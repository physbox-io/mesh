/**
 * Delaunay triangulation of 2D points, Bowyer-Watson. Plain and quadratic at
 * worst, which is plenty for a cloth piece's few thousand points (and the
 * result is cached by the caller). Returns a flat list of point indices, three
 * per triangle, wound counter-clockwise.
 */
export function delaunay(pts: [number, number][]): number[] {
  const n = pts.length;
  if (n < 3) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  const d = Math.max(maxX - minX, maxY - minY) || 1, mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
  // A super-triangle well clear of every point; its corners are n, n+1, n+2.
  const P: [number, number][] = [...pts, [mx - 20 * d, my - d], [mx, my + 20 * d], [mx + 20 * d, my - d]];

  type Tri = { a: number; b: number; c: number; cx: number; cy: number; r2: number };
  const make = (a: number, b: number, c: number): Tri => {
    const [ax, ay] = P[a], [bx, by] = P[b], [cx, cy] = P[c];
    const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    // Orient counter-clockwise.
    if (D < 0) [b, c] = [c, b];
    const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / D;
    const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / D;
    return { a, b, c, cx: ux, cy: uy, r2: (ax - ux) ** 2 + (ay - uy) ** 2 };
  };
  let tris: Tri[] = [make(n, n + 1, n + 2)];
  for (let i = 0; i < n; i++) {
    const [x, y] = P[i];
    const keep: Tri[] = [];
    const edges = new Map<string, [number, number]>();
    for (const t of tris) {
      if ((x - t.cx) ** 2 + (y - t.cy) ** 2 < t.r2 * (1 + 1e-12)) {
        for (const [p, q] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) {
          // An edge shared by two removed triangles is interior to the cavity.
          const k = p < q ? `${p},${q}` : `${q},${p}`;
          if (edges.has(k)) edges.delete(k); else edges.set(k, [p, q]);
        }
      } else keep.push(t);
    }
    for (const [p, q] of edges.values()) {
      const t = make(p, q, i);
      if (Number.isFinite(t.r2)) keep.push(t);
    }
    tris = keep;
  }
  const out: number[] = [];
  for (const t of tris) if (t.a < n && t.b < n && t.c < n) out.push(t.a, t.b, t.c);
  return out;
}
