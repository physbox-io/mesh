// ---------------------------------------------------------------------------
// A printed mold with a dissolvable liner (PLA + PVA by default; linerMaterials.ts)
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
// Nothing the pour touches is shell. The sprue, vents, down-sprue, runner and
// gate each get a sleeve of liner the skin thick, because epoxy cured in a
// bare shell bore holds on for good: a real ASA + HIPS gear mold came out of
// four hours of limonene with its lid glued on by nine vent plugs and the
// casting held in the cavity half by a runner buried under it.
//
// Two constructions:
//  - 'combined': shell and liner printed together, two filaments, a pair of
//    bodies per half.
//  - 'insert': the liner is a separate insert, printed alone in the soluble
//    filament, sitting with a clearance in a pocket of a reusable holder,
//    printed alone in the rigid one. Four prints. The holder lifts off and the
//    whole insert is open to the solvent, instead of only its rim.
//
// A clamshell's shell (or holder) carries a tongue round the cavity on the lid
// and a groove for it on the cavity half, so the seam needs no tape.
//
// Using it: the shell lifts off along the pull (soaked a while if the PVA holds
// it), the casting comes out wearing its PVA, and the PVA dissolves off it.
// ---------------------------------------------------------------------------

import type { CrossSection, Manifold, ManifoldToplevel, SimplePolygon } from 'manifold-3d';
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
import { linerPair, pairSoftenC, type LinerPair, type LinerPairId } from './linerMaterials';
import { fittedBlock, type Outline } from './moldOutline';
import { channelSolid, sprueNeckDiaMm, withPourMouth } from './moldSprue';
import { boreSolids, type BoreCut } from './moldGating';
import { unprintableRoofs, ROOF_LAYER_MM, type CavityRoof } from './moldRoofs';

export const DEFAULT_LINER_SKIN_MM = 1.2;

/** How a lined mold prints: shell and liner together, or a separate insert in a holder. */
export type LinerConstruction = 'combined' | 'insert';
/** Gap between an insert and its holder's pocket, all round, mm. */
export const INSERT_CLEARANCE_MM = 0.25;
/** The seal: a tongue on the lid's shell and a groove for it on the cavity half's, mm. */
export const SEAL_TONGUE_W_MM = 1.2;
export const SEAL_TONGUE_H_MM = 1.0;
export const SEAL_GROOVE_CLEAR_MM = 0.15;
/** Deeper than the tongue is tall, so the faces still meet. */
export const SEAL_GROOVE_D_MM = 1.3;
/** Shell kept between the groove and the block's edge, mm. */
const SEAL_EDGE_MM = 1;
/** Room the seal takes outside the liner, beyond a 1 mm wall: the nearest gap, the groove and its edge. */
export const SEAL_RING_ROOM_MM = 0.8 + SEAL_TONGUE_W_MM + 2 * SEAL_GROOVE_CLEAR_MM + SEAL_EDGE_MM - 1;
/** Kept clear round a pin, socket or pry notch, mm. */
const SEAL_PIN_CLEAR_MM = 0.8;
/** Said of a water-soluble liner; an ABS + HIPS mold takes water-based casts. */
export const WATER_BASED_REFUSAL = 'Water-based casts dissolve a water-soluble liner while they cure; use an ABS + HIPS or PLA + PVB liner, the rigid mold or a silicone one.';
export const MELTS_REFUSAL = (label: string) =>
  `${label} melts before a liner dissolves, and a solvent bath is no place for food; use a silicone mold.`;
export const METAL_REFUSAL = 'Metal is poured into sand or investment, not a printed mold; make a Sand or Lost PLA pattern instead.';
export const NO_MANIFOLD_REFUSAL = "Couldn't load the geometry engine; reload the page and try again.";

/** What is left of the shell's floor under the deepest skin, at least. */
const MIN_FLOOR_MM = 1;

export interface MoldLinerInfo {
  /** What it is printed in (linerMaterials.ts). */
  pair: LinerPairId;
  shellMaterial: string;
  linerMaterial: string;
  /** What dissolves the liner. */
  solvent: string;
  skinMm: number;
  castMaterial: CastMaterialId;
  linerVolumeMm3: number;
  linerGrams: number;
  shellVolumeMm3: number;
  shellGrams: number;
  castVolumeMl: number;
  /** The deepest liner anywhere from a face the solvent reaches once the shell is off, mm. */
  thickestLinerMm: number;
  dissolveHours: number;
  /** Shell and liner printed together, or an insert in a holder. */
  construction: LinerConstruction;
  /** Whether the clamshell's shell carries the tongue and groove. */
  sealRidge: boolean;
  /** Weight on the lid that holds it down through the pour, g (clamshells). */
  clampGrams?: number;
  /** What to do with it, in order. */
  steps: string[];
}

/** Whether this cast can go in a mold lined with this pair, and anything worth saying about it. */
export function castMaterialCheck(material: CastMaterialId, castVolumeMl: number, pairId?: LinerPairId): { error?: string; warnings: string[] } {
  const m = castMaterial(material);
  const pair = linerPair(pairId);
  if (m.metal) return { error: METAL_REFUSAL, warnings: [] };
  // Hours in a bath melt ice and chocolate before any liner is gone, and
  // chocolate does not belong in IPA or limonene either.
  if (m.meltsInBath) return { error: MELTS_REFUSAL(m.label), warnings: [] };
  if (m.waterBased && pair.waterSoluble) return { error: WATER_BASED_REFUSAL, warnings: [] };
  return { warnings: castMaterialWarnings(material, castVolumeMl, { pla: true, softenC: pairSoftenC(pair), name: pair.label }) };
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

function replace2(prev: CrossSection, next: CrossSection): CrossSection {
  prev.delete();
  return next;
}

/** Smaller than this, a separate piece of a printed body is a crumb: a slicer's sliver, or a loose pillar left between sleeves. */
const CRUMB_MM3 = 2;

/** `m` without its crumbs; `m` is consumed. */
function withoutCrumbs(wasm: ManifoldToplevel, m: Manifold): Manifold {
  const pieces = m.decompose();
  if (pieces.length <= 1) {
    for (const p of pieces) p.delete();
    return m;
  }
  const kept = pieces.filter((p) => p.volume() >= CRUMB_MM3);
  const out = wasm.Manifold.compose(kept.length ? kept : pieces);
  for (const p of pieces) p.delete();
  m.delete();
  return out;
}

/**
 * A sleeve of liner round every feature the pour runs through (sprue, vents,
 * down-sprue, runner, gate, an open mold's blind vents), the skin thick, as
 * solids in the half's own frame. Not the sockets: pins go in those.
 */
export function featureSleeves(wasm: ManifoldToplevel, features: HalfFeatures, blockHeight: number, skinMm: number): Manifold[] {
  const out: Manifold[] = [];
  for (const ch of features.channels) {
    const stop = ch.pocketZMm !== undefined && ch.pocketZMm > 0 ? Math.max(0, ch.pocketZMm - skinMm) : ch.pocketZMm;
    out.push(channelSolid(wasm, { ...ch, outerR: ch.outerR + skinMm, innerR: ch.innerR + skinMm, ...(stop !== undefined ? { pocketZMm: stop } : {}) }, blockHeight, false));
  }
  for (const v of features.topVents ?? []) {
    if (v.zRoof < -0.1 && v.zRoof > -blockHeight + 0.5) {
      const z0 = v.zRoof - 0.3 - skinMm;
      out.push(wasm.Manifold.cylinder(1.0 - z0, v.r + skinMm, v.r + skinMm, 24, false).translate([v.x, v.y, z0]));
    }
  }
  for (const cut of features.bores ?? []) {
    // Round-ended: the ball on each end puts the skin past it as well.
    const grown: BoreCut = { ...cut, r: cut.r + skinMm, ...(cut.rB !== undefined ? { rB: cut.rB + skinMm } : {}), fluted: false, ends: true };
    out.push(...boreSolids(wasm, grown));
  }
  return out;
}

/**
 * How deep below the parting face each grid column holds a sleeve: the same
 * features as featureSleeves, as a depth field, so an insert can carry them as
 * columns it lifts out with. Generous by half a grid diagonal, as the envelope
 * is, so the heightfield between the samples still holds the exact sleeves.
 * A channel goes right through the half.
 */
export function sleeveColumnDepth(features: HalfFeatures, grid: Grid, blockHeight: number, skinMm: number): Float64Array {
  const { cols, rows, stepX, stepY, halfW, halfD } = grid;
  const pad = Math.hypot(stepX, stepY) / 2;
  const out = new Float64Array(cols * rows);
  const through = blockHeight + 2;
  const stamp = (x: number, y: number, R: number, depthAt: (d: number) => number) => {
    const c0 = Math.max(0, Math.floor((x - R - pad + halfW) / stepX));
    const c1 = Math.min(cols - 1, Math.ceil((x + R + pad + halfW) / stepX));
    const r0 = Math.max(0, Math.floor((y - R - pad + halfD) / stepY));
    const r1 = Math.min(rows - 1, Math.ceil((y + R + pad + halfD) / stepY));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const d = Math.max(0, Math.hypot(-halfW + c * stepX - x, -halfD + r * stepY - y) - pad);
        if (d > R) continue;
        const depth = depthAt(d);
        const i = r * cols + c;
        if (depth > out[i]) out[i] = depth;
      }
    }
  };
  for (const ch of features.channels) stamp(ch.x, ch.y, Math.max(ch.outerR, ch.innerR) + skinMm, () => through);
  for (const v of features.topVents ?? []) {
    if (v.zRoof < -0.1 && v.zRoof > -blockHeight + 0.5) stamp(v.x, v.y, v.r + skinMm, () => 0.3 + skinMm - v.zRoof);
  }
  for (const cut of features.bores ?? []) {
    // Balls along the axis: the round-ended sleeve exactly.
    const len = Math.hypot(cut.b[0] - cut.a[0], cut.b[1] - cut.a[1], cut.b[2] - cut.a[2]);
    const n = Math.max(1, Math.ceil(len / 0.25));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const z = cut.a[2] + t * (cut.b[2] - cut.a[2]);
      const R = cut.r + t * ((cut.rB ?? cut.r) - cut.r) + skinMm;
      stamp(cut.a[0] + t * (cut.b[0] - cut.a[0]), cut.a[1] + t * (cut.b[1] - cut.a[1]), R, (d) => Math.sqrt(R * R - d * d) - z);
    }
  }
  return out;
}

/**
 * Deepens `depth` to at least `minDepth` at every grid vertex within half a
 * grid diagonal of `footprint`, so the heightfield between the samples covers
 * it all.
 */
function stampFootprint(depth: Float64Array, grid: Grid, footprint: CrossSection, minDepth: number): void {
  const { cols, rows, stepX, stepY, halfW, halfD } = grid;
  const grown = footprint.offset(Math.hypot(stepX, stepY) / 2, 'Round');
  const polys = grown.toPolygons();
  grown.delete();
  const inside = (x: number, y: number) => {
    let n = 0;
    for (const poly of polys) {
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) n++;
      }
    }
    return n % 2 === 1;
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (depth[i] >= minDepth) continue;
      if (inside(-halfW + c * stepX, -halfD + r * stepY)) depth[i] = minDepth;
    }
  }
}

/**
 * An insert's depth field deepened so that, printed parting face up, its
 * underside builds up from the bed at 45° or steeper everywhere: no piece of
 * it, cut or not, needs support. Each column's underside comes down to no
 * higher above the bed than its distance, through the insert, from where the
 * insert stands on the bed; a low point the slopes cannot reach is taken down
 * to the bed itself, and the slopes then run to it. Only ever deeper, and only
 * under the insert's own footprint.
 */
/** Half the width of the least footprint an insert stands on the bed by, mm: a few nozzle lines. */
const BED_FOOT_R = 1.2;

export function selfSupporting(depth: Float64Array, grid: Grid, blockHeight: number): Float64Array {
  const { cols, rows, stepX, stepY } = grid;
  const n = cols * rows;
  const deepest = Math.min(blockHeight, depth.reduce((m, d) => Math.max(m, d), 0));
  if (!(deepest > 0)) return depth;
  // Height of each column's underside above the bed; outside the insert, none.
  const height = new Float64Array(n).fill(Infinity);
  for (let i = 0; i < n; i++) if (depth[i] > 0) height[i] = Math.max(0, deepest - Math.min(depth[i], blockHeight));
  const diag = Math.hypot(stepX, stepY);
  const nb: Array<[number, number, number]> = [[-1, 0, stepX], [1, 0, stepX], [0, -1, stepY], [0, 1, stepY], [-1, -1, diag], [1, -1, diag], [-1, 1, diag], [1, 1, diag]];
  // Where the insert stands on the bed, grown to a footprint a slicer keeps:
  // a needle that meets the bed at a point is a first-layer speck it drops,
  // and everything built up from it is then floating.
  const reach: Array<[number, number]> = [];
  const rc = Math.ceil(BED_FOOT_R / stepX), rr = Math.ceil(BED_FOOT_R / stepY);
  for (let dr = -rr; dr <= rr; dr++) for (let dc = -rc; dc <= rc; dc++) if (Math.hypot(dc * stepX, dr * stepY) <= BED_FOOT_R) reach.push([dc, dr]);
  const onBed = new Uint8Array(n);
  const standOnBed = (i: number) => {
    const r0 = Math.floor(i / cols), c0 = i - r0 * cols;
    for (const [dc, dr] of reach) {
      const c = c0 + dc, r = r0 + dr;
      if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
      const j = r * cols + c;
      if (Number.isFinite(height[j])) onBed[j] = 1;
    }
  };
  for (let i = 0; i < n; i++) if (height[i] <= 1e-6) standOnBed(i);
  const out = new Float64Array(height);
  for (let round = 0; round < 64; round++) {
    // Distance through the insert to where it stands on the bed: two chamfer sweeps each way.
    const dist = new Float64Array(n).fill(Infinity);
    for (let i = 0; i < n; i++) if (onBed[i]) dist[i] = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (const dir of [1, -1]) {
        for (let k = 0; k < n; k++) {
          const i = dir > 0 ? k : n - 1 - k;
          if (!Number.isFinite(height[i])) continue;
          const r = Math.floor(i / cols), c = i - r * cols;
          let best = dist[i];
          for (const [dc, dr, w] of nb) {
            const cc = c + dc, rr = r + dr;
            if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) continue;
            const v = dist[rr * cols + cc] + w;
            if (v < best) best = v;
          }
          dist[i] = best;
        }
      }
    }
    for (let i = 0; i < n; i++) if (Number.isFinite(height[i])) out[i] = onBed[i] ? 0 : Math.min(height[i], dist[i]);
    // A column with nothing lower beside it to build up from goes down to the bed.
    let added = 0;
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(out[i]) || out[i] <= 1e-6) continue;
      const r = Math.floor(i / cols), c = i - r * cols;
      let held = false;
      for (const [dc, dr, w] of nb) {
        const cc = c + dc, rr = r + dr;
        if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) continue;
        const j = rr * cols + cc;
        if (Number.isFinite(out[j]) && out[j] <= out[i] - w + 1e-6) {
          held = true;
          break;
        }
      }
      if (!held) {
        standOnBed(i);
        added++;
      }
    }
    if (!added) break;
  }
  const result = new Float64Array(n);
  for (let i = 0; i < n; i++) result[i] = Number.isFinite(out[i]) ? Math.max(depth[i], deepest - out[i]) : depth[i];
  return result;
}

/** How far down from the parting face a holder's pocket fits its insert to the clearance exactly, mm. */
const INSERT_RIM_FIT_MM = 3;

/** Signed area of a contour: positive is an outer boundary, negative a hole. */
function contourArea(poly: SimplePolygon): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/** A solid's outline where it meets the parting face, holes filled. */
function faceOutline(wasm: ManifoldToplevel, m: Manifold): CrossSection {
  const cs = m.slice(-0.05);
  const outer = cs.toPolygons().filter((p) => contourArea(p) > 0);
  cs.delete();
  return new wasm.CrossSection(outer, 'Positive');
}

interface HalfPair {
  shell: Manifold;
  liner: Manifold;
  /** Where the liner (or the holder's pocket) meets the parting face, holes filled: the seal goes round it. */
  face: CrossSection;
  /** The block's own outline at the parting face. */
  blockFace: CrossSection;
  envelope: Float64Array;
  spans: Float64Array[];
  /** Part volume outside the envelope: where the shell would touch the casting. */
  escapedMm3: number;
  /** An insert cut into pieces that each print with nothing over the casting (splitInsert), bottom first; together they are `liner`. */
  pieces?: Manifold[];
}

/**
 * The part in one half's own frame (cavity below z = 0), as that half's mold
 * casts it: drafted, and carried up through the face where it ends on it.
 */
function halfPart(ctx: LinerContext, rawPart: Manifold, flipped: boolean, rawDepth: Float64Array): Manifold {
  const { wasm, grid, partingZ } = ctx;
  let part = flipped ? rawPart.transform(flipAbout(partingZ)) : rawPart.translate([0, 0, -partingZ]);
  // The casting as the draft leaves it; the shell's envelope then has to hold
  // both it and the undrafted part, whichever reaches further.
  const { draftAngleDeg, draftMode } = ctx.opts;
  const drafted = draftPart(wasm, part, grid, rawDepth, draftAngleDeg, draftMode);
  if (drafted !== part) part = replace(part, drafted);
  if (ctx.opts.moldType === 'open' || ctx.lidIsBackingPlate) {
    // Here the part ends exactly on the block's face, and a solid cut by
    // another that shares its face is left with a sheet of nothing there. So
    // the part's outline at the face is carried up through it, as the exact
    // open mold does.
    part = withPourMouth(wasm, part, ctx.opts.moldType === 'open' ? sprueNeckDiaMm(ctx.opts.sprueBottomDiaMm, ctx.castMaterial) : 0);
  }
  return part;
}

/**
 * One half as shell and liner, in the half's own frame (cavity below z = 0).
 * `part` is halfPart's, and stays the caller's. `arriving` is where liner
 * lifted off the other half's cavity lands on this half's face (liftRoofs):
 * that much of the face is liner a skin deep, so what lands there stands on
 * liner.
 */
function buildHalfPair(
  ctx: LinerContext,
  part: Manifold,
  flipped: boolean,
  rawDepth: Float64Array,
  blockHeight: number,
  features: HalfFeatures,
  outline?: Outline | null,
  arriving?: CrossSection | null,
): HalfPair {
  const { wasm, grid, moldWidthMm, moldDepthMm, partingZ } = ctx;
  const { draftAngleDeg, draftMode } = ctx.opts;
  const reach = draftAngleDeg > 0 ? applyDraft(rawDepth, grid, draftAngleDeg, draftMode).map((d, i) => Math.max(d, rawDepth[i])) : rawDepth;

  const envelope = envelopeDepth(reach, grid, ctx.skinMm, blockHeight - MIN_FLOOR_MM);
  const env = envelopeSolid(wasm, grid, envelope);
  const cube = wasm.Manifold.cube([moldWidthMm, moldDepthMm, blockHeight], false);
  const block = fittedBlock(wasm, cube.translate([-moldWidthMm / 2, -moldDepthMm / 2, -blockHeight]), outline, -blockHeight, 0);
  cube.delete();

  // Inside the block only: the face-cutting stub above it is no part of the casting.
  const outside = part.subtract(env);
  const escaped = outside.intersect(block);
  const escapedMm3 = escaped.volume();
  outside.delete();
  escaped.delete();

  // Every bore the pour runs through, sleeved in liner.
  const sleeveTools = featureSleeves(wasm, features, blockHeight, ctx.skinMm);
  const sleeveAll = sleeveTools.length ? wasm.Manifold.union(sleeveTools) : null;
  for (const t of sleeveTools) t.delete();
  const sleeves = sleeveAll ? sleeveAll.intersect(block) : null;
  sleeveAll?.delete();
  const reachWithSleeves = sleeves ? env.add(sleeves) : env;
  // A skin wider than what lands, so that an insert's clearance round it lies
  // under the other half's solid face and not over the seam where the pad
  // meets that half's liner: resin wicks along a seam into an open gap.
  const landingFoot = arriving && !arriving.isEmpty() ? arriving.offset(ctx.skinMm, 'Round') : null;
  const landing = landingFoot
    ? wasm.Manifold.extrude(landingFoot, ctx.skinMm + ENVELOPE_TOP).translate([0, 0, -ctx.skinMm])
    : null;
  const linerReach = landing ? reachWithSleeves.add(landing) : reachWithSleeves;

  let shell: Manifold;
  let liner: Manifold;
  let face: CrossSection;
  if (ctx.construction === 'insert') {
    // The insert is a heightfield sunk from the parting face, holding the
    // envelope and every sleeve, so it lifts out of its holder. A column it
    // would leave too thin a floor under goes on through.
    const sd = sleeveColumnDepth(features, grid, blockHeight, ctx.skinMm);
    const limit = blockHeight - MIN_FLOOR_MM;
    const raw = envelope.map((d, i) => Math.max(d, sd[i]));
    // What lands from the other half stands on insert, a skin deep at least.
    if (landingFoot) stampFootprint(raw, grid, landingFoot, ctx.skinMm);
    // Built down to the bed at 45° or steeper, so no piece of it needs support.
    const insertDepth = selfSupporting(raw, grid, blockHeight).map((v) => (v > limit ? blockHeight + 2 : v));
    const outer = envelopeSolid(wasm, grid, insertDepth);
    const withSleeves = sleeves ? outer.add(sleeves) : outer;
    const shape = landing ? withSleeves.add(landing) : withSleeves;
    if (shape !== withSleeves && withSleeves !== outer) withSleeves.delete();
    const inBlock = shape.intersect(block);
    liner = inBlock.subtract(part);
    inBlock.delete();
    // The pocket: the heightfield grown by the clearance on the grid, and to
    // the clearance exactly round the rim, where it sets how the two inserts
    // line up with each other.
    const gridPocket = envelopeSolid(wasm, grid, envelopeDepth(insertDepth, grid, INSERT_CLEARANCE_MM, Infinity));
    const rimFace = faceOutline(wasm, outer);
    const rimGrown = rimFace.offset(INSERT_CLEARANCE_MM, 'Round');
    rimFace.delete();
    const rimSlab = wasm.Manifold.extrude(rimGrown, INSERT_RIM_FIT_MM + ENVELOPE_TOP);
    rimGrown.delete();
    const rim = rimSlab.translate([0, 0, -INSERT_RIM_FIT_MM]);
    rimSlab.delete();
    let pocket = gridPocket.add(rim);
    gridPocket.delete();
    rim.delete();
    if (sleeves) pocket = replace(pocket, pocket.add(sleeves));
    if (landingFoot) {
      const grownLanding = landingFoot.offset(INSERT_CLEARANCE_MM, 'Round');
      const deep = ctx.skinMm + INSERT_CLEARANCE_MM;
      const seat = wasm.Manifold.extrude(grownLanding, deep + ENVELOPE_TOP).translate([0, 0, -deep]);
      grownLanding.delete();
      pocket = replace(pocket, pocket.add(seat));
      seat.delete();
    }
    if (shape !== outer) shape.delete();
    outer.delete();
    shell = block.subtract(pocket);
    face = faceOutline(wasm, pocket);
    pocket.delete();
  } else {
    const cavity = linerReach.add(part);
    shell = block.subtract(cavity);
    face = faceOutline(wasm, cavity);
    cavity.delete();
    const inBlock = block.intersect(linerReach);
    liner = inBlock.subtract(part);
    inBlock.delete();
  }
  const blockFace = faceOutline(wasm, block);
  if (linerReach !== reachWithSleeves) linerReach.delete();
  if (reachWithSleeves !== env) reachWithSleeves.delete();
  landing?.delete();
  landingFoot?.delete();
  sleeves?.delete();
  block.delete();
  env.delete();

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
    cutBoth(channelSolid(wasm, ch, blockHeight));
  }
  for (const cut of features.bores ?? []) {
    for (const tool of boreSolids(wasm, cut)) cutBoth(tool);
  }

  return { shell, liner, face, blockFace, envelope, spans: halfSpans(ctx.field, grid, partingZ, flipped), escapedMm3 };
}

/** Below this, a column whose part stops short of the face counts as touching it, mm. */
const FACE_TOUCH_MM = 0.05;
/**
 * Liner over the part no thicker than this, reaching the face, goes to the
 * other half as a pad, mm. A taller pad would have to fit its pocket with no
 * clearance; a thicker roof is cut off the insert as its own piece instead.
 */
const LIFT_MAX_MM = 1.5;
/** Liner lifted off a cavity stops this far inside the part's outline, so it never shares a wall with it, mm. */
const LIFT_INSET_MM = 0.02;

/** Turns a solid in one half's frame into the other's: the lid's frame is the cavity half's turned over about X. */
const otherHalf = (m: Manifold) => m.rotate([180, 0, 0]);

/** The part's shadow on the face from the half's own side of it (z < 0). */
function halfShadow(wasm: ManifoldToplevel, part: Manifold): CrossSection {
  const side = wasm.Manifold.cube([1e4, 1e4, 1e4], true).translate([0, 0, -5e3]);
  const below = part.intersect(side);
  side.delete();
  const shadow = below.project();
  below.delete();
  return shadow;
}

/**
 * Where this half's liner roofs its cavity right up to the parting face, thin,
 * and the other half has no part to cast there: the columns where the part
 * comes within LIFT_MAX_MM of the face but stops short of it, less the other
 * half's shadow. Printed face up that liner hangs over the casting, and a slicer fills
 * the cavity under it with support. Belonging to the other half instead, it is
 * a pad standing on that half's face. `otherShadow` is in this half's frame.
 */
function roofFootprint(wasm: ManifoldToplevel, part: Manifold, shadow: CrossSection, otherShadow: CrossSection): CrossSection {
  // Only where the part comes within LIFT_MAX_MM of the face.
  const slab = wasm.Manifold.cube([1e4, 1e4, LIFT_MAX_MM], true).translate([0, 0, -LIFT_MAX_MM / 2]);
  const near = part.intersect(slab);
  slab.delete();
  const nearShadow = near.project();
  near.delete();
  const touching = part.slice(-FACE_TOUCH_MM);
  const short = nearShadow.subtract(touching);
  nearShadow.delete();
  touching.delete();
  const free = short.subtract(otherShadow);
  short.delete();
  const inset = free.offset(-LIFT_INSET_MM, 'Miter');
  free.delete();
  // Specks are left where they are.
  const kept = inset.decompose().filter((p) => {
    const keep = p.area() > 0.5;
    if (!keep) p.delete();
    return keep;
  });
  inset.delete();
  const out = kept.length ? wasm.CrossSection.compose(kept) : shadow.subtract(shadow);
  for (const p of kept) p.delete();
  return out;
}

/**
 * Lifts the liner over `footprint` that roofs `from`'s cavity up to the face,
 * and stands it on `to`'s face, turned into `to`'s frame. Only the pieces
 * that reach the face move: liner further down, between the part and a lower
 * one, stays.
 */
function liftRoofs(wasm: ManifoldToplevel, from: HalfPair, to: HalfPair, footprint: CrossSection, blockHeight: number): number {
  if (footprint.isEmpty()) return 0;
  const prism = wasm.Manifold.extrude(footprint, blockHeight + 2).translate([0, 0, -blockHeight - 1]);
  const inside = prism.intersect(from.liner);
  prism.delete();
  const pieces = inside.decompose();
  inside.delete();
  const top = pieces.filter((p) => p.boundingBox().max[2] > -1e-3 && p.volume() > 1e-3);
  const moved = top.length ? wasm.Manifold.compose(top) : null;
  for (const p of pieces) p.delete();
  if (!moved) return 0;
  const volume = moved.volume();
  from.liner = replace(from.liner, from.liner.subtract(moved));
  const turned = otherHalf(moved);
  moved.delete();
  to.liner = replace(to.liner, to.liner.add(turned));
  turned.delete();
  return volume;
}

/** Everything the pour fills in one half: the casting and every channel and bore it runs through, below the face. */
function castSpace(wasm: ManifoldToplevel, part: Manifold, features: HalfFeatures, blockHeight: number): Manifold {
  const side = wasm.Manifold.cube([1e4, 1e4, blockHeight], true).translate([0, 0, -blockHeight / 2]);
  const tools = [part.intersect(side)];
  for (const ch of features.channels) tools.push(channelSolid(wasm, ch, blockHeight));
  for (const cut of features.bores ?? []) tools.push(...boreSolids(wasm, cut));
  const all = wasm.Manifold.union(tools);
  for (const t of tools) t.delete();
  const cast = all.intersect(side);
  all.delete();
  side.delete();
  return cast;
}

/** Heights of the flat faces a solid turns upward, mm, at least `minAreaMm2` each. */
function upwardFlats(m: Manifold, minAreaMm2 = 1): number[] {
  const mesh = m.getMesh();
  const p = mesh.vertProperties;
  const st = mesh.numProp;
  const t = mesh.triVerts;
  const area = new Map<number, number>();
  for (let k = 0; k < t.length; k += 3) {
    const [a, b, c] = [t[k] * st, t[k + 1] * st, t[k + 2] * st];
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12 || nz / len < 0.999) continue;
    const z = Math.round(((p[a + 2] + p[b + 2] + p[c + 2]) / 3) * 100) / 100;
    area.set(z, (area.get(z) ?? 0) + len / 2);
  }
  return [...area].filter(([, a]) => a >= minAreaMm2).map(([z]) => z);
}

/** How far under the face it frees an insert is cut, mm: far under a layer. */
const CUT_UNDER_MM = 0.02;
/** A peg on each cut face of an insert in pieces, into a hole in the piece above, mm. */
const PEG_R = 1.0;
const PEG_TOP_R = 0.8;
const PEG_H = 1.5;
const PEG_HOLE_CLEAR = 0.15;
const PEG_HOLE_DEEP = 1.8;
/** Kept between a peg's hole and the casting, the insert's edge or anything else, mm. */
const PEG_MARGIN = 0.8;
/** Two pegs at least this far apart fix a piece's turn as well as its place, mm. */
const PEG_SPREAD = 6;

/**
 * Pieces of an insert keyed to each other. The holder's pocket alone lets a
 * piece shift by its clearance, a step in the casting at every cut; a pair of
 * pegs on each cut face, in holes in the piece above, holds it. Only where the
 * two pieces meet solid, clear of the casting and their edges, with the piece
 * above deep enough for the hole: a cut too small for even one is left plain.
 * `cuts` are the heights of the cuts, bottom first, one between each pair of
 * `pieces`; the pieces are consumed.
 */
function pegPieces(wasm: ManifoldToplevel, pieces: Manifold[], cuts: number[]): { pieces: Manifold[]; pegs: number } {
  const out = [...pieces];
  let pegs = 0;
  for (let k = 0; k + 1 < out.length && k < cuts.length; k++) {
    const z = cuts[k];
    const below = out[k].slice(z - 0.05);
    const above = out[k + 1].slice(z + 0.05);
    // Solid all the way up the hole and past its end, not only at the cut.
    let solid = below.intersect(above);
    for (const h of [0.5, 1, PEG_HOLE_DEEP, PEG_HOLE_DEEP + PEG_MARGIN]) {
      const at = out[k + 1].slice(z + h);
      solid = replace2(solid, solid.intersect(at));
      at.delete();
    }
    const room = solid.offset(-(PEG_R + PEG_HOLE_CLEAR + PEG_MARGIN), 'Round');
    for (const c of [below, above, solid]) c.delete();
    const spots = room.toPolygons().flat();
    room.delete();
    if (!spots.length) continue;
    // The two spots furthest apart, or one.
    let best: [number, number][] = [spots[0]];
    let far = 0;
    for (let i = 0; i < spots.length; i += Math.max(1, Math.floor(spots.length / 200))) {
      for (let j = i + 1; j < spots.length; j += Math.max(1, Math.floor(spots.length / 200))) {
        const d = Math.hypot(spots[i][0] - spots[j][0], spots[i][1] - spots[j][1]);
        if (d > far) {
          far = d;
          best = [spots[i], spots[j]];
        }
      }
    }
    if (far < PEG_SPREAD) best = [best[0]];
    for (const [x, y] of best) {
      const peg = wasm.Manifold.cylinder(PEG_H + 0.05, PEG_R, PEG_TOP_R, 24, false).translate([x, y, z - 0.05]);
      out[k] = replace(out[k], out[k].add(peg));
      peg.delete();
      const hole = wasm.Manifold.cylinder(PEG_HOLE_DEEP + 0.05, PEG_R + PEG_HOLE_CLEAR, PEG_R + PEG_HOLE_CLEAR, 24, false).translate([x, y, z - 0.05]);
      out[k + 1] = replace(out[k + 1], out[k + 1].subtract(hole));
      hole.delete();
      pegs++;
    }
  }
  return { pieces: out, pegs };
}

/**
 * An insert cut across wherever it would hang over the casting, so each piece
 * prints with that roof's underside on the bed: the roofs are found as a
 * slicer would (unprintableRoofs), and each one that is the top of a flat
 * face of the casting is cut at exactly that face. Pieces bottom first, with
 * the heights they were cut at and whatever roofs no cut could fix.
 */
function splitInsert(wasm: ManifoldToplevel, liner: Manifold, cast: Manifold): { pieces: Manifold[]; cutsMm: number[]; pegs: number; left: CavityRoof[] } {
  const flats = upwardFlats(cast);
  const cuts: number[] = [];
  let pieces: Manifold[] = [liner];
  // The roofs the last round found that no cut could fix.
  let left: CavityRoof[] = [];
  for (let round = 0; round < 8; round++) {
    const fresh: number[] = [];
    left = [];
    for (const piece of pieces) {
      for (const roof of unprintableRoofs(piece, cast)) {
        // The roof starts on the layer above the face it hangs over.
        const face = flats.find((f) => Math.abs(f + roof.depthMm) <= ROOF_LAYER_MM * 0.75);
        // A hair under the face: cut on it, the pieces touch each other along
        // its edges, and no slicer reads a body that does as solid.
        const z = face === undefined ? undefined : Math.round((face - CUT_UNDER_MM) * 1000) / 1000;
        if (z === undefined) left.push(roof);
        else if (!cuts.includes(z) && !fresh.includes(z)) fresh.push(z);
      }
    }
    if (!fresh.length) break;
    cuts.push(...fresh);
    const next: Manifold[] = [];
    for (const piece of pieces) {
      let rest = piece;
      for (const z of [...fresh].sort((a, b) => a - b)) {
        const box = rest.boundingBox();
        if (z <= box.min[2] + 1e-3 || z >= box.max[2] - 1e-3) continue;
        const [above, below] = rest.splitByPlane([0, 0, 1], z);
        if (rest !== liner) rest.delete();
        next.push(withoutCrumbs(wasm, below));
        rest = above;
      }
      next.push(rest === liner ? rest : withoutCrumbs(wasm, rest));
    }
    pieces = next.filter((p) => {
      if (p.isEmpty()) {
        p.delete();
        return false;
      }
      return true;
    });
  }
  cuts.sort((a, b) => a - b);
  pieces.sort((p, q) => p.boundingBox().min[2] - q.boundingBox().min[2]);
  // Pegs stand on a piece's top and go into holes opening on the next one's
  // bed: neither hangs over anything, so what was left stays what is left.
  let pegs = 0;
  if (pieces.length > 1) ({ pieces, pegs } = pegPieces(wasm, pieces, cuts));
  return { pieces, cutsMm: cuts.map((z) => Math.round(-(z + CUT_UNDER_MM) * 100) / 100), pegs, left: left.sort((p, q) => q.areaMm2 - p.areaMm2) };
}

/** Everything the exact-CSG mold build has, plus what the liner needs from the column field. */
export interface LinerContext extends CsgContext {
  field: ColumnField;
  skinMm: number;
  castMaterial: CastMaterialId;
  /** What it is printed in (default PLA + PVA). */
  linerPair?: LinerPairId;
  /** Shell and liner printed together (default), or an insert in a holder. */
  construction?: LinerConstruction;
  /** A tongue and groove round the cavity on a clamshell's shell (default on). */
  sealRidge?: boolean;
}

/**
 * The tongue (in the lid's frame) and the groove (in the cavity half's) that
 * seal a clamshell's seam, or why there is no room for them. The lid's frame is
 * the cavity half's mirrored in Y. The ring goes round both halves' liner, as
 * close as it fits inside the block's edge and clear of every pin, socket and
 * pry notch.
 */
export function sealRing(
  wasm: ManifoldToplevel,
  base: { face: CrossSection; blockFace: CrossSection; features: HalfFeatures },
  lid: { face: CrossSection; blockFace: CrossSection; features: HalfFeatures },
): { groove: CrossSection; tongue: CrossSection } | { error: string } {
  const lidFace = lid.face.mirror([0, 1]);
  const lidBlock = lid.blockFace.mirror([0, 1]);
  const inside = base.face.add(lidFace);
  const blocks = base.blockFace.intersect(lidBlock);
  const allowed = blocks.offset(-SEAL_EDGE_MM, 'Miter');
  lidFace.delete();
  lidBlock.delete();
  blocks.delete();
  const discs: SimplePolygon[] = [];
  const disc = (x: number, y: number, r: number) => {
    const ring: [number, number][] = [];
    for (let k = 0; k < 32; k++) ring.push([x + r * Math.cos((k * Math.PI) / 16), y + r * Math.sin((k * Math.PI) / 16)]);
    discs.push(ring);
  };
  for (const s of base.features.sockets) disc(s.x, s.y, s.rimR + SEAL_PIN_CLEAR_MM);
  for (const p of lid.features.pins) disc(p.x, -p.y, p.baseR + SEAL_PIN_CLEAR_MM);
  const obstacles = new wasm.CrossSection(discs.length ? discs : [[[1e6, 1e6], [1e6 + 1, 1e6], [1e6, 1e6 + 1]]], 'Positive');

  const grooveW = SEAL_TONGUE_W_MM + 2 * SEAL_GROOVE_CLEAR_MM;
  let found: { groove: CrossSection; tongue: CrossSection } | null = null;
  for (const gap of [0.8, 1.2, 1.6, 2.0, 2.5, 3.0]) {
    const inner = inside.offset(gap, 'Round');
    const outer = inside.offset(gap + grooveW, 'Round');
    const groove = outer.subtract(inner);
    inner.delete();
    outer.delete();
    const out = groove.subtract(allowed);
    const hit = groove.intersect(obstacles);
    const fits = out.area() < 1e-3 && hit.area() < 1e-3;
    out.delete();
    hit.delete();
    if (!fits) {
      groove.delete();
      continue;
    }
    const tIn = inside.offset(gap + SEAL_GROOVE_CLEAR_MM, 'Round');
    const tOut = inside.offset(gap + SEAL_GROOVE_CLEAR_MM + SEAL_TONGUE_W_MM, 'Round');
    const tongueBase = tOut.subtract(tIn);
    tIn.delete();
    tOut.delete();
    found = { groove, tongue: tongueBase.mirror([0, 1]) };
    tongueBase.delete();
    break;
  }
  const room = allowed.isEmpty() ? 0 : 1;
  inside.delete();
  allowed.delete();
  obstacles.delete();
  if (found) return found;
  return {
    error: room
      ? `No room for the sealing ridge between the cavity and the pins or the block's edge; a wall margin ${Math.ceil(grooveW + 0.8 + SEAL_EDGE_MM + SEAL_PIN_CLEAR_MM)} mm wider makes room. Tape the seam and clamp it instead.`
      : 'No room for the sealing ridge; tape the seam and clamp it instead.',
  };
}

/** Grams on the lid that the pour, full to the top of the funnel, would lift off: twice that, for margin. */
export function clampGrams(castMaterialId: CastMaterialId, moldWidthMm: number, moldDepthMm: number, headMm: number): number {
  const lift = (castMaterial(castMaterialId).densityGcm3 * moldWidthMm * moldDepthMm * headMm) / 1000;
  return Math.ceil((2 * lift) / 10) * 10;
}

/** What to do with a lined mold, in order: the printing, the release, the clamp, the pour and the dissolving. */
export function linerSteps(o: {
  pair: LinerPair;
  construction: LinerConstruction;
  clamshell: boolean;
  sealed: boolean;
  castLabel: string;
  clampG: number;
  dissolveHours: number;
  thickestMm: number;
  /** Whether any insert still has a roof over the casting that prints only with support (a warning names it). */
  roofsLeft?: boolean;
  /** Inserts cut into pieces (splitInsert): which half, how far below the face each cut is, mm, and the pegs keying them. */
  insertCuts?: Array<{ half: string; cutsMm: number[]; pegs?: number }>;
}): string[] {
  const { pair, construction, clamshell, sealed } = o;
  const insert = construction === 'insert';
  const shell = pair.shell.name;
  const sol = pair.liner.name;
  return [
    insert
      ? `Print the ${clamshell ? 'two holder halves' : 'holder'} in ${shell} and the ${clamshell ? 'two inserts' : 'insert'} in ${sol}, each on its own. Print them parting face up with supports off: nothing in them needs any${o.roofsLeft ? ' but the roof the warnings name, which prints unsupported and a little rough (the slicer calls it a floating region)' : ''}, and support printed inside the cavity would take the casting's place.`
      : `Print with ${shell} on extruder 1 and ${sol} on extruder 2 (already set in the 3MF).`,
    ...(o.insertCuts ?? []).map((c) =>
      `The ${c.half}'s insert comes in ${c.cutsMm.length + 1} pieces, cut ${[...c.cutsMm].sort((a, b) => a - b).join(' and ')} mm below the parting face so that nothing in it hangs over the casting as it prints. ` +
      'Print each piece the way up it lies in the 3MF, the upper ones standing on their flat cut faces, and stack them in the holder from the bottom up' +
      (c.pegs ? ', each on the pegs of the one below.' : '.')),
    ...(insert ? [`Press each insert into its holder${clamshell ? ', and close the halves dry once to check they seat flat' : ''}.`] : []),
    clamshell
      ? `Wipe a thin film of mold release or petroleum jelly over both parting faces${sealed ? ', the sealing ridge and its groove' : ''}, the pins and sockets, and the sprue and vent mouths. The cavity needs none: the ${sol} dissolves.`
      : `Wipe a thin film of mold release or petroleum jelly over the top face and round the rim. The cavity needs none: the ${sol} dissolves.`,
    ...(clamshell
      ? [`Close the halves${sealed ? ' with the tongue in its groove' : ''} and clamp them: binder clips round the edge, or at least ${o.clampG} g on the lid. Once the pour reaches the funnel it can lift a lid that is only taped, and resin gets into the seam.`]
      : []),
    `Pour the ${o.castLabel} slowly into the funnel until it shows at every vent, then leave it to cure.`,
    insert
      ? `Unclamp, lift the holder off and push the ${clamshell ? 'inserts' : 'insert'} out with the casting inside. The holder is reusable.`
      : `Unclamp and lift the ${shell} shell off along the pull. If it holds on, soak it in the solvent for an hour first.`,
    `Dissolve the ${sol} off the casting in ${pair.solvent}: about ${o.dissolveHours} h for its thickest ${o.thickestMm} mm${insert ? ', now that the solvent reaches every side' : ''}. ${pair.dissolveTip}`,
  ];
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
 * The lined mold (a rigid shell, a soluble liner), or the one sentence that says why not. Shares its layout
 * with the exact-CSG mold: halves side by side on the plate, cavity up.
 */
export function buildLinerMold(ctx: LinerContext): MoldExportResult | { error: string } {
  const { wasm, opts, warnings } = ctx;
  const fail = (error: string) => ({ error });

  const { part: rawPart, unsolid } = buildPartManifold(wasm, ctx.tris, ctx.solidIds);
  if (!rawPart) return fail(unsolidPartRefusal(unsolid, ctx.solidNames, 'the liner'));
  const castVolumeMl = rawPart.volume() / 1000;

  const pair: LinerPair = linerPair(ctx.linerPair);
  const material = castMaterialCheck(ctx.castMaterial, castVolumeMl, pair.id);
  if (material.error) {
    rawPart.delete();
    return fail(material.error);
  }
  const notes = [...warnings, ...material.warnings];
  if (opts.baseThicknessMm < ctx.skinMm + MIN_FLOOR_MM) {
    notes.push(
      `The ${opts.baseThicknessMm} mm floor leaves under ${MIN_FLOOR_MM} mm of ${pair.shell.name} below a ${ctx.skinMm} mm liner; ` +
      `a floor of ${Math.ceil((ctx.skinMm + MIN_FLOOR_MM + 1) * 10) / 10} mm or more keeps the shell stiff.`
    );
  }

  const clamshell = opts.moldType === 'clamshell';
  const basePart = halfPart(ctx, rawPart, ctx.detailIsAbove, ctx.rawBaseDepth);
  const lidPart = clamshell ? halfPart(ctx, rawPart, !ctx.detailIsAbove, ctx.rawLidDepth) : null;
  rawPart.delete();
  // Liner roofing one half's cavity up to the face goes to the other half, so
  // that neither prints with liner hanging over the casting (roofFootprint).
  let baseRoof: CrossSection | null = null;
  let lidRoof: CrossSection | null = null;
  if (lidPart && !ctx.lidIsBackingPlate) {
    const baseShadow = halfShadow(wasm, basePart);
    const lidShadow = halfShadow(wasm, lidPart);
    const lidInBase = lidShadow.mirror([0, 1]);
    const baseInLid = baseShadow.mirror([0, 1]);
    baseRoof = roofFootprint(wasm, basePart, baseShadow, lidInBase);
    lidRoof = roofFootprint(wasm, lidPart, lidShadow, baseInLid);
    for (const c of [baseShadow, lidShadow, lidInBase, baseInLid]) c.delete();
  }
  // Each half's face is liner, a skin deep, wherever the other half's part
  // meets the face: a part standing on the parting plane has nothing of it in
  // this half, so no envelope here, and the casting's face would lie on the
  // shell (or on an insert's clearance, which the resin then fills). And
  // wherever liner lifted off the other half lands.
  const landingFor = (roof: CrossSection | null, otherPart: Manifold | null) => {
    if (!otherPart || ctx.lidIsBackingPlate) return null;
    const touch = otherPart.slice(-FACE_TOUCH_MM);
    const both = roof ? touch.add(roof) : touch;
    if (both !== touch) touch.delete();
    const turned = both.mirror([0, 1]);
    both.delete();
    return turned;
  };
  const baseLanding = landingFor(lidRoof, lidPart);
  const lidLanding = landingFor(baseRoof, basePart);
  const base = buildHalfPair(ctx, basePart, ctx.detailIsAbove, ctx.rawBaseDepth, ctx.baseBlockHeight, ctx.baseFeatures, ctx.outlines?.base, baseLanding);
  const lid = lidPart
    ? buildHalfPair(ctx, lidPart, !ctx.detailIsAbove, ctx.rawLidDepth, ctx.lidBlockHeight, ctx.lidFeatures, ctx.outlines?.lid, lidLanding)
    : null;
  baseLanding?.delete();
  lidLanding?.delete();
  if (lid && baseRoof && lidRoof) {
    liftRoofs(wasm, base, lid, baseRoof, ctx.baseBlockHeight);
    liftRoofs(wasm, lid, base, lidRoof, ctx.lidBlockHeight);
  }
  baseRoof?.delete();
  lidRoof?.delete();

  const construction: LinerConstruction = ctx.construction ?? 'combined';
  let sealed = false;
  if (lid && ctx.sealRidge !== false) {
    const ring = sealRing(
      wasm,
      { face: base.face, blockFace: base.blockFace, features: ctx.baseFeatures },
      { face: lid.face, blockFace: lid.blockFace, features: ctx.lidFeatures },
    );
    if ('error' in ring) {
      notes.push(ring.error);
    } else {
      const groove = wasm.Manifold.extrude(ring.groove, SEAL_GROOVE_D_MM + 0.5).translate([0, 0, -SEAL_GROOVE_D_MM]);
      base.shell = replace(base.shell, base.shell.subtract(groove));
      groove.delete();
      const tongue = wasm.Manifold.extrude(ring.tongue, SEAL_TONGUE_H_MM + 0.5).translate([0, 0, -0.5]);
      lid.shell = replace(lid.shell, lid.shell.add(tongue));
      tongue.delete();
      ring.groove.delete();
      ring.tongue.delete();
      sealed = true;
    }
  }
  const halves = lid ? [base, lid] : [base];
  for (const h of halves) {
    h.face.delete();
    h.blockFace.delete();
    h.shell = withoutCrumbs(wasm, h.shell);
    h.liner = withoutCrumbs(wasm, h.liner);
  }
  // Nothing may hang over the casting as it prints: a slicer supports it, and
  // support printed in the cavity takes the casting's place. An insert is cut
  // into pieces at the faces it would hang over; a combined half cannot be.
  const halfParts = lidPart ? [basePart, lidPart] : [basePart];
  const halfFeatures = lid ? [ctx.baseFeatures, ctx.lidFeatures] : [ctx.baseFeatures];
  const halfHeights = lid ? [ctx.baseBlockHeight, ctx.lidBlockHeight] : [ctx.baseBlockHeight];
  const roofNames = lid ? ['cavity half', 'lid'] : ['mold'];
  const insertCuts: Array<{ half: string; cutsMm: number[]; pegs: number }> = [];
  let roofsLeft = false;
  halves.forEach((h, i) => {
    const cast = castSpace(wasm, halfParts[i], halfFeatures[i], halfHeights[i]);
    let left: CavityRoof[];
    if (construction === 'insert') {
      const split = splitInsert(wasm, h.liner, cast);
      if (split.cutsMm.length) {
        h.pieces = split.pieces;
        insertCuts.push({ half: roofNames[i], cutsMm: split.cutsMm, pegs: split.pegs });
      } else {
        for (const p of split.pieces) if (p !== h.liner) p.delete();
      }
      left = split.left;
    } else {
      const body = h.shell.add(h.liner);
      left = unprintableRoofs(body, cast);
      body.delete();
    }
    cast.delete();
    if (!left.length) return;
    roofsLeft = true;
    const total = Math.round(left.reduce((sum, r) => sum + r.areaMm2, 0));
    const at = left[0].depthMm;
    // The last resort: support in a filament the liner survives the solvent of, washed out before the pour.
    const support = pair.waterSoluble
      ? 'HIPS, and soak it out in d-limonene before the pour (the PVA-type liner does not mind limonene)'
      : `PVA, and wash it out in warm water before the pour (the ${pair.liner.name} does not mind water), then let it dry right through: water left in the cavity spoils epoxy`;
    notes.push(
      construction === 'insert'
        ? `The ${roofNames[i]}'s insert still has ${total} mm² of ${pair.liner.name} hanging over the casting, most of it ${at} mm below the parting face, ` +
          'where it is sloped or curved rather than flat, so no cut can put it on the bed. A slicer supports that, and support printed in the cavity takes the casting\'s place. ' +
          `Try another Pull Direction first: turned so that face runs along the pull, the mold may have none. As a last resort, print the insert with its supports in ${support}.`
        : `The ${roofNames[i]}'s liner has ${total} mm² of ${pair.liner.name} hanging over the casting, most of it ${at} mm below the parting face. ` +
          'Printed in one piece with the shell it needs support there, and support printed in the cavity takes the casting\'s place. ' +
          'Print it as Holder + insert, which cuts the insert into pieces that print without it where the roof is flat, or try another Pull Direction.'
    );
  });
  for (const p of halfParts) p.delete();
  const escaped = halves.reduce((sum, h) => sum + h.escapedMm3, 0);
  if (escaped > castVolumeMl * 1000 * 0.002) {
    notes.push(
      `${Math.round(escaped)} mm³ of the part reaches past the liner onto the ${pair.shell.name}, where a feature is finer than ` +
      'the mold grid; the shell may grip the casting there.'
    );
  }

  const plateGapMm = 6;
  const plateOffset = lid ? ctx.moldWidthMm / 2 + plateGapMm / 2 : 0;
  const placed = (h: HalfPair, x: number, lift: number) => {
    const shell = h.shell.translate([x, 0, lift]);
    const liner = h.liner.translate([x, 0, lift]);
    const pieces = h.pieces?.map((p) => {
      const moved = p.translate([x, 0, lift]);
      p.delete();
      return moved;
    });
    h.shell.delete();
    h.liner.delete();
    return { shell, liner, pieces };
  };
  const basePlaced = placed(base, -plateOffset, ctx.baseBlockHeight);
  const lidPlaced = lid ? placed(lid, plateOffset, ctx.lidBlockHeight) : null;
  const all = lidPlaced ? [basePlaced, lidPlaced] : [basePlaced];

  const pvaVolumeMm3 = all.reduce((s, h) => s + h.liner.volume(), 0);
  const plaVolumeMm3 = all.reduce((s, h) => s + h.shell.volume(), 0);
  const thickest = Math.max(...halves.map((h) => thickestPvaMm(h.envelope, h.spans, ctx.grid)));
  const dissolveHours = Math.max(1, Math.ceil(thickest / pair.dissolveMmPerHour));

  const names = lid ? ['Cavity half', 'Lid half'] : ['Open mold'];
  const insertGapMm = 10;
  const assemblies: ThreeMfAssembly[] = construction === 'insert'
    // Four separate prints: the holders in a row, the inserts in a row in front of them.
    ? [
        ...all.map((h, i) => ({ name: `${names[i]} holder`, parts: [meshPart(h.shell, `${names[i]} holder (${pair.shell.name})`, 1)] })),
        ...all.flatMap((h, i) => {
          if (!h.pieces) {
            const moved = h.liner.translate([0, -(ctx.moldDepthMm + insertGapMm), 0]);
            const part = meshPart(moved, `${names[i]} insert (${pair.liner.name})`, 2);
            moved.delete();
            return [{ name: `${names[i]} insert`, parts: [part] }];
          }
          // Each piece on its own bottom face, in a row going away from the holders.
          let top = -ctx.moldDepthMm / 2 - insertGapMm;
          return h.pieces.map((p, k) => {
            const box = p.boundingBox();
            const moved = p.translate([0, top - box.max[1], -box.min[2]]);
            top -= box.max[1] - box.min[1] + insertGapMm;
            const label = `${names[i]} insert, piece ${k + 1} of ${h.pieces!.length}${k === 0 ? ' (bottom)' : k === h.pieces!.length - 1 ? ' (top)' : ''}`;
            const part = meshPart(moved, `${label} (${pair.liner.name})`, 2);
            moved.delete();
            return { name: label, parts: [part] };
          });
        }),
      ]
    : all.map((h, i) => ({
        name: names[i],
        parts: [meshPart(h.shell, `${names[i]} shell (${pair.shell.name})`, 1), meshPart(h.liner, `${names[i]} liner (${pair.liner.name})`, 2)],
      }));

  const halfOf = (h: { shell: Manifold; liner: Manifold; pieces?: Manifold[] }, name: string, blockHeight: number, pinRise: number): MoldMeshHalf => {
    const shell = manifoldToTriangles(h.shell);
    // An insert in pieces is listed piece by piece, so each is a part of its own.
    const pieceTris = h.pieces?.map((p) => manifoldToTriangles(p));
    const liner = pieceTris ? pieceTris.flat() : manifoldToTriangles(h.liner);
    const triangles = [...shell, ...liner];
    return {
      name,
      triangles,
      liner: { shell, liner, ...(pieceTris ? { pieceTriangles: pieceTris.map((t) => t.length) } : {}) },
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
    for (const p of h.pieces ?? []) p.delete();
  }

  const combinedTriangles = topHalf ? [...bottomHalf.triangles, ...topHalf.triangles] : bottomHalf.triangles;
  let stlBytes: Uint8Array | null = null;
  let threeMfBytes: Uint8Array | null = null;
  const totalWidth = lid ? ctx.moldWidthMm * 2 + plateGapMm : ctx.moldWidthMm;
  const totalHeight = Math.max(ctx.baseBlockHeight, lid ? ctx.lidBlockHeight + opts.pinHeightMm : 0);

  const thickR = Math.round(thickest * 10) / 10;
  const clampG = lid ? clampGrams(ctx.castMaterial, ctx.moldWidthMm, ctx.moldDepthMm, ctx.lidBlockHeight) : undefined;
  const liner: MoldLinerInfo = {
    pair: pair.id,
    shellMaterial: pair.shell.name,
    linerMaterial: pair.liner.name,
    solvent: pair.solvent,
    skinMm: ctx.skinMm,
    castMaterial: ctx.castMaterial,
    linerVolumeMm3: Math.round(pvaVolumeMm3),
    linerGrams: Math.round((pvaVolumeMm3 / 1000) * pair.liner.densityGcm3 * 10) / 10,
    shellVolumeMm3: Math.round(plaVolumeMm3),
    shellGrams: Math.round((plaVolumeMm3 / 1000) * pair.shell.densityGcm3 * 10) / 10,
    castVolumeMl: Math.round(castVolumeMl * 10) / 10,
    thickestLinerMm: thickR,
    dissolveHours,
    construction,
    sealRidge: sealed,
    ...(clampG !== undefined ? { clampGrams: clampG } : {}),
    steps: linerSteps({
      pair,
      construction,
      clamshell: Boolean(lid),
      sealed,
      castLabel: castMaterial(ctx.castMaterial).label.toLowerCase(),
      clampG: clampG ?? 0,
      dissolveHours,
      thickestMm: thickR,
      ...(insertCuts.length ? { insertCuts } : {}),
      ...(roofsLeft ? { roofsLeft } : {}),
    }),
  };

  return {
    success: true,
    ...ctx.setup,
    get binarySTL() {
      if (!stlBytes) stlBytes = exportBinarySTL(combinedTriangles, `PhysBox 3D Mold Plate (${pair.label})`);
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
