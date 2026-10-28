import { describe, it, expect, vi } from 'vitest';

// The bridge module sizes its OpenSCAD pool from navigator at import.
vi.hoisted(() => { (globalThis as { navigator?: unknown }).navigator ??= { hardwareConcurrency: 2 }; });

import { useStore } from '../src/store/useStore';
import { compileToMJCF } from '../src/utils/mjcf';
import type { SceneNode } from '../src/types';

const box = (id: string, x: number, extra: Partial<SceneNode> = {}): SceneNode => ({
  id, name: id, pos: [x, 0, 0.1], quat: [1, 0, 0, 0], joints: [], children: [],
  geoms: [{ name: `${id}_g`, type: 'box', size: [0.02, 0.02, 0.02], rgba: [0.5, 0.5, 0.5, 1] }],
  ...extra,
});

// Combine removes the bodies it merges. A weld from a third body to one of them
// used to be left naming it, and MuJoCo refused the whole model:
// "unknown element 'bottom_right' in equality constraint".
describe('combine and the welds that named a merged body', () => {
  const run = () => {
    useStore.setState({ recompile: async () => {} } as never);
    useStore.getState().updateScene({
      nodes: [
        box('top', 0, { weldTargetId: 'bottom_right' }),
        box('bottom_left', 0.05),
        box('bottom_right', 0.1, { weldTargetId: 'bottom_left', connectTargetId: 'bottom_left', connectAnchor: [0.1, 0, 0.1] }),
        box('side', 0.2, { connectTargetId: 'bottom_right', connectAnchor: [0.15, 0, 0.1], coupleTargetId: 'bottom_right', coupleRatio: 2 }),
      ],
    } as never);
    useStore.getState().combineBodies('bottom_left', ['bottom_right'], 'intersect');
    return useStore.getState().sceneGraph;
  };

  it('moves them onto the body it was merged into', () => {
    const nodes = run().nodes;
    const top = nodes.find((n) => n.id === 'top')!;
    const side = nodes.find((n) => n.id === 'side')!;
    expect(nodes.some((n) => n.id === 'bottom_right')).toBe(false);
    expect(top.weldTargetId).toBe('bottom_left');
    expect(side.connectTargetId).toBe('bottom_left');
    expect(side.coupleTargetId).toBeUndefined();
  });

  it('compiles with no constraint naming the removed body', () => {
    const xml = compileToMJCF(run());
    expect(xml).not.toContain('bottom_right');
    expect(xml).toMatch(/<weld [^>]*body1="top" body2="bottom_left"/);
  });
});
