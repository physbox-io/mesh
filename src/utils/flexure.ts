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
    // N guided cantilevers in series per side (k_seg = 12 E I / L^3, k_side = k_seg / N),
    // and a folded spring on each side of the body in parallel
    stiffness = (2 * 12 * E * I) / (N * L * L * L);
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
