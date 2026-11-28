/**
 * Delaunay triangulation of 2D points, Bowyer-Watson: each point found in the
 * triangle that holds it by walking there from the last one made, its cavity
 * (the triangles whose circumcircles hold it) grown across neighbours, and
 * refilled as a fan to it. About n log n for points inserted in order along
 * a piece (its outline, then its lattice row by row); scanning every
 * triangle for each point, 23.6k points took 29 s. Returns a flat list of
 * point indices, three per triangle, wound counter-clockwise.
 */
export function delaunay(pts: [number, number][]): number[] {
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

  // Triangles: corners (counter-clockwise), the neighbour across each edge
  // (edge k runs from corner k to corner k + 1; -1 is none), circumcircle.
  let cap = 2 * unique.length + 16;
  let V = new Int32Array(3 * cap), N = new Int32Array(3 * cap), C = new Float64Array(3 * cap), alive = new Uint8Array(cap);
  let count = 0;
  const free: number[] = [];
  const grow = () => {
    cap *= 2;
    const V2 = new Int32Array(3 * cap), N2 = new Int32Array(3 * cap), C2 = new Float64Array(3 * cap), A2 = new Uint8Array(cap);
    V2.set(V); N2.set(N); C2.set(C); A2.set(alive);
    V = V2; N = N2; C = C2; alive = A2;
  };
  const make = (a: number, b: number, c: number): number => {
    const t = free.length ? free.pop()! : (count === cap ? (grow(), count++) : count++);
    const [ax, ay] = P[a], [bx, by] = P[b], [cx, cy] = P[c];
    const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    V[3 * t] = a; V[3 * t + 1] = b; V[3 * t + 2] = c;
    N[3 * t] = N[3 * t + 1] = N[3 * t + 2] = -1;
    alive[t] = 1;
    const dx1 = bx - ax, dy1 = by - ay, dx2 = cx - ax, dy2 = cy - ay;
    const l1 = dx1 * dx1 + dy1 * dy1, l2 = dx2 * dx2 + dy2 * dy2;
    const ux = ax + (l1 * dy2 - l2 * dy1) / D, uy = ay + (dx1 * l2 - dx2 * l1) / D;
    const r2 = (ax - ux) ** 2 + (ay - uy) ** 2;
    // Degenerate (its corners in a line): it holds everything, so the next point near it takes it out.
    if (Math.abs(D) < 1e-15 || !Number.isFinite(r2)) { C[3 * t] = 0; C[3 * t + 1] = 0; C[3 * t + 2] = Infinity; } else { C[3 * t] = ux; C[3 * t + 1] = uy; C[3 * t + 2] = r2; }
    return t;
  };
  const holds = (t: number, x: number, y: number) => (x - C[3 * t]) ** 2 + (y - C[3 * t + 1]) ** 2 < C[3 * t + 2] * (1 + 1e-12);
  const orient = (a: number, b: number, x: number, y: number) => (P[b][0] - P[a][0]) * (y - P[a][1]) - (P[b][1] - P[a][1]) * (x - P[a][0]);
  let last = make(n, n + 2, n + 1); // counter-clockwise
  const bad: number[] = [], stack: number[] = [], mark = new Int32Array(cap).fill(-1);
  let marks = mark;
  const boundary: number[] = []; // per cavity edge: from, to, the neighbour outside
  const fanFrom = new Map<number, number>(), fanTo = new Map<number, number>();
  for (const i of unique) {
    const [x, y] = P[i];
    // Walk to the triangle that holds it (or one whose circumcircle does).
    let t = last, steps = 0;
    for (;;) {
      if (holds(t, x, y)) break;
      let next = -1;
      for (let k = 0; k < 3; k++) if (orient(V[3 * t + k], V[3 * t + ((k + 1) % 3)], x, y) < 0 && N[3 * t + k] >= 0) { next = N[3 * t + k]; break; }
      if (next < 0 || ++steps > count + 8) {
        // Lost (only where a degenerate triangle cut the walk short): any triangle that holds it.
        t = -1;
        for (let q = 0; q < count; q++) if (alive[q] && holds(q, x, y)) { t = q; break; }
        break;
      }
      t = next;
    }
    if (t < 0) continue;
    // The cavity: every triangle joined to that one whose circumcircle holds the point.
    if (marks.length < cap) { const m2 = new Int32Array(cap).fill(-1); m2.set(marks); marks = m2; }
    bad.length = 0; boundary.length = 0; stack.length = 0;
    stack.push(t); marks[t] = i;
    while (stack.length) {
      const q = stack.pop()!;
      bad.push(q);
      for (let k = 0; k < 3; k++) {
        const o = N[3 * q + k];
        if (o >= 0 && marks[o] !== i && holds(o, x, y)) { marks[o] = i; stack.push(o); }
      }
    }
    for (const q of bad) for (let k = 0; k < 3; k++) {
      const o = N[3 * q + k];
      if (o >= 0 && marks[o] === i) continue;
      boundary.push(V[3 * q + k], V[3 * q + ((k + 1) % 3)], o);
    }
    for (const q of bad) { alive[q] = 0; free.push(q); }
    // Refilled as a fan to the point, each new triangle joined to what was outside and to its fan neighbours.
    fanFrom.clear(); fanTo.clear();
    for (let e = 0; e < boundary.length; e += 3) {
      const a = boundary[e], b = boundary[e + 1], o = boundary[e + 2];
      const nt = make(a, b, i);
      if (marks.length < cap) { const m2 = new Int32Array(cap).fill(-1); m2.set(marks); marks = m2; }
      N[3 * nt] = o;
      if (o >= 0) for (let k = 0; k < 3; k++) if (V[3 * o + k] === b && V[3 * o + ((k + 1) % 3)] === a) N[3 * o + k] = nt;
      fanFrom.set(a, nt); fanTo.set(b, nt);
      last = nt;
    }
    for (let e = 0; e < boundary.length; e += 3) {
      const a = boundary[e], b = boundary[e + 1], nt = fanFrom.get(a)!;
      // Edge 1 (b to the point) meets the triangle that starts at b; edge 2 (the point to a) the one that ends at a.
      N[3 * nt + 1] = fanFrom.get(b) ?? -1;
      N[3 * nt + 2] = fanTo.get(a) ?? -1;
    }
  }
  void mark;
  const out: number[] = [];
  for (let t = 0; t < count; t++) {
    if (!alive[t]) continue;
    const a = V[3 * t], b = V[3 * t + 1], c = V[3 * t + 2];
    // Corners in a line make no triangle (as a degenerate one never was).
    if (a < n && b < n && c < n && C[3 * t + 2] !== Infinity) out.push(a, b, c);
  }
  return out;
}
