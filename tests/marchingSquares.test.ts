import { describe, expect, it } from 'vitest';
import { isoContours } from '../src/utils/marchingSquares';

/** Segments marching squares emits for a field: one per crossed cell, two for a saddle. */
function segmentCount(f: Float32Array, n: number, level: number): number {
  let segs = 0;
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = [f[r * n + c], f[r * n + c + 1], f[(r + 1) * n + c + 1], f[(r + 1) * n + c]].map((x) => (x >= level ? 1 : 0));
      const s = v[0] + v[1] + v[2] + v[3];
      if (s === 0 || s === 4) continue;
      segs += s === 2 && v[0] === v[2] ? 2 : 1;
    }
  }
  return segs;
}

describe('isoContours', () => {
  it('closes every contour of a field that is zero round its border', () => {
    // Joining segment ends by quantised coordinates dropped loops whose
    // crossings sat near a pixel: two edges' crossings rounded to one key.
    let seed = 1;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const n = 6;
    const lost: number[] = [];
    for (let trial = 0; trial < 20000; trial++) {
      const f = new Float32Array(n * n);
      for (let r = 1; r < n - 1; r++) for (let c = 1; c < n - 1; c++) f[r * n + c] = rnd() * 3;
      const level = rnd() * 3;
      const points = isoContours(f, n, n, level).reduce((a, l) => a + l.length, 0);
      if (points !== segmentCount(f, n, level)) lost.push(trial);
    }
    expect(lost).toEqual([]);
  });

  it('keeps a loop whose level lands exactly on pixels', () => {
    const n = 5;
    const f = new Float32Array(n * n);
    for (let r = 1; r < 4; r++) for (let c = 1; c < 4; c++) f[r * n + c] = 1;
    f[2 * n + 2] = 2;
    const loops = isoContours(f, n, n, 1);
    expect(loops).toHaveLength(1);
    const [loop] = loops;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      expect(a.x === b.x && a.y === b.y).toBe(false);
    }
  });
});
