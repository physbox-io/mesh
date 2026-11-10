// ---------------------------------------------------------------------------
// Thinning a closed loop: Ramer–Douglas–Peucker, then the collinear points it
// leaves behind. Shared by the contour slicer and the profile tracer.
// ---------------------------------------------------------------------------

import type { Point2D } from './laserCutExporter';

/** Ramer–Douglas–Peucker on a closed loop, splitting it at two far-apart anchors. */
export function simplifyLoop(pts: Point2D[], tolMm: number): Point2D[] {
  if (pts.length <= 4) return pts;

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
  let current = pts;
  for (let pass = 0; pass < 3; pass++) {
    if (current.length <= 3) break;
    const out: Point2D[] = [];
    for (let i = 0; i < current.length; i++) {
      const prev = out.length ? out[out.length - 1] : current[(i - 1 + current.length) % current.length];
      const curr = current[i];
      const next = current[(i + 1) % current.length];
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
