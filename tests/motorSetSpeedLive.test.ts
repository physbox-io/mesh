// Changing a motor's set speed while the sim plays.
//
// Reported: the new gain applied at once, the new set speed was ignored. Both
// edits rebuild the model mid-play; kv lives in the model, so it took, but the
// rebuild carries every actuator's live ctrl across (so a script's or the Volt
// link's value survives an unrelated edit) and that carried value overwrote
// the edited ctrlValue. The worker now lets a set speed the document changed
// win (applyEditedCtrl). The physics worker cannot load here, so this drives
// the same carry functions it calls, in the same order.

import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.hoisted(() => { (globalThis as { navigator?: unknown }).navigator ??= { hardwareConcurrency: 2 }; });

import load_mujoco from '@mujoco/mujoco';
import { fillBodyDefaults } from '../src/hooks/useMCPBridge';
import { compileToMJCF } from '../src/utils/mjcf';
import { applyEditedCtrl, captureState, copyCarriedActuators, documentCtrlValues } from '../src/workers/carryState';
import type { SceneNode } from '../src/types/scene';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

const motoredBar = (ctrlValue: number, kv: number, forceLimit?: number): SceneNode => fillBodyDefaults({
  name: 'stand', static: true,
  geoms: [{ type: 'box', size: [0.01, 0.01, 0.01], pos: [0, 0, 0.01] }],
  children: [{
    name: 'bar', pos: [0, 0, 0.05],
    joints: [{ name: 'spin', type: 'hinge', axis: [0, 0, 1], actuator: { type: 'velocity', kv, ctrlValue, ...(forceLimit !== undefined ? { forceLimit } : {}) } }],
    geoms: [{ type: 'box', size: [0.02, 0.002, 0.002], mass: 0.005, contype: 0, conaffinity: 0 }],
  }],
} as never);

const build = (nodes: SceneNode[]) => {
  const m = mj.MjModel.from_xml_string(compileToMJCF({ nodes }, -9.81, 1, 0, 0, 0));
  const d = new mj.MjData(m);
  const actuators: Record<string, number> = {};
  for (let i = 0; i < m.nu; i++) actuators[mj.mj_id2name(m, mj.mjtObj.mjOBJ_ACTUATOR.value, i)] = i;
  const joints: Record<string, number> = {};
  for (let i = 0; i < m.njnt; i++) joints[mj.mj_id2name(m, mj.mjtObj.mjOBJ_JOINT.value, i)] = i;
  return { m, d, actuators, joints, v: () => d.qvel[m.jnt_dofadr[joints.spin]] as number };
};

/** What doBuild does on a preserveState rebuild whose dofs did not change. */
const rebuildMidPlay = (old: ReturnType<typeof build>, before: SceneNode[], after: SceneNode[]) => {
  const carried = captureState(old.m, old.d, old.joints, old.actuators)!;
  const next = build(after);
  for (let i = 0; i < carried.nq; i++) next.d.qpos[i] = carried.qpos[i];
  for (let i = 0; i < carried.nv; i++) next.d.qvel[i] = carried.qvel[i];
  copyCarriedActuators(carried, next.m, next.d, next.actuators);
  applyEditedCtrl(documentCtrlValues(before), after, next.m, next.d, next.actuators);
  mj.mj_forward(next.m, next.d);
  old.d.delete(); old.m.delete();
  return next;
};

describe.each([['unclamped', undefined], ['clutched', 0.05]] as const)('a %s motor edited mid-play', (_label, limit) => {
  it('takes a new set speed', () => {
    const before = [motoredBar(1, 2, limit)];
    let s = build(before);
    s.d.ctrl[s.actuators.spin_actuator] = 1;
    for (let i = 0; i < 1000; i++) mj.mj_step(s.m, s.d);
    expect(s.v()).toBeCloseTo(1, 1);

    const after = [motoredBar(4, 2, limit)];
    s = rebuildMidPlay(s, before, after);
    expect(s.d.ctrl[s.actuators.spin_actuator]).toBe(4);
    for (let i = 0; i < 2000; i++) mj.mj_step(s.m, s.d);
    expect(s.v()).toBeCloseTo(4, 1);
    s.d.delete(); s.m.delete();
  });

  it('keeps a script-set ctrl when something else is edited (the gain)', () => {
    const before = [motoredBar(1, 2, limit)];
    let s = build(before);
    s.d.ctrl[s.actuators.spin_actuator] = 3; // a script drove it elsewhere
    for (let i = 0; i < 200; i++) mj.mj_step(s.m, s.d);
    s = rebuildMidPlay(s, before, [motoredBar(1, 5, limit)]);
    expect(s.d.ctrl[s.actuators.spin_actuator]).toBe(3);
    s.d.delete(); s.m.delete();
  });
});

describe('applyEditedCtrl', () => {
  it('does nothing without the previous document (a fresh worker with no seed)', () => {
    const s = build([motoredBar(2, 2)]);
    s.d.ctrl[0] = 7;
    expect(applyEditedCtrl(null, [motoredBar(2, 2)], s.m, s.d, s.actuators)).toEqual([]);
    expect(s.d.ctrl[0]).toBe(7);
    s.d.delete(); s.m.delete();
  });
});
