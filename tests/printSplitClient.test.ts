import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setPrintSplitWorkerFactory,
  splitOffThread,
  cutAlongPlaneOffThread,
  testAssemblyOffThread,
  prewarmPrintSplit,
  type PrintSplitWorkerLike,
  type SplitOk,
} from '../src/utils/printSplitClient';
import type { PrintSplitRequest, PrintSplitResponse } from '../src/workers/printSplitProtocol';
import type { StageResult } from '../src/utils/printAssembly';

class FakeSplitWorker implements PrintSplitWorkerLike {
  onmessage: ((evt: MessageEvent<PrintSplitResponse>) => void) | null = null;
  onerror: ((evt: ErrorEvent) => void) | null = null;
  onmessageerror: ((evt: MessageEvent) => void) | null = null;
  posted: PrintSplitRequest[] = [];
  terminated = false;

  postMessage(message: PrintSplitRequest): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(msg: PrintSplitResponse): void {
    this.onmessage?.({ data: msg } as MessageEvent<PrintSplitResponse>);
  }

  emitError(): void {
    this.onerror?.({} as ErrorEvent);
  }

  emitMessageError(): void {
    this.onmessageerror?.({} as MessageEvent);
  }
}

const dummySoup = () => new Float64Array([0, 0, 0, 0.01, 0, 0, 0, 0.01, 0]);
const dummyBed = { widthMm: 200, depthMm: 200, heightMm: 200 };

const dummySplitOk = (): SplitOk => ({
  ok: true,
  sections: [],
  cuts: [],
  joints: [],
  tree: { section: 0 },
  joinery: { kind: 'none', diameterMm: 6, lengthMm: 20, clearanceMm: 0.2, minWallMm: 2 },
  warnings: [],
});

const dummyStageResult = (label: string, ok = true): StageResult => ({
  label,
  kind: 'join',
  cut: 0,
  ok,
  seated: ok,
  gapMm: 0,
  lateralMm: 0,
  angleDeg: 0,
  playMm: null,
  twistDeg: null,
  rotates: false,
  diverged: false,
  approximate: false,
  notes: [],
  frames: [],
});

describe('printSplitClient worker lifecycle, coalescing, and error recovery', () => {
  let workers: FakeSplitWorker[] = [];

  beforeEach(() => {
    workers = [];
    setPrintSplitWorkerFactory(() => {
      const w = new FakeSplitWorker();
      workers.push(w);
      return w;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    setPrintSplitWorkerFactory(null);
  });

  it('sends WARM on prewarmPrintSplit and reuses the single worker', () => {
    prewarmPrintSplit();
    expect(workers).toHaveLength(1);
    expect(workers[0].posted).toEqual([{ type: 'WARM' }]);
  });

  it('enforces single-flight dispatch and latest-wins coalescing for queued splitOffThread requests', async () => {
    const p1 = splitOffThread([dummySoup()], { bed: dummyBed, marginMm: 1 });
    const p2 = splitOffThread([dummySoup()], { bed: dummyBed, marginMm: 2 });
    const p3 = splitOffThread([dummySoup()], { bed: dummyBed, marginMm: 3 });
    const p4 = splitOffThread([dummySoup()], { bed: dummyBed, marginMm: 4 });

    expect(workers).toHaveLength(1);
    const w = workers[0];
    // Only the first request is dispatched while in-flight; 2 and 3 are superseded immediately.
    expect(w.posted).toHaveLength(1);
    const first = w.posted[0] as Extract<PrintSplitRequest, { type: 'SPLIT' }>;
    expect(first.type).toBe('SPLIT');
    expect(first.options.marginMm).toBe(1);

    const [r2, r3] = await Promise.all([p2, p3]);
    expect(r2.result.ok).toBe(false);
    if (!r2.result.ok) expect(r2.result.error).toMatch(/Superseded/i);
    expect(r3.result.ok).toBe(false);
    if (!r3.result.ok) expect(r3.result.error).toMatch(/Superseded/i);

    // Completing the first split dispatches only the latest queued split (marginMm: 4).
    const okSplit = dummySplitOk();
    w.emit({ type: 'SPLIT_DONE', id: first.id, result: okSplit, checks: null });

    const r1 = await p1;
    expect(r1.result).toEqual(okSplit);
    expect(w.posted).toHaveLength(2);
    const latest = w.posted[1] as Extract<PrintSplitRequest, { type: 'SPLIT' }>;
    expect(latest.type).toBe('SPLIT');
    expect(latest.options.marginMm).toBe(4);

    w.emit({ type: 'SPLIT_DONE', id: latest.id, result: okSplit, checks: null });
    const r4 = await p4;
    expect(r4.result).toEqual(okSplit);
  });

  it('resolves FAILED cleanly on split and plane cut, and rejects on assemble without killing the worker', async () => {
    const pSplit = splitOffThread([dummySoup()], { bed: dummyBed });
    const pPlane = cutAlongPlaneOffThread([dummySoup()], [0, 0, 0], [1, 0, 0]);
    const pAsm = testAssemblyOffThread(dummySplitOk());

    const w = workers[0];
    const req1 = w.posted[0] as Extract<PrintSplitRequest, { type: 'SPLIT' }>;
    w.emit({ type: 'FAILED', id: req1.id, error: 'Manifold exploded' });
    const splitRes = await pSplit;
    expect(splitRes.result).toEqual({ ok: false, error: 'Manifold exploded' });
    expect(w.terminated).toBe(false);

    const req2 = w.posted[1] as Extract<PrintSplitRequest, { type: 'PLANE_CUT' }>;
    w.emit({ type: 'FAILED', id: req2.id, error: 'Bad plane' });
    const planeRes = await pPlane;
    expect(planeRes).toEqual({ ok: false, error: 'Bad plane' });

    const req3 = w.posted[2] as Extract<PrintSplitRequest, { type: 'ASSEMBLE' }>;
    w.emit({ type: 'FAILED', id: req3.id, error: 'MuJoCo aborted: OOM' });
    await expect(pAsm).rejects.toThrow('MuJoCo aborted: OOM');
    expect(w.terminated).toBe(false);
  });

  it('handles worker.onerror and worker.onmessageerror by failing pending work, terminating, and respawning on retry', async () => {
    const p1 = splitOffThread([dummySoup()], { bed: dummyBed });
    const w1 = workers[0];
    w1.emitError();

    const r1 = await p1;
    expect(r1.result.ok).toBe(false);
    if (!r1.result.ok) expect(r1.result.error).toMatch(/stopped working/i);
    expect(w1.terminated).toBe(true);

    // Next request spawns a fresh worker and tests onmessageerror.
    const p2 = cutAlongPlaneOffThread([dummySoup()], [0, 0, 0], [0, 0, 1]);
    expect(workers).toHaveLength(2);
    const w2 = workers[1];
    w2.emitMessageError();

    const r2 = await p2;
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toMatch(/could not read/i);
    expect(w2.terminated).toBe(true);

    // Retry succeeds on a third fresh worker.
    const p3 = cutAlongPlaneOffThread([dummySoup()], [0, 0, 0], [0, 0, 1]);
    expect(workers).toHaveLength(3);
    const w3 = workers[2];
    const req3 = w3.posted[0] as Extract<PrintSplitRequest, { type: 'PLANE_CUT' }>;
    w3.emit({ type: 'PLANE_CUT_DONE', id: req3.id, result: { ok: true, sections: [] } });
    expect(await p3).toEqual({ ok: true, sections: [] });
  });

  it('recovers from timeout by terminating the wedged worker and running queued requests on a fresh worker', async () => {
    vi.useFakeTimers();

    const pSplit = splitOffThread([dummySoup()], { bed: dummyBed });
    const pPlane = cutAlongPlaneOffThread([dummySoup()], [0, 0, 0], [1, 0, 0]);

    expect(workers).toHaveLength(1);
    const w1 = workers[0];
    expect(w1.posted).toHaveLength(1);

    // Advance past SPLIT_TIMEOUT_MS (120 s).
    vi.advanceTimersByTime(120_000);

    const splitRes = await pSplit;
    expect(splitRes.result).toEqual({ ok: false, error: 'The split took too long and was abandoned.' });
    expect(w1.terminated).toBe(true);

    // The queued plane cut was never sent to the wedged worker, so it spawns a
    // fresh worker and completes cleanly instead of failing with the split timeout.
    expect(workers).toHaveLength(2);
    const w2 = workers[1];
    expect(w2.posted).toHaveLength(1);
    const req2 = w2.posted[0] as Extract<PrintSplitRequest, { type: 'PLANE_CUT' }>;
    expect(req2.type).toBe('PLANE_CUT');
    w2.emit({ type: 'PLANE_CUT_DONE', id: req2.id, result: { ok: true, sections: [] } });
    expect(await pPlane).toEqual({ ok: true, sections: [] });
  });

  it('resets the stage timeout on ASSEMBLE_PROGRESS and delivers all progress events', async () => {
    vi.useFakeTimers();
    const seen: { done: number; total: number; label: string }[] = [];
    const p = testAssemblyOffThread(dummySplitOk(), (done, total, result) => {
      seen.push({ done, total, label: result.label });
    });

    const w = workers[0];
    const req = w.posted[0] as Extract<PrintSplitRequest, { type: 'ASSEMBLE' }>;
    // 50 s passes (< 60 s stage timeout), then stage 1 reports progress, resetting the timer.
    vi.advanceTimersByTime(50_000);
    const s1 = dummyStageResult('stage-1');
    w.emit({ type: 'ASSEMBLE_PROGRESS', id: req.id, done: 1, total: 2, result: s1 });

    // Another 50 s passes (100 s total, still < 60 s since stage 1) — must not time out!
    vi.advanceTimersByTime(50_000);
    const s2 = dummyStageResult('stage-2');
    w.emit({ type: 'ASSEMBLE_PROGRESS', id: req.id, done: 2, total: 2, result: s2 });
    w.emit({ type: 'ASSEMBLE_DONE', id: req.id });

    const out = await p;
    expect(out.results).toEqual([s1, s2]);
    expect(seen).toEqual([
      { done: 1, total: 2, label: 'stage-1' },
      { done: 2, total: 2, label: 'stage-2' },
    ]);
  });
});
