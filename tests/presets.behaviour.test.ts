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

describe('pulley system', () => {
  let sim: Sim;
  let start: { l: number; r: number };
  beforeAll(async () => {
    sim = await simulate(preset('pulley_system'));
    start = { l: sim.bodyPos('left_weight')[2], r: sim.bodyPos('right_weight')[2] };
    sim.run(2);
  });
  afterAll(() => sim.dispose());

  it('lets the heavier weight descend and lift the lighter one', () => {
    // 2kg on the left, 1kg on the right — the imbalance is the demonstration.
    expect(sim.bodyPos('left_weight')[2]).toBeLessThan(start.l);
    expect(sim.bodyPos('right_weight')[2]).toBeGreaterThan(start.r);
  });

  it('turns the wheel as the rope runs over it', () => {
    expect(Math.abs(sim.jointPos('pulley_wheel_hinge'))).toBeGreaterThan(1);
  });

  it('keeps both weights above the floor', () => {
    for (const w of ['left_weight', 'right_weight']) {
      expect(sim.bodyPos(w)[2]).toBeGreaterThan(0.04);
    }
  });
});

describe('paper plane', () => {
  let sim: Sim;
  beforeAll(async () => { sim = await simulate(preset('paper_plane')); sim.run(1); });
  afterAll(() => sim.dispose());

  it('remains numerically stable during flight', () => {
    expect(Number.isFinite(sim.bodyPos('paper_plane_wing')[0])).toBe(true);
    expect(Number.isFinite(sim.bodyPos('paper_plane_wing')[2])).toBe(true);
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
