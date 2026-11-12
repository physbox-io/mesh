/// <reference lib="webworker" />

// A dress form's geoms, off the main thread: lofting its torso, limbs and head
// and tuning its tapes takes a second or so, which froze the editor on every
// measurement slider.
//
// utils/cloth/bodyForm.ts stays Worker-free, so the tests call it directly.

import { bodyFormGeoms } from '../utils/cloth/bodyForm';
import type { BodyFormRequest, BodyFormResponse } from './bodyFormProtocol';

const post = (msg: BodyFormResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);

self.onmessage = (evt: MessageEvent<BodyFormRequest>) => {
  const msg = evt.data;
  try {
    post({ type: 'BUILT', id: msg.id, geoms: bodyFormGeoms(msg.measurements, msg.prefix) });
  } catch (err) {
    post({ type: 'FAILED', id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
};
