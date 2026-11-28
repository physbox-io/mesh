/**
 * A scene's cloth models, made on a small pool of workers
 * (workers/clothModelWorker.ts) side by side before a build, and kept here
 * by their `exact` key (clothInputs) to hand to the physics worker with the
 * build (PhysicsWorkerClient.build). The physics worker used to model every
 * garment itself, one after another, answering nothing meanwhile; and lost
 * them all when it was recycled.
 *
 * Under Node there is no Worker: nothing is modelled here, and the physics
 * worker's own fallback (clothWorld) models what it is not given.
 */

import type { SceneGraph } from '../../types/scene';
import type { ClothModel } from './clothModel';
import { clothInputs } from './clothInputs';
import type { ClothModelRequest, ClothModelResponse } from '../../workers/clothModelProtocol';

/** As many as the physics worker's cache holds (clothWorld MODEL_CACHE_SIZE). */
const CACHE_SIZE = 24;
/** A garment is seconds. Past this the worker is wedged on the job. */
const TIMEOUT_MS = 180_000;

const cache = new Map<string, ClothModel>();
const remember = (exact: string, m: ClothModel) => {
  cache.delete(exact);
  cache.set(exact, m);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
};

interface Job {
  id: number;
  exact: string;
  req: ClothModelRequest;
  done: (m: ClothModel | null) => void;
}
interface Slot { worker: Worker; job: Job | null; timer: ReturnType<typeof setTimeout> | null }

const slots: Slot[] = [];
const queue: Job[] = [];
const pending = new Map<string, Promise<ClothModel | null>>();
let seq = 0;

const poolSize = () => Math.max(1, Math.min(4, ((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4) - 2));

function drop(slot: Slot) {
  slot.worker.onmessage = null; slot.worker.onerror = null; slot.worker.onmessageerror = null;
  slot.worker.terminate();
  if (slot.timer) clearTimeout(slot.timer);
  const i = slots.indexOf(slot);
  if (i >= 0) slots.splice(i, 1);
}

function finish(slot: Slot, model: ClothModel | null) {
  const job = slot.job;
  slot.job = null;
  if (slot.timer) { clearTimeout(slot.timer); slot.timer = null; }
  if (job) {
    if (model) remember(job.exact, model);
    pending.delete(job.exact);
    job.done(model);
  }
  pump();
}

function spawn(): Slot | null {
  try {
    const slot: Slot = { worker: new Worker(new URL('../../workers/clothModelWorker.ts', import.meta.url), { type: 'module' }), job: null, timer: null };
    slot.worker.onmessage = (evt: MessageEvent<ClothModelResponse>) => {
      if (!slot.job || slot.job.id !== evt.data.id) return;
      finish(slot, evt.data.type === 'MODELLED' ? evt.data.model : null);
    };
    // Broken: what it was doing falls back to the physics worker, the rest go on without it.
    slot.worker.onerror = slot.worker.onmessageerror = () => { drop(slot); finish(slot, null); };
    slots.push(slot);
    return slot;
  } catch {
    return null;
  }
}

function pump() {
  while (queue.length) {
    const slot = slots.find((s) => !s.job) ?? (slots.length < poolSize() ? spawn() : null);
    if (!slot) return;
    const job = queue.shift()!;
    slot.job = job;
    slot.timer = setTimeout(() => { drop(slot); finish(slot, null); }, TIMEOUT_MS);
    try {
      slot.worker.postMessage(job.req);
    } catch {
      drop(slot);
      finish(slot, null);
    }
  }
}

/**
 * Models every cloth of `graph` (as the physics worker gets it, meshes
 * stripped) that is not modelled already, side by side; resolves when all
 * are, or have failed (the physics worker then models those itself).
 * Modelling queued for an earlier call and not wanted by this one is
 * dropped: a slider dragged queues an edit at every step.
 */
export async function modelClothsForBuild(graph: SceneGraph): Promise<void> {
  if (typeof Worker === 'undefined') return;
  const inputs = clothInputs(graph.nodes);
  const wanted = new Set(inputs.map((c) => c.exact));
  for (let i = queue.length - 1; i >= 0; i--) {
    if (wanted.has(queue[i].exact)) continue;
    const [job] = queue.splice(i, 1);
    pending.delete(job.exact);
    job.done(null);
  }
  const waits: Promise<unknown>[] = [];
  for (const { node, world, exact } of inputs) {
    if (cache.has(exact)) { remember(exact, cache.get(exact)!); continue; }
    let p = pending.get(exact);
    if (!p) {
      const id = ++seq;
      p = new Promise<ClothModel | null>((done) => {
        queue.push({ id, exact, done, req: { type: 'MODEL', id, node, world: Array.from(world.elements), nodes: graph.nodes } });
      });
      pending.set(exact, p);
    }
    waits.push(p);
  }
  pump();
  await Promise.all(waits);
}

/**
 * The models of `graph`'s cloths made here that the physics worker behind
 * `sent` has not been given yet (`sent` is that worker's own record, oldest
 * first; marked as they go, and kept to what its cache holds).
 */
export function clothModelsToSend(graph: SceneGraph, sent: Set<string>): [string, ClothModel][] {
  if (!cache.size) return [];
  const out: [string, ClothModel][] = [];
  for (const { exact } of clothInputs(graph.nodes)) {
    const m = cache.get(exact);
    if (!m) continue;
    if (!sent.has(exact)) out.push([exact, m]);
    sent.delete(exact);
    sent.add(exact);
  }
  while (sent.size > CACHE_SIZE) sent.delete(sent.values().next().value!);
  return out;
}

/** The model of a cloth by its `exact` key (clothInputs), if it was made here. */
export function cachedClothModel(exact: string): ClothModel | undefined {
  return cache.get(exact);
}
