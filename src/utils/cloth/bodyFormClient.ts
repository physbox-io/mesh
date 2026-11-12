// Thin postMessage client over the body form worker: the worker in a browser,
// bodyForm.ts directly under Node, where `Worker` does not exist. Rejects with
// the reason on failure. The geoms come back raw; finishBodyFormGeoms
// (bodyFormEdit.ts) readies them for the node.

import type { BodyFormMeasurements } from '../../types/cloth';
import type { SceneGeom } from '../../types/scene';
import type { BodyFormRequest, BodyFormResponse } from '../../workers/bodyFormProtocol';
import { noteWorkerStopped } from '../staleBuild';

/** A form is a second or two. Past this the worker is wedged. */
const TIMEOUT_MS = 60_000;

interface Pending { resolve: (v: SceneGeom[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function failAll(error: string) {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(error));
  }
  pending.clear();
}

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    worker = new Worker(new URL('../../workers/bodyFormWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (evt: MessageEvent<BodyFormResponse>) => {
      const msg = evt.data;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.type === 'BUILT') p.resolve(msg.geoms);
      else p.reject(new Error(msg.error));
    };
    worker.onerror = () => {
      noteWorkerStopped();
      failAll('Building the dress form stopped working. Try again.');
      worker?.terminate();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

/** bodyFormGeoms, off the main thread. */
export async function buildBodyFormOffThread(measurements: BodyFormMeasurements, prefix: string): Promise<SceneGeom[]> {
  const w = ensureWorker();
  if (!w) {
    const { bodyFormGeoms } = await import('./bodyForm');
    return bodyFormGeoms(measurements, prefix);
  }
  const req: BodyFormRequest = { type: 'BUILD', id: ++seq, measurements, prefix };
  return new Promise<SceneGeom[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(req.id);
      worker?.terminate();
      worker = null;
      reject(new Error('Building the dress form took too long and was abandoned.'));
      failAll('Building the dress form took too long and was abandoned.');
    }, TIMEOUT_MS);
    pending.set(req.id, { resolve, reject, timer });
    w.postMessage(req);
  });
}
