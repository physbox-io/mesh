// Thin postMessage client over the fracture worker.
//
// Same signature as utils/fracture.ts's fractureMesh, but async: the worker in
// a browser, the module directly under Node and vite-node, where `Worker` does
// not exist — which is what the test suite runs on.

import type { FractureCell, SeedOptions } from './fracture';
import type { FractureRequest, FractureResponse } from '../workers/fractureProtocol';
import type { HullPayload } from '../workers/vhacdProtocol';

/**
 * A cut takes tens of milliseconds. Past this the worker is wedged, and a body
 * that never breaks is better than a promise nobody ever settles.
 */
const FRACTURE_TIMEOUT_MS = 5_000;

type Settle = { resolve: (cells: FractureCell[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Settle>();

function failAll(message: string) {
  for (const [, s] of pending) { clearTimeout(s.timer); s.reject(new Error(message)); }
  pending.clear();
}

function ensureWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('../workers/fractureWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (evt: MessageEvent<FractureResponse>) => {
      const msg = evt.data;
      const settle = pending.get(msg.id);
      if (!settle) return;
      pending.delete(msg.id);
      clearTimeout(settle.timer);
      if (msg.type === 'FRACTURE_ERROR') settle.reject(new Error(msg.message));
      else settle.resolve(msg.cells.map(fromPayload));
    };
    worker.onerror = () => {
      failAll('The fracture worker stopped.');
      worker?.terminate();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
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
  const w = ensureWorker();
  if (!w) {
    const { fractureMesh } = await import('./fracture');
    return fractureMesh(verts, faces, opts);
  }
  return new Promise<FractureCell[]>((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Fracture timed out.'));
    }, FRACTURE_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    const req: FractureRequest = {
      type: 'FRACTURE', id, opts,
      verts: Float64Array.from(verts),
      faces: Uint32Array.from(faces),
    };
    w.postMessage(req, [req.verts.buffer, req.faces.buffer]);
  });
}
