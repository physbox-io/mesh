import load_mujoco from '@mujoco/mujoco';
import { describe, expect, it } from 'vitest';
import { percussionKitPreset } from '../src/presets/percussionKit';
import { computeContactDampingRate } from '../src/utils/contactFrictionAcoustics';
import {
  evaluateTensionedMembrane,
  solveMembraneImpact,
} from '../src/utils/membraneAcoustics';
import { compileToMJCF } from '../src/utils/mjcf';
import {
  estimateBodyModes,
  resolveTwoBodyImpact,
} from '../src/utils/modalAudio';
import { solveVonKarmanPlateImpact } from '../src/utils/nonlinearPlateAcoustics';

describe('Percussion Kit — Snare Pitch, Unchoked Crash Sustain & Mid-Shimmer Choke Fix', () => {
  it('distinguishes vented dual-head 14" snare (~182 Hz fat fundamental) from sealed timpani kettle (F3, 1:1.50:1.99)', () => {
    const nodes = percussionKitPreset.nodes;
    const timpaniHead = nodes.find((n) => n.id === 'timpani_head')!;
    const snareBatter = nodes.find((n) => n.id === 'snare_batter_head')!;
    const snareReso = nodes.find((n) => n.id === 'snare_resonant_head')!;
    const snareStick = nodes.find((n) => n.id === 'snare_drumstick')!;

    // 1. Sealed copper timpani kettle: closed kettle cavity + harmonic 1 : ~1.50 : ~1.99 azimuthal ratios in [85, 180] Hz
    const timpEval = evaluateTensionedMembrane(timpaniHead, nodes)!;
    expect(timpEval).not.toBeNull();
    expect(timpEval.hasShellCavity).toBe(true);
    expect(timpEval.isClosedKettle).toBe(true);
    expect(timpEval.fundamentalHz).toBeGreaterThanOrEqual(85);
    expect(timpEval.fundamentalHz).toBeLessThanOrEqual(180);
    expect(timpEval.modeRatios[0]).toBeCloseTo(1.0, 2);
    expect(timpEval.modeRatios[1]).toBeGreaterThan(1.42);
    expect(timpEval.modeRatios[1]).toBeLessThan(1.56);
    expect(timpEval.modeRatios[2]).toBeGreaterThan(1.88);
    expect(timpEval.modeRatios[2]).toBeLessThan(2.08);

    // 2. Dual-head vented 14" snare drum: NOT a sealed kettle (`isClosedKettle === false`), fat [160, 205] Hz pitch!
    const batterEval = evaluateTensionedMembrane(snareBatter, nodes)!;
    const resoEval = evaluateTensionedMembrane(snareReso, nodes)!;
    expect(batterEval).not.toBeNull();
    expect(resoEval).not.toBeNull();
    expect(batterEval.isClosedKettle).toBe(false);
    expect(resoEval.isClosedKettle).toBe(false);
    expect(batterEval.radiusM).toBeCloseTo(0.178, 3);
    expect(batterEval.fundamentalHz).toBeGreaterThanOrEqual(160);
    expect(batterEval.fundamentalHz).toBeLessThanOrEqual(205);
    expect(resoEval.fundamentalHz).toBeGreaterThanOrEqual(160);
    expect(resoEval.fundamentalHz).toBeLessThanOrEqual(210);

    // Near-center backbeat impact strongly excites fat (0,1) ~182 Hz body with ~220->182 Hz pitch drop + crisp 1.2–3.2 kHz snare wire buzz
    const centerImpact = solveMembraneImpact(snareBatter, nodes, {
      impulseNs: 0.65,
      localPoint: [0, -0.018, 0],
      strikerNode: snareStick,
      strikerGeomName: 'hickory_acorn_tip',
    })!;
    expect(centerImpact).not.toBeNull();
    expect(centerImpact.voices[0].freqHz).toBeGreaterThanOrEqual(160);
    expect(centerImpact.voices[0].freqHz).toBeLessThanOrEqual(205);
    // Fat (0,1) fundamental dominates upper timbale/bongo overtones in both peak gain and ring control
    expect(centerImpact.voices[0].gain).toBeGreaterThan(centerImpact.voices[2].gain * 2.5);
    const startHz = centerImpact.voices[0].freqHz * (1 + centerImpact.pitchGlide.initialRatio);
    expect(startHz).toBeGreaterThan(208);
    expect(startHz).toBeLessThan(255);
    expect(centerImpact.snareRattle).not.toBeNull();
    expect(centerImpact.snareRattle!.bandpassHz).toBeGreaterThanOrEqual(1200);
    expect(centerImpact.snareRattle!.bandpassHz).toBeLessThanOrEqual(3200);
    expect(centerImpact.snareRattle!.decaySec).toBeGreaterThanOrEqual(0.12);
  });

  it('sustains unchoked Ø350 mm B20 bronze crash cymbal for >= 3.2 s fundamental/cascade & >= 2.2 s shimmer wash', () => {
    const nodes = percussionKitPreset.nodes;
    const crashCymbal = nodes.find((n) => n.id === 'crash_cymbal')!;
    const cymbalMallet = nodes.find((n) => n.id === 'cymbal_crash_mallet')!;

    const profile = estimateBodyModes(crashCymbal);
    const crashEnv = solveVonKarmanPlateImpact(profile, crashCymbal, 1.45)!;
    expect(crashEnv).not.toBeNull();
    expect(crashEnv.active).toBe(true);
    expect(crashEnv.shimmerDecaySec).toBeGreaterThanOrEqual(2.2);

    const impact = resolveTwoBodyImpact(profile, crashCymbal, {
      impulseNs: 1.45,
      strikerNode: cymbalMallet,
      strikerGeomName: 'cymbal_mallet_head',
      localPoint: [0, -0.110, 0],
      sceneNodes: nodes,
    });
    const maxVoiceDecaySec = Math.max(...impact.voices.map((v) => v.decaySec));
    expect(impact.voices[0].decaySec).toBeGreaterThanOrEqual(3.2);
    expect(maxVoiceDecaySec).toBeGreaterThanOrEqual(3.5);
    expect(impact.crashShimmer).toBeDefined();
    expect(impact.crashShimmer!.decaySec).toBeGreaterThanOrEqual(2.2);
  });

  it('steps live MuJoCo: zero recoil self-choke, clamps felt choke 0.35..0.65 s after crash with Fn > 0.5 N & low slip, then plays unchoked Bar 2 crash', async () => {
    const mj = await load_mujoco();
    const xml = compileToMJCF(percussionKitPreset, -9.81, 1, 0, 0, 0, 0);
    const model = mj.MjModel.from_xml_string(xml);
    const data = new mj.MjData(model);

    try {
      mj.mj_forward(model, data);
      expect(data.ncon).toBe(0);

      const bodyId = (n: string) => mj.mj_name2id(model, mj.mjtObj.mjOBJ_BODY.value, n);
      const jointId = (n: string) => mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, n);

      const nodes = percussionKitPreset.nodes;
      const frame = nodes.find((n) => n.id === 'percussion_rig_frame')!;
      const crashCymbal = nodes.find((n) => n.id === 'crash_cymbal')!;
      const chokeArm = nodes.find((n) => n.id === 'cymbal_choke_arm')!;
      const cymbalMallet = nodes.find((n) => n.id === 'cymbal_crash_mallet')!;
      const snareBatter = nodes.find((n) => n.id === 'snare_batter_head')!;
      const snareStick = nodes.find((n) => n.id === 'snare_drumstick')!;

      const scriptFn = new Function('api', frame.script!) as (api: Record<string, unknown>) => void;
      const api = {
        id: frame.id,
        name: frame.name,
        getTime: () => data.time,
        getJointPosition: (name: string) => data.qpos[model.jnt_qposadr[jointId(name)]],
        getJointVelocity: (name: string) => data.qvel[model.jnt_dofadr[jointId(name)]],
        applyJointForce: (name: string, force: number) => {
          data.qfrc_applied[model.jnt_dofadr[jointId(name)]] += force;
        },
      };

      const cymbalBid = bodyId(crashCymbal.name);
      const malletBid = bodyId(cymbalMallet.name);
      const chokeBid = bodyId(chokeArm.name);
      const snareBid = bodyId(snareBatter.name);
      const stickBid = bodyId(snareStick.name);

      const dt = model.opt.timestep;
      const totalSteps = Math.round(3.20 / dt); // Covers Bar 1 choked crash (0.50->1.00 s) AND Bar 2 unchoked crash (2.06..3.20 s)

      let bar1CrashStrikeT = -1;
      let bar1CrashImpulseNs = 0;
      let bar2CrashStrikeT = -1;
      let prematureChokeContacts = 0;
      let firstChokeContactT = -1;
      let lastBar1ChokeContactT = -1;
      let peakChokeNormalForceN = 0;
      let settledChokeSlipSum = 0;
      let settledChokeSteps = 0;
      let maxChokeRad = 0;
      let bar2ChokeContacts = 0;
      let firstSnareHitRadialRatio = -1;

      const wrench = new mj.DoubleBuffer(6);
      try {
        for (let s = 0; s < totalSteps; s++) {
          for (let k = 0; k < model.nv; k++) data.qfrc_applied[k] = 0;
          scriptFn(api);
          mj.mj_step(model, data);
          const curChokeQ = data.qpos[model.jnt_qposadr[jointId('cymbal_choke_hinge')]];
          if (curChokeQ > maxChokeRad) maxChokeRad = curChokeQ;

          const t = data.time;
          const cv = data.contact;
          try {
            const ncon = cv.size();
            for (let c = 0; c < ncon; c++) {
              const ct = cv.get(c);
              if (!ct) continue;
              try {
                if (ct.efc_address < 0) continue;
                const b1 = model.geom_bodyid[ct.geom1];
                const b2 = model.geom_bodyid[ct.geom2];

                // Crash mallet <-> Crash cymbal
                if ((b1 === cymbalBid && b2 === malletBid) || (b2 === cymbalBid && b1 === malletBid)) {
                  mj.mj_contactForce(model, data, c, wrench);
                  const fn = Math.max(0, wrench.GetView()[0]);
                  if (fn > 0.2) {
                    if (t < 1.5) {
                      if (bar1CrashStrikeT < 0) bar1CrashStrikeT = t;
                      bar1CrashImpulseNs += fn * dt;
                    } else if (t >= 2.0 && bar2CrashStrikeT < 0) {
                      bar2CrashStrikeT = t;
                    }
                  }
                }

                // Snare drumstick <-> Snare batter head
                if ((b1 === snareBid && b2 === stickBid) || (b2 === snareBid && b1 === stickBid)) {
                  mj.mj_contactForce(model, data, c, wrench);
                  const fn = Math.max(0, wrench.GetView()[0]);
                  if (fn > 5.0 && firstSnareHitRadialRatio < 0) {
                    const dx = ct.pos[0] - snareBatter.pos[0];
                    const dy = ct.pos[1] - snareBatter.pos[1];
                    firstSnareHitRadialRatio = Math.hypot(dx, dy) / 0.178;
                  }
                }

                // Choke arm <-> Crash cymbal
                if ((b1 === cymbalBid && b2 === chokeBid) || (b2 === cymbalBid && b1 === chokeBid)) {
                  mj.mj_contactForce(model, data, c, wrench);
                  const fn = Math.max(0, wrench.GetView()[0]);
                  if (t < 0.80 && fn > 0.05) {
                    prematureChokeContacts++;
                  }
                  if (t >= 0.80 && t <= 1.70 && fn >= 0.5) {
                    if (firstChokeContactT < 0) firstChokeContactT = t;
                    lastBar1ChokeContactT = t;
                    if (fn > peakChokeNormalForceN) peakChokeNormalForceN = fn;
                    // Measure relative tangential patch speed once clamped (>= 40 ms into choke hold)
                    if (t >= firstChokeContactT + 0.040 && t <= 1.50) {
                      const vPadY = Math.abs(data.qvel[model.jnt_dofadr[jointId('cymbal_choke_hinge')]] * 0.010);
                      settledChokeSlipSum += vPadY;
                      settledChokeSteps++;
                    }
                  }
                  if (t >= 2.00 && fn > 0.05) {
                    bar2ChokeContacts++;
                  }
                }
              } finally {
                ct.delete();
              }
            }
          } finally {
            cv.delete();
          }
        }
      } finally {
        wrench.delete();
      }

      // Snare drumstick hits right near the center of the 14" batter head (r/a < 0.22)
      expect(firstSnareHitRadialRatio).toBeGreaterThanOrEqual(0);
      expect(firstSnareHitRadialRatio).toBeLessThan(0.22);

      // Bar 1 crash strike is vigorous, with ZERO accidental back-rim recoil choke before 0.80 s!
      expect(bar1CrashStrikeT).toBeGreaterThan(0.50);
      expect(bar1CrashStrikeT).toBeLessThan(0.56);
      expect(bar1CrashImpulseNs).toBeGreaterThan(0.5);
      expect(prematureChokeContacts).toBe(0);

      // Choke arm clamps onto the shimmering cymbal 0.35..0.65 s (specifically ~0.45..0.55 s) after impact!
      expect(firstChokeContactT).toBeGreaterThan(0);
      const chokeDelaySec = firstChokeContactT - bar1CrashStrikeT;
      expect(chokeDelaySec).toBeGreaterThanOrEqual(0.35);
      expect(chokeDelaySec).toBeLessThanOrEqual(0.65);
      expect(chokeDelaySec).toBeGreaterThanOrEqual(0.43);
      expect(chokeDelaySec).toBeLessThanOrEqual(0.57);

      // Firm viscoelastic AUDIO_DAMPING contact (>= 0.5 N, held ~0.5 s, low tangential slip < 0.04 m/s, zero pad punch-through)
      expect(peakChokeNormalForceN).toBeGreaterThan(0.5);
      expect(maxChokeRad).toBeLessThan(0.44);
      expect(lastBar1ChokeContactT - firstChokeContactT).toBeGreaterThanOrEqual(0.42);
      expect(settledChokeSteps).toBeGreaterThan(250);
      expect(settledChokeSlipSum / settledChokeSteps).toBeLessThan(0.04);
      expect(computeContactDampingRate(peakChokeNormalForceN, 0.92, 1.06)).toBeGreaterThan(2.0);

      // Choke arm lifts cleanly so Bar 2 crash (t ≈ 2.06 s) rings out completely unchoked!
      expect(bar2CrashStrikeT).toBeGreaterThan(2.06);
      expect(bar2CrashStrikeT).toBeLessThan(2.14);
      expect(bar2ChokeContacts).toBe(0);
    } finally {
      data.delete();
      model.delete();
    }
  });
});
