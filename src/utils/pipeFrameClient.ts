// Thin postMessage client over the pipe-frame worker.
//
// The same calls as utils/pipeSkeleton.ts and utils/tubeAndWireExporter.ts,
// but async: the worker in a browser, the modules directly under Node and
// vite-node, where `Worker` does not exist. Rejects with the reason on failure.

import type { SceneGraph, SceneNode } from '../types/scene';
import type { PipeFrameBreakdownResult } from './tubeAndWireExporter';
import type { FrameOptions, FrameOutcome, PipeFrameRequest, PipeFrameResponse } from '../workers/pipeFrameProtocol';
import { noteWorkerStopped } from './staleBuild';

export type { FrameOptions, FrameOutcome };

/** A whole bridge frames in a few seconds. Past this the worker is wedged. */
const TIMEOUT_MS = 180_000;

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
    worker = new Worker(new URL('../workers/pipeFrameWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (evt: MessageEvent<PipeFrameResponse>) => {
      const msg = evt.data;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.type === 'FRAME_DONE') p.resolve(msg.outcome);
      else if (msg.type === 'HUBS_DONE') p.resolve(msg.nodes);
      else p.reject(new Error(msg.error));
    };
    worker.onerror = () => {
      noteWorkerStopped();
      failAll('Pipe framing stopped working. Try again.');
      worker?.terminate();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

function send<T>(w: Worker, req: PipeFrameRequest & { id: number }, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(req.id);
      // A wedged worker is no use to the next request either.
      worker?.terminate();
      worker = null;
      reject(new Error(`${what} took too long and was abandoned.`));
      failAll(`${what} took too long and was abandoned.`);
    }, TIMEOUT_MS);
    pending.set(req.id, { resolve: resolve as (v: unknown) => void, reject, timer });
    w.postMessage(req);
  });
}

/** Start the worker and its wasm loading before the dialog asks for anything. */
export function prewarmPipeFrame(): void {
  ensureWorker()?.postMessage({ type: 'WARM' } satisfies PipeFrameRequest);
}

/** frameBodyInScene, off the main thread. */
export async function frameBodyOffThread(scene: SceneGraph, bodyId: string, options: FrameOptions = {}): Promise<FrameOutcome> {
  const w = ensureWorker();
  if (!w) {
    const [{ loadManifold }, { frameBodyInScene }] = await Promise.all([import('./sculptCut'), import('./pipeSkeleton')]);
    return frameBodyInScene(scene, bodyId, { ...options, wasm: await loadManifold() });
  }
  return send<FrameOutcome>(w, { type: 'FRAME', id: ++seq, scene, bodyId, options }, 'Framing');
}

/** buildAllCustomHubNodes, off the main thread. */
export async function buildHubsOffThread(breakdown: PipeFrameBreakdownResult): Promise<SceneNode[]> {
  const w = ensureWorker();
  if (!w) {
    const { buildAllCustomHubNodes } = await import('./tubeAndWireExporter');
    return buildAllCustomHubNodes(breakdown);
  }
  return send<SceneNode[]>(w, { type: 'HUBS', id: ++seq, breakdown }, 'Building the hubs');
}
