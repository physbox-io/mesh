import { describe, it, expect } from 'vitest';
import {
  deriveSolidOptions,
  generateSolidMachining,
  stockFor,
  DEFAULT_SOLID_OPTIONS,
} from '../src/utils/solidMachiningExporter';
import { autoFluteLength, deriveReliefFeeds } from '../src/utils/reliefTooling';
import {
  DEFAULT_RELIEF_OPTIONS,
  generateReliefCarveGcode,
} from '../src/utils/reliefCarveExporter';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

/** A 34 x 44 x 6 mm flat-topped plate (like the wooden snowflake holder). */
const smallHolder: SceneGraph = {
  nodes: [{
    id: 'holder',
    name: 'Wood holder',
    type: 'body',
    pos: [0, 0, 0],
    geoms: [{
      name: 'plate',
      type: 'box',
      size: [0.017, 0.022, 0.003],
      pos: [0, 0, 0.003],
    } as SceneGeom],
    joints: [],
    children: [],
  }],
};

describe('machining realism fixes', () => {
  it('assumes realistic ~7xD flute reach for small bits (1/16" clears 6.2 mm without shank lift)', () => {
    expect(autoFluteLength(1.5875)).toBeGreaterThanOrEqual(11);
    const opts = deriveSolidOptions(smallHolder, {
      board: { widthMm: 131, depthMm: 140, thicknessMm: 6 },
      sides: 1,
      material: 'hardwood',
      roughingToolDiaMm: 3.175,
      finishingToolDiaMm: 1.5875,
      finishingToolType: 'flat',
    });
    const res = generateSolidMachining(smallHolder, opts);
    expect(res.success, res.error).toBe(true);
    expect(res.warnings.join(' ')).not.toMatch(/Shank\/holder clearance lifted/);
  }, 60_000);

  it('does not ask to trim X/Y stock on a 1-sided job on a larger sheet, while still trimming 2-sided flips', () => {
    const oneSided = stockFor(34, 44, 6, {
      ...DEFAULT_SOLID_OPTIONS,
      sides: 1,
      roughingToolDiaMm: 3.175,
      board: { widthMm: 131, depthMm: 140, thicknessMm: 6 },
    });
    expect(oneSided.prep).toBeNull();
    // Still plans inside a compact cut window so multiple parts fit on one sheet.
    expect(oneSided.stockW).toBeLessThan(100);
    expect(oneSided.stockD).toBeLessThan(100);

    const twoSided = stockFor(34, 44, 6, {
      ...DEFAULT_SOLID_OPTIONS,
      sides: 2,
      roughingToolDiaMm: 3.175,
      board: { widthMm: 131, depthMm: 140, thicknessMm: 6 },
    });
    expect(twoSided.prep).toMatch(/Trim stock/);
  });

  it('skips fine raster finishing of the roughed scrap moat floor and uses 50% flat stepover', () => {
    const feeds = deriveReliefFeeds({
      material: 'hardwood',
      roughingToolDiaMm: 3.175,
      roughingFlutes: 2,
      finishingToolDiaMm: 1.5875,
      finishingFlutes: 2,
      finishingToolType: 'flat',
      carveDepthMm: 6,
    });
    expect(feeds.finishingStepoverPercent).toBe(50);

    const opts = deriveSolidOptions(smallHolder, {
      board: { widthMm: 131, depthMm: 140, thicknessMm: 6 },
      sides: 1,
      material: 'hardwood',
      roughingToolDiaMm: 3.175,
      finishingToolDiaMm: 1.5875,
      finishingToolType: 'flat',
    });
    const res = generateSolidMachining(smallHolder, opts);
    expect(res.success, res.error).toBe(true);
    // Previously a 34 x 44 x 6 mm plate took ~30+ minutes; skipping scrap floor finishing cuts it dramatically.
    expect(res.estimatedTimeSeconds).toBeLessThan(900);
  }, 60_000);

  it('cuts a full-thickness part out of a larger board with holding tabs in relief carve when cutThroughMm > 0', () => {
    const res = generateReliefCarveGcode(smallHolder, {
      ...DEFAULT_RELIEF_OPTIONS,
      stockWidthMm: 131,
      stockDepthMm: 140,
      stockThicknessMm: 6,
      verticalScaleMode: 'model',
      fitMode: 'manual',
      backgroundMode: 'auto',
      cutThroughMm: 0.3,
      holdingTabs: true,
      roughingToolDiaMm: 3.175,
      finishingToolDiaMm: 1.5875,
      finishingToolType: 'flat',
      material: 'hardwood',
    });
    expect(res.success, res.error).toBe(true);
    const warned = res.warnings.join(' ');
    expect(warned).toMatch(/Cuts through 6 mm stock and 0\.3 mm into the spoilboard/);
    expect(warned).toMatch(/Placed \d+ holding tab/);
    expect(warned).not.toMatch(/board round it is left uncut/);
  }, 60_000);

  it('uses matching 0.5xD hardwood stepdown for roughing and unroughed layered finishing', () => {
    const feeds = deriveReliefFeeds({
      material: 'hardwood',
      roughingToolDiaMm: 1.5875,
      roughingFlutes: 2,
      finishingToolDiaMm: 1.5875,
      finishingFlutes: 2,
      finishingToolType: 'flat',
      carveDepthMm: 6,
    });
    expect(feeds.roughingStepdownMm).toBeCloseTo(0.79, 2);

    const finishOnly = generateSolidMachining(
      smallHolder,
      deriveSolidOptions(smallHolder, {
        board: { widthMm: 131, depthMm: 140, thicknessMm: 6 },
        sides: 1,
        material: 'hardwood',
        roughingToolDiaMm: 1.5875,
        finishingToolDiaMm: 1.5875,
        finishingToolType: 'flat',
        roughingEnabled: false,
        finishingEnabled: true,
      })
    );
    expect(finishOnly.success, finishOnly.error).toBe(true);
    // Uses ~0.79 mm layered stepdown (not aggressive 1.59 mm = 1xD).
    expect(finishOnly.warnings.join(' ')).toMatch(/at most 0\.79 mm each/);
  }, 60_000);
});
