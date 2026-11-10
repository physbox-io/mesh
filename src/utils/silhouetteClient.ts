// bestView on a worker: the same call as utils/silhouette.ts, async. Runs it
// directly where there is no Worker (Node, tests).

import { bestView, type Mask, type View, type ViewMatch } from './silhouette';
import type { BestViewRequest, SilhouetteResponse } from '../workers/silhouetteProtocol';
import { noteWorkerStopped } from './staleBuild';

const TIMEOUT_MS = 60_000;

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (m: ViewMatch | null) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    worker = new Worker(new URL('../workers/silhouetteWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (evt: MessageEvent<SilhouetteResponse>) => {
      const msg = evt.data;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.type === 'BEST_VIEW_DONE') p.resolve(msg.match);
      else p.reject(new Error(msg.error));
    };
    worker.onerror = () => {
      noteWorkerStopped();
      for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('The view search stopped working.')); }
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

export function bestViewOffThread(tris: ArrayLike<number>, photo: Mask, near?: View): Promise<ViewMatch | null> {
  const w = ensureWorker();
  if (!w) return Promise.resolve(bestView(tris, photo, near));
  const id = ++seq;
  const req: BestViewRequest = { type: 'BEST_VIEW', id, tris: Float32Array.from(tris), photo: photo.slice(), ...(near ? { near } : {}) };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      worker?.terminate();
      worker = null;
      reject(new Error('The view search took too long.'));
    }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    w.postMessage(req, [req.tris.buffer, req.photo.buffer]);
  });
}
