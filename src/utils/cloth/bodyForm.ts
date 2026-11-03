/**
 * A dress form from tape measurements: the torso a stack of elliptical
 * slices, each sized so its circumference is what a tape would read there,
 * with capsules and spheres for the neck, shoulders, arms and legs, and for a
 * female figure a bust sized so a tape round it reads the bust measurement.
 * Convex primitives only, so it collides as drawn. Stands on the floor at its
 * body's origin, facing -Y (the front of a garment is at -Y), MuJoCo Z-up,
 * metres.
 *
 * Proportions not given by a measurement (where the waist is, how deep a
 * chest is for its width, the set of the shoulders, the posture) are the
 * usual fractions for the figure, male or female.
 */

import type { BodyFigure, BodyFormMeasurements } from '../../types/cloth';
import type { SceneGeom } from '../../types/scene';

/** A typical figure of each kind: what a new form starts from. */
export const FIGURE_DEFAULTS: Record<BodyFigure, BodyFormMeasurements> = {
  male: {
    figure: 'male', height: 1.78, chest: 1.0, underbust: 0.92, waist: 0.86, hip: 0.98, neck: 0.39,
    shoulderWidth: 0.46, armLength: 0.62, upperArm: 0.31, armAngle: 45, legs: true,
  },
  female: {
    figure: 'female', height: 1.68, chest: 0.92, underbust: 0.78, waist: 0.72, hip: 0.98, neck: 0.33,
    shoulderWidth: 0.39, armLength: 0.57, upperArm: 0.27, armAngle: 45, legs: true,
  },
};

export const DEFAULT_BODY_FORM: BodyFormMeasurements = FIGURE_DEFAULTS.male;

/** Limits the inspector and MCP clamp to, metres (degrees for the arm). */
export const BODY_FORM_LIMITS: Record<Exclude<keyof BodyFormMeasurements, 'legs' | 'figure'>, [number, number]> = {
  height: [0.9, 2.2],
  chest: [0.5, 1.6],
  underbust: [0.45, 1.5],
  waist: [0.4, 1.6],
  hip: [0.5, 1.7],
  neck: [0.25, 0.55],
  shoulderWidth: [0.25, 0.6],
  armLength: [0.35, 0.85],
  upperArm: [0.15, 0.5],
  armAngle: [10, 90],
};

/**
 * Fills in what was not given from the figure's defaults (a form with only a
 * figure is that typical figure) and clamps to sane limits. The underbust is
 * never more than the chest: a male chest has none to speak of.
 */
export function clampBodyForm(m: Partial<BodyFormMeasurements>): BodyFormMeasurements {
  const figure: BodyFigure = m.figure === 'female' ? 'female' : 'male';
  const base = FIGURE_DEFAULTS[figure];
  const out: BodyFormMeasurements = { ...base, ...m, figure };
  // Scale an unstated underbust with a stated chest, keeping the figure's difference.
  if (m.underbust === undefined && m.chest !== undefined) out.underbust = m.chest - (base.chest - base.underbust);
  for (const [k, [lo, hi]] of Object.entries(BODY_FORM_LIMITS) as [keyof typeof BODY_FORM_LIMITS, [number, number]][]) {
    const v = Number(out[k]);
    out[k] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : base[k];
  }
  out.underbust = Math.min(out.underbust, out.chest);
  out.legs = out.legs !== false;
  return out;
}

/** Semi-axis across for an ellipse of circumference `c` whose depth is `k` times its width (Ramanujan). */
export function ellipseHalfWidth(c: number, k: number): number {
  return c / (Math.PI * (3 * (1 + k) - Math.sqrt((3 + k) * (1 + 3 * k))));
}

/** Where things are on a form, for drafting garments onto it. Body frame. */
export interface BodyLandmarks {
  /** Height of the shoulder line (top of the shoulders, at the neck: HPS). */
  hpsZ: number;
  shoulderZ: number;
  /** How far the shoulder slopes from the neck down to the shoulder point. */
  shoulderDrop: number;
  bustZ: number;
  waistZ: number;
  hipZ: number;
  crotchZ: number;
  /** Half-depth of the chest, front to back. */
  chestDepth: number;
  /** Half-width of the hips. */
  hipHalf: number;
  hipDepth: number;
  neckRadius: number;
  /** Shoulder point, +x side. */
  shoulderPoint: number[];
  /** Unit direction down the +x arm. */
  armDir: number[];
  armRadius: number;
  armLength: number;
  /** Bust point, +x side (a male figure's is where a dart would point, were there one). */
  bustPoint: number[];
  /** How far the bust stands out from the ribcage under it, metres; 0 for none. */
  bustProminence: number;
}

/** The figure's proportions: heights as fractions of height, and the torso's shape at each. */
function proportions(m: BodyFormMeasurements) {
  const female = m.figure === 'female';
  const s = m.height / 1.75;
  return {
    s,
    shoulderZ: 0.817 * m.height,
    shoulderDrop: (female ? 0.05 : 0.04) * s,
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

/**
 * The bust: two ellipsoids standing out from the ribcage, brought forward
 * until a tape round the lot (the convex hull of the section) reads `chest`.
 */
function bustGeometry(m: BodyFormMeasurements) {
  const P = proportions(m);
  const s = P.s;
  const rib = { a: ellipseHalfWidth(m.underbust, 0.72), k: 0.72, cy: P.centre.bust };
  const r = { x: 0.07 * s, y: 0.055 * s, z: 0.065 * s };
  if (m.figure !== 'female' || m.chest - m.underbust < 0.02) return null;
  const front = rib.cy - rib.a * rib.k;
  const girth = (p: number) => {
    const pts: [number, number][] = [];
    for (let i = 0; i < 64; i++) { const t = (2 * Math.PI * i) / 64; pts.push([rib.a * Math.sin(t), rib.cy - rib.a * rib.k * Math.cos(t)]); }
    for (const side of [1, -1]) {
      const cx = side * P.bustSpan / 2, cy = front - p + r.y;
      for (let i = 0; i < 32; i++) { const t = (2 * Math.PI * i) / 32; pts.push([cx + r.x * Math.cos(t), cy + r.y * Math.sin(t)]); }
    }
    return hullPerimeter(pts);
  };
  let lo = 0, hi = 0.15 * s;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (girth(mid) < m.chest) lo = mid; else hi = mid; }
  const p = (lo + hi) / 2;
  return { prominence: p, centreY: front - p + r.y, radii: r };
}

/** Perimeter of the convex hull of 2D points (monotone chain). */
function hullPerimeter(pts: [number, number][]): number {
  const P = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: number[][] = [], upper: number[][] = [];
  for (const p of P) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (const p of P.slice().reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  let L = 0;
  for (let i = 0; i < hull.length; i++) { const a = hull[i], b = hull[(i + 1) % hull.length]; L += Math.hypot(a[0] - b[0], a[1] - b[1]); }
  return L;
}

export function bodyLandmarks(m: BodyFormMeasurements): BodyLandmarks {
  const P = proportions(m);
  const th = (m.armAngle * Math.PI) / 180;
  const chestHalf = ellipseHalfWidth(m.chest, 0.7);
  const hipHalf = ellipseHalfWidth(m.hip, 0.74);
  const bust = bustGeometry(m);
  return {
    hpsZ: P.shoulderZ + P.shoulderR,
    shoulderZ: P.shoulderZ,
    shoulderDrop: P.shoulderDrop,
    bustZ: P.bustZ,
    waistZ: P.waistZ,
    hipZ: P.hipZ,
    crotchZ: P.crotchZ,
    chestDepth: 0.7 * chestHalf,
    hipHalf,
    hipDepth: 0.74 * hipHalf,
    neckRadius: m.neck / (2 * Math.PI),
    shoulderPoint: [m.shoulderWidth / 2, 0, P.shoulderZ - P.shoulderDrop],
    armDir: [Math.cos(th), 0, -Math.sin(th)],
    armRadius: m.upperArm / (2 * Math.PI),
    armLength: m.armLength,
    bustPoint: [P.bustSpan / 2, bust ? bust.centreY - bust.radii.y : -0.7 * chestHalf, P.bustZ],
    bustProminence: bust?.prominence ?? 0,
  };
}

const r4 = (x: number) => +x.toFixed(4);

/** The form's geoms, named `<prefix>_<part>`. */
export function bodyFormGeoms(m: BodyFormMeasurements, prefix: string): SceneGeom[] {
  const P = proportions(m);
  const L = bodyLandmarks(m);
  const female = m.figure === 'female';
  const H = m.height, s = P.s;
  const rgba = [0.93, 0.89, 0.82, 1];
  const geoms: SceneGeom[] = [];
  const add = (name: string, g: Omit<SceneGeom, 'name' | 'rgba'>) => geoms.push({ name: `${prefix}_${name}`, rgba, ...g } as SceneGeom);

  // The torso: tape measurements at a few heights ([height, circumference,
  // depth over width, centre toward the back]), eased between with a cosine
  // and cut into overlapping slices.
  const C = P.centre;
  const keys: [number, number, number, number][] = female
    ? [
      [P.shoulderZ - 0.05 * s, m.underbust * 1.04, 0.6, C.upper],
      [P.bustZ, m.underbust, 0.72, C.bust],
      [P.bustZ - 0.07 * s, m.underbust * 0.99, 0.72, C.bust],
      [P.waistZ, m.waist, 0.72, C.waist],
      [P.hipZ, m.hip, 0.76, C.hip],
      [P.crotchZ + 0.03 * s, m.hip * 0.94, 0.72, C.seat],
    ]
    : [
      [P.shoulderZ - 0.05 * s, m.chest * 0.95, 0.6, C.upper],
      [P.bustZ, m.chest, 0.68, C.bust],
      [P.waistZ, m.waist, 0.78, C.waist],
      [P.hipZ, m.hip, 0.72, C.hip],
      [P.crotchZ + 0.03 * s, m.hip * 0.94, 0.7, C.seat],
    ];
  const top = keys[0][0], bottom = keys[keys.length - 1][0];
  const N = 9, step = (top - bottom) / (N - 1);
  const at = (z: number): [number, number, number] => {
    for (let i = 0; i < keys.length - 1; i++) {
      const [z0, c0, k0, y0] = keys[i], [z1, c1, k1, y1] = keys[i + 1];
      if (z <= z0 + 1e-9 && z >= z1 - 1e-9) {
        const t = (1 - Math.cos((Math.PI * (z0 - z)) / (z0 - z1))) / 2;
        return [c0 + (c1 - c0) * t, k0 + (k1 - k0) * t, y0 + (y1 - y0) * t];
      }
    }
    const last = keys[keys.length - 1];
    return [last[1], last[2], last[3]];
  };
  for (let i = 0; i < N; i++) {
    const z = top - i * step;
    const [c, k, cy] = at(z);
    const a = ellipseHalfWidth(c, k);
    // Each slice 2.5 steps tall, so they overlap deeply. At 0.9 each pair met
    // in a groove ~17% of the radius deep (3 cm at the waist), and cloth lying
    // across a groove is pinched between two solids: it sank into the form and
    // chattered there. The end slices are kept short so they do not stand out
    // above the shoulders or below the seat.
    const half = i === 0 || i === N - 1 ? step * 1.2 : step * 2.5;
    add(`torso${i}`, { type: 'ellipsoid', size: [r4(a), r4(a * k), r4(half)], pos: [0, r4(cy), r4(z)] });
  }

  const bust = bustGeometry(m);
  if (bust) {
    for (const side of [1, -1]) {
      add(`bust${side > 0 ? 'L' : 'R'}`, { type: 'ellipsoid', size: [r4(bust.radii.x), r4(bust.radii.y), r4(bust.radii.z)], pos: [r4(side * P.bustSpan / 2), r4(bust.centreY), r4(P.bustZ)] });
    }
  }

  // Shoulders slope from the base of the neck to the shoulder point, which
  // is rounded by the deltoid.
  const sx = m.shoulderWidth / 2 - P.shoulderR * 0.6;
  const spZ = P.shoulderZ - P.shoulderDrop;
  for (const side of [1, -1]) {
    const tag = side > 0 ? 'L' : 'R'; // the wearer's left is +x, facing -y
    add(`shoulder${tag}`, { type: 'capsule', size: [r4(P.shoulderR)], fromto: [r4(side * L.neckRadius * 0.8), 0, r4(P.shoulderZ), r4(side * sx), 0, r4(spZ)] });
    add(`deltoid${tag}`, { type: 'sphere', size: [r4(L.armRadius * 1.3)], pos: [r4(side * (sx + 0.005 * s)), 0, r4(spZ - 0.012 * s)] });
  }
  // The neck, carried a little forward of the shoulders.
  add('neck', { type: 'capsule', size: [r4(L.neckRadius)], fromto: [0, 0, r4(P.shoulderZ - 0.02 * s), 0, r4(-0.012 * s), r4(0.875 * H)] });
  add('head', { type: 'ellipsoid', size: [r4(0.075 * s), r4(0.095 * s), r4(0.115 * s)], pos: [0, r4(-0.015 * s), r4(H - 0.115 * s)] });

  for (const side of [1, -1]) {
    const tag = side > 0 ? 'L' : 'R';
    const o = [side * sx, 0, spZ - 0.01 * s];
    const d = [side * L.armDir[0], 0, L.armDir[2]];
    const elbow = o.map((v, k) => v + d[k] * m.armLength * 0.47);
    const wrist = o.map((v, k) => v + d[k] * m.armLength);
    const hand = wrist.map((v, k) => v + d[k] * 0.09 * s);
    add(`upperArm${tag}`, { type: 'capsule', size: [r4(L.armRadius)], fromto: [...o, ...elbow].map(r4) });
    add(`forearm${tag}`, { type: 'capsule', size: [r4(L.armRadius * 0.78)], fromto: [...elbow, ...wrist].map(r4) });
    add(`hand${tag}`, { type: 'capsule', size: [r4(0.026 * s)], fromto: [...wrist, ...hand].map(r4) });
  }

  if (m.legs) {
    const thighR = (m.hip * (female ? 0.6 : 0.56)) / (2 * Math.PI), calfR = thighR * 0.6;
    const kneeZ = 0.285 * H, ankleZ = 0.05 * H;
    for (const side of [1, -1]) {
      const tag = side > 0 ? 'L' : 'R';
      const x = side * L.hipHalf * (female ? 0.44 : 0.48);
      const midZ = (P.crotchZ + kneeZ) / 2;
      add(`thigh${tag}`, { type: 'capsule', size: [r4(thighR)], fromto: [x, r4(C.seat), r4(P.crotchZ + 0.03 * s), r4(x * 0.9), r4(C.seat / 2), r4(midZ)] });
      add(`knee${tag}`, { type: 'capsule', size: [r4(thighR * 0.72)], fromto: [r4(x * 0.9), r4(C.seat / 2), r4(midZ), r4(x * 0.8), 0, r4(kneeZ)] });
      add(`calf${tag}`, { type: 'capsule', size: [r4(calfR)], fromto: [r4(x * 0.8), 0, r4(kneeZ), r4(x * 0.75), r4(0.01 * s), r4(ankleZ)] });
      add(`foot${tag}`, { type: 'box', size: [r4(0.04 * s), r4(0.12 * s), r4(0.03 * s)], pos: [r4(x * 0.75), r4(-0.06 * s), r4(0.03 * s)] });
    }
  } else {
    // A dress form's stand.
    add('pole', { type: 'cylinder', size: [0.015, r4((P.crotchZ + 0.03 * s) / 2)], pos: [0, 0, r4((P.crotchZ + 0.03 * s) / 2)] });
    add('base', { type: 'cylinder', size: [0.22, 0.015], pos: [0, 0, 0.015] });
  }
  // The torso is drawn as one smooth skin over its slices, which still do
  // the colliding but are not drawn: stacked, they read as a pile of rings.
  for (const g of geoms) if (/_(torso\d+|bust\w*|shoulder\w*|deltoid\w*)$/.test(g.name)) g.role = 'collision';
  geoms.push(torsoSkin(geoms, P.crotchZ + 0.02 * s, P.shoulderZ + P.shoulderR, `${prefix}_skin`, rgba));
  return geoms;
}

/**
 * A smooth mesh over the torso's colliding geoms: at each height the convex
 * hull of their cross-sections (what a tape round the body traces), sampled
 * by angle and lofted. Drawn only (role 'visual'). Vertices Three.js Y-up, as
 * mesh geoms are; triangles wound outward (CLAUDE.md, face winding).
 */
function torsoSkin(geoms: SceneGeom[], z0: number, z1: number, name: string, rgba: number[]): SceneGeom {
  const parts = geoms.filter((g) => g.role === 'collision');
  const ANG = 72, ROWS = Math.max(8, Math.round((z1 - z0) / 0.012));
  const rows: number[][][] = [];
  for (let r = 0; r <= ROWS; r++) {
    const z = z0 + ((z1 - z0) * r) / ROWS;
    const pts: [number, number][] = [];
    for (const g of parts) {
      if (g.type === 'ellipsoid' || g.type === 'sphere') {
        const [a, b, c] = g.type === 'sphere' ? [g.size[0], g.size[0], g.size[0]] : g.size;
        const p = g.pos ?? [0, 0, 0], t = (z - p[2]) / c;
        if (Math.abs(t) >= 1) continue;
        const k = Math.sqrt(1 - t * t);
        for (let i = 0; i < 48; i++) { const th = (2 * Math.PI * i) / 48; pts.push([p[0] + a * k * Math.cos(th), p[1] + b * k * Math.sin(th)]); }
      } else if (g.type === 'capsule' && g.fromto) {
        const [ax, ay, az, bx, by, bz] = g.fromto, rad = g.size[0];
        for (let j = 0; j <= 12; j++) {
          const f = j / 12, px = ax + (bx - ax) * f, py = ay + (by - ay) * f, dz = z - (az + (bz - az) * f);
          if (Math.abs(dz) >= rad) continue;
          const h = Math.sqrt(rad * rad - dz * dz);
          for (let i = 0; i < 16; i++) { const th = (2 * Math.PI * i) / 16; pts.push([px + h * Math.cos(th), py + h * Math.sin(th)]); }
        }
      }
    }
    const hull = convexHull(pts);
    if (hull.length < 3) continue;
    let cy = 0;
    for (const p of hull) cy += p[1];
    cy /= hull.length;
    // Round the hull by angle from its centre, so every row has the same points.
    const row: number[][] = [];
    for (let i = 0; i < ANG; i++) {
      const th = (2 * Math.PI * i) / ANG, dx = Math.cos(th), dy = Math.sin(th);
      let best = 0;
      for (let k = 0; k < hull.length; k++) {
        const [x1, y1] = hull[k], [x2, y2] = hull[(k + 1) % hull.length];
        // Ray (0, cy) + t (dx, dy) against segment.
        const ex = x2 - x1, ey = y2 - y1, den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((x1) * ey - (y1 - cy) * ex) / den, u = ((x1) * dy - (y1 - cy) * dx) / den;
        if (t > 0 && u >= -1e-9 && u <= 1 + 1e-9) best = Math.max(best, t);
      }
      row.push([best * dx, cy + best * dy, z]);
    }
    rows.push(row);
  }
  // Each section's hull is smooth round the body but not up it: it still
  // follows every slice's bulge. A running mean up each column, twice, over
  // about +-4 cm, evens them out and keeps the waist.
  const W = 3;
  for (let pass = 0; pass < 2; pass++) {
    const copy = rows.map((row) => row.map((p) => p.slice()));
    for (let r = 1; r + 1 < rows.length; r++) {
      for (let i = 0; i < ANG; i++) {
        let sx = 0, sy = 0, n = 0;
        for (let q = Math.max(0, r - W); q <= Math.min(rows.length - 1, r + W); q++) { sx += copy[q][i][0]; sy += copy[q][i][1]; n++; }
        rows[r][i][0] = sx / n; rows[r][i][1] = sy / n;
      }
    }
  }
  // MuJoCo Z-up (x, y, z) is Three.js (x, z, -y).
  const vertices: number[] = [];
  const push = (p: number[]) => { vertices.push(p[0], p[2], -p[1]); return vertices.length / 3 - 1; };
  const idx = rows.map((row) => row.map(push));
  const faces: number[] = [];
  for (let r = 0; r + 1 < idx.length; r++) {
    for (let i = 0; i < ANG; i++) {
      const a = idx[r][i], b = idx[r][(i + 1) % ANG], c = idx[r + 1][(i + 1) % ANG], d = idx[r + 1][i];
      // Counter-clockwise round z, then up: outward.
      faces.push(a, b, c, a, c, d);
    }
  }
  // Caps: fans to the centre of the bottom and top rows, facing down and up.
  const centre = (row: number[][]) => push([0, row.reduce((sum, p) => sum + p[1], 0) / row.length, row[0][2]]);
  const bottom = centre(rows[0]), topC = centre(rows[rows.length - 1]);
  for (let i = 0; i < ANG; i++) {
    faces.push(bottom, idx[0][(i + 1) % ANG], idx[0][i]);
    faces.push(topC, idx[idx.length - 1][i], idx[idx.length - 1][(i + 1) % ANG]);
  }
  return { name, type: 'mesh', size: [1, 1, 1], role: 'visual', rgba, vertices, faces } as SceneGeom;
}

function convexHull(pts: [number, number][]): [number, number][] {
  const P = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [], upper: [number, number][] = [];
  for (const p of P) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (const p of P.slice().reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * The torso's cross-section at height z: half-width, half-depth, and how far
 * its centre sits toward +y. From the torso slices and the shoulders (not the
 * arms, neck or legs), as garments are wrapped round it to start. Below the
 * hips it stays the hips' (a skirt hangs from them); above the shoulders it
 * closes to nothing.
 */
export function bodyFormSection(m: BodyFormMeasurements, z: number, prefix = 'form') {
  const L = bodyLandmarks(m);
  const geoms = bodyFormGeoms(m, prefix).filter((g) => /_(torso\d+|shoulder\w*|bust\w*|deltoid\w*)$/.test(g.name));
  const zz = Math.max(z, L.hipZ);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const g of geoms) {
    if (g.type === 'ellipsoid' || g.type === 'sphere') {
      const [a, b, c] = g.type === 'sphere' ? [g.size[0], g.size[0], g.size[0]] : g.size;
      const p = g.pos ?? [0, 0, 0], t = (zz - p[2]) / c;
      if (Math.abs(t) >= 1) continue;
      const s = Math.sqrt(1 - t * t);
      x0 = Math.min(x0, p[0] - a * s); x1 = Math.max(x1, p[0] + a * s);
      y0 = Math.min(y0, p[1] - b * s); y1 = Math.max(y1, p[1] + b * s);
    } else if (g.type === 'capsule' && g.fromto) {
      const [ax, ay, az, bx, by, bz] = g.fromto, r = g.size[0];
      // Sampled along the axis: each point's sphere cut at height zz.
      for (let i = 0; i <= 16; i++) {
        const f = i / 16, px = ax + (bx - ax) * f, py = ay + (by - ay) * f, pz = az + (bz - az) * f;
        const dz = zz - pz;
        if (Math.abs(dz) >= r) continue;
        const h = Math.sqrt(r * r - dz * dz);
        x0 = Math.min(x0, px - h); x1 = Math.max(x1, px + h);
        y0 = Math.min(y0, py - h); y1 = Math.max(y1, py + h);
      }
    }
  }
  if (!Number.isFinite(x0)) return { halfWidth: 0.01, halfDepth: 0.005, centreY: 0 };
  return { halfWidth: Math.max(Math.abs(x0), Math.abs(x1)), halfDepth: (y1 - y0) / 2, centreY: (y1 + y0) / 2 };
}

/** The section every `step` metres from `z0` up to `z1`, as a girth placement's profile (v measured from `zRef`). */
export function bodyFormProfile(m: BodyFormMeasurements, z0: number, z1: number, zRef: number, step = 0.02) {
  const out: { v: number; halfWidth: number; halfDepth: number; centreY: number }[] = [];
  for (let z = z0; z <= z1 + 1e-9; z += step) out.push({ v: z - zRef, ...bodyFormSection(m, z) });
  return out;
}
