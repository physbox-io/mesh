// A body creeping under the settled speed is not settled. Soft contacts let a
// block below its friction angle slide at a steady fraction of a mm/s, which
// `final` used to call settled. See creepRate in src/utils/trajectorySummary.ts.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { TrajectoryAccumulator } from '../src/utils/trajectorySummary';
import { bodyAngularVelocity, bodyPointVelocity, syncKinematics } from '../src/workers/bodyKinematics';

type Mujoco = Awaited<ReturnType<typeof load_mujoco>>;
let mj: Mujoco;

beforeAll(async () => { mj = await load_mujoco(); });

/** A 40 mm block on a plank tilted `deg` (friction 0.6: slips past ~31°), started `lift` above it. */
function settle(deg: number, seconds: number, lift = 0) {
  const r = (deg * Math.PI) / 180;
  const h = 0.03 + lift;
  const XML = `<mujoco><option timestep="0.001"/><worldbody>
    <body euler="0 ${deg} 0"><geom type="box" size="0.5 0.2 0.01" friction="0.6 0.005 0.0001"/></body>
    <body name="blk" pos="${-h * Math.sin(r)} 0 ${h * Math.cos(r)}" euler="0 ${deg} 0"><freejoint/>
      <geom type="box" size="0.02 0.02 0.02" mass="0.1" friction="0.6 0.005 0.0001"/></body>
  </worldbody></mujoco>`;
  const model = mj.MjModel.from_xml_string(XML);
  const data = new mj.MjData(model);
  const acc = new TrajectoryAccumulator();
  // Body 2: world is 0, the plank 1.
  try {
    for (let i = 0; i < seconds * 1000; i++) {
      mj.mj_step(model, data);
      syncKinematics(mj, model, data);
      const v = { cvel: data.cvel, xpos: data.xpos, subtreeCom: data.subtree_com, rootId: model.body_rootid };
      const q = data.xquat;
      acc.add({ time: data.time, bodies: { blk: {
        pos: [data.xpos[6], data.xpos[7], data.xpos[8]], vel: bodyPointVelocity(v, 2), angvel: bodyAngularVelocity(v, 2),
        quat: [q[8], q[9], q[10], q[11]],
      } } });
    }
  } finally { data.delete(); model.delete(); }
  return acc.result()!;
}

describe('creep', () => {
  it('flags a block creeping down a slope below its friction angle', () => {
    const s = settle(10, 3);
    const b = s.bodies.blk;
    // Under the 1 mm/s that `settled` allows ...
    expect(b.speedMmS).toBeLessThan(1);
    // ... but sliding all the same.
    expect(b.creeping).toBe(true);
    expect(b.creepMmS!).toBeGreaterThan(0.3);
    expect(b.creepMmS!).toBeLessThan(1);
    expect(b.settled).toBe(false);
    expect(s.settled).toBe(false);
    expect(s.creeping).toEqual(['blk']);
  });

  it('does not flag a block at rest on the level, even one dropped onto it', () => {
    for (const lift of [0, 0.02]) {
      const s = settle(0, 2, lift);
      expect(s.bodies.blk.creeping).toBeUndefined();
      expect(s.bodies.blk.settled).toBe(true);
      expect(s.settled).toBe(true);
    }
  });

  it('does not take a body still easing to rest for a creeper', () => {
    // Speed decaying fast through the window: 0.9 mm/s down to nothing.
    const acc = new TrajectoryAccumulator();
    let x = 0;
    for (let t = 0.001; t <= 2; t += 0.001) {
      const v = t < 1.5 ? 0.0009 : 0.0009 * Math.exp(-(t - 1.5) / 0.03);
      x += v * 0.001;
      acc.add({ time: t, bodies: { b: { pos: [x, 0, 0], vel: [v, 0, 0], angvel: [0, 0, 0], quat: [1, 0, 0, 0] } } });
    }
    const s = acc.result()!;
    expect(s.bodies.b.creeping).toBeUndefined();
  });
});
