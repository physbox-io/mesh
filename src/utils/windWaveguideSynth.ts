// ---------------------------------------------------------------------------
// Generic 1D Kelly–Lochbaum Bore + 2nd-Order Thiran Waveguide Synth
// ---------------------------------------------------------------------------
//
// Pure 1D acoustic waveguide sliced directly from 3D CAD geometry:
//   - M spatial scattering junctions `k[c] = (A_c - A_{c+1}) / (A_c + A_{c+1})`
//     with exact log-area taper preservation across arbitrary sample rates
//   - 3-port parallel open-tonehole shunts `shunt[c]`
//   - 2nd-order Thiran allpass fractional boundary termination (`D ∈ [1.5, 3.5)`,
//     all poles strictly inside `|z_p| <= 0.462`, zero quantization dead-zones!)
//   - Pressure- & jet-coupled exciters (`reed`, `brass_lip`, `flute_jet`,
//     `flap_valve`) with sample-rate-invariant filters (`44.1 / 48 / 96 kHz`)
//     and strict `NaN`/`Inf`/denormal guards.
// ---------------------------------------------------------------------------

import type { WindExciterKind } from '../types/scene';

export interface WindVoiceConfig {
  id: string;
  exciter: WindExciterKind;
  breathKPa: number;
  embouchureHz: number;
  cellCount: number;
  exactCells?: number;
  /** Reference sample rate at which `cellCount`/`exactCells` were computed (defaults to 48000). */
  sampleRate?: number;
  junctionK: number[];
  bellCutoffHz: number;
  shunts: { cell: number; coeff: number }[];
  gain?: number;
}

const MAX_BORE_CELLS = 1024;
const REF_SAMPLE_RATE = 48000;

interface WindSlot {
  id: string;
  active: boolean;
  exciter: number; // 0 = reed, 1 = brass_lip, 2 = flute_jet, 3 = flap_valve
  targetBreath: number;
  breathEnv: number;
  embouchureHz: number;
  smoothEmbHz: number;
  cellCount: number;
  exactCellsScaled: number;
  thiranA1: number;
  thiranA2: number;
  apS1: number;
  apS2: number;
  pPlus: Float64Array;
  pMinus: Float64Array;
  nextPlus: Float64Array;
  nextMinus: Float64Array;
  k: Float64Array;
  shunt: Float64Array;
  holeAlpha: Float64Array;
  holeState: Float64Array;
  hasOpenHoles: boolean;
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
    exactCellsScaled: 32,
    thiranA1: 0,
    thiranA2: 0,
    apS1: 0,
    apS2: 0,
    pPlus: new Float64Array(MAX_BORE_CELLS),
    pMinus: new Float64Array(MAX_BORE_CELLS),
    nextPlus: new Float64Array(MAX_BORE_CELLS),
    nextMinus: new Float64Array(MAX_BORE_CELLS),
    k: new Float64Array(MAX_BORE_CELLS),
    shunt: new Float64Array(MAX_BORE_CELLS),
    holeAlpha: new Float64Array(MAX_BORE_CELLS),
    holeState: new Float64Array(MAX_BORE_CELLS),
    hasOpenHoles: false,
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

function clearWindSlotState(slot: WindSlot): void {
  slot.pPlus.fill(0);
  slot.pMinus.fill(0);
  slot.nextPlus.fill(0);
  slot.nextMinus.fill(0);
  slot.holeState.fill(0);
  slot.apS1 = 0;
  slot.apS2 = 0;
  slot.bellLp = 0;
  slot.reedLp = 0;
  slot.outLp1 = 0;
  slot.outLp2 = 0;
  slot.lipY = 0;
  slot.lipV = 0;
  slot.dcX1 = 0;
  slot.dcY1 = 0;
}

function clampFinite(v: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return v < lo ? lo : v > hi ? hi : v;
}

function onePolePhaseDelay(a: number, sinW: number, cosW: number, invW: number): number {
  const b = 1 - a;
  return Math.atan2(b * sinW, 1 - b * cosW) * invW;
}

export class KellyLochbaumSynthBank {
  private readonly slots: WindSlot[];
  private readonly logAreaScratch = new Float64Array(MAX_BORE_CELLS + 1);
  private readonly seenIds: string[] = [];
  private rng = 0x2468ace1;
  private sampleRate: number;
  private dt = 1 / REF_SAMPLE_RATE;
  private srRatio = 1;
  private envAlpha = 0;
  private embAlpha = 0;
  private cellLoss = 0.9995;
  private holeIdleDecay = 0.85;
  private dcR = 0;
  private vibInc = 0;

  constructor(sampleRate = REF_SAMPLE_RATE, maxSlots = 4) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 8000 ? sampleRate : REF_SAMPLE_RATE;
    this.slots = Array.from({ length: maxSlots }, () => createWindSlot());
    this.recomputeRateConstants();
  }

  private recomputeRateConstants(): void {
    const sr = this.sampleRate;
    const srRatio = REF_SAMPLE_RATE / sr;
    this.dt = 1 / sr;
    this.srRatio = srRatio;
    this.envAlpha = 1 - Math.exp(-0.0011 * srRatio);
    this.embAlpha = 1 - Math.exp(-0.0020 * srRatio);
    this.cellLoss = Math.pow(0.9995, srRatio);
    this.holeIdleDecay = Math.pow(0.85, srRatio);
    this.dcR = Math.exp((-2 * Math.PI * 18) / sr);
    this.vibInc = (2 * Math.PI * 4.8) / sr;
    // Refresh precomputed tonehole one-pole alphas for any active slots
    for (let w = 0; w < this.slots.length; w++) {
      const ws = this.slots[w];
      if (!ws.hasOpenHoles) continue;
      const M = ws.cellCount;
      for (let c = 0; c < M; c++) {
        const sh = ws.shunt[c];
        if (sh < -0.001) {
          const rawAHole = Math.min(0.96, Math.sqrt(-sh) * 1.04);
          ws.holeAlpha[c] = sr === REF_SAMPLE_RATE ? rawAHole : 1 - Math.pow(1 - rawAHole, srRatio);
        } else {
          ws.holeAlpha[c] = 0;
        }
      }
    }
  }

  setSampleRate(sr: number): void {
    if (Number.isFinite(sr) && sr > 8000 && sr !== this.sampleRate) {
      this.sampleRate = sr;
      this.recomputeRateConstants();
    }
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
    const dt = this.dt;
    const srRatio = this.srRatio;
    const seenIds = this.seenIds;
    seenIds.length = 0;

    // Prioritize actively blown voices ahead of idle voices so >4 instruments never starve active audio!
    const valid: WindVoiceConfig[] = [];
    for (let i = 0; i < voices.length; i++) {
      const v = voices[i];
      if (v && typeof v.id === 'string' && v.id.length > 0) valid.push(v);
    }
    if (valid.length > this.slots.length) {
      valid.sort((a, b) => {
        const aOn = Number.isFinite(a.breathKPa) && a.breathKPa >= 0.08 ? 1 : 0;
        const bOn = Number.isFinite(b.breathKPa) && b.breathKPa >= 0.08 ? 1 : 0;
        if (bOn !== aOn) return bOn - aOn;
        return (Number.isFinite(b.breathKPa) ? b.breathKPa : 0) - (Number.isFinite(a.breathKPa) ? a.breathKPa : 0);
      });
    }

    for (let vIdx = 0; vIdx < valid.length && vIdx < this.slots.length; vIdx++) {
      const cfg = valid[vIdx];
      seenIds.push(cfg.id);

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
            clearWindSlotState(slot);
            const initEmb = clampFinite(cfg.embouchureHz, 16, 2400, cfg.exciter === 'flap_valve' ? 55 : 320);
            slot.smoothEmbHz = initEmb;
            break;
          }
        }
      }
      if (!slot) continue;

      const fBell = clampFinite(cfg.bellCutoffHz, 350, sr * 0.42, 1500);
      const rc = 1 / (2 * Math.PI * fBell);
      slot.bellAlpha = dt / (rc + dt);

      slot.exciter =
        cfg.exciter === 'brass_lip'
          ? 1
          : cfg.exciter === 'flute_jet'
            ? 2
            : cfg.exciter === 'flap_valve'
              ? 3
              : 0;

      const rawKPa = clampFinite(cfg.breathKPa, 0, 25, 0);
      slot.targetBreath = rawKPa < 0.08
        ? 0
        : slot.exciter === 0
          ? 0.42 + 0.34 * Math.tanh((rawKPa - 0.5) / 3.2)
          : Math.max(0, Math.min(0.90, rawKPa / 5.2));

      const minEmb = slot.exciter === 3 ? 16 : 40;
      slot.embouchureHz = clampFinite(cfg.embouchureHz, minEmb, 2400, slot.exciter === 3 ? 55 : 320);
      slot.gain = clampFinite(
        cfg.gain ?? (slot.exciter === 1 ? 0.85 : slot.exciter === 3 ? 0.85 : 0.90),
        0,
        2.5,
        0.80,
      );

      // Scale reference cell count (`cfg.sampleRate`, defaulting to 48 kHz) to live `this.sampleRate`
      const cfgSr = Number.isFinite(cfg.sampleRate) && cfg.sampleRate! > 8000 ? cfg.sampleRate! : REF_SAMPLE_RATE;
      const srScale = sr / cfgSr;
      const baseCellCount = clampFinite(cfg.cellCount, 6, MAX_BORE_CELLS - 3, 32);
      const rawExact = Number.isFinite(cfg.exactCells) && cfg.exactCells! > 0 ? cfg.exactCells! : baseCellCount;
      const scaledExact = clampFinite(rawExact * srScale, 6.8, MAX_BORE_CELLS - 3, 32 * srScale);
      slot.exactCellsScaled = scaledExact;

      const fOpenEst = sr / Math.max(8, 2 * scaledExact);
      const loopCutHz = slot.exciter === 0
        ? Math.min(sr * 0.35, Math.max(280, slot.embouchureHz * 1.75))
        : slot.exciter === 2
          ? Math.min(sr * 0.42, Math.max(700, Math.max(slot.embouchureHz * 2.4, fOpenEst * 2.8)))
          : Math.min(sr * 0.40, Math.max(380, slot.embouchureHz * 2.6));
      const alphaLoop = dt / (1 / (2 * Math.PI * loopCutHz) + dt);

      const fRef = slot.exciter === 0
        ? sr / Math.max(16, 4 * scaledExact)
        : slot.exciter === 2
          ? fOpenEst
          : Math.max(40, Math.min(1400, slot.embouchureHz * 0.92));
      const wRef = (2 * Math.PI * fRef) / sr;
      const sinW = Math.sin(wRef);
      const cosW = Math.cos(wRef);
      const invW = 1 / Math.max(1e-6, wRef);
      const loopLagSamples =
        onePolePhaseDelay(slot.bellAlpha, sinW, cosW, invW) +
        onePolePhaseDelay(alphaLoop, sinW, cosW, invW);

      const targetRoundTrip = clampFinite(
        2 * scaledExact - loopLagSamples,
        13.5,
        2 * (MAX_BORE_CELLS - 3) + 1.5,
        64,
      );
      const M = Math.max(6, Math.min(MAX_BORE_CELLS - 3, Math.floor((targetRoundTrip - 1.5) * 0.5)));
      const D = Math.max(1.5, Math.min(3.4999, targetRoundTrip - 2 * M));
      slot.thiranA1 = -2 * ((D - 2) / (D + 1));
      slot.thiranA2 = ((D - 1) * (D - 2)) / ((D + 1) * (D + 2));

      const prevM = slot.cellCount;
      if (prevM !== M) {
        if (M > prevM) {
          const tailP = slot.pPlus[Math.max(0, prevM - 1)];
          const tailM = slot.pMinus[Math.max(0, prevM - 1)];
          for (let c = prevM; c < M; c++) {
            slot.pPlus[c] = tailP;
            slot.pMinus[c] = tailM;
          }
        }
        slot.cellCount = M;
      }

      const clearEnd = Math.min(MAX_BORE_CELLS, Math.max(prevM, M));
      const jk = Array.isArray(cfg.junctionK) ? cfg.junctionK : [];
      slot.k.fill(0, 0, clearEnd);
      if (jk.length > 0 && M >= 2) {
        if (jk.length === M - 1) {
          for (let i = 0; i < M - 1; i++) {
            slot.k[i] = clampFinite(jk[i], -0.92, 0.92, 0);
          }
        } else {
          const nSrc = Math.min(jk.length, MAX_BORE_CELLS);
          const logArea = this.logAreaScratch;
          logArea[0] = 0;
          for (let j = 0; j < nSrc; j++) {
            const kj = clampFinite(jk[j], -0.92, 0.92, 0);
            logArea[j + 1] = logArea[j] + Math.log((1 - kj) / (1 + kj));
          }
          let prevLogA = logArea[0];
          const invMm1 = 1 / (M - 1);
          for (let c = 1; c < M; c++) {
            const pos = c * invMm1 * nSrc;
            const i0 = Math.min(nSrc, Math.floor(pos));
            const i1 = Math.min(nSrc, i0 + 1);
            const frac = pos - i0;
            const curLogA = logArea[i0] * (1 - frac) + logArea[i1] * frac;
            const ratio = Math.exp(curLogA - prevLogA);
            slot.k[c - 1] = clampFinite((1 - ratio) / (1 + ratio), -0.92, 0.92, 0);
            prevLogA = curLogA;
          }
        }
      }

      // Combine parallel open-tonehole shunts and precompute per-cell `holeAlpha[c]` ONCE (zero Math.sqrt/Math.pow in render!)
      slot.shunt.fill(0, 0, clearEnd);
      slot.holeAlpha.fill(0, 0, clearEnd);
      let anyOpenHole = false;
      const shunts = Array.isArray(cfg.shunts) ? cfg.shunts : [];
      const refDenom = Math.max(1, baseCellCount - 1);
      const cellScale = (M - 1) / refDenom;
      for (let s = 0; s < shunts.length; s++) {
        const shItem = shunts[s];
        if (!shItem || !Number.isFinite(shItem.cell) || !Number.isFinite(shItem.coeff)) continue;
        const ci = Math.round(shItem.cell * cellScale);
        if (ci >= 1 && ci < M - 1) {
          const cNew = clampFinite(shItem.coeff, -0.92, 0, 0);
          if (cNew >= -1e-5) continue;
          const cPrev = slot.shunt[ci];
          let cComb: number;
          if (cPrev < -1e-5) {
            const yTot = -cPrev / (1 + cPrev) + -cNew / (1 + cNew);
            cComb = Math.max(-0.92, -yTot / (1 + yTot));
          } else {
            cComb = cNew;
          }
          slot.shunt[ci] = cComb;
          if (cComb < -0.001) {
            const rawAHole = Math.min(0.96, Math.sqrt(-cComb) * 1.04);
            slot.holeAlpha[ci] = sr === REF_SAMPLE_RATE ? rawAHole : 1 - Math.pow(1 - rawAHole, srRatio);
            anyOpenHole = true;
          }
        }
      }
      slot.hasOpenHoles = anyOpenHole;
      slot.active = true;
    }

    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s.active && !seenIds.includes(s.id)) {
        s.targetBreath = 0;
      }
    }
  }

  private nextNoise(): number {
    let x = this.rng | 0;
    if (x === 0) x = 0x2468ace1;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng = x;
    return (x | 0) / 2147483648;
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
    const dt = this.dt;
    const envAlpha = this.envAlpha;
    const embAlpha = this.embAlpha;
    const cellLoss = this.cellLoss;
    const holeIdleDecay = this.holeIdleDecay;
    const dcR = this.dcR;
    const vibInc = this.vibInc;

    for (let w = 0; w < this.slots.length; w++) {
      const ws = this.slots[w];
      if (!ws.active) continue;
      if (ws.targetBreath < 0.001 && ws.breathEnv < 0.0004) {
        ws.active = false;
        ws.id = '';
        continue;
      }

      const M = ws.cellCount;
      const Mm1 = M - 1;
      const kArr = ws.k;
      const holeAlphaArr = ws.holeAlpha;
      const hState = ws.holeState;
      const hasOpenHoles = ws.hasOpenHoles;
      const bellAlpha = ws.bellAlpha;
      const a1 = ws.thiranA1;
      const a2 = ws.thiranA2;
      const exc = ws.exciter;
      const targetBreath = ws.targetBreath;
      const embouchureHz = ws.embouchureHz;
      const slotGain = ws.gain;
      const turb = exc === 2 ? 0.032 : exc === 3 ? 0.018 : 0.007;

      const fOpenEst = sr / Math.max(8, 2 * ws.exactCellsScaled);
      const loopCutHz = exc === 0
        ? Math.min(sr * 0.35, Math.max(280, embouchureHz * 1.75))
        : exc === 2
          ? Math.min(sr * 0.42, Math.max(700, Math.max(embouchureHz * 2.4, fOpenEst * 2.8)))
          : Math.min(sr * 0.40, Math.max(380, embouchureHz * 2.6));
      const alphaLoop = dt / (1 / (2 * Math.PI * loopCutHz) + dt);
      const alphaJetHp = Math.min(0.25, (2 * Math.PI * Math.max(45, fOpenEst * 0.35)) * dt);

      const radCutHz = Math.min(sr * 0.42, 1300 + 1800 * Math.max(0.2, targetBreath));
      const alphaRad = dt / (1 / (2 * Math.PI * radCutHz) + dt);

      // Hoist slot arrays & state into locals for tight register-allocated inner loop
      let pPlus = ws.pPlus;
      let pMinus = ws.pMinus;
      let nPlus = ws.nextPlus;
      let nMinus = ws.nextMinus;
      let breathEnv = ws.breathEnv;
      let smoothEmbHz = ws.smoothEmbHz;
      let vibPhase = ws.vibPhase;
      let apS1 = ws.apS1;
      let apS2 = ws.apS2;
      let bellLp = ws.bellLp;
      let reedLp = ws.reedLp;
      let lipY = ws.lipY;
      let lipV = ws.lipV;
      let outLp1 = ws.outLp1;
      let outLp2 = ws.outLp2;
      let dcX1 = ws.dcX1;
      let dcY1 = ws.dcY1;

      for (let i = 0; i < nFrames; i++) {
        breathEnv += envAlpha * (targetBreath - breathEnv);
        smoothEmbHz += embAlpha * (embouchureHz - smoothEmbHz);
        vibPhase += vibInc;
        if (vibPhase > Math.PI * 2) vibPhase -= Math.PI * 2;

        const vib = 1 + 0.011 * Math.sin(vibPhase);
        const pMouth = breathEnv * vib * (1 + turb * this.nextNoise());

        // Open-end 2nd-order Thiran fractional boundary (DF-II Transposed) + spherical radiation
        const pIncEnd = pPlus[Mm1];
        const pEnd = a2 * pIncEnd + apS1;
        apS1 = a1 * (pIncEnd - pEnd) + apS2;
        apS2 = pIncEnd - a2 * pEnd;

        bellLp += bellAlpha * (pEnd - bellLp);
        const pReflBell = -0.968 * bellLp;
        let radiated = (pEnd - bellLp) * 0.88 + 0.44 * bellLp;

        let pIn0: number;
        const pBack0 = pMinus[0];
        reedLp += alphaLoop * (pBack0 - reedLp);

        if (exc === 0) {
          const dp = pMouth - reedLp;
          const dc = dp < -1.1 ? -1.1 : dp > 1.1 ? 1.1 : dp;
          let rReed = 0.24 + 0.88 * dc - 0.16 * dc * dc * dc;
          if (rReed < -0.90) rReed = -0.90;
          else if (rReed > 0.97) rReed = 0.97;
          pIn0 = pMouth - rReed * dp;
        } else if (exc === 1) {
          const qLip = 3.6;
          const omegaLip = 2 * Math.PI * smoothEmbHz;
          const subSteps = omegaLip * dt > 0.45 ? 2 : 1;
          const dtSub = dt / subSteps;
          const omegaLipSq = omegaLip * omegaLip;
          const dampLip = omegaLip / qLip;

          for (let st = 0; st < subSteps; st++) {
            const acc = omegaLipSq * (reedLp - lipY - 0.35 * lipY * lipY * lipY) - dampLip * lipV;
            lipV += dtSub * acc;
            lipY += dtSub * lipV;
            if (lipY < -1.2) {
              lipY = -1.2;
              lipV *= -0.15;
            } else if (lipY > 1.2) {
              lipY = 1.2;
              lipV *= -0.15;
            }
          }

          const vBp = lipV / Math.max(20, omegaLip * qLip);
          const lipOpen = Math.max(0, 0.24 + 2.85 * vBp);
          const dp = pMouth - 0.55 * reedLp;
          const flow = lipOpen * Math.tanh(dp * 1.6) * 0.72;
          pIn0 = 0.94 * reedLp + flow;
        } else if (exc === 3) {
          const qFlap = 1.85;
          const omegaFlap = 2 * Math.PI * smoothEmbHz;
          const omegaSq = omegaFlap * omegaFlap;
          const dampFlap = omegaFlap / qFlap;
          const bernSuction = pMouth * (0.36 - 1.35 * Math.max(0, lipY + 0.18));
          const aeroVelDrive = pMouth * 1.55 * dampFlap * lipV;
          const acc =
            omegaSq * (bernSuction + 0.38 * reedLp - lipY - 0.52 * lipY * lipY * lipY) +
            aeroVelDrive -
            dampFlap * lipV;
          lipV += dt * acc;
          lipY += dt * lipV;
          if (lipY < -1.05) {
            lipY = -1.05;
            lipV *= -0.10;
          } else if (lipY > 1.15) {
            lipY = 1.15;
            lipV *= -0.12;
          }
          const flapOpen = Math.max(0, 0.16 + 1.15 * lipY);
          const dp = pMouth - 0.45 * reedLp;
          const flow = flapOpen * Math.tanh(dp * 1.85) * 0.84;
          pIn0 = 0.86 * reedLp + flow;
        } else {
          lipY += alphaJetHp * (reedLp - lipY);
          const acBore = reedLp - lipY;
          const jetNoise = 0.06 * pMouth * this.nextNoise();
          const uJet = acBore * (1.85 + 0.85 * pMouth) + jetNoise;
          const jet = -pMouth * 0.72 * Math.tanh(uJet * 1.45);
          pIn0 = -0.78 * reedLp + jet;
        }

        if (!Number.isFinite(pIn0)) {
          ws.pPlus = pPlus; ws.pMinus = pMinus; ws.nextPlus = nPlus; ws.nextMinus = nMinus;
          clearWindSlotState(ws);
          apS1 = 0; apS2 = 0; bellLp = 0; reedLp = 0; outLp1 = 0; outLp2 = 0; lipY = 0; lipV = 0; dcX1 = 0; dcY1 = 0;
          continue;
        }
        if (pIn0 > 1.5) pIn0 = 1.5;
        else if (pIn0 < -1.5) pIn0 = -1.5;

        // 1-multiply Kelly–Lochbaum spatial scattering ladder + precomputed open tonehole shunts
        nPlus[0] = pIn0;
        nMinus[Mm1] = pReflBell;
        if (hasOpenHoles) {
          for (let c = 0; c < Mm1; c++) {
            let fp = pPlus[c];
            let bm = pMinus[c + 1];
            const aHole = holeAlphaArr[c];
            if (aHole > 0) {
              const targetW = -0.985 * (fp + bm);
              const nextH = hState[c] + aHole * (targetW - hState[c]);
              hState[c] = nextH;
              fp += nextH;
              bm += nextH;
              radiated -= nextH * 0.62;
            } else if (hState[c] !== 0) {
              const decayed = hState[c] * holeIdleDecay;
              hState[c] = decayed > -1e-18 && decayed < 1e-18 ? 0 : decayed;
            }
            const d = kArr[c] * (fp - bm);
            nPlus[c + 1] = (fp + d) * cellLoss;
            nMinus[c] = (bm + d) * cellLoss;
          }
        } else {
          for (let c = 0; c < Mm1; c++) {
            const fp = pPlus[c];
            const bm = pMinus[c + 1];
            const d = kArr[c] * (fp - bm);
            nPlus[c + 1] = (fp + d) * cellLoss;
            nMinus[c] = (bm + d) * cellLoss;
          }
        }

        const tmpP = pPlus; pPlus = nPlus; nPlus = tmpP;
        const tmpM = pMinus; pMinus = nMinus; nMinus = tmpM;

        // Universal 2-pole radiation smoothing + sample-rate-scaled DC blocker
        outLp1 += alphaRad * (radiated - outLp1);
        outLp2 += alphaRad * (outLp1 - outLp2);
        const dcOut = outLp2 - dcX1 + dcR * dcY1;
        dcX1 = outLp2;
        dcY1 = dcOut > -1e-20 && dcOut < 1e-20 ? 0 : dcOut;
        if (!Number.isFinite(dcOut)) {
          ws.pPlus = pPlus; ws.pMinus = pMinus; ws.nextPlus = nPlus; ws.nextMinus = nMinus;
          clearWindSlotState(ws);
          apS1 = 0; apS2 = 0; bellLp = 0; reedLp = 0; outLp1 = 0; outLp2 = 0; lipY = 0; lipV = 0; dcX1 = 0; dcY1 = 0;
          continue;
        }
        outL[i] += dcOut * slotGain;
      }

      ws.pPlus = pPlus;
      ws.pMinus = pMinus;
      ws.nextPlus = nPlus;
      ws.nextMinus = nMinus;
      ws.breathEnv = breathEnv;
      ws.smoothEmbHz = smoothEmbHz;
      ws.vibPhase = vibPhase;
      ws.apS1 = apS1;
      ws.apS2 = apS2;
      ws.bellLp = bellLp;
      ws.reedLp = reedLp;
      ws.lipY = lipY;
      ws.lipV = lipV;
      ws.outLp1 = outLp1;
      ws.outLp2 = outLp2;
      ws.dcX1 = dcX1;
      ws.dcY1 = dcY1;
    }

    // C^1-continuous soft-knee safety limiter (exact value & unit slope at |s| = 0.28, ceiling 0.82)
    for (let i = 0; i < nFrames; i++) {
      const s = outL[i];
      if (!Number.isFinite(s)) {
        outL[i] = 0;
        if (outR) outR[i] = 0;
        continue;
      }
      const absS = Math.abs(s);
      const lim = absS > 0.28 ? Math.sign(s) * (0.28 + 0.54 * Math.tanh((absS - 0.28) / 0.54)) : s;
      outL[i] = lim;
      if (outR) outR[i] = lim;
    }
  }
}
