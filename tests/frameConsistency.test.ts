// One frame, one instant: after a step the bodies are where the joints are.
// mj_step derives xpos/cvel before it integrates, so they lagged qpos/qvel by
// a step (vz by g·dt, pos by v·dt). See syncKinematics in bodyKinematics.ts.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { bodyPointVelocity, syncKinematics } from '../src/workers/bodyKinematics';

type Mujoco = Awaited<ReturnType<typeof load_mujoco>>;
let mj: Mujoco;

const XML = `<mujoco>
  <option timestep="0.001" gravity="0 0 -9.81"/>
  <worldbody>
    <body name="ball" pos="0 0 1"><freejoint name="ball_free"/><geom type="sphere" size="0.02" mass="0.1"/></body>
  </worldbody>
</mujoco>`;

beforeAll(async () => { mj = await load_mujoco(); });

const run = (sync: boolean) => {
  const model = mj.MjModel.from_xml_string(XML);
  const data = new mj.MjData(model);
  try {
    mj.mj_forward(model, data);
    data.qvel[0] = 0.3;
    for (let i = 0; i < 200; i++) {
      mj.mj_step(model, data);
      if (sync) syncKinematics(mj, model, data);
    }
    const v = bodyPointVelocity({ cvel: data.cvel, xpos: data.xpos, subtreeCom: data.subtree_com, rootId: model.body_rootid }, 1);
    return {
      dz: data.xpos[5] - data.qpos[2],
      dx: data.xpos[3] - data.qpos[0],
      dvz: v[2] - data.qvel[2],
    };
  } finally { data.delete(); model.delete(); }
};

describe('frame consistency after a step', () => {
  it('lagged by one step without the sync', () => {
    const r = run(false);
    expect(r.dvz).toBeCloseTo(9.81 * 0.001, 6);
    expect(Math.abs(r.dx)).toBeCloseTo(0.3 * 0.001, 6);
  });

  it('agrees with the joints once synced', () => {
    const r = run(true);
    expect(Math.abs(r.dz)).toBeLessThan(1e-12);
    expect(Math.abs(r.dx)).toBeLessThan(1e-12);
    expect(Math.abs(r.dvz)).toBeLessThan(1e-12);
  });

  it('does not change the physics', () => {
    const traj = (sync: boolean) => {
      const model = mj.MjModel.from_xml_string(XML);
      const data = new mj.MjData(model);
      try {
        data.qvel[0] = 0.3;
        for (let i = 0; i < 500; i++) { mj.mj_step(model, data); if (sync) syncKinematics(mj, model, data); }
        return Array.from(data.qpos as ArrayLike<number>);
      } finally { data.delete(); model.delete(); }
    };
    expect(traj(true)).toEqual(traj(false));
  });
});
