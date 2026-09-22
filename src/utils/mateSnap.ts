// ---------------------------------------------------------------------------
// Landing a part on the geometry that is already there
// ---------------------------------------------------------------------------
//
// Putting two parts together in this app has meant arithmetic. To sit a bracket
// on a plate you work out the plate's half-height, add the bracket's, and type
// the sum. To put a peg in a hole you need the hole's centre — which, after a
// boolean, no longer exists anywhere in the document.
//
// So a drag is pulled toward the things a person is actually aiming at: a
// corner onto a corner, an axis into a hole, a face flat onto a face. The
// features themselves come from `mateFeatures.ts`, which reads them off the
// DRAWN scene (the measure tool's candidate hunt, which already recovers a
// hole's centre by fitting a circle to the vertices around its rim). This file
// is only the solve, and is deliberately free of three.js and of the store, so
// the behaviour can be tested on numbers rather than eyeballed in a viewport.
//
// Three things are worth knowing before changing anything here.
//
// 1. THE FLOOR SNAP IS ALREADY ONE OF THESE. `floorSnap.ts` mates the body's
//    lowest point to the ground plane: a band in screen pixels, a deadzone so
//    it lands, a smoothstep ease so nothing teleports, a strength that fades
//    the hint. This generalises that one shape rather than inventing a second,
//    and shares its curve outright — `snapEase` is imported, not copied.
//
// 2. EACH MATE CONSTRAINS AS LITTLE AS IT HAS TO. A corner fixes all three
//    axes, an axis fixes the two across it and lets the part slide in the hole,
//    a face fixes only its normal and lets the part slide around on it. What is
//    left over is reported as `free`, and the caller keeps applying the floor
//    snap along exactly those directions — which is what makes dropping a peg
//    into an upright hole give you concentric AND seated, in one gesture.
//
// 3. A MATE NEVER TURNS THE PART. A translate drag that silently reorients
//    something is the classic way a gizmo comes to feel possessed, so a face
//    mate is offered only when the two faces ALREADY face each other. Turning
//    to suit is the rotate handles' job, and `solveAlignAboutAxis` below does
//    it under the same curve — confined to the ring actually being dragged.
// ---------------------------------------------------------------------------

import { snapEase } from './floorSnap';
import type { Vec3 } from './measureSnap';

export type { Vec3 };

/** A quaternion in Three's order: x, y, z, w. */
export type Quat = [number, number, number, number];

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

/** A corner, an edge midpoint or a centre: a place, with nothing to align to. */
export interface PointFeature {
  kind: 'point';
  point: Vec3;
  label: string;
  nodeId?: string;
}

/** A hole or a boss: a line in space, with a size that has to match. */
export interface AxisFeature {
  kind: 'axis';
  /** A point ON the axis — which end does not matter, the line is what counts. */
  point: Vec3;
  /** Unit direction. Its sign is meaningless: a hole is the same hole either way. */
  dir: Vec3;
  radius: number;
  label: string;
  nodeId?: string;
}

/** A flat face: a plane, bounded enough to know when two of them overlap. */
export interface FaceFeature {
  kind: 'face';
  /** The middle of the face. */
  point: Vec3;
  /** Unit OUTWARD normal — which side is material matters here. */
  normal: Vec3;
  /** Half the face's larger in-plane dimension: how far it reaches sideways. */
  extent: number;
  label: string;
  nodeId?: string;
}

export type MateFeature = PointFeature | AxisFeature | FaceFeature;
export type MateKind = MateFeature['kind'];

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * How nearly parallel two axes, or two face normals, have to be.
 *
 * Three degrees: tight enough that a part visibly askew is not quietly treated
 * as aligned, loose enough to forgive a rotation typed as 45 when the neighbour
 * was built at 45.0001.
 */
export const PARALLEL_TOL_DEG = 3;

/**
 * How different two radii may be and still be called the same hole, as a
 * fraction of the larger. A peg is usually a little under its hole and a boss a
 * little over its counterbore; thirty per cent covers clearance fits without
 * letting a 3 mm pin claim a 20 mm bore.
 */
export const RADIUS_TOL = 0.3;

/**
 * Per-kind multipliers on the snap band.
 *
 * A face mate gets a wider band because dropping one part onto another is the
 * coarse, confident gesture — you are nowhere near a specific corner, and you
 * should not have to be. A corner is the precise one and gets the plain band.
 */
export const BAND_WEIGHT: Record<MateKind, number> = { point: 1, axis: 1, face: 1.25 };

/**
 * How much nearer a LESS specific mate has to be to beat a more specific one.
 *
 * Specificity comes first: a corner says more about intent than a face does, so
 * a corner within reach wins even when a face happens to be somewhat nearer.
 * But a face all but touching should not lose to a corner right at the edge of
 * the band, so there is an escape. At 0.3 the two cases that set the number
 * both come out right: a face 0.2 mm away beats a corner 9 mm away, and a
 * corner 3 mm away still beats a face 1 mm away.
 */
export const TIE_BREAK = 0.3;

/** Specificity: how much a mate of this kind says about what was meant. */
const RANK: Record<MateKind, number> = { point: 0, axis: 1, face: 2 };

/** Below this a vector has no reliable direction and is treated as having none. */
const TINY = 1e-9;

// ---------------------------------------------------------------------------
// Vector helpers, kept local so this module needs no three.js
// ---------------------------------------------------------------------------

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 => {
  const l = len(a);
  return l < TINY ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
};
const finite = (a: Vec3): boolean => Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]);

/** The part of `v` perpendicular to a unit direction `d`. */
const perpendicular = (v: Vec3, d: Vec3): Vec3 => sub(v, scale(d, dot(v, d)));

/** Two unit vectors spanning the plane with this normal. */
function spanOf(normal: Vec3): Vec3[] {
  const seed: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = norm(cross(normal, seed));
  const v = norm(cross(normal, u));
  return [u, v];
}

// ---------------------------------------------------------------------------
// Quaternions, likewise local
// ---------------------------------------------------------------------------

export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const a = norm(axis);
  const h = angle / 2;
  const s = Math.sin(h);
  return [a[0] * s, a[1] * s, a[2] * s, Math.cos(h)];
}

/** `a` applied AFTER `b` — the same order Three's `multiply` uses. */
export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function applyQuat(v: Vec3, q: Quat): Vec3 {
  const [x, y, z, w] = q;
  // The standard v + 2w(u×v) + 2u×(u×v) form, with u the vector part.
  const u: Vec3 = [x, y, z];
  const uv = cross(u, v);
  const uuv = cross(u, uv);
  return add(v, add(scale(uv, 2 * w), scale(uuv, 2)));
}

// ---------------------------------------------------------------------------
// The translate solve
// ---------------------------------------------------------------------------

export interface MateSolution {
  /** Where the drag should actually put the handle. */
  position: Vec3;
  /** What was added to the proposed position to get there. */
  offset: Vec3;
  /** 0 at the edge of the band, 1 locked — drives the hint's opacity. */
  strength: number;
  /** True when the mate is being held exactly. */
  locked: boolean;
  kind: MateKind;
  label: string;
  /** The two features, for drawing: where the part is, and where it is going. */
  from: Vec3;
  to: Vec3;
  /**
   * Unit directions this mate does NOT constrain.
   *
   * What the floor snap is still allowed to move. Empty for a corner, the axis
   * for a hole, the two in-plane directions for a face.
   */
  free: Vec3[];
  /** Set for a concentric mate: the shared line, for the hint to draw along. */
  axis?: { point: Vec3; dir: Vec3; radius: number };
  /** Set for a face mate: the fixed face it landed on. */
  plane?: { point: Vec3; normal: Vec3; extent: number };
}

/** One pairing under consideration, before the ease is applied. */
interface Pairing {
  kind: MateKind;
  /** What to add to the position to satisfy the mate exactly. */
  correction: Vec3;
  /** How far that is — the residual the ease is measured against. */
  distance: number;
  label: string;
  from: Vec3;
  to: Vec3;
  free: Vec3[];
  axis?: { point: Vec3; dir: Vec3; radius: number };
  plane?: { point: Vec3; normal: Vec3; extent: number };
}

/** Corner onto corner: the whole offset between them. */
function pairPoints(moving: PointFeature, fixed: PointFeature): Pairing | null {
  const correction = sub(fixed.point, moving.point);
  return {
    kind: 'point',
    correction,
    distance: len(correction),
    label: `${moving.label} to ${fixed.label}`,
    from: moving.point,
    to: fixed.point,
    free: [],
  };
}

/**
 * Axis into axis: bring the two lines onto each other, and nothing else.
 *
 * The correction is the offset between the lines measured ACROSS the shared
 * direction — the component along it is dropped, which is exactly what lets a
 * peg slide up and down inside the hole it has snapped into rather than
 * jumping to a fixed depth nobody asked for.
 */
function pairAxes(moving: AxisFeature, fixed: AxisFeature, cosTol: number): Pairing | null {
  const a = norm(moving.dir);
  const b = norm(fixed.dir);
  if (len(a) < 0.5 || len(b) < 0.5) return null;
  // Absolute: a hole has no preferred end, so opposed directions are the same line.
  if (Math.abs(dot(a, b)) < cosTol) return null;

  const bigger = Math.max(moving.radius, fixed.radius);
  if (bigger > TINY && Math.abs(moving.radius - fixed.radius) / bigger > RADIUS_TOL) return null;

  const correction = perpendicular(sub(fixed.point, moving.point), b);
  return {
    kind: 'axis',
    correction,
    distance: len(correction),
    label: `${moving.label} into ${fixed.label}`,
    from: moving.point,
    to: add(moving.point, correction),
    free: [b],
    axis: { point: fixed.point, dir: b, radius: fixed.radius },
  };
}

/**
 * Face flat onto face: close the gap along the normal, and nothing else.
 *
 * Two gates, and both earn their place. The normals must ALREADY be opposed,
 * because a translate drag is not allowed to turn the part (see the header).
 * And the faces must overlap sideways, or a plate would mate with a bench top
 * clear across the scene for no better reason than being level with it.
 */
function pairFaces(moving: FaceFeature, fixed: FaceFeature, cosTol: number): Pairing | null {
  const n = norm(fixed.normal);
  const m = norm(moving.normal);
  if (len(n) < 0.5 || len(m) < 0.5) return null;
  if (dot(m, n) > -cosTol) return null;

  const between = sub(fixed.point, moving.point);
  const gap = dot(between, n);
  const sideways = len(perpendicular(between, n));
  if (sideways > moving.extent + fixed.extent) return null;

  const correction = scale(n, gap);
  return {
    kind: 'face',
    correction,
    distance: Math.abs(gap),
    label: `${moving.label} flush on ${fixed.label}`,
    from: moving.point,
    to: add(moving.point, correction),
    free: spanOf(n),
    plane: { point: fixed.point, normal: n, extent: fixed.extent },
  };
}

/** Whether `a` should be preferred to `b`. See TIE_BREAK. */
function beats(a: Pairing, b: Pairing): boolean {
  const ra = RANK[a.kind];
  const rb = RANK[b.kind];
  if (ra === rb) return a.distance < b.distance;
  // The more specific one holds unless the other is nearer by a clear margin.
  if (ra < rb) return !(b.distance < a.distance * TIE_BREAK);
  return a.distance < b.distance * TIE_BREAK;
}

/**
 * The mate a drag is closest to wanting, or null when it is not near one.
 *
 * `moving` are the dragged body's features where this frame's drag has put
 * them; `fixed` are everything else's, gathered once. Both are in the same
 * frame as `position` — MuJoCo world metres, for every caller here.
 */
export function solveMate(input: {
  moving: MateFeature[];
  fixed: MateFeature[];
  position: Vec3;
  threshold: number;
  parallelToleranceDeg?: number;
}): MateSolution | null {
  const { moving, fixed, position, threshold } = input;
  if (!(threshold > 0) || !finite(position)) return null;
  if (moving.length === 0 || fixed.length === 0) return null;

  const cosTol = Math.cos(((input.parallelToleranceDeg ?? PARALLEL_TOL_DEG) * Math.PI) / 180);

  let best: Pairing | null = null;
  for (const m of moving) {
    for (const f of fixed) {
      if (m.kind !== f.kind) continue;
      let pairing: Pairing | null = null;
      if (m.kind === 'point' && f.kind === 'point') pairing = pairPoints(m, f);
      else if (m.kind === 'axis' && f.kind === 'axis') pairing = pairAxes(m, f, cosTol);
      else if (m.kind === 'face' && f.kind === 'face') pairing = pairFaces(m, f, cosTol);
      if (!pairing) continue;
      // Outside its own band it was not aimed at, whatever its rank.
      if (!(pairing.distance < threshold * BAND_WEIGHT[pairing.kind])) continue;
      if (!best || beats(pairing, best)) best = pairing;
    }
  }
  if (!best) return null;

  const ease = snapEase(best.distance, threshold * BAND_WEIGHT[best.kind]);
  // `factor` is the fraction of the gap left alone, so what is closed is the rest.
  const offset = scale(best.correction, 1 - ease.factor);
  return {
    position: add(position, offset),
    offset,
    strength: ease.strength,
    locked: ease.locked,
    kind: best.kind,
    label: best.label,
    from: best.from,
    to: best.to,
    free: best.free,
    ...(best.axis ? { axis: best.axis } : {}),
    ...(best.plane ? { plane: best.plane } : {}),
  };
}

// ---------------------------------------------------------------------------
// The scale solve
// ---------------------------------------------------------------------------

export interface ScaleSolution {
  /** The factor the gesture should actually use. */
  factor: number;
  strength: number;
  locked: boolean;
  label: string;
  /** The radius it is being pulled to, for the hint and the readout. */
  radius: number;
}

/**
 * Sizes a part to fit a hole it is being scaled next to.
 *
 * The companion to the concentric mate, and the half of that gesture the mate
 * cannot do: snapping a peg into a bore lines up its axis, but a peg that is
 * the wrong diameter still will not go in, and getting it right meant reading
 * one diameter off the model and typing the other. So the scale gesture is
 * pulled toward the factors that make them match.
 *
 * Measured in METRES of radius rather than in the factor, so the band is the
 * same physical size as every other snap here — a factor is dimensionless and
 * the same tenth of it means a tenth of a millimetre on a pin and a centimetre
 * on a flange.
 *
 * `moving` are the dragged body's features at the size it STARTED, so the
 * factor is always relative to the same thing however far the gesture has run.
 */
export function solveScaleToFit(input: {
  moving: MateFeature[];
  fixed: MateFeature[];
  factor: number;
  threshold: number;
}): ScaleSolution | null {
  const { moving, fixed, factor, threshold } = input;
  if (!(threshold > 0) || !Number.isFinite(factor) || factor <= 0) return null;

  let best: { distance: number; from: AxisFeature; to: AxisFeature } | null = null;
  for (const m of moving) {
    if (m.kind !== 'axis' || !(m.radius > TINY)) continue;
    const at = m.radius * factor;
    for (const f of fixed) {
      if (f.kind !== 'axis' || !(f.radius > TINY)) continue;
      const distance = Math.abs(at - f.radius);
      if (!(distance < threshold)) continue;
      if (!best || distance < best.distance) best = { distance, from: m, to: f };
    }
  }
  if (!best) return null;

  const ease = snapEase(best.distance, threshold);
  const at = best.from.radius * factor;
  const radius = at + (best.to.radius - at) * (1 - ease.factor);
  return {
    factor: radius / best.from.radius,
    strength: ease.strength,
    locked: ease.locked,
    label: `${best.from.label} sized to ${best.to.label}`,
    radius,
  };
}

// ---------------------------------------------------------------------------
// The rotate solve
// ---------------------------------------------------------------------------

export interface AlignSolution {
  quaternion: Quat;
  strength: number;
  locked: boolean;
  label: string;
  /** The two normals, for the hint: where the face points, and where it is going. */
  from: { point: Vec3; dir: Vec3 };
  to: { point: Vec3; dir: Vec3 };
}

/** Eight degrees: a nudge you can feel, and can pull out of without a fight. */
export const ALIGN_BAND_DEG = 8;


/**
 * Turns a part the last few degrees onto a neighbour's face.
 *
 * CONFINED TO THE RING BEING DRAGGED, and that is the whole design. A solve
 * free to rotate about any axis would answer a drag on the blue ring by tipping
 * the part sideways — the handle under the pointer and the motion on screen
 * would stop agreeing, which is precisely how a gizmo comes to feel possessed.
 * So each pairing is asked a narrower question: turning about THIS axis alone,
 * how far short does it fall? A pairing that cannot be reached about this ring
 * is not offered at all, rather than being approximated by something that can.
 *
 * `moving` are the dragged body's faces in the orientation the drag has reached;
 * `axis` is the ring's direction in the same frame; `quaternion` is what the
 * drag proposes.
 */
export function solveAlignAboutAxis(input: {
  moving: FaceFeature[];
  fixed: FaceFeature[];
  axis: Vec3;
  quaternion: Quat;
  thresholdDeg?: number;
}): AlignSolution | null {
  const { moving, fixed, quaternion } = input;
  const axis = norm(input.axis);
  if (len(axis) < 0.5) return null;
  if (moving.length === 0 || fixed.length === 0) return null;

  const threshold = ((input.thresholdDeg ?? ALIGN_BAND_DEG) * Math.PI) / 180;
  if (!(threshold > 0)) return null;

  let bestAngle = Infinity;
  let bestPair: { m: FaceFeature; f: FaceFeature } | null = null;

  for (const m of moving) {
    const mn = norm(m.normal);
    if (len(mn) < 0.5) continue;
    const mAlong = dot(mn, axis);
    const mPerp = perpendicular(mn, axis);
    const mPerpLen = len(mPerp);
    // A face pointing straight down the ring's own axis cannot be turned by it.
    if (mPerpLen < TINY) continue;

    for (const f of fixed) {
      // Mating means facing each other, so the target is the OPPOSITE normal.
      const target = scale(norm(f.normal), -1);
      if (len(target) < 0.5) continue;
      const tAlong = dot(target, axis);
      const tPerp = perpendicular(target, axis);
      const tPerpLen = len(tPerp);
      if (tPerpLen < TINY) continue;

      /*
       * Turning about `axis` preserves the along-axis component and sweeps the
       * perpendicular one round a circle. So the best this ring can do leaves a
       * residual fixed by how far apart the two cones are, and if that residual
       * is itself outside the band the pairing is unreachable — offering it
       * would turn the part toward something it can never actually meet.
       */
      const cosResidual = Math.min(1, Math.max(-1, mAlong * tAlong + mPerpLen * tPerpLen));
      if (Math.acos(cosResidual) > threshold) continue;

      // The signed angle from the moving normal to the target, about the ring.
      const angle = Math.atan2(dot(cross(mPerp, tPerp), axis), dot(mPerp, tPerp));
      if (!Number.isFinite(angle)) continue;
      if (Math.abs(angle) >= threshold) continue;
      if (Math.abs(angle) < Math.abs(bestAngle)) {
        bestAngle = angle;
        bestPair = { m, f };
      }
    }
  }

  if (!bestPair || !Number.isFinite(bestAngle)) return null;

  const ease = snapEase(bestAngle, threshold);
  if (ease.strength === 0) return null;
  const nudge = bestAngle * (1 - ease.factor);
  const turned = quatMul(quatFromAxisAngle(axis, nudge), quaternion);

  return {
    quaternion: turned,
    strength: ease.strength,
    locked: ease.locked,
    label: `${bestPair.m.label} aligned to ${bestPair.f.label}`,
    from: { point: bestPair.m.point, dir: norm(bestPair.m.normal) },
    to: { point: bestPair.f.point, dir: norm(bestPair.f.normal) },
  };
}
