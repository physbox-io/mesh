import { describe, it, expect } from 'vitest';
import { machineSurface } from '../src/utils/machineSurface';
import { simulateMilling } from '../src/utils/cutSimulation';
import { DEFAULT_RELIEF_OPTIONS, type ReliefCarveOptions } from '../src/utils/reliefOptions';

/*
 * The finishing tool's shank is checked against what is still standing when
 * it gets there, not only against the finished surface. A valley narrower
 * than the roughing bit is left at full height by roughing; the finishing
 * bit's flutes fit the valley and so does its shank against the finished
 * walls, but its shank sat in the stock roughing never took out.
 */

const W = 40, D = 30, CELL = 0.1, TOL = 0.75;

/**
 * Runs the program through a heightmap of the stock, cutting with a flat end
 * mill of the fitted tool's diameter, and after the tool change checks every
 * point of every move for stock standing more than `flute` above the tip
 * under the cutter or under a shank of `shankR`: the part of the tool that
 * does not cut, driven into what is left. Returns the worst intrusion, mm.
 */
function worstShankIntrusion(gcode: string, roughDia: number, finishDia: number, shankR: number, flute: number) {
  const cols = Math.ceil(W / CELL), rows = Math.ceil(D / CELL);
  const h = new Float64Array(cols * rows);
  let r = roughDia / 2, finishing = false, worst = 0;
  let x = 0, y = 0, z = 5;
  const disc = (px: number, py: number, R: number, fn: (k: number) => void) => {
    const i0 = Math.max(0, Math.floor((px - R) / CELL)), i1 = Math.min(cols - 1, Math.floor((px + R) / CELL));
    const j0 = Math.max(0, Math.floor((py - R) / CELL)), j1 = Math.min(rows - 1, Math.floor((py + R) / CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const cx = (i + 0.5) * CELL - px, cy = (j + 0.5) * CELL - py;
      if (cx * cx + cy * cy <= R * R) fn(j * cols + i);
    }
  };
  for (const raw of gcode.split('\n')) {
    const code = raw.split(';')[0].trim();
    if (/\bM6\b/.test(code)) { r = finishDia / 2; finishing = true; continue; }
    if (!/^G[01]\b/.test(code)) continue;
    const g = (k: string, d: number) => { const m = new RegExp(`${k}(-?[\\d.]+)`).exec(code); return m ? parseFloat(m[1]) : d; };
    const nx = g('X', x), ny = g('Y', y), nz = g('Z', z);
    const n = Math.max(1, Math.ceil(Math.hypot(nx - x, ny - y, nz - z) / (CELL / 2)));
    for (let s = 1; s <= n; s++) {
      const px = x + ((nx - x) * s) / n, py = y + ((ny - y) * s) / n, pz = z + ((nz - z) * s) / n;
      if (finishing) {
        // What the flutes reach is cut to the tip as they go, so only the
        // stock above their length counts there; a cell the cutter's rim
        // only grazes is left out, and so is a hairline under the shank's
        // rim (TOL), where the two grids disagree by up to a cell.
        disc(px, py, Math.max(r, shankR - TOL), (k) => {
          const i = k % cols, j = (k - i) / cols;
          const d = Math.hypot((i + 0.5) * CELL - px, (j + 0.5) * CELL - py);
          if (d > r && d <= r + CELL) return;
          worst = Math.max(worst, h[k] - (pz + flute));
        });
      }
      if (pz < 0) disc(px, py, r, (k) => { if (pz < h[k]) h[k] = pz; });
    }
    x = nx; y = ny; z = nz;
  }
  return worst;
}

describe('finishing shank clearance against the stock still standing', () => {
  it('keeps the shank out of a valley the roughing bit could not enter', () => {
    const step = 0.5;
    const cols = W / step + 1, rows = D / step + 1;
    const z = new Float32Array(cols * rows);
    // 14 mm wide, 12 mm deep valley: a 16 mm rougher cannot enter it; a 3 mm
    // finisher on a 6 mm shank reaches its floor down the middle.
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = c * step, y = r * step;
      if (x > 13 && x < 27 && y > 5 && y < 25) z[r * cols + c] = -12;
    }
    const opts: ReliefCarveOptions = {
      ...DEFAULT_RELIEF_OPTIONS,
      stockWidthMm: W,
      stockDepthMm: D,
      stockThicknessMm: 20,
      carveDepthMm: 12,
      roughingEnabled: true,
      finishingEnabled: true,
      roughingToolDiaMm: 16,
      finishingToolDiaMm: 3,
      finishingToolType: 'flat',
      finishingShankDiaMm: 6,
      finishingFluteLengthMm: 5,
      toolBodyClearance: true,
      roughingAllowanceMm: 0.5,
      roughingStepdownMm: 2,
    };
    const warnings: string[] = [];
    const res = machineSurface(
      {
        surface: { minX: 0, minY: 0, maxX: W, maxY: D, cols, rows, stepX: step, stepY: step, z },
        bounds: { minX: 0, minY: 0, maxX: W, maxY: D, minZ: -20, maxZ: 0 },
        depthMm: 12,
        resolution: step,
        header: ['; shank clearance'],
      },
      opts,
      warnings
    );
    expect(res.success, res.error).toBe(true);
    expect(worstShankIntrusion(res.gcode, 16, 3, 3, 5)).toBeLessThan(0.3);
    // ...and still takes the middle of the valley to its floor, a flute
    // length a sweep, rather than leaving it at the first sweep's depth.
    const sim = simulateMilling(res.gcode, {
      widthMm: W, depthMm: D, cellMm: 0.2,
      tools: { 1: { shape: 'flat', diameterMm: 16 }, 2: { shape: 'flat', diameterMm: 3 } },
    });
    for (const x of [18, 20, 22]) expect(sim.at(x, 15)).toBeLessThan(-11.9);
  });
});
