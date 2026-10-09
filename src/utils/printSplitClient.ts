// Thin postMessage client over the Split for Print worker.
//
// Same shape as utils/printSplit.ts and utils/printAssembly.ts, but async: the
// worker in a browser, the modules directly under Node and vite-node, where
// `Worker` does not exist. Also where a body becomes the soups the split takes,
// and a split becomes compiled assembly stages, since both need main-thread
// modules (the scene's geometry and the MJCF compiler) the worker must not load.

import * as THREE from 'three';
import type { SceneGraph, SceneNode } from '../types/scene';
import { appendSolidTriangles } from './contourSliceExporter';
import { getNodeWorldTransform } from './laserCutExporter';
import { resolveCsgGeoms } from './csg';
import { compileToMJCF } from './mjcf';
import type { SplitChecks, SplitOptions, SplitResult } from './printSplit';
import { buildAssemblyPlan, type AssemblyPlan, type MujocoLike, type StageResult } from './printAssembly';
import type { PrintSplitRequest, PrintSplitResponse } from '../workers/printSplitProtocol';

export type SplitOk = Extract<SplitResult, { ok: true }>;
export interface SplitOutcome { result: SplitResult; checks: SplitChecks | null }

/** A big part's search takes a few seconds. Past this the worker is wedged. */
const SPLIT_TIMEOUT_MS = 120_000;
/** Per stage of an assembly test. */
const STAGE_TIMEOUT_MS = 60_000;

/**
 * A part's solids as the split takes them: one triangle soup per geom, in the
 * selected body's own frame (Z-up metres), booleans already applied.
 *
 * "The part" is the body and every body rigidly attached under it — children
 * with no joints of their own, all the way down. A model built as a parent
 * holding its panels (the birdhouse is a bare root with seven walls under it)
 * is one part to print, and splitting only the root's own geoms would find
 * nothing at all. A child that has a joint moves on its own, so it is a
 * separate part, and it and everything under it are left out.
 *
 * Only collision-only geoms are skipped. A compiled boolean's mesh is marked
 * visual-only for the physics (its primitives collide), but it is exactly the
 * shape to print — the same rule collectSceneTriangles follows.
 */
export function partSoups(node: SceneNode, frame = new THREE.Matrix4()): { soups: Float64Array[]; absorbed: string[] } {
  const soups: Float64Array[] = [];
  const absorbed: string[] = [];
  const add = (n: SceneNode, frame: THREE.Matrix4) => {
    for (const geom of resolveCsgGeoms(n, 'render')) {
      if (geom.role === 'collision') continue;
      const out: number[] = [];
      if (appendSolidTriangles(geom, frame, out) && out.length >= 36) soups.push(Float64Array.from(out));
    }
    for (const child of n.children || []) {
      if (child.joints?.length) continue;
      absorbed.push(child.id);
      add(child, getNodeWorldTransform(child, frame));
    }
  };
  add(node, frame);
  return { soups, absorbed };
}

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

type Pending =
  | { kind: 'split'; resolve: (o: SplitOutcome) => void; timer: ReturnType<typeof setTimeout> }
  | {
    kind: 'assemble';
    resolve: (r: StageResult[]) => void;
    reject: (e: Error) => void;
    onProgress?: (done: number, total: number, result: StageResult) => void;
    results: StageResult[];
    timer: ReturnType<typeof setTimeout>;
    total: number;
  };

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function failAll(error: string) {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    if (p.kind === 'split') p.resolve({ result: { ok: false, error }, checks: null });
    else p.reject(new Error(error));
  }
  pending.clear();
}

function ensureWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('../workers/printSplitWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (evt: MessageEvent<PrintSplitResponse>) => {
      const msg = evt.data;
      const p = pending.get(msg.id);
      if (!p) return;
      if (msg.type === 'SPLIT_DONE' && p.kind === 'split') {
        pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve({ result: msg.result, checks: msg.checks });
      } else if (msg.type === 'ASSEMBLE_PROGRESS' && p.kind === 'assemble') {
        p.results.push(msg.result);
        p.onProgress?.(msg.done, msg.total, msg.result);
        clearTimeout(p.timer);
        p.timer = setTimeout(() => abandon(msg.id, 'A stage of the assembly test took too long and was abandoned.'), STAGE_TIMEOUT_MS);
      } else if (msg.type === 'ASSEMBLE_DONE' && p.kind === 'assemble') {
        pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(p.results);
      } else if (msg.type === 'FAILED') {
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (p.kind === 'split') p.resolve({ result: { ok: false, error: msg.error }, checks: null });
        else p.reject(new Error(msg.error));
      }
    };
    worker.onerror = () => {
      failAll('Split for Print stopped working. Try again.');
      worker?.terminate();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

function abandon(id: number, error: string) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (p.kind === 'split') p.resolve({ result: { ok: false, error }, checks: null });
  else p.reject(new Error(error));
  // A wedged worker is no use to the next request either.
  worker?.terminate();
  worker = null;
  failAll(error);
}

/** Start the worker and its wasm loading before the dialog asks for anything. */
export function prewarmPrintSplit(): void {
  const w = ensureWorker();
  if (w) w.postMessage({ type: 'WARM' } satisfies PrintSplitRequest);
}

/** Splits off the main thread where it can, inline where it cannot. Never rejects. */
export async function splitOffThread(soups: Float64Array[], options: SplitOptions): Promise<SplitOutcome> {
  const w = ensureWorker();
  if (!w) {
    const [{ loadManifold }, { splitForPrint, checkSplit }] = await Promise.all([import('./sculptCut'), import('./printSplit')]);
    const wasm = await loadManifold();
    const result = splitForPrint(wasm, soups, options);
    return { result, checks: result.ok ? checkSplit(wasm, result.sections, result.joints, soups) : null };
  }
  return new Promise<SplitOutcome>((resolve) => {
    const id = ++seq;
    const timer = setTimeout(() => abandon(id, 'The split took too long and was abandoned.'), SPLIT_TIMEOUT_MS);
    pending.set(id, { kind: 'split', resolve, timer });
    // Copies, not the caller's arrays: they are transferred.
    const req: PrintSplitRequest = { type: 'SPLIT', id, soups: soups.map((s) => s.slice()), options };
    w.postMessage(req, req.soups.map((s) => s.buffer));
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
  const w = ensureWorker();
  if (!w) {
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
    const timer = setTimeout(() => abandon(id, 'The assembly test took too long and was abandoned.'), STAGE_TIMEOUT_MS);
    pending.set(id, { kind: 'assemble', resolve, reject, onProgress, results: [], timer, total: stages.length });
    w.postMessage({ type: 'ASSEMBLE', id, stages } satisfies PrintSplitRequest);
  });
  return { plan, results };
}
