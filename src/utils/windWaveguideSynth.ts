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

export class KellyLochbaumSynthBank {
  private readonly slots: WindSlot[];
  private rng = 0x2468ace1;
  private sampleRate: number;

  constructor(sampleRate = REF_SAMPLE_RATE, maxSlots = 4) {
    this.sampleRate = Number.isFinite(sampleRate) && sampleRate > 8000 ? sampleRate : REF_SAMPLE_RATE;
    this.slots = Array.from({ length: maxSlots }, () => createWindSlot());
  }

  setSampleRate(sr: number): void {
    if (Number.isFinite(sr) && sr > 8000) this.sampleRate = sr;
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
    const dt = 1 / sr;
    const seen = new Set<string>();

    // Prioritize actively blown voices ahead of idle voices so >4 instruments never starve active audio!
    const valid = voices.filter((v) => v && typeof v.id === 'string' && v.id.length > 0);
    const ordered = valid.length > this.slots.length
      ? [...valid].sort((a, b) => {
          const aOn = Number.isFinite(a.breathKPa) && a.breathKPa >= 0.08 ? 1 : 0;
          const bOn = Number.isFinite(b.breathKPa) && b.breathKPa >= 0.08 ? 1 : 0;
          if (bOn !== aOn) return bOn - aOn;
          return (Number.isFinite(b.breathKPa) ? b.breathKPa : 0) - (Number.isFinite(a.breathKPa) ? a.breathKPa : 0);
        })
      : valid;

    for (let vIdx = 0; vIdx < ordered.length && vIdx < this.slots.length; vIdx++) {
      const cfg = ordered[vIdx];
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
      const onePolePhaseDelay = (a: number): number => {
        const b = 1 - a;
        return Math.atan2(b * Math.sin(wRef), 1 - b * Math.cos(wRef)) / Math.max(1e-6, wRef);
      };
      const loopLagSamples = onePolePhaseDelay(slot.bellAlpha) + onePolePhaseDelay(alphaLoop);

      // 2nd-order Thiran allpass fractional termination over `D ∈ [1.5, 3.5)` round-trip samples:
      // Zero clamping dead-zones across the full 2-sample cell step and all poles strictly inside `|z_p| <= 0.462`!
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

      // Log-area taper interpolation preserves exact total expansion `A_bell / A_mouth` across any `M` or sample rate!
      const jk = Array.isArray(cfg.junctionK) ? cfg.junctionK : [];
      slot.k.fill(0);
      if (jk.length > 0 && M >= 2) {
        if (jk.length === M - 1) {
          for (let i = 0; i < M - 1; i++) {
            slot.k[i] = clampFinite(jk[i], -0.92, 0.92, 0);
          }
        } else {
          const nSrc = jk.length;
          const logArea = new Float64Array(nSrc + 1);
          for (let j = 0; j < nSrc; j++) {
            const kj = clampFinite(jk[j], -0.92, 0.92, 0);
            logArea[j + 1] = logArea[j] + Math.log((1 - kj) / (1 + kj));
          }
          let prevLogA = logArea[0];
          for (let c = 1; c < M; c++) {
            const pos = (c / (M - 1)) * nSrc;
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

      // Combine parallel open-tonehole shunts cleanly if multiple holes map to the same cell
      slot.shunt.fill(0);
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
          if (cPrev < -1e-5) {
            const yPrev = -cPrev / (1 + cPrev);
            const yNew = -cNew / (1 + cNew);
            const yTot = yPrev + yNew;
            slot.shunt[ci] = Math.max(-0.92, -yTot / (1 + yTot));
          } else {
            slot.shunt[ci] = cNew;
          }
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
    const dt = 1 / sr;
    const srRatio = REF_SAMPLE_RATE / sr;
    const envAlpha = 1 - Math.exp(-0.0011 * srRatio);
    const embAlpha = 1 - Math.exp(-0.0020 * srRatio);
    const cellLoss = Math.pow(0.9995, srRatio);
    const holeIdleDecay = Math.pow(0.85, srRatio);
    const dcR = Math.exp((-2 * Math.PI * 18) / sr);
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
      const a1 = ws.thiranA1;
      const a2 = ws.thiranA2;
      const exc = ws.exciter;

      const fOpenEst = sr / Math.max(8, 2 * ws.exactCellsScaled);
      const loopCutHz = exc === 0
        ? Math.min(sr * 0.35, Math.max(280, ws.embouchureHz * 1.75))
        : exc === 2
          ? Math.min(sr * 0.42, Math.max(700, Math.max(ws.embouchureHz * 2.4, fOpenEst * 2.8)))
          : Math.min(sr * 0.40, Math.max(380, ws.embouchureHz * 2.6));
      const alphaLoop = dt / (1 / (2 * Math.PI * loopCutHz) + dt);

      const radCutHz = Math.min(sr * 0.42, 1300 + 1800 * Math.max(0.2, ws.targetBreath));
      const alphaRad = dt / (1 / (2 * Math.PI * radCutHz) + dt);

      for (let i = 0; i < nFrames; i++) {
        ws.breathEnv += envAlpha * (ws.targetBreath - ws.breathEnv);
        ws.smoothEmbHz += embAlpha * (ws.embouchureHz - ws.smoothEmbHz);
        ws.vibPhase += vibInc;
        if (ws.vibPhase > Math.PI * 2) ws.vibPhase -= Math.PI * 2;

        const vib = 1 + 0.011 * Math.sin(ws.vibPhase);
        const turb = exc === 2 ? 0.032 : exc === 3 ? 0.018 : 0.007;
        const pMouth = ws.breathEnv * vib * (1 + turb * this.nextNoise());

        // Open-end 2nd-order Thiran fractional boundary (DF-II Transposed) + spherical radiation
        const pIncEnd = ws.pPlus[M - 1];
        const pEnd = a2 * pIncEnd + ws.apS1;
        ws.apS1 = a1 * (pIncEnd - pEnd) + ws.apS2;
        ws.apS2 = pIncEnd - a2 * pEnd;

        ws.bellLp += bellAlpha * (pEnd - ws.bellLp);
        const pReflBell = -0.968 * ws.bellLp;
        let radiated = (pEnd - ws.bellLp) * 0.88 + 0.44 * ws.bellLp;

        let pIn0: number;
        const pBack0 = ws.pMinus[0];
        ws.reedLp += alphaLoop * (pBack0 - ws.reedLp);

        if (exc === 0) {
          // Inward-striking compliant reed valve (smooth C^2 cubic pressure-reflection curve)
          const dp = pMouth - ws.reedLp;
          const dc = Math.max(-1.1, Math.min(1.1, dp));
          let rReed = 0.24 + 0.88 * dc - 0.16 * dc * dc * dc;
          if (rReed < -0.90) rReed = -0.90;
          else if (rReed > 0.97) rReed = 0.97;
          pIn0 = pMouth - rReed * dp;
        } else if (exc === 1) {
          // Passive bandpass-coupled 1-DOF brass lip-reed valve (sub-stepped if omega*dt > 0.45)
          const qLip = 3.6;
          const omegaLip = 2 * Math.PI * ws.smoothEmbHz;
          const subSteps = omegaLip * dt > 0.45 ? 2 : 1;
          const dtSub = dt / subSteps;
          const omegaLipSq = omegaLip * omegaLip;
          const dampLip = omegaLip / qLip;

          for (let st = 0; st < subSteps; st++) {
            const acc = omegaLipSq * (ws.reedLp - ws.lipY - 0.35 * ws.lipY * ws.lipY * ws.lipY) - dampLip * ws.lipV;
            ws.lipV += dtSub * acc;
            ws.lipY += dtSub * ws.lipV;
            if (ws.lipY < -1.2) {
              ws.lipY = -1.2;
              ws.lipV *= -0.15;
            } else if (ws.lipY > 1.2) {
              ws.lipY = 1.2;
              ws.lipV *= -0.15;
            }
          }

          const vBp = ws.lipV / Math.max(20, omegaLip * qLip);
          const lipOpen = Math.max(0, 0.24 + 2.85 * vBp);
          const dp = pMouth - 0.55 * ws.reedLp;
          const flow = lipOpen * Math.tanh(dp * 1.6) * 0.72;
          pIn0 = 0.94 * ws.reedLp + flow;
        } else if (exc === 3) {
          // Fletcher autonomous compliant flap-valve (sub-resonant relaxation slap-oscillator + Bernoulli suction)
          const qFlap = 1.85;
          const omegaFlap = 2 * Math.PI * ws.smoothEmbHz;
          const omegaSq = omegaFlap * omegaFlap;
          const dampFlap = omegaFlap / qFlap;
          const bernSuction = pMouth * (0.36 - 1.35 * Math.max(0, ws.lipY + 0.18));
          const aeroVelDrive = pMouth * 1.55 * dampFlap * ws.lipV;
          const acc =
            omegaSq * (bernSuction + 0.38 * ws.reedLp - ws.lipY - 0.52 * ws.lipY * ws.lipY * ws.lipY) +
            aeroVelDrive -
            dampFlap * ws.lipV;
          ws.lipV += dt * acc;
          ws.lipY += dt * ws.lipV;
          if (ws.lipY < -1.05) {
            ws.lipY = -1.05;
            ws.lipV *= -0.10;
          } else if (ws.lipY > 1.15) {
            ws.lipY = 1.15;
            ws.lipV *= -0.12;
          }
          const flapOpen = Math.max(0, 0.16 + 1.15 * ws.lipY);
          const dp = pMouth - 0.45 * ws.reedLp;
          const flow = flapOpen * Math.tanh(dp * 1.85) * 0.84;
          pIn0 = 0.86 * ws.reedLp + flow;
        } else {
          // Open-embouchure air-jet flute: AC-coupled jet-labium deflection (`reedLp - lipY` -> zero DC gain,
          // preventing open-open DC latch-up!) + negative open-end reflection (-0.78) -> pure lambda/2 limit cycle!
          const alphaJetHp = Math.min(0.25, (2 * Math.PI * Math.max(45, fOpenEst * 0.35)) * dt);
          ws.lipY += alphaJetHp * (ws.reedLp - ws.lipY);
          const acBore = ws.reedLp - ws.lipY;
          const jetNoise = 0.06 * pMouth * this.nextNoise();
          const uJet = acBore * (1.85 + 0.85 * pMouth) + jetNoise;
          const jet = -pMouth * 0.72 * Math.tanh(uJet * 1.45);
          pIn0 = -0.78 * ws.reedLp + jet;
        }

        if (!Number.isFinite(pIn0)) {
          clearWindSlotState(ws);
          continue;
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
            const rawAHole = Math.min(0.96, Math.sqrt(-sh) * 1.04);
            const aHole = sr === REF_SAMPLE_RATE ? rawAHole : 1 - Math.pow(1 - rawAHole, srRatio);
            const targetW = -0.985 * (fp + bm);
            hState[c] += aHole * (targetW - hState[c]);
            const w = hState[c];
            fp += w;
            bm += w;
            radiated -= w * 0.62;
          } else {
            const decayed = hState[c] * holeIdleDecay;
            hState[c] = Math.abs(decayed) < 1e-18 ? 0 : decayed;
          }
          const d = kArr[c] * (fp - bm);
          nPlus[c + 1] = (fp + d) * cellLoss;
          nMinus[c] = (bm + d) * cellLoss;
        }

        const tmpP = ws.pPlus;
        ws.pPlus = nPlus;
        ws.nextPlus = tmpP;
        const tmpM = ws.pMinus;
        ws.pMinus = nMinus;
        ws.nextMinus = tmpM;

        // Universal 2-pole radiation smoothing + sample-rate-scaled DC blocker
        ws.outLp1 += alphaRad * (radiated - ws.outLp1);
        ws.outLp2 += alphaRad * (ws.outLp1 - ws.outLp2);
        const dcOut = ws.outLp2 - ws.dcX1 + dcR * ws.dcY1;
        ws.dcX1 = ws.outLp2;
        ws.dcY1 = Math.abs(dcOut) < 1e-20 ? 0 : dcOut;
        if (!Number.isFinite(dcOut)) {
          clearWindSlotState(ws);
          continue;
        }
        outL[i] += dcOut * ws.gain;
      }
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
