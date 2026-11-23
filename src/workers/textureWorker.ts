/// <reference lib="webworker" />

// Lays surface patterns onto a geom, off the main thread.
//
// Refining a face to 0.4 mm and sampling the pattern over it is most of a
// second for a large face, and the viewport asks again every time a field in
// the pattern dialog changes. utils/surfaceTexture.ts stays Worker-free, so
// the tests call it directly and only the browser pays for this.

import { applySurfaceTextures } from '../utils/surfaceTexture';
import type { PackedTexturedSurface, TextureRequest, TextureResponse } from './textureProtocol';
import { collectTransferables } from './transferables';

const post = (msg: TextureResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

self.onmessage = (evt: MessageEvent<TextureRequest>) => {
  const msg = evt.data;
  try {
    const surface = applySurfaceTextures(msg.positions, msg.faces, msg.textures, { splits: msg.splits });
    const packed: PackedTexturedSurface = {
      vertices: Float64Array.from(surface.vertices),
      faces: Uint32Array.from(surface.faces),
      ...(surface.paint
        ? {
            paint: {
              res: surface.paint.res,
              idx: Uint32Array.from(surface.paint.idx),
              rgba: Uint8Array.from(surface.paint.rgba),
            },
          }
        : {}),
      regions: surface.regions,
      warnings: surface.warnings,
    };
    post({ type: 'TEXTURE_DONE', id: msg.id, packed }, collectTransferables(packed));
  } catch (err) {
    post({ type: 'TEXTURE_FAILED', id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
};
