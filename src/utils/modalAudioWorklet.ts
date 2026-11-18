// ---------------------------------------------------------------------------
// Native C++ WebAudio Physical Bore & Reed / Lip / Jet Synthesizer
// ---------------------------------------------------------------------------
//
// Runs 100% on the real-time C++ WebAudio rendering thread (`OscillatorNode`,
// 4x-oversampled `WaveShaperNode` physical aperture curves, 24 dB/oct cascaded
// bore/bell `BiquadFilterNode` impedance shapers with Risset amplitude-coupled
// harmonic bloom, filtered breath-turbulence `BufferSourceNode`, and native C++
// `ConvolverNode` stereo studio-chamber acoustic presence).
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

type ShaperKind = 'cylindrical_reed' | 'brass_lip_pulse' | 'conical_reed' | 'flute_jet';

interface NativeWindVoiceSlot {
  id: string;
  wasActive: boolean;
  lastPitchHz: number;
  currentShaperKind: ShaperKind;
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
  curves: Record<ShaperKind, Float32Array<ArrayBuffer>>;
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
  __physboxNativeWindV12?: NativeWindBankState;
};

function buildExciterCurves(): Record<ShaperKind, Float32Array<ArrayBuffer>> {
  const N = 2049;
  const cyl = new Float32Array(new ArrayBuffer(N * 4));
  const lip = new Float32Array(new ArrayBuffer(N * 4));
  const cone = new Float32Array(new ArrayBuffer(N * 4));
  const flute = new Float32Array(new ArrayBuffer(N * 4));

  const cylAsym = 0.055;
  const cylK = 2.35;
  const cylDc = Math.tanh(cylK * cylAsym * 0.5);

  // Smooth C^infinity Gaussian outward-striking lip-aperture flow pulse:
  // Strong, warm, golden 1st..5th brass harmonics with super-exponential suppression of harsh upper buzz!
  const lipCenter = 0.52;
  const lipAlpha = 2.35;
  const lipFloor = Math.exp(-lipAlpha * lipCenter * lipCenter);

  const coneBias = 0.36;
  const coneK = 2.0;
  const coneDc = Math.tanh(coneK * coneBias);

  const fluteBias = 0.16;
  const fluteK = 1.25;
  const fluteDc = Math.tanh(fluteK * fluteBias);

  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * 2 - 1;
    // 1. Cylindrical quarter-wave reed: predominantly odd harmonics (f, 3f, 5f, 7f)
    cyl[i] = Math.tanh(cylK * (x + cylAsym * (x * x - 0.5))) - cylDc * 0.1;
    // 2. Brass lip-aperture flow pulse: smooth Gaussian bell opening once per lip cycle
    const dx = x - lipCenter;
    lip[i] = (Math.exp(-lipAlpha * dx * dx) - lipFloor) * 1.35;
    // 3. Conical reed: smooth asymmetric hyperbolic tangent
    cone[i] = (Math.tanh(coneK * (x + coneBias)) - coneDc) * 0.9;
    // 4. Air-jet flute: gentle fundamental + subtle 2nd/3rd harmonic
    flute[i] = (Math.tanh(fluteK * (x + fluteBias)) - fluteDc) * 0.92;
  }

  return {
    cylindrical_reed: cyl,
    brass_lip_pulse: lip,
    conical_reed: cone,
    flute_jet: flute,
  };
}

/** Synthesizes a natural, warm 1.05s stereo studio-chamber / recital-stage impulse response. */
function buildStudioChamberIR(ctx: AudioContext): AudioBuffer {
  const sr = ctx.sampleRate || 48000;
  const dur = 1.05;
  const len = Math.floor(sr * dur);
  const ir = ctx.createBuffer(2, len, sr);
  const left = ir.getChannelData(0);
  const right = ir.getChannelData(1);

  // Decorrelated early stage reflections (12..54 ms) for realistic 3D instrument presence
  const earlyL: [number, number][] = [
    [0.011, 0.34],
    [0.019, -0.24],
    [0.031, 0.19],
    [0.047, 0.14],
  ];
  const earlyR: [number, number][] = [
    [0.014, 0.32],
    [0.023, -0.25],
    [0.036, 0.18],
    [0.053, 0.13],
  ];
  for (const [tSec, amp] of earlyL) {
    const idx = Math.floor(tSec * sr);
    if (idx < len) left[idx] += amp;
  }
  for (const [tSec, amp] of earlyR) {
    const idx = Math.floor(tSec * sr);
    if (idx < len) right[idx] += amp;
  }

  // Smoothly damped diffuse wooden recital-room tail (air absorption lowpass + low-mud cut)
  let seedL = 0x2468ace1;
  let seedR = 0x9e3779b9;
  let lpL = 0, lpR = 0;
  let hpL = 0, hpR = 0;
  for (let i = Math.floor(0.010 * sr); i < len; i++) {
    const t = i / sr;
    const env = Math.exp(-t / 0.28) * (1 - Math.exp(-t / 0.018));
    seedL = (Math.imul(seedL, 1664525) + 1013904223) | 0;
    seedR = (Math.imul(seedR, 22695477) + 1) | 0;
    const wL = seedL / 2147483648;
    const wR = seedR / 2147483648;
    // Progressive high-frequency wall absorption
    const damp = 0.34 * Math.exp(-t * 1.4) + 0.08;
    lpL += damp * (wL - lpL);
    lpR += damp * (wR - lpR);
    // Gentle 130 Hz highpass so room tail stays airy and clear
    hpL += 0.018 * (lpL - hpL);
    hpR += 0.018 * (lpR - hpR);
    left[i] += (lpL - hpL) * env * 0.26;
    right[i] += (lpR - hpR) * env * 0.26;
  }

  return ir;
}

function selectShaperKind(p: WorkletWindVoicePayload): ShaperKind {
  if (p.exciter === 'flute_jet') return 'flute_jet';
  if (p.exciter === 'brass_lip') return 'brass_lip_pulse';
  const shape = p.boreShape ?? 'cylindrical';
  return shape === 'cylindrical' ? 'cylindrical_reed' : 'conical_reed';
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
  if (c.__physboxNativeWindV12) return c.__physboxNativeWindV12;
  if (typeof ctx.createOscillator !== 'function' || typeof ctx.createWaveShaper !== 'function') {
    return null;
  }

  const curves = buildExciterCurves();
  const now = ctx.currentTime;

  const masterGain = ctx.createGain();
  masterGain.gain.setValueAtTime(0.95, now);

  // Subtle acoustic presence lift around 1.9 kHz so woodwinds & brass project forward cleanly
  const presenceShelf = ctx.createBiquadFilter();
  presenceShelf.type = 'peaking';
  presenceShelf.frequency.setValueAtTime(1850, now);
  presenceShelf.Q.setValueAtTime(0.85, now);
  presenceShelf.gain.setValueAtTime(2.6, now);

  const dryGain = ctx.createGain();
  dryGain.gain.setValueAtTime(0.86, now);
  const wetGain = ctx.createGain();
  wetGain.gain.setValueAtTime(0.28, now);

  masterGain.connect(presenceShelf);
  presenceShelf.connect(dryGain);
  dryGain.connect(ctx.destination);

  let convolver: ConvolverNode | null = null;
  if (typeof ctx.createConvolver === 'function' && typeof ctx.createBuffer === 'function') {
    convolver = ctx.createConvolver();
    convolver.normalize = false;
    convolver.buffer = buildStudioChamberIR(ctx);
    presenceShelf.connect(convolver);
    convolver.connect(wetGain);
    wetGain.connect(ctx.destination);
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
    driveGain.gain.setValueAtTime(0.5, now);

    const shaper = ctx.createWaveShaper();
    shaper.curve = curves.cylindrical_reed;
    shaper.oversample = '4x';

    const bodyFormant = ctx.createBiquadFilter();
    bodyFormant.type = 'peaking';
    bodyFormant.frequency.setValueAtTime(850, now);
    bodyFormant.Q.setValueAtTime(1.2, now);
    bodyFormant.gain.setValueAtTime(4.0, now);

    // 24 dB/oct dual-stage bell radiation filter eliminates thin upper-harmonic buzz while keeping warm horn core
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
      currentShaperKind: 'cylindrical_reed',
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
    curves,
  };
  c.__physboxNativeWindV12 = bank;
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
      // Risset release tuck: upper harmonics fold cleanly into warm fundamental as breath stops!
      const tuckHz = Math.max(320, slot.lastPitchHz * 1.35);
      slot.bellLowpass1.frequency.setTargetAtTime(tuckHz, now, 0.010);
      slot.bellLowpass2.frequency.setTargetAtTime(tuckHz * 1.25, now, 0.010);
      slot.driveGain.gain.setTargetAtTime(0.28, now, 0.010);
      slot.voiceGain.gain.setTargetAtTime(0, now, 0.010);
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

    const isFreshAttack = !slot.wasActive || isNewId;
    slot.lastPitchHz = solved.pitchHz;

    // Snap oscillator frequency cleanly BEFORE ramping gain from silence so attacks never chirp!
    if (isFreshAttack) {
      slot.osc.frequency.cancelScheduledValues(now);
      slot.osc.frequency.setValueAtTime(solved.pitchHz, now);
      // Risset brass/reed attack bloom: start warm on fundamental, then bloom harmonics over ~25 ms!
      const warmStartHz = Math.max(420, solved.pitchHz * 1.45);
      slot.bellLowpass1.frequency.cancelScheduledValues(now);
      slot.bellLowpass1.frequency.setValueAtTime(warmStartHz, now);
      slot.bellLowpass2.frequency.cancelScheduledValues(now);
      slot.bellLowpass2.frequency.setValueAtTime(warmStartHz * 1.3, now);
    } else {
      slot.osc.frequency.setTargetAtTime(solved.pitchHz, now, 0.006);
    }

    slot.driveGain.gain.setTargetAtTime(solved.drive, now, 0.018);
    slot.bodyFormant.frequency.setTargetAtTime(solved.formantHz, now, 0.016);
    slot.bodyFormant.gain.setTargetAtTime(solved.formantGainDb, now, 0.016);
    slot.bellLowpass1.frequency.setTargetAtTime(solved.bellLowpassHz, now, 0.022);
    slot.bellLowpass1.Q.setTargetAtTime(solved.bellQ, now, 0.018);
    slot.bellLowpass2.frequency.setTargetAtTime(solved.bellLowpassHz * 1.32, now, 0.022);

    slot.voiceGain.gain.setTargetAtTime(solved.amplitude, now, 0.011);
    slot.noiseFilter.frequency.setTargetAtTime(Math.min(2800, solved.pitchHz * 2.3), now, 0.018);
    if (isFreshAttack && v.exciter === 'brass_lip') {
      // Crisp 18 ms tongued mouthpiece articulation chiff settling into quiet breath sustain
      slot.noiseGain.gain.cancelScheduledValues(now);
      slot.noiseGain.gain.setValueAtTime(solved.amplitude * 0.08, now);
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
  const bank = c.__physboxNativeWindV12;
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
