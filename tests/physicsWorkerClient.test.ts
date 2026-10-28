import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A worker that accepts messages and never answers, so every request stays
// in flight until the client itself settles it.
class SilentWorker {
  onmessage: ((evt: MessageEvent) => void) | null = null;
  onerror: ((evt: ErrorEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
}

let created: SilentWorker[] = [];

beforeEach(() => {
  created = [];
  (globalThis as unknown as { Worker: unknown }).Worker = class {
    constructor() {
      const w = new SilentWorker();
      created.push(w);
      return w as unknown as Worker;
    }
  };
});

afterEach(() => { delete (globalThis as Record<string, unknown>).Worker; });

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

describe('PhysicsWorkerClient worker failure', () => {
  it('rejects in-flight requests and reports when the worker fails to load', async () => {
    const { PhysicsWorkerClient } = await import('../src/store/physicsWorkerClient');
    const client = new PhysicsWorkerClient();
    const onError = vi.fn();
    client.onError = onError;

    const build = client.build('<mujoco/>', { nodes: [] }, true);
    // What a stale hashed chunk served as index.html looks like to the page.
    created[0].onerror?.({ message: 'SyntaxError: Unexpected token <', preventDefault: () => {} } as ErrorEvent);

    await expect(build).rejects.toThrow(/failed to load/);
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/failed to load/), false);
    expect(client.hasPendingWork()).toBe(false);
  });

  it('sends batched multi-axis setQpos and density-aware setEnv in single messages', async () => {
    const { PhysicsWorkerClient } = await import('../src/store/physicsWorkerClient');
    const client = new PhysicsWorkerClient();
    client.setQpos('ball_joint', 0, [1, 2, 3, 1, 0, 0, 0]);
    client.setEnv(2.5, -1.0, 1.8);

    expect(created[0].postMessage).toHaveBeenCalledWith({
      type: 'SET_QPOS',
      jointName: 'ball_joint',
      axis: 0,
      value: [1, 2, 3, 1, 0, 0, 0],
    });
    expect(created[0].postMessage).toHaveBeenCalledWith({
      type: 'SET_ENV',
      windX: 2.5,
      windY: -1.0,
      density: 1.8,
    });
  });
});


describe('PhysicsWorkerClient dead worker', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('settles everything owed and reports fatal when the engine aborts', async () => {
    const { PhysicsWorkerClient } = await import('../src/store/physicsWorkerClient');
    const client = new PhysicsWorkerClient();
    const onError = vi.fn();
    client.onError = onError;
    const headless = client.runHeadless('<mujoco/>', { nodes: [] }, 10);
    const telemetry = client.getTelemetry();

    created[0].onmessage!({ data: { type: 'ERROR', message: 'The physics engine aborted (native code called abort()).', fatal: true } } as MessageEvent);

    await expect(headless).rejects.toThrow(/aborted/);
    await expect(telemetry).rejects.toThrow(/aborted/);
    expect(client.hasPendingWork()).toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/aborted/), true, undefined);
    client.terminate();
  });

  it('takes a worker that owes work and stays silent for dead, and reports it fatal', async () => {
    vi.useFakeTimers();
    const { PhysicsWorkerClient, WORKER_SILENCE_MS } = await import('../src/store/physicsWorkerClient');
    const client = new PhysicsWorkerClient();
    const onError = vi.fn();
    client.onError = onError;
    const headless = client.runHeadless('<mujoco/>', { nodes: [] }, 10);
    const settled = expect(headless).rejects.toThrow(/stopped answering/);

    vi.advanceTimersByTime(WORKER_SILENCE_MS - 10_000);
    expect(onError).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20_000);

    await settled;
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/stopped answering/), true);
    expect(client.hasPendingWork()).toBe(false);
    client.terminate();
  });

  it('leaves an idle worker alone however long it is quiet, and counts silence from the request', async () => {
    vi.useFakeTimers();
    const { PhysicsWorkerClient, WORKER_SILENCE_MS } = await import('../src/store/physicsWorkerClient');
    const client = new PhysicsWorkerClient();
    const onError = vi.fn();
    client.onError = onError;

    vi.advanceTimersByTime(WORKER_SILENCE_MS * 3);
    expect(onError).not.toHaveBeenCalled();

    // Work handed over after a long idle spell gets the whole allowance.
    const telemetry = client.getTelemetry();
    vi.advanceTimersByTime(WORKER_SILENCE_MS - 10_000);
    expect(onError).not.toHaveBeenCalled();
    created[0].onmessage!({ data: { type: 'TELEMETRY_RESULT', id: (created[0].postMessage.mock.calls[0][0] as { id: string }).id, telemetry: null } } as MessageEvent);
    await expect(telemetry).resolves.toBeNull();
    vi.advanceTimersByTime(WORKER_SILENCE_MS * 2);
    expect(onError).not.toHaveBeenCalled();
    client.terminate();
  });
});
