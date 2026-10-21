import { describe, it, expect, vi } from 'vitest';

/** A worker that records what it was sent and answers when told to. */
class FakeWorker {
  static last: FakeWorker;
  static count = 0;
  sent: { id: number; type: string; scene?: unknown }[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  terminated = false;
  constructor() { FakeWorker.last = this; FakeWorker.count++; }
  postMessage(m: { id: number; type: string; scene?: unknown }) { this.sent.push(m); }
  terminate() { this.terminated = true; }
}
vi.stubGlobal('Worker', FakeWorker);

const { MoldWorkerClient } = await import('../src/utils/moldWorkerClient');

/*
 * A tab left open across a deploy asks for a worker file that no longer
 * exists, and the worker dies on load. The client kept the dead worker, and
 * every later request waited on it for good.
 */
describe('the mold worker client, when its worker dies', () => {
  it('fails what was asked, refuses what needed the lost mold, and regenerates on a new worker', async () => {
    const client = new MoldWorkerClient();
    const scene = { nodes: [] };
    const dead = FakeWorker.last;
    const a = client.generate(scene, {});
    const before = FakeWorker.count;
    dead.onerror?.();
    await expect(a).rejects.toThrow('The mold worker stopped.');
    expect(dead.terminated).toBe(true);
    // Not at once: on an out-of-date tab that would load, die and respawn for good.
    expect(FakeWorker.count).toBe(before);

    // The mold the dead worker held is gone; an STL of nothing would be worse than an error.
    await expect(client.stl()).rejects.toThrow('The mold worker stopped.');
    expect(FakeWorker.count).toBe(before);

    const b = client.generate(scene, {});
    const fresh = FakeWorker.last;
    expect(fresh).not.toBe(dead);
    expect(fresh.sent).toHaveLength(1);
    // The new worker holds no scene, so it is sent again.
    expect(fresh.sent[0]).toMatchObject({ type: 'GENERATE', scene });
    fresh.onmessage?.({ data: { type: 'GENERATED', id: fresh.sent[0].id, summary: 's', bottom: 'b', top: null } });
    await expect(b).resolves.toMatchObject({ summary: 's' });

    const stl = client.stl();
    fresh.onmessage?.({ data: { type: 'STL', id: fresh.sent[1].id, bytes: 'bytes' } });
    await expect(stl).resolves.toBe('bytes');
  });
});
