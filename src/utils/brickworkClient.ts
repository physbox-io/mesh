// Thin postMessage client over the brickwork worker: the worker in a browser,
// utils/brickwork.ts directly under Node, where `Worker` does not exist.
// Rejects with the reason on failure.

import type { SceneGraph } from '../types/scene';
import type { BrickworkOutcome, BrickworkRequest, BrickworkRequestOptions, BrickworkResponse } from '../workers/brickworkProtocol';
import { noteWorkerStopped } from './staleBuild';

export type { BrickworkOutcome, BrickworkRequestOptions };

/** A house is a few seconds. Past this the worker is wedged. */
const TIMEOUT_MS = 120_000;

interface Pending { resolve: (v: BrickworkOutcome) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

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
    worker = new Worker(new URL('../workers/brickworkWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (evt: MessageEvent<BrickworkResponse>) => {
      const msg = evt.data;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.type === 'LAY_DONE') p.resolve(msg.outcome);
      else p.reject(new Error(msg.error));
    };
    worker.onerror = () => {
      noteWorkerStopped();
      failAll('Brickwork stopped working. Try again.');
      worker?.terminate();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

/** brickworkInScene, off the main thread. */
export async function layBricksOffThread(scene: SceneGraph, bodyId: string | null, options: BrickworkRequestOptions = {}): Promise<BrickworkOutcome> {
  const w = ensureWorker();
  if (!w) {
    const { brickworkInScene } = await import('./brickwork');
    return brickworkInScene(scene, bodyId, options);
  }
  return new Promise<BrickworkOutcome>((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      worker?.terminate();
      worker = null;
      reject(new Error('Laying the bricks took too long and was abandoned.'));
      failAll('Laying the bricks took too long and was abandoned.');
    }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    w.postMessage({ type: 'LAY', id, scene, bodyId, options } satisfies BrickworkRequest);
  });
}
