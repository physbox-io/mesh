// Thin postMessage client over the V-HACD worker.
//
// Exposes the same signature as utils/vhacd.ts's decomposeMesh, so the producer
// in convexDecomposition.ts can reach for whichever is available without caring:
// the worker in a browser, the module directly under Node and vite-node, where
// `Worker` does not exist at all. That fallback is not a nicety — it is what
// lets scripts/export-presets.ts and the test suite decompose.
//
// One worker, not a pool, and one job in it at a time. A pool was measured and
// is not worth it: the wasm heap never shrinks, and is 60 MB after a cup at 25k
// voxels and 230 MB after a 384-piece chute at 400k, so a second worker is a
// second heap that size for work that is mostly one body at a time anyway.
//
// One job at a time is what makes a timeout mean something. Every request used
// to be posted at once and timed from the post, so a scene of four concave
// bodies built over MCP timed out all four: the fourth's 20 s ran out while the
// first three were still in front of it. A job is now posted only when the
// worker is idle, so its clock is its own; and a job that does time out is
// stopped by terminating the worker, which used to grind on through it while
// everything behind it waited and timed out in turn. The next job gets a new
// worker.

import type { Hull } from './csg';
import type { DecomposeParams } from './vhacd';
import type { FilledCavity } from './filledCavities';
import type { HullPayload, MeshAnalysis, VhacdRequest, VhacdResponse } from '../workers/vhacdProtocol';
import { noteWorkerStopped } from './staleBuild';

/**
 * Long enough for any shape that passed the triangle cap, short enough that a
 * forced decomposition of something pathological gives up rather than wedging
 * the compile pass. The caller falls back to colliding as a hull. Counted from
 * when the worker is given the job, not from when it was asked for.
 */
export const DECOMPOSE_TIMEOUT_MS = 20_000;

/** Measuring is a hull and an edge walk, well under a second. */
export const ANALYSE_TIMEOUT_MS = 10_000;

/** What the client needs of a Worker; a test passes its own. */
export interface WorkerLike {
  postMessage(msg: VhacdRequest, transfer: Transferable[]): void;
  terminate(): void;
  onmessage: ((evt: MessageEvent<VhacdResponse>) => void) | null;
  onerror: ((evt: unknown) => void) | null;
}

type Job = {
  build: (id: number) => VhacdRequest & { verts: Float64Array; faces: Uint32Array };
  timeoutMs: number;
  timeoutMessage: string;
  resolve: (value: unknown) => void;
  reject: (e: Error) => void;
};

const defaultSpawn = (): WorkerLike | null => {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('../workers/vhacdWorker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
  } catch {
    return null;
  }
};

let spawn: () => WorkerLike | null = defaultSpawn;
let worker: WorkerLike | null = null;
let seq = 0;
const queue: Job[] = [];
let running: { id: number; job: Job; timer: ReturnType<typeof setTimeout> } | null = null;
const cavitiesByHulls = new WeakMap<Hull[], FilledCavity[]>();

/** For tests: the worker to use instead of the real one. Resets the queue. */
export function setVhacdWorkerFactory(factory: (() => WorkerLike | null) | null): void {
  worker?.terminate();
  worker = null;
  if (running) clearTimeout(running.timer);
  running = null;
  queue.length = 0;
  spawn = factory ?? defaultSpawn;
}

/** Jobs waiting or running, for whoever wants to know whether the worker is busy. */
export function vhacdJobsPending(): number {
  return queue.length + (running ? 1 : 0);
}

function stopWorker() {
  worker?.terminate();
  worker = null;
}

function finish(id: number, settle: (job: Job) => void) {
  if (!running || running.id !== id) return;
  const { job, timer } = running;
  clearTimeout(timer);
  running = null;
  settle(job);
  pump();
}

function ensureWorker(): WorkerLike | null {
  if (worker) return worker;
  const w = spawn();
  if (!w) return null;
  w.onmessage = (evt: MessageEvent<VhacdResponse>) => {
    const msg = evt.data;
    finish(msg.id, (job) => {
      if (msg.type === 'DECOMPOSE_ERROR') job.reject(new Error(msg.message));
      else if (msg.type === 'ANALYSED') job.resolve(msg.analysis);
      else {
        const hulls = msg.hulls.map(fromPayload);
        if (msg.cavities) cavitiesByHulls.set(hulls, msg.cavities);
        job.resolve(hulls);
      }
    });
  };
  // A worker that dies fails the job it was running, and only that one: the
  // jobs behind it get a new worker.
  w.onerror = () => {
    noteWorkerStopped();
    if (worker === w) stopWorker();
    if (running) finish(running.id, (job) => job.reject(new Error('The convex decomposition worker stopped.')));
  };
  worker = w;
  return w;
}

function pump() {
  if (running || queue.length === 0) return;
  const w = ensureWorker();
  if (!w) {
    // The worker could not be started at all; nothing behind this will fare better.
    for (const job of queue.splice(0)) job.reject(new Error('The convex decomposition worker could not be started.'));
    return;
  }
  const job = queue.shift()!;
  const id = ++seq;
  const timer = setTimeout(() => {
    // Stopped, not abandoned: left running it would hold every job behind it.
    stopWorker();
    finish(id, (j) => j.reject(new Error(j.timeoutMessage)));
  }, job.timeoutMs);
  running = { id, job, timer };
  const req = job.build(id);
  try {
    w.postMessage(req, [req.verts.buffer, req.faces.buffer]);
  } catch (err) {
    stopWorker();
    finish(id, (j) => j.reject(err instanceof Error ? err : new Error(String(err))));
  }
}

function request<T>(
  timeoutMessage: string,
  timeoutMs: number,
  build: Job['build'],
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({ build, timeoutMs, timeoutMessage, resolve: resolve as (v: unknown) => void, reject });
    pump();
  });
}

/** Whether there is a worker to send jobs to, or this has to run inline. */
function hasWorker(): boolean {
  return ensureWorker() !== null;
}

const fromPayload = (h: HullPayload): Hull => ({
  verts: Array.from(h.verts),
  faces: Array.from(h.faces),
  volume: h.volume,
  centroid: h.centroid,
});

/**
 * Decomposes off the main thread where it can, inline where it cannot.
 *
 * Deliberately not counted in the SCAD pool's compile counter: this runs behind
 * every sculpt stroke, and a "SCAD Compiling" pill for a side effect of the
 * user's own action is noise, not news.
 */
export async function decomposeMeshOffThread(
  verts: number[],
  faces: number[],
  params: Partial<DecomposeParams> = {},
): Promise<Hull[]> {
  if (!hasWorker()) {
    const { decomposeMesh } = await import('./vhacd');
    return decomposeMesh(verts, faces, params);
  }
  return request<Hull[]>('Convex decomposition timed out.', DECOMPOSE_TIMEOUT_MS, (id) => ({
    type: 'DECOMPOSE', id, params,
    verts: Float64Array.from(verts),
    faces: Uint32Array.from(faces),
  }));
}

export async function decomposeWithCavitiesOffThread(
  verts: number[],
  faces: number[],
  params: Partial<DecomposeParams> = {},
): Promise<{ hulls: Hull[]; cavities: FilledCavity[] }> {
  if (!hasWorker()) {
    const { decomposeMesh } = await import('./vhacd');
    const { findFilledCavities } = await import('./filledCavities');
    const hulls = await decomposeMesh(verts, faces, params);
    return { hulls, cavities: findFilledCavities(verts, faces, hulls) };
  }
  const hulls = await request<Hull[]>('Convex decomposition timed out.', DECOMPOSE_TIMEOUT_MS, (id) => ({
    type: 'DECOMPOSE', id, params, findCavities: true,
    verts: Float64Array.from(verts),
    faces: Uint32Array.from(faces),
  }));
  const { findFilledCavities } = await import('./filledCavities');
  return { hulls, cavities: cavitiesByHulls.get(hulls) ?? findFilledCavities(verts, faces, hulls) };
}

/**
 * Volume, hull volume and integrity of a mesh, measured off the main thread
 * where it can be. See utils/meshAnalysis.ts.
 */
export async function analyseMeshOffThread(verts: number[], faces: number[]): Promise<MeshAnalysis> {
  if (!hasWorker()) {
    const { analyseMesh } = await import('./meshAnalysis');
    return analyseMesh(verts, faces);
  }
  return request<MeshAnalysis>('Measuring the mesh timed out.', ANALYSE_TIMEOUT_MS, (id) => ({
    type: 'ANALYSE', id,
    verts: Float64Array.from(verts),
    faces: Uint32Array.from(faces),
  }));
}
