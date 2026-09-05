import { describe, it, expect } from 'vitest';
import {
  parseGrblSettings,
  motionProfileFromSettings,
  accelAlong,
  maxRateAlong,
  DEFAULT_MOTION_PROFILE,
  type MotionProfile,
} from '../src/utils/motionProfile';
import { estimateMoveSeconds, estimateGcodeTime, type TimedMove } from '../src/utils/timeEstimate';

/** A realistic `$$` dump, with the noise a live connection puts in it. */
const DUMP = `
ok
<Idle|MPos:0.000,0.000,0.000|FS:0,0>
$0=10
$11=0.010
$30=24000
$31=8000
$100=80.000
$110=8000.000
$111=8000.000
$112=1200.000
$120=750.000
$121=750.000
$122=100.000
$130=800.000
ok
`.split('\n');

describe('reading the controller settings', () => {
  it('picks the settings out of the surrounding traffic', () => {
    const settings = parseGrblSettings(DUMP);
    expect(settings.get(120)).toBe(750);
    expect(settings.get(112)).toBe(1200);
    expect(settings.get(30)).toBe(24000);
    // The status report and the `ok`s are not settings.
    expect(settings.size).toBe(12);
  });

  it('turns them into a profile and says it came from the machine', () => {
    const p = motionProfileFromSettings(parseGrblSettings(DUMP));
    expect(p.source).toBe('machine');
    expect(p.accel).toEqual({ x: 750, y: 750, z: 100 });
    expect(p.maxRate).toEqual({ x: 8000, y: 8000, z: 1200 });
    expect(p.spindle).toEqual({ min: 8000, max: 24000 });
  });

  it('falls back per field rather than throwing the lot away', () => {
    // A laser build with no Z configured and no spindle range.
    const p = motionProfileFromSettings(parseGrblSettings(['$110=6000', '$120=400']));
    expect(p.source).toBe('machine');
    expect(p.accel.x).toBe(400);
    // Y unstated follows X, which is what it is on every machine of this shape.
    expect(p.accel.y).toBe(400);
    // Z unstated falls back to the assumption rather than to zero.
    expect(p.accel.z).toBe(DEFAULT_MOTION_PROFILE.accel.z);
    expect(p.spindle).toBeNull();
  });

  it('treats a zero as unset, not as a machine that cannot move', () => {
    const p = motionProfileFromSettings(parseGrblSettings(['$110=6000', '$120=0']));
    expect(p.accel.x).toBe(DEFAULT_MOTION_PROFILE.accel.x);
    // The acceleration never actually arrived, so this is not a machine profile.
    expect(p.source).toBe('assumed');
  });

  it('stays assumed when the controller says nothing it understands', () => {
    expect(motionProfileFromSettings(parseGrblSettings(['ok', 'error:1'])).source).toBe('assumed');
  });
});

const ROUTER: MotionProfile = {
  accel: { x: 800, y: 800, z: 100 },
  maxRate: { x: 6000, y: 6000, z: 900 },
  spindle: { min: 8000, max: 24000 },
  source: 'machine',
};

describe('per-axis limits', () => {
  it('gives a pure X move all of X and a plunge all of Z', () => {
    expect(accelAlong(ROUTER, 1, 0, 0)).toBeCloseTo(800, 6);
    expect(accelAlong(ROUTER, 0, 0, -1)).toBeCloseTo(100, 6);
    expect(maxRateAlong(ROUTER, 0, 0, -1)).toBeCloseTo(900, 6);
  });

  it('lets a diagonal have more than either axis alone', () => {
    // Each axis only supplies its own component, so a 45 degree move can carry
    // 800/cos(45) before either axis is at its limit.
    expect(accelAlong(ROUTER, 1, 1, 0)).toBeCloseTo(800 / Math.SQRT1_2, 4);
  });

  it('is dragged down to the slow axis by even a little of it', () => {
    // A long XY move with a millimetre of Z in it is still an XY move, but the
    // controller will not exceed Z's own rate on Z, and that caps the vector.
    const rate = maxRateAlong(ROUTER, 100, 0, -1);
    expect(rate).toBeGreaterThan(6000 * 0.99);
    // A retract, where Z dominates, is the slow case.
    expect(maxRateAlong(ROUTER, 1, 0, -100)).toBeLessThan(1000);
  });
});

describe('the profile actually changes the estimate', () => {
  const move = [{ x1: 0, y1: 0, z1: 0, x2: 200, y2: 0, z2: 0, feed: 6000, rapid: false }];

  it('a machine that accelerates harder finishes sooner', () => {
    const slow = estimateMoveSeconds(move, {
      profile: { ...ROUTER, accel: { x: 50, y: 50, z: 50 } },
    });
    const fast = estimateMoveSeconds(move, { profile: ROUTER });
    expect(slow).toBeGreaterThan(fast);
  });

  it('a rapid runs at the axis maximum, not at an invented 3000', () => {
    const g = 'G90\nG0 X600\n';
    const quick = estimateGcodeTime(g, { profile: ROUTER });
    const stock = estimateGcodeTime(g, {
      profile: { ...ROUTER, maxRate: { x: 1000, y: 1000, z: 500 } },
    });
    // 600 mm at 6000 mm/min is 6 s; at 1000 mm/min it is 36.
    expect(quick.seconds).toBeLessThan(9);
    expect(stock.seconds).toBeGreaterThan(30);
  });

  it('a retract is timed on Z, which is the axis that actually does it', () => {
    // Same 20 mm, once across the bed and once straight up.
    const across = estimateGcodeTime('G90\nG0 X20\n', { profile: ROUTER });
    const up = estimateGcodeTime('G90\nG0 Z20\n', { profile: ROUTER });
    expect(up.seconds).toBeGreaterThan(across.seconds * 2);
  });

  it('reports whether the numbers were read or invented', () => {
    expect(estimateGcodeTime('G90\nG1 X10 F600\n', { profile: ROUTER }).source).toBe('machine');
    expect(estimateGcodeTime('G90\nG1 X10 F600\n').source).toBe('assumed');
  });
});

/**
 * `$11` — the setting that decides how much speed survives a corner.
 *
 * Every vertex of a traced outline is a corner, so on that kind of work this
 * number governs the job more than the feed does. Stock GRBL ships 0.010 and a
 * tuned belt machine runs several times that, which is the difference between
 * an estimate people trust and one they learn to ignore.
 */
describe('junction deviation', () => {
  it('is read off the controller', () => {
    const p = motionProfileFromSettings(parseGrblSettings(['$11=0.040', '$120=800', '$110=6000']));
    expect(p.junctionDeviation).toBe(0.04);
  });

  it("falls back to GRBL's own default when the controller does not report it", () => {
    const p = motionProfileFromSettings(parseGrblSettings(['$120=800', '$110=6000']));
    expect(p.junctionDeviation).toBe(DEFAULT_MOTION_PROFILE.junctionDeviation);
  });

  it('is treated as absent when it is zero, which no machine means', () => {
    const p = motionProfileFromSettings(parseGrblSettings(['$11=0', '$120=800']));
    expect(p.junctionDeviation).toBe(DEFAULT_MOTION_PROFILE.junctionDeviation);
  });

  it('shortens the estimate for a job made of corners', () => {
    // A zig-zag: every vertex is a full reversal-ish turn, so the whole job is
    // corner-limited rather than feed-limited.
    const moves: TimedMove[] = [];
    for (let i = 0; i < 60; i++) {
      moves.push({
        x1: i, y1: i % 2 ? 0 : 4, z1: 0,
        x2: i + 1, y2: i % 2 ? 4 : 0, z2: 0,
        feed: 3000, rapid: false,
      });
    }
    const settings = (jd: string) => parseGrblSettings([`$11=${jd}`, '$120=800', '$121=800', '$110=6000', '$111=6000']);
    const slack = estimateMoveSeconds(moves, { profile: motionProfileFromSettings(settings('0.050')) });
    const tight = estimateMoveSeconds(moves, { profile: motionProfileFromSettings(settings('0.010')) });
    expect(slack).toBeLessThan(tight);
  });
});
