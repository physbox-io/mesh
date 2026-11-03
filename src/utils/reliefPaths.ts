// Toolpath polylines: simplifying, squaring up at walls, and the number format the G-code is written in.

import { WALL_SLOPE } from './finishingPaths';
import type { Heightmap } from './reliefHeightmap';

/** A finishing point this close to the straight line through its neighbours is noise (mm). */
export const PATH_SIMPLIFY_MM = 0.01;

/**
 * The same idea for roughing, looser, and tied to the allowance.
 *
 * Roughing leaves an allowance for the finishing pass to take off, so a ring
 * may stray from its curve by up to half of it and still never reach the
 * finished surface. Held to a fixed twentieth of a millimetre instead, a ring
 * keeps nearly every marching-squares vertex — they zigzag by a fraction of a
 * cell — and an adaptive clear of a dome came to three times the lines of a
 * raster. Capped, because past a quarter of a millimetre the ring is visibly
 * not the curve any more; floored for a job with no allowance at all, where
 * roughing cuts the surface itself.
 */
export function roughSimplifyMm(allowanceMm: number, resolutionMm = 0): number {
  return Math.min(0.25, Math.max(0.05, allowanceMm / 2, Math.min(allowanceMm, resolutionMm * 0.4)));
}
/** How far the simplifier looks ahead before it commits to a point. */
const SIMPLIFY_LOOKAHEAD = 48;
/** Preview vertex budget — past this the viewport, not the mill, is the bottleneck. */
export const MAX_PREVIEW_POINTS = 60_000;

export function f(num: number): string {
  return num.toFixed(3);
}

// ---------------------------------------------------------------------------
// Path building
// ---------------------------------------------------------------------------

export interface PathPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * Thins a raster pass down to the points that carry its shape.
 *
 * A relief raster samples on a fixed grid, so a flat stretch of background
 * arrives as hundreds of identical moves. GRBL only swallows a few hundred
 * lines a second over serial, and a job that streams slower than it cuts stalls
 * the spindle in the cut — so points that sit on the straight line between the
 * ones either side of them are dropped.
 *
 * "On the line" is measured in plan as well as in Z. This used to check Z
 * alone, which is all a raster needs — its points are collinear in plan by
 * construction — but a waterline contour or a roughing ring sits at one Z the
 * whole way round, so every point passed and the path was cut to one vertex in
 * forty-eight: straight 10 mm chords across a closed curve, driven through the
 * islands it was going round. On a giraffe hide that put the finishing ball
 * nose up to 6 mm into the patches.
 */
/**
 * Heights the target surface is flat at over an area at least a cutter wide,
 * highest first: the levels a roughing layer has to land on exactly for a
 * flat face to come out flat. `offset` is added to every height (the roughing
 * allowance). Read to the hundredth of a millimetre, which is finer than any
 * layer and coarser than a flat face's float noise.
 *
 * A cell only counts when its four neighbours sit at its height too. Counting
 * every cell that rounds to a level found hundreds of "flats" on a gently
 * sloping dome — each ring of cells shares a rounded height — and a soap
 * dish's roughing went from two and a half hours to twelve.
 */
export function flatLevels(map: Heightmap, offset: number, cutterDiaMm: number): number[] {
  const cellArea = Math.max(1e-9, map.stepX * map.stepY);
  const minCells = Math.max(4, Math.ceil((cutterDiaMm * cutterDiaMm) / cellArea));
  const counts = new Map<number, number>();
  const { cols, rows, z } = map;
  for (let j = 1; j < rows - 1; j++) {
    for (let i = 1; i < cols - 1; i++) {
      const k = j * cols + i;
      const v = z[k];
      if (
        Math.abs(z[k - 1] - v) > 5e-3 || Math.abs(z[k + 1] - v) > 5e-3 ||
        Math.abs(z[k - cols] - v) > 5e-3 || Math.abs(z[k + cols] - v) > 5e-3
      ) continue;
      const key = Math.round((v + offset) * 100);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const levels: number[] = [];
  for (const [key, n] of counts) if (n >= minCells) levels.push(key / 100);
  return levels.sort((a, b) => b - a);
}

/**
 * Turns a pass's steep steps into square ones, high side first.
 *
 * A pass is a list of samples of the cutter-offset surface, a resolution step
 * apart, and the machine draws a straight line between each pair. Across a
 * vertical wall that line is a chamfer: the cutter starts down while its edge
 * is still over the top of the wall, and cuts into it — up to 0.65 mm into a
 * pocket's rim on the part this was found on, on every wall the raster
 * crossed. Where the samples rise or fall more steeply than `WALL_SLOPE`, the
 * cutter now stays at the higher of the two until it is over the lower one
 * and goes straight down there, or goes straight up first and then across.
 * Somewhere between the two samples is the wall, and that is the only side of
 * it the cutter can be wrong on without cutting into the part: it leaves at
 * most a sample step of material against the wall instead of gouging it.
 */
export function squareUpWalls(points: PathPoint[], maxSlope = WALL_SLOPE): PathPoint[] {
  if (points.length < 2) return points;
  const out: PathPoint[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1];
    const q = points[i];
    const run = Math.hypot(q.x - p.x, q.y - p.y);
    const rise = q.z - p.z;
    if (run > 1e-9 && Math.abs(rise) > run * maxSlope) {
      // Down: across at the top, then down. Up: up first, then across.
      out.push(rise < 0 ? { x: q.x, y: q.y, z: p.z } : { x: p.x, y: p.y, z: q.z });
    }
    out.push(q);
  }
  return out;
}

/**
 * For each waterline run, the runs at a higher level that pass within `reach`
 * of it: the ones that must be cut before it.
 *
 * Roughing leaves its allowance standing the whole height of every wall. A
 * waterline at the foot of a wall cut before the levels above it buries the
 * finishing cutter's flank in all of it at once, a side cut as tall as the
 * wall; top down, each level takes only its own step. Runs that are not
 * waterlines (`levels[i]` undefined) wait for nothing and hold nothing up.
 *
 * Points are sampled every quarter of `reach` and binned on a grid of that
 * size, so a run is matched only against what is nearby.
 */
export function higherWaterlinesNear(
  runs: { x: number; y: number }[][],
  levels: (number | undefined)[],
  reach: number
): number[][] {
  const out = runs.map(() => [] as number[]);
  if (!(reach > 0) || !levels.some((l) => l !== undefined)) return out;

  const cell = reach;
  const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  const samples = runs.map((run, i) => {
    if (levels[i] === undefined || run.length === 0) return [];
    const pts = [run[0]];
    let from = run[0];
    for (let k = 1; k < run.length; k++) {
      const p = run[k];
      const d = Math.hypot(p.x - from.x, p.y - from.y);
      if (d >= reach / 4 || k === run.length - 1) {
        // Long moves are filled in, or a waterline straight along a wall
        // would be two points a wall's length apart.
        const extra = Math.floor(d / (reach / 4));
        for (let e = 1; e < extra; e++) {
          pts.push({ x: from.x + ((p.x - from.x) * e) / extra, y: from.y + ((p.y - from.y) * e) / extra });
        }
        pts.push(p);
        from = p;
      }
    }
    return pts;
  });

  const bins = new Map<string, { run: number; x: number; y: number }[]>();
  samples.forEach((pts, run) => {
    for (const p of pts) {
      const k = key(p.x, p.y);
      let bin = bins.get(k);
      if (!bin) bins.set(k, (bin = []));
      bin.push({ run, x: p.x, y: p.y });
    }
  });

  samples.forEach((pts, i) => {
    const level = levels[i];
    if (level === undefined) return;
    const found = new Set<number>();
    for (const p of pts) {
      const cx = Math.floor(p.x / cell);
      const cy = Math.floor(p.y / cell);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const bin = bins.get(`${cx + dx},${cy + dy}`);
          if (!bin) continue;
          for (const q of bin) {
            if (found.has(q.run)) continue;
            const other = levels[q.run];
            if (other === undefined || other <= level + 1e-6) continue;
            if (Math.hypot(q.x - p.x, q.y - p.y) < reach) found.add(q.run);
          }
        }
      }
    }
    out[i] = [...found];
  });
  return out;
}

export function simplifyPass(points: PathPoint[], tolMm: number): PathPoint[] {
  if (points.length <= 2) return points;

  const kept: PathPoint[] = [points[0]];
  let anchor = 0;

  for (let i = 1; i < points.length; i++) {
    const a = points[anchor];
    const b = points[i];
    const spanX = b.x - a.x;
    const spanY = b.y - a.y;
    const span2 = spanX * spanX + spanY * spanY;

    let fits = i - anchor <= SIMPLIFY_LOOKAHEAD;
    if (fits) {
      for (let j = anchor + 1; j < i; j++) {
        const p = points[j];
        // Nearest point on the chord in plan, and how far off it p lies.
        const t = span2 > 1e-18
          ? Math.min(1, Math.max(0, ((p.x - a.x) * spanX + (p.y - a.y) * spanY) / span2))
          : 0;
        const off = Math.hypot(p.x - (a.x + spanX * t), p.y - (a.y + spanY * t));
        if (off > tolMm || Math.abs(p.z - (a.z + (b.z - a.z) * t)) > tolMm) {
          fits = false;
          break;
        }
      }
    }

    if (!fits) {
      kept.push(points[i - 1]);
      anchor = i - 1;
    }
  }

  kept.push(points[points.length - 1]);
  return kept;
}

/** Sample positions along one axis, inclusive of both ends. */
export function axisSamples(from: number, to: number, step: number): number[] {
  if (to <= from) return [(from + to) / 2];
  const count = Math.max(1, Math.ceil((to - from) / step));
  const out: number[] = [];
  for (let i = 0; i <= count; i++) out.push(from + ((to - from) * i) / count);
  return out;
}

/**
 * A closed loop turned to start at (x, y), split there if it falls part way
 * along a segment; null where the point is not on the loop.
 */
export function startLoopAt(loop: PathPoint[], x: number, y: number): PathPoint[] | null {
  for (let i = 0; i + 1 < loop.length; i++) {
    const a = loop[i];
    const b = loop[i + 1];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const lenSq = ex * ex + ey * ey;
    let t = lenSq > 1e-12 ? ((x - a.x) * ex + (y - a.y) * ey) / lenSq : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    if (Math.hypot(a.x + ex * t - x, a.y + ey * t - y) > 1e-6) continue;
    const k = t < 1e-9 ? i : t > 1 - 1e-9 ? i + 1 : -1;
    if (k === 0 || k === loop.length - 1) return loop;
    if (k > 0) return [...loop.slice(k), ...loop.slice(1, k + 1)];
    const p = { ...a, x, y, z: a.z + (b.z - a.z) * t };
    return [p, ...loop.slice(i + 1), ...loop.slice(1, i + 1), p];
  }
  return null;
}
