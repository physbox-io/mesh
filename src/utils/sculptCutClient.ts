// Thin postMessage client over the scissors worker.
//
// Same shape as utils/sculptCut.ts's cutSculptWith, but async: the worker in a
// browser, the module directly under Node and vite-node, where `Worker` does
// not exist — which is what the test suite runs on.

import { createSculptMesh, type SculptMesh } from './sculptMesh';
import type { CutOptions, CutResult, PrismSpec } from './sculptCut';
import type { SculptCutRequest, SculptCutResponse } from '../workers/sculptCutProtocol';
import { noteWorkerStopped } from './staleBuild';

/**
 * A cut on the densest sculpt takes a couple of seconds. Past this the worker
 * is wedged, and a refused cut is better than a lasso that never lets go.
 */
const CUT_TIMEOUT_MS = 60_000;

type QueuedCut = {
  id: number;
  mesh: SculptMesh;
  spec: PrismSpec;
  options: CutOptions;
  resolve: (result: CutResult) => void;
};

let worker: Worker | null = null;
let seq = 0;
let active: (QueuedCut & { timer: ReturnType<typeof setTimeout> }) | null = null;
const queued: QueuedCut[] = [];

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
    done.resolve({ ok: false, error });
  }
  while (queued.length > 0) queued.shift()!.resolve({ ok: false, error });
}

function ensureWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    const w = new Worker(new URL('../workers/sculptCutWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (evt: MessageEvent<SculptCutResponse>) => {
      if (worker !== w) return;
      const msg = evt.data;
      if (!active || active.id !== msg.id) return;
      const done = active;
      active = null;
      clearTimeout(done.timer);
      if (msg.type === 'CUT_REFUSED') {
        done.resolve({ ok: false, error: msg.error });
      } else {
        const mesh = createSculptMesh(msg.positions, msg.faces);
        mesh.topologyRevision = done.mesh.topologyRevision + 1;
        mesh.revision = done.mesh.revision + 1;
        done.resolve({
          ok: true, mesh, pieces: msg.pieces,
          facesBefore: done.mesh.faceCount, facesAfter: mesh.faceCount,
        });
      }
      pump();
    };
    const handleBroken = (error: string) => {
      if (worker !== w) return;
      noteWorkerStopped();
      dropWorker(w);
      failAll(error);
    };
    w.onerror = () => handleBroken('The scissors stopped working. Try the cut again.');
    w.onmessageerror = () => handleBroken('The scissors could not read the worker response. Try the cut again.');
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
      import('./sculptCut')
        .then(async ({ cutSculptWith, loadManifold }) => next.resolve(cutSculptWith(await loadManifold(), next.mesh, next.spec, next.options)))
        .catch((err) => next.resolve({ ok: false, error: err instanceof Error ? err.message : String(err) }))
        .finally(pump);
      return;
    }
    const timer = setTimeout(() => {
      if (active?.id !== next.id) return;
      const wedged = active;
      active = null;
      dropWorker(w);
      wedged.resolve({ ok: false, error: 'The cut took too long and was abandoned.' });
      pump();
    }, CUT_TIMEOUT_MS);
    active = { ...next, timer };
    try {
      const req: SculptCutRequest = {
        type: 'CUT', id: next.id, spec: next.spec, options: next.options,
        positions: next.mesh.positions.slice(0, next.mesh.vertexCount * 3),
        faces: next.mesh.faces.slice(0, next.mesh.faceCount * 3),
      };
      const transfer: Transferable[] = [];
      if (req.positions.byteLength > 0) transfer.push(req.positions.buffer);
      if (req.faces.byteLength > 0) transfer.push(req.faces.buffer);
      w.postMessage(req, transfer);
      return;
    } catch (err) {
      clearTimeout(timer);
      active = null;
      next.resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
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
  if (typeof Worker === 'undefined') {
    const { cutSculptWith, loadManifold } = await import('./sculptCut');
    return cutSculptWith(await loadManifold(), mesh, spec, options);
  }
  return new Promise<CutResult>((resolve) => {
    queued.push({ id: ++seq, mesh, spec, options, resolve });
    pump();
  });
}
