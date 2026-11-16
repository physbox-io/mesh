// ---------------------------------------------------------------------------
// Taut Musical Strings & Coupled Soundbox (Helmholtz + Soundboard) Acoustics
// ---------------------------------------------------------------------------
//
// Physics implemented:
// 1. Mersenne's Law for stretched strings:
//      f0 = (1 / (2 * L)) * sqrt(T / mu),   mu = rho * pi * r^2
// 2. Fletcher's stiff-string dispersion (inharmonicity):
//      f_n = n * f0 * sqrt(1 + B * n^2),    B = (pi^3 * E * r^4) / (8 * T * L^2)
// 3. Tensile breaking-stress check:
//      sigma = T / (pi * r^2) vs ultimate strength sigma_ult (MPa)
// 4. Bridge -> Soundbox Acoustic Coupling:
//    - Inspects the host/bridge body's internal air cavity V and soundhole port
//      (via `measureBodyCavity` on watertight meshes AND analytic boolean/shell
//      inspection before OpenSCAD runs).
//    - Computes exact Helmholtz air-cavity frequency:
//        f_H = (c_air / (2 * pi)) * sqrt(A_port / (V * (L_port + 1.7 * r_port)))
//    - Computes soundboard top-plate flexural resonance f_top.
//    - Filters string harmonics through the coupled soundbox transfer function
//      H_box(f) AND excites sympathetic Helmholtz air-boom + soundboard modes!
// ---------------------------------------------------------------------------

import type {
  SceneGeom,
  SceneNode,
  StringMaterialId,
} from '../types/scene';
import { measureBodyCavity } from './cavity';
import { geomVolume } from './deformMaterials';
import { buildHydroBodyModel, geomHydroTriangles } from './hydrostatics';
import { estimateBodyModes, type BodyModalProfile, type ModalVoice } from './modalAudio';

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
  portRadiusMm: number | null;
  portLengthMm: number | null;
  /** Helmholtz air-cavity resonance frequency f_H (Hz), when a hollow cavity opens through a soundhole/port. */
  helmholtzHz: number | null;
  /** Primary soundboard / top-plate flexural resonance (Hz). */
  topPlateHz: number;
  /** Secondary body / back-plate resonance (Hz). */
  bodyModeHz: number;
  /** Acoustic radiation efficiency multiplier (0.28 for solid block, up to 1.25 for ported hollow soundbox). */
  radiationGain: number;
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

/** Measures the vibrating span L (m) of a string node from its primary capsule/cylinder/box geom. */
export function measureStringLengthM(node: SceneNode): number {
  const g = (node.geoms ?? []).find((x) => !x.csgDerived && x.csg !== 'difference');
  if (!g) return 0.32;
  if (g.fromto && g.fromto.length >= 6) {
    const dx = g.fromto[3] - g.fromto[0];
    const dy = g.fromto[4] - g.fromto[1];
    const dz = g.fromto[5] - g.fromto[2];
    const len = Math.hypot(dx, dy, dz);
    if (len > 1e-4) return len;
  }
  if (g.type === 'cylinder' || g.type === 'capsule') {
    return Math.max(0.02, 2 * (g.size[1] ?? 0.15));
  }
  if (g.type === 'box') {
    return Math.max(0.02, 2 * Math.max(g.size[0] ?? 0, g.size[1] ?? 0, g.size[2] ?? 0));
  }
  return 0.32;
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
 * Analyses a body as an acoustic soundbox: measures its internal air volume V and
 * soundhole port (via watertight `measureBodyCavity` when compiled, or directly
 * from boolean `difference` primitives / hollow plank assemblies when uncompiled)
 * to compute its Helmholtz air resonance f_H and soundboard plate modes.
 */
export function analyzeSoundboxResonance(host: SceneNode): SoundboxResonance {
  let cavityVolumeM3 = 0;
  let portRadiusM: number | null = null;
  let portLengthM: number | null = null;

  // 1. Try exact watertight mesh cavity + port measurement first
  const measured = measureBodyCavity(host);
  if (measured.ok && measured.cavity.volume > 1e-7) {
    cavityVolumeM3 = measured.cavity.volume;
    if (measured.cavity.port) {
      portRadiusM = measured.cavity.port.radius;
      portLengthM = measured.cavity.port.length;
    }
  }

  // 2. Fallback: inspect boolean `difference` cutters or hollow multi-plank shell directly!
  if (cavityVolumeM3 <= 1e-7) {
    const geoms = host.geoms ?? [];
    const positives = geoms.filter((g) => !g.csgDerived && g.csg !== 'difference' && g.role !== 'visual');
    const negatives = geoms.filter((g) => g.csg === 'difference');

    if (negatives.length > 0 && positives.length > 0) {
      const outerVol = positives.reduce((acc, g) => acc + geomVolume(g), 0);
      // Separate large interior hollowing cutters from narrower soundhole cylinder(s)
      const cylNegs = negatives.filter((g) => g.type === 'cylinder');
      let portGeom: SceneGeom | undefined;
      if (cylNegs.length > 0 && negatives.length >= 2) {
        // Smallest-volume cylinder cutter is the soundhole; larger cutter(s) form the air chamber
        portGeom = [...cylNegs].sort((a, b) => geomVolume(a) - geomVolume(b))[0];
      }
      let voidVol = 0;
      for (const neg of negatives) {
        if (neg === portGeom) continue;
        voidVol += geomVolume(neg);
      }
      if (voidVol > 1e-7) {
        cavityVolumeM3 = Math.min(outerVol * 0.92, voidVol);
      }
      if (portGeom) {
        portRadiusM = portGeom.size[0] ?? 0.02;
        // Estimate wall thickness pierced by the soundhole
        const posTris: number[] = [];
        for (const p of positives) geomHydroTriangles(p, posTris);
        let minZ = Infinity, maxZ = -Infinity;
        for (let i = 2; i < posTris.length; i += 3) {
          if (posTris[i] < minZ) minZ = posTris[i];
          if (posTris[i] > maxZ) maxZ = posTris[i];
        }
        const outerDepth = Number.isFinite(minZ) ? maxZ - minZ : 0.06;
        // Wall thickness ~ 3 mm typical top soundboard, bounded by cutter length
        portLengthM = Math.min(2 * (portGeom.size[1] ?? 0.005), Math.max(0.002, outerDepth * 0.06));
      }
    } else if (positives.length >= 4) {
      // Multi-plank hollow box (e.g. laser-cut / luthiery panel assembly)
      const hydro = buildHydroBodyModel(host);
      if (hydro?.vessel) {
        cavityVolumeM3 = Math.max(0, hydro.vessel.hullVolume - hydro.solidVolume);
        // Equivalent mouth radius from open area
        portRadiusM = Math.cbrt(cavityVolumeM3) * 0.28;
        portLengthM = 0.0035;
      }
    }
  }

  // Compute Helmholtz air resonance f_H = (c / 2π) * sqrt(A_port / (V * L_eff))
  let helmholtzHz: number | null = null;
  if (cavityVolumeM3 > 1e-6 && portRadiusM && portRadiusM > 0.002) {
    const areaPort = Math.PI * portRadiusM * portRadiusM;
    const neckLen = Math.max(0.0015, portLengthM ?? 0.003);
    // Rayleigh flanged end correction on both sides of soundboard: +1.7 * r_port
    const effectiveLen = neckLen + 1.7 * portRadiusM;
    const rawFh = (SPEED_OF_SOUND_AIR / (2 * Math.PI)) * Math.sqrt(areaPort / (cavityVolumeM3 * effectiveLen));
    helmholtzHz = +Math.max(35, Math.min(1200, rawFh)).toFixed(1);
  }

  // Soundboard top-plate & body modes
  const hostModes = estimateBodyModes(host);
  // Hollow soundboxes have thin plates (~2.5–3.5 mm spruce/wood top), placing T(1,1) around 170–320 Hz
  const topPlateHz = cavityVolumeM3 > 1e-6
    ? +Math.max(130, Math.min(520, (helmholtzHz ?? 120) * 1.82)).toFixed(1)
    : +Math.max(140, Math.min(900, hostModes.fundamentalHz)).toFixed(1);
  const bodyModeHz = +(topPlateHz * 1.54).toFixed(1);

  const hasHollowCavity = cavityVolumeM3 > 1e-6;
  const radiationGain = helmholtzHz !== null
    ? 1.18 // Ported acoustic soundbox (strong air + top-plate coupling!)
    : hasHollowCavity
      ? 0.78 // Sealed hollow chamber (top-plate coupling, no air port)
      : 0.30; // Solid-body / unmounted frame (quiet electric/monochord wire)

  return {
    hostNodeId: host.id,
    hostName: host.name || host.id,
    hasHollowCavity,
    cavityVolumeLitres: +(cavityVolumeM3 * 1000).toFixed(3),
    portRadiusMm: portRadiusM !== null ? +(portRadiusM * 1000).toFixed(1) : null,
    portLengthMm: portLengthM !== null ? +(portLengthM * 1000).toFixed(1) : null,
    helmholtzHz,
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

/**
 * Evaluates a taut string's Mersenne fundamental, Fletcher stiff-string harmonics,
 * breaking-stress safety, and coupled soundbox resonance profile.
 */
export function evaluateTautString(
  node: SceneNode,
  sceneNodes?: SceneNode[],
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
  let resonatorNode: SceneNode | null = null;
  if (sceneNodes?.length) {
    if (spec.resonatorNodeId) {
      resonatorNode = findById(sceneNodes, spec.resonatorNodeId);
    }
    if (!resonatorNode) {
      resonatorNode = findParentOf(sceneNodes, node.id);
    }
  }
  const soundbox = resonatorNode && !resonatorNode.acousticString
    ? analyzeSoundboxResonance(resonatorNode)
    : null;

  // 5. Build stiff-string harmonic partial bank shaped by pluck comb & soundbox transfer function!
  const pluckPos = Math.max(0.05, Math.min(0.5, spec.pluckPos ?? 0.18));
  const radGain = soundbox ? soundbox.radiationGain : 0.65;
  const modes: ModalVoice[] = [];
  const nPartials = 12;

  for (let n = 1; n <= nPartials; n++) {
    const fn = n * fundamentalHz * Math.sqrt(1 + inharmonicityB * n * n);
    if (fn < 24 || fn > 17500) continue;

    // Pluck triangle-wave Fourier rolloff (1/n^1.35) * comb node sin(n * π * x_pluck / L)
    const comb = Math.abs(Math.sin(n * Math.PI * pluckPos));
    if (comb < 0.04) continue;
    let gain = (comb / Math.pow(n, 1.32)) * radGain;

    // Couple through the soundbox's Helmholtz air cavity + top/body plate formants!
    if (soundbox) {
      let boxH = resonatorTransferGain(fn, soundbox.topPlateHz, 8.5, 4.2);
      boxH *= resonatorTransferGain(fn, soundbox.bodyModeHz, 10.0, 2.6);
      if (soundbox.helmholtzHz !== null) {
        boxH *= resonatorTransferGain(fn, soundbox.helmholtzHz, 11.0, 5.5);
        // Below Helmholtz cutoff, ported soundboxes cancel as an acoustic dipole (~f^2 high-pass)
        if (fn < soundbox.helmholtzHz * 0.72) {
          const ratio = fn / (soundbox.helmholtzHz * 0.72);
          boxH *= 0.35 + 0.65 * ratio * ratio;
        }
      }
      gain *= Math.min(2.4, boxH * 0.58);
    }

    // String damping: higher harmonics decay faster (viscoelastic + air drag + bridge radiation energy transfer!)
    // Notice energy conservation: stronger soundbox radiation coupling slightly shortens sustain while making it louder!
    const bridgeLoadFactor = soundbox?.helmholtzHz ? 0.78 : 1.0;
    const partialQ = (mat.intrinsicQ * bridgeLoadFactor) / (1 + 0.28 * (n - 1) * (n - 1) * (1 - 0.5 * mat.brightness));
    const decaySec = Math.max(0.04, Math.min(5.5, (partialQ / (Math.PI * fn)) * 2.6));

    modes.push({
      freqHz: +fn.toFixed(2),
      gain: +Math.min(1.2, gain).toFixed(3),
      decaySec: +decaySec.toFixed(4),
    });
  }

  // 6. Sympathetic transient excitation of the soundbox's own Helmholtz air-boom & top-plate knock via the bridge!
  if (soundbox) {
    if (soundbox.helmholtzHz !== null) {
      modes.push({
        freqHz: soundbox.helmholtzHz,
        gain: 0.24,
        decaySec: +Math.max(0.06, 11 / (Math.PI * soundbox.helmholtzHz) * 2.2).toFixed(4),
      });
    }
    modes.push({
      freqHz: soundbox.topPlateHz,
      gain: soundbox.hasHollowCavity ? 0.18 : 0.08,
      decaySec: +Math.max(0.04, 14 / (Math.PI * soundbox.topPlateHz) * 2.0).toFixed(4),
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
      brightness: mat.brightness,
    },
    contactDurationSec: 0.00075,
    modes,
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
 * automatically adjusting wire diameter if needed to stay safely within [12 N .. 68% breaking stress],
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

  // If tension would snap the wire or leave it floppy (< 12 N), pick an appropriate luthier gauge!
  if (tensionN / areaOf(diameterMm) > maxSafeStressPa || tensionN < 12 || tensionN > 140) {
    // Target nominal musical tension ~48 N (acoustic guitar / harp sweet spot)
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
 * Creates `count` taut musical strings mounted as children across the top face
 * of `hostNode`, tuned to a musical interval set (e.g. open harp/lyre/guitar tuning).
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

  // Span strings along the longer horizontal axis (X or Y) of the soundbox top!
  const spanAlongY = dy >= dx;
  const scaleLen = Math.max(0.08, (spanAlongY ? dy : dx) * 0.82);
  const acrossSpan = Math.max(0.03, (spanAlongY ? dx : dy) * 0.56);
  const zHeight = +(topZ + 0.008).toFixed(5); // 8 mm bridge action above soundboard

  const freqs = opts.notes ?? [261.63, 293.66, 329.63, 392.00]; // C4, D4, E4, G4
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
    // Transverse pluck axis (horizontal across the soundboard so a passing plectrum plucks cleanly!)
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
