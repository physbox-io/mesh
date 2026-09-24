// A sculpt cut in two becomes two bodies.
//
// While the pieces of a cut were one mesh on one body, none of them could be
// deleted on its own, and a brush on one reached across the gap and dragged
// the other along too. separateSculpt gives each piece a body of its own.

import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../src/store/useStore';
import { compileToMJCF } from '../src/utils/mjcf';
import { icosphere, splitComponents, toSceneGeom, createSculptMesh } from '../src/utils/sculptMesh';
import type { SceneGraph, SceneNode } from '../src/types/scene';

/** Two separate balls in one mesh, 0.3 m apart along X. */
function twoBalls() {
  const a = icosphere(0.05, 2);
  const b = icosphere(0.08, 2);
  const positions: number[] = [];
  const faces: number[] = [];
  for (let i = 0; i < a.vertexCount * 3; i++) positions.push(a.positions[i] + (i % 3 === 0 ? -0.15 : 0));
  for (let i = 0; i < a.faceCount * 3; i++) faces.push(a.faces[i]);
  for (let i = 0; i < b.vertexCount * 3; i++) positions.push(b.positions[i] + (i % 3 === 0 ? 0.15 : 0));
  for (let i = 0; i < b.faceCount * 3; i++) faces.push(b.faces[i] + a.vertexCount);
  return createSculptMesh(positions, faces);
}

const find = (nodes: SceneNode[], id: string): SceneNode | undefined => {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = find(n.children || [], id);
    if (hit) return hit;
  }
  return undefined;
};

describe('separateSculpt', () => {
  beforeEach(() => {
    // recompile's debounce parks its resolver on `window`; see
    // detachToTopLevel.test.ts.
    (globalThis as unknown as { window: unknown }).window = globalThis;
    const geom = toSceneGeom(twoBalls());
    const graph = {
      nodes: [{
        id: 'clay', name: 'Clay', type: 'body', pos: [1, 2, 3], euler: [0, 0, 30],
        isSculpt: true, sculptVersion: 4,
        joints: [{ name: 'clay_joint', type: 'free' }],
        weldTargetId: 'table',
        geoms: [{ name: 'clay_mesh', type: 'mesh', size: [1], rgba: [0.9, 0.5, 0.3, 1], dynamic: true, ...geom }],
        children: [],
      }],
    } as unknown as SceneGraph;
    useStore.setState({ sceneGraph: graph, model: null, data: null, undoStack: [] });
  });

  it('makes one body per piece, the largest staying put', () => {
    const node = find(useStore.getState().sceneGraph.nodes, 'clay')!;
    const mesh = createSculptMesh(node.geoms[0].renderVertices!, node.geoms[0].faces!);
    const pieces = splitComponents(mesh);
    expect(pieces).toHaveLength(2);

    const ids = useStore.getState().separateSculpt('clay', pieces, 'clay_mesh');
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe('clay');
    const { nodes } = useStore.getState().sceneGraph;
    expect(nodes).toHaveLength(2);

    const kept = find(nodes, 'clay')!;
    const other = find(nodes, ids[1])!;
    // The bigger ball, at +X, stays on the original body.
    expect(kept.geoms).toHaveLength(1);
    expect(kept.geoms[0].faces!.length / 3).toBe(pieces[0].faceCount);
    expect(Math.min(...kept.geoms[0].renderVertices!.filter((_, i) => i % 3 === 0))).toBeGreaterThan(0);
    expect(kept.sculptVersion).toBe(5);

    // The other is a sculpt of its own, where it was, and not welded to
    // what the original was welded to.
    expect(other.isSculpt).toBe(true);
    expect(other.pos).toEqual([1, 2, 3]);
    expect(other.euler).toEqual([0, 0, 30]);
    expect(other.weldTargetId).toBeUndefined();
    expect(other.joints[0].name).not.toBe('clay_joint');
    expect(other.geoms[0].rgba).toEqual([0.9, 0.5, 0.3, 1]);
    expect(Math.max(...other.geoms[0].renderVertices!.filter((_, i) => i % 3 === 0))).toBeLessThan(0);
  });

  it('is one undo step', () => {
    const node = find(useStore.getState().sceneGraph.nodes, 'clay')!;
    const pieces = splitComponents(createSculptMesh(node.geoms[0].renderVertices!, node.geoms[0].faces!));
    useStore.getState().separateSculpt('clay', pieces);
    expect(useStore.getState().sceneGraph.nodes).toHaveLength(2);
    useStore.getState().undo();
    const { nodes } = useStore.getState().sceneGraph;
    expect(nodes).toHaveLength(1);
    expect(nodes[0].geoms[0].faces!.length / 3).toBe(pieces[0].faceCount + pieces[1].faceCount);
  });

  it('compiles, with every body and joint named once', () => {
    const node = find(useStore.getState().sceneGraph.nodes, 'clay')!;
    const pieces = splitComponents(createSculptMesh(node.geoms[0].renderVertices!, node.geoms[0].faces!));
    useStore.getState().separateSculpt('clay', pieces);
    const xml = compileToMJCF(useStore.getState().sceneGraph);
    // MuJoCo keeps a namespace per element type, and refuses a model with a
    // name twice in one of them.
    for (const tag of ['body', 'joint', 'freejoint', 'geom', 'mesh']) {
      const names = [...xml.matchAll(new RegExp(`<${tag} [^>]*name="([^"]+)"`, 'g'))].map((m) => m[1]);
      expect(new Set(names).size, tag).toBe(names.length);
    }
    // Both bodies are in it.
    for (const n of useStore.getState().sceneGraph.nodes) expect(xml).toContain(`<body name="${n.name}"`);
  });
});
