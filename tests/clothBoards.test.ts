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
});
