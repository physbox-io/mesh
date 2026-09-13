// Cutting a real part out of a block: the lattice wall bracket, which is the
// preset that exists to be made.
import { describe, it, expect } from 'vitest';
import { latticeBracketPreset } from '../src/presets/latticeBracket';
import { generateSolidMachining, DEFAULT_SOLID_OPTIONS } from '../src/utils/solidMachiningExporter';

/** Fast enough tooling for a test: a big finisher means a coarse grid. */
const quick = {
  finishingToolDiaMm: 6,
  finishingStepoverPercent: 40,
  roughingToolDiaMm: 6.35,
  material: 'aluminium' as const,
};

describe('solid machining of the wall bracket', () => {
  const twoSided = generateSolidMachining(latticeBracketPreset, { ...quick, sides: 2 });

  it('produces a program for each side', () => {
    expect(twoSided.success, twoSided.error).toBe(true);
    expect(twoSided.sides.map((s) => s.side)).toEqual(['A', 'B']);
    expect(twoSided.sides[0].gcode).toContain('SIDE A of 2');
    expect(twoSided.sides[1].gcode).toContain('SIDE B of 2');
    for (const side of twoSided.sides) {
      expect(side.gcode).toContain('; --- OP 2: finishing pass');
      expect(side.finishingRasterLines).toBeGreaterThan(0);
      expect(side.estimatedTimeSeconds).toBeGreaterThan(0);
    }
  });

  it('is the part the preset claims, at true scale', () => {
    expect(twoSided.partSizeMm.x).toBeCloseTo(50, 3);
    expect(twoSided.partSizeMm.y).toBeCloseTo(40, 3);
    expect(twoSided.partSizeMm.z).toBeCloseTo(60, 3);
  });

  it('sizes the stock from the part, a channel and a frame', () => {
    const moat = Math.max(3, quick.roughingToolDiaMm * 1.5);
    const frame = DEFAULT_SOLID_OPTIONS.frameWidthMm;
    expect(twoSided.stock.widthMm).toBeCloseTo(50 + 2 * (moat + frame), 3);
    expect(twoSided.stock.depthMm).toBeCloseTo(40 + 2 * (moat + frame), 3);
    expect(twoSided.stock.thicknessMm).toBeCloseTo(60 + 2 * DEFAULT_SOLID_OPTIONS.topSkinMm, 3);
  });

  it('each side cuts just past the middle of the block and no further', () => {
    const half = twoSided.stock.thicknessMm / 2;
    for (const side of twoSided.sides) {
      expect(side.depthMm).toBeGreaterThan(half);
      expect(side.depthMm).toBeLessThan(half + 1);
      let deepest = 0;
      for (const m of side.gcode.matchAll(/Z(-?\d+(?:\.\d+)?)/g)) {
        const z = parseFloat(m[1]);
        if (z < deepest) deepest = z;
      }
      // The pin bores on side A go through the stock into the spoilboard;
      // everything else stops at the floor.
      const allowed = side.side === 'A'
        ? twoSided.stock.thicknessMm + DEFAULT_SOLID_OPTIONS.pinDepthMm
        : side.depthMm;
      expect(-deepest).toBeLessThanOrEqual(allowed + 1e-6);
    }
  });

  it('holds the part with tabs and registers the flip on pins', () => {
    expect(twoSided.tabsPlaced).toBe(DEFAULT_SOLID_OPTIONS.tabCount);
    expect(twoSided.pins).toHaveLength(2);
    // Pins mirror onto each other when the block is flipped left to right.
    const [p, q] = twoSided.pins;
    expect(p.x + q.x).toBeCloseTo(twoSided.stock.widthMm, 6);
    expect(p.y).toBeCloseTo(q.y, 6);
    expect(twoSided.sides[0].gcode).toContain('OP 0: registration pins');
    expect(twoSided.sides[1].gcode).not.toContain('OP 0: registration pins');
  });

  it('can see all of an L bracket from two sides', () => {
    expect(twoSided.unreachablePercent).toBeLessThan(2);
    expect(twoSided.partVolumeMm3).toBeGreaterThan(0);
  });

  it('cuts a flat-backed part from one side alone, lying on its back', () => {
    // The wall plate's back is the flat face: point +X at the spindle.
    const oneSided = generateSolidMachining(latticeBracketPreset, { ...quick, sides: 1, up: '+x' });
    expect(oneSided.success, oneSided.error).toBe(true);
    expect(oneSided.sides).toHaveLength(1);
    expect(oneSided.partSizeMm.z).toBeCloseTo(50, 3);
    expect(oneSided.unreachablePercent).toBeLessThan(2);
    expect(oneSided.pins).toHaveLength(0);
    // Through the stock and a touch into the spoilboard.
    expect(oneSided.sides[0].depthMm).toBeCloseTo(
      oneSided.stock.thicknessMm + DEFAULT_SOLID_OPTIONS.throughCutMm, 6
    );
  });

  it('knows when one side is not enough', () => {
    // Upside down, the arm is at the top and shades everything below it:
    // from above, the column under the arm is solid from the arm down to the
    // bed, and the space under the shelf never gets cut.
    const oneSided = generateSolidMachining(latticeBracketPreset, { ...quick, sides: 1, up: '-z' });
    expect(oneSided.success, oneSided.error).toBe(true);
    expect(oneSided.unreachablePercent).toBeGreaterThan(50);
    expect(oneSided.warnings.join('\n')).toMatch(/cannot see past/);
  });

  it('refuses stock thinner than the part', () => {
    const thin = generateSolidMachining(latticeBracketPreset, { ...quick, stockThicknessMm: 20 });
    expect(thin.success).toBe(false);
    expect(thin.error).toMatch(/thicker stock/);
  });

  it('warns when nothing holds the part', () => {
    const loose = generateSolidMachining(latticeBracketPreset, { ...quick, tabCount: 0 });
    expect(loose.success, loose.error).toBe(true);
    expect(loose.tabsPlaced).toBe(0);
    expect(loose.warnings.join('\n')).toMatch(/come loose/);
  });
});
