// A dense import collides as a simplified copy of its mesh. Any store write
// that changes the mesh (a rescale, Simplify, a repair, a sculpt) used to leave
// the copy at the old shape; the set middleware now rebuilds it
// (store/denseColliders.ts).
import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../src/store/useStore';
import { denseCollidersSettled, withFreshDenseColliders } from '../src/store/denseColliders';
import { colliderCopyOf, meshFingerprint, simplifierReady } from '../src/utils/denseMesh';
import { scaleNodeTree } from '../src/utils/scaleNode';
import type { SceneGeom, SceneGraph, SceneNode } from '../src/types/scene';

/** A closed torus, Z-up, of 2·nu·nv triangles. */
function torus(nu: number, nv: number, R = 0.05, r = 0.02) {
  const vertices: number[] = [];
  const faces: number[] = [];
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const u = (i / nu) * 2 * Math.PI;
      const w = (j / nv) * 2 * Math.PI;
      vertices.push((R + r * Math.cos(w)) * Math.cos(u), (R + r * Math.cos(w)) * Math.sin(u), r * Math.sin(w));
    }
  }
  const id = (i: number, j: number) => (i % nu) * nv + (j % nv);
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) faces.push(id(i, j), id(i + 1, j + 1), id(i + 1, j), id(i, j), id(i, j + 1), id(i + 1, j + 1));
  }
  return { vertices, faces };
}

const toYUp = (v: number[]) => v.flatMap((_, i) => (i % 3 ? [] : [v[i], v[i + 2], -v[i + 1]]));

function bounds(v: number[]) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], v[i + k]);
      max[k] = Math.max(max[k], v[i + k]);
    }
  }
  return { min, max };
}

const ringNode = (geom: Partial<SceneGeom>): SceneNode => ({
  id: 'ring', name: 'ring', pos: [0, 0, 0.2], joints: [{ name: 'ring_free', type: 'free' }], children: [],
  geoms: [{ name: 'ring_geom', type: 'mesh', size: [1], dynamic: true, ...geom } as SceneGeom],
});

describe('a dense collider kept in step with its mesh', () => {
  // First, while the simplifier has not loaded in this file.
  it('waits for the simplifier to rebuild a stale copy, then writes the graph again', async () => {
    expect(simplifierReady()).toBe(false);
    const { vertices, faces } = torus(400, 270);
    const graph: SceneGraph = {
      nodes: [ringNode({
        renderVertices: vertices, vertices: toYUp(vertices), faces,
        colliderVertices: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], colliderFaces: [0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2],
        denseColliderOf: 'made from some other mesh',
      })],
    };
    let retried = 0;
    expect(withFreshDenseColliders(graph, () => { retried++; })).toBe(graph);
    await denseCollidersSettled();
    expect(retried).toBe(1);
    const fresh = withFreshDenseColliders(graph, () => { retried++; });
    const g = fresh.nodes[0].geoms[0];
    expect(g.denseColliderOf).toBe(meshFingerprint(vertices, faces));
    expect(g.colliderFaces!.length / 3).toBeLessThanOrEqual(50_000);
    expect(retried).toBe(1);
  });

  describe('through the store', () => {
    const ring = () => useStore.getState().sceneGraph.nodes[0].geoms[0];

    beforeEach(async () => {
      // The store schedules a recompile on window; there is none under Vitest.
      (globalThis as unknown as { window: unknown }).window = globalThis;
      const { vertices, faces } = torus(400, 270);
      const copy = (await colliderCopyOf(vertices, faces))!;
      useStore.setState({
        sceneGraph: {
          nodes: [ringNode({
            renderVertices: vertices, vertices: toYUp(vertices), faces,
            colliderVertices: copy.colliderVertices, colliderFaces: copy.colliderFaces, denseColliderOf: copy.source,
          })],
        } as SceneGraph,
        model: null,
        data: null,
      });
    });

    it('keeps the copy at the new size when the part is rescaled', () => {
      scaleNodeTree('ring', 2, 1, 3);
      const g = ring();
      const drawn = bounds(g.renderVertices!);
      const collides = bounds(g.colliderVertices!);
      for (let k = 0; k < 3; k++) {
        const size = drawn.max[k] - drawn.min[k];
        expect(Math.abs(collides.min[k] - drawn.min[k])).toBeLessThan(size * 0.01);
        expect(Math.abs(collides.max[k] - drawn.max[k])).toBeLessThan(size * 0.01);
      }
      // 2 x 0.14 m across in X, 3 x 0.04 m tall in Z.
      expect(collides.max[0] - collides.min[0]).toBeCloseTo(0.28, 2);
      expect(collides.max[2] - collides.min[2]).toBeCloseTo(0.12, 2);
      expect(g.denseColliderOf).toBe(meshFingerprint(g.renderVertices!, g.faces!));
    });

    it('drops the copy, and the mark, once the mesh is no longer dense', () => {
      const small = torus(60, 40);
      const graph = structuredClone(useStore.getState().sceneGraph);
      Object.assign(graph.nodes[0].geoms[0], { renderVertices: small.vertices, vertices: toYUp(small.vertices), faces: small.faces });
      useStore.getState().updateScene(graph, true);
      const g = ring();
      expect(g.colliderVertices).toBeUndefined();
      expect(g.colliderFaces).toBeUndefined();
      expect(g.denseColliderOf).toBeUndefined();
    });

    it('leaves the copy alone on an edit that does not touch the mesh', () => {
      const before = ring().colliderVertices;
      useStore.getState().renameNode('ring', 'hoop');
      expect(ring().colliderVertices).toBe(before);
    });
  });
});
