// ---------------------------------------------------------------------------
// Taut Musical Strings & Coupled 3D Soundbox (Multi-Port Helmholtz + Kirchhoff Plate)
// ---------------------------------------------------------------------------
//
// Physics implemented:
// 1. Mersenne's Law for stretched strings:
//      f0_Mersenne = (1 / (2 * L)) * sqrt(T / mu),   mu = rho * pi * r^2
// 2. Fletcher's stiff-string dispersion (inharmonicity, Fletcher 1964 Eq. 3):
//      f_n = n * f0_Mersenne * sqrt(1 + B * n^2),    B = (pi^3 * E * r^4) / (4 * T * L^2)
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
// 5. Strike-position, plectrum-material, Kirchhoff-Carrier pitch droop, &
//    Weinreich-Gough bridge-admittance sympathetic string coupling!
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type {
  SceneGeom,
  SceneJoint,
  SceneNode,
  StringMaterialId,
} from '../types/scene';
import { geomMatrixOf } from './csg';
import { geomHydroTriangles } from './hydrostatics';
import {
  estimateBodyModes,
  inferAcousticMaterial,
  inferColliderContactProps,
  type BodyModalProfile,
  type ModalVoice,
} from './modalAudio';
import {
  analyze3DCavityAndPorts,
  analyze3DSolidCrossSections,
  buildBodyRayScene,
  castSceneRay,
  simulate3DVibroAcousticIR,
  type BodyRayScene,
  type VibroAcousticIRResult,
} from './solidAcoustics3D';

const SPEED_OF_SOUND_AIR = 343; // m/s at 20 °C
const LN_10000 = Math.log(10000); // -80 dB modal envelope decay factor (~9.21034)
const SYMP_Q_POW_NEG_045 = Float64Array.from({ length: 13 }, (_, q) => (q > 0 ? Math.pow(q, -0.45) : 1));

function roundN(v: number, scale: number): number {
  return Math.round(v * scale) / scale;
}

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

function resolveStringMaterial(id: unknown): StringMaterialProps {
  if (typeof id === 'string' && Object.prototype.hasOwnProperty.call(STRING_MATERIALS, id)) {
    return STRING_MATERIALS[id as StringMaterialId];
  }
  return STRING_MATERIALS.steel;
}

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
  /** Acoustic baffle/dipole interference frequency c_air / (1.85 * W_bout) from measured 3D bout width (Hz). */
  dipoleCancelHz: number;
  /** Dipole interference valley depth (dB; 0 for solid unhollowed blocks!). */
  dipoleCancelDb: number;
  /** Acoustic radiation efficiency multiplier (derived from Skudrzyk plate point-admittance & porting). */
  radiationGain: number;
}

export interface StringPluckImpactContext {
  localPoint?: [number, number, number];
  strikerNode?: SceneNode | null;
  strikerGeomName?: string;
  /** Optional normalized impact impulse (N·s) for nonlinear Kirchhoff-Carrier tension pitch droop. */
  impulseNs?: number;
  /** Optional active stopped length fraction in (0.25, 1.0]. */
  stoppedLengthFraction?: number;
}

export interface PluckedModalVoice extends ModalVoice {
  /** Initial fractional frequency shift Δf_0 / f_0 >= 0 for nonlinear tension-modulation pitch droop. */
  pitchDroopFrac?: number;
  /** Exponential 1/e relaxation time constant τ_droop (s), decaying at 2x the amplitude decay rate. */
  pitchDroopTauSec?: number;
}

export interface PluckPitchDroopResult {
  /** Initial fractional frequency shift Δf_0 / f_0 >= 0 (scales ∝ (A_0 / L)^2 before geometric saturation). */
  pitchDroopFrac: number;
  /** Initial upward pitch shift in cents: 1200 * log2(1 + pitchDroopFrac). */
  pitchDroopCents: number;
  /** Exponential 1/e relaxation time constant τ_droop (s) = 0.5 * τ_amp. */
  pitchDroopTauSec: number;
  /** Peak transverse pluck deflection A_0 (m). */
  displacementM: number;
  /** Dimensionless Kirchhoff-Carrier tension-modulation stiffness coefficient κ_TM. */
  kappaTM: number;
}

export interface StringEvaluation {
  lengthM: number;
  fundamentalHz: number;
  inharmonicityB: number;
  linearDensityKgM: number;
  tensileStressMPa: number;
  stressRatio: number;
  transverseStiffnessNm: number;
  waveImpedanceZ0: number;
  bridgeCoupling: number;
  speakingSpanBounds: [number, number];
  bridgeDrivePoint: [number, number, number];
  /** Un-colored string partials (without analytical boxH / air-mode injection) for feeding into 3D FIR ConvolverNode! */
  rawStringModes: PluckedModalVoice[];
  pitchDroop: PluckPitchDroopResult;
  warnings: string[];
  soundbox: SoundboxResonance | null;
  profile: BodyModalProfile & { rawStringModes?: PluckedModalVoice[] };
}

export interface SympatheticStringTarget {
  targetNode: SceneNode;
  targetNodeId: string;
  fundamentalHz: number;
  bridgeCoupling: number;
  couplingGain: number;
  modes: PluckedModalVoice[];
  rawStringModes: PluckedModalVoice[];
  bodyIr: Float32Array<ArrayBuffer> | null;
  bodyIrSig: string;
}

export interface BowedStringContactInput {
  node: SceneNode;
  sceneNodes?: SceneNode[];
  /** Tangential sliding speed of the bow across the string (m/s). */
  bowVelocityMps: number;
  /** Normal contact force pressing the bow onto the string (N). */
  bowForceN: number;
  /** Normalized distance from nearest termination x_bow / L in [0, 1] (symmetric around 0.5). */
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
  /** Pure Helmholtz/Cremer stick-slip string harmonics before body convolution! */
  stringHarmonicWeights: number[];
  /** Simulated 48 kHz 3D vibro-acoustic impulse response of the coupled body + cavity + bridge! */
  bodyIr: Float32Array<ArrayBuffer> | null;
  bodyIrSig: string;
  bodyFormantHz: number;
  bodyFormantGainDb: number;
  bodyFormantQ: number;
  secondaryFormantHz: number;
  woodModeHz: number;
  dipoleCancelHz: number;
  dipoleCancelDb: number;
  bridgeHillHz: number;
  bridgeHillGainDb: number;
  lowpassHz: number;
  rosinNoiseGain: number;
  rosinCenterHz: number;
  /** Schelleng minimum bow force for Helmholtz stick-slip lock (N), scaling with Z0 * |v_bow| / beta^2 and Re(Y_bridge). */
  fMin: number;
  /** Schelleng maximum bow force before raucous rosin crunch (N), scaling with Z0 * |v_bow| / beta. */
  fMax: number;
  /** Mechanical wave impedance Z0 = sqrt(T * mu) (kg/s). */
  waveImpedanceZ0: number;
  /** Active Schelleng bowing regime. */
  regime: 'silent' | 'flautando' | 'helmholtz' | 'raucous';
  /** Coupled string-body wolf-note cyclic beat rate (Hz) when pitchHz locks onto a strong high-admittance plate resonance. */
  wolfBeatHz?: number;
  /** Coupled string-body wolf-note amplitude modulation depth in [0, 0.65]. */
  wolfBeatDepth?: number;
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

function nodeLocalMatrix(n: Pick<SceneNode, 'pos' | 'quat' | 'euler'>): THREE.Matrix4 {
  return geomMatrixOf({
    name: '',
    type: 'box',
    size: [1, 1, 1],
    pos: n.pos,
    quat: n.quat,
    euler: n.euler,
  });
}

function resolveWorldMatrixWithOverride(
  target: SceneNode,
  roots: SceneNode[],
  parentMat: THREE.Matrix4 = new THREE.Matrix4(),
): THREE.Matrix4 | null {
  for (const n of roots) {
    const curLocal = n.id === target.id ? nodeLocalMatrix(target) : nodeLocalMatrix(n);
    const curWorld = new THREE.Matrix4().multiplyMatrices(parentMat, curLocal);
    if (n.id === target.id) return curWorld;
    if (n.children?.length) {
      const sub = resolveWorldMatrixWithOverride(target, n.children, curWorld);
      if (sub) return sub;
    }
  }
  return null;
}

interface StringLocalEndpoints {
  p0: [number, number, number];
  p1: [number, number, number];
  wireR: number;
}

function findPrimaryWireGeom(node: SceneNode): SceneGeom | undefined {
  return (node.geoms ?? []).find(
    (x) => !x.csgDerived && x.csg !== 'difference' && x.role !== 'visual' && x.type !== 'plane',
  );
}

/**
 * Resolves exact 3D wire endpoints [p0, p1] in `node`'s local Z-up frame:
 * - Honors `fromto` [x0, y0, z0, x1, y1, z1] directly.
 * - Honors MuJoCo's local +Z axis (`[0, 0, ±halfH]`) and `g.pos`/`g.quat`/`g.euler`
 *   for non-`fromto` cylinder/capsule geoms (fixing the old local-Y assumption).
 * - Falls back to 3D solid principal-axis bounds for arbitrary mesh/sculpted wires.
 */
export function resolveStringLocalEndpoints(node: SceneNode): StringLocalEndpoints | null {
  const solidGeoms = (node.geoms ?? []).filter(
    (x) => !x.csgDerived && x.csg !== 'difference' && x.role !== 'visual' && x.type !== 'plane',
  );
  const g = solidGeoms[0];
  if (!g) return null;

  if (!node.sculptEdited && solidGeoms.length === 1) {
    if (g.fromto && g.fromto.length >= 6) {
      return {
        p0: [g.fromto[0], g.fromto[1], g.fromto[2]],
        p1: [g.fromto[3], g.fromto[4], g.fromto[5]],
        wireR: Math.max(0.0004, g.size?.[0] ?? 0.001),
      };
    }
    if (g.type === 'capsule' || g.type === 'cylinder') {
      const wireR = Math.max(0.0004, g.size?.[0] ?? 0.001);
      const halfL = Math.max(0.005, g.size?.[1] ?? 0.15);
      const gm = geomMatrixOf(g);
      const v0 = new THREE.Vector3(0, 0, -halfL).applyMatrix4(gm);
      const v1 = new THREE.Vector3(0, 0, halfL).applyMatrix4(gm);
      return {
        p0: [v0.x, v0.y, v0.z],
        p1: [v1.x, v1.y, v1.z],
        wireR,
      };
    }
    if (g.type === 'box' && g.size && g.size.length >= 3) {
      const sx = Math.max(1e-5, g.size[0]);
      const sy = Math.max(1e-5, g.size[1]);
      const sz = Math.max(1e-5, g.size[2]);
      let longAxis: 0 | 1 | 2 = 2;
      let halfL = sz;
      if (sx >= sy && sx >= sz) { longAxis = 0; halfL = sx; }
      else if (sy >= sx && sy >= sz) { longAxis = 1; halfL = sy; }
      const wireR = Math.max(0.0004, Math.min(sx, sy, sz));
      const gm = geomMatrixOf(g);
      const a0 = new THREE.Vector3(
        longAxis === 0 ? -halfL : 0,
        longAxis === 1 ? -halfL : 0,
        longAxis === 2 ? -halfL : 0,
      ).applyMatrix4(gm);
      const a1 = new THREE.Vector3(
        longAxis === 0 ? halfL : 0,
        longAxis === 1 ? halfL : 0,
        longAxis === 2 ? halfL : 0,
      ).applyMatrix4(gm);
      return {
        p0: [a0.x, a0.y, a0.z],
        p1: [a1.x, a1.y, a1.z],
        wireR,
      };
    }
  }

  const sec = analyze3DSolidCrossSections(node);
  const lenAxis = sec.axisOrderAsc[2];
  const [lo, hi] = sec.lenBounds;
  const p0: [number, number, number] = [0, 0, 0];
  const p1: [number, number, number] = [0, 0, 0];
  p0[lenAxis] = lo;
  p1[lenAxis] = hi;
  return {
    p0,
    p1,
    wireR: Math.max(0.0004, 0.5 * sec.dimsSortedAsc[0]),
  };
}

/** Measures the vibrating span L (m) of a string node from its post-CSG/Sculpt 3D geometry. */
export function measureStringLengthM(node: SceneNode): number {
  const ep = resolveStringLocalEndpoints(node);
  if (!ep) return 0.32;
  const len = Math.hypot(ep.p1[0] - ep.p0[0], ep.p1[1] - ep.p0[1], ep.p1[2] - ep.p0[2]);
  return Math.max(0.02, len > 1e-4 ? len : 0.32);
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

  // 4. Acoustic baffle/dipole interference across measured 3D bout width W_bout (`cav.plateSpanAM`):
  //    Hollow boxes exhibit front/port/back phase cancellation around c_air / (1.85 * W_bout); solid blocks have 0 dB!
  const boutWidthM = Math.max(0.05, cav.plateSpanAM);
  const dipoleCancelHz = +Math.max(380, Math.min(1800, SPEED_OF_SOUND_AIR / (1.85 * boutWidthM))).toFixed(1);
  const dipoleCancelDb = hasHollowCavity ? (helmholtzHz !== null ? -3.6 : -2.0) : 0;

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
    dipoleCancelHz,
    dipoleCancelDb,
    radiationGain,
  };
}

/** Complex magnitude of a 2nd-order resonant peak around `fRes` with quality `Q` and peak boost `boost`. */
function resonatorTransferGain(freqHz: number, fRes: number, Q: number, boost: number): number {
  const r = freqHz / Math.max(20, fRes);
  const denom = Math.sqrt((1 - r * r) * (1 - r * r) + (r / Q) * (r / Q));
  return 1 + (boost / Math.max(1, Q)) * (1 / Math.max(0.06, denom));
}

function lorentzianResonance(freqHz: number, fRes: number, Q: number): number {
  const bw = Math.max(1.5, fRes / (2 * Math.max(1, Q)));
  const df = freqHz - fRes;
  return (bw * bw) / (df * df + bw * bw);
}

function resolveRawWireFractionFromPoint(
  node: SceneNode,
  localPoint: [number, number, number],
  speakingBounds?: [number, number],
): number | null {
  const ep = resolveStringLocalEndpoints(node);
  if (!ep) return null;
  const ax = ep.p1[0] - ep.p0[0];
  const ay = ep.p1[1] - ep.p0[1];
  const az = ep.p1[2] - ep.p0[2];
  const lenSq = ax * ax + ay * ay + az * az;
  if (lenSq <= 1e-10) return null;
  const rawT =
    ((localPoint[0] - ep.p0[0]) * ax +
      (localPoint[1] - ep.p0[1]) * ay +
      (localPoint[2] - ep.p0[2]) * az) /
    lenSq;
  const [sLo, sHi] = speakingBounds ?? [0, 1];
  const span = Math.max(0.05, sHi - sLo);
  const mappedT = (rawT - sLo) / span;
  return Math.max(0.002, Math.min(0.998, mappedT));
}

/**
 * Maps a body-local contact point on `node` to normalized bow/pluck distance β = x / L_active in [0.005, 0.5],
 * accounting for both interior bridge/nut speaking bounds `[sLo, sHi]` and left-hand `stoppedLengthFraction`!
 */
export function resolveStringBetaFromPoint(
  node: SceneNode,
  localPoint?: [number, number, number],
  stoppedLengthFraction?: number,
  sceneNodes?: SceneNode[],
): number {
  let speakingBounds: [number, number] | undefined;
  if (sceneNodes?.length) {
    const coupled = resolveCoupledSoundboxAndSpan(node, sceneNodes);
    speakingBounds = coupled.speakingSpanBounds;
  }
  const tSpan = localPoint ? resolveRawWireFractionFromPoint(node, localPoint, speakingBounds) : null;
  let beta = tSpan !== null ? Math.min(tSpan, 1 - tSpan) : (node.acousticString?.pluckPos ?? 0.12);
  if (
    stoppedLengthFraction !== undefined &&
    Number.isFinite(stoppedLengthFraction) &&
    stoppedLengthFraction > 0.2 &&
    stoppedLengthFraction < 0.999
  ) {
    const scaled = beta / stoppedLengthFraction;
    const clamped01 = Math.max(0.005, Math.min(0.995, scaled));
    beta = Math.min(clamped01, 1 - clamped01);
  }
  return Math.max(0.005, Math.min(0.5, beta));
}

const hostRaySceneCache = new WeakMap<
  SceneNode,
  { geomsRef: SceneNode['geoms']; childrenRef: SceneNode['children']; sculptVersion: number | undefined; scene: BodyRayScene | null }
>();

function getCachedHostRayScene(host: SceneNode): BodyRayScene | null {
  const hit = hostRaySceneCache.get(host);
  if (
    hit &&
    hit.geomsRef === host.geoms &&
    hit.childrenRef === host.children &&
    hit.sculptVersion === host.sculptVersion
  ) {
    return hit.scene;
  }
  const scene = buildBodyRayScene(host, true);
  hostRaySceneCache.set(host, {
    geomsRef: host.geoms,
    childrenRef: host.children,
    sculptVersion: host.sculptVersion,
    scene,
  });
  return scene;
}

interface PhysicalStringSupport {
  /** Mechanical bridge/nut force-transmission coupling in [0, 1] (0 when floating disconnected in mid-air!). */
  bridgeCoupling: number;
  /** Fraction (0.25..1.0] of the wire length between actual solid bearing points (bridge & nut/fret). */
  vibratingSpanFraction: number;
  /** Normalized speaking span [sLo, sHi] along the string's local endpoints [p0, p1]. */
  speakingSpanBounds: [number, number];
  /** Distinct structural 3D bridge child body bearing under the string, if any. */
  bridgeNode: SceneNode | null;
  /** Exact 3D bearing point [x, y, z] in hostNode-local frame where this string drives the bridge/body! */
  bridgeDrivePoint: [number, number, number];
}

/**
 * Checks whether a welded structural child (e.g. rotated bridge, angled neck, side harp pillar)
 * physically bears on `hostScene` across all 3 orthogonal local ray directions under full 3D `pos`/`quat`/`euler`.
 */
function doesChildBearOnHost(
  child: SceneNode,
  childMat: THREE.Matrix4,
  hostScene: BodyRayScene,
): boolean {
  const childScene = getCachedHostRayScene(child);
  if (!childScene) return false;

  const b = childScene.bounds;
  const hostExtent = Math.max(
    0.1,
    hostScene.bounds[1] - hostScene.bounds[0],
    hostScene.bounds[3] - hostScene.bounds[2],
    hostScene.bounds[5] - hostScene.bounds[4],
  );
  const maxTouchGap = Math.max(0.006, 0.015 * hostExtent);

  const oVec = new THREE.Vector3();
  const e = childMat.elements;
  // Test Z first (fast 1-ray short-circuit on standard top-mounted bridges), then X and Y for vertical/rotated soundboxes
  const axes: (0 | 1 | 2)[] = [2, 0, 1];
  for (const axis of axes) {
    const uAxis = ((axis + 1) % 3) as 0 | 1 | 2;
    const vAxis = ((axis + 2) % 3) as 0 | 1 | 2;
    const u0 = b[2 * uAxis], u1 = b[2 * uAxis + 1];
    const v0 = b[2 * vAxis], v1 = b[2 * vAxis + 1];
    if (!(u1 > u0 && v1 > v0)) continue;

    const dxC = axis === 0 ? 1 : 0;
    const dyC = axis === 1 ? 1 : 0;
    const dzC = axis === 2 ? 1 : 0;
    // Account for rotation & any scale in childMat directly without allocating Matrix4
    const colOff = axis * 4;
    const sx = e[colOff];
    const sy = e[colOff + 1];
    const sz = e[colOff + 2];
    const dirScale = Math.hypot(sx, sy, sz) || 1;
    const dhx = sx / dirScale;
    const dhy = sy / dirScale;
    const dhz = sz / dirScale;

    for (let iu = 0; iu < 5; iu++) {
      const u = u0 + ((u1 - u0) * (iu + 0.5)) / 5;
      for (let iv = 0; iv < 5; iv++) {
        const v = v0 + ((v1 - v0) * (iv + 0.5)) / 5;
        const oc: [number, number, number] = [0, 0, 0];
        oc[uAxis] = u;
        oc[vAxis] = v;
        oc[axis] = 0;
        const cIvs = castSceneRay(childScene, oc[0], oc[1], oc[2], dxC, dyC, dzC);
        if (cIvs.length === 0) continue;

        oVec.set(oc[0], oc[1], oc[2]).applyMatrix4(childMat);
        const hIvs = castSceneRay(hostScene, oVec.x, oVec.y, oVec.z, dhx, dhy, dhz);
        if (hIvs.length === 0) continue;

        for (const [ca, cb] of cIvs) {
          const za = Math.min(ca, cb) * dirScale;
          const zb = Math.max(ca, cb) * dirScale;
          for (const [ha, hb] of hIvs) {
            const gap = zb < ha ? ha - zb : za > hb ? za - hb : 0;
            if (gap <= maxTouchGap) return true;
          }
        }
      }
    }
  }
  return false;
}

/**
 * Verifies 3D mechanical contact between a string's terminations and its host
 * resonator body (`buildBodyRayScene`, ignoring `role: 'visual'` props, plus any
 * welded static bridge/neck subassemblies that themselves physically bear on `hostNode`!):
 * - Full 3D `pos`/`quat`/`euler` support on `hostNode`, `stringNode`, welded bridge/nut children,
 *   and primitive local-Z cylinders/capsules across all 3 orthogonal ray directions.
 * - Symmetric bridge/nut resolution (works identically whether `fromto` is authored bridge->nut or nut->bridge).
 * - Protects open strings with realistic 1.5–3.5 mm fingerboard action from false interior stopping.
 */
function measurePhysicalStringSupport(
  stringNode: SceneNode,
  hostNode: SceneNode,
  sceneNodes?: SceneNode[],
): PhysicalStringSupport {
  const hostScene = getCachedHostRayScene(hostNode);
  if (!hostScene) {
    return {
      bridgeCoupling: 0,
      vibratingSpanFraction: 1.0,
      speakingSpanBounds: [0, 1],
      bridgeNode: null,
      bridgeDrivePoint: [0, 0, 0],
    };
  }

  const ep = resolveStringLocalEndpoints(stringNode);
  if (!ep) {
    return {
      bridgeCoupling: 0,
      vibratingSpanFraction: 1.0,
      speakingSpanBounds: [0, 1],
      bridgeNode: null,
      bridgeDrivePoint: [0, 0, 0],
    };
  }

  // Include welded static structural attachments (e.g. Arched Maple Bridge, Mortised Neck & Nut)
  // ONLY if they physically bear on `hostNode` (lifting a bridge into mid-air breaks coupling!).
  const supportScenes: {
    scene: BodyRayScene;
    invMat: Float64Array;
    detScale: number;
    childNode: SceneNode | null;
  }[] = [
    {
      scene: hostScene,
      invMat: Float64Array.from(new THREE.Matrix4().elements),
      detScale: 1,
      childNode: null,
    },
  ];

  for (const child of hostNode.children ?? []) {
    if (child.id === stringNode.id || child.acousticString) continue;
    if ((child.joints?.length ?? 0) > 0) continue;
    const cScene = getCachedHostRayScene(child);
    if (!cScene) continue;
    const cMat = nodeLocalMatrix(child);
    if (doesChildBearOnHost(child, cMat, hostScene)) {
      const inv = cMat.clone().invert();
      const det = Math.cbrt(Math.abs(cMat.determinant()) || 1);
      supportScenes.push({
        scene: cScene,
        invMat: Float64Array.from(inv.elements),
        detScale: det,
        childNode: child,
      });
    }
  }

  // Resolve exact 4x4 transform from `stringNode` local frame into `hostNode` local frame!
  let strInHostMat: THREE.Matrix4;
  const isDirectChild = (hostNode.children ?? []).some((c) => c.id === stringNode.id);
  if (isDirectChild) {
    strInHostMat = nodeLocalMatrix(stringNode);
  } else if (sceneNodes?.length) {
    const hostWorld = resolveWorldMatrixWithOverride(hostNode, sceneNodes) ?? nodeLocalMatrix(hostNode);
    const strWorld = resolveWorldMatrixWithOverride(stringNode, sceneNodes) ?? nodeLocalMatrix(stringNode);
    strInHostMat = hostWorld.clone().invert().multiply(strWorld);
  } else {
    const hostWorld = nodeLocalMatrix(hostNode);
    const strWorld = nodeLocalMatrix(stringNode);
    strInHostMat = hostWorld.invert().multiply(strWorld);
  }

  const strScale = Math.cbrt(Math.abs(strInHostMat.determinant()) || 1);
  const v0 = new THREE.Vector3(ep.p0[0], ep.p0[1], ep.p0[2]).applyMatrix4(strInHostMat);
  const v1 = new THREE.Vector3(ep.p1[0], ep.p1[1], ep.p1[2]).applyMatrix4(strInHostMat);
  const p0: [number, number, number] = [v0.x, v0.y, v0.z];
  const p1: [number, number, number] = [v1.x, v1.y, v1.z];
  const wireR = Math.max(0.0004, ep.wireR * strScale);

  const spanLen = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
  const nStations = Math.max(48, Math.min(200, Math.ceil(spanLen / 0.004)));
  const gaps = new Float64Array(nStations + 1);
  const hitChildren: (SceneNode | null)[] = new Array(nStations + 1).fill(null);

  for (let k = 0; k <= nStations; k++) {
    const s = k / nStations;
    const x = p0[0] + (p1[0] - p0[0]) * s;
    const y = p0[1] + (p1[1] - p0[1]) * s;
    const z = p0[2] + (p1[2] - p0[2]) * s;

    // Measure orthogonal X, Y, Z ray gaps in each support scene's own rotated local frame
    let minDist = Infinity;
    let hitChild: SceneNode | null = null;
    for (let si = 0; si < supportScenes.length; si++) {
      const { scene, invMat: m, detScale, childNode } = supportScenes[si];
      const lx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const ly = m[1] * x + m[5] * y + m[9] * z + m[13];
      const lz = m[2] * x + m[6] * y + m[10] * z + m[14];

      const zIvs = castSceneRay(scene, lx, ly, 0, 0, 0, 1);
      for (const [za, zb] of zIvs) {
        const d = (lz < za ? za - lz : lz > zb ? lz - zb : 0) * detScale;
        if (d < minDist) {
          minDist = d;
          hitChild = childNode;
        }
      }
      if (minDist > 0.002) {
        const xIvs = castSceneRay(scene, 0, ly, lz, 1, 0, 0);
        for (const [xa, xb] of xIvs) {
          const d = (lx < xa ? xa - lx : lx > xb ? lx - xb : 0) * detScale;
          if (d < minDist) {
            minDist = d;
            hitChild = childNode;
          }
        }
      }
      if (minDist > 0.002) {
        const yIvs = castSceneRay(scene, lx, 0, lz, 0, 1, 0);
        for (const [ya, yb] of yIvs) {
          const d = (ly < ya ? ya - ly : ly > yb ? ly - yb : 0) * detScale;
          if (d < minDist) {
            minDist = d;
            hitChild = childNode;
          }
        }
      }
    }
    gaps[k] = Math.max(0, minDist - wireR);
    hitChildren[k] = hitChild;
  }

  let endGapLo = Infinity;
  let endGapHi = Infinity;
  let maxMidGap = 0;
  for (let k = 0; k <= nStations; k++) {
    const s = k / nStations;
    const gap = gaps[k];
    if (s <= 0.08 && gap < endGapLo) endGapLo = gap;
    if (s >= 0.92 && gap < endGapHi) endGapHi = gap;
    if (s > 0.45 && s < 0.55 && gap > maxMidGap) maxMidGap = gap;
  }

  // Interior saddle/fret touch threshold:
  // If the string already bears tightly at its outer end (`endGap <= 1.8 mm`, e.g. at a nut),
  // require an interior stop to actually touch within `endGap + 1.0 mm` so a parallel fingerboard
  // with 1.5–3.5 mm string action never false-stops the open string! When the end floats free
  // (`endGap > 4 mm`, e.g. sliding bridge or silk afterlength), allow up to 3.8 mm saddle seating.
  const touchCapLo = endGapLo <= 0.0018 ? endGapLo + 0.0010 : 0.0038;
  const touchCapHi = endGapHi <= 0.0018 ? endGapHi + 0.0010 : 0.0038;

  let interiorTouchLo = Infinity;
  let interiorTouchHi = Infinity;
  let sLoTouch = -1;
  let sHiTouch = -1;
  let kBridgeLo = 0;
  let bestGapLo = Infinity;
  let kBridgeHi = nStations;
  let bestGapHi = Infinity;

  for (let k = 0; k <= nStations; k++) {
    const s = k / nStations;
    const gap = gaps[k];
    if (s <= 0.45) {
      if (gap <= bestGapLo + 0.0004 && (gap < bestGapLo || hitChildren[k] !== null)) {
        if (gap < bestGapLo) bestGapLo = gap;
        kBridgeLo = k;
      }
      if (gap <= touchCapLo) {
        sLoTouch = s;
        if (gap < interiorTouchLo) interiorTouchLo = gap;
      }
    } else if (s >= 0.55) {
      if (gap < bestGapHi || (gap <= bestGapHi + 0.0004 && hitChildren[kBridgeHi] === null && hitChildren[k] !== null)) {
        if (gap < bestGapHi) bestGapHi = gap;
        kBridgeHi = k;
      }
      if (gap <= touchCapHi) {
        if (sHiTouch < 0) sHiTouch = s;
        if (gap < interiorTouchHi) interiorTouchHi = gap;
      }
    }
  }

  // Scale-aware end-anchor coupling window so `buildMountedStringsForBody` strings stay 100% coupled
  // when scaled up (e.g. 2x–5x), while unbridged cello strings floating 84 mm above the belly drop to 0!
  const fullAnchorGap = Math.max(0.009, 0.038 * spanLen);
  const zeroAnchorGap = Math.max(0.018, 0.065 * spanLen);
  const denomGap = Math.max(1e-5, zeroAnchorGap - fullAnchorGap);

  const effGapLo = Math.min(endGapLo, interiorTouchLo);
  const effGapHi = Math.min(endGapHi, interiorTouchHi);
  const cLo = Math.max(0, Math.min(1, (zeroAnchorGap - effGapLo) / denomGap));
  const cHi = Math.max(0, Math.min(1, (zeroAnchorGap - effGapHi) / denomGap));
  const bridgeCoupling = +(cLo * cHi).toFixed(3);

  let vibratingSpanFraction = 1.0;
  let speakingSpanBounds: [number, number] = [0, 1];
  if (maxMidGap > 0.0045 && (sLoTouch >= 0 || sHiTouch >= 0)) {
    const effLo = sLoTouch >= 0 ? sLoTouch : 0.0;
    const effHi = sHiTouch >= 0 ? sHiTouch : 1.0;
    if (effHi - effLo >= 0.35 && effHi - effLo < 0.985) {
      vibratingSpanFraction = +(effHi - effLo).toFixed(4);
      speakingSpanBounds = [+effLo.toFixed(4), +effHi.toFixed(4)];
    }
  }

  // Symmetric bridge vs nut selection (works whether `fromto` is authored bridge->nut or nut->bridge):
  // Prefer the bearing termination sitting closer to `hostScene`'s hollow corpus center (or explicitly named bridge).
  const hb = hostScene.bounds;
  const hostCenter: [number, number, number] = [
    0.5 * (hb[0] + hb[1]),
    0.5 * (hb[2] + hb[3]),
    0.5 * (hb[4] + hb[5]),
  ];
  const pointAtK = (k: number): [number, number, number] => {
    const s = k / nStations;
    return [
      p0[0] + (p1[0] - p0[0]) * s,
      p0[1] + (p1[1] - p0[1]) * s,
      p0[2] + (p1[2] - p0[2]) * s,
    ];
  };
  const ptLo = pointAtK(kBridgeLo);
  const ptHi = pointAtK(kBridgeHi);
  const distLo = Math.hypot(ptLo[0] - hostCenter[0], ptLo[1] - hostCenter[1], ptLo[2] - hostCenter[2]);
  const distHi = Math.hypot(ptHi[0] - hostCenter[0], ptHi[1] - hostCenter[1], ptHi[2] - hostCenter[2]);
  const childLo = hitChildren[kBridgeLo];
  const childHi = hitChildren[kBridgeHi];
  const loIsBridgeName = !!childLo && /bridge/i.test(`${childLo.id} ${childLo.name}`);
  const hiIsBridgeName = !!childHi && /bridge/i.test(`${childHi.id} ${childHi.name}`);

  let useHiAsBridge = false;
  if (hiIsBridgeName && !loIsBridgeName && bestGapHi <= 0.006) {
    useHiAsBridge = true;
  } else if (!loIsBridgeName && bestGapHi <= 0.006 && distHi + 0.035 < distLo) {
    useHiAsBridge = true;
  }

  const chosenK = useHiAsBridge ? kBridgeHi : kBridgeLo;
  const chosenGap = useHiAsBridge ? bestGapHi : bestGapLo;
  const bridgeDrivePoint: [number, number, number] =
    chosenGap <= zeroAnchorGap ? pointAtK(chosenK) : [p0[0], p0[1], p0[2]];
  const bridgeNode = chosenGap <= zeroAnchorGap ? hitChildren[chosenK] : null;

  return {
    bridgeCoupling,
    vibratingSpanFraction,
    speakingSpanBounds,
    bridgeNode,
    bridgeDrivePoint,
  };
}

function resolveResonatorHost(node: SceneNode, sceneNodes?: SceneNode[]): SceneNode | null {
  if (!sceneNodes?.length) return null;
  const explicitId = node.acousticString?.resonatorNodeId ?? node.resonatorNodeId;
  let resonatorNode: SceneNode | null = null;
  if (explicitId) {
    resonatorNode = findById(sceneNodes, explicitId);
  }
  if (!resonatorNode) {
    resonatorNode = findParentOf(sceneNodes, node.id);
  }
  if (!resonatorNode || resonatorNode.acousticString) return null;
  return resonatorNode;
}

interface CoupledSoundboxResult {
  cacheKey: string;
  resonatorNode: SceneNode | null;
  soundbox: SoundboxResonance | null;
  bridgeCoupling: number;
  vibratingSpanFraction: number;
  speakingSpanBounds: [number, number];
  bridgeDrivePoint: [number, number, number];
  bridgeHillHz: number;
  bridgeHillGainDb: number;
  vibroIr: VibroAcousticIRResult | null;
}

const coupledSoundboxCache = new Map<string, CoupledSoundboxResult>();
const MAX_COUPLED_SOUNDBOX_CACHE = 128;

function fastGeomListSig(n: SceneNode): string {
  let out = `${n.id}|${n.pos?.[0] ?? 0},${n.pos?.[1] ?? 0},${n.pos?.[2] ?? 0}|${n.quat ? n.quat.join(',') : ''}|${n.euler ? n.euler.join(',') : ''}|${n.deformMaterial ?? ''}|${n.density ?? ''}|${n.mass ?? ''}|${n.sculptVersion ?? 0}|${n.sculptEdited ? 1 : 0}|${n.csgEnabled === false ? 0 : 1}`;
  const geoms = n.geoms;
  if (geoms && geoms.length > 0) {
    for (let i = 0; i < geoms.length; i++) {
      const g = geoms[i];
      if (g.csgDerived || g.role === 'visual' || g.type === 'plane') continue;
      out += `;${g.name ?? ''}:${g.type}:${g.csg ?? ''}:${g.size ? g.size.join(',') : ''}:${g.pos ? g.pos.join(',') : ''}:${g.quat ? g.quat.join(',') : ''}:${g.euler ? g.euler.join(',') : ''}:${g.fromto ? g.fromto.join(',') : ''}:${g.contype ?? ''}:${g.conaffinity ?? ''}:${g.renderVertices?.length ?? g.vertices?.length ?? 0}:${g.faces?.length ?? 0}`;
    }
  }
  return out;
}

function buildCoupledSoundboxCacheKey(
  stringNode: SceneNode,
  resonatorNode: SceneNode,
  sceneNodes: SceneNode[],
): string {
  let key = `${fastGeomListSig(stringNode)}||${fastGeomListSig(resonatorNode)}`;
  let isDirectChild = false;
  const children = resonatorNode.children;
  if (children && children.length > 0) {
    for (let i = 0; i < children.length; i++) {
      const ch = children[i];
      if (ch.id === stringNode.id) {
        isDirectChild = true;
        continue;
      }
      if (ch.acousticString || (ch.joints?.length ?? 0) > 0) continue;
      key += `|C:${fastGeomListSig(ch)}`;
    }
  }
  if (!isDirectChild) {
    const hw = resolveWorldMatrixWithOverride(resonatorNode, sceneNodes) ?? nodeLocalMatrix(resonatorNode);
    const sw = resolveWorldMatrixWithOverride(stringNode, sceneNodes) ?? nodeLocalMatrix(stringNode);
    const rel = hw.clone().invert().multiply(sw).elements;
    key += `|R:${rel[0].toFixed(4)},${rel[1].toFixed(4)},${rel[2].toFixed(4)},${rel[4].toFixed(4)},${rel[5].toFixed(4)},${rel[6].toFixed(4)},${rel[8].toFixed(4)},${rel[9].toFixed(4)},${rel[10].toFixed(4)},${rel[12].toFixed(5)},${rel[13].toFixed(5)},${rel[14].toFixed(5)}`;
  }
  return key;
}

const EMPTY_COUPLED_SOUNDBOX: CoupledSoundboxResult = {
  cacheKey: '',
  resonatorNode: null,
  soundbox: null,
  bridgeCoupling: 0,
  vibratingSpanFraction: 1.0,
  speakingSpanBounds: [0, 1],
  bridgeDrivePoint: [0, 0, 0],
  bridgeHillHz: 2000,
  bridgeHillGainDb: 0,
  vibroIr: null,
};

function resolveCoupledSoundboxAndSpan(
  node: SceneNode,
  sceneNodes?: SceneNode[],
): CoupledSoundboxResult {
  const spec = node.acousticString;
  if (!spec || !sceneNodes?.length) return EMPTY_COUPLED_SOUNDBOX;

  const resonatorNode = resolveResonatorHost(node, sceneNodes);
  if (!resonatorNode) return EMPTY_COUPLED_SOUNDBOX;

  const cacheKey = buildCoupledSoundboxCacheKey(node, resonatorNode, sceneNodes);
  const cached = coupledSoundboxCache.get(cacheKey);
  if (cached) {
    coupledSoundboxCache.delete(cacheKey);
    coupledSoundboxCache.set(cacheKey, cached);
    return cached;
  }

  const support = measurePhysicalStringSupport(node, resonatorNode, sceneNodes);
  if (support.bridgeCoupling <= 0.02) {
    // Floating string disconnected from bridge/nut: zero mechanical coupling to soundbox!
    if (coupledSoundboxCache.size >= MAX_COUPLED_SOUNDBOX_CACHE) {
      const oldest = coupledSoundboxCache.keys().next().value;
      if (oldest !== undefined) coupledSoundboxCache.delete(oldest);
    }
    coupledSoundboxCache.set(cacheKey, EMPTY_COUPLED_SOUNDBOX);
    return EMPTY_COUPLED_SOUNDBOX;
  }

  // Solve actual 3D solid eigenmodes of the standing bridge (`support.bridgeNode`) if present!
  let bridgeHillHz = 2000;
  let bridgeHillGainDb = 0;
  if (support.bridgeNode) {
    const bridgeModes = estimateBodyModes(support.bridgeNode);
    bridgeHillHz = roundN(Math.max(350, Math.min(5500, bridgeModes.fundamentalHz)), 10);
    bridgeHillGainDb = roundN(Math.min(5.2, 1.2 + 7.5 * bridgeModes.material.brightness) * support.bridgeCoupling, 100);
  }

  // Run (cached ~4 ms) 3D coupled FDTD air-cavity + Kirchhoff shell impulse-response simulation
  // injecting force right at this string's 3D bridge bearing point!
  const hostMat = inferAcousticMaterial(resonatorNode);
  const bMat = support.bridgeNode ? inferAcousticMaterial(support.bridgeNode) : null;
  const vibroIr = simulate3DVibroAcousticIR(
    resonatorNode,
    hostMat,
    support.bridgeNode,
    bMat,
    support.bridgeDrivePoint,
  );

  const baseRes = getCachedSoundboxResonance(resonatorNode);
  const scaledSoundbox = support.bridgeCoupling >= 0.98
    ? baseRes
    : {
        ...baseRes,
        radiationGain: roundN(0.22 + (baseRes.radiationGain - 0.22) * support.bridgeCoupling, 1000),
      };

  const result: CoupledSoundboxResult = {
    cacheKey,
    resonatorNode,
    soundbox: scaledSoundbox,
    bridgeCoupling: support.bridgeCoupling,
    vibratingSpanFraction: support.vibratingSpanFraction,
    speakingSpanBounds: support.speakingSpanBounds,
    bridgeDrivePoint: support.bridgeDrivePoint,
    bridgeHillHz,
    bridgeHillGainDb,
    vibroIr,
  };

  if (coupledSoundboxCache.size >= MAX_COUPLED_SOUNDBOX_CACHE) {
    const oldest = coupledSoundboxCache.keys().next().value;
    if (oldest !== undefined) coupledSoundboxCache.delete(oldest);
  }
  coupledSoundboxCache.set(cacheKey, result);
  return result;
}

/**
 * 100% Generic Helmholtz / Schelleng Continuous Bowed-String Solver:
 * - Computes exact Mersenne + stiff-string fundamental & wave impedance Z0 = sqrt(T * mu)
 * - Evaluates Schelleng's minimum (∝ Z0 |v_bow| / β² * Re(Y_bridge)) and maximum (∝ Z0 |v_bow| / β)
 *   bow-force limits, torsional rolling compliance, and coupled string-body wolf-note beating!
 * - Folds bowBeta in [0, 1] symmetrically around 0.5, chokes right at β -> 0 on the bridge saddle,
 *   and suppresses ONLY true interior harmonic nodes (1 <= m < n) rather than notching n = 1 at m = 0!
 */
export function solveBowedStringVoice(input: BowedStringContactInput): BowedStringVoice {
  const { node, sceneNodes } = input;
  const spec = node.acousticString;
  if (!spec) {
    return {
      active: false,
      pitchHz: 220,
      amplitude: 0,
      harmonicWeights: new Array<number>(24).fill(0),
      stringHarmonicWeights: new Array<number>(24).fill(0),
      bodyIr: null,
      bodyIrSig: '',
      bodyFormantHz: 220,
      bodyFormantGainDb: 0,
      bodyFormantQ: 1.4,
      secondaryFormantHz: 480,
      woodModeHz: 680,
      dipoleCancelHz: 750,
      dipoleCancelDb: 0,
      bridgeHillHz: 2000,
      bridgeHillGainDb: 0,
      lowpassHz: 1800,
      rosinNoiseGain: 0,
      rosinCenterHz: 1400,
      fMin: 0.02,
      fMax: 1.0,
      waveImpedanceZ0: 0.2,
      regime: 'silent',
      wolfBeatHz: 0,
      wolfBeatDepth: 0,
    };
  }

  const mat = resolveStringMaterial(spec.material);
  const coupled = resolveCoupledSoundboxAndSpan(node, sceneNodes);
  const soundbox = coupled.soundbox;
  const openLengthM = measureStringLengthM(node) * coupled.vibratingSpanFraction;
  const stopFrac =
    input.stoppedLengthFraction !== undefined && Number.isFinite(input.stoppedLengthFraction)
      ? Math.max(0.25, Math.min(1.0, input.stoppedLengthFraction))
      : 1.0;
  const effectiveLengthM = Math.max(0.02, openLengthM * stopFrac);

  const radiusM = Math.max(0.00006, (Number(spec.diameterMm) || 0.5) / 2000);
  const areaM2 = Math.PI * radiusM * radiusM;
  const mu = mat.densityKgM3 * areaM2;
  const tensionN = Math.max(0.5, Number(spec.tensionN) || 45);
  const E = mat.modulusGPa * 1e9;

  // Exact mechanical wave impedance Z0 = sqrt(T * mu) and stiff-string fundamental f1
  const waveImpedanceZ0 = Math.sqrt(tensionN * mu);
  const waveSpeed = Math.sqrt(tensionN / mu);
  const bActive = (Math.pow(Math.PI, 3) * E * Math.pow(radiusM, 4)) / (4 * tensionN * effectiveLengthM * effectiveLengthM);
  const f0Open = waveSpeed / (2 * openLengthM);
  const pitchHz = +((f0Open / stopFrac) * Math.sqrt(1 + bActive)).toFixed(2);

  const vBow = Number.isFinite(input.bowVelocityMps) ? Math.abs(input.bowVelocityMps) : 0;
  const forceN = Number.isFinite(input.bowForceN) ? Math.max(0, input.bowForceN) : 0;

  // Fold bowBeta in [0, 1] symmetrically into [0, 0.5]; attenuate smoothly when bowing right on top of the bridge saddle (beta -> 0)
  const rawBeta = Number.isFinite(input.bowBeta) ? Math.max(0, Math.min(1, input.bowBeta)) : 0.12;
  const foldedBeta = Math.min(rawBeta, 1 - rawBeta);
  const bridgeSaddleChoke = foldedBeta >= 0.025 ? 1.0 : Math.max(0, (foldedBeta - 0.003) / 0.022);
  const beta = Math.max(0.015, Math.min(0.5, foldedBeta));

  // Schelleng (1973) bow-force wedge limits with Skudrzyk bridge-admittance & Cremer torsional rolling compliance:
  //   F_min ∝ Z0 * |v_bow| / beta^2 * (intrinsicLoss + Z0 * Re(Y_bridge(f0)))
  //   F_max ∝ Z0 * |v_bow| / beta
  const torsionEase = 1 / (1 + 0.18 * (1 - mat.brightness));
  let bridgeLossScale = 0.78;
  let wolfCoupling = 0;
  if (soundbox && coupled.bridgeCoupling > 0.02) {
    const lTop = lorentzianResonance(pitchHz, soundbox.topPlateHz, 11.0);
    const lBody = lorentzianResonance(pitchHz, soundbox.bodyModeHz, 12.0);
    const lAir = soundbox.helmholtzHz !== null
      ? lorentzianResonance(pitchHz, soundbox.helmholtzHz, soundbox.helmholtzQ)
      : 0;
    const yBridgeNorm = coupled.bridgeCoupling * soundbox.radiationGain * (0.28 + 1.35 * lTop + 0.45 * lBody + 0.65 * lAir);
    bridgeLossScale = 0.80 + 0.42 * yBridgeNorm;
    wolfCoupling = coupled.bridgeCoupling * (waveImpedanceZ0 / 0.22) * soundbox.radiationGain * Math.max(lTop, 0.75 * lAir);
  }
  const fMin = +((0.042 * waveImpedanceZ0 * vBow * torsionEase * bridgeLossScale) / (beta * beta)).toFixed(6);
  const fMax = +((4.6 * waveImpedanceZ0 * vBow) / beta).toFixed(6);

  // Coupled string-body Wolf Note beating when Z0 * |Y_bridge(f0)| exceeds critical modal splitting threshold!
  let wolfBeatHz = 0;
  let wolfBeatDepth = 0;
  if (wolfCoupling > 0.58 && vBow >= 0.008 && forceN >= 0.015) {
    const excess = Math.min(1.5, wolfCoupling - 0.58);
    // Pressing firmly toward fMax suppresses the wolf slightly; light/moderate bow pressure stutters strongly
    const pressSuppress = forceN > fMin ? Math.max(0.35, 1 - 0.35 * Math.min(1.5, (forceN - fMin) / Math.max(0.05, fMax - fMin))) : 1.0;
    wolfBeatHz = +Math.max(3.2, Math.min(14.5, pitchHz * 0.032 * (0.7 + excess))).toFixed(2);
    wolfBeatDepth = +Math.min(0.62, 0.48 * excess * pressSuppress).toFixed(3);
  }

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
  const woodModeHz = soundbox
    ? +soundbox.bodyModeHz.toFixed(1)
    : +Math.max(540, pitchHz * 4.5).toFixed(1);
  const dipoleCancelHz = soundbox ? soundbox.dipoleCancelHz : 800;
  const dipoleCancelDb = soundbox ? soundbox.dipoleCancelDb : 0;
  const bridgeHillHz = coupled.bridgeHillHz;
  const bridgeHillGainDb = coupled.bridgeHillGainDb;
  const vibroIr = coupled.vibroIr;
  const bodyIr = vibroIr?.ir ?? null;
  const bodyIrSig = vibroIr?.signature ?? '';

  if (vBow < 0.008 || forceN < 0.015 || bridgeSaddleChoke <= 0.01) {
    return {
      active: false,
      pitchHz,
      amplitude: 0,
      harmonicWeights: new Array<number>(24).fill(0),
      stringHarmonicWeights: new Array<number>(24).fill(0),
      bodyIr,
      bodyIrSig,
      bodyFormantHz,
      bodyFormantGainDb,
      bodyFormantQ,
      secondaryFormantHz,
      woodModeHz,
      dipoleCancelHz,
      dipoleCancelDb,
      bridgeHillHz,
      bridgeHillGainDb,
      lowpassHz: 1500,
      rosinNoiseGain: 0,
      rosinCenterHz: 1400,
      fMin,
      fMax,
      waveImpedanceZ0: +waveImpedanceZ0.toFixed(5),
      regime: 'silent',
      wolfBeatHz: 0,
      wolfBeatDepth: 0,
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

  // Cremer corner-rounding + viscoelastic internal damping (higher-frequency gut modes round slightly more!)
  const freqVisco = 1 + Math.max(0, (pitchHz - 110) / 380) * (1.15 - 0.8 * mat.brightness);
  const cornerDecay = (0.052 / Math.pow(contactPressure, 0.55)) * (1.12 - 0.24 * mat.brightness) * freqVisco;
  const ribbonWidthM = Math.max(0.0015, Math.min(effectiveLengthM * 0.20, input.bowRibbonWidthM ?? 0.009));
  const ponticelloExp = Math.max(-0.46, Math.min(0.42, (0.38 * (0.13 - beta)) / 0.10));

  const nHarmonics = 24;
  const harmonicWeights: number[] = new Array<number>(nHarmonics);
  const stringHarmonicWeights: number[] = new Array<number>(nHarmonics);
  for (let n = 1; n <= nHarmonics; n++) {
    const fn = n * pitchHz;
    if (fn > 18500) {
      harmonicWeights[n - 1] = 0;
      stringHarmonicWeights[n - 1] = 0;
      continue;
    }

    // 1. Ideal Helmholtz sawtooth 1/n * Cremer bow-force corner rounding
    const cornerRoll = Math.exp(-cornerDecay * (n - 1));

    // 2. Interior-only bow-position node comb (1 <= m < n) + sul ponticello / sul tasto spectral tilt
    const mNode = Math.round(n * beta);
    const isInteriorNode = mNode >= 1 && mNode < n;
    const nodePhase = n * beta - mNode;
    let bowComb = isInteriorNode
      ? 1 - 0.85 * Math.exp(-Math.pow(nodePhase / 0.08, 2))
      : 1.0;
    // Glassy sul-ponticello fundamental dropout occurs ONLY when bow force drops below Schelleng F_min!
    if (n === 1 && underPress > 0 && beta < 0.09) {
      bowComb *= 1 - 0.72 * underPress * ((0.09 - beta) / 0.09);
    }
    const ponticelloTilt = Math.pow(n, ponticelloExp);

    // 3. Finite horsehair ribbon width sinc roll-off
    const uRibbon = (n * Math.PI * ribbonWidthM) / Math.max(0.025, effectiveLengthM);
    const ribbonSinc = uRibbon < 1e-3 ? 1.0 : Math.max(0.05, Math.abs(Math.sin(uRibbon) / uRibbon));

    // Raucous over-pressing adds gritty odd/upper partial crunch
    const raucousBoost = overPress > 0 && n >= 3 ? 1 + 0.35 * overPress * (n % 2 === 1 ? 1.0 : 0.6) : 1.0;

    // Pure string Helmholtz stick-slip harmonics (fed directly into the 3D Vibro-Acoustic ConvolverNode!)
    const pureStrW = (1 / n) * cornerRoll * bowComb * ponticelloTilt * ribbonSinc * raucousBoost;
    stringHarmonicWeights[n - 1] = roundN(pureStrW < 1.6 ? pureStrW : 1.6, 10000);

    // Diagnostic / fallback composite weights
    let boxGain = 0.50;
    if (soundbox) {
      let boxH = resonatorTransferGain(fn, soundbox.topPlateHz, 7.5, 2.0);
      boxH *= resonatorTransferGain(fn, soundbox.bodyModeHz, 8.5, 1.5);
      if (bridgeHillGainDb > 0.1) {
        boxH *= resonatorTransferGain(fn, bridgeHillHz, 3.0, bridgeHillGainDb * 0.45);
      }
      if (soundbox.helmholtzHz !== null) {
        boxH *= resonatorTransferGain(fn, soundbox.helmholtzHz, soundbox.helmholtzQ, 3.2);
        if (fn < soundbox.helmholtzHz * 0.80) {
          const ratio = fn / (soundbox.helmholtzHz * 0.80);
          boxH *= 0.45 + 0.55 * ratio * ratio;
        }
      } else if (soundbox.hasHollowCavity && fn < soundbox.topPlateHz * 0.85) {
        const ratio = fn / (soundbox.topPlateHz * 0.85);
        boxH *= 0.52 + 0.48 * ratio * ratio;
      }
      boxGain = Math.min(2.1, boxH * 0.62 * soundbox.radiationGain);
    }
    const colW = pureStrW * boxGain;
    harmonicWeights[n - 1] = roundN(colW < 1.6 ? colW : 1.6, 10000);
  }

  // Blend analytical Skudrzyk radiation gain with measured 3D FDTD radiation RMS efficiency!
  const radGain = soundbox
    ? vibroIr
      ? 0.55 * soundbox.radiationGain + 0.45 * vibroIr.radiationGain
      : soundbox.radiationGain
    : 0.34;
  // Transverse Helmholtz string velocity scales with v_bow / beta; saturates musically at fortissimo
  const effVelocityDrive = Math.tanh((vBow / Math.max(0.055, Math.sqrt(beta * 0.12))) * 0.95);
  const lockEfficiency =
    regime === 'flautando'
      ? 0.38 + 0.62 * (1 - underPress)
      : regime === 'raucous'
        ? Math.max(0.65, 1.05 - 0.18 * overPress)
        : 0.92 + 0.14 * Math.min(1, Math.log10(1 + pressureRatio));
  const amplitude = +(
    Math.min(0.44, 0.33 * effVelocityDrive * lockEfficiency * Math.min(1.45, radGain)) * bridgeSaddleChoke
  ).toFixed(4);

  const baseCutoff =
    1480 +
    pitchHz * (2.6 + 2.8 * mat.brightness) +
    620 * Math.min(2.2, pressureRatio) +
    (0.20 - Math.min(0.20, beta)) * 3400;
  const lowpassHz = +Math.max(1450, Math.min(5400, baseCutoff * (0.78 + 0.26 * mat.brightness))).toFixed(1);

  const speedSheen = Math.min(1, vBow / 0.28);
  const highStrTame = 1 / Math.sqrt(Math.max(1, pitchHz / 110));
  const rosinRaw =
    (0.0055 * speedSheen + 0.012 * underPress * speedSheen) * highStrTame +
    0.048 * overPress * (0.4 + 0.6 * speedSheen);
  const rosinNoiseGain = +Math.min(0.085, rosinRaw).toFixed(4);
  const rosinCenterHz = +Math.max(
    1450,
    Math.min(4000, (bridgeHillGainDb > 0 ? bridgeHillHz : 1900) + 650 * ((0.22 - Math.min(0.22, beta)) / 0.22) + 420 * overPress),
  ).toFixed(1);

  return {
    active: amplitude >= 0.002,
    pitchHz,
    amplitude,
    harmonicWeights,
    stringHarmonicWeights,
    bodyIr,
    bodyIrSig,
    bodyFormantHz,
    bodyFormantGainDb,
    bodyFormantQ,
    secondaryFormantHz,
    woodModeHz,
    dipoleCancelHz,
    dipoleCancelDb,
    bridgeHillHz,
    bridgeHillGainDb,
    lowpassHz,
    rosinNoiseGain,
    rosinCenterHz,
    fMin,
    fMax,
    waveImpedanceZ0: +waveImpedanceZ0.toFixed(5),
    regime,
    wolfBeatHz,
    wolfBeatDepth,
  };
}

/**
 * Starter #4b — Kirchhoff-Carrier Nonlinear Plucked String Tension-Modulation Pitch Droop:
 *   ΔT(t) = (π² L K_axial,eff / 8) * γ(β) * (A(t) / L)²
 *   f(t) = f_0 * sqrt(1 + κ_TM * (A(t) / L)²),   Δf_0 / f_0 ∝ (A_0 / L)²
 *   τ_droop = 0.5 * τ_1,amp   (since A(t)² decays at 2x the amplitude decay rate!)
 */
export function computePluckPitchDroop(
  node: SceneNode,
  lengthM: number,
  impulseNs: number,
  pluckPos = 0.18,
  fundamentalDecaySec = 1.2,
): PluckPitchDroopResult {
  const spec = node.acousticString;
  const tauAmp = Math.max(0.03, fundamentalDecaySec / LN_10000);
  const pitchDroopTauSec = +Math.max(0.015, Math.min(0.32, 0.5 * tauAmp)).toFixed(4);

  if (
    !spec ||
    spec.nonlinearPitchDroop === false ||
    spec.nonlinearPitchDroop === 0 ||
    !Number.isFinite(impulseNs) ||
    impulseNs <= 0 ||
    !Number.isFinite(lengthM) ||
    lengthM <= 0.01
  ) {
    return {
      pitchDroopFrac: 0,
      pitchDroopCents: 0,
      pitchDroopTauSec,
      displacementM: 0,
      kappaTM: 0,
    };
  }

  const userScale =
    typeof spec.nonlinearPitchDroop === 'number'
      ? Math.max(0, Math.min(4.0, spec.nonlinearPitchDroop))
      : 1.0;

  const mat = resolveStringMaterial(spec.material);
  const L = Math.max(0.02, lengthM);
  const radiusM = Math.max(0.00006, (Number(spec.diameterMm) || 0.5) / 2000);
  const areaM2 = Math.PI * radiusM * radiusM;
  const tensionN = Math.max(0.5, Number(spec.tensionN) || 45);
  const E = mat.modulusGPa * 1e9;

  // Pluck-point triangular slope factor γ(β) (plucks near the bridge stretch initial slope more steeply)
  const beta = Math.max(0.04, Math.min(0.5, Number.isFinite(pluckPos) ? pluckPos : 0.18));
  const gammaBeta = Math.min(2.2, 0.65 + 0.12 / (beta * (1 - beta)));

  // Series axial stiffness of wire (E*S / L) and wooden bridge/nut/peg termination compliance (C_term = 3e-6 m/N)
  const cTermMPerN = 3.0e-6;
  const kAxialEff = 1 / (L / (E * areaM2) + cTermMPerN);
  const kappaTM = ((Math.PI * Math.PI * L * kAxialEff) / (8 * tensionN)) * gammaBeta * userScale;

  // Transverse pluck deflection A_0 against mid-span stiffness k_mid = 4 * T_0 / L (linear for small/moderate J -> exact Δf ∝ (A/L)²!)
  const kMid = (4 * tensionN) / L;
  const aMax = Math.min(0.012, 0.035 * L);
  const fTransverse = 4.0 * impulseNs;
  const displacementM = aMax * Math.tanh(fTransverse / Math.max(1e-6, kMid * aMax));

  const aOverL = displacementM / L;
  const pitchDroopFrac = Math.min(0.25, Math.sqrt(1 + kappaTM * aOverL * aOverL) - 1);
  const pitchDroopCents = +(1200 * Math.log2(1 + pitchDroopFrac)).toFixed(2);

  return {
    pitchDroopFrac: +pitchDroopFrac.toFixed(6),
    pitchDroopCents,
    pitchDroopTauSec,
    displacementM: +displacementM.toFixed(6),
    kappaTM: +kappaTM.toFixed(3),
  };
}

const baseStringEvalCache = new Map<string, StringEvaluation>();
const MAX_BASE_STRING_EVAL_CACHE = 64;

/**
 * Evaluates a taut string's Mersenne + Fletcher stiff-string modes, breaking-stress safety,
 * coupled 3D soundbox resonance, un-colored `rawStringModes` (for double-filter-free 3D FIR convolution),
 * and live plectrum/strike-point + nonlinear tension pitch droop shaping!
 */
export function evaluateTautString(
  node: SceneNode,
  sceneNodes?: SceneNode[],
  impactCtx?: StringPluckImpactContext,
): StringEvaluation | null {
  const spec = node.acousticString;
  if (!spec) return null;

  const coupled = resolveCoupledSoundboxAndSpan(node, sceneNodes);
  let evalCacheKey: string | null = null;
  if (!impactCtx) {
    const geomSig = coupled.cacheKey ? '' : fastGeomListSig(node);
    evalCacheKey = `${coupled.cacheKey}|${geomSig}|${spec.material}|${spec.diameterMm}|${spec.tensionN}|${spec.pluckPos ?? ''}|${spec.nonlinearPitchDroop ?? ''}|${sceneNodes?.length ? 1 : 0}`;
    const cachedEval = baseStringEvalCache.get(evalCacheKey);
    if (cachedEval) {
      baseStringEvalCache.delete(evalCacheKey);
      baseStringEvalCache.set(evalCacheKey, cachedEval);
      return cachedEval;
    }
  }

  const mat = resolveStringMaterial(spec.material);
  const soundbox = coupled.soundbox;
  const stopFrac =
    impactCtx?.stoppedLengthFraction !== undefined && Number.isFinite(impactCtx.stoppedLengthFraction)
      ? Math.max(0.25, Math.min(1.0, impactCtx.stoppedLengthFraction))
      : 1.0;
  const lengthM = Math.max(0.02, measureStringLengthM(node) * coupled.vibratingSpanFraction * stopFrac);
  const radiusM = Math.max(0.00006, (Number(spec.diameterMm) || 0.5) / 2000);
  const areaM2 = Math.PI * radiusM * radiusM;
  const linearDensityKgM = mat.densityKgM3 * areaM2;
  const tensionN = Math.max(0.5, Number(spec.tensionN) || 45);
  const waveImpedanceZ0 = Math.sqrt(tensionN * linearDensityKgM);

  // 1. Mersenne's law + Fletcher (1964) stiff-string dispersion B = (π³ * E * r⁴) / (4 * T * L²)
  const waveSpeed = Math.sqrt(tensionN / linearDensityKgM);
  const f0Mersenne = waveSpeed / (2 * lengthM);
  const E = mat.modulusGPa * 1e9;
  const inharmonicityB = (Math.pow(Math.PI, 3) * E * Math.pow(radiusM, 4)) / (4 * tensionN * lengthM * lengthM);
  const fundamentalHz = f0Mersenne * Math.sqrt(1 + inharmonicityB);
  const overtoneRatio = +(2 * Math.sqrt((1 + 4 * inharmonicityB) / (1 + inharmonicityB))).toFixed(3);

  // 3. Tensile stress & safety factor
  const tensileStressMPa = (tensionN / areaM2) / 1e6;
  const stressRatio = tensileStressMPa / mat.ultimateStrengthMPa;
  const transverseStiffnessNm = (4 * tensionN) / lengthM;

  const warnings: string[] = [];
  if (sceneNodes?.length && coupled.bridgeCoupling <= 0.02) {
    warnings.push('String is floating without mechanical bridge/nut contact — uncoupled from soundbox.');
  }
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

  // 4. Determine actual pluck position (within active speaking/stopped span!) & plectrum contact width/stiffness
  const pluckPos = impactCtx?.localPoint
    ? Math.max(0.04, resolveStringBetaFromPoint(node, impactCtx.localPoint, stopFrac, sceneNodes))
    : Math.max(0.04, Math.min(0.5, Number.isFinite(spec.pluckPos) ? spec.pluckPos! : 0.18));

  let pickWidthM = 0.004;
  let pickBrightness = mat.brightness;
  let contactTauSec = 0.00072;
  if (impactCtx?.strikerNode) {
    const pickProps = inferColliderContactProps(impactCtx.strikerNode, impactCtx.strikerGeomName);
    pickWidthM = Math.max(0.001, Math.min(lengthM * 0.25, 1.6 * pickProps.radiusM));
    pickBrightness = 0.45 * mat.brightness + 0.55 * pickProps.brightness;
    contactTauSec = Math.max(0.00035, Math.min(0.0028, 0.00095 * Math.pow(3e9 / pickProps.modulusPa, 0.18)));
  }

  const radGain = soundbox ? soundbox.radiationGain : 0.65;
  const bridgeLoadFactor = soundbox ? Math.max(0.68, 1.0 - 0.18 * soundbox.radiationGain) : 1.0;
  const f1DecaySec = Math.max(0.04, Math.min(5.5, ((mat.intrinsicQ * bridgeLoadFactor) / (Math.PI * fundamentalHz)) * 2.6));
  const pitchDroop = computePluckPitchDroop(
    node,
    lengthM,
    impactCtx?.impulseNs ?? 0,
    pluckPos,
    f1DecaySec,
  );

  const modes: PluckedModalVoice[] = [];
  const rawStringModes: PluckedModalVoice[] = [];
  const nPartials = 12;

  for (let n = 1; n <= nPartials; n++) {
    const fn = n * f0Mersenne * Math.sqrt(1 + inharmonicityB * n * n);
    if (fn < 24 || fn > 17500) continue;

    // Pluck triangle-wave Fourier rolloff * spatial pluck comb sin(n * π * x_pluck / L)
    const comb = Math.abs(Math.sin(n * Math.PI * pluckPos));
    if (comb < 0.035) continue;

    // Finite plectrum contact width sinc filter: sin(n π w_pick / L) / (n π w_pick / L)
    const uPick = (n * Math.PI * pickWidthM) / Math.max(0.02, lengthM);
    const pickSinc = uPick < 1e-3 ? 1.0 : Math.abs(Math.sin(uPick) / uPick);

    // Plectrum stiffness spectral tilt (stiff metal pick boosts upper partials vs soft felt/wood)
    const rolloffExp = 1.46 - 0.34 * pickBrightness;
    const pureGain = (comb / Math.pow(n, rolloffExp)) * pickSinc * radGain;
    let coloredGain = pureGain;

    // Couple through the 3D soundbox's Helmholtz air cavity + Kirchhoff top/body plate formants (fallback when no IR)!
    if (soundbox) {
      let boxH = resonatorTransferGain(fn, soundbox.topPlateHz, 8.5, 4.2);
      boxH *= resonatorTransferGain(fn, soundbox.bodyModeHz, 10.0, 2.6);
      if (soundbox.helmholtzHz !== null) {
        boxH *= resonatorTransferGain(fn, soundbox.helmholtzHz, soundbox.helmholtzQ, 5.8);
        if (fn < soundbox.helmholtzHz * 0.75) {
          const ratio = fn / (soundbox.helmholtzHz * 0.75);
          boxH *= 0.30 + 0.70 * ratio * ratio;
        }
      }
      coloredGain *= Math.min(2.4, boxH * 0.60);
    }

    const partialQ = (mat.intrinsicQ * bridgeLoadFactor) / (1 + 0.28 * (n - 1) * (n - 1) * (1 - 0.5 * pickBrightness));
    const decaySec = Math.max(0.04, Math.min(5.5, (partialQ / (Math.PI * fn)) * 2.6));
    // Stiff-string tension modulation affects lower modes most strongly; higher stiff modes scale by 1 / (1 + B*n²)
    const partialDroopFrac =
      pitchDroop.pitchDroopFrac > 0
        ? +(pitchDroop.pitchDroopFrac / (1 + inharmonicityB * n * n)).toFixed(6)
        : undefined;

    if (pureGain >= 0.0008) {
      rawStringModes.push({
        freqHz: +fn.toFixed(2),
        gain: +Math.min(1.25, pureGain).toFixed(4),
        decaySec: +decaySec.toFixed(4),
        ...(partialDroopFrac ? { pitchDroopFrac: partialDroopFrac, pitchDroopTauSec: pitchDroop.pitchDroopTauSec } : {}),
      });
    }

    if (coloredGain >= 0.0008) {
      modes.push({
        freqHz: +fn.toFixed(2),
        gain: +Math.min(1.25, coloredGain).toFixed(4),
        decaySec: +decaySec.toFixed(4),
        ...(partialDroopFrac ? { pitchDroopFrac: partialDroopFrac, pitchDroopTauSec: pitchDroop.pitchDroopTauSec } : {}),
      });
    }
  }

  // Sympathetic transient excitation of the soundbox's own Helmholtz air-boom & top-plate knock (analytical fallback modes)
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

  const profile: BodyModalProfile & { rawStringModes?: PluckedModalVoice[] } = {
    fundamentalHz: +fundamentalHz.toFixed(2),
    overtoneRatio,
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
    rawStringModes,
    radiatingWidthM: soundbox ? 0.12 : 0.016,
    bodyIr: coupled.vibroIr?.ir ?? null,
    bodyIrSig: coupled.vibroIr?.signature ?? '',
  };

  const result: StringEvaluation = {
    lengthM: +lengthM.toFixed(4),
    fundamentalHz: +fundamentalHz.toFixed(2),
    inharmonicityB: +inharmonicityB.toExponential(3),
    linearDensityKgM: +linearDensityKgM.toExponential(4),
    tensileStressMPa: +tensileStressMPa.toFixed(1),
    stressRatio: +stressRatio.toFixed(3),
    transverseStiffnessNm: +transverseStiffnessNm.toFixed(1),
    waveImpedanceZ0: +waveImpedanceZ0.toFixed(5),
    bridgeCoupling: coupled.bridgeCoupling,
    speakingSpanBounds: coupled.speakingSpanBounds,
    bridgeDrivePoint: coupled.bridgeDrivePoint,
    rawStringModes,
    pitchDroop,
    warnings,
    soundbox,
    profile,
  };
  if (evalCacheKey !== null) {
    if (baseStringEvalCache.size >= MAX_BASE_STRING_EVAL_CACHE) {
      const oldest = baseStringEvalCache.keys().next().value;
      if (oldest !== undefined) baseStringEvalCache.delete(oldest);
    }
    baseStringEvalCache.set(evalCacheKey, result);
  }
  return result;
}

function collectStringNodes(nodes: SceneNode[], out: SceneNode[] = []): SceneNode[] {
  for (const n of nodes) {
    if (n.acousticString) out.push(n);
    if (n.children?.length) collectStringNodes(n.children, out);
  }
  return out;
}

/**
 * Starter #3 — Weinreich-Gough Bridge-Admittance Sympathetic String Coupling:
 * Computes cross-string modal excitation across all unplayed sibling strings sharing the same
 * 3D resonator body (`resonatorNodeId` or parent) via Skudrzyk bridge admittance `Y_bridge(f)`,
 * 3D bridge bearing proximity `exp(-|r_a - r_b| / λ_plate)`, and Lorentzian harmonic coincidence!
 */
export function solveSympatheticStringCoupling(
  sourceNode: SceneNode,
  sceneNodes: SceneNode[],
  opts?: {
    sourcePitchHz?: number;
    sourcePartials?: { freqHz: number; gain: number }[];
    excludedNodeIds?: ReadonlySet<string>;
  },
): SympatheticStringTarget[] {
  if (!sourceNode.acousticString || !sceneNodes?.length) return [];

  const srcCoupled = resolveCoupledSoundboxAndSpan(sourceNode, sceneNodes);
  const host = srcCoupled.resonatorNode;
  const soundbox = srcCoupled.soundbox;
  if (!host || !soundbox || srcCoupled.bridgeCoupling <= 0.05) return [];

  const srcEval = evaluateTautString(sourceNode, sceneNodes);
  if (!srcEval) return [];

  let sourcePartials: { freqHz: number; gain: number }[];
  if (opts?.sourcePartials && opts.sourcePartials.length > 0) {
    sourcePartials = opts.sourcePartials.filter((p) => p.gain > 0.001 && p.freqHz >= 20 && p.freqHz <= 18000);
  } else {
    const pitchRatio =
      opts?.sourcePitchHz && opts.sourcePitchHz > 20 && srcEval.fundamentalHz > 1e-3
        ? opts.sourcePitchHz / srcEval.fundamentalHz
        : 1.0;
    sourcePartials = srcEval.rawStringModes.map((m) => ({
      freqHz: m.freqHz * pitchRatio,
      gain: m.gain,
    }));
  }
  if (sourcePartials.length === 0) return [];

  // Normalized Skudrzyk driving-point bridge admittance scale (reference 4 mm spruce soundboard -> Y_ref ~ 0.012 m/(N·s))
  const hostMat = inferAcousticMaterial(host);
  const cLong = Math.sqrt((hostMat.modulusGPa * 1e9) / Math.max(80, hostMat.density));
  const hTopM = Math.max(0.0015, soundbox.topPlateThicknessMm / 1000);
  const y0Plate = soundbox.hasHollowCavity
    ? Math.min(0.032, 1 / Math.max(25, 2.31 * hostMat.density * cLong * hTopM * hTopM))
    : 0.0018;

  // Hoist soundbox transfer magnitude `hBox` per source partial ONCE (previously recomputed N_siblings * 12 times!)
  const nSrcPartials = sourcePartials.length;
  const srcPartialHBox = new Float64Array(nSrcPartials);
  for (let i = 0; i < nSrcPartials; i++) {
    const fSp = sourcePartials[i].freqHz;
    let hBox = resonatorTransferGain(fSp, soundbox.topPlateHz, 8.0, 2.8);
    hBox *= resonatorTransferGain(fSp, soundbox.bodyModeHz, 9.0, 1.8);
    if (soundbox.helmholtzHz !== null) {
      hBox *= resonatorTransferGain(fSp, soundbox.helmholtzHz, soundbox.helmholtzQ, 3.6);
    }
    if (srcCoupled.bridgeHillGainDb > 0.1) {
      hBox *= resonatorTransferGain(fSp, srcCoupled.bridgeHillHz, 3.2, srcCoupled.bridgeHillGainDb * 0.4);
    }
    srcPartialHBox[i] = hBox < 3.6 ? hBox : 3.6;
  }

  const allStrings = collectStringNodes(sceneNodes);
  const targets: SympatheticStringTarget[] = [];

  for (const cand of allStrings) {
    if (cand.id === sourceNode.id) continue;
    if (opts?.excludedNodeIds?.has(cand.id)) continue;

    const candHost = resolveResonatorHost(cand, sceneNodes);
    if (!candHost || candHost.id !== host.id) continue;

    const candEval = evaluateTautString(cand, sceneNodes);
    if (!candEval || candEval.bridgeCoupling <= 0.05) continue;

    const dxB = srcCoupled.bridgeDrivePoint[0] - candEval.bridgeDrivePoint[0];
    const dyB = srcCoupled.bridgeDrivePoint[1] - candEval.bridgeDrivePoint[1];
    const dzB = srcCoupled.bridgeDrivePoint[2] - candEval.bridgeDrivePoint[2];
    const distBridgeM = Math.sqrt(dxB * dxB + dyB * dyB + dzB * dzB);
    const spatialBridgeTransfer = Math.exp(-distBridgeM / 0.18);

    const candMat = resolveStringMaterial(cand.acousticString!.material);
    const candRadiusM = Math.max(0.00006, (Number(cand.acousticString!.diameterMm) || 0.5) / 2000);
    const candTensionN = Math.max(0.5, Number(cand.acousticString!.tensionN) || 45);
    const candMu = candMat.densityKgM3 * Math.PI * candRadiusM * candRadiusM;
    const candF0Mersenne = Math.sqrt(candTensionN / candMu) / (2 * candEval.lengthM);
    const candB =
      (Math.PI * Math.PI * Math.PI * candMat.modulusGPa * 1e9 * candRadiusM * candRadiusM * candRadiusM * candRadiusM) /
      (4 * candTensionN * candEval.lengthM * candEval.lengthM);

    const zGeomMean = Math.sqrt(srcEval.waveImpedanceZ0 * candEval.waveImpedanceZ0);
    const bridgeLoadFactor = Math.max(0.68, 1.0 - 0.18 * soundbox.radiationGain);
    const baseKappaFactor =
      (srcCoupled.bridgeCoupling * candEval.bridgeCoupling * zGeomMean * y0Plate * spatialBridgeTransfer) / Math.PI;

    const sympModes: PluckedModalVoice[] = [];
    const sympRawModes: PluckedModalVoice[] = [];
    let peakSympGain = 0;

    for (let q = 1; q <= 12; q++) {
      const fq = q * candF0Mersenne * Math.sqrt(1 + candB * q * q);
      if (fq < 24 || fq > 16500) continue;

      const partialQ = (candMat.intrinsicQ * bridgeLoadFactor) / (1 + 0.22 * (q - 1) * (q - 1));
      // Lorentzian capture half-width combines intrinsic damping f/(2Q) and temperament/vibrato lock bandwidth (0.45% ≈ 7.8 cents)
      const g1 = fq / (2 * Math.max(20, partialQ));
      const g2 = 0.0045 * fq;
      const gammaSq = g1 * g1 + g2 * g2;
      const qPow = SYMP_Q_POW_NEG_045[q];

      let energySum = 0;
      for (let i = 0; i < nSrcPartials; i++) {
        const sp = sourcePartials[i];
        const df = sp.freqHz - fq;
        const lorentz = gammaSq / (df * df + gammaSq);
        if (lorentz < 0.015) continue;

        const kappa = baseKappaFactor * srcPartialHBox[i];
        const scaledKappa = 180.0 * kappa;
        const transferAmp = sp.gain * (scaledKappa < 0.26 ? scaledKappa : 0.26) * lorentz * qPow;
        energySum += transferAmp * transferAmp;
      }

      const rawSympGain = Math.sqrt(energySum);
      if (rawSympGain < 0.0015) continue;

      let coloredSympGain = rawSympGain;
      let outBox = resonatorTransferGain(fq, soundbox.topPlateHz, 8.0, 2.4);
      if (soundbox.helmholtzHz !== null) {
        outBox *= resonatorTransferGain(fq, soundbox.helmholtzHz, soundbox.helmholtzQ, 3.0);
      }
      coloredSympGain *= Math.min(2.0, outBox * 0.65 * soundbox.radiationGain);

      const decaySec = Math.max(0.08, Math.min(5.5, (partialQ / (Math.PI * fq)) * 2.6));
      const cleanRaw = roundN(Math.min(0.35, rawSympGain), 10000);
      const cleanCol = roundN(Math.min(0.42, Math.max(rawSympGain * 0.75, coloredSympGain)), 10000);
      if (cleanCol > peakSympGain) peakSympGain = cleanCol;

      const cleanFreq = roundN(fq, 100);
      const cleanDecay = roundN(decaySec, 10000);
      sympRawModes.push({
        freqHz: cleanFreq,
        gain: cleanRaw,
        decaySec: cleanDecay,
      });
      sympModes.push({
        freqHz: cleanFreq,
        gain: cleanCol,
        decaySec: cleanDecay,
      });
    }

    if (sympModes.length > 0 && peakSympGain >= 0.002) {
      targets.push({
        targetNode: cand,
        targetNodeId: cand.id,
        fundamentalHz: candEval.fundamentalHz,
        bridgeCoupling: candEval.bridgeCoupling,
        couplingGain: roundN(peakSympGain, 10000),
        modes: sympModes,
        rawStringModes: sympRawModes,
        bodyIr: candEval.profile.bodyIr ?? null,
        bodyIrSig: candEval.profile.bodyIrSig ?? '',
      });
    }
  }

  targets.sort((a, b) => b.couplingGain - a.couplingGain);
  return targets;
}

/**
 * Ensures a user-authored capsule/cylinder toggled into `acousticString` mode has:
 * 1. A transverse `slide` pluck joint perpendicular to the wire axis (replacing `free` or empty `joints: []`
 *    so the wire neither falls to the floor nor sits un-pluckable at 0-DOF), and
 * 2. Collidable wire contact (`solref` + material density) so plectrums, mallets, and bows physically engage it.
 */
export function ensureTautStringJointAndContact(node: SceneNode): SceneNode {
  const mat = resolveStringMaterial(node.acousticString?.material ?? 'bronze');
  const ep = resolveStringLocalEndpoints(node);
  const lengthM = measureStringLengthM(node);
  const tensionN = Math.max(2, Number(node.acousticString?.tensionN) || 48);
  const kTransverse = +(4 * tensionN / Math.max(0.02, lengthM)).toFixed(1);

  let wireDir = new THREE.Vector3(0, 1, 0);
  if (ep) {
    const d = new THREE.Vector3(ep.p1[0] - ep.p0[0], ep.p1[1] - ep.p0[1], ep.p1[2] - ep.p0[2]);
    if (d.lengthSq() > 1e-10) wireDir = d.normalize();
  }

  // Pick a horizontal-preferred unit transverse slide axis perpendicular to `wireDir`
  const upRef = Math.abs(wireDir.z) < 0.85 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const transVec = new THREE.Vector3().crossVectors(wireDir, upRef).normalize();
  const slideAxis: [number, number, number] = [
    +transVec.x.toFixed(5),
    +transVec.y.toFixed(5),
    +transVec.z.toFixed(5),
  ];

  const hasValidPluckSlide =
    (node.joints?.length ?? 0) > 0 && !(node.joints!.length === 1 && node.joints![0].type === 'free');
  const travelM = +Math.max(0.002, Math.min(0.008, lengthM * 0.025)).toFixed(5);
  const nextJoints: SceneJoint[] = hasValidPluckSlide
    ? node.joints.map((j) => ({ ...j }))
    : [
        {
          name: `${node.id}_pluck`,
          type: 'slide',
          axis: slideAxis,
          stiffness: kTransverse,
          damping: +Math.max(0.04, kTransverse * 0.0008).toFixed(4),
          limited: true,
          range: [-travelM, travelM],
        },
      ];

  const nextGeoms = (node.geoms ?? []).map((g, idx) => {
    if (idx !== 0 || g.role === 'visual' || g.csg === 'difference' || g.csgDerived) {
      return { ...g };
    }
    const clearDisabled = g.contype === 0 && g.conaffinity === 0;
    return {
      ...g,
      ...(clearDisabled ? { contype: undefined, conaffinity: undefined } : {}),
      solref: g.solref ?? [0.004, 0.25],
      ...(g.mass === undefined && g.density === undefined ? { density: mat.densityKgM3 } : {}),
    };
  });

  return {
    ...node,
    geoms: nextGeoms,
    joints: nextJoints,
  };
}

/**
 * Tunes a taut string node to `targetHz` via Mersenne + Fletcher stiff-string law:
 *   T = 4 * L_eff² * f_target² * μ - (π³ * E * r⁴) / (4 * L_eff²)
 * accounting for coupled `vibratingSpanFraction` when `sceneNodes` is supplied, automatically
 * adjusting wire gauge to stay within [12 N .. 65% breaking stress], and ensuring a valid
 * MuJoCo transverse `slide` pluck joint (`4 * T / L_eff`).
 */
export function tuneStringToPitch(
  node: SceneNode,
  targetHz: number,
  sceneNodes?: SceneNode[],
): SceneNode {
  const safeTargetHz = Number.isFinite(targetHz) && targetHz > 10 ? targetHz : 261.63;
  const cur = node.acousticString ?? { material: 'bronze', diameterMm: 0.65, tensionN: 55 };
  const mat = resolveStringMaterial(cur.material);
  const seededNode: SceneNode = node.acousticString ? node : { ...node, acousticString: cur };

  const coupled = sceneNodes?.length ? resolveCoupledSoundboxAndSpan(seededNode, sceneNodes) : null;
  const spanFrac = coupled ? coupled.vibratingSpanFraction : 1.0;
  const lengthM = Math.max(0.02, measureStringLengthM(seededNode) * spanFrac);
  const E = mat.modulusGPa * 1e9;

  let diameterMm = Number(cur.diameterMm) || 0.65;
  const computeTension = (dMm: number) => {
    const r = dMm / 2000;
    const mu = mat.densityKgM3 * Math.PI * r * r;
    const tMersenne = 4 * lengthM * lengthM * safeTargetHz * safeTargetHz * mu;
    const tBendCorr = (Math.pow(Math.PI, 3) * E * Math.pow(r, 4)) / (4 * lengthM * lengthM);
    return tMersenne - tBendCorr;
  };

  let tensionN = computeTension(diameterMm);
  const areaOf = (dMm: number) => Math.PI * Math.pow(dMm / 2000, 2);
  const maxSafeStressPa = mat.ultimateStrengthMPa * 1e6 * 0.65;

  if (
    tensionN <= 0 ||
    tensionN / areaOf(diameterMm) > maxSafeStressPa ||
    tensionN < 12 ||
    tensionN > 140
  ) {
    const targetT = Math.min(85, Math.max(18, lengthM < 0.22 ? 220 * lengthM : 48));
    const idealMu = targetT / (4 * lengthM * lengthM * safeTargetHz * safeTargetHz);
    const idealR = Math.sqrt(idealMu / (mat.densityKgM3 * Math.PI));
    diameterMm = +Math.max(0.20, Math.min(2.45, idealR * 2000)).toFixed(2);
    tensionN = computeTension(diameterMm);
    if (tensionN < 2) {
      diameterMm = +Math.max(0.14, diameterMm * 0.65).toFixed(2);
      tensionN = Math.max(2, computeTension(diameterMm));
    }
  }

  const cleanTension = +Math.max(2, Math.min(280, tensionN)).toFixed(2);
  const kTransverse = +(4 * cleanTension / lengthM).toFixed(1);
  const visRadiusM = +Math.max(0.0009, (diameterMm / 2000) * 1.8).toFixed(5);

  const prepared =
    !seededNode.joints?.length || (seededNode.joints.length === 1 && seededNode.joints[0].type === 'free')
      ? ensureTautStringJointAndContact({
          ...seededNode,
          acousticString: { ...cur, material: mat.id, diameterMm, tensionN: cleanTension },
        })
      : seededNode;

  const primaryWire = findPrimaryWireGeom(prepared);
  const nextGeoms = (prepared.geoms ?? []).map((g) =>
    g === primaryWire && (g.type === 'capsule' || g.type === 'cylinder')
      ? { ...g, size: [visRadiusM, ...g.size.slice(1)], rgba: [...mat.rgba] }
      : { ...g },
  );

  const nextJoints = (prepared.joints ?? []).map((j, idx) =>
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
    ...prepared,
    geoms: nextGeoms,
    joints: nextJoints,
    tunedPitchHz: +safeTargetHz.toFixed(2),
    acousticString: {
      ...cur,
      material: mat.id,
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
  const mat = resolveStringMaterial(opts.material ?? 'bronze');
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
        material: mat.id,
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
