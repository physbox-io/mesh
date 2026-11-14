/// <reference lib="webworker" />

// Plans slip-cast molds off the main thread, a dozen booleans on the part and
// a split search over its surface, a few seconds on a detailed vase; and
// simulates the cast out of one.

import { buildSlipMold } from '../utils/slipCastMold';
import { simulateSlipCast } from '../utils/slipCastSimulation';
import { masterSoupMm } from '../utils/pourBoxScene';
import { loadManifold } from '../utils/sculptCut';
import type { SlipMoldRequest, SlipMoldResponse } from './slipMoldProtocol';

const post = (msg: SlipMoldResponse) => self.postMessage(msg);

self.onmessage = async (evt: MessageEvent<SlipMoldRequest>) => {
  const msg = evt.data;
  try {
    const wasm = await loadManifold();
    if (msg.type === 'CAST') {
      post({ type: 'CAST_DONE', id: msg.id, result: simulateSlipCast(wasm, msg.input, msg.wallMm) });
      return;
    }
    const mold = buildSlipMold(wasm, masterSoupMm(msg.scene, msg.ids), msg.options);
    post({ type: 'PLANNED', id: msg.id, mold });
  } catch (e) {
    post({ type: 'FAILED', id: msg.id, error: (e as Error)?.message ?? String(e) });
  }
};
