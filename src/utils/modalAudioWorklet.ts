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
import { useSoundStore } from '../store/soundStore';
import type { AeroSynthParams, SnapSynthParams } from './aeroAcoustics';
import type { ModalVoice } from './modalAudio';
import { resampleIrToContextRate } from './solidAcoustics3D';
import { solvePlayableWindVoice } from './windAcoustics';

const STUDIO_REVERB_WET_GAIN = 0.13;
const STUDIO_REVERB_DRY_ON = 0.90;
const STUDIO_REVERB_DRY_OFF = 0.95;

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
  bodyIr?: Float32Array<ArrayBuffer> | null;
  bodyIrSig?: string;
}

export interface WorkletStrikePayload {
  type: 'STRIKE';
  level: number;
  tauC: number;
  brightness: number;
  isPluck?: boolean;
  voices: ModalVoice[];
}

export interface WorkletBowedVoicePayload {
  id: string;
  active: boolean;
  pitchHz: number;
  amplitude: number;
  harmonicWeights: number[];
  stringHarmonicWeights?: number[];
  bodyIr?: Float32Array<ArrayBuffer> | null;
  bodyIrSig?: string;
  bodyFormantHz: number;
  bodyFormantGainDb: number;
  bodyFormantQ: number;
  secondaryFormantHz: number;
  woodModeHz?: number;
  dipoleCancelHz?: number;
  dipoleCancelDb?: number;
  bridgeHillHz?: number;
  bridgeHillGainDb?: number;
  lowpassHz: number;
  rosinNoiseGain: number;
  rosinCenterHz: number;
}

interface NativeBowedVoiceSlot {
  id: string;
  wasActive: boolean;
  activeSinceTime: number;
  lastPitchHz: number;
  lastWaveSig: string;
  lastIrSig: string;
  osc: OscillatorNode;
  osc2: OscillatorNode;
  osc3: OscillatorNode;
  mixGain: GainNode;
  vibOsc: OscillatorNode;
  vibDepth: GainNode;
  jitterDepth1: GainNode;
  jitterDepth2: GainNode;
  bodyConvolver: ConvolverNode | null;
  wetBodyGain: GainNode;
  dryWireGain: GainNode;
  bowLowpass: BiquadFilterNode;
  voiceGain: GainNode;
  rosinFilter: BiquadFilterNode;
  rosinGain: GainNode;
}

interface NativeBowedBankState {
  slots: NativeBowedVoiceSlot[];
}

interface NativeWindVoiceSlot {
  id: string;
  wasActive: boolean;
  lastPitchHz: number;
  lastWaveSig: string;
  lastIrSig: string;
  osc: OscillatorNode;
  vibOsc: OscillatorNode;
  vibDepth: GainNode;
  squelchOsc: OscillatorNode;
  squelchDepth: GainNode;
  driveGain: GainNode;
  shaper: WaveShaperNode;
  bodyFormant: BiquadFilterNode;
  bellLowpass1: BiquadFilterNode;
  bellLowpass2: BiquadFilterNode;
  bodyConvolver: ConvolverNode | null;
  wetBodyIrGain: GainNode;
  dryBoreGain: GainNode;
  voiceGain: GainNode;
  noiseFilter: BiquadFilterNode;
  noiseGain: GainNode;
  puffDepth: GainNode;
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
  __physboxNativeWindV15?: LegacyWindGraphState;
  __physboxNativeWindV16?: LegacyWindGraphState;
  __physboxNativeWindV17?: LegacyWindGraphState & { slots?: { osc?: OscillatorNode; vibOsc?: OscillatorNode; squelchOsc?: OscillatorNode }[] };
  __physboxNativeWindV18?: NativeWindBankState;
  __physboxNativeBowedV1?: { slots: { voiceGain: GainNode; rosinGain?: GainNode; osc?: OscillatorNode }[] };
  __physboxNativeBowedV2?: { slots: { voiceGain: GainNode; rosinGain?: GainNode; osc?: OscillatorNode; osc2?: OscillatorNode; vibOsc?: OscillatorNode }[] };
  __physboxNativeBowedV3?: { slots: { voiceGain: GainNode; rosinGain?: GainNode; osc?: OscillatorNode; osc2?: OscillatorNode; osc3?: OscillatorNode; vibOsc?: OscillatorNode }[] };
  __physboxNativeBowedV4?: { slots: { voiceGain: GainNode; rosinGain?: GainNode; osc?: OscillatorNode; osc2?: OscillatorNode; osc3?: OscillatorNode; vibOsc?: OscillatorNode }[] };
  __physboxNativeBowedV5?: { slots: { voiceGain: GainNode; rosinGain?: GainNode; osc?: OscillatorNode; osc2?: OscillatorNode; osc3?: OscillatorNode; vibOsc?: OscillatorNode }[] };
  __physboxNativeBowedV6?: NativeBowedBankState;
  __physboxNativeBowedV7?: NativeBowedBankState;
  __physboxNativeAeroV1?: NativeAeroBankState;
};

interface NativeAeroVoiceSlot {
  id: string;
  wasActive: boolean;
  lastWaveSig: string;
  propOsc: OscillatorNode;
  propLowpass: BiquadFilterNode;
  tonalGain: GainNode;
  strouhalFilter: BiquadFilterNode;
  noiseGain: GainNode;
  amOsc: OscillatorNode;
  amDepth: GainNode;
  rustleShelf: BiquadFilterNode;
  rustleGain: GainNode;
}

interface NativeAeroBankState {
  slots: NativeAeroVoiceSlot[];
}

/**
 * Instantiates a fresh write-once `ConvolverNode` whose `AudioBuffer` is resampled to
 * `ctx.sampleRate` (e.g. 44.1 kHz on Windows WASAPI vs 48 kHz), preventing both
 * `NotSupportedError` (sample-rate mismatch) and `InvalidStateError` (re-setting `.buffer`).
 */
export function createResampledConvolver(
  ctx: AudioContext,
  ir48k: Float32Array,
  sourceSampleRate = 48000,
): ConvolverNode | null {
  if (typeof ctx.createConvolver !== 'function' || typeof ctx.createBuffer !== 'function') {
    return null;
  }
  try {
    const sr = ctx.sampleRate || 48000;
    const samples = resampleIrToContextRate(ir48k, sr, sourceSampleRate);
    const buf = ctx.createBuffer(1, samples.length, sr);
    buf.getChannelData(0).set(samples);
    const conv = ctx.createConvolver();
    conv.normalize = false;
    conv.buffer = buf;
    return conv;
  } catch {
    return null;
  }
}

function buildPuffGateCurve(): Float32Array<ArrayBuffer> {
  const N = 513;
  const curve = new Float32Array(new ArrayBuffer(N * 4));
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * 2 - 1;
    curve[i] = x > 0.30 ? Math.pow((x - 0.30) / 0.70, 1.35) : 0;
  }
  return curve;
}

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
    '__physboxNativeWindV15',
    '__physboxNativeWindV16',
    '__physboxNativeWindV17',
  ] as const) {
    const prev = c[oldKey];
    if (prev) {
      if ('slots' in prev && Array.isArray(prev.slots)) {
        for (const sl of prev.slots) {
          try { sl.osc?.stop(); } catch { /* ignore */ }
          try { sl.vibOsc?.stop(); } catch { /* ignore */ }
          try { sl.squelchOsc?.stop(); } catch { /* ignore */ }
        }
      }
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
  if (c.__physboxNativeWindV18) return c.__physboxNativeWindV18;
  if (typeof ctx.createOscillator !== 'function' || typeof ctx.createWaveShaper !== 'function') {
    return null;
  }

  const softSatCurve = buildSoftSatCurve();
  const puffGateCurve = buildPuffGateCurve();
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

  const reverbOn = useSoundStore.getState().reverbEnabled;
  const dryGain = ctx.createGain();
  dryGain.gain.setValueAtTime(reverbOn ? STUDIO_REVERB_DRY_ON : STUDIO_REVERB_DRY_OFF, now);
  const wetGain = ctx.createGain();
  wetGain.gain.setValueAtTime(reverbOn ? STUDIO_REVERB_WET_GAIN : 0, now);

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

    // Liquid / compliant formant-squelch modulator (cross-modulated by vibOsc for irregular bubbling!)
    const squelchOsc = ctx.createOscillator();
    squelchOsc.type = 'triangle';
    squelchOsc.frequency.setValueAtTime(12.0 + i * 1.3, now);
    const squelchFm = ctx.createGain();
    squelchFm.gain.setValueAtTime(3.8, now);
    vibOsc.connect(squelchFm);
    squelchFm.connect(squelchOsc.frequency);

    const squelchDepth = ctx.createGain();
    squelchDepth.gain.setValueAtTime(0, now);
    squelchOsc.connect(squelchDepth);

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

    // Synchronized per-cycle air-puff modulator (half-wave pulse rectifier on osc -> noiseGain.gain)
    const puffRectifier = ctx.createWaveShaper();
    puffRectifier.curve = puffGateCurve;
    const puffDepth = ctx.createGain();
    puffDepth.gain.setValueAtTime(0, now);
    osc.connect(puffRectifier);
    puffRectifier.connect(puffDepth);
    puffDepth.connect(noiseGain.gain);

    squelchDepth.connect(bodyFormant.frequency);
    squelchDepth.connect(bellLowpass1.frequency);

    osc.connect(driveGain);
    driveGain.connect(shaper);
    const dryBoreGain = ctx.createGain();
    dryBoreGain.gain.setValueAtTime(1.0, now);

    const wetBodyIrGain = ctx.createGain();
    wetBodyIrGain.gain.setValueAtTime(0, now);

    shaper.connect(bodyFormant);
    bodyFormant.connect(bellLowpass1);
    bellLowpass1.connect(bellLowpass2);
    bellLowpass2.connect(dryBoreGain);
    dryBoreGain.connect(voiceGain);
    wetBodyIrGain.connect(voiceGain);
    voiceGain.connect(masterGain);

    if (noiseSource) {
      noiseSource.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(masterGain);
    }

    osc.start(now);
    vibOsc.start(now);
    squelchOsc.start(now);

    slots.push({
      id: '',
      wasActive: false,
      lastPitchHz: 261.63,
      lastWaveSig: '',
      lastIrSig: '',
      osc,
      vibOsc,
      vibDepth,
      squelchOsc,
      squelchDepth,
      driveGain,
      shaper,
      bodyFormant,
      bellLowpass1,
      bellLowpass2,
      bodyConvolver: null,
      wetBodyIrGain,
      dryBoreGain,
      voiceGain,
      noiseFilter,
      noiseGain,
      puffDepth,
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
  c.__physboxNativeWindV18 = bank;
  return bank;
}

export function getOrInitModalWorklet(ctx: AudioContext): GainNode | null {
  return ensureNativeWindBank(ctx)?.masterGain ?? null;
}

/** Shared studio-chamber output bus (presence + 0.68 s room convolver + safety limiter) for ALL acoustic instruments. */
export function getSharedAcousticOutputBus(ctx: AudioContext): AudioNode {
  return ensureNativeWindBank(ctx)?.masterGain ?? ctx.destination;
}

/** Smoothly toggles the 0.68 s stereo studio-room convolver wet send on the master bus without touching 3D body FIRs. */
export function setStudioReverbEnabled(ctx: AudioContext | null, enabled: boolean): void {
  if (!ctx) return;
  const c = ctx as AudioContextWithWindGraph;
  const bank = c.__physboxNativeWindV18;
  if (!bank) return;
  const now = ctx.currentTime;
  bank.wetGain.gain.cancelScheduledValues(now);
  bank.wetGain.gain.setTargetAtTime(enabled ? STUDIO_REVERB_WET_GAIN : 0, now, 0.018);
  bank.dryGain.gain.cancelScheduledValues(now);
  bank.dryGain.gain.setTargetAtTime(enabled ? STUDIO_REVERB_DRY_ON : STUDIO_REVERB_DRY_OFF, now, 0.018);
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
      slot.puffDepth.gain.setTargetAtTime(0, now, 0.008);
      slot.vibDepth.gain.setTargetAtTime(0, now, 0.012);
      slot.squelchDepth.gain.setTargetAtTime(0, now, 0.012);
      slot.wasActive = false;
      continue;
    }

    // Update band-limited C++ PeriodicWave from TMM harmonic weights H_1..H_N whenever bore spectrum changes!
    const hw = solved.harmonicWeights;
    const coh = Math.max(0, Math.min(1, solved.phaseCoherence ?? 0));
    const waveSig = `${Math.round(coh * 20)}:${hw.length}:${hw.slice(0, 10).map((w) => Math.round(w * 25)).join(',')}`;
    const isFreshAttack = !slot.wasActive || isNewId;
    if ((isFreshAttack || slot.lastWaveSig !== waveSig) && typeof ctx.createPeriodicWave === 'function') {
      const nHarm = hw.length + 1;
      const real = new Float32Array(nHarm);
      const imag = new Float32Array(nHarm);
      for (let h = 0; h < hw.length; h++) {
        const amp = hw[h];
        const dispPhase = (h + 1) * 0.35;
        // Rosenberg asymmetric mucosal sawtooth-pulse phase (-1.12 + 0.085*(h+1)) avoids high crest-factor
        // normalization collapse while delivering steep, wet slap closures!
        const rosenPhase = -1.12 + (h + 1) * 0.085;
        real[h + 1] = amp * ((1 - coh) * Math.sin(dispPhase) + coh * Math.cos(rosenPhase));
        imag[h + 1] = amp * ((1 - coh) * Math.cos(dispPhase) + coh * Math.sin(rosenPhase));
      }
      slot.osc.setPeriodicWave(ctx.createPeriodicWave(real, imag, { disableNormalization: false }));
      slot.lastWaveSig = waveSig;
    }

    slot.lastPitchHz = solved.pitchHz;

    if (isFreshAttack) {
      slot.osc.frequency.cancelScheduledValues(now);
      slot.osc.frequency.setValueAtTime(solved.pitchHz, now);
      const warmStartHz = coh > 0.2 ? Math.max(260, solved.bellLowpassHz * 0.55) : Math.max(420, solved.pitchHz * 1.45);
      slot.bellLowpass1.frequency.cancelScheduledValues(now);
      slot.bellLowpass1.frequency.setValueAtTime(warmStartHz, now);
      slot.bellLowpass2.frequency.cancelScheduledValues(now);
      slot.bellLowpass2.frequency.setValueAtTime(warmStartHz * 1.35, now);
    } else {
      slot.osc.frequency.setTargetAtTime(solved.pitchHz, now, 0.008);
    }

    slot.driveGain.gain.setTargetAtTime(0.65 + 0.45 * solved.drive, now, 0.016);
    slot.bodyFormant.frequency.setTargetAtTime(solved.formantHz, now, 0.014);
    slot.bodyFormant.gain.setTargetAtTime(solved.formantGainDb, now, 0.014);
    slot.bodyFormant.Q.setTargetAtTime(solved.formantQ, now, 0.014);
    slot.bellLowpass1.frequency.setTargetAtTime(solved.bellLowpassHz, now, 0.016);
    slot.bellLowpass1.Q.setTargetAtTime(solved.bellQ, now, 0.016);
    slot.bellLowpass2.frequency.setTargetAtTime(solved.bellLowpassHz * 1.38, now, 0.018);

    slot.voiceGain.gain.setTargetAtTime(solved.amplitude, now, 0.011);
    const noiseCenterHz = coh > 0.2
      ? Math.max(480, Math.min(1800, solved.formantHz * (0.95 + 0.35 * (v.breachFactor ?? 0))))
      : Math.min(3200, solved.pitchHz * (2.3 + (v.breachFactor ?? 0) * 1.4));
    slot.noiseFilter.frequency.setTargetAtTime(noiseCenterHz, now, 0.016);
    slot.noiseFilter.Q.setTargetAtTime((coh > 0.2 ? 1.8 : 1.1) + (v.breachFactor ?? 0) * 0.8, now, 0.016);
    slot.puffDepth.gain.setTargetAtTime(solved.puffGateDepth ?? 0, now, 0.010);

    if (isFreshAttack && v.exciter === 'brass_lip' && coh <= 0.2) {
      slot.noiseGain.gain.cancelScheduledValues(now);
      slot.noiseGain.gain.setValueAtTime(Math.max(solved.noiseGain, solved.amplitude * 0.08), now);
      slot.noiseGain.gain.setTargetAtTime(solved.noiseGain, now + 0.014, 0.016);
    } else {
      slot.noiseGain.gain.setTargetAtTime(solved.noiseGain, now, 0.012);
    }

    const vibRate = solved.flutterHz ?? (5.0 + idx * 0.2);
    const vibFrac = solved.flutterFrac ?? (0.0024 * Math.min(1, solved.amplitude * 4));
    slot.vibOsc.frequency.setTargetAtTime(vibRate, now, 0.025);
    slot.vibDepth.gain.setTargetAtTime(solved.pitchHz * vibFrac, now, 0.025);

    slot.squelchOsc.frequency.setTargetAtTime(solved.squelchRateHz ?? 12.0, now, 0.025);
    slot.squelchDepth.gain.setTargetAtTime(solved.squelchSweepHz ?? 0, now, 0.020);

    // Hot-swap simulated 3D Vibro-Acoustic Impulse Response of the wind instrument's 3D wall/bell geometry!
    if (v.bodyIr && v.bodyIr.length > 0 && v.bodyIrSig && slot.lastIrSig !== v.bodyIrSig) {
      if (slot.bodyConvolver) {
        try { slot.bellLowpass2.disconnect(slot.bodyConvolver); } catch { /* ignore */ }
        try { slot.bodyConvolver.disconnect(); } catch { /* ignore */ }
      }
      const nextConv = createResampledConvolver(ctx, v.bodyIr);
      slot.bodyConvolver = nextConv;
      if (nextConv) {
        slot.bellLowpass2.connect(nextConv);
        nextConv.connect(slot.wetBodyIrGain);
        slot.lastIrSig = v.bodyIrSig;
      }
    }
    if (slot.bodyConvolver) {
      slot.dryBoreGain.gain.setTargetAtTime(0.82, now, 0.015);
      slot.wetBodyIrGain.gain.setTargetAtTime(0.55, now, 0.015);
    } else {
      slot.dryBoreGain.gain.setTargetAtTime(1.0, now, 0.015);
      slot.wetBodyIrGain.gain.setTargetAtTime(0, now, 0.015);
    }

    slot.wasActive = true;
  }

  for (let i = 0; i < bank.slots.length; i++) {
    if (!usedSlots.has(i)) {
      const slot = bank.slots[i];
      slot.voiceGain.gain.setTargetAtTime(0, now, 0.010);
      slot.noiseGain.gain.setTargetAtTime(0, now, 0.008);
      slot.puffDepth.gain.setTargetAtTime(0, now, 0.008);
      slot.vibDepth.gain.setTargetAtTime(0, now, 0.012);
      slot.squelchDepth.gain.setTargetAtTime(0, now, 0.012);
      slot.wasActive = false;
    }
  }
}

export function postWorkletWindSilence(ctx: AudioContext | null): void {
  if (!ctx) return;
  const c = ctx as AudioContextWithWindGraph;
  disconnectLegacyGraphs(c);
  const bank = c.__physboxNativeWindV18;
  if (!bank) return;
  const now = ctx.currentTime;
  for (const slot of bank.slots) {
    slot.voiceGain.gain.cancelScheduledValues(now);
    slot.voiceGain.gain.setTargetAtTime(0, now, 0.010);
    slot.noiseGain.gain.cancelScheduledValues(now);
    slot.noiseGain.gain.setTargetAtTime(0, now, 0.009);
    slot.puffDepth.gain.cancelScheduledValues(now);
    slot.puffDepth.gain.setTargetAtTime(0, now, 0.009);
    slot.vibDepth.gain.cancelScheduledValues(now);
    slot.vibDepth.gain.setTargetAtTime(0, now, 0.010);
    slot.squelchDepth.gain.cancelScheduledValues(now);
    slot.squelchDepth.gain.setTargetAtTime(0, now, 0.010);
    slot.wasActive = false;
  }
}

function ensureNativeBowedBank(ctx: AudioContext): NativeBowedBankState | null {
  const c = ctx as AudioContextWithWindGraph;
  for (const oldBowedKey of [
    '__physboxNativeBowedV1',
    '__physboxNativeBowedV2',
    '__physboxNativeBowedV3',
    '__physboxNativeBowedV4',
    '__physboxNativeBowedV5',
    '__physboxNativeBowedV6',
  ] as const) {
    const prevBowed = c[oldBowedKey];
    if (prevBowed) {
      for (const oldSlot of prevBowed.slots) {
        try { oldSlot.voiceGain.disconnect(); } catch { /* ignore */ }
        try { oldSlot.rosinGain?.disconnect(); } catch { /* ignore */ }
        try { (oldSlot as { bodyConvolver?: ConvolverNode | null }).bodyConvolver?.disconnect(); } catch { /* ignore */ }
        try { oldSlot.osc?.stop(); } catch { /* ignore */ }
        try { (oldSlot as { osc2?: OscillatorNode }).osc2?.stop(); } catch { /* ignore */ }
        try { (oldSlot as { osc3?: OscillatorNode }).osc3?.stop(); } catch { /* ignore */ }
        try { (oldSlot as { vibOsc?: OscillatorNode }).vibOsc?.stop(); } catch { /* ignore */ }
      }
      delete c[oldBowedKey];
    }
  }
  if (c.__physboxNativeBowedV7) return c.__physboxNativeBowedV7;
  const windBank = ensureNativeWindBank(ctx);
  if (!windBank) return null;

  const sharedBus = getSharedAcousticOutputBus(ctx);
  const now = ctx.currentTime;
  const slots: NativeBowedVoiceSlot[] = [];

  for (let i = 0; i < 4; i++) {
    // 3-Ribbon Helmholtz stick-slip string source (pure linear string motion — ZERO hardcoded body biquads!)
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(98.0, now);

    const osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.setValueAtTime(98.0, now);
    osc2.detune.setValueAtTime(-3.6, now);

    const osc3 = ctx.createOscillator();
    osc3.type = 'sawtooth';
    osc3.frequency.setValueAtTime(98.0, now);
    osc3.detune.setValueAtTime(4.1, now);

    const g1 = ctx.createGain();
    g1.gain.setValueAtTime(0.68, now);
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.28, now);
    const g3 = ctx.createGain();
    g3.gain.setValueAtTime(0.26, now);

    const mixGain = ctx.createGain();
    mixGain.gain.setValueAtTime(0.88, now);

    // Expressive left-hand vibrato (~5.15 Hz)
    const vibOsc = ctx.createOscillator();
    vibOsc.type = 'sine';
    vibOsc.frequency.setValueAtTime(5.12 + i * 0.13, now);

    const vibDepth = ctx.createGain();
    vibDepth.gain.setValueAtTime(0, now);
    vibOsc.connect(vibDepth);
    vibDepth.connect(osc.frequency);
    vibDepth.connect(osc2.frequency);
    vibDepth.connect(osc3.frequency);

    // Schumacher stochastic rosin stick-slip flyback jitter (~15-36 Hz band-limited noise -> ±4.5 cents)
    const jitterLp1 = ctx.createBiquadFilter();
    jitterLp1.type = 'lowpass';
    jitterLp1.frequency.setValueAtTime(30 + i * 4, now);
    jitterLp1.Q.setValueAtTime(0.85, now);
    const jitterDepth1 = ctx.createGain();
    jitterDepth1.gain.setValueAtTime(4.2, now);

    const jitterLp2 = ctx.createBiquadFilter();
    jitterLp2.type = 'bandpass';
    jitterLp2.frequency.setValueAtTime(21 + i * 3, now);
    jitterLp2.Q.setValueAtTime(1.1, now);
    const jitterDepth2 = ctx.createGain();
    jitterDepth2.gain.setValueAtTime(5.8, now);

    if (windBank.noiseSource) {
      windBank.noiseSource.connect(jitterLp1);
      jitterLp1.connect(jitterDepth1);
      jitterDepth1.connect(osc.detune);

      windBank.noiseSource.connect(jitterLp2);
      jitterLp2.connect(jitterDepth2);
      jitterDepth2.connect(osc2.detune);
    }

    const wetBodyGain = ctx.createGain();
    wetBodyGain.gain.setValueAtTime(0, now);

    const dryWireGain = ctx.createGain();
    dryWireGain.gain.setValueAtTime(1.0, now);

    // Smooth Bessel viscoelastic string/radiation rolloff (Q = 0.52, zero resonant filter peak!)
    const bowLowpass = ctx.createBiquadFilter();
    bowLowpass.type = 'lowpass';
    bowLowpass.frequency.setValueAtTime(2600, now);
    bowLowpass.Q.setValueAtTime(0.52, now);

    const voiceGain = ctx.createGain();
    voiceGain.gain.setValueAtTime(0, now);

    const rosinFilter = ctx.createBiquadFilter();
    rosinFilter.type = 'bandpass';
    rosinFilter.frequency.setValueAtTime(2000, now);
    rosinFilter.Q.setValueAtTime(1.3, now);

    const rosinGain = ctx.createGain();
    rosinGain.gain.setValueAtTime(0, now);

    osc.connect(g1);
    osc2.connect(g2);
    osc3.connect(g3);
    g1.connect(mixGain);
    g2.connect(mixGain);
    g3.connect(mixGain);

    mixGain.connect(dryWireGain);
    dryWireGain.connect(bowLowpass);
    wetBodyGain.connect(bowLowpass);

    bowLowpass.connect(voiceGain);
    voiceGain.connect(sharedBus);

    if (windBank.noiseSource) {
      windBank.noiseSource.connect(rosinFilter);
      rosinFilter.connect(rosinGain);
      rosinGain.connect(bowLowpass);
    }

    osc.start(now);
    osc2.start(now);
    osc3.start(now);
    vibOsc.start(now);

    slots.push({
      id: '',
      wasActive: false,
      activeSinceTime: 0,
      lastPitchHz: 98.0,
      lastWaveSig: '',
      lastIrSig: '',
      osc,
      osc2,
      osc3,
      mixGain,
      vibOsc,
      vibDepth,
      jitterDepth1,
      jitterDepth2,
      bodyConvolver: null,
      wetBodyGain,
      dryWireGain,
      bowLowpass,
      voiceGain,
      rosinFilter,
      rosinGain,
    });
  }

  const bowedBank: NativeBowedBankState = { slots };
  c.__physboxNativeBowedV7 = bowedBank;
  return bowedBank;
}

export function postWorkletBowedUpdate(ctx: AudioContext, voices: WorkletBowedVoicePayload[]): void {
  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => {});
  }
  const bank = ensureNativeBowedBank(ctx);
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

    if (!v.active || v.amplitude <= 0.001) {
      // Singing 115 ms open-string sympathetic ring connects legato crossings warmly without muddying 16th notes!
      slot.voiceGain.gain.setTargetAtTime(0, now, 0.115);
      slot.rosinGain.gain.setTargetAtTime(0, now, 0.015);
      slot.vibDepth.gain.setTargetAtTime(0, now, 0.040);
      slot.wasActive = false;
      continue;
    }

    // Instantiate a fresh resampled ConvolverNode whenever the 3D body/bridge IR signature changes!
    const wantIr = !!(v.bodyIr && v.bodyIr.length > 0 && v.bodyIrSig);
    if (wantIr && v.bodyIr && v.bodyIrSig && slot.lastIrSig !== v.bodyIrSig) {
      if (slot.bodyConvolver) {
        try { slot.mixGain.disconnect(slot.bodyConvolver); } catch { /* ignore */ }
        try { slot.rosinGain.disconnect(slot.bodyConvolver); } catch { /* ignore */ }
        try { slot.bodyConvolver.disconnect(); } catch { /* ignore */ }
      }
      const nextConv = createResampledConvolver(ctx, v.bodyIr);
      slot.bodyConvolver = nextConv;
      if (nextConv) {
        slot.mixGain.connect(nextConv);
        slot.rosinGain.connect(nextConv);
        nextConv.connect(slot.wetBodyGain);
        slot.lastIrSig = v.bodyIrSig;
      }
    }

    const hasIr = !!(wantIr && slot.bodyConvolver);
    if (hasIr) {
      slot.wetBodyGain.gain.setTargetAtTime(2.35, now, 0.015);
      slot.dryWireGain.gain.setTargetAtTime(0.24, now, 0.015);
    } else {
      // Unbridged / floating wire in space: zero body convolution!
      slot.wetBodyGain.gain.setTargetAtTime(0, now, 0.015);
      slot.dryWireGain.gain.setTargetAtTime(0.88, now, 0.015);
    }

    // Feed pure Helmholtz/Cremer string harmonics into the 3D Body Convolver (avoiding double body filtering!)
    const hw = hasIr && v.stringHarmonicWeights?.length ? v.stringHarmonicWeights : v.harmonicWeights;
    const waveSig = `${hasIr ? 'ir' : 'dry'}:${hw.length}:${hw.slice(0, 24).map((w) => Math.round(w * 40)).join(',')}`;
    const isFreshAttack = !slot.wasActive || isNewId;

    if ((isFreshAttack || slot.lastWaveSig !== waveSig) && typeof ctx.createPeriodicWave === 'function') {
      const nHarm = hw.length + 1;
      const real = new Float32Array(nHarm);
      const imag = new Float32Array(nHarm);
      const real2 = new Float32Array(nHarm);
      const imag2 = new Float32Array(nHarm);
      const real3 = new Float32Array(nHarm);
      const imag3 = new Float32Array(nHarm);
      for (let h = 0; h < hw.length; h++) {
        const n = h + 1;
        const amp = hw[h];
        const sign = n % 2 === 1 ? 1 : -1;
        imag[n] = sign * amp;
        const phi2 = n * 0.19;
        real2[n] = sign * amp * Math.sin(phi2);
        imag2[n] = sign * amp * Math.cos(phi2);
        const phi3 = -n * 0.27;
        real3[n] = sign * amp * Math.sin(phi3);
        imag3[n] = sign * amp * Math.cos(phi3);
      }
      slot.osc.setPeriodicWave(ctx.createPeriodicWave(real, imag, { disableNormalization: false }));
      slot.osc2.setPeriodicWave(ctx.createPeriodicWave(real2, imag2, { disableNormalization: false }));
      slot.osc3.setPeriodicWave(ctx.createPeriodicWave(real3, imag3, { disableNormalization: false }));
      slot.lastWaveSig = waveSig;
    }

    const prevPitchHz = slot.lastPitchHz;
    slot.lastPitchHz = v.pitchHz;
    const isPitchStep = !isFreshAttack && Math.abs(v.pitchHz - prevPitchHz) > prevPitchHz * 0.025;

    if (isFreshAttack) {
      slot.activeSinceTime = now;
      slot.osc.frequency.cancelScheduledValues(now);
      slot.osc.frequency.setValueAtTime(v.pitchHz, now);
      slot.osc2.frequency.cancelScheduledValues(now);
      slot.osc2.frequency.setValueAtTime(v.pitchHz, now);
      slot.osc3.frequency.cancelScheduledValues(now);
      slot.osc3.frequency.setValueAtTime(v.pitchHz, now);
      slot.bowLowpass.frequency.setValueAtTime(v.lowpassHz, now);
    } else {
      if (isPitchStep) slot.activeSinceTime = now;
      const pitchTau = isPitchStep ? 0.0055 : 0.010;
      slot.osc.frequency.setTargetAtTime(v.pitchHz, now, pitchTau);
      slot.osc2.frequency.setTargetAtTime(v.pitchHz, now, pitchTau);
      slot.osc3.frequency.setTargetAtTime(v.pitchHz, now, pitchTau);
      slot.bowLowpass.frequency.setTargetAtTime(v.lowpassHz, now, 0.022);
    }

    const sustainedSec = now - slot.activeSinceTime;
    const vibBloom = sustainedSec >= 0.05 ? Math.min(1, (sustainedSec - 0.05) / 0.18) : 0;
    slot.vibOsc.frequency.setTargetAtTime(5.18 + idx * 0.11, now, 0.030);
    slot.vibDepth.gain.setTargetAtTime(v.pitchHz * 0.0052 * vibBloom, now, 0.035);

    // Smooth 24 ms bow-attack bloom eliminates square-gate clicks while keeping sixteenth-note rhythm crisp!
    const gainTau = isFreshAttack ? 0.024 : 0.016;
    slot.voiceGain.gain.setTargetAtTime(v.amplitude, now, gainTau);
    slot.rosinFilter.frequency.setTargetAtTime(v.rosinCenterHz, now, 0.018);
    const attackChiff = isFreshAttack ? 1.25 : 1.0;
    slot.rosinGain.gain.setTargetAtTime(v.rosinNoiseGain * 0.60 * attackChiff, now, 0.016);

    slot.wasActive = true;
  }

  for (let i = 0; i < bank.slots.length; i++) {
    if (!usedSlots.has(i)) {
      const slot = bank.slots[i];
      if (slot.wasActive) {
        slot.voiceGain.gain.setTargetAtTime(0, now, 0.115);
        slot.rosinGain.gain.setTargetAtTime(0, now, 0.015);
        slot.vibDepth.gain.setTargetAtTime(0, now, 0.040);
        slot.wasActive = false;
      }
    }
  }
}

export function postWorkletBowedSilence(ctx: AudioContext | null): void {
  if (!ctx) return;
  const c = ctx as AudioContextWithWindGraph;
  const bank = c.__physboxNativeBowedV7;
  if (!bank) return;
  const now = ctx.currentTime;
  for (const slot of bank.slots) {
    slot.voiceGain.gain.cancelScheduledValues(now);
    slot.voiceGain.gain.setTargetAtTime(0, now, 0.010);
    slot.rosinGain.gain.cancelScheduledValues(now);
    slot.rosinGain.gain.setTargetAtTime(0, now, 0.008);
    slot.vibDepth.gain.cancelScheduledValues(now);
    slot.vibDepth.gain.setTargetAtTime(0, now, 0.010);
    slot.wasActive = false;
  }
}

export function ensureNativeAeroBank(ctx: AudioContext): NativeAeroBankState | null {
  const c = ctx as AudioContextWithWindGraph;
  if (c.__physboxNativeAeroV1) return c.__physboxNativeAeroV1;
  const windBank = ensureNativeWindBank(ctx);
  if (!windBank) return null;

  const sharedBus = getSharedAcousticOutputBus(ctx);
  const now = ctx.currentTime;
  const slots: NativeAeroVoiceSlot[] = [];

  for (let i = 0; i < 8; i++) {
    // 1. Gutin Propeller / Rotor Tonal PeriodicWave Oscillator
    const propOsc = ctx.createOscillator();
    propOsc.type = 'sawtooth';
    propOsc.frequency.setValueAtTime(55.0 + i * 0.3, now);

    const propLowpass = ctx.createBiquadFilter();
    propLowpass.type = 'lowpass';
    propLowpass.frequency.setValueAtTime(2800, now);
    propLowpass.Q.setValueAtTime(0.65, now);

    const tonalGain = ctx.createGain();
    tonalGain.gain.setValueAtTime(0, now);

    propOsc.connect(propLowpass);
    propLowpass.connect(tonalGain);
    tonalGain.connect(sharedBus);

    // 2. Curle Strouhal Vortex-Shedding Bandpass + Raised-Cosine Blade-Pass / Flutter AM
    const strouhalFilter = ctx.createBiquadFilter();
    strouhalFilter.type = 'bandpass';
    strouhalFilter.frequency.setValueAtTime(600, now);
    strouhalFilter.Q.setValueAtTime(1.8, now);

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0, now);

    const amOsc = ctx.createOscillator();
    amOsc.type = 'sine';
    amOsc.frequency.setValueAtTime(4.0 + i * 0.17, now);

    const amDepth = ctx.createGain();
    amDepth.gain.setValueAtTime(0, now);
    amOsc.connect(amDepth);
    amDepth.connect(noiseGain.gain);

    // 3. Cloth / Sail Weave-Rubbing High-Shelf Rustle (2.2..5.5 kHz)
    const rustleShelf = ctx.createBiquadFilter();
    rustleShelf.type = 'highpass';
    rustleShelf.frequency.setValueAtTime(2800, now);
    rustleShelf.Q.setValueAtTime(0.8, now);

    const rustleGain = ctx.createGain();
    rustleGain.gain.setValueAtTime(0, now);

    if (windBank.noiseSource) {
      windBank.noiseSource.connect(strouhalFilter);
      strouhalFilter.connect(noiseGain);
      noiseGain.connect(sharedBus);

      windBank.noiseSource.connect(rustleShelf);
      rustleShelf.connect(rustleGain);
      rustleGain.connect(sharedBus);
    }

    propOsc.start(now);
    amOsc.start(now);

    slots.push({
      id: '',
      wasActive: false,
      lastWaveSig: '',
      propOsc,
      propLowpass,
      tonalGain,
      strouhalFilter,
      noiseGain,
      amOsc,
      amDepth,
      rustleShelf,
      rustleGain,
    });
  }

  const aeroBank: NativeAeroBankState = { slots };
  c.__physboxNativeAeroV1 = aeroBank;
  return aeroBank;
}

export function postWorkletAeroUpdate(ctx: AudioContext, voices: AeroSynthParams[]): void {
  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => {});
  }
  const bank = ensureNativeAeroBank(ctx);
  if (!bank) return;

  const now = ctx.currentTime;
  const usedSlots = new Set<number>();

  // Prioritize the 8 loudest / most active aero voices if a scene has > 8 rotors/wings
  const sorted = voices.length > 8
    ? [...voices].sort((a, b) => (b.tonalGain + b.noiseGain + b.rustleGain) - (a.tonalGain + a.noiseGain + a.rustleGain)).slice(0, 8)
    : voices;

  for (const v of sorted) {
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

    if (!v.active) {
      slot.tonalGain.gain.setTargetAtTime(0, now, 0.016);
      slot.noiseGain.gain.setTargetAtTime(0, now, 0.016);
      slot.amDepth.gain.setTargetAtTime(0, now, 0.016);
      slot.rustleGain.gain.setTargetAtTime(0, now, 0.016);
      slot.wasActive = false;
      continue;
    }

    const isFresh = !slot.wasActive || isNewId;

    // 1. Tonal Gutin Propeller Branch
    if (v.tonalActive && v.bpfHz >= 22 && v.harmonicWeights.length > 0) {
      const hw = v.harmonicWeights;
      const waveSig = `${hw.length}:${hw.map((w) => Math.round(w * 30)).join(',')}`;
      if ((isFresh || slot.lastWaveSig !== waveSig) && typeof ctx.createPeriodicWave === 'function') {
        const nHarm = hw.length + 1;
        const real = new Float32Array(nHarm);
        const imag = new Float32Array(nHarm);
        for (let h = 0; h < hw.length; h++) {
          const n = h + 1;
          // Dispersed Gutin dipole phase prevents unnatural buzzsaw peak-clipping
          const phase = -0.75 + n * 0.23;
          real[n] = hw[h] * Math.cos(phase);
          imag[n] = hw[h] * Math.sin(phase);
        }
        slot.propOsc.setPeriodicWave(ctx.createPeriodicWave(real, imag, { disableNormalization: false }));
        slot.lastWaveSig = waveSig;
      }

      const lpHz = Math.min(8500, Math.max(650, v.bpfHz * (5.5 + 8.0 * (1 - v.stallRoughness))));
      if (isFresh) {
        slot.propOsc.frequency.cancelScheduledValues(now);
        slot.propOsc.frequency.setValueAtTime(v.bpfHz, now);
        slot.propLowpass.frequency.setValueAtTime(lpHz, now);
      } else {
        slot.propOsc.frequency.setTargetAtTime(v.bpfHz, now, 0.018);
        slot.propLowpass.frequency.setTargetAtTime(lpHz, now, 0.022);
      }
      slot.tonalGain.gain.setTargetAtTime(v.tonalGain, now, 0.018);
    } else {
      slot.tonalGain.gain.setTargetAtTime(0, now, 0.014);
    }

    // 2. Broadband Strouhal Vortex-Shedding + Blade-Pass / Stall Flutter AM Branch
    if (isFresh) {
      slot.strouhalFilter.frequency.setValueAtTime(v.noiseCenterHz, now);
      slot.strouhalFilter.Q.setValueAtTime(v.noiseQ, now);
    } else {
      slot.strouhalFilter.frequency.setTargetAtTime(v.noiseCenterHz, now, 0.022);
      slot.strouhalFilter.Q.setTargetAtTime(v.noiseQ, now, 0.022);
    }
    slot.noiseGain.gain.setTargetAtTime(v.noiseGain, now, 0.018);

    if (v.amRateHz >= 0.4 && v.amDepth > 0.01 && v.noiseGain > 0.001) {
      slot.amOsc.frequency.setTargetAtTime(v.amRateHz, now, 0.025);
      // Modulate +/- (amDepth * 0.55 * noiseGain) around `noiseGain` so gain stays smoothly non-negative
      slot.amDepth.gain.setTargetAtTime(v.noiseGain * v.amDepth * 0.55, now, 0.020);
    } else {
      slot.amDepth.gain.setTargetAtTime(0, now, 0.016);
    }

    // 3. Cloth Weave-Rubbing High-Shelf Branch
    if (v.rustleGain > 0.001) {
      slot.rustleShelf.frequency.setTargetAtTime(v.rustleFreqHz, now, 0.022);
      slot.rustleGain.gain.setTargetAtTime(v.rustleGain, now, 0.018);
    } else {
      slot.rustleGain.gain.setTargetAtTime(0, now, 0.015);
    }

    slot.wasActive = true;
  }

  for (let i = 0; i < bank.slots.length; i++) {
    if (!usedSlots.has(i)) {
      const slot = bank.slots[i];
      if (slot.wasActive) {
        slot.tonalGain.gain.setTargetAtTime(0, now, 0.018);
        slot.noiseGain.gain.setTargetAtTime(0, now, 0.018);
        slot.amDepth.gain.setTargetAtTime(0, now, 0.016);
        slot.rustleGain.gain.setTargetAtTime(0, now, 0.016);
        slot.wasActive = false;
      }
    }
  }
}

export function postWorkletAeroSnap(ctx: AudioContext, snap: SnapSynthParams): void {
  if (!snap.active || snap.gain <= 0.002) return;
  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => {});
  }
  if (typeof ctx.createBuffer !== 'function' || typeof ctx.createBufferSource !== 'function') return;

  const sharedBus = getSharedAcousticOutputBus(ctx);
  const sr = ctx.sampleRate || 48000;
  const now = ctx.currentTime;
  const tau = snap.durationSec; // 0.7..2.6 ms asymmetric N-wave shock
  const totalDur = Math.max(0.018, tau * 12);
  const len = Math.max(64, Math.ceil(sr * totalDur));
  const buf = ctx.createBuffer(1, len, sr);
  const ch = buf.getChannelData(0);

  let seed = 0x51a7c0de;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    // Asymmetric Friedlander / N-wave shock pulse + decaying fabric whip tail
    let nWave: number;
    if (t < tau) {
      const u = t / tau;
      // Sharp shock rise followed by linear N-wave rarefaction sweep from +1 to -0.78
      const rise = u < 0.14 ? u / 0.14 : 1.0 - 1.78 * ((u - 0.14) / 0.86);
      nWave = rise;
    } else {
      const dt = (t - tau) / tau;
      nWave = -0.45 * Math.exp(-dt * 1.45) * Math.cos(dt * 2.2);
    }
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    const white = seed / 2147483648;
    const tailEnv = Math.exp(-t / (tau * 2.8));
    ch[i] = nWave + 0.28 * white * tailEnv;
  }

  const src = ctx.createBufferSource();
  src.buffer = buf;

  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(snap.centerHz, now);
  bp.Q.setValueAtTime(snap.bandpassQ, now);

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(snap.lowpassHz, now);
  lp.Q.setValueAtTime(0.8, now);

  const outGain = ctx.createGain();
  outGain.gain.setValueAtTime(snap.gain, now);

  src.connect(bp);
  bp.connect(lp);
  lp.connect(outGain);
  outGain.connect(sharedBus);
  src.start(now);
  src.onended = () => {
    try { outGain.disconnect(); } catch { /* ignore */ }
  };
}

export function postWorkletAeroSilence(ctx: AudioContext | null): void {
  if (!ctx) return;
  const c = ctx as AudioContextWithWindGraph;
  const bank = c.__physboxNativeAeroV1;
  if (!bank) return;
  const now = ctx.currentTime;
  for (const slot of bank.slots) {
    slot.tonalGain.gain.cancelScheduledValues(now);
    slot.tonalGain.gain.setTargetAtTime(0, now, 0.010);
    slot.noiseGain.gain.cancelScheduledValues(now);
    slot.noiseGain.gain.setTargetAtTime(0, now, 0.010);
    slot.amDepth.gain.cancelScheduledValues(now);
    slot.amDepth.gain.setTargetAtTime(0, now, 0.010);
    slot.rustleGain.gain.cancelScheduledValues(now);
    slot.rustleGain.gain.setTargetAtTime(0, now, 0.010);
    slot.wasActive = false;
  }
}
