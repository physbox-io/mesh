// The messages between utils/fractureWorkerClient.ts and workers/fractureWorker.ts.
//
// One file, imported by both sides, so a change to a message shape is a type
// error rather than a silent no-op — the convention physicsWorkerProtocol.ts
// established.

import type { SeedOptions } from '../utils/fracture';
import type { HullPayload } from './vhacdProtocol';

export type FractureRequest =
  | { type: 'WARM' }
  | {
    type: 'FRACTURE';
    id: number;
    verts: Float64Array;
    faces: Uint32Array;
    opts: SeedOptions;
  };

export type FractureResponse =
  | { type: 'FRACTURED'; id: number; cells: HullPayload[] }
  | { type: 'FRACTURE_ERROR'; id: number; message: string };
