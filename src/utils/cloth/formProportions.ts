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

export function proportions(m: BodyFormMeasurements) {
  const female = m.figure === 'female';
  const s = m.height / 1.75;
  return {
    s,
    shoulderZ: 0.817 * m.height,
    shoulderDrop: (female ? 0.066 : 0.058) * s,
    shoulderR: 0.045 * s,
    bustZ: (female ? 0.715 : 0.72) * m.height,
    waistZ: (female ? 0.625 : 0.6) * m.height,
    hipZ: (female ? 0.52 : 0.51) * m.height,
    crotchZ: 0.47 * m.height,
    bustSpan: 0.19 * s,
    // Posture: how far each level's centre sits toward the back (+y). A
    // chest carried forward, the small of the back drawn in, the seat behind.
    centre: female ? { upper: 0, bust: -0.004, waist: 0.012, hip: 0.022, seat: 0.018 } : { upper: 0.004, bust: -0.006, waist: 0.006, hip: 0.012, seat: 0.012 },
  };
}
