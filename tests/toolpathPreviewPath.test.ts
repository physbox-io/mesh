import { describe, it, expect } from 'vitest';
import { buildPreviewPath, type ToolpathPreviewOptions } from '../src/utils/toolpathPreviewPath';
import { DEFAULT_MOTION_PROFILE } from '../src/utils/motionProfile';

const options: ToolpathPreviewOptions = {
  stockWidthMm: 50,
  stockDepthMm: 50,
  stockThicknessMm: 10,
  finishingToolDiaMm: 3,
  // Equal feeds: the case that used to colour every move as roughing.
  roughingFeedrate: 1000,
  finishingFeedrate: 1000,
  finishingPlungeRate: 300,
  safeZ: 5,
  motionProfile: DEFAULT_MOTION_PROFILE,
};

describe('the toolpath preview path', () => {
  it('tags each move with the pass it belongs to, whatever the feeds', () => {
    const { moves } = buildPreviewPath({
      segments: [
        { type: 'roughing', points: [{ x: 0, y: 0, z: -1 }, { x: 10, y: 0, z: -1 }] },
        { type: 'finishing', points: [{ x: 10, y: 5, z: -2 }, { x: 0, y: 5, z: -2 }] },
        { type: 'roughing', points: [{ x: 0, y: 10, z: -1 }, { x: 10, y: 10, z: -1 }] },
      ],
      estimatedTimeSeconds: 0,
      carveBounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    }, options);

    const cuts = moves.filter((m) => !m.rapid);
    // Cut, then plunge + cut into the finishing pass, then plunge + cut back into roughing.
    expect(cuts.map((m) => m.pass)).toEqual(['roughing', 'finishing', 'finishing', 'roughing', 'roughing']);
    // The plunge into a roughing pass, timed at the finishing plunge rate, is still roughing.
    const plunge = cuts[3];
    expect(plunge.feed).toBe(300);
    expect(plunge.pass).toBe('roughing');
  });
});
