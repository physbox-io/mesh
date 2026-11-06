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

import { limbLoft } from './limbLoft';
import { ellipseHalfWidth, NECK_TOP, proportions } from './formProportions';

export { ellipseHalfWidth } from './formProportions';
import { formLimbs, limbSections } from './formLimbs';
import type { LimbPath } from './limbPath';
import type { BodyFigure, BodyFormMeasurements } from '../../types/cloth';
import type { SceneGeom } from '../../types/scene';

/** A typical figure of each kind: what a new form starts from. */
export const FIGURE_DEFAULTS: Record<BodyFigure, BodyFormMeasurements> = {
  male: {
    figure: 'male', height: 1.78, chest: 1.0, underbust: 0.92, waist: 0.86, hip: 0.98, neck: 0.39,
    shoulderWidth: 0.46, armLength: 0.62, upperArm: 0.31, armAngle: 45, elbowBend: 80, legs: true,
  },
  female: {
    figure: 'female', height: 1.68, chest: 0.92, underbust: 0.78, waist: 0.72, hip: 0.98, neck: 0.33,
    shoulderWidth: 0.39, armLength: 0.57, upperArm: 0.27, armAngle: 45, elbowBend: 80, legs: true,
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
  elbowBend: [0, 150],
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
  /** Where the +x arm's axis starts, at the shoulder. */
  armOrigin: number[];
  /** Radius of the deltoid that rounds the shoulder over the arm. */
  deltoidRadius: number;
  armRadius: number;
  armLength: number;
  /** Bust point, +x side (a male figure's is where a dart would point, were there one). */
  bustPoint: number[];
  /** How far the bust stands out from the ribcage under it, metres; 0 for none. */
  bustProminence: number;
}

/** The figure's proportions: heights as fractions of height, and the torso's shape at each. */

/**
 * The bust: two ellipsoids standing out from the ribcage, brought forward
 * until a tape round the lot (the convex hull of the section) reads `chest`
 * on an ideal ribcage. The form as built reads more (its sections are
 * smoothed hulls of every part there), so it is sized by `formTapes`.
 */
function bustGeometry(m: BodyFormMeasurements, chest = formTapes(m).chest) {
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
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (girth(mid) < chest) lo = mid; else hi = mid; }
  const p = (lo + hi) / 2;
  return { prominence: p, centreY: front - p + r.y, radii: r };
}

/** What each tape height is built to: for the bust, the chest the bust is sized to. */
interface Tapes { chest: number; waist: number; hip: number }
const tapesCache = new Map<string, Tapes>();

/**
 * What to build chest, waist and hip to so that a tape round the form as
 * built reads the measurements: corrected against the built form's own
 * sections a few times over. A section is a smoothed hull of every part at
 * its height, so built straight from the measurements a female form's waist
 * read 6% over and a male one's hip 3% under.
 */
function formTapes(m: BodyFormMeasurements): Tapes {
  const key = JSON.stringify(m);
  let t = tapesCache.get(key);
  if (t) return t;
  t = { chest: m.chest, waist: m.waist, hip: m.hip };
  const P = proportions(m);
  for (let it = 0; it < 5; it++) {
    const rows = torsoRows(torsoParts(bodyFormGeomsRaw(m, 'form', t)), P.crotchZ - 0.005 * P.s, NECK_TOP * m.height, torsoProfile(m, t));
    const read = { chest: sectionGirth(sectionAt(rows, P.bustZ)), waist: sectionGirth(sectionAt(rows, P.waistZ)), hip: sectionGirth(sectionAt(rows, P.hipZ)) };
    if ((Object.keys(read) as (keyof Tapes)[]).every((k) => Math.abs(read[k] / m[k] - 1) < 0.003)) break;
    t = { chest: t.chest * m.chest / read.chest, waist: t.waist * m.waist / read.waist, hip: t.hip * m.hip / read.hip };
  }
  if (tapesCache.size > 32) tapesCache.clear();
  tapesCache.set(key, t);
  return t;
}

/** Perimeter of a section given as radii at even angles round its centre. */
function sectionGirth(sec: { radii: number[] }): number {
  const n = sec.radii.length;
  let L = 0;
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n, b = (2 * Math.PI * (i + 1)) / n, ra = sec.radii[i], rb = sec.radii[(i + 1) % n];
    L += Math.hypot(rb * Math.cos(b) - ra * Math.cos(a), rb * Math.sin(b) - ra * Math.sin(a));
  }
  return L;
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

const landmarksCache = new Map<string, BodyLandmarks>();
/** Where things are on a form (cached: the bust alone is a bisection, and garments ask constantly). */
export function bodyLandmarks(m: BodyFormMeasurements): BodyLandmarks {
  const key = JSON.stringify(m);
  let hit = landmarksCache.get(key);
  if (!hit) {
    hit = computeLandmarks(m);
    if (landmarksCache.size > 32) landmarksCache.clear();
    landmarksCache.set(key, hit);
  }
  return hit;
}

/** The landmarks the form's parts are built from, none of them the bust's (which is sized on the built form). */
function limbLandmarks(m: BodyFormMeasurements) {
  const th = (m.armAngle * Math.PI) / 180;
  return {
    armDir: [Math.cos(th), 0, -Math.sin(th)],
    armRadius: m.upperArm / (2 * Math.PI),
    hipHalf: ellipseHalfWidth(m.hip, 0.74),
    neckRadius: m.neck / (2 * Math.PI),
  };
}

function computeLandmarks(m: BodyFormMeasurements): BodyLandmarks {
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
    armOrigin: [m.shoulderWidth / 2 - P.shoulderR * 0.6, 0, P.shoulderZ - P.shoulderDrop - 0.01 * P.s],
    deltoidRadius: (m.upperArm / (2 * Math.PI)) * 1.3,
    armRadius: m.upperArm / (2 * Math.PI),
    armLength: m.armLength,
    bustPoint: [P.bustSpan / 2, bust ? bust.centreY - bust.radii.y : -0.7 * chestHalf, P.bustZ],
    bustProminence: bust?.prominence ?? 0,
  };
}

const r4 = (x: number) => +x.toFixed(4);

/**
 * The torso's skin as a closed mesh, Z-up, as a garment is modelled off it.
 * `hangFrom`: below that height, each way round, as far out as the body is
 * anywhere between there and it, so a garment not shaped in under the bust
 * hangs straight from it (a t-shirt). `downTo`: below the hips, the hips'
 * section carried straight down to there, for a skirt.
 */
export function formSkin(m: BodyFormMeasurements, hangFrom?: number, downTo?: number): { points: number[][]; tris: number[] } {
  let rows = formRows(m);
  // On down past the seat, as the hips (a skirt hangs from them, and does not follow the legs).
  if (downTo !== undefined && downTo < rows[0].z) {
    const hip = sectionAt(rows, bodyLandmarks(m).hipZ), step = rows[1].z - rows[0].z;
    const below: TorsoRow[] = [];
    for (let z = rows[0].z - step; z > downTo - step; z -= step) below.unshift({ z, centreY: hip.centreY, radii: hip.radii.slice() });
    rows = [...below, ...rows.map((row) => (row.z < bodyLandmarks(m).hipZ ? { ...row, centreY: hip.centreY, radii: row.radii.map((r, i) => Math.max(r, hip.radii[i])) } : row))];
  }
  if (hangFrom !== undefined) {
    let run: number[] | null = null;
    rows = rows.slice().reverse().map((row) => {
      if (row.z > hangFrom) return row;
      run = run ? run.map((r, i) => Math.max(r, row.radii[i])) : row.radii.slice();
      return { ...row, radii: run.slice() };
    }).reverse();
  }
  const { vertices, faces } = loft(rows);
  const points: number[][] = [];
  for (let i = 0; i < vertices.length; i += 3) points.push([vertices[i], -vertices[i + 2], vertices[i + 1]]);
  return { points, tris: faces.slice() };
}

/** The centreline of the form's arm on one side (+1 the wearer's left, +x). */
export function formArmPath(m: BodyFormMeasurements, side: 1 | -1): LimbPath {
  return formLimbs(m)[side > 0 ? 'armL' : 'armR'].path;
}

/** The form's geoms, named `<prefix>_<part>`. */
export function bodyFormGeoms(m: BodyFormMeasurements, prefix: string): SceneGeom[] {
  const P = proportions(m);
  const geoms = bodyFormGeomsRaw(m, prefix);
  // The torso is one smooth surface, lofted through the hull of its tape
  // profile's sections and these parts': it is what is drawn, and it is what collides, as a stack of
  // convex slabs cut from it. Drawn as slices the torso read as a pile of
  // rings; colliding as slices it had grooves between them that cloth sank
  // into, below the surface you could see.
  const isTorsoPart = (g: SceneGeom) => /_(bust\w*|shoulder\w*|deltoid\w*|neck)$/.test(g.name);
  const rows = prefix === 'form' ? formRows(m) : torsoRows(geoms.filter(isTorsoPart), P.crotchZ - 0.005 * P.s, NECK_TOP * m.height, torsoProfile(m, formTapes(m)));
  const rgba = geoms[0]?.rgba ?? [0.93, 0.89, 0.82, 1];
  return [...geoms.filter((g) => !isTorsoPart(g)), torsoSkin(rows, `${prefix}_skin`, rgba), ...torsoSlabs(rows, `${prefix}_torso`)];
}

/**
 * The torso as tape measurements at a few heights ([height, circumference,
 * depth over width, centre toward the back]), eased between with a cosine:
 * at each height an ellipse, half-width a, depth b, centred at cy. Below the
 * hips the central pelvis narrows between the thighs into the crotch while
 * the upper thighs and glutes emerge at the sides.
 */
function torsoProfile(m: BodyFormMeasurements, T: Tapes): (z: number) => { a: number; b: number; cy: number } | null {
  const P = proportions(m), C = P.centre, s = P.s;
  const keys: [number, number, number, number][] = m.figure === 'female'
    ? [
      [P.shoulderZ - 0.05 * s, m.underbust * 1.04, 0.6, C.upper],
      [P.bustZ, m.underbust, 0.72, C.bust],
      [P.waistZ, T.waist, 0.74, C.waist],
      [P.hipZ + 0.03 * s, T.hip * 0.94, 0.72, C.hip],
      [P.hipZ, T.hip, 0.74, C.hip],
      [P.hipZ - 0.018 * s, T.hip * 0.95, 0.72, C.seat],
    ]
    : [
      [P.shoulderZ - 0.05 * s, T.chest * 0.96, 0.6, C.upper],
      [P.bustZ, T.chest, 0.68, C.bust],
      [P.waistZ, T.waist, 0.72, C.waist],
      [P.hipZ + 0.03 * s, T.hip * 0.95, 0.71, C.hip],
      [P.hipZ, T.hip, 0.72, C.hip],
      [P.hipZ - 0.018 * s, T.hip * 0.95, 0.7, C.seat],
    ];
  const top = keys[0][0], bottom = keys[keys.length - 1][0], cap = 0.08 * s;
  const crotchBottom = P.crotchZ - 0.012 * s;
  const ellipse = (c: number, k: number, cy: number, f = 1) => { const a = ellipseHalfWidth(c, k) * f; return { a, b: a * k, cy }; };
  return (z) => {
    if (z > top) { const t = (z - top) / cap; return t >= 1 ? null : ellipse(keys[0][1], keys[0][2], keys[0][3], Math.sqrt(1 - t * t)); }
    if (z < bottom) {
      if (z <= crotchBottom) return null;
      const l = keys[keys.length - 1], base = ellipse(l[1], l[2], l[3]);
      // Pelvic wedge: narrows along the groin creases between the thighs, then rounds under the crotch.
      const u = (bottom - z) / (bottom - crotchBottom);
      const sCurve = u * u * (3 - 2 * u);
      const round = u > 0.7 ? Math.sqrt(Math.max(0.02, 1 - ((u - 0.7) / 0.3) ** 2)) : 1;
      const a = (base.a * (1 - sCurve) + 0.038 * s * sCurve) * round;
      const b = (base.b * (1 - 0.42 * sCurve)) * round;
      return { a, b, cy: l[3] * (1 - 0.3 * sCurve) };
    }
    for (let i = 0; i < keys.length - 1; i++) {
      const [z0, c0, k0, y0] = keys[i], [z1, c1, k1, y1] = keys[i + 1];
      if (z <= z0 + 1e-9 && z >= z1 - 1e-9) {
        const t = (1 - Math.cos((Math.PI * (z0 - z)) / (z0 - z1))) / 2;
        return ellipse(c0 + (c1 - c0) * t, k0 + (k1 - k0) * t, y0 + (y1 - y0) * t);
      }
    }
    return null;
  };
}

/** Every primitive the form is built from, the torso's construction parts included. */
function bodyFormGeomsRaw(m: BodyFormMeasurements, prefix: string, tune: Tapes = formTapes(m)): SceneGeom[] {
  const P = proportions(m);
  const T = tune;
  const L = limbLandmarks(m);
  const H = m.height, s = P.s;
  const rgba = [0.93, 0.89, 0.82, 1];
  const geoms: SceneGeom[] = [];
  const add = (name: string, g: Omit<SceneGeom, 'name' | 'rgba'>) => geoms.push({ name: `${prefix}_${name}`, rgba, ...g } as SceneGeom);

  const bust = bustGeometry(m, T.chest);
  if (bust) {
    for (const side of [1, -1]) {
      add(`bust${side > 0 ? 'L' : 'R'}`, { type: 'ellipsoid', size: [r4(bust.radii.x), r4(bust.radii.y), r4(bust.radii.z)], pos: [r4(side * P.bustSpan / 2), r4(bust.centreY), r4(P.bustZ)] });
    }
  }

  // Shoulders slope from the base of the neck to the shoulder point; the
  // deltoid cap sits on the arm's root (formLimbs), while a smaller shoulder
  // cap here blends the acromion smoothly into the upper chest without
  // bulging out past the shoulder crease.
  const sx = m.shoulderWidth / 2 - P.shoulderR * 0.6;
  const spZ = P.shoulderZ - P.shoulderDrop;
  for (const side of [1, -1]) {
    const tag = side > 0 ? 'L' : 'R'; // the wearer's left is +x, facing -y
    add(`shoulder${tag}`, { type: 'capsule', size: [r4(P.shoulderR)], fromto: [r4(side * L.neckRadius * 0.8), 0, r4(P.shoulderZ), r4(side * sx), 0, r4(spZ)] });
    add(`deltoid${tag}`, { type: 'sphere', size: [r4(P.shoulderR * 1.05)], pos: [r4(side * (sx - 0.01 * s)), 0, r4(spZ - 0.015 * s)] });
  }
  // The neck, carried a little forward of the shoulders.
  add('neck', { type: 'capsule', size: [r4(L.neckRadius)], fromto: [0, 0, r4(P.shoulderZ - 0.02 * s), 0, r4(-0.012 * s), r4(NECK_TOP * H)] });
  add('head', { type: 'ellipsoid', role: 'collision', size: [r4(0.075 * s), r4(0.095 * s), r4(0.115 * s)], pos: [0, r4(-0.015 * s), r4(H - 0.115 * s)] });

  // Arms: one smooth limb each, tapering from the shoulder through the elbow
  // to the wrist and on into a mitten hand, palm to the body, with a thumb.
  const rA = L.armRadius;
  // Arms, legs and head: each one smooth limb (formLimbs), drawn and what
  // cloth lies on; MuJoCo collides with capsules along it, as the torso's
  // skin has its slabs (a concave mesh would be decomposed).
  const limbs = formLimbs(m);
  for (const side of [1, -1] as const) {
    const tag = side > 0 ? 'L' : 'R';
    const limb = limbs[side > 0 ? 'armL' : 'armR'], path = limb.path, A = m.armLength;
    add(`arm${tag}`, { type: 'mesh', size: [1, 1, 1], role: 'visual', ...limbLoft(limbSections(limb), [0, 1, 0]) });
    const o = path.at(0), elbow = path.at(path.jointAt), wrist = path.at(A), tip = path.at(A + 0.14 * s);
    add(`upperArm${tag}`, { type: 'capsule', role: 'collision', size: [r4(rA * 0.9)], fromto: [...o, ...elbow].map(r4) });
    add(`forearm${tag}`, { type: 'capsule', role: 'collision', size: [r4(rA * 0.7)], fromto: [...elbow, ...wrist].map(r4) });
    add(`hand${tag}`, { type: 'capsule', role: 'collision', size: [r4(0.015 * s)], fromto: [...wrist, ...tip].map(r4) });
    // The thumb at the palm's front edge, out and along it.
    const h0 = limb.section(A + 0.02 * s), h1 = limb.section(A + 0.075 * s);
    const thumb0 = h0.c.map((v, k) => v + h0.side[k] * 0.036 * s), thumb1 = h1.c.map((v, k) => v + h1.side[k] * 0.05 * s);
    add(`thumb${tag}`, { type: 'capsule', size: [r4(0.011 * s)], fromto: [...thumb0, ...thumb1].map(r4) });
  }
  {
    const head = limbs.head;
    add('headSkin', { type: 'mesh', size: [1, 1, 1], role: 'visual', ...limbLoft(limbSections(head, 0.006), [1, 0, 0], { start: head.startCap, end: head.endCap }) });
  }

  if (m.legs) {
    for (const side of [1, -1] as const) {
      const tag = side > 0 ? 'L' : 'R';
      const limb = limbs[side > 0 ? 'legL' : 'legR'], path = limb.path;
      add(`leg${tag}`, { type: 'mesh', size: [1, 1, 1], role: 'visual', ...limbLoft(limbSections(limb), [1, 0, 0]) });
      const hip = path.at(0), knee = path.at(path.jointAt * 0.55), ankle = path.at(path.jointAt), toe = path.at(limb.length - 0.02 * s);
      add(`thigh${tag}`, { type: 'capsule', role: 'collision', size: [r4(limb.section(0).w * 0.8)], fromto: [...hip, ...knee].map(r4) });
      add(`calf${tag}`, { type: 'capsule', role: 'collision', size: [r4(limb.section(path.jointAt * 0.7).w * 0.7)], fromto: [...knee, ...ankle].map(r4) });
      add(`sole${tag}`, { type: 'capsule', role: 'collision', size: [r4(0.025 * s)], fromto: [...ankle, ...toe].map(r4) });
    }
  } else {
    // A dress form's stand.
    add('pole', { type: 'cylinder', size: [0.015, r4((P.crotchZ + 0.03 * s) / 2)], pos: [0, 0, r4((P.crotchZ + 0.03 * s) / 2)] });
    add('base', { type: 'cylinder', size: [0.22, 0.015], pos: [0, 0, 0.015] });
  }
  return geoms;
}

/** Points round the torso at each row: this many, at even angles round its own centre. */
export const TORSO_ANGLES = 72;
/** One row of the torso's surface: radius at each even angle round (0, centreY), at height z. */
export interface TorsoRow { z: number; centreY: number; radii: number[] }


/**
 * The torso's surface as rows: at each height the convex hull of the parts'
 * cross-sections (what a tape round the body traces), as radii at even angles
 * round its centre, then evened out up each column (the hull of each section
 * is smooth round the body but not up it, and followed every slice's bulge).
 */
function torsoRows(parts: SceneGeom[], z0: number, z1: number, torso: ReturnType<typeof torsoProfile>): TorsoRow[] {
  const ANG = TORSO_ANGLES, ROWS = Math.max(8, Math.round((z1 - z0) / 0.012));
  const rows: TorsoRow[] = [];
  for (let r = 0; r <= ROWS; r++) {
    const z = z0 + ((z1 - z0) * r) / ROWS;
    const pts: [number, number][] = [];
    const e = torso(z);
    if (e) for (let i = 0; i < 64; i++) { const th = (2 * Math.PI * i) / 64; pts.push([e.a * Math.cos(th), e.cy + e.b * Math.sin(th)]); }
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
    const radii: number[] = [];
    for (let i = 0; i < ANG; i++) {
      const th = (2 * Math.PI * i) / ANG, dx = Math.cos(th), dy = Math.sin(th);
      let best = 0;
      for (let k = 0; k < hull.length; k++) {
        const [x1, y1] = hull[k], [x2, y2] = hull[(k + 1) % hull.length];
        // The ray (0, cy) + t (dx, dy) against this edge.
        const ex = x2 - x1, ey = y2 - y1, den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-12) continue;
        const t = (x1 * ey - (y1 - cy) * ex) / den, u = (x1 * dy - (y1 - cy) * dx) / den;
        if (t > 0 && u >= -1e-9 && u <= 1 + 1e-9) best = Math.max(best, t);
      }
      radii.push(best);
    }
    rows.push({ z, centreY: cy, radii });
  }
  // A running mean up each column, twice, over about +-4 cm.
  const W = 3;
  for (let pass = 0; pass < 2; pass++) {
    const copy = rows.map((r) => ({ ...r, radii: r.radii.slice() }));
    for (let r = 1; r + 1 < rows.length; r++) {
      let cy = 0, n = 0;
      const sum = new Array(ANG).fill(0);
      for (let q = Math.max(0, r - W); q <= Math.min(rows.length - 1, r + W); q++) {
        cy += copy[q].centreY; n++;
        for (let i = 0; i < ANG; i++) sum[i] += copy[q].radii[i];
      }
      rows[r].centreY = cy / n;
      rows[r].radii = sum.map((x) => x / n);
    }
  }
  // Tuck the top rim of the neck skin slightly inside the base of headSkin so its flat cap never shows.
  if (rows.length >= 3) {
    rows[rows.length - 2].radii = rows[rows.length - 2].radii.map((r) => r * 0.97);
    rows[rows.length - 1].radii = rows[rows.length - 1].radii.map((r) => r * 0.91);
  }
  return rows;
}

/** A row's points, MuJoCo Z-up. */
const rowPoints = (row: TorsoRow) => row.radii.map((r, i) => {
  const th = (2 * Math.PI * i) / row.radii.length;
  return [r * Math.cos(th), row.centreY + r * Math.sin(th), row.z];
});

/**
 * Rows lofted into a closed mesh, MuJoCo Z-up points converted to Three.js
 * Y-up (x, z, -y) as mesh geoms take them; wound outward (CLAUDE.md, face
 * winding): counter-clockwise round z then up, and the caps facing down and up.
 */
function loft(rows: TorsoRow[]): { vertices: number[]; faces: number[] } {
  const ANG = rows[0].radii.length;
  const vertices: number[] = [];
  const push = (p: number[]) => { vertices.push(p[0], p[2], -p[1]); return vertices.length / 3 - 1; };
  const idx = rows.map((row) => rowPoints(row).map(push));
  const faces: number[] = [];
  for (let r = 0; r + 1 < idx.length; r++) {
    for (let i = 0; i < ANG; i++) {
      const a = idx[r][i], b = idx[r][(i + 1) % ANG], c = idx[r + 1][(i + 1) % ANG], d = idx[r + 1][i];
      faces.push(a, b, c, a, c, d);
    }
  }
  const capAt = (row: TorsoRow) => push([0, row.centreY, row.z]);
  const bottom = capAt(rows[0]), top = capAt(rows[rows.length - 1]);
  for (let i = 0; i < ANG; i++) {
    faces.push(bottom, idx[0][(i + 1) % ANG], idx[0][i]);
    faces.push(top, idx[idx.length - 1][i], idx[idx.length - 1][(i + 1) % ANG]);
  }
  return { vertices, faces };
}

/** The torso's surface, drawn only. */
function torsoSkin(rows: TorsoRow[], name: string, rgba: number[]): SceneGeom {
  return { name, type: 'mesh', size: [1, 1, 1], role: 'visual', rgba, ...loft(rows) } as SceneGeom;
}

/**
 * The same surface as convex slabs about 4 cm tall, collision only. Each is
 * the loft between two rows, both convex, so MuJoCo's hull of it is the slab
 * itself, and the slabs together are the surface that is drawn.
 */
function torsoSlabs(rows: TorsoRow[], prefix: string): SceneGeom[] {
  const every = Math.max(1, Math.round(0.04 / Math.max(1e-3, rows[1].z - rows[0].z)));
  const picks: number[] = [];
  for (let r = 0; r < rows.length; r += every) picks.push(r);
  if (picks[picks.length - 1] !== rows.length - 1) picks.push(rows.length - 1);
  const out: SceneGeom[] = [];
  for (let k = 0; k + 1 < picks.length; k++) {
    out.push({ name: `${prefix}${k}`, type: 'mesh', size: [1, 1, 1], role: 'collision', ...loft([rows[picks[k]], rows[picks[k + 1]]]) } as SceneGeom);
  }
  return out;
}

function convexHull(pts: [number, number][]): [number, number][] {
  const P = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [], upper: [number, number][] = [];
  for (const p of P) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (const p of P.slice().reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

const rowsCache = new Map<string, TorsoRow[]>();
/** The torso's rows for these measurements (cached: garments ask for them often). */
/** The parts the torso's skin is lofted round. */
const torsoParts = (geoms: SceneGeom[]) => geoms.filter((g) => /_(bust\w*|shoulder\w*|deltoid\w*|neck)$/.test(g.name));

/** The section at height z between rows (clamped to the first and last). */
function sectionAt(rows: TorsoRow[], z: number): { centreY: number; radii: number[] } {
  if (z <= rows[0].z) return rows[0];
  for (let i = 1; i < rows.length; i++) {
    if (z <= rows[i].z) {
      const a = rows[i - 1], b = rows[i], t = (z - a.z) / (b.z - a.z || 1);
      return { centreY: a.centreY + (b.centreY - a.centreY) * t, radii: a.radii.map((r, k) => r + (b.radii[k] - r) * t) };
    }
  }
  return rows[rows.length - 1];
}

function formRows(m: BodyFormMeasurements): TorsoRow[] {
  const key = JSON.stringify(m);
  let rows = rowsCache.get(key);
  if (!rows) {
    const P = proportions(m);
    rows = torsoRows(torsoParts(bodyFormGeomsRaw(m, 'form')), P.crotchZ - 0.005 * P.s, NECK_TOP * m.height, torsoProfile(m, formTapes(m)));
    if (rowsCache.size > 16) rowsCache.clear();
    rowsCache.set(key, rows);
  }
  return rows;
}

/**
 * The torso's surface at height z, as a girth placement takes it (radii at
 * even angles round a centre). Below the hips it stays the hips' (a skirt
 * hangs from them); above the top of the shoulders, the top row.
 */
export function bodyFormSection(m: BodyFormMeasurements, z: number): { centreY: number; radii: number[] } {
  return sectionAt(formRows(m), Math.max(z, bodyLandmarks(m).hipZ));
}

/** The section every `step` metres from `z0` up to `z1`, as a girth placement's profile (v measured from `zRef`). */
export function bodyFormProfile(m: BodyFormMeasurements, z0: number, z1: number, zRef: number, step = 0.02) {
  const out: { v: number; centreY: number; radii: number[] }[] = [];
  for (let z = z0; z <= z1 + 1e-9; z += step) out.push({ v: z - zRef, ...bodyFormSection(m, z) });
  return out;
}
