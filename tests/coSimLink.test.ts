import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import { PRESETS } from '../src/presets/presetScenes';
import type { SceneGraph, SceneNode } from '../src/types/scene';
import {
  applyCtrlInputs, applyJointForces, channelCatalogue, envelope, isCoSimMessage, readOutputs, resolveInputs,
  setJointParams, stepsFor, substepsFor,
} from '../src/utils/coSimLink';

/**
 * The co-simulation link's channels against real MuJoCo models: what a
 * linked Volt can bind, and that driving a joint through it obeys Newton.
 *
 * The step loop here is the worker's `stepFor` reduced to what matters for a
 * joint force: add the link's armature and damping, sub-step a stiff law,
 * and each step clear `qfrc_applied`, add the link's forces, step.
 */

type Mujoco = Awaited<ReturnType<typeof load_mujoco>>;
let mj: Mujoco;
beforeAll(async () => {
  mj = await load_mujoco();
});

/** A cylinder on a vertical hinge, no gravity: I about the axis = m·r²/2. */
const flywheel = (mass: number, radius: number, timestep = 0.001, damping = 0) => `
<mujoco>
  <option timestep="${timestep}" gravity="0 0 0" integrator="implicitfast"/>
  <worldbody>
    <body name="wheel">
      <joint name="spin" type="hinge" axis="0 0 1" damping="${damping}"/>
      <geom type="cylinder" size="${radius} 0.01" mass="${mass}" contype="0" conaffinity="0"/>
    </body>
    <body name="carriage" pos="1 0 0">
      <joint name="rail" type="slide" axis="1 0 0"/>
      <geom type="box" size="0.05 0.05 0.05" mass="2" contype="0" conaffinity="0"/>
    </body>
  </worldbody>
  <actuator>
    <motor name="drive" joint="spin" gear="1" ctrllimited="false"/>
  </actuator>
</mujoco>`;

type Run = { t: number; n: number; sub: number; unknown: string[]; outputs: Record<string, number>; trace: number[] };

/** One STEP_FOR, as the worker does it, on a fresh model or a carried one. */
function step(
  model: InstanceType<Mujoco['MjModel']>, data: InstanceType<Mujoco['MjData']>,
  inputs: Record<string, number>, dtMs: number, outputs: string[], opts: { noSubsteps?: boolean; trace?: string } = {},
): Run {
  const { resolved, unknown } = resolveInputs(mj, model, inputs);
  applyCtrlInputs(data, resolved);
  setJointParams(mj, model, data, resolved);
  const ts = model.opt.timestep;
  const base = stepsFor(dtMs, ts);
  const sub = opts.noSubsteps || base === 0 ? 1 : substepsFor(model, data, resolved, ts);
  if (base > 0) model.opt.timestep = dtMs / 1000 / (base * sub);
  const trace: number[] = [];
  for (let i = 0; i < base * sub; i++) {
    data.qfrc_applied.fill(0);
    applyJointForces(data, resolved);
    mj.mj_step(model, data);
    if (opts.trace) trace.push(readOutputs(mj, model, data, [opts.trace]).outputs[opts.trace]);
  }
  model.opt.timestep = ts;
  const read = readOutputs(mj, model, data, outputs);
  return { t: data.time, n: base * sub, sub, unknown: [...unknown, ...read.unknown], outputs: read.outputs, trace };
}

function run(xml: string, inputs: Record<string, number>, dtMs: number, outputs: string[], opts: { noSubsteps?: boolean; trace?: string } = {}) {
  const model = mj.MjModel.from_xml_string(xml);
  const data = new mj.MjData(model);
  const r = step(model, data, inputs, dtMs, outputs, opts);
  data.delete();
  model.delete();
  return r;
}

describe('a joint driven through the link', () => {
  for (const { mass, radius, torque, ms } of [
    { mass: 1, radius: 0.1, torque: 0.01, ms: 200 },
    { mass: 0.2, radius: 0.05, torque: 0.002, ms: 50 },
    { mass: 5, radius: 0.3, torque: 1.5, ms: 500 },
  ]) {
    const inertia = (mass * radius * radius) / 2;
    it(`spins up at τ/I: ${torque}N·m on ${mass}kg × ${radius}m, for ${ms}ms`, () => {
      const r = run(flywheel(mass, radius), { 'joint:spin.force': torque }, ms, ['joint:spin.vel', 'joint:spin.pos']);
      const t = ms / 1000;
      expect(r.t).toBeCloseTo(t, 9);
      expect(r.outputs['joint:spin.vel'] / ((torque * t) / inertia)).toBeCloseTo(1, 2);
      expect(r.outputs['joint:spin.pos'] / ((0.5 * torque * t * t) / inertia)).toBeCloseTo(1, 1);
    });

    it(`does the same through an unlimited motor actuator: ${torque}N·m on ${mass}kg`, () => {
      const r = run(flywheel(mass, radius), { 'actuator:drive': torque }, ms, ['joint:spin.vel', 'actuator:drive.force']);
      expect(r.outputs['actuator:drive.force']).toBeCloseTo(torque, 9);
      expect(r.outputs['joint:spin.vel'] / ((torque * ms) / 1000 / inertia)).toBeCloseTo(1, 2);
    });
  }

  it('pushes a slide joint at F/m', () => {
    const r = run(flywheel(1, 0.1), { 'joint:rail.force': 4 }, 100, ['joint:rail.vel', 'body:carriage.x']);
    expect(r.outputs['joint:rail.vel']).toBeCloseTo((4 * 0.1) / 2, 3);
    expect(r.outputs['body:carriage.x']).toBeCloseTo(1 + 0.5 * 2 * 0.01, 3);
  });

  it('advances time by exactly the slice, whatever the timestep divides into, and not at all for a read', () => {
    for (const [ts, dt] of [[0.001, 5], [0.002, 5], [0.0005, 1], [0.004, 1], [0.003, 10]] as const) {
      const r = run(flywheel(1, 0.1, ts), {}, dt, []);
      expect(r.n).toBe(Math.ceil(dt / 1000 / ts - 1e-9));
      expect(r.t).toBeCloseTo(dt / 1000, 12);
    }
    // Sub-stepped, too: the slice is the same length in finer steps.
    const stiff = run(flywheel(0.01, 0.02, 0.002), { 'joint:spin.force.sin(50)': -2 }, 10, []);
    expect(stiff.sub).toBeGreaterThan(1);
    expect(stiff.t).toBeCloseTo(0.01, 12);
    expect(run(flywheel(1, 0.1), { 'joint:spin.force': 1 }, 0, []).t).toBe(0);
  });

  for (const { mass, radius, damping } of [{ mass: 1, radius: 0.1, damping: 0.01 }, { mass: 3, radius: 0.2, damping: 0.2 }]) {
    it(`reports the joint's inertia, and the load on it less what the link applied: ${mass}kg, damping ${damping}`, () => {
      const r = run(flywheel(mass, radius, 0.001, damping), { 'joint:spin.force': 0.5 }, 100, ['joint:spin.inertia', 'joint:spin.load', 'joint:spin.vel']);
      expect(r.outputs['joint:spin.inertia'] / ((mass * radius * radius) / 2)).toBeCloseTo(1, 3);
      // Damping is the only other thing on it: −d·ω, at the start of the last
      // step, so one step's speed-up (~1% here) behind the speed read after it.
      expect(r.outputs['joint:spin.load'] / (-damping * r.outputs['joint:spin.vel'])).toBeCloseTo(1, 1);
    });
  }

  it('names the inputs and outputs it has no channel for, rather than dropping them', () => {
    const r = run(flywheel(1, 0.1), { 'joint:nope.force': 1, 'actuator:drive.force': 1, 'banana': 2 }, 5, ['joint:spin.vel', 'joint:nope.pos', 'body:world.x']);
    expect(r.unknown.sort()).toEqual(['actuator:drive.force', 'banana', 'body:world.x', 'joint:nope.force', 'joint:nope.pos'].sort());
    const bad = run(flywheel(1, 0.1), { 'joint:spin.force.sin(x)': 1, 'joint:spin.force.tan(2)': 1 }, 5, []);
    expect(bad.unknown.sort()).toEqual(['joint:spin.force.sin(x)', 'joint:spin.force.tan(2)']);
  });
});

describe('a force that varies with the joint\'s position', () => {
  // A stepper held on one phase: τ = −K·sin(N·q), a spring of stiffness K·N
  // about q = 0, here at a few hundred hertz on a light rotor.
  for (const { K, N, mass, radius, armature } of [
    { K: 0.235, N: 50, mass: 0.02, radius: 0.02, armature: 5.4e-6 },
    { K: 0.4, N: 50, mass: 0.05, radius: 0.03, armature: 0 },
    { K: 2, N: 10, mass: 1, radius: 0.1, armature: 1e-3 },
  ]) {
    const inertia = (mass * radius * radius) / 2 + armature;
    const f = Math.sqrt((K * N) / inertia) / (2 * Math.PI);
    it(`rings at √(K·N/I)/2π = ${f.toFixed(0)}Hz and holds its energy, at a 2ms scene timestep: K=${K}, N=${N}`, () => {
      const xml = flywheel(mass, radius, 0.002);
      const model = mj.MjModel.from_xml_string(xml);
      const data = new mj.MjData(model);
      data.qpos[0] = 0.2 / N; // a fifth of the way to the next tooth: small enough to be linear
      const inputs = { 'joint:spin.force.sin(50)': 0, [`joint:spin.force.sin(${N})`]: -K, 'joint:spin.armature': armature };
      const pos: number[] = [];
      const t: number[] = [];
      const slices = Math.max(40, Math.ceil(5 / f / 0.005));
      for (let k = 0; k < slices; k++) {
        const r = step(model, data, inputs, 5, [], { trace: 'joint:spin.pos' });
        const dt = 0.005 / r.trace.length;
        r.trace.forEach((q, i) => { pos.push(q); t.push(k * 0.005 + (i + 1) * dt); });
      }
      // Period from upward zero crossings.
      const ups: number[] = [];
      for (let i = 1; i < pos.length; i++) if (pos[i - 1] < 0 && pos[i] >= 0) ups.push(t[i - 1] + (t[i] - t[i - 1]) * (-pos[i - 1] / (pos[i] - pos[i - 1])));
      expect(ups.length, `crossings; peak ${Math.max(...pos.map(Math.abs))}`).toBeGreaterThan(3);
      const period = (ups[ups.length - 1] - ups[0]) / (ups.length - 1);
      expect(period * f, `period ${period}, ${ups.length} crossings over ${t[t.length - 1]}s`).toBeGreaterThan(0);
      // sin(N·q) ≈ N·q to 0.7% at this amplitude, which lengthens the period about as much.
      expect(Math.abs(period * f - 1)).toBeLessThan(0.02);
      const peak = Math.max(...pos.slice(-pos.length / 4).map(Math.abs));
      expect(peak).toBeLessThan(0.2 / N * 1.05);
      expect(peak).toBeGreaterThan(0.2 / N * 0.9);
      data.delete();
      model.delete();
    });
  }

  it('keeps the scene where it was when the armature changes', () => {
    const model = mj.MjModel.from_xml_string(flywheel(1, 0.1, 0.001));
    const data = new mj.MjData(model);
    step(model, data, { 'joint:spin.force': 0.5 }, 50, []);
    const [q, v, t] = [data.qpos[0], data.qvel[0], data.time];
    step(model, data, { 'joint:spin.armature': 0.01 }, 0, []);
    expect([data.qpos[0], data.qvel[0], data.time]).toEqual([q, v, t]);
    data.delete();
    model.delete();
  });

  it('would blow up at the scene timestep without the sub-steps', () => {
    const model = mj.MjModel.from_xml_string(flywheel(0.02, 0.02, 0.002));
    const data = new mj.MjData(model);
    data.qpos[0] = 0.004;
    for (let k = 0; k < 40; k++) step(model, data, { 'joint:spin.force.sin(50)': -0.235 }, 5, [], { noSubsteps: true });
    expect(Math.abs(data.qpos[0]) > 0.04 || !Number.isFinite(data.qpos[0])).toBe(true);
    data.delete();
    model.delete();
  });

  it('applies a cos law and a sin law together as their sum', () => {
    const model = mj.MjModel.from_xml_string(flywheel(1, 0.1, 0.001));
    const data = new mj.MjData(model);
    data.qpos[0] = 0.3;
    const r = step(model, data, { 'joint:spin.force.cos(2)': 0.5, 'joint:spin.force.sin(3)': 0.25, 'joint:spin.force': 0.1 }, 1, ['joint:spin.vel']);
    const torque = 0.5 * Math.cos(0.6) + 0.25 * Math.sin(0.9) + 0.1;
    expect(r.outputs['joint:spin.vel'] / ((torque * 0.001) / 0.005)).toBeCloseTo(1, 2);
    data.delete();
    model.delete();
  });

  it('adds armature and damping while they are named, and takes them off after', () => {
    const model = mj.MjModel.from_xml_string(flywheel(1, 0.1, 0.001, 0.002));
    const data = new mj.MjData(model);
    const r = step(model, data, { 'joint:spin.force': 0.01, 'joint:spin.armature': 0.005 }, 100, ['joint:spin.vel', 'joint:spin.inertia']);
    // I = 0.005 (body) + 0.005 (armature)
    expect(r.outputs['joint:spin.inertia']).toBeCloseTo(0.01, 9);
    expect(r.outputs['joint:spin.vel'] / ((0.01 * 0.1) / 0.01)).toBeCloseTo(1, 1);
    const d = step(model, data, { 'joint:spin.damping': 0.05 }, 100, ['joint:spin.vel', 'joint:spin.inertia']);
    expect(d.outputs['joint:spin.vel']).toBeLessThan(r.outputs['joint:spin.vel']);
    expect(d.outputs['joint:spin.inertia']).toBeCloseTo(0.005, 9);
    expect(model.dof_damping[0]).toBeCloseTo(0.052, 12);
    step(model, data, {}, 0, []);
    expect(model.dof_armature[0]).toBe(0);
    expect(model.dof_damping[0]).toBeCloseTo(0.002, 12);
    data.delete();
    model.delete();
  });
});

describe('the channel catalogue', () => {
  const walk = (nodes: SceneNode[], fn: (n: SceneNode) => void) => {
    for (const n of nodes) { fn(n); walk(n.children ?? [], fn); }
  };

  const withActuators = Object.entries(PRESETS)
    .filter(([, p]) => {
      let any = false;
      if (p.scene) walk((p.scene as SceneGraph).nodes, n => n.joints?.forEach(j => { if (j.actuator) any = true; }));
      return any;
    })
    .slice(0, 6);

  it('has presets with actuators to check', () => expect(withActuators.length).toBeGreaterThan(0));

  for (const [key, preset] of withActuators) {
    it(`${key}: lists every hinge and slide joint, every actuator and every body`, () => {
      const xml = compileToMJCF(preset.scene as SceneGraph, -9.81, 1, 0, 0, 0, 0);
      const model = mj.MjModel.from_xml_string(xml);
      const names = new Set(channelCatalogue(mj, model).map(c => c.name));
      for (let id = 0; id < model.njnt; id++) {
        if (model.jnt_type[id] < 2) continue;
        const name = mj.mj_id2name(model, mj.mjtObj.mjOBJ_JOINT.value, id);
        for (const field of ['force', 'force.cos(w)', 'force.sin(w)', 'armature', 'damping', 'pos', 'vel', 'inertia', 'load']) expect(names, `${name}.${field}`).toContain(`joint:${name}.${field}`);
      }
      for (let id = 0; id < model.nu; id++) {
        const name = mj.mj_id2name(model, mj.mjtObj.mjOBJ_ACTUATOR.value, id);
        expect(names).toContain(`actuator:${name}`);
      }
      for (let id = 1; id < model.nbody; id++) {
        const name = mj.mj_id2name(model, mj.mjtObj.mjOBJ_BODY.value, id);
        if (name) expect(names).toContain(`body:${name}.contacts`);
      }
      model.delete();
    });
  }
});

describe('a body resting on the floor', () => {
  it('counts its contacts, and none once lifted clear', () => {
    const xml = (z: number) => `
<mujoco>
  <worldbody>
    <geom name="floor" type="plane" size="1 1 0.1"/>
    <body name="block" pos="0 0 ${z}"><freejoint/><geom type="box" size="0.05 0.05 0.05" mass="1"/></body>
  </worldbody>
</mujoco>`;
    expect(run(xml(0.05), {}, 50, ['body:block.contacts']).outputs['body:block.contacts']).toBeGreaterThan(0);
    expect(run(xml(0.5), {}, 5, ['body:block.contacts']).outputs['body:block.contacts']).toBe(0);
  });
});

describe('the envelope', () => {
  it('accepts its own messages and nothing else', () => {
    expect(isCoSimMessage(envelope({ type: 'HELLO' }))).toBe(true);
    expect(isCoSimMessage({ type: 'HELLO' })).toBe(false);
    expect(isCoSimMessage({ ...envelope({ type: 'HELLO' }), v: 99 })).toBe(false);
    expect(isCoSimMessage('HELLO')).toBe(false);
  });
});
