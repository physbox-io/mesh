// A crumple zone: rigid until overloaded, then folded and staying folded.
//
// The whole trick is that it is not a new mechanism. A crumple is an ordinary
// hinge held still by a weld equality, so "it gives" is the same one-byte write
// to `eq_active` that shears a handle off a mug — which is why this arrived for
// almost nothing once breakable welds existed.
//
// What these check is the part that is genuinely different: that the joint does
// not move at all before it gives, that it does move after, and that it then
// STAYS where it folded to. A spring would come back; metal does not.

import { describe, it, expect, afterAll } from 'vitest';
import { compileToMJCF } from '../src/utils/mjcf';
import { canCrumple, crumpleAsWeld, crumpleKey } from '../src/utils/breakThresholds';
import { simulate, type Sim } from './helpers/simulate';
import type { SceneGraph } from '../src/types/scene';

/** A post with an arm hinged off it, loaded by its own weight. */
const bracket = (crumpleTorqueNm?: number): SceneGraph => ({
  nodes: [
    {
      id: 'post', name: 'post', pos: [0, 0, 0.5],
      geoms: [{ name: 'post_g', type: 'box', size: [0.04, 0.04, 0.5], mass: 5 }],
      joints: [], children: [
        {
          id: 'arm', name: 'arm', pos: [0.04, 0, 0.4],
          // Held clear of the post on purpose: an arm whose inner end rests against
      // the column is propped up by contact, and then nothing the joint does
      // makes any difference — the first version of this test measured two
      // contact forces cancelling gravity and concluded the lock had held.
      geoms: [{ name: 'arm_g', type: 'box', size: [0.28, 0.03, 0.02], pos: [0.35, 0, 0], mass: 6 }],
          joints: [{
            name: 'arm_hinge', type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.05,
            ...(crumpleTorqueNm !== undefined
              ? { crumpleTorqueNm, crumpleRangeDeg: [0, 70] as [number, number], crumpleDampingAfter: 40 }
              : {}),
          }],
          children: [],
        },
      ],
    },
  ],
});

describe('what a crumple compiles to', () => {
  it('locks the joint with a weld to its parent, and gives it its fold as a range', () => {
    const xml = compileToMJCF(bracket(3), -9.81, 1, 0, 0, 0, 0);
    expect(xml).toContain('<weld name="crumple_lock_arm_hinge" body1="arm" body2="post"');
    // Degrees: MuJoCo's MJCF default, and this file emits no <compiler> to
    // change it.
    expect(xml).toContain('range="0 70"');
    expect(xml).toContain('limited="true"');
  });

  it('changes nothing at all for a joint without one', () => {
    const plain = compileToMJCF(bracket(), -9.81, 1, 0, 0, 0, 0);
    expect(plain).not.toContain('crumple_lock');
    expect(plain).not.toContain('range=');
  });
});

describe('the decision', () => {
  it('reads a crumple as a weld that only cares about torque', () => {
    // A crumple zone folds when it is bent, not when it is pulled. Giving it a
    // force limit too would make it come apart in the hands.
    const cfg = crumpleAsWeld({ crumpleTorqueNm: 3 });
    expect(cfg.weldBreakTorqueNm).toBe(3);
    expect(cfg.weldBreakForceN).toBeUndefined();
  });

  it('knows which joints are crumple zones', () => {
    expect(canCrumple({ crumpleTorqueNm: 3 })).toBe(true);
    expect(canCrumple({})).toBe(false);
    expect(canCrumple(undefined)).toBe(false);
    expect(canCrumple({ crumpleTorqueNm: NaN })).toBe(false);
  });

  it('names the key after the joint, which is unique in the model', () => {
    expect(crumpleKey('arm_hinge')).toBe('crumple:arm_hinge');
  });
});

describe('a bracket with a crumple zone', () => {
  let locked: Sim;
  let folded: Sim;
  afterAll(() => { locked?.dispose(); folded?.dispose(); });

  it('holds rigid under load, then folds and stays folded when released', async () => {
    // --- Locked. A 6 kg arm on a 0.3 m lever is a real load, and the joint
    //     must not move under it at all.
    locked = await simulate(bracket(3));
    locked.run(1.0);
    expect(Math.abs(locked.jointPos('arm_hinge'))).toBeLessThan(0.02);

    // --- Released, exactly as the worker does it: clear the lock's eq_active
    //     and stiffen the joint into its new shape.
    folded = await simulate(bracket(3));
    folded.run(0.5);
    const beforeRelease = folded.jointPos('arm_hinge');
    expect(Math.abs(beforeRelease)).toBeLessThan(0.02);

    folded.data.eq_active[0] = 0;
    folded.run(1.5);
    const bent = folded.jointPos('arm_hinge');

    // It gave, and it gave the way gravity pushed it: the arm hangs off +X and
    // the hinge turns about +Y, so its own weight folds it positive.
    expect(bent).toBeGreaterThan(0.15);

    // ...and it stopped at its own limit rather than swinging past it.
    expect(bent).toBeLessThanOrEqual(70 * Math.PI / 180 + 0.05);

    // Settled, not oscillating — a spring would still be moving.
    const atRest = folded.jointPos('arm_hinge');
    folded.run(1.0);
    expect(Math.abs(folded.jointPos('arm_hinge') - atRest)).toBeLessThan(0.05);
  }, 120_000);
});
