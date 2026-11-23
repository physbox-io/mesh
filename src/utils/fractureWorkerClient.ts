// Thin postMessage client over the fracture worker.
//
// Same signature as utils/fracture.ts's fractureMesh, but async: the worker in
// a browser, the module directly under Node and vite-node, where `Worker` does
// not exist — which is what the test suite runs on.

import type { FractureCell, SeedOptions } from './fracture';
import type { FractureRequest, FractureResponse } from '../workers/fractureProtocol';
import type { HullPayload } from '../workers/vhacdProtocol';
import { noteWorkerStopped } from './staleBuild';

/**
 * A cut takes tens of milliseconds. Past this the worker is wedged, and a body
 * that never breaks is better than a promise nobody ever settles.
 */
const FRACTURE_TIMEOUT_MS = 5_000;

type QueuedFracture = {
  id: number;
  verts: number[];
  faces: number[];
  opts: SeedOptions;
  resolve: (cells: FractureCell[]) => void;
  reject: (e: Error) => void;
};

let worker: Worker | null = null;
let seq = 0;
let active: (QueuedFracture & { timer: ReturnType<typeof setTimeout> }) | null = null;
const queued: QueuedFracture[] = [];

function dropWorker(w: Worker | null): void {
  if (w) {
    w.onmessage = null;
    w.onerror = null;
    w.onmessageerror = null;
    w.terminate();
  }
  if (worker === w) worker = null;
}

function failAll(message: string): void {
  if (active) {
    clearTimeout(active.timer);
    const done = active;
    active = null;
    done.reject(new Error(message));
  }
  while (queued.length > 0) queued.shift()!.reject(new Error(message));
}

function ensureWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    const w = new Worker(new URL('../workers/fractureWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (evt: MessageEvent<FractureResponse>) => {
      if (worker !== w) return;
      const msg = evt.data;
      if (!active || active.id !== msg.id) return;
      const done = active;
      active = null;
      clearTimeout(done.timer);
      if (msg.type === 'FRACTURE_ERROR') done.reject(new Error(msg.message));
      else done.resolve(msg.cells.map(fromPayload));
      pump();
    };
    const handleBroken = (message: string) => {
      if (worker !== w) return;
      noteWorkerStopped();
      dropWorker(w);
      failAll(message);
    };
    w.onerror = () => handleBroken('The fracture worker stopped.');
    w.onmessageerror = () => handleBroken('The fracture worker could not read the worker response.');
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
      Promise.all([import('./fractureClip'), import('./sculptCut')])
        .then(async ([{ fractureSolid }, { loadManifold }]) =>
          next.resolve(fractureSolid(await loadManifold(), next.verts, next.faces, next.opts)),
        )
        .catch((err) => next.reject(err instanceof Error ? err : new Error(String(err))))
        .finally(pump);
      return;
    }
    const timer = setTimeout(() => {
      if (active?.id !== next.id) return;
      const wedged = active;
      active = null;
      dropWorker(w);
      wedged.reject(new Error('Fracture timed out.'));
      pump();
    }, FRACTURE_TIMEOUT_MS);
    active = { ...next, timer };
    try {
      const req: FractureRequest = {
        type: 'FRACTURE', id: next.id, opts: next.opts,
        verts: Float64Array.from(next.verts),
        faces: Uint32Array.from(next.faces),
      };
      const transfer: Transferable[] = [];
      if (req.verts.byteLength > 0) transfer.push(req.verts.buffer);
      if (req.faces.byteLength > 0) transfer.push(req.faces.buffer);
      w.postMessage(req, transfer);
      return;
    } catch (err) {
      clearTimeout(timer);
      active = null;
      next.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

const fromPayload = (h: HullPayload): FractureCell => ({
  verts: Array.from(h.verts),
  faces: Array.from(h.faces),
  volume: h.volume,
  centroid: h.centroid,
});

/**
 * Start the worker and have it load its module before anything breaks.
 *
 * A cold worker spends longer fetching and compiling fracture.ts and three.js
 * than it does cutting, and the first break of a run is the one people watch.
 */
export function prewarmFractureWorker(): void {
  const w = ensureWorker();
  if (w) w.postMessage({ type: 'WARM' } satisfies FractureRequest);
}

/** Cuts off the main thread where it can, inline where it cannot. */
export async function fractureMeshOffThread(
  verts: number[],
  faces: number[],
  opts: SeedOptions = {},
): Promise<FractureCell[]> {
  if (typeof Worker === 'undefined') {
    const [{ fractureSolid }, { loadManifold }] = await Promise.all([import('./fractureClip'), import('./sculptCut')]);
    return fractureSolid(await loadManifold(), verts, faces, opts);
  }
  return new Promise<FractureCell[]>((resolve, reject) => {
    queued.push({ id: ++seq, verts, faces, opts, resolve, reject });
    pump();
  });
}
