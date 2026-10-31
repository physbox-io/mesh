// ---------------------------------------------------------------------------
// A PLA mold with a dissolvable PVA liner
// ---------------------------------------------------------------------------
//
// A rigid printed mold has to choose. Fill its undercuts in, and it lets go of
// the casting but loses the detail it filled. Keep them, and it locks onto the
// casting for good. A liner printed in PVA, in the same print, takes the choice
// away: the mold keeps every undercut, and what keeps them is the part that
// dissolves.
//
// The construction is the two molds the exporter already knows how to build:
//
//  - The PLA SHELL is the rigid mold — every column of the cavity sunk from the
//    parting face down to the part's lowest point, which is what makes it lift
//    straight off — with its cavity grown by a skin, so PLA never touches the
//    casting and draft no longer matters.
//  - The PVA LINER is the exact mold minus the shell: the block, less the part,
//    less the shell. That leaves PVA in every undercut, however deep, and a thin
//    skin everywhere else. There is no thickness to guess.
//
// Shell and liner together are exactly the undercut-keeping mold, so the cast
// simulation and the STL read the halves whole; only the 3MF and the preview
// tell the two materials apart.
//
// Using it: the shell lifts off along the pull (soaked a while if the PVA holds
// it), the casting comes out wearing its PVA, and the PVA dissolves off it.
// ---------------------------------------------------------------------------

import type { CrossSection, Manifold, ManifoldToplevel } from 'manifold-3d';
import type { Grid, ColumnField } from './moldColumns';
import {
  boundsOf,
  buildPartManifold,
  unsolidPartRefusal,
  exportBinarySTL,
  manifoldToTriangles,
  type Mat4Tuple,
} from './moldManifold';
import { exportThreeMfAssemblies, type ThreeMfAssembly, type ThreeMfPart } from './threeMfExporter';
import type { CsgContext, HalfFeatures, MoldExportResult, MoldMeshHalf } from './moldExporter';
import { castMaterial, castMaterialWarnings, type CastMaterialId } from './castMaterials';
import { applyDraft, erodeDepth, type DraftMode } from './moldDraft';

export const DEFAULT_LINER_SKIN_MM = 1.2;
export const WATER_BASED_REFUSAL = 'Water-based casts dissolve PVA while they cure; use the rigid mold or a silicone one.';
export const METAL_REFUSAL = 'Metal is poured into sand or investment, not a printed mold; make a Sand or Lost PLA pattern instead.';
export const NO_MANIFOLD_REFUSAL = "Couldn't load the geometry engine; reload the page and try again.";

/** g/cm³, as the filament makers give them. */
const PVA_DENSITY = 1.23;
const PLA_DENSITY = 1.24;
/**
 * Solid PVA in warm (30–40 °C), stirred water, mm an hour. A rough figure:
 * makers quote whole prints ("a few hours") rather than a rate, so this is
 * stated as one in the estimate and nothing is promised by it.
 */
const PVA_DISSOLVE_MM_PER_HOUR = 1;
/** What is left of the PLA floor under the deepest skin, at least. */
const MIN_FLOOR_MM = 1;

export interface MoldLinerInfo {
  skinMm: number;
  castMaterial: CastMaterialId;
  pvaVolumeMm3: number;
  pvaGrams: number;
  plaVolumeMm3: number;
  plaGrams: number;
  castVolumeMl: number;
  /** The deepest PVA anywhere from a face water reaches once the shell is off, mm. */
  thickestPvaMm: number;
  dissolveHours: number;
  /** What to do with it, in order. */
  steps: string[];
}

/** Whether this cast can go in a PVA-lined mold, and anything worth saying about it. */
export function castMaterialCheck(material: CastMaterialId, castVolumeMl: number): { error?: string; warnings: string[] } {
  const m = castMaterial(material);
  if (m.metal) return { error: METAL_REFUSAL, warnings: [] };
  if (m.waterBased) return { error: WATER_BASED_REFUSAL, warnings: [] };
  return { warnings: castMaterialWarnings(material, castVolumeMl, { pla: true }) };
}

/**
 * The shell's cavity, as a depth below the parting face per grid column: the
 * rigid cavity grown by the skin, down and out.
 *
 * Out is a max filter over a disc, and the disc is the skin plus half a grid
 * diagonal, because the envelope is a heightfield over the grid's vertices and
 * between two of them its edge is a straight line that can cut a corner the
 * samples straddle. Down is the skin added to whatever the disc found. A max
 * over a disc of radius r, plus r downward, contains the ball of radius r
 * about every sampled surface point, so the skin is at least `skinMm` thick.
 * (A whole diagonal was tried first: on a 120 mm ball it was 45% more PVA, and
 * no casting reached the PLA with either.)
 */
export function envelopeDepth(depth: Float64Array, grid: Grid, skinMm: number, maxDepthMm: number): Float64Array {
  const { cols, rows, stepX, stepY } = grid;
  const radius = skinMm + Math.hypot(stepX, stepY) / 2;
  const rx = Math.ceil(radius / stepX);
  const ry = Math.ceil(radius / stepY);
  const offsets: Array<[number, number]> = [];
  for (let dr = -ry; dr <= ry; dr++) {
    for (let dc = -rx; dc <= rx; dc++) {
      if ((dc * stepX) ** 2 + (dr * stepY) ** 2 <= radius * radius) offsets.push([dc, dr]);
    }
  }

  const out = new Float64Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let best = -1;
      for (const [dc, dr] of offsets) {
        const cc = c + dc;
        const rr = r + dr;
        if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) continue;
        const d = depth[rr * cols + cc];
        if (d > 1e-6 && d > best) best = d;
      }
      out[r * cols + c] = best < 0 ? 0 : Math.min(maxDepthMm, best + skinMm);
    }
  }
  return out;
}

/** Height of the envelope's flat top, and of its floor where there is no cavity: both above the block's face at z = 0. */
const ENVELOPE_TOP = 1;
const ENVELOPE_LIFT = 0.5;

/**
 * The envelope as a closed solid: a heightfield whose underside is the grown
 * cavity, z = -depth, and whose top stands above the block. Where a column has
 * no cavity its underside is lifted clear of the block, so the solid cuts
 * nothing there and shares no face with the block.
 *
 * Wound outward from each face's own direction: the underside faces -z, the
 * top +z, and each side its own way out.
 */
export function envelopeSolid(wasm: ManifoldToplevel, grid: Grid, depth: Float64Array): Manifold {
  const { cols, rows, stepX, stepY, halfW, halfD } = grid;
  const n = cols * rows;
  const vert = new Float32Array(n * 2 * 3);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const x = -halfW + c * stepX;
      const y = -halfD + r * stepY;
      vert.set([x, y, depth[i] > 0 ? -depth[i] : ENVELOPE_LIFT], i * 3);
      vert.set([x, y, ENVELOPE_TOP], (n + i) * 3);
    }
  }
  const b = (c: number, r: number) => r * cols + c;
  const t = (c: number, r: number) => n + r * cols + c;
  const tri: number[] = [];
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      // Underside, facing -z.
      tri.push(b(c, r), b(c, r + 1), b(c + 1, r + 1), b(c, r), b(c + 1, r + 1), b(c + 1, r));
      // Top, facing +z.
      tri.push(t(c, r), t(c + 1, r), t(c + 1, r + 1), t(c, r), t(c + 1, r + 1), t(c, r + 1));
    }
  }
  for (let c = 0; c + 1 < cols; c++) {
    // Front edge, facing -y.
    tri.push(b(c, 0), b(c + 1, 0), t(c + 1, 0), b(c, 0), t(c + 1, 0), t(c, 0));
    // Back edge, facing +y.
    const r = rows - 1;
    tri.push(b(c, r), t(c, r), t(c + 1, r), b(c, r), t(c + 1, r), b(c + 1, r));
  }
  for (let r = 0; r + 1 < rows; r++) {
    // Left edge, facing -x.
    tri.push(b(0, r), t(0, r), t(0, r + 1), b(0, r), t(0, r + 1), b(0, r + 1));
    // Right edge, facing +x.
    const c = cols - 1;
    tri.push(b(c, r), b(c, r + 1), t(c, r + 1), b(c, r), t(c, r + 1), t(c, r));
  }
  return new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: vert, triVerts: Uint32Array.from(tri) }));
}

/**
 * The part as a drafted cavity casts it, for the molds that cut the exact part
 * rather than a depth field: the liner and the undercut-keeping mold. `part` is
 * in the half's own frame (cavity below z = 0), and `rawDepth` is its depth
 * field on that half's grid. Returns `part` itself when there is no draft.
 *
 * The drafted field's envelope is the taper. 'remove' keeps only what lies
 * inside it. 'add' grows the part by everything the envelope has beyond the
 * undrafted one; that one is pulled in by a cell first, because its walls are
 * the grid's and lie a fraction of a cell off the part's, and growing from them
 * would leave a fin of mold between the two. 'centre' does both.
 */
export function draftPart(
  wasm: ManifoldToplevel,
  part: Manifold,
  grid: Grid,
  rawDepth: Float64Array,
  draftDeg: number,
  mode: DraftMode = 'remove',
): Manifold {
  if (!(draftDeg > 0)) return part;
  const drafted = envelopeSolid(wasm, grid, applyDraft(rawDepth, grid, draftDeg, mode));
  let out = part;
  if (mode !== 'remove') {
    const inner = envelopeSolid(wasm, grid, erodeDepth(rawDepth, grid));
    const grown = drafted.subtract(inner);
    inner.delete();
    out = part.add(grown);
    grown.delete();
  }
  if (mode !== 'add') {
    const kept = out.intersect(drafted);
    if (out !== part) out.delete();
    out = kept;
  }
  drafted.delete();
  return out;
}

/**
 * The part's solid spans in one half's own frame, per column of that half's
 * grid: z' below the parting face is negative. A half built from the part
 * turned over (`flipped`) is mirrored in Y as well, as the exporter builds it.
 */
function halfSpans(field: ColumnField, grid: Grid, partingZ: number, flipped: boolean): Float64Array[] {
  const { cols, rows } = grid;
  const out: Float64Array[] = new Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const src = field.spans[(flipped ? rows - 1 - r : r) * cols + c];
      const mapped: number[] = [];
      for (let k = 0; k + 1 < src.length; k += 2) {
        const lo = flipped ? partingZ - src[k + 1] : src[k] - partingZ;
        const hi = flipped ? partingZ - src[k] : src[k + 1] - partingZ;
        if (lo < 0) mapped.push(lo, Math.min(0, hi));
      }
      out[r * cols + c] = Float64Array.from(mapped);
    }
  }
  return out;
}

/**
 * The deepest PVA lies from a face water can reach, once the shell is off.
 *
 * The liner is voxelised on the mold grid, the casting in it is a wall water
 * cannot pass, and every voxel that is neither — the shell's side of the
 * envelope, or above the parting face — is open water. A chamfer distance
 * transform, two sweeps each way, then gives each PVA voxel its distance to
 * water through PVA alone. Not the exact solid, but it measures the right
 * thing: an undercut is slow to dissolve because of how far in it goes, not
 * how tall it is.
 */
export function thickestPvaMm(envelope: Float64Array, spans: Float64Array[], grid: Grid): number {
  const { stepX, stepY } = grid;
  // Only the envelope's own footprint, one column of water round it.
  let c0 = Infinity, c1 = -Infinity, r0 = Infinity, r1 = -Infinity, maxDepth = 0;
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const d = envelope[r * grid.cols + c];
      if (d <= 0) continue;
      if (d > maxDepth) maxDepth = d;
      c0 = Math.min(c0, c); c1 = Math.max(c1, c); r0 = Math.min(r0, r); r1 = Math.max(r1, r);
    }
  }
  if (maxDepth <= 0) return 0;
  c0 = Math.max(0, c0 - 1); r0 = Math.max(0, r0 - 1);
  c1 = Math.min(grid.cols - 1, c1 + 1); r1 = Math.min(grid.rows - 1, r1 + 1);
  const cols = c1 - c0 + 1;
  const rows = r1 - r0 + 1;
  const dz = Math.max(Math.min(stepX, stepY), maxDepth / 120);
  const layers = Math.ceil(maxDepth / dz);
  const plane = cols * rows;

  const OPEN = 0;
  const PART = -1;
  const dist = new Float32Array(plane * layers);
  for (let i = 0; i < plane; i++) {
    const src = (r0 + Math.floor(i / cols)) * grid.cols + c0 + (i % cols);
    const env = envelope[src];
    const sp = spans[src];
    for (let k = 0; k < layers; k++) {
      const z = -(k + 0.5) * dz;
      let value: number = OPEN;
      if (env > 0 && z >= -env) {
        value = Infinity;
        for (let s = 0; s + 1 < sp.length; s += 2) {
          if (z >= sp[s] && z <= sp[s + 1]) {
            value = PART;
            break;
          }
        }
      }
      dist[k * plane + i] = value;
    }
  }

  const neighbours: Array<[number, number, number, number]> = [];
  for (let dk = -1; dk <= 1; dk++) {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const before = dk < 0 || (dk === 0 && (dr < 0 || (dr === 0 && dc < 0)));
        if (before) neighbours.push([dc, dr, dk, Math.hypot(dc * stepX, dr * stepY, dk * dz)]);
      }
    }
  }
  const sweep = (sign: 1 | -1) => {
    const start = sign > 0 ? 0 : plane * layers - 1;
    for (let idx = start, step = 0; step < plane * layers; step++, idx += sign) {
      const here = dist[idx];
      if (here === PART || here === OPEN) continue;
      const k = Math.floor(idx / plane);
      const rem = idx - k * plane;
      const r = Math.floor(rem / cols);
      const c = rem - r * cols;
      let best = here;
      for (const [dc0, dr0, dk0, w] of neighbours) {
        const cc = c + dc0 * sign;
        const rr = r + dr0 * sign;
        const kk = k + dk0 * sign;
        // Off the grid is water: above the face, under the floor, or out past the flange.
        const d = cc < 0 || rr < 0 || kk < 0 || cc >= cols || rr >= rows || kk >= layers
          ? OPEN
          : dist[kk * plane + rr * cols + cc];
        if (d === PART) continue;
        if (d + w < best) best = d + w;
      }
      dist[idx] = best;
    }
  };
  for (let pass = 0; pass < 2; pass++) {
    sweep(1);
    sweep(-1);
  }

  let thickest = 0;
  for (let i = 0; i < dist.length; i++) {
    const d = dist[i];
    if (d > 0 && Number.isFinite(d) && d > thickest) thickest = d;
  }
  return thickest;
}

const flipAbout = (z: number): Mat4Tuple => [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, z, 1];

function replace(prev: Manifold, next: Manifold): Manifold {
  prev.delete();
  return next;
}

function replaceSection(prev: CrossSection, next: CrossSection): CrossSection {
  prev.delete();
  return next;
}

interface HalfPair {
  shell: Manifold;
  liner: Manifold;
  envelope: Float64Array;
  spans: Float64Array[];
  /** Part volume outside the envelope: where the shell would touch the casting. */
  escapedMm3: number;
}

/**
 * One half as shell and liner, in the half's own frame (cavity below z = 0).
 * `flipped` is the part turned over onto its other face, as the exporter
 * builds whichever half holds the top of it.
 */
function buildHalfPair(
  ctx: LinerContext,
  rawPart: Manifold,
  flipped: boolean,
  rawDepth: Float64Array,
  blockHeight: number,
  features: HalfFeatures,
): HalfPair {
  const { wasm, grid, moldWidthMm, moldDepthMm, partingZ } = ctx;
  let part = flipped ? rawPart.transform(flipAbout(partingZ)) : rawPart.translate([0, 0, -partingZ]);
  // The casting as the draft leaves it; the shell's envelope then has to hold
  // both it and the undrafted part, whichever reaches further.
  const { draftAngleDeg, draftMode } = ctx.opts;
  const drafted = draftPart(wasm, part, grid, rawDepth, draftAngleDeg, draftMode);
  if (drafted !== part) part = replace(part, drafted);
  const reach = draftAngleDeg > 0 ? applyDraft(rawDepth, grid, draftAngleDeg, draftMode).map((d, i) => Math.max(d, rawDepth[i])) : rawDepth;
  if (ctx.opts.moldType === 'open' || ctx.lidIsBackingPlate) {
    // Here the part ends exactly on the block's face, and a solid cut by
    // another that shares its face is left with a sheet of nothing there. So
    // the part's outline at the face is carried up through it, as the exact
    // open mold does.
    let slice = part.slice(-0.01);
    if (slice.isEmpty()) slice = replaceSection(slice, part.slice(-0.1));
    if (!slice.isEmpty()) {
      const pour = wasm.Manifold.extrude(slice, 2.5).translate([0, 0, -0.5]);
      part = replace(part, part.add(pour));
      pour.delete();
    }
    slice.delete();
  }

  const envelope = envelopeDepth(reach, grid, ctx.skinMm, blockHeight - MIN_FLOOR_MM);
  const env = envelopeSolid(wasm, grid, envelope);
  const cube = wasm.Manifold.cube([moldWidthMm, moldDepthMm, blockHeight], false);
  const block = cube.translate([-moldWidthMm / 2, -moldDepthMm / 2, -blockHeight]);
  cube.delete();

  // Inside the block only: the face-cutting stub above it is no part of the casting.
  const outside = part.subtract(env);
  const escaped = outside.intersect(block);
  const escapedMm3 = escaped.volume();
  outside.delete();
  escaped.delete();

  const cavity = env.add(part);
  let shell = block.subtract(cavity);
  cavity.delete();
  const inBlock = block.intersect(env);
  let liner = inBlock.subtract(part);
  inBlock.delete();
  block.delete();
  env.delete();
  part.delete();

  const cutBoth = (tool: Manifold) => {
    shell = replace(shell, shell.subtract(tool));
    liner = replace(liner, liner.subtract(tool));
    tool.delete();
  };
  for (const s of features.sockets) {
    cutBoth(wasm.Manifold.cylinder(s.depth + 0.5, s.botR, s.rimR, 24, false).translate([s.x, s.y, -s.depth]));
  }
  for (const v of features.topVents ?? []) {
    if (v.zRoof < -0.1 && v.zRoof > -blockHeight + 0.5) {
      // Started a little inside the casting, not on its roof: a vent ending
      // exactly on the part's face leaves PVA touching itself along the rim.
      const sink = 0.3;
      cutBoth(wasm.Manifold.cylinder(1.0 - v.zRoof + sink, v.r, v.r, 24, false).translate([v.x, v.y, v.zRoof - sink]));
    }
  }
  for (const p of features.pins) {
    const pin = wasm.Manifold.cylinder(p.height + 0.5, p.baseR, p.topR, 24, false).translate([p.x, p.y, -0.5]);
    shell = replace(shell, shell.add(pin));
    pin.delete();
  }
  for (const ch of features.channels) {
    cutBoth(
      wasm.Manifold.cylinder(blockHeight + 2, ch.outerR, ch.innerR, 24, false).translate([ch.x, ch.y, -blockHeight - 1])
    );
  }

  return { shell, liner, envelope, spans: halfSpans(ctx.field, grid, partingZ, flipped), escapedMm3 };
}

/** Everything the exact-CSG mold build has, plus what the liner needs from the column field. */
export interface LinerContext extends CsgContext {
  field: ColumnField;
  skinMm: number;
  castMaterial: CastMaterialId;
}

function meshPart(m: Manifold, name: string, extruder: number): ThreeMfPart {
  const mesh = m.getMesh();
  const stride = mesh.numProp;
  const count = mesh.vertProperties.length / stride;
  const positions = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) {
    positions[v * 3] = mesh.vertProperties[v * stride];
    positions[v * 3 + 1] = mesh.vertProperties[v * stride + 1];
    positions[v * 3 + 2] = mesh.vertProperties[v * stride + 2];
  }
  return { name, positions, indices: mesh.triVerts, extruder };
}

/**
 * The PVA-lined mold, or the one sentence that says why not. Shares its layout
 * with the exact-CSG mold: halves side by side on the plate, cavity up.
 */
export function buildLinerMold(ctx: LinerContext): MoldExportResult | { error: string } {
  const { wasm, opts, warnings } = ctx;
  const fail = (error: string) => ({ error });

  const { part: rawPart, unsolid } = buildPartManifold(wasm, ctx.tris, ctx.solidIds);
  if (!rawPart) return fail(unsolidPartRefusal(unsolid, ctx.solidNames, 'the liner'));
  const castVolumeMl = rawPart.volume() / 1000;

  const material = castMaterialCheck(ctx.castMaterial, castVolumeMl);
  if (material.error) {
    rawPart.delete();
    return fail(material.error);
  }
  const notes = [...warnings, ...material.warnings];
  if (opts.baseThicknessMm < ctx.skinMm + MIN_FLOOR_MM) {
    notes.push(
      `The ${opts.baseThicknessMm} mm floor leaves under ${MIN_FLOOR_MM} mm of PLA below a ${ctx.skinMm} mm liner; ` +
      `a floor of ${Math.ceil((ctx.skinMm + MIN_FLOOR_MM + 1) * 10) / 10} mm or more keeps the shell stiff.`
    );
  }

  const clamshell = opts.moldType === 'clamshell';
  const base = buildHalfPair(ctx, rawPart, ctx.detailIsAbove, ctx.rawBaseDepth, ctx.baseBlockHeight, ctx.baseFeatures);
  const lid = clamshell
    ? buildHalfPair(ctx, rawPart, !ctx.detailIsAbove, ctx.rawLidDepth, ctx.lidBlockHeight, ctx.lidFeatures)
    : null;
  rawPart.delete();

  const halves = lid ? [base, lid] : [base];
  const escaped = halves.reduce((sum, h) => sum + h.escapedMm3, 0);
  if (escaped > castVolumeMl * 1000 * 0.002) {
    notes.push(
      `${Math.round(escaped)} mm³ of the part reaches past the liner onto the PLA, where a feature is finer than ` +
      'the mold grid; the shell may grip the casting there.'
    );
  }

  const plateGapMm = 6;
  const plateOffset = lid ? ctx.moldWidthMm / 2 + plateGapMm / 2 : 0;
  const placed = (h: HalfPair, x: number, lift: number) => {
    const shell = h.shell.translate([x, 0, lift]);
    const liner = h.liner.translate([x, 0, lift]);
    h.shell.delete();
    h.liner.delete();
    return { shell, liner };
  };
  const basePlaced = placed(base, -plateOffset, ctx.baseBlockHeight);
  const lidPlaced = lid ? placed(lid, plateOffset, ctx.lidBlockHeight) : null;
  const all = lidPlaced ? [basePlaced, lidPlaced] : [basePlaced];

  const pvaVolumeMm3 = all.reduce((s, h) => s + h.liner.volume(), 0);
  const plaVolumeMm3 = all.reduce((s, h) => s + h.shell.volume(), 0);
  const thickest = Math.max(...halves.map((h) => thickestPvaMm(h.envelope, h.spans, ctx.grid)));
  const dissolveHours = Math.max(1, Math.ceil(thickest / PVA_DISSOLVE_MM_PER_HOUR));

  const names = lid ? ['Cavity half', 'Lid half'] : ['Open mold'];
  const assemblies: ThreeMfAssembly[] = all.map((h, i) => ({
    name: names[i],
    parts: [meshPart(h.shell, `${names[i]} shell (PLA)`, 1), meshPart(h.liner, `${names[i]} liner (PVA)`, 2)],
  }));

  const halfOf = (h: { shell: Manifold; liner: Manifold }, name: string, blockHeight: number, pinRise: number): MoldMeshHalf => {
    const shell = manifoldToTriangles(h.shell);
    const liner = manifoldToTriangles(h.liner);
    const triangles = [...shell, ...liner];
    return {
      name,
      triangles,
      liner: { shell, liner },
      bounds: boundsOf(triangles),
      widthMm: ctx.moldWidthMm,
      depthMm: ctx.moldDepthMm,
      heightMm: Math.round((blockHeight + pinRise) * 10) / 10,
      partingZMm: Math.round(blockHeight * 100) / 100,
      triangleCount: triangles.length,
    };
  };
  const bottomHalf = halfOf(basePlaced, 'Cavity Half', ctx.baseBlockHeight, 0);
  const topHalf = lidPlaced ? halfOf(lidPlaced, 'Lid Half (Pins, Sprue & Vents)', ctx.lidBlockHeight, opts.pinHeightMm) : undefined;
  for (const h of all) {
    h.shell.delete();
    h.liner.delete();
  }

  const combinedTriangles = topHalf ? [...bottomHalf.triangles, ...topHalf.triangles] : bottomHalf.triangles;
  let stlBytes: Uint8Array | null = null;
  let threeMfBytes: Uint8Array | null = null;
  const totalWidth = lid ? ctx.moldWidthMm * 2 + plateGapMm : ctx.moldWidthMm;
  const totalHeight = Math.max(ctx.baseBlockHeight, lid ? ctx.lidBlockHeight + opts.pinHeightMm : 0);

  const liner: MoldLinerInfo = {
    skinMm: ctx.skinMm,
    castMaterial: ctx.castMaterial,
    pvaVolumeMm3: Math.round(pvaVolumeMm3),
    pvaGrams: Math.round((pvaVolumeMm3 / 1000) * PVA_DENSITY * 10) / 10,
    plaVolumeMm3: Math.round(plaVolumeMm3),
    plaGrams: Math.round((plaVolumeMm3 / 1000) * PLA_DENSITY * 10) / 10,
    castVolumeMl: Math.round(castVolumeMl * 10) / 10,
    thickestPvaMm: Math.round(thickest * 10) / 10,
    dissolveHours,
    steps: [
      'Print with PLA on extruder 1 and PVA on extruder 2 (pre-assigned in 3MF).',
      `Cast ${castMaterial(ctx.castMaterial).label.toLowerCase()} and allow to cure.`,
      'Remove the PLA outer shell along the pull direction.',
      `Dissolve the PVA liner in warm (30–40 °C) water (~${dissolveHours} h for ${Math.round(thickest * 10) / 10} mm max thickness).`,
    ],
  };

  return {
    success: true,
    ...ctx.setup,
    get binarySTL() {
      if (!stlBytes) stlBytes = exportBinarySTL(combinedTriangles, 'PhysBox 3D Mold Plate (PLA + PVA)');
      return stlBytes;
    },
    get threeMf() {
      if (!threeMfBytes) threeMfBytes = exportThreeMfAssemblies(assemblies).data;
      return threeMfBytes;
    },
    liner,
    partBounds: { minX: ctx.mnX, minY: ctx.mnY, minZ: ctx.mnZ, maxX: ctx.mxX, maxY: ctx.mxY, maxZ: ctx.mxZ },
    moldBounds: {
      minX: -totalWidth / 2,
      minY: -ctx.moldDepthMm / 2,
      minZ: 0,
      maxX: totalWidth / 2,
      maxY: ctx.moldDepthMm / 2,
      maxZ: totalHeight,
    },
    partWidthMm: Math.round(ctx.partWidthMm * 10) / 10,
    partDepthMm: Math.round(ctx.partDepthMm * 10) / 10,
    partHeightMm: Math.round(ctx.partHeightMm * 10) / 10,
    moldWidthMm: Math.round(ctx.moldWidthMm * 10) / 10,
    moldDepthMm: Math.round(ctx.moldDepthMm * 10) / 10,
    moldHeightMm: Math.round(totalHeight * 10) / 10,
    totalTriangles: combinedTriangles.length,
    cavityDepthMm: Math.round(ctx.rawCavityDepthMm * 10) / 10,
    minDraftDeg: Math.round(ctx.minDraftDeg * 10) / 10,
    // The PVA is what lets go, so a rigid shell is fine whatever the draft.
    flexibleMoldAdvised: false,
    lidIsBackingPlate: ctx.lidIsBackingPlate,
    bottomHalf,
    topHalf,
    combinedTriangles,
    warnings: notes,
  };
}
