/// <reference lib="webworker" />

// Lays surface patterns onto a geom, off the main thread.
//
// Refining a face to 0.4 mm and sampling the pattern over it is most of a
// second for a large face, and the viewport asks again every time a field in
// the pattern dialog changes. utils/surfaceTexture.ts stays Worker-free, so
// the tests call it directly and only the browser pays for this.

import { applySurfaceTextures } from '../utils/surfaceTexture';
import type { TextureRequest, TextureResponse } from './textureProtocol';

const post = (msg: TextureResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);

self.onmessage = (evt: MessageEvent<TextureRequest>) => {
  const msg = evt.data;
  try {
    const surface = applySurfaceTextures(msg.positions, msg.faces, msg.textures);
    post({ type: 'TEXTURE_DONE', id: msg.id, surface });
  } catch (err) {
    post({ type: 'TEXTURE_FAILED', id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
};
