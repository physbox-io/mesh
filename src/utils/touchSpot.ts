// Where a new bit is touched off at a tool change.

import { distanceTransform } from './distanceTransform';
import type { StockBounds, StockModel } from './stockModel';

/** A place on the block to stand a tool over and take Z from. */
export interface TouchSpot {
  x: number;
  y: number;
  /** Height of the ground there, 0 being the stock's top face. */
  levelMm: number;
  /** Radius of the patch of that ground round the spot, mm. */
  clearanceMm: number;
}

/** Ground within this of one height counts as one flat. */
const FLAT_MM = 0.02;
/** Room to set a paper or a small plate down beside the bit, mm. */
const USEFUL_CLEARANCE_MM = 3;
/** Flat levels looked at, most ground first. */
const FLATS_TRIED = 6;
const MAX_CELLS = 2e6;

/**
 * The widest ground a bit of `bitRadiusMm` can be touched off on, or null when
 * nothing flat is wide enough.
 *
 * The stock's own top face comes first, the middle of its widest patch, so the
 * new bit lands where the old one's Z0 still holds; failing that, the middle of
 * the widest roughing floor. Slopes are never offered: the model only bounds a
 * slope's height from above, and a touch-off that high would cut too deep.
 *
 * The patch has to hold the whole bit and two cells more. A cell counts as
 * uncut until a single pass covers all of it, so the model's patch overstates
 * the real one by up to a cell at its rim.
 *
 * `area` is the whole of the top the tool can stand over, and `standsAt` says
 * where something the model has not seen took that top away. The radius here
 * is measured to the edge of the block too, which keeps it off the clamps.
 */
export function chooseTouchSpot(
  stock: StockModel,
  area: StockBounds,
  bitRadiusMm: number,
  standsAt?: (x: number, y: number) => boolean
): TouchSpot | null {
  const w = area.maxX - area.minX, d = area.maxY - area.minY;
  const cell = Math.max(stock.cell, Math.sqrt((w * d) / MAX_CELLS));
  const cols = Math.max(1, Math.ceil(w / cell - 1e-9));
  const rows = Math.max(1, Math.ceil(d / cell - 1e-9));
  const { low, high } = stock.levelsOver({ minX: area.minX, minY: area.minY, cell, cols, rows });
  const at = (c: number, r: number) => ({ x: area.minX + (c + 0.5) * cell, y: area.minY + (r + 0.5) * cell });
  const usable = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      if (high[k] - low[k] > FLAT_MM) continue;
      if (standsAt) {
        const p = at(c, r);
        if (!standsAt(p.x, p.y)) continue;
      }
      usable[k] = 1;
    }
  }

  /** The middle of the widest patch of the cells `on` picks. */
  const widest = (on: (k: number) => boolean) => {
    // One cell round the grid is off the block, so the block's edge counts.
    const pc = cols + 2, pr = rows + 2;
    const off = new Uint8Array(pc * pr).fill(1);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (usable[r * cols + c] && on(r * cols + c)) off[(r + 1) * pc + c + 1] = 0;
      }
    }
    const dist = distanceTransform(off, pc, pr);
    let best = 0;
    for (let k = 0; k < dist.length; k++) if (dist[k] > best) best = dist[k];
    if (best <= 0) return null;
    // A long patch has a ridge of equal cells: the one nearest the block's middle.
    let pick = -1, nearest = Infinity;
    for (let k = 0; k < dist.length; k++) {
      if (dist[k] < best - 1e-3) continue;
      const r = Math.floor(k / pc), c = k - r * pc;
      const away = Math.hypot(c - pc / 2, r - pr / 2);
      if (away < nearest) { nearest = away; pick = k; }
    }
    const r = Math.floor(pick / pc) - 1, c = pick % pc - 1;
    return { ...at(c, r), k: r * cols + c, clearanceMm: (best - 0.5) * cell };
  };

  const fits = bitRadiusMm + 2 * cell;
  const useful = Math.max(USEFUL_CLEARANCE_MM, fits + 1);

  const top = widest((k) => high[k] >= -FLAT_MM);
  const spotOf = (p: NonNullable<typeof top>, levelMm: number): TouchSpot => ({
    x: Math.round(p.x * 10) / 10,
    y: Math.round(p.y * 10) / 10,
    levelMm,
    clearanceMm: p.clearanceMm,
  });
  if (top && top.clearanceMm >= useful) return spotOf(top, 0);

  // The floors, by how much ground each has.
  const counts = new Map<number, number>();
  for (let k = 0; k < high.length; k++) {
    if (!usable[k] || high[k] >= -FLAT_MM) continue;
    const bin = Math.round(high[k] / FLAT_MM);
    counts.set(bin, (counts.get(bin) ?? 0) + 1);
  }
  const enough = Math.PI * (fits / cell) ** 2;
  const levels = [...counts].filter(([, n]) => n >= enough).sort((p, q) => q[1] - p[1]).slice(0, FLATS_TRIED);
  let flat: ReturnType<typeof widest> = null;
  for (const [bin] of levels) {
    const level = bin * FLAT_MM;
    const patch = widest((k) => Math.abs(high[k] - level) <= FLAT_MM);
    if (patch && (!flat || patch.clearanceMm > flat.clearanceMm)) flat = patch;
  }

  if (flat && flat.clearanceMm >= fits && (!top || flat.clearanceMm > top.clearanceMm)) {
    return spotOf(flat, Math.round(high[flat.k] * 1000) / 1000);
  }
  return top && top.clearanceMm >= fits ? spotOf(top, 0) : null;
}
