// ---------------------------------------------------------------------------
// Unified 3D Aeroacoustics Solver (Rotors, Wings, Windmills & Cloth)
// ---------------------------------------------------------------------------
//
// Zero pre-recorded samples — derives tonal and broadband aeroacoustic
// synthesis parameters directly from live MuJoCo kinematics, blade/patch
// geometry, angle of attack, aerodynamic loading, and cloth areal density:
//
//   A. Gutin Propeller & Rotor Tonality (Gutin 1936; Hanson 1980):
//      - Blade-Passing Frequency f_BPF = B * |Ω| / (2π)
//      - High-speed rotors (f_BPF >= 22 Hz): pitched loading + thickness
//        harmonics n * f_BPF (n = 1..16) whose upper-partial brightness scales
//        with tip Mach number M_tip = v_tip / c_0 and thrust loading ||F_aero||.
//      - Sub-audible / Low-RPM rotors (0.5 <= f_BPF < 22 Hz, e.g. 3-blade or
//        4-blade windmills): rhythmic raised-cosine AM blade-pass envelope on
//        the broadband Strouhal wake noise ("whoomp-whoomp-whoomp").
//
//   B. Curle Boundary-Layer & Stall Whoosh (Curle 1955; Brooks-Pope-Marcolini):
//      - Strouhal vortex-shedding center frequency:
//          d_eff = t_geom + c_chord * |sin(α)|
//          f_c = clamp(0.21 * v_rel / d_eff, 120 Hz, 4200 Hz)
//      - Filter Q transitions smoothly from sleek attached whistling (Q ≈ 3.2
//        at |α| < 10°) to rough separated stall buffeting (Q ≈ 0.75 + 8..18 Hz
//        flutter AM past |α| > 15°).
//      - Dipole acoustic power scales with sqrt(A_wing) * v_rel^2.2.
//
//   C. Cloth, Sails & Flags in the Wind:
//      - Continuous flutter & weave-rubbing high-shelf rustle (2.2..5.5 kHz)
//        proportional to inter-element hinge angular speed <|θ̇|>.
//      - Impulsive Trailing-Edge "Flag Snap" / Whip Crack: asymmetric N-wave
//        shock pulse (0.7..2.6 ms) whose center frequency & lowpass contour
//        shift inversely with areal density σ = m / A (kg/m²):
//          * Heavy canvas (σ >= 0.30 kg/m²): warm 300..950 Hz thwack
//          * Medium cotton (σ ≈ 0.15 kg/m²): crisp 800..2000 Hz snap
//          * Ultralight ripstop nylon (σ <= 0.06 kg/m²): bright 1800..4800 Hz crackle
// ---------------------------------------------------------------------------

import type { AeroSnapEvent, AeroVoiceTelemetry } from '../workers/physicsWorkerProtocol';

const SPEED_OF_SOUND_AIR = 343.0; // m/s at 20 °C
const MIN_AUDIBLE_BPF_HZ = 22.0;
const MIN_SUB_BPF_HZ = 0.5;
const NUM_GUTIN_HARMONICS = 16;
const GUST_OMEGA_1 = 2 * Math.PI * 0.31;
const GUST_OMEGA_2 = 2 * Math.PI * 0.73;

const GUTIN_HUMP_SIN = Float64Array.from(
  { length: NUM_GUTIN_HARMONICS },
  (_, i) => Math.sin(Math.min(Math.PI, (i / 6) * Math.PI)),
);
const GUTIN_INV_N_POW = Float64Array.from(
  { length: NUM_GUTIN_HARMONICS },
  (_, i) => 1 / Math.pow(i + 1, 0.32),
);

function roundN(v: number, scale: number): number {
  return Math.round(v * scale) / scale;
}

export interface AeroSynthParams {
  id: string;
  active: boolean;
  /** Blade-passing frequency B * |Ω| / (2π), or 0 for non-rotating wings/cloth. */
  bpfHz: number;
  /** True when f_BPF >= 22 Hz so the C++ PeriodicWave tonal prop oscillator speaks. */
  tonalActive: boolean;
  /** Normalized Gutin loading + thickness harmonic weights H_1..H_16. */
  harmonicWeights: number[];
  /** Tonal rotor dipole level [0..0.45]. */
  tonalGain: number;
  /** Strouhal vortex-shedding / billow-whoosh bandpass center frequency [85..4200 Hz]. */
  noiseCenterHz: number;
  /** Strouhal bandpass Q (high ~3.2 for sleek attached flow, warm ~1.4 for cloth billow, ~0.75 in deep stall). */
  noiseQ: number;
  /** Post-bandpass Kolmogorov turbulence lowpass cutoff (Hz) stripping flat high-kHz hiss. */
  lowpassHz?: number;
  /** Broadband Strouhal / boundary-layer / billow whoosh level [0..0.42]. */
  noiseGain: number;
  /** Weave-rubbing / cloth-fold rustle gain [0..0.25] for articulated/composite/XPBD cloth. */
  rustleGain: number;
  /** Characteristic weave-rubbing spectral parameter [2200..5500 Hz] scaled by fabric lightness. */
  rustleFreqHz: number;
  /** Amplitude-modulation rate (Hz): sub-audible blade-pass swoosh or Kármán cloth/stall flutter! */
  amRateHz: number;
  /** Amplitude-modulation depth [0..0.85] applied to the broadband whoosh & cloth rustle branches. */
  amDepth: number;
  /** Separated-flow stall roughness factor [0 = attached laminar/sleek, 1 = deep stall]. */
  stallRoughness: number;
  /** Optional understated tonal Aeolian vortex-shedding hum frequency (Hz) for slender masts/stays. */
  aeolianFreqHz?: number;
  /** Optional understated tonal Aeolian vortex-shedding hum gain [0..0.05] for slender masts/stays. */
  aeolianGain?: number;
}

export interface SnapSynthParams {
  nodeId: string;
  active: boolean;
  /** Asymmetric N-wave shock duration τ_snap in seconds [0.0007..0.0026]. */
  durationSec: number;
  /** Primary spectral peak / bandpass center frequency (Hz) governed by areal density σ. */
  centerHz: number;
  /** Bandpass filter Q for fabric membrane body resonance. */
  bandpassQ: number;
  /** Post-pulse lowpass rolloff (Hz) separating warm canvas thwack from bright nylon crackle. */
  lowpassHz: number;
  /** Output peak amplitude [0..0.60]. */
  gain: number;
  /** Physical Curle dipole impulse (N·s), preserved for deterministic PRNG seeding. */
  impulseNs?: number;
  /** Monotonic event sequence number for deterministic non-repeating white-noise phase seeding. */
  seq?: number;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

function finiteNonNeg(v: number | undefined, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : fallback;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (!Number.isFinite(x)) return 0;
  const t = clamp((x - edge0) / Math.max(1e-9, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Pure, deterministic solver mapping a single hub/wing/cloth `AeroVoiceTelemetry`
 * snapshot to continuous native WebAudio synthesis parameters.
 */
export function solveAeroAcousticVoice(
  telemetry: AeroVoiceTelemetry & { airDensityKgM3?: number },
): AeroSynthParams {
  const id = telemetry.hubOrBodyId;
  const blades = Math.max(0, Math.floor(finiteNonNeg(telemetry.bladeCount)));
  const rawOmega = typeof telemetry.omegaRadPerSec === 'number' && Number.isFinite(telemetry.omegaRadPerSec)
    ? telemetry.omegaRadPerSec
    : 0;
  const absOmega = Math.min(20000, Math.abs(rawOmega));
  const tipSpeed = Math.min(1200, finiteNonNeg(telemetry.tipSpeedMps));
  const relSpeed = Math.min(1200, finiteNonNeg(telemetry.relSpeedMps));
  const bendRate = Math.min(5000, finiteNonNeg(telemetry.bendRateRadPerSec));
  const effSpeed = Math.max(relSpeed, tipSpeed * 0.72);

  // Vacuum or near-stationary guard -> 0 gain, 0 active voices
  if (telemetry.isVacuum || (effSpeed < 0.25 && absOmega < 0.35 && bendRate < 0.5)) {
    return {
      id,
      active: false,
      bpfHz: 0,
      tonalActive: false,
      harmonicWeights: [],
      tonalGain: 0,
      noiseCenterHz: 400,
      noiseQ: 1.5,
      lowpassHz: 600,
      noiseGain: 0,
      rustleGain: 0,
      rustleFreqHz: 3200,
      amRateHz: 0,
      amDepth: 0,
      stallRoughness: 0,
      aeolianFreqHz: 0,
      aeolianGain: 0,
    };
  }

  const area = clamp(telemetry.areaM2 ?? 0.01, 1e-5, 25.0);
  const chord = clamp(telemetry.chordM ?? 0.05, 0.004, 4.0);
  const thickness = clamp(telemetry.thicknessM ?? 0.003, 0.0005, 0.5);
  const rawAlpha = typeof telemetry.alphaDeg === 'number' && Number.isFinite(telemetry.alphaDeg) ? telemetry.alphaDeg : 0;
  const absAlphaDeg = clamp(Math.abs(rawAlpha), 0, 90);
  const alphaRad = (absAlphaDeg * Math.PI) / 180;
  const aeroForce = Math.min(1e6, finiteNonNeg(telemetry.aeroForceN));
  const rho = clamp(telemetry.airDensityKgM3 ?? 1.225, 0.005, 25.0);
  const rhoScale = Math.pow(rho / 1.225, 0.85);
  const gainScale =
    typeof telemetry.gainScale === 'number' && Number.isFinite(telemetry.gainScale)
      ? clamp(telemetry.gainScale, 0, 2.0)
      : 1.0;

  // Detect static slender cylindrical masts / stays (`chord ≈ thickness = D`, attenuated `gainScale <= 0.55`):
  // these emit a warm, understated Aeolian vortex-shedding hum (~115..210 Hz) rather than broadband hiss.
  const isAeolianCylinder =
    !telemetry.isCloth &&
    blades === 0 &&
    absOmega < 0.05 &&
    bendRate < 0.05 &&
    gainScale > 0 &&
    gainScale <= 0.55 &&
    thickness >= 0.75 * chord;

  // -------------------------------------------------------------------------
  // 1. Stall separation factor & Strouhal vortex-shedding / billow whoosh
  // -------------------------------------------------------------------------
  // Attached below 10°, progressive trailing-edge separation 10°..22°, deep bluff stall above 22°
  const stallRoughness = smoothstep(10.0, 22.0, absAlphaDeg);

  const wakeProjScale = 0.08 + 0.37 * stallRoughness;
  const dEff = Math.max(0.0012, thickness + wakeProjScale * chord * Math.abs(Math.sin(alphaRad)));
  const rawStrouhalHz = (0.21 * Math.max(0.25, effSpeed)) / dEff;

  let noiseCenterHz: number;
  let noiseQ: number;
  let lowpassHz: number;
  if (telemetry.isCloth) {
    // Flexible billowing flag / sail: boundary-layer & billow-fold shear thickness
    // d_shear ~ 0.010 + 0.008 * c + 0.014 * c * |sin(alpha)| (~13..22 mm), producing a warm,
    // deep 85..280 Hz outdoor wind-whoosh formant that sweeps organically with coastal gusts!
    const dShear = Math.max(0.008, 0.010 + chord * (0.008 + 0.014 * Math.abs(Math.sin(alphaRad))));
    const billowLift = 1.0 + 0.16 * clamp(bendRate / 22.0, 0, 1.35);
    noiseCenterHz = roundN(clamp(((0.21 * Math.max(0.25, effSpeed)) / dShear) * billowLift, 85, 280), 100);
    noiseQ = roundN(1.55 - 0.40 * stallRoughness, 1000);
    lowpassHz = roundN(clamp(noiseCenterHz * 2.35 + 90 * clamp(bendRate / 20.0, 0, 1.2), 280, 680), 10);
  } else if (isAeolianCylinder) {
    // Hollow mast + stay coupled Aeolian lock-in (~115..210 Hz, gliding gently with wind gusts)
    const aeolianBaseHz =
      rawStrouhalHz > 210
        ? 115 + 95 * Math.tanh((rawStrouhalHz - 115) / 250)
        : clamp(rawStrouhalHz, 115, 210);
    noiseCenterHz = roundN(aeolianBaseHz, 100);
    noiseQ = 3.8;
    lowpassHz = roundN(clamp(aeolianBaseHz * 1.65, 210, 380), 10);
  } else {
    // Rigid wings, rotors, windmills & bluff bodies:
    // Narrow whistling Q (~3.2) at sleek attached angles (|α| < 10°), widening into
    // rough separated buffeting (Q ≈ 0.75) past stall (|α| > 15..22°)!
    noiseCenterHz = roundN(clamp(rawStrouhalHz, 120, 4200), 100);
    noiseQ = roundN(3.2 - (3.2 - 0.75) * stallRoughness, 1000);
    lowpassHz = roundN(clamp(noiseCenterHz * (1.75 + 0.45 * stallRoughness) + 180, 420, 2800), 10);
  }

  // -------------------------------------------------------------------------
  // 2. Gutin Rotor BPF & Harmonic Spectrum vs Free-Stream Wing/Cloth/Aeolian
  //    Smoothly crossfaded across bpfHz ∈ [0.30..0.80] and [22.0..34.0] Hz!
  // -------------------------------------------------------------------------
  const bpfHz = blades >= 1 ? Math.min(16000, (blades * absOmega) / (2 * Math.PI)) : 0;
  const machTip = clamp(tipSpeed / SPEED_OF_SOUND_AIR, 0, 0.88);

  const speedRamp = smoothstep(0.25, 0.85, effSpeed);
  let freeNoiseGain: number;
  if (telemetry.isCloth) {
    // Separate steady freestream tangential slip from UNSTEADY cloth billow & normal loading:
    // a taut sheet aligned parallel to laminar flow (`bendRate = 0, sin(alpha) = 0`) radiates minimal
    // dipole sound, whereas active Kármán billowing & coastal gusts swell organically without flatlining!
    const gustQ = rhoScale * Math.sqrt(area) * Math.pow(effSpeed / 8.5, 1.85);
    const normalLoadDrive =
      aeroForce > 0
        ? clamp(aeroForce / Math.max(0.15, 3.2 * area), 0, 1.6)
        : 0.45 * Math.abs(Math.sin(alphaRad));
    const billowActivity = clamp(
      0.12 + 0.62 * clamp(bendRate / 14.0, 0, 1.25) + 0.26 * normalLoadDrive,
      0.12,
      1.15,
    );
    freeNoiseGain = clamp(0.27 * Math.tanh(0.52 * gustQ) * billowActivity * speedRamp, 0, 0.27);
  } else {
    // Free-flying wing / glider / vane / bluff body (Curle dipole law with smooth saturation)
    const stallBoost = 1.0 + 0.85 * stallRoughness;
    const curleDrive = rhoScale * Math.sqrt(area) * Math.pow(effSpeed, 2.0) * stallBoost;
    freeNoiseGain = clamp(0.32 * Math.tanh(0.042 * curleDrive) * speedRamp, 0, 0.32);
  }

  let freeAmRateHz = 0;
  let freeAmDepth = 0;
  if (telemetry.isCloth) {
    // Traveling billow-wave Kármán cadence along flag chord St_L ≈ 0.46 * U / L_chord (typically 3..7 Hz),
    // blended with emergent flexural bend rate and given deep rhythmic *whuff-whuff* modulation!
    const chordFlapHz = clamp((0.46 * Math.max(1.0, effSpeed)) / Math.max(0.22, chord), 2.5, 6.8);
    const bendFlapHz = clamp(bendRate / (2 * Math.PI * 1.4), 2.4, 7.2);
    freeAmRateHz = bendRate > 0.4 ? 0.65 * chordFlapHz + 0.35 * bendFlapHz : chordFlapHz;
    freeAmDepth = clamp(0.46 + 0.38 * clamp(bendRate / 9.5, 0, 1.0) + 0.08 * stallRoughness, 0.38, 0.84);
  } else if (stallRoughness > 0.05) {
    // Separated stall buffeting flutter (8..18 Hz)
    freeAmRateHz = clamp(8.0 + 0.55 * effSpeed + 4.0 * stallRoughness, 8.0, 18.0);
    freeAmDepth = clamp(0.62 * stallRoughness, 0, 0.68);
  }

  let tonalActive = false;
  const harmonicWeights: number[] = [];
  let tonalGain = 0;
  let noiseGain = freeNoiseGain;
  let amRateHz = freeAmRateHz;
  let amDepth = freeAmDepth;

  if (blades >= 1 && bpfHz > 0.30) {
    // Sub-audible / Low-RPM rotor branch (e.g. 3-blade or 4-blade Windmill):
    // Rhythmic blade-pass "whoomp-whoomp-whoomp" swoosh modulated at f_BPF
    const subBlend = smoothstep(0.30, 0.80, bpfHz);
    const kTSub = 1.35;
    const subDipoleArg = Math.max(
      0,
      kTSub * Math.max(aeroForce, 0.04 * rho * area * effSpeed * effSpeed) * Math.max(tipSpeed, effSpeed),
    );
    const swooshRamp = smoothstep(0.25, 0.95, Math.max(tipSpeed, effSpeed));
    const subNoise = clamp(0.145 * Math.log10(1 + subDipoleArg) * swooshRamp, 0, 0.30);
    const subAmRate = Math.max(MIN_SUB_BPF_HZ, bpfHz);
    const subAmDepth = clamp(0.52 + 0.24 * Math.min(1, tipSpeed / 4.0), 0.35, 0.82);

    noiseGain = freeNoiseGain * (1 - subBlend) + subNoise * subBlend;
    amRateHz = subBlend > 0.05 ? subAmRate : freeAmRateHz;
    amDepth = freeAmDepth * (1 - subBlend) + subAmDepth * subBlend;

    if (bpfHz >= MIN_AUDIBLE_BPF_HZ) {
      // High-speed propeller / quadcopter rotor (f_BPF >= 22 Hz):
      // Crossfade smoothly from blade-pass AM swoosh into Gutin dipole harmonics over 22..34 Hz!
      const tonalBlend = smoothstep(MIN_AUDIBLE_BPF_HZ, 34.0, bpfHz);
      const thrustLoadingNorm = clamp(aeroForce / Math.max(0.08, area * 35), 0, 2.5);
      const decayBase = clamp(
        0.46 + 0.34 * Math.min(1, machTip * 6.5) + 0.14 * Math.min(1.5, thrustLoadingNorm),
        0.42,
        0.90,
      );

      let decayPow = 1.0;
      for (let n = 1; n <= NUM_GUTIN_HARMONICS; n++) {
        if (n * bpfHz > 18000) break;
        const idx = n - 1;
        const loadingHump = 1.0 + 0.55 * thrustLoadingNorm * GUTIN_HUMP_SIN[idx];
        const w = decayPow * loadingHump * GUTIN_INV_N_POW[idx];
        harmonicWeights.push(roundN(w, 10000));
        decayPow *= decayBase;
      }

      const kT = 0.85;
      const dipoleArg = Math.max(0, kT * Math.max(aeroForce, 0.015 * rho * area * tipSpeed * tipSpeed) * tipSpeed);
      const rawTonal = 0.115 * Math.log10(1 + dipoleArg);
      const ramp = smoothstep(0.25, 1.2, tipSpeed);
      const propTonal = clamp(rawTonal * ramp, 0, 0.28);

      const wakeGain = clamp(
        0.045 * Math.log10(1 + 0.45 * dipoleArg) * (0.65 + 0.55 * stallRoughness) * ramp,
        0,
        0.18,
      );
      const propAmRate = stallRoughness > 0.15 ? clamp(10 + 0.4 * effSpeed, 8, 18) : bpfHz;
      const propAmDepth = stallRoughness > 0.15 ? 0.22 * stallRoughness : 0;

      tonalGain = roundN(propTonal * Math.max(0.08, tonalBlend), 10000);
      tonalActive = harmonicWeights.length > 0 && tonalGain >= 0.0015;
      noiseGain = noiseGain * (1 - tonalBlend) + wakeGain * tonalBlend;
      amDepth = amDepth * (1 - tonalBlend) + propAmDepth * tonalBlend;
      amRateHz = tonalBlend > 0.75 && stallRoughness > 0.15 ? propAmRate : amRateHz;
    }
  }

  tonalGain = roundN(tonalGain * gainScale, 10000);
  const aeolianScale = isAeolianCylinder ? 0.44 : 1.0;
  noiseGain = roundN(clamp(noiseGain * gainScale * aeolianScale, 0, 0.32), 10000);
  amRateHz = roundN(clamp(amRateHz, 0, 16000), 1000);
  amDepth = roundN(clamp(amDepth, 0, 0.85), 1000);

  const aeolianFreqHz = isAeolianCylinder ? noiseCenterHz : 0;
  const aeolianGain = isAeolianCylinder
    ? roundN(clamp(freeNoiseGain * gainScale * 0.30, 0.004, 0.024), 10000)
    : 0;

  // -------------------------------------------------------------------------
  // 3. Cloth / Sail Weave-Rubbing Rustle Contour (2.2..5.5 kHz index)
  // -------------------------------------------------------------------------
  let rustleGain = 0;
  let rustleFreqHz = 3200;
  if (telemetry.isCloth || bendRate > 0.25) {
    const sigma = clamp(telemetry.arealDensityKgM2 ?? 0.15, 0.02, 1.2);
    // Lighter ripstop crispness sits higher (4.5..5.5 kHz); heavier canvas sits warmer (2.2..3.0 kHz)
    const lightness = clamp((0.32 - sigma) / 0.28, 0, 1);
    rustleFreqHz = roundN(clamp(2200 + 3300 * lightness, 2200, 5500), 10);
    const bendNorm = clamp(bendRate / 18.0, 0, 1.5);
    rustleGain = roundN(
      clamp(
        0.085 * rhoScale * bendNorm * (0.55 + 0.45 * smoothstep(0.2, 3.0, effSpeed)) * gainScale,
        0,
        0.16,
      ),
      10000,
    );
  }

  const active =
    tonalGain >= 0.0015 ||
    noiseGain >= 0.0015 ||
    rustleGain >= 0.0015 ||
    aeolianGain >= 0.0015;
  tonalActive = tonalActive && tonalGain >= 0.0015;

  return {
    id,
    active,
    bpfHz: roundN(bpfHz, 1000),
    tonalActive,
    harmonicWeights,
    tonalGain,
    noiseCenterHz,
    noiseQ,
    lowpassHz,
    noiseGain,
    rustleGain,
    rustleFreqHz,
    amRateHz,
    amDepth,
    stallRoughness: roundN(stallRoughness, 10000),
    ...(aeolianGain > 0 ? { aeolianFreqHz, aeolianGain } : {}),
  };
}

/**
 * Pure, deterministic solver for an impulsive trailing-edge "Flag Snap" / whip crack.
 * Maps impulse momentum & fabric areal density σ = m / A (kg/m²) to an asymmetric
 * N-wave shock duration (0.7..2.6 ms) and spectral bandpass contour:
 *   - Heavy canvas (σ >= 0.30 kg/m²): warm 300..950 Hz thwack
 *   - Medium cotton (σ ≈ 0.15 kg/m²): crisp 800..2000 Hz snap
 *   - Ultralight ripstop nylon (σ <= 0.06 kg/m²): bright 1800..4800 Hz crackle
 */
export function solveClothSnapPulse(snap: AeroSnapEvent): SnapSynthParams {
  const impulse = Math.min(50, finiteNonNeg(snap.impulseNs));
  const relSpeed = Math.min(1200, finiteNonNeg(snap.relSpeedMps));
  if (impulse < 0.0004) {
    return {
      nodeId: snap.nodeId,
      active: false,
      durationSec: 0.0015,
      centerHz: 1200,
      bandpassQ: 1.2,
      lowpassHz: 2400,
      gain: 0,
      impulseNs: impulse,
      ...(snap.seq !== undefined ? { seq: snap.seq } : {}),
    };
  }

  const sigma = clamp(snap.arealDensityKgM2 ?? 0.15, 0.02, 1.20);

  // Continuous physical mapping across σ:
  //   σ = 0.04 kg/m² (ripstop nylon) -> center ~3100 Hz, lowpass ~4800 Hz, τ ~0.75 ms
  //   σ = 0.15 kg/m² (medium cotton) -> center ~1350 Hz, lowpass ~2200 Hz, τ ~1.35 ms
  //   σ = 0.35 kg/m² (heavy canvas)  -> center ~580 Hz,  lowpass ~950 Hz,  τ ~2.35 ms
  const speedBoost = 1 + 0.04 * clamp(relSpeed - 4.0, -2.0, 12.0);
  const rawCenterHz = (195 / Math.pow(sigma, 0.86)) * speedBoost;
  const centerHz = +clamp(rawCenterHz, 320, 4400).toFixed(1);
  const lowpassHz = +clamp(centerHz * 1.62, 550, 5600).toFixed(1);

  // Shock duration τ_snap inversely related to wave speed / areal stiffness: 0.7..2.6 ms
  const rawTau = 0.00052 + 0.0052 * Math.pow(sigma, 0.82);
  const durationSec = +clamp(rawTau, 0.0007, 0.0026).toFixed(5);

  const bandpassQ = +clamp(1.05 + 0.35 * smoothstep(0.05, 0.35, sigma), 0.95, 1.65).toFixed(2);
  const gain = +clamp(0.24 * Math.log10(1 + impulse * 180), 0.02, 0.52).toFixed(4);

  return {
    nodeId: snap.nodeId,
    active: true,
    durationSec,
    centerHz,
    bandpassQ,
    lowpassHz,
    gain,
    impulseNs: +impulse.toFixed(5),
    ...(snap.seq !== undefined ? { seq: snap.seq } : {}),
  };
}

/**
 * Deterministic, zero-allocation 3D spatially-varying curl/sinusoid gust perturbation
 * around mean wind `[windX, windY]` (±12% spatial shear across `(x, y, z, t)`),
 * preventing symmetric cloth grids or vanes from freezing into a silent static catenary.
 */
export function evaluateGustWind(
  windX: number,
  windY: number,
  x: number,
  y: number,
  z: number,
  timeSec: number,
): [number, number, number] {
  if (!Number.isFinite(windX + windY) || !Number.isFinite(x + y + z + timeSec)) {
    return [0, 0, 0];
  }
  const meanSpeedSq = windX * windX + windY * windY;
  if (!(meanSpeedSq >= 1e-8)) return [0, 0, 0];
  const meanSpeed = Math.sqrt(meanSpeedSq);

  // Advected Taylor frozen-turbulence phase u = k · (x - V_conv * t)
  const invMean = 1 / meanSpeed;
  const ux = windX * invMean;
  const uy = windY * invMean;
  const sStream = x * ux + y * uy - 0.72 * meanSpeed * timeSec;
  const sCross = -x * uy + y * ux;

  // Coherent multi-second Kaimal outdoor gust breathing (~0.31 Hz primary swell + ~0.73 Hz secondary eddy)
  // paired with incompressible-style advected spatial eddies
  const coherentGust =
    1.0 +
    0.19 * Math.sin(GUST_OMEGA_1 * timeSec + 0.35) +
    0.11 * Math.sin(GUST_OMEGA_2 * timeSec - 1.1);
  const e1 = Math.sin(4.7 * sStream + 6.1 * z + 1.9 * timeSec);
  const e2 = Math.cos(8.3 * sStream - 5.3 * sCross + 3.7 * timeSec);
  const e3 = Math.sin(11.9 * z + 7.1 * sCross - 4.3 * timeSec);

  const longGain = coherentGust * (1.0 + 0.075 * e1 + 0.030 * e2);
  const latShear = meanSpeed * coherentGust * (0.070 * e2 + 0.038 * e3);
  const vertShear = meanSpeed * (0.055 * e1 * e3 + 0.035 * Math.sin(6.4 * sStream + 2.8 * timeSec));

  return [
    windX * longGain - uy * latShear,
    windY * longGain + ux * latShear,
    vertShear,
  ];
}
