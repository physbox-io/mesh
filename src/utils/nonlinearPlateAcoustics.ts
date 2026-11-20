// ---------------------------------------------------------------------------
// von Kármán Geometric Nonlinearity for Thin Plates, Cymbals & Gongs
// (Upward Modal Energy Cascade, Delayed Crash Bloom & Pitch Glide)
// ---------------------------------------------------------------------------
//
// Physics implemented (Touzé, Thomas & Chaigne 2002; Fletcher & Rossing §20):
// 1. Dimensionless von Kármán transverse deflection ratio:
//      eta = w_max / h = (J / (alpha_m * m_plate * omega_1 * h)) * sensitivity
//    Soft mallet taps (eta <= 0.22) remain strictly linear; high-energy strikes
//    (eta > 0.22) activate cubic geometric membrane stretching in the plate!
// 2. Chu–Herrmann / Berger nonlinear pitch glide over 50–250 ms:
//      df(0) / f_0 = (3 * (1 - nu^2) / 8) * eta^2 - c_arch * archRatio * eta
//    - Flat plates / crash cymbals (archRatio ≈ 0): initial upward pitch surge
//      gliding down to f_0 as amplitude decays at 2 / tau_1.
//    - Shallow-arched Chinese opera gongs (archRatio > 0.3): initial quadratic
//      arch-flattening pitch DIP (negative cents) or upward/downward glide!
// 3. Upward Modal Energy Cascade (Wave Turbulence):
//    3-wave and 4-wave resonant coupling drains energy faster out of the low
//    flexural modes while pumping 8..12 dense high-frequency Rossing–Chladni
//    partials whose envelopes BLOOM at delayed peak times t_bloom in 45–250 ms,
//    accompanied by a shimmering high-frequency turbulence wash!
// ---------------------------------------------------------------------------

import type { NonlinearPlateSpec, SceneNode } from '../types/scene';
import type { BodyModalProfile } from './modalAudio';
import { analyze3DSolidCrossSections } from './solidAcoustics3D';

export interface NonlinearCascadeVoice {
  freqHz: number;
  peakGain: number;
  /** Delayed energy-cascade rise time (s) from strike t = 0 to peak envelope amplitude. */
  bloomAttackSec: number;
  /** Post-peak exponential decay duration (s). */
  decaySec: number;
}

export interface NonlinearPlateCrashEnvelope {
  active: boolean;
  /** Dimensionless peak deflection-to-thickness ratio w_max / h. */
  deflectionRatioEta: number;
  /** Normalized wave-turbulence cascade strength Gamma in [0, 1]. */
  cascadeStrength: number;
  /** Initial fractional frequency offset df(0) / f_0 (positive = sharp start, negative = arched gong dip). */
  pitchGlideRatio: number;
  /** Signed initial pitch shift in musical cents (1200 * log2(1 + pitchGlideRatio)). */
  pitchGlideCents: number;
  /** Exponential pitch-glide relaxation time constant (0.050–0.250 s). */
  glideTauSec: number;
  /** Multiplicative decay factor (<= 1) shortening low primary modes as energy pumps upward into the cascade! */
  lowModeDecayScale: number;
  /** Delayed-bloom upper Rossing–Chladni plate partials (up to ~13.8 kHz). */
  cascadeVoices: NonlinearCascadeVoice[];
  /** Peak amplitude of broadband high-frequency wave-turbulence shimmer wash (0..0.45). */
  shimmerPeakGain: number;
  /** Delayed rise time (s) of the high-frequency shimmer wash. */
  shimmerBloomSec: number;
  /** Decay duration (s) of the high-frequency shimmer wash. */
  shimmerDecaySec: number;
  /** Center frequency (Hz) of the metallic shimmer bandpass/shelf filter. */
  shimmerBandHz: number;
}

/**
 * Returns true if `node` explicitly enables `nonlinearPlate` or is a thin, stiff,
 * high-Q metal/glass/ceramic plate/disk (`bMid / hMin >= 18`, `modulusGPa >= 45`).
 */
export function isNonlinearPlateCandidate(
  node: SceneNode,
  profile?: Pick<BodyModalProfile, 'regime' | 'material'>,
): boolean {
  const spec = node.nonlinearPlate;
  if (spec) return spec.enabled !== false && (spec.crashSensitivity ?? 1) > 0;
  if (node.acousticString || node.acousticMembrane || node.windInstrument) return false;
  if (profile && profile.regime !== 'plate') return false;
  if (profile && (profile.material.modulusGPa < 45 || profile.material.qualityQ < 220)) return false;

  const sec = analyze3DSolidCrossSections(node);
  const [hMin, bMid, lMax] = sec.dimsSortedAsc;
  return bMid / Math.max(1e-4, hMin) >= 18 && lMax / Math.max(1e-4, bMid) <= 2.2;
}

/**
 * Computes the von Kármán geometric nonlinearity envelope for a strike of momentum
 * `impulseNs` (N·s) on `node`. Returns `null` when linear (disabled, thick block,
 * or soft tap below the von Kármán threshold `eta <= 0.22`).
 */
export function solveVonKarmanPlateImpact(
  profile: BodyModalProfile,
  node: SceneNode,
  impulseNs: number,
  tauC = 0.0008,
): NonlinearPlateCrashEnvelope | null {
  if (!Number.isFinite(impulseNs) || impulseNs <= 0) return null;
  if (!isNonlinearPlateCandidate(node, profile)) return null;

  const spec: NonlinearPlateSpec = node.nonlinearPlate ?? {};
  const sensitivity = Math.max(0, Math.min(5.0, spec.crashSensitivity ?? 1.0));
  if (sensitivity <= 1e-4) return null;

  const sec = analyze3DSolidCrossSections(node);
  const [hRaw, bMid, lMax] = sec.dimsSortedAsc;
  const hPlate = Math.max(0.0003, Math.min(hRaw, sec.meanWallThicknessM || hRaw));
  const f1 = Math.max(35, profile.fundamentalHz || 180);
  const omega1 = 2 * Math.PI * f1;
  const plateMassKg = Math.max(
    0.015,
    profile.massKg ?? sec.solidVolumeM3 * Math.max(500, profile.material.density),
  );

  // Infer shallow shell arch / boss curvature from `spec.archRatio` or hollow camber in `sec`
  const inferredArch =
    spec.archRatio !== undefined
      ? Math.max(-2.0, Math.min(3.0, spec.archRatio))
      : sec.hollowFraction >= 0.08 && hRaw > sec.meanWallThicknessM * 1.45
        ? Math.min(1.6, (hRaw - sec.meanWallThicknessM) / Math.max(0.0005, 2 * hPlate))
        : 0;

  // Effective modal mass of fundamental (2,0)/(1,1) free plate mode ~ 0.38 * m_plate;
  // shallow shell curvature elevates linear stiffness by sqrt(1 + 2.2 * archRatio^2).
  const modalMassKg = 0.38 * plateMassKg;
  const shellStiffBoost = Math.sqrt(1 + 2.2 * inferredArch * inferredArch);
  const wLinM = impulseNs / Math.max(1e-3, modalMassKg * omega1 * shellStiffBoost);
  const etaLin = (wLinM / hPlate) * sensitivity;
  // Exact Duffing / von Kármán energy conservation (1/2 m v0^2 = 1/2 k1 w^2 + 1/4 k3 w^4):
  // cubic membrane tension self-limits peak transverse deflection to w_max / h ~ sqrt(eta_lin) at large strikes!
  const gammaDuffing = 0.65;
  const eta = Math.min(
    6.0,
    Math.sqrt((Math.sqrt(1 + 2 * gammaDuffing * etaLin * etaLin) - 1) / gammaDuffing),
  );

  // Linear regime guard: gentle mallet taps (eta <= 0.50) produce pure linear bell/chime tone without crash bloom!
  const etaCrit = 0.50;
  if (eta <= etaCrit) return null;

  const excess = eta - etaCrit;
  const cascadeStrength = Math.max(0, Math.min(1.0, (excess * excess) / (0.85 + 0.50 * excess * excess)));

  const nu = 0.30;
  let pitchGlideRatio: number;
  let pitchGlideCents: number;
  if (typeof spec.pitchGlideCents === 'number' && Number.isFinite(spec.pitchGlideCents)) {
    const driveFrac = Math.min(1.35, (eta * eta) / (1.2 + 0.75 * eta * eta));
    pitchGlideCents = Math.max(-450, Math.min(550, spec.pitchGlideCents * driveFrac));
    pitchGlideRatio = Math.pow(2, pitchGlideCents / 1200) - 1;
  } else {
    // Chu–Herrmann / Marguerre cubic membrane stiffening minus quadratic shallow-shell arch softening!
    const cubicStiff = (3 * (1 - nu * nu) / 8) * eta * eta * 0.25;
    const archSoften = 0.34 * inferredArch * eta;
    const rawShift = cubicStiff - archSoften;
    pitchGlideRatio = Math.max(-0.18, Math.min(0.24, rawShift));
    pitchGlideCents = 1200 * Math.log2(Math.max(0.5, 1 + pitchGlideRatio));
  }

  // Pitch glide and cascade bloom span 50–250 ms (honoring `spec.bloomDelayMs` when configured)
  const baseBloomSec =
    typeof spec.bloomDelayMs === 'number' && Number.isFinite(spec.bloomDelayMs) && spec.bloomDelayMs > 0
      ? Math.max(0.020, Math.min(0.400, spec.bloomDelayMs * 1e-3))
      : Math.max(0.050, Math.min(0.220, 0.052 + 0.042 * Math.min(3.5, eta)));

  const glideTauSec = Math.max(0.050, Math.min(0.250, baseBloomSec * 1.05));

  // Energy conservation: upward cascade pumps kinetic/strain energy out of low modes into high modes
  const lowModeDecayScale = Math.max(0.38, 1 / (1 + 0.85 * cascadeStrength));

  // Build 10 Rossing–Chladni upper plate cascade partials (inharmonic ~ (m + 2n)^1.42 dispersion)
  // Higher partials reach peak amplitude LATER as the turbulent wavefront cascades to short wavelengths!
  const nCascade = 10;
  const cascadeVoices: NonlinearCascadeVoice[] = [];
  const aspectSkew = Math.min(1.15, Math.max(0.92, lMax / Math.max(1e-4, bMid)));
  const qBase = Math.max(80, profile.material.qualityQ);
  // Softer mallets (longer tauC) still feed the nonlinear internal cascade from low modes, though very soft yarn slightly tempers peak ультра-highs
  const malletCoupling = Math.max(0.45, Math.min(1.15, Math.pow(0.0012 / Math.max(0.0003, tauC), 0.25)));

  for (let k = 1; k <= nCascade; k++) {
    // Quasi-irregular Chladni plate partial ratios avoiding artificial harmonic comb periodicity
    const detune = 1 + 0.031 * Math.sin(k * 2.39996) * aspectSkew;
    const freqHz = f1 * Math.pow(1.75 + 0.82 * k, 1.38) * detune;
    if (freqHz > 14200 || freqHz < 90) continue;

    // Higher k blooms progressively later across 45..250 ms
    const prog = (k - 1) / (nCascade - 1);
    const bloomAttackSec = Math.max(
      0.035,
      Math.min(0.250, baseBloomSec * (0.55 + 0.85 * prog)),
    );

    const spectralEnv = Math.pow(k, -0.58) * (0.45 + 0.55 * cascadeStrength);
    const peakGain = Math.min(0.42, 0.34 * cascadeStrength * spectralEnv * malletCoupling);
    if (peakGain < 0.004) continue;

    const modeQ = qBase / (1 + 0.55 * k * Math.sqrt(k));
    const decaySec = Math.max(0.08, Math.min(3.4, (modeQ / (Math.PI * freqHz)) * 3.6 + bloomAttackSec * 0.8));

    cascadeVoices.push({
      freqHz: +freqHz.toFixed(2),
      peakGain: +peakGain.toFixed(4),
      bloomAttackSec: +bloomAttackSec.toFixed(4),
      decaySec: +decaySec.toFixed(4),
    });
  }

  const shimmerMix = Math.max(0, Math.min(1, spec.shimmerMix ?? (0.55 * profile.material.brightness)));
  const shimmerPeakGain = +(Math.min(0.38, 0.36 * cascadeStrength * shimmerMix * malletCoupling)).toFixed(4);
  const shimmerBloomSec = +Math.max(0.045, Math.min(0.240, baseBloomSec * 0.92)).toFixed(4);
  const shimmerDecaySec = +Math.max(0.18, Math.min(2.8, (qBase / 950) * 1.45 * (0.6 + 0.6 * cascadeStrength))).toFixed(4);
  const shimmerBandHz = +Math.max(2400, Math.min(8200, f1 * 14)).toFixed(1);

  return {
    active: true,
    deflectionRatioEta: +eta.toFixed(4),
    cascadeStrength: +cascadeStrength.toFixed(4),
    pitchGlideRatio: +pitchGlideRatio.toFixed(5),
    pitchGlideCents: +pitchGlideCents.toFixed(2),
    glideTauSec: +glideTauSec.toFixed(4),
    lowModeDecayScale: +lowModeDecayScale.toFixed(4),
    cascadeVoices,
    shimmerPeakGain,
    shimmerBloomSec,
    shimmerDecaySec,
    shimmerBandHz,
  };
}
