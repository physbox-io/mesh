// The hardware presets, run in real MuJoCo with their own scripts — through a
// stand-in for the worker's script api — so each one is seen to do what its
// note card says it does.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import {
  chestOfDrawersPreset, extrusionFramePreset, sealedJarPreset, springLauncherPreset, stepperTurntablePreset, xyPlotterPreset,
} from '../src/presets/hardwarePresets';
import { compileToMJCF } from '../src/utils/mjcf';
import { sealFindings, runnerFindings } from '../src/utils/hardwareChecks';
import { hardwareList } from '../src/utils/hardwareList';
import type { SceneGraph, SceneNode } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

const all = (nodes: SceneNode[], out: SceneNode[] = []): SceneNode[] => { for (const n of nodes) { out.push(n); all(n.children || [], out); } return out; };

/** A model of the scene and a stepper that runs its scripts each step, the way the worker does. */
function sim(scene: SceneGraph) {
  const model = mj.MjModel.from_xml_string(compileToMJCF(scene, -9.81, 1, 0, 0, 0, 0));
  const data = new mj.MjData(model);
  // Positions are zeros until the model is first worked out.
  mj.mj_forward(model, data);
  const O = mj.mjtObj;
  // Bodies are named by node name; scripts and these tests ask by id, as the worker resolves them.
  const names = new Map(all(scene.nodes).map((n) => [n.id, n.name]));
  const body = (n: string) => mj.mj_name2id(model, O.mjOBJ_BODY.value, names.get(n) ?? n);
  const joint = (n: string) => mj.mj_name2id(model, O.mjOBJ_JOINT.value, n);
  const scripted = all(scene.nodes).filter((n) => n.script);
  const runs = scripted.map((n) => {
    const api = {
      getTime: () => data.time,
      getJointPosition: (j: string) => data.qpos[model.jnt_qposadr[joint(j)]],
      getJointVelocity: (j: string) => data.qvel[model.jnt_dofadr[joint(j)]],
      applyJointForce: (j: string, f: number) => { data.qfrc_applied[model.jnt_dofadr[joint(j)]] += f; },
      applyForce: (f: number[], b = n.id) => { const id = body(b); for (let k = 0; k < 3; k++) data.xfrc_applied[id * 6 + k] += f[k] || 0; },
      setActuatorControl: (a: string, v: number) => { data.ctrl[mj.mj_name2id(model, O.mjOBJ_ACTUATOR.value, a)] = v; },
      getMass: (b = n.id) => model.body_mass[body(b)],
      state: {},
      log: () => {},
    };
    const fn = new Function('api', n.script!);
    return () => fn(api);
  });
  const step = (seconds: number, each?: () => void) => {
    const n = Math.round(seconds / model.opt.timestep);
    for (let i = 0; i < n; i++) {
      data.xfrc_applied.fill(0);
      data.qfrc_applied.fill(0);
      for (const r of runs) r();
      mj.mj_step(model, data);
      each?.();
    }
    for (const v of data.qpos) if (!Number.isFinite(v)) throw new Error('diverged');
  };
  const pos = (b: string) => { const id = body(b); return [data.xpos[id * 3], data.xpos[id * 3 + 1], data.xpos[id * 3 + 2]]; };
  return { model, data, step, pos, joint, done: () => { data.delete(); model.delete(); } };
}

describe('chest of drawers', () => {
  it('opens the bottom drawer its runners\' length, shuts it, then opens the next', () => {
    const s = sim(chestOfDrawersPreset);
    const y0 = s.pos('drawer_1')[1];
    // Each opens two seconds after the one below it, and is pushed home four after it opened.
    s.step(1.8);
    expect(y0 - s.pos('drawer_1')[1]).toBeGreaterThan(0.35);
    expect(y0 - s.pos('drawer_1')[1]).toBeLessThan(0.41);
    expect(Math.abs(s.pos('drawer_2')[1] - y0)).toBeLessThan(0.01);
    s.step(4.1); // t = 5.9: the first pushed home, the second still out
    expect(Math.abs(s.pos('drawer_1')[1] - y0)).toBeLessThan(0.005);
    expect(y0 - s.pos('drawer_2')[1]).toBeGreaterThan(0.35);
    // Nothing sagged onto what is under it.
    expect(s.pos('drawer_1')[2]).toBeGreaterThan(chestOfDrawersPreset.nodes.find((n) => n.id === 'drawer_1')!.pos[2] - 0.003);
    s.done();
  }, 60_000);

  it('has the side space right for every runner, and lists eight of them', () => {
    expect(runnerFindings(chestOfDrawersPreset, 'print')).toEqual([]);
    const row = hardwareList(chestOfDrawersPreset).rows.find((r) => r.kind === 'drawer_runner');
    expect(row?.count).toBe(8);
  });
});

describe('XY plotter', () => {
  it('follows its figure to within a couple of millimetres', () => {
    const s = sim(xyPlotterPreset);
    s.step(2);
    let worst = 0;
    s.step(4, () => {
      const t = s.data.time * 0.7;
      const x = s.data.qpos[s.model.jnt_qposadr[s.joint('x_rail_travel')]];
      const y = s.data.qpos[s.model.jnt_qposadr[s.joint('y_rail_travel')]];
      worst = Math.max(worst, Math.hypot(x - 0.11 * Math.sin(3 * t), y - 0.075 * Math.sin(2 * t + 0.6)));
    });
    expect(worst).toBeLessThan(0.004);
    s.done();
  }, 60_000);
});

describe('stepper turntable', () => {
  it('spins up, and throws its cubes outermost first', () => {
    const s = sim(stepperTurntablePreset);
    const gone = (b: string) => Math.hypot(s.pos(b)[0], s.pos(b)[1]) > 0.12;
    const when: Record<string, number> = {};
    s.step(9, () => {
      for (const b of ['cube_far', 'cube_mid', 'cube_near']) if (when[b] === undefined && gone(b)) when[b] = s.data.time;
    });
    const omega = s.data.qvel[s.model.jnt_dofadr[s.joint('bearing_spin')]];
    expect(omega).toBeGreaterThan(14);
    expect(when.cube_far).toBeDefined();
    expect(when.cube_far).toBeLessThan(when.cube_mid ?? Infinity);
    // During the spin-up, not before it starts.
    expect(when.cube_far).toBeGreaterThan(1);
    expect(when.cube_far).toBeLessThan(9);
    s.done();
  }, 60_000);
});

describe('spring launcher', () => {
  it('throws the ball and catches it again', () => {
    const s = sim(springLauncherPreset);
    let top = 0;
    s.step(4, () => { if (s.data.time > 2) top = Math.max(top, s.pos('ball')[2]); });
    expect(top).toBeGreaterThan(0.25);
    s.step(1.9);
    // Back in the cup, being cocked again.
    expect(Math.hypot(s.pos('ball')[0], s.pos('ball')[1])).toBeLessThan(0.02);
    s.done();
  }, 60_000);
});

describe('sealed jar', () => {
  it('seals with the lid on, and does not with it lifted', () => {
    const [f] = sealFindings(sealedJarPreset, 'print');
    expect(f.passed).toBe(true);
    const lifted = structuredClone(sealedJarPreset);
    lifted.nodes.find((n) => n.id === 'lid')!.pos[2] += 0.0005;
    expect(sealFindings(lifted, 'print')[0].title).toMatch(/squeezed only/);
  });
});

describe('extrusion frame', () => {
  it('stands square, and its carriage rides up and down its post', () => {
    const s = sim(extrusionFramePreset);
    let lo = Infinity, hi = -Infinity;
    s.step(6, () => {
      const z = s.data.qpos[s.model.jnt_qposadr[s.joint('lift_slide')]];
      lo = Math.min(lo, z); hi = Math.max(hi, z);
    });
    expect(hi - lo).toBeGreaterThan(0.15);
    // The top square is still where it was over the bottom.
    const drop = extrusionFramePreset.nodes.find((n) => n.id === 'top_front')!.pos[2] - s.pos('top_front')[2];
    expect(Math.abs(drop)).toBeLessThan(0.003);
    s.done();
  }, 60_000);

  it('packs its profiles onto bars', () => {
    const list = hardwareList(extrusionFramePreset);
    expect(list.bars.length).toBeGreaterThan(0);
    expect(list.rows.find((r) => r.kind === 'corner_bracket')?.count).toBe(16);
  });
});
