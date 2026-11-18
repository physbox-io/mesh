// ---------------------------------------------------------------------------
// Native C++ WebAudio Physical Bore & Reed / Lip / Jet Synthesizer
// ---------------------------------------------------------------------------
//
// Driven directly by the 1D Conical Transfer-Matrix (TMM) input-impedance
// spectrum `Z_in(f)` of the 3D mesh (`solvePlayableWindVoice`):
//   - Band-limited C++ `PeriodicWave` harmonic synthesis (`H_1..H_10`) weighted
//     by the actual bore impedance & stub anti-resonances at `n * f_0`
//   - Nonlinear waveshaper + 24 dB/oct dual-stage bell radiation filter with
//     Risset attack-bloom / release-tuck & muted-bell formant Q
//   - Turbulent vortex air-leak noise proportional to unpadded hole/breach area
//   - Subtle 0.68 s studio-room `ConvolverNode` presence
//
// Zero `ScriptProcessorNode`, zero main-thread JS sample loops, and zero
// buffer-underrun pops/clicks!
// ---------------------------------------------------------------------------

import type { WindExciterKind } from '../types/scene';
import type { ModalVoice } from './modalAudio';
import { solvePlayableWindVoice } from './windAcoustics';

export interface WorkletWindVoicePayload {
  id: string;
  exciter: WindExciterKind;
  breathKPa: number;
  embouchureHz: number;
  boreShape?: 'cylindrical' | 'conical' | 'flared_horn';
  resonantModesHz?: number[];
  modeImpedancePeaks?: number[];
  impedanceGrid?: { fMin: number; fStep: number; magNorm: number[] };
  muteFactor?: number;
  breachFactor?: number;
  bellCutoffHz: number;
  mouthRadiusM?: number;
  bellRadiusM?: number;
  cellCount?: number;
  exactCells?: number;
  junctionK?: number[];
  shunts?: { cell: number; coeff: number }[];
}

export interface WorkletStrikePayload {
  type: 'STRIKE';
  level: number;
  tauC: number;
  brightness: number;
  isPluck?: boolean;
  voices: ModalVoice[];
}

interface NativeWindVoiceSlot {
  id: string;
  wasActive: boolean;
  lastPitchHz: number;
  lastWaveSig: string;
  osc: OscillatorNode;
  vibOsc: OscillatorNode;
  vibDepth: GainNode;
  driveGain: GainNode;
  shaper: WaveShaperNode;
  bodyFormant: BiquadFilterNode;
  bellLowpass1: BiquadFilterNode;
  bellLowpass2: BiquadFilterNode;
  voiceGain: GainNode;
  noiseFilter: BiquadFilterNode;
  noiseGain: GainNode;
}

interface NativeWindBankState {
  masterGain: GainNode;
  presenceShelf: BiquadFilterNode;
  dryGain: GainNode;
  wetGain: GainNode;
  convolver: ConvolverNode | null;
  noiseSource: AudioBufferSourceNode | null;
  slots: NativeWindVoiceSlot[];
  softSatCurve: Float32Array<ArrayBuffer>;
}

interface LegacyWindGraphState {
  outGain?: GainNode;
  masterGain?: GainNode;
  dryGain?: GainNode;
  wetGain?: GainNode;
  roomWetGain?: GainNode;
  noiseSource?: AudioBufferSourceNode | null;
  processor?: AudioNode | null;
  keepAlive?: ConstantSourceNode;
}

type AudioContextWithWindGraph = AudioContext & {
  __physboxWindWaveguideV5?: LegacyWindGraphState;
  __physboxWindWaveguideV6?: LegacyWindGraphState;
  __physboxWindWaveguideV7?: LegacyWindGraphState;
  __physboxWindWaveguideV8?: LegacyWindGraphState;
  __physboxWindWaveguideV9?: LegacyWindGraphState;
  __physboxNativeWindV10?: LegacyWindGraphState;
  __physboxNativeWindV11?: LegacyWindGraphState;
  __physboxNativeWindV12?: LegacyWindGraphState;
  __physboxNativeWindV13?: LegacyWindGraphState;
  __physboxNativeWindV14?: LegacyWindGraphState;
  __physboxNativeWindV15?: NativeWindBankState;
};

function buildSoftSatCurve(): Float32Array<ArrayBuffer> {
  const N = 1025;
  const curve = new Float32Array(new ArrayBuffer(N * 4));
  const norm = Math.tanh(1.35);
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * 2 - 1;
    curve[i] = Math.tanh(1.35 * x) / norm;
  }
  return curve;
}

/** Synthesizes a tight, natural 0.68s stereo studio-room impulse response (subtle presence, non-cathedral). */
function buildStudioChamberIR(ctx: AudioContext): AudioBuffer {
  const sr = ctx.sampleRate || 48000;
  const dur = 0.68;
  const len = Math.floor(sr * dur);
  const ir = ctx.createBuffer(2, len, sr);
  const left = ir.getChannelData(0);
  const right = ir.getChannelData(1);

  const earlyL: [number, number][] = [
    [0.011, 0.30],
    [0.019, -0.20],
    [0.029, 0.14],
    [0.042, 0.10],
  ];
  const earlyR: [number, number][] = [
    [0.014, 0.28],
    [0.022, -0.21],
    [0.033, 0.14],
    [0.046, 0.09],
  ];
  for (const [tSec, amp] of earlyL) {
    const idx = Math.floor(tSec * sr);
    if (idx < len) left[idx] += amp;
  }
  for (const [tSec, amp] of earlyR) {
    const idx = Math.floor(tSec * sr);
    if (idx < len) right[idx] += amp;
  }

  let seedL = 0x2468ace1;
  let seedR = 0x9e3779b9;
  let lpL = 0, lpR = 0;
  let hpL = 0, hpR = 0;
  for (let i = Math.floor(0.010 * sr); i < len; i++) {
    const t = i / sr;
    const env = Math.exp(-t / 0.18) * (1 - Math.exp(-t / 0.015));
    seedL = (Math.imul(seedL, 1664525) + 1013904223) | 0;
    seedR = (Math.imul(seedR, 22695477) + 1) | 0;
    const wL = seedL / 2147483648;
    const wR = seedR / 2147483648;
    const damp = 0.34 * Math.exp(-t * 1.8) + 0.08;
    lpL += damp * (wL - lpL);
    lpR += damp * (wR - lpR);
    hpL += 0.018 * (lpL - hpL);
    hpR += 0.018 * (lpR - hpR);
    left[i] += (lpL - hpL) * env * 0.22;
    right[i] += (lpR - hpR) * env * 0.22;
  }

  return ir;
}

function disconnectLegacyGraphs(c: AudioContextWithWindGraph): void {
  for (const oldKey of [
    '__physboxWindWaveguideV5',
    '__physboxWindWaveguideV6',
    '__physboxWindWaveguideV7',
    '__physboxWindWaveguideV8',
    '__physboxWindWaveguideV9',
    '__physboxNativeWindV10',
    '__physboxNativeWindV11',
    '__physboxNativeWindV12',
    '__physboxNativeWindV13',
    '__physboxNativeWindV14',
  ] as const) {
    const prev = c[oldKey];
    if (prev) {
      try { prev.keepAlive?.stop(); } catch { /* ignore */ }
      try { prev.keepAlive?.disconnect(); } catch { /* ignore */ }
      try { prev.noiseSource?.stop(); } catch { /* ignore */ }
      try { prev.noiseSource?.disconnect(); } catch { /* ignore */ }
      try { prev.processor?.disconnect(); } catch { /* ignore */ }
      try { prev.outGain?.disconnect(); } catch { /* ignore */ }
      try { prev.dryGain?.disconnect(); } catch { /* ignore */ }
      try { prev.wetGain?.disconnect(); } catch { /* ignore */ }
      try { prev.roomWetGain?.disconnect(); } catch { /* ignore */ }
      try { prev.masterGain?.disconnect(); } catch { /* ignore */ }
      delete c[oldKey];
    }
  }
}

function ensureNativeWindBank(ctx: AudioContext): NativeWindBankState | null {
  const c = ctx as AudioContextWithWindGraph;
  disconnectLegacyGraphs(c);
  if (c.__physboxNativeWindV15) return c.__physboxNativeWindV15;
  if (typeof ctx.createOscillator !== 'function' || typeof ctx.createWaveShaper !== 'function') {
    return null;
  }

  const softSatCurve = buildSoftSatCurve();
  const now = ctx.currentTime;

  const masterGain = ctx.createGain();
  masterGain.gain.setValueAtTime(0.95, now);

  const presenceShelf = ctx.createBiquadFilter();
  presenceShelf.type = 'peaking';
  presenceShelf.frequency.setValueAtTime(1850, now);
  presenceShelf.Q.setValueAtTime(0.85, now);
  presenceShelf.gain.setValueAtTime(2.4, now);

  // Transparent safety limiter so rapid polyphonic marimba/glockenspiel/lyre strums never clip
  let outputTarget: AudioNode = ctx.destination;
  if (typeof ctx.createDynamicsCompressor === 'function') {
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.setValueAtTime(-3.0, now);
    limiter.knee.setValueAtTime(6.0, now);
    limiter.ratio.setValueAtTime(10.0, now);
    limiter.attack.setValueAtTime(0.002, now);
    limiter.release.setValueAtTime(0.12, now);
    limiter.connect(ctx.destination);
    outputTarget = limiter;
  }

  const dryGain = ctx.createGain();
  dryGain.gain.setValueAtTime(0.90, now);
  const wetGain = ctx.createGain();
  wetGain.gain.setValueAtTime(0.13, now);

  masterGain.connect(presenceShelf);
  presenceShelf.connect(dryGain);
  dryGain.connect(outputTarget);

  let convolver: ConvolverNode | null = null;
  if (typeof ctx.createConvolver === 'function' && typeof ctx.createBuffer === 'function') {
    convolver = ctx.createConvolver();
    convolver.normalize = false;
    convolver.buffer = buildStudioChamberIR(ctx);
    presenceShelf.connect(convolver);
    convolver.connect(wetGain);
    wetGain.connect(outputTarget);
  }

  let noiseSource: AudioBufferSourceNode | null = null;
  if (typeof ctx.createBuffer === 'function' && typeof ctx.createBufferSource === 'function') {
    const sr = ctx.sampleRate || 48000;
    const len = Math.floor(sr * 2.5);
    const noiseBuf = ctx.createBuffer(1, len, sr);
    const ch = noiseBuf.getChannelData(0);
    let lpState = 0;
    let seed = 0x13579bdf;
    for (let i = 0; i < len; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      const white = seed / 2147483648;
      lpState = 0.72 * lpState + 0.28 * white;
      ch[i] = lpState;
    }
    noiseSource = ctx.createBufferSource();
    noiseSource.buffer = noiseBuf;
    noiseSource.loop = true;
    noiseSource.start(now);
  }

  const slots: NativeWindVoiceSlot[] = [];
  for (let i = 0; i < 4; i++) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(261.63, now);

    const vibOsc = ctx.createOscillator();
    vibOsc.type = 'sine';
    vibOsc.frequency.setValueAtTime(5.0 + i * 0.2, now);

    const vibDepth = ctx.createGain();
    vibDepth.gain.setValueAtTime(0, now);
    vibOsc.connect(vibDepth);
    vibDepth.connect(osc.frequency);

    const driveGain = ctx.createGain();
    driveGain.gain.setValueAtTime(0.75, now);

    const shaper = ctx.createWaveShaper();
    shaper.curve = softSatCurve;
    shaper.oversample = '4x';

    const bodyFormant = ctx.createBiquadFilter();
    bodyFormant.type = 'peaking';
    bodyFormant.frequency.setValueAtTime(850, now);
    bodyFormant.Q.setValueAtTime(1.2, now);
    bodyFormant.gain.setValueAtTime(4.0, now);

    const bellLowpass1 = ctx.createBiquadFilter();
    bellLowpass1.type = 'lowpass';
    bellLowpass1.frequency.setValueAtTime(1200, now);
    bellLowpass1.Q.setValueAtTime(0.95, now);

    const bellLowpass2 = ctx.createBiquadFilter();
    bellLowpass2.type = 'lowpass';
    bellLowpass2.frequency.setValueAtTime(1600, now);
    bellLowpass2.Q.setValueAtTime(0.707, now);

    const voiceGain = ctx.createGain();
    voiceGain.gain.setValueAtTime(0, now);

    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.setValueAtTime(1100, now);
    noiseFilter.Q.setValueAtTime(1.1, now);

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0, now);

    osc.connect(driveGain);
    driveGain.connect(shaper);
    shaper.connect(bodyFormant);
    bodyFormant.connect(bellLowpass1);
    bellLowpass1.connect(bellLowpass2);
    bellLowpass2.connect(voiceGain);
    voiceGain.connect(masterGain);

    if (noiseSource) {
      noiseSource.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(masterGain);
    }

    osc.start(now);
    vibOsc.start(now);

    slots.push({
      id: '',
      wasActive: false,
      lastPitchHz: 261.63,
      lastWaveSig: '',
      osc,
      vibOsc,
      vibDepth,
      driveGain,
      shaper,
      bodyFormant,
      bellLowpass1,
      bellLowpass2,
      voiceGain,
      noiseFilter,
      noiseGain,
    });
  }

  const bank: NativeWindBankState = {
    masterGain,
    presenceShelf,
    dryGain,
    wetGain,
    convolver,
    noiseSource,
    slots,
    softSatCurve,
  };
  c.__physboxNativeWindV15 = bank;
  return bank;
}

export function getOrInitModalWorklet(ctx: AudioContext): GainNode | null {
  return ensureNativeWindBank(ctx)?.masterGain ?? null;
}

/** Shared studio-chamber output bus (presence + 0.68 s room convolver + safety limiter) for ALL acoustic instruments. */
export function getSharedAcousticOutputBus(ctx: AudioContext): AudioNode {
  return ensureNativeWindBank(ctx)?.masterGain ?? ctx.destination;
}

export function postWorkletStrike(_ctx: AudioContext, _payload: WorkletStrikePayload): boolean {
  return false;
}

export function postWorkletWindUpdate(ctx: AudioContext, voices: WorkletWindVoicePayload[]): void {
  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => {});
  }
  const bank = ensureNativeWindBank(ctx);
  if (!bank) return;

  const now = ctx.currentTime;
  const usedSlots = new Set<number>();

  for (const v of voices) {
    let idx = bank.slots.findIndex((s) => s.id === v.id);
    if (idx === -1) {
      idx = bank.slots.findIndex((s, i) => !usedSlots.has(i) && !s.wasActive);
    }
    if (idx === -1) {
      idx = bank.slots.findIndex((_s, i) => !usedSlots.has(i));
    }
    if (idx === -1) continue;
    usedSlots.add(idx);

    const slot = bank.slots[idx];
    const isNewId = slot.id !== v.id;
    slot.id = v.id;

    const solved = solvePlayableWindVoice(v, v.breathKPa, v.embouchureHz);
    if (!solved.active) {
      const tuckHz = Math.max(320, slot.lastPitchHz * 1.35);
      slot.bellLowpass1.frequency.setTargetAtTime(tuckHz, now, 0.010);
      slot.bellLowpass2.frequency.setTargetAtTime(tuckHz * 1.25, now, 0.010);
      slot.driveGain.gain.setTargetAtTime(0.45, now, 0.010);
      slot.voiceGain.gain.setTargetAtTime(0, now, 0.010);
      slot.noiseGain.gain.setTargetAtTime(0, now, 0.008);
      slot.vibDepth.gain.setTargetAtTime(0, now, 0.012);
      slot.wasActive = false;
      continue;
    }

    // Update band-limited C++ PeriodicWave from TMM harmonic weights H_1..H_10 whenever bore spectrum changes!
    const hw = solved.harmonicWeights;
    const waveSig = hw.slice(0, 8).map((w) => Math.round(w * 25)).join(',');
    const isFreshAttack = !slot.wasActive || isNewId;
    if ((isFreshAttack || slot.lastWaveSig !== waveSig) && typeof ctx.createPeriodicWave === 'function') {
      const nHarm = hw.length + 1;
      const real = new Float32Array(nHarm);
      const imag = new Float32Array(nHarm);
      for (let h = 0; h < hw.length; h++) {
        // Cosine/sine quadrature phases avoid sharp crest-factor spikes while preserving exact power spectrum!
        const amp = hw[h];
        const phase = (h + 1) * 0.35;
        real[h + 1] = amp * Math.sin(phase);
        imag[h + 1] = amp * Math.cos(phase);
      }
      slot.osc.setPeriodicWave(ctx.createPeriodicWave(real, imag, { disableNormalization: false }));
      slot.lastWaveSig = waveSig;
    }

    slot.lastPitchHz = solved.pitchHz;

    if (isFreshAttack) {
      slot.osc.frequency.cancelScheduledValues(now);
      slot.osc.frequency.setValueAtTime(solved.pitchHz, now);
      const warmStartHz = Math.max(420, solved.pitchHz * 1.45);
      slot.bellLowpass1.frequency.cancelScheduledValues(now);
      slot.bellLowpass1.frequency.setValueAtTime(warmStartHz, now);
      slot.bellLowpass2.frequency.cancelScheduledValues(now);
      slot.bellLowpass2.frequency.setValueAtTime(warmStartHz * 1.3, now);
    } else {
      slot.osc.frequency.setTargetAtTime(solved.pitchHz, now, 0.006);
    }

    slot.driveGain.gain.setTargetAtTime(0.65 + 0.45 * solved.drive, now, 0.016);
    slot.bodyFormant.frequency.setTargetAtTime(solved.formantHz, now, 0.016);
    slot.bodyFormant.gain.setTargetAtTime(solved.formantGainDb, now, 0.016);
    slot.bodyFormant.Q.setTargetAtTime(solved.formantQ, now, 0.016);
    slot.bellLowpass1.frequency.setTargetAtTime(solved.bellLowpassHz, now, 0.022);
    slot.bellLowpass1.Q.setTargetAtTime(solved.bellQ, now, 0.018);
    slot.bellLowpass2.frequency.setTargetAtTime(solved.bellLowpassHz * 1.32, now, 0.022);

    slot.voiceGain.gain.setTargetAtTime(solved.amplitude, now, 0.011);
    slot.noiseFilter.frequency.setTargetAtTime(Math.min(3200, solved.pitchHz * (2.3 + (v.breachFactor ?? 0) * 1.4)), now, 0.018);
    slot.noiseFilter.Q.setTargetAtTime(1.1 + (v.breachFactor ?? 0) * 0.9, now, 0.018);
    if (isFreshAttack && v.exciter === 'brass_lip') {
      slot.noiseGain.gain.cancelScheduledValues(now);
      slot.noiseGain.gain.setValueAtTime(Math.max(solved.noiseGain, solved.amplitude * 0.08), now);
      slot.noiseGain.gain.setTargetAtTime(solved.noiseGain, now + 0.014, 0.016);
    } else {
      slot.noiseGain.gain.setTargetAtTime(solved.noiseGain, now, 0.012);
    }
    slot.vibDepth.gain.setTargetAtTime(solved.pitchHz * 0.0024 * Math.min(1, solved.amplitude * 4), now, 0.06);

    slot.wasActive = true;
  }

  for (let i = 0; i < bank.slots.length; i++) {
    if (!usedSlots.has(i)) {
      const slot = bank.slots[i];
      slot.voiceGain.gain.setTargetAtTime(0, now, 0.010);
      slot.noiseGain.gain.setTargetAtTime(0, now, 0.008);
      slot.vibDepth.gain.setTargetAtTime(0, now, 0.012);
      slot.wasActive = false;
    }
  }
}

export function postWorkletWindSilence(ctx: AudioContext | null): void {
  if (!ctx) return;
  const c = ctx as AudioContextWithWindGraph;
  disconnectLegacyGraphs(c);
  const bank = c.__physboxNativeWindV15;
  if (!bank) return;
  const now = ctx.currentTime;
  for (const slot of bank.slots) {
    slot.voiceGain.gain.cancelScheduledValues(now);
    slot.voiceGain.gain.setTargetAtTime(0, now, 0.010);
    slot.noiseGain.gain.cancelScheduledValues(now);
    slot.noiseGain.gain.setTargetAtTime(0, now, 0.009);
    slot.vibDepth.gain.cancelScheduledValues(now);
    slot.vibDepth.gain.setTargetAtTime(0, now, 0.010);
    slot.wasActive = false;
  }
}
