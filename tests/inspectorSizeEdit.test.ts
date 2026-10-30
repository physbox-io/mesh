// The inspector's size controls never send a size the store refuses, and
// never let a refusal escape a React handler.
//
// updateNodeGeom throws on a bad size (utils/geomSize). Two ways the Resize
// card could hand it one: lengthSpan floored a sub-10 mm part's slider minimum
// to 0, so its left end asked for a zero size; and a short size (a box written
// [0.1]) edited on one axis went out as [v, undefined, undefined]. The handlers
// now build the size with resizedGeomSize and run the edit through guardedEdit.

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

import { resizedGeomSize, guardedEdit } from '../src/utils/sizeEdit';
import { lengthSpan } from '../src/utils/sliderSpan';
import { compileToMJCF } from '../src/utils/mjcf';
import type { SceneNode } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
let useStore: any;
beforeAll(async () => { ({ useStore } = await import('../src/store/useStore')); });

const cube = (size: number[]): SceneNode => ({
  id: 'cube', name: 'cube', pos: [0, 0, 0.1], children: [], joints: [],
  geoms: [{ name: 'cube_g', type: 'box', size }],
} as SceneNode);

describe('lengthSpan', () => {
  it('never reaches down to a zero size (a 4 mm part went to 0)', () => {
    expect(lengthSpan(0.004).min).toBeGreaterThan(0);
    expect(lengthSpan(0.004).min).toBeLessThanOrEqual(0.004);
    expect(lengthSpan(0.0005).min).toBe(0.0005);
    expect(lengthSpan(0.05)).toEqual({ min: 0.01, max: 4, step: 0.01 }); // as before
  });
});

describe('resizedGeomSize', () => {
  it('refuses zero, negative and NaN, so nothing is sent', () => {
    for (const v of [0, -0.01, NaN, Infinity]) expect(resizedGeomSize([0.1, 0.1, 0.1], 0, v, 3)).toBeNull();
  });

  it('fills a short size the way the compiler reads it', () => {
    expect(resizedGeomSize([0.1], 0, 0.2, 3)).toEqual([0.2, 0.2, 0.2]);
    expect(resizedGeomSize([0.1], 2, 0.3, 3)).toEqual([0.1, 0.1, 0.3]);
    expect(resizedGeomSize([0.02], 0, 0.03, 1)).toEqual([0.03]);
    expect(resizedGeomSize([0.02, 0.1], 1, 0.2, 2)).toEqual([0.02, 0.2]);
  });

  it('a cube edited on one axis compiles as the cube it was, plus that edit (was 0.1 m on the others)', () => {
    const xml = compileToMJCF({ nodes: [cube([0.02, undefined as never, undefined as never])] }, -9.81, 1, 0, 0, 0);
    expect(xml).toContain('size="0.02 0.02 0.02"');
  });
});

describe('guardedEdit', () => {
  it('returns the refusal instead of throwing, and the store keeps the old size', () => {
    useStore.getState().updateScene({ nodes: [cube([0.05, 0.05, 0.05])] }, true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refused = guardedEdit(() => useStore.getState().updateNodeGeom('cube', { size: [0.05, -1, 0.05] }, 0));
    expect(refused).toMatch(/size\[1\] is -1/);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(useStore.getState().sceneGraph.nodes[0].geoms[0].size).toEqual([0.05, 0.05, 0.05]);
  });

  it('lets a good edit through', () => {
    useStore.getState().updateScene({ nodes: [cube([0.05])] }, true);
    const size = resizedGeomSize([0.05], 1, 0.08, 3)!;
    expect(guardedEdit(() => useStore.getState().updateNodeGeom('cube', { size }, 0))).toBeNull();
    expect(useStore.getState().sceneGraph.nodes[0].geoms[0].size).toEqual([0.05, 0.08, 0.05]);
  });
});
