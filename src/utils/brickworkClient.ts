// Thin postMessage client over the brickwork worker: the worker in a browser,
// utils/brickwork.ts directly under Node, where `Worker` does not exist.
// Rejects with the reason on failure.

import type { BrickworkSource, SceneGeom, SceneGraph } from '../types/scene';
import type { BrickworkOutcome, BrickworkRequest, BrickworkRequestOptions, BrickworkResponse } from '../workers/brickworkProtocol';
import { noteWorkerStopped } from './staleBuild';

export type { BrickworkOutcome, BrickworkRequestOptions };

/** A house is a few seconds. Past this the worker is wedged. */
const TIMEOUT_MS = 120_000;

/** A queued LAY superseded by a newer brickwork option edit for the same target. */
export class BrickworkSupersededError extends Error {
  constructor() {
    super('Brickwork layout superseded by a newer edit.');
    this.name = 'Superseded';
  }
}

type QueuedJob =
  | {
      id: number;
      kind: 'lay';
      slot: string;
      scene: SceneGraph;
      bodyId: string | null;
      options: BrickworkRequestOptions;
      resolve: (v: BrickworkOutcome) => void;
      reject: (e: Error) => void;
    }
  | {
      id: number;
      kind: 'source';
      source: BrickworkSource;
      prefix: string;
      resolve: (v: SceneGeom[]) => void;
      reject: (e: Error) => void;
    };

let worker: Worker | null = null;
let seq = 0;
let active: (QueuedJob & { timer: ReturnType<typeof setTimeout> }) | null = null;
const queued: QueuedJob[] = [];
/** The scene the worker already holds, so brickwork option edits omit it. */
let sceneSent: SceneGraph | null = null;

function dropWorker(w: Worker | null): void {
  if (w) {
    w.onmessage = null;
    w.onerror = null;
    w.onmessageerror = null;
    w.terminate();
  }
  if (worker === w) worker = null;
  sceneSent = null;
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
    const w = new Worker(new URL('../workers/brickworkWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (evt: MessageEvent<BrickworkResponse>) => {
      if (worker !== w) return;
      const msg = evt.data;
      if (!active || active.id !== msg.id) return;
      const done = active;
      active = null;
      clearTimeout(done.timer);
      if (msg.type === 'LAY_DONE' && done.kind === 'lay') done.resolve(msg.outcome);
      else if (msg.type === 'SOURCE_DONE' && done.kind === 'source') done.resolve(msg.geoms);
      else done.reject(new Error(msg.type === 'FAILED' ? msg.error : 'Unexpected brickwork worker reply.'));
      pump();
    };
    const handleBroken = (error: string) => {
      if (worker !== w) return;
      noteWorkerStopped();
      dropWorker(w);
      failAll(error);
    };
    w.onerror = () => handleBroken('Brickwork stopped working. Try again.');
    w.onmessageerror = () => handleBroken('Brickwork could not read the worker response. Try again.');
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
      if (next.kind === 'lay') {
        import('./brickwork')
          .then(({ brickworkInScene }) => next.resolve(brickworkInScene(next.scene, next.bodyId, next.options)))
          .catch((err) => next.reject(err instanceof Error ? err : new Error(String(err))))
          .finally(pump);
      } else {
        import('./brickwork')
          .then(({ brickworkSourceGeoms }) => next.resolve(brickworkSourceGeoms(next.source, next.prefix).geoms))
          .catch((err) => next.reject(err instanceof Error ? err : new Error(String(err))))
          .finally(pump);
      }
      return;
    }

    const timer = setTimeout(() => {
      if (active?.id !== next.id) return;
      const wedged = active;
      active = null;
      dropWorker(w);
      wedged.reject(new Error('Laying the bricks took too long and was abandoned.'));
      pump();
    }, TIMEOUT_MS);

    active = { ...next, timer };
    const prevScene = sceneSent;
    try {
      let req: BrickworkRequest;
      if (next.kind === 'lay') {
        const fresh = next.scene !== sceneSent;
        sceneSent = next.scene;
        req = {
          type: 'LAY',
          id: next.id,
          ...(fresh ? { scene: next.scene } : {}),
          bodyId: next.bodyId,
          options: next.options,
        };
      } else {
        req = { type: 'LAY_SOURCE', id: next.id, source: next.source, prefix: next.prefix };
      }
      w.postMessage(req);
      return;
    } catch (err) {
      clearTimeout(timer);
      active = null;
      sceneSent = prevScene;
      next.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

/** brickworkInScene, off the main thread. */
export async function layBricksOffThread(scene: SceneGraph, bodyId: string | null, options: BrickworkRequestOptions = {}): Promise<BrickworkOutcome> {
  if (typeof Worker === 'undefined') {
    const { brickworkInScene } = await import('./brickwork');
    return brickworkInScene(scene, bodyId, options);
  }
  const slot = bodyId ?? '';
  for (let i = queued.length - 1; i >= 0; i--) {
    const q = queued[i];
    if (q.kind === 'lay' && q.slot === slot) {
      queued.splice(i, 1);
      q.reject(new BrickworkSupersededError());
    }
  }
  return new Promise<BrickworkOutcome>((resolve, reject) => {
    queued.push({ id: ++seq, kind: 'lay', slot, scene, bodyId, options, resolve, reject });
    pump();
  });
}

/** A brickwork body's bricks from its source (SceneNode.brickwork), off the main thread. */
export async function layBrickworkSourceOffThread(source: BrickworkSource, prefix: string): Promise<SceneGeom[]> {
  if (typeof Worker === 'undefined') {
    const { brickworkSourceGeoms } = await import('./brickwork');
    return brickworkSourceGeoms(source, prefix).geoms;
  }
  return new Promise<SceneGeom[]>((resolve, reject) => {
    queued.push({ id: ++seq, kind: 'source', source, prefix, resolve, reject });
    pump();
  });
}
