// physics_run_headless's `final` does not depend on the stride: the worker
// feeds TrajectoryAccumulator every tick through headlessLoop's `observe`.
// Repro: a cylinder rolling down a 28° ramp for 500 ticks said turnedDeg 438.9
// at stride 50 and 78.9 at stride 500.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { headlessLoop } from '../src/store/physicsWorkerClient';
import { TrajectoryAccumulator, summarizeTrajectory, type TrajectorySummary } from '../src/utils/trajectorySummary';
import { reportHeadless } from '../src/utils/headlessReport';
import { bodyAngularVelocity, bodyPointVelocity, syncKinematics } from '../src/workers/bodyKinematics';
import type { HistoryEntry } from '../src/workers/physicsWorkerProtocol';
import type { SceneGraph } from '../src/types/scene';

type Mujoco = Awaited<ReturnType<typeof load_mujoco>>;
let mj: Mujoco;

const A = (28 * Math.PI) / 180;
// The ramp tilted about y; the roller's axis along y, so it rolls down -x.
const XML = `<mujoco>
  <option timestep="0.001"/>
  <worldbody>
    <body name="ramp" euler="0 ${28} 0"><geom type="box" size="1 0.2 0.01" friction="1 0.005 0.0001"/></body>
    <body name="roller" pos="${0.3 * Math.cos(A) - 0.0} 0 ${-0.3 * Math.sin(A) + 0.04}" euler="90 0 0">
      <freejoint name="roller_free"/><geom type="cylinder" size="0.02 0.03" mass="0.1"/>
    </body>
  </worldbody>
</mujoco>`;

beforeAll(async () => { mj = await load_mujoco(); });

/** The worker's flow in miniature: step + sync, observe every tick, keep every `stride`th. */
function run(ticks: number, stride: number) {
  const model = mj.MjModel.from_xml_string(XML);
  const data = new mj.MjData(model);
  const b = mj.mj_name2id(model, mj.mjtObj.mjOBJ_BODY.value, 'roller');
  try {
    mj.mj_forward(model, data);
    const frame = (): HistoryEntry => {
      const views = { cvel: data.cvel, xpos: data.xpos, subtreeCom: data.subtree_com, rootId: model.body_rootid };
      const q = data.xquat;
      return {
        time: data.time,
        bodies: { roller: {
          pos: [data.xpos[b * 3], data.xpos[b * 3 + 1], data.xpos[b * 3 + 2]],
          vel: bodyPointVelocity(views, b), angvel: bodyAngularVelocity(views, b),
          quat: [q[b * 4], q[b * 4 + 1], q[b * 4 + 2], q[b * 4 + 3]], xfrc_applied: [0, 0, 0, 0, 0, 0],
        } },
        joints: {}, contacts: [], aeroDiagnostics: {},
      };
    };
    const acc = new TrajectoryAccumulator();
    let jointTurn = 0;
    const loop = headlessLoop<HistoryEntry>({ ticks, stride }, {
      step: () => { mj.mj_step(model, data); syncKinematics(mj, model, data); },
      time: () => data.time,
      isBad: () => false,
      observe: () => {
        acc.add(frame());
        const w = data.qvel;
        jointTurn += Math.hypot(w[3], w[4], w[5]) * 0.001 * 180 / Math.PI;
      },
      sample: frame,
    });
    let r = loop.next();
    while (!r.done) r = loop.next();
    return { frames: r.value.frames, summary: acc.result()!, jointTurn };
  } finally { data.delete(); model.delete(); }
}

describe('final is judged every tick', () => {
  it('gives the same turn at stride 50 and stride 500, and the joint agrees', () => {
    const a = run(500, 50);
    const b = run(500, 500);
    const ta = a.summary.bodies.roller.turnedDeg;
    const tb = b.summary.bodies.roller.turnedDeg;
    expect(ta).toBe(tb);
    expect(ta).toBeGreaterThan(100);
    expect(Math.abs(ta - a.jointTurn)).toBeLessThan(0.02 * a.jointTurn);
    // Judged on the kept frames alone, stride 500 aliases badly.
    const strided = summarizeTrajectory(b.frames)!.bodies.roller.turnedDeg;
    expect(strided).toBeLessThan(0.5 * ta);
  });

  it('reportHeadless prefers the per-tick summary to the kept frames', () => {
    const b = run(500, 500);
    const graph = { nodes: [{ id: 'roller', name: 'roller', type: 'body', children: [] }] } as unknown as SceneGraph;
    const reply = reportHeadless({ ok: true, trajectory: b.frames, summary: b.summary, warnings: [] }, graph, undefined);
    expect((reply.final as TrajectorySummary).bodies.roller.turnedDeg).toBe(b.summary.bodies.roller.turnedDeg);
    expect(reply).not.toHaveProperty('summary');
  });

  it('include leaves sections out of the frames', () => {
    const b = run(100, 10);
    const graph = { nodes: [{ id: 'roller', name: 'roller', type: 'body', children: [] }] } as unknown as SceneGraph;
    const reply = reportHeadless({ ok: true, trajectory: b.frames, summary: b.summary, warnings: [] }, graph, undefined, ['bodies']);
    const fr = reply.trajectory![0];
    expect(fr.bodies.roller).toBeDefined();
    expect(fr).not.toHaveProperty('contacts');
    expect(fr).not.toHaveProperty('joints');
  });
});
