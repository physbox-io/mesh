/**
 * A body form's proportions from its measurements: heights of its landmarks,
 * its scale against a 1.75 m figure, and its posture. Shared by the form's
 * torso (bodyForm) and limbs (formLimbs).
 */

import type { BodyFormMeasurements } from '../../types/cloth';

/** Half-width of an ellipse of circumference c and depth over width k (Ramanujan). */
export function ellipseHalfWidth(c: number, k: number): number {
  return c / (Math.PI * (3 * (1 + k) - Math.sqrt((3 + k) * (1 + 3 * k))));
}

/**
 * The skin runs on up the neck to here (a fraction of height), where the
 * head sits: ended in a flat lid at the top of the shoulders, with the neck a
 * separate capsule through it, cloth at the neckline resting on the lid was
 * pushed off its rim and the fabric round it stretched.
 */
export const NECK_TOP = 0.875;

/**
 * How far inside the skin a leg's own surface runs above the crotch, at scale
 * s: eased with a C2 quintic curve from just below the crotch up into the hip
 * so the upper thigh transitions smoothly without a horizontal slope crease.
 */
export function legTuck(z: number, crotchZ: number, s: number): number {
  const t = Math.min(1, Math.max(0, (z - (crotchZ - 0.02 * s)) / (0.075 * s)));
  return 0.018 * s * t * t * t * (10 - 15 * t + 6 * t * t);
}

/**
 * Least gaps between the landmarks, bottom up, at a 1.75 m figure: crotch to
 * hip, hip to waist, waist to bust, bust to shoulder. Under these the torso's
 * profile keys (bodyForm torsoProfile) would cross, and the leg's root would
 * sit under the crotch. The usual proportions clear them all two to one.
 */
export const LANDMARK_GAPS = [0.04, 0.08, 0.08, 0.08] as const;
/** The crotch as a fraction of height, at most and least: past these the leg's own proportions (knee, calf, ankle) stop making sense. */
export const INSEAM_RANGE = [0.38, 0.54] as const;

/** Height of the shoulder's capsule above the shoulder line, at scale s. */
const shoulderRadius = (s: number) => 0.045 * s;

export interface FormHeights { crotchZ: number; hipZ: number; waistZ: number; bustZ: number; shoulderZ: number }

/**
 * The landmark heights, from the floor. Each one set by a measurement is
 * placed from the landmark it is measured from (inseam from the floor, rise
 * from the crotch, waist to hip and back length from the waist, shoulder to
 * bust from the top of the shoulder); each one not set is the usual fraction
 * of height for the figure. Then they are put in order, LANDMARK_GAPS apart
 * and the shoulders under the neck: an unset landmark moves out of a set
 * one's way first, and where two set ones disagree the upper gives way. With
 * nothing set, nothing moves: the form is the one the fractions give.
 */
export function resolveHeights(m: BodyFormMeasurements): FormHeights {
  const female = m.figure === 'female', H = m.height, s = H / 1.75, R = shoulderRadius(s);
  // Bottom up: crotch, hip, waist, bust, shoulder line. Unset, the usual fractions.
  const z = [0.47 * H, (female ? 0.52 : 0.51) * H, (female ? 0.625 : 0.6) * H, (female ? 0.715 : 0.72) * H, 0.817 * H];
  const set = [m.inseam !== undefined, m.waistToHip !== undefined, m.rise !== undefined, m.shoulderToBust !== undefined, m.backLength !== undefined];
  if (!set.some(Boolean)) return { crotchZ: z[0], hipZ: z[1], waistZ: z[2], bustZ: z[3], shoulderZ: z[4] };
  const gap = LANDMARK_GAPS.map((g) => g * s);
  const top = NECK_TOP * H - 0.025 * s - R;
  const span = (i: number, j: number) => { let d = 0; for (let k = i; k < j; k++) d += gap[k]; return d; };
  // Each set landmark from the one it is measured from, in that order; a
  // second and third time round, from where those were put.
  for (let pass = 0; pass < 3; pass++) {
    if (m.inseam !== undefined) z[0] = Math.min(INSEAM_RANGE[1] * H, Math.max(INSEAM_RANGE[0] * H, m.inseam));
    if (m.rise !== undefined) z[2] = z[0] + m.rise;
    if (m.waistToHip !== undefined) z[1] = z[2] - m.waistToHip;
    if (m.backLength !== undefined) z[4] = z[2] + m.backLength - R;
    if (m.shoulderToBust !== undefined) z[3] = z[4] + R - m.shoulderToBust;
    // An unset landmark moves into the room its set neighbours leave it.
    for (let i = 0; i < 5; i++) {
      if (set[i]) continue;
      let lo = -Infinity, hi = top - span(i, 4);
      for (let j = 0; j < i; j++) if (set[j]) lo = Math.max(lo, z[j] + span(j, i));
      for (let j = i + 1; j < 5; j++) if (set[j]) hi = Math.min(hi, z[j] - span(i, j));
      if (z[i] < lo) z[i] = lo;
      else if (z[i] > hi) z[i] = Math.max(lo, hi);
    }
    // Then any two set ones that still disagree: the upper gives way, and the shoulders stay under the neck.
    for (let i = 0; i < 4; i++) if (z[i + 1] < z[i] + gap[i]) z[i + 1] = z[i] + gap[i];
    if (z[4] > top) z[4] = top;
    for (let i = 3; i >= 0; i--) if (z[i] > z[i + 1] - gap[i]) z[i] = z[i + 1] - gap[i];
  }
  return { crotchZ: z[0], hipZ: z[1], waistZ: z[2], bustZ: z[3], shoulderZ: z[4] };
}

/**
 * The height measurements as the form has them: those set, after
 * resolveHeights put them in order, and those not set, as the proportions
 * give them. What the inspector shows.
 */
export function formHeightMeasurements(m: BodyFormMeasurements) {
  const z = resolveHeights(m), R = shoulderRadius(m.height / 1.75);
  return {
    inseam: z.crotchZ,
    rise: z.waistZ - z.crotchZ,
    waistToHip: z.waistZ - z.hipZ,
    backLength: z.shoulderZ + R - z.waistZ,
    shoulderToBust: z.shoulderZ + R - z.bustZ,
    /** Waist to floor down the side: the inseam and the rise, not a measurement of its own. */
    outseam: z.waistZ,
  };
}

/** Room under a foot for cloth (twice its thickness, and a little), metres. */
export const FOOT_ROOM = 0.012;

/** Posture: how far each level's centre sits toward the back (+y). A chest carried forward, the small of the back drawn in, the seat behind. */
const centres = (female: boolean) => (female ? { upper: 0, bust: -0.004, waist: 0.012, hip: 0.022, seat: 0.018 } : { upper: 0.004, bust: -0.006, waist: 0.006, hip: 0.012, seat: 0.012 });

/** A pose angle in degrees, 0 when unset (a form saved before it had one). */
const angle = (v: number | undefined) => (Number.isFinite(v) ? Number(v) : 0);

export interface LegPose {
  /** How far the hips sit below where straight legs under them would hold them. */
  drop: number;
  /** The +x leg's root in the hip and its ankle, as posed (the -x leg is the mirror). */
  top: number[];
  ankle: number[];
  /**
   * Where it turns at the hip, as posed, `hipAt` along it from the root: down
   * to there it runs as it stands, so it leaves the body as it does
   * standing; from there it swings out and forward.
   */
  hip: number[];
  hipAt: number;
  /** Its knee as posed; null with the knee locked. */
  knee: number[] | null;
  /** Its root and ankle standing straight, the hips not dropped. */
  rest: { top: number[]; ankle: number[] };
  /** Root to knee and knee to ankle, along the leg. */
  thigh: number;
  shin: number;
  /** Heights as the straight leg has them, standing: the ankle, the knee, and the knee's height from the usual one with the crotch moved. */
  footZ: number;
  kneeZ: number;
  lz: (z: number) => number;
}

/**
 * Where the +x leg runs, from its root in the hip through the knee to the
 * ankle: standing straight (the usual proportions) and as posed. The stance
 * swings the leg out at the hip, the knee bends it forward; the foot stays
 * on the floor and the thigh and shin keep their lengths, so the hips come
 * down (`drop`) and the torso with them, upright.
 */
export function legPose(m: BodyFormMeasurements): LegPose {
  const female = m.figure === 'female', H = m.height, S = H / 1.75, z = resolveHeights(m);
  const hipHalf = ellipseHalfWidth(m.hip, female ? 0.74 : 0.72);
  // The foot stands a sock's thickness clear of the floor: with its sole on
  // the floor there was no room under it, and cloth there was crushed.
  // The leg's root sits up in the hip.
  const footZ = 0.035 * S + FOOT_ROOM, topZ = z.hipZ - 0.015 * S;
  // Heights down the leg, at the usual proportions, stretched between the
  // ankle and the crotch where an inseam moves the crotch.
  const k = (z.crotchZ - footZ) / (0.47 * H - footZ);
  const lz = (h: number) => (z.crotchZ === 0.47 * H ? h : footZ + (h - footZ) * k);
  const kneeZ = lz(0.285 * H);
  const top = [hipHalf * 0.5, centres(female).hip, topZ], ankle = [hipHalf * 0.56, 0.01 * S, footZ];
  const upper = Math.hypot(ankle[0] - top[0], ankle[1] - top[1], ankle[2] - top[2]);
  const thigh = upper * (topZ - kneeZ) / (topZ - footZ), shin = upper - thigh;
  const bend = (Math.min(KNEE_MAX, Math.max(0, angle(m.kneeBend))) * Math.PI) / 180, stance = (angle(m.stance) * Math.PI) / 180;
  // The hip turns where the leg leaves the body, level with the crotch.
  const down = ankle.map((v, i) => (v - top[i]) / upper), hipAt = (topZ - z.crotchZ) / -down[2];
  const hip = top.map((v, i) => v + down[i] * hipAt);
  if (bend === 0 && stance === 0) return { drop: 0, top, ankle, hip, hipAt, knee: null, rest: { top, ankle }, thigh, shin, footZ, kneeZ, lz };
  // Hip to ankle across the bent knee; then that swung out by the stance, front view, the foot on the floor.
  const t = thigh - hipAt, D = Math.sqrt(t * t + shin * shin + 2 * t * shin * Math.cos(bend));
  const dy = ankle[1] - hip[1], R = Math.sqrt(Math.max(0, D * D - dy * dy));
  const out = Math.atan2(ankle[0] - hip[0], hip[2] - footZ) + stance;
  const posedHip = [hip[0], hip[1], footZ + Math.cos(out) * R], posedAnkle = [hip[0] + Math.sin(out) * R, ankle[1], footZ];
  const drop = hip[2] - posedHip[2];
  let knee: number[] | null = null;
  if (bend > 0) {
    // The knee forward of the line hip to ankle, the thigh and shin their lengths.
    const u = posedAnkle.map((v, i) => (v - posedHip[i]) / D);
    // Forward (-y), square to that line.
    const f = [u[0] * u[1], u[1] * u[1] - 1, u[2] * u[1]];
    const fl = Math.hypot(f[0], f[1], f[2]) || 1;
    const along = (t * t - shin * shin + D * D) / (2 * D), h = Math.sqrt(Math.max(0, t * t - along * along));
    knee = posedHip.map((v, i) => v + u[i] * along + (f[i] / fl) * h);
  }
  return { drop, top: [top[0], top[1], topZ - drop], ankle: posedAnkle, hip: posedHip, hipAt, knee, rest: { top, ankle }, thigh, shin, footZ, kneeZ, lz };
}

/** The deepest the knee bends, degrees: a crouch, the thighs near level. */
export const KNEE_MAX = 110;

export function proportions(m: BodyFormMeasurements) {
  const female = m.figure === 'female';
  const s = m.height / 1.75;
  const z = resolveHeights(m);
  // Bent knees and a wide stance bring the hips down, and everything above them.
  const drop = legPose(m).drop;
  return {
    s,
    drop,
    shoulderZ: z.shoulderZ - drop,
    shoulderDrop: (female ? 0.066 : 0.058) * s,
    shoulderR: shoulderRadius(s),
    bustZ: z.bustZ - drop,
    waistZ: z.waistZ - drop,
    hipZ: z.hipZ - drop,
    crotchZ: z.crotchZ - drop,
    /** Where the skin ends up the neck, and the crown of the head. */
    neckTop: NECK_TOP * m.height - drop,
    crown: m.height - drop,
    bustSpan: m.bustSpan ?? 0.19 * s,
    centre: centres(female),
  };
}
