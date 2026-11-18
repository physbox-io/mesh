// ---------------------------------------------------------------------------
// Taut Musical Strings & Coupled 3D Soundbox (Multi-Port Helmholtz + Kirchhoff Plate)
// ---------------------------------------------------------------------------
//
// Physics implemented:
// 1. Mersenne's Law for stretched strings:
//      f0 = (1 / (2 * L)) * sqrt(T / mu),   mu = rho * pi * r^2
// 2. Fletcher's stiff-string dispersion (inharmonicity):
//      f_n = n * f0 * sqrt(1 + B * n^2),    B = (pi^3 * E * r^4) / (8 * T * L^2)
// 3. Tensile breaking-stress check:
//      sigma = T / (pi * r^2) vs ultimate strength sigma_ult (MPa)
// 4. 3D Soundbox Multi-Port Cavity & Kirchhoff Soundboard Coupling:
//    - Measures internal air cavity V, top soundboard thickness h_top, and ALL
//      open holes/ports (CSG booleans, multi-plank gaps, OR freehand Sculpt cuts!)
//      via `analyze3DCavityAndPorts`.
//    - Multi-port Rayleigh Helmholtz air-cavity frequency:
//        f_H = (c_air / (2 * pi)) * sqrt(G_total / V),
//        G_total = Σ A_p / (L_p + 1.7 * r_p)
//    - Kirchhoff soundboard flexural plate mode f_top from measured 3D h_top,
//      lateral spans (a, b), and wood (E, rho) + Skudrzyk bridge admittance!
// 5. Strike-position & plectrum-material coupling:
//    - Live collision `localPoint` determines actual pluck comb sin(n π x_hit / L),
//      and plectrum tip radius + Young's modulus shape harmonic roll-off!
// ---------------------------------------------------------------------------

import type {
  SceneNode,
  StringMaterialId,
} from '../types/scene';
import { geomHydroTriangles } from './hydrostatics';
import {
  estimateBodyModes,
  inferAcousticMaterial,
  inferColliderContactProps,
  type BodyModalProfile,
  type ModalVoice,
} from './modalAudio';
import { analyze3DCavityAndPorts, analyze3DSolidCrossSections } from './solidAcoustics3D';

const SPEED_OF_SOUND_AIR = 343; // m/s at 20 °C

export interface StringMaterialProps {
  id: StringMaterialId;
  label: string;
  densityKgM3: number;
  modulusGPa: number;
  ultimateStrengthMPa: number;
  intrinsicQ: number;
  brightness: number;
  rgba: [number, number, number, number];
}

export const STRING_MATERIALS: Record<StringMaterialId, StringMaterialProps> = {
  steel: {
    id: 'steel',
    label: 'Music Wire (Steel)',
    densityKgM3: 7850,
    modulusGPa: 200,
    ultimateStrengthMPa: 2200,
    intrinsicQ: 1450,
    brightness: 0.88,
    rgba: [0.84, 0.87, 0.92, 1],
  },
  bronze: {
    id: 'bronze',
    label: '80/20 Acoustic Bronze',
    densityKgM3: 8700,
    modulusGPa: 110,
    ultimateStrengthMPa: 980,
    intrinsicQ: 1150,
    brightness: 0.76,
    rgba: [0.82, 0.58, 0.26, 1],
  },
  nylon: {
    id: 'nylon',
    label: 'Concert Nylon',
    densityKgM3: 1140,
    modulusGPa: 3.2,
    ultimateStrengthMPa: 520,
    intrinsicQ: 580,
    brightness: 0.44,
    rgba: [0.93, 0.94, 0.88, 0.92],
  },
  gut: {
    id: 'gut',
    label: 'Luthier Gut',
    densityKgM3: 1320,
    modulusGPa: 4.5,
    ultimateStrengthMPa: 380,
    intrinsicQ: 490,
    brightness: 0.5,
    rgba: [0.85, 0.74, 0.54, 0.95],
  },
};

export interface SoundboxResonance {
  hostNodeId: string;
  hostName: string;
  hasHollowCavity: boolean;
  cavityVolumeLitres: number;
  portCount: number;
  portRadiusMm: number | null;
  portLengthMm: number | null;
  topPlateThicknessMm: number;
  /** Multi-port Helmholtz air-cavity resonance frequency f_H (Hz), when cavity opens through >= 1 port. */
  helmholtzHz: number | null;
  /** Cavity quality factor Q_H (drops when oversized/multiple holes make the shell leaky). */
  helmholtzQ: number;
  /** Primary Kirchhoff soundboard / top-plate flexural resonance (Hz) from 3D wall thickness & material. */
  topPlateHz: number;
  /** Secondary body / back-plate resonance (Hz). */
  bodyModeHz: number;
  /** Acoustic radiation efficiency multiplier (derived from Skudrzyk plate point-admittance & porting). */
  radiationGain: number;
}

export interface StringPluckImpactContext {
  localPoint?: [number, number, number];
  strikerNode?: SceneNode | null;
  strikerGeomName?: string;
}

export interface StringEvaluation {
  lengthM: number;
  fundamentalHz: number;
  inharmonicityB: number;
  linearDensityKgM: number;
  tensileStressMPa: number;
  stressRatio: number;
  transverseStiffnessNm: number;
  warnings: string[];
  soundbox: SoundboxResonance | null;
  profile: BodyModalProfile;
}

export interface BowedStringContactInput {
  node: SceneNode;
  sceneNodes?: SceneNode[];
  /** Tangential sliding speed of the bow across the string (m/s). */
  bowVelocityMps: number;
  /** Normal contact force pressing the bow onto the string (N). */
  bowForceN: number;
  /** Normalized distance from nearest termination x_bow / L in [0.03, 0.5]. */
  bowBeta: number;
  /** Optional stopped length fraction in (0.25, 1.0] raising f0 = f0_open / stoppedLengthFraction. */
  stoppedLengthFraction?: number;
  /** Optional bow-hair ribbon width along the string axis (m), default 0.009 m. */
  bowRibbonWidthM?: number;
}

export interface BowedStringVoice {
  active: boolean;
  pitchHz: number;
  amplitude: number;
  harmonicWeights: number[];
  bodyFormantHz: number;
  bodyFormantGainDb: number;
  bodyFormantQ: number;
  secondaryFormantHz: number;
  lowpassHz: number;
  rosinNoiseGain: number;
  rosinCenterHz: number;
  /** Schelleng minimum bow force for Helmholtz stick-slip lock (N), scaling with Z0 * |v_bow| / beta^2. */
  fMin: number;
  /** Schelleng maximum bow force before raucous rosin crunch (N), scaling with Z0 * |v_bow| / beta. */
  fMax: number;
  /** Mechanical wave impedance Z0 = sqrt(T * mu) (kg/s). */
  waveImpedanceZ0: number;
  /** Active Schelleng bowing regime. */
  regime: 'silent' | 'flautando' | 'helmholtz' | 'raucous';
}

const soundboxCache = new WeakMap<
  SceneNode,
  { geomsRef: SceneNode['geoms']; sculptVersion: number | undefined; res: SoundboxResonance }
>();

function getCachedSoundboxResonance(host: SceneNode): SoundboxResonance {
  const hit = soundboxCache.get(host);
  if (hit && hit.geomsRef === host.geoms && hit.sculptVersion === host.sculptVersion) {
    return hit.res;
  }
  const res = analyzeSoundboxResonance(host);
  soundboxCache.set(host, { geomsRef: host.geoms, sculptVersion: host.sculptVersion, res });
  return res;
}

/** Measures the vibrating span L (m) of a string node from its post-CSG/Sculpt 3D geometry. */
export function measureStringLengthM(node: SceneNode): number {
  const g = (node.geoms ?? []).find((x) => !x.csgDerived && x.csg !== 'difference');
  if (!g) return 0.32;
  if (g.fromto && g.fromto.length >= 6 && !node.sculptEdited && (node.geoms?.length ?? 0) === 1) {
    const dx = g.fromto[3] - g.fromto[0];
    const dy = g.fromto[4] - g.fromto[1];
    const dz = g.fromto[5] - g.fromto[2];
    const len = Math.hypot(dx, dy, dz);
    if (len > 1e-4) return len;
  }
  const sec = analyze3DSolidCrossSections(node);
  return Math.max(0.02, sec.dimsSortedAsc[2]);
}

function findParentOf(nodes: SceneNode[], childId: string): SceneNode | null {
  for (const n of nodes) {
    if ((n.children ?? []).some((c) => c.id === childId)) return n;
    const sub = findParentOf(n.children ?? [], childId);
    if (sub) return sub;
  }
  return null;
}

function findById(nodes: SceneNode[], id: string): SceneNode | null {
  for (const n of nodes) {
    if (n.id === id || n.name === id) return n;
    const sub = findById(n.children ?? [], id);
    if (sub) return sub;
  }
  return null;
}

/**
 * Analyses ANY 3D body as an acoustic soundbox: measures its internal air volume V,
 * ALL open holes/ports (CSG boolean cuts, panel gaps, OR freehand Sculpt holes!),
 * and top-plate thickness h_top to compute multi-port Helmholtz resonance f_H,
 * Kirchhoff soundboard flexural modes, and Skudrzyk bridge radiation gain.
 */
export function analyzeSoundboxResonance(host: SceneNode): SoundboxResonance {
  const cav = analyze3DCavityAndPorts(host);
  const boxMat = inferAcousticMaterial(host);
  const E = boxMat.modulusGPa * 1e9;
  const rho = Math.max(80, boxMat.density);
  const cLong = Math.sqrt(E / rho);

  const cavityVolumeM3 = cav.cavityVolumeM3;
  const hasHollowCavity = cav.hasHollowCavity;
  const portCount = cav.ports.length;

  // Equivalent combined port radius & weighted neck length for display/diagnostics
  const totalPortArea = cav.ports.reduce((acc, p) => acc + p.areaM2, 0);
  const eqPortRadiusM = portCount > 0 ? Math.sqrt(totalPortArea / Math.PI) : null;
  const avgPortLenM = portCount > 0
    ? cav.ports.reduce((acc, p) => acc + p.neckLengthM * p.areaM2, 0) / Math.max(1e-12, totalPortArea)
    : null;

  // 1. Multi-port Helmholtz air-cavity resonance:
  //      f_H = (c_air / 2π) * sqrt(G_total / V),   G_total = Σ A_p / (L_p + 1.7 r_p)
  let helmholtzHz: number | null = null;
  let helmholtzQ = 11.0;
  if (hasHollowCavity && !cav.isOpenCupOrShell && cav.totalConductanceM > 1e-6 && cavityVolumeM3 > 1e-6) {
    const rawFh = (SPEED_OF_SOUND_AIR / (2 * Math.PI)) * Math.sqrt(cav.totalConductanceM / cavityVolumeM3);
    helmholtzHz = +Math.max(35, Math.min(1800, rawFh)).toFixed(1);
    // Radiation & viscous damping across larger / multiple openings lowers cavity Q naturally
    helmholtzQ = +Math.max(2.6, Math.min(13.0, 11.8 * (1 - 2.6 * cav.openAreaFraction))).toFixed(2);
  }

  // 2. Real Kirchhoff soundboard flexural plate resonance from measured 3D wall thickness & wood (E, rho)!
  let topPlateHz: number;
  let bodyModeHz: number;
  if (hasHollowCavity) {
    const nu = 0.30;
    const hTop = Math.max(0.0012, cav.topPlateThicknessM);
    // Inner free vibrating span of top soundboard (outer span minus two side-rib thicknesses)
    const spanA = Math.max(0.04, cav.plateSpanAM - 2 * cav.meanWallThicknessM);
    const spanB = Math.max(0.04, cav.plateSpanBM - 2 * cav.meanWallThicknessM);
    const plateRigidityFactor = hTop / Math.sqrt(12 * (1 - nu * nu));
    // Soundholes slightly reduce central plate stiffness while shedding mass; open-shell cuts lower edge restraint
    const holeCompliance = Math.max(0.72, 1 - 0.55 * cav.openAreaFraction);
    let rawTopHz = 0.54 * plateRigidityFactor * cLong * (1 / (spanA * spanA) + 1 / (spanB * spanB)) * holeCompliance;

    // Sealed enclosure (0 holes!): trapped internal air spring K_air = ρ_air c² A_plate² / V raises soundboard f_top!
    if (portCount === 0 && !cav.isOpenCupOrShell && cavityVolumeM3 > 1e-6) {
      const rhoAir = 1.204;
      const plateArea = spanA * spanB;
      const plateMass = Math.max(1e-4, rho * hTop * plateArea * 0.45);
      const kAir = (rhoAir * SPEED_OF_SOUND_AIR * SPEED_OF_SOUND_AIR * plateArea * plateArea * 0.25) / cavityVolumeM3;
      const fAirSpringSq = kAir / (4 * Math.PI * Math.PI * plateMass);
      rawTopHz = Math.sqrt(rawTopHz * rawTopHz + fAirSpringSq);
    }

    topPlateHz = +Math.max(75, Math.min(1600, rawTopHz)).toFixed(1);
    bodyModeHz = +(topPlateHz * (1.46 + 0.14 * Math.min(2, spanB / spanA))).toFixed(1);
  } else {
    // Solid plank / unhollowed body: use actual 3D solid modal eigenfrequencies of the host!
    const hostModes = estimateBodyModes(host);
    topPlateHz = +Math.max(90, Math.min(2200, hostModes.fundamentalHz)).toFixed(1);
    bodyModeHz = +(topPlateHz * hostModes.overtoneRatio).toFixed(1);
  }

  // 3. Skudrzyk driving-point bridge admittance Y_bridge = 1 / (8 * sqrt(D * rho * h_top)) ∝ 1 / (rho * c_L * h_top²):
  //    Thin, low-density spruce soundboards move generously under string tension; thick/heavy slabs barely radiate!
  const refImpedance = 450 * 4472 * 0.004 * 0.004; // Reference 4 mm spruce soundboard
  const actualH = hasHollowCavity ? cav.topPlateThicknessM : cav.plateSpanAM * 0.35;
  const actualImpedance = Math.max(refImpedance * 0.18, rho * cLong * actualH * actualH);
  const admittanceScale = Math.max(0.32, Math.min(1.55, Math.pow(refImpedance / actualImpedance, 0.28)));

  const baseEnclosureGain = helmholtzHz !== null
    ? 1.22 // Ported Helmholtz soundbox
    : hasHollowCavity
      ? (cav.isOpenCupOrShell ? 0.94 : 0.78) // Open-back shell vs sealed chamber
      : 0.30; // Solid-body / unmounted frame

  const radiationGain = +(baseEnclosureGain * (hasHollowCavity ? admittanceScale : 1.0)).toFixed(3);

  return {
    hostNodeId: host.id,
    hostName: host.name || host.id,
    hasHollowCavity,
    cavityVolumeLitres: +(cavityVolumeM3 * 1000).toFixed(3),
    portCount,
    portRadiusMm: eqPortRadiusM !== null ? +(eqPortRadiusM * 1000).toFixed(1) : null,
    portLengthMm: avgPortLenM !== null ? +(avgPortLenM * 1000).toFixed(1) : null,
    topPlateThicknessMm: +(cav.topPlateThicknessM * 1000).toFixed(2),
    helmholtzHz,
    helmholtzQ,
    topPlateHz,
    bodyModeHz,
    radiationGain,
  };
}

/** Complex magnitude of a 2nd-order resonant peak around `fRes` with quality `Q` and peak boost `boost`. */
function resonatorTransferGain(freqHz: number, fRes: number, Q: number, boost: number): number {
  const r = freqHz / Math.max(20, fRes);
  const denom = Math.sqrt((1 - r * r) * (1 - r * r) + (r / Q) * (r / Q));
  return 1 + (boost / Math.max(1, Q)) * (1 / Math.max(0.06, denom));
}

function resolvePluckFractionFromPoint(node: SceneNode, localPoint: [number, number, number]): number | null {
  const g = (node.geoms ?? []).find((x) => !x.csgDerived && x.csg !== 'difference');
  if (!g) return null;
  if (g.fromto && g.fromto.length >= 6) {
    const ax = g.fromto[3] - g.fromto[0];
    const ay = g.fromto[4] - g.fromto[1];
    const az = g.fromto[5] - g.fromto[2];
    const lenSq = ax * ax + ay * ay + az * az;
    if (lenSq > 1e-8) {
      const t = ((localPoint[0] - g.fromto[0]) * ax + (localPoint[1] - g.fromto[1]) * ay + (localPoint[2] - g.fromto[2]) * az) / lenSq;
      const clamped = Math.max(0.03, Math.min(0.97, t));
      // Fold symmetric [0..1] into [0..0.5] distance from nearest bridge/nut termination
      return Math.min(clamped, 1 - clamped);
    }
  }
  const sec = analyze3DSolidCrossSections(node);
  const lenAxis = sec.axisOrderAsc[2];
  const [lo, hi] = sec.lenBounds;
  const span = Math.max(1e-4, hi - lo);
  const t = Math.max(0.03, Math.min(0.97, (localPoint[lenAxis] - lo) / span));
  return Math.min(t, 1 - t);
}

/** Maps a body-local contact point on `node` to normalized bow/pluck distance β = x / L in [0.03, 0.5]. */
export function resolveStringBetaFromPoint(node: SceneNode, localPoint?: [number, number, number]): number {
  const frac = localPoint ? resolvePluckFractionFromPoint(node, localPoint) : null;
  return Math.max(0.03, Math.min(0.5, frac ?? node.acousticString?.pluckPos ?? 0.12));
}

function resolveCoupledSoundbox(node: SceneNode, sceneNodes?: SceneNode[]): SoundboxResonance | null {
  const spec = node.acousticString;
  if (!spec || !sceneNodes?.length) return null;
  let resonatorNode: SceneNode | null = null;
  if (spec.resonatorNodeId) {
    resonatorNode = findById(sceneNodes, spec.resonatorNodeId);
  }
  if (!resonatorNode) {
    resonatorNode = findParentOf(sceneNodes, node.id);
  }
  return resonatorNode && !resonatorNode.acousticString
    ? getCachedSoundboxResonance(resonatorNode)
    : null;
}

/**
 * 100% Generic Helmholtz / Schelleng Continuous Bowed-String Solver:
 * - Computes exact Mersenne mechanical wave impedance Z0 = sqrt(T * mu)
 * - Evaluates Schelleng's minimum (∝ Z0 |v_bow| / β²) and maximum (∝ Z0 |v_bow| / β)
 *   bow-force limits for Helmholtz stick-slip lock vs airy flautando vs raucous crunch
 * - Shapes harmonics H_1..H_20 with Cremer corner-rounding, bow-position node comb
 *   (*sul ponticello* vs *sul tasto*), finite horsehair ribbon width, and the exact
 *   3D Soundbox Transfer Function H_box(n * f0) (`analyzeSoundboxResonance`).
 */
export function solveBowedStringVoice(input: BowedStringContactInput): BowedStringVoice {
  const { node, sceneNodes } = input;
  const spec = node.acousticString;
  if (!spec) {
    return {
      active: false,
      pitchHz: 220,
      amplitude: 0,
      harmonicWeights: new Array<number>(20).fill(0),
      bodyFormantHz: 220,
      bodyFormantGainDb: 0,
      bodyFormantQ: 1.4,
      secondaryFormantHz: 480,
      lowpassHz: 1800,
      rosinNoiseGain: 0,
      rosinCenterHz: 1400,
      fMin: 0.02,
      fMax: 1.0,
      waveImpedanceZ0: 0.2,
      regime: 'silent',
    };
  }

  const mat = STRING_MATERIALS[spec.material] ?? STRING_MATERIALS.steel;
  const openLengthM = measureStringLengthM(node);
  const stopFrac =
    input.stoppedLengthFraction !== undefined && Number.isFinite(input.stoppedLengthFraction)
      ? Math.max(0.25, Math.min(1.0, input.stoppedLengthFraction))
      : 1.0;
  const effectiveLengthM = Math.max(0.02, openLengthM * stopFrac);

  const radiusM = Math.max(0.00006, (spec.diameterMm || 0.5) / 2000);
  const areaM2 = Math.PI * radiusM * radiusM;
  const mu = mat.densityKgM3 * areaM2;
  const tensionN = Math.max(0.5, spec.tensionN || 45);

  // Exact mechanical wave impedance Z0 = sqrt(T * mu) and Mersenne fundamental f0
  const waveImpedanceZ0 = Math.sqrt(tensionN * mu);
  const waveSpeed = Math.sqrt(tensionN / mu);
  const f0Open = waveSpeed / (2 * openLengthM);
  const pitchHz = +(f0Open / stopFrac).toFixed(2);

  const vBow = Math.abs(input.bowVelocityMps);
  const forceN = Math.max(0, input.bowForceN);
  const beta = Math.max(0.03, Math.min(0.5, Number.isFinite(input.bowBeta) ? input.bowBeta : 0.12));

  // Schelleng (1973) bow-force wedge limits:
  //   F_min ∝ Z0 * |v_bow| / beta^2   (minimum force to sustain single-slip Helmholtz lock)
  //   F_max ∝ Z0 * |v_bow| / beta     (maximum force before raucous rosin crunch)
  const fMin = +((0.042 * waveImpedanceZ0 * vBow) / (beta * beta)).toFixed(6);
  const fMax = +((4.6 * waveImpedanceZ0 * vBow) / beta).toFixed(6);

  const soundbox = resolveCoupledSoundbox(node, sceneNodes);
  const bodyFormantHz = soundbox
    ? +(soundbox.helmholtzHz ?? soundbox.topPlateHz).toFixed(1)
    : +Math.max(160, pitchHz * 1.75).toFixed(1);
  const bodyFormantGainDb = soundbox
    ? +(soundbox.helmholtzHz !== null ? 6.4 : soundbox.hasHollowCavity ? 4.2 : 2.2).toFixed(2)
    : 2.0;
  const bodyFormantQ = soundbox
    ? +Math.max(1.3, Math.min(5.8, (soundbox.helmholtzHz !== null ? soundbox.helmholtzQ : 6.0) * 0.42)).toFixed(2)
    : 1.5;
  const secondaryFormantHz = soundbox
    ? +(soundbox.helmholtzHz !== null ? soundbox.topPlateHz : soundbox.bodyModeHz).toFixed(1)
    : +Math.max(380, pitchHz * 3.1).toFixed(1);

  if (vBow < 0.008 || forceN < 0.015) {
    return {
      active: false,
      pitchHz,
      amplitude: 0,
      harmonicWeights: new Array<number>(20).fill(0),
      bodyFormantHz,
      bodyFormantGainDb,
      bodyFormantQ,
      secondaryFormantHz,
      lowpassHz: 1500,
      rosinNoiseGain: 0,
      rosinCenterHz: 1400,
      fMin,
      fMax,
      waveImpedanceZ0: +waveImpedanceZ0.toFixed(5),
      regime: 'silent',
    };
  }

  const regime: BowedStringVoice['regime'] =
    forceN < fMin ? 'flautando' : forceN > fMax ? 'raucous' : 'helmholtz';

  const fCenter = Math.max(1e-4, Math.sqrt(Math.max(1e-8, fMin * fMax)));
  const pressureRatio = Math.max(0.06, Math.min(5.5, forceN / fCenter));
  // Cremer physical rosin contact pressure relative to Z0 * |v_bow| (independent of 1/beta^1.5)
  const contactPressure = Math.max(0.06, Math.min(6.0, forceN / Math.max(0.012, 6.5 * waveImpedanceZ0 * vBow)));
  const overPress = forceN > fMax ? Math.min(1.6, (forceN - fMax) / Math.max(0.02, fMax)) : 0;
  const underPress = forceN < fMin ? Math.max(0, Math.min(1, 1 - forceN / Math.max(1e-5, fMin))) : 0;

  // Cremer corner-rounding decay: lighter bow pressure rounds the stick-slip corner (warmer, softer upper partials);
  // firmer bow pressure sharpens the release into a richer, brighter harmonic core.
  const cornerDecay = (0.165 / Math.pow(contactPressure, 0.62)) * (1.18 - 0.30 * mat.brightness);
  const ribbonWidthM = Math.max(0.0015, Math.min(effectiveLengthM * 0.20, input.bowRibbonWidthM ?? 0.009));
  const ponticelloExp = Math.max(-0.46, Math.min(0.42, (0.38 * (0.13 - beta)) / 0.10));

  const nHarmonics = 20;
  const harmonicWeights: number[] = new Array<number>(nHarmonics);
  for (let n = 1; n <= nHarmonics; n++) {
    const fn = n * pitchHz;
    if (fn > 18500) {
      harmonicWeights[n - 1] = 0;
      continue;
    }

    // 1. Ideal Helmholtz sawtooth 1/n * Cremer bow-force corner rounding
    const cornerRoll = Math.exp(-cornerDecay * (n - 1));

    // 2. Bow-position node comb + sul ponticello / sul tasto spectral tilt
    const nodePhase = n * beta - Math.round(n * beta);
    const bowComb = 1 - 0.85 * Math.exp(-Math.pow(nodePhase / 0.08, 2));
    const ponticelloTilt = Math.pow(n, ponticelloExp);

    // 3. Finite horsehair ribbon width sinc roll-off
    const uRibbon = (n * Math.PI * ribbonWidthM) / Math.max(0.025, effectiveLengthM);
    const ribbonSinc = uRibbon < 1e-3 ? 1.0 : Math.max(0.05, Math.abs(Math.sin(uRibbon) / uRibbon));

    // 4. Exact 3D Soundbox Transfer Function H_box(n * f0)
    let boxGain = 0.44;
    if (soundbox) {
      let boxH = resonatorTransferGain(fn, soundbox.topPlateHz, 8.5, 4.6);
      boxH *= resonatorTransferGain(fn, soundbox.bodyModeHz, 10.0, 2.8);
      if (soundbox.helmholtzHz !== null) {
        boxH *= resonatorTransferGain(fn, soundbox.helmholtzHz, soundbox.helmholtzQ, 6.2);
        // Below Helmholtz air resonance f_H, ported soundboxes cancel as an acoustic dipole (~f^2 high-pass)
        if (fn < soundbox.helmholtzHz * 0.82) {
          const ratio = fn / (soundbox.helmholtzHz * 0.82);
          boxH *= 0.24 + 0.76 * ratio * ratio;
        }
      } else if (soundbox.hasHollowCavity && fn < soundbox.topPlateHz * 0.85) {
        const ratio = fn / (soundbox.topPlateHz * 0.85);
        boxH *= 0.42 + 0.58 * ratio * ratio;
      }
      boxGain = Math.min(2.6, boxH * 0.52 * soundbox.radiationGain);
    }

    // Raucous over-pressing adds gritty odd/upper partial crunch
    const raucousBoost = overPress > 0 && n >= 3 ? 1 + 0.35 * overPress * (n % 2 === 1 ? 1.0 : 0.6) : 1.0;
    const rawW = (1 / n) * cornerRoll * bowComb * ponticelloTilt * ribbonSinc * boxGain * raucousBoost;
    harmonicWeights[n - 1] = +Math.min(1.6, rawW).toFixed(4);
  }

  const radGain = soundbox ? soundbox.radiationGain : 0.42;
  // Transverse Helmholtz string velocity scales with v_bow / beta; saturates musically at fortissimo
  const effVelocityDrive = Math.tanh((vBow / Math.max(0.055, Math.sqrt(beta * 0.12))) * 0.95);
  const lockEfficiency =
    regime === 'flautando'
      ? 0.38 + 0.62 * (1 - underPress)
      : regime === 'raucous'
        ? Math.max(0.65, 1.05 - 0.18 * overPress)
        : 0.92 + 0.14 * Math.min(1, Math.log10(1 + pressureRatio));
  const amplitude = +Math.min(0.40, 0.28 * effVelocityDrive * lockEfficiency * Math.min(1.45, radGain)).toFixed(4);

  // Bow-pressure and beta-dependent lowpass cutoff
  const baseCutoff = pitchHz * (4.8 + 4.2 * Math.min(2.2, pressureRatio) + (0.20 - Math.min(0.20, beta)) * 18);
  const lowpassHz = +Math.max(850, Math.min(7200, baseCutoff * (0.72 + 0.36 * mat.brightness))).toFixed(1);

  // Horsehair rosin stick-slip friction noise: silky sheen in Helmholtz lock, airy skate in flautando, gritty crunch in raucous!
  const speedSheen = Math.min(1, vBow / 0.32);
  const rosinRaw =
    0.0045 * speedSheen +
    0.011 * underPress * speedSheen +
    0.048 * overPress * (0.4 + 0.6 * speedSheen);
  const rosinNoiseGain = +Math.min(0.085, rosinRaw).toFixed(4);
  const rosinCenterHz = +Math.max(
    880,
    Math.min(4400, pitchHz * (4.0 + 3.0 * ((0.22 - Math.min(0.22, beta)) / 0.22)) + 450 * overPress),
  ).toFixed(1);

  return {
    active: amplitude >= 0.002,
    pitchHz,
    amplitude,
    harmonicWeights,
    bodyFormantHz,
    bodyFormantGainDb,
    bodyFormantQ,
    secondaryFormantHz,
    lowpassHz,
    rosinNoiseGain,
    rosinCenterHz,
    fMin,
    fMax,
    waveImpedanceZ0: +waveImpedanceZ0.toFixed(5),
    regime,
  };
}

/**
 * Evaluates a taut string's Mersenne fundamental, Fletcher stiff-string harmonics,
 * breaking-stress safety, coupled 3D soundbox resonance, and live plectrum/strike-point shaping!
 */
export function evaluateTautString(
  node: SceneNode,
  sceneNodes?: SceneNode[],
  impactCtx?: StringPluckImpactContext,
): StringEvaluation | null {
  const spec = node.acousticString;
  if (!spec) return null;

  const mat = STRING_MATERIALS[spec.material] ?? STRING_MATERIALS.steel;
  const lengthM = measureStringLengthM(node);
  const radiusM = Math.max(0.00006, (spec.diameterMm || 0.5) / 2000);
  const areaM2 = Math.PI * radiusM * radiusM;
  const linearDensityKgM = mat.densityKgM3 * areaM2;
  const tensionN = Math.max(0.5, spec.tensionN || 45);

  // 1. Mersenne's law: f0 = sqrt(T / mu) / (2 * L)
  const waveSpeed = Math.sqrt(tensionN / linearDensityKgM);
  const fundamentalHz = waveSpeed / (2 * lengthM);

  // 2. Fletcher's stiff-string inharmonicity B = (π³ * E * r⁴) / (8 * T * L²)
  const E = mat.modulusGPa * 1e9;
  const inharmonicityB = (Math.pow(Math.PI, 3) * E * Math.pow(radiusM, 4)) / (8 * tensionN * lengthM * lengthM);

  // 3. Tensile stress & safety factor
  const tensileStressMPa = (tensionN / areaM2) / 1e6;
  const stressRatio = tensileStressMPa / mat.ultimateStrengthMPa;
  const transverseStiffnessNm = (4 * tensionN) / lengthM;

  const warnings: string[] = [];
  if (stressRatio >= 0.95) {
    warnings.push(
      `String tension (${tensileStressMPa.toFixed(0)} MPa) exceeds ${mat.label} breaking strength (${mat.ultimateStrengthMPa} MPa) — use a thinner gauge or shorter scale length!`,
    );
  } else if (stressRatio >= 0.76) {
    warnings.push(
      `High tensile stress (${Math.round(stressRatio * 100)}% of ${mat.label} breaking limit) — near snapping pitch.`,
    );
  }
  if (tensionN < 8) {
    warnings.push('Very low string tension (< 8 N) — string will buzz with weak bridge drive.');
  }

  // 4. Resolve coupled soundbox body (explicit resonatorNodeId, or parent body in scene tree)
  const soundbox = resolveCoupledSoundbox(node, sceneNodes);

  // 5. Determine actual pluck position & plectrum contact width/stiffness!
  const dynamicPluck = impactCtx?.localPoint
    ? resolvePluckFractionFromPoint(node, impactCtx.localPoint)
    : null;
  const pluckPos = Math.max(0.04, Math.min(0.5, dynamicPluck ?? spec.pluckPos ?? 0.18));

  let pickWidthM = 0.004;
  let pickBrightness = mat.brightness;
  let contactTauSec = 0.00072;
  if (impactCtx?.strikerNode) {
    const pickProps = inferColliderContactProps(impactCtx.strikerNode, impactCtx.strikerGeomName);
    pickWidthM = Math.max(0.001, Math.min(lengthM * 0.25, 1.6 * pickProps.radiusM));
    pickBrightness = 0.45 * mat.brightness + 0.55 * pickProps.brightness;
    // Softer / heavier plectrum prolongs string release contact time τ_c
    contactTauSec = Math.max(0.00035, Math.min(0.0028, 0.00095 * Math.pow(3e9 / pickProps.modulusPa, 0.18)));
  }

  const radGain = soundbox ? soundbox.radiationGain : 0.65;
  const modes: ModalVoice[] = [];
  const nPartials = 12;

  for (let n = 1; n <= nPartials; n++) {
    const fn = n * fundamentalHz * Math.sqrt(1 + inharmonicityB * n * n);
    if (fn < 24 || fn > 17500) continue;

    // Pluck triangle-wave Fourier rolloff * spatial pluck comb sin(n * π * x_pluck / L)
    const comb = Math.abs(Math.sin(n * Math.PI * pluckPos));
    if (comb < 0.035) continue;

    // Finite plectrum contact width sinc filter: sin(n π w_pick / L) / (n π w_pick / L)
    const uPick = (n * Math.PI * pickWidthM) / Math.max(0.02, lengthM);
    const pickSinc = uPick < 1e-3 ? 1.0 : Math.abs(Math.sin(uPick) / uPick);

    // Plectrum stiffness spectral tilt (stiff metal pick boosts upper partials vs soft felt/wood)
    const rolloffExp = 1.46 - 0.34 * pickBrightness;
    let gain = (comb / Math.pow(n, rolloffExp)) * pickSinc * radGain;

    // Couple through the 3D soundbox's Helmholtz air cavity + Kirchhoff top/body plate formants!
    if (soundbox) {
      let boxH = resonatorTransferGain(fn, soundbox.topPlateHz, 8.5, 4.2);
      boxH *= resonatorTransferGain(fn, soundbox.bodyModeHz, 10.0, 2.6);
      if (soundbox.helmholtzHz !== null) {
        boxH *= resonatorTransferGain(fn, soundbox.helmholtzHz, soundbox.helmholtzQ, 5.8);
        // Below Helmholtz cutoff, ported soundboxes cancel as an acoustic dipole (~f^2 high-pass)
        if (fn < soundbox.helmholtzHz * 0.75) {
          const ratio = fn / (soundbox.helmholtzHz * 0.75);
          boxH *= 0.30 + 0.70 * ratio * ratio;
        }
      }
      gain *= Math.min(2.4, boxH * 0.60);
    }

    // Energy conservation: stronger bridge/soundbox radiation transfers energy faster!
    const bridgeLoadFactor = soundbox ? Math.max(0.68, 1.0 - 0.18 * soundbox.radiationGain) : 1.0;
    const partialQ = (mat.intrinsicQ * bridgeLoadFactor) / (1 + 0.28 * (n - 1) * (n - 1) * (1 - 0.5 * pickBrightness));
    const decaySec = Math.max(0.04, Math.min(5.5, (partialQ / (Math.PI * fn)) * 2.6));

    modes.push({
      freqHz: +fn.toFixed(2),
      gain: +Math.min(1.25, gain).toFixed(3),
      decaySec: +decaySec.toFixed(4),
    });
  }

  // 6. Sympathetic transient excitation of the soundbox's own Helmholtz air-boom & top-plate knock via the bridge!
  if (soundbox) {
    if (soundbox.helmholtzHz !== null) {
      modes.push({
        freqHz: soundbox.helmholtzHz,
        gain: 0.24,
        decaySec: +Math.max(0.05, (soundbox.helmholtzQ / (Math.PI * soundbox.helmholtzHz)) * 2.2).toFixed(4),
      });
    }
    modes.push({
      freqHz: soundbox.topPlateHz,
      gain: soundbox.hasHollowCavity ? 0.18 : 0.08,
      decaySec: +Math.max(0.04, (14 / (Math.PI * soundbox.topPlateHz)) * 2.0).toFixed(4),
    });
  }

  const f2 = modes[1]?.freqHz ?? fundamentalHz * 2;
  const profile: BodyModalProfile = {
    fundamentalHz: +fundamentalHz.toFixed(2),
    overtoneRatio: +(f2 / Math.max(1e-6, fundamentalHz)).toFixed(3),
    regime: 'tube',
    material: {
      label: mat.label,
      density: mat.densityKgM3,
      modulusGPa: mat.modulusGPa,
      qualityQ: mat.intrinsicQ,
      brightness: pickBrightness,
    },
    contactDurationSec: contactTauSec,
    modes,
    radiatingWidthM: soundbox ? 0.12 : 0.016,
  };

  return {
    lengthM: +lengthM.toFixed(4),
    fundamentalHz: +fundamentalHz.toFixed(2),
    inharmonicityB: +inharmonicityB.toExponential(3),
    linearDensityKgM: +linearDensityKgM.toExponential(4),
    tensileStressMPa: +tensileStressMPa.toFixed(1),
    stressRatio: +stressRatio.toFixed(3),
    transverseStiffnessNm: +transverseStiffnessNm.toFixed(1),
    warnings,
    soundbox,
    profile,
  };
}

/**
 * Tunes a taut string node to `targetHz` via Mersenne's law T = 4 * L^2 * f^2 * mu,
 * automatically adjusting wire diameter if needed to stay safely within [12 N .. 65% breaking stress],
 * and updates its MuJoCo transverse pluck stiffness `4 * T / L`.
 */
export function tuneStringToPitch(node: SceneNode, targetHz: number): SceneNode {
  const cur = node.acousticString ?? { material: 'bronze', diameterMm: 0.65, tensionN: 55 };
  const mat = STRING_MATERIALS[cur.material] ?? STRING_MATERIALS.bronze;
  const lengthM = measureStringLengthM(node);

  let diameterMm = cur.diameterMm || 0.65;
  const computeTension = (dMm: number) => {
    const r = dMm / 2000;
    const mu = mat.densityKgM3 * Math.PI * r * r;
    return 4 * lengthM * lengthM * targetHz * targetHz * mu;
  };

  let tensionN = computeTension(diameterMm);
  const areaOf = (dMm: number) => Math.PI * Math.pow(dMm / 2000, 2);
  const maxSafeStressPa = mat.ultimateStrengthMPa * 1e6 * 0.65;

  if (tensionN / areaOf(diameterMm) > maxSafeStressPa || tensionN < 12 || tensionN > 140) {
    const targetT = Math.min(85, Math.max(18, 48));
    const idealMu = targetT / (4 * lengthM * lengthM * targetHz * targetHz);
    const idealR = Math.sqrt(idealMu / (mat.densityKgM3 * Math.PI));
    diameterMm = +Math.max(0.20, Math.min(1.65, idealR * 2000)).toFixed(2);
    tensionN = computeTension(diameterMm);
  }

  const cleanTension = +Math.max(2, Math.min(280, tensionN)).toFixed(2);
  const kTransverse = +(4 * cleanTension / lengthM).toFixed(1);
  const visRadiusM = +Math.max(0.0009, (diameterMm / 2000) * 1.8).toFixed(5);

  const nextGeoms = (node.geoms ?? []).map((g, idx) =>
    idx === 0 && (g.type === 'capsule' || g.type === 'cylinder')
      ? { ...g, size: [visRadiusM, ...g.size.slice(1)], rgba: [...mat.rgba] }
      : { ...g },
  );

  const nextJoints = (node.joints ?? []).map((j, idx) =>
    idx === 0 && j.type === 'slide'
      ? {
          ...j,
          stiffness: kTransverse,
          damping: +Math.max(0.04, kTransverse * 0.0008).toFixed(4),
          limited: true,
          range: [-0.008, 0.008] as [number, number],
        }
      : { ...j },
  );

  return {
    ...node,
    geoms: nextGeoms,
    joints: nextJoints,
    tunedPitchHz: +targetHz.toFixed(2),
    acousticString: {
      ...cur,
      diameterMm,
      tensionN: cleanTension,
    },
  };
}

/**
 * Creates taut musical strings mounted as children across the top face of `hostNode`.
 */
export function buildMountedStringsForBody(
  hostNode: SceneNode,
  opts: {
    notes?: number[];
    material?: StringMaterialId;
    pluckPos?: number;
  } = {},
): SceneNode[] {
  const tris: number[] = [];
  for (const g of hostNode.geoms ?? []) {
    if (!g.csgDerived && g.csg !== 'difference' && g.role !== 'visual') {
      geomHydroTriangles(g, tris);
    }
  }
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i + 2 < tris.length; i += 3) {
    if (tris[i] < minX) minX = tris[i];
    if (tris[i] > maxX) maxX = tris[i];
    if (tris[i + 1] < minY) minY = tris[i + 1];
    if (tris[i + 1] > maxY) maxY = tris[i + 1];
    if (tris[i + 2] < minZ) minZ = tris[i + 2];
    if (tris[i + 2] > maxZ) maxZ = tris[i + 2];
  }
  const dx = Number.isFinite(minX) ? maxX - minX : 0.14;
  const dy = Number.isFinite(minY) ? maxY - minY : 0.28;
  const topZ = Number.isFinite(maxZ) ? maxZ : 0.03;

  const spanAlongY = dy >= dx;
  const scaleLen = Math.max(0.08, (spanAlongY ? dy : dx) * 0.82);
  const acrossSpan = Math.max(0.03, (spanAlongY ? dx : dy) * 0.56);
  const zHeight = +(topZ + 0.008).toFixed(5);

  const freqs = opts.notes ?? [261.63, 293.66, 329.63, 392.00];
  const material = opts.material ?? 'bronze';
  const mat = STRING_MATERIALS[material];
  const existingCount = (hostNode.children ?? []).filter((c) => !!c.acousticString).length;

  return freqs.map((hz, i) => {
    const frac = freqs.length === 1 ? 0 : (i / (freqs.length - 1)) - 0.5;
    const lateral = +(frac * acrossSpan).toFixed(5);
    const halfL = +(scaleLen * 0.5).toFixed(5);
    const idx = existingCount + i + 1;
    const id = `${hostNode.id}_string_${idx}`;

    const pos: [number, number, number] = spanAlongY
      ? [lateral, 0, zHeight]
      : [0, lateral, zHeight];
    const fromto: number[] = spanAlongY
      ? [0, -halfL, 0, 0, halfL, 0]
      : [-halfL, 0, 0, halfL, 0, 0];
    const slideAxis: [number, number, number] = spanAlongY ? [1, 0, 0] : [0, 1, 0];

    const rawString: SceneNode = {
      id,
      name: `String ${idx}`,
      type: 'body',
      pos,
      joints: [
        {
          name: `${id}_pluck`,
          type: 'slide',
          axis: slideAxis,
          stiffness: 600,
          damping: 0.4,
          limited: true,
          range: [-0.008, 0.008],
        },
      ],
      geoms: [
        {
          name: `${id}_wire`,
          type: 'capsule',
          fromto,
          size: [0.0011],
          density: mat.densityKgM3,
          solref: [0.004, 0.25],
          rgba: [...mat.rgba],
        },
      ],
      acousticString: {
        material,
        diameterMm: 0.65,
        tensionN: 50,
        pluckPos: opts.pluckPos ?? 0.18,
        resonatorNodeId: hostNode.id,
      },
      children: [],
    };
    return tuneStringToPitch(rawString, hz);
  });
}
