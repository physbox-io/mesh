// Torque-limited velocity motors, driven through a slip clutch.
//
// A velocity actuator's clamped force is stepped explicitly, and on a light
// joint a step of limit torque overshoots the band the servo works in: a 5 g
// gear at kv 2 went to -500 rad/s. That used to be cured with armature of
// 1.5*kv*dt on the joint (0.00165 kg*m^2 on a NEMA17, 240 times its rotor),
// which capped acceleration at a few hundred rad/s^2 and stored far too much
// energy for an end stop to absorb. Now the compiler drives the joint from a
// hidden driver through dry friction at the limit (utils/motorClutch.ts), and
// the joint keeps the inertia it really has.

import { describe, it, expect, beforeAll, vi } from 'vitest';

// The bridge module sizes its OpenSCAD pool from navigator at import.
vi.hoisted(() => { (globalThis as { navigator?: unknown }).navigator ??= { hardwareConcurrency: 2 }; });

import load_mujoco from '@mujoco/mujoco';
import { fillBodyDefaults } from '../src/hooks/useMCPBridge';
import { compileToMJCF } from '../src/utils/mjcf';
import { hardwarePartNode } from '../src/utils/hardwareParts';
import { buildLeadscrewDrive } from '../src/utils/mechanismParts';
import type { SceneNode } from '../src/types/scene';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

/** A 5 g bar on a hinge, driven at 1 rad/s with kv 2. */
const motoredBar = (forceLimit?: number): SceneNode => fillBodyDefaults({
  name: 'stand', static: true,
  geoms: [{ type: 'box', size: [0.01, 0.01, 0.01], pos: [0, 0, 0.01] }],
  children: [{
    name: 'bar', pos: [0, 0, 0.05],
    joints: [{ name: 'spin', type: 'hinge', axis: [0, 0, 1], actuator: { type: 'velocity', kv: 2, ctrlValue: 1, ...(forceLimit !== undefined ? { forceLimit } : {}) } }],
    geoms: [{ type: 'box', size: [0.02, 0.002, 0.002], mass: 0.005, contype: 0, conaffinity: 0 }],
  }],
} as never);

const open = (nodes: SceneNode[]) => {
  const m = mj.MjModel.from_xml_string(compileToMJCF({ nodes }, -9.81, 1, 0, 0, 0));
  const d = new mj.MjData(m);
  const joint = (name: string) => mj.mj_name2id(m, mj.mjtObj.mjOBJ_JOINT.value, name);
  const actuator = (name: string) => mj.mj_name2id(m, mj.mjtObj.mjOBJ_ACTUATOR.value, name);
  return {
    m, d,
    q: (name: string) => d.qpos[m.jnt_qposadr[joint(name)]] as number,
    v: (name: string) => d.qvel[m.jnt_dofadr[joint(name)]] as number,
    ctrl: (name: string, value: number) => { d.ctrl[actuator(name)] = value; },
    step: (n: number) => { for (let i = 0; i < n; i++) mj.mj_step(m, d); },
    done: () => { d.delete(); m.delete(); },
  };
};

describe('torque-limited velocity motors', () => {
  it('add no armature to the joint', () => {
    expect(motoredBar(0.01).children[0].joints[0].armature).toBeUndefined();
    const stepper = hardwarePartNode({ kind: 'stepper', size: 'NEMA17 48' }, 'st');
    // The datasheet rotor, 68 g*cm^2, is a disc on the shaft; the joint carries
    // no armature (it carried 0.00165, 240 times that).
    expect(stepper.children[0].joints[0].armature).toBeUndefined();
  });

  it('an unclamped motor holds a light part at its set speed', () => {
    const s = open([motoredBar()]);
    s.ctrl('spin_actuator', 1);
    s.step(2000);
    expect(Math.abs(s.v('spin') - 1)).toBeLessThan(0.05);
    s.done();
  });

  it('a clamped light part holds its set speed with no armature (was -500 rad/s bare)', () => {
    const s = open([motoredBar(0.01)]);
    s.ctrl('spin_actuator', 1);
    s.step(2000);
    expect(Math.abs(s.v('spin') - 1)).toBeLessThan(0.01);
    s.done();
  });

  it('a 0.05 N*m motor at kv 5 spins a 1e-5 kg*m^2 rotor up at its torque limit, not 3.5 s', () => {
    const rotor: SceneNode = {
      id: 'rotor', name: 'rotor', type: 'body', pos: [0, 0, 0.05], children: [],
      // A 20 mm disc of 0.05 kg: I = m*r^2/2 = 1e-5 kg*m^2.
      geoms: [{ name: 'rotor_g', type: 'cylinder', size: [0.02, 0.005], mass: 0.05, contype: 0, conaffinity: 0 }],
      joints: [{ name: 'spin', type: 'hinge', axis: [0, 0, 1], actuator: { type: 'velocity', kv: 5, forceLimit: 0.05, ctrlValue: 25 } }],
    };
    const s = open([rotor]);
    s.ctrl('spin_actuator', 25);
    let t = 0;
    while (s.v('spin') < 24.5 && t < 5000) { s.step(1); t++; }
    // At 0.05 N*m on 1e-5 kg*m^2 it takes I*w/T = 5 ms to reach 25 rad/s; the
    // floor armature of 0.0075 made it 3.75 s. It is never faster than its
    // torque allows.
    expect(t).toBeGreaterThanOrEqual(4);
    expect(t).toBeLessThan(15);
    s.step(1000);
    expect(Math.abs(s.v('spin') - 25)).toBeLessThan(0.01);
    s.done();
  });

  it('stalls at a leadscrew end stop: the stepper and screw stop with the nut', () => {
    // NEMA17 48 at -12.566 rad/s, 1:1 onto a T8x8 screw whose nut stops at -62.5 mm.
    const stepper = hardwarePartNode({ kind: 'stepper', size: 'NEMA17 48' }, 'st');
    stepper.joints = [];
    stepper.pos = [0, 0, 0.05];
    const ls = buildLeadscrewDrive({ lengthMm: 150, leadMm: 8, actuateScrew: false, origin: [0.1, 0, 0.1] });
    expect(ls.travelRangeMm[0]).toBeCloseTo(-62.5, 6);
    ls.leadscrewNode.coupleTargetId = 'st_shaft';
    ls.leadscrewNode.coupleRatio = 1;
    const s = open([stepper, ...ls.nodes]);
    const shaft = 'st_spin', screw = `${ls.leadscrewNode.id}_hinge`, nut = `${ls.nutNode.id}_slide`;
    s.ctrl('st_spin_actuator', -12.566);
    s.step(8000);
    // Before: the nut stopped but the screw and motor ran on at -12.5 rad/s,
    // about 150 rad past the stop. Now all three stop: the nut 0.31 mm into
    // its steel stop under the 432 N that 0.55 N*m puts through an 8 mm lead.
    expect(s.q(nut) * 1000).toBeGreaterThan(-63);
    expect(s.q(nut) * 1000).toBeLessThan(-62.5);
    // The thread carries those 432 N with 0.034 mm of give.
    expect(Math.abs(s.q(nut) - s.q(screw) * ls.coupleRatio) * 1000).toBeLessThan(0.05);
    expect(Math.abs(s.v(screw))).toBeLessThan(0.01);
    expect(Math.abs(s.v(shaft))).toBeLessThan(0.01);
    // Stalled, not slipping off the screw: the 1:1 coupling winds up 2 mrad.
    expect(Math.abs(s.q(screw) - s.q(shaft))).toBeLessThan(0.005);
    s.done();
  });
});
