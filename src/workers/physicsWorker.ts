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

type SceneNode = any;

let mujoco: any = null;
let model: any = null;
let data: any = null;
let sceneGraph: { nodes: SceneNode[] } = { nodes: [] };

let isPlaying = false;
let draggedNodeId: string | null = null;
let dragTarget: { x: number; y: number; z: number } | null = null;
let pressedKeys = new Set<string>();

let stepCount = 0;
let accumulator = 0;

let historyBuffer: any[] = [];
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

const scriptCache: Record<string, Function> = {};

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
  const bCache: Record<string, number> = {};
  const jCache: Record<string, number> = {};
  const collectIds = (nodes: SceneNode[]) => {
    if (!nodes) return;
    for (const node of nodes) {
      let bId = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, node.name || node.id);
      if (bId === -1 && node.id) {
        bId = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, node.id);
      }
      if (bId !== -1) {
        bCache[node.id] = bId;
        if (node.name) bCache[node.name] = bId;
      }
      node.joints?.forEach((j: any) => {
        const jId = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT.value, j.name);
        if (jId !== -1) jCache[j.name] = jId;
      });
      collectIds(node.children || []);
    }
  };
  collectIds(sceneGraph.nodes);

  const giCache: Record<string, number> = {};
  const gnCache: Record<number, string> = {};
  for (let g = 0; g < model.ngeom; g++) {
    const name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM.value, g);
    gnCache[g] = name || `geom_${g}`;
    if (name) giCache[name] = g;
  }
  const aCache: Record<string, number> = {};
  for (let a = 0; a < model.nu; a++) {
    const name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_ACTUATOR.value, a);
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
const executeScripts = (nodes: SceneNode[], aeroDiagnostics: Record<string, any>) => {
  if (!nodes) return;
  for (const node of nodes) {
    if (node.isAerodynamic) {
      const geom = node.geoms?.[0];
      if (geom) {
        const bId = bodyIdCache[node.id] ?? bodyIdCache[node.name] ?? -1;
        if (bId !== -1) {
          let pId = bId;
          while (pId > 0 && model.body_dofnum[pId] === 0) {
            pId = model.body_parentid[pId];
          }

          const gId = geomIdCache[geom.name || ''] ?? -1;
          let geomWorldX = data.xpos[bId * 3 + 0];
          let geomWorldY = data.xpos[bId * 3 + 1];
          let geomWorldZ = data.xpos[bId * 3 + 2];
          if (gId !== -1) {
            geomWorldX = data.geom_xpos[gId * 3 + 0];
            geomWorldY = data.geom_xpos[gId * 3 + 1];
            geomWorldZ = data.geom_xpos[gId * 3 + 2];
          }

          const rx = geomWorldX - data.xpos[pId * 3 + 0];
          const ry = geomWorldY - data.xpos[pId * 3 + 1];
          const rz = geomWorldZ - data.xpos[pId * 3 + 2];

          const wx = data.cvel[bId * 6 + 0];
          const wy = data.cvel[bId * 6 + 1];
          const wz = data.cvel[bId * 6 + 2];
          const vO_x = data.cvel[bId * 6 + 3];
          const vO_y = data.cvel[bId * 6 + 4];
          const vO_z = data.cvel[bId * 6 + 5];

          const vx = vO_x + (wy * rz - wz * ry);
          const vy = vO_y + (wz * rx - wx * rz);
          const vz = vO_z + (wx * ry - wy * rx);

          const o = bId * 9;
          const noseX = data.xmat[o + 0], noseY = data.xmat[o + 3], noseZ = data.xmat[o + 6];
          const spanX = data.xmat[o + 1], spanY = data.xmat[o + 4], spanZ = data.xmat[o + 7];
          const upX = data.xmat[o + 2], upY = data.xmat[o + 5], upZ = data.xmat[o + 8];

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

            const u_nose = -(vhx * noseX + vhy * noseY + vhz * noseZ);
            const u_up = -(vhx * upX + vhy * upY + vhz * upZ);

            const alpha = Math.atan2(u_up, u_nose);

            const CL = 1.5 * Math.sin(2 * alpha);
            const CD = 0.08 + 1.2 * Math.sin(alpha) * Math.sin(alpha);

            const ldx = -u_up * noseX + u_nose * upX;
            const ldy = -u_up * noseY + u_nose * upY;
            const ldz = -u_up * noseZ + u_nose * upZ;

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

            data.xfrc_applied[pId * 6 + 0] += fx;
            data.xfrc_applied[pId * 6 + 1] += fy;
            data.xfrc_applied[pId * 6 + 2] += fz;

            data.xfrc_applied[pId * 6 + 3] += tx_aero + tx_roll + tx_lever;
            data.xfrc_applied[pId * 6 + 4] += ty_aero + ty_roll + ty_lever;
            data.xfrc_applied[pId * 6 + 5] += tz_aero + tz_roll + tz_lever;

            aeroDiagnostics[node.name || node.id] = {
              relSpeed, alpha: alpha * 180 / Math.PI, CL, CD,
              force: [fx, fy, fz],
              torque: [tx_aero + tx_roll + tx_lever, ty_aero + ty_roll + ty_lever, tz_aero + tz_roll + tz_lever],
            };
          } else {
            aeroDiagnostics[node.name || node.id] = { relSpeed, alpha: 0, CL: 0, CD: 0, force: [0, 0, 0], torque: [0, 0, 0] };
          }

          const DAMPING = 0.0005;
          data.xfrc_applied[pId * 6 + 3] -= DAMPING * wx;
          data.xfrc_applied[pId * 6 + 4] -= DAMPING * wy;
          data.xfrc_applied[pId * 6 + 5] -= DAMPING * wz;
        }
      }
    }

    if (node.script && node.script.trim() !== '') {
      let fn = scriptCache[node.id];
      if (!fn) {
        try {
          fn = new Function('api', node.script);
          scriptCache[node.id] = fn;
        } catch (e: any) {
          console.error(`[Script Compilation Error on node ${node.name}]:`, e);
          fn = () => {};
          scriptCache[node.id] = fn;
        }
      }

      const _resolveBody = (name: string) => bodyIdCache[name] ?? mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, name);
      const _resolveJoint = (name: string) => jointIdCache[name] ?? mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT.value, name);

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
          const qposadr = model.jnt_qposadr[jId];
          if (joint.type === 'free') {
            if (Array.isArray(pos) && pos.length >= 3) {
              data.qpos[qposadr + 0] = pos[0]; data.qpos[qposadr + 1] = pos[1]; data.qpos[qposadr + 2] = pos[2];
            }
          } else if (joint.type === 'ball') {
            if (Array.isArray(pos) && pos.length >= 4) {
              data.qpos[qposadr + 0] = pos[0]; data.qpos[qposadr + 1] = pos[1]; data.qpos[qposadr + 2] = pos[2]; data.qpos[qposadr + 3] = pos[3];
            }
          } else {
            data.qpos[qposadr] = typeof pos === 'number' ? pos : (Array.isArray(pos) ? pos[0] : 0);
          }
        },
        setVelocity: (vel: number[] | number, bodyName = node.id) => {
          const targetNode = findNodeById(sceneGraph.nodes, bodyName);
          if (!targetNode?.joints?.length) return;
          const joint = targetNode.joints[0];
          const jId = _resolveJoint(joint.name);
          if (jId === -1) return;
          const dofadr = model.jnt_dofadr[jId];
          if (joint.type === 'free') {
            if (Array.isArray(vel) && vel.length >= 3) {
              data.qvel[dofadr + 0] = vel[0]; data.qvel[dofadr + 1] = vel[1]; data.qvel[dofadr + 2] = vel[2];
            }
          } else {
            data.qvel[dofadr] = typeof vel === 'number' ? vel : (Array.isArray(vel) ? vel[0] : 0);
          }
        },
        setAngularVelocity: (angvel: number[] | number, bodyName = node.id) => {
          const targetNode = findNodeById(sceneGraph.nodes, bodyName);
          if (!targetNode?.joints?.length) return;
          const joint = targetNode.joints[0];
          const jId = _resolveJoint(joint.name);
          if (jId === -1) return;
          const dofadr = model.jnt_dofadr[jId];
          if (joint.type === 'free') {
            if (Array.isArray(angvel) && angvel.length >= 3) {
              data.qvel[dofadr + 3] = angvel[0]; data.qvel[dofadr + 4] = angvel[1]; data.qvel[dofadr + 5] = angvel[2];
            }
          } else if (joint.type === 'ball') {
            if (Array.isArray(angvel) && angvel.length >= 3) {
              data.qvel[dofadr + 0] = angvel[0]; data.qvel[dofadr + 1] = angvel[1]; data.qvel[dofadr + 2] = angvel[2];
            }
          } else if (joint.type === 'hinge') {
            data.qvel[dofadr] = typeof angvel === 'number' ? angvel : (Array.isArray(angvel) ? angvel[0] : 0);
          }
        },
        getPosition: (bodyName = node.id) => {
          const bId = _resolveBody(bodyName);
          return bId !== -1 ? [data.xpos[bId * 3], data.xpos[bId * 3 + 1], data.xpos[bId * 3 + 2]] : [0, 0, 0];
        },
        getVelocity: (bodyName = node.id) => {
          const bId = _resolveBody(bodyName);
          return bId !== -1 ? [data.cvel[bId * 6 + 3], data.cvel[bId * 6 + 4], data.cvel[bId * 6 + 5]] : [0, 0, 0];
        },
        getAngularVelocity: (bodyName = node.id) => {
          const bId = _resolveBody(bodyName);
          return bId !== -1 ? [data.cvel[bId * 6 + 0], data.cvel[bId * 6 + 1], data.cvel[bId * 6 + 2]] : [0, 0, 0];
        },
        getMass: (bodyName = node.id) => {
          const bId = _resolveBody(bodyName);
          return bId !== -1 ? model.body_mass[bId] : 0;
        },
        getJointPosition: (jointName: string) => {
          const jId = _resolveJoint(jointName);
          return jId !== -1 ? data.qpos[model.jnt_qposadr[jId]] : 0;
        },
        getJointVelocity: (jointName: string) => {
          const jId = _resolveJoint(jointName);
          return jId !== -1 ? data.qvel[model.jnt_dofadr[jId]] : 0;
        },
        applyForce: (forceVec: number[], bodyName = node.id) => {
          if (!Array.isArray(forceVec)) return;
          const bId = _resolveBody(bodyName);
          if (bId === -1) return;
          data.xfrc_applied[bId * 6 + 0] += forceVec[0] || 0;
          data.xfrc_applied[bId * 6 + 1] += forceVec[1] || 0;
          data.xfrc_applied[bId * 6 + 2] += forceVec[2] || 0;
        },
        applyTorque: (torqueVec: number[], bodyName = node.id) => {
          if (!Array.isArray(torqueVec)) return;
          const bId = _resolveBody(bodyName);
          if (bId === -1) return;
          data.xfrc_applied[bId * 6 + 3] += torqueVec[0] || 0;
          data.xfrc_applied[bId * 6 + 4] += torqueVec[1] || 0;
          data.xfrc_applied[bId * 6 + 5] += torqueVec[2] || 0;
        },
        getOrientation: (bodyName = node.id) => {
          const bId = _resolveBody(bodyName);
          if (bId === -1) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
          const o = bId * 9;
          return [data.xmat[o], data.xmat[o+1], data.xmat[o+2], data.xmat[o+3], data.xmat[o+4], data.xmat[o+5], data.xmat[o+6], data.xmat[o+7], data.xmat[o+8]];
        },
        applyJointForce: (jointName: string, forceVal: number) => {
          if (typeof forceVal !== 'number') return;
          const jId = _resolveJoint(jointName);
          if (jId !== -1) data.qfrc_applied[model.jnt_dofadr[jId]] += forceVal;
        },
        setActuatorControl: (actuatorName: string, ctrlVal: number) => {
          if (typeof ctrlVal !== 'number') return;
          const actId = actuatorIdCache[actuatorName] ?? -1;
          if (actId !== -1) data.ctrl[actId] = ctrlVal;
        },
        getTime: () => (data ? data.time : 0),
        getWind: () => [envWindX || 0, envWindY || 0],
        log: (msg: any) => console.log(`[Script:${node.name}]`, msg),
      };

      try { fn(api); } catch (e: any) { console.error(`[Script Runtime Error on node ${node.name}]:`, e); }
    }

    if (node.children) executeScripts(node.children, aeroDiagnostics);
  }
};

const applyFreeJointDamping = (nodes: SceneNode[]) => {
  if (!nodes) return;
  for (const node of nodes) {
    if (node.joints) {
      for (const joint of node.joints) {
        if (joint.type === 'free' && joint.damping !== undefined && joint.damping > 0) {
          const bId = bodyIdCache[node.id] ?? bodyIdCache[node.name] ?? -1;
          if (bId !== -1) {
            const wx = data.cvel[bId * 6 + 0], wy = data.cvel[bId * 6 + 1], wz = data.cvel[bId * 6 + 2];
            const vx = data.cvel[bId * 6 + 3], vy = data.cvel[bId * 6 + 4], vz = data.cvel[bId * 6 + 5];
            const c = joint.damping;
            const mass = model.body_mass[bId] || 1.0;
            const ix = model.body_inertia[bId * 3 + 0] || 1.0;
            const iy = model.body_inertia[bId * 3 + 1] || 1.0;
            const iz = model.body_inertia[bId * 3 + 2] || 1.0;
            data.xfrc_applied[bId * 6 + 0] -= c * mass * vx;
            data.xfrc_applied[bId * 6 + 1] -= c * mass * vy;
            data.xfrc_applied[bId * 6 + 2] -= c * mass * vz;
            data.xfrc_applied[bId * 6 + 3] -= c * ix * wx;
            data.xfrc_applied[bId * 6 + 4] -= c * iy * wy;
            data.xfrc_applied[bId * 6 + 5] -= c * iz * wz;
          }
        }
      }
    }
    applyFreeJointDamping(node.children || []);
  }
};

const applyDragForce = () => {
  if (!draggedNodeId || !dragTarget) return;
  let targetBodyName = draggedNodeId;
  let bestMass = -1;
  const findHeaviestDescendant = (nodeId: string) => {
    const bid = bodyIdCache[nodeId] ?? -1;
    if (bid !== -1) {
      const m = model.body_mass[bid] || 0;
      if (m > bestMass) { bestMass = m; targetBodyName = nodeId; }
    }
    const node = findNodeById(sceneGraph.nodes, nodeId);
    for (const child of node?.children || []) findHeaviestDescendant(child.id);
  };
  findHeaviestDescendant(draggedNodeId);

  const bId = bodyIdCache[targetBodyName] ?? -1;
  if (bId === -1) return;

  const bx = data.xpos[bId * 3], by = data.xpos[bId * 3 + 1], bz = data.xpos[bId * 3 + 2];
  const vx = data.cvel[bId * 6 + 3], vy = data.cvel[bId * 6 + 4], vz = data.cvel[bId * 6 + 5];
  const mass = model.body_mass[bId] || 1.0;
  const K = 200.0;
  const D = 2.0 * Math.sqrt(mass * K);

  let fx = K * (dragTarget.x - bx) - D * vx;
  let fy = K * (dragTarget.y - by) - D * vy;
  let fz = K * (dragTarget.z - bz) - D * vz;

  const maxForce = 3.0 * mass * 9.81;
  const netMag = Math.sqrt(fx * fx + fy * fy + fz * fz);
  if (netMag > maxForce) {
    const scale = maxForce / netMag;
    fx *= scale; fy *= scale; fz *= scale;
  }

  data.xfrc_applied[bId * 6 + 0] = fx;
  data.xfrc_applied[bId * 6 + 1] = fy;
  data.xfrc_applied[bId * 6 + 2] = fz;
};

const buildHistoryEntry = (aeroDiagnostics: Record<string, any>) => {
  const bodies: Record<string, any> = {};
  const joints: Record<string, any> = {};
  const collectNodeData = (nodesList: SceneNode[]) => {
    if (!nodesList) return;
    for (const node of nodesList) {
      const bId = bodyIdCache[node.id];
      if (bId !== undefined) {
        const wx = data.cvel[bId * 6 + 0], wy = data.cvel[bId * 6 + 1], wz = data.cvel[bId * 6 + 2];
        const vO_x = data.cvel[bId * 6 + 3], vO_y = data.cvel[bId * 6 + 4], vO_z = data.cvel[bId * 6 + 5];
        const x_pos = data.xpos[bId * 3 + 0], y_pos = data.xpos[bId * 3 + 1], z_pos = data.xpos[bId * 3 + 2];
        const vx = vO_x + (wy * z_pos - wz * y_pos);
        const vy = vO_y + (wz * x_pos - wx * z_pos);
        const vz = vO_z + (wx * y_pos - wy * x_pos);
        bodies[node.id] = {
          pos: [x_pos, y_pos, z_pos], vel: [vx, vy, vz], angvel: [wx, wy, wz],
          xfrc_applied: [
            data.xfrc_applied[bId * 6 + 0], data.xfrc_applied[bId * 6 + 1], data.xfrc_applied[bId * 6 + 2],
            data.xfrc_applied[bId * 6 + 3], data.xfrc_applied[bId * 6 + 4], data.xfrc_applied[bId * 6 + 5],
          ],
        };
      }
      node.joints?.forEach((j: any) => {
        const jId = jointIdCache[j.name];
        if (jId !== undefined) {
          joints[j.name] = { pos: data.qpos[model.jnt_qposadr[jId]], vel: data.qvel[model.jnt_dofadr[jId]], qfrc_applied: data.qfrc_applied[model.jnt_dofadr[jId]] };
        }
      });
      if (node.children) collectNodeData(node.children);
    }
  };
  collectNodeData(sceneGraph.nodes);

  const contacts: any[] = [];
  const ncon = data.contact.size();
  for (let c = 0; c < ncon; c++) {
    const contact = data.contact.get(c);
    if (contact) {
      contacts.push({ geom1: geomNameCache[contact.geom1] ?? `geom_${contact.geom1}`, geom2: geomNameCache[contact.geom2] ?? `geom_${contact.geom2}`, dist: contact.dist });
      contact.delete();
    }
  }

  return { time: data.time, bodies, joints, contacts, aeroDiagnostics };
};

let envWindX = 0;
let envWindY = 0;

// Snapshot everything the main thread needs to render + mirror `model`/`data`.
const snapshot = () => {
  const { qpos, qvel, ctrl, xfrc_applied, qfrc_applied, xpos, xmat, cvel, geom_xpos, geom_xmat } = sharedBuffers;
  if (isSharedSupported && qpos && qvel && ctrl && xfrc_applied && qfrc_applied && xpos && xmat && cvel && geom_xpos && geom_xmat) {
    updateSharedBuffers();
    return {
      time: data.time,
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
    time: data.time,
    qpos: Float64Array.from(data.qpos),
    qvel: Float64Array.from(data.qvel),
    ctrl: Float64Array.from(data.ctrl),
    xfrc_applied: Float64Array.from(data.xfrc_applied),
    qfrc_applied: Float64Array.from(data.qfrc_applied),
    xpos: Float64Array.from(data.xpos),
    xmat: Float64Array.from(data.xmat),
    cvel: Float64Array.from(data.cvel),
    geom_xpos: Float64Array.from(data.geom_xpos),
    geom_xmat: Float64Array.from(data.geom_xmat),
  };
};


const post = (msg: any, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer as any);

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

      const aeroDiagnostics: Record<string, any> = {};
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
    } catch (e: any) {
      const msg = String(e?.message || e);
      const fatal = /Aborted|enlarge memory|abort|bad_alloc/i.test(msg);
      post({ type: 'ERROR', message: msg, fatal, lastState: fatal ? { qpos: Array.from(data.qpos), qvel: Array.from(data.qvel), time: data.time } : undefined });
      isPlaying = false;
      return;
    }
  }

  if (stepsNeeded > 0) {
    const snap = snapshot();
    if (isSharedSupported) {
      post({ type: 'FRAME', time: snap.time, isShared: true });
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

let workerTimerId: any = null;
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
  newSceneGraph: { nodes: SceneNode[] },
  preserveState: boolean,
  seedState?: { qpos: number[]; qvel: number[]; ctrl?: number[]; time: number },
) => {
  const oldModel = model;
  const oldData = data;

  if (!mujoco) throw new Error('MuJoCo module not loaded yet');

  if (oldModel) { try { oldModel.free(); } catch (_) {} }
  if (oldData) { try { oldData.free(); } catch (_) {} }

  const newModel = mujoco.MjModel.from_xml_string(xml);
  const newData = new mujoco.MjData(newModel);

  model = newModel;
  data = newData;
  sceneGraph = newSceneGraph;
  rebuildIdCaches();
  scriptCache && Object.keys(scriptCache).forEach(k => delete scriptCache[k]);

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
    const actuators: any[] = [];
    const traverse = (nodes: SceneNode[]) => {
      if (!nodes) return;
      for (const node of nodes) {
        node.joints?.forEach((j: any) => { if (j.actuator) actuators.push(j); });
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
        node.joints?.forEach((j: any) => { if (j.initialVelocity) initVelJoints.push({ name: j.name, vel: j.initialVelocity }); });
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
const runHeadless = (xml: string, headlessSceneGraph: { nodes: SceneNode[] }, ticks: number) => {
  if (!mujoco) throw new Error('MuJoCo module not loaded yet');

  const savedModel = model, savedData = data, savedSceneGraph = sceneGraph;
  const savedBodyIdCache = bodyIdCache, savedJointIdCache = jointIdCache;
  const savedGeomIdCache = geomIdCache, savedGeomNameCache = geomNameCache, savedActuatorIdCache = actuatorIdCache;

  const warnings: string[] = [];
  mujoco.on_warning = (m: string) => warnings.push(m);

  let headlessModel: any = null;
  let headlessData: any = null;
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
        node.joints?.forEach((j: any) => { if (j.initialVelocity) initVelJoints.push({ name: j.name, vel: j.initialVelocity }); });
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

    const trajectory: any[] = [];
    for (let i = 0; i < ticks; i++) {
      data.xfrc_applied.fill(0);
      data.qfrc_applied.fill(0);

      const aeroDiagnostics: Record<string, any> = {};
      executeScripts(sceneGraph.nodes, aeroDiagnostics);
      applyFreeJointDamping(sceneGraph.nodes);

      mujoco.mj_step(model, data);

      if (isNaN(data.qpos[0])) break;

      trajectory.push(buildHistoryEntry(aeroDiagnostics));
    }

    return { ok: true, ticksSimulated: trajectory.length, trajectory, warnings };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e), warnings };
  } finally {
    if (headlessModel) { try { headlessModel.delete(); } catch (_) {} }
    if (headlessData) { try { headlessData.delete(); } catch (_) {} }
    model = savedModel; data = savedData; sceneGraph = savedSceneGraph;
    bodyIdCache = savedBodyIdCache; jointIdCache = savedJointIdCache;
    geomIdCache = savedGeomIdCache; geomNameCache = savedGeomNameCache; actuatorIdCache = savedActuatorIdCache;
  }
};

(self as unknown as Worker).onmessage = async (evt: MessageEvent) => {
  const msg = evt.data;
  try {
    switch (msg.type) {
      case 'BUILD': {
        if (!mujoco) mujoco = await load_mujoco();
        try {
          const result = doBuild(msg.xml, msg.sceneGraph, msg.preserveState, msg.seedState);
          post({ type: 'BUILT', id: msg.id, ok: true, ...result });
          if (isPlaying && isSharedSupported) {
            startWorkerLoop();
          }
        } catch (e: any) {
          const errMsg = String(e?.message || e);
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
            post({ type: 'FRAME', time: snap.time, isShared: true });
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
        if (!mujoco) mujoco = await load_mujoco();
        const result = runHeadless(msg.xml, msg.sceneGraph, msg.ticks);
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
  } catch (e: any) {
    post({ type: 'ERROR', message: String(e?.message || e), fatal: false });
  }
};
