// ---------------------------------------------------------------------------
// Thinning a closed loop: Ramer–Douglas–Peucker, then the collinear points it
// leaves behind. Shared by the contour slicer and the profile tracer.
// ---------------------------------------------------------------------------

import type { Point2D } from './laserCutExporter';

/**
 * The loop restarted at the vertex farthest from its centroid: a corner of its
 * hull, so never a point in the middle of an edge.
 *
 * A traced or sliced contour starts wherever its chaining happened to begin,
 * often a hair to one side of a corner with the loop's last point a hair to
 * the other. Each pass below treats its first and last points specially, and
 * started there they judged each other collinear and the corner went with
 * them: a traced plate came back a triangle and its holes fell outside it.
 */
function fromExtreme(pts: Point2D[]): Point2D[] {
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length; cy /= pts.length;
  let far = 0, best = -1;
  pts.forEach((p, i) => {
    const d = (p.x - cx) ** 2 + (p.y - cy) ** 2;
    if (d > best) { best = d; far = i; }
  });
  return far === 0 ? pts : [...pts.slice(far), ...pts.slice(0, far)];
}

/** Ramer–Douglas–Peucker on a closed loop, splitting it at two far-apart anchors. */
export function simplifyLoop(loop: Point2D[], tolMm: number): Point2D[] {
  if (loop.length <= 4) return loop;
  const pts = fromExtreme(loop);

  const perp = (p: Point2D, a: Point2D, b: Point2D) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
    return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
  };

  const keep = new Uint8Array(pts.length);
  const rdp = (first: number, last: number) => {
    if (last <= first + 1) return;
    let worst = -1;
    let worstDist = tolMm;
    for (let i = first + 1; i < last; i++) {
      const dd = perp(pts[i], pts[first], pts[last]);
      if (dd > worstDist) { worstDist = dd; worst = i; }
    }
    if (worst < 0) return;
    keep[worst] = 1;
    rdp(first, worst);
    rdp(worst, last);
  };

  let anchor = 0;
  let best = -1;
  for (let i = 1; i < pts.length; i++) {
    const dd = Math.hypot(pts[i].x - pts[0].x, pts[i].y - pts[0].y);
    if (dd > best) { best = dd; anchor = i; }
  }

  keep[0] = 1;
  keep[anchor] = 1;
  keep[pts.length - 1] = 1;
  rdp(0, anchor);
  rdp(anchor, pts.length - 1);

  const out = pts.filter((_, i) => keep[i]);
  return out.length >= 3 ? out : pts;
}

/**
 * Drops vertices that sit on the line through their neighbours.
 *
 * RDP always keeps the first and last point of the run it is given, so the
 * vertex a contour happens to have been chained from survives even when it is
 * the middle of a straight edge. On a box that leaves a redundant node on one
 * side of every layer; this closes the loop properly.
 */
export function dropCollinear(pts: Point2D[], tolMm: number): Point2D[] {
  if (pts.length <= 3) return pts;
  // Point 0 is a hull corner and stays; everything is judged between kept
  // neighbours, the last point against point 0 as kept.
  let current = fromExtreme(pts);
  for (let pass = 0; pass < 3; pass++) {
    if (current.length <= 3) break;
    const out: Point2D[] = [current[0]];
    for (let i = 1; i < current.length; i++) {
      const prev = out[out.length - 1];
      const curr = current[i];
      const next = i === current.length - 1 ? out[0] : current[i + 1];
      const dx = next.x - prev.x;
      const dy = next.y - prev.y;
      const len = Math.hypot(dx, dy);
      const dist = len < 1e-9
        ? Math.hypot(curr.x - prev.x, curr.y - prev.y)
        : Math.abs((curr.x - prev.x) * dy - (curr.y - prev.y) * dx) / len;
      if (dist > tolMm) out.push(curr);
    }
    if (out.length === current.length || out.length < 3) break;
    current = out;
  }
  return current;
}
