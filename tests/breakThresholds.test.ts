// The weld-break decision, which the worker cannot be tested through.
//
// The hysteresis is the part worth covering: a single overloaded step is a
// solver transient on contact onset, not a failure, and a version of this that
// broke on the first step over the line snapped handles off mugs that were set
// down gently.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DENT_MAX_DEPTH, DEFAULT_HOLD_STEPS, dentDepth, holdSteps, isBreakable,
  isOverloaded, shatterVerdict, weldKey, weldOverload,
} from '../src/utils/breakThresholds';

describe('isBreakable', () => {
  it('is false for a weld with no thresholds, which is every weld that shipped before this', () => {
    expect(isBreakable(undefined)).toBe(false);
    expect(isBreakable({})).toBe(false);
  });

  it('takes either threshold on its own', () => {
    expect(isBreakable({ weldBreakForceN: 50 })).toBe(true);
    expect(isBreakable({ weldBreakTorqueNm: 2 })).toBe(true);
  });

  it('ignores a threshold that is not a usable number', () => {
    expect(isBreakable({ weldBreakForceN: NaN })).toBe(false);
    expect(isBreakable({ weldBreakForceN: Infinity })).toBe(false);
    expect(isBreakable({ weldBreakForceN: -1 })).toBe(false);
  });
});

describe('isOverloaded', () => {
  it('breaks on force alone', () => {
    expect(isOverloaded(60, 0, { weldBreakForceN: 50 })).toBe(true);
    expect(isOverloaded(40, 0, { weldBreakForceN: 50 })).toBe(false);
  });

  it('breaks on torque alone', () => {
    expect(isOverloaded(0, 3, { weldBreakTorqueNm: 2 })).toBe(true);
    expect(isOverloaded(0, 1, { weldBreakTorqueNm: 2 })).toBe(false);
  });

  it('ignores the axis it was given no limit for', () => {
    // A weld given only a force limit is not expected to survive unlimited
    // torque; it is expected not to care about torque.
    expect(isOverloaded(0, 1e6, { weldBreakForceN: 50 })).toBe(false);
  });

  it('treats a zero threshold as "breaks under any load", not as unset', () => {
    expect(isOverloaded(0.001, 0, { weldBreakForceN: 0 })).toBe(true);
  });

  it('is false when nothing is configured', () => {
    expect(isOverloaded(1e9, 1e9, {})).toBe(false);
    expect(isOverloaded(1e9, 1e9, undefined)).toBe(false);
  });
});

describe('holdSteps', () => {
  it('defaults when unset or unusable', () => {
    expect(holdSteps(undefined)).toBe(DEFAULT_HOLD_STEPS);
    expect(holdSteps({})).toBe(DEFAULT_HOLD_STEPS);
    expect(holdSteps({ weldBreakHoldSteps: NaN })).toBe(DEFAULT_HOLD_STEPS);
  });

  it('floors at one, because zero cannot be expressed by the caller\'s counter', () => {
    expect(holdSteps({ weldBreakHoldSteps: 0 })).toBe(1);
    expect(holdSteps({ weldBreakHoldSteps: -5 })).toBe(1);
  });

  it('rounds, since a fractional step does not exist', () => {
    expect(holdSteps({ weldBreakHoldSteps: 2.6 })).toBe(3);
  });
});

describe('weldOverload hysteresis', () => {
  const cfg = { weldBreakForceN: 50, weldBreakHoldSteps: 3 };

  it('does not break on a single spike', () => {
    const r = weldOverload(500, 0, cfg, 0);
    expect(r.broken).toBe(false);
    expect(r.consecutive).toBe(1);
  });

  it('breaks once the overload has lasted the full hold', () => {
    let consecutive = 0;
    const seen: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      const r = weldOverload(500, 0, cfg, consecutive);
      consecutive = r.consecutive;
      seen.push(r.broken);
    }
    expect(seen).toEqual([false, false, true]);
  });

  it('resets the count when the load comes off, so two spikes are not one overload', () => {
    let { consecutive } = weldOverload(500, 0, cfg, 0);
    expect(consecutive).toBe(1);
    ({ consecutive } = weldOverload(10, 0, cfg, consecutive));
    expect(consecutive).toBe(0);
    const r = weldOverload(500, 0, cfg, consecutive);
    expect(r.broken).toBe(false);
    expect(r.consecutive).toBe(1);
  });

  it('breaks on the first step when the hold is one', () => {
    expect(weldOverload(500, 0, { weldBreakForceN: 50, weldBreakHoldSteps: 1 }, 0).broken).toBe(true);
  });

  it('never breaks a weld with no thresholds, however hard it is pulled', () => {
    const r = weldOverload(1e9, 1e9, {}, 99);
    expect(r.broken).toBe(false);
    expect(r.consecutive).toBe(0);
  });
});

describe('weldKey', () => {
  it('is built from the two ids, so it survives a rebuild that shifts equality indices', () => {
    expect(weldKey('handle', 'mug')).toBe('weld:handle->mug');
    expect(weldKey('handle', 'mug')).not.toBe(weldKey('mug', 'handle'));
  });
});

describe('shatterVerdict', () => {
  it('needs a threshold before anything can break it', () => {
    expect(shatterVerdict(1e6, {})).toBe(false);
    expect(shatterVerdict(1e6, undefined)).toBe(false);
    expect(shatterVerdict(1e6, { shatterImpulseNs: 0 })).toBe(false);
  });

  it('breaks at or above the threshold, and not below', () => {
    expect(shatterVerdict(2.0, { shatterImpulseNs: 1.5 })).toBe(true);
    expect(shatterVerdict(1.5, { shatterImpulseNs: 1.5 })).toBe(true);
    expect(shatterVerdict(1.4, { shatterImpulseNs: 1.5 })).toBe(false);
  });
});

describe('dentDepth', () => {
  const steel = { dentYieldNs: 4, dentDepthPerNs: 0.004, dentMaxDepth: 0.02 };

  it('leaves no mark below the yield — the soft weight case', () => {
    expect(dentDepth(3.9, steel)).toBe(0);
    expect(dentDepth(0, steel)).toBe(0);
  });

  it('craters above it, in proportion to the excess — the hard weight case', () => {
    expect(dentDepth(5, steel)).toBeCloseTo(0.004, 9);
    expect(dentDepth(6, steel)).toBeCloseTo(0.008, 9);
  });

  it('clamps, so a hard enough blow dents rather than punching through', () => {
    expect(dentDepth(1000, steel)).toBe(0.02);
  });

  it('is inert on a geom that was never made dentable', () => {
    expect(dentDepth(1e6, {})).toBe(0);
    expect(dentDepth(1e6, undefined)).toBe(0);
  });

  it('falls back to sane numbers when only a yield is given', () => {
    const d = dentDepth(10, { dentYieldNs: 5 });
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThanOrEqual(DEFAULT_DENT_MAX_DEPTH);
  });

  it('ignores nonsense rates rather than producing NaN', () => {
    expect(dentDepth(10, { dentYieldNs: 5, dentDepthPerNs: NaN })).toBeGreaterThan(0);
    expect(dentDepth(10, { dentYieldNs: 5, dentMaxDepth: -1 })).toBeGreaterThan(0);
  });
});
