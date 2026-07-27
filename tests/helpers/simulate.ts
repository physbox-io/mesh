// A headless MuJoCo harness for asserting what a preset actually DOES.
//
// The presets are the app's documentation-by-example: "stacked cubes fall and
// settle", "the driven gear turns its neighbour", "the cartpole stays upright".
// Those claims were only ever checked by loading the app and watching, which is
// how a bulk rescale silently left several of them doing nothing at all.
//
// This reproduces the two things src/workers/physicsWorker.ts does beyond
// stepping MuJoCo, because without them a preset is inert:
//   - actuator ctrl seeded from each joint's actuator.ctrlValue
//   - qvel seeded from each joint's initialVelocity
// plus a faithful subset of the script API, for the presets driven by one.
//
// NOT reproduced: aerodynamics (isAerodynamic bodies), mouse drag forces, and
// the gear-meshing proximity recompute that runs per-frame in the app. Presets
// relying on those are marked as such where they're tested.

import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../../src/utils/mjcf';
import type { SceneGraph, SceneNode } from '../../src/types/scene';

type Mujoco = Awaited<ReturnType<typeof load_mujoco>>;
let mujocoPromise: Promise<Mujoco> | null = null;
const getMujoco = () => (mujocoPromise ??= load_mujoco());

export interface SimOptions {
  gravityZ?: number;
  floorFriction?: number;
  windX?: number;
  windY?: number;
  density?: number;
  floorBounce?: number;
  /** Run each scripted body's control script every step (default true). */
  runScripts?: boolean;
}

export interface Sim {
  step(n?: number): void;
  /**
   * Frees the MuJoCo model and data. Call it when a suite is done with a sim
   * (afterAll): MuJoCo's wasm heap only ever grows and has a hard 2GB ceiling —
   * a few hundred live models exhaust it outright, and growing the heap
   * reallocates it, which can leave a previously handed-out typed-array view
   * pointing at memory that now belongs to a different model.
   */
  dispose(): void;
  /** Steps for `seconds` of simulated time at the model's timestep. */
  run(seconds: number): void;
  time(): number;
  bodyPos(name: string): [number, number, number];
  jointPos(name: string): number;
  jointVel(name: string): number;
  /** Peak absolute value of a joint's position over a run — for stability checks. */
  track<T>(fn: () => T): T;
  xml: string;
  model: any;
  data: any;
}

const walk = (nodes: SceneNode[], fn: (n: SceneNode) => void) => {
  for (const n of nodes || []) { fn(n); walk(n.children || [], fn); }
};

export async function simulate(scene: SceneGraph, opts: SimOptions = {}): Promise<Sim> {
  const mujoco = await getMujoco();
  const xml = compileToMJCF(
    scene,
    opts.gravityZ ?? -9.81,
    opts.floorFriction ?? 1,
    opts.windX ?? 0,
    opts.windY ?? 0,
    opts.density ?? 0,
    opts.floorBounce ?? 0,
  );
  const model = mujoco.MjModel.from_xml_string(xml);
  const data = new mujoco.MjData(model);

  const bodyId = (n: string) => mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, n);
  const jointId = (n: string) => mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT.value, n);

  // --- Seed actuator ctrl, exactly as physicsWorker's build does: actuators in
  // scene-graph traversal order, matched positionally to MuJoCo's ctrl indices.
  const actuatorJoints: any[] = [];
  walk(scene.nodes, n => n.joints?.forEach((j: any) => { if (j.actuator) actuatorJoints.push(j); }));
  actuatorJoints.forEach((j, idx) => {
    if (j.actuator?.ctrlValue !== undefined && idx < model.nu) data.ctrl[idx] = j.actuator.ctrlValue;
  });
  mujoco.mj_forward(model, data);

  // --- Seed initial joint velocities.
  let seeded = false;
  walk(scene.nodes, n => n.joints?.forEach((j: any) => {
    if (!j.initialVelocity) return;
    const jid = jointId(j.name);
    if (jid === -1) return;
    const dof = model.jnt_dofadr[jid];
    for (let i = 0; i < j.initialVelocity.length; i++) data.qvel[dof + i] = j.initialVelocity[i];
    seeded = true;
  }));
  if (seeded) mujoco.mj_forward(model, data);

  // --- Script API: the subset the presets actually use, mirroring the worker.
  const scripted: Array<{ node: SceneNode; fn: (api: any) => void }> = [];
  if (opts.runScripts !== false) {
    walk(scene.nodes, n => {
      if (!n.script || !n.script.trim()) return;
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      scripted.push({ node: n, fn: new Function('api', n.script) as (api: any) => void });
    });
  }

  const apiFor = (node: SceneNode) => ({
    id: node.id,
    name: node.name,
    getTime: () => data.time,
    getWind: () => [opts.windX ?? 0, opts.windY ?? 0],
    isKeyPressed: () => false,
    log: () => {},
    getJointPosition: (name: string) => {
      const jid = jointId(name);
      return jid === -1 ? 0 : data.qpos[model.jnt_qposadr[jid]];
    },
    getJointVelocity: (name: string) => {
      const jid = jointId(name);
      return jid === -1 ? 0 : data.qvel[model.jnt_dofadr[jid]];
    },
    applyJointForce: (name: string, force: number) => {
      const jid = jointId(name);
      if (jid !== -1) data.qfrc_applied[model.jnt_dofadr[jid]] += force;
    },
    getOrientation: (bodyName = node.id) => {
      const bid = bodyId(bodyName) === -1 ? bodyId(node.name) : bodyId(bodyName);
      if (bid === -1) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
      return Array.from({ length: 9 }, (_, i) => data.xmat[bid * 9 + i]);
    },
    getAngularVelocity: (bodyName = node.id) => {
      const bid = bodyId(bodyName) === -1 ? bodyId(node.name) : bodyId(bodyName);
      if (bid === -1) return [0, 0, 0];
      return [data.cvel[bid * 6 + 0], data.cvel[bid * 6 + 1], data.cvel[bid * 6 + 2]];
    },
    setAngularVelocity: (angvel: number[], bodyName = node.id) => {
      const target = bodyName === node.id ? node : null;
      const joint = target?.joints?.[0];
      if (!joint) return;
      const jid = jointId(joint.name);
      if (jid === -1) return;
      const dof = model.jnt_dofadr[jid];
      // A free joint's rotational DOFs follow its three linear ones.
      const off = joint.type === 'free' ? 3 : 0;
      for (let i = 0; i < Math.min(3, angvel.length); i++) data.qvel[dof + off + i] = angvel[i];
    },
    applyTorque: (torque: number[], bodyName = node.id) => {
      let bid = bodyId(bodyName);
      if (bid === -1) bid = bodyId(node.name);
      if (bid === -1) return;
      data.xfrc_applied[bid * 6 + 3] += torque[0];
      data.xfrc_applied[bid * 6 + 4] += torque[1];
      data.xfrc_applied[bid * 6 + 5] += torque[2];
    },
    applyForce: (force: number[], bodyName = node.id) => {
      let bid = bodyId(bodyName);
      if (bid === -1) bid = bodyId(node.name);
      if (bid === -1) return;
      data.xfrc_applied[bid * 6 + 0] += force[0];
      data.xfrc_applied[bid * 6 + 1] += force[1];
      data.xfrc_applied[bid * 6 + 2] += force[2];
    },
  });

  const step = (n = 1) => {
    for (let i = 0; i < n; i++) {
      if (scripted.length > 0) {
        // Applied forces do not persist across steps in MuJoCo, so the scripts
        // re-apply them every step just as the worker's loop does.
        for (let k = 0; k < model.nv; k++) data.qfrc_applied[k] = 0;
        for (let k = 0; k < model.nbody * 6; k++) data.xfrc_applied[k] = 0;
        for (const s of scripted) {
          try { s.fn(apiFor(s.node)); } catch { /* a throwing script must not kill the run */ }
        }
      }
      mujoco.mj_step(model, data);
    }
  };

  // Read once: every property access on an embind handle crosses into wasm.
  const timestep = model.opt.timestep;
  let disposed = false;

  return {
    step,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      data.delete();
      model.delete();
    },
    run: (seconds: number) => step(Math.round(seconds / timestep)),
    time: () => data.time,
    bodyPos: (name: string) => {
      const bid = bodyId(name);
      if (bid === -1) throw new Error(`no body "${name}" in the compiled model`);
      return [data.xpos[bid * 3], data.xpos[bid * 3 + 1], data.xpos[bid * 3 + 2]];
    },
    jointPos: (name: string) => {
      const jid = jointId(name);
      if (jid === -1) throw new Error(`no joint "${name}" in the compiled model`);
      return data.qpos[model.jnt_qposadr[jid]];
    },
    jointVel: (name: string) => {
      const jid = jointId(name);
      if (jid === -1) throw new Error(`no joint "${name}" in the compiled model`);
      return data.qvel[model.jnt_dofadr[jid]];
    },
    track: fn => fn(),
    xml,
    model,
    data,
  };
}
