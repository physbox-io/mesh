import { afterEach, describe, expect, it } from 'vitest';
import type { SceneNode } from '../src/types/scene';
import {
  estimateBodyModes,
  playModalImpact,
  resolveTwoBodyImpact,
  unlockAudioContext,
  updateLiveAeroVoices,
  updateLiveBowedVoices,
  updateLiveFrictionVoices,
  updateLiveWindVoices,
  type BodyModalProfile,
} from '../src/utils/modalAudio';
import {
  postWorkletAeroUpdate,
  postWorkletBowedUpdate,
  postWorkletWindUpdate,
  type SpatialAeroSynthParams,
  type WorkletBowedVoicePayload,
  type WorkletWindVoicePayload,
} from '../src/utils/modalAudioWorklet';

type ParamEvent =
  | { op: 'cancel'; time: number }
  | { op: 'setValue'; value: number; time: number }
  | { op: 'setTarget'; value: number; time: number; tau: number };

interface RecordingParam {
  value: number;
  events: ParamEvent[];
  setValueAtTime: (value: number, time: number) => void;
  linearRampToValueAtTime: (value: number, time: number) => void;
  exponentialRampToValueAtTime: (value: number, time: number) => void;
  setTargetAtTime: (value: number, time: number, tau: number) => void;
  cancelScheduledValues: (time: number) => void;
  cancelAndHoldAtTime: (time: number) => void;
}

function makeRecordingParam(init = 0): RecordingParam {
  const events: ParamEvent[] = [];
  return {
    value: init,
    events,
    setValueAtTime(value: number, time: number) {
      events.push({ op: 'setValue', value, time });
      this.value = value;
    },
    linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {},
    setTargetAtTime(value: number, time: number, tau: number) {
      events.push({ op: 'setTarget', value, time, tau });
      this.value = value;
    },
    cancelScheduledValues(time: number) {
      events.push({ op: 'cancel', time });
    },
    cancelAndHoldAtTime() {},
  };
}

function createRecordingMockAudioContext(sampleRate = 48000) {
  let now = 1.0;
  let resumeCalls = 0;

  const makeNode = (extra: Record<string, unknown> = {}) => ({
    connect: () => {},
    disconnect: () => {},
    ...extra,
  });

  const ctx = {
    get currentTime() {
      return now;
    },
    set currentTime(t: number) {
      now = t;
    },
    sampleRate,
    state: 'running' as AudioContextState,
    destination: makeNode(),
    resume: () => {
      resumeCalls++;
      return Promise.resolve();
    },
    suspend: () => Promise.resolve(),
    createGain: () => makeNode({ gain: makeRecordingParam(1) }),
    createOscillator: () =>
      makeNode({
        type: 'sine',
        frequency: makeRecordingParam(440),
        detune: makeRecordingParam(0),
        setPeriodicWave: () => {},
        start: () => {},
        stop: () => {},
      }),
    createBiquadFilter: () =>
      makeNode({
        type: 'lowpass',
        frequency: makeRecordingParam(1000),
        Q: makeRecordingParam(1),
        gain: makeRecordingParam(0),
      }),
    createWaveShaper: () => makeNode({ curve: null, oversample: 'none' }),
    createStereoPanner: () => makeNode({ pan: makeRecordingParam(0) }),
    createDynamicsCompressor: () =>
      makeNode({
        threshold: makeRecordingParam(-3),
        knee: makeRecordingParam(6),
        ratio: makeRecordingParam(10),
        attack: makeRecordingParam(0.002),
        release: makeRecordingParam(0.12),
      }),
    createChannelSplitter: () => makeNode(),
    createChannelMerger: () => makeNode(),
    createConvolver: () => makeNode({ normalize: false, buffer: null }),
    createPeriodicWave: () => ({}),
    createBuffer: (ch: number, len: number, sr: number) => {
      const channels = Array.from({ length: ch }, () => new Float32Array(len));
      return {
        numberOfChannels: ch,
        length: len,
        sampleRate: sr,
        getChannelData: (i: number) => channels[i],
      };
    },
    createBufferSource: () =>
      makeNode({
        buffer: null,
        loop: false,
        onended: null as (() => void) | null,
        start: () => {},
        stop: () => {},
      }),
  } as unknown as AudioContext & {
    __physboxNativeWindV18?: { slots: { id: string; noiseGain: { gain: RecordingParam }; squelchDepth: { gain: RecordingParam } }[] };
    __physboxNativeBowedV7?: { slots: { id: string; voiceGain: { gain: RecordingParam }; releaseUntilTime: number }[] };
    __physboxNativeAeroV2?: {
      slots: {
        id: string;
        amFreqDepth: { gain: RecordingParam };
        gustFormantDepth: { gain: RecordingParam };
      }[];
    };
  };

  return {
    ctx,
    getResumeCalls: () => resumeCalls,
    setTime: (t: number) => {
      now = t;
    },
  };
}

function makeSimpleBarNode(id = 'test_bar'): SceneNode {
  return {
    id,
    name: 'Test Bar',
    pos: [0, 0, 0.2],
    deformMaterial: 'hardwood',
    geoms: [{ name: 'bar_geom', type: 'box', size: [0.16, 0.025, 0.01] }],
  };
}

const origWindow = globalThis.window;
const origDocument = globalThis.document;

afterEach(() => {
  if (origWindow === undefined) {
    delete (globalThis as Record<string, unknown>).window;
  } else {
    (globalThis as Record<string, unknown>).window = origWindow;
  }
  if (origDocument === undefined) {
    delete (globalThis as Record<string, unknown>).document;
  } else {
    (globalThis as Record<string, unknown>).document = origDocument;
  }
});

describe('Runtime audio engine & DSP audit fixes', () => {
  it('1. recovers cleanly when shared AudioContext transitions to closed', () => {
    const created: ReturnType<typeof createRecordingMockAudioContext>[] = [];
    class MockAudioContext {
      constructor() {
        const inst = createRecordingMockAudioContext(48000);
        created.push(inst);
        return inst.ctx as unknown as MockAudioContext;
      }
    }

    (globalThis as Record<string, unknown>).window = {
      AudioContext: MockAudioContext,
    };
    (globalThis as Record<string, unknown>).document = {
      visibilityState: 'visible',
    };

    const ctx1 = unlockAudioContext();
    expect(ctx1).toBeTruthy();
    expect(created.length).toBe(1);

    // Simulate OS audio teardown closing the context
    (ctx1 as unknown as { state: AudioContextState }).state = 'closed';

    const ctx2 = unlockAudioContext();
    expect(ctx2).toBeTruthy();
    expect(ctx2).not.toBe(ctx1);
    expect(ctx2?.state).toBe('running');
    expect(created.length).toBe(2);

    // Clean up module-level sharedAudioCtx by marking ctx2 closed for subsequent tests
    (ctx2 as unknown as { state: AudioContextState }).state = 'closed';
  });

  it('2. skips AudioContext allocation on empty arrays and hidden tabs in continuous updaters', () => {
    let ctorCalls = 0;
    const mockHolder = createRecordingMockAudioContext(48000);
    class CountingAudioContext {
      constructor() {
        ctorCalls++;
        return mockHolder.ctx as unknown as CountingAudioContext;
      }
    }

    (globalThis as Record<string, unknown>).window = {
      AudioContext: CountingAudioContext,
    };
    const mockDoc = { visibilityState: 'visible' as DocumentVisibilityState };
    (globalThis as Record<string, unknown>).document = mockDoc;

    // Empty arrays when no AudioContext exists must NOT allocate one
    updateLiveWindVoices([]);
    updateLiveBowedVoices([]);
    updateLiveAeroVoices([]);
    updateLiveFrictionVoices([]);
    expect(ctorCalls).toBe(0);

    // Hidden tab must return early even for non-empty voice arrays
    mockDoc.visibilityState = 'hidden';
    updateLiveWindVoices([
      { id: 'flute', exciter: 'air_jet', breathKPa: 2.0, embouchureHz: 440, bellCutoffHz: 1800 },
    ]);
    updateLiveBowedVoices([
      {
        id: 'cello_a',
        active: true,
        pitchHz: 220,
        amplitude: 0.4,
        harmonicWeights: [1, 0.5, 0.25],
        bodyFormantHz: 500,
        bodyFormantGainDb: 4,
        bodyFormantQ: 2,
        secondaryFormantHz: 900,
        lowpassHz: 2400,
        rosinNoiseGain: 0.1,
        rosinCenterHz: 2000,
      },
    ]);
    updateLiveAeroVoices([
      {
        id: 'flag',
        active: true,
        tonalActive: false,
        bpfHz: 0,
        tonalGain: 0,
        harmonicWeights: [],
        stallRoughness: 0,
        noiseCenterHz: 300,
        noiseQ: 1.5,
        noiseGain: 0.3,
        amRateHz: 4,
        amDepth: 0.5,
        rustleGain: 0,
        rustleFreqHz: 2000,
        lowpassHz: 900,
        aeolianGain: 0,
        aeolianFreqHz: 200,
      },
    ]);
    updateLiveFrictionVoices([
      {
        id: 'slide',
        active: true,
        regime: 'sliding',
        noiseGain: 0.2,
        noiseCenterHz: 800,
        noiseQ: 1.4,
        patchLowpassHz: 2200,
        grainRateHz: 18,
        grainDepth: 0.2,
        tonalGain: 0,
        tonalFreq1Hz: 440,
        tonalFreq2Hz: 442,
        tonalDrive: 0.5,
        mode1Hz: 440,
        mode1Q: 4,
        mode1GainDb: 6,
        mode2Hz: 980,
        mode2Q: 3,
        mode2GainDb: 4,
        attackTauSec: 0.02,
      },
    ]);
    expect(ctorCalls).toBe(0);
    expect(mockHolder.getResumeCalls()).toBe(0);
  });

  it('3. rejects zero/negative/NaN impulseNs in playModalImpact and prevents NaN in resolveTwoBodyImpact', () => {
    const mockHolder = createRecordingMockAudioContext(48000);
    class MockAudioContext {
      constructor() {
        return mockHolder.ctx as unknown as MockAudioContext;
      }
    }
    (globalThis as Record<string, unknown>).window = {
      AudioContext: MockAudioContext,
    };
    (globalThis as Record<string, unknown>).document = {
      visibilityState: 'visible',
    };

    const node = makeSimpleBarNode();
    const profile = estimateBodyModes(node);

    expect(playModalImpact(profile, 0)).toBeNull();
    expect(playModalImpact(profile, -0.5)).toBeNull();
    expect(playModalImpact(profile, Number.NaN)).toBeNull();
    expect(playModalImpact(profile, 0, true)).toBeNull();
    expect(
      playModalImpact(profile, 0.2, false, {
        tauC: 0.001,
        effectiveBrightness: 0.5,
        radiationScale: Number.NaN,
        voices: profile.modes,
      }),
    ).toBeNull();

    // NaN impulseNs & NaN localPoint must be sanitized in resolveTwoBodyImpact
    const impact = resolveTwoBodyImpact(profile, node, {
      impulseNs: Number.NaN,
      localPoint: [Number.NaN, 0, 0],
    });
    expect(Number.isFinite(impact.tauC)).toBe(true);
    expect(impact.strikeXi).toBeUndefined();
    expect(impact.voices.length).toBeGreaterThan(0);
    for (const v of impact.voices) {
      expect(Number.isFinite(v.freqHz)).toBe(true);
      expect(Number.isFinite(v.gain)).toBe(true);
      expect(Number.isFinite(v.decaySec)).toBe(true);
    }

    // NaN entries in rawFreqsHz / rawBaseGains must be skipped cleanly
    const poisonedProfile: BodyModalProfile = {
      ...profile,
      rawFreqsHz: [Number.NaN, 440, Infinity, 880],
      rawBaseGains: [1.0, Number.NaN, 0.5, 0.7],
    };
    const poisonedImpact = resolveTwoBodyImpact(poisonedProfile, node, { impulseNs: 0.2 });
    expect(poisonedImpact.voices.length).toBe(1);
    expect(poisonedImpact.voices[0].freqHz).toBeCloseTo(880, 1);
    expect(Number.isFinite(poisonedImpact.voices[0].gain)).toBe(true);
    expect(Number.isFinite(poisonedImpact.voices[0].decaySec)).toBe(true);

    (mockHolder.ctx as unknown as { state: AudioContextState }).state = 'closed';
  });

  it('4. cancels pending future brass_lip noiseGain events on subsequent update and release', () => {
    const { ctx, setTime } = createRecordingMockAudioContext(48000);
    const brassVoice: WorkletWindVoicePayload = {
      id: 'cornet_1',
      exciter: 'brass_lip',
      breathKPa: 3.5,
      embouchureHz: 330,
      boreShape: 'flared_horn',
      resonantModesHz: [165, 330, 495, 660],
      modeImpedancePeaks: [1, 0.9, 0.75, 0.6],
      bellCutoffHz: 1600,
    };

    // t = 1.000: fresh brass_lip attack schedules setTargetAtTime(..., 1.014, 0.016)
    setTime(1.0);
    postWorkletWindUpdate(ctx, [brassVoice]);
    const slot = ctx.__physboxNativeWindV18!.slots.find((s) => s.id === 'cornet_1')!;
    expect(slot).toBeTruthy();

    // t = 1.004 (within 14 ms): sustained update must cancel prior future event before setTargetAtTime
    slot.noiseGain.gain.events.length = 0;
    setTime(1.004);
    postWorkletWindUpdate(ctx, [brassVoice]);
    expect(slot.noiseGain.gain.events.length).toBeGreaterThanOrEqual(2);
    expect(slot.noiseGain.gain.events[0]).toEqual({ op: 'cancel', time: 1.004 });
    expect(slot.noiseGain.gain.events[1].op).toBe('setTarget');

    // t = 1.008 (still within 14 ms): release must cancel prior future event before ramping to 0
    slot.noiseGain.gain.events.length = 0;
    setTime(1.008);
    postWorkletWindUpdate(ctx, []);
    expect(slot.noiseGain.gain.events.length).toBeGreaterThanOrEqual(2);
    expect(slot.noiseGain.gain.events[0]).toEqual({ op: 'cancel', time: 1.008 });
    expect(slot.noiseGain.gain.events[1]).toEqual({ op: 'setTarget', value: 0, time: 1.008, tau: 0.008 });
  });

  it('5. orders cancelScheduledValues(now) before setValueAtTime(0, now) when stealing a releasing bowed slot', () => {
    const { ctx, setTime } = createRecordingMockAudioContext(48000);
    const makeBowed = (id: string, pitchHz: number): WorkletBowedVoicePayload => ({
      id,
      active: true,
      pitchHz,
      amplitude: 0.45,
      harmonicWeights: [1, 0.5, 0.3, 0.2],
      bodyFormantHz: 500,
      bodyFormantGainDb: 4,
      bodyFormantQ: 2,
      secondaryFormantHz: 950,
      lowpassHz: 2600,
      rosinNoiseGain: 0.08,
      rosinCenterHz: 2100,
    });

    // Occupy all 6 bowed slots at t = 1.0
    setTime(1.0);
    const sixVoices = Array.from({ length: 6 }, (_, i) => makeBowed(`str_${i}`, 110 + i * 55));
    postWorkletBowedUpdate(ctx, sixVoices);

    // Release str_0 at t = 1.05 so it enters its 380 ms release tail (releaseUntilTime = 1.43)
    setTime(1.05);
    postWorkletBowedUpdate(ctx, sixVoices.slice(1));
    const releasingSlot = ctx.__physboxNativeBowedV7!.slots.find((s) => s.id === 'str_0')!;
    expect(releasingSlot.releaseUntilTime).toBeGreaterThan(1.1);
    releasingSlot.voiceGain.gain.events.length = 0;

    // At t = 1.10 (still inside str_0's release tail), introduce str_new to steal that slot
    setTime(1.1);
    postWorkletBowedUpdate(ctx, [...sixVoices.slice(1), makeBowed('str_new', 440)]);
    expect(releasingSlot.id).toBe('str_new');

    const evs = releasingSlot.voiceGain.gain.events;
    const cancelIdx = evs.findIndex((e) => e.op === 'cancel' && e.time === 1.1);
    const zeroIdx = evs.findIndex((e) => e.op === 'setValue' && e.value === 0 && e.time === 1.1);
    const targetIdx = evs.findIndex((e) => e.op === 'setTarget' && e.time === 1.1);

    expect(cancelIdx).toBeGreaterThanOrEqual(0);
    expect(zeroIdx).toBeGreaterThan(cancelIdx);
    expect(targetIdx).toBeGreaterThan(zeroIdx);
  });

  it('6. caps Wind & Aero A-rate LFO modulation depths within (0, nyquistSafe] and snaps on fresh attack', () => {
    // Low 8 kHz context -> nyquistSafe = 3800 Hz
    const { ctx, setTime } = createRecordingMockAudioContext(8000);
    const nyquistSafe = 8000 * 0.475;

    // 6a. Wind bank: high bell cutoff near Nyquist + fresh attack snap
    setTime(1.0);
    postWorkletWindUpdate(ctx, [
      {
        id: 'whistle_hi',
        exciter: 'air_jet',
        breathKPa: 4.0,
        embouchureHz: 2400,
        resonantModesHz: [2400, 3600],
        modeImpedancePeaks: [1, 0.8],
        bellCutoffHz: 5000, // clamped to nyquistSafe = 3800
        breachFactor: 0.9,
      },
    ]);
    const windSlot = ctx.__physboxNativeWindV18!.slots.find((s) => s.id === 'whistle_hi')!;
    const windEvs = windSlot.squelchDepth.gain.events;
    const windCancelIdx = windEvs.findIndex((e) => e.op === 'cancel' && e.time === 1.0);
    const windSnapIdx = windEvs.findIndex((e, i) => i > windCancelIdx && e.op === 'setValue' && e.time === 1.0);
    expect(windCancelIdx).toBeGreaterThanOrEqual(0);
    expect(windSnapIdx).toBeGreaterThan(windCancelIdx);
    // Since bellLp1Hz is clamped to nyquistSafe (3800), headroom is 0 -> squelchDepth must be 0
    expect(windSlot.squelchDepth.gain.value).toBeLessThanOrEqual(0.001);

    // 6b. Aero bank: lowpassHz < strouhalHz floor guard + fresh snap
    const lowLpAero: SpatialAeroSynthParams = {
      id: 'aero_low_lp',
      active: true,
      tonalActive: false,
      bpfHz: 0,
      tonalGain: 0,
      harmonicWeights: [],
      stallRoughness: 0,
      noiseCenterHz: 600,
      noiseQ: 1.6,
      noiseGain: 0.5,
      amRateHz: 5.0,
      amDepth: 1.0,
      rustleGain: 0,
      rustleFreqHz: 2000,
      lowpassHz: 120,
      aeolianGain: 0,
      aeolianFreqHz: 180,
    };
    setTime(1.2);
    postWorkletAeroUpdate(ctx, [lowLpAero]);
    const aeroSlot = ctx.__physboxNativeAeroV2!.slots.find((s) => s.id === 'aero_low_lp')!;
    const combinedLow = aeroSlot.amFreqDepth.gain.value + aeroSlot.gustFormantDepth.gain.value;
    expect(combinedLow).toBeLessThanOrEqual(0.42 * 120 + 1e-6);
    expect(120 - combinedLow).toBeGreaterThan(0);

    // Verify fresh attack snapped both depth gains via cancel + setValue
    expect(aeroSlot.amFreqDepth.gain.events.some((e) => e.op === 'cancel' && e.time === 1.2)).toBe(true);
    expect(aeroSlot.amFreqDepth.gain.events.some((e) => e.op === 'setValue' && e.time === 1.2)).toBe(true);
    expect(aeroSlot.gustFormantDepth.gain.events.some((e) => e.op === 'cancel' && e.time === 1.2)).toBe(true);
    expect(aeroSlot.gustFormantDepth.gain.events.some((e) => e.op === 'setValue' && e.time === 1.2)).toBe(true);

    // 6c. Aero bank: near-Nyquist headroom guard (3700 Hz on 3800 Hz nyquistSafe -> max 100 Hz total mod)
    const hiAero: SpatialAeroSynthParams = {
      ...lowLpAero,
      id: 'aero_hi_nyq',
      noiseCenterHz: 3600,
      lowpassHz: 3700,
    };
    setTime(1.4);
    postWorkletAeroUpdate(ctx, [hiAero]);
    const hiSlot = ctx.__physboxNativeAeroV2!.slots.find((s) => s.id === 'aero_hi_nyq')!;
    const combinedHi = hiSlot.amFreqDepth.gain.value + hiSlot.gustFormantDepth.gain.value;
    expect(combinedHi).toBeLessThanOrEqual(nyquistSafe - 3700 + 1e-6);
    expect(3700 + combinedHi).toBeLessThanOrEqual(nyquistSafe + 1e-6);
  });
});
