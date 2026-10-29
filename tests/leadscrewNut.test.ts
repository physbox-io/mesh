// A leadscrew's nut travels; it does not turn. It used to be a child of the
// hinged screw, so a carriage fixed to it spun at the screw's 6.27 rad/s.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import { buildLeadscrewDrive } from '../src/utils/mechanismParts';
import type { SceneNode } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

describe('a leadscrew nut and what rides on it', () => {
  it('a carriage on the nut travels at lead/2π per radian and does not turn', () => {
    const ls = buildLeadscrewDrive({ lengthMm: 200, leadMm: 8 });
    const carriage: SceneNode = {
      id: 'carriage', name: 'carriage', type: 'body', pos: [0.03, 0, 0], children: [], joints: [],
      geoms: [{ name: 'carriage_g', type: 'box', size: [0.02, 0.01, 0.005], mass: 0.1, contype: 0, conaffinity: 0 }],
    };
    ls.nutNode.children.push(carriage);
    expect(ls.nodes).toHaveLength(1);
    expect(ls.nodes[0].children.map((c) => c.id)).toEqual([ls.leadscrewNode.id, ls.nutNode.id]);
    expect(ls.leadscrewNode.children).not.toContain(ls.nutNode);

    const m = mj.MjModel.from_xml_string(compileToMJCF({ nodes: ls.nodes }, -9.81, 1, 0, 0, 0));
    const d = new mj.MjData(m);
    try {
      d.ctrl[0] = 6.27;
      const body = mj.mj_name2id(m, mj.mjtObj.mjOBJ_BODY.value, 'carriage');
      const nut = mj.mj_name2id(m, mj.mjtObj.mjOBJ_JOINT.value, `${ls.nutNode.id}_slide`);
      const screw = mj.mj_name2id(m, mj.mjtObj.mjOBJ_JOINT.value, `${ls.leadscrewNode.id}_hinge`);
      for (let i = 0; i < 1000; i++) mj.mj_step(m, d);
      // cvel is [angular; linear] in the world frame.
      const spin = Math.hypot(d.cvel[body * 6], d.cvel[body * 6 + 1], d.cvel[body * 6 + 2]);
      const screwSpeed = d.qvel[m.jnt_dofadr[screw]];
      const nutSpeed = d.qvel[m.jnt_dofadr[nut]];
      expect(screwSpeed).toBeGreaterThan(6);
      // Was 6.27 rad/s, the screw's own speed.
      expect(spin).toBeLessThan(1e-6);
      expect(nutSpeed / screwSpeed).toBeCloseTo(0.008 / (2 * Math.PI), 6);
    } finally {
      d.delete(); m.delete();
    }
  });
});
