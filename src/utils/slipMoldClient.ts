// The Slip Cast tab's and MCP's end of workers/slipMoldWorker.ts. One worker,
// kept for the session; single-flight queued with per-subject latest-wins
// coalescing for PLAN requests so rapid option edits never pile up behind the
// worker, and per-job watchdog recovery. Where there is no Worker (the tests,
// under Node) the plan runs inline.

import type { SceneGraph } from '../types/scene';
import type { SlipMold, SlipMoldOptions } from './slipCastMold';
import type { SlipCastInput, SlipCastResult } from './slipCastSimulation';
import type { SlipMoldRequest, SlipMoldResponse } from '../workers/slipMoldProtocol';
import { workerStoppedError } from './staleBuild';

const SLIP_TIMEOUT_MS = 120_000;

/** A queued slip-mold PLAN superseded by a newer edit for the same subject. */
export class SlipMoldSupersededError extends Error {
  constructor() {
    super('Slip mold plan superseded by a newer edit.');
    this.name = 'Superseded';
  }
}

type QueuedJob =
  | {
      id: number;
      kind: 'plan';
      slot: string;
      scene: SceneGraph;
      ids: string[];
      options: Partial<SlipMoldOptions>;
      resolve: (m: SlipMold) => void;
      reject: (e: Error) => void;
    }
  | {
      id: number;
      kind: 'cast';
      input: SlipCastInput;
      wallMm: number;
      resolve: (r: SlipCastResult) => void;
      reject: (e: Error) => void;
    };

let worker: Worker | null = null;
let seq = 0;
let active: (QueuedJob & { timer: ReturnType<typeof setTimeout> }) | null = null;
const queued: QueuedJob[] = [];
/** The scene the worker already holds, so option tweaks send options alone. */
let sceneSent: SceneGraph | null = null;

function dropWorker(w: Worker | null): void {
  if (w) {
    w.onmessage = null;
    w.onerror = null;
    w.onmessageerror = null;
    w.terminate();
  }
  if (worker === w) worker = null;
  sceneSent = null;
}

function ensureWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    const w = new Worker(new URL('../workers/slipMoldWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (evt: MessageEvent<SlipMoldResponse>) => {
      if (worker !== w) return;
      const msg = evt.data;
      if (!active || active.id !== msg.id) return;
      const done = active;
      active = null;
      clearTimeout(done.timer);
      if (msg.type === 'PLANNED' && done.kind === 'plan') done.resolve(msg.mold);
      else if (msg.type === 'CAST_DONE' && done.kind === 'cast') done.resolve(msg.result);
      else done.reject(new Error(msg.type === 'FAILED' ? msg.error : 'Unexpected slip mold worker reply.'));
      pump();
    };
    const handleBroken = (fallbackMessage: string) => {
      if (worker !== w) return;
      const waiters: ((e: Error) => void)[] = [];
      if (active) {
        clearTimeout(active.timer);
        waiters.push(active.reject);
        active = null;
      }
      while (queued.length > 0) waiters.push(queued.shift()!.reject);
      dropWorker(w);
      void workerStoppedError(fallbackMessage).then((err) => waiters.forEach((rej) => rej(err)));
    };
    w.onerror = () => handleBroken('The slip mold worker stopped.');
    w.onmessageerror = () => handleBroken('The slip mold worker could not read the worker response.');
    worker = w;
    return w;
  } catch {
    return null;
  }
}

function pump(): void {
  while (!active && queued.length > 0) {
    const next = queued.shift()!;
    const w = ensureWorker();
    if (!w) {
      if (next.kind === 'plan') {
        Promise.all([import('./slipCastMold'), import('./pourBoxScene'), import('./sculptCut')])
          .then(async ([{ buildSlipMold }, { masterSoupMm }, { loadManifold }]) =>
            next.resolve(buildSlipMold(await loadManifold(), masterSoupMm(next.scene, next.ids), next.options)),
          )
          .catch((e) => next.reject(e instanceof Error ? e : new Error(String(e))))
          .finally(pump);
      } else {
        Promise.all([import('./slipCastSimulation'), import('./sculptCut')])
          .then(async ([{ simulateSlipCast }, { loadManifold }]) =>
            next.resolve(simulateSlipCast(await loadManifold(), next.input, next.wallMm)),
          )
          .catch((e) => next.reject(e instanceof Error ? e : new Error(String(e))))
          .finally(pump);
      }
      return;
    }

    const timer = setTimeout(() => {
      if (active?.id !== next.id) return;
      const wedged = active;
      active = null;
      dropWorker(w);
      wedged.reject(new Error('The slip mold worker took too long and was abandoned.'));
      pump();
    }, SLIP_TIMEOUT_MS);

    active = { ...next, timer };
    const prevScene = sceneSent;
    try {
      let req: SlipMoldRequest;
      if (next.kind === 'plan') {
        const fresh = next.scene !== sceneSent;
        sceneSent = next.scene;
        req = {
          type: 'PLAN',
          id: next.id,
          ...(fresh ? { scene: next.scene } : {}),
          ids: next.ids,
          options: next.options,
        };
      } else {
        req = { type: 'CAST', id: next.id, input: next.input, wallMm: next.wallMm };
      }
      w.postMessage(req);
      return;
    } catch (e) {
      clearTimeout(timer);
      active = null;
      sceneSent = prevScene;
      next.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }
}

/** Plans the slip-cast mold round the given bodies, without touching the scene. */
export async function planSlipMold(scene: SceneGraph, ids: string[], options: Partial<SlipMoldOptions>): Promise<SlipMold> {
  if (typeof Worker === 'undefined') {
    const [{ buildSlipMold }, { masterSoupMm }, { loadManifold }] = await Promise.all([
      import('./slipCastMold'), import('./pourBoxScene'), import('./sculptCut'),
    ]);
    return buildSlipMold(await loadManifold(), masterSoupMm(scene, ids), options);
  }
  const slot = ids.join('\0');
  for (let i = queued.length - 1; i >= 0; i--) {
    const q = queued[i];
    if (q.kind === 'plan' && q.slot === slot) {
      queued.splice(i, 1);
      q.reject(new SlipMoldSupersededError());
    }
  }
  return new Promise<SlipMold>((resolve, reject) => {
    queued.push({ id: ++seq, kind: 'plan', slot, scene, ids, options, resolve, reject });
    pump();
  });
}

/** The casting a planned mold makes: the clay wall built, drained, trimmed and fired. */
export async function simulateSlipCastOffThread(input: SlipCastInput, wallMm: number): Promise<SlipCastResult> {
  if (typeof Worker === 'undefined') {
    const [{ simulateSlipCast }, { loadManifold }] = await Promise.all([import('./slipCastSimulation'), import('./sculptCut')]);
    return simulateSlipCast(await loadManifold(), input, wallMm);
  }
  return new Promise<SlipCastResult>((resolve, reject) => {
    queued.push({ id: ++seq, kind: 'cast', input, wallMm, resolve, reject });
    pump();
  });
}
