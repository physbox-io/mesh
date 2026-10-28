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
import type { SceneGraph, SceneJoint, SceneNode } from '../types/scene';
// Pure loop control for the headless run, kept in a module that can be
// imported outside a Worker realm so it is testable (this file cannot be:
// it assigns self.onmessage at module scope). See tests/headlessRun.test.ts.
import { runHeadlessLoop, type HeadlessRunResult } from '../store/physicsWorkerClient';
import type {
  AeroDiagnostic,
  BodyHistory,
  ContactHistory,
  HistoryEntry,
  JointHistory,
  WorkerToMainMessage,
} from './physicsWorkerProtocol';
import { HistoryRing } from './historyRing';
import { rebaseShard } from '../utils/runtimeShatter';
import { ScriptStateStore, attachScriptState, scriptStateForBuild, type ScriptStateMap } from '../utils/scriptState';
import { BREAK_ARM_S, axialPush, barBending, toBodyFrame, weldTorque, canCrumple, crumpleAsWeld, crumpleKey, holdSteps, isBreakable, shatterFloor, weldKey, weldOverload, type WeldBreakConfig } from '../utils/breakThresholds';
import { BREAK_FIELDS, parseBreakKey } from '../utils/breakKeys';

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
 * is logged once. A headless run clears it first and returns it as warnings;
 * otherwise it only reaches the console.
 */
let scriptProblems = new Map<string, string>();
const noteScriptProblem = (bodyName: string, message: string) => {
  const key = `${bodyName}\u0000${message}`;
  if (scriptProblems.has(key)) return;
  const text = `Script on '${bodyName}': ${message}`;
  scriptProblems.set(key, text);
  console.warn(`[Script:${bodyName}]`, message);
};
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
        if (!mj || !mdl) return;
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
};

const createScriptApi = (node: SceneNode): Record<string, unknown> => {
  const _resolveBody = (name: string) =>
    bodyIdCache[name] ?? (mujoco && model ? mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, name) : -1);
  const _resolveJoint = (name: string) =>
    jointIdCache[name] ?? (mujoco && model ? mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT.value, name) : -1);

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
    if (typeof v === 'number') return v;
    if (Array.isArray(v) && v.length === 1) return v[0];
    if (Array.isArray(v) && v.length >= 3) {
      const a = joint.axis ?? [0, 0, 1];
      const len = Math.hypot(a[0], a[1], a[2]) || 1;
      const along = (v[0] * a[0] + v[1] * a[1] + v[2] * a[2]) / len;
      const off = Math.sqrt(Math.max(0, v[0] * v[0] + v[1] * v[1] + v[2] * v[2] - along * along));
      if (off > 1e-6 * Math.max(1, Math.abs(along))) {
        noteScriptProblem(node.name || node.id, `${fnName}: [${v.slice(0, 3).join(', ')}] is not along ${joint.type} '${joint.name}' axis [${a.join(', ')}]; only its component along the axis (${along.toPrecision(4)}) was applied`);
      }
      return along;
    }
    throw new Error(`${fnName}: joint '${joint.name}' is a ${joint.type}; pass a number (or a 3-vector to project onto its axis)`);
  };
  const _vector = (fnName: string, v: number[] | number, n: number, joint: SceneJoint): number[] => {
    if (!Array.isArray(v) || v.length < n) {
      throw new Error(`${fnName}: joint '${joint.name}' is a ${joint.type}; pass an array of ${n} numbers`);
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
      pendingWake.add(mdl.jnt_bodyid[jId]);
      if (joint.type === 'free') {
        const p = _vector('setPosition', pos, 3, joint);
        dat.qpos[qposadr + 0] = p[0]; dat.qpos[qposadr + 1] = p[1]; dat.qpos[qposadr + 2] = p[2];
      } else if (joint.type === 'ball') {
        const q = _vector('setPosition', pos, 4, joint);
        dat.qpos[qposadr + 0] = q[0]; dat.qpos[qposadr + 1] = q[1]; dat.qpos[qposadr + 2] = q[2]; dat.qpos[qposadr + 3] = q[3];
      } else {
        dat.qpos[qposadr] = _alongAxis('setPosition', pos, joint);
      }
    }),
    setVelocity: _guard((vel: number[] | number, bodyName: string = node.id) => {
      const mdl = model!, dat = data!;
      const { joint, jId } = _resolveSetterJoint('setVelocity', bodyName);
      const dofadr = mdl.jnt_dofadr[jId];
      pendingWake.add(mdl.jnt_bodyid[jId]);
      if (joint.type === 'free') {
        const v = _vector('setVelocity', vel, 3, joint);
        dat.qvel[dofadr + 0] = v[0]; dat.qvel[dofadr + 1] = v[1]; dat.qvel[dofadr + 2] = v[2];
      } else if (joint.type === 'ball') {
        throw new Error(`setVelocity: joint '${joint.name}' is a ball joint, which only rotates; use setAngularVelocity`);
      } else {
        dat.qvel[dofadr] = _alongAxis('setVelocity', vel, joint);
      }
    }),
    setAngularVelocity: _guard((angvel: number[] | number, bodyName: string = node.id) => {
      const mdl = model!, dat = data!;
      const { joint, jId } = _resolveSetterJoint('setAngularVelocity', bodyName);
      const dofadr = mdl.jnt_dofadr[jId];
      pendingWake.add(mdl.jnt_bodyid[jId]);
      if (joint.type === 'free') {
        const w = _vector('setAngularVelocity', angvel, 3, joint);
        dat.qvel[dofadr + 3] = w[0]; dat.qvel[dofadr + 4] = w[1]; dat.qvel[dofadr + 5] = w[2];
      } else if (joint.type === 'ball') {
        const w = _vector('setAngularVelocity', angvel, 3, joint);
        dat.qvel[dofadr + 0] = w[0]; dat.qvel[dofadr + 1] = w[1]; dat.qvel[dofadr + 2] = w[2];
      } else if (joint.type === 'hinge') {
        dat.qvel[dofadr] = _alongAxis('setAngularVelocity', angvel, joint);
      } else {
        throw new Error(`setAngularVelocity: joint '${joint.name}' is a slide, which cannot rotate; use setVelocity`);
      }
    }),
    getPosition: (bodyName = node.id) => {
      const dat = data!;
      const bId = _resolveBody(bodyName);
      return bId !== -1 ? [dat.xpos[bId * 3], dat.xpos[bId * 3 + 1], dat.xpos[bId * 3 + 2]] : [0, 0, 0];
    },
    getVelocity: (bodyName = node.id) => {
      const dat = data!;
      const bId = _resolveBody(bodyName);
      return bId !== -1 ? [dat.cvel[bId * 6 + 3], dat.cvel[bId * 6 + 4], dat.cvel[bId * 6 + 5]] : [0, 0, 0];
    },
    getAngularVelocity: (bodyName = node.id) => {
      const dat = data!;
      const bId = _resolveBody(bodyName);
      return bId !== -1 ? [dat.cvel[bId * 6 + 0], dat.cvel[bId * 6 + 1], dat.cvel[bId * 6 + 2]] : [0, 0, 0];
    },
    getMass: (bodyName = node.id) => {
      const mdl = model!;
      const bId = _resolveBody(bodyName);
      return bId !== -1 ? mdl.body_mass[bId] : 0;
    },
    getJointPosition: (jointName: string) => {
      const mdl = model!, dat = data!;
      const jId = _resolveJoint(jointName);
      return jId !== -1 ? dat.qpos[mdl.jnt_qposadr[jId]] : 0;
    },
    getJointVelocity: (jointName: string) => {
      const mdl = model!, dat = data!;
      const jId = _resolveJoint(jointName);
      return jId !== -1 ? dat.qvel[mdl.jnt_dofadr[jId]] : 0;
    },
    applyForce: (forceVec: number[], bodyName = node.id) => {
      if (!Array.isArray(forceVec)) return;
      const dat = data!;
      const bId = _resolveBody(bodyName);
      if (bId === -1) return;
      pendingWake.add(bId);
      dat.xfrc_applied[bId * 6 + 0] += forceVec[0] || 0;
      dat.xfrc_applied[bId * 6 + 1] += forceVec[1] || 0;
      dat.xfrc_applied[bId * 6 + 2] += forceVec[2] || 0;
    },
    applyTorque: (torqueVec: number[], bodyName = node.id) => {
      if (!Array.isArray(torqueVec)) return;
      const dat = data!;
      const bId = _resolveBody(bodyName);
      if (bId === -1) return;
      pendingWake.add(bId);
      dat.xfrc_applied[bId * 6 + 3] += torqueVec[0] || 0;
      dat.xfrc_applied[bId * 6 + 4] += torqueVec[1] || 0;
      dat.xfrc_applied[bId * 6 + 5] += torqueVec[2] || 0;
    },
    getOrientation: (bodyName = node.id) => {
      const dat = data!;
      const bId = _resolveBody(bodyName);
      if (bId === -1) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
      const o = bId * 9;
      return [dat.xmat[o], dat.xmat[o+1], dat.xmat[o+2], dat.xmat[o+3], dat.xmat[o+4], dat.xmat[o+5], dat.xmat[o+6], dat.xmat[o+7], dat.xmat[o+8]];
    },
    applyJointForce: (jointName: string, forceVal: number) => {
      if (typeof forceVal !== 'number') return;
      const mdl = model!, dat = data!;
      const jId = _resolveJoint(jointName);
      if (jId !== -1) {
        pendingWake.add(mdl.jnt_bodyid[jId]);
        dat.qfrc_applied[mdl.jnt_dofadr[jId]] += forceVal;
      }
    },
    setActuatorControl: (actuatorName: string, ctrlVal: number) => {
      if (typeof ctrlVal !== 'number') return;
      const dat = data!;
      const actId = actuatorIdCache[actuatorName] ?? -1;
      if (actId !== -1) dat.ctrl[actId] = ctrlVal;
    },
    getTime: () => (data ? data.time : 0),
    getWind: () => [envWindX || 0, envWindY || 0],
    log: (msg: unknown) => console.log(`[Script:${node.name}]`, msg),
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
          const cvel = dat.cvel;
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

          const rx = geomWorldX - xpos[pId * 3 + 0];
          const ry = geomWorldY - xpos[pId * 3 + 1];
          const rz = geomWorldZ - xpos[pId * 3 + 2];

          const wx = cvel[bId * 6 + 0];
          const wy = cvel[bId * 6 + 1];
          const wz = cvel[bId * 6 + 2];
          const vO_x = cvel[bId * 6 + 3];
          const vO_y = cvel[bId * 6 + 4];
          const vO_z = cvel[bId * 6 + 5];

          const vx = vO_x + (wy * rz - wz * ry);
          const vy = vO_y + (wz * rx - wx * rz);
          const vz = vO_z + (wx * ry - wy * rx);

          const o = bId * 9;
          const noseX = xmat[o + 0], noseY = xmat[o + 3], noseZ = xmat[o + 6];
          const spanX = xmat[o + 1], spanY = xmat[o + 4], spanZ = xmat[o + 7];
          const upX = xmat[o + 2], upY = xmat[o + 5], upZ = xmat[o + 8];

          const relVx = vx - (envWindX || 0);
          const relVy = vy - (envWindY || 0);
          const relVz = vz;

          const spanDotV = relVx * spanX + relVy * spanY + relVz * spanZ;
          const airfoilVx = relVx - spanDotV * spanX;
          const airfoilVy = relVy - spanDotV * spanY;
          const airfoilVz = relVz - spanDotV * spanZ;
          const relSpeed = Math.sqrt(airfoilVx * airfoilVx + airfoilVy * airfoilVy + airfoilVz * airfoilVz);

          if (relSpeed >= 0.05) {
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
            const tx_aero = pitchMoment * spanX;
            const ty_aero = pitchMoment * spanY;
            const tz_aero = pitchMoment * spanZ;

            const bankAngle = Math.atan2(upX * spanY - upY * spanX, upZ);
            const rollRestoring = -0.1 * bankAngle * q * wingArea * chord;
            const tx_roll = rollRestoring * noseX;
            const ty_roll = rollRestoring * noseY;
            const tz_roll = rollRestoring * noseZ;

            const tx_lever = ry * fz - rz * fy;
            const ty_lever = rz * fx - rx * fz;
            const tz_lever = rx * fy - ry * fx;

            xfrc[pId * 6 + 0] += fx;
            xfrc[pId * 6 + 1] += fy;
            xfrc[pId * 6 + 2] += fz;

            xfrc[pId * 6 + 3] += tx_aero + tx_roll + tx_lever;
            xfrc[pId * 6 + 4] += ty_aero + ty_roll + ty_lever;
            xfrc[pId * 6 + 5] += tz_aero + tz_roll + tz_lever;

            aeroDiagnostics[node.name || node.id] = {
              relSpeed, alpha: alpha * 180 / Math.PI, CL, CD,
              force: [fx, fy, fz],
              torque: [tx_aero + tx_roll + tx_lever, ty_aero + ty_roll + ty_lever, tz_aero + tz_roll + tz_lever],
            };
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

      try { cached.fn(cached.api); } catch (e) { noteScriptProblem(node.name || node.id, `runtime error: ${(e as Error)?.message ?? e}`); }
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
            const cvel = dat.cvel;
            const xfrc = dat.xfrc_applied;
            const bodyInertia = mdl.body_inertia;
            const bodyMass = mdl.body_mass;
            const wx = cvel[bId * 6 + 0], wy = cvel[bId * 6 + 1], wz = cvel[bId * 6 + 2];
            const vx = cvel[bId * 6 + 3], vy = cvel[bId * 6 + 4], vz = cvel[bId * 6 + 5];
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
let optCache: { model: MjModel; timestep: number; enableflags: number } | null = null;
const modelOpt = (mdl: MjModel) => {
  if (optCache?.model !== mdl) {
    const opt = mdl.opt;
    optCache = { model: mdl, timestep: opt.timestep, enableflags: opt.enableflags };
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
const DRAG_HAND_N = 5;

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

const applyDragForce = () => {
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
  const vx = dat.cvel[bId * 6 + 3], vy = dat.cvel[bId * 6 + 4], vz = dat.cvel[bId * 6 + 5];
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
  // A hand's worth at the least: enough, at the 0.15 m of pointer offset
  // every body saturates at, to pull a part out of a joint or snap it.
  const K = Math.max(200.0 * mass, DRAG_HAND_N / 0.15);
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

const buildHistoryEntry = (aeroDiagnostics: Record<string, AeroDiagnostic>): HistoryEntry => {
  const mdl = model!;
  const dat = data!;
  const bodies: Record<string, BodyHistory> = {};
  const joints: Record<string, JointHistory> = {};
  const collectNodeData = (nodesList: SceneNode[]) => {
    if (!nodesList || !dat || !mdl) return;
    for (const node of nodesList) {
      const bId = bodyIdCache[node.id];
      if (bId !== undefined) {
        // Views taken once for this body, as in executeScripts.
        const cvel = dat.cvel;
        const xfrc = dat.xfrc_applied;
        const xpos = dat.xpos;
        const xquat = dat.xquat;
        const bodyDofnum = mdl.body_dofnum;
        const bodyParentid = mdl.body_parentid;
        let pId = bId;
        while (pId > 0 && bodyDofnum[pId] === 0) {
          pId = bodyParentid[pId];
        }
        const wx = cvel[bId * 6 + 0], wy = cvel[bId * 6 + 1], wz = cvel[bId * 6 + 2];
        const vO_x = cvel[bId * 6 + 3], vO_y = cvel[bId * 6 + 4], vO_z = cvel[bId * 6 + 5];
        const x_pos = xpos[bId * 3 + 0], y_pos = xpos[bId * 3 + 1], z_pos = xpos[bId * 3 + 2];
        const rx = x_pos - xpos[pId * 3 + 0];
        const ry = y_pos - xpos[pId * 3 + 1];
        const rz = z_pos - xpos[pId * 3 + 2];
        const vx = vO_x + (wy * rz - wz * ry);
        const vy = vO_y + (wz * rx - wx * rz);
        const vz = vO_z + (wx * ry - wy * rx);
        bodies[node.id] = {
          pos: [x_pos, y_pos, z_pos], vel: [vx, vy, vz], angvel: [wx, wy, wz],
          quat: [xquat[bId * 4], xquat[bId * 4 + 1], xquat[bId * 4 + 2], xquat[bId * 4 + 3]],
          xfrc_applied: [
            xfrc[bId * 6 + 0], xfrc[bId * 6 + 1], xfrc[bId * 6 + 2],
            xfrc[bId * 6 + 3], xfrc[bId * 6 + 4], xfrc[bId * 6 + 5],
          ],
        };
      }
      node.joints?.forEach((j) => {
        if (!dat || !mdl) return;
        const jId = jointIdCache[j.name];
        if (jId !== undefined) {
          joints[j.name] = { pos: dat.qpos[mdl.jnt_qposadr[jId]], vel: dat.qvel[mdl.jnt_dofadr[jId]], qfrc_applied: dat.qfrc_applied[mdl.jnt_dofadr[jId]] };
        }
      });
      if (node.children) collectNodeData(node.children);
    }
  };
  collectNodeData(sceneGraph.nodes);

  const contacts: ContactHistory[] = [];
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
        contacts.push({ geom1: geomNameCache[contact.geom1] ?? `geom_${contact.geom1}`, geom2: geomNameCache[contact.geom2] ?? `geom_${contact.geom2}`, dist: contact.dist });
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
let envDensity = 0;

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
    post({
      type: 'CONSTRAINT_BROKEN',
      key: w.key,
      nodeId: w.nodeId,
      targetId: w.targetId,
      kind: w.kind ?? (w.crumple ? 'crumple' : 'weld'),
      ...(cause ? { cause } : {}),
      time: dat.time,
      forceN,
      torqueNm,
    });
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
// What counts as "hit hard" is IMPULSE, not force. Contact force in a hard
// solver is a spike whose height depends on the timestep as much as on the
// collision, so a force threshold is a number that changes meaning when the
// timestep does. Momentum does not: 0.2 kg arriving at 5 m/s and stopping dead
// is 1 N*s whatever the solver was doing, and it is a quantity somebody can
// reason about without knowing anything about MuJoCo.
//
// The cheap signal is `qfrc_constraint` — the net constraint force on each
// degree of freedom, a plain view with no heap copy behind it, summed over a
// short sliding window. Resting on a table barely registers: a 1 kg body at
// rest accumulates 0.05 N*s over the window and stays there. Being struck
// clears a whole newton-second in a few milliseconds.
//
// Only once that trips does the expensive read happen. `dat.contact` copies the
// entire contact array onto the wasm heap every time it is touched — the leak
// that used to hit the 2 GB ceiling — so it is read once, on the step of the
// impact, purely to find out WHERE the body was hit. Never per step.

/** Sliding window for the impulse sum, in steps (1 ms each). */
const IMPACT_WINDOW_STEPS = 5;
/** Steps to wait before a body may report another impact. */
const IMPACT_COOLDOWN_STEPS = 250;

interface ImpactWatch {
  nodeId: string;
  bodyId: number;
  dofadr: number;
  /**
   * How many of this joint's degrees of freedom are translational.
   *
   * Six for a free joint, of which the first three are the linear ones. For a
   * hinge there is exactly one, and reading three would walk straight off the
   * end of it into whatever joint MuJoCo laid out next — so a swinging arm
   * would be reporting some other body's constraint force as its own.
   */
  dofCount: number;
  /** The lowest threshold anything on this body cares about, in N*s. */
  triggerNs: number;
  ring: Float64Array;
  cursor: number;
  cooldown: number;
  /**
   * The load this body carries when nothing is happening to it.
   *
   * Without this a heavy body cannot be watched at all: a 60 kg plate lying on
   * the ground shows a steady 590 N of constraint force just holding itself up,
   * which fills a 5 ms window with 3 N*s of perfectly uneventful resting
   * contact. Only the EXCESS over what it normally carries is a blow, so the
   * baseline is tracked slowly and subtracted. A long time constant on purpose:
   * it has to be far slower than any impact, or it would learn the impact.
   */
  baseline: number;
  /**
   * Whether the baseline has seen anything yet.
   *
   * Starting it at zero makes a body's own resting weight look like a blow on
   * the very first step, so every dentable thing in the scene got dented the
   * instant it loaded. The first reading IS the baseline.
   */
  primed: boolean;
  /**
   * A blow in progress, waiting for its peak.
   *
   * The running impulse is reported when it crosses the LOWEST threshold
   * anything in the scene cares about — which is not the same as how hard the
   * blow was. Reporting at that instant meant a steel slug and a rubber one
   * both arrived as "just over the smallest number in the scene", and a plate
   * that yields higher up was never told about either. So the crossing starts a
   * short watch instead, and what gets reported is the largest the impulse
   * reaches over the rest of the window: five milliseconds later, and the
   * difference between a hard blow and a soft one intact.
   */
  pending: { stepsLeft: number; maxImpulseNs: number; point: number[]; normal: number[]; otherBodyId: number } | null;
}

/** ~500 steps, so the baseline follows a body settling but never an impact. */
const IMPACT_BASELINE_ALPHA = 0.002;

let impactWatches: ImpactWatch[] = [];
/** Body id -> node id, for naming the other party to a collision. */
let bodyIdToNodeId: Record<number, string> = {};

/**
 * Which bodies are worth watching, and how hard they have to be hit.
 *
 * A body with neither a shatter threshold nor a dentable geom is not watched at
 * all, so a scene that uses none of this pays for one `length === 0` test per
 * step.
 */
const rebuildImpactWatches = () => {
  impactWatches = [];
  bodyIdToNodeId = {};
  const mdl = model;
  if (!mdl) return;

  /*
   * The softest thing in the scene, if anything is dentable at all.
   *
   * A body resting on the ground is a poor witness to being hit: squeezed
   * between the blow above and the ground below, its NET constraint force
   * barely moves, because the ground reaction rises to meet the load. The
   * hammer is the honest witness — a falling weight carries no constraint force
   * at all until the moment it arrives, so what shows up on it IS the
   * collision. So anything that can move is watched when the scene contains
   * something dentable, and a blow is attributed to both parties.
   */
  let minDentNs = Infinity;
  const scanDentable = (nodes: SceneNode[]) => {
    for (const node of nodes || []) {
      for (const g of node.geoms || []) {
        if (typeof g.dentYieldNs === 'number' && g.dentYieldNs > 0) minDentNs = Math.min(minDentNs, g.dentYieldNs);
        // A surface that can only be pierced is still worth watching for.
        if (typeof g.pierceImpulseNs === 'number' && g.pierceImpulseNs > 0) minDentNs = Math.min(minDentNs, g.pierceImpulseNs);
      }
      scanDentable(node.children || []);
    }
  };
  scanDentable(sceneGraph.nodes);

  const collect = (nodes: SceneNode[]) => {
    if (!nodes) return;
    for (const node of nodes) {
      const thresholds: number[] = [];
      if (typeof node.shatterImpulseNs === 'number' && node.shatterImpulseNs > 0) {
        // The weakest wall anywhere on it: only the main thread can tell
        // where the blow landed, and so how thick the body is there.
        thresholds.push(shatterFloor(node));
      }
      for (const g of node.geoms || []) {
        if (typeof g.dentYieldNs === 'number' && g.dentYieldNs > 0) thresholds.push(g.dentYieldNs);
        if (typeof g.pierceImpulseNs === 'number' && g.pierceImpulseNs > 0) thresholds.push(g.pierceImpulseNs);
      }
      if (Number.isFinite(minDentNs)) thresholds.push(minDentNs);
      const bodyId = bodyIdCache[node.id];
      if (bodyId !== undefined) bodyIdToNodeId[bodyId] = node.id;
      // Needs a joint of its own: a body welded into the scenery has no degrees
      // of freedom for a constraint force to show up on.
      const jointName = node.joints?.[0]?.name;
      const jointId = jointName !== undefined ? jointIdCache[jointName] : undefined;
      if (thresholds.length > 0 && bodyId !== undefined && jointId !== undefined) {
        const jointType = mdl.jnt_type[jointId];
        impactWatches.push({
          nodeId: node.id,
          bodyId,
          dofadr: mdl.jnt_dofadr[jointId],
          dofCount: Math.min(3, JOINT_NV[jointType] ?? 1),
          triggerNs: Math.min(...thresholds),
          ring: new Float64Array(IMPACT_WINDOW_STEPS),
          cursor: 0,
          cooldown: 0,
          baseline: 0,
          primed: false,
          pending: null,
        });
      }
      collect(node.children || []);
    }
  };
  collect(sceneGraph.nodes);
};

/**
 * Where on the body the blow landed, in the body's own frame.
 *
 * The one place `dat.contact` is read outside history sampling, and it is read
 * once per impact rather than once per step. Read-once/delete-in-finally, the
 * same discipline buildHistoryEntry documents.
 */
const impactSiteOf = (bodyId: number, againstBodyId?: number): { point: number[]; normal: number[]; otherBodyId: number } | null => {
  const dat = data, mdl = model;
  if (!dat || !mdl) return null;

  let best: { point: number[]; normal: number[]; otherBodyId: number } | null = null;
  const contactVec = dat.contact;
  try {
    const ncon = contactVec.size();
    for (let c = 0; c < ncon; c++) {
      const contact = contactVec.get(c);
      if (!contact) continue;
      try {
        const b1 = mdl.geom_bodyid[contact.geom1];
        const b2 = mdl.geom_bodyid[contact.geom2];
        if (b1 !== bodyId && b2 !== bodyId) continue;
        // When we already know who hit whom, take THAT contact. A plate lying
        // on the ground is in contact with the ground at every step, and the
        // first contact found for it is usually one of those — which would put
        // the dent on its underside rather than where it was struck.
        if (againstBodyId !== undefined && b1 !== againstBodyId && b2 !== againstBodyId) continue;
        const pos = contact.pos;
        const frame = contact.frame;
        // contact.frame's first row is the normal, pointing from geom1 to geom2.
        const sign = b1 === bodyId ? 1 : -1;
        best = {
          point: [pos[0], pos[1], pos[2]],
          normal: [frame[0] * sign, frame[1] * sign, frame[2] * sign],
          otherBodyId: b1 === bodyId ? b2 : b1,
        };
      } finally {
        contact.delete();
      }
      if (best) break;
    }
  } finally {
    contactVec.delete();
  }
  if (!best) return null;

  // World -> body local: R^T (p - xpos). xmat is row-major, so its transpose is
  // a column read.
  const px = best.point[0] - dat.xpos[bodyId * 3];
  const py = best.point[1] - dat.xpos[bodyId * 3 + 1];
  const pz = best.point[2] - dat.xpos[bodyId * 3 + 2];
  const m = bodyId * 9;
  const local = (x: number, y: number, z: number): number[] => [
    dat.xmat[m] * x + dat.xmat[m + 3] * y + dat.xmat[m + 6] * z,
    dat.xmat[m + 1] * x + dat.xmat[m + 4] * y + dat.xmat[m + 7] * z,
    dat.xmat[m + 2] * x + dat.xmat[m + 5] * y + dat.xmat[m + 8] * z,
  ];
  return {
    point: local(px, py, pz),
    normal: local(best.normal[0], best.normal[1], best.normal[2]),
    otherBodyId: best.otherBodyId,
  };
};

/** Has anything been hit hard enough to care about this step? */
const checkImpacts = (dt: number) => {
  if (impactWatches.length === 0) return;
  const dat = data;
  if (!dat) return;

  for (const w of impactWatches) {
    if (w.cooldown > 0) { w.cooldown--; continue; }

    let sum = 0;
    for (let i = 0; i < w.dofCount; i++) {
      const c = dat.qfrc_constraint[w.dofadr + i];
      sum += c * c;
    }
    const force = Math.sqrt(sum);

    // Only what this body is NOT normally carrying counts as a blow.
    if (!w.primed) { w.baseline = force; w.primed = true; }
    const excess = Math.max(0, force - w.baseline);
    w.baseline += (force - w.baseline) * IMPACT_BASELINE_ALPHA;

    w.ring[w.cursor] = excess * dt;
    w.cursor = (w.cursor + 1) % IMPACT_WINDOW_STEPS;

    let impulseNs = 0;
    for (let i = 0; i < IMPACT_WINDOW_STEPS; i++) impulseNs += w.ring[i];

    if (w.pending) {
      // Still measuring. The site was taken at first contact, while there
      // certainly was one; only the size of the blow is still in question.
      if (impulseNs > w.pending.maxImpulseNs) w.pending.maxImpulseNs = impulseNs;
      if (--w.pending.stepsLeft > 0) continue;

      const { maxImpulseNs, point, normal, otherBodyId } = w.pending;
      w.pending = null;
      w.cooldown = IMPACT_COOLDOWN_STEPS;
      w.ring.fill(0);

      // The same blow in the other body's frame, so a dent lands where the
      // thing was actually struck rather than at its origin.
      const otherNodeId = otherBodyId >= 0 ? bodyIdToNodeId[otherBodyId] : undefined;
      const otherSite = otherBodyId >= 0 ? impactSiteOf(otherBodyId, w.bodyId) : null;

      post({
        type: 'IMPACT',
        nodeId: w.nodeId,
        otherNodeId,
        otherLocalPoint: otherSite?.point,
        otherLocalNormal: otherSite?.normal,
        time: dat.time,
        impulseNs: maxImpulseNs,
        localPoint: point,
        localNormal: normal,
        pos: [dat.xpos[w.bodyId * 3], dat.xpos[w.bodyId * 3 + 1], dat.xpos[w.bodyId * 3 + 2]],
        xmat: Array.from({ length: 9 }, (_, i) => dat.xmat[w.bodyId * 9 + i]),
        vel: [dat.cvel[w.bodyId * 6 + 3], dat.cvel[w.bodyId * 6 + 4], dat.cvel[w.bodyId * 6 + 5]],
        angvel: [dat.cvel[w.bodyId * 6], dat.cvel[w.bodyId * 6 + 1], dat.cvel[w.bodyId * 6 + 2]],
      });
      continue;
    }

    if (impulseNs < w.triggerNs) continue;

    const site = impactSiteOf(w.bodyId);
    w.pending = {
      stepsLeft: IMPACT_WINDOW_STEPS,
      maxImpulseNs: impulseNs,
      point: site?.point ?? [0, 0, 0],
      normal: site?.normal ?? [0, 0, 1],
      otherBodyId: site?.otherBodyId ?? -1,
    };
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
  tickFloor = Date.now();
  accumulator = 0;
  lastTickTime = performance.now();
};

/**
 * The joint forces a linked Volt is applying this STEP_FOR, added every step
 * after `qfrc_applied` is cleared. Empty whenever no STEP_FOR is running.
 */
let linkForces: ResolvedInput[] = [];

/**
 * One model step, with everything a step does besides `mj_step`: forces,
 * scripts, damping, breaks, impacts, history. False when the step failed or
 * went to NaN, which has already been reported and has stopped play.
 */
const stepOnce = (stepSize: number): boolean => {
  if (!model || !data || !mujoco) return false;
  try {
    data.xfrc_applied.fill(0);
    data.qfrc_applied.fill(0);

    applyDragForce();
    applyJointForces(data, linkForces);

    const aeroDiagnostics: Record<string, AeroDiagnostic> = {};
    executeScripts(sceneGraph.nodes, aeroDiagnostics);
    applyFreeJointDamping(sceneGraph.nodes);
    wakeBodies();

    const prevTime = data.time;
    mujoco.mj_step(model, data);
    if (data.time <= prevTime) {
      post({ type: 'ERROR', message: 'Simulation diverged (solver auto-reset detected) — simulation stopped.', fatal: false });
      isPlaying = false;
      return false;
    }
    checkConstraintBreaks();
    checkImpacts(stepSize);
    stepCount++;

    if (stepCount % 10 === 0) {
      const entry = buildHistoryEntry(aeroDiagnostics);
      history.push(entry);
    }

    // One view, not one per element: every `data.qpos` / `data.qvel` read is an
    // embind getter that allocates a fresh Float64Array over the heap.
    const qpos = data.qpos;
    const nq = model.nq;
    for (let j = 0; j < nq; j++) {
      if (!Number.isFinite(qpos[j])) {
        post({ type: 'ERROR', message: 'NaN or Inf detected in qpos — simulation stopped.', fatal: false });
        isPlaying = false;
        return false;
      }
    }
    const qvel = data.qvel;
    const nv = model.nv;
    for (let j = 0; j < nv; j++) {
      if (!Number.isFinite(qvel[j])) {
        post({ type: 'ERROR', message: 'NaN or Inf detected in qvel — simulation stopped.', fatal: false });
        isPlaying = false;
        return false;
      }
    }
    return true;
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    const fatal = /Aborted|enlarge memory|abort|bad_alloc/i.test(msg);
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

  for (let i = 0; i < stepsNeeded; i++) {
    if (!stepOnce(stepSize)) return;
  }

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

const postFrame = () => {
  framePending = false;
  lastFramePost = performance.now();
  const snap = snapshot();
  if (isSharedSupported) {
    post({ type: 'FRAME', time: snap.time, heapBytes: snap.heapBytes, isShared: true, scriptState: scriptState.snapshot() });
  } else {
    post({ type: 'FRAME', ...snap, isShared: false, scriptState: scriptState.snapshot() }, [
      snap.qpos.buffer, snap.qvel.buffer, snap.ctrl.buffer,
      snap.xfrc_applied.buffer, snap.qfrc_applied.buffer,
      snap.xpos.buffer, snap.xmat.buffer, snap.cvel.buffer,
      snap.geom_xpos.buffer, snap.geom_xmat.buffer
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

const workerTick = (gen: number) => {
  if (gen !== workerLoopGen) return;
  workerTimerId = null;
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

/** How many qpos/qvel slots each joint type occupies: free, ball, slide, hinge. */
const JOINT_NQ = [7, 4, 1, 1];
const JOINT_NV = [6, 3, 1, 1];

interface CarriedState {
  nq: number; nv: number; nu: number; time: number;
  qpos: Float64Array; qvel: Float64Array; ctrl: Float64Array;
  /** Joint name -> where its state lived in the model being replaced. */
  joints: Record<string, { type: number; qposadr: number; dofadr: number }>;
  /** Actuator name -> control value in the model being replaced. */
  actuators: Record<string, number>;
}

/**
 * Everything worth carrying out of a model that is about to be freed.
 *
 * Plain JS arrays on purpose: the handles are deleted moments later and every
 * read of one after that throws.
 */
const captureState = (mdl: MjModel | null, dat: MjData | null): CarriedState | null => {
  if (!mdl || !dat) return null;
  try {
    const joints: CarriedState['joints'] = {};
    for (const name in jointIdCache) {
      const id = jointIdCache[name];
      joints[name] = { type: mdl.jnt_type[id], qposadr: mdl.jnt_qposadr[id], dofadr: mdl.jnt_dofadr[id] };
    }
    const actuators: Record<string, number> = {};
    for (const name in actuatorIdCache) {
      const id = actuatorIdCache[name];
      if (id >= 0 && id < mdl.nu) actuators[name] = dat.ctrl[id];
    }
    return {
      nq: mdl.nq, nv: mdl.nv, nu: mdl.nu, time: dat.time,
      qpos: Float64Array.from(dat.qpos),
      qvel: Float64Array.from(dat.qvel),
      ctrl: Float64Array.from(dat.ctrl),
      joints,
      actuators,
    };
  } catch {
    // A handle already gone is not worth failing a build over; the build just
    // falls back to the document pose.
    return null;
  }
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

const copyCarriedActuators = (carried: CarriedState, newModel: MjModel, newData: MjData): Set<string> => {
  const placed = new Set<string>();
  for (const name in actuatorIdCache) {
    if (Object.prototype.hasOwnProperty.call(carried.actuators, name)) {
      const id = actuatorIdCache[name];
      if (id >= 0 && id < newModel.nu) {
        newData.ctrl[id] = carried.actuators[name];
        placed.add(name);
      }
    }
  }
  return placed;
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

const doBuild = (
  xml: string,
  newSceneGraph: SceneGraph,
  preserveState: boolean,
  seedState?: { qpos: number[]; qvel: number[]; ctrl?: number[]; time: number; scriptState?: ScriptStateMap },
  brokenConstraints?: string[],
) => {
  if (brokenConstraints) brokenWeldKeys = new Set(brokenConstraints);
  // A rebuild is usually an edit: let a mistake that is still there be logged again.
  scriptProblems = new Map();
  scriptStateForBuild(scriptState, preserveState, seedState);
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
  const carried = captureState(oldModel, oldData);

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

  const newModel = meshVfs ? mujoco.MjModel.from_xml_string(xml, meshVfs) : mujoco.MjModel.from_xml_string(xml);
  const newData = new mujoco.MjData(newModel);
  if (threaded) mujoco.mju_threadpool(newData, STEP_THREADS);

  model = newModel;
  data = newData;
  sceneGraph = newSceneGraph;
  rebuildIdCaches();
  rebuildBreakableWelds();
  rebuildImpactWatches();
  pendingWake.clear(); // body ids from the old model mean nothing in this one
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
    newData.time = seedState.time;
    mujoco.mj_forward(newModel, newData);
  } else if (preserveState && carried && carried.nq === newModel.nq && carried.nv === newModel.nv) {
    const nq = Math.min(carried.nq, newModel.nq);
    const nv = Math.min(carried.nv, newModel.nv);
    for (let i = 0; i < nq; i++) newData.qpos[i] = carried.qpos[i];
    for (let i = 0; i < nv; i++) newData.qvel[i] = carried.qvel[i];
    const placedActuators = copyCarriedActuators(carried, newModel, newData);
    seedActuatorCtrl(sceneGraph.nodes, newData, placedActuators);
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
    const placed = new Set<string>();
    for (const name in jointIdCache) {
      const from = carried.joints[name];
      if (!from) continue;
      const id = jointIdCache[name];
      const type = newModel.jnt_type[id];
      if (type !== from.type) continue; // same name, different joint: not the same state
      const nq = JOINT_NQ[type] ?? 1;
      const nv = JOINT_NV[type] ?? 1;
      const qTo = newModel.jnt_qposadr[id], vTo = newModel.jnt_dofadr[id];
      if (qTo + nq > newModel.nq || vTo + nv > newModel.nv) continue;
      if (from.qposadr + nq > carried.qpos.length || from.dofadr + nv > carried.qvel.length) continue;
      for (let i = 0; i < nq; i++) newData.qpos[qTo + i] = carried.qpos[from.qposadr + i];
      for (let i = 0; i < nv; i++) newData.qvel[vTo + i] = carried.qvel[from.dofadr + i];
      placed.add(name);
    }
    const placedActuators = copyCarriedActuators(carried, newModel, newData);
    seedActuatorCtrl(sceneGraph.nodes, newData, placedActuators);
    newData.time = carried.time;
    mujoco.mj_forward(newModel, newData);

    // Anything that did NOT come across is new, and gets its opening velocity.
    let seededNew = false;
    const seedNew = (nodes: SceneNode[]) => {
      if (!nodes) return;
      for (const node of nodes) {
        /*
         * A shard is placed for the instant its body broke, but the old model
         * has gone on stepping since. If that body was still in the old model,
         * its state is in `carried` — exactly where it is now — so the shard
         * is put where it would be on the body as it is now. See rebaseShard.
         */
        const from = node.shatterFrom;
        const parent = from && carried.joints[from.joint];
        const own = node.joints?.[0];
        if (from && parent && parent.type === 0 && own?.type === 'free' && !placed.has(own.name)) {
          const id = jointIdCache[own.name];
          if (id !== undefined && newModel.jnt_type[id] === 0) {
            const qa = parent.qposadr, va = parent.dofadr;
            const { qpos, qvel } = rebaseShard(
              { pos: node.pos, quat: node.quat ?? [1, 0, 0, 0], initialVelocity: own.initialVelocity },
              from,
              {
                pos: carried.qpos.subarray(qa, qa + 3),
                quat: carried.qpos.subarray(qa + 3, qa + 7),
                vel: carried.qvel.subarray(va, va + 3),
                angvelLocal: carried.qvel.subarray(va + 3, va + 6),
              },
            );
            const qTo = newModel.jnt_qposadr[id], vTo = newModel.jnt_dofadr[id];
            for (let i = 0; i < 7; i++) newData.qpos[qTo + i] = qpos[i];
            for (let i = 0; i < 6; i++) newData.qvel[vTo + i] = qvel[i];
            placed.add(own.name);
            seededNew = true;
          }
        }
        node.joints?.forEach((j) => {
          if (!j.initialVelocity || placed.has(j.name)) return;
          const id = jointIdCache[j.name];
          if (id === undefined) return;
          const dofAdr = newModel.jnt_dofadr[id];
          for (let i = 0; i < j.initialVelocity!.length; i++) newData.qvel[dofAdr + i] = j.initialVelocity![i];
          seededNew = true;
        });
        seedNew(node.children);
      }
    };
    seedNew(sceneGraph.nodes);
    if (seededNew) mujoco.mj_forward(newModel, newData);
  } else {
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
    for (const j of initVelJoints) {
      const jntId = jointIdCache[j.name];
      if (jntId !== undefined) {
        const dofAdr = newModel.jnt_dofadr[jntId];
        for (let i = 0; i < j.vel.length; i++) newData.qvel[dofAdr + i] = j.vel[i];
        needForward = true;
      }
    }
    if (needForward) mujoco.mj_forward(newModel, newData);
  }

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
    };
  } else {
    sharedBuffers = {};
  }

  // Note: history is NOT cleared here. Every rebuild goes through doBuild —
  // ordinary scene edits, the every-4-builds proactive recycle, and the
  // every-20s seamless mid-play recycle all call this. Wiping history
  // unconditionally would silently truncate physics_get_history/telemetry
  // on every one of those, defeating the "seamless" point of the proactive
  // recycles. Only an explicit RESET/LOAD_PRESET should clear history — see
  // the CLEAR_HISTORY message handler, which those already call.
  accumulator = 0;

  return {
    nq: newModel.nq, nv: newModel.nv, nu: newModel.nu, ngeom: newModel.ngeom, nbody: newModel.nbody,
    timestep: newModel.opt.timestep,
    geom_size: Array.from(newModel.geom_size as ArrayLike<number>),
    geom_type: Array.from(newModel.geom_type as ArrayLike<number>),
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

const runHeadless = (
  xml: string,
  headlessSceneGraph: SceneGraph,
  ticks: number,
  stride = 1,
): HeadlessRunResult => {
  if (!mujoco) throw new Error('MuJoCo module not loaded yet');

  const savedModel = model, savedData = data, savedSceneGraph = sceneGraph;
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
  // breakableWelds holds indices into the LIVE model's equality list, so it has
  // to be swapped out with everything else or the headless run would break
  // welds by the interactive model's numbering.
  const savedBreakableWelds = breakableWelds, savedBrokenWeldKeys = brokenWeldKeys;

  const warnings: string[] = [];
  const savedScriptProblems = scriptProblems;
  scriptProblems = new Map();

  let headlessModel: MjModel | null = null;
  let headlessData: MjData | null = null;
  try {
    if (threaded && savedData) mujoco.mju_threadpool(savedData, 0);
    headlessModel = meshVfs ? mujoco.MjModel.from_xml_string(xml, meshVfs) : mujoco.MjModel.from_xml_string(xml);
    headlessData = new mujoco.MjData(headlessModel);
    if (threaded) mujoco.mju_threadpool(headlessData, STEP_THREADS);

    model = headlessModel;
    data = headlessData;
    sceneGraph = headlessSceneGraph;
    rebuildIdCaches();
    brokenWeldKeys = new Set();
    rebuildBreakableWelds();

    seedActuatorCtrl(sceneGraph.nodes, data);
    mujoco.mj_forward(model, data);

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
    for (const j of initVelJoints) {
      const jntId = jointIdCache[j.name];
      if (jntId !== undefined) {
        const dofAdr = model.jnt_dofadr[jntId];
        for (let i = 0; i < j.vel.length; i++) data.qvel[dofAdr + i] = j.vel[i];
        needForward = true;
      }
    }
    if (needForward) mujoco.mj_forward(model, data);

    // The per-tick aero diagnostics of the most recently stepped tick, so the
    // (possibly deferred) sample() below reports the tick it belongs to.
    let lastAero: Record<string, AeroDiagnostic> = {};

    const outcome = runHeadlessLoop<HistoryEntry>({ ticks, stride }, {
      step: () => {
        data!.xfrc_applied.fill(0);
        data!.qfrc_applied.fill(0);
        lastAero = {};
        executeScripts(sceneGraph.nodes, lastAero);
        applyFreeJointDamping(sceneGraph.nodes);
        wakeBodies();
        mujoco!.mj_step(model!, data!);
        checkConstraintBreaks();
      },
      time: () => data!.time,
      isBad: () => {
        const qpos = data!.qpos;
        for (let i = 0; i < model!.nq; i++) if (!Number.isFinite(qpos[i])) return true;
        const qvel = data!.qvel;
        for (let i = 0; i < model!.nv; i++) if (!Number.isFinite(qvel[i])) return true;
        return false;
      },
      sample: () => buildHistoryEntry(lastAero),
    });

    warnings.push(...collectMujocoWarnings(data));
    warnings.push(...scriptProblems.values());
    if (outcome.truncationDetail) warnings.push(outcome.truncationDetail);

    return {
      ok: true,
      ticksRequested: ticks,
      ticksSimulated: outcome.ticksSimulated,
      truncated: outcome.truncated,
      ...(outcome.truncationReason
        ? { truncationReason: outcome.truncationReason, truncationDetail: outcome.truncationDetail }
        : {}),
      trajectory: outcome.frames,
      warnings,
    };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e), warnings: [...warnings, ...scriptProblems.values()] };
  } finally {
    if (headlessData) { try { headlessData.delete(); } catch { /* ignore */ } }
    if (headlessModel) { try { headlessModel.delete(); } catch { /* ignore */ } }
    if (threaded && savedData && mujoco) { try { mujoco.mju_threadpool(savedData, STEP_THREADS); } catch { /* ignore */ } }
    model = savedModel; data = savedData; sceneGraph = savedSceneGraph;
    scriptState = savedScriptState;
    scriptCache = savedScriptCache;
    pendingWake.clear();
    for (const id of savedPendingWake) pendingWake.add(id);
    bodyIdCache = savedBodyIdCache; jointIdCache = savedJointIdCache;
    geomIdCache = savedGeomIdCache; geomNameCache = savedGeomNameCache; actuatorIdCache = savedActuatorIdCache;
    breakableWelds = savedBreakableWelds; brokenWeldKeys = savedBrokenWeldKeys;
    scriptProblems = savedScriptProblems;
  }
};

self.onmessage = async (evt: MessageEvent) => {
  const msg = evt.data;
  try {
    switch (msg.type) {
      case 'BUILD': {
        try {
          if (!mujoco) await loadMujoco();
          applyMeshFiles(msg.meshFiles, msg.dropMeshes);
          const result = doBuild(msg.xml, msg.sceneGraph, msg.preserveState, msg.seedState, msg.brokenConstraints);
          if (msg.holdForInstall) holdUntil = performance.now() + HOLD_FOR_INSTALL_MS;
          post({ type: 'BUILT', id: msg.id, ok: true, ...result });
          if (isPlaying && isSharedSupported) {
            startWorkerLoop();
          }
        } catch (e) {
          const errMsg = String((e as Error)?.message || e);
          post({ type: 'BUILT', id: msg.id, ok: false, error: errMsg, fatal: /Aborted|enlarge memory|abort|bad_alloc/i.test(errMsg) });
        }
        break;
      }
      case 'SET_ENV': {
        envWindX = msg.windX ?? envWindX;
        envWindY = msg.windY ?? envWindY;
        envDensity = msg.density ?? envDensity;
        break;
      }
      case 'SET_PLAYING': {
        isPlaying = !!msg.isPlaying;
        if (isPlaying) {
          accumulator = 0;
          if (isSharedSupported) {
            startWorkerLoop();
          }
        } else {
          if (isSharedSupported) {
            stopWorkerLoop();
          }
          // The steps since the last frame, so what stops on screen is where
          // the simulation stopped. See FRAME_INTERVAL_MS.
          if (framePending && model && data) postFrame();
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
          if (Array.isArray(msg.value)) {
            for (let i = 0; i < msg.value.length; i++) {
              if (adr + msg.axis + i < model.nq) data.qpos[adr + msg.axis + i] = msg.value[i];
            }
          } else {
            data.qpos[adr + msg.axis] = msg.value;
          }
          pendingWake.add(model.jnt_bodyid[jId]);
          const vadr = model.jnt_dofadr[jId];
          const nv = JOINT_NV[model.jnt_type[jId]] ?? 1;
          for (let i = 0; i < nv; i++) data.qvel[vadr + i] = 0;
          mujoco.mj_forward(model, data);
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
        }
        break;
      }
      case 'RUN_HEADLESS': {
        try {
          if (!mujoco) await loadMujoco();
        } catch (e) {
          post({ type: 'HEADLESS_RESULT', id: msg.id, ok: false, error: String((e as Error)?.message || e), warnings: [] });
          break;
        }
        applyMeshFiles(msg.meshFiles, msg.dropMeshes);
        const result = runHeadless(msg.xml, msg.sceneGraph, msg.ticks, msg.stride);
        post({ type: 'HEADLESS_RESULT', id: msg.id, ...result });
        break;
      }
      case 'GET_HISTORY': {
        const { frames, total, stride } = history.query(msg.query);
        post({ type: 'HISTORY_RESULT', id: msg.id, history: frames, total, stride });
        break;
      }
      case 'GET_TELEMETRY': {
        post({ type: 'TELEMETRY_RESULT', id: msg.id, telemetry: history.latest() });
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
