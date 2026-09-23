/// <reference lib="webworker" />

// Cuts a body into Voronoi shards, off the main thread.
//
// A break is decided in the middle of play, and the cut takes tens of
// milliseconds for a turned vase. Inline, that is taken at the exact moment of
// impact and felt as the scene stopping dead just before the blow lands. Here
// the old model keeps stepping while the pieces are worked out, and
// rebaseShard puts them wherever the body has got to by the time they land.
//
// utils/fracture.ts stays Worker-free, so the tests call it directly and only
// the browser pays for this. Same split as vhacdWorker over utils/vhacd.

import { fractureMesh } from '../utils/fracture';
import type { FractureRequest, FractureResponse } from './fractureProtocol';

const post = (msg: FractureResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

self.onmessage = (evt: MessageEvent<FractureRequest>) => {
  const msg = evt.data;
  if (msg.type !== 'FRACTURE') return; // WARM only has to load this module
  try {
    const cells = fractureMesh(Array.from(msg.verts), Array.from(msg.faces), msg.opts);
    const payload = cells.map(c => ({
      verts: Float64Array.from(c.verts),
      faces: Uint32Array.from(c.faces),
      volume: c.volume,
      centroid: c.centroid,
    }));
    post(
      { type: 'FRACTURED', id: msg.id, cells: payload },
      payload.flatMap(c => [c.verts.buffer, c.faces.buffer]),
    );
  } catch (err) {
    post({ type: 'FRACTURE_ERROR', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};
