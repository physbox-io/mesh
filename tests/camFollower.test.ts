// A cam drives its follower through contact. It used to be a linear coupling
// to the cam's angle, so the follower climbed with every turn and never came
// back down, whatever the profile. These run the built mechanism in MuJoCo.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import { buildCamMechanism, buildCamProfile, camConvexPieces, signedPolygonArea2, type CamProfileKind } from '../src/utils/mechanismParts';
import type { SceneGraph } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

const isConvex = (poly: [number, number][]) => poly.every((a, i) => {
  const b = poly[(i + 1) % poly.length];
  const c = poly[(i + 2) % poly.length];
  return (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) >= -1e-9;
});

/** Follower travel (mm) sampled against cam angle over `turns` revolutions. */
function run(kind: CamProfileKind, turns: number) {
  const mech = buildCamMechanism({ kind, baseRadiusMm: 18, liftMm: 10, origin: [0, 0, 0.05] });
  const xml = compileToMJCF({ nodes: mech.nodes } as unknown as SceneGraph, -9.81, 1, 0, 0, 0, 0);
  const m = mj.MjModel.from_xml_string(xml);
  const d = new mj.MjData(m);
  const hinge = mj.mj_name2id(m, mj.mjtObj.mjOBJ_JOINT.value, mech.camNode.joints[0].name);
  const slide = mj.mj_name2id(m, mj.mjtObj.mjOBJ_JOINT.value, mech.followerNode.joints[0].name);
  const hq = m.jnt_qposadr[hinge];
  const sq = m.jnt_qposadr[slide];
  // The app sets the motor's target from ctrlValue at run time.
  const act = mj.mj_name2id(m, mj.mjtObj.mjOBJ_ACTUATOR.value, `${mech.camNode.joints[0].name}_actuator`);
  d.ctrl[act] = mech.camNode.joints[0].actuator!.ctrlValue!;
  const samples: { theta: number; s: number }[] = [];
  for (let i = 0; i < 200_000; i++) {
    mj.mj_step(m, d);
    const theta = d.qpos[hq];
    if (i % 20 === 0) samples.push({ theta, s: d.qpos[sq] * 1000 });
    if (theta > turns * 2 * Math.PI) { samples.push({ theta, s: d.qpos[sq] * 1000 }); break; }
  }
  d.delete();
  m.delete();
  return samples;
}

describe('cam and follower', () => {
  it('collides as convex pieces that cover the profile exactly', () => {
    for (const kind of ['eccentric', 'snail', 'heart', 'harmonic'] as CamProfileKind[]) {
      const prof = buildCamProfile({ kind, baseRadiusMm: 18, liftMm: 10 });
      const pieces = camConvexPieces(prof.outline);
      for (const p of pieces) expect(isConvex(p), kind).toBe(true);
      const area = pieces.reduce((a, p) => a + Math.abs(signedPolygonArea2(p)), 0);
      expect(area / Math.abs(signedPolygonArea2(prof.outline)), kind).toBeCloseTo(1, 6);
    }
  });

  it('is not coupled: the follower is pushed by the cam', () => {
    const mech = buildCamMechanism({ kind: 'heart' });
    expect(mech.followerNode.coupleTargetId).toBeUndefined();
    expect(mech.followerNode.joints[0].stiffness).toBeGreaterThan(0);
  });

  for (const kind of ['eccentric', 'snail', 'heart', 'harmonic'] as CamProfileKind[]) {
    it(`${kind}: the follower rises by the lift and comes back down every turn`, () => {
      const samples = run(kind, 3);
      expect(samples.at(-1)!.theta, 'the cam turned three times').toBeGreaterThan(3 * 2 * Math.PI);
      for (let turn = 0; turn < 3; turn++) {
        const inTurn = samples.filter((x) => x.theta >= turn * 2 * Math.PI && x.theta < (turn + 1) * 2 * Math.PI);
        const top = Math.max(...inTurn.map((x) => x.s));
        const bottom = Math.min(...inTurn.map((x) => x.s));
        // A roller follows the profile offset by its radius, so its stroke is
        // near the lift but not exactly it.
        expect(top - bottom, `${kind} turn ${turn}`).toBeGreaterThan(7);
        expect(top - bottom, `${kind} turn ${turn}`).toBeLessThan(11);
        expect(bottom, `${kind} turn ${turn}`).toBeLessThan(1);
        expect(top, `${kind} turn ${turn}`).toBeLessThan(11);
      }
    }, 60_000);
  }
});
