import { describe, it, expect } from 'vitest';
import { isFabricationScene, staleBodies, summarizeGeom, summarizeNode } from '../src/utils/sceneSummary';
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

describe('summarizeGeom', () => {
  it('carries fromto, so a capsule written end to end does not read as a stub pill', () => {
    const s = summarizeGeom({ name: 'spoke', type: 'capsule', size: [0.0012], fromto: [0, 0, 0, 0.15, 0, 0] } as SceneGeom);
    expect(s).toMatchObject({ type: 'capsule', size: [0.0012], fromto: [0, 0, 0, 0.15, 0, 0] });
  });

  it('rounds float noise to the micron', () => {
    const s = summarizeGeom({ name: 'b', type: 'box', size: [0.1 + 0.2, 0.01, 0.01], pos: [1 / 3, 0, 0] } as SceneGeom);
    expect(s.size).toEqual([0.3, 0.01, 0.01]);
    expect(s.pos).toEqual([0.333333, 0, 0]);
  });
});

describe('summarizeNode', () => {
  it('summarises a curve track instead of listing every segment box', () => {
    const segs = Array.from({ length: 64 }, (_, i) => ({ type: 'box' as const, size: [0.01, 0.25, 0.03], pos: [i * 0.05, 0, 0] }));
    const s = summarizeNode(body('track', segs, { isCurve: true, curvePoints: [[0, 0, 0], [1, 0, 0]], curveWidth: 0.5 }), { model: null });
    expect(s.geoms).toEqual([]);
    expect(s.curve).toMatchObject({ segments: 64, controlPoints: 2, widthMm: 500 });
    expect(summarizeNode(body('track', segs, { isCurve: true }), { model: null, full: true }).geoms).toHaveLength(64);
  });

  it('counts convex-piece colliders rather than listing them', () => {
    const cols = Array.from({ length: 12 }, (_, i) => ({ ...octa(), name: `cup_mesh_csg_col${i}`, csgDerived: 'collider' as const, role: 'collision' as const }));
    const s = summarizeNode(body('cup', [{ ...octa(), name: 'cup_mesh' }, ...cols]), { model: null });
    expect((s.geoms as unknown[]).length).toBe(1);
    expect(s.colliderGeoms).toBe(12);
  });

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

describe('isFabricationScene', () => {
  const hinge = [{ name: 'h', type: 'hinge' as const, axis: [0, 0, 1] }];
  const free = [{ name: 'f', type: 'free' as const }];

  it('is a mechanism once anything is hinged, and leaves the stock out', () => {
    const wheel = body('wheel', [{ type: 'cylinder', size: [0.1, 0.01] }], { joints: hinge });
    expect(isFabricationScene(graph([body('tower', [], { children: [wheel] })]), null)).toBe(false);
  });

  it('is fabrication for loose parts, carve settings or print fidelity', () => {
    expect(isFabricationScene(graph([body('part', [], { joints: free })]), null)).toBe(true);
    const wheel = body('wheel', [], { joints: hinge });
    expect(isFabricationScene(graph([wheel]), { depthMm: 3 })).toBe(true);
    expect(isFabricationScene(graph([wheel], { simFidelity: 'print' }), null)).toBe(true);
  });

  it('is an experiment, not fabrication, for a free part launched, shattering or otherwise set up to simulate', () => {
    const block = [{ type: 'box' as const, size: [0.02, 0.02, 0.02] }];
    expect(isFabricationScene(graph([body('part', block, { joints: free })]), null)).toBe(true);
    const launched = body('ball', block, { joints: [{ ...free[0], initialVelocity: [0, 0, 0, 0, 0, 0] }] });
    expect(isFabricationScene(graph([launched]), null)).toBe(true);
    const thrown = body('ball', block, { joints: [{ ...free[0], initialVelocity: [2, 0, 0, 0, 0, 0] }] });
    expect(isFabricationScene(graph([thrown]), null)).toBe(false);
    const vase = body('vase', block, { joints: free, shatterImpulseNs: 8 });
    expect(isFabricationScene(graph([vase]), null)).toBe(false);
    const plate = body('plate', [{ ...block[0], dentYieldNs: 6 }], { joints: free });
    expect(isFabricationScene(graph([plate]), null)).toBe(false);
    const scripted = body('bot', block, { joints: free, script: 'ctrl[0] = 1' });
    expect(isFabricationScene(graph([body('bench', block), scripted]), null)).toBe(false);
    const nested = body('blob', block, { joinMaterial: 'putty' });
    expect(isFabricationScene(graph([body('bench', block, { children: [nested] })]), null)).toBe(false);
  });

  it('is fabrication again for an experiment with carve settings or print fidelity', () => {
    const vase = body('vase', [], { joints: [{ ...free[0], initialVelocity: [2, 0, 0, 0, 0, 0] }], shatterImpulseNs: 8 });
    expect(isFabricationScene(graph([vase]), { depthMm: 3 })).toBe(true);
    expect(isFabricationScene(graph([vase], { simFidelity: 'print' }), null)).toBe(true);
  });
});

describe('isFabricationScene: loose bodies in the air', () => {
  const free = [{ name: 'f', type: 'free' as const }];
  const cube = [{ type: 'box' as const, size: [0.02, 0.02, 0.02] }];

  it('is an experiment, not fabrication, when a free body starts in the air on nothing', () => {
    const dropped = body('cube', cube, { joints: free, pos: [0, 0, 0.5] });
    expect(isFabricationScene(graph([dropped]), null)).toBe(false);
  });

  it('is fabrication for a part on the floor or stacked on another', () => {
    const base = body('base', cube, { joints: free, pos: [0, 0, 0.02] });
    const lid = body('lid', cube, { joints: free, pos: [0, 0, 0.06] });
    expect(isFabricationScene(graph([base, lid]), null)).toBe(true);
  });

  it('carve settings still win', () => {
    const dropped = body('cube', cube, { joints: free, pos: [0, 0, 0.5] });
    expect(isFabricationScene(graph([dropped]), { depthMm: 3 })).toBe(true);
  });
});
