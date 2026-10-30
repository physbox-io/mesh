// A pulley rope is a rigid coupling of its ends and its wheel, with a strand
// count per end. It used to be two joint equalities at the default softness,
// a hard-coded left = -right and left = r*theta: the wheel lagged the rope by
// 33-43 mm and the ends drifted 5.4 mm apart, and a movable pulley (MA 2) or
// a block and tackle (MA 4) could only be built with coupleRatio, with no
// rope drawn. The drawn rope tied on 0.5*r above each body's origin and always
// ran the left end to the wheel's -X side, crossing when the left end was on +X.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import { couplingWarnings, restPoses } from '../src/utils/sceneCouplings';
import { ropeLayout, ropePolylines, type V3 } from '../src/utils/pulleyRope';
import { PRESETS } from '../src/presets/presetScenes';
import type { SceneNode } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

const run = (nodes: SceneNode[], steps: number, read: (q: (j: string) => number) => void) => {
  const m = mj.MjModel.from_xml_string(compileToMJCF({ nodes }, -9.81, 1, 0, 0, 0));
  const d = new mj.MjData(m);
  try {
    for (let i = 0; i < steps; i++) mj.mj_step(m, d);
    read((j) => d.qpos[m.jnt_qposadr[mj.mj_name2id(m, mj.mjtObj.mjOBJ_JOINT.value, j)]] as number);
  } finally { d.delete(); m.delete(); }
};

const R = 0.05;
const weight = (id: string, x: number, mass: number, half = 0.03): SceneNode => ({
  id, name: id, type: 'body', pos: [x, 0, 0.8], children: [],
  joints: [{ name: `${id}_slide`, type: 'slide', axis: [0, 0, 1] }],
  geoms: [{ name: `${id}_g`, type: 'box', size: [half, half, half], mass, contype: 0, conaffinity: 0 }],
});
/** A wheel at 1.3 m, a rope over it from `left` to `right`, `n` strands holding the right end. */
const rig = (left: SceneNode, right: SceneNode, n = 1): SceneNode[] => [
  {
    id: 'wheel', name: 'wheel', type: 'body', pos: [0, 0, 1.3], children: [], isPulleyWheel: true, pulleyRadius: R,
    joints: [{ name: 'wheel_hinge', type: 'hinge', axis: [0, 1, 0] }],
    geoms: [{ name: 'wheel_g', type: 'cylinder', size: [R, 0.006], euler: [90, 0, 0], mass: 0.01, contype: 0, conaffinity: 0 }],
  },
  left, right,
  {
    id: 'rope', name: 'rope', type: 'body', pos: [0, 0, 1.3], children: [], joints: [], geoms: [],
    isPulleyRope: true, pulleyWheelId: 'wheel', leftTargetId: left.id, rightTargetId: right.id, ...(n !== 1 ? { rightStrands: n } : {}),
  },
];

describe('pulley rope', () => {
  it('compiles to rigid tendon couplings, not soft joint equalities', () => {
    const xml = compileToMJCF(PRESETS.pulley_system.scene, -9.81, 1, 0, 0, 0);
    expect(xml).not.toMatch(/<joint name="rope_coupling/);
    expect(xml).toMatch(/<fixed name="rope_coupling_linear_1"><joint joint="left_weight_joint" coef="1" \/><joint joint="right_weight_joint" coef="1" \/>/);
    expect(xml).toMatch(/<fixed name="rope_coupling_angular_1"><joint joint="pulley_wheel_hinge" coef="1" \/><joint joint="left_weight_joint" coef="-12.5" \/>/);
    expect(couplingWarnings(PRESETS.pulley_system.scene.nodes)).toEqual([]);
  });

  it("an Atwood machine's rope does not stretch and its wheel does not lag", () => {
    const nodes = PRESETS.pulley_system.scene.nodes;
    run(nodes, 300, (q) => {
      const l = q('left_weight_joint'), r = q('right_weight_joint'), th = q('pulley_wheel_hinge');
      expect(l).toBeLessThan(-0.05);
      // Were 5.4 mm and 33-43 mm.
      expect(Math.abs(l + r)).toBeLessThan(5e-5);
      expect(Math.abs(0.08 * th - l)).toBeLessThan(5e-5);
    });
  });

  it('a movable pulley (2 strands) balances twice the effort, and moves half as far', () => {
    // 2 kg on two strands against 1 kg: held.
    run(rig(weight('effort', -R, 1), weight('load', R, 2), 2), 500, (q) => {
      expect(Math.abs(q('effort_slide'))).toBeLessThan(1e-3);
      expect(Math.abs(q('load_slide'))).toBeLessThan(1e-3);
    });
    // 1.5 kg of effort lifts it, the load rising half as far as the effort falls.
    run(rig(weight('effort', -R, 1.5), weight('load', R, 2), 2), 500, (q) => {
      const e = q('effort_slide'), l = q('load_slide');
      expect(e).toBeLessThan(-0.05);
      expect(l / e).toBeCloseTo(-0.5, 4);
      expect(q('wheel_hinge') * R).toBeCloseTo(e, 4);
    });
  });

  it('a four-fall block and tackle balances four times the effort', () => {
    const tackle = rig(weight('effort', -R, 1), weight('load', R, 4), 4);
    run(tackle, 500, (q) => {
      expect(Math.abs(q('effort_slide'))).toBeLessThan(1e-3);
    });
    const { layout } = ropeLayout(tackle[3], new Map(tackle.map((n) => [n.id, n])), restPoses(tackle));
    expect(layout!.linearRatio).toBe(-4);
  });

  it('with the left end on +X the wheel turns the other way, and the drawn rope does not cross', () => {
    const nodes = rig(weight('a', R, 1), weight('b', -R, 1.5));
    run(nodes, 300, (q) => {
      // a (left, on +X) rises; the rim on its side moves up, so the wheel turns -Y.
      expect(q('a_slide')).toBeGreaterThan(0.05);
      expect(q('wheel_hinge') * R).toBeCloseTo(-q('a_slide'), 4);
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const { layout } = ropeLayout(nodes[3], byId, restPoses(nodes));
    // Tied on at the top face of each 30 mm box, not 0.5*r above its origin.
    expect(layout!.left.attachLocal).toEqual([0, 0, 0.03]);
    const lines = ropePolylines(
      { attach: [R, 0, 0.83], axis: [0, 0, 1], sign: 1, strands: 1 },
      { attach: [-R, 0, 0.83], axis: [0, 0, 1], sign: 1, strands: 1 },
      { centre: [0, 0, 1.3], axis: [0, 1, 0], radius: R },
    );
    const main = lines[0];
    expect(lines).toHaveLength(1);
    // Up the +X side, over the top, down the -X side.
    expect(main[1][0]).toBeCloseTo(R, 9);
    expect(main[1][2]).toBeCloseTo(1.3, 9);
    expect(Math.max(...main.map((p) => p[2]))).toBeCloseTo(1.3 + R, 3);
    expect(main[main.length - 2][0]).toBeCloseTo(-R, 9);
  });

  it('draws each further strand of an end, and runs a table-top rope round the corner it turns', () => {
    const lines = ropePolylines(
      { attach: [-R, 0, 0.83], axis: [0, 0, 1], sign: 1, strands: 1 },
      { attach: [R, 0, 0.83], axis: [0, 0, 1], sign: 1, strands: 2 },
      { centre: [0, 0, 1.3], axis: [0, 1, 0], radius: R },
    );
    expect(lines).toHaveLength(2);
    expect(lines[1][1][2]).toBeCloseTo(1.3, 9);
    // A cart sliding +X along a table to a wheel at its edge, a weight hanging below the wheel's +X side.
    const corner = ropePolylines(
      { attach: [-0.3, 0, 1.3 + R], axis: [1, 0, 0], sign: 1, strands: 1 },
      { attach: [R, 0, 0.8], axis: [0, 0, 1], sign: 1, strands: 1 },
      { centre: [0, 0, 1.3], axis: [0, 1, 0], radius: R },
    )[0] as V3[];
    expect(corner[1]).toEqual([expect.closeTo(0, 9), 0, expect.closeTo(1.3 + R, 9)]);
    expect(corner[corner.length - 2][0]).toBeCloseTo(R, 9);
    // A quarter turn: never below the axle on the way.
    expect(Math.min(...corner.slice(1, -1).map((p) => p[2]))).toBeGreaterThan(1.3 - 1e-9);
  });

  it('names a rope end that cannot slide', () => {
    const nodes = rig(weight('effort', -R, 1), { ...weight('load', R, 2), joints: [{ name: 'load_free', type: 'free' }] });
    const w = couplingWarnings(nodes);
    expect(w.some((s) => s.includes("right end 'load' has only a free joint"))).toBe(true);
    expect(compileToMJCF({ nodes }, -9.81, 1, 0, 0, 0)).not.toContain('rope_coupling');
  });
});
