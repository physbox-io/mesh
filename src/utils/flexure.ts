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
// viewport bent by their joint's live position (each carries `bend`; see
// components/scene/FlexureLeaves.tsx), export into STL/3MF prints at rest, and
// stay out of MuJoCo's contact solver so they never jam the joint.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { FlexureBend, FlexureKind, FlexureSpec, SceneGeom, SceneJoint, SceneNode } from '../types/scene';
import { filamentSpec, type FilamentId } from './filaments';

export interface FilamentMechanics {
  id: FilamentId;
  modulusGPa: number;
  yieldMPa: number;
  creepsUnderSustainedLoad: boolean;
  /** Viscoelastic loss of a printed leaf, as a fraction of critical damping. */
  lossRatio: number;
  rgba: [number, number, number, number];
}

export const FLEXURE_FILAMENT_PROPS: Record<FilamentId, FilamentMechanics> = {
  pla: {
    id: 'pla',
    lossRatio: 0.03,
    modulusGPa: 2.8,
    yieldMPa: 50,
    creepsUnderSustainedLoad: true,
    rgba: [0.28, 0.62, 0.88, 1],
  },
  petg: {
    id: 'petg',
    lossRatio: 0.03,
    modulusGPa: 2.1,
    yieldMPa: 48,
    creepsUnderSustainedLoad: false,
    rgba: [0.18, 0.72, 0.58, 1],
  },
  abs: {
    id: 'abs',
    lossRatio: 0.03,
    modulusGPa: 2.0,
    yieldMPa: 40,
    creepsUnderSustainedLoad: false,
    rgba: [0.88, 0.58, 0.22, 1],
  },
  asa: {
    id: 'asa',
    lossRatio: 0.03,
    modulusGPa: 2.05,
    yieldMPa: 42,
    creepsUnderSustainedLoad: false,
    rgba: [0.78, 0.48, 0.25, 1],
  },
  tpu: {
    id: 'tpu',
    lossRatio: 0.15,
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
  /** Optional joint name to target on multi-joint bodies (defaults to first hinge/slide joint). */
  jointName?: string;
  /** Optional operating deflection to check stress/strain/SF (deg for hinge, mm for slide). */
  targetDeflection?: number;
}

export interface FlexureOperatingPoint {
  /** Requested deflection (deg for hinge, mm for slide). */
  deflection: number;
  /** Peak bending stress at the operating deflection (MPa). */
  stressMPa: number;
  /** Peak surface strain at the operating deflection (dimensionless). */
  strain: number;
  /** Safety factor against filament yield (yieldMPa / stressMPa). */
  safetyFactor: number;
  /** Restoring torque (N·m for hinge) or force (N for slide) at the operating deflection. */
  forceOrTorque: number;
}

export interface FlexureEvaluation {
  spec: FlexureSpec;
  /** Critical snap-through force (N) for bistable toggles, else 0. */
  snapForceN: number;
  /** Peak bending stress at full rated travel (MPa). */
  peakStressMPa: number;
  /** Second moment of area I = b·t³/12 (m⁴). */
  secondMomentM4: number;
  /** Peak surface strain ε = σ / E at full rated travel (dimensionless). */
  maxStrain: number;
  /** Filament yield strain ε_y = σ_y / E (dimensionless). */
  yieldStrain: number;
  /** Safety factor against yield at full rated travel (or at targetDeflection if supplied). */
  safetyFactor: number;
  /** Peak restoring torque (N·m, hinge) or force (N, slide) at rated travel (or snap force for bistable). */
  maxForceOrTorque: number;
  /** Present when `targetDeflection` is supplied in `FlexureDesignInput`. */
  operating?: FlexureOperatingPoint;
  /** Actionable engineering warnings (e.g. PLA creep, nozzle wall floor, Q-ratio, over-stress). */
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

  const thicknessMm = Math.max(0.4, Math.min(4.0, input.thicknessMm ?? Math.max(1.0, fSpec.minWallMm)));
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
  let maxForceOrTorque: number;
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
    maxForceOrTorque = +(stiffness * thetaMaxRad).toPrecision(4);
    if (mech.creepsUnderSustainedLoad) {
      warnings.push('PLA creeps under sustained deflection; switch to PETG or TPU if held bent.');
    }
  } else if (kind === 'serpentine') {
    const N = folds ?? 4;
    // N guided cantilevers in series per side (k_seg = 12 E I / L^3, k_side = k_seg / N),
    // and a folded spring on each side of the body in parallel
    stiffness = (2 * 12 * E * I) / (N * L * L * L);
    const deltaSegMax = (sigmaAllow * L * L) / (3 * E * t);
    const xMaxM = Math.min(L * 0.65, N * deltaSegMax);
    maxTravel = +(xMaxM * 1000).toFixed(2);
    peakStressMPa = +(((3 * E * t * (xMaxM / N)) / (L * L)) / 1e6).toFixed(1);
    maxForceOrTorque = +(stiffness * xMaxM).toPrecision(4);
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
    maxForceOrTorque = snapForceN;

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

  const yieldStrain = +((mech.yieldMPa * 1e6) / E).toPrecision(4);
  const maxStrain = +((peakStressMPa * 1e6) / E).toPrecision(4);
  const ratedSafetyFactor = peakStressMPa > 1e-6 ? +(mech.yieldMPa / peakStressMPa).toFixed(2) : 99;

  let operating: FlexureOperatingPoint | undefined;
  if (input.targetDeflection !== undefined && Number.isFinite(input.targetDeflection) && input.targetDeflection >= 0) {
    const req = input.targetDeflection;
    let opStressPa: number;
    let opForce: number;
    if (kind === 'blade' || kind === 'cross_pivot') {
      const rad = (req * Math.PI) / 180;
      opStressPa = (E * t * rad) / (2 * L);
      opForce = stiffness * rad;
    } else if (kind === 'serpentine') {
      const N = folds ?? 4;
      const xM = req / 1000;
      opStressPa = (3 * E * t * (xM / N)) / (L * L);
      opForce = stiffness * xM;
    } else {
      // Bistable peak stress occurs at the snap-through midpoint q = h0
      const h0 = (archRiseMm ?? 2.4) / 1000;
      const frac = Math.min(1, (req / 1000) / Math.max(1e-6, h0));
      opStressPa = ((E * (1.5 * h0 * t + 0.5 * h0 * h0)) / (L * L)) * frac;
      opForce = Math.abs(bistableForce(req / 1000, {
        kind, filament: filId, thicknessMm, lengthMm, widthMm, archRiseMm, stiffness, maxTravel,
      }));
    }
    const opStressMPa = +(opStressPa / 1e6).toFixed(2);
    const opStrain = +(opStressPa / E).toPrecision(4);
    const opSF = opStressMPa > 1e-6 ? +(mech.yieldMPa / opStressMPa).toFixed(2) : 99;
    operating = {
      deflection: req,
      stressMPa: opStressMPa,
      strain: opStrain,
      safetyFactor: opSF,
      forceOrTorque: +opForce.toPrecision(4),
    };
    const unit = jointType === 'hinge' ? '°' : ' mm';
    if (opSF < 1.0) {
      warnings.push(
        `Target deflection (${req}${unit}) exceeds ${fSpec.label} yield (σ = ${opStressMPa.toFixed(1)} MPa > ${mech.yieldMPa} MPa, SF = ${opSF.toFixed(2)}); lengthen leaf or reduce thickness.`,
      );
    } else if (opSF < 1.4) {
      warnings.push(
        `Target deflection (${req}${unit}) has low fatigue safety factor (SF = ${opSF.toFixed(2)} < 1.4; σ = ${opStressMPa.toFixed(1)} MPa).`,
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
    secondMomentM4: +I.toPrecision(5),
    maxStrain,
    yieldStrain,
    safetyFactor: operating ? operating.safetyFactor : ratedSafetyFactor,
    maxForceOrTorque,
    ...(operating ? { operating } : {}),
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
  bend?: FlexureBend,
): SceneGeom {
  const m = new THREE.Matrix4().makeBasis(bx, by, bz);
  const q = new THREE.Quaternion().setFromRotationMatrix(m).normalize();
  const r6 = (v: THREE.Vector3) => [+v.x.toFixed(6), +v.y.toFixed(6), +v.z.toFixed(6)];
  return {
    name,
    type: 'box',
    size: halfSizes.map((v) => +Math.max(0.00015, v).toFixed(6)),
    pos: r6(origin),
    quat: [+q.w.toFixed(6), +q.x.toFixed(6), +q.y.toFixed(6), +q.z.toFixed(6)],
    role: 'visual',
    rgba: [...rgba],
    ...(bend ? { bend } : {}),
  };
}

/** A box leaf spanning `a` → `b`, its thin side along `thin`, carrying `w0` at `a` and `w1` at `b` of the joint's travel. */
function leafBetween(
  name: string,
  a: THREE.Vector3,
  b: THREE.Vector3,
  thin: THREE.Vector3,
  halfThick: number,
  halfWidth: number,
  rgba: [number, number, number, number],
  w0: number,
  w1: number,
  ease: 'smooth' | 'linear' = 'smooth',
): SceneGeom {
  const span = b.clone().sub(a);
  const len = span.length();
  const lx = span.normalize();
  const ly = thin.clone().addScaledVector(lx, -thin.dot(lx)).normalize();
  const lz = new THREE.Vector3().crossVectors(lx, ly).normalize();
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const r6 = (v: THREE.Vector3) => [+v.x.toFixed(6), +v.y.toFixed(6), +v.z.toFixed(6)];
  return boxGeomInBasis(name, mid, lx, ly, lz, [len * 0.5, halfThick, halfWidth], rgba, {
    from: r6(a), to: r6(b), w0, w1, ease,
  });
}

/** Rotation of a box/cylinder/sphere geom, or null when it has none. */
function geomRotation(g: SceneGeom): THREE.Quaternion | null {
  if (g.quat && g.quat.length === 4) return new THREE.Quaternion(g.quat[1], g.quat[2], g.quat[3], g.quat[0]).normalize();
  if (g.euler && g.euler.length === 3) {
    const d = Math.PI / 180;
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(g.euler[0] * d, g.euler[1] * d, g.euler[2] * d, 'XYZ'));
  }
  return null;
}

/**
 * How far the body's own geoms reach from `origin` along `dir` (body frame): where a
 * slide flexure's leaves meet the body. Rotated geoms count by their bounding sphere.
 */
export function bodyReach(geoms: SceneGeom[], origin: THREE.Vector3, dir: THREE.Vector3): number {
  let reach = 0;
  for (const g of geoms) {
    if (g.name.startsWith('flexure_') || g.csg === 'difference' || g.role === 'collision') continue;
    const s = g.size ?? [];
    const c = new THREE.Vector3(g.pos?.[0] ?? 0, g.pos?.[1] ?? 0, g.pos?.[2] ?? 0).sub(origin);
    const rot = geomRotation(g);
    let extent: number;
    if (g.type === 'sphere') extent = s[0] ?? 0;
    else if (rot || (g.type !== 'box' && g.type !== 'cylinder')) {
      extent = g.type === 'cylinder' || g.type === 'capsule'
        ? Math.hypot(s[0] ?? 0, s[1] ?? 0) + (g.type === 'capsule' ? s[0] ?? 0 : 0)
        : Math.hypot(s[0] ?? 0, s[1] ?? 0, s[2] ?? 0);
    } else if (g.type === 'box') {
      extent = Math.abs(dir.x) * (s[0] ?? 0) + Math.abs(dir.y) * (s[1] ?? 0) + Math.abs(dir.z) * (s[2] ?? 0);
    } else {
      extent = Math.abs(dir.z) * (s[1] ?? 0) + Math.hypot(dir.x, dir.y) * (s[0] ?? 0);
    }
    reach = Math.max(reach, c.dot(dir) + extent);
  }
  return reach;
}

/**
 * The direction, square to a hinge's axis, in which the body hangs from it: its
 * centre of mass, with everything it carries. A hinge flexure anchors on the
 * opposite side. Mass-weighted, so a counterweight or a pan hanging from a child
 * body counts for what it weighs, not for how many geoms it has.
 */
function hangDirection(geoms: SceneGeom[], children: SceneNode[], pivot: THREE.Vector3, axis: THREE.Vector3): THREE.Vector3 | null {
  const c = new THREE.Vector3();
  let total = 0;
  const add = (list: SceneGeom[], kids: SceneNode[], offset: THREE.Vector3) => {
    for (const g of list) {
      if (g.name.startsWith('flexure_') || g.csg === 'difference' || g.role === 'visual') continue;
      const m = g.mass ?? (g.density ?? 1000) * geomVolume(g);
      if (!(m > 0)) continue;
      c.addScaledVector(new THREE.Vector3(g.pos?.[0] ?? 0, g.pos?.[1] ?? 0, g.pos?.[2] ?? 0).add(offset), m);
      total += m;
    }
    for (const k of kids) {
      add(k.geoms ?? [], k.children ?? [], offset.clone().add(new THREE.Vector3(k.pos?.[0] ?? 0, k.pos?.[1] ?? 0, k.pos?.[2] ?? 0)));
    }
  };
  add(geoms, children, new THREE.Vector3());
  if (!(total > 0)) return null;
  c.multiplyScalar(1 / total).sub(pivot);
  c.addScaledVector(axis, -c.dot(axis));
  return c.lengthSq() > 1e-12 ? c.normalize() : null;
}

/**
 * Generates printable `role: 'visual'` compliant leaf geometry in `node`'s frame
 * around `joint.pos`. Each leaf carries `bend`, so the viewport draws it flexing
 * between the parent (frame) and the body as the joint moves. `bodyGeoms` (the
 * body's own geoms) place the leaves: a hinge flexure anchors on the side away
 * from where the body hangs, a slide flexure's leaves start at the body's faces.
 */
export function buildFlexureGeoms(joint: SceneJoint, spec: FlexureSpec, bodyGeoms: SceneGeom[] = [], bodyChildren: SceneNode[] = []): SceneGeom[] {
  const filId = resolveFilamentId(spec.filament);
  const rgba = FLEXURE_FILAMENT_PROPS[filId].rgba;
  const pivot = new THREE.Vector3(joint.pos?.[0] ?? 0, joint.pos?.[1] ?? 0, joint.pos?.[2] ?? 0);
  const { ex, ey, ez } = jointBasis(joint.axis);

  const t = spec.thicknessMm / 1000;
  const L = spec.lengthMm / 1000;
  const b = spec.widthMm / 1000;
  const geoms: SceneGeom[] = [];
  const at = (...terms: [THREE.Vector3, number][]) => {
    const p = pivot.clone();
    for (const [v, k] of terms) p.addScaledVector(v, k);
    return p;
  };

  if (spec.kind === 'blade' || spec.kind === 'cross_pivot') {
    // `up` points from the body to the frame across the pivot; `side` is square to it.
    const up = hangDirection(bodyGeoms, bodyChildren, pivot, ez)?.negate() ?? ey.clone();
    const side = new THREE.Vector3().crossVectors(ez, up).normalize();
    if (spec.kind === 'blade') {
      // One leaf through the pivot, anchored above it and holding the body below.
      const top = at([up, L * 0.5]);
      const bottom = at([up, -L * 0.5]);
      geoms.push(leafBetween('flexure_blade', top, bottom, side, t * 0.5, b * 0.5, rgba, 0, 1));
      const padThick = Math.max(t * 2.2, 0.0018);
      const padLen = Math.max(0.0015, L * 0.14);
      for (const [k, end, w] of [[0, 1, 0], [1, -1, 1]] as const) {
        const a = at([up, end * L * 0.5]);
        const c = at([up, end * (L * 0.5 + padLen)]);
        geoms.push(leafBetween(`flexure_pad_${k}`, a, c, side, padThick * 0.5, b * 0.5, rgba, w, w));
      }
    } else {
      // Two leaves crossing at the pivot at ±45°, set apart along the axis so they
      // print without fusing; each runs from the frame above to the body below.
      const halfB = Math.max(0.001, b * 0.44);
      const gap = b * 0.26;
      for (const [i, sign, shift] of [[0, 1, -gap], [1, -1, gap]] as const) {
        const dir = up.clone().multiplyScalar(Math.SQRT1_2).addScaledVector(side, sign * Math.SQRT1_2);
        const top = at([dir, L * 0.5], [ez, shift]);
        const bottom = at([dir, -L * 0.5], [ez, shift]);
        const thin = new THREE.Vector3().crossVectors(ez, dir);
        geoms.push(leafBetween(`flexure_cross_${i}`, top, bottom, thin, t * 0.5, halfB * 0.5, rgba, 0, 1));
      }
    }
  } else if (spec.kind === 'serpentine') {
    // A folded spring on each side (±ex) of the body: N legs across the slide
    // axis, stacked along it, joined alternately at their outer and inner ends.
    // Leg i carries 1 - i/N of the travel at its entry and 1 - (i+1)/N at its exit.
    const N = Math.max(2, spec.folds ?? 4);
    // Neighbouring legs close on each other by 2/N of the travel at their shared
    // side, so they are spaced to clear that at the joint's full rated travel.
    const pitch = Math.max(t * 3.2, (L * 0.45) / N, (2.2 * spec.maxTravel) / 1000 / N + t);
    const z0 = -((N - 1) * pitch) / 2;
    const gap = Math.max(0.0015, t * 2);
    for (const sideSign of [1, -1] as const) {
      const dir = ex.clone().multiplyScalar(sideSign);
      const face = Math.max(0, bodyReach(bodyGeoms, pivot, dir));
      const xin = face + gap;
      const xout = xin + L;
      const tag = sideSign > 0 ? 'a' : 'b';
      geoms.push(leafBetween(`flexure_tab_${tag}`, at([dir, face], [ez, z0]), at([dir, xin + t], [ez, z0]), ez, t, b * 0.5, rgba, 1, 1));
      for (let i = 0; i < N; i++) {
        const z = z0 + i * pitch;
        const entry = i % 2 === 0 ? xin : xout;
        const exit = i % 2 === 0 ? xout : xin;
        const wIn = 1 - i / N;
        const wOut = 1 - (i + 1) / N;
        geoms.push(leafBetween(`flexure_meander_${tag}${i}`, at([dir, entry], [ez, z]), at([dir, exit], [ez, z]), ez, t * 0.5, b * 0.5, rgba, wIn, wOut));
        if (i < N - 1) {
          geoms.push(leafBetween(`flexure_turn_${tag}${i}`, at([dir, exit], [ez, z - t * 0.5]), at([dir, exit], [ez, z + pitch + t * 0.5]), dir, t, b * 0.5, rgba, wOut, wOut, 'linear'));
        } else {
          // The anchor pad, where the frame holds the spring.
          const padLen = Math.max(0.002, t * 3);
          const out = exit === xout ? 1 : -1;
          geoms.push(leafBetween(`flexure_anchor_${tag}`, at([dir, exit], [ez, z]), at([dir, exit + out * padLen], [ez, z]), ez, Math.max(t * 1.5, 0.0012), b * 0.5, rgba, 0, 0));
        }
      }
    }
  } else {
    // Bistable Von Mises arches: a pair on ±ex, each from the body's face out to
    // the frame, the frame end set h0 *ahead* along the slide axis so the arch
    // flattens at q = h0 and inverts into its second rest at q = 2·h0.
    const h0 = (spec.archRiseMm ?? 2.4) / 1000;
    const rows = [-Math.max(t * 2.4, h0 * 0.7), Math.max(t * 2.4, h0 * 0.7)];
    let idx = 0;
    for (const zRow of rows) {
      for (const sideSign of [-1, 1] as const) {
        const dir = ex.clone().multiplyScalar(sideSign);
        const face = Math.max(Math.max(0.0018, t * 2.2), bodyReach(bodyGeoms, pivot, dir));
        const inner = at([dir, face], [ez, zRow]);
        const outer = at([dir, face + L], [ez, zRow + h0]);
        geoms.push(leafBetween(`flexure_arch_${idx++}`, outer, inner, ez, t * 0.5, b * 0.5, rgba, 0, 1));
      }
    }
  }

  return geoms;
}

/**
 * Where a point of a flexure leaf is drawn, in its body's frame, when the joint
 * stands at `q` (rad for a hinge, m for a slide). The body frame already carries
 * the whole of `q`; a point that should carry only its share `w` is taken back
 * by (1 - w) of it, about the joint's pivot or along its axis.
 */
export function bendLeafPoint(
  p: [number, number, number],
  bend: FlexureBend,
  joint: { type: string; pos?: number[]; axis?: number[] },
  q: number,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const fx = bend.from[0], fy = bend.from[1], fz = bend.from[2];
  const dx = bend.to[0] - fx, dy = bend.to[1] - fy, dz = bend.to[2] - fz;
  const len2 = dx * dx + dy * dy + dz * dz;
  let s = len2 > 0 ? ((p[0] - fx) * dx + (p[1] - fy) * dy + (p[2] - fz) * dz) / len2 : 0;
  s = Math.max(0, Math.min(1, s));
  const e = bend.ease === 'linear' ? s : s * s * (3 - 2 * s);
  const back = -(1 - (bend.w0 + (bend.w1 - bend.w0) * e)) * q;
  let ax = joint.axis?.[0] ?? 0, ay = joint.axis?.[1] ?? 0, az = joint.axis?.[2] ?? 1;
  const n = Math.hypot(ax, ay, az) || 1;
  ax /= n; ay /= n; az /= n;
  if (joint.type === 'slide') {
    out[0] = p[0] + ax * back; out[1] = p[1] + ay * back; out[2] = p[2] + az * back;
    return out;
  }
  // Rodrigues rotation by `back` about the axis through the joint's pivot.
  const ox = joint.pos?.[0] ?? 0, oy = joint.pos?.[1] ?? 0, oz = joint.pos?.[2] ?? 0;
  const vx = p[0] - ox, vy = p[1] - oy, vz = p[2] - oz;
  const c = Math.cos(back), sn = Math.sin(back);
  const dot = ax * vx + ay * vy + az * vz;
  const cx = ay * vz - az * vy, cy = az * vx - ax * vz, cz = ax * vy - ay * vx;
  out[0] = ox + vx * c + cx * sn + ax * dot * (1 - c);
  out[1] = oy + vy * c + cy * sn + ay * dot * (1 - c);
  out[2] = oz + vz * c + cz * sn + az * dot * (1 - c);
  return out;
}

/** Removes generated flexure geoms and resets the joint to a clean rigid pin/slider. */
export function revertFlexure(node: SceneNode): SceneNode {
  const nextGeoms = (node.geoms ?? []).filter((g) => !g.name.startsWith('flexure_'));
  const jointIdx = (node.joints ?? []).findIndex((j) => j.type === 'hinge' || j.type === 'slide');
  const nextJoints = (node.joints ?? []).map((j, idx) => {
    if (idx !== jointIdx) return { ...j };
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

function geomVolume(g: SceneGeom): number {
  const s = g.size ?? [];
  const a = s[0] ?? 0, b = s[1] ?? 0, c = s[2] ?? 0;
  switch (g.type) {
    case 'box': return 8 * a * b * c;
    case 'sphere': return (4 / 3) * Math.PI * a * a * a;
    case 'cylinder': return Math.PI * a * a * 2 * b;
    case 'capsule': return Math.PI * a * a * 2 * b + (4 / 3) * Math.PI * a * a * a;
    case 'ellipsoid': return (4 / 3) * Math.PI * a * b * c;
    default: return 0;
  }
}

/**
 * What the joint has to move: the mass (slide, kg) or the moment of inertia about
 * the joint's axis (hinge, kg·m²) of the body and everything it carries, from its
 * primitive geoms at their density (MuJoCo's default 1000 kg/m³). Rough on
 * purpose: it only sets how much a leaf's material loss damps the joint.
 */
export function movingInertia(node: SceneNode, joint: SceneJoint): number {
  const pivot = new THREE.Vector3(joint.pos?.[0] ?? 0, joint.pos?.[1] ?? 0, joint.pos?.[2] ?? 0);
  const axis = new THREE.Vector3(joint.axis?.[0] ?? 0, joint.axis?.[1] ?? 0, joint.axis?.[2] ?? 1);
  if (axis.lengthSq() < 1e-12) axis.set(0, 0, 1);
  axis.normalize();
  let total = 0;
  const add = (n: SceneNode, offset: THREE.Vector3) => {
    for (const g of n.geoms ?? []) {
      if (g.role === 'visual' || g.csg === 'difference' || g.name.startsWith('flexure_')) continue;
      const m = g.mass ?? (g.density ?? 1000) * geomVolume(g);
      if (!(m > 0)) continue;
      if (joint.type === 'slide') { total += m; continue; }
      const d = new THREE.Vector3(g.pos?.[0] ?? 0, g.pos?.[1] ?? 0, g.pos?.[2] ?? 0).add(offset).sub(pivot);
      d.addScaledVector(axis, -d.dot(axis));
      const s = g.size ?? [];
      const own = (m * ((s[0] ?? 0) ** 2 + (s[1] ?? 0) ** 2 + (s[2] ?? 0) ** 2)) / 5;
      total += m * d.lengthSq() + own;
    }
    for (const c of n.children ?? []) {
      add(c, offset.clone().add(new THREE.Vector3(c.pos?.[0] ?? 0, c.pos?.[1] ?? 0, c.pos?.[2] ?? 0)));
    }
  };
  add(node, new THREE.Vector3());
  return total;
}

/**
 * The physics step the worker integrates at. A leaf's spring force is applied
 * explicitly, so a stiff leaf on a light body (ω·dt near 1) needs damping of at
 * least k·dt to stay stable; less than that and it rings up and flies apart.
 */
const SIM_STEP_S = 0.001;

/**
 * Joint damping for a leaf of `stiffness` moving `inertia`: the filament's loss
 * ratio of critical, 2·ζ·√(k·m), and never under the k·dt the step needs.
 */
function polymerDamping(stiffness: number, inertia: number, lossRatio: number): number {
  const k = Math.max(0, stiffness);
  const c = Math.max(2 * lossRatio * Math.sqrt(k * Math.max(inertia, 1e-9)), k * SIM_STEP_S);
  return +Math.max(1e-7, c).toPrecision(4);
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
  const joints = node.joints ?? [];
  const jointIdx = input.jointName
    ? joints.findIndex((j) => j.name === input.jointName && (j.type === 'hinge' || j.type === 'slide'))
    : joints.findIndex((j) => j.type === 'hinge' || j.type === 'slide');
  if (jointIdx < 0) return null;
  const baseJoint = joints[jointIdx];
  const jointType = baseJoint.type as 'hinge' | 'slide';

  const mergedInput: FlexureDesignInput = {
    kind: input.kind ?? node.flexure?.kind,
    filament: input.filament ?? node.flexure?.filament ?? 'petg',
    thicknessMm: input.thicknessMm ?? node.flexure?.thicknessMm,
    lengthMm: input.lengthMm ?? node.flexure?.lengthMm,
    widthMm: input.widthMm ?? node.flexure?.widthMm,
    folds: input.folds ?? node.flexure?.folds,
    archRiseMm: input.archRiseMm ?? node.flexure?.archRiseMm,
    targetDeflection: input.targetDeflection,
  };

  const evaluation = evaluateFlexureSpec(mergedInput, jointType);
  const { spec } = evaluation;

  // Calibrate joint stiffness, range & gentle structural polymer loss damping
  const updatedJoint: SceneJoint = { ...baseJoint };
  if (jointType === 'hinge') {
    updatedJoint.stiffness = spec.stiffness;
    updatedJoint.springref = 0;
    // Polymer viscoelastic loss ~3% of critical for typical body inertia
    updatedJoint.damping = polymerDamping(spec.stiffness, movingInertia(node, baseJoint), FLEXURE_FILAMENT_PROPS[resolveFilamentId(spec.filament)].lossRatio);
    updatedJoint.limited = true;
    const limDeg = Math.max(5, Math.min(135, spec.maxTravel));
    updatedJoint.range = [-limDeg, limDeg];
  } else if (spec.kind === 'serpentine') {
    updatedJoint.stiffness = spec.stiffness;
    updatedJoint.springref = 0;
    updatedJoint.damping = polymerDamping(spec.stiffness, movingInertia(node, baseJoint), FLEXURE_FILAMENT_PROPS[resolveFilamentId(spec.filament)].lossRatio);
    updatedJoint.limited = true;
    const limM = +(Math.max(0.001, spec.maxTravel / 1000)).toFixed(5);
    updatedJoint.range = [-limM, limM];
  } else {
    // Bistable toggle: linear joint stiffness MUST be 0 so physicsWorker's cubic double-well
    // `bistableForce` creates two symmetric true equilibria at q = 0 and q = 2 * h0!
    const strokeM = (2 * (spec.archRiseMm ?? 2.4)) / 1000;
    updatedJoint.stiffness = 0;
    updatedJoint.springref = 0;
    // The wells are as stiff as the arch's initial slope, so the same loss applies there.
    updatedJoint.damping = polymerDamping(spec.stiffness, movingInertia(node, baseJoint), FLEXURE_FILAMENT_PROPS[resolveFilamentId(spec.filament)].lossRatio);
    updatedJoint.limited = true;
    updatedJoint.range = [
      +(-0.35 * strokeM).toFixed(5),
      +(1.35 * strokeM).toFixed(5),
    ];
  }

  const cleanGeoms = (node.geoms ?? []).filter((g) => !g.name.startsWith('flexure_'));
  const flexureGeoms = buildFlexureGeoms(updatedJoint, spec, cleanGeoms, node.children ?? []);
  const nextJoints = joints.map((j, i) => (i === jointIdx ? updatedJoint : { ...j }));

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

// ---------------------------------------------------------------------------
// Howell PRBM Primitives: Cantilever Pawl / Latch, Parallel-Guiding Flexures,
// and Multi-Flexure Compliant Parallel-Jaw Gripper
// ---------------------------------------------------------------------------

/** Howell's Pseudo-Rigid-Body Model constants for a fixed-free cantilever beam. */
export const HOWELL_PRBM_GAMMA = 0.85;
export const HOWELL_PRBM_K_THETA = 2.65;

export interface CantileverBeamInput {
  filament?: string;
  thicknessMm?: number;
  lengthMm?: number;
  widthMm?: number;
  /** Tip deflection to evaluate (mm). Defaults to max safe deflection at SF = 1.4. */
  deflectionMm?: number;
  /** Optional catch ramp angle (deg, 5..60) for snap-latch / pawl engagement force. */
  rampAngleDeg?: number;
  /** Sliding friction coefficient for ramp engagement (default 0.22 for PETG/PLA). */
  frictionCoeff?: number;
}

export interface CantileverBeamEvaluation {
  filament: FilamentId;
  thicknessMm: number;
  lengthMm: number;
  widthMm: number;
  secondMomentM4: number;
  /** Linear tip stiffness k = 3·E·I / L³ (N/m). */
  tipStiffnessNm: number;
  /** Howell PRBM torsional stiffness K = γ·K_Θ·E·I / L (N·m/rad). */
  prbmStiffnessNmRad: number;
  /** Characteristic pivot offset (1 - γ)·L from the clamped root (mm). */
  prbmPivotOffsetMm: number;
  /** Maximum safe tip deflection at safety factor 1.4 (mm). */
  maxSafeDeflectionMm: number;
  /** Evaluated tip deflection (mm). */
  deflectionMm: number;
  /** Normal tip restoring force at `deflectionMm` (N). */
  tipForceN: number;
  /** Axial push force required to deflect the pawl over a ramp (N); 0 if no rampAngleDeg. */
  engageForceN: number;
  peakStressMPa: number;
  maxStrain: number;
  yieldStrain: number;
  safetyFactor: number;
  warnings: string[];
}

/**
 * Evaluates a fixed-free compliant cantilever beam (or snap-fit pawl/latch)
 * using Euler-Bernoulli bending + Howell's Pseudo-Rigid-Body Model.
 */
export function evaluateCantileverBeam(input: CantileverBeamInput = {}): CantileverBeamEvaluation {
  const filId = resolveFilamentId(input.filament);
  const mech = FLEXURE_FILAMENT_PROPS[filId];
  const fSpec = filamentSpec(filId);

  const thicknessMm = Math.max(0.4, Math.min(6.0, input.thicknessMm ?? (filId === 'tpu' ? 1.4 : 1.0)));
  const lengthMm = Math.max(5.0, Math.min(120.0, input.lengthMm ?? 20.0));
  const widthMm = Math.max(2.0, Math.min(60.0, input.widthMm ?? 8.0));

  const E = mech.modulusGPa * 1e9;
  const sigmaAllow = (mech.yieldMPa * 1e6) / 1.4;
  const t = thicknessMm / 1000;
  const L = lengthMm / 1000;
  const b = widthMm / 1000;
  const I = (b * t * t * t) / 12;

  const tipStiffnessNm = (3 * E * I) / (L * L * L);
  const prbmStiffnessNmRad = (HOWELL_PRBM_GAMMA * HOWELL_PRBM_K_THETA * E * I) / L;
  const prbmPivotOffsetMm = +((1 - HOWELL_PRBM_GAMMA) * lengthMm).toFixed(2);
  const maxSafeDeflectionM = Math.min(L * 0.35, (2 * sigmaAllow * L * L) / (3 * E * t));
  const maxSafeDeflectionMm = +(maxSafeDeflectionM * 1000).toFixed(2);

  const deflectionMm = input.deflectionMm !== undefined && Number.isFinite(input.deflectionMm)
    ? Math.max(0, input.deflectionMm)
    : maxSafeDeflectionMm;
  const delta = deflectionMm / 1000;

  const tipForceN = +(tipStiffnessNm * delta).toPrecision(4);
  const peakStressPa = (3 * E * t * delta) / (2 * L * L);
  const peakStressMPa = +(peakStressPa / 1e6).toFixed(2);
  const yieldStrain = +((mech.yieldMPa * 1e6) / E).toPrecision(4);
  const maxStrain = +(peakStressPa / E).toPrecision(4);
  const safetyFactor = peakStressMPa > 1e-6 ? +(mech.yieldMPa / peakStressMPa).toFixed(2) : 99;

  let engageForceN = 0;
  if (input.rampAngleDeg !== undefined && Number.isFinite(input.rampAngleDeg)) {
    const alpha = (Math.max(5, Math.min(60, input.rampAngleDeg)) * Math.PI) / 180;
    const mu = Math.max(0, Math.min(0.8, input.frictionCoeff ?? 0.22));
    const denom = Math.max(0.05, Math.cos(alpha) - mu * Math.sin(alpha));
    engageForceN = +(tipForceN * ((Math.sin(alpha) + mu * Math.cos(alpha)) / denom)).toPrecision(4);
  }

  const warnings: string[] = [];
  if (thicknessMm + 1e-6 < fSpec.minWallMm) {
    warnings.push(
      `${fSpec.label} minimum reliable two-perimeter wall is ${fSpec.minWallMm} mm (beam is ${thicknessMm.toFixed(2)} mm).`,
    );
  }
  if (mech.creepsUnderSustainedLoad) {
    warnings.push('PLA creeps under sustained latch preload; PETG or ASA is recommended for snap pawls.');
  }
  if (safetyFactor < 1.0) {
    warnings.push(
      `Cantilever deflection (${deflectionMm.toFixed(2)} mm) exceeds ${fSpec.label} yield (σ = ${peakStressMPa.toFixed(1)} MPa > ${mech.yieldMPa} MPa, SF = ${safetyFactor.toFixed(2)}).`,
    );
  } else if (safetyFactor < 1.4) {
    warnings.push(
      `Cantilever deflection (${deflectionMm.toFixed(2)} mm) has low fatigue safety factor (SF = ${safetyFactor.toFixed(2)} < 1.4).`,
    );
  }

  return {
    filament: filId,
    thicknessMm: +thicknessMm.toFixed(2),
    lengthMm: +lengthMm.toFixed(2),
    widthMm: +widthMm.toFixed(2),
    secondMomentM4: +I.toPrecision(5),
    tipStiffnessNm: +tipStiffnessNm.toPrecision(5),
    prbmStiffnessNmRad: +prbmStiffnessNmRad.toPrecision(5),
    prbmPivotOffsetMm,
    maxSafeDeflectionMm,
    deflectionMm: +deflectionMm.toFixed(2),
    tipForceN,
    engageForceN,
    peakStressMPa,
    maxStrain,
    yieldStrain,
    safetyFactor,
    warnings,
  };
}

export interface ParallelFlexureInput {
  filament?: string;
  thicknessMm?: number;
  lengthMm?: number;
  widthMm?: number;
  /** Number of parallel guiding beams (2..6, default 2). */
  numBeams?: number;
  /** Center-to-center spacing between adjacent parallel beams (mm, default 10). */
  beamSpacingMm?: number;
  /** Guided lateral deflection to evaluate (mm). Defaults to max safe deflection at SF = 1.4. */
  deflectionMm?: number;
}

export interface ParallelFlexureEvaluation {
  filament: FilamentId;
  thicknessMm: number;
  lengthMm: number;
  widthMm: number;
  numBeams: number;
  beamSpacingMm: number;
  secondMomentM4: number;
  /** Fixed-guided stiffness per beam k_leaf = 12·E·I / L³ (N/m). */
  stiffnessPerBeamNm: number;
  /** Total parallel lateral stiffness k_total = n · 12·E·I / L³ (N/m). */
  totalStiffnessNm: number;
  /** Max safe lateral deflection at SF = 1.4 (mm). */
  maxSafeDeflectionMm: number;
  /** Evaluated lateral deflection (mm). */
  deflectionMm: number;
  /** Total restoring force at `deflectionMm` (N). */
  restoringForceN: number;
  /** Parasitic axial foreshortening Δy = 3·δ² / (5·L) (mm). */
  parasiticShiftMm: number;
  peakStressMPa: number;
  maxStrain: number;
  yieldStrain: number;
  safetyFactor: number;
  warnings: string[];
}

/**
 * Evaluates a parallel-guiding compliant flexure (N fixed-guided leaf springs
 * in parallel), computing total lateral stiffness, parasitic foreshortening,
 * peak bending stress, strain, and safety factor.
 */
export function evaluateParallelFlexure(input: ParallelFlexureInput = {}): ParallelFlexureEvaluation {
  const filId = resolveFilamentId(input.filament);
  const mech = FLEXURE_FILAMENT_PROPS[filId];
  const fSpec = filamentSpec(filId);

  const thicknessMm = Math.max(0.4, Math.min(4.0, input.thicknessMm ?? Math.max(1.0, fSpec.minWallMm)));
  const lengthMm = Math.max(6.0, Math.min(100.0, input.lengthMm ?? 22.0));
  const widthMm = Math.max(2.0, Math.min(60.0, input.widthMm ?? 10.0));
  const numBeams = Math.max(2, Math.min(6, Math.round(input.numBeams ?? 2)));
  const beamSpacingMm = Math.max(thicknessMm * 3, Math.min(80, input.beamSpacingMm ?? 10.0));

  const E = mech.modulusGPa * 1e9;
  const sigmaAllow = (mech.yieldMPa * 1e6) / 1.4;
  const t = thicknessMm / 1000;
  const L = lengthMm / 1000;
  const b = widthMm / 1000;
  const I = (b * t * t * t) / 12;

  const stiffnessPerBeamNm = (12 * E * I) / (L * L * L);
  const totalStiffnessNm = numBeams * stiffnessPerBeamNm;
  const maxSafeDeflectionM = Math.min(L * 0.3, (sigmaAllow * L * L) / (3 * E * t));
  const maxSafeDeflectionMm = +(maxSafeDeflectionM * 1000).toFixed(2);

  const deflectionMm = input.deflectionMm !== undefined && Number.isFinite(input.deflectionMm)
    ? Math.max(0, input.deflectionMm)
    : maxSafeDeflectionMm;
  const delta = deflectionMm / 1000;

  const restoringForceN = +(totalStiffnessNm * delta).toPrecision(4);
  const parasiticShiftMm = +(((3 * delta * delta) / (5 * L)) * 1000).toFixed(3);
  const peakStressPa = (3 * E * t * delta) / (L * L);
  const peakStressMPa = +(peakStressPa / 1e6).toFixed(2);
  const yieldStrain = +((mech.yieldMPa * 1e6) / E).toPrecision(4);
  const maxStrain = +(peakStressPa / E).toPrecision(4);
  const safetyFactor = peakStressMPa > 1e-6 ? +(mech.yieldMPa / peakStressMPa).toFixed(2) : 99;

  const warnings: string[] = [];
  if (thicknessMm + 1e-6 < fSpec.minWallMm) {
    warnings.push(
      `${fSpec.label} minimum reliable two-perimeter wall is ${fSpec.minWallMm} mm (beam is ${thicknessMm.toFixed(2)} mm).`,
    );
  }
  if (mech.creepsUnderSustainedLoad) {
    warnings.push('PLA creeps under sustained load; switch to PETG or ASA for parallel-guiding flexures.');
  }
  if (safetyFactor < 1.0) {
    warnings.push(
      `Guided deflection (${deflectionMm.toFixed(2)} mm) exceeds ${fSpec.label} yield (σ = ${peakStressMPa.toFixed(1)} MPa > ${mech.yieldMPa} MPa, SF = ${safetyFactor.toFixed(2)}).`,
    );
  } else if (safetyFactor < 1.4) {
    warnings.push(
      `Guided deflection (${deflectionMm.toFixed(2)} mm) has low fatigue safety factor (SF = ${safetyFactor.toFixed(2)} < 1.4).`,
    );
  }
  if (deflectionMm > beamSpacingMm - thicknessMm * 1.5) {
    warnings.push(
      `Deflection (${deflectionMm.toFixed(2)} mm) approaches beam spacing (${beamSpacingMm.toFixed(1)} mm); beams may collide.`,
    );
  }

  return {
    filament: filId,
    thicknessMm: +thicknessMm.toFixed(2),
    lengthMm: +lengthMm.toFixed(2),
    widthMm: +widthMm.toFixed(2),
    numBeams,
    beamSpacingMm: +beamSpacingMm.toFixed(2),
    secondMomentM4: +I.toPrecision(5),
    stiffnessPerBeamNm: +stiffnessPerBeamNm.toPrecision(5),
    totalStiffnessNm: +totalStiffnessNm.toPrecision(5),
    maxSafeDeflectionMm,
    deflectionMm: +deflectionMm.toFixed(2),
    restoringForceN,
    parasiticShiftMm,
    peakStressMPa,
    maxStrain,
    yieldStrain,
    safetyFactor,
    warnings,
  };
}

export interface CantileverPawlBuildInput extends CantileverBeamInput {
  /** Catch nub protrusion height (mm, default 2.5). */
  catchHeightMm?: number;
  /** World origin of the anchor root (m, default [0, 0, 0.01]). */
  origin?: [number, number, number];
  idPrefix?: string;
}

export interface CantileverPawlBuildResult {
  nodes: SceneNode[];
  addedIds: string[];
  evaluation: CantileverBeamEvaluation;
}

/**
 * Builds a simulatable + 3D-printable compliant cantilever pawl / snap-latch:
 * fixed base block + hinged pawl arm calibrated to Howell's PRBM stiffness,
 * carrying a printable `flexure_cantilever` leaf that bends in the viewport.
 */
export function buildCantileverPawl(input: CantileverPawlBuildInput = {}): CantileverPawlBuildResult {
  const evaluation = evaluateCantileverBeam({
    ...input,
    rampAngleDeg: input.rampAngleDeg ?? 30,
  });
  const prefix = input.idPrefix ?? 'cantilever_pawl';
  const origin = input.origin ?? [0, 0, 0.01];
  const mech = FLEXURE_FILAMENT_PROPS[evaluation.filament];
  const rgba = mech.rgba;

  const L = evaluation.lengthMm / 1000;
  const t = evaluation.thicknessMm / 1000;
  const b = evaluation.widthMm / 1000;
  const catchH = Math.max(0.001, (input.catchHeightMm ?? 2.5) / 1000);
  const pivotOffset = evaluation.prbmPivotOffsetMm / 1000;
  const maxAngleDeg = Math.max(
    4,
    Math.min(45, +((Math.atan2(evaluation.maxSafeDeflectionMm / 1000, L * HOWELL_PRBM_GAMMA) * 180) / Math.PI).toFixed(1)),
  );

  const rootX = -pivotOffset;
  const tipX = L - pivotOffset;

  const leafGeom = leafBetween(
    'flexure_cantilever',
    new THREE.Vector3(rootX, 0, 0),
    new THREE.Vector3(tipX, 0, 0),
    new THREE.Vector3(0, 1, 0),
    t * 0.5,
    b * 0.5,
    rgba,
    0,
    1,
  );

  const catchGeom: SceneGeom = {
    name: 'pawl_catch',
    type: 'box',
    size: [Math.max(0.0015, catchH * 0.7), catchH * 0.5, b * 0.5],
    pos: [+(tipX - catchH * 0.7).toFixed(6), +((t + catchH) * 0.5).toFixed(6), 0],
    rgba: [...rgba],
  };

  const pawlJoint: SceneJoint = {
    name: `${prefix}_hinge`,
    type: 'hinge',
    axis: [0, 0, 1],
    pos: [0, 0, 0],
    stiffness: evaluation.prbmStiffnessNmRad,
    springref: 0,
    limited: true,
    range: [-maxAngleDeg, maxAngleDeg],
  };

  const pawlNode: SceneNode = {
    id: `${prefix}_arm`,
    name: 'Cantilever Pawl Arm',
    type: 'body',
    pos: [+pivotOffset.toFixed(6), 0, 0],
    deformMaterial: 'plastic',
    geoms: [catchGeom, leafGeom],
    joints: [pawlJoint],
    flexure: {
      kind: 'blade',
      filament: evaluation.filament,
      thicknessMm: evaluation.thicknessMm,
      lengthMm: evaluation.lengthMm,
      widthMm: evaluation.widthMm,
      stiffness: evaluation.prbmStiffnessNmRad,
      maxTravel: maxAngleDeg,
    },
    children: [],
  };
  pawlNode.joints[0].damping = polymerDamping(
    evaluation.prbmStiffnessNmRad,
    movingInertia(pawlNode, pawlJoint),
    mech.lossRatio,
  );

  const baseDepth = Math.max(0.006, t * 5);
  const baseHeight = Math.max(0.008, t * 6);
  const baseNode: SceneNode = {
    id: `${prefix}_base`,
    name: 'Cantilever Pawl Base',
    type: 'body',
    pos: [...origin],
    deformMaterial: 'plastic',
    geoms: [
      {
        name: 'anchor_block',
        type: 'box',
        size: [baseDepth * 0.5, baseHeight * 0.5, b * 0.5],
        pos: [+(-baseDepth * 0.5).toFixed(6), 0, 0],
        rgba: [0.35, 0.4, 0.48, 1],
      },
    ],
    joints: [],
    children: [pawlNode],
  };

  return {
    nodes: [baseNode],
    addedIds: [baseNode.id, pawlNode.id],
    evaluation,
  };
}

export interface ParallelFlexureStageBuildInput extends ParallelFlexureInput {
  /** Moving stage thickness along motion axis (mm, default 10). */
  stageDepthMm?: number;
  /** World origin of the fixed anchor base (m, default [0, 0, 0.01]). */
  origin?: [number, number, number];
  idPrefix?: string;
}

export interface ParallelFlexureStageBuildResult {
  nodes: SceneNode[];
  addedIds: string[];
  evaluation: ParallelFlexureEvaluation;
}

/**
 * Builds a simulatable + monolithic 3D-printable parallel-guiding flexure stage:
 * fixed anchor rail + guided moving stage on a calibrated `slide` joint with
 * `numBeams` parallel fixed-guided leaf springs (`flexure_parallel_*`).
 */
export function buildParallelFlexureStage(input: ParallelFlexureStageBuildInput = {}): ParallelFlexureStageBuildResult {
  const evaluation = evaluateParallelFlexure(input);
  const prefix = input.idPrefix ?? 'parallel_flexure';
  const origin = input.origin ?? [0, 0, 0.01];
  const mech = FLEXURE_FILAMENT_PROPS[evaluation.filament];
  const rgba = mech.rgba;

  const L = evaluation.lengthMm / 1000;
  const t = evaluation.thicknessMm / 1000;
  const b = evaluation.widthMm / 1000;
  const n = evaluation.numBeams;
  const spacing = evaluation.beamSpacingMm / 1000;
  const stageDepth = Math.max(0.006, (input.stageDepthMm ?? 10) / 1000);
  const spanY = (n - 1) * spacing + Math.max(0.006, t * 4);
  const limM = +(Math.max(0.0005, evaluation.maxSafeDeflectionMm / 1000)).toFixed(5);

  const stageGeoms: SceneGeom[] = [
    {
      name: 'guided_stage',
      type: 'box',
      size: [stageDepth * 0.5, spanY * 0.5, b * 0.5],
      pos: [0, 0, 0],
      rgba: [...rgba],
    },
  ];

  // Beams bridge from anchor face (x = -L - stageDepth/2) to stage face (x = -stageDepth/2)
  const y0 = -((n - 1) * spacing) / 2;
  for (let i = 0; i < n; i++) {
    const y = y0 + i * spacing;
    stageGeoms.push(
      leafBetween(
        `flexure_parallel_${i}`,
        new THREE.Vector3(-stageDepth * 0.5 - L, y, 0),
        new THREE.Vector3(-stageDepth * 0.5, y, 0),
        new THREE.Vector3(0, 1, 0),
        t * 0.5,
        b * 0.5,
        rgba,
        0,
        1,
      ),
    );
  }

  const slideJoint: SceneJoint = {
    name: `${prefix}_slide`,
    type: 'slide',
    axis: [0, 1, 0],
    pos: [0, 0, 0],
    stiffness: evaluation.totalStiffnessNm,
    springref: 0,
    limited: true,
    range: [-limM, limM],
  };

  const stageNode: SceneNode = {
    id: `${prefix}_stage`,
    name: 'Parallel Flexure Stage',
    type: 'body',
    pos: [+(L + stageDepth).toFixed(6), 0, 0],
    deformMaterial: 'plastic',
    geoms: stageGeoms,
    joints: [slideJoint],
    flexure: {
      kind: 'serpentine',
      filament: evaluation.filament,
      thicknessMm: evaluation.thicknessMm,
      lengthMm: evaluation.lengthMm,
      widthMm: evaluation.widthMm,
      folds: n,
      stiffness: evaluation.totalStiffnessNm,
      maxTravel: evaluation.maxSafeDeflectionMm,
    },
    children: [],
  };
  stageNode.joints[0].damping = polymerDamping(
    evaluation.totalStiffnessNm,
    movingInertia(stageNode, slideJoint),
    mech.lossRatio,
  );

  const baseNode: SceneNode = {
    id: `${prefix}_base`,
    name: 'Parallel Flexure Base',
    type: 'body',
    pos: [...origin],
    deformMaterial: 'plastic',
    geoms: [
      {
        name: 'anchor_rail',
        type: 'box',
        size: [stageDepth * 0.5, spanY * 0.5, b * 0.5],
        pos: [0, 0, 0],
        rgba: [0.35, 0.4, 0.48, 1],
      },
    ],
    joints: [],
    children: [stageNode],
  };

  return {
    nodes: [baseNode],
    addedIds: [baseNode.id, stageNode.id],
    evaluation,
  };
}

export interface CompliantGripperInput {
  filament?: string;
  /** Clear distance between the two gripping jaws at rest (mm, default 24). */
  jawOpeningMm?: number;
  /** Forward length of the gripping fingers (mm, default 28). */
  jawLengthMm?: number;
  /** Thickness of each jaw bar (mm, default 6). */
  jawThicknessMm?: number;
  /** Flexure leaf thickness (mm, default 1.0 for PETG/PLA/ABS/ASA, 1.2 for TPU; always >= filament minWallMm). */
  beamThicknessMm?: number;
  /** Flexure leaf length (mm, default 22). */
  beamLengthMm?: number;
  /** Out-of-plane print height / extrusion width (mm, default 10). */
  beamWidthMm?: number;
  /** Number of parallel flexure beams per jaw (2..5, default 3 => 6 flexures total). */
  beamsPerJaw?: number;
  /** Spacing between parallel beams along the jaw (mm, default 10). */
  beamSpacingMm?: number;
  /** Design closing stroke per jaw (mm, defaults to safe travel clamped to half-opening). */
  strokeMm?: number;
  /** World origin of the gripper palm (m, default [0, 0, 0.01]). */
  origin?: [number, number, number];
  idPrefix?: string;
}

export interface CompliantGripperBuildResult {
  nodes: SceneNode[];
  addedIds: string[];
  /** Per-jaw parallel flexure evaluation. */
  evaluation: ParallelFlexureEvaluation;
  /** Total number of individual flexure beams across both jaws (2 × beamsPerJaw). */
  totalFlexureCount: number;
  /** Elastic restoring force per jaw at design stroke (N). */
  pinchForceAtStrokeN: number;
  /** Parasitic axial jaw foreshortening at design stroke (mm). */
  parasiticShiftMm: number;
  warnings: string[];
}

/**
 * Builds a complete, monolithic 3D-printable AND MuJoCo-simulatable compliant
 * parallel-jaw gripper (default 2 jaws × 3 parallel flexures = 6 flexures).
 *
 * Each jaw rides on a calibrated parallel-guiding `slide` joint along ±X with
 * stiffness `k = beamsPerJaw · 12·E·I / L³`, polymer loss damping, and
 * `flexure_parallel_*` leaves carrying `bend` so the jaws visibly flex in
 * MuJoCo while exporting monolithically at rest without manual model duplication.
 */
export function buildCompliantGripper(input: CompliantGripperInput = {}): CompliantGripperBuildResult {
  const filId = resolveFilamentId(input.filament);
  const fSpec = filamentSpec(filId);
  const beamsPerJaw = Math.max(2, Math.min(5, Math.round(input.beamsPerJaw ?? 3)));
  const jawOpeningMm = Math.max(4, Math.min(120, input.jawOpeningMm ?? 24));
  const jawLengthMm = Math.max(10, Math.min(100, input.jawLengthMm ?? 28));
  const jawThicknessMm = Math.max(3, Math.min(20, input.jawThicknessMm ?? 6));
  const beamSpacingMm = Math.max(4, Math.min(40, input.beamSpacingMm ?? 10));
  const defaultBeamThicknessMm = Math.max(1.0, fSpec.minWallMm);

  // Preliminary evaluation to determine max safe stroke if caller omitted strokeMm
  const prelim = evaluateParallelFlexure({
    filament: filId,
    thicknessMm: input.beamThicknessMm ?? defaultBeamThicknessMm,
    lengthMm: input.beamLengthMm,
    widthMm: input.beamWidthMm,
    numBeams: beamsPerJaw,
    beamSpacingMm,
  });
  const maxHalfOpeningMm = Math.max(1, jawOpeningMm * 0.5 - 1);
  const strokeMm = input.strokeMm !== undefined && Number.isFinite(input.strokeMm)
    ? Math.max(0.2, input.strokeMm)
    : +Math.min(prelim.maxSafeDeflectionMm, maxHalfOpeningMm).toFixed(2);

  const evaluation = evaluateParallelFlexure({
    filament: filId,
    thicknessMm: prelim.thicknessMm,
    lengthMm: prelim.lengthMm,
    widthMm: prelim.widthMm,
    numBeams: beamsPerJaw,
    beamSpacingMm,
    deflectionMm: strokeMm,
  });

  const prefix = input.idPrefix ?? 'compliant_gripper';
  const origin = input.origin ?? [0, 0, 0.01];
  const mech = FLEXURE_FILAMENT_PROPS[filId];
  const rgba = mech.rgba;

  const L = evaluation.lengthMm / 1000;
  const t = evaluation.thicknessMm / 1000;
  const b = evaluation.widthMm / 1000;
  const openHalf = (jawOpeningMm / 1000) * 0.5;
  const jawLen = jawLengthMm / 1000;
  const jawThick = jawThicknessMm / 1000;
  const spacing = evaluation.beamSpacingMm / 1000;
  const flexureSpanY = (beamsPerJaw - 1) * spacing + Math.max(0.005, t * 4);
  const leafPitchX = Math.max(t * 3, spacing * 0.55);
  const leafMargin = Math.max(t * 2, 0.0025);
  const outerLeafX = (beamsPerJaw - 1) * leafPitchX;
  const bridgeOuterExtent = Math.max(jawThick * 0.5, outerLeafX + leafMargin);
  const palmHalfX = Math.max(0.006, openHalf + jawThick * 0.5 + bridgeOuterExtent);
  const palmDepthY = Math.max(0.010, flexureSpanY * 0.45);
  const limM = +(Math.max(0.001, Math.min(evaluation.maxSafeDeflectionMm / 1000, maxHalfOpeningMm / 1000))).toFixed(5);

  const buildJaw = (side: -1 | 1): SceneNode => {
    const tag = side < 0 ? 'left' : 'right';
    // Jaw center X sits outside the clear opening by jawThick / 2
    const jawX = side * (openHalf + jawThick * 0.5);
    // Rigid jaw-base crossbar bridges the jaw body out to the outermost parallel flexure leaf
    // while keeping the gripping throat (|X| < openHalf) completely unobstructed.
    const bridgeInnerX = -side * (jawThick * 0.5);
    const bridgeOuterX = side * bridgeOuterExtent;
    const bridgeCenterX = (bridgeInnerX + bridgeOuterX) * 0.5;
    const bridgeHalfX = Math.abs(bridgeOuterX - bridgeInnerX) * 0.5;
    const bridgeDepthY = Math.min(flexureSpanY, Math.max(0.005, jawThick * 0.85));
    const bridgeCenterY = -flexureSpanY * 0.5 + bridgeDepthY * 0.5;

    // Anchor rail sits behind the jaw at y = -L in jaw-local coordinates
    const jawGeoms: SceneGeom[] = [
      {
        name: `jaw_${tag}_body`,
        type: 'box',
        size: [jawThick * 0.5, (flexureSpanY + jawLen) * 0.5, b * 0.5],
        pos: [0, +(jawLen * 0.5).toFixed(6), 0],
        rgba: [...rgba],
      },
      {
        name: `jaw_${tag}_bridge`,
        type: 'box',
        size: [+bridgeHalfX.toFixed(6), +(bridgeDepthY * 0.5).toFixed(6), b * 0.5],
        pos: [+bridgeCenterX.toFixed(6), +bridgeCenterY.toFixed(6), 0],
        rgba: [...rgba],
      },
      {
        name: `jaw_${tag}_pad`,
        type: 'box',
        size: [Math.max(0.001, jawThick * 0.18), jawLen * 0.35, b * 0.48],
        pos: [+(-side * (jawThick * 0.5 + jawThick * 0.14)).toFixed(6), +(flexureSpanY * 0.5 + jawLen * 0.55).toFixed(6), 0],
        rgba: [0.22, 0.26, 0.32, 1],
      },
    ];

    // Parallel flexure leaves run along Y from palm (-flexureSpanY/2 - L) to jaw bridge (-flexureSpanY/2),
    // stepped outward (+side) so every beam connects solidly to both palm and jaw bridge
    // while preserving full jawOpeningMm center clearance (> 2 * strokeMm).
    for (let i = 0; i < beamsPerJaw; i++) {
      const xLeaf = side * (i * leafPitchX);
      const yFrom = -flexureSpanY * 0.5 - L;
      const yTo = -flexureSpanY * 0.5;
      jawGeoms.push(
        leafBetween(
          `flexure_parallel_${tag}_${i}`,
          new THREE.Vector3(xLeaf, yFrom, 0),
          new THREE.Vector3(xLeaf, yTo, 0),
          new THREE.Vector3(1, 0, 0),
          t * 0.5,
          b * 0.5,
          rgba,
          0,
          1,
        ),
      );
    }

    const slideJoint: SceneJoint = {
      name: `${prefix}_jaw_${tag}_slide`,
      type: 'slide',
      axis: [-side, 0, 0], // positive q closes the jaw inward toward centerline
      pos: [0, 0, 0],
      stiffness: evaluation.totalStiffnessNm,
      springref: 0,
      limited: true,
      range: [+(-limM * 0.4).toFixed(5), limM],
    };

    const jawNode: SceneNode = {
      id: `${prefix}_jaw_${tag}`,
      name: `Compliant Jaw (${tag})`,
      type: 'body',
      pos: [+jawX.toFixed(6), +(L + flexureSpanY * 0.5).toFixed(6), 0],
      deformMaterial: 'plastic',
      geoms: jawGeoms,
      joints: [slideJoint],
      flexure: {
        kind: 'serpentine',
        filament: filId,
        thicknessMm: evaluation.thicknessMm,
        lengthMm: evaluation.lengthMm,
        widthMm: evaluation.widthMm,
        folds: beamsPerJaw,
        stiffness: evaluation.totalStiffnessNm,
        maxTravel: evaluation.maxSafeDeflectionMm,
      },
      children: [],
    };
    jawNode.joints[0].damping = polymerDamping(
      evaluation.totalStiffnessNm,
      movingInertia(jawNode, slideJoint),
      mech.lossRatio,
    );
    return jawNode;
  };

  const leftJaw = buildJaw(-1);
  const rightJaw = buildJaw(1);

  const baseNode: SceneNode = {
    id: `${prefix}_base`,
    name: 'Compliant Gripper Palm',
    type: 'body',
    pos: [...origin],
    deformMaterial: 'plastic',
    geoms: [
      {
        name: 'gripper_palm',
        type: 'box',
        size: [+palmHalfX.toFixed(6), +(palmDepthY * 0.5).toFixed(6), b * 0.5],
        pos: [0, +(-palmDepthY * 0.5).toFixed(6), 0],
        rgba: [0.32, 0.38, 0.46, 1],
      },
    ],
    joints: [],
    children: [leftJaw, rightJaw],
  };

  return {
    nodes: [baseNode],
    addedIds: [baseNode.id, leftJaw.id, rightJaw.id],
    evaluation,
    totalFlexureCount: beamsPerJaw * 2,
    pinchForceAtStrokeN: evaluation.restoringForceN,
    parasiticShiftMm: evaluation.parasiticShiftMm,
    warnings: [...evaluation.warnings],
  };
}

// ---------------------------------------------------------------------------
// Multi-Flexure Scene Analysis & PRBM -> Monolithic 3D-Print Bridge
// ---------------------------------------------------------------------------

export interface SceneFlexureItem {
  nodeId: string;
  nodeName: string;
  kind: FlexureKind;
  filament: FilamentId;
  leafCount: number;
  stiffness: number;
  maxTravel: number;
  peakStressMPa: number;
  maxStrain: number;
  safetyFactor: number;
  warnings: string[];
}

export interface SceneFlexureAnalysis {
  flexureCount: number;
  totalLeafCount: number;
  minSafetyFactor: number | null;
  hasWarnings: boolean;
  items: SceneFlexureItem[];
  warnings: string[];
}

/**
 * Audits every compliant flexure in a scene graph, returning per-joint
 * stiffness, peak stress, surface strain, safety factor, leaf counts, and
 * aggregated engineering warnings.
 */
export function analyzeSceneFlexures(nodes: SceneNode[]): SceneFlexureAnalysis {
  const items: SceneFlexureItem[] = [];
  const warnings: string[] = [];

  const walk = (list: SceneNode[]) => {
    for (const n of list) {
      if (n.flexure) {
        const primaryJoint = (n.joints ?? []).find((j) => j.type === 'hinge' || j.type === 'slide');
        const jointType: 'hinge' | 'slide' = primaryJoint?.type === 'slide' ? 'slide' : 'hinge';
        const ev = evaluateFlexureSpec(n.flexure, jointType);
        const leafCount = (n.geoms ?? []).filter((g) => g.name.startsWith('flexure_') || Boolean(g.bend)).length;
        const itemWarnings = [...ev.warnings];
        if (leafCount === 0) {
          itemWarnings.push(`Node '${n.id}' has a flexure spec but no printable flexure_* leaf geoms.`);
        }
        items.push({
          nodeId: n.id,
          nodeName: n.name,
          kind: n.flexure.kind,
          filament: resolveFilamentId(n.flexure.filament),
          leafCount,
          stiffness: n.flexure.stiffness,
          maxTravel: n.flexure.maxTravel,
          peakStressMPa: ev.peakStressMPa,
          maxStrain: ev.maxStrain,
          safetyFactor: ev.safetyFactor,
          warnings: itemWarnings,
        });
        for (const w of itemWarnings) warnings.push(`[${n.id}] ${w}`);
      }
      if (n.children?.length) walk(n.children);
    }
  };
  walk(nodes);

  const totalLeafCount = items.reduce((sum, it) => sum + it.leafCount, 0);
  const minSafetyFactor = items.length > 0 ? Math.min(...items.map((it) => it.safetyFactor)) : null;

  return {
    flexureCount: items.length,
    totalLeafCount,
    minSafetyFactor,
    hasWarnings: warnings.length > 0,
    items,
    warnings,
  };
}

function nodeQuat(n: SceneNode): THREE.Quaternion {
  if (n.quat && n.quat.length === 4) {
    return new THREE.Quaternion(n.quat[1], n.quat[2], n.quat[3], n.quat[0]).normalize();
  }
  if (n.euler && n.euler.length === 3) {
    const d = Math.PI / 180;
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(n.euler[0] * d, n.euler[1] * d, n.euler[2] * d, 'XYZ'));
  }
  return new THREE.Quaternion();
}

function transformGeomToParent(
  g: SceneGeom,
  childPos: THREE.Vector3,
  childQuat: THREE.Quaternion,
  namePrefix: string,
): SceneGeom {
  const gp = new THREE.Vector3(g.pos?.[0] ?? 0, g.pos?.[1] ?? 0, g.pos?.[2] ?? 0)
    .applyQuaternion(childQuat)
    .add(childPos);
  const gq = geomRotation(g) ?? new THREE.Quaternion();
  const combined = childQuat.clone().multiply(gq).normalize();
  const isFlexLeaf = g.name.startsWith('flexure_') || Boolean(g.bend);
  const out: SceneGeom = {
    ...g,
    name: `${namePrefix}_${g.name}`,
    pos: [+gp.x.toFixed(6), +gp.y.toFixed(6), +gp.z.toFixed(6)],
    quat: [+combined.w.toFixed(6), +combined.x.toFixed(6), +combined.y.toFixed(6), +combined.z.toFixed(6)],
  };
  delete out.euler;
  if (isFlexLeaf) {
    delete out.role;
    delete out.bend;
  }
  return out;
}

/**
 * Converts a multi-body PRBM compliant mechanism tree into a monolithic
 * 3D-printable node tree at rest pose:
 *   - Flattens every flexure-attached child body into its parent's frame
 *   - Strips simulation joints so the mechanism exports as one rigid monolithic part
 *   - Promotes `flexure_*` visual-bend leaves to solid printable geometry
 *
 * Pure function — does not mutate the input nodes.
 */
export function buildMonolithicPrintNodes(nodes: SceneNode[]): SceneNode[] {
  const flattenInto = (
    node: SceneNode,
    accGeoms: SceneGeom[],
    relPos: THREE.Vector3,
    relQuat: THREE.Quaternion,
    prefix: string,
  ) => {
    for (const g of node.geoms ?? []) {
      if (g.role === 'collision') continue;
      accGeoms.push(transformGeomToParent(g, relPos, relQuat, prefix));
    }
    for (const child of node.children ?? []) {
      const cp = new THREE.Vector3(child.pos?.[0] ?? 0, child.pos?.[1] ?? 0, child.pos?.[2] ?? 0)
        .applyQuaternion(relQuat)
        .add(relPos);
      const cq = relQuat.clone().multiply(nodeQuat(child)).normalize();
      flattenInto(child, accGeoms, cp, cq, child.id);
    }
  };

  const hasFlexureDescendant = (n: SceneNode): boolean =>
    Boolean(n.flexure) || (n.children ?? []).some(hasFlexureDescendant);

  return nodes.map((n) => {
    if (!hasFlexureDescendant(n)) {
      return { ...n, children: n.children ? buildMonolithicPrintNodes(n.children) : [] };
    }
    const mergedGeoms: SceneGeom[] = [];
    for (const g of n.geoms ?? []) {
      if (g.role === 'collision') continue;
      const isFlexLeaf = g.name.startsWith('flexure_') || Boolean(g.bend);
      if (isFlexLeaf) {
        const solid: SceneGeom = { ...g };
        delete solid.role;
        delete solid.bend;
        mergedGeoms.push(solid);
      } else {
        mergedGeoms.push({ ...g });
      }
    }
    const keptChildren: SceneNode[] = [];
    for (const child of n.children ?? []) {
      if (hasFlexureDescendant(child)) {
        const cp = new THREE.Vector3(child.pos?.[0] ?? 0, child.pos?.[1] ?? 0, child.pos?.[2] ?? 0);
        const cq = nodeQuat(child);
        flattenInto(child, mergedGeoms, cp, cq, child.id);
      } else {
        keptChildren.push(...buildMonolithicPrintNodes([child]));
      }
    }
    const out: SceneNode = {
      ...n,
      geoms: mergedGeoms,
      joints: [],
      children: keptChildren,
    };
    delete out.flexure;
    return out;
  });
}
