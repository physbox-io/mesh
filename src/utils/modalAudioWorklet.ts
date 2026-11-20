// ---------------------------------------------------------------------------
// Native C++ WebAudio Physical Bore, String, Aero & Tribological Synthesizer
// ---------------------------------------------------------------------------
//
// Driven directly by the 1D Conical Transfer-Matrix (TMM) input-impedance
// spectrum `Z_in(f)` of the 3D mesh (`solvePlayableWindVoice`), Helmholtz
// bowed strings, Gutin/Curle aeroacoustics, and continuous rolling/scraping/
// Stribeck/singing-rim contact friction:
//   - Band-limited C++ `PeriodicWave` harmonic synthesis weighted by actual
//     bore impedance & stub anti-resonances
//   - Nonlinear waveshaper + 24 dB/oct dual-stage bell radiation filter with
//     Risset attack-bloom / release-tuck & muted-bell formant Q
//   - 6-slot continuous tribological resonator bank (fractal roughness +
//     stick-slip / rim lock-in -> dual modal biquads + 3D body FIR)
//   - Per-slot `StereoPannerNode` + distance gain & 0.22 cross-fed 0.68 s
//     studio-room `ConvolverNode` presence
//
// Zero `ScriptProcessorNode`, zero main-thread JS sample loops, and strict
// NaN/Inf/Nyquist/sample-rate DSP guards across 8 kHz..96 kHz AudioContexts!
// ---------------------------------------------------------------------------

import type { WindExciterKind } from '../types/scene';
import { useSoundStore } from '../store/soundStore';
import type { AeroSynthParams, SnapSynthParams } from './aeroAcoustics';
import type { WorkletFrictionVoicePayload } from './contactFrictionAcoustics';
import type { ModalVoice } from './modalAudio';
import { resampleIrToContextRate } from './solidAcoustics3D';
import { createSpatialSend, type SpatialAcousticParams } from './spatialAcoustics';
import { solvePlayableWindVoice } from './windAcoustics';

const STUDIO_REVERB_WET_GAIN = 0.13;
const STUDIO_REVERB_DRY_ON = 0.90;
const STUDIO_REVERB_DRY_OFF = 0.95;
const STUDIO_REVERB_CROSSFEED = 0.22;

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
  pan?: number;
  distanceGain?: number;
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
  pan?: number;
  distanceGain?: number;
}

export type SpatialAeroSynthParams = AeroSynthParams & {
  pan?: number;
  distanceGain?: number;
};

export type SpatialSnapSynthParams = SnapSynthParams & {
  pan?: number;
  distanceGain?: number;
};

interface SlotSpatialStage {
  input: GainNode;
  panner: StereoPannerNode | null;
  apply: (pan: number | undefined, distanceGain: number | undefined, now: number, immediate: boolean) => void;
}

interface NativeBowedVoiceSlot {
  id: string;
  wasActive: boolean;
  activeSinceTime: number;
  releaseUntilTime: number;
  lastPitchHz: number;
  lastAmplitude: number;
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
  spatial: SlotSpatialStage;
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
  noiseLowpass: BiquadFilterNode;
  noiseFilter: BiquadFilterNode;
  noiseGain: GainNode;
  puffDepth: GainNode;
  spatial: SlotSpatialStage;
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
  spatial: SlotSpatialStage;
}

interface NativeAeroBankState {
  slots: NativeAeroVoiceSlot[];
}

interface NativeFrictionVoiceSlot {
  id: string;
  wasActive: boolean;
  lastIrSig: string;
  noiseBandpass: BiquadFilterNode;
  patchLowpass: BiquadFilterNode;
  noiseGain: GainNode;
  grainOsc: OscillatorNode;
  grainDepth: GainNode;
  tonalOsc1: OscillatorNode;
  tonalOsc2: OscillatorNode;
  tonalDriveGain: GainNode;
  tonalShaper: WaveShaperNode;
  tonalGain: GainNode;
  exciterMix: GainNode;
  modePeak1: BiquadFilterNode;
  modePeak2: BiquadFilterNode;
  dryModalGain: GainNode;
  bodyConvolver: ConvolverNode | null;
  wetIrGain: GainNode;
  voiceGain: GainNode;
  spatial: SlotSpatialStage;
}

interface NativeFrictionBankState {
  slots: NativeFrictionVoiceSlot[];
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
  __physboxNativeFrictionV1?: NativeFrictionBankState;
};

// ---------------------------------------------------------------------------
// DSP Safety Helpers (Finite / Nyquist / Sample-Rate / PeriodicWave / IR Cache)
// ---------------------------------------------------------------------------

function finiteOr(v: number | undefined | null, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function safeClamp(v: number | undefined | null, fallback: number, lo: number, hi: number): number {
  const x = finiteOr(v, fallback);
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Clamps any filter or oscillator frequency to `[minHz, 0.475 * ctx.sampleRate]`,
 * preventing WebAudio `RangeError`/`TypeError` or unstable Nyquist poles on
 * 8 kHz / 16 kHz / 24 kHz / 44.1 kHz / 48 kHz / 96 kHz AudioContexts.
 */
export function clampAudioFreq(
  ctx: { sampleRate?: number } | null | undefined,
  hz: number | undefined | null,
  fallback = 440,
  minHz = 15,
): number {
  const sr = ctx?.sampleRate && Number.isFinite(ctx.sampleRate) && ctx.sampleRate > 0
    ? ctx.sampleRate
    : 48000;
  const nyquistSafe = Math.max(minHz + 10, sr * 0.475);
  return safeClamp(hz, fallback, minHz, nyquistSafe);
}

/**
 * Sanitizes Fourier cosine/sine arrays for `ctx.createPeriodicWave`, replacing
 * non-finite bins with `0` and disabling normalization when all harmonic weights
 * are near zero (avoiding WebAudio `0 / 0` `NaN` wavetables).
 */
export function safePeriodicWave(
  ctx: AudioContext,
  real: Float32Array<ArrayBuffer>,
  imag: Float32Array<ArrayBuffer>,
): PeriodicWave | null {
  if (typeof ctx.createPeriodicWave !== 'function') return null;
  if (real.length < 2 || real.length !== imag.length) return null;
  real[0] = 0;
  imag[0] = 0;
  let maxMag = 0;
  for (let i = 1; i < real.length; i++) {
    const r = Number.isFinite(real[i]) ? real[i] : 0;
    const im = Number.isFinite(imag[i]) ? imag[i] : 0;
    real[i] = r;
    imag[i] = im;
    const mag = Math.hypot(r, im);
    if (mag > maxMag) maxMag = mag;
  }
  return ctx.createPeriodicWave(real, imag, { disableNormalization: maxMag < 1e-8 });
}

function createSlotSpatialStage(ctx: AudioContext, target: AudioNode): SlotSpatialStage {
  const now = finiteOr(ctx.currentTime, 0);
  const input = ctx.createGain();
  input.gain.setValueAtTime(1.0, now);
  let panner: StereoPannerNode | null = null;
  if (typeof ctx.createStereoPanner === 'function') {
    try {
      panner = ctx.createStereoPanner();
      panner.pan.setValueAtTime(0, now);
      input.connect(panner);
      panner.connect(target);
    } catch {
      panner = null;
      input.connect(target);
    }
  } else {
    input.connect(target);
  }

  return {
    input,
    panner,
    apply: (pan, distanceGain, t, immediate) => {
      const g = safeClamp(distanceGain, 1.0, 0.12, 1.6);
      const p = safeClamp(pan, 0, -1, 1);
      if (immediate) {
        input.gain.cancelScheduledValues(t);
        input.gain.setValueAtTime(g, t);
        if (panner) {
          panner.pan.cancelScheduledValues(t);
          panner.pan.setValueAtTime(p, t);
        }
      } else {
        input.gain.setTargetAtTime(g, t, 0.020);
        if (panner) {
          panner.pan.setTargetAtTime(p, t, 0.020);
        }
      }
    },
  };
}

/**
 * WeakMap cache of sanitized, rate-matched `AudioBuffer`s per source `Float32Array`
 * and `(targetSampleRate, sourceSampleRate)` so polyphonic mallet strikes and voice
 * slot switches never allocate duplicate resampled buffers.
 */
const resampledIrBufferCache = new WeakMap<Float32Array, Map<string, AudioBuffer | null>>();

/**
 * Instantiates a fresh write-once `ConvolverNode` whose `AudioBuffer` is resampled to
 * `ctx.sampleRate`, gain-scaled for discrete convolution invariance (`sourceRate / targetRate`),
 * and strictly sanitized against `NaN` / `Infinity` so a bad IR sample can NEVER poison
 * the shared Studio Chamber output bus!
 */
export function createResampledConvolver(
  ctx: AudioContext,
  ir48k: Float32Array,
  sourceSampleRate = 48000,
): ConvolverNode | null {
  if (
    !ir48k ||
    ir48k.length === 0 ||
    !(sourceSampleRate > 0) ||
    !Number.isFinite(sourceSampleRate) ||
    typeof ctx.createConvolver !== 'function' ||
    typeof ctx.createBuffer !== 'function'
  ) {
    return null;
  }
  try {
    const sr = ctx.sampleRate && Number.isFinite(ctx.sampleRate) && ctx.sampleRate > 0 ? ctx.sampleRate : 48000;
    const rateKey = `${Math.round(sr)}:${Math.round(sourceSampleRate)}`;
    let byRate = resampledIrBufferCache.get(ir48k);
    let cachedBuf = byRate?.get(rateKey);

    if (cachedBuf === undefined) {
      // Sanitize a working copy if `ir48k` contains any non-finite samples before interpolation
      let cleanInput = ir48k;
      let inSq = 0;
      let inCount = 0;
      let hadBadInput = false;
      for (let i = 0; i < ir48k.length; i++) {
        const v = ir48k[i];
        if (!Number.isFinite(v)) {
          hadBadInput = true;
        } else {
          inSq += v * v;
          inCount++;
        }
      }
      if (inCount === 0 || inSq < 1e-20) {
        if (!byRate) {
          byRate = new Map();
          resampledIrBufferCache.set(ir48k, byRate);
        }
        byRate.set(rateKey, null);
        return null;
      }
      if (hadBadInput) {
        const sanitized = new Float32Array(ir48k.length);
        for (let i = 0; i < ir48k.length; i++) {
          sanitized[i] = Number.isFinite(ir48k[i]) ? ir48k[i] : 0;
        }
        cleanInput = sanitized;
      }

      const rawSamples = resampleIrToContextRate(cleanInput, sr, sourceSampleRate);
      const safeSamples = new Float32Array(rawSamples.length);
      let outSq = 0;
      let maxAbs = 0;
      for (let i = 0; i < rawSamples.length; i++) {
        const s = Number.isFinite(rawSamples[i]) ? rawSamples[i] : 0;
        safeSamples[i] = s;
        outSq += s * s;
        const a = Math.abs(s);
        if (a > maxAbs) maxAbs = a;
      }

      if (maxAbs < 1e-8) {
        cachedBuf = null;
      } else {
        // Idempotent discrete-time convolution tap scaling:
        // Continuous-time integral y(t) = sum_k x[n-k] h[k] requires h_sr[k] = (sourceRate / sr) * h_src(k / sr)
        // so doubling sampleRate (96 kHz) doesn't double (+6 dB) convolution output amplitude!
        // Check RMS ratio so if `resampleIrToContextRate` already applied `sourceRate / sr`, we don't double-scale.
        let tapScale = 1.0;
        if (Math.abs(sr - sourceSampleRate) >= 1 && rawSamples.length > 0) {
          const inRms = Math.sqrt(inSq / ir48k.length);
          const outRms = Math.sqrt(outSq / rawSamples.length);
          const targetRatio = sourceSampleRate / sr;
          if (inRms > 1e-9 && outRms > 1e-9) {
            const actualRatio = outRms / inRms;
            if (Math.abs(actualRatio - 1.0) < Math.abs(actualRatio - targetRatio)) {
              tapScale = targetRatio;
            }
          }
        }

        const peakAfterScale = maxAbs * tapScale;
        const safetyCeil = peakAfterScale > 1.0 ? 1.0 / peakAfterScale : 1.0;
        const finalGain = tapScale * safetyCeil;
        if (Math.abs(finalGain - 1.0) > 1e-6 || maxAbs > 1.0) {
          for (let i = 0; i < safeSamples.length; i++) {
            safeSamples[i] = safeClamp(safeSamples[i] * finalGain, 0, -1, 1);
          }
        }

        const buf = ctx.createBuffer(1, safeSamples.length, sr);
        buf.getChannelData(0).set(safeSamples);
        cachedBuf = buf;
      }

      if (!byRate) {
        byRate = new Map();
        resampledIrBufferCache.set(ir48k, byRate);
      }
      byRate.set(rateKey, cachedBuf);
    }

    if (!cachedBuf) return null;
    const conv = ctx.createConvolver();
    conv.normalize = false;
    conv.buffer = cachedBuf;
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

/**
 * Synthesizes a tight, natural 0.68 s stereo studio-room impulse response
 * with sample-rate-invariant one-pole damping and tap scaling across 16..96 kHz.
 */
function buildStudioChamberIR(ctx: AudioContext): AudioBuffer {
  const sr = ctx.sampleRate && Number.isFinite(ctx.sampleRate) && ctx.sampleRate > 0 ? ctx.sampleRate : 48000;
  const dur = 0.68;
  const len = Math.max(64, Math.floor(sr * dur));
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
  // Early discrete reflections carry sample-rate-independent impulse weight;
  // continuous diffuse tail scales by sqrt(48000 / sr) / (sr / 48000) -> 48000 / sr for constant convolved RMS
  const rateRatio = 48000 / sr;
  const tailScale = 0.22 * Math.sqrt(rateRatio);
  const hpAlpha = 1 - Math.pow(1 - 0.018, rateRatio);

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
    const damp48 = 0.34 * Math.exp(-t * 1.8) + 0.08;
    const damp = 1 - Math.pow(Math.max(1e-4, 1 - damp48), rateRatio);
    lpL += damp * (wL - lpL);
    lpR += damp * (wR - lpR);
    hpL += hpAlpha * (lpL - hpL);
    hpR += hpAlpha * (lpR - hpR);
    left[i] += (lpL - hpL) * env * tailScale;
    right[i] += (lpR - hpR) * env * tailScale;
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
  const now = finiteOr(ctx.currentTime, 0);

  const masterGain = ctx.createGain();
  masterGain.gain.setValueAtTime(0.95, now);

  const presenceShelf = ctx.createBiquadFilter();
  presenceShelf.type = 'peaking';
  presenceShelf.frequency.setValueAtTime(clampAudioFreq(ctx, 1850), now);
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
    // 0.22 stereo cross-feed into studio room convolver (normalized by 1 / 1.22 so centered mono is unity!)
    // ensures hard-panned sources excite natural cross-ear room reflections while dryGain stays crisp stereo.
    if (
      typeof ctx.createChannelSplitter === 'function' &&
      typeof ctx.createChannelMerger === 'function'
    ) {
      try {
        const normMain = 1 / (1 + STUDIO_REVERB_CROSSFEED);
        const normCross = STUDIO_REVERB_CROSSFEED / (1 + STUDIO_REVERB_CROSSFEED);
        const splitter = ctx.createChannelSplitter(2);
        const merger = ctx.createChannelMerger(2);
        const gLL = ctx.createGain();
        const gRR = ctx.createGain();
        const gLR = ctx.createGain();
        const gRL = ctx.createGain();
        gLL.gain.setValueAtTime(normMain, now);
        gRR.gain.setValueAtTime(normMain, now);
        gLR.gain.setValueAtTime(normCross, now);
        gRL.gain.setValueAtTime(normCross, now);
        presenceShelf.connect(splitter);
        splitter.connect(gLL, 0);
        splitter.connect(gLR, 0);
        splitter.connect(gRR, 1);
        splitter.connect(gRL, 1);
        gLL.connect(merger, 0, 0);
        gRL.connect(merger, 0, 0);
        gRR.connect(merger, 0, 1);
        gLR.connect(merger, 0, 1);
        merger.connect(convolver);
      } catch {
        presenceShelf.connect(convolver);
      }
    } else {
      presenceShelf.connect(convolver);
    }
    convolver.connect(wetGain);
    wetGain.connect(outputTarget);
  }

  // Flat, zero-mean broadband white noise source so bowed rosin, cloth rustle (2.2..5.5 kHz),
  // and surface-roughness friction filters receive full-bandwidth sample-rate-invariant spectrum!
  let noiseSource: AudioBufferSourceNode | null = null;
  if (typeof ctx.createBuffer === 'function' && typeof ctx.createBufferSource === 'function') {
    const sr = ctx.sampleRate && Number.isFinite(ctx.sampleRate) && ctx.sampleRate > 0 ? ctx.sampleRate : 48000;
    const len = Math.max(256, Math.floor(sr * 2.5));
    const noiseBuf = ctx.createBuffer(1, len, sr);
    const ch = noiseBuf.getChannelData(0);
    let seed = 0x13579bdf;
    let mean = 0;
    for (let i = 0; i < len; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      const white = (seed / 2147483648) * 0.58;
      ch[i] = white;
      mean += white;
    }
    mean /= len;
    for (let i = 0; i < len; i++) {
      ch[i] -= mean;
    }
    noiseSource = ctx.createBufferSource();
    noiseSource.buffer = noiseBuf;
    noiseSource.loop = true;
    noiseSource.start(now);
  }

  const slots: NativeWindVoiceSlot[] = [];
  for (let i = 0; i < 6; i++) {
    const spatial = createSlotSpatialStage(ctx, masterGain);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(clampAudioFreq(ctx, 261.63), now);

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
    squelchFm.gain.setValueAtTime(3.2, now);
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
    bodyFormant.frequency.setValueAtTime(clampAudioFreq(ctx, 850), now);
    bodyFormant.Q.setValueAtTime(1.2, now);
    bodyFormant.gain.setValueAtTime(4.0, now);

    const bellLowpass1 = ctx.createBiquadFilter();
    bellLowpass1.type = 'lowpass';
    bellLowpass1.frequency.setValueAtTime(clampAudioFreq(ctx, 1200), now);
    bellLowpass1.Q.setValueAtTime(0.95, now);

    const bellLowpass2 = ctx.createBiquadFilter();
    bellLowpass2.type = 'lowpass';
    bellLowpass2.frequency.setValueAtTime(clampAudioFreq(ctx, 1600), now);
    bellLowpass2.Q.setValueAtTime(0.707, now);

    const voiceGain = ctx.createGain();
    voiceGain.gain.setValueAtTime(0, now);

    // Dedicated sample-rate-invariant warm breath rolloff (~2.6 kHz) for wind air-leak noise
    const noiseLowpass = ctx.createBiquadFilter();
    noiseLowpass.type = 'lowpass';
    noiseLowpass.frequency.setValueAtTime(clampAudioFreq(ctx, 2600), now);
    noiseLowpass.Q.setValueAtTime(0.707, now);

    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.setValueAtTime(clampAudioFreq(ctx, 1100), now);
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
    voiceGain.connect(spatial.input);

    if (noiseSource) {
      noiseSource.connect(noiseLowpass);
      noiseLowpass.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(spatial.input);
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
      noiseLowpass,
      noiseFilter,
      noiseGain,
      puffDepth,
      spatial,
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
  const now = finiteOr(ctx.currentTime, 0);
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

  const now = finiteOr(ctx.currentTime, 0);
  const usedSlots = new Set<number>();

  // Solve & filter ONLY active wind voices first so idle pipes (breathKPa = 0) never starve active ones!
  const activeEntries = voices
    .map((v) => ({
      v,
      solved: solvePlayableWindVoice(
        v,
        safeClamp(v.breathKPa, 0, 0, 25),
        safeClamp(v.embouchureHz, 220, 15, 4500),
      ),
    }))
    .filter((item) => item.solved.active && finiteOr(item.solved.amplitude, 0) > 0.0005)
    .sort((a, b) => finiteOr(b.solved.amplitude, 0) - finiteOr(a.solved.amplitude, 0))
    .slice(0, bank.slots.length);

  for (const { v, solved } of activeEntries) {
    let idx = bank.slots.findIndex((s, i) => !usedSlots.has(i) && s.id === v.id);
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

    // Update band-limited C++ PeriodicWave from TMM harmonic weights H_1..H_N whenever bore spectrum changes!
    const hw = Array.isArray(solved.harmonicWeights) ? solved.harmonicWeights : [];
    const coh = safeClamp(solved.phaseCoherence, 0, 0, 1);
    const waveSig = `${Math.round(coh * 20)}:${hw.length}:${hw.slice(0, 10).map((w) => Math.round(finiteOr(w, 0) * 25)).join(',')}`;
    const isFreshAttack = !slot.wasActive || isNewId;
    if ((isFreshAttack || slot.lastWaveSig !== waveSig) && hw.length > 0) {
      const nHarm = hw.length + 1;
      const real = new Float32Array(new ArrayBuffer(nHarm * 4));
      const imag = new Float32Array(new ArrayBuffer(nHarm * 4));
      for (let h = 0; h < hw.length; h++) {
        const amp = safeClamp(hw[h], 0, -4, 4);
        const dispPhase = (h + 1) * 0.35;
        const rosenPhase = -1.12 + (h + 1) * 0.085;
        real[h + 1] = amp * ((1 - coh) * Math.sin(dispPhase) + coh * Math.cos(rosenPhase));
        imag[h + 1] = amp * ((1 - coh) * Math.cos(dispPhase) + coh * Math.sin(rosenPhase));
      }
      const wave = safePeriodicWave(ctx, real, imag);
      if (wave) {
        slot.osc.setPeriodicWave(wave);
        slot.lastWaveSig = waveSig;
      }
    }

    const pitchHz = clampAudioFreq(ctx, solved.pitchHz, 261.63, 18);
    const formantHz = clampAudioFreq(ctx, solved.formantHz, 850, 60);
    const bellLp1Hz = clampAudioFreq(ctx, solved.bellLowpassHz, 1200, 80);
    const bellLp2Hz = clampAudioFreq(ctx, bellLp1Hz * 1.38, 1650, 100);
    slot.lastPitchHz = pitchHz;

    if (isFreshAttack) {
      slot.osc.frequency.cancelScheduledValues(now);
      slot.osc.frequency.setValueAtTime(pitchHz, now);
      const warmStartHz = clampAudioFreq(
        ctx,
        coh > 0.2 ? Math.max(260, bellLp1Hz * 0.55) : Math.max(420, pitchHz * 1.45),
        420,
        80,
      );
      slot.bellLowpass1.frequency.cancelScheduledValues(now);
      slot.bellLowpass1.frequency.setValueAtTime(warmStartHz, now);
      slot.bellLowpass2.frequency.cancelScheduledValues(now);
      slot.bellLowpass2.frequency.setValueAtTime(clampAudioFreq(ctx, warmStartHz * 1.35, 580, 100), now);
    } else {
      slot.osc.frequency.setTargetAtTime(pitchHz, now, 0.008);
    }

    slot.driveGain.gain.setTargetAtTime(0.65 + 0.45 * safeClamp(solved.drive, 0.5, 0, 2.5), now, 0.016);
    slot.bodyFormant.frequency.setTargetAtTime(formantHz, now, 0.014);
    slot.bodyFormant.gain.setTargetAtTime(safeClamp(solved.formantGainDb, 4.0, -24, 24), now, 0.014);
    slot.bodyFormant.Q.setTargetAtTime(safeClamp(solved.formantQ, 1.2, 0.15, 24), now, 0.014);
    slot.bellLowpass1.frequency.setTargetAtTime(bellLp1Hz, now, 0.016);
    slot.bellLowpass1.Q.setTargetAtTime(safeClamp(solved.bellQ, 0.95, 0.15, 18), now, 0.016);
    slot.bellLowpass2.frequency.setTargetAtTime(bellLp2Hz, now, 0.018);

    const amp = safeClamp(solved.amplitude, 0, 0, 1.5);
    slot.voiceGain.gain.setTargetAtTime(amp, now, 0.011);

    const breach = safeClamp(v.breachFactor, 0, 0, 1.5);
    const rawNoiseCenter = coh > 0.2
      ? Math.max(480, Math.min(1800, formantHz * (0.95 + 0.35 * breach)))
      : Math.min(3200, pitchHz * (2.3 + breach * 1.4));
    slot.noiseFilter.frequency.setTargetAtTime(clampAudioFreq(ctx, rawNoiseCenter, 1100, 80), now, 0.016);
    slot.noiseFilter.Q.setTargetAtTime(safeClamp((coh > 0.2 ? 1.8 : 1.1) + breach * 0.8, 1.2, 0.2, 18), now, 0.016);
    slot.puffDepth.gain.setTargetAtTime(safeClamp(solved.puffGateDepth, 0, 0, 1.5), now, 0.010);

    const noiseGainVal = safeClamp(solved.noiseGain, 0, 0, 0.8);
    if (isFreshAttack && v.exciter === 'brass_lip' && coh <= 0.2) {
      slot.noiseGain.gain.cancelScheduledValues(now);
      slot.noiseGain.gain.setValueAtTime(Math.max(noiseGainVal, amp * 0.08), now);
      slot.noiseGain.gain.setTargetAtTime(noiseGainVal, now + 0.014, 0.016);
    } else {
      slot.noiseGain.gain.setTargetAtTime(noiseGainVal, now, 0.012);
    }

    const vibRate = safeClamp(solved.flutterHz, 5.0 + idx * 0.2, 0.2, 35);
    const vibFrac = safeClamp(solved.flutterFrac, 0.0024 * Math.min(1, amp * 4), 0, 0.12);
    slot.vibOsc.frequency.setTargetAtTime(vibRate, now, 0.025);
    slot.vibDepth.gain.setTargetAtTime(pitchHz * vibFrac, now, 0.025);

    const squelchRate = safeClamp(solved.squelchRateHz, 12.0, 5.0, 48.0);
    // Floor guard: keep a-rate squelch sweep strictly <= 0.42 * min(formantHz, bellLp1Hz) so filter frequency never crosses 0 Hz!
    const maxSafeSquelch = 0.42 * Math.min(formantHz, bellLp1Hz);
    const safeSquelchSweep = safeClamp(solved.squelchSweepHz, 0, 0, maxSafeSquelch);
    slot.squelchOsc.frequency.setTargetAtTime(squelchRate, now, 0.025);
    slot.squelchDepth.gain.setTargetAtTime(safeSquelchSweep, now, 0.020);

    // Hot-swap simulated 3D Vibro-Acoustic Impulse Response — and cleanly disconnect when `!wantIr`!
    const wantIr = !!(v.bodyIr && v.bodyIr.length > 0 && v.bodyIrSig);
    if (!wantIr && slot.bodyConvolver) {
      try { slot.bellLowpass2.disconnect(slot.bodyConvolver); } catch { /* ignore */ }
      try { slot.bodyConvolver.disconnect(); } catch { /* ignore */ }
      slot.bodyConvolver = null;
      slot.lastIrSig = '';
    } else if (wantIr && v.bodyIr && v.bodyIrSig && slot.lastIrSig !== v.bodyIrSig) {
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
      } else {
        slot.lastIrSig = '';
      }
    }

    if (wantIr && slot.bodyConvolver) {
      slot.dryBoreGain.gain.setTargetAtTime(0.82, now, 0.015);
      slot.wetBodyIrGain.gain.setTargetAtTime(0.55, now, 0.015);
    } else {
      slot.dryBoreGain.gain.setTargetAtTime(1.0, now, 0.015);
      slot.wetBodyIrGain.gain.setTargetAtTime(0, now, 0.015);
    }

    slot.spatial.apply(v.pan, v.distanceGain, now, isFreshAttack);
    slot.wasActive = true;
  }

  for (let i = 0; i < bank.slots.length; i++) {
    if (!usedSlots.has(i)) {
      const slot = bank.slots[i];
      if (slot.wasActive) {
        const tuckHz = clampAudioFreq(ctx, Math.max(320, slot.lastPitchHz * 1.35), 400, 80);
        slot.bellLowpass1.frequency.setTargetAtTime(tuckHz, now, 0.010);
        slot.bellLowpass2.frequency.setTargetAtTime(clampAudioFreq(ctx, tuckHz * 1.25, 500, 100), now, 0.010);
        slot.driveGain.gain.setTargetAtTime(0.45, now, 0.010);
      }
      slot.voiceGain.gain.setTargetAtTime(0, now, 0.010);
      slot.noiseGain.gain.setTargetAtTime(0, now, 0.008);
      slot.puffDepth.gain.setTargetAtTime(0, now, 0.008);
      slot.vibDepth.gain.setTargetAtTime(0, now, 0.012);
      // Decay squelchDepth faster (5 ms) than bellLowpass1 (10 ms) so cutoff never underflows during release tuck
      slot.squelchDepth.gain.setTargetAtTime(0, now, 0.005);
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
  const now = finiteOr(ctx.currentTime, 0);
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
    slot.squelchDepth.gain.setTargetAtTime(0, now, 0.005);
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
  const now = finiteOr(ctx.currentTime, 0);
  const slots: NativeBowedVoiceSlot[] = [];

  // 6 slots so a 4-string cello + legato sympathetic tails / double-stops never steal releasing strings!
  for (let i = 0; i < 6; i++) {
    const spatial = createSlotSpatialStage(ctx, sharedBus);

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(clampAudioFreq(ctx, 98.0), now);

    const osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.setValueAtTime(clampAudioFreq(ctx, 98.0), now);
    osc2.detune.setValueAtTime(-3.6, now);

    const osc3 = ctx.createOscillator();
    osc3.type = 'sawtooth';
    osc3.frequency.setValueAtTime(clampAudioFreq(ctx, 98.0), now);
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
    jitterLp1.frequency.setValueAtTime(clampAudioFreq(ctx, 30 + i * 4, 30, 10), now);
    jitterLp1.Q.setValueAtTime(0.85, now);
    const jitterDepth1 = ctx.createGain();
    jitterDepth1.gain.setValueAtTime(4.2, now);

    const jitterLp2 = ctx.createBiquadFilter();
    jitterLp2.type = 'bandpass';
    jitterLp2.frequency.setValueAtTime(clampAudioFreq(ctx, 21 + i * 3, 21, 10), now);
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
    bowLowpass.frequency.setValueAtTime(clampAudioFreq(ctx, 2600), now);
    bowLowpass.Q.setValueAtTime(0.52, now);

    const voiceGain = ctx.createGain();
    voiceGain.gain.setValueAtTime(0, now);

    const rosinFilter = ctx.createBiquadFilter();
    rosinFilter.type = 'bandpass';
    rosinFilter.frequency.setValueAtTime(clampAudioFreq(ctx, 2000), now);
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
    voiceGain.connect(spatial.input);

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
      releaseUntilTime: 0,
      lastPitchHz: 98.0,
      lastAmplitude: 0,
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
      spatial,
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

  const now = finiteOr(ctx.currentTime, 0);
  const usedSlots = new Set<number>();

  // Filter ONLY active bowed voices first and sort loudest-first so inactive payloads never steal slots!
  const activeVoices = voices
    .filter((v) => v && v.active && finiteOr(v.amplitude, 0) > 0.001)
    .sort((a, b) => finiteOr(b.amplitude, 0) - finiteOr(a.amplitude, 0))
    .slice(0, bank.slots.length);

  for (const v of activeVoices) {
    // 1. Exact string ID match
    let idx = bank.slots.findIndex((s, i) => !usedSlots.has(i) && s.id === v.id);
    // 2. Idle slot whose sympathetic release tail has fully finished (`now >= releaseUntilTime`)
    if (idx === -1) {
      idx = bank.slots.findIndex((s, i) => !usedSlots.has(i) && !s.wasActive && now >= s.releaseUntilTime);
    }
    // 3. Oldest releasing inactive slot (minimizing any audible tail pitch-jump!)
    if (idx === -1) {
      let bestIdx = -1;
      let oldestRelease = Infinity;
      for (let i = 0; i < bank.slots.length; i++) {
        const s = bank.slots[i];
        if (!usedSlots.has(i) && !s.wasActive && s.releaseUntilTime < oldestRelease) {
          oldestRelease = s.releaseUntilTime;
          bestIdx = i;
        }
      }
      idx = bestIdx;
    }
    // 4. Fallback: any remaining unused slot
    if (idx === -1) {
      idx = bank.slots.findIndex((_s, i) => !usedSlots.has(i));
    }
    if (idx === -1) continue;
    usedSlots.add(idx);

    const slot = bank.slots[idx];
    const isNewId = slot.id !== v.id;
    slot.id = v.id;

    // Instantiate a fresh resampled ConvolverNode whenever the 3D body/bridge IR signature changes,
    // and disconnect completely when `!wantIr` so floating wires burn zero FFT CPU!
    const wantIr = !!(v.bodyIr && v.bodyIr.length > 0 && v.bodyIrSig);
    if (!wantIr && slot.bodyConvolver) {
      try { slot.mixGain.disconnect(slot.bodyConvolver); } catch { /* ignore */ }
      try { slot.rosinGain.disconnect(slot.bodyConvolver); } catch { /* ignore */ }
      try { slot.bodyConvolver.disconnect(); } catch { /* ignore */ }
      slot.bodyConvolver = null;
      slot.lastIrSig = '';
    } else if (wantIr && v.bodyIr && v.bodyIrSig && slot.lastIrSig !== v.bodyIrSig) {
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
      } else {
        slot.lastIrSig = '';
      }
    }

    const hasIr = !!(wantIr && slot.bodyConvolver);
    if (hasIr) {
      slot.wetBodyGain.gain.setTargetAtTime(2.35, now, 0.015);
      slot.dryWireGain.gain.setTargetAtTime(0.24, now, 0.015);
    } else {
      slot.wetBodyGain.gain.setTargetAtTime(0, now, 0.015);
      slot.dryWireGain.gain.setTargetAtTime(0.88, now, 0.015);
    }

    // Feed pure Helmholtz/Cremer string harmonics into the 3D Body Convolver (avoiding double body filtering!)
    const rawHw = hasIr && v.stringHarmonicWeights?.length ? v.stringHarmonicWeights : v.harmonicWeights;
    const hw = Array.isArray(rawHw) ? rawHw : [];
    const waveSig = `${hasIr ? 'ir' : 'dry'}:${hw.length}:${hw.slice(0, 24).map((w) => Math.round(finiteOr(w, 0) * 40)).join(',')}`;
    const isFreshAttack = !slot.wasActive || isNewId;

    if ((isFreshAttack || slot.lastWaveSig !== waveSig) && hw.length > 0) {
      const nHarm = hw.length + 1;
      const real = new Float32Array(new ArrayBuffer(nHarm * 4));
      const imag = new Float32Array(new ArrayBuffer(nHarm * 4));
      const real2 = new Float32Array(new ArrayBuffer(nHarm * 4));
      const imag2 = new Float32Array(new ArrayBuffer(nHarm * 4));
      const real3 = new Float32Array(new ArrayBuffer(nHarm * 4));
      const imag3 = new Float32Array(new ArrayBuffer(nHarm * 4));
      for (let h = 0; h < hw.length; h++) {
        const n = h + 1;
        const amp = safeClamp(hw[h], 0, -4, 4);
        const sign = n % 2 === 1 ? 1 : -1;
        imag[n] = sign * amp;
        const phi2 = n * 0.19;
        real2[n] = sign * amp * Math.sin(phi2);
        imag2[n] = sign * amp * Math.cos(phi2);
        const phi3 = -n * 0.27;
        real3[n] = sign * amp * Math.sin(phi3);
        imag3[n] = sign * amp * Math.cos(phi3);
      }
      const w1 = safePeriodicWave(ctx, real, imag);
      const w2 = safePeriodicWave(ctx, real2, imag2);
      const w3 = safePeriodicWave(ctx, real3, imag3);
      if (w1 && w2 && w3) {
        slot.osc.setPeriodicWave(w1);
        slot.osc2.setPeriodicWave(w2);
        slot.osc3.setPeriodicWave(w3);
        slot.lastWaveSig = waveSig;
      }
    }

    const pitchHz = clampAudioFreq(ctx, v.pitchHz, 98.0, 18);
    const lowpassHz = clampAudioFreq(ctx, v.lowpassHz, 2600, 80);
    const rosinCenterHz = clampAudioFreq(ctx, v.rosinCenterHz, 2000, 120);
    const amplitude = safeClamp(v.amplitude, 0, 0, 1.5);
    const rosinNoiseGain = safeClamp(v.rosinNoiseGain, 0, 0, 1.2);

    const prevPitchHz = slot.lastPitchHz;
    slot.lastPitchHz = pitchHz;
    slot.lastAmplitude = amplitude;
    const isPitchStep = !isFreshAttack && Math.abs(pitchHz - prevPitchHz) > prevPitchHz * 0.025;

    if (isFreshAttack) {
      slot.activeSinceTime = now;
      // If stealing a slot still inside its release tail, zero voiceGain cleanly before snapping pitch
      if (isNewId && now < slot.releaseUntilTime) {
        slot.voiceGain.gain.cancelScheduledValues(now);
        slot.voiceGain.gain.setValueAtTime(0, now);
      }
      slot.osc.frequency.cancelScheduledValues(now);
      slot.osc.frequency.setValueAtTime(pitchHz, now);
      slot.osc2.frequency.cancelScheduledValues(now);
      slot.osc2.frequency.setValueAtTime(pitchHz, now);
      slot.osc3.frequency.cancelScheduledValues(now);
      slot.osc3.frequency.setValueAtTime(pitchHz, now);
      slot.bowLowpass.frequency.cancelScheduledValues(now);
      slot.bowLowpass.frequency.setValueAtTime(lowpassHz, now);
    } else {
      if (isPitchStep) slot.activeSinceTime = now;
      const pitchTau = isPitchStep ? 0.0055 : 0.010;
      slot.osc.frequency.setTargetAtTime(pitchHz, now, pitchTau);
      slot.osc2.frequency.setTargetAtTime(pitchHz, now, pitchTau);
      slot.osc3.frequency.setTargetAtTime(pitchHz, now, pitchTau);
      slot.bowLowpass.frequency.setTargetAtTime(lowpassHz, now, 0.022);
    }

    const sustainedSec = Math.max(0, now - slot.activeSinceTime);
    const vibBloom = sustainedSec >= 0.05 ? Math.min(1, (sustainedSec - 0.05) / 0.18) : 0;
    slot.vibOsc.frequency.setTargetAtTime(5.18 + idx * 0.11, now, 0.030);
    slot.vibDepth.gain.setTargetAtTime(pitchHz * 0.0052 * vibBloom, now, 0.035);

    const gainTau = isFreshAttack ? 0.024 : 0.016;
    slot.voiceGain.gain.cancelScheduledValues(now);
    slot.voiceGain.gain.setTargetAtTime(amplitude, now, gainTau);
    slot.rosinFilter.frequency.setTargetAtTime(rosinCenterHz, now, 0.018);
    const attackChiff = isFreshAttack ? 1.25 : 1.0;
    slot.rosinGain.gain.setTargetAtTime(rosinNoiseGain * 0.60 * attackChiff, now, 0.016);

    slot.spatial.apply(v.pan, v.distanceGain, now, isFreshAttack);
    slot.wasActive = true;
    slot.releaseUntilTime = now + 0.36;
  }

  for (let i = 0; i < bank.slots.length; i++) {
    if (!usedSlots.has(i)) {
      const slot = bank.slots[i];
      if (slot.wasActive) {
        // Singing 115 ms open-string sympathetic ring connects legato crossings warmly without muddying 16th notes!
        slot.voiceGain.gain.cancelScheduledValues(now);
        slot.voiceGain.gain.setTargetAtTime(0, now, 0.115);
        slot.rosinGain.gain.cancelScheduledValues(now);
        slot.rosinGain.gain.setTargetAtTime(0, now, 0.015);
        slot.vibDepth.gain.cancelScheduledValues(now);
        slot.vibDepth.gain.setTargetAtTime(0, now, 0.040);
        slot.releaseUntilTime = now + 0.38;
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
  const now = finiteOr(ctx.currentTime, 0);
  for (const slot of bank.slots) {
    slot.voiceGain.gain.cancelScheduledValues(now);
    slot.voiceGain.gain.setTargetAtTime(0, now, 0.010);
    slot.rosinGain.gain.cancelScheduledValues(now);
    slot.rosinGain.gain.setTargetAtTime(0, now, 0.008);
    slot.vibDepth.gain.cancelScheduledValues(now);
    slot.vibDepth.gain.setTargetAtTime(0, now, 0.010);
    slot.releaseUntilTime = now + 0.03;
    slot.wasActive = false;
  }
}

export function ensureNativeAeroBank(ctx: AudioContext): NativeAeroBankState | null {
  const c = ctx as AudioContextWithWindGraph;
  if (c.__physboxNativeAeroV1) return c.__physboxNativeAeroV1;
  const windBank = ensureNativeWindBank(ctx);
  if (!windBank) return null;

  const sharedBus = getSharedAcousticOutputBus(ctx);
  const now = finiteOr(ctx.currentTime, 0);
  const slots: NativeAeroVoiceSlot[] = [];

  for (let i = 0; i < 8; i++) {
    const spatial = createSlotSpatialStage(ctx, sharedBus);

    // 1. Gutin Propeller / Rotor Tonal PeriodicWave Oscillator
    const propOsc = ctx.createOscillator();
    propOsc.type = 'sawtooth';
    propOsc.frequency.setValueAtTime(clampAudioFreq(ctx, 55.0 + i * 0.3), now);

    const propLowpass = ctx.createBiquadFilter();
    propLowpass.type = 'lowpass';
    propLowpass.frequency.setValueAtTime(clampAudioFreq(ctx, 2800), now);
    propLowpass.Q.setValueAtTime(0.65, now);

    const tonalGain = ctx.createGain();
    tonalGain.gain.setValueAtTime(0, now);

    propOsc.connect(propLowpass);
    propLowpass.connect(tonalGain);
    tonalGain.connect(spatial.input);

    // 2. Curle Strouhal Vortex-Shedding Bandpass + Raised-Cosine Blade-Pass / Flutter AM
    const strouhalFilter = ctx.createBiquadFilter();
    strouhalFilter.type = 'bandpass';
    strouhalFilter.frequency.setValueAtTime(clampAudioFreq(ctx, 600), now);
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
    rustleShelf.frequency.setValueAtTime(clampAudioFreq(ctx, 2800), now);
    rustleShelf.Q.setValueAtTime(0.8, now);

    const rustleGain = ctx.createGain();
    rustleGain.gain.setValueAtTime(0, now);

    if (windBank.noiseSource) {
      windBank.noiseSource.connect(strouhalFilter);
      strouhalFilter.connect(noiseGain);
      noiseGain.connect(spatial.input);

      windBank.noiseSource.connect(rustleShelf);
      rustleShelf.connect(rustleGain);
      rustleGain.connect(spatial.input);
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
      spatial,
    });
  }

  const aeroBank: NativeAeroBankState = { slots };
  c.__physboxNativeAeroV1 = aeroBank;
  return aeroBank;
}

export function postWorkletAeroUpdate(ctx: AudioContext, voices: SpatialAeroSynthParams[]): void {
  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => {});
  }
  const bank = ensureNativeAeroBank(ctx);
  if (!bank) return;

  const now = finiteOr(ctx.currentTime, 0);
  const usedSlots = new Set<number>();

  // Filter active & prioritize the 8 loudest aero voices
  const activeVoices = voices
    .filter((v) => v && v.active)
    .sort(
      (a, b) =>
        finiteOr(b.tonalGain, 0) + finiteOr(b.noiseGain, 0) + finiteOr(b.rustleGain, 0) -
        (finiteOr(a.tonalGain, 0) + finiteOr(a.noiseGain, 0) + finiteOr(a.rustleGain, 0)),
    )
    .slice(0, bank.slots.length);

  for (const v of activeVoices) {
    let idx = bank.slots.findIndex((s, i) => !usedSlots.has(i) && s.id === v.id);
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
    const isFresh = !slot.wasActive || isNewId;

    const bpfHz = clampAudioFreq(ctx, v.bpfHz, 55, 18);
    const hw = Array.isArray(v.harmonicWeights) ? v.harmonicWeights : [];

    // 1. Tonal Gutin Propeller Branch
    if (v.tonalActive && finiteOr(v.bpfHz, 0) >= 22 && hw.length > 0) {
      const waveSig = `${hw.length}:${hw.map((w) => Math.round(finiteOr(w, 0) * 30)).join(',')}`;
      if (isFresh || slot.lastWaveSig !== waveSig) {
        const nHarm = hw.length + 1;
        const real = new Float32Array(new ArrayBuffer(nHarm * 4));
        const imag = new Float32Array(new ArrayBuffer(nHarm * 4));
        for (let h = 0; h < hw.length; h++) {
          const n = h + 1;
          const w = safeClamp(hw[h], 0, -4, 4);
          const phase = -0.75 + n * 0.23;
          real[n] = w * Math.cos(phase);
          imag[n] = w * Math.sin(phase);
        }
        const wave = safePeriodicWave(ctx, real, imag);
        if (wave) {
          slot.propOsc.setPeriodicWave(wave);
          slot.lastWaveSig = waveSig;
        }
      }

      const stallRough = safeClamp(v.stallRoughness, 0, 0, 1);
      const rawLpHz = Math.min(8500, Math.max(650, bpfHz * (5.5 + 8.0 * (1 - stallRough))));
      const lpHz = clampAudioFreq(ctx, rawLpHz, 2800, 120);
      if (isFresh) {
        slot.propOsc.frequency.cancelScheduledValues(now);
        slot.propOsc.frequency.setValueAtTime(bpfHz, now);
        slot.propLowpass.frequency.setValueAtTime(lpHz, now);
      } else {
        slot.propOsc.frequency.setTargetAtTime(bpfHz, now, 0.018);
        slot.propLowpass.frequency.setTargetAtTime(lpHz, now, 0.022);
      }
      slot.tonalGain.gain.setTargetAtTime(safeClamp(v.tonalGain, 0, 0, 1.0), now, 0.018);
    } else {
      slot.tonalGain.gain.setTargetAtTime(0, now, 0.014);
    }

    // 2. Broadband Strouhal Vortex-Shedding + Blade-Pass / Stall Flutter AM Branch
    const strouhalHz = clampAudioFreq(ctx, v.noiseCenterHz, 600, 60);
    const strouhalQ = safeClamp(v.noiseQ, 1.5, 0.2, 18);
    const noiseGainVal = safeClamp(v.noiseGain, 0, 0, 1.0);
    if (isFresh) {
      slot.strouhalFilter.frequency.setValueAtTime(strouhalHz, now);
      slot.strouhalFilter.Q.setValueAtTime(strouhalQ, now);
    } else {
      slot.strouhalFilter.frequency.setTargetAtTime(strouhalHz, now, 0.022);
      slot.strouhalFilter.Q.setTargetAtTime(strouhalQ, now, 0.022);
    }
    slot.noiseGain.gain.setTargetAtTime(noiseGainVal, now, 0.018);

    const amRate = safeClamp(v.amRateHz, 0, 0, 48);
    const amDepth = safeClamp(v.amDepth, 0, 0, 1);
    if (amRate >= 0.4 && amDepth > 0.01 && noiseGainVal > 0.001) {
      slot.amOsc.frequency.setTargetAtTime(amRate, now, 0.025);
      slot.amDepth.gain.setTargetAtTime(noiseGainVal * amDepth * 0.55, now, 0.020);
    } else {
      slot.amDepth.gain.setTargetAtTime(0, now, 0.016);
    }

    // 3. Cloth Weave-Rubbing High-Shelf Branch
    const rustleGainVal = safeClamp(v.rustleGain, 0, 0, 0.8);
    if (rustleGainVal > 0.001) {
      slot.rustleShelf.frequency.setTargetAtTime(clampAudioFreq(ctx, v.rustleFreqHz, 2800, 200), now, 0.022);
      slot.rustleGain.gain.setTargetAtTime(rustleGainVal, now, 0.018);
    } else {
      slot.rustleGain.gain.setTargetAtTime(0, now, 0.015);
    }

    slot.spatial.apply(v.pan, v.distanceGain, now, isFresh);
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

export function postWorkletAeroSnap(
  ctx: AudioContext,
  snap: SpatialSnapSynthParams,
  spatial?: Partial<SpatialAcousticParams> | null,
): void {
  const gain = safeClamp(snap?.gain, 0, 0, 1.2);
  if (!snap || !snap.active || gain <= 0.002) return;
  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => {});
  }
  if (typeof ctx.createBuffer !== 'function' || typeof ctx.createBufferSource !== 'function') return;

  const sharedBus = getSharedAcousticOutputBus(ctx);
  const sr = ctx.sampleRate && Number.isFinite(ctx.sampleRate) && ctx.sampleRate > 0 ? ctx.sampleRate : 48000;
  const now = finiteOr(ctx.currentTime, 0);
  const tau = safeClamp(snap.durationSec, 0.0015, 0.0003, 0.020);
  const totalDur = Math.max(0.018, tau * 12);
  const len = Math.max(64, Math.ceil(sr * totalDur));
  const buf = ctx.createBuffer(1, len, sr);
  const ch = buf.getChannelData(0);

  let seed =
    (Math.imul(Math.round((snap.impulseNs ?? 0.045) * 1e6), 2654435761) ^
      Math.round(snap.centerHz * 17) ^
      (snap.seq ?? 0)) |
    1;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    let nWave: number;
    if (t < tau) {
      const u = t / tau;
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
  bp.frequency.setValueAtTime(clampAudioFreq(ctx, snap.centerHz, 1200, 80), now);
  bp.Q.setValueAtTime(safeClamp(snap.bandpassQ, 1.2, 0.2, 18), now);

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(clampAudioFreq(ctx, snap.lowpassHz, 2400, 120), now);
  lp.Q.setValueAtTime(0.8, now);

  const outGain = ctx.createGain();
  outGain.gain.setValueAtTime(gain, now);

  // Parallel low-mid Curle air-displacement dipole billow-thump bandpass (115–340 Hz, Q = 1.4)
  const thumpBp = ctx.createBiquadFilter();
  thumpBp.type = 'bandpass';
  const rawThumpHz = safeClamp(0.22 * snap.centerHz, 165, 115, 340);
  thumpBp.frequency.setValueAtTime(clampAudioFreq(ctx, rawThumpHz, 165, 60), now);
  thumpBp.Q.setValueAtTime(1.4, now);

  const thumpGain = ctx.createGain();
  thumpGain.gain.setValueAtTime(gain * 0.32, now);

  const resolvedSpatial = spatial ?? (snap.pan !== undefined || snap.distanceGain !== undefined
    ? { pan: snap.pan, distanceGain: snap.distanceGain }
    : null);
  const spatialSend = createSpatialSend(ctx, sharedBus, resolvedSpatial);

  src.connect(bp);
  bp.connect(lp);
  lp.connect(outGain);
  outGain.connect(spatialSend.input);

  src.connect(thumpBp);
  thumpBp.connect(thumpGain);
  thumpGain.connect(spatialSend.input);

  src.start(now);
  src.onended = () => {
    try { src.disconnect(); } catch { /* ignore */ }
    try { bp.disconnect(); } catch { /* ignore */ }
    try { lp.disconnect(); } catch { /* ignore */ }
    try { outGain.disconnect(); } catch { /* ignore */ }
    try { thumpBp.disconnect(); } catch { /* ignore */ }
    try { thumpGain.disconnect(); } catch { /* ignore */ }
    spatialSend.disconnect();
  };
}

export function postWorkletAeroSilence(ctx: AudioContext | null): void {
  if (!ctx) return;
  const c = ctx as AudioContextWithWindGraph;
  const bank = c.__physboxNativeAeroV1;
  if (!bank) return;
  const now = finiteOr(ctx.currentTime, 0);
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

// ---------------------------------------------------------------------------
// Starter #2: 6-Slot Continuous Rolling / Scraping / Squeal / Singing-Rim Bank
// ---------------------------------------------------------------------------

export function ensureNativeFrictionBank(ctx: AudioContext): NativeFrictionBankState | null {
  const c = ctx as AudioContextWithWindGraph;
  if (c.__physboxNativeFrictionV1) return c.__physboxNativeFrictionV1;
  const windBank = ensureNativeWindBank(ctx);
  if (!windBank) return null;

  const sharedBus = getSharedAcousticOutputBus(ctx);
  const now = finiteOr(ctx.currentTime, 0);
  const slots: NativeFrictionVoiceSlot[] = [];

  for (let i = 0; i < 6; i++) {
    const spatial = createSlotSpatialStage(ctx, sharedBus);

    // 1. Fractal Surface-Roughness & Hertzian Contact-Patch Noise Branch
    const noiseBandpass = ctx.createBiquadFilter();
    noiseBandpass.type = 'bandpass';
    noiseBandpass.frequency.setValueAtTime(clampAudioFreq(ctx, 650), now);
    noiseBandpass.Q.setValueAtTime(1.2, now);

    const patchLowpass = ctx.createBiquadFilter();
    patchLowpass.type = 'lowpass';
    patchLowpass.frequency.setValueAtTime(clampAudioFreq(ctx, 2200), now);
    patchLowpass.Q.setValueAtTime(0.707, now);

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0, now);

    const grainOsc = ctx.createOscillator();
    grainOsc.type = 'triangle';
    grainOsc.frequency.setValueAtTime(14.0 + i * 0.7, now);

    const grainDepth = ctx.createGain();
    grainDepth.gain.setValueAtTime(0, now);
    grainOsc.connect(grainDepth);
    grainDepth.connect(noiseGain.gain);

    // 2. Stribeck Stick-Slip Squeal / Singing-Rim Quadrupole Dual-Oscillator Branch
    const tonalOsc1 = ctx.createOscillator();
    tonalOsc1.type = 'sine';
    tonalOsc1.frequency.setValueAtTime(clampAudioFreq(ctx, 440), now);

    const tonalOsc2 = ctx.createOscillator();
    tonalOsc2.type = 'sine';
    tonalOsc2.frequency.setValueAtTime(clampAudioFreq(ctx, 442), now);

    const tMix1 = ctx.createGain();
    tMix1.gain.setValueAtTime(0.62, now);
    const tMix2 = ctx.createGain();
    tMix2.gain.setValueAtTime(0.38, now);

    const tonalDriveGain = ctx.createGain();
    tonalDriveGain.gain.setValueAtTime(0.5, now);

    const tonalShaper = ctx.createWaveShaper();
    tonalShaper.curve = windBank.softSatCurve;
    tonalShaper.oversample = '2x';

    const tonalGain = ctx.createGain();
    tonalGain.gain.setValueAtTime(0, now);

    tonalOsc1.connect(tMix1);
    tonalOsc2.connect(tMix2);
    tMix1.connect(tonalDriveGain);
    tMix2.connect(tonalDriveGain);
    tonalDriveGain.connect(tonalShaper);
    tonalShaper.connect(tonalGain);

    // 3. Structural Modal Resonator Peaks + 3D Body FIR Routing
    const exciterMix = ctx.createGain();
    exciterMix.gain.setValueAtTime(1.0, now);

    if (windBank.noiseSource) {
      windBank.noiseSource.connect(noiseBandpass);
      noiseBandpass.connect(patchLowpass);
      patchLowpass.connect(noiseGain);
      noiseGain.connect(exciterMix);
    }
    tonalGain.connect(exciterMix);

    const modePeak1 = ctx.createBiquadFilter();
    modePeak1.type = 'peaking';
    modePeak1.frequency.setValueAtTime(clampAudioFreq(ctx, 440), now);
    modePeak1.Q.setValueAtTime(4.0, now);
    modePeak1.gain.setValueAtTime(6.0, now);

    const modePeak2 = ctx.createBiquadFilter();
    modePeak2.type = 'peaking';
    modePeak2.frequency.setValueAtTime(clampAudioFreq(ctx, 980), now);
    modePeak2.Q.setValueAtTime(3.2, now);
    modePeak2.gain.setValueAtTime(4.0, now);

    const dryModalGain = ctx.createGain();
    dryModalGain.gain.setValueAtTime(0.92, now);

    const wetIrGain = ctx.createGain();
    wetIrGain.gain.setValueAtTime(0, now);

    const voiceGain = ctx.createGain();
    voiceGain.gain.setValueAtTime(1.0, now);

    exciterMix.connect(modePeak1);
    modePeak1.connect(modePeak2);
    modePeak2.connect(dryModalGain);
    dryModalGain.connect(voiceGain);
    wetIrGain.connect(voiceGain);
    voiceGain.connect(spatial.input);

    grainOsc.start(now);
    tonalOsc1.start(now);
    tonalOsc2.start(now);

    slots.push({
      id: '',
      wasActive: false,
      lastIrSig: '',
      noiseBandpass,
      patchLowpass,
      noiseGain,
      grainOsc,
      grainDepth,
      tonalOsc1,
      tonalOsc2,
      tonalDriveGain,
      tonalShaper,
      tonalGain,
      exciterMix,
      modePeak1,
      modePeak2,
      dryModalGain,
      bodyConvolver: null,
      wetIrGain,
      voiceGain,
      spatial,
    });
  }

  const frictionBank: NativeFrictionBankState = { slots };
  c.__physboxNativeFrictionV1 = frictionBank;
  return frictionBank;
}

export function postWorkletFrictionUpdate(
  ctx: AudioContext,
  voices: WorkletFrictionVoicePayload[],
): void {
  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => {});
  }
  const bank = ensureNativeFrictionBank(ctx);
  if (!bank) return;

  const now = finiteOr(ctx.currentTime, 0);
  const usedSlots = new Set<number>();

  const activeVoices = voices
    .filter((v) => v && v.active && (finiteOr(v.noiseGain, 0) >= 0.0015 || finiteOr(v.tonalGain, 0) >= 0.0015))
    .sort(
      (a, b) =>
        finiteOr(b.noiseGain, 0) + finiteOr(b.tonalGain, 0) -
        (finiteOr(a.noiseGain, 0) + finiteOr(a.tonalGain, 0)),
    )
    .slice(0, bank.slots.length);

  for (const v of activeVoices) {
    let idx = bank.slots.findIndex((s, i) => !usedSlots.has(i) && s.id === v.id);
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
    const isFresh = !slot.wasActive || isNewId;
    const tau = safeClamp(v.attackTauSec, 0.020, 0.008, 0.45);

    // Hot-swap 3D body FIR convolver, disconnecting cleanly when absent
    const wantIr = !!(v.bodyIr && v.bodyIr.length > 0 && v.bodyIrSig);
    if (!wantIr && slot.bodyConvolver) {
      try { slot.exciterMix.disconnect(slot.bodyConvolver); } catch { /* ignore */ }
      try { slot.bodyConvolver.disconnect(); } catch { /* ignore */ }
      slot.bodyConvolver = null;
      slot.lastIrSig = '';
    } else if (wantIr && v.bodyIr && v.bodyIrSig && slot.lastIrSig !== v.bodyIrSig) {
      if (slot.bodyConvolver) {
        try { slot.exciterMix.disconnect(slot.bodyConvolver); } catch { /* ignore */ }
        try { slot.bodyConvolver.disconnect(); } catch { /* ignore */ }
      }
      const nextConv = createResampledConvolver(ctx, v.bodyIr);
      slot.bodyConvolver = nextConv;
      if (nextConv) {
        slot.exciterMix.connect(nextConv);
        nextConv.connect(slot.wetIrGain);
        slot.lastIrSig = v.bodyIrSig;
      } else {
        slot.lastIrSig = '';
      }
    }

    if (wantIr && slot.bodyConvolver) {
      slot.dryModalGain.gain.setTargetAtTime(0.58, now, 0.018);
      slot.wetIrGain.gain.setTargetAtTime(1.35, now, 0.018);
    } else {
      slot.dryModalGain.gain.setTargetAtTime(0.95, now, 0.018);
      slot.wetIrGain.gain.setTargetAtTime(0, now, 0.018);
    }

    // Resonator modal peaks
    const m1Hz = clampAudioFreq(ctx, v.mode1Hz, 440, 55);
    const m2Hz = clampAudioFreq(ctx, v.mode2Hz, 980, 90);
    const m1Q = safeClamp(v.mode1Q, 4.0, 0.5, 24);
    const m2Q = safeClamp(v.mode2Q, 3.2, 0.5, 20);
    const m1Gain = safeClamp(v.mode1GainDb, 6.0, -12, 18);
    const m2Gain = safeClamp(v.mode2GainDb, 4.0, -12, 16);

    // Broadband roughness branch
    const nCenterHz = clampAudioFreq(ctx, v.noiseCenterHz, 650, 50);
    const pLpHz = clampAudioFreq(ctx, v.patchLowpassHz, 2200, 90);
    const nQ = safeClamp(v.noiseQ, 1.2, 0.25, 18);
    const nGain = safeClamp(v.noiseGain, 0, 0, 0.65);
    const gRate = safeClamp(v.grainRateHz, 12, 0.5, 55);
    const gDepth = safeClamp(v.grainDepth, 0, 0, 1);

    if (isFresh) {
      slot.modePeak1.frequency.setValueAtTime(m1Hz, now);
      slot.modePeak1.Q.setValueAtTime(m1Q, now);
      slot.modePeak1.gain.setValueAtTime(m1Gain, now);
      slot.modePeak2.frequency.setValueAtTime(m2Hz, now);
      slot.modePeak2.Q.setValueAtTime(m2Q, now);
      slot.modePeak2.gain.setValueAtTime(m2Gain, now);
      slot.noiseBandpass.frequency.setValueAtTime(nCenterHz, now);
      slot.noiseBandpass.Q.setValueAtTime(nQ, now);
      slot.patchLowpass.frequency.setValueAtTime(pLpHz, now);
    } else {
      slot.modePeak1.frequency.setTargetAtTime(m1Hz, now, 0.020);
      slot.modePeak1.Q.setTargetAtTime(m1Q, now, 0.020);
      slot.modePeak1.gain.setTargetAtTime(m1Gain, now, 0.020);
      slot.modePeak2.frequency.setTargetAtTime(m2Hz, now, 0.020);
      slot.modePeak2.Q.setTargetAtTime(m2Q, now, 0.020);
      slot.modePeak2.gain.setTargetAtTime(m2Gain, now, 0.020);
      slot.noiseBandpass.frequency.setTargetAtTime(nCenterHz, now, 0.018);
      slot.noiseBandpass.Q.setTargetAtTime(nQ, now, 0.018);
      slot.patchLowpass.frequency.setTargetAtTime(pLpHz, now, 0.018);
    }

    slot.noiseGain.gain.setTargetAtTime(nGain, now, 0.018);
    if (gDepth > 0.02 && nGain > 0.002) {
      slot.grainOsc.frequency.setTargetAtTime(gRate, now, 0.025);
      slot.grainDepth.gain.setTargetAtTime(nGain * gDepth * 0.48, now, 0.020);
    } else {
      slot.grainDepth.gain.setTargetAtTime(0, now, 0.015);
    }

    // Tonal stick-slip / singing-rim branch
    const tGain = v.tonalActive ? safeClamp(v.tonalGain, 0, 0, 0.65) : 0;
    if (v.tonalActive && tGain > 0.001) {
      const f1 = clampAudioFreq(ctx, v.tonalFreqHz, 440, 55);
      const f2 = clampAudioFreq(ctx, v.tonalBeatFreqHz, f1 * 1.005, 55);
      slot.tonalOsc1.type = v.regime === 'stick_slip_squeal' ? 'sawtooth' : 'sine';
      slot.tonalOsc2.type = 'sine';
      if (isFresh) {
        slot.tonalOsc1.frequency.cancelScheduledValues(now);
        slot.tonalOsc1.frequency.setValueAtTime(f1, now);
        slot.tonalOsc2.frequency.cancelScheduledValues(now);
        slot.tonalOsc2.frequency.setValueAtTime(f2, now);
      } else {
        slot.tonalOsc1.frequency.setTargetAtTime(f1, now, 0.014);
        slot.tonalOsc2.frequency.setTargetAtTime(f2, now, 0.014);
      }
      slot.tonalDriveGain.gain.setTargetAtTime(safeClamp(v.tonalDrive, 0.5, 0.2, 2.4), now, 0.020);
      slot.tonalGain.gain.setTargetAtTime(tGain, now, tau);
    } else {
      slot.tonalGain.gain.setTargetAtTime(0, now, 0.022);
    }

    slot.voiceGain.gain.setTargetAtTime(1.0, now, 0.012);
    slot.spatial.apply(v.pan, v.distanceGain, now, isFresh);
    slot.wasActive = true;
  }

  for (let i = 0; i < bank.slots.length; i++) {
    if (!usedSlots.has(i)) {
      const slot = bank.slots[i];
      if (slot.wasActive) {
        // Gentle 65 ms decay lets singing-bowl / glass rim resonances ring down naturally without square-gate clicks
        slot.noiseGain.gain.setTargetAtTime(0, now, 0.016);
        slot.grainDepth.gain.setTargetAtTime(0, now, 0.014);
        slot.tonalGain.gain.setTargetAtTime(0, now, 0.065);
        slot.wasActive = false;
      }
    }
  }
}

export function postWorkletFrictionSilence(ctx: AudioContext | null): void {
  if (!ctx) return;
  const c = ctx as AudioContextWithWindGraph;
  const bank = c.__physboxNativeFrictionV1;
  if (!bank) return;
  const now = finiteOr(ctx.currentTime, 0);
  for (const slot of bank.slots) {
    slot.noiseGain.gain.cancelScheduledValues(now);
    slot.noiseGain.gain.setTargetAtTime(0, now, 0.010);
    slot.grainDepth.gain.cancelScheduledValues(now);
    slot.grainDepth.gain.setTargetAtTime(0, now, 0.008);
    slot.tonalGain.gain.cancelScheduledValues(now);
    slot.tonalGain.gain.setTargetAtTime(0, now, 0.012);
    slot.wasActive = false;
  }
}
