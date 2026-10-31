// ---------------------------------------------------------------------------
// Mold geometry shared by the mold builders
// ---------------------------------------------------------------------------
//
// The pieces of the mold build both mold builders need: turning the part's
// triangle soup into a Manifold solid and a solid back into triangles, and the
// STL writer. Kept out of moldExporter.ts so the dissolvable-liner build
// (moldLiner.ts) can use them without importing the exporter, which imports it:
// a circular import is what twice broke the worker bundle in production.
// ---------------------------------------------------------------------------

import type { ManifoldToplevel, Manifold } from 'manifold-3d';
import { toManifold } from './sculptCut';
import { createSculptMesh } from './sculptMesh';
import { repairMesh } from './meshRepair';

export interface Triangle3D {
  a: [number, number, number];
  b: [number, number, number];
  c: [number, number, number];
  normal?: [number, number, number];
}

/** Compute face normal of a 3D triangle. */
export function computeNormal(a: [number, number, number], b: [number, number, number], c: [number, number, number]): [number, number, number] {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

export type Mat4Tuple = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number
];

export function manifoldToTriangles(m: Manifold): Triangle3D[] {
  const mesh = m.getMesh();
  const tris: Triangle3D[] = [];
  const numTris = mesh.triVerts.length / 3;
  const stride = mesh.numProp;
  const p = mesh.vertProperties;
  for (let t = 0; t < numTris; t++) {
    const i0 = mesh.triVerts[t * 3];
    const i1 = mesh.triVerts[t * 3 + 1];
    const i2 = mesh.triVerts[t * 3 + 2];
    if (i0 === i1 || i1 === i2 || i0 === i2) continue;
    const a: [number, number, number] = [p[i0 * stride], p[i0 * stride + 1], p[i0 * stride + 2]];
    const b: [number, number, number] = [p[i1 * stride], p[i1 * stride + 1], p[i1 * stride + 2]];
    const c: [number, number, number] = [p[i2 * stride], p[i2 * stride + 1], p[i2 * stride + 2]];
    if (
      (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) ||
      (b[0] === c[0] && b[1] === c[1] && b[2] === c[2]) ||
      (a[0] === c[0] && a[1] === c[1] && a[2] === c[2])
    ) {
      continue;
    }
    tris.push({ a, b, c, normal: computeNormal(a, b, c) });
  }
  return tris;
}

/**
 * The part as one Manifold solid, or the solids (by id) that no repair could
 * close. All or nothing: a mold cut from the bodies that did close would be
 * missing the others, and a lined mold would fill their space with PVA.
 */
export interface PartManifold {
  part: Manifold | null;
  unsolid: number[];
}

export function buildPartManifold(
  wasm: ManifoldToplevel,
  tris: Float64Array,
  solidIds?: number[]
): PartManifold {
  const triCount = tris.length / 9;
  if (triCount === 0) return { part: null, unsolid: [] };

  const groups = new Map<number, number[]>();
  for (let t = 0; t < triCount; t++) {
    const sid = solidIds && solidIds.length === triCount ? solidIds[t] : 0;
    let g = groups.get(sid);
    if (!g) {
      g = [];
      groups.set(sid, g);
    }
    g.push(t);
  }

  let combined: Manifold | null = null;

  const unsolid: number[] = [];
  for (const [sid, triIndices] of groups) {
    const vMap = new Map<string, number>();
    const positions: number[] = [];
    const faces: number[] = [];

    for (const t of triIndices) {
      const i = t * 9;
      const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
      const bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5];
      const cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];

      const d1x = bx - ax, d1y = by - ay, d1z = bz - az;
      const d2x = cx - ax, d2y = cy - ay, d2z = cz - az;
      const cpx = d1y * d2z - d1z * d2y;
      const cpy = d1z * d2x - d1x * d2z;
      const cpz = d1x * d2y - d1y * d2x;
      if (cpx * cpx + cpy * cpy + cpz * cpz < 1e-12) continue;

      const ka = `${Math.round(ax * 1000)},${Math.round(ay * 1000)},${Math.round(az * 1000)}`;
      const kb = `${Math.round(bx * 1000)},${Math.round(by * 1000)},${Math.round(bz * 1000)}`;
      const kc = `${Math.round(cx * 1000)},${Math.round(cy * 1000)},${Math.round(cz * 1000)}`;
      if (ka === kb || kb === kc || ka === kc) continue;

      let va = vMap.get(ka);
      if (va === undefined) {
        va = positions.length / 3;
        vMap.set(ka, va);
        positions.push(ax, ay, az);
      }
      let vb = vMap.get(kb);
      if (vb === undefined) {
        vb = positions.length / 3;
        vMap.set(kb, vb);
        positions.push(bx, by, bz);
      }
      let vc = vMap.get(kc);
      if (vc === undefined) {
        vc = positions.length / 3;
        vMap.set(kc, vc);
        positions.push(cx, cy, cz);
      }
      faces.push(va, vb, vc);
    }

    if (faces.length < 3) continue;

    let solidManifold: Manifold | null = null;
    const sculptMesh = createSculptMesh(positions, faces);
    const mRes = toManifold(wasm, sculptMesh);
    if (mRes.ok) {
      solidManifold = mRes.manifold;
    } else {
      const repaired = repairMesh(positions, faces, {
        weldTolerance: 0.02,
        fillHoles: true,
        fixWinding: true,
      });
      if (repaired.faces.length >= 12) {
        const rMesh = createSculptMesh(repaired.positions, repaired.faces);
        const rRes = toManifold(wasm, rMesh);
        if (rRes.ok) {
          solidManifold = rRes.manifold;
        }
      }
      if (!solidManifold) {
        try {
          const direct = new wasm.Manifold(
            new wasm.Mesh({
              numProp: 3,
              vertProperties: Float32Array.from(positions),
              triVerts: Uint32Array.from(faces),
            })
          );
          if (direct.status() === 'NoError') {
            solidManifold = direct;
          } else {
            direct.delete();
          }
        } catch {
          solidManifold = null;
        }
      }
    }

    if (!solidManifold) {
      unsolid.push(sid);
      continue;
    }

    if (!combined) {
      combined = solidManifold;
    } else {
      const next: Manifold = combined.add(solidManifold);
      combined.delete();
      solidManifold.delete();
      combined = next;
    }
  }

  if (unsolid.length === 0 && combined && combined.status() === 'NoError' && !combined.isEmpty()) {
    return { part: combined, unsolid };
  }
  combined?.delete();
  return { part: null, unsolid };
}

/**
 * Why the part could not be made solid, naming the bodies that would not close
 * when there are any; `what` is the mold that needed it.
 */
export function unsolidPartRefusal(unsolid: number[], solidNames: string[] | undefined, what: string): string {
  const names = [...new Set(unsolid.map((sid) => solidNames?.[sid]).filter((n): n is string => Boolean(n)))];
  if (names.length === 0) return `The part could not be made into a solid for ${what}; repair the mesh and try again.`;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return (
    `${list} ${names.length === 1 ? 'is' : 'are'} not a closed solid even after repair, so ${what} cannot hold ` +
    `${names.length === 1 ? 'it' : 'them'}; repair the mesh or delete ${names.length === 1 ? 'it' : 'them'} and try again.`
  );
}

/**
 * Fast IEEE-754 Little-Endian Binary STL generator.
 * Standard format: 80-byte header + 4-byte uint32 triangle count + 50 bytes per triangle.
 */
export function exportBinarySTL(triangles: Triangle3D[], headerText = 'PhysBox 3D Mold Exporter'): Uint8Array {
  const triCount = triangles.length;
  const bufferSize = 80 + 4 + triCount * 50;
  const buffer = new ArrayBuffer(bufferSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // 80-byte ASCII header
  const title = headerText.slice(0, 79);
  for (let i = 0; i < title.length; i++) {
    bytes[i] = title.charCodeAt(i);
  }

  // 4-byte little-endian triangle count
  view.setUint32(80, triCount, true);

  let offset = 84;
  for (let i = 0; i < triCount; i++) {
    const tri = triangles[i];
    const norm = tri.normal ?? computeNormal(tri.a, tri.b, tri.c);

    // Normal vector [nx, ny, nz]
    view.setFloat32(offset, norm[0], true);
    view.setFloat32(offset + 4, norm[1], true);
    view.setFloat32(offset + 8, norm[2], true);

    // Vertex A [x, y, z]
    view.setFloat32(offset + 12, tri.a[0], true);
    view.setFloat32(offset + 16, tri.a[1], true);
    view.setFloat32(offset + 20, tri.a[2], true);

    // Vertex B [x, y, z]
    view.setFloat32(offset + 24, tri.b[0], true);
    view.setFloat32(offset + 28, tri.b[1], true);
    view.setFloat32(offset + 32, tri.b[2], true);

    // Vertex C [x, y, z]
    view.setFloat32(offset + 36, tri.c[0], true);
    view.setFloat32(offset + 40, tri.c[1], true);
    view.setFloat32(offset + 44, tri.c[2], true);

    // 2-byte attribute byte count (0)
    view.setUint16(offset + 48, 0, true);

    offset += 50;
  }

  return bytes;
}

export function boundsOf(tris: Triangle3D[]) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const t of tris) {
    for (const v of [t.a, t.b, t.c]) {
      if (v[0] < minX) minX = v[0];
      if (v[0] > maxX) maxX = v[0];
      if (v[1] < minY) minY = v[1];
      if (v[1] > maxY) maxY = v[1];
      if (v[2] < minZ) minZ = v[2];
      if (v[2] > maxZ) maxZ = v[2];
    }
  }
  if (tris.length === 0) return { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  return { minX, minY, minZ, maxX, maxY, maxZ };
}
