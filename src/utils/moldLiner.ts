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
import { unprintableRoofs, ROOF_LAYER_MM, ROOF_REACH_MM, type CavityRoof } from './moldRoofs';
import { DEFAULT_PRINTER, printLimits } from './printLimits';
import { packOnBed } from './printPlate';

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
 * The deepest soluble liner lies from a face solvent can reach.
 *
 * In `'insert'` mode the reusable holder lifts straight off, exposing the
 * insert's floor, side walls and parting face to solvent (`OPEN = 0`).
 * In `'combined'` mode, when the rigid shell is mechanically locked onto the
 * cured casting (undercuts, buried bottom-fill runner, or reverse-tapered
 * sprue/vent cones), the waterproof shell blocks the floor and side walls so
 * solvent only enters from the open parting face (`z = 0`) and travels through
 * the liner alone.
 */
export function thickestPvaMm(
  envelope: Float64Array,
  spans: Float64Array[],
  grid: Grid,
  construction: LinerConstruction = 'insert',
): number {
  const { stepX, stepY } = grid;
  const shellBlocks = construction === 'combined';
  // Only the envelope's own footprint, one column round it.
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
  const dz = Math.max(maxDepth / 160, Math.min(stepX, stepY, 0.6));
  const layers = Math.max(1, Math.ceil(maxDepth / dz));
  const plane = cols * rows;

  const OPEN = 0;
  const PART = -1;
  const dist = new Float32Array(plane * layers);
  let hasLiner = false;
  for (let i = 0; i < plane; i++) {
    const src = (r0 + Math.floor(i / cols)) * grid.cols + c0 + (i % cols);
    const env = envelope[src];
    const sp = spans[src];
    for (let k = 0; k < layers; k++) {
      const z = -(k + 0.5) * dz;
      let value: number = shellBlocks ? PART : OPEN;
      if (env > 0 && z >= -env) {
        value = Infinity;
        for (let s = 0; s + 1 < sp.length; s += 2) {
          if (z >= sp[s] && z <= sp[s + 1]) {
            value = PART;
            break;
          }
        }
        if (value === Infinity) hasLiner = true;
      }
      dist[k * plane + i] = value;
    }
  }
  if (!hasLiner) return 0;

  const dcArr: number[] = [];
  const drArr: number[] = [];
  const dkArr: number[] = [];
  const wArr: number[] = [];
  for (let dk = -1; dk <= 1; dk++) {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const before = dk < 0 || (dk === 0 && (dr < 0 || (dr === 0 && dc < 0)));
        if (before) {
          dcArr.push(dc);
          drArr.push(dr);
          dkArr.push(dk);
          wArr.push(Math.hypot(dc * stepX, dr * stepY, dk * dz));
        }
      }
    }
  }
  const nNbr = dcArr.length;
  const sweep = (sign: 1 | -1): number => {
    let maxDelta = 0;
    const start = sign > 0 ? 0 : plane * layers - 1;
    for (let idx = start, step = 0; step < plane * layers; step++, idx += sign) {
      const here = dist[idx];
      if (here === PART || here === OPEN) continue;
      const k = Math.floor(idx / plane);
      const rem = idx - k * plane;
      const r = Math.floor(rem / cols);
      const c = rem - r * cols;
      let best = here;
      for (let n = 0; n < nNbr; n++) {
        const cc = c + dcArr[n] * sign;
        const rr = r + drArr[n] * sign;
        const kk = k + dkArr[n] * sign;
        let d: number;
        if (kk < 0) {
          d = OPEN;
        } else if (cc < 0 || rr < 0 || cc >= cols || rr >= rows || kk >= layers) {
          d = shellBlocks ? PART : OPEN;
        } else {
          d = dist[kk * plane + rr * cols + cc];
        }
        if (d === PART) continue;
        const cand = d + wArr[n];
        if (cand < best) best = cand;
      }
      if (best < here) {
        const delta = Number.isFinite(here) ? here - best : 1e6;
        if (delta > maxDelta) maxDelta = delta;
        dist[idx] = best;
      }
    }
    return maxDelta;
  };
  const maxPasses = shellBlocks ? 12 : 3;
  for (let pass = 0; pass < maxPasses; pass++) {
    const d1 = sweep(1);
    const d2 = sweep(-1);
    if (Math.max(d1, d2) < 0.02) break;
  }

  let thickest = 0;
  for (let i = 0; i < dist.length; i++) {
    const d = dist[i];
    if (d > 0 && Number.isFinite(d) && d > thickest) thickest = d;
  }
  return thickest > 0 ? thickest : maxDepth;
}

const flipAbout = (z: number): Mat4Tuple => [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, z, 1];

function replace(prev: Manifold, next: Manifold): Manifold {
  next.numTri();
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
 * An insert's depth field taken down to one flat base: every column of the
 * insert's footprint goes as deep as its deepest, so printed parting face up
 * it stands on the bed by its whole outline. A 45° self-supporting underside
 * needed no support, but on a part with an uneven underside (a gear
 * sculpture) it built a cup 17 mm tall on a few feet a fifth of its width,
 * and in HIPS the nozzle knocked it off the bed every time. In a half a
 * channel goes right through (a lid's sprue and vents), the base is the
 * block's back: the insert goes through its holder, which keeps it by its
 * sides, and the clamping presses on it. Only ever deeper, and only under the insert.
 */
export function flatBase(depth: Float64Array, blockHeight: number): Float64Array {
  let deepest = 0;
  for (const d of depth) if (d > deepest) deepest = Math.min(d, blockHeight);
  if (!(deepest > 0)) return depth;
  return depth.map((d) => (d > 0 ? Math.max(d, deepest) : d));
}

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
  return outer.length ? new wasm.CrossSection(outer, 'Positive') : m.slice(m.boundingBox().max[2] + 10);
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

function circlePoly(x: number, y: number, r: number, segs = 48): SimplePolygon {
  const ring: [number, number][] = [];
  for (let k = 0; k < segs; k++) {
    const a = (2 * Math.PI * k) / segs;
    ring.push([x + r * Math.cos(a), y + r * Math.sin(a)]);
  }
  return ring;
}

function barPoly(ax: number, ay: number, bx: number, by: number, halfW: number): SimplePolygon | null {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  const nx = (-dy / len) * halfW;
  const ny = (dx / len) * halfW;
  return [
    [ax + nx, ay + ny],
    [ax - nx, ay - ny],
    [bx - nx, by - ny],
    [bx + nx, by + ny],
  ];
}

/**
 * Carries any flat upward face of `part` that lies on the parting plane
 * (|z| < 0.01 mm) up through z = 0, so float32 rounding never leaves a
 * sub-micron sheet of liner across the cavity mouth when `part` is subtracted
 * from the block. Curved surfaces crossing z = 0 are left alone.
 */
function carryPartingFlats(wasm: ManifoldToplevel, part: Manifold): Manifold {
  const mesh = part.getMesh();
  const p = mesh.vertProperties;
  const st = mesh.numProp;
  const t = mesh.triVerts;
  const polys: SimplePolygon[] = [];
  for (let k = 0; k < t.length; k += 3) {
    const [a, b, c] = [t[k] * st, t[k + 1] * st, t[k + 2] * st];
    const z = (p[a + 2] + p[b + 2] + p[c + 2]) / 3;
    if (Math.abs(z) > FACE_TOUCH_MM) continue;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-12 && nz / len > 0.999) {
      polys.push([[p[a], p[a + 1]], [p[b], p[b + 1]], [p[c], p[c + 1]]]);
    }
  }
  if (!polys.length) return part;
  const cs = new wasm.CrossSection(polys, 'Positive');
  if (cs.isEmpty()) {
    cs.delete();
    return part;
  }
  const plug = wasm.Manifold.extrude(cs, 0.5 + FACE_TOUCH_MM + 0.02).translate([0, 0, -(FACE_TOUCH_MM + 0.02)]);
  cs.delete();
  const out = part.add(plug);
  out.numTri();
  plug.delete();
  return replace(part, out);
}

/**
 * The part in one half's own frame (cavity below z = 0), as that half's mold
 * casts it: drafted, and carried up through the face where it ends on it.
 */
function halfPart(
  ctx: LinerContext,
  rawPart: Manifold,
  flipped: boolean,
  rawDepth: Float64Array,
  isBackingLid = false,
): Manifold {
  const { wasm, grid, partingZ } = ctx;
  let part = flipped ? rawPart.transform(flipAbout(partingZ)) : rawPart.translate([0, 0, -partingZ]);
  if (isBackingLid) {
    // A backing-plate lid has zero cavity below z = 0; lift it clear of the
    // parting plane so coplanar float32 facets never dent the lid's landing pad.
    return replace(part, part.translate([0, 0, 0.05]));
  }
  if (ctx.opts.moldType !== 'open') {
    part = carryPartingFlats(wasm, part);
  }
  // The casting as the draft leaves it; the shell's envelope then has to hold
  // both it and the undrafted part, whichever reaches further.
  const { draftAngleDeg, draftMode } = ctx.opts;
  const drafted = draftPart(wasm, part, grid, rawDepth, draftAngleDeg, draftMode);
  if (drafted !== part) part = replace(part, drafted);
  if (ctx.opts.moldType === 'open') {
    // Here the part ends exactly on the block's face, and a solid cut by
    // another that shares its face is left with a sheet of nothing there. So
    // the part's outline at the face is carried up through it, as the exact
    // open mold does.
    part = withPourMouth(wasm, part, sprueNeckDiaMm(ctx.opts.sprueBottomDiaMm, ctx.castMaterial));
  } else if (ctx.lidIsBackingPlate) {
    const above = part.slice(0.01);
    const needsMouth = above.isEmpty();
    above.delete();
    if (needsMouth) part = withPourMouth(wasm, part, 0);
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
    const floorLimit = Math.max(ctx.skinMm, blockHeight - MIN_FLOOR_MM - INSERT_CLEARANCE_MM);
    const nonThrough = sleeveColumnDepth({ ...features, channels: [] }, grid, blockHeight, ctx.skinMm);
    const cavityRaw = envelope.map((d, i) => Math.min(floorLimit, Math.max(d, nonThrough[i])));
    if (landingFoot) stampFootprint(cavityRaw, grid, landingFoot, Math.min(floorLimit, ctx.skinMm));

    let boreFoot: CrossSection | null = null;
    if (features.bores?.length) {
      const boreTools: Manifold[] = [];
      for (const cut of features.bores) {
        const grown: BoreCut = { ...cut, r: cut.r + ctx.skinMm, ...(cut.rB !== undefined ? { rB: cut.rB + ctx.skinMm } : {}), fluted: false, ends: true };
        boreTools.push(...boreSolids(wasm, grown));
      }
      if (boreTools.length) {
        const boreUnion = wasm.Manifold.union(boreTools);
        for (const t of boreTools) t.delete();
        const boreClipped = boreUnion.intersect(block);
        boreUnion.delete();
        const boreMinZ = boreClipped.boundingBox().min[2];
        boreFoot = boreClipped.project();
        boreClipped.delete();
        if (!boreFoot.isEmpty() && boreMinZ < 0) {
          stampFootprint(cavityRaw, grid, boreFoot, Math.min(floorLimit, -boreMinZ));
        }
      }
    }

    if (features.channels.length > 0) {
      // Through-channel half (clamshell lid): take the insert's base flush to
      // z = -blockHeight as ONE flat-backed piece so sprue and vent bores stay
      // continuously sleeved without an unsealed floorCutZ cut, while a 45°
      // beveled back shoulder seats against a captive retaining lip on the
      // holder so the insert cannot push or fall out the back.
      // Clamp the cavity envelope at least `minInsertBackMm` short of the outer
      // back face (`-blockHeight`) so subtracting `part` never punches through
      // the insert's first-layer bed floor into isolated pillar islands.
      const minInsertBackMm = Math.max(1.2, ctx.skinMm);
      const lidFloorLimit = Math.max(ctx.skinMm, blockHeight - minInsertBackMm);
      const lidPart = (() => {
        const partMinZ = part.boundingBox().min[2];
        if (partMinZ >= -lidFloorLimit - 1e-4) return part;
        const keepBox = wasm.Manifold.cube(
          [moldWidthMm * 4, moldDepthMm * 4, lidFloorLimit + ENVELOPE_TOP + 2],
          false,
        ).translate([-moldWidthMm * 2, -moldDepthMm * 2, -lidFloorLimit]);
        const clamped = part.intersect(keepBox);
        clamped.numTri();
        keepBox.delete();
        return clamped;
      })();

      let bodyCs: CrossSection;
      if (cavityRaw.some((d) => d > 0)) {
        const fullDepth = cavityRaw.map((d) => (d > 0 ? blockHeight : 0));
        const gridCol = envelopeSolid(wasm, grid, fullDepth);
        bodyCs = gridCol.slice(-0.05);
        gridCol.delete();
      } else {
        bodyCs = new wasm.CrossSection([]);
      }
      if (boreFoot && !boreFoot.isEmpty()) bodyCs = replace2(bodyCs, bodyCs.add(boreFoot));
      if (landingFoot && !landingFoot.isEmpty()) bodyCs = replace2(bodyCs, bodyCs.add(landingFoot));
      if (!bodyCs.isEmpty()) {
        const outerBody = bodyCs.toPolygons().filter((p) => contourArea(p) > 0);
        if (outerBody.length) bodyCs = replace2(bodyCs, new wasm.CrossSection(outerBody, 'Positive'));
      }

      const chPolys: SimplePolygon[] = features.channels.map((ch) =>
        circlePoly(ch.x, ch.y, Math.max(ch.outerR, ch.innerR) + ctx.skinMm, 48),
      );
      const channelCs = new wasm.CrossSection(chPolys, 'Positive');
      let topCs = bodyCs.isEmpty() ? channelCs.offset(0, 'Round') : bodyCs.add(channelCs);
      {
        const outerTop = topCs.toPolygons().filter((p) => contourArea(p) > 0);
        if (outerTop.length) topCs = replace2(topCs, new wasm.CrossSection(outerTop, 'Positive'));
      }

      // Connect any flange channel island to the main insert body so the lid
      // insert prints and seats as one monolithic captive piece.
      let bridgesCs: CrossSection | null = null;
      const islands = topCs.decompose().sort((a, b) => b.area() - a.area());
      if (islands.length > 1) {
        const mb = islands[0].bounds();
        const mcx = (mb.min[0] + mb.max[0]) / 2;
        const mcy = (mb.min[1] + mb.max[1]) / 2;
        const mainVerts = islands[0].toPolygons().flat();
        const barPolys: SimplePolygon[] = [];
        for (let idx = 1; idx < islands.length; idx++) {
          const b = islands[idx].bounds();
          const cx = (b.min[0] + b.max[0]) / 2;
          const cy = (b.min[1] + b.max[1]) / 2;
          let bestV: [number, number] = mainVerts[0] ?? [mcx, mcy];
          let bestD = Infinity;
          for (const v of mainVerts) {
            const d = Math.hypot(v[0] - cx, v[1] - cy);
            if (d < bestD) {
              bestD = d;
              bestV = v;
            }
          }
          const dx = bestV[0] - cx;
          const dy = bestV[1] - cy;
          const len = Math.hypot(dx, dy) || 1;
          const tx = bestV[0] + (dx / len) * 1.5;
          const ty = bestV[1] + (dy / len) * 1.5;
          const hw = Math.max(1.5, ctx.skinMm);
          const bar = barPoly(cx, cy, tx, ty, hw);
          if (bar) barPolys.push(bar);
          barPolys.push(circlePoly(cx, cy, hw, 24));
          barPolys.push(circlePoly(tx, ty, hw, 24));
        }
        if (barPolys.length) {
          let rawBridge = new wasm.CrossSection(barPolys, 'Positive');
          if (features.pins.length > 0) {
            const pinKeepout = new wasm.CrossSection(
              features.pins.map((p) => circlePoly(p.x, p.y, p.baseR + INSERT_CLEARANCE_MM + 0.6, 32)),
              'Positive',
            );
            rawBridge = replace2(rawBridge, rawBridge.subtract(pinKeepout));
            pinKeepout.delete();
          }
          if (!rawBridge.isEmpty()) {
            bridgesCs = rawBridge;
            topCs = replace2(topCs, topCs.add(bridgesCs));
          } else {
            rawBridge.delete();
          }
        }
      }
      for (const isl of islands) isl.delete();

      const lipMm = Math.min(1.5, Math.max(0, blockHeight - ctx.skinMm - 1.0));
      let botCs: CrossSection;
      if (lipMm >= 0.6 && !bodyCs.isEmpty()) {
        const eroded = bodyCs.offset(-lipMm, 'Round');
        if (!eroded.isEmpty()) {
          botCs = eroded.add(channelCs);
          eroded.delete();
          if (bridgesCs) botCs = replace2(botCs, botCs.add(bridgesCs));
          botCs = replace2(botCs, botCs.intersect(topCs));
        } else {
          eroded.delete();
          botCs = topCs.offset(0, 'Round');
        }
      } else {
        botCs = topCs.offset(0, 'Round');
      }
      // Drop any sub-12 mm² corner specks on the bottom face so every first-layer
      // island on the bed is wide and stable, and fill any interior holes.
      {
        const keptBot: SimplePolygon[] = [];
        for (const comp of botCs.decompose()) {
          if (comp.area() >= 12) {
            for (const poly of comp.toPolygons()) {
              if (contourArea(poly) > 0) keptBot.push(poly);
            }
          }
          comp.delete();
        }
        if (keptBot.length) botCs = replace2(botCs, new wasm.CrossSection(keptBot, 'Positive').intersect(topCs));
      }

      const shapeParts: Manifold[] = [];
      const pocketParts: Manifold[] = [];
      const pocketTop = topCs.offset(INSERT_CLEARANCE_MM, 'Round');

      if (lipMm >= 0.6) {
        const nSteps = Math.max(4, Math.ceil(lipMm / 0.15));
        for (let s = 0; s < nSteps; s++) {
          const z0 = -blockHeight + (s * lipMm) / nSteps;
          // At s > 0, `botCs.offset(...)` rounded over a concave corner of `topCs`
          // can nick off disconnected sub-nozzle corner slivers against `topCs`
          // right on layer 2 (z = 0.15 mm on the bed); prune any < 12 mm² islands.
          let cs = s === 0
            ? botCs.offset(0, 'Round')
            : botCs.offset((s * lipMm) / nSteps, 'Round').intersect(topCs);
          if (s > 0 && !cs.isEmpty()) {
            const keptStep: SimplePolygon[] = [];
            for (const comp of cs.decompose()) {
              if (comp.area() >= 12) {
                for (const poly of comp.toPolygons()) {
                  if (contourArea(poly) > 0) keptStep.push(poly);
                }
              }
              comp.delete();
            }
            if (keptStep.length) cs = replace2(cs, new wasm.CrossSection(keptStep, 'Positive').intersect(topCs));
          }
          if (!cs.isEmpty()) {
            shapeParts.push(wasm.Manifold.extrude(cs, ENVELOPE_TOP - z0).translate([0, 0, z0]));
          }
          cs.delete();
        }
        const zTop0 = -blockHeight + lipMm;
        shapeParts.push(wasm.Manifold.extrude(topCs, ENVELOPE_TOP - zTop0).translate([0, 0, zTop0]));

        const backClear = INSERT_CLEARANCE_MM + 0.20;
        const p0 = botCs.offset(backClear, 'Round').intersect(pocketTop);
        if (!p0.isEmpty()) {
          pocketParts.push(wasm.Manifold.extrude(p0, blockHeight + 2 + ENVELOPE_TOP).translate([0, 0, -blockHeight - 2]));
        }
        p0.delete();
        const pocketSpanZ = Math.max(0.1, lipMm - 0.30);
        for (let s = 1; s < nSteps; s++) {
          const frac = s / nSteps;
          const z0 = -blockHeight + frac * pocketSpanZ;
          const off = backClear + frac * (lipMm + INSERT_CLEARANCE_MM - backClear);
          const ps = botCs.offset(off, 'Round').intersect(pocketTop);
          if (!ps.isEmpty()) {
            pocketParts.push(wasm.Manifold.extrude(ps, ENVELOPE_TOP - z0).translate([0, 0, z0]));
          }
          ps.delete();
        }
        const zPocketTop = -blockHeight + pocketSpanZ;
        pocketParts.push(wasm.Manifold.extrude(pocketTop, ENVELOPE_TOP - zPocketTop).translate([0, 0, zPocketTop]));
      } else {
        shapeParts.push(wasm.Manifold.extrude(topCs, blockHeight + ENVELOPE_TOP).translate([0, 0, -blockHeight]));
        pocketParts.push(wasm.Manifold.extrude(pocketTop, blockHeight + 2 + ENVELOPE_TOP).translate([0, 0, -blockHeight - 2]));
      }
      // Do NOT union raw full-depth `sleeves` onto `shapeParts` here: `topCs`
      // already encloses every channel's outer sleeve radius at the parting face,
      // and raw `sleeves` extend vertically to `z = -blockHeight` outside `botCs`,
      // which defeated the 45° captive back shoulder around vents near the rim;
      // only blind `topVents` and `bores` (if any) need explicit sleeve tools.
      for (const v of features.topVents ?? []) {
        if (v.zRoof < -0.1 && v.zRoof > -blockHeight + 0.5) {
          const zSleeve = v.zRoof - 0.3 - ctx.skinMm;
          shapeParts.push(
            wasm.Manifold.cylinder(1.0 - zSleeve, v.r + ctx.skinMm, v.r + ctx.skinMm, 24, false).translate([v.x, v.y, zSleeve]),
          );
          const z0 = zSleeve - INSERT_CLEARANCE_MM;
          const rClear = v.r + ctx.skinMm + INSERT_CLEARANCE_MM;
          pocketParts.push(
            wasm.Manifold.cylinder(1.0 - z0 + ENVELOPE_TOP, rClear, rClear, 32, false).translate([v.x, v.y, z0]),
          );
        }
      }

      const shape = shapeParts.length > 1
        ? wasm.Manifold.union(shapeParts)
        : shapeParts[0] ?? wasm.Manifold.cube([0, 0, 0]);
      shape.numTri();
      for (const sp of shapeParts) {
        if (sp !== shape) sp.delete();
      }
      const inBlock = shape.intersect(block);
      inBlock.numTri();
      shape.delete();
      liner = inBlock.subtract(lidPart);
      liner.numTri();
      if (lidPart !== part) lidPart.delete();
      inBlock.delete();

      const pocket = pocketParts.length === 1 ? pocketParts[0] : wasm.Manifold.union(pocketParts);
      pocket.numTri();
      if (pocketParts.length > 1) for (const p of pocketParts) p.delete();
      shell = block.subtract(pocket);
      shell.numTri();
      face = faceOutline(wasm, pocket);
      pocket.delete();

      pocketTop.delete();
      botCs.delete();
      topCs.delete();
      channelCs.delete();
      bodyCs.delete();
      bridgesCs?.delete();
      boreFoot?.delete();
    } else {
      // Blind-pocket half (open mold, cavity half, or unchannelled lid): keep
      // a solid rigid holder back floor of at least MIN_FLOOR_MM.
      const baseFlat = flatBase(cavityRaw, floorLimit);
      let baseDepth = 0;
      for (const d of baseFlat) if (d > baseDepth) baseDepth = d;

      let outer: Manifold | null = baseDepth > 0 ? envelopeSolid(wasm, grid, baseFlat) : null;
      if (boreFoot && !boreFoot.isEmpty() && baseDepth > 0) {
        const boreCol = wasm.Manifold.extrude(boreFoot, baseDepth + ENVELOPE_TOP).translate([0, 0, -baseDepth]);
        outer = outer ? replace(outer, outer.add(boreCol)) : boreCol;
        if (outer !== boreCol) boreCol.delete();
      }

      const shapeParts: Manifold[] = [];
      if (outer) shapeParts.push(outer);
      if (sleeves) shapeParts.push(sleeves);
      if (landing) shapeParts.push(landing);
      const shape = shapeParts.length > 1
        ? wasm.Manifold.union(shapeParts)
        : shapeParts[0] ?? wasm.Manifold.cube([0, 0, 0]);
      shape.numTri();
      const inBlock = shape.intersect(block);
      inBlock.numTri();
      if (shape !== outer && shape !== sleeves && shape !== landing) shape.delete();
      const minBlindBackMm = Math.max(1.2, ctx.skinMm);
      const blindFloorLimit = baseDepth > 0
        ? Math.max(0.4, baseDepth - minBlindBackMm)
        : Math.max(0.4, floorLimit - minBlindBackMm);
      const blindPart = (() => {
        if (part.boundingBox().min[2] >= -blindFloorLimit - 1e-4) return part;
        const keepBox = wasm.Manifold.cube(
          [moldWidthMm * 4, moldDepthMm * 4, blindFloorLimit + ENVELOPE_TOP + 2],
          false,
        ).translate([-moldWidthMm * 2, -moldDepthMm * 2, -blindFloorLimit]);
        const clamped = part.intersect(keepBox);
        clamped.numTri();
        keepBox.delete();
        return clamped;
      })();
      liner = inBlock.subtract(blindPart);
      liner.numTri();
      if (blindPart !== part) blindPart.delete();
      inBlock.delete();

      const pocketParts: Manifold[] = [];
      if (outer && baseDepth > 0) {
        let outerFace = outer.slice(0);
        if (boreFoot && !boreFoot.isEmpty()) outerFace = replace2(outerFace, outerFace.add(boreFoot));
        if (!outerFace.isEmpty()) {
          const grownFace = outerFace.offset(INSERT_CLEARANCE_MM, 'Round');
          const pDepth = baseDepth + INSERT_CLEARANCE_MM;
          pocketParts.push(wasm.Manifold.extrude(grownFace, pDepth + ENVELOPE_TOP).translate([0, 0, -pDepth]));
          grownFace.delete();
        }
        outerFace.delete();
      }
      for (const v of features.topVents ?? []) {
        if (v.zRoof < -0.1 && v.zRoof > -blockHeight + 0.5) {
          const z0 = v.zRoof - 0.3 - ctx.skinMm - INSERT_CLEARANCE_MM;
          const rClear = v.r + ctx.skinMm + INSERT_CLEARANCE_MM;
          pocketParts.push(
            wasm.Manifold.cylinder(1.0 - z0 + ENVELOPE_TOP, rClear, rClear, 32, false).translate([v.x, v.y, z0]),
          );
        }
      }
      if (landingFoot) {
        const grownLanding = landingFoot.offset(INSERT_CLEARANCE_MM, 'Round');
        const deep = ctx.skinMm + INSERT_CLEARANCE_MM;
        pocketParts.push(wasm.Manifold.extrude(grownLanding, deep + ENVELOPE_TOP).translate([0, 0, -deep]));
        grownLanding.delete();
      }
      boreFoot?.delete();
      outer?.delete();

      if (pocketParts.length > 0) {
        const pocket = pocketParts.length === 1 ? pocketParts[0] : wasm.Manifold.union(pocketParts);
        pocket.numTri();
        if (pocketParts.length > 1) for (const p of pocketParts) p.delete();
        shell = block.subtract(pocket);
        shell.numTri();
        face = faceOutline(wasm, pocket);
        pocket.delete();
      } else {
        shell = block.translate([0, 0, 0]);
        shell.numTri();
        face = block.slice(10);
      }
    }
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

/** The part's shadow on the face within LIFT_MAX_MM of the half's own side of it (z < 0). */
function halfShadow(wasm: ManifoldToplevel, part: Manifold): CrossSection {
  const side = wasm.Manifold.cube([1e4, 1e4, LIFT_MAX_MM], true).translate([0, 0, -LIFT_MAX_MM / 2]);
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
function roofFootprint(wasm: ManifoldToplevel, part: Manifold, shadow: CrossSection, otherShadow: CrossSection, minWallMm = 0.4): CrossSection {
  // Only where the part comes within LIFT_MAX_MM of the face. Shrinking
  // `touching` by LIFT_INSET_MM rather than shrinking after subtracting it
  // avoids leaving a 20 µm foil of liner standing along the wall of `touching`.
  const slab = wasm.Manifold.cube([1e4, 1e4, LIFT_MAX_MM], true).translate([0, 0, -LIFT_MAX_MM / 2]);
  const near = part.intersect(slab);
  slab.delete();
  const nearShadow = near.project();
  near.delete();
  const nearInset = nearShadow.offset(-LIFT_INSET_MM, 'Miter');
  nearShadow.delete();
  const touching = part.slice(-FACE_TOUCH_MM);
  const touchInset = touching.offset(-LIFT_INSET_MM, 'Miter');
  touching.delete();
  const short = nearInset.subtract(touchInset);
  nearInset.delete();
  touchInset.delete();
  const otherGrown = otherShadow.offset(LIFT_INSET_MM, 'Miter');
  const inset = short.subtract(otherGrown);
  short.delete();
  otherGrown.delete();
  // Specks and slivers narrower than one nozzle line (< minWallMm) are left where they are;
  // anything at least a line wide (such as gear-tooth roofs) lifts onto the other half's face
  // rather than hanging over the cavity as a thin cantilevered wafer.
  const rMin = Math.max(0.05, minWallMm / 2);
  const aMin = Math.max(0.05, minWallMm * minWallMm * 0.75);
  const kept = inset.decompose().filter((p) => {
    const core = p.offset(-rMin, 'Round');
    const keep = p.area() > aMin && !core.isEmpty();
    core.delete();
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
  const top = pieces.filter((p) => p.boundingBox().max[2] > -1e-3 && p.volume() >= 0.005);
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

/** Flat faces a solid turns upward below the parting face, grouped by height (mm), at least `minAreaMm2` each. */
function upwardFlats(wasm: ManifoldToplevel, m: Manifold, minAreaMm2 = 1): Array<{ z: number; cs: CrossSection }> {
  const mesh = m.getMesh();
  const p = mesh.vertProperties;
  const st = mesh.numProp;
  const t = mesh.triVerts;
  const byZ = new Map<number, { area: number; polys: SimplePolygon[] }>();
  for (let k = 0; k < t.length; k += 3) {
    const [a, b, c] = [t[k] * st, t[k + 1] * st, t[k + 2] * st];
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12 || nz / len < 0.999) continue;
    const z = Math.round(((p[a + 2] + p[b + 2] + p[c + 2]) / 3) * 100) / 100;
    if (z >= -0.05) continue;
    let entry = byZ.get(z);
    if (!entry) {
      entry = { area: 0, polys: [] };
      byZ.set(z, entry);
    }
    entry.area += len / 2;
    entry.polys.push([[p[a], p[a + 1]], [p[b], p[b + 1]], [p[c], p[c + 1]]]);
  }
  const out: Array<{ z: number; cs: CrossSection }> = [];
  for (const [z, { area, polys }] of byZ) {
    if (area < minAreaMm2) continue;
    const raw = new wasm.CrossSection(polys, 'Positive');
    // Each contiguous flat face must reach `minAreaMm2` on its own, so a ring of
    // tiny polar-cap facets on curved domes or petals at the same height never
    // adds up to look like one flat shelf.
    const bigPolys: SimplePolygon[] = [];
    for (const island of raw.decompose()) {
      if (island.area() >= minAreaMm2) bigPolys.push(...island.toPolygons());
      island.delete();
    }
    raw.delete();
    if (!bigPolys.length) continue;
    const cs = new wasm.CrossSection(bigPolys, 'Positive');
    if (cs.area() >= minAreaMm2) out.push({ z, cs });
    else cs.delete();
  }
  return out;
}

/** How far under the face it frees an insert is cut, mm: far under a layer. */
const CUT_UNDER_MM = 0.02;
/** Minimum vertical spacing between two insert cuts so no cut slices out a sub-millimetre wafer, mm. */
const MIN_CUT_STEP_MM = 0.8;
/** Two pegs at least this far apart fix a piece's turn as well as its place, mm. */
const PEG_SPREAD = 6;

interface PegSpec {
  pegR: number;
  pegTopR: number;
  pegH: number;
  holeClear: number;
  holeDeep: number;
  margin: number;
  roofMargin: number;
}

const PEG_TIERS: readonly PegSpec[] = [
  { pegR: 1.0, pegTopR: 0.8, pegH: 1.5, holeClear: 0.15, holeDeep: 1.8, margin: 0.8, roofMargin: 0.6 },
  { pegR: 0.85, pegTopR: 0.68, pegH: 1.0, holeClear: 0.15, holeDeep: 1.2, margin: 0.65, roofMargin: 0.4 },
  { pegR: 0.75, pegTopR: 0.6, pegH: 0.7, holeClear: 0.15, holeDeep: 0.85, margin: 0.55, roofMargin: 0.3 },
  { pegR: 0.68, pegTopR: 0.54, pegH: 0.5, holeClear: 0.15, holeDeep: 0.62, margin: 0.5, roofMargin: 0.25 },
];

/**
 * Pieces of an insert keyed to each other. The holder's pocket alone lets a
 * piece shift by its clearance, a step in the casting at every cut; a pair of
 * pegs on each cut face, in holes in the piece above, holds it. Scales down
 * pegs for thinner wafers (down to ~1.7 mm) while sampling continuous Z slices
 * (step <= 0.25 mm) up to the hole cone tip so no hole pierces an intermediate
 * runner or undercut cavity. Any cut genuinely too thin or narrow is reported.
 */
function pegPieces(
  wasm: ManifoldToplevel,
  pieces: Manifold[],
  cuts: number[],
): { pieces: Manifold[]; pegs: number; unpeggedCutsMm: number[] } {
  const out = [...pieces];
  let pegs = 0;
  const unpeggedCutsMm: number[] = [];
  for (let k = 0; k + 1 < out.length && k < cuts.length; k++) {
    const z = cuts[k];
    const upperMaxZ = out[k + 1].boundingBox().max[2];
    const below = out[k].slice(z - 0.05);
    if (below.isEmpty()) {
      below.delete();
      unpeggedCutsMm.push(Math.round(-(z + CUT_UNDER_MM) * 100) / 100);
      continue;
    }

    let chosen: { tier: PegSpec; spots: [number, number][] } | null = null;
    for (const tier of PEG_TIERS) {
      const rHole = tier.pegR + tier.holeClear;
      const hMax = tier.holeDeep + rHole + tier.roofMargin;
      if (upperMaxZ < z + hMax) continue;

      let solid = below.offset(0, 'Round');
      const heights: number[] = [];
      for (let h = 0.05; h < hMax - 1e-6; h += 0.25) heights.push(h);
      heights.push(hMax);
      for (const h of heights) {
        const at = out[k + 1].slice(z + h);
        solid = replace2(solid, solid.intersect(at));
        at.delete();
        if (solid.isEmpty()) break;
      }
      const room = solid.isEmpty() ? solid : solid.offset(-(rHole + tier.margin), 'Round');
      if (room !== solid) solid.delete();
      const rawSpots = room.toPolygons().flat();
      room.delete();
      if (!rawSpots.length) continue;

      let best: [number, number][] = [rawSpots[0]];
      let far = 0;
      const stride = Math.max(1, Math.floor(rawSpots.length / 200));
      for (let i = 0; i < rawSpots.length; i += stride) {
        for (let j = i + 1; j < rawSpots.length; j += stride) {
          const d = Math.hypot(rawSpots[i][0] - rawSpots[j][0], rawSpots[i][1] - rawSpots[j][1]);
          if (d > far) {
            far = d;
            best = [rawSpots[i], rawSpots[j]];
          }
        }
      }
      if (far < PEG_SPREAD) best = [best[0]];
      if (!chosen) chosen = { tier, spots: best };
      if (best.length === 2) {
        chosen = { tier, spots: best };
        break;
      }
    }
    below.delete();

    if (!chosen) {
      unpeggedCutsMm.push(Math.round(-(z + CUT_UNDER_MM) * 100) / 100);
      continue;
    }

    const { tier, spots } = chosen;
    const rHole = tier.pegR + tier.holeClear;
    const holeCs = new wasm.CrossSection(
      [[[0, -0.05], [rHole, -0.05], [rHole, tier.holeDeep], [0, tier.holeDeep + rHole]]],
      'Positive',
    );
    const holeShape = wasm.Manifold.revolve(holeCs, 24);
    holeCs.delete();
    for (const [x, y] of spots) {
      const peg = wasm.Manifold.cylinder(tier.pegH + 0.05, tier.pegR, tier.pegTopR, 24, false).translate([x, y, z - 0.05]);
      out[k] = replace(out[k], out[k].add(peg));
      peg.delete();
      const hole = holeShape.translate([x, y, z]);
      out[k + 1] = replace(out[k + 1], out[k + 1].subtract(hole));
      hole.delete();
      pegs++;
    }
    holeShape.delete();
  }
  return { pieces: out, pegs, unpeggedCutsMm };
}

/**
 * An insert cut across wherever it would hang over the casting, so each piece
 * prints with that roof's underside on the bed: the roofs are found as a
 * slicer would (unprintableRoofs), and each one that is the top of a flat
 * face of the casting is cut at exactly that face. Pieces bottom first, with
 * the heights they were cut at and whatever roofs no cut could fix.
 */
type LeftRoof = CavityRoof & { flatWafer?: boolean };

/** Minimum first-layer bed contact area for any upper piece sliced by `splitInsert`, mm². */
const MIN_SPLIT_BASE_ISLAND_MM2 = 6;

/**
 * After `splitInsert` cuts an insert along horizontal planes `cuts`, an upper
 * piece `k > 0` stands on `z = cuts[k - 1]` (which becomes `Z = 0` on the bed):
 *  1. Any disconnected 3D lump of piece `k` whose own bed contact on `z + 0.05`
 *     is under `MIN_SPLIT_BASE_ISLAND_MM2` (e.g. a narrow pillar or tooth tip
 *     sliced across by the cut plane) cannot anchor itself on the bed in HIPS/PVA:
 *     keep it attached to `pieces[k - 1]` below instead.
 *  2. Because `cuts[k - 1] = face - CUT_UNDER_MM` (`0.02 mm` under the flat face
 *     it frees), a tiny feature grazed only inside that `0.02 mm` band or a narrow
 *     `< MIN_SPLIT_BASE_ISLAND_MM2` toe touching `z` would emit unanchored first-layer
 *     dots before merging higher up: shave `0.05 mm` off any `< MIN_SPLIT_BASE_ISLAND_MM2`
 *     bottom island on `z` (and lift the `0.02 mm` rim step flush where the main
 *     `z + 0.05` face is already wide) so layer 1 (`Z = 0..0.2 mm`) has zero tiny dots.
 */
function anchorSplitPieces(wasm: ManifoldToplevel, pieces: Manifold[], cuts: number[]): Manifold[] {
  if (pieces.length <= 1) return pieces;
  const out = [...pieces];
  for (let k = 1; k < out.length; k++) {
    const cutZ = cuts[Math.min(k - 1, cuts.length - 1)];
    const lumps = out[k].decompose();
    if (lumps.length > 1) {
      const keepUpper: Manifold[] = [];
      const mergeBelow: Manifold[] = [];
      for (const lump of lumps) {
        const lb = lump.boundingBox();
        if (lb.min[2] > cutZ + 0.25) {
          // Floating above cutZ without touching the bed at all -> return to piece below
          mergeBelow.push(lump);
          continue;
        }
        const foot = lump.slice(lb.min[2] + 0.05);
        const footArea = foot.area();
        foot.delete();
        if (footArea < MIN_SPLIT_BASE_ISLAND_MM2) {
          mergeBelow.push(lump);
        } else {
          keepUpper.push(lump);
        }
      }
      if (mergeBelow.length > 0 && keepUpper.length > 0) {
        const addedBelow = mergeBelow.length === 1 ? mergeBelow[0] : wasm.Manifold.compose(mergeBelow);
        out[k - 1] = replace(out[k - 1], out[k - 1].add(addedBelow));
        if (addedBelow !== mergeBelow[0]) addedBelow.delete();
        const nextUpper = keepUpper.length === 1 ? keepUpper[0] : wasm.Manifold.compose(keepUpper);
        out[k] = replace(out[k], nextUpper);
      }
      for (const l of lumps) l.delete();
    }

    // Check first-layer islands right above the piece's bottom (`minZ + 0.01 mm` and `+ 0.08 mm`)
    // and trim any tiny (< MIN_SPLIT_BASE_ISLAND_MM2) grazed toes up by 0.22 mm so the piece's
    // Z = 0 bed layer only contains anchored islands >= MIN_SPLIT_BASE_ISLAND_MM2.
    const pb = out[k].boundingBox();
    const probeZ = pb.min[2] + 0.01;
    const csLow = out[k].slice(probeZ);
    const lowIslands = csLow.decompose();
    csLow.delete();
    const tinyPolys: SimplePolygon[] = [];
    let hasWide = false;
    for (const isl of lowIslands) {
      if (isl.area() >= MIN_SPLIT_BASE_ISLAND_MM2) hasWide = true;
      else tinyPolys.push(...isl.toPolygons());
      isl.delete();
    }
    if (!hasWide) {
      // Check slightly above CUT_UNDER_MM (`minZ + CUT_UNDER_MM + 0.03`): if the wide
      // flat shelf opens right above the 20 µm CUT_UNDER_MM rim, trim the 25 µm rim off
      // so the wide shelf itself sits cleanly on Z = 0!
      const csShelf = out[k].slice(pb.min[2] + CUT_UNDER_MM + 0.03);
      const shelfWide = csShelf.decompose().some((isl) => {
        const ok = isl.area() >= MIN_SPLIT_BASE_ISLAND_MM2;
        isl.delete();
        return ok;
      });
      csShelf.delete();
      if (shelfWide && pb.max[2] - pb.min[2] > 0.3) {
        const trimZ = pb.min[2] + CUT_UNDER_MM + 0.01;
        const [trimmed, shaved] = out[k].splitByPlane([0, 0, 1], trimZ);
        shaved.delete();
        if (!trimmed.isEmpty()) {
          out[k] = replace(out[k], withoutCrumbs(wasm, trimmed));
        } else {
          trimmed.delete();
        }
      }
    } else if (tinyPolys.length > 0) {
      const tinyRaw = new wasm.CrossSection(tinyPolys, 'Positive');
      const tinyPad = tinyRaw.offset(0.08, 'Round');
      tinyRaw.delete();
      // Only shave up to 0.20 mm so upper walls stay intact; return the shaved tip to out[k - 1]
      // only where it doesn't bridge over cast space (it sits right on cutZ, touching out[k - 1]).
      const shaveH = Math.min(0.22, Math.max(0.05, (pb.max[2] - pb.min[2]) * 0.25));
      const shavePrism = wasm.Manifold.extrude(tinyPad, shaveH + 0.04).translate([0, 0, pb.min[2] - 0.02]);
      tinyPad.delete();
      const shavedTip = out[k].intersect(shavePrism);
      if (!shavedTip.isEmpty()) {
        out[k - 1] = replace(out[k - 1], out[k - 1].add(shavedTip));
      }
      shavedTip.delete();
      out[k] = replace(out[k], withoutCrumbs(wasm, out[k].subtract(shavePrism)));
      shavePrism.delete();
    }

    // Re-check at +0.08 mm (mid first layer) in case CUT_UNDER_MM left a tiny island above +0.01 mm.
    const pb2 = out[k].boundingBox();
    const csMid = out[k].slice(pb2.min[2] + 0.08);
    const midIslands = csMid.decompose();
    csMid.delete();
    const midTiny: SimplePolygon[] = [];
    let midHasWide = false;
    for (const isl of midIslands) {
      if (isl.area() >= MIN_SPLIT_BASE_ISLAND_MM2) midHasWide = true;
      else midTiny.push(...isl.toPolygons());
      isl.delete();
    }
    if (midHasWide && midTiny.length > 0 && pb2.max[2] - pb2.min[2] > 0.4) {
      const tinyRaw = new wasm.CrossSection(midTiny, 'Positive');
      const tinyPad = tinyRaw.offset(0.08, 'Round');
      tinyRaw.delete();
      const shavePrism = wasm.Manifold.extrude(tinyPad, 0.24).translate([0, 0, pb2.min[2] - 0.02]);
      tinyPad.delete();
      const shavedTip = out[k].intersect(shavePrism);
      if (!shavedTip.isEmpty()) {
        out[k - 1] = replace(out[k - 1], out[k - 1].add(shavedTip));
      }
      shavedTip.delete();
      out[k] = replace(out[k], withoutCrumbs(wasm, out[k].subtract(shavePrism)));
      shavePrism.delete();
    }
  }
  return out.filter((p) => {
    if (p.isEmpty()) {
      p.delete();
      return false;
    }
    return true;
  });
}

function splitInsert(
  wasm: ManifoldToplevel,
  liner: Manifold,
  cast: Manifold,
  bridgeMm: number,
): { pieces: Manifold[]; cutsMm: number[]; pegs: number; unpeggedCutsMm: number[]; left: LeftRoof[] } {
  const flats = upwardFlats(wasm, cast, 2);
  const cuts: number[] = [];
  let pieces: Manifold[] = [liner];
  // The roofs the last round found that no cut could fix.
  let left: LeftRoof[] = [];
  for (let round = 0; round < 8; round++) {
    const candidates: Array<{ z: number; area: number; roof: CavityRoof }> = [];
    left = [];
    for (const piece of pieces) {
      const box = piece.boundingBox();
      for (const roof of unprintableRoofs(piece, cast, ROOF_LAYER_MM, ROOF_REACH_MM, bridgeMm)) {
        // The roof starts on the layer above the flat face it hangs over — and
        // only when a substantial share of that roof actually lies over the flat
        // face in XY, not at a curved petal grazing a small facet elsewhere.
        let face: number | undefined;
        let bestArea = 0;
        let bestDist = ROOF_LAYER_MM * 0.75;
        let roofCs: CrossSection | null = null;
        if (roof.polys && roof.polys.length > 0) {
          const rawCs = new wasm.CrossSection(roof.polys, 'Positive');
          roofCs = rawCs.offset(ROOF_REACH_MM + 0.1, 'Round');
          rawCs.delete();
        }
        const minOverlap = Math.max(0.5, roof.areaMm2 * 0.4);
        for (const f of flats) {
          const d = Math.abs(f.z + roof.depthMm);
          if (d > bestDist) continue;
          let overArea = roof.areaMm2;
          if (roofCs) {
            const under = f.cs.intersect(roofCs);
            overArea = under.area();
            under.delete();
            if (overArea < minOverlap) continue;
          }
          bestDist = d;
          bestArea = overArea;
          face = f.z;
        }
        roofCs?.delete();
        // A hair under the face: cut on it, the pieces touch each other along
        // its edges, and no slicer reads a body that does as solid.
        const z = face === undefined ? undefined : Math.round((face - CUT_UNDER_MM) * 1000) / 1000;
        if (z === undefined) {
          left.push({ ...roof, flatWafer: false });
        } else if (z <= box.min[2] + 0.4 || z >= box.max[2] - 0.4) {
          left.push({ ...roof, flatWafer: true });
        } else {
          candidates.push({ z, area: bestArea, roof });
        }
      }
    }
    candidates.sort((a, b) => b.area - a.area);
    const fresh: number[] = [];
    for (const cand of candidates) {
      const tooClose =
        cuts.some((c) => Math.abs(c - cand.z) < MIN_CUT_STEP_MM) ||
        fresh.some((c) => Math.abs(c - cand.z) < MIN_CUT_STEP_MM);
      if (tooClose) {
        if (!cuts.includes(cand.z) && !fresh.includes(cand.z)) left.push({ ...cand.roof, flatWafer: true });
      } else {
        fresh.push(cand.z);
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
  for (const f of flats) f.cs.delete();
  cuts.sort((a, b) => a - b);
  pieces.sort((p, q) => p.boundingBox().min[2] - q.boundingBox().min[2]);
  if (pieces.length > 1) pieces = anchorSplitPieces(wasm, pieces, cuts);
  // Pegs stand on a piece's top and go into holes opening on the next one's
  // bed: neither hangs over anything, so what was left stays what is left.
  let pegs = 0;
  let unpeggedCutsMm: number[] = [];
  if (pieces.length > 1) ({ pieces, pegs, unpeggedCutsMm } = pegPieces(wasm, pieces, cuts));
  return {
    pieces,
    cutsMm: cuts.map((z) => Math.round(-(z + CUT_UNDER_MM) * 100) / 100),
    pegs,
    unpeggedCutsMm,
    left: left.sort((p, q) => q.areaMm2 - p.areaMm2),
  };
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
  /** In 'combined' mode, whether flared sprue/vent cones sit at the shell's back face. */
  flaredChannels?: boolean;
  /** In 'combined' mode, whether undercuts, a buried runner or flared cones lock the shell onto the casting. */
  shellLocked?: boolean;
}): string[] {
  const { pair, construction, clamshell, sealed } = o;
  const insert = construction === 'insert';
  const shell = pair.shell.name;
  const sol = pair.liner.name;
  const combinedDemold = o.flaredChannels
    ? `Unclamp, then snip or drill any flared sprue and vent plugs flush with the back of the ${shell} shell so they cannot rivet the lid on. Pull the ${shell} shell off along the pull if it slides free; if an undercut or bottom runner locks it on, soak the whole mold in ${pair.solvent} so the solvent works in from the open seam until the shell lets go.`
    : o.shellLocked
      ? `${clamshell ? 'Unclamp and pull' : 'Pull'} the ${shell} shell off along the pull if it slides free; where an undercut or runner locks it on, soak the whole mold in ${pair.solvent} so the solvent works in from the open ${clamshell ? 'seam' : 'mouth'} until the shell lets go.`
      : `${clamshell ? 'Unclamp and lift' : 'Lift'} the ${shell} shell off along the pull. If it holds on, soak it in the solvent for an hour first.`;
  return [
    insert
      ? `Print the ${clamshell ? 'two holder halves' : 'holder'} in ${shell} and the ${clamshell ? 'two inserts' : 'insert'} in ${sol}, each on its own. Print them parting face up with supports off: nothing in them needs any${o.roofsLeft ? ' but the roof the warnings name, which prints unsupported and a little rough (the slicer calls it a floating region)' : ''}, and support printed inside the cavity would take the casting's place.`
      : `Print with ${shell} on extruder 1 and ${sol} on extruder 2 (already set in the 3MF).`,
    ...(o.insertCuts ?? []).map((c) =>
      `The ${c.half}'s insert comes in ${c.cutsMm.length + 1} pieces, cut ${[...c.cutsMm].sort((a, b) => a - b).join(' and ')} mm below the parting face so that nothing in it hangs over the casting as it prints. ` +
      'Print each piece the way up it lies in the 3MF, the upper ones standing on their flat cut faces, and stack them in the holder from the bottom up' +
      (c.pegs ? ', each on the pegs of the one below.' : '.')),
    ...(insert ? [`Press each insert into its holder${clamshell ? ' (the lid holder\'s back lip stops it going through; hold the lid insert in place as you turn the lid over, and close the halves dry once to check they seat flat)' : ''}.`] : []),
    clamshell
      ? `Wipe a thin film of mold release or petroleum jelly over both parting faces${sealed ? ', the sealing ridge and its groove' : ''}, the pins and sockets, and the sprue and vent mouths. The cavity needs none: the ${sol} dissolves.`
      : `Wipe a thin film of mold release or petroleum jelly over the top face and round the rim. The cavity needs none: the ${sol} dissolves.`,
    ...(clamshell
      ? [
          `Close the halves${sealed ? ' with the tongue in its groove' : ''} and clamp them: binder clips round the edge, or at least ${o.clampG} g on the lid. Once the pour reaches the funnel it can lift a lid that is only taped, and resin gets into the seam.`,
        ]
      : []),
    `Pour the ${o.castLabel} slowly into the funnel until it shows at every vent, then leave it to cure.`,
    insert
      ? `Unclamp, lift the holder off and push the ${clamshell ? 'inserts' : 'insert'} out with the casting inside. The holder is reusable.`
      : combinedDemold,
    `Dissolve the ${sol} off the casting in ${pair.solvent}: about ${o.dissolveHours} h for its thickest ${o.thickestMm} mm${insert ? ', now that the solvent reaches every side' : o.shellLocked ? ' from the open seam while the shell stays on' : ''}. ${pair.dissolveTip}`,
  ];
}

/**
 * Edges shorter than this are collapsed before a part is written, mm. The 3MF
 * keeps a tenth of a micron, and the booleans leave sliver triangles finer
 * than that: rounded, they fold onto each other, and a slicer has to repair
 * the part (the gear insert's lid had 581 such edges).
 */
const EXPORT_TOLERANCE_MM = 1e-3;

function meshPart(m: Manifold, name: string, extruder: number, alreadyClean = false): ThreeMfPart {
  const clean = alreadyClean ? m : m.simplify(EXPORT_TOLERANCE_MM);
  const mesh = clean.getMesh();
  if (!alreadyClean) clean.delete();
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
  const construction: LinerConstruction = ctx.construction ?? 'combined';
  const notes = [...warnings, ...material.warnings];
  const minFloorNeed = ctx.skinMm + MIN_FLOOR_MM + (construction === 'insert' ? INSERT_CLEARANCE_MM : 0);
  if (opts.baseThicknessMm < minFloorNeed) {
    notes.push(
      `The ${opts.baseThicknessMm} mm floor leaves under ${MIN_FLOOR_MM} mm of ${pair.shell.name} below a ${ctx.skinMm} mm ${construction === 'insert' ? 'insert and its clearance' : 'liner'}; ` +
      `a floor of ${Math.ceil((minFloorNeed + 1) * 10) / 10} mm or more keeps the ${construction === 'insert' ? 'holder' : 'shell'} stiff.`
    );
  }
  const minShellWallMm = 1.2;
  const gridPadMm = Math.hypot(ctx.grid.stepX, ctx.grid.stepY) / 2;
  const minWallNeed = ctx.skinMm + (construction === 'insert' ? INSERT_CLEARANCE_MM : 0) + gridPadMm + minShellWallMm;
  if (opts.wallMarginMm < minWallNeed) {
    notes.push(
      `The ${opts.wallMarginMm} mm wall margin leaves under ${minShellWallMm} mm of ${pair.shell.name} outside a ${ctx.skinMm} mm ${construction === 'insert' ? 'insert and its clearance' : 'liner'}; ` +
      `a wall margin of ${Math.ceil((minWallNeed + 0.5) * 10) / 10} mm or more keeps the ${construction === 'insert' ? 'holder' : 'shell'} wall solid.`
    );
  }

  const clamshell = opts.moldType === 'clamshell';
  const basePart = halfPart(ctx, rawPart, ctx.detailIsAbove, ctx.rawBaseDepth, false);
  const lidPart = clamshell ? halfPart(ctx, rawPart, !ctx.detailIsAbove, ctx.rawLidDepth, ctx.lidIsBackingPlate) : null;
  rawPart.delete();
  // Liner roofing one half's cavity up to the face goes to the other half, so
  // that neither prints with liner hanging over the casting (roofFootprint).
  const limits = opts.printLimits ?? printLimits(DEFAULT_PRINTER);
  let baseRoof: CrossSection | null = null;
  let lidRoof: CrossSection | null = null;
  if (lidPart) {
    const baseShadow = halfShadow(wasm, basePart);
    const lidShadow = halfShadow(wasm, lidPart);
    const lidInBase = lidShadow.mirror([0, 1]);
    const baseInLid = baseShadow.mirror([0, 1]);
    baseRoof = roofFootprint(wasm, basePart, baseShadow, lidInBase, limits.minWallMm);
    lidRoof = roofFootprint(wasm, lidPart, lidShadow, baseInLid, limits.minWallMm);
    for (const c of [baseShadow, lidShadow, lidInBase, baseInLid]) c.delete();
  }
  // Each half's face is liner, a skin deep, wherever the other half's part
  // meets the face: a part standing on the parting plane has nothing of it in
  // this half, so no envelope here, and the casting's face would lie on the
  // shell (or on an insert's clearance, which the resin then fills). And
  // wherever liner lifted off the other half lands.
  const landingFor = (roof: CrossSection | null, otherPart: Manifold | null) => {
    if (!otherPart) return null;
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
  // Roofs the printer bridges with supports off print as they are; only the rest are cut or warned about.
  const bridgeMm = (opts.printLimits ?? printLimits(DEFAULT_PRINTER)).bridgeMm;
  const insertCuts: Array<{ half: string; cutsMm: number[]; pegs: number }> = [];
  let roofsLeft = false;
  halves.forEach((h, i) => {
    const cast = castSpace(wasm, halfParts[i], halfFeatures[i], halfHeights[i]);
    let left: LeftRoof[];
    if (construction === 'insert') {
      const split = splitInsert(wasm, h.liner, cast, bridgeMm);
      if (split.cutsMm.length) {
        h.pieces = split.pieces;
        insertCuts.push({ half: roofNames[i], cutsMm: split.cutsMm, pegs: split.pegs });
        for (const unpeggedDepth of split.unpeggedCutsMm) {
          notes.push(
            `The cut ${unpeggedDepth} mm below the ${roofNames[i]}'s parting face is too thin or narrow for alignment pegs; ` +
            'seat that piece carefully against the holder wall before pouring.'
          );
        }
      } else {
        for (const p of split.pieces) if (p !== h.liner) p.delete();
      }
      left = split.left;
    } else {
      const body = h.shell.add(h.liner);
      left = unprintableRoofs(body, cast, ROOF_LAYER_MM, ROOF_REACH_MM, bridgeMm);
      body.delete();
    }
    cast.delete();
    if (!left.length) return;
    // A flat roof skipped solely by the < 0.4 mm (1-2 layer) wafer guard near
    // the parting face is not sloped or curved: do not falsely claim it is.
    const curvedLeft = left.filter((r) => !r.flatWafer);
    if (construction === 'insert' && curvedLeft.length === 0) return;
    const reported = construction === 'insert' ? curvedLeft : left;
    const rawTotal = reported.reduce((sum, r) => sum + r.areaMm2, 0);
    if (rawTotal < 0.5) return;
    roofsLeft = true;
    const total = Math.max(1, Math.round(rawTotal));
    const at = reported[0].depthMm;
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
    const clean = (m: Manifold) => {
      const moved = m.translate([x, 0, lift]);
      const simplified = moved.simplify(EXPORT_TOLERANCE_MM);
      moved.delete();
      return withoutCrumbs(wasm, simplified);
    };
    const liner = clean(h.liner);
    let shell: Manifold;
    if (construction === 'combined') {
      const wholeRaw = h.shell.add(h.liner);
      const whole = clean(wholeRaw);
      wholeRaw.delete();
      const diff = whole.subtract(liner);
      whole.delete();
      shell = withoutCrumbs(wasm, diff);
    } else {
      shell = clean(h.shell);
    }
    const pieces = h.pieces?.map((p) => {
      const s = clean(p);
      p.delete();
      return s;
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
  const allFeatures = lid ? [ctx.baseFeatures, ctx.lidFeatures] : [ctx.baseFeatures];
  const flaredChannels =
    construction === 'combined' &&
    allFeatures.some((f) => f.channels.some((c) => c.outerR > c.innerR + 1e-3));
  const hasBuriedRunner =
    construction === 'combined' &&
    allFeatures.some((f) => Boolean(f.bores?.length));
  const shellLocked = construction === 'combined' && (ctx.undercutColumns > 0 || hasBuriedRunner || flaredChannels);
  const rawThickest = Math.max(...halves.map((h) => thickestPvaMm(h.envelope, h.spans, ctx.grid, shellLocked ? 'combined' : 'insert')));
  const thickest = rawThickest > 0 ? rawThickest : ctx.skinMm;
  const dissolveHours = Math.max(1, Math.ceil(thickest / pair.dissolveMmPerHour));

  const names = lid ? ['Cavity half', 'Lid half'] : ['Open mold'];
  const assemblies: ThreeMfAssembly[] = (() => {
    if (construction !== 'insert') {
      return all.map((h, i) => ({
        name: names[i],
        parts: [
          meshPart(h.shell, `${names[i]} shell (${pair.shell.name})`, 1, true),
          meshPart(h.liner, `${names[i]} liner (${pair.liner.name})`, 2, true),
        ],
      }));
    }
    const bedItems = [
      ...all.map((h, i) => ({
        assemblyName: `${names[i]} holder`,
        partName: `${names[i]} holder (${pair.shell.name})`,
        extruder: 1,
        manifold: h.shell,
      })),
      ...all.flatMap((h, i) => {
        if (!h.pieces) {
          return [{
            assemblyName: `${names[i]} insert`,
            partName: `${names[i]} insert (${pair.liner.name})`,
            extruder: 2,
            manifold: h.liner,
          }];
        }
        return h.pieces.map((p, k) => {
          const label = `${names[i]} insert, piece ${k + 1} of ${h.pieces!.length}${k === 0 ? ' (bottom)' : k === h.pieces!.length - 1 ? ' (top)' : ''}`;
          return {
            assemblyName: label,
            partName: `${label} (${pair.liner.name})`,
            extruder: 2,
            manifold: p,
          };
        });
      }),
    ];
    const bedMm = { widthMm: 250, depthMm: 250 };
    const bedPlateGapMm = 20;
    const boxes = bedItems.map((it) => it.manifold.boundingBox());
    const rects = boxes.map((b) => ({ w: b.max[0] - b.min[0], d: b.max[1] - b.min[1] }));
    const places = packOnBed(rects, bedMm, 5, 8);
    let p0MinX = Infinity, p0MaxX = -Infinity, p0MinY = Infinity, p0MaxY = -Infinity;
    places.forEach((pl, idx) => {
      if (pl.plate !== 0) return;
      const w = pl.turned ? rects[idx].d : rects[idx].w;
      const d = pl.turned ? rects[idx].w : rects[idx].d;
      p0MinX = Math.min(p0MinX, pl.x);
      p0MaxX = Math.max(p0MaxX, pl.x + w);
      p0MinY = Math.min(p0MinY, pl.y);
      p0MaxY = Math.max(p0MaxY, pl.y + d);
    });
    const shiftX = Number.isFinite(p0MinX) ? (p0MinX + p0MaxX) / 2 : 0;
    const shiftY = Number.isFinite(p0MinY) ? (p0MinY + p0MaxY) / 2 : 0;

    return bedItems.map((it, idx) => {
      const b = boxes[idx];
      const pl = places[idx];
      let moved = it.manifold.translate([-b.min[0], -b.min[1], -b.min[2]]);
      if (pl.turned) {
        const rotated = moved.rotate([0, 0, 90]);
        moved.delete();
        moved = rotated.translate([rects[idx].d, 0, 0]);
        rotated.delete();
      }
      const plateX = pl.plate * (bedMm.widthMm + bedPlateGapMm);
      const placedM = moved.translate([plateX + pl.x - shiftX, pl.y - shiftY, 0]);
      moved.delete();
      const part = meshPart(placedM, it.partName, it.extruder, true);
      placedM.delete();
      return { name: it.assemblyName, parts: [part] };
    });
  })();

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
      partingZMm: blockHeight,
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
      ...(flaredChannels ? { flaredChannels } : {}),
      ...(shellLocked ? { shellLocked } : {}),
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
