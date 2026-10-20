import { describe, it, expect, vi } from 'vitest';

/** A worker that records what it was sent and answers when told to. */
class FakeWorker {
  static last: FakeWorker;
  sent: { id: number; options: unknown; scene?: unknown }[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { FakeWorker.last = this; }
  postMessage(m: { id: number; options: unknown; scene?: unknown }) { this.sent.push(m); }
  terminate() {}
  answer(id: number) { this.onmessage?.({ data: { type: 'DONE', id, result: `r${id}` } }); }
}
vi.stubGlobal('Worker', FakeWorker);

const { ExportWorkerClient } = await import('../src/utils/exportWorkerClient');

describe('the export worker client', () => {
  it('runs one job at a time and only the newest of those that waited', async () => {
    const client = new ExportWorkerClient();
    const scene = { nodes: [] };
    const a = client.run('solid', scene, { n: 1 } as never);
    const b = client.run('solid', scene, { n: 2 } as never);
    const c = client.run('solid', scene, { n: 3 } as never);
    const w = FakeWorker.last;
    expect(w.sent.map((m) => m.options)).toEqual([{ n: 1 }]);
    await expect(b).rejects.toMatchObject({ name: 'Superseded' });

    w.answer(w.sent[0].id);
    await expect(a).resolves.toBe('r1');
    expect(w.sent.map((m) => m.options)).toEqual([{ n: 1 }, { n: 3 }]);
    // The scene went with the first; the one that waited does not send it again.
    expect(w.sent[0].scene).toBe(scene);
    expect(w.sent[1].scene).toBeUndefined();
    w.answer(w.sent[1].id);
    await expect(c).resolves.toBe('r3');
  });

  it('dispatches timber joinery jobs through the worker protocol', async () => {
    const client = new ExportWorkerClient();
    const scene = { nodes: [] };
    const promise = client.run('timber', scene, {
      soups: [],
      joineryOptions: { jointMode: 'mortise_tenon' },
      cncBedMm: [300, 200, 60],
      defaultStockLengthMm: 1800,
    });
    const w = FakeWorker.last;
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({
      kind: 'timber',
      options: {
        soups: [],
        joineryOptions: { jointMode: 'mortise_tenon' },
        cncBedMm: [300, 200, 60],
        defaultStockLengthMm: 1800,
      },
    });
    w.answer(w.sent[0].id);
    await expect(promise).resolves.toBe('r1');
  });
});
