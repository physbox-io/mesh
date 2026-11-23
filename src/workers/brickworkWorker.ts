/// <reference lib="webworker" />

// Brickwork, off the main thread: a slice and a ring of runs per course, and
// thousands of bricks for a house.
//
// utils/brickwork.ts stays Worker-free, so the tests call it directly.

import { brickworkInScene, brickworkSourceGeoms } from '../utils/brickwork';
import type { SceneGraph } from '../types/scene';
import type { BrickworkRequest, BrickworkResponse } from './brickworkProtocol';
import { collectTransferables } from './transferables';

const post = (msg: BrickworkResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

let cachedScene: SceneGraph = { nodes: [] };

self.onmessage = (evt: MessageEvent<BrickworkRequest>) => {
  const msg = evt.data;
  try {
    if (msg.type === 'LAY_SOURCE') {
      const geoms = brickworkSourceGeoms(msg.source, msg.prefix).geoms;
      post({ type: 'SOURCE_DONE', id: msg.id, geoms }, collectTransferables(geoms));
    } else {
      if (msg.scene) cachedScene = msg.scene;
      const outcome = brickworkInScene(cachedScene, msg.bodyId, msg.options);
      post({ type: 'LAY_DONE', id: msg.id, outcome }, collectTransferables(outcome));
    }
  } catch (err) {
    post({ type: 'FAILED', id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
};
