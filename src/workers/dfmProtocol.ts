// The messages between utils/dfmWorkerClient.ts and workers/dfmWorker.ts.
//
// One file, imported by both sides, so a change to a message shape is a type
// error rather than a silent no-op -- the convention physicsWorkerProtocol.ts
// established.

import type { SceneGraph } from '../types/scene';
import type { DfmBench, DfmLimits, DfmProcess, DfmReport } from '../utils/dfm';
import type { WeakSpot } from '../utils/printAnalysis';

export type DfmBenchArgs = Partial<DfmBench & DfmLimits>;

/** `scene` rides along only when it differs from the last one sent; the worker keeps it. */
export type DfmRequest =
  | { type: 'DFM'; id: number; scene?: SceneGraph; process: DfmProcess; bench: DfmBenchArgs }
  | { type: 'WEAK_SPOTS'; id: number; scene?: SceneGraph };

export type DfmResponse =
  | { type: 'DFM_DONE'; id: number; report: DfmReport }
  | { type: 'WEAK_SPOTS_DONE'; id: number; weakSpots: WeakSpot[] }
  | { type: 'FAILED'; id: number; error: string };
