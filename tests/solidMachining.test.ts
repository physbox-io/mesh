// Cutting a real part out of a block: the lattice wall bracket, which is the
// preset that exists to be made.
import { describe, it, expect } from 'vitest';
import { latticeBracketPreset } from '../src/presets/latticeBracket';
import { generateSolidMachining, deriveSolidOptions, DEFAULT_SOLID_OPTIONS, fittingScalePercent, measurePart } from '../src/utils/solidMachiningExporter';
import { oakTreePreset } from '../src/presets/oakTree';

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

  /*
   * The channel round the part is split at the middle; the part's own faces
   * are cut from whichever side they face, however deep. Side A once stopped
   * at the middle everywhere, and the top of the bracket's lower arm, 56 mm
   * down, was left under 24 mm of stock that neither side cut.
   */
  it('each side cuts its own faces, and the channel just past the middle', () => {
    const half = twoSided.stock.thicknessMm / 2;
    expect(twoSided.sides[0].depthMm).toBeCloseTo(56, 0);
    expect(twoSided.sides[1].depthMm).toBeLessThan(half + 1);
    for (const side of twoSided.sides) {
      expect(side.depthMm).toBeGreaterThan(half);
      expect(side.depthMm).toBeLessThanOrEqual(twoSided.stock.thicknessMm);
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
    expect(oneSided.warnings.join('\n')).toMatch(/beneath overhangs/);
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
    expect(loose.warnings.join('\n')).toMatch(/no holding tabs/);
  });
});

describe('options worked out for the material', () => {
  // The MCP export used to hand the defaults straight to the exporter, so the
  // material only changed the label: an aluminium job got hardwood's feeds,
  // spindle speed and stepdown.
  const asked = { sides: 2 as const, roughingToolDiaMm: 3, finishingToolDiaMm: 3 };
  const alu = deriveSolidOptions(latticeBracketPreset, { ...asked, material: 'aluminium' });
  const oak = deriveSolidOptions(latticeBracketPreset, { ...asked, material: 'hardwood' });

  it('cuts aluminium shallower and slower than hardwood', () => {
    expect(alu.roughingStepdownMm).toBeLessThan(oak.roughingStepdownMm);
    expect(alu.roughingFeedrate).toBeLessThan(oak.roughingFeedrate);
    expect(alu.roughingStepdownMm).toBeLessThanOrEqual(0.1 * 3 + 1e-9);
  });

  it('keeps what was asked for', () => {
    expect(alu.sides).toBe(2);
    expect(alu.material).toBe('aluminium');
    expect(alu.roughingToolDiaMm).toBe(3);
  });

  it('writes the derived numbers into the program', () => {
    const a = generateSolidMachining(latticeBracketPreset, alu);
    const o = generateSolidMachining(latticeBracketPreset, oak);
    expect(a.success && o.success).toBe(true);
    const roughFeed = (g: string) => g.slice(g.indexOf('OP 1: roughing')).match(/ F(\d+)/)?.[1];
    expect(roughFeed(a.sides[0].gcode)).not.toBe(roughFeed(o.sides[0].gcode));
  });
});

describe('a model far bigger than a part', () => {
  // The oak tree at 100% is metres across. Planned as it was, it overflowed the
  // page's stack after minutes; it is turned away at once, with a scale that fits.
  it('says so, quickly, with a scale that makes a part of it', () => {
    const t0 = performance.now();
    const r = generateSolidMachining(oakTreePreset, quick);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(r.success).toBe(false);
    const fit = Number(r.error?.match(/Scale it down: ([\d.]+)%/)?.[1]);
    const natural = measurePart(oakTreePreset, '+z', 100)!;
    expect(fit).toBe(fittingScalePercent(Math.max(natural.x, natural.y, natural.z)));
    const at = measurePart(oakTreePreset, '+z', fit)!;
    const largest = Math.max(at.x, at.y, at.z);
    expect(largest).toBeGreaterThan(180);
    expect(largest).toBeLessThanOrEqual(200);
  });

  it('leaves a part that fits at 100%', () => {
    expect(fittingScalePercent(999)).toBe(100);
    expect(fittingScalePercent(4000)).toBe(5);
    expect(fittingScalePercent(3820)).toBe(5.2);
  });
});

describe('bed levelling on a two-sided job', () => {
  it('levels side A only, and says side B is cut without levelling rather than to probe again', () => {
    const grid = { minX: 0, minY: 0, maxX: 200, maxY: 200, gridX: 2, gridY: 2,
      points: [[{ x: 0, y: 0, z: 0 }, { x: 200, y: 0, z: 1.5 }], [{ x: 0, y: 200, z: 0 }, { x: 200, y: 200, z: 1.5 }]] };
    const opts = { ...quick, applyMeshLeveling: true, meshLevelGrid: grid as never };
    const two = generateSolidMachining(latticeBracketPreset, { ...opts, sides: 2 });
    const unlevelled = generateSolidMachining(latticeBracketPreset, { ...quick, sides: 2 });
    // Side B is baked unlevelled, and nothing levels a program after it is
    // made, so advice to probe again before side B could not be acted on.
    expect(two.warnings.some((w) => /Probe again/.test(w))).toBe(false);
    expect(two.warnings.some((w) => /side B is cut without levelling/.test(w))).toBe(true);
    expect(two.sides[0].gcode).not.toBe(unlevelled.sides[0].gcode);
    expect(two.sides[1].gcode).toBe(unlevelled.sides[1].gcode);
    const one = generateSolidMachining(latticeBracketPreset, { ...opts, sides: 1 });
    expect(one.warnings.some((w) => /side B is cut without levelling/.test(w))).toBe(false);
  });

  it('samples a symmetric part identically across the X flip and keeps outer boundary at floorZ when Side B can reach', () => {
    const symPart = {
      nodes: [{
        id: 'sym', name: 'sym', type: 'body' as const, pos: [0, 0, 0] as [number, number, number],
        geoms: [{ name: 'g0', type: 'box' as const, size: [0.015, 0.015, 0.01], pos: [0, 0, 0.01] }],
        joints: [], children: [],
      }],
    };
    const res = generateSolidMachining(symPart, { ...quick, sides: 2 });
    expect(res.success).toBe(true);
    // Symmetric box centered in Z has identical cut depth on Side A and Side B,
    // clamped at floorZ (half the stock + overcut) along the outer perimeter.
    const floorDepth = res.stock.thicknessMm / 2 + 0.5;
    expect(res.sides[0].depthMm).toBeCloseTo(floorDepth, 2);
    expect(res.sides[1].depthMm).toBeCloseTo(floorDepth, 2);
    expect(res.sides[0].finishingRasterLines).toBe(res.sides[1].finishingRasterLines);
  });
});

