// The messages between utils/brickworkClient.ts and workers/brickworkWorker.ts.
// One file imported by both sides, so a changed shape is a type error.

import type { BrickworkSource, SceneGeom, SceneGraph, SceneNode } from '../types/scene';
import type { BrickPlacement, BrickworkOptions, BrickworkResult } from '../utils/brickwork';

export type BrickworkRequestOptions = Partial<BrickworkOptions> & { placement?: BrickPlacement };

export interface BrickworkOutcome { nodes: SceneNode[]; result: BrickworkResult }

export type BrickworkRequest =
  | { type: 'LAY'; id: number; scene: SceneGraph; bodyId: string | null; options: BrickworkRequestOptions }
  /** A brickwork body's bricks, from its source (SceneNode.brickwork). */
  | { type: 'LAY_SOURCE'; id: number; source: BrickworkSource; prefix: string };

export type BrickworkResponse =
  | { type: 'LAY_DONE'; id: number; outcome: BrickworkOutcome }
  | { type: 'SOURCE_DONE'; id: number; geoms: SceneGeom[] }
  | { type: 'FAILED'; id: number; error: string };
