import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  withSpindleOverride,
  readSpindleMaxOverride,
  writeSpindleMaxOverride,
  programMaxSpindle,
  spindleCeilingRefusal,
  SPINDLE_MAX_OVERRIDE_KEY,
  MIN_RPM_CEILING_FROM_30,
} from '../src/utils/spindleOverride';

// Writing an override mirrors it to the account; nothing here has one.
vi.mock('../src/utils/apiClient', () => ({ syncCloudParameters: vi.fn().mockResolvedValue(undefined) }));
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

/*
 * Kept per controller. One number for the account put a hand-dial router's
 * 24,000 on top of the next machine's $30=10000 PWM spindle, and GRBL clamped
 * every S to 10,000 under feeds planned for 24,000.
 */
describe('the override, per machine', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('applies only to the machine it was set for', () => {
    writeSpindleMaxOverride(24000, 'grbl:1.1h:router');
    expect(readSpindleMaxOverride('grbl:1.1h:router')).toBe(24000);
    expect(readSpindleMaxOverride('grbl:1.1h:mill')).toBeNull();
    expect(readSpindleMaxOverride(null)).toBeNull();
  });

  it('keeps one set with no machine identified for when none is', () => {
    writeSpindleMaxOverride(30000, null);
    expect(readSpindleMaxOverride(null)).toBe(30000);
    expect(readSpindleMaxOverride('grbl:1.1h:mill')).toBeNull();
  });

  it('reads what an older build wrote as the unkeyed value, not as every machine\'s', () => {
    store.set(SPINDLE_MAX_OVERRIDE_KEY, '24000');
    expect(readSpindleMaxOverride(null)).toBe(24000);
    expect(readSpindleMaxOverride('cloud:box-1')).toBeNull();
  });

  it('clears one machine without touching another', () => {
    writeSpindleMaxOverride(24000, 'a');
    writeSpindleMaxOverride(18000, 'b');
    writeSpindleMaxOverride(null, 'a');
    expect(readSpindleMaxOverride('a')).toBeNull();
    expect(readSpindleMaxOverride('b')).toBe(18000);
  });
});

describe('a program asking for more spindle than the controller has', () => {
  const pwm = { maxRpm: 10000, laser: false, overridden: false };
  const job = ['G21 G90', '(S30000 is what oak would like)', 'M3 S24000', 'G4 P2', 'G1 X10 F1500', 'M30'];

  it('reads the highest S, ignoring comments', () => {
    expect(programMaxSpindle(job)).toBe(24000);
    expect(programMaxSpindle(['G0 X0', '; S99999'])).toBeNull();
  });

  it('is refused with a reason that says to re-export', () => {
    expect(spindleCeilingRefusal(job, pwm)).toMatch(/S24000.*10000 RPM.*2\.4×.*Re-export for this machine/s);
  });

  it('is not refused at or under $30', () => {
    expect(spindleCeilingRefusal(['M3 S10000', 'G1 X1 F500'], pwm)).toBeNull();
  });

  it('is not refused where S drives nothing — a machine with its own override', () => {
    expect(spindleCeilingRefusal(job, { ...pwm, overridden: true })).toBeNull();
  });

  it('never catches a laser job, whose S is a power', () => {
    expect(spindleCeilingRefusal(job, { ...pwm, laser: true })).toBeNull();
    // $32 read as off (a borrowed guide spot), but the program fires with M4.
    expect(spindleCeilingRefusal(['M4 S24000', 'G1 X10 F3000', 'M5', 'M30'], pwm)).toBeNull();
  });

  /*
   * A hand-dial router left at the factory $30=1000 has never had a reason to
   * change it, because S drives nothing on it. Read as an RPM ceiling, that
   * refused every job it was sent.
   */
  it('reads a $30 under 3000 as a PWM scale, not a ceiling', () => {
    expect(spindleCeilingRefusal(job, { ...pwm, maxRpm: 1000 })).toBeNull();
    expect(spindleCeilingRefusal(job, { ...pwm, maxRpm: 255 })).toBeNull();
    expect(spindleCeilingRefusal(job, { ...pwm, maxRpm: MIN_RPM_CEILING_FROM_30 - 1 })).toBeNull();
    // At the threshold it is a speed again.
    expect(spindleCeilingRefusal(job, { ...pwm, maxRpm: MIN_RPM_CEILING_FROM_30 })).toMatch(/S24000/);
  });

  it('says nothing when the controller has not said what $30 is', () => {
    expect(spindleCeilingRefusal(job, { ...pwm, maxRpm: undefined })).toBeNull();
  });
});
