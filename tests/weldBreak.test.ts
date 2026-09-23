// Does a weld actually let go when it is loaded past its limit?
//
// The threshold arithmetic lives in utils/breakThresholds.ts and is unit-tested
// there. What that cannot answer is whether the number it is fed means anything:
// whether MuJoCo reports a weld's load where this code looks for it, in the
// units the UI claims, and whether clearing `eq_active` actually releases the
// part rather than merely making the solver stop reporting.
//
// So this runs the real engine on a real welded body. The scan below is the same
// one physicsWorker.ts runs after every step — six constraint rows per weld,
// three of force and three of torque — and the worker's own copy cannot be
// imported here, because that module is a Worker and instantiates wasm on load.
//
// The control matters as much as the assertion. "The arm ended up on the floor"
// proves nothing on its own: an arm that was never welded also ends up on the
// floor. The two runs differ in one byte of `eq_active` and nothing else.

import { describe, it, expect, afterAll } from 'vitest';
import { compileToMJCF } from '../src/utils/mjcf';
import { isBreakable, weldOverload } from '../src/utils/breakThresholds';
import { simulate, type Sim } from './helpers/simulate';
import type { SceneGraph } from '../src/types/scene';

/** A heavy arm welded to a fixed post, hanging out to one side so it has leverage. */
const cantilever = (): SceneGraph => ({
  nodes: [
    {
      id: 'post', name: 'post', pos: [0, 0, 1], geoms: [
        { name: 'post_g', type: 'box', size: [0.05, 0.05, 0.5], mass: 1 },
      ], joints: [], children: [],
    },
    {
      id: 'arm', name: 'arm', pos: [0.6, 0, 1.5],
      geoms: [{ name: 'arm_g', type: 'box', size: [0.4, 0.05, 0.05], mass: 20 }],
      joints: [{ name: 'arm_free', type: 'free' }],
      children: [],
      weldTargetId: 'post',
      weldBreakForceN: 100,
      weldBreakHoldSteps: 3,
    },
  ],
});

const EQUALITY = 0; // mjtConstraint.mjCNSTR_EQUALITY

/** The load on equality `eqIndex`, exactly as the worker measures it. */
const weldLoad = (sim: Sim, eqIndex: number) => {
  const rows: number[] = [];
  for (let i = 0; i < sim.data.nefc && rows.length < 6; i++) {
    if (sim.data.efc_type[i] === EQUALITY && sim.data.efc_id[i] === eqIndex) {
      rows.push(sim.data.efc_force[i]);
    }
  }
  const [fx = 0, fy = 0, fz = 0, tx = 0, ty = 0, tz = 0] = rows;
  return {
    rows: rows.length,
    forceN: Math.hypot(fx, fy, fz),
    torqueNm: Math.hypot(tx, ty, tz),
  };
};

describe('the MJCF a breakable weld compiles to', () => {
  it('still emits an ordinary weld — the thresholds are runtime-only', () => {
    const withThresholds = compileToMJCF(cantilever(), -9.81, 1, 0, 0, 0, 0);
    expect(withThresholds).toContain('<weld name="weld_constraint_1" body1="arm" body2="post"');

    // The golden MJCF the native app diffs against must not move because
    // somebody authored a break threshold. Nothing about breaking belongs in
    // the XML: it is decided per step, against forces the solver reports.
    const plain = cantilever();
    delete plain.nodes[1].weldBreakForceN;
    delete plain.nodes[1].weldBreakHoldSteps;
    expect(compileToMJCF(plain, -9.81, 1, 0, 0, 0, 0)).toBe(withThresholds);
    expect(withThresholds).not.toMatch(/weldBreak|breakForce/i);
  });
});

describe('a weld under load', () => {
  let sim: Sim;
  afterAll(() => sim?.dispose());

  it('reports its load in newtons, on six rows', async () => {
    sim = await simulate(cantilever());
    sim.run(0.8);

    const load = weldLoad(sim, 0);
    expect(load.rows).toBe(6);
    // 20 kg held out on a weld is hundreds of newtons, not single digits and
    // not tens of thousands. If this drifts, the UI's "breaks at N" is lying.
    expect(load.forceN).toBeGreaterThan(100);
    expect(load.forceN).toBeLessThan(1000);

    // And it is genuinely holding the arm up, rather than reporting a load on
    // something already resting on the floor.
    expect(sim.bodyPos('arm')[2]).toBeGreaterThan(1.3);
  });
});

describe('breaking it', () => {
  let held: Sim;
  let broken: Sim;
  afterAll(() => { held?.dispose(); broken?.dispose(); });

  it('drops the part when the threshold is passed, and holds it when it is not', async () => {
    // --- The break. Threshold well under what the arm actually weighs.
    broken = await simulate(cantilever());
    broken.run(0.5);

    const cfg = { weldBreakForceN: 100, weldBreakHoldSteps: 3 };
    expect(isBreakable(cfg)).toBe(true);

    let consecutive = 0;
    let brokeAt = -1;
    for (let step = 0; step < 400 && brokeAt < 0; step++) {
      broken.step(1);
      const { forceN, torqueNm } = weldLoad(broken, 0);
      const verdict = weldOverload(forceN, torqueNm, cfg, consecutive);
      consecutive = verdict.consecutive;
      if (verdict.broken) {
        broken.data.eq_active[0] = 0;
        brokeAt = step;
      }
    }

    // It broke, and it took at least the hold — a weld that snaps on the first
    // overloaded step is the bug the hold exists to prevent.
    expect(brokeAt).toBeGreaterThanOrEqual(2);
    broken.run(1.5);
    expect(broken.bodyPos('arm')[2]).toBeLessThan(0.3);
    expect(weldLoad(broken, 0).forceN).toBe(0);

    // --- The control. Same scene, same duration, threshold above the load.
    held = await simulate(cantilever());
    const highCfg = { weldBreakForceN: 1e6, weldBreakHoldSteps: 3 };
    let heldConsecutive = 0;
    let everBroke = false;
    for (let step = 0; step < 400; step++) {
      held.step(1);
      const { forceN, torqueNm } = weldLoad(held, 0);
      const verdict = weldOverload(forceN, torqueNm, highCfg, heldConsecutive);
      heldConsecutive = verdict.consecutive;
      if (verdict.broken) everBroke = true;
    }
    held.run(1.5);
    expect(everBroke).toBe(false);
    expect(held.bodyPos('arm')[2]).toBeGreaterThan(1.3);
  });
});
