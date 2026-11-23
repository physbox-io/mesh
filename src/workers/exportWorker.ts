/// <reference lib="webworker" />

// Runs the heavy router exports off the main thread.
//
// One worker serves every export job (see `exportJobs.ts` for the registry):
// the message says which job to run, and the worker dispatches to it. Adding a
// heavy export means adding it to the registry, not standing up another worker.
//
// The scene is cached here between calls. It is the largest thing crossing the
// boundary — it carries the model's whole vertex array — and the dialogs change
// the options far more often than the scene, so it is sent once and reused until
// the client says otherwise.

import { runExportJob, type ExportJobKind } from '../utils/exportJobs';
import type { SceneGraph } from '../types/scene';
import { collectTransferables } from './transferables';

type Incoming = {
  type: 'RUN';
  id: number;
  kind: ExportJobKind;
  scene?: SceneGraph;
  options: Record<string, unknown>;
};

const scope = self as unknown as DedicatedWorkerGlobalScope;
let scene: SceneGraph = { nodes: [] };
let queue: Promise<void> = Promise.resolve();

async function handleRun(msg: Incoming): Promise<void> {
  if (msg.scene) scene = msg.scene;
  try {
    let last = -1;
    const result = await runExportJob(msg.kind, scene, msg.options, (fraction) => {
      // Whole percent steps: a message per G-code line would flood the page.
      const pct = Math.floor(fraction * 100);
      if (pct === last) return;
      last = pct;
      scope.postMessage({ type: 'PROGRESS', id: msg.id, fraction });
    });
    scope.postMessage({ type: 'DONE', id: msg.id, result }, collectTransferables(result));
  } catch (e) {
    scope.postMessage({ type: 'FAILED', id: msg.id, message: (e as Error)?.message ?? String(e) });
  }
}

self.onmessage = (evt: MessageEvent<Incoming>) => {
  const msg = evt.data;
  if (msg.type !== 'RUN') return;
  queue = queue.then(() => handleRun(msg));
};
