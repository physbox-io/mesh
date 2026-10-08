import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { neutralToneMap, preToneMappedColor } from '../src/utils/neutralToneMapping';

describe('preToneMappedColor', () => {
  // The viewport backdrops, a mid grey, and a saturated colour that only
  // partly crosses the compression threshold.
  it.each(['#f8fafc', '#0b0f19', '#808080', '#ef4444'])('comes out of the tone mapper as %s', (css) => {
    const want = new THREE.Color(css);
    const pre = preToneMappedColor(css);
    const got = neutralToneMap([pre.r, pre.g, pre.b]);
    expect(got[0]).toBeCloseTo(want.r, 4);
    expect(got[1]).toBeCloseTo(want.g, 4);
    expect(got[2]).toBeCloseTo(want.b, 4);
  });

  it('stays finite for pure white, which has no exact preimage', () => {
    const pre = preToneMappedColor('#ffffff');
    expect(Number.isFinite(pre.r)).toBe(true);
    expect(neutralToneMap([pre.r, pre.g, pre.b])[0]).toBeGreaterThan(0.99);
  });
});
