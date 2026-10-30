// A stiff velocity servo on a coupled joint. A 10 g pinion (r 10 mm) at kv 1
// (kv*dt/I = 2000) swung the 50 g gear it drives between -773 and +741 rad/s
// in its first 12 ms, and the warning blamed the load and the masses. And the
// builder's own gear_pair warned "pulled 3.46 mm apart, not holding" with no
// load at all: a hinge coupling's error, in radians, printed as metres.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import { buildMechanism } from '../src/utils/buildMechanism';
import { createConstraintMonitor } from '../src/utils/constraintResiduals';
import { RIGID_COUPLING } from '../src/utils/jointCoupling';
import type { SceneNode } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

const gear = (id: string, r: number, mass: number, x: number, drive = false): SceneNode => ({
  id, name: id, type: 'body', pos: [x, 0, 0.1], children: [],
  joints: [{ name: `${id}_h`, type: 'hinge', axis: [0, 0, 1], ...(drive ? { actuator: { type: 'velocity', kv: 1, ctrlValue: 3 } } : {}) }],
  geoms: [{ name: `${id}_g`, type: 'cylinder', size: [r, 0.004], mass, contype: 0, conaffinity: 0 }],
});

/** Run `xml` with every ctrl at 3: the driven joint's speed range over the first `early` steps, and the residual report. */
const run = (xml: string, steps: number, watch: string, early = 50) => {
  const m = mj.MjModel.from_xml_string(xml);
  const d = new mj.MjData(m);
  try {
    const mon = createConstraintMonitor(mj, m);
    for (let i = 0; i < m.nu; i++) d.ctrl[i] = 3;
    const dof = m.jnt_dofadr[mj.mj_name2id(m, mj.mjtObj.mjOBJ_JOINT.value, watch)];
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < steps; i++) {
      mj.mj_step(m, d);
      mon.sample(d);
      if (i < early) { lo = Math.min(lo, d.qvel[dof]); hi = Math.max(hi, d.qvel[dof]); }
    }
    return { lo, hi, final: d.qvel[dof] as number, report: mon.report(d) };
  } finally { d.delete(); m.delete(); }
};

describe('a stiff servo on a coupled joint', () => {
  it('drives it through a clutch, and the driven gear does not whip', () => {
    const xml = compileToMJCF({ nodes: [gear('gear_c1', 0.01, 0.01, 0, true), gear('gear_c2', 0.03, 0.05, 0.04)] }, -9.81, 1, 0, 0, 0);
    expect(xml).toContain('joint="gear_c1_h__drive"');
    const r = run(xml, 1000, 'gear_c2_h');
    // Was -773 to +872 rad/s.
    expect(r.lo).toBeGreaterThan(-1.05);
    expect(r.hi).toBeLessThan(0);
    expect(r.final).toBeCloseTo(-1, 3);
    expect(r.report.warnings).toEqual([]);
  });

  it('blames the servo, by its stiffness, when a model drives a coupled joint with one directly', () => {
    const xml = `<mujoco><option integrator="implicitfast" timestep="0.001"/><worldbody>
      <body name="c1" pos="0 0 0.1"><joint name="c1_h" type="hinge" axis="0 0 1"/><geom type="cylinder" size="0.01 0.004" mass="0.01" contype="0" conaffinity="0"/></body>
      <body name="c2" pos="0.04 0 0.1"><joint name="c2_h" type="hinge" axis="0 0 1"/><geom type="cylinder" size="0.03 0.004" mass="0.05" contype="0" conaffinity="0"/></body>
    </worldbody><actuator><velocity name="c1_h_actuator" joint="c1_h" kv="1"/></actuator>
    <tendon><fixed name="gear_coupling_1"><joint joint="c1_h" coef="1"/><joint joint="c2_h" coef="3"/></fixed></tendon>
    <equality><tendon name="gear_coupling_1" tendon1="gear_coupling_1" polycoef="0 0 0 0 0" ${RIGID_COUPLING}/></equality></mujoco>`;
    const r = run(xml, 200, 'c2_h');
    expect(r.hi - r.lo).toBeGreaterThan(100);
    const w = r.report.warnings.find((s) => s.includes('gear_coupling_1'))!;
    expect(w).toMatch(/Coupling gear_coupling_1 \(c1_h -> c2_h, on c1 and c2\) was pulled [\d.]+° out/);
    expect(w).toMatch(/c1_h_actuator drives c1_h .*kv\*timestep\/inertia = 2000/);
    expect(w).not.toMatch(/too little mass/);
  });

  it("the builder's gear_pair is measured in degrees, holds, and says nothing", () => {
    const b = buildMechanism({ family: 'gear_pair', idPrefix: 'gp' }, []);
    if ('error' in b) throw new Error(b.error);
    const r = run(compileToMJCF({ nodes: b.nodes }, -9.81, 1, 0, 0, 0), 2000, b.nodes[1].joints[0].name);
    const c = r.report.constraints.find((x) => x.name === 'explicit_coupling_1')!;
    expect(c.joints).toHaveLength(2);
    expect(c.worstMm).toBeUndefined();
    expect(c.worstDeg!).toBeLessThan(1);
    expect(r.report.warnings).toEqual([]);
  });
});
