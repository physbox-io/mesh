// physics_create_lattice answers once the body exists, not after its convex
// pieces.
//
// Five creates in a row: the first timed out at the hub's 60 s and the body
// was there afterwards, so a retrying agent made a duplicate. The handler went
// through settleScene, which waited up to 25 s for V-HACD (one job at a time,
// queued behind every other body's) and then rebuilt the model. Here the
// decomposer is a stand-in that takes far longer than the reply may.

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneGeom, SceneNode } from '../src/types/scene';

const SLOW_MS = 400;

vi.mock('../src/utils/convexDecomposition', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/utils/convexDecomposition')>();
  return {
    ...real,
    // Every body counts as needing pieces, so the decomposition is always asked for.
    collidersAreStale: (node: SceneNode) => !!node.isLattice && !(node.geoms || []).some(g => g.csgDerived === 'collider'),
    decomposeNodeColliders: async (node: SceneNode) => {
      await new Promise(r => setTimeout(r, SLOW_MS));
      const geoms: SceneGeom[] = [{
        name: `${node.name}_csg_col0`, type: 'mesh', size: [1], csgDerived: 'collider',
        vertices: [0, 0, 0, 0.01, 0, 0, 0, 0.01, 0, 0, 0, 0.01], faces: [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3],
      }];
      return {
        hash: real.collisionHashOf(node), geoms, volume: 1e-5, hullVolume: 3e-5, mass: 0.01,
        verdict: { strategy: 'decompose', solidity: 0.3, triangles: 12, maxHulls: 1, reason: 'concave' },
      };
    },
  };
});

// No OpenSCAD body in the scene; its worker pool needs a browser.
vi.mock('../src/utils/openscad', () => ({ compileSCAD: async () => { throw new Error('not in this test'); } }));

const { useStore } = await import('../src/store/useStore');
const { latticeCommands } = await import('../src/hooks/mcp/latticeCommands');

describe('CREATE_LATTICE', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: unknown }).window = globalThis;
    useStore.setState({ sceneGraph: { nodes: [] }, recompile: async () => {}, lastCompileError: null });
  });
  afterAll(() => { delete (globalThis as { window?: unknown }).window; });

  it('replies with the body before its convex pieces land, and they land after', async () => {
    const recompiled = vi.fn(async () => {});
    useStore.setState({ recompile: recompiled });
    const t0 = Date.now();
    const reply = await latticeCommands.CREATE_LATTICE(
      { name: 'Leg', ops: [{ op: 'extrude', face: [[-20, -20, 20], [20, -20, 20], [20, 20, 20], [-20, 20, 20]], distanceMm: 380 }] },
      { store: useStore.getState(), toId: (v) => v },
    ) as { ok: boolean; id: string };
    expect(Date.now() - t0).toBeLessThan(SLOW_MS);
    expect(reply.ok).toBe(true);
    const body = () => useStore.getState().sceneGraph.nodes.find(n => n.id === reply.id)!;
    expect(body()).toBeDefined();
    expect(body().geoms.some(g => g.csgDerived === 'collider')).toBe(false);

    await new Promise(r => setTimeout(r, SLOW_MS + 100));
    expect(body().geoms.some(g => g.csgDerived === 'collider')).toBe(true);
    expect(recompiled.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
