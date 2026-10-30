// A closed mesh to convex colliders: cut into chunks, decomposed chunk by
// chunk, and each piece pulled in to the surface it stands for.
//
// The three steps and why each is there are in chunkedDecomposition.ts and
// tightPieces.ts. This is the order they run in, the budgets they get, and
// the one place the V-HACD worker and the Node fallback both call.
//
// A lathed part skips all that: it is sliced into exact sectors about its
// axis (revolution.ts), and chunks are tried only if the sectors fill a
// cavity (a bowl's curved inside) or stand prouder than half a millimetre.
//
// Any other part with sharp inside corners is cut along them first
// (reflexCuts.ts): the cells that come out convex are exact pieces, and only
// cells still curved go on to the chunks. A part whose corners would take
// more than MAX_REFLEX_CELLS cells goes the chunked way whole.
//
// Measured on the concave-contact scenes (Node, one core), against one
// V-HACD call over the whole part at the old defaults:
//
//                     before                          after
//   two-turn chute    64 pieces, 29-42 filled, 4.4 s  ~410-480 pieces, none filled, ~18 s; a 6 mm marble rolls both turns
//   10 mm blind bore  12 pieces, clears 8.35 mm       64 sectors a tier, 0.2 s; 0.5 and 0.2 mm fits reach the floor
//   bored boss        9 pieces, 0.5 mm peg at rim     128 sectors; a 3°-tilted peg goes to the floor
//   closed drum       1 hull, dice thrown out         66 sectors, dice stay inside (40 mm of 45)
//   funnel            64 pieces, 7.1 s                ~170-290 pieces, 8-10 s
//
// And cut at sharp inside corners first, against chunks alone:
//
//                     chunks alone                    corners cut first
//   21 mm sq. pocket  66 pieces, 4.8 mm proud, 0.9 s  5 boxes, exact, 0.05 s; a 0.5 mm-clearance peg reaches the floor (was 16 mm up)
//   open-top box      99 pieces, 7.3 mm proud, 2.7 s  5 boxes, exact, 0.05 s
//   sealed box        chunked                         6 boxes, exact, 0.09 s
//   U-channel track   490 pieces, 4.2 mm proud, 9.2 s 3 curved cells (floor, walls), 348 pieces, 1.3 mm, 2.3 s
//
// Pure, store-free and Worker-safe.

import type { Hull } from './csg';
import { findFilledCavities, wallThickness, type FilledCavity } from './filledCavities';
import { tightenPieces } from './tightPieces';
import type { Chunk, ChunkPlan } from './chunkedDecomposition';
import type { ReflexCutResult } from './reflexCuts';

export interface SolidOptions {
  /** The most pieces the whole mesh may come out as. */
  maxPieces: number;
  /** Voxels per V-HACD call (per chunk). Default: enough for a wall two voxels thick, within CHUNK_VOXELS. */
  voxelResolution?: number;
  /** Stop pulling pieces in once nothing stands more than this proud, metres. Default: see toleranceFor. */
  tolerance?: number;
}

export interface SolidResult {
  hulls: Hull[];
  cavities: FilledCavity[];
  /** How far the pieces stand proud of the surface into the air, at most, metres. */
  intrusion: number;
  intrusionAt?: [number, number, number];
  chunks: number;
}

/**
 * Voxels per chunk unless asked. A chunk is small, so this is a finer grid
 * than the old 25k over a whole part — and V-HACD's time is mostly per call:
 * 0.4 to 0.5 s a chunk of the chute at 25k, much the same at 8 pieces as 16.
 */
export const CHUNK_VOXELS = 25_000;

/** Pieces V-HACD is asked for per chunk; tightPieces cuts further where the surface needs it. */
export const CHUNK_HULLS = 16;

/** Halvings V-HACD may make per chunk before merging; see DecomposeParams.maxRecursionDepth. */
export const CHUNK_RECURSION = 5;

/** Per-chunk plan: cut while 40 walls long, never below 8 walls, at most 32 chunks. */
export const SOLID_CHUNK_PLAN: ChunkPlan = { slender: 40, minWalls: 8, maxChunks: 32 };

/**
 * The thinnest piece a cut may leave: slivers only. A wall strip 3 mm wide is
 * 1.7 mm by twice its volume over its area, and must stay allowed.
 */
export const MIN_PIECE_THICKNESS = 0.0005;

// No time budget for pulling in, only the piece budget: a budget in
// milliseconds made the result depend on how busy the machine was — the
// chute came out different with two test files running at once, and a
// collider must come out the same for the same mesh, every time.

/**
 * How proud a piece may stand: a tenth of a millimetre, below which MuJoCo's
 * own contact softness is the larger error, or a two-thousandth of the part
 * for a big one.
 */
export function toleranceFor(verts: number[]): number {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < verts.length; i += 3) {
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], verts[i + k]); hi[k] = Math.max(hi[k], verts[i + k]); }
  }
  return Math.max(1e-4, Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2000);
}

function boxOf(c: Chunk, wall: number): number {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < c.verts.length; i += 3) {
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], c.verts[i + k]); hi[k] = Math.max(hi[k], c.verts[i + k]); }
  }
  return [0, 1, 2].reduce((v, k) => v * Math.max(hi[k] - lo[k], wall), 1);
}

/**
 * Sectors round a solid of revolution, or the segments it was lathed with if
 * fewer: 0.013 mm of chord on a 10.5 mm bore. At 32 (0.05 mm) a 20 mm peg
 * tilted 3° still wedged at the rim of a 21 mm bore; at 64 it went down.
 */
export const REVOLUTION_SECTORS = 64;

/** A solid of revolution's exact sectors are kept without trying chunks when they stand no prouder than this, metres. */
const SECTORS_GOOD_ENOUGH = 5e-4;

/**
 * A lathed part sliced into sectors about its axis, tier by tier between its
 * flat steps — exact, where V-HACD left a 10.5 mm bore 2.4 mm narrower — and
 * measured the same way as the chunked pieces. Null when the part was not
 * lathed, or its sectors fill a cavity (a bowl's curved inside: one tier, and
 * every sector spans it).
 */
async function sectorPieces(verts: number[], faces: number[], opts: SolidOptions, tolerance: number) {
  const { detectRevolution } = await import('./revolution');
  const rev = detectRevolution(verts, faces);
  if (!rev) return null;
  const { convexHullOf, decomposeAroundAxis, usableColliderHulls } = await import('./csg');
  let sectors = Math.max(8, Math.min(REVOLUTION_SECTORS, rev.segments || REVOLUTION_SECTORS));
  let hulls = usableColliderHulls(decomposeAroundAxis(verts, faces, rev.origin, rev.axis, sectors));
  while (hulls.length > opts.maxPieces && sectors > 8) {
    sectors = Math.max(8, Math.floor((sectors * opts.maxPieces) / hulls.length));
    hulls = usableColliderHulls(decomposeAroundAxis(verts, faces, rev.origin, rev.axis, sectors));
  }
  hulls = mergeConvexTiers(hulls, rev, convexHullOf);
  if (hulls.length < 2 || hulls.length > opts.maxPieces) return null;
  // Measured only: no cuts, and the hull of the solid in each sector is the sector.
  const tight = tightenPieces(verts, faces, hulls, { tolerance, maxPieces: hulls.length });
  const cavities = findFilledCavities(verts, faces, tight.hulls);
  if (cavities.length > 0) return null;
  return {
    hulls: tight.hulls, cavities, intrusion: tight.intrusion,
    ...(tight.intrusionAt ? { intrusionAt: tight.intrusionAt } : {}),
    chunks: 1,
  };
}

/**
 * Sectors that meet on the axis and make a convex whole between them — a
 * cup's floor, a drum's end caps — put back together as one piece. Left as
 * 64 wedges meeting at a point, an 8 mm ball dropped onto the middle of a
 * cup's floor touched all of them at once and was thrown out of the cup.
 */
function mergeConvexTiers(hulls: Hull[], rev: { origin: number[]; axis: number[] }, hullOf: (p: number[][]) => Hull | null): Hull[] {
  const a = rev.axis, o = rev.origin;
  const groups = new Map<string, Hull[]>();
  const rest: Hull[] = [];
  let reach = 0;
  for (const h of hulls) {
    for (let i = 0; i < h.verts.length; i += 3) {
      const d = [h.verts[i] - o[0], h.verts[i + 1] - o[1], h.verts[i + 2] - o[2]];
      reach = Math.max(reach, Math.hypot(d[0], d[1], d[2]));
    }
  }
  for (const h of hulls) {
    let rMin = Infinity, tLo = Infinity, tHi = -Infinity;
    for (let i = 0; i < h.verts.length; i += 3) {
      const d = [h.verts[i] - o[0], h.verts[i + 1] - o[1], h.verts[i + 2] - o[2]];
      const t = d[0] * a[0] + d[1] * a[1] + d[2] * a[2];
      rMin = Math.min(rMin, Math.hypot(d[0] - t * a[0], d[1] - t * a[1], d[2] - t * a[2]));
      tLo = Math.min(tLo, t); tHi = Math.max(tHi, t);
    }
    // Within a fiftieth of the part of the axis: on it, or round a lathe's pinhole.
    if (rMin > reach * 0.02) { rest.push(h); continue; }
    const key = `${Math.round(tLo / (reach * 1e-4))},${Math.round(tHi / (reach * 1e-4))}`;
    groups.set(key, [...(groups.get(key) ?? []), h]);
  }
  for (const group of groups.values()) {
    const whole = group.length > 1 ? hullOf(group.flatMap(h => {
      const pts: number[][] = [];
      for (let i = 0; i < h.verts.length; i += 3) pts.push([h.verts[i], h.verts[i + 1], h.verts[i + 2]]);
      return pts;
    })) : null;
    const parts = group.reduce((v, h) => v + h.volume, 0);
    if (whole && Math.abs(whole.volume) <= parts * 1.02) rest.push({ ...whole, volume: Math.abs(whole.volume) });
    else rest.push(...group);
  }
  return rest;
}

export async function decomposeSolid(verts: number[], faces: number[], opts: SolidOptions): Promise<SolidResult> {
  const tolerance = opts.tolerance ?? toleranceFor(verts);
  const sectors = opts.voxelResolution === undefined ? await sectorPieces(verts, faces, opts, tolerance) : null;
  if (sectors && sectors.intrusion <= SECTORS_GOOD_ENOUGH) return sectors;
  const exact = await reflexPieces(verts, faces, opts, tolerance);
  if (exact) return exact;
  const chunked = await chunkedPieces(verts, faces, opts, tolerance);
  return sectors && sectors.intrusion < chunked.intrusion ? sectors : chunked;
}

/**
 * Most cells the reflex-edge cuts may make before the part goes the V-HACD
 * way whole; see reflexCuts.ts.
 */
export const MAX_REFLEX_CELLS = 128;

/**
 * A part cut along its sharp inside corners (reflexCuts.ts): the convex cells
 * are exact pieces, and only cells still curved somewhere are decomposed by
 * V-HACD, each with its share of what the budget has left. Null when the part
 * has no sharp inside corner, or cutting along them would take too many
 * cells or leave too little budget for the curved ones.
 */
async function reflexPieces(verts: number[], faces: number[], opts: SolidOptions, tolerance: number): Promise<SolidResult | null> {
  let cut: ReflexCutResult | null;
  try {
    const [{ loadManifold }, { cutAtReflexEdges }] = await Promise.all([import('./sculptCut'), import('./reflexCuts')]);
    cut = cutAtReflexEdges(await loadManifold(), verts, faces, Math.min(MAX_REFLEX_CELLS, opts.maxPieces));
  } catch {
    return null;
  }
  if (!cut) return null;
  const { convexHullOf } = await import('./csg');
  const hulls: Hull[] = [];
  for (const c of cut.convex) {
    const pts: number[][] = [];
    for (let i = 0; i < c.verts.length; i += 3) pts.push([c.verts[i], c.verts[i + 1], c.verts[i + 2]]);
    const h = convexHullOf(pts);
    if (h) hulls.push({ ...h, volume: Math.abs(h.volume) });
  }
  // A curved cell gets at least a chunk's worth of pieces, or the part goes
  // the old way whole: a U-channel asked for 16 pieces split them 4, 4 and 4
  // over its floor and two walls, and the floor's 4 still spanned the
  // channel's dips.
  const left = opts.maxPieces - hulls.length;
  if (cut.rest.length > 0 && left < cut.rest.length * CHUNK_HULLS) return null;
  let chunks = cut.convex.length;
  for (const c of cut.rest) {
    const share = { ...opts, maxPieces: Math.floor(left / cut.rest.length) };
    const r = await chunkHulls(c.verts, c.faces, share);
    hulls.push(...r.hulls);
    chunks += r.chunks;
  }
  return tightened(verts, faces, hulls, opts, tolerance, chunks);
}

async function chunkedPieces(verts: number[], faces: number[], opts: SolidOptions, tolerance: number): Promise<SolidResult> {
  const { hulls, chunks } = await chunkHulls(verts, faces, opts);
  return tightened(verts, faces, hulls, opts, tolerance, chunks);
}

/** V-HACD's pieces for a closed mesh, chunk by chunk, before they are pulled in. */
async function chunkHulls(verts: number[], faces: number[], opts: SolidOptions): Promise<{ hulls: Hull[]; chunks: number }> {
  const { decomposeMesh } = await import('./vhacd');
  const wall = wallThickness(verts, faces);
  const voxels = (c: Chunk) => opts.voxelResolution
    ?? Math.round(Math.max(10_000, Math.min(CHUNK_VOXELS, boxOf(c, wall) / (wall / 2) ** 3)));
  const hullsPerChunk = Math.max(1, Math.min(CHUNK_HULLS, opts.maxPieces));
  const plan: ChunkPlan = {
    ...SOLID_CHUNK_PLAN,
    // A budget asked for is a budget for the whole part, so it bounds the chunks too.
    maxChunks: Math.max(1, Math.min(SOLID_CHUNK_PLAN.maxChunks, Math.floor(opts.maxPieces / hullsPerChunk))),
  };
  const paramsFor = (c: Chunk) => ({ maxHulls: hullsPerChunk, voxelResolution: voxels(c), maxRecursionDepth: CHUNK_RECURSION });

  try {
    const [{ loadManifold }, { decomposeInChunks }] = await Promise.all([import('./sculptCut'), import('./chunkedDecomposition')]);
    const wasm = await loadManifold();
    const chunked = await decomposeInChunks(wasm, verts, faces, decomposeMesh, paramsFor, plan);
    if (chunked) return { hulls: chunked.hulls, chunks: chunked.chunks };
  } catch {
    // Manifold would not load, or would not take the mesh: decompose it whole.
  }
  return { hulls: await decomposeMesh(verts, faces, paramsFor({ verts, faces })), chunks: 1 };
}

/** Every piece pulled in to the surface of the whole mesh, and measured against it. */
function tightened(verts: number[], faces: number[], hulls: Hull[], opts: SolidOptions, tolerance: number, chunks: number): SolidResult {
  const tight = tightenPieces(verts, faces, hulls, {
    tolerance,
    maxPieces: Math.max(hulls.length, opts.maxPieces),
    minThickness: MIN_PIECE_THICKNESS,
  });
  const cavities = findFilledCavities(verts, faces, tight.hulls);
  return {
    hulls: tight.hulls, cavities, intrusion: tight.intrusion,
    ...(tight.intrusionAt ? { intrusionAt: tight.intrusionAt } : {}),
    chunks,
  };
}
