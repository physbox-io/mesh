// A torque-limited velocity motor's telemetry. The compiler moves its actuator
// onto a hidden `<joint>__drive` joint (utils/motorClutch.ts), so reading only
// the joint's own actuators dropped `ctrl` and `actuatorForce` the moment a
// forceLimit was set. readJoint now reads the driver, and adds clutchTorque.

import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.hoisted(() => { (globalThis as { navigator?: unknown }).navigator ??= { hardwareConcurrency: 2 }; });

import load_mujoco from '@mujoco/mujoco';
import { fillBodyDefaults } from '../src/hooks/useMCPBridge';
import { compileToMJCF } from '../src/utils/mjcf';
import { actuatorsByJoint, clutchDrive, jointViews, readJoint, type JointInfo } from '../src/workers/scriptSensors';
import type { SceneNode } from '../src/types/scene';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

/** A 0.1 kg weight 50 mm out on an arm, held level by a motor asked for 0 rad/s: m·g·r = 0.04905 N·m. */
const MGR = 0.1 * 9.81 * 0.05;
const arm = (forceLimit?: number): SceneNode => fillBodyDefaults({
  name: 'stand', static: true,
  geoms: [{ type: 'box', size: [0.01, 0.01, 0.01], pos: [0, 0, 0.01] }],
  children: [{
    name: 'arm', pos: [0, 0, 0.1],
    joints: [{ name: 'lift', type: 'hinge', axis: [0, 1, 0], actuator: { type: 'velocity', kv: 5, ctrlValue: 0, ...(forceLimit !== undefined ? { forceLimit } : {}) } }],
    geoms: [{ type: 'sphere', size: [0.005], pos: [0.05, 0, 0], mass: 0.1, contype: 0, conaffinity: 0 }],
  }],
} as never);

const settle = (node: SceneNode, steps = 3000, ctrl = 0) => {
  const m = mj.MjModel.from_xml_string(compileToMJCF({ nodes: [node] }, -9.81, 1, 0, 0, 0));
  const d = new mj.MjData(m);
  try {
    const id = mj.mj_name2id(m, mj.mjtObj.mjOBJ_JOINT.value, 'lift');
    const byJoint = actuatorsByJoint(mj, m);
    const drive = clutchDrive(mj, m, 'lift', byJoint);
    const info: JointInfo = {
      name: 'lift', id, type: m.jnt_type[id], qposadr: m.jnt_qposadr[id], dofadr: m.jnt_dofadr[id], body: 'arm',
      actuators: byJoint.get(id) ?? [], ...(drive ? { drive } : {}),
    };
    d.ctrl[mj.mj_name2id(m, mj.mjtObj.mjOBJ_ACTUATOR.value, 'lift_actuator')] = ctrl;
    for (let i = 0; i < steps; i++) mj.mj_step(m, d);
    return { joint: readJoint(info, jointViews(d)), drive };
  } finally { d.delete(); m.delete(); }
};

describe('clutched motor telemetry', () => {
  it('an unlimited motor reports its effort as before', () => {
    const { joint, drive } = settle(arm());
    expect(drive).toBeUndefined();
    expect(joint.ctrl).toBe(0);
    expect(Math.abs(joint.actuatorForce!)).toBeCloseTo(MGR, 2);
  });

  it('a torque-limited one keeps ctrl and actuatorForce, and adds the clutch torque', () => {
    const { joint, drive } = settle(arm(0.2));
    expect(drive).toBeDefined();
    expect(joint.ctrl).toBe(0);
    expect(Math.abs(joint.actuatorForce!)).toBeCloseTo(MGR, 2);
    // Holding: the clutch passes the whole effort on, and it holds the weight up.
    expect(Math.abs(joint.clutchTorque!)).toBeCloseTo(MGR, 2);
    expect(Math.sign(joint.clutchTorque!)).toBe(Math.sign(joint.actuatorForce!));
  });

  it('a slipping clutch reports its limit', () => {
    // Asked for 100 rad/s at 0.02 N·m: still far short of it, and slipping, after 0.2 s.
    const { joint } = settle(arm(0.02), 200, 100);
    expect(joint.ctrl).toBe(100);
    expect(Math.abs(joint.clutchTorque!)).toBeCloseTo(0.02, 3);
  });
});
