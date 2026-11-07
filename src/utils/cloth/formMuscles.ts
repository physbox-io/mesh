/**
 * The muscles and bony landmarks on a form: how far the surface stands off
 * or sinks from the smooth shape the tapes give, at a point on it. Each is
 * small, a centimetre or so, on a limb or the torso's own contour, so a
 * garment drawn off the form follows them only as cloth would.
 *
 * Metres at a 1.75 m figure; callers scale by S. +x the wearer's left, front
 * toward -y, Z-up. A female form carries the same bones and a softer cover.
 */

import type { BodyFigure } from '../../types/cloth';

/** A bump at c, width w either way (asymmetric if `wUp` is given). */
const bump = (x: number, c: number, w: number, wUp = w) => { const t = (x - c) / (x > c ? wUp : w); return Math.exp(-t * t); };
/** Facing `d` of a unit direction, sharpened: 1 straight at it, falling to 0 a quarter turn off. */
const facing = (dot: number, sharp: number) => Math.max(0, dot) ** sharp;
const cover = (figure: BodyFigure) => (figure === 'female' ? 0.45 : 1);

export interface TorsoMarks { bustZ: number; shoulderZ: number; waistZ: number; hipZ: number; crotchZ: number }

/** Over the torso: x across and z at scale S, `front` 1 on the front falling to 0 at the sides, `back` the same behind. */
export function torsoRelief(figure: BodyFigure, x: number, z: number, front: number, back: number, L: TorsoMarks): number {
  const M = cover(figure), ax = Math.abs(x);
  const dBust = z - L.bustZ, dWaist = z - L.waistZ, dHip = z - L.hipZ;
  let r = 0;
  if (front > 0) {
    let f = 0;
    if (figure === 'male') {
      // Each pectoral, its lower edge the sharper; the breastbone between.
      f += 0.02 * bump(ax, 0.08, 0.06, 0.07) * bump(dBust, 0.045, 0.024, 0.06);
      f -= 0.0045 * bump(ax, 0, 0.014) * bump(dBust, 0.04, 0.05, 0.05);
      // The abdominals: down the middle, along each side, and the bands across.
      const abs = bump(dWaist, 0.0, 0.11, 0.105) * bump(ax, 0.04, 0.05, 0.045);
      f += 0.008 * abs;
      f -= 0.0032 * bump(ax, 0, 0.011) * bump(dWaist, 0.0, 0.13, 0.11);
      f -= 0.0022 * abs * (bump(dWaist, 0.075, 0.014) + bump(dWaist, 0.02, 0.014) + bump(dWaist, -0.04, 0.016));
    } else {
      f -= 0.0015 * bump(ax, 0, 0.016) * bump(dWaist, 0.04, 0.12);
    }
    // The collarbones, from the notch of the throat out along the shoulder.
    f += 0.0028 * M * bump(ax, 0.09, 0.075) * bump(z - (L.shoulderZ - 0.012 - 0.1 * Math.max(0, 0.09 - ax) * 0.2), 0, 0.012);
    r += f * front;
  }
  if (back > 0) {
    let b = 0;
    // The spine in its channel, the long muscles either side of it, the shoulder blades and the lats.
    b -= 0.0045 * (M * 0.5 + 0.5) * bump(ax, 0, 0.012) * bump(dWaist, 0.03, 0.14, 0.2);
    b += 0.0045 * M * bump(ax, 0.034, 0.019) * bump(dWaist, -0.01, 0.1, 0.1);
    b += 0.0075 * (M * 0.6 + 0.4) * bump(ax, 0.085, 0.05) * bump(dBust, 0.075, 0.075, 0.055);
    b += 0.005 * M * bump(ax, 0.135, 0.04) * bump(dBust, -0.02, 0.08);
    // The seat, in two, and the cleft between.
    b += 0.009 * (M * 0.4 + 0.6) * bump(ax, 0.082, 0.06, 0.075) * bump(dHip, -0.018, 0.05, 0.075);
    b -= 0.0085 * bump(ax, 0, 0.013) * bump(dHip, -0.06, 0.09, 0.06);
    r += b * back;
  }
  return r;
}

/**
 * Over an arm. `u` runs shoulder to wrist; `elbow` is where the joint falls on
 * that. `fwd` is how much the point faces the inside of the elbow, `out` how
 * much it faces away from the body (1, 0 straight at each).
 */
export function armRelief(figure: BodyFigure, u: number, elbow: number, fwd: number, out: number): number {
  const M = cover(figure), ue = u / elbow, uf = (u - elbow) / (1 - elbow);
  let r = 0;
  // Deltoid, wrapped round the shoulder's outside.
  r += 0.0125 * (M * 0.5 + 0.5) * bump(ue, 0.3, 0.2, 0.26) * (0.35 + 0.65 * facing(out + 0.35, 1.2));
  r += 0.0095 * M * bump(ue, 0.62, 0.22, 0.27) * facing(fwd, 1.6); // biceps
  r += 0.0085 * M * bump(ue, 0.55, 0.3) * facing(-fwd * 0.9 + out * 0.3, 1.6); // triceps
  r -= 0.0024 * M * bump(ue, 0.66, 0.24) * facing(out * 0.95 + fwd * 0.2, 7); // the groove between them
  // The point of the elbow, and the crease inside it.
  r += 0.0055 * bump(u, elbow, 0.04) * facing(-fwd, 3);
  r -= 0.0035 * bump(u, elbow, 0.035) * facing(fwd, 2);
  // The forearm's two masses, off the elbow.
  r += 0.0085 * (M * 0.5 + 0.5) * bump(uf, 0.22, 0.14, 0.26) * facing(out * 0.8 + fwd * 0.6, 2);
  r += 0.0055 * (M * 0.5 + 0.5) * bump(uf, 0.25, 0.14, 0.3) * facing(-out * 0.8 + fwd * 0.5, 2);
  return r;
}

/**
 * Over a leg. `t` is height above the middle of the knee, at scale S; `kneeRel`
 * the same for callers fading it. `fwd` is how much the point faces front,
 * `out` away from the other leg.
 */
export function legRelief(figure: BodyFigure, t: number, fwd: number, out: number): number {
  const M = cover(figure), B = figure === 'female' ? 0.85 : 1;
  let r = 0;
  // The kneecap, the hollows either side of it and behind it, and the tendon below it to the top of the shin.
  r += 0.0075 * B * bump(t, 0.003, 0.024, 0.03) * facing(fwd, 3.5);
  r += 0.0022 * B * bump(t, -0.052, 0.018, 0.02) * facing(fwd, 7);
  r -= 0.0042 * B * bump(t, -0.018, 0.03) * facing(Math.abs(fwd) * 0.75 + Math.abs(out) * 0.65, 14) * (fwd > 0 ? 1 : 0);
  r -= 0.0052 * bump(t, 0.0, 0.03) * facing(-fwd, 2);
  // Above it: the dip over the kneecap, the teardrop inside, the thigh's muscles.
  r -= 0.0034 * bump(t, 0.058, 0.022) * facing(fwd, 2.5);
  r += 0.0095 * (M * 0.6 + 0.4) * bump(t, 0.085, 0.04, 0.06) * facing(fwd * 0.72 - out * 0.7, 2.5);
  r += 0.0065 * (M * 0.6 + 0.4) * bump(t, 0.15, 0.08, 0.1) * facing(fwd * 0.72 + out * 0.7, 2.5);
  r += 0.0065 * M * bump(t, 0.2, 0.09, 0.1) * facing(fwd, 2);
  r += 0.006 * (M * 0.6 + 0.4) * bump(t, 0.18, 0.1, 0.1) * facing(-fwd, 1.8);
  // The calf's two heads, the inner the lower; the flat of the shin.
  r += 0.0115 * (M * 0.5 + 0.5) * bump(t, -0.125, 0.05, 0.065) * facing(-fwd * 0.75 - out * 0.68, 2);
  r += 0.009 * (M * 0.5 + 0.5) * bump(t, -0.105, 0.045, 0.06) * facing(-fwd * 0.75 + out * 0.68, 2);
  r -= 0.0018 * bump(t, -0.22, 0.09) * facing(fwd, 1.5);
  return r;
}
