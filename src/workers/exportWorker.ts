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

type Incoming = {
  type: 'RUN';
  id: number;
  kind: ExportJobKind;
  scene?: SceneGraph;
  options: Record<string, unknown>;
};

let scene: SceneGraph = { nodes: [] };

self.onmessage = (evt: MessageEvent<Incoming>) => {
  const msg = evt.data;
  if (msg.type !== 'RUN') return;
  if (msg.scene) scene = msg.scene;
  try {
    const result = runExportJob(msg.kind, scene, msg.options);
    self.postMessage({ type: 'DONE', id: msg.id, result });
  } catch (e) {
    self.postMessage({ type: 'FAILED', id: msg.id, message: (e as Error)?.message ?? String(e) });
  }
};
