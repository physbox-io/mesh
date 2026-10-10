import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import { PRESETS } from '../src/presets/presetScenes';
import type { SceneGraph } from '../src/types/scene';
import { applyJointForces, channelCatalogue, readOutputs, resolveInputs, setJointParams } from '../src/utils/coSimLink';

/**
 * The scenes Volt's linked presets drive: they expose the joints Volt binds
 * to, and the gripper does what the Volt preset's note card says — sweeps
 * shut past its limit-switch angle when nothing is in the way, and stalls on
 * the block when it is.
 */

type Mujoco = Awaited<ReturnType<typeof load_mujoco>>;
let mj: Mujoco;
beforeAll(async () => {
  mj = await load_mujoco();
});

const build = (scene: SceneGraph) => {
  const model = mj.MjModel.from_xml_string(compileToMJCF(scene, -9.81, 1, 0, 0, 0, 0));
  return { model, data: new mj.MjData(model) };
};

describe('the Volt scenes', () => {
  it('expose the joints the Volt presets bind to', () => {
    for (const [key, joint] of [['volt_gripper', 'jaw_hinge'], ['volt_stepper_dial', 'stepper_shaft']] as const) {
      const { model, data } = build(PRESETS[key].scene as SceneGraph);
      const names = channelCatalogue(mj, model).map(c => c.name);
      for (const ch of ['force', 'force.cos(w)', 'armature', 'damping', 'pos', 'vel']) expect(names).toContain(`joint:${joint}.${ch}`);
      data.delete();
      model.delete();
    }
  });

  /**
   * The gearmotor of Volt's gripper preset, held at its stall torque (0.6N·m
   * at the gearbox output), its rotor reflected as 1e-3 kg·m² of armature.
   */
  const drive = (scene: SceneGraph, seconds: number) => {
    const { model, data } = build(scene);
    const inputs = { 'joint:jaw_hinge.force': 0.6, 'joint:jaw_hinge.armature': 1e-3, 'joint:jaw_hinge.damping': 1e-3 };
    const { resolved } = resolveInputs(mj, model, inputs);
    setJointParams(mj, model, data, resolved);
    const n = Math.round(seconds / model.opt.timestep);
    for (let i = 0; i < n; i++) {
      data.qfrc_applied.fill(0);
      applyJointForces(data, resolved);
      mj.mj_step(model, data);
    }
    const out = readOutputs(mj, model, data, ['joint:jaw_hinge.pos', 'joint:jaw_hinge.vel', 'body:jaw.contacts']).outputs;
    data.delete();
    model.delete();
    return out;
  };

  it('lets the open jaw sweep past the limit-switch angle to its stop', () => {
    const out = drive(PRESETS.volt_gripper.scene as SceneGraph, 0.5);
    expect(out['joint:jaw_hinge.pos']).toBeGreaterThan(1.15);
    // The joint's 80° limit.
    expect(out['joint:jaw_hinge.pos']).toBeLessThan((80 / 180) * Math.PI + 0.02);
  });

  it('stalls the jaw on the block, short of the switch, when the block is in its path', () => {
    const scene = structuredClone(PRESETS.volt_gripper.scene) as SceneGraph;
    const block = scene.nodes.find(n => n.id === 'grip_block')!;
    block.pos = [0.055, 0.045, 0.035];
    const out = drive(scene, 0.5);
    expect(out['joint:jaw_hinge.pos']).toBeLessThan(1.0);
    // Stopped by the block's near corner, wherever that falls in the sweep.
    expect(out['joint:jaw_hinge.pos']).toBeGreaterThan(0.1);
    expect(Math.abs(out['joint:jaw_hinge.vel'])).toBeLessThan(0.1);
    expect(out['body:jaw.contacts']).toBeGreaterThan(0);
  });
});
