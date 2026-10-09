// How much support a printed shape needs, standing the way it stands.
//
// Two callers have to agree on this: the DFM print lens (utils/dfm.ts), which
// shades and reports overhang, and Split for Print (utils/printSplit.ts), which
// turns each section to whichever way up needs the least of it. If they
// measured differently, a section Split for Print had carefully turned would
// light up red in the overlay the moment it was applied.
//
// A module of its own, with no imports, rather than an export of dfm.ts: the
// split runs in a worker, and dfm.ts pulls in the slicer, the relief carver and
// three.js behind it. A worker bundle that drags those in is how a circular
// import reached Cloud Build unnoticed twice before.

const RAD = 180 / Math.PI;

/**
 * How far a face leans from the build axis, in degrees.
 *
 * A vertical wall is 0° and prints on top of itself. A horizontal ceiling is 90°
 * and is bridging over air. The slicer limit of 45° is the angle at which each
 * layer still lands half on the one below it.
 *
 * Only DOWNWARD-facing triangles can overhang: an upward face at any angle has
 * the whole part underneath it. Those come back as 0.
 */
export function overhangDeg(normalZ: number): number {
  if (normalZ >= 0) return 0;
  return Math.asin(Math.min(1, -normalZ)) * RAD;
}

/**
 * How much of a triangle soup (9 numbers a triangle, Z-up) needs support when
 * printed as it stands, and how much surface it has in all.
 *
 * A face needs support once it leans past `overhangLimitDeg` from vertical,
 * unless it is sitting on the build plate — printed against glass, not air.
 * Faces whose centre is within `bedContact` of the lowest point count as on the
 * plate, in the soup's own units: half a millimetre is 0.0005 in the scene's
 * metres and 0.5 in the split engine's millimetres.
 *
 * `onFace` is told about every face that needs support, for a caller that wants
 * more than the total — the DFM lens paints its heat map from it.
 */
export function supportArea(
  tris: ArrayLike<number>,
  overhangLimitDeg: number,
  bedContact = 0.0005,
  onFace?: (t: number, deg: number, area: number) => void,
): { area: number; totalArea: number } {
  const count = Math.floor(tris.length / 9);
  let minZ = Infinity;
  for (let i = 2; i < count * 9; i += 3) if (tris[i] < minZ) minZ = tris[i];
  let area = 0, totalArea = 0;
  for (let t = 0; t < count; t++) {
    const i = t * 9;
    const ux = tris[i + 3] - tris[i], uy = tris[i + 4] - tris[i + 1], uz = tris[i + 5] - tris[i + 2];
    const vx = tris[i + 6] - tris[i], vy = tris[i + 7] - tris[i + 1], vz = tris[i + 8] - tris[i + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 1e-12)) continue;
    const a = len / 2;
    totalArea += a;
    const deg = overhangDeg(nz / len);
    if (deg <= overhangLimitDeg) continue;
    if ((tris[i + 2] + tris[i + 5] + tris[i + 8]) / 3 - minZ < bedContact) continue;
    area += a;
    onFace?.(t, deg, a);
  }
  return { area, totalArea };
}
