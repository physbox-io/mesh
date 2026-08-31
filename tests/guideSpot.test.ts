import { describe, it, expect } from 'vitest';
import {
  DEFAULT_GUIDE_POWER_PCT,
  DEFAULT_SPINDLE_PWM_MAX,
  MAX_GUIDE_POWER_PCT,
  clampGuidePower,
  guidePowerToS,
} from '../src/utils/guideSpot';

/**
 * The guide spot fires the real cutting beam at a machine the operator is
 * standing over, so the ceiling on its power is a safety property rather than a
 * UI nicety — `guideSpotOn` clamps with this too, and not only the number box.
 */
describe('clampGuidePower', () => {
  it('caps at the maximum however it is asked', () => {
    expect(clampGuidePower(100)).toBe(MAX_GUIDE_POWER_PCT);
    expect(clampGuidePower(MAX_GUIDE_POWER_PCT + 0.1)).toBe(MAX_GUIDE_POWER_PCT);
  });

  it('falls back rather than accepting nothing, zero or nonsense', () => {
    expect(clampGuidePower(0)).toBe(DEFAULT_GUIDE_POWER_PCT);
    expect(clampGuidePower(-3)).toBe(DEFAULT_GUIDE_POWER_PCT);
    expect(clampGuidePower(NaN)).toBe(DEFAULT_GUIDE_POWER_PCT);
  });

  it('keeps tenths, which is where the threshold of a diode lives', () => {
    expect(clampGuidePower(0.5)).toBe(0.5);
    expect(clampGuidePower(1.24)).toBe(1.2);
  });
});

describe('guidePowerToS', () => {
  it('is a percentage of the controller\'s own full scale', () => {
    expect(guidePowerToS(1, 1000)).toBe(10);
    expect(guidePowerToS(1, 255)).toBe(3);
    expect(guidePowerToS(2.5, 1000)).toBe(25);
  });

  it('assumes the usual full scale when $30 has not been read', () => {
    expect(guidePowerToS(1, NaN)).toBe(guidePowerToS(1, DEFAULT_SPINDLE_PWM_MAX));
    expect(guidePowerToS(1, 0)).toBe(guidePowerToS(1, DEFAULT_SPINDLE_PWM_MAX));
  });

  it('never rounds down to a beam that never lights', () => {
    // 0.5% of a $30 of 100 is 0.5, and S0 is indistinguishable at the machine
    // from the button being broken.
    expect(guidePowerToS(0.5, 100)).toBe(1);
  });

  it('clamps before converting, so the S word cannot exceed the cap either', () => {
    expect(guidePowerToS(500, 1000)).toBe((MAX_GUIDE_POWER_PCT / 100) * 1000);
  });
});
