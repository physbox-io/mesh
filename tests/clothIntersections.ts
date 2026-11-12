// Cloth through cloth, by geometry alone: an edge of any cloth that crosses a
// triangle of any cloth it is not joined to. Cloth that has passed through
// cloth (itself, another piece, another layer) leaves its surfaces crossing;
// cloth that has only come close does not. No side, layer or threshold is
// assumed, so the same count holds every scene to the same rule.
//
// Joined: sharing a particle, or particles sewn together (stitches, ties to
// another cloth, which the solver closes to nothing) - two panels meeting at a
// seam touch there by design.

/** Union-find over particles, by the stitches. */
function sewnRoots(n: number, stitches: ArrayLike<number>): Int32Array {
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let k = 0; k + 1 < stitches.length; k += 2) { const a = find(stitches[k]), b = find(stitches[k + 1]); if (a !== b) parent[a] = b; }
  for (let i = 0; i < n; i++) parent[i] = find(i);
  return parent;
}

export interface Crossing { edgePiece: string; triPiece: string; at: number[]; /** How far the edge's shallower end is through the triangle's plane. */ depth: number }

/**
 * Every edge (of the triangles) crossing a triangle it is not joined to.
 * `x` all particles; `tris` global indices; `pieceOf` a name per particle.
 * Triangles with a tacked or tied overlay are included like any other.
 */
export function clothCrossings(x: ArrayLike<number>, tris: ArrayLike<number>, stitches: ArrayLike<number>, pieceOf: (i: number) => string): Crossing[] {
  const n = x.length / 3, nt = tris.length / 3;
  const root = sewnRoots(n, stitches);
  // Edges, once each, by root pair.
  const edgeSet = new Set<string>(), edges: number[] = [];
  for (let t = 0; t < nt; t++) for (let e = 0; e < 3; e++) {
    const a = tris[3 * t + e], b = tris[3 * t + (e + 1) % 3];
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    if (!edgeSet.has(key)) { edgeSet.add(key); edges.push(a, b); }
  }
  // Triangles in a uniform grid by their boxes.
  const cell = 0.02, grid = new Map<string, number[]>();
  const box = new Float64Array(6 * nt);
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const v = [0, 1, 2].map((q) => x[3 * tris[3 * t + q] + k]);
      box[6 * t + k] = Math.min(...v); box[6 * t + 3 + k] = Math.max(...v);
    }
    for (let ix = Math.floor(box[6 * t] / cell); ix <= Math.floor(box[6 * t + 3] / cell); ix++)
      for (let iy = Math.floor(box[6 * t + 1] / cell); iy <= Math.floor(box[6 * t + 4] / cell); iy++)
        for (let iz = Math.floor(box[6 * t + 2] / cell); iz <= Math.floor(box[6 * t + 5] / cell); iz++) {
          const key = `${ix},${iy},${iz}`;
          let list = grid.get(key);
          if (!list) grid.set(key, (list = []));
          list.push(t);
        }
  }
  const out: Crossing[] = [];
  const seen = new Set<number>();
  for (let e = 0; e < edges.length; e += 2) {
    const a = edges[e], b = edges[e + 1], ra = root[a], rb = root[b];
    const p = [x[3 * a], x[3 * a + 1], x[3 * a + 2]], q = [x[3 * b], x[3 * b + 1], x[3 * b + 2]];
    const lo = [0, 1, 2].map((k) => Math.min(p[k], q[k])), hi = [0, 1, 2].map((k) => Math.max(p[k], q[k]));
    seen.clear();
    for (let ix = Math.floor(lo[0] / cell); ix <= Math.floor(hi[0] / cell); ix++)
      for (let iy = Math.floor(lo[1] / cell); iy <= Math.floor(hi[1] / cell); iy++)
        for (let iz = Math.floor(lo[2] / cell); iz <= Math.floor(hi[2] / cell); iz++) {
          for (const t of grid.get(`${ix},${iy},${iz}`) ?? []) {
            if (seen.has(t)) continue;
            seen.add(t);
            const o = 6 * t;
            if (hi[0] < box[o] || hi[1] < box[o + 1] || hi[2] < box[o + 2] || lo[0] > box[o + 3] || lo[1] > box[o + 4] || lo[2] > box[o + 5]) continue;
            const i0 = tris[3 * t], i1 = tris[3 * t + 1], i2 = tris[3 * t + 2];
            const r0 = root[i0], r1 = root[i1], r2 = root[i2];
            if (ra === r0 || ra === r1 || ra === r2 || rb === r0 || rb === r1 || rb === r2) continue;
            const hit = segmentTriangle(p, q, x, i0, i1, i2);
            if (hit) {
              const e1 = [0, 1, 2].map((k) => x[3 * i1 + k] - x[3 * i0 + k]), e2 = [0, 1, 2].map((k) => x[3 * i2 + k] - x[3 * i0 + k]);
              const nn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]], nl = Math.hypot(nn[0], nn[1], nn[2]) || 1;
              const sd = (v: number[]) => ((v[0] - x[3 * i0]) * nn[0] + (v[1] - x[3 * i0 + 1]) * nn[1] + (v[2] - x[3 * i0 + 2]) * nn[2]) / nl;
              out.push({ edgePiece: pieceOf(a), triPiece: pieceOf(i0), at: hit, depth: Math.min(Math.abs(sd(p)), Math.abs(sd(q))) });
            }
          }
        }
  }
  return out;
}

/** Where segment pq crosses triangle (i0, i1, i2), strictly inside both, or null (Moller-Trumbore). */
function segmentTriangle(p: number[], q: number[], x: ArrayLike<number>, i0: number, i1: number, i2: number): number[] | null {
  const v0 = [x[3 * i0], x[3 * i0 + 1], x[3 * i0 + 2]];
  const e1 = [x[3 * i1] - v0[0], x[3 * i1 + 1] - v0[1], x[3 * i1 + 2] - v0[2]];
  const e2 = [x[3 * i2] - v0[0], x[3 * i2 + 1] - v0[1], x[3 * i2 + 2] - v0[2]];
  const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const h = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
  const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
  if (Math.abs(det) < 1e-18) return null;
  const inv = 1 / det, s = [p[0] - v0[0], p[1] - v0[1], p[2] - v0[2]];
  const u = inv * (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]);
  if (u <= 0 || u >= 1) return null;
  const qv = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
  const v = inv * (d[0] * qv[0] + d[1] * qv[1] + d[2] * qv[2]);
  if (v <= 0 || u + v >= 1) return null;
  const t = inv * (e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]);
  if (t <= 0 || t >= 1) return null;
  return [p[0] + t * d[0], p[1] + t * d[1], p[2] + t * d[2]];
}
