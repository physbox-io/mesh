// Thin postMessage client over the brickwork worker: the worker in a browser,
// utils/brickwork.ts directly under Node, where `Worker` does not exist.
// Rejects with the reason on failure.

import type { BrickworkSource, SceneGeom, SceneGraph } from '../types/scene';
import type { BrickworkOutcome, BrickworkRequest, BrickworkRequestOptions, BrickworkResponse } from '../workers/brickworkProtocol';
import { noteWorkerStopped } from './staleBuild';

export type { BrickworkOutcome, BrickworkRequestOptions };

/** A house is a few seconds. Past this the worker is wedged. */
const TIMEOUT_MS = 120_000;

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

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
      else if (msg.type === 'SOURCE_DONE') p.resolve(msg.geoms);
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

function send<T>(w: Worker, req: BrickworkRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(req.id);
      worker?.terminate();
      worker = null;
      reject(new Error('Laying the bricks took too long and was abandoned.'));
      failAll('Laying the bricks took too long and was abandoned.');
    }, TIMEOUT_MS);
    pending.set(req.id, { resolve: resolve as (v: unknown) => void, reject, timer });
    w.postMessage(req);
  });
}

/** brickworkInScene, off the main thread. */
export async function layBricksOffThread(scene: SceneGraph, bodyId: string | null, options: BrickworkRequestOptions = {}): Promise<BrickworkOutcome> {
  const w = ensureWorker();
  if (!w) {
    const { brickworkInScene } = await import('./brickwork');
    return brickworkInScene(scene, bodyId, options);
  }
  return send<BrickworkOutcome>(w, { type: 'LAY', id: ++seq, scene, bodyId, options });
}

/** A brickwork body's bricks from its source (SceneNode.brickwork), off the main thread. */
export async function layBrickworkSourceOffThread(source: BrickworkSource, prefix: string): Promise<SceneGeom[]> {
  const w = ensureWorker();
  if (!w) {
    const { brickworkSourceGeoms } = await import('./brickwork');
    return brickworkSourceGeoms(source, prefix).geoms;
  }
  return send<SceneGeom[]>(w, { type: 'LAY_SOURCE', id: ++seq, source, prefix });
}
