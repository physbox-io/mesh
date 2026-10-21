// A tab that outlived a deploy says so when a worker dies, instead of blaming
// the feature that happened to use it.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubGlobal('__MESH_BUILD__', '2026-10-20T05:00:00.000Z');
const { isStaleBuild, workerStoppedError, useUpdateNotice, UPDATED_MESSAGE } = await import('../src/utils/staleBuild');

const serving = (body: unknown, ok = true) =>
  (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

describe('telling a replaced build from a broken worker', () => {
  beforeEach(() => useUpdateNotice.setState({ stale: false, dismissed: false }));

  it('is not stale while the server serves this build', async () => {
    expect(await isStaleBuild(serving({ build: '2026-10-20T05:00:00.000Z' }))).toBe(false);
    const e = await workerStoppedError('The export worker stopped.', serving({ build: '2026-10-20T05:00:00.000Z' }));
    expect(e.message).toBe('The export worker stopped.');
    expect(useUpdateNotice.getState().stale).toBe(false);
  });

  it('is stale once the server serves another, and raises the banner', async () => {
    const e = await workerStoppedError('The export worker stopped.', serving({ build: '2026-10-20T06:26:00.000Z' }));
    expect(e.message).toBe(UPDATED_MESSAGE);
    expect(useUpdateNotice.getState().stale).toBe(true);
  });

  it('keeps the worker’s own message when the server cannot say', async () => {
    const down = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    expect((await workerStoppedError('The export worker stopped.', down)).message).toBe('The export worker stopped.');
    expect((await workerStoppedError('The export worker stopped.', serving({}, false))).message).toBe('The export worker stopped.');
    expect((await workerStoppedError('The export worker stopped.', serving({ nothing: 1 }))).message).toBe('The export worker stopped.');
    expect(useUpdateNotice.getState().stale).toBe(false);
  });
});
