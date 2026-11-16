// Off-main-thread real-time modal, stiff-string, and 1D Kelly–Lochbaum wind/brass
// waveguide processor (48 kHz). Loaded from same-origin /modalAudioProcessor.js.

const MAX_BORE_CELLS = 180;

function createWindSlot() {
  return {
    id: '',
    active: false,
    exciter: 0, // 0 = reed, 1 = brass_lip, 2 = flute_jet
    targetBreath: 0,
    breathEnv: 0,
    embouchureHz: 320,
    smoothEmbHz: 320,
    cellCount: 32,
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
    const sr = sampleRate;
    const seen = new Set();
    for (let vIdx = 0; vIdx < voices.length && vIdx < this.windSlots.length; vIdx++) {
      const cfg = voices[vIdx];
      if (!cfg || !cfg.id) continue;
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
            slot.pPlus.fill(0);
            slot.pMinus.fill(0);
            slot.bellLp = 0;
            slot.reedLp = 0;
            slot.cupLp = 0;
            slot.lipY = 0;
            slot.lipV = 0;
            slot.prevBack = 0;
            slot.smoothEmbHz = Math.max(80, Math.min(1800, cfg.embouchureHz || 320));
            break;
          }
        }
      }
      if (!slot) continue;

      const M = Math.max(8, Math.min(MAX_BORE_CELLS - 1, cfg.cellCount | 0));
      if (slot.cellCount !== M) {
        // Clear tail cells if bore resized
        for (let c = M; c < MAX_BORE_CELLS; c++) {
          slot.pPlus[c] = 0;
          slot.pMinus[c] = 0;
        }
        slot.cellCount = M;
      }
      slot.exciter = cfg.exciter === 'brass_lip' ? 1 : cfg.exciter === 'flute_jet' ? 2 : 0;
      const rawKPa = Math.max(0, cfg.breathKPa || 0);
      slot.targetBreath = rawKPa < 0.08
        ? 0
        : slot.exciter === 0
          ? 0.42 + 0.36 * Math.tanh((rawKPa - 0.5) / 3.2)
          : Math.max(0, Math.min(0.88, rawKPa / 5.5));
      slot.embouchureHz = Math.max(80, Math.min(1800, cfg.embouchureHz || 320));
      slot.gain = cfg.gain ?? (slot.exciter === 1 ? 0.65 : 0.95);

      const jk = cfg.junctionK || [];
      slot.k.fill(0);
      for (let i = 0; i < M - 1 && i < jk.length; i++) {
        slot.k[i] = Math.max(-0.92, Math.min(0.92, jk[i]));
      }

      slot.shunt.fill(0);
      const shunts = cfg.shunts || [];
      for (let s = 0; s < shunts.length; s++) {
        const ci = shunts[s].cell | 0;
        if (ci >= 1 && ci < M - 1) {
          slot.shunt[ci] = Math.max(-0.85, Math.min(0, shunts[s].coeff || 0));
        }
      }

      const fBell = Math.max(350, Math.min(sr * 0.42, cfg.bellCutoffHz || 1500));
      const rc = 1 / (2 * Math.PI * fBell);
      const dt = 1 / sr;
      slot.bellAlpha = dt / (rc + dt);
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
    const sr = sampleRate;
    const nyquist = sr * 0.47;
    const level = Math.min(0.65, Math.max(0, msg.level || 0));
    if (level < 0.001) return;

    const voices = msg.voices || [];
    for (let i = 0; i < voices.length; i++) {
      const v = voices[i];
      const f = v.freqHz;
      if (!(f >= 20 && f < nyquist)) continue;
      const dur = Math.max(0.012, Math.min(6.0, v.decaySec || 0.15));
      const r = Math.exp(-9.21034037 / (dur * sr));
      const omega = (2 * Math.PI * f) / sr;
      const sinW = Math.sin(omega);
      if (Math.abs(sinW) < 1e-6) continue;

      const slot = this.allocVoiceSlot();
      this.c1[slot] = 2 * r * Math.cos(omega);
      this.c2[slot] = r * r;
      const amp = level * (v.gain || 0.1);
      this.y1[slot] = amp * r * sinW;
      this.y2[slot] = 0;
      this.active[slot] = 1;
    }

    const bSlot = this.bCursor;
    this.bCursor = (this.bCursor + 1) % this.maxBursts;
    const tauSamples = Math.max(8, Math.min(sr * 0.008, (msg.tauC || 0.0008) * sr));
    this.bTauSamples[bSlot] = tauSamples;
    this.bStep[bSlot] = 0;
    this.bTotal[bSlot] = Math.ceil(tauSamples * (msg.isPluck ? 4.5 : 8.5));
    const bright = Math.max(0, Math.min(1, msg.brightness ?? 0.5));
    this.bBright[bSlot] = bright;
    this.bPluck[bSlot] = msg.isPluck ? 1 : 0;
    const pulseWeight = voices.length === 0 ? 1.45 : (msg.isPluck ? 0.24 : 0.4 + 0.4 * bright);
    this.bGain[bSlot] = level * pulseWeight;
    const cutoffHz = msg.isPluck ? (900 + 2600 * bright) : (1050 + 2400 * bright);
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
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    this.rng = x;
    return x / 2147483648;
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
      if (s1 * s1 + s2 * s2 < 1e-16) {
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
      this.bLpState[b] = lp;
      if (step >= total) this.bActive[b] = 0;
    }

    // 3. 1D Kelly–Lochbaum Wind / Brass / Reed Bore Waveguides
    const sr = sampleRate;
    const dt = 1 / sr;
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
      const exc = ws.exciter;
      const reedCut = exc === 0 ? 1950 : Math.min(sr * 0.4, ws.embouchureHz * 4.2);
      const alphaReed = dt / (1 / (2 * Math.PI * reedCut) + dt);

      for (let i = 0; i < nFrames; i++) {
        ws.breathEnv += 0.00095 * (ws.targetBreath - ws.breathEnv);
        ws.smoothEmbHz += 0.0015 * (ws.embouchureHz - ws.smoothEmbHz);
        ws.vibPhase += vibInc;
        if (ws.vibPhase > Math.PI * 2) ws.vibPhase -= Math.PI * 2;
        const vib = 1 + 0.016 * Math.sin(ws.vibPhase);
        const pMouth = ws.breathEnv * vib * (1 + (exc === 2 ? 0.06 : 0.012) * this.nextNoise());

        // Bell open-end reflection (inverting lowpass) + radiation
        const pEnd = ws.pPlus[M - 1];
        ws.bellLp += bellAlpha * (pEnd - ws.bellLp);
        const pReflBell = -0.962 * ws.bellLp;
        let radiated = (pEnd - ws.bellLp) * 0.85 + 0.42 * ws.bellLp;

        // Mouthpiece nonlinear reed / brass lip-reed / flute jet exciter
        let pIn0;
        const pBack0 = ws.pMinus[0];
        if (exc === 0) {
          // Inward-beating single reed (Smith STK Clarinet):
          // Higher mouth pressure closes the cane reed toward the lay (r -> +1.0),
          // creating active negative resistance (|dp+/dp-| > 1) and warm odd-harmonic oscillation!
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
        } else {
          ws.reedLp += alphaReed * (pBack0 - ws.reedLp);
          const jet = Math.tanh((pMouth * 1.4 - 0.85 * ws.reedLp) * 2.8) * pMouth * 0.52;
          pIn0 = 0.86 * ws.reedLp + jet;
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
          nPlus[c + 1] = (fp + d) * 0.9994;
          nMinus[c] = (bm + d) * 0.9994;
        }
        const tmpP = ws.pPlus;
        ws.pPlus = nPlus;
        ws.nextPlus = tmpP;
        const tmpM = ws.pMinus;
        ws.pMinus = nMinus;
        ws.nextMinus = tmpM;

        const dcOut = radiated - ws.dcX1 + 0.995 * ws.dcY1;
        ws.dcX1 = radiated;
        ws.dcY1 = dcOut;
        outChan[i] += dcOut * ws.gain;
      }
    }

    for (let i = 0; i < nFrames; i++) {
      const s = outChan[i];
      const lim = (s > 0.25 || s < -0.25) ? Math.tanh(s * 1.15) * 0.85 : s;
      outChan[i] = lim;
      if (outR) outR[i] = lim;
    }
    return true;
  }
}

registerProcessor('physbox-modal-synth', ModalResonatorProcessor);
