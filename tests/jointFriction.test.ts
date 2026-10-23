// Joint friction: the one thing damping cannot do.
//
// Damping resists in proportion to speed, so it fades as a joint slows and a
// damped lid still falls shut, only later. frictionloss is dry friction: the
// joint holds until the load passes it. These run the compiled scene in real
// MuJoCo and watch a lid propped open at 45 degrees.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import type { SceneGraph, SceneJoint } from '../src/types/scene';

type Mujoco = Awaited<ReturnType<typeof load_mujoco>>;
let mj: Mujoco;
beforeAll(async () => {
  mj = await load_mujoco();
});

// A 0.2 kg lid, 100 mm long, hinged at one end: its weight acts 50 mm out, so
// gravity loads the hinge with 0.2 * 9.81 * 0.05 * cos(45) = 0.069 N*m.
const lid = (joint: Partial<SceneJoint>): SceneGraph => ({
  nodes: [{
    id: 'lid', name: 'lid', type: 'body', pos: [0, 0, 0.2], euler: [0, -45, 0],
    geoms: [{ name: 'panel', type: 'box', size: [0.05, 0.03, 0.002], pos: [0.05, 0, 0], mass: 0.2, contype: 0, conaffinity: 0 }],
    joints: [{ name: 'hinge', type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], ...joint }],
    children: [],
  }],
} as unknown as SceneGraph);

/** The hinge angle, in radians, after `seconds` of falling. */
function angleAfter(scene: SceneGraph, seconds: number): number {
  const xml = compileToMJCF(scene, -9.81, 1, 0, 0, 0, 0);
  const model = mj.MjModel.from_xml_string(xml);
  const data = new mj.MjData(model);
  const steps = Math.round(seconds / model.opt.timestep);
  for (let i = 0; i < steps; i++) mj.mj_step(model, data);
  const q = data.qpos[0];
  data.delete();
  model.delete();
  return q;
}

describe('joint frictionloss', () => {
  it('compiles to the MJCF attribute, and to nothing when unset or zero', () => {
    expect(compileToMJCF(lid({ frictionloss: 0.1 }), -9.81, 1, 0, 0, 0, 0)).toContain('frictionloss="0.1"');
    expect(compileToMJCF(lid({}), -9.81, 1, 0, 0, 0, 0)).not.toContain('frictionloss');
    expect(compileToMJCF(lid({ frictionloss: 0 }), -9.81, 1, 0, 0, 0, 0)).not.toContain('frictionloss');
  });

  it('holds a lid where it was left when it exceeds the load', () => {
    // At MuJoCo's default friction impedance this lid crept 1.4 rad in 10 s,
    // whatever the friction; mjcf.ts stiffens it so it holds.
    expect(Math.abs(angleAfter(lid({ frictionloss: 0.1 }), 10))).toBeLessThan(0.005);
  });

  it('lets it fall when it does not', () => {
    expect(Math.abs(angleAfter(lid({ frictionloss: 0.03 }), 2))).toBeGreaterThan(0.3);
  });

  it('does what heavy damping cannot: damping only delays the fall', () => {
    expect(Math.abs(angleAfter(lid({ damping: 2 }), 10))).toBeGreaterThan(0.3);
  });
});
