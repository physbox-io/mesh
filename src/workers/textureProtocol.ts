// The messages between utils/textureClient.ts and workers/textureWorker.ts.
//
// One file, imported by both sides, so a change to a message shape is a type
// error rather than a silent no-op -- the convention physicsWorkerProtocol.ts
// established.

import type { SurfaceTexture, TexturedSurface } from '../utils/surfaceTexture';

export interface TextureRequest {
  type: 'TEXTURE';
  id: number;
  positions: Float64Array;
  faces: Uint32Array;
  textures: SurfaceTexture[];
}

export type TextureResponse =
  | { type: 'TEXTURE_DONE'; id: number; surface: TexturedSurface }
  | { type: 'TEXTURE_FAILED'; id: number; error: string };
