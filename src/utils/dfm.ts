// Design for Manufacturing: what this shape will do when someone tries to make it.
//
// Three processes, three different ways for the same geometry to be wrong, and
// the answers are only comparable because they are all read off the same scene
// triangles:
//
//   3D printing — a face that leans past 45° from vertical needs support under
//                 it, and a wall thinner than the nozzle can lay down will not
//                 exist at all.
//   3-axis CNC  — the cutter comes from ONE direction. Material tucked under an
//                 overhang is material the machine cannot see, and an inside
//                 corner can never be sharper than the bit is round.
//   Casting     — a wall parallel to the pull direction drags; a wall that
//                 leans back locks the pattern in the sand and the mould has to
//                 be broken to get it out.
//
// This module is PURE and store-free, unlike utils/printAnalysis.ts, which reads
// live MuJoCo state at module scope and can therefore only run on the main
// thread. Everything here takes a scene and returns numbers, so it is testable
// and could move to a worker unchanged.
//
// SPACES. `collectSceneTriangles` hands back world triangles in METRES, MuJoCo
// Z-up, with a solid id per triangle and `role: 'collision'` geoms already
// dropped — so the convex colliders from utils/convexDecomposition.ts are not
// mistaken for part geometry. Everything reported to the user is in MILLIMETRES,
// because that is what the fabrication side of this app speaks.

import { collectSceneTriangles } from './contourSliceExporter';
import { DEFAULT_MATERIAL, materialSpec, type MaterialId } from './feedsAndSpeeds';
import { DEFAULT_FILAMENT, filamentSpec, type FilamentId } from './filaments';
import { MAX_AVAILABLE_REACH_DIAMETERS, STANDARD_BIT_DIAS } from './reliefCarveExporter';
import { sampleColumns } from './solidMachiningExporter';
import { squaredDistanceTransform } from './heightmapMesh';
import type { SceneGraph, SceneNode } from '../types/scene';

export type DfmProcess = 'print' | 'cnc' | 'cast';
export type DfmSeverity = 'critical' | 'warning' | 'info';

/**
 * The limits each process is judged against.
 *
 * These come from the bench, not from this file: what is clamped down, what is
 * loaded in the printer, and how big the stock is. `dfmLimitsFor` reads them off
 * the store's material/filament/stock, so switching the material switches the
 * answers — a 1.2 mm rib is fine in aluminium and crumbles in MDF.
 */
export interface DfmLimits {
  /** Past this many degrees from vertical, a printed face needs support. */
  overhangDeg: number;
  /** Material thinner than this will not survive the process. */
  minWallMm: number;
  /** Whether the filament will span a gap with nothing under it. */
  bridges: boolean;
  /** Whether a big flat footprint will lift off the bed as it cools. */
  warpsOnLargeFlats: boolean;
  /** The cutter, for inside-corner radius. */
  toolDiaMm: number;
  /** The deepest any bit a workshop actually owns can reach, mm. */
  maxToolReachMm: number;
  /** A cast wall wants at least this much taper to let go of the mould. */
  draftDeg: number;
  /** What is clamped on the bed, mm. Null when it should not be checked. */
  stockMm: { widthMm: number; depthMm: number; thicknessMm: number } | null;
  /**
   * Thinnest wall that survives being CUT, as opposed to printed. A separate
   * number because they answer to different things: the printed one is the
   * nozzle, this one is whether the remaining material holds together.
   */
  cncMinWallMm: number;
}

/**
 * HOW LOUD ANY OF THIS IS ALLOWED TO BE.
 *
 * A panel that complains about every part is a panel people turn off, and then
 * it is worse than nothing because the one real problem goes unseen too. So the
 * bar here is "this will actually fail, or cost real time and money", not "this
 * is not ideal".
 *
 * Support material is NORMAL in FDM. Inside corners having the bit's radius is
 * NORMAL in CNC. Neither is a warning; both are shown in the heat map, where
 * they inform without interrupting. What gets a written finding is the shape
 * that will not come out of the mould, the wall that is too thin to exist, and
 * the part that does not fit on the stock.
 */
const T = {
  /** Overhang: a quarter of the surface needing support is a lot of support. */
  overhangShare: 0.25,
  overhangShareCritical: 0.45,
  /** A near-flat ceiling on a filament that cannot bridge is a failed print. */
  bridgeDeg: 75,
  /** Flat footprint, mm, past which a shrinking filament lifts at the corners. */
  warpSpanMm: 120,
  /** Thin material has to cover real area before it is a feature and not a sliver. */
  thinCellShare: 0.01,
  /** Undercut: below this it is tessellation noise, not a re-entrant feature. */
  undercutShare: 0.05,
  undercutShareCritical: 0.15,
  /** Corners: every CNC pocket has radiused corners. Only a lot of them matters. */
  strandedShare: 0.25,
  /**
   * Draft: an undercut stops the pattern coming out; no draft merely makes it
   * drag. That is a finish-and-mould-wear problem, not a failure, and it is true
   * of every plain box anyone ever models — so it needs most of the part to be
   * dead upright AND enough height for the sliding to actually cost something.
   * A 40 mm block pulls fine whatever its walls do.
   */
  dragShare: 0.5,
  dragMinHeightMm: 40,
  /** Casting undercuts stop the pattern coming out at all, so the bar is low. */
  castUndercutShare: 0.02,
} as const;

/**
 * Which lens the bench implies.
 *
 * Not a choice the user makes twice: the machine is already picked in the
 * bottom bar, along with what it is loaded with, and asking again for the same
 * fact is how a control ends up disagreeing with the one beside it.
 *
 * A laser has no Z depth, so overhang, undercut and reach mean nothing to it —
 * its DFM is kerf and closed paths, which is not built. Null rather than a
 * wrong answer.
 */
export function dfmLensFor(machineTarget: 'fdm' | 'cnc' | 'laser'): DfmProcess | null {
  return machineTarget === 'fdm' ? 'print' : machineTarget === 'cnc' ? 'cnc' : null;
}

export interface DfmBench {
  material: MaterialId;
  filament: FilamentId;
  stock?: { widthMm: number; depthMm: number; thicknessMm: number } | null;
  /**
   * The body to judge. Absent means the whole scene.
   *
   * This matters more than it looks. A Mesh scene is usually a SIMULATION — a
   * pendulum, a gear train, a bridge — not a part, and asking "will this make?"
   * of a whole scene produces true but worthless answers: the Golden Gate does
   * not fit on a 150 mm board, and two bodies hanging in space are trivially
   * "under an overhang" with respect to each other. Fabrication is per part, so
   * the question is per part.
   */
  nodeId?: string | null;
}

/**
 * The limits for a given bench.
 *
 * The one genuinely derived number is the reach: rather than assume a bit, ask
 * what the deepest cut a workshop's largest standard bit can manage is, using
 * the same stickout rule reliefCarveExporter sizes real tooling with. That way
 * "too deep" means "no bit you own reaches this", not "not the bit I guessed".
 */
export function dfmLimitsFor(bench: DfmBench): DfmLimits {
  const mat = materialSpec(bench.material);
  const fil = filamentSpec(bench.filament);
  const biggestBit = STANDARD_BIT_DIAS[STANDARD_BIT_DIAS.length - 1];
  return {
    overhangDeg: fil.maxOverhangDeg,
    minWallMm: fil.minWallMm,
    bridges: fil.bridges,
    warpsOnLargeFlats: fil.warpsOnLargeFlats,
    toolDiaMm: 3.175,
    maxToolReachMm: biggestBit * MAX_AVAILABLE_REACH_DIAMETERS,
    draftDeg: 2,
    stockMm: bench.stock ?? null,
    cncMinWallMm: mat.minWallMm,
  };
}

export const DFM_DEFAULTS: DfmLimits = dfmLimitsFor({
  material: DEFAULT_MATERIAL,
  filament: DEFAULT_FILAMENT,
  stock: null,
});

export interface DfmFinding {
  id: string;
  process: DfmProcess;
  severity: DfmSeverity;
  title: string;
  /** What is wrong, with the measurement that says so. */
  detail: string;
  /** What to do about it. */
  fix: string;
  /** Where to look, world Z-up metres — same space the overlay draws in. */
  position: [number, number, number];
  /** The number that triggered it, for sorting and for the UI to show. */
  metric?: number;
}

export interface DfmReport {
  process: DfmProcess;
  findings: DfmFinding[];
  /**
   * How badly each triangle of the scene soup offends, 0 (fine) to 1 (worst),
   * one entry per triangle and in the same order collectSceneTriangles returned
   * them. This is the heat map; the overlay colours the soup straight from it.
   */
  heat: Float32Array;
  /** The scene triangles the heat indexes into, world metres, 9 floats each. */
  tris: Float64Array;
  /** What the hot end of the scale means, for the legend. */
  legend: string;
  /** 0-100, and deliberately blunt: it is a prompt to look, not a grade. */
  score: number;
  summary: string;
  warnings: string[];
}

const RAD = 180 / Math.PI;

/** The node with this id, anywhere in the tree. */
function findNode(nodes: SceneNode[], id: string): SceneNode | null {
  for (const n of nodes || []) {
    if (n.id === id) return n;
    const hit = findNode(n.children || [], id);
    if (hit) return hit;
  }
  return null;
}

/** Unit normal of triangle t, and its area. Degenerates come back as null. */
function triNormal(tris: Float64Array, t: number): { n: [number, number, number]; area: number } | null {
  const i = t * 9;
  const ux = tris[i + 3] - tris[i], uy = tris[i + 4] - tris[i + 1], uz = tris[i + 5] - tris[i + 2];
  const vx = tris[i + 6] - tris[i], vy = tris[i + 7] - tris[i + 1], vz = tris[i + 8] - tris[i + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (!(len > 1e-12)) return null;
  return { n: [nx / len, ny / len, nz / len], area: len / 2 };
}

function triCentroid(tris: Float64Array, t: number): [number, number, number] {
  const i = t * 9;
  return [
    (tris[i] + tris[i + 3] + tris[i + 6]) / 3,
    (tris[i + 1] + tris[i + 4] + tris[i + 7]) / 3,
    (tris[i + 2] + tris[i + 5] + tris[i + 8]) / 3,
  ];
}

function bounds(tris: Float64Array) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    if (tris[i] < minX) minX = tris[i];
    if (tris[i] > maxX) maxX = tris[i];
    if (tris[i + 1] < minY) minY = tris[i + 1];
    if (tris[i + 1] > maxY) maxY = tris[i + 1];
    if (tris[i + 2] < minZ) minZ = tris[i + 2];
    if (tris[i + 2] > maxZ) maxZ = tris[i + 2];
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

/** Weighted centre of the hottest triangles, so a finding points somewhere real. */
function hotSpot(tris: Float64Array, heat: Float32Array, min: number): [number, number, number] | null {
  let sx = 0, sy = 0, sz = 0, w = 0;
  for (let t = 0; t < heat.length; t++) {
    if (heat[t] < min) continue;
    const c = triCentroid(tris, t);
    sx += c[0] * heat[t]; sy += c[1] * heat[t]; sz += c[2] * heat[t]; w += heat[t];
  }
  return w > 0 ? [sx / w, sy / w, sz / w] : null;
}

/**
 * How far a face leans from the build axis, in degrees.
 *
 * A vertical wall is 0° and prints on top of itself. A horizontal ceiling is 90°
 * and is bridging over air. The slicer limit of 45° is the angle at which each
 * layer still lands half on the one below it.
 *
 * Only DOWNWARD-facing triangles can overhang: an upward face at any angle has
 * the whole part underneath it. Those come back as 0.
 */
export function overhangDeg(normalZ: number): number {
  if (normalZ >= 0) return 0;
  return Math.asin(Math.min(1, -normalZ)) * RAD;
}

/**
 * The taper on a face, relative to pulling the pattern along +Z.
 *
 * Positive is draft: the face opens towards the pull and lets go. Zero is a wall
 * exactly parallel to the pull, which drags the whole way out and scuffs.
 * Negative is an undercut — the face leans back over the mould and the pattern
 * cannot come out at all without breaking something.
 *
 * `above` says which side of the parting plane the face sits on, because the
 * bottom half is pulled the other way and its sign flips.
 */
export function draftDeg(normalZ: number, above: boolean): number {
  const along = above ? normalZ : -normalZ;
  return Math.asin(Math.max(-1, Math.min(1, along))) * RAD;
}

/**
 * Air cells that a tool could not simply drive in from outside: pockets, bores
 * and slots, as opposed to the open space around the part.
 *
 * A flood fill from the border marks everything the outside world connects to;
 * what is left is enclosed. This is what separates "the corner of this pocket is
 * too sharp for the bit" from "these two bodies are close together".
 */
export function enclosedAir(hit: Uint8Array, cols: number, rows: number): Uint8Array {
  const open = new Uint8Array(cols * rows);
  const stack: number[] = [];
  const push = (c: number, r: number) => {
    if (c < 0 || r < 0 || c >= cols || r >= rows) return;
    const i = r * cols + c;
    if (open[i] || hit[i]) return;
    open[i] = 1;
    stack.push(i);
  };
  for (let c = 0; c < cols; c++) { push(c, 0); push(c, rows - 1); }
  for (let r = 0; r < rows; r++) { push(0, r); push(cols - 1, r); }
  while (stack.length) {
    const i = stack.pop()!;
    const c = i % cols, r = (i - c) / cols;
    push(c + 1, r); push(c - 1, r); push(c, r + 1); push(c, r - 1);
  }
  const enclosed = new Uint8Array(cols * rows);
  for (let i = 0; i < enclosed.length; i++) enclosed[i] = !hit[i] && !open[i] ? 1 : 0;
  return enclosed;
}

/** A grid fine enough to see the limits being measured, and no finer. */
function gridFor(span: number, featureMm: number) {
  const target = Math.ceil((span * 1000) / Math.max(0.2, featureMm / 2));
  return Math.max(16, Math.min(320, target));
}

// ---------------------------------------------------------------------------
// 3D printing
// ---------------------------------------------------------------------------

function analysePrint(tris: Float64Array, limits: DfmLimits): Omit<DfmReport, 'process' | 'tris' | 'warnings'> {
  const count = tris.length / 9;
  const heat = new Float32Array(count);
  const findings: DfmFinding[] = [];
  const b = bounds(tris);

  let overhangArea = 0, totalArea = 0, worstDeg = 0, unbridgeable = 0;
  for (let t = 0; t < count; t++) {
    const tri = triNormal(tris, t);
    if (!tri) continue;
    totalArea += tri.area;
    const deg = overhangDeg(tri.n[2]);
    if (deg <= limits.overhangDeg) continue;
    // Faces sitting on the build plate are printed against glass, not air.
    const c = triCentroid(tris, t);
    if (c[2] - b.minZ < 0.0005) continue;
    heat[t] = Math.min(1, (deg - limits.overhangDeg) / (90 - limits.overhangDeg));
    overhangArea += tri.area;
    if (deg > worstDeg) worstDeg = deg;
    if (deg >= T.bridgeDeg) unbridgeable += tri.area;
  }

  const share = totalArea > 0 ? overhangArea / totalArea : 0;

  // Support is the normal cost of printing, not a defect. This only speaks up
  // when the orientation is costing a LOT of it — the case where turning the
  // part is worth real time and a better surface.
  if (share > T.overhangShare) {
    const at = hotSpot(tris, heat, 0.01) ?? [0, 0, b.maxZ];
    findings.push({
      id: 'print_overhang',
      process: 'print',
      severity: share > T.overhangShareCritical ? 'critical' : 'warning',
      title: `${(share * 100).toFixed(0)}% of the surface needs support`,
      detail: `${(share * 100).toFixed(0)}% of this part leans more than ${limits.overhangDeg}° from vertical, reaching ${worstDeg.toFixed(0)}°. That is a lot of support to print, and a lot of scarred surface where it breaks off.`,
      fix: 'Turn the part on the build plate — the orientation with the least downward area usually costs the least support and the least time.',
      position: at,
      metric: share,
    });
  }

  // A filament that will not bridge cannot print a flat ceiling at all, however
  // little of it there is. That is a failed print rather than an expensive one.
  if (!limits.bridges && unbridgeable > 0 && totalArea > 0 && unbridgeable / totalArea > 0.01) {
    findings.push({
      id: 'print_no_bridge',
      process: 'print',
      severity: 'critical',
      title: 'This filament will not bridge',
      detail: `There are faces here running flat over open air, and the loaded filament will not span a gap — it droops into it instead of setting across it.`,
      fix: 'Turn the part so those faces are supported, chamfer them so they climb instead of spanning, or print it in something stiffer.',
      position: hotSpot(tris, heat, 0.8) ?? [0, 0, b.maxZ],
      metric: unbridgeable / totalArea,
    });
  }

  // Shrinkage only matters once the flat is big enough for the corners to have
  // real leverage. A small ABS part is perfectly happy on an open printer.
  const spanMm = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 1000;
  if (limits.warpsOnLargeFlats && spanMm > T.warpSpanMm) {
    findings.push({
      id: 'print_warp',
      process: 'print',
      severity: 'warning',
      title: `${spanMm.toFixed(0)} mm across, in a filament that shrinks`,
      detail: `This part is ${spanMm.toFixed(0)} mm across its widest flat direction. The loaded filament shrinks as it cools, and over that span the shrinkage lifts the corners off the bed.`,
      fix: 'Print it in an enclosure, add a brim, or use a filament that does not shrink if the part does not need the heat resistance.',
      position: [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, b.minZ],
      metric: spanMm,
    });
  }

  const thin = thinnestWall(tris, limits.minWallMm);
  if (thin && thin.mm < limits.minWallMm && thin.share > T.thinCellShare) {
    findings.push({
      id: 'print_thin_wall',
      process: 'print',
      severity: thin.mm < limits.minWallMm / 2 ? 'critical' : 'warning',
      title: `Wall down to ${thin.mm.toFixed(2)} mm`,
      detail: `The thinnest material here measures ${thin.mm.toFixed(2)} mm, against ${limits.minWallMm} mm for the loaded filament. Below that the slicer has nowhere to put two perimeters and will thin it further or drop it entirely.`,
      fix: `Take it to at least ${limits.minWallMm} mm.`,
      position: thin.at,
      metric: thin.mm,
    });
  }

  return {
    findings,
    heat,
    legend: `Unsupported overhang — red is flat over air, amber is just past ${limits.overhangDeg}°`,
    score: scoreOf(findings),
    summary: findings.length === 0
      ? 'Nothing here should give a printer trouble.'
      : `${(share * 100).toFixed(0)}% of the surface overhangs.`,
  };
}

/**
 * Whether the part fits the board that is clamped down.
 *
 * CNC only. `stock` is what is on the router bed; nothing in the app knows how
 * big a printer's bed is, so the print lens has no business guessing.
 *
 * And only when the part is in the same ballpark as the board. A part twice the
 * size of the stock is an actionable near-miss — scale it, or split it. A part
 * thirty times the size is a bridge somebody is simulating, and telling them it
 * will not fit on a 150 mm board is the kind of true, useless remark that gets
 * a panel switched off.
 */
const STOCK_BALLPARK = 3;

function stockFindings(b: ReturnType<typeof bounds>, limits: DfmLimits): DfmFinding[] {
  const stock = limits.stockMm;
  if (!stock) return [];
  const w = (b.maxX - b.minX) * 1000;
  const d = (b.maxY - b.minY) * 1000;
  const h = (b.maxZ - b.minZ) * 1000;

  const fitsPlan = (w <= stock.widthMm && d <= stock.depthMm) || (d <= stock.widthMm && w <= stock.depthMm);
  const fitsThick = h <= stock.thicknessMm;
  if (fitsPlan && fitsThick) return [];

  // Plainly not meant for this board.
  const planRatio = Math.max(w / stock.widthMm, d / stock.depthMm);
  if (planRatio > STOCK_BALLPARK || h / stock.thicknessMm > STOCK_BALLPARK) return [];

  return [{
    id: 'stock_fit',
    process: 'cnc',
    severity: 'critical',
    title: 'It does not fit the stock',
    detail: !fitsPlan
      ? `This part is ${w.toFixed(0)} x ${d.toFixed(0)} mm, on a ${stock.widthMm} x ${stock.depthMm} mm board.`
      : `This part is ${h.toFixed(0)} mm tall, out of ${stock.thicknessMm} mm stock.`,
    fix: 'Scale it down, clamp bigger stock, or split it into pieces.',
    position: [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, b.maxZ],
  }];
}

/**
 * The thinnest material anywhere in the part, and how much of it is that thin.
 *
 * Looks through each axis in turn and takes the smallest interior column. Column
 * thickness is exact for a wall square to the axis and an overestimate for one
 * at a slant, so the minimum across three axes converges on the true wall from
 * above — the safe direction to be wrong in, since it under-reports a thin
 * diagonal rib rather than inventing one.
 */
export function thinnestWall(
  tris: Float64Array,
  minWallMm: number,
): { mm: number; at: [number, number, number]; share: number } | null {
  let best: { mm: number; at: [number, number, number]; share: number } | null = null;

  for (const axis of [0, 1, 2]) {
    // Rotate the soup so `axis` becomes Z, then the existing plan-view column
    // sampler does the work. Proper rotations only, so winding holds.
    const rotated = axis === 2 ? tris : rotateAxisToZ(tris, axis);
    const rb = bounds(rotated);
    const cols = gridFor(rb.maxX - rb.minX, minWallMm);
    const rows = gridFor(rb.maxY - rb.minY, minWallMm);
    if (cols < 3 || rows < 3) continue;
    const { thickness, hit } = sampleColumns(rotated, rb, cols, rows);

    const stepX = (rb.maxX - rb.minX) / (cols - 1);
    const stepY = (rb.maxY - rb.minY) / (rows - 1);
    let thinnest = Infinity;
    let at: [number, number, number] | null = null;
    let solidCells = 0, thinCells = 0;

    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        const i = r * cols + c;
        if (!hit[i]) continue;
        // INTERIOR COLUMNS ONLY. Any curved body is genuinely thin where it
        // turns away at its own silhouette — the edge of a sphere really is a
        // sliver — and counting those reported every round part as having
        // paper-thin walls. A column with material on all four sides is
        // measuring a wall; one on the boundary is measuring a tangent.
        if (!hit[i - 1] || !hit[i + 1] || !hit[i - cols] || !hit[i + cols]) continue;
        const mm = thickness[i] * 1000;
        if (mm < 0.01) continue;
        solidCells++;
        if (mm < minWallMm) thinCells++;
        if (mm < thinnest) { thinnest = mm; at = [rb.minX + c * stepX, rb.minY + r * stepY, 0]; }
      }
    }
    if (!at || !solidCells) continue;
    // How much of the part is actually thin, not just the single worst sample.
    const share = thinCells / solidCells;
    if (best && thinnest >= best.mm) continue;
    best = { mm: thinnest, at: unrotateFromZ(at, axis), share };
  }
  return best;
}

/** Turns the given axis into Z, as a proper rotation (no mirror, so winding holds). */
function rotateAxisToZ(tris: Float64Array, axis: number): Float64Array {
  const out = new Float64Array(tris.length);
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i], y = tris[i + 1], z = tris[i + 2];
    if (axis === 0) { out[i] = y; out[i + 1] = z; out[i + 2] = x; }
    else { out[i] = z; out[i + 1] = x; out[i + 2] = y; }
  }
  return out;
}

function unrotateFromZ(p: [number, number, number], axis: number): [number, number, number] {
  if (axis === 2) return p;
  if (axis === 0) return [p[2], p[0], p[1]];
  return [p[1], p[2], p[0]];
}

// ---------------------------------------------------------------------------
// 3-axis CNC
// ---------------------------------------------------------------------------

function analyseCnc(tris: Float64Array, limits: DfmLimits): Omit<DfmReport, 'process' | 'tris' | 'warnings'> {
  const count = tris.length / 9;
  const heat = new Float32Array(count);
  const findings: DfmFinding[] = [];
  const b = bounds(tris);

  const cols = gridFor(b.maxX - b.minX, limits.toolDiaMm);
  const rows = gridFor(b.maxY - b.minY, limits.toolDiaMm);
  const { top, thickness, hit } = sampleColumns(tris, b, cols, rows);
  const stepX = (b.maxX - b.minX) / Math.max(1, cols - 1);
  const stepY = (b.maxY - b.minY) / Math.max(1, rows - 1);
  const cellArea = stepX * stepY;

  // Material the cutter cannot see.
  //
  // A 3-axis tool comes straight down and stops at the first surface it meets.
  // So measure each column from its top face down to the BOTTOM OF THE STOCK,
  // not to the column's own lowest triangle: the void under a floating arm is
  // exactly the material the machine would have to clear and cannot, and a
  // column measured against itself would report that arm as perfectly
  // reachable. This is the one-sided case of the `kept - thickness` figure
  // solidMachiningExporter already reports for a finished job.
  let trapped = 0, kept = 0;
  const trappedCell = new Uint8Array(cols * rows);
  for (let i = 0; i < cols * rows; i++) {
    if (!hit[i]) continue;
    const span = top[i] - b.minZ;
    if (!(span > 0)) continue;
    kept += span * cellArea;
    const gap = span - thickness[i];
    if (gap > 1e-6) { trapped += gap * cellArea; trappedCell[i] = 1; }
  }
  const trappedShare = kept > 0 ? trapped / kept : 0;

  // Paint the heat onto the faces that are actually hidden — the ones tucked
  // under something else in their own column.
  for (let t = 0; t < count && trappedShare > 0; t++) {
    const c = triCentroid(tris, t);
    const ci = Math.round((c[0] - b.minX) / (stepX || 1));
    const ri = Math.round((c[1] - b.minY) / (stepY || 1));
    if (ci < 0 || ri < 0 || ci >= cols || ri >= rows) continue;
    const i = ri * cols + ci;
    if (!trappedCell[i]) continue;
    // Only the material BELOW the top surface is out of reach; the top face of
    // the same column is exactly what the cutter does reach.
    if (c[2] > top[i] - 1e-6) continue;
    heat[t] = 1;
  }

  if (trappedShare > T.undercutShare) {
    findings.push({
      id: 'cnc_undercut',
      process: 'cnc',
      severity: trappedShare > T.undercutShareCritical ? 'critical' : 'warning',
      title: `${(trappedShare * 100).toFixed(0)}% is under an overhang`,
      detail: `${(trappedShare * 100).toFixed(0)}% of this part sits beneath something else, where a cutter coming straight down cannot reach it. The machine will leave that material behind.`,
      fix: 'Flip the part and cut the second side, or split it into two pieces that each open to a cutter.',
      position: hotSpot(tris, heat, 0.5) ?? [0, 0, b.maxZ],
      metric: trappedShare,
    });
  }

  // Inside corners. A round cutter cannot cut a sharp internal corner: the
  // smallest radius it can leave is its own. That is true of every CNC part
  // ever made, so this only speaks up when a real share of the pockets is
  // narrower than the bit — the case where the feature does not get cut at all.
  //
  // Only ENCLOSED air counts. Air outside the part's silhouette is where the
  // tool came from, and counting it would report the gap between two separate
  // bodies as an uncuttable corner.
  const toolRadiusCells = (limits.toolDiaMm / 2000) / Math.max(stepX, stepY, 1e-9);
  if (toolRadiusCells >= 1 && cols > 2 && rows > 2) {
    const enclosed = enclosedAir(hit, cols, rows);
    let pocketCells = 0;
    for (let i = 0; i < enclosed.length; i++) if (enclosed[i]) pocketCells++;

    if (pocketCells > 0) {
      // Rolling the disc: an air cell can hold the tool's centre only if it is
      // at least a tool radius from any material. Dilating those back out by the
      // same radius gives everywhere the tool can sweep; enclosed air outside
      // that is stranded.
      const solid = new Uint8Array(cols * rows);
      for (let i = 0; i < cols * rows; i++) solid[i] = hit[i] ? 1 : 0;
      const dSolid = squaredDistanceTransform(solid, cols, rows);
      const holds = new Uint8Array(cols * rows);
      const r2 = toolRadiusCells * toolRadiusCells;
      for (let i = 0; i < cols * rows; i++) if (!hit[i] && dSolid[i] >= r2) holds[i] = 1;
      const dHolds = squaredDistanceTransform(holds, cols, rows);

      let stranded = 0;
      for (let i = 0; i < cols * rows; i++) if (enclosed[i] && dHolds[i] > r2) stranded++;
      const strandedShare = stranded / pocketCells;

      if (strandedShare > T.strandedShare) {
        findings.push({
          id: 'cnc_corner_radius',
          process: 'cnc',
          severity: 'warning',
          title: `A \u00d8${limits.toolDiaMm} mm bit cannot get into ${(strandedShare * 100).toFixed(0)}% of the pockets`,
          detail: `${(strandedShare * 100).toFixed(0)}% of the enclosed pocket area here is narrower than the cutter, so those features do not get cut at all.`,
          fix: `Use a smaller bit, or open the slots past ${limits.toolDiaMm} mm.`,
          position: [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, b.maxZ],
          metric: strandedShare,
        });
      }
    }
  }

  // Depth. Stepping down in passes is ordinary, and a longer bit is a normal
  // answer, so this only fires when NO bit a workshop is likely to own reaches
  // the bottom — the same stickout rule reliefCarveExporter sizes real tooling
  // with, applied to the largest standard diameter.
  const depthMm = (b.maxZ - b.minZ) * 1000;
  if (depthMm > limits.maxToolReachMm) {
    findings.push({
      id: 'cnc_reach',
      process: 'cnc',
      severity: 'warning',
      title: `${depthMm.toFixed(0)} mm deep — deeper than a bit reaches`,
      detail: `This part stands ${depthMm.toFixed(0)} mm tall, and the longest standard bit reaches about ${limits.maxToolReachMm.toFixed(0)} mm before its shank is in the cut.`,
      fix: 'Cut it from both sides, or split it into pieces shallow enough to reach.',
      position: [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, b.minZ],
      metric: depthMm,
    });
  }

  // Thin material, judged by what is being CUT rather than what is printed —
  // a 1.2 mm rib is fine in aluminium and crumbles in MDF.
  const thin = thinnestWall(tris, limits.cncMinWallMm);
  if (thin && thin.mm < limits.cncMinWallMm && thin.share > T.thinCellShare) {
    findings.push({
      id: 'cnc_thin_wall',
      process: 'cnc',
      severity: thin.mm < limits.cncMinWallMm / 2 ? 'critical' : 'warning',
      title: `Wall down to ${thin.mm.toFixed(2)} mm`,
      detail: `The thinnest material here is ${thin.mm.toFixed(2)} mm, against about ${limits.cncMinWallMm} mm for the stock on the bench. Thinner than that and it chatters, tears out or simply breaks off while being cut.`,
      fix: `Thicken it to ${limits.cncMinWallMm} mm, or cut it from something that holds a thin section.`,
      position: thin.at,
      metric: thin.mm,
    });
  }

  findings.push(...stockFindings(b, limits));

  return {
    findings,
    heat,
    legend: 'Red is material a cutter cannot reach from above',
    score: scoreOf(findings),
    summary: findings.length === 0
      ? 'A 3-axis machine can reach all of this from one side.'
      : `${(trappedShare * 100).toFixed(0)}% unreachable from above, ${depthMm.toFixed(0)} mm deep.`,
  };
}

// ---------------------------------------------------------------------------
// Casting
// ---------------------------------------------------------------------------

function analyseCast(tris: Float64Array, limits: DfmLimits): Omit<DfmReport, 'process' | 'tris' | 'warnings'> {
  const count = tris.length / 9;
  const heat = new Float32Array(count);
  const findings: DfmFinding[] = [];
  const b = bounds(tris);
  // A flat parting plane at mid-height, pulled along ±Z. castPatternExporter
  // searches for a better one; this is the passive check, so it reports what a
  // reasonable default would do rather than optimising behind the user's back.
  const partingZ = (b.minZ + b.maxZ) / 2;

  let undercutArea = 0, dragArea = 0, totalArea = 0, worstDeg = 0;
  for (let t = 0; t < count; t++) {
    const tri = triNormal(tris, t);
    if (!tri) continue;
    totalArea += tri.area;
    const c = triCentroid(tris, t);
    const deg = draftDeg(tri.n[2], c[2] >= partingZ);
    // A face square to the pull is the top or the bottom of the part; it comes
    // straight off and has nothing to drag against.
    if (deg > 80) continue;
    if (deg < 0) {
      heat[t] = 1;
      undercutArea += tri.area;
      if (-deg > worstDeg) worstDeg = -deg;
    } else if (deg < limits.draftDeg) {
      heat[t] = 0.35 * (1 - deg / limits.draftDeg);
      dragArea += tri.area;
    }
  }

  const undercutShare = totalArea > 0 ? undercutArea / totalArea : 0;
  const dragShare = totalArea > 0 ? dragArea / totalArea : 0;
  const heightMm = (b.maxZ - b.minZ) * 1000;

  // An undercut means the pattern physically does not come out, so the bar is
  // low — unlike everything else here, a small one is still a broken mould.
  if (undercutShare > T.castUndercutShare) {
    findings.push({
      id: 'cast_undercut',
      process: 'cast',
      severity: 'critical',
      title: `${(undercutShare * 100).toFixed(0)}% undercut — the pattern will not pull`,
      detail: `${(undercutShare * 100).toFixed(0)}% of the surface leans back over the mould, by up to ${worstDeg.toFixed(0)}°, with the parting plane at mid-height. Those faces lock the pattern in: the sand has to be broken to get it out.`,
      fix: 'Move the parting line so the undercut falls the other side of it, split the pattern, or add a loose piece for the feature.',
      position: hotSpot(tris, heat, 0.9) ?? [0, 0, partingZ],
      metric: undercutShare,
    });
  }

  // Draft is a nicety on a shallow part and a real problem on a deep one: drag
  // scales with how far the wall has to slide. So this needs both a lot of the
  // part to be upright AND enough height for it to matter.
  if (dragShare > T.dragShare && heightMm > T.dragMinHeightMm) {
    findings.push({
      id: 'cast_draft',
      process: 'cast',
      severity: 'warning',
      title: `${(dragShare * 100).toFixed(0)}% of walls have no draft`,
      detail: `${(dragShare * 100).toFixed(0)}% of the surface stands within ${limits.draftDeg}° of parallel to the pull, over ${heightMm.toFixed(0)} mm of height. Walls that upright drag the whole way out, scuffing the mould and taking sand with them.`,
      fix: `Taper them by ${limits.draftDeg}° away from the parting line — well under a millimetre of extra material on a part this size.`,
      position: hotSpot(tris, heat, 0.05) ?? [0, 0, partingZ],
      metric: dragShare,
    });
  }

  return {
    findings,
    heat,
    legend: `Red is undercut and will not pull; amber is under ${limits.draftDeg}° of draft`,
    score: scoreOf(findings),
    summary: findings.length === 0
      ? `Everything draws cleanly along Z.`
      : `${(undercutShare * 100).toFixed(0)}% undercut, ${(dragShare * 100).toFixed(0)}% short of draft.`,
  };
}

/** Blunt on purpose: a prompt to look, not a grade. */
function scoreOf(findings: DfmFinding[]): number {
  let score = 100;
  for (const f of findings) {
    score -= f.severity === 'critical' ? 30 : f.severity === 'warning' ? 12 : 4;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Runs one process's checks over the whole scene.
 *
 * The triangles are collected once and handed back on the report, because the
 * overlay needs exactly the same soup the heat indexes into — re-collecting it
 * on the render side would be a second traversal and, worse, a second chance
 * for the two to disagree about which triangle is which.
 */
export function analyseDfm(
  scene: SceneGraph,
  process: DfmProcess,
  bench: Partial<DfmBench & DfmLimits> = {},
): DfmReport {
  // The bench first — what is clamped down and what is loaded — then any
  // explicit override on top, so a caller can pin one number without having to
  // restate the material it came with.
  const lim: DfmLimits = {
    ...dfmLimitsFor({
      material: bench.material ?? DEFAULT_MATERIAL,
      filament: bench.filament ?? DEFAULT_FILAMENT,
      stock: bench.stock ?? null,
    }),
    ...Object.fromEntries(Object.entries(bench).filter(([k]) => k in DFM_DEFAULTS)),
  };
  const target = bench.nodeId ? findNode(scene.nodes || [], bench.nodeId) : null;
  const collected = collectSceneTriangles(target ? { ...scene, nodes: [target] } : scene);
  const tris = Float64Array.from(collected.tris);
  const warnings = [...collected.warnings];
  if (collected.skipped.length) {
    warnings.push(`Not analysed: ${collected.skipped.join(', ')}.`);
  }

  if (tris.length < 9) {
    return {
      process, tris, warnings,
      findings: [], heat: new Float32Array(0),
      legend: '', score: 100,
      summary: 'Nothing in the scene to analyse.',
    };
  }

  const body = process === 'print' ? analysePrint(tris, lim)
    : process === 'cnc' ? analyseCnc(tris, lim)
      : analyseCast(tris, lim);

  return { process, tris, warnings, ...body };
}
