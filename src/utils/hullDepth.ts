// How far a mesh's surface lies inside its own convex hull.
//
// Solidity (true volume over hull volume) says how much of a part is air, not
// whether any of it is air something could go into: a 20 mm bore in a 60 mm
// block is 8% of the block, so the block read as convex and its bore as solid.
// Depth does not care how small the hole is next to the part. A faceted sphere
// is 0, and a blind or a through bore is as deep as its walls are from the
// block's outside.
//
// Pure, store-free and Worker-safe.

import type { Hull } from './csg';

/** A hull's own vertices lie within this of its sides, metres. */
const HULL_SLACK = 1e-6;

/** Hull vertices a plane is checked against, and surface points measured, at most. */
const MAX_SAMPLES = 2000;
const MAX_SURFACE_SAMPLES = 20_000;

export interface HullPlane { n: [number, number, number]; d: number }

/**
 * The hull's sides. A plane something of the hull lies outside is a sliver's,
 * tilted by float noise, not a side of it: believed, it puts every point
 * outside the hull, and a concave cell reads as flat.
 */
export function hullPlanes(hull: Hull): HullPlane[] {
  const v = hull.verts;
  const seen = new Map<string, HullPlane>();
  for (let t = 0; t < hull.faces.length; t += 3) {
    const a = hull.faces[t] * 3, b = hull.faces[t + 1] * 3, c = hull.faces[t + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
    const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-18) continue;
    nx /= len; ny /= len; nz /= len;
    const d = nx * v[a] + ny * v[a + 1] + nz * v[a + 2];
    seen.set(`${Math.round(nx * 1e6)},${Math.round(ny * 1e6)},${Math.round(nz * 1e6)},${Math.round(d * 1e7)}`, { n: [nx, ny, nz], d });
  }
  const step = 3 * Math.max(1, Math.ceil(v.length / 3 / MAX_SAMPLES));
  return [...seen.values()].filter(p => {
    for (let i = 0; i < v.length; i += step) {
      if (p.n[0] * v[i] + p.n[1] * v[i + 1] + p.n[2] * v[i + 2] - p.d > HULL_SLACK) return false;
    }
    return true;
  });
}

/** How far a point lies inside the planes, and 0 if outside any. */
export function depthInside(planes: HullPlane[], x: number, y: number, z: number): number {
  let least = Infinity;
  for (const p of planes) {
    const gap = p.d - (p.n[0] * x + p.n[1] * y + p.n[2] * z);
    if (gap < least) {
      least = gap;
      if (least <= 0) return 0;
    }
  }
  return Number.isFinite(least) ? least : 0;
}

/**
 * The deepest the surface goes inside the hull, metres, at its edges' ends and
 * middles. The middles matter: a through bore's edges end on the block's
 * faces, and only their middles are inside its hull.
 */
export function concavityDepth(verts: number[], faces: number[], hull: Hull): number {
  const planes = hullPlanes(hull);
  if (planes.length === 0) return 0;
  const edges = faces.length;
  const stride = Math.max(1, Math.ceil(edges / MAX_SURFACE_SAMPLES));
  let deepest = 0;
  for (let i = 0; i < edges; i += stride) {
    const a = faces[i] * 3, b = faces[i % 3 === 2 ? i - 2 : i + 1] * 3;
    deepest = Math.max(
      deepest,
      depthInside(planes, verts[a], verts[a + 1], verts[a + 2]),
      depthInside(planes, (verts[a] + verts[b]) / 2, (verts[a + 1] + verts[b + 1]) / 2, (verts[a + 2] + verts[b + 2]) / 2),
    );
  }
  return deepest;
}
