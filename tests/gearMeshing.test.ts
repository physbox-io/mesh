// Which gears the compiler couples by proximity. Every hinge body with 'gear'
// in its id used to be coupled to every other within 1.2*(r1+r2) of body
// origins, whatever plane or axis either turned in, so a folded train of
// arbors got couplings between arbors that only passed each other, jammed,
// and its motor stalled at 0 rad/s.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import type { SceneNode } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

/** Arbor i: a 32 mm wheel and, 4 mm above it, an 8 mm pinion, the train stepping up 4 mm a stage. */
const arbor = (i: number, x: number, y: number): SceneNode => ({
  id: `gear_a${i}`, name: `gear_a${i}`, type: 'body', pos: [x, y, 0.05], children: [],
  joints: [{ name: `a${i}_hinge`, type: 'hinge', axis: [0, 0, 1], pos: [0, 0, 0], damping: 0.0001 }],
  geoms: [
    { name: `a${i}_wheel`, type: 'cylinder', size: [0.032, 0.002], pos: [0, 0, 0.004 * i], contype: 0, conaffinity: 0, density: 1240 },
    { name: `a${i}_pin`, type: 'cylinder', size: [0.008, 0.002], pos: [0, 0, 0.004 * i + 0.004], contype: 0, conaffinity: 0, density: 1240 },
  ],
  ...(i > 0 ? { coupleTargetId: `gear_a${i - 1}`, coupleRatio: -0.25 } : {}),
});

const train = (layout: [number, number][]) => {
  const nodes = layout.map(([x, y], i) => arbor(i, x, y));
  nodes[0].joints[0].actuator = { type: 'velocity', kv: 0.05, forceLimit: 0.05, ctrlValue: 25.6 };
  return nodes;
};

const speeds = (nodes: SceneNode[], joints: string[], ctrl: number) => {
  const m = mj.MjModel.from_xml_string(compileToMJCF({ nodes }, -9.81, 1, 0, 0, 0));
  const d = new mj.MjData(m);
  try {
    d.ctrl[0] = ctrl;
    for (let i = 0; i < 1000; i++) mj.mj_step(m, d);
    return joints.map((n) => d.qvel[m.jnt_dofadr[mj.mj_name2id(m, mj.mjtObj.mjOBJ_JOINT.value, n)]] as number);
  } finally {
    d.delete(); m.delete();
  }
};

const proximityCouplings = (xml: string) => xml.match(/<tendon name="gear_coupling_[^"]*"/g) ?? [];

describe('gear proximity coupling', () => {
  it('a folded, explicitly chained train gets no extra couplings, and turns', () => {
    const nodes = train([[0, 0], [0.04, 0], [0.04, 0.04], [0, 0.04], [-0.04, 0.04]]);
    // Was four: a0-a2, a0-a3, a0-a4 and a1-a3.
    expect(proximityCouplings(compileToMJCF({ nodes }))).toEqual([]);
    const [motor, out] = speeds(nodes, ['a0_hinge', 'a4_hinge'], 25.6);
    // Was 0 rad/s, jammed.
    expect(motor).toBeGreaterThan(25);
    expect(out / motor).toBeCloseTo(1 / 256, 5);
  });

  /** Two free gears: a cylinder of radius ra at the origin, rb at x, in planes za and zb. */
  const pair = (ra: number, rb: number, x: number, zb = 0, axisB: number[] = [0, 0, 1]): SceneNode[] => [
    { id: 'gear_p', name: 'gear_p', type: 'body', pos: [0, 0, 0.05], children: [],
      joints: [{ name: 'p_hinge', type: 'hinge', axis: [0, 0, 1], actuator: { type: 'velocity', kv: 1, ctrlValue: 2 } }],
      geoms: [{ name: 'p_g', type: 'cylinder', size: [ra, 0.003], density: 1240, contype: 0, conaffinity: 0 }] },
    { id: 'gear_w', name: 'gear_w', type: 'body', pos: [x, 0, 0.05 + zb], children: [],
      joints: [{ name: 'w_hinge', type: 'hinge', axis: axisB }],
      geoms: [{ name: 'w_g', type: 'cylinder', size: [rb, 0.003], density: 1240, contype: 0, conaffinity: 0 }] },
  ];

  it('couples two gears in one plane at their radii, driven 2:1 down', () => {
    const nodes = pair(0.01, 0.02, 0.03);
    expect(proximityCouplings(compileToMJCF({ nodes }))).toHaveLength(1);
    const [p, w] = speeds(nodes, ['p_hinge', 'w_hinge'], 2);
    expect(p).toBeGreaterThan(1.9);
    // r_p*w_p = -r_w*w_w: the big wheel turns at half the speed, backwards.
    expect(w / p).toBeCloseTo(-0.5, 3);
  });

  it('does not couple gears that pass in different planes, or turn about crossed axes', () => {
    expect(proximityCouplings(compileToMJCF({ nodes: pair(0.01, 0.02, 0.03, 0.02) }))).toEqual([]);
    expect(proximityCouplings(compileToMJCF({ nodes: pair(0.01, 0.02, 0.03, 0, [1, 0, 0]) }))).toEqual([]);
    // Nor a gear sitting on another's axis.
    expect(proximityCouplings(compileToMJCF({ nodes: pair(0.01, 0.02, 0) }))).toEqual([]);
  });

  it('an arbor meshes by the wheel in the other gear\'s plane, not its first geom', () => {
    // a1's 8 mm pinion is 4 mm up, in the plane of a free 32 mm wheel 40 mm away.
    const a = arbor(1, 0, 0);
    delete a.coupleTargetId;
    const nodes: SceneNode[] = [
      { ...a, joints: [{ ...a.joints[0], actuator: { type: 'velocity', kv: 1, ctrlValue: 4 } }] },
      { id: 'gear_big', name: 'gear_big', type: 'body', pos: [0.04, 0, 0.05 + 0.008], children: [],
        joints: [{ name: 'big_hinge', type: 'hinge', axis: [0, 0, 1] }],
        geoms: [{ name: 'big_g', type: 'cylinder', size: [0.032, 0.002], density: 1240, contype: 0, conaffinity: 0 }] },
    ];
    expect(proximityCouplings(compileToMJCF({ nodes }))).toHaveLength(1);
    const [p, w] = speeds(nodes, ['a1_hinge', 'big_hinge'], 4);
    expect(w / p).toBeCloseTo(-0.25, 3);
  });
});
