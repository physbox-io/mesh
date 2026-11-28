// The worker no longer posts the cloth's whole state (up to 735 KB) with
// every frame: about once a second, once it has moved, transferred; a
// planned recycle asks for the current one.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { CLOTH_STATE_EVERY_MS, clothStateThrottle, clothStateTransfer } from '../src/workers/clothStatePost';
import type { ClothStateSnapshot } from '../src/workers/physicsWorkerProtocol';

describe('cloth state posting', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('is due about once a second, and only once the cloth has moved', () => {
    const due = clothStateThrottle();
    expect(due(0, 0.1)).toBe(true);
    expect(due(16, 0.11)).toBe(false);
    expect(due(CLOTH_STATE_EVERY_MS - 1, 0.5)).toBe(false);
    expect(due(CLOTH_STATE_EVERY_MS, 0.6)).toBe(true);
    expect(due(3 * CLOTH_STATE_EVERY_MS, 0.6)).toBe(false); // paused: nothing new to send
    expect(due(3 * CLOTH_STATE_EVERY_MS + 1, 0.61)).toBe(true);
  });

  it('transfers every buffer of the state', () => {
    const s: ClothStateSnapshot = { x: new Float64Array(6), v: new Float64Array(6), time: 1, floatUntil: new Float64Array(2), boardsQ: new Float64Array(0), stitchOn: new Uint8Array(3) };
    const t = clothStateTransfer(s);
    expect(t).toHaveLength(4); // the empty one left out
    const clone = structuredClone(s, { transfer: t });
    expect(clone.x.length).toBe(6);
    expect(s.x.byteLength).toBe(0); // handed over, not copied
  });

  it('a planned recycle can ask the worker for the state now', async () => {
    const posted: { type: string; id: string }[] = [];
    let worker: { onmessage: ((e: MessageEvent) => void) | null } | null = null;
    class MockWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onmessageerror: (() => void) | null = null;
      onerror: (() => void) | null = null;
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      constructor() { worker = this; }
      postMessage(m: { type: string; id: string }) { posted.push(m); }
      terminate() {}
    }
    vi.stubGlobal('Worker', MockWorker);
    const { PhysicsWorkerClient } = await import('../src/store/physicsWorkerClient');
    const client = new PhysicsWorkerClient();
    const p = client.getClothState();
    const ask = posted.find((m) => m.type === 'GET_CLOTH_STATE')!;
    expect(ask).toBeTruthy();
    const state = { x: new Float64Array(3), v: new Float64Array(3), time: 2 };
    worker!.onmessage!({ data: { type: 'CLOTH_STATE', id: ask.id, clothState: state } } as MessageEvent);
    await expect(p).resolves.toBe(state);
    // A worker that does not answer: undefined after the timeout, not a hang.
    vi.useFakeTimers();
    const q = client.getClothState(500);
    vi.advanceTimersByTime(501);
    await expect(q).resolves.toBeUndefined();
    expect(client.hasPendingWork()).toBe(false);
    client.terminate();
  });
});
