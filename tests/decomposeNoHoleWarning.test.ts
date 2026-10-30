// collision 'decompose' on a body with no negative shape at all (a threaded
// rod, positive only) was told "the negative shape is not elongated". The
// warning now says what is true of the body it is about.

import { describe, it, expect, vi } from 'vitest';
import { evaluateNodeCsg } from '../src/utils/csg';
import type { SceneNode } from '../src/types/scene';

vi.mock('../src/utils/openscad', () => ({
  compileSCAD: vi.fn(),
  setScadCompileListener: vi.fn(),
}));

const ZUP = [
  -0.01, -0.01, 0, 0.01, -0.01, 0, 0.01, 0.01, 0, -0.01, 0.01, 0,
  -0.01, -0.01, 0.01, 0.01, -0.01, 0.01, 0.01, 0.01, 0.01, -0.01, 0.01, 0.01,
];
const FACES = [
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
  0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
  2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
];
const yup = (z: number[]) => z.flatMap((_, i) => (i % 3 === 0 ? [z[i], z[i + 2], -z[i + 1]] : []));

describe("'decompose' with nothing to slice round", () => {
  it('says the body has no negative shape, not that its negative shape is round', async () => {
    const openscad = await import('../src/utils/openscad');
    vi.mocked(openscad.compileSCAD).mockResolvedValueOnce({ vertices: yup(ZUP), renderVertices: ZUP, faces: FACES });
    const node: SceneNode = {
      id: 'rod', name: 'rod', type: 'body', pos: [0, 0, 0], joints: [], children: [],
      csgEnabled: true, csgCollision: 'decompose',
      geoms: [{ name: 'r', type: 'cylinder', size: [0.004, 0.02], thread: { pitch: 0.00125 } } as SceneNode['geoms'][number]],
    };
    const res = await evaluateNodeCsg(node);
    expect(res!.warning).toMatch(/has no negative shape/);
    expect(res!.warning).not.toMatch(/not elongated/);
  });
});
