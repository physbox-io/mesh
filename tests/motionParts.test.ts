// Springs and steppers, in real MuJoCo: a spring loaded with a kilo settles
// where its rate says it should, and a stepper reaches the speed it is set to
// under a light load and stalls under one past its holding torque.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { hardwarePartNode } from '../src/utils/hardwareParts';
import { SPRINGS, STEPPERS } from '../src/utils/motionParts';
import { compileToMJCF } from '../src/utils/mjcf';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import type { SceneGeom, SceneGraph, SceneNode } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

const all = (nodes: SceneNode[], out: SceneNode[] = []): SceneNode[] => { for (const n of nodes) { out.push(n); all(n.children, out); } return out; };

describe('springs', () => {
  it('builds every size closed and outward', () => {
    for (const size of Object.keys(SPRINGS)) {
      for (const g of all([hardwarePartNode({ kind: 'spring', size }, 's')]).flatMap((n) => n.geoms).filter((x) => x.type === 'mesh')) {
        const a = analyzeMesh(g.renderVertices!, g.faces!)!;
        expect(a.closed && a.consistentlyWound && a.volume > 0).toBe(true);
      }
    }
  });

  it('settles under a kilo by its weight over its rate', () => {
    const spring = hardwarePartNode({ kind: 'spring', size: 'Ø12×40' }, 'sp');
    spring.joints = [];
    // A kilo fixed on its top, as a part welded there would be.
    spring.children[0].geoms.push({ name: 'load', type: 'box', size: [0.02, 0.02, 0.005], pos: [0, 0, 0.005], mass: 1, contype: 0, conaffinity: 0 } as SceneGeom);
    const model = mj.MjModel.from_xml_string(compileToMJCF({ nodes: [spring] } as SceneGraph, -9.81, 1, 0, 0, 0, 0));
    const data = new mj.MjData(model);
    for (let i = 0; i < 3000; i++) mj.mj_step(model, data);
    const q = data.qpos[model.jnt_qposadr[mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, 'sp_compress')]];
    const rate = SPRINGS['Ø12×40'][3] * 1000;
    expect(-q).toBeCloseTo((1 + 0.0001) * 9.81 / rate, 3);
    data.delete();
    model.delete();
  });
});

describe('steppers', () => {
  const run = (loadKg: number, leverM: number, speed: number) => {
    const motor = hardwarePartNode({ kind: 'stepper', size: 'NEMA17 40' }, 'm');
    motor.joints = [];
    motor.pos = [0, 0, 0.1];
    // A bar on the shaft: its weight at `leverM` out is a torque to lift, turning about a level shaft.
    motor.quat = [Math.SQRT1_2, Math.SQRT1_2, 0, 0];
    motor.children[0].geoms.push({ name: 'arm', type: 'box', size: [leverM, 0.002, 0.002], pos: [leverM, 0, 0.02], mass: loadKg, contype: 0, conaffinity: 0 } as SceneGeom);
    const model = mj.MjModel.from_xml_string(compileToMJCF({ nodes: [motor] } as SceneGraph, -9.81, 1, 0, 0, 0, 0));
    const data = new mj.MjData(model);
    data.ctrl[0] = speed;
    for (let i = 0; i < 2000; i++) mj.mj_step(model, data);
    const omega = data.qvel[model.jnt_dofadr[mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, 'm_spin')]];
    data.delete();
    model.delete();
    return omega;
  };

  it('reaches its speed with a light arm on it', () => {
    expect(run(0.01, 0.02, 6)).toBeGreaterThan(5);
  });

  it('holds its speed under a load right up to its holding torque', () => {
    // 0.2 kg at 100 mm is 0.196 N·m, and 0.4 kg is 0.39, against 0.42: it
    // must hold the speed asked for, not sag or turn backwards, whichever way
    // round the arm is as it turns. Averaged over whole turns.
    for (const kg of [0.2, 0.4]) expect(run(kg, 0.1, 6)).toBeGreaterThan(4.5);
  });

  it('cannot lift a load past its holding torque', () => {
    // 1 kg at 100 mm is 0.98 N·m, against 0.42.
    const [, , , , torque] = STEPPERS['NEMA17 40'];
    expect(1 * 9.81 * 0.1).toBeGreaterThan(torque);
    expect(run(1, 0.1, 6)).toBeLessThan(1);
  });
});
