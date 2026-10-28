import { describe, it, expect, vi } from 'vitest';

// The bridge module sizes its OpenSCAD pool from navigator at import.
vi.hoisted(() => { (globalThis as { navigator?: unknown }).navigator ??= { hardwareConcurrency: 2 }; });

import * as THREE from 'three';
import { useStore } from '../src/store/useStore';
import { nodeWorldMatrix } from '../src/utils/combineBodies';
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

// Only a merged body's own shape goes into the target. The bodies hung off it
// are parts of their own and used to be deleted with it.
describe('combine and the bodies hung off a merged body', () => {
  const combine = (nodes: SceneNode[], targetId: string, sourceIds: string[]) => {
    useStore.setState({ recompile: async () => {} } as never);
    useStore.getState().updateScene({ nodes } as never);
    useStore.getState().combineBodies(targetId, sourceIds, 'union');
    return useStore.getState().sceneGraph.nodes;
  };
  const world = (nodes: SceneNode[], id: string) => {
    const p = new THREE.Vector3();
    nodeWorldMatrix(nodes, id)!.decompose(p, new THREE.Quaternion(), new THREE.Vector3());
    return p.toArray();
  };

  it('moves them under the target, where they were, with their joints', () => {
    const turned = Math.SQRT1_2;
    const lid = box('lid', 0, { pos: [0, 0.02, 0.03], joints: [{ name: 'lid_hinge', type: 'hinge', axis: [1, 0, 0] }] });
    const before = [box('frame', 0), box('case', 0.1, { quat: [turned, 0, 0, turned], children: [lid] }), box('latch', 0.3, { weldTargetId: 'lid' })];
    const lidWorld = world(before, 'lid');
    const nodes = combine(before, 'frame', ['case']);
    const frame = nodes.find((n) => n.id === 'frame')!;
    expect(frame.children.map((c) => c.id)).toEqual(['lid']);
    expect(frame.children[0].joints[0].name).toBe('lid_hinge');
    world(nodes, 'lid').forEach((v, i) => expect(v).toBeCloseTo(lidWorld[i], 9));
    const xml = compileToMJCF(useStore.getState().sceneGraph);
    expect(xml).toMatch(/<weld [^>]*body1="latch" body2="lid"/);
    expect(xml).not.toContain('"case"');
  });

  it('keeps a target that hung off the body merged into it', () => {
    const before = [box('base', 0, { children: [box('arm', 0, { pos: [0.05, 0, 0.04], children: [box('pin', 0, { pos: [0.01, 0, 0] })] })] })];
    const armWorld = world(before, 'arm');
    const pinWorld = world(before, 'pin');
    const nodes = combine(before, 'arm', ['base']);
    expect(nodes.map((n) => n.id)).toEqual(['arm']);
    expect(nodes[0].children.map((c) => c.id)).toEqual(['pin']);
    world(nodes, 'arm').forEach((v, i) => expect(v).toBeCloseTo(armWorld[i], 9));
    world(nodes, 'pin').forEach((v, i) => expect(v).toBeCloseTo(pinWorld[i], 9));
  });
});
