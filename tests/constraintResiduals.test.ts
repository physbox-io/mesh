// A headless run has to say when a pin, weld, coupling or stop was not
// holding. A scissor lift whose loop-closing pins opened 23 mm folded 178 mm
// through the floor, and a 50 g slider ran 16 mm past its stop, and both runs
// came back settled with no warning.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { createConstraintMonitor } from '../src/utils/constraintResiduals';
import { compileToMJCF } from '../src/utils/mjcf';
import type { SceneGraph } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

/** Step `xml` for `ticks`, calling `load` before each step; return the monitor's report. */
const run = (xml: string, ticks: number, load: (model: any, data: any) => void = () => {}) => {
  const model = mj.MjModel.from_xml_string(xml);
  const data = new mj.MjData(model);
  try {
    const monitor = createConstraintMonitor(mj, model);
    for (let i = 0; i < ticks; i++) {
      load(model, data);
      mj.mj_step(model, data);
      monitor.sample(data);
    }
    return monitor.report(data);
  } finally {
    data.delete();
    model.delete();
  }
};

const rig = `<mujoco><option timestep="0.001"/><worldbody>
  <body name="arm" pos="0 0 1"><joint name="arm_hinge" type="hinge" axis="0 1 0"/>
    <geom type="capsule" fromto="0 0 0 0.3 0 0" size="0.01" mass="0.1"/></body>
  <body name="slider" pos="0 0.5 0.5"><joint name="slide" type="slide" axis="1 0 0" limited="true" range="-0.12 0.1"/>
    <geom type="box" size="0.01 0.01 0.01" mass="0.05"/></body>
  <body name="gear_a" pos="1 0 1"><joint name="ga" type="hinge" axis="0 0 1"/><geom type="cylinder" size="0.02 0.005" mass="0.05"/></body>
  <body name="gear_b" pos="1.1 0 1"><joint name="gb" type="hinge" axis="0 0 1"/><geom type="cylinder" size="0.02 0.005" mass="0.05"/></body>
</worldbody><equality>
  <connect name="connect_constraint_1" body1="arm" anchor="0.3 0 0"/>
  <joint name="gear_coupling_1" joint1="ga" joint2="gb" polycoef="0 -1 0 0 0"/>
</equality></mujoco>`;

describe('constraint residuals in a headless run', () => {
  it('says nothing about a rig that holds', () => {
    const r = run(rig, 500);
    expect(r.warnings).toEqual([]);
    expect(r.limits).toEqual([]);
    const pin = r.constraints.find((c) => c.name === 'connect_constraint_1')!;
    expect(pin.bodies).toEqual(['arm', 'world']);
    expect(pin.worstMm!).toBeLessThan(1);
  });

  it('names a pin pulled open, a coupling twisted, and a slider run through its stop', () => {
    const r = run(rig, 800, (model, data) => {
      // Pull the pinned arm's tip down hard; twist the two coupled gears the
      // same way, which the coupling says must turn opposite; shove the
      // slider into its lower stop.
      const x = data.xfrc_applied;
      x.fill(0);
      x[1 * 6 + 2] = -60;
      const q = data.qfrc_applied;
      q.fill(0);
      q[model.jnt_dofadr[2]] = 0.02;
      q[model.jnt_dofadr[3]] = 0.02;
      q[model.jnt_dofadr[1]] = -20;
    });
    const pin = r.constraints.find((c) => c.name === 'connect_constraint_1')!;
    expect(pin.worstMm!).toBeGreaterThan(1);
    const coupling = r.constraints.find((c) => c.name === 'gear_coupling_1')!;
    expect(coupling.kind).toBe('joint');
    expect(coupling.joints).toEqual(['ga', 'gb']);
    expect(coupling.bodies).toEqual(['gear_a', 'gear_b']);
    expect(coupling.worstDeg!).toBeGreaterThan(1);
    expect(coupling.worstMm).toBeUndefined();
    expect(r.limits).toHaveLength(1);
    expect(r.limits[0]).toMatchObject({ joint: 'slide', body: 'slider', unit: 'mm', range: [-120, 100] });
    expect(r.limits[0].worstPast).toBeGreaterThan(2);
    expect(r.warnings.some((w) => /Pin connect_constraint_1 between arm and world/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /Coupling gear_coupling_1 \(ga -> gb/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /Joint slide \(slider\) ran .* past its range \[-120, 100\] mm/.test(w))).toBe(true);
  });

  it('reads a weld\'s rotation in degrees and its offset in millimetres', () => {
    const xml = `<mujoco><option timestep="0.001"/><worldbody>
      <body name="post" pos="0 0 1"><geom type="box" size="0.01 0.01 0.01"/></body>
      <body name="knob" pos="0.1 0 1"><freejoint/><geom type="box" size="0.01 0.01 0.01" mass="0.02"/></body>
    </worldbody><equality><weld name="weld_constraint_1" body1="knob" body2="post"/></equality></mujoco>`;
    const r = run(xml, 500, (_m, data) => {
      const x = data.xfrc_applied;
      x.fill(0);
      x[2 * 6 + 5] = 0.05; // a hard twist about Z
    });
    const weld = r.constraints[0];
    expect(weld).toMatchObject({ name: 'weld_constraint_1', kind: 'weld', bodies: ['knob', 'post'] });
    expect(weld.worstDeg!).toBeGreaterThan(1);
    expect(typeof weld.worstMm).toBe('number');
    expect(r.warnings[0]).toMatch(/Weld weld_constraint_1 between knob and post .*°/);
  });

  it('does not count a heavy slider resting on its stop', () => {
    const xml = `<mujoco><option timestep="0.001"/><worldbody>
      <body name="carriage" pos="0 0 0.5"><joint name="lift" type="slide" axis="0 0 1" limited="true" range="0 0.2"/>
        <geom type="box" size="0.02 0.02 0.02" mass="2"/></body>
    </worldbody></mujoco>`;
    const r = run(xml, 1000);
    expect(r.limits).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('names the scene\'s own bodies in a compiled model', () => {
    const graph: SceneGraph = {
      nodes: [
        { id: 'p1', name: 'post', type: 'body', pos: [0, 0, 0.5], children: [], joints: [],
          geoms: [{ name: 'post_g', type: 'box', size: [0.01, 0.01, 0.01] } as any] },
        { id: 'b1', name: 'bob', type: 'body', pos: [0.2, 0, 0.5], children: [],
          joints: [{ name: 'bob_free', type: 'free' } as any],
          geoms: [{ name: 'bob_g', type: 'sphere', size: [0.01], mass: 0.05 } as any],
          connectTargetId: 'p1', connectAnchor: [0, 0, 0.5] } as any,
      ],
    };
    const xml = compileToMJCF(graph, -9.81, 1, 0, 0, 1.2, 0);
    const r = run(xml, 500, (model, data) => {
      const bob = mj.mj_name2id(model, mj.mjtObj.mjOBJ_BODY.value, 'bob');
      data.xfrc_applied.fill(0);
      data.xfrc_applied[bob * 6 + 2] = -30;
    });
    const pin = r.constraints.find((c) => c.kind === 'connect')!;
    expect(pin.name).toMatch(/^connect_constraint_/);
    expect(pin.bodies).toEqual(['bob', 'post']);
    expect(r.warnings.some((w) => /between bob and post/.test(w))).toBe(true);
  });
});
