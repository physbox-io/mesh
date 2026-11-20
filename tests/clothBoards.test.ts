import { describe, expect, it } from 'vitest';
import { BoardShapes } from '../src/utils/cloth/clothBoards';

/** A square board of N x N cells, 1 cm each, its flat pattern and triangles. */
const square = (N = 8) => {
  const rest: number[][] = [], tris: number[] = [];
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) rest.push([i * 0.01, j * 0.01]);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const a = j * (N + 1) + i; tris.push(a, a + 1, a + N + 2, a, a + N + 2, a + N + 1); }
  return { rest, tris, particles: rest.map((_, k) => k) };
};
const worstStrain = (x: Float64Array, rest: number[][], tris: number[]) => {
  let e = 0;
  for (let t = 0; t < tris.length; t += 3) for (let q = 0; q < 3; q++) {
    const a = tris[t + q], c = tris[t + ((q + 1) % 3)];
    e = Math.max(e, Math.abs(Math.hypot(x[3 * a] - x[3 * c], x[3 * a + 1] - x[3 * c + 1], x[3 * a + 2] - x[3 * c + 2]) / Math.hypot(rest[a][0] - rest[c][0], rest[a][1] - rest[c][1]) - 1));
  }
  return e;
};

describe('boards (clothBoards)', () => {
  it('brings a bent and stretched board back to its flat shape', () => {
    const b = square();
    const x = new Float64Array(b.rest.length * 3);
    b.rest.forEach(([u, v], k) => { x[3 * k] = u * 1.1; x[3 * k + 1] = v * Math.cos(8 * v); x[3 * k + 2] = -5 * v * v; });
    expect(worstStrain(x, b.rest, b.tris)).toBeGreaterThan(0.05);
    const shapes = new BoardShapes([b], b.rest.length);
    for (let it = 0; it < 30; it++) shapes.solve(x, new Float64Array(b.rest.length).fill(1));
    expect(worstStrain(x, b.rest, b.tris)).toBeLessThan(0.005);
  });

  it('leaves held points where they are and fits the rest of the board to them', () => {
    const b = { ...square(), held: [0, 1, 2, 3, 4, 5, 6, 7, 8] };
    const x = new Float64Array(b.rest.length * 3);
    // Its held row level; the rest hanging down off it at 60 degrees.
    b.rest.forEach(([u, v], k) => { x[3 * k] = u; x[3 * k + 1] = v * 0.5; x[3 * k + 2] = -v * 0.866; });
    const before = x.slice(0, 27);
    const shapes = new BoardShapes([b], b.rest.length);
    for (let it = 0; it < 30; it++) shapes.solve(x, new Float64Array(b.rest.length).fill(1));
    expect(Array.from(x.slice(0, 27))).toEqual(Array.from(before));
    expect(worstStrain(x, b.rest, b.tris)).toBeLessThan(0.02);
  });

  it('converges on pass 1 without folding when a curved board starts ~180 degrees from rest space', () => {
    const N = 8, R = 0.16;
    const rest: number[][] = [], tris: number[] = [];
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const u = (i - N / 2) * 0.015, v = j * 0.01, th = u / R;
        rest.push([R * Math.sin(th), v, R * (1 - Math.cos(th))]);
      }
    }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i;
      tris.push(a, a + 1, a + N + 2, a, a + N + 2, a + N + 1);
    }
    const held = Array.from({ length: N + 1 }, (_, i) => i);
    const b = { rest, tris, particles: rest.map((_, k) => k), held };
    // 1. Placed in exact 180-deg X-rotated rest pose ((x, y, z) -> (x, -y, -z)): a single cold-start solve pass must keep 0% strain (no 180-deg saddle yank).
    const xExact = new Float64Array(rest.length * 3);
    rest.forEach(([rx, ry, rz], k) => { xExact[3 * k] = rx; xExact[3 * k + 1] = -ry; xExact[3 * k + 2] = -rz; });
    const w = new Float64Array(rest.length).fill(1);
    new BoardShapes([b], rest.length).solve(xExact, w);
    const maxStrain = (arr: Float64Array) => {
      let maxErr = 0;
      for (let t = 0; t < tris.length; t += 3) for (let q = 0; q < 3; q++) {
        const a = tris[t + q], c = tris[t + ((q + 1) % 3)];
        const dCur = Math.hypot(arr[3 * a] - arr[3 * c], arr[3 * a + 1] - arr[3 * c + 1], arr[3 * a + 2] - arr[3 * c + 2]);
        const dRest = Math.hypot(rest[a][0] - rest[c][0], rest[a][1] - rest[c][1], rest[a][2] - rest[c][2]);
        maxErr = Math.max(maxErr, Math.abs(dCur / dRest - 1));
      }
      return maxErr;
    };
    expect(maxStrain(xExact)).toBeLessThan(1e-4);

    // 2. Stretched and bent while flipped ~180 deg around X: recovers its curved arch within 30 passes.
    const x = new Float64Array(rest.length * 3);
    const bFree = { rest, tris, particles: rest.map((_, k) => k) };
    rest.forEach(([rx, ry, rz], k) => {
      x[3 * k] = rx * 1.1;
      x[3 * k + 1] = -ry * Math.cos(6 * ry);
      x[3 * k + 2] = -rz - 4 * ry * ry;
    });
    expect(maxStrain(x)).toBeGreaterThan(0.08);
    const shapes = new BoardShapes([bFree], rest.length);
    for (let it = 0; it < 30; it++) shapes.solve(x, w);
    expect(maxStrain(x)).toBeLessThan(0.005);
  });
});
