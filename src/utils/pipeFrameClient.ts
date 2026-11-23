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

/** A queued FRAME superseded by a newer framing request for the same body. */
export class PipeFrameSupersededError extends Error {
  constructor() {
    super('Pipe framing superseded by a newer request.');
    this.name = 'Superseded';
  }
}

type QueuedJob =
  | {
      id: number;
      kind: 'frame';
      scene: SceneGraph;
      bodyId: string;
      options: FrameOptions;
      what: string;
      resolve: (v: FrameOutcome) => void;
      reject: (e: Error) => void;
    }
  | {
      id: number;
      kind: 'hubs';
      breakdown: PipeFrameBreakdownResult;
      what: string;
      resolve: (v: SceneNode[]) => void;
      reject: (e: Error) => void;
    };

let worker: Worker | null = null;
let seq = 0;
let active: (QueuedJob & { timer: ReturnType<typeof setTimeout> }) | null = null;
const queued: QueuedJob[] = [];
/** The scene the worker already holds, so option tweaks send options alone. */
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
    const w = new Worker(new URL('../workers/pipeFrameWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (evt: MessageEvent<PipeFrameResponse>) => {
      if (worker !== w) return;
      const msg = evt.data;
      if (!active || active.id !== msg.id) return;
      const done = active;
      active = null;
      clearTimeout(done.timer);
      if (msg.type === 'FRAME_DONE' && done.kind === 'frame') done.resolve(msg.outcome);
      else if (msg.type === 'HUBS_DONE' && done.kind === 'hubs') done.resolve(msg.nodes);
      else done.reject(new Error(msg.type === 'FAILED' ? msg.error : 'Unexpected pipe frame worker reply.'));
      pump();
    };
    const handleBroken = (error: string) => {
      if (worker !== w) return;
      noteWorkerStopped();
      dropWorker(w);
      failAll(error);
    };
    w.onerror = () => handleBroken('Pipe framing stopped working. Try again.');
    w.onmessageerror = () => handleBroken('Pipe framing could not read the worker response. Try again.');
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
      if (next.kind === 'frame') {
        Promise.all([import('./sculptCut'), import('./pipeSkeleton')])
          .then(async ([{ loadManifold }, { frameBodyInScene }]) =>
            next.resolve(frameBodyInScene(next.scene, next.bodyId, { ...next.options, wasm: await loadManifold() })),
          )
          .catch((err) => next.reject(err instanceof Error ? err : new Error(String(err))))
          .finally(pump);
      } else {
        import('./tubeAndWireExporter')
          .then(({ buildAllCustomHubNodes }) => next.resolve(buildAllCustomHubNodes(next.breakdown)))
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
      wedged.reject(new Error(`${wedged.what} took too long and was abandoned.`));
      pump();
    }, TIMEOUT_MS);

    active = { ...next, timer };
    const prevScene = sceneSent;
    try {
      let req: PipeFrameRequest;
      if (next.kind === 'frame') {
        const fresh = next.scene !== sceneSent;
        sceneSent = next.scene;
        req = {
          type: 'FRAME',
          id: next.id,
          ...(fresh ? { scene: next.scene } : {}),
          bodyId: next.bodyId,
          options: next.options,
        };
      } else {
        req = { type: 'HUBS', id: next.id, breakdown: next.breakdown };
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

/** Start the worker and its wasm loading before the dialog asks for anything. */
export function prewarmPipeFrame(): void {
  ensureWorker()?.postMessage({ type: 'WARM' } satisfies PipeFrameRequest);
}

/** frameBodyInScene, off the main thread. */
export async function frameBodyOffThread(scene: SceneGraph, bodyId: string, options: FrameOptions = {}): Promise<FrameOutcome> {
  if (typeof Worker === 'undefined') {
    const [{ loadManifold }, { frameBodyInScene }] = await Promise.all([import('./sculptCut'), import('./pipeSkeleton')]);
    return frameBodyInScene(scene, bodyId, { ...options, wasm: await loadManifold() });
  }
  for (let i = queued.length - 1; i >= 0; i--) {
    const q = queued[i];
    if (q.kind === 'frame' && q.bodyId === bodyId) {
      queued.splice(i, 1);
      q.reject(new PipeFrameSupersededError());
    }
  }
  return new Promise<FrameOutcome>((resolve, reject) => {
    queued.push({ id: ++seq, kind: 'frame', scene, bodyId, options, what: 'Framing', resolve, reject });
    pump();
  });
}

/** buildAllCustomHubNodes, off the main thread. */
export async function buildHubsOffThread(breakdown: PipeFrameBreakdownResult): Promise<SceneNode[]> {
  if (typeof Worker === 'undefined') {
    const { buildAllCustomHubNodes } = await import('./tubeAndWireExporter');
    return buildAllCustomHubNodes(breakdown);
  }
  return new Promise<SceneNode[]>((resolve, reject) => {
    queued.push({ id: ++seq, kind: 'hubs', breakdown, what: 'Building the hubs', resolve, reject });
    pump();
  });
}
