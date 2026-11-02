/**
 * A mesh with no volume, which MuJoCo cannot hull: every vertex in one plane
 * (the first face drawn in an empty lattice), or fewer than four, or all on a
 * line. A flat one is emitted as a thin box lying in its plane, so it still
 * collides where it is drawn; anything less is a speck. Null for a mesh with
 * volume, which compiles as itself. Kept per vertex array, since the asset
 * pass and the geom pass both ask.
 */
const FLAT_HALF_THICKNESS = 0.0005;
export type FlatMesh = 'speck' | { pos: number[]; quat: number[]; size: number[] };
const flatMeshes = new WeakMap<number[], FlatMesh | null>();
export function flatMesh(vertices: number[]): FlatMesh | null {
  const cached = flatMeshes.get(vertices);
  if (cached !== undefined) return cached;
  // Y-up to MuJoCo's Z-up, as toMjcfVerts does: (x, y, z) -> (x, -z, y).
  const pts: number[][] = [];
  for (let i = 0; i + 2 < vertices.length; i += 3) pts.push([vertices[i], -vertices[i + 2], vertices[i + 1]]);
  const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };
  let result: FlatMesh | null = null;
  if (pts.length < 4) result = 'speck';
  else {
    const p0 = pts[0];
    let p1 = p0;
    for (const p of pts) if (dot(sub(p, p0), sub(p, p0)) > dot(sub(p1, p0), sub(p1, p0))) p1 = p;
    const extent = Math.sqrt(dot(sub(p1, p0), sub(p1, p0)));
    const along = extent > 0 ? unit(sub(p1, p0)) : [1, 0, 0];
    let normal = [0, 0, 0];
    for (const p of pts) {
      const c = cross(along, sub(p, p0));
      if (dot(c, c) > dot(normal, normal)) normal = c;
    }
    const tolerance = Math.max(extent, 1e-9) * 1e-7;
    if (extent === 0 || Math.sqrt(dot(normal, normal)) <= tolerance) result = 'speck';
    else {
      const n = unit(normal);
      if (pts.every((p) => Math.abs(dot(n, sub(p, p0))) <= tolerance)) {
        // The box's sides run along the shape's: the grid's axes when the plane
        // is square to them, as a lattice face nearly always is, and otherwise
        // the first edge — the diagonal to the far corner would turn the box
        // 45° off a rectangle and oversize it.
        const square = [0, 1, 2].findIndex((k) => Math.abs(n[k]) > 0.9999);
        const first = sub(pts[1], pts[0]);
        const inPlane = sub(first, n.map((c) => c * dot(first, n)));
        const u = square !== -1
          ? [0, 1, 2].map((k) => (k === (square + 1) % 3 ? 1 : 0))
          : dot(inPlane, inPlane) > 0 ? unit(inPlane) : along;
        const v = cross(n, u);
        let uLo = Infinity, uHi = -Infinity, vLo = Infinity, vHi = -Infinity;
        for (const p of pts) {
          const d = sub(p, p0);
          const a = dot(d, u), b = dot(d, v);
          if (a < uLo) uLo = a; if (a > uHi) uHi = a;
          if (b < vLo) vLo = b; if (b > vHi) vHi = b;
        }
        const um = (uLo + uHi) / 2, vm = (vLo + vHi) / 2;
        const pos = [0, 1, 2].map((k) => p0[k] + u[k] * um + v[k] * vm);
        // Rotation with columns u, v, n, as a (w, x, y, z) quaternion.
        const [m00, m10, m20] = u, [m01, m11, m21] = v, [m02, m12, m22] = n;
        const trace = m00 + m11 + m22;
        let q: number[];
        if (trace > 0) {
          const k = Math.sqrt(trace + 1) * 2;
          q = [k / 4, (m21 - m12) / k, (m02 - m20) / k, (m10 - m01) / k];
        } else if (m00 > m11 && m00 > m22) {
          const k = Math.sqrt(1 + m00 - m11 - m22) * 2;
          q = [(m21 - m12) / k, k / 4, (m01 + m10) / k, (m02 + m20) / k];
        } else if (m11 > m22) {
          const k = Math.sqrt(1 + m11 - m00 - m22) * 2;
          q = [(m02 - m20) / k, (m01 + m10) / k, k / 4, (m12 + m21) / k];
        } else {
          const k = Math.sqrt(1 + m22 - m00 - m11) * 2;
          q = [(m10 - m01) / k, (m02 + m20) / k, (m12 + m21) / k, k / 4];
        }
        const size = [Math.max((uHi - uLo) / 2, FLAT_HALF_THICKNESS), Math.max((vHi - vLo) / 2, FLAT_HALF_THICKNESS), FLAT_HALF_THICKNESS];
        result = { pos, quat: q, size };
      }
    }
  }
  flatMeshes.set(vertices, result);
  return result;
}
