// Off-main-thread real-time modal, stiff-string, and 1D Kelly–Lochbaum wind/brass
// waveguide processor. Loaded from same-origin /modalAudioProcessor.js.

const MAX_BORE_CELLS = 1024;
const REF_SAMPLE_RATE = 48000;

function clampFinite(v, lo, hi, fallback) {
  if (!Number.isFinite(v)) return fallback;
  return v < lo ? lo : v > hi ? hi : v;
}

function createWindSlot() {
  return {
    id: '',
    active: false,
    exciter: 0, // 0 = reed, 1 = brass_lip, 2 = flute_jet, 3 = flap_valve
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
    bellAlpha: 0.25,
    bellLp: 0,
    reedLp: 0,
    cupLp: 0,
    lipY: 0,
    lipV: 0,
    prevBack: 0,
    vibPhase: 0,
    dcX1: 0,
    dcY1: 0,
    gain: 0.28,
  };
}

function clearWindSlotState(slot) {
  slot.pPlus.fill(0);
  slot.pMinus.fill(0);
  slot.nextPlus.fill(0);
  slot.nextMinus.fill(0);
  slot.apS1 = 0;
  slot.apS2 = 0;
  slot.bellLp = 0;
  slot.reedLp = 0;
  slot.cupLp = 0;
  slot.lipY = 0;
  slot.lipV = 0;
  slot.prevBack = 0;
  slot.dcX1 = 0;
  slot.dcY1 = 0;
}

class ModalResonatorProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.maxVoices = 96;
    this.active = new Uint8Array(this.maxVoices);
    this.y1 = new Float64Array(this.maxVoices);
    this.y2 = new Float64Array(this.maxVoices);
    this.c1 = new Float64Array(this.maxVoices);
    this.c2 = new Float64Array(this.maxVoices);
    this.cursor = 0;

    this.maxBursts = 8;
    this.bActive = new Uint8Array(this.maxBursts);
    this.bStep = new Int32Array(this.maxBursts);
    this.bTotal = new Int32Array(this.maxBursts);
    this.bTauSamples = new Float32Array(this.maxBursts);
    this.bGain = new Float32Array(this.maxBursts);
    this.bBright = new Float32Array(this.maxBursts);
    this.bPluck = new Uint8Array(this.maxBursts);
    this.bLpState = new Float32Array(this.maxBursts);
    this.bAlpha = new Float32Array(this.maxBursts);
    this.bCursor = 0;

    // Pre-allocated Kelly–Lochbaum wind/brass bore slots (zero GC in process!)
    this.windSlots = [createWindSlot(), createWindSlot(), createWindSlot(), createWindSlot()];

    this.rng = 0x12345678;
    this.reportedRunning = false;

    this.port.onmessage = (ev) => {
      const msg = ev.data;
      if (!msg) return;
      if (msg.type === 'STRIKE') {
        this.triggerStrike(msg);
      } else if (msg.type === 'WIND_UPDATE') {
        this.updateWindVoices(msg.voices || []);
      } else if (msg.type === 'WIND_SILENCE') {
        for (let i = 0; i < this.windSlots.length; i++) {
          this.windSlots[i].targetBreath = 0;
        }
      }
    };
  }

  updateWindVoices(voices) {
    const sr = Number.isFinite(sampleRate) && sampleRate > 8000 ? sampleRate : REF_SAMPLE_RATE;
    const dt = 1 / sr;
    const seen = new Set();

    const valid = Array.isArray(voices)
      ? voices.filter((v) => v && typeof v.id === 'string' && v.id.length > 0)
      : [];
    const ordered = valid.length > this.windSlots.length
      ? [...valid].sort((a, b) => {
          const aOn = Number.isFinite(a.breathKPa) && a.breathKPa >= 0.08 ? 1 : 0;
          const bOn = Number.isFinite(b.breathKPa) && b.breathKPa >= 0.08 ? 1 : 0;
          if (bOn !== aOn) return bOn - aOn;
          return (Number.isFinite(b.breathKPa) ? b.breathKPa : 0) - (Number.isFinite(a.breathKPa) ? a.breathKPa : 0);
        })
      : valid;

    for (let vIdx = 0; vIdx < ordered.length && vIdx < this.windSlots.length; vIdx++) {
      const cfg = ordered[vIdx];
      seen.add(cfg.id);

      let slot = null;
      for (let i = 0; i < this.windSlots.length; i++) {
        if (this.windSlots[i].id === cfg.id) {
          slot = this.windSlots[i];
          break;
        }
      }
      if (!slot) {
        for (let i = 0; i < this.windSlots.length; i++) {
          if (!this.windSlots[i].active) {
            slot = this.windSlots[i];
            slot.id = cfg.id;
            clearWindSlotState(slot);
            slot.smoothEmbHz = clampFinite(cfg.embouchureHz, 16, 2400, cfg.exciter === 'flap_valve' ? 55 : 320);
            break;
          }
        }
      }
      if (!slot) continue;

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
          ? 0.42 + 0.36 * Math.tanh((rawKPa - 0.5) / 3.2)
          : Math.max(0, Math.min(0.88, rawKPa / 5.5));
      slot.embouchureHz = clampFinite(cfg.embouchureHz, slot.exciter === 3 ? 16 : 40, 2400, slot.exciter === 3 ? 55 : 320);
      slot.gain = clampFinite(cfg.gain ?? (slot.exciter === 1 ? 0.75 : slot.exciter === 3 ? 0.80 : 0.95), 0, 2.5, 0.80);

      const fBell = clampFinite(cfg.bellCutoffHz, 350, sr * 0.42, 1500);
      const rc = 1 / (2 * Math.PI * fBell);
      slot.bellAlpha = dt / (rc + dt);

      const cfgSr = Number.isFinite(cfg.sampleRate) && cfg.sampleRate > 8000 ? cfg.sampleRate : REF_SAMPLE_RATE;
      const srScale = sr / cfgSr;
      const baseCells = clampFinite(cfg.cellCount, 6, MAX_BORE_CELLS - 3, 32);
      const rawExact = Number.isFinite(cfg.exactCells) && cfg.exactCells > 0 ? cfg.exactCells : baseCells;
      const scaledExact = clampFinite(rawExact * srScale, 6.8, MAX_BORE_CELLS - 3, 32 * srScale);
      slot.exactCellsScaled = scaledExact;

      const targetRT = clampFinite(2 * scaledExact - 1.5, 13.5, 2 * (MAX_BORE_CELLS - 3) + 1.5, 64);
      const M = Math.max(6, Math.min(MAX_BORE_CELLS - 3, Math.floor((targetRT - 1.5) * 0.5)));
      const D = Math.max(1.5, Math.min(3.4999, targetRT - 2 * M));
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

      slot.shunt.fill(0);
      const shunts = Array.isArray(cfg.shunts) ? cfg.shunts : [];
      const cellScale = (M - 1) / Math.max(1, baseCells - 1);
      for (let s = 0; s < shunts.length; s++) {
        const shItem = shunts[s];
        if (!shItem || !Number.isFinite(shItem.cell) || !Number.isFinite(shItem.coeff)) continue;
        const ci = Math.round(shItem.cell * cellScale);
        if (ci >= 1 && ci < M - 1) {
          const cNew = clampFinite(shItem.coeff, -0.85, 0, 0);
          if (cNew >= -1e-5) continue;
          const cPrev = slot.shunt[ci];
          if (cPrev < -1e-5) {
            const yTot = -cPrev / (1 + cPrev) + -cNew / (1 + cNew);
            slot.shunt[ci] = Math.max(-0.85, -yTot / (1 + yTot));
          } else {
            slot.shunt[ci] = cNew;
          }
        }
      }

      slot.active = true;
    }

    for (let i = 0; i < this.windSlots.length; i++) {
      const s = this.windSlots[i];
      if (s.active && !seen.has(s.id)) {
        s.targetBreath = 0;
      }
    }
  }

  triggerStrike(msg) {
    const sr = Number.isFinite(sampleRate) && sampleRate > 8000 ? sampleRate : REF_SAMPLE_RATE;
    const nyquist = sr * 0.47;
    const level = clampFinite(msg.level, 0, 0.65, 0);
    if (level < 0.001) return;

    const voices = Array.isArray(msg.voices) ? msg.voices : [];
    for (let i = 0; i < voices.length; i++) {
      const v = voices[i];
      if (!v) continue;
      const f = v.freqHz;
      if (!(Number.isFinite(f) && f >= 20 && f < nyquist)) continue;
      const dur = clampFinite(v.decaySec, 0.012, 6.0, 0.15);
      const r = Math.exp(-9.21034037 / (dur * sr));
      const omega = (2 * Math.PI * f) / sr;
      const sinW = Math.sin(omega);
      if (Math.abs(sinW) < 1e-6) continue;

      const slot = this.allocVoiceSlot();
      this.c1[slot] = 2 * r * Math.cos(omega);
      this.c2[slot] = r * r;
      const amp = level * clampFinite(v.gain, 0, 2.0, 0.1);
      this.y1[slot] = amp * r * sinW;
      this.y2[slot] = 0;
      this.active[slot] = 1;
    }

    const bSlot = this.bCursor;
    this.bCursor = (this.bCursor + 1) % this.maxBursts;
    const tauSamples = clampFinite((msg.tauC || 0.0008) * sr, 8, sr * 0.008, 0.0008 * sr);
    this.bTauSamples[bSlot] = tauSamples;
    this.bStep[bSlot] = 0;
    this.bTotal[bSlot] = Math.ceil(tauSamples * (msg.isPluck ? 4.5 : 8.5));
    const bright = clampFinite(msg.brightness ?? 0.5, 0, 1, 0.5);
    this.bBright[bSlot] = bright;
    this.bPluck[bSlot] = msg.isPluck ? 1 : 0;
    const pulseWeight = voices.length === 0 ? 1.45 : (msg.isPluck ? 0.24 : 0.4 + 0.4 * bright);
    this.bGain[bSlot] = level * pulseWeight;
    const cutoffHz = Math.min(nyquist, msg.isPluck ? (900 + 2600 * bright) : (1050 + 2400 * bright));
    const rc = 1 / (2 * Math.PI * cutoffHz);
    const dt = 1 / sr;
    this.bAlpha[bSlot] = dt / (rc + dt);
    this.bLpState[bSlot] = 0;
    this.bActive[bSlot] = 1;
  }

  allocVoiceSlot() {
    for (let k = 0; k < this.maxVoices; k++) {
      const idx = (this.cursor + k) % this.maxVoices;
      if (!this.active[idx]) {
        this.cursor = (idx + 1) % this.maxVoices;
        return idx;
      }
    }
    let quietIdx = this.cursor;
    let minEnergy = Infinity;
    for (let i = 0; i < this.maxVoices; i++) {
      const e = this.y1[i] * this.y1[i] + this.y2[i] * this.y2[i];
      if (e < minEnergy) {
        minEnergy = e;
        quietIdx = i;
      }
    }
    this.cursor = (quietIdx + 1) % this.maxVoices;
    return quietIdx;
  }

  nextNoise() {
    let x = this.rng | 0;
    if (x === 0) x = 0x12345678;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng = x;
    return (x | 0) / 2147483648;
  }

  process(_inputs, outputs) {
    if (!this.reportedRunning) {
      this.reportedRunning = true;
      this.port.postMessage({ type: 'RUNNING' });
    }
    const outL = outputs[0] && outputs[0][0];
    if (!outL) return true;
    const outR = outputs[0][1];
    const nFrames = outL.length;
    outL.fill(0);
    const outChan = outL;

    // 1. Modal & stiff-string 2-pole resonators
    for (let v = 0; v < this.maxVoices; v++) {
      if (!this.active[v]) continue;
      let s1 = this.y1[v];
      let s2 = this.y2[v];
      const a1 = this.c1[v];
      const a2 = this.c2[v];
      for (let i = 0; i < nFrames; i++) {
        outChan[i] += s1;
        const y0 = a1 * s1 - a2 * s2;
        s2 = s1;
        s1 = y0;
      }
      if (!Number.isFinite(s1) || !Number.isFinite(s2) || s1 * s1 + s2 * s2 < 1e-16) {
        this.active[v] = 0;
        this.y1[v] = 0;
        this.y2[v] = 0;
      } else {
        this.y1[v] = s1;
        this.y2[v] = s2;
      }
    }

    // 2. Contact / plectrum bursts
    for (let b = 0; b < this.maxBursts; b++) {
      if (!this.bActive[b]) continue;
      let step = this.bStep[b];
      const total = this.bTotal[b];
      const tau = this.bTauSamples[b];
      const gain = this.bGain[b];
      const bright = this.bBright[b];
      const isPluck = this.bPluck[b] === 1;
      const alpha = this.bAlpha[b];
      let lp = this.bLpState[b];

      for (let i = 0; i < nFrames && step < total; i++, step++) {
        let raw;
        if (isPluck) {
          const u = step / tau;
          raw = (u < 1 ? u : Math.exp(-(u - 1) * 1.8)) * (0.65 + 0.35 * this.nextNoise());
        } else if (step < tau) {
          const u = (Math.PI * step) / tau;
          raw = 1.25 * Math.sqrt(Math.max(0, Math.sin(u))) * Math.cos(u);
        } else {
          const dt = (step - tau) / tau;
          raw = -0.34 * Math.exp(-dt * 1.15) * Math.cos(1.6 * dt);
        }
        const tex = 0.08 * bright * this.nextNoise() * Math.exp(-step / (tau * 2.2));
        lp += alpha * ((raw + tex) - lp);
        outChan[i] += lp * gain;
      }

      this.bStep[b] = step;
      this.bLpState[b] = Number.isFinite(lp) ? lp : 0;
      if (step >= total || !Number.isFinite(lp)) this.bActive[b] = 0;
    }

    // 3. 1D Kelly–Lochbaum Wind / Brass / Reed / Flute / Flap-Valve Bore Waveguides
    const sr = Number.isFinite(sampleRate) && sampleRate > 8000 ? sampleRate : REF_SAMPLE_RATE;
    const dt = 1 / sr;
    const srRatio = REF_SAMPLE_RATE / sr;
    const envAlpha = 1 - Math.exp(-0.00095 * srRatio);
    const embAlpha = 1 - Math.exp(-0.0015 * srRatio);
    const cellLoss = Math.pow(0.9994, srRatio);
    const dcR = Math.exp((-2 * Math.PI * 18) / sr);
    const vibInc = (2 * Math.PI * 4.9) / sr;

    for (let w = 0; w < this.windSlots.length; w++) {
      const ws = this.windSlots[w];
      if (!ws.active) continue;
      if (ws.targetBreath < 0.001 && ws.breathEnv < 0.0004) {
        ws.active = false;
        ws.id = '';
        continue;
      }

      const M = ws.cellCount;
      const kArr = ws.k;
      const shArr = ws.shunt;
      const bellAlpha = ws.bellAlpha;
      const a1 = ws.thiranA1;
      const a2 = ws.thiranA2;
      const exc = ws.exciter;
      const fOpenEst = sr / Math.max(8, 2 * ws.exactCellsScaled);
      const reedCut = exc === 0
        ? Math.min(sr * 0.38, 1950)
        : exc === 2
          ? Math.min(sr * 0.42, Math.max(700, Math.max(ws.embouchureHz * 2.4, fOpenEst * 2.8)))
          : Math.min(sr * 0.4, Math.max(380, ws.embouchureHz * 4.2));
      const alphaReed = dt / (1 / (2 * Math.PI * reedCut) + dt);

      for (let i = 0; i < nFrames; i++) {
        ws.breathEnv += envAlpha * (ws.targetBreath - ws.breathEnv);
        ws.smoothEmbHz += embAlpha * (ws.embouchureHz - ws.smoothEmbHz);
        ws.vibPhase += vibInc;
        if (ws.vibPhase > Math.PI * 2) ws.vibPhase -= Math.PI * 2;
        const vib = 1 + 0.016 * Math.sin(ws.vibPhase);
        const pMouth = ws.breathEnv * vib * (1 + (exc === 2 ? 0.04 : 0.012) * this.nextNoise());

        // Bell open-end 2nd-order Thiran fractional delay + inverting lowpass radiation
        const pIncEnd = ws.pPlus[M - 1];
        const pEnd = a2 * pIncEnd + ws.apS1;
        ws.apS1 = a1 * (pIncEnd - pEnd) + ws.apS2;
        ws.apS2 = pIncEnd - a2 * pEnd;

        ws.bellLp += bellAlpha * (pEnd - ws.bellLp);
        const pReflBell = -0.962 * ws.bellLp;
        let radiated = (pEnd - ws.bellLp) * 0.85 + 0.42 * ws.bellLp;

        // Mouthpiece nonlinear reed / brass lip-reed / flute jet / compliant flap-valve exciter
        let pIn0;
        const pBack0 = ws.pMinus[0];
        if (exc === 0) {
          ws.reedLp += alphaReed * (pBack0 - ws.reedLp);
          const dp = pMouth - ws.reedLp;
          let rReed = 0.24 + 0.92 * dp;
          if (rReed < -0.92) rReed = -0.92;
          else if (rReed > 0.995) rReed = 0.995;
          pIn0 = pMouth - rReed * dp;
        } else if (exc === 1) {
          const omegaLip = 2 * Math.PI * ws.smoothEmbHz;
          const omegaLipSq = omegaLip * omegaLip;
          const dampLip = omegaLip / 6.8;

          ws.reedLp += alphaReed * (pBack0 - ws.reedLp);
          const dBackRate = (ws.reedLp - ws.prevBack) / Math.max(1e-5, omegaLip * dt);
          ws.prevBack = ws.reedLp;

          const drive = 0.28 * pMouth + 0.42 * ws.reedLp + 0.55 * ws.lipV / Math.max(50, omegaLip) * pMouth + 0.18 * dBackRate;
          const acc = omegaLipSq * (drive - ws.lipY) - dampLip * ws.lipV - omegaLipSq * 0.45 * ws.lipY * ws.lipY * ws.lipY;
          ws.lipV += dt * acc;
          ws.lipY += dt * ws.lipV;
          if (ws.lipY < -0.8) {
            ws.lipY = -0.8;
            ws.lipV *= -0.2;
          } else if (ws.lipY > 1.1) {
            ws.lipY = 1.1;
            ws.lipV *= -0.2;
          }
          const lipOpen = Math.max(0, 0.22 + 0.92 * ws.lipY);
          const dp = pMouth - 0.65 * ws.reedLp;
          const flow = lipOpen * Math.tanh(dp * 1.65) * 0.78;
          pIn0 = 0.88 * ws.reedLp + flow;

          const alphaCup = Math.min(0.45, dt * 2 * Math.PI * (ws.smoothEmbHz * 4.5));
          ws.cupLp += alphaCup * ((radiated + 0.35 * flow) - ws.cupLp);
          radiated = ws.cupLp;
        } else if (exc === 3) {
          // Fletcher autonomous compliant flap-valve (sub-resonant relaxation slap-oscillator)
          ws.reedLp += alphaReed * (pBack0 - ws.reedLp);
          const omegaFlap = 2 * Math.PI * ws.smoothEmbHz;
          const omegaSq = omegaFlap * omegaFlap;
          const dampFlap = omegaFlap / 1.85;
          const bernSuction = pMouth * (0.36 - 1.35 * Math.max(0, ws.lipY + 0.18));
          const acc =
            omegaSq * (bernSuction + 0.38 * ws.reedLp - ws.lipY - 0.52 * ws.lipY * ws.lipY * ws.lipY) +
            pMouth * 1.55 * dampFlap * ws.lipV -
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
          const flow = flapOpen * Math.tanh((pMouth - 0.45 * ws.reedLp) * 1.85) * 0.84;
          pIn0 = 0.86 * ws.reedLp + flow;
        } else {
          // Open-embouchure air-jet flute: AC-coupled jet-labium deflection (zero DC gain) + negative reflection (-0.78)
          ws.reedLp += alphaReed * (pBack0 - ws.reedLp);
          const alphaJetHp = Math.min(0.25, (2 * Math.PI * Math.max(45, fOpenEst * 0.35)) * dt);
          ws.lipY += alphaJetHp * (ws.reedLp - ws.lipY);
          const acBore = ws.reedLp - ws.lipY;
          const uJet = acBore * (1.85 + 0.85 * pMouth) + 0.06 * pMouth * this.nextNoise();
          const jet = -pMouth * 0.72 * Math.tanh(uJet * 1.45);
          pIn0 = -0.78 * ws.reedLp + jet;
        }
        if (!Number.isFinite(pIn0)) {
          clearWindSlotState(ws);
          continue;
        }
        if (pIn0 > 1.6) pIn0 = 1.6;
        else if (pIn0 < -1.6) pIn0 = -1.6;

        // 1-multiply Kelly–Lochbaum scattering ladder + open tonehole shunts
        const nPlus = ws.nextPlus;
        const nMinus = ws.nextMinus;
        nPlus[0] = pIn0;
        nMinus[M - 1] = pReflBell;
        for (let c = 0; c < M - 1; c++) {
          let fp = ws.pPlus[c];
          let bm = ws.pMinus[c + 1];
          const sh = shArr[c];
          if (sh < -0.001) {
            const w = sh * (fp + bm);
            fp += w;
            bm += w;
            radiated -= w * 0.52;
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

        const dcOut = radiated - ws.dcX1 + dcR * ws.dcY1;
        ws.dcX1 = radiated;
        ws.dcY1 = Math.abs(dcOut) < 1e-20 ? 0 : dcOut;
        if (!Number.isFinite(dcOut)) {
          clearWindSlotState(ws);
          continue;
        }
        outChan[i] += dcOut * ws.gain;
      }
    }

    // C^1-continuous soft-knee limiter + NaN guard
    for (let i = 0; i < nFrames; i++) {
      const s = outChan[i];
      if (!Number.isFinite(s)) {
        outChan[i] = 0;
        if (outR) outR[i] = 0;
        continue;
      }
      const absS = Math.abs(s);
      const lim = absS > 0.25 ? Math.sign(s) * (0.25 + 0.60 * Math.tanh((absS - 0.25) / 0.60)) : s;
      outChan[i] = lim;
      if (outR) outR[i] = lim;
    }
    return true;
  }
}

registerProcessor('physbox-modal-synth', ModalResonatorProcessor);
