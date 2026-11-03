/// <reference lib="webworker" />

// Brickwork, off the main thread: a slice and a ring of runs per course, and
// thousands of bricks for a house.
//
// utils/brickwork.ts stays Worker-free, so the tests call it directly.

import { brickworkInScene, brickworkSourceGeoms } from '../utils/brickwork';
import type { BrickworkRequest, BrickworkResponse } from './brickworkProtocol';

const post = (msg: BrickworkResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);

self.onmessage = (evt: MessageEvent<BrickworkRequest>) => {
  const msg = evt.data;
  try {
    if (msg.type === 'LAY_SOURCE') post({ type: 'SOURCE_DONE', id: msg.id, geoms: brickworkSourceGeoms(msg.source, msg.prefix).geoms });
    else post({ type: 'LAY_DONE', id: msg.id, outcome: brickworkInScene(msg.scene, msg.bodyId, msg.options) });
  } catch (err) {
    post({ type: 'FAILED', id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
};
