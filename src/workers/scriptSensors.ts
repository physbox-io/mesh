// Reading the model for telemetry and for the scripts' sensors: joint state of
// every type, actuator effort, raycasts and contacts.
//
// Plain functions over a MuJoCo module, model and data, so they run against
// real MuJoCo in Vitest (tests/scriptSensors.test.ts) — physicsWorker.ts
// itself cannot be imported outside a Worker realm. Store-free.
//
// Memory: the numeric `data.*` / `model.*` arrays are views over the wasm heap
// and need no freeing, but `data.contact` is NOT: every read copies the whole
// contact array into a fresh std::vector and returns a handle that must be
// delete()d, as must each contact taken from it. Read it once, delete it once.
// The same goes for the DoubleBuffer/IntBuffer out-parameters made here.

import type load_mujoco from '@mujoco/mujoco';
import type { JointHistory } from './physicsWorkerProtocol';
import { clutchDriverJointName } from '../utils/motorClutch';

type Mujoco = Awaited<ReturnType<typeof load_mujoco>>;
type MjModel = InstanceType<Mujoco['MjModel']>;
type MjData = InstanceType<Mujoco['MjData']>;

/** MuJoCo's joint types: mjJNT_FREE, BALL, SLIDE, HINGE. */
export const JNT_FREE = 0;
export const JNT_BALL = 1;

/** One joint the scene names, with where its state lives in the model. */
export interface JointInfo {
  name: string;
  id: number;
  type: number;
  qposadr: number;
  dofadr: number;
  /** The scene node (body) the joint belongs to. */
  body: string;
  /** Actuators driving this joint (transmission = joint). */
  actuators: number[];
  /**
   * A torque-limited velocity motor's hidden driver (utils/motorClutch.ts):
   * the actuator sits on the driver's joint, and the user's joint feels it
   * only through the slip clutch.
   */
  drive?: { dofadr: number; actuators: number[] };
}

/**
 * The clutch driver of a joint, when the compiler made one: its joint is
 * named by clutchDriverJointName and carries the actuator.
 */
export const clutchDrive = (
  mj: Mujoco, model: MjModel, jointName: string, byJoint: Map<number, number[]>,
): JointInfo['drive'] => {
  const id = mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, clutchDriverJointName(jointName));
  if (id < 0) return undefined;
  return { dofadr: model.jnt_dofadr[id], actuators: byJoint.get(id) ?? [] };
};

/** Actuator ids by the joint they drive, for actuators whose transmission is a joint. */
export const actuatorsByJoint = (mj: Mujoco, model: MjModel): Map<number, number[]> => {
  const out = new Map<number, number[]>();
  const nu = model.nu;
  if (nu === 0) return out;
  const trntype = model.actuator_trntype;
  const trnid = model.actuator_trnid;
  const jointTrn = mj.mjtTrn.mjTRN_JOINT.value;
  for (let a = 0; a < nu; a++) {
    if (trntype[a] !== jointTrn) continue;
    const j = trnid[a * 2];
    out.set(j, [...(out.get(j) ?? []), a]);
  }
  return out;
};

/** The views a frame reads every joint from, taken once per frame. */
export interface JointViews {
  qpos: ArrayLike<number>;
  qvel: ArrayLike<number>;
  qfrcApplied: ArrayLike<number>;
  qfrcActuator: ArrayLike<number>;
  qfrcConstraint: ArrayLike<number>;
  ctrl: ArrayLike<number>;
}

export const jointViews = (data: MjData): JointViews => ({
  qpos: data.qpos,
  qvel: data.qvel,
  qfrcApplied: data.qfrc_applied,
  qfrcActuator: data.qfrc_actuator,
  qfrcConstraint: data.qfrc_constraint,
  ctrl: data.ctrl,
});

const slice = (a: ArrayLike<number>, from: number, n: number): number[] => {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = a[from + i];
  return out;
};

/**
 * A joint's state for telemetry.
 *
 * Hinge and slide: numbers. Free: pos [x, y, z, qw, qx, qy, qz] and vel
 * [vx, vy, vz, wx, wy, wz] (linear in the world frame, angular in the body's,
 * as MuJoCo stores them). Ball: pos is the quaternion [qw, qx, qy, qz] and vel
 * the body-frame angular velocity. Reading only qpos[adr] used to report a
 * free body's x as its "position". Joints with an actuator add `ctrl` (the
 * first actuator's control) and `actuatorForce` (the actuators' generalised
 * force on the joint, qfrc_actuator — the effort a setActuatorControl puts in,
 * which qfrc_applied never shows).
 *
 * A torque-limited velocity motor is a slip clutch to a hidden driver, which
 * carries the actuator. Its joint reports the driver's `ctrl` and
 * `actuatorForce` (the motor's effort), and `clutchTorque`, what the clutch
 * puts on the joint: the motor's effort while it holds, the limit while it
 * slips. Read off the driver's dof, which nothing else acts on, as the
 * negated constraint force there (the clutch tendon is joint − driver).
 */
export const readJoint = (j: JointInfo, v: JointViews): JointHistory => {
  let out: JointHistory;
  if (j.type === JNT_FREE) {
    out = { body: j.body, pos: slice(v.qpos, j.qposadr, 7), vel: slice(v.qvel, j.dofadr, 6), qfrc_applied: slice(v.qfrcApplied, j.dofadr, 6) };
  } else if (j.type === JNT_BALL) {
    out = { body: j.body, pos: slice(v.qpos, j.qposadr, 4), vel: slice(v.qvel, j.dofadr, 3), qfrc_applied: slice(v.qfrcApplied, j.dofadr, 3) };
  } else {
    out = { body: j.body, pos: v.qpos[j.qposadr], vel: v.qvel[j.dofadr], qfrc_applied: v.qfrcApplied[j.dofadr] };
    if (j.drive) {
      if (j.drive.actuators.length) out.ctrl = v.ctrl[j.drive.actuators[0]];
      out.actuatorForce = v.qfrcActuator[j.drive.dofadr];
      out.clutchTorque = -v.qfrcConstraint[j.drive.dofadr];
    } else if (j.actuators.length) {
      out.ctrl = v.ctrl[j.actuators[0]];
      out.actuatorForce = v.qfrcActuator[j.dofadr];
    }
  }
  return out;
};

// ---- Sensors for scripts ---------------------------------------------------

export interface RayHit {
  /** Distance from the origin to the hit, m. */
  dist: number;
  /** World point hit. */
  point: [number, number, number];
  /** Geom hit, by name. */
  geom: string;
  /** Body (scene node id, or 'world') the geom belongs to. */
  body: string;
}

/** Name lookups the sensors report through. */
export interface SensorNames {
  geomName: (g: number) => string;
  /** Scene node id of a MuJoCo body, or 'world' for body 0. */
  bodyNode: (b: number) => string;
}

/** Every geom group, so nothing visible is skipped. */
const ALL_GROUPS = [1, 1, 1, 1, 1, 1];

/**
 * Casts a ray from `origin` along `dir` (any length) and returns the first
 * geom it meets within `maxDist`, or null. `excludeBody` (a MuJoCo body id,
 * -1 for none) is skipped, so a body can look out from inside itself.
 * Static geoms are included; geoms drawn fully transparent (alpha 0) are not
 * (MuJoCo's own rule for rays).
 */
export const raycast = (
  mj: Mujoco, model: MjModel, data: MjData,
  origin: number[], dir: number[], maxDist: number, excludeBody: number, names: SensorNames,
): RayHit | null => {
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  if (!(len > 0)) throw new Error('raycast: dir must be a non-zero [x, y, z]');
  const unit = [dir[0] / len, dir[1] / len, dir[2] / len];
  const geomid = new mj.IntBuffer(1);
  const normal = new mj.DoubleBuffer(3);
  try {
    const dist = mj.mj_ray(model, data, [origin[0], origin[1], origin[2]], unit, ALL_GROUPS, true, excludeBody, geomid, normal);
    const g = geomid.GetView()[0];
    if (!(dist >= 0) || g < 0 || dist > maxDist) return null;
    return {
      dist,
      point: [origin[0] + unit[0] * dist, origin[1] + unit[1] * dist, origin[2] + unit[2] * dist],
      geom: names.geomName(g),
      body: names.bodyNode(model.geom_bodyid[g]),
    };
  } finally {
    geomid.delete();
    normal.delete();
  }
};

export interface ContactInfo {
  /** The body on the other side (scene node id, or 'world'). */
  otherBody: string;
  otherGeom: string;
  /** This body's geom in the contact. */
  geom: string;
  /** Signed distance, m: negative is penetration. */
  dist: number;
  /** Normal force, N (0 for a contact the solver did not engage). */
  force: number;
}

/**
 * The contacts touching MuJoCo body `bodyId` (or every contact, as seen from
 * geom1, when bodyId is -1), with the normal force on each.
 */
export const contactsOfBody = (mj: Mujoco, model: MjModel, data: MjData, bodyId: number, names: SensorNames): ContactInfo[] => {
  const out: ContactInfo[] = [];
  const vec = data.contact;
  const wrench = new mj.DoubleBuffer(6);
  try {
    const n = vec.size();
    const geomBody = model.geom_bodyid;
    for (let i = 0; i < n; i++) {
      const c = vec.get(i);
      if (!c) continue;
      try {
        const b1 = geomBody[c.geom1], b2 = geomBody[c.geom2];
        let mine: number, other: number;
        if (bodyId < 0 || b1 === bodyId) { mine = c.geom1; other = c.geom2; }
        else if (b2 === bodyId) { mine = c.geom2; other = c.geom1; }
        else continue;
        let force = 0;
        if (c.efc_address >= 0) {
          mj.mj_contactForce(model, data, i, wrench);
          force = wrench.GetView()[0];
        }
        out.push({ otherBody: names.bodyNode(geomBody[other]), otherGeom: names.geomName(other), geom: names.geomName(mine), dist: c.dist, force });
      } finally {
        c.delete();
      }
    }
  } finally {
    vec.delete();
    wrench.delete();
  }
  return out;
};
