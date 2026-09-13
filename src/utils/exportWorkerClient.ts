// ---------------------------------------------------------------------------
// The export modals' end of the heavy-export worker
// ---------------------------------------------------------------------------
//
// One worker per open modal, torn down with it. Requests are numbered and
// answered in order — the worker handles one message at a time — so the caller
// tells a stale answer from the current one by its id and drops what it no
// longer wants. The `useExportJob` hook wraps all of that: a modal hands it a
// job and its dependencies and gets back the last finished result, whether it
// is busy, and any failure.
//
// Falls back to running inline where there is no Worker at all (a test
// environment, an ancient browser). That path blocks the caller, which is the
// thing this module exists to avoid, but a modal that works slowly beats one
// that does not work.

import { useEffect, useRef, useState, type DependencyList } from 'react';
import {
  runExportJob,
  type ExportJobKind,
  type ExportJobOptions,
  type ExportJobResult,
} from './exportJobs';
import type { SceneGraph } from '../types/scene';

type Settle = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class ExportWorkerClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Settle>();
  /** The scene the worker already holds, so an options change sends options alone. */
  private sceneSent: SceneGraph | null = null;

  constructor() {
    if (typeof Worker === 'undefined') return;
    try {
      this.worker = new Worker(new URL('../workers/exportWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (evt: MessageEvent) => {
        const msg = evt.data;
        const settle = this.pending.get(msg.id);
        if (!settle) return;
        this.pending.delete(msg.id);
        if (msg.type === 'FAILED') settle.reject(new Error(msg.message));
        else if (msg.type === 'DONE') settle.resolve(msg.result);
      };
      // A worker that dies leaves every caller awaiting forever otherwise.
      this.worker.onerror = () => {
        const failed = new Error('The export worker stopped.');
        for (const settle of this.pending.values()) settle.reject(failed);
        this.pending.clear();
        this.sceneSent = null;
      };
    } catch {
      this.worker = null;
    }
  }

  run<K extends ExportJobKind>(
    kind: K,
    scene: SceneGraph,
    options: ExportJobOptions<K>
  ): Promise<ExportJobResult<K>> {
    if (!this.worker) return Promise.resolve(runExportJob(kind, scene, options));

    const fresh = scene !== this.sceneSent;
    this.sceneSent = scene;
    const id = ++this.seq;
    return new Promise<ExportJobResult<K>>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker!.postMessage({ type: 'RUN', id, kind, options, ...(fresh ? { scene } : {}) });
    });
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
    this.sceneSent = null;
  }
}

/**
 * Runs a heavy export on a worker and hands back its latest result.
 *
 * One worker lives for as long as the modal is open. Whenever `deps` change the
 * modal's `request` is run again; the answer that comes back sets `result`,
 * unless a newer request has already superseded it. `busy` is true while one is
 * in flight, so the dialog can say it is a moment behind without blanking the
 * preview it already has. A `request` that returns null is a job not worth
 * running yet, and leaves the last result standing.
 *
 * `request` may close over anything; it is read fresh each run, so only `deps`
 * decides when it re-runs — the same contract as `useEffect`.
 */
export function useExportJob<TRes>(
  isOpen: boolean,
  request: (client: ExportWorkerClient) => Promise<TRes> | null,
  deps: DependencyList
): { result: TRes | null; busy: boolean; failure: string | null } {
  const clientRef = useRef<ExportWorkerClient | null>(null);
  const [result, setResult] = useState<TRes | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Declared before the run effect so it is set by the time that effect first
  // fires on the same commit.
  useEffect(() => {
    if (!isOpen) return;
    const client = new ExportWorkerClient();
    clientRef.current = client;
    return () => {
      client.dispose();
      clientRef.current = null;
      setResult(null);
      setFailure(null);
    };
  }, [isOpen]);

  // The request closes over live values; kept in a ref so the effect below runs
  // the current one without naming it as a dependency. Updated in its own effect
  // rather than during render, and declared before the run effect so it is
  // current by the time that one fires.
  const requestRef = useRef(request);
  useEffect(() => {
    requestRef.current = request;
  });

  useEffect(() => {
    const client = clientRef.current;
    if (!isOpen || !client) return;
    const promise = requestRef.current(client);
    if (!promise) return;

    let live = true;
    setBusy(true);
    promise
      .then((next) => {
        if (!live) return;
        setResult(next);
        setFailure(null);
      })
      .catch((e: Error) => {
        if (live) setFailure(e.message);
      })
      .finally(() => {
        if (live) setBusy(false);
      });

    // A superseded request is dropped here rather than racing the one that
    // replaced it; the worker still answers in order.
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, ...deps]);

  return { result, busy, failure };
}
