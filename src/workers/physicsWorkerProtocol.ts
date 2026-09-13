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

export type HeadlessResult =
  | { ok: true; ticksSimulated: number; trajectory: HistoryEntry[]; warnings: string[] }
  | { ok: false; error: string; warnings: string[] };

// ---- Main thread -> worker -----------------------------------------------

export type MainToWorkerMessage =
  | { type: 'BUILD'; id: string; xml: string; sceneGraph: SceneGraph; preserveState: boolean; seedState?: SeedState }
  | { type: 'SET_ENV'; windX?: number; windY?: number }
  | { type: 'SET_PLAYING'; isPlaying: boolean }
  | { type: 'TICK'; delta: number }
  | { type: 'SET_DRAG'; nodeId: string | null; target: DragTarget | null }
  | { type: 'SET_KEYS'; keys: string[] }
  | { type: 'SET_QPOS'; jointName: string; axis: number; value: number }
  | { type: 'SET_CTRL'; actuatorName: string; value: number }
  | { type: 'UPDATE_SCRIPT'; nodeId: string; script: string }
  | { type: 'RUN_HEADLESS'; id: string; xml: string; sceneGraph: SceneGraph; ticks: number }
  | { type: 'GET_HISTORY'; id: string }
  | { type: 'GET_TELEMETRY'; id: string }
  | { type: 'CLEAR_HISTORY' };

// ---- Worker -> main thread -----------------------------------------------

export type WorkerToMainMessage =
  | ({ type: 'BUILT'; id: string } & BuiltResult)
  | ({ type: 'FRAME' } & FrameSnapshot)
  | { type: 'ERROR'; message: string; fatal: boolean; lastState?: SeedState }
  | ({ type: 'HEADLESS_RESULT'; id: string } & HeadlessResult)
  | { type: 'HISTORY_RESULT'; id: string; history: HistoryEntry[] }
  | { type: 'TELEMETRY_RESULT'; id: string; telemetry: HistoryEntry | null };
