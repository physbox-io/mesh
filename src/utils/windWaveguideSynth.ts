// ---------------------------------------------------------------------------
// Generic 1D Kelly–Lochbaum Bore + Thiran Fractional-Boundary Waveguide Synth
// ---------------------------------------------------------------------------
//
// Pure 1D acoustic waveguide sliced directly from 3D CAD geometry:
//   - M spatial scattering junctions `k[c] = (A_c - A_{c+1}) / (A_c + A_{c+1})`
//   - 3-port open-tonehole shunts `shunt[c]`
//   - 1st-order Thiran allpass fractional boundary termination at `x = L` so
//     continuous millimeter geometry edits vary pitch smoothly without 48 kHz
//     7.3 mm grid quantization jumps!
//   - Passive pressure-controlled exciters (`reed`, `brass_lip`, `flute_jet`)
//     that lock phase-coherently onto the bore's own standing-wave modes
//     (zero autonomous free-air oscillators -> zero wolf-tone intermodulation!).
// ---------------------------------------------------------------------------

import type { WindExciterKind } from '../types/scene';

export interface WindVoiceConfig {
  id: string;
  exciter: WindExciterKind;
  breathKPa: number;
  embouchureHz: number;
  cellCount: number;
  exactCells?: number;
  junctionK: number[];
  bellCutoffHz: number;
  shunts: { cell: number; coeff: number }[];
  gain?: number;
}

const MAX_BORE_CELLS = 180;

interface WindSlot {
  id: string;
  active: boolean;
  exciter: number; // 0 = reed, 1 = brass_lip, 2 = flute_jet
  targetBreath: number;
  breathEnv: number;
  embouchureHz: number;
  smoothEmbHz: number;
  cellCount: number;
  thiranEta: number;
  apX1: number;
  apY1: number;
  pPlus: Float64Array;
  pMinus: Float64Array;
  nextPlus: Float64Array;
  nextMinus: Float64Array;
  k: Float64Array;
  shunt: Float64Array;
  holeState: Float64Array;
  bellAlpha: number;
  bellLp: number;
  reedLp: number;
  outLp1: number;
  outLp2: number;
  lipY: number;
  lipV: number;
  vibPhase: number;
  dcX1: number;
  dcY1: number;
  gain: number;
}

function createWindSlot(): WindSlot {
  return {
    id: '',
    active: false,
    exciter: 0,
    targetBreath: 0,
    breathEnv: 0,
    embouchureHz: 320,
    smoothEmbHz: 320,
    cellCount: 32,
    thiranEta: 0,
    apX1: 0,
    apY1: 0,
    pPlus: new Float64Array(MAX_BORE_CELLS),
    pMinus: new Float64Array(MAX_BORE_CELLS),
    nextPlus: new Float64Array(MAX_BORE_CELLS),
    nextMinus: new Float64Array(MAX_BORE_CELLS),
    k: new Float64Array(MAX_BORE_CELLS),
    shunt: new Float64Array(MAX_BORE_CELLS),
    holeState: new Float64Array(MAX_BORE_CELLS),
    bellAlpha: 0.25,
    bellLp: 0,
    reedLp: 0,
    outLp1: 0,
    outLp2: 0,
    lipY: 0,
    lipV: 0,
    vibPhase: 0,
    dcX1: 0,
    dcY1: 0,
    gain: 0.75,
  };
}

export class KellyLochbaumSynthBank {
  private readonly slots: WindSlot[];
  private rng = 0x2468ace1;
  private sampleRate: number;

  constructor(sampleRate = 48000, maxSlots = 4) {
    this.sampleRate = sampleRate;
    this.slots = Array.from({ length: maxSlots }, () => createWindSlot());
  }

  setSampleRate(sr: number): void {
    if (sr > 8000) this.sampleRate = sr;
  }

  silenceAll(): void {
    for (let i = 0; i < this.slots.length; i++) {
      this.slots[i].targetBreath = 0;
    }
  }

  hasActiveAudio(): boolean {
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.active && (s.targetBreath > 0.0008 || s.breathEnv > 0.0004)) return true;
    }
    return false;
  }

  updateVoices(voices: WindVoiceConfig[]): void {
    const sr = this.sampleRate;
    const seen = new Set<string>();

    for (let vIdx = 0; vIdx < voices.length && vIdx < this.slots.length; vIdx++) {
      const cfg = voices[vIdx];
      if (!cfg || !cfg.id) continue;
      seen.add(cfg.id);

      let slot: WindSlot | null = null;
      for (let i = 0; i < this.slots.length; i++) {
        if (this.slots[i].id === cfg.id) {
          slot = this.slots[i];
          break;
        }
      }
      if (!slot) {
        for (let i = 0; i < this.slots.length; i++) {
          if (!this.slots[i].active) {
            slot = this.slots[i];
            slot.id = cfg.id;
            slot.pPlus.fill(0);
            slot.pMinus.fill(0);
            slot.holeState.fill(0);
            slot.apX1 = 0;
            slot.apY1 = 0;
            slot.bellLp = 0;
            slot.reedLp = 0;
            slot.outLp1 = 0;
            slot.outLp2 = 0;
            slot.lipY = 0;
            slot.lipV = 0;
            slot.smoothEmbHz = Math.max(60, Math.min(2000, cfg.embouchureHz || 320));
            break;
          }
        }
      }
      if (!slot) continue;

      const fBell = Math.max(420, Math.min(sr * 0.42, cfg.bellCutoffHz || 1500));
      const rc = 1 / (2 * Math.PI * fBell);
      const dt = 1 / sr;
      slot.bellAlpha = dt / (rc + dt);

      slot.exciter = cfg.exciter === 'brass_lip' ? 1 : cfg.exciter === 'flute_jet' ? 2 : 0;
      const rawKPa = Math.max(0, cfg.breathKPa || 0);
      slot.targetBreath = rawKPa < 0.08
        ? 0
        : slot.exciter === 0
          ? 0.42 + 0.34 * Math.tanh((rawKPa - 0.5) / 3.2)
          : Math.max(0, Math.min(0.90, rawKPa / 5.2));
      slot.embouchureHz = Math.max(60, Math.min(2000, cfg.embouchureHz || 320));
      slot.gain = cfg.gain ?? (slot.exciter === 1 ? 0.78 : 0.90);

      // Exact analytical 1-pole phase delay compensation `atan2((1-a)*sin(w), 1-(1-a)*cos(w)) / w`
      // for both in-loop filters (`bellLp` + `reedLp`) so discrete cells + Thiran `thiranEta`
      // resonate at the exact physical acoustic frequency without flat dispersion drift!
      const rawExact = cfg.exactCells ?? cfg.cellCount;
      const loopCutHz = slot.exciter === 0
        ? Math.min(sr * 0.35, Math.max(280, slot.embouchureHz * 1.75))
        : Math.min(sr * 0.4, Math.max(450, slot.embouchureHz * 2.6));
      const alphaLoop = dt / (1 / (2 * Math.PI * loopCutHz) + dt);
      const fRef = slot.exciter === 0
        ? sr / Math.max(16, 4 * rawExact)
        : Math.max(120, Math.min(1200, slot.embouchureHz * 0.92));
      const wRef = (2 * Math.PI * fRef) / sr;
      const onePolePhaseDelay = (a: number): number => {
        const b = 1 - a;
        return Math.atan2(b * Math.sin(wRef), 1 - b * Math.cos(wRef)) / Math.max(1e-6, wRef);
      };
      const loopLagSamples = onePolePhaseDelay(slot.bellAlpha) + onePolePhaseDelay(alphaLoop);
      // 1 spatial waveguide cell = 2 round-trip samples
      const compensatedExact = Math.max(6.2, Math.min(MAX_BORE_CELLS - 2, rawExact - 0.5 * loopLagSamples));
      const M = Math.max(6, Math.min(MAX_BORE_CELLS - 2, Math.floor(compensatedExact)));
      const remRoundTrip = Math.max(0.15, Math.min(1.85, 2 * (compensatedExact - M)));
      slot.thiranEta = (1 - remRoundTrip) / (1 + remRoundTrip);

      if (slot.cellCount !== M) {
        if (M > slot.cellCount) {
          const tailP = slot.pPlus[Math.max(0, slot.cellCount - 1)];
          const tailM = slot.pMinus[Math.max(0, slot.cellCount - 1)];
          for (let c = slot.cellCount; c < M; c++) {
            slot.pPlus[c] = tailP;
            slot.pMinus[c] = tailM;
          }
        }
        slot.cellCount = M;
      }

      const jk = cfg.junctionK || [];
      slot.k.fill(0);
      if (jk.length > 0 && M >= 2) {
        for (let i = 0; i < M - 1; i++) {
          const srcIdx = Math.min(jk.length - 1, Math.round((i * (jk.length - 1)) / Math.max(1, M - 2)));
          slot.k[i] = Math.max(-0.92, Math.min(0.92, jk[srcIdx]));
        }
      }

      slot.shunt.fill(0);
      const shunts = cfg.shunts || [];
      const cellScale = (M - 1) / Math.max(1, (cfg.cellCount || M) - 1);
      for (let s = 0; s < shunts.length; s++) {
        const ci = Math.round(shunts[s].cell * cellScale);
        if (ci >= 1 && ci < M - 1) {
          slot.shunt[ci] = Math.max(-0.92, Math.min(0, shunts[s].coeff || 0));
        }
      }

      slot.active = true;
    }

    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.active && !seen.has(s.id)) {
        s.targetBreath = 0;
      }
    }
  }

  private nextNoise(): number {
    let x = this.rng | 0;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    this.rng = x;
    return x / 2147483648;
  }

  render(outL: Float32Array, outR?: Float32Array): void {
    const nFrames = outL.length;
    outL.fill(0);
    if (!this.hasActiveAudio()) {
      if (outR) outR.fill(0);
      for (let w = 0; w < this.slots.length; w++) {
        if (this.slots[w].active && this.slots[w].breathEnv < 0.0005 && this.slots[w].targetBreath < 0.001) {
          this.slots[w].active = false;
          this.slots[w].id = '';
        }
      }
      return;
    }

    const sr = this.sampleRate;
    const dt = 1 / sr;
    const vibInc = (2 * Math.PI * 4.8) / sr;

    for (let w = 0; w < this.slots.length; w++) {
      const ws = this.slots[w];
      if (!ws.active) continue;
      if (ws.targetBreath < 0.001 && ws.breathEnv < 0.0004) {
        ws.active = false;
        ws.id = '';
        continue;
      }

      const M = ws.cellCount;
      const kArr = ws.k;
      const shArr = ws.shunt;
      const hState = ws.holeState;
      const bellAlpha = ws.bellAlpha;
      const eta = ws.thiranEta;
      const exc = ws.exciter;

      // Reed/lip mechanical compliance lowpass (~1.75 * embouchureHz):
      // Guarantees the fundamental bore mode wins cleanly over 3*f1 / 5*f1 squeak modes,
      // while the nonlinear valve still injects rich upper harmonics into the forward wave!
      const loopCutHz = exc === 0
        ? Math.min(sr * 0.35, Math.max(280, ws.embouchureHz * 1.75))
        : Math.min(sr * 0.4, Math.max(450, ws.embouchureHz * 2.6));
      const alphaLoop = dt / (1 / (2 * Math.PI * loopCutHz) + dt);
      // Universal spherical radiation smoothing filter (~1800–2800 Hz depending on breath)
      const radCutHz = Math.min(sr * 0.4, 1300 + 1800 * Math.max(0.2, ws.targetBreath));
      const alphaRad = dt / (1 / (2 * Math.PI * radCutHz) + dt);

      for (let i = 0; i < nFrames; i++) {
        ws.breathEnv += 0.0011 * (ws.targetBreath - ws.breathEnv);
        ws.smoothEmbHz += 0.0020 * (ws.embouchureHz - ws.smoothEmbHz);
        ws.vibPhase += vibInc;
        if (ws.vibPhase > Math.PI * 2) ws.vibPhase -= Math.PI * 2;

        const vib = 1 + 0.011 * Math.sin(ws.vibPhase);
        const turb = exc === 2 ? 0.05 : 0.007;
        const pMouth = ws.breathEnv * vib * (1 + turb * this.nextNoise());

        // Open-end Thiran fractional boundary cell + spherical radiation reflection/transmission
        const pIncEnd = ws.pPlus[M - 1];
        const pEnd = eta * pIncEnd + ws.apX1 - eta * ws.apY1;
        ws.apX1 = pIncEnd;
        ws.apY1 = pEnd;

        ws.bellLp += bellAlpha * (pEnd - ws.bellLp);
        const pReflBell = -0.968 * ws.bellLp;
        let radiated = (pEnd - ws.bellLp) * 0.88 + 0.44 * ws.bellLp;

        // Passive pressure-controlled valve exciters coupled strictly to returning bore wave pBack0
        let pIn0: number;
        const pBack0 = ws.pMinus[0];
        ws.reedLp += alphaLoop * (pBack0 - ws.reedLp);

        if (exc === 0) {
          // Inward-striking compliant reed valve (smooth C^2 cubic pressure-reflection curve):
          const dp = pMouth - ws.reedLp;
          const dc = Math.max(-1.1, Math.min(1.1, dp));
          let rReed = 0.24 + 0.88 * dc - 0.16 * dc * dc * dc;
          if (rReed < -0.90) rReed = -0.90;
          else if (rReed > 0.97) rReed = 0.97;
          pIn0 = pMouth - rReed * dp;
        } else if (exc === 1) {
          // Passive bandpass-coupled 1-DOF lip-reed valve:
          // `vBp = lipV / (omegaLip * Q)` has exact +1.0 gain and 0° phase at `smoothEmbHz`,
          // rolling off both lower pedal modes and upper squeaks while remaining 100% passive
          // in free air (`reedLp == 0` -> zero free-air buzz, zero dual-oscillator growl)!
          const qLip = 3.6;
          const omegaLip = 2 * Math.PI * ws.smoothEmbHz;
          const omegaLipSq = omegaLip * omegaLip;
          const dampLip = omegaLip / qLip;

          const acc = omegaLipSq * (ws.reedLp - ws.lipY - 0.35 * ws.lipY * ws.lipY * ws.lipY) - dampLip * ws.lipV;
          ws.lipV += dt * acc;
          ws.lipY += dt * ws.lipV;
          if (ws.lipY < -1.2) {
            ws.lipY = -1.2;
            ws.lipV *= -0.15;
          } else if (ws.lipY > 1.2) {
            ws.lipY = 1.2;
            ws.lipV *= -0.15;
          }

          const vBp = ws.lipV / Math.max(20, omegaLip * qLip);
          const lipOpen = Math.max(0, 0.24 + 2.85 * vBp);
          const dp = pMouth - 0.55 * ws.reedLp;
          const flow = lipOpen * Math.tanh(dp * 1.6) * 0.72;
          pIn0 = 0.94 * ws.reedLp + flow;
        } else {
          // Air-jet edge excitation
          const jet = Math.tanh((pMouth * 1.4 - 0.85 * ws.reedLp) * 2.6) * pMouth * 0.50;
          pIn0 = 0.88 * ws.reedLp + jet;
        }

        if (pIn0 > 1.5) pIn0 = 1.5;
        else if (pIn0 < -1.5) pIn0 = -1.5;

        // 1-multiply Kelly–Lochbaum spatial scattering ladder + open tonehole shunts
        const nPlus = ws.nextPlus;
        const nMinus = ws.nextMinus;
        nPlus[0] = pIn0;
        nMinus[M - 1] = pReflBell;
        for (let c = 0; c < M - 1; c++) {
          let fp = ws.pPlus[c];
          let bm = ws.pMinus[c + 1];
          const sh = shArr[c];
          if (sh < -0.001) {
            // Scavone–Smith 1-pole lossless acoustic inertance tonehole shunt:
            const aHole = Math.min(0.96, Math.sqrt(-sh) * 1.04);
            const targetW = -0.985 * (fp + bm);
            hState[c] += aHole * (targetW - hState[c]);
            const w = hState[c];
            fp += w;
            bm += w;
            radiated -= w * 0.62;
          } else {
            hState[c] *= 0.85;
          }
          const d = kArr[c] * (fp - bm);
          nPlus[c + 1] = (fp + d) * 0.9995;
          nMinus[c] = (bm + d) * 0.9995;
        }

        const tmpP = ws.pPlus;
        ws.pPlus = nPlus;
        ws.nextPlus = tmpP;
        const tmpM = ws.pMinus;
        ws.pMinus = nMinus;
        ws.nextMinus = tmpM;

        // Universal 2-pole radiation smoothing + DC blocker
        ws.outLp1 += alphaRad * (radiated - ws.outLp1);
        ws.outLp2 += alphaRad * (ws.outLp1 - ws.outLp2);
        const dcOut = ws.outLp2 - ws.dcX1 + 0.995 * ws.dcY1;
        ws.dcX1 = ws.outLp2;
        ws.dcY1 = dcOut;
        outL[i] += dcOut * ws.gain;
      }
    }

    for (let i = 0; i < nFrames; i++) {
      const s = outL[i];
      const lim = (s > 0.28 || s < -0.28) ? Math.tanh(s * 1.1) * 0.82 : s;
      outL[i] = lim;
      if (outR) outR[i] = lim;
    }
  }
}
