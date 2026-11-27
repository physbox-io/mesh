// A Manifold result as a printed part's mesh, clean the way a slicer needs it.

import type { Manifold } from 'manifold-3d';
import { analyzeMesh, weldByPosition } from './meshIntegrity';

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
export function printedMeshOf(m: Manifold, simplifyMm = PRINTED_MESH_CLEAN_MM): { positions: number[]; faces: number[] } {
  const clean = m.simplify(simplifyMm);
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

/**
 * Welds vertices coinciding within `epsMm` (or exact float32 when `epsMm <= 0`),
 * drops triangles collapsed by the weld and opposing zero-volume pairs, and
 * compacts unused vertices. Returns null if the result (in mm or after
 * float32-metre welding as `sceneSummary` / binary STL reads it) is not a
 * closed, consistently-wound positive-volume solid.
 */
export function weldAndCleanMesh(
  raw: { positions: ArrayLike<number>; faces: ArrayLike<number> },
  epsMm: number,
): { positions: number[]; faces: number[] } | null {
  const nVerts = raw.positions.length / 3;
  if (nVerts === 0 || raw.faces.length === 0) return { positions: [], faces: [] };
  const ids = new Map<string, number>();
  const remap = new Uint32Array(nVerts);
  const pos: number[] = [];
  const inv = epsMm > 0 ? 1 / epsMm : 0;
  for (let v = 0; v < nVerts; v++) {
    const rx = raw.positions[v * 3];
    const ry = raw.positions[v * 3 + 1];
    const rz = raw.positions[v * 3 + 2];
    const qx = inv > 0 ? Math.round(rx * inv) : Math.fround(rx);
    const qy = inv > 0 ? Math.round(ry * inv) : Math.fround(ry);
    const qz = inv > 0 ? Math.round(rz * inv) : Math.fround(rz);
    const key = `${qx},${qy},${qz}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
      pos.push(inv > 0 ? qx * epsMm : qx, inv > 0 ? qy * epsMm : qy, inv > 0 ? qz * epsMm : qz);
    }
    remap[v] = id;
  }

  const tris: [number, number, number][] = [];
  const canonMap = new Map<string, number[]>();
  const alive: boolean[] = [];
  for (let i = 0; i + 2 < raw.faces.length; i += 3) {
    const a = remap[raw.faces[i]];
    const b = remap[raw.faces[i + 1]];
    const c = remap[raw.faces[i + 2]];
    if (a === b || b === c || a === c) continue;
    const s0 = a < b ? (a < c ? a : c) : (b < c ? b : c);
    const s2 = a > b ? (a > c ? a : c) : (b > c ? b : c);
    const s1 = a + b + c - s0 - s2;
    const key = `${s0},${s1},${s2}`;
    const existing = canonMap.get(key);
    let cancelled = false;
    if (existing) {
      for (let k = 0; k < existing.length; k++) {
        const idx = existing[k];
        if (!alive[idx]) continue;
        const [ea, eb, ec] = tris[idx];
        const sameWinding =
          (a === ea && b === eb && c === ec) ||
          (a === eb && b === ec && c === ea) ||
          (a === ec && b === ea && c === eb);
        if (!sameWinding) {
          alive[idx] = false;
          cancelled = true;
          break;
        }
      }
    }
    if (!cancelled) {
      const idx = tris.length;
      tris.push([a, b, c]);
      alive.push(true);
      if (existing) existing.push(idx);
      else canonMap.set(key, [idx]);
    }
  }

  const used = new Int32Array(pos.length / 3).fill(-1);
  const outPositions: number[] = [];
  const outFaces: number[] = [];
  for (let i = 0; i < tris.length; i++) {
    if (!alive[i]) continue;
    const tri = tris[i];
    for (let k = 0; k < 3; k++) {
      const oldIdx = tri[k];
      let newIdx = used[oldIdx];
      if (newIdx === -1) {
        newIdx = outPositions.length / 3;
        used[oldIdx] = newIdx;
        outPositions.push(pos[oldIdx * 3], pos[oldIdx * 3 + 1], pos[oldIdx * 3 + 2]);
      }
      outFaces.push(newIdx);
    }
  }
  const check = analyzeMesh(outPositions, outFaces);
  if (!check || !check.closed || !check.consistentlyWound || check.volume <= 0) return null;
  // Also verify float32-metre welding (as sceneSummary and binary STL read it).
  const metres = new Float32Array(outPositions.length);
  for (let i = 0; i < outPositions.length; i++) metres[i] = outPositions[i] / 1000;
  const weldedM = weldByPosition(metres, outFaces);
  const checkM = analyzeMesh(weldedM.positions, weldedM.faces);
  if (!checkM || !checkM.closed || !checkM.consistentlyWound || checkM.volume <= 0) return null;
  return { positions: outPositions, faces: outFaces };
}

/**
 * Extracts a Manifold solid as a watertight, float32-clean triangle mesh in mm,
 * or returns null if no weld epsilon produces a closed manifold mesh.
 */
export function tryCleanManifoldMesh(m: Manifold): { positions: number[]; faces: number[] } | null {
  for (const simplifyMm of [PRINTED_MESH_CLEAN_MM, 2e-3, 5e-3]) {
    const raw = printedMeshOf(m, simplifyMm);
    for (const eps of [1e-4, 5e-4, 1e-3, 1e-5, 0]) {
      const cleaned = weldAndCleanMesh(raw, eps);
      if (cleaned) return cleaned;
    }
  }
  return null;
}

/**
 * Extracts a Manifold solid as a cleaned triangle mesh in mm (falling back to
 * `printedMeshOf` only if no simplify + weld pass closes it).
 */
export function cleanManifoldMesh(m: Manifold): { positions: number[]; faces: number[] } {
  return tryCleanManifoldMesh(m) ?? printedMeshOf(m);
}
