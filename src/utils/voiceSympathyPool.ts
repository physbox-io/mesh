// ---------------------------------------------------------------------------
// Bounded Polyphonic Modal Voice Pool, Physical Choking & Sympathetic Strings
// ---------------------------------------------------------------------------
//
// Solves all one-shot & sympathetic modal voice lifecycle requirements:
// 1. Bounded per-`nodeId` `ActiveModalVoiceGroup`s (`MAX_ACTIVE_IMPACTS = 24`,
//    `MAX_ACTIVE_CONVOLVERS = 16`, `MAX_ACTIVE_OSCILLATORS = 112`) — including
//    `modes.length === 0` ultrasonic rigid-body clacks/rolls!
// 2. Sanitized & sample-rate-scaled (`sourceRate / targetRate`) resampled
//    `AudioBuffer` LRU cache (`MAX_CACHED_IR_BUFFERS = 64`), preventing both
//    `NaN`/`Inf` bus poisoning and +6 dB 96 kHz convolution gain drift.
// 3. Click-free envelopes & `ctx.currentTime`-gated cleanup (never premature
//    wall-clock `setTimeout` disconnects on suspended `AudioContext`s) +
//    `silenceModalVoices()` for Pause / Reset / Mute.
// 4. Physical re-strike / re-pluck quadrature mutability & spatial contact
//    choking (preserving nodal flageolet harmonics while reusing existing
//    `OscillatorNode`s and per-body `ConvolverNode`!).
// 5. Viewport mouse-grab hand mute (`chokeBodyVoice`) & sustained worker
//    contact damping (`applyAudioDampingEvents` from `AUDIO_DAMPING`).
// 6. Weinreich-Gough bridge-admittance sympathetic string plucks & bowed halo,
//    plus Wave 2B hooks for pitch-glide, von Kármán crash-bloom/shimmer,
//    snare-rattle, vibraphone vane tremolo-LFO, and stereo spatial pan!
// ---------------------------------------------------------------------------

import type { SceneNode } from '../types/scene';
import type { AudioDampingEvent } from '../workers/physicsWorkerProtocol';
import type { ModalVoice } from './modalAudio';
import { evaluateNormalizedModeShape } from './solidAcoustics3D';
import {
  resolveStringBetaFromPoint,
  solveSympatheticStringCoupling,
} from './stringAcoustics';

export const MAX_ACTIVE_CONVOLVERS = 16;
export const MAX_ACTIVE_OSCILLATORS = 112;
export const MAX_ACTIVE_IMPACTS = 24;
export const MAX_CACHED_IR_BUFFERS = 64;

const LN_10000 = Math.log(10000);

export interface ModalVoiceSpec extends ModalVoice {
  /** Initial fractional pitch shift Δf_0 / f_0 (e.g. +0.025 for upward hard-pluck droop, or negative). */
  pitchDroopFrac?: number;
  /** Alternative initial pitch glide in cents (converted via 2^(cents / 1200) - 1). */
  pitchGlideCents?: number;
  /** Exponential 1/e relaxation time constant (s) for pitch glide back to `freqHz`. */
  pitchDroopTauSec?: number;
  /** Delayed onset (s) before mode begins blooming (Starter #4a von Kármán crash cascade). */
  bloomDelaySec?: number;
  /** Custom attack rise duration (s) for cascade bloom or sympathetic string energy transfer. */
  bloomAttackSec?: number;
}

export interface SnareRattleParams {
  /** Snare wire buzz gain in [0, 1]. */
  gain: number;
  /** Decay duration (-80 dB) in seconds (e.g. 0.08..0.35 s). */
  decaySec: number;
  /** Crisp snare wire bandpass center frequency (Hz, default 3200 Hz). */
  centerHz?: number;
}

export interface CrashShimmerParams {
  /** High-frequency nonlinear plate/gong crash shimmer wash gain in [0, 1]. */
  gain: number;
  /** Upward modal cascade bloom rise time in seconds (e.g. 0.05..0.25 s). */
  bloomSec: number;
  /** Shimmer wash decay duration in seconds (e.g. 0.4..2.8 s). */
  decaySec: number;
  /** Highpass cutoff frequency (Hz, default 2800 Hz). */
  highpassHz?: number;
}

export interface TremoloModulationParams {
  /** Motor-driven rotating vane LFO rate (Hz, e.g. |Ω| / π = 2 cycles per revolution). */
  rateHz: number;
  /** Amplitude modulation depth in [0, 1]. */
  depth: number;
  /** Optional resonator formant sweep center (Hz). */
  formantHz?: number;
  /** Instantaneous static vane aperture multiplier (0.15..1.25). */
  occlusionGain?: number;
}

export interface TriggerModalImpactOptions {
  ctx: AudioContext;
  outputBus: AudioNode;
  /** Owning scene body id (`node.id`) enabling in-place re-strike mutability and grab/damper choking. */
  nodeId?: string;
  /** Optional explicit pool key (defaults to `nodeId`, or unique ephemeral key if `nodeId` is omitted). */
  voiceGroupKey?: string;
  /** Overall dynamic strike/pluck amplitude in (0, 0.7]. */
  level: number;
  /** Two-body Hertzian contact duration τ_c (s). */
  tauC: number;
  /** Surface transient brightness in [0, 1]. */
  brightness: number;
  isPluck?: boolean;
  /** Suppresses the Hertzian plectrum/mallet click pulse (used for pure sympathetic string excitation). */
  skipClickPulse?: boolean;
  /** Custom modal attack time override (s, e.g. 0.045 s for sympathetic Weinreich bloom). */
  attackTimeSec?: number;
  /** Audible modes (analytical colored modes when no IR is present, or solid structural modes). */
  voices: ModalVoiceSpec[];
  /** Pure un-colored string modes routed through `bodyIr` on plucks to avoid double soundbox filtering! */
  rawIrVoices?: ModalVoiceSpec[];
  bodyIr?: Float32Array | null;
  bodyIrSig?: string;
  /** Optional wet FIR gain multiplier override. */
  bodyIrGain?: number;
  materialQ?: number;
  /** Normalized Legendre mode-shape vectors ψ_m(ξ) for spatial contact choking on solids. */
  modeVectors?: number[][];
  lenAxis?: 0 | 1 | 2;
  lenBounds?: [number, number];
  principalLenDir?: [number, number, number];
  principalOrigin?: [number, number, number];
  /** Normalized longitudinal hit coordinate ξ_hit in [-1, 1] on solids. */
  strikeXi?: number;
  /** Normalized string pluck/touch coordinate β in (0, 0.5]. */
  pluckBeta?: number;
  strikerMassKg?: number;
  bodyMassKg?: number;
  /** Stereo pan in [-1, 1] (Starter #6c). */
  pan?: number;
  /** Distance attenuation multiplier in (0, 1.5] (Starter #6c). */
  distanceGain?: number;
  /** Bottom-head snare wire rattle envelope (Starter #1). */
  snare?: SnareRattleParams;
  /** von Kármán nonlinear plate/gong crash cascade wash (Starter #4a). */
  crashShimmer?: CrashShimmerParams;
  /** Vibraphone rotating-vane tremolo modulation (Starter #5). */
  tremolo?: TremoloModulationParams;
  /** Optional simulation timestamp (s) when this modal voice was struck/plucked. */
  simTime?: number;
}

export interface ActiveModeState {
  osc: OscillatorNode;
  env: GainNode;
  baseFreqHz: number;
  modeIndex: number;
  anchorTime: number;
  anchorGain: number;
  peakGain: number;
  attackEndTime: number;
  tauSec: number;
  droopFrac: number;
  droopStartTime: number;
  droopTauSec: number;
}

export interface ActiveAuxEnvelopeState {
  env: GainNode;
  kind: 'shimmer' | 'snare';
  anchorTime: number;
  anchorGain: number;
  peakGain: number;
  attackEndTime: number;
  tauSec: number;
}

export interface ActiveModalVoiceGroup {
  key: string;
  nodeId: string;
  isPluck: boolean;
  master: GainNode;
  tremoloGain: GainNode | null;
  tremoloOsc: OscillatorNode | null;
  tremoloDepthGain: GainNode | null;
  tremoloFormant: BiquadFilterNode | null;
  panner: StereoPannerNode | null;
  dryGain: GainNode | null;
  irConv: ConvolverNode | null;
  irWetGain: GainNode | null;
  irSig: string;
  modes: ActiveModeState[];
  modeVectors?: number[][];
  lenAxis?: 0 | 1 | 2;
  lenBounds?: [number, number];
  principalLenDir?: [number, number, number];
  principalOrigin?: [number, number, number];
  shimmerEnv: GainNode | null;
  auxEnvelopes: Set<ActiveAuxEnvelopeState>;
  transientSources: Set<AudioScheduledSourceNode>;
  transientNodes: Set<AudioNode>;
  createdAtAudioTime: number;
  lastTriggeredAtAudioTime: number;
  lastTriggeredSimTime?: number;
  expiresAtAudioTime: number;
  pulsePeakGain: number;
  pulseDecayTauSec: number;
  pulseStartTime: number;
}

export interface ChokeVoiceOptions {
  /** 'grab' = viscoelastic human hand mute (~35-60 ms); 'contact' = physical damper / nodal finger touch. */
  mode?: 'grab' | 'contact';
  /** Additional modal decay rate Δα (1/s) when `mode === 'contact'`. */
  dampingRate?: number;
  normalForceN?: number;
  softness?: number;
  localPoint?: [number, number, number];
  /** Sustained contact duration (s) of this pair — contacts starting before/within 60 ms of strike never choke! */
  contactDurationSec?: number;
  /** Explicit simulation timestamp (s) when this contact began, if known. */
  contactStartedAtSimTime?: number;
  /** Current simulation timestamp (s) for comparing `contactDurationSec` against `lastTriggeredSimTime`. */
  currentSimTime?: number;
  targetNode?: SceneNode | null;
  sceneNodes?: SceneNode[];
}

export interface ModalVoicePoolStats {
  activeGroups: number;
  activeOscillators: number;
  activeConvolvers: number;
  cachedIrBuffers: number;
  groupKeys: string[];
}

const MAX_CACHED_CLICK_BUFFERS = 48;

interface ContextModalBank {
  groups: Map<string, ActiveModalVoiceGroup>;
  irBufferCache: Map<string, AudioBuffer>;
  clickBufferCache: Map<string, AudioBuffer>;
  noiseBuffer: AudioBuffer | null;
  ephemeralCounter: number;
  sweepTimer: ReturnType<typeof setInterval> | null;
  activeSympatheticKeys: Set<string>;
}

const banksByContext = new WeakMap<AudioContext, ContextModalBank>();
let lastKnownAudioCtx: AudioContext | null = null;

function getBank(ctx: AudioContext): ContextModalBank {
  lastKnownAudioCtx = ctx;
  let bank = banksByContext.get(ctx);
  if (!bank) {
    bank = {
      groups: new Map(),
      irBufferCache: new Map(),
      clickBufferCache: new Map(),
      noiseBuffer: null,
      ephemeralCounter: 0,
      sweepTimer: null,
      activeSympatheticKeys: new Set(),
    };
    banksByContext.set(ctx, bank);
  }
  return bank;
}

function clampSafeFreq(freqHz: number, sampleRate: number, minHz = 18): number {
  if (!Number.isFinite(freqHz)) return 440;
  const nyquistSafe = Math.max(minHz + 10, sampleRate * 0.475);
  return Math.max(minHz, Math.min(nyquistSafe, freqHz));
}

function cancelParam(param: AudioParam, now: number): void {
  const p = param as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };
  if (typeof p.cancelAndHoldAtTime === 'function') {
    try {
      p.cancelAndHoldAtTime(now);
      return;
    } catch {
      // Fall back to cancelScheduledValues
    }
  }
  try {
    param.cancelScheduledValues(now);
  } catch {
    // Ignore in minimal mock contexts
  }
}

/**
 * Sanitizes (`NaN`/`Inf` -> 0), resamples `ir48k` to `targetSampleRate`, and scales taps by
 * `sourceSampleRate / targetSampleRate` so discrete WebAudio `ConvolverNode` gain stays
 * invariant across 44.1 kHz, 48 kHz, and 96 kHz! Returns `null` if energy is zero/poisoned.
 */
export function sanitizeAndResampleIrSamples(
  ir48k: Float32Array,
  targetSampleRate: number,
  sourceSampleRate = 48000,
): Float32Array<ArrayBuffer> | null {
  if (!ir48k || ir48k.length === 0) return null;
  const srTarget = Number.isFinite(targetSampleRate) && targetSampleRate >= 8000 ? targetSampleRate : 48000;
  const srSource = Number.isFinite(sourceSampleRate) && sourceSampleRate >= 8000 ? sourceSampleRate : 48000;
  // Continuous-time convolution invariance dτ = 1 / srTarget requires tap scaling by srSource / srTarget!
  const rateGainScale = srSource / srTarget;

  // Fast single-allocation path when source and target sample rates match (99% 48 kHz case!)
  if (Math.abs(srTarget - srSource) < 1) {
    const out = new Float32Array(new ArrayBuffer(ir48k.length * 4));
    let energySq = 0;
    for (let i = 0; i < ir48k.length; i++) {
      const v = ir48k[i];
      const safe = Number.isFinite(v) ? (v < -2.0 ? -2.0 : v > 2.0 ? 2.0 : v) : 0;
      const scaled = safe * rateGainScale;
      out[i] = scaled;
      energySq += safe * safe;
    }
    return energySq > 1e-16 ? out : null;
  }

  // Sanitize source samples first so not a single NaN/Inf can ever enter linear interpolation
  const cleanSrc = new Float32Array(ir48k.length);
  let energySq = 0;
  for (let i = 0; i < ir48k.length; i++) {
    const v = ir48k[i];
    const safe = Number.isFinite(v) ? (v < -2.0 ? -2.0 : v > 2.0 ? 2.0 : v) : 0;
    cleanSrc[i] = safe;
    energySq += safe * safe;
  }
  if (!(energySq > 1e-16)) return null;

  const outLen = Math.max(64, Math.round((cleanSrc.length * srTarget) / srSource));
  const out = new Float32Array(new ArrayBuffer(outLen * 4));
  const ratio = srSource / srTarget;
  const maxIdx = cleanSrc.length - 1;
  let outEnergySq = 0;
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio;
    const i0 = Math.min(maxIdx, Math.floor(srcPos));
    const i1 = Math.min(maxIdx, i0 + 1);
    const frac = srcPos - i0;
    const val = (cleanSrc[i0] + (cleanSrc[i1] - cleanSrc[i0]) * frac) * rateGainScale;
    const safeVal = Number.isFinite(val) ? val : 0;
    out[i] = safeVal;
    outEnergySq += safeVal * safeVal;
  }
  return outEnergySq > 1e-16 ? out : null;
}

function getOrCreateCachedIrBuffer(
  ctx: AudioContext,
  bank: ContextModalBank,
  ir48k: Float32Array,
  irSig?: string,
): AudioBuffer | null {
  if (typeof ctx.createBuffer !== 'function') return null;
  const sr = ctx.sampleRate || 48000;
  const cacheKey = irSig ? `${sr}:${irSig}` : '';
  if (cacheKey) {
    const cached = bank.irBufferCache.get(cacheKey);
    if (cached) {
      // Refresh LRU insertion order
      bank.irBufferCache.delete(cacheKey);
      bank.irBufferCache.set(cacheKey, cached);
      return cached;
    }
  }

  const samples = sanitizeAndResampleIrSamples(ir48k, sr, 48000);
  if (!samples) return null;

  try {
    const buf = ctx.createBuffer(1, samples.length, sr);
    buf.getChannelData(0).set(samples);
    if (cacheKey) {
      if (bank.irBufferCache.size >= MAX_CACHED_IR_BUFFERS) {
        const oldest = bank.irBufferCache.keys().next().value;
        if (oldest !== undefined) bank.irBufferCache.delete(oldest);
      }
      bank.irBufferCache.set(cacheKey, buf);
    }
    return buf;
  } catch {
    return null;
  }
}

function createPooledConvolver(
  ctx: AudioContext,
  bank: ContextModalBank,
  ir48k: Float32Array,
  irSig?: string,
): ConvolverNode | null {
  if (typeof ctx.createConvolver !== 'function') return null;
  const buf = getOrCreateCachedIrBuffer(ctx, bank, ir48k, irSig);
  if (!buf) return null;
  try {
    const conv = ctx.createConvolver();
    conv.normalize = false;
    conv.buffer = buf;
    return conv;
  } catch {
    return null;
  }
}

function getSharedNoiseBuffer(ctx: AudioContext, bank: ContextModalBank): AudioBuffer | null {
  if (bank.noiseBuffer) return bank.noiseBuffer;
  if (typeof ctx.createBuffer !== 'function') return null;
  const sr = ctx.sampleRate || 48000;
  const len = Math.floor(sr * 1.5);
  const buf = ctx.createBuffer(1, len, sr);
  const ch = buf.getChannelData(0);
  let seed = 0x6d2b79f5;
  for (let i = 0; i < len; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    ch[i] = seed / 2147483648;
  }
  bank.noiseBuffer = buf;
  return buf;
}

/** Evaluates analytic instantaneous mode amplitude A_m(t) at AudioContext time `now`. */
export function evaluateModeAmplitudeAt(mode: ActiveModeState, now: number): number {
  if (now <= mode.anchorTime) return Math.max(0, mode.anchorGain);
  if (now < mode.attackEndTime) {
    const span = Math.max(1e-5, mode.attackEndTime - mode.anchorTime);
    const u = Math.max(0, Math.min(1, (now - mode.anchorTime) / span));
    return Math.max(0, mode.anchorGain + (mode.peakGain - mode.anchorGain) * u);
  }
  const dt = now - mode.attackEndTime;
  return Math.max(0, mode.peakGain * Math.exp(-dt / Math.max(0.004, mode.tauSec)));
}

/** Evaluates analytic instantaneous auxiliary envelope amplitude (crash shimmer / snare rattle) at `now`. */
export function evaluateAuxEnvelopeAmplitudeAt(aux: ActiveAuxEnvelopeState, now: number): number {
  if (now <= aux.anchorTime) return Math.max(0, aux.anchorGain);
  if (now < aux.attackEndTime) {
    const span = Math.max(1e-5, aux.attackEndTime - aux.anchorTime);
    const u = Math.max(0, Math.min(1, (now - aux.anchorTime) / span));
    return Math.max(0, aux.anchorGain + (aux.peakGain - aux.anchorGain) * u);
  }
  const dt = now - aux.attackEndTime;
  return Math.max(0, aux.peakGain * Math.exp(-dt / Math.max(0.004, aux.tauSec)));
}

/**
 * Pure worker impact gate distinguishing a gentle viscoelastic felt/rubber damper press
 * (`softness >= 0.85 && damperSolDamp >= 0.85`, e.g. `vibe_damper_bar` or `cymbal_choke_arm`)
 * from an elastic/ballistic mallet or dropped-ball strike (`solDamp < 0.85` or high closing speed).
 */
export function isCriticallyDampedDamperPress(
  damperSoftness: number,
  damperSolDamp: number,
  relSpeedMps: number,
  effImpulseNs: number,
  damperMassKg: number,
): boolean {
  if (!(damperSoftness >= 0.85 && damperSolDamp >= 0.85)) return false;
  if (!(effImpulseNs < 0.08)) return false;
  const approxClosingSpeed = Math.max(
    Math.max(0, relSpeedMps),
    effImpulseNs / Math.max(0.02, damperMassKg),
  );
  return approxClosingSpeed < 0.65;
}

function evaluateGroupInstantLoudness(group: ActiveModalVoiceGroup, now: number): number {
  let modeSum = 0;
  for (const m of group.modes) {
    modeSum += evaluateModeAmplitudeAt(m, now);
  }
  let auxSum = 0;
  for (const aux of group.auxEnvelopes) {
    auxSum += evaluateAuxEnvelopeAmplitudeAt(aux, now);
  }
  const pulseDt = Math.max(0, now - group.pulseStartTime);
  const pulseCur = group.pulsePeakGain * Math.exp(-pulseDt / Math.max(0.004, group.pulseDecayTauSec));
  return Math.max(pulseCur, modeSum + auxSum);
}

function destroyVoiceGroup(bank: ContextModalBank, group: ActiveModalVoiceGroup): void {
  bank.groups.delete(group.key);
  bank.activeSympatheticKeys.delete(group.key);

  for (const m of group.modes) {
    try { m.osc.stop(); } catch { /* already stopped */ }
    try { m.osc.disconnect(); } catch { /* ignore */ }
    try { m.env.disconnect(); } catch { /* ignore */ }
  }
  group.modes.length = 0;
  group.auxEnvelopes.clear();
  group.shimmerEnv = null;

  for (const src of group.transientSources) {
    try { src.stop(); } catch { /* ignore */ }
    try { src.disconnect(); } catch { /* ignore */ }
  }
  group.transientSources.clear();

  for (const nd of group.transientNodes) {
    try { nd.disconnect(); } catch { /* ignore */ }
  }
  group.transientNodes.clear();

  if (group.tremoloOsc) {
    try { group.tremoloOsc.stop(); } catch { /* ignore */ }
    try { group.tremoloOsc.disconnect(); } catch { /* ignore */ }
  }
  try { group.tremoloDepthGain?.disconnect(); } catch { /* ignore */ }
  try { group.tremoloFormant?.disconnect(); } catch { /* ignore */ }
  try { group.tremoloGain?.disconnect(); } catch { /* ignore */ }
  try { group.dryGain?.disconnect(); } catch { /* ignore */ }
  try { group.irConv?.disconnect(); } catch { /* ignore */ }
  try { group.irWetGain?.disconnect(); } catch { /* ignore */ }
  try { group.panner?.disconnect(); } catch { /* ignore */ }
  try { group.master.disconnect(); } catch { /* ignore */ }

  if (bank.groups.size === 0 && bank.sweepTimer !== null) {
    clearInterval(bank.sweepTimer);
    bank.sweepTimer = null;
  }
}

/** Sweeps any voice groups whose `ctx.currentTime` has passed `expiresAtAudioTime` (safe on suspended contexts!). */
export function sweepExpiredVoiceGroups(ctx: AudioContext): void {
  const bank = banksByContext.get(ctx);
  if (!bank || bank.groups.size === 0) return;
  const now = ctx.currentTime;
  for (const group of bank.groups.values()) {
    if (now >= group.expiresAtAudioTime) {
      destroyVoiceGroup(bank, group);
    }
  }
}

function ensureSweepTimer(ctx: AudioContext, bank: ContextModalBank): void {
  if (bank.sweepTimer !== null) return;
  bank.sweepTimer = setInterval(() => {
    if (ctx.state === 'closed') {
      for (const g of Array.from(bank.groups.values())) destroyVoiceGroup(bank, g);
      if (bank.sweepTimer !== null) {
        clearInterval(bank.sweepTimer);
        bank.sweepTimer = null;
      }
      return;
    }
    sweepExpiredVoiceGroups(ctx);
  }, 120);
}

function countPoolTotals(bank: ContextModalBank): { oscCount: number; convCount: number } {
  let oscCount = 0;
  let convCount = 0;
  for (const g of bank.groups.values()) {
    oscCount += g.modes.length;
    if (g.irConv) convCount++;
  }
  return { oscCount, convCount };
}

function quickStealGroup(ctx: AudioContext, bank: ContextModalBank, victim: ActiveModalVoiceGroup): void {
  // Immediately disconnect & free victim resources after ramping master to 0 if possible
  const now = ctx.currentTime;
  cancelParam(victim.master.gain, now);
  try {
    victim.master.gain.setValueAtTime(0, now);
  } catch {
    // Ignore
  }
  destroyVoiceGroup(bank, victim);
}

function enforcePoolBudget(
  ctx: AudioContext,
  bank: ContextModalBank,
  neededOsc: number,
  needConvolver: boolean,
  incomingEnergy: number,
  protectedKey: string,
): boolean {
  let { oscCount, convCount } = countPoolTotals(bank);

  const needsEviction = () =>
    bank.groups.size >= MAX_ACTIVE_IMPACTS ||
    (needConvolver && convCount >= MAX_ACTIVE_CONVOLVERS) ||
    oscCount + neededOsc > MAX_ACTIVE_OSCILLATORS;

  if (!needsEviction()) return true;

  const now = ctx.currentTime;
  const candidates = Array.from(bank.groups.values())
    .filter((g) => g.key !== protectedKey)
    .map((g) => ({
      group: g,
      // Sympathetic background voices yield preferentially before primary struck voices
      score: evaluateGroupInstantLoudness(g, now) * (g.key.endsWith(':symp') ? 0.35 : 1.0),
    }))
    .sort((a, b) => a.score - b.score);

  for (const cand of candidates) {
    if (!needsEviction()) break;
    // If needConvolver specifically, prefer stealing a group that actually owns a ConvolverNode when group/osc caps aren't exceeded
    const onlyConvShortage =
      bank.groups.size < MAX_ACTIVE_IMPACTS &&
      oscCount + neededOsc <= MAX_ACTIVE_OSCILLATORS &&
      needConvolver &&
      convCount >= MAX_ACTIVE_CONVOLVERS;
    if (onlyConvShortage && !cand.group.irConv) continue;

    // Never let a microscopic background brush steal a 4x louder foreground fortissimo strike unless >85% decayed
    if (cand.score > incomingEnergy * 4.0 && cand.score > 0.08) continue;

    const victimOscs = cand.group.modes.length;
    const victimHadConv = cand.group.irConv !== null;
    quickStealGroup(ctx, bank, cand.group);
    oscCount -= victimOscs;
    if (victimHadConv) convCount--;
  }

  // Fallback pass if `onlyConvShortage` skipped non-convolver groups or vice versa
  if (needsEviction()) {
    for (const cand of candidates) {
      if (!bank.groups.has(cand.group.key)) continue;
      if (!needsEviction()) break;
      if (cand.score > incomingEnergy * 6.0 && cand.score > 0.15) continue;
      const victimOscs = cand.group.modes.length;
      const victimHadConv = cand.group.irConv !== null;
      quickStealGroup(ctx, bank, cand.group);
      oscCount -= victimOscs;
      if (victimHadConv) convCount--;
    }
  }

  return (
    bank.groups.size < MAX_ACTIVE_IMPACTS &&
    (!needConvolver || convCount < MAX_ACTIVE_CONVOLVERS)
  );
}

function resolvePitchShiftFrac(m: ModalVoiceSpec): number {
  if (m.pitchDroopFrac !== undefined && Number.isFinite(m.pitchDroopFrac) && Math.abs(m.pitchDroopFrac) > 1e-5) {
    return Math.max(-0.45, Math.min(0.65, m.pitchDroopFrac));
  }
  if (m.pitchGlideCents !== undefined && Number.isFinite(m.pitchGlideCents) && Math.abs(m.pitchGlideCents) > 0.05) {
    return Math.max(-0.45, Math.min(0.65, Math.pow(2, m.pitchGlideCents / 1200) - 1));
  }
  return 0;
}

function scheduleModeEnvelopeAndPitch(
  state: ActiveModeState,
  spec: ModalVoiceSpec,
  targetPeakGain: number,
  survivingGain: number,
  curGain: number,
  now: number,
  defaultAttackSec: number,
  sampleRate: number,
): number {
  const bloomDelay = spec.bloomDelaySec && spec.bloomDelaySec > 0 ? Math.min(0.35, spec.bloomDelaySec) : 0;
  const atkDur = Math.max(0.0008, spec.bloomAttackSec ?? defaultAttackSec);
  const tStart = now + bloomDelay;
  const tAtk = tStart + atkDur;
  const rawDur = Math.min(4.2, Math.max(atkDur + 0.018, spec.decaySec));
  const tEnd = tStart + rawDur;
  const tauSec = Math.max(0.005, (rawDur - atkDur) / LN_10000);
  const safePeak = Math.max(0.0002, Math.min(1.35, targetPeakGain));
  const safeCur = Math.max(0.0001, curGain);
  const safeSurv = Math.max(0.0001, Math.min(safeCur, survivingGain));

  cancelParam(state.env.gain, now);
  state.env.gain.setValueAtTime(safeCur, now);
  if (bloomDelay > 0.001) {
    state.env.gain.linearRampToValueAtTime(safeSurv, tStart);
  } else if (safeSurv < safeCur * 0.85 && atkDur >= 0.0012) {
    state.env.gain.linearRampToValueAtTime(safeSurv, now + atkDur * 0.35);
  }
  state.env.gain.linearRampToValueAtTime(safePeak, tAtk);
  state.env.gain.exponentialRampToValueAtTime(0.0001, tEnd);
  state.env.gain.linearRampToValueAtTime(0, tEnd + 0.008);

  state.anchorTime = tStart;
  state.anchorGain = safeSurv;
  state.peakGain = safePeak;
  state.attackEndTime = tAtk;
  state.tauSec = tauSec;

  // Nonlinear tension-modulation / membrane / von Kármán pitch glide!
  const baseHz = clampSafeFreq(spec.freqHz, sampleRate);
  state.baseFreqHz = baseHz;
  const newDroopFrac = resolvePitchShiftFrac(spec);
  // Combine any residual in-flight upward pitch droop with fresh pluck droop in quadrature
  const prevRemDroop =
    state.droopFrac > 0 && now > state.droopStartTime
      ? state.droopFrac * Math.exp(-(now - state.droopStartTime) / Math.max(0.008, state.droopTauSec))
      : 0;
  const combinedDroop =
    newDroopFrac >= 0
      ? Math.min(0.65, Math.hypot(prevRemDroop, newDroopFrac))
      : newDroopFrac;

  cancelParam(state.osc.frequency, now);
  if (Math.abs(combinedDroop) > 0.0004) {
    const startHz = clampSafeFreq(baseHz * (1 + combinedDroop), sampleRate);
    const droopTau = Math.max(0.012, Math.min(0.45, spec.pitchDroopTauSec ?? tauSec * 0.5));
    state.osc.frequency.setValueAtTime(startHz, now);
    state.osc.frequency.setTargetAtTime(baseHz, tStart + atkDur * 0.4, droopTau);
    state.droopFrac = combinedDroop;
    state.droopStartTime = now;
    state.droopTauSec = droopTau;
  } else {
    state.osc.frequency.setValueAtTime(baseHz, now);
    state.droopFrac = 0;
  }

  return tEnd + 0.012;
}

function getOrCreateCachedClickPulseBuffer(
  ctx: AudioContext,
  bank: ContextModalBank,
  tauC: number,
  brightness: number,
  isZeroVoice: boolean,
): { buffer: AudioBuffer; totalPulseDur: number } {
  const sr = ctx.sampleRate || 48000;
  // Quantize tauC in ~4% log steps and brightness in 0.05 steps so rapid rolls reuse precomputed AudioBuffers!
  const qTauIdx = Math.round(Math.log(tauC / 0.00025) / 0.04);
  const qTau = Math.max(0.00025, Math.min(0.012, 0.00025 * Math.exp(qTauIdx * 0.04)));
  const qBright = Math.round(Math.max(0, Math.min(1, brightness)) * 20) / 20;
  const totalPulseDur = Math.max(0.012, qTau * 9);
  const key = `${sr}:${qTauIdx}:${qBright}:${isZeroVoice ? 1 : 0}`;

  const cached = bank.clickBufferCache.get(key);
  if (cached) {
    bank.clickBufferCache.delete(key);
    bank.clickBufferCache.set(key, cached);
    return { buffer: cached, totalPulseDur };
  }

  const sampleCount = Math.max(64, Math.ceil(sr * totalPulseDur));
  const pulseBuf = ctx.createBuffer(1, sampleCount, sr);
  const data = pulseBuf.getChannelData(0);
  const invSr = 1 / sr;
  const invTau = 1 / qTau;
  const piOverTau = Math.PI * invTau;
  const sampleScale = isZeroVoice ? 1.0 : 0.72;
  const brightTexScale = 0.025 * qBright;
  const texMul = Math.exp(-invSr / (qTau * 1.8));
  const postDecMul = Math.exp((-1.2 * invSr) * invTau);
  const tauSamples = Math.min(sampleCount, Math.ceil(qTau * sr));

  let seed = ((qTauIdx * 2654435761) ^ (sampleCount * 7919) ^ 0x5bd1e995) | 1;
  let texEnv = 1.0;
  for (let i = 0; i < tauSamples; i++) {
    const u = i * invSr * piOverTau;
    const sinU = Math.sin(u);
    const sample = 1.2 * Math.sqrt(sinU > 0 ? sinU : 0) * Math.cos(u);
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    data[i] = sample * sampleScale + brightTexScale * (seed / 2147483648) * texEnv;
    texEnv *= texMul;
  }
  let postDec = tauSamples < sampleCount ? Math.exp(-((tauSamples * invSr - qTau) * invTau) * 1.2) : 0;
  for (let i = tauSamples; i < sampleCount; i++) {
    const dt = (i * invSr - qTau) * invTau;
    const sample = -0.32 * postDec * Math.cos(1.5 * dt);
    postDec *= postDecMul;
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    data[i] = sample * sampleScale + brightTexScale * (seed / 2147483648) * texEnv;
    texEnv *= texMul;
  }

  if (bank.clickBufferCache.size >= MAX_CACHED_CLICK_BUFFERS) {
    const oldest = bank.clickBufferCache.keys().next().value;
    if (oldest !== undefined) bank.clickBufferCache.delete(oldest);
  }
  bank.clickBufferCache.set(key, pulseBuf);
  return { buffer: pulseBuf, totalPulseDur };
}

function attachHertzianClickPulse(
  ctx: AudioContext,
  bank: ContextModalBank,
  group: ActiveModalVoiceGroup,
  opts: TriggerModalImpactOptions,
  now: number,
  effectiveVoiceCount: number,
): number {
  if (opts.skipClickPulse || typeof ctx.createBuffer !== 'function' || typeof ctx.createBufferSource !== 'function') {
    return now + 0.02;
  }
  const sr = ctx.sampleRate || 48000;
  const tauC = Math.max(0.00025, Math.min(0.012, opts.tauC));
  const { buffer: pulseBuf, totalPulseDur } = getOrCreateCachedClickPulseBuffer(
    ctx,
    bank,
    tauC,
    opts.brightness,
    effectiveVoiceCount === 0,
  );

  const pulseSrc = ctx.createBufferSource();
  pulseSrc.buffer = pulseBuf;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  const hertzCutoffHz = clampSafeFreq(
    Math.max(300, Math.min(4600, (0.82 / tauC) * (0.55 + 0.65 * opts.brightness))),
    sr,
    80,
  );
  lp.frequency.setValueAtTime(hertzCutoffHz, now);
  lp.Q.setValueAtTime(0.75, now);

  const clickGain = ctx.createGain();
  const pulseWeight =
    effectiveVoiceCount === 0
      ? 1.45
      : opts.isPluck
        ? 0.04 + 0.08 * opts.brightness
        : 0.018 + 0.052 * Math.pow(Math.max(0, opts.brightness), 1.35);
  const clickAmp = Math.min(0.85, opts.level * pulseWeight);
  clickGain.gain.setValueAtTime(clickAmp, now);

  const targetNode = group.panner ?? group.tremoloGain ?? group.master;
  pulseSrc.connect(lp);
  lp.connect(clickGain);
  clickGain.connect(targetNode);

  // For struck hollow 3D soundboxes/shells (`!isPluck` & `group.irConv`), route the level-scaled `clickGain`
  // (NEVER raw unscaled `lp`!) into `group.irConv` so cavity excitation scales proportionally with `opts.level`!
  let irTailSec = 0;
  if (group.irConv && !opts.isPluck) {
    clickGain.connect(group.irConv);
    irTailSec = 0.095;
  }

  group.transientSources.add(pulseSrc);
  group.transientNodes.add(lp);
  group.transientNodes.add(clickGain);
  group.pulsePeakGain = clickAmp;
  group.pulseStartTime = now;
  group.pulseDecayTauSec = tauC * 2.5;

  pulseSrc.onended = () => {
    group.transientSources.delete(pulseSrc);
    group.transientNodes.delete(lp);
    group.transientNodes.delete(clickGain);
    try { pulseSrc.disconnect(); } catch { /* ignore */ }
    try { lp.disconnect(); } catch { /* ignore */ }
    try { clickGain.disconnect(); } catch { /* ignore */ }
  };
  pulseSrc.start(now);

  return now + totalPulseDur + irTailSec + 0.02;
}

function attachSnareRattle(
  ctx: AudioContext,
  bank: ContextModalBank,
  group: ActiveModalVoiceGroup,
  snare: SnareRattleParams,
  level: number,
  now: number,
): number {
  if (!(snare.gain > 0.002) || typeof ctx.createBufferSource !== 'function') return now;
  const noiseBuf = getSharedNoiseBuffer(ctx, bank);
  if (!noiseBuf) return now;

  const sr = ctx.sampleRate || 48000;
  const dur = Math.max(0.04, Math.min(0.8, snare.decaySec));
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;

  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(clampSafeFreq(snare.centerHz ?? 3200, sr, 200), now);
  bp.Q.setValueAtTime(1.1, now);

  const env = ctx.createGain();
  const bloom = 0.006;
  const peak = Math.min(0.45, level * snare.gain * 0.55);
  env.gain.setValueAtTime(0.0001, now);
  env.gain.linearRampToValueAtTime(peak, now + bloom);
  env.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  env.gain.linearRampToValueAtTime(0, now + dur + 0.006);

  src.connect(bp);
  bp.connect(env);
  env.connect(group.master);

  const auxState: ActiveAuxEnvelopeState = {
    env,
    kind: 'snare',
    anchorTime: now,
    anchorGain: 0.0001,
    peakGain: peak,
    attackEndTime: now + bloom,
    tauSec: Math.max(0.005, (dur - bloom) / Math.max(1e-4, Math.log(Math.max(1.0002, peak / 0.0001)))),
  };
  group.auxEnvelopes.add(auxState);
  group.transientSources.add(src);
  group.transientNodes.add(bp);
  group.transientNodes.add(env);

  src.onended = () => {
    group.auxEnvelopes.delete(auxState);
    group.transientSources.delete(src);
    group.transientNodes.delete(bp);
    group.transientNodes.delete(env);
    try { src.disconnect(); } catch { /* ignore */ }
    try { bp.disconnect(); } catch { /* ignore */ }
    try { env.disconnect(); } catch { /* ignore */ }
  };
  src.start(now);
  src.stop(now + dur + 0.01);
  return now + dur + 0.02;
}

function attachCrashShimmer(
  ctx: AudioContext,
  bank: ContextModalBank,
  group: ActiveModalVoiceGroup,
  shimmer: CrashShimmerParams,
  level: number,
  now: number,
): number {
  if (!(shimmer.gain > 0.002) || typeof ctx.createBufferSource !== 'function') return now;
  const noiseBuf = getSharedNoiseBuffer(ctx, bank);
  if (!noiseBuf) return now;

  const sr = ctx.sampleRate || 48000;
  const bloom = Math.max(0.015, Math.min(0.30, shimmer.bloomSec));
  const dur = Math.max(bloom + 0.05, Math.min(3.5, shimmer.decaySec));
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;

  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.setValueAtTime(clampSafeFreq(shimmer.highpassHz ?? 2800, sr, 300), now);
  hp.Q.setValueAtTime(0.7, now);

  const env = ctx.createGain();
  const peak = Math.min(0.38, level * shimmer.gain * 0.42);
  env.gain.setValueAtTime(0.0001, now);
  env.gain.linearRampToValueAtTime(peak, now + bloom);
  env.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  env.gain.linearRampToValueAtTime(0, now + dur + 0.008);

  src.connect(hp);
  hp.connect(env);
  env.connect(group.master);

  const auxState: ActiveAuxEnvelopeState = {
    env,
    kind: 'shimmer',
    anchorTime: now,
    anchorGain: 0.0001,
    peakGain: peak,
    attackEndTime: now + bloom,
    tauSec: Math.max(0.005, (dur - bloom) / Math.max(1e-4, Math.log(Math.max(1.0002, peak / 0.0001)))),
  };
  group.shimmerEnv = env;
  group.auxEnvelopes.add(auxState);
  group.transientSources.add(src);
  group.transientNodes.add(hp);
  group.transientNodes.add(env);

  src.onended = () => {
    group.auxEnvelopes.delete(auxState);
    if (group.shimmerEnv === env) group.shimmerEnv = null;
    group.transientSources.delete(src);
    group.transientNodes.delete(hp);
    group.transientNodes.delete(env);
    try { src.disconnect(); } catch { /* ignore */ }
    try { hp.disconnect(); } catch { /* ignore */ }
    try { env.disconnect(); } catch { /* ignore */ }
  };
  src.start(now);
  src.stop(now + dur + 0.012);
  return now + dur + 0.025;
}

function configureTremoloStage(
  ctx: AudioContext,
  group: ActiveModalVoiceGroup,
  tremolo: TremoloModulationParams | undefined,
  now: number,
): void {
  if (!tremolo || (!(tremolo.depth > 0.005) && tremolo.occlusionGain === undefined)) {
    if (group.tremoloDepthGain) {
      cancelParam(group.tremoloDepthGain.gain, now);
      group.tremoloDepthGain.gain.setTargetAtTime(0, now, 0.015);
    }
    if (group.tremoloGain) {
      cancelParam(group.tremoloGain.gain, now);
      group.tremoloGain.gain.setTargetAtTime(1.0, now, 0.015);
    }
    return;
  }

  const baseOcc = Math.max(0.15, Math.min(1.3, tremolo.occlusionGain ?? (1 - 0.38 * tremolo.depth)));
  const depthAmp = Math.max(0, Math.min(0.55, 0.45 * tremolo.depth));
  const rateHz = Math.max(0.2, Math.min(28, tremolo.rateHz || 5.5));

  if (group.tremoloGain) {
    cancelParam(group.tremoloGain.gain, now);
    group.tremoloGain.gain.setTargetAtTime(baseOcc, now, 0.015);
  }
  if (group.tremoloOsc && group.tremoloDepthGain) {
    cancelParam(group.tremoloOsc.frequency, now);
    group.tremoloOsc.frequency.setTargetAtTime(rateHz, now, 0.020);
    cancelParam(group.tremoloDepthGain.gain, now);
    group.tremoloDepthGain.gain.setTargetAtTime(depthAmp, now, 0.018);
  }
  if (group.tremoloFormant && tremolo.formantHz) {
    const sr = ctx.sampleRate || 48000;
    cancelParam(group.tremoloFormant.frequency, now);
    group.tremoloFormant.frequency.setTargetAtTime(clampSafeFreq(tremolo.formantHz, sr, 60), now, 0.020);
  }
}

function computeSpatialParticipationSq(
  modeIndex: number,
  isPluck: boolean,
  pluckBeta: number | undefined,
  strikeXi: number | undefined,
  modeVectors: number[][] | undefined,
): number {
  if (isPluck && pluckBeta !== undefined && Number.isFinite(pluckBeta)) {
    const s = Math.sin((modeIndex + 1) * Math.PI * pluckBeta);
    return s * s;
  }
  if (strikeXi !== undefined && Number.isFinite(strikeXi) && modeVectors && modeVectors[modeIndex]) {
    const psi = evaluateNormalizedModeShape(modeVectors[modeIndex], strikeXi);
    return Math.min(1, psi * psi);
  }
  return 0.65;
}

/**
 * Triggers a new bounded `ActiveModalVoiceGroup` or physically mutates an already-ringing
 * `nodeId` group in place (choking non-nodal partials by spatial participation & combining
 * surviving + fresh strike energy in quadrature with ZERO duplicate oscillators or convolvers!).
 */
export function triggerOrMutateModalVoice(opts: TriggerModalImpactOptions): ActiveModalVoiceGroup | null {
  const { ctx, outputBus } = opts;
  if (!ctx || !outputBus || !(opts.level >= 0.002) || !Number.isFinite(opts.level)) return null;

  const bank = getBank(ctx);
  sweepExpiredVoiceGroups(ctx);

  const sr = ctx.sampleRate || 48000;
  const now = ctx.currentTime;
  const nyquistLimit = sr * 0.475;

  const wantIr = !!(opts.bodyIr && opts.bodyIr.length > 0);
  // On plucked strings with a 3D body IR, feed un-colored `rawIrVoices` into the ConvolverNode (zero double-filtering!)
  const sourceSpecs =
    opts.isPluck && wantIr && opts.rawIrVoices && opts.rawIrVoices.length > 0
      ? opts.rawIrVoices
      : opts.voices;

  const validSpecs = sourceSpecs.filter(
    (m) =>
      Number.isFinite(m.freqHz) &&
      m.freqHz >= 18 &&
      m.freqHz < nyquistLimit &&
      Number.isFinite(m.gain) &&
      m.gain >= 0.0008,
  );

  const groupKey =
    opts.voiceGroupKey ??
    (opts.nodeId ? opts.nodeId : `__ephemeral_${++bank.ephemeralCounter}`);
  const existing = opts.nodeId || opts.voiceGroupKey ? bank.groups.get(groupKey) : undefined;

  const minMalletAttack = opts.brightness <= 0.48 ? 0.0024 : 0.0016;
  const defaultAttackSec =
    opts.attackTimeSec ??
    (opts.isPluck ? 0.0014 : Math.max(minMalletAttack, Math.min(0.0040, opts.tauC * 1.45)));
  const distScale = opts.distanceGain !== undefined && Number.isFinite(opts.distanceGain)
    ? Math.max(0.02, Math.min(1.5, opts.distanceGain))
    : 1.0;

  // Striker-to-body contact absorption ratio η_choke in [0.25, 0.92] (0 for pure sympathetic energy injection!)
  let etaChoke = opts.skipClickPulse ? 0 : 0.55;
  if (!opts.skipClickPulse && opts.strikerMassKg && opts.bodyMassKg && opts.bodyMassKg > 0) {
    const mEff = 0.5 * opts.bodyMassKg;
    etaChoke = Math.max(0.25, Math.min(0.92, opts.strikerMassKg / (opts.strikerMassKg + mEff)));
  }

  // ---- PATH A: Mutate existing ringing group for `nodeId` in place! ---------
  if (existing && now < existing.expiresAtAudioTime) {
    cancelParam(existing.master.gain, now);
    existing.master.gain.setValueAtTime(distScale, now);
    if (existing.panner && opts.pan !== undefined && Number.isFinite(opts.pan)) {
      cancelParam(existing.panner.pan, now);
      existing.panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, opts.pan)), now, 0.012);
    }
    if (opts.modeVectors) existing.modeVectors = opts.modeVectors;
    if (opts.lenAxis !== undefined) existing.lenAxis = opts.lenAxis;
    if (opts.lenBounds) existing.lenBounds = opts.lenBounds;
    if (opts.principalLenDir) existing.principalLenDir = opts.principalLenDir;
    if (opts.principalOrigin) existing.principalOrigin = opts.principalOrigin;
    if (!opts.skipClickPulse) {
      existing.lastTriggeredAtAudioTime = now;
      if (opts.simTime !== undefined && Number.isFinite(opts.simTime)) {
        existing.lastTriggeredSimTime = opts.simTime;
      }
    }
    configureTremoloStage(ctx, existing, opts.tremolo, now);

    // Hot-swap body IR only if geometry/sculpt signature actually changed
    if (wantIr && opts.bodyIr && opts.bodyIrSig && existing.irSig !== opts.bodyIrSig) {
      const nextConv = createPooledConvolver(ctx, bank, opts.bodyIr, opts.bodyIrSig);
      if (nextConv) {
        try { existing.irConv?.disconnect(); } catch { /* ignore */ }
        existing.irConv = nextConv;
        existing.irSig = opts.bodyIrSig;
        if (existing.irWetGain) {
          if (opts.isPluck) existing.master.connect(nextConv);
          nextConv.connect(existing.irWetGain);
        }
      }
    }

    let maxEnd = now + 0.06;
    const countToMatch = Math.max(existing.modes.length, validSpecs.length);
    const { oscCount } = countPoolTotals(bank);
    let extraOscAllowed = Math.max(0, MAX_ACTIVE_OSCILLATORS - oscCount);

    for (let i = 0; i < countToMatch; i++) {
      const spec = validSpecs[i];
      let modeState = existing.modes[i];

      if (!spec && modeState) {
        // Mode absent in new strike (e.g. struck directly on its node!): damp according to spatial contact absorption
        const curG = evaluateModeAmplitudeAt(modeState, now);
        const phiSq = computeSpatialParticipationSq(
          i,
          !!opts.isPluck,
          opts.pluckBeta,
          opts.strikeXi,
          existing.modeVectors,
        );
        const survG = curG * (1 - etaChoke * phiSq);
        if (survG < 0.0003) {
          cancelParam(modeState.env.gain, now);
          modeState.env.gain.setValueAtTime(Math.max(0.0001, curG), now);
          modeState.env.gain.linearRampToValueAtTime(0, now + 0.012);
          modeState.peakGain = 0;
          modeState.attackEndTime = now;
        } else {
          const remEnd = scheduleModeEnvelopeAndPitch(
            modeState,
            { freqHz: modeState.baseFreqHz, gain: survG, decaySec: modeState.tauSec * LN_10000 },
            survG,
            survG,
            curG,
            now,
            0.002,
            sr,
          );
          if (remEnd > maxEnd) maxEnd = remEnd;
        }
        continue;
      }

      if (!spec) continue;

      if (!modeState) {
        if (extraOscAllowed <= 0) continue;
        extraOscAllowed--;
        const osc = ctx.createOscillator();
        const env = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(clampSafeFreq(spec.freqHz, sr), now);
        env.gain.setValueAtTime(0.0001, now);
        osc.connect(env);
        env.connect(existing.master);
        osc.start(now);
        modeState = {
          osc,
          env,
          baseFreqHz: spec.freqHz,
          modeIndex: i,
          anchorTime: now,
          anchorGain: 0,
          peakGain: 0,
          attackEndTime: now,
          tauSec: 0.1,
          droopFrac: 0,
          droopStartTime: now,
          droopTauSec: 0.08,
        };
        existing.modes.push(modeState);
      }

      const curG = evaluateModeAmplitudeAt(modeState, now);
      const phiSq = computeSpatialParticipationSq(
        i,
        !!opts.isPluck,
        opts.pluckBeta,
        opts.strikeXi,
        existing.modeVectors,
      );
      const survG = curG * (1 - etaChoke * phiSq);
      const freshG = opts.level * spec.gain;
      const combinedPeak = Math.min(1.30, Math.hypot(survG, freshG));

      const modeEnd = scheduleModeEnvelopeAndPitch(
        modeState,
        spec,
        combinedPeak,
        survG,
        curG,
        now,
        defaultAttackSec,
        sr,
      );
      if (modeEnd > maxEnd) maxEnd = modeEnd;
    }

    const pulseEnd = attachHertzianClickPulse(ctx, bank, existing, opts, now, validSpecs.length);
    if (pulseEnd > maxEnd) maxEnd = pulseEnd;
    if (opts.snare) {
      const sEnd = attachSnareRattle(ctx, bank, existing, opts.snare, opts.level, now);
      if (sEnd > maxEnd) maxEnd = sEnd;
    }
    if (opts.crashShimmer) {
      const cEnd = attachCrashShimmer(ctx, bank, existing, opts.crashShimmer, opts.level, now);
      if (cEnd > maxEnd) maxEnd = cEnd;
    }

    const irPad = existing.irConv ? 0.11 : 0.03;
    existing.expiresAtAudioTime = Math.max(existing.expiresAtAudioTime, maxEnd + irPad);
    ensureSweepTimer(ctx, bank);
    return existing;
  }

  // ---- PATH B: Allocate bounded new `ActiveModalVoiceGroup` -----------------
  const incomingEnergy =
    opts.level *
    (validSpecs.length > 0
      ? validSpecs.reduce((acc, m) => acc + m.gain, 0) * 0.5
      : 1.2);

  if (!enforcePoolBudget(ctx, bank, validSpecs.length, wantIr, incomingEnergy, groupKey)) {
    return null;
  }

  const { oscCount, convCount } = countPoolTotals(bank);
  const maxModesThisVoice = Math.max(0, Math.min(validSpecs.length, MAX_ACTIVE_OSCILLATORS - oscCount));
  // Never play a half-chopped harmonic note if 0 oscillators fit when modes were requested!
  if (validSpecs.length > 0 && maxModesThisVoice === 0) return null;

  const canAttachConv = wantIr && convCount < MAX_ACTIVE_CONVOLVERS;
  const irConv = canAttachConv && opts.bodyIr ? createPooledConvolver(ctx, bank, opts.bodyIr, opts.bodyIrSig) : null;

  const master = ctx.createGain();
  master.gain.setValueAtTime(distScale, now);

  // Optional vibraphone vane tremolo stage (Starter #5)
  let tremoloGain: GainNode | null = null;
  let tremoloOsc: OscillatorNode | null = null;
  let tremoloDepthGain: GainNode | null = null;
  let tremoloFormant: BiquadFilterNode | null = null;
  if (opts.tremolo) {
    tremoloGain = ctx.createGain();
    tremoloGain.gain.setValueAtTime(1.0, now);
    tremoloOsc = ctx.createOscillator();
    tremoloOsc.type = 'sine';
    tremoloOsc.frequency.setValueAtTime(Math.max(0.2, opts.tremolo.rateHz || 5.5), now);
    tremoloDepthGain = ctx.createGain();
    tremoloDepthGain.gain.setValueAtTime(0, now);
    tremoloOsc.connect(tremoloDepthGain);
    tremoloDepthGain.connect(tremoloGain.gain);
    tremoloOsc.start(now);
    if (opts.tremolo.formantHz) {
      tremoloFormant = ctx.createBiquadFilter();
      tremoloFormant.type = 'peaking';
      tremoloFormant.frequency.setValueAtTime(clampSafeFreq(opts.tremolo.formantHz, sr, 60), now);
      tremoloFormant.Q.setValueAtTime(2.8, now);
      tremoloFormant.gain.setValueAtTime(4.5, now);
    }
  }

  // Optional StereoPannerNode spatialization stage (Starter #6c)
  let panner: StereoPannerNode | null = null;
  if (typeof ctx.createStereoPanner === 'function' && opts.pan !== undefined && Number.isFinite(opts.pan)) {
    try {
      panner = ctx.createStereoPanner();
      panner.pan.setValueAtTime(Math.max(-1, Math.min(1, opts.pan)), now);
    } catch {
      panner = null;
    }
  }

  const busEntry: AudioNode = panner ?? outputBus;
  if (panner) panner.connect(outputBus);

  let postMasterTarget: AudioNode = busEntry;
  if (tremoloGain) {
    if (tremoloFormant) {
      tremoloFormant.connect(tremoloGain);
      tremoloGain.connect(busEntry);
      postMasterTarget = tremoloFormant;
    } else {
      tremoloGain.connect(busEntry);
      postMasterTarget = tremoloGain;
    }
  }

  let dryGain: GainNode | null = null;
  let irWetGain: GainNode | null = null;

  if (irConv && opts.isPluck) {
    const usedPureModes = !!(opts.rawIrVoices && opts.rawIrVoices.length > 0);
    dryGain = ctx.createGain();
    dryGain.gain.setValueAtTime(usedPureModes ? 0.42 : 0.36, now);
    irWetGain = ctx.createGain();
    const wetScale = opts.bodyIrGain ?? (usedPureModes ? 1.65 : 1.15);
    irWetGain.gain.setValueAtTime(wetScale, now);
    master.connect(dryGain);
    dryGain.connect(postMasterTarget);
    master.connect(irConv);
    irConv.connect(irWetGain);
    irWetGain.connect(postMasterTarget);
  } else {
    master.connect(postMasterTarget);
    if (irConv && !opts.isPluck) {
      irWetGain = ctx.createGain();
      const q = opts.materialQ ?? 350;
      const irWeight = opts.bodyIrGain ?? (0.52 + 0.38 * (1 - Math.min(1, q / 700)));
      irWetGain.gain.setValueAtTime(irWeight, now);
      irConv.connect(irWetGain);
      irWetGain.connect(postMasterTarget);
    }
  }

  const group: ActiveModalVoiceGroup = {
    key: groupKey,
    nodeId: opts.nodeId ?? groupKey,
    isPluck: !!opts.isPluck,
    master,
    tremoloGain,
    tremoloOsc,
    tremoloDepthGain,
    tremoloFormant,
    panner,
    dryGain,
    irConv,
    irWetGain,
    irSig: opts.bodyIrSig ?? '',
    modes: [],
    modeVectors: opts.modeVectors,
    lenAxis: opts.lenAxis,
    lenBounds: opts.lenBounds,
    principalLenDir: opts.principalLenDir,
    principalOrigin: opts.principalOrigin,
    shimmerEnv: null,
    auxEnvelopes: new Set(),
    transientSources: new Set(),
    transientNodes: new Set(),
    createdAtAudioTime: now,
    lastTriggeredAtAudioTime: now,
    ...(opts.simTime !== undefined && Number.isFinite(opts.simTime)
      ? { lastTriggeredSimTime: opts.simTime }
      : {}),
    expiresAtAudioTime: now + 0.15,
    pulsePeakGain: 0,
    pulseDecayTauSec: 0.02,
    pulseStartTime: now,
  };

  configureTremoloStage(ctx, group, opts.tremolo, now);

  let maxEnd = now + 0.06;
  for (let i = 0; i < maxModesThisVoice; i++) {
    const spec = validSpecs[i];
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(clampSafeFreq(spec.freqHz, sr), now);
    env.gain.setValueAtTime(0.0001, now);
    osc.connect(env);
    env.connect(master);
    osc.start(now);

    const state: ActiveModeState = {
      osc,
      env,
      baseFreqHz: spec.freqHz,
      modeIndex: i,
      anchorTime: now,
      anchorGain: 0.0001,
      peakGain: 0.0001,
      attackEndTime: now,
      tauSec: 0.1,
      droopFrac: 0,
      droopStartTime: now,
      droopTauSec: 0.08,
    };
    const peakGain = opts.level * spec.gain;
    const mEnd = scheduleModeEnvelopeAndPitch(
      state,
      spec,
      peakGain,
      0.0001,
      0.0001,
      now,
      defaultAttackSec,
      sr,
    );
    if (mEnd > maxEnd) maxEnd = mEnd;
    group.modes.push(state);
  }

  const pulseEnd = attachHertzianClickPulse(ctx, bank, group, opts, now, maxModesThisVoice);
  if (pulseEnd > maxEnd) maxEnd = pulseEnd;
  if (opts.snare) {
    const sEnd = attachSnareRattle(ctx, bank, group, opts.snare, opts.level, now);
    if (sEnd > maxEnd) maxEnd = sEnd;
  }
  if (opts.crashShimmer) {
    const cEnd = attachCrashShimmer(ctx, bank, group, opts.crashShimmer, opts.level, now);
    if (cEnd > maxEnd) maxEnd = cEnd;
  }

  const irPad = irConv ? 0.11 : 0.03;
  group.expiresAtAudioTime = maxEnd + irPad;
  bank.groups.set(groupKey, group);
  ensureSweepTimer(ctx, bank);
  return group;
}

function resolveSolidTouchXi(
  localPoint: [number, number, number] | undefined,
  group: ActiveModalVoiceGroup,
  tNode?: SceneNode | null,
): number | undefined {
  if (!localPoint) return undefined;
  if (group.lenBounds) {
    const [sLo, sHi] = group.lenBounds;
    const mid = 0.5 * (sLo + sHi);
    const half = Math.max(1e-4, 0.5 * (sHi - sLo));
    if (group.principalLenDir) {
      const dir = group.principalLenDir;
      const orig = group.principalOrigin ?? [0, 0, 0];
      const sProj =
        (localPoint[0] - orig[0]) * dir[0] +
        (localPoint[1] - orig[1]) * dir[1] +
        (localPoint[2] - orig[2]) * dir[2];
      return Math.max(-1, Math.min(1, (sProj - mid) / half));
    }
    if (group.lenAxis !== undefined) {
      return Math.max(-1, Math.min(1, (localPoint[group.lenAxis] - mid) / half));
    }
  }
  const g = tNode?.geoms?.find((gm) => !gm.csgDerived && gm.csg !== 'difference' && gm.role !== 'visual') ?? tNode?.geoms?.[0];
  if (!g) return undefined;
  if ((g.type === 'cylinder' || g.type === 'capsule') && g.fromto && g.fromto.length >= 6) {
    const dx = g.fromto[3] - g.fromto[0];
    const dy = g.fromto[4] - g.fromto[1];
    const dz = g.fromto[5] - g.fromto[2];
    const trunkLen = Math.hypot(dx, dy, dz);
    if (trunkLen > 1e-4) {
      const mx = 0.5 * (g.fromto[0] + g.fromto[3]);
      const my = 0.5 * (g.fromto[1] + g.fromto[4]);
      const mz = 0.5 * (g.fromto[2] + g.fromto[5]);
      const halfTotal = 0.5 * trunkLen + (g.type === 'capsule' ? (g.size?.[0] ?? 0) : 0);
      const proj = ((localPoint[0] - mx) * dx + (localPoint[1] - my) * dy + (localPoint[2] - mz) * dz) / trunkLen;
      return Math.max(-1, Math.min(1, proj / Math.max(1e-4, halfTotal)));
    }
  }
  if (g.type === 'cylinder' || g.type === 'capsule') {
    const halfL = (g.size?.[1] ?? 0.05) + (g.type === 'capsule' ? (g.size?.[0] ?? 0) : 0);
    const cz = g.pos?.[2] ?? 0;
    return halfL > 1e-4 ? Math.max(-1, Math.min(1, (localPoint[2] - cz) / halfL)) : undefined;
  }
  const sx = g.size?.[0] ?? 0.02;
  const sy = g.size?.[1] ?? sx;
  const sz = g.size?.[2] ?? sx;
  const axis: 0 | 1 | 2 = sx >= sy && sx >= sz ? 0 : sy >= sx && sy >= sz ? 1 : 2;
  const half = axis === 0 ? sx : axis === 1 ? sy : sz;
  const center = g.pos?.[axis] ?? 0;
  return half > 1e-4 ? Math.max(-1, Math.min(1, (localPoint[axis] - center) / half)) : undefined;
}

/**
 * Physically damps/chokes active ringing modes on `nodeId` (and any `${nodeId}:symp` halo):
 * - `mode: 'grab'`: viscoelastic human-hand mute (~30–65 ms, damping upper partials fastest).
 * - `mode: 'contact'`: post-strike damper / nodal touch (`contactStartedAt > voiceTriggeredAt + 0.06s`),
 *   weighted by modal shape `φ_n(ξ)²` (preserving beam Euler-Bernoulli nodes ξ_bar ≈ 0.224, 0.776 & string flageolets!).
 */
export function chokeBodyVoice(
  ctx: AudioContext | null | undefined,
  nodeId: string,
  opts: ChokeVoiceOptions = {},
): boolean {
  const targetCtx = ctx ?? lastKnownAudioCtx;
  if (!targetCtx || !nodeId) return false;
  const bank = banksByContext.get(targetCtx);
  if (!bank || bank.groups.size === 0) return false;

  const now = targetCtx.currentTime;
  let chokedAny = false;

  const isGrab = (opts.mode ?? 'grab') === 'grab';
  if (!isGrab && opts.softness !== undefined && opts.softness < 0.28) {
    return false;
  }

  let touchBeta: number | undefined;
  const tNode = opts.targetNode;
  if (!isGrab && opts.localPoint && tNode?.acousticString) {
    touchBeta = resolveStringBetaFromPoint(tNode, opts.localPoint, undefined, opts.sceneNodes);
  }

  const checkSymp = bank.activeSympatheticKeys.size > 0;
  for (let pass = 0; pass < (checkSymp ? 2 : 1); pass++) {
    const group = bank.groups.get(pass === 0 ? nodeId : `${nodeId}:symp`);
    if (!group || now >= group.expiresAtAudioTime) continue;

    // Pre-existing resting support / rail / cushion / striker guard (60 ms post-strike window):
    // Any contact that began BEFORE or within 60 ms of when this voice was triggered MUST NEVER choke it!
    if (!isGrab) {
      if (opts.contactStartedAtSimTime !== undefined && group.lastTriggeredSimTime !== undefined) {
        if (opts.contactStartedAtSimTime <= group.lastTriggeredSimTime + 0.060) continue;
      } else if (
        opts.contactDurationSec !== undefined &&
        opts.currentSimTime !== undefined &&
        group.lastTriggeredSimTime !== undefined
      ) {
        const startedSim = opts.currentSimTime - opts.contactDurationSec;
        if (startedSim <= group.lastTriggeredSimTime + 0.060) continue;
      } else if (opts.contactDurationSec !== undefined) {
        const startedAudio = now - opts.contactDurationSec;
        if (startedAudio <= group.lastTriggeredAtAudioTime + 0.060) continue;
      }
    }

    const touchXi = !isGrab && !group.isPluck
      ? resolveSolidTouchXi(opts.localPoint, group, tNode)
      : undefined;

    let maxNewExpire = now + 0.05;
    let groupChoked = false;
    for (let i = 0; i < group.modes.length; i++) {
      const m = group.modes[i];
      const curG = evaluateModeAmplitudeAt(m, now);
      if (curG <= 0.00012) continue;

      let nextTau: number;
      if (isGrab) {
        // Soft viscoelastic flesh grasp damps high frequencies in ~15 ms and fundamental in ~50 ms
        nextTau = Math.max(0.014, 0.052 / (1 + 0.38 * i));
      } else {
        const phiSq = computeSpatialParticipationSq(
          i,
          group.isPluck,
          touchBeta,
          touchXi,
          group.modeVectors,
        );
        const fN = Math.max(0, opts.normalForceN ?? 0.25);
        const softness = Math.max(0, Math.min(1, opts.softness ?? 0.5));
        // Scale damping strictly with modal displacement squared φ_n(ξ)² so contacts at Euler-Bernoulli
        // beam nodes (0.224·L, 0.776·L -> ξ ≈ ±0.5516) or string harmonic nodes preserve natural ring!
        const effParticipation = Math.min(1, phiSq * (1 + 0.22 * softness * Math.min(2.5, fN)) + 0.0015);
        const baseRate = Math.max(0.5, opts.dampingRate ?? 14.0);
        const deltaAlpha = baseRate * effParticipation * (1 + 0.16 * i * softness);
        if (deltaAlpha < 0.12) {
          const keepExp = now + m.tauSec * LN_10000 + 0.04;
          if (keepExp > maxNewExpire) maxNewExpire = keepExp;
          continue;
        }
        nextTau = 1 / (1 / Math.max(0.005, m.tauSec) + deltaAlpha);
      }

      cancelParam(m.env.gain, now);
      m.env.gain.setValueAtTime(Math.max(0.0001, curG), now);
      const endDur = Math.max(0.014, nextTau * LN_10000);
      m.env.gain.exponentialRampToValueAtTime(0.0001, now + endDur);
      m.env.gain.linearRampToValueAtTime(0, now + endDur + 0.006);

      m.anchorTime = now;
      m.anchorGain = curG;
      m.peakGain = curG;
      m.attackEndTime = now;
      m.tauSec = nextTau;
      const mExp = now + endDur + 0.025;
      if (mExp > maxNewExpire) maxNewExpire = mExp;
      groupChoked = true;
      chokedAny = true;
    }

    // Smoothly choke broadband von Kármán crash shimmer & snare rattle envelopes alongside modal partials
    for (const aux of group.auxEnvelopes) {
      const curAuxG = evaluateAuxEnvelopeAmplitudeAt(aux, now);
      if (curAuxG <= 0.00012) continue;

      let nextAuxTau: number;
      if (isGrab) {
        nextAuxTau = aux.kind === 'shimmer' ? 0.028 : 0.032;
      } else {
        const fN = Math.max(0, opts.normalForceN ?? 0.25);
        const softness = Math.max(0, Math.min(1, opts.softness ?? 0.5));
        const baseRate = Math.max(0.5, opts.dampingRate ?? 14.0);
        const broadbandCoupling = Math.min(
          1.2,
          (0.65 + 0.35 * softness) * (1 + 0.22 * softness * Math.min(2.5, fN)),
        );
        const deltaAlpha = baseRate * broadbandCoupling * (aux.kind === 'shimmer' ? 1.35 : 1.15);
        if (deltaAlpha < 0.12) {
          const keepExp = now + aux.tauSec * LN_10000 + 0.04;
          if (keepExp > maxNewExpire) maxNewExpire = keepExp;
          continue;
        }
        nextAuxTau = 1 / (1 / Math.max(0.005, aux.tauSec) + deltaAlpha);
      }

      cancelParam(aux.env.gain, now);
      aux.env.gain.setValueAtTime(Math.max(0.0001, curAuxG), now);
      const decayRatio = Math.max(1.0002, curAuxG / 0.0001);
      const auxEndDur = Math.max(0.014, nextAuxTau * Math.log(decayRatio));
      aux.env.gain.exponentialRampToValueAtTime(0.0001, now + auxEndDur);
      aux.env.gain.linearRampToValueAtTime(0, now + auxEndDur + 0.006);

      aux.anchorTime = now;
      aux.anchorGain = curAuxG;
      aux.peakGain = curAuxG;
      aux.attackEndTime = now;
      aux.tauSec = nextAuxTau;
      const auxExp = now + auxEndDur + 0.025;
      if (auxExp > maxNewExpire) maxNewExpire = auxExp;
      groupChoked = true;
      chokedAny = true;
    }

    if (groupChoked) {
      group.expiresAtAudioTime = Math.min(group.expiresAtAudioTime, maxNewExpire + (group.irConv ? 0.09 : 0.02));
    }
  }

  return chokedAny;
}

function findNodeInTree(nodes: SceneNode[] | undefined, id: string): SceneNode | null {
  if (!nodes) return null;
  for (const n of nodes) {
    if (n.id === id || n.name === id) return n;
    const sub = findNodeInTree(n.children, id);
    if (sub) return sub;
  }
  return null;
}

/** Processes batched `AUDIO_DAMPING` events from `physicsWorker.ts` against active ringing voices. */
export function applyAudioDampingEvents(
  ctx: AudioContext | null | undefined,
  events: AudioDampingEvent[],
  sceneNodes?: SceneNode[],
  currentSimTime?: number,
): void {
  const targetCtx = ctx ?? lastKnownAudioCtx;
  if (!targetCtx || !events?.length) return;
  const bank = banksByContext.get(targetCtx);
  if (!bank || bank.groups.size === 0) return;

  for (const ev of events) {
    if (!ev.nodeId || !(ev.dampingRate > 0) || !(ev.normalForce > 0)) continue;
    if (ev.softness !== undefined && ev.softness < 0.28) continue;
    if (!bank.groups.has(ev.nodeId) && !bank.groups.has(`${ev.nodeId}:symp`)) continue;
    const targetNode = findNodeInTree(sceneNodes, ev.nodeId);
    chokeBodyVoice(targetCtx, ev.nodeId, {
      mode: 'contact',
      dampingRate: ev.dampingRate,
      normalForceN: ev.normalForce,
      softness: ev.softness,
      localPoint: ev.localPoint,
      contactDurationSec: ev.contactDurationSec,
      currentSimTime,
      targetNode,
      sceneNodes,
    });
  }
}

/** Updates StereoPannerNode pan & distance attenuation live on a ringing `nodeId` (Starter #6c). */
export function updateVoiceSpatialPan(
  ctx: AudioContext | null | undefined,
  nodeId: string,
  pan: number,
  distanceGain?: number,
): void {
  const targetCtx = ctx ?? lastKnownAudioCtx;
  if (!targetCtx || !nodeId) return;
  const bank = banksByContext.get(targetCtx);
  const group = bank?.groups.get(nodeId);
  if (!group) return;
  const now = targetCtx.currentTime;
  if (group.panner && Number.isFinite(pan)) {
    cancelParam(group.panner.pan, now);
    group.panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), now, 0.016);
  }
  if (distanceGain !== undefined && Number.isFinite(distanceGain)) {
    cancelParam(group.master.gain, now);
    group.master.gain.setTargetAtTime(Math.max(0.02, Math.min(1.5, distanceGain)), now, 0.016);
  }
}

/** Updates rotating-vane vibraphone tremolo LFO rate/depth/occlusion live on a ringing `nodeId` (Starter #5). */
export function updateVoiceTremolo(
  ctx: AudioContext | null | undefined,
  nodeId: string,
  tremolo: TremoloModulationParams,
): void {
  const targetCtx = ctx ?? lastKnownAudioCtx;
  if (!targetCtx || !nodeId) return;
  const bank = banksByContext.get(targetCtx);
  const group = bank?.groups.get(nodeId);
  if (!group) return;
  configureTremoloStage(targetCtx, group, tremolo, targetCtx.currentTime);
}

/**
 * Starter #3 — Triggers sympathetic bridge-coupled resonance across all unplayed sibling strings
 * when `sourceNode` is plucked! Each sibling string rings in its OWN `nodeId` voice group with
 * slow Weinreich energy-transfer bloom (`45 ms`) so muting `sourceNode` leaves siblings singing!
 */
export function triggerSympatheticStringPluck(
  ctx: AudioContext,
  outputBus: AudioNode,
  sourceNode: SceneNode,
  sceneNodes: SceneNode[],
  impulseNs: number,
  opts?: {
    sourcePitchHz?: number;
    excludedNodeIds?: ReadonlySet<string>;
    pan?: number;
    distanceGain?: number;
  },
): number {
  if (!ctx || !outputBus || !sourceNode.acousticString || !sceneNodes?.length) return 0;
  const baseLevel = Math.min(0.56, 0.34 * Math.log10(1 + Math.max(0.0005, impulseNs) * 140) * 1.15);
  if (baseLevel < 0.008) return 0;

  const targets = solveSympatheticStringCoupling(sourceNode, sceneNodes, {
    sourcePitchHz: opts?.sourcePitchHz,
    excludedNodeIds: opts?.excludedNodeIds,
  });

  let triggered = 0;
  for (const t of targets) {
    const sympLevel = Math.min(0.28, baseLevel * 0.65);
    if (sympLevel * t.couplingGain < 0.0012) continue;
    const g = triggerOrMutateModalVoice({
      ctx,
      outputBus,
      nodeId: t.targetNodeId,
      level: sympLevel,
      tauC: 0.002,
      brightness: 0.35,
      isPluck: true,
      skipClickPulse: true,
      attackTimeSec: 0.045, // Weinreich coupled-string energy-transfer bloom!
      voices: t.modes,
      rawIrVoices: t.rawStringModes,
      bodyIr: t.bodyIr,
      bodyIrSig: t.bodyIrSig,
      pan: opts?.pan,
      distanceGain: opts?.distanceGain,
    });
    if (g) triggered++;
  }
  return triggered;
}

/**
 * Starter #3 — Continuously pumps sympathetic resonance on unbowed sibling strings while bowing
 * `activeBowedStrings`, and lets them decay naturally at their open-string `Q` upon bow lift-off!
 */
export function updateSympatheticBowedVoices(
  ctx: AudioContext | null | undefined,
  outputBus: AudioNode | null | undefined,
  activeBowedStrings: {
    node: SceneNode;
    pitchHz: number;
    amplitude: number;
    stringHarmonicWeights?: number[];
  }[],
  sceneNodes: SceneNode[],
  excludedNodeIds?: ReadonlySet<string>,
): void {
  const targetCtx = ctx ?? lastKnownAudioCtx;
  if (!targetCtx || !outputBus) return;
  const bank = getBank(targetCtx);
  sweepExpiredVoiceGroups(targetCtx);

  const bowedIds = new Set(activeBowedStrings.map((b) => b.node.id));
  if (excludedNodeIds) {
    for (const id of excludedNodeIds) bowedIds.add(id);
  }

  // Any string currently bowed directly should have its `:symp` halo damped quickly so direct bow owns it cleanly
  for (const b of activeBowedStrings) {
    const selfSymp = bank.groups.get(`${b.node.id}:symp`);
    if (selfSymp) {
      chokeBodyVoice(targetCtx, `${b.node.id}:symp`, { mode: 'grab' });
    }
  }

  for (const b of activeBowedStrings) {
    if (!(b.amplitude >= 0.008) || !b.node.acousticString) continue;
    const hw = b.stringHarmonicWeights ?? [];
    const sourcePartials = hw.map((w, idx) => ({
      freqHz: (idx + 1) * b.pitchHz,
      gain: w,
    }));
    const targets = solveSympatheticStringCoupling(b.node, sceneNodes, {
      sourcePitchHz: b.pitchHz,
      sourcePartials: sourcePartials.length > 0 ? sourcePartials : undefined,
      excludedNodeIds: bowedIds,
    });

    for (const t of targets) {
      const sympKey = `${t.targetNodeId}:symp`;
      const sympLevel = Math.min(0.18, b.amplitude * 0.42);
      if (sympLevel * t.couplingGain < 0.001) continue;
      const g = triggerOrMutateModalVoice({
        ctx: targetCtx,
        outputBus,
        nodeId: t.targetNodeId,
        voiceGroupKey: sympKey,
        level: sympLevel,
        tauC: 0.003,
        brightness: 0.3,
        isPluck: true,
        skipClickPulse: true,
        attackTimeSec: 0.060,
        voices: t.modes,
        rawIrVoices: t.rawStringModes,
        bodyIr: t.bodyIr,
        bodyIrSig: t.bodyIrSig,
      });
      if (g) bank.activeSympatheticKeys.add(sympKey);
    }
  }
}

/**
 * Smoothly silences & tears down ALL active modal impact, bell, bar, membrane, and sympathetic
 * string voices (called on Pause `isPlaying -> false`, Reset `resetSimulation()`, and Mute!).
 */
export function silenceModalVoices(ctx?: AudioContext | null, fadeSec = 0.015): void {
  const targetCtx = ctx ?? lastKnownAudioCtx;
  if (!targetCtx) return;
  const bank = banksByContext.get(targetCtx);
  if (!bank || bank.groups.size === 0) return;

  const now = targetCtx.currentTime;
  if (!(fadeSec > 0.002) || targetCtx.state !== 'running') {
    for (const g of Array.from(bank.groups.values())) {
      destroyVoiceGroup(bank, g);
    }
    return;
  }

  for (const g of Array.from(bank.groups.values())) {
    cancelParam(g.master.gain, now);
    try {
      g.master.gain.setValueAtTime(Math.max(0.0001, g.master.gain.value || 1.0), now);
      g.master.gain.linearRampToValueAtTime(0, now + fadeSec);
    } catch {
      destroyVoiceGroup(bank, g);
      continue;
    }
    g.expiresAtAudioTime = now + fadeSec + 0.005;
  }
  ensureSweepTimer(targetCtx, bank);
}

/** Diagnostic snapshot of active voice groups, oscillators, convolvers, and cached IR buffers. */
export function getModalVoicePoolStats(ctx?: AudioContext | null): ModalVoicePoolStats {
  const targetCtx = ctx ?? lastKnownAudioCtx;
  if (!targetCtx) {
    return {
      activeGroups: 0,
      activeOscillators: 0,
      activeConvolvers: 0,
      cachedIrBuffers: 0,
      groupKeys: [],
    };
  }
  sweepExpiredVoiceGroups(targetCtx);
  const bank = banksByContext.get(targetCtx);
  if (!bank) {
    return {
      activeGroups: 0,
      activeOscillators: 0,
      activeConvolvers: 0,
      cachedIrBuffers: 0,
      groupKeys: [],
    };
  }
  const { oscCount, convCount } = countPoolTotals(bank);
  return {
    activeGroups: bank.groups.size,
    activeOscillators: oscCount,
    activeConvolvers: convCount,
    cachedIrBuffers: bank.irBufferCache.size,
    groupKeys: Array.from(bank.groups.keys()),
  };
}
