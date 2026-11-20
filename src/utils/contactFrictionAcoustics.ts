// ---------------------------------------------------------------------------
// Continuous Rolling, Sliding, Scraping & Singing-Rim Contact Friction Solver
// (Starter #2)
// ---------------------------------------------------------------------------
//
// Maps throttled (~70 Hz) MuJoCo continuous contact-pair telemetry
// (`ContinuousContactEvent`) + structural `BodyModalProfile`s into four
// physical tribological excitation regimes:
//   1. `rolling`          — Hertzian contact-patch spatial filtering & micro-impact
//                           asperity traversal (rolling glass marble, steel ball on rail)
//   2. `scraping`         — Fractal 1/f^beta surface-roughness broadband excitation
//                           + irregular stick-slip grain chatter (stone drag, wood slide)
//   3. `stick_slip_squeal`— Stribeck negative friction-velocity slope locking onto
//                           high-Q structural modes (brake / metal-on-metal squeal)
//   4. `rim_singing`      — Tangential circumferential rub locking onto axisymmetric
//                           shell/goblet quadrupole modes with revolving nodal-line
//                           shimmer beating df = v_slip / (pi * R_rim) (wineglass / bowl)
//
// Pure & store-free: deterministic mapping ready for `postWorkletFrictionUpdate`.
// ---------------------------------------------------------------------------

import type { SceneNode } from '../types/scene';
import type { BowedStringContactEvent, ContinuousContactEvent } from '../workers/physicsWorkerProtocol';
import {
  inferAcousticMaterial,
  inferColliderContactProps,
  type BodyModalProfile,
} from './modalAudio';
import type { SpatialAcousticParams } from './spatialAcoustics';

export type ContactFrictionRegime =
  | 'silent'
  | 'rolling'
  | 'scraping'
  | 'stick_slip_squeal'
  | 'rim_singing';

export interface WorkletFrictionVoicePayload {
  id: string;
  active: boolean;
  regime: ContactFrictionRegime;
  /** Broadband fractal surface-roughness bandpass center frequency (Hz). */
  noiseCenterHz: number;
  /** Broadband bandpass filter Q. */
  noiseQ: number;
  /** Hertzian contact-patch spatial lowpass cutoff frequency (Hz). */
  patchLowpassHz: number;
  /** Broadband surface-roughness noise gain [0..0.36]. */
  noiseGain: number;
  /** Rolling eccentricity / stick-slip grain AM rate (Hz). */
  grainRateHz: number;
  /** Grain AM depth [0..1]. */
  grainDepth: number;
  /** True when tonal stick-slip squeal or singing-rim modal lock-in is active. */
  tonalActive: boolean;
  /** Primary locked structural modal frequency f_1 (Hz). */
  tonalFreqHz: number;
  /** Secondary revolving quadrupole rim-beat or companion mode frequency (Hz). */
  tonalBeatFreqHz: number;
  /** Tonal stick-slip branch gain [0..0.42]. */
  tonalGain: number;
  /** Soft-saturation drive [0.3..2.2] (pure ~0.38 for singing rim, edgy ~1.6 for squeal). */
  tonalDrive: number;
  /** Envelope attack/bloom time constant (s): ~0.18 s for singing rim, ~0.018 s for scrape/roll. */
  attackTauSec: number;
  /** Tracked structural resonator peak 1 & 2 frequencies, Qs, and gains. */
  mode1Hz: number;
  mode1Q: number;
  mode1GainDb: number;
  mode2Hz: number;
  mode2Q: number;
  mode2GainDb: number;
  /** Optional 48 kHz 3D vibro-acoustic impulse response of the primary radiating body. */
  bodyIr?: Float32Array<ArrayBuffer> | null;
  bodyIrSig?: string;
  /** Optional Starter #6c stereo spatial pan in [-1, 1] and distance attenuation. */
  pan?: number;
  distanceGain?: number;
}

export interface SolveContactFrictionOptions {
  primaryProfile?: BodyModalProfile | null;
  primaryNode?: SceneNode | null;
  partnerProfile?: BodyModalProfile | null;
  partnerNode?: SceneNode | null;
  spatial?: Partial<SpatialAcousticParams> | null;
}

const ROUGHNESS_BY_DEFORM_MATERIAL: Record<string, number> = {
  glass: 0.06,
  steel: 0.14,
  softMetal: 0.18,
  plastic: 0.25,
  rubber: 0.30,
  ceramic: 0.32,
  pasta: 0.40,
  hardwood: 0.48,
  softwood: 0.58,
  stone: 0.85,
};

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

function finiteOr(v: number | undefined | null, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / Math.max(1e-9, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Estimates normalized surface roughness `R_a` in `[0.04, 0.92]` from a body's
 * material preset, density, and optional colliding geom friction.
 */
export function inferSurfaceRoughness(
  node?: SceneNode | null,
  geomName?: string,
): number {
  if (!node) return 0.42; // mineral/concrete floor default
  const matId = node.deformMaterial;
  let base = matId && ROUGHNESS_BY_DEFORM_MATERIAL[matId] !== undefined
    ? ROUGHNESS_BY_DEFORM_MATERIAL[matId]
    : undefined;

  if (base === undefined) {
    const mat = inferAcousticMaterial(node);
    const label = mat.label.toLowerCase();
    if (label.includes('glass')) base = 0.08;
    else if (label.includes('steel')) base = 0.14;
    else if (label.includes('aluminium') || label.includes('alloy')) base = 0.18;
    else if (label.includes('ceramic')) base = 0.32;
    else if (label.includes('hardwood')) base = 0.48;
    else if (label.includes('softwood')) base = 0.58;
    else base = 0.28;
  }

  const hitGeom = geomName
    ? (node.geoms ?? []).find((g) => g.name === geomName)
    : node.geoms?.[0];
  const mu = hitGeom?.friction?.[0];
  if (typeof mu === 'number' && Number.isFinite(mu)) {
    // Ultra-slick surfaces slightly smoother; high-grit surfaces rougher
    base = clamp(base * (0.78 + 0.32 * clamp(mu, 0.05, 1.5)), 0.04, 0.92);
  }
  return +clamp(base, 0.04, 0.92).toFixed(3);
}

function makeSilentPayload(id: string): WorkletFrictionVoicePayload {
  return {
    id,
    active: false,
    regime: 'silent',
    noiseCenterHz: 500,
    noiseQ: 1.2,
    patchLowpassHz: 1800,
    noiseGain: 0,
    grainRateHz: 0,
    grainDepth: 0,
    tonalActive: false,
    tonalFreqHz: 440,
    tonalBeatFreqHz: 442,
    tonalGain: 0,
    tonalDrive: 0.5,
    attackTauSec: 0.020,
    mode1Hz: 440,
    mode1Q: 4.0,
    mode1GainDb: 0,
    mode2Hz: 980,
    mode2Q: 3.5,
    mode2GainDb: 0,
  };
}

/**
 * Pure, deterministic solver mapping one aggregated `ContinuousContactEvent`
 * and optional partner `BodyModalProfile`s into WebAudio resonator parameters.
 */
export function solveContactFrictionVoice(
  event: ContinuousContactEvent,
  opts: SolveContactFrictionOptions = {},
): WorkletFrictionVoicePayload {
  const id = event.pairId || `${event.nodeId}:${event.otherNodeId ?? 'world'}`;
  const tangentSpeed = Math.max(0, finiteOr(event.tangentSpeed, 0));
  const rollSpeed = Math.max(0, finiteOr(event.rollSpeedMps, tangentSpeed * clamp(finiteOr(event.rollingRatio, 0), 0, 1)));
  const normalForce = Math.max(0, finiteOr(event.normalForce, 0));
  const mu = clamp(finiteOr(event.muFriction, 0.4), 0.01, 2.5);
  const rollingRatio = clamp(finiteOr(event.rollingRatio, 0), 0, 1);
  const durSec = Math.max(0, finiteOr(event.contactDurationSec, 0.05));

  const patchSpeed = Math.max(tangentSpeed, rollSpeed);
  if (normalForce < 0.012 || patchSpeed < 0.010) {
    return makeSilentPayload(id);
  }

  const slipSpeed = Math.max(0, tangentSpeed * (1 - 0.85 * rollingRatio));

  const profA = opts.primaryProfile ?? null;
  const profB = opts.partnerProfile ?? null;
  // Choose primary structural resonator (prefer body with audible modes & bodyIr or stronger radiation)
  const scoreProfile = (p: BodyModalProfile | null): number => {
    if (!p) return 0;
    const hasModes = p.modes.length > 0 ? 1.0 : 0.25;
    const widthBoost = clamp((p.radiatingWidthM ?? 0.03) / 0.03, 0.3, 2.5);
    const qBoost = clamp(Math.log10(10 + p.material.qualityQ) / 2.5, 0.4, 1.5);
    return hasModes * widthBoost * qBoost;
  };
  const usePartner = scoreProfile(profB) > scoreProfile(profA) * 1.25;
  const activeProf = usePartner ? profB : profA;

  const propsA = inferColliderContactProps(opts.primaryNode ?? null, event.selfGeomName);
  const propsB = inferColliderContactProps(opts.partnerNode ?? null, event.otherGeomName);
  const invEStar =
    (1 - propsA.poisson * propsA.poisson) / Math.max(1e6, propsA.modulusPa) +
    (1 - propsB.poisson * propsB.poisson) / Math.max(1e6, propsB.modulusPa);
  const eStar = 1 / Math.max(1e-14, invEStar);
  const rStar = clamp(
    finiteOr(
      event.contactRadiusM,
      1 / (1 / Math.max(0.001, propsA.radiusM) + 1 / Math.max(0.001, propsB.radiusM)),
    ),
    0.001,
    2.0,
  );

  // Hertzian circular contact-patch radius a_H = (3 F_n R* / (4 E*))^(1/3)
  const aHertz = clamp(Math.cbrt((3 * normalForce * rStar) / Math.max(1e5, 4 * eStar)), 6e-5, 0.025);

  const roughness = clamp(
    finiteOr(
      event.roughness,
      0.5 * (
        inferSurfaceRoughness(opts.primaryNode, event.selfGeomName) +
        inferSurfaceRoughness(opts.partnerNode, event.otherGeomName)
      ),
    ),
    0.04,
    0.95,
  );

  // Extract top 2 audible body modal resonances
  const rawModes = activeProf?.modes ?? [];
  const baseF1 = clamp(rawModes[0]?.freqHz ?? activeProf?.fundamentalHz ?? 420, 65, 6500);
  const baseF2 = clamp(rawModes[1]?.freqHz ?? baseF1 * (activeProf?.overtoneRatio ?? 2.32), 110, 9200);
  const matQ = clamp(activeProf?.material.qualityQ ?? Math.max(propsA.qualityQ, propsB.qualityQ), 25, 1800);

  // Coupled contact-damped modal Q for resonator filter peaks (bounded for Biquad stability)
  const mode1Q = +clamp(2.2 + Math.sqrt(matQ) * 0.42, 2.0, 22.0).toFixed(2);
  const mode2Q = +clamp(mode1Q * 0.82, 1.8, 18.0).toFixed(2);

  const rubAlign = typeof event.circumferentialRub === 'number'
    ? clamp(event.circumferentialRub, 0, 1)
    : event.circumferentialRub
      ? 0.85
      : 0;

  let regime: ContactFrictionRegime;
  let noiseCenterHz: number;
  let noiseQ: number;
  let patchLowpassHz: number;
  let noiseGain: number;
  let grainRateHz = 0;
  let grainDepth = 0;
  let tonalActive = false;
  let tonalFreqHz = baseF1;
  let tonalBeatFreqHz = baseF1 * 1.005;
  let tonalGain = 0;
  let tonalDrive = 0.5;
  let attackTauSec: number;
  let mode1GainDb: number;
  let mode2GainDb: number;

  // -------------------------------------------------------------------------
  // Check Regime 4: Rubbed Wineglass / Singing-Bowl Rim Modal Lock-In
  // -------------------------------------------------------------------------
  const canRimSing =
    rubAlign >= 0.45 &&
    rollingRatio < 0.55 &&
    matQ >= 280 &&
    slipSpeed >= 0.015 &&
    slipSpeed <= 0.80 &&
    normalForce >= 0.05 &&
    normalForce <= 20.0 &&
    mu >= 0.14 &&
    durSec >= 0.05;

  // -------------------------------------------------------------------------
  // Check Regime 3: Stribeck Negative-Slope Stick-Slip Squeal (Brake / Metal)
  // -------------------------------------------------------------------------
  const vStribeck = 0.18;
  const deltaMu = 0.28 * mu;
  const stribeckSlope = (deltaMu * (slipSpeed / (vStribeck * vStribeck))) * Math.exp(-slipSpeed / vStribeck);
  const squealInstability = normalForce * stribeckSlope * (eStar >= 15e9 ? 1.0 : 0.25) * (matQ / 220);
  const canSqueal =
    !canRimSing &&
    rollingRatio < 0.45 &&
    mu >= 0.34 &&
    eStar >= 15e9 &&
    matQ >= 160 &&
    normalForce >= 1.2 &&
    slipSpeed >= 0.010 &&
    slipSpeed <= 0.90 &&
    squealInstability >= 0.95;

  if (rollingRatio >= 0.65 && patchSpeed >= 0.015) {
    // -----------------------------------------------------------------------
    // Regime 1: Continuous Rolling Marble / Wheel / Bearing
    // -----------------------------------------------------------------------
    regime = 'rolling';
    const effRollV = Math.max(rollSpeed, patchSpeed * 0.85);
    const spatialCutoff = effRollV / (Math.PI * aHertz + 0.00038 + 0.0012 * roughness);
    patchLowpassHz = +clamp(spatialCutoff, 110, 4600).toFixed(1);
    noiseCenterHz = +clamp(0.56 * patchLowpassHz, 70, 2500).toFixed(1);
    noiseQ = +(1.15 + 0.95 * (1 - roughness)).toFixed(2);

    const speedRamp = smoothstep(0.015, 0.12, effRollV);
    const powerArg = 24 * Math.pow(normalForce, 0.65) * Math.pow(effRollV, 1.35) * (0.22 + roughness);
    noiseGain = +clamp(0.15 * Math.log10(1 + powerArg) * speedRamp, 0, 0.28).toFixed(4);

    // Subtle wheel/sphere rotation eccentricity & surface-wave modulation
    grainRateHz = +clamp(effRollV / Math.max(0.015, 2 * Math.PI * rStar), 3.0, 32.0).toFixed(2);
    grainDepth = +clamp(0.18 + 0.32 * roughness, 0.12, 0.52).toFixed(3);
    mode1GainDb = 7.5;
    mode2GainDb = 5.0;
    attackTauSec = 0.022;
  } else if (canRimSing) {
    // -----------------------------------------------------------------------
    // Regime 4: Singing Bowl / Rubbed Wineglass Rim Quadrupole Lock-In
    // -----------------------------------------------------------------------
    regime = 'rim_singing';
    tonalActive = true;
    tonalFreqHz = +clamp(baseF1, 80, 4200).toFixed(2);

    // Revolving quadrupole nodal-line beat frequency: df_orbit = v_slip / (pi * R_rim)
    const lp = event.localPoint;
    const localRimR = lp ? Math.hypot(lp[0] || 0, lp[1] || 0) : 0;
    const rRim = clamp(localRimR > 0.012 ? localRimR : (activeProf?.radiatingWidthM ?? 0.06) * 0.5, 0.02, 0.35);
    const orbitBeatHz = clamp(slipSpeed / (Math.PI * rRim), 0.35, 14.0);
    tonalBeatFreqHz = +(tonalFreqHz + orbitBeatHz).toFixed(3);

    // Sweet-spot bowing/rubbing window across speed & normal pressure
    const speedWindow = smoothstep(0.015, 0.06, slipSpeed) * (1 - 0.55 * smoothstep(0.45, 0.85, slipSpeed));
    const forceWindow = smoothstep(0.05, 0.35, normalForce) * (1 - 0.45 * smoothstep(8.0, 20.0, normalForce));
    const durBloom = smoothstep(0.05, 0.32, durSec);
    tonalGain = +clamp(0.32 * speedWindow * forceWindow * durBloom * rubAlign, 0.015, 0.38).toFixed(4);
    tonalDrive = 0.38; // warm, pure sinusoidal quadrupole bloom
    attackTauSec = 0.18;

    // Silky subtle finger/mallet rim friction whisper
    noiseCenterHz = +clamp(tonalFreqHz * 1.5, 220, 3800).toFixed(1);
    patchLowpassHz = +clamp(tonalFreqHz * 3.0, 600, 5200).toFixed(1);
    noiseQ = 2.0;
    noiseGain = +clamp(0.022 * speedWindow * (0.2 + roughness), 0.002, 0.032).toFixed(4);
    mode1GainDb = 8.5;
    mode2GainDb = 6.0;
  } else if (canSqueal) {
    // -----------------------------------------------------------------------
    // Regime 3: Stribeck Stick-Slip Brake / Metal-on-Metal Squeal
    // -----------------------------------------------------------------------
    regime = 'stick_slip_squeal';
    tonalActive = true;
    const squealMode = rawModes.find((m) => m.freqHz >= 650 && m.freqHz <= 5200)?.freqHz
      ?? clamp(baseF1 >= 650 ? baseF1 : baseF2 >= 650 ? baseF2 : baseF1 * 2.756, 720, 4800);
    tonalFreqHz = +squealMode.toFixed(2);
    tonalBeatFreqHz = +(squealMode * 1.0035).toFixed(2);

    const squealStrength = smoothstep(0.95, 3.2, squealInstability);
    tonalGain = +clamp(0.24 * squealStrength * smoothstep(0.01, 0.05, slipSpeed), 0.01, 0.30).toFixed(4);
    tonalDrive = +clamp(1.15 + 0.55 * squealStrength, 1.0, 1.85).toFixed(2);
    attackTauSec = 0.016;

    // Companion metallic scrape
    const corrLen = 0.00018 + 0.0020 * Math.pow(roughness, 1.3);
    noiseCenterHz = +clamp(slipSpeed / corrLen, 350, 6200).toFixed(1);
    patchLowpassHz = +clamp(noiseCenterHz * 1.9, 900, 9500).toFixed(1);
    noiseQ = 1.65;
    const powerArg = 14 * mu * normalForce * slipSpeed * (0.2 + roughness);
    noiseGain = +clamp(0.11 * Math.log10(1 + powerArg), 0.005, 0.22).toFixed(4);
    grainRateHz = +clamp(18 + 22 * slipSpeed, 14, 42).toFixed(1);
    grainDepth = 0.28;
    mode1GainDb = 7.0;
    mode2GainDb = 5.5;
  } else {
    // -----------------------------------------------------------------------
    // Regime 2: Broadband Rough Sliding / Stone Drag / Wood Scrape
    // -----------------------------------------------------------------------
    regime = 'scraping';
    const effSlip = Math.max(0.010, slipSpeed);
    const corrLen = 0.00018 + 0.0020 * Math.pow(roughness, 1.3);
    noiseCenterHz = +clamp(effSlip / corrLen, 130, 6200).toFixed(1);
    patchLowpassHz = +clamp(Math.max(noiseCenterHz * 1.85, effSlip / (Math.PI * aHertz + 0.00025)), 320, 9500).toFixed(1);
    noiseQ = +(0.75 + 1.35 * (1 - roughness)).toFixed(2);

    const speedRamp = smoothstep(0.010, 0.065, effSlip);
    const powerArg = 18 * mu * normalForce * effSlip * (0.20 + roughness);
    noiseGain = +clamp(0.165 * Math.log10(1 + powerArg) * speedRamp, 0, 0.34).toFixed(4);

    // Stick-slip asperity chatter modulation
    grainRateHz = +clamp(12 + 28 * Math.min(1.2, effSlip) * (0.4 + 0.6 * roughness), 10, 46).toFixed(1);
    grainDepth = +clamp(0.16 + 0.38 * mu * roughness, 0.10, 0.62).toFixed(3);
    mode1GainDb = 6.5;
    mode2GainDb = 4.5;
    attackTauSec = 0.018;
  }

  const active = noiseGain >= 0.002 || (tonalActive && tonalGain >= 0.002);
  if (!active) return makeSilentPayload(id);

  return {
    id,
    active: true,
    regime,
    noiseCenterHz,
    noiseQ,
    patchLowpassHz,
    noiseGain,
    grainRateHz,
    grainDepth,
    tonalActive,
    tonalFreqHz,
    tonalBeatFreqHz,
    tonalGain,
    tonalDrive,
    attackTauSec,
    mode1Hz: +clamp(baseF1, 65, 7500).toFixed(1),
    mode1Q,
    mode1GainDb,
    mode2Hz: +clamp(baseF2, 110, 9500).toFixed(1),
    mode2Q,
    mode2GainDb,
    bodyIr: activeProf?.bodyIr ?? null,
    bodyIrSig: activeProf?.bodyIrSig ?? '',
    ...(opts.spatial?.pan !== undefined ? { pan: opts.spatial.pan } : {}),
    ...(opts.spatial?.distanceGain !== undefined ? { distanceGain: opts.spatial.distanceGain } : {}),
  };
}

// ---------------------------------------------------------------------------
// Pure Worker Contact & Impact Helpers (Shared with `physicsWorker.ts`)
// ---------------------------------------------------------------------------

function rotateVecByGeomPose(
  v: [number, number, number],
  quat?: readonly number[],
  eulerDeg?: readonly number[],
): [number, number, number] {
  if (quat && quat.length >= 4) {
    const qw = finiteOr(quat[0], 1);
    const qx = finiteOr(quat[1], 0);
    const qy = finiteOr(quat[2], 0);
    const qz = finiteOr(quat[3], 0);
    const norm = Math.hypot(qw, qx, qy, qz);
    if (norm > 1e-8) {
      const w = qw / norm;
      const x = qx / norm;
      const y = qy / norm;
      const z = qz / norm;
      // v' = v + 2 * q_xyz x (q_xyz x v + w * v)
      const tx = 2 * (y * v[2] - z * v[1]);
      const ty = 2 * (z * v[0] - x * v[2]);
      const tz = 2 * (x * v[1] - y * v[0]);
      return [
        v[0] + w * tx + (y * tz - z * ty),
        v[1] + w * ty + (z * tx - x * tz),
        v[2] + w * tz + (x * ty - y * tx),
      ];
    }
  }
  if (eulerDeg && eulerDeg.length >= 3) {
    // MuJoCo default intrinsic XYZ Euler sequence: R = Rx(ex) * Ry(ey) * Rz(ez)
    const rx = (finiteOr(eulerDeg[0], 0) * Math.PI) / 180;
    const ry = (finiteOr(eulerDeg[1], 0) * Math.PI) / 180;
    const rz = (finiteOr(eulerDeg[2], 0) * Math.PI) / 180;
    const cx = Math.cos(rx), sx = Math.sin(rx);
    const cy = Math.cos(ry), sy = Math.sin(ry);
    const cz = Math.cos(rz), sz = Math.sin(rz);
    // First Rz(ez)
    const x1 = cz * v[0] - sz * v[1];
    const y1 = sz * v[0] + cz * v[1];
    const z1 = v[2];
    // Then Ry(ey)
    const x2 = cy * x1 + sy * z1;
    const y2 = y1;
    const z2 = -sy * x1 + cy * z1;
    // Then Rx(ex)
    return [
      x2,
      cx * y2 - sx * z2,
      sx * y2 + cx * z2,
    ];
  }
  return v;
}

/**
 * Infers a string node's body-local endpoint `p0`, unit axis `ax`, and vibrating
 * span `len` in MuJoCo Z-up coordinates, honoring `fromto`, MuJoCo `+Z` local
 * cylinder/capsule convention, longest box axis, `g.pos`, `g.quat`, and `g.euler`.
 */
export function inferStringLocalSpan(
  node: SceneNode,
): { p0: [number, number, number]; ax: [number, number, number]; len: number } {
  const g =
    (node.geoms ?? []).find((x) => !x.csgDerived && x.csg !== 'difference' && x.role !== 'visual') ??
    node.geoms?.[0];
  if (g?.fromto && g.fromto.length >= 6) {
    const dx = g.fromto[3] - g.fromto[0];
    const dy = g.fromto[4] - g.fromto[1];
    const dz = g.fromto[5] - g.fromto[2];
    const len = Math.hypot(dx, dy, dz);
    if (len > 1e-6) {
      return {
        p0: [g.fromto[0], g.fromto[1], g.fromto[2]],
        ax: [dx / len, dy / len, dz / len],
        len,
      };
    }
  }

  const gx = finiteOr(g?.pos?.[0], 0);
  const gy = finiteOr(g?.pos?.[1], 0);
  const gz = finiteOr(g?.pos?.[2], 0);

  let localAx: [number, number, number] = [0, 0, 1]; // MuJoCo cylinder/capsule default is +Z!
  let halfL = Math.max(0.005, finiteOr(g?.size?.[1], 0.15));

  if (g?.type === 'box' && g.size.length >= 3) {
    const sx = Math.abs(finiteOr(g.size[0], 0.01));
    const sy = Math.abs(finiteOr(g.size[1], 0.01));
    const sz = Math.abs(finiteOr(g.size[2], 0.01));
    if (sx >= sy && sx >= sz) {
      localAx = [1, 0, 0];
      halfL = Math.max(5e-5, sx);
    } else if (sy >= sx && sy >= sz) {
      localAx = [0, 1, 0];
      halfL = Math.max(5e-5, sy);
    } else {
      localAx = [0, 0, 1];
      halfL = Math.max(5e-5, sz);
    }
  } else if (g?.type === 'ellipsoid' && g.size.length >= 3) {
    const sx = Math.abs(finiteOr(g.size[0], 0.01));
    const sy = Math.abs(finiteOr(g.size[1], 0.01));
    const sz = Math.abs(finiteOr(g.size[2], 0.01));
    if (sx >= sy && sx >= sz) {
      localAx = [1, 0, 0];
      halfL = Math.max(5e-5, sx);
    } else if (sy >= sx && sy >= sz) {
      localAx = [0, 1, 0];
      halfL = Math.max(5e-5, sy);
    } else {
      localAx = [0, 0, 1];
      halfL = Math.max(5e-5, sz);
    }
  }

  const rotAx = rotateVecByGeomPose(localAx, g?.quat, g?.euler);
  const axLen = Math.hypot(rotAx[0], rotAx[1], rotAx[2]) || 1;
  const ax: [number, number, number] = [rotAx[0] / axLen, rotAx[1] / axLen, rotAx[2] / axLen];
  return {
    p0: [gx - halfL * ax[0], gy - halfL * ax[1], gz - halfL * ax[2]],
    ax,
    len: Math.max(1e-4, 2 * halfL),
  };
}

/**
 * Computes solver-softness impulse compensation `solSoftScale` while distinguishing:
 *   - Underdamped elastic softened contacts (`solref: [0.012, 0.12]` on Newton's Cradle) -> >1 compensation
 *   - Critically damped pneumatic bladders/cushions (`solref: [0.075, 1.0]` on Whoopee Cushion) -> suppressed (~0.04x)
 */
export function computeImpactSolSoftScale(
  solTime: number,
  solDamp: number,
  stepSize: number,
  isString: boolean,
): number {
  if (isString) return 1.0;
  const st = finiteOr(solTime, 0.004);
  const sd = finiteOr(solDamp, 1.0);
  const dt = Math.max(1e-5, finiteOr(stepSize, 0.002));
  if (st >= 0.040 && sd >= 0.85) {
    // Critically damped slow pneumatic bladder / elastomer squeeze -> suppress rigid gunshot bang!
    return 0.04;
  }
  if (st > 2.5 * dt && st <= 0.030 && sd < 0.65) {
    // Artificially softened elastic collision (e.g. Newton's Cradle [0.012, 0.12])
    return Math.min(16, Math.pow(st / (2 * dt), 1.5));
  }
  return 1.0;
}

/**
 * Simulation-time pair-keyed impact debounce (`${nodeId}:${otherNodeId}`).
 * Prevents multi-substep solver bounce double-triggers (~22-35 ms on the SAME pair)
 * while allowing 0 ms cross-mallet flams/rolls and strong crescendo re-strikes!
 */
export function shouldEmitPairImpact(
  prev: { atSimTime: number; impulseNs: number } | undefined,
  simTime: number,
  impulseNs: number,
  solTime = 0.004,
): boolean {
  if (!prev || simTime < prev.atSimTime) return true;
  const dt = simTime - prev.atSimTime;
  const minCooldown = Math.max(0.022, Math.min(0.060, 2.2 * Math.max(0.004, finiteOr(solTime, 0.004))));
  if (dt >= minCooldown) return true;
  if (dt >= 0.012 && impulseNs > prev.impulseNs * 2.2) return true;
  return false;
}

/**
 * Evaluates all active smooth stopping contacts `sStops` along a string in `[0, 1]`
 * relative to normalized bow position `sBow`, choosing the stop closest to the bow
 * (shortest active vibrating length, supporting multi-finger chords & high positions down to 0.12*L).
 */
export function selectMultiFingerStopFraction(
  sBow: number,
  sStops: readonly number[],
): number | undefined {
  let bestFrac: number | undefined;
  for (const sStop of sStops) {
    if (!Number.isFinite(sStop)) continue;
    let cand: number | undefined;
    if (sBow < 0.5 && sStop > sBow + 0.06 && sStop < 0.985) {
      cand = clamp(sStop, 0.12, 1.0);
    } else if (sBow >= 0.5 && sStop < sBow - 0.06 && sStop > 0.015) {
      cand = clamp(1 - sStop, 0.12, 1.0);
    }
    if (cand !== undefined && (bestFrac === undefined || cand < bestFrac)) {
      bestFrac = cand;
    }
  }
  return bestFrac;
}

/**
 * Guarded 32 ms anti-micro-bounce bow hold (Verifier #13 Section 2 Item 4):
 * - Keys held contacts by `${bowNodeId}:${stringNodeId}` so double-stops hold both strings.
 * - Immediately drops held strings on `bowNodeId` in 0 ms whenever `bowNodeId` lands on a
 *   newly-contacted string (`crossedToNewString`), keeping fast Bach 16th-note crossings crisp!
 */
export function resolveGuardedBowHold(
  currentEvents: BowedStringContactEvent[],
  recentEvents: Map<string, { event: BowedStringContactEvent; atSimTime: number }>,
  prevActiveByBow: Map<string, Set<string>>,
  simTime: number,
): BowedStringContactEvent[] {
  const curByBow = new Map<string, Set<string>>();
  for (const ev of currentEvents) {
    let set = curByBow.get(ev.bowNodeId);
    if (!set) {
      set = new Set();
      curByBow.set(ev.bowNodeId, set);
    }
    set.add(ev.stringNodeId);
    recentEvents.set(`${ev.bowNodeId}:${ev.stringNodeId}`, { event: ev, atSimTime: simTime });
  }

  const out = [...currentEvents];
  const crossedBows = new Set<string>();
  for (const [bowId, curSet] of curByBow) {
    const prevSet = prevActiveByBow.get(bowId);
    for (const sId of curSet) {
      if (!prevSet || !prevSet.has(sId)) {
        crossedBows.add(bowId);
        break;
      }
    }
  }

  for (const [key, held] of Array.from(recentEvents.entries())) {
    const bowId = held.event.bowNodeId;
    const strId = held.event.stringNodeId;
    const curSet = curByBow.get(bowId);
    if (curSet?.has(strId)) continue;

    if (crossedBows.has(bowId)) {
      // Bow crossed onto a new string -> 0 ms release of old string!
      recentEvents.delete(key);
      continue;
    }

    if (simTime >= held.atSimTime && simTime - held.atSimTime <= 0.032 && held.event.bowVelocityMps >= 0.035) {
      out.push(held.event);
      let nextSet = curByBow.get(bowId);
      if (!nextSet) {
        nextSet = new Set();
        curByBow.set(bowId, nextSet);
      }
      nextSet.add(strId);
    } else {
      recentEvents.delete(key);
    }
  }

  prevActiveByBow.clear();
  for (const [bowId, set] of curByBow) {
    prevActiveByBow.set(bowId, set);
  }
  return out;
}

/**
 * Computes viscoelastic contact modal decay rate `delta_alpha` (1/s) induced on a
 * ringing body of mass `targetMassKg` by sustained normal force `normalForceN`
 * against a surface of viscoelastic `softness` in `[0, 1]`.
 */
export function computeContactDampingRate(
  normalForceN: number,
  softness: number,
  targetMassKg: number,
): number {
  const fn = Math.max(0, finiteOr(normalForceN, 0));
  const soft = clamp(finiteOr(softness, 0.25), 0.02, 1.0);
  const mKg = Math.max(0.015, finiteOr(targetMassKg, 0.25));
  if (fn < 0.03) return 0;
  return +clamp((2.8 * soft * Math.pow(fn, 0.65)) / mKg, 0.4, 85.0).toFixed(3);
}
