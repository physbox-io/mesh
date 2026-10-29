/**
 * physics_build_scene with no bodies clears the scene.
 *
 * It refused an empty list ("bodies must be a non-empty array"), so the only
 * way to clear a scene over MCP was physics_update_scene([]).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

const g = globalThis as Record<string, unknown>;
g.window = g;
g.document = { visibilityState: 'hidden' };
g.alert = () => {};
if (!('navigator' in g)) g.navigator = { hardwareConcurrency: 4 };

const builds: string[] = [];
vi.mock('../src/store/physicsWorkerClient', () => {
  class PhysicsWorkerClient {
    meshFiles = undefined;
    onFrame = null; onBreak = null; onImpact = null; onError = null;
    build(xml: string) { builds.push(xml); return Promise.resolve({ ok: true }); }
    setEnv() {} setPlaying() {} resume() {} tick() {} terminate() {} clearHistory() {}
    hasPendingWork() { return false; }
  }
  return { PhysicsWorkerClient };
});

/* eslint-disable @typescript-eslint/no-explicit-any */
let useStore: any;
let sceneCommands: any;

beforeAll(async () => {
  ({ useStore } = await import('../src/store/useStore'));
  ({ sceneCommands } = await import('../src/hooks/mcp/sceneCommands'));
});

const ctx = () => ({ store: useStore.getState(), toId: (v: unknown) => v });

describe('physics_build_scene', () => {
  it('clears the scene when given no bodies', async () => {
    const built = await sceneCommands.BUILD_SCENE({
      bodies: [{ id: 'box', name: 'box', pos: [0, 0, 0.1], geoms: [{ type: 'box', size: [0.01, 0.01, 0.01] }] }],
    }, ctx());
    expect(built).toMatchObject({ ok: true, nodeCount: 1 });
    expect(useStore.getState().sceneGraph.nodes).toHaveLength(1);

    builds.length = 0;
    const cleared = await sceneCommands.BUILD_SCENE({ bodies: [] }, ctx());
    expect(cleared).toMatchObject({ ok: true, nodeCount: 0, topLevelCount: 0 });
    expect(useStore.getState().sceneGraph.nodes).toEqual([]);
    expect(builds.length).toBeGreaterThan(0);
    expect(useStore.getState().lastCompileError).toBeNull();
  });

  it('still refuses something that is not a list', async () => {
    expect(await sceneCommands.BUILD_SCENE({ bodies: 'box' }, ctx())).toMatchObject({ ok: false, error: expect.stringMatching(/array/) });
    expect(await sceneCommands.BUILD_SCENE({}, ctx())).toMatchObject({ ok: false });
  });
});
