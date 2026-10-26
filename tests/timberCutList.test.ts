import { describe, it, expect } from 'vitest';
import { generateWindowGcode, mortisingFeeds } from '../src/utils/timberCutList';
import { recommendSpeeds } from '../src/utils/feedsAndSpeeds';

/*
 * The timber cut plan used to cut every mortise at S12000 F900, plunge 250,
 * 2.5 mm a pass, whatever was in the collet and whatever the controller could
 * do — and ramped into the first mortise straight off the M3, before the
 * spindle was up to speed.
 */

describe('mortising feeds', () => {
  it('keeps the old figures for a caller that says nothing about the machine', () => {
    expect(mortisingFeeds(6, {})).toEqual({ spindleRpm: 12000, feedRate: 900, plungeRate: 250, stepdownMm: 2.5 });
  });

  it('derives them from the cutter, the timber and the machine when told', () => {
    const spindle = { min: 5000, max: 10000 };
    const f = mortisingFeeds(3, { material: 'hardwood', spindle, maxFeedMmMin: 2000 });
    const rec = recommendSpeeds({ diameterMm: 3, flutes: 2, material: 'hardwood', spindle, maxFeedMmMin: 2000 });
    expect(f.spindleRpm).toBe(rec.rpm);
    expect(f.spindleRpm).toBeLessThanOrEqual(10000);
    expect(f.feedRate).toBe(rec.feedMmMin);
    expect(f.plungeRate).toBe(rec.plungeMmMin);
    // A 3 mm bit slotting oak takes a fraction of its diameter, not 2.5 mm.
    expect(f.stepdownMm).toBeCloseTo(0.9, 6);
  });

  it('lets an explicit figure stand over a derived one', () => {
    expect(mortisingFeeds(6, { material: 'softwood', stepdownMm: 1 }).stepdownMm).toBe(1);
  });
});

describe('a window setup program', () => {
  it('waits for the spindle before the first move into the wood', () => {
    const { gcode } = generateWindowGcode({
      setupId: 's1', partId: 'Leg', faceUpLabel: 'A', fenceFaceLabel: 'B', indexOffsetFromTopMm: 0,
      cutterDiaMm: 6, spindleRpm: 10000, feedRate: 800, plungeRate: 250, stepdownMm: 2,
      mortises: [{ id: 'm1', centerXMm: 20, centerYMm: 40, widthYMm: 30, thicknessXMm: 12, depthMm: 4, dogbone: false }],
      zClips: [],
    });
    const lines = gcode.split('\n');
    const m3 = lines.findIndex((l) => /^M3\b/.test(l));
    expect(m3).toBeGreaterThanOrEqual(0);
    expect(lines[m3 + 1]).toBe('G4 P2');
    expect(lines.findIndex((l) => /^G1\b/.test(l))).toBeGreaterThan(m3 + 1);
  });
});
