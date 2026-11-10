// The messages between utils/silhouetteClient.ts and workers/silhouetteWorker.ts.

import type { View, ViewMatch } from '../utils/silhouette';

export interface BestViewRequest {
  type: 'BEST_VIEW';
  id: number;
  tris: Float32Array;
  photo: Uint8Array;
  near?: View;
}

export type SilhouetteResponse =
  | { type: 'BEST_VIEW_DONE'; id: number; match: ViewMatch | null }
  | { type: 'FAILED'; id: number; error: string };
