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

import { fractureSolid } from '../utils/fractureClip';
import { loadManifold } from '../utils/sculptCut';
import type { FractureRequest, FractureResponse } from './fractureProtocol';

const post = (msg: FractureResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

self.onmessage = async (evt: MessageEvent<FractureRequest>) => {
  const msg = evt.data;
  // WARM loads this module, and the boolean that cuts concave bodies.
  if (msg.type !== 'FRACTURE') { void loadManifold().catch(() => {}); return; }
  try {
    // Cells of the real solid, not of its hull: see utils/fractureClip.ts.
    const wasm = await loadManifold();
    const cells = fractureSolid(wasm, Array.from(msg.verts), Array.from(msg.faces), msg.opts);
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
