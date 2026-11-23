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

/** Where the neck's axis is, front to back, in the form's frame at height z: the skin's neck follows the head's. */
export function neckAxisY(z: number, height: number, s: number): number {
  return (-0.012 + (0.02 * ((z - height) / s + 0.33)) / 0.18) * s;
}

const smin = (a: number, b: number, k: number) => {
  const h = Math.max(0, k - Math.abs(a - b)) / k;
  return Math.min(a, b) - (h * h * k) / 4;
};
const smax = (a: number, b: number, k: number) => -smin(-a, -b, k);

/** Zero-allocation scalar ellipsoid SDF (Inigo Quilez bound). */
function ellipsoidS(
  x: number, y: number, z: number,
  cx: number, cy: number, cz: number,
  invRx: number, invRy: number, invRz: number,
  invRx2: number, invRy2: number, invRz2: number,
  negMinR: number,
): number {
  const px = x - cx, py = y - cy, pz = z - cz;
  const ux = px * invRx, uy = py * invRy, uz = pz * invRz;
  const k0 = Math.sqrt(ux * ux + uy * uy + uz * uz);
  const gx = px * invRx2, gy = py * invRy2, gz = pz * invRz2;
  const k1 = Math.sqrt(gx * gx + gy * gy + gz * gz);
  return k1 < 1e-9 ? negMinR : (k0 * (k0 - 1)) / k1;
}

/** Zero-allocation scalar tapered capsule SDF (precomputed ba & invBa2). */
function coneS(
  x: number, y: number, z: number,
  ax: number, ay: number, az: number,
  bax: number, bay: number, baz: number,
  invBa2: number, ra: number, dr: number,
): number {
  const pax = x - ax, pay = y - ay, paz = z - az;
  let t = (pax * bax + pay * bay + paz * baz) * invBa2;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const dx = pax - bax * t, dy = pay - bay * t, dz = paz - baz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - (ra + dr * t);
}

type HeadFieldFn = (x: number, y: number, z: number) => number;
const fieldCache = new Map<string, HeadFieldFn>();

/** Signed distance (about) to the head, negative inside. `neckR` is the neck's radius at this scale. */
export function headField(figure: BodyFigure, neckR: number): HeadFieldFn {
  const key = `${figure}:${neckR.toFixed(6)}`;
  const cached = fieldCache.get(key);
  if (cached) return cached;
  const f = figure === 'female';
  const jawW = f ? 0.053 : 0.06, jawZ = f ? -0.183 : -0.186, chinR = f ? 0.0185 : 0.022;
  const nose = f ? 0.88 : 1, lip = f ? 1.08 : 1;

  // Precompute reciprocals for all static ellipsoids & cones once per (figure, neckR).
  const e0rx = f ? 0.074 : 0.077, e0ry = f ? 0.095 : 0.098, e0rz = 0.096;
  const e0ix = 1 / e0rx, e0iy = 1 / e0ry, e0iz = 1 / e0rz;
  const e0ix2 = e0ix * e0ix, e0iy2 = e0iy * e0iy, e0iz2 = e0iz * e0iz, e0mr = -Math.min(e0rx, e0ry, e0rz);

  const e1rx = f ? 0.066 : 0.069, e1ry = 0.066, e1rz = 0.086;
  const e1ix = 1 / e1rx, e1iy = 1 / e1ry, e1iz = 1 / e1rz;
  const e1ix2 = e1ix * e1ix, e1iy2 = e1iy * e1iy, e1iz2 = e1iz * e1iz, e1mr = -Math.min(e1rx, e1ry, e1rz);

  const e2rx = jawW, e2ry = 0.06, e2rz = 0.04;
  const e2ix = 1 / e2rx, e2iy = 1 / e2ry, e2iz = 1 / e2rz;
  const e2ix2 = e2ix * e2ix, e2iy2 = e2iy * e2iy, e2iz2 = e2iz * e2iz, e2mr = -Math.min(e2rx, e2ry, e2rz);

  const e3rx = chinR * 1.15, e3ry = chinR * 0.95, e3rz = chinR * 0.82;
  const e3ix = 1 / e3rx, e3iy = 1 / e3ry, e3iz = 1 / e3rz;
  const e3ix2 = e3ix * e3ix, e3iy2 = e3iy * e3iy, e3iz2 = e3iz * e3iz, e3mr = -Math.min(e3rx, e3ry, e3rz);

  const e4ix = 1 / 0.015, e4iy = 1 / 0.0074, e4iz = 1 / 0.0086;
  const e4ix2 = e4ix * e4ix, e4iy2 = e4iy * e4iy, e4iz2 = e4iz * e4iz, e4mr = -0.0074;

  const e5ix = 1 / 0.0152, e5iy = 1 / 0.0086, e5iz = 1 / 0.0080;
  const e5ix2 = e5ix * e5ix, e5iy2 = e5iy * e5iy, e5iz2 = e5iz * e5iz, e5mr = -0.0080;

  const e6ix = 1 / 0.0132, e6iy = 1 / 0.0102, e6iz = 1 / 0.0066;
  const e6ix2 = e6ix * e6ix, e6iy2 = e6iy * e6iy, e6iz2 = e6iz * e6iz, e6mr = -0.0066;

  const e7cx = 0.0086 * nose;
  const e7ix = 1 / 0.0044, e7iy = 1 / 0.0049, e7iz = 1 / 0.0047;
  const e7ix2 = e7ix * e7ix, e7iy2 = e7iy * e7iy, e7iz2 = e7iz * e7iz, e7mr = -0.0044;

  const e8rz = 0.0066 * lip;
  const e8ix = 1 / 0.0215, e8iy = 1 / 0.0088, e8iz = 1 / e8rz;
  const e8ix2 = e8ix * e8ix, e8iy2 = e8iy * e8iy, e8iz2 = e8iz * e8iz, e8mr = -Math.min(0.0215, 0.0088, e8rz);

  const e9rz = 0.0068 * lip;
  const e9ix = 1 / 0.019, e9iy = 1 / 0.0088, e9iz = 1 / e9rz;
  const e9ix2 = e9ix * e9ix, e9iy2 = e9iy * e9iy, e9iz2 = e9iz * e9iz, e9mr = -Math.min(0.019, 0.0088, e9rz);

  const e10ix = 1 / 0.0205, e10iy = 1 / 0.0044, e10iz = 1 / 0.0044;
  const e10ix2 = e10ix * e10ix, e10iy2 = e10iy * e10iy, e10iz2 = e10iz * e10iz, e10mr = -0.0044;

  const e11ix = 1 / 0.018, e11iy = 1 / 0.0040, e11iz = 1 / 0.0068;
  const e11ix2 = e11ix * e11ix, e11iy2 = e11iy * e11iy, e11iz2 = e11iz * e11iz, e11mr = -0.0040;

  const e12cx = f ? 0.0725 : 0.075;
  const e12ix = 1 / 0.0048, e12iy = 1 / 0.015, e12iz = 1 / 0.025;
  const e12ix2 = e12ix * e12ix, e12iy2 = e12iy * e12iy, e12iz2 = e12iz * e12iz, e12mr = -0.0048;

  // Nose cones & neck cone precomputed vectors
  const c0ay = -0.0835, c0az = -0.1185, c0bay = -(0.0920 + 0.0040 * nose) - c0ay, c0baz = -0.149 - c0az;
  const c0inv = 1 / (c0bay * c0bay + c0baz * c0baz), c0ra = 0.0042 * nose, c0dr = 0.0062 * nose - c0ra;

  const c1ay = -(0.0914 + 0.0035 * nose), c1az = -0.1495, c1bay = -0.0880 - c1ay, c1baz = -0.1645 - c1az;
  const c1inv = 1 / (c1bay * c1bay + c1baz * c1baz), c1ra = 0.0053 * nose, c1dr = 0.0060 - c1ra;

  const c2ay = 0, c2az = -0.33, c2bay = 0.02, c2baz = 0.18;
  const c2inv = 1 / (c2bay * c2bay + c2baz * c2baz), c2ra = neckR * 0.92, c2dr = neckR - c2ra;

  const browZ0 = f ? -0.1080 : -0.1092, browZA = f ? 0.0022 : 0.0014, browZU = f ? 0.0032 : 0.0022;
  const browY0 = f ? -0.0884 : -0.0902, browR0 = f ? 0.0026 : 0.0031;

  const fn: HeadFieldFn = (x, y, z) => {
    const ax = x < 0 ? -x : x; // the two sides mirror
    // Cranial vault, temples & back of skull kept identical so fitted hats & baseball caps keep exact fit.
    let d = ellipsoidS(x, y, z, 0, 0.012, -0.096, e0ix, e0iy, e0iz, e0ix2, e0iy2, e0iz2, e0mr);
    d = smin(d, ellipsoidS(x, y, z, 0, -0.024, -0.15, e1ix, e1iy, e1iz, e1ix2, e1iy2, e1iz2, e1mr), 0.03);
    d = smin(d, ellipsoidS(x, y, z, 0, -0.032, jawZ, e2ix, e2iy, e2iz, e2ix2, e2iy2, e2iz2, e2mr), 0.03);
    d = smin(d, ellipsoidS(x, y, z, 0, -0.075, -0.212, e3ix, e3iy, e3iz, e3ix2, e3iy2, e3iz2, e3mr), 0.024);
    // Serene supraorbital brow arches: calm poised medial head rising gently to the lateral-iris arch peak
    // and tapering past the outer canthus, standing subtly proud of the recessed orbital hollow & eyelids.
    if (ax > 0.0115 && ax < 0.0495) {
      const bx = ax < 0.014 ? 0.014 : ax > 0.0475 ? 0.0475 : ax;
      const u = (bx - 0.014) / 0.0335;
      const arch = Math.sin(Math.PI * Math.sqrt(u * Math.sqrt(u)));
      const zBrow = browZ0 + browZA * arch - browZU * u * u;
      const brRatio = bx / 0.031;
      const yBrow = browY0 + 0.0068 * brRatio * brRatio;
      const envT = (ax - 0.0115) / 0.038;
      const env = Math.sin(Math.PI * (envT > 1 ? 1 : envT));
      const rBrow = browR0 * (0.62 + 0.38 * arch) * env;
      if (rBrow > 1e-5) {
        const dz = z - zBrow;
        const zScale = dz > 0 ? 0.84 : 1.15;
        const dxB = (ax - bx) * 0.88, dyB = (y - yBrow) * 0.95, dzB = dz * zScale;
        const dBrow = Math.sqrt(dxB * dxB + dyB * dyB + dzB * dzB) - rBrow;
        d = smin(d, dBrow, 0.0085);
      }
    }
    // Nasion indentation (root of nose steps cleanly inward beneath the glabella — zero top-of-nose bulge).
    d = smax(d, -ellipsoidS(x, y, z, 0, -0.0972, -0.1185, e4ix, e4iy, e4iz, e4ix2, e4iy2, e4iz2, e4mr), 0.012);
    // Recessed orbital hollows beneath the brow arches & calm almond-shaped closed eyelids tucked behind brow.
    d = smax(d, -ellipsoidS(ax, y, z, 0.0285, -0.0932, -0.1205, e5ix, e5iy, e5iz, e5ix2, e5iy2, e5iz2, e5mr), 0.0125);
    d = smin(d, ellipsoidS(ax, y, z, 0.0285, -0.0754, -0.1215, e6ix, e6iy, e6iz, e6ix2, e6iy2, e6iz2, e6mr), 0.0105);
    // Slender pyramidal nose: narrow dorsal bridge & soft-domed compact tip flaring smoothly backward along
    // the nasal sidewalls to the maxilla, composed as one solid so blends never inflate the tip into a bulb.
    const yRel = y + 0.1015;
    const yBack = 0.5 * (yRel + Math.sqrt(yRel * yRel + 2.5e-5));
    const nx = (x * 0.88) / (1 + 13.5 * yBack);
    let dNose = coneS(nx, y, z, 0, c0ay, c0az, 0, c0bay, c0baz, c0inv, c0ra, c0dr);
    dNose = smin(dNose, coneS(nx, y, z, 0, c1ay, c1az, 0, c1bay, c1baz, c1inv, c1ra, c1dr), 0.0075);
    dNose = smin(dNose, ellipsoidS(ax, y, z, e7cx, -0.0920, -0.153, e7ix, e7iy, e7iz, e7ix2, e7iy2, e7iz2, e7mr), 0.0050);
    d = smin(d, dNose, 0.0098);
    // Understated sculptural lips with a gentle labial parting contour and mentolabial hollow.
    d = smin(d, ellipsoidS(x, y, z, 0, -0.0875, -0.1755, e8ix, e8iy, e8iz, e8ix2, e8iy2, e8iz2, e8mr), 0.0135);
    d = smin(d, ellipsoidS(x, y, z, 0, -0.086, -0.1875, e9ix, e9iy, e9iz, e9ix2, e9iy2, e9iz2, e9mr), 0.0135);
    d = smax(d, -ellipsoidS(x, y, z, 0, -0.0985, -0.1815, e10ix, e10iy, e10iz, e10ix2, e10iy2, e10iz2, e10mr), 0.0125);
    d = smax(d, -ellipsoidS(x, y, z, 0, -0.094, -0.1975, e11ix, e11iy, e11iz, e11ix2, e11iy2, e11iz2, e11mr), 0.015);
    // Clean studio ear plane, level between brow and nasal base (flush enough not to snag hats or crease >30°).
    d = smin(d, ellipsoidS(ax, y, z, e12cx, 0.012, -0.132, e12ix, e12iy, e12iz, e12ix2, e12iy2, e12iz2, e12mr), 0.018);
    // The neck, into the base of the skull behind the jaw.
    return smin(d, coneS(x, y, z, 0, c2ay, c2az, 0, c2bay, c2baz, c2inv, c2ra, c2dr), 0.024); // the axis is neckAxisY's
  };
  if (fieldCache.size >= 32) fieldCache.delete(fieldCache.keys().next().value as string);
  fieldCache.set(key, fn);
  return fn;
}

/**
 * The outermost surface along one ray. Uses conservative coarse stepping far from
 * the surface (landing on exact 0.001 m grid steps) and exact 0.001 m stepping
 * within 15 mm of the surface so thin features are never jumped.
 */
function rayHit(field: HeadFieldFn, z: number, ca: number, sa: number): number {
  for (let r = 0.15; r > 0;) {
    const d = field(r * ca, r * sa, z);
    if (d < 0) {
      let lo = r, hi = r + 0.001;
      for (let i = 0; i < 6; i++) { const mid = 0.5 * (lo + hi); if (field(mid * ca, mid * sa, z) < 0) lo = mid; else hi = mid; }
      return lo;
    }
    if (d > 0.015) {
      const steps = Math.min(12, Math.floor(d * 400));
      r -= steps > 1 ? steps * 0.001 : 0.001;
    } else {
      r -= 0.001;
    }
  }
  return 0.002;
}

const rayCache = new WeakMap<HeadFieldFn, Map<number, number>>();

function cachedRay(field: HeadFieldFn, z: number, a: number): number {
  let map = rayCache.get(field);
  if (!map) { map = new Map(); rayCache.set(field, map); }
  const tau = 2 * Math.PI;
  let an = ((a % tau) + tau) % tau;
  // headField is strictly even in x: fold (PI/2, 3*PI/2) across the y-axis onto [-PI/2, PI/2] equivalent in [0, 2*PI).
  if (an > Math.PI * 0.5 && an < Math.PI * 1.5) {
    an = an <= Math.PI ? Math.PI - an : 3 * Math.PI - an;
  }
  const key = Math.round(z * 1e6) * 8000000 + Math.round(an * 1e6);
  let hit = map.get(key);
  if (hit === undefined) {
    hit = rayHit(field, z, Math.cos(an), Math.sin(an));
    map.set(key, hit);
  }
  return hit;
}

/**
 * How far out from the axis the head's surface lies at height z, at angle a
 * (0 = +x, pi/2 = back): exact 3-tap skull contour above `z = -0.098` so hats
 * & caps keep their exact crown fit, and a gentle 2D `(a, z)` kernel across
 * the face so brow arches, lids, nose and lips stay crisp without >=30° steps.
 */
export function headRadius(field: (x: number, y: number, z: number) => number, z: number, a: number): number {
  const fz = Math.min(1, Math.max(0, (-0.094 - z) / 0.010)) * Math.min(1, Math.max(0, (z + 0.225) / 0.014));
  const fa = Math.min(1, Math.max(0, (-Math.sin(a) - 0.30) / 0.30));
  const wFace = fz * fa;
  if (wFace <= 1e-4) {
    const d = 0.035;
    return Math.max(0.002, (cachedRay(field, z, a - d) + 2 * cachedRay(field, z, a) + cachedRay(field, z, a + d)) / 4);
  }
  const da = 0.027;
  const row5 = (zq: number) => (
    cachedRay(field, zq, a - 2 * da) +
    4 * cachedRay(field, zq, a - da) +
    6 * cachedRay(field, zq, a) +
    4 * cachedRay(field, zq, a + da) +
    cachedRay(field, zq, a + 2 * da)
  ) / 16;
  const dz = 0.0030 * wFace;
  const faceVal = (row5(z - dz) + 2 * row5(z) + row5(z + dz)) / 4;
  if (wFace >= 0.9999) return Math.max(0.002, faceVal);
  const d0 = 0.035;
  const baseVal = (cachedRay(field, z, a - d0) + 2 * cachedRay(field, z, a) + cachedRay(field, z, a + d0)) / 4;
  return Math.max(0.002, baseVal + (faceVal - baseVal) * wFace);
}
