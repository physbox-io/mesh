/// <reference lib="webworker" />

// Cuts a sculpt with the scissors, off the main thread.
//
// The boolean is quick; building Manifold's half-edge structure from a dense
// sculpt is not — around a second at 160 k vertices — and on the main thread
// that second is the viewport frozen with the lasso still drawn on it.
//
// utils/sculptCut.ts stays Worker-free, so the tests call it directly and only
// the browser pays for this. Same split as fractureWorker over utils/fracture.

import { createSculptMesh } from '../utils/sculptMesh';
import { cutSculptWith, loadManifold } from '../utils/sculptCut';
import type { SculptCutRequest, SculptCutResponse } from './sculptCutProtocol';
import { collectTransferables, isStandaloneView } from './transferables';

const post = (msg: SculptCutResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

let queue: Promise<void> = Promise.resolve();

async function handleMessage(msg: SculptCutRequest): Promise<void> {
  if (msg.type === 'WARM') {
    // The wasm is the slow part of a first cut; fetch it while the lasso is
    // still being drawn.
    await loadManifold().catch(() => undefined);
    return;
  }
  try {
    const wasm = await loadManifold();
    const result = cutSculptWith(wasm, createSculptMesh(msg.positions, msg.faces), msg.spec, msg.options);
    if (!result.ok) {
      post({ type: 'CUT_REFUSED', id: msg.id, error: result.error });
      return;
    }
    const posLen = result.mesh.vertexCount * 3;
    const faceLen = result.mesh.faceCount * 3;
    const positions =
      result.mesh.positions.length === posLen && isStandaloneView(result.mesh.positions)
        ? result.mesh.positions
        : result.mesh.positions.slice(0, posLen);
    const faces =
      result.mesh.faces.length === faceLen && isStandaloneView(result.mesh.faces)
        ? result.mesh.faces
        : result.mesh.faces.slice(0, faceLen);
    post({ type: 'CUT_DONE', id: msg.id, positions, faces, pieces: result.pieces }, collectTransferables([positions, faces]));
  } catch (err) {
    post({ type: 'CUT_REFUSED', id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
}

self.onmessage = (evt: MessageEvent<SculptCutRequest>) => {
  const msg = evt.data;
  queue = queue.then(() => handleMessage(msg));
};
