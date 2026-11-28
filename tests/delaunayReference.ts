// The quadratic Bowyer-Watson src/utils/cloth/delaunay.ts replaced, kept as
// the reference its triangulation is checked against (tests/delaunay.test.ts).
export function delaunayReference(pts: [number, number][]): number[] {
  const n = pts.length;
  if (n < 3) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  const d = Math.max(maxX - minX, maxY - minY) || 1, mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
  // Deduplicate near-coincident points and apply tiny deterministic jitter to break
  // exact collinearity / cocircularity without changing point indices or geometry.
  const eps = 1e-9 * d, cell = 1 / eps;
  const seen = new Map<string, number>();
  const unique: number[] = [];
  for (let i = 0; i < n; i++) {
    const gx = Math.round((pts[i][0] - mx) * cell), gy = Math.round((pts[i][1] - my) * cell);
    let dup = false;
    for (let ox = -1; ox <= 1 && !dup; ox++) for (let oy = -1; oy <= 1 && !dup; oy++) {
      const prev = seen.get(`${gx + ox},${gy + oy}`);
      if (prev !== undefined && Math.hypot(pts[i][0] - pts[prev][0], pts[i][1] - pts[prev][1]) < eps) dup = true;
    }
    if (!dup) { seen.set(`${gx},${gy}`, i); unique.push(i); }
  }
  if (unique.length < 3) return [];
  // Normalize coordinates around (mx, my) with sub-picometre deterministic perturbation
  // so collinear/cocircular grids cannot suffer catastrophic cancellation.
  const P: [number, number][] = pts.map(([x, y], i) => [
    (x - mx) / d + Math.sin(i * 12.9898 + 1.234) * 1e-11,
    (y - my) / d + Math.cos(i * 78.233 + 5.678) * 1e-11,
  ]);
  // A super-triangle well clear of every point; its corners are n, n+1, n+2.
  P.push([-20, -1], [0, 20], [20, -1]);

  type Tri = { a: number; b: number; c: number; cx: number; cy: number; r2: number };
  const make = (a: number, b: number, c: number): Tri | null => {
    const [ax, ay] = P[a], [bx, by] = P[b], [cx, cy] = P[c];
    let D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(D) < 1e-15) return null;
    // Orient counter-clockwise.
    if (D < 0) { [b, c] = [c, b]; D = -D; }
    const dx1 = P[b][0] - ax, dy1 = P[b][1] - ay, dx2 = P[c][0] - ax, dy2 = P[c][1] - ay;
    const l1 = dx1 * dx1 + dy1 * dy1, l2 = dx2 * dx2 + dy2 * dy2;
    const ux = ax + (l1 * dy2 - l2 * dy1) / D;
    const uy = ay + (dx1 * l2 - dx2 * l1) / D;
    const r2 = (ax - ux) ** 2 + (ay - uy) ** 2;
    return Number.isFinite(r2) ? { a, b, c, cx: ux, cy: uy, r2 } : null;
  };
  const root = make(n, n + 1, n + 2);
  if (!root) return [];
  let tris: Tri[] = [root];
  for (const i of unique) {
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
      if (t) keep.push(t);
    }
    tris = keep;
  }
  const out: number[] = [];
  for (const t of tris) if (t.a < n && t.b < n && t.c < n) out.push(t.a, t.b, t.c);
  return out;
}

type UV = [number, number];
/** The point-in-outline and clearance tests meshOutline made over the whole outline for every point. */
export const insideReference = (poly: UV[], [x, y]: UV) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
export const distToPolyReference = (poly: UV[], [x, y]: UV) => {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    d = Math.min(d, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return d;
};
