import { describe, it, expect } from 'vitest';
import {
  recommendSpeeds,
  describeSpeedRecommendation,
  materialSpec,
  MATERIALS,
  DEFAULT_SPINDLE_RANGE,
} from '../src/utils/feedsAndSpeeds';
import { chiploadMm } from '../src/utils/reliefCarveExporter';

describe('what RPM to set', () => {
  it('is surface speed over diameter, so a bigger cutter turns slower', () => {
    const small = recommendSpeeds({ diameterMm: 3.175, flutes: 2, material: 'hardwood' });
    const big = recommendSpeeds({ diameterMm: 12, flutes: 2, material: 'hardwood' });
    expect(small.rpm).toBeGreaterThan(big.rpm);

    // 250 m/min over a 12 mm cutter is about 6,600 RPM, and that arithmetic is
    // the whole recommendation — not a number picked to look plausible. Shown
    // here on a spindle that can actually be dialled that low.
    const ideal = (materialSpec('hardwood').surfaceSpeedMMin * 1000) / (Math.PI * 12);
    const onARealSpindle = recommendSpeeds({
      diameterMm: 12,
      flutes: 2,
      material: 'hardwood',
      spindle: { min: 6000, max: 24000 },
    });
    expect(onARealSpindle.rpm).toBeCloseTo(Math.round(ideal / 500) * 500, 0);
    expect(onARealSpindle.clampedBy).toBeNull();
  });

  it('says when the spindle will not go slow enough for a big cutter', () => {
    // A trim router does not idle below about 10,000, and a 12 mm cutter in oak
    // wants 6,600 — so the edge is running hot and the operator should be told,
    // rather than handed a number that looks like a considered recommendation.
    const rec = recommendSpeeds({
      diameterMm: 12,
      flutes: 2,
      material: 'hardwood',
      spindle: { min: 10000, max: 30000 },
    });
    expect(rec.rpm).toBe(10000);
    expect(rec.clampedBy).toBe('spindle-min');
    // The wording changed with the hint rewrite; what matters is that it still
    // warns about the edge running hot and says what to do about it.
    expect(describeSpeedRecommendation(rec, 'hardwood', 12)).toMatch(/heat|hot/i);
    expect(describeSpeedRecommendation(rec, 'hardwood', 12)).toMatch(/shallow pass/i);
  });

  it('lands near the 12,000 that used to be hard-coded, for the bit that was assumed', () => {
    // A 1/4" cutter in hardwood — which is what the old fixed default silently
    // suited, and nothing else.
    const rec = recommendSpeeds({ diameterMm: 6.35, flutes: 2, material: 'hardwood' });
    expect(rec.rpm).toBeGreaterThan(11000);
    expect(rec.rpm).toBeLessThan(14000);
  });

  it('stops at the spindle the machine actually has, and says so', () => {
    // A 1.5 mm bit in pine asks for over 60,000 RPM. No hobby spindle will.
    const rec = recommendSpeeds({
      diameterMm: 1.5,
      flutes: 1,
      material: 'softwood',
      spindle: { min: 8000, max: 24000 },
    });
    expect(rec.rpm).toBe(24000);
    expect(rec.clampedBy).toBe('spindle-max');
    // Says the spindle tops out below the ideal, and that the feed already
    // accounts for it.
    expect(describeSpeedRecommendation(rec, 'softwood', 1.5)).toMatch(/maximum RPM is lower|under\s+speed/i);
    expect(describeSpeedRecommendation(rec, 'softwood', 1.5)).toMatch(/feed rate has been adjusted|allows for that/i);
  });

  it('holds acrylic down rather than up, because it melts rather than wears', () => {
    const acrylic = recommendSpeeds({ diameterMm: 3.175, flutes: 1, material: 'acrylic' });
    const pine = recommendSpeeds({ diameterMm: 3.175, flutes: 1, material: 'softwood' });
    expect(acrylic.rpm).toBeLessThan(pine.rpm);
    expect(acrylic.clampedBy).toBe('material');
    // And it wants a bigger bite, to carry the heat out in the chip.
    expect(acrylic.chiploadMm).toBeGreaterThan(pine.chiploadMm);
  });

  it('runs aluminium far slower than wood', () => {
    const al = recommendSpeeds({ diameterMm: 6, flutes: 2, material: 'aluminium' });
    const oak = recommendSpeeds({ diameterMm: 6, flutes: 2, material: 'hardwood' });
    expect(al.rpm).toBeLessThan(oak.rpm);
    expect(al.chiploadMm).toBeLessThan(oak.chiploadMm / 2);
  });

  it('produces a feed that is the chipload it claims', () => {
    const rec = recommendSpeeds({ diameterMm: 6, flutes: 2, material: 'hardwood' });
    const actual = chiploadMm(rec.feedMmMin, rec.rpm, 2);
    // Within the rounding the feed is snapped to.
    expect(actual).toBeCloseTo(rec.chiploadMm, 2);
  });

  it('feeds a four-flute cutter faster than a two-flute one at the same speed', () => {
    const two = recommendSpeeds({ diameterMm: 6, flutes: 2, material: 'hardwood' });
    const four = recommendSpeeds({ diameterMm: 6, flutes: 4, material: 'hardwood' });
    expect(four.rpm).toBe(two.rpm);
    expect(four.feedMmMin).toBeCloseTo(two.feedMmMin * 2, -1);
  });

  it('never plunges at the cutting feed', () => {
    for (const m of MATERIALS) {
      const rec = recommendSpeeds({ diameterMm: 6, flutes: 2, material: m.id });
      expect(rec.plungeMmMin).toBeLessThan(rec.feedMmMin);
    }
  });

  it('derates for a cutter hanging a long way out', () => {
    const full = recommendSpeeds({ diameterMm: 3, flutes: 2, material: 'hardwood' });
    const stretched = recommendSpeeds({ diameterMm: 3, flutes: 2, material: 'hardwood', derate: 0.5 });
    expect(stretched.rpm).toBe(full.rpm);
    expect(stretched.feedMmMin).toBeLessThan(full.feedMmMin);
  });

  it('gives every material a usable answer inside a stock spindle range', () => {
    for (const m of MATERIALS) {
      for (const dia of [1, 3.175, 6.35, 12]) {
        const rec = recommendSpeeds({ diameterMm: dia, flutes: 2, material: m.id });
        expect(rec.rpm).toBeGreaterThanOrEqual(DEFAULT_SPINDLE_RANGE.min);
        expect(rec.rpm).toBeLessThanOrEqual(DEFAULT_SPINDLE_RANGE.max);
        expect(rec.feedMmMin).toBeGreaterThan(0);
        expect(Number.isFinite(rec.feedMmMin)).toBe(true);
      }
    }
  });
});

describe('when the machine cannot track the ideal feed', () => {
  // A 6 mm two-flute in pine wants ~17,000 RPM, and holding 0.18 mm a tooth at
  // that speed needs ~6,100 mm/min. A machine that tops out at 4,000 cannot do
  // the second half of that — but 4,000 mm/min at 0.36 mm a revolution is
  // ~11,000 RPM, which its spindle can still reach, so the chip survives.
  const SLOW_GANTRY = 4000;

  it('turns the spindle down rather than starving the chip', () => {
    const free = recommendSpeeds({ diameterMm: 6, flutes: 2, material: 'softwood' });
    const limited = recommendSpeeds({
      diameterMm: 6,
      flutes: 2,
      material: 'softwood',
      maxFeedMmMin: SLOW_GANTRY,
    });

    expect(limited.clampedBy).toBe('gantry');
    expect(limited.rpm).toBeLessThan(free.rpm);
    expect(limited.feedMmMin).toBeLessThanOrEqual(SLOW_GANTRY);
    // The whole point: the chip stays the right thickness. Feeding slower at
    // the higher RPM would have thinned it, which is rubbing, not cutting.
    expect(chiploadMm(limited.feedMmMin, limited.rpm, 2)).toBeCloseTo(limited.chiploadMm, 2);
    expect(limited.chiploadMm).toBeCloseTo(free.chiploadMm, 6);
  });

  it('says why the speed is not the textbook one', () => {
    const rec = recommendSpeeds({
      diameterMm: 6,
      flutes: 2,
      material: 'softwood',
      maxFeedMmMin: SLOW_GANTRY,
    });
    // Says the RPM was moved to suit the machine's feed limit, and that chip
    // thickness is what is being held.
    expect(describeSpeedRecommendation(rec, 'softwood', 6)).toMatch(/machine feed rate|turned down|cannot track/i);
    expect(describeSpeedRecommendation(rec, 'softwood', 6)).toMatch(/chip thickness/i);
  });

  it('leaves a machine that can keep up alone', () => {
    const fast = recommendSpeeds({
      diameterMm: 6,
      flutes: 2,
      material: 'softwood',
      maxFeedMmMin: 20000,
    });
    expect(fast.clampedBy).not.toBe('gantry');
    expect(fast).toEqual(recommendSpeeds({ diameterMm: 6, flutes: 2, material: 'softwood' }));
  });

  it('still refuses to go below the spindle floor', () => {
    const rec = recommendSpeeds({
      diameterMm: 6,
      flutes: 2,
      material: 'softwood',
      maxFeedMmMin: 100,
      spindle: { min: 10000, max: 30000 },
    });
    expect(rec.rpm).toBe(10000);
    expect(rec.clampedBy).toBe('spindle-min');
    // The feed is still held to what the machine can track, even though the
    // chip is now thinner than ideal — which the note explains.
    expect(rec.feedMmMin).toBeLessThanOrEqual(100);
  });
});
