/// <reference lib="webworker" />

// The photo-direction search off the main thread: a hundred-odd rasterisations
// of the part's triangles each round of picture to part, which on a dense part
// is seconds. utils/silhouette.ts stays Worker-free, so the tests call it directly.

import { bestView } from '../utils/silhouette';
import type { BestViewRequest, SilhouetteResponse } from './silhouetteProtocol';

const post = (msg: SilhouetteResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);

self.onmessage = (evt: MessageEvent<BestViewRequest>) => {
  const msg = evt.data;
  try {
    post({ type: 'BEST_VIEW_DONE', id: msg.id, match: bestView(msg.tris, msg.photo, msg.near) });
  } catch (err) {
    post({ type: 'FAILED', id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
};
