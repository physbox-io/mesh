// physics_build_mechanism: every family takes origin, idPrefix and the drive's
// actuation, and gears can be built onto an existing arbor. The bridge used
// to build a gear pair with no options at all, so every pair landed on the
// same spot and pairs stacked, and there was no compound gear.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import { buildMechanism, MECHANISM_FAMILIES, type MechanismBuild } from '../src/utils/buildMechanism';
import type { SceneNode } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

const ok = (r: MechanismBuild | { error: string }): MechanismBuild => {
  if ('error' in r) throw new Error(r.error);
  return r;
};
const find = (ns: SceneNode[], id: string): SceneNode | null => {
  for (const n of ns) {
    if (n.id === id) return n;
    const c = find(n.children || [], id);
    if (c) return c;
  }
  return null;
};
const actuators = (ns: SceneNode[]) => {
  const out: NonNullable<SceneNode['joints'][number]['actuator']>[] = [];
  const walk = (list: SceneNode[]) => list.forEach((n) => { n.joints.forEach((j) => j.actuator && out.push(j.actuator)); walk(n.children || []); });
  walk(ns);
  return out;
};

describe('build_mechanism options', () => {
  it('two gear pairs go where they are told, named from idPrefix', () => {
    const a = ok(buildMechanism({ family: 'gear_pair', driverTeeth: 16, drivenTeeth: 32, origin: [0, 0, 0.05], idPrefix: 'p1' }, []));
    const b = ok(buildMechanism({ family: 'gear_pair', driverTeeth: 16, drivenTeeth: 32, origin: [0.2, 0, 0.05], idPrefix: 'p2' }, a.nodes));
    expect(a.addedIds).toEqual(['gear_p1', 'gear_p1_2']);
    expect(b.nodes.map((n) => n.id)).toEqual(['gear_p1', 'gear_p1_2', 'gear_p2', 'gear_p2_2']);
    // Was both pairs on the default spot.
    expect(find(b.nodes, 'gear_p2')!.pos).toEqual([0.2, 0, 0.05]);
    expect(find(b.nodes, 'gear_p2_2')!.coupleTargetId).toBe('gear_p2');
    expect(find(b.nodes, 'gear_p2')!.joints[0].name).toBe('gear_p2_hinge');
    // Built again under the same prefix, it replaces itself.
    const again = ok(buildMechanism({ family: 'gear_pair', origin: [0.2, 0.1, 0.05], idPrefix: 'p2' }, b.nodes));
    expect(again.nodes).toHaveLength(4);
    expect(find(again.nodes, 'gear_p2')!.pos).toEqual([0.2, 0.1, 0.05]);
  });

  it('every family takes actuate, speed and torqueLimitNm', () => {
    for (const family of MECHANISM_FAMILIES) {
      const driven = ok(buildMechanism({ family, speed: 7, torqueLimitNm: 0.3 }, []));
      const acts = actuators(driven.nodes);
      expect(acts.length, family).toBe(1);
      expect(acts[0].ctrlValue, family).toBe(7);
      expect(acts[0].forceLimit, family).toBe(0.3);
      expect(actuators(ok(buildMechanism({ family, actuate: false }, [])).nodes), family).toEqual([]);
    }
  });

  it('refuses an unknown family or arbor', () => {
    expect(buildMechanism({ family: 'worm' }, [])).toHaveProperty('error');
    expect(buildMechanism({ family: 'gear', arborId: 'nope' }, [])).toHaveProperty('error');
  });
});

describe('a compound gear train built onto arbors', () => {
  it('three 16:48 stages on two compound arbors turn at 1/27, through explicit couplings only', () => {
    let scene: SceneNode[] = [];
    const stage1 = ok(buildMechanism({ family: 'gear_pair', driverTeeth: 16, drivenTeeth: 48, moduleMm: 1, origin: [0, 0, 0.05], idPrefix: 's1', speed: 27 }, scene));
    scene = stage1.nodes;
    // A 16T pinion 10 mm up the 48T wheel's arbor drives the next 48T wheel.
    const stage2 = ok(buildMechanism({ family: 'gear_pair', driverTeeth: 16, drivenTeeth: 48, moduleMm: 1, arborId: 'gear_s1_2', axialOffsetMm: 10, meshAngleDeg: 90, idPrefix: 's2' }, scene));
    scene = stage2.nodes;
    const stage3 = ok(buildMechanism({ family: 'gear_pair', driverTeeth: 16, drivenTeeth: 48, moduleMm: 1, arborId: stage2.addedIds[0], axialOffsetMm: 10, meshAngleDeg: 180, idPrefix: 's3' }, scene));
    scene = stage3.nodes;
    expect(stage2.arborId).toBe('gear_s1_2');
    // The arbor carries both gears on its one hinge.
    const arbor = find(scene, 'gear_s1_2')!;
    expect(arbor.joints).toHaveLength(1);
    expect(arbor.geoms.filter((g) => g.role === 'collision')).toHaveLength(2);
    const out = find(scene, stage3.addedIds[0])!;
    expect(out.pos[2]).toBeCloseTo(0.07, 6);

    const xml = compileToMJCF({ nodes: scene }, -9.81, 1, 0, 0, 0);
    expect(xml.match(/<tendon name="gear_coupling_[^"]*"/g) ?? []).toEqual([]);
    const m = mj.MjModel.from_xml_string(xml);
    const d = new mj.MjData(m);
    try {
      d.ctrl[0] = 27;
      for (let i = 0; i < 2000; i++) mj.mj_step(m, d);
      const v = (body: string) => d.qvel[m.jnt_dofadr[mj.mj_name2id(m, mj.mjtObj.mjOBJ_JOINT.value, `${body}_hinge`)]];
      expect(v('gear_s1')).toBeGreaterThan(26);
      expect(v('gear_s1_2') / v('gear_s1')).toBeCloseTo(-1 / 3, 4);
      expect(v(stage3.addedIds[0]) / v('gear_s1')).toBeCloseTo(-1 / 27, 4);
    } finally {
      d.delete(); m.delete();
    }
  });
});
