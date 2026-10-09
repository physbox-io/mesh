import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import { PRESETS } from '../src/presets/presetScenes';
import type { SceneGraph, SceneNode } from '../src/types/scene';
import {
  applyCtrlInputs, applyJointForces, channelCatalogue, envelope, isCoSimMessage, readOutputs, resolveInputs, stepsFor,
} from '../src/utils/coSimLink';

/**
 * The co-simulation link's channels against real MuJoCo models: what a
 * linked Volt can bind, and that driving a joint through it obeys Newton.
 *
 * The step loop here is the worker's `stepOnce` reduced to what matters for
 * a joint force: clear `qfrc_applied`, add the link's forces, step.
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

function run(xml: string, inputs: Record<string, number>, dtMs: number, outputs: string[]) {
  const model = mj.MjModel.from_xml_string(xml);
  const data = new mj.MjData(model);
  const { resolved, unknown } = resolveInputs(mj, model, inputs);
  applyCtrlInputs(data, resolved);
  const n = stepsFor(dtMs, model.opt.timestep);
  for (let i = 0; i < n; i++) {
    data.qfrc_applied.fill(0);
    applyJointForces(data, resolved);
    mj.mj_step(model, data);
  }
  const read = readOutputs(mj, model, data, outputs);
  const result = { t: data.time, n, unknown: [...unknown, ...read.unknown], outputs: read.outputs };
  data.delete();
  model.delete();
  return result;
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
    for (const [ts, dt] of [[0.001, 5], [0.002, 5], [0.0005, 1], [0.004, 1]] as const) {
      const r = run(flywheel(1, 0.1, ts), {}, dt, []);
      expect(r.n).toBe(Math.max(1, Math.round(dt / 1000 / ts)));
      expect(r.t).toBeCloseTo(r.n * ts, 12);
    }
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
        for (const field of ['force', 'pos', 'vel', 'inertia', 'load']) expect(names, `${name}.${field}`).toContain(`joint:${name}.${field}`);
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
