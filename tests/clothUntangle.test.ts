// Untangling (utils/cloth/clothUntangle): a sheet with a bump pushed up
// through a flat sheet meets it along a closed contour; shrinking the
// contour parts them, with nothing but contour steps.

import { describe, it, expect } from 'vitest';
import { contourStep, findCrossings, untangleMesh } from '../src/utils/cloth/clothUntangle';

/** n x n grids of spacing h, each offset so no edge lies exactly over another: z(i, j) per sheet. */
function stack(n: number, h: number, zs: ((i: number, j: number) => number)[]) {
  const x: number[] = [], tris: number[] = [];
  zs.forEach((z, k) => {
    const base = k * n * n, off = 0.37 * h * k;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) x.push((i - (n - 1) / 2) * h + off, (j - (n - 1) / 2) * h + 0.7 * off, z(i, j));
    for (let i = 0; i + 1 < n; i++) for (let j = 0; j + 1 < n; j++) { const a = base + i * n + j, b = a + n, c = a + 1, d = b + 1; tris.push(a, b, d, a, d, c); }
  });
  return { x: Float64Array.from(x), tris: Int32Array.from(tris), n: zs.length * n * n };
}

function untangleAlone(x: Float64Array, tris: Int32Array, n: number, step: number, most: number) {
  const m = untangleMesh(n, tris, []);
  const w = new Float64Array(n).fill(1);
  const dx = new Float64Array(3 * n), count = new Float64Array(n);
  const before = findCrossings(x, m).length;
  let steps = 0, left = before, peak = before;
  for (; steps < most && left; steps++) {
    contourStep(x, w, m, findCrossings(x, m), step, dx, count);
    for (let k = 0; k < dx.length; k++) x[k] += dx[k];
    left = findCrossings(x, m).length;
    peak = Math.max(peak, left);
  }
  return { before, left, steps, peak };
}

/** Two n x n grids of spacing h: a flat one at z = 0, and above it one whose middle bulges `bump` up through it from `below`. */
function sheets(n: number, h: number, below: number, bump: number) {
  const x: number[] = [], tris: number[] = [];
  const grid = (z: (i: number, j: number) => number, base: number, off: number) => {
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) x.push((i - (n - 1) / 2) * h + off, (j - (n - 1) / 2) * h + 0.7 * off, z(i, j));
    for (let i = 0; i + 1 < n; i++) for (let j = 0; j + 1 < n; j++) {
      const a = base + i * n + j, b = a + n, c = a + 1, d = b + 1;
      tris.push(a, b, d, a, d, c);
    }
  };
  // The bump's grid offset from the sheet's, so no edge lies exactly over another.
  grid(() => 0, 0, 0);
  const r0 = ((n - 1) / 2) * h;
  grid((i, j) => {
    const r = Math.hypot((i - (n - 1) / 2) * h, (j - (n - 1) / 2) * h) / r0;
    return -below + bump * Math.max(0, 1 - r * r);
  }, n * n, 0.37 * h);
  return { x: Float64Array.from(x), tris: Int32Array.from(tris), n: 2 * n * n };
}

describe('untangling', () => {
  it('parts a bump pushed up through a sheet by shrinking where they cross', () => {
    const { x, tris, n } = sheets(21, 0.01, 0.004, 0.012);
    const m = untangleMesh(n, tris, []);
    const w = new Float64Array(n).fill(1);
    const dx = new Float64Array(3 * n), count = new Float64Array(n);
    const before = findCrossings(x, m).length;
    let steps = 0, left = before;
    for (; steps < 200 && left; steps++) {
      contourStep(x, w, m, findCrossings(x, m), 0.0005, dx, count);
      for (let k = 0; k < dx.length; k++) x[k] += dx[k];
      left = findCrossings(x, m).length;
    }
    console.log(`bump through a sheet: ${before} crossings, ${left} after ${steps} steps`);
    expect(before).toBeGreaterThan(10);
    expect(left).toBe(0);
  });

  // Pleats: layers a millimetre apart. The middle one's bump is through the
  // top one; parting them must not push either through the bottom one.
  it('parts a bump through the top of three layers a millimetre apart without crossing the third', () => {
    const n = 21, h = 0.01, r0 = ((n - 1) / 2) * h;
    const bump = (i: number, j: number) => Math.max(0, 1 - (Math.hypot((i - (n - 1) / 2) * h, (j - (n - 1) / 2) * h) / r0) ** 2);
    const { x, tris, n: np } = stack(n, h, [() => 0, (i, j) => -0.0005 + 0.002 * bump(i, j), () => -0.001]);
    const r = untangleAlone(x, tris, np, 0.0002, 400);
    console.log(`three layers: ${r.before} crossings, ${r.left} after ${r.steps} steps, most on the way ${r.peak}`);
    expect(r.before).toBeGreaterThan(10);
    expect(r.left).toBe(0);
    expect(r.peak).toBeLessThanOrEqual(r.before);
  });
});
