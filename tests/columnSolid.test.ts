import { describe, it, expect } from 'vitest';
import { castColumnSpans } from '../src/utils/columnSolid';

/** A closed axis-aligned box as an outward-wound triangle soup, mm. */
function boxSoup(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] {
  const p = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const out: number[] = [];
  for (const [a, b, c, d] of quads) out.push(...p[a], ...p[b], ...p[c], ...p[a], ...p[c], ...p[d]);
  return out;
}

describe('castColumnSpans', () => {
  it('reads a boss standing on the same floor as its plate at its full height', () => {
    // Two separate meshes, both from z = 0: the boss's entry coincides with
    // the plate's. Counting it once read the boss as plate-high.
    const tris = Float64Array.from([...boxSoup(-30, -30, 0, 30, 30, 5), ...boxSoup(-5, -5, 0, 5, 5, 20)]);
    const sp = castColumnSpans(tris, { minX: -2, minY: -2, stepX: 1, stepY: 1, cols: 5, rows: 5 });
    for (let k = 0; k < 25; k++) expect(Array.from(sp.z.slice(sp.offset[k], sp.offset[k + 1]))).toEqual([0, 20]);
  });

  it('still counts a ray down an edge two triangles of one mesh share once', () => {
    // Columns on the box's top-face diagonal cross the shared edge of its two triangles.
    const tris = Float64Array.from(boxSoup(0, 0, 0, 10, 10, 4));
    const sp = castColumnSpans(tris, { minX: 0, minY: 0, stepX: 1, stepY: 1, cols: 11, rows: 11 });
    for (let k = 0; k < 121; k++) {
      const spans = Array.from(sp.z.slice(sp.offset[k], sp.offset[k + 1]));
      expect(spans).toHaveLength(2);
      expect(spans[0]).toBeCloseTo(0, 6);
      expect(spans[1]).toBeCloseTo(4, 6);
    }
  });
});
