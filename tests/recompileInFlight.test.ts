/**
 * The count of recompiles in flight must come back to zero.
 *
 * physics_get_scene_summary and physics_get_state report `compiling` from it,
 * and after a burst of edits every call reported a compile in flight forever.
 * A debounced recompile that a second one woke cleared the shared wake handle
 * after the second had already set its own, so a third could not wake the
 * second: it hung, never built, and never gave its count back.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

const g = globalThis as Record<string, unknown>;
g.window = g;
g.document = { visibilityState: 'hidden' };
g.alert = () => {};

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* eslint-disable @typescript-eslint/no-explicit-any */
let useStore: any;
let sim: any;

beforeAll(async () => {
  ({ useStore } = await import('../src/store/useStore'));
  sim = await import('../src/store/simulationActions');
});

describe('recompiles in flight', () => {
  it('drops back to zero after a burst of debounced recompiles, and every caller returns', async () => {
    await sleep(300);
    // A few milliseconds apart, as edits arrive over MCP: each wakes the one
    // before it, whose continuation runs before the next edit lands.
    const calls: Promise<void>[] = [];
    for (let i = 0; i < 4; i++) {
      calls.push(useStore.getState().recompile());
      await sleep(5);
    }
    const settled = await Promise.race([
      Promise.all(calls).then(() => true),
      sleep(1500).then(() => false),
    ]);
    expect(settled).toBe(true);
    await sleep(50);
    expect(sim.recompilesInFlight).toBe(0);
  });
});
