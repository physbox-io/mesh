import { describe, expect, it } from 'vitest';
import type { SceneNode } from '../src/types/scene';
import { newtonsCradlePreset } from '../src/presets/presetScenes';
import { simulate } from './helpers/simulate';
import {
  estimateBodyModes,
  inferAcousticMaterial,
  solveVariableBeamModes,
} from '../src/utils/modalAudio';
import {
  buildTunedScaleNodes,
  hzToNoteInfo,
  noteToHz,
  tuneBodyToPitch,
} from '../src/utils/acousticTuning';

describe('Modal Impact Acoustics & Concert Pitch Tuning', () => {
  it('reproduces classical Euler-Bernoulli free-free beam overtone ratios (1 : 2.756 : 5.404) for a uniform bar', () => {
    const lengthM = 0.24;
    const thicknessM = 0.012;
    const freqs = solveVariableBeamModes(lengthM, 12.5e9, 720, () => thicknessM);
    expect(freqs.length).toBeGreaterThanOrEqual(3);
    expect(freqs[1] / freqs[0]).toBeCloseTo(2.7565, 2);
    expect(freqs[2] / freqs[0]).toBeCloseTo(5.4039, 1);
  });

  it('distinguishes material speed of sound and mechanical Q across steel, hardwood, and polymer', () => {
    const makeBar = (deformMaterial?: string, density?: number): SceneNode => ({
      id: 'bar',
      name: 'Test Bar',
      pos: [0, 0, 0.02],
      deformMaterial,
      density,
      geoms: [{ name: 'body', type: 'box', size: [0.11, 0.018, 0.006] }],
      joints: [{ name: 'free', type: 'free' }],
      children: [],
    });

    const steel = estimateBodyModes(makeBar('steel'));
    const wood = estimateBodyModes(makeBar('hardwood'));
    const plastic = estimateBodyModes(makeBar('plastic'));

    // Wave speed c = sqrt(E/rho): steel (~5050 m/s) & hardwood (~4100 m/s) >> polymer (~1550 m/s)
    expect(steel.fundamentalHz).toBeGreaterThan(wood.fundamentalHz);
    expect(wood.fundamentalHz).toBeGreaterThan(plastic.fundamentalHz * 2);

    // Sustain quality factor Q: steel rings much longer than wood, which rings longer than plastic
    expect(inferAcousticMaterial(makeBar('steel')).qualityQ).toBeGreaterThan(
      inferAcousticMaterial(makeBar('hardwood')).qualityQ * 4,
    );
    expect(inferAcousticMaterial(makeBar('hardwood')).qualityQ).toBeGreaterThan(
      inferAcousticMaterial(makeBar('plastic')).qualityQ * 2,
    );
  });

  it('carves an underside luthier arch to tune a hardwood marimba bar to A4 (440 Hz) and raises f2/f1', () => {
    // Un-tuned 250 x 36 x 18 mm rosewood/hardwood bar starts sharp above A4 (~690 Hz, f2/f1 ~ 2.76)
    const rawBar: SceneNode = {
      id: 'marimba_bar',
      name: 'Hardwood Bar',
      pos: [0, 0, 0.02],
      deformMaterial: 'hardwood',
      geoms: [{ name: 'bar', type: 'box', size: [0.125, 0.018, 0.009] }],
      joints: [{ name: 'free', type: 'free' }],
      children: [],
    };

    const before = estimateBodyModes(rawBar);
    expect(before.fundamentalHz).toBeGreaterThan(550);
    expect(before.overtoneRatio).toBeCloseTo(2.76, 1);

    const targetHz = noteToHz('A4')!;
    expect(targetHz).toBeCloseTo(440, 2);

    const tuned = tuneBodyToPitch(rawBar, targetHz);
    expect(tuned.method).toBe('arch');
    expect(tuned.node.geoms.some((g) => g.name === 'luthier_arch' && g.csg === 'difference')).toBe(true);

    // Hits 440 Hz within < 0.8% (< 14 cents) AND raises 2nd flexural overtone ratio well above 2.76 toward 4:1!
    expect(Math.abs(tuned.after.fundamentalHz - 440) / 440).toBeLessThan(0.008);
    expect(tuned.after.overtoneRatio).toBeGreaterThan(3.15);
    expect(hzToNoteInfo(tuned.after.fundamentalHz).note).toBe('A4');
  });

  it('tunes a cylindrical chime rod by length L ∝ 1/√f and places a Ø2.2 mm cord hole at 0.2242·L', () => {
    const rod: SceneNode = {
      id: 'chime',
      name: 'Steel Chime',
      pos: [0, 0, 0.15],
      deformMaterial: 'steel',
      geoms: [{ name: 'rod', type: 'cylinder', size: [0.008, 0.14] }],
      joints: [{ name: 'free', type: 'free' }],
      children: [],
    };

    const c5Hz = noteToHz('C5')!;
    const tuned = tuneBodyToPitch(rod, c5Hz, { drillNodalHole: true });
    expect(tuned.method).toBe('tube_length');
    expect(Math.abs(tuned.after.fundamentalHz - c5Hz) / c5Hz).toBeLessThan(0.01);

    const mainCyl = tuned.node.geoms.find((g) => g.name === 'rod')!;
    const fullLenMm = mainCyl.size[1] * 2 * 1000;
    expect(tuned.nodalOffsetMm).toBeCloseTo(0.2242 * fullLenMm, 1);
    expect(tuned.node.geoms.some((g) => g.name === 'nodal_hole' && g.csg === 'difference')).toBe(true);
  });

  it('spawns a 5-note C4 major pentatonic bar set tuned to C4, D4, E4, G4, A4', () => {
    const baseBar: SceneNode = {
      id: 'key',
      name: 'Key',
      pos: [0, 0, 0.02],
      deformMaterial: 'hardwood',
      geoms: [{ name: 'bar', type: 'box', size: [0.13, 0.016, 0.009] }],
      joints: [{ name: 'free', type: 'free' }],
      children: [],
    };

    const set = buildTunedScaleNodes(baseBar, 'C4', 'pentatonic');
    expect(set.length).toBe(5);
    const notes = set.map((n) => hzToNoteInfo(estimateBodyModes(n).fundamentalHz).note);
    expect(notes).toEqual(['C4', 'D4', 'E4', 'G4', 'A4']);
  });

  it("resolves welded child colliders, warm ~1 kHz clack pulse, and passive MuJoCo momentum transfer on Newton's Cradle", async () => {
    const cradleArm = newtonsCradlePreset.nodes.find((n) => n.id === 'cradle_0')!;
    const profile = estimateBodyModes(cradleArm);
    expect(profile.material.label).toBe('Steel');
    // Macroscopic contact duration ~0.45–0.65 ms (~900–1300 Hz midrange clack, not 8 kHz tick)
    expect(profile.contactDurationSec).toBeGreaterThan(0.00035);
    expect(profile.contactDurationSec).toBeLessThan(0.0012);
    expect(profile.fundamentalHz).toBeGreaterThan(20000);
    expect(profile.modes.length).toBe(0);

    // Real MuJoCo WASM simulation: 1 ball in -> far ball swings out cleanly, and height NEVER exceeds initial release height!
    const sim = await simulate(newtonsCradlePreset);
    try {
      const initialBall0Z = sim.bodyPos('cradle_bob_body_0')[2]; // released at 35°: z = 0.30 - 0.20*cos(35°) ≈ 0.1362 m
      const restBall4X = sim.bodyPos('cradle_bob_body_4')[0]; // +0.08 m
      let peakBall4SwingDx = 0;
      let maxAnyBallZ = -Infinity;
      // Step 5 full seconds (2500 steps)
      for (let step = 0; step < 2500; step++) {
        sim.step(1);
        const dx4 = sim.bodyPos('cradle_bob_body_4')[0] - restBall4X;
        if (dx4 > peakBall4SwingDx) peakBall4SwingDx = dx4;
        for (let i = 0; i < 5; i++) {
          const zi = sim.bodyPos(`cradle_bob_body_${i}`)[2];
          if (zi > maxAnyBallZ) maxAnyBallZ = zi;
        }
      }
      // Ball 0 dropped from dx = -115 mm (z ≈ 0.1362 m): far ball 4 swings out > 75 mm, and NO ball ever rises above initial z!
      expect(peakBall4SwingDx).toBeGreaterThan(0.075);
      expect(maxAnyBallZ).toBeLessThanOrEqual(initialBall0Z + 0.002);
    } finally {
      sim.dispose();
    }
  });
});
