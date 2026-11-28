// ---------------------------------------------------------------------------
// The DFM lens's end of the DFM worker
// ---------------------------------------------------------------------------
//
// The panel, the heat map on the parts and the spatial focus overlay all read
// the same analyses of the same scene. They ask here, and each analysis runs
// once per scene and lens on workers/dfmWorker.ts; the answer is kept against
// the scene graph object, which is never edited in place, so the next view
// that asks gets it at once.
//
// Concurrency model:
// - UI polling requests (`useDfmReport` / `useStructuralWeakSpots`) coalesce
//   per slot (latest-wins), so dragging a slider or clicking through parts
//   never builds a backlog.
// - Imperative requests (`dfmReportFor`, used by MCP `CHECK_DFM`, mold checks
//   and slip-casting checks with synthetic subset SceneGraphs) live in their
//   own FIFO queue and are NEVER evicted by UI polling, nor do they evict UI
//   jobs.
// - A per-job watchdog timeout and `onmessageerror` handler ensure a wedged
//   or crashing worker is terminated, replaced on demand, and never leaves
//   callers hanging forever.
//
// Where there is no Worker (the tests, under Node) the analysis runs inline,
// through the same cache.

import { useEffect, useState, useSyncExternalStore } from 'react';
import * as THREE from 'three';
import type { SceneGraph, SceneNode } from '../types/scene';
import { analyseDfm, type DfmFinding, type DfmProcess, type DfmReport } from './dfm';
import { structuralWeakSpots, type WeakSpot } from './printAnalysis';
import { getNodeWorldTransform } from './laserCutExporter';
import { isNodeRotationBaked } from './sceneTree';
import { noteWorkerStopped } from './staleBuild';
import type { DfmBenchArgs, DfmRequest, DfmResponse } from '../workers/dfmProtocol';

export interface DfmWorkerLike {
  onmessage: ((evt: MessageEvent<DfmResponse>) => void) | null;
  onerror: ((evt?: unknown) => void) | null;
  onmessageerror: ((evt?: unknown) => void) | null;
  postMessage: (msg: DfmRequest) => void;
  terminate: () => void;
}

export const DEFAULT_DFM_JOB_TIMEOUT_MS = 60_000;

type Ask = { type: 'DFM'; process: DfmProcess; bench: DfmBenchArgs; wholeScene?: SceneGraph } | { type: 'WEAK_SPOTS' };
type JobKind = 'ui' | 'imperative';
type Job = {
  id: number;
  key: string;
  kind: JobKind;
  slot?: string;
  scene: SceneGraph;
  ask: Ask;
  settle: (result: unknown) => void;
};
type InFlightEntry = { promise: Promise<unknown>; job: Job };

let results = new WeakMap<SceneGraph, Map<string, unknown>>();
let inFlight = new WeakMap<SceneGraph, Map<string, InFlightEntry>>();

let workerFactory: (() => DfmWorkerLike) | null = null;
let jobTimeoutMs = DEFAULT_DFM_JOB_TIMEOUT_MS;
let worker: DfmWorkerLike | null = null;
let seq = 0;
let running: Job | null = null;
let runningTimer: ReturnType<typeof setTimeout> | null = null;
let imperativeQueue: Job[] = [];
let uiQueue: Job[] = [];
/** The scene the worker already holds, so a second lens on it sends no scene. */
let sceneSent: SceneGraph | null = null;

/** Test seam: inject a fake worker factory (pass null to restore the real browser Worker). */
export function setDfmWorkerFactory(factory: (() => DfmWorkerLike) | null): void {
  resetWorkerState();
  workerFactory = factory;
}

/** Test seam: reset worker, queues, caches, focus state and optional watchdog timeout. */
export function resetDfmWorkerClientForTests(opts?: { timeoutMs?: number }): void {
  resetWorkerState();
  results = new WeakMap();
  inFlight = new WeakMap();
  seq = 0;
  jobTimeoutMs = opts?.timeoutMs ?? DEFAULT_DFM_JOB_TIMEOUT_MS;
  cachedLivePose = null;
  clearDfmFocus();
  setDfmCheckAllAsPlate(false);
}

function clearRunningTimer(): void {
  if (runningTimer !== null) {
    clearTimeout(runningTimer);
    runningTimer = null;
  }
}

function dropWorker(w: DfmWorkerLike | null): void {
  if (w) {
    w.onmessage = null;
    w.onerror = null;
    w.onmessageerror = null;
    try {
      w.terminate();
    } catch {
      // ignore termination errors on already-dead workers
    }
  }
  if (worker === w) worker = null;
  sceneSent = null;
}

function resetWorkerState(): void {
  clearRunningTimer();
  const pending = [...(running ? [running] : []), ...imperativeQueue, ...uiQueue];
  running = null;
  imperativeQueue = [];
  uiQueue = [];
  dropWorker(worker);
  for (const job of pending) job.settle(null);
}

function handleWorkerCrash(w: DfmWorkerLike, notifyStopped: boolean): void {
  if (notifyStopped) noteWorkerStopped();
  clearRunningTimer();
  const pending = [...(running ? [running] : []), ...imperativeQueue, ...uiQueue];
  running = null;
  imperativeQueue = [];
  uiQueue = [];
  dropWorker(w);
  for (const job of pending) job.settle(null);
}

function handleRunningFailure(w: DfmWorkerLike): void {
  clearRunningTimer();
  const failed = running;
  running = null;
  dropWorker(w);
  failed?.settle(null);
  pump();
}

function ensureWorker(): DfmWorkerLike | null {
  if (worker) return worker;
  if (!workerFactory && typeof Worker === 'undefined') return null;
  try {
    const w: DfmWorkerLike = workerFactory
      ? workerFactory()
      : (new Worker(new URL('../workers/dfmWorker.ts', import.meta.url), { type: 'module' }) as unknown as DfmWorkerLike);
    w.onmessage = (evt: MessageEvent<DfmResponse>) => {
      if (worker !== w) return;
      const msg = evt.data;
      const job = running;
      if (!job || job.id !== msg.id) return;
      clearRunningTimer();
      running = null;
      const result = msg.type === 'DFM_DONE' ? msg.report : msg.type === 'WEAK_SPOTS_DONE' ? msg.weakSpots : null;
      if (result !== null) remember(job.scene, job.key, result);
      job.settle(result);
      pump();
    };
    // Every caller would wait for good otherwise. The next request starts a
    // fresh worker; starting one here would loop load-fail-respawn for as long
    // as the tab is out of date, which is the usual reason it never loaded.
    w.onerror = () => {
      if (worker !== w) return;
      handleWorkerCrash(w, true);
    };
    w.onmessageerror = () => {
      if (worker !== w) return;
      handleRunningFailure(w);
    };
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

function remember(scene: SceneGraph, key: string, result: unknown) {
  let byKey = results.get(scene);
  if (!byKey) results.set(scene, (byKey = new Map()));
  byKey.set(key, result);
}

function pump() {
  if (running) return;
  const job = imperativeQueue.shift() ?? uiQueue.shift();
  if (!job) return;

  const w = ensureWorker();
  if (!w) {
    const result = inline(job.scene, job.ask);
    if (result !== null) remember(job.scene, job.key, result);
    job.settle(result);
    pump();
    return;
  }

  running = job;
  const fresh = job.scene !== sceneSent;
  sceneSent = job.scene;
  const msg: DfmRequest = { ...job.ask, id: job.id, ...(fresh ? { scene: job.scene } : {}) };

  if (jobTimeoutMs > 0) {
    runningTimer = setTimeout(() => {
      if (running !== job || worker !== w) return;
      handleRunningFailure(w);
    }, jobTimeoutMs);
  }

  try {
    w.postMessage(msg);
  } catch {
    clearRunningTimer();
    running = null;
    sceneSent = null;
    job.settle(null);
    pump();
  }
}

function inline(scene: SceneGraph, ask: Ask): unknown {
  try {
    return ask.type === 'DFM' ? analyseDfm(scene, ask.process, ask.bench, ask.wholeScene) : structuralWeakSpots(scene);
  } catch {
    return null;
  }
}

function requestInternal(scene: SceneGraph, key: string, ask: Ask, kind: JobKind, slot?: string): Promise<unknown> {
  const hit = results.get(scene)?.get(key);
  if (hit !== undefined) return Promise.resolve(hit);

  const pending = inFlight.get(scene)?.get(key);
  if (pending) {
    // If an imperative caller asks for the exact same (scene, key) currently
    // sitting in the UI queue, promote it so a subsequent UI edit cannot evict it.
    if (kind === 'imperative' && pending.job.kind === 'ui') {
      const idx = uiQueue.indexOf(pending.job);
      if (idx >= 0) {
        uiQueue.splice(idx, 1);
        pending.job.kind = 'imperative';
        imperativeQueue.push(pending.job);
      } else {
        pending.job.kind = 'imperative';
      }
    }
    return pending.promise;
  }

  const w = ensureWorker();
  if (!w) {
    const result = inline(scene, ask);
    if (result !== null) remember(scene, key, result);
    return Promise.resolve(result);
  }

  if (kind === 'ui') {
    // Coalesce ONLY queued UI jobs (same slot or older scene); never touch imperativeQueue.
    const kept: Job[] = [];
    const evicted: Job[] = [];
    for (const queued of uiQueue) {
      if (queued.scene !== scene || (slot && queued.slot === slot)) evicted.push(queued);
      else kept.push(queued);
    }
    uiQueue = kept;
    for (const stale of evicted) stale.settle(null);
  }

  let jobRecord!: Job;
  const promise = new Promise<unknown>((resolve) => {
    jobRecord = { id: ++seq, key, kind, slot, scene, ask, settle: resolve };
    if (kind === 'imperative') imperativeQueue.push(jobRecord);
    else uiQueue.push(jobRecord);
  });

  let byKey = inFlight.get(scene);
  if (!byKey) inFlight.set(scene, (byKey = new Map()));
  byKey.set(key, { promise, job: jobRecord });
  void promise.finally(() => {
    const map = inFlight.get(scene);
    if (map?.get(key)?.promise === promise) map.delete(key);
  });
  pump();
  return promise;
}

const sceneTagIds = new WeakMap<SceneGraph, number>();
let nextSceneTagId = 1;
const sceneTagOf = (s: SceneGraph | undefined): number => {
  if (!s) return 0;
  let id = sceneTagIds.get(s);
  if (!id) sceneTagIds.set(s, (id = nextSceneTagId++));
  return id;
};
const dfmKey = (process: DfmProcess, bench: DfmBenchArgs, wholeScene?: SceneGraph) =>
  wholeScene ? JSON.stringify(['dfm', process, bench, sceneTagOf(wholeScene)]) : JSON.stringify(['dfm', process, bench]);
const dfmScopeKey = (process: DfmProcess, bench: DfmBenchArgs) =>
  JSON.stringify([process, bench.nodeId ?? null, Boolean(bench.checkAllAsPlate)]);
const WEAK_SPOTS_KEY = 'weakSpots';

/**
 * UI-slot request helper (coalescing, latest-wins within its slot).
 * Exposed so unit tests can exercise concurrent UI polling + imperative `dfmReportFor`.
 */
export function requestDfmReportUi(scene: SceneGraph, process: DfmProcess, bench: DfmBenchArgs): Promise<DfmReport | null> {
  return requestInternal(scene, dfmKey(process, bench), { type: 'DFM', process, bench }, 'ui', `dfm:${process}`) as Promise<DfmReport | null>;
}

/**
 * The latest answer for (scene, key), or null while `key` is null.
 *
 * While a new answer for the SAME target identity (`scopeKey`) is being worked
 * out (e.g. during a slider drag), the last answer stands so edits do not
 * blank the HUD. Switching selected parts, toggling Cast, or toggling plate
 * mode changes `scopeKey` and clears the previous target immediately so Part A's
 * heatmap never flashes under Part B's title.
 */
function useAnalysis<T>(
  scene: SceneGraph | null,
  key: string | null,
  ask: Ask,
  slot: string,
  scopeKey: string | null,
): T | null {
  const [last, setLast] = useState<{ scope: string; value: T } | null>(null);
  const hit = scene && key ? (results.get(scene)?.get(key) as T | undefined) : undefined;
  // Closing the lens or switching target forgets the stale answer immediately.
  if ((!scene || !key || !scopeKey) && last !== null) setLast(null);
  else if (scopeKey && last !== null && last.scope !== scopeKey) setLast(null);

  useEffect(() => {
    if (!scene || !key || !scopeKey) return;
    let live = true;
    void requestInternal(scene, key, ask, 'ui', slot).then((result) => {
      if (live && result !== null) setLast({ scope: scopeKey, value: result as T });
    });
    return () => {
      live = false;
    };
    // `ask` is described in full by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, key, slot, scopeKey]);

  if (!scene || !key || !scopeKey) return null;
  if (hit !== undefined) return hit;
  return last && last.scope === scopeKey ? last.value : null;
}

/** The DFM report for one lens, worked out off the main thread. Null while `process` is. */
export function useDfmReport(scene: SceneGraph | null, process: DfmProcess | null, bench: DfmBenchArgs): DfmReport | null {
  const key = process ? dfmKey(process, bench) : null;
  const scopeKey = process ? dfmScopeKey(process, bench) : null;
  return useAnalysis<DfmReport>(
    scene,
    key,
    process ? { type: 'DFM', process, bench } : { type: 'WEAK_SPOTS' },
    process ? `dfm:${process}` : 'dfm:none',
    scopeKey,
  );
}

/** The structural weak spots (see printAnalysis.structuralWeakSpots), off the main thread. Null while `enabled` is false. */
export function useStructuralWeakSpots(scene: SceneGraph | null, enabled: boolean): WeakSpot[] | null {
  return useAnalysis<WeakSpot[]>(
    scene,
    enabled ? WEAK_SPOTS_KEY : null,
    { type: 'WEAK_SPOTS' },
    'weakSpots',
    enabled ? WEAK_SPOTS_KEY : null,
  );
}

/**
 * The DFM report as a promise, for non-component callers (MCP `CHECK_DFM`,
 * mold / slip-casting checks). Queued independently from UI polling so open
 * DFM HUD edits can never evict an imperative check.
 */
export async function dfmReportFor(
  scene: SceneGraph,
  process: DfmProcess,
  bench: DfmBenchArgs,
  wholeScene?: SceneGraph,
): Promise<DfmReport | null> {
  const ctx = wholeScene && wholeScene !== scene ? wholeScene : undefined;
  const report = await requestInternal(
    scene,
    dfmKey(process, bench, ctx),
    { type: 'DFM', process, bench, ...(ctx ? { wholeScene: ctx } : {}) },
    'imperative',
  );
  return (report as DfmReport | null) ?? null;
}

// ---------------------------------------------------------------------------
// Live-pose scene alignment for DfmHUD, DfmHeatmap, and PrintAnalysisOverlay
// ---------------------------------------------------------------------------
//
// When physics has moved bodies (after Run + Pause, or via VoltLink), the
// viewport renders each body at its live MuJoCo world matrix (`livePoses`).
// Applying those matrices onto a shared memoized SceneGraph copy ensures
// `analyseDfm`, `DfmHeatmap`, `DfmHUD`, and `PrintAnalysisOverlay` all hit
// the exact same WeakMap cache entry AND align triangles + 3D pins pixel-exact
// with where the bodies sit in the viewport.

let cachedLivePose: { source: SceneGraph; sig: string; posed: SceneGraph } | null = null;

function poseSignature(poses: Map<string, THREE.Matrix4>): string {
  const keys = [...poses.keys()].sort();
  let out = '';
  for (let k = 0; k < keys.length; k++) {
    const id = keys[k];
    const e = poses.get(id)!.elements;
    if (k > 0) out += '|';
    out += `${id}:${Math.round(e[0] * 1e5)},${Math.round(e[1] * 1e5)},${Math.round(e[2] * 1e5)},${Math.round(e[3] * 1e5)},${Math.round(e[4] * 1e5)},${Math.round(e[5] * 1e5)},${Math.round(e[6] * 1e5)},${Math.round(e[7] * 1e5)},${Math.round(e[8] * 1e5)},${Math.round(e[9] * 1e5)},${Math.round(e[10] * 1e5)},${Math.round(e[11] * 1e5)},${Math.round(e[12] * 1e5)},${Math.round(e[13] * 1e5)},${Math.round(e[14] * 1e5)},${Math.round(e[15] * 1e5)}`;
  }
  return out;
}

export function applyLivePosesToScene(scene: SceneGraph, poses: Map<string, THREE.Matrix4>): SceneGraph {
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const invParent = new THREE.Matrix4();
  const localMat = new THREE.Matrix4();

  const walk = (nodes: SceneNode[], parentWorld?: THREE.Matrix4): SceneNode[] =>
    nodes.map((node) => {
      const liveWorld = poses.get(node.id);
      if (!liveWorld) {
        const world = getNodeWorldTransform(node, parentWorld);
        const children = node.children?.length ? walk(node.children, world) : node.children;
        return children === node.children ? node : { ...node, children };
      }

      if (parentWorld) {
        invParent.copy(parentWorld).invert();
        localMat.multiplyMatrices(invParent, liveWorld);
      } else {
        localMat.copy(liveWorld);
      }
      localMat.decompose(pos, quat, scale);
      const nextPos: [number, number, number] = [pos.x, pos.y, pos.z];
      const nextQuat: [number, number, number, number] = [quat.w, quat.x, quat.y, quat.z];

      // If this mesh body had its initial rotation baked into vertices, omit
      // the bake marker on the transient DFM clone so `getNodeWorldTransform`
      // honours the live post-simulation `quat` rotation.
      const geoms = isNodeRotationBaked(node) && node.geoms
        ? node.geoms.map((g) => {
            if (!g.baseVertices && !g.baseRenderVertices) return g;
            const copy = { ...g };
            delete copy.baseVertices;
            delete copy.baseRenderVertices;
            return copy;
          })
        : node.geoms;

      const children = node.children?.length ? walk(node.children, liveWorld) : node.children;
      const next: SceneNode = {
        ...node,
        pos: nextPos,
        quat: nextQuat,
        geoms,
        children,
      };
      delete next.euler;
      return next;
    });

  return { ...scene, nodes: walk(scene.nodes || []) };
}

/**
 * Returns `scene` unchanged when `poses` is null/empty, or a shared cached
 * live-posed clone so `DfmHUD`, `DfmHeatmap`, and `PrintAnalysisOverlay`
 * share a single object identity and hit the same worker cache.
 */
export function getLivePosedScene(scene: SceneGraph, poses: Map<string, THREE.Matrix4> | null): SceneGraph {
  if (!poses || poses.size === 0) return scene;
  const sig = poseSignature(poses);
  if (cachedLivePose && cachedLivePose.source === scene && cachedLivePose.sig === sig) {
    return cachedLivePose.posed;
  }
  const posed = applyLivePosesToScene(scene, poses);
  cachedLivePose = { source: scene, sig, posed };
  return posed;
}

// ---------------------------------------------------------------------------
// Lightweight DFM spatial focus & plate-check store (DfmHUD <-> Overlays)
// ---------------------------------------------------------------------------

export interface DfmFocusTarget {
  id: string;
  title: string;
  detail: string;
  fix: string;
  severity: DfmFinding['severity'];
  position: [number, number, number];
  nodeId?: string;
  process?: DfmProcess;
}

export interface DfmFocusState {
  hovered: DfmFocusTarget | null;
  active: DfmFocusTarget | null;
  checkAllAsPlate: boolean;
}

let focusState: DfmFocusState = { hovered: null, active: null, checkAllAsPlate: false };
const focusListeners = new Set<() => void>();

function emitFocus(): void {
  for (const listener of focusListeners) listener();
}

function subscribeFocus(listener: () => void): () => void {
  focusListeners.add(listener);
  return () => focusListeners.delete(listener);
}

function getFocusSnapshot(): DfmFocusState {
  return focusState;
}

export function setHoveredDfmFinding(hovered: DfmFocusTarget | null): void {
  if (focusState.hovered?.id === hovered?.id && focusState.hovered === hovered) return;
  focusState = { ...focusState, hovered };
  emitFocus();
}

export function setActiveDfmFinding(active: DfmFocusTarget | null): void {
  if (focusState.active?.id === active?.id && focusState.active === active) return;
  focusState = { ...focusState, active };
  emitFocus();
}

export function setDfmCheckAllAsPlate(checkAllAsPlate: boolean): void {
  if (focusState.checkAllAsPlate === checkAllAsPlate) return;
  focusState = { ...focusState, checkAllAsPlate };
  emitFocus();
}

export function clearDfmFocus(): void {
  if (!focusState.hovered && !focusState.active) return;
  focusState = { ...focusState, hovered: null, active: null };
  emitFocus();
}

export function useDfmFocus(): DfmFocusState {
  return useSyncExternalStore(subscribeFocus, getFocusSnapshot, getFocusSnapshot);
}
