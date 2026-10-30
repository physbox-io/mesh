// Carrying a running simulation across a rebuild that changes its degrees of
// freedom — a body shattering into a dozen shards.
//
// Out of physicsWorker.ts so the live rebuild, the headless run's mid-run
// rebuild and the tests (which cannot load the worker) carry state the same
// way. Pure: it reads the arrays and models it is handed.

import type load_mujoco from '@mujoco/mujoco';
import type { SceneNode } from '../types/scene';
import { rebaseShard } from '../utils/runtimeShatter';

type Mujoco = Awaited<ReturnType<typeof load_mujoco>>;
type MjModel = InstanceType<Mujoco['MjModel']>;
type MjData = InstanceType<Mujoco['MjData']>;

/** How many qpos/qvel slots each joint type occupies: free, ball, slide, hinge. */
export const JOINT_NQ = [7, 4, 1, 1];
export const JOINT_NV = [6, 3, 1, 1];

export interface CarriedState {
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
export function captureState(
  mdl: MjModel | null,
  dat: MjData | null,
  jointIdOf: Record<string, number>,
  actuatorIdOf: Record<string, number>,
): CarriedState | null {
  if (!mdl || !dat) return null;
  try {
    const joints: CarriedState['joints'] = {};
    for (const name in jointIdOf) {
      const id = jointIdOf[name];
      joints[name] = { type: mdl.jnt_type[id], qposadr: mdl.jnt_qposadr[id], dofadr: mdl.jnt_dofadr[id] };
    }
    const actuators: Record<string, number> = {};
    for (const name in actuatorIdOf) {
      const id = actuatorIdOf[name];
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
}

/**
 * Every joint that is in both models, put where it was. Returns the names placed.
 *
 * Matching by joint NAME survives a rebuild whose addresses all moved, which a
 * straight array copy does not.
 */
export function copyJointsByName(
  carried: CarriedState,
  newModel: MjModel,
  newData: MjData,
  jointIdOf: Record<string, number>,
): Set<string> {
  const placed = new Set<string>();
  for (const name in jointIdOf) {
    const from = carried.joints[name];
    if (!from) continue;
    const id = jointIdOf[name];
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
  return placed;
}

/**
 * Place what did NOT come across: a shard where its body is now, anything
 * else new with its opening velocity. Returns whether anything was written,
 * so the caller knows to run mj_forward again.
 */
export function seedNewBodies(
  carried: CarriedState,
  newModel: MjModel,
  newData: MjData,
  nodes: SceneNode[],
  jointIdOf: Record<string, number>,
  placed: Set<string>,
): boolean {
  let seededNew = false;
  const seedNew = (list: SceneNode[]) => {
    if (!list) return;
    for (const node of list) {
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
        const id = jointIdOf[own.name];
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
        const id = jointIdOf[j.name];
        if (id === undefined) return;
        const dofAdr = newModel.jnt_dofadr[id];
        for (let i = 0; i < j.initialVelocity!.length; i++) newData.qvel[dofAdr + i] = j.initialVelocity![i];
        seededNew = true;
      });
      seedNew(node.children);
    }
  };
  seedNew(nodes);
  return seededNew;
}
