import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * A localStorage that counts its writes and can be told to run out of room.
 *
 * Both are the point. The whole design of the checkpoint is about how *often* it
 * writes — a storage write per G-code block, on the thread pacing a serial port,
 * is the thing it exists to avoid — and about what happens when a program is too
 * big to hold, which is the ordinary case for a long relief and cannot be
 * provoked any other way.
 */
class FakeStorage {
  private map = new Map<string, string>();
  limit = Infinity;
  writes = 0;
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); this.writes = 0; }
  setItem(k: string, v: string) {
    if (v.length > this.limit) {
      const err = new Error('quota') as Error & { name: string };
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.writes++;
    this.map.set(k, v);
  }
}

const store = new FakeStorage();
vi.stubGlobal('localStorage', store);

const account = {
  token: null as string | null,
  pro: false,
  docs: new Map<string, unknown>(),
  puts: 0,
  deletes: 0,
};

vi.mock('../src/utils/apiClient', () => ({
  getStoredAuthToken: () => account.token,
  isProAccount: () => account.pro,
  putCloudDocument: async ({ id, data }: { id: string; data: unknown }) => {
    account.puts++;
    account.docs.set(id, data);
    return { id, revision: 1 };
  },
  fetchCloudDocument: async (id: string) => {
    if (!account.docs.has(id)) throw new Error('404');
    return { id, data: account.docs.get(id) };
  },
  fetchCloudDocuments: async () =>
    [...account.docs.keys()].map((id) => ({ id, updatedAt: '2026-09-20T00:00:00Z' })),
  deleteCloudDocument: async (id: string) => {
    account.deletes++;
    account.docs.delete(id);
    return true;
  },
}));

import {
  adoptCheckpoint,
  beginCheckpoint,
  recordProgress,
  clearCheckpoint,
  loadCheckpoint,
  getCheckpointStatus,
  subscribeRemoteJob,
  CHECKPOINT_LIMITS,
  type RemoteJob,
} from '../src/utils/jobCheckpoint';

/** A program of roughly the requested size, in lines a G-code parser would take. */
function program(bytes: number): { gcode: string; totalLines: number } {
  const line = 'G1 X10.000 Y10.000 Z-1.000 F600';
  const count = Math.max(1, Math.ceil(bytes / (line.length + 1)));
  return { gcode: Array(count).fill(line).join('\n'), totalLines: count };
}

/** Lets the fire-and-forget cloud writes settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  store.clear();
  store.limit = Infinity;
  account.token = null;
  account.pro = false;
  account.docs.clear();
  account.puts = 0;
  account.deletes = 0;
  clearCheckpoint();
  store.clear();
  vi.useRealTimers();
});

describe('checkpointing a running job', () => {
  it('offers a job back after the session that was streaming it has gone', async () => {
    const p = program(4000);
    beginCheckpoint({ ...p, jobName: 'Relief carve' });
    recordProgress(1800, 'streaming', true);

    const found = await loadCheckpoint();
    expect(found).not.toBeNull();
    expect(found!.source).toBe('local');
    expect(found!.approximate).toBe(false);
    expect(found!.progress.fromLine).toBe(1800);
    expect(found!.program.jobName).toBe('Relief carve');
    // The program itself has to come back, not just the line: without it
    // `resumeFromLine` has nothing to replay and nothing to stream.
    expect(found!.program.gcode).toBe(p.gcode);
  });

  it('remembers the tool change a stopped job was waiting at', async () => {
    beginCheckpoint({ ...program(4000), jobName: 'Relief carve' });
    const pause = { kind: 'tool-change' as const, message: 'Tool change: fit the 1.5875 mm ball nose.' };
    recordProgress(2075, 'alarm', true, pause);

    const found = await loadCheckpoint();
    expect(found!.progress.fromLine).toBe(2075);
    expect(found!.progress.pendingPause).toEqual(pause);
  });

  it('does not offer a job that had cut nothing', async () => {
    beginCheckpoint(program(4000));
    // begin records line 0 on its own; nothing else has happened.
    expect(await loadCheckpoint()).toBeNull();
  });

  it('forgets the job when it is cleared', async () => {
    beginCheckpoint(program(4000));
    recordProgress(900, 'streaming', true);
    clearCheckpoint();

    expect(await loadCheckpoint()).toBeNull();
    expect(getCheckpointStatus().active).toBe(false);
  });

  it('will not apply a progress record to a different program', async () => {
    beginCheckpoint(program(4000));
    recordProgress(900, 'streaming', true);
    // A second job starts and is checkpointed over the first. The stale progress
    // record, if it were honoured, would resume the new program at the old
    // program's line — an arbitrary point in the wrong file.
    const second = program(8000);
    beginCheckpoint(second);

    expect(await loadCheckpoint()).toBeNull();
  });

  it('ignores a checkpoint old enough that the work has come off the machine', async () => {
    beginCheckpoint(program(4000));
    recordProgress(900, 'streaming', true);

    const real = Date.now;
    Date.now = () => real() + CHECKPOINT_LIMITS.TTL_MS + 1000;
    try {
      expect(await loadCheckpoint()).toBeNull();
    } finally {
      Date.now = real;
    }
  });
});

describe('how often it writes', () => {
  it('throttles progress to the interval, not to the G-code line', () => {
    beginCheckpoint(program(4000));
    const before = store.writes;

    // What the streamer actually does: one call per line sent.
    for (let i = 1; i <= 5000; i++) recordProgress(i, 'streaming');

    // One write at most for the whole burst, because no time has passed.
    expect(store.writes - before).toBeLessThanOrEqual(1);
  });

  it('writes immediately for the stops that may be followed by the tab closing', () => {
    beginCheckpoint(program(4000));
    for (let i = 1; i <= 100; i++) recordProgress(i, 'streaming');
    const before = store.writes;

    recordProgress(100, 'disconnected', true);

    expect(store.writes - before).toBe(1);
    const saved = JSON.parse(store.getItem('physics_job_checkpoint_progress')!);
    expect(saved.fromLine).toBe(100);
    expect(saved.reason).toBe('disconnected');
  });
});

describe('a program too big for the browser', () => {
  it('says so rather than silently keeping nothing', () => {
    const big = program(CHECKPOINT_LIMITS.MAX_LOCAL_BYTES + 1024);
    const status = beginCheckpoint(big);

    expect(status.local).toBe(false);
    expect(status.tooLargeForLocal).toBe(true);
    expect(status.bytes).toBeGreaterThan(CHECKPOINT_LIMITS.MAX_LOCAL_BYTES);
  });

  it('survives storage that refuses the write outright', () => {
    store.limit = 500;
    const status = beginCheckpoint(program(4000));

    // No throw, and an honest answer. A checkpoint that cannot be written is
    // never a reason to refuse to run the job.
    expect(status.local).toBe(false);
    expect(status.active).toBe(true);
  });

  it('keeps it in the account instead, when the account is Pro', async () => {
    account.token = 'tok';
    account.pro = true;

    const big = program(CHECKPOINT_LIMITS.MAX_LOCAL_BYTES + 1024);
    beginCheckpoint({ ...big, jobName: 'Long relief' });
    recordProgress(12000, 'disconnected', true);
    await settle();

    expect(getCheckpointStatus().cloud).toBe(true);

    // Now lose the browser's storage entirely — cleared site data, or a
    // different laptop — and the job must still come back.
    const install = store.getItem('physics_job_checkpoint_install');
    store.clear();
    if (install) store.setItem('physics_job_checkpoint_install', install);

    const found = await loadCheckpoint();
    expect(found).not.toBeNull();
    expect(found!.source).toBe('cloud');
    expect(found!.progress.fromLine).toBe(12000);
    expect(found!.program.gcode).toBe(big.gcode);
    // A cloud line is written on a slow clock, so it may be behind the cut.
    expect(found!.approximate).toBe(true);
  });

  it('finds the job from a browser that never held the id', async () => {
    account.token = 'tok';
    account.pro = true;
    beginCheckpoint({ ...program(4000), jobName: 'Tray' });
    recordProgress(600, 'alarm', true);
    await settle();

    // Everything local gone, including the install id that addresses the
    // records — the case of picking the job up on a second machine.
    store.clear();

    const found = await loadCheckpoint();
    expect(found).not.toBeNull();
    expect(found!.program.jobName).toBe('Tray');
    expect(found!.progress.fromLine).toBe(600);
  });

  it('does not touch the network for a free account', async () => {
    account.token = 'tok';
    account.pro = false;
    beginCheckpoint(program(4000));
    recordProgress(500, 'cancelled', true);
    await settle();

    expect(account.puts).toBe(0);
    expect(getCheckpointStatus().cloud).toBe(false);
  });

  it('writes to the account far less often than to the browser', async () => {
    account.token = 'tok';
    account.pro = true;
    beginCheckpoint(program(4000));
    await settle();
    const afterBegin = account.puts;

    // A minute of streaming, ticked a line at a time, must not be a minute of
    // HTTP: every one of these would be a revision on the document.
    for (let i = 1; i <= 20000; i++) recordProgress(i, 'streaming');
    await settle();

    expect(account.puts - afterBegin).toBe(0);
  });

  it('removes what it left in the account when the job is done', async () => {
    account.token = 'tok';
    account.pro = true;
    beginCheckpoint(program(4000));
    recordProgress(400, 'streaming', true);
    await settle();

    clearCheckpoint();
    await settle();

    expect(account.deletes).toBeGreaterThan(0);
    expect(account.docs.size).toBe(0);
  });
});

describe('carrying on after a restore', () => {
  it('writes the recovered program back to this browser, so a second stop is local', async () => {
    account.token = 'tok';
    account.pro = true;
    const p = program(4000);
    beginCheckpoint({ ...p, jobName: 'Sign' });
    recordProgress(700, 'disconnected', true);
    await settle();

    // Recovered on a machine with nothing in storage.
    store.clear();
    const found = await loadCheckpoint();
    expect(found!.source).toBe('cloud');

    adoptCheckpoint(found!.program);
    recordProgress(1400, 'alarm', true);

    // The second interruption must be answerable without the network: the
    // account is where this came from, not where it has to keep living.
    account.docs.clear();
    const again = await loadCheckpoint();
    expect(again).not.toBeNull();
    expect(again!.source).toBe('local');
    expect(again!.progress.fromLine).toBe(1400);
    expect(again!.program.gcode).toBe(p.gcode);
  });
});

/** What the lookup last said about a job running somewhere else. */
function remoteJob(): RemoteJob | null {
  let seen: RemoteJob | null = null;
  subscribeRemoteJob((j) => (seen = j))();
  return seen;
}

/** Rewrites the stored progress record as if another writer had made it. */
function signLocalProgress(patch: Record<string, unknown>): void {
  const key = 'physics_job_checkpoint_progress';
  const rec = JSON.parse(store.getItem(key)!);
  store.setItem(key, JSON.stringify({ ...rec, ...patch, writer: { ...rec.writer, ...(patch.writer as object) } }));
}

describe('a job still running somewhere else', () => {
  it('is not offered as interrupted while another tab of this browser is writing it', async () => {
    beginCheckpoint({ ...program(4000), jobName: 'Tray' });
    recordProgress(1500, 'streaming', true);
    signLocalProgress({ writer: { tab: 'tab_other' } });

    expect(await loadCheckpoint()).toBeNull();
    expect(remoteJob()).toMatchObject({ jobName: 'Tray', fromLine: 1500, where: 'tab' });
  });

  it('is offered once that tab has gone quiet', async () => {
    beginCheckpoint(program(4000));
    recordProgress(1500, 'streaming', true);
    signLocalProgress({
      writer: { tab: 'tab_other' },
      at: Date.now() - CHECKPOINT_LIMITS.LIVE_LOCAL_MS - 1000,
    });

    const found = await loadCheckpoint();
    expect(found).not.toBeNull();
    expect(found!.progress.fromLine).toBe(1500);
    expect(remoteJob()).toBeNull();
  });

  it('offers a job this same tab left behind straight away, as after a reload', async () => {
    beginCheckpoint(program(4000));
    recordProgress(800, 'streaming', true);

    expect(await loadCheckpoint()).not.toBeNull();
    expect(remoteJob()).toBeNull();
  });

  it('recognises a job another machine on the account is streaming', async () => {
    account.token = 'tok';
    account.pro = true;
    beginCheckpoint({ ...program(4000), jobName: 'Oak tray' });
    recordProgress(2200, 'streaming', true);
    await settle();

    // A second computer: nothing local, its own install id.
    store.clear();

    expect(await loadCheckpoint()).toBeNull();
    expect(remoteJob()).toMatchObject({ jobName: 'Oak tray', fromLine: 2200, where: 'device' });
  });

  it('offers the other machine\'s job once its record is stale', async () => {
    account.token = 'tok';
    account.pro = true;
    beginCheckpoint(program(4000));
    recordProgress(2200, 'streaming', true);
    await settle();
    const progressId = [...account.docs.keys()].find((k) => k.startsWith('mesh-job-progress-'))!;
    const rec = account.docs.get(progressId) as { at: number };
    account.docs.set(progressId, { ...rec, at: Date.now() - CHECKPOINT_LIMITS.LIVE_CLOUD_MS - 1000 });
    store.clear();

    const found = await loadCheckpoint();
    expect(found).not.toBeNull();
    expect(found!.source).toBe('cloud');
  });

  it('keeps the record fresh while the job waits at a tool change, and stops once it has stopped', () => {
    vi.useFakeTimers();
    beginCheckpoint(program(4000));
    recordProgress(900, 'streaming', true);
    const key = 'physics_job_checkpoint_progress';
    const first = JSON.parse(store.getItem(key)!).at;

    // Twenty minutes standing at a tool change: no lines go out.
    vi.advanceTimersByTime(20 * 60 * 1000);
    const later = JSON.parse(store.getItem(key)!);
    expect(later.at - first).toBeGreaterThan(19 * 60 * 1000);
    expect(later.fromLine).toBe(900);

    // An alarm ends it; the heartbeat must not dress the stop up as live.
    recordProgress(950, 'alarm', true);
    const stopped = JSON.parse(store.getItem(key)!).at;
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(JSON.parse(store.getItem(key)!).at).toBe(stopped);
  });
});
