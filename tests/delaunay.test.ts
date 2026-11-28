// Delaunay of a piece's points (meshOutline's): the same triangles as the
// quadratic Bowyer-Watson it replaced, and fast at the sizes a fine sheet
// reaches (23.6k points took 29 s).

import { describe, it, expect } from 'vitest';
import { delaunay } from '../src/utils/cloth/delaunay';
import { delaunayReference, distToPolyReference, insideReference } from './delaunayReference';
import { meshOutline } from '../src/utils/cloth/clothMesh';

const canon = (tris: number[]) => {
  const out: string[] = [];
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris.slice(t, t + 3);
    const k = a.indexOf(Math.min(...a));
    out.push([a[k], a[(k + 1) % 3], a[(k + 2) % 3]].join(','));
  }
  return out.sort();
};
const square = (L: number) => [
  { id: 'a', pts: [[0, 0], [L, 0]] }, { id: 'b', pts: [[L, 0], [L, L]] },
  { id: 'c', pts: [[L, L], [0, L]] }, { id: 'd', pts: [[0, L], [0, 0]] },
] as Parameters<typeof meshOutline>[0];

describe('delaunay', () => {
  it('makes the same triangles as the reference', () => {
    let seed = 3;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const scattered = Array.from({ length: 800 }, () => [rand(), rand()] as [number, number]);
    expect(canon(delaunay(scattered))).toEqual(canon(delaunayReference(scattered)));
    const lattice = meshOutline(square(0.5), 0.02).uv as [number, number][];
    expect(canon(delaunay(lattice))).toEqual(canon(delaunayReference(lattice)));
    const blob = meshOutline([{ id: 'r', pts: Array.from({ length: 41 }, (_, k) => { const a = (2 * Math.PI * k) / 40; return [0.3 * Math.cos(a) * (1 + 0.3 * Math.sin(3 * a)), 0.2 * Math.sin(a)]; }) }], 0.012).uv as [number, number][];
    expect(canon(delaunay(blob))).toEqual(canon(delaunayReference(blob)));
  });

  it('meshOutline keeps the same points and triangles as testing every edge', () => {
    const outline = Array.from({ length: 60 }, (_, k) => { const a = (2 * Math.PI * k) / 60; return [0.3 * Math.cos(a) * (1 + 0.3 * Math.sin(3 * a)), 0.2 * Math.sin(a) + 0.05 * Math.cos(5 * a)] as [number, number]; });
    const step = 0.01;
    const m = meshOutline(outline.map((q, k) => ({ id: `s${k}`, pts: [q, outline[(k + 1) % outline.length]] })), step);
    const ring = m.uv.slice(0, Object.values(m.edgeVerts).reduce((s, e) => s + e.length - 1, 0));
    // The lattice as meshOutline lays it, filtered the old way.
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const [u, v] of ring) { minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v); }
    const want = ring.slice();
    const dv = (step * Math.sqrt(3)) / 2;
    for (let row = 0, v = minV + dv / 2; v < maxV; v += dv, row++) for (let u = minU + (row % 2 ? step / 2 : 0); u < maxU; u += step) {
      if (insideReference(ring, [u, v]) && distToPolyReference(ring, [u, v]) > step * 0.55) want.push([u, v]);
    }
    expect(m.uv).toEqual(want);
    const kept: number[] = [];
    const all = delaunayReference(want);
    for (let t = 0; t < all.length; t += 3) {
      const [a, b, c] = [all[t], all[t + 1], all[t + 2]];
      if (!insideReference(ring, [(want[a][0] + want[b][0] + want[c][0]) / 3, (want[a][1] + want[b][1] + want[c][1]) / 3])) continue;
      const cross = (want[b][0] - want[a][0]) * (want[c][1] - want[a][1]) - (want[c][0] - want[a][0]) * (want[b][1] - want[a][1]);
      if (Math.abs(cross) / 2 < 0.05 * step * step) continue;
      if (cross > 0) kept.push(a, b, c); else kept.push(a, c, b);
    }
    expect(canon(m.tris)).toEqual(canon(kept));
  });

  it('is fast on a fine sheet', () => {
    const t = performance.now();
    const m = meshOutline(square(1), 0.007);
    expect(m.uv.length).toBeGreaterThan(20_000);
    expect(m.tris.length / 3).toBeGreaterThan(40_000);
    expect(performance.now() - t).toBeLessThan(5_000);
  });
});
