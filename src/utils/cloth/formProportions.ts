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
 * s: there the skin is the leg (bodyForm, blendLimbRoots), and the two would
 * otherwise lie on each other.
 */
export function legTuck(z: number, crotchZ: number, s: number): number {
  const t = Math.min(1, Math.max(0, (z - crotchZ) / (0.05 * s)));
  return 0.022 * s * t * t * (3 - 2 * t);
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

export function proportions(m: BodyFormMeasurements) {
  const female = m.figure === 'female';
  const s = m.height / 1.75;
  const z = resolveHeights(m);
  return {
    s,
    shoulderZ: z.shoulderZ,
    shoulderDrop: (female ? 0.066 : 0.058) * s,
    shoulderR: shoulderRadius(s),
    bustZ: z.bustZ,
    waistZ: z.waistZ,
    hipZ: z.hipZ,
    crotchZ: z.crotchZ,
    bustSpan: m.bustSpan ?? 0.19 * s,
    // Posture: how far each level's centre sits toward the back (+y). A
    // chest carried forward, the small of the back drawn in, the seat behind.
    centre: female ? { upper: 0, bust: -0.004, waist: 0.012, hip: 0.022, seat: 0.018 } : { upper: 0.004, bust: -0.006, waist: 0.006, hip: 0.012, seat: 0.012 },
  };
}
