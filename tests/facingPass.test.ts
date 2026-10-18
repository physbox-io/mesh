import { describe, it, expect } from 'vitest';
import { generateLaserCutGcode, generateFramingGcode, DEFAULT_GCODE_OPTIONS } from '../src/utils/gcodeExporter';
import type { LaserPanel } from '../src/utils/laserCutExporter';

/**
 * Facing stock down to the thickness a part was drawn at.
 *
 * The answer to having 10 mm in the rack and an 8 mm part in the model — and
 * only ever that direction. Stock thinner than drawn cannot be machined back up
 * and is refused by the panel exporter instead.
 */

const panel = (): LaserPanel =>
  ({
    id: 'p1', name: 'panel_1',
    thickness: 0.008, // 8 mm drawn
    origin3D: { x: 0, y: 0, z: 0 },
    normal3D: { x: 0, y: 0, z: 1 },
    uAxis3D: { x: 1, y: 0, z: 0 },
    vAxis3D: { x: 0, y: 1, z: 0 },
    outerPolygon2D: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }],
    innerCutouts2D: [],
    edges3D: [],
    width2D: 100,
    height2D: 60,
    placedPos2D: { x: 20, y: 30 },
    sheetIndex: 0,
  }) as unknown as LaserPanel;

const run = (over: Partial<typeof DEFAULT_GCODE_OPTIONS> = {}) =>
  generateLaserCutGcode([panel()], {
    ...DEFAULT_GCODE_OPTIONS,
    machineMode: 'cnc',
    faceToThickness: true,
    sheetStockThicknessMm: [10],
    ...over,
  });

describe('facing', () => {
  it('does nothing unless it is asked for', () => {
    const r = generateLaserCutGcode([panel()], {
      ...DEFAULT_GCODE_OPTIONS, machineMode: 'cnc', sheetStockThicknessMm: [10],
    });
    expect(r.operations.some((o) => o.type === 'facing')).toBe(false);
  });

  it('does nothing on a laser, which has no Z to take material off with', () => {
    const r = run({ machineMode: 'laser' });
    expect(r.operations.some((o) => o.type === 'facing')).toBe(false);
  });

  it('does nothing when the stock is already the thickness that was drawn', () => {
    expect(run({ sheetStockThicknessMm: [8] }).operations.some((o) => o.type === 'facing')).toBe(false);
  });

  it('does nothing when the caller cannot say what the stock is', () => {
    expect(run({ sheetStockThicknessMm: undefined }).operations.some((o) => o.type === 'facing')).toBe(false);
  });

  it('takes exactly the difference off, in passes of the depth asked for', () => {
    const r = run({ facingDepthPerPassMm: 0.5 });
    expect(r.success).toBe(true);
    // 10 mm stock, 8 mm part: 2 mm off in 0.5 mm bites is four passes.
    expect(r.gcode).toContain('Facing pass 1 of 4');
    expect(r.gcode).toContain('Facing pass 4 of 4');
    // The last one finishes exactly on the drawn face, never past it.
    expect(r.gcode).toContain('Z-2.000');
    expect(r.gcode).not.toContain('Z-2.500');
  });

  it('never cuts deeper than the difference, even on an uneven last bite', () => {
    const r = run({ facingDepthPerPassMm: 0.75 });
    // 2 mm in 0.75 bites is three passes, the last a short one.
    expect(r.gcode).toContain('Facing pass 3 of 3');
    expect(r.gcode).toContain('Z-2.000');
    expect(r.gcode).not.toContain('Z-2.250');
  });

  it('starts a bit-radius outside the panel, so no lip is left at the edges', () => {
    const r = run({ facingBitDiameterMm: 20 });
    // Footprint is x 20..120, y 30..90; a 20 mm bit reaches from x 10 to x 130.
    expect(r.gcode).toContain('X10.000');
    expect(r.gcode).toContain('X130.000');
  });

  it('names the operation with both thicknesses, so the pause list reads plainly', () => {
    const op = run().operations.find((o) => o.type === 'facing');
    expect(op?.name).toContain('10.000mm down to 8.000mm');
  });

  it('faces before it cuts, so nothing is loose under a full-width bit', () => {
    const r = run();
    const facing = r.operations.findIndex((o) => o.type === 'facing');
    const cut = r.operations.findIndex((o) => o.type === 'cut');
    expect(facing).toBeGreaterThanOrEqual(0);
    expect(cut).toBeGreaterThan(facing);
  });

  it('works with a plain end mill, just with more passes', () => {
    // Slower is the operator's trade to make, not a reason to refuse the job.
    const big = run({ facingBitDiameterMm: 25 });
    const small = run({ facingBitDiameterMm: 6 });
    const count = (g: string) => (g.match(/G1 X/g) || []).length;
    expect(small.success).toBe(true);
    expect(count(small.gcode)).toBeGreaterThan(count(big.gcode));
  });
});

describe('facing, then the profile bit', () => {
  const lines = (g: string) => g.split('\n');

  it('stops for the profile bit after facing with a different one', () => {
    const g = lines(run({ facingBitDiameterMm: 25, bitDiameterMm: 3.175 }).gcode);
    const lastFacing = g.map((l) => /^; Facing pass/.test(l)).lastIndexOf(true);
    const firstPanel = g.findIndex((l) => /^; --- Panel/.test(l));
    const change = g.findIndex((l) => /\bM6\b/.test(l));
    expect(change).toBeGreaterThan(lastFacing);
    expect(change).toBeLessThan(firstPanel);
    expect(g[change]).toContain('3.175');
    // Lifted and stopped before it, and back up to travel height and spinning after.
    expect(g.slice(lastFacing, change).some((l) => /^M5\b/.test(l))).toBe(true);
    expect(g.slice(change, firstPanel).some((l) => /^G0 Z/.test(l))).toBe(true);
    expect(g.slice(change, firstPanel).some((l) => /^M3 S/.test(l))).toBe(true);
  });

  it('does not stop when told not to, or when the same bit does both', () => {
    expect(run({ pauseOnToolChange: false }).gcode).not.toMatch(/\bM6\b/);
    expect(run({ facingBitDiameterMm: 3.175, bitDiameterMm: 3.175 }).gcode).not.toMatch(/\bM6\b/);
  });

  it('starts the profile at the faced surface, not in the air above it', () => {
    // 10 mm stock faced 2 mm down: the profile's 3 mm steps start from -2.
    const g = lines(run({ cutDepthZ: 10, zStepdown: 3 }).gcode);
    const firstPanel = g.findIndex((l) => /^; --- Panel/.test(l));
    const plunges = g.slice(firstPanel).filter((l) => /^G1 Z/.test(l)).map((l) => parseFloat(/Z(-?[\d.]+)/.exec(l)![1]));
    expect(plunges[0]).toBeCloseTo(-5, 3);
    expect(Math.min(...plunges)).toBeCloseTo(-10, 3);
  });

  it('steps evenly across the footprint and reaches its far edge', () => {
    // Footprint y 30..90 plus a 12.5 mm radius each side: 17.5..102.5, 15 mm stepover.
    const g = lines(run({ facingBitDiameterMm: 25, facingStepoverFraction: 0.6, facingDepthPerPassMm: 5 }).gcode);
    const start = g.findIndex((l) => /^; Facing pass 1/.test(l));
    const end = g.findIndex((l, i) => i > start && /^G0 Z/.test(l) && i > start + 3);
    const ys = [...new Set(g.slice(start, end).map((l) => /Y(-?[\d.]+)/.exec(l)?.[1]).filter(Boolean).map(Number))];
    expect(ys[0]).toBeCloseTo(17.5, 3);
    expect(ys[ys.length - 1]).toBeCloseTo(102.5, 3);
    const gaps = ys.slice(1).map((y, i) => y - ys[i]);
    for (const gap of gaps) {
      expect(gap).toBeLessThanOrEqual(15 + 1e-6);
      expect(gap).toBeCloseTo(gaps[0], 2); // to the G-code's 0.001 mm rounding
    }
  });

  it('reports the facing bit\'s reach in the job bounds', () => {
    const r = run({ facingBitDiameterMm: 25 });
    // Panel at x 20..120, y 30..90; the facing bit's centre runs 12.5 outside, its edge 25.
    expect(r.bounds.minX).toBeLessThanOrEqual(20 - 25 + 1e-6);
    expect(r.bounds.maxY).toBeGreaterThanOrEqual(90 + 25 - 1e-6);
  });
});

describe('CNC framing', () => {
  it('lifts before it moves across the stock', () => {
    const g = generateFramingGcode({ minX: 10, minY: 10, maxX: 50, maxY: 50 }, { ...DEFAULT_GCODE_OPTIONS, machineMode: 'cnc' }).split('\n');
    const lift = g.findIndex((l) => /^G0 Z/.test(l));
    const firstXY = g.findIndex((l) => /^G[01] X/.test(l));
    expect(lift).toBeGreaterThanOrEqual(0);
    expect(lift).toBeLessThan(firstXY);
  });
});
