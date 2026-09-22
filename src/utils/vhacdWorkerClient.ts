// Thin postMessage client over the V-HACD worker.
//
// Exposes the same signature as utils/vhacd.ts's decomposeMesh, so the producer
// in convexDecomposition.ts can reach for whichever is available without caring:
// the worker in a browser, the module directly under Node and vite-node, where
// `Worker` does not exist at all. That fallback is not a nicety — it is what
// lets scripts/export-presets.ts and the test suite decompose.
//
// One worker, not a pool. Decompositions are queued behind a single debounce in
// useCsgCompile and a scene rarely has more than a handful of concave bodies, so
// the parallelism openscad.ts needs would buy a second wasm heap for nothing.

import type { Hull } from './csg';
import type { DecomposeParams } from './vhacd';
import type { HullPayload, VhacdRequest, VhacdResponse } from '../workers/vhacdProtocol';

/**
 * Long enough for any shape that passed the triangle cap, short enough that a
 * forced decomposition of something pathological gives up rather than wedging
 * the compile pass. The caller falls back to colliding as a hull.
 */
const DECOMPOSE_TIMEOUT_MS = 20_000;

type Settle = { resolve: (hulls: Hull[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

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
    worker = new Worker(new URL('../workers/vhacdWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (evt: MessageEvent<VhacdResponse>) => {
      const msg = evt.data;
      const settle = pending.get(msg.id);
      if (!settle) return;
      pending.delete(msg.id);
      clearTimeout(settle.timer);
      if (msg.type === 'DECOMPOSE_ERROR') settle.reject(new Error(msg.message));
      else settle.resolve(msg.hulls.map(fromPayload));
    };
    // A worker that dies leaves every caller awaiting forever otherwise.
    worker.onerror = () => {
      failAll('The convex decomposition worker stopped.');
      worker?.terminate();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

const fromPayload = (h: HullPayload): Hull => ({
  verts: Array.from(h.verts),
  faces: Array.from(h.faces),
  volume: h.volume,
  centroid: h.centroid,
});

/**
 * Decomposes off the main thread where it can, inline where it cannot.
 *
 * Wrapped in the same compile counter the SCAD pool uses, so the existing
 * "compiling" pill covers this too — a body that takes two seconds to gain its
 * colliders should not look like a body that has stopped responding.
 */
export async function decomposeMeshOffThread(
  verts: number[],
  faces: number[],
  params: Partial<DecomposeParams> = {},
): Promise<Hull[]> {
  const w = ensureWorker();
  if (!w) {
    const { decomposeMesh } = await import('./vhacd');
    return decomposeMesh(verts, faces, params);
  }

  // Imported here rather than at module scope, and only on the browser path.
  // A static import of the store drags the physics worker client and the MuJoCo
  // wasm glue in with it, which is what makes openscad.ts unusable from Node —
  // and the Node path below is the one the tests and the preset exporter use.
  const { useStore } = await import('../store/useStore');
  useStore.getState().incrementScadCompile();
  try {
    return await new Promise<Hull[]>((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Convex decomposition timed out.'));
      }, DECOMPOSE_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      const req: VhacdRequest = {
        type: 'DECOMPOSE', id, params,
        verts: Float64Array.from(verts),
        faces: Uint32Array.from(faces),
      };
      w.postMessage(req, [req.verts.buffer, req.faces.buffer]);
    });
  } finally {
    useStore.getState().decrementScadCompile();
  }
}
