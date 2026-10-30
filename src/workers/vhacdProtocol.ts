// The messages between utils/vhacdWorkerClient.ts and workers/vhacdWorker.ts.
//
// One file, imported by both sides, so a change to a message shape is a type
// error rather than a silent no-op — the convention physicsWorkerProtocol.ts
// established and scadWorker predates.

import type { DecomposeParams } from '../utils/vhacd';
import type { FilledCavity } from '../utils/filledCavities';
import type { MeshIntegrity } from '../utils/meshIntegrity';
import type { SolidOptions } from '../utils/solidDecomposition';

/** What deciding whether to decompose a mesh needs to know about it. */
export interface MeshAnalysis {
  volume: number;
  hullVolume: number;
  integrity: MeshIntegrity | null;
}

/** A convex piece, as it crosses the worker boundary. */
export interface HullPayload {
  verts: Float64Array;
  faces: Uint32Array;
  volume: number;
  centroid: number[];
}

export type VhacdRequest =
  | {
      type: 'DECOMPOSE';
      id: number;
      verts: Float64Array;
      faces: Uint32Array;
      params: Partial<DecomposeParams>;
      findCavities?: boolean;
    }
  | { type: 'ANALYSE'; id: number; verts: Float64Array; faces: Uint32Array }
  | { type: 'DECOMPOSE_SOLID'; id: number; verts: Float64Array; faces: Uint32Array; options: SolidOptions };

export type VhacdResponse =
  | { type: 'DECOMPOSED'; id: number; hulls: HullPayload[]; cavities?: FilledCavity[] }
  | { type: 'ANALYSED'; id: number; analysis: MeshAnalysis }
  | {
      type: 'DECOMPOSED_SOLID'; id: number; hulls: HullPayload[]; cavities: FilledCavity[];
      intrusion: number; intrusionAt?: [number, number, number];
      uncovered: number; uncoveredAt?: [number, number, number]; chunks: number;
    }
  | { type: 'DECOMPOSE_ERROR'; id: number; message: string };
