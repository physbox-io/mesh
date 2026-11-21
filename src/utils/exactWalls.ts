// A flat finishing bit put against walls the job knows exactly, rather than
// somewhere in the cell of the sampled grid they were sampled across.

import type { PathPoint } from './reliefPaths';
import type { SurfaceJob } from './surfaceJob';

type Rect = { minX: number; minY: number; maxX: number; maxY: number };

/**
 * For a job with `exactAt` (a solid part's own faces), null otherwise:
 *
 * `faceTop`, the highest ground under a flat bit's face at a point - the
 * model where it covers it, the sampled grid elsewhere (a tab, the frame);
 *
 * `onWall`, a waterline point at `level` moved to where the bit's rim meets
 * the nearest wall, or null where the model says no wall is near or the bit
 * would not stand clear there.
 *
 * The waterline is traced on the sampled grid, which can only say the wall is
 * somewhere in the cell it was sampled across and the tool clear of it
 * somewhere in the next: a flat bit came off a solid part's walls up to a cell
 * proud, 0.6 mm a side on a 40 mm boss, a 20 mm pocket 0.9 mm narrow.
 */
export function exactWalls(job: SurfaceJob, finishRad: number, passRect: Rect) {
  const exactAt = job.exactAt;
  if (!exactAt) return null;
  const surface = job.surface;
  const res = job.resolution;

  /**
   * The sampled ground at a point the model does not cover, at its highest
   * across the cell, except in a cell one of whose samples the part's own
   * faces account for, where the model has said where the wall is. The
   * samples are taken a hair off the grid points (see `sampleColumns`), so
   * the model is looked for round each one.
   */
  // Whether each sample is one the part's faces account for, worked out once.
  const partSample = new Int8Array(surface.cols * surface.rows).fill(-1);
  const isPartSample = (c: number, r: number) => {
    const k = r * surface.cols + c;
    if (partSample[k] < 0) {
      const sx = surface.minX + c * surface.stepX, sy = surface.minY + r * surface.stepY;
      partSample[k] = 0;
      for (const [ox, oy] of [[0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        if (!Number.isNaN(exactAt(sx + ox * 0.05, sy + oy * 0.05))) { partSample[k] = 1; break; }
      }
    }
    return partSample[k] === 1;
  };
  const sampledHigh = (x: number, y: number) => {
    const c0 = Math.min(surface.cols - 2, Math.max(0, Math.floor((x - surface.minX) / (surface.stepX || 1))));
    const r0 = Math.min(surface.rows - 2, Math.max(0, Math.floor((y - surface.minY) / (surface.stepY || 1))));
    let high = -Infinity;
    for (const [c, r] of [[c0, r0], [c0 + 1, r0], [c0, r0 + 1], [c0 + 1, r0 + 1]]) {
      if (isPartSample(c, r)) return -Infinity;
      high = Math.max(high, surface.z[r * surface.cols + c]);
    }
    return high;
  };
  // Dense near the rim, where a corner standing into the bit's face shows
  // first: a tenth of a millimetre apart there.
  const RINGS = [
    [0, 1], [finishRad / 2, 16], [Math.max(0, finishRad - 0.25), 48],
    [Math.max(0, finishRad - 0.1), 64], [finishRad - 1e-3, Math.max(32, Math.ceil((2 * Math.PI * finishRad) / 0.1))],
  ] as const;
  /** The highest ground under the bit's face; `modelOnly` reads the model alone. */
  const faceTop = (cx: number, cy: number, modelOnly = false) => {
    let top = -Infinity;
    for (const [rad, n] of RINGS) {
      for (let k = 0; k < n; k++) {
        const a = (2 * Math.PI * k) / n;
        const x = cx + rad * Math.cos(a), y = cy + rad * Math.sin(a);
        const z = exactAt(x, y);
        top = Math.max(top, Number.isNaN(z) ? (modelOnly ? -Infinity : sampledHigh(x, y)) : z);
      }
    }
    return top;
  };

  const onWall = (p: { x: number; y: number }, level: number, hint?: { x: number; y: number }): PathPoint | null => {
    const above = (x: number, y: number) => exactAt(x, y) > level + 1e-3;
    /** How far from (ox, oy) along (ux, uy) the model first stands above the level. */
    const wallAlong = (ox: number, oy: number, ux: number, uy: number) => {
      let lo = -res, hi = NaN;
      if (above(ox + ux * lo, oy + uy * lo)) return NaN;
      for (let t = lo + res / 4; t <= finishRad + 2 * res; t += res / 4) {
        if (above(ox + ux * t, oy + uy * t)) { hi = t; break; }
        lo = t;
      }
      if (Number.isNaN(hi)) return NaN;
      for (let k = 0; k < 10; k++) {
        const m = (lo + hi) / 2;
        if (above(ox + ux * m, oy + uy * m)) hi = m; else lo = m;
      }
      return lo;
    };
    // Toward the nearest of the wall, looked for all round: the slope of the
    // sampled grid only roughly faces it, and on a curve could miss it; then
    // squared to the wall's own direction, read off two more points of it
    // either side.
    let ux = 0, uy = 0, best = Infinity;
    if (hint) {
      const t = wallAlong(p.x, p.y, hint.x, hint.y);
      if (t < best) { best = t; ux = hint.x; uy = hint.y; }
    }
    for (let k = 0; k < 16 && !(best < Infinity); k++) {
      const a = (Math.PI * k) / 8, t = wallAlong(p.x, p.y, Math.cos(a), Math.sin(a));
      if (t < best) { best = t; ux = Math.cos(a); uy = Math.sin(a); }
    }
    if (!(best < Infinity)) return null;
    const side = 0.3;
    const t1 = wallAlong(p.x - uy * side, p.y + ux * side, ux, uy);
    const t2 = wallAlong(p.x + uy * side, p.y - ux * side, ux, uy);
    if (!Number.isNaN(t1) && !Number.isNaN(t2)) {
      const tx = -2 * uy * side + ux * (t1 - t2), ty = 2 * ux * side + uy * (t1 - t2);
      const tl = Math.hypot(tx, ty);
      let nx = ty / tl, ny = -tx / tl;
      if (nx * ux + ny * uy < 0) { nx = -nx; ny = -ny; }
      ux = nx; uy = ny;
    }
    const lo = wallAlong(p.x, p.y, ux, uy);
    if (Number.isNaN(lo)) return null;
    // As near the wall as the bit's face stands clear, found by halving.
    const clear = (cx: number, cy: number) => {
      for (let i = RINGS.length - 1; i >= 0; i--) {
        const [rad, n] = RINGS[i];
        for (let k = 0; k < n; k++) {
          const a = (2 * Math.PI * k) / n;
          const x = cx + rad * Math.cos(a), y = cy + rad * Math.sin(a);
          const z = exactAt(x, y);
          if ((Number.isNaN(z) ? sampledHigh(x, y) : z) > level + 1e-3) return false;
        }
      }
      return true;
    };
    const at = (shift: number) => ({ x: p.x + ux * shift, y: p.y + uy * shift });
    // Off a convex corner the bit stands back along the diagonal, up to
    // 0.41 of its radius further than off either face.
    let near = lo - finishRad, far = near - Math.max(res, 0.5 * finishRad);
    const farAt = at(far);
    if (!clear(farAt.x, farAt.y)) return null;
    const nearAt = at(near);
    if (!clear(nearAt.x, nearAt.y)) {
      for (let k = 0; k < 6; k++) {
        const m = (near + far) / 2, q = at(m);
        if (clear(q.x, q.y)) far = m; else near = m;
      }
      near = far;
    }
    const q = at(near);
    if (Math.hypot(q.x - p.x, q.y - p.y) > 1.5 * res + 0.5 * finishRad) return null;
    if (q.x < passRect.minX || q.x > passRect.maxX || q.y < passRect.minY || q.y > passRect.maxY) return null;
    return { x: q.x, y: q.y, z: level };
  };

  /**
   * A waterline's points with more put in wherever the straight move between
   * two of them would take the bit's face into the model: round a convex
   * corner the points either side stand on the two faces' lines, and the
   * move between them cut 0.2 mm off the corner of a square.
   */
  const mend = (points: PathPoint[], level: number): PathPoint[] => {
    const out: PathPoint[] = [];
    const between = (a: PathPoint, b: PathPoint, depth: number) => {
      if (depth > 5 || a.z > level + 1e-6 || b.z > level + 1e-6) return;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (faceTop(mx, my, true) <= level + 1e-3) return;
      const m = onWall({ x: mx, y: my }, level);
      if (!m) return;
      between(a, m, depth + 1);
      out.push(m);
      between(m, b, depth + 1);
    };
    for (let i = 0; i < points.length; i++) {
      if (i > 0) between(points[i - 1], points[i], 0);
      out.push(points[i]);
    }
    return out;
  };

  /**
   * A point the grid placed, made safe against the model: moved straight
   * back from the nearest of it until the bit's face stands clear of it, or
   * lifted over it where that takes more than a cell or two. The grid's own
   * ground (a tab, the frame) the grid has already kept it off.
   */
  const settle = (p: PathPoint): PathPoint => {
    if (faceTop(p.x, p.y, true) <= p.z + 1e-3) return p;
    let ux = 0, uy = 0, best = Infinity;
    // The nearest of the model, looked for all round: past a corner it lies
    // between any two of a few directions, so a fine fan of them.
    for (let k = 0; k < 64; k++) {
      const a = (Math.PI * k) / 32;
      for (let t = 0; t <= finishRad + res; t += res / 8) {
        if (exactAt(p.x + Math.cos(a) * t, p.y + Math.sin(a) * t) > p.z + 1e-3) {
          if (t < best) { best = t; ux = Math.cos(a); uy = Math.sin(a); }
          break;
        }
      }
    }
    if (best < Infinity) {
      for (let back = res / 8; back <= 2 * res; back += res / 8) {
        const x = p.x - ux * back, y = p.y - uy * back;
        if (x < passRect.minX || x > passRect.maxX || y < passRect.minY || y > passRect.maxY) break;
        if (faceTop(x, y, true) <= p.z + 1e-3) return { x, y, z: p.z };
      }
    }
    return { x: p.x, y: p.y, z: Math.min(0, faceTop(p.x, p.y, true)) };
  };

  return { faceTop, onWall, mend, settle };
}
