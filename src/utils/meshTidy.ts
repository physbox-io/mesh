// Closing up the meshes that are closed in every way but their bookkeeping.
//
// Two shapes arrive looking open, or inside out, when they are neither:
//
// * A solid of revolution whose profile reaches the axis. OpenSCAD's
//   `rotate_extrude() polygon([[0,0], ..., [0,t]])` is how a bowl or a cup is
//   normally written, and it emits one vertex per segment at each point on the
//   axis. Welded (the SCAD worker welds by position), every quad of the fans
//   there loses a corner and becomes a zero-area triangle with two equal
//   indices: 256 of them on a 64-segment bowl. Such a mesh is watertight as a
//   surface, but analyzeMesh counts each collapsed triangle against `closed`,
//   so decomposition refused it as having holes, and it collided and was
//   weighed as its hull — 0.64 kg instead of about 0.07.
//
// * A closed mesh wound consistently but inward, as a `polyhedron` with its
//   faces listed counter-clockwise comes out. There is nothing ambiguous about
//   it: every face is the wrong way round, so turning every face over is the
//   whole fix. Left alone it is drawn see-through (the winding trap in
//   CLAUDE.md) and was refused for decomposition with the message meant for a
//   mesh wound both ways.
//
// Pure, Worker-safe and store-free: the SCAD worker calls it on every compile
// and the decomposer on every mesh it is handed, including meshes saved
// before either did.

import { analyzeMesh, type MeshIntegrity } from './meshIntegrity';

/** The triangles that still have three different corners. */
export function dropCollapsedTriangles(faces: number[]): number[] {
  let collapsed = false;
  for (let i = 0; i < faces.length && !collapsed; i += 3) {
    collapsed = faces[i] === faces[i + 1] || faces[i + 1] === faces[i + 2] || faces[i] === faces[i + 2];
  }
  if (!collapsed) return faces;
  const out: number[] = [];
  for (let i = 0; i < faces.length; i += 3) {
    const a = faces[i], b = faces[i + 1], c = faces[i + 2];
    if (a !== b && b !== c && a !== c) out.push(a, b, c);
  }
  return out;
}

/**
 * Faces re-indexed so that vertices at the same position (to `quantum`, in
 * the mesh's units) share one index. The vertex array is left as it is: an
 * index that is no longer used costs nothing, and keeping the array means a
 * caller holding a parallel copy (Y-up beside Z-up) can keep it.
 */
export function weldFaces(verts: ArrayLike<number>, faces: number[], quantum = 1e-9): number[] {
  const q = 1 / quantum;
  const first = new Map<string, number>();
  const remap = new Int32Array(verts.length / 3);
  let changed = false;
  for (let i = 0; i < remap.length; i++) {
    const key = `${Math.round(verts[i * 3] * q)},${Math.round(verts[i * 3 + 1] * q)},${Math.round(verts[i * 3 + 2] * q)}`;
    const seen = first.get(key);
    if (seen === undefined) { first.set(key, i); remap[i] = i; } else { remap[i] = seen; changed = true; }
  }
  if (!changed) return faces;
  return faces.map(f => remap[f]);
}

/** Every face turned over. */
export function flipFaces(faces: number[]): number[] {
  const out = faces.slice();
  for (let i = 0; i < out.length; i += 3) { out[i + 1] = faces[i + 2]; out[i + 2] = faces[i + 1]; }
  return out;
}

export interface TidyResult {
  faces: number[];
  /** Zero-area triangles dropped: collapsed by the weld, or already. */
  dropped: number;
  /** True when every face was turned over, because the whole closed mesh was inside out. */
  flipped: boolean;
  /** analyzeMesh of the tidied mesh; null when empty or too big to check. */
  integrity: MeshIntegrity | null;
}

/**
 * Welds, drops the triangles that collapse, and turns a uniformly inside-out
 * closed mesh the right way out. A mesh that is open or wound both ways keeps
 * its winding: which way it should face cannot be told from it. A `quantum`
 * of null is for a mesh already welded.
 */
export function tidyMesh(verts: ArrayLike<number>, faces: number[], quantum: number | null = 1e-9): TidyResult {
  const welded = dropCollapsedTriangles(quantum === null ? faces : weldFaces(verts, faces, quantum));
  const dropped = (faces.length - welded.length) / 3;
  let integrity = analyzeMesh(verts, welded);
  let out = welded;
  let flipped = false;
  if (integrity && integrity.closed && integrity.consistentlyWound && integrity.volume < 0) {
    out = flipFaces(welded);
    flipped = true;
    integrity = { ...integrity, volume: -integrity.volume };
  }
  return { faces: out, dropped, flipped, integrity };
}
