// A build whose cloth layout the client already holds is not sent it again:
// the worker leaves `flexes` out and the client gives back the very objects
// it had, so the viewport rebuilds nothing drawn from them.

import { describe, it, expect, vi } from 'vitest';

class FakeWorker {
  static last: FakeWorker;
  posted: Array<Record<string, unknown> & { type?: string }> = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: unknown = null; onmessageerror: unknown = null;
  constructor() { FakeWorker.last = this; }
  postMessage(m: Record<string, unknown> & { type?: string }) { this.posted.push(m); }
  terminate() {}
}
vi.stubGlobal('Worker', FakeWorker);

const { PhysicsWorkerClient } = await import('../src/store/physicsWorkerClient');

describe('cloth layout reuse', () => {
  it('fills an unchanged layout back in and says which it holds', async () => {
    const client = new PhysicsWorkerClient();
    const w = FakeWorker.last;
    const flexes = [{ name: 'c__p', vertadr: 0, vertnum: 3, elems: [0, 1, 2], rgba: [1, 1, 1, 1] }];
    const reply = (id: string, extra: object) => w.onmessage!({ data: { type: 'BUILT', id, ok: true, ...extra } });
    const first = client.build('<mujoco/>', { nodes: [] }, false);
    const m1 = w.posted.find((m) => m.type === 'BUILD');
    expect(m1.haveClothLayout).toBeUndefined();
    reply(m1.id, { flexes, clothLayoutId: 4 });
    expect((await first).flexes).toBe(flexes);
    const second = client.build('<mujoco/>', { nodes: [] }, true);
    const m2 = w.posted.filter((m) => m.type === 'BUILD')[1];
    expect(m2.haveClothLayout).toBe(4);
    reply(m2.id, { flexes: undefined, clothLayoutId: 4 });
    expect((await second).flexes).toBe(flexes);
  });
});
