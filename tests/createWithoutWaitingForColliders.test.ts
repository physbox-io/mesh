// Adding a body does not wait for every stale body's convex decomposition.
//
// physics_create_lattice settled the scene through compileCsgNodes, which also
// ran V-HACD on every body whose colliders were stale, and the V-HACD worker
// runs one job at a time. In a burst of five creates the fourth waited on the
// others' decompositions, timed out at 60 s, and its body existed anyway, so a
// retry made it twice. Creation now leaves decomposition to the background
// compiler and says collisionPending.

import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../src/store/useStore';
import { compileCsgNodes } from '../src/hooks/useCsgCompile';
import { collidersAreStale } from '../src/utils/convexDecomposition';
import { createLattice, deserializeCage, serializeCage, toSceneGeom, DEFAULT_UNIT } from '../src/utils/latticeMesh';
import { runLatticeOps } from '../src/hooks/mcp/latticeState';
import type { SceneGraph } from '../src/types/scene';

/** A U: a floor and two walls, far from convex. */
function uShape() {
  const lattice = createLattice(DEFAULT_UNIT);
  const box = (x0: number, x1: number, z0: number, z1: number) => [
    [[x0, -20, z0], [x0, 20, z0], [x1, 20, z0], [x1, -20, z0]],
    [[x0, -20, z1], [x1, -20, z1], [x1, 20, z1], [x0, 20, z1]],
    [[x0, -20, z0], [x1, -20, z0], [x1, -20, z1], [x0, -20, z1]],
    [[x0, 20, z0], [x0, 20, z1], [x1, 20, z1], [x1, 20, z0]],
    [[x0, -20, z0], [x0, -20, z1], [x0, 20, z1], [x0, 20, z0]],
    [[x1, -20, z0], [x1, 20, z0], [x1, 20, z1], [x1, -20, z1]],
  ];
  runLatticeOps(lattice, [{ op: 'faces', faces: [...box(-60, 60, 0, 10), ...box(-60, -50, 10, 80), ...box(50, 60, 10, 80)] }]);
  return toSceneGeom(deserializeCage(serializeCage(lattice)), 0, 0);
}

describe('settling a scene without its colliders', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: unknown }).window = globalThis;
    const { vertices, renderVertices, faces } = uShape();
    const graph = {
      nodes: [{
        id: 'u', name: 'u', type: 'body', pos: [0, 0, 0.3], joints: [{ name: 'u_free', type: 'free' }], children: [],
        geoms: [{ name: 'u_mesh', type: 'mesh', size: [1], dynamic: true, vertices, renderVertices, faces }],
      }],
    } as unknown as SceneGraph;
    useStore.setState({ sceneGraph: graph, model: null, data: null, undoStack: [] });
  });

  it('returns without decomposing, leaving the body pending', async () => {
    const node = () => useStore.getState().sceneGraph.nodes[0];
    expect(collidersAreStale(node())).toBe(true);
    const started = Date.now();
    await compileCsgNodes(true, { colliders: false });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(collidersAreStale(node())).toBe(true);
    expect(node().geoms.some((g) => g.csgDerived === 'collider')).toBe(false);
  });
});
