import { describe, expect, it } from 'vitest';
import { percussionKitPreset } from '../src/presets/percussionKit';
import { PRESETS } from '../src/presets/presetScenes';
import { singingBowlFrictionPreset } from '../src/presets/singingBowlFriction';
import { vibraphoneResonatorsPreset } from '../src/presets/vibraphoneResonators';
import { hzToNoteInfo, noteToHz } from '../src/utils/acousticTuning';
import {
  computeContactDampingRate,
  inferSurfaceRoughness,
  solveContactFrictionVoice,
} from '../src/utils/contactFrictionAcoustics';
import {
  evaluateTensionedMembrane,
  solveMembraneImpact,
} from '../src/utils/membraneAcoustics';
import { estimateBodyModes } from '../src/utils/modalAudio';
import { solveVonKarmanPlateImpact } from '../src/utils/nonlinearPlateAcoustics';
import { makePresetNoteCard } from '../src/utils/noteCards';
import {
  extractTubeAirColumn,
  resolveExternalTubeResonator,
} from '../src/utils/resonatorAcoustics';
import { PRESET_SHELF } from '../src/utils/sceneCatalog';
import { simulate } from './helpers/simulate';

describe('Wave 2B Acoustics Showcase Presets', () => {
  it('registers percussion_kit, singing_bowl_friction, and vibraphone_resonators on shelf "Make it" with note cards', () => {
    for (const id of ['percussion_kit', 'singing_bowl_friction', 'vibraphone_resonators'] as const) {
      expect(PRESETS[id]).toBeDefined();
      expect(PRESETS[id].scene.nodes.length).toBeGreaterThan(0);
      expect(PRESET_SHELF[id]).toBe('Make it');
      const card = makePresetNoteCard(id);
      expect(card).not.toBeNull();
      expect(card!.markdown).toMatch(/^#\s+/);
      expect(card!.markdown).toContain('## Try it');
    }
  });

  it('percussion_kit: compiles cleanly with 0 t=0 contacts, kettle-shifted timpani modes, snare buzz/glide, von Kármán crash & physical felt choking', async () => {
    const nodes = percussionKitPreset.nodes;
    const timpaniHead = nodes.find((n) => n.id === 'timpani_head')!;
    const snareBatter = nodes.find((n) => n.id === 'snare_batter_head')!;
    const snareReso = nodes.find((n) => n.id === 'snare_resonant_head')!;
    const crashCymbal = nodes.find((n) => n.id === 'crash_cymbal')!;
    const chokeArm = nodes.find((n) => n.id === 'cymbal_choke_arm')!;

    // 1. Kettle-coupled timpani head: harmonic 1 : 1.50 : 1.99 azimuthal Bessel ratios tuned to F3
    const timpEval = evaluateTensionedMembrane(timpaniHead, nodes)!;
    expect(timpEval).not.toBeNull();
    expect(timpEval.hasShellCavity).toBe(true);
    expect(timpEval.isClosedKettle).toBe(true);
    expect(hzToNoteInfo(timpEval.fundamentalHz).note).toBe('F3');
    expect(Math.abs(hzToNoteInfo(timpEval.fundamentalHz).cents)).toBeLessThanOrEqual(6);
    expect(timpEval.modeRatios[0]).toBeCloseTo(1.0, 2);
    expect(timpEval.modeRatios[1]).toBeGreaterThan(1.42);
    expect(timpEval.modeRatios[1]).toBeLessThan(1.56);
    expect(timpEval.modeRatios[2]).toBeGreaterThan(1.88);
    expect(timpEval.modeRatios[2]).toBeLessThan(2.08);

    // 2. Dual-head snare drum: batter & resonant heads produce snare wire rattle + hard-strike tension pitch glide
    const snareHit = solveMembraneImpact(snareBatter, nodes, { impulseNs: 0.85 })!;
    const resoEval = evaluateTensionedMembrane(snareReso, nodes)!;
    expect(snareHit).not.toBeNull();
    expect(snareHit.snareRattle).not.toBeNull();
    expect(snareHit.snareRattle!.gain).toBeGreaterThan(0.15);
    expect(snareHit.pitchGlide.semitones).toBeGreaterThan(0.5);
    expect(resoEval.snareRattle).not.toBeNull();

    // 3. Suspended thin bronze crash cymbal: linear on feather tap, von Kármán cascade + shimmer on crash hit
    const cymbalProfile = estimateBodyModes(crashCymbal);
    expect(solveVonKarmanPlateImpact(cymbalProfile, crashCymbal, 0.01)).toBeNull();
    const crashEnv = solveVonKarmanPlateImpact(cymbalProfile, crashCymbal, 1.65)!;
    expect(crashEnv).not.toBeNull();
    expect(crashEnv.active).toBe(true);
    expect(crashEnv.cascadeVoices.length).toBeGreaterThanOrEqual(6);
    expect(crashEnv.shimmerPeakGain).toBeGreaterThan(0.05);

    // 4. Headless MuJoCo verification: zero t=0 interpenetrations, active drum/cymbal hits, and sustained felt damper contact
    const sim = await simulate(percussionKitPreset);
    try {
      expect(sim.data.ncon).toBe(0);

      let peakCymbalTilt = 0;
      let peakTimpaniSlide = 0;
      let peakSnareSlide = 0;
      let chokeContactSteps = 0;

      const cymbalBid = sim.bodyId(crashCymbal.name);
      const chokeBid = sim.bodyId(chokeArm.name);
      expect(cymbalBid).toBeGreaterThan(0);
      expect(chokeBid).toBeGreaterThan(0);

      // Step 1.55 s (~775 steps at 2 ms) covering crash strike (0.06 s), snare hit (0.52 s), and felt choke (0.96..1.55 s)
      const totalSteps = Math.round(1.55 / sim.model.opt.timestep);
      for (let s = 0; s < totalSteps; s++) {
        sim.step(1);
        peakCymbalTilt = Math.max(peakCymbalTilt, Math.abs(sim.jointPos('cymbal_tilt')));
        peakTimpaniSlide = Math.max(peakTimpaniSlide, Math.abs(sim.jointPos('timpani_head_pad')));
        peakSnareSlide = Math.max(peakSnareSlide, Math.abs(sim.jointPos('snare_batter_pad')));

        if (sim.time() >= 1.05 && sim.time() <= 1.52) {
          const contactVec = sim.data.contact;
          try {
            const ncon = contactVec.size();
            for (let c = 0; c < ncon; c++) {
              const ct = contactVec.get(c);
              if (!ct) continue;
              try {
                const b1 = sim.model.geom_bodyid[ct.geom1];
                const b2 = sim.model.geom_bodyid[ct.geom2];
                if ((b1 === cymbalBid && b2 === chokeBid) || (b1 === chokeBid && b2 === cymbalBid)) {
                  chokeContactSteps++;
                  break;
                }
              } finally {
                ct.delete();
              }
            }
          } finally {
            contactVec.delete();
          }
        }
      }

      expect(peakTimpaniSlide).toBeGreaterThan(0.0002);
      expect(peakSnareSlide).toBeGreaterThan(0.0002);
      expect(peakCymbalTilt).toBeGreaterThan(0.01);
      // Felt damper arm maintains continuous physical contact for >= 150 steps (>= 300 ms >> 35 ms AUDIO_DAMPING gate!)
      expect(chokeContactSteps).toBeGreaterThan(150);
      expect(computeContactDampingRate(1.5, 0.92, cymbalProfile.massKg ?? 0.85)).toBeGreaterThan(2.0);
    } finally {
      sim.dispose();
    }
  });

  it('singing_bowl_friction: compiles cleanly with 0 t=0 contacts, 3D hollow bronze bodyIr, continuous rim singing & zig-zag chute rolling/scraping', async () => {
    const nodes = singingBowlFrictionPreset.nodes;
    const bowl = nodes.find((n) => n.id === 'tibetan_singing_bowl')!;
    const slateTier = nodes.find((n) => n.id === 'zigzag_slate_tier')!;
    const mapleChute = nodes.find((n) => n.id === 'zigzag_maple_chute')!;
    const steelMarble = nodes.find((n) => n.id === 'bearing_steel_marble')!;
    const glassMarble = nodes.find((n) => n.id === 'cobalt_glass_marble')!;
    const slatePuck = nodes.find((n) => n.id === 'slate_whetstone_puck')!;
    const bowlRig = nodes.find((n) => n.id === 'bowl_cushion_rig')!;
    const pujaMallet = bowlRig.children![0].children![0];

    const bowlProfile = estimateBodyModes(bowl, true);
    expect(bowlProfile.material.qualityQ).toBeGreaterThanOrEqual(700);
    expect(bowlProfile.bodyIr).not.toBeNull();
    expect(bowlProfile.bodyIr!.length).toBeGreaterThan(512);
    expect(inferSurfaceRoughness(slateTier)).toBeGreaterThan(inferSurfaceRoughness(mapleChute));

    const sim = await simulate(singingBowlFrictionPreset);
    try {
      expect(sim.data.ncon).toBe(0);

      const bowlBid = sim.bodyId(bowl.name);
      const pujaBid = sim.bodyId(pujaMallet.name);
      expect(bowlBid).toBeGreaterThan(0);
      expect(pujaBid).toBeGreaterThan(0);

      const startMarblePos = sim.bodyPos(steelMarble.name);
      const startGlassPos = sim.bodyPos(glassMarble.name);
      const startPuckPos = sim.bodyPos(slatePuck.name);

      let pujaBowlContactSteps = 0;
      const totalSteps = Math.round(1.60 / sim.model.opt.timestep);
      for (let s = 0; s < totalSteps; s++) {
        sim.step(1);
        if (sim.time() >= 0.25) {
          const contactVec = sim.data.contact;
          try {
            const ncon = contactVec.size();
            for (let c = 0; c < ncon; c++) {
              const ct = contactVec.get(c);
              if (!ct) continue;
              try {
                const b1 = sim.model.geom_bodyid[ct.geom1];
                const b2 = sim.model.geom_bodyid[ct.geom2];
                if ((b1 === bowlBid && b2 === pujaBid) || (b1 === pujaBid && b2 === bowlBid)) {
                  pujaBowlContactSteps++;
                  break;
                }
              } finally {
                ct.delete();
              }
            }
          } finally {
            contactVec.delete();
          }
        }
      }

      // Puja wand maintains steady uninterrupted contact around the bronze rim while orbiting at ~1.75 rad/s
      expect(pujaBowlContactSteps).toBeGreaterThan(500);
      const orbitSpeed = Math.abs(sim.jointVel('puja_orbit_hinge'));
      expect(orbitSpeed).toBeGreaterThan(1.3);

      const slipSpeed = 0.082 * orbitSpeed;
      const rimVoice = solveContactFrictionVoice(
        {
          nodeId: bowl.id,
          otherNodeId: 'puja_mallet',
          tangentSpeed: slipSpeed,
          rollSpeedMps: 0.0097 * orbitSpeed,
          normalForce: 1.38,
          muFriction: 0.38,
          rollingRatio: 0.106,
          circumferentialRub: 0.98,
          localPoint: [0.082, 0, 0.04],
          contactDurationSec: 0.65,
        },
        { primaryNode: bowl, primaryProfile: bowlProfile },
      );
      expect(rimVoice.active).toBe(true);
      expect(rimVoice.regime).toBe('rim_singing');
      expect(rimVoice.tonalActive).toBe(true);
      expect(rimVoice.bodyIr).not.toBeNull();

      // Marbles descend down the zig-zag chute and slate puck slides along the rocking lane
      const endMarblePos = sim.bodyPos(steelMarble.name);
      const endGlassPos = sim.bodyPos(glassMarble.name);
      const endPuckPos = sim.bodyPos(slatePuck.name);
      expect(endMarblePos[2]).toBeLessThan(startMarblePos[2] - 0.08);
      expect(endGlassPos[2]).toBeLessThan(startGlassPos[2] - 0.08);
      expect(Math.abs(endPuckPos[0] - startPuckPos[0])).toBeGreaterThan(0.03);

      const rollVoice = solveContactFrictionVoice(
        {
          nodeId: steelMarble.id,
          otherNodeId: mapleChute.id,
          tangentSpeed: 0.42,
          rollSpeedMps: 0.40,
          normalForce: 0.32,
          muFriction: 0.32,
          rollingRatio: 0.95,
          contactRadiusM: 0.010,
          contactDurationSec: 0.30,
        },
        { primaryNode: steelMarble, partnerNode: mapleChute },
      );
      expect(rollVoice.regime).toBe('rolling');

      const scrapeVoice = solveContactFrictionVoice(
        {
          nodeId: slatePuck.id,
          otherNodeId: 'rocking_chute_trough',
          tangentSpeed: 0.24,
          rollSpeedMps: 0.0,
          normalForce: 1.55,
          muFriction: 0.11,
          rollingRatio: 0.0,
          contactDurationSec: 0.35,
        },
        { primaryNode: slatePuck },
      );
      expect(scrapeVoice.regime).toBe('scraping');
    } finally {
      sim.dispose();
    }
  });

  it('vibraphone_resonators: compiles cleanly with 0 t=0 rail penetrations, couples all 6 bars to λ/4 tubes + tremolo fans, and engages pedal damper bar', async () => {
    const nodes = vibraphoneResonatorsPreset.nodes;
    const frame = nodes.find((n) => n.id === 'vibraphone_frame')!;
    const malletRail = frame.geoms.find((g) => g.name === 'vibe_mallet_rail')!;
    const railBackFaceY = (malletRail.pos?.[1] ?? 0) + (malletRail.size[1] ?? 0);

    const expectedNotes = ['C4', 'D4', 'E4', 'G4', 'A4', 'C5'] as const;

    // 1. Static rail clearance + resonator tube standing-wave air column + external resonator coupling for ALL 6 bars
    for (const note of expectedNotes) {
      const lower = note.toLowerCase();
      const bar = nodes.find((n) => n.id === `vibe_bar_${lower}`)!;
      const tube = nodes.find((n) => n.id === `vibe_tube_${lower}`)!;
      expect(bar).toBeDefined();
      expect(tube).toBeDefined();

      const barBox = bar.geoms.find((g) => g.name === 'aluminum_bar_body')!;
      expect(-barBox.size[1]).toBeGreaterThan(railBackFaceY + 0.015);

      const targetHz = noteToHz(note)!;
      const barProfile = estimateBodyModes(bar);
      expect(Math.abs(barProfile.fundamentalHz - targetHz) / targetHz).toBeLessThan(0.02);

      const col = extractTubeAirColumn(tube)!;
      expect(col).not.toBeNull();
      expect(col.endCondition).toBe('open_closed');
      expect(Math.abs(col.fundamentalHz - targetHz) / targetHz).toBeLessThan(0.02);

      const coupledSpinning = resolveExternalTubeResonator(
        bar,
        barProfile,
        barProfile.modes,
        nodes,
        {
          jointPositions: { vibe_tremolo_shaft: 0.6 },
          jointVelocities: { vibe_tremolo_shaft: 5.5 * Math.PI },
        },
      )!;
      expect(coupledSpinning).not.toBeNull();
      expect(coupledSpinning.tube.tubeNodeId).toBe(tube.id);
      expect(coupledSpinning.lorentzianDetuning).toBeGreaterThan(0.90);
      expect(coupledSpinning.geometricCoupling).toBeGreaterThan(0.25);
      expect(coupledSpinning.fundamentalGainMultiplier).toBeGreaterThan(1.45);
      expect(coupledSpinning.tremolo.active).toBe(true);
      expect(coupledSpinning.tremolo.vaneJointName).toBe('vibe_tremolo_shaft');
      expect(coupledSpinning.tremolo.tremoloHz).toBeCloseTo(5.5, 2);
      expect(coupledSpinning.tremolo.amDepth).toBeGreaterThan(0.35);
    }

    // 2. Headless MuJoCo verification: zero t=0 contacts, live motor tremolo spin, chordal mallet hits, and pedal damper bar muting
    const sim = await simulate(vibraphoneResonatorsPreset);
    try {
      expect(sim.data.ncon).toBe(0);

      const damperNode = nodes.find((n) => n.id === 'vibe_damper_bar')!;
      const damperBid = sim.bodyId(damperNode.name);
      const barBids = new Set(
        expectedNotes.map((n) => sim.bodyId(nodes.find((x) => x.id === `vibe_bar_${n.toLowerCase()}`)!.name)),
      );
      expect(damperBid).toBeGreaterThan(0);
      const dampedBarBids = new Set<number>();
      let c4PeakSlide = 0;

      const totalSteps = Math.round(1.85 / sim.model.opt.timestep);
      for (let s = 0; s < totalSteps; s++) {
        sim.step(1);
        c4PeakSlide = Math.max(c4PeakSlide, Math.abs(sim.jointPos('vibe_bar_c4_cord')));

        if (sim.time() >= 1.50 && sim.time() <= 1.85) {
          const contactVec = sim.data.contact;
          try {
            const ncon = contactVec.size();
            for (let c = 0; c < ncon; c++) {
              const ct = contactVec.get(c);
              if (!ct) continue;
              try {
                const b1 = sim.model.geom_bodyid[ct.geom1];
                const b2 = sim.model.geom_bodyid[ct.geom2];
                if (b1 === damperBid && barBids.has(b2)) dampedBarBids.add(b2);
                if (b2 === damperBid && barBids.has(b1)) dampedBarBids.add(b1);
              } finally {
                ct.delete();
              }
            }
          } finally {
            contactVec.delete();
          }
        }
      }

      // Live motor hinge drives butterfly tremolo shaft right to 5.5 * pi rad/s -> 5.5 Hz tremolo!
      const liveShaftVel = sim.jointVel('vibe_tremolo_shaft');
      expect(liveShaftVel / Math.PI).toBeCloseTo(5.5, 1);
      expect(c4PeakSlide).toBeGreaterThan(0.0002);
      // Pedal felt damper bar physically lifts against all 6 vibraphone bars during the mute window
      expect(dampedBarBids.size).toBe(6);
    } finally {
      sim.dispose();
    }
  });
});
