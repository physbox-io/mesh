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
import type { PipeFrameRequest, PipeFrameResponse } from './pipeFrameProtocol';

const post = (msg: PipeFrameResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);

self.onmessage = async (evt: MessageEvent<PipeFrameRequest>) => {
  const msg = evt.data;
  if (msg.type === 'WARM') {
    void loadManifold().catch(() => undefined);
    return;
  }
  try {
    if (msg.type === 'FRAME') {
      const wasm = await loadManifold();
      post({ type: 'FRAME_DONE', id: msg.id, outcome: frameBodyInScene(msg.scene, msg.bodyId, { ...msg.options, wasm }) });
      return;
    }
    post({ type: 'HUBS_DONE', id: msg.id, nodes: buildAllCustomHubNodes(msg.breakdown) });
  } catch (err) {
    post({ type: 'FAILED', id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
};
