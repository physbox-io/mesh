import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SceneNode } from '../src/types/scene';
import { bowedCelloPreset } from '../src/presets/bowedCello';
import { percussionKitPreset } from '../src/presets/percussionKit';
import { vibraphoneResonatorsPreset } from '../src/presets/vibraphoneResonators';
import { windInstrumentsPreset } from '../src/presets/windInstruments';
import { evaluateGustWind, solveAeroAcousticVoice } from '../src/utils/aeroAcoustics';
import { resolveGuardedBowHold, solveContactFrictionVoice } from '../src/utils/contactFrictionAcoustics';
import { solveMembraneImpact, tuneMembraneToPitch } from '../src/utils/membraneAcoustics';
import { estimateBodyModes, inferColliderContactProps } from '../src/utils/modalAudio';
import {
  postWorkletAeroUpdate,
  postWorkletBowedUpdate,
  postWorkletFrictionUpdate,
  postWorkletWindUpdate,
} from '../src/utils/modalAudioWorklet';
import { solveVonKarmanPlateImpact } from '../src/utils/nonlinearPlateAcoustics';
import { resolveExternalTubeResonator, tuneResonatorTubeToPitch } from '../src/utils/resonatorAcoustics';
import {
  analyze3DCavityAndPorts,
  analyze3DSolidCrossSections,
  simulate3DVibroAcousticIR,
  solveGeneralSectionBeamModes,
} from '../src/utils/solidAcoustics3D';
import { resolveSpatialAcousticParams } from '../src/utils/spatialAcoustics';
import {
  evaluateTautString,
  resolveStringBetaFromPoint,
  solveBowedStringVoice,
  solveSympatheticStringCoupling,
} from '../src/utils/stringAcoustics';
import {
  getModalVoicePoolStats,
  MAX_ACTIVE_CONVOLVERS,
  MAX_ACTIVE_IMPACTS,
  MAX_ACTIVE_OSCILLATORS,
  silenceModalVoices,
  triggerOrMutateModalVoice,
} from '../src/utils/voiceSympathyPool';
import { extractBoreWaveguide, solvePlayableWindVoice } from '../src/utils/windAcoustics';
import { KellyLochbaumSynthBank } from '../src/utils/windWaveguideSynth';

function findNode(nodes: SceneNode[], pred: (n: SceneNode) => boolean): SceneNode | null {
  for (const n of nodes) {
    if (pred(n)) return n;
    const sub = findNode(n.children ?? [], pred);
    if (sub) return sub;
  }
  return null;
}

function createCountingMockAudioContext(sampleRate = 48000) {
  let now = 1.0;
  let createBufferCount = 0;
  let createNodeCount = 0;
  let setTargetCalls = 0;
  let periodicWaveCalls = 0;

  const makeParam = (init = 0) => ({
    value: init,
    setValueAtTime: () => {},
    linearRampToValueAtTime: () => {},
    exponentialRampToValueAtTime: () => {},
    setTargetAtTime: () => { setTargetCalls++; },
    cancelScheduledValues: () => {},
    cancelAndHoldAtTime: () => {},
  });

  const makeNode = (extra: Record<string, unknown> = {}, count = true) => {
    if (count) createNodeCount++;
    return {
      connect: () => {},
      disconnect: () => {},
      ...extra,
    };
  };

  const ctx = {
    get currentTime() { return now; },
    set currentTime(t: number) { now = t; },
    sampleRate,
    state: 'running',
    destination: makeNode({}, false),
    resume: () => Promise.resolve(),
    suspend: () => Promise.resolve(),
    createGain: () => makeNode({ gain: makeParam(1) }),
    createOscillator: () => makeNode({
      type: 'sine',
      frequency: makeParam(440),
      detune: makeParam(0),
      setPeriodicWave: () => {},
      start: () => {},
      stop: () => {},
    }),
    createBiquadFilter: () => makeNode({
      type: 'lowpass',
      frequency: makeParam(1000),
      Q: makeParam(1),
      gain: makeParam(0),
    }),
    createWaveShaper: () => makeNode({ curve: null, oversample: 'none' }),
    createStereoPanner: () => makeNode({ pan: makeParam(0) }),
    createDynamicsCompressor: () => makeNode({
      threshold: makeParam(-3),
      knee: makeParam(6),
      ratio: makeParam(10),
      attack: makeParam(0.002),
      release: makeParam(0.12),
    }),
    createChannelSplitter: () => makeNode(),
    createChannelMerger: () => makeNode(),
    createConvolver: () => makeNode({ normalize: false, buffer: null }),
    createPeriodicWave: () => {
      periodicWaveCalls++;
      return {};
    },
    createBuffer: (ch: number, len: number, sr: number) => {
      createBufferCount++;
      const channels = Array.from({ length: ch }, () => new Float32Array(len));
      return {
        numberOfChannels: ch,
        length: len,
        sampleRate: sr,
        getChannelData: (i: number) => channels[i],
      };
    },
    createBufferSource: () => makeNode({
      buffer: null,
      loop: false,
      onended: null as (() => void) | null,
      start: () => {},
      stop: () => {},
    }),
  } as unknown as AudioContext;

  return {
    ctx,
    getCounts: () => ({ createBufferCount, createNodeCount, setTargetCalls, periodicWaveCalls }),
    resetCounts: () => {
      createBufferCount = 0;
      createNodeCount = 0;
      setTargetCalls = 0;
      periodicWaveCalls = 0;
    },
    advanceTime: (dt: number) => { now += dt; },
  };
}

describe('Acoustics Performance Audit & Regression Suite', () => {
  it('keeps 60 Hz bowed cello + sympathy hot path fast and invalidates caches on bridge/tension edits', () => {
    const nodes = structuredClone(bowedCelloPreset.nodes);
    const a3 = findNode(nodes, (n) => !!n.acousticString && /A3|string_4/i.test(`${n.id} ${n.name}`))
      ?? findNode(nodes, (n) => !!n.acousticString)!;
    expect(a3).toBeTruthy();

    // Warm up coupled soundbox + sibling strings (1 cold frame)
    const warmSolved = solveBowedStringVoice({
      node: a3,
      sceneNodes: nodes,
      bowVelocityMps: 0.25,
      bowForceN: 0.75,
      bowBeta: 0.12,
    });
    expect(warmSolved.active).toBe(true);
    const warmSymp = solveSympatheticStringCoupling(a3, nodes, {
      sourcePitchHz: warmSolved.pitchHz,
      sourcePartials: warmSolved.stringHarmonicWeights.map((w, i) => ({ freqHz: (i + 1) * warmSolved.pitchHz, gain: w })),
    });
    expect(warmSymp.length).toBeGreaterThan(0);

    // Steady-state 120 frames (2 s @ 60 Hz)
    const t0 = performance.now();
    for (let f = 0; f < 120; f++) {
      const beta = resolveStringBetaFromPoint(a3, [0, 0.05, 0], 1.0, nodes);
      const solved = solveBowedStringVoice({
        node: a3,
        sceneNodes: nodes,
        bowVelocityMps: 0.22 + 0.04 * Math.sin(f * 0.1),
        bowForceN: 0.70,
        bowBeta: beta,
      });
      const symp = solveSympatheticStringCoupling(a3, nodes, {
        sourcePitchHz: solved.pitchHz,
        sourcePartials: solved.stringHarmonicWeights.map((w, i) => ({ freqHz: (i + 1) * solved.pitchHz, gain: w })),
      });
      expect(solved.active).toBe(true);
      expect(symp.length).toBeGreaterThan(0);
    }
    const steadyMs = performance.now() - t0;
    console.log(`[BENCH] bowed_cello_steady_120f_ms=${steadyMs.toFixed(2)}`);
    expect(steadyMs).toBeLessThan(200);

    // Cache invalidation #1: increasing tension MUST shift pitch immediately
    const origTension = a3.acousticString!.tensionN;
    a3.acousticString!.tensionN = origTension * 1.44; // +20% frequency
    const tighter = evaluateTautString(a3, nodes)!;
    expect(tighter.fundamentalHz).toBeGreaterThan(warmSolved.pitchHz * 1.15);
    a3.acousticString!.tensionN = origTension;

    // Cache invalidation #2: detaching string into mid-air MUST immediately drop bridgeCoupling to 0!
    const beforeCoupling = evaluateTautString(a3, nodes)!.bridgeCoupling;
    expect(beforeCoupling).toBeGreaterThan(0.5);
    a3.pos = [a3.pos?.[0] ?? 0, a3.pos?.[1] ?? 0, (a3.pos?.[2] ?? 0) + 0.35];
    const floatingEval = evaluateTautString(a3, nodes)!;
    expect(floatingEval.bridgeCoupling).toBe(0);
  });

  it('keeps 42 Hz vibraphone resonator sync fast and invalidates local tube cache on resize', () => {
    const nodes = structuredClone(vibraphoneResonatorsPreset.nodes);
    const bar = findNode(nodes, (n) => /bar/i.test(`${n.id} ${n.name}`) && typeof n.tunedPitchHz === 'number')!;
    expect(bar).toBeTruthy();
    const profile = estimateBodyModes(bar, false, nodes);
    const hingeName = findNode(nodes, (n) => (n.joints ?? []).some((j) => j.type === 'hinge'))?.joints?.[0]?.name ?? '';

    // Warm 1 frame
    const warm = resolveExternalTubeResonator(bar, profile, profile.modes, nodes, {
      jointPositions: { [hingeName]: 0 },
      jointVelocities: { [hingeName]: 15.0 },
    });
    expect(warm).not.toBeNull();

    const t0 = performance.now();
    let lastRes = warm;
    for (let f = 0; f < 120; f++) {
      lastRes = resolveExternalTubeResonator(bar, profile, profile.modes, nodes, {
        jointPositions: { [hingeName]: f * 0.1 },
        jointVelocities: { [hingeName]: 15.0 },
      });
    }
    const elapsedMs = performance.now() - t0;
    console.log(`[BENCH] vibraphone_resonator_steady_120f_ms=${elapsedMs.toFixed(2)}`);
    expect(lastRes).not.toBeNull();
    expect(elapsedMs).toBeLessThan(200);

    // Cache invalidation: retuning the coupled tube MUST update its fundamentalHz immediately
    const tubeNode = findNode(nodes, (n) => n.id === lastRes!.tube.tubeNodeId);
    if (tubeNode) {
      const targetHz = Math.round(lastRes!.tube.fundamentalHz * 1.25);
      const retuned = tuneResonatorTubeToPitch(tubeNode, targetHz);
      Object.assign(tubeNode, retuned);
      const after = resolveExternalTubeResonator(bar, profile, profile.modes, nodes);
      expect(after).not.toBeNull();
      expect(Math.abs(after!.tube.fundamentalHz - targetHz)).toBeLessThan(12);
    }
  });

  it('keeps 3D FDTD IR, beam eigenmodes, and solid cavity cache bounded and fast', () => {
    const cello = findNode(bowedCelloPreset.nodes, (n) => /body|corpus|cello/i.test(`${n.id} ${n.name}`) && (n.geoms?.length ?? 0) > 0)!;
    const bridge = findNode(bowedCelloPreset.nodes, (n) => /bridge/i.test(`${n.id} ${n.name}`));
    expect(cello).toBeTruthy();

    const coldCello: SceneNode = { ...structuredClone(cello), id: `cold_cello_${Date.now()}` };
    const tSec0 = performance.now();
    const sec = analyze3DSolidCrossSections(coldCello);
    const secMs = performance.now() - tSec0;

    const tCav0 = performance.now();
    const cav = analyze3DCavityAndPorts(coldCello);
    const cavMs = performance.now() - tCav0;

    const tIr0 = performance.now();
    const ir = simulate3DVibroAcousticIR(
      coldCello,
      { modulusGPa: 11.5, density: 440, qualityQ: 140 },
      bridge,
      { modulusGPa: 12.5, density: 680, qualityQ: 180 },
    );
    const irMs = performance.now() - tIr0;

    const tEig0 = performance.now();
    let lastEig = solveGeneralSectionBeamModes(0.32, 12.5e9, 750, sec.areaProfile, sec.inertiaThickProfile, true);
    for (let k = 0; k < 200; k++) {
      lastEig = solveGeneralSectionBeamModes(0.32, 12.5e9, 750, sec.areaProfile, sec.inertiaThickProfile, true);
    }
    const eigMs = performance.now() - tEig0;

    // Verify uniform free-free beam eigenmode accuracy (f2/f1 ≈ 2.7565)
    const uniformA = new Array<number>(24).fill(0.03 * 0.01);
    const uniformI = new Array<number>(24).fill((0.03 * Math.pow(0.01, 3)) / 12);
    const uniformModes = solveGeneralSectionBeamModes(0.30, 69e9, 2700, uniformA, uniformI, true);
    expect(uniformModes.frequenciesHz[1] / uniformModes.frequenciesHz[0]).toBeCloseTo(2.7565, 1);

    // Exercise 300 distinct non-cavity solid boxes to confirm cavityCache stays bounded (no unbounded leak)
    for (let i = 0; i < 300; i++) {
      const solidBox: SceneNode = {
        id: `solid_box_leak_check_${i}`,
        name: `Box ${i}`,
        type: 'body',
        pos: [0, 0, 0],
        joints: [],
        geoms: [{ name: 'b', type: 'box', size: [0.02 + i * 0.0001, 0.02, 0.02] }],
      };
      const r = analyze3DCavityAndPorts(solidBox);
      expect(r.hasHollowCavity).toBe(false);
    }

    console.log(
      `[BENCH] solid3d_sec_ms=${secMs.toFixed(2)} cav_ms=${cavMs.toFixed(2)} fdtd_ir_ms=${irMs.toFixed(2)} beam_eig_200_ms=${eigMs.toFixed(2)}`,
    );
    expect(cav.hasHollowCavity).toBe(true);
    expect(ir).not.toBeNull();
    expect(ir!.ir.length).toBe(4096);
    expect(lastEig.frequenciesHz.length).toBeGreaterThanOrEqual(3);
    expect(eigMs).toBeLessThan(100);
  });

  it('caches steady-state 60 Hz wind waveguide extraction and invalidates on valve/key changes', () => {
    const nodes = structuredClone(windInstrumentsPreset.nodes);
    const horn = findNode(nodes, (n) => !!n.windInstrument && n.windInstrument.exciter === 'brass_lip')!;
    const clarinet = findNode(nodes, (n) => !!n.windInstrument && n.windInstrument.exciter === 'reed')!;
    expect(horn).toBeTruthy();
    expect(clarinet).toBeTruthy();

    // Cold TMM solves across 6 distinct bore lengths
    const tCold0 = performance.now();
    for (let k = 0; k < 6; k++) {
      const modHorn: SceneNode = {
        ...horn,
        windInstrument: { ...horn.windInstrument!, boreLengthM: 0.72 + k * 0.037 },
      };
      const bore = extractBoreWaveguide(modHorn);
      expect(bore).not.toBeNull();
      expect(bore!.resonantModesHz.length).toBeGreaterThan(0);
    }
    const coldTmmMs = performance.now() - tCold0;

    // Warm 1 frame of horn + clarinet
    const warmHorn = extractBoreWaveguide(horn, {})!;
    const warmClar = extractBoreWaveguide(clarinet, {})!;
    expect(warmHorn.resonantModesHz.length).toBeGreaterThan(0);
    expect(warmClar.resonantModesHz.length).toBeGreaterThan(0);

    // 180 steady-state frames (3 s @ 60 Hz)
    const tHot0 = performance.now();
    for (let f = 0; f < 180; f++) {
      const b1 = extractBoreWaveguide(horn, {})!;
      const b2 = extractBoreWaveguide(clarinet, {})!;
      const v1 = solvePlayableWindVoice(b1, 3.0, 261.63);
      const v2 = solvePlayableWindVoice(b2, 2.8, 293.66);
      expect(v1.active).toBe(true);
      expect(v2.active).toBe(true);
    }
    const steadyWindMs = performance.now() - tHot0;
    console.log(`[BENCH] wind_tmm_6cold_ms=${coldTmmMs.toFixed(2)} wind_steady_180f_ms=${steadyWindMs.toFixed(2)}`);
    expect(steadyWindMs).toBeLessThan(80);

    // Cache invalidation: depressing brass valves MUST lengthen bore & lower resonant pitch
    const valveName = horn.windInstrument?.valveJoints?.[0]?.jointName;
    if (valveName) {
      const valvedHorn = extractBoreWaveguide(horn, { [valveName]: 0.015 })!;
      expect(valvedHorn.lengthM).toBeGreaterThan(warmHorn.lengthM * 1.02);
    }
    // Cache invalidation: opening clarinet tonehole MUST shift resonant pitch upward
    const keyName = clarinet.windInstrument?.toneholeJoints?.[0]?.jointName;
    if (keyName) {
      const openClar = extractBoreWaveguide(clarinet, { [keyName]: 0.25 })!;
      expect(openClar.resonantModesHz[0]).toBeGreaterThan(warmClar.resonantModesHz[0]);
    }
  });

  it('keeps Kelly-Lochbaum waveguide & AudioWorklet process() well within real-time quantum budget', () => {
    const bank = new KellyLochbaumSynthBank(44100, 4);
    const bore = extractBoreWaveguide(
      findNode(windInstrumentsPreset.nodes, (n) => !!n.windInstrument && n.windInstrument.exciter === 'reed')!,
    )!;
    const shunts = [
      { cell: Math.floor(bore.cellCount * 0.35), coeff: -0.45 },
      { cell: Math.floor(bore.cellCount * 0.48), coeff: -0.52 },
      { cell: Math.floor(bore.cellCount * 0.62), coeff: -0.58 },
      { cell: Math.floor(bore.cellCount * 0.75), coeff: -0.62 },
    ];
    bank.updateVoices([{
      id: 'clarinet',
      exciter: 'reed',
      breathKPa: 3.2,
      embouchureHz: 320,
      cellCount: bore.cellCount,
      exactCells: bore.exactCells,
      sampleRate: 48000,
      junctionK: bore.junctionK,
      bellCutoffHz: bore.bellCutoffHz,
      shunts,
    }]);

    const outL = new Float32Array(128);
    const outR = new Float32Array(128);
    const tWg0 = performance.now();
    let energy = 0;
    let allFinite = true;
    for (let q = 0; q < 345; q++) {
      bank.render(outL, outR);
      for (let i = 0; i < 128; i++) {
        const s = outL[i];
        if (!Number.isFinite(s)) allFinite = false;
        energy += s * s;
      }
    }
    const wgMs = performance.now() - tWg0;
    expect(allFinite).toBe(true);
    expect(energy).toBeGreaterThan(0.01);
    expect(wgMs).toBeLessThan(250);

    // Load public/modalAudioProcessor.js and run 1.0 s @ 48 kHz (375 quanta)
    const src = readFileSync(resolve(process.cwd(), 'public/modalAudioProcessor.js'), 'utf8');
    let ProcessorCtor: new () => {
      port: { onmessage: ((ev: { data: unknown }) => void) | null; postMessage: (m: unknown) => void };
      process: (inputs: unknown[], outputs: Float32Array[][]) => boolean;
    };
    const fn = new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', `${src}`);
    class BaseProc {
      port = { onmessage: null as ((ev: { data: unknown }) => void) | null, postMessage: () => {} };
    }
    fn(BaseProc, (_name: string, ctor: typeof ProcessorCtor) => { ProcessorCtor = ctor; }, 48000);
    const proc = new ProcessorCtor!();
    proc.port.onmessage!({
      data: {
        type: 'STRIKE',
        level: 0.4,
        tauC: 0.001,
        brightness: 0.7,
        voices: [
          { freqHz: 261.63, gain: 0.8, decaySec: 1.5 },
          { freqHz: 523.25, gain: 0.4, decaySec: 1.2 },
          { freqHz: 784.0, gain: 0.2, decaySec: 0.9 },
        ],
      },
    });
    const windMsg = {
      data: {
        type: 'WIND_UPDATE',
        voices: [{
          id: 'clarinet',
          exciter: 'reed',
          breathKPa: 3.2,
          embouchureHz: 320,
          cellCount: bore.cellCount,
          exactCells: bore.exactCells,
          sampleRate: 48000,
          junctionK: bore.junctionK,
          bellCutoffHz: bore.bellCutoffHz,
          shunts,
        }],
      },
    };
    proc.port.onmessage!(windMsg);

    const wOutL = new Float32Array(128);
    const wOutR = new Float32Array(128);
    const outputs = [[wOutL, wOutR]];
    const tProc0 = performance.now();
    let procEnergy = 0;
    for (let q = 0; q < 375; q++) {
      if ((q & 7) === 0) proc.port.onmessage!(windMsg);
      proc.process([], outputs);
      for (let i = 0; i < 128; i++) procEnergy += wOutL[i] * wOutL[i];
    }
    const procMs = performance.now() - tProc0;
    console.log(`[BENCH] waveguide_1s_44k_ms=${wgMs.toFixed(2)} worklet_1s_48k_ms=${procMs.toFixed(2)}`);
    expect(procEnergy).toBeGreaterThan(0.01);
    expect(procMs).toBeLessThan(250);
  });

  it('verifies membrane tuning speed, plate/aero/friction hot loops, buffer/wave caching, and zero idle spam', () => {
    const nodes = structuredClone(percussionKitPreset.nodes);
    const timpani = findNode(nodes, (n) => !!n.acousticMembrane)!;
    const cymbal = findNode(nodes, (n) => !!n.nonlinearPlate)!;
    const cymProfile = estimateBodyModes(cymbal, false, nodes);

    // Cold tuneMembraneToPitch skips FDTD shell IR during 18-step bisection!
    const tTune0 = performance.now();
    const tuned = tuneMembraneToPitch(timpani, 146.83, nodes);
    const tuneMs = performance.now() - tTune0;
    expect(tuneMs).toBeLessThan(120);

    // Warm 1 impact (populates shell IR cache once), then time 40 steady impacts
    const firstHit = solveMembraneImpact(tuned, nodes, { impulseNs: 0.45, localPoint: [0.08, 0.04, 0] });
    expect(firstHit).not.toBeNull();
    expect(Math.abs(firstHit!.evaluation.fundamentalHz - 146.83)).toBeLessThan(2.5);
    const tMemHit0 = performance.now();
    for (let i = 0; i < 40; i++) {
      solveMembraneImpact(tuned, nodes, { impulseNs: 0.45, localPoint: [0.08, 0.04, 0] });
    }
    const memHit40Ms = performance.now() - tMemHit0;
    expect(memHit40Ms).toBeLessThan(80);

    const tPlate0 = performance.now();
    for (let i = 0; i < 200; i++) {
      solveVonKarmanPlateImpact(cymProfile, cymbal, 0.65, 0.0008);
    }
    const plateMs = performance.now() - tPlate0;
    expect(plateMs).toBeLessThan(60);

    const tHot0 = performance.now();
    const mockCam = { matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.2, 2.4, 1] } };
    for (let i = 0; i < 5000; i++) {
      evaluateGustWind(8.0, 2.0, i * 0.001, 0.2, 0.5, i * 0.002);
    }
    for (let i = 0; i < 1000; i++) {
      resolveSpatialAcousticParams([0.3, -0.2, 0.4], mockCam);
      solveAeroAcousticVoice({
        hubOrBodyId: 'prop_1',
        bladeCount: 4,
        omegaRadPerSec: 180,
        tipSpeedMps: 45,
        relSpeedMps: 18,
        areaM2: 0.03,
        chordM: 0.04,
        thicknessM: 0.004,
        alphaDeg: 8,
        aeroForceN: 4.5,
      });
      solveContactFrictionVoice(
        {
          pairId: 'a:b',
          nodeId: 'a',
          otherNodeId: 'b',
          tangentSpeed: 0.25,
          rollSpeedMps: 0.24,
          normalForce: 2.5,
          muFriction: 0.35,
          rollingRatio: 0.85,
          contactDurationSec: 0.4,
        },
        { primaryProfile: cymProfile, primaryNode: cymbal },
      );
      inferColliderContactProps(cymbal);
    }
    const recent = new Map();
    const prevByBow = new Map();
    for (let i = 0; i < 5000; i++) {
      resolveGuardedBowHold([], recent, prevByBow, i * 0.002);
    }
    const hotMiscMs = performance.now() - tHot0;

    // Regression #1: Click pulse AudioBuffer LRU cache reuses buffer across 120 identical strikes!
    const mock = createCountingMockAudioContext(48000);
    const outBus = mock.ctx.destination;
    for (let i = 0; i < 120; i++) {
      triggerOrMutateModalVoice({
        ctx: mock.ctx,
        outputBus: outBus,
        nodeId: `bar_${i % 30}`,
        level: 0.35,
        tauC: 0.0008,
        brightness: 0.65,
        voices: [
          { freqHz: 261.63 + i * 5, gain: 0.8, decaySec: 0.9 },
          { freqHz: 720 + i * 10, gain: 0.4, decaySec: 0.5 },
        ],
      });
      mock.advanceTime(0.015);
    }
    const stats = getModalVoicePoolStats(mock.ctx);
    expect(stats.activeGroups).toBeLessThanOrEqual(MAX_ACTIVE_IMPACTS);
    expect(stats.activeOscillators).toBeLessThanOrEqual(MAX_ACTIVE_OSCILLATORS);
    expect(stats.activeConvolvers).toBeLessThanOrEqual(MAX_ACTIVE_CONVOLVERS);
    const impactBufCount = mock.getCounts().createBufferCount;
    expect(impactBufCount).toBeLessThanOrEqual(4);
    silenceModalVoices(mock.ctx, 0);

    // Regression #2: Lazy bank creation — empty updates on a fresh AudioContext allocate 0 nodes!
    const freshMock = createCountingMockAudioContext(48000);
    postWorkletBowedUpdate(freshMock.ctx, []);
    postWorkletAeroUpdate(freshMock.ctx, []);
    postWorkletFrictionUpdate(freshMock.ctx, []);
    expect(freshMock.getCounts().createNodeCount).toBe(0);
    expect(freshMock.getCounts().createBufferCount).toBe(0);

    // Regression #3: Zero idle-slot setTargetAtTime spam + PeriodicWave cache reuse across alternating timbres!
    const horn = findNode(windInstrumentsPreset.nodes, (n) => !!n.windInstrument && n.windInstrument.exciter === 'brass_lip')!;
    const hornBore = extractBoreWaveguide(horn)!;
    const hornVoiceA = {
      id: 'horn',
      exciter: 'brass_lip' as const,
      breathKPa: 3.0,
      embouchureHz: 261.63,
      bellCutoffHz: hornBore.bellCutoffHz,
      resonantModesHz: hornBore.resonantModesHz,
      modeImpedancePeaks: hornBore.modeImpedancePeaks,
      impedanceGrid: hornBore.impedanceGrid,
      boreShape: hornBore.boreShape,
    };
    const hornVoiceB = { ...hornVoiceA, breathKPa: 4.5, embouchureHz: 392.0 };
    postWorkletWindUpdate(mock.ctx, [hornVoiceA]);
    mock.resetCounts();
    for (let i = 0; i < 120; i++) {
      postWorkletWindUpdate(mock.ctx, [hornVoiceA]);
    }
    const windIdleCounts = mock.getCounts();
    expect(windIdleCounts.setTargetCalls).toBeLessThanOrEqual(2800);

    // Alternating between 2 wind spectra 60 times should hit PeriodicWave cache (<= 4 builds, not 60!)
    mock.resetCounts();
    for (let i = 0; i < 60; i++) {
      postWorkletWindUpdate(mock.ctx, [i % 2 === 0 ? hornVoiceA : hornVoiceB]);
    }
    const waveCounts = mock.getCounts();
    expect(waveCounts.periodicWaveCalls).toBeLessThanOrEqual(4);

    console.log(
      `[BENCH] tune_mem_ms=${tuneMs.toFixed(2)} mem_hit40_ms=${memHit40Ms.toFixed(2)} plate_200_ms=${plateMs.toFixed(2)} misc_hot_ms=${hotMiscMs.toFixed(2)} impact_bufs=${impactBufCount} wind_120_setTarget=${windIdleCounts.setTargetCalls} alt60_waves=${waveCounts.periodicWaveCalls}`,
    );
  });
});
