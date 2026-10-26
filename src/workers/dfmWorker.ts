/// <reference lib="webworker" />

// The DFM lens's analyses, off the main thread.
//
// One run samples every part on a grid of up to 320² columns and turns it
// through six orientations to find its best side, and the lens asks again on
// every edit while it is open — a slider tick froze the viewport for as long
// as that took. utils/dfm.ts and utils/printAnalysis.ts stay Worker-free, so
// the tests call them directly and only the browser pays for this.

import { analyseDfm } from '../utils/dfm';
import { structuralWeakSpots } from '../utils/printAnalysis';
import type { SceneGraph } from '../types/scene';
import type { DfmRequest, DfmResponse } from './dfmProtocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (msg: DfmResponse, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);

// The largest thing crossing the boundary, sent once per edit and reused for
// every lens that asks about it.
let scene: SceneGraph = { nodes: [] };

self.onmessage = (evt: MessageEvent<DfmRequest>) => {
  const msg = evt.data;
  if (msg.scene) scene = msg.scene;
  try {
    if (msg.type === 'DFM') {
      const report = analyseDfm(scene, msg.process, msg.bench);
      post({ type: 'DFM_DONE', id: msg.id, report }, [report.tris.buffer as ArrayBuffer, report.heat.buffer as ArrayBuffer]);
    } else {
      post({ type: 'WEAK_SPOTS_DONE', id: msg.id, weakSpots: structuralWeakSpots(scene) });
    }
  } catch (err) {
    post({ type: 'FAILED', id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
};
