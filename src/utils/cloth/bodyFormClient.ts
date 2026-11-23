// Thin postMessage client over the body form worker: the worker in a browser,
// bodyForm.ts directly under Node, where `Worker` does not exist. Rejects with
// the reason on failure. The geoms come back raw; finishBodyFormGeoms
// (bodyFormEdit.ts) readies them for the node.

import type { BodyFormMeasurements } from '../../types/cloth';
import type { SceneGeom } from '../../types/scene';
import type { BodyFormRequest, BodyFormResponse } from '../../workers/bodyFormProtocol';
import { noteWorkerStopped } from '../staleBuild';

/** A form is a second or two. Past this the worker is wedged on the active job. */
const TIMEOUT_MS = 60_000;

interface Job {
  id: number;
  key: string;
  exact: string;
  measurements: BodyFormMeasurements;
  prefix: string;
  resolve: (v: SceneGeom[]) => void;
  reject: (e: Error) => void;
}

let worker: Worker | null = null;
let seq = 0;
let active: (Job & { timer: ReturnType<typeof setTimeout> }) | null = null;
const queued: Job[] = [];

/** Error code set when a queued request was superseded by a newer one for the same key before starting. */
export class BodyFormSupersededError extends Error {
  readonly superseded = true;
  constructor() { super('Body form build superseded by a newer edit.'); }
}

function dropWorker(w: Worker | null): void {
  if (w) {
    w.onmessage = null;
    w.onerror = null;
    w.onmessageerror = null;
    w.terminate();
  }
  if (worker === w) worker = null;
}

function pump() {
  while (!active && queued.length > 0) {
    const w = ensureWorker();
    const next = queued.shift()!;
    if (!w) {
      import('./bodyForm')
        .then(({ bodyFormGeoms }) => next.resolve(bodyFormGeoms(next.measurements, next.prefix)))
        .catch((err) => next.reject(err instanceof Error ? err : new Error(String(err))))
        .finally(pump);
      return;
    }
    const timer = setTimeout(() => {
      if (active?.id !== next.id) return;
      const wedged = active;
      active = null;
      dropWorker(w);
      wedged.reject(new Error('Building the dress form took too long and was abandoned.'));
      // Innocent queued jobs run on a fresh worker rather than being poisoned by the wedged one.
      pump();
    }, TIMEOUT_MS);
    active = { ...next, timer };
    const req: BodyFormRequest = { type: 'BUILD', id: next.id, measurements: next.measurements, prefix: next.prefix };
    try {
      w.postMessage(req);
      return;
    } catch (err) {
      clearTimeout(timer);
      active = null;
      next.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    const w = new Worker(new URL('../../workers/bodyFormWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (evt: MessageEvent<BodyFormResponse>) => {
      if (worker !== w) return;
      const msg = evt.data;
      if (!active || active.id !== msg.id) return;
      const done = active;
      active = null;
      clearTimeout(done.timer);
      if (msg.type === 'BUILT') done.resolve(msg.geoms);
      else done.reject(new Error(msg.error));
      pump();
    };
    const handleBroken = (error: string) => {
      if (worker !== w) return;
      noteWorkerStopped();
      const crashed = active;
      active = null;
      if (crashed) clearTimeout(crashed.timer);
      dropWorker(w);
      crashed?.reject(new Error(error));
      pump();
    };
    w.onerror = () => handleBroken('Building the dress form stopped working. Try again.');
    w.onmessageerror = () => handleBroken('Building the dress form could not read the worker response. Try again.');
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

/**
 * bodyFormGeoms, off the main thread. Queued builds for the same `key` (default
 * `prefix`) coalesce so rapid slider drags never pile up behind the worker, and
 * a timeout only fails the active wedged job.
 */
export async function buildBodyFormOffThread(measurements: BodyFormMeasurements, prefix: string, key = prefix): Promise<SceneGeom[]> {
  if (typeof Worker === 'undefined') {
    const { bodyFormGeoms } = await import('./bodyForm');
    return bodyFormGeoms(measurements, prefix);
  }
  const exact = JSON.stringify([key, prefix, measurements]);
  // Join an identical active request (when no newer edit for the same key is queued after it).
  if (active && active.exact === exact && !queued.some((q) => q.key === key)) {
    const target = active;
    return new Promise<SceneGeom[]>((resolve, reject) => {
      const r0 = target.resolve, j0 = target.reject;
      target.resolve = (v) => { r0(v); resolve(v); };
      target.reject = (e) => { j0(e); reject(e); };
    });
  }
  // Join an identical queued request, or supersede an older unstarted one for the same key.
  for (let i = 0; i < queued.length; i++) {
    const q = queued[i];
    if (q.key !== key) continue;
    if (q.exact === exact) {
      return new Promise<SceneGeom[]>((resolve, reject) => {
        const r0 = q.resolve, j0 = q.reject;
        q.resolve = (v) => { r0(v); resolve(v); };
        q.reject = (e) => { j0(e); reject(e); };
      });
    }
    queued.splice(i, 1);
    q.reject(new BodyFormSupersededError());
    break;
  }
  const id = ++seq;
  return new Promise<SceneGeom[]>((resolve, reject) => {
    queued.push({ id, key, exact, measurements, prefix, resolve, reject });
    pump();
  });
}
