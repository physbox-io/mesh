/// <reference lib="webworker" />

// Plans slip-cast molds off the main thread, a dozen booleans on the part and
// a split search over its surface, a few seconds on a detailed vase; and
// simulates the cast out of one.

import { buildSlipMold } from '../utils/slipCastMold';
import { simulateSlipCast } from '../utils/slipCastSimulation';
import { masterSoupMm } from '../utils/pourBoxScene';
import { loadManifold } from '../utils/sculptCut';
import type { SceneGraph } from '../types/scene';
import type { SlipMoldRequest, SlipMoldResponse } from './slipMoldProtocol';
import { collectTransferables } from './transferables';

const post = (msg: SlipMoldResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

let cachedScene: SceneGraph = { nodes: [] };
let queue: Promise<void> = Promise.resolve();

async function handleMessage(msg: SlipMoldRequest): Promise<void> {
  try {
    const wasm = await loadManifold();
    if (msg.type === 'CAST') {
      const result = simulateSlipCast(wasm, msg.input, msg.wallMm);
      post({ type: 'CAST_DONE', id: msg.id, result }, collectTransferables(result));
      return;
    }
    if (msg.scene) cachedScene = msg.scene;
    const mold = buildSlipMold(wasm, masterSoupMm(cachedScene, msg.ids), msg.options);
    post({ type: 'PLANNED', id: msg.id, mold }, collectTransferables(mold));
  } catch (e) {
    post({ type: 'FAILED', id: msg.id, error: (e as Error)?.message ?? String(e) });
  }
}

self.onmessage = (evt: MessageEvent<SlipMoldRequest>) => {
  const msg = evt.data;
  queue = queue.then(() => handleMessage(msg));
};
