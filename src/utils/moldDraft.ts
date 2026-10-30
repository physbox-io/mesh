// ---------------------------------------------------------------------------
// Draft on a mold's cavity walls
// ---------------------------------------------------------------------------
//
// A cavity is a depth field, and a wall's steepness is that field's gradient, so
// draft is a slope limit between neighbouring columns. Which way the wall leans
// is the choice:
//
//  - 'remove' (default): the cavity only gets shallower, so the taper is cut back
//    into the deep side. The opening keeps its size and the casting loses
//    depth x tan(angle) off each wall at the bottom. Nothing is oversize, and a
//    thin wall can all but vanish: 1 degree over 111 mm is 1.9 mm a side.
//  - 'add': the cavity only gets deeper, so the opening widens. The bottom keeps
//    its size and the casting gains that much at the top. Nothing is undersize.
//  - 'centre': the wall pivots about its mid-height, half of each.
//
// Each is two sweeps, forwards then backwards, which carry the limit across the
// whole field.
// ---------------------------------------------------------------------------

import type { Grid } from './moldColumns';

export type DraftMode = 'remove' | 'add' | 'centre';

/** One sweep pair of the slope limit, `cot` the wall's run per unit of depth. */
function limitSlope(depth: Float64Array, grid: Grid, cot: number, deepen: boolean): Float64Array {
  const wx = grid.stepX * cot;
  const wy = grid.stepY * cot;
  const wd = Math.hypot(grid.stepX, grid.stepY) * cot;
  const d = Float64Array.from(depth);
  const { cols, rows } = grid;
  // Shallower: no column deeper than a neighbour plus a step's taper.
  // Deeper: no column shallower than a neighbour less one.
  const pull = deepen
    ? (i: number, j: number, w: number) => { if (d[j] - w > d[i]) d[i] = d[j] - w; }
    : (i: number, j: number, w: number) => { if (d[j] + w < d[i]) d[i] = d[j] + w; };

  // The first step off a wall is half a step. A wall between two samples
  // lies, on average, halfway between them, and a taper counted from the
  // sample rather than the wall came out at two thirds of its size: 1 degree
  // on a 111 mm slot gave 45 000 mm³ of wedge where 70 000 was due.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if ((dr === 0 && dc === 0) || rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
          const j = rr * cols + cc;
          const w = (dr === 0 ? wx : dc === 0 ? wy : wd) / 2;
          if (deepen ? depth[j] - w > d[i] : depth[j] + w < d[i]) d[i] = deepen ? depth[j] - w : depth[j] + w;
        }
      }
    }
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (c > 0) pull(i, i - 1, wx);
      if (r > 0) pull(i, i - cols, wy);
      if (r > 0 && c > 0) pull(i, i - cols - 1, wd);
      if (r > 0 && c < cols - 1) pull(i, i - cols + 1, wd);
    }
  }
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c;
      if (c < cols - 1) pull(i, i + 1, wx);
      if (r < rows - 1) pull(i, i + cols, wy);
      if (r < rows - 1 && c < cols - 1) pull(i, i + cols + 1, wd);
      if (r < rows - 1 && c > 0) pull(i, i + cols - 1, wd);
    }
  }
  return d;
}

/**
 * Tapers the cavity walls so a rigid mold can let go. The cost is real: a wall
 * moves depth x tan(angle), so 2 degrees over an 18 mm cavity rounds the top
 * millimetre of every cliff. Zero reproduces the part exactly.
 */
export function applyDraft(depth: Float64Array, grid: Grid, draftDeg: number, mode: DraftMode = 'remove'): Float64Array {
  if (!(draftDeg > 0)) return depth;
  const tan = Math.tan((draftDeg * Math.PI) / 180);
  if (mode !== 'centre') return limitSlope(depth, grid, 1 / tan, mode === 'add');
  // A wall from 0 to D: half the taper cut back, half grown out, averaged,
  // stands at (z - D/2) tan(angle) off where it was, which is the pivot wanted.
  const shallower = limitSlope(depth, grid, 2 / tan, false);
  const deeper = limitSlope(depth, grid, 2 / tan, true);
  const out = new Float64Array(depth.length);
  for (let i = 0; i < out.length; i++) out[i] = (shallower[i] + deeper[i]) / 2;
  return out;
}

/** The shallowest taper on any cavity wall, in degrees off the pull direction. */
export function shallowestDraft(depth: Float64Array, grid: Grid): number {
  let steepest = 0;
  const { cols, rows } = grid;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (c + 1 < cols) steepest = Math.max(steepest, Math.abs(depth[i + 1] - depth[i]) / grid.stepX);
      if (r + 1 < rows) steepest = Math.max(steepest, Math.abs(depth[i + cols] - depth[i]) / grid.stepY);
    }
  }
  if (steepest <= 1e-9) return 90;
  return (Math.atan(1 / steepest) * 180) / Math.PI;
}

/** Whether a drafted cavity reaches the block's outer edge, which leaves a hole in its side wall. */
export function draftBreaksSide(depth: Float64Array, grid: Grid): boolean {
  const { cols, rows } = grid;
  for (let c = 0; c < cols; c++) {
    if (depth[c] > 1e-6 || depth[(rows - 1) * cols + c] > 1e-6) return true;
  }
  for (let r = 0; r < rows; r++) {
    if (depth[r * cols] > 1e-6 || depth[r * cols + cols - 1] > 1e-6) return true;
  }
  return false;
}

/** Each column's depth no deeper than its shallowest neighbour: the cavity pulled in by a cell. */
export function erodeDepth(depth: Float64Array, grid: Grid): Float64Array {
  const { cols, rows } = grid;
  const out = new Float64Array(depth.length);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let m = depth[r * cols + c];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) { m = 0; continue; }
          m = Math.min(m, depth[rr * cols + cc]);
        }
      }
      out[r * cols + c] = m;
    }
  }
  return out;
}
