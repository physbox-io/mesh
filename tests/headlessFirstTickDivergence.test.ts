// A headless run that blows up on its very first tick.
//
// MuJoCo resets a diverging model inside mj_step (mj_resetData: qpos0, zero
// velocity, time 0) and then finishes the step, so the step ends at one
// timestep. Mid-run that is the clock going backwards, which runHeadlessLoop
// catches. From t = 0 it is indistinguishable by the clock from a good step:
// the run came back un-truncated, ran on from rest, and the initial velocities
// the scene set were silently gone. The reset warning MuJoCo raises with it is
// what gives it away (src/utils/mujocoAutoReset.ts).

import { describe, it, expect } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { runHeadlessLoop, type HeadlessLoopHooks } from '../src/store/physicsWorkerClient';
import { autoResetCount } from '../src/utils/mujocoAutoReset';

const xml = `<mujoco>
  <option timestep="0.001" gravity="0 0 -9.81"/>
  <worldbody>
    <geom name="floor" type="plane" size="5 5 0.1"/>
    <body name="ball" pos="0 0 1">
      <freejoint name="fj"/>
      <geom type="sphere" size="0.1"/>
    </body>
    <body name="puck" pos="1 0 1">
      <freejoint name="fj2"/>
      <geom type="sphere" size="0.1"/>
    </body>
  </worldbody>
</mujoco>`;

type Frame = { time: number; puckVx: number };

/** The worker's hooks over a real model, with initial qvel set the way it sets them. */
const setUp = async (qvel: Record<number, number>, watchResets = true) => {
  const mujoco = await load_mujoco();
  const model = mujoco.MjModel.from_xml_string(xml);
  const data = new mujoco.MjData(model);
  mujoco.mj_forward(model, data);
  for (const [dof, v] of Object.entries(qvel)) data.qvel[Number(dof)] = v;
  mujoco.mj_forward(model, data);
  const hooks: HeadlessLoopHooks<Frame> = {
    step: () => mujoco.mj_step(model, data),
    time: () => data.time,
    isBad: () => !Number.isFinite(data.qpos[0]),
    sample: () => ({ time: data.time, puckVx: data.qvel[6] }),
    ...(watchResets ? { resets: () => autoResetCount(data) } : {}),
  };
  return { hooks, data, dispose: () => { data.delete(); model.delete(); } };
};

describe('a headless run that diverges on its first tick', () => {
  it('is the case the clock alone misses', async () => {
    // Documents the bug: without the reset counter the run looks complete.
    const { hooks, dispose } = await setUp({ 0: 1e11, 6: 3 }, false);
    try {
      const out = runHeadlessLoop({ ticks: 50 }, hooks);
      expect(out.truncated).toBe(false);
      expect(out.frames[0].puckVx).toBe(0); // the puck's 3 m/s, gone
    } finally { dispose(); }
  });

  it('is reported as diverged at tick 1, naming the initial velocities it wiped', async () => {
    const { hooks, dispose } = await setUp({ 0: 1e11, 6: 3 });
    try {
      const out = runHeadlessLoop({ ticks: 50, initialVelocityJoints: ['fj', 'fj2'] }, hooks);
      expect(out.truncated).toBe(true);
      expect(out.truncationReason).toBe('diverged');
      expect(out.ticksSimulated).toBe(0);
      expect(out.frames).toEqual([]);
      expect(out.truncationDetail).toMatch(/very first tick/);
      expect(out.truncationDetail).toMatch(/initial velocities set on joints fj, fj2/);
    } finally { dispose(); }
  });

  it('keeps the initial velocities of a scene that does not blow up', async () => {
    const { hooks, dispose } = await setUp({ 6: 3 });
    try {
      const out = runHeadlessLoop({ ticks: 50, initialVelocityJoints: ['fj2'] }, hooks);
      expect(out.truncated).toBe(false);
      expect(out.ticksSimulated).toBe(50);
      expect(out.frames[0].puckVx).toBeCloseTo(3, 6);
      expect(out.frames[49].puckVx).toBeCloseTo(3, 6);
    } finally { dispose(); }
  });

  it('still catches a reset later in the run, where the counter does not grow', async () => {
    // mj_resetData clears the counters and the check sets its own to 1, so a
    // second reset leaves the sum unchanged: the clock check covers that.
    const { hooks, data, dispose } = await setUp({ 0: 1e11 });
    try {
      hooks.step(); // an earlier reset: the counter now reads 1
      expect(hooks.resets!()).toBe(1);
      let tick = 0;
      const step = hooks.step;
      hooks.step = () => { tick++; if (tick === 20) data.qvel[0] = 1e11; step(); };
      const out = runHeadlessLoop({ ticks: 50 }, hooks);
      expect(hooks.resets!()).toBe(1);
      expect(out.truncated).toBe(true);
      expect(out.truncationReason).toBe('diverged');
      expect(out.ticksSimulated).toBe(19);
    } finally { dispose(); }
  });
});
