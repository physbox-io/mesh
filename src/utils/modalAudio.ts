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
import { solveClothSnapPulse, type SnapSynthParams } from './aeroAcoustics';
import { deformMaterial, geomVolume } from './deformMaterials';
import {
  analyze3DCavityAndPorts,
  analyze3DSolidCrossSections,
  evaluateNormalizedModeShape,
  simulate3DVibroAcousticIR,
  solveGeneralSectionBeamModes,
} from './solidAcoustics3D';
import {
  getOrInitModalWorklet,
  getSharedAcousticOutputBus,
  postWorkletAeroSilence,
  postWorkletAeroSnap,
  postWorkletAeroUpdate,
  postWorkletBowedSilence,
  postWorkletBowedUpdate,
  postWorkletFrictionSilence,
  postWorkletFrictionUpdate,
  postWorkletWindSilence,
  postWorkletWindUpdate,
  setStudioReverbEnabled,
  type SpatialAeroSynthParams,
  type SpatialSnapSynthParams,
  type WorkletBowedVoicePayload,
  type WorkletWindVoicePayload,
} from './modalAudioWorklet';
import type { WorkletFrictionVoicePayload } from './contactFrictionAcoustics';
import {
  evaluateTensionedMembrane,
  isMembraneCandidate,
  solveMembraneImpact,
} from './membraneAcoustics';
import {
  solveVonKarmanPlateImpact,
  type NonlinearPlateCrashEnvelope,
} from './nonlinearPlateAcoustics';
import {
  resolveExternalTubeResonator,
  type CoupledTubeResonatorResult,
  type ResonatorLiveKinematics,
} from './resonatorAcoustics';
import type { SpatialAcousticParams } from './spatialAcoustics';
import {
  computePluckPitchDroop,
  resolveStringBetaFromPoint,
  resolveStringLocalEndpoints,
} from './stringAcoustics';
import {
  chokeBodyVoice,
  silenceModalVoices,
  triggerOrMutateModalVoice,
  triggerSympatheticStringPluck,
  type ActiveModalVoiceGroup,
  type CrashShimmerParams,
  type ModalVoiceSpec,
  type SnareRattleParams,
  type TremoloModulationParams,
} from './voiceSympathyPool';

export {
  chokeBodyVoice,
  isMembraneCandidate,
  silenceModalVoices,
  triggerSympatheticStringPluck,
};

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

export type AcousticModalRegime =
  | 'beam'
  | 'plate'
  | 'shell'
  | 'membrane'
  | 'string'
  | 'clack'
  | 'block';

export interface BodyModalProfile {
  /** Optional owning SceneNode id for stateful polyphonic voice pooling & physical choking. */
  nodeId?: string;
  fundamentalHz: number;
  overtoneRatio: number;
  regime: 'bar' | 'arched_bar' | 'tube' | 'plate' | 'block';
  material: AcousticMaterialProps;
  /** Physical single-body reference Hertz contact duration τ_c (s) at 1 m/s impact speed. */
  contactDurationSec: number;
  /** Audible structural modes (< 18 kHz), weighted by reference Hertzian pulse. */
  modes: ModalVoiceSpec[];
  /** Pure un-colored string modes routed through `bodyIr` on plucks to avoid double soundbox filtering. */
  rawStringModes?: ModalVoiceSpec[];
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
  /** Optional unit principal longitudinal direction & origin in body-local Z-up frame (for rotated/`fromto` geoms). */
  principalLenDir?: [number, number, number];
  principalOrigin?: [number, number, number];
  /** Effective solid mass (kg) and radiating width (m) for two-body Hertzian & dipole radiation coupling. */
  massKg?: number;
  radiatingWidthM?: number;
  /** True when the body encloses a 3D hollow air cavity, open cup/shell, or multi-panel soundbox. */
  hasAcousticCavity?: boolean;
  /** Simulated 48 kHz 3D vibro-acoustic impulse response of this hollow soundbox/shell (null on solid cavity-free bars/plates)! */
  bodyIr?: Float32Array<ArrayBuffer> | null;
  bodyIrSig?: string;
  /** Wet 3D Vibro-Acoustic FIR gain calibrated from physical FDTD radiation efficiency. */
  bodyIrGain?: number;
}

export interface ExtractedModalProfile extends Omit<BodyModalProfile, 'regime'> {
  regime: AcousticModalRegime;
  structuralRegime: BodyModalProfile['regime'];
}

export type AnyModalProfile = BodyModalProfile | ExtractedModalProfile;

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
  sceneNodes?: SceneNode[];
  liveKinematics?: ResonatorLiveKinematics;
  stoppedLengthFraction?: number;
}

export interface TwoBodyImpactResult {
  tauC: number;
  effectiveBrightness: number;
  radiationScale: number;
  voices: ModalVoiceSpec[];
  rawIrVoices?: ModalVoiceSpec[];
  bodyIr?: Float32Array<ArrayBuffer> | null;
  bodyIrSig?: string;
  bodyIrGain?: number;
  strikeXi?: number;
  pluckBeta?: number;
  strikerMassKg?: number;
  bodyMassKg?: number;
  snare?: SnareRattleParams;
  crashShimmer?: CrashShimmerParams;
  crashEnvelope?: NonlinearPlateCrashEnvelope | null;
  resonator?: CoupledTubeResonatorResult | null;
  tremolo?: TremoloModulationParams;
}

/**
 * Collects the solid geoms that participate in structural acoustics on `node`,
 * including jointless welded child bodies (e.g. `cradle_bob_body_*` under
 * `cradle_*` in Newton's Cradle) while skipping non-colliding `contype: 0`
 * suspension strings/rods whenever colliding geoms exist.
 */
function collectAcousticSubtree(node: SceneNode): { geoms: SceneGeom[]; materialHost: SceneNode } {
  // Fast zero-wrapper path for leaf nodes (95%+ of bodies)
  if (!node.children || node.children.length === 0) {
    const raw = node.geoms;
    if (!raw || raw.length === 0) return { geoms: [], materialHost: node };
    const colliding: SceneGeom[] = [];
    const allSolid: SceneGeom[] = [];
    for (let i = 0; i < raw.length; i++) {
      const g = raw[i];
      if (g.csgDerived || g.csg === 'difference' || g.role === 'visual' || g.type === 'plane') continue;
      allSolid.push(g);
      if (!(g.contype === 0 && g.conaffinity === 0)) colliding.push(g);
    }
    return {
      geoms: colliding.length > 0 ? colliding : allSolid,
      materialHost: node,
    };
  }

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
  hardwood: { q: 190, brightness: 0.46 },
  softwood: { q: 115, brightness: 0.42 },
  stone: { q: 110, brightness: 0.65 },
  plastic: { q: 42, brightness: 0.36 },
  pasta: { q: 55, brightness: 0.58 },
  rubber: { q: 18, brightness: 0.16 },
};

function inferAcousticMaterialWithSubtree(
  node: SceneNode,
): { mat: AcousticMaterialProps; geoms: SceneGeom[] } {
  const { geoms, materialHost } = collectAcousticSubtree(node);
  const dm = deformMaterial(node.deformMaterial ?? materialHost.deformMaterial);
  if (dm) {
    const qInfo = MATERIAL_Q_BY_ID[dm.id] ?? { q: 80, brightness: 0.5 };
    return {
      geoms,
      mat: {
        label: dm.label,
        density: node.density ?? materialHost.density ?? dm.density,
        modulusGPa: dm.strength.modulusGPa,
        qualityQ: qInfo.q,
        brightness: qInfo.brightness,
      },
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
    return { geoms, mat: { label: 'Steel', density: Math.min(8500, Math.max(7500, rho)), modulusGPa: 200, qualityQ: 920, brightness: 0.94 } };
  }
  if (rho >= 2550) {
    return { geoms, mat: { label: 'Aluminium / Alloy', density: rho, modulusGPa: 69, qualityQ: 760, brightness: 0.84 } };
  }
  if (rho >= 2100) {
    return { geoms, mat: { label: 'Glass / Ceramic', density: rho, modulusGPa: 70, qualityQ: 540, brightness: 0.92 } };
  }
  if (rho >= 550 && rho <= 920) {
    return { geoms, mat: { label: 'Hardwood', density: rho, modulusGPa: 12.5, qualityQ: 190, brightness: 0.46 } };
  }
  if (rho < 550) {
    return { geoms, mat: { label: 'Softwood', density: rho, modulusGPa: 9.0, qualityQ: 115, brightness: 0.42 } };
  }
  if (stiffContact) {
    return { geoms, mat: { label: 'Hard Acrylic / Phenolic', density: rho, modulusGPa: 6.5, qualityQ: 120, brightness: 0.78 } };
  }
  return { geoms, mat: { label: 'Polymer', density: rho, modulusGPa: 2.8, qualityQ: 45, brightness: 0.36 } };
}

export function inferAcousticMaterial(node: SceneNode): AcousticMaterialProps {
  return inferAcousticMaterialWithSubtree(node).mat;
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

  const { mat, geoms } = inferAcousticMaterialWithSubtree(node);
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

  let sumMassKg = 0;
  if (typeof node.mass === 'number' && Number.isFinite(node.mass) && node.mass > 0) {
    sumMassKg = node.mass;
  } else {
    for (const g of geoms) {
      if (typeof g.mass === 'number' && Number.isFinite(g.mass) && g.mass > 0) {
        sumMassKg += g.mass;
      } else {
        const gRho = typeof g.density === 'number' && Number.isFinite(g.density) && g.density > 0 ? g.density : mat.density;
        sumMassKg += Math.max(0, geomVolume(g)) * gRho;
      }
    }
  }
  const massKg = Math.max(0.002, sumMassKg > 1e-6 ? sumMassKg : 4e-5 * mat.density);

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
 * internal Helmholtz/pipe cavity ports, and material properties — ZERO hardcoded pitch overrides!
 */
export function estimateBodyModes(
  node: SceneNode,
  includeIr = false,
  sceneNodes?: SceneNode[],
): BodyModalProfile {
  // Starter #1: Tensioned 2D drum/timpani membrane — ONLY when `node.acousticMembrane` is explicitly authored
  // (NEVER via `isMembraneCandidate(node)`, which would turn flat rectangular rosewood marimba planks into drumheads!).
  if (node.acousticMembrane !== undefined) {
    const memEval = evaluateTensionedMembrane(node, sceneNodes);
    if (memEval) {
      return {
        ...memEval.profile,
        nodeId: node.id,
      };
    }
  }

  const { mat, geoms } = inferAcousticMaterialWithSubtree(node);
  const E = mat.modulusGPa * 1e9;
  const rho = Math.max(50, mat.density);
  const cLong = Math.sqrt(E / rho);

  const section = analyze3DSolidCrossSections(node);
  const [hMin, bMid, lMax] = section.dimsSortedAsc;
  const [, , lenAxis] = section.axisOrderAsc;
  const primaryGeom = geoms[0];
  let cachedCav: ReturnType<typeof analyze3DCavityAndPorts> | null = null;

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
    // 2D Kirchhoff–Rayleigh free plate / disk / cymbal (Leissa NASA SP-160 Table 4.41):
    // `eigLong.frequenciesHz[0]` already incorporates 1/sqrt(12) (lambda_beam = 22.373);
    // scale by Leissa free-plate eigenvalue ratios (lambda_11 = 13.47, lambda_20 = 19.60, lambda_02 = 24.27)
    // and co-sort `modeVectors` alongside `freqs`!
    regime = 'plate';
    const nu = 0.30;
    const plateStiff = 1 / Math.sqrt(1 - nu * nu);
    const eigLong = solveGeneralSectionBeamModes(lMax, E, rho, section.areaProfile, section.inertiaThickProfile, true);
    const eigTrans = solveGeneralSectionBeamModes(bMid, E, rho, section.transverseAreaProfile, section.transverseInertiaProfile, true);
    const fx20 = (eigLong.frequenciesHz[0] ?? 220) * plateStiff * 0.88;
    const fy02 = (eigTrans.frequenciesHz[0] ?? 310) * plateStiff * 0.96;
    const f11 = 0.66 * Math.sqrt(fx20 * fy02);
    const f22 = 1.18 * Math.hypot(fx20, fy02);
    const platePairs: { f: number; v?: number[] }[] = [
      { f: f11, v: eigLong.modeVectors[1] ?? eigLong.modeVectors[0] },
      { f: fx20, v: eigLong.modeVectors[0] },
      { f: fy02, v: eigTrans.modeVectors[0] ?? eigLong.modeVectors[0] },
      { f: f22, v: eigLong.modeVectors[2] ?? eigLong.modeVectors[0] },
    ].sort((a, b) => a.f - b.f);
    freqs = platePairs.map((p) => p.f);
    if (platePairs.every((p) => Array.isArray(p.v))) {
      modeVectors = platePairs.map((p) => p.v!);
    }
    gains = [1.0, 0.64, 0.40, 0.24];
  } else if (section.hollowFraction >= 0.18) {
    // 3D Hollow Shell / Bell / Cup / Cajón / Soundbox / Tube!
    // Vibrates via actual measured 3D wall thickness `meanWallThicknessM` AND any Helmholtz or λ/4 / λ/2 air column!
    regime = 'plate';
    const hWall = Math.max(0.001, section.meanWallThicknessM);
    const cav = analyze3DCavityAndPorts(node);
    cachedCav = cav;
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

    // Narrow-ported Helmholtz cavity or standing-wave λ/4 / λ/2 pipe air column (NOT wide open-front cups/boxes)!
    if (cav.hasHollowCavity && !cav.isOpenCupOrShell && (cav.airResonanceHz || (cav.totalConductanceM > 0 && cav.cavityVolumeM3 > 1e-6))) {
      const fAir = cav.airResonanceHz ?? ((343 / (2 * Math.PI)) * Math.sqrt(cav.totalConductanceM / cav.cavityVolumeM3));
      const airQ = cav.cavityRegime === 'quarter_wave_tube' || cav.cavityRegime === 'half_wave_tube' ? 24 : 11;
      if (fAir >= 35 && fAir <= 2400) {
        freqs = [fAir, ...shellModes.slice(0, 3)];
        gains = [0.88, 1.0, 0.52, 0.26];
        rawModeQs = [airQ, mat.qualityQ, mat.qualityQ, mat.qualityQ];
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
  const meanArea = section.solidVolumeM3 / Math.max(0.004, lMax);
  const meanWidthM = Math.min(bMid, Math.max(0.002, meanArea / Math.max(0.001, section.meanWallThicknessM * 0.85)));
  const radiatingWidthM = section.hollowFraction >= 0.18 ? bMid : meanWidthM;

  const mightHaveCavity =
    isJoinedPanelBox ||
    section.hollowFraction >= 0.08 ||
    node.isTube === true ||
    (node.geoms ?? []).some(
      (g) => g.csg === 'difference' && g.name !== 'luthier_arch' && g.name !== 'nodal_hole',
    );
  const cavityCheck = cachedCav ?? (mightHaveCavity ? analyze3DCavityAndPorts(node) : null);
  const hasAcousticCavity =
    isJoinedPanelBox ||
    section.hollowFraction >= 0.18 ||
    cavityCheck?.hasHollowCavity === true ||
    cavityCheck?.isOpenCupOrShell === true;
  const modes = buildWeightedModalVoices(freqs, gains, mat.qualityQ, contactDurationSec, modeVectors, undefined, rawModeQs);
  // 3D FDTD air-cavity convolution ONLY applies to hollow soundboxes, open shells/cups, or joined panel carcasses!
  // Solid cavity-free beams, marimba/vibraphone bars, rods, plates, and blocks radiate directly via their pure structural modes.
  const vibroIr = includeIr ? (hasAcousticCavity ? simulate3DVibroAcousticIR(node, mat) : null) : undefined;
  const baseIrWeight = 0.52 + 0.38 * (1 - Math.min(1, mat.qualityQ / 700));
  const bodyIrGain = vibroIr ? +(baseIrWeight * vibroIr.radiationGain).toFixed(4) : undefined;

  return {
    nodeId: node.id,
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
    ...(section.principalLenDir ? { principalLenDir: section.principalLenDir } : {}),
    ...(section.principalOrigin ? { principalOrigin: section.principalOrigin } : {}),
    massKg,
    radiatingWidthM,
    hasAcousticCavity,
    ...(vibroIr !== undefined
      ? {
          bodyIr: vibroIr?.ir ?? null,
          bodyIrSig: vibroIr?.signature ?? '',
          ...(bodyIrGain !== undefined ? { bodyIrGain } : {}),
        }
      : {}),
  };
}

/**
 * Extracts a node's structural modal profile classified by high-level acoustic synthesis regime
 * (`'beam'`, `'plate'`, `'shell'`, `'membrane'`, `'string'`, `'clack'`, or `'block'`).
 */
export function extractModalProfile(
  node: SceneNode,
  includeIr = false,
  sceneNodes?: SceneNode[],
): ExtractedModalProfile {
  const base = estimateBodyModes(node, includeIr, sceneNodes);
  let regime: AcousticModalRegime;
  if (node.acousticMembrane !== undefined) {
    regime = 'membrane';
  } else if (node.acousticString !== undefined) {
    regime = 'string';
  } else if (base.modes.length === 0) {
    regime = 'clack';
  } else if (base.regime === 'bar' || base.regime === 'arched_bar' || base.regime === 'tube') {
    regime = 'beam';
  } else if (base.hasAcousticCavity || base.bodyIr) {
    regime = 'shell';
  } else if (base.regime === 'plate') {
    regime = 'plate';
  } else {
    regime = 'block';
  }
  return {
    ...base,
    regime,
    structuralRegime: base.regime,
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
  const safeTauC = Number.isFinite(tauC) && tauC > 0 ? tauC : 0.001;
  const safeQualityQ = Number.isFinite(qualityQ) && qualityQ > 0 ? qualityQ : 80;
  const safeStrikeXi =
    strikeXi !== undefined && Number.isFinite(strikeXi)
      ? Math.max(-1, Math.min(1, strikeXi))
      : undefined;
  const modes: ModalVoice[] = [];
  for (let idx = 0; idx < freqs.length; idx++) {
    const rawHz = freqs[idx];
    if (!Number.isFinite(rawHz) || rawHz < 24 || rawHz > 18000) continue;

    // 1. Fourier spectrum of the half-sine Hertzian contact force pulse + dual-stiffness mallet core:
    //    |F(f)| = |cos(π f τ_c) / (1 - (2 f τ_c)²)|
    //    For f * τ_c > 1.0 (soft yarn mallet on upper partials), rolls off smoothly while preserving
    //    warm 4*f1 and 9.2*f1 arch overtone articulation from the firmer inner mallet core!
    const x = rawHz * safeTauC;
    let pulseExcitation: number;
    if (Math.abs(x - 0.5) < 1e-3) {
      pulseExcitation = Math.PI / 4;
    } else if (x <= 1.2) {
      pulseExcitation = Math.abs(Math.cos(Math.PI * x) / (1 - 4 * x * x));
    } else {
      pulseExcitation = 0.72 / (4 * x * x - 1) + (modeQs ? 0 : 0.14 / (1 + 0.42 * x));
    }

    // 2. Spatial modal participation |ψ_m(ξ_hit)| integrated across finite beater contact footprint (±0.10):
    //    Striking near the center strongly excites symmetric modes (m=1, 3) and gently excites the 4*f1
    //    arch harmonic across the finite mallet head radius, while striking off-center excites all overtones!
    let spatialWeight = 1.0;
    if (safeStrikeXi !== undefined && modeVectors && modeVectors[idx]) {
      const vec = modeVectors[idx];
      const xiLo = Math.max(-1, Math.min(1, safeStrikeXi - 0.10));
      const xiHi = Math.max(-1, Math.min(1, safeStrikeXi + 0.10));
      const patchAvg =
        0.5 * evaluateNormalizedModeShape(vec, safeStrikeXi) +
        0.25 * evaluateNormalizedModeShape(vec, xiLo) +
        0.25 * evaluateNormalizedModeShape(vec, xiHi);
      if (Number.isFinite(patchAvg)) {
        spatialWeight = 0.12 + 0.92 * patchAvg;
      }
    }

    const rawBaseGain = baseGains[idx];
    const baseGain =
      rawBaseGain === undefined
        ? 0.12
        : Number.isFinite(rawBaseGain)
          ? rawBaseGain
          : 0;
    const weightedGain = baseGain * Math.min(1.25, pulseExcitation * 1.08) * spatialWeight;
    if (!Number.isFinite(weightedGain) || weightedGain < 0.006) continue;

    // Zener thermoelastic + acoustic radiation damping increases with mode order.
    // Free structural solids use physical RT60/RT80 ring duration (~6.91 * Q / (π f)) matching voiceSympathyPool's
    // -80 dB exponential ramp; explicit `modeQs` overrides (joined cabinet seam thuds / air ports) keep crisp fast decay.
    const rawModeQ = modeQs?.[idx];
    const baseModeQ =
      typeof rawModeQ === 'number' && Number.isFinite(rawModeQ) && rawModeQ > 0
        ? rawModeQ
        : safeQualityQ;
    const modeQ = baseModeQ / (1 + (modeQs ? 1.2 : 1.85) * idx * idx);
    const rawDecay = (modeQ / (Math.PI * rawHz)) * (modeQs ? 2.8 : 6.91);
    const decaySec = Number.isFinite(rawDecay) ? Math.max(0.016, Math.min(4.2, rawDecay)) : 0.05;

    modes.push({
      freqHz: +rawHz.toFixed(2),
      gain: +weightedGain.toFixed(3),
      decaySec: +decaySec.toFixed(4),
    });
  }
  return modes;
}

function asBodyModalProfile(profile: AnyModalProfile): BodyModalProfile {
  if ('structuralRegime' in profile) {
    return {
      ...profile,
      regime: profile.structuralRegime,
    };
  }
  return profile;
}

/**
 * Computes exact Two-Body Hertzian Contact Duration τ_c(A, B, J), combined transient
 * brightness, dipole width radiation scaling, strike-position-weighted modal voices,
 * tensioned 2D membrane Bessel modes/snare, von Kármán plate crash cascade, external
 * marimba/vibraphone tube resonator coupling, and plucked string pitch droop!
 */
export function resolveTwoBodyImpact(
  targetProfileIn: AnyModalProfile,
  targetNode: SceneNode,
  opts: TwoBodyImpactOptions,
): TwoBodyImpactResult {
  const targetProfile = asBodyModalProfile(targetProfileIn);
  const safeImpulseNs = Number.isFinite(opts.impulseNs) && opts.impulseNs > 0 ? opts.impulseNs : 0;
  const safeLocalPoint: [number, number, number] | undefined =
    opts.localPoint &&
    Number.isFinite(opts.localPoint[0]) &&
    Number.isFinite(opts.localPoint[1]) &&
    Number.isFinite(opts.localPoint[2])
      ? opts.localPoint
      : undefined;
  const propsA = inferColliderContactProps(targetNode, opts.selfGeomName);
  const propsB = inferColliderContactProps(opts.strikerNode, opts.strikerGeomName);

  // Starter #1: Tensioned 2D drum/timpani membrane impact — ONLY when `targetNode.acousticMembrane` is explicitly set!
  if (targetNode.acousticMembrane !== undefined && !opts.isPluck) {
    const mem = solveMembraneImpact(targetNode, opts.sceneNodes, {
      impulseNs: safeImpulseNs,
      localPoint: safeLocalPoint,
      strikerNode: opts.strikerNode,
      strikerGeomName: opts.strikerGeomName,
    });
    if (mem) {
      const glideFrac = mem.pitchGlide.initialRatio > 0.0004 ? mem.pitchGlide.initialRatio : undefined;
      const glideTau = glideFrac ? mem.pitchGlide.glideTauSec : undefined;
      const memVoices: ModalVoiceSpec[] = mem.voices.map((v) => ({
        ...v,
        ...(glideFrac !== undefined ? { pitchDroopFrac: glideFrac, pitchDroopTauSec: glideTau } : {}),
      }));
      return {
        tauC: mem.tauC,
        effectiveBrightness: mem.effectiveBrightness,
        radiationScale: mem.radiationScale,
        voices: memVoices,
        bodyIr: mem.bodyIr,
        bodyIrSig: mem.bodyIrSig,
        strikerMassKg: propsB.massKg,
        bodyMassKg: mem.evaluation.profile.massKg ?? propsA.massKg,
        ...(mem.snareRattle
          ? {
              snare: {
                gain: mem.snareRattle.gain,
                decaySec: mem.snareRattle.decaySec,
                centerHz: mem.snareRattle.bandpassHz,
              },
            }
          : {}),
      };
    }
  }

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
  const vRel = Math.max(0.06, Math.min(12.0, safeImpulseNs / Math.max(0.0015, 1.55 * mStar)));

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
  // (supporting both axis-aligned solids and rotated/`fromto` principal axes!)
  let strikeXi: number | undefined;
  if (safeLocalPoint && targetProfile.lenBounds) {
    const [sLo, sHi] = targetProfile.lenBounds;
    const mid = 0.5 * (sLo + sHi);
    const half = Math.max(1e-4, 0.5 * (sHi - sLo));
    if (targetProfile.principalLenDir) {
      const dir = targetProfile.principalLenDir;
      const orig = targetProfile.principalOrigin ?? [0, 0, 0];
      const sProj =
        (safeLocalPoint[0] - orig[0]) * dir[0] +
        (safeLocalPoint[1] - orig[1]) * dir[1] +
        (safeLocalPoint[2] - orig[2]) * dir[2];
      const rawXi = (sProj - mid) / half;
      if (Number.isFinite(rawXi)) {
        strikeXi = Math.max(-1, Math.min(1, rawXi));
      }
    } else if (targetProfile.lenAxis !== undefined) {
      const rawXi = (safeLocalPoint[targetProfile.lenAxis] - mid) / half;
      if (Number.isFinite(rawXi)) {
        strikeXi = Math.max(-1, Math.min(1, rawXi));
      }
    }
  }

  // Acoustic dipole radiation efficiency
  const widthM = targetProfile.radiatingWidthM ?? 0.03;
  const radiationScale = opts.isPluck
    ? 1.15
    : widthM >= 0.015
      ? Math.min(1.22, 0.82 + 4.8 * Math.min(0.08, widthM))
      : Math.max(0.03, Math.pow(widthM / 0.015, 2.2) * 0.82);

  // Starter #4b & #3: Plucked / struck taut string modes (raw un-colored modes for 3D FIR + Kirchhoff pitch droop)
  if (opts.isPluck || targetNode.acousticString) {
    const pluckBeta = targetNode.acousticString
      ? resolveStringBetaFromPoint(targetNode, safeLocalPoint, opts.stoppedLengthFraction, opts.sceneNodes)
      : undefined;
    let voices: ModalVoiceSpec[] = targetProfile.modes.map((m) => ({ ...m }));
    let rawIrVoices: ModalVoiceSpec[] | undefined = targetProfile.rawStringModes?.map((m) => ({ ...m }));

    if (
      targetNode.acousticString &&
      safeImpulseNs > 0 &&
      voices.length > 0 &&
      voices[0].pitchDroopFrac === undefined
    ) {
      const ep = resolveStringLocalEndpoints(targetNode);
      const strLenM = ep
        ? Math.max(0.02, Math.hypot(ep.p1[0] - ep.p0[0], ep.p1[1] - ep.p0[1], ep.p1[2] - ep.p0[2]))
        : 0.35;
      const droop = computePluckPitchDroop(
        targetNode,
        strLenM,
        safeImpulseNs,
        pluckBeta ?? targetNode.acousticString.pluckPos ?? 0.18,
        voices[0].decaySec,
      );
      if (droop.pitchDroopFrac > 0) {
        voices = voices.map((m, idx) => ({
          ...m,
          pitchDroopFrac: +(droop.pitchDroopFrac / (1 + 0.04 * idx * idx)).toFixed(6),
          pitchDroopTauSec: droop.pitchDroopTauSec,
        }));
        if (rawIrVoices) {
          rawIrVoices = rawIrVoices.map((m, idx) => ({
            ...m,
            pitchDroopFrac: +(droop.pitchDroopFrac / (1 + 0.04 * idx * idx)).toFixed(6),
            pitchDroopTauSec: droop.pitchDroopTauSec,
          }));
        }
      }
    }

    return {
      tauC,
      effectiveBrightness,
      radiationScale,
      voices,
      ...(rawIrVoices ? { rawIrVoices } : {}),
      bodyIr: targetProfile.bodyIr ?? null,
      bodyIrSig: targetProfile.bodyIrSig ?? '',
      pluckBeta,
      strikerMassKg: propsB.massKg,
      bodyMassKg: targetProfile.massKg ?? propsA.massKg,
    };
  }

  let baseVoices: ModalVoice[] = targetProfile.rawFreqsHz && targetProfile.rawBaseGains
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

  // Starter #5: Marimba / Vibraphone external standing-wave tube resonator & rotating vane tremolo
  let resonator: CoupledTubeResonatorResult | null = null;
  let tremolo: TremoloModulationParams | undefined;
  if (opts.sceneNodes && opts.sceneNodes.length > 0 && baseVoices.length > 0) {
    resonator = resolveExternalTubeResonator(
      targetNode,
      targetProfile,
      baseVoices,
      opts.sceneNodes,
      opts.liveKinematics,
    );
    if (resonator) {
      baseVoices = resonator.coupledVoices;
      if (resonator.tremolo.active || resonator.tremolo.instantaneousOpenFactor < 0.995) {
        tremolo = {
          rateHz: resonator.tremolo.tremoloHz,
          depth: resonator.tremolo.active ? resonator.tremolo.amDepth : 0,
          formantHz: resonator.tube.fundamentalHz,
          occlusionGain: resonator.tremolo.active
            ? resonator.tremolo.meanOpenFactor
            : resonator.tremolo.instantaneousOpenFactor,
        };
      }
    }
  }

  // Starter #4a: von Kármán geometric nonlinearity on thin plates / cymbals / gongs
  let voices: ModalVoiceSpec[] = baseVoices.map((v) => ({ ...v }));
  let crashShimmer: CrashShimmerParams | undefined;
  const crashEnvelope = solveVonKarmanPlateImpact(targetProfile, targetNode, safeImpulseNs, tauC);
  if (crashEnvelope?.active) {
    voices = voices.map((v) => ({
      ...v,
      decaySec: +Math.max(0.020, v.decaySec * crashEnvelope.lowModeDecayScale).toFixed(4),
      ...(Math.abs(crashEnvelope.pitchGlideRatio) > 0.0005
        ? {
            pitchDroopFrac: crashEnvelope.pitchGlideRatio,
            pitchDroopTauSec: crashEnvelope.glideTauSec,
          }
        : {}),
    }));
    for (const cv of crashEnvelope.cascadeVoices) {
      voices.push({
        freqHz: cv.freqHz,
        gain: cv.peakGain,
        decaySec: cv.decaySec,
        bloomDelaySec: +(cv.bloomAttackSec * 0.25).toFixed(4),
        bloomAttackSec: +(cv.bloomAttackSec * 0.75).toFixed(4),
        ...(Math.abs(crashEnvelope.pitchGlideCents) > 1
          ? {
              pitchGlideCents: +(crashEnvelope.pitchGlideCents * 0.65).toFixed(2),
              pitchDroopTauSec: crashEnvelope.glideTauSec,
            }
          : {}),
      });
    }
    if (crashEnvelope.shimmerPeakGain > 0.005) {
      crashShimmer = {
        gain: crashEnvelope.shimmerPeakGain,
        bloomSec: crashEnvelope.shimmerBloomSec,
        decaySec: crashEnvelope.shimmerDecaySec,
        highpassHz: Math.max(1800, Math.round(crashEnvelope.shimmerBandHz * 0.65)),
      };
    }
  }

  // Cached 3D Vibro-Acoustic FIR ONLY for hollow soundboxes, open shells/cups, or joined panel carcasses!
  // Solid cavity-free bars/beams/plates/blocks (`hasAcousticCavity === false`) radiate purely through their structural modes.
  const computedVibroIr =
    targetProfile.bodyIr === undefined && targetProfile.hasAcousticCavity === true
      ? simulate3DVibroAcousticIR(targetNode, targetProfile.material)
      : undefined;
  const localIr =
    targetProfile.hasAcousticCavity === false
      ? null
      : targetProfile.bodyIr !== undefined
        ? targetProfile.bodyIr
        : (computedVibroIr?.ir ?? null);
  const localIrSig =
    localIr
      ? (targetProfile.bodyIrSig !== undefined ? targetProfile.bodyIrSig : (computedVibroIr?.signature ?? ''))
      : '';
  const baseIrWeight = 0.52 + 0.38 * (1 - Math.min(1, targetProfile.material.qualityQ / 700));
  const localIrGain =
    localIr
      ? targetProfile.bodyIrGain !== undefined
        ? targetProfile.bodyIrGain
        : computedVibroIr
          ? +(baseIrWeight * computedVibroIr.radiationGain).toFixed(4)
          : undefined
      : undefined;

  return {
    tauC,
    effectiveBrightness,
    radiationScale,
    voices,
    bodyIr: localIr ?? null,
    bodyIrSig: localIrSig,
    ...(localIrGain !== undefined ? { bodyIrGain: localIrGain } : {}),
    strikeXi,
    strikerMassKg: propsB.massKg,
    bodyMassKg: targetProfile.massKg ?? propsA.massKg,
    ...(crashShimmer ? { crashShimmer } : {}),
    ...(crashEnvelope ? { crashEnvelope } : {}),
    ...(resonator ? { resonator } : {}),
    ...(tremolo ? { tremolo } : {}),
  };
}

// ---------------------------------------------------------------------------
// Zero-sample WebAudio synthesiser (routed through shared Studio Chamber Bus!)
// ---------------------------------------------------------------------------

type WindowWithAudioCtx = Window & {
  __physboxSharedAudioCtx?: AudioContext;
  __physboxGestureHookInstalled?: boolean;
  __physboxVisibilityHookInstalled?: boolean;
  __physboxReverbSubUnsub?: () => void;
};

let sharedAudioCtx: AudioContext | null = null;
let pendingSuspendTimer: ReturnType<typeof setTimeout> | null = null;

function clearPendingSuspend(): void {
  if (pendingSuspendTimer !== null) {
    clearTimeout(pendingSuspendTimer);
    pendingSuspendTimer = null;
  }
}

function scheduleIdleAudioSuspend(delayMs = 180): void {
  clearPendingSuspend();
  pendingSuspendTimer = setTimeout(() => {
    pendingSuspendTimer = null;
    const isHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    if (!useSoundStore.getState().soundEnabled || isHidden) {
      const ctx = sharedAudioCtx ?? (typeof window !== 'undefined' ? (window as WindowWithAudioCtx).__physboxSharedAudioCtx : undefined);
      if (ctx && ctx.state === 'running' && typeof ctx.suspend === 'function') {
        void ctx.suspend().catch(() => {});
      }
    }
  }, delayMs);
}

/** Returns the existing shared `AudioContext` if already created, without allocating or resuming one. */
export function peekSharedAudioContext(): AudioContext | null {
  if (sharedAudioCtx && sharedAudioCtx.state !== 'closed') return sharedAudioCtx;
  if (sharedAudioCtx?.state === 'closed') sharedAudioCtx = null;
  if (typeof window !== 'undefined') {
    const winCtx = (window as WindowWithAudioCtx).__physboxSharedAudioCtx;
    if (winCtx && winCtx.state !== 'closed') {
      sharedAudioCtx = winCtx;
      return winCtx;
    }
  }
  return null;
}

/** Returns the shared Studio Chamber output bus on `ctx` (or `null` when `ctx` is absent). */
export function getSharedOutputBusForContext(ctx?: AudioContext | null): AudioNode | null {
  const target = ctx ?? peekSharedAudioContext();
  if (!target) return null;
  return getSharedAcousticOutputBus(target);
}

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  clearPendingSuspend();
  if (sharedAudioCtx?.state === 'closed') {
    sharedAudioCtx = null;
  }
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
    src.onended = () => {
      try { src.disconnect(); } catch { /* ignore */ }
    };
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
      if (!useSoundStore.getState().soundEnabled) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (sharedAudioCtx && sharedAudioCtx.state === 'suspended') {
        void sharedAudioCtx.resume().catch(() => {});
      } else if (win.__physboxSharedAudioCtx && win.__physboxSharedAudioCtx.state === 'suspended') {
        void win.__physboxSharedAudioCtx.resume().catch(() => {});
      }
    };
    window.addEventListener('pointerdown', onGesture, { passive: true });
    window.addEventListener('keydown', onGesture, { passive: true });
  }
  if (!win.__physboxVisibilityHookInstalled && typeof document !== 'undefined') {
    win.__physboxVisibilityHookInstalled = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        const ctx = peekSharedAudioContext();
        silenceModalVoices(ctx);
        postWorkletWindSilence(ctx);
        postWorkletBowedSilence(ctx);
        postWorkletAeroSilence(ctx);
        postWorkletFrictionSilence(ctx);
        scheduleIdleAudioSuspend(120);
      } else if (useSoundStore.getState().soundEnabled) {
        const ctx = peekSharedAudioContext();
        if (ctx && ctx.state === 'suspended') {
          void ctx.resume().catch(() => {});
        }
      }
    });
  }
  win.__physboxReverbSubUnsub?.();
  let prevReverb = useSoundStore.getState().reverbEnabled;
  let prevSound = useSoundStore.getState().soundEnabled;
  win.__physboxReverbSubUnsub = useSoundStore.subscribe((state) => {
    if (state.reverbEnabled !== prevReverb) {
      prevReverb = state.reverbEnabled;
      const ctx = peekSharedAudioContext();
      setStudioReverbEnabled(ctx, state.reverbEnabled);
    }
    if (state.soundEnabled !== prevSound) {
      prevSound = state.soundEnabled;
      if (!state.soundEnabled) {
        scheduleIdleAudioSuspend(180);
      } else {
        clearPendingSuspend();
        const ctx = peekSharedAudioContext();
        if (ctx && ctx.state === 'suspended' && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) {
          void ctx.resume().catch(() => {});
        }
      }
    }
  });
}

/**
 * Synthesises a physical modal impact, membrane strike, plate crash, or string pluck
 * through the bounded polyphonic `voiceSympathyPool` and shared Studio Chamber bus!
 */
export function playModalImpact(
  profile: AnyModalProfile,
  impulseNs: number,
  isPluck = false,
  twoBodyOverride?: Partial<TwoBodyImpactResult> & {
    tauC: number;
    effectiveBrightness: number;
    radiationScale: number;
    voices: ModalVoiceSpec[];
    nodeId?: string;
    pan?: number;
    distanceGain?: number;
    simTime?: number;
  },
): ActiveModalVoiceGroup | null {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return null;
  if (!Number.isFinite(impulseNs) || impulseNs <= 0) return null;

  const radScale = twoBodyOverride?.radiationScale ?? (isPluck ? 1.15 : 1.0);
  // Concert-matched dynamic curve so marimba, metallophone, and lyre sit at the same lush presence as cornet/clarinet
  const baseLevel = isPluck
    ? 0.34 * Math.log10(1 + Math.max(0.0005, impulseNs) * 140)
    : 0.30 * Math.log10(1 + Math.max(0.0005, impulseNs) * 95);
  const level = Math.min(0.56, baseLevel * radScale);
  if (!Number.isFinite(level) || level < 0.004) return null;

  const ctx = getAudioContext();
  if (!ctx) return null;

  const vScale = Math.pow(Math.max(0.08, Math.min(6, impulseNs * 1.8)), -0.15);
  const tauC = twoBodyOverride
    ? twoBodyOverride.tauC
    : Math.max(0.00035, Math.min(0.006, profile.contactDurationSec * vScale));
  const brightness = twoBodyOverride ? twoBodyOverride.effectiveBrightness : profile.material.brightness;
  const voices = twoBodyOverride ? twoBodyOverride.voices : profile.modes;
  const rawIrVoices = twoBodyOverride?.rawIrVoices ?? profile.rawStringModes;
  const activeIr =
    profile.hasAcousticCavity === false && twoBodyOverride?.bodyIr === undefined
      ? null
      : twoBodyOverride?.bodyIr !== undefined
        ? twoBodyOverride.bodyIr
        : profile.bodyIr;
  const activeIrSig = activeIr ? (twoBodyOverride?.bodyIrSig ?? profile.bodyIrSig ?? '') : '';
  const activeIrGain = activeIr ? (twoBodyOverride?.bodyIrGain ?? profile.bodyIrGain) : undefined;

  const outputBus = getSharedAcousticOutputBus(ctx);
  return triggerOrMutateModalVoice({
    ctx,
    outputBus,
    nodeId: twoBodyOverride?.nodeId ?? profile.nodeId,
    level,
    tauC,
    brightness,
    isPluck,
    voices,
    rawIrVoices,
    bodyIr: activeIr,
    bodyIrSig: activeIrSig,
    bodyIrGain: activeIrGain,
    materialQ: profile.material.qualityQ,
    modeVectors: profile.modeVectors,
    lenAxis: profile.lenAxis,
    lenBounds: profile.lenBounds,
    principalLenDir: profile.principalLenDir,
    principalOrigin: profile.principalOrigin,
    strikeXi: twoBodyOverride?.strikeXi,
    pluckBeta: twoBodyOverride?.pluckBeta,
    strikerMassKg: twoBodyOverride?.strikerMassKg,
    bodyMassKg: twoBodyOverride?.bodyMassKg ?? profile.massKg,
    pan: twoBodyOverride?.pan,
    distanceGain: twoBodyOverride?.distanceGain,
    snare: twoBodyOverride?.snare,
    crashShimmer: twoBodyOverride?.crashShimmer,
    tremolo: twoBodyOverride?.tremolo,
    simTime: twoBodyOverride?.simTime,
  });
}

/** Auditions a clean medium mallet tap at the center of `node` in the Inspector. */
export function playModalTap(node: SceneNode, sceneNodes?: SceneNode[]): BodyModalProfile {
  const profile = estimateBodyModes(node, true, sceneNodes);
  const twoBody = resolveTwoBodyImpact(profile, node, {
    impulseNs: 0.35,
    sceneNodes,
  });
  playModalImpact(profile, 0.35, false, { ...twoBody, nodeId: node.id });
  return profile;
}

/** Streams active wind/brass bore parameters to the native WebAudio engine. */
export function updateLiveWindVoices(voices: WorkletWindVoicePayload[]): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  const ctx = voices.length === 0 ? peekSharedAudioContext() : getAudioContext();
  if (!ctx) return;
  postWorkletWindUpdate(ctx, voices);
}

/** Immediately fades out all continuous wind/brass bore voices (on Stop or Mute). */
export function silenceWindVoices(): void {
  postWorkletWindSilence(peekSharedAudioContext());
}

/** Streams active bowed-string Helmholtz voices to the native WebAudio engine. */
export function updateLiveBowedVoices(voices: WorkletBowedVoicePayload[]): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  const ctx = voices.length === 0 ? peekSharedAudioContext() : getAudioContext();
  if (!ctx) return;
  postWorkletBowedUpdate(ctx, voices);
}

/** Immediately fades out all continuous bowed-string voices (on Stop or Mute). */
export function silenceBowedVoices(): void {
  postWorkletBowedSilence(peekSharedAudioContext());
}

/** Streams active rotor, wing, windmill, and cloth aeroacoustic voices to the native WebAudio engine. */
export function updateLiveAeroVoices(voices: SpatialAeroSynthParams[]): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  const ctx = voices.length === 0 ? peekSharedAudioContext() : getAudioContext();
  if (!ctx) return;
  postWorkletAeroUpdate(ctx, voices);
}

let auditionSnapSeq = 1;

/** Triggers an impulsive trailing-edge cloth / flag N-wave whip-snap through the shared acoustic bus. */
export function playAeroSnapPulse(
  snap: SpatialSnapSynthParams,
  spatial?: Partial<SpatialAcousticParams> | null,
): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  const ctx = getAudioContext();
  if (!ctx) return;
  postWorkletAeroSnap(ctx, snap, spatial);
}

/** Auditions a clean cloth whip-snap at areal density `arealDensityKgM2` (e.g. from the Inspector). */
export function auditionClothSnap(
  arealDensityKgM2: number,
  nodeId = 'audition_cloth',
  relSpeedMps = 8.5,
  impulseNs = 0.055,
): SnapSynthParams {
  unlockAudioContext();
  const snapParams = solveClothSnapPulse({
    nodeId,
    impulseNs,
    arealDensityKgM2,
    relSpeedMps,
    seq: auditionSnapSeq++,
  });
  playAeroSnapPulse(snapParams);
  return snapParams;
}

/** Immediately fades out all continuous aeroacoustic voices (on Stop or Mute). */
export function silenceAeroVoices(): void {
  postWorkletAeroSilence(peekSharedAudioContext());
}

/** Streams active continuous rolling, scraping, squealing, and rim-singing friction voices to WebAudio. */
export function updateLiveFrictionVoices(voices: WorkletFrictionVoicePayload[]): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  const ctx = voices.length === 0 ? peekSharedAudioContext() : getAudioContext();
  if (!ctx) return;
  postWorkletFrictionUpdate(ctx, voices);
}

/** Immediately fades out all continuous contact-friction voices (on Stop, Reset, or Mute). */
export function silenceFrictionVoices(): void {
  postWorkletFrictionSilence(peekSharedAudioContext());
}

export type { WorkletBowedVoicePayload, WorkletFrictionVoicePayload };
