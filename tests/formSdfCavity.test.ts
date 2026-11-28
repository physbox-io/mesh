// The garment shell's distance field reads air as outside even where it is
// reached only through a narrow mouth: the outside flood used to stop at the
// surface band, so a hollow behind a gap of four cells or fewer read as
// inside the body, and a garment surface could grow in it.

import { describe, it, expect } from 'vitest';
import { gridOver, meshSdf, sampleGrid } from '../src/utils/cloth/formSdf';

/** A voxel solid's outward-wound boundary: the unit box less a central cavity, open through a narrow chimney in its top. */
function hollowBox(vs: number, chimney: boolean) {
  const N = Math.round(1 / vs);
  const solid = (i: number, j: number, k: number) => {
    if (i < 0 || j < 0 || k < 0 || i >= N || j >= N || k >= N) return false;
    const c = [(i + 0.5) * vs, (j + 0.5) * vs, (k + 0.5) * vs];
    const inCav = c.every((v) => v > 0.2 && v < 0.8);
    const inHole = chimney && c[0] > 0.4 && c[0] < 0.6 && c[1] > 0.4 && c[1] < 0.6 && c[2] > 0.8;
    return !inCav && !inHole;
  };
  const pts: number[][] = [], tris: number[] = [], idx = new Map<string, number>();
  const P = (x: number, y: number, z: number) => { const k = `${x},${y},${z}`; let v = idx.get(k); if (v === undefined) { v = pts.length; pts.push([x * vs, y * vs, z * vs]); idx.set(k, v); } return v; };
  const quad = (a: number, b: number, c: number, d: number) => { tris.push(a, b, c, a, c, d); };
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) for (let k = 0; k < N; k++) {
    if (!solid(i, j, k)) continue;
    if (!solid(i + 1, j, k)) quad(P(i + 1, j, k), P(i + 1, j + 1, k), P(i + 1, j + 1, k + 1), P(i + 1, j, k + 1));
    if (!solid(i - 1, j, k)) quad(P(i, j, k), P(i, j, k + 1), P(i, j + 1, k + 1), P(i, j + 1, k));
    if (!solid(i, j + 1, k)) quad(P(i, j + 1, k), P(i, j + 1, k + 1), P(i + 1, j + 1, k + 1), P(i + 1, j + 1, k));
    if (!solid(i, j - 1, k)) quad(P(i, j, k), P(i + 1, j, k), P(i + 1, j, k + 1), P(i, j, k + 1));
    if (!solid(i, j, k + 1)) quad(P(i, j, k + 1), P(i + 1, j, k + 1), P(i + 1, j + 1, k + 1), P(i, j + 1, k + 1));
    if (!solid(i, j, k - 1)) quad(P(i, j, k), P(i, j + 1, k), P(i + 1, j + 1, k), P(i + 1, j, k));
  }
  return { pts, tris };
}

describe('formSdf on a hollow', () => {
  const g = gridOver([-0.2, -0.2, -0.2], [1.2, 1.2, 1.2], 0.05);

  it('air behind a narrow mouth is outside', () => {
    const { pts, tris } = hollowBox(0.1, true);
    const d = meshSdf(g, pts, tris);
    expect(sampleGrid(g, d, [0.5, 0.5, 0.5])).toBeGreaterThan(0.2); // the cavity's centre, 0.3 from its walls
    expect(sampleGrid(g, d, [0.5, 0.5, 0.9])).toBeGreaterThan(0); // in the chimney
    expect(sampleGrid(g, d, [0.1, 0.5, 0.5])).toBeLessThan(-0.05); // in the wall
    expect(sampleGrid(g, d, [-0.1, 0.5, 0.5])).toBeGreaterThan(0.05); // beside it
  });

  it('a sealed cavity is still inside', () => {
    const { pts, tris } = hollowBox(0.1, false);
    const d = meshSdf(g, pts, tris);
    expect(sampleGrid(g, d, [0.5, 0.5, 0.5])).toBeLessThan(0);
    expect(sampleGrid(g, d, [-0.1, 0.5, 0.5])).toBeGreaterThan(0.05);
  });
});
