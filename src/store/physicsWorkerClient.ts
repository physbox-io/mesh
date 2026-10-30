// Thin wrapper around the physics Worker (src/workers/physicsWorker.ts).
//
// The worker owns the live MuJoCo module/model/data and the step loop; this
// client just does postMessage plumbing and exposes small async methods that
// mirror what useStore.ts's recompile()/action methods used to do directly
// against a same-thread MjModel/MjData.

import type { SceneGeom, SceneGraph, SceneNode } from '../types/scene';
import { MeshFileLedger } from '../utils/meshVfs';
import type {
  BuiltResult,
  ConstraintBrokenEvent,
  FrameSnapshot,
  ImpactEvent,
  HeadlessRebuild,
  HeadlessResult,
  HistoryFrame,
  MainToWorkerMessage,
  HistoryQuery,
  SeedState,
  StepForResult,
  TelemetryReply,
} from '../workers/physicsWorkerProtocol';
import { noteScriptStatus } from './scriptStatus';
import { noteWorkerFrame } from './modelProvenance';
import type { CoSimChannel } from '../utils/coSimLink';
import { noteWorkerStopped } from '../utils/staleBuild';
import { wipedInitialVelocityNote } from '../utils/mujocoAutoReset';

export type { BuiltResult, FrameSnapshot } from '../workers/physicsWorkerProtocol';

type Pending<T> = { resolve: (r: T) => void; reject: (e: Error) => void };

/**
 * What a headless run does about a blow: the scene to go on with, compiled
 * against this client's `meshFiles`, or null when nothing broke. See
 * `runHeadless`'s `judge`.
 */
export type HeadlessImpactJudge = (event: ImpactEvent) => Promise<{ xml: string; sceneGraph: SceneGraph } | null>;

/** What GET_HISTORY returned, and how much of the history it was cut from. */
export type HistoryResult = { frames: HistoryFrame[]; total: number; stride: number };

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
  /**
   * Called after every good tick, kept or not: what is judged over the whole
   * run (`final`) must not depend on the stride the frames are kept at.
   */
  observe?(): void;
  /**
   * True when something happened this tick that the caller must deal with
   * before the next one: a blow that may shatter a body. `headlessLoop` then
   * yields, and the caller resumes it once the model is rebuilt.
   */
  interrupted?(): boolean;
  /**
   * MuJoCo's auto-reset counter (`autoResetCount` in utils/mujocoAutoReset).
   * A change across a step means the state was reset during it. Without it
   * a reset on the very first step is invisible: it also ends at one
   * timestep, exactly like a good step from t = 0.
   */
  resets?(): number;
}

export interface HeadlessLoopOptions {
  ticks: number;
  /** Keep one frame every `stride` ticks (plus the final tick). Default 1. */
  stride?: number;
  /** Hard ceiling on kept frames, so a huge run cannot blow the reply. */
  maxFrames?: number;
  /**
   * Joints the scene gave an initial velocity, named in the reason when the
   * run blows up on its first tick - the reset that ends it zeroes them.
   */
  initialVelocityJoints?: readonly string[];
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
  const loop = headlessLoop(opts, hooks);
  let r = loop.next();
  while (!r.done) r = loop.next();
  return r.value;
};

/**
 * The same loop, as a generator that yields after any tick `interrupted`
 * flags, with that tick's frame already kept. The caller rebuilds the model
 * (with simulated time carried over, so it still strictly increases) and
 * resumes; the frames, the stride and the tick count run on across it.
 */
export function* headlessLoop<F>(
  opts: HeadlessLoopOptions,
  hooks: HeadlessLoopHooks<F>,
): Generator<void, HeadlessLoopOutcome<F>, void> {
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
  let prevResets = hooks.resets?.();

  for (let i = 0; i < ticks; i++) {
    hooks.step();

    const t = hooks.time();
    const resets = hooks.resets?.();
    const resetSeen = resets !== undefined && resets !== prevResets;
    prevResets = resets;
    if (!Number.isFinite(t) || t <= prevTime || resetSeen) {
      truncated = true;
      truncationReason = 'diverged';
      truncationDetail = i === 0
        ? 'The model went unstable on its very first tick: MuJoCo found a huge or non-finite ' +
          'position, velocity or acceleration and reset the simulation to its starting pose at rest. ' +
          'Nothing was simulated from the state the scene sets up, so the run stopped there.' +
          wipedInitialVelocityNote(opts.initialVelocityJoints ?? []) +
          ' Look for an initial velocity, force or script value that is far too large, or bodies ' +
          'that start deeply overlapping.'
        : `The model went unstable at tick ${i + 1}: MuJoCo reset the simulation state ` +
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
    hooks.observe?.();

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
    if (hooks.interrupted?.()) yield;
  }

  // The final tick always gets a frame on a run that finished cleanly, even
  // when `stride` does not divide it — callers analyse the end state.
  if (!truncated && ticksSimulated > 0 && lastKeptTick !== ticksSimulated - 1 && frames.length < maxFrames) {
    frames.push(hooks.sample());
  }

  return { frames, ticksSimulated, truncated, ...(truncationReason ? { truncationReason, truncationDetail } : {}) };
}

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

/*
 * The scene graph as the worker needs it: names, joints, scripts, break and
 * dent settings — never the shapes, which it already has in the XML. Every
 * BUILD posted the whole graph, and structured-cloning a scene's worth of
 * plain number[] vertex arrays cost time on both threads for data the worker
 * never reads.
 */
const MESH_FIELDS = ['vertices', 'renderVertices', 'faces', 'baseVertices', 'baseRenderVertices', 'colliderVertices', 'baseColliderVertices', 'colliderFaces', 'paint'] as const;
const stripGeom = (g: SceneGeom): SceneGeom => {
  if (!MESH_FIELDS.some((k) => g[k] !== undefined)) return g;
  const copy = { ...g };
  for (const k of MESH_FIELDS) delete copy[k];
  return copy;
};
const stripNodes = (nodes: SceneNode[]): SceneNode[] => (nodes || []).map((n) => {
  const { latticeCage: _cage, ...rest } = n;
  void _cage;
  return {
    ...rest,
    ...(n.geoms ? { geoms: n.geoms.map(stripGeom) } : {}),
    ...(n.children ? { children: stripNodes(n.children) } : {}),
  };
});
export const withoutMeshData = (sceneGraph: SceneGraph): SceneGraph =>
  sceneGraph ? { ...sceneGraph, nodes: stripNodes(sceneGraph.nodes) } : sceneGraph;

/**
 * How long the worker may owe an answer without sending anything at all
 * before it is taken for dead. Longer than any legitimate build or headless
 * run (the MCP bridge itself gives up on those after 60 s), because a false
 * alarm costs a respawn and a rebuild.
 */
export const WORKER_SILENCE_MS = 120_000;

export class PhysicsWorkerClient {
  private worker: Worker;
  /** When the worker last said anything, or was handed work while idle. */
  private lastHeardAt = Date.now();
  private watchdog: ReturnType<typeof setInterval>;
  private pendingBuilds = new Map<string, Pending<BuiltResult>>();
  private pendingHeadless = new Map<string, Pending<HeadlessRunResult>>();
  private headlessJudges = new Map<string, HeadlessImpactJudge>();
  private pendingHistory = new Map<string, Pending<HistoryResult>>();
  private pendingTelemetry = new Map<string, Pending<TelemetryReply | null>>();
  private pendingSteps = new Map<string, Pending<StepForResult>>();
  private pendingChannels = new Map<string, Pending<{ channels: CoSimChannel[]; timestepMs: number }>>();
  /**
   * Which meshes this worker already holds as VFS files. Pass it to
   * `compileToMJCF` and then `build` the result on THIS client: a recycled
   * worker has an empty VFS, and XML naming files it never received will not
   * compile.
   */
  readonly meshFiles = new MeshFileLedger();
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
      this.lastHeardAt = Date.now();
      switch (msg.type) {
        case 'BUILT': {
          // A build's reply carries the new model's state: from here on the
          // sim time is the new model's, not the last frame of the old one.
          if (msg.ok && typeof msg.time === 'number') noteWorkerFrame(msg.time);
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
        case 'SCRIPT_STATUS': {
          const { type: _t, ...status } = msg;
          noteScriptStatus(status);
          break;
        }
        case 'ERROR':
          // A fatal error means the engine is gone (a native abort, the heap
          // exhausted): whatever was still asked will never be answered.
          if (msg.fatal) this.rejectAll(new Error(msg.message));
          this.onError?.(msg.message, !!msg.fatal, msg.lastState);
          break;
        case 'CONSTRAINT_BROKEN':
          this.onBreak?.(msg);
          break;
        case 'IMPACT':
          this.onImpact?.(msg);
          break;
        case 'HEADLESS_RESULT': {
          this.headlessJudges.delete(msg.id);
          const pending = this.pendingHeadless.get(msg.id);
          if (pending) {
            this.pendingHeadless.delete(msg.id);
            pending.resolve(msg);
          }
          break;
        }
        case 'HEADLESS_IMPACT':
          void this.answerImpact(msg.id, msg.event);
          break;
        case 'HISTORY_RESULT': {
          const pending = this.pendingHistory.get(msg.id);
          if (pending) {
            this.pendingHistory.delete(msg.id);
            pending.resolve({ frames: msg.history, total: msg.total, stride: msg.stride });
          }
          break;
        }
        case 'STEPPED': {
          const pending = this.pendingSteps.get(msg.id);
          if (pending) {
            this.pendingSteps.delete(msg.id);
            const { type: _t, id: _i, ...result } = msg;
            pending.resolve(result);
          }
          break;
        }
        case 'CHANNELS': {
          const pending = this.pendingChannels.get(msg.id);
          if (pending) {
            this.pendingChannels.delete(msg.id);
            pending.resolve({ channels: msg.channels, timestepMs: msg.timestepMs });
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
    // A worker whose script or wasm never loads - a tab left open across a
    // deploy fetches old hashed chunks, and nginx answers those with
    // index.html - reports only here. Without it every build waited forever
    // and the page sat on "Initializing Mesh..." with no error.
    const fail = (message: string) => {
      this.rejectAll(new Error(message));
      this.onError?.(message, false);
    };
    this.worker.onerror = (evt: ErrorEvent) => {
      noteWorkerStopped();
      evt.preventDefault();
      fail(`The physics engine failed to load${evt.message ? `: ${evt.message}` : ''}. Reload the page to try again.`);
    };
    this.worker.onmessageerror = () => fail('The physics worker sent a message that could not be read.');
    // A worker blocked for good (a native abort leaves later calls hanging)
    // never answers and never errors, and hasPendingWork() then holds off the
    // periodic recycle that would have replaced it: the tab's physics stayed
    // dead until a reload. Owed work and long silence mean it is gone.
    this.watchdog = setInterval(() => {
      if (!this.hasPendingWork() || Date.now() - this.lastHeardAt < WORKER_SILENCE_MS) return;
      clearInterval(this.watchdog);
      const message = `The physics worker stopped answering for ${Math.round(WORKER_SILENCE_MS / 1000)} s.`;
      this.rejectAll(new Error(message));
      this.onError?.(message, true);
    }, 5_000);
  }

  /** Start the silence clock on work handed to an idle worker. */
  private noteRequest() {
    if (!this.hasPendingWork()) this.lastHeardAt = Date.now();
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
    holdForInstall?: boolean,
  ): Promise<BuiltResult> {
    const id = Math.random().toString(36).slice(2);
    // Whatever the last compile against this client's ledger emitted as a
    // file. An XML compiled without the ledger names no files, and `take` then
    // hands back nothing to send.
    const { add, drop } = this.meshFiles.take();
    return new Promise((resolve, reject) => {
      this.noteRequest();
      this.pendingBuilds.set(id, { resolve, reject });
      this.worker.postMessage(
        { type: 'BUILD', id, xml, sceneGraph: withoutMeshData(sceneGraph), preserveState, seedState, brokenConstraints, meshFiles: add, dropMeshes: drop, holdForInstall },
        add.map((f) => f.bytes.buffer as ArrayBuffer),
      );
    });
  }

  setPlaying(isPlaying: boolean) { this.worker.postMessage({ type: 'SET_PLAYING', isPlaying }); }
  // Drives the worker's step loop in lockstep with the main thread's own
  // requestAnimationFrame, so physics stepping stays in phase with rendering
  // instead of drifting against an independent worker-side timer.
  tick(delta: number) { this.worker.postMessage({ type: 'TICK', delta, sentAt: Date.now() }); }
  /** The model a `holdForInstall` build made is on screen; the worker may step it. */
  resume() { this.worker.postMessage({ type: 'RESUME' }); }
  setEnv(windX: number, windY: number, density?: number) { this.worker.postMessage({ type: 'SET_ENV', windX, windY, density }); }
  setDrag(nodeId: string | null, target: { x: number; y: number; z: number } | null) { this.worker.postMessage({ type: 'SET_DRAG', nodeId, target }); }
  setKeys(keys: string[]) { this.worker.postMessage({ type: 'SET_KEYS', keys }); }
  setQpos(jointName: string, axis: number, value: number | readonly number[]) { this.worker.postMessage({ type: 'SET_QPOS', jointName, axis, value }); }
  setCtrl(actuatorName: string, value: number) { this.worker.postMessage({ type: 'SET_CTRL', actuatorName, value }); }
  updateScript(nodeId: string, script: string) { this.worker.postMessage({ type: 'UPDATE_SCRIPT', nodeId, script }); }

  // `stride` decimates inside the worker, before the trajectory is cloned
  // across the thread boundary. It defaults to 1 (every tick) because the MCP
  // bridge does its own striding on the full trajectory; passing it here as
  // well would decimate twice.
  //
  // With a `judge`, the run stops at every blow and asks it what happened, as
  // the live run asks the store: a body that shatters is rebuilt as its pieces
  // at that tick and the run goes on. Without one it never shatters.
  //
  // `frames.contacts: false` leaves the contact list out of every kept frame:
  // on a scene with a few bodies it is most of each frame.
  runHeadless(
    xml: string, sceneGraph: SceneGraph, ticks: number, stride = 1, judge?: HeadlessImpactJudge,
    frames: { contacts?: boolean } = {},
  ): Promise<HeadlessRunResult> {
    const id = Math.random().toString(36).slice(2);
    if (judge) this.headlessJudges.set(id, judge);
    // The same ledger as `build`: an XML compiled against it can name a mesh
    // file the last live build only sent as text (a SCAD body just updated),
    // and without these the worker fails with "Error opening file m_….msh".
    const { add, drop } = this.meshFiles.take();
    return new Promise((resolve, reject) => {
      this.noteRequest();
      this.pendingHeadless.set(id, { resolve, reject });
      this.worker.postMessage(
        { type: 'RUN_HEADLESS', id, xml, sceneGraph: withoutMeshData(sceneGraph), ticks, stride, contacts: frames.contacts !== false, meshFiles: add, dropMeshes: drop, judgeImpacts: !!judge },
        add.map((f) => f.bytes.buffer as ArrayBuffer),
      );
    });
  }

  /** Answer a paused headless run. Always answers: the run waits for it. */
  private async answerImpact(id: string, event: ImpactEvent) {
    let rebuild: HeadlessRebuild | undefined;
    try {
      const next = await this.headlessJudges.get(id)?.(event);
      if (next) {
        // Taken after the judge compiled: the files its XML names.
        const { add, drop } = this.meshFiles.take();
        rebuild = { xml: next.xml, sceneGraph: withoutMeshData(next.sceneGraph), meshFiles: add, dropMeshes: drop };
      }
    } catch (err) {
      console.warn('[headless impact]', err);
    }
    this.worker.postMessage(
      { type: 'HEADLESS_IMPACT_REPLY', id, rebuild } satisfies MainToWorkerMessage,
      rebuild?.meshFiles?.map((f) => f.bytes.buffer as ArrayBuffer) ?? [],
    );
  }

  /** No query returns everything held; see HistoryRing.query for the filters. */
  getHistory(query?: HistoryQuery): Promise<HistoryResult> {
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      this.noteRequest();
      this.pendingHistory.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'GET_HISTORY', id, query });
    });
  }

  getTelemetry(): Promise<TelemetryReply | null> {
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      this.noteRequest();
      this.pendingTelemetry.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'GET_TELEMETRY', id });
    });
  }

  /** A linked Volt's slice: hold `inputs` for `dtMs`, then read `outputs`. */
  stepFor(dtMs: number, inputs: Record<string, number>, outputs: string[]): Promise<StepForResult> {
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      this.noteRequest();
      this.pendingSteps.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'STEP_FOR', id, dtMs, inputs, outputs });
    });
  }

  /** Every channel a linked Volt can bind in the built model. */
  getChannels(): Promise<{ channels: CoSimChannel[]; timestepMs: number }> {
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      this.noteRequest();
      this.pendingChannels.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'GET_CHANNELS', id });
    });
  }

  // True while the worker still owes an answer to a build/headless/history/
  // telemetry request. The periodic recycle checks this so it doesn't
  // terminate a worker mid-build and turn a legitimate request into a failure.
  hasPendingWork(): boolean {
    return this.pendingBuilds.size > 0 || this.pendingHeadless.size > 0
        || this.pendingHistory.size > 0 || this.pendingTelemetry.size > 0
        || this.pendingSteps.size > 0 || this.pendingChannels.size > 0;
  }

  clearHistory() {
    this.worker.postMessage({ type: 'CLEAR_HISTORY' });
  }

  terminate() {
    clearInterval(this.watchdog);
    this.worker.terminate();
    // A terminated worker will never answer anything it was already asked, so
    // every in-flight request has to be settled here. Left pending they hang
    // forever, and so does whatever is awaiting them - that's how an MCP
    // command whose recompile was still running when the periodic recycle
    // fired ended up never replying, leaving the "MCP Active" badge on screen
    // for the rest of the session. The message deliberately avoids the words
    // recompile() sniffs for when deciding a failure was WASM heap exhaustion.
    this.rejectAll(new Error('The physics worker was recycled before this request completed.'));
  }

  private rejectAll(err: Error) {
    this.headlessJudges.clear();
    const settle = (map: Map<string, { reject: (e: Error) => void }>) => {
      for (const pending of map.values()) pending.reject(err);
      map.clear();
    };
    settle(this.pendingBuilds);
    settle(this.pendingHeadless);
    settle(this.pendingHistory);
    settle(this.pendingTelemetry);
    settle(this.pendingSteps);
    settle(this.pendingChannels);
  }
}
