// Nodes that are not bodies in the model: a pulley rope (no body at all) and a
// composite cable (whose joints MuJoCo generates under its own names).
//
// Each of these used to break the build. A part added with a rope selected
// lands under the rope, and the compiler dropped it with the rope. A weld or
// pin to a rope, and an actuator or coupling on a cable's joint, named
// something the model does not have, and MuJoCo refused the whole scene.

import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.hoisted(() => { (globalThis as { navigator?: unknown }).navigator ??= { hardwareConcurrency: 2 }; });

import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import { getSyncedSceneGraph } from '../src/utils/mujocoSync';
import type { SceneGraph, SceneNode } from '../src/types/scene';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

const box = (id: string, extra: Partial<SceneNode> = {}): SceneNode => ({
  id, name: id, pos: [0, 0, 0.1], children: [],
  joints: [{ name: `${id}_free`, type: 'free' }],
  geoms: [{ name: `${id}_g`, type: 'box', size: [0.02, 0.02, 0.02] }],
  ...extra,
} as SceneNode);
const rope = (extra: Partial<SceneNode> = {}): SceneNode => ({
  id: 'rope', name: 'rope', pos: [0.3, 0, 0.5], isPulleyRope: true,
  leftTargetId: '', rightTargetId: '', pulleyWheelId: '', geoms: [], joints: [], children: [],
  ...extra,
} as SceneNode);
const cable = (extra: Partial<SceneNode> = {}, joint: object = {}): SceneNode => ({
  id: 'cable', name: 'cable', pos: [0, 0, 0.5], isComposite: true, compositeType: 'cable',
  joints: [{ name: 'cable_j', type: 'hinge', axis: [0, 0, 1], ...joint }],
  geoms: [{ name: 'cable_g', type: 'capsule', size: [0.01] }], children: [],
  ...extra,
} as SceneNode);
const hinged = (extra: Partial<SceneNode> = {}): SceneNode => box('wheel', { joints: [{ name: 'wheel_j', type: 'hinge', axis: [0, 0, 1] }], ...extra });

/** Compiles and loads the scene, then hands back the model and its data after one forward pass. */
const load = (nodes: SceneNode[]) => {
  const m = mj.MjModel.from_xml_string(compileToMJCF({ nodes } as SceneGraph));
  const d = new mj.MjData(m);
  mj.mj_forward(m, d);
  return { m, d, bodyId: (name: string) => mj.mj_name2id(m, mj.mjtObj.mjOBJ_BODY.value, name) as number, done: () => { d.delete(); m.delete(); } };
};

describe('a part under a pulley rope', () => {
  it('is in the model, placed in the rope frame', () => {
    const { d, bodyId, done } = load([rope({ euler: [0, 0, 90], children: [box('kid', { pos: [0.1, 0, 0] })] })]);
    const id = bodyId('kid');
    expect(id).toBeGreaterThan(0);
    const at = Array.from(d.xpos.slice(id * 3, id * 3 + 3) as number[]);
    // 0.1 along the rope's x, turned 90 degrees about z, from the rope's position.
    expect(at[0]).toBeCloseTo(0.3, 6);
    expect(at[1]).toBeCloseTo(0.1, 6);
    expect(at[2]).toBeCloseTo(0.5, 6);
    done();
  });

  it('is written back in the rope frame, so it does not jump on the next build', () => {
    const scene = { nodes: [rope({ children: [box('kid', { pos: [0.1, 0, 0] })] })] } as SceneGraph;
    const { m, d, done } = load(scene.nodes);
    const synced = getSyncedSceneGraph(scene, m, d, mj);
    const kid = synced.nodes[0].children![0];
    expect(kid.pos[0]).toBeCloseTo(0.1, 6);
    expect(kid.pos[1]).toBeCloseTo(0, 6);
    expect(kid.pos[2]).toBeCloseTo(0, 6);
    done();
  });

  it('a rope with nothing under it still emits nothing', () => {
    expect(compileToMJCF({ nodes: [rope()] } as SceneGraph)).not.toContain('<frame');
  });
});

describe('a weld or a pin to a pulley rope', () => {
  it('comes off, and the scene still loads', () => {
    const { m, done } = load([rope(), box('a', { weldTargetId: 'rope' }), box('b', { connectTargetId: 'rope', connectAnchor: [0, 0, 0.1] })]);
    expect(m.neq).toBe(0);
    done();
  });
});

describe("a cable's joints", () => {
  it('take no actuator, crumple lock or coupling, and the scene still loads', () => {
    const { m, done } = load([
      cable({ coupleTargetId: 'wheel', coupleRatio: 1 }, { actuator: { type: 'velocity', kv: 1 }, crumpleTorqueNm: 1 }),
      hinged({ coupleTargetId: 'cable', coupleRatio: 1 }),
    ]);
    expect(m.nu).toBe(0);
    expect(m.neq).toBe(0);
    done();
  });
});
