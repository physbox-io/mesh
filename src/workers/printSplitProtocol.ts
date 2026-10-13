// The messages between utils/printSplitClient.ts and workers/printSplitWorker.ts.
//
// One file, imported by both sides, so a change to a message shape is a type
// error rather than a silent no-op — the convention physicsWorkerProtocol.ts
// established.

import type { PlaneCutResult, SplitChecks, SplitOptions, SplitResult } from '../utils/printSplit';
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
    type: 'PLANE_CUT';
    id: number;
    /** As for SPLIT. */
    soups: Float64Array[];
    /** The plane, body frame, metres. */
    at: [number, number, number];
    normal: [number, number, number];
  }
  | {
    type: 'ASSEMBLE';
    id: number;
    /** Each stage's compiled model, with what it is measured against. */
    stages: { xml: string; stage: StageSpec }[];
  };

export type PrintSplitResponse =
  | { type: 'SPLIT_DONE'; id: number; result: SplitResult; checks: SplitChecks | null }
  | { type: 'PLANE_CUT_DONE'; id: number; result: PlaneCutResult }
  | { type: 'ASSEMBLE_PROGRESS'; id: number; done: number; total: number; result: StageResult }
  | { type: 'ASSEMBLE_DONE'; id: number }
  | { type: 'FAILED'; id: number; error: string };
