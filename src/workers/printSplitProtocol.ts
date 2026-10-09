// The messages between utils/printSplitClient.ts and workers/printSplitWorker.ts.
//
// One file, imported by both sides, so a change to a message shape is a type
// error rather than a silent no-op — the convention physicsWorkerProtocol.ts
// established.

import type { SplitChecks, SplitOptions, SplitResult } from '../utils/printSplit';
import type { StageResult, StageSpec } from '../utils/printAssembly';

export type PrintSplitRequest =
  | { type: 'WARM' }
  | {
    type: 'SPLIT';
    id: number;
    /** The body's solids, triangle soups, body frame, Z-up, metres. */
    soups: Float64Array[];
    options: SplitOptions;
  }
  | {
    type: 'ASSEMBLE';
    id: number;
    /** Each stage's compiled model, with what it is measured against. */
    stages: { xml: string; stage: StageSpec }[];
  };

export type PrintSplitResponse =
  | { type: 'SPLIT_DONE'; id: number; result: SplitResult; checks: SplitChecks | null }
  | { type: 'ASSEMBLE_PROGRESS'; id: number; done: number; total: number; result: StageResult }
  | { type: 'ASSEMBLE_DONE'; id: number }
  | { type: 'FAILED'; id: number; error: string };
