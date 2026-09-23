// Thin wrapper around the physics Worker (src/workers/physicsWorker.ts).
//
// The worker owns the live MuJoCo module/model/data and the step loop; this
// client just does postMessage plumbing and exposes small async methods that
// mirror what useStore.ts's recompile()/action methods used to do directly
// against a same-thread MjModel/MjData.

import type { SceneGraph } from '../types/scene';
import type {
  BuiltResult,
  ConstraintBrokenEvent,
  FrameSnapshot,
  ImpactEvent,
  HeadlessResult,
  HistoryEntry,
  SeedState,
} from '../workers/physicsWorkerProtocol';

export type { BuiltResult, FrameSnapshot } from '../workers/physicsWorkerProtocol';

type Pending<T> = { resolve: (r: T) => void; reject: (e: Error) => void };

// ---------------------------------------------------------------------------
// Headless run core (pure; imported by src/workers/physicsWorker.ts)
// ---------------------------------------------------------------------------
//
// This lives here rather than in the worker because the worker module cannot be
// imported outside a Worker realm (it assigns `self.onmessage` at module scope
// and pulls in the MuJoCo wasm glue), so none of its logic was reachable from a
// test. Everything below is pure loop control — it never touches MuJoCo, only
// the four callbacks the worker hands it — so `tests/headlessRun.test.ts` can
// drive it against a fake integrator and assert the guarantees the MCP
// `physics_run_headless` reply makes about its frames.

/** Why a headless run stopped before completing every requested tick. */
export type HeadlessTruncationReason = 'diverged' | 'nan' | 'frame-cap';

export interface HeadlessLoopHooks<F> {
  /** Advance the simulation exactly one tick (forces, scripts, mj_step). */
  step(): void;
  /** Simulated time after the most recent step. */
  time(): number;
  /** True when the state has gone non-finite and the frame is worthless. */
  isBad(): boolean;
  /** Build a trajectory frame from the current state. */
  sample(): F;
}

export interface HeadlessLoopOptions {
  ticks: number;
  /** Keep one frame every `stride` ticks (plus the final tick). Default 1. */
  stride?: number;
  /** Hard ceiling on kept frames, so a huge run cannot blow the reply. */
  maxFrames?: number;
}

export interface HeadlessLoopOutcome<F> {
  frames: F[];
  /** Ticks actually integrated — never the requested count when it stopped early. */
  ticksSimulated: number;
  truncated: boolean;
  truncationReason?: HeadlessTruncationReason;
  truncationDetail?: string;
}

/**
 * ~48MB of JSON at a typical per-frame size; past this a reply is useless
 * anyway because it cannot cross the MCP bridge's response window.
 */
export const MAX_HEADLESS_FRAMES = 20000;

/**
 * Runs the fixed-tick loop behind `physics_run_headless`, and stops the moment
 * the integrator stops making forward progress.
 *
 * That last part is the whole point. MuJoCo does not surface a diverging model
 * as an exception or as a NaN you can find in qpos: `mj_step` calls
 * `mj_checkPos`/`mj_checkVel`/`mj_checkAcc`, and when any state exceeds mjMAXVAL
 * those call `mj_resetData` — which puts the model back at qpos0 and sets
 * `data.time` back to 0. The step "succeeds", the state looks clean, and the
 * clock silently restarts. A scene whose control scripts drive it unstable
 * therefore produced a trajectory that ran 0.001 .. 0.6s, reset, ran again, and
 * so on for every requested tick, with times that repeat and go backwards —
 * while the reply cheerfully claimed the full requested tick count.
 *
 * So the contract is: time must strictly increase every tick. The first tick
 * that does not is a divergence, the run stops there, and the reply says so.
 */
export const runHeadlessLoop = <F>(
  opts: HeadlessLoopOptions,
  hooks: HeadlessLoopHooks<F>,
): HeadlessLoopOutcome<F> => {
  const ticks = Math.max(0, Math.floor(opts.ticks) || 0);
  const stride = Math.max(1, Math.floor(opts.stride ?? 1) || 1);
  const maxFrames = Math.max(1, Math.floor(opts.maxFrames ?? MAX_HEADLESS_FRAMES));

  const frames: F[] = [];
  let ticksSimulated = 0;
  let truncated = false;
  let truncationReason: HeadlessTruncationReason | undefined;
  let truncationDetail: string | undefined;
  let lastKeptTick = -1;
  let prevTime = hooks.time();

  for (let i = 0; i < ticks; i++) {
    hooks.step();

    const t = hooks.time();
    if (!Number.isFinite(t) || t <= prevTime) {
      truncated = true;
      truncationReason = 'diverged';
      truncationDetail =
        `The model went unstable at tick ${i + 1}: MuJoCo reset the simulation state ` +
        `(simulated time went from ${prevTime} back to ${t}). Frames after this point ` +
        'would have belonged to a restarted run, so the run stopped here.';
      break;
    }
    if (hooks.isBad()) {
      truncated = true;
      truncationReason = 'nan';
      truncationDetail = `The state became non-finite at tick ${i + 1}; the run stopped there.`;
      break;
    }

    prevTime = t;
    ticksSimulated = i + 1;

    if (i % stride === 0) {
      if (frames.length >= maxFrames) {
        truncated = true;
        truncationReason = 'frame-cap';
        truncationDetail =
          `Kept the maximum of ${maxFrames} frames (reached at tick ${i + 1} of ${ticks}); ` +
          'raise `stride` to cover the whole run.';
        break;
      }
      frames.push(hooks.sample());
      lastKeptTick = i;
    }
  }

  // The final tick always gets a frame on a run that finished cleanly, even
  // when `stride` does not divide it — callers analyse the end state.
  if (!truncated && ticksSimulated > 0 && lastKeptTick !== ticksSimulated - 1 && frames.length < maxFrames) {
    frames.push(hooks.sample());
  }

  return { frames, ticksSimulated, truncated, ...(truncationReason ? { truncationReason, truncationDetail } : {}) };
};

/**
 * The reply the worker sends back for RUN_HEADLESS. `HeadlessResult` (in
 * physicsWorkerProtocol.ts) describes the happy path; these fields say, when a
 * run did not complete, that it did not complete and why — `ticksSimulated` is
 * always the number of ticks actually integrated.
 */
export type HeadlessRunResult = HeadlessResult & {
  truncated?: boolean;
  truncationReason?: HeadlessTruncationReason;
  truncationDetail?: string;
  ticksRequested?: number;
};

export class PhysicsWorkerClient {
  private worker: Worker;
  private pendingBuilds = new Map<string, Pending<BuiltResult>>();
  private pendingHeadless = new Map<string, Pending<HeadlessRunResult>>();
  private pendingHistory = new Map<string, Pending<HistoryEntry[]>>();
  private pendingTelemetry = new Map<string, Pending<HistoryEntry | null>>();
  onFrame: ((snap: FrameSnapshot) => void) | null = null;
  onError: ((message: string, fatal: boolean, lastState?: SeedState) => void) | null = null;
  /** A weld has just sheared off. See utils/breakThresholds.ts. */
  onBreak: ((event: ConstraintBrokenEvent) => void) | null = null;
  /** A body has been hit hard enough to shatter or to dent. */
  onImpact: ((event: ImpactEvent) => void) | null = null;

  constructor() {
    this.worker = new Worker(new URL('../workers/physicsWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (evt: MessageEvent) => {
      const msg = evt.data;
      switch (msg.type) {
        case 'BUILT': {
          const pending = this.pendingBuilds.get(msg.id);
          if (pending) {
            this.pendingBuilds.delete(msg.id);
            pending.resolve(msg);
          }
          break;
        }
        case 'FRAME':
          this.onFrame?.(msg);
          break;
        case 'ERROR':
          this.onError?.(msg.message, !!msg.fatal, msg.lastState);
          break;
        case 'CONSTRAINT_BROKEN':
          this.onBreak?.(msg);
          break;
        case 'IMPACT':
          this.onImpact?.(msg);
          break;
        case 'HEADLESS_RESULT': {
          const pending = this.pendingHeadless.get(msg.id);
          if (pending) {
            this.pendingHeadless.delete(msg.id);
            pending.resolve(msg);
          }
          break;
        }
        case 'HISTORY_RESULT': {
          const pending = this.pendingHistory.get(msg.id);
          if (pending) {
            this.pendingHistory.delete(msg.id);
            pending.resolve(msg.history);
          }
          break;
        }
        case 'TELEMETRY_RESULT': {
          const pending = this.pendingTelemetry.get(msg.id);
          if (pending) {
            this.pendingTelemetry.delete(msg.id);
            pending.resolve(msg.telemetry);
          }
          break;
        }
        default:
          break;
      }
    };
  }

  /**
   * `brokenConstraints` is not optional in spirit, only in type.
   *
   * A build hands the worker a brand new model whose equalities all start
   * active, so anything that has already broken has to be re-broken on the far
   * side. The worker cannot remember on its own: it is terminated and respawned
   * every fourth build and every twenty seconds of play. Every call site that
   * rebuilds during play has to pass this or the scene quietly heals itself.
   */
  build(
    xml: string,
    sceneGraph: SceneGraph,
    preserveState: boolean,
    seedState?: SeedState,
    brokenConstraints?: string[],
  ): Promise<BuiltResult> {
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      this.pendingBuilds.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'BUILD', id, xml, sceneGraph, preserveState, seedState, brokenConstraints });
    });
  }

  setPlaying(isPlaying: boolean) { this.worker.postMessage({ type: 'SET_PLAYING', isPlaying }); }
  // Drives the worker's step loop in lockstep with the main thread's own
  // requestAnimationFrame, so physics stepping stays in phase with rendering
  // instead of drifting against an independent worker-side timer.
  tick(delta: number) { this.worker.postMessage({ type: 'TICK', delta }); }
  setEnv(windX: number, windY: number) { this.worker.postMessage({ type: 'SET_ENV', windX, windY }); }
  setDrag(nodeId: string | null, target: { x: number; y: number; z: number } | null) { this.worker.postMessage({ type: 'SET_DRAG', nodeId, target }); }
  setKeys(keys: string[]) { this.worker.postMessage({ type: 'SET_KEYS', keys }); }
  setQpos(jointName: string, axis: number, value: number) { this.worker.postMessage({ type: 'SET_QPOS', jointName, axis, value }); }
  setCtrl(actuatorName: string, value: number) { this.worker.postMessage({ type: 'SET_CTRL', actuatorName, value }); }
  updateScript(nodeId: string, script: string) { this.worker.postMessage({ type: 'UPDATE_SCRIPT', nodeId, script }); }

  // `stride` decimates inside the worker, before the trajectory is cloned
  // across the thread boundary. It defaults to 1 (every tick) because the MCP
  // bridge does its own striding on the full trajectory; passing it here as
  // well would decimate twice.
  runHeadless(xml: string, sceneGraph: SceneGraph, ticks: number, stride = 1): Promise<HeadlessRunResult> {
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      this.pendingHeadless.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'RUN_HEADLESS', id, xml, sceneGraph, ticks, stride });
    });
  }

  getHistory(): Promise<HistoryEntry[]> {
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      this.pendingHistory.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'GET_HISTORY', id });
    });
  }

  getTelemetry(): Promise<HistoryEntry | null> {
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      this.pendingTelemetry.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'GET_TELEMETRY', id });
    });
  }

  // True while the worker still owes an answer to a build/headless/history/
  // telemetry request. The periodic recycle checks this so it doesn't
  // terminate a worker mid-build and turn a legitimate request into a failure.
  hasPendingWork(): boolean {
    return this.pendingBuilds.size > 0 || this.pendingHeadless.size > 0
        || this.pendingHistory.size > 0 || this.pendingTelemetry.size > 0;
  }

  clearHistory() {
    this.worker.postMessage({ type: 'CLEAR_HISTORY' });
  }

  terminate() {
    this.worker.terminate();
    // A terminated worker will never answer anything it was already asked, so
    // every in-flight request has to be settled here. Left pending they hang
    // forever, and so does whatever is awaiting them - that's how an MCP
    // command whose recompile was still running when the periodic recycle
    // fired ended up never replying, leaving the "MCP Active" badge on screen
    // for the rest of the session. The message deliberately avoids the words
    // recompile() sniffs for when deciding a failure was WASM heap exhaustion.
    const err = new Error('The physics worker was recycled before this request completed.');
    const settle = (map: Map<string, { reject: (e: Error) => void }>) => {
      for (const pending of map.values()) pending.reject(err);
      map.clear();
    };
    settle(this.pendingBuilds);
    settle(this.pendingHeadless);
    settle(this.pendingHistory);
    settle(this.pendingTelemetry);
  }
}
