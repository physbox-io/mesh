// The messages between utils/sculptCutClient.ts and workers/sculptCutWorker.ts.
//
// One file, imported by both sides, so a change to a message shape is a type
// error rather than a silent no-op — the convention physicsWorkerProtocol.ts
// established.

import type { CutOptions, PrismSpec } from '../utils/sculptCut';

export type SculptCutRequest =
  | { type: 'WARM' }
  | {
    type: 'CUT';
    id: number;
    positions: Float32Array;
    faces: Uint32Array;
    spec: PrismSpec;
    options: CutOptions;
  };

export type SculptCutResponse =
  | { type: 'CUT_DONE'; id: number; positions: Float32Array; faces: Uint32Array; pieces: number }
  | { type: 'CUT_REFUSED'; id: number; error: string };
