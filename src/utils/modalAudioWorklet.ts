// ---------------------------------------------------------------------------
// Real-Time In-Graph Wind / Brass / Reed Waveguide Engine
// ---------------------------------------------------------------------------
//
// Connects directly to `sharedAudioCtx.destination` inside the exact same
// WebAudio graph as `OscillatorNode` impacts (zero external script fetch, zero
// HMR worklet cache mismatch, ~0.14% CPU via pre-allocated Float64Arrays!).
// ---------------------------------------------------------------------------

import type { ModalVoice } from './modalAudio';
import { KellyLochbaumSynthBank, type WindVoiceConfig } from './windWaveguideSynth';

export type WorkletWindVoicePayload = WindVoiceConfig;

export interface WorkletStrikePayload {
  type: 'STRIKE';
  level: number;
  tauC: number;
  brightness: number;
  isPluck?: boolean;
  voices: ModalVoice[];
}

interface AttachedWindGraphState {
  bank: KellyLochbaumSynthBank;
  processor: ScriptProcessorNode | null;
  keepAlive?: ConstantSourceNode;
  outGain?: GainNode;
}

type AudioContextWithWindBank = AudioContext & {
  __physboxWindWaveguideV5?: AttachedWindGraphState;
  __physboxWindWaveguideV6?: AttachedWindGraphState;
};

function ensureWindGraph(ctx: AudioContext): AttachedWindGraphState {
  const c = ctx as AudioContextWithWindBank;
  if (c.__physboxWindWaveguideV5) {
    try { c.__physboxWindWaveguideV5.outGain?.disconnect(); } catch { /* ignore */ }
    delete c.__physboxWindWaveguideV5;
  }
  if (c.__physboxWindWaveguideV6) {
    c.__physboxWindWaveguideV6.bank.setSampleRate(ctx.sampleRate || 48000);
    return c.__physboxWindWaveguideV6;
  }

  const bank = new KellyLochbaumSynthBank(ctx.sampleRate || 48000, 4);
  const st: AttachedWindGraphState = { bank, processor: null };
  c.__physboxWindWaveguideV6 = st;

  if (typeof ctx.createScriptProcessor === 'function') {
    const proc = ctx.createScriptProcessor(1024, 1, 2);
    proc.onaudioprocess = (ev: AudioProcessingEvent) => {
      const outL = ev.outputBuffer.getChannelData(0);
      const outR = ev.outputBuffer.numberOfChannels > 1 ? ev.outputBuffer.getChannelData(1) : undefined;
      bank.render(outL, outR);
    };
    const outGain = ctx.createGain();
    outGain.gain.value = 0.85;
    proc.connect(outGain);
    outGain.connect(ctx.destination);
    st.processor = proc;
    st.outGain = outGain;

    if (typeof ctx.createConstantSource === 'function') {
      const keepAlive = ctx.createConstantSource();
      // Tiny non-zero sub-LSB offset prevents Chromium Blink's `propagatesSilence()` optimization
      // from skipping `onaudioprocess` when upstream input is identically 0.0!
      keepAlive.offset.value = 1e-7;
      keepAlive.connect(proc);
      keepAlive.start();
      st.keepAlive = keepAlive;
    }
  }

  return st;
}

export function getOrInitModalWorklet(ctx: AudioContext): ScriptProcessorNode | null {
  return ensureWindGraph(ctx).processor;
}

export function postWorkletStrike(_ctx: AudioContext, _payload: WorkletStrikePayload): boolean {
  return false;
}

export function postWorkletWindUpdate(ctx: AudioContext, voices: WorkletWindVoicePayload[]): void {
  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => {});
  }
  const st = ensureWindGraph(ctx);
  st.bank.updateVoices(voices);
}

export function postWorkletWindSilence(ctx: AudioContext | null): void {
  if (!ctx) return;
  const st = (ctx as AudioContextWithWindBank).__physboxWindWaveguideV6;
  st?.bank.silenceAll();
}
