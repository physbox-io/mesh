// Continuous collision keeps a cache of the pairs that can meet while the
// cloth stays near where it was made, and tests only those; finding none it
// is done, finding any it looks again in full. Its answers are the full
// look's: a persistent ClothCcd (cache used) against a fresh one per look
// (never cached), over a sheet sinking slowly onto another, then fast
// through it, then wobbling where it lies.

import { describe, expect, it } from 'vitest';
import { ClothCcd } from '../src/utils/cloth/clothCcd';

function sheet(k: number, size: number, z: number, base: number, pts: number[], tris: number[]) {
  for (let j = 0; j <= k; j++) for (let i = 0; i <= k; i++) pts.push((i / k - 0.5) * size + 0.003 * j, (j / k - 0.5) * size, z);
  for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) {
    const a = base + j * (k + 1) + i, b = a + 1, c = a + k + 1, d = c + 1;
    tris.push(a, b, d, a, d, c);
  }
}

describe('continuous collision pair cache', () => {
  it('gives the full look\'s answer, look after look', () => {
    const k = 12, pts: number[] = [], tris: number[] = [];
    sheet(k, 0.2, 0, 0, pts, tris);
    const top = pts.length / 3;
    sheet(k, 0.15, 0.012, top, pts, tris);
    const n = pts.length / 3, root = Int32Array.from({ length: n }, (_, i) => i), T = Int32Array.from(tris), w = new Float64Array(n).fill(1);
    const kept = new ClothCcd(n, T, root);
    let x = Float64Array.from(pts);
    let met = 0;
    for (let step = 0; step < 120; step++) {
      const x1 = Float64Array.from(x);
      // Slow at first (under a millimetre a look), then a fast plunge, then a wobble.
      const dz = step < 40 ? -0.0004 : step < 50 ? -0.004 : 0.0006 * Math.sin(step);
      for (let i = top; i < n; i++) { x1[3 * i + 2] += dz * (1 + 0.1 * Math.sin(i)); x1[3 * i] += 0.0002 * Math.cos(i + step); }
      const fresh = Float64Array.from(x1);
      const a = kept.resolve(x, x1, w);
      const b = new ClothCcd(n, T, root).resolve(x, fresh, w);
      expect(a).toEqual(b);
      expect(Array.from(x1)).toEqual(Array.from(fresh));
      met += a.met;
      x = x1;
    }
    expect(met).toBeGreaterThan(0); // it did meet, and was put right the same way
    expect((kept as unknown as { cacheUses: number }).cacheUses).toBeGreaterThan(0);
  });
});
