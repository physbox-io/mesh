// The messages between utils/slipMoldClient.ts and workers/slipMoldWorker.ts.
// One file, imported by both sides, so a change to a message shape is a type
// error rather than a silent no-op.

import type { SceneGraph } from '../types/scene';
import type { SlipMold, SlipMoldOptions } from '../utils/slipCastMold';
import type { SlipCastInput, SlipCastResult } from '../utils/slipCastSimulation';

export type SlipMoldRequest =
  | {
    type: 'PLAN';
    id: number;
    /** The scene the part is in, and the bodies that are the part. */
    scene: SceneGraph;
    ids: string[];
    options: Partial<SlipMoldOptions>;
  }
  | { type: 'CAST'; id: number; input: SlipCastInput; wallMm: number };

export type SlipMoldResponse =
  | { type: 'PLANNED'; id: number; mold: SlipMold }
  | { type: 'CAST_DONE'; id: number; result: SlipCastResult }
  | { type: 'FAILED'; id: number; error: string };
