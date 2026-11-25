// ---------------------------------------------------------------------------
// Tensioned 2D Membranes & Drums (Circular Bessel & Rectangular Heads,
// Kettle / Vented Shell Air-Cavity Coupling, Hard-Strike Tension Pitch Drop,
// & Sympathetic Bottom-Head Snare Wire Rattle)
// ---------------------------------------------------------------------------
//
// Physics implemented:
// 1. Circular tensioned membrane (radius a, isotropic tension T_s in N/m,
//    film thickness h, density rho -> areal density sigma = rho * h + sigma_air):
//      f_{mn}^(0) = (j_{mn} / (2 * pi * a)) * sqrt(T_s / sigma_{mn})
//                   * sqrt(1 + (D * j_{mn}^2) / (T_s * a^2))
//    with Bessel roots j_{mn} of J_m(x) = 0 and strike-radius modal weight
//    |J_m(j_{mn} * r_hit / a)| / max |J_m|.
// 2. Rectangular tensioned membrane (spans L_x, L_y):
//      f_{mn}^(0) = 0.5 * sqrt(T_s / sigma_{mn}) * hypot(m / L_x, n / L_y).
// 3. Enclosed Kettle / Vented Drum-Shell Air Coupling (`analyze3DCavityAndPorts`):
//    - Closed kettle (timpani): adiabatic air stiffness couples strictly to
//      axisymmetric m = 0 modes while baffled air-mass loading shifts azimuthal
//      modes (1,1), (2,1), (3,1), (4,1) into harmonic 1 : 1.50 : 1.99 : 2.44!
//    - Vented cylindrical shell (tom/snare): 2x2 coupled oscillator splitting
//      between fundamental (0,1) head mode and shell Helmholtz air mode f_H.
// 4. Hard-Strike Nonlinear Tension-Modulation Pitch Drop:
//      T(t) = T_0 + dT_0 * exp(-2 * t / tau_nl),  dT_0 = (E * h / (2 * a^2)) * A_0^2
//      f(t) = f_inf * sqrt(1 + gamma_nl * exp(-2 * t / tau_nl)).
// 5. Snare-Bed Wire Rattle: amplitude-gated high-frequency wire buzz modulated
//    at bottom-head fundamental f_{01}.
// ---------------------------------------------------------------------------

import type {
  AcousticMembraneSpec,
  MembraneMaterialId,
  MembraneShapeKind,
  SceneNode,
} from '../types/scene';
import {
  inferColliderContactProps,
  type AcousticMaterialProps,
  type BodyModalProfile,
  type ModalVoice,
} from './modalAudio';
import {
  analyze3DCavityAndPorts,
  analyze3DSolidCrossSections,
  buildBodyRayScene,
  castSceneRay,
  simulate3DVibroAcousticIR,
} from './solidAcoustics3D';

const AIR_DENSITY_KGM3 = 1.204;
const SPEED_OF_SOUND_AIR = 343.0;

export interface MembraneMaterialProps {
  id: MembraneMaterialId;
  label: string;
  densityKgM3: number;
  modulusGPa: number;
  poisson: number;
  ultimateStrengthMPa: number;
  intrinsicQ: number;
  brightness: number;
  rgba: [number, number, number, number];
}

export const MEMBRANE_MATERIALS: Record<MembraneMaterialId, MembraneMaterialProps> = {
  mylar: {
    id: 'mylar',
    label: 'Clear PET / Mylar Film',
    densityKgM3: 1390,
    modulusGPa: 4.5,
    poisson: 0.38,
    ultimateStrengthMPa: 195,
    intrinsicQ: 92,
    brightness: 0.62,
    rgba: [0.90, 0.93, 0.97, 0.88],
  },
  coated_film: {
    id: 'coated_film',
    label: 'Coated Batter Film',
    densityKgM3: 1520,
    modulusGPa: 4.2,
    poisson: 0.38,
    ultimateStrengthMPa: 185,
    intrinsicQ: 74,
    brightness: 0.48,
    rgba: [0.95, 0.94, 0.90, 0.96],
  },
  calfskin: {
    id: 'calfskin',
    label: 'Natural Calfskin / Goat Parchment',
    densityKgM3: 1180,
    modulusGPa: 2.4,
    poisson: 0.35,
    ultimateStrengthMPa: 85,
    intrinsicQ: 64,
    brightness: 0.40,
    rgba: [0.88, 0.80, 0.64, 0.96],
  },
  kevlar: {
    id: 'kevlar',
    label: 'Woven Aramid / Marching Kevlar',
    densityKgM3: 1440,
    modulusGPa: 68.0,
    poisson: 0.36,
    ultimateStrengthMPa: 950,
    intrinsicQ: 108,
    brightness: 0.78,
    rgba: [0.92, 0.88, 0.72, 0.98],
  },
};

export interface CircularBesselMode {
  m: number;
  n: number;
  jmn: number;
  /** Peak |J_m(x)| in [0, j_{mn}] for normalizing spatial strike participation to [0, 1]. */
  peakAbsJm: number;
  /** Dimensionless baffled air-inertia loading factor chi_{mn} (Christian, Davis, Tubis 1984 timpani tables). */
  airLoadingChi: number;
  baseWeight: number;
}

export const CIRCULAR_BESSEL_MODES: readonly CircularBesselMode[] = [
  { m: 0, n: 1, jmn: 2.40482556, peakAbsJm: 1.0, airLoadingChi: 1.0, baseWeight: 0.92 },
  { m: 1, n: 1, jmn: 3.83170597, peakAbsJm: 0.581865, airLoadingChi: 0.505, baseWeight: 1.0 },
  { m: 2, n: 1, jmn: 5.13562230, peakAbsJm: 0.486499, airLoadingChi: 0.312, baseWeight: 0.76 },
  { m: 0, n: 2, jmn: 5.52007811, peakAbsJm: 1.0, airLoadingChi: 0.285, baseWeight: 0.48 },
  { m: 3, n: 1, jmn: 6.38016190, peakAbsJm: 0.434394, airLoadingChi: 0.214, baseWeight: 0.54 },
  { m: 1, n: 2, jmn: 7.01558667, peakAbsJm: 0.581865, airLoadingChi: 0.185, baseWeight: 0.34 },
  { m: 4, n: 1, jmn: 7.58834243, peakAbsJm: 0.399663, airLoadingChi: 0.156, baseWeight: 0.36 },
  { m: 2, n: 2, jmn: 8.41724414, peakAbsJm: 0.486499, airLoadingChi: 0.132, baseWeight: 0.22 },
];

const BESSEL_FACTORIAL = [1, 1, 2, 6, 24, 120, 720, 5040];

/** Evaluates Bessel function of the first kind J_m(x) for integer m >= 0 and x in [0, 16]. */
export function besselJn(m: number, x: number): number {
  const ax = x < 0 ? -x : x;
  if (ax < 1e-12) return m === 0 ? 1 : 0;
  let fact = m < BESSEL_FACTORIAL.length ? BESSEL_FACTORIAL[m] : 1;
  if (m >= BESSEL_FACTORIAL.length) {
    for (let k = 2; k <= m; k++) fact *= k;
  }
  const halfX = 0.5 * ax;
  let term = (m === 0 ? 1 : m === 1 ? halfX : m === 2 ? halfX * halfX : Math.pow(halfX, m)) / fact;
  let sum = term;
  const negQuarterXSq = -halfX * halfX;
  for (let k = 1; k <= 28; k++) {
    term *= negQuarterXSq / (k * (k + m));
    sum += term;
    const absTerm = term < 0 ? -term : term;
    const absSum = sum < 0 ? -sum : sum;
    if (absTerm < 1e-15 * absSum) break;
  }
  return x < 0 && (m & 1) === 1 ? -sum : sum;
}

export interface MembraneStrikeContext {
  impulseNs?: number;
  localPoint?: [number, number, number];
  strikerNode?: SceneNode | null;
  strikerGeomName?: string;
}

export interface MembranePitchGlideEnvelope {
  /** Initial fractional frequency multiplier offset (f_start / f_steady - 1 >= 0). */
  initialRatio: number;
  /** Equivalent initial upward pitch shift in semitones (12 * log2(1 + initialRatio)). */
  semitones: number;
  /** Exponential time constant tau_glide (s) for WebAudio `setTargetAtTime`. */
  glideTauSec: number;
}

export interface SnareRattleEnvelope {
  gain: number;
  decaySec: number;
  modHz: number;
  bandpassHz: number;
  highshelfHz: number;
}

export interface MembraneEvaluation {
  shape: MembraneShapeKind;
  radiusM: number;
  spanXM: number;
  spanYM: number;
  thicknessM: number;
  arealDensityKgM2: number;
  waveSpeedMps: number;
  tensileStressMPa: number;
  stressRatio: number;
  fundamentalHz: number;
  overtoneRatio: number;
  /** Ratios of lowest azimuthal/musical partials (e.g. [1, 1.50, 1.99] on kettle timpani vs [1, 1.593, 2.136] on unbaffled circular membrane). */
  modeRatios: number[];
  hasShellCavity: boolean;
  isClosedKettle: boolean;
  shellVolumeLitres: number;
  shellHelmholtzHz: number | null;
  warnings: string[];
  profile: BodyModalProfile;
  pitchGlide: MembranePitchGlideEnvelope;
  snareRattle: SnareRattleEnvelope | null;
}

/** Returns true when `node` is configured as `acousticMembrane` or has drumhead-like thin sheet geometry. */
export function isMembraneCandidate(node: SceneNode): boolean {
  if (node.acousticMembrane) return true;
  if (node.hardwarePart || node.simulation || node.acousticString || node.windInstrument) return false;
  const sec = analyze3DSolidCrossSections(node);
  const [hMin, bMid, lMax] = sec.dimsSortedAsc;
  return bMid >= 0.06 && hMin / bMid <= 0.08 && lMax / bMid <= 1.85 && sec.hollowFraction < 0.20;
}

function findNodeById(nodes: SceneNode[] | undefined, id: string): SceneNode | null {
  if (!nodes) return null;
  for (const n of nodes) {
    if (n.id === id || n.name === id) return n;
    const sub = findNodeById(n.children, id);
    if (sub) return sub;
  }
  return null;
}

function hasSiblingHeadOnShell(
  headNode: SceneNode,
  shellNode: SceneNode,
  sceneNodes?: SceneNode[],
): boolean {
  if (!sceneNodes) return false;
  let found = false;
  const walk = (list: SceneNode[]) => {
    for (const n of list) {
      if (found) return;
      if (n.id !== headNode.id && n.acousticMembrane) {
        if (n.acousticMembrane.shellNodeId === shellNode.id || n.acousticMembrane.shellNodeId === shellNode.name) {
          found = true;
          return;
        }
      }
      if (n.children?.length) walk(n.children);
    }
  };
  walk(sceneNodes);
  return found;
}

const closedAxialEndCache = new Map<string, boolean>();
const MAX_CLOSED_AXIAL_CACHE = 128;

function shellGeomFastSig(shellNode: SceneNode, normalAxis: 0 | 1 | 2): string {
  let sig = `${shellNode.id}|${normalAxis}|${shellNode.isTube ? 1 : 0}|${shellNode.csgEnabled === false ? 0 : 1}|${shellNode.sculptVersion ?? 0}|${shellNode.sculptEdited ? 1 : 0}`;
  const geoms = shellNode.geoms;
  if (geoms) {
    for (let i = 0; i < geoms.length; i++) {
      const g = geoms[i];
      if (g.csgDerived || g.role === 'visual' || g.type === 'plane') continue;
      sig += `;${g.type}:${g.csg ?? ''}:${g.size ? g.size.join(',') : ''}:${g.pos ? g.pos.join(',') : ''}:${g.renderVertices?.length ?? g.vertices?.length ?? 0}`;
    }
  }
  return sig;
}

function shellHasClosedAxialEnd(shellNode: SceneNode, normalAxis: 0 | 1 | 2): boolean {
  if (shellNode.isTube) return false;
  const sig = shellGeomFastSig(shellNode, normalAxis);
  const hit = closedAxialEndCache.get(sig);
  if (hit !== undefined) return hit;

  const rayScene = buildBodyRayScene(shellNode, false) ?? buildBodyRayScene(shellNode, true);
  let closed = false;
  if (rayScene) {
    const b = rayScene.bounds;
    const org: [number, number, number] = [
      0.5 * (b[0] + b[1]),
      0.5 * (b[2] + b[3]),
      0.5 * (b[4] + b[5]),
    ];
    org[normalAxis] = b[2 * normalAxis] - 0.05;
    const dir: [number, number, number] = [0, 0, 0];
    dir[normalAxis] = 1;
    const ivs = castSceneRay(rayScene, org[0], org[1], org[2], dir[0], dir[1], dir[2]);
    closed = ivs.length >= 1;
  }
  if (closedAxialEndCache.size >= MAX_CLOSED_AXIAL_CACHE) {
    const oldest = closedAxialEndCache.keys().next().value;
    if (oldest !== undefined) closedAxialEndCache.delete(oldest);
  }
  closedAxialEndCache.set(sig, closed);
  return closed;
}

function findParentNode(nodes: SceneNode[] | undefined, childId: string): SceneNode | null {
  if (!nodes) return null;
  for (const n of nodes) {
    if ((n.children ?? []).some((c) => c.id === childId)) return n;
    const sub = findParentNode(n.children, childId);
    if (sub) return sub;
  }
  return null;
}

function worldOriginApprox(targetId: string, nodes: SceneNode[] | undefined): [number, number, number] | null {
  if (!nodes) return null;
  const walk = (list: SceneNode[], ox: number, oy: number, oz: number): [number, number, number] | null => {
    for (const n of list) {
      const nx = ox + (n.pos?.[0] ?? 0);
      const ny = oy + (n.pos?.[1] ?? 0);
      const nz = oz + (n.pos?.[2] ?? 0);
      if (n.id === targetId) return [nx, ny, nz];
      const sub = walk(n.children ?? [], nx, ny, nz);
      if (sub) return sub;
    }
    return null;
  };
  return walk(nodes, 0, 0, 0);
}

function resolveCoupledDrumShell(
  headNode: SceneNode,
  spec: AcousticMembraneSpec,
  headRadiusM: number,
  sceneNodes?: SceneNode[],
): SceneNode | null {
  if (spec.shellNodeId) {
    const explicit = findNodeById(sceneNodes, spec.shellNodeId);
    if (explicit && explicit.id !== headNode.id) return explicit;
  }
  const parent = findParentNode(sceneNodes, headNode.id);
  if (parent) {
    const pCav = analyze3DCavityAndPorts(parent);
    if (pCav.hasHollowCavity || pCav.isOpenCupOrShell) return parent;
  }
  if (!sceneNodes) return null;

  const headWorld = worldOriginApprox(headNode.id, sceneNodes) ?? [
    headNode.pos?.[0] ?? 0,
    headNode.pos?.[1] ?? 0,
    headNode.pos?.[2] ?? 0,
  ];
  let bestShell: SceneNode | null = null;
  let bestDist = Infinity;

  const visit = (list: SceneNode[], ox: number, oy: number, oz: number) => {
    for (const cand of list) {
      const cx = ox + (cand.pos?.[0] ?? 0);
      const cy = oy + (cand.pos?.[1] ?? 0);
      const cz = oz + (cand.pos?.[2] ?? 0);
      if (cand.id !== headNode.id && !cand.acousticMembrane && !cand.acousticString) {
        const dXY = Math.hypot(cx - headWorld[0], cy - headWorld[1]);
        const dZ = Math.abs(cz - headWorld[2]);
        if (dXY <= headRadiusM * 0.85 && dZ <= headRadiusM * 3.2) {
          const cav = analyze3DCavityAndPorts(cand);
          if (cav.hasHollowCavity || cav.isOpenCupOrShell || cand.isTube) {
            const dist = dXY + 0.5 * dZ;
            if (dist < bestDist) {
              bestDist = dist;
              bestShell = cand;
            }
          }
        }
      }
      if (cand.children?.length) visit(cand.children, cx, cy, cz);
    }
  };
  visit(sceneNodes, 0, 0, 0);
  return bestShell;
}

function inferMembranePlanform(
  node: SceneNode,
  spec: AcousticMembraneSpec,
): {
  shape: MembraneShapeKind;
  radiusM: number;
  spanXM: number;
  spanYM: number;
  normalAxis: 0 | 1 | 2;
  uAxis: 0 | 1 | 2;
  vAxis: 0 | 1 | 2;
  centerLocal: [number, number, number];
} {
  const sec = analyze3DSolidCrossSections(node);
  const [, bMid, lMax] = sec.dimsSortedAsc;
  const [thickAxis, widthAxis, lenAxis] = sec.axisOrderAsc;
  const primary = (node.geoms ?? []).find((g) => !g.csgDerived && g.csg !== 'difference' && g.role !== 'visual');

  let inferredShape: MembraneShapeKind = 'circular';
  if (spec.shape) {
    inferredShape = spec.shape;
  } else if (primary?.type === 'box' || (lMax / Math.max(1e-4, bMid) > 1.18 && primary?.type !== 'cylinder' && primary?.type !== 'ellipsoid')) {
    inferredShape = 'rectangular';
  }

  const spanUM = Math.max(0.04, bMid);
  const spanVM = Math.max(0.04, lMax);
  const radiusM = inferredShape === 'circular'
    ? 0.25 * (spanUM + spanVM)
    : Math.sqrt((spanUM * spanVM) / Math.PI);

  const centerLocal: [number, number, number] = [0, 0, 0];
  centerLocal[lenAxis] = 0.5 * (sec.lenBounds[0] + sec.lenBounds[1]);
  centerLocal[widthAxis] = 0.5 * (sec.widthBounds[0] + sec.widthBounds[1]);
  centerLocal[thickAxis] = primary?.pos?.[thickAxis] ?? 0;

  return {
    shape: inferredShape,
    radiusM,
    spanXM: spanUM,
    spanYM: spanVM,
    normalAxis: thickAxis,
    uAxis: widthAxis,
    vAxis: lenAxis,
    centerLocal,
  };
}

interface ResolvedMembraneShellInfo {
  plan: ReturnType<typeof inferMembranePlanform>;
  shellNode: SceneNode | null;
  hasShellCavity: boolean;
  isClosedKettle: boolean;
  isDualHeadOrVentedSnare: boolean;
  shellVolumeM3: number;
  shellDepthM: number;
  shellHelmholtzHz: number | null;
}

function resolveMembraneShellInfo(
  node: SceneNode,
  spec: AcousticMembraneSpec,
  sceneNodes?: SceneNode[],
): ResolvedMembraneShellInfo {
  const plan = inferMembranePlanform(node, spec);
  const { shape, radiusM: a, spanXM, spanYM } = plan;
  const areaM2 = shape === 'circular' ? Math.PI * a * a : spanXM * spanYM;

  const snareAmount = Math.max(0, Math.min(1, spec.snareBuzz ?? 0));
  const shellNode = resolveCoupledDrumShell(node, spec, a, sceneNodes);
  let hasShellCavity = false;
  let isClosedKettle = false;
  let isDualHeadOrVentedSnare = snareAmount > 0.05;
  let shellVolumeM3 = 0;
  let shellDepthM = 0.14;
  let shellHelmholtzHz: number | null = null;

  if (shellNode) {
    const shellCav = analyze3DCavityAndPorts(shellNode);
    const shellSec = analyze3DSolidCrossSections(shellNode);
    const [shThick, shW, shL] = shellSec.dimsSortedAsc;
    shellDepthM = Math.max(0.06, shThick > 0.04 ? shThick : 0.45 * shW);
    const hasClosedBottom = shellHasClosedAxialEnd(shellNode, plan.normalAxis);
    const hasSiblingHead = hasSiblingHeadOnShell(node, shellNode, sceneNodes);
    if (hasSiblingHead || !hasClosedBottom) {
      isDualHeadOrVentedSnare = isDualHeadOrVentedSnare || hasSiblingHead;
    }

    if (shellCav.hasHollowCavity && shellCav.cavityVolumeM3 > 1e-5) {
      hasShellCavity = true;
      shellVolumeM3 = shellCav.cavityVolumeM3;
      let wideRimPortCount = 0;
      let ventPortCount = 0;
      let ventConductance = 0;
      const rimThresh = 0.35 * areaM2;
      for (let i = 0; i < shellCav.ports.length; i++) {
        const p = shellCav.ports[i];
        if (p.areaM2 >= rimThresh) {
          wideRimPortCount++;
        } else {
          ventPortCount++;
          ventConductance += p.conductanceM;
        }
      }
      if (spec.kettleCoupling !== undefined) {
        isClosedKettle = spec.kettleCoupling >= 0.45 && hasClosedBottom;
      } else if (
        !isDualHeadOrVentedSnare &&
        hasClosedBottom &&
        wideRimPortCount <= 1 &&
        ventPortCount === 0
      ) {
        isClosedKettle = true;
      }

      if (!isClosedKettle && ventPortCount > 0) {
        if (ventConductance > 0) {
          shellHelmholtzHz = (SPEED_OF_SOUND_AIR / (2 * Math.PI)) * Math.sqrt(ventConductance / shellVolumeM3);
        }
      } else if (!isClosedKettle && !hasClosedBottom && !isDualHeadOrVentedSnare) {
        const tubeDepth = Math.max(0.08, shellNode.height ?? shL * 0.6);
        shellHelmholtzHz = SPEED_OF_SOUND_AIR / (2 * (tubeDepth + 1.2266 * a));
      }
    } else if (shellCav.isOpenCupOrShell || shellNode.isTube || shellSec.hollowFraction >= 0.18) {
      shellVolumeM3 = Math.max(1e-4, areaM2 * shellDepthM);
      hasShellCavity = true;
      if (spec.kettleCoupling !== undefined) {
        isClosedKettle = spec.kettleCoupling >= 0.45 && hasClosedBottom;
      } else {
        isClosedKettle = !isDualHeadOrVentedSnare && hasClosedBottom && !shellNode.isTube;
      }
      if (!isClosedKettle && !isDualHeadOrVentedSnare && (shellNode.isTube || !hasClosedBottom)) {
        const tubeDepth = Math.max(0.08, shellNode.height ?? shellDepthM);
        shellHelmholtzHz = SPEED_OF_SOUND_AIR / (2 * (tubeDepth + 1.2266 * a));
      }
    }
  } else if (spec.kettleCoupling !== undefined && spec.kettleCoupling >= 0.45) {
    hasShellCavity = true;
    isClosedKettle = true;
    shellVolumeM3 = (2 / 3) * Math.PI * a * a * a;
  }

  return {
    plan,
    shellNode,
    hasShellCavity,
    isClosedKettle,
    isDualHeadOrVentedSnare,
    shellVolumeM3,
    shellDepthM,
    shellHelmholtzHz,
  };
}

function evaluateTensionedMembraneInternal(
  node: SceneNode,
  sceneNodes: SceneNode[] | undefined,
  strikeCtx: MembraneStrikeContext | undefined,
  preResolvedShell: ResolvedMembraneShellInfo | undefined,
  skipShellIr: boolean,
): MembraneEvaluation | null {
  const spec = node.acousticMembrane;
  if (!spec) return null;

  const mat = MEMBRANE_MATERIALS[spec.material] ?? MEMBRANE_MATERIALS.mylar;
  const thicknessMm = Number.isFinite(spec.thicknessMm) ? Math.max(0.04, Math.min(4.0, spec.thicknessMm)) : 0.25;
  const h = thicknessMm * 1e-3;
  const tensionNPerM = Number.isFinite(spec.tensionNPerM) ? Math.max(15, Math.min(80000, spec.tensionNPerM)) : 1800;

  const resolved = preResolvedShell ?? resolveMembraneShellInfo(node, spec, sceneNodes);
  const {
    plan,
    shellNode,
    hasShellCavity,
    isClosedKettle,
    isDualHeadOrVentedSnare,
    shellVolumeM3,
    shellDepthM,
    shellHelmholtzHz,
  } = resolved;
  const { shape, radiusM: a, spanXM, spanYM } = plan;
  const areaM2 = shape === 'circular' ? Math.PI * a * a : spanXM * spanYM;

  const E = mat.modulusGPa * 1e9;
  const nu = mat.poisson;
  const D = (E * h * h * h) / (12 * (1 - nu * nu));
  const sigmaFilm = mat.densityKgM3 * h;
  const waveSpeedMps = Math.sqrt(tensionNPerM / Math.max(1e-5, sigmaFilm));
  const tensileStressMPa = (tensionNPerM / h) * 1e-6;
  const stressRatio = tensileStressMPa / mat.ultimateStrengthMPa;

  const warnings: string[] = [];
  if (stressRatio >= 1.0) {
    warnings.push(
      `Head stress ${tensileStressMPa.toFixed(0)} MPa exceeds ${mat.label} tensile limit (${mat.ultimateStrengthMPa} MPa)`,
    );
  } else if (stressRatio >= 0.82) {
    warnings.push(
      `High head tension (${Math.round(stressRatio * 100)}% of ${mat.label} yield limit)`,
    );
  }

  const snareAmount = Math.max(0, Math.min(1, spec.snareBuzz ?? 0));

  // On a dual-head vented snare/tom (`isDualHeadOrVentedSnare`), the bottom resonant head moves in phase with the
  // batter head on (0,1) (Rossing §3.2–3.5: zero net sealed-kettle air compression -> default kettleStrength = 0!).
  const kettleStrength = Math.max(
    0,
    Math.min(
      1.5,
      spec.kettleCoupling ??
        (isClosedKettle ? 1.0 : isDualHeadOrVentedSnare ? 0 : hasShellCavity && shellHelmholtzHz !== null ? 0.35 : 0),
    ),
  );

  // Air radiation mass loading: baffled circular piston adds front air inertia proportional to rho_air * a * chi_{mn},
  // plus Christian–Davis–Tubis (1984) evanescent internal kettle air sloshing inertia on enclosed timpani bowls!
  const airMassScale = 0.85 + 0.35 * kettleStrength;

  // Normalize strike coordinates in head plane:
  // Default audition spot is ~0.18 R (fat center backbeat) on snare drums vs ~0.58 R (musical spot) on timpani/open heads.
  let normRadius = snareAmount > 0.05 ? 0.18 : 0.58;
  let normU = 0.37;
  let normV = 0.41;
  if (strikeCtx?.localPoint) {
    const du = strikeCtx.localPoint[plan.uAxis] - plan.centerLocal[plan.uAxis];
    const dv = strikeCtx.localPoint[plan.vAxis] - plan.centerLocal[plan.vAxis];
    normRadius = Math.max(0, Math.min(0.97, Math.hypot(du, dv) / Math.max(1e-4, a)));
    normU = Math.max(0.03, Math.min(0.97, (du + 0.5 * spanXM) / Math.max(1e-4, spanXM)));
    normV = Math.max(0.03, Math.min(0.97, (dv + 0.5 * spanYM) / Math.max(1e-4, spanYM)));
  }

  const rawFreqsHz: number[] = [];
  const rawBaseGains: number[] = [];
  const rawModeQs: number[] = [];
  const spatialWeights: number[] = [];
  const azimuthalFreqsHz: number[] = [];

  if (shape === 'circular') {
    for (let idx = 0; idx < CIRCULAR_BESSEL_MODES.length; idx++) {
      const bm = CIRCULAR_BESSEL_MODES[idx];
      // Baffled air-radiation inertia depresses low modes (especially (0,1) and (1,1)), compressing
      // azimuthal overtones (1,1):(2,1):(3,1):(4,1) from [1 : 1.34 : 1.66 : 1.98] -> [1 : 1.50 : 1.99 : 2.44]!
      const sigmaFrontAir = ((8 * AIR_DENSITY_KGM3 * a) / (3 * Math.PI)) * bm.airLoadingChi * airMassScale;
      let sigmaKettleAir = 0;
      if (bm.m >= 1 && isClosedKettle && hasShellCavity && shellVolumeM3 > 1e-5 && kettleStrength > 0) {
        const lkOverA = Math.max(0.35, shellVolumeM3 / Math.max(1e-5, areaM2 * a));
        const cothTerm = 1 / Math.tanh(Math.min(8, bm.jmn * lkOverA * 0.45));
        sigmaKettleAir = kettleStrength * ((5.2 * AIR_DENSITY_KGM3 * a) / Math.pow(bm.jmn, 1.72)) * cothTerm;
      } else if (bm.m === 0 && bm.n === 1 && isDualHeadOrVentedSnare && hasShellCavity) {
        // Dual-head snare/tom in-phase (0,1) mode carries the internal shell air plug without compressing it,
        // slightly lowering f_{01} into a warm, fat studio snare fundamental (~170–195 Hz)!
        sigmaKettleAir = 0.28 * AIR_DENSITY_KGM3 * Math.min(0.22, shellDepthM);
      }
      const sigmaEff = sigmaFilm + sigmaFrontAir + sigmaKettleAir;
      const stiffFactor = Math.sqrt(1 + (D * bm.jmn * bm.jmn) / Math.max(1e-6, tensionNPerM * a * a));
      let fMode = (bm.jmn / (2 * Math.PI * a)) * Math.sqrt(tensionNPerM / sigmaEff) * stiffFactor;

      // Axisymmetric modes (m === 0) displace net air volume and couple to an enclosed kettle or Helmholtz shell!
      if (bm.m === 0 && hasShellCavity && shellVolumeM3 > 1e-5 && kettleStrength > 0) {
        if (isClosedKettle) {
          // Adiabatic enclosed kettle bulk stiffness raises (0,1) (and slightly (0,2)) without shifting m >= 1 modes
          const netVolShare = bm.n === 1 ? 0.432 : 0.085;
          const cavStiffShiftHzSq =
            kettleStrength *
            netVolShare *
            ((AIR_DENSITY_KGM3 * SPEED_OF_SOUND_AIR * SPEED_OF_SOUND_AIR * areaM2) /
              (4 * Math.PI * Math.PI * shellVolumeM3 * sigmaEff));
          fMode = Math.sqrt(fMode * fMode + cavStiffShiftHzSq);
        } else if (bm.n === 1 && shellHelmholtzHz !== null && shellHelmholtzHz > 15) {
          // Single-head vented drum shell: gentle coupled-oscillator shift
          const fH = shellHelmholtzHz;
          const kappa = 0.18 * kettleStrength;
          const sumSq = fMode * fMode + fH * fH;
          const diffSq = fMode * fMode - fH * fH;
          const branchSign = diffSq >= 0 ? 1 : -1;
          fMode = Math.sqrt(
            Math.max(0, 0.5 * (sumSq + branchSign * Math.sqrt(diffSq * diffSq + 4 * kappa * kappa * fMode * fMode * fH * fH))),
          );
        }
      }

      if (bm.m >= 1 && bm.n === 1) {
        azimuthalFreqsHz.push(fMode);
      }

      // Bessel spatial strike factor |J_m(j_{mn} * r / a)| / peakAbsJm
      const jVal = Math.abs(besselJn(bm.m, bm.jmn * normRadius)) / bm.peakAbsJm;
      // Small finite beater-pad footprint (~6% of radius) prevents exact mathematical zero while keeping strong center/rim contrast!
      const spatial = bm.m === 0
        ? Math.max(0.08, jVal)
        : normRadius < 0.04
          ? 0.03 + 0.97 * jVal
          : Math.max(0.05, jVal);

      // Axisymmetric m = 0 modes radiate strongly as acoustic monopoles (fast radiation damping -> lower Q ~ 18..32),
      // whereas azimuthal m >= 1 dipole/quadrupole modes sustain on timpani, while snare-wire contact chatter on snare
      // drums (`snareAmount > 0.05`) damps high timbale/bongo ring so the fat (0,1) body dominates cleanly!
      const snareRingDamp =
        snareAmount > 0.05 && idx > 0 ? 1 + 2.4 * snareAmount * Math.sqrt(idx) : 1.0;
      const modeQ = bm.m === 0
        ? Math.min(mat.intrinsicQ * 0.42, 26) / (bm.n >= 2 && snareAmount > 0.05 ? 1 + 1.5 * snareAmount : 1)
        : mat.intrinsicQ / ((1 + 0.16 * idx) * snareRingDamp);

      const modeWeight =
        snareAmount > 0.05 && idx === 0
          ? bm.baseWeight * (1 + 0.22 * snareAmount)
          : snareAmount > 0.05 && (bm.m >= 2 || bm.n >= 2)
            ? bm.baseWeight * (1 - 0.34 * snareAmount)
            : bm.baseWeight;

      rawFreqsHz.push(fMode);
      rawBaseGains.push(modeWeight);
      rawModeQs.push(modeQ);
      spatialWeights.push(spatial);
    }
  } else {
    // Rectangular tensioned membrane (m, n) in {1..3} x {1..3}
    const rectPairs: [number, number, number][] = [
      [1, 1, 1.0],
      [1, 2, 0.72],
      [2, 1, 0.72],
      [2, 2, 0.50],
      [1, 3, 0.36],
      [3, 1, 0.36],
      [2, 3, 0.24],
      [3, 2, 0.24],
    ];
    for (let idx = 0; idx < rectPairs.length; idx++) {
      const [m, n, wBase] = rectPairs[idx];
      const chi = 1 / (1 + 0.68 * (m + n - 2));
      const sigmaAir = ((8 * AIR_DENSITY_KGM3 * a) / (3 * Math.PI)) * chi * airMassScale;
      const sigmaEff = sigmaFilm + sigmaAir;
      const kSq = Math.PI * Math.PI * ((m * m) / (spanXM * spanXM) + (n * n) / (spanYM * spanYM));
      const stiffFactor = Math.sqrt(1 + (D * kSq) / Math.max(1e-6, tensionNPerM));
      let fMode = (Math.sqrt(kSq * (tensionNPerM / sigmaEff)) / (2 * Math.PI)) * stiffFactor;

      // Odd-odd modes (both m, n odd) have non-zero net volume displacement and couple to enclosed cavity stiffness
      if ((m & 1) === 1 && (n & 1) === 1 && hasShellCavity && shellVolumeM3 > 1e-5 && kettleStrength > 0) {
        const volShare = 0.40 / (m * m * n * n);
        const cavShift =
          kettleStrength *
          volShare *
          ((AIR_DENSITY_KGM3 * SPEED_OF_SOUND_AIR * SPEED_OF_SOUND_AIR * areaM2) /
            (4 * Math.PI * Math.PI * shellVolumeM3 * sigmaEff));
        fMode = Math.sqrt(fMode * fMode + cavShift);
      }

      const spatial = Math.max(
        0.05,
        Math.abs(Math.sin(m * Math.PI * normU) * Math.sin(n * Math.PI * normV)),
      );
      const isMonopole = (m & 1) === 1 && (n & 1) === 1;
      const modeQ = isMonopole
        ? Math.min(mat.intrinsicQ * 0.45, 28)
        : mat.intrinsicQ / (1 + 0.18 * idx);

      rawFreqsHz.push(fMode);
      rawBaseGains.push(wBase);
      rawModeQs.push(modeQ);
      spatialWeights.push(spatial);
    }
  }

  // In-place insertion sort of 8 modes ascending in frequency (avoids 5 temporary array allocations per hit!)
  for (let i = 1; i < rawFreqsHz.length; i++) {
    const f = rawFreqsHz[i];
    const g = rawBaseGains[i];
    const q = rawModeQs[i];
    const sp = spatialWeights[i];
    let j = i - 1;
    while (j >= 0 && rawFreqsHz[j] > f) {
      rawFreqsHz[j + 1] = rawFreqsHz[j];
      rawBaseGains[j + 1] = rawBaseGains[j];
      rawModeQs[j + 1] = rawModeQs[j];
      spatialWeights[j + 1] = spatialWeights[j];
      j--;
    }
    rawFreqsHz[j + 1] = f;
    rawBaseGains[j + 1] = g;
    rawModeQs[j + 1] = q;
    spatialWeights[j + 1] = sp;
  }
  const sortedFreqs = rawFreqsHz;
  const sortedBaseGains = rawBaseGains;
  const sortedQs = rawModeQs;
  const sortedSpatial = spatialWeights;

  // Musical fundamental: on an enclosed kettle timpani, the (1,1) azimuthal mode is the perceived concert pitch
  // (with overtones (2,1)/(1,1) ≈ 1.50 and (3,1)/(1,1) ≈ 2.00!), whereas on open/vented drums it is f_{01} / f_{11}.
  const musicalRefHz =
    shape === 'circular' && isClosedKettle && kettleStrength >= 0.45 && azimuthalFreqsHz.length >= 2
      ? azimuthalFreqsHz[0]
      : sortedFreqs[0] ?? 110;
  const secondRefHz =
    shape === 'circular' && isClosedKettle && kettleStrength >= 0.45 && azimuthalFreqsHz.length >= 2
      ? azimuthalFreqsHz[1]
      : sortedFreqs[1] ?? musicalRefHz * 1.593;

  const modeRatios =
    shape === 'circular' && azimuthalFreqsHz.length >= 3 && isClosedKettle && kettleStrength >= 0.45
      ? azimuthalFreqsHz.map((f) => +(f / azimuthalFreqsHz[0]).toFixed(3))
      : sortedFreqs.slice(0, 5).map((f) => +(f / Math.max(1e-6, sortedFreqs[0])).toFixed(3));

  // Beater Hertzian contact duration tau_c (compliant felt/wood drumstick vs tensioned head stiffness)
  const strikerProps = strikeCtx?.strikerNode !== undefined
    ? inferColliderContactProps(strikeCtx.strikerNode, strikeCtx.strikerGeomName)
    : null;
  const impulseNs = Math.max(0.002, strikeCtx?.impulseNs ?? 0.35);
  const headEffectiveMassKg = Math.max(0.004, 0.43 * (sigmaFilm + AIR_DENSITY_KGM3 * a * 0.3) * areaM2);
  const mBeater = strikerProps ? Math.min(0.18, strikerProps.massKg) : 0.032;
  const kHead = Math.max(120, 4 * Math.PI * tensionNPerM);
  const tauBase = Math.PI * Math.sqrt(mBeater / (kHead * (1 + mBeater / headEffectiveMassKg)));
  const beaterSoftFactor = strikerProps
    ? Math.max(0.65, Math.min(1.65, Math.pow(2e9 / Math.max(1e7, strikerProps.modulusPa), 0.12)))
    : 1.0;
  const tauC = Math.max(0.00055, Math.min(0.0065, tauBase * beaterSoftFactor * 0.55));

  const voices: ModalVoice[] = [];
  for (let i = 0; i < sortedFreqs.length; i++) {
    const f = sortedFreqs[i];
    if (f < 22 || f > 16000) continue;
    const x = f * tauC;
    const pulse = Math.abs(x - 0.5) < 1e-3
      ? Math.PI / 4
      : x <= 1.2
        ? Math.abs(Math.cos(Math.PI * x) / (1 - 4 * x * x))
        : 0.72 / (4 * x * x - 1);
    const gain = sortedBaseGains[i] * Math.min(1.25, pulse * 1.12) * sortedSpatial[i];
    if (gain < 0.005) continue;
    const decaySec = Math.max(0.028, Math.min(4.0, (sortedQs[i] / (Math.PI * f)) * 2.8));
    voices.push({
      freqHz: +f.toFixed(2),
      gain: +gain.toFixed(4),
      decaySec: +decaySec.toFixed(4),
    });
  }

  // Hard-strike nonlinear tension-modulation pitch drop:
  //   T(t) = T_0 + dT_0 * exp(-2*t / tau_01),   dT_0 = (E * h / (2 * a^2)) * A_0^2
  const omega01 = 2 * Math.PI * Math.max(25, sortedFreqs[0] ?? 100);
  const peakDeflectionM = Math.min(0.025, impulseNs / Math.max(1e-4, headEffectiveMassKg * omega01));
  const nlScale = Math.max(0, Math.min(3.0, spec.nonlinearGlide ?? 1.0));
  const dT0 = nlScale * ((0.5 * E * h * peakDeflectionM * peakDeflectionM) / Math.max(4e-4, a * a));
  const physicalGammaNl = Math.max(0, Math.min(0.65, dT0 / Math.max(15, tensionNPerM)));

  let pitchGlideSemitones: number;
  let initialRatio: number;
  if (typeof spec.pitchGlideSemitones === 'number' && Number.isFinite(spec.pitchGlideSemitones)) {
    // Scale explicit max pitch-glide semitones smoothly with normalized strike energy so light taps stay subtle
    const energyNorm = Math.min(1.35, Math.pow(impulseNs / 0.45, 0.85)) * nlScale;
    pitchGlideSemitones = Math.max(0, Math.min(9.0, spec.pitchGlideSemitones * energyNorm));
    initialRatio = Math.pow(2, pitchGlideSemitones / 12) - 1;
  } else {
    initialRatio = Math.sqrt(1 + physicalGammaNl) - 1;
    pitchGlideSemitones = 12 * Math.log2(1 + initialRatio);
  }
  const fundamentalDecaySec = voices[0]?.decaySec ?? 0.24;
  const glideTauSec =
    typeof spec.pitchGlideDecayMs === 'number' && Number.isFinite(spec.pitchGlideDecayMs) && spec.pitchGlideDecayMs > 0
      ? Math.max(0.012, Math.min(0.60, spec.pitchGlideDecayMs * 1e-3))
      : Math.max(0.032, Math.min(0.22, 0.38 * fundamentalDecaySec));

  // Bottom-head snare wire rattle (`snareBuzz` in [0, 1]): crisp 1.2–3.2 kHz steel wire snap
  // balanced so it complements rather than masks the fat ~180 Hz drum body!
  const snareExcitation = snareAmount * Math.min(1.2, Math.pow(Math.max(0, impulseNs - 0.004) * 5.5, 0.65));
  const snareRattle: SnareRattleEnvelope | null =
    snareExcitation > 0.015
      ? {
          gain: +(0.34 * snareExcitation).toFixed(4),
          decaySec: +Math.max(0.14, Math.min(0.42, fundamentalDecaySec * 1.12)).toFixed(4),
          modHz: +(sortedFreqs[0] ?? 180).toFixed(2),
          bandpassHz: 2150,
          highshelfHz: 4800,
        }
      : null;

  const acousticMat: AcousticMaterialProps = {
    label: mat.label,
    density: mat.densityKgM3,
    modulusGPa: mat.modulusGPa,
    qualityQ: mat.intrinsicQ,
    brightness: strikerProps ? Math.min(mat.brightness, strikerProps.brightness) : mat.brightness,
  };

  const shellIr = !skipShellIr && shellNode
    ? simulate3DVibroAcousticIR(shellNode, {
        modulusGPa: 11.0,
        density: 680,
        qualityQ: 120,
      })
    : null;

  const profile: BodyModalProfile = {
    fundamentalHz: +musicalRefHz.toFixed(2),
    overtoneRatio: +(secondRefHz / Math.max(1e-6, musicalRefHz)).toFixed(3),
    regime: 'plate',
    material: acousticMat,
    contactDurationSec: +tauC.toExponential(4),
    modes: voices,
    rawFreqsHz: sortedFreqs,
    rawBaseGains: sortedBaseGains,
    rawModeQs: sortedQs,
    massKg: headEffectiveMassKg,
    radiatingWidthM: 2 * a,
    bodyIr: shellIr?.ir ?? null,
    bodyIrSig: shellIr?.signature ?? '',
  };

  return {
    shape,
    radiusM: a,
    spanXM,
    spanYM,
    thicknessM: h,
    arealDensityKgM2: +sigmaFilm.toFixed(5),
    waveSpeedMps: +waveSpeedMps.toFixed(2),
    tensileStressMPa: +tensileStressMPa.toFixed(2),
    stressRatio: +stressRatio.toFixed(3),
    fundamentalHz: profile.fundamentalHz,
    overtoneRatio: profile.overtoneRatio,
    modeRatios,
    hasShellCavity,
    isClosedKettle,
    shellVolumeLitres: +(shellVolumeM3 * 1000).toFixed(3),
    shellHelmholtzHz: shellHelmholtzHz !== null ? +shellHelmholtzHz.toFixed(2) : null,
    warnings,
    profile,
    pitchGlide: {
      initialRatio: +initialRatio.toFixed(5),
      semitones: +pitchGlideSemitones.toFixed(3),
      glideTauSec: +glideTauSec.toFixed(4),
    },
    snareRattle,
  };
}

/**
 * Evaluates a tensioned 2D circular or rectangular membrane (`node.acousticMembrane`),
 * including enclosed kettle / vented shell air coupling, strike-point modal weights,
 * nonlinear tension-modulation pitch drop, and snare wire rattle.
 */
export function evaluateTensionedMembrane(
  node: SceneNode,
  sceneNodes?: SceneNode[],
  strikeCtx?: MembraneStrikeContext,
): MembraneEvaluation | null {
  return evaluateTensionedMembraneInternal(node, sceneNodes, strikeCtx, undefined, false);
}

/**
 * Convenience two-body impact wrapper for Wave 2B (`modalAudio.ts` / `physicsEngine.ts`):
 * resolves strike-radius-weighted Bessel/rectangular voices, beater Hertzian filtering,
 * hard-strike tension pitch glide, and snare wire rattle in one call.
 */
export function solveMembraneImpact(
  node: SceneNode,
  sceneNodes: SceneNode[] | undefined,
  opts: {
    impulseNs: number;
    localPoint?: [number, number, number];
    strikerNode?: SceneNode | null;
    strikerGeomName?: string;
  },
): {
  evaluation: MembraneEvaluation;
  voices: ModalVoice[];
  tauC: number;
  effectiveBrightness: number;
  radiationScale: number;
  pitchGlide: MembranePitchGlideEnvelope;
  snareRattle: SnareRattleEnvelope | null;
  bodyIr: Float32Array<ArrayBuffer> | null;
  bodyIrSig: string;
} | null {
  const evaluation = evaluateTensionedMembrane(node, sceneNodes, opts);
  if (!evaluation) return null;
  const tauC = evaluation.profile.contactDurationSec;
  const radiationScale = Math.min(1.32, 0.92 + 1.4 * Math.min(0.28, evaluation.radiusM * 2));
  return {
    evaluation,
    voices: evaluation.profile.modes,
    tauC,
    effectiveBrightness: evaluation.profile.material.brightness,
    radiationScale,
    pitchGlide: evaluation.pitchGlide,
    snareRattle: evaluation.snareRattle,
    bodyIr: evaluation.profile.bodyIr ?? null,
    bodyIrSig: evaluation.profile.bodyIrSig ?? '',
  };
}

/**
 * Tunes a tensioned 2D membrane (`node.acousticMembrane`, or initializes a default mylar head
 * when called on an untagged drumhead disk) to `targetHz` by solving for isotropic line tension
 * `tensionNPerM` (adjusting film thickness when needed to stay safely below tensile yield!).
 */
export function tuneMembraneToPitch(
  node: SceneNode,
  targetHzRaw: number,
  sceneNodes?: SceneNode[],
): SceneNode {
  const safeTargetHz = Number.isFinite(targetHzRaw) ? targetHzRaw : 261.63;
  const targetHz = Math.max(25, Math.min(2500, safeTargetHz));
  const baseSpec: AcousticMembraneSpec = node.acousticMembrane
    ? { ...node.acousticMembrane }
    : {
        material: 'coated_film',
        tensionNPerM: 1800,
        thicknessMm: 0.25,
      };
  const mat = MEMBRANE_MATERIALS[baseSpec.material] ?? MEMBRANE_MATERIALS.coated_film;

  // Resolve planform & drum shell cavity ONCE before the 18-step bisection loop!
  const sharedShellInfo = resolveMembraneShellInfo(node, baseSpec, sceneNodes);
  const evalAtTension = (T: number, thickMm: number): MembraneEvaluation => {
    const probe: SceneNode = {
      ...node,
      acousticMembrane: {
        ...baseSpec,
        tensionNPerM: T,
        thicknessMm: thickMm,
      },
    };
    return evaluateTensionedMembraneInternal(probe, sceneNodes, undefined, sharedShellInfo, true)!;
  };

  let thickMm = Math.max(0.08, Math.min(1.5, baseSpec.thicknessMm || 0.25));

  // Bisection over tension because enclosed kettle air stiffness adds a tension-independent offset to m = 0 modes!
  let loT = 15;
  let hiT = 75000;
  const fLo = evalAtTension(loT, thickMm).fundamentalHz;
  if (targetHz <= fLo) {
    // Thicken head slightly if target bass pitch lies below minimum slack tension
    thickMm = Math.min(2.0, thickMm * Math.pow(fLo / targetHz, 2) * 1.15);
  }
  let curEval: MembraneEvaluation;
  for (let iter = 0; iter < 18; iter++) {
    const midT = 0.5 * (loT + hiT);
    curEval = evalAtTension(midT, thickMm);
    if (curEval.fundamentalHz < targetHz) loT = midT;
    else hiT = midT;
  }

  let bestT = +(0.5 * (loT + hiT)).toFixed(2);
  curEval = evalAtTension(bestT, thickMm);

  // If film stress exceeds 80% of material ultimate strength, clamp safely below 88% ultimate yield
  if (curEval.stressRatio > 0.80) {
    // Wait: sigma_stress = T / h, while T ∝ sigma_areal = rho * h => T / h ≈ rho * (2π a f / j)^2 is independent of h!
    // Clamp tension safely below 88% ultimate yield if extreme pitch exceeds physical film wave-speed limit.
    const maxSafeT = 0.88 * mat.ultimateStrengthMPa * 1e6 * (thickMm * 1e-3);
    if (bestT > maxSafeT) {
      bestT = +maxSafeT.toFixed(2);
    }
  }

  return {
    ...node,
    tunedPitchHz: +targetHz.toFixed(2),
    acousticMembrane: {
      ...baseSpec,
      tensionNPerM: bestT,
      thicknessMm: +thickMm.toFixed(3),
    },
  };
}
