// Dry friction on a coupled joint reaches the motor through the ratio. On the
// light output of a 256:1 train it used to creep at whatever speed it was
// driven: 0.5, 10 and 100 N*m gave bit-identical runs, the motor never slowed.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import { estimateJointInertia, relocateCoupledFriction } from '../src/utils/coupledFriction';
import type { SceneNode } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

/** Arbor i of a straight 4-stage 4:1 train: a 32 mm wheel and an 8 mm pinion on one hinge. */
const arbor = (i: number): SceneNode => ({
  id: `gear_a${i}`, name: `gear_a${i}`, type: 'body', pos: [0.04 * i, 0, 0.05], children: [],
  joints: [{ name: `a${i}_hinge`, type: 'hinge', axis: [0, 0, 1], pos: [0, 0, 0], damping: 0.0001 }],
  geoms: [
    { name: `a${i}_wheel`, type: 'cylinder', size: [0.032, 0.002], pos: [0, 0, 0.004 * i], contype: 0, conaffinity: 0, density: 1240 },
    { name: `a${i}_pin`, type: 'cylinder', size: [0.008, 0.002], pos: [0, 0, 0.004 * i + 0.004], contype: 0, conaffinity: 0, density: 1240 },
  ],
  ...(i > 0 ? { coupleTargetId: `gear_a${i - 1}`, coupleRatio: -0.25 } : {}),
});

/** The train with a 0.05 N*m motor at 25.6 rad/s on a0 and `friction` N*m on the output; speeds after 2 s. */
const run = (friction: number) => {
  const nodes = [0, 1, 2, 3, 4].map(arbor);
  nodes[0].joints[0].actuator = { type: 'velocity', kv: 0.05, forceLimit: 0.05, ctrlValue: 25.6 };
  nodes[4].joints[0].frictionloss = friction;
  const m = mj.MjModel.from_xml_string(compileToMJCF({ nodes }, -9.81, 1, 0, 0, 0));
  const d = new mj.MjData(m);
  try {
    d.ctrl[0] = 25.6;
    for (let i = 0; i < 2000; i++) mj.mj_step(m, d);
    const v = (i: number) => d.qvel[m.jnt_dofadr[mj.mj_name2id(m, mj.mjtObj.mjOBJ_JOINT.value, `a${i}_hinge`)]];
    return { motor: v(0) as number, output: v(4) as number };
  } finally {
    d.delete(); m.delete();
  }
};

describe('friction on a coupled joint', () => {
  it('is emitted on the joint that carries the chain, scaled by the ratio', () => {
    const nodes = [0, 1, 2, 3, 4].map(arbor);
    nodes[4].joints[0].frictionloss = 100;
    const joints = new Map(nodes.map((n) => [n.joints[0].name, { node: n, joint: n.joints[0] }]));
    const edges = [1, 2, 3, 4].map((i) => ({ joint1: `a${i}_hinge`, joint2: `a${i - 1}_hinge`, ratio: -0.25 }));
    const moved = relocateCoupledFriction(edges, joints);
    expect(moved.get('a4_hinge')).toBe(0);
    expect(moved.get('a0_hinge')).toBeCloseTo(100 / 256, 9);
    // The 32 mm, 4 mm thick PLA wheel: about m*r^2/2 = 8.3e-6 kg*m^2.
    expect(estimateJointInertia(nodes[0], nodes[0].joints[0])).toBeGreaterThan(7e-6);
    expect(estimateJointInertia(nodes[0], nodes[0].joints[0])).toBeLessThan(1e-5);
  });

  it('stalls the motor when it is more than the motor can turn through the ratio', () => {
    // 100 N*m / 256 = 0.39 N*m at the motor, past its 0.05.
    const r = run(100);
    // Was 25.28 rad/s, with the output creeping at 0.0995.
    expect(Math.abs(r.motor)).toBeLessThan(0.01);
    expect(Math.abs(r.output)).toBeLessThan(1e-4);
  });

  it('runs at the ratio when the motor can carry it, and different friction runs differently', () => {
    // 10 N*m / 256 = 0.039 N*m: inside 0.05, so it turns, the output at 1/256.
    const light = run(0.5);
    const heavy = run(10);
    expect(light.motor).toBeGreaterThan(25);
    expect(heavy.motor).toBeGreaterThan(24);
    expect(heavy.output / heavy.motor).toBeCloseTo(1 / 256, 5);
    // Was bit-identical.
    expect(heavy.motor).toBeLessThan(light.motor - 0.1);
  });
});
