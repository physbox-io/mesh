// The Slip Cast tab's and MCP's end of workers/slipMoldWorker.ts. One worker,
// kept for the session; each plan is answered by id. Where there is no Worker
// (the tests, under Node) the plan runs inline.

import type { SceneGraph } from '../types/scene';
import type { SlipMold, SlipMoldOptions } from './slipCastMold';
import type { SlipCastInput, SlipCastResult } from './slipCastSimulation';
import type { SlipMoldRequest, SlipMoldResponse } from '../workers/slipMoldProtocol';
import { workerStoppedError } from './staleBuild';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (m: never) => void; reject: (e: Error) => void }>();

function ensureWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    const w = new Worker(new URL('../workers/slipMoldWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (evt: MessageEvent<SlipMoldResponse>) => {
      const msg = evt.data;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.type === 'PLANNED') p.resolve(msg.mold as never);
      else if (msg.type === 'CAST_DONE') p.resolve(msg.result as never);
      else p.reject(new Error(msg.error));
    };
    // A dead worker would leave every caller waiting; it is dropped, and the
    // next plan starts another.
    w.onerror = () => {
      const waiting = [...pending.values()];
      pending.clear();
      w.terminate();
      if (worker === w) worker = null;
      void workerStoppedError('The slip mold worker stopped.').then((err) => waiting.forEach((p) => p.reject(err)));
    };
    worker = w;
    return w;
  } catch {
    return null;
  }
}

/** Plans the slip-cast mold round the given bodies, without touching the scene. */
export async function planSlipMold(scene: SceneGraph, ids: string[], options: Partial<SlipMoldOptions>): Promise<SlipMold> {
  const w = ensureWorker();
  if (!w) {
    const [{ buildSlipMold }, { masterSoupMm }, { loadManifold }] = await Promise.all([
      import('./slipCastMold'), import('./pourBoxScene'), import('./sculptCut'),
    ]);
    return buildSlipMold(await loadManifold(), masterSoupMm(scene, ids), options);
  }
  return ask<SlipMold>(w, { type: 'PLAN', id: ++seq, scene, ids, options });
}

/** The casting a planned mold makes: the clay wall built, drained, trimmed and fired. */
export async function simulateSlipCastOffThread(input: SlipCastInput, wallMm: number): Promise<SlipCastResult> {
  const w = ensureWorker();
  if (!w) {
    const [{ simulateSlipCast }, { loadManifold }] = await Promise.all([import('./slipCastSimulation'), import('./sculptCut')]);
    return simulateSlipCast(await loadManifold(), input, wallMm);
  }
  return ask<SlipCastResult>(w, { type: 'CAST', id: ++seq, input, wallMm });
}

function ask<T>(w: Worker, req: SlipMoldRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    pending.set(req.id, { resolve: resolve as (m: never) => void, reject });
    w.postMessage(req);
  });
}
