import { describe, it, expect, vi } from 'vitest';
import { evaluateNodeCsg } from '../src/utils/csg';
import type { SceneNode } from '../src/types/scene';

vi.mock('../src/utils/openscad', () => ({
  compileSCAD: vi.fn(),
  setScadCompileListener: vi.fn(),
}));

// A 30 x 20 x 10 mm block sitting off to one side of the body origin, x 20..50 mm.
const ZUP = [
  0.02, -0.01, 0, 0.05, -0.01, 0, 0.05, 0.01, 0, 0.02, 0.01, 0,
  0.02, -0.01, 0.01, 0.05, -0.01, 0.01, 0.05, 0.01, 0.01, 0.02, 0.01, 0.01,
];
const FACES = [
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
  0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
  2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
];
const yup = (z: number[]) => z.flatMap((_, i) => (i % 3 === 0 ? [z[i], z[i + 2], -z[i + 1]] : []));

// A compiled boolean was re-origined on its centroid in X and Y while its body
// stayed put, so a part moved by that much as soon as it was cut: a bracket
// built flush against a wall was drawn and collided 10 mm off it.
describe('a compiled boolean', () => {
  it('stays where its shapes were authored', async () => {
    const openscad = await import('../src/utils/openscad');
    vi.mocked(openscad.compileSCAD).mockResolvedValueOnce({ vertices: yup(ZUP), renderVertices: ZUP, faces: FACES });
    const node: SceneNode = {
      id: 'block', name: 'block', type: 'body', pos: [0, 0, 0], joints: [], children: [],
      csgEnabled: true, csgCollision: 'hull',
      geoms: [
        { name: 'b', type: 'box', size: [0.015, 0.01, 0.005], pos: [0.035, 0, 0.005] },
        { name: 'hole', type: 'cylinder', size: [0.002, 0.01], pos: [0.03, 0, 0.005], csg: 'difference' },
      ],
    };
    const res = await evaluateNodeCsg(node);
    expect(res!.centroid).toEqual([0, 0, 0]);
    const visual = res!.geoms.find((g) => g.csgDerived === 'visual')!;
    expect(visual.renderVertices).toEqual(ZUP);
  });
});

/** A closed prism over a counter-clockwise outline (metres), z 0..h. */
function prism(outline: number[][], h: number) {
  const n = outline.length;
  const zup = [...outline.flatMap(([x, y]) => [x, y, 0]), ...outline.flatMap(([x, y]) => [x, y, h])];
  const faces: number[] = [];
  // A fan from corner 0, which sees every other corner of this outline.
  for (let i = 1; i + 1 < n; i++) faces.push(0, i + 1, i, n, n + i, n + i + 1);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push(i, j, n + j, i, n + j, n + i);
  }
  return { zup, faces };
}

// A part with a pocket collided as its uncut primitives: the pocket was
// solid. Only a cut right through, with an axis to slice round, was handled.
describe('a boolean with no hole axis', () => {
  it('collides as its own solid, not as the primitives it was cut from', async () => {
    const openscad = await import('../src/utils/openscad');
    // A 30 x 20 x 10 mm block with a 10 mm square notch out of one corner.
    const L = prism([[0, 0], [0.03, 0], [0.03, 0.01], [0.02, 0.01], [0.02, 0.02], [0, 0.02]], 0.01);
    vi.mocked(openscad.compileSCAD).mockResolvedValueOnce({ vertices: yup(L.zup), renderVertices: L.zup, faces: L.faces });
    const node: SceneNode = {
      id: 'notched', name: 'notched', type: 'body', pos: [0, 0, 0], joints: [], children: [],
      csgEnabled: true,
      geoms: [
        { name: 'b', type: 'box', size: [0.015, 0.01, 0.005], pos: [0.015, 0.01, 0.005] },
        // A blind pocket: it goes through nothing, so there is no axis to
        // slice round, unlike a bore. (The mocked solid stands in for it.)
        { name: 'pocket', type: 'box', size: [0.0055, 0.0055, 0.003], pos: [0.025, 0.015, 0.008], csg: 'difference' },
      ],
    };
    const res = await evaluateNodeCsg(node);
    expect(res!.mode).toBe('decompose');
    const colliders = res!.geoms.filter((g) => g.csgDerived === 'collider');
    expect(colliders.length).toBeGreaterThanOrEqual(2);
  }, 60000);
});

