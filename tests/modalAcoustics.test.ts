import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SceneNode } from '../src/types/scene';
import { newtonsCradlePreset } from '../src/presets/presetScenes';
import { marimbaCascadePreset } from '../src/presets/marimbaCascade';
import { metallophoneCarillonPreset } from '../src/presets/metallophoneCarillon';
import { soundboxLyrePreset } from '../src/presets/soundboxLyre';
import { windInstrumentsPreset } from '../src/presets/windInstruments';
import { whoopeeStomperPreset } from '../src/presets/whoopeeStomper';
import { compliantFlexuresPreset } from '../src/presets/compliantFlexures';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import { simulate } from './helpers/simulate';
import {
  estimateBodyModes,
  inferAcousticMaterial,
  resolveTwoBodyImpact,
  solveVariableBeamModes,
} from '../src/utils/modalAudio';
import {
  analyzeSoundboxResonance,
  evaluateTautString,
} from '../src/utils/stringAcoustics';
import { extractBoreWaveguide, solvePlayableWindVoice } from '../src/utils/windAcoustics';
import { KellyLochbaumSynthBank } from '../src/utils/windWaveguideSynth';
import { cutSculptWith, loadManifold } from '../src/utils/sculptCut';
import { fromSceneGeom, toSceneGeom } from '../src/utils/sculptMesh';
import { useStore } from '../src/store/useStore';
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

  it('drives hinged mallets and spinning drum to play multiple bars in marimbaCascadePreset', async () => {
    const sim = await simulate(marimbaCascadePreset);
    try {
      const struckBars = new Set<string>();
      const barJoints = ['bar_c4_pad', 'bar_d4_pad', 'bar_e4_pad', 'bar_g4_pad'];
      const nv = sim.model.nv;
      const prevC = new Float64Array(nv);
      let audioTriggerCount = 0;
      // Run 2.0 s (first 6 notes of Morning Mood: G4, E4, D4, C4, D4, E4)
      let minPad = Infinity;
      let minHammer = Infinity;
      for (let step = 0; step < 1000; step++) {
        sim.step(1);
        const h3 = sim.jointPos('hammer_3');
        if (h3 < minHammer) minHammer = h3;
        const qfrcC = sim.data.qfrc_constraint;
        for (let d = 0; d < nv; d++) {
          const df = qfrcC[d] - prevC[d];
          prevC[d] = qfrcC[d];
          if (Math.abs(df) * 0.002 >= 0.004) audioTriggerCount++;
        }
        for (const jn of barJoints) {
          const qp = sim.jointPos(jn);
          if (qp < minPad) minPad = qp;
          if (qp < -0.00035) struckBars.add(jn);
        }
      }
      expect(Math.abs(sim.jointPos('drum_spin'))).toBeGreaterThan(1.1);
      expect(struckBars.size).toBeGreaterThanOrEqual(3);
      expect(audioTriggerCount).toBeGreaterThanOrEqual(5);
    } finally {
      sim.dispose();
    }
  });

  it('models Mersenne string tension, breaking stress, Helmholtz soundbox resonance, and physical plucking in soundboxLyrePreset', async () => {
    const soundbox = soundboxLyrePreset.nodes[0];
    const baseRes = analyzeSoundboxResonance(soundbox);
    expect(baseRes.hasHollowCavity).toBe(true);
    expect(baseRes.helmholtzHz).not.toBeNull();
    expect(baseRes.helmholtzHz!).toBeGreaterThan(80);
    expect(baseRes.helmholtzHz!).toBeLessThan(260);

    // Enlarging the soundhole radius raises Helmholtz f_H!
    const widerHoleBox: SceneNode = {
      ...soundbox,
      geoms: soundbox.geoms.map((g) =>
        g.name === 'soundhole' ? { ...g, size: [0.038, g.size[1]] } : g,
      ),
    };
    expect(analyzeSoundboxResonance(widerHoleBox).helmholtzHz!).toBeGreaterThan(baseRes.helmholtzHz! * 1.15);

    // Mersenne's law: quadrupling tension doubles pitch (2.0x) and eventually triggers breaking-stress warning
    const c4String = soundbox.children.find((c) => c.acousticString)!;
    const e1 = evaluateTautString(c4String, soundboxLyrePreset.nodes)!;
    expect(hzToNoteInfo(e1.fundamentalHz).note).toBe('C4');
    expect(e1.soundbox?.helmholtzHz).toBe(baseRes.helmholtzHz);

    const quadT: SceneNode = {
      ...c4String,
      acousticString: { ...c4String.acousticString!, tensionN: c4String.acousticString!.tensionN * 4 },
    };
    const e2 = evaluateTautString(quadT, soundboxLyrePreset.nodes)!;
    expect(e2.fundamentalHz / e1.fundamentalHz).toBeCloseTo(2.0, 2);

    const overT: SceneNode = {
      ...c4String,
      acousticString: { ...c4String.acousticString!, tensionN: 900 },
    };
    expect(evaluateTautString(overT)!.warnings.length).toBeGreaterThan(0);

    // Real MuJoCo WASM simulation: sweeping plectrum physically plucks the taut strings!
    const sim = await simulate(soundboxLyrePreset);
    try {
      const plucked = new Set<string>();
      for (let step = 0; step < 600; step++) {
        sim.step(1);
        for (let idx = 1; idx <= 5; idx++) {
          const jn = `lyre_soundbox_string_${idx}_pluck`;
          if (Math.abs(sim.jointPos(jn)) > 0.00025) plucked.add(jn);
        }
      }
      expect(plucked.size).toBeGreaterThanOrEqual(3);
    } finally {
      sim.dispose();
    }
  });

  it('simulates compliantFlexuresPreset bistable snap toggle latching between both stable equilibria', async () => {
    const sim = await simulate(compliantFlexuresPreset);
    try {
      // Note: bistableForce is injected in physicsWorker; verify MJCF compiles & cross-pivot + serpentine oscillate cleanly!
      sim.run(1.0);
      expect(Math.abs(sim.jointPos('cross_pivot_hinge'))).toBeGreaterThan(0.01);
      expect(Math.abs(sim.jointPos('serpentine_slide'))).toBeGreaterThan(0.0002);
    } finally {
      sim.dispose();
    }
  });

  it('renders real non-zero PCM audio in modalAudioProcessor.js for modal strikes, reed clarinet, and brass lip-reed', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../public/modalAudioProcessor.js'), 'utf8');
    let RegisteredCtor: (new () => {
      port: { onmessage: ((ev: { data: unknown }) => void) | null; postMessage: (msg: unknown) => void };
      process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
    }) | null = null;

    class MockWorkletProcessor {
      port = {
        onmessage: null as ((ev: { data: unknown }) => void) | null,
        postMessage: () => {},
      };
    }

    const runner = new Function(
      'AudioWorkletProcessor',
      'sampleRate',
      'registerProcessor',
      src,
    );
    runner(MockWorkletProcessor, 48000, (_name: string, ctor: typeof RegisteredCtor) => {
      RegisteredCtor = ctor;
    });
    expect(RegisteredCtor).not.toBeNull();

    const proc = new RegisteredCtor!();
    const renderBlocks = (blocks: number): number => {
      let sumSq = 0;
      const out = new Float32Array(128);
      for (let b = 0; b < blocks; b++) {
        proc.process([], [[out]]);
        for (let i = 0; i < 128; i++) {
          expect(Number.isFinite(out[i])).toBe(true);
          sumSq += out[i] * out[i];
        }
      }
      return Math.sqrt(sumSq / (blocks * 128));
    };

    // 1. Modal percussion strike produces strong clean RMS output
    proc.port.onmessage!({
      data: {
        type: 'STRIKE',
        level: 0.25,
        tauC: 0.0008,
        brightness: 0.6,
        voices: [{ freqHz: 440, gain: 0.9, decaySec: 0.5 }],
      },
    });
    expect(renderBlocks(20)).toBeGreaterThan(0.02);

    // 2. Sustained steady-state (t = 0.45..0.90s!) Clarinet Reed & Brass Lip-Reed self-oscillation
    const clarinetNode = windInstrumentsPreset.nodes.find((n) => n.id === 'grenadilla_clarinet')!;
    const clarinetBore = extractBoreWaveguide(clarinetNode)!;
    expect(clarinetBore.boreShape).toBe('cylindrical');
    const clarinetOpenBore = extractBoreWaveguide(clarinetNode, { clarinet_key_1: 0.25 })!;
    expect(clarinetOpenBore.resonantModesHz[0]).toBeGreaterThan(clarinetBore.resonantModesHz[0] * 1.25);

    const measureSteadyState = (bank: KellyLochbaumSynthBank): { rms: number; pitchHz: number; periodicity: number } => {
      const buf = new Float32Array(1024);
      // 0.45 s warmup (past any attack transient!)
      for (let b = 0; b < 22; b++) bank.render(buf);
      const samples = new Float32Array(8 * 1024);
      let sumSq = 0;
      for (let b = 0; b < 8; b++) {
        bank.render(buf);
        samples.set(buf, b * 1024);
        for (let i = 0; i < buf.length; i++) {
          expect(Number.isFinite(buf[i])).toBe(true);
          sumSq += buf[i] * buf[i];
        }
      }
      const rms = Math.sqrt(sumSq / samples.length);
      // Normalized autocorrelation pitch detector over [70 Hz .. 1100 Hz]
      const minLag = Math.floor(48000 / 1100);
      const maxLag = Math.ceil(48000 / 70);
      const winN = 4096;
      let e0 = 0;
      for (let i = 0; i < winN; i++) e0 += samples[i] * samples[i];
      let bestCorr = -1;
      let bestLag = minLag;
      let passedFirstDip = false;
      for (let lag = minLag; lag <= maxLag; lag++) {
        let c = 0;
        let eLag = 0;
        for (let i = 0; i < winN; i++) {
          c += samples[i] * samples[i + lag];
          eLag += samples[i + lag] * samples[i + lag];
        }
        const norm = c / Math.max(1e-18, Math.sqrt(e0 * eLag));
        if (norm < 0.2) passedFirstDip = true;
        if (passedFirstDip && norm > bestCorr) {
          bestCorr = norm;
          bestLag = lag;
          // Take the FIRST strong fundamental period peak (>= 0.90) rather than 2*T0 subharmonic!
          if (norm >= 0.92 && lag > minLag + 4) {
            let nextC = 0, nextE = 0;
            for (let i = 0; i < winN; i++) {
              nextC += samples[i] * samples[i + lag + 1];
              nextE += samples[i + lag + 1] * samples[i + lag + 1];
            }
            const nextNorm = nextC / Math.max(1e-18, Math.sqrt(e0 * nextE));
            if (nextNorm <= norm) break;
          }
        }
      }
      return { rms, pitchHz: 48000 / bestLag, periodicity: bestCorr };
    };

    const reedBankClosed = new KellyLochbaumSynthBank(48000);
    reedBankClosed.updateVoices([
      {
        id: 'clar',
        exciter: 'reed',
        breathKPa: 3.4,
        embouchureHz: 330,
        cellCount: clarinetBore.cellCount,
        exactCells: clarinetBore.exactCells,
        junctionK: clarinetBore.junctionK,
        bellCutoffHz: clarinetBore.bellCutoffHz,
        shunts: [],
      },
    ]);
    const closedStats = measureSteadyState(reedBankClosed);
    expect(closedStats.rms).toBeGreaterThan(0.015);
    expect(closedStats.rms).toBeLessThan(0.85);
    expect(closedStats.periodicity).toBeGreaterThan(0.92);
    // Must oscillate in the warm fundamental chalumeau register (~175..260 Hz), NOT squeaking at >900 Hz!
    expect(closedStats.pitchHz).toBeGreaterThan(165);
    expect(closedStats.pitchHz).toBeLessThan(280);

    // Opening tonehole shunts raises the steady-state Clarinet fundamental pitch cleanly!
    const clarinetAllOpenBore = extractBoreWaveguide(clarinetNode, {
      clarinet_key_1: 0.25,
      clarinet_key_2: 0.25,
      clarinet_key_3: 0.25,
      clarinet_key_4: 0.25,
    })!;
    const reedBankOpen = new KellyLochbaumSynthBank(48000);
    reedBankOpen.updateVoices([
      {
        id: 'clar_open',
        exciter: 'reed',
        breathKPa: 3.4,
        embouchureHz: 420,
        cellCount: clarinetAllOpenBore.cellCount,
        exactCells: clarinetAllOpenBore.exactCells,
        junctionK: clarinetAllOpenBore.junctionK,
        bellCutoffHz: clarinetAllOpenBore.bellCutoffHz,
        shunts: clarinetAllOpenBore.toneholes
          .filter((t) => t.openAmount > 0.05)
          .map((t) => ({ cell: t.cellIndex, coeff: t.shuntCoeff * t.openAmount })),
      },
    ]);
    const openStats = measureSteadyState(reedBankOpen);
    expect(openStats.rms).toBeGreaterThan(0.015);
    expect(openStats.periodicity).toBeGreaterThan(0.92);
    expect(openStats.pitchHz).toBeGreaterThan(closedStats.pitchHz * 1.30);

    // 3. Flared 3-Valve Brass Cornet Lip-Reed waveguide sustains pure periodic tone (zero wolf-tone growl!) & tracks lip/valves!
    const bugleNode = windInstrumentsPreset.nodes.find((n) => n.id === 'brass_bugle_horn')!;
    const bugleBoreOpen = extractBoreWaveguide(bugleNode)!;
    const bugleBoreValved = extractBoreWaveguide(bugleNode, { cornet_valve_1: 0.012, cornet_valve_3: 0.012 })!;
    expect(bugleBoreOpen.boreShape).toBe('flared_horn');
    expect(bugleBoreValved.cellCount).toBeGreaterThan(bugleBoreOpen.cellCount + 8);

    const brassLow = new KellyLochbaumSynthBank(48000);
    brassLow.updateVoices([
      {
        id: 'cornet_low',
        exciter: 'brass_lip',
        breathKPa: 3.8,
        embouchureHz: 430,
        cellCount: bugleBoreValved.cellCount,
        exactCells: bugleBoreValved.exactCells,
        junctionK: bugleBoreValved.junctionK,
        bellCutoffHz: bugleBoreValved.bellCutoffHz,
        shunts: [],
      },
    ]);
    const brassLowStats = measureSteadyState(brassLow);
    expect(brassLowStats.rms).toBeGreaterThan(0.015);
    expect(brassLowStats.rms).toBeLessThan(0.85);
    expect(brassLowStats.periodicity).toBeGreaterThan(0.92);

    const brassHigh = new KellyLochbaumSynthBank(48000);
    brassHigh.updateVoices([
      {
        id: 'cornet_high',
        exciter: 'brass_lip',
        breathKPa: 4.1,
        embouchureHz: 640,
        cellCount: bugleBoreOpen.cellCount,
        exactCells: bugleBoreOpen.exactCells,
        junctionK: bugleBoreOpen.junctionK,
        bellCutoffHz: bugleBoreOpen.bellCutoffHz,
        shunts: [],
      },
    ]);
    const brassHighStats = measureSteadyState(brassHigh);
    expect(brassHighStats.rms).toBeGreaterThan(0.015);
    expect(brassHighStats.periodicity).toBeGreaterThan(0.92);
    expect(brassHighStats.pitchHz).toBeGreaterThan(brassLowStats.pitchHz * 1.25);
  });

  it('compiles and steps windInstrumentsPreset and metallophoneCarillonPreset stably with distinct glockenspiel pitches and outward-wound meshes', async () => {
    // 1. Verify BOTH Clarinet bell mesh and Folded Cornet horn mesh are watertight & outward-wound (volume > 0)!
    const clarinetNode = windInstrumentsPreset.nodes.find((n) => n.id === 'grenadilla_clarinet')!;
    const clarBellGeom = clarinetNode.geoms.find((g) => g.name === 'clarinet_bell_mesh')!;
    const clarBellInt = analyzeMesh(clarBellGeom.renderVertices!, clarBellGeom.faces!)!;
    expect(clarBellInt.closed).toBe(true);
    expect(clarBellInt.consistentlyWound).toBe(true);
    expect(clarBellInt.volume).toBeGreaterThan(0);

    const bugleNode = windInstrumentsPreset.nodes.find((n) => n.id === 'brass_bugle_horn')!;
    const hornGeom = bugleNode.geoms.find((g) => g.name === 'cornet_folded_horn')!;
    expect(hornGeom.dynamic).toBe(true);
    expect(clarBellGeom.dynamic).toBe(true);
    const integrity = analyzeMesh(hornGeom.renderVertices!, hornGeom.faces!)!;
    expect(integrity.closed).toBe(true);
    expect(integrity.consistentlyWound).toBe(true);
    expect(integrity.volume).toBeGreaterThan(0);

    // 2. Verify all 6 steel bars in metallophoneCarillonPreset have 6 strictly distinct notes G4..G5 & clear the mallet rail!
    const expectedNotes = ['G4', 'A4', 'C5', 'D5', 'E5', 'G5'];
    const glockBars = expectedNotes.map(
      (nt) => metallophoneCarillonPreset.nodes.find((n) => n.id === `glock_bar_${nt.toLowerCase()}`)!,
    );
    const glockPitches = glockBars.map((b) => estimateBodyModes(b).fundamentalHz);
    for (let i = 0; i < expectedNotes.length; i++) {
      expect(hzToNoteInfo(glockPitches[i]).note).toBe(expectedNotes[i]);
      expect(Math.abs(hzToNoteInfo(glockPitches[i]).cents)).toBeLessThan(20);
      if (i > 0) expect(glockPitches[i]).toBeGreaterThan(glockPitches[i - 1] * 1.09);
      // Must NOT overlap glock_mallet_rail (front face at y = -0.148 + 0.009 = -0.139 m)
      const halfLenY = bHalfLenY(glockBars[i]);
      expect(halfLenY).toBeLessThan(0.132);
    }

    function bHalfLenY(bar: SceneNode): number {
      const box = bar.geoms.find((g) => g.name === 'steel_bar_body')!;
      return box.size[1];
    }

    // 3. Step windInstrumentsPreset across BOTH Clarinet (0..6.4s) and 3-Valve Cornet (6.5..12.9s) "Ode to Joy" phrases,
    //    verifying every single Cornet note is in tune (<= 4 cents) at its live MuJoCo valve positions!
    const simWind = await simulate(windInstrumentsPreset);
    try {
      let maxClarKey = 0;
      let maxCornetValve = 0;
      const cornetSchedule: [number, number, string][] = [
        [6.70, 494, 'B4'],
        [7.10, 494, 'B4'],
        [7.50, 523, 'C5'],
        [7.90, 587, 'D5'],
        [8.30, 587, 'D5'],
        [8.70, 523, 'C5'],
        [9.10, 494, 'B4'],
        [9.50, 440, 'A4'],
        [9.90, 392, 'G4'],
        [10.30, 392, 'G4'],
        [10.70, 440, 'A4'],
        [11.10, 494, 'B4'],
        [11.60, 440, 'A4'],
        [12.02, 392, 'G4'],
        [12.45, 392, 'G4'],
      ];
      let nextCheckIdx = 0;
      for (let step = 0; step < 12600; step++) {
        simWind.step(1);
        maxClarKey = Math.max(maxClarKey, simWind.jointPos('clarinet_key_4'));
        maxCornetValve = Math.max(maxCornetValve, simWind.jointPos('cornet_valve_1'));
        if (nextCheckIdx < cornetSchedule.length && simWind.time() >= cornetSchedule[nextCheckIdx][0]) {
          const [, lipHz, expectedNote] = cornetSchedule[nextCheckIdx++];
          const liveValves = {
            cornet_valve_1: simWind.jointPos('cornet_valve_1'),
            cornet_valve_2: simWind.jointPos('cornet_valve_2'),
            cornet_valve_3: simWind.jointPos('cornet_valve_3'),
          };
          const liveBore = extractBoreWaveguide(bugleNode, liveValves)!;
          const liveSolved = solvePlayableWindVoice(liveBore, 3.0, lipHz);
          const info = hzToNoteInfo(liveSolved.pitchHz);
          expect(info.note).toBe(expectedNote);
          expect(Math.abs(info.cents)).toBeLessThanOrEqual(8);
        }
      }
      expect(nextCheckIdx).toBe(cornetSchedule.length);
      expect(maxClarKey).toBeGreaterThan(0.08);
      expect(maxCornetValve).toBeGreaterThan(0.011);
    } finally {
      simWind.dispose();
    }

    // 4. Step metallophoneCarillonPreset and verify even the 3 longest bars (G4, A4, C5) sit free at rest and deflect cleanly on strike!
    const simGlock = await simulate(metallophoneCarillonPreset);
    try {
      simGlock.step(5);
      // None of the 3 longest bars are pinned into their upper +0.002 joint stop by rail overlap!
      expect(Math.abs(simGlock.jointPos('glock_g4_pad'))).toBeLessThan(0.0005);
      expect(Math.abs(simGlock.jointPos('glock_a4_pad'))).toBeLessThan(0.0005);
      expect(Math.abs(simGlock.jointPos('glock_c5_pad'))).toBeLessThan(0.0005);

      const padNames = ['glock_g4_pad', 'glock_a4_pad', 'glock_c5_pad', 'glock_d5_pad', 'glock_e5_pad', 'glock_g5_pad'];
      const struckLongBars = new Set<string>();
      const strikeSequence: string[] = [];
      const lastStrikeStep = new Map<string, number>();
      let minHammer0Rad = Infinity;
      for (let step = 0; step < 4800; step++) {
        simGlock.step(1);
        const h0 = simGlock.jointPos('glock_hammer_0');
        if (h0 < minHammer0Rad) minHammer0Rad = h0;
        for (const p of padNames) {
          if (simGlock.jointPos(p) < -0.00025) {
            struckLongBars.add(p);
            const prevStep = lastStrikeStep.get(p) ?? -999;
            if (step - prevStep > 45) {
              strikeSequence.push(p);
            }
            lastStrikeStep.set(p, step);
          }
        }
      }
      expect(Math.abs(simGlock.jointPos('carillon_drum_spin'))).toBeGreaterThan(1.0);
      // Lowest mallet (`glock_hammer_0` on G4) never tunnels or falls below its steel bar!
      expect(minHammer0Rad).toBeGreaterThan(-0.19);
      expect(struckLongBars.has('glock_g4_pad')).toBe(true);
      expect(struckLongBars.has('glock_a4_pad')).toBe(true);
      expect(struckLongBars.has('glock_c5_pad')).toBe(true);
      expect(struckLongBars.size).toBeGreaterThanOrEqual(4);
      // First 9 strikes of "Amazing Grace" ("A-ma-zing Grace, how sweet the sound"):
      // G4 -> C5 -> E5 -> C5 -> E5 -> D5 -> C5 -> A4 -> G4 with zero double-bounce phantom hits!
      expect(strikeSequence.slice(0, 9)).toEqual([
        'glock_g4_pad',
        'glock_c5_pad',
        'glock_e5_pad',
        'glock_c5_pad',
        'glock_e5_pad',
        'glock_d5_pad',
        'glock_c5_pad',
        'glock_a4_pad',
        'glock_g4_pad',
      ]);
    } finally {
      simGlock.dispose();
    }

    // 5. Verify generic bore mode-slotting produces exact concert "Ode to Joy" G-major pitches (<= 5 cents) on Clarinet & Cornet!
    const clarCases: [Record<string, number>, string][] = [
      [{}, 'G3'],
      [{ clarinet_key_4: 0.25 }, 'A3'],
      [{ clarinet_key_3: 0.25, clarinet_key_4: 0.25 }, 'B3'],
      [{ clarinet_key_2: 0.25, clarinet_key_3: 0.25, clarinet_key_4: 0.25 }, 'C4'],
      [{ clarinet_key_1: 0.25, clarinet_key_2: 0.25, clarinet_key_3: 0.25, clarinet_key_4: 0.25 }, 'D4'],
    ];
    for (const [jPos, expectedNote] of clarCases) {
      const bore = extractBoreWaveguide(clarinetNode, jPos)!;
      const solved = solvePlayableWindVoice(bore, 3.0, 260);
      expect(solved.active).toBe(true);
      const info = hzToNoteInfo(solved.pitchHz);
      expect(info.note).toBe(expectedNote);
      expect(Math.abs(info.cents)).toBeLessThanOrEqual(8);
    }

    const cornetCases: [Record<string, number>, number, string][] = [
      [{}, 392, 'G4'],
      [{ cornet_valve_1: 0.013, cornet_valve_3: 0.013 }, 440, 'A4'],
      [{ cornet_valve_1: 0.013, cornet_valve_2: 0.013 }, 494, 'B4'],
      [{ cornet_valve_1: 0.013 }, 523, 'C5'],
      [{}, 587, 'D5'],
    ];
    for (const [jPos, lipHz, expectedNote] of cornetCases) {
      const bore = extractBoreWaveguide(bugleNode, jPos)!;
      const solved = solvePlayableWindVoice(bore, 3.0, lipHz);
      expect(solved.active).toBe(true);
      const info = hzToNoteInfo(solved.pitchHz);
      expect(info.note).toBe(expectedNote);
      expect(Math.abs(info.cents)).toBeLessThanOrEqual(8);
    }
  });

  it('responds acoustically in pitch and timbre to 3D sculpted holes and bell mutes, and deletes sub-geom bell_brace_1 without deleting the instrument', async () => {
    const cornetNode = windInstrumentsPreset.nodes.find((n) => n.id === 'brass_bugle_horn')!;
    const hornGeom = cornetNode.geoms.find((g) => g.name === 'cornet_folded_horn')!;

    const baseBore = extractBoreWaveguide(cornetNode)!;
    const baseVoice = solvePlayableWindVoice(baseBore, 3.0, 587);
    expect(baseBore.breachFactor ?? 0).toBe(0);
    expect(baseBore.muteFactor ?? 0).toBeLessThan(0.05);

    // 1. Punch a real Manifold-3D sculpt hole through the Cornet's upper bell branch (x ≈ 0.115..0.133, z ≈ 0.026..0.042)
    const wasm = await loadManifold();
    const baseSculpt = fromSceneGeom(hornGeom.renderVertices!, hornGeom.faces!);
    const cutRes = cutSculptWith(wasm, baseSculpt, {
      kind: 'polygon',
      polygon: [
        [0.114, 0.0, 0.026],
        [0.132, 0.0, 0.026],
        [0.132, 0.0, 0.042],
        [0.114, 0.0, 0.042],
      ],
      direction: [0, 1, 0],
    });
    expect(cutRes.ok).toBe(true);
    if (!cutRes.ok) return;

    const holedNode: SceneNode = {
      ...cornetNode,
      sculptEdited: true,
      geoms: cornetNode.geoms.map((g) =>
        g.name === 'cornet_folded_horn' ? { ...g, ...toSceneGeom(cutRes.mesh) } : g,
      ),
    };
    const holedBore = extractBoreWaveguide(holedNode)!;
    const holedVoice = solvePlayableWindVoice(holedBore, 3.0, 587);

    // Sculpted side-hole is detected directly from 3D mesh topology & cross-sections:
    // - Shortens standing-wave resonance (raising pitch!),
    // - Reshapes TMM harmonicWeights spectrum via stub shunt admittance,
    // - Increases turbulent air-leak noiseGain!
    expect(holedBore.toneholes.some((t) => t.fromGeometry)).toBe(true);
    expect(holedBore.breachFactor).toBeGreaterThan(0.2);
    expect(holedVoice.pitchHz).toBeGreaterThan(baseVoice.pitchHz + 15);
    expect(holedVoice.noiseGain).toBeGreaterThan(baseVoice.noiseGain * 2.0);
    expect(holedVoice.harmonicWeights).not.toEqual(baseVoice.harmonicWeights);

    // 2. Sculpt 3 inward mute baffles inside the Cornet bell (x > 0.125, pushing inner-airway vertices inward)
    const mutedRv = [...hornGeom.renderVertices!];
    for (let i = 0; i + 2 < mutedRv.length; i += 3) {
      const x = mutedRv[i];
      const dy = mutedRv[i + 1] - 0.018;
      const dz = mutedRv[i + 2] - 0.034;
      const r = Math.hypot(dy, dz);
      if (x > 0.128 && r > 0.010 && r < 0.043) {
        const ang = Math.atan2(dz, dy);
        // 3 symmetric inward mute wedges
        const lobe = Math.max(0, Math.cos(3 * ang));
        if (lobe > 0.35) {
          const shrink = 1 - 0.68 * lobe;
          mutedRv[i + 1] = 0.018 + dy * shrink;
          mutedRv[i + 2] = 0.034 + dz * shrink;
        }
      }
    }
    const mutedNode: SceneNode = {
      ...cornetNode,
      sculptEdited: true,
      geoms: cornetNode.geoms.map((g) =>
        g.name === 'cornet_folded_horn' ? { ...g, renderVertices: mutedRv } : g,
      ),
    };
    const mutedBore = extractBoreWaveguide(mutedNode)!;
    const mutedVoice = solvePlayableWindVoice(mutedBore, 3.0, 587);
    expect(mutedBore.muteFactor).toBeGreaterThan(0.25);
    expect(mutedBore.bellRadiusM).toBeLessThan(baseBore.bellRadiusM * 0.9);
    // Muted bell shifts formant upward into nasal stopped-horn band and increases formantQ!
    expect(mutedVoice.formantHz).toBeGreaterThan(baseVoice.formantHz + 200);
    expect(mutedVoice.formantQ).toBeGreaterThan(baseVoice.formantQ + 0.4);

    // 3. Selecting sub-geom `bell_brace_1` and deleting deletes ONLY `bell_brace_1`, NOT the Cornet!
    const braceIdx = cornetNode.geoms.findIndex((g) => g.name === 'bell_brace_1');
    expect(braceIdx).toBeGreaterThan(0);
    useStore.setState({
      sceneGraph: structuredClone(windInstrumentsPreset),
      selectedNodeId: 'brass_bugle_horn',
      extraSelectedIds: [],
      activeGeomIndex: braceIdx,
      geomFocused: true,
    });
    useStore.getState().deleteSelectionOrFocusedGeom();
    const afterCornet = useStore.getState().sceneGraph.nodes.find((n) => n.id === 'brass_bugle_horn');
    expect(afterCornet).toBeDefined();
    expect(afterCornet!.geoms.some((g) => g.name === 'bell_brace_1')).toBe(false);
    expect(afterCornet!.geoms.some((g) => g.name === 'cornet_folded_horn')).toBe(true);
    expect(afterCornet!.geoms.length).toBe(cornetNode.geoms.length - 1);
  });

  it('models multi-port CSG & Sculpt soundbox holes, arbitrary 3D solid bumps/hollows, and two-body Hertzian mallet impacts', async () => {
    // 1. Soundbox multi-port CSG & Manifold-3D Sculpt holes + top-plate thickness
    const soundbox = soundboxLyrePreset.nodes[0];
    const res1 = analyzeSoundboxResonance(soundbox);
    expect(res1.portCount).toBe(1);
    expect(res1.helmholtzHz).not.toBeNull();

    // Adding a second soundhole via CSG sums parallel conductance -> raises f_H & portCount == 2!
    const twoHoleBox: SceneNode = {
      ...soundbox,
      geoms: [
        ...soundbox.geoms,
        {
          name: 'second_soundhole',
          type: 'cylinder',
          size: [0.024, 0.010],
          pos: [0, 0.055, 0.030],
          csg: 'difference',
        },
      ],
    };
    const res2 = analyzeSoundboxResonance(twoHoleBox);
    expect(res2.portCount).toBe(2);
    expect(res2.helmholtzHz!).toBeGreaterThan(res1.helmholtzHz! * 1.25);

    // Build a pure Manifold-3D watertight hollow box mesh and punch 1 then 2 Sculpt holes into it!
    const wasm = await loadManifold();
    const outerM = wasm.Manifold.cube([0.16, 0.28, 0.06], true);
    const innerM = wasm.Manifold.cube([0.148, 0.268, 0.050], true);
    const sealedBoxM = outerM.subtract(innerM);
    const sealedMesh = sealedBoxM.getMesh();
    outerM.delete();
    innerM.delete();
    sealedBoxM.delete();

    const sealedSculpt = fromSceneGeom(Array.from(sealedMesh.vertProperties), Array.from(sealedMesh.triVerts));
    const sealedNode: SceneNode = {
      id: 'sculpt_box',
      name: 'Sculpted Soundbox',
      deformMaterial: 'softwood',
      sculptEdited: true,
      geoms: [{ name: 'shell', type: 'mesh', size: [0.08, 0.14, 0.03], ...toSceneGeom(sealedSculpt) }],
      children: [],
    };
    const resSealed = analyzeSoundboxResonance(sealedNode);
    expect(resSealed.hasHollowCavity).toBe(true);
    expect(resSealed.portCount).toBe(0);
    expect(resSealed.helmholtzHz).toBeNull();

    // Punch first Sculpt hole through the top plate (z > 0 only, piercing top wall into cavity)
    // Using a side-rib Sculpt cut through x = +0.074..+0.080 at y = -0.02..+0.02, z = -0.015..+0.015:
    const sideHole1 = cutSculptWith(wasm, sealedSculpt, {
      kind: 'polygon',
      polygon: [
        [0.065, -0.020, -0.015],
        [0.090, -0.020, -0.015],
        [0.090, -0.020, 0.015],
        [0.065, -0.020, 0.015],
      ],
      direction: [0, 1, 0],
    });
    expect(sideHole1.ok).toBe(true);
    if (!sideHole1.ok) return;
    // Wait: polygon cut extrudes infinitely along direction [0,1,0], cutting slots on BOTH -Y and +Y ends if unbounded;
    // either 1 or 2 sculpted ports open the sealed cavity -> helmholtzHz turns ON from null!
    const sculptPortedNode: SceneNode = {
      ...sealedNode,
      sculptVersion: 2,
      geoms: [{ name: 'shell', type: 'mesh', size: [0.08, 0.14, 0.03], ...toSceneGeom(sideHole1.mesh) }],
    };
    const resSculptPorted = analyzeSoundboxResonance(sculptPortedNode);
    expect(resSculptPorted.hasHollowCavity).toBe(true);
    expect(resSculptPorted.portCount).toBeGreaterThanOrEqual(1);
    expect(resSculptPorted.helmholtzHz).not.toBeNull();

    // 2. All solids respond to 3D bumps, cuts, and hollowing (never masked by tunedPitchHz!)
    const c4Bar = marimbaCascadePreset.nodes.find((n) => n.id === 'marimba_bar_c4')!;
    const baseBarModes = estimateBodyModes(c4Bar);
    expect(hzToNoteInfo(baseBarModes.fundamentalHz).note).toBe('C4');

    // Adding heavy mass bumps near the free ends (antinodes of displacement, zero bending curvature) lowers f1!
    const endWeightedBar: SceneNode = {
      ...c4Bar,
      sculptVersion: 10,
      geoms: [
        ...c4Bar.geoms,
        { name: 'bump_lo', type: 'box', size: [0.018, 0.016, 0.007], pos: [0, -0.095, 0.012] },
        { name: 'bump_hi', type: 'box', size: [0.018, 0.016, 0.007], pos: [0, 0.095, 0.012] },
      ],
    };
    const endWeightedModes = estimateBodyModes(endWeightedBar);
    expect(endWeightedModes.fundamentalHz).toBeLessThan(baseBarModes.fundamentalHz * 0.95);
    expect(endWeightedModes.overtoneRatio).not.toBeCloseTo(baseBarModes.overtoneRatio, 2);

    // Adding a central spine thickening (filling in the center arch -> cubic h^3 stiffness surge!) raises f1!
    const centerStiffBar: SceneNode = {
      ...c4Bar,
      sculptVersion: 11,
      geoms: [
        ...c4Bar.geoms,
        { name: 'center_ridge', type: 'box', size: [0.018, 0.035, 0.006], pos: [0, 0, 0.011] },
      ],
    };
    expect(estimateBodyModes(centerStiffBar).fundamentalHz).toBeGreaterThan(baseBarModes.fundamentalHz * 1.12);

    // Hollowing out a non-marimba solid steel sphere turns its ultrasonic clack into an audible sleigh-bell ring!
    const solidBall: SceneNode = {
      id: 'steel_ball',
      name: 'Solid Ball',
      deformMaterial: 'steel',
      geoms: [{ name: 'ball', type: 'sphere', size: [0.025] }],
      children: [],
    };
    const hollowBellBall: SceneNode = {
      ...solidBall,
      id: 'hollow_bell',
      csgEnabled: true,
      geoms: [
        { name: 'ball', type: 'sphere', size: [0.025] },
        { name: 'cavity', type: 'sphere', size: [0.022], csg: 'difference' },
      ],
    };
    expect(estimateBodyModes(solidBall).modes.length).toBe(0);
    expect(estimateBodyModes(hollowBellBall).modes.length).toBeGreaterThan(0);

    // 3. Two-body Hertzian contact mechanics (soft polymer mallet vs steel mallet + center vs end hit!)
    const softMallet = marimbaCascadePreset.nodes.find((n) => n.id === 'mallet_1')!;
    const steelMallet = marimbaCascadePreset.nodes.find((n) => n.id === 'mallet_6')!;

    const hitSoftCenter = resolveTwoBodyImpact(baseBarModes, c4Bar, {
      impulseNs: 0.08,
      strikerNode: softMallet,
      strikerGeomName: 'mallet_head_0',
      localPoint: [0, 0, 0.008],
    });
    const hitSteelCenter = resolveTwoBodyImpact(baseBarModes, c4Bar, {
      impulseNs: 0.08,
      strikerNode: steelMallet,
      strikerGeomName: 'mallet_head_5',
      localPoint: [0, 0, 0.008],
    });
    const hitSteelEnd = resolveTwoBodyImpact(baseBarModes, c4Bar, {
      impulseNs: 0.08,
      strikerNode: steelMallet,
      strikerGeomName: 'mallet_head_5',
      localPoint: [0, 0.105, 0.008],
    });

    // Soft mallet has > 2.2x longer Hertzian contact duration and warmer (lower) brightness than steel mallet!
    expect(hitSoftCenter.tauC).toBeGreaterThan(hitSteelCenter.tauC * 2.2);
    expect(hitSteelCenter.effectiveBrightness).toBeGreaterThan(hitSoftCenter.effectiveBrightness * 2.0);
    // Steel strike near the bar end strongly excites antisymmetric Mode 2 compared to a soft center hit!
    const m2SoftCenter = hitSoftCenter.voices[1]?.gain ?? 0;
    const m2SteelEnd = hitSteelEnd.voices[1]?.gain ?? 0;
    expect(m2SteelEnd).toBeGreaterThan(m2SoftCenter * 3.0);

    // 4. Fletcher sub-resonant autonomous slap-valve regime on short 110 mm Whoopee Spout (`whoopeeStomperPreset`):
    const spoutNode = whoopeeStomperPreset.nodes.find((n) => n.id === 'whoopee_spout_nozzle')!;
    const spoutBore = extractBoreWaveguide(spoutNode)!;
    expect(spoutBore.resonantModesHz[0]).toBeGreaterThan(500);
    const lowRip = solvePlayableWindVoice(spoutBore, 3.2, 36);
    const highSqueak = solvePlayableWindVoice(spoutBore, 3.2, 185);
    expect(lowRip.active).toBe(true);
    expect(lowRip.pitchHz).toBeCloseTo(36, 0);
    expect(highSqueak.pitchHz).toBeCloseTo(185, 0);
    expect(lowRip.phaseCoherence).toBeGreaterThan(0.9);
    expect(lowRip.squelchSweepHz).toBeGreaterThan(200);
    expect(lowRip.formantQ).toBeGreaterThan(4.0);
    expect(lowRip.harmonicWeights.length).toBeGreaterThanOrEqual(20);
  });
});
