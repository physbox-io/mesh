// No body is decomposed twice at once for the same shape.
//
// Four SCAD nesting bowls over MCP: physics_run_headless reported contacts
// with bowl1_csg_col55 and bowl2_csg_col45, and the scene then settled with
// bowl1 at 15 pieces and bowl2 at 14, their cavities filled. A compile pass
// decomposes every stale body; the first to land changes the scene, the effect
// schedules another pass, and the bodies still being decomposed are still
// stale — so they were decomposed again, and whichever run finished last was
// installed, since both carried the right hash. Here the decomposer is a
// stand-in whose first run of a body is the good one and any second the bad.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneGeom, SceneNode } from '../src/types/scene';
import { cupMesh, zupToYupFlat } from './helpers/meshes';

const calls = new Map<string, number>();

vi.mock('../src/utils/convexDecomposition', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/utils/convexDecomposition')>();
  return {
    ...real,
    decomposeNodeColliders: async (node: SceneNode) => {
      const n = (calls.get(node.id) ?? 0) + 1;
      calls.set(node.id, n);
      const hash = real.collisionHashOf(node);
      // The first body is quick, the second slow: the first lands while the second is still running.
      await new Promise(r => setTimeout(r, node.id === 'bowl1' ? 20 : 200));
      const pieces = n === 1 ? 55 : 15;
      const geoms: SceneGeom[] = Array.from({ length: pieces }, (_, i) => ({
        name: `${node.name}_csg_col${i}`, type: 'mesh', size: [1], csgDerived: 'collider',
        vertices: [0, 0, 0, 0.01, 0, 0, 0, 0.01, 0, 0, 0, 0.01], faces: [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3],
      }));
      return {
        hash, geoms, volume: 1e-5, hullVolume: 3e-5, mass: 0.01,
        verdict: { strategy: 'decompose', solidity: 0.3, triangles: 100, maxHulls: pieces, reason: 'concave' },
      };
    },
  };
});

const { useStore } = await import('../src/store/useStore');
const { compileCsgNodes, collidersBeingDecomposed, pendingColliderBodies } = await import('../src/hooks/useCsgCompile');

const bowl = (id: string): SceneNode => {
  const m = cupMesh({ outerR: 0.05, innerR: 0.045, height: 0.04, baseThickness: 0.004 });
  return {
    id, name: id, type: 'body', pos: [0, 0, 0], joints: [], children: [],
    geoms: [{ name: `${id}_m`, type: 'mesh', size: [1], dynamic: true, renderVertices: m.verts, vertices: zupToYupFlat(m.verts), faces: m.faces }],
  } as SceneNode;
};

const pieces = (id: string) => (useStore.getState().sceneGraph.nodes.find(n => n.id === id)!.geoms || [])
  .filter(g => g.csgDerived === 'collider').length;

describe('two compile passes over the same stale bodies', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: unknown }).window = globalThis;
    calls.clear();
    useStore.setState({ sceneGraph: { nodes: [bowl('bowl1'), bowl('bowl2')] }, recompile: async () => {} });
  });
  afterAll(() => { delete (globalThis as { window?: unknown }).window; });

  it('decomposes each body once, and keeps the run that was asked for first', async () => {
    const first = compileCsgNodes(true);
    // bowl1 lands at 20 ms and changes the scene; the effect schedules the next pass.
    await new Promise(r => setTimeout(r, 60));
    expect(pieces('bowl1')).toBe(55);
    expect(collidersBeingDecomposed()).toEqual(['bowl2']);
    // What physics_run_headless and a scene build wait on.
    expect(pendingColliderBodies()).toEqual(['bowl2']);
    const second = compileCsgNodes(true);
    await Promise.all([first, second]);

    expect(calls.get('bowl2')).toBe(1);
    expect(pieces('bowl2')).toBe(55);
    expect(collidersBeingDecomposed()).toEqual([]);
    expect(pendingColliderBodies()).toEqual([]);
  });

  it('a pass with a deadline answers without pieces still being worked out, and they land after', async () => {
    const recompiled = vi.fn(async () => {});
    useStore.setState({ recompile: recompiled });
    const t0 = Date.now();
    await compileCsgNodes(true, { colliderWaitMs: 50 });
    expect(Date.now() - t0).toBeLessThan(150);
    expect(pieces('bowl2')).toBe(0);
    await new Promise(r => setTimeout(r, 250));
    expect(pieces('bowl2')).toBe(55);
    expect(recompiled).toHaveBeenCalled();
  });
});
