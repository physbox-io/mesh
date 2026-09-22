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
// mj_step, NaN safety check, and throttled history recording. Stepping is
// driven by TICK messages from the main thread's own requestAnimationFrame
// loop (see stepTick below) rather than a worker-local timer, so it stays in
// phase with rendering instead of adding a whole extra frame of latency.

import load_mujoco from '@mujoco/mujoco';
// The same asset the Emscripten glue would fetch by import.meta.url, as a URL.
// Wanted explicitly so loadMujoco() below can instantiate the module itself and
// keep hold of its WebAssembly.Memory — this build exports neither HEAPU8 nor
// wasmMemory (both abort with "was not exported"), so capturing the instance at
// creation is the only way to read how big the heap has grown. Vite emits the
// file once; the package's exports map does list ./mujoco.wasm, so a bare
// specifier resolves (unlike openscad's - see the note in scadWorker.ts).
import mujocoWasmUrl from '@mujoco/mujoco/mujoco.wasm?url';
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

type Mujoco = Awaited<ReturnType<typeof load_mujoco>>;
type MjModel = InstanceType<Mujoco['MjModel']>;
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
 */
const loadMujoco = async (): Promise<Mujoco> => {
  if (mujoco) return mujoco;
  mujoco = await load_mujoco({
    instantiateWasm: (
      imports: WebAssembly.Imports,
      done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
    ) => {
      WebAssembly.instantiateStreaming(fetch(mujocoWasmUrl), imports).then((result) => {
        wasmMemory = result.instance.exports.memory as WebAssembly.Memory;
        done(result.instance, result.module);
      });
      return {};
    },
  } as Parameters<typeof load_mujoco>[0]);
  return mujoco;
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

let historyBuffer: HistoryEntry[] = [];
const MAX_HISTORY_SIZE = 5000;

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

const scriptCache: Record<string, (api: Record<string, unknown>) => void> = {};

const findNodeById = (nodes: SceneNode[], targetId: string): SceneNode | null => {
  if (!nodes) return null;
  for (const n of nodes) {
    if (n.id === targetId) return n;
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

// Ported verbatim from App.tsx's PhysicsLoop.executeScripts (aerodynamics +
// user control scripts), operating on the worker's own model/data/sceneGraph.
const executeScripts = (nodes: SceneNode[], aeroDiagnostics: Record<string, AeroDiagnostic>) => {
  // Only ever reached from stepTick/runHeadless, both of which have already
  // established that the module, model and data are there.
  const mdl = model!;
  const dat = data!;
  const mj = mujoco!;
  if (!nodes) return;
  for (const node of nodes) {
    if (node.isAerodynamic) {
      const geom = node.geoms?.[0];
      if (geom) {
        const bId = bodyIdCache[node.id] ?? bodyIdCache[node.name] ?? -1;
        if (bId !== -1) {
          let pId = bId;
          while (pId > 0 && mdl.body_dofnum[pId] === 0) {
            pId = mdl.body_parentid[pId];
          }

          const gId = geomIdCache[geom.name || ''] ?? -1;
          let geomWorldX = dat.xpos[bId * 3 + 0];
          let geomWorldY = dat.xpos[bId * 3 + 1];
          let geomWorldZ = dat.xpos[bId * 3 + 2];
          if (gId !== -1) {
            geomWorldX = dat.geom_xpos[gId * 3 + 0];
            geomWorldY = dat.geom_xpos[gId * 3 + 1];
            geomWorldZ = dat.geom_xpos[gId * 3 + 2];
          }

          const rx = geomWorldX - dat.xpos[pId * 3 + 0];
          const ry = geomWorldY - dat.xpos[pId * 3 + 1];
          const rz = geomWorldZ - dat.xpos[pId * 3 + 2];

          const wx = dat.cvel[bId * 6 + 0];
          const wy = dat.cvel[bId * 6 + 1];
          const wz = dat.cvel[bId * 6 + 2];
          const vO_x = dat.cvel[bId * 6 + 3];
          const vO_y = dat.cvel[bId * 6 + 4];
          const vO_z = dat.cvel[bId * 6 + 5];

          const vx = vO_x + (wy * rz - wz * ry);
          const vy = vO_y + (wz * rx - wx * rz);
          const vz = vO_z + (wx * ry - wy * rx);

          const o = bId * 9;
          const noseX = dat.xmat[o + 0], noseY = dat.xmat[o + 3], noseZ = dat.xmat[o + 6];
          const spanX = dat.xmat[o + 1], spanY = dat.xmat[o + 4], spanZ = dat.xmat[o + 7];
          const upX = dat.xmat[o + 2], upY = dat.xmat[o + 5], upZ = dat.xmat[o + 8];

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

            const q = 0.5 * 1.225 * relSpeed * relSpeed;

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

            dat.xfrc_applied[pId * 6 + 0] += fx;
            dat.xfrc_applied[pId * 6 + 1] += fy;
            dat.xfrc_applied[pId * 6 + 2] += fz;

            dat.xfrc_applied[pId * 6 + 3] += tx_aero + tx_roll + tx_lever;
            dat.xfrc_applied[pId * 6 + 4] += ty_aero + ty_roll + ty_lever;
            dat.xfrc_applied[pId * 6 + 5] += tz_aero + tz_roll + tz_lever;

            aeroDiagnostics[node.name || node.id] = {
              relSpeed, alpha: alpha * 180 / Math.PI, CL, CD,
              force: [fx, fy, fz],
              torque: [tx_aero + tx_roll + tx_lever, ty_aero + ty_roll + ty_lever, tz_aero + tz_roll + tz_lever],
            };
          } else {
            aeroDiagnostics[node.name || node.id] = { relSpeed, alpha: 0, CL: 0, CD: 0, force: [0, 0, 0], torque: [0, 0, 0] };
          }

          const DAMPING = 0.0005;
          dat.xfrc_applied[pId * 6 + 3] -= DAMPING * wx;
          dat.xfrc_applied[pId * 6 + 4] -= DAMPING * wy;
          dat.xfrc_applied[pId * 6 + 5] -= DAMPING * wz;
        }
      }
    }

    if (node.script && node.script.trim() !== '') {
      let fn = scriptCache[node.id];
      if (!fn) {
        try {
          fn = new Function('api', node.script) as (api: Record<string, unknown>) => void;
          scriptCache[node.id] = fn;
        } catch (e) {
          console.error(`[Script Compilation Error on node ${node.name}]:`, e);
          fn = () => {};
          scriptCache[node.id] = fn;
        }
      }

      const _resolveBody = (name: string) => bodyIdCache[name] ?? mj.mj_name2id(mdl, mj.mjtObj.mjOBJ_BODY.value, name);
      const _resolveJoint = (name: string) => jointIdCache[name] ?? mj.mj_name2id(mdl, mj.mjtObj.mjOBJ_JOINT.value, name);

      const api = {
        id: node.id,
        name: node.name,
        isKeyPressed: (keyName: string) => !!keyName && pressedKeys.has(keyName.toLowerCase()),
        setPosition: (pos: number[] | number, bodyName = node.id) => {
          const targetNode = findNodeById(sceneGraph.nodes, bodyName);
          if (!targetNode?.joints?.length) return;
          const joint = targetNode.joints[0];
          const jId = _resolveJoint(joint.name);
          if (jId === -1) return;
          const qposadr = mdl.jnt_qposadr[jId];
          if (joint.type === 'free') {
            if (Array.isArray(pos) && pos.length >= 3) {
              dat.qpos[qposadr + 0] = pos[0]; dat.qpos[qposadr + 1] = pos[1]; dat.qpos[qposadr + 2] = pos[2];
            }
          } else if (joint.type === 'ball') {
            if (Array.isArray(pos) && pos.length >= 4) {
              dat.qpos[qposadr + 0] = pos[0]; dat.qpos[qposadr + 1] = pos[1]; dat.qpos[qposadr + 2] = pos[2]; dat.qpos[qposadr + 3] = pos[3];
            }
          } else {
            dat.qpos[qposadr] = typeof pos === 'number' ? pos : (Array.isArray(pos) ? pos[0] : 0);
          }
        },
        setVelocity: (vel: number[] | number, bodyName = node.id) => {
          const targetNode = findNodeById(sceneGraph.nodes, bodyName);
          if (!targetNode?.joints?.length) return;
          const joint = targetNode.joints[0];
          const jId = _resolveJoint(joint.name);
          if (jId === -1) return;
          const dofadr = mdl.jnt_dofadr[jId];
          if (joint.type === 'free') {
            if (Array.isArray(vel) && vel.length >= 3) {
              dat.qvel[dofadr + 0] = vel[0]; dat.qvel[dofadr + 1] = vel[1]; dat.qvel[dofadr + 2] = vel[2];
            }
          } else {
            dat.qvel[dofadr] = typeof vel === 'number' ? vel : (Array.isArray(vel) ? vel[0] : 0);
          }
        },
        setAngularVelocity: (angvel: number[] | number, bodyName = node.id) => {
          const targetNode = findNodeById(sceneGraph.nodes, bodyName);
          if (!targetNode?.joints?.length) return;
          const joint = targetNode.joints[0];
          const jId = _resolveJoint(joint.name);
          if (jId === -1) return;
          const dofadr = mdl.jnt_dofadr[jId];
          if (joint.type === 'free') {
            if (Array.isArray(angvel) && angvel.length >= 3) {
              dat.qvel[dofadr + 3] = angvel[0]; dat.qvel[dofadr + 4] = angvel[1]; dat.qvel[dofadr + 5] = angvel[2];
            }
          } else if (joint.type === 'ball') {
            if (Array.isArray(angvel) && angvel.length >= 3) {
              dat.qvel[dofadr + 0] = angvel[0]; dat.qvel[dofadr + 1] = angvel[1]; dat.qvel[dofadr + 2] = angvel[2];
            }
          } else if (joint.type === 'hinge') {
            dat.qvel[dofadr] = typeof angvel === 'number' ? angvel : (Array.isArray(angvel) ? angvel[0] : 0);
          }
        },
        getPosition: (bodyName = node.id) => {
          const bId = _resolveBody(bodyName);
          return bId !== -1 ? [dat.xpos[bId * 3], dat.xpos[bId * 3 + 1], dat.xpos[bId * 3 + 2]] : [0, 0, 0];
        },
        getVelocity: (bodyName = node.id) => {
          const bId = _resolveBody(bodyName);
          return bId !== -1 ? [dat.cvel[bId * 6 + 3], dat.cvel[bId * 6 + 4], dat.cvel[bId * 6 + 5]] : [0, 0, 0];
        },
        getAngularVelocity: (bodyName = node.id) => {
          const bId = _resolveBody(bodyName);
          return bId !== -1 ? [dat.cvel[bId * 6 + 0], dat.cvel[bId * 6 + 1], dat.cvel[bId * 6 + 2]] : [0, 0, 0];
        },
        getMass: (bodyName = node.id) => {
          const bId = _resolveBody(bodyName);
          return bId !== -1 ? mdl.body_mass[bId] : 0;
        },
        getJointPosition: (jointName: string) => {
          const jId = _resolveJoint(jointName);
          return jId !== -1 ? dat.qpos[mdl.jnt_qposadr[jId]] : 0;
        },
        getJointVelocity: (jointName: string) => {
          const jId = _resolveJoint(jointName);
          return jId !== -1 ? dat.qvel[mdl.jnt_dofadr[jId]] : 0;
        },
        applyForce: (forceVec: number[], bodyName = node.id) => {
          if (!Array.isArray(forceVec)) return;
          const bId = _resolveBody(bodyName);
          if (bId === -1) return;
          dat.xfrc_applied[bId * 6 + 0] += forceVec[0] || 0;
          dat.xfrc_applied[bId * 6 + 1] += forceVec[1] || 0;
          dat.xfrc_applied[bId * 6 + 2] += forceVec[2] || 0;
        },
        applyTorque: (torqueVec: number[], bodyName = node.id) => {
          if (!Array.isArray(torqueVec)) return;
          const bId = _resolveBody(bodyName);
          if (bId === -1) return;
          dat.xfrc_applied[bId * 6 + 3] += torqueVec[0] || 0;
          dat.xfrc_applied[bId * 6 + 4] += torqueVec[1] || 0;
          dat.xfrc_applied[bId * 6 + 5] += torqueVec[2] || 0;
        },
        getOrientation: (bodyName = node.id) => {
          const bId = _resolveBody(bodyName);
          if (bId === -1) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
          const o = bId * 9;
          return [dat.xmat[o], dat.xmat[o+1], dat.xmat[o+2], dat.xmat[o+3], dat.xmat[o+4], dat.xmat[o+5], dat.xmat[o+6], dat.xmat[o+7], dat.xmat[o+8]];
        },
        applyJointForce: (jointName: string, forceVal: number) => {
          if (typeof forceVal !== 'number') return;
          const jId = _resolveJoint(jointName);
          if (jId !== -1) dat.qfrc_applied[mdl.jnt_dofadr[jId]] += forceVal;
        },
        setActuatorControl: (actuatorName: string, ctrlVal: number) => {
          if (typeof ctrlVal !== 'number') return;
          const actId = actuatorIdCache[actuatorName] ?? -1;
          if (actId !== -1) dat.ctrl[actId] = ctrlVal;
        },
        getTime: () => (dat ? dat.time : 0),
        getWind: () => [envWindX || 0, envWindY || 0],
        log: (msg: unknown) => console.log(`[Script:${node.name}]`, msg),
      };

      try { fn(api); } catch (e) { console.error(`[Script Runtime Error on node ${node.name}]:`, e); }
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
            const wx = dat.cvel[bId * 6 + 0], wy = dat.cvel[bId * 6 + 1], wz = dat.cvel[bId * 6 + 2];
            const vx = dat.cvel[bId * 6 + 3], vy = dat.cvel[bId * 6 + 4], vz = dat.cvel[bId * 6 + 5];
            const c = joint.damping;
            const mass = mdl.body_mass[bId] || 1.0;
            const ix = mdl.body_inertia[bId * 3 + 0] || 1.0;
            const iy = mdl.body_inertia[bId * 3 + 1] || 1.0;
            const iz = mdl.body_inertia[bId * 3 + 2] || 1.0;
            dat.xfrc_applied[bId * 6 + 0] -= c * mass * vx;
            dat.xfrc_applied[bId * 6 + 1] -= c * mass * vy;
            dat.xfrc_applied[bId * 6 + 2] -= c * mass * vz;
            dat.xfrc_applied[bId * 6 + 3] -= c * ix * wx;
            dat.xfrc_applied[bId * 6 + 4] -= c * iy * wy;
            dat.xfrc_applied[bId * 6 + 5] -= c * iz * wz;
          }
        }
      }
    }
    applyFreeJointDamping(node.children || []);
  }
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

  const bx = dat.xpos[bId * 3], by = dat.xpos[bId * 3 + 1], bz = dat.xpos[bId * 3 + 2];
  const vx = dat.cvel[bId * 6 + 3], vy = dat.cvel[bId * 6 + 4], vz = dat.cvel[bId * 6 + 5];
  const mass = mdl.body_mass[bId] || 1.0;
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
  const K = 200.0 * mass;
  const D = 2.0 * Math.sqrt(mass * K); // critical damping, so nothing oscillates

  let fx = K * (dragTarget.x - bx) - D * vx;
  let fy = K * (dragTarget.y - by) - D * vy;
  let fz = K * (dragTarget.z - bz) - D * vz;

  const maxForce = 3.0 * mass * 9.81;
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
        const wx = dat.cvel[bId * 6 + 0], wy = dat.cvel[bId * 6 + 1], wz = dat.cvel[bId * 6 + 2];
        const vO_x = dat.cvel[bId * 6 + 3], vO_y = dat.cvel[bId * 6 + 4], vO_z = dat.cvel[bId * 6 + 5];
        const x_pos = dat.xpos[bId * 3 + 0], y_pos = dat.xpos[bId * 3 + 1], z_pos = dat.xpos[bId * 3 + 2];
        const vx = vO_x + (wy * z_pos - wz * y_pos);
        const vy = vO_y + (wz * x_pos - wx * z_pos);
        const vz = vO_z + (wx * y_pos - wy * x_pos);
        bodies[node.id] = {
          pos: [x_pos, y_pos, z_pos], vel: [vx, vy, vz], angvel: [wx, wy, wz],
          xfrc_applied: [
            dat.xfrc_applied[bId * 6 + 0], dat.xfrc_applied[bId * 6 + 1], dat.xfrc_applied[bId * 6 + 2],
            dat.xfrc_applied[bId * 6 + 3], dat.xfrc_applied[bId * 6 + 4], dat.xfrc_applied[bId * 6 + 5],
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

// Stepping is driven by TICK messages from the main thread's own
// requestAnimationFrame loop (see App.tsx's PhysicsLoop / physicsWorkerClient's
// `tick()`), not by a worker-local setInterval. A worker-local timer runs on
// its own independent clock, out of phase with the render loop, and was
// adding roughly a whole extra frame of perceived latency to direct
// manipulation (dragging bodies) on top of the unavoidable message-passing
// round trip. Ticking in lockstep with the main thread's rAF keeps the added
// overhead to just that one cross-thread hop.
const stepTick = (delta: number) => {
  if (!isPlaying || !model || !data || !mujoco) return;
  accumulator += Math.min(delta, 0.1);

  const stepSize = model.opt.timestep;
  const stepsNeeded = Math.floor(accumulator / stepSize);
  accumulator -= stepsNeeded * stepSize;

  for (let i = 0; i < stepsNeeded; i++) {
    try {
      data.xfrc_applied.fill(0);
      data.qfrc_applied.fill(0);

      applyDragForce();

      const aeroDiagnostics: Record<string, AeroDiagnostic> = {};
      executeScripts(sceneGraph.nodes, aeroDiagnostics);
      applyFreeJointDamping(sceneGraph.nodes);

      mujoco.mj_step(model, data);
      stepCount++;

      if (stepCount % 10 === 0) {
        const entry = buildHistoryEntry(aeroDiagnostics);
        historyBuffer.push(entry);
        if (historyBuffer.length > MAX_HISTORY_SIZE) {
          historyBuffer.shift();
        }
      }

      const nq = model.nq;
      for (let j = 0; j < nq; j++) {
        if (isNaN(data.qpos[j])) {
          post({ type: 'ERROR', message: 'NaN detected in qpos — simulation stopped.', fatal: false });
          isPlaying = false;
          return;
        }
      }
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      const fatal = /Aborted|enlarge memory|abort|bad_alloc/i.test(msg);
      post({ type: 'ERROR', message: msg, fatal, lastState: fatal ? { qpos: Array.from(data.qpos), qvel: Array.from(data.qvel), time: data.time } : undefined });
      isPlaying = false;
      return;
    }
  }

  if (stepsNeeded > 0) {
    const snap = snapshot();
    if (isSharedSupported) {
      post({ type: 'FRAME', time: snap.time, heapBytes: snap.heapBytes, isShared: true });
    } else {
      post({ type: 'FRAME', ...snap, isShared: false }, [
        snap.qpos.buffer, snap.qvel.buffer, snap.ctrl.buffer,
        snap.xfrc_applied.buffer, snap.qfrc_applied.buffer,
        snap.xpos.buffer, snap.xmat.buffer, snap.cvel.buffer,
        snap.geom_xpos.buffer, snap.geom_xmat.buffer
      ]);
    }
  }
};

let workerTimerId: ReturnType<typeof setTimeout> | null = null;
let lastTickTime = 0;

const startWorkerLoop = () => {
  if (workerTimerId) return;
  lastTickTime = performance.now();
  const workerTick = () => {
    if (!isPlaying || !model || !data || !mujoco) {
      workerTimerId = null;
      return;
    }
    const now = performance.now();
    const elapsedSeconds = (now - lastTickTime) / 1000;
    lastTickTime = now;
    
    stepTick(elapsedSeconds);
    workerTimerId = setTimeout(workerTick, 4);
  };
  workerTimerId = setTimeout(workerTick, 4);
};

const stopWorkerLoop = () => {
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

const doBuild = (
  xml: string,
  newSceneGraph: SceneGraph,
  preserveState: boolean,
  seedState?: { qpos: number[]; qvel: number[]; ctrl?: number[]; time: number },
) => {
  const oldModel = model;
  const oldData = data;

  if (!mujoco) throw new Error('MuJoCo module not loaded yet');

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

  const newModel = mujoco.MjModel.from_xml_string(xml);
  const newData = new mujoco.MjData(newModel);

  model = newModel;
  data = newData;
  sceneGraph = newSceneGraph;
  rebuildIdCaches();
  for (const k of Object.keys(scriptCache)) delete scriptCache[k];

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
  } else if (preserveState && oldModel && oldData && oldModel.nq === newModel.nq && oldModel.nv === newModel.nv) {
    const nq = Math.min(oldModel.nq, newModel.nq);
    const nv = Math.min(oldModel.nv, newModel.nv);
    const nu = Math.min(oldModel.nu, newModel.nu);
    for (let i = 0; i < nq; i++) newData.qpos[i] = oldData.qpos[i];
    for (let i = 0; i < nv; i++) newData.qvel[i] = oldData.qvel[i];
    for (let i = 0; i < nu; i++) newData.ctrl[i] = oldData.ctrl[i];
    newData.time = oldData.time;
    mujoco.mj_forward(newModel, newData);
  } else {
    const actuators: SceneJoint[] = [];
    const traverse = (nodes: SceneNode[]) => {
      if (!nodes) return;
      for (const node of nodes) {
        node.joints?.forEach((j) => { if (j.actuator) actuators.push(j); });
        traverse(node.children);
      }
    };
    traverse(sceneGraph.nodes);
    actuators.forEach((j, idx) => {
      if (j.actuator && j.actuator.ctrlValue !== undefined) newData.ctrl[idx] = j.actuator.ctrlValue;
    });

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
    // The vector is a heap copy in its own right, like the contact vector in
    // snapshot() — releasing only its members still leaks one per call.
    stats.delete?.();
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
  const savedBodyIdCache = bodyIdCache, savedJointIdCache = jointIdCache;
  const savedGeomIdCache = geomIdCache, savedGeomNameCache = geomNameCache, savedActuatorIdCache = actuatorIdCache;

  const warnings: string[] = [];

  let headlessModel: MjModel | null = null;
  let headlessData: MjData | null = null;
  try {
    headlessModel = mujoco.MjModel.from_xml_string(xml);
    headlessData = new mujoco.MjData(headlessModel);

    model = headlessModel;
    data = headlessData;
    sceneGraph = headlessSceneGraph;
    rebuildIdCaches();

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
        mujoco!.mj_step(model!, data!);
      },
      time: () => data!.time,
      isBad: () => !Number.isFinite(data!.qpos[0]),
      sample: () => buildHistoryEntry(lastAero),
    });

    warnings.push(...collectMujocoWarnings(data));
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
    return { ok: false, error: String((e as Error)?.message || e), warnings };
  } finally {
    if (headlessModel) { try { headlessModel.delete(); } catch { /* ignore */ } }
    if (headlessData) { try { headlessData.delete(); } catch { /* ignore */ } }
    model = savedModel; data = savedData; sceneGraph = savedSceneGraph;
    bodyIdCache = savedBodyIdCache; jointIdCache = savedJointIdCache;
    geomIdCache = savedGeomIdCache; geomNameCache = savedGeomNameCache; actuatorIdCache = savedActuatorIdCache;
  }
};

self.onmessage = async (evt: MessageEvent) => {
  const msg = evt.data;
  try {
    switch (msg.type) {
      case 'BUILD': {
        if (!mujoco) await loadMujoco();
        try {
          const result = doBuild(msg.xml, msg.sceneGraph, msg.preserveState, msg.seedState);
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
        }
        break;
      }
      case 'TICK': {
        if (!isSharedSupported) {
          stepTick(msg.delta);
        }
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
          data.qpos[adr + msg.axis] = msg.value;
          const vadr = model.jnt_dofadr[jId];
          for (let i = 0; i < 6; i++) data.qvel[vadr + i] = 0;
          mujoco.mj_forward(model, data);
          const snap = snapshot();
          if (isSharedSupported) {
            post({ type: 'FRAME', time: snap.time, heapBytes: snap.heapBytes, isShared: true });
          } else {
            post({ type: 'FRAME', ...snap, isShared: false }, [
              snap.qpos.buffer, snap.qvel.buffer, snap.ctrl.buffer,
              snap.xfrc_applied.buffer, snap.qfrc_applied.buffer,
              snap.xpos.buffer, snap.xmat.buffer, snap.cvel.buffer,
              snap.geom_xpos.buffer, snap.geom_xmat.buffer
            ]);
          }
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
        if (!mujoco) await loadMujoco();
        const result = runHeadless(msg.xml, msg.sceneGraph, msg.ticks, msg.stride);
        post({ type: 'HEADLESS_RESULT', id: msg.id, ...result });
        break;
      }
      case 'GET_HISTORY': {
        post({ type: 'HISTORY_RESULT', id: msg.id, history: historyBuffer });
        break;
      }
      case 'GET_TELEMETRY': {
        const latest = historyBuffer.length > 0 ? historyBuffer[historyBuffer.length - 1] : null;
        post({ type: 'TELEMETRY_RESULT', id: msg.id, telemetry: latest });
        break;
      }
      case 'CLEAR_HISTORY': {
        historyBuffer = [];
        break;
      }
      default:
        break;
    }
  } catch (e) {
    post({ type: 'ERROR', message: String((e as Error)?.message || e), fatal: false });
  }
};
