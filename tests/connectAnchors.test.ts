import { describe, it, expect, vi } from 'vitest';

// The bridge module sizes its OpenSCAD pool from navigator at import.
vi.hoisted(() => { (globalThis as { navigator?: unknown }).navigator ??= { hardwareConcurrency: 2 }; });

import { useStore } from '../src/store/useStore';
import type { SceneNode } from '../src/types';

const body = (id: string, pos: number[], extra: Partial<SceneNode> = {}): SceneNode => ({
  id, name: id, pos, quat: [1, 0, 0, 0], children: [],
  joints: [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 0, 1] }],
  geoms: [{ name: `${id}_g`, type: 'box', size: [0.01, 0.01, 0.01], rgba: [0.5, 0.5, 0.5, 1] }],
  ...extra,
});
const node = (id: string) => {
  const walk = (list: SceneNode[]): SceneNode | undefined => {
    for (const n of list) { if (n.id === id) return n; const f = walk(n.children || []); if (f) return f; }
    return undefined;
  };
  return walk(useStore.getState().sceneGraph.nodes)!;
};
const close = (a: number[] | undefined, b: number[]) => b.forEach((v, i) => expect(a![i]).toBeCloseTo(v, 6));

// A connect's anchor is world space and nothing moved it: a duplicated linkage
// kept its pin on the original, and moving a body left its pin behind.
describe('a connect pin stays on its body', () => {
  const load = () => {
    useStore.setState({ recompile: async () => {} } as never);
    useStore.getState().updateScene({ nodes: [
      body('rocker', [0, 0, 0.1]),
      body('arm', [0.02, 0, 0.1], { connectTargetId: 'rocker', connectAnchor: [0.025, 0, 0.1] }),
    ] } as never);
  };

  it('works the local point out from the anchor it is given', () => {
    load();
    close(node('arm').connectAnchorLocal, [0.005, 0, 0]);
  });

  it('follows the body when it moves', () => {
    load();
    useStore.getState().updateNodePos('arm', [0.32, 0, 0.1]);
    close(node('arm').connectAnchor, [0.325, 0, 0.1]);
  });

  it('lands on a pasted copy, not on the original', () => {
    load();
    useStore.setState({ selectedNodeId: 'arm', extraSelectedIds: [] });
    const [copyId] = useStore.getState().duplicateSelection();
    const copy = node(copyId);
    close(copy.connectAnchor, [copy.pos[0] + 0.005, copy.pos[1], copy.pos[2]]);
    close(node('arm').connectAnchor, [0.025, 0, 0.1]);
  });

  it('takes a newly written anchor as meant', () => {
    load();
    useStore.getState().updateNode('arm', { connectAnchor: [0.02, 0.01, 0.1] });
    close(node('arm').connectAnchor, [0.02, 0.01, 0.1]);
    close(node('arm').connectAnchorLocal, [0, 0.01, 0]);
  });
});
