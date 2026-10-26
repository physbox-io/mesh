// ---------------------------------------------------------------------------
// The DFM lens's end of the DFM worker
// ---------------------------------------------------------------------------
//
// The panel, the heat map on the parts and the weak-spot markers all read the
// same analyses of the same scene. They ask here, and each analysis runs once
// per scene and lens on workers/dfmWorker.ts; the answer is kept against the
// scene graph object, which is never edited in place, so the next view that
// asks gets it at once.
//
// One job runs at a time and the rest wait. An edit makes a new scene, and any
// job still waiting on an older one is dropped unrun: dragging a slider asks
// for an analysis per tick, and only the last is worth the worker's time.
//
// Where there is no Worker (the tests, under Node) the analysis runs inline,
// through the same cache.

import { useEffect, useState } from 'react';
import type { SceneGraph } from '../types/scene';
import { analyseDfm, type DfmProcess, type DfmReport } from './dfm';
import { structuralWeakSpots, type WeakSpot } from './printAnalysis';
import { noteWorkerStopped } from './staleBuild';
import type { DfmBenchArgs, DfmRequest, DfmResponse } from '../workers/dfmProtocol';

type Ask = { type: 'DFM'; process: DfmProcess; bench: DfmBenchArgs } | { type: 'WEAK_SPOTS' };
type Job = { id: number; key: string; scene: SceneGraph; ask: Ask; settle: (result: unknown) => void };

const results = new WeakMap<SceneGraph, Map<string, unknown>>();
const inFlight = new WeakMap<SceneGraph, Map<string, Promise<unknown>>>();

let worker: Worker | null = null;
let seq = 0;
let running: Job | null = null;
let queue: Job[] = [];
/** The scene the worker already holds, so a second lens on it sends no scene. */
let sceneSent: SceneGraph | null = null;

function ensureWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    const w = new Worker(new URL('../workers/dfmWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (evt: MessageEvent<DfmResponse>) => {
      const msg = evt.data;
      const job = running;
      if (!job || job.id !== msg.id) return;
      running = null;
      const result = msg.type === 'DFM_DONE' ? msg.report : msg.type === 'WEAK_SPOTS_DONE' ? msg.weakSpots : null;
      if (result !== null) remember(job.scene, job.key, result);
      job.settle(result);
      pump();
    };
    // Every caller would wait for good otherwise. The next request starts a
    // fresh worker; starting one here would loop load-fail-respawn for as long
    // as the tab is out of date, which is the usual reason it never loaded.
    w.onerror = () => {
      noteWorkerStopped();
      for (const job of [...(running ? [running] : []), ...queue]) job.settle(null);
      running = null;
      queue = [];
      sceneSent = null;
      w.terminate();
      if (worker === w) worker = null;
    };
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

function remember(scene: SceneGraph, key: string, result: unknown) {
  let byKey = results.get(scene);
  if (!byKey) results.set(scene, (byKey = new Map()));
  byKey.set(key, result);
}

function pump() {
  if (running || !worker) return;
  const job = queue.shift();
  if (!job) return;
  running = job;
  const fresh = job.scene !== sceneSent;
  sceneSent = job.scene;
  const msg: DfmRequest = { ...job.ask, id: job.id, ...(fresh ? { scene: job.scene } : {}) };
  worker.postMessage(msg);
}

function inline(scene: SceneGraph, ask: Ask): unknown {
  try {
    return ask.type === 'DFM' ? analyseDfm(scene, ask.process, ask.bench) : structuralWeakSpots(scene);
  } catch {
    return null;
  }
}

/** Resolves null when the analysis failed, or was dropped for a newer scene; never rejects. */
function request(scene: SceneGraph, key: string, ask: Ask): Promise<unknown> {
  const hit = results.get(scene)?.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const pending = inFlight.get(scene)?.get(key);
  if (pending) return pending;

  const w = ensureWorker();
  if (!w) {
    const result = inline(scene, ask);
    if (result !== null) remember(scene, key, result);
    return Promise.resolve(result);
  }
  const stale = queue.filter((job) => job.scene !== scene);
  queue = queue.filter((job) => job.scene === scene);
  for (const job of stale) job.settle(null);

  const job = new Promise<unknown>((resolve) => {
    queue.push({ id: ++seq, key, scene, ask, settle: resolve });
  });
  let byKey = inFlight.get(scene);
  if (!byKey) inFlight.set(scene, (byKey = new Map()));
  byKey.set(key, job);
  void job.finally(() => inFlight.get(scene)?.delete(key));
  pump();
  return job;
}

const dfmKey = (process: DfmProcess, bench: DfmBenchArgs) => JSON.stringify(['dfm', process, bench]);
const WEAK_SPOTS_KEY = 'weakSpots';

/**
 * The latest answer for (scene, key), or null while `key` is null.
 *
 * While a new answer is being worked out the last one stands, so an edit
 * leaves the panel and the heat map a moment behind rather than blank.
 */
function useAnalysis<T>(scene: SceneGraph | null, key: string | null, ask: Ask): T | null {
  const [last, setLast] = useState<T | null>(null);
  const hit = scene && key ? (results.get(scene)?.get(key) as T | undefined) : undefined;
  // Closing the lens forgets it, so opening it again never shows an answer
  // from before. Set during render, React's pattern for state that follows a prop.
  if ((!scene || !key) && last !== null) setLast(null);

  useEffect(() => {
    if (!scene || !key) return;
    let live = true;
    void request(scene, key, ask).then((result) => {
      if (live && result !== null) setLast(result as T);
    });
    return () => {
      live = false;
    };
    // `ask` is described in full by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, key]);

  if (!scene || !key) return null;
  return hit ?? last;
}

/** The DFM report for one lens, worked out off the main thread. Null while `process` is. */
export function useDfmReport(scene: SceneGraph | null, process: DfmProcess | null, bench: DfmBenchArgs): DfmReport | null {
  const key = process ? dfmKey(process, bench) : null;
  return useAnalysis<DfmReport>(scene, key, process ? { type: 'DFM', process, bench } : { type: 'WEAK_SPOTS' });
}

/** The structural weak spots (see printAnalysis.structuralWeakSpots), off the main thread. Null while `enabled` is false. */
export function useStructuralWeakSpots(scene: SceneGraph | null, enabled: boolean): WeakSpot[] | null {
  return useAnalysis<WeakSpot[]>(scene, enabled ? WEAK_SPOTS_KEY : null, { type: 'WEAK_SPOTS' });
}
