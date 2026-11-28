// Cloth meets bodies where they are now, not where they were a MuJoCo step
// ago: mj_step leaves xpos/xmat at the step's start, so the worker (and this
// harness, which copies its order) brings the kinematics up to date before
// the cloth is posed. A body falling past 1 m/s used to be met 2+ mm behind.

import { describe, it, expect } from 'vitest';
import type * as THREE from 'three';
import { sheetNode } from '../src/utils/cloth/clothSheet';
import type { SceneNode } from '../src/types/scene';
import { clothRun } from './clothSimHarness';

describe('cloth step order', () => {
  it('poses colliders from the body pose after the step', async () => {
    const box = {
      id: 'faller', name: 'faller', pos: [2, 0, 3],
      geoms: [{ name: 'faller_g', type: 'box', size: [0.1, 0.1, 0.1], rgba: [0.6, 0.6, 0.6, 1] }],
      joints: [{ name: 'faller_free', type: 'free' }], children: [],
    } as unknown as SceneNode;
    const sheet = sheetNode([], null, [0, 0]);
    const r = await clothRun([box, sheet]);
    const ci = r.colliders.findIndex((c) => c.body === 'faller');
    expect(ci).toBeGreaterThanOrEqual(0);
    const world = (r.sim as unknown as { world: THREE.Matrix4[] }).world;
    expect(r.mjModel.nq).toBe(7); // the faller's free joint only
    const dt = r.mjModel.opt.timestep;
    let checked = 0;
    for (let k = 0; k < 300; k++) {
      const t0 = r.sim.time;
      r.run(dt);
      if (r.sim.time === t0) continue; // no substep: not posed this step
      const z = r.mjData.qpos[2]; // where the joint is now (xpos may lag it)
      expect(Math.abs(world[ci].elements[14] - z)).toBeLessThan(1e-9);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
    // It was falling fast enough for a step's lag to matter.
    expect(Math.abs(r.mjData.qvel[2])).toBeGreaterThan(1);
  }, 120_000);
});
