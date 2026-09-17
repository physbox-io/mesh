import { describe, it, expect } from 'vitest';
import { generateLaserCutGcode, DEFAULT_GCODE_OPTIONS } from '../src/utils/gcodeExporter';
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
