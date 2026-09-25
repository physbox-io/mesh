import { describe, it, expect } from 'vitest';
import { sliderSpan, offsetSpan, lengthSpan } from '../src/utils/sliderSpan';

describe('sliderSpan', () => {
  it('is the usual range in 10 mm steps while the value is inside it', () => {
    expect(offsetSpan(0.5)).toEqual({ min: -4, max: 4, step: 0.01 });
    expect(lengthSpan(0.2)).toEqual({ min: 0.01, max: 4, step: 0.01 });
  });

  it('stretches to a value typed past either end, out to a whole step', () => {
    const up = offsetSpan(6.123);
    expect(up.min).toBe(-4);
    expect(up.max).toBeCloseTo(6.13, 9);
    const down = offsetSpan(-5.5);
    expect(down.min).toBeCloseTo(-5.5, 9);
    expect(down.max).toBe(4);
    expect(lengthSpan(7).max).toBeCloseTo(7, 9);
  });

  it('keeps the stops on round numbers when it stretches', () => {
    const { min, step } = offsetSpan(-4.567);
    const k = (-4 - min) / step;
    expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6);
  });

  it('does not stretch for float noise on a bound', () => {
    expect(offsetSpan(4.000000000001).max).toBe(4);
  });

  it('falls back to the range for a value that is not a number', () => {
    expect(sliderSpan(NaN, -1, 1)).toEqual({ min: -1, max: 1, step: 0.01 });
  });
});
