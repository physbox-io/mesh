// Mechanism builder links collide with the floor and with other bodies, and
// not with the parts they are linked to. Every collider used to be contype 0,
// so a four-bar walker could not put a foot on the ground and a part dropped
// on a gear fell straight through it.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import { buildFourBarLinkage, buildLeadscrewDrive, buildMeshingGearPair } from '../src/utils/mechanismParts';
import type { SceneNode } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

const crate = (pos: [number, number, number]): SceneNode => ({
  id: 'crate', name: 'crate', type: 'body', pos, children: [],
  joints: [{ name: 'crate_free', type: 'free' }],
  geoms: [{ name: 'crate_g', type: 'box', size: [0.004, 0.004, 0.004], mass: 0.02 }],
});

/** Runs the scene; the crate's final height, and whether any two of the mechanism's own bodies ever touched. */
const run = (nodes: SceneNode[], ctrl: number, steps = 2000) => {
  const m = mj.MjModel.from_xml_string(compileToMJCF({ nodes }, -9.81, 1, 0, 0, 0));
  const d = new mj.MjData(m);
  try {
    const crate = mj.mj_name2id(m, mj.mjtObj.mjOBJ_BODY.value, 'crate');
    const floor = mj.mj_name2id(m, mj.mjtObj.mjOBJ_GEOM.value, 'floor');
    let selfContacts = 0;
    if (m.nu) d.ctrl[0] = ctrl;
    for (let i = 0; i < steps; i++) {
      mj.mj_step(m, d);
      const contacts = d.contact;
      for (let c = 0; c < d.ncon; c++) {
        const con = contacts.get(c);
        const b1 = m.geom_bodyid[con.geom1], b2 = m.geom_bodyid[con.geom2];
        if (b1 !== crate && b2 !== crate && con.geom1 !== floor && con.geom2 !== floor) selfContacts++;
      }
      contacts.delete();
    }
    return { crateZ: crate >= 0 ? d.xpos[crate * 3 + 2] : NaN, selfContacts, q0: d.qpos[0] };
  } finally {
    d.delete(); m.delete();
  }
};

describe('mechanism parts collide', () => {
  it('a part dropped on a four-bar\'s ground link lands on it, and the linkage never rubs itself', () => {
    const fb = buildFourBarLinkage({ groundMm: 100, crankMm: 30, couplerMm: 90, rockerMm: 80 }, { origin: [0, 0, 0.05] });
    const ground = fb.groundNode;
    const at: [number, number, number] = [ground.pos[0] + 0.05, ground.pos[1], ground.pos[2] - 0.004 + 0.012];
    const speed = fb.crankNode.joints[0].actuator!.ctrlValue!;
    const r = run([...fb.nodes, crate(at)], speed);
    // Was through it, onto the floor at 4 mm.
    expect(r.crateZ).toBeGreaterThan(0.05);
    expect(r.selfContacts).toBe(0);
    expect(Math.abs(r.q0)).toBeGreaterThan(2);
  });

  it('a gear pair turns without its colliders touching, and holds up what is dropped on it', () => {
    const pair = buildMeshingGearPair({ teeth: 18, moduleMm: 1.5 }, { teeth: 36, moduleMm: 1.5 });
    const g = pair.drivenNode;
    const r = run([...pair.nodes, crate([g.pos[0], g.pos[1], g.pos[2] + 0.02])], 2);
    expect(r.crateZ).toBeGreaterThan(g.pos[2]);
    expect(r.selfContacts).toBe(0);
  });

  it('a leadscrew\'s nut runs on its screw without the two colliding', () => {
    const ls = buildLeadscrewDrive({ lengthMm: 200, leadMm: 8 });
    const r = run(ls.nodes, 6);
    expect(r.selfContacts).toBe(0);
  });
});
