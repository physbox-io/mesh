import { describe, it, expect } from 'vitest';
import { orientationOf, authoredQuat } from '../src/utils/bodyOrientation';

const aboutX = (deg: number) => [Math.cos((deg * Math.PI) / 360), Math.sin((deg * Math.PI) / 360), 0, 0];

describe('which way a body points', () => {
  it('reads an upright body as vertical', () => {
    const o = orientationOf([1, 0, 0, 0]);
    expect(o.fromVerticalDeg).toBe(0);
    expect(o.headingDeg).toBeNull();
  });

  it('reads a phone leaning 22 degrees back', () => {
    const o = orientationOf(aboutX(22));
    expect(o.fromVerticalDeg).toBeCloseTo(22, 1);
    expect(o.fromHorizontalDeg).toBeCloseTo(68, 1);
    // Tipped about +X, its top swings towards -Y.
    expect(o.headingDeg).toBeCloseTo(-90, 1);
  });

  it('measures another of the body\'s own axes when asked', () => {
    expect(orientationOf(aboutX(22), 'x').fromVerticalDeg).toBeCloseTo(90, 1);
  });

  it('takes an authored euler in degrees, as MuJoCo does', () => {
    const q = authoredQuat({ euler: [22, 0, 0] });
    expect(orientationOf(q).fromVerticalDeg).toBeCloseTo(22, 1);
    expect(authoredQuat({})).toEqual([1, 0, 0, 0]);
  });
});
