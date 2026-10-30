// What each pin, weld and coupling carries, from the solver's efc_force on the
// rows the residuals already read. See src/utils/constraintResiduals.ts.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { createConstraintMonitor } from '../src/utils/constraintResiduals';

type Mujoco = Awaited<ReturnType<typeof load_mujoco>>;
let mj: Mujoco;
beforeAll(async () => { mj = await load_mujoco(); });

const G = 9.81;

const report = (xml: string, steps = 2000) => {
  const model = mj.MjModel.from_xml_string(xml);
  const data = new mj.MjData(model);
  try {
    const mon = createConstraintMonitor(mj, model);
    for (let i = 0; i < steps; i++) { mj.mj_step(model, data); mon.sample(data); }
    return mon.report(data);
  } finally { data.delete(); model.delete(); }
};

describe('constraint forces', () => {
  it('a pin carries the weight hung on it', () => {
    const r = report(`<mujoco><option timestep="0.001"/><worldbody>
      <body name="bob" pos="0 0 0.5"><freejoint/><geom type="sphere" size="0.02" mass="0.2"/></body>
    </worldbody><equality><connect name="pin" body1="bob" anchor="0 0 0"/></equality></mujoco>`);
    const pin = r.constraints.find((c) => c.name === 'pin')!;
    expect(pin.forceUnit).toBe('N');
    expect(pin.finalForce!).toBeCloseTo(0.2 * G, 2);
  });

  it("a weld carries a cantilever's weight at its anchor", () => {
    // 0.1 kg, its centre 0.1 m out from the weld: 0.981 N.
    const r = report(`<mujoco><option timestep="0.001"/><worldbody>
      <body name="beam" pos="0 0 0.5"><freejoint/><geom type="box" size="0.1 0.02 0.02" pos="0.1 0 0" mass="0.1"/></body>
    </worldbody><equality><weld name="w" body1="beam"/></equality></mujoco>`);
    const w = r.constraints.find((c) => c.name === 'w')!;
    expect(w.finalForce!).toBeCloseTo(0.1 * G, 1);
    expect(w.peakForce!).toBeGreaterThanOrEqual(w.finalForce!);
  });

  it("a rope coupling reports the rope's tension", () => {
    // An Atwood machine: 0.3 kg and 0.1 kg on slides, tied by a fixed tendon held at length 0.
    const r = report(`<mujoco><option timestep="0.001"/><worldbody>
      <body name="a" pos="0 0 1"><joint name="ja" type="slide" axis="0 0 1"/><geom type="sphere" size="0.02" mass="0.3" contype="0" conaffinity="0"/></body>
      <body name="b" pos="0.2 0 1"><joint name="jb" type="slide" axis="0 0 1"/><geom type="sphere" size="0.02" mass="0.1" contype="0" conaffinity="0"/></body>
    </worldbody>
    <tendon><fixed name="rope"><joint joint="ja" coef="1"/><joint joint="jb" coef="1"/></fixed></tendon>
    <equality><tendon name="rope_eq" tendon1="rope"/></equality></mujoco>`, 300);
    const rope = r.constraints.find((c) => c.name === 'rope_eq')!;
    expect(rope.kind).toBe('tendon');
    expect(rope.forceUnit).toBe('N');
    expect(rope.finalForce!).toBeCloseTo((2 * 0.3 * 0.1 * G) / 0.4, 2);
  });
});
