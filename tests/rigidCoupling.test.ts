// Coupled joints keep their ratio under load. At MuJoCo's default impedance a
// joint coupling gave like a spring whose rate scaled with the lighter joint,
// and the load slipped it for good: a 20 N·m load on a 256:1 train left the
// output 4.2 rad (240°) off its ratio, and a leadscrew's nut sat 7 mm off its
// screw under a 0.35 kg carriage.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import { buildLeadscrewDrive } from '../src/utils/mechanismParts';
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

const jointOf = (m: any, name: string) => mj.mj_name2id(m, mj.mjtObj.mjOBJ_JOINT.value, name);

describe('joint couplings hold their ratio under load', () => {
  it('a 20 N·m load on a 256:1 train deflects it by milliradians, and it springs back', () => {
    const nodes = [0, 1, 2, 3, 4].map(arbor);
    nodes[0].joints[0].actuator = { type: 'velocity', kv: 1, ctrlValue: 25.6 };
    nodes[4].joints[0].actuator = { type: 'motor', ctrlValue: 0 };
    const m = mj.MjModel.from_xml_string(compileToMJCF({ nodes }, -9.81, 1, 0, 0, 0));
    const d = new mj.MjData(m);
    try {
      const q = (i: number) => d.qpos[m.jnt_qposadr[jointOf(m, `a${i}_hinge`)]];
      const outputError = () => q(4) - q(0) * 0.25 ** 4;
      d.ctrl[0] = 25.6;
      d.ctrl[1] = -20;
      for (let i = 0; i < 2000; i++) mj.mj_step(m, d);
      const loaded = Math.abs(outputError());
      // Was 4.16 rad.
      expect(loaded).toBeLessThan(0.02);
      expect(loaded).toBeGreaterThan(0);
      d.ctrl[1] = 0;
      for (let i = 0; i < 500; i++) mj.mj_step(m, d);
      expect(Math.abs(outputError())).toBeLessThan(1e-4);
    } finally {
      d.delete(); m.delete();
    }
  });

  it("a vertical leadscrew holds a 0.35 kg carriage on its thread", () => {
    const ls = buildLeadscrewDrive({ lengthMm: 200, leadMm: 8, actuateScrew: false });
    ls.nutNode.children.push({
      id: 'carriage', name: 'carriage', type: 'body', pos: [0.03, 0, 0], children: [], joints: [],
      geoms: [{ name: 'carriage_g', type: 'box', size: [0.02, 0.01, 0.005], mass: 0.35, contype: 0, conaffinity: 0 }],
    });
    // Held still by its motor: a stiff unlimited servo at zero speed.
    ls.leadscrewNode.joints[0].actuator = { type: 'velocity', kv: 5, ctrlValue: 0 };
    const m = mj.MjModel.from_xml_string(compileToMJCF({ nodes: ls.nodes }, -9.81, 1, 0, 0, 0));
    const d = new mj.MjData(m);
    try {
      for (let i = 0; i < 2000; i++) mj.mj_step(m, d);
      const nut = d.qpos[m.jnt_qposadr[jointOf(m, `${ls.nutNode.id}_slide`)]];
      const screw = d.qpos[m.jnt_qposadr[jointOf(m, `${ls.leadscrewNode.id}_hinge`)]];
      // Was about 7 mm.
      expect(Math.abs(nut - screw * ls.coupleRatio) * 1000).toBeLessThan(0.01);
    } finally {
      d.delete(); m.delete();
    }
  });
});
