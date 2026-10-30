// Every way of giving an extrude its height, as the schema documents them:
// `height`, or `size: [halfHeight]`. A gear meant to be 8 mm thick came out a
// silent 100 mm, because only `size[2]` was read and a one-number size fell
// through to the default.

import { describe, it, expect } from 'vitest';
import { normalizeMeshGeomData } from '../src/utils/geom';

const square = [[-0.01, -0.01], [0.01, -0.01], [0.01, 0.01], [-0.01, 0.01]];

/** Extent along Z of the extruded mesh, from its Z-up vertices. */
function heightOf(geom: Record<string, unknown>): number {
  const g = normalizeMeshGeomData({ ...geom }) as { renderVertices: number[] };
  let lo = Infinity, hi = -Infinity;
  for (let i = 2; i < g.renderVertices.length; i += 3) {
    lo = Math.min(lo, g.renderVertices[i]);
    hi = Math.max(hi, g.renderVertices[i]);
  }
  return +(hi - lo).toFixed(9);
}

describe('extrude height', () => {
  it('reads `height`', () => {
    expect(heightOf({ type: 'extrude', polygon: square, height: 0.008 })).toBe(0.008);
  });

  it('reads `size: [halfHeight]`', () => {
    expect(heightOf({ type: 'extrude', polygon: square, size: [0.004] })).toBe(0.008);
    expect(heightOf({ type: 'prism', polygon: square, size: [0.004] })).toBe(0.008);
  });

  it('`height` wins over size', () => {
    expect(heightOf({ type: 'extrude', polygon: square, height: 0.02, size: [0.004] })).toBe(0.02);
  });

  it('keeps the height when a normalised extrude comes round again', () => {
    const once = normalizeMeshGeomData({ type: 'extrude', polygon: square, size: [0.004] }) as Record<string, unknown>;
    // Its size is now the mesh's half-extents, [hx, hy, hz].
    expect((once.size as number[]).length).toBe(3);
    expect(heightOf(once)).toBe(0.008);
  });

  it('is 0.1 m with neither', () => {
    expect(heightOf({ type: 'extrude', polygon: square })).toBe(0.1);
  });
});
