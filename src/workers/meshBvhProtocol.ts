import type { SerializedBVH } from 'three-mesh-bvh';

export interface MeshBvhRequest {
  id: number;
  position: Float32Array;
  index: Uint32Array | Uint16Array | null;
  groups: { start: number; count: number; materialIndex?: number }[];
  /** MeshBVH options, minus the progress callback, which cannot cross. */
  options: Record<string, unknown>;
}

export type MeshBvhResponse =
  | { id: number; ok: true; serialized: SerializedBVH; position: Float32Array }
  | { id: number; ok: false; error: string };
