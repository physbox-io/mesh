/**
 * A form's head and neck as one solid: rounded masses (skull, face, jaw,
 * chin, nose, lips, ears) blended into each other, the eye sockets and the
 * line of the mouth pressed into them. Worked out as a field so that the
 * masses can be drawn from anatomy and each height still reads as one closed
 * contour round the head's axis, which is what a limb is lofted through.
 *
 * Sizes are for a 1.75 m figure with the crown at z = 0, front toward -y,
 * +x the wearer's left, measured from the head's axis.
 */

import type { BodyFigure } from '../../types/cloth';

type V = [number, number, number];

/** Where the neck's axis is, front to back, in the form's frame at height z: the skin's neck follows the head's. */
export function neckAxisY(z: number, height: number, s: number): number {
  return (-0.012 + (0.02 * ((z - height) / s + 0.33)) / 0.18) * s;
}

const smin = (a: number, b: number, k: number) => {
  const h = Math.max(0, k - Math.abs(a - b)) / k;
  return Math.min(a, b) - (h * h * k) / 4;
};
const smax = (a: number, b: number, k: number) => -smin(-a, -b, k);

function ellipsoid(x: number, y: number, z: number, c: V, r: V): number {
  const px = x - c[0], py = y - c[1], pz = z - c[2];
  const k0 = Math.sqrt((px / r[0]) ** 2 + (py / r[1]) ** 2 + (pz / r[2]) ** 2);
  const k1 = Math.sqrt((px / (r[0] * r[0])) ** 2 + (py / (r[1] * r[1])) ** 2 + (pz / (r[2] * r[2])) ** 2);
  return k1 < 1e-9 ? -Math.min(...r) : (k0 * (k0 - 1)) / k1;
}

/** A tapered capsule, radius ra at a to rb at b. */
function cone(x: number, y: number, z: number, a: V, b: V, ra: number, rb: number): number {
  const ba = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], pa = [x - a[0], y - a[1], z - a[2]];
  const t = Math.min(1, Math.max(0, (pa[0] * ba[0] + pa[1] * ba[1] + pa[2] * ba[2]) / (ba[0] * ba[0] + ba[1] * ba[1] + ba[2] * ba[2])));
  return Math.hypot(pa[0] - ba[0] * t, pa[1] - ba[1] * t, pa[2] - ba[2] * t) - (ra + (rb - ra) * t);
}

/** Signed distance (about) to the head, negative inside. `neckR` is the neck's radius at this scale. */
export function headField(figure: BodyFigure, neckR: number): (x: number, y: number, z: number) => number {
  const f = figure === 'female';
  const jawW = f ? 0.053 : 0.06, jawZ = f ? -0.183 : -0.186, chinR = f ? 0.019 : 0.023;
  const nose = f ? 0.86 : 1, lip = f ? 1.1 : 1;
  return (x, y, z) => {
    const ax = Math.abs(x); // the two sides mirror
    let d = ellipsoid(x, y, z, [0, 0.012, -0.096], [f ? 0.074 : 0.077, f ? 0.095 : 0.098, 0.096]);
    d = smin(d, ellipsoid(x, y, z, [0, -0.024, -0.15], [f ? 0.066 : 0.069, 0.066, 0.086]), 0.03);
    d = smin(d, ellipsoid(x, y, z, [0, -0.032, jawZ], [jawW, 0.06, 0.04]), 0.03);
    d = smin(d, ellipsoid(x, y, z, [0, -0.076, -0.214], [chinR * 1.2, chinR, chinR * 0.8]), 0.024);
    // No ridge for the brow: the sockets leave one. The closed eye in each.
    d = smax(d, -ellipsoid(ax, y, z, [0.031, -0.0965, -0.119], [0.0165, 0.0105, 0.0085]), 0.013);
    d = smin(d, ellipsoid(ax, y, z, [0.031, -0.0715, -0.119], [0.0125, 0.0135, 0.0072]), 0.007);
    // The nose: its bridge running down to a ball of a tip, with a wing either side.
    d = smin(d, cone(x, y, z, [0, -0.086, -0.11], [0, -(0.09 + 0.0115 * nose), -0.149], 0.0068 * nose, 0.0088 * nose), 0.013);
    d = smin(d, ellipsoid(x, y, z, [0, -(0.09 + 0.0125 * nose), -0.1525], [0.0115 * nose, 0.0118 * nose, 0.0102 * nose]), 0.008);
    d = smin(d, ellipsoid(ax, y, z, [0.0125 * nose, -(0.09 + 0.0025 * nose), -0.1565], [0.0085, 0.0105, 0.0072]), 0.009);
    // The lips and the line between them.
    d = smin(d, ellipsoid(x, y, z, [0, -0.088, -0.1775], [0.0235, 0.0105, 0.0062 * lip]), 0.01);
    d = smin(d, ellipsoid(x, y, z, [0, -0.0865, -0.1885], [0.0205, 0.0105, 0.0068 * lip]), 0.01);
    d = smax(d, -ellipsoid(x, y, z, [0, -0.1035, -0.1827], [0.0255, 0.0095, 0.0011]), 0.004);
    // An ear, level between the brow and the base of the nose.
    d = smin(d, ellipsoid(ax, y, z, [0.0765, 0.012, -0.124], [0.0058, 0.0165, 0.029]), 0.016);
    // The neck, into the base of the skull behind the jaw.
    return smin(d, cone(x, y, z, [0, 0, -0.33], [0, 0.02, -0.15], neckR * 0.92, neckR), 0.024); // the axis is neckAxisY's
  };
}

/** The outermost surface along one ray. Fixed steps: the field is only about a distance, and steps sized by it jumped thin features, leaving spikes. */
function rayHit(field: (x: number, y: number, z: number) => number, z: number, ca: number, sa: number): number {
  for (let r = 0.15; r > 0; r -= 0.0015) {
    if (field(r * ca, r * sa, z) >= 0) continue;
    let lo = r, hi = r + 0.0015;
    for (let i = 0; i < 6; i++) { const mid = (lo + hi) / 2; if (field(mid * ca, mid * sa, z) < 0) lo = mid; else hi = mid; }
    return lo;
  }
  return 0.002;
}

/**
 * How far out from the axis the head's surface lies at height z, at angle a
 * (0 = +x, pi/2 = back), a little evened round the ring so the steep side of
 * a nose or an ear is a slope between the mesh's points rather than a cliff.
 */
export function headRadius(field: (x: number, y: number, z: number) => number, z: number, a: number): number {
  const d = 0.035, at = (t: number) => rayHit(field, z, Math.cos(t), Math.sin(t));
  return Math.max(0.002, (at(a - d) + 2 * at(a) + at(a + d)) / 4);
}
