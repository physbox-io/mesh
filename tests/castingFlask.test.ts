import { describe, it, expect } from 'vitest';
import { exportLaserCutSvg, DEFAULT_LASER_OPTIONS, type LaserCutOptions, type StockItem } from '../src/utils/laserCutExporter';
import { castingFlaskPreset, PRESETS } from '../src/presets/presetScenes';

/**
 * The flask is the shape nobody can cut whole: a 300 x 300 ring of 60 mm
 * timber. A slab that size is not something people have; 60 mm bar is.
 */

const opts = (o: Partial<LaserCutOptions> = {}): LaserCutOptions => ({
  ...DEFAULT_LASER_OPTIONS,
  materialThickness: 0.06,
  ...o,
});

/** Long enough for a side, only as wide as the frame's own border. */
const bar: StockItem[] = [{ widthMm: 320, heightMm: 40, thicknessMm: 60, quantity: 16 }];

describe('the casting flask preset', () => {
  it('is in the preset list', () => {
    expect(PRESETS.casting_flask.scene).toBe(castingFlaskPreset);
  });

  it('extracts as two rings, not as two hollow boxes', () => {
    // The void passes clean through, so each half is one closed outline with
    // one hole. A subtraction that stopped inside would leave a tray, and the
    // half would come out as six shelled faces instead.
    const result = exportLaserCutSvg(castingFlaskPreset, opts({ stock: [{ widthMm: 400, heightMm: 400, thicknessMm: 60, quantity: null }] }));
    expect(result.success).toBe(true);
    expect(result.panels).toHaveLength(2);
    for (const p of result.panels!) {
      expect(p.innerCutouts2D).toHaveLength(1);
      expect(p.width2D).toBeCloseTo(300, 0);
      expect(p.height2D).toBeCloseTo(300, 0);
    }
  });

  it('will not fit on bar, and says so, until splitting is asked for', () => {
    const result = exportLaserCutSvg(castingFlaskPreset, opts({ stock: bar }));
    expect(result.success).toBe(true);
    expect(result.warnings!.some((w) => w.includes('Too big for'))).toBe(true);
  });

  it('comes off 60 mm bar as eight mitred lengths once it is', () => {
    const result = exportLaserCutSvg(castingFlaskPreset, opts({ stock: bar, splitOversized: true }));

    expect(result.success).toBe(true);
    // Two halves, four lengths each.
    expect(result.panels).toHaveLength(8);
    for (const p of result.panels!) {
      expect(Math.max(p.width2D!, p.height2D!)).toBeCloseTo(300, 0);
      expect(Math.min(p.width2D!, p.height2D!)).toBeCloseTo(20, 0);
      expect(p.outerPolygon2D).toHaveLength(4);
    }
    expect(result.warnings!.some((w) => w.includes('Too big for'))).toBeFalsy();
    // Cope and drag both split, and both are named so they can be told apart.
    const names = result.panels!.map((p) => p.name).join(' ');
    expect(names).toContain('cope_1');
    expect(names).toContain('drag_1');
  });

  it('cuts every length from 60 mm stock', () => {
    const result = exportLaserCutSvg(castingFlaskPreset, opts({ stock: bar, splitOversized: true }));
    for (const sheet of result.sheets!) expect(sheet.thicknessMm).toBe(60);
  });

  it('refuses to cut the flask from stock thinner than it was drawn', () => {
    // A flask in 18 mm is not a thinner flask, it is a different depth of
    // mould — and the joints would fit each other perfectly while it happened.
    const result = exportLaserCutSvg(castingFlaskPreset, opts({
      stock: [{ widthMm: 320, heightMm: 40, thicknessMm: 18, quantity: 16 }],
      splitOversized: true,
    }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('nothing thick enough');
  });
});

describe('the flask from short offcuts', () => {
  /** Not-so-long wood: 170 mm pieces, only as wide as the frame's border. */
  const shortOffcuts: StockItem[] = [{ widthMm: 170, heightMm: 40, thicknessMm: 60, quantity: 32 }];

  it('splices each side, so 170 mm offcuts make a 300 mm frame', () => {
    const result = exportLaserCutSvg(castingFlaskPreset, opts({
      stock: shortOffcuts, splitOversized: true,
    }));

    expect(result.success).toBe(true);
    // Two halves, four sides each, every side spliced from two pieces.
    expect(result.panels).toHaveLength(16);
    for (const p of result.panels!) {
      const long = Math.max(p.width2D!, p.height2D!);
      expect(long).toBeLessThanOrEqual(170 - 2 * 8 + 0.01);
    }
    expect(result.warnings!.some((w) => w.includes('spliced'))).toBe(true);
    expect(result.warnings!.some((w) => w.includes('Too big for'))).toBeFalsy();
  });

  it('gives the spliced pieces interlocking ends, not butt joints', () => {
    const result = exportLaserCutSvg(castingFlaskPreset, opts({
      stock: shortOffcuts, splitOversized: true,
    }));
    // A mitred length is 4 corners; one with a finger seam on an end has many
    // more. Every piece here has at least one spliced end.
    for (const p of result.panels!) {
      expect(p.outerPolygon2D.length).toBeGreaterThan(4);
    }
  });

  it('names the pieces so a side can be reassembled from the bench', () => {
    const result = exportLaserCutSvg(castingFlaskPreset, opts({
      stock: shortOffcuts, splitOversized: true,
    }));
    const names = result.panels!.map((p) => p.name);
    // cope side 1 is cope_1a + cope_1b.
    expect(names).toContain('cope_1a');
    expect(names).toContain('cope_1b');
    expect(names).toContain('drag_4a');
  });

  it('does not splice a length the rack can hold whole', () => {
    const result = exportLaserCutSvg(castingFlaskPreset, opts({
      stock: [{ widthMm: 320, heightMm: 40, thicknessMm: 60, quantity: 16 }],
      splitOversized: true,
    }));
    expect(result.panels).toHaveLength(8);
    expect(result.warnings!.some((w) => w.includes('spliced'))).toBeFalsy();
  });
});
