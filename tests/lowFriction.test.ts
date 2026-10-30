// Zero and near-zero sliding friction, which used to blow the model up.
//
// MuJoCo's pyramidal cone degenerates at mu = 0: a 1 kg box on a 20° ramp with
// friction [0, ...] was thrown 1.8 m up spinning at 115 rad/s, and a lever
// with mu 0.01 on its plank and stop launched its load hundreds of metres.
// Both runs came back looking complete. See src/utils/contactFriction.ts for
// the compile side and src/utils/solverWorkMonitor.ts for the report.

import { describe, it, expect } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import { createSolverWorkMonitor } from '../src/utils/solverWorkMonitor';
import type { SceneGraph, SceneNode } from '../src/types/scene';

const ramp = (friction: number[]): SceneGraph => ({
  nodes: [
    { id: 'ramp', name: 'ramp', pos: [0, 0, 0.8], euler: [0, 20, 0], static: true,
      geoms: [{ name: 'ramp_g', type: 'box', size: [1, 0.3, 0.02], friction }] },
    { id: 'block', name: 'block', pos: [0.023941, 0, 0.865778], euler: [0, 20, 0],
      joints: [{ name: 'block_free', type: 'free' }],
      geoms: [{ name: 'block_g', type: 'box', size: [0.05, 0.05, 0.05], mass: 1, friction }] },
  ] as SceneNode[],
});

/** A plank on a hinge, a 10 kg load on one end pressing the other up into a stop. */
const lever = (mu: number): SceneGraph => ({
  nodes: [
    { id: 'beam', name: 'beam', pos: [0, 0, 0.5], joints: [{ name: 'pivot', type: 'hinge', axis: [0, 1, 0] }],
      geoms: [{ name: 'plank', type: 'box', size: [0.75, 0.08, 0.02], mass: 1, friction: [mu, 0.005, 0.0001] }] },
    { id: 'load', name: 'load', pos: [-0.4, 0, 0.57], joints: [{ name: 'load_free', type: 'free' }],
      geoms: [{ name: 'load_g', type: 'box', size: [0.05, 0.05, 0.05], mass: 10 }] },
    { id: 'stop', name: 'stop', pos: [0.7, 0, 0.62], static: true,
      geoms: [{ name: 'stop_g', type: 'box', size: [0.01, 0.06, 0.1], friction: [mu, 0.005, 0.0001] }] },
  ] as SceneNode[],
});

const run = async (xml: string, ticks: number) => {
  const mj = await load_mujoco();
  const model = mj.MjModel.from_xml_string(xml);
  const data = new mj.MjData(model);
  const monitor = createSolverWorkMonitor(mj, model);
  const speeds: number[] = [];
  let peak = 0;
  try {
    for (let i = 0; i < ticks; i++) {
      monitor.before(data);
      mj.mj_step(model, data);
      monitor.after(data, 0.001);
      for (let k = 0; k < model.nv; k++) peak = Math.max(peak, Math.abs(data.qvel[k]));
      speeds.push(Math.hypot(data.qvel[0], data.qvel[1], data.qvel[2]));
    }
    return { speeds, peak, z: data.qpos[2], unstable: monitor.result() };
  } finally { data.delete(); model.delete(); }
};

describe('sliding friction at or near zero', () => {
  it('compiles to the elliptic cone and a slide of at least 0.001', () => {
    const xml = compileToMJCF(ramp([0, 0, 0]));
    expect(xml).toContain('cone="elliptic"');
    expect(xml).toMatch(/name="block_g"[^>]*friction="0.001 0 0"/);
  });

  it('leaves an ordinary scene on the pyramidal cone, friction as written', () => {
    const xml = compileToMJCF(ramp([0.5, 0.005, 0.0001]));
    expect(xml).not.toContain('cone=');
    expect(xml).toMatch(/name="block_g"[^>]*friction="0.5 0.005 0.0001"/);
  });

  it('counts the floor: floorFriction 0 is low friction too', () => {
    const xml = compileToMJCF({ nodes: [] }, -9.81, 0);
    expect(xml).toContain('cone="elliptic"');
    expect(xml).toMatch(/name="floor"[^>]*friction="0.001 /);
  });

  it('slides an icy block down a 20° ramp at g sin 20°, on the ramp', async () => {
    // Was: z 2.61 m (thrown 1.8 m up), peak 120 rad/s.
    const r = await run(compileToMJCF(ramp([0, 0.005, 0.0001])), 500);
    const a = (r.speeds[499] - r.speeds[199]) / 0.3;
    expect(a).toBeGreaterThan(9.81 * Math.sin((20 * Math.PI) / 180) * 0.97);
    expect(a).toBeLessThan(9.81 * Math.sin((20 * Math.PI) / 180) * 1.01);
    expect(r.z).toBeLessThan(0.866);
    expect(r.peak).toBeLessThan(2);
    expect(r.unstable).toBeNull();
  });

  it.each([0, 0.001, 0.01, 0.05])('holds a lever still against its stop at mu %s', async (mu) => {
    // Was: peak 17e6 (mu 0), 3657 (0.01), 412 (0.05); 13 rad/s kicks at exactly 0 in condim 1.
    const r = await run(compileToMJCF(lever(mu)), 5000);
    expect(r.peak).toBeLessThan(0.5);
    expect(r.unstable).toBeNull();
  });
});

describe('a run that blows up while staying finite', () => {
  it('is reported by the work its contacts did', async () => {
    // The old compile: mu 0 written verbatim, pyramidal cone.
    const xml = compileToMJCF(ramp([0.5, 0.005, 0.0001])).replace(/friction="0.5 /g, 'friction="0 ');
    const r = await run(xml, 500);
    expect(r.unstable).not.toBeNull();
    expect(r.unstable!.body).toBe('block');
    expect(r.unstable!.gainedJ).toBeGreaterThan(r.unstable!.limitJ);
  });

  it('is not reported for a block that slides and stops', async () => {
    const r = await run(compileToMJCF(ramp([0.3, 0.005, 0.0001])), 1500);
    expect(r.unstable).toBeNull();
  });
});
