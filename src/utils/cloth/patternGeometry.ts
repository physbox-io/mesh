/**
 * Plane geometry for sewing-pattern pieces, mm, y down the page: a cutting
 * line grown by a different allowance on each edge, a piece halved on its
 * fold, symmetry and mirror tests, and a point well inside a piece to label.
 */

import { insertCrossings, pointInPolygon, signedArea2, splitLoops } from '../polygonOffset';

export type Pt = { x: number; y: number };

/**
 * `loop` grown outward by `d[i]` along each edge i (loop[i] to loop[i + 1]):
 * corners mitred where the two offsets meet, bevelled past `miterLimit` times
 * the larger of them, stepped where two edges in line take different
 * allowances. Folds the offset throws off are cut away; the largest loop wins.
 */
export function offsetEdges(loop: Pt[], d: number[], miterLimit = 2): Pt[][] {
  const n = loop.length;
  if (n < 3) return [];
  if (d.every((x) => x <= 1e-9)) return [loop.slice()];
  // Counter-clockwise throughout (interior on the left of each edge).
  const ccw = signedArea2(loop) > 0;
  const P = ccw ? loop : [...loop].reverse();
  const D = ccw ? d : loop.map((_, j) => d[(((n - 2 - j) % n) + n) % n]);
  const off: { a: Pt; b: Pt; nx: number; ny: number; len: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    const nx = len > 1e-12 ? dy / len : 0, ny = len > 1e-12 ? -dx / len : 0;
    off.push({ a: { x: a.x + nx * D[i], y: a.y + ny * D[i] }, b: { x: b.x + nx * D[i], y: b.y + ny * D[i] }, nx, ny, len });
  }
  const raw: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const e0 = off[(i - 1 + n) % n], e1 = off[i], v = P[i];
    if (e0.len < 1e-12) { raw.push(e1.a); continue; }
    if (e1.len < 1e-12) { raw.push(e0.b); continue; }
    const r = { x: e0.b.x - e0.a.x, y: e0.b.y - e0.a.y }, s = { x: e1.b.x - e1.a.x, y: e1.b.y - e1.a.y };
    const cross = r.x * s.y - r.y * s.x;
    if (Math.abs(cross) < 1e-9 * e0.len * e1.len) {
      raw.push(e0.b);
      if (Math.hypot(e0.b.x - e1.a.x, e0.b.y - e1.a.y) > 1e-6) raw.push(e1.a);
      continue;
    }
    const t = ((e1.a.x - e0.a.x) * s.y - (e1.a.y - e0.a.y) * s.x) / cross;
    const q = { x: e0.a.x + t * r.x, y: e0.a.y + t * r.y };
    const limit = miterLimit * Math.max(D[(i - 1 + n) % n], D[i], 1e-6);
    // Turning left (convex, for a counter-clockwise loop) the mitre runs out; turning right it folds back in and is trimmed below.
    if (cross > 0 && Math.hypot(q.x - v.x, q.y - v.y) > limit) { raw.push(e0.b, e1.a); continue; }
    raw.push(q);
  }
  const loops = splitLoops(insertCrossings(raw)).filter((l) => l.length >= 3 && signedArea2(l) > 0);
  if (!loops.length) return [];
  let best = loops[0];
  for (const l of loops) if (signedArea2(l) > signedArea2(best)) best = l;
  return [ccw ? best : [...best].reverse()];
}

/**
 * The half of a loop on x >= c, each vertex carrying the attribute of the edge
 * leaving it; the new edges along the line carry `foldAttr`.
 */
export function clipHalf<A>(pts: Pt[], attrs: A[], c: number, foldAttr: A): { pts: Pt[]; attrs: A[] } {
  const out: Pt[] = [], oa: A[] = [], n = pts.length, eps = 1e-6;
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    const pin = p.x >= c - eps, qin = q.x >= c - eps;
    if (pin) { out.push(p); oa.push(attrs[i]); }
    if (pin !== qin) {
      const t = (c - p.x) / (q.x - p.x), x = { x: c, y: p.y + t * (q.y - p.y) };
      if (pin) { out.push(x); oa.push(foldAttr); } else { out.push(x); oa.push(attrs[i]); }
    }
  }
  return { pts: out, attrs: oa };
}

/** Distance from p to the loop's boundary. */
export function distToLoop(p: Pt, loop: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return best;
}

/** Whether loop `b` is loop `a` to within `tol` both ways (every point of each near the other's boundary). */
export function sameShape(a: Pt[], b: Pt[], tol: number): boolean {
  return a.every((p) => distToLoop(p, b) <= tol) && b.every((p) => distToLoop(p, a) <= tol);
}

export function bounds(pts: Pt[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of pts) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
  return { x0, y0, x1, y1 };
}

/** A point well inside the loop (the deepest of a grid over it): where its label goes. */
export function deepPoint(loop: Pt[]): Pt {
  const b = bounds(loop);
  let best = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }, bd = -1;
  const N = 24;
  for (let i = 1; i < N; i++) for (let j = 1; j < N; j++) {
    const p = { x: b.x0 + ((b.x1 - b.x0) * i) / N, y: b.y0 + ((b.y1 - b.y0) * j) / N };
    if (!pointInPolygon(p, loop)) continue;
    const d = distToLoop(p, loop);
    if (d > bd) { bd = d; best = p; }
  }
  return best;
}

/** The stretch of the vertical line x through the loop that holds y: where a grain arrow fits. */
export function verticalChord(loop: Pt[], x: number, y: number): [number, number] | null {
  const ys: number[] = [];
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    if ((a.x <= x) !== (b.x <= x)) ys.push(a.y + ((x - a.x) / (b.x - a.x)) * (b.y - a.y));
  }
  ys.sort((p, q) => p - q);
  for (let i = 0; i + 1 < ys.length; i += 2) if (ys[i] <= y && y <= ys[i + 1]) return [ys[i], ys[i + 1]];
  return null;
}
