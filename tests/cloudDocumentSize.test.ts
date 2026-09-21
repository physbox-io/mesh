import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * A relief or a sculpt is megabytes of vertices, and the account will not take a
 * document that big. The point of these is that the app knows that before it
 * spends a mill job's worth of uploads finding out — and that what it says when
 * it happens is a sentence rather than `HTTP error 413`.
 */

class FakeApiError extends Error {
  status: number;
  code?: string;
  body: Record<string, unknown>;
  constructor(message: string, status: number, body: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.body = body;
    this.code = typeof body.code === 'string' ? body.code : undefined;
  }
}

const putCloudDocument = vi.fn(async () => ({ id: 'doc_test', revision: 1 }));

vi.mock('../src/utils/apiClient', () => ({
  isProAccount: () => true,
  isProRequired: () => false,
  getStoredAuthToken: () => 'token',
  putCloudDocument: (...args: unknown[]) => putCloudDocument(...(args as [])),
  fetchCloudDocument: async () => { throw new FakeApiError('nope', 404); },
  PhysBoxApiError: FakeApiError,
}));

/** A scene whose JSON is `bytes` long, near enough. */
function documentOfSize(bytes: number): unknown {
  return { verts: 'v'.repeat(bytes) };
}

const MB = 1024 * 1024;

describe('cloud autosave size gate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    putCloudDocument.mockClear();
    /*
     * A fresh engine per test. The module holds one, and `useFakeTimers` resets
     * the clock to real time at the start of each test — so an engine carried
     * over from a test that advanced five minutes sees its own coalescing window
     * as five minutes in the future and quietly sits out the next one.
     */
    vi.resetModules();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses to upload a document bigger than the account takes, and says so plainly', async () => {
    const { cloudAutosave } = await import('../src/utils/cloudDocuments');

    cloudAutosave.schedule('relief', documentOfSize(40 * MB));
    await vi.advanceTimersByTimeAsync(300000);

    expect(putCloudDocument).not.toHaveBeenCalled();
    const status = cloudAutosave.getStatus();
    expect(status.state).toBe('offline');
    expect(status.message).toMatch(/Too big to sync/);
    // The number is in the message: "it did not work" is not actionable, "40.0 MB
    // of 31.0 MB" tells you what to take out.
    expect(status.message).toMatch(/40\.0 MB/);
  });

  it('starts saving again once the document is small enough, without a reload', async () => {
    const { cloudAutosave } = await import('../src/utils/cloudDocuments');

    cloudAutosave.schedule('relief', documentOfSize(40 * MB));
    await vi.advanceTimersByTimeAsync(300000);
    expect(putCloudDocument).not.toHaveBeenCalled();

    cloudAutosave.schedule('relief', { verts: 'v'.repeat(100) });
    await vi.advanceTimersByTimeAsync(300000);

    expect(putCloudDocument).toHaveBeenCalledTimes(1);
    expect(cloudAutosave.getStatus().state).toBe('saved');
  });

  it('uploads a relief-sized document, on a slower clock than a small one', async () => {
    const { cloudAutosave } = await import('../src/utils/cloudDocuments');

    cloudAutosave.schedule('relief', documentOfSize(20 * MB));

    // A small document goes after three seconds of quiet. Twenty megabytes of
    // vertices does not: re-uploading that every few seconds while the machine
    // is cutting is the behaviour this pacing exists to avoid.
    await vi.advanceTimersByTimeAsync(5000);
    expect(putCloudDocument).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20000);
    expect(putCloudDocument).toHaveBeenCalledTimes(1);
    expect(cloudAutosave.getStatus().state).toBe('saved');
  });
});
