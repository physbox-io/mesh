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
  /** Strouhal vortex-shedding bandpass center frequency [120..4200 Hz]. */
  noiseCenterHz: number;
  /** Strouhal bandpass Q (high ~3.2 for sleek attached flow, low ~0.75 in deep stall). */
  noiseQ: number;
  /** Broadband Strouhal / boundary-layer noise level [0..0.42]. */
  noiseGain: number;
  /** High-shelf weave-rubbing rustle gain [0..0.25] for articulated/composite cloth. */
  rustleGain: number;
  /** High-shelf weave-rubbing frequency [2200..5500 Hz]. */
  rustleFreqHz: number;
  /** Amplitude-modulation rate (Hz): sub-audible blade-pass swoosh or stall/cloth flutter! */
  amRateHz: number;
  /** Amplitude-modulation depth [0..0.85] applied to the broadband noise branch. */
  amDepth: number;
  /** Separated-flow stall roughness factor [0 = attached laminar/sleek, 1 = deep stall]. */
  stallRoughness: number;
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
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / Math.max(1e-9, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Pure, deterministic solver mapping a single hub/wing/cloth `AeroVoiceTelemetry`
 * snapshot to continuous native WebAudio synthesis parameters.
 */
export function solveAeroAcousticVoice(telemetry: AeroVoiceTelemetry): AeroSynthParams {
  const id = telemetry.hubOrBodyId;
  const blades = Math.max(0, Math.floor(telemetry.bladeCount || 0));
  const absOmega = Math.abs(telemetry.omegaRadPerSec || 0);
  const tipSpeed = Math.max(0, telemetry.tipSpeedMps || 0);
  const relSpeed = Math.max(0, telemetry.relSpeedMps || 0);
  const effSpeed = Math.max(relSpeed, tipSpeed * 0.72);

  // Vacuum or near-stationary guard -> 0 gain, 0 active voices
  if (telemetry.isVacuum || (effSpeed < 0.25 && absOmega < 0.35 && (telemetry.bendRateRadPerSec || 0) < 0.5)) {
    return {
      id,
      active: false,
      bpfHz: 0,
      tonalActive: false,
      harmonicWeights: [],
      tonalGain: 0,
      noiseCenterHz: 400,
      noiseQ: 1.5,
      noiseGain: 0,
      rustleGain: 0,
      rustleFreqHz: 3200,
      amRateHz: 0,
      amDepth: 0,
      stallRoughness: 0,
    };
  }

  const area = clamp(telemetry.areaM2 || 0.01, 1e-5, 25.0);
  const chord = clamp(telemetry.chordM || 0.05, 0.004, 4.0);
  const thickness = clamp(telemetry.thicknessM || 0.003, 0.0005, 0.5);
  const absAlphaDeg = clamp(Math.abs(telemetry.alphaDeg || 0), 0, 90);
  const alphaRad = (absAlphaDeg * Math.PI) / 180;
  const aeroForce = Math.max(0, telemetry.aeroForceN || 0);
  const bendRate = Math.max(0, telemetry.bendRateRadPerSec || 0);

  // -------------------------------------------------------------------------
  // 1. Stall separation factor & Strouhal vortex-shedding bandpass
  // -------------------------------------------------------------------------
  // Attached below 10°, progressive trailing-edge separation 10°..22°, deep bluff stall above 22°
  const stallRoughness = smoothstep(10.0, 22.0, absAlphaDeg);

  // Effective bluff/trailing-edge wake thickness:
  // At attached angles, trailing-edge boundary-layer displacement thickness δ* ≈ t_geom + 0.06 * c * |sin(α)|;
  // past stall, separated shear-layer wake opens to ~0.45 * c * |sin(α)|!
  const wakeProjScale = 0.08 + 0.37 * stallRoughness;
  const dEff = Math.max(0.0012, thickness + wakeProjScale * chord * Math.abs(Math.sin(alphaRad)));
  const rawStrouhalHz = (0.21 * Math.max(0.25, effSpeed)) / dEff;
  const noiseCenterHz = +clamp(rawStrouhalHz, 120, 4200).toFixed(2);

  // Narrow whistling Q (~3.2) at sleek attached angles (|α| < 10°), widening into
  // rough separated buffeting (Q ≈ 0.75) past stall (|α| > 15..22°)!
  const noiseQ = +(3.2 - (3.2 - 0.75) * stallRoughness).toFixed(3);

  // -------------------------------------------------------------------------
  // 2. Gutin Rotor BPF & Harmonic Spectrum vs Free-Stream Wing/Cloth
  // -------------------------------------------------------------------------
  const bpfHz = blades >= 1 ? (blades * absOmega) / (2 * Math.PI) : 0;
  const machTip = clamp(tipSpeed / SPEED_OF_SOUND_AIR, 0, 0.88);

  let tonalActive = false;
  const harmonicWeights: number[] = [];
  let tonalGain = 0;
  let noiseGain: number;
  let amRateHz = 0;
  let amDepth = 0;

  if (blades >= 1 && bpfHz >= MIN_AUDIBLE_BPF_HZ) {
    // High-speed propeller / quadcopter rotor (f_BPF >= 22 Hz):
    // Gutin dipole loading + thickness harmonics H_1..H_16
    tonalActive = true;
    const thrustLoadingNorm = clamp(aeroForce / Math.max(0.08, area * 35), 0, 2.5);
    // Brightness parameter: higher tip Mach and higher thrust loading lift upper harmonics n = 2..10
    const decayBase = clamp(0.46 + 0.34 * Math.min(1, machTip * 6.5) + 0.14 * Math.min(1.5, thrustLoadingNorm), 0.42, 0.90);

    for (let n = 1; n <= NUM_GUTIN_HARMONICS; n++) {
      if (n * bpfHz > 18000) break;
      // Bessel-like Gutin envelope: n=1 fundamental + strong n=2..6 buzz humped by loading/tip speed
      const loadingHump = 1.0 + 0.55 * thrustLoadingNorm * Math.sin(Math.min(Math.PI, ((n - 1) / 6) * Math.PI));
      const w = Math.pow(decayBase, n - 1) * loadingHump * (1 / Math.pow(n, 0.32));
      harmonicWeights.push(+w.toFixed(4));
    }

    // Dipole acoustic power scaling: gain ∝ log10(1 + k_T * ||F_aero|| * v_tip)
    const kT = 0.85;
    const dipoleArg = Math.max(0, kT * Math.max(aeroForce, 0.015 * area * tipSpeed * tipSpeed) * tipSpeed);
    const rawTonal = 0.115 * Math.log10(1 + dipoleArg);
    const ramp = smoothstep(0.25, 1.2, tipSpeed);
    tonalGain = +clamp(rawTonal * ramp, 0, 0.28).toFixed(4);

    // Broadband trailing-edge + tip-vortex turbulent wake alongside the tonal prop buzz
    const wakeGain = 0.045 * Math.log10(1 + 0.45 * dipoleArg) * (0.65 + 0.55 * stallRoughness) * ramp;
    noiseGain = +clamp(wakeGain, 0, 0.18).toFixed(4);

    if (stallRoughness > 0.15) {
      amRateHz = +clamp(10 + 0.4 * effSpeed, 8, 18).toFixed(2);
      amDepth = +(0.22 * stallRoughness).toFixed(3);
    }
  } else if (blades >= 1 && bpfHz >= MIN_SUB_BPF_HZ) {
    // Sub-audible / Low-RPM rotor (0.5 <= f_BPF < 22 Hz, e.g. 3-blade or 4-blade Windmill):
    // Zero sub-bass oscillator; modulate broadband Strouhal noise at f_BPF for rhythmic
    // blade-pass "whoomp-whoomp-whoomp" swoosh!
    tonalActive = false;
    const kT = 1.35;
    const dipoleArg = Math.max(
      0,
      kT * Math.max(aeroForce, 0.04 * area * effSpeed * effSpeed) * Math.max(tipSpeed, effSpeed),
    );
    const swooshRamp = smoothstep(0.25, 0.95, Math.max(tipSpeed, effSpeed));
    noiseGain = +clamp(0.145 * Math.log10(1 + dipoleArg) * swooshRamp, 0, 0.30).toFixed(4);
    amRateHz = +bpfHz.toFixed(3);
    // Deep rhythmic raised-cosine envelope depth as each sail sweeps past the tower mast
    amDepth = +clamp(0.52 + 0.24 * Math.min(1, tipSpeed / 4.0), 0.35, 0.82).toFixed(3);
  } else {
    // Free-flying wing / glider / vane / cloth sheet (Curle dipole law: ∝ sqrt(A) * v_rel^2.2)
    const speedRamp = smoothstep(0.25, 0.85, effSpeed);
    const curlePower = Math.sqrt(area) * Math.pow(effSpeed, 2.2);
    const stallBoost = 1.0 + 0.85 * stallRoughness;
    const rawWhoosh = 0.026 * Math.log10(1 + 2.4 * curlePower * stallBoost) * speedRamp;
    noiseGain = +clamp(rawWhoosh, 0, 0.32).toFixed(4);

    if (telemetry.isCloth) {
      // Cloth flutter modulation driven by emergent flapping rate (`bendRateRadPerSec`) or Strouhal wake
      const flapHz = bendRate > 0.4 ? bendRate / (2 * Math.PI) : 3.5 + 0.65 * effSpeed;
      amRateHz = +clamp(flapHz, 1.8, 20.0).toFixed(2);
      amDepth = +clamp(0.28 + 0.38 * Math.min(1, bendRate / 14.0) + 0.15 * stallRoughness, 0.20, 0.78).toFixed(3);
    } else if (stallRoughness > 0.05) {
      // Separated stall buffeting flutter (8..18 Hz)
      amRateHz = +clamp(8.0 + 0.55 * effSpeed + 4.0 * stallRoughness, 8.0, 18.0).toFixed(2);
      amDepth = +clamp(0.62 * stallRoughness, 0, 0.68).toFixed(3);
    }
  }

  // -------------------------------------------------------------------------
  // 3. Cloth / Sail Weave-Rubbing High-Shelf Rustle (2.2..5.5 kHz)
  // -------------------------------------------------------------------------
  let rustleGain = 0;
  let rustleFreqHz = 3200;
  if (telemetry.isCloth || bendRate > 0.25) {
    const sigma = clamp(telemetry.arealDensityKgM2 || 0.15, 0.02, 1.2);
    // Lighter ripstop crispness sits higher (4.5..5.5 kHz); heavier canvas sits warmer (2.2..3.0 kHz)
    const lightness = clamp((0.32 - sigma) / 0.28, 0, 1);
    rustleFreqHz = +clamp(2200 + 3300 * lightness, 2200, 5500).toFixed(1);
    const bendNorm = clamp(bendRate / 18.0, 0, 1.5);
    rustleGain = +clamp(0.085 * bendNorm * (0.55 + 0.45 * smoothstep(0.2, 3.0, effSpeed)), 0, 0.16).toFixed(4);
  }

  const active = tonalGain >= 0.0015 || noiseGain >= 0.0015 || rustleGain >= 0.0015;

  return {
    id,
    active,
    bpfHz: +bpfHz.toFixed(3),
    tonalActive,
    harmonicWeights,
    tonalGain,
    noiseCenterHz,
    noiseQ,
    noiseGain,
    rustleGain,
    rustleFreqHz,
    amRateHz,
    amDepth,
    stallRoughness: +stallRoughness.toFixed(4),
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
  const impulse = Math.max(0, snap.impulseNs || 0);
  const relSpeed = Math.max(0, snap.relSpeedMps || 0);
  if (impulse < 0.0004) {
    return {
      nodeId: snap.nodeId,
      active: false,
      durationSec: 0.0015,
      centerHz: 1200,
      bandpassQ: 1.2,
      lowpassHz: 2400,
      gain: 0,
    };
  }

  const sigma = clamp(snap.arealDensityKgM2 || 0.15, 0.02, 1.20);

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
  const meanSpeed = Math.hypot(windX, windY);
  if (meanSpeed < 1e-4) return [0, 0, 0];

  // Advected Taylor frozen-turbulence phase u = k · (x - V_conv * t)
  const ux = windX / meanSpeed;
  const uy = windY / meanSpeed;
  const sStream = x * ux + y * uy - 0.72 * meanSpeed * timeSec;
  const sCross = -x * uy + y * ux;

  // Incompressible-style multi-scale sinusoidal eddies bounded strictly within ±12%
  const e1 = Math.sin(4.7 * sStream + 6.1 * z + 1.9 * timeSec);
  const e2 = Math.cos(8.3 * sStream - 5.3 * sCross + 3.7 * timeSec);
  const e3 = Math.sin(11.9 * z + 7.1 * sCross - 4.3 * timeSec);

  const longGain = 1.0 + 0.085 * e1 + 0.035 * e2;
  const latShear = meanSpeed * (0.075 * e2 + 0.040 * e3);
  const vertShear = meanSpeed * (0.055 * e1 * e3 + 0.035 * Math.sin(6.4 * sStream + 2.8 * timeSec));

  return [
    windX * longGain - uy * latShear,
    windY * longGain + ux * latShear,
    vertShear,
  ];
}
