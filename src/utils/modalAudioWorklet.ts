// ---------------------------------------------------------------------------
// Native C++ WebAudio Physical Bore & Reed / Lip / Jet Synthesizer
// ---------------------------------------------------------------------------
//
// Runs 100% dry on the real-time C++ WebAudio rendering thread (`OscillatorNode`,
// 4x-oversampled `WaveShaperNode`, dual `BiquadFilterNode` bore/bell impedance
// shapers, and filtered breath-turbulence `BufferSourceNode` — zero artificial
// reverb/delay, zero `ScriptProcessorNode`, zero main-thread JS sample loops,
// and zero buffer-underrun pops/clicks!).
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
  noiseSource: AudioBufferSourceNode | null;
  slots: NativeWindVoiceSlot[];
  curves: Record<ShaperKind, Float32Array<ArrayBuffer>>;
}

interface LegacyWindGraphState {
  outGain?: GainNode;
  masterGain?: GainNode;
  dryGain?: GainNode;
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
  __physboxNativeWindV11?: NativeWindBankState;
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
    '__physboxNativeWindV10',
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
      try { prev.roomWetGain?.disconnect(); } catch { /* ignore */ }
      try { prev.masterGain?.disconnect(); } catch { /* ignore */ }
      delete c[oldKey];
    }
  }
}

function ensureNativeWindBank(ctx: AudioContext): NativeWindBankState | null {
  const c = ctx as AudioContextWithWindGraph;
  disconnectLegacyGraphs(c);
  if (c.__physboxNativeWindV11) return c.__physboxNativeWindV11;
  if (typeof ctx.createOscillator !== 'function' || typeof ctx.createWaveShaper !== 'function') {
    return null;
  }

  const curves = buildExciterCurves();
  const now = ctx.currentTime;

  // 100% pure dry output straight to destination (no reverb or room delay!)
  const masterGain = ctx.createGain();
  masterGain.gain.setValueAtTime(0.88, now);
  masterGain.connect(ctx.destination);

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
    vibOsc.frequency.setValueAtTime(4.8 + i * 0.2, now);

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
    noiseSource,
    slots,
    curves,
  };
  c.__physboxNativeWindV11 = bank;
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
      slot.voiceGain.gain.setTargetAtTime(0, now, 0.009);
      slot.noiseGain.gain.setTargetAtTime(0, now, 0.008);
      slot.vibDepth.gain.setTargetAtTime(0, now, 0.012);
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
      slot.osc.frequency.setTargetAtTime(solved.pitchHz, now, 0.006);
    }

    slot.driveGain.gain.setTargetAtTime(solved.drive, now, 0.014);
    slot.bodyFormant.frequency.setTargetAtTime(solved.formantHz, now, 0.016);
    slot.bodyFormant.gain.setTargetAtTime(solved.formantGainDb, now, 0.016);
    slot.bellLowpass.frequency.setTargetAtTime(solved.bellLowpassHz, now, 0.014);
    slot.bellLowpass.Q.setTargetAtTime(solved.bellQ, now, 0.016);

    slot.voiceGain.gain.setTargetAtTime(solved.amplitude, now, 0.012);
    slot.noiseFilter.frequency.setTargetAtTime(Math.min(2800, solved.pitchHz * 2.4), now, 0.018);
    slot.noiseGain.gain.setTargetAtTime(solved.noiseGain, now, 0.012);
    slot.vibDepth.gain.setTargetAtTime(solved.pitchHz * 0.0022 * Math.min(1, solved.amplitude * 4), now, 0.05);

    slot.wasActive = true;
  }

  for (let i = 0; i < bank.slots.length; i++) {
    if (!usedSlots.has(i)) {
      const slot = bank.slots[i];
      slot.voiceGain.gain.setTargetAtTime(0, now, 0.009);
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
  const bank = c.__physboxNativeWindV11;
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
