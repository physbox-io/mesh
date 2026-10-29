// Shards of the body itself, not of its convex hull.
//
// utils/fracture.ts cuts Voronoi cells of the CONVEX HULL, which is exact for a
// box, a plate or a ball and wrong for anything concave: a chair shattered
// into ten shards that tiled its hull, so the air between and under its legs
// became solid pieces and it settled as a brick. Here each cell is intersected
// with the real solid (manifold-3d, as Scissors uses), and every connected
// piece of what is left is a shard. A cell that falls in the air between the
// legs is empty and goes; one that takes the tops of two legs gives two.
//
// Seeds are placed inside the solid, so the pieces asked for are pieces of
// material rather than empty cells. The shards' volumes are the true volumes,
// and buildShatterGraph shares the body's mass out by them, so the total is
// still the body's.
//
// A shard of a concave body need not itself be convex (a seat corner with the
// top of a leg under it is an L), and collides as its hull, which is a far
// smaller error than the whole chair's hull was. Worker-free, like fracture.ts:
// the fracture worker calls it, and so do the tests.

import type { ManifoldToplevel, Manifold as ManifoldT } from 'manifold-3d';
import { convexHullOf, meshVolumeAndCentroid } from './csg';
import { clampPieces, seedPoints, voronoiCells, DEFAULT_FRACTURE_PIECES, type FractureCell, type SeedOptions } from './fracture';

/** Over this solidity (volume / hull volume) the hull cells are already the body's. */
const CONVEX_ENOUGH = 0.985;
/** A piece smaller than this share of the body is a fleck, not a shard. */
const MIN_SHARD_SHARE = 1e-3;
/** Rounds of fresh seeds tried when too many land outside the solid. */
const SEED_ROUNDS = 12;

/** Whether `p` is inside the closed mesh, by the parity of a ray's crossings. */
export function insideMesh(verts: ArrayLike<number>, faces: ArrayLike<number>, p: number[]): boolean {
  // A slightly skewed direction, so the ray does not run along a grid edge.
  const d = [0.8726, 0.3141, 0.3741];
  let crossings = 0;
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f] * 3, b = faces[f + 1] * 3, c = faces[f + 2] * 3;
    const e1 = [verts[b] - verts[a], verts[b + 1] - verts[a + 1], verts[b + 2] - verts[a + 2]];
    const e2 = [verts[c] - verts[a], verts[c + 1] - verts[a + 1], verts[c + 2] - verts[a + 2]];
    const h = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
    const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
    if (Math.abs(det) < 1e-18) continue;
    const inv = 1 / det;
    const s = [p[0] - verts[a], p[1] - verts[a + 1], p[2] - verts[a + 2]];
    const u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) * inv;
    if (u < 0 || u > 1) continue;
    const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
    const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) * inv;
    if (v < 0 || u + v > 1) continue;
    if ((e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv > 0) crossings++;
  }
  return crossings % 2 === 1;
}

/** Seeds as fracture.ts places them, kept only where there is material. */
export function seedsInside(verts: number[], faces: number[], opts: SeedOptions): [number, number, number][] {
  const want = clampPieces(opts.pieces ?? DEFAULT_FRACTURE_PIECES);
  const out: [number, number, number][] = [];
  for (let round = 0; round < SEED_ROUNDS && out.length < want; round++) {
    const batch = seedPoints(verts, { ...opts, pieces: want, seed: (opts.seed ?? 1) + round * 7919 });
    for (const p of batch) {
      if (out.length >= want) break;
      if (insideMesh(verts, faces, p)) out.push(p);
    }
  }
  return out;
}

function solidOf(wasm: ManifoldToplevel, verts: number[], faces: number[]): ManifoldT | null {
  try {
    const mesh = new wasm.Mesh({ numProp: 3, vertProperties: Float32Array.from(verts), triVerts: Uint32Array.from(faces) });
    mesh.merge();
    const solid = new wasm.Manifold(mesh);
    if (solid.status() !== 'NoError' || solid.isEmpty()) { solid.delete(); return null; }
    return solid;
  } catch {
    return null;
  }
}

function cellOf(part: ManifoldT): FractureCell | null {
  const out = part.getMesh();
  const verts: number[] = [];
  for (let v = 0; v < out.numVert; v++) {
    verts.push(out.vertProperties[v * out.numProp], out.vertProperties[v * out.numProp + 1], out.vertProperties[v * out.numProp + 2]);
  }
  const faces = Array.from(out.triVerts);
  const { volume, centroid } = meshVolumeAndCentroid(verts, faces);
  return volume > 0 ? { verts, faces, volume, centroid } : null;
}

/**
 * The body's shards: Voronoi cells of the real solid, each connected piece of a
 * cell its own shard. Falls back to the hull's cells (fracture.ts) for a body
 * that is convex already or that Manifold will not take as a solid (an open
 * mesh), which is what every body got before.
 */
export function fractureSolid(
  wasm: ManifoldToplevel,
  verts: number[],
  faces: number[],
  opts: SeedOptions = {},
): FractureCell[] {
  const hull = convexHullOf(Array.from({ length: verts.length / 3 }, (_, i) => [verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]]));
  const solid = solidOf(wasm, verts, faces);
  const hullCells = () => voronoiCells(verts, faces, seedPoints(verts, opts));
  if (!solid || !hull) { solid?.delete(); return hullCells(); }
  const volume = solid.volume();
  if (volume / hull.volume > CONVEX_ENOUGH) { solid.delete(); return hullCells(); }

  const cells = voronoiCells(verts, faces, seedsInside(verts, faces, opts));
  const shards: FractureCell[] = [];
  try {
    for (const cell of cells) {
      const points: [number, number, number][] = [];
      for (let i = 0; i < cell.verts.length; i += 3) points.push([cell.verts[i], cell.verts[i + 1], cell.verts[i + 2]]);
      const region = wasm.Manifold.hull(points);
      const piece = solid.intersect(region);
      region.delete();
      const parts = piece.decompose();
      piece.delete();
      for (const part of parts) {
        if (part.volume() >= volume * MIN_SHARD_SHARE) {
          const shard = cellOf(part);
          if (shard) shards.push(shard);
        }
        part.delete();
      }
    }
  } finally {
    solid.delete();
  }
  // A cell can fall across two parts of the body and give two shards; past
  // twice what was asked for, the smallest go (their mass goes with the rest,
  // which buildShatterGraph shares out by volume), or the shard budget the
  // store set would be overrun.
  const cap = 2 * clampPieces(opts.pieces ?? DEFAULT_FRACTURE_PIECES);
  if (shards.length > cap) shards.sort((a, b) => b.volume - a.volume).length = cap;
  // A cut that came to nothing usable is no reason not to break at all.
  return shards.length >= 2 ? shards : hullCells();
}
