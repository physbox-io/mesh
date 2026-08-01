// What the presets DO, simulated headlessly in MuJoCo.
//
// Every assertion here corresponds to a claim the preset's note card makes to
// the user. They exist because a bulk rescale in commit 34c17ea shrank the
// presets ~2.5x without rescaling the parameters that made them work, and the
// result silently shipped: stacked cubes with no gap to fall through, gear
// trains that detonated numerically within 15ms, a "torque-driven" windmill with
// no torque, a cart-pole whose controller regulated to a non-equilibrium, and a
// rack jammed against its own shelf. Nothing caught any of it, because a
// preset's behaviour was only ever verified by loading the app and watching.
//
// See tests/helpers/simulate.ts for what the harness does and does not
// reproduce; notably it has no aerodynamics, so lift-driven presets (the
// aerodynamic windmill, drone flight) are only checked for numerical sanity.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PRESETS } from '../src/presets/presetScenes';
import { makePresetNoteCard } from '../src/utils/noteCards';
import type { SceneNode } from '../src/types/scene';
import { simulate, type Sim } from './helpers/simulate';

const preset = (key: string) => (PRESETS as Record<string, { scene: never }>)[key].scene;

describe('stacked cubes', () => {
  let sim: Sim;
  let startZ: number;
  beforeAll(async () => {
    sim = await simulate(preset('cubes'));
    startZ = sim.bodyPos('cube2')[2];
  });
  afterAll(() => sim.dispose());

  it('starts with the upper cube in the air, not already resting on the lower one', () => {
    // The regression: cube2 sat at 0.24 = 0.08 + 2*0.08, exactly on cube1's top
    // face. Both bodies began at rest in contact, so the preset never moved.
    const cube1Top = sim.bodyPos('cube1')[2] + 0.08;
    expect(startZ).toBeGreaterThan(cube1Top + 0.02);
  });

  it('drops the upper cube onto the lower one, where it settles', () => {
    sim.run(3);
    const [, , z2] = sim.bodyPos('cube2');
    expect(z2).toBeLessThan(startZ - 0.05);   // it actually fell
    expect(z2).toBeCloseTo(0.24, 2);           // resting on cube1
    expect(sim.bodyPos('cube1')[2]).toBeCloseTo(0.08, 2); // which stayed put
  });
});

describe('gear system', () => {
  let sim: Sim;
  beforeAll(async () => { sim = await simulate(preset('gears')); sim.run(2); });

  it('spins the driven gear up to its commanded speed', () => {
    // ctrl 1.5 rad/s against kv=20 and damping 0.5 settles at 1.5*20/21.
    expect(sim.jointVel('gear1_hinge')).toBeCloseTo(1.4286, 2);
  });
  afterAll(() => sim.dispose());

  it('drives the second gear in the opposite direction at a 1:1 ratio', () => {
    expect(sim.jointVel('gear2_hinge')).toBeCloseTo(-sim.jointVel('gear1_hinge'), 2);
  });

  it('stays numerically stable', () => {
    // The failure this guards: with the explicit Euler integrator a velocity
    // actuator is only stable while kv < 2*I/timestep. The rescale cut the hub
    // inertia to 0.0018, dropping that limit from ~89 to ~3.5 with kv still 20,
    // so the model hit NaN in QACC at t=0.011 and both gears sat at zero.
    expect(Number.isFinite(sim.jointVel('gear1_hinge'))).toBe(true);
    expect(Math.abs(sim.jointPos('gear1_hinge'))).toBeGreaterThan(1);
  });
});

describe('gear train machine', () => {
  let sim: Sim;
  beforeAll(async () => { sim = await simulate(preset('machine')); sim.run(2); });

  it('turns every gear in the train', () => {
    for (const j of ['gear1_hinge', 'gear2_hinge', 'gear3_hinge']) {
      expect(Math.abs(sim.jointPos(j))).toBeGreaterThan(1);
    }
  });
  afterAll(() => sim.dispose());

  it('alternates direction down the train', () => {
    expect(Math.sign(sim.jointPos('gear1_hinge'))).toBe(-Math.sign(sim.jointPos('gear2_hinge')));
    expect(Math.sign(sim.jointPos('gear2_hinge'))).toBe(-Math.sign(sim.jointPos('gear3_hinge')));
  });
});

describe('rack and pinion', () => {
  let sim: Sim;
  beforeAll(async () => { sim = await simulate(preset('rack_pinion')); });

  it('converts pinion rotation into rack travel at the pinion\'s pitch radius', () => {
    sim.run(0.5);
    const theta = sim.jointPos('pinion_hinge');
    const x = sim.jointPos('rack_slide');
    expect(theta).toBeGreaterThan(0.1);
    // x = r * theta, r = 0.08. The coupling used to emit polycoef r instead of
    // 1/r — MuJoCo's joint equality is joint1 = poly(joint2), so that demanded
    // 1/r^2 = 156x the travel and the mechanism bound against its own limit.
    expect(x / theta).toBeCloseTo(0.08, 2);
  });
  afterAll(() => sim.dispose());

  it('pushes the load block along instead of jamming', () => {
    const before = sim.bodyPos('rack_block')[0];
    sim.run(1.5);
    expect(sim.bodyPos('rack_block')[0]).toBeGreaterThan(before + 0.1);
    // And the rack keeps tracking the pinion while it pushes.
    expect(sim.jointPos('rack_slide') / sim.jointPos('pinion_hinge')).toBeCloseTo(0.08, 2);
  });
});

describe('cartpole', () => {
  let sim: Sim;
  let peakTilt = 0;
  let peakCart = 0;
  beforeAll(async () => {
    sim = await simulate(preset('cartpole'));
    for (let i = 0; i < 300; i++) {
      sim.run(0.05);
      peakTilt = Math.max(peakTilt, Math.abs(sim.jointPos('pole_hinge')));
      peakCart = Math.max(peakCart, Math.abs(sim.jointPos('cart_slide')));
    }
  });
  afterAll(() => sim.dispose());

  it('measures the pole angle from vertical, so the controller has a real setpoint', () => {
    // The regression: the pole body carried euler [0,5,0], a lean baked into the
    // body frame that the hinge coordinate cannot see. getJointPosition returned
    // 0 for a pole already 5 degrees over, so the controller held it there — not
    // an equilibrium — and chased the fall into the end of the rail. No choice of
    // gains could recover; 192 combinations were tried and all failed.
    expect(Math.abs(peakTilt)).toBeLessThan(0.5);
  });

  it('keeps the pole upright for 15 seconds', () => {
    expect(Math.abs(sim.jointPos('pole_hinge'))).toBeLessThan(0.1);
    expect(peakTilt).toBeLessThan(0.2);
  });

  it('keeps the cart well inside its rail', () => {
    // Saturating the +-0.35 rail is what dropped the pole before.
    expect(peakCart).toBeLessThan(0.25);
  });
});

describe('wind turbine (no aerodynamics)', () => {
  let sim: Sim;
  beforeAll(async () => { sim = await simulate(preset('physics_only_windmill')); sim.run(4); });

  it('spins its rotor from the scripted shaft torque', () => {
    // It had no script, no actuator and no aerodynamic geoms — nothing drove it
    // at all, while its note card described exactly this torque.
    expect(sim.jointVel('rotor_hinge')).toBeGreaterThan(1);
  });
  afterAll(() => sim.dispose());

  it('settles at the speed the hinge damping implies', () => {
    // Terminal speed omega = T/d = 0.4/0.05.
    expect(sim.jointVel('rotor_hinge')).toBeCloseTo(8, 1);
  });
});

describe('quadcopter drone', () => {
  let sim: Sim;
  beforeAll(async () => { sim = await simulate(preset('drone')); sim.run(2); });

  it('spins every rotor up to its commanded speed without blowing up', () => {
    // Rotor hubs have a tiny inertia, so kv=2 was far past the explicit
    // integrator's stability limit and the whole model went unstable.
    // Thrust itself comes from the app's aerodynamics, which the harness does
    // not implement, so this checks the actuators only.
    expect(sim.jointVel('rotor1_joint')).toBeCloseTo(89.1, 0);
    expect(sim.jointVel('free_rotor1_joint')).toBeCloseTo(89.1, 0);
    expect(sim.jointVel('free_rotor2_joint')).toBeCloseTo(-89.1, 0);
  });
  afterAll(() => sim.dispose());
});

describe('pulley system (Atwood machine)', () => {
  let sim: Sim;
  let start: { l: number; r: number };
  let earlyAcceleration = 0;
  beforeAll(async () => {
    sim = await simulate(preset('pulley_system'));
    start = { l: sim.bodyPos('left_weight')[2], r: sim.bodyPos('right_weight')[2] };
    sim.run(0.1);
    earlyAcceleration = Math.abs(sim.jointVel('left_weight_joint')) / 0.1;
    sim.run(1.9);
  });
  afterAll(() => sim.dispose());

  // These assert the KINEMATIC RELATIONSHIPS, not just which way things moved.
  // The previous version of this suite only checked that the heavy side went
  // down and the light side went up, and it passed happily while the rope
  // constraint was violated fourfold and the wheel was being flung to 1058 rad
  // by its own axle. A direction is not a physical claim.

  it('keeps the rope inextensible: one side rises exactly as the other falls', () => {
    const l = sim.jointPos('left_weight_joint');
    const r = sim.jointPos('right_weight_joint');
    expect(l + r).toBeCloseTo(0, 2);
  });

  it('runs the rope over the rim without slipping: x = r * theta', () => {
    // The coupling used to emit polycoef 1/r with the weight as joint1, i.e.
    // 12.5m of travel per radian — off by 1/r^2 = 156x, unsatisfiable alongside
    // gravity and the left/right coupling, so the solver simply thrashed.
    const x = sim.jointPos('left_weight_joint');
    const theta = sim.jointPos('pulley_wheel_hinge');
    expect(Math.abs(theta)).toBeGreaterThan(0.5);
    expect(x / theta).toBeCloseTo(0.08, 2);
  });

  it('accelerates at the Atwood rate, not free fall', () => {
    // a = g(m1-m2)/(m1+m2+I/r^2). With 2kg and 1kg that is ~3.27 before the
    // wheel's inertia, a little under 3.3 after it — and nowhere near g.
    expect(earlyAcceleration).toBeGreaterThan(2.0);
    expect(earlyAcceleration).toBeLessThan(3.6);
  });

  it('lets the heavier weight descend and lift the lighter one', () => {
    expect(sim.bodyPos('left_weight')[2]).toBeLessThan(start.l);
    expect(sim.bodyPos('right_weight')[2]).toBeGreaterThan(start.r);
  });

  it('keeps both weights off the floor and clear of the wheel', () => {
    for (const w of ['left_weight', 'right_weight']) {
      const z = sim.bodyPos(w)[2];
      expect(z - 0.03).toBeGreaterThan(0);      // box half-extent above the floor
      expect(z + 0.03).toBeLessThan(0.47);       // below the wheel's rim
    }
  });

  it('does not let the axle collide with the wheel it carries', () => {
    // An axle passes through its hub by design; they are joined by the hinge.
    // Leaving contact on both meant a permanently interpenetrating pair, and
    // that alone spun the wheel to 316 rad with every rope constraint removed.
    const scene = preset('pulley_system') as unknown as { nodes: SceneNode[] };
    const geomsOf = (id: string) => scene.nodes.find(n => n.id === id)!.geoms;
    const axle = geomsOf('pulley_support').find(g => g.name === 'support_axle')!;
    expect(axle.contype).toBe(0);
    expect(axle.conaffinity).toBe(0);
    for (const g of geomsOf('pulley_wheel')) {
      expect(g.contype).toBe(0);
      expect(g.conaffinity).toBe(0);
    }
  });

  it('hangs each weight directly below the rim it hangs from', () => {
    // Weights at +-0.1 against a 0.08 rim made the drawn rope non-vertical and
    // the geometry a lie.
    const scene = preset('pulley_system') as unknown as { nodes: SceneNode[] };
    const wheel = scene.nodes.find(n => n.id === 'pulley_wheel')!;
    const left = scene.nodes.find(n => n.id === 'left_weight')!;
    const right = scene.nodes.find(n => n.id === 'right_weight')!;
    expect(Math.abs(left.pos[0])).toBeCloseTo(wheel.pulleyRadius!, 6);
    expect(Math.abs(right.pos[0])).toBeCloseTo(wheel.pulleyRadius!, 6);
    // ...and on the same axis as the support that holds it up.
    for (const n of [wheel, left, right]) expect(n.pos[1]).toBe(0);
  });
});

describe('every preset explains itself', () => {
  // The note card is the preset's documentation, and it used to live in two
  // places at once: App.tsx's own copy for the dropdown and utils/noteCards.ts
  // for the MCP bridge. They drifted, and two presets ended up with no card at
  // all, so loading them explained nothing.
  it('has a note card for every built-in preset', () => {
    const missing = Object.keys(PRESETS).filter(k => !makePresetNoteCard(k));
    expect(missing).toEqual([]);
  });
});

// A cheap net that would have caught most of the above at once: any preset whose
// state goes non-finite is broken, whatever it is meant to demonstrate.
describe('every preset is numerically stable', () => {
  const keys = Object.keys(PRESETS).filter(k => k !== 'empty');

  it.each(keys)('%s produces finite state after 1s', async key => {
    const sim = await simulate(preset(key));
    try {
      sim.run(1);
      for (let i = 0; i < sim.model.nq; i++) expect(Number.isFinite(sim.data.qpos[i])).toBe(true);
      for (let i = 0; i < sim.model.nv; i++) expect(Number.isFinite(sim.data.qvel[i])).toBe(true);
    } finally {
      sim.dispose();
    }
  });
});
