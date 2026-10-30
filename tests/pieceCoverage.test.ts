// Surface no convex piece covers (utils/pieceCoverage.ts): the fault the
// narrowing figure cannot show, because nothing stands proud. A carved sculpt
// lost every piece under its lower half and sank 27 mm into the floor, and a
// lathed funnel's spout was a ring of wedges round a hole a ball jammed in;
// both reported nothing.

import { describe, expect, it } from 'vitest';
import { uncoveredSurface } from '../src/utils/pieceCoverage';
import { boxMesh } from './helpers/meshes';

const hull = (c: [number, number, number], h: [number, number, number]) => ({ ...boxMesh(c, h), volume: 8 * h[0] * h[1] * h[2], centroid: [...c] });

describe('surface no piece covers', () => {
  const cube = boxMesh([0, 0, 0], [0.025, 0.025, 0.025]);

  it('is nothing when the pieces cover the part', () => {
    const r = uncoveredSurface(cube.verts, cube.faces, [hull([0, 0, -0.0125], [0.025, 0.025, 0.0125]), hull([0, 0, 0.0125], [0.025, 0.025, 0.0125])]);
    expect(r.depth).toBe(0);
    expect(r.at).toBeUndefined();
  });

  it('measures how far below the pieces the bare surface lies, and where', () => {
    // Only the upper half covered, from z = +1.8 mm: the sculpt's pieces.
    const r = uncoveredSurface(cube.verts, cube.faces, [hull([0, 0, 0.0134], [0.025, 0.025, 0.0116])]);
    expect(r.depth).toBeCloseTo(0.0268, 4);
    expect(r.at![2]).toBeCloseTo(-0.025, 6);
  });
});
