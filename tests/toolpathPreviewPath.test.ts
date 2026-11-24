import { describe, it, expect } from 'vitest';
import { buildPreviewPath, type ToolpathPreviewOptions } from '../src/utils/toolpathPreviewPath';
import { DEPTH_RAMP, fillToolpathColours } from '../src/utils/toolpathBuffers';
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
    // The plunge into a roughing pass, timed at the finishing plunge rate when
    // roughingPlungeRate is omitted, is still roughing.
    const plunge = cuts[3];
    expect(plunge.feed).toBe(300);
    expect(plunge.pass).toBe('roughing');
  });

  it('rescales roughing and finishing passes separately and omits zero-length hops', () => {
    const { moves, seconds } = buildPreviewPath({
      segments: [
        { type: 'roughing', points: [{ x: 0, y: 0, z: -2 }, { x: 20, y: 0, z: -2 }] },
        // Linked pass starting at the previous endpoint at the same Z: no phantom retract.
        { type: 'roughing', points: [{ x: 20, y: 0, z: -2 }, { x: 20, y: 5, z: -2 }], traverseZ: -2 },
        { type: 'finishing', points: [{ x: 20, y: 5, z: -3 }, { x: 0, y: 5, z: -3 }], traverseZ: 5 },
      ],
      estimatedTimeSeconds: 100,
      roughingTimeSeconds: 40,
      carveBounds: { minX: 0, minY: 0, maxX: 20, maxY: 5 },
    }, { ...options, roughingPlungeRate: 250 });

    const roughMoves = moves.filter((m) => m.pass === 'roughing');
    expect(roughMoves.some((m) => m.rapid)).toBe(false);
    expect(roughMoves[roughMoves.length - 1].t1).toBeCloseTo(40, 5);
    expect(seconds).toBeCloseTo(100, 5);
  });

  it('clamps positive-Z plunge starts to the surface end of the depth ramp', () => {
    const { moves } = buildPreviewPath({
      segments: [
        { type: 'finishing', points: [{ x: 0, y: 0, z: -5 }, { x: 10, y: 0, z: -5 }] },
        { type: 'finishing', points: [{ x: 10, y: 5, z: -5 }, { x: 0, y: 5, z: -5 }], traverseZ: 5 },
      ],
      estimatedTimeSeconds: 10,
      carveBounds: { minX: 0, minY: 0, maxX: 10, maxY: 5 },
    }, options);

    const plungeIdx = moves.findIndex((m) => !m.rapid && m.z1 > 0 && m.z2 < 0);
    expect(plungeIdx).toBeGreaterThan(-1);
    const colours = fillToolpathColours(moves, 'depth', -5);
    const surface = DEPTH_RAMP[DEPTH_RAMP.length - 1];
    const floor = DEPTH_RAMP[0];
    // Endpoint 1 (Z = +5) must be surface colour, not reflected to floor colour.
    expect(colours[plungeIdx * 6]).toBeCloseTo(surface[0], 3);
    expect(colours[plungeIdx * 6 + 1]).toBeCloseTo(surface[1], 3);
    expect(colours[plungeIdx * 6 + 2]).toBeCloseTo(surface[2], 3);
    // Endpoint 2 (Z = -5) must be floor colour.
    expect(colours[plungeIdx * 6 + 3]).toBeCloseTo(floor[0], 3);
    expect(colours[plungeIdx * 6 + 4]).toBeCloseTo(floor[1], 3);
    expect(colours[plungeIdx * 6 + 5]).toBeCloseTo(floor[2], 3);
  });
});
