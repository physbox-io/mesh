// A bad geom size is refused, never replaced with 0.1 m.
//
// Reported: negative, zero or text sizes were silently swapped for 0.1 m by
// the compiler, so a box written with size [-0.05, ...] came out 200 mm across
// and 0.32 kg. The MCP's body defaults, the store's geom edits and the
// compiler now all refuse one with a message naming the geom and the entry.

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

import { geomSizeProblem } from '../src/utils/geomSize';
import { compileToMJCF } from '../src/utils/mjcf';
import { fillBodyDefaults, resolveUpdatedGeoms } from '../src/hooks/mcp/bodyDefaults';
import type { SceneNode } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
let useStore: any;
beforeAll(async () => { ({ useStore } = await import('../src/store/useStore')); });

const boxBody = (size: unknown): SceneNode => ({
  id: 'crate', name: 'crate', pos: [0, 0, 0.5], joints: [{ name: 'crate_free', type: 'free' }], children: [],
  geoms: [{ name: 'crate_g', type: 'box', size: size as number[] }],
} as SceneNode);

describe('geomSizeProblem', () => {
  it.each([
    ['negative', [-0.05, 0.05, 0.05], /size\[0\] is -0\.05/],
    ['zero', [0.05, 0, 0.05], /size\[1\] is 0/],
    ['text', [0.05, 0.05, 'big'], /size\[2\] is "big"/],
    ['NaN', [NaN], /size\[0\] is null/],
    ['not a list', 'large', /must be a list of numbers/],
    ['empty', [], /size is empty/],
  ])('refuses a %s box size', (_l, size, msg) => {
    expect(geomSizeProblem({ name: 'b', type: 'box', size }, 'body')).toMatch(msg);
  });

  it('accepts what MuJoCo accepts', () => {
    expect(geomSizeProblem({ type: 'box', size: [0.1] })).toBeNull(); // a cube
    expect(geomSizeProblem({ type: 'sphere', size: [0.1, 0, 'x'] })).toBeNull(); // only [0] read
    expect(geomSizeProblem({ type: 'cylinder', size: [0.02, 0.1, 0] })).toBeNull();
    expect(geomSizeProblem({ type: 'capsule', size: [0.02, 0], fromto: [0, 0, 0, 0, 0, 1] })).toBeNull();
    expect(geomSizeProblem({ type: 'plane', size: [0, 0, 0.1] })).toBeNull();
    expect(geomSizeProblem({ type: 'mesh', size: [0] })).toBeNull();
    expect(geomSizeProblem({ type: 'box' })).toBeNull(); // left out: a default fills it
  });
});

describe('the MCP boundary', () => {
  it('build_scene / add_object refuse a negative box', () => {
    expect(() => fillBodyDefaults({ name: 'crate', geoms: [{ type: 'box', size: [-0.05, 0.05, 0.05] }] } as never))
      .toThrow(/crate_geom_0.*on body "crate".*size\[0\] is -0\.05/);
  });

  it('update_object refuses a text size', () => {
    const target = fillBodyDefaults({ name: 'crate', geoms: [{ name: 'crate_g', type: 'box', size: [0.05, 0.05, 0.05] }] } as never);
    expect(() => resolveUpdatedGeoms(target, [{ name: 'crate_g', size: ['big', 0.05, 0.05] } as never]))
      .toThrow(/size\[0\] is "big"/);
  });
});

describe('the store', () => {
  it('updateNodeGeom refuses a zero size and leaves the geom as it was', () => {
    useStore.getState().updateScene({ nodes: [boxBody([0.05, 0.05, 0.05])] });
    expect(() => useStore.getState().updateNodeGeom('crate', { size: [0.05, 0, 0.05] }, 0)).toThrow(/size\[1\] is 0/);
    expect(useStore.getState().sceneGraph.nodes[0].geoms[0].size).toEqual([0.05, 0.05, 0.05]);
  });

  it('updateNode refuses geoms with a negative size', () => {
    useStore.getState().updateScene({ nodes: [boxBody([0.05, 0.05, 0.05])] });
    expect(() => useStore.getState().updateNode('crate', { geoms: [{ name: 'crate_g', type: 'box', size: [-0.1, 0.05, 0.05] }] }))
      .toThrow(/size\[0\] is -0\.1/);
    expect(useStore.getState().sceneGraph.nodes[0].geoms[0].size).toEqual([0.05, 0.05, 0.05]);
  });
});

describe('the compiler', () => {
  it('names the bad size instead of compiling it as 0.1 m (a negative box was 200 mm, 0.32 kg)', () => {
    expect(() => compileToMJCF({ nodes: [boxBody([-0.05, 0.05, 0.05])] }, -9.81, 1, 0, 0, 0))
      .toThrow(/crate_g.*size\[0\] is -0\.05/);
    expect(compileToMJCF({ nodes: [boxBody([0.05, 0.05, 0.05])] }, -9.81, 1, 0, 0, 0)).toContain('size="0.05 0.05 0.05"');
  });
});
