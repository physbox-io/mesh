import { describe, it, expect, beforeAll, vi } from 'vitest';

// The bridge module sizes its OpenSCAD pool from navigator at import.
vi.hoisted(() => { (globalThis as { navigator?: unknown }).navigator ??= { hardwareConcurrency: 2 }; });

import type { ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../src/utils/sculptCut';
import { cutAlongPlane } from '../src/utils/printSplit';
import { knifeSoups } from '../src/utils/knife';
import { useStore } from '../src/store/useStore';
import type { SceneNode } from '../src/types';

let wasm: ManifoldToplevel;
beforeAll(async () => { wasm = await loadManifold(); }, 30_000);

const node = (id: string) => {
  const walk = (list: SceneNode[]): SceneNode | undefined => {
    for (const n of list) { if (n.id === id) return n; const f = walk(n.children || []); if (f) return f; }
    return undefined;
  };
  return walk(useStore.getState().sceneGraph.nodes);
};
const parentOf = (id: string) => {
  const walk = (list: SceneNode[], parent: SceneNode | null): SceneNode | null | undefined => {
    for (const n of list) {
      if (n.id === id) return parent;
      const f = walk(n.children || [], n);
      if (f !== undefined) return f;
    }
    return undefined;
  };
  return walk(useStore.getState().sceneGraph.nodes, null);
};

// The first piece of a cut keeps the part's id, and everything hung off the
// part or welded to it used to stay with that piece, wherever it really was.
describe('a knife cut shares out what was attached to the part', () => {
  it('gives each child and each weld to the piece it is on', () => {
    useStore.setState({ recompile: async () => {} } as never);
    useStore.getState().updateScene({ nodes: [
      {
        id: 'bar', name: 'bar', pos: [0.1, 0, 0.05], quat: [1, 0, 0, 0], joints: [],
        geoms: [{ name: 'bar_g', type: 'box', size: [0.03, 0.01, 0.005], rgba: [0.5, 0.5, 0.5, 1] }],
        children: [
          { id: 'left_arm', name: 'left_arm', pos: [-0.02, 0, 0.01], quat: [1, 0, 0, 0], children: [],
            joints: [{ name: 'left_hinge', type: 'hinge', axis: [1, 0, 0] }],
            geoms: [{ name: 'left_g', type: 'box', size: [0.002, 0.002, 0.01], rgba: [1, 0, 0, 1] }] },
        ],
      },
      {
        id: 'tag', name: 'tag', pos: [0.125, 0, 0.055], quat: [1, 0, 0, 0], children: [], joints: [], weldTargetId: 'bar',
        geoms: [{ name: 'tag_g', type: 'box', size: [0.002, 0.002, 0.002], rgba: [0, 0, 1, 1] }],
      },
    ] } as never);
    const bar = node('bar')!;
    const { soups, absorbed } = knifeSoups(bar);
    const cut = cutAlongPlane(wasm, soups, [0, 0, 0], [1, 0, 0]);
    if (!cut.ok) throw new Error(cut.error);
    const ids = useStore.getState().splitBodyForPrint('bar', cut.sections, absorbed, { plain: true });
    expect(ids).toHaveLength(2);
    // Which piece is which: the one whose mesh lies at negative x is the left.
    const left = ids.find((id) => Math.max(...node(id)!.geoms[0].renderVertices!.filter((_, i) => i % 3 === 0)) < 0.001)!;
    const right = ids.find((id) => id !== left)!;
    expect(parentOf('left_arm')?.id).toBe(left);
    expect(node('left_arm')!.pos).toEqual([-0.02, 0, 0.01]);
    expect(node('tag')!.weldTargetId).toBe(right);
  });
});
