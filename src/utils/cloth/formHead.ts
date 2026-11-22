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
  const jawW = f ? 0.053 : 0.06, jawZ = f ? -0.183 : -0.186, chinR = f ? 0.0185 : 0.022;
  const nose = f ? 0.88 : 1, lip = f ? 1.08 : 1;
  return (x, y, z) => {
    const ax = Math.abs(x); // the two sides mirror
    // Cranial vault, temples & back of skull kept identical so fitted hats & baseball caps keep exact fit.
    let d = ellipsoid(x, y, z, [0, 0.012, -0.096], [f ? 0.074 : 0.077, f ? 0.095 : 0.098, 0.096]);
    d = smin(d, ellipsoid(x, y, z, [0, -0.024, -0.15], [f ? 0.066 : 0.069, 0.066, 0.086]), 0.03);
    d = smin(d, ellipsoid(x, y, z, [0, -0.032, jawZ], [jawW, 0.06, 0.04]), 0.03);
    d = smin(d, ellipsoid(x, y, z, [0, -0.075, -0.212], [chinR * 1.15, chinR * 0.95, chinR * 0.82]), 0.024);
    // Serene supraorbital brow arches: calm poised medial head rising gently to the lateral-iris arch peak
    // and tapering past the outer canthus, standing subtly proud of the recessed orbital hollow & eyelids.
    {
      const bx = Math.min(0.0475, Math.max(0.014, ax));
      const u = (bx - 0.014) / 0.0335;
      const arch = Math.sin(Math.PI * Math.pow(u, 0.75));
      const zBrow = (f ? -0.1080 : -0.1092) + (f ? 0.0022 : 0.0014) * arch - (f ? 0.0032 : 0.0022) * u * u;
      const yBrow = (f ? -0.0884 : -0.0902) + 0.0068 * (bx / 0.031) ** 2;
      const env = Math.sin(Math.PI * Math.min(1, Math.max(0, (ax - 0.0115) / 0.038)));
      const rBrow = (f ? 0.0026 : 0.0031) * (0.62 + 0.38 * arch) * env;
      if (rBrow > 1e-5) {
        const dz = z - zBrow;
        const zScale = dz > 0 ? 0.84 : 1.15;
        const dBrow = Math.hypot((ax - bx) * 0.88, (y - yBrow) * 0.95, dz * zScale) - rBrow;
        d = smin(d, dBrow, 0.0085);
      }
    }
    // Nasion indentation (root of nose steps cleanly inward beneath the glabella — zero top-of-nose bulge).
    d = smax(d, -ellipsoid(x, y, z, [0, -0.0972, -0.1185], [0.015, 0.0074, 0.0086]), 0.012);
    // Recessed orbital hollows beneath the brow arches & calm almond-shaped closed eyelids tucked behind brow.
    d = smax(d, -ellipsoid(ax, y, z, [0.0285, -0.0932, -0.1205], [0.0152, 0.0086, 0.0080]), 0.0125);
    d = smin(d, ellipsoid(ax, y, z, [0.0285, -0.0754, -0.1215], [0.0132, 0.0102, 0.0066]), 0.0105);
    // Slender pyramidal nose: narrow dorsal bridge & soft-domed compact tip flaring smoothly backward along
    // the nasal sidewalls to the maxilla, composed as one solid so blends never inflate the tip into a bulb.
    const yRel = y + 0.1015;
    const yBack = 0.5 * (yRel + Math.hypot(yRel, 0.005));
    const nx = (x * 0.88) / (1 + 13.5 * yBack);
    let dNose = cone(nx, y, z, [0, -0.0835, -0.1185], [0, -(0.0920 + 0.0040 * nose), -0.149], 0.0042 * nose, 0.0062 * nose);
    dNose = smin(dNose, cone(nx, y, z, [0, -(0.0914 + 0.0035 * nose), -0.1495], [0, -0.0880, -0.1645], 0.0053 * nose, 0.0060), 0.0075);
    dNose = smin(dNose, ellipsoid(ax, y, z, [0.0086 * nose, -0.0920, -0.153], [0.0044, 0.0049, 0.0047]), 0.0050);
    d = smin(d, dNose, 0.0098);
    // Understated sculptural lips with a gentle labial parting contour and mentolabial hollow.
    d = smin(d, ellipsoid(x, y, z, [0, -0.0875, -0.1755], [0.0215, 0.0088, 0.0066 * lip]), 0.0135);
    d = smin(d, ellipsoid(x, y, z, [0, -0.086, -0.1875], [0.019, 0.0088, 0.0068 * lip]), 0.0135);
    d = smax(d, -ellipsoid(x, y, z, [0, -0.0985, -0.1815], [0.0205, 0.0044, 0.0044]), 0.0125);
    d = smax(d, -ellipsoid(x, y, z, [0, -0.094, -0.1975], [0.018, 0.0040, 0.0068]), 0.015);
    // Clean studio ear plane, level between brow and nasal base (flush enough not to snag hats or crease >30°).
    d = smin(d, ellipsoid(ax, y, z, [f ? 0.0725 : 0.075, 0.012, -0.132], [0.0048, 0.015, 0.025]), 0.018);
    // The neck, into the base of the skull behind the jaw.
    return smin(d, cone(x, y, z, [0, 0, -0.33], [0, 0.02, -0.15], neckR * 0.92, neckR), 0.024); // the axis is neckAxisY's
  };
}

/** The outermost surface along one ray. Fixed steps: the field is only about a distance, and steps sized by it jumped thin features, leaving spikes. */
function rayHit(field: (x: number, y: number, z: number) => number, z: number, ca: number, sa: number): number {
  for (let r = 0.15; r > 0; r -= 0.001) {
    if (field(r * ca, r * sa, z) >= 0) continue;
    let lo = r, hi = r + 0.001;
    for (let i = 0; i < 6; i++) { const mid = (lo + hi) / 2; if (field(mid * ca, mid * sa, z) < 0) lo = mid; else hi = mid; }
    return lo;
  }
  return 0.002;
}

const rayCache = new WeakMap<(x: number, y: number, z: number) => number, Map<string, number>>();

function cachedRay(field: (x: number, y: number, z: number) => number, z: number, a: number): number {
  let map = rayCache.get(field);
  if (!map) { map = new Map(); rayCache.set(field, map); }
  const tau = 2 * Math.PI, an = ((a % tau) + tau) % tau;
  const key = `${z.toFixed(6)},${an.toFixed(6)}`;
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
