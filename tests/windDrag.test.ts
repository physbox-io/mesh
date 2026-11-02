// Wind blows on everything. With the scene's air density left at its default
// of 0, MuJoCo's fluid model is off, and its wind moved nothing but the
// bodies marked aerodynamic, which the worker pushes itself.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import type { SceneGraph, SceneNode } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

const ball: SceneGraph = {
  nodes: [{ id: 'ball', name: 'ball', pos: [0, 0, 1], joints: [{ name: 'ball_free', type: 'free' }], geoms: [{ name: 'ball_g', type: 'sphere', size: [0.1], mass: 0.05 }] } as SceneNode],
} as SceneGraph;

function drift(windX: number, density: number) {
  const m = mj.MjModel.from_xml_string(compileToMJCF(ball, 0, 1, windX, 0, density));
  const d = new mj.MjData(m);
  while (d.time < 1) mj.mj_step(m, d);
  const x = d.xpos[3];
  d.delete(); m.delete();
  return x;
}

describe('wind', () => {
  it('pushes an ordinary body at the default air density', () => {
    expect(drift(10, 0)).toBeGreaterThan(0.05);
  });
  it('does nothing when there is none', () => {
    expect(Math.abs(drift(0, 0))).toBeLessThan(1e-9);
  });
  it('pushes harder through denser air', () => {
    expect(drift(10, 5)).toBeGreaterThan(drift(10, 1.225) * 1.2);
  });
});
