import { describe, it, expect, beforeAll, vi } from 'vitest';

// The bridge module sizes its OpenSCAD pool from navigator at import.
vi.hoisted(() => { (globalThis as { navigator?: unknown }).navigator ??= { hardwareConcurrency: 2 }; });

import load_mujoco from '@mujoco/mujoco';
import { fillBodyDefaults } from '../src/hooks/useMCPBridge';
import { motorArmature, withMotorArmature } from '../src/utils/motionParts';
import { compileToMJCF } from '../src/utils/mjcf';
import type { SceneNode } from '../src/types/scene';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

/** A 5 g bar on a hinge, driven at 1 rad/s with kv 2. */
const motoredBar = (forceLimit?: number): SceneNode => fillBodyDefaults({
  name: 'stand', static: true,
  geoms: [{ type: 'box', size: [0.01, 0.01, 0.01], pos: [0, 0, 0.01] }],
  children: [{
    name: 'bar', pos: [0, 0, 0.05],
    joints: [{ name: 'spin', type: 'hinge', axis: [0, 0, 1], actuator: { type: 'velocity', kv: 2, ctrlValue: 1, ...(forceLimit !== undefined ? { forceLimit } : {}) } }],
    geoms: [{ type: 'box', size: [0.02, 0.002, 0.002], mass: 0.005, contype: 0, conaffinity: 0 }],
  }],
} as never);

const speedAfter = (node: SceneNode, steps: number) => {
  const model = mj.MjModel.from_xml_string(compileToMJCF({ nodes: [node] }, -9.81, 1, 0, 0, 0));
  const data = new mj.MjData(model);
  data.ctrl[0] = 1;
  for (let i = 0; i < steps; i++) mj.mj_step(model, data);
  const v = data.qvel[0];
  data.delete(); model.delete();
  return v;
};

describe('torque-limited velocity motors written by hand carry motorArmature', () => {
  it('raises a clamped joint below the floor, and leaves everything else alone', () => {
    expect(withMotorArmature({ actuator: { type: 'velocity', kv: 10, forceLimit: 1 } }).armature).toBe(motorArmature(10));
    expect(withMotorArmature({ actuator: { type: 'velocity', forceLimit: 1 } }).armature).toBe(motorArmature(1));
    expect(withMotorArmature({ armature: 1, actuator: { type: 'velocity', kv: 10, forceLimit: 1 } }).armature).toBe(1);
    expect(withMotorArmature({ actuator: { type: 'velocity', kv: 10 } }).armature).toBeUndefined();
    expect(withMotorArmature({ actuator: { type: 'motor', forceLimit: 1 } }).armature).toBeUndefined();
  });

  it('an unclamped motor needs none: implicitfast holds a light part at its set speed', () => {
    const bar = motoredBar();
    expect(bar.children[0].joints[0].armature).toBeUndefined();
    expect(Math.abs(speedAfter(bar, 2000) - 1)).toBeLessThan(0.05);
  });

  it('build_scene gives a clamped light part the armature that keeps it at its set speed', () => {
    const bar = motoredBar(0.01);
    expect(bar.children[0].joints[0].armature).toBe(motorArmature(2));
    expect(Math.abs(speedAfter(bar, 2000) - 1)).toBeLessThan(0.05);
  });

  it('without it the same clamped part never holds its set speed (why the floor exists)', () => {
    const bare = motoredBar(0.01);
    delete bare.children[0].joints[0].armature;
    const v = speedAfter(bare, 2000);
    expect(Number.isFinite(v) ? Math.abs(v - 1) : Infinity).toBeGreaterThan(0.5);
  });
});
