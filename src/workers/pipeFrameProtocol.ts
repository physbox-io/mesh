// The messages between utils/pipeFrameClient.ts and workers/pipeFrameWorker.ts.
// One file imported by both sides, so a changed shape is a type error.

import type { SceneGraph, SceneNode } from '../types/scene';
import type { BuiltSkeleton, FramePlacement, SkeletonOptions } from '../utils/pipeSkeleton';
import type { PipeFrameBreakdownResult } from '../utils/tubeAndWireExporter';

/** Everything frameBodyInScene takes but the wasm, which the worker loads itself. */
export type FrameOptions = Omit<SkeletonOptions, 'wasm'> & { placement?: FramePlacement };

export interface FrameOutcome { nodes: SceneNode[]; skeleton: BuiltSkeleton; added: number }

export type PipeFrameRequest =
  | { type: 'WARM' }
  | { type: 'FRAME'; id: number; scene: SceneGraph; bodyId: string; options: FrameOptions }
  | { type: 'HUBS'; id: number; breakdown: PipeFrameBreakdownResult };

export type PipeFrameResponse =
  | { type: 'FRAME_DONE'; id: number; outcome: FrameOutcome }
  | { type: 'HUBS_DONE'; id: number; nodes: SceneNode[] }
  | { type: 'FAILED'; id: number; error: string };
