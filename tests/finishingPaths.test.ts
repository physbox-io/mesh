import { describe, it, expect } from 'vitest';
import {
  finishingPasses,
  rasterPasses,
  concentricPasses,
  spiralPasses,
  contourPasses,
  hybridPasses,
  resamplePolyline,
  surfaceSlopeDeg,
  describeFinishingStrategy,
  type FinishingPathInput,
  type SurfaceGrid,
} from '../src/utils/finishingPaths';

const BOUNDS = { minX: 0, minY: 0, maxX: 40, maxY: 30 };

/**
 * A cone dropped into the middle of a flat board: flat background at Z 0, a
 * conical pit falling to -10 at the centre. Steep sides, flat surround — which
 * is exactly the surface that shows up the difference between the strategies.
 */
function conePit(cols = 41, rows = 31, depth = 10, radius = 12): SurfaceGrid {
  const stepX = (BOUNDS.maxX - BOUNDS.minX) / (cols - 1);
  const stepY = (BOUNDS.maxY - BOUNDS.minY) / (rows - 1);
  const z = new Float32Array(cols * rows);
  const cx = (BOUNDS.minX + BOUNDS.maxX) / 2;
  const cy = (BOUNDS.minY + BOUNDS.maxY) / 2;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = BOUNDS.minX + c * stepX;
      const y = BOUNDS.minY + r * stepY;
      const d = Math.hypot(x - cx, y - cy);
      z[r * cols + c] = d >= radius ? 0 : -depth * (1 - d / radius);
    }
  }
  return { ...BOUNDS, cols, rows, stepX, stepY, z };
}

function input(over: Partial<FinishingPathInput> = {}): FinishingPathInput {
  return {
    bounds: BOUNDS,
    stepover: 2,
    resolution: 1,
    angleDeg: 0,
    surface: conePit(),
    floorZ: -10,
    ...over,
  };
}

const inRect = (p: { x: number; y: number }, b = BOUNDS) =>
  p.x >= b.minX - 1e-6 && p.x <= b.maxX + 1e-6 && p.y >= b.minY - 1e-6 && p.y <= b.maxY + 1e-6;

describe('resamplePolyline', () => {
  it('divides each segment evenly and never exceeds the step', () => {
    const out = resamplePolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }], 3);
    // 10 mm at a 3 mm step is 4 even parts of 2.5, not 3+3+3+1.
    expect(out).toHaveLength(5);
    for (let i = 1; i < out.length; i++) {
      expect(Math.hypot(out[i].x - out[i - 1].x, out[i].y - out[i - 1].y)).toBeCloseTo(2.5, 6);
    }
  });

  it('keeps every original vertex, so a corner survives resampling', () => {
    const corner = { x: 10, y: 0 };
    const out = resamplePolyline([{ x: 0, y: 0 }, corner, { x: 10, y: 10 }], 3);
    expect(out.some((p) => Math.abs(p.x - corner.x) < 1e-9 && Math.abs(p.y - corner.y) < 1e-9)).toBe(true);
  });

  it('leaves a degenerate path alone', () => {
    expect(resamplePolyline([{ x: 1, y: 2 }], 1)).toHaveLength(1);
  });
});

describe('rasterPasses', () => {
  it('reaches both edges of the stock, so no uncut strip is left', () => {
    const passes = rasterPasses(input(), 0);
    const ys = passes.map((p) => p[0].y);
    expect(Math.min(...ys)).toBeCloseTo(BOUNDS.minY, 6);
    expect(Math.max(...ys)).toBeCloseTo(BOUNDS.maxY, 6);
  });

  it('spaces passes no wider than the stepover', () => {
    const stepover = 2;
    const ys = rasterPasses(input({ stepover }), 0)
      .map((p) => p[0].y)
      .sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i] - ys[i - 1]).toBeLessThanOrEqual(stepover + 1e-6);
    }
  });

  it('alternates direction, so the tool does not fly back for every pass', () => {
    const passes = rasterPasses(input(), 0);
    const forward = passes.map((p) => p[p.length - 1].x > p[0].x);
    for (let i = 1; i < forward.length; i++) expect(forward[i]).toBe(!forward[i - 1]);
  });

  it('is the old X sweep at 0 degrees and the old Y sweep at 90', () => {
    const alongX = rasterPasses(input(), 0);
    const alongY = rasterPasses(input(), 90);
    // Every pass of an X raster holds Y; every pass of a Y raster holds X.
    for (const p of alongX) expect(p.every((q) => Math.abs(q.y - p[0].y) < 1e-6)).toBe(true);
    for (const p of alongY) expect(p.every((q) => Math.abs(q.x - p[0].x) < 1e-6)).toBe(true);
  });

  it('stays inside the stock at an angle', () => {
    for (const angle of [15, 45, 70, -30, 135]) {
      const passes = rasterPasses(input(), angle);
      expect(passes.length).toBeGreaterThan(0);
      for (const pass of passes) for (const p of pass) expect(inRect(p)).toBe(true);
    }
  });

  it('holds the requested angle', () => {
    const passes = rasterPasses(input(), 45);
    // Take a pass long enough to read an angle off reliably.
    const long = passes.reduce((a, b) => (b.length > a.length ? b : a));
    const dx = long[long.length - 1].x - long[0].x;
    const dy = long[long.length - 1].y - long[0].y;
    expect(Math.abs(Math.abs(dy / dx) - 1)).toBeLessThan(1e-6);
  });
});

describe('concentric and spiral', () => {
  it('walks rings inward, outermost first, all inside the stock', () => {
    const rings = concentricPasses(input());
    expect(rings.length).toBeGreaterThan(1);
    for (const ring of rings) for (const p of ring) expect(inRect(p)).toBe(true);

    const extent = (ring: { x: number; y: number }[]) =>
      Math.max(...ring.map((p) => p.x)) - Math.min(...ring.map((p) => p.x));
    expect(extent(rings[0])).toBeGreaterThan(extent(rings[rings.length - 1]));
  });

  it('closes every ring, so the tool finishes where it started', () => {
    for (const ring of concentricPasses(input())) {
      const a = ring[0];
      const b = ring[ring.length - 1];
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThan(1e-6);
    }
  });

  it('joins the rings into far fewer paths than the rings it came from', () => {
    const rings = concentricPasses(input());
    const spiral = spiralPasses(input());
    expect(spiral.length).toBeLessThan(rings.length);
    // A continuous spiral means the tool enters once: on a rectangle, once full stop.
    expect(spiral).toHaveLength(1);
  });

  it('bridges between rings without a jump longer than a few stepovers', () => {
    const stepover = 2;
    const [path] = spiralPasses(input({ stepover }));
    let worst = 0;
    for (let i = 1; i < path.length; i++) {
      worst = Math.max(worst, Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
    }
    expect(worst).toBeLessThanOrEqual(stepover * 3 + 1e-6);
  });
});

describe('contour (waterline)', () => {
  it('follows the level lines of the surface', () => {
    const surface = conePit();
    const passes = contourPasses(input({ surface }));
    expect(passes.length).toBeGreaterThan(2);

    // Every point of a given pass sits at very nearly one height — that is what
    // makes it a waterline rather than a raster.
    for (const pass of passes) {
      const zs = pass.map((p) => sample(surface, p.x, p.y));
      expect(Math.max(...zs) - Math.min(...zs)).toBeLessThan(1.0);
    }
  });

  it('rings the pit rather than crossing the flat background', () => {
    const passes = contourPasses(input());
    const cx = (BOUNDS.minX + BOUNDS.maxX) / 2;
    const cy = (BOUNDS.minY + BOUNDS.maxY) / 2;
    // The cone's radius is 12; nothing outside it is at a cuttable level.
    for (const pass of passes) {
      for (const p of pass) expect(Math.hypot(p.x - cx, p.y - cy)).toBeLessThan(13);
    }
  });

  it('produces nothing on a surface with no relief in it', () => {
    const flat = conePit();
    flat.z.fill(0);
    expect(contourPasses(input({ surface: flat }))).toHaveLength(0);
  });

  it('stays inside the stock', () => {
    for (const pass of contourPasses(input())) {
      for (const p of pass) expect(inRect(p)).toBe(true);
    }
  });
});

describe('hybrid', () => {
  it('reads slope off the surface', () => {
    const surface = conePit();
    // Cone half-angle: 10 mm deep over a 12 mm radius is about 39.8 degrees.
    expect(surfaceSlopeDeg(surface, 20, 10)).toBeGreaterThan(30);
    // Well outside the pit, the board is flat.
    expect(surfaceSlopeDeg(surface, 2, 2)).toBeLessThan(1);
  });

  it('sends the steep ground to the waterline and the flat to the raster', () => {
    const surface = conePit();
    const passes = hybridPasses(input({ surface, steepAngleDeg: 30 }));
    expect(passes.length).toBeGreaterThan(0);

    const cx = (BOUNDS.minX + BOUNDS.maxX) / 2;
    const cy = (BOUNDS.minY + BOUNDS.maxY) / 2;
    const radial = passes.flat().map((p) => Math.hypot(p.x - cx, p.y - cy));
    // Both regions are covered: passes on the wall and passes out on the flat.
    expect(radial.some((r) => r < 12)).toBe(true);
    expect(radial.some((r) => r > 14)).toBe(true);
  });

  it('drops the one-point runs that would be a plunge and a retract for nothing', () => {
    for (const pass of hybridPasses(input({ steepAngleDeg: 30 }))) {
      expect(pass.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('degenerates to a plain raster when nothing is steep enough', () => {
    const passes = hybridPasses(input({ steepAngleDeg: 85 }));
    const raster = rasterPasses(input(), 0);
    expect(passes).toHaveLength(raster.length);
  });
});

describe('finishingPasses', () => {
  it('dispatches every strategy and keeps them all inside the stock', () => {
    const strategies = ['raster', 'crosshatch', 'concentric', 'spiral', 'contour', 'hybrid'] as const;
    for (const s of strategies) {
      const passes = finishingPasses(s, input());
      expect(passes.length, s).toBeGreaterThan(0);
      for (const pass of passes) for (const p of pass) expect(inRect(p), s).toBe(true);
    }
  });

  it('crosshatch runs both directions', () => {
    const passes = finishingPasses('crosshatch', input());
    const horizontal = passes.filter((p) => Math.abs(p[p.length - 1].y - p[0].y) < 1e-6);
    const vertical = passes.filter((p) => Math.abs(p[p.length - 1].x - p[0].x) < 1e-6);
    expect(horizontal.length).toBeGreaterThan(0);
    expect(vertical.length).toBeGreaterThan(0);
    // The two rasters are counted across different spans of a 40 x 30 board, so
    // this is their sum rather than twice either one.
    expect(passes.length).toBe(rasterPasses(input(), 0).length + rasterPasses(input(), 90).length);
  });

  it('falls back to a raster for an unknown strategy', () => {
    const passes = finishingPasses('nonsense' as never, input());
    expect(passes).toHaveLength(finishingPasses('raster', input()).length);
  });

  it('describes each strategy for the G-code header', () => {
    expect(describeFinishingStrategy('raster', 45)).toContain('45');
    expect(describeFinishingStrategy('crosshatch', 0)).toContain('90');
    expect(describeFinishingStrategy('contour', 0)).toContain('waterline');
    expect(describeFinishingStrategy('hybrid', 0)).toContain('steep');
  });
});

/** Bilinear read of a surface grid, matching the exporter's own sampler. */
function sample(s: SurfaceGrid, x: number, y: number): number {
  const fx = Math.min(s.cols - 1, Math.max(0, (x - s.minX) / s.stepX));
  const fy = Math.min(s.rows - 1, Math.max(0, (y - s.minY) / s.stepY));
  const c0 = Math.floor(fx);
  const r0 = Math.floor(fy);
  const c1 = Math.min(s.cols - 1, c0 + 1);
  const r1 = Math.min(s.rows - 1, r0 + 1);
  const tx = fx - c0;
  const ty = fy - r0;
  const z00 = s.z[r0 * s.cols + c0];
  const z10 = s.z[r0 * s.cols + c1];
  const z01 = s.z[r1 * s.cols + c0];
  const z11 = s.z[r1 * s.cols + c1];
  return (z00 * (1 - tx) + z10 * tx) * (1 - ty) + (z01 * (1 - tx) + z11 * tx) * ty;
}
