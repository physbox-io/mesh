// bestView on a worker: the same call as utils/silhouette.ts, async. Runs it
// directly where there is no Worker (Node, tests).

import { bestView, type Mask, type View, type ViewMatch } from './silhouette';
import type { BestViewRequest, SilhouetteResponse } from '../workers/silhouetteProtocol';
import { noteWorkerStopped } from './staleBuild';

const TIMEOUT_MS = 60_000;

interface QueuedView {
  id: number;
  tris: Float32Array;
  photo: Uint8Array;
  near?: View;
  resolve: (m: ViewMatch | null) => void;
  reject: (e: Error) => void;
}

let worker: Worker | null = null;
let seq = 0;
let active: (QueuedView & { timer: ReturnType<typeof setTimeout> }) | null = null;
const queued: QueuedView[] = [];

function dropWorker(w: Worker | null): void {
  if (w) {
    w.onmessage = null;
    w.onerror = null;
    w.onmessageerror = null;
    w.terminate();
  }
  if (worker === w) worker = null;
}

function failAll(error: string): void {
  if (active) {
    clearTimeout(active.timer);
    const done = active;
    active = null;
    done.reject(new Error(error));
  }
  while (queued.length > 0) queued.shift()!.reject(new Error(error));
}

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    const w = new Worker(new URL('../workers/silhouetteWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (evt: MessageEvent<SilhouetteResponse>) => {
      if (worker !== w) return;
      const msg = evt.data;
      if (!active || active.id !== msg.id) return;
      const done = active;
      active = null;
      clearTimeout(done.timer);
      if (msg.type === 'BEST_VIEW_DONE') done.resolve(msg.match);
      else done.reject(new Error(msg.error));
      pump();
    };
    const handleBroken = (error: string) => {
      if (worker !== w) return;
      noteWorkerStopped();
      dropWorker(w);
      failAll(error);
    };
    w.onerror = () => handleBroken('The view search stopped working.');
    w.onmessageerror = () => handleBroken('The view search could not read the worker response.');
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

function pump(): void {
  while (!active && queued.length > 0) {
    const next = queued.shift()!;
    const w = ensureWorker();
    if (!w) {
      try {
        next.resolve(bestView(next.tris, next.photo, next.near));
      } catch (err) {
        next.reject(err instanceof Error ? err : new Error(String(err)));
      }
      continue;
    }
    const timer = setTimeout(() => {
      if (active?.id !== next.id) return;
      const wedged = active;
      active = null;
      dropWorker(w);
      wedged.reject(new Error('The view search took too long.'));
      pump();
    }, TIMEOUT_MS);
    active = { ...next, timer };
    try {
      const req: BestViewRequest = {
        type: 'BEST_VIEW',
        id: next.id,
        tris: next.tris,
        photo: next.photo,
        ...(next.near ? { near: next.near } : {}),
      };
      const transfer: Transferable[] = [];
      if (req.tris.byteLength > 0) transfer.push(req.tris.buffer);
      if (req.photo.byteLength > 0) transfer.push(req.photo.buffer);
      w.postMessage(req, transfer);
      return;
    } catch (err) {
      clearTimeout(timer);
      active = null;
      next.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

export function bestViewOffThread(tris: ArrayLike<number>, photo: Mask, near?: View): Promise<ViewMatch | null> {
  if (typeof Worker === 'undefined') return Promise.resolve(bestView(tris, photo, near));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    queued.push({ id, tris: Float32Array.from(tris), photo: photo.slice(), near, resolve, reject });
    pump();
  });
}
