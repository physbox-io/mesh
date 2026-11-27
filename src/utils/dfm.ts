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

import * as THREE from 'three';
import { appendSolidTriangles, collectSceneTriangles, uncompiledCsgWarning } from './contourSliceExporter';
import { resolveCsgGeoms } from './csg';
import { getNodeWorldTransform } from './laserCutExporter';
import { isBoughtIn } from './boughtIn';
import { hardwareFindings, type LivePoses } from './hardwareChecks';
import { DEFAULT_MATERIAL, materialSpec, type MaterialId } from './feedsAndSpeeds';
import { DEFAULT_FILAMENT, filamentSpec, type FilamentId } from './filaments';
import { printLimits, type PrinterSettings } from './printLimits';
import { poseMatrix, rotatePoints, type Mat3 } from './printPlate';
import { MAX_AVAILABLE_REACH_DIAMETERS, STANDARD_BIT_DIAS } from './reliefCarveExporter';
import { columnProbe, sampleColumns, sampleWallSpans } from './partColumns';
import { squaredDistanceTransform } from './heightmapMesh';
import { overhangDeg, supportArea } from './printSupport';
import { trappedAirInSoup } from './trappedAir';
import { CAST_MATERIALS, castMaterial, resolveCastMaterial, type CastMaterialId } from './castMaterials';
import type { SceneGraph, SceneNode } from '../types/scene';

export type DfmExtraCastMaterialId = 'pewter' | 'zinc' | 'iron';
export type DfmCastMaterialId = CastMaterialId | DfmExtraCastMaterialId;

export interface ResolvedDfmCastMaterial {
  id: DfmCastMaterialId;
  label: string;
  minSectionMm: number;
  slip: boolean;
  /** Set when an unrecognised name fell back to epoxy. */
  fallbackFrom?: string;
}

const EXTRA_CAST_MATERIALS: Record<DfmExtraCastMaterialId, { label: string; minSectionMm: number }> = {
  pewter: { label: 'Pewter', minSectionMm: 2.0 },
  zinc: { label: 'Zinc', minSectionMm: 2.0 },
  iron: { label: 'Cast iron', minSectionMm: 3.5 },
};

const EXTRA_CAST_ALIASES: Record<string, DfmCastMaterialId> = {
  aluminum: 'aluminium',
  'cast-iron': 'iron',
  cast_iron: 'iron',
};

export const SUPPORTED_CAST_MATERIAL_IDS: readonly DfmCastMaterialId[] = [
  ...CAST_MATERIALS.map((m) => m.id),
  'pewter',
  'zinc',
  'iron',
];

/**
 * Resolves a casting material name (case-insensitive, including US spelling
 * `aluminum` and extra casting metals `pewter`, `zinc`, `iron`) to its
 * minimum section threshold, or null if unknown.
 */
export function resolveDfmCastMaterialStrict(value: unknown): ResolvedDfmCastMaterial | null {
  if (typeof value !== 'string') return null;
  const norm = value.trim().toLowerCase();
  if (!norm) return null;
  const aliased = Object.hasOwn(EXTRA_CAST_ALIASES, norm) ? EXTRA_CAST_ALIASES[norm] : norm;
  if (Object.hasOwn(EXTRA_CAST_MATERIALS, aliased)) {
    const extra = EXTRA_CAST_MATERIALS[aliased as DfmExtraCastMaterialId];
    return { id: aliased as DfmExtraCastMaterialId, label: extra.label, minSectionMm: extra.minSectionMm, slip: false };
  }
  const baseId = resolveCastMaterial(aliased);
  if (baseId) {
    const m = castMaterial(baseId);
    return { id: baseId, label: m.label, minSectionMm: m.minSectionMm, slip: Boolean(m.slip) };
  }
  return null;
}

/** Resolves a casting material name, falling back to `epoxy` with `fallbackFrom` set if unknown. */
export function resolveDfmCastMaterial(value: unknown): ResolvedDfmCastMaterial {
  if (value === undefined || value === null || value === '') {
    const m = castMaterial('epoxy');
    return { id: 'epoxy', label: m.label, minSectionMm: m.minSectionMm, slip: false };
  }
  const hit = resolveDfmCastMaterialStrict(value);
  if (hit) return hit;
  const m = castMaterial('epoxy');
  return { id: 'epoxy', label: m.label, minSectionMm: m.minSectionMm, slip: false, fallbackFrom: String(value) };
}

/** Minimum recommended air gap between opposing walls in a print-in-place assembly, mm. */
export const PRINT_MIN_AIR_GAP_MM = 0.35;

export type DfmProcess = 'print' | 'cnc' | 'cast';
export type DfmSeverity = 'critical' | 'warning' | 'info';

/** Serializable 1-click remediation actions attached to findings; executed by DfmHUD. */
export type DfmAction =
  | { kind: 'open_split'; label: string; nodeId?: string }
  | { kind: 'apply_print_pose'; label: string; nodeId: string; up: [number, number, number]; spin: number }
  | { kind: 'set_filament'; label: string; filament: FilamentId }
  | { kind: 'set_nozzle'; label: string; nozzleMm: number }
  | { kind: 'fit_stock'; label: string; widthMm: number; depthMm: number; thicknessMm: number }
  | { kind: 'open_fab'; label: string; modal: 'solid' | 'mold'; moldTab?: string }
  | { kind: 'open_edge_round'; label: string; nodeId?: string; radiusMm?: number }
  | { kind: 'thicken_boss'; label: string; nodeId: string; outerDiameterMm: number };

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
  /** The printer's build volume, mm. Null when it should not be checked. */
  bedMm: { widthMm: number; depthMm: number; heightMm: number } | null;
  /**
   * Thinnest wall that survives being CUT, as opposed to printed. A separate
   * number because they answer to different things: the printed one is the
   * nozzle, this one is whether the remaining material holds together.
   */
  cncMinWallMm: number;
  /**
   * Thinnest section a casting keeps, mm: the larger of what the poured
   * material fills (castMaterials' minSectionMm) and what a printed mold or
   * pattern reproduces (PRINTED_DETAIL_MM).
   */
  castMinSectionMm: number;
  /** The casting is clay slip in plaster: sharp inside corners crack as it dries and fires. */
  castSlip?: boolean;
  /** Resolved casting material id (e.g. 'bronze', 'aluminium', 'pewter', 'epoxy'). */
  castMaterial?: DfmCastMaterialId;
  /** Resolved casting material display label. */
  castMaterialLabel?: string;
  /** Printer process ('fdm' | 'resin'). Resin runs SLA suction-cup checks instead of FDM bridging/warping. */
  printerProcess?: 'fdm' | 'resin';
  /** Active FDM nozzle diameter, mm (used for thin-wall remediation suggestions). */
  nozzleMm?: number;
}

/**
 * The finest detail a printed mold or pattern holds, mm: two 0.4 mm beads.
 * A 0.6 mm spoke in the master is a slot the nozzle cannot draw in the mold.
 */
export const PRINTED_DETAIL_MM = 0.8;

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
  /** Localized flat overhang ledge (e.g. upright snap-hook catch lip) that needs support even on a large part. */
  severeOverhangDeg: 80,
  severeOverhangSpanMm: 0.8,
  severeOverhangMinZMm: 1.0,
  severeOverhangMinAreaMm2: 0.5,
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
  printBed?: { widthMm: number; depthMm: number; heightMm: number } | null;
  /** Shorthand print build volume `[widthMm, depthMm, heightMm]`; overrides `printBed` when provided. */
  bed_mm?: [number, number, number] | null;
  /** Active printer settings (FDM nozzle/layer or Resin SLA pixel/layer). */
  printer?: PrinterSettings | null;
  /**
   * The body to judge. Absent means the whole scene (gated on multi-body scenes
   * unless `checkAllAsPlate` is true).
   */
  nodeId?: string | null;
  /** When true with `nodeId == null` on a multi-body scene, run per-part DFM on every body. */
  checkAllAsPlate?: boolean;
  /** What is poured, for the casting lens's thinnest section (default epoxy). */
  castMaterial?: DfmCastMaterialId | string;
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
  const printer = bench.printer ?? null;
  const isResin = printer?.process === 'resin';
  const pLim = printer ? printLimits(printer) : null;
  // Two extrusion beads for FDM (so a 0.8 mm nozzle checks 1.6 mm walls, and 0.4 mm matches PLA's 0.8 mm).
  // For Resin SLA, at least 0.5 mm structural wall or the printer's pixel limit.
  const minWallMm = isResin
    ? Math.max(0.5, pLim!.minWallMm)
    : pLim
      ? Math.max(fil.minWallMm, 2 * pLim.minWallMm)
      : fil.minWallMm;
  const biggestBit = STANDARD_BIT_DIAS[STANDARD_BIT_DIAS.length - 1];
  const resolvedBed =
    Array.isArray(bench.bed_mm) &&
    bench.bed_mm.length === 3 &&
    bench.bed_mm.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)
      ? { widthMm: bench.bed_mm[0], depthMm: bench.bed_mm[1], heightMm: bench.bed_mm[2] }
      : (bench.printBed ?? null);
  const resolvedCast = resolveDfmCastMaterial(bench.castMaterial);
  return {
    overhangDeg: isResin ? 45 : fil.maxOverhangDeg,
    minWallMm,
    bridges: isResin ? true : fil.bridges,
    warpsOnLargeFlats: isResin ? false : fil.warpsOnLargeFlats,
    toolDiaMm: 3.175,
    maxToolReachMm: biggestBit * MAX_AVAILABLE_REACH_DIAMETERS,
    draftDeg: 2,
    stockMm: bench.stock ?? null,
    bedMm: resolvedBed,
    cncMinWallMm: mat.minWallMm,
    castMinSectionMm: Math.max(PRINTED_DETAIL_MM, resolvedCast.minSectionMm),
    castSlip: resolvedCast.slip,
    castMaterial: resolvedCast.id,
    castMaterialLabel: resolvedCast.label,
    printerProcess: isResin ? 'resin' : 'fdm',
    nozzleMm: printer?.nozzleMm ?? 0.4,
  };
}

/** Inside corners turning more than this at one edge are sharp, degrees. */
const SHARP_INSIDE_DEG = 60;

/**
 * Edges where the surface turns inward sharply in one step (an inside corner
 * with no radius): their total length and the middle of the longest, in the
 * soup's units. Vertices are matched by position, so a soup of separate
 * triangles reads as the surface it is.
 */
export function sharpInsideCorners(tris: Float64Array): { length: number; at: [number, number, number] } | null {
  const count = tris.length / 9;
  const ids = new Map<string, number>();
  const id = (o: number) => {
    const key = `${Math.round(tris[o] * 1e7)},${Math.round(tris[o + 1] * 1e7)},${Math.round(tris[o + 2] * 1e7)}`;
    let v = ids.get(key);
    if (v === undefined) { v = ids.size; ids.set(key, v); }
    return v;
  };
  /** Per edge (a < b): the triangles on it and the offset of each one's third corner. */
  const edges = new Map<number, { t: number; far: number; a: number; b: number }[]>();
  const n = count * 3 + 1;
  for (let t = 0; t < count; t++) {
    const o = t * 9;
    const v = [id(o), id(o + 3), id(o + 6)];
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3];
      const key = a < b ? a * n + b : b * n + a;
      const list = edges.get(key) ?? [];
      list.push({ t, far: o + ((k + 2) % 3) * 3, a: o + k * 3, b: o + ((k + 1) % 3) * 3 });
      edges.set(key, list);
    }
  }
  const cosLimit = Math.cos((SHARP_INSIDE_DEG * Math.PI) / 180);
  let length = 0, longest = 0;
  let at: [number, number, number] = [0, 0, 0];
  for (const list of edges.values()) {
    if (list.length !== 2) continue;
    const [e1, e2] = list;
    const n1 = triNormal(tris, e1.t), n2 = triNormal(tris, e2.t);
    if (!n1 || !n2) continue;
    if (n1.n[0] * n2.n[0] + n1.n[1] * n2.n[1] + n1.n[2] * n2.n[2] > cosLimit) continue;
    // Inside: the second triangle's far corner stands out past the first's face.
    const dx = tris[e2.far] - tris[e1.a], dy = tris[e2.far + 1] - tris[e1.a + 1], dz = tris[e2.far + 2] - tris[e1.a + 2];
    if (dx * n1.n[0] + dy * n1.n[1] + dz * n1.n[2] <= 0) continue;
    const len = Math.hypot(tris[e1.b] - tris[e1.a], tris[e1.b + 1] - tris[e1.a + 1], tris[e1.b + 2] - tris[e1.a + 2]);
    length += len;
    if (len > longest) {
      longest = len;
      at = [(tris[e1.a] + tris[e1.b]) / 2, (tris[e1.a + 1] + tris[e1.b + 1]) / 2, (tris[e1.a + 2] + tris[e1.b + 2]) / 2];
    }
  }
  return length > 0 ? { length, at } : null;
}

export const DFM_DEFAULTS: DfmLimits = dfmLimitsFor({
  material: DEFAULT_MATERIAL,
  filament: DEFAULT_FILAMENT,
  stock: null,
});

export interface DfmFinding {
  id: string;
  /** The body this finding belongs to, for click-to-select & spatial focus. */
  nodeId?: string;
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
  /**
   * A check that came out fine, listed so it is seen to have been made — a
   * seal that will seal. It costs nothing in the score.
   */
  passed?: true;
  /**
   * From the assembly checks (seals, screws, runners, insert bosses), which
   * read where the parts sit relative to each other, so can be re-run on live
   * poses; see withLivePoses.
   */
  assembly?: true;
  /** Optional 1-click remediation chips rendered by DfmHUD. */
  actions?: DfmAction[];
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
  /** Set on unselected multi-body scenes when per-part avalanche checks were gated. */
  needsPartSelection?: { bodyCount: number };
  /** Label when the report was evaluated in a non-default pose (e.g. 'print pose'). */
  judgedPoseLabel?: string;
  /** The scoped body id this report was generated for, preserved across withLivePoses. */
  nodeId?: string | null;
  /** Resolved minimum wall-thickness threshold used by this check, mm. */
  minWallMm?: number;
  /** Resolved casting material id when `process === 'cast'`. */
  castMaterial?: DfmCastMaterialId;
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
    const x = tris[i], y = tris[i + 1], z = tris[i + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
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

// Measured in utils/printSupport.ts, where Split for Print can reach it
// without loading this module.
export { overhangDeg, supportArea };

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

/** A grid fine enough to see the limits being measured, and no finer. NaN/zero-span safe. */
function gridFor(span: number, featureMm: number) {
  if (!Number.isFinite(span) || span <= 1e-6 || !Number.isFinite(featureMm)) return 0;
  const target = Math.ceil((span * 1000) / Math.max(0.2, featureMm / 2));
  return Math.max(16, Math.min(320, target));
}

const SEVERITY_RANK: Record<DfmSeverity, number> = { critical: 3, warning: 2, info: 1 };

function primaryFindingSummary(findings: DfmFinding[]): string {
  const open = findings.filter((f) => !f.passed);
  if (open.length === 0) return '';
  let best = open[0];
  for (const f of open) {
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[best.severity]) best = f;
  }
  return open.length === 1 ? `${best.title}.` : `${best.title} (+${open.length - 1} more).`;
}

// ---------------------------------------------------------------------------
// 3D printing
// ---------------------------------------------------------------------------

/** Maximum horizontal XY span (mm) of any connected cluster of unbridgeable ceiling triangles. */
function maxCeilingClusterSpanMm(tris: Float64Array, ceilingTris: number[]): number {
  if (ceilingTris.length === 0) return 0;
  const CELL = 0.005; // 5 mm clustering grid
  const cells = new Map<string, number[]>();
  const keyOf = (ix: number, iy: number, iz: number) => `${ix},${iy},${iz}`;
  const triCells: [number, number, number][] = [];
  for (let idx = 0; idx < ceilingTris.length; idx++) {
    const c = triCentroid(tris, ceilingTris[idx]);
    const ix = Math.floor(c[0] / CELL);
    const iy = Math.floor(c[1] / CELL);
    const iz = Math.floor(c[2] / CELL);
    triCells.push([ix, iy, iz]);
    const k = keyOf(ix, iy, iz);
    let list = cells.get(k);
    if (!list) cells.set(k, (list = []));
    list.push(idx);
  }
  const visited = new Uint8Array(ceilingTris.length);
  let maxSpanMm = 0;
  const queue: number[] = [];
  for (let start = 0; start < ceilingTris.length; start++) {
    if (visited[start]) continue;
    visited[start] = 1;
    queue.length = 0;
    queue.push(start);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let qi = 0; qi < queue.length; qi++) {
      const cur = queue[qi];
      const o = ceilingTris[cur] * 9;
      for (let v = 0; v < 9; v += 3) {
        const x = tris[o + v], y = tris[o + v + 1];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      const [ix, iy, iz] = triCells[cur];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const neigh = cells.get(keyOf(ix + dx, iy + dy, iz + dz));
            if (!neigh) continue;
            for (const nxt of neigh) {
              if (!visited[nxt]) { visited[nxt] = 1; queue.push(nxt); }
            }
          }
        }
      }
    }
    const spanMm = Math.max(maxX - minX, maxY - minY) * 1000;
    if (spanMm > maxSpanMm) maxSpanMm = spanMm;
  }
  return maxSpanMm;
}

/** Worst connected cluster of severe flat-overhang triangles: horizontal XY span (mm), area (mm²), and centroid. */
function worstSevereOverhangCluster(
  tris: Float64Array,
  severeTris: number[],
): { spanMm: number; areaMm2: number; position: [number, number, number] } | null {
  if (severeTris.length === 0) return null;
  const CELL = 0.005; // 5 mm clustering grid
  const cells = new Map<string, number[]>();
  const keyOf = (ix: number, iy: number, iz: number) => `${ix},${iy},${iz}`;
  const triCells: [number, number, number][] = [];
  for (let idx = 0; idx < severeTris.length; idx++) {
    const c = triCentroid(tris, severeTris[idx]);
    const ix = Math.floor(c[0] / CELL);
    const iy = Math.floor(c[1] / CELL);
    const iz = Math.floor(c[2] / CELL);
    triCells.push([ix, iy, iz]);
    const k = keyOf(ix, iy, iz);
    let list = cells.get(k);
    if (!list) cells.set(k, (list = []));
    list.push(idx);
  }
  const visited = new Uint8Array(severeTris.length);
  let best: { spanMm: number; areaMm2: number; position: [number, number, number] } | null = null;
  const queue: number[] = [];
  for (let start = 0; start < severeTris.length; start++) {
    if (visited[start]) continue;
    visited[start] = 1;
    queue.length = 0;
    queue.push(start);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let areaSum = 0, sx = 0, sy = 0, sz = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const cur = queue[qi];
      const tIdx = severeTris[cur];
      const o = tIdx * 9;
      for (let v = 0; v < 9; v += 3) {
        const x = tris[o + v], y = tris[o + v + 1];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      const n = triNormal(tris, tIdx);
      const a = n ? n.area : 0;
      const c = triCentroid(tris, tIdx);
      areaSum += a;
      sx += c[0] * a; sy += c[1] * a; sz += c[2] * a;
      const [ix, iy, iz] = triCells[cur];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const neigh = cells.get(keyOf(ix + dx, iy + dy, iz + dz));
            if (!neigh) continue;
            for (const nxt of neigh) {
              if (!visited[nxt]) { visited[nxt] = 1; queue.push(nxt); }
            }
          }
        }
      }
    }
    const spanMm = Math.max(maxX - minX, maxY - minY) * 1000;
    const areaMm2 = areaSum * 1e6;
    if (!best || spanMm > best.spanMm) {
      const pos: [number, number, number] = areaSum > 0
        ? [sx / areaSum, sy / areaSum, sz / areaSum]
        : triCentroid(tris, severeTris[start]);
      best = { spanMm, areaMm2, position: pos };
    }
  }
  return best;
}

/** Outward-wound axis-aligned box triangles (12 triangles, 108 floats). */
function appendBoxSoup(out: Float64Array, offset: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
  const faces: [number, number, number][][] = [
    // -Z (outward normal 0,0,-1)
    [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [[x0, y0, z0], [x1, y1, z0], [x1, y0, z0]],
    // +Z (outward normal 0,0,+1)
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1]], [[x0, y0, z1], [x1, y1, z1], [x0, y1, z1]],
    // -Y (outward normal 0,-1,0)
    [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1]], [[x0, y0, z0], [x1, y0, z1], [x0, y0, z1]],
    // +Y (outward normal 0,+1,0)
    [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1]], [[x0, y1, z0], [x1, y1, z1], [x1, y1, z0]],
    // -X (outward normal -1,0,0)
    [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1]], [[x0, y0, z0], [x0, y1, z1], [x0, y1, z0]],
    // +X (outward normal +1,0,0)
    [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [[x1, y0, z0], [x1, y1, z1], [x1, y0, z1]],
  ];
  let k = offset;
  for (const tri of faces) {
    for (const v of tri) {
      out[k++] = v[0]; out[k++] = v[1]; out[k++] = v[2];
    }
  }
}

/**
 * SLA / Resin suction-cup detection.
 *
 * In bottom-up resin printing, the build plate sits at `minZ` and pulls upward
 * out of the vat so the model's `+Z` points downward into the liquid resin.
 * Inverting Z (`z' = -z`) turns the part's solid into an inward-wound void inside
 * an enclosing air box (`[-maxZ - 0.02, -minZ + 2]` mm), so `trappedAirInSoup`
 * locates cavities/cups that trap air or resin suction against the FEP film.
 */
function findSlaTrappedCups(tris: Float64Array, b: ReturnType<typeof bounds>): { x: number; y: number; z: number }[] {
  if (!Number.isFinite(b.minX) || !(b.maxZ - b.minZ > 0.002)) return [];
  const minXMm = b.minX * 1000, maxXMm = b.maxX * 1000;
  const minYMm = b.minY * 1000, maxYMm = b.maxY * 1000;
  const minZMm = b.minZ * 1000, maxZMm = b.maxZ * 1000;
  const pad = 2;
  const zBot = -maxZMm - 0.02; // < MIN_SPAN_MM (0.05) so solid top faces don't create false air slivers
  const zTop = -minZMm + 2;

  const airSoup = new Float64Array(108 + tris.length);
  appendBoxSoup(airSoup, 0, minXMm - pad, minYMm - pad, zBot, maxXMm + pad, maxYMm + pad, zTop);
  for (let i = 0; i < tris.length; i += 3) {
    airSoup[108 + i] = tris[i] * 1000;
    airSoup[108 + i + 1] = tris[i + 1] * 1000;
    airSoup[108 + i + 2] = -tris[i + 2] * 1000;
  }

  const raw = trappedAirInSoup(airSoup, zTop);
  if (raw.length === 0) return [];

  // Confirm each candidate pocket is horizontally enclosed by part walls (not an open flat shelf).
  const checkEnclosed = (px: number, py: number, pzOrig: number): boolean => {
    const zProbe = pzOrig + 0.001; // 1 mm into the cup opening along +Z (toward mouth)
    let hitPosX = false, hitNegX = false, hitPosY = false, hitNegY = false;
    for (let t = 0; t + 8 < tris.length; t += 9) {
      const az = tris[t + 2], bz = tris[t + 5], cz = tris[t + 8];
      if ((az < zProbe && bz < zProbe && cz < zProbe) || (az > zProbe && bz > zProbe && cz > zProbe)) continue;
      // Intersect triangle with plane z = zProbe to get a 2D segment in XY.
      const pts: [number, number][] = [];
      const vs: [number, number, number][] = [
        [tris[t], tris[t + 1], az],
        [tris[t + 3], tris[t + 4], bz],
        [tris[t + 6], tris[t + 7], cz],
      ];
      for (let e = 0; e < 3; e++) {
        const p0 = vs[e], p1 = vs[(e + 1) % 3];
        const d0 = p0[2] - zProbe, d1 = p1[2] - zProbe;
        if ((d0 <= 0 && d1 >= 0) || (d0 >= 0 && d1 <= 0)) {
          const denom = p1[2] - p0[2];
          if (Math.abs(denom) > 1e-12) {
            const f = (zProbe - p0[2]) / denom;
            pts.push([p0[0] + f * (p1[0] - p0[0]), p0[1] + f * (p1[1] - p0[1])]);
          }
        }
      }
      if (pts.length < 2) continue;
      const [x0, y0] = pts[0], [x1, y1] = pts[1];
      // Horizontal ray along ±X at y = py:
      if ((y0 <= py && y1 > py) || (y1 <= py && y0 > py)) {
        const xHit = x0 + ((py - y0) / (y1 - y0)) * (x1 - x0);
        if (xHit > px) hitPosX = true;
        else if (xHit < px) hitNegX = true;
      }
      // Horizontal ray along ±Y at x = px:
      if ((x0 <= px && x1 > px) || (x1 <= px && x0 > px)) {
        const yHit = y0 + ((px - x0) / (x1 - x0)) * (y1 - y0);
        if (yHit > py) hitPosY = true;
        else if (yHit < py) hitNegY = true;
      }
      if (hitPosX && hitNegX && hitPosY && hitNegY) return true;
    }
    return hitPosX && hitNegX && hitPosY && hitNegY;
  };

  const out: { x: number; y: number; z: number }[] = [];
  for (const p of raw) {
    const x = p.x / 1000;
    const y = p.y / 1000;
    const z = -p.z / 1000;
    if (checkEnclosed(x, y, z)) out.push({ x, y, z });
  }
  return out;
}

function analysePrint(
  tris: Float64Array,
  limits: DfmLimits,
  wallTris: Float64Array = tris,
  posedForBed = false,
  gapTris: Float64Array = wallTris,
): Omit<DfmReport, 'process' | 'tris' | 'warnings'> {
  const count = Math.floor(tris.length / 9);
  const heat = new Float32Array(count);
  const findings: DfmFinding[] = [];
  const b = bounds(tris);
  const isResin = limits.printerProcess === 'resin';

  let worstDeg = 0, unbridgeable = 0;
  const ceilingTris: number[] = [];
  const severeOverhangTris: number[] = [];
  const { area: overhangArea, totalArea } = supportArea(tris, limits.overhangDeg, 0.0005, (t, deg, area) => {
    heat[t] = Math.min(1, (deg - limits.overhangDeg) / (90 - limits.overhangDeg));
    if (deg > worstDeg) worstDeg = deg;
    if (deg >= T.bridgeDeg) {
      unbridgeable += area;
      ceilingTris.push(t);
    }
    if (deg >= T.severeOverhangDeg) {
      const c = triCentroid(tris, t);
      if ((c[2] - b.minZ) * 1000 > T.severeOverhangMinZMm) {
        severeOverhangTris.push(t);
      }
    }
  });

  const share = totalArea > 0 ? overhangArea / totalArea : 0;

  // Support is the normal cost of printing, not a defect. This only speaks up
  // when the orientation is costing a LOT of it — the case where turning the
  // part is worth real time and a better surface — or when a localized flat
  // ledge (such as an upright snap-hook catch lip) hangs ≥ 80° in mid-air.
  if (share > T.overhangShare) {
    const at = hotSpot(tris, heat, 0.01) ?? [0, 0, b.maxZ];
    findings.push({
      id: 'print_overhang',
      process: 'print',
      severity: share > T.overhangShareCritical ? 'critical' : 'warning',
      title: `${(share * 100).toFixed(0)}% of the surface needs support`,
      detail: `${(share * 100).toFixed(0)}% of the surface overhangs past ${limits.overhangDeg}° (max ${worstDeg.toFixed(0)}°).`,
      fix: 'Reorient on the build plate to reduce downward-facing area.',
      position: at,
      metric: share,
    });
  }

  if (isResin) {
    // SLA / Resin: check for downward-facing suction cups / trapped resin cavities
    // instead of FDM bridging or bed-shrinkage warping.
    const cups = findSlaTrappedCups(tris, b);
    if (cups.length > 0) {
      const first = cups[0];
      findings.push({
        id: 'sla_trapped_cup',
        process: 'print',
        severity: 'critical',
        title: cups.length === 1 ? 'Resin suction cup / trapped cavity' : `${cups.length} resin suction cups / trapped cavities`,
        detail: `${cups.length === 1 ? 'A hollow cavity opens' : `${cups.length} cavities open`} toward the vat with no drain vent, creating peel suction and trapping uncured resin.`,
        fix: 'Tilt the part 20–45°, flip it open-side toward the build plate, or add a ≥ 2 mm drain hole at the lowest point.',
        position: [first.x, first.y, first.z],
        metric: cups.length,
      });
    }
  } else {
    // A filament that will not bridge cannot print a wide flat ceiling (> 5 mm)
    // without supports. Tiny screw-hole ceilings (<= 5 mm) are skipped.
    if (!limits.bridges && unbridgeable > 0 && totalArea > 0 && unbridgeable / totalArea > 0.01) {
      const ceilingSpanMm = maxCeilingClusterSpanMm(tris, ceilingTris);
      if (ceilingSpanMm > 5) {
        findings.push({
          id: 'print_no_bridge',
          process: 'print',
          severity: 'critical',
          title: 'Unsupported horizontal span',
          detail: `Horizontal faces span ${ceilingSpanMm.toFixed(0)} mm over open air; selected filament requires support across gaps.`,
          fix: 'Reorient the part or enable supports.',
          position: hotSpot(tris, heat, 0.8) ?? [0, 0, b.maxZ],
          metric: unbridgeable / totalArea,
        });
      }
    }

    // Tiny first-layer bed contact on a non-trivial part (> 8 mm tall): point/edge
    // contact or small isolated feet (< 12 mm²) peel off the bed and catch the nozzle.
    const partHeightMm = Number.isFinite(b.minZ) ? (b.maxZ - b.minZ) * 1000 : 0;
    if (partHeightMm > 8 && totalArea > 0) {
      const zBedBand = b.minZ + 0.00025;
      let bedContactMm2 = 0;
      for (let t = 0; t < count; t++) {
        const i = t * 9;
        const z0 = tris[i + 2], z1 = tris[i + 5], z2 = tris[i + 8];
        if (Math.max(z0, z1, z2) > zBedBand) continue;
        const ux = tris[i + 3] - tris[i], uy = tris[i + 4] - tris[i + 1], uz = z1 - z0;
        const vx = tris[i + 6] - tris[i], vy = tris[i + 7] - tris[i + 1], vz = z2 - z0;
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz);
        if (len > 1e-12 && nz / len < -0.85) bedContactMm2 += (len / 2) * 1e6;
      }
      if (bedContactMm2 < 12) {
        findings.push({
          id: 'print_tiny_bed_contact',
          process: 'print',
          severity: bedContactMm2 < 3 ? 'critical' : 'warning',
          title: bedContactMm2 < 0.5 ? 'Point/edge bed contact on first layer' : `Small first-layer footprint (${bedContactMm2.toFixed(1)} mm²)`,
          detail: `Only ${bedContactMm2.toFixed(1)} mm² of flat surface touches the build plate across a ${partHeightMm.toFixed(0)} mm tall print, risking first-layer detachment or nozzle collision.`,
          fix: 'Orient a flat face onto the build plate (Split for Print auto-orients sections) or add a brim/raft in your slicer.',
          position: [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, b.minZ],
          metric: bedContactMm2,
        });
      }
    }

    // Shrinkage warping depends on actual bed-contact footprint (z <= minZ + 1.5 mm),
    // not a wide mid-air canopy above a narrow stem.
    if (limits.warpsOnLargeFlats && Number.isFinite(b.minZ)) {
      const zCut = b.minZ + 0.0015;
      let fMinX = Infinity, fMaxX = -Infinity, fMinY = Infinity, fMaxY = -Infinity;
      for (let i = 0; i < tris.length; i += 3) {
        const x = tris[i], y = tris[i + 1], z = tris[i + 2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        if (z <= zCut) {
          if (x < fMinX) fMinX = x; if (x > fMaxX) fMaxX = x;
          if (y < fMinY) fMinY = y; if (y > fMaxY) fMaxY = y;
        }
      }
      const spanMm = fMaxX > fMinX || fMaxY > fMinY ? Math.max(fMaxX - fMinX, fMaxY - fMinY) * 1000 : 0;
      if (spanMm > T.warpSpanMm) {
        findings.push({
          id: 'print_warp',
          process: 'print',
          severity: 'warning',
          title: `Large footprint (${spanMm.toFixed(0)} mm) in high-shrinkage filament`,
          detail: `${spanMm.toFixed(0)} mm bed-contact span may warp or lift at the corners during cooling.`,
          fix: 'Use an enclosure and brim, bevel the base, or switch to PLA/PETG.',
          position: [(fMinX + fMaxX) / 2, (fMinY + fMaxY) / 2, b.minZ],
          metric: spanMm,
          actions: [
            { kind: 'set_filament', label: 'Switch to PETG', filament: 'petg' },
            { kind: 'open_edge_round', label: 'Bevel base', radiusMm: 1 },
          ],
        });
      }
    }
  }

  const thin = wallTris.length >= 9 ? thinnestWall(wallTris, limits.minWallMm) : null;
  if (thin && thin.mm < limits.minWallMm && thin.share > T.thinCellShare) {
    const actions: DfmAction[] = [];
    const nozzle = limits.nozzleMm ?? 0.4;
    if (!isResin) {
      if (nozzle > 0.4 && thin.mm >= 0.8) actions.push({ kind: 'set_nozzle', label: 'Use 0.4 mm nozzle', nozzleMm: 0.4 });
      else if (nozzle > 0.2) actions.push({ kind: 'set_nozzle', label: 'Use 0.2 mm nozzle', nozzleMm: 0.2 });
    }
    // Vertical-extruded XY beams >= 0.8 mm (thin in X or Y, printed flat on the bed)
    // are often intentional compliant flexure blades (>= 2 perimeters on a 0.4 mm nozzle).
    // Avoid over-penalizing them with warning/critical severity; report as an info note instead.
    const isXyFlexureBeam = !isResin && (thin.axis === 0 || thin.axis === 1) && thin.mm >= 0.8;
    const severity: DfmSeverity = isXyFlexureBeam
      ? 'info'
      : thin.mm < limits.minWallMm / 2
        ? 'critical'
        : 'warning';
    findings.push({
      id: 'print_thin_wall',
      process: 'print',
      severity,
      title: isXyFlexureBeam
        ? `Thin vertical XY beam (${thin.mm.toFixed(2)} mm)`
        : `Wall down to ${thin.mm.toFixed(2)} mm`,
      detail: isXyFlexureBeam
        ? `Minimum wall is ${thin.mm.toFixed(2)} mm (min ${limits.minWallMm} mm for this printer & filament). Note: vertical-extruded XY beams ≥ 0.8 mm print cleanly flat on the bed as intentional flexure blades (≥ 2 perimeters with a 0.4 mm nozzle).`
        : `Minimum wall is ${thin.mm.toFixed(2)} mm (min ${limits.minWallMm} mm for this ${isResin ? 'resin printer' : 'printer & filament'}).`,
      fix: isXyFlexureBeam
        ? `Keep as-is if this is an intentional XY-flat flexure blade; otherwise thicken structural walls to at least ${limits.minWallMm} mm.`
        : `Thicken walls to at least ${limits.minWallMm} mm.`,
      position: thin.at,
      metric: thin.mm,
      ...(actions.length ? { actions } : {}),
    });
  }

  // Localized flat downward-facing ledges (e.g. upright snap-hook catch lips >= 80°
  // and >= 0.8 mm span above z > 1 mm) still need support even when total overhang
  // area is below 25%. Checked after thin walls so unprintable walls lead the summary.
  if (share <= T.overhangShare && severeOverhangTris.length > 0) {
    const severe = worstSevereOverhangCluster(tris, severeOverhangTris);
    if (severe && severe.spanMm >= T.severeOverhangSpanMm && severe.areaMm2 >= T.severeOverhangMinAreaMm2) {
      findings.push({
        id: 'print_severe_overhang',
        process: 'print',
        severity: 'warning',
        title: `Flat ${worstDeg.toFixed(0)}° overhang needs support`,
        detail: `Localized flat downward-facing ledge (${severe.spanMm.toFixed(1)} mm span at ${worstDeg.toFixed(0)}°, ${((severe.position[2] - b.minZ) * 1000).toFixed(1)} mm above the bed) cannot print cleanly without support.`,
        fix: 'Reorient the part (e.g. lay hooks flat on the bed), add a 45° chamfer under the ledge, or enable supports.',
        position: severe.position,
        metric: severe.spanMm,
      });
    }
  }

  // Print-in-place opposing-wall air-gap clearance check (< 0.35 mm risks fusion).
  const gap = gapTris.length >= 9 ? narrowestAirGap(gapTris, PRINT_MIN_AIR_GAP_MM) : null;
  if (gap) {
    findings.push({
      id: 'print_narrow_gap',
      process: 'print',
      severity: gap.mm < 0.2 ? 'critical' : 'warning',
      title: `Narrow air gap (${gap.mm.toFixed(2)} mm) risks fusion`,
      detail: `Opposing walls are separated by ${gap.mm.toFixed(2)} mm (minimum ${PRINT_MIN_AIR_GAP_MM} mm recommended for print-in-place clearance to avoid fusing).`,
      fix: `Increase print-in-place air-gap clearance between opposing walls to at least ${PRINT_MIN_AIR_GAP_MM} mm (0.4 mm recommended for FDM).`,
      position: gap.at,
      metric: gap.mm,
    });
  }

  findings.push(...bedFindings(b, limits, tris, posedForBed));

  const summary = findings.length === 0
    ? (isResin ? 'Nothing here should give a resin printer trouble.' : 'Nothing here should give a printer trouble.')
    : share > 0.005 && findings.some((f) => f.id === 'print_overhang')
      ? `${(share * 100).toFixed(0)}% of the surface overhangs.`
      : primaryFindingSummary(findings);

  return {
    findings,
    heat,
    legend: isResin
      ? `Unsupported overhang — red faces straight down, amber is just past ${limits.overhangDeg}°`
      : `Unsupported overhang — red is flat over air, amber is just past ${limits.overhangDeg}°`,
    score: scoreOf(findings),
    summary,
  };
}

/**
 * Whether the part fits the printer at all, in any of the six square-on ways
 * up. Turning it at an angle can sometimes squeeze a part in that this says
 * will not fit; Split for Print searches those, and says so if it finds one.
 *
 * Same ballpark rule as the stock: a part many times the bed is a scene, not a
 * print, and telling someone their bridge will not fit a printer is noise.
 */
const BED_BALLPARK = 2.2;

/** Checks if a 45° diagonal spin on any of the 6 square-on orientations fits the bed. */
function findDiagonalBedPose(
  tris: Float64Array,
  bed: { widthMm: number; depthMm: number; heightMm: number },
): { up: [number, number, number]; spin: number } | null {
  const spin = Math.PI / 4;
  for (const side of SIDES) {
    const m = poseMatrix({ up: side.up, spin });
    const rot = rotatePoints(m, tris);
    const rb = bounds(rot);
    const w = (rb.maxX - rb.minX) * 1000;
    const d = (rb.maxY - rb.minY) * 1000;
    const h = (rb.maxZ - rb.minZ) * 1000;
    if (((w <= bed.widthMm && d <= bed.depthMm) || (d <= bed.widthMm && w <= bed.depthMm)) && h <= bed.heightMm) {
      return { up: side.up, spin };
    }
  }
  return null;
}

function bedFindings(
  b: ReturnType<typeof bounds>,
  limits: DfmLimits,
  tris?: Float64Array,
  posedForBed = false,
): DfmFinding[] {
  const bed = limits.bedMm;
  if (!bed || !Number.isFinite(b.minX)) return [];
  const size = [(b.maxX - b.minX) * 1000, (b.maxY - b.minY) * 1000, (b.maxZ - b.minZ) * 1000];
  if (posedForBed) {
    // In an explicit printPose, check the posed XY footprint & Z height directly
    // (allowing a 90° XY table swap) before falling back to square-on check.
    const fitsPosed =
      ((size[0] <= bed.widthMm && size[1] <= bed.depthMm) || (size[1] <= bed.widthMm && size[0] <= bed.depthMm)) &&
      size[2] <= bed.heightMm;
    if (fitsPosed) return [];
  }
  if (fitsBedSquareOn(size, bed)) return [];
  const worst = Math.max(...size) / Math.max(bed.widthMm, bed.depthMm, bed.heightMm);
  if (worst > BED_BALLPARK) return [];
  const over = Math.max(size[0] - bed.widthMm, size[1] - bed.depthMm, size[2] - bed.heightMm, 0);
  const actions: DfmAction[] = [{ kind: 'open_split', label: 'Split for Print…' }];
  const diag = tris && !posedForBed ? findDiagonalBedPose(tris, bed) : null;
  if (diag) {
    actions.unshift({
      kind: 'apply_print_pose',
      label: 'Auto-orient to fit (45°)',
      nodeId: '',
      up: diag.up,
      spin: diag.spin,
    });
  }
  return [{
    id: 'print_exceeds_bed',
    process: 'print',
    severity: 'critical',
    title: 'Exceeds print bed',
    detail: `Part is ${size.map((v) => v.toFixed(0)).join(' × ')} mm; bed is ${bed.widthMm} × ${bed.depthMm} × ${bed.heightMm} mm (${over.toFixed(0)} mm over limit).`,
    fix: diag ? 'Rotate diagonally on the bed, scale down, or use Split for Print.' : 'Scale down or use Split for Print.',
    position: [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, b.maxZ],
    metric: worst,
    actions,
  }];
}

/** Whether a box of these sides fits the bed in one of its six square-on orientations. */
export function fitsBedSquareOn(sizeMm: number[], bed: { widthMm: number; depthMm: number; heightMm: number }): boolean {
  const [a, b, c] = sizeMm;
  const orders = [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]];
  return orders.some(([w, d, h]) => w <= bed.widthMm && d <= bed.depthMm && h <= bed.heightMm);
}

/**
 * Whether the part fits the board that is clamped down.
 *
 * CNC only. `stock` is what is on the router bed; the printer's bed is the
 * print lens's own question, answered by bedFindings.
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
  if (!stock || !Number.isFinite(b.minX)) return [];
  const w = (b.maxX - b.minX) * 1000;
  const d = (b.maxY - b.minY) * 1000;
  const h = (b.maxZ - b.minZ) * 1000;

  const fitsPlan = (w <= stock.widthMm && d <= stock.depthMm) || (d <= stock.widthMm && w <= stock.depthMm);
  const fitsThick = h <= stock.thicknessMm;
  if (fitsPlan && fitsThick) return [];

  // Plainly not meant for this board. Compare sorted dimensions so the
  // ballpark gate is invariant to 90° rotations — otherwise analyseBestSide
  // can stand a flat board on edge (making h >> stock.thicknessMm) just to
  // silence stock_fit and trade a critical fit error for a cnc_reach warning.
  const partSorted = [w, d, h].sort((a, b) => a - b);
  const stockSorted = [stock.widthMm, stock.depthMm, stock.thicknessMm].sort((a, b) => a - b);
  if (
    partSorted[0] / stockSorted[0] > STOCK_BALLPARK ||
    partSorted[1] / stockSorted[1] > STOCK_BALLPARK ||
    partSorted[2] / stockSorted[2] > STOCK_BALLPARK
  ) return [];

  const size = [w, d, h];
  const stockDims = [stock.widthMm, stock.depthMm, stock.thicknessMm];
  const over = Math.max(
    fitsPlan ? 0 : Math.min(Math.max(w - stock.widthMm, d - stock.depthMm), Math.max(d - stock.widthMm, w - stock.depthMm)),
    Math.max(0, h - stock.thicknessMm),
  );
  const fitW = Math.max(stock.widthMm, Math.ceil(w + 10));
  const fitD = Math.max(stock.depthMm, Math.ceil(d + 10));
  const fitT = Math.max(stock.thicknessMm, Math.ceil(h + 2));
  return [{
    id: 'stock_fit',
    process: 'cnc',
    severity: 'critical',
    title: 'Exceeds stock dimensions',
    detail: `Part is ${size.map((v) => v.toFixed(0)).join(' × ')} mm; bench stock is ${stockDims.map((v) => v.toFixed(0)).join(' × ')} mm (${over.toFixed(1)} mm over).`,
    fix: 'Increase stock dimensions or scale the part down.',
    position: [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, b.maxZ],
    actions: [{
      kind: 'fit_stock',
      label: 'Fit stock (+10 mm)',
      widthMm: fitW,
      depthMm: fitD,
      thicknessMm: fitT,
    }],
  }];
}

/**
 * The thinnest material anywhere in the part, and how much of it is that thin.
 *
 * Looks through each axis in turn and inspects individual closed solid spans
 * (`sampleWallSpans`) rather than summing across hollow cavities, rejecting
 * grazing surface crests / mountain ridges where entry and exit normals do not
 * oppose each other or where the span ends without neighbour backing.
 */
export function thinnestWall(
  tris: Float64Array,
  minWallMm: number,
): { mm: number; at: [number, number, number]; share: number; axis: number } | null {
  if (tris.length < 9 || !Number.isFinite(minWallMm)) return null;
  let best: { mm: number; at: [number, number, number]; share: number; axis: number } | null = null;

  for (const axis of [0, 1, 2]) {
    // Rotate the soup so `axis` becomes Z, then sample individual wall spans.
    // Proper rotations only, so winding holds.
    const rotated = axis === 2 ? tris : rotateAxisToZ(tris, axis);
    const rb = bounds(rotated);
    const spanX = rb.maxX - rb.minX;
    const spanY = rb.maxY - rb.minY;
    const cols = gridFor(spanX, minWallMm);
    const rows = gridFor(spanY, minWallMm);
    if (cols < 3 || rows < 3) continue;
    const {
      spanStart, spanZ0, spanZ1, spanEnTri, spanExTri,
      minWall, minWallMid, minWallZ0, minWallZ1, hit,
    } = sampleWallSpans(rotated, rb, cols, rows);

    const stepX = spanX / (cols - 1);
    const stepY = spanY / (rows - 1);
    const baseMargin = Math.max(stepX, stepY) * 2.5;

    const shareVertexSq = 1e-10; // (0.01 mm)^2 in metres
    const trisShareVertex = (ta: number, tb: number): boolean => {
      if (ta < 0 || tb < 0) return false;
      for (let a = 0; a < 3; a++) {
        const ax = rotated[ta + a * 3], ay = rotated[ta + a * 3 + 1], az = rotated[ta + a * 3 + 2];
        for (let b = 0; b < 3; b++) {
          const dx = ax - rotated[tb + b * 3];
          const dy = ay - rotated[tb + b * 3 + 1];
          const dz = az - rotated[tb + b * 3 + 2];
          if (dx * dx + dy * dy + dz * dz <= shareVertexSq) return true;
        }
      }
      return false;
    };

    const isCreasePinch = (cellIdx: number, z0: number, z1: number): boolean => {
      const s0 = spanStart[cellIdx], s1 = spanStart[cellIdx + 1];
      for (let s = s0; s < s1; s++) {
        if (Math.abs(spanZ0[s] - z0) <= 1e-6 && Math.abs(spanZ1[s] - z1) <= 1e-6) {
          return trisShareVertex(spanEnTri[s], spanExTri[s]);
        }
      }
      return false;
    };

    const neighborHasSpanNear = (ni: number, z0: number, z1: number, margin: number): boolean => {
      const s0 = spanStart[ni], s1 = spanStart[ni + 1];
      for (let s = s0; s < s1; s++) {
        if (spanZ1[s] >= z0 - margin && spanZ0[s] <= z1 + margin) return true;
      }
      return false;
    };

    const neighborIsThin = (ni: number): boolean => {
      const w = minWall[ni];
      return Number.isFinite(w) && w * 1000 < minWallMm && w * 1000 >= 0.01;
    };

    let thinnest = Infinity;
    let at: [number, number, number] | null = null;
    let solidCells = 0, thinCells = 0;

    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        const i = r * cols + c;
        if (!hit[i]) continue;
        // INTERIOR COLUMNS ONLY.
        if (!hit[i - 1] || !hit[i + 1] || !hit[i - cols] || !hit[i + cols]) continue;
        const wallM = minWall[i];
        if (!Number.isFinite(wallM)) continue;
        const mm = wallM * 1000;
        if (mm < 0.01) continue;
        // Verify this specific span is backed by overlapping spans in all 4
        // neighbours, not a 1-cell summit/ridge crest sitting in front of
        // unrelated geometry further along the ray.
        const z0 = minWallZ0[i], z1 = minWallZ1[i];
        // Ignore tiny (< 0.2 mm) crease pinches where entry and exit triangles
        // share a vertex (e.g. a fillet-to-pattern or drafted fillet seam).
        if (mm < 0.2 && isCreasePinch(i, z0, z1)) continue;
        const margin = baseMargin + wallM;
        if (
          !neighborHasSpanNear(i - 1, z0, z1, margin) ||
          !neighborHasSpanNear(i + 1, z0, z1, margin) ||
          !neighborHasSpanNear(i - cols, z0, z1, margin) ||
          !neighborHasSpanNear(i + cols, z0, z1, margin)
        ) continue;
        solidCells++;
        const isThin = mm < minWallMm;
        if (isThin) {
          // A real thin wall/fin spans more than one isolated grid sample;
          // ignore a lone 1-cell fillet-seam outlier surrounded by thick walls.
          const backedThin =
            neighborIsThin(i - 1) || neighborIsThin(i + 1) ||
            neighborIsThin(i - cols) || neighborIsThin(i + cols);
          if (!backedThin) continue;
          thinCells++;
        }
        if (mm < thinnest) {
          thinnest = mm;
          at = [rb.minX + c * stepX, rb.minY + r * stepY, minWallMid[i]];
        }
      }
    }
    if (!at || !solidCells) continue;
    // How much of the part is actually thin, not just the single worst sample.
    const share = thinCells / solidCells;
    if (best && thinnest >= best.mm) continue;
    best = { mm: thinnest, at: unrotateFromZ(at, axis), share, axis };
  }
  return best;
}

/**
 * Finds the narrowest opposing-wall air gap (< `maxGapMm`, and >= 0.02 mm to
 * ignore coincident touching faces) along X, Y, or Z. Used to detect
 * print-in-place clearances that risk fusing during FDM printing.
 *
 * Requires the two bounding faces to oppose each other (`dot(nA, nB) < -0.5`
 * and aligned with the sampling ray) and skips interior V-creases (such as a
 * gable roof ridge apex) where two non-parallel walls converge directly into a
 * continuous solid.
 */
export function narrowestAirGap(
  tris: Float64Array,
  maxGapMm: number = PRINT_MIN_AIR_GAP_MM,
): { mm: number; at: [number, number, number]; axis: number; gapCells: number } | null {
  if (tris.length < 9 || !Number.isFinite(maxGapMm) || maxGapMm <= 0.02) return null;
  const MIN_GAP_MM = 0.02;
  let best: { mm: number; at: [number, number, number]; axis: number; gapCells: number } | null = null;

  for (const axis of [0, 1, 2]) {
    const rotated = axis === 2 ? tris : rotateAxisToZ(tris, axis);
    const rb = bounds(rotated);
    const spanX = rb.maxX - rb.minX;
    const spanY = rb.maxY - rb.minY;
    const cols = gridFor(spanX, Math.max(1.0, maxGapMm * 3));
    const rows = gridFor(spanY, Math.max(1.0, maxGapMm * 3));
    if (cols < 3 || rows < 3) continue;

    const {
      spanStart,
      spanZ0,
      spanZ1,
      spanEnNx,
      spanEnNy,
      spanEnNz,
      spanExNx,
      spanExNy,
      spanExNz,
      spanEnTri,
      spanExTri,
    } = sampleWallSpans(rotated, rb, cols, rows);
    const stepX = spanX / (cols - 1);
    const stepY = spanY / (rows - 1);
    const stepMax = Math.max(stepX, stepY);
    const margin = stepMax * 2.5 + maxGapMm / 1000;

    // Two opposing triangles that directly share a vertex or edge (within 0.01 mm,
    // well below MIN_GAP_MM) meet at a concave crease/corner rather than being
    // two separate opposing walls across a print-in-place clearance gap.
    const VERT_WELD_TOL2 = 1e-10; // (1e-5 m)^2 = (0.01 mm)^2
    const trisShareVertex = (offA: number, offB: number): boolean => {
      if (offA < 0 || offB < 0) return false;
      for (let a = 0; a < 9; a += 3) {
        const ax = rotated[offA + a], ay = rotated[offA + a + 1], az = rotated[offA + a + 2];
        for (let b = 0; b < 9; b += 3) {
          const dx = ax - rotated[offB + b];
          const dy = ay - rotated[offB + b + 1];
          const dz = az - rotated[offB + b + 2];
          if (dx * dx + dy * dy + dz * dz <= VERT_WELD_TOL2) return true;
        }
      }
      return false;
    };

    const isOpposingGap = (sA: number, sB: number): boolean => {
      const exNz = spanExNz[sA];
      const enNz = spanEnNz[sB];
      if (exNz < 0.5 || enNz > -0.5) return false;
      const dot = spanExNx[sA] * spanEnNx[sB] + spanExNy[sA] * spanEnNy[sB] + exNz * enNz;
      return dot < -0.5;
    };

    const cellBridgesZ = (pc: number, pr: number, zMid: number): boolean => {
      if (pc < 0 || pr < 0 || pc >= cols || pr >= rows) return false;
      const ni = pr * cols + pc;
      const ns0 = spanStart[ni], ns1 = spanStart[ni + 1];
      for (let k = ns0; k < ns1; k++) {
        if (spanZ0[k] <= zMid && spanZ1[k] >= zMid) return true;
      }
      return false;
    };

    const hasNearbyBridge = (pc: number, pr: number, zMid: number, radius = 1): boolean => {
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          if (dc === 0 && dr === 0) continue;
          if (cellBridgesZ(pc + dc, pr + dr, zMid)) return true;
        }
      }
      return false;
    };

    // Detect sharp acute interior V-creases (e.g., steep gable ridge apex or
    // sculpted organic V-grooves / boot-to-pedestal concave seams) where two
    // non-parallel walls converge to 0 and merge into a solid right next to
    // this cell. Parallel opposing walls have dot ~ -1 and gMag ~ 0.
    const isConvergingCrease = (
      c: number,
      r: number,
      sA: number,
      sB: number,
      g0: number,
      g1: number,
    ): boolean => {
      if (trisShareVertex(spanExTri[sA], spanEnTri[sB])) return true;
      const exNx = spanExNx[sA], exNy = spanExNy[sA], exNz = spanExNz[sA];
      const enNx = spanEnNx[sB], enNy = spanEnNy[sB], enNz = spanEnNz[sB];
      const dot = exNx * enNx + exNy * enNy + exNz * enNz;
      const zMid = (g0 + g1) * 0.5;
      const gapMm = (g1 - g0) * 1000;
      // A sub-0.08 mm crevice directly next to a solid weld on the same body
      // (e.g. a monolithic sculpt boot curving onto its flat pedestal base) is
      // a concave mesh fold, not an intentional print-in-place air gap.
      // Separate bodies have no bridging cells so even 0.03 mm gaps still flag.
      if (gapMm < 0.08 && hasNearbyBridge(c, r, zMid, 3)) return true;
      // Non-parallel opposing faces right beside a solid bridge are a local
      // concave fillet/seam on a monolithic body, not an open air gap.
      if (dot > -0.995 && hasNearbyBridge(c, r, zMid, 1)) return true;
      if (dot <= -0.99999) return false;
      // Gradient of gap(x, y) = zB(x, y) - zA(x, y) in rotated XY.
      const gx = exNx / exNz - enNx / enNz;
      const gy = exNy / exNz - enNy / enNz;
      const gMag = Math.hypot(gx, gy);
      if (gMag <= 0.005) return false;
      const dApex = (g1 - g0) / gMag;
      const maxSearch = stepMax * 4 + (maxGapMm / 1000) * 6;
      if (dApex > maxSearch) return false;
      const dirX = -gx / gMag;
      const dirY = -gy / gMag;
      const probeLimit = dApex + stepMax * 1.25;
      const probeStep = Math.max(Math.min(stepX, stepY) * 0.35, 1e-6);
      let lastC = c, lastR = r;
      for (let d = probeStep; d <= probeLimit; d += probeStep) {
        const pc = Math.round(c + (dirX * d) / stepX);
        const pr = Math.round(r + (dirY * d) / stepY);
        if (pc === lastC && pr === lastR) continue;
        lastC = pc;
        lastR = pr;
        if (cellBridgesZ(pc, pr, zMid)) return true;
        if (Math.abs(d - dApex) <= stepMax && hasNearbyBridge(pc, pr, zMid, 1)) return true;
      }
      return false;
    };

    const neighborHasNarrowGapNear = (nc: number, nr: number, g0: number, g1: number): boolean => {
      const ni = nr * cols + nc;
      const s0 = spanStart[ni], s1 = spanStart[ni + 1];
      for (let s = s0; s + 1 < s1; s++) {
        const ng0 = spanZ1[s], ng1 = spanZ0[s + 1];
        const ngMm = (ng1 - ng0) * 1000;
        if (
          ngMm >= MIN_GAP_MM &&
          ngMm < maxGapMm &&
          ng1 >= g0 - margin &&
          ng0 <= g1 + margin &&
          isOpposingGap(s, s + 1) &&
          !isConvergingCrease(nc, nr, s, s + 1, ng0, ng1)
        ) {
          return true;
        }
      }
      return false;
    };

    let minGapMm = Infinity;
    let at: [number, number, number] | null = null;
    let gapCells = 0;
    let interiorGapCells = 0;
    let borderWorstDot = -1;

    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        const i = r * cols + c;
        const s0 = spanStart[i], s1 = spanStart[i + 1];
        if (s1 - s0 < 2) continue;
        let cellMinMm = Infinity;
        let cellMidZ = 0;
        let cellDot = -1;
        for (let s = s0; s + 1 < s1; s++) {
          const g0 = spanZ1[s], g1 = spanZ0[s + 1];
          const gapMm = (g1 - g0) * 1000;
          if (gapMm < MIN_GAP_MM || gapMm >= maxGapMm) continue;
          if (!isOpposingGap(s, s + 1)) continue;
          if (isConvergingCrease(c, r, s, s + 1, g0, g1)) continue;
          // Require at least one 4-connected neighbour to also see a narrow gap
          // at the same depth so 1-cell grazing edge slivers are ignored.
          const backed =
            neighborHasNarrowGapNear(c - 1, r, g0, g1) ||
            neighborHasNarrowGapNear(c + 1, r, g0, g1) ||
            neighborHasNarrowGapNear(c, r - 1, g0, g1) ||
            neighborHasNarrowGapNear(c, r + 1, g0, g1);
          if (!backed) continue;
          if (gapMm < cellMinMm) {
            cellMinMm = gapMm;
            cellMidZ = (g0 + g1) * 0.5;
            cellDot =
              spanExNx[s] * spanEnNx[s + 1] +
              spanExNy[s] * spanEnNy[s + 1] +
              spanExNz[s] * spanEnNz[s + 1];
          }
        }
        if (cellMinMm < maxGapMm) {
          gapCells++;
          if (hasNearbyBridge(c, r, cellMidZ, 1)) {
            if (cellDot > borderWorstDot) borderWorstDot = cellDot;
          } else {
            interiorGapCells++;
          }
          if (cellMinMm < minGapMm) {
            minGapMm = cellMinMm;
            at = [rb.minX + c * stepX, rb.minY + r * stepY, cellMidZ];
          }
        }
      }
    }

    if (!at || gapCells < 2) continue;
    // When every narrow-gap cell sits directly beside a solid bridge (no open
    // interior channel at all), skip sub-0.08 mm or non-parallel seams (such
    // as a monolithic sculpt boot meeting a flat pedestal base) while still
    // keeping genuine parallel-wall slots.
    if (interiorGapCells === 0 && (borderWorstDot > -0.999 || minGapMm < 0.08)) continue;
    if (best && minGapMm >= best.mm) continue;
    best = { mm: minGapMm, at: unrotateFromZ(at, axis), axis, gapCells };
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

function analyseCnc(
  tris: Float64Array,
  limits: DfmLimits,
  wallTris: Float64Array = tris,
): Omit<DfmReport, 'process' | 'tris' | 'warnings'> {
  const count = Math.floor(tris.length / 9);
  const heat = new Float32Array(count);
  const findings: DfmFinding[] = [];
  const b = bounds(tris);

  const cols = gridFor(b.maxX - b.minX, limits.toolDiaMm);
  const rows = gridFor(b.maxY - b.minY, limits.toolDiaMm);
  if (cols === 0 || rows === 0) {
    return {
      findings,
      heat,
      legend: 'Amber is reachable by flipping or turning onto a side; red is trapped from every face',
      score: 100,
      summary: 'A 3-axis machine can reach all of this from one side.',
    };
  }
  const { top, bottom, thickness, hit } = sampleColumns(tris, b, cols, rows);
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
  const twoSidedGapCell = new Uint8Array(cols * rows);
  for (let i = 0; i < cols * rows; i++) {
    if (!hit[i]) continue;
    const span = top[i] - b.minZ;
    if (!(span > 0)) continue;
    kept += span * cellArea;
    const gap = span - thickness[i];
    if (gap > 1e-6) {
      trapped += gap * cellArea;
      trappedCell[i] = 1;
      if ((top[i] - bottom[i]) - thickness[i] > 1e-6) twoSidedGapCell[i] = 1;
    }
  }
  const trappedShare = kept > 0 ? trapped / kept : 0;

  // When material is hidden from +Z, check which of the other five block faces
  // (-Z underside, ±X, ±Y sides) have a clear line of sight to each hidden
  // triangle so the heatmap and finding distinguish flip-reachable, side-reachable,
  // and truly enclosed undercuts.
  let xCols = 0, xRows = 0, xStepU = 1, xStepV = 1;
  let xBounds = b;
  let xSample: ReturnType<typeof sampleColumns> | null = null;
  let yCols = 0, yRows = 0, yStepU = 1, yStepV = 1;
  let yBounds = b;
  let ySample: ReturnType<typeof sampleColumns> | null = null;
  if (trappedShare > 0) {
    const rotX = rotateAxisToZ(tris, 0); // (x, y, z) -> (y, z, x)
    xBounds = bounds(rotX);
    xCols = gridFor(xBounds.maxX - xBounds.minX, limits.toolDiaMm);
    xRows = gridFor(xBounds.maxY - xBounds.minY, limits.toolDiaMm);
    xStepU = (xBounds.maxX - xBounds.minX) / Math.max(1, xCols - 1) || 1;
    xStepV = (xBounds.maxY - xBounds.minY) / Math.max(1, xRows - 1) || 1;
    xSample = sampleColumns(rotX, xBounds, xCols, xRows);

    const rotY = rotateAxisToZ(tris, 1); // (x, y, z) -> (z, x, y)
    yBounds = bounds(rotY);
    yCols = gridFor(yBounds.maxX - yBounds.minX, limits.toolDiaMm);
    yRows = gridFor(yBounds.maxY - yBounds.minY, limits.toolDiaMm);
    yStepU = (yBounds.maxX - yBounds.minX) / Math.max(1, yCols - 1) || 1;
    yStepV = (yBounds.maxY - yBounds.minY) / Math.max(1, yRows - 1) || 1;
    ySample = sampleColumns(rotY, yBounds, yCols, yRows);
  }

  const sideFacesUsed = new Set<string>();
  let sideReachableTris = 0;
  let trappedAllFacesTris = 0;
  const nudge = Math.max(stepX, stepY, 1e-4) * 0.5;

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

    const tn = triNormal(tris, t);
    const px = tn ? c[0] + tn.n[0] * nudge : c[0];
    const py = tn ? c[1] + tn.n[1] * nudge : c[1];
    const pz = tn ? c[2] + tn.n[2] * nudge : c[2];
    const tol = nudge * 1.5;

    // 1. Reachable from the underside (-Z) if there is no solid below this point in the column.
    if (!twoSidedGapCell[i] || pz <= bottom[i] + tol) {
      heat[t] = 0.6;
      continue;
    }

    // 2. Check side faces (±X, ±Y).
    let sideReached = false;
    if (xSample) {
      const xci = Math.min(xCols - 1, Math.max(0, Math.round((py - xBounds.minX) / xStepU)));
      const xri = Math.min(xRows - 1, Math.max(0, Math.round((pz - xBounds.minY) / xStepV)));
      const xi = xri * xCols + xci;
      if (!xSample.hit[xi] || px >= xSample.top[xi] - tol) {
        sideFacesUsed.add('right (+X)');
        sideReached = true;
      } else if (px <= xSample.bottom[xi] + tol) {
        sideFacesUsed.add('left (-X)');
        sideReached = true;
      }
    }
    if (ySample) {
      const yci = Math.min(yCols - 1, Math.max(0, Math.round((pz - yBounds.minX) / yStepU)));
      const yri = Math.min(yRows - 1, Math.max(0, Math.round((px - yBounds.minY) / yStepV)));
      const yi = yri * yCols + yci;
      if (!ySample.hit[yi] || py >= ySample.top[yi] - tol) {
        sideFacesUsed.add('back (+Y)');
        sideReached = true;
      } else if (py <= ySample.bottom[yi] + tol) {
        sideFacesUsed.add('front (-Y)');
        sideReached = true;
      }
    }

    if (sideReached) {
      heat[t] = 0.8;
      sideReachableTris++;
    } else {
      heat[t] = 1;
      trappedAllFacesTris++;
    }
  }

  if (trappedShare > T.undercutShare) {
    const sideList = [...sideFacesUsed];
    const reachNote =
      trappedAllFacesTris > 0
        ? ` Some volume is enclosed from all six faces.`
        : sideReachableTris > 0
          ? ` Side undercuts are reachable from ${sideList.join(', ')}.`
          : ` Accessible from the underside when flipped.`;
    const fixText =
      trappedAllFacesTris > 0
        ? 'Flip the part or use Solid Machining (Setups: Auto) for outer overhangs, and split internal cavities.'
        : sideReachableTris > 0
          ? `Flip the part or use Solid Machining (Setups: Auto) on ${sideList.join(', ')}.`
          : 'Flip the part for a two-sided setup, or split the body.';
    findings.push({
      id: 'cnc_undercut',
      process: 'cnc',
      severity: trappedShare > T.undercutShareCritical ? 'critical' : 'warning',
      title: `${(trappedShare * 100).toFixed(0)}% is under an overhang`,
      detail: `${(trappedShare * 100).toFixed(0)}% of part volume is occluded from +Z.${reachNote}`,
      fix: fixText,
      position: hotSpot(tris, heat, 0.5) ?? [0, 0, b.maxZ],
      metric: trappedShare,
      actions: [{ kind: 'open_fab', label: 'Solid Machining (Auto Setups)', modal: 'solid' }],
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
      let worstDist = -1;
      let worstC = -1, worstR = -1;
      for (let i = 0; i < cols * rows; i++) {
        if (enclosed[i] && dHolds[i] > r2) {
          stranded++;
          if (dHolds[i] > worstDist) {
            worstDist = dHolds[i];
            worstC = i % cols;
            worstR = (i - worstC) / cols;
          }
        }
      }
      const strandedShare = stranded / pocketCells;

      if (strandedShare > T.strandedShare) {
        const pos: [number, number, number] = worstC >= 0
          ? [b.minX + worstC * stepX, b.minY + worstR * stepY, (b.minZ + b.maxZ) / 2]
          : [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, b.maxZ];
        findings.push({
          id: 'cnc_corner_radius',
          process: 'cnc',
          severity: 'warning',
          title: `Inside corner radius < ${(limits.toolDiaMm / 2).toFixed(1)} mm`,
          detail: `${(strandedShare * 100).toFixed(0)}% of enclosed pocket area is narrower than a ⌀${limits.toolDiaMm} mm end mill.`,
          fix: `Fillet to ≥ R${(limits.toolDiaMm / 2).toFixed(1)} mm, widen slots past ${limits.toolDiaMm} mm, or use a smaller bit.`,
          position: pos,
          metric: strandedShare,
        });
      }
    }
  }

  // Depth. Two-sided flipping up to 2× maxToolReachMm is standard CNC work and
  // does not emit a finding; only warn when no standard bit reaches even flipped.
  const depthMm = (b.maxZ - b.minZ) * 1000;
  if (depthMm > 2 * limits.maxToolReachMm) {
    findings.push({
      id: 'cnc_reach',
      process: 'cnc',
      severity: 'warning',
      title: `${depthMm.toFixed(0)} mm deep — exceeds max tool reach`,
      detail: `Part height is ${depthMm.toFixed(0)} mm (max two-sided standard tool reach ~${(2 * limits.maxToolReachMm).toFixed(0)} mm).`,
      fix: 'Reduce depth or split the part into layers.',
      position: [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, b.minZ],
      metric: depthMm,
    });
  }

  // Thin material, judged by what is being CUT rather than what is printed —
  // a 1.2 mm rib is fine in aluminium and crumbles in MDF.
  const thin = wallTris.length >= 9 ? thinnestWall(wallTris, limits.cncMinWallMm) : null;
  if (thin && thin.mm < limits.cncMinWallMm && thin.share > T.thinCellShare) {
    findings.push({
      id: 'cnc_thin_wall',
      process: 'cnc',
      severity: thin.mm < limits.cncMinWallMm / 2 ? 'critical' : 'warning',
      title: `Wall down to ${thin.mm.toFixed(2)} mm`,
      detail: `Minimum wall is ${thin.mm.toFixed(2)} mm (min ${limits.cncMinWallMm} mm for this material).`,
      fix: `Thicken walls to ≥ ${limits.cncMinWallMm} mm.`,
      position: thin.at,
      metric: thin.mm,
    });
  }

  findings.push(...stockFindings(b, limits));

  const summary = findings.length === 0
    ? 'A 3-axis machine can reach all of this from one side.'
    : trappedShare > T.undercutShare
      ? `${(trappedShare * 100).toFixed(0)}% unreachable from above, ${depthMm.toFixed(0)} mm deep.`
      : primaryFindingSummary(findings);

  return {
    findings,
    heat,
    legend: 'Amber is reachable by flipping or turning onto a side; red is trapped from every face',
    score: scoreOf(findings),
    summary,
  };
}

// ---------------------------------------------------------------------------
// Casting
// ---------------------------------------------------------------------------

function analyseCast(
  tris: Float64Array,
  limits: DfmLimits,
  wallTris: Float64Array = tris,
): Omit<DfmReport, 'process' | 'tris' | 'warnings'> {
  const count = Math.floor(tris.length / 9);
  const heat = new Float32Array(count);
  const findings: DfmFinding[] = [];
  const b = bounds(tris);
  // A flat parting plane at mid-height, pulled along ±Z. castPatternExporter
  // searches for a better one; this is the passive check, so it reports what a
  // reasonable default would do rather than optimising behind the user's back.
  // The parting line goes where a pattern maker would put it: of a spread of
  // heights from the bottom of the part to the top, the one leaving the least
  // undercut, mid-height when that is as good as any. A lid with a knob parts
  // at the step, not across the middle of the knob.
  // A flat face lying ON the parting plane itself (e.g. the flat base of a
  // pattern resting on the parting board at b.minZ) is square to the pull and
  // never overhangs the mould, regardless of which side `c[2] >= z` assigns it.
  const FLAT_PULL_NZ = Math.sin((80 * Math.PI) / 180);
  const isPartingFace = (nz: number, cz: number, z: number): boolean =>
    Math.abs(cz - z) <= 1e-5 && Math.abs(nz) > FLAT_PULL_NZ;

  // On open-top hollow vessels (planters, cups, bowls), a 2-part ±Z clamshell
  // pulls a central core out of the cavity (+Z) while the outer mold half pulls
  // off the exterior (-Z), or vice versa. A face that faces +Z and is
  // unobstructed from +Z (or faces -Z and is unobstructed from -Z) draws cleanly
  // into that mold half rather than locking against a flat mid-height plane.
  const heightM = Math.max(0, b.maxZ - b.minZ);
  const visEps = Math.max(2e-4, heightM * 0.002);
  let probe: ((x: number, y: number) => { top: number; bottom: number } | null) | null = null;
  let colGrid: ReturnType<typeof sampleColumns> | null = null;
  const gridN = 96;
  const spanX = b.maxX - b.minX;
  const spanY = b.maxY - b.minY;
  const effectiveDraftDeg = (nz: number, cx: number, cy: number, cz: number, z: number): number => {
    const deg = draftDeg(nz, cz >= z);
    if (deg >= -UNDERCUT_NOISE_DEG) return deg;
    if (Math.abs(nz) <= 1e-6) return deg;
    let top: number, bottom: number;
    if (count <= 40_000) {
      if (!probe) probe = columnProbe(tris, b);
      const col = probe(cx, cy);
      if (!col) return deg;
      top = col.top;
      bottom = col.bottom;
    } else if (spanX > 1e-9 && spanY > 1e-9) {
      if (!colGrid) colGrid = sampleColumns(tris, b, gridN, gridN);
      const c = Math.max(0, Math.min(gridN - 1, Math.round(((cx - b.minX) / spanX) * (gridN - 1))));
      const r = Math.max(0, Math.min(gridN - 1, Math.round(((cy - b.minY) / spanY) * (gridN - 1))));
      const idx = r * gridN + c;
      if (!colGrid.hit[idx]) return deg;
      top = colGrid.top[idx];
      bottom = colGrid.bottom[idx];
    } else {
      return deg;
    }
    const openUp = nz > 0 && cz >= top - visEps;
    const openDown = nz < 0 && cz <= bottom + visEps;
    if (openUp || openDown) return draftDeg(nz, openUp);
    return deg;
  };

  const undercutAt = (z: number) => {
    let area = 0;
    for (let t = 0; t < count; t++) {
      const tri = triNormal(tris, t);
      if (!tri) continue;
      const c = triCentroid(tris, t);
      if (isPartingFace(tri.n[2], c[2], z)) continue;
      const deg = effectiveDraftDeg(tri.n[2], c[0], c[1], c[2], z);
      if (deg <= 80 && deg < -UNDERCUT_NOISE_DEG) area += tri.area;
    }
    return area;
  };
  const mid = (b.minZ + b.maxZ) / 2;
  let partingZ = mid;
  let leastUndercut = undercutAt(mid);
  for (let k = 0; k <= 10 && leastUndercut > 0; k++) {
    const z = b.minZ + ((b.maxZ - b.minZ) * k) / 10;
    const area = undercutAt(z);
    if (area < leastUndercut - 1e-12) { leastUndercut = area; partingZ = z; }
  }

  let undercutArea = 0, dragArea = 0, totalArea = 0, worstDeg = 0;
  for (let t = 0; t < count; t++) {
    const tri = triNormal(tris, t);
    if (!tri) continue;
    totalArea += tri.area;
    const c = triCentroid(tris, t);
    if (isPartingFace(tri.n[2], c[2], partingZ)) continue;
    const deg = effectiveDraftDeg(tri.n[2], c[0], c[1], c[2], partingZ);
    // A face square to the pull is the top or the bottom of the part; it comes
    // straight off and has nothing to drag against.
    if (deg > 80) continue;
    if (deg < -UNDERCUT_NOISE_DEG) {
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

  // An undercut means the pattern physically does not come out of a rigid draw
  // mould, so the bar is low — though a dissolvable liner, silicone pour box,
  // or lost-PLA burnout releases undercuts cleanly.
  const hasUndercut = undercutShare > T.castUndercutShare;
  if (hasUndercut) {
    findings.push({
      id: 'cast_undercut',
      process: 'cast',
      severity: 'critical',
      title: 'Undercut locks pattern in mould',
      detail: `${(undercutShare * 100).toFixed(0)}% of the surface leans back up to ${worstDeg.toFixed(0)}° along the draw.`,
      fix: limits.castSlip
        ? 'Use a multi-piece Slip Cast Plaster Mold (splits radially around undercuts and adds a base plug for recessed feet).'
        : 'Use a Dissolvable Liner or Silicone Pour Box (for resin, plaster, concrete, or Jesmonite), or split the pattern / use Lost PLA (for metal).',
      position: hotSpot(tris, heat, 0.9) ?? [0, 0, partingZ],
      metric: undercutShare,
      actions: limits.castSlip
        ? [{ kind: 'open_fab', label: 'Slip Cast Mold', modal: 'mold', moldTab: 'slip' }]
        : [
            { kind: 'open_fab', label: 'Silicone Box', modal: 'mold', moldTab: 'silicone' },
            { kind: 'open_fab', label: 'PVA Liner', modal: 'mold', moldTab: 'rigid' },
          ],
    });
  }

  // Draft is a nicety on a shallow part and a real problem on a deep one: drag
  // scales with how far the wall has to slide. So this needs both a lot of the
  // part to be upright AND enough height for it to matter.
  const hasDraft = dragShare > T.dragShare && heightMm > T.dragMinHeightMm;
  if (hasDraft) {
    findings.push({
      id: 'cast_draft',
      process: 'cast',
      severity: 'warning',
      title: `Walls have < ${limits.draftDeg}° draft`,
      detail: `${(dragShare * 100).toFixed(0)}% of the surface has less than ${limits.draftDeg}° draft over ${heightMm.toFixed(0)} mm height.`,
      fix: `Taper walls by ${limits.draftDeg}° (Mold → Draft, or skip draft with a Dissolvable Liner or Silicone Pour Box).`,
      position: hotSpot(tris, heat, 0.05) ?? [0, 0, partingZ],
      metric: dragShare,
      actions: [{ kind: 'open_fab', label: `Add ${limits.draftDeg}° Draft`, modal: 'mold', moldTab: 'rigid' }],
    });
  }

  // Too thin to cast: below what the material fills, or what a printed mold
  // can draw. Spokes and fins a hair wide came out of a mold as nothing.
  const castMatLabel = limits.castMaterialLabel ?? limits.castMaterial ?? 'epoxy';
  const thin = wallTris.length >= 9 ? thinnestWall(wallTris, limits.castMinSectionMm) : null;
  if (thin && thin.mm < limits.castMinSectionMm && thin.share > T.thinCellShare) {
    findings.push({
      id: 'cast_thin_section',
      process: 'cast',
      severity: thin.mm < limits.castMinSectionMm / 2 ? 'critical' : 'warning',
      title: `Sections down to ${thin.mm.toFixed(1)} mm`,
      detail: `The thinnest part is ${thin.mm.toFixed(2)} mm; ${castMatLabel} casting keeps about ${limits.castMinSectionMm} mm here (the material, or a printed mold's ${PRINTED_DETAIL_MM} mm detail).`,
      fix: `Thicken it to ${limits.castMinSectionMm} mm, or cast in a finer material.`,
      position: thin.at,
      metric: thin.mm,
    });
  }

  // Clay slip: an inside corner with no radius is where the wall cracks as it
  // dries and fires, and where a join (a handle on a body) is weakest.
  if (limits.castSlip) {
    const sharp = sharpInsideCorners(tris);
    if (sharp && sharp.length > 0.002) {
      findings.push({
        id: 'cast_sharp_inside_corner',
        process: 'cast',
        severity: 'warning',
        title: 'Sharp inside corners',
        detail: `${(sharp.length * 1000).toFixed(0)} mm of inside corner turns more than ${SHARP_INSIDE_DEG}° with no radius; a slip casting cracks there as it dries and fires, and a join there is its weakest point.`,
        fix: 'Round inside corners to at least the cast wall (about 3 mm), and blend joins such as a handle into the body.',
        position: sharp.at,
        metric: sharp.length,
        actions: [{ kind: 'open_edge_round', label: 'Round edges', radiusMm: 3 }],
      });
    }
  }

  const summaryParts: string[] = [];
  if (hasUndercut) summaryParts.push(`${(undercutShare * 100).toFixed(0)}% undercut`);
  if (hasDraft) summaryParts.push(`${(dragShare * 100).toFixed(0)}% short of draft`);
  const summary = findings.length === 0
    ? `Everything draws cleanly along Z (${castMatLabel}, min wall ${limits.castMinSectionMm} mm).`
    : summaryParts.length > 0
      ? `${summaryParts.join(', ')}.`
      : primaryFindingSummary(findings);

  return {
    findings,
    heat,
    legend: `Red is undercut and will not pull; amber is under ${limits.draftDeg}° of draft`,
    score: scoreOf(findings),
    summary,
  };
}

/** Blunt on purpose: a prompt to look, not a grade. */
function scoreOf(findings: DfmFinding[]): number {
  let score = 100;
  for (const f of findings) {
    if (f.passed) continue;
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
/** The world matrix of the body a node hangs under, or undefined at the top. */
function parentMatrixOf(nodes: SceneNode[], id: string, parent?: THREE.Matrix4): THREE.Matrix4 | undefined | null {
  for (const n of nodes) {
    if (n.id === id) return parent;
    const found = parentMatrixOf(n.children || [], id, getNodeWorldTransform(n, parent));
    if (found !== null) return found;
  }
  return null;
}

/** Past this many triangles, faces buried between a part's own shapes are not looked for. */
const MAX_BURIED_CHECK = 40_000;

interface FlatTriBvh {
  minX: Float64Array;
  minY: Float64Array;
  minZ: Float64Array;
  maxX: Float64Array;
  maxY: Float64Array;
  maxZ: Float64Array;
  /** Left child index (>= 0) for internal nodes, or -(start + 1) for leaves. */
  left: Int32Array;
  /** Right child index for internal nodes, or count for leaves. */
  right: Int32Array;
  order: Int32Array;
  nodeCount: number;
}

function buildFlatTriBvh(tris: Float64Array, count: number): FlatTriBvh {
  const order = new Int32Array(count);
  const tMinX = new Float64Array(count), tMinY = new Float64Array(count), tMinZ = new Float64Array(count);
  const tMaxX = new Float64Array(count), tMaxY = new Float64Array(count), tMaxZ = new Float64Array(count);
  const cx = new Float64Array(count), cy = new Float64Array(count), cz = new Float64Array(count);

  for (let t = 0; t < count; t++) {
    order[t] = t;
    const i = t * 9;
    const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
    const bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5];
    const dx = tris[i + 6], dy = tris[i + 7], dz = tris[i + 8];
    tMinX[t] = Math.min(ax, bx, dx); tMaxX[t] = Math.max(ax, bx, dx);
    tMinY[t] = Math.min(ay, by, dy); tMaxY[t] = Math.max(ay, by, dy);
    tMinZ[t] = Math.min(az, bz, dz); tMaxZ[t] = Math.max(az, bz, dz);
    cx[t] = (ax + bx + dx) / 3;
    cy[t] = (ay + by + dy) / 3;
    cz[t] = (az + bz + dz) / 3;
  }

  const maxNodes = Math.max(1, count * 2);
  const minX = new Float64Array(maxNodes), minY = new Float64Array(maxNodes), minZ = new Float64Array(maxNodes);
  const maxX = new Float64Array(maxNodes), maxY = new Float64Array(maxNodes), maxZ = new Float64Array(maxNodes);
  const left = new Int32Array(maxNodes);
  const right = new Int32Array(maxNodes);
  let nodeCount = 0;

  const build = (start: number, end: number): number => {
    const idx = nodeCount++;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity;
    let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity;
    let cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
    for (let k = start; k < end; k++) {
      const t = order[k];
      if (tMinX[t] < x0) x0 = tMinX[t]; if (tMaxX[t] > x1) x1 = tMaxX[t];
      if (tMinY[t] < y0) y0 = tMinY[t]; if (tMaxY[t] > y1) y1 = tMaxY[t];
      if (tMinZ[t] < z0) z0 = tMinZ[t]; if (tMaxZ[t] > z1) z1 = tMaxZ[t];
      if (cx[t] < cx0) cx0 = cx[t]; if (cx[t] > cx1) cx1 = cx[t];
      if (cy[t] < cy0) cy0 = cy[t]; if (cy[t] > cy1) cy1 = cy[t];
      if (cz[t] < cz0) cz0 = cz[t]; if (cz[t] > cz1) cz1 = cz[t];
    }
    minX[idx] = x0; minY[idx] = y0; minZ[idx] = z0;
    maxX[idx] = x1; maxY[idx] = y1; maxZ[idx] = z1;

    const len = end - start;
    if (len <= 8) {
      left[idx] = -(start + 1);
      right[idx] = len;
      return idx;
    }
    const sx = cx1 - cx0, sy = cy1 - cy0, sz = cz1 - cz0;
    const cArr = sx >= sy && sx >= sz ? cx : sy >= sz ? cy : cz;
    const midVal = sx >= sy && sx >= sz ? (cx0 + cx1) * 0.5 : sy >= sz ? (cy0 + cy1) * 0.5 : (cz0 + cz1) * 0.5;
    let lo = start, hi = end - 1;
    while (lo <= hi) {
      if (cArr[order[lo]] < midVal) lo++;
      else {
        const tmp = order[lo];
        order[lo] = order[hi];
        order[hi] = tmp;
        hi--;
      }
    }
    let split = lo;
    if (split === start || split === end) split = (start + end) >> 1;
    left[idx] = build(start, split);
    right[idx] = build(split, end);
    return idx;
  };

  if (count > 0) build(0, count);
  return { minX, minY, minZ, maxX, maxY, maxZ, left, right, order, nodeCount };
}

/**
 * A part's triangles less those that lie buried inside another of its own
 * shapes — the underside of a knob sitting flush on a lid, a gusset sunk into
 * an arm. Two shapes of one body are one solid once made, so buried interior
 * faces should not trigger overhang/undercut findings.
 *
 * Uses a flat AABB-BVH + per-solid AABB pre-filter with zero inner allocations,
 * and checks whether `c + eps * n` (`eps = 0.01 mm`) actually lies INSIDE
 * another solid (nearest forward ray hit on that solid is an EXITING face with
 * `dot(d, otherOutwardNormal) > 0`), so opposing exterior faces separated by a
 * real `0.05–0.3 mm` air gap are never deleted.
 */
export function outsideFaces(tris: Float64Array, solids: Int32Array): { tris: Float64Array; index: number[] } {
  const count = Math.floor(tris.length / 9);
  const all = Array.from({ length: count }, (_, t) => t);
  if (count === 0 || count > MAX_BURIED_CHECK) return { tris, index: all };

  // Map distinct solid ids to dense 0..S-1 indices and compute per-solid AABBs.
  const solidIdToIdx = new Map<number, number>();
  const solidIdxOfTri = new Int32Array(count);
  for (let t = 0; t < count; t++) {
    const sid = solids[t];
    let idx = solidIdToIdx.get(sid);
    if (idx === undefined) {
      idx = solidIdToIdx.size;
      solidIdToIdx.set(sid, idx);
    }
    solidIdxOfTri[t] = idx;
  }
  const numSolids = solidIdToIdx.size;
  if (numSolids < 2) return { tris, index: all };

  const sMinX = new Float64Array(numSolids).fill(Infinity);
  const sMinY = new Float64Array(numSolids).fill(Infinity);
  const sMinZ = new Float64Array(numSolids).fill(Infinity);
  const sMaxX = new Float64Array(numSolids).fill(-Infinity);
  const sMaxY = new Float64Array(numSolids).fill(-Infinity);
  const sMaxZ = new Float64Array(numSolids).fill(-Infinity);
  for (let t = 0; t < count; t++) {
    const s = solidIdxOfTri[t];
    const i = t * 9;
    for (let v = 0; v < 9; v += 3) {
      const x = tris[i + v], y = tris[i + v + 1], z = tris[i + v + 2];
      if (x < sMinX[s]) sMinX[s] = x; if (x > sMaxX[s]) sMaxX[s] = x;
      if (y < sMinY[s]) sMinY[s] = y; if (y > sMaxY[s]) sMaxY[s] = y;
      if (z < sMinZ[s]) sMinZ[s] = z; if (z > sMaxZ[s]) sMaxZ[s] = z;
    }
  }

  const bvh = buildFlatTriBvh(tris, count);
  const EPS = 1e-5; // 0.01 mm: inside touching/overlapping solids, strictly inside >= 0.05 mm air gaps
  const keep: number[] = [];
  const stack = new Int32Array(64);
  const candFlag = new Uint8Array(numSolids);
  const bestDist = new Float64Array(numSolids);
  const bestDot = new Float64Array(numSolids);
  const candList = new Int32Array(numSolids);

  for (let t = 0; t < count; t++) {
    const tri = triNormal(tris, t);
    if (!tri) { keep.push(t); continue; }
    const c = triCentroid(tris, t);
    const dx = tri.n[0], dy = tri.n[1], dz = tri.n[2];
    const ox = c[0] + dx * EPS;
    const oy = c[1] + dy * EPS;
    const oz = c[2] + dz * EPS;
    const mySolid = solidIdxOfTri[t];

    // Pre-filter: only solids whose AABB contains P can contain P.
    let candCount = 0;
    for (let s = 0; s < numSolids; s++) {
      if (s === mySolid) { candFlag[s] = 0; continue; }
      if (ox >= sMinX[s] && ox <= sMaxX[s] && oy >= sMinY[s] && oy <= sMaxY[s] && oz >= sMinZ[s] && oz <= sMaxZ[s]) {
        candFlag[s] = 1;
        bestDist[s] = Infinity;
        bestDot[s] = 0;
        candList[candCount++] = s;
      } else {
        candFlag[s] = 0;
      }
    }
    if (candCount === 0) {
      keep.push(t);
      continue;
    }

    const invX = Math.abs(dx) > 1e-18 ? 1 / dx : (dx >= 0 ? 1e18 : -1e18);
    const invY = Math.abs(dy) > 1e-18 ? 1 / dy : (dy >= 0 ? 1e18 : -1e18);
    const invZ = Math.abs(dz) > 1e-18 ? 1 / dz : (dz >= 0 ? 1e18 : -1e18);

    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const ni = stack[--sp];
      // Ray-AABB slab test for dist >= 0
      const tx1 = (bvh.minX[ni] - ox) * invX, tx2 = (bvh.maxX[ni] - ox) * invX;
      let tmin = tx1 < tx2 ? tx1 : tx2;
      let tmax = tx1 > tx2 ? tx1 : tx2;
      const ty1 = (bvh.minY[ni] - oy) * invY, ty2 = (bvh.maxY[ni] - oy) * invY;
      const tminY = ty1 < ty2 ? ty1 : ty2, tmaxY = ty1 > ty2 ? ty1 : ty2;
      if (tminY > tmin) tmin = tminY;
      if (tmaxY < tmax) tmax = tmaxY;
      const tz1 = (bvh.minZ[ni] - oz) * invZ, tz2 = (bvh.maxZ[ni] - oz) * invZ;
      const tminZ = tz1 < tz2 ? tz1 : tz2, tmaxZ = tz1 > tz2 ? tz1 : tz2;
      if (tminZ > tmin) tmin = tminZ;
      if (tmaxZ < tmax) tmax = tmaxZ;
      if (tmax < 0 || tmin > tmax) continue;

      const l = bvh.left[ni];
      if (l < 0) {
        const start = -(l + 1);
        const end = start + bvh.right[ni];
        for (let k = start; k < end; k++) {
          const u = bvh.order[k];
          const su = solidIdxOfTri[u];
          if (!candFlag[su]) continue;
          const i = u * 9;
          const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
          const e1x = tris[i + 3] - ax, e1y = tris[i + 4] - ay, e1z = tris[i + 5] - az;
          const e2x = tris[i + 6] - ax, e2y = tris[i + 7] - ay, e2z = tris[i + 8] - az;
          // p = d × e2
          const px = dy * e2z - dz * e2y;
          const py = dz * e2x - dx * e2z;
          const pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (Math.abs(det) < 1e-18) continue;
          const inv = 1 / det;
          const sx = ox - ax, sy = oy - ay, sz = oz - az;
          const bu = (sx * px + sy * py + sz * pz) * inv;
          if (bu < -1e-9 || bu > 1 + 1e-9) continue;
          // q = s × e1
          const qx = sy * e1z - sz * e1y;
          const qy = sz * e1x - sx * e1z;
          const qz = sx * e1y - sy * e1x;
          const bv = (dx * qx + dy * qy + dz * qz) * inv;
          if (bv < -1e-9 || bu + bv > 1 + 1e-9) continue;
          const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (dist > 0 && dist < bestDist[su]) {
            bestDist[su] = dist;
            // (e1 × e2) · d = -det (Wait: (e1 × e2) · d = e1 · (e2 × d) = -e1 · (d × e2) = -det!)
            bestDot[su] = -det;
          }
        }
      } else {
        stack[sp++] = l;
        stack[sp++] = bvh.right[ni];
      }
    }

    let buried = false;
    for (let k = 0; k < candCount; k++) {
      const s = candList[k];
      // Nearest forward hit on candidate solid `s` is an exiting face -> P lies inside solid `s`.
      if (bestDist[s] < Infinity && bestDot[s] > 0) {
        buried = true;
        break;
      }
    }
    if (!buried) keep.push(t);
  }

  if (keep.length === count) return { tris, index: all };
  const out = new Float64Array(keep.length * 9);
  keep.forEach((t, k) => out.set(tris.subarray(t * 9, t * 9 + 9), k * 9));
  return { tris: out, index: keep };
}

/** A wall leaning back by less than this is upright: rounding, not an undercut. */
const UNDERCUT_NOISE_DEG = 0.01;

/** The six ways up a part can be laid on a bed or clamped: which of its own axes points up. */
const SIDES: { up: [number, number, number]; text: string }[] = [
  { up: [0, 0, 1], text: '' },
  { up: [0, 0, -1], text: 'upside down' },
  { up: [1, 0, 0], text: 'on its side, +X up' },
  { up: [-1, 0, 0], text: 'on its side, −X up' },
  { up: [0, 1, 0], text: 'on its side, +Y up' },
  { up: [0, -1, 0], text: 'on its side, −Y up' },
];
/** Past this many triangles a part is judged only as it is placed: six passes would hold the panel up. */
const MAX_TURNED_TRIANGLES = 50_000;

type Analysis = Omit<DfmReport, 'process' | 'tris' | 'warnings'>;

function transposeMat3(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

function applyMat3Vec(m: Mat3, p: [number, number, number]): [number, number, number] {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2],
    m[3] * p[0] + m[4] * p[1] + m[5] * p[2],
    m[6] * p[0] + m[7] * p[1] + m[8] * p[2],
  ];
}

const PRINT_ORIENTATION_IDS = new Set(['print_overhang', 'print_no_bridge', 'print_exceeds_bed', 'sla_trapped_cup']);

/**
 * Evaluates a single part without silently painting phantom rotated heat onto
 * unrotated viewport triangles.
 *
 * - For 3D printing without `node.printPose`: evaluates `placed` (matching the
 *   viewport mesh and heatmap) and, if turning the part improves the score,
 *   attaches a 1-click `apply_print_pose` action chip rather than silently
 *   overwriting the viewport heatmap with a hidden rotated orientation.
 * - For CNC / Casting: searches the six orientations when placed has findings,
 *   zeroing out heat when a cleaner turn eliminates all findings (so unrotated
 *   faces never glow red when `findings.length === 0`).
 */
function analyseBestSide(
  tris: Float64Array,
  wallTris: Float64Array,
  process: DfmProcess,
  lim: DfmLimits,
  nodeId: string,
  gapTris: Float64Array = wallTris,
): Analysis & { side: string } {
  const run = (t: Float64Array, wt: Float64Array, gt: Float64Array) => (
    process === 'print' ? analysePrint(t, lim, wt, false, gt)
      : process === 'cnc' ? analyseCnc(t, lim, wt)
        : analyseCast(t, lim, wt)
  );
  const placed = run(tris, wallTris, gapTris);
  if (tris.length / 9 > MAX_TURNED_TRIANGLES || placed.findings.length === 0) return { ...placed, side: '' };

  const b = bounds(tris);
  const c = new THREE.Vector3((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
  const badness = (a: Analysis) => 100 - a.score;
  const sameWalls = wallTris === tris;
  const sameGap = gapTris === wallTris;

  const rotateSoupAroundCenter = (src: Float64Array, q: THREE.Quaternion): Float64Array => {
    const v = new THREE.Vector3();
    const turned = new Float64Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      v.set(src[i] - c.x, src[i + 1] - c.y, src[i + 2] - c.z).applyQuaternion(q);
      turned[i] = v.x + c.x; turned[i + 1] = v.y + c.y; turned[i + 2] = v.z + c.z;
    }
    return turned;
  };

  let bestTurn: { analysis: Analysis; side: { up: [number, number, number]; text: string }; q: THREE.Quaternion } | null = null;
  let bestBadness = badness(placed);

  for (const side of SIDES.slice(1)) {
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(...side.up), new THREE.Vector3(0, 0, 1));
    const turned = rotateSoupAroundCenter(tris, q);
    const turnedWalls = sameWalls ? turned : rotateSoupAroundCenter(wallTris, q);
    const turnedGaps = sameGap ? turnedWalls : gapTris === tris ? turned : rotateSoupAroundCenter(gapTris, q);
    const a = run(turned, turnedWalls, turnedGaps);
    const scoreBad = badness(a);
    if (scoreBad >= bestBadness) continue;
    bestBadness = scoreBad;
    bestTurn = { analysis: a, side, q };
  }

  if (!bestTurn) return { ...placed, side: '' };

  if (process === 'print') {
    // Keep `placed` findings AND `placed` heat so the viewport heatmap matches
    // the visible geometry, and attach a 1-click `apply_print_pose` action!
    const poseAction: DfmAction = {
      kind: 'apply_print_pose',
      label: `Lay ${bestTurn.side.text}`,
      nodeId,
      up: bestTurn.side.up,
      spin: 0,
    };
    const findings = placed.findings.map((f) => {
      if (!PRINT_ORIENTATION_IDS.has(f.id)) return f;
      const existing = f.actions ?? [];
      const hasPose = existing.some((a) => a.kind === 'apply_print_pose');
      return {
        ...f,
        actions: hasPose ? existing : [poseAction, ...existing],
      };
    });
    return { ...placed, findings, side: '' };
  }

  // CNC / Casting: use the better setup's findings (positions mapped back to
  // body space), and never paint rotated heat when the turn clears all issues.
  const back = bestTurn.q.clone().invert();
  const findings = bestTurn.analysis.findings.map((f) => {
    const p = new THREE.Vector3(...f.position).sub(c).applyQuaternion(back).add(c);
    return { ...f, position: [p.x, p.y, p.z] as [number, number, number] };
  });
  const heat = findings.length === 0 ? new Float32Array(placed.heat.length) : placed.heat;
  return { ...bestTurn.analysis, findings, heat, side: bestTurn.side.text };
}

/** Populate `nodeId` on any finding action that references the current part. */
function attachNodeToActions(actions: DfmAction[] | undefined, nodeId: string): DfmAction[] | undefined {
  if (!actions || actions.length === 0) return undefined;
  return actions.map((a) => {
    if (a.kind === 'open_split' && !a.nodeId) return { ...a, nodeId };
    if (a.kind === 'open_edge_round' && !a.nodeId) return { ...a, nodeId };
    if (a.kind === 'apply_print_pose' && !a.nodeId) return { ...a, nodeId };
    return a;
  });
}

/**
 * The scene judged part by part, each the way up that suits the process.
 *
 * Every body at the top of the tree is a part — with whatever is fixed under
 * it, and less any bought hardware — because each is made on its own: a
 * chassis over its wheels is not an overhang, and a cabinet's drawers are not
 * a pocket in it. With `asPlaced`, the whole scene is judged as one solid,
 * exactly as it stands, which is what the earlier checks did and what a test
 * of the geometry itself wants.
 */
export function analyseDfm(
  scene: SceneGraph,
  process: DfmProcess,
  bench: Partial<DfmBench & DfmLimits> & { asPlaced?: boolean } = {},
  wholeScene?: SceneGraph,
): DfmReport {
  if (bench.asPlaced) return analyseDfmAsPlaced(scene, process, bench, wholeScene);
  const contextScene = wholeScene ?? scene;
  const resolvedCast = resolveDfmCastMaterial(bench.castMaterial);
  const lim: DfmLimits = {
    ...dfmLimitsFor({
      material: bench.material ?? DEFAULT_MATERIAL,
      filament: bench.filament ?? DEFAULT_FILAMENT,
      stock: bench.stock ?? null,
      printBed: bench.printBed ?? null,
      bed_mm: bench.bed_mm ?? null,
      printer: bench.printer ?? null,
      castMaterial: bench.castMaterial,
    }),
    ...Object.fromEntries(Object.entries(bench).filter(([k]) => k in DFM_DEFAULTS && k !== 'castMaterial')),
  };
  const resolvedMinWallMm = process === 'cast' ? lim.castMinSectionMm : process === 'cnc' ? lim.cncMinWallMm : lim.minWallMm;
  const target = bench.nodeId ? findNode(scene.nodes || [], bench.nodeId) : null;
  const scopeNodeId = target ? target.id : null;
  // Said as the walk goes, not by sampling the whole scene a second time for
  // its warnings alone.
  const warnings: string[] = [];
  if (process === 'cast' && resolvedCast.fallbackFrom) {
    warnings.push(`Unknown cast material "${resolvedCast.fallbackFrom}"; falling back to ${resolvedCast.id} (min wall ${lim.castMinSectionMm} mm).`);
  }
  const skipped: string[] = [];

  // Each body is a part, judged in its own frame — a board modelled tilted
  // is still a board — and put back where it stands for the overlay.
  const bodies: {
    node: SceneNode;
    local: Float64Array;
    solids: Int32Array;
    flexureTri: Uint8Array;
    gapSkipTri: Uint8Array;
    world: THREE.Matrix4;
  }[] = [];
  const walk = (nodes: SceneNode[], parent?: THREE.Matrix4) => {
    for (const n of nodes) {
      const world = getNodeWorldTransform(n, parent);
      if (n.simulation) warnings.push(`${n.name}: a simulated cut, so it is left out.`);
      if (!isBoughtIn(n) && !n.simulation) {
        const uncompiled = uncompiledCsgWarning(n);
        if (uncompiled) warnings.push(uncompiled);
        const out: number[] = [];
        const solids: number[] = [];
        const flexFlags: number[] = [];
        const gapSkipFlags: number[] = [];
        let solid = 0;
        for (const g of resolveCsgGeoms(n, 'render')) {
          if (g.role === 'collision') continue;
          const before = out.length;
          if (!appendSolidTriangles(g, new THREE.Matrix4(), out)) {
            skipped.push(`${n.name} (${g.name || g.type})`);
            continue;
          }
          const isFlexureLeaf = Boolean(g.bend || g.name?.startsWith('flexure_') || (n.flexure && g.role === 'visual'));
          // Visual-only flexure leaf geoms intentionally fuse monolithically into their parent body.
          const isGapIgnored = Boolean(g.bend || g.name?.startsWith('flexure_') || (g.role === 'visual' && !g.csgDerived));
          for (let i = before; i < out.length; i += 9) {
            solids.push(solid);
            flexFlags.push(isFlexureLeaf ? 1 : 0);
            gapSkipFlags.push(isGapIgnored ? 1 : 0);
          }
          solid++;
        }
        if (out.length >= 9) {
          bodies.push({
            node: n,
            local: Float64Array.from(out),
            solids: Int32Array.from(solids),
            flexureTri: Uint8Array.from(flexFlags),
            gapSkipTri: Uint8Array.from(gapSkipFlags),
            world,
          });
        }
      }
      walk(n.children || [], world);
    }
  };
  const targetParent = target ? (parentMatrixOf(scene.nodes || [], target.id) ?? undefined) : undefined;
  walk(target ? [target] : (scene.nodes || []), targetParent);
  if (skipped.length) warnings.push(`Not analysed: ${skipped.join(', ')}.`);

  // Gate whole-scene multi-body avalanche when no part is selected (unless caller
  // explicitly asked for checkAllAsPlate: true). Cross-part assembly checks still run.
  if (!target && bodies.length > 1 && !bench.checkAllAsPlate) {
    const findings = hardwareFindings(scene, process, contextScene, undefined, null);
    const open = findings.filter((f) => !f.passed);
    const procName = process === 'print' ? '3D printing' : process === 'cnc' ? 'CNC' : 'casting';
    return {
      process,
      tris: new Float64Array(0),
      heat: new Float32Array(0),
      warnings,
      findings,
      legend: '',
      score: scoreOf(findings),
      summary: open.length === 0
        ? `Select a part to check ${procName} (${bodies.length} parts in scene).`
        : `${open.length} assembly issue${open.length === 1 ? '' : 's'}; select a part for fabrication checks.`,
      needsPartSelection: { bodyCount: bodies.length },
      nodeId: null,
    };
  }

  const allTris: number[] = [];
  const assemblyGapTris: number[] = [];
  const allHeat: number[] = [];
  const findings: DfmFinding[] = [];
  let legend = '';
  let summaries: string[] = [];
  let judgedPoseLabel: string | undefined;
  const named = bodies.length > 1;
  for (const { node, local, solids, flexureTri, gapSkipTri, world } of bodies) {
    // Faces where one of the part's shapes sits on another are inside the
    // part, not on it: judged without them, and given no heat.
    const kept = outsideFaces(local, solids);

    // Exclude intentional compliant flexure leaves from thin-wall false positives.
    let hasFlex = false;
    let hasGapSkip = false;
    for (let k = 0; k < kept.index.length; k++) {
      if (flexureTri[kept.index[k]]) hasFlex = true;
      if (gapSkipTri[kept.index[k]]) hasGapSkip = true;
      if (hasFlex && hasGapSkip) break;
    }
    let wallTris = kept.tris;
    if (hasFlex) {
      const keepWall: number[] = [];
      for (let k = 0; k < kept.index.length; k++) {
        if (!flexureTri[kept.index[k]]) keepWall.push(k);
      }
      const wt = new Float64Array(keepWall.length * 9);
      keepWall.forEach((k, idx) => wt.set(kept.tris.subarray(k * 9, k * 9 + 9), idx * 9));
      wallTris = wt;
    }
    let gapTris = kept.tris;
    if (hasGapSkip) {
      const keepGap: number[] = [];
      for (let k = 0; k < kept.index.length; k++) {
        if (!gapSkipTri[kept.index[k]]) keepGap.push(k);
      }
      const gt = new Float64Array(keepGap.length * 9);
      keepGap.forEach((k, idx) => gt.set(kept.tris.subarray(k * 9, k * 9 + 9), idx * 9));
      gapTris = gt;
    }

    let a: Analysis & { side: string };
    if (process === 'print' && node.printPose) {
      // Evaluate overhang, bed fit (including cutFor?.bedMm and oblique/diagonal
      // footprint), and heatmap directly in the body's explicit `node.printPose`.
      const m = poseMatrix(node.printPose);
      const mInv = transposeMat3(m);
      const posedTris = rotatePoints(m, kept.tris);
      const posedWallTris = wallTris === kept.tris ? posedTris : rotatePoints(m, wallTris);
      const posedGapTris = gapTris === kept.tris ? posedTris : gapTris === wallTris ? posedWallTris : rotatePoints(m, gapTris);
      const cutBed = node.printPose.cutFor?.bedMm;
      const bodyLim: DfmLimits = !lim.bedMm && cutBed
        ? { ...lim, bedMm: { widthMm: cutBed[0], depthMm: cutBed[1], heightMm: cutBed[2] } }
        : lim;
      const posed = analysePrint(posedTris, bodyLim, posedWallTris, true, posedGapTris);
      posed.findings = posed.findings.map((f) => ({
        ...f,
        position: applyMat3Vec(mInv, f.position),
      }));
      a = { ...posed, side: '' };
      judgedPoseLabel = 'print pose';
    } else {
      a = analyseBestSide(kept.tris, wallTris, process, lim, node.id, gapTris);
      if (a.side) judgedPoseLabel = a.side;
    }

    const heat = new Float32Array(local.length / 9);
    kept.index.forEach((t, k) => { heat[t] = a.heat[k]; });
    a.heat = heat;
    const v = new THREE.Vector3();
    for (let i = 0; i < local.length; i += 3) {
      v.set(local[i], local[i + 1], local[i + 2]).applyMatrix4(world);
      allTris.push(v.x, v.y, v.z);
    }
    if (process === 'print' && gapTris.length >= 9) {
      for (let i = 0; i < gapTris.length; i += 3) {
        v.set(gapTris[i], gapTris[i + 1], gapTris[i + 2]).applyMatrix4(world);
        assemblyGapTris.push(v.x, v.y, v.z);
      }
    }
    for (const h of a.heat) allHeat.push(h);
    legend = a.legend;
    summaries.push(a.summary);
    for (const f of a.findings) {
      const p = new THREE.Vector3(...f.position).applyMatrix4(world);
      const actions = attachNodeToActions(f.actions, node.id);
      findings.push({
        ...f,
        id: named ? `${node.id}:${f.id}` : f.id,
        nodeId: node.id,
        title: named ? `${node.name}: ${f.title}` : f.title,
        detail: a.side ? `${f.detail} Judged ${a.side}, the best way up for it.` : f.detail,
        position: [p.x, p.y, p.z],
        ...(actions ? { actions } : {}),
      });
    }
  }
  const parts = bodies.length;
  // Assembly checks (seals, screws, runners, insert bosses), scoped to the
  // selected body and its mating parts when `nodeId` is specified.
  findings.push(...hardwareFindings(scene, process, contextScene, undefined, scopeNodeId));

  const tris = Float64Array.from(allTris);
  if (parts === 0) {
    return {
      process, tris, warnings, findings, heat: new Float32Array(0), legend: '',
      score: scoreOf(findings), summary: 'Nothing in the scene to analyse.', nodeId: scopeNodeId,
      minWallMm: resolvedMinWallMm,
      ...(process === 'cast' && lim.castMaterial ? { castMaterial: lim.castMaterial } : {}),
    };
  }
  // Multi-body print-in-place assembly air-gap check across all parts in world space
  // (skipping visual-only flexure leaf geoms that fuse monolithically into their parent).
  const assemblyGapSoup = Float64Array.from(assemblyGapTris);
  if (process === 'print' && parts > 1 && assemblyGapSoup.length >= 9 && assemblyGapSoup.length / 9 <= MAX_BURIED_CHECK) {
    const assemblyGap = narrowestAirGap(assemblyGapSoup, PRINT_MIN_AIR_GAP_MM);
    if (assemblyGap) {
      const existingTightest = findings
        .filter((f) => f.id === 'print_narrow_gap' || f.id.endsWith(':print_narrow_gap'))
        .reduce((min, f) => Math.min(min, f.metric ?? Infinity), Infinity);
      if (assemblyGap.mm < existingTightest - 0.01) {
        findings.push({
          id: 'print_narrow_gap',
          process: 'print',
          severity: assemblyGap.mm < 0.2 ? 'critical' : 'warning',
          title: `Narrow air gap (${assemblyGap.mm.toFixed(2)} mm) risks fusion`,
          detail: `Opposing walls between print-in-place parts are separated by ${assemblyGap.mm.toFixed(2)} mm (minimum ${PRINT_MIN_AIR_GAP_MM} mm recommended to avoid fusing).`,
          fix: `Increase print-in-place air-gap clearance between opposing walls to at least ${PRINT_MIN_AIR_GAP_MM} mm (0.4 mm recommended for FDM).`,
          position: assemblyGap.at,
          metric: assemblyGap.mm,
          assembly: true,
        });
      }
    }
  }
  const open = findings.filter((f) => !f.passed);
  if (parts > 1) summaries = [open.length === 0 ? `All ${parts} parts come out clean.` : `${open.length} to look at across ${parts} parts.`];
  return {
    process, tris, warnings, findings,
    heat: Float32Array.from(allHeat), legend, score: scoreOf(findings), summary: summaries[0] ?? '',
    ...(judgedPoseLabel ? { judgedPoseLabel } : {}),
    nodeId: scopeNodeId,
    minWallMm: resolvedMinWallMm,
    ...(process === 'cast' && lim.castMaterial ? { castMaterial: lim.castMaterial } : {}),
  };
}

/** The whole scene as one solid, as it stands: see `asPlaced` on analyseDfm. */
function analyseDfmAsPlaced(
  scene: SceneGraph,
  process: DfmProcess,
  bench: Partial<DfmBench & DfmLimits> = {},
  wholeScene?: SceneGraph,
): DfmReport {
  const contextScene = wholeScene ?? scene;
  // The bench first — what is clamped down and what is loaded — then any
  // explicit override on top, so a caller can pin one number without having to
  // restate the material it came with.
  const resolvedCast = resolveDfmCastMaterial(bench.castMaterial);
  const lim: DfmLimits = {
    ...dfmLimitsFor({
      material: bench.material ?? DEFAULT_MATERIAL,
      filament: bench.filament ?? DEFAULT_FILAMENT,
      stock: bench.stock ?? null,
      printBed: bench.printBed ?? null,
      bed_mm: bench.bed_mm ?? null,
      printer: bench.printer ?? null,
      castMaterial: bench.castMaterial,
    }),
    ...Object.fromEntries(Object.entries(bench).filter(([k]) => k in DFM_DEFAULTS && k !== 'castMaterial')),
  };
  const resolvedMinWallMm = process === 'cast' ? lim.castMinSectionMm : process === 'cnc' ? lim.cncMinWallMm : lim.minWallMm;
  const target = bench.nodeId ? findNode(scene.nodes || [], bench.nodeId) : null;
  const scopeNodeId = target ? target.id : null;
  const collected = collectSceneTriangles(target ? { ...scene, nodes: [target] } : scene);
  const tris = Float64Array.from(collected.tris);
  const warnings = [...collected.warnings];
  if (process === 'cast' && resolvedCast.fallbackFrom) {
    warnings.push(`Unknown cast material "${resolvedCast.fallbackFrom}"; falling back to ${resolvedCast.id} (min wall ${lim.castMinSectionMm} mm).`);
  }
  if (collected.skipped.length) {
    warnings.push(`Not analysed: ${collected.skipped.join(', ')}.`);
  }

  if (tris.length < 9) {
    return {
      process, tris, warnings,
      findings: [], heat: new Float32Array(0),
      legend: '', score: 100,
      summary: 'Nothing in the scene to analyse.',
      nodeId: scopeNodeId,
      minWallMm: resolvedMinWallMm,
      ...(process === 'cast' && lim.castMaterial ? { castMaterial: lim.castMaterial } : {}),
    };
  }

  const body = process === 'print' ? analysePrint(tris, lim)
    : process === 'cnc' ? analyseCnc(tris, lim)
      : analyseCast(tris, lim);
  if (scopeNodeId) {
    body.findings = body.findings.map((f) => ({
      ...f,
      nodeId: f.nodeId ?? scopeNodeId,
      ...(f.actions ? { actions: attachNodeToActions(f.actions, scopeNodeId) } : {}),
    }));
  }
  // Seals, screws, runners, and insert bosses are judged the same whatever makes the part.
  const hardware = hardwareFindings(target ? { ...scene, nodes: [target] } : scene, process, contextScene, undefined, scopeNodeId);
  if (hardware.length) {
    body.findings = [...body.findings, ...hardware];
    body.score = scoreOf(body.findings);
  }

  return {
    process, tris, warnings, ...body, nodeId: scopeNodeId,
    minWallMm: resolvedMinWallMm,
    ...(process === 'cast' && lim.castMaterial ? { castMaterial: lim.castMaterial } : {}),
  };
}

/**
 * The report with its assembly findings measured where the bodies are now
 * rather than where they were drawn. A part's own shape does not change when
 * the sim moves it, so only the seals, screws, runners and bosses are run again.
 */
export function withLivePoses(report: DfmReport, scene: SceneGraph, poses: LivePoses): DfmReport {
  const findings = [
    ...report.findings.filter((f) => !f.assembly),
    ...hardwareFindings(scene, report.process, scene, poses, report.nodeId ?? null),
  ];
  return { ...report, findings, score: scoreOf(findings) };
}
