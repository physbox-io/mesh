// A Manifold result as a printed part's mesh, clean the way a slicer needs it.

import type { Manifold } from 'manifold-3d';

/**
 * What a Manifold result is simplified by before it becomes a printed part,
 * mm. Booleans leave zero-area slivers along their seams that are manifold by
 * vertex index but collapse once a slicer welds vertices by position, which it
 * reports as hundreds of non-manifold edges. A micron is far under anything a
 * printer draws, and takes them all out.
 */
export const PRINTED_MESH_CLEAN_MM = 1e-3;

/**
 * `m`'s mesh without the seam slivers, and without the shells of no volume
 * that simplifying leaves where a sliver was: positions (xyz, mm) and faces.
 */
export function printedMeshOf(m: Manifold): { positions: number[]; faces: number[] } {
  const clean = m.simplify(PRINTED_MESH_CLEAN_MM);
  const parts = clean.decompose();
  const kept = parts.length > 1 ? parts.filter((p) => Math.abs(p.volume()) > 1e-6) : parts;
  const positions: number[] = [];
  const faces: number[] = [];
  for (const p of kept.length ? kept : parts) {
    const mesh = p.getMesh();
    const base = positions.length / 3;
    for (let i = 0; i < mesh.numVert; i++) {
      positions.push(mesh.vertProperties[i * mesh.numProp], mesh.vertProperties[i * mesh.numProp + 1], mesh.vertProperties[i * mesh.numProp + 2]);
    }
    for (let i = 0; i < mesh.triVerts.length; i++) faces.push(mesh.triVerts[i] + base);
  }
  for (const p of parts) p.delete();
  clean.delete();
  return { positions, faces };
}
