/// <reference lib="webworker" />

// Owns the V-HACD wasm, off the main thread.
//
// A decomposition is a couple of seconds of voxelising (see the measurements in
// utils/vhacd.ts). Inline on the main thread that is a viewport frozen mid-drag
// every time someone finishes editing a hollow body — the app reads as broken
// rather than busy.
//
// The module it wraps is Worker-free and Node-safe on purpose, so the tests and
// the preset exporter call utils/vhacd.ts directly and only the browser pays for
// this. Same split as moldWorker over utils/moldExporter.

import { decomposeMesh } from '../utils/vhacd';
import type { VhacdRequest, VhacdResponse } from './vhacdProtocol';

const post = (msg: VhacdResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

self.onmessage = async (evt: MessageEvent<VhacdRequest>) => {
  const msg = evt.data;
  if (msg.type !== 'DECOMPOSE') return;
  try {
    const hulls = await decomposeMesh(
      Array.from(msg.verts),
      Array.from(msg.faces),
      msg.params,
    );
    // Each hull crosses as typed arrays and is transferred rather than copied:
    // a decomposed body is up to 16 of these, and they are the only thing on
    // this boundary big enough to matter.
    const payload = hulls.map(h => ({
      verts: Float64Array.from(h.verts),
      faces: Uint32Array.from(h.faces),
      volume: h.volume,
      centroid: h.centroid,
    }));
    post(
      { type: 'DECOMPOSED', id: msg.id, hulls: payload },
      payload.flatMap(h => [h.verts.buffer, h.faces.buffer]),
    );
  } catch (err) {
    post({ type: 'DECOMPOSE_ERROR', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};
