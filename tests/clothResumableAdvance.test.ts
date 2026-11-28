// The worker keeps to its frame budget inside the cloth's substeps: an
// advance may stop between two substeps (or before a continuous-collision
// pass) at a deadline and be finished later. Finished in pieces, the cloth
// ends exactly where it would have in one go.

import { describe, it, expect } from 'vitest';
import { sheetNode } from '../src/utils/cloth/clothSheet';
import type { SceneNode } from '../src/types/scene';
import type { ClothEnv } from '../src/utils/cloth/xpbd';
import { clothRun, type ClothRun } from './clothSimHarness';

const scene = (): SceneNode[] => {
  const table = { id: 'table', name: 'table', pos: [0, 0, 0.4], geoms: [{ name: 'table_g', type: 'box', size: [0.3, 0.2, 0.4], rgba: [0.6, 0.6, 0.6, 1] }], joints: [], children: [] } as unknown as SceneNode;
  return [table, sheetNode([table], table)];
};
const env: ClothEnv = { gravity: [0, 0, -9.81], wind: [0, 0, 0], airDensity: 1.225 };

/** Steps MuJoCo and the cloth as the worker does; `pieces`: stop the cloth after every piece of work and finish it in as many calls. */
function stepAll(r: ClothRun, steps: number, pieces: boolean) {
  const dt = r.mjModel.opt.timestep;
  let stops = 0;
  for (let k = 0; k < steps; k++) stops += stepOne(r, dt, pieces);
  return stops;
}

let mjMod: { mj_step: (m: unknown, d: unknown) => void; mj_kinematics: (m: unknown, d: unknown) => void; mj_comPos: (m: unknown, d: unknown) => void; mj_comVel: (m: unknown, d: unknown) => void } | null = null;
function stepOne(r: ClothRun, dt: number, pieces: boolean): number {
  const mj = mjMod!;
  mj.mj_step(r.mjModel, r.mjData);
  mj.mj_kinematics(r.mjModel, r.mjData); mj.mj_comPos(r.mjModel, r.mjData); mj.mj_comVel(r.mjModel, r.mjData);
  if (!pieces) { expect(r.world.advance(dt, env)).toBe(true); return 0; }
  let stops = 0;
  if (!r.world.advance(dt, env, -Infinity)) {
    stops++;
    while (!r.world.finish(-Infinity)) stops++;
  }
  return stops;
}

describe('resumable cloth advance', () => {
  it('finished in pieces, ends bit-identical to one go', async () => {
    const { mujocoReady } = await import('./clothSimHarness');
    mjMod = await mujocoReady();
    const a = await clothRun(scene());
    const b = await clothRun(scene());
    expect(Array.from(b.sim.x)).toEqual(Array.from(a.sim.x));
    stepAll(a, 400, false);
    const stops = stepAll(b, 400, true);
    // It did stop: before each CCD pass at least, and between two substeps of one step.
    expect(stops).toBeGreaterThan(20);
    expect(b.sim.time).toBe(a.sim.time);
    expect(Array.from(b.sim.x)).toEqual(Array.from(a.sim.x));
    expect(Array.from(b.sim.v)).toEqual(Array.from(a.sim.v));
  }, 200_000);
});
