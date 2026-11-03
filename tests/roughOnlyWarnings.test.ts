import { describe, it, expect } from 'vitest';
import { generateReliefCarveGcode, DEFAULT_RELIEF_OPTIONS } from '../src/utils/reliefCarveExporter';
import type { SceneGraph } from '../src/types/scene';

/*
 * With the finishing pass off, the finishing bit never goes in the collet, so
 * nothing about it is the operator's problem. Its stepover's cusps, its shank
 * clearance and the spindle speed it wants were all still reported, and the
 * surface was dilated for it - 8 s of a 1 mm cutter's dilation for a job that
 * never cut with it. The spindle speed is checked against the roughing
 * cutter instead, which is the one turning.
 */

const dome: SceneGraph = {
  nodes: [{
    id: 'd', name: 'dome', type: 'body', pos: [0, 0, 0],
    geoms: [{ name: 'g', type: 'sphere', size: [0.03] } as never],
    joints: [], children: [],
  }],
};

const roughOnly = {
  ...DEFAULT_RELIEF_OPTIONS,
  stockWidthMm: 80, stockDepthMm: 80, fitMode: 'manual' as const, scalePercent: 100,
  backgroundMode: 'skip' as const, carveDepthMm: 6,
  material: 'hardwood' as const,
  roughingToolDiaMm: 6.35,
  finishingEnabled: false,
};

describe('a rough-only job says nothing about the finishing bit', () => {
  it('no cusp warning for a stepover that is never cut', () => {
    const r = generateReliefCarveGcode(dome, {
      ...roughOnly, finishingToolType: 'ball_nose', finishingToolDiaMm: 3.175, finishingStepoverPercent: 90,
    });
    expect(r.success, r.error).toBe(true);
    expect(r.warnings.filter((w) => /cusps/.test(w))).toEqual([]);
  });

  it('no shank-clearance warning for a toolpath that is never cut', () => {
    const r = generateReliefCarveGcode(dome, {
      ...roughOnly, toolBodyClearance: true,
      finishingToolDiaMm: 1.5, finishingShankDiaMm: 6.35, finishingFluteLengthMm: 2,
    });
    expect(r.success, r.error).toBe(true);
    expect(r.warnings.filter((w) => /clearance lifted/.test(w))).toEqual([]);
  });

  it('checks the spindle speed against the roughing cutter', () => {
    // About right for the 6.35 mm end mill, far too slow for a 1 mm bit.
    const r = generateReliefCarveGcode(dome, { ...roughOnly, finishingToolDiaMm: 1, spindleRpm: 10000 });
    expect(r.success, r.error).toBe(true);
    expect(r.warnings.filter((w) => /RPM/.test(w))).toEqual([]);

    // And still warns when it is wrong for the roughing cutter.
    const slow = generateReliefCarveGcode(dome, { ...roughOnly, finishingToolDiaMm: 1, spindleRpm: 3000 });
    expect(slow.warnings.some((w) => /RPM is below .* for a 6\.35 mm cutter/.test(w))).toBe(true);
  });
});
