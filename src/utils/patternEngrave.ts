// ---------------------------------------------------------------------------
// A surface pattern drawn as lines: the 2D form of a relief, for a laser.
//
// A laser cannot cut a relief, but it can engrave one's outline. Each region a
// pattern was laid on reports the relief over a grid (ReliefField, in
// surfaceTexture.ts); this traces contours of it with marching squares. A
// two-level pattern -- bricks, parquet, a topographic terrace -- is exactly
// one contour, its walls. A graded one -- wood grain, waves -- reads as a few
// evenly spaced levels, the way a contour map reads a hill.
//
// Lines come back in the geom's own frame, so the exporter that draws them
// places them with the same matrix as the rest of the geom.
// ---------------------------------------------------------------------------

import type { Vec3 } from './measureSnap';
import type { ReliefField } from './surfaceTexture';

/** The levels a field is traced at when the caller does not say. */
export function defaultEngraveLevels(field: ReliefField): number[] {
  return field.twoLevel ? [0.5] : [0.25, 0.5, 0.75];
}

/** Past this many points in one field the lines are thinned harder. */
const MAX_POINTS = 120_000;

/**
 * Contours of the relief at each level, as polylines in the geom's frame.
 * Closed loops repeat their first point at the end.
 */
export function reliefContours(field: ReliefField, levels = defaultEngraveLevels(field)): Vec3[][] {
  const { cols, rows, step, data } = field;
  const lines2D: number[][][] = [];
  for (const level of levels) lines2D.push(...contourAt(data, cols, rows, step, level));

  let total = 0;
  for (const l of lines2D) total += l.length;
  // A quarter of a cell keeps every corner a two-level pattern has; a dense
  // graded pattern is thinned more rather than handed to a laser as a million
  // points.
  const tolerance = (step / 4) * Math.max(1, Math.sqrt(total / MAX_POINTS));

  const { origin, u, v } = field;
  return lines2D
    .map((line) => simplify(line, tolerance))
    .filter((line) => line.length >= 2)
    .map((line) => line.map(([x, y]) => [
      origin[0] + u[0] * x + v[0] * y,
      origin[1] + u[1] * x + v[1] * y,
      origin[2] + u[2] * x + v[2] * y,
    ] as Vec3));
}

/** Marching squares at one level, chained into polylines, in grid metres. */
function contourAt(data: Float32Array, cols: number, rows: number, step: number, level: number): number[][][] {
  // A crossing lives on a grid edge, and its id is that edge's: a horizontal
  // edge from (c, r) is 2·(r·cols + c), the vertical one 2·(r·cols + c) + 1.
  // Two segments meeting at a crossing share its id, which is how they chain.
  const point = new Map<number, number[]>();
  const at = (c: number, r: number) => data[r * cols + c];
  const cross = (id: number, x0: number, y0: number, a: number, x1: number, y1: number, b: number) => {
    if (!point.has(id)) {
      const t = a === b ? 0.5 : (level - a) / (b - a);
      point.set(id, [(x0 + (x1 - x0) * t) * step, (y0 + (y1 - y0) * t) * step]);
    }
    return id;
  };
  const neighbours = new Map<number, number[]>();
  const link = (p: number, q: number) => {
    const lp = neighbours.get(p);
    if (lp) lp.push(q); else neighbours.set(p, [q]);
    const lq = neighbours.get(q);
    if (lq) lq.push(p); else neighbours.set(q, [p]);
  };

  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      const a = at(c, r), b = at(c + 1, r), cc = at(c + 1, r + 1), d = at(c, r + 1);
      const idx = (a > level ? 1 : 0) | (b > level ? 2 : 0) | (cc > level ? 4 : 0) | (d > level ? 8 : 0);
      if (idx === 0 || idx === 15) continue;
      const bottom = () => cross(2 * (r * cols + c), c, r, a, c + 1, r, b);
      const right = () => cross(2 * (r * cols + c + 1) + 1, c + 1, r, b, c + 1, r + 1, cc);
      const top = () => cross(2 * ((r + 1) * cols + c), c, r + 1, d, c + 1, r + 1, cc);
      const left = () => cross(2 * (r * cols + c) + 1, c, r, a, c, r + 1, d);
      switch (idx) {
        case 1: case 14: link(left(), bottom()); break;
        case 2: case 13: link(bottom(), right()); break;
        case 3: case 12: link(left(), right()); break;
        case 4: case 11: link(right(), top()); break;
        case 6: case 9: link(bottom(), top()); break;
        case 7: case 8: link(left(), top()); break;
        case 5: case 10: {
          // A saddle: the middle of the cell says which pair of corners join.
          const middle = (a + b + cc + d) / 4 > level;
          if ((idx === 5) === middle) { link(left(), top()); link(bottom(), right()); }
          else { link(left(), bottom()); link(right(), top()); }
          break;
        }
      }
    }
  }

  // Walk each chain from an end if it has one, so open lines come out whole.
  const lines: number[][][] = [];
  const seen = new Set<number>();
  const walk = (start: number) => {
    const line = [point.get(start)!];
    seen.add(start);
    let prev = -1, cur = start;
    for (;;) {
      const next = (neighbours.get(cur) ?? []).find((n) => n !== prev && !seen.has(n));
      if (next === undefined) {
        // Back where it started: a closed loop.
        if ((neighbours.get(cur) ?? []).includes(start) && line.length > 2) line.push(point.get(start)!);
        break;
      }
      seen.add(next);
      line.push(point.get(next)!);
      prev = cur;
      cur = next;
    }
    lines.push(line);
  };
  for (const [id, list] of neighbours) if (list.length === 1 && !seen.has(id)) walk(id);
  for (const id of neighbours.keys()) if (!seen.has(id)) walk(id);
  return lines;
}

/** Ramer-Douglas-Peucker, keeping both ends. */
function simplify(line: number[][], tolerance: number): number[][] {
  if (line.length <= 2) return line;
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack: [number, number][] = [[0, line.length - 1]];
  const t2 = tolerance * tolerance;
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const [ax, ay] = line[i], [bx, by] = line[j];
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let worst = -1, worstD = t2;
    for (let k = i + 1; k < j; k++) {
      const [px, py] = line[k];
      let d2: number;
      if (l2 === 0) d2 = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        const cr = dx * (py - ay) - dy * (px - ax);
        d2 = (cr * cr) / l2;
      }
      if (d2 > worstD) { worstD = d2; worst = k; }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([i, worst], [worst, j]);
    }
  }
  return line.filter((_, k) => keep[k]);
}
