/// <reference lib="webworker" />

// Dedicated worker owning the live MuJoCo WASM module, MjModel, and MjData.
//
// Why this exists: MuJoCo's WASM linear memory only ever grows within a JS
// realm (freeing a model/data releases C++-side heap for reuse, but the
// underlying WebAssembly.Memory never shrinks), and the @mujoco/mujoco
// package's build has a hard-coded 2^31-byte ceiling. Recompiling in place
// on the main thread eventually exhausts that ceiling with no way back short
// of a full page reload. Because this worker is a separate realm, the main
// thread can `terminate()` it and spawn a fresh one to get a real memory
// reclaim, with zero page navigation and no loss of camera/UI state.
//
// The worker owns the entire fixed-timestep step loop (previously
// PhysicsLoop's useFrame body in App.tsx): force reset, mouse-drag spring
// force, script execution (aero + user scripts), free-joint damping,
// mj_step, NaN safety check, and throttled history recording. Without shared
// memory, stepping is driven by TICK messages from the main thread's own
// requestAnimationFrame loop (see stepTick below). With it — the usual case,
// since the dev server and nginx both send COOP/COEP — the worker paces itself
// at display rate (startWorkerLoop): one tick and one frame per 16 ms.

import type load_mujoco from '@mujoco/mujoco';
// The same asset the Emscripten glue would fetch by import.meta.url, as a URL.
// Wanted explicitly so loadMujoco() below can instantiate the module itself and
// keep hold of its WebAssembly.Memory — this build exports neither HEAPU8 nor
// wasmMemory (both abort with "was not exported"), so capturing the instance at
// creation is the only way to read how big the heap has grown. Vite emits the
// file once; the package's exports map does list ./mujoco.wasm, so a bare
// specifier resolves (unlike openscad's - see the note in scadWorker.ts).
import mujocoWasmUrl from '@mujoco/mujoco/mujoco.wasm?url';
// The multithreaded build, used when the page is cross-origin isolated (the
// dev server and nginx both send COOP/COEP); see loadMujoco below.
import mujocoMtWasmUrl from '@mujoco/mujoco/mt/mujoco.wasm?url';
import {
  applyCtrlInputs, applyJointForces, channelCatalogue, readOutputs, resolveInputs, setJointParams, stepsFor, substepsFor,
  type ResolvedInput,
} from '../utils/coSimLink';
import type { AcousticBowSpec, FlexureSpec, SceneGraph, SceneJoint, SceneNode } from '../types/scene';
import {
  buildHydroBodyModel,
  collectWaterBasins,
  computeBuoyancyWrench,
  pointInsideWaterBasin,
  type HydroBodyModel,
  type WaterBasinWorld,
} from '../utils/hydrostatics';
import { bistableForce } from '../utils/flexure';
import { collectMagnetBodies, applyMagnetForces, type MagnetBody } from '../utils/magnetForces';
// Pure loop control for the headless run, kept in a module that can be
// imported outside a Worker realm so it is testable (this file cannot be:
// it assigns self.onmessage at module scope). See tests/headlessRun.test.ts.
import { headlessLoop, type HeadlessRunResult } from '../store/physicsWorkerClient';
import { createSolverWorkMonitor, solverEnergyWarning, type SolverEnergyGain } from '../utils/solverWorkMonitor';
import { autoResetCount, wipedInitialVelocityNote } from '../utils/mujocoAutoReset';
import type {
  AeroDiagnostic,
  AeroSnapEvent,
  AeroVoiceTelemetry,
  AudioDampingEvent,
  BodyHistory,
  BowedStringContactEvent,
  ClothStateSnapshot,
  ConstraintBrokenEvent,
  ContactHistory,
  ContinuousContactEvent,
  AudioImpactEvent,
  HeadlessRebuild,
  HistoryEntry,
  ImpactEvent,
  JointHistory,
  SeedState,
  WorkerToMainMessage,
} from './physicsWorkerProtocol';
import { evaluateGustWind } from '../utils/aeroAcoustics';
import {
  computeContactDampingRate,
  computeImpactSolSoftScale,
  inferStringLocalSpan,
  inferSurfaceRoughness,
  resolveGuardedBowHold,
  selectMultiFingerStopFraction,
  shouldEmitPairImpact,
} from '../utils/contactFrictionAcoustics';
import { isCriticallyDampedDamperPress } from '../utils/voiceSympathyPool';
import { HistoryRing } from './historyRing';
import { buildImpactWatches, checkImpacts as detectImpacts, type ImpactWatches } from './impactWatch';
import { JOINT_NV, applyEditedCtrl, captureState, copyCarriedActuators as copyCarriedActuatorsByName, copyJointsByName, documentCtrlValues, seedNewBodies, writeInitialVelocity, type CarriedState } from './carryState';
import { ScriptStateStore, attachScriptState, scriptStateForBuild } from '../utils/scriptState';
import { BREAK_ARM_S, axialPush, barBending, toBodyFrame, weldTorque, canCrumple, crumpleAsWeld, crumpleKey, holdSteps, isBreakable, weldKey, weldOverload, type WeldBreakConfig } from '../utils/breakThresholds';
import { BREAK_FIELDS, parseBreakKey } from '../utils/breakKeys';
import { createConstraintMonitor, mergeConstraintReports, type ConstraintReport } from '../utils/constraintResiduals';
import { TrajectoryAccumulator } from '../utils/trajectorySummary';
import { jointTypes } from '../utils/headlessReport';
import { ScriptLogRing, ScriptProblemLog, ScriptTiming, headlessCostWarning } from './scriptDiagnostics';
import { bodyAngularVelocity, bodyPointVelocity, syncKinematics, worldToBodyFrame, type VelocityViews } from './bodyKinematics';
import { actuatorsByJoint, clutchDrive, contactsOfBody, jointViews, raycast, readJoint, type JointInfo, type SensorNames } from './scriptSensors';
import { buildClothWorld, seedClothModels, type ClothWorld } from '../utils/cloth/clothWorld';
import { contactBody } from '../utils/contactBodies';

type Mujoco = Awaited<ReturnType<typeof load_mujoco>>;
type MjModel = InstanceType<Mujoco['MjModel']>;
type MjVFS = InstanceType<Mujoco['MjVFS']>;
type MjData = InstanceType<Mujoco['MjData']>;
let mujoco: Mujoco | null = null;
/**
 * The module's linear memory, captured at instantiation.
 *
 * MuJoCo's WASM heap only ever grows and has a hard 2^31-byte ceiling, and both
 * proactive recycles exist to stay clear of it. Reading the real figure lets that
 * decision be made on the heap itself rather than on a build count or a timer.
 */
let wasmMemory: WebAssembly.Memory | null = null;

/** Bytes of WASM linear memory currently reserved, or 0 before the module loads. */
const heapBytes = (): number => wasmMemory?.buffer.byteLength ?? 0;

/**
 * Loads the MuJoCo module once, instantiating the wasm ourselves so the
 * WebAssembly.Memory can be kept (see wasmMemory above).
 *
 * The load is shared: two BUILDs arriving while the wasm downloads used to load
 * two separate modules, and the second build then handed module 2 a VFS made by
 * module 1 ("Expected null or instance of MjVFS"), failing every mesh build for
 * the life of the worker. A failed instantiate rejects - Emscripten never calls
 * `done` for it, which left the load, and the build awaiting it, pending forever.
 */
let mujocoLoading: Promise<Mujoco> | null = null;
/**
 * The multithreaded build, when SharedArrayBuffer is available: the model
 * compiler processes meshes on several threads and stepping runs on a
 * two-thread pool (mju_threadpool).
 */
const threaded = self.crossOriginIsolated;
/**
 * Emscripten starts this many workers at load, and the compiler starts at most
 * this many threads: both read navigator.hardwareConcurrency. Left at one per
 * core it starts 12+ idle workers; and in a browser a thread wanted beyond
 * those started can deadlock, so the two must agree.
 */
const MAX_THREADS = 4;
const STEP_THREADS = 2;
const loadMujoco = (): Promise<Mujoco> => {
  if (mujoco) return Promise.resolve(mujoco);
  mujocoLoading ??= (async () => {
    if (threaded) {
      Object.defineProperty(self.navigator, 'hardwareConcurrency', {
        value: Math.min(MAX_THREADS, navigator.hardwareConcurrency || MAX_THREADS),
        configurable: true,
      });
    }
    const load = (threaded ? await import('@mujoco/mujoco/mt') : await import('@mujoco/mujoco')).default as typeof load_mujoco;
    return new Promise<Mujoco>((resolve, reject) => {
      load({
        // After a native abort every later call into the module throws or
        // blocks, so nothing this worker was asked will ever be answered. Say
        // so at once: the page respawns the worker and rebuilds the scene.
        onAbort: (what: unknown) => post({ type: 'ERROR', message: `The physics engine aborted (${String(what)}).`, fatal: true }),
        instantiateWasm: (
          imports: WebAssembly.Imports,
          done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
        ) => {
          WebAssembly.instantiateStreaming(fetch(threaded ? mujocoMtWasmUrl : mujocoWasmUrl), imports).then((result) => {
            // The threaded build imports its (shared) memory rather than exporting it.
            wasmMemory = (result.instance.exports.memory as WebAssembly.Memory | undefined)
              ?? Object.values(imports).flatMap((m) => Object.values(m)).find((v): v is WebAssembly.Memory => v instanceof WebAssembly.Memory)
              ?? null;
            done(result.instance, result.module);
          }, reject);
          return {};
        },
      } as Parameters<typeof load_mujoco>[0]).then((m) => { mujoco = m; resolve(m); }, reject);
    });
  })().catch((e) => {
    mujocoLoading = null;
    throw new Error(`The physics engine failed to load: ${String((e as Error)?.message || e)}`);
  });
  return mujocoLoading;
};
let model: MjModel | null = null;
let data: MjData | null = null;
let sceneGraph: SceneGraph = { nodes: [] };

let isPlaying = false;
let draggedNodeId: string | null = null;
let dragTarget: { x: number; y: number; z: number } | null = null;
let pressedKeys = new Set<string>();

let stepCount = 0;
let accumulator = 0;

const history = new HistoryRing(5000);

const isSharedSupported = typeof SharedArrayBuffer !== 'undefined';

/**
 * The scene's cloth, simulated beside MuJoCo by XPBD (utils/cloth/xpbd.ts):
 * it reads where every body is after each MuJoCo step and is drawn from its
 * own particles. Rebuilt with the model; a rebuild that carries the scene
 * over carries the cloth too.
 */
let cloth: ClothWorld | null = null;

/**
 * Which cloth layout the last build made: a new number whenever the cloth's
 * models are not the very ones of the build before (a carried build reuses
 * them), so the client can be spared a layout it holds already.
 */
let clothLayoutId = 0;
let clothLayoutModels: ClothWorld['models'] | null = null;
const noteClothLayout = (): number => {
  const models = cloth?.models ?? [];
  const same = clothLayoutModels !== null && clothLayoutModels.length === models.length && models.every((m, i) => m === clothLayoutModels![i]);
  if (!same) { clothLayoutId++; clothLayoutModels = models; }
  return clothLayoutId;
};

/** Builds the scene's cloth (utils/cloth/clothWorld); `carry` keeps it where it is if it is the same cloth. */
const buildCloth = (carry: boolean, seedClothState?: ClothStateSnapshot) => {
  cloth = model && data ? buildClothWorld(mujoco, model, data, sceneGraph, cloth, carry, seedClothState) : null;
};

let sharedBuffers: {
  qpos?: Float64Array;
  qvel?: Float64Array;
  ctrl?: Float64Array;
  xfrc_applied?: Float64Array;
  qfrc_applied?: Float64Array;
  xpos?: Float64Array;
  xmat?: Float64Array;
  cvel?: Float64Array;
  geom_xpos?: Float64Array;
  geom_xmat?: Float64Array;
  /** Cloth vertices, world frame; separate from the guards below, being often empty. */
  flexvert_xpos?: Float64Array;
} = {};

const updateSharedBuffers = () => {
  if (!isSharedSupported || !data) return;
  const { qpos, qvel, ctrl, xfrc_applied, qfrc_applied, xpos, xmat, cvel, geom_xpos, geom_xmat } = sharedBuffers;
  if (!qpos || !qvel || !ctrl || !xfrc_applied || !qfrc_applied || !xpos || !xmat || !cvel || !geom_xpos || !geom_xmat) return;
  qpos.set(data.qpos);
  qvel.set(data.qvel);
  ctrl.set(data.ctrl);
  xfrc_applied.set(data.xfrc_applied);
  qfrc_applied.set(data.qfrc_applied);
  xpos.set(data.xpos);
  xmat.set(data.xmat);
  cvel.set(data.cvel);
  geom_xpos.set(data.geom_xpos);
  geom_xmat.set(data.geom_xmat);
  if (sharedBuffers.flexvert_xpos?.length && cloth) cloth.sim.writeRender(sharedBuffers.flexvert_xpos);
};


// Name -> id caches, rebuilt once per successful build (mirrors the caches
// PhysicsLoop/DynamicGeom/PulleyRopesRenderer/MouseDragForceRenderer used to
// build on the main thread via mj_name2id/mj_id2name).
let bodyIdCache: Record<string, number> = {};
let jointIdCache: Record<string, number> = {};
let geomIdCache: Record<string, number> = {};
let geomNameCache: Record<number, string> = {};
let actuatorIdCache: Record<string, number> = {};

interface CachedScript {
  src: string;
  fn: (api: Record<string, unknown>) => void;
  api: Record<string, unknown>;
}
let scriptCache: Record<string, CachedScript> = {};
/*
 * What scripts got wrong, keyed by body + message so a mistake made every step
 * is logged once, with when it started and how often. A headless run swaps in
 * its own and returns it as warnings; live, it is pushed to the main thread
 * (SCRIPT_STATUS) for physics_get_state. See scriptDiagnostics.ts.
 */
let scriptProblems = new ScriptProblemLog();
const noteScriptProblem = (bodyName: string, message: string) => {
  if (scriptProblems.note(bodyName, message, data ? data.time : 0)) {
    console.warn(`[Script:${bodyName}]`, message);
  }
};
/** api.log lines, and what the scripts cost: swapped out by a headless run like the problems. */
let scriptLogs = new ScriptLogRing(200);
let scriptTiming = new ScriptTiming();
/** A short list of names for a "no such X; this model has: ..." message. */
const nameList = (names: string[], max = 12): string =>
  names.length === 0 ? '(none)' : names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
// Each scripted body's api.state; see utils/scriptState.ts. A `let` so a
// headless run can work on its own without touching the live scene's.
let scriptState = new ScriptStateStore();

const findNodeById = (nodes: SceneNode[], targetId: string): SceneNode | null => {
  if (!nodes) return null;
  for (const n of nodes) {
    if (n.id === targetId || n.name === targetId) return n;
    const c = findNodeById(n.children || [], targetId);
    if (c) return c;
  }
  return null;
};

const rebuildIdCaches = () => {
  const mj = mujoco!;
  const mdl = model!;
  const bCache: Record<string, number> = {};
  for (let b = 0; b < mdl.nbody; b++) {
    const name = mj.mj_id2name(mdl, mj.mjtObj.mjOBJ_BODY.value, b);
    if (name) bCache[name] = b;
  }
  const jCache: Record<string, number> = {};
  const collectIds = (nodes: SceneNode[]) => {
    if (!nodes || !mj || !mdl) return;
    for (const node of nodes) {
      let bId = mj.mj_name2id(mdl, mj.mjtObj.mjOBJ_BODY.value, node.name || node.id);
      if (bId === -1 && node.id) {
        bId = mj.mj_name2id(mdl, mj.mjtObj.mjOBJ_BODY.value, node.id);
      }
      if (bId !== -1) {
        bCache[node.id] = bId;
        if (node.name) bCache[node.name] = bId;
      }
      node.joints?.forEach((j) => {
        // mj_name2id throws on undefined, which failed the whole build.
        if (!mj || !mdl || !j.name) return;
        const jId = mj.mj_name2id(mdl, mj.mjtObj.mjOBJ_JOINT.value, j.name);
        if (jId !== -1) jCache[j.name] = jId;
      });
      collectIds(node.children || []);
    }
  };
  collectIds(sceneGraph.nodes);

  const giCache: Record<string, number> = {};
  const gnCache: Record<number, string> = {};
  for (let g = 0; g < mdl.ngeom; g++) {
    const name = mj.mj_id2name(mdl, mj.mjtObj.mjOBJ_GEOM.value, g);
    gnCache[g] = name || `geom_${g}`;
    if (name) giCache[name] = g;
  }
  const aCache: Record<string, number> = {};
  for (let a = 0; a < mdl.nu; a++) {
    const name = mj.mj_id2name(mdl, mj.mjtObj.mjOBJ_ACTUATOR.value, a);
    if (name) aCache[name] = a;
  }

  bodyIdCache = bCache;
  jointIdCache = jCache;
  geomIdCache = giCache;
  geomNameCache = gnCache;
  actuatorIdCache = aCache;

  // The joints telemetry reports, with their body and actuators, once per build.
  const nodeOfBody: Record<number, string> = { 0: 'world' };
  const infos: JointInfo[] = [];
  const byJoint = actuatorsByJoint(mj, mdl);
  const walk = (nodes: SceneNode[]) => {
    for (const node of nodes || []) {
      const bId = bCache[node.id];
      if (bId !== undefined && nodeOfBody[bId] === undefined) nodeOfBody[bId] = node.id;
      for (const j of node.joints || []) {
        const id = jCache[j.name];
        if (id === undefined) continue;
        const drive = clutchDrive(mj, mdl, j.name, byJoint);
        infos.push({
          name: j.name, id, type: mdl.jnt_type[id], qposadr: mdl.jnt_qposadr[id], dofadr: mdl.jnt_dofadr[id], body: node.id,
          actuators: byJoint.get(id) ?? [], ...(drive ? { drive } : {}),
        });
      }
      walk(node.children || []);
    }
  };
  walk(sceneGraph.nodes);
  bodyNodeById = nodeOfBody;
  jointInfos = infos;
};

/** Scene node id of each MuJoCo body ('world' for 0), for naming contacts and ray hits. */
let bodyNodeById: Record<number, string> = {};
let jointInfos: JointInfo[] = [];
const sensorNames: SensorNames = {
  geomName: (g) => geomNameCache[g] ?? `geom_${g}`,
  bodyNode: (b) => bodyNodeById[b] ?? (mujoco && model ? mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY.value, b) || `body_${b}` : `body_${b}`),
};

/** The views body velocities are read from; take once per use, as each getter allocates. */
const velocityViews = (mdl: MjModel, dat: MjData): VelocityViews => ({
  cvel: dat.cvel, xpos: dat.xpos, subtreeCom: dat.subtree_com, rootId: mdl.body_rootid,
});

const createScriptApi = (node: SceneNode): Record<string, unknown> => {
  const _resolveBody = (name: string) =>
    bodyIdCache[name] ?? (mujoco && model ? mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, name) : -1);
  const _resolveJoint = (name: string) =>
    jointIdCache[name] ?? (mujoco && model ? mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT.value, name) : -1);
  const me = node.name || node.id;
  // Lookups that used to miss in silence (a getter returning zeros, a force
  // or a control going nowhere) now say so once in the problems, naming what
  // the model does have. Still no throw: see _guard below. A body left out
  // defaults to the script's own, and is not reported if that one has no
  // MuJoCo body of its own.
  const _body = (fnName: string, bodyName: string | undefined): number => {
    const id = _resolveBody(bodyName ?? node.id);
    if (id === -1 && bodyName !== undefined) {
      noteScriptProblem(me, `${fnName}: no body named '${bodyName}'; this model has: ${nameList([...new Set(Object.keys(bodyIdCache))])}`);
    }
    return id;
  };
  const _joint = (fnName: string, jointName: string): number => {
    const id = typeof jointName === 'string' ? _resolveJoint(jointName) : -1;
    if (id === -1) noteScriptProblem(me, `${fnName}: no joint named '${String(jointName)}'; this model has: ${nameList(Object.keys(jointIdCache))}`);
    return id;
  };
  const _actuator = (fnName: string, actuatorName: string): number => {
    const id = actuatorIdCache[actuatorName] ?? -1;
    if (id === -1) noteScriptProblem(me, `${fnName}: no actuator named '${String(actuatorName)}'; this model has: ${nameList(Object.keys(actuatorIdCache))}`);
    return id;
  };

  // The setters used to return quietly on every miss (no such body, no joint,
  // a joint MuJoCo does not know) and to read only [0] of a vector given to a
  // one-axis joint, so [0, 0, w] spun a z hinge at 0. A call that asks for
  // something impossible now does nothing *and says so*, once, in the run's
  // warnings. It does not throw: that would also stop the rest of the script,
  // every step, in scenes that have always worked around the miss.
  const _guard = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => {
    try { fn(...args); } catch (e) { noteScriptProblem(node.name || node.id, (e as Error).message); }
  };
  const _resolveSetterJoint = (fnName: string, bodyName: string) => {
    const targetNode = findNodeById(sceneGraph.nodes, bodyName);
    if (!targetNode) throw new Error(`${fnName}: no body named '${bodyName}'`);
    if (!targetNode.joints?.length) {
      throw new Error(`${fnName}: body '${bodyName}' has no joint, so it cannot move on its own (it is fixed to its parent or the world)`);
    }
    const joint = targetNode.joints[0];
    const jId = _resolveJoint(joint.name);
    if (jId === -1) throw new Error(`${fnName}: joint '${joint.name}' of body '${bodyName}' is not in the compiled model`);
    return { joint, jId };
  };
  // A one-axis joint (hinge, slide) takes a number. A 3-vector is read as a
  // rate in the body's frame and projected onto the joint axis, the same frame
  // the axis is written in.
  const _alongAxis = (fnName: string, v: number[] | number, joint: SceneJoint): number => {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new Error(`${fnName}: value must be a finite number; nothing was set`);
      return v;
    }
    if (Array.isArray(v) && v.length === 1) {
      if (typeof v[0] !== 'number' || !Number.isFinite(v[0])) {
        throw new Error(`${fnName}: value must be a finite number; nothing was set`);
      }
      return v[0];
    }
    if (Array.isArray(v) && v.length >= 3) {
      if (
        typeof v[0] !== 'number' || !Number.isFinite(v[0]) ||
        typeof v[1] !== 'number' || !Number.isFinite(v[1]) ||
        typeof v[2] !== 'number' || !Number.isFinite(v[2])
      ) {
        throw new Error(`${fnName}: all 3 components must be finite numbers; nothing was set`);
      }
      const a = joint.axis ?? [0, 0, 1];
      const len = Math.hypot(a[0], a[1], a[2]) || 1;
      const along = (v[0] * a[0] + v[1] * a[1] + v[2] * a[2]) / len;
      const off = Math.sqrt(Math.max(0, v[0] * v[0] + v[1] * v[1] + v[2] * v[2] - along * along));
      if (off > 1e-6 * Math.max(1, Math.abs(along))) {
        // No values in the message: it is the dedupe key, and they change every step.
        noteScriptProblem(me, `${fnName}: a vector that is not along ${joint.type} '${joint.name}' axis [${a.join(', ')}] was given; only its component along the axis was applied`);
      }
      return along;
    }
    throw new Error(`${fnName}: joint '${joint.name}' is a ${joint.type}; pass a number (or a 3-vector to project onto its axis)`);
  };
  const _vector = (fnName: string, v: number[] | number, n: number, joint: SceneJoint): number[] => {
    if (!Array.isArray(v) || v.length < n) {
      throw new Error(`${fnName}: joint '${joint.name}' is a ${joint.type}; pass an array of ${n} numbers`);
    }
    for (let i = 0; i < n; i++) {
      if (typeof v[i] !== 'number' || !Number.isFinite(v[i])) {
        throw new Error(`${fnName}: all ${n} components must be finite numbers; nothing was set`);
      }
    }
    return v;
  };

  const api: Record<string, unknown> = {
    id: node.id,
    name: node.name,
    isKeyPressed: (keyName: string) => !!keyName && pressedKeys.has(keyName.toLowerCase()),
    setPosition: _guard((pos: number[] | number, bodyName: string = node.id) => {
      const mdl = model!, dat = data!;
      const { joint, jId } = _resolveSetterJoint('setPosition', bodyName);
      const qposadr = mdl.jnt_qposadr[jId];
      if (joint.type === 'free') {
        const p = _vector('setPosition', pos, 3, joint);
        dat.qpos[qposadr + 0] = p[0]; dat.qpos[qposadr + 1] = p[1]; dat.qpos[qposadr + 2] = p[2];
      } else if (joint.type === 'ball') {
        const q = _vector('setPosition', pos, 4, joint);
        dat.qpos[qposadr + 0] = q[0]; dat.qpos[qposadr + 1] = q[1]; dat.qpos[qposadr + 2] = q[2]; dat.qpos[qposadr + 3] = q[3];
      } else {
        dat.qpos[qposadr] = _alongAxis('setPosition', pos, joint);
      }
      pendingWake.add(mdl.jnt_bodyid[jId]);
    }),
    setVelocity: _guard((vel: number[] | number, bodyName: string = node.id) => {
      const mdl = model!, dat = data!;
      const { joint, jId } = _resolveSetterJoint('setVelocity', bodyName);
      const dofadr = mdl.jnt_dofadr[jId];
      if (joint.type === 'free') {
        const v = _vector('setVelocity', vel, 3, joint);
        dat.qvel[dofadr + 0] = v[0]; dat.qvel[dofadr + 1] = v[1]; dat.qvel[dofadr + 2] = v[2];
      } else if (joint.type === 'ball') {
        throw new Error(`setVelocity: joint '${joint.name}' is a ball joint, which only rotates; use setAngularVelocity`);
      } else {
        dat.qvel[dofadr] = _alongAxis('setVelocity', vel, joint);
      }
      pendingWake.add(mdl.jnt_bodyid[jId]);
    }),
    setAngularVelocity: _guard((angvel: number[] | number, bodyName: string = node.id) => {
      const mdl = model!, dat = data!;
      const { joint, jId } = _resolveSetterJoint('setAngularVelocity', bodyName);
      const dofadr = mdl.jnt_dofadr[jId];
      if (joint.type === 'free') {
        // World frame, as getAngularVelocity reads it: a free joint's qvel holds ω in the body's frame.
        const w = worldToBodyFrame(dat.xmat, mdl.jnt_bodyid[jId], _vector('setAngularVelocity', angvel, 3, joint));
        dat.qvel[dofadr + 3] = w[0]; dat.qvel[dofadr + 4] = w[1]; dat.qvel[dofadr + 5] = w[2];
      } else if (joint.type === 'ball') {
        // World frame, as getAngularVelocity reads it: a ball joint's qvel also holds ω in the body's frame.
        const w = worldToBodyFrame(dat.xmat, mdl.jnt_bodyid[jId], _vector('setAngularVelocity', angvel, 3, joint));
        dat.qvel[dofadr + 0] = w[0]; dat.qvel[dofadr + 1] = w[1]; dat.qvel[dofadr + 2] = w[2];
      } else if (joint.type === 'hinge') {
        dat.qvel[dofadr] = _alongAxis('setAngularVelocity', angvel, joint);
      } else {
        throw new Error(`setAngularVelocity: joint '${joint.name}' is a slide, which cannot rotate; use setVelocity`);
      }
      pendingWake.add(mdl.jnt_bodyid[jId]);
    }),
    getPosition: (bodyName?: string) => {
      const dat = data!;
      const bId = _body('getPosition', bodyName);
      return bId !== -1 ? [dat.xpos[bId * 3], dat.xpos[bId * 3 + 1], dat.xpos[bId * 3 + 2]] : [0, 0, 0];
    },
    getVelocity: (bodyName?: string) => {
      const dat = data!;
      const bId = _body('getVelocity', bodyName);
      // The body origin's (the point getPosition gives), not cvel's tree-COM point.
      return bId !== -1 ? bodyPointVelocity(velocityViews(model!, dat), bId) : [0, 0, 0];
    },
    getAngularVelocity: (bodyName?: string) => {
      const dat = data!;
      const bId = _body('getAngularVelocity', bodyName);
      return bId !== -1 ? bodyAngularVelocity(velocityViews(model!, dat), bId) : [0, 0, 0];
    },
    getMass: (bodyName?: string) => {
      const mdl = model!;
      const bId = _body('getMass', bodyName);
      return bId !== -1 ? mdl.body_mass[bId] : 0;
    },
    getJointPosition: (jointName: string) => {
      const mdl = model!, dat = data!;
      const jId = _joint('getJointPosition', jointName);
      return jId !== -1 ? dat.qpos[mdl.jnt_qposadr[jId]] : 0;
    },
    getJointVelocity: (jointName: string) => {
      const mdl = model!, dat = data!;
      const jId = _joint('getJointVelocity', jointName);
      return jId !== -1 ? dat.qvel[mdl.jnt_dofadr[jId]] : 0;
    },
    applyForce: (forceVec: number[], bodyName?: string) => {
      if (
        !Array.isArray(forceVec) || forceVec.length < 3 ||
        typeof forceVec[0] !== 'number' || !Number.isFinite(forceVec[0]) ||
        typeof forceVec[1] !== 'number' || !Number.isFinite(forceVec[1]) ||
        typeof forceVec[2] !== 'number' || !Number.isFinite(forceVec[2])
      ) {
        noteScriptProblem(me, 'applyForce: pass [fx, fy, fz] of 3 finite numbers; nothing was applied');
        return;
      }
      const dat = data!;
      const bId = _body('applyForce', bodyName);
      if (bId === -1) return;
      pendingWake.add(bId);
      dat.xfrc_applied[bId * 6 + 0] += forceVec[0];
      dat.xfrc_applied[bId * 6 + 1] += forceVec[1];
      dat.xfrc_applied[bId * 6 + 2] += forceVec[2];
    },
    applyTorque: (torqueVec: number[], bodyName?: string) => {
      if (
        !Array.isArray(torqueVec) || torqueVec.length < 3 ||
        typeof torqueVec[0] !== 'number' || !Number.isFinite(torqueVec[0]) ||
        typeof torqueVec[1] !== 'number' || !Number.isFinite(torqueVec[1]) ||
        typeof torqueVec[2] !== 'number' || !Number.isFinite(torqueVec[2])
      ) {
        noteScriptProblem(me, 'applyTorque: pass [tx, ty, tz] of 3 finite numbers; nothing was applied');
        return;
      }
      const dat = data!;
      const bId = _body('applyTorque', bodyName);
      if (bId === -1) return;
      pendingWake.add(bId);
      dat.xfrc_applied[bId * 6 + 3] += torqueVec[0];
      dat.xfrc_applied[bId * 6 + 4] += torqueVec[1];
      dat.xfrc_applied[bId * 6 + 5] += torqueVec[2];
    },
    getOrientation: (bodyName?: string) => {
      const dat = data!;
      const bId = _body('getOrientation', bodyName);
      if (bId === -1) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
      const o = bId * 9;
      return [dat.xmat[o], dat.xmat[o+1], dat.xmat[o+2], dat.xmat[o+3], dat.xmat[o+4], dat.xmat[o+5], dat.xmat[o+6], dat.xmat[o+7], dat.xmat[o+8]];
    },
    applyJointForce: (jointName: string, forceVal: number) => {
      if (typeof forceVal !== 'number' || !Number.isFinite(forceVal)) {
        noteScriptProblem(me, `applyJointForce('${jointName}', ${String(forceVal)}): the force must be a finite number; nothing was applied`);
        return;
      }
      const mdl = model!, dat = data!;
      const jId = _joint('applyJointForce', jointName);
      if (jId !== -1) {
        pendingWake.add(mdl.jnt_bodyid[jId]);
        dat.qfrc_applied[mdl.jnt_dofadr[jId]] += forceVal;
      }
    },
    setActuatorControl: (actuatorName: string, ctrlVal: number) => {
      if (typeof ctrlVal !== 'number' || !Number.isFinite(ctrlVal)) {
        noteScriptProblem(me, `setActuatorControl('${actuatorName}', ${String(ctrlVal)}): the control must be a finite number; nothing was set`);
        return;
      }
      const actId = _actuator('setActuatorControl', actuatorName);
      if (actId !== -1) data!.ctrl[actId] = ctrlVal;
    },
    getActuatorControl: (actuatorName: string) => {
      const actId = _actuator('getActuatorControl', actuatorName);
      return actId !== -1 ? data!.ctrl[actId] : 0;
    },
    getTime: () => (data ? data.time : 0),
    getTimestep: () => (model ? modelOpt(model).timestep : 0),
    getWind: () => [envWindX || 0, envWindY || 0],
    // First hit within maxDist (default 10 m) along dir, or null. Skips the
    // calling body unless excludeBody says otherwise (null: skip nothing).
    raycast: (origin: number[], dir: number[], maxDist = 10, excludeBody?: string | null) => {
      if (!Array.isArray(origin) || origin.length < 3 || !Array.isArray(dir) || dir.length < 3) {
        noteScriptProblem(me, 'raycast: pass origin and dir as [x, y, z] arrays');
        return null;
      }
      const exclude = excludeBody === null ? -1 : _body('raycast', excludeBody ?? undefined);
      try {
        return raycast(mujoco!, model!, data!, origin, dir, maxDist, exclude, sensorNames);
      } catch (e) {
        noteScriptProblem(me, (e as Error).message);
        return null;
      }
    },
    // What this body (or the named one) is touching right now.
    getContacts: (bodyName?: string) => {
      const bId = _body('getContacts', bodyName);
      if (bId === -1) return [];
      return contactsOfBody(mujoco!, model!, data!, bId, sensorNames);
    },
    log: (...args: unknown[]) => {
      console.log(`[Script:${node.name}]`, ...args);
      scriptLogs.push(data ? data.time : 0, me, args);
    },
  };
  attachScriptState(api, scriptState, node.id);
  return api;
};

// Ported verbatim from App.tsx's PhysicsLoop.executeScripts (aerodynamics +
// user control scripts), operating on the worker's own model/data/sceneGraph.
const executeScripts = (nodes: SceneNode[], aeroDiagnostics: Record<string, AeroDiagnostic>) => {
  // Only ever reached from stepTick/runHeadless, both of which have already
  // established that the module, model and data are there.
  const mdl = model!;
  const dat = data!;
  if (!nodes) return;
  for (const node of nodes) {
    if (node.isAerodynamic) {
      const geom = node.geoms?.[0];
      if (geom) {
        const bId = bodyIdCache[node.id] ?? bodyIdCache[node.name] ?? -1;
        if (bId !== -1) {
          // Views taken once for this body: each `dat.x` / `mdl.x` read is an embind
          // getter that allocates a new typed array over the heap.
          const geomXpos = dat.geom_xpos;
          const xfrc = dat.xfrc_applied;
          const xmat = dat.xmat;
          const xpos = dat.xpos;
          const bodyDofnum = mdl.body_dofnum;
          const bodyParentid = mdl.body_parentid;
          let pId = bId;
          while (pId > 0 && bodyDofnum[pId] === 0) {
            pId = bodyParentid[pId];
          }

          const gId = geomIdCache[geom.name || ''] ?? -1;
          let geomWorldX = xpos[bId * 3 + 0];
          let geomWorldY = xpos[bId * 3 + 1];
          let geomWorldZ = xpos[bId * 3 + 2];
          if (gId !== -1) {
            geomWorldX = geomXpos[gId * 3 + 0];
            geomWorldY = geomXpos[gId * 3 + 1];
            geomWorldZ = geomXpos[gId * 3 + 2];
          }

          // The force goes on the moving body, whose xfrc_applied acts at its COM.
          const xipos = dat.xipos;
          const rx = geomWorldX - xipos[pId * 3 + 0];
          const ry = geomWorldY - xipos[pId * 3 + 1];
          const rz = geomWorldZ - xipos[pId * 3 + 2];

          // The air meets the geom where it is, at that point's velocity.
          const views = velocityViews(mdl, dat);
          const [wx, wy, wz] = bodyAngularVelocity(views, bId);
          const [vx, vy, vz] = bodyPointVelocity(views, bId, [geomWorldX, geomWorldY, geomWorldZ]);

          const o = bId * 9;
          const noseX = xmat[o + 0], noseY = xmat[o + 3], noseZ = xmat[o + 6];
          const spanX = xmat[o + 1], spanY = xmat[o + 4], spanZ = xmat[o + 7];
          const upX = xmat[o + 2], upY = xmat[o + 5], upZ = xmat[o + 8];

          const aeroRef = aeroBladeGroupByNodeId.get(node.id);
          let localWindX = envWindX || 0;
          let localWindY = envWindY || 0;
          let localWindZ = 0;
          if (envWindGusting && (localWindX !== 0 || localWindY !== 0)) {
            [localWindX, localWindY, localWindZ] = evaluateGustWind(
              localWindX,
              localWindY,
              geomWorldX,
              geomWorldY,
              geomWorldZ,
              dat.time,
            );
          }

          const relVx = vx - localWindX;
          const relVy = vy - localWindY;
          const relVz = vz - localWindZ;

          const spanDotV = relVx * spanX + relVy * spanY + relVz * spanZ;
          const airfoilVx = relVx - spanDotV * spanX;
          const airfoilVy = relVy - spanDotV * spanY;
          const airfoilVz = relVz - spanDotV * spanZ;
          const relSpeed = Math.sqrt(airfoilVx * airfoilVx + airfoilVy * airfoilVy + airfoilVz * airfoilVz);

          if (relSpeed >= 0.05 && envDensity >= 0) {
            const s = geom.size || [];
            const halfX = s[0] || 0.3;
            const halfY = s[1] || 0.2;
            const wingArea = (halfX * 2) * (halfY * 2);
            const chord = halfX * 2;

            const airDensity = envDensity > 0 ? envDensity : 1.225;
            const q = 0.5 * airDensity * relSpeed * relSpeed;

            const vhx = airfoilVx / relSpeed;
            const vhy = airfoilVy / relSpeed;
            const vhz = airfoilVz / relSpeed;

            const v_nose = vhx * noseX + vhy * noseY + vhz * noseZ;
            const v_up = vhx * upX + vhy * upY + vhz * upZ;

            const alpha = Math.atan2(-v_up, v_nose);

            const alphaDeg = Math.abs(alpha * 180 / Math.PI);
            let CL: number;
            if (alphaDeg <= 15) {
              CL = 5.7 * alpha;
            } else if (alphaDeg <= 30) {
              const sign = Math.sign(alpha) || 1;
              const t = (alphaDeg - 15) / 15;
              CL = sign * (1.1 * (1 - t) + 0.4 * t);
            } else {
              CL = Math.sin(2 * alpha);
            }
            const CD = 0.05 + 1.5 * Math.sin(alpha) * Math.sin(alpha);

            const ldx = -v_up * noseX + v_nose * upX;
            const ldy = -v_up * noseY + v_nose * upY;
            const ldz = -v_up * noseZ + v_nose * upZ;

            const ddx = -vhx;
            const ddy = -vhy;
            const ddz = -vhz;

            const fx = (CL * ldx + CD * ddx) * q * wingArea;
            const fy = (CL * ldy + CD * ddy) * q * wingArea;
            const fz = (CL * ldz + CD * ddz) * q * wingArea;

            const pitchMoment = -0.05 * alpha * q * wingArea * chord;
            let tx_aero = pitchMoment * spanX;
            let ty_aero = pitchMoment * spanY;
            let tz_aero = pitchMoment * spanZ;

            let tx_lever = ry * fz - rz * fy;
            let ty_lever = rz * fx - rx * fz;
            let tz_lever = rx * fy - ry * fx;

            // Explicit Euler integrator passive velocity clamp for lightweight (< 150 g) aerodynamic panels/wings:
            // When a light panel whips through high relative speed (e.g. > 20 m/s), explicit step force
            // `F * dt / m` could exceed `relSpeed` and reverse the relative flow within a single 1 ms step,
            // creating exponential explicit-Euler amplification! Clamping `|Δv_step| <= 0.35 * relSpeed`
            // guarantees strict passivity across ripstop nylon, cotton, and heavy canvas up to gale-force winds.
            let scale = 1.0;
            const bodyMassVal = mdl.body_mass[pId] || 0;
            if (bodyMassVal > 0 && bodyMassVal < 0.15) {
              const dtStep = modelOpt(mdl).timestep || 0.001;
              const fMagRaw = Math.hypot(fx, fy, fz);
              const maxPassiveForce = (0.35 * bodyMassVal * Math.max(1.0, relSpeed)) / dtStep;
              if (fMagRaw > maxPassiveForce) {
                scale = maxPassiveForce / fMagRaw;
              }
            }
            const sFx = fx * scale;
            const sFy = fy * scale;
            const sFz = fz * scale;
            tx_aero *= scale;
            ty_aero *= scale;
            tz_aero *= scale;
            tx_lever *= scale;
            ty_lever *= scale;
            tz_lever *= scale;

            xfrc[pId * 6 + 0] += sFx;
            xfrc[pId * 6 + 1] += sFy;
            xfrc[pId * 6 + 2] += sFz;

            xfrc[pId * 6 + 3] += tx_aero + tx_lever;
            xfrc[pId * 6 + 4] += ty_aero + ty_lever;
            xfrc[pId * 6 + 5] += tz_aero + tz_lever;

            aeroDiagnostics[node.name || node.id] = {
              relSpeed, alpha: alpha * 180 / Math.PI, CL, CD,
              force: [sFx, sFy, sFz],
              torque: [tx_aero + tx_lever, ty_aero + ty_lever, tz_aero + tz_lever],
            };
            if (soundEnabled && aeroRef) {
              const fMag = Math.hypot(sFx, sFy, sFz);
              const grp = aeroRef.group;
              grp.accForceSum += fMag;
              grp.accRelSpeedSum += relSpeed * wingArea;
              grp.accAlphaWeightedSum += alphaDeg * wingArea;
              grp.accAreaSum += wingArea;
              grp.accActiveCount++;
              if (relSpeed > grp.accTipSpeedMax) grp.accTipSpeedMax = relSpeed;
            }
          } else {
            aeroDiagnostics[node.name || node.id] = { relSpeed, alpha: 0, CL: 0, CD: 0, force: [0, 0, 0], torque: [0, 0, 0] };
          }

          const DAMPING = 0.0005;
          xfrc[pId * 6 + 3] -= DAMPING * wx;
          xfrc[pId * 6 + 4] -= DAMPING * wy;
          xfrc[pId * 6 + 5] -= DAMPING * wz;
        }
      }
    }

    if (node.script && node.script.trim() !== '') {
      let cached = scriptCache[node.id];
      if (!cached || cached.src !== node.script) {
        let fn: (api: Record<string, unknown>) => void;
        try {
          fn = new Function('api', node.script) as (api: Record<string, unknown>) => void;
        } catch (e) {
          noteScriptProblem(node.name || node.id, `does not compile: ${(e as Error)?.message ?? e}`);
          fn = () => {};
        }
        cached = { src: node.script, fn, api: createScriptApi(node) };
        scriptCache[node.id] = cached;
      }

      // Timed per body, so a slow scene can name the script that makes it slow.
      const t0 = performance.now();
      try { cached.fn(cached.api); } catch (e) { noteScriptProblem(node.name || node.id, `runtime error: ${(e as Error)?.message ?? e}`); }
      scriptTiming.addBody(node.name || node.id, performance.now() - t0);
    }

    if (node.children) executeScripts(node.children, aeroDiagnostics);
  }
};

const applyFreeJointDamping = (nodes: SceneNode[]) => {
  const mdl = model!;
  const dat = data!;
  if (!nodes) return;
  for (const node of nodes) {
    if (node.joints) {
      for (const joint of node.joints) {
        if (joint.type === 'free' && joint.damping !== undefined && joint.damping > 0) {
          const bId = bodyIdCache[node.id] ?? bodyIdCache[node.name] ?? -1;
          if (bId !== -1) {
            // Views taken once for this body, as in executeScripts.
            const xfrc = dat.xfrc_applied;
            const bodyInertia = mdl.body_inertia;
            const bodyMass = mdl.body_mass;
            // xfrc_applied acts at the body's COM, so the damping reads that point's velocity.
            const views = velocityViews(mdl, dat);
            const xipos = dat.xipos;
            const [wx, wy, wz] = bodyAngularVelocity(views, bId);
            const [vx, vy, vz] = bodyPointVelocity(views, bId, [xipos[bId * 3], xipos[bId * 3 + 1], xipos[bId * 3 + 2]]);
            const c = joint.damping;
            const mass = bodyMass[bId] || 1.0;
            const ix = bodyInertia[bId * 3 + 0] || 1.0;
            const iy = bodyInertia[bId * 3 + 1] || 1.0;
            const iz = bodyInertia[bId * 3 + 2] || 1.0;
            xfrc[bId * 6 + 0] -= c * mass * vx;
            xfrc[bId * 6 + 1] -= c * mass * vy;
            xfrc[bId * 6 + 2] -= c * mass * vz;
            xfrc[bId * 6 + 3] -= c * ix * wx;
            xfrc[bId * 6 + 4] -= c * iy * wy;
            xfrc[bId * 6 + 5] -= c * iz * wz;
          }
        }
      }
    }
    applyFreeJointDamping(node.children || []);
  }
};

/*
 * Bodies to wake before the next step.
 *
 * A shattered scene runs with MuJoCo's sleeping on (see `sleep` in mjcf.ts),
 * and a body that is asleep is not integrated at all: gravity does not wake
 * it. Writing its qpos moves it, but it stays asleep where it was put, so a
 * shard lifted by the gizmo or a script would hang in mid-air when let go.
 * Collisions and applied forces are what wake a body, so a body written to is
 * given a force far too small to move anything, for one step.
 */
const pendingWake = new Set<number>();
const SLEEP_ENABLE_BIT = 16; // mjENBL_SLEEP
const WAKE_NUDGE_N = 1e-12;

/*
 * The two option fields read while stepping, remembered per model. `model.opt`
 * is an embind accessor that builds a wrapper object each time it is read, and
 * it was read on every tick; the values cannot change under a built model.
 * Keyed on the model object because headless runs swap it out and back.
 */
let optCache: { model: MjModel; timestep: number; enableflags: number; gravityZ: number; gravity: number[] } | null = null;
const modelOpt = (mdl: MjModel) => {
  if (optCache?.model !== mdl) {
    const opt = mdl.opt;
    const gravity = Array.from((opt.gravity ?? [0, 0, -9.81]) as ArrayLike<number>);
    optCache = {
      model: mdl,
      timestep: opt.timestep,
      enableflags: opt.enableflags,
      gravityZ: gravity[2] ?? -9.81,
      gravity,
    };
  }
  return optCache;
};

const wakeBodies = () => {
  if (pendingWake.size === 0) return;
  const mdl = model!, dat = data!;
  if (modelOpt(mdl).enableflags & SLEEP_ENABLE_BIT) {
    for (const b of pendingWake) {
      if (b > 0 && b < mdl.nbody) dat.xfrc_applied[b * 6 + 2] += WAKE_NUDGE_N;
    }
  }
  pendingWake.clear();
};

/** The least the pointer can pull with, N: about what fingers pull a strand out of putty with. */
const DRAG_HAND_N = 25;

/**
 * The mass of everything joined to body `bId` by active welds and pins, its
 * own included. Recomputed when what is broken changes, not every step.
 */
let joinedMassCache: { bId: number; broken: number; mass: number } | null = null;
const joinedMass = (bId: number): number => {
  const mdl = model!;
  const dat = data!;
  if (joinedMassCache?.bId === bId && joinedMassCache.broken === brokenWeldKeys.size) return joinedMassCache.mass;
  const active = dat.eq_active;
  const o1 = mdl.eq_obj1id, o2 = mdl.eq_obj2id, type = mdl.eq_type;
  const weld = mujoco!.mjtEq.mjEQ_WELD.value, connect = mujoco!.mjtEq.mjEQ_CONNECT.value;
  const links: number[][] = [];
  for (let i = 0; i < mdl.neq; i++) {
    if (!active[i] || (type[i] !== weld && type[i] !== connect)) continue;
    // Body 0 is the world: something fixed to it is not mass to be moved.
    if (o1[i] <= 0 || o2[i] <= 0) continue;
    (links[o1[i]] ??= []).push(o2[i]);
    (links[o2[i]] ??= []).push(o1[i]);
  }
  const seen = new Set([bId]);
  const queue = [bId];
  let mass = 0;
  while (queue.length) {
    const b = queue.pop()!;
    mass += mdl.body_mass[b] || 0;
    for (const n of links[b] ?? []) if (!seen.has(n)) { seen.add(n); queue.push(n); }
  }
  joinedMassCache = { bId, broken: brokenWeldKeys.size, mass };
  return mass;
};

/** The point of cloth the current drag holds, by its index as drawn, if it holds cloth. */
let clothGrabVertex: number | null = null;
/** The zip whose slider the current drag holds (ClothSim.zipAt), if it holds one: moved along its zip, not the cloth. */
let clothGrabZip = -1;

const applyDragForce = () => {
  if (clothGrabVertex !== null || clothGrabZip >= 0) return;
  const mdl = model!;
  const dat = data!;
  if (!draggedNodeId || !dragTarget) return;
  let targetBodyName = draggedNodeId;
  let bestMass = -1;
  const findHeaviestDescendant = (nodeId: string) => {
    const bid = bodyIdCache[nodeId] ?? -1;
    if (bid !== -1) {
      const m = mdl.body_mass[bid] || 0;
      if (m > bestMass) { bestMass = m; targetBodyName = nodeId; }
    }
    const node = findNodeById(sceneGraph.nodes, nodeId);
    for (const child of node?.children || []) findHeaviestDescendant(child.id);
  };
  findHeaviestDescendant(draggedNodeId);

  const bId = bodyIdCache[targetBodyName] ?? -1;
  if (bId === -1) return;
  pendingWake.add(bId);

  const bx = dat.xpos[bId * 3], by = dat.xpos[bId * 3 + 1], bz = dat.xpos[bId * 3 + 2];
  // The spring pulls the origin (bx, by, bz), so it is damped on that point's velocity.
  const [vx, vy, vz] = bodyPointVelocity(velocityViews(mdl, dat), bId);
  const own = mdl.body_mass[bId] || 1.0;
  // What the pull has to move: the body and everything welded or pinned to
  // it. Sized by the grabbed body alone, a 0.4 g strand of spaghetti in a
  // putty tower could be pulled with a hundredth of a newton, against putty
  // that holds it to 1.4 N, and nothing anywhere could be pulled apart.
  const mass = Math.max(own, joinedMass(bId));
  /*
   * Stiffness PER KILOGRAM, not an absolute one.
   *
   * A fixed spring makes the pointer's pull mean something different on every
   * body: the force is clamped to three times the body's weight below, so with
   * a constant K the offset needed to reach that clamp grows with the mass —
   * 0.15 m for a 1 kg block, but 132 m for the 900 kg oak tree, which is many
   * screens' worth of mouse. The tree read as immovable for that reason, not
   * because the force was too weak.
   *
   * Scaling K with the mass fixes the ratio instead: every body saturates at
   * the same 3 * 9.81 / 200 ≈ 0.15 m of pointer offset and settles in the same
   * time, so the gesture feels the same whatever is on the end of it. 200 per
   * kg is what a 1 kg body already had, so light bodies are unchanged.
   */
  // A hand's worth at the least: enough, at ~0.08 m of pointer offset,
  // to depress stiff spring-loaded buttons (e.g. 1.2 N/mm) or snap flexures.
  const K = Math.max(200.0 * mass, DRAG_HAND_N / 0.08);
  // Critical damping for the body actually being pulled: damping sized to the
  // whole assembly but applied to one light part would be unstable at 1 ms.
  const D = 2.0 * Math.sqrt(own * K);

  let fx = K * (dragTarget.x - bx) - D * vx;
  let fy = K * (dragTarget.y - by) - D * vy;
  let fz = K * (dragTarget.z - bz) - D * vz;

  const maxForce = Math.max(3.0 * mass * 9.81, DRAG_HAND_N);
  const netMag = Math.sqrt(fx * fx + fy * fy + fz * fz);
  if (netMag > maxForce) {
    const scale = maxForce / netMag;
    fx *= scale; fy *= scale; fz *= scale;
  }

  dat.xfrc_applied[bId * 6 + 0] = fx;
  dat.xfrc_applied[bId * 6 + 1] = fy;
  dat.xfrc_applied[bId * 6 + 2] = fz;
};

/**
 * A telemetry frame of the current state. `contacts: false` leaves out the
 * contact list (an empty array), which is most of the cost and the size.
 */
const buildHistoryEntry = (aeroDiagnostics: Record<string, AeroDiagnostic>, opts: { contacts?: boolean } = {}): HistoryEntry => {
  const mdl = model!;
  const dat = data!;
  const bodies: Record<string, BodyHistory> = {};
  const joints: Record<string, JointHistory> = {};
  const views = velocityViews(mdl, dat);
  const collectNodeData = (nodesList: SceneNode[]) => {
    if (!nodesList || !dat || !mdl) return;
    for (const node of nodesList) {
      const bId = bodyIdCache[node.id];
      if (bId !== undefined) {
        // Views taken once for this body, as in executeScripts.
        const xfrc = dat.xfrc_applied;
        const xpos = dat.xpos;
        const xquat = dat.xquat;
        // vel: world-frame velocity of the point `pos` is (the body origin);
        // angvel: world-frame ω. See bodyKinematics.ts.
        bodies[node.id] = {
          pos: [xpos[bId * 3], xpos[bId * 3 + 1], xpos[bId * 3 + 2]],
          vel: bodyPointVelocity(views, bId), angvel: bodyAngularVelocity(views, bId),
          quat: [xquat[bId * 4], xquat[bId * 4 + 1], xquat[bId * 4 + 2], xquat[bId * 4 + 3]],
          xfrc_applied: [
            xfrc[bId * 6 + 0], xfrc[bId * 6 + 1], xfrc[bId * 6 + 2],
            xfrc[bId * 6 + 3], xfrc[bId * 6 + 4], xfrc[bId * 6 + 5],
          ],
        };
      }
      if (node.children) collectNodeData(node.children);
    }
  };
  collectNodeData(sceneGraph.nodes);
  // Every joint at its full width (a free joint's 7/6, a ball's 4/3), with
  // its actuator's control and force: see readJoint.
  if (jointInfos.length) {
    const views = jointViews(dat);
    for (const j of jointInfos) joints[j.name] = readJoint(j, views);
  }

  const contacts: ContactHistory[] = [];
  if (opts.contacts === false) return { time: dat.time, bodies, joints, contacts, aeroDiagnostics };
  // `dat.contact` is not a view. Every read of the property has the bindings
  // copy the whole contact array into a fresh std::vector on the wasm heap and
  // hand back a handle that has to be delete()d — exactly like the per-contact
  // objects below, which always were. Reading it once per contact, as this
  // used to, allocated (1 + ncon) copies of ncon contacts every tenth step and
  // freed none of them: a stress scene with a few hundred contacts leaked the
  // heap to its 2 GB ceiling every couple of seconds, aborted, and the
  // "seamless" respawn made it look like a pause. Read once, delete once.
  const contactVec = dat.contact;
  try {
    const ncon = contactVec.size();
    for (let c = 0; c < ncon; c++) {
      const contact = contactVec.get(c);
      if (contact) {
        // A cloth side has no geom (-1); it is named for the cloth's vertex body.
        const geomOf = (g: number, side: 0 | 1) => (g >= 0 ? geomNameCache[g] ?? `geom_${g}` : sensorNames.bodyNode(contactBody(mdl, contact, side)));
        contacts.push({
          geom1: geomOf(contact.geom1, 0), geom2: geomOf(contact.geom2, 1), dist: contact.dist,
          // Whose geoms they are, so a `bodies` filter can keep a body's contacts.
          body1: sensorNames.bodyNode(contactBody(mdl, contact, 0)), body2: sensorNames.bodyNode(contactBody(mdl, contact, 1)),
        });
        contact.delete();
      }
    }
  } finally {
    contactVec.delete();
  }

  return { time: dat.time, bodies, joints, contacts, aeroDiagnostics };
};

let envWindX = 0;
let envWindY = 0;
let envWindGusting = false;
let envDensity = 0;
let envWaterLevel: number | null = null;
let envWaterBasins: WaterBasinWorld[] = [];
let magnetBodies: MagnetBody[] = [];
let soundEnabled = false;

interface BistableJointEntry {
  dofAdr: number;
  qposAdr: number;
  bodyId: number;
  spec: FlexureSpec;
}

interface JointStopWatch {
  qposAdrs: number[];
  dofAdrs: number[];
  isSlide: boolean;
  lo: number;
  hi: number;
  movingNodeId: string;
  movingBodyId: number;
  upperStopNodeId: string;
  hostNodeId: string;
  leverM: number;
  dampingScale: number;
  state: 0 | 1 | 2;
  initialized: boolean;
  prevVel: number;
}

interface BluffBodyAeroEntry {
  nodeId: string;
  areaM2: number;
  chordM: number;
  thicknessM: number;
  sigmaKgM2: number;
  isAeolian?: boolean;
}

let cachedHydroByNodeId = new Map<string, HydroBodyModel>();
let hydroByBodyId = new Map<number, HydroBodyModel>();
let bistableJoints: BistableJointEntry[] = [];
let jointStopWatches: JointStopWatch[] = [];
let dofForceScale: Float64Array | null = null;
let acousticStringBodyIds = new Set<number>();
let acousticStringAxisByBodyId = new Map<number, [number, number, number]>();
let acousticStringSpanByBodyId = new Map<
  number,
  { p0: [number, number, number]; ax: [number, number, number]; len: number }
>();
let acousticBowBodyIds = new Set<number>();
let acousticBowSpecByBodyId = new Map<number, AcousticBowSpec>();
let distinctAcousticChildBodyIds = new Set<number>();
let windSubtreeBodyIds = new Set<number>();
let bodyRoughnessByBodyId: Float64Array | null = null;
let bodySoftnessByBodyId: Float64Array | null = null;
let rimCapableBodyIds = new Set<number>();
let geomRollingRadius: Float64Array | null = null;
let aeroCoveredBodyIds = new Set<number>();
let bluffBodyAeroByBodyId = new Map<number, BluffBodyAeroEntry>();

const bowContactStartSimTime = new Map<string, number>();
const recentStopByStringBody = new Map<number, { frac: number; atSimTime: number }>();
const recentBowEvents = new Map<string, { event: BowedStringContactEvent; atSimTime: number }>();
const prevActiveStringsByBow = new Map<string, Set<string>>();
const recentPluckTouchSite = new Map<
  number,
  { otherBodyId: number; selfGeom: number; otherGeom: number; worldPos: [number, number, number]; atSimTime: number }
>();
const continuousPairStartSimTime = new Map<string, number>();
const lastNodeStrikeSimTime = new Map<string, number>();
let lastBowEmitMs = 0;
let hadActiveBowedStrings = false;
let hadActiveFrictionContacts = false;
let hadActiveDampingContacts = false;
let prevConstraintDof: Float64Array | null = null;
let prevStringVelDof: Float64Array | null = null;
const pendingAudioImpacts = new Map<string, AudioImpactEvent & { solTime?: number }>();
const lastAudioEmitSim = new Map<string, { atSimTime: number; impulseNs: number }>();

interface AeroBladeEntry {
  nodeId: string;
  bodyId: number;
  areaM2: number;
  chordM: number;
  thicknessM: number;
  tipRadiusM: number;
  arealDensityKgM2: number;
  hingeDofAdr: number;
}

interface AeroVoiceGroup {
  id: string;
  hubBodyId: number;
  hubJointDofAdr: number;
  bladeCount: number;
  isCloth: boolean;
  blades: AeroBladeEntry[];
  compositeBodyIds: number[];
  compositeDofAdrs: number[];
  compositeElementAreaM2: number;
  compositeThicknessM: number;
  compositeArealDensityKgM2: number;
  // Preallocated per-step accumulators (zero GC churn inside executeScripts!)
  accForceSum: number;
  accRelSpeedSum: number;
  accTipSpeedMax: number;
  accAlphaWeightedSum: number;
  accAreaSum: number;
  accActiveCount: number;
}

interface ClothTrailingEdgeWatch {
  nodeId: string;
  bodyId: number;
  normalLocal: [number, number, number];
  arealDensityKgM2: number;
  prevNormalVel: number;
  prevSpeedSq: number;
  prevConstraintMag: number;
  constraintDofAdrs: number[];
  initialized: boolean;
  lastSnapSimTime: number;
}

let aeroVoiceGroups: AeroVoiceGroup[] = [];
let aeroBladeGroupByNodeId = new Map<string, { group: AeroVoiceGroup; blade: AeroBladeEntry }>();
let clothTrailingWatches: ClothTrailingEdgeWatch[] = [];
const pendingAeroSnaps = new Map<string, AeroSnapEvent>();
let lastAeroEmitMs = 0;
let hadActiveAeroVoices = false;

const SOFTNESS_BY_MATERIAL: Record<string, number> = {
  rubber: 0.92,
  plastic: 0.58,
  pasta: 0.24,
  softwood: 0.20,
  hardwood: 0.16,
  stone: 0.14,
  ceramic: 0.10,
  softMetal: 0.08,
  glass: 0.06,
  steel: 0.05,
};

const rebuildHydroAndFlexureCaches = (
  explicitHydroModels?: HydroBodyModel[],
  activeWaterLevel: number | null = envWaterLevel,
  activeWaterBasins: WaterBasinWorld[] = envWaterBasins,
) => {
  if (explicitHydroModels) {
    cachedHydroByNodeId = new Map(explicitHydroModels.map((h) => [h.nodeId, h]));
  }
  hydroByBodyId = new Map();
  bistableJoints = [];
  jointStopWatches = [];
  dofForceScale = null;
  acousticStringBodyIds = new Set();
  acousticStringAxisByBodyId = new Map();
  acousticStringSpanByBodyId = new Map();
  acousticBowBodyIds = new Set();
  acousticBowSpecByBodyId = new Map();
  distinctAcousticChildBodyIds = new Set();
  windSubtreeBodyIds = new Set();
  bodyRoughnessByBodyId = null;
  bodySoftnessByBodyId = null;
  rimCapableBodyIds = new Set();
  geomRollingRadius = null;
  aeroCoveredBodyIds = new Set();
  bluffBodyAeroByBodyId = new Map();
  bowContactStartSimTime.clear();
  recentStopByStringBody.clear();
  recentBowEvents.clear();
  prevActiveStringsByBow.clear();
  recentPluckTouchSite.clear();
  continuousPairStartSimTime.clear();
  lastNodeStrikeSimTime.clear();
  prevConstraintDof = null;
  prevStringVelDof = null;
  aeroVoiceGroups = [];
  aeroBladeGroupByNodeId = new Map();
  clothTrailingWatches = [];
  pendingAeroSnaps.clear();
  const mdl = model;
  if (!mdl) return;

  const anyWater = activeWaterLevel !== null || activeWaterBasins.length > 0;
  const nbody = mdl.nbody;
  const ngeom = mdl.ngeom;
  bodyRoughnessByBodyId = new Float64Array(nbody);
  bodyRoughnessByBodyId.fill(0.35);
  bodyRoughnessByBodyId[0] = 0.42; // mineral floor
  bodySoftnessByBodyId = new Float64Array(nbody);
  bodySoftnessByBodyId.fill(0.24);
  bodySoftnessByBodyId[0] = 0.14;

  // Precompute rolling curvature radius for sphere (2), capsule (3), ellipsoid (4), cylinder (5) geoms
  geomRollingRadius = new Float64Array(ngeom);
  const gTypes = mdl.geom_type;
  const gSizes = mdl.geom_size;
  for (let g = 0; g < ngeom; g++) {
    const gt = gTypes[g];
    const r0 = gSizes[g * 3] ?? 0;
    if (gt === 2 || gt === 3 || gt === 4 || gt === 5) {
      geomRollingRadius[g] = Math.max(0, r0);
    }
  }

  const jntPos = mdl.jnt_pos;
  const bodyIpos = mdl.body_ipos;
  const bodyParent = mdl.body_parentid;
  const bodyJntNum = mdl.body_jntnum;
  const bodyPos = mdl.body_pos;
  const bodyMass = mdl.body_mass;

  const computeHingeComLever = (jId: number): number => {
    const bRoot = mdl.jnt_bodyid[jId];
    const jx = jntPos[jId * 3], jy = jntPos[jId * 3 + 1], jz = jntPos[jId * 3 + 2];
    let mSum = Math.max(0, bodyMass[bRoot] ?? 0);
    let cx = mSum * (bodyIpos[bRoot * 3] ?? 0);
    let cy = mSum * (bodyIpos[bRoot * 3 + 1] ?? 0);
    let cz = mSum * (bodyIpos[bRoot * 3 + 2] ?? 0);
    for (let b = bRoot + 1; b < nbody; b++) {
      let cur = b;
      let ox = 0, oy = 0, oz = 0;
      while (cur > bRoot && bodyJntNum[cur] === 0) {
        ox += bodyPos[cur * 3] ?? 0;
        oy += bodyPos[cur * 3 + 1] ?? 0;
        oz += bodyPos[cur * 3 + 2] ?? 0;
        cur = bodyParent[cur];
      }
      if (cur === bRoot) {
        const mb = Math.max(0, bodyMass[b] ?? 0);
        mSum += mb;
        cx += mb * (ox + (bodyIpos[b * 3] ?? 0));
        cy += mb * (oy + (bodyIpos[b * 3 + 1] ?? 0));
        cz += mb * (oz + (bodyIpos[b * 3 + 2] ?? 0));
      }
    }
    return mSum > 1e-6
      ? Math.max(0.025, Math.min(0.80, Math.hypot(cx / mSum - jx, cy / mSum - jy, cz / mSum - jz)))
      : 0.14;
  };

  const nodeHasCollidableSolid = (n: SceneNode): boolean => {
    for (const g of n.geoms ?? []) {
      if (!g.csgDerived && g.csg !== 'difference' && g.role !== 'visual' && g.type !== 'plane') {
        if (!(g.contype === 0 && g.conaffinity === 0)) return true;
      }
    }
    for (const ch of n.children ?? []) {
      if ((ch.joints?.length ?? 0) === 0 && !ch.acousticString && !ch.simulation && nodeHasCollidableSolid(ch)) {
        return true;
      }
    }
    return false;
  };

  const weldedRiderByTarget = new Map<string, SceneNode>();
  const collectWelds = (nodes: SceneNode[]) => {
    for (const n of nodes || []) {
      if (n.weldTargetId && nodeHasCollidableSolid(n)) {
        weldedRiderByTarget.set(n.weldTargetId, n);
      }
      if (n.children?.length) collectWelds(n.children);
    }
  };
  collectWelds(sceneGraph.nodes);

  const walk = (
    nodes: SceneNode[],
    insideWind = false,
    collidableHostId?: string,
    inheritedBow?: AcousticBowSpec,
  ) => {
    for (const node of nodes || []) {
      const nextWind = insideWind || !!node.windInstrument;
      const activeBow = node.acousticBow ?? inheritedBow;
      const nodeIsCollidable = nodeHasCollidableSolid(node);
      const bId = bodyIdCache[node.id];
      if (bId !== undefined && bId > 0) {
        if (nextWind) windSubtreeBodyIds.add(bId);
        if (
          typeof node.tunedPitchHz === 'number' ||
          node.acousticString ||
          node.acousticMembrane ||
          node.nonlinearPlate ||
          node.resonatorTube
        ) {
          distinctAcousticChildBodyIds.add(bId);
        }
        if (activeBow) {
          acousticBowBodyIds.add(bId);
          acousticBowSpecByBodyId.set(bId, activeBow);
        }
        if (bodyRoughnessByBodyId && bId < nbody) {
          bodyRoughnessByBodyId[bId] = inferSurfaceRoughness(node);
        }
        if (bodySoftnessByBodyId && bId < nbody) {
          let soft = node.deformMaterial ? (SOFTNESS_BY_MATERIAL[node.deformMaterial] ?? 0.24) : 0.24;
          const firstG = (node.geoms ?? []).find((g) => !g.csgDerived && g.csg !== 'difference');
          const solT = firstG?.solref?.[0];
          if (typeof solT === 'number' && solT >= 0.015) {
            soft = Math.max(soft, Math.min(0.95, 0.45 + solT * 8.0));
          }
          bodySoftnessByBodyId[bId] = soft;

          // Detect hollow/axisymmetric high-Q shells/cups/bells/goblets capable of singing when rubbed on the rim!
          const hasDifferenceCut = (node.geoms ?? []).some((g) => g.csg === 'difference');
          const isAxisymGeom = (node.geoms ?? []).some(
            (g) => g.type === 'cylinder' || g.type === 'mesh' || g.type === 'ellipsoid',
          );
          const isSingingMat =
            node.deformMaterial === 'glass' ||
            node.deformMaterial === 'ceramic' ||
            node.deformMaterial === 'softMetal' ||
            node.deformMaterial === 'steel';
          if (isSingingMat && (node.isTube || node.isTorus || hasDifferenceCut || isAxisymGeom)) {
            rimCapableBodyIds.add(bId);
          }
        }
        if (node.acousticString) {
          acousticStringBodyIds.add(bId);
          const span = inferStringLocalSpan(node);
          acousticStringAxisByBodyId.set(bId, span.ax);
          acousticStringSpanByBodyId.set(bId, span);
        }
        // Movable body (has own joints or rides on a jointed ancestor)
        if (anyWater && (node.joints?.length ?? 0) > 0) {
          const h = cachedHydroByNodeId.get(node.id) ?? buildHydroBodyModel(node);
          if (h) {
            hydroByBodyId.set(bId, h);
            pendingWake.add(bId);
          }
        }
        if (node.flexure?.kind === 'bistable') {
          const slide = (node.joints || []).find((j) => j.type === 'slide');
          const jId = slide ? jointIdCache[slide.name] : undefined;
          if (jId !== undefined) {
            bistableJoints.push({
              dofAdr: mdl.jnt_dofadr[jId],
              qposAdr: mdl.jnt_qposadr[jId],
              bodyId: bId,
              spec: node.flexure,
            });
          }
        }
      }

      // Build mechanical end-stop audio watches for limited slide/hinge joints & telescopic drawer runners
      if (!nextWind && !node.acousticString) {
        if (node.hardwarePart?.kind === 'drawer_runner' && !node.hardwarePart.piece) {
          const middle = node.children?.[0];
          const carriage = middle?.children?.[0];
          if (middle && carriage && !middle.coupleTargetId && !carriage.coupleTargetId) {
            const j1 = middle.joints?.[0] ? jointIdCache[middle.joints[0].name] : undefined;
            const j2 = carriage.joints?.[0] ? jointIdCache[carriage.joints[0].name] : undefined;
            const rider = weldedRiderByTarget.get(carriage.id);
            const movingBodyId = rider ? bodyIdCache[rider.id] : undefined;
            if (
              j1 !== undefined &&
              j2 !== undefined &&
              rider &&
              movingBodyId !== undefined &&
              movingBodyId > 0 &&
              mdl.jnt_limited[j1] &&
              mdl.jnt_limited[j2]
            ) {
              jointStopWatches.push({
                qposAdrs: [mdl.jnt_qposadr[j1], mdl.jnt_qposadr[j2]],
                dofAdrs: [mdl.jnt_dofadr[j1], mdl.jnt_dofadr[j2]],
                isSlide: true,
                lo: mdl.jnt_range[j1 * 2] + mdl.jnt_range[j2 * 2],
                hi: mdl.jnt_range[j1 * 2 + 1] + mdl.jnt_range[j2 * 2 + 1],
                movingNodeId: rider.id,
                movingBodyId,
                upperStopNodeId: carriage.id,
                hostNodeId: collidableHostId ?? 'world',
                leverM: 1.0,
                dampingScale: 1.0,
                state: 0,
                initialized: false,
                prevVel: 0,
              });
            }
          }
          continue;
        }

        if (!node.coupleTargetId) {
          for (const j of node.joints ?? []) {
            if (j.type !== 'slide' && j.type !== 'hinge') continue;
            const jId = jointIdCache[j.name];
            if (jId === undefined || !mdl.jnt_limited[jId]) continue;
            const lo = mdl.jnt_range[jId * 2];
            const hi = mdl.jnt_range[jId * 2 + 1];
            const isSlide = j.type === 'slide';
            if (hi - lo < (isSlide ? 0.012 : 0.15)) continue;
            const rider = nodeIsCollidable ? node : weldedRiderByTarget.get(node.id);
            const movingBodyId = rider ? bodyIdCache[rider.id] : undefined;
            if (!rider || movingBodyId === undefined || movingBodyId <= 0) continue;

            // Suppress rigid end-stop clacks on joints explicitly marked `hardStop: false` or heavily overdamped dashpots
            const approxMass = Math.max(0.05, bodyMass[movingBodyId] ?? 0.25);
            const jDamp = j.damping ?? 0;
            const dampPerKg = jDamp / approxMass;
            if (j.hardStop === false || dampPerKg > 45 || (!j.hardStop && jDamp > 25)) continue;
            const dampingScale = dampPerKg > 15 ? Math.max(0.15, 1 - (dampPerKg - 15) / 35) : 1.0;

            jointStopWatches.push({
              qposAdrs: [mdl.jnt_qposadr[jId]],
              dofAdrs: [mdl.jnt_dofadr[jId]],
              isSlide,
              lo,
              hi,
              movingNodeId: rider.id,
              movingBodyId,
              upperStopNodeId: collidableHostId ?? 'world',
              hostNodeId: collidableHostId ?? 'world',
              leverM: isSlide ? 1.0 : computeHingeComLever(jId),
              dampingScale,
              state: 0,
              initialized: false,
              prevVel: 0,
            });
          }
        }
      }

      const nextHostId = nodeIsCollidable ? node.id : collidableHostId;
      if (node.children?.length) walk(node.children, nextWind, nextHostId, activeBow);
    }
  };
  walk(sceneGraph.nodes);

  // Convert rotational DOF torques (N·m on hinge/ball joints, e.g. Newton's Cradle pendulums)
  // to equivalent linear contact force (N = τ / r_lever) so soft/hinged collisions scale accurately!
  const nv = mdl.nv;
  dofForceScale = new Float64Array(nv);
  dofForceScale.fill(1.0);
  const jntType = mdl.jnt_type;
  const jntDofAdr = mdl.jnt_dofadr;
  for (let j = 0; j < mdl.njnt; j++) {
    const jt = jntType[j];
    const d0 = jntDofAdr[j];
    if (jt === 0) {
      // mjJNT_FREE: DOFs 0..2 are linear forces (N), DOFs 3..5 are torques (avoid double-counting!)
      if (d0 + 5 < nv) {
        dofForceScale[d0 + 3] = 0;
        dofForceScale[d0 + 4] = 0;
        dofForceScale[d0 + 5] = 0;
      }
    } else if (jt === 1 || jt === 3) {
      // mjJNT_BALL (3 DOFs) or mjJNT_HINGE (1 DOF): compute mass-weighted COM lever arm from joint anchor!
      const leverM = Math.max(0.05, Math.min(0.60, computeHingeComLever(j)));
      const invLever = 1 / leverM;
      const count = jt === 1 ? 3 : 1;
      for (let k = 0; k < count && d0 + k < nv; k++) {
        dofForceScale[d0 + k] = invLever;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Build Aeroacoustic Voice Groups & Cloth Trailing-Edge Snap Watches
  // -------------------------------------------------------------------------
  const mj = mujoco!;
  const hubGroups = new Map<string, AeroVoiceGroup>();
  const bodyMassArr = mdl.body_mass;
  const geomSizeArr = mdl.geom_size;

  const estimateBladeMetrics = (node: SceneNode, bId: number): {
    areaM2: number;
    chordM: number;
    thicknessM: number;
    tipRadiusM: number;
    arealDensityKgM2: number;
  } => {
    const geom = node.geoms?.[0];
    const s = geom?.size ?? [];
    const halfX = s[0] || 0.05;
    const halfY = s[1] || halfX;
    const halfZ = s[2] || 0.002;
    const dims = [halfX * 2, halfY * 2, halfZ * 2].sort((a, b) => a - b);
    const thicknessM = Math.max(0.0005, dims[0]);
    const chordM = Math.max(0.006, halfX * 2);
    const spanM = Math.max(0.008, halfY * 2);
    const areaM2 = Math.max(1e-5, chordM * spanM);
    const gp = geom?.pos ?? [0, 0, 0];
    const np = node.pos ?? [0, 0, 0];
    const centerRad = Math.hypot(np[0] + (gp[0] || 0), np[1] + (gp[1] || 0), np[2] + (gp[2] || 0));
    const tipRadiusM = Math.max(0.015, centerRad + Math.max(halfX, halfY));
    const mKg = Math.max(0.0002, bodyMassArr[bId] || geom?.mass || areaM2 * thicknessM * (node.density ?? geom?.density ?? 650));
    const arealDensityKgM2 = Math.max(0.02, Math.min(2.5, mKg / areaM2));
    return { areaM2, chordM, thicknessM, tipRadiusM, arealDensityKgM2 };
  };

  interface AncestorChainItem {
    node: SceneNode;
    bodyId: number;
    hingeDofAdr: number;
    hasFreeOrSlide: boolean;
  }

  const aeroNodesWithChain: { node: SceneNode; bId: number; chain: AncestorChainItem[] }[] = [];
  const compositeNodes: SceneNode[] = [];

  const gatherAeroTree = (list: SceneNode[], chain: AncestorChainItem[]) => {
    for (const n of list || []) {
      if (n.isComposite) {
        compositeNodes.push(n);
      }
      const bId = bodyIdCache[n.id] ?? bodyIdCache[n.name] ?? -1;
      let hingeDofAdr = -1;
      let hasFreeOrSlide = false;
      for (const j of n.joints ?? []) {
        if (j.type === 'free' || j.type === 'slide') hasFreeOrSlide = true;
        if (j.type === 'hinge' && hingeDofAdr === -1) {
          const jId = jointIdCache[j.name];
          if (jId !== undefined) hingeDofAdr = mdl.jnt_dofadr[jId];
        }
      }
      const nextChain = bId > 0 ? [...chain, { node: n, bodyId: bId, hingeDofAdr, hasFreeOrSlide }] : chain;
      if (n.isAerodynamic && bId > 0) {
        aeroNodesWithChain.push({ node: n, bId, chain: nextChain });
      }
      if (n.children?.length) gatherAeroTree(n.children, nextChain);
    }
  };
  gatherAeroTree(sceneGraph.nodes, []);

  // Identify articulated membrane/flag chains (parent AND child both `isAerodynamic` connected by hinges!)
  const aeroNodeIdSet = new Set(aeroNodesWithChain.map((x) => x.node.id));
  const membraneRootByNodeId = new Map<string, AncestorChainItem>();
  for (const item of aeroNodesWithChain) {
    // Check if an ancestor in the chain is ALSO `isAerodynamic` with hinged links (an articulated flag/ribbon!)
    let topAero: AncestorChainItem | null = null;
    let hingedCount = 0;
    for (const anc of item.chain) {
      if (aeroNodeIdSet.has(anc.node.id)) {
        if (!topAero) topAero = anc;
        if (anc.hingeDofAdr >= 0) hingedCount++;
      }
    }
    if (topAero && topAero.node.id !== item.node.id && hingedCount >= 1) {
      membraneRootByNodeId.set(item.node.id, topAero);
      membraneRootByNodeId.set(topAero.node.id, topAero);
    }
  }

  for (const { node, bId, chain } of aeroNodesWithChain) {
    const selfItem = chain[chain.length - 1];
    const metrics = estimateBladeMetrics(node, bId);

    // Case 1: Articulated aerodynamic cloth/flag strip chain
    const memRoot = membraneRootByNodeId.get(node.id);
    if (memRoot) {
      const gid = memRoot.node.id;
      let grp = hubGroups.get(gid);
      if (!grp) {
        grp = {
          id: gid,
          hubBodyId: memRoot.bodyId,
          hubJointDofAdr: -1,
          bladeCount: 0,
          isCloth: true,
          blades: [],
          compositeBodyIds: [],
          compositeDofAdrs: [],
          compositeElementAreaM2: 0,
          compositeThicknessM: metrics.thicknessM,
          compositeArealDensityKgM2: metrics.arealDensityKgM2,
          accForceSum: 0,
          accRelSpeedSum: 0,
          accTipSpeedMax: 0,
          accAlphaWeightedSum: 0,
          accAreaSum: 0,
          accActiveCount: 0,
        };
        hubGroups.set(gid, grp);
        aeroVoiceGroups.push(grp);
      }
      const bladeEntry: AeroBladeEntry = {
        nodeId: node.id,
        bodyId: bId,
        ...metrics,
        hingeDofAdr: selfItem?.hingeDofAdr ?? -1,
      };
      grp.blades.push(bladeEntry);
      aeroBladeGroupByNodeId.set(node.id, { group: grp, blade: bladeEntry });

      // Free trailing edge of an articulated flag/strip: no aerodynamic children below this node!
      const hasAeroChild = (node.children ?? []).some((ch) => aeroNodeIdSet.has(ch.id));
      if (!hasAeroChild && selfItem && selfItem.hingeDofAdr >= 0) {
        const dAdrs: number[] = [];
        for (const anc of chain) {
          if (anc.hingeDofAdr >= 0) dAdrs.push(anc.hingeDofAdr);
        }
        clothTrailingWatches.push({
          nodeId: node.id,
          bodyId: bId,
          normalLocal: [0, 0, 1],
          arealDensityKgM2: metrics.arealDensityKgM2,
          prevNormalVel: 0,
          prevSpeedSq: 0,
          prevConstraintMag: 0,
          constraintDofAdrs: dAdrs,
          initialized: false,
          lastSnapSimTime: -1,
        });
      }
      continue;
    }

    // Case 2: Nearest rotating parent hinge hub (e.g. `rotor1..4` with B=2, `windmill` rotor with B=3)
    // Walk strictly up ancestors (excluding self if self is a free-flying wing like `paper_plane_wing`!)
    let hubAncestor: AncestorChainItem | null = null;
    for (let k = chain.length - 2; k >= 0; k--) {
      const anc = chain[k];
      if (anc.hingeDofAdr >= 0 && !anc.hasFreeOrSlide) {
        // Skip nacelle yaw hinges if there is no direct blade relationship: check that node itself has no joint of its own
        // OR is directly mounted on the rotating hub (e.g. `rotor1 -> r1_b1`, `rotor -> blade1`)
        if ((selfItem?.hingeDofAdr ?? -1) === -1) {
          hubAncestor = anc;
          break;
        }
      }
      if (anc.hasFreeOrSlide) break;
    }
    // Note: `tail_vane` on `windmill` is mounted under `nacelle` (`yaw_hinge`), NOT `rotor` (`rotor_hinge`).
    // A yaw vane has 1 fin (`B = 1` with slow/zero yaw), whereas a true rotor hub either has `B >= 2` blades
    // OR an actuated/spinning shaft. We group by `hubAncestor` first and finalize `bladeCount` right after!
    if (hubAncestor) {
      // Compute radial tip distance relative to the hub body's frame
      let rx = 0, ry = 0, rz = 0;
      for (let k = chain.indexOf(hubAncestor) + 1; k < chain.length; k++) {
        const np = chain[k].node.pos ?? [0, 0, 0];
        rx += np[0] || 0;
        ry += np[1] || 0;
        rz += np[2] || 0;
      }
      const gp = node.geoms?.[0]?.pos ?? [0, 0, 0];
      const gs = node.geoms?.[0]?.size ?? [0.03, 0.1];
      const hubTipR = Math.max(
        0.02,
        Math.hypot(rx + (gp[0] || 0), ry + (gp[1] || 0), rz + (gp[2] || 0)) + Math.max(gs[0] || 0, gs[1] || 0),
      );
      const gid = hubAncestor.node.id;
      let grp = hubGroups.get(gid);
      if (!grp) {
        grp = {
          id: gid,
          hubBodyId: hubAncestor.bodyId,
          hubJointDofAdr: hubAncestor.hingeDofAdr,
          bladeCount: 0,
          isCloth: false,
          blades: [],
          compositeBodyIds: [],
          compositeDofAdrs: [],
          compositeElementAreaM2: 0,
          compositeThicknessM: metrics.thicknessM,
          compositeArealDensityKgM2: metrics.arealDensityKgM2,
          accForceSum: 0,
          accRelSpeedSum: 0,
          accTipSpeedMax: 0,
          accAlphaWeightedSum: 0,
          accAreaSum: 0,
          accActiveCount: 0,
        };
        hubGroups.set(gid, grp);
        aeroVoiceGroups.push(grp);
      }
      const bladeEntry: AeroBladeEntry = {
        nodeId: node.id,
        bodyId: bId,
        ...metrics,
        tipRadiusM: hubTipR,
        hingeDofAdr: -1,
      };
      grp.blades.push(bladeEntry);
      aeroBladeGroupByNodeId.set(node.id, { group: grp, blade: bladeEntry });
    } else {
      // Case 3: Standalone wing / airframe surface (e.g. `paper_plane_wing` + welded elevons share root moving body `pId`!):
      // Weight chord proportionally, or keep primary lifting wing's chord so Strouhal `c * |sin(alpha)|` matches the wing chord!
      let pId = bId;
      while (pId > 0 && mdl.body_dofnum[pId] === 0) {
        pId = bodyParent[pId];
      }
      const ownerId = (pId > 0 ? bodyNodeById[pId] : undefined) ?? node.id;
      let grp = hubGroups.get(ownerId);
      if (!grp) {
        grp = {
          id: ownerId,
          hubBodyId: pId > 0 ? pId : bId,
          hubJointDofAdr: selfItem?.hingeDofAdr ?? -1,
          bladeCount: 0,
          isCloth: false,
          blades: [],
          compositeBodyIds: [],
          compositeDofAdrs: [],
          compositeElementAreaM2: 0,
          compositeThicknessM: metrics.thicknessM,
          compositeArealDensityKgM2: metrics.arealDensityKgM2,
          accForceSum: 0,
          accRelSpeedSum: 0,
          accTipSpeedMax: 0,
          accAlphaWeightedSum: 0,
          accAreaSum: 0,
          accActiveCount: 0,
        };
        hubGroups.set(ownerId, grp);
        aeroVoiceGroups.push(grp);
      }
      const bladeEntry: AeroBladeEntry = {
        nodeId: node.id,
        bodyId: bId,
        ...metrics,
        hingeDofAdr: -1,
      };
      grp.blades.push(bladeEntry);
      aeroBladeGroupByNodeId.set(node.id, { group: grp, blade: bladeEntry });
    }
  }

  // Finalize `bladeCount` on hub groups:
  // - Multi-blade hubs (`blades.length >= 2`, e.g. quadcopter B=2, windmill B=3) keep `bladeCount = blades.length`.
  // - Single-fin bodies on a slow/unactuated yaw hinge (e.g. `tail_vane` on `nacelle`) have `blades.length === 1`:
  //   treat as a translating/weathercocking vane (`bladeCount = 0`) unless that hinge has an actuator!
  for (const grp of aeroVoiceGroups) {
    if (grp.isCloth) {
      grp.bladeCount = 0;
    } else if (grp.hubJointDofAdr >= 0) {
      if (grp.blades.length >= 2) {
        grp.bladeCount = grp.blades.length;
      } else {
        const hasMotor = jointInfos.some((ji) => ji.dofadr === grp.hubJointDofAdr && ji.actuators.length > 0);
        grp.bladeCount = hasMotor ? 1 : 0;
      }
    }
  }

  // Also detect physics-only scripted multi-blade rotors (`traditionalWindmillPreset` / `physicsOnlyWindmillPreset`)
  // where `rotor` has a `rotor_hinge` and 3..4 `blade*` children whose sails aren't marked `isAerodynamic`:
  const scanScriptedRotors = (list: SceneNode[]) => {
    for (const n of list || []) {
      if (!hubGroups.has(n.id) && (n.joints?.length ?? 0) > 0 && (n.children?.length ?? 0) >= 2) {
        const hinge = n.joints.find((j) => j.type === 'hinge');
        const jId = hinge ? jointIdCache[hinge.name] : undefined;
        const hubBId = bodyIdCache[n.id] ?? bodyIdCache[n.name] ?? -1;
        const bladeKids = (n.children ?? []).filter(
          (ch) => (ch.joints?.length ?? 0) === 0 && (ch.geoms?.length ?? 0) > 0 && /blade|vane|prop|wing|sail/i.test(ch.name || ch.id),
        );
        if (jId !== undefined && hubBId > 0 && bladeKids.length >= 2) {
          const grp: AeroVoiceGroup = {
            id: n.id,
            hubBodyId: hubBId,
            hubJointDofAdr: mdl.jnt_dofadr[jId],
            bladeCount: bladeKids.length,
            isCloth: false,
            blades: [],
            compositeBodyIds: [],
            compositeDofAdrs: [],
            compositeElementAreaM2: 0,
            compositeThicknessM: 0.008,
            compositeArealDensityKgM2: 0.25,
            accForceSum: 0,
            accRelSpeedSum: 0,
            accTipSpeedMax: 0,
            accAlphaWeightedSum: 0,
            accAreaSum: 0,
            accActiveCount: 0,
          };
          for (const bk of bladeKids) {
            const bkId = bodyIdCache[bk.id] ?? bodyIdCache[bk.name] ?? hubBId;
            const m = estimateBladeMetrics(bk, bkId);
            const entry: AeroBladeEntry = { nodeId: bk.id, bodyId: bkId, ...m, hingeDofAdr: -1 };
            grp.blades.push(entry);
          }
          hubGroups.set(n.id, grp);
          aeroVoiceGroups.push(grp);
        }
      }
      if (n.children?.length) scanScriptedRotors(n.children);
    }
  };
  scanScriptedRotors(sceneGraph.nodes);

  // Case 4: MuJoCo `<composite>` (`grid` / `cloth` / unanchored aerodynamic `cable`)
  for (const comp of compositeNodes) {
    // A string: scenes saved when MuJoCo had grid and cloth composites still name them.
    const cType: string = comp.compositeType || 'cable';
    if (cType !== 'grid' && cType !== 'cloth' && !comp.isAerodynamic) continue;
    const prefix = comp.compositePrefix || `${comp.name || comp.id}_`;
    const compBodyIds: number[] = [];
    const compDofAdrs: number[] = [];
    for (let b = 1; b < mdl.nbody; b++) {
      const bName = mj.mj_id2name(mdl, mj.mjtObj.mjOBJ_BODY.value, b) || '';
      if (bName.startsWith(`${prefix}B`)) {
        compBodyIds.push(b);
        const dNum = mdl.body_dofnum[b];
        const dAdr = mdl.body_dofadr[b];
        for (let k = 0; k < dNum; k++) compDofAdrs.push(dAdr + k);
      }
    }
    if (compBodyIds.length === 0) continue;
    const counts = (comp.compositeCount || '6 6 1').trim().split(/\s+/).map(Number);
    const ny = Math.max(1, counts[1] || 1);
    const sizeParts = (comp.compositeSize || '0.4 0.3').trim().split(/\s+/).map(Number);
    const spanX = Math.max(0.05, sizeParts[0] || 0.4);
    const spanY = Math.max(0.02, sizeParts[1] || (ny > 1 ? spanX : 0.03));
    const totalArea = spanX * spanY;
    const elemArea = totalArea / Math.max(1, compBodyIds.length);
    const rGeom = comp.geoms?.[0]?.size?.[0] ?? (geomSizeArr[0] || 0.004);
    const totalMass = compBodyIds.reduce((s, id) => s + (bodyMassArr[id] || 0.005), 0);
    const sigma = Math.max(0.02, Math.min(1.5, totalMass / Math.max(1e-4, totalArea)));

    const grp: AeroVoiceGroup = {
      id: comp.id,
      hubBodyId: compBodyIds[0],
      hubJointDofAdr: -1,
      bladeCount: 0,
      isCloth: true,
      blades: [],
      compositeBodyIds: compBodyIds,
      compositeDofAdrs: compDofAdrs,
      compositeElementAreaM2: elemArea,
      compositeThicknessM: Math.max(0.001, rGeom * 2),
      compositeArealDensityKgM2: sigma,
      accForceSum: 0,
      accRelSpeedSum: 0,
      accTipSpeedMax: 0,
      accAlphaWeightedSum: 0,
      accAreaSum: 0,
      accActiveCount: 0,
    };
    aeroVoiceGroups.push(grp);

    // Watch trailing-edge / free corner body of the composite sheet/cable (unless welded at far end!)
    if (!comp.weldLastToId) {
      const tipBodyId = compBodyIds[compBodyIds.length - 1];
      clothTrailingWatches.push({
        nodeId: comp.id,
        bodyId: tipBodyId,
        normalLocal: [0, 0, 1],
        arealDensityKgM2: sigma,
        prevNormalVel: 0,
        prevSpeedSq: 0,
        prevConstraintMag: 0,
        constraintDofAdrs: compDofAdrs.slice(-6),
        initialized: false,
        lastSnapSimTime: -1,
      });
    }
  }

  // Record all bodies already represented by `aeroVoiceGroups` and build lightweight bluff-body
  // Strouhal whoosh metrics for fast-moving non-`isAerodynamic` dynamic bodies (pendulums, rods, projectiles)
  for (const grp of aeroVoiceGroups) {
    if (grp.hubBodyId > 0) aeroCoveredBodyIds.add(grp.hubBodyId);
    for (const bl of grp.blades) aeroCoveredBodyIds.add(bl.bodyId);
    for (const cb of grp.compositeBodyIds) aeroCoveredBodyIds.add(cb);
  }
  const bodyGeomAdr = mdl.body_geomadr;
  const bodyGeomNum = mdl.body_geomnum;
  const bodyDofNum = mdl.body_dofnum;
  for (let b = 1; b < nbody; b++) {
    if (aeroCoveredBodyIds.has(b) || acousticStringBodyIds.has(b) || windSubtreeBodyIds.has(b)) {
      continue;
    }
    const nodeId = bodyNodeById[b];
    if (!nodeId || nodeId === 'world') continue;
    const gStart = bodyGeomAdr[b] ?? 0;
    const gCount = bodyGeomNum[b] ?? 0;

    if (bodyDofNum[b] <= 0) {
      // Static slender cylindrical/capsule bodies (e.g. flagpoles, masts, halyards: L/D >= 6, D in [0.004, 0.16] m):
      // emit subtle high-Q Strouhal Aeolian vortex-shedding hum in wind >= 2.5 m/s!
      let minSlenderD = Infinity;
      let slenderAreaSum = 0;
      for (let k = 0; k < gCount; k++) {
        const g = gStart + k;
        const gt = gTypes[g];
        if (gt !== 3 && gt !== 5) continue; // capsule (3) or cylinder (5)
        const r = gSizes[g * 3] || 0;
        const halfLen = gSizes[g * 3 + 1] || 0;
        const diam = 2 * r;
        const fullLen = gt === 3 ? 2 * halfLen + diam : 2 * halfLen;
        if (diam >= 0.004 && diam <= 0.16 && fullLen / diam >= 6.0) {
          if (diam < minSlenderD) minSlenderD = diam;
          slenderAreaSum += diam * fullLen;
        }
      }
      if (Number.isFinite(minSlenderD) && slenderAreaSum > 1e-5) {
        const mKg = Math.max(0.02, bodyMass[b] || slenderAreaSum * minSlenderD * 2700);
        bluffBodyAeroByBodyId.set(b, {
          nodeId,
          areaM2: Math.min(2.0, slenderAreaSum),
          chordM: minSlenderD,
          thicknessM: minSlenderD,
          sigmaKgM2: Math.max(0.05, Math.min(2.5, mKg / Math.max(1e-4, slenderAreaSum))),
          isAeolian: true,
        });
      }
      continue;
    }

    let areaSum = 0;
    let minDim = Infinity;
    let maxDim = 0.03;
    for (let k = 0; k < gCount; k++) {
      const g = gStart + k;
      const gt = gTypes[g];
      if (gt === 0) continue; // plane
      const s0 = Math.max(0.002, gSizes[g * 3] || 0.02);
      const s1 = Math.max(0.002, gSizes[g * 3 + 1] || s0);
      const s2 = Math.max(0.002, gSizes[g * 3 + 2] || s0);
      const d0 = s0 * 2;
      const d1 = (gt === 2 ? s0 : s1) * 2;
      const d2 = (gt === 2 || gt === 3 || gt === 5 ? s0 : s2) * 2;
      const sorted = [d0, d1, d2].sort((a, c) => a - c);
      areaSum += sorted[1] * sorted[2] * 0.78;
      if (sorted[0] < minDim) minDim = sorted[0];
      if (sorted[2] > maxDim) maxDim = sorted[2];
    }
    if (areaSum > 1e-5) {
      const mKg = Math.max(0.005, bodyMass[b] || 0.1);
      bluffBodyAeroByBodyId.set(b, {
        nodeId,
        areaM2: Math.min(4.0, areaSum),
        chordM: Math.max(0.008, Math.min(1.5, maxDim * 0.5)),
        thicknessM: Number.isFinite(minDim) ? Math.max(0.002, minDim) : 0.015,
        sigmaKgM2: Math.max(0.05, Math.min(2.5, mKg / Math.max(1e-4, areaSum))),
      });
    }
  }
};

const applyHydroAndFlexureForces = (
  stepSize: number,
  activeWaterLevel: number | null = envWaterLevel,
  activeWaterBasins: WaterBasinWorld[] = envWaterBasins,
) => {
  const mdl = model;
  const dat = data;
  if (!mdl || !dat) return;

  if (bistableJoints.length > 0) {
    const qpos = dat.qpos;
    const qfrc = dat.qfrc_applied;
    for (const bj of bistableJoints) {
      const f = bistableForce(qpos[bj.qposAdr], bj.spec);
      if (Math.abs(f) > 1e-6) {
        qfrc[bj.dofAdr] += f;
        pendingWake.add(bj.bodyId);
      }
    }
  }

  if ((activeWaterLevel !== null || activeWaterBasins.length > 0) && hydroByBodyId.size > 0) {
    const xpos = dat.xpos;
    const xmat = dat.xmat;
    const xipos = dat.xipos;
    const xfrc = dat.xfrc_applied;
    const bodyMass = mdl.body_mass;
    const bodySubtreeMass = (mdl as unknown as { body_subtreemass?: ArrayLike<number> }).body_subtreemass;
    const bodyInertia = mdl.body_inertia;
    const views = velocityViews(mdl, dat);
    const gravityZ = modelOpt(mdl).gravityZ;

    for (const [bId, hydro] of hydroByBodyId) {
      const pOff = bId * 3;
      const pos = [xpos[pOff], xpos[pOff + 1], xpos[pOff + 2]];

      // Resolve enclosing container basin water surface Z (or fallback global waterLevel)
      let localWaterZ: number | null = activeWaterLevel;
      for (const basin of activeWaterBasins) {
        if (basin.containerNodeId === hydro.nodeId) continue;
        if (
          pointInsideWaterBasin(basin, pos[0], pos[1]) &&
          pos[2] >= basin.floorZ - 0.12
        ) {
          localWaterZ = localWaterZ === null ? basin.surfaceZ : Math.max(localWaterZ, basin.surfaceZ);
        }
      }
      if (localWaterZ === null) continue;

      const mOff = bId * 9;
      const mat = [
        xmat[mOff], xmat[mOff + 1], xmat[mOff + 2],
        xmat[mOff + 3], xmat[mOff + 4], xmat[mOff + 5],
        xmat[mOff + 6], xmat[mOff + 7], xmat[mOff + 8],
      ];
      const ipos = [xipos[pOff], xipos[pOff + 1], xipos[pOff + 2]];
      const velAtCom = bodyPointVelocity(views, bId, ipos);
      const angVel = bodyAngularVelocity(views, bId);
      const massKg = Math.max(bodyMass[bId] || 0, bodySubtreeMass?.[bId] || 0, 1e-4);
      const inertia = [bodyInertia[pOff], bodyInertia[pOff + 1], bodyInertia[pOff + 2]];
      const wrench = computeBuoyancyWrench(
        hydro,
        pos,
        mat,
        ipos,
        velAtCom,
        angVel,
        massKg,
        inertia,
        localWaterZ,
        gravityZ,
        stepSize,
      );
      if (wrench.submergedVolume > 1e-12) {
        const fOff = bId * 6;
        xfrc[fOff + 0] += wrench.force[0];
        xfrc[fOff + 1] += wrench.force[1];
        xfrc[fOff + 2] += wrench.force[2];
        xfrc[fOff + 3] += wrench.torque[0];
        xfrc[fOff + 4] += wrench.torque[1];
        xfrc[fOff + 5] += wrench.torque[2];
        pendingWake.add(bId);
      }
    }
  }
};

const resolveRigidOwnerBody = (
  rawB: number,
  bodyParent: ArrayLike<number>,
  bodyJntNum: ArrayLike<number>,
): number => {
  let cur = rawB;
  while (
    cur > 0 &&
    bodyJntNum[cur] === 0 &&
    bodyParent[cur] > 0 &&
    !distinctAcousticChildBodyIds.has(cur)
  ) {
    cur = bodyParent[cur];
  }
  return cur;
};

/**
 * Zero-copy modal audio impulse detector: reads `dat.qfrc_constraint` (never
 * `dat.contact`, which copies onto the WASM heap!) only when `soundEnabled` is on.
 */
const sampleAudioImpacts = (stepSize: number) => {
  if (!soundEnabled || !model || !data) return;
  const nv = model.nv;
  const simTime = data.time;
  const qfrcC = data.qfrc_constraint;
  const qvel = data.qvel;
  if (nv > 0 && (!prevConstraintDof || prevConstraintDof.length !== nv || !prevStringVelDof || prevStringVelDof.length !== nv)) {
    prevConstraintDof = Float64Array.from(qfrcC);
    prevStringVelDof = Float64Array.from(qvel);
    const qposInit = data.qpos;
    for (const w of jointStopWatches) {
      let q = 0;
      for (const qa of w.qposAdrs) q += qposInit[qa];
      let v = 0;
      for (const da of w.dofAdrs) v += qvel[da];
      const eps = w.isSlide ? 0.0022 : 0.020;
      w.state = q <= w.lo + eps ? 1 : q >= w.hi - eps ? 2 : 0;
      w.prevVel = v;
      w.initialized = true;
    }
    return;
  }
  if (nv === 0) return;

  // Mechanical end-stop impact detector for limited slide/hinge joints & telescopic drawer runners
  if (jointStopWatches.length > 0) {
    const qpos = data.qpos;
    for (const w of jointStopWatches) {
      let q = 0;
      for (const qa of w.qposAdrs) q += qpos[qa];
      let v = 0;
      for (const da of w.dofAdrs) v += qvel[da];
      const eps = w.isSlide ? 0.0022 : 0.020;
      const clearEps = w.isSlide ? 0.0060 : 0.045;
      if (!w.initialized) {
        w.state = q <= w.lo + eps ? 1 : q >= w.hi - eps ? 2 : 0;
        w.prevVel = v;
        w.initialized = true;
        continue;
      }
      const approachVel = w.prevVel;
      w.prevVel = v;
      if (w.state === 1 && q > w.lo + clearEps) w.state = 0;
      else if (w.state === 2 && q < w.hi - clearEps) w.state = 0;

      if (w.state === 0) {
        const minSpeed = w.isSlide ? 0.045 : 0.22;
        let hitStop: 0 | 1 | 2 = 0;
        if (q <= w.lo + eps && approachVel < -minSpeed) hitStop = 1;
        else if (q >= w.hi - eps && approachVel > minSpeed) hitStop = 2;
        if (hitStop !== 0) {
          w.state = hitStop;
          // Rigid assembly mass (own + equality welds) rather than loosely-hinged subtree!
          const mKg = Math.max(0.04, joinedMass(w.movingBodyId) || model.body_mass[w.movingBodyId] || 0.25);
          const linSpeed = w.isSlide ? Math.abs(approachVel) : Math.abs(approachVel) * w.leverM;
          const stopScale = (hitStop === 2 ? 0.15 : 0.20) * w.dampingScale;
          const stopImpulse = Math.min(0.28, stopScale * mKg * linSpeed);
          const otherId = hitStop === 2 ? w.upperStopNodeId : w.hostNodeId;
          const pairKey = `${w.movingNodeId}:${otherId}`;
          if (stopImpulse >= 0.003 && shouldEmitPairImpact(lastAudioEmitSim.get(pairKey), simTime, stopImpulse, 0.018)) {
            const prev = pendingAudioImpacts.get(pairKey);
            if (!prev || stopImpulse > prev.impulseNs) {
              pendingAudioImpacts.set(pairKey, {
                nodeId: w.movingNodeId,
                impulseNs: stopImpulse,
                otherNodeId: otherId,
                solTime: 0.018,
              });
            }
            // Subtle carcass knock when hitting a solid cabinet/frame host
            if (w.hostNodeId !== 'world' && w.hostNodeId !== w.movingNodeId) {
              const hostKey = `${w.hostNodeId}:${w.movingNodeId}`;
              const hostImpulse = stopImpulse * (hitStop === 1 ? 0.28 : 0.20);
              if (hostImpulse >= 0.002 && shouldEmitPairImpact(lastAudioEmitSim.get(hostKey), simTime, hostImpulse, 0.018)) {
                const prevHost = pendingAudioImpacts.get(hostKey);
                if (!prevHost || hostImpulse > prevHost.impulseNs) {
                  pendingAudioImpacts.set(hostKey, {
                    nodeId: w.hostNodeId,
                    impulseNs: hostImpulse,
                    otherNodeId: w.movingNodeId,
                    solTime: 0.018,
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  const dofBody = model.dof_bodyid;
  // Accumulate translational constraint force jump per body over this step
  const bodyJumpSq = new Map<number, number>();
  const stringPluckImpulse = new Map<number, number>();
  const newlyTouchedStrings: number[] = [];
  for (let d = 0; d < nv; d++) {
    const cur = qfrcC[d];
    const prev = prevConstraintDof![d];
    prevConstraintDof![d] = cur;
    const vCur = qvel[d];
    const vPrev = prevStringVelDof![d];
    prevStringVelDof![d] = vCur;
    const bId = dofBody[d];
    if (bId <= 0) continue;
    const isStr = acousticStringBodyIds.has(bId);
    if (isStr) {
      if (Math.abs(cur) >= 0.0005) {
        const cached = recentPluckTouchSite.get(bId);
        if (!cached || simTime - cached.atSimTime > 0.025) newlyTouchedStrings.push(bId);
      }
      const dv = Math.abs(vCur - vPrev);
      const isVelKick = dv >= 0.028 && (Math.abs(vCur) > Math.abs(vPrev) + 0.015 || vCur * vPrev < -0.0004);
      const df = Math.abs(cur - prev);
      if (!isVelKick && df < 0.008) continue;
      const estImpulse = Math.max(df * 0.18, Math.max(Math.abs(vCur), dv) * 0.065);
      if (estImpulse > (stringPluckImpulse.get(bId) ?? 0)) {
        stringPluckImpulse.set(bId, estImpulse);
      }
      bodyJumpSq.set(bId, (bodyJumpSq.get(bId) ?? 0) + df * df);
    } else {
      const fScale = dofForceScale ? dofForceScale[d] : 1.0;
      if (fScale <= 0) continue;
      const fCur = cur * fScale;
      const fPrev = prev * fScale;
      // Rigid bodies: only trigger on rising contact/constraint loading (or sign reversal), never unloading!
      const isLoading = Math.abs(fCur) > Math.abs(fPrev) + 0.25 || fCur * fPrev < -0.25;
      if (!isLoading) continue;
      const df = fCur - fPrev;
      if (Math.abs(df) < 0.25) continue;
      bodyJumpSq.set(bId, (bodyJumpSq.get(bId) ?? 0) + df * df);
    }
  }
  const newTriggers: { bId: number; nodeId: string; impulseNs: number }[] = [];
  for (const [bId, sumSq] of bodyJumpSq) {
    const rawImpulse = Math.sqrt(sumSq) * stepSize;
    const impulseNs = acousticStringBodyIds.has(bId)
      ? Math.max(rawImpulse, stringPluckImpulse.get(bId) ?? 0)
      : rawImpulse;
    if (impulseNs < 0.0015) continue;
    const nodeId = bodyNodeById[bId];
    if (!nodeId || nodeId === 'world') continue;
    newTriggers.push({ bId, nodeId, impulseNs });
  }
  if (newTriggers.length === 0 && newlyTouchedStrings.length === 0) return;

  // Read `dat.contact` once on this impact substep (and delete handles in `finally`)
  // to identify the colliding partner geom/body and local hit point for two-body Hertzian synthesis!
  const hitByBody = new Map<
    number,
    {
      otherBodyId: number;
      selfGeom: number;
      otherGeom: number;
      worldPos: [number, number, number];
      solTime: number;
      solDamp: number;
    }
  >();
  const suppressedBowImpactBodies = new Set<number>();
  const bodyParent = model.body_parentid;
  const bodyJntNum = model.body_jntnum;
  const contactVec = data.contact;
  try {
    const ncon = contactVec.size();
    const geomBody = ncon > 0 ? model.geom_bodyid : null;
    const geomSolref = ncon > 0 ? model.geom_solref : null;
    const geomFriction = ncon > 0 && acousticStringBodyIds.size > 0 ? model.geom_friction : null;
    if (geomBody) {
      const wanted = new Set([...newTriggers.map((t) => t.bId), ...newlyTouchedStrings]);
      for (let c = 0; c < ncon; c++) {
        const ct = contactVec.get(c);
        if (!ct) continue;
        try {
          const rawB1 = geomBody[ct.geom1];
          const rawB2 = geomBody[ct.geom2];
          const b1 = resolveRigidOwnerBody(rawB1, bodyParent, bodyJntNum);
          const b2 = resolveRigidOwnerBody(rawB2, bodyParent, bodyJntNum);
          if (!wanted.has(b1) && !wanted.has(b2)) continue;
          // Suppress percussive AUDIO_IMPACTS clicks/plucks on rosined, authored `acousticBow`, or damped bow-on-string contacts!
          if (geomSolref && geomFriction) {
            const isStr1 = acousticStringBodyIds.has(b1) || acousticStringBodyIds.has(rawB1);
            const isStr2 = acousticStringBodyIds.has(b2) || acousticStringBodyIds.has(rawB2);
            if (isStr1 !== isStr2) {
              const bStr = isStr1 ? (acousticStringBodyIds.has(rawB1) ? rawB1 : b1) : (acousticStringBodyIds.has(rawB2) ? rawB2 : b2);
              const bBow = isStr1 ? b2 : b1;
              const rawBow = isStr1 ? rawB2 : rawB1;
              const gBow = isStr1 ? ct.geom2 : ct.geom1;
              const muBow = geomFriction[gBow * 3] ?? 1.0;
              const bowSolTime = geomSolref[gBow * 2] ?? 0.02;
              const bowSolDamp = geomSolref[gBow * 2 + 1] ?? 1.0;
              const isExplicitBow = acousticBowBodyIds.has(bBow) || acousticBowBodyIds.has(rawBow);
              const isDampedBow =
                isExplicitBow ||
                ct.dim === 1 ||
                muBow < 0.02 ||
                (muBow >= 0.22 && bowSolDamp >= 0.95 && bowSolTime > 0 && bowSolTime <= 0.010);
              if (isDampedBow || bowContactStartSimTime.has(`${bStr}:${bBow}`) || bowContactStartSimTime.has(`${bStr}:${rawBow}`)) {
                suppressedBowImpactBodies.add(b1);
                suppressedBowImpactBodies.add(b2);
                continue;
              }
            }
          }
          const st1 = geomSolref ? (geomSolref[ct.geom1 * 2] ?? 0.004) : 0.004;
          const st2 = geomSolref ? (geomSolref[ct.geom2 * 2] ?? 0.004) : 0.004;
          const sd1 = geomSolref ? (geomSolref[ct.geom1 * 2 + 1] ?? 1.0) : 1.0;
          const sd2 = geomSolref ? (geomSolref[ct.geom2 * 2 + 1] ?? 1.0) : 1.0;
          const solTime = Math.max(st1 > 0 ? st1 : 0.004, st2 > 0 ? st2 : 0.004);
          const solDamp = Math.max(st1 > 0 && sd1 > 0 ? sd1 : 0.5, st2 > 0 && sd2 > 0 ? sd2 : 0.5);
          const pos = ct.pos;
          const wp: [number, number, number] = [pos[0], pos[1], pos[2]];
          if (wanted.has(b1)) {
            const cur = hitByBody.get(b1);
            // Prefer dynamic/scene body-to-body strike over static world floor contact when both exist
            if (!cur || (cur.otherBodyId === 0 && b2 > 0)) {
              hitByBody.set(b1, { otherBodyId: b2, selfGeom: ct.geom1, otherGeom: ct.geom2, worldPos: wp, solTime, solDamp });
            }
          }
          if (wanted.has(b2)) {
            const cur = hitByBody.get(b2);
            if (!cur || (cur.otherBodyId === 0 && b1 > 0)) {
              hitByBody.set(b2, { otherBodyId: b1, selfGeom: ct.geom2, otherGeom: ct.geom1, worldPos: wp, solTime, solDamp });
            }
          }
        } finally {
          ct.delete();
        }
      }
    }
  } finally {
    contactVec.delete();
  }

  for (const sbId of newlyTouchedStrings) {
    const st = hitByBody.get(sbId);
    if (st && !suppressedBowImpactBodies.has(sbId)) {
      recentPluckTouchSite.set(sbId, {
        otherBodyId: st.otherBodyId,
        selfGeom: st.selfGeom,
        otherGeom: st.otherGeom,
        worldPos: st.worldPos,
        atSimTime: simTime,
      });
    }
  }
  if (newTriggers.length === 0) return;

  const enqueuePairImpact = (
    targetBId: number,
    targetNodeId: string,
    partnerBId: number,
    partnerNodeId: string,
    selfGeom: number,
    otherGeom: number,
    worldPos: [number, number, number],
    effImpulseNs: number,
    solTime: number,
  ) => {
    if (effImpulseNs < 0.0015 || windSubtreeBodyIds.has(targetBId)) return;
    // When an untuned mallet/beater/plectrum strikes an explicitly tuned musical resonator (`tunedPitchHz`,
    // `acousticMembrane`, `nonlinearPlate`, `acousticString`), the striker's Hertzian compliance & mass are
    // already modeled in `resolveTwoBodyImpact` on the resonator — never emit a second dull beater-stick thud!
    if (
      partnerBId > 0 &&
      distinctAcousticChildBodyIds.has(partnerBId) &&
      !distinctAcousticChildBodyIds.has(targetBId)
    ) {
      return;
    }
    const cKey = `${Math.min(targetBId, partnerBId)}:${Math.max(targetBId, partnerBId)}`;
    const prevStart = continuousPairStartSimTime.get(cKey);
    if (prevStart === undefined || simTime < prevStart) {
      continuousPairStartSimTime.set(cKey, simTime);
    }
    // Critically-damped soft felt/rubber dampers (`softness >= 0.85 && solDamp >= 0.85`, e.g. `vibe_damper_bar`
    // or `cymbal_choke_arm`) gently pressing against a distinct resonator mute via `AUDIO_DAMPING` — never
    // re-strike the resonator via `AUDIO_IMPACTS` or overwrite `lastNodeStrikeSimTime`!
    if (
      partnerBId > 0 &&
      distinctAcousticChildBodyIds.has(targetBId) &&
      !distinctAcousticChildBodyIds.has(partnerBId)
    ) {
      const partnerSoft = bodySoftnessByBodyId?.[partnerBId] ?? 0.24;
      const gSolref = model!.geom_solref;
      const pSt = gSolref[otherGeom * 2] ?? 0.004;
      const pSd = gSolref[otherGeom * 2 + 1] ?? 1.0;
      const partnerSolDamp = pSt > 0 && pSd > 0 ? pSd : 0.5;
      if (partnerSoft >= 0.85 && partnerSolDamp >= 0.85) {
        const views = velocityViews(model!, data!);
        const vTarget = bodyPointVelocity(views, targetBId, worldPos);
        const vPartner = bodyPointVelocity(views, partnerBId, worldPos);
        const relSpeed = Math.hypot(
          vPartner[0] - vTarget[0],
          vPartner[1] - vTarget[1],
          vPartner[2] - vTarget[2],
        );
        const partnerMassKg = Math.max(0.02, model!.body_mass[partnerBId] || 0.06);
        if (isCriticallyDampedDamperPress(partnerSoft, partnerSolDamp, relSpeed, effImpulseNs, partnerMassKg)) {
          return;
        }
      }
    }
    const pairKey = `${targetNodeId}:${partnerNodeId}`;
    if (!shouldEmitPairImpact(lastAudioEmitSim.get(pairKey), simTime, effImpulseNs, solTime)) return;
    lastNodeStrikeSimTime.set(targetNodeId, simTime);
    const ox = data!.xpos[targetBId * 3];
    const oy = data!.xpos[targetBId * 3 + 1];
    const oz = data!.xpos[targetBId * 3 + 2];
    const localPoint = worldToBodyFrame(data!.xmat, targetBId, [
      worldPos[0] - ox,
      worldPos[1] - oy,
      worldPos[2] - oz,
    ]);
    const prev = pendingAudioImpacts.get(pairKey);
    if (!prev || effImpulseNs > prev.impulseNs) {
      pendingAudioImpacts.set(pairKey, {
        nodeId: targetNodeId,
        impulseNs: effImpulseNs,
        otherNodeId: partnerNodeId,
        selfGeomName: geomNameCache[selfGeom],
        otherGeomName: geomNameCache[otherGeom],
        localPoint,
        solTime,
      });
    }
  };

  for (const { bId, nodeId, impulseNs } of newTriggers) {
    const cachedPluck = acousticStringBodyIds.has(bId) ? recentPluckTouchSite.get(bId) : undefined;
    const site =
      hitByBody.get(bId) ??
      (cachedPluck && simTime - cachedPluck.atSimTime <= 0.060
        ? { ...cachedPluck, solTime: 0.004, solDamp: 1.0 }
        : undefined);
    // Skip internal joint-spring / joint-stop reversals with zero external geom contact (`!site`)
    if (!site || suppressedBowImpactBodies.has(bId)) continue;

    const solSoftScale = computeImpactSolSoftScale(
      site.solTime,
      site.solDamp,
      stepSize,
      acousticStringBodyIds.has(bId),
    );
    const effectiveImpulseNs = impulseNs * solSoftScale;
    const otherNodeId = site.otherBodyId > 0 ? (bodyNodeById[site.otherBodyId] ?? 'world') : 'world';

    enqueuePairImpact(
      bId,
      nodeId,
      site.otherBodyId,
      otherNodeId,
      site.selfGeom,
      site.otherGeom,
      site.worldPos,
      effectiveImpulseNs,
      site.solTime,
    );

    // Newton's 3rd Law attribution: static 0-DOF scene bodies (fixed bells, gongs, xylophone bars on stands,
    // hollow soundboxes/tables) and ground-supported targets never enter `dof_bodyid` on their own!
    if (
      site.otherBodyId > 0 &&
      otherNodeId !== 'world' &&
      otherNodeId !== nodeId &&
      !suppressedBowImpactBodies.has(site.otherBodyId)
    ) {
      enqueuePairImpact(
        site.otherBodyId,
        otherNodeId,
        bId,
        nodeId,
        site.otherGeom,
        site.selfGeom,
        site.worldPos,
        effectiveImpulseNs,
        site.solTime,
      );
    }
  }
};

const flushAudioImpacts = () => {
  if (!soundEnabled || pendingAudioImpacts.size === 0 || !data) {
    pendingAudioImpacts.clear();
    return;
  }
  const simTime = data.time;
  const candidates: (AudioImpactEvent & { solTime?: number })[] = [];
  for (const [pairKey, ev] of pendingAudioImpacts) {
    if (!shouldEmitPairImpact(lastAudioEmitSim.get(pairKey), simTime, ev.impulseNs, ev.solTime ?? 0.004)) {
      continue;
    }
    candidates.push(ev);
  }
  pendingAudioImpacts.clear();
  if (candidates.length === 0) return;
  candidates.sort((a, b) => b.impulseNs - a.impulseNs);
  const top = candidates.slice(0, 10);
  const cleanEvents: AudioImpactEvent[] = [];
  for (const ev of top) {
    const pairKey = `${ev.nodeId}:${ev.otherNodeId ?? 'world'}`;
    lastAudioEmitSim.set(pairKey, { atSimTime: simTime, impulseNs: ev.impulseNs });
    const { solTime: _st, ...clean } = ev;
    void _st;
    cleanEvents.push(clean);
  }
  post({ type: 'AUDIO_IMPACTS', events: cleanEvents });
};

/**
 * Throttled (~14 ms / 70 Hz) unified continuous contact analyzer:
 * - Zero overhead when `soundEnabled` is false!
 * - Shares ONE `data.contact` + `mj_contactForce` scan across:
 *   1. `BOWED_STRINGS` (rosined / `acousticBow` stick-slip + multi-finger stopping)
 *   2. `CONTACT_FRICTION` (Starter #2: continuous rolling, scraping, Stribeck squeal, singing-rim rub)
 *   3. `AUDIO_DAMPING` (Starter #3: sustained viscoelastic contact modal damping)
 * - Frees all WASM handles (`ct`, `contactVec`, `wrench`) in `finally`.
 */
const flushBowedStrings = () => {
  if (!soundEnabled || !model || !data || !mujoco) {
    if (hadActiveBowedStrings) {
      hadActiveBowedStrings = false;
      bowContactStartSimTime.clear();
      recentBowEvents.clear();
      prevActiveStringsByBow.clear();
      post({ type: 'BOWED_STRINGS', contacts: [] });
    }
    if (hadActiveFrictionContacts) {
      hadActiveFrictionContacts = false;
      continuousPairStartSimTime.clear();
      post({ type: 'CONTACT_FRICTION', contacts: [] });
    }
    if (hadActiveDampingContacts) {
      hadActiveDampingContacts = false;
      post({ type: 'AUDIO_DAMPING', contacts: [] });
    }
    return;
  }
  const now = performance.now();
  if (now - lastBowEmitMs < 14) return;
  lastBowEmitMs = now;

  interface AggregatedBowPair {
    bStr: number;
    bBow: number;
    gBow: number;
    totalForceN: number;
    weightedVelSum: number;
    weightedPos: [number, number, number];
    durSec: number;
  }

  interface AggregatedFrictionPair {
    pairKey: string;
    b1: number;
    b2: number;
    g1: number;
    g2: number;
    totalForceN: number;
    weightedSlipSum: number;
    weightedRollSum: number;
    weightedVt: [number, number, number];
    weightedPos: [number, number, number];
    muMax: number;
    rStarMin: number;
    durSec: number;
  }

  const pairMap = new Map<string, AggregatedBowPair>();
  const stopWorldPositionsByStringBody = new Map<number, [number, number, number][]>();
  const seenBowPairs = new Set<string>();

  const frictionPairMap = new Map<string, AggregatedFrictionPair>();
  const seenContinuousPairs = new Set<string>();

  const bodyParent = model.body_parentid;
  const bodyJntNum = model.body_jntnum;
  const contactVec = data.contact;
  const wrench = new mujoco.DoubleBuffer(6);
  try {
    const ncon = contactVec.size();
    if (ncon > 0) {
      const geomBody = model.geom_bodyid;
      const geomFriction = model.geom_friction;
      const geomSolref = model.geom_solref;
      const views = velocityViews(model, data);
      const xmat = data.xmat;

      for (let c = 0; c < ncon; c++) {
        const ct = contactVec.get(c);
        if (!ct) continue;
        try {
          const rawB1 = geomBody[ct.geom1];
          const rawB2 = geomBody[ct.geom2];
          const isStr1 = acousticStringBodyIds.has(rawB1);
          const isStr2 = acousticStringBodyIds.has(rawB2);

          // -----------------------------------------------------------------
          // Branch 1: Bowed / Stopped Taut String Contact
          // -----------------------------------------------------------------
          if (isStr1 !== isStr2) {
            const bStr = isStr1 ? rawB1 : rawB2;
            const rawBow = isStr1 ? rawB2 : rawB1;
            const bBow = bodyNodeById[rawBow]
              ? rawBow
              : resolveRigidOwnerBody(rawBow, bodyParent, bodyJntNum);
            const gBow = isStr1 ? ct.geom2 : ct.geom1;
            if (bBow <= 0) continue;

            const bowSpec = acousticBowSpecByBodyId.get(rawBow) ?? acousticBowSpecByBodyId.get(bBow);
            const rawMuSlide = geomFriction[gBow * 3] ?? 1.0;
            const muSlide = bowSpec ? (bowSpec.rosinFriction ?? Math.max(0.38, rawMuSlide)) : rawMuSlide;

            // Smooth non-rosined fingertip / capo / slide bar (`condim === 1` or `mu < 0.12` without `acousticBow`):
            if (!bowSpec && (ct.dim === 1 || muSlide < 0.12)) {
              if (ct.dist <= 0.0006) {
                const sp = ct.pos;
                let list = stopWorldPositionsByStringBody.get(bStr);
                if (!list) {
                  list = [];
                  stopWorldPositionsByStringBody.set(bStr, list);
                }
                list.push([sp[0], sp[1], sp[2]]);
              }
              continue;
            }

            let forceN = 0;
            if (ct.efc_address >= 0) {
              mujoco.mj_contactForce(model, data, c, wrench);
              forceN = Math.max(0, wrench.GetView()[0]);
            }
            if (bowSpec) {
              forceN *= Math.max(0.1, bowSpec.forceScale ?? 1.0) * Math.max(0.2, bowSpec.rosinGrip ?? 1.0);
            }
            if (forceN < 0.005 || muSlide < 0.15) continue;

            const pairKey = `${bStr}:${bBow}`;
            seenBowPairs.add(pairKey);
            let startT = bowContactStartSimTime.get(pairKey);
            if (startT === undefined || data.time < startT) {
              startT = data.time;
              bowContactStartSimTime.set(pairKey, startT);
            }
            const durSec = Math.max(0, data.time - startT);
            const bowSolTime = geomSolref[gBow * 2] ?? 0.02;
            const bowSolDamp = geomSolref[gBow * 2 + 1] ?? 1.0;
            const isDampedBow =
              !!bowSpec ||
              (bowSolTime > 0 && bowSolDamp >= 0.90) ||
              (bowSolTime < 0 && bowSolTime > -3000);
            const minDurSec = muSlide >= 0.22 && isDampedBow ? 0 : isDampedBow ? 0.012 : 0.018;
            if (durSec < minDurSec) continue;

            const pos = ct.pos;
            const wp: [number, number, number] = [pos[0], pos[1], pos[2]];
            const vStr = bodyPointVelocity(views, bStr, wp);
            const vBow = bodyPointVelocity(views, rawBow > 0 ? rawBow : bBow, wp);
            const vrx = vBow[0] - vStr[0];
            const vry = vBow[1] - vStr[1];
            const vrz = vBow[2] - vStr[2];

            const localAxis = acousticStringAxisByBodyId.get(bStr) ?? [0, 0, 1];
            const m = bStr * 9;
            const ux = xmat[m] * localAxis[0] + xmat[m + 1] * localAxis[1] + xmat[m + 2] * localAxis[2];
            const uy = xmat[m + 3] * localAxis[0] + xmat[m + 4] * localAxis[1] + xmat[m + 5] * localAxis[2];
            const uz = xmat[m + 6] * localAxis[0] + xmat[m + 7] * localAxis[1] + xmat[m + 8] * localAxis[2];

            const vDotU = vrx * ux + vry * uy + vrz * uz;
            let px = vrx - vDotU * ux;
            let py = vry - vDotU * uy;
            let pz = vrz - vDotU * uz;

            const frame = ct.frame;
            const nx = frame[0];
            const ny = frame[1];
            const nz = frame[2];
            const nDotU = nx * ux + ny * uy + nz * uz;
            let npx = nx - nDotU * ux;
            let npy = ny - nDotU * uy;
            let npz = nz - nDotU * uz;
            const npLen = Math.hypot(npx, npy, npz);
            if (npLen > 1e-5) {
              npx /= npLen;
              npy /= npLen;
              npz /= npLen;
              const pDotN = px * npx + py * npy + pz * npz;
              px -= pDotN * npx;
              py -= pDotN * npy;
              pz -= pDotN * npz;
            }
            const slideSpeed = Math.hypot(px, py, pz);

            const existing = pairMap.get(pairKey);
            if (existing) {
              existing.totalForceN += forceN;
              existing.weightedVelSum += slideSpeed * forceN;
              existing.weightedPos[0] += wp[0] * forceN;
              existing.weightedPos[1] += wp[1] * forceN;
              existing.weightedPos[2] += wp[2] * forceN;
              if (durSec > existing.durSec) existing.durSec = durSec;
            } else {
              pairMap.set(pairKey, {
                bStr,
                bBow,
                gBow,
                totalForceN: forceN,
                weightedVelSum: slideSpeed * forceN,
                weightedPos: [wp[0] * forceN, wp[1] * forceN, wp[2] * forceN],
                durSec,
              });
            }
            continue;
          }
          if (isStr1 && isStr2) continue;

          // -----------------------------------------------------------------
          // Branch 2: Continuous Solid Contact Friction & Viscoelastic Damping
          // -----------------------------------------------------------------
          const b1 = resolveRigidOwnerBody(rawB1, bodyParent, bodyJntNum);
          const b2 = resolveRigidOwnerBody(rawB2, bodyParent, bodyJntNum);
          if (b1 === b2 || (b1 <= 0 && b2 <= 0)) continue;
          if (windSubtreeBodyIds.has(b1) || windSubtreeBodyIds.has(b2)) continue;
          if (ct.efc_address < 0) continue;

          mujoco.mj_contactForce(model, data, c, wrench);
          const forceN = Math.max(0, wrench.GetView()[0]);
          if (forceN < 0.012) continue;

          const loB = Math.min(b1, b2);
          const hiB = Math.max(b1, b2);
          const gLo = b1 <= b2 ? ct.geom1 : ct.geom2;
          const gHi = b1 <= b2 ? ct.geom2 : ct.geom1;
          const cKey = `${loB}:${hiB}`;
          seenContinuousPairs.add(cKey);
          let cStart = continuousPairStartSimTime.get(cKey);
          if (cStart === undefined || data.time < cStart) {
            cStart = data.time;
            continuousPairStartSimTime.set(cKey, cStart);
          }
          const durSec = Math.max(0, data.time - cStart);

          const pos = ct.pos;
          const wp: [number, number, number] = [pos[0], pos[1], pos[2]];
          const vLo = loB > 0 ? bodyPointVelocity(views, loB, wp) : [0, 0, 0];
          const vHi = hiB > 0 ? bodyPointVelocity(views, hiB, wp) : [0, 0, 0];
          const dvx = vHi[0] - vLo[0];
          const dvy = vHi[1] - vLo[1];
          const dvz = vHi[2] - vLo[2];

          const frame = ct.frame;
          const nx = frame[0];
          const ny = frame[1];
          const nz = frame[2];
          const vDotN = dvx * nx + dvy * ny + dvz * nz;
          const vtx = dvx - vDotN * nx;
          const vty = dvy - vDotN * ny;
          const vtz = dvz - vDotN * nz;
          const slipSpeed = Math.hypot(vtx, vty, vtz);

          const wLo = loB > 0 ? bodyAngularVelocity(views, loB) : [0, 0, 0];
          const wHi = hiB > 0 ? bodyAngularVelocity(views, hiB) : [0, 0, 0];
          const dwx = wHi[0] - wLo[0];
          const dwy = wHi[1] - wLo[1];
          const dwz = wHi[2] - wLo[2];
          const wDotN = dwx * nx + dwy * ny + dwz * nz;
          const wPerp = Math.hypot(dwx - wDotN * nx, dwy - wDotN * ny, dwz - wDotN * nz);

          const rLo = geomRollingRadius ? (geomRollingRadius[gLo] ?? 0) : 0;
          const rHi = geomRollingRadius ? (geomRollingRadius[gHi] ?? 0) : 0;
          const rRoll = rLo > 0 && rHi > 0 ? (rLo * rHi) / (rLo + rHi) : Math.max(rLo, rHi);
          const rollSpeed = rRoll > 0 ? rRoll * wPerp : 0;

          const mu1 = geomFriction[gLo * 3] ?? 0.5;
          const mu2 = geomFriction[gHi * 3] ?? 0.5;
          const mu = Math.max(mu1, mu2);
          const rStar = rRoll > 0 ? rRoll : 0.025;

          const agg = frictionPairMap.get(cKey);
          if (agg) {
            agg.totalForceN += forceN;
            agg.weightedSlipSum += slipSpeed * forceN;
            agg.weightedRollSum += rollSpeed * forceN;
            agg.weightedVt[0] += vtx * forceN;
            agg.weightedVt[1] += vty * forceN;
            agg.weightedVt[2] += vtz * forceN;
            agg.weightedPos[0] += wp[0] * forceN;
            agg.weightedPos[1] += wp[1] * forceN;
            agg.weightedPos[2] += wp[2] * forceN;
            if (mu > agg.muMax) agg.muMax = mu;
            if (rStar < agg.rStarMin) agg.rStarMin = rStar;
            if (durSec > agg.durSec) agg.durSec = durSec;
          } else {
            frictionPairMap.set(cKey, {
              pairKey: cKey,
              b1: loB,
              b2: hiB,
              g1: gLo,
              g2: gHi,
              totalForceN: forceN,
              weightedSlipSum: slipSpeed * forceN,
              weightedRollSum: rollSpeed * forceN,
              weightedVt: [vtx * forceN, vty * forceN, vtz * forceN],
              weightedPos: [wp[0] * forceN, wp[1] * forceN, wp[2] * forceN],
              muMax: mu,
              rStarMin: rStar,
              durSec,
            });
          }
        } finally {
          ct.delete();
        }
      }
    }
  } finally {
    contactVec.delete();
    wrench.delete();
  }

  for (const key of Array.from(bowContactStartSimTime.keys())) {
    if (!seenBowPairs.has(key)) bowContactStartSimTime.delete(key);
  }
  for (const key of Array.from(continuousPairStartSimTime.keys())) {
    if (!seenContinuousPairs.has(key)) continuousPairStartSimTime.delete(key);
  }

  // ---- Emit BOWED_STRINGS -------------------------------------------------
  const rawBowEvents: BowedStringContactEvent[] = [];
  const stateSnap = pairMap.size > 0 ? scriptState.snapshot() : undefined;
  const xpos = data.xpos;
  const xmat = data.xmat;

  for (const agg of pairMap.values()) {
    const strNodeId = bodyNodeById[agg.bStr];
    const bowNodeId = bodyNodeById[agg.bBow];
    if (!strNodeId || !bowNodeId || strNodeId === 'world') continue;
    const invF = 1 / Math.max(1e-6, agg.totalForceN);
    const wx = agg.weightedPos[0] * invF;
    const wy = agg.weightedPos[1] * invF;
    const wz = agg.weightedPos[2] * invF;
    const ox = xpos[agg.bStr * 3];
    const oy = xpos[agg.bStr * 3 + 1];
    const oz = xpos[agg.bStr * 3 + 2];
    const localPoint = worldToBodyFrame(xmat, agg.bStr, [wx - ox, wy - oy, wz - oz]);

    // 1. Live 3D physical fingerboard/slide-bar stopping contacts (supports multi-finger chords & high positions!)
    let stoppedLengthFraction: number | undefined;
    const stopWps = stopWorldPositionsByStringBody.get(agg.bStr);
    const span = acousticStringSpanByBodyId.get(agg.bStr);
    if (stopWps && stopWps.length > 0 && span && span.len > 1e-4) {
      const sBow =
        ((localPoint[0] - span.p0[0]) * span.ax[0] +
          (localPoint[1] - span.p0[1]) * span.ax[1] +
          (localPoint[2] - span.p0[2]) * span.ax[2]) /
        span.len;
      const sStops: number[] = [];
      for (const stopWp of stopWps) {
        const stopLocal = worldToBodyFrame(xmat, agg.bStr, [stopWp[0] - ox, stopWp[1] - oy, stopWp[2] - oz]);
        const sStop =
          ((stopLocal[0] - span.p0[0]) * span.ax[0] +
            (stopLocal[1] - span.p0[1]) * span.ax[1] +
            (stopLocal[2] - span.p0[2]) * span.ax[2]) /
          span.len;
        sStops.push(sStop);
      }
      const rawStop = selectMultiFingerStopFraction(sBow, sStops);
      if (rawStop !== undefined) {
        const prev = recentStopByStringBody.get(agg.bStr);
        const smoothed =
          prev && Math.abs(prev.frac - rawStop) < 0.015 ? 0.82 * prev.frac + 0.18 * rawStop : rawStop;
        stoppedLengthFraction = +smoothed.toFixed(5);
        recentStopByStringBody.set(agg.bStr, { frac: stoppedLengthFraction, atSimTime: data.time });
      }
    } else {
      const prev = recentStopByStringBody.get(agg.bStr);
      if (prev && data.time >= prev.atSimTime && data.time - prev.atSimTime <= 0.018) {
        stoppedLengthFraction = prev.frac;
      } else if (prev) {
        recentStopByStringBody.delete(agg.bStr);
      }
    }

    // 2. Optional scriptState fallback
    if (stoppedLengthFraction === undefined && stateSnap) {
      const strSt = stateSnap[strNodeId] as Record<string, unknown> | undefined;
      const bowSt = stateSnap[bowNodeId] as Record<string, unknown> | undefined;
      const rawFrac =
        typeof strSt?.stoppedLengthFraction === 'number'
          ? strSt.stoppedLengthFraction
          : typeof bowSt?.stoppedLengthFraction === 'number'
            ? bowSt.stoppedLengthFraction
            : undefined;
      if (rawFrac !== undefined && Number.isFinite(rawFrac)) {
        stoppedLengthFraction = Math.max(0.12, Math.min(1.0, rawFrac));
      }
    }

    rawBowEvents.push({
      stringNodeId: strNodeId,
      bowNodeId,
      bowGeomName: geomNameCache[agg.gBow],
      bowVelocityMps: +(agg.weightedVelSum * invF).toFixed(5),
      bowForceN: +agg.totalForceN.toFixed(5),
      localPoint,
      contactDurationSec: +agg.durSec.toFixed(4),
      ...(stoppedLengthFraction !== undefined ? { stoppedLengthFraction } : {}),
    });
  }

  const bowEvents = resolveGuardedBowHold(rawBowEvents, recentBowEvents, prevActiveStringsByBow, data.time);
  if (bowEvents.length > 0 || hadActiveBowedStrings) {
    hadActiveBowedStrings = bowEvents.length > 0;
    post({ type: 'BOWED_STRINGS', contacts: bowEvents });
  }

  // ---- Emit CONTACT_FRICTION & AUDIO_DAMPING ------------------------------
  const frictionCandidates: { score: number; ev: ContinuousContactEvent }[] = [];
  const dampingCandidates: AudioDampingEvent[] = [];
  const bodyMass = model.body_mass;

  for (const agg of frictionPairMap.values()) {
    // Require sustained contact >= 22 ms so crisp 1-8 ms rigid bounces only fire AUDIO_IMPACTS
    if (agg.durSec < 0.022) continue;

    // Choose primary resonator body (prefer dynamic, rim-capable, or harder high-Q body over world/damper)
    let bPrimary = agg.b2;
    let bPartner = agg.b1;
    let gPrimary = agg.g2;
    let gPartner = agg.g1;
    let vtSign = 1;
    if (agg.b1 > 0 && agg.b2 > 0) {
      const rim1 = rimCapableBodyIds.has(agg.b1);
      const rim2 = rimCapableBodyIds.has(agg.b2);
      const soft1 = bodySoftnessByBodyId?.[agg.b1] ?? 0.24;
      const soft2 = bodySoftnessByBodyId?.[agg.b2] ?? 0.24;
      if ((rim1 && !rim2) || (rim1 === rim2 && soft1 < soft2)) {
        bPrimary = agg.b1;
        bPartner = agg.b2;
        gPrimary = agg.g1;
        gPartner = agg.g2;
        vtSign = -1;
      }
    } else if (agg.b1 > 0) {
      bPrimary = agg.b1;
      bPartner = 0;
      gPrimary = agg.g1;
      gPartner = agg.g2;
      vtSign = -1;
    }

    const nodeId = bodyNodeById[bPrimary];
    if (!nodeId || nodeId === 'world') continue;
    const otherNodeId = bPartner > 0 ? (bodyNodeById[bPartner] ?? 'world') : 'world';

    const invF = 1 / Math.max(1e-6, agg.totalForceN);
    const wx = agg.weightedPos[0] * invF;
    const wy = agg.weightedPos[1] * invF;
    const wz = agg.weightedPos[2] * invF;
    const ox = xpos[bPrimary * 3];
    const oy = xpos[bPrimary * 3 + 1];
    const oz = xpos[bPrimary * 3 + 2];
    const localPoint = worldToBodyFrame(xmat, bPrimary, [wx - ox, wy - oy, wz - oz]);

    const avgSlip = agg.weightedSlipSum * invF;
    const avgRoll = agg.weightedRollSum * invF;
    const patchMotion = Math.max(avgSlip, avgRoll);
    let isRimRub = false;

    if (patchMotion >= 0.012 && agg.totalForceN >= 0.015) {
      const rollingRatio = Math.max(0, Math.min(1, avgRoll / Math.max(1e-5, avgSlip + avgRoll)));
      const rA = bodyRoughnessByBodyId?.[bPrimary] ?? 0.35;
      const rB = bodyRoughnessByBodyId?.[bPartner] ?? 0.42;
      const roughness = +Math.max(0.04, Math.min(0.92, 0.5 * (rA + rB))).toFixed(3);

      let circumferentialRub: boolean | number = false;
      if (rimCapableBodyIds.has(bPrimary) && rollingRatio < 0.55 && avgSlip >= 0.015) {
        const vtLocal = worldToBodyFrame(xmat, bPrimary, [
          vtSign * agg.weightedVt[0] * invF,
          vtSign * agg.weightedVt[1] * invF,
          vtSign * agg.weightedVt[2] * invF,
        ]);
        const rRim = Math.hypot(localPoint[0], localPoint[1]);
        const vtNorm = Math.hypot(vtLocal[0], vtLocal[1], vtLocal[2]);
        if (rRim >= 0.015 && vtNorm > 1e-4) {
          const tx = -localPoint[1] / rRim;
          const ty = localPoint[0] / rRim;
          const align = Math.abs(vtLocal[0] * tx + vtLocal[1] * ty) / vtNorm;
          if (align >= 0.65) {
            circumferentialRub = +align.toFixed(3);
            isRimRub = true;
          }
        }
      }

      const score = Math.pow(agg.totalForceN, 0.7) * patchMotion * (0.3 + agg.muMax);
      frictionCandidates.push({
        score,
        ev: {
          pairId: agg.pairKey,
          nodeId,
          otherNodeId,
          selfGeomName: geomNameCache[gPrimary],
          otherGeomName: geomNameCache[gPartner],
          tangentSpeed: +patchMotion.toFixed(5),
          rollSpeedMps: +avgRoll.toFixed(5),
          normalForce: +agg.totalForceN.toFixed(5),
          muFriction: +agg.muMax.toFixed(3),
          rollingRatio: +rollingRatio.toFixed(4),
          roughness,
          contactRadiusM: +agg.rStarMin.toFixed(5),
          contactDurationSec: +agg.durSec.toFixed(4),
          contactPointWorld: [+wx.toFixed(4), +wy.toFixed(4), +wz.toFixed(4)],
          localPoint,
          ...(circumferentialRub ? { circumferentialRub } : {}),
        },
      });
    }

    // Viscoelastic modal damping (Starter #3): ONLY newly arriving post-strike contacts (`cStart > lastStrikeT + 0.06s`)
    // from a soft/felt damper body (`bPartner > 0 && damperSoft >= 0.45 && !isRimRub`) apply contact choking!
    // Pre-existing resting mounts, frame rails, pins, cushions, static floor, and the striking mallet itself NEVER choke!
    if (bPartner > 0 && !isRimRub && agg.durSec >= 0.035 && agg.totalForceN >= 0.05) {
      const damperSoft = bodySoftnessByBodyId?.[bPartner] ?? 0.14;
      const cStart = continuousPairStartSimTime.get(agg.pairKey) ?? (data.time - agg.durSec);
      const lastStrikeT = lastNodeStrikeSimTime.get(nodeId);
      const isPostStrikeArrival =
        lastStrikeT !== undefined ? cStart > lastStrikeT + 0.060 : cStart > 0.060;
      if (damperSoft >= 0.45 && isPostStrikeArrival) {
        const mTarget = Math.max(0.02, bodyMass[bPrimary] || 0.25);
        const dampingRate = computeContactDampingRate(agg.totalForceN, damperSoft, mTarget);
        if (dampingRate >= 0.6) {
          dampingCandidates.push({
            nodeId,
            dampingNodeId: otherNodeId,
            dampingGeomName: geomNameCache[gPartner],
            normalForce: +agg.totalForceN.toFixed(4),
            dampingRate,
            softness: +damperSoft.toFixed(3),
            contactDurationSec: +agg.durSec.toFixed(4),
            localPoint,
          });
        }
      }
    }
  }

  frictionCandidates.sort((a, b) => b.score - a.score);
  const frictionEvents = frictionCandidates.slice(0, 6).map((c) => c.ev);
  if (frictionEvents.length > 0 || hadActiveFrictionContacts) {
    hadActiveFrictionContacts = frictionEvents.length > 0;
    post({ type: 'CONTACT_FRICTION', contacts: frictionEvents });
  }

  dampingCandidates.sort((a, b) => b.dampingRate - a.dampingRate);
  const dampingEvents = dampingCandidates.slice(0, 8);
  if (dampingEvents.length > 0 || hadActiveDampingContacts) {
    hadActiveDampingContacts = dampingEvents.length > 0;
    post({ type: 'AUDIO_DAMPING', contacts: dampingEvents });
  }
};

/**
 * Applies physical wind drag & turbulent gust forces to MuJoCo `<composite>`
 * (`grid` / `cloth` / `cable`) bodies so flexible banners and sheets billow
 * and snap in `[envWindX, envWindY]`.
 */
const applyCompositeAeroForces = () => {
  if (!model || !data || aeroVoiceGroups.length === 0 || envDensity < 0) return;
  const hasWind = Math.abs(envWindX) > 1e-4 || Math.abs(envWindY) > 1e-4;
  let hasCompositeGroup = false;
  for (const g of aeroVoiceGroups) {
    if (g.compositeBodyIds.length > 0) {
      hasCompositeGroup = true;
      break;
    }
  }
  if (!hasCompositeGroup) return;

  const views = velocityViews(model, data);
  const xpos = data.xpos;
  const xmat = data.xmat;
  const xfrc = data.xfrc_applied;
  const rho = envDensity > 0 ? envDensity : 1.225;

  for (const grp of aeroVoiceGroups) {
    if (grp.compositeBodyIds.length === 0) continue;
    const area = grp.compositeElementAreaM2;
    for (const bId of grp.compositeBodyIds) {
      const px = xpos[bId * 3];
      const py = xpos[bId * 3 + 1];
      const pz = xpos[bId * 3 + 2];
      const [vx, vy, vz] = bodyPointVelocity(views, bId, [px, py, pz]);
      let wx = envWindX || 0;
      let wy = envWindY || 0;
      let wz = 0;
      if (envWindGusting && hasWind) {
        [wx, wy, wz] = evaluateGustWind(wx, wy, px, py, pz, data.time);
      }
      const rvx = wx - vx;
      const rvy = wy - vy;
      const rvz = wz - vz;
      const relSpeed = Math.hypot(rvx, rvy, rvz);
      if (relSpeed < 0.04) continue;

      const mOff = bId * 9;
      // Local Z normal of the composite element frame
      const nx = xmat[mOff + 2];
      const ny = xmat[mOff + 5];
      const nz = xmat[mOff + 8];
      const vDotN = rvx * nx + rvy * ny + rvz * nz;
      const sinAlpha = Math.min(1, Math.abs(vDotN) / relSpeed);
      const q = 0.5 * rho * relSpeed * relSpeed;
      // Normal pressure loading + tangential skin drag on cloth/membrane element
      const fn = 1.65 * q * area * (vDotN / relSpeed) * (0.35 + 0.65 * sinAlpha);
      const fd = 0.08 * q * area;
      const fx = fn * nx + fd * (rvx / relSpeed);
      const fy = fn * ny + fd * (rvy / relSpeed);
      const fz = fn * nz + fd * (rvz / relSpeed);
      xfrc[bId * 6 + 0] += fx;
      xfrc[bId * 6 + 1] += fy;
      xfrc[bId * 6 + 2] += fz;

      if (soundEnabled) {
        grp.accForceSum += Math.hypot(fx, fy, fz);
        grp.accRelSpeedSum += relSpeed * area;
        grp.accAlphaWeightedSum += (Math.asin(sinAlpha) * 180 / Math.PI) * area;
        grp.accAreaSum += area;
        grp.accActiveCount++;
        if (relSpeed > grp.accTipSpeedMax) grp.accTipSpeedMax = relSpeed;
      }
    }
  }
};

/**
 * Per-substep zero-copy cloth trailing-edge whip-snap ("flag snap") detector:
 * Tracks normal velocity reversal / jerk `|Δv_⊥| / Δt > a_snap` alongside rising
 * membrane hinge/constraint tension (`90 ms` per-edge debounce, zero `dat.contact` copy!).
 */
const sampleAeroSnaps = (stepSize: number) => {
  if (!soundEnabled || clothTrailingWatches.length === 0 || !model || !data || envDensity < 0) return;
  const dt = Math.max(1e-4, stepSize);
  const views = velocityViews(model, data);
  const xpos = data.xpos;
  const xmat = data.xmat;
  const qfrcC = data.qfrc_constraint;
  const qfrcPassive = data.qfrc_passive;

  for (const w of clothTrailingWatches) {
    const bId = w.bodyId;
    if (bId <= 0 || bId >= model.nbody) continue;
    const px = xpos[bId * 3];
    const py = xpos[bId * 3 + 1];
    const pz = xpos[bId * 3 + 2];
    const [vx, vy, vz] = bodyPointVelocity(views, bId, [px, py, pz]);
    const mOff = bId * 9;
    const nx = xmat[mOff] * w.normalLocal[0] + xmat[mOff + 1] * w.normalLocal[1] + xmat[mOff + 2] * w.normalLocal[2];
    const ny = xmat[mOff + 3] * w.normalLocal[0] + xmat[mOff + 4] * w.normalLocal[1] + xmat[mOff + 5] * w.normalLocal[2];
    const nz = xmat[mOff + 6] * w.normalLocal[0] + xmat[mOff + 7] * w.normalLocal[1] + xmat[mOff + 8] * w.normalLocal[2];
    const vNorm = vx * nx + vy * ny + vz * nz;
    const speedSq = vx * vx + vy * vy + vz * vz;

    let cMag = 0;
    for (const dAdr of w.constraintDofAdrs) {
      if (dAdr >= 0 && dAdr < model.nv) {
        cMag += Math.abs(qfrcC[dAdr]) + Math.abs(qfrcPassive[dAdr]);
      }
    }

    if (!w.initialized) {
      w.prevNormalVel = vNorm;
      w.prevSpeedSq = speedSq;
      w.prevConstraintMag = cMag;
      w.initialized = true;
      continue;
    }

    const accelNorm = Math.abs(vNorm - w.prevNormalVel) / dt;
    const isWhipReversal = vNorm * w.prevNormalVel <= 0.02 || speedSq < w.prevSpeedSq * 0.72;
    const isTensionSpike = cMag > w.prevConstraintMag * 1.08 + 0.004 || accelNorm > 55.0;
    w.prevNormalVel = vNorm;
    w.prevSpeedSq = speedSq;
    w.prevConstraintMag = cMag;

    // Traveling flexural wave snaps the free trailing edge taut (a_snap = 26 m/s², 90 ms debounce)
    const relSpeed = Math.hypot(vx - (envWindX || 0), vy - (envWindY || 0), vz);
    if (
      accelNorm > 26.0 &&
      relSpeed >= 0.8 &&
      isWhipReversal &&
      isTensionSpike &&
      data.time - w.lastSnapSimTime >= 0.090
    ) {
      w.lastSnapSimTime = data.time;
      const bodyMass = Math.max(0.002, model.body_mass[bId] || 0.008);
      const impulseNs = Math.min(0.45, bodyMass * Math.abs(accelNorm) * dt * 1.8);
      if (impulseNs >= 0.0005) {
        const prev = pendingAeroSnaps.get(w.nodeId);
        if (!prev || impulseNs > prev.impulseNs) {
          pendingAeroSnaps.set(w.nodeId, {
            nodeId: w.nodeId,
            impulseNs: +impulseNs.toFixed(5),
            arealDensityKgM2: w.arealDensityKgM2,
            relSpeedMps: +relSpeed.toFixed(3),
          });
        }
      }
    }
  }
};

/**
 * Throttled (20 ms / 50 Hz) aeroacoustic telemetry emitter:
 * - Zero WASM `data.contact` copies!
 * - Resets preallocated accumulators cleanly and sends a single `{ voices: [], snaps: [] }`
 *   clear frame when all aero bodies go quiet (`hadActiveAeroVoices` guard).
 */
const flushAeroAudio = () => {
  if (
    !soundEnabled ||
    (aeroVoiceGroups.length === 0 && bluffBodyAeroByBodyId.size === 0 && !cloth) ||
    !model ||
    !data
  ) {
    pendingAeroSnaps.clear();
    if (cloth) {
      cloth.sim.consumeAeroTelemetry(0, true);
    }
    for (const grp of aeroVoiceGroups) {
      grp.accForceSum = 0;
      grp.accRelSpeedSum = 0;
      grp.accTipSpeedMax = 0;
      grp.accAlphaWeightedSum = 0;
      grp.accAreaSum = 0;
      grp.accActiveCount = 0;
    }
    if (hadActiveAeroVoices) {
      hadActiveAeroVoices = false;
      post({ type: 'AERO_AUDIO', voices: [], snaps: [] });
    }
    return;
  }

  const now = performance.now();
  if (now - lastAeroEmitMs < 20) return;
  lastAeroEmitMs = now;

  const qvel = data.qvel;
  const views = velocityViews(model, data);
  const xpos = data.xpos;
  const isVacuum = envDensity < 0;
  const rho = isVacuum ? 0 : envDensity > 0 ? envDensity : 1.225;
  const voices: AeroVoiceTelemetry[] = [];
  let clothSnaps: AeroSnapEvent[] = [];

  if (cloth) {
    const clothTelemetry = cloth.sim.consumeAeroTelemetry(rho, isVacuum);
    for (const cv of clothTelemetry.voices) voices.push(cv);
    clothSnaps = clothTelemetry.snaps;
    if (clothTelemetry.tieImpacts.length > 0) {
      for (const ti of clothTelemetry.tieImpacts) {
        const bId = bodyIdCache[ti.bodyName];
        const targetNodeId = bId !== undefined ? bodyNodeById[bId] : undefined;
        if (!targetNodeId || targetNodeId === 'world') continue;
        // When `isGrommetClink` is true, attribute partner to a hard metallic halyard/shackle node if present in the scene,
        // else `'world'` (which `inferColliderContactProps` models as hard mineral/steel at 65 GPa!).
        let strikerPartnerId = 'world';
        if (ti.isGrommetClink) {
          for (const key of Object.keys(bodyIdCache)) {
            if (/shackle|clew|halyard/i.test(key) && bodyNodeById[bodyIdCache[key]]) {
              strikerPartnerId = bodyNodeById[bodyIdCache[key]];
              break;
            }
          }
        }
        const pairKey = `${targetNodeId}:cloth_tie_${ti.anchorLocal ? ti.anchorLocal.map((c) => c.toFixed(3)).join('_') : 'origin'}`;
        const prev = pendingAudioImpacts.get(pairKey);
        if (!prev || ti.impulseNs > prev.impulseNs) {
          pendingAudioImpacts.set(pairKey, {
            nodeId: targetNodeId,
            impulseNs: ti.impulseNs,
            otherNodeId: strikerPartnerId,
            ...(ti.anchorLocal ? { localPoint: ti.anchorLocal } : {}),
            solTime: ti.isGrommetClink ? 0.0025 : 0.006,
          });
        }
      }
    }
  }

  for (const grp of aeroVoiceGroups) {
    // Effective rotor angular rate relative to air: `|qvel[hubJoint] + ω_parent · axis_world|`
    // so a pitching/yawing/tumbling quadcopter naturally shifts its 4 motors' BPFs apart (`inter-motor beating`)!
    let omega = grp.hubJointDofAdr >= 0 && grp.hubJointDofAdr < model.nv ? qvel[grp.hubJointDofAdr] : 0;
    if (grp.bladeCount >= 1 && grp.hubBodyId > 0 && grp.hubBodyId < model.nbody) {
      const parentId = model.body_parentid[grp.hubBodyId];
      if (parentId > 0) {
        const [pwx, pwy, pwz] = bodyAngularVelocity(views, parentId);
        // Project parent world angular velocity onto hub body's world Z/spin axis (or total world spin along hub):
        const hubW = bodyAngularVelocity(views, grp.hubBodyId);
        const relMag = Math.hypot(hubW[0], hubW[1], hubW[2]);
        if (relMag > 0.1) {
          omega = omega >= 0 ? relMag : -relMag;
        } else {
          omega += 0.35 * (pwx + pwy + pwz);
        }
      }
    }
    const absOmega = Math.abs(omega);

    let totalArea = 0;
    let avgChord = 0.05;
    let avgThick = grp.compositeThicknessM || 0.003;
    let maxTipR = 0.05;
    let avgSigma = grp.compositeArealDensityKgM2 || 0.15;
    let bendRateSum = 0;
    let bendCount = 0;

    if (grp.blades.length > 0) {
      let chordSum = 0;
      let thickSum = 0;
      let sigmaSum = 0;
      for (const bl of grp.blades) {
        totalArea += bl.areaM2;
        chordSum += bl.chordM * bl.areaM2;
        thickSum += bl.thicknessM * bl.areaM2;
        sigmaSum += bl.arealDensityKgM2 * bl.areaM2;
        if (bl.tipRadiusM > maxTipR) maxTipR = bl.tipRadiusM;
        if (bl.hingeDofAdr >= 0 && bl.hingeDofAdr < model.nv) {
          bendRateSum += Math.abs(qvel[bl.hingeDofAdr]);
          bendCount++;
        }
      }
      if (totalArea > 1e-6) {
        avgChord = chordSum / totalArea;
        avgThick = thickSum / totalArea;
        avgSigma = sigmaSum / totalArea;
      }
    } else if (grp.compositeBodyIds.length > 0) {
      totalArea = grp.compositeElementAreaM2 * grp.compositeBodyIds.length;
      avgChord = Math.sqrt(Math.max(1e-4, totalArea));
      for (const dAdr of grp.compositeDofAdrs) {
        if (dAdr >= 0 && dAdr < model.nv) {
          bendRateSum += Math.abs(qvel[dAdr]);
          bendCount++;
        }
      }
    }

    // Read instantaneous kinematics when accumulators had 0 aerodynamic force (e.g. physics-only scripted windmill!)
    let relSpeedMps = grp.accAreaSum > 1e-6 ? grp.accRelSpeedSum / Math.max(1e-6, grp.accAreaSum) : 0;
    let tipSpeedMps = Math.max(grp.accTipSpeedMax, absOmega * maxTipR);
    let aeroForceN = grp.accActiveCount > 0 ? grp.accForceSum / Math.max(1, grp.accActiveCount / Math.max(1, grp.blades.length || grp.compositeBodyIds.length)) : 0;
    const alphaDeg = grp.accAreaSum > 1e-6 ? grp.accAlphaWeightedSum / grp.accAreaSum : 12.0;

    if (relSpeedMps < 0.05 && grp.hubBodyId > 0 && grp.hubBodyId < model.nbody) {
      const hb = grp.hubBodyId;
      const [vx, vy, vz] = bodyPointVelocity(views, hb, [xpos[hb * 3], xpos[hb * 3 + 1], xpos[hb * 3 + 2]]);
      const hubRel = Math.hypot(vx - (envWindX || 0), vy - (envWindY || 0), vz);
      relSpeedMps = Math.max(hubRel, absOmega * maxTipR * 0.7);
      if (tipSpeedMps < relSpeedMps) tipSpeedMps = relSpeedMps;
      if (aeroForceN === 0 && absOmega > 0.4 && !isVacuum) {
        const rho = envDensity > 0 ? envDensity : 1.225;
        aeroForceN = 0.35 * rho * totalArea * relSpeedMps * relSpeedMps;
      }
    }

    const bendRateRadPerSec = bendCount > 0 ? bendRateSum / bendCount : 0;

    // Reset accumulators for the next 20 ms window
    grp.accForceSum = 0;
    grp.accRelSpeedSum = 0;
    grp.accTipSpeedMax = 0;
    grp.accAlphaWeightedSum = 0;
    grp.accAreaSum = 0;
    grp.accActiveCount = 0;

    if (!isVacuum && (relSpeedMps >= 0.25 || tipSpeedMps >= 0.25 || absOmega >= 0.35 || bendRateRadPerSec >= 0.5)) {
      voices.push({
        hubOrBodyId: grp.id,
        bladeCount: grp.bladeCount,
        omegaRadPerSec: +omega.toFixed(4),
        tipSpeedMps: +tipSpeedMps.toFixed(4),
        relSpeedMps: +relSpeedMps.toFixed(4),
        alphaDeg: +alphaDeg.toFixed(3),
        areaM2: +totalArea.toFixed(5),
        chordM: +avgChord.toFixed(4),
        thicknessM: +avgThick.toFixed(5),
        aeroForceN: +aeroForceN.toFixed(4),
        arealDensityKgM2: +avgSigma.toFixed(4),
        bendRateRadPerSec: +bendRateRadPerSec.toFixed(4),
        ...(grp.isCloth ? { isCloth: true } : {}),
      });
    }
  }

  // Fast-moving non-`isAerodynamic` dynamic bodies (pendulums, whipped rods, projectiles >= 2.2 m/s)
  // AND static slender cylindrical masts/poles (`isAeolian: true`, wind >= 2.5 m/s):
  // emit passive Strouhal whoosh / Aeolian wind hum without disturbing rigid-body solver trajectories!
  if (!isVacuum && bluffBodyAeroByBodyId.size > 0) {
    const bluffCandidates: { score: number; v: AeroVoiceTelemetry }[] = [];
    const envWindMag = Math.hypot(envWindX || 0, envWindY || 0);
    for (const [bId, meta] of bluffBodyAeroByBodyId) {
      if (bId <= 0 || bId >= model.nbody) continue;
      if (meta.isAeolian) {
        if (envWindMag < 2.5) continue;
        // Sample live gust speed at the mast's world position when wind gusting is enabled
        const [gx, gy, gz] = envWindGusting
          ? evaluateGustWind(
              envWindX || 0,
              envWindY || 0,
              xpos[bId * 3],
              xpos[bId * 3 + 1],
              xpos[bId * 3 + 2] + 1.0,
              data.time,
            )
          : [envWindX || 0, envWindY || 0, 0];
        const uPerp = Math.hypot(gx, gy, gz * 0.25);
        if (uPerp < 2.5) continue;
        const fDrag = 0.5 * rho * 1.1 * meta.areaM2 * uPerp * uPerp;
        bluffCandidates.push({
          score: fDrag * uPerp * 0.5,
          v: {
            hubOrBodyId: meta.nodeId,
            bladeCount: 0,
            omegaRadPerSec: 0,
            tipSpeedMps: +uPerp.toFixed(4),
            relSpeedMps: +uPerp.toFixed(4),
            alphaDeg: 4.0,
            areaM2: +meta.areaM2.toFixed(5),
            chordM: +meta.chordM.toFixed(4),
            thicknessM: +meta.thicknessM.toFixed(5),
            aeroForceN: +fDrag.toFixed(4),
            arealDensityKgM2: +meta.sigmaKgM2.toFixed(4),
            bendRateRadPerSec: 0,
            gainScale: 0.28,
          },
        });
        continue;
      }
      const px = xpos[bId * 3];
      const py = xpos[bId * 3 + 1];
      const pz = xpos[bId * 3 + 2];
      const [vx, vy, vz] = bodyPointVelocity(views, bId, [px, py, pz]);
      const [wx, wy, wz] = bodyAngularVelocity(views, bId);
      const bodySpeed = Math.hypot(vx, vy, vz);
      const tipSwish = Math.hypot(wx, wy, wz) * meta.chordM;
      // Tiny nearly-stationary hardware fittings (< 0.008 m², e.g. halyard shackles) do not emit standalone bluff wind hiss
      if (meta.areaM2 < 0.008 && bodySpeed < 1.2 && tipSwish < 1.2) continue;
      let locWx = envWindX || 0;
      let locWy = envWindY || 0;
      let locWz = 0;
      if (envWindGusting && envWindMag >= 0.5) {
        [locWx, locWy, locWz] = evaluateGustWind(locWx, locWy, px, py, pz, data.time);
      }
      const linRel = Math.hypot(vx - locWx, vy - locWy, vz - locWz);
      const effRel = Math.max(linRel, tipSwish * 0.65);
      if (effRel < 2.2) continue;
      const fDrag = 0.5 * rho * 0.47 * meta.areaM2 * effRel * effRel;
      bluffCandidates.push({
        score: fDrag * effRel,
        v: {
          hubOrBodyId: meta.nodeId,
          bladeCount: 0,
          omegaRadPerSec: 0,
          tipSpeedMps: +Math.max(effRel, tipSwish).toFixed(4),
          relSpeedMps: +effRel.toFixed(4),
          alphaDeg: 18.0,
          areaM2: +meta.areaM2.toFixed(5),
          chordM: +meta.chordM.toFixed(4),
          thicknessM: +meta.thicknessM.toFixed(5),
          aeroForceN: +fDrag.toFixed(4),
          arealDensityKgM2: +meta.sigmaKgM2.toFixed(4),
          bendRateRadPerSec: 0,
        },
      });
    }
    if (bluffCandidates.length > 0) {
      bluffCandidates.sort((a, b) => b.score - a.score);
      for (const c of bluffCandidates.slice(0, 4)) voices.push(c.v);
    }
  }

  const snaps = clothSnaps.length > 0
    ? [...Array.from(pendingAeroSnaps.values()), ...clothSnaps]
    : Array.from(pendingAeroSnaps.values());
  pendingAeroSnaps.clear();

  if (voices.length > 0 || snaps.length > 0 || hadActiveAeroVoices) {
    hadActiveAeroVoices = voices.length > 0;
    post({ type: 'AERO_AUDIO', voices, snaps });
  }
};

/** Lets go of the zip slider the drag held, and tells the main thread how far it is done up, for the graph. */
const releaseClothZip = () => {
  const zip = clothGrabZip;
  clothGrabZip = -1;
  if (!cloth) return;
  cloth.sim.grabZip(null, null);
  const z = cloth.sim.zipState()[zip];
  if (z) post({ type: 'CLOTH_ZIP', ...z });
};

/** Moves the cloth on by a step, after MuJoCo's: it reads where every body has just got to. */
const stepCloth = (dt: number) => {
  if (!cloth || !model) return;
  const g = modelOpt(model).gravity;
  const wx = envWindX || 0, wy = envWindY || 0;
  cloth.advance(dt, {
    gravity: [g[0], g[1], g[2]],
    wind: [wx, wy, 0],
    airDensity: envDensity < 0 ? 0 : envDensity > 0 ? envDensity : 1.225,
    gustAt: envWindGusting && (wx !== 0 || wy !== 0) ? evaluateGustWind : undefined,
  });
};

// Snapshot everything the main thread needs to render + mirror `model`/`data`.
const snapshot = () => {
  const dat = data!;
  const { qpos, qvel, ctrl, xfrc_applied, qfrc_applied, xpos, xmat, cvel, geom_xpos, geom_xmat } = sharedBuffers;
  if (isSharedSupported && qpos && qvel && ctrl && xfrc_applied && qfrc_applied && xpos && xmat && cvel && geom_xpos && geom_xmat) {
    updateSharedBuffers();
    return {
      time: dat.time,
      heapBytes: heapBytes(),
      qpos,
      qvel,
      ctrl,
      xfrc_applied,
      qfrc_applied,
      xpos,
      xmat,
      cvel,
      geom_xpos,
      geom_xmat,
      flexvert_xpos: sharedBuffers.flexvert_xpos,
    };
  }
  return {
    time: dat.time,
    heapBytes: heapBytes(),
    qpos: Float64Array.from(dat.qpos),
    qvel: Float64Array.from(dat.qvel),
    ctrl: Float64Array.from(dat.ctrl),
    xfrc_applied: Float64Array.from(dat.xfrc_applied),
    qfrc_applied: Float64Array.from(dat.qfrc_applied),
    xpos: Float64Array.from(dat.xpos),
    xmat: Float64Array.from(dat.xmat),
    cvel: Float64Array.from(dat.cvel),
    geom_xpos: Float64Array.from(dat.geom_xpos),
    geom_xmat: Float64Array.from(dat.geom_xmat),
    flexvert_xpos: cloth ? (() => { const a = new Float64Array(3 * cloth.sim.renderSize()); cloth.sim.writeRender(a); return a; })() : undefined,
  };
};


const post = (msg: WorkerToMainMessage, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

// Without shared memory, stepping is driven by TICK messages from the main
// thread's own requestAnimationFrame loop (see App.tsx's PhysicsLoop /
// physicsWorkerClient's `tick()`), not by a worker-local setInterval: a
// worker-local timer runs on its own clock, out of phase with the render loop,
// and added roughly a frame of latency to dragging a body. With shared memory
// the TICKs are ignored and the worker's own display-rate loop steps instead —
// see startWorkerLoop and FRAME_INTERVAL_MS.
// ---- Breakable welds ------------------------------------------------------
//
// MuJoCo spends a measurable force holding every weld together and reports it in
// `efc_force`: six rows per weld equality, the first three force in newtons and
// the last three torque in newton-metres. A 1 kg body hanging off a weld reads
// 9.81 N, so the numbers a body is authored with are the numbers a person can
// reason about.
//
// Breaking one costs nothing. `data.eq_active` is a writable Uint8Array view —
// not one of the heap-copy handles `dat.contact` is, so none of the delete()
// discipline below applies to it — and clearing a row disables that equality
// from the next step onwards. No rebuild, no change to nq or nv, no state to
// carry over. The part simply stops being held on and keeps the momentum it
// already had.
//
// The worker breaks the weld itself rather than asking the main thread to,
// because a round trip is several frames the scene would otherwise spend still
// holding a weld that has already failed. What the main thread gets is the news.

/** Per-weld bookkeeping, rebuilt once per model build rather than per step. */
interface BreakableWeld {
  eqIndex: number;
  key: string;
  nodeId: string;
  targetId: string;
  cfg: WeldBreakConfig;
  /** Consecutive steps this weld has been over its limit. */
  consecutive: number;
  /**
   * Set when this is a crumple zone rather than a weld between two parts.
   *
   * The difference is only in what happens after: a weld that lets go leaves
   * two free bodies, while a crumple leaves a joint that has to be stiffened
   * into its new shape so the part stays folded instead of flapping.
   */
  crumple?: { jointName: string; dampingAfter: number };
  /**
   * A member's axis, or a rod's way into itself at a joint, in body1's frame:
   * so the push along it can be told from the rest of the force, for buckling
   * and for pulling out. See BREAK_FIELDS in utils/breakKeys.ts.
   */
  axis?: [number, number, number];
  /** A bar's wide side (body1's frame) and strong-way bending limit: see barBending. */
  bar?: { wide: [number, number, number]; strongNm: number };
  /** Another breakable that goes when this one does: a joint's pin, when the member snapped at the joint. */
  also?: string;
  /** What the main thread is told it was: see ConstraintBrokenEvent.kind. */
  kind?: 'member' | 'joint';
}

let breakableWelds: BreakableWeld[] = [];

/**
 * Keys of welds that have already given way.
 *
 * Mirrored from the main thread on every build. The worker cannot be the
 * authority here: it is terminated and respawned every fourth build and every
 * twenty seconds of play, and a fresh worker has no memory of what broke.
 */
let brokenWeldKeys: Set<string> = new Set();

/**
 * Match each breakable body to the equality that holds it.
 *
 * Deliberately a forward lookup from the scene graph rather than a parse of the
 * `weld_constraint_N` names the emitter generates. That ordinal is positional:
 * add a body and every weld after it renumbers, so a cached index would start
 * pointing at somebody else's weld after the next edit. Going out from the node
 * to its body id and finding the equality that names it survives any of that.
 */
const rebuildBreakableWelds = () => {
  breakableWelds = [];
  joinedMassCache = null;
  const mdl = model;
  const mj = mujoco;
  if (!mdl || !mj) return;

  const weldType = mj.mjtEq.mjEQ_WELD.value;

  /*
   * Which equality is which.
   *
   * A weld between two parts is found from the body it holds; a crumple lock is
   * found by NAME, because there may be several on the same body and the body
   * alone cannot tell them apart. Both are welds as far as MuJoCo is concerned.
   */
  const eqIdByName: Record<string, number> = {};
  for (let i = 0; i < mdl.neq; i++) {
    const nm = mj.mj_id2name(mdl, mj.mjtObj.mjOBJ_EQUALITY.value, i);
    if (nm) eqIdByName[nm] = i;
  }

  const collect = (nodes: SceneNode[]) => {
    if (!nodes) return;
    for (const node of nodes) {
      for (const j of node.joints || []) {
        if (!canCrumple(j)) continue;
        const eqIndex = eqIdByName[`crumple_lock_${j.name}`];
        if (eqIndex === undefined) continue;
        breakableWelds.push({
          eqIndex,
          key: crumpleKey(j.name),
          nodeId: node.id,
          targetId: j.name,
          cfg: crumpleAsWeld(j),
          consecutive: 0,
          crumple: { jointName: j.name, dampingAfter: j.crumpleDampingAfter ?? 0 },
        });
      }
      const cfg = node as WeldBreakConfig;
      if (node.weldTargetId && isBreakable(cfg)) {
        const bodyId = bodyIdCache[node.id];
        if (bodyId !== undefined) {
          for (let i = 0; i < mdl.neq; i++) {
            if (mdl.eq_type[i] === weldType && mdl.eq_obj1id[i] === bodyId) {
              breakableWelds.push({
                eqIndex: i,
                key: weldKey(node.id, node.weldTargetId),
                nodeId: node.id,
                targetId: node.weldTargetId,
                cfg: {
                  weldBreakForceN: cfg.weldBreakForceN,
                  weldBreakTorqueNm: cfg.weldBreakTorqueNm,
                  weldBreakHoldSteps: holdSteps(cfg),
                },
                consecutive: 0,
              });
              break;
            }
          }
        }
      }
      collect(node.children || []);
    }
  };
  collect(sceneGraph.nodes);

  // Members and joint blobs: the compiler wrote each one's limits into the
  // model as a <numeric> named after its equality (utils/breakModel.ts), so
  // nothing here works them out again.
  const nnum = mdl.nnumeric ?? 0;
  if (nnum > 0) {
    const adrs = mdl.numeric_adr;
    const vals = mdl.numeric_data;
    const opt = (v: number) => (v >= 0 ? v : undefined);
    for (let i = 0; i < nnum; i++) {
      const name = mj.mj_id2name(mdl, mj.mjtObj.mjOBJ_NUMERIC.value, i);
      const eqIndex = name ? eqIdByName[name] : undefined;
      const parsed = name ? parseBreakKey(name) : null;
      if (eqIndex === undefined || !parsed) continue;
      const d = (k: number) => vals[adrs[i] + k];
      breakableWelds.push({
        eqIndex,
        key: name,
        nodeId: parsed.nodeId,
        targetId: parsed.targetId,
        cfg: {
          weldBreakForceN: opt(d(BREAK_FIELDS.FORCE)),
          weldBreakTorqueNm: opt(d(BREAK_FIELDS.TORQUE)),
          weldBreakCompressionN: opt(d(BREAK_FIELDS.COMPRESSION)),
          weldBreakLateralN: opt(d(BREAK_FIELDS.LATERAL)),
          weldBreakHoldSteps: d(BREAK_FIELDS.HOLD) || undefined,
        },
        consecutive: 0,
        axis: d(BREAK_FIELDS.AX) || d(BREAK_FIELDS.AY) || d(BREAK_FIELDS.AZ) ? [d(BREAK_FIELDS.AX), d(BREAK_FIELDS.AY), d(BREAK_FIELDS.AZ)] : undefined,
        bar: d(BREAK_FIELDS.STRONG) > 0
          ? { wide: [d(BREAK_FIELDS.WX), d(BREAK_FIELDS.WY), d(BREAK_FIELDS.WZ)], strongNm: d(BREAK_FIELDS.STRONG) }
          : undefined,
        also: d(BREAK_FIELDS.ALSO) ? `pin:${parsed.targetId}>${parsed.nodeId}` : undefined,
        kind: parsed.kind === 'member' ? 'member' : 'joint',
      });
    }
  }
};

/**
 * Stiffen a crumple zone into the shape it has just folded into.
 *
 * `model.dof_damping` is a plain writable view, so this needs no rebuild. It is
 * what stops a released joint from swinging: a car wing that folds and then
 * flaps reads as a hinge coming undone, not as metal taking a set.
 */
const releaseCrumple = (w: BreakableWeld) => {
  const mdl = model;
  if (!w.crumple || !mdl) return;
  const jntId = jointIdCache[w.crumple.jointName];
  if (jntId === undefined) return;
  const dofAdr = mdl.jnt_dofadr[jntId];
  if (dofAdr >= 0 && dofAdr < mdl.nv) mdl.dof_damping[dofAdr] = w.crumple.dampingAfter;
};

/** Re-break, without ceremony, every weld the main thread says is already gone. */
const applyBrokenWelds = () => {
  if (!data || brokenWeldKeys.size === 0) return;
  for (const w of breakableWelds) {
    if (!brokenWeldKeys.has(w.key)) continue;
    data.eq_active[w.eqIndex] = 0;
    releaseCrumple(w);
  }
};

/**
 * Has anything given way this step?
 *
 * Costs nothing when the scene has no breakable welds in it, which is every
 * scene that existed before this feature — the early return is the first line.
 */
/** Set for the length of a headless run, which collects its breaks here instead of posting them. */
let headlessBreaks: ConstraintBrokenEvent[] | null = null;

const checkConstraintBreaks = () => {
  if (breakableWelds.length === 0) return;
  const dat = data;
  const mj = mujoco;
  if (!dat || !mj) return;
  // Nothing breaks while the scene is still settling onto its supports: see
  // BREAK_ARM_S.
  if (dat.time < BREAK_ARM_S) {
    for (const w of breakableWelds) w.consecutive = 0;
    return;
  }

  const equalityType = mj.mjtConstraint.mjCNSTR_EQUALITY.value;
  const nefc = dat.nefc;
  if (nefc === 0) return;

  // A weld contributes six rows: three of force, three of torque. Found by
  // scanning rather than by assuming an offset — the row order follows the
  // solver's constraint ordering, which is not ours to predict — but in ONE
  // pass for all welds, with the views taken once. Every `dat.efc_*` read is an
  // embind getter that allocates a fresh typed array, and this used to make
  // three of them per row, per weld, per step.
  const efcType = dat.efc_type;
  const efcId = dat.efc_id;
  const efcForce = dat.efc_force;
  const rowsOf = new Map<number, number[]>();
  for (const w of breakableWelds) {
    if (!brokenWeldKeys.has(w.key)) rowsOf.set(w.eqIndex, []);
  }
  if (rowsOf.size === 0) return;
  for (let i = 0; i < nefc; i++) {
    if (efcType[i] !== equalityType) continue;
    const rows = rowsOf.get(efcId[i]);
    if (rows && rows.length < 6) rows.push(efcForce[i]);
  }

  let xmat: ArrayLike<number> | null = null;
  const release = (w: BreakableWeld, forceN: number, torqueNm: number, cause: ReturnType<typeof weldOverload>['cause']) => {
    dat.eq_active[w.eqIndex] = 0;
    releaseCrumple(w);
    brokenWeldKeys.add(w.key);
    const event: ConstraintBrokenEvent = {
      key: w.key,
      nodeId: w.nodeId,
      targetId: w.targetId,
      kind: w.kind ?? (w.crumple ? 'crumple' : 'weld'),
      ...(cause ? { cause } : {}),
      time: dat.time,
      forceN,
      torqueNm,
    };
    // A headless run's breaks are its own: posted, the store took them as the
    // live scene's, and the next live build started with those welds broken.
    if (headlessBreaks) headlessBreaks.push(event);
    else post({ type: 'CONSTRAINT_BROKEN', ...event });
  };
  for (const w of breakableWelds) {
    if (brokenWeldKeys.has(w.key)) continue;
    const rows = rowsOf.get(w.eqIndex);
    if (!rows || rows.length === 0) continue;
    const [fx = 0, fy = 0, fz = 0, tx = 0, ty = 0, tz = 0] = rows;

    const forceN = Math.sqrt(fx * fx + fy * fy + fz * fz);
    let torqueNm = weldTorque(tx, ty, tz);
    // The push along a member or a rod in a joint. See axialPush.
    let compressionN = 0;
    if (w.axis) {
      const frames = (xmat ??= dat.xmat as ArrayLike<number>);
      compressionN = axialPush([fx, fy, fz], frames, model!.eq_obj1id[w.eqIndex], w.axis);
      // A bar is judged by which way it is bent.
      if (w.bar && w.cfg.weldBreakTorqueNm !== undefined) {
        const t = toBodyFrame([tx / 2, ty / 2, tz / 2], frames, model!.eq_obj1id[w.eqIndex]);
        torqueNm = barBending(t, w.axis, w.bar.wide, w.cfg.weldBreakTorqueNm, w.bar.strongNm);
      }
    }
    const verdict = weldOverload(forceN, torqueNm, w.cfg, w.consecutive, compressionN);
    w.consecutive = verdict.consecutive;
    if (!verdict.broken) continue;

    release(w, forceN, torqueNm, verdict.cause);
    if (w.also) {
      const other = breakableWelds.find((x) => x.key === w.also);
      if (other && !brokenWeldKeys.has(other.key)) release(other, forceN, torqueNm, verdict.cause);
    }
  }
};


// ---- Impacts --------------------------------------------------------------
//
// Detected by workers/impactWatch.ts, which the headless run and the tests use
// too. Live, each blow goes up to the store, which decides whether to shatter
// or dent; a headless run keeps them for itself (`headlessImpacts`).

let impactWatches: ImpactWatches = { watches: [], bodyIdToNodeId: {} };
/** Set for the length of a headless run, which collects its impacts here instead of posting them. */
let headlessImpacts: ImpactEvent[] | null = null;

const rebuildImpactWatches = () => {
  impactWatches = buildImpactWatches(model, sceneGraph.nodes, bodyIdCache, jointIdCache);
};

/** Has anything been hit hard enough to care about this step? */
const checkImpacts = (dt: number) => {
  if (impactWatches.watches.length === 0) return;
  for (const event of detectImpacts(impactWatches, model, data, dt)) {
    if (headlessImpacts) headlessImpacts.push(event);
    else post({ type: 'IMPACT', ...event });
  }
};

/*
 * Holding a freshly built model still until the main thread is drawing it.
 *
 * A body shatters, the model is rebuilt with its pieces, and the build blocks
 * this worker for a while — a hundred milliseconds or so for the first break
 * of a scene. Two things then used to happen off screen. The TICKs that
 * queued up during the build were all stepped on arrival, lurching the world
 * forward by however long the build took; and the main thread, busy with the
 * impact, took as long again to swap the new model in. Meanwhile the screen
 * showed the old model's last frame. By the time the pieces appeared they
 * were a fifth of a metre on from the vase the eye was following.
 *
 * So after such a build nothing is stepped until RESUME says the new model is
 * on screen (or `HOLD_FOR_INSTALL_MS` passes, so a lost message cannot freeze
 * the scene), and ticks posted before that are dropped rather than caught up.
 * The world pauses for a beat instead of jumping.
 */
const HOLD_FOR_INSTALL_MS = 500;
let holdUntil = 0; // performance.now() deadline; 0 = not holding
let tickFloor = 0; // Date.now(): TICKs posted before this are a stale backlog

const endHold = () => {
  holdUntil = 0;
  scriptTiming.restart();
  tickFloor = Date.now();
  accumulator = 0;
  lastTickTime = performance.now();
};

/**
 * The joint forces a linked Volt is applying this STEP_FOR, added every step
 * after `qfrc_applied` is cleared. Empty whenever no STEP_FOR is running.
 */
let linkForces: ResolvedInput[] = [];

/** Names of the joints the scene gives an initial velocity. */
const initialVelocityJointNames = (nodes: SceneNode[]): string[] => {
  const out: string[] = [];
  const walk = (list: SceneNode[]) => {
    for (const node of list || []) {
      node.joints?.forEach((j) => { if (j.initialVelocity?.some((v) => v !== 0)) out.push(j.name); });
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
};

/**
 * One model step, with everything a step does besides `mj_step`: forces,
 * scripts, damping, breaks, impacts, history. False when the step failed or
 * went to NaN, which has already been reported and has stopped play.
 */
/** Clear differential audio/watch state and silence any active continuous audio channels. */
const resetAudioWatchState = () => {
  prevConstraintDof = null;
  prevStringVelDof = null;
  for (const w of jointStopWatches) w.initialized = false;
  for (const w of clothTrailingWatches) w.initialized = false;
  pendingAudioImpacts.clear();
  lastAudioEmitSim.clear();
  pendingAeroSnaps.clear();
  bowContactStartSimTime.clear();
  recentBowEvents.clear();
  prevActiveStringsByBow.clear();
  continuousPairStartSimTime.clear();
  if (hadActiveBowedStrings) {
    hadActiveBowedStrings = false;
    post({ type: 'BOWED_STRINGS', contacts: [] });
  }
  if (hadActiveFrictionContacts) {
    hadActiveFrictionContacts = false;
    post({ type: 'CONTACT_FRICTION', contacts: [] });
  }
  if (hadActiveDampingContacts) {
    hadActiveDampingContacts = false;
    post({ type: 'AUDIO_DAMPING', contacts: [] });
  }
  if (hadActiveAeroVoices) {
    hadActiveAeroVoices = false;
    post({ type: 'AERO_AUDIO', voices: [], snaps: [] });
  }
};

const stepOnce = (stepSize: number): boolean => {
  if (!model || !data || !mujoco) return false;
  try {
    data.xfrc_applied.fill(0);
    data.qfrc_applied.fill(0);

    applyDragForce();
    applyJointForces(data, linkForces);
    applyHydroAndFlexureForces(stepSize);
    applyMagnetForces(magnetBodies, data);

    const aeroDiagnostics: Record<string, AeroDiagnostic> = {};
    const scriptStart = performance.now();
    executeScripts(sceneGraph.nodes, aeroDiagnostics);
    scriptTiming.addStep(performance.now() - scriptStart);
    applyCompositeAeroForces();
    applyFreeJointDamping(sceneGraph.nodes);
    wakeBodies();

    const prevTime = data.time;
    // The clock alone misses a reset on the first step (it also ends at one
    // timestep), so the reset warning is watched as well. See mujocoAutoReset.
    const prevResets = autoResetCount(data);
    mujoco.mj_step(model, data);
    if (data.time <= prevTime || autoResetCount(data) !== prevResets) {
      const message = prevTime === 0
        ? 'Simulation diverged on its first step: MuJoCo reset it to the starting pose at rest — simulation stopped.' +
          wipedInitialVelocityNote(initialVelocityJointNames(sceneGraph.nodes))
        : 'Simulation diverged (solver auto-reset detected) — simulation stopped.';
      resetAudioWatchState();
      post({ type: 'ERROR', message, fatal: false });
      isPlaying = false;
      return false;
    }
    // Check finiteness immediately after mj_step, before running cloth,
    // kinematics, breaks, impacts, audio, or history side effects.
    // One view, not one per element: every `data.qpos` / `data.qvel` read is an
    // embind getter that allocates a fresh Float64Array over the heap.
    const qpos = data.qpos;
    const nq = model.nq;
    for (let j = 0; j < nq; j++) {
      if (!Number.isFinite(qpos[j])) {
        resetAudioWatchState();
        post({ type: 'ERROR', message: 'NaN or Inf detected in qpos — simulation stopped.', fatal: false });
        isPlaying = false;
        return false;
      }
    }
    const qvel = data.qvel;
    const nv = model.nv;
    for (let j = 0; j < nv; j++) {
      if (!Number.isFinite(qvel[j])) {
        resetAudioWatchState();
        post({ type: 'ERROR', message: 'NaN or Inf detected in qvel — simulation stopped.', fatal: false });
        isPlaying = false;
        return false;
      }
    }

    stepCloth(stepSize);
    // Bodies to the instant the joints are at, for everything read from here on.
    syncKinematics(mujoco, model, data);
    checkConstraintBreaks();
    checkImpacts(stepSize);
    sampleAudioImpacts(stepSize);
    sampleAeroSnaps(stepSize);
    stepCount++;

    if (stepCount % 10 === 0) {
      const entry = buildHistoryEntry(aeroDiagnostics);
      history.push(entry);
    }
    return true;
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    const fatal = /Aborted|enlarge memory|abort|bad_alloc/i.test(msg);
    resetAudioWatchState();
    post({
      type: 'ERROR',
      message: msg,
      fatal,
      lastState: fatal
        ? { qpos: Array.from(data.qpos), qvel: Array.from(data.qvel), ctrl: Array.from(data.ctrl), time: data.time, scriptState: scriptState.snapshot() }
        : undefined,
    });
    isPlaying = false;
    return false;
  }
};

/**
 * A linked Volt's slice: hold `inputs` for `dtMs` of model time, then read
 * `outputs`. Runs whether or not the scene is playing — while linked it is
 * not, and this is the only thing that moves it.
 */
const stepFor = (dtMs: number, inputs: Record<string, number>, outputNames: string[]) => {
  if (!model || !data || !mujoco) return { ok: false as const, error: 'No model is built.' };
  const { resolved, unknown: unknownInputs } = resolveInputs(mujoco, model, inputs);
  applyCtrlInputs(data, resolved);
  setJointParams(mujoco, model, data, resolved);
  linkForces = resolved;
  const stepSize = modelOpt(model).timestep;
  // The slice in equal steps that end exactly on it, finer still where a
  // position-dependent force is stiff; the scene's own timestep is put back.
  const base = stepsFor(dtMs, stepSize);
  const sub = base > 0 ? substepsFor(model, data, resolved, stepSize) : 1;
  const n = base * sub;
  const h = n > 0 ? dtMs / 1000 / n : stepSize;
  if (h !== stepSize) model.opt.timestep = h;
  let steps = 0;
  try {
    for (; steps < n; steps++) if (!stepOnce(h)) break;
  } finally {
    linkForces = [];
    if (h !== stepSize) model.opt.timestep = stepSize;
  }
  if (steps < n) return { ok: false as const, error: 'The scene failed mid-step; see Mesh for the reason.' };
  // A read with no steps behind it still wants the derived quantities current.
  if (n === 0) mujoco.mj_forward(model, data);
  const { outputs, unknown: unknownOutputs } = readOutputs(mujoco, model, data, outputNames);
  if (n > 0) postFrame();
  return { ok: true as const, t: data.time, steps, outputs, unknown: [...unknownInputs, ...unknownOutputs] };
};

/** With cloth in the scene a frame stops stepping after this much work and lets the rest go: slow motion, smoothly. */
const CLOTH_FRAME_BUDGET_MS = 24;

const stepTick = (delta: number) => {
  if (!isPlaying || !model || !data || !mujoco) return;
  if (holdUntil) {
    if (performance.now() < holdUntil) return;
    endHold();
    return;
  }
  accumulator += Math.min(delta, 0.1);

  const stepSize = modelOpt(model).timestep;
  const stepsNeeded = Math.floor(accumulator / stepSize);
  accumulator -= stepsNeeded * stepSize;

  // Cloth can cost more per step than a step is long. Rather than run every
  // step owed and post a frame a few times a second, stop at a frame's worth
  // of work and let the rest go: the cloth plays in slow motion, smoothly.
  const budgetEnd = cloth ? performance.now() + CLOTH_FRAME_BUDGET_MS : Infinity;
  for (let i = 0; i < stepsNeeded; i++) {
    if (!stepOnce(stepSize)) return;
    if (performance.now() > budgetEnd) { accumulator = 0; break; }
  }
  // How fast the sim is keeping up, and what the scripts cost: see ScriptTiming.
  if (scriptTiming.tick(performance.now(), data.time)) scriptStatusDue = true;

  if (stepsNeeded > 0) framePending = true;
  if (framePending && (!isSharedSupported || performance.now() - lastFramePost >= FRAME_INTERVAL_MS - 2)) {
    postFrame();
  }
};

/*
 * How often the worker steps and posts a frame when it paces itself.
 *
 * With shared memory the worker paces itself at display rate (FRAME_INTERVAL_MS):
 * each tick steps the full frame's burst in one go, updates sharedBuffers, and
 * posts a FRAME. When a tick finishes ahead of real time (`remaining > 1 ms`),
 * it sleeps for `remaining` ms until the next frame boundary; when behind real
 * time (`remaining <= 1 ms`), it yields via MessageChannel (`0 ms` gap) so
 * incoming messages still run on the event loop without wasting 4+ ms of dead
 * timer sleep or cooling the step thread pool.
 */
const FRAME_INTERVAL_MS = 16;
let lastFramePost = 0;
let framePending = false;

/** When SCRIPT_STATUS was last posted, and whether something new is waiting to be. */
let lastScriptStatusPost = 0;
let scriptStatusDue = true;
let lastStatusVersion = -1;
const SCRIPT_STATUS_INTERVAL_MS = 500;

/**
 * Tells the main thread what the live scripts got wrong and cost, for
 * physics_get_state. Throttled to SCRIPT_STATUS_INTERVAL_MS unless `force`.
 */
const postScriptStatus = (force = false) => {
  const now = performance.now();
  if (scriptProblems.version !== lastStatusVersion) scriptStatusDue = true;
  // Counts change every step a script fails; those ride along on the timed post.
  if (!force && (now - lastScriptStatusPost < SCRIPT_STATUS_INTERVAL_MS || (!scriptStatusDue && !(isPlaying && scriptProblems.size)))) return;
  lastScriptStatusPost = now;
  scriptStatusDue = false;
  lastStatusVersion = scriptProblems.version;
  const problems = scriptProblems.list();
  post({
    type: 'SCRIPT_STATUS',
    problems: problems.slice(0, 20),
    moreProblems: Math.max(0, problems.length - 20) + scriptProblems.overflow,
    timing: scriptTiming.last,
    timestepMs: model ? modelOpt(model).timestep * 1000 : 0,
  });
};

/** The loads on the cloth's ties, zip states, and state snapshot for worker recycles. */
const clothFrame = () => {
  const ties = cloth?.sim?.tieLoads(), zips = cloth?.sim?.zipState(), clothState = cloth?.sim?.state();
  return {
    ...(ties?.length ? { clothTies: ties } : {}),
    ...(zips?.length ? { clothZips: zips } : {}),
    ...(clothState ? { clothState } : {}),
  };
};

const postFrame = () => {
  framePending = false;
  lastFramePost = performance.now();
  postScriptStatus();
  flushAeroAudio();
  flushAudioImpacts();
  flushBowedStrings();
  const snap = snapshot();
  if (isSharedSupported) {
    post({ type: 'FRAME', time: snap.time, heapBytes: snap.heapBytes, isShared: true, scriptState: scriptState.snapshot(), ...clothFrame() });
  } else {
    post({ type: 'FRAME', ...snap, isShared: false, scriptState: scriptState.snapshot(), ...clothFrame() }, [
      snap.qpos.buffer, snap.qvel.buffer, snap.ctrl.buffer,
      snap.xfrc_applied.buffer, snap.qfrc_applied.buffer,
      snap.xpos.buffer, snap.xmat.buffer, snap.cvel.buffer,
      snap.geom_xpos.buffer, snap.geom_xmat.buffer,
      ...(snap.flexvert_xpos ? [snap.flexvert_xpos.buffer] : []),
    ]);
  }
};

let workerLoopActive = false;
let workerTimerId: ReturnType<typeof setTimeout> | null = null;
let lastTickTime = 0;
const yieldChannel = new MessageChannel();
// Bumped by every start and stop. A yield already posted cannot be cancelled,
// so a stop then start while behind real time would otherwise leave that stale
// message running a second chain of ticks beside the new one.
let workerLoopGen = 0;

/**
 * True while a headless run has the module's model and data swapped for its
 * own. A judged run (see AskImpact) awaits the main thread mid-run, and the
 * display loop below must not step the headless model in the meantime.
 */
let headlessBusy = false;

const workerTick = (gen: number) => {
  if (gen !== workerLoopGen) return;
  workerTimerId = null;
  if (headlessBusy) {
    // Try again once it is over, without counting the wait as time to catch up.
    lastTickTime = performance.now();
    workerTimerId = setTimeout(workerTick, FRAME_INTERVAL_MS, gen);
    return;
  }
  if (!workerLoopActive || !isPlaying || !model || !data || !mujoco) {
    workerLoopActive = false;
    return;
  }
  const now = performance.now();
  const elapsedSeconds = (now - lastTickTime) / 1000;
  lastTickTime = now;

  stepTick(elapsedSeconds);
  if (!workerLoopActive || !isPlaying || !model || !data || !mujoco) {
    workerLoopActive = false;
    return;
  }
  const remaining = FRAME_INTERVAL_MS - (performance.now() - now);
  if (remaining > 1) {
    workerTimerId = setTimeout(workerTick, remaining, gen);
  } else {
    yieldChannel.port2.postMessage(gen);
  }
};
yieldChannel.port1.onmessage = (e: MessageEvent<number>) => workerTick(e.data);

const startWorkerLoop = () => {
  if (workerLoopActive) return;
  workerLoopActive = true;
  lastTickTime = performance.now();
  workerTimerId = setTimeout(workerTick, FRAME_INTERVAL_MS, ++workerLoopGen);
};

const stopWorkerLoop = () => {
  workerLoopActive = false;
  workerLoopGen++;
  if (workerTimerId) {
    clearTimeout(workerTimerId);
    workerTimerId = null;
  }
};


const buildIdMaps = () => {
  const toPlain = (rec: Record<string, number>) => ({ ...rec });
  const toRev = (rec: Record<string, number>) => {
    const rev: Record<number, string> = {};
    for (const name in rec) rev[rec[name]] = name;
    return rev;
  };
  return {
    body: toPlain(bodyIdCache), bodyRev: toRev(bodyIdCache),
    joint: toPlain(jointIdCache), jointRev: toRev(jointIdCache),
    geom: toPlain(geomIdCache), geomRev: { ...geomNameCache },
    actuator: toPlain(actuatorIdCache), actuatorRev: toRev(actuatorIdCache),
  };
};

const seedActuatorCtrl = (nodes: SceneNode[], targetData: MjData, skipActuators?: Set<string>) => {
  const actuators: SceneJoint[] = [];
  const traverse = (list: SceneNode[]) => {
    if (!list) return;
    for (const node of list) {
      node.joints?.forEach((j) => { if (j.actuator) actuators.push(j); });
      traverse(node.children);
    }
  };
  traverse(nodes);
  actuators.forEach((j, idx) => {
    if (!j.actuator || j.actuator.ctrlValue === undefined) return;
    const actName = `${j.name}_actuator`;
    if (skipActuators?.has(actName)) return;
    const actId = actuatorIdCache[actName] ?? idx;
    if (actId >= 0 && actId < targetData.ctrl.length) targetData.ctrl[actId] = j.actuator.ctrlValue;
  });
};

const copyCarriedActuators = (carried: CarriedState, newModel: MjModel, newData: MjData): Set<string> =>
  copyCarriedActuatorsByName(carried, newModel, newData, actuatorIdCache);

/**
 * Carry a running simulation into a model whose degrees of freedom changed.
 *
 * Every body that still exists goes on exactly where it was, matched by joint
 * name; a shard is put where its body is now (see rebaseShard) and anything
 * else new starts with its opening velocity. The live rebuild after a shatter
 * and the headless run's own both come through here.
 */
const carryByJointName = (carried: CarriedState, newModel: MjModel, newData: MjData) => {
  const placed = copyJointsByName(carried, newModel, newData, jointIdCache);
  const placedActuators = copyCarriedActuators(carried, newModel, newData);
  seedActuatorCtrl(sceneGraph.nodes, newData, placedActuators);
  newData.time = carried.time;
  mujoco!.mj_forward(newModel, newData);
  if (seedNewBodies(carried, newModel, newData, sceneGraph.nodes, jointIdCache, placed)) mujoco!.mj_forward(newModel, newData);
};

/**
 * Mesh files the main thread has sent, for `from_xml_string` to read.
 *
 * Lives as long as the worker. MuJoCo caches each processed mesh against its
 * file, so a mesh that stays in here is not parsed or hulled again on the next
 * rebuild, which is most of what a rebuild used to cost. The main thread's
 * `MeshFileLedger` decides what goes in and what comes out; this only obeys.
 */
let meshVfs: MjVFS | null = null;

const applyMeshFiles = (add?: { name: string; bytes: Uint8Array }[], drop?: string[]) => {
  if (!mujoco || (!add?.length && !drop?.length)) return;
  meshVfs ??= new mujoco.MjVFS();
  for (const name of drop ?? []) {
    try { meshVfs.deleteFile(name); } catch { /* never added, or already gone */ }
  }
  for (const f of add ?? []) meshVfs.addBuffer(f.name, f.bytes);
};

/** Each scripted body's script, by the name its problems are filed under. */
const scriptsByBody = (nodes: SceneNode[], into = new Map<string, string>()): Map<string, string> => {
  for (const n of nodes || []) {
    if (n.script && n.script.trim() !== '') into.set(n.name || n.id, n.script);
    scriptsByBody(n.children || [], into);
  }
  return into;
};

const doBuild = (
  xml: string,
  newSceneGraph: SceneGraph,
  preserveState: boolean,
  seedState?: SeedState,
  brokenConstraints?: string[],
) => {
  // The set speeds the running model was built with, so an edit of one can
  // win over the live ctrl carried across (see applyEditedCtrl). A fresh
  // worker has no previous scene of its own; the main thread sends it.
  const ctrlBefore = seedState ? (seedState.docCtrl ?? null) : documentCtrlValues(sceneGraph?.nodes);
  if (brokenConstraints) brokenWeldKeys = new Set(brokenConstraints);
  // Which scripts this build changes: their old mistakes no longer apply.
  const scriptsBefore = scriptsByBody(sceneGraph.nodes);
  scriptStateForBuild(scriptState, preserveState, seedState);
  /** Set when this build starts the simulation over from t = 0 (see below). */
  let freshRun = false;
  const oldModel = model;
  const oldData = data;

  if (!mujoco) throw new Error('MuJoCo module not loaded yet');

  /*
   * Take the old state as plain arrays BEFORE anything is released.
   *
   * delete() genuinely frees, and embind then throws on any access — reading
   * `oldModel.nq` after the fact does not return a stale number, it raises
   * "cannot call emscripten binding method MjModel.nq getter on deleted
   * object", which fails the whole build. So the copy-forward below cannot
   * touch the handles at all; it reads this snapshot instead.
   *
   * The joint table is the other half of it. Carrying state across a rebuild
   * that CHANGES the degrees of freedom — a body shattering into a dozen
   * shards — cannot be a straight array copy, because every address after the
   * new bodies shifts. Matching by joint NAME survives that, and it is the only
   * thing that does.
   */
  const carried = captureState(oldModel, oldData, jointIdCache, actuatorIdCache);

  /*
   * Release the previous model and data.
   *
   * These used to call `free()`, which is not part of @mujoco/mujoco's embind
   * surface — a ClassHandle exposes delete() — so every one threw straight into
   * its own catch and released nothing. A whole MjModel + MjData was stranded in
   * WASM linear memory on EVERY rebuild: measured at ~13 MB a build on a scene of
   * one box. Memory only ever grows inside a realm and the build has a hard
   * 2^31-byte ceiling, which is what the proactive recycles in useStore exist to
   * stay clear of.
   *
   * delete() genuinely frees, so this is only safe because nothing outlives the
   * swap: BuiltResult is all Array.from copies, sharedBuffers are separately
   * allocated and written by .set(), and stepTick re-reads these module globals
   * on every call and is driven by TICK messages — doBuild is synchronous, so no
   * step can interleave with it. runHeadless below has always done exactly this.
   *
   * Data before model: MjData is the dependent object. The try/catch stays so a
   * handle that somehow went already — a double build, a partial failure — still
   * cannot fail the build that is replacing it.
   */
  if (oldData) { try { oldData.delete(); } catch { /* already gone */ } }
  if (oldModel) { try { oldModel.delete(); } catch { /* already gone */ } }
  /*
   * Drop the globals in the same breath.
   *
   * from_xml_string below throws on any scene MuJoCo will not accept, which is
   * an ordinary thing for a user to produce. While free() released nothing that
   * was harmless — the globals still pointed at a live model. Now they would
   * point at freed memory until the assignment further down, and a TICK arriving
   * on a failed build would step a deleted model. Nulling them makes stepTick's
   * own `!model || !data` guard the thing that catches it.
   */
  model = null;
  data = null;

  let newModel: MjModel | null = null;
  let newData: MjData | null = null;
  try {
    newModel = meshVfs ? mujoco.MjModel.from_xml_string(xml, meshVfs) : mujoco.MjModel.from_xml_string(xml);
    newData = new mujoco.MjData(newModel);
    if (threaded) mujoco.mju_threadpool(newData, STEP_THREADS);
  } catch (e) {
    if (newData) { try { newData.delete(); } catch { /* ignore */ } }
    if (newModel) { try { newModel.delete(); } catch { /* ignore */ } }
    throw e;
  }

  model = newModel;
  data = newData;
  sceneGraph = newSceneGraph;
  rebuildIdCaches();
  rebuildBreakableWelds();
  rebuildImpactWatches();
  pendingWake.clear(); // body ids from the old model mean nothing in this one
  envWaterBasins = collectWaterBasins(sceneGraph.nodes);
  rebuildHydroAndFlexureCaches();
  magnetBodies = collectMagnetBodies(sceneGraph.nodes, bodyIdCache, model);
  scriptCache = {};

  // Explicit seed state (from the main thread's live mirror) takes priority
  // over the same-worker oldModel/oldData copy-forward below — this is what
  // lets a *freshly spawned* worker (no oldModel of its own) still carry over
  // exactly where the simulation was, e.g. for a seamless proactive memory
  // recycle mid-play rather than a visible reset to the initial pose.
  if (seedState && seedState.qpos.length === newModel.nq && seedState.qvel.length === newModel.nv) {
    for (let i = 0; i < seedState.qpos.length; i++) newData.qpos[i] = seedState.qpos[i];
    for (let i = 0; i < seedState.qvel.length; i++) newData.qvel[i] = seedState.qvel[i];
    if (seedState.ctrl) for (let i = 0; i < Math.min(seedState.ctrl.length, newModel.nu); i++) newData.ctrl[i] = seedState.ctrl[i];
    applyEditedCtrl(ctrlBefore, sceneGraph.nodes, newModel, newData, actuatorIdCache);
    newData.time = seedState.time;
    mujoco.mj_forward(newModel, newData);
  } else if (preserveState && carried && carried.nq === newModel.nq && carried.nv === newModel.nv) {
    const nq = Math.min(carried.nq, newModel.nq);
    const nv = Math.min(carried.nv, newModel.nv);
    for (let i = 0; i < nq; i++) newData.qpos[i] = carried.qpos[i];
    for (let i = 0; i < nv; i++) newData.qvel[i] = carried.qvel[i];
    const placedActuators = copyCarriedActuators(carried, newModel, newData);
    seedActuatorCtrl(sceneGraph.nodes, newData, placedActuators);
    applyEditedCtrl(ctrlBefore, sceneGraph.nodes, newModel, newData, actuatorIdCache);
    newData.time = carried.time;
    mujoco.mj_forward(newModel, newData);
  } else if (carried && preserveState) {
    /*
     * The degrees of freedom changed, so there is no array to copy.
     *
     * This is the case a body shattering creates: a dozen new free joints
     * appear, every address after them moves, and the straight copy above would
     * be nonsense even where it fitted. Matching by joint NAME carries every
     * body that still exists exactly where it was, and leaves the new ones to
     * be placed by the document — which for a shard is where it broke, with the
     * velocity of the point it used to be riding on its initialVelocity.
     *
     * Without this, shattering one vase resets the whole scene to its opening
     * pose: everything else in mid-air snaps back to where it started.
     */
    carryByJointName(carried, newModel, newData);
    applyEditedCtrl(ctrlBefore, sceneGraph.nodes, newModel, newData, actuatorIdCache);
  } else {
    freshRun = true;
    seedActuatorCtrl(sceneGraph.nodes, newData);

    mujoco.mj_forward(newModel, newData);

    const initVelJoints: { name: string; vel: number[] }[] = [];
    const traverseVel = (nodes: SceneNode[]) => {
      if (!nodes) return;
      for (const node of nodes) {
        node.joints?.forEach((j) => { if (j.initialVelocity) initVelJoints.push({ name: j.name, vel: j.initialVelocity }); });
        traverseVel(node.children);
      }
    };
    traverseVel(sceneGraph.nodes);

    let needForward = false;
    const jntType = newModel.jnt_type;
    const jntDofadr = newModel.jnt_dofadr;
    const newQvel = newData.qvel;
    for (const j of initVelJoints) {
      const jntId = jointIdCache[j.name];
      if (jntId !== undefined && writeInitialVelocity(jntType, jntDofadr, newModel.nv, newQvel, jntId, j.vel)) {
        needForward = true;
      }
    }
    if (needForward) mujoco.mj_forward(newModel, newData);
  }

  // The cloth, built after the model so it can read where the bodies are; a
  // rebuild that carried the scene over carries the cloth with it.
  buildCloth(!freshRun, !freshRun ? seedState?.clothState : undefined);
  post({ type: 'CLOTH_STATUS', warnings: cloth?.warnings ?? [] });

  // Last, so nothing above can put a broken weld back together. A rebuild is
  // the one moment a break can be silently undone — the model is new, every
  // eq_active row starts at 1, and the recycle timer fires one of these every
  // twenty seconds of play.
  applyBrokenWelds();

  if (isSharedSupported) {
    const createSharedArray = (size: number) => new Float64Array(new SharedArrayBuffer(size * 8));
    sharedBuffers = {
      qpos: createSharedArray(newModel.nq),
      qvel: createSharedArray(newModel.nv),
      ctrl: createSharedArray(newModel.nu),
      xfrc_applied: createSharedArray(newModel.nbody * 6),
      qfrc_applied: createSharedArray(newModel.nv),
      xpos: createSharedArray(newModel.nbody * 3),
      xmat: createSharedArray(newModel.nbody * 9),
      cvel: createSharedArray(newModel.nbody * 6),
      geom_xpos: createSharedArray(newModel.ngeom * 3),
      geom_xmat: createSharedArray(newModel.ngeom * 9),
      flexvert_xpos: createSharedArray(cloth ? 3 * cloth.sim.renderSize() : 0),
    };
    // Filled now, not at the next step: the viewport reads it as soon as the
    // model arrives, and read empty it drew the cloth at the origin (a
    // garment flashed up, then vanished until something asked for a frame).
    if (cloth && sharedBuffers.flexvert_xpos?.length) cloth.sim.writeRender(sharedBuffers.flexvert_xpos);
  } else {
    sharedBuffers = {};
  }

  /*
   * History belongs to one continuous run. A build that carries the running
   * simulation across (an edit mid-play, a shatter, a recycle's seed) keeps
   * it: time goes on from where it was. A build that starts over from t = 0 —
   * a new scene, a preset, Reset, an undo, a structural edit — clears it, and
   * records the new opening state as its first frame. Kept, scene B's frames
   * were appended after scene A's (time running 29 s back to 0, which
   * since_time cannot separate) and get_telemetry went on answering with
   * scene A's last frame.
   */
  if (freshRun) {
    history.clear();
    history.push(buildHistoryEntry({}));
    scriptProblems.clear();
    scriptLogs.clear();
    pendingAudioImpacts.clear();
    lastAudioEmitSim.clear();
  } else {
    const after = scriptsByBody(sceneGraph.nodes);
    const changed = new Set<string>();
    for (const [body, src] of after) if (scriptsBefore.get(body) !== src) changed.add(body);
    for (const body of scriptsBefore.keys()) if (!after.has(body)) changed.add(body);
    if (changed.size) scriptProblems.clearBodies(changed);
  }
  scriptTiming.restart();
  accumulator = 0;

  return {
    nq: newModel.nq, nv: newModel.nv, nu: newModel.nu, ngeom: newModel.ngeom, nbody: newModel.nbody,
    timestep: newModel.opt.timestep,
    geom_size: Array.from(newModel.geom_size as ArrayLike<number>),
    geom_type: Array.from(newModel.geom_type as ArrayLike<number>),
    geom_bodyid: Array.from(newModel.geom_bodyid as ArrayLike<number>),
    geom_rgba: Array.from(newModel.geom_rgba as ArrayLike<number>),
    body_mass: Array.from(newModel.body_mass as ArrayLike<number>),
    body_inertia: Array.from(newModel.body_inertia as ArrayLike<number>),
    body_ipos: Array.from(newModel.body_ipos as ArrayLike<number>),
    body_iquat: Array.from(newModel.body_iquat as ArrayLike<number>),
    body_dofnum: Array.from(newModel.body_dofnum as ArrayLike<number>),
    body_parentid: Array.from(newModel.body_parentid as ArrayLike<number>),
    jnt_qposadr: Array.from(newModel.jnt_qposadr as ArrayLike<number>),
    jnt_dofadr: Array.from(newModel.jnt_dofadr as ArrayLike<number>),
    idMaps: buildIdMaps(),
    flexes: cloth?.sim?.renderLayout() ?? [],
    clothLayoutId: noteClothLayout(),
    clothStitches: [],
    ...(cloth ? { clothState: cloth.sim.state() } : {}),
    isShared: isSharedSupported,
    ...snapshot(),
  };
};

// Runs a fully isolated headless simulation (its own MjModel/MjData, built
// from the same already-loaded `mujoco` module — never a second loaded WASM
// module) for MCP's physics_run_headless. Reuses executeScripts/
// applyFreeJointDamping/buildHistoryEntry/rebuildIdCaches by temporarily
// pointing the module-level model/data/sceneGraph/caches at the headless
// instance for the (fully synchronous, non-yielding) duration of the run,
// then restoring the live simulation's exactly as it was in a `finally`.
// This guarantees a headless "what-if" run can never diverge from — or
// disturb — what's actually rendered live, and never touches a second WASM
// module (no doubled memory/network cost).
// Reads MuJoCo's own warning counters off an MjData. This replaced a
// `mujoco.on_warning = ...` assignment that looked like a warning hook but is
// not part of the wasm build's API at all — it simply stuck a property on the
// module object, was never called, and left `warnings` empty on every single
// headless reply, including the diverging runs that most needed one.
const collectMujocoWarnings = (d: MjData): string[] => {
  const out: string[] = [];
  if (!mujoco) return out;
  try {
    const stats = d.warning;
    const n = stats.size();
    for (let i = 0; i < n; i++) {
      const stat = stats.get(i);
      if (!stat) continue;
      if (stat.number > 0) {
        let text = `warning ${i}`;
        try { text = mujoco.mju_warningText(i, stat.lastinfo); } catch { /* keep the index */ }
        out.push(`${text} (x${stat.number})`);
      }
      stat.delete?.();
    }
    // Unlike the contact vector in snapshot(), this one is NOT a copy: it is a
    // view onto the MjData's own warning array. Deleting it freed memory the
    // MjData still owned, so the headless MjData's delete() freed it twice and
    // the threaded build aborted the module, leaving every headless run and
    // the tab's physics dead. Its members are copies and are released above.
  } catch { /* warning stats are diagnostics; never fail a run over them */ }
  return out;
};

/**
 * Asks the main thread what a blow did, the way the live run hands IMPACT to
 * the store: resolves with the model to go on with when it broke something.
 */
type AskImpact = (event: ImpactEvent) => Promise<HeadlessRebuild | undefined>;

const runHeadless = async (
  xml: string,
  headlessSceneGraph: SceneGraph,
  ticks: number,
  stride = 1,
  askImpact?: AskImpact,
  frameContacts = true,
  headlessWaterLevel: number | null = envWaterLevel,
  headlessHydroModels?: HydroBodyModel[],
  headlessWaterBasins: WaterBasinWorld[] = envWaterBasins,
): Promise<HeadlessRunResult> => {
  if (!mujoco) throw new Error('MuJoCo module not loaded yet');
  const mj = mujoco;

  const savedModel = model, savedData = data, savedSceneGraph = sceneGraph;
  const savedMagnetBodies = magnetBodies;
  const savedCachedHydro = cachedHydroByNodeId;
  const savedHydroByBodyId = hydroByBodyId;
  const savedBistableJoints = bistableJoints;
  const savedJointStopWatches = jointStopWatches;
  const savedDofForceScale = dofForceScale;
  const savedAcousticStringBodyIds = acousticStringBodyIds;
  const savedAcousticStringAxis = acousticStringAxisByBodyId;
  const savedAcousticStringSpan = acousticStringSpanByBodyId;
  const savedAcousticBowBodyIds = acousticBowBodyIds;
  const savedAcousticBowSpec = acousticBowSpecByBodyId;
  const savedDistinctAcousticChildIds = distinctAcousticChildBodyIds;
  const savedWindSubtreeIds = windSubtreeBodyIds;
  const savedBodyRoughness = bodyRoughnessByBodyId;
  const savedBodySoftness = bodySoftnessByBodyId;
  const savedRimCapableIds = rimCapableBodyIds;
  const savedGeomRollingRadius = geomRollingRadius;
  const savedAeroCoveredIds = aeroCoveredBodyIds;
  const savedBluffBodyAero = bluffBodyAeroByBodyId;
  const savedAeroVoiceGroups = aeroVoiceGroups;
  const savedAeroBladeGroupByNodeId = aeroBladeGroupByNodeId;
  const savedClothTrailingWatches = clothTrailingWatches;
  const savedBowStartMap = new Map(bowContactStartSimTime);
  const savedRecentStopMap = new Map(recentStopByStringBody);
  const savedRecentBowEvents = new Map(recentBowEvents);
  const savedPrevActiveByBow = new Map(
    Array.from(prevActiveStringsByBow.entries(), ([k, v]) => [k, new Set(v)]),
  );
  const savedPluckTouchSite = new Map(recentPluckTouchSite);
  const savedContinuousPairStart = new Map(continuousPairStartSimTime);
  const savedLastNodeStrike = new Map(lastNodeStrikeSimTime);
  const savedPendingAeroSnaps = new Map(pendingAeroSnaps);
  const savedCloth = cloth;
  // A headless run starts its scripts from nothing and must not leave its
  // state or compiled closures in the live scene's.
  const savedScriptState = scriptState;
  const savedScriptCache = scriptCache;
  const savedPendingWake = new Set(pendingWake);
  scriptState = new ScriptStateStore();
  scriptCache = {};
  pendingWake.clear();
  const savedBodyIdCache = bodyIdCache, savedJointIdCache = jointIdCache;
  const savedGeomIdCache = geomIdCache, savedGeomNameCache = geomNameCache, savedActuatorIdCache = actuatorIdCache;
  const savedBodyNodeById = bodyNodeById, savedJointInfos = jointInfos;
  // breakableWelds holds indices into the LIVE model's equality list, so it has
  // to be swapped out with everything else or the headless run would break
  // welds by the interactive model's numbering.
  const savedBreakableWelds = breakableWelds, savedBrokenWeldKeys = brokenWeldKeys;
  const breaks: ConstraintBrokenEvent[] = [];
  headlessBreaks = breaks;
  // Blows are watched only when someone will judge them; see AskImpact.
  const savedImpactWatches = impactWatches;
  const impacts: ImpactEvent[] = [];
  headlessImpacts = impacts;
  headlessBusy = true;

  const warnings: string[] = [];
  const savedScriptProblems = scriptProblems, savedScriptLogs = scriptLogs, savedScriptTiming = scriptTiming;
  scriptProblems = new ScriptProblemLog();
  scriptLogs = new ScriptLogRing(200);
  scriptTiming = new ScriptTiming();
  let scriptMs = 0;
  const wallStart = performance.now();

  let headlessModel: MjModel | null = null;
  let headlessData: MjData | null = null;
  const watchImpacts = () => {
    if (askImpact) rebuildImpactWatches();
    else impactWatches = { watches: [], bodyIdToNodeId: {} };
  };
  try {
    if (threaded && savedData) mj.mju_threadpool(savedData, 0);
    headlessModel = meshVfs ? mj.MjModel.from_xml_string(xml, meshVfs) : mj.MjModel.from_xml_string(xml);
    headlessData = new mj.MjData(headlessModel);
    if (threaded) mj.mju_threadpool(headlessData, STEP_THREADS);

    model = headlessModel;
    data = headlessData;
    sceneGraph = headlessSceneGraph;
    rebuildIdCaches();
    brokenWeldKeys = new Set();
    rebuildBreakableWelds();
    watchImpacts();
    rebuildHydroAndFlexureCaches(headlessHydroModels, headlessWaterLevel, headlessWaterBasins);
    magnetBodies = collectMagnetBodies(sceneGraph.nodes, bodyIdCache, model);

    seedActuatorCtrl(sceneGraph.nodes, data);
    mujoco.mj_forward(model, data);
    buildCloth(false);

    const initVelJoints: { name: string; vel: number[] }[] = [];
    const traverseVel = (nodes: SceneNode[]) => {
      if (!nodes) return;
      for (const node of nodes) {
        node.joints?.forEach((j) => { if (j.initialVelocity) initVelJoints.push({ name: j.name, vel: j.initialVelocity }); });
        traverseVel(node.children);
      }
    };
    traverseVel(sceneGraph.nodes);
    let needForward = false;
    const initialVelocityJoints: string[] = [];
    const jntType = model.jnt_type;
    const jntDofadr = model.jnt_dofadr;
    const qvel = data.qvel;
    for (const j of initVelJoints) {
      const jntId = jointIdCache[j.name];
      if (jntId !== undefined && writeInitialVelocity(jntType, jntDofadr, model.nv, qvel, jntId, j.vel)) {
        needForward = true;
        const jntNv = JOINT_NV[jntType[jntId]] ?? 1;
        const count = Math.min(j.vel.length, jntNv, Math.max(0, model.nv - jntDofadr[jntId]));
        for (let i = 0; i < count; i++) {
          if (typeof j.vel[i] === 'number' && Number.isFinite(j.vel[i]) && j.vel[i] !== 0) {
            initialVelocityJoints.push(j.name);
            break;
          }
        }
      }
    }
    if (needForward) mujoco.mj_forward(model, data);

    // The per-tick aero diagnostics of the most recently stepped tick, so the
    // (possibly deferred) sample() below reports the tick it belongs to.
    let lastAero: Record<string, AeroDiagnostic> = {};
    // Every tick, not every frame: a pin that opens for a few ticks and
    // closes again between two sampled frames has still let go.
    let constraints = createConstraintMonitor(mujoco, model);
    // Energy the contacts put in: an explosion that never goes non-finite.
    let solverWork = createSolverWorkMonitor(mujoco, model);
    let energyGain: SolverEnergyGain | null = null;
    // What the models before a mid-run rebuild did to their constraints.
    const earlierReports: ConstraintReport[] = [];
    let timestep = modelOpt(model).timestep;

    /*
     * Go on with the pieces of a body that has just shattered: the same
     * rebuild the live run makes (carryByJointName) at the very tick of the
     * blow, so nothing has moved on in between and the shards start exactly
     * where the body was, with the velocity of the part of it each one was.
     */
    const rebuildMidRun = (rebuild: HeadlessRebuild) => {
      applyMeshFiles(rebuild.meshFiles, rebuild.dropMeshes);
      // Release the stepping threadpool before compiling: Emscripten's pthread
      // pool is sized to MAX_THREADS, and compiling while STEP_THREADS are held
      // can deadlock waiting for worker threads.
      if (threaded && headlessData) mj.mju_threadpool(headlessData, 0);
      let nextModel: MjModel | null = null;
      let nextData: MjData | null = null;
      try {
        nextModel = meshVfs ? mj.MjModel.from_xml_string(rebuild.xml, meshVfs) : mj.MjModel.from_xml_string(rebuild.xml);
        nextData = new mj.MjData(nextModel);
        if (threaded) mj.mju_threadpool(nextData, STEP_THREADS);
      } catch (e) {
        if (nextData) { try { nextData.delete(); } catch { /* ignore */ } }
        if (nextModel) { try { nextModel.delete(); } catch { /* ignore */ } }
        if (threaded && headlessData) { try { mj.mju_threadpool(headlessData, STEP_THREADS); } catch { /* ignore */ } }
        warnings.push(`A body shattered at t=${data!.time.toFixed(3)} s, but the model with its pieces did not compile (${String((e as Error)?.message || e)}), so the run went on with it whole.`);
        return;
      }
      const carried = captureState(model, data, jointIdCache, actuatorIdCache);
      earlierReports.push(constraints.report(data!));
      try { headlessData?.delete(); } catch { /* already gone */ }
      try { headlessModel?.delete(); } catch { /* already gone */ }
      headlessModel = nextModel;
      headlessData = nextData;
      model = nextModel;
      data = nextData;
      sceneGraph = rebuild.sceneGraph;
      rebuildIdCaches();
      rebuildBreakableWelds();
      watchImpacts();
      pendingWake.clear();
      rebuildHydroAndFlexureCaches(undefined, headlessWaterLevel, headlessWaterBasins);
      magnetBodies = collectMagnetBodies(sceneGraph.nodes, bodyIdCache, model);
      scriptCache = {};
      if (carried) carryByJointName(carried, nextModel, nextData);
      else mj.mj_forward(nextModel, nextData);
      buildCloth(true);
      applyBrokenWelds();
      constraints = createConstraintMonitor(mj, nextModel);
      energyGain ??= solverWork.result();
      solverWork = createSolverWorkMonitor(mj, nextModel);
      timestep = modelOpt(nextModel).timestep;
    };

    // `final` is judged on every tick, whatever the stride: see TrajectoryAccumulator.
    const accumulator = new TrajectoryAccumulator({ jointTypes: jointTypes(headlessSceneGraph) });
    const loop = headlessLoop<HistoryEntry>({ ticks, stride, initialVelocityJoints }, {
      step: () => {
        data!.xfrc_applied.fill(0);
        data!.qfrc_applied.fill(0);
        applyHydroAndFlexureForces(timestep, headlessWaterLevel, headlessWaterBasins);
        applyMagnetForces(magnetBodies, data!);
        lastAero = {};
        const t0 = performance.now();
        executeScripts(sceneGraph.nodes, lastAero);
        const dt = performance.now() - t0;
        scriptMs += dt;
        scriptTiming.addStep(dt);
        applyCompositeAeroForces();
        applyFreeJointDamping(sceneGraph.nodes);
        wakeBodies();
        solverWork.before(data!);
        mujoco!.mj_step(model!, data!);
        stepCloth(timestep);
        syncKinematics(mujoco!, model!, data!);
        solverWork.after(data!, timestep);
        checkConstraintBreaks();
        checkImpacts(timestep);
        constraints.sample(data!);
      },
      time: () => data!.time,
      isBad: () => {
        const qpos = data!.qpos;
        for (let i = 0; i < model!.nq; i++) if (!Number.isFinite(qpos[i])) return true;
        const qvel = data!.qvel;
        for (let i = 0; i < model!.nv; i++) if (!Number.isFinite(qvel[i])) return true;
        return false;
      },
      observe: () => accumulator.add(buildHistoryEntry(lastAero, { contacts: false })),
      sample: () => buildHistoryEntry(lastAero, { contacts: frameContacts }),
      interrupted: () => impacts.length > 0,
      // A mid-run rebuild hands over a fresh MjData whose counters start at 0;
      // the loop has stopped on any earlier change, so the count it compares
      // against is 0 as well.
      resets: () => autoResetCount(data!),
    });
    // Each pause is a tick on which something was hit: ask what it did, in
    // the order the blows landed, and rebuild when it broke.
    let next = loop.next();
    while (!next.done) {
      for (const event of impacts.splice(0)) {
        const rebuild = askImpact ? await askImpact(event) : undefined;
        if (rebuild) rebuildMidRun(rebuild);
      }
      next = loop.next();
    }
    const outcome = next.value;

    const wallMs = performance.now() - wallStart;
    const constraintReport = mergeConstraintReports([...earlierReports, constraints.report(data!)]);
    warnings.push(...collectMujocoWarnings(data!));
    warnings.push(...scriptProblems.warnings());
    const ticksRun = Math.max(1, outcome.ticksSimulated);
    const cost = scriptTiming.current(wallMs, null);
    const costWarning = headlessCostWarning(ticksRun, wallMs, scriptMs, timestep, cost?.slowest);
    if (costWarning) warnings.push(costWarning);
    warnings.push(...constraintReport.warnings);
    if (outcome.truncationDetail) warnings.push(outcome.truncationDetail);
    energyGain ??= solverWork.result();
    if (energyGain) warnings.push(solverEnergyWarning(energyGain));
    const scriptReport = headlessScriptReport(wallMs, scriptMs, ticksRun);

    return {
      ok: true,
      ticksRequested: ticks,
      ticksSimulated: outcome.ticksSimulated,
      truncated: outcome.truncated,
      ...(outcome.truncationReason
        ? { truncationReason: outcome.truncationReason, truncationDetail: outcome.truncationDetail }
        : {}),
      trajectory: outcome.frames,
      summary: accumulator.result(),
      warnings,
      constraintReport,
      ...(breaks.length ? { breaks } : {}),
      ...(energyGain ? { unstable: energyGain } : {}),
      ...scriptReport,
    };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e), warnings: [...warnings, ...scriptProblems.warnings()] };
  } finally {
    if (headlessData) { try { headlessData.delete(); } catch { /* ignore */ } }
    if (headlessModel) { try { headlessModel.delete(); } catch { /* ignore */ } }
    if (threaded && savedData && mujoco) { try { mujoco.mju_threadpool(savedData, STEP_THREADS); } catch { /* ignore */ } }
    model = savedModel; data = savedData; sceneGraph = savedSceneGraph;
    cloth = savedCloth;
    scriptState = savedScriptState;
    scriptCache = savedScriptCache;
    pendingWake.clear();
    for (const id of savedPendingWake) pendingWake.add(id);
    bodyIdCache = savedBodyIdCache; jointIdCache = savedJointIdCache;
    magnetBodies = savedMagnetBodies;
    geomIdCache = savedGeomIdCache; geomNameCache = savedGeomNameCache; actuatorIdCache = savedActuatorIdCache;
    cachedHydroByNodeId = savedCachedHydro;
    hydroByBodyId = savedHydroByBodyId;
    bistableJoints = savedBistableJoints;
    jointStopWatches = savedJointStopWatches;
    dofForceScale = savedDofForceScale;
    acousticStringBodyIds = savedAcousticStringBodyIds;
    acousticStringAxisByBodyId = savedAcousticStringAxis;
    acousticStringSpanByBodyId = savedAcousticStringSpan;
    acousticBowBodyIds = savedAcousticBowBodyIds;
    acousticBowSpecByBodyId = savedAcousticBowSpec;
    distinctAcousticChildBodyIds = savedDistinctAcousticChildIds;
    windSubtreeBodyIds = savedWindSubtreeIds;
    bodyRoughnessByBodyId = savedBodyRoughness;
    bodySoftnessByBodyId = savedBodySoftness;
    rimCapableBodyIds = savedRimCapableIds;
    geomRollingRadius = savedGeomRollingRadius;
    aeroCoveredBodyIds = savedAeroCoveredIds;
    bluffBodyAeroByBodyId = savedBluffBodyAero;
    aeroVoiceGroups = savedAeroVoiceGroups;
    aeroBladeGroupByNodeId = savedAeroBladeGroupByNodeId;
    clothTrailingWatches = savedClothTrailingWatches;
    bowContactStartSimTime.clear();
    for (const [k, v] of savedBowStartMap) bowContactStartSimTime.set(k, v);
    recentStopByStringBody.clear();
    for (const [k, v] of savedRecentStopMap) recentStopByStringBody.set(k, v);
    recentBowEvents.clear();
    for (const [k, v] of savedRecentBowEvents) recentBowEvents.set(k, v);
    prevActiveStringsByBow.clear();
    for (const [k, v] of savedPrevActiveByBow) prevActiveStringsByBow.set(k, v);
    recentPluckTouchSite.clear();
    for (const [k, v] of savedPluckTouchSite) recentPluckTouchSite.set(k, v);
    continuousPairStartSimTime.clear();
    for (const [k, v] of savedContinuousPairStart) continuousPairStartSimTime.set(k, v);
    lastNodeStrikeSimTime.clear();
    for (const [k, v] of savedLastNodeStrike) lastNodeStrikeSimTime.set(k, v);
    pendingAeroSnaps.clear();
    for (const [k, v] of savedPendingAeroSnaps) pendingAeroSnaps.set(k, v);
    prevConstraintDof = null;
    prevStringVelDof = null;
    breakableWelds = savedBreakableWelds; brokenWeldKeys = savedBrokenWeldKeys;
    headlessBreaks = null;
    impactWatches = savedImpactWatches;
    headlessImpacts = null;
    headlessBusy = false;
    bodyNodeById = savedBodyNodeById; jointInfos = savedJointInfos;
    scriptProblems = savedScriptProblems; scriptLogs = savedScriptLogs; scriptTiming = savedScriptTiming;
  }
};

/** What a headless run's scripts logged, held and cost, for its reply. Reads the swapped-in stores. */
const headlessScriptReport = (wallMs: number, scriptMs: number, ticks: number) => {
  const hasScripts = scriptsByBody(sceneGraph.nodes).size > 0;
  const finalState = scriptState.snapshot();
  return {
    wallMs: Math.round(wallMs),
    ...(hasScripts ? { scriptMsPerStep: +(scriptMs / ticks).toPrecision(3) } : {}),
    ...(scriptLogs.total ? { logs: scriptLogs.entries(), ...(scriptLogs.dropped ? { logsDropped: scriptLogs.dropped } : {}) } : {}),
    ...(finalState ? { scriptState: finalState } : {}),
  };
};

/** The answer a judged headless run is waiting for, while it waits. */
let impactAnswer: ((rebuild: HeadlessRebuild | undefined) => void) | null = null;
/**
 * Messages that arrive during a judged headless run, handled in order once it
 * is over. An unjudged run is synchronous, so nothing can arrive in the middle
 * of it; a judged one awaits the main thread at every blow, and a TICK or a
 * BUILD handled then would step or replace the headless model in the live
 * one's place.
 */
let heldMessages: MessageEvent[] | null = null;

const drainHeldMessages = async () => {
  // Still holding while it drains, so anything newer queues behind.
  while (heldMessages && heldMessages.length) {
    await handleMessage(heldMessages.shift()!);
  }
  heldMessages = null;
};

const askMainAboutImpact = (id: string, event: ImpactEvent) => new Promise<HeadlessRebuild | undefined>((resolve) => {
  impactAnswer = resolve;
  post({ type: 'HEADLESS_IMPACT', id, event });
});

self.onmessage = (evt: MessageEvent) => {
  const msg = evt.data;
  if (msg?.type === 'HEADLESS_IMPACT_REPLY') {
    const answer = impactAnswer;
    impactAnswer = null;
    answer?.(msg.rebuild);
    return;
  }
  if (heldMessages) { heldMessages.push(evt); return; }
  void handleMessage(evt);
};

const handleMessage = async (evt: MessageEvent) => {
  const msg = evt.data;
  try {
    switch (msg.type) {
      case 'BUILD': {
        const holds = !mujoco && !heldMessages;
        if (holds) heldMessages = [];
        let loadFailed = false;
        try {
          if (!mujoco) {
            try {
              await loadMujoco();
            } catch (e) {
              loadFailed = true;
              throw e;
            }
          }
          applyMeshFiles(msg.meshFiles, msg.dropMeshes);
          seedClothModels(msg.clothModels);
          if (msg.hydroModels) {
            cachedHydroByNodeId = new Map(msg.hydroModels.map((h: HydroBodyModel) => [h.nodeId, h]));
          }
          const result = doBuild(msg.xml, msg.sceneGraph, msg.preserveState, msg.seedState, msg.brokenConstraints);
          // The cloth layout, only if the client does not hold it already (a 2.4 MB clone on urban_collection every build).
          const layoutHeld = result.clothLayoutId === msg.haveClothLayout;
          if (msg.holdForInstall) holdUntil = performance.now() + HOLD_FOR_INSTALL_MS;
          post({ type: 'BUILT', id: msg.id, ok: true, ...result, ...(layoutHeld ? { flexes: undefined } : {}) });
          // A build may have cleared problems (a fresh run, a changed script).
          postScriptStatus(true);
          if (isPlaying && isSharedSupported) {
            startWorkerLoop();
          }
        } catch (e) {
          const errMsg = String((e as Error)?.message || e);
          const fatal = loadFailed || /Aborted|enlarge memory|abort|bad_alloc/i.test(errMsg);
          post({ type: 'BUILT', id: msg.id, ok: false, error: errMsg, fatal });
        } finally {
          if (holds) await drainHeldMessages();
        }
        break;
      }
      case 'SET_ENV': {
        envWindX = msg.windX ?? envWindX;
        envWindY = msg.windY ?? envWindY;
        if (typeof msg.windGusting === 'boolean') envWindGusting = msg.windGusting;
        envDensity = msg.density ?? envDensity;
        if ('waterBasins' in msg) {
          envWaterBasins = msg.waterBasins ?? [];
        }
        if ('waterLevel' in msg) {
          envWaterLevel = typeof msg.waterLevel === 'number' && Number.isFinite(msg.waterLevel) ? msg.waterLevel : null;
        }
        if ('waterLevel' in msg || 'waterBasins' in msg || msg.hydroModels) {
          rebuildHydroAndFlexureCaches(msg.hydroModels, envWaterLevel, envWaterBasins);
        }
        break;
      }
      case 'SET_SOUND': {
        soundEnabled = !!msg.enabled;
        if (!soundEnabled) {
          resetAudioWatchState();
        }
        break;
      }
      case 'SET_PLAYING': {
        isPlaying = !!msg.isPlaying;
        // A pause is not slow play: measure from here.
        scriptTiming.restart();
        if (isPlaying) {
          accumulator = 0;
          if (isSharedSupported) {
            startWorkerLoop();
          }
        } else {
          if (isSharedSupported) {
            stopWorkerLoop();
          }
          if (clothGrabZip >= 0) releaseClothZip();
          if (clothGrabVertex !== null) {
            cloth?.sim.grab(null, null);
            clothGrabVertex = null;
          }
          // The steps since the last frame, so what stops on screen is where
          // the simulation stopped. See FRAME_INTERVAL_MS.
          if (framePending && model && data) postFrame();
          // Re-prime differential DOF watches so SET_QPOS edits while paused never pop on unpause!
          resetAudioWatchState();
          postScriptStatus(true);
        }
        break;
      }
      case 'TICK': {
        if (typeof msg.sentAt === 'number' && msg.sentAt < tickFloor) break;
        if (!isSharedSupported) {
          stepTick(msg.delta);
        }
        break;
      }
      case 'RESUME': {
        if (holdUntil) endHold();
        break;
      }
      case 'SET_DRAG': {
        draggedNodeId = msg.nodeId ?? null;
        dragTarget = msg.target ?? null;
        // A drag that holds cloth: its point drawn to the target; let go with the drag.
        // One that holds a zip's slider: the slider drawn along its zip.
        if (clothGrabZip >= 0 && cloth) {
          if (draggedNodeId && dragTarget) cloth.sim.grabZip(clothGrabZip, [dragTarget.x, dragTarget.y, dragTarget.z]);
          else if (!draggedNodeId) releaseClothZip();
        } else if (clothGrabVertex !== null && cloth) {
          if (draggedNodeId && dragTarget) cloth.sim.grab(clothGrabVertex, [dragTarget.x, dragTarget.y, dragTarget.z]);
          else if (!draggedNodeId) { cloth.sim.grab(null, null); clothGrabVertex = null; }
        }
        break;
      }
      case 'SET_CLOTH_GRAB': {
        if (clothGrabZip >= 0) releaseClothZip();
        clothGrabVertex = msg.vertex;
        clothGrabZip = msg.vertex !== null && msg.point && cloth ? cloth.sim.zipAt(msg.point) : -1;
        if (clothGrabZip >= 0) { clothGrabVertex = null; cloth?.sim.grab(null, null); }
        if (msg.vertex === null) cloth?.sim.grab(null, null);
        break;
      }
      case 'SET_KEYS': {
        pressedKeys = new Set<string>(msg.keys || []);
        break;
      }
      case 'SET_QPOS': {
        if (!model || !data || !mujoco) break;
        const jId = jointIdCache[msg.jointName] ?? mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT.value, msg.jointName);
        if (jId !== -1) {
          const adr = model.jnt_qposadr[jId];
          const axis = typeof msg.axis === 'number' && Number.isInteger(msg.axis) ? msg.axis : -1;
          let wrote = false;
          if (axis >= 0) {
            if (Array.isArray(msg.value)) {
              for (let i = 0; i < msg.value.length; i++) {
                const idx = adr + axis + i;
                const val = msg.value[i];
                if (idx >= 0 && idx < model.nq && typeof val === 'number' && Number.isFinite(val)) {
                  data.qpos[idx] = val;
                  wrote = true;
                }
              }
            } else {
              const idx = adr + axis;
              if (idx >= 0 && idx < model.nq && typeof msg.value === 'number' && Number.isFinite(msg.value)) {
                data.qpos[idx] = msg.value;
                wrote = true;
              }
            }
          }
          if (!wrote) break;
          pendingWake.add(model.jnt_bodyid[jId]);
          const vadr = model.jnt_dofadr[jId];
          const nv = JOINT_NV[model.jnt_type[jId]] ?? 1;
          for (let i = 0; i < nv; i++) data.qvel[vadr + i] = 0;
          mujoco.mj_forward(model, data);
          cloth?.pose();
          postFrame();
        }
        break;
      }
      case 'SET_CTRL': {
        if (!model || !data) break;
        const actId = actuatorIdCache[msg.actuatorName] ?? -1;
        if (actId !== -1) data.ctrl[actId] = msg.value;
        break;
      }
      case 'UPDATE_SCRIPT': {
        const node = findNodeById(sceneGraph.nodes, msg.nodeId);
        if (node) {
          node.script = msg.script;
          delete scriptCache[msg.nodeId];
          // The old script's mistakes are not the new one's.
          scriptProblems.clearBodies(new Set([node.name || node.id]));
        }
        break;
      }
      case 'RUN_HEADLESS': {
        const judged = !!msg.judgeImpacts;
        // Hold incoming messages during cold-boot WASM load and/or judged runs
        // so interleaved control/query messages are queued and drained in order.
        const holds = (!mujoco || judged) && !heldMessages;
        if (holds) heldMessages = [];
        try {
          if (!mujoco) {
            try {
              await loadMujoco();
            } catch (e) {
              const errMsg = String((e as Error)?.message || e);
              post({ type: 'HEADLESS_RESULT', id: msg.id, ok: false, error: errMsg, warnings: [] });
              post({ type: 'ERROR', message: errMsg, fatal: true });
              break;
            }
          }
          applyMeshFiles(msg.meshFiles, msg.dropMeshes);
          const id: string = msg.id;
          const result = await runHeadless(
            msg.xml, msg.sceneGraph, msg.ticks, msg.stride,
            judged ? (event) => askMainAboutImpact(id, event) : undefined,
            msg.contacts !== false,
            'waterLevel' in msg ? (msg.waterLevel ?? null) : envWaterLevel,
            msg.hydroModels,
            msg.waterBasins ?? collectWaterBasins(msg.sceneGraph.nodes),
          );
          post({ type: 'HEADLESS_RESULT', id, ...result });
        } finally {
          if (holds) await drainHeldMessages();
        }
        break;
      }
      case 'GET_HISTORY': {
        const { frames, total, stride } = history.query(msg.query);
        post({ type: 'HISTORY_RESULT', id: msg.id, history: frames, total, stride });
        break;
      }
      case 'GET_TELEMETRY': {
        // The latest frame, with what the scripts hold now and their last words.
        const latest = history.latest();
        const scriptStateNow = scriptState.snapshot();
        const lines = scriptLogs.entries(50);
        post({
          type: 'TELEMETRY_RESULT', id: msg.id,
          telemetry: latest || scriptStateNow || lines.length ? {
            ...(latest ?? {}),
            ...(scriptStateNow ? { scriptState: scriptStateNow } : {}),
            ...(lines.length ? { scriptLogs: lines } : {}),
            ...(scriptLogs.total > lines.length ? { scriptLogsDropped: scriptLogs.total - lines.length } : {}),
          } : null,
        });
        break;
      }
      case 'CLEAR_HISTORY': {
        history.clear();
        break;
      }
      case 'STEP_FOR': {
        const r = stepFor(msg.dtMs, msg.inputs ?? {}, msg.outputs ?? []);
        post(r.ok
          ? { type: 'STEPPED', id: msg.id, ok: true, t: r.t, steps: r.steps, outputs: r.outputs, unknown: r.unknown }
          : { type: 'STEPPED', id: msg.id, ok: false, error: r.error });
        break;
      }
      case 'GET_CHANNELS': {
        post(model && mujoco
          ? { type: 'CHANNELS', id: msg.id, channels: channelCatalogue(mujoco, model), timestepMs: modelOpt(model).timestep * 1000 }
          : { type: 'CHANNELS', id: msg.id, channels: [], timestepMs: 0 });
        break;
      }
      default:
        break;
    }
  } catch (e) {
    post({ type: 'ERROR', message: String((e as Error)?.message || e), fatal: false });
  }
};
