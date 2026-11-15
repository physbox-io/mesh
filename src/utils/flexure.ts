// ---------------------------------------------------------------------------
// Monolithic Compliant Mechanisms ("Replace Joint with Flexure")
// ---------------------------------------------------------------------------
//
// Replaces a rigid `hinge` or `slide` joint with a 3D-printable monolithic
// compliant flexure sized from filament mechanics (Howell's Pseudo-Rigid-Body
// Model):
//   - `blade`       (hinge): single living/blade leaf
//   - `cross_pivot` (hinge): ±45° crossed flexural strips with minimal axis drift
//   - `serpentine`  (slide): N-meander guided linear spring
//   - `bistable`    (slide): symmetric inclined Von Mises snap-through toggle
//                            with two true equilibria at q = 0 and q = 2 * archRise
//
// Printable flexure leaves (`flexure_*`, `role: 'visual'`) render in the 3D
// viewport and export into STL/3MF prints while staying out of MuJoCo's contact
// solver so they never jam the joint.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { FlexureKind, FlexureSpec, SceneGeom, SceneJoint, SceneNode } from '../types/scene';
import { filamentSpec, type FilamentId } from './filaments';

export interface FilamentMechanics {
  id: FilamentId;
  modulusGPa: number;
  yieldMPa: number;
  creepsUnderSustainedLoad: boolean;
  rgba: [number, number, number, number];
}

export const FLEXURE_FILAMENT_PROPS: Record<FilamentId, FilamentMechanics> = {
  pla: {
    id: 'pla',
    modulusGPa: 2.8,
    yieldMPa: 50,
    creepsUnderSustainedLoad: true,
    rgba: [0.28, 0.62, 0.88, 1],
  },
  petg: {
    id: 'petg',
    modulusGPa: 2.1,
    yieldMPa: 48,
    creepsUnderSustainedLoad: false,
    rgba: [0.18, 0.72, 0.58, 1],
  },
  abs: {
    id: 'abs',
    modulusGPa: 2.0,
    yieldMPa: 40,
    creepsUnderSustainedLoad: false,
    rgba: [0.88, 0.58, 0.22, 1],
  },
  asa: {
    id: 'asa',
    modulusGPa: 2.05,
    yieldMPa: 42,
    creepsUnderSustainedLoad: false,
    rgba: [0.78, 0.48, 0.25, 1],
  },
  tpu: {
    id: 'tpu',
    modulusGPa: 0.045,
    yieldMPa: 18,
    creepsUnderSustainedLoad: false,
    rgba: [0.35, 0.38, 0.45, 1],
  },
};

export interface FlexureDesignInput {
  kind?: FlexureKind;
  filament?: string;
  thicknessMm?: number;
  lengthMm?: number;
  widthMm?: number;
  folds?: number;
  archRiseMm?: number;
}

export interface FlexureEvaluation {
  spec: FlexureSpec;
  /** Critical snap-through force (N) for bistable toggles, else 0. */
  snapForceN: number;
  /** Peak bending stress at full rated travel (MPa). */
  peakStressMPa: number;
  /** Actionable engineering warnings (e.g. PLA creep, nozzle wall floor, Q-ratio). */
  warnings: string[];
}

function resolveFilamentId(raw: string | undefined): FilamentId {
  if (raw === 'pla' || raw === 'petg' || raw === 'abs' || raw === 'asa' || raw === 'tpu') {
    return raw;
  }
  return 'petg';
}

export function allowedFlexureKindsForJoint(jointType: string | undefined): FlexureKind[] {
  if (jointType === 'hinge') return ['blade', 'cross_pivot'];
  if (jointType === 'slide') return ['serpentine', 'bistable'];
  return [];
}

/**
 * Computes pseudo-rigid-body stiffness, travel limit, snap force, and DFM
 * warnings from physical leaf dimensions and filament properties.
 */
export function evaluateFlexureSpec(input: FlexureDesignInput, jointType: 'hinge' | 'slide' = 'hinge'): FlexureEvaluation {
  const allowed = allowedFlexureKindsForJoint(jointType);
  const kind: FlexureKind = input.kind && allowed.includes(input.kind)
    ? input.kind
    : allowed[0];

  const filId = resolveFilamentId(input.filament);
  const mech = FLEXURE_FILAMENT_PROPS[filId];
  const fSpec = filamentSpec(filId);

  const thicknessMm = Math.max(0.4, Math.min(4.0, input.thicknessMm ?? (filId === 'tpu' ? 1.2 : 0.8)));
  const lengthMm = Math.max(4.0, Math.min(80.0, input.lengthMm ?? (jointType === 'hinge' ? 12 : 16)));
  const widthMm = Math.max(2.0, Math.min(50.0, input.widthMm ?? 8.0));
  const folds = kind === 'serpentine' ? Math.max(2, Math.min(8, Math.round(input.folds ?? 4))) : undefined;
  const archRiseMm = kind === 'bistable'
    ? Math.max(0.8, Math.min(12.0, input.archRiseMm ?? Math.max(2.0, thicknessMm * 2.8)))
    : undefined;

  const E = mech.modulusGPa * 1e9; // Pa
  const sigmaAllow = (mech.yieldMPa * 1e6) / 1.4; // Pa with safety factor 1.4
  const t = thicknessMm / 1000;
  const L = lengthMm / 1000;
  const b = widthMm / 1000;
  const I = (b * t * t * t) / 12;

  let stiffness: number;
  let maxTravel: number;
  let snapForceN = 0;
  let peakStressMPa: number;
  const warnings: string[] = [];

  if (thicknessMm + 1e-6 < fSpec.minWallMm) {
    warnings.push(
      `${fSpec.label} minimum reliable two-perimeter wall is ${fSpec.minWallMm} mm (current leaf is ${thicknessMm.toFixed(2)} mm; use a 0.25 mm nozzle or single-arachne perimeter).`,
    );
  }

  if (kind === 'blade' || kind === 'cross_pivot') {
    // k_theta = E * I / L (N*m/rad) for both a full-width blade and two half-width crossed leaves
    stiffness = (E * I) / L;
    const thetaMaxRad = Math.min(Math.PI * 0.75, (2 * sigmaAllow * L) / (E * t));
    maxTravel = +((thetaMaxRad * 180) / Math.PI).toFixed(1);
    peakStressMPa = +(((E * t * thetaMaxRad) / (2 * L)) / 1e6).toFixed(1);
    if (mech.creepsUnderSustainedLoad) {
      warnings.push('PLA creeps under sustained deflection; switch to PETG or TPU if held bent.');
    }
  } else if (kind === 'serpentine') {
    const N = folds ?? 4;
    // N guided cantilevers in series: k_seg = 12 E I / L^3, k_total = k_seg / N
    stiffness = (12 * E * I) / (N * L * L * L);
    const deltaSegMax = (sigmaAllow * L * L) / (3 * E * t);
    const xMaxM = Math.min(L * 0.65, N * deltaSegMax);
    maxTravel = +(xMaxM * 1000).toFixed(2);
    peakStressMPa = +(((3 * E * t * (xMaxM / N)) / (L * L)) / 1e6).toFixed(1);
    if (mech.creepsUnderSustainedLoad) {
      warnings.push('PLA creeps under sustained spring load; PETG is strongly recommended for compliant springs.');
    }
  } else {
    // Bistable Von Mises inclined-arch toggle:
    // Two equilibria at q = 0 and q = 2 * h0 (m); unstable hilltop at q = h0.
    const h0 = (archRiseMm ?? 2.4) / 1000;
    const qRatio = h0 / t;
    const frameFactor = 0.35;
    stiffness = frameFactor * ((2 * E * b * t) / (L * L * L)) * (h0 * h0 + t * t);
    snapForceN = +(stiffness * h0 / (3 * Math.sqrt(3))).toFixed(3);
    maxTravel = +(2 * (archRiseMm ?? 2.4)).toFixed(2);
    peakStressMPa = +(((E * (1.5 * h0 * t + 0.5 * h0 * h0)) / (L * L)) / 1e6).toFixed(1);

    if (qRatio < 1.6) {
      warnings.push(
        `Arch rise / thickness ratio Q = ${qRatio.toFixed(1)} is below ~1.8; real printed walls may pop back instead of latching in the second state.`,
      );
    }
    if (mech.creepsUnderSustainedLoad) {
      warnings.push(
        'PLA cold-flows when parked in a stressed or latched flexure — use PETG or ASA for bistable toggles.',
      );
    }
    if (peakStressMPa > mech.yieldMPa * 1.15) {
      warnings.push(
        `Snap-through strain (~${peakStressMPa.toFixed(0)} MPa) exceeds ${fSpec.label} yield (${mech.yieldMPa} MPa); lengthen leaf span or thin the blade.`,
      );
    }
  }

  return {
    spec: {
      kind,
      filament: filId,
      thicknessMm: +thicknessMm.toFixed(2),
      lengthMm: +lengthMm.toFixed(2),
      widthMm: +widthMm.toFixed(2),
      ...(folds !== undefined ? { folds } : {}),
      ...(archRiseMm !== undefined ? { archRiseMm: +archRiseMm.toFixed(2) } : {}),
      stiffness: +stiffness.toPrecision(5),
      maxTravel,
    },
    snapForceN,
    peakStressMPa,
    warnings,
  };
}

/**
 * Exact symmetric double-well snap-through force (N) applied along a `bistable`
 * slide joint at generalized coordinate `qMeters`.
 *
 * Stable equilibria: `q = 0` and `q = 2 * h0` (where slope dF/dq = -stiffness).
 * Unstable snap threshold: `q = h0` (F = 0, positive feedback on either side).
 */
export function bistableForce(qMeters: number, spec: FlexureSpec): number {
  if (spec.kind !== 'bistable') return 0;
  const h0 = Math.max(0.0005, (spec.archRiseMm ?? 2.4) / 1000);
  const k0 = Math.max(0, spec.stiffness);
  const u = (qMeters - h0) / h0;
  // Clamp extreme excursions gently so numerical spikes never explode
  const uClamped = Math.max(-3.5, Math.min(3.5, u));
  return 0.5 * k0 * h0 * uClamped * (1 - uClamped * uClamped);
}

/** Builds an orthonormal frame where local +Z aligns with `jointAxis`, +X is motion/span, +Y is width. */
function jointBasis(axisRaw: number[] | undefined): {
  ex: THREE.Vector3;
  ey: THREE.Vector3;
  ez: THREE.Vector3;
} {
  const ez = new THREE.Vector3(axisRaw?.[0] ?? 0, axisRaw?.[1] ?? 0, axisRaw?.[2] ?? 1);
  if (ez.lengthSq() < 1e-12) ez.set(0, 0, 1);
  ez.normalize();
  const ref = Math.abs(ez.z) < 0.85 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  const ex = new THREE.Vector3().crossVectors(ref, ez).normalize();
  const ey = new THREE.Vector3().crossVectors(ez, ex).normalize();
  return { ex, ey, ez };
}

function boxGeomInBasis(
  name: string,
  origin: THREE.Vector3,
  bx: THREE.Vector3,
  by: THREE.Vector3,
  bz: THREE.Vector3,
  halfSizes: [number, number, number],
  rgba: [number, number, number, number],
): SceneGeom {
  const m = new THREE.Matrix4().makeBasis(bx, by, bz);
  const q = new THREE.Quaternion().setFromRotationMatrix(m).normalize();
  return {
    name,
    type: 'box',
    size: halfSizes.map((v) => +Math.max(0.00015, v).toFixed(6)),
    pos: [+origin.x.toFixed(6), +origin.y.toFixed(6), +origin.z.toFixed(6)],
    quat: [+q.w.toFixed(6), +q.x.toFixed(6), +q.y.toFixed(6), +q.z.toFixed(6)],
    role: 'visual',
    rgba: [...rgba],
  };
}

/**
 * Generates printable `role: 'visual'` compliant leaf geometry in `node`'s frame
 * centred on `joint.pos`. Exported into STL/3MF prints and rendered in the 3D
 * viewport while excluded from MuJoCo contact pairs.
 */
export function buildFlexureGeoms(joint: SceneJoint, spec: FlexureSpec): SceneGeom[] {
  const filId = resolveFilamentId(spec.filament);
  const rgba = FLEXURE_FILAMENT_PROPS[filId].rgba;
  const pivot = new THREE.Vector3(joint.pos?.[0] ?? 0, joint.pos?.[1] ?? 0, joint.pos?.[2] ?? 0);
  const { ex, ey, ez } = jointBasis(joint.axis);

  const t = spec.thicknessMm / 1000;
  const L = spec.lengthMm / 1000;
  const b = spec.widthMm / 1000;
  const geoms: SceneGeom[] = [];

  if (spec.kind === 'blade') {
    // Thin blade spanning L along ex, thickness t along ey, width b along hinge axis ez
    geoms.push(
      boxGeomInBasis('flexure_blade', pivot, ex, ey, ez, [L * 0.5, t * 0.5, b * 0.5], rgba),
    );
    // Root fillet/anchor pads at both ends
    const padThick = Math.max(t * 2.2, 0.0018);
    const padLen = Math.max(0.0015, L * 0.14);
    for (const [idx, sign] of [[-1, 0], [1, 1]] as const) {
      const p = pivot.clone().addScaledVector(ex, idx * (L * 0.5 + padLen * 0.4));
      geoms.push(
        boxGeomInBasis(`flexure_pad_${sign}`, p, ex, ey, ez, [padLen * 0.5, padThick * 0.5, b * 0.5], rgba),
      );
    }
  } else if (spec.kind === 'cross_pivot') {
    // Two ±45° crossed leaves separated slightly along hinge axis ez so they print cleanly without fusing at centre!
    const halfB = Math.max(0.001, b * 0.44);
    const gapZ = b * 0.26;
    for (const [i, ang, zShift] of [[0, Math.PI / 4, -gapZ], [1, -Math.PI / 4, gapZ]] as const) {
      const lx = ex.clone().multiplyScalar(Math.cos(ang)).addScaledVector(ey, Math.sin(ang)).normalize();
      const ly = new THREE.Vector3().crossVectors(ez, lx).normalize();
      const c = pivot.clone().addScaledVector(ez, zShift);
      geoms.push(
        boxGeomInBasis(`flexure_cross_${i}`, c, lx, ly, ez, [L * 0.5, t * 0.5, halfB * 0.5], rgba),
      );
    }
  } else if (spec.kind === 'serpentine') {
    // Slide axis is ez! Build N meanders stacked along ez, spanning L laterally along ex, out-of-plane width b along ey
    const N = Math.max(2, spec.folds ?? 4);
    const pitchZ = Math.max(t * 2.8, (L * 0.45) / N);
    const startZ = -((N - 1) * pitchZ) / 2;
    for (let i = 0; i < N; i++) {
      const zOff = startZ + i * pitchZ;
      const c = pivot.clone().addScaledVector(ez, zOff);
      // Leaf thin along slide axis ez (thickness t), long along ex (span L), wide along ey (width b)
      geoms.push(
        boxGeomInBasis(`flexure_meander_${i}`, c, ex, ey, ez, [L * 0.5, b * 0.5, t * 0.5], rgba),
      );
      if (i < N - 1) {
        const side = i % 2 === 0 ? 1 : -1;
        const turnCenter = pivot
          .clone()
          .addScaledVector(ez, zOff + pitchZ * 0.5)
          .addScaledVector(ex, side * (L * 0.5 - t));
        geoms.push(
          boxGeomInBasis(
            `flexure_turn_${i}`,
            turnCenter,
            ex,
            ey,
            ez,
            [t, b * 0.5, (pitchZ + t) * 0.5],
            rgba,
          ),
        );
      }
    }
  } else {
    // Bistable Von Mises inclined arches: slide axis is ez, symmetric pair on ±ex inclined by archRise h0 along -ez
    const h0 = (spec.archRiseMm ?? 2.4) / 1000;
    const beamLen = Math.hypot(L, h0);
    const shuttleR = Math.max(0.0018, t * 2.2);
    // Central shuttle boss
    geoms.push(
      boxGeomInBasis('flexure_shuttle', pivot, ex, ey, ez, [shuttleR, b * 0.5, Math.max(shuttleR, h0 * 0.6)], rgba),
    );
    // Paired double-arch leaves (two parallel rows for rotational anti-buckling, just like real printed bistable switches)
    const rowOffsets = [-Math.max(t * 2.4, h0 * 0.7), Math.max(t * 2.4, h0 * 0.7)];
    let idx = 0;
    for (const zRow of rowOffsets) {
      for (const side of [-1, 1] as const) {
        // From outer frame anchor (side * (L + shuttleR), -h0) up to shuttle (side * shuttleR, 0)
        const pOuter = pivot.clone().addScaledVector(ex, side * (L + shuttleR)).addScaledVector(ez, zRow - h0);
        const pInner = pivot.clone().addScaledVector(ex, side * shuttleR).addScaledVector(ez, zRow);
        const mid = pOuter.clone().add(pInner).multiplyScalar(0.5);
        const lx = pInner.clone().sub(pOuter).normalize();
        const lz = new THREE.Vector3().crossVectors(lx, ey).normalize();
        geoms.push(
          boxGeomInBasis(`flexure_arch_${idx++}`, mid, lx, ey, lz, [beamLen * 0.5, b * 0.5, t * 0.5], rgba),
        );
      }
    }
  }

  return geoms;
}

/** Removes generated flexure geoms and resets the joint to a clean rigid pin/slider. */
export function revertFlexure(node: SceneNode): SceneNode {
  const nextGeoms = (node.geoms ?? []).filter((g) => !g.name.startsWith('flexure_'));
  const nextJoints = (node.joints ?? []).map((j, idx) => {
    if (idx !== 0 || (j.type !== 'hinge' && j.type !== 'slide')) return { ...j };
    return {
      ...j,
      stiffness: 0,
      springref: 0,
      damping: 0,
      limited: false,
      range: undefined,
    };
  });
  const out: SceneNode = {
    ...node,
    geoms: nextGeoms,
    joints: nextJoints,
  };
  delete out.flexure;
  return out;
}

/**
 * Converts `node`'s primary `hinge` or `slide` joint into a calibrated compliant
 * flexure (or updates an existing flexure in-place), returning the updated node
 * and engineering evaluation.
 */
export function applyFlexureToNode(
  node: SceneNode,
  input: FlexureDesignInput = {},
): { node: SceneNode; evaluation: FlexureEvaluation } | null {
  const jointIdx = (node.joints ?? []).findIndex((j) => j.type === 'hinge' || j.type === 'slide');
  if (jointIdx < 0) return null;
  const baseJoint = node.joints[jointIdx];
  const jointType = baseJoint.type as 'hinge' | 'slide';

  const mergedInput: FlexureDesignInput = {
    kind: input.kind ?? node.flexure?.kind,
    filament: input.filament ?? node.flexure?.filament ?? 'petg',
    thicknessMm: input.thicknessMm ?? node.flexure?.thicknessMm,
    lengthMm: input.lengthMm ?? node.flexure?.lengthMm,
    widthMm: input.widthMm ?? node.flexure?.widthMm,
    folds: input.folds ?? node.flexure?.folds,
    archRiseMm: input.archRiseMm ?? node.flexure?.archRiseMm,
  };

  const evaluation = evaluateFlexureSpec(mergedInput, jointType);
  const { spec } = evaluation;

  // Calibrate joint stiffness, range & gentle structural polymer loss damping
  const updatedJoint: SceneJoint = { ...baseJoint };
  if (jointType === 'hinge') {
    updatedJoint.stiffness = spec.stiffness;
    updatedJoint.springref = 0;
    // Polymer viscoelastic loss ~3% of critical for typical body inertia
    updatedJoint.damping = +Math.max(1e-4, spec.stiffness * 0.015).toPrecision(4);
    updatedJoint.limited = true;
    const limDeg = Math.max(5, Math.min(135, spec.maxTravel));
    updatedJoint.range = [-limDeg, limDeg];
  } else if (spec.kind === 'serpentine') {
    updatedJoint.stiffness = spec.stiffness;
    updatedJoint.springref = 0;
    updatedJoint.damping = +Math.max(0.02, spec.stiffness * 0.012).toPrecision(4);
    updatedJoint.limited = true;
    const limM = +(Math.max(0.001, spec.maxTravel / 1000)).toFixed(5);
    updatedJoint.range = [-limM, limM];
  } else {
    // Bistable toggle: linear joint stiffness MUST be 0 so physicsWorker's cubic double-well
    // `bistableForce` creates two symmetric true equilibria at q = 0 and q = 2 * h0!
    const strokeM = (2 * (spec.archRiseMm ?? 2.4)) / 1000;
    updatedJoint.stiffness = 0;
    updatedJoint.springref = 0;
    updatedJoint.damping = +Math.max(0.08, spec.stiffness * 0.006).toPrecision(4);
    updatedJoint.limited = true;
    updatedJoint.range = [
      +(-0.35 * strokeM).toFixed(5),
      +(1.35 * strokeM).toFixed(5),
    ];
  }

  const cleanGeoms = (node.geoms ?? []).filter((g) => !g.name.startsWith('flexure_'));
  const flexureGeoms = buildFlexureGeoms(updatedJoint, spec);
  const nextJoints = node.joints.map((j, i) => (i === jointIdx ? updatedJoint : { ...j }));

  return {
    node: {
      ...node,
      geoms: [...cleanGeoms, ...flexureGeoms],
      joints: nextJoints,
      flexure: spec,
    },
    evaluation,
  };
}
