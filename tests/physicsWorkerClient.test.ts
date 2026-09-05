import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A worker that accepts messages and never answers, so every request stays
// in flight until the client itself settles it.
class SilentWorker {
  onmessage: ((evt: MessageEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
}

let created: SilentWorker[] = [];

beforeEach(() => {
  created = [];
  (globalThis as any).Worker = class {
    constructor() {
      const w = new SilentWorker();
      created.push(w);
      return w as any;
    }
  };
});

afterEach(() => { delete (globalThis as any).Worker; });

describe('PhysicsWorkerClient.terminate', () => {
  it('rejects requests the terminated worker can never answer', async () => {
    const { PhysicsWorkerClient } = await import('../src/store/physicsWorkerClient');
    const client = new PhysicsWorkerClient();

    const build = client.build('<mujoco/>', { nodes: [] }, true);
    const headless = client.runHeadless('<mujoco/>', { nodes: [] }, 10);
    const history = client.getHistory();
    const telemetry = client.getTelemetry();

    expect(client.hasPendingWork()).toBe(true);

    client.terminate();

    // Without this, each of these promises hangs forever and so does whatever
    // awaits it — which is how the MCP bridge's "MCP Active" badge got stuck.
    await expect(build).rejects.toThrow(/recycled/);
    await expect(headless).rejects.toThrow(/recycled/);
    await expect(history).rejects.toThrow(/recycled/);
    await expect(telemetry).rejects.toThrow(/recycled/);
    expect(client.hasPendingWork()).toBe(false);
  });

  it('reports no pending work on a fresh client', async () => {
    const { PhysicsWorkerClient } = await import('../src/store/physicsWorkerClient');
    expect(new PhysicsWorkerClient().hasPendingWork()).toBe(false);
  });
});
