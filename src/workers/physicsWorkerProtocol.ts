// Message protocol shared by the physics worker (src/workers/physicsWorker.ts)
// and its main-thread client (src/store/physicsWorkerClient.ts). Both sides
// import from here so a message can't be posted in one shape and read in
// another.

import type { SceneGraph } from '../types/scene';

/** Explicit state to seed a freshly built model with (a live mirror's copy). */
export interface SeedState {
  qpos: number[];
  qvel: number[];
  ctrl?: number[];
  time: number;
}

export interface DragTarget {
  x: number;
  y: number;
  z: number;
}

/** Name -> id lookups rebuilt on every successful build, plus their inverses. */
export interface IdMaps {
  body: Record<string, number>;
  joint: Record<string, number>;
  geom: Record<string, number>;
  actuator: Record<string, number>;
  bodyRev?: Record<number, string>;
  jointRev?: Record<number, string>;
  geomRev?: Record<number, string>;
  actuatorRev?: Record<number, string>;
}

/**
 * The per-frame MjData mirror. When SharedArrayBuffer is available these are
 * views over shared memory that the worker keeps current in place; otherwise
 * they are fresh copies transferred with each FRAME.
 */
export interface SimBuffers {
  qpos: Float64Array;
  qvel: Float64Array;
  ctrl: Float64Array;
  xfrc_applied: Float64Array;
  qfrc_applied: Float64Array;
  xpos: Float64Array;
  xmat: Float64Array;
  cvel: Float64Array;
  geom_xpos: Float64Array;
  geom_xmat: Float64Array;
}

export interface FrameSnapshot extends Partial<SimBuffers> {
  time: number;
  isShared?: boolean;
  /**
   * WASM linear memory reserved right now.
   *
   * Reported on every frame, not just on a build, because the heap also grows
   * while simply stepping — MuJoCo's contact/constraint arena sizes itself to
   * whatever the scene is doing — and the proactive recycle needs a current
   * figure to decide on during a long run, when no build is happening at all.
   */
  heapBytes?: number;
}

export interface BuiltResult extends Partial<SimBuffers> {
  ok: boolean;
  error?: string;
  fatal?: boolean;
  nq?: number; nv?: number; nu?: number; ngeom?: number; nbody?: number;
  timestep?: number;
  geom_size?: number[]; body_mass?: number[]; body_inertia?: number[];
  body_dofnum?: number[]; body_parentid?: number[];
  geom_type?: number[]; geom_rgba?: number[];
  jnt_qposadr?: number[]; jnt_dofadr?: number[];
  idMaps?: IdMaps;
  time?: number;
  isShared?: boolean;
  /** As on FrameSnapshot — a build spreads one in, so it carries the figure too. */
  heapBytes?: number;
}

// ---- History / telemetry -------------------------------------------------

export interface AeroDiagnostic {
  relSpeed: number;
  alpha: number;
  CL: number;
  CD: number;
  force: number[];
  torque: number[];
}

export interface BodyHistory {
  pos: number[];
  vel: number[];
  angvel: number[];
  xfrc_applied: number[];
}

export interface JointHistory {
  pos: number;
  vel: number;
  qfrc_applied: number;
}

export interface ContactHistory {
  geom1: string;
  geom2: string;
  dist: number;
}

export interface HistoryEntry {
  time: number;
  bodies: Record<string, BodyHistory>;
  joints: Record<string, JointHistory>;
  contacts: ContactHistory[];
  aeroDiagnostics: Record<string, AeroDiagnostic>;
}

/** A history entry trimmed by a HistoryQuery's `include`: only `time` is certain. */
export type HistoryFrame = Pick<HistoryEntry, 'time'> & Partial<Omit<HistoryEntry, 'time'>>;

/** Which part of the history GET_HISTORY returns. See HistoryRing.query. */
export interface HistoryQuery {
  sinceTime?: number;
  last?: number;
  stride?: number;
  maxFrames?: number;
  bodies?: string[];
  include?: ('bodies' | 'joints' | 'contacts' | 'aero')[];
}

export type HeadlessResult =
  | { ok: true; ticksSimulated: number; trajectory: HistoryEntry[]; warnings: string[] }
  | { ok: false; error: string; warnings: string[] };

// ---- Main thread -> worker -----------------------------------------------

export type MainToWorkerMessage =
  | {
      type: 'BUILD'; id: string; xml: string; sceneGraph: SceneGraph; preserveState: boolean; seedState?: SeedState; brokenConstraints?: string[];
      /**
       * Mesh files to put in the worker's VFS before compiling, and names it
       * may delete. The client tracks what the worker holds, so each file
       * crosses once per worker. See utils/meshVfs.ts.
       */
      meshFiles?: { name: string; bytes: Uint8Array }[];
      dropMeshes?: string[];
      /**
       * Do not step the new model until RESUME: the main thread is still
       * drawing the old one, and anything simulated before it swaps is
       * simulated off screen and shows up as a jump. See `holdUntil`.
       */
      holdForInstall?: boolean;
    }
  | { type: 'SET_ENV'; windX?: number; windY?: number }
  | { type: 'SET_PLAYING'; isPlaying: boolean }
  | { type: 'TICK'; delta: number; /** Date.now() when posted, so a backlog can be told apart. */ sentAt?: number }
  | { type: 'RESUME' }
  | { type: 'SET_DRAG'; nodeId: string | null; target: DragTarget | null }
  | { type: 'SET_KEYS'; keys: string[] }
  | { type: 'SET_QPOS'; jointName: string; axis: number; value: number }
  | { type: 'SET_CTRL'; actuatorName: string; value: number }
  | { type: 'UPDATE_SCRIPT'; nodeId: string; script: string }
  | { type: 'RUN_HEADLESS'; id: string; xml: string; sceneGraph: SceneGraph; ticks: number }
  | { type: 'GET_HISTORY'; id: string; query?: HistoryQuery }
  | { type: 'GET_TELEMETRY'; id: string }
  | { type: 'CLEAR_HISTORY' };

/**
 * A constraint that has just given way, on its way up to the main thread.
 *
 * The worker breaks the weld itself, the instant it happens, by clearing the
 * equality's `eq_active` row — waiting for a round trip would let the scene step
 * on with a weld the model has already decided is gone. This message is the
 * worker telling the main thread what it did, so the break survives the next
 * rebuild: a worker recycle spawns a process with no memory of it, so the main
 * thread has to be the one that remembers. See `brokenConstraints` on BUILD.
 */
export interface ConstraintBrokenEvent {
  /** Stable across rebuilds — see weldKey()/crumpleKey() in utils/breakThresholds.ts. */
  key: string;
  nodeId: string;
  /** The welded-to body for a weld; the joint's own name for a crumple. */
  targetId: string;
  /** 'crumple' is a joint that has folded and stayed folded, not a part coming off. */
  kind: 'weld' | 'crumple';
  /** Simulated seconds when it let go, for the "broken at 1.34 s" readout. */
  time: number;
  /** What it was carrying when it went, in N and N*m. */
  forceN: number;
  torqueNm: number;
}

/**
 * A body has been hit hard enough that something should happen to it.
 *
 * One message for two features: above the body's shatter threshold it comes
 * apart, above a geom's dent threshold the surface takes a dent. The worker
 * reports the blow and lets the main thread decide which, because only the main
 * thread owns the geometry.
 *
 * `pos`/`xmat`/`vel`/`angvel` are the body's state at the instant of the hit,
 * not at the next frame. A shard's position and spin are derived from them, and
 * a frame's worth of drift is the difference between a vase bursting where it
 * was struck and a vase bursting a few centimetres away.
 */
export interface ImpactEvent {
  nodeId: string;
  /**
   * The body on the other end of the collision, if there was one.
   *
   * A blow is between two things, and which of them is the useful witness
   * depends on what is being asked. The striker feels the whole of it; a plate
   * lying on the ground does not, because the ground reaction rises to meet the
   * load and its net constraint force hardly moves. So the impulse is measured
   * on whichever body reported it and attributed to both.
   */
  otherNodeId?: string;
  /** Where the blow landed on that other body, in ITS frame. */
  otherLocalPoint?: number[];
  otherLocalNormal?: number[];
  time: number;
  /** Momentum absorbed over the detection window, in N*s. */
  impulseNs: number;
  /** Where it was hit, in the body's own frame. */
  localPoint: number[];
  /** Inward surface normal at that point, in the body's own frame. */
  localNormal: number[];
  pos: number[];
  /** Row-major 3x3, straight from `data.xmat`. */
  xmat: number[];
  vel: number[];
  angvel: number[];
}

// ---- Worker -> main thread -----------------------------------------------

export type WorkerToMainMessage =
  | ({ type: 'BUILT'; id: string } & BuiltResult)
  | ({ type: 'FRAME' } & FrameSnapshot)
  | { type: 'ERROR'; message: string; fatal: boolean; lastState?: SeedState }
  | ({ type: 'CONSTRAINT_BROKEN' } & ConstraintBrokenEvent)
  | ({ type: 'IMPACT' } & ImpactEvent)
  | ({ type: 'HEADLESS_RESULT'; id: string } & HeadlessResult)
  | { type: 'HISTORY_RESULT'; id: string; history: HistoryFrame[]; total: number; stride: number }
  | { type: 'TELEMETRY_RESULT'; id: string; telemetry: HistoryEntry | null };
