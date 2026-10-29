// The V-HACD worker runs one job at a time, and a job's 20 s starts when the
// worker starts it.
//
// A marble run built over MCP — funnel, spiral chute, ramp, cup — came back
// with all four bodies "Convex decomposition timed out": every request was
// posted at once and timed from the post, so each waited out the ones in front
// of it on its own clock. A job that did time out was never stopped, so the
// worker went on grinding through it while the rest timed out behind it. And a
// finer retry inside one body's decomposition timed out the same way, silently.
//
// A stand-in worker here takes `maxHulls` seconds over each job.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DECOMPOSE_TIMEOUT_MS, decomposeMeshOffThread, setVhacdWorkerFactory, vhacdJobsPending, type WorkerLike,
} from '../src/utils/vhacdWorkerClient';
import type { VhacdRequest, VhacdResponse } from '../src/workers/vhacdProtocol';

interface FakeWorker extends WorkerLike { terminated: boolean; started: number[] }

let spawned: FakeWorker[] = [];

function fakeWorker(): FakeWorker {
  const w: FakeWorker = {
    terminated: false,
    started: [],
    onmessage: null,
    onerror: null,
    terminate() { this.terminated = true; },
    postMessage(msg: VhacdRequest) {
      if (msg.type !== 'DECOMPOSE') return;
      w.started.push(Date.now());
      const seconds = msg.params.maxHulls ?? 1;
      if (seconds < 0) { setTimeout(() => w.onerror?.(new Error('out of memory')), 1000); return; }
      setTimeout(() => {
        if (w.terminated) return;
        w.onmessage?.({ data: { type: 'DECOMPOSED', id: msg.id, hulls: [] } as VhacdResponse } as MessageEvent<VhacdResponse>);
      }, seconds * 1000);
    },
  };
  spawned.push(w);
  return w;
}

const job = (seconds: number) => decomposeMeshOffThread([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2], { maxHulls: seconds })
  .then(() => 'ok', (e: Error) => e.message);

beforeEach(() => {
  vi.useFakeTimers();
  spawned = [];
  setVhacdWorkerFactory(fakeWorker);
});
afterEach(() => {
  setVhacdWorkerFactory(null);
  vi.useRealTimers();
});

describe('the V-HACD queue', () => {
  it('times each job from when the worker starts it, so four 8 s jobs all finish', async () => {
    const all = Promise.all([job(8), job(8), job(8), job(8)]);
    await vi.advanceTimersByTimeAsync(40_000);
    // Posted together and timed from the post, the third and fourth would have timed out at 20 s.
    expect(await all).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].started.map(t => t - spawned[0].started[0])).toEqual([0, 8000, 16000, 24000]);
  });

  it('stops a job that runs past its time, and gives the rest a new worker', async () => {
    const all = Promise.all([job(30), job(2), job(2)]);
    await vi.advanceTimersByTimeAsync(DECOMPOSE_TIMEOUT_MS + 5_000);
    expect(await all).toEqual(['Convex decomposition timed out.', 'ok', 'ok']);
    expect(spawned[0].terminated).toBe(true);
    expect(spawned).toHaveLength(2);
    expect(spawned[1].started).toHaveLength(2);
    expect(vhacdJobsPending()).toBe(0);
  });

  it('fails only the job a dying worker was running', async () => {
    const all = Promise.all([job(-1), job(3)]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await all).toEqual(['The convex decomposition worker stopped.', 'ok']);
  });
});
