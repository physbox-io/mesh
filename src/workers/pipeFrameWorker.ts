/// <reference lib="webworker" />

// Pipe frames, off the main thread: framing a shape (a Manifold union of every
// part, then its edges simplified and filled) and building the printed hubs,
// each a CSG solid. A big scene is seconds of either, and on the main thread
// that was the viewport frozen with the Pipes dialog open over it.
//
// utils/pipeSkeleton.ts and utils/tubeAndWireExporter.ts stay Worker-free, so
// the tests call them directly.

import { loadManifold } from '../utils/sculptCut';
import { frameBodyInScene } from '../utils/pipeSkeleton';
import { buildAllCustomHubNodes } from '../utils/tubeAndWireExporter';
import type { SceneGraph } from '../types/scene';
import type { PipeFrameRequest, PipeFrameResponse } from './pipeFrameProtocol';
import { collectTransferables } from './transferables';

const post = (msg: PipeFrameResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

let cachedScene: SceneGraph = { nodes: [] };
let queue: Promise<void> = Promise.resolve();

async function handleMessage(msg: PipeFrameRequest): Promise<void> {
  if (msg.type === 'WARM') {
    await loadManifold().catch(() => undefined);
    return;
  }
  try {
    if (msg.type === 'FRAME') {
      if (msg.scene) cachedScene = msg.scene;
      const wasm = await loadManifold();
      const outcome = frameBodyInScene(cachedScene, msg.bodyId, { ...msg.options, wasm });
      post({ type: 'FRAME_DONE', id: msg.id, outcome }, collectTransferables(outcome));
      return;
    }
    const nodes = buildAllCustomHubNodes(msg.breakdown, msg.includeStandard === true);
    post({ type: 'HUBS_DONE', id: msg.id, nodes }, collectTransferables(nodes));
  } catch (err) {
    post({ type: 'FAILED', id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
}

self.onmessage = (evt: MessageEvent<PipeFrameRequest>) => {
  const msg = evt.data;
  queue = queue.then(() => handleMessage(msg));
};
