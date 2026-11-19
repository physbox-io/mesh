// ---------------------------------------------------------------------------
// Modal Impact Audio (100% 3D Geometry-Driven & Two-Body Hertzian Synthesis)
// ---------------------------------------------------------------------------
//
// Derives structural vibration modes (frequencies, mode shapes, relative gains,
// decay times) directly from ANY 3D solid's actual cross-sectional area A(s),
// bending inertia I(s), shell wall thickness, internal cavity ports, and
// material — whether primitive, CSG boolean, or freehand Sculpt mesh!
//
// Collision synthesis models BOTH impactors via two-body Hertzian contact
// mechanics (reduced modulus E*, reduced curvature R*, reduced mass m*, and
// strike coordinate ξ_hit along the normalized Legendre mode shapes ψ_m(ξ)),
// routed through the shared studio-chamber ConvolverNode bus.
// ---------------------------------------------------------------------------

import type { SceneGeom, SceneNode } from '../types/scene';
import { useSoundStore } from '../store/soundStore';
import { deformMaterial, geomVolume } from './deformMaterials';
import {
  analyze3DCavityAndPorts,
  analyze3DSolidCrossSections,
  evaluateNormalizedModeShape,
  simulate3DVibroAcousticIR,
  solveGeneralSectionBeamModes,
} from './solidAcoustics3D';
import {
  createResampledConvolver,
  getOrInitModalWorklet,
  getSharedAcousticOutputBus,
  postWorkletAeroSilence,
  postWorkletAeroSnap,
  postWorkletAeroUpdate,
  postWorkletBowedSilence,
  postWorkletBowedUpdate,
  postWorkletWindSilence,
  postWorkletWindUpdate,
  setStudioReverbEnabled,
  type WorkletBowedVoicePayload,
  type WorkletWindVoicePayload,
} from './modalAudioWorklet';
import type { AeroSynthParams, SnapSynthParams } from './aeroAcoustics';

export interface AcousticMaterialProps {
  label: string;
  density: number;
  modulusGPa: number;
  /** Mechanical quality factor Q (higher = longer sustain, e.g. steel ~950, wood ~145, plastic ~42). */
  qualityQ: number;
  /** High-frequency transient click brightness (0..1). */
  brightness: number;
}

export interface ModalVoice {
  freqHz: number;
  gain: number;
  decaySec: number;
}

export interface BodyModalProfile {
  fundamentalHz: number;
  overtoneRatio: number;
  regime: 'bar' | 'arched_bar' | 'tube' | 'plate' | 'block';
  material: AcousticMaterialProps;
  /** Physical single-body reference Hertz contact duration τ_c (s) at 1 m/s impact speed. */
  contactDurationSec: number;
  /** Audible structural modes (< 18 kHz), weighted by reference Hertzian pulse. */
  modes: ModalVoice[];
  /** Unweighted intrinsic modal frequencies (Hz) before strike-location / striker-material filtering. */
  rawFreqsHz?: number[];
  /** Intrinsic base modal gains before Hertzian striker filtering. */
  rawBaseGains?: number[];
  /** Optional per-mode mechanical/acoustic Q overrides (e.g. air Helmholtz Q vs solid shell Q, or joined panel seam damping). */
  rawModeQs?: number[];
  /** Normalized Legendre polynomial mode-shape vectors ψ_m(ξ) along `lenAxis` in [-1, 1]. */
  modeVectors?: number[][];
  /** Principal longitudinal axis (0=X, 1=Y, 2=Z) and solid span [sMin, sMax] in body-local coordinates. */
  lenAxis?: 0 | 1 | 2;
  lenBounds?: [number, number];
  /** Effective solid mass (kg) and radiating width (m) for two-body Hertzian & dipole radiation coupling. */
  massKg?: number;
  radiatingWidthM?: number;
  /** Simulated 48 kHz 3D vibro-acoustic impulse response of this body (or coupled soundbox)! */
  bodyIr?: Float32Array<ArrayBuffer> | null;
  bodyIrSig?: string;
}

export interface ColliderContactProps {
  modulusPa: number;
  poisson: number;
  radiusM: number;
  massKg: number;
  brightness: number;
  qualityQ: number;
}

export interface TwoBodyImpactOptions {
  impulseNs: number;
  strikerNode?: SceneNode | null;
  selfGeomName?: string;
  strikerGeomName?: string;
  localPoint?: [number, number, number];
  isPluck?: boolean;
}

/**
 * Collects the solid geoms that participate in structural acoustics on `node`,
 * including jointless welded child bodies (e.g. `cradle_bob_body_*` under
 * `cradle_*` in Newton's Cradle) while skipping non-colliding `contype: 0`
 * suspension strings/rods whenever colliding geoms exist.
 */
function collectAcousticSubtree(node: SceneNode): { geoms: SceneGeom[]; materialHost: SceneNode } {
  const colliding: { geom: SceneGeom; host: SceneNode }[] = [];
  const allSolid: { geom: SceneGeom; host: SceneNode }[] = [];

  const visit = (n: SceneNode, isRoot: boolean) => {
    if (!isRoot && ((n.joints?.length ?? 0) > 0 || n.simulation || n.acousticString)) return;
    for (const g of n.geoms ?? []) {
      if (g.csgDerived || g.csg === 'difference' || g.role === 'visual' || g.type === 'plane') continue;
      allSolid.push({ geom: g, host: n });
      const disabled = g.contype === 0 && g.conaffinity === 0;
      if (!disabled) colliding.push({ geom: g, host: n });
    }
    for (const ch of n.children ?? []) visit(ch, false);
  };
  visit(node, true);

  const chosen = colliding.length > 0 ? colliding : allSolid;
  const materialHost =
    chosen.find((c) => c.host.deformMaterial || c.host.density !== undefined)?.host ??
    chosen[0]?.host ??
    node;
  return {
    geoms: chosen.map((c) => c.geom),
    materialHost,
  };
}

const MATERIAL_Q_BY_ID: Record<string, { q: number; brightness: number }> = {
  steel: { q: 950, brightness: 0.9 },
  softMetal: { q: 780, brightness: 0.82 },
  glass: { q: 620, brightness: 0.95 },
  ceramic: { q: 480, brightness: 0.88 },
  hardwood: { q: 165, brightness: 0.52 },
  softwood: { q: 105, brightness: 0.44 },
  stone: { q: 110, brightness: 0.65 },
  plastic: { q: 42, brightness: 0.36 },
  pasta: { q: 55, brightness: 0.58 },
};

export function inferAcousticMaterial(node: SceneNode): AcousticMaterialProps {
  const { geoms, materialHost } = collectAcousticSubtree(node);
  const dm = deformMaterial(node.deformMaterial ?? materialHost.deformMaterial);
  if (dm) {
    const qInfo = MATERIAL_Q_BY_ID[dm.id] ?? { q: 80, brightness: 0.5 };
    return {
      label: dm.label,
      density: node.density ?? materialHost.density ?? dm.density,
      modulusGPa: dm.strength.modulusGPa,
      qualityQ: qInfo.q,
      brightness: qInfo.brightness,
    };
  }
  const firstSolid = geoms[0];
  let impliedRho: number | undefined;
  if (firstSolid && typeof firstSolid.mass === 'number' && firstSolid.mass > 0) {
    const vol = geomVolume(firstSolid);
    if (vol > 1e-9) impliedRho = Math.min(20000, firstSolid.mass / vol);
  }
  const stiffContact = (firstSolid?.solref?.[0] ?? 0) <= -3500;
  const rho = node.density ?? materialHost.density ?? firstSolid?.density ?? impliedRho ?? (stiffContact ? 7800 : 1150);
  if (node.hardwarePart || materialHost.hardwarePart || rho >= 5500) {
    return { label: 'Steel', density: Math.min(8500, Math.max(7500, rho)), modulusGPa: 200, qualityQ: 920, brightness: 0.94 };
  }
  if (rho >= 2550) {
    return { label: 'Aluminium / Alloy', density: rho, modulusGPa: 69, qualityQ: 760, brightness: 0.84 };
  }
  if (rho >= 2100) {
    return { label: 'Glass / Ceramic', density: rho, modulusGPa: 70, qualityQ: 540, brightness: 0.92 };
  }
  if (rho >= 550 && rho <= 920) {
    return { label: 'Hardwood', density: rho, modulusGPa: 12.5, qualityQ: 165, brightness: 0.52 };
  }
  if (rho < 550) {
    return { label: 'Softwood', density: rho, modulusGPa: 9.0, qualityQ: 105, brightness: 0.44 };
  }
  if (stiffContact) {
    return { label: 'Hard Acrylic / Phenolic', density: rho, modulusGPa: 6.5, qualityQ: 120, brightness: 0.78 };
  }
  return { label: 'Polymer', density: rho, modulusGPa: 2.8, qualityQ: 45, brightness: 0.36 };
}

/**
 * Extracts physical Hertzian contact compliance (E, ν, local contact radius R, mass)
 * of the specific geom on `node` that participated in an impact!
 */
export function inferColliderContactProps(
  node: SceneNode | null | undefined,
  geomName?: string,
): ColliderContactProps {
  // Collision against world / floor plane: rigid heavy mineral/steel boundary
  if (!node) {
    return {
      modulusPa: 65e9,
      poisson: 0.25,
      radiusM: 10.0,
      massKg: 1e6,
      brightness: 0.62,
      qualityQ: 120,
    };
  }

  const mat = inferAcousticMaterial(node);
  const { geoms } = collectAcousticSubtree(node);
  const hitGeom = (geomName
    ? geoms.find((g) => g.name === geomName) ?? (node.geoms ?? []).find((g) => g.name === geomName)
    : undefined) ?? geoms[0];

  let modulusGPa = mat.modulusGPa;
  let brightness = mat.brightness;

  // Spherical/capsule polymer mallet heads (rubber/yarn mallets) have elastomeric surface compliance (~0.18 GPa)
  // unless the user explicitly changed `node.deformMaterial` to steel/softMetal/glass/ceramic/hardwood!
  const matId = node.deformMaterial;
  const isRoundBeaterHead = hitGeom && (hitGeom.type === 'sphere' || hitGeom.type === 'capsule');
  if (isRoundBeaterHead && (matId === 'plastic' || (!matId && (hitGeom.density ?? 1200) < 2100 && (hitGeom.density ?? 1200) > 950))) {
    modulusGPa = 0.18;
    brightness = 0.22;
  } else if (!matId && hitGeom?.density) {
    // Respect per-geom density when node has no deformMaterial override (e.g. brass/steel vs wood geom)
    if (hitGeom.density >= 7000) {
      modulusGPa = 180;
      brightness = 0.90;
    } else if (hitGeom.density >= 2500) {
      modulusGPa = 69;
      brightness = 0.82;
    } else if (hitGeom.density >= 550 && hitGeom.density <= 950) {
      modulusGPa = 12.5;
      brightness = 0.52;
    }
  }

  // Honor explicit MuJoCo contact softness (`solref[0] > 0.012` = compliant rubbery contact)
  const solTime = hitGeom?.solref?.[0];
  if (typeof solTime === 'number' && solTime > 0.012) {
    const softScale = Math.pow(0.010 / solTime, 2);
    modulusGPa = Math.max(0.008, modulusGPa * softScale);
    brightness *= Math.max(0.25, Math.sqrt(softScale));
  }

  let radiusM = 0.018;
  if (hitGeom) {
    if (hitGeom.type === 'sphere' || hitGeom.type === 'capsule' || hitGeom.type === 'cylinder') {
      radiusM = Math.max(0.0015, hitGeom.size[0] ?? 0.012);
    } else if (hitGeom.type === 'ellipsoid') {
      const rx = hitGeom.size[0] ?? 0.015;
      const ry = hitGeom.size[1] ?? rx;
      const rz = hitGeom.size[2] ?? rx;
      radiusM = Math.max(0.002, Math.cbrt(rx * ry * rz));
    } else {
      const v = Math.max(1e-9, geomVolume(hitGeom));
      radiusM = Math.max(0.003, 0.5 * Math.cbrt(v));
    }
  }

  let totalVol = 0;
  for (const g of geoms) totalVol += Math.max(0, geomVolume(g));
  const massKg = Math.max(0.002, (totalVol > 1e-9 ? totalVol : 4e-5) * mat.density);

  return {
    modulusPa: Math.max(5e6, modulusGPa * 1e9),
    poisson: 0.30,
    radiusM,
    massKg,
    brightness,
    qualityQ: mat.qualityQ,
  };
}

/** Evaluates Legendre polynomials P_0..P_{N-1} and second derivatives d²P_k/dξ² at ξ in [-1, 1]. */
function legendreBasis(xi: number, nBasis: number): { p: number[]; d2p: number[] } {
  const p = new Array<number>(nBasis).fill(0);
  const dp = new Array<number>(nBasis).fill(0);
  const d2p = new Array<number>(nBasis).fill(0);
  p[0] = 1;
  if (nBasis > 1) {
    p[1] = xi;
    dp[1] = 1;
  }
  for (let k = 1; k + 1 < nBasis; k++) {
    p[k + 1] = ((2 * k + 1) * xi * p[k] - k * p[k - 1]) / (k + 1);
    dp[k + 1] = ((2 * k + 1) * (p[k] + xi * dp[k]) - k * dp[k - 1]) / (k + 1);
    d2p[k + 1] = ((2 * k + 1) * (2 * dp[k] + xi * d2p[k]) - k * d2p[k - 1]) / (k + 1);
  }
  return { p, d2p };
}

function jacobiEigenvalues(aIn: number[][]): number[] {
  const n = aIn.length;
  const A = aIn.map((row) => row.slice());
  for (let sweep = 0; sweep < 45; sweep++) {
    let maxOff = 0;
    let p = 0;
    let q = 1;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const v = Math.abs(A[i][j]);
        if (v > maxOff) {
          maxOff = v;
          p = i;
          q = j;
        }
      }
    }
    if (maxOff < 1e-13) break;
    const diff = A[q][q] - A[p][p];
    const t = Math.abs(A[p][q]) < Math.abs(diff) * 1e-18
      ? A[p][q] / diff
      : (() => {
          const phi = diff / (2 * A[p][q]);
          return (1 / (Math.abs(phi) + Math.sqrt(phi * phi + 1))) * (phi < 0 ? -1 : 1);
        })();
    const c = 1 / Math.sqrt(1 + t * t);
    const s = t * c;
    const tau = s / (1 + c);
    const apq = A[p][q];
    A[p][q] = 0;
    A[q][p] = 0;
    A[p][p] -= t * apq;
    A[q][q] += t * apq;
    for (let k = 0; k < n; k++) {
      if (k === p || k === q) continue;
      const akp = A[k][p];
      const akq = A[k][q];
      A[k][p] = A[p][k] = akp - s * (akq + tau * akp);
      A[k][q] = A[q][k] = akq + s * (akp - tau * akq);
    }
  }
  return A.map((row, i) => row[i]).sort((x, y) => x - y);
}

/**
 * Classical 1D Euler–Bernoulli variational free-free flexural solver for a bar
 * with thickness profile `thicknessAtX(x)`.
 */
export function solveVariableBeamModes(
  lengthM: number,
  modulusPa: number,
  densityKgM3: number,
  thicknessAtX: (x: number) => number,
): [number, number, number] {
  const nBasis = 10;
  const nQuad = 64;
  const K = Array.from({ length: nBasis }, () => new Array<number>(nBasis).fill(0));
  const M = Array.from({ length: nBasis }, () => new Array<number>(nBasis).fill(0));
  const halfL = lengthM * 0.5;
  const invHalfL4 = 1 / Math.pow(halfL, 4);

  for (let q = 0; q < nQuad; q++) {
    const xi = -1 + ((q + 0.5) * 2) / nQuad;
    const dxi = 2 / nQuad;
    const x = xi * halfL;
    const h = Math.max(1e-4, thicknessAtX(x));
    const eiPerWidth = (modulusPa * h * h * h) / 12;
    const mPerWidth = densityKgM3 * h;
    const { p, d2p } = legendreBasis(xi, nBasis);
    const wK = eiPerWidth * invHalfL4 * halfL * dxi;
    const wM = mPerWidth * halfL * dxi;
    for (let i = 0; i < nBasis; i++) {
      for (let j = i; j < nBasis; j++) {
        K[i][j] += wK * d2p[i] * d2p[j];
        M[i][j] += wM * p[i] * p[j];
      }
    }
  }
  for (let i = 0; i < nBasis; i++) {
    for (let j = 0; j < i; j++) {
      K[i][j] = K[j][i];
      M[i][j] = M[j][i];
    }
  }

  const L = Array.from({ length: nBasis }, () => new Array<number>(nBasis).fill(0));
  for (let i = 0; i < nBasis; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = M[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) L[i][i] = Math.sqrt(Math.max(1e-24, sum));
      else L[i][j] = sum / L[j][j];
    }
  }
  const Linv = Array.from({ length: nBasis }, () => new Array<number>(nBasis).fill(0));
  for (let i = 0; i < nBasis; i++) {
    Linv[i][i] = 1 / L[i][i];
    for (let j = 0; j < i; j++) {
      let sum = 0;
      for (let k = j; k < i; k++) sum += L[i][k] * Linv[k][j];
      Linv[i][j] = -sum / L[i][i];
    }
  }
  const tmp = Array.from({ length: nBasis }, () => new Array<number>(nBasis).fill(0));
  for (let i = 0; i < nBasis; i++) {
    for (let j = 0; j < nBasis; j++) {
      let s = 0;
      for (let k = 0; k <= i; k++) s += Linv[i][k] * K[k][j];
      tmp[i][j] = s;
    }
  }
  const C = Array.from({ length: nBasis }, () => new Array<number>(nBasis).fill(0));
  for (let i = 0; i < nBasis; i++) {
    for (let j = i; j < nBasis; j++) {
      let s = 0;
      for (let k = 0; k <= j; k++) s += tmp[i][k] * Linv[j][k];
      C[i][j] = C[j][i] = s;
    }
  }

  const eigOmegaSq = jacobiEigenvalues(C);
  const elasticHz = eigOmegaSq
    .slice(2)
    .map((w2) => Math.sqrt(Math.max(0, w2)) / (2 * Math.PI));

  const f1 = Math.max(15, elasticHz[0] ?? 220);
  const f2 = Math.max(f1 * 1.5, elasticHz[1] ?? f1 * 2.756);
  const f3 = Math.max(f2 * 1.2, elasticHz[2] ?? f1 * 5.404);
  return [f1, f2, f3];
}

/**
 * Computes ANY 3D solid's vibration modes directly from its post-CSG / post-Sculpt
 * 3D cross-sectional area A(s), bending inertia I(s), shell wall thickness,
 * internal Helmholtz cavity ports, and material properties — ZERO hardcoded pitch overrides!
 */
export function estimateBodyModes(node: SceneNode, includeIr = false): BodyModalProfile {
  const mat = inferAcousticMaterial(node);
  const E = mat.modulusGPa * 1e9;
  const rho = Math.max(50, mat.density);
  const cLong = Math.sqrt(E / rho);

  const section = analyze3DSolidCrossSections(node);
  const [hMin, bMid, lMax] = section.dimsSortedAsc;
  const [, , lenAxis] = section.axisOrderAsc;
  const { geoms } = collectAcousticSubtree(node);
  const primaryGeom = geoms[0];

  // Detect non-uniform cross-section (arches, sculpted bumps, holes, tapers)
  let minInteriorA = Infinity;
  let maxInteriorA = 0;
  for (let q = 6; q < section.areaProfile.length - 6; q++) {
    const a = section.areaProfile[q];
    if (a > 1e-11) {
      if (a < minInteriorA) minInteriorA = a;
      if (a > maxInteriorA) maxInteriorA = a;
    }
  }
  const sectionVariation = minInteriorA < Infinity && minInteriorA > 0 ? maxInteriorA / minInteriorA : 1;

  let regime: BodyModalProfile['regime'];
  let freqs: number[];
  let gains: number[];
  let rawModeQs: number[] | undefined;
  let modeVectors: number[][] | undefined;

  const isCylOrTubeLike =
    node.isTube ||
    primaryGeom?.type === 'cylinder' ||
    primaryGeom?.type === 'capsule';

  let collidingChildPanels = 0;
  for (const ch of node.children ?? []) {
    if ((ch.joints?.length ?? 0) > 0 || ch.acousticString || ch.simulation) continue;
    if ((ch.geoms ?? []).some((g) => !g.csgDerived && g.csg !== 'difference' && g.role !== 'visual' && !(g.contype === 0 && g.conaffinity === 0))) {
      collidingChildPanels++;
    }
  }
  const isJoinedPanelBox = typeof node.tunedPitchHz !== 'number' && collidingChildPanels >= 2;

  if (lMax / bMid >= 1.85 && lMax / hMin >= 2.2) {
    // Slender / medium 3D beam, arched bar, rod, or chime tube:
    // Exact Rayleigh–Ritz eigenproblem over the measured 48-slice 3D A(s) and I_thick(s)!
    const beamEig = solveGeneralSectionBeamModes(
      lMax,
      E,
      rho,
      section.areaProfile,
      section.inertiaThickProfile,
      true,
    );
    freqs = beamEig.frequenciesHz.slice(0, 4);
    modeVectors = beamEig.modeVectors.slice(0, 4);

    if (isCylOrTubeLike && sectionVariation < 1.18) {
      regime = 'tube';
      gains = [1.0, 0.58, 0.32, 0.16];
    } else if (sectionVariation >= 1.14) {
      regime = 'arched_bar';
      gains = [1.0, 0.36, 0.15, 0.07];
    } else {
      regime = 'bar';
      gains = [1.0, 0.50, 0.25, 0.12];
    }
  } else if (isJoinedPanelBox) {
    // Clamped/joined rectangular box panels (shallow drawers, cabinets, crates): supported-edge plate bending
    // (crisp 300–1100 Hz wood knock rather than low bell/plate booming) with fast seam-friction damping!
    regime = 'plate';
    const hWall = Math.max(0.004, section.meanWallThicknessM);
    const sPanel = Math.max(0.055, Math.min(bMid * 0.72, lMax * 0.45));
    const fPanel1 = Math.max(260, Math.min(4500, 0.48 * (hWall / Math.max(0.0025, sPanel * sPanel)) * cLong));
    freqs = [fPanel1, fPanel1 * 1.58, fPanel1 * 2.34, fPanel1 * 3.25];
    gains = [0.68, 1.0, 0.58, 0.30];
    const seamQ = Math.min(mat.qualityQ, 18);
    rawModeQs = [seamQ, seamQ * 0.9, seamQ * 0.8, seamQ * 0.7];
  } else if (bMid / hMin >= 3.0 && section.hollowFraction < 0.22) {
    // 2D Kirchhoff–Rayleigh plate / disk / cymbal: couple longitudinal & transverse 3D section modes!
    regime = 'plate';
    const nu = 0.30;
    const plateStiff = 1 / Math.sqrt(1 - nu * nu);
    const eigLong = solveGeneralSectionBeamModes(lMax, E, rho, section.areaProfile, section.inertiaThickProfile, true);
    const eigTrans = solveGeneralSectionBeamModes(bMid, E, rho, section.transverseAreaProfile, section.transverseInertiaProfile, true);
    const fx1 = (eigLong.frequenciesHz[0] ?? 220) * plateStiff * 0.46;
    const fy1 = (eigTrans.frequenciesHz[0] ?? 310) * plateStiff * 0.46;
    // (1,1) torsional saddle mode, (2,0) long mode, (0,2) cross mode, (2,2) ring mode
    const f11 = 0.82 * Math.sqrt(fx1 * fy1);
    const f22 = Math.hypot(fx1, fy1);
    freqs = [f11, fx1, fy1, f22].sort((a, b) => a - b);
    modeVectors = eigLong.modeVectors.slice(0, 4);
    gains = [1.0, 0.64, 0.40, 0.24];
  } else if (section.hollowFraction >= 0.18) {
    // 3D Hollow Shell / Bell / Cup / Cajón / Soundbox!
    // Vibrates via actual measured 3D wall thickness `meanWallThicknessM` AND any Helmholtz air cavity!
    regime = 'plate';
    const hWall = Math.max(0.001, section.meanWallThicknessM);
    const cav = analyze3DCavityAndPorts(node);
    const rShell = 0.25 * (lMax + bMid);
    // Rayleigh flexural shell / bell ring fundamental: f ∝ (h_wall / R_shell²) * c_L
    const fShell1 = Math.max(55, Math.min(6500, 0.21 * (hWall / Math.max(0.0016, rShell * rShell)) * cLong));
    const aspect = lMax / Math.max(1e-4, bMid);
    const shellModes = [
      fShell1,
      fShell1 * (1.42 + 0.18 * Math.min(2, aspect)),
      fShell1 * 2.28,
      fShell1 * 3.35,
    ];
    gains = [1.0, 0.56, 0.30, 0.16];

    // Narrow-ported acoustic Helmholtz cavity (e.g. woodblock, udu pot, cajón, soundbox — NOT wide open-front cups/boxes)!
    // Air Helmholtz modes radiate with low acoustic air Q (~11), never solid metal/wood bar Q!
    if (cav.hasHollowCavity && !cav.isOpenCupOrShell && cav.totalConductanceM > 0 && cav.cavityVolumeM3 > 1e-6) {
      const fHelmholtz = (343 / (2 * Math.PI)) * Math.sqrt(cav.totalConductanceM / cav.cavityVolumeM3);
      if (fHelmholtz >= 35 && fHelmholtz <= 2400) {
        freqs = [fHelmholtz, ...shellModes.slice(0, 3)];
        gains = [0.88, 1.0, 0.52, 0.26];
        rawModeQs = [11, mat.qualityQ, mat.qualityQ, mat.qualityQ];
      } else {
        freqs = shellModes;
      }
    } else {
      freqs = shellModes;
    }
  } else {
    // Compact 3D solid block / sphere / sculpted stone or metal piece:
    regime = 'block';
    if (section.isPureSolidSphere && mat.modulusGPa >= 50 && lMax <= 0.085) {
      // Solid stiff metal/glass sphere (< 85 mm): spheroidal Lamb mode (0.42 * c_L / d > 20 kHz) is ultrasonic!
      const fLamb = (0.42 * cLong) / Math.max(0.004, lMax);
      freqs = [fLamb, fLamb * 1.45, fLamb * 1.92];
      gains = [1.0, 0.45, 0.22];
    } else {
      // General 3D solid block / sculpted shape: blend 3D cross-sectional Timoshenko eigenvalues with flexural block coupling
      const eig3D = solveGeneralSectionBeamModes(
        lMax,
        E,
        rho,
        section.areaProfile,
        section.inertiaThickProfile,
        true,
      );
      modeVectors = eig3D.modeVectors.slice(0, 4);
      // Free 3D blocks laid on/struck against surfaces couple flexural wall/body modes scaled by actual section inertia
      const rg = Math.sqrt(
        Math.max(1e-14, section.inertiaThickProfile[24] || (bMid * hMin * hMin * hMin) / 12) /
          Math.max(1e-9, section.areaProfile[24] || bMid * hMin),
      );
      const slenderness = lMax / Math.max(1e-4, rg);
      // Smooth physical transition from slender Timoshenko bar (factor = 1) to compact 3D block (coupled surface compliance)
      const blockCompliance = slenderness >= 10
        ? 1.0
        : 0.14 + 0.86 * Math.pow(Math.max(1, slenderness) / 10, 1.35);
      freqs = eig3D.frequenciesHz.slice(0, 4).map((f) => Math.max(45, f * blockCompliance));
      gains = [1.0, 0.46, 0.22, 0.10];
    }
  }

  const f0 = Math.max(15, freqs[0] ?? 220);
  const f1 = freqs[1] ?? f0 * 2.756;
  const overtoneRatio = +(f1 / f0).toFixed(3);

  // Reference single-body Hertzian contact duration at 1 m/s against an identical solid:
  const nu = 0.30;
  const rEff = 0.5 * Math.cbrt(Math.max(1e-9, section.solidVolumeM3 * 6 / Math.PI));
  const idealHertzTau = 2.87 * Math.pow((rho * (1 - nu * nu)) / E, 0.4) * rEff;
  const contactDurationSec = Math.max(0.00038, Math.min(0.0055, 5.2 * idealHertzTau));

  const massKg = Math.max(0.002, section.solidVolumeM3 * rho);
  // Effective acoustic dipole radiating width is governed by MEAN cross-sectional width along the span
  // (a 4 mm stick with a small ball on the end has tiny mean width along its length, whereas a 38 mm bar moves air across its whole span!)
  const meanArea = section.solidVolumeM3 / Math.max(0.004, lMax);
  const meanWidthM = Math.min(bMid, Math.max(0.002, meanArea / Math.max(0.001, section.meanWallThicknessM * 0.85)));
  const radiatingWidthM = section.hollowFraction >= 0.18 ? bMid : meanWidthM;

  const modes = buildWeightedModalVoices(freqs, gains, mat.qualityQ, contactDurationSec, modeVectors, undefined, rawModeQs);
  const vibroIr = includeIr ? simulate3DVibroAcousticIR(node, mat) : undefined;

  return {
    fundamentalHz: +f0.toFixed(2),
    overtoneRatio,
    regime,
    material: mat,
    contactDurationSec: +contactDurationSec.toExponential(4),
    modes,
    rawFreqsHz: freqs,
    rawBaseGains: gains,
    ...(rawModeQs ? { rawModeQs } : {}),
    modeVectors,
    lenAxis,
    lenBounds: section.lenBounds,
    massKg,
    radiatingWidthM,
    ...(vibroIr !== undefined ? { bodyIr: vibroIr?.ir ?? null, bodyIrSig: vibroIr?.signature ?? '' } : {}),
  };
}

function buildWeightedModalVoices(
  freqs: number[],
  baseGains: number[],
  qualityQ: number,
  tauC: number,
  modeVectors?: number[][],
  strikeXi?: number,
  modeQs?: number[],
): ModalVoice[] {
  const modes: ModalVoice[] = [];
  for (let idx = 0; idx < freqs.length; idx++) {
    const rawHz = freqs[idx];
    if (rawHz < 24 || rawHz > 18000) continue;

    // 1. Fourier spectrum of the half-sine Hertzian contact force pulse:
    //    |F(f)| = |cos(π f τ_c) / (1 - (2 f τ_c)²)|
    //    For f * τ_c > 1.0 (soft mallet on upper partials), rolls off cleanly as ~1 / (4 f² τ_c²)!
    const x = rawHz * tauC;
    let pulseExcitation: number;
    if (Math.abs(x - 0.5) < 1e-3) {
      pulseExcitation = Math.PI / 4;
    } else if (x <= 1.2) {
      pulseExcitation = Math.abs(Math.cos(Math.PI * x) / (1 - 4 * x * x));
    } else {
      // Smooth envelope of Hertzian rolloff above first lobe (avoids comb zero dropouts while keeping 1/x² rolloff)
      pulseExcitation = 0.72 / (4 * x * x - 1);
    }

    // 2. Spatial modal participation |ψ_m(ξ_hit)| at the actual collision coordinate along the body!
    //    Striking near the center (ξ ≈ 0) strongly excites symmetric modes (m=1, 3) and naturally suppresses
    //    antisymmetric Mode 2 (which has a node at ξ = 0!), while striking near an end excites all overtones!
    let spatialWeight = 1.0;
    if (strikeXi !== undefined && modeVectors && modeVectors[idx]) {
      spatialWeight = 0.10 + 0.95 * evaluateNormalizedModeShape(modeVectors[idx], strikeXi);
    }

    const weightedGain = (baseGains[idx] ?? 0.12) * Math.min(1.25, pulseExcitation * 1.08) * spatialWeight;
    if (weightedGain < 0.006) continue;

    // Zener thermoelastic + acoustic radiation damping increases with mode order
    const baseModeQ = modeQs?.[idx] ?? qualityQ;
    const modeQ = baseModeQ / (1 + (modeQs ? 1.2 : 3.8) * idx * idx);
    const rawDecay = (modeQ / (Math.PI * rawHz)) * 2.8;
    const decaySec = Math.max(0.016, Math.min(4.2, rawDecay));

    modes.push({
      freqHz: +rawHz.toFixed(2),
      gain: +weightedGain.toFixed(3),
      decaySec: +decaySec.toFixed(4),
    });
  }
  return modes;
}

/**
 * Computes exact Two-Body Hertzian Contact Duration τ_c(A, B, J), combined transient
 * brightness, dipole width radiation scaling, and strike-position-weighted modal voices
 * for `targetNode` struck by `strikerNode`!
 */
export function resolveTwoBodyImpact(
  targetProfile: BodyModalProfile,
  targetNode: SceneNode,
  opts: TwoBodyImpactOptions,
): {
  tauC: number;
  effectiveBrightness: number;
  radiationScale: number;
  voices: ModalVoice[];
  bodyIr?: Float32Array<ArrayBuffer> | null;
} {
  const propsA = inferColliderContactProps(targetNode, opts.selfGeomName);
  const propsB = inferColliderContactProps(opts.strikerNode, opts.strikerGeomName);

  // Two-body reduced Young's modulus: 1/E* = (1 - ν_A²)/E_A + (1 - ν_B²)/E_B
  const invEStar =
    (1 - propsA.poisson * propsA.poisson) / propsA.modulusPa +
    (1 - propsB.poisson * propsB.poisson) / propsB.modulusPa;
  const eStar = 1 / Math.max(1e-14, invEStar);

  // Two-body reduced curvature radius: 1/R* = 1/R_A + 1/R_B
  const rStar = 1 / (1 / Math.max(0.001, propsA.radiusM) + 1 / Math.max(0.001, propsB.radiusM));

  // Two-body reduced mass: m* = (m_A * m_B) / (m_A + m_B)
  const mStar = (propsA.massKg * propsB.massKg) / Math.max(1e-6, propsA.massKg + propsB.massKg);

  // Relative impact velocity estimated from physical impulse J = (1 + e) m* v_rel
  const vRel = Math.max(0.06, Math.min(12.0, opts.impulseNs / Math.max(0.0015, 1.55 * mStar)));

  // Landau–Lifshitz / Rayleigh–Hertz two-body elastic contact duration:
  //   τ_c = 2.87 * γ_macro * (m*² / (R* * E*² * v_rel))^(1/5)
  const idealTau = 2.87 * Math.pow((mStar * mStar) / (rStar * eStar * eStar * vRel), 0.2);
  const tauC = Math.max(0.00032, Math.min(0.0065, 4.1 * idealTau));

  // Combined surface transient brightness is limited by the SOFTER of the two colliding surfaces!
  const effectiveBrightness = Math.min(
    propsA.brightness,
    propsB.brightness,
    0.5 * (propsA.brightness + propsB.brightness),
  );

  // Map body-local hit point onto normalized principal coordinate ξ_hit in [-1, 1]
  let strikeXi: number | undefined;
  if (opts.localPoint && targetProfile.lenAxis !== undefined && targetProfile.lenBounds) {
    const [sLo, sHi] = targetProfile.lenBounds;
    const mid = 0.5 * (sLo + sHi);
    const half = Math.max(1e-4, 0.5 * (sHi - sLo));
    strikeXi = Math.max(-1, Math.min(1, (opts.localPoint[targetProfile.lenAxis] - mid) / half));
  }

  // Acoustic dipole radiation efficiency: when width w << acoustic wavelength, dipole cancellation
  // scales radiated pressure steeply with (w / w_ref)^2 (thin 5 mm mallet shafts barely radiate air modes,
  // while 16 mm chimes, 38 mm bars, and 160 mm soundboxes project strongly!).
  const widthM = targetProfile.radiatingWidthM ?? 0.03;
  const radiationScale = opts.isPluck
    ? 1.15
    : widthM >= 0.015
      ? Math.min(1.22, 0.82 + 4.8 * Math.min(0.08, widthM))
      : Math.max(0.03, Math.pow(widthM / 0.015, 2.2) * 0.82);

  const voices = targetProfile.rawFreqsHz && targetProfile.rawBaseGains && !opts.isPluck
    ? buildWeightedModalVoices(
        targetProfile.rawFreqsHz,
        targetProfile.rawBaseGains,
        targetProfile.material.qualityQ,
        tauC,
        targetProfile.modeVectors,
        strikeXi,
        targetProfile.rawModeQs,
      )
    : targetProfile.modes;

  // Cached 3D Vibro-Acoustic FIR for rigid-body impacts (prewarmed once per unique 3D solid geometry + material)
  const localIr = !opts.isPluck
    ? targetProfile.bodyIr !== undefined
      ? targetProfile.bodyIr
      : (simulate3DVibroAcousticIR(targetNode, targetProfile.material)?.ir ?? null)
    : targetProfile.bodyIr;

  return {
    tauC,
    effectiveBrightness,
    radiationScale,
    voices,
    bodyIr: localIr ?? null,
  };
}

// ---------------------------------------------------------------------------
// Zero-sample WebAudio synthesiser (routed through shared Studio Chamber Bus!)
// ---------------------------------------------------------------------------

type WindowWithAudioCtx = Window & {
  __physboxSharedAudioCtx?: AudioContext;
  __physboxGestureHookInstalled?: boolean;
  __physboxReverbSubUnsub?: () => void;
};

let sharedAudioCtx: AudioContext | null = null;
let activeVoices = 0;
const MAX_ACTIVE_VOICES = 112;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const win = window as WindowWithAudioCtx;
  if (!sharedAudioCtx && win.__physboxSharedAudioCtx && win.__physboxSharedAudioCtx.state !== 'closed') {
    sharedAudioCtx = win.__physboxSharedAudioCtx;
  }
  const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedAudioCtx) {
    sharedAudioCtx = new Ctor();
    win.__physboxSharedAudioCtx = sharedAudioCtx;
  }
  getOrInitModalWorklet(sharedAudioCtx);
  if (sharedAudioCtx.state === 'suspended') {
    void sharedAudioCtx.resume().catch(() => {});
  }
  return sharedAudioCtx;
}

export function unlockAudioContext(): AudioContext | null {
  const ctx = getAudioContext();
  if (!ctx) return null;
  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => {});
  }
  try {
    const silent = ctx.createBuffer(1, 1, ctx.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = silent;
    src.connect(ctx.destination);
    src.start(0);
  } catch {
    // Ignore in headless/mock contexts
  }
  return ctx;
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  const win = window as WindowWithAudioCtx;
  if (!win.__physboxGestureHookInstalled) {
    win.__physboxGestureHookInstalled = true;
    const onGesture = () => {
      if (sharedAudioCtx && sharedAudioCtx.state === 'suspended') {
        void sharedAudioCtx.resume().catch(() => {});
      } else if (win.__physboxSharedAudioCtx && win.__physboxSharedAudioCtx.state === 'suspended') {
        void win.__physboxSharedAudioCtx.resume().catch(() => {});
      }
    };
    window.addEventListener('pointerdown', onGesture, { passive: true });
    window.addEventListener('keydown', onGesture, { passive: true });
  }
  win.__physboxReverbSubUnsub?.();
  let prevReverb = useSoundStore.getState().reverbEnabled;
  win.__physboxReverbSubUnsub = useSoundStore.subscribe((state) => {
    if (state.reverbEnabled !== prevReverb) {
      prevReverb = state.reverbEnabled;
      const ctx = sharedAudioCtx ?? win.__physboxSharedAudioCtx ?? null;
      setStudioReverbEnabled(ctx, state.reverbEnabled);
    }
  });
}

/**
 * Synthesises a physical modal impact or string pluck through the shared
 * studio-chamber ConvolverNode bus, honoring two-body Hertzian contact duration
 * `tauC`, surface `brightness`, and strike-position `voices`.
 */
export function playModalImpact(
  profile: BodyModalProfile,
  impulseNs: number,
  isPluck = false,
  twoBodyOverride?: {
    tauC: number;
    effectiveBrightness: number;
    radiationScale: number;
    voices: ModalVoice[];
    bodyIr?: Float32Array<ArrayBuffer> | null;
  },
): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  const radScale = twoBodyOverride?.radiationScale ?? (isPluck ? 1.15 : 1.0);
  // Concert-matched dynamic curve so marimba, metallophone, and lyre sit at the same lush presence as cornet/clarinet
  const baseLevel = isPluck
    ? 0.34 * Math.log10(1 + Math.max(0.0005, impulseNs) * 140)
    : 0.30 * Math.log10(1 + Math.max(0.0005, impulseNs) * 95);
  const level = Math.min(0.56, baseLevel * radScale);
  if (level < 0.004) return;
  if (activeVoices >= MAX_ACTIVE_VOICES) return;

  const vScale = Math.pow(Math.max(0.08, Math.min(6, impulseNs * 1.8)), -0.15);
  const tauC = twoBodyOverride
    ? twoBodyOverride.tauC
    : Math.max(0.00035, Math.min(0.006, profile.contactDurationSec * vScale));
  const brightness = twoBodyOverride ? twoBodyOverride.effectiveBrightness : profile.material.brightness;
  const voices = twoBodyOverride ? twoBodyOverride.voices : profile.modes;
  const activeIr = twoBodyOverride?.bodyIr !== undefined ? twoBodyOverride.bodyIr : profile.bodyIr;

  const outputBus = getSharedAcousticOutputBus(ctx);
  const now = ctx.currentTime;
  const master = ctx.createGain();
  const irConv = activeIr && activeIr.length > 0 ? createResampledConvolver(ctx, activeIr) : null;
  let irWetGain: GainNode | null = null;
  let dryPluckGain: GainNode | null = null;

  if (irConv && isPluck) {
    // Plucked string coupled to a 3D soundbox: route string modes through the simulated 3D soundbox FIR!
    dryPluckGain = ctx.createGain();
    dryPluckGain.gain.setValueAtTime(level * 0.48, now);
    irWetGain = ctx.createGain();
    irWetGain.gain.setValueAtTime(level * 2.15, now);
    master.gain.setValueAtTime(1.0, now);
    master.connect(dryPluckGain);
    dryPluckGain.connect(outputBus);
    master.connect(irConv);
    irConv.connect(irWetGain);
    irWetGain.connect(outputBus);
  } else {
    master.gain.setValueAtTime(level, now);
    master.connect(outputBus);
  }

  // Soft-beater strikes have slightly gentler attack rise (~tauC) vs crisp metal/pluck attacks (~1.2 ms)
  const attackTime = isPluck ? 0.0014 : Math.max(0.0012, Math.min(0.0038, tauC * 1.1));

  let longest = 0.05;
  for (const m of voices) {
    if (activeVoices >= MAX_ACTIVE_VOICES) break;
    activeVoices++;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(m.freqHz, now);

    const dur = Math.min(3.8, m.decaySec);
    if (dur > longest) longest = dur;
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(m.gain, now + attackTime);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    osc.connect(env);
    env.connect(master);
    osc.start(now);
    osc.stop(now + dur + 0.01);
    osc.onended = () => {
      activeVoices = Math.max(0, activeVoices - 1);
      env.disconnect();
    };
  }

  // Koss–Alfredson Hertzian rigid-body acceleration pressure pulse:
  // Bandwidth is governed directly by 1 / τ_c (warm ~400 Hz thump for soft rubber marimba mallets;
  // crisp ~2000 Hz metallic ping for brass/steel beaters or billiard spheres!).
  const totalPulseDur = Math.max(0.012, tauC * 9);
  const sampleCount = Math.max(64, Math.ceil(ctx.sampleRate * totalPulseDur));
  const pulseBuf = ctx.createBuffer(1, sampleCount, ctx.sampleRate);
  const data = pulseBuf.getChannelData(0);
  for (let i = 0; i < sampleCount; i++) {
    const t = i / ctx.sampleRate;
    let sample: number;
    if (t < tauC) {
      const u = (Math.PI * t) / tauC;
      sample = 1.2 * Math.sqrt(Math.max(0, Math.sin(u))) * Math.cos(u);
    } else {
      const dt = (t - tauC) / tauC;
      sample = -0.32 * Math.exp(-dt * 1.2) * Math.cos(1.5 * dt);
    }
    const texEnv = Math.exp(-t / (tauC * 1.8));
    data[i] = sample + 0.04 * brightness * (Math.random() * 2 - 1) * texEnv;
  }
  const pulseSrc = ctx.createBufferSource();
  pulseSrc.buffer = pulseBuf;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  const hertzCutoffHz = Math.max(300, Math.min(4600, (0.82 / tauC) * (0.55 + 0.65 * brightness)));
  lp.frequency.setValueAtTime(hertzCutoffHz, now);
  lp.Q.setValueAtTime(0.75, now);
  const clickGain = ctx.createGain();
  const pulseWeight = voices.length === 0
    ? 1.45
    : isPluck
      ? 0.05 + 0.10 * brightness
      : 0.06 + 0.16 * brightness;
  clickGain.gain.setValueAtTime(level * pulseWeight, now);
  pulseSrc.connect(lp);
  lp.connect(clickGain);
  clickGain.connect(outputBus);

  // For struck rigid/hollow 3D bodies (`!isPluck`), drive the Hertzian collision force pulse directly through
  // the body's simulated 3D Vibro-Acoustic FIR (`irConv`) so hollow shells, birdhouses, wood blocks, and bars
  // radiate their true 85 ms 3D shell + cavity + soundhole transient alongside Rayleigh-Ritz pitch sustain!
  if (irConv && !isPluck) {
    irWetGain = ctx.createGain();
    const irWeight = 0.52 + 0.38 * (1 - Math.min(1, profile.material.qualityQ / 700));
    irWetGain.gain.setValueAtTime(level * irWeight, now);
    lp.connect(irConv);
    irConv.connect(irWetGain);
    irWetGain.connect(outputBus);
    if (longest < 0.12) longest = 0.12;
  }

  pulseSrc.start(now);

  setTimeout(() => {
    master.disconnect();
    clickGain.disconnect();
    try { dryPluckGain?.disconnect(); } catch { /* ignore */ }
    try { irConv?.disconnect(); } catch { /* ignore */ }
    try { irWetGain?.disconnect(); } catch { /* ignore */ }
  }, Math.ceil((longest + 0.12) * 1000));
}

/** Auditions a clean medium mallet tap at the center of `node` in the Inspector. */
export function playModalTap(node: SceneNode): BodyModalProfile {
  const profile = estimateBodyModes(node, true);
  playModalImpact(profile, 0.35);
  return profile;
}

/** Streams active wind/brass bore parameters to the native WebAudio engine. */
export function updateLiveWindVoices(voices: WorkletWindVoicePayload[]): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  postWorkletWindUpdate(ctx, voices);
}

/** Immediately fades out all continuous wind/brass bore voices (on Stop or Mute). */
export function silenceWindVoices(): void {
  postWorkletWindSilence(sharedAudioCtx);
}

/** Streams active bowed-string Helmholtz voices to the native WebAudio engine. */
export function updateLiveBowedVoices(voices: WorkletBowedVoicePayload[]): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  postWorkletBowedUpdate(ctx, voices);
}

/** Immediately fades out all continuous bowed-string voices (on Stop or Mute). */
export function silenceBowedVoices(): void {
  postWorkletBowedSilence(sharedAudioCtx);
}

/** Streams active rotor, wing, windmill, and cloth aeroacoustic voices to the native WebAudio engine. */
export function updateLiveAeroVoices(voices: AeroSynthParams[]): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  postWorkletAeroUpdate(ctx, voices);
}

/** Triggers an impulsive trailing-edge cloth / flag N-wave whip-snap through the shared acoustic bus. */
export function playAeroSnapPulse(snap: SnapSynthParams): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  postWorkletAeroSnap(ctx, snap);
}

/** Immediately fades out all continuous aeroacoustic voices (on Stop or Mute). */
export function silenceAeroVoices(): void {
  postWorkletAeroSilence(sharedAudioCtx);
}

export type { WorkletBowedVoicePayload };
