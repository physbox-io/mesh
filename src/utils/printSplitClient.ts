// Thin postMessage client over the Split for Print worker.
//
// Same shape as utils/printSplit.ts and utils/printAssembly.ts, but async: the
// worker in a browser, the modules directly under Node and vite-node, where
// `Worker` does not exist. Also where a body becomes the soups the split takes,
// and a split becomes compiled assembly stages, since both need main-thread
// modules (the scene's geometry and the MJCF compiler) the worker must not load.

import * as THREE from 'three';
import type { SceneGraph, SceneNode } from '../types/scene';
import { getNodeWorldTransform } from './laserCutExporter';
import { compileToMJCF } from './mjcf';
import type { PlaneCutResult, SplitChecks, SplitOptions, SplitResult } from './printSplit';
import { buildAssemblyPlan, type AssemblyPlan, type MujocoLike, type StageResult } from './printAssembly';
import type { PrintSplitRequest, PrintSplitResponse } from '../workers/printSplitProtocol';
import { noteWorkerStopped } from './staleBuild';
import { partSoups } from './partSoups';

export { partSoups };

export type SplitOk = Extract<SplitResult, { ok: true }>;
export interface SplitOutcome { result: SplitResult; checks: SplitChecks | null }

/** A big part's search takes a few seconds. Past this the worker is wedged. */
const SPLIT_TIMEOUT_MS = 120_000;
/** Per stage of an assembly test. */
const STAGE_TIMEOUT_MS = 60_000;


/**
 * Several selected bodies as one part, in the first one's frame: Select
 * Multiple (or Shift-click) a box and the lid on it, and they are split as one
 * solid, so a seam can run through both. Every body after the first, and the
 * rigid bodies under each, are listed in `absorbed` for Apply to remove.
 */
export function selectionSoups(scene: SceneGraph, ids: string[]): { soups: Float64Array[]; absorbed: string[] } {
  const worlds = new Map<string, { node: SceneNode; world: THREE.Matrix4 }>();
  const walk = (nodes: SceneNode[], parent?: THREE.Matrix4) => {
    for (const n of nodes) {
      const world = getNodeWorldTransform(n, parent);
      worlds.set(n.id, { node: n, world });
      walk(n.children || [], world);
    }
  };
  walk(scene.nodes);
  const picked = ids.map((id) => worlds.get(id)).filter((x): x is { node: SceneNode; world: THREE.Matrix4 } => !!x);
  if (!picked.length) return { soups: [], absorbed: [] };
  const first = picked[0];
  const toFirst = first.world.clone().invert();
  const out = partSoups(first.node);
  const seen = new Set([first.node.id, ...out.absorbed]);
  for (const { node, world } of picked.slice(1)) {
    // A body already taken in as a rigid child of an earlier one is in already.
    if (seen.has(node.id)) continue;
    const more = partSoups(node, new THREE.Matrix4().multiplyMatrices(toFirst, world));
    out.soups.push(...more.soups);
    for (const id of [node.id, ...more.absorbed]) {
      if (!seen.has(id)) { seen.add(id); out.absorbed.push(id); }
    }
  }
  return out;
}

export interface PrintSplitWorkerLike {
  onmessage: ((evt: MessageEvent<PrintSplitResponse>) => void) | null;
  onerror: ((evt: ErrorEvent) => void) | null;
  onmessageerror: ((evt: MessageEvent) => void) | null;
  postMessage(message: PrintSplitRequest, transfer?: Transferable[]): void;
  terminate(): void;
}

export type PrintSplitWorkerFactory = () => PrintSplitWorkerLike | null;

type QueuedJob =
  | {
    id: number;
    kind: 'split';
    soups: Float64Array[];
    options: SplitOptions;
    resolve: (o: SplitOutcome) => void;
  }
  | {
    id: number;
    kind: 'plane';
    soups: Float64Array[];
    at: [number, number, number];
    normal: [number, number, number];
    resolve: (r: PlaneCutResult) => void;
  }
  | {
    id: number;
    kind: 'assemble';
    stages: { xml: string; stage: AssemblyPlan['stages'][number] extends infer S ? Omit<S, 'scene'> : never }[];
    resolve: (r: StageResult[]) => void;
    reject: (e: Error) => void;
    onProgress?: (done: number, total: number, result: StageResult) => void;
    results: StageResult[];
  };

type ActiveJob = QueuedJob & { timer: ReturnType<typeof setTimeout> };

let workerFactory: PrintSplitWorkerFactory | null = null;
let worker: PrintSplitWorkerLike | null = null;
let seq = 0;
let inFlight: ActiveJob | null = null;
const queued: QueuedJob[] = [];

function resolveJobFailure(job: QueuedJob, error: string): void {
  if (job.kind === 'split') job.resolve({ result: { ok: false, error }, checks: null });
  else if (job.kind === 'plane') job.resolve({ ok: false, error });
  else job.reject(new Error(error));
}

function terminateWorker(): void {
  const w = worker;
  worker = null;
  if (w) {
    w.onmessage = null;
    w.onerror = null;
    w.onmessageerror = null;
    w.terminate();
  }
}

function failAll(error: string): void {
  const active = inFlight;
  inFlight = null;
  const waiting = queued.splice(0, queued.length);
  if (active) {
    clearTimeout(active.timer);
    resolveJobFailure(active, error);
  }
  for (const job of waiting) resolveJobFailure(job, error);
}

function createWorkerInstance(): PrintSplitWorkerLike | null {
  if (workerFactory) return workerFactory();
  if (typeof Worker === 'undefined') return null;
  return new Worker(new URL('../workers/printSplitWorker.ts', import.meta.url), { type: 'module' });
}

function canUseWorker(): boolean {
  return workerFactory !== null || typeof Worker !== 'undefined';
}

function ensureWorker(): PrintSplitWorkerLike | null {
  if (worker) return worker;
  if (!canUseWorker()) return null;
  try {
    const w = createWorkerInstance();
    if (!w) return null;
    worker = w;
    w.onmessage = (evt: MessageEvent<PrintSplitResponse>) => {
      if (worker !== w) return;
      const msg = evt.data;
      const active = inFlight;
      if (!active || active.id !== msg.id) return;
      if (msg.type === 'SPLIT_DONE' && active.kind === 'split') {
        inFlight = null;
        clearTimeout(active.timer);
        active.resolve({ result: msg.result, checks: msg.checks });
        drainQueue();
      } else if (msg.type === 'PLANE_CUT_DONE' && active.kind === 'plane') {
        inFlight = null;
        clearTimeout(active.timer);
        active.resolve(msg.result);
        drainQueue();
      } else if (msg.type === 'ASSEMBLE_PROGRESS' && active.kind === 'assemble') {
        active.results.push(msg.result);
        active.onProgress?.(msg.done, msg.total, msg.result);
        clearTimeout(active.timer);
        active.timer = setTimeout(
          () => abandon(msg.id, 'A stage of the assembly test took too long and was abandoned.'),
          STAGE_TIMEOUT_MS,
        );
      } else if (msg.type === 'ASSEMBLE_DONE' && active.kind === 'assemble') {
        inFlight = null;
        clearTimeout(active.timer);
        active.resolve(active.results);
        drainQueue();
      } else if (msg.type === 'FAILED') {
        inFlight = null;
        clearTimeout(active.timer);
        resolveJobFailure(active, msg.error);
        drainQueue();
      }
    };
    const onWorkerBroken = (error: string) => {
      if (worker !== w) return;
      noteWorkerStopped();
      terminateWorker();
      failAll(error);
    };
    w.onerror = () => onWorkerBroken('Split for Print stopped working. Try again.');
    w.onmessageerror = () => onWorkerBroken('Split for Print could not read the worker response. Try again.');
  } catch {
    worker = null;
  }
  return worker;
}

function timeoutMessageFor(job: QueuedJob): string {
  if (job.kind === 'split') return 'The split took too long and was abandoned.';
  if (job.kind === 'plane') return 'The cut took too long and was abandoned.';
  return 'The assembly test took too long and was abandoned.';
}

function timeoutMsFor(job: QueuedJob): number {
  return job.kind === 'assemble' ? STAGE_TIMEOUT_MS : SPLIT_TIMEOUT_MS;
}

function drainQueue(): void {
  while (!inFlight && queued.length > 0) {
    const next = queued.shift()!;
    const w = ensureWorker();
    if (!w) {
      resolveJobFailure(next, 'Split for Print stopped working. Try again.');
      continue;
    }
    const timer = setTimeout(() => abandon(next.id, timeoutMessageFor(next)), timeoutMsFor(next));
    const active: ActiveJob = { ...next, timer };
    inFlight = active;
    try {
      if (active.kind === 'split') {
        // Copies, not the caller's arrays: they are transferred.
        const req: PrintSplitRequest = {
          type: 'SPLIT',
          id: active.id,
          soups: active.soups.map((s) => s.slice()),
          options: active.options,
        };
        w.postMessage(req, req.soups.map((s) => s.buffer));
      } else if (active.kind === 'plane') {
        const req: PrintSplitRequest = {
          type: 'PLANE_CUT',
          id: active.id,
          soups: active.soups.map((s) => s.slice()),
          at: active.at,
          normal: active.normal,
        };
        w.postMessage(req, req.soups.map((s) => s.buffer));
      } else {
        const req: PrintSplitRequest = { type: 'ASSEMBLE', id: active.id, stages: active.stages };
        w.postMessage(req);
      }
      return;
    } catch (err) {
      clearTimeout(active.timer);
      inFlight = null;
      resolveJobFailure(active, err instanceof Error ? err.message : String(err));
    }
  }
}

function abandon(id: number, error: string): void {
  const active = inFlight;
  if (!active || active.id !== id) return;
  inFlight = null;
  clearTimeout(active.timer);
  // A wedged worker is no use to the next request either; replace it so any
  // queued requests that never ran on it can execute cleanly on a fresh one.
  terminateWorker();
  resolveJobFailure(active, error);
  drainQueue();
}

/**
 * Test seam: override how the print-split worker is constructed. Pass `null`
 * to restore the default `new Worker(...)` behaviour and reset client state.
 */
export function setPrintSplitWorkerFactory(factory: PrintSplitWorkerFactory | null): void {
  terminateWorker();
  failAll('Split for Print worker was reset.');
  workerFactory = factory;
}

/** Start the worker and its wasm loading before the dialog asks for anything. */
export function prewarmPrintSplit(): void {
  const w = ensureWorker();
  if (w) w.postMessage({ type: 'WARM' } satisfies PrintSplitRequest);
}

/** Splits off the main thread where it can, inline where it cannot. Never rejects. */
export async function splitOffThread(soups: Float64Array[], options: SplitOptions): Promise<SplitOutcome> {
  if (!canUseWorker() || (!worker && !ensureWorker())) {
    const [{ loadManifold }, { splitForPrint, checkSplit }] = await Promise.all([import('./sculptCut'), import('./printSplit')]);
    const wasm = await loadManifold();
    const result = splitForPrint(wasm, soups, options);
    return { result, checks: result.ok ? checkSplit(wasm, result.sections, result.joints, soups) : null };
  }
  return new Promise<SplitOutcome>((resolve) => {
    // Latest-wins coalescing: supersede any queued split that has not started yet
    // so rapid slider/input edits never queue obsolete multi-second splits back-to-back.
    for (let i = queued.length - 1; i >= 0; i--) {
      const existing = queued[i];
      if (existing.kind === 'split') {
        queued.splice(i, 1);
        existing.resolve({ result: { ok: false, error: 'Superseded by a newer split request.' }, checks: null });
      }
    }
    const id = ++seq;
    queued.push({ id, kind: 'split', soups: soups.map((s) => s.slice()), options, resolve });
    drainQueue();
  });
}

/** The knife's through-cut, off the main thread where it can be, inline where not. Never rejects. */
export async function cutAlongPlaneOffThread(
  soups: Float64Array[],
  at: [number, number, number],
  normal: [number, number, number],
): Promise<PlaneCutResult> {
  if (!canUseWorker() || (!worker && !ensureWorker())) {
    const [{ loadManifold }, { cutAlongPlane }] = await Promise.all([import('./sculptCut'), import('./printSplit')]);
    return cutAlongPlane(await loadManifold(), soups, at, normal);
  }
  return new Promise<PlaneCutResult>((resolve) => {
    const id = ++seq;
    queued.push({ id, kind: 'plane', soups: soups.map((s) => s.slice()), at, normal, resolve });
    drainQueue();
  });
}

/** The same gravity and floor every assembly stage is run with. */
export function compileStage(scene: SceneGraph): string {
  return compileToMJCF(scene, -9.81, 0.3);
}

/**
 * Puts a split back together in MuJoCo, stage by stage, reporting each as it
 * finishes. Rejects only if the engine itself fails.
 */
export async function testAssemblyOffThread(
  split: SplitOk,
  onProgress?: (done: number, total: number, result: StageResult) => void,
): Promise<{ plan: AssemblyPlan; results: StageResult[] }> {
  const plan = buildAssemblyPlan(split);
  const stages = plan.stages.map(({ scene, ...stage }) => ({ xml: compileStage(scene), stage }));
  if (!canUseWorker() || (!worker && !ensureWorker())) {
    const [{ default: loadMujoco }, { runStage }] = await Promise.all([import('@mujoco/mujoco'), import('./printAssembly')]);
    const mj = (await loadMujoco()) as unknown as MujocoLike;
    const results: StageResult[] = [];
    stages.forEach(({ xml, stage }, k) => {
      const r = runStage(mj, xml, stage);
      results.push(r);
      onProgress?.(k + 1, stages.length, r);
    });
    return { plan, results };
  }
  const results = await new Promise<StageResult[]>((resolve, reject) => {
    const id = ++seq;
    queued.push({ id, kind: 'assemble', stages, resolve, reject, onProgress, results: [] });
    drainQueue();
  });
  return { plan, results };
}
