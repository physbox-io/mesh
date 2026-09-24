// Thin postMessage client over the scissors worker.
//
// Same shape as utils/sculptCut.ts's cutSculptWith, but async: the worker in a
// browser, the module directly under Node and vite-node, where `Worker` does
// not exist — which is what the test suite runs on.

import { createSculptMesh, type SculptMesh } from './sculptMesh';
import type { CutOptions, CutResult, PrismSpec } from './sculptCut';
import type { SculptCutRequest, SculptCutResponse } from '../workers/sculptCutProtocol';

/**
 * A cut on the densest sculpt takes a couple of seconds. Past this the worker
 * is wedged, and a refused cut is better than a lasso that never lets go.
 */
const CUT_TIMEOUT_MS = 30_000;

type Settle = { resolve: (result: CutResult) => void; timer: ReturnType<typeof setTimeout>; mesh: SculptMesh };

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Settle>();

function failAll(error: string) {
  for (const [, s] of pending) { clearTimeout(s.timer); s.resolve({ ok: false, error }); }
  pending.clear();
}

function ensureWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('../workers/sculptCutWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (evt: MessageEvent<SculptCutResponse>) => {
      const msg = evt.data;
      const settle = pending.get(msg.id);
      if (!settle) return;
      pending.delete(msg.id);
      clearTimeout(settle.timer);
      if (msg.type === 'CUT_REFUSED') {
        settle.resolve({ ok: false, error: msg.error });
        return;
      }
      const mesh = createSculptMesh(msg.positions, msg.faces);
      mesh.topologyRevision = settle.mesh.topologyRevision + 1;
      mesh.revision = settle.mesh.revision + 1;
      settle.resolve({
        ok: true, mesh, pieces: msg.pieces,
        facesBefore: settle.mesh.faceCount, facesAfter: mesh.faceCount,
      });
    };
    worker.onerror = () => {
      failAll('The scissors stopped working. Try the cut again.');
      worker?.terminate();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

/** Start the worker and its wasm loading before the first cut is asked for. */
export function prewarmSculptCut(): void {
  const w = ensureWorker();
  if (w) w.postMessage({ type: 'WARM' } satisfies SculptCutRequest);
}

/**
 * Cuts off the main thread where it can, inline where it cannot. Never
 * rejects: a cut that cannot be made says why in `error`.
 */
export async function cutSculptOffThread(
  mesh: SculptMesh,
  spec: PrismSpec,
  options: CutOptions = {},
): Promise<CutResult> {
  const w = ensureWorker();
  if (!w) {
    const { cutSculptWith, loadManifold } = await import('./sculptCut');
    return cutSculptWith(await loadManifold(), mesh, spec, options);
  }
  return new Promise<CutResult>((resolve) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: 'The cut took too long and was abandoned.' });
    }, CUT_TIMEOUT_MS);
    pending.set(id, { resolve, timer, mesh });
    const req: SculptCutRequest = {
      type: 'CUT', id, spec, options,
      positions: mesh.positions.slice(0, mesh.vertexCount * 3),
      faces: mesh.faces.slice(0, mesh.faceCount * 3),
    };
    w.postMessage(req, [req.positions.buffer, req.faces.buffer]);
  });
}
