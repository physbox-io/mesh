import { describe, it, expect } from 'vitest';
import { withSpindleOverride } from '../src/utils/spindleOverride';
import { DEFAULT_MOTION_PROFILE } from '../src/utils/motionProfile';
import { deriveReliefFeeds, DEFAULT_RELIEF_OPTIONS } from '../src/utils/reliefCarveExporter';

describe('spindle top-speed override', () => {
  const reported = { ...DEFAULT_MOTION_PROFILE, spindle: { min: 0, max: 10000 } };

  it('replaces the controller $30 when set', () => {
    expect(withSpindleOverride(reported, 30000).spindle).toEqual({ min: 0, max: 30000 });
  });

  it('leaves the reported range alone when there is no override', () => {
    expect(withSpindleOverride(reported, null)).toBe(reported);
  });

  it('applies with no controller connected, where nothing was reported', () => {
    expect(withSpindleOverride(DEFAULT_MOTION_PROFILE, 30000).spindle).toEqual({ min: 0, max: 30000 });
  });

  it('keeps the minimum at or below the new top speed', () => {
    const odd = { ...DEFAULT_MOTION_PROFILE, spindle: { min: 12000, max: 24000 } };
    expect(withSpindleOverride(odd, 10000).spindle).toEqual({ min: 10000, max: 10000 });
  });

  it('lets a small finishing bit run faster than a low $30 allowed', () => {
    // The case that started this: a 1/16" ball nose planned at 10,000 RPM on a
    // router that dials to 30,000.
    const opts = {
      ...DEFAULT_RELIEF_OPTIONS, material: 'softwood' as const,
      finishingToolDiaMm: 1.5875, roughingToolDiaMm: 3.175, carveDepthMm: 12.6,
    };
    const capped = deriveReliefFeeds(opts, reported.spindle);
    const freed = deriveReliefFeeds(opts, withSpindleOverride(reported, 30000).spindle);
    expect(capped.spindleRpm).toBe(10000);
    expect(freed.spindleRpm).toBeGreaterThan(capped.spindleRpm);
    expect(freed.finishingFeedrate).toBeGreaterThan(capped.finishingFeedrate);
  });
});
