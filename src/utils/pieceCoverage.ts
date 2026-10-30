// Is every bit of a part's surface under some convex piece?
//
// The other measures of a decomposition look one way. filledCavities.ts finds
// pieces standing in air, and tightPieces.ts measures how far they stand
// proud of the surface. Neither notices material that no piece covers, and
// that is the worse fault: contact there goes straight into the body. A
// carved sculpt cube lost every piece under its lower half and sank 27 mm into
// the floor, and a lathed funnel's spout came out as a ring of wedges round a
// conical hole that a ball dropped into and jammed — and both reported
// nothing at all, because nothing stood proud.
//
// So the surface is sampled — every vertex and every triangle's centroid, or
// an even share of them on a big mesh — and each sample not inside some piece
// is measured to the nearest one. Pure, store-free and Worker-safe.

import type { Hull } from './csg';

export interface Coverage {
  /** How far the surface lies outside every piece, at most, metres: how far contact sinks into the body there. */
  depth: number;
  /** Where, in the mesh's frame. */
  at?: [number, number, number];
}

/** Samples at most this many surface points. */
const MAX_SAMPLES = 60_000;

interface HullPlanes { planes: Float64Array; lo: number[]; hi: number[] }

function planesOf(h: Hull): HullPlanes {
  const v = h.verts, out: number[] = [];
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) {
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[i + k]); hi[k] = Math.max(hi[k], v[i + k]); }
  }
  for (let i = 0; i < h.faces.length; i += 3) {
    const a = h.faces[i] * 3, b = h.faces[i + 1] * 3, c = h.faces[i + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
    const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-24) continue;
    nx /= len; ny /= len; nz /= len;
    out.push(nx, ny, nz, nx * v[a] + ny * v[a + 1] + nz * v[a + 2]);
  }
  return { planes: Float64Array.from(out), lo, hi };
}

/** How far outside a convex piece a point lies: its furthest plane, a lower bound on the distance and exact over a face. */
function outside(h: HullPlanes, x: number, y: number, z: number): number {
  const p = h.planes;
  let worst = -Infinity;
  for (let i = 0; i < p.length; i += 4) {
    const d = p[i] * x + p[i + 1] * y + p[i + 2] * z - p[i + 3];
    if (d > worst) worst = d;
  }
  return worst;
}

/**
 * How far the surface of a closed mesh lies outside all of `hulls`, at most.
 * Zero when every sample is within `tolerance` of a piece.
 */
export function uncoveredSurface(verts: ArrayLike<number>, faces: ArrayLike<number>, hulls: Hull[], tolerance = 1e-5): Coverage {
  if (hulls.length === 0 || faces.length === 0) return { depth: 0 };
  const pieces = hulls.map(planesOf);
  const tris = faces.length / 3;
  const samplesPer = 1 + 3; // centroid and corners
  const stride = Math.max(1, Math.ceil((tris * samplesPer) / MAX_SAMPLES));
  let depth = 0;
  let at: [number, number, number] | undefined;
  const probe = (x: number, y: number, z: number) => {
    // Covered by a piece whose box holds it: the usual case, and cheap.
    for (const h of pieces) {
      if (x < h.lo[0] - tolerance || x > h.hi[0] + tolerance || y < h.lo[1] - tolerance
        || y > h.hi[1] + tolerance || z < h.lo[2] - tolerance || z > h.hi[2] + tolerance) continue;
      if (outside(h, x, y, z) <= tolerance) return;
    }
    let nearest = Infinity;
    for (const h of pieces) nearest = Math.min(nearest, outside(h, x, y, z));
    if (nearest > depth) { depth = nearest; at = [x, y, z]; }
  };
  for (let t = 0; t < tris; t += stride) {
    const a = faces[t * 3] * 3, b = faces[t * 3 + 1] * 3, c = faces[t * 3 + 2] * 3;
    probe((verts[a] + verts[b] + verts[c]) / 3, (verts[a + 1] + verts[b + 1] + verts[c + 1]) / 3, (verts[a + 2] + verts[b + 2] + verts[c + 2]) / 3);
    probe(verts[a], verts[a + 1], verts[a + 2]);
    probe(verts[b], verts[b + 1], verts[b + 2]);
    probe(verts[c], verts[c + 1], verts[c + 2]);
  }
  return depth > tolerance && at ? { depth, at } : { depth: 0 };
}
