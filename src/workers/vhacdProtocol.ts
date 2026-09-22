// The messages between utils/vhacdWorkerClient.ts and workers/vhacdWorker.ts.
//
// One file, imported by both sides, so a change to a message shape is a type
// error rather than a silent no-op — the convention physicsWorkerProtocol.ts
// established and scadWorker predates.

import type { DecomposeParams } from '../utils/vhacd';

/** A convex piece, as it crosses the worker boundary. */
export interface HullPayload {
  verts: Float64Array;
  faces: Uint32Array;
  volume: number;
  centroid: number[];
}

export type VhacdRequest = {
  type: 'DECOMPOSE';
  id: number;
  verts: Float64Array;
  faces: Uint32Array;
  params: Partial<DecomposeParams>;
};

export type VhacdResponse =
  | { type: 'DECOMPOSED'; id: number; hulls: HullPayload[] }
  | { type: 'DECOMPOSE_ERROR'; id: number; message: string };
