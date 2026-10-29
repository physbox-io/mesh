// A mesh cut into closed chunks before V-HACD sees it.
//
// Handing V-HACD a whole part in one call gives it one voxel grid over the
// part's whole bounding box, one piece budget, and one flood fill from
// outside, and each of those failed a shape:
//
// * A helical chute (R 60 mm, two turns, 2.5 mm walls) has a 140 x 140 x
//   160 mm box, so it read as compact and got the compact budget: 64 pieces,
//   29 to 42 of them filling its channel. Its length hides in the coil.
// * Its voxels were sized by that box, and the floor came out stepped by
//   about a voxel: 6 mm marbles stopped dead on an 11° slope ~2.7 mm above
//   the true floor, even at 384 pieces.
// * A closed drum's inside cannot be reached by a flood from outside, so it
//   filled solid — one hull — and dice inside it were thrown out.
//
// Cutting first answers all three. Each chunk is measured afresh, so a
// quarter of a coil is long and thin no longer and a part is cut until none
// of it is; each chunk gets its own voxel grid, so voxels shrink with it; no
// piece can span a cut; and a cut through a sealed hollow opens it, so the
// flood fill reaches it from the cut face. A chunk is cut again while it is
// still slender for its wall, or while its decomposition still fills a
// cavity — which is how a sealed hollow announces itself: filledCavities.ts
// finds a hull standing in air that fills its whole box.
//
// The cuts are Manifold's (manifold-3d's splitByPlane), which hands back two
// closed, capped halves; a chunk Manifold will not take is decomposed whole,
// as before. Deterministic: the same mesh is cut the same way, always at the
// middle of a chunk's longest side.
//
// Pure, store-free and Worker-safe; the V-HACD worker runs it, and Node runs
// it inline for the tests and the preset exporter.

import type { ManifoldToplevel, Manifold } from 'manifold-3d';
import type { Hull } from './csg';
import type { DecomposeParams } from './vhacd';
import { findFilledCavities, wallThickness, type FilledCavity } from './filledCavities';

/** Millimetres inside Manifold: its tolerances are relative, and every figure here is a millimetre one. */
const MM = 1000;

export interface Chunk { verts: number[]; faces: number[] }

export interface ChunkPlan {
  /** Cut while a chunk is at least this long for its wall. */
  slender: number;
  /** Never cut a chunk whose longest side is under this many wall thicknesses. */
  minWalls: number;
  /** Stop cutting at this many chunks. */
  maxChunks: number;
}

export const DEFAULT_CHUNK_PLAN: ChunkPlan = { slender: 40, minWalls: 8, maxChunks: 32 };

function bounds(v: ArrayLike<number>) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) {
    for (let k = 0; k < 3; k++) { if (v[i + k] < lo[k]) lo[k] = v[i + k]; if (v[i + k] > hi[k]) hi[k] = v[i + k]; }
  }
  return { lo, hi };
}

export function toManifoldSolid(wasm: ManifoldToplevel, verts: number[], faces: number[]): Manifold | null {
  const used = new Int32Array(verts.length / 3).fill(-1);
  const pos: number[] = [];
  const tri = new Uint32Array(faces.length);
  for (let i = 0; i < faces.length; i++) {
    const v = faces[i];
    if (used[v] < 0) { used[v] = pos.length / 3; pos.push(verts[v * 3] * MM, verts[v * 3 + 1] * MM, verts[v * 3 + 2] * MM); }
    tri[i] = used[v];
  }
  try {
    const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: Float32Array.from(pos), triVerts: tri }));
    if (m.status() !== 'NoError' || m.isEmpty()) { m.delete(); return null; }
    return m;
  } catch {
    return null;
  }
}

export function fromManifold(m: Manifold): Chunk {
  const mesh = m.getMesh();
  const verts = new Array<number>(mesh.numVert * 3);
  for (let v = 0; v < mesh.numVert; v++) {
    for (let k = 0; k < 3; k++) verts[v * 3 + k] = mesh.vertProperties[v * mesh.numProp + k] / MM;
  }
  return { verts, faces: Array.from(mesh.triVerts) };
}

/** Halves at the middle of the longest side, or null when Manifold makes nothing of it. */
export function bisect(m: Manifold): [Manifold, Manifold] | null {
  const b = m.boundingBox();
  const size = [0, 1, 2].map(k => b.max[k] - b.min[k]);
  const k = size.indexOf(Math.max(...size));
  const n: [number, number, number] = [0, 0, 0];
  n[k] = 1;
  const [pos, neg] = m.splitByPlane(n, (b.min[k] + b.max[k]) / 2);
  if (pos.isEmpty() || neg.isEmpty()) { pos.delete(); neg.delete(); return null; }
  return [pos, neg];
}

/** How long a chunk is for its wall, read off its own box. */
export function chunkSlenderness(c: Chunk, wall: number): number {
  const { lo, hi } = bounds(c.verts);
  return Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / wall;
}

export interface ChunkedResult {
  hulls: Hull[];
  cavities: FilledCavity[];
  /** How many chunks the mesh was cut into; 1 when it was not cut. */
  chunks: number;
}

type Decompose = (verts: number[], faces: number[], params: Partial<DecomposeParams>) => Promise<Hull[]>;

/**
 * Decomposes a closed mesh chunk by chunk. `paramsFor` picks each chunk's
 * V-HACD budget from the chunk itself; `wall` is the whole part's wall
 * thickness, which a cut does not change.
 */
export async function decomposeInChunks(
  wasm: ManifoldToplevel,
  verts: number[],
  faces: number[],
  decompose: Decompose,
  paramsFor: (chunk: Chunk) => Partial<DecomposeParams>,
  plan: ChunkPlan = DEFAULT_CHUNK_PLAN,
): Promise<ChunkedResult | null> {
  const wall = wallThickness(verts, faces);
  const root = toManifoldSolid(wasm, verts, faces);
  if (!root || !(wall > 0)) { root?.delete(); return null; }

  const done: { hulls: Hull[]; cavities: FilledCavity[] }[] = [];
  // Breadth first, so the budget of chunks is spent evenly over the part.
  let queue: Manifold[] = [root];
  let next: Manifold[] = [];
  let chunks = 1;
  try {
    while (queue.length) {
      next = [];
      while (queue.length) {
        const m = queue.shift()!;
        const chunk = fromManifold(m);
        const { lo, hi } = bounds(chunk.verts);
        const longest = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
        const canCut = longest >= plan.minWalls * wall && chunks < plan.maxChunks;
        if (canCut && longest / wall >= plan.slender) {
          const halves = bisect(m);
          if (halves) { m.delete(); next.push(...halves); chunks++; continue; }
        }
        const hulls = await decompose(chunk.verts, chunk.faces, paramsFor(chunk));
        const cavities = findFilledCavities(chunk.verts, chunk.faces, hulls);
        if (cavities.length > 0 && canCut) {
          const halves = bisect(m);
          if (halves) { m.delete(); next.push(...halves); chunks++; continue; }
        }
        m.delete();
        done.push({ hulls, cavities });
      }
      queue = next;
    }
  } finally {
    // Whatever was not decomposed when something threw: each is deleted once.
    for (const m of new Set([...queue, ...next])) m.delete();
  }
  // Cavities are named by piece index, so they are renumbered into the whole list.
  const hulls: Hull[] = [];
  const cavities: FilledCavity[] = [];
  for (const d of done) {
    for (const c of d.cavities) cavities.push({ ...c, coveredBy: c.coveredBy + hulls.length });
    hulls.push(...d.hulls);
  }
  return { hulls, cavities: cavities.sort((p, q) => q.volumeMm3 - p.volumeMm3), chunks };
}
