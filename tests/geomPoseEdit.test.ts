// Turning or moving one geom inside its body, as the Shape tab's offset and
// rotation sliders do.
//
// A rotation is written as the geom's euler, and a quat already on the geom is
// dropped, since MJCF takes the quat over the euler. A static mesh geom is
// drawn from its vertices as they are, ignoring its own pose, so one given a
// pose goes over to the dynamic path, which draws it where MuJoCo puts it.

import { describe, it, expect, vi, beforeAll } from 'vitest';

const g = globalThis as Record<string, unknown>;
g.window = g;
g.document = { visibilityState: 'hidden' };
g.alert = () => {};
vi.hoisted(() => { (globalThis as { navigator?: unknown }).navigator ??= { hardwareConcurrency: 2 }; });

vi.mock('../src/store/physicsWorkerClient', () => {
  class PhysicsWorkerClient {
    meshFiles = undefined;
    onFrame = null; onBreak = null; onImpact = null; onError = null;
    build() { return Promise.resolve({ ok: true }); }
    setEnv() {} setPlaying() {} resume() {} tick() {} terminate() {}
    hasPendingWork() { return false; }
  }
  return { PhysicsWorkerClient };
});

import { compileToMJCF } from '../src/utils/mjcf';
import { promotePosedStaticMeshes } from '../src/store/meshGeomTransforms';
import type { SceneNode, SceneGeom } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
let useStore: any;
beforeAll(async () => { ({ useStore } = await import('../src/store/useStore')); });

// A unit tetrahedron, Y-up, as a static mesh geom stores it.
const tetra = (extra: Partial<SceneGeom> = {}): SceneGeom => ({
  name: 'tet', type: 'mesh', size: [1],
  vertices: [0, 0, 0, 0.02, 0, 0, 0, 0.02, 0, 0, 0, 0.02],
  faces: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
  ...extra,
} as SceneGeom);

const body = (geoms: SceneGeom[]): SceneNode => ({
  id: 'part', name: 'part', pos: [0, 0, 0.1], children: [], joints: [], geoms,
} as SceneNode);

const geomTag = (xml: string, name: string) => xml.match(new RegExp(`<geom name="${name}"[^>]*>`))?.[0] ?? '';

describe('editing one geom\'s rotation', () => {
  it('writes euler and drops a quat that would otherwise win in the MJCF', () => {
    useStore.getState().updateScene({ nodes: [body([
      { name: 'a', type: 'box', size: [0.01, 0.01, 0.01], quat: [0.7071, 0.7071, 0, 0] },
      { name: 'b', type: 'box', size: [0.01, 0.01, 0.01], pos: [0.03, 0, 0] },
    ] as SceneGeom[])] }, true);
    useStore.getState().updateNodeGeom('part', { euler: [0, 45, 0], quat: undefined }, 0);
    const geom = useStore.getState().sceneGraph.nodes[0].geoms[0];
    expect(geom.euler).toEqual([0, 45, 0]);
    expect(geom.quat).toBeUndefined();
    const tag = geomTag(compileToMJCF(useStore.getState().sceneGraph), 'a');
    expect(tag).toContain('euler="0 45 0"');
    expect(tag).not.toContain('quat=');
  });
});

describe('promotePosedStaticMeshes', () => {
  it('moves a static mesh with a pose of its own onto the dynamic path', () => {
    const node = body([tetra({ euler: [0, 0, 30] })]);
    promotePosedStaticMeshes(node);
    const g0 = node.geoms[0];
    expect(g0.dynamic).toBe(true);
    // Y-up to Z-up: (x, y, z) -> (x, -z, y).
    expect(g0.renderVertices).toEqual([0, -0, 0, 0.02, -0, 0, 0, -0, 0.02, 0, -0.02, 0]);
  });

  it('leaves a static mesh with no pose of its own, and a zero pose, alone', () => {
    for (const extra of [{}, { pos: [0, 0, 0], euler: [0, 0, 0] }]) {
      const node = body([tetra(extra)]);
      promotePosedStaticMeshes(node);
      expect(node.geoms[0].dynamic).toBeFalsy();
    }
  });

  it('is applied when the inspector moves a static mesh geom', () => {
    useStore.getState().updateScene({ nodes: [body([tetra()])] }, true);
    useStore.getState().updateNodeGeom('part', { pos: [0.01, 0, 0] }, 0);
    expect(useStore.getState().sceneGraph.nodes[0].geoms[0].dynamic).toBe(true);
  });

  it('is applied when a geom pose arrives through updateNode (MCP)', () => {
    useStore.getState().updateScene({ nodes: [body([tetra()])] }, true);
    useStore.getState().updateNode('part', { geoms: [tetra({ euler: [10, 0, 0] })] });
    expect(useStore.getState().sceneGraph.nodes[0].geoms[0].dynamic).toBe(true);
  });
});
