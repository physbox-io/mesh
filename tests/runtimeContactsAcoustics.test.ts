import { describe, expect, it, vi } from 'vitest';
import type { SceneGraph, SceneNode } from '../src/types/scene';
import type {
  AudioDampingEvent,
  BowedStringContactEvent,
  ContinuousContactEvent,
} from '../src/workers/physicsWorkerProtocol';
import { estimateBodyModes } from '../src/utils/modalAudio';
import {
  clampAudioFreq,
  createResampledConvolver,
  ensureNativeFrictionBank,
  getSharedAcousticOutputBus,
  postWorkletAeroSnap,
  postWorkletBowedSilence,
  postWorkletBowedUpdate,
  postWorkletFrictionSilence,
  postWorkletFrictionUpdate,
  postWorkletWindSilence,
  postWorkletWindUpdate,
  safePeriodicWave,
  setStudioReverbEnabled,
  type WorkletBowedVoicePayload,
  type WorkletWindVoicePayload,
} from '../src/utils/modalAudioWorklet';
import {
  computeContactDampingRate,
  computeImpactSolSoftScale,
  inferStringLocalSpan,
  inferSurfaceRoughness,
  resolveGuardedBowHold,
  selectMultiFingerStopFraction,
  shouldEmitPairImpact,
  solveContactFrictionVoice,
} from '../src/utils/contactFrictionAcoustics';
import {
  DEFAULT_SPATIAL_PARAMS,
  MAX_STEREO_PAN,
  createSpatialSend,
  mujocoWorldToThreeWorld,
  resolveBodyWorldPosMuJoCo,
  resolveSpatialAcousticParams,
} from '../src/utils/spatialAcoustics';
import { simulate } from './helpers/simulate';

// ---------------------------------------------------------------------------
// Deterministic WebAudio Graph Mock for Unit-Testing Native Synth Banks
// ---------------------------------------------------------------------------

interface MockParam {
  value: number;
  setValueAtTime: ReturnType<typeof vi.fn>;
  setTargetAtTime: ReturnType<typeof vi.fn>;
  cancelScheduledValues: ReturnType<typeof vi.fn>;
}

function makeMockParam(initial = 0): MockParam {
  const p: MockParam = {
    value: initial,
    setValueAtTime: vi.fn((v: number) => {
      if (!Number.isFinite(v)) throw new TypeError(`Non-finite AudioParam value: ${v}`);
      p.value = v;
    }),
    setTargetAtTime: vi.fn((v: number) => {
      if (!Number.isFinite(v)) throw new TypeError(`Non-finite AudioParam target: ${v}`);
      p.value = v;
    }),
    cancelScheduledValues: vi.fn(),
  };
  return p;
}

class MockNode {
  kind: string;
  connectedTo = new Set<unknown>();
  disconnectCalls = 0;

  constructor(kind: string) {
    this.kind = kind;
  }

  connect(dest: unknown): unknown {
    this.connectedTo.add(dest);
    return dest;
  }

  disconnect(dest?: unknown): void {
    this.disconnectCalls++;
    if (dest !== undefined) {
      this.connectedTo.delete(dest);
    } else {
      this.connectedTo.clear();
    }
  }
}

interface MockAudioContextBag {
  ctx: AudioContext;
  setTime: (t: number) => void;
  buffers: { channels: Float32Array[]; sampleRate: number }[];
  convolvers: (MockNode & { normalize: boolean; buffer: AudioBuffer | null })[];
  gains: (MockNode & { gain: MockParam })[];
  biquads: (MockNode & { type: string; frequency: MockParam; Q: MockParam; gain: MockParam })[];
  oscillators: (MockNode & {
    type: string;
    frequency: MockParam;
    detune: MockParam;
    periodicWaves: unknown[];
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  })[];
  panners: (MockNode & { pan: MockParam })[];
  bufferSources: (MockNode & {
    buffer: AudioBuffer | null;
    loop: boolean;
    onended: (() => void) | null;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  })[];
  periodicWaveCalls: { real: Float32Array; imag: Float32Array; opts?: { disableNormalization?: boolean } }[];
}

function createMockAudioContext(sampleRate = 48000, withStereoPanner = true): MockAudioContextBag {
  let now = 0.5;
  const buffers: MockAudioContextBag['buffers'] = [];
  const convolvers: MockAudioContextBag['convolvers'] = [];
  const gains: MockAudioContextBag['gains'] = [];
  const biquads: MockAudioContextBag['biquads'] = [];
  const oscillators: MockAudioContextBag['oscillators'] = [];
  const panners: MockAudioContextBag['panners'] = [];
  const bufferSources: MockAudioContextBag['bufferSources'] = [];
  const periodicWaveCalls: MockAudioContextBag['periodicWaveCalls'] = [];
  const destination = new MockNode('destination');

  const rawCtx: Record<string, unknown> = {
    sampleRate,
    state: 'running',
    get currentTime() {
      return now;
    },
    destination,
    resume: vi.fn(() => Promise.resolve()),
    createBuffer: vi.fn((numChannels: number, length: number, sr: number) => {
      const channels = Array.from({ length: numChannels }, () => new Float32Array(length));
      const rec = { channels, sampleRate: sr };
      buffers.push(rec);
      return {
        numberOfChannels: numChannels,
        length,
        sampleRate: sr,
        duration: length / sr,
        getChannelData: (ch: number) => channels[ch],
      } as unknown as AudioBuffer;
    }),
    createConvolver: vi.fn(() => {
      const c = Object.assign(new MockNode('convolver'), {
        normalize: true,
        buffer: null as AudioBuffer | null,
      });
      convolvers.push(c);
      return c;
    }),
    createGain: vi.fn(() => {
      const g = Object.assign(new MockNode('gain'), {
        gain: makeMockParam(1),
      });
      gains.push(g);
      return g;
    }),
    createBiquadFilter: vi.fn(() => {
      const maxNyquist = sampleRate * 0.5;
      const freqParam = makeMockParam(350);
      const origSetVal = freqParam.setValueAtTime;
      const origSetTarget = freqParam.setTargetAtTime;
      freqParam.setValueAtTime = vi.fn((v: number, t: number) => {
        if (v <= 0 || v >= maxNyquist) {
          throw new RangeError(`Biquad frequency ${v} out of (0, ${maxNyquist}) at sr=${sampleRate}`);
        }
        return origSetVal(v, t);
      });
      freqParam.setTargetAtTime = vi.fn((v: number, t: number, tau: number) => {
        if (v <= 0 || v >= maxNyquist) {
          throw new RangeError(`Biquad target frequency ${v} out of (0, ${maxNyquist}) at sr=${sampleRate}`);
        }
        return origSetTarget(v, t, tau);
      });
      const b = Object.assign(new MockNode('biquad'), {
        type: 'lowpass',
        frequency: freqParam,
        Q: makeMockParam(1),
        gain: makeMockParam(0),
      });
      biquads.push(b);
      return b;
    }),
    createOscillator: vi.fn(() => {
      const o = Object.assign(new MockNode('oscillator'), {
        type: 'sine',
        frequency: makeMockParam(440),
        detune: makeMockParam(0),
        periodicWaves: [] as unknown[],
        setPeriodicWave: vi.fn((w: unknown) => {
          o.periodicWaves.push(w);
        }),
        start: vi.fn(),
        stop: vi.fn(),
      });
      oscillators.push(o);
      return o;
    }),
    createWaveShaper: vi.fn(() =>
      Object.assign(new MockNode('waveshaper'), {
        curve: null as Float32Array | null,
        oversample: 'none',
      }),
    ),
    createDynamicsCompressor: vi.fn(() =>
      Object.assign(new MockNode('compressor'), {
        threshold: makeMockParam(-24),
        knee: makeMockParam(30),
        ratio: makeMockParam(12),
        attack: makeMockParam(0.003),
        release: makeMockParam(0.25),
      }),
    ),
    createChannelSplitter: vi.fn(() => new MockNode('splitter')),
    createChannelMerger: vi.fn(() => new MockNode('merger')),
    createBufferSource: vi.fn(() => {
      const s = Object.assign(new MockNode('buffersource'), {
        buffer: null as AudioBuffer | null,
        loop: false,
        onended: null as (() => void) | null,
        start: vi.fn(),
        stop: vi.fn(),
      });
      bufferSources.push(s);
      return s;
    }),
    createPeriodicWave: vi.fn(
      (real: Float32Array, imag: Float32Array, opts?: { disableNormalization?: boolean }) => {
        for (let i = 0; i < real.length; i++) {
          if (!Number.isFinite(real[i]) || !Number.isFinite(imag[i])) {
            throw new TypeError('Non-finite PeriodicWave coefficient');
          }
        }
        const entry = { real: Float32Array.from(real), imag: Float32Array.from(imag), opts };
        periodicWaveCalls.push(entry);
        return entry as unknown as PeriodicWave;
      },
    ),
  };

  if (withStereoPanner) {
    rawCtx.createStereoPanner = vi.fn(() => {
      const p = Object.assign(new MockNode('stereopanner'), {
        pan: makeMockParam(0),
      });
      panners.push(p);
      return p;
    });
  }

  return {
    ctx: rawCtx as unknown as AudioContext,
    setTime: (t: number) => {
      now = t;
    },
    buffers,
    convolvers,
    gains,
    biquads,
    oscillators,
    panners,
    bufferSources,
    periodicWaveCalls,
  };
}

describe('Slice 4 DSP Safety, Contact/Friction Excitation & Spatial Audio', () => {
  it('sanitizes NaN/Inf IR samples, caches AudioBuffers via WeakMap, and scales convolution taps by sourceRate/targetRate', () => {
    const bag48 = createMockAudioContext(48000);
    const bag96 = createMockAudioContext(96000);
    const bag24 = createMockAudioContext(24000);

    // Reject empty, all-zero, and all-NaN impulse responses cleanly
    expect(createResampledConvolver(bag48.ctx, new Float32Array(0))).toBeNull();
    expect(createResampledConvolver(bag48.ctx, new Float32Array(128))).toBeNull();
    const allNan = new Float32Array(64).fill(Number.NaN);
    expect(createResampledConvolver(bag48.ctx, allNan)).toBeNull();

    // Corrupt a realistic decaying 48 kHz IR with NaN and ±Infinity spikes
    const poisonedIr = new Float32Array(512);
    for (let i = 0; i < poisonedIr.length; i++) {
      poisonedIr[i] = 0.42 * Math.exp(-i / 120) * Math.sin((2 * Math.PI * 440 * i) / 48000);
    }
    poisonedIr[7] = Number.NaN;
    poisonedIr[39] = Number.POSITIVE_INFINITY;
    poisonedIr[112] = Number.NEGATIVE_INFINITY;

    const conv48a = createResampledConvolver(bag48.ctx, poisonedIr)!;
    expect(conv48a).not.toBeNull();
    expect(conv48a.normalize).toBe(false);
    const data48 = conv48a.buffer!.getChannelData(0);
    expect(data48.every((v) => Number.isFinite(v))).toBe(true);

    // WeakMap cache: second ConvolverNode at 48 kHz reuses the exact AudioBuffer without calling createBuffer again
    const bufCountBefore = bag48.buffers.length;
    const conv48b = createResampledConvolver(bag48.ctx, poisonedIr)!;
    expect(conv48b).not.toBe(conv48a);
    expect(conv48b.buffer).toBe(conv48a.buffer);
    expect(bag48.buffers.length).toBe(bufCountBefore);

    // Sample-rate discrete convolution invariance: at 96 kHz (2x taps per second), tap amplitudes scale by 0.5x!
    const cleanIr = new Float32Array(512);
    for (let i = 0; i < cleanIr.length; i++) {
      cleanIr[i] = 0.35 * Math.exp(-i / 140) * Math.cos((2 * Math.PI * 330 * i) / 48000);
    }
    const c48 = createResampledConvolver(bag48.ctx, cleanIr)!;
    const c96 = createResampledConvolver(bag96.ctx, cleanIr)!;
    const c24 = createResampledConvolver(bag24.ctx, cleanIr)!;

    const sumAbs = (arr: Float32Array) => arr.reduce((acc, x) => acc + Math.abs(x), 0);
    // Integral sum_k |h_sr[k]| equals continuous L1 norm * sr_ref regardless of AudioContext sampleRate!
    const l1At48 = sumAbs(c48.buffer!.getChannelData(0));
    const l1At96 = sumAbs(c96.buffer!.getChannelData(0));
    const l1At24 = sumAbs(c24.buffer!.getChannelData(0));
    expect(l1At96 / l1At48).toBeCloseTo(1.0, 1);
    expect(l1At24 / l1At48).toBeCloseTo(1.0, 1);
  });

  it('clamps Nyquist frequencies on low-rate Bluetooth AudioContexts and guards PeriodicWave against NaN/zero bins', () => {
    const bt16k = createMockAudioContext(16000);
    expect(clampAudioFreq(bt16k.ctx, 18000)).toBeLessThanOrEqual(16000 * 0.475);
    expect(clampAudioFreq(bt16k.ctx, Number.NaN, 520)).toBe(520);
    expect(clampAudioFreq(bt16k.ctx, -50, 440, 20)).toBe(20);

    // Zero-amplitude harmonics disable normalization so WebAudio never computes 0 / 0 = NaN
    const zeroReal = new Float32Array([1, 0, Number.NaN, Number.POSITIVE_INFINITY]);
    const zeroImag = new Float32Array([1, 0, 0, Number.NEGATIVE_INFINITY]);
    const wZero = safePeriodicWave(bt16k.ctx, zeroReal, zeroImag);
    expect(wZero).not.toBeNull();
    expect(bt16k.periodicWaveCalls[0].real[0]).toBe(0);
    expect(bt16k.periodicWaveCalls[0].imag[0]).toBe(0);
    expect(bt16k.periodicWaveCalls[0].opts?.disableNormalization).toBe(true);

    // Non-zero harmonics preserve normal PeriodicWave normalization
    const validReal = new Float32Array([0, 0.8, 0.3]);
    const validImag = new Float32Array([0, 0.2, -0.1]);
    safePeriodicWave(bt16k.ctx, validReal, validImag);
    expect(bt16k.periodicWaveCalls[1].opts?.disableNormalization).toBe(false);

    // Full studio bus + aero snap survives 16 kHz Nyquist without throwing RangeError on 18 kHz / 8.5 kHz filters
    expect(() => {
      getSharedAcousticOutputBus(bt16k.ctx);
      postWorkletAeroSnap(bt16k.ctx, {
        active: true,
        gain: 0.4,
        durationSec: 0.002,
        centerHz: 9200,
        bandpassQ: 1.5,
        lowpassHz: 14000,
        pan: -0.5,
        distanceGain: 0.85,
      });
    }).not.toThrow();
  });

  it('allocates active Wind & Bowed voices before idle payloads, disconnects stale IRs, clamps squelch floor, and cleans up snaps', () => {
    const bag = createMockAudioContext(48000);
    getSharedAcousticOutputBus(bag.ctx);

    const internalCtx = bag.ctx as unknown as {
      __physboxNativeWindV18: {
        noiseSource: { buffer: AudioBuffer };
        convolver: { buffer: AudioBuffer };
        slots: {
          id: string;
          wasActive: boolean;
          voiceGain: { gain: MockParam };
          bodyFormant: { frequency: MockParam };
          bellLowpass1: { frequency: MockParam };
          squelchDepth: { gain: MockParam };
          bodyConvolver: MockNode | null;
          wetBodyIrGain: { gain: MockParam };
          spatial: { panner: { pan: MockParam } | null; input: { gain: MockParam } };
        }[];
      };
      __physboxNativeBowedV7?: {
        slots: {
          id: string;
          wasActive: boolean;
          releaseUntilTime: number;
          voiceGain: { gain: MockParam };
          bodyConvolver: MockNode | null;
          wetBodyGain: { gain: MockParam };
        }[];
      };
    };

    // 1. Shared noiseSource is flat zero-mean broadband white noise (not pre-muffled!)
    const noiseData = internalCtx.__physboxNativeWindV18.noiseSource.buffer.getChannelData(0);
    const mean = noiseData.reduce((s, x) => s + x, 0) / noiseData.length;
    expect(Math.abs(mean)).toBeLessThan(1e-4);
    // Adjacent-sample difference RMS on white noise is ~sqrt(2) * RMS (a 2 kHz one-pole LP would drop diffRms/rms < 0.35!)
    let sq = 0;
    let diffSq = 0;
    for (let i = 1; i < noiseData.length; i++) {
      sq += noiseData[i] * noiseData[i];
      const d = noiseData[i] - noiseData[i - 1];
      diffSq += d * d;
    }
    expect(Math.sqrt(diffSq / sq)).toBeGreaterThan(1.15);

    // 2. Active-first Wind slot allocation: 6 idle pipes + 1 active pipe at index 6 must play!
    const dummyIr = new Float32Array(256);
    dummyIr[0] = 0.6;
    dummyIr[12] = -0.25;

    const makeIdleWind = (i: number): WorkletWindVoicePayload => ({
      id: `idle_pipe_${i}`,
      exciter: 'air_jet',
      breathKPa: 0,
      embouchureHz: 440,
      bellCutoffHz: 1800,
      resonantModesHz: [440, 880],
    });
    const activeHorn: WorkletWindVoicePayload = {
      id: 'active_bladder_horn',
      exciter: 'brass_lip',
      breathKPa: 3.8,
      embouchureHz: 165,
      boreShape: 'flared_horn',
      bellCutoffHz: 900,
      resonantModesHz: [165, 330, 495],
      modeImpedancePeaks: [1.0, 0.85, 0.65],
      bodyIr: dummyIr as Float32Array<ArrayBuffer>,
      bodyIrSig: 'horn_ir_v1',
      pan: 0.42,
      distanceGain: 0.82,
    };

    postWorkletWindUpdate(bag.ctx, [
      makeIdleWind(0),
      makeIdleWind(1),
      makeIdleWind(2),
      makeIdleWind(3),
      makeIdleWind(4),
      makeIdleWind(5),
      activeHorn,
    ]);

    const windSlot = internalCtx.__physboxNativeWindV18.slots.find((s) => s.id === 'active_bladder_horn')!;
    expect(windSlot).toBeDefined();
    expect(windSlot.wasActive).toBe(true);
    expect(windSlot.voiceGain.gain.value).toBeGreaterThan(0.01);
    expect(windSlot.bodyConvolver).not.toBeNull();
    expect(windSlot.spatial.panner?.pan.value).toBeCloseTo(0.42, 2);
    expect(windSlot.spatial.input.gain.value).toBeCloseTo(0.82, 2);

    // Squelch floor guard: modulation depth never exceeds 0.42 * min(formantHz, bellLowpass1Hz)
    const minCutoff = Math.min(windSlot.bodyFormant.frequency.value, windSlot.bellLowpass1.frequency.value);
    expect(windSlot.squelchDepth.gain.value).toBeLessThanOrEqual(0.42 * minCutoff + 1e-6);

    // Reusing `active_bladder_horn` without `bodyIr` disconnects stale ConvolverNode cleanly!
    const prevWindConv = windSlot.bodyConvolver!;
    postWorkletWindUpdate(bag.ctx, [{ ...activeHorn, bodyIr: null, bodyIrSig: '' }]);
    expect(prevWindConv.disconnectCalls).toBeGreaterThan(0);
    expect(windSlot.bodyConvolver).toBeNull();
    expect(windSlot.wetBodyIrGain.gain.value).toBe(0);
    postWorkletWindSilence(bag.ctx);

    // 3. Bowed 6-slot active-first allocation + `releaseUntilTime` anti-steal
    const makeBowed = (id: string, active: boolean, pitchHz: number, withIr = false): WorkletBowedVoicePayload => ({
      id,
      active,
      pitchHz,
      amplitude: active ? 0.28 : 0,
      harmonicWeights: [1, 0.5, 0.33, 0.25],
      bodyFormantHz: 240,
      bodyFormantGainDb: 6,
      bodyFormantQ: 2.2,
      secondaryFormantHz: 520,
      lowpassHz: 2800,
      rosinNoiseGain: 0.04,
      rosinCenterHz: 2100,
      bodyIr: withIr ? (dummyIr as Float32Array<ArrayBuffer>) : null,
      bodyIrSig: withIr ? 'cello_ir_v1' : '',
    });

    bag.setTime(1.0);
    postWorkletBowedUpdate(bag.ctx, [
      makeBowed('idle_str_1', false, 65.4),
      makeBowed('idle_str_2', false, 98.0),
      makeBowed('idle_str_3', false, 146.8),
      makeBowed('idle_str_4', false, 220.0),
      makeBowed('idle_str_5', false, 293.7),
      makeBowed('idle_str_6', false, 329.6),
      makeBowed('cello_A3', true, 220.0, true),
    ]);
    const bowedSlots = internalCtx.__physboxNativeBowedV7!.slots;
    expect(bowedSlots).toHaveLength(6);
    const slotA3 = bowedSlots.find((s) => s.id === 'cello_A3')!;
    expect(slotA3).toBeDefined();
    expect(slotA3.wasActive).toBe(true);
    expect(slotA3.bodyConvolver).not.toBeNull();

    // Release `cello_A3` at t = 1.2s -> enters 380 ms sympathetic ring (`releaseUntilTime = 1.58`)
    bag.setTime(1.2);
    postWorkletBowedUpdate(bag.ctx, []);
    expect(slotA3.wasActive).toBe(false);
    expect(slotA3.releaseUntilTime).toBeCloseTo(1.58, 2);

    // Bowing a new string `cello_D3` at t = 1.25s picks a cold slot instead of stealing `cello_A3`'s ringing tail!
    bag.setTime(1.25);
    postWorkletBowedUpdate(bag.ctx, [makeBowed('cello_D3', true, 146.8, false)]);
    expect(slotA3.id).toBe('cello_A3');
    const slotD3 = bowedSlots.find((s) => s.id === 'cello_D3')!;
    expect(slotD3).toBeDefined();
    expect(slotD3).not.toBe(slotA3);

    // Switching `cello_A3` back on without `bodyIr` disconnects its old ConvolverNode
    const oldCelloConv = slotA3.bodyConvolver!;
    bag.setTime(1.7);
    postWorkletBowedUpdate(bag.ctx, [makeBowed('cello_A3', true, 220.0, false)]);
    expect(oldCelloConv.disconnectCalls).toBeGreaterThan(0);
    expect(slotA3.bodyConvolver).toBeNull();
    postWorkletBowedSilence(bag.ctx);

    // 4. `postWorkletAeroSnap` disconnects EVERY transient node on `onended`
    const srcCountBefore = bag.bufferSources.length;
    postWorkletAeroSnap(bag.ctx, {
      active: true,
      gain: 0.35,
      durationSec: 0.0018,
      centerHz: 1400,
      bandpassQ: 1.4,
      lowpassHz: 3200,
      pan: -0.65,
      distanceGain: 0.72,
    });
    const snapSrc = bag.bufferSources[srcCountBefore];
    expect(snapSrc.onended).toBeTypeOf('function');
    snapSrc.onended!();
    expect(snapSrc.disconnectCalls).toBeGreaterThan(0);

    // Studio reverb toggle still works seamlessly on `__physboxNativeWindV18`
    expect(() => setStudioReverbEnabled(bag.ctx, false)).not.toThrow();
    expect(() => setStudioReverbEnabled(bag.ctx, true)).not.toThrow();
  });

  it('synthesizes distinct Starter #2 rolling, scraping, Stribeck squeal, and singing-rim lock-in voices', () => {
    const glassGoblet: SceneNode = {
      id: 'wineglass',
      name: 'Crystal Goblet',
      deformMaterial: 'glass',
      geoms: [{ name: 'bowl', type: 'cylinder', size: [0.042, 0.055], friction: [0.35, 0.005, 0.0001] }],
      joints: [],
      children: [],
    };
    const steelBrake: SceneNode = {
      id: 'brake_rotor',
      name: 'Steel Brake Rotor',
      deformMaterial: 'steel',
      geoms: [{ name: 'disc', type: 'cylinder', size: [0.12, 0.008], friction: [0.58, 0.005, 0.0001] }],
      joints: [],
      children: [],
    };
    const woodRail: SceneNode = {
      id: 'wood_rail',
      name: 'Hardwood Track',
      deformMaterial: 'hardwood',
      geoms: [{ name: 'rail', type: 'box', size: [0.30, 0.03, 0.015], friction: [0.45, 0.005, 0.0001] }],
      joints: [],
      children: [],
    };
    const stoneBlock: SceneNode = {
      id: 'granite_slab',
      name: 'Granite Block',
      deformMaterial: 'stone',
      geoms: [{ name: 'slab', type: 'box', size: [0.08, 0.06, 0.04], friction: [0.75, 0.005, 0.0001] }],
      joints: [{ name: 'free', type: 'free' }],
      children: [],
    };

    expect(inferSurfaceRoughness(glassGoblet)).toBeLessThan(inferSurfaceRoughness(steelBrake));
    expect(inferSurfaceRoughness(steelBrake)).toBeLessThan(inferSurfaceRoughness(woodRail));
    expect(inferSurfaceRoughness(woodRail)).toBeLessThan(inferSurfaceRoughness(stoneBlock));

    const glassProfile = estimateBodyModes(glassGoblet, false);
    const steelProfile = estimateBodyModes(steelBrake, false);
    const woodProfile = estimateBodyModes(woodRail, false);
    const stoneProfile = estimateBodyModes(stoneBlock, false);

    // 1. Rolling marble on hardwood rail
    const rollEvent: ContinuousContactEvent = {
      nodeId: 'marble',
      otherNodeId: 'wood_rail',
      tangentSpeed: 0.35,
      rollSpeedMps: 0.34,
      normalForce: 0.45,
      muFriction: 0.30,
      rollingRatio: 0.94,
      contactRadiusM: 0.012,
      contactDurationSec: 0.25,
    };
    const rollVoice = solveContactFrictionVoice(rollEvent, {
      primaryNode: glassGoblet,
      partnerNode: woodRail,
      partnerProfile: woodProfile,
    });
    expect(rollVoice.active).toBe(true);
    expect(rollVoice.regime).toBe('rolling');
    expect(rollVoice.tonalActive).toBe(false);
    expect(rollVoice.noiseGain).toBeGreaterThan(0.01);
    expect(rollVoice.grainRateHz).toBeGreaterThanOrEqual(3);

    // 2. Rough stone block dragged across floor
    const scrapeEvent: ContinuousContactEvent = {
      nodeId: 'granite_slab',
      otherNodeId: 'world',
      tangentSpeed: 0.28,
      rollSpeedMps: 0.0,
      normalForce: 14.0,
      muFriction: 0.72,
      rollingRatio: 0.02,
      roughness: 0.85,
      contactDurationSec: 0.18,
    };
    const scrapeVoice = solveContactFrictionVoice(scrapeEvent, {
      primaryNode: stoneBlock,
      primaryProfile: stoneProfile,
    });
    expect(scrapeVoice.active).toBe(true);
    expect(scrapeVoice.regime).toBe('scraping');
    expect(scrapeVoice.tonalActive).toBe(false);
    expect(scrapeVoice.noiseGain).toBeGreaterThan(rollVoice.noiseGain);

    // 3. High-force steel-on-steel Stribeck brake squeal
    const squealEvent: ContinuousContactEvent = {
      nodeId: 'brake_rotor',
      otherNodeId: 'caliper',
      tangentSpeed: 0.14,
      rollSpeedMps: 0.0,
      normalForce: 22.0,
      muFriction: 0.58,
      rollingRatio: 0.0,
      contactDurationSec: 0.20,
    };
    const squealVoice = solveContactFrictionVoice(squealEvent, {
      primaryNode: steelBrake,
      primaryProfile: steelProfile,
      partnerNode: steelBrake,
    });
    expect(squealVoice.active).toBe(true);
    expect(squealVoice.regime).toBe('stick_slip_squeal');
    expect(squealVoice.tonalActive).toBe(true);
    expect(squealVoice.tonalFreqHz).toBeGreaterThanOrEqual(650);
    expect(squealVoice.tonalDrive).toBeGreaterThan(1.0);

    // 4. Rubbed crystal wineglass rim singing with revolving quadrupole beat df = v_slip / (pi * R_rim)
    const rimSlip = 0.085;
    const rimRadius = 0.042;
    const rimEvent: ContinuousContactEvent = {
      nodeId: 'wineglass',
      otherNodeId: 'moist_finger',
      tangentSpeed: rimSlip,
      rollSpeedMps: 0.0,
      normalForce: 0.85,
      muFriction: 0.36,
      rollingRatio: 0.0,
      circumferentialRub: 0.92,
      localPoint: [rimRadius, 0, 0.055],
      contactDurationSec: 0.42,
    };
    const rimVoice = solveContactFrictionVoice(rimEvent, {
      primaryNode: glassGoblet,
      primaryProfile: glassProfile,
      spatial: { pan: -0.35, distanceGain: 0.92 },
    });
    expect(rimVoice.active).toBe(true);
    expect(rimVoice.regime).toBe('rim_singing');
    expect(rimVoice.tonalActive).toBe(true);
    expect(rimVoice.tonalDrive).toBeCloseTo(0.38, 2);
    expect(rimVoice.attackTauSec).toBeCloseTo(0.18, 2);
    const expectedBeat = rimSlip / (Math.PI * rimRadius);
    expect(rimVoice.tonalBeatFreqHz - rimVoice.tonalFreqHz).toBeCloseTo(expectedBeat, 2);
    expect(rimVoice.pan).toBe(-0.35);
    expect(rimVoice.distanceGain).toBe(0.92);

    // Drive all 4 voices through the 6-slot WebAudio Friction Bank & verify IR swap + clean silence
    const bag = createMockAudioContext(48000);
    const bank = ensureNativeFrictionBank(bag.ctx)!;
    expect(bank.slots).toHaveLength(6);

    const irSamples = new Float32Array(256);
    irSamples[0] = 0.5;
    irSamples[19] = -0.22;
    postWorkletFrictionUpdate(bag.ctx, [
      rollVoice,
      scrapeVoice,
      squealVoice,
      { ...rimVoice, bodyIr: irSamples as Float32Array<ArrayBuffer>, bodyIrSig: 'goblet_ir_1' },
    ]);

    const activeCount = bank.slots.filter((s) => s.wasActive).length;
    expect(activeCount).toBe(4);
    const squealSlot = bank.slots.find((s) => s.id === squealVoice.id)!;
    const rimSlot = bank.slots.find((s) => s.id === rimVoice.id)!;
    expect(squealSlot.tonalOsc1.type).toBe('sawtooth');
    expect(rimSlot.tonalOsc1.type).toBe('sine');
    expect(rimSlot.bodyConvolver).not.toBeNull();

    // Clearing bodyIr disconnects convolver
    postWorkletFrictionUpdate(bag.ctx, [{ ...rimVoice, bodyIr: null, bodyIrSig: '' }]);
    expect(rimSlot.bodyConvolver).toBeNull();

    postWorkletFrictionSilence(bag.ctx);
    expect(bank.slots.every((s) => !s.wasActive)).toBe(true);
  });

  it('projects MuJoCo Z-up coordinates into Starter #6c camera-relative stereo pan, ITD, and distance rolloff', () => {
    // MuJoCo Z-up (x, y, z) -> Three.js Y-up (x, z, -y)
    expect(mujocoWorldToThreeWorld([0.3, 0.5, 0.8])).toEqual([0.3, 0.8, -0.5]);

    // Camera at Three.js (0, 0.4, 1.0) looking toward -Z with +X right vector (column-major matrixWorld)
    const mockCamera = {
      matrixWorld: {
        elements: [
          1, 0, 0, 0, // col 0: right = +X
          0, 1, 0, 0, // col 1: up = +Y
          0, 0, 1, 0, // col 2: backward = +Z
          0, 0.4, 1.0, 1, // col 3: camera pos
        ],
      },
    };

    const leftSrc = resolveSpatialAcousticParams([-0.55, 0.0, 0.35], mockCamera);
    const rightSrc = resolveSpatialAcousticParams([+0.55, 0.0, 0.35], mockCamera);
    const centerSrc = resolveSpatialAcousticParams([0.0, 0.0, 0.40], mockCamera);

    expect(leftSrc.pan).toBeLessThan(-0.25);
    expect(rightSrc.pan).toBeGreaterThan(0.25);
    expect(leftSrc.pan).toBeCloseTo(-rightSrc.pan, 3);
    expect(Math.abs(leftSrc.pan)).toBeLessThanOrEqual(MAX_STEREO_PAN);
    expect(centerSrc.pan).toBeCloseTo(0, 4);

    // Left source arrives at left ear first -> positive right-ear ITD; symmetric for right source
    expect(leftSrc.itdSec).toBeGreaterThan(0.0001);
    expect(rightSrc.itdSec).toBeCloseTo(-leftSrc.itdSec, 5);

    // Near-field softening (< 2 cm from camera at Three (0, 0.4, 1.0) <=> MuJoCo (0, -1.0, 0.4))
    const nearSrc = resolveSpatialAcousticParams([0.01, -1.0, 0.4], mockCamera);
    expect(Math.abs(nearSrc.pan)).toBeLessThan(0.02);

    // Distant source experiences inverse-distance attenuation & HF air absorption
    const farSrc = resolveSpatialAcousticParams([0.0, 9.0, 0.4], mockCamera);
    expect(farSrc.distanceGain).toBeLessThan(centerSrc.distanceGain);
    expect(farSrc.distanceGain).toBeGreaterThanOrEqual(0.18);
    expect(farSrc.airLowpassHz).toBeLessThan(12000);

    // Missing camera or NaN coordinates safely return DEFAULT_SPATIAL_PARAMS
    expect(resolveSpatialAcousticParams([0.2, 0.3, 0.4], null)).toEqual(DEFAULT_SPATIAL_PARAMS);
    expect(resolveSpatialAcousticParams([Number.NaN, 0, 0], mockCamera)).toEqual(DEFAULT_SPATIAL_PARAMS);

    // Body world position resolution with 90 deg Z-rotation xmat + local strike offset
    const resolvedPos = resolveBodyWorldPosMuJoCo(
      'bell_1',
      { _idMaps: { body: { bell_1: 1 } } },
      {
        xpos: new Float64Array([0, 0, 0, 1.0, 2.0, 0.5]),
        xmat: new Float64Array([
          1, 0, 0, 0, 1, 0, 0, 0, 1,
          0, -1, 0, 1, 0, 0, 0, 0, 1, // 90° yaw: local +X -> world +Y
        ]),
      },
      [0.25, 0, 0],
    );
    expect(resolvedPos?.[0]).toBeCloseTo(1.0, 5);
    expect(resolvedPos?.[1]).toBeCloseTo(2.25, 5);
    expect(resolvedPos?.[2]).toBeCloseTo(0.5, 5);

    // Headless AudioContext without `createStereoPanner` degrades gracefully in `createSpatialSend`
    const noPanBag = createMockAudioContext(48000, false);
    const send = createSpatialSend(noPanBag.ctx, noPanBag.ctx.destination, { pan: 0.6, distanceGain: 0.75 });
    expect(send.input).not.toBe(noPanBag.ctx.destination);
    expect(() => send.disconnect()).not.toThrow();
  });

  it('verifies worker string span Z-up/quat orientation, solDamp bladder suppression, pair debounce, multi-finger stops, and guarded bow hold', () => {
    // 1. Non-`fromto` MuJoCo capsule defaults to +Z axis, and rotates accurately via `quat` & `euler`
    const zCapsule: SceneNode = {
      id: 'str_z',
      name: 'Vertical String',
      geoms: [{ name: 'wire', type: 'capsule', size: [0.001, 0.22], pos: [0.02, -0.01, 0.30] }],
      joints: [],
      children: [],
    };
    const spanZ = inferStringLocalSpan(zCapsule);
    expect(spanZ.ax[0]).toBeCloseTo(0, 5);
    expect(spanZ.ax[1]).toBeCloseTo(0, 5);
    expect(spanZ.ax[2]).toBeCloseTo(1, 5);
    expect(spanZ.len).toBeCloseTo(0.44, 5);
    expect(spanZ.p0[2]).toBeCloseTo(0.08, 5);

    // 90° rotation around +Y (`quat = [cos(45°), 0, sin(45°), 0]`) maps +Z -> +X!
    const s45 = Math.SQRT1_2;
    const xQuatCapsule: SceneNode = {
      id: 'str_quat',
      name: 'Quat String',
      geoms: [{ name: 'wire', type: 'cylinder', size: [0.001, 0.16], quat: [s45, 0, s45, 0] }],
      joints: [],
      children: [],
    };
    const spanQuat = inferStringLocalSpan(xQuatCapsule);
    expect(spanQuat.ax[0]).toBeCloseTo(1, 5);
    expect(spanQuat.ax[1]).toBeCloseTo(0, 5);
    expect(spanQuat.ax[2]).toBeCloseTo(0, 5);
    expect(spanQuat.len).toBeCloseTo(0.32, 5);

    // 2. `computeImpactSolSoftScale`: suppresses critically-damped pneumatic bladder [0.075, 1.0] while boosting Newton's Cradle [0.012, 0.12]
    expect(computeImpactSolSoftScale(0.075, 1.0, 0.002, false)).toBeCloseTo(0.04, 4);
    expect(computeImpactSolSoftScale(0.012, 0.12, 0.002, false)).toBeCloseTo(Math.pow(3, 1.5), 3);
    expect(computeImpactSolSoftScale(0.012, 0.12, 0.002, true)).toBe(1.0);

    // 3. Sim-time pair debounce allows 0 ms two-mallet flams while debouncing 16 ms same-pair solver bounce
    const mallet1Prev = { atSimTime: 1.000, impulseNs: 0.45 };
    expect(shouldEmitPairImpact(mallet1Prev, 1.016, 0.42, 0.004)).toBe(false);
    expect(shouldEmitPairImpact(undefined, 1.002, 0.40, 0.004)).toBe(true); // 2 ms flam on Mallet #2 (distinct pair key!)
    expect(shouldEmitPairImpact(mallet1Prev, 1.015, 1.25, 0.004)).toBe(true); // >2.2x crescendo accent re-strike
    expect(shouldEmitPairImpact(mallet1Prev, 0.004, 0.30, 0.004)).toBe(true); // sim reset / rewind

    // 4. Multi-finger stops pick shortest active length toward bridge & support high positions (< 0.25)
    expect(selectMultiFingerStopFraction(0.09, [0.75, 0.52, 0.18])).toBeCloseTo(0.18, 4);
    expect(selectMultiFingerStopFraction(0.91, [0.25, 0.62, 0.82])).toBeCloseTo(0.18, 4);

    // 5. Guarded 32 ms bow hold keeps double-stops across micro-bounces AND drops old string in 0 ms on string crossing!
    const recent = new Map<string, { event: BowedStringContactEvent; atSimTime: number }>();
    const prevByBow = new Map<string, Set<string>>();
    const mkBow = (stringNodeId: string): BowedStringContactEvent => ({
      stringNodeId,
      bowNodeId: 'cello_bow',
      bowVelocityMps: 0.28,
      bowForceN: 0.72,
      bowBeta: 0.10,
    });

    // t = 1.000: double-stop on G2 + D3
    const f1 = resolveGuardedBowHold([mkBow('str_G2'), mkBow('str_D3')], recent, prevByBow, 1.000);
    expect(f1.map((e) => e.stringNodeId).sort()).toEqual(['str_D3', 'str_G2']);

    // t = 1.014: 14 ms solver micro-bounce loses both contacts -> both strings stay held!
    const f2 = resolveGuardedBowHold([], recent, prevByBow, 1.014);
    expect(f2.map((e) => e.stringNodeId).sort()).toEqual(['str_D3', 'str_G2']);

    // t = 1.020: bow crosses onto A3 -> G2 & D3 drop in 0 ms (no 32 ms bleed across Bach 16th-note crossing!)
    const f3 = resolveGuardedBowHold([mkBow('str_A3')], recent, prevByBow, 1.020);
    expect(f3.map((e) => e.stringNodeId)).toEqual(['str_A3']);

    // 6. Viscoelastic contact damping rate scales monotonically with normal force & surface softness
    expect(computeContactDampingRate(0.01, 0.8, 0.4)).toBe(0);
    expect(computeContactDampingRate(4.0, 0.85, 0.35)).toBeGreaterThan(
      computeContactDampingRate(4.0, 0.12, 0.35),
    );
  });

  it('detects static 0-DOF bell impacts, pneumatic bladder softness suppression, and continuous marble rolling in real MuJoCo WASM', async () => {
    const testScene: SceneGraph = {
      nodes: [
        // 1. Static 0-DOF bronze temple bell plate struck by falling steel clapper
        {
          id: 'static_bronze_bell',
          name: 'Static Bronze Bell',
          pos: [-0.25, 0, 0.04],
          deformMaterial: 'steel',
          joints: [],
          geoms: [{ name: 'bell_plate', type: 'cylinder', size: [0.075, 0.010], solref: [0.004, 0.25] }],
          children: [],
        },
        {
          id: 'steel_clapper',
          name: 'Steel Clapper',
          pos: [-0.25, 0, 0.16],
          deformMaterial: 'steel',
          joints: [{ name: 'clapper_free', type: 'free' }],
          geoms: [{ name: 'clapper_ball', type: 'sphere', size: [0.016], solref: [0.004, 0.25] }],
          children: [],
        },
        // 2. Critically-damped pneumatic bladder (`solref: [0.075, 1.0]`) stomped by foot weight
        {
          id: 'whoopee_bladder',
          name: 'Rubber Bladder',
          pos: [0.0, 0, 0.025],
          deformMaterial: 'rubber',
          joints: [],
          geoms: [{ name: 'bladder_pad', type: 'cylinder', size: [0.07, 0.022], solref: [0.075, 1.0] }],
          children: [],
        },
        {
          id: 'stomp_weight',
          name: 'Stomp Mass',
          pos: [0.0, 0, 0.14],
          deformMaterial: 'plastic',
          joints: [{ name: 'stomp_slide', type: 'slide', axis: [0, 0, 1] }],
          geoms: [{ name: 'stomp_foot', type: 'cylinder', size: [0.05, 0.015], density: 1800, solref: [0.075, 1.0] }],
          children: [],
        },
        // 3. Tilted hardwood ramp + rolling glass marble
        {
          id: 'hardwood_ramp',
          name: 'Hardwood Ramp',
          pos: [0.28, 0, 0.08],
          euler: [0, 16, 0],
          deformMaterial: 'hardwood',
          joints: [],
          geoms: [{ name: 'ramp_deck', type: 'box', size: [0.18, 0.04, 0.008], friction: [0.48, 0.005, 0.0001] }],
          children: [],
        },
        {
          id: 'glass_marble',
          name: 'Glass Marble',
          pos: [0.18, 0, 0.145],
          deformMaterial: 'glass',
          joints: [{ name: 'marble_free', type: 'free' }],
          geoms: [{ name: 'marble_sphere', type: 'sphere', size: [0.014], friction: [0.48, 0.005, 0.0001] }],
          children: [],
        },
      ],
    };

    const sim = await simulate(testScene);
    try {
      const bellBodyId = sim.bodyId('Static Bronze Bell');
      const clapperBodyId = sim.bodyId('Steel Clapper');
      const bladderBodyId = sim.bodyId('Rubber Bladder');
      const stompBodyId = sim.bodyId('Stomp Mass');
      const rampBodyId = sim.bodyId('Hardwood Ramp');
      const marbleBodyId = sim.bodyId('Glass Marble');

      // Static 0-DOF bell has nv == 0 (body_dofnum === 0), yet Newton's 3rd law attributes clapper impulse to it!
      expect(sim.model.body_dofnum[bellBodyId]).toBe(0);
      const clapperDof = sim.model.body_dofadr[clapperBodyId];
      const stompDof = sim.model.body_dofadr[stompBodyId];
      const marbleDof = sim.model.body_dofadr[marbleBodyId];

      let maxStaticBellForce = 0;
      let maxSuppressedBladderImpulse = 0;
      let rollingFrames = 0;

      for (let step = 0; step < 300; step++) {
        sim.step(1);
        const dt = sim.model.opt.timestep;
        const cVec = sim.data.contact;
        const ncon = sim.data.ncon;
        try {
          for (let i = 0; i < ncon; i++) {
            const ct = cVec.get(i);
            try {
              const g1 = ct.geom1;
              const g2 = ct.geom2;
              const b1 = sim.model.geom_bodyid[g1];
              const b2 = sim.model.geom_bodyid[g2];

              if ((b1 === bellBodyId && b2 === clapperBodyId) || (b2 === bellBodyId && b1 === clapperBodyId)) {
                const fn = Math.hypot(
                  sim.data.qfrc_constraint[clapperDof],
                  sim.data.qfrc_constraint[clapperDof + 1],
                  sim.data.qfrc_constraint[clapperDof + 2],
                );
                maxStaticBellForce = Math.max(maxStaticBellForce, fn);
              }

              if ((b1 === bladderBodyId && b2 === stompBodyId) || (b2 === bladderBodyId && b1 === stompBodyId)) {
                const fn = Math.abs(sim.data.qfrc_constraint[stompDof]);
                const solTime = Math.max(sim.model.geom_solref[g1 * 2], sim.model.geom_solref[g2 * 2]);
                const solDamp = Math.max(sim.model.geom_solref[g1 * 2 + 1], sim.model.geom_solref[g2 * 2 + 1]);
                const scale = computeImpactSolSoftScale(solTime, solDamp, dt, false);
                maxSuppressedBladderImpulse = Math.max(maxSuppressedBladderImpulse, fn * dt * scale);
              }

              if ((b1 === marbleBodyId && b2 === rampBodyId) || (b2 === marbleBodyId && b1 === rampBodyId)) {
                const fn = Math.hypot(
                  sim.data.qfrc_constraint[marbleDof],
                  sim.data.qfrc_constraint[marbleDof + 1],
                  sim.data.qfrc_constraint[marbleDof + 2],
                );
                const vx = sim.data.qvel[marbleDof];
                const vy = sim.data.qvel[marbleDof + 1];
                const vz = sim.data.qvel[marbleDof + 2];
                const wx = sim.data.qvel[marbleDof + 3];
                const wy = sim.data.qvel[marbleDof + 4];
                const wz = sim.data.qvel[marbleDof + 5];
                const vCom = Math.hypot(vx, vy, vz);
                const vRoll = Math.hypot(wx, wy, wz) * 0.014;
                if (fn > 0.05 && vCom > 0.08 && vRoll > 0.05) {
                  rollingFrames++;
                }
              }
            } finally {
              ct.delete();
            }
          }
        } finally {
          cVec.delete();
        }
      }

      expect(maxStaticBellForce).toBeGreaterThan(2.0);
      expect(maxSuppressedBladderImpulse).toBeLessThan(0.015);
      expect(rollingFrames).toBeGreaterThan(25);
    } finally {
      sim.dispose();
    }
  });

  it('dispatches CONTACT_FRICTION and AUDIO_DAMPING messages on PhysicsWorkerClient', async () => {
    const prevWorker = (globalThis as Record<string, unknown>).Worker;
    let workerInstance: { onmessage: ((evt: MessageEvent) => void) | null } | null = null;
    (globalThis as Record<string, unknown>).Worker = class {
      onmessage: ((evt: MessageEvent) => void) | null = null;
      onerror: ((evt: ErrorEvent) => void) | null = null;
      postMessage = vi.fn();
      terminate = vi.fn();
      constructor() {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        workerInstance = this;
      }
    };

    try {
      const { PhysicsWorkerClient } = await import('../src/store/physicsWorkerClient');
      const client = new PhysicsWorkerClient();
      const onFriction = vi.fn();
      const onDamping = vi.fn();
      client.onContactFriction = onFriction;
      client.onAudioDamping = onDamping;

      const frictionContacts: ContinuousContactEvent[] = [
        {
          nodeId: 'marble_1',
          otherNodeId: 'wood_track',
          tangentSpeed: 0.42,
          normalForce: 0.65,
          muFriction: 0.35,
          rollingRatio: 0.92,
          contactDurationSec: 0.18,
        },
      ];
      const dampingContacts: AudioDampingEvent[] = [
        {
          nodeId: 'singing_bell',
          dampingNodeId: 'felt_pad',
          normalForce: 3.2,
          dampingRate: 14.5,
          softness: 0.78,
        },
      ];

      workerInstance!.onmessage!({ data: { type: 'CONTACT_FRICTION', contacts: frictionContacts } } as MessageEvent);
      workerInstance!.onmessage!({ data: { type: 'AUDIO_DAMPING', contacts: dampingContacts } } as MessageEvent);

      expect(onFriction).toHaveBeenCalledTimes(1);
      expect(onFriction).toHaveBeenCalledWith(frictionContacts);
      expect(onDamping).toHaveBeenCalledTimes(1);
      expect(onDamping).toHaveBeenCalledWith(dampingContacts);

      client.terminate();
    } finally {
      if (prevWorker === undefined) {
        delete (globalThis as Record<string, unknown>).Worker;
      } else {
        (globalThis as Record<string, unknown>).Worker = prevWorker;
      }
    }
  });
});
