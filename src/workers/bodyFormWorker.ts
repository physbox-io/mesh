/// <reference lib="webworker" />

// A dress form's geoms, off the main thread: lofting its torso, limbs and head
// and tuning its tapes takes a second or so, which froze the editor on every
// measurement slider.
//
// utils/cloth/bodyForm.ts stays Worker-free, so the tests call it directly.

import { bodyFormGeoms } from '../utils/cloth/bodyForm';
import type { BodyFormRequest, BodyFormResponse } from './bodyFormProtocol';
import { collectTransferables } from './transferables';

const post = (msg: BodyFormResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

self.onmessage = (evt: MessageEvent<BodyFormRequest>) => {
  const msg = evt.data;
  try {
    const geoms = bodyFormGeoms(msg.measurements, msg.prefix);
    post({ type: 'BUILT', id: msg.id, geoms }, collectTransferables(geoms));
  } catch (err) {
    post({ type: 'FAILED', id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
};
