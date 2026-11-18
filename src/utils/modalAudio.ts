// ---------------------------------------------------------------------------
// Modal Impact Audio (Zero-Sample Physical Synthesis)
// ---------------------------------------------------------------------------
//
// Derives structural vibration modes (frequencies, relative gains, decay times)
// directly from a body's geometry and material (Euler-Bernoulli free-free beam
// / tube, variable-section luthier-arched marimba bar via 10-mode Legendre
// Rayleigh-Ritz, Kirchhoff plate, or 3D solid block).
//
// Synthesises collision sounds in WebAudio with damped sinusoidal + filtered
// transient resonators — zero audio files, muted by default.
// ---------------------------------------------------------------------------

import type { SceneGeom, SceneNode } from '../types/scene';
import { deformMaterial, geomVolume } from './deformMaterials';
import { geomHydroTriangles } from './hydrostatics';
import {
  getOrInitModalWorklet,
  postWorkletWindSilence,
  postWorkletWindUpdate,
  type WorkletWindVoicePayload,
} from './modalAudioWorklet';

export interface AcousticMaterialProps {
  label: string;
  density: number;
  modulusGPa: number;
  /** Mechanical quality factor Q (higher = longer sustain, e.g. steel ~900, wood ~130, plastic ~42). */
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
  /** Physical Hertz elastic contact duration τ_c (s) at 1 m/s reference impact speed: τ_c = 2.87 (ρ(1-ν²)/E)^0.4 R_eff. */
  contactDurationSec: number;
  /** Audible structural modes (only modes below the ~18 kHz human hearing ceiling, weighted by the Hertz contact pulse spectrum). */
  modes: ModalVoice[];
}

/**
 * Collects the solid geoms that actually participate in impacts on `node`,
 * including jointless welded child bodies (e.g. `cradle_bob_body_*` under
 * `cradle_*` in Newton's Cradle) while skipping non-colliding `contype: 0`
 * suspension strings/rods whenever colliding geoms exist.
 */
function collectAcousticSubtree(node: SceneNode): { geoms: SceneGeom[]; materialHost: SceneNode } {
  const colliding: { geom: SceneGeom; host: SceneNode }[] = [];
  const allSolid: { geom: SceneGeom; host: SceneNode }[] = [];

  const visit = (n: SceneNode, isRoot: boolean) => {
    if (!isRoot && ((n.joints?.length ?? 0) > 0 || n.simulation)) return;
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
  hardwood: { q: 145, brightness: 0.58 },
  softwood: { q: 95, brightness: 0.48 },
  stone: { q: 110, brightness: 0.65 },
  plastic: { q: 42, brightness: 0.42 },
  pasta: { q: 55, brightness: 0.6 },
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
    return { label: 'Steel', density: Math.min(8050, Math.max(7500, rho)), modulusGPa: 200, qualityQ: 920, brightness: 0.94 };
  }
  if (rho >= 2550) {
    return { label: 'Aluminium / Alloy', density: rho, modulusGPa: 69, qualityQ: 760, brightness: 0.84 };
  }
  if (rho >= 2100) {
    return { label: 'Glass / Ceramic', density: rho, modulusGPa: 70, qualityQ: 540, brightness: 0.92 };
  }
  if (rho >= 550 && rho <= 920) {
    return { label: 'Hardwood', density: rho, modulusGPa: 12.5, qualityQ: 145, brightness: 0.58 };
  }
  if (rho < 550) {
    return { label: 'Softwood', density: rho, modulusGPa: 9.0, qualityQ: 95, brightness: 0.48 };
  }
  if (stiffContact) {
    return { label: 'Hard Acrylic / Phenolic', density: rho, modulusGPa: 6.5, qualityQ: 120, brightness: 0.78 };
  }
  return { label: 'Polymer', density: rho, modulusGPa: 2.8, qualityQ: 45, brightness: 0.42 };
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

/** Jacobi eigenvalues (ascending) of a small symmetric N×N matrix. */
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
          return 1 / (Math.abs(phi) + Math.sqrt(phi * phi + 1)) * (phi < 0 ? -1 : 1);
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
 * Computes exact variational free-free Euler-Bernoulli flexural frequencies (Hz)
 * [f1, f2, f3] of a rectangular bar of length `lengthM` whose thickness along
 * `x in [-lengthM/2, +lengthM/2]` is given by `thicknessAtX(x)`.
 */
export function solveVariableBeamModes(
  lengthM: number,
  modulusPa: number,
  densityKgM3: number,
  thicknessAtX: (x: number) => number,
): [number, number, number] {
  const nBasis = 10; // P_0..P_9 -> 2 rigid modes + 8 elastic modes
  const nQuad = 64;
  const K = Array.from({ length: nBasis }, () => new Array<number>(nBasis).fill(0));
  const M = Array.from({ length: nBasis }, () => new Array<number>(nBasis).fill(0));
  const halfL = lengthM * 0.5;
  // dx = halfL * dxi, d²w/dx² = (1 / halfL²) d²w/dξ²
  const invHalfL4 = 1 / Math.pow(halfL, 4);

  for (let q = 0; q < nQuad; q++) {
    const xi = -1 + ((q + 0.5) * 2) / nQuad;
    const dxi = 2 / nQuad;
    const x = xi * halfL;
    const h = Math.max(1e-4, thicknessAtX(x));
    // Width b cancels between EI = b*h^3/12 and rho*A = rho*b*h!
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

  // Cholesky M = L * L^T to reduce K v = omega^2 M v to standard symmetric L^-1 K L^-T y = omega^2 y
  const L = Array.from({ length: nBasis }, () => new Array<number>(nBasis).fill(0));
  for (let i = 0; i < nBasis; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = M[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        L[i][i] = Math.sqrt(Math.max(1e-24, sum));
      } else {
        L[i][j] = sum / L[j][j];
      }
    }
  }
  // Invert lower triangular L -> Linv
  const Linv = Array.from({ length: nBasis }, () => new Array<number>(nBasis).fill(0));
  for (let i = 0; i < nBasis; i++) {
    Linv[i][i] = 1 / L[i][i];
    for (let j = 0; j < i; j++) {
      let sum = 0;
      for (let k = j; k < i; k++) sum += L[i][k] * Linv[k][j];
      Linv[i][j] = -sum / L[i][i];
    }
  }
  // C = Linv * K * Linv^T
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
  // First two eigenvalues are 0 (rigid-body translation & rotation); elastic modes start at index 2
  const elasticHz = eigOmegaSq
    .slice(2)
    .map((w2) => Math.sqrt(Math.max(0, w2)) / (2 * Math.PI));

  const f1 = Math.max(15, elasticHz[0] ?? 220);
  const f2 = Math.max(f1 * 1.5, elasticHz[1] ?? f1 * 2.756);
  const f3 = Math.max(f2 * 1.2, elasticHz[2] ?? f1 * 5.404);
  return [f1, f2, f3];
}

function measureLocalExtents(node: SceneNode): {
  dimsSortedAsc: [number, number, number];
  axisOrderAsc: [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2];
  primaryGeom: SceneGeom | undefined;
} {
  const { geoms: solidGeoms } = collectAcousticSubtree(node);
  const primaryGeom = solidGeoms[0];
  const tris: number[] = [];
  for (const g of solidGeoms) geomHydroTriangles(g, tris);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i + 2 < tris.length; i += 3) {
    if (tris[i] < minX) minX = tris[i];
    if (tris[i + 1] < minY) minY = tris[i + 1];
    if (tris[i + 2] < minZ) minZ = tris[i + 2];
    if (tris[i] > maxX) maxX = tris[i];
    if (tris[i + 1] > maxY) maxY = tris[i + 1];
    if (tris[i + 2] > maxZ) maxZ = tris[i + 2];
  }
  const dx = Number.isFinite(minX) ? Math.max(0.002, maxX - minX) : 0.05;
  const dy = Number.isFinite(minY) ? Math.max(0.002, maxY - minY) : 0.05;
  const dz = Number.isFinite(minZ) ? Math.max(0.002, maxZ - minZ) : 0.05;
  const pairs: { len: number; axis: 0 | 1 | 2 }[] = [
    { len: dx, axis: 0 },
    { len: dy, axis: 1 },
    { len: dz, axis: 2 },
  ];
  pairs.sort((a, b) => a.len - b.len);
  return {
    dimsSortedAsc: [pairs[0].len, pairs[1].len, pairs[2].len],
    axisOrderAsc: [pairs[0].axis, pairs[1].axis, pairs[2].axis],
    primaryGeom,
  };
}

/**
 * Estimates a body's physical vibration modes from its dimensions, material,
 * hollow tube wall, or underside luthier tuning arch.
 */
export function estimateBodyModes(node: SceneNode): BodyModalProfile {
  const mat = inferAcousticMaterial(node);
  const E = mat.modulusGPa * 1e9;
  const rho = Math.max(50, mat.density);
  const cLong = Math.sqrt(E / rho); // longitudinal wave speed (m/s)
  const { dimsSortedAsc, axisOrderAsc, primaryGeom } = measureLocalExtents(node);
  const [hMin, bMid, lMax] = dimsSortedAsc;
  const [thickAxis, , lenAxis] = axisOrderAsc;

  let regime: BodyModalProfile['regime'] = 'block';
  let freqs: number[] = [];
  let gains = [1.0, 0.52, 0.28, 0.16];

  // Check if tuned with an underside `luthier_arch` boolean cutter
  const archCut = (node.geoms ?? []).find((g) => g.name === 'luthier_arch' && g.csg === 'difference');
  if (archCut && archCut.type === 'ellipsoid' && archCut.size.length >= 3) {
    regime = 'arched_bar';
    const halfSpan = Math.max(0.005, Math.min(lMax * 0.49, archCut.size[lenAxis] ?? lMax * 0.34));
    const cutDepth = Math.max(0, Math.min(hMin * 0.88, archCut.size[thickAxis] ?? hMin * 0.5));
    const [f1, f2, f3] = solveVariableBeamModes(lMax, E, rho, (x) => {
      const u = x / halfSpan;
      if (Math.abs(u) >= 1) return hMin;
      return Math.max(hMin * 0.08, hMin - cutDepth * Math.sqrt(1 - u * u));
    });
    freqs = [f1, f2, f3, f3 * 1.65];
    gains = typeof node.tunedPitchHz === 'number' ? [1.0, 0.24, 0.09, 0.03] : [1.0, 0.52, 0.22, 0.10];
  } else if (
    node.isTube ||
    primaryGeom?.type === 'cylinder' ||
    primaryGeom?.type === 'capsule'
  ) {
    // Cylindrical rod / chime tube: check if hollow tube or cylinder with coaxial bore
    const outerR = node.outerRadius ?? (primaryGeom?.type === 'cylinder' || primaryGeom?.type === 'capsule'
      ? (primaryGeom.size[0] ?? bMid * 0.5)
      : bMid * 0.5);
    const boreCut = (node.geoms ?? []).find((g) => g.csg === 'difference' && g.type === 'cylinder');
    const innerR = node.innerRadius ?? (boreCut?.size?.[0] ?? 0);
    const len = lMax;
    if (len / Math.max(1e-4, 2 * outerR) >= 2.2) {
      regime = 'tube';
      // Radius of gyration kappa = 0.5 * sqrt(r_out^2 + r_in^2) for circular/annular cross-section
      const kappa = 0.5 * Math.sqrt(outerR * outerR + innerR * innerR);
      const beta1Sq = 4.73004074 * 4.73004074;
      const f1 = (beta1Sq / (2 * Math.PI)) * (kappa / (len * len)) * cLong;
      freqs = [f1, f1 * 2.7565, f1 * 5.4039, f1 * 8.933];
      gains = [1.0, 0.62, 0.34, 0.18];
    }
  }

  if (freqs.length === 0) {
    if (lMax / bMid >= 2.1 && lMax / hMin >= 3.0) {
      // Uniform free-free bar (marimba / xylophone blank)
      regime = 'bar';
      const kappa = hMin / Math.sqrt(12);
      const beta1Sq = 4.73004074 * 4.73004074;
      const f1 = (beta1Sq / (2 * Math.PI)) * (kappa / (lMax * lMax)) * cLong;
      freqs = [f1, f1 * 2.7565, f1 * 5.4039, f1 * 8.933];
      gains = [1.0, 0.55, 0.28, 0.14];
    } else if (bMid / hMin >= 3.2) {
      // Thin Kirchhoff plate
      regime = 'plate';
      const nu = 0.3;
      const plateFactor = hMin / Math.sqrt(12 * (1 - nu * nu));
      const f1 = 1.65 * plateFactor * cLong * (1 / (lMax * lMax) + 1 / (bMid * bMid));
      freqs = [f1, f1 * 1.52, f1 * 2.38, f1 * 3.41];
      gains = [1.0, 0.65, 0.38, 0.22];
    } else {
      // Compact 3D block / part / sphere:
      // - Solid stiff metal/glass spheres (< 80 mm) have ultrasonic spheroidal Lamb modes (0.42 * c / d > 20 kHz),
      //   so they radiate a pure rigid-body contact clack without sustained tonal ringing.
      // - Everyday 3D parts, cubes, sculptures, and printed shells vibrate in flexural wall / table-coupled
      //   modes (~90–950 Hz) rather than multi-kHz bulk longitudinal P-waves!
      regime = 'block';
      const isSolidHardSphere =
        primaryGeom?.type === 'sphere' && mat.modulusGPa >= 50 && lMax <= 0.085;
      if (isSolidHardSphere) {
        const f1 = (0.42 * cLong) / Math.max(0.004, lMax);
        freqs = [f1, f1 * 1.45, f1 * 1.92];
        gains = [1.0, 0.45, 0.22];
      } else {
        const hEff = Math.min(0.14 * hMin, 0.0022 + 0.028 * hMin);
        const rawFlexHz = (0.22 * hEff * cLong) / Math.max(0.0025, lMax * lMax);
        const f1 = Math.max(65, Math.min(980, rawFlexHz));
        const aspectA = lMax / Math.max(1e-4, bMid);
        const aspectB = bMid / Math.max(1e-4, hMin);
        freqs = [
          f1,
          f1 * (1.34 + 0.16 * Math.min(2, aspectA)),
          f1 * (1.82 + 0.2 * Math.min(2, aspectB)),
          f1 * 2.46,
        ];
        gains = [1.0, 0.46, 0.22, 0.1];
      }
    }
  }

  // If user explicitly calibrated tunedPitchHz, anchor f1 cleanly to exact concert pitch
  if (typeof node.tunedPitchHz === 'number' && node.tunedPitchHz > 15) {
    const scale = node.tunedPitchHz / Math.max(1e-6, freqs[0]);
    if (Math.abs(scale - 1) < 0.08 || regime === 'block') {
      freqs = freqs.map((f) => f * scale);
    }
  }

  // Macroscopic elastic contact duration (Hertzian scaling widened by real surface asperity & air/frame coupling):
  //   - 40 mm steel sphere: τ_c ≈ 0.48 ms -> warm, crisp ~1.0 kHz billiard/cradle "clack" (not an 8 kHz tick)
  //   - 40 mm polymer ball: τ_c ≈ 1.25 ms -> ~400 Hz knock
  //   - 160 mm block:       τ_c ≈ 2.6 ms  -> ~200 Hz thud
  const nu = 0.3;
  const rEff = 0.5 * Math.cbrt(hMin * bMid * lMax);
  const idealHertzTau = 2.87 * Math.pow((rho * (1 - nu * nu)) / E, 0.4) * rEff;
  const contactDurationSec = Math.max(
    0.00038,
    Math.min(0.0055, 7.5 * idealHertzTau),
  );

  const fundamentalHz = +freqs[0].toFixed(2);
  const overtoneRatio = +(freqs[1] / Math.max(1e-6, freqs[0])).toFixed(3);

  // Only modes within human hearing (< 18 kHz) ring as sinusoidal voices, weighted by
  // the Fourier spectrum of the half-sine Hertz force pulse |F(f)| = |cos(π f τ_c) / (1 - (2 f τ_c)²)|.
  // Ultrasonic modes (e.g. 48 kHz Lamb mode of a 40 mm steel ball) naturally drop out instead
  // of being folded down into an artificial whistle, leaving the pure Koss-Alfredson contact pulse!
  const modes: ModalVoice[] = [];
  for (let idx = 0; idx < freqs.length; idx++) {
    const rawHz = freqs[idx];
    if (rawHz < 24 || rawHz > 18000) continue;
    const x = rawHz * contactDurationSec;
    const pulseExcitation = Math.abs(x - 0.5) < 1e-3
      ? Math.PI / 4
      : Math.abs(Math.cos(Math.PI * x) / (1 - 4 * x * x));
    const weightedGain = (gains[idx] ?? 0.12) * Math.min(1.15, 0.35 + 0.85 * pulseExcitation);
    if (weightedGain < 0.008) continue;
    const modeQ = mat.qualityQ / (1 + 0.42 * idx);
    const decaySec = Math.max(0.014, Math.min(4.2, (modeQ / (Math.PI * rawHz)) * 2.8));
    modes.push({
      freqHz: +rawHz.toFixed(2),
      gain: +weightedGain.toFixed(3),
      decaySec: +decaySec.toFixed(4),
    });
  }

  return {
    fundamentalHz,
    overtoneRatio,
    regime,
    material: mat,
    contactDurationSec: +contactDurationSec.toExponential(4),
    modes,
  };
}

// ---------------------------------------------------------------------------
// Zero-sample WebAudio synthesiser (browser-only, safe no-op in Node/Vitest)
// ---------------------------------------------------------------------------

type WindowWithAudioCtx = Window & {
  __physboxSharedAudioCtx?: AudioContext;
  __physboxGestureHookInstalled?: boolean;
};

let sharedAudioCtx: AudioContext | null = null;
let activeVoices = 0;
const MAX_ACTIVE_VOICES = 96;

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

/**
 * Unlocks and resumes the shared WebAudio context synchronously inside a DOM
 * user gesture (click / pointerdown / keydown). Essential because Chrome blocks
 * `AudioContext.resume()` when called asynchronously inside `Worker.onmessage`!
 */
export function unlockAudioContext(): AudioContext | null {
  const ctx = getAudioContext();
  if (!ctx) return null;
  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => {});
  }
  try {
    // 1-frame silent buffer unlock for WebKit/Chromium autoplay gate
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

// Only where `window` takes listeners: a test's stub `window` (or a worker shim) may not.
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
}

/**
 * Plays a physical modal impact (or string pluck) for `profile` scaled by impulse `impulseNs`.
 * Uses WebAudio's native C++ audio-thread `OscillatorNode` + `BiquadFilterNode` graph directly
 * (proven 100% reliable across all browsers/tabs, zero JS-thread sample loops!).
 */
export function playModalImpact(profile: BodyModalProfile, impulseNs: number, _isPluck = false): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  // Compress dynamic range smoothly from tiny taps (0.002 N*s) to heavy blows (10 N*s)
  const level = Math.min(0.45, 0.14 * Math.log10(1 + Math.max(0.0005, impulseNs) * 45));
  if (level < 0.004) return;
  if (activeVoices >= MAX_ACTIVE_VOICES) return;

  const vScale = Math.pow(Math.max(0.08, Math.min(6, impulseNs * 1.8)), -0.15);
  const tauC = Math.max(0.00038, Math.min(0.006, profile.contactDurationSec * vScale));

  const now = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.setValueAtTime(level, now);
  master.connect(ctx.destination);

  let longest = 0.05;
  for (const m of profile.modes) {
    if (activeVoices >= MAX_ACTIVE_VOICES) break;
    activeVoices++;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(m.freqHz, now);

    const dur = Math.min(3.5, m.decaySec);
    if (dur > longest) longest = dur;
    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(m.gain, now + 0.0018);
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

  // Universal Koss–Alfredson Hertzian rigid-body acceleration pressure pulse (fallback path):
  const totalPulseDur = Math.max(0.012, tauC * 9);
  const sampleCount = Math.max(64, Math.ceil(ctx.sampleRate * totalPulseDur));
  const pulseBuf = ctx.createBuffer(1, sampleCount, ctx.sampleRate);
  const data = pulseBuf.getChannelData(0);
  for (let i = 0; i < sampleCount; i++) {
    const t = i / ctx.sampleRate;
    let sample: number;
    if (t < tauC) {
      const u = (Math.PI * t) / tauC;
      sample = 1.25 * Math.sqrt(Math.max(0, Math.sin(u))) * Math.cos(u);
    } else {
      const dt = (t - tauC) / tauC;
      sample = -0.34 * Math.exp(-dt * 1.15) * Math.cos(1.6 * dt);
    }
    const texEnv = Math.exp(-t / (tauC * 2.2));
    data[i] = sample + 0.08 * profile.material.brightness * (Math.random() * 2 - 1) * texEnv;
  }
  const pulseSrc = ctx.createBufferSource();
  pulseSrc.buffer = pulseBuf;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(1100 + 2400 * profile.material.brightness, now);
  lp.Q.setValueAtTime(0.85, now);
  const clickGain = ctx.createGain();
  const pulseWeight = profile.modes.length === 0 ? 1.45 : 0.4 + 0.4 * profile.material.brightness;
  clickGain.gain.setValueAtTime(level * pulseWeight, now);
  pulseSrc.connect(lp);
  lp.connect(clickGain);
  clickGain.connect(ctx.destination);
  pulseSrc.start(now);

  setTimeout(() => {
    master.disconnect();
    clickGain.disconnect();
  }, Math.ceil((longest + 0.1) * 1000));
}

/** Auditions a clean mallet tap on `node` in the Inspector (works even when simulation audio is muted). */
export function playModalTap(node: SceneNode): BodyModalProfile {
  const profile = estimateBodyModes(node);
  playModalImpact(profile, 0.35);
  return profile;
}

/** Streams active 1D Kelly–Lochbaum wind/brass bore parameters to the off-main-thread AudioWorklet. */
export function updateLiveWindVoices(voices: WorkletWindVoicePayload[]): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  postWorkletWindUpdate(ctx, voices);
}

/** Immediately fades out all continuous wind/brass bore voices (on Stop or Mute). */
export function silenceWindVoices(): void {
  postWorkletWindSilence(sharedAudioCtx);
}
