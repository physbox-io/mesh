/**
 * An awaited recompile reports the build it asked for, not the one before it.
 *
 * physics_build_scene and physics_update_object read lastCompileError straight
 * after awaiting recompile(). The success path cleared it on the next paint,
 * after that await had resolved, so a build that worked was reported with the
 * previous build's error. And a recompile a newer one superseded returned at
 * once, before anything had built, with the same result.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

const g = globalThis as Record<string, unknown>;
g.window = g;
g.document = { visibilityState: 'hidden' };
g.alert = () => {};

const outcomes: { ok: boolean; error?: string }[] = [];

vi.mock('../src/store/physicsWorkerClient', () => {
  class PhysicsWorkerClient {
    meshFiles = undefined;
    onFrame = null; onBreak = null; onImpact = null; onError = null;
    build() { return new Promise((r) => setTimeout(() => r(outcomes.shift() ?? { ok: true }), 20)); }
    setEnv() {} setPlaying() {} resume() {} tick() {} terminate() {}
    hasPendingWork() { return false; }
  }
  return { PhysicsWorkerClient };
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* eslint-disable @typescript-eslint/no-explicit-any */
let useStore: any;

beforeAll(async () => {
  ({ useStore } = await import('../src/store/useStore'));
  await sleep(300);
});

describe('the error an awaited recompile leaves behind', () => {
  it('is cleared by a successful build before the await returns', async () => {
    outcomes.push({ ok: false, error: 'free joint can only be used on top level' });
    await useStore.getState().recompile(useStore.getState().sceneGraph, undefined, true, true);
    expect(useStore.getState().lastCompileError).toMatch(/free joint/);

    outcomes.push({ ok: true });
    await useStore.getState().recompile(useStore.getState().sceneGraph, undefined, false, true);
    expect(useStore.getState().lastCompileError).toBeNull();
  });

  it('is the newer build\'s when a newer recompile supersedes the awaited one', async () => {
    outcomes.push({ ok: false, error: 'previous build failed' });
    await useStore.getState().recompile(useStore.getState().sceneGraph, undefined, true, true);
    expect(useStore.getState().lastCompileError).toBe('previous build failed');

    outcomes.push({ ok: true });
    const mine = useStore.getState().recompile(useStore.getState().sceneGraph, undefined, false, true);
    await sleep(5);
    // An edit's own rebuild arrives inside the debounce and takes over.
    void useStore.getState().recompile();
    await mine;
    expect(useStore.getState().lastCompileError).toBeNull();
  });
});
