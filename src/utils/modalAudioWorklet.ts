// ---------------------------------------------------------------------------
// Native C++ WebAudio Physical Bore & Reed / Lip / Jet Synthesizer
// ---------------------------------------------------------------------------
//
// Runs 100% on the real-time C++ WebAudio rendering thread (`OscillatorNode`,
// 4x-oversampled `WaveShaperNode`, dual `BiquadFilterNode` bore/bell impedance
// shapers, filtered breath-turbulence `BufferSourceNode`, and early-reflection
// stereo room `DelayNode`s).
//
// Zero `ScriptProcessorNode`, zero main-thread JS sample loops, zero buffer
// underrun pops/clicks when Three.js/React renders heavy frames, and 100%
// generic physical acoustics driven by `extractBoreWaveguide` + `solvePlayableWindVoice`!
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

type ShaperKind = 'cylindrical_reed' | 'lip_or_conical' | 'flute_jet';

interface NativeWindVoiceSlot {
  id: string;
  wasActive: boolean;
  currentShaperKind: ShaperKind;
  osc: OscillatorNode;
  vibOsc: OscillatorNode;
  vibDepth: GainNode;
  driveGain: GainNode;
  shaper: WaveShaperNode;
  bodyFormant: BiquadFilterNode;
  bellLowpass: BiquadFilterNode;
  voiceGain: GainNode;
  noiseFilter: BiquadFilterNode;
  noiseGain: GainNode;
}

interface NativeWindBankState {
  masterGain: GainNode;
  dryGain: GainNode;
  roomWetGain: GainNode;
  noiseSource: AudioBufferSourceNode | null;
  slots: NativeWindVoiceSlot[];
  curves: Record<ShaperKind, Float32Array<ArrayBuffer>>;
}

interface LegacyWindGraphState {
  outGain?: GainNode;
  processor?: AudioNode | null;
  keepAlive?: ConstantSourceNode;
}

type AudioContextWithWindGraph = AudioContext & {
  __physboxWindWaveguideV5?: LegacyWindGraphState;
  __physboxWindWaveguideV6?: LegacyWindGraphState;
  __physboxWindWaveguideV7?: LegacyWindGraphState;
  __physboxWindWaveguideV8?: LegacyWindGraphState;
  __physboxWindWaveguideV9?: LegacyWindGraphState;
  __physboxNativeWindV10?: NativeWindBankState;
};

function buildExciterCurves(): Record<ShaperKind, Float32Array<ArrayBuffer>> {
  const N = 2049;
  const cyl = new Float32Array(new ArrayBuffer(N * 4));
  const lip = new Float32Array(new ArrayBuffer(N * 4));
  const flute = new Float32Array(new ArrayBuffer(N * 4));

  const lipBias = 0.42;
  const lipK = 2.15;
  const lipDc = Math.tanh(lipK * lipBias);

  const fluteBias = 0.16;
  const fluteK = 1.25;
  const fluteDc = Math.tanh(fluteK * fluteBias);

  const cylAsym = 0.055;
  const cylK = 2.35;
  const cylDc = Math.tanh(cylK * cylAsym * 0.5);

  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * 2 - 1;
    // 1. Cylindrical quarter-wave reed: predominantly odd harmonics (f, 3f, 5f, 7f)
    cyl[i] = Math.tanh(cylK * (x + cylAsym * (x * x - 0.5))) - cylDc * 0.1;
    // 2. Outward-striking lip-reed / conical reed aperture pulse: smooth complete harmonic series (f, 2f, 3f, 4f, 5f)
    lip[i] = (Math.tanh(lipK * (x + lipBias)) - lipDc) * 0.88;
    // 3. Air-jet flute: gentle soft fundamental + subtle 2nd/3rd harmonic
    flute[i] = (Math.tanh(fluteK * (x + fluteBias)) - fluteDc) * 0.92;
  }

  return {
    cylindrical_reed: cyl,
    lip_or_conical: lip,
    flute_jet: flute,
  };
}

function selectShaperKind(p: WorkletWindVoicePayload): ShaperKind {
  if (p.exciter === 'flute_jet') return 'flute_jet';
  const shape = p.boreShape ?? (p.exciter === 'brass_lip' ? 'flared_horn' : 'cylindrical');
  if (p.exciter === 'reed' && shape === 'cylindrical') return 'cylindrical_reed';
  return 'lip_or_conical';
}

function disconnectLegacyGraphs(c: AudioContextWithWindGraph): void {
  for (const oldKey of [
    '__physboxWindWaveguideV5',
    '__physboxWindWaveguideV6',
    '__physboxWindWaveguideV7',
    '__physboxWindWaveguideV8',
    '__physboxWindWaveguideV9',
  ] as const) {
    const prev = c[oldKey];
    if (prev) {
      try { prev.keepAlive?.stop(); } catch { /* ignore */ }
      try { prev.keepAlive?.disconnect(); } catch { /* ignore */ }
      try { prev.processor?.disconnect(); } catch { /* ignore */ }
      try { prev.outGain?.disconnect(); } catch { /* ignore */ }
      delete c[oldKey];
    }
  }
}

function ensureNativeWindBank(ctx: AudioContext): NativeWindBankState | null {
  const c = ctx as AudioContextWithWindGraph;
  disconnectLegacyGraphs(c);
  if (c.__physboxNativeWindV10) return c.__physboxNativeWindV10;
  if (typeof ctx.createOscillator !== 'function' || typeof ctx.createWaveShaper !== 'function') {
    return null;
  }

  const curves = buildExciterCurves();
  const now = ctx.currentTime;

  const masterGain = ctx.createGain();
  masterGain.gain.setValueAtTime(0.9, now);

  // Direct path + warm unconditional-FIR early room reflection (zero feedback, zero ringing, natural stereo air)
  const dryGain = ctx.createGain();
  dryGain.gain.setValueAtTime(0.86, now);
  const roomWetGain = ctx.createGain();
  roomWetGain.gain.setValueAtTime(0.14, now);

  masterGain.connect(dryGain);
  dryGain.connect(ctx.destination);

  if (typeof ctx.createDelay === 'function' && typeof ctx.createChannelMerger === 'function') {
    const roomLp = ctx.createBiquadFilter();
    roomLp.type = 'lowpass';
    roomLp.frequency.setValueAtTime(1650, now);
    roomLp.Q.setValueAtTime(0.7, now);

    const delayL = ctx.createDelay(0.1);
    const delayR = ctx.createDelay(0.1);
    delayL.delayTime.setValueAtTime(0.023, now);
    delayR.delayTime.setValueAtTime(0.031, now);

    const merger = ctx.createChannelMerger(2);
    masterGain.connect(roomLp);
    roomLp.connect(delayL);
    roomLp.connect(delayR);
    delayL.connect(merger, 0, 0);
    delayR.connect(merger, 0, 1);
    merger.connect(roomWetGain);
    roomWetGain.connect(ctx.destination);
  }

  // Shared looping warm breath-turbulence noise buffer running purely on C++ audio thread
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
      const white = (seed / 2147483648);
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
    vibOsc.frequency.setValueAtTime(4.7 + i * 0.22, now);

    const vibDepth = ctx.createGain();
    vibDepth.gain.setValueAtTime(0, now);
    vibOsc.connect(vibDepth);
    vibDepth.connect(osc.frequency);

    const driveGain = ctx.createGain();
    driveGain.gain.setValueAtTime(0.5, now);

    const shaper = ctx.createWaveShaper();
    shaper.curve = curves.cylindrical_reed;
    shaper.oversample = '4x';

    const bodyFormant = ctx.createBiquadFilter();
    bodyFormant.type = 'peaking';
    bodyFormant.frequency.setValueAtTime(800, now);
    bodyFormant.Q.setValueAtTime(1.3, now);
    bodyFormant.gain.setValueAtTime(3.5, now);

    const bellLowpass = ctx.createBiquadFilter();
    bellLowpass.type = 'lowpass';
    bellLowpass.frequency.setValueAtTime(1200, now);
    bellLowpass.Q.setValueAtTime(0.9, now);

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
    bodyFormant.connect(bellLowpass);
    bellLowpass.connect(voiceGain);
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
      currentShaperKind: 'cylindrical_reed',
      osc,
      vibOsc,
      vibDepth,
      driveGain,
      shaper,
      bodyFormant,
      bellLowpass,
      voiceGain,
      noiseFilter,
      noiseGain,
    });
  }

  const bank: NativeWindBankState = {
    masterGain,
    dryGain,
    roomWetGain,
    noiseSource,
    slots,
    curves,
  };
  c.__physboxNativeWindV10 = bank;
  return bank;
}

export function getOrInitModalWorklet(ctx: AudioContext): GainNode | null {
  return ensureNativeWindBank(ctx)?.masterGain ?? null;
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
      slot.voiceGain.gain.setTargetAtTime(0, now, 0.016);
      slot.noiseGain.gain.setTargetAtTime(0, now, 0.014);
      slot.vibDepth.gain.setTargetAtTime(0, now, 0.02);
      slot.wasActive = false;
      continue;
    }

    const desiredCurve = selectShaperKind(v);
    if (slot.currentShaperKind !== desiredCurve) {
      slot.shaper.curve = bank.curves[desiredCurve];
      slot.currentShaperKind = desiredCurve;
    }

    // Snap oscillator frequency cleanly BEFORE ramping gain from silence so attacks never chirp from stale notes!
    if (!slot.wasActive || isNewId) {
      slot.osc.frequency.cancelScheduledValues(now);
      slot.osc.frequency.setValueAtTime(solved.pitchHz, now);
    } else {
      slot.osc.frequency.setTargetAtTime(solved.pitchHz, now, 0.007);
    }

    slot.driveGain.gain.setTargetAtTime(solved.drive, now, 0.018);
    slot.bodyFormant.frequency.setTargetAtTime(solved.formantHz, now, 0.020);
    slot.bodyFormant.gain.setTargetAtTime(solved.formantGainDb, now, 0.020);
    slot.bellLowpass.frequency.setTargetAtTime(solved.bellLowpassHz, now, 0.018);
    slot.bellLowpass.Q.setTargetAtTime(solved.bellQ, now, 0.020);

    slot.voiceGain.gain.setTargetAtTime(solved.amplitude, now, 0.018);
    slot.noiseFilter.frequency.setTargetAtTime(Math.min(2800, solved.pitchHz * 2.4), now, 0.022);
    slot.noiseGain.gain.setTargetAtTime(solved.noiseGain, now, 0.018);
    slot.vibDepth.gain.setTargetAtTime(solved.pitchHz * 0.0026 * Math.min(1, solved.amplitude * 4), now, 0.06);

    slot.wasActive = true;
  }

  for (let i = 0; i < bank.slots.length; i++) {
    if (!usedSlots.has(i)) {
      const slot = bank.slots[i];
      slot.voiceGain.gain.setTargetAtTime(0, now, 0.015);
      slot.noiseGain.gain.setTargetAtTime(0, now, 0.014);
      slot.vibDepth.gain.setTargetAtTime(0, now, 0.02);
      slot.wasActive = false;
    }
  }
}

export function postWorkletWindSilence(ctx: AudioContext | null): void {
  if (!ctx) return;
  const c = ctx as AudioContextWithWindGraph;
  disconnectLegacyGraphs(c);
  const bank = c.__physboxNativeWindV10;
  if (!bank) return;
  const now = ctx.currentTime;
  for (const slot of bank.slots) {
    slot.voiceGain.gain.cancelScheduledValues(now);
    slot.voiceGain.gain.setTargetAtTime(0, now, 0.014);
    slot.noiseGain.gain.cancelScheduledValues(now);
    slot.noiseGain.gain.setTargetAtTime(0, now, 0.012);
    slot.vibDepth.gain.cancelScheduledValues(now);
    slot.vibDepth.gain.setTargetAtTime(0, now, 0.015);
    slot.wasActive = false;
  }
}
