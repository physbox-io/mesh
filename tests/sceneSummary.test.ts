import { describe, it, expect } from 'vitest';
import { staleBodies, summarizeNode } from '../src/utils/sceneSummary';
import { collisionHashOf } from '../src/utils/convexDecomposition';
import type { SceneGeom, SceneGraph, SceneNode } from '../src/types/scene';
import type { ModelMirror } from '../src/types/sceneLayer';

function body(id: string, geoms: Partial<SceneGeom>[], extra: Partial<SceneNode> = {}): SceneNode {
  return {
    id,
    name: id,
    type: 'body',
    pos: [0, 0, 0],
    geoms: geoms.map((g, i) => ({ name: `${id}_g${i}`, ...g }) as SceneGeom),
    joints: [],
    children: [],
    ...extra,
  };
}

const graph = (nodes: SceneNode[], extra: Partial<SceneGraph> = {}): SceneGraph => ({ nodes, ...extra } as SceneGraph);

/** A closed, outward-wound octahedron, concave enough on no axis to need decomposing. */
const octa = (): Partial<SceneGeom> => ({
  type: 'mesh',
  size: [1],
  dynamic: true,
  renderVertices: [0.01, 0, 0, -0.01, 0, 0, 0, 0.01, 0, 0, -0.01, 0, 0, 0, 0.01, 0, 0, -0.01],
  faces: [0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5],
});

const model = (ids: string[], masses: number[]): ModelMirror => ({
  nq: 0, nv: 0, nu: 0, ngeom: 0, nbody: ids.length + 1, opt: {},
  geom_size: [],
  body_mass: [0, ...masses],
  _idMaps: { body: Object.fromEntries(ids.map((id, i) => [id, i + 1])) },
} as unknown as ModelMirror);

describe('summarizeNode', () => {
  it('reports a decomposition still to run as pending, not as the convex hull', () => {
    const cup = body('cup', [octa()], { collision: 'decompose' });
    const pending = summarizeNode(cup, { model: null });
    expect(pending.collidesAs).toMatch(/pending/);
    expect(pending.collisionPending).toBe(true);

    // Once the verdict has landed (hull, with its hash stamped), it says so.
    const settled = summarizeNode({ ...cup, collision: 'hull', collisionHash: collisionHashOf({ ...cup, collision: 'hull' }) }, { model: null });
    expect(settled.collidesAs).toBe('convex hull');
  });

  it('marks inertial figures from an older build as stale', () => {
    const a = body('a', [{ type: 'box', size: [0.01, 0.01, 0.01] }]);
    const m = model(['a'], [0.008]);
    expect(summarizeNode(a, { model: m }).inertial).toEqual({ massKg: 0.008 });
    expect(summarizeNode(a, { model: m, stale: new Set(['a']) }).inertial).toEqual({ massKg: 0.008, stale: true });
  });
});

describe('staleBodies', () => {
  const a = body('a', [{ type: 'box', size: [0.01, 0.01, 0.01] }]);
  const b = body('b', [{ type: 'sphere', size: [0.02] }]);

  it('is empty when the model was built from this very graph', () => {
    const g = graph([a, b]);
    expect(staleBodies(g, g).size).toBe(0);
  });

  it('names the bodies whose physics changed, and new ones, but not a repaint', () => {
    const built = graph([a, b]);
    const resized = { ...b, geoms: [{ ...b.geoms[0], size: [0.03] }] };
    const repainted = { ...a, geoms: [{ ...a.geoms[0], rgba: [1, 0, 0, 1] }] };
    const added = body('c', [{ type: 'box', size: [0.01, 0.01, 0.01] }]);
    expect([...staleBodies(graph([repainted, resized, added]), built)].sort()).toEqual(['b', 'c']);
  });

  it('treats every body as stale when nothing has been built', () => {
    expect(staleBodies(graph([a, b]), null).size).toBe(2);
  });
});
