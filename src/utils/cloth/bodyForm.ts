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
import { ellipseHalfWidth, formHeightMeasurements, KNEE_MAX, proportions } from './formProportions';
import { neckAxisY } from './formHead';

export { ellipseHalfWidth } from './formProportions';
import { formLimbs, HAND_LENGTH, limbSections, type FormLimb } from './formLimbs';
import { torsoRelief } from './formMuscles';
import type { LimbPath } from './limbPath';
import type { BodyFigure, BodyFormMeasurements } from '../../types/cloth';
import type { SceneGeom } from '../../types/scene';

/** Neutral studio-plaster colour when `skinTone` is unset. */
export const DEFAULT_MANNEQUIN_RGBA: [number, number, number, number] = [0.93, 0.89, 0.82, 1];

/**
 * Curated human-complexion stops along `[0, 1]`, following a physiological
 * melanin + hemoglobin/undertone curve across deep espresso, reddish mahogany,
 * warm umber, sienna, golden bronze, terracotta, warm olive, honey, peach and
 * rosy porcelain rather than a dead linear grey-brown ramp.
 */
export const SKIN_TONE_STOPS: { at: number; label: string; rgb: [number, number, number] }[] = [
  { at: 0.00, label: 'Deep ebony', rgb: [0.15, 0.10, 0.09] },
  { at: 0.09, label: 'Espresso', rgb: [0.23, 0.14, 0.11] },
  { at: 0.18, label: 'Mahogany', rgb: [0.33, 0.18, 0.13] },
  { at: 0.28, label: 'Warm umber', rgb: [0.44, 0.27, 0.18] },
  { at: 0.38, label: 'Sienna', rgb: [0.54, 0.33, 0.22] },
  { at: 0.48, label: 'Golden bronze', rgb: [0.62, 0.42, 0.27] },
  { at: 0.57, label: 'Terracotta', rgb: [0.69, 0.46, 0.34] },
  { at: 0.66, label: 'Warm olive', rgb: [0.75, 0.58, 0.43] },
  { at: 0.75, label: 'Golden honey', rgb: [0.83, 0.65, 0.51] },
  { at: 0.84, label: 'Warm peach', rgb: [0.88, 0.68, 0.58] },
  { at: 0.92, label: 'Rosy fair', rgb: [0.93, 0.75, 0.69] },
  { at: 1.00, label: 'Porcelain rose', rgb: [0.96, 0.83, 0.79] },
];

const srgbToLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linToSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * Math.max(0, c) : 1.055 * Math.max(0, c) ** (1 / 2.4) - 0.055);

function rgbToOklab([r, g, b]: [number, number, number]): [number, number, number] {
  const lr = srgbToLin(r), lg = srgbToLin(g), lb = srgbToLin(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

function oklabToRgb([L, a, B]: [number, number, number]): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * B;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * B;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * B;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  const lr = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  const clamp01 = (v: number) => +Math.min(1, Math.max(0, v)).toFixed(4);
  return [clamp01(linToSrgb(lr)), clamp01(linToSrgb(lg)), clamp01(linToSrgb(lb))];
}

const OKLAB_STOPS = SKIN_TONE_STOPS.map((s) => ({ ...s, lab: rgbToOklab(s.rgb) }));

/** Evaluates `skinTone` (`0..1`) in perceptual Oklab space; `undefined` returns neutral studio plaster. */
export function skinToneRgba(skinTone?: number | null): [number, number, number, number] {
  if (skinTone === undefined || skinTone === null || !Number.isFinite(skinTone)) return [...DEFAULT_MANNEQUIN_RGBA];
  const t = Math.min(1, Math.max(0, skinTone));
  for (let i = 1; i < OKLAB_STOPS.length; i++) {
    const a = OKLAB_STOPS[i - 1], b = OKLAB_STOPS[i];
    if (t <= b.at + 1e-9) {
      const u = Math.min(1, Math.max(0, (t - a.at) / Math.max(1e-9, b.at - a.at)));
      const lab: [number, number, number] = [
        a.lab[0] + (b.lab[0] - a.lab[0]) * u,
        a.lab[1] + (b.lab[1] - a.lab[1]) * u,
        a.lab[2] + (b.lab[2] - a.lab[2]) * u,
      ];
      return [...oklabToRgb(lab), 1];
    }
  }
  return [...SKIN_TONE_STOPS[SKIN_TONE_STOPS.length - 1].rgb, 1];
}

/** Human-readable name for the nearest stop along `skinTone` (`"Studio plaster"` when unset). */
export function skinToneLabel(skinTone?: number | null): string {
  if (skinTone === undefined || skinTone === null || !Number.isFinite(skinTone)) return 'Studio plaster';
  const t = Math.min(1, Math.max(0, skinTone));
  let best = SKIN_TONE_STOPS[0];
  for (const s of SKIN_TONE_STOPS) if (Math.abs(s.at - t) < Math.abs(best.at - t)) best = s;
  return best.label;
}

/** CSS `linear-gradient` spanning all curated human skin-tone stops for the inspector slider track. */
export const SKIN_TONE_CSS_GRADIENT = `linear-gradient(to right, ${SKIN_TONE_STOPS.map((s) => {
  const hex = s.rgb.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  return `#${hex} ${Math.round(s.at * 100)}%`;
}).join(', ')})`;

/** A typical figure of each kind: what a new form starts from. */
export const FIGURE_DEFAULTS: Record<BodyFigure, BodyFormMeasurements> = {
  male: {
    figure: 'male', height: 1.78, chest: 1.0, underbust: 0.92, waist: 0.86, hip: 0.98, neck: 0.39,
    shoulderWidth: 0.46, armLength: 0.55, upperArm: 0.31, armAngle: 45, elbowBend: 80, stance: 0, kneeBend: 0,
  },
  female: {
    figure: 'female', height: 1.68, chest: 0.92, underbust: 0.78, waist: 0.72, hip: 0.98, neck: 0.33,
    shoulderWidth: 0.39, armLength: 0.505, upperArm: 0.27, armAngle: 45, elbowBend: 80, stance: 0, kneeBend: 0,
  },
};

export const DEFAULT_BODY_FORM: BodyFormMeasurements = FIGURE_DEFAULTS.male;

/** The measurements a form may leave unset, to be the usual proportion for its height. */
export type OptionalBodyMeasurement = 'inseam' | 'rise' | 'waistToHip' | 'backLength' | 'shoulderToBust' | 'bustSpan' | 'wrist' | 'thigh' | 'knee' | 'calf' | 'ankle';
const OPTIONAL_MEASUREMENTS: OptionalBodyMeasurement[] = ['inseam', 'rise', 'waistToHip', 'backLength', 'shoulderToBust', 'bustSpan', 'wrist', 'thigh', 'knee', 'calf', 'ankle'];
/** The height measurements, which resolveHeights keeps in order (and may move to). */
const HEIGHT_MEASUREMENTS = ['inseam', 'rise', 'waistToHip', 'backLength', 'shoulderToBust'] as const;

/**
 * Limits the inspector and MCP clamp to, metres (degrees for the pose). The
 * heights are also kept in order against each other and the form's height
 * (formProportions resolveHeights), which can narrow these.
 */
export const BODY_FORM_LIMITS: Record<Exclude<keyof BodyFormMeasurements, 'figure' | 'skinTone'>, [number, number]> = {
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
  stance: [-2, 30],
  kneeBend: [0, KNEE_MAX],
  inseam: [0.4, 1.05],
  rise: [0.15, 0.4],
  waistToHip: [0.1, 0.3],
  backLength: [0.3, 0.6],
  shoulderToBust: [0.15, 0.4],
  bustSpan: [0.12, 0.26],
  wrist: [0.12, 0.25],
  thigh: [0.35, 0.85],
  knee: [0.28, 0.55],
  calf: [0.25, 0.55],
  ankle: [0.17, 0.35],
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
  const optional = new Set<string>(OPTIONAL_MEASUREMENTS);
  for (const [k, [lo, hi]] of Object.entries(BODY_FORM_LIMITS) as [keyof typeof BODY_FORM_LIMITS, [number, number]][]) {
    // An optional measurement not given (or given as null) is left unset: the usual proportion.
    if (optional.has(k) && (out[k] === undefined || out[k] === null || !Number.isFinite(Number(out[k])))) { delete (out as unknown as Record<string, unknown>)[k]; continue; }
    const v = Number(out[k]);
    (out as unknown as Record<string, number>)[k] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : base[k] as number;
  }
  // Optional visual skinTone in [0, 1]; null or non-finite resets back to studio plaster (unset).
  if (out.skinTone === undefined || out.skinTone === null || !Number.isFinite(Number(out.skinTone))) {
    delete out.skinTone;
  } else {
    out.skinTone = +Math.min(1, Math.max(0, Number(out.skinTone))).toFixed(4);
  }
  const s = out.height / 1.75;
  // Anatomical coupling so extreme independent slider combinations cannot invert or self-intersect:
  // underbust stays within a realistic bust projection of chest, shoulders stay outside the upper ribcage,
  // and thighs cannot deeply overlap across the midline.
  out.underbust = Math.min(out.chest, Math.max(BODY_FORM_LIMITS.underbust[0], out.underbust, +(out.chest - 0.32 * s).toFixed(6)));
  const minShoulder = Math.min(BODY_FORM_LIMITS.shoulderWidth[1], +(2 * ellipseHalfWidth(out.chest, 0.7) * 0.75).toFixed(6));
  if (out.shoulderWidth < minShoulder) out.shoulderWidth = minShoulder;
  if (out.thigh !== undefined) {
    const maxThigh = Math.max(BODY_FORM_LIMITS.thigh[0], +(0.75 * out.hip).toFixed(6));
    if (out.thigh > maxThigh) out.thigh = maxThigh;
  }
  // A form always has legs: one saved with them off gets them.
  delete (out as { legs?: unknown }).legs;
  // The heights set, as resolveHeights placed them in order: a set one it had
  // to move is stored where it went, so the form says what it is.
  const placed = formHeightMeasurements(out);
  for (const k of HEIGHT_MEASUREMENTS) {
    const v = out[k];
    if (v !== undefined && Math.abs(placed[k] - v) > 1e-6) out[k] = +placed[k].toFixed(6);
  }
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
  /**
   * How far bent knees and the stance bring the hips down: every height
   * here is as posed, and a leg hung straight from its root (what a trouser
   * leg is cut on) reaches this far below the floor.
   */
  drop: number;
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
  let lo = 0, hi = Math.min(0.18 * s, Math.max(0.15 * s, 0.4 * (chest - m.underbust)));
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (girth(mid) < chest) lo = mid; else hi = mid; }
  const p = (lo + hi) / 2;
  return { prominence: p, centreY: front - p + r.y, radii: r };
}

/** What each tape height is built to: for the bust, the chest the bust is sized to. */
interface Tapes { chest: number; waist: number; hip: number }
const tapesCache = new Map<string, Tapes>();

/** The parts the torso's skin is lofted round — built without lofting arms, legs, or head. */
function bodyFormTorsoParts(m: BodyFormMeasurements, prefix: string, T: Tapes = formTapes(m)): SceneGeom[] {
  const P = proportions(m), L = limbLandmarks(m), s = P.s;
  const rgba = [0.93, 0.89, 0.82, 1];
  const geoms: SceneGeom[] = [];
  const add = (name: string, g: Omit<SceneGeom, 'name' | 'rgba'>) => geoms.push({ name: `${prefix}_${name}`, rgba, ...g } as SceneGeom);
  const bust = bustGeometry(m, T.chest);
  if (bust) {
    for (const side of [1, -1]) {
      add(`bust${side > 0 ? 'L' : 'R'}`, { type: 'ellipsoid', size: [r4(bust.radii.x), r4(bust.radii.y), r4(bust.radii.z)], pos: [r4(side * P.bustSpan / 2), r4(bust.centreY), r4(P.bustZ)] });
    }
  }
  const sx = m.shoulderWidth / 2 - P.shoulderR * 0.6;
  const spZ = P.shoulderZ - P.shoulderDrop;
  for (const side of [1, -1]) {
    const tag = side > 0 ? 'L' : 'R';
    add(`shoulder${tag}`, { type: 'capsule', size: [r4(P.shoulderR)], fromto: [r4(side * L.neckRadius * 0.8), 0, r4(P.shoulderZ), r4(side * sx), 0, r4(spZ)] });
    add(`deltoid${tag}`, { type: 'sphere', size: [r4(P.shoulderR * 1.05)], pos: [r4(side * (sx - 0.01 * s)), 0, r4(spZ - 0.015 * s)] });
  }
  add('neck', { type: 'capsule', size: [r4(L.neckRadius)], fromto: [0, 0, r4(P.shoulderZ - 0.02 * s), 0, r4(-0.012 * s), r4(P.neckTop)] });
  return geoms;
}

const geomCacheKey = (m: BodyFormMeasurements) => {
  const { skinTone: _st, ...geomM } = m;
  void _st;
  return JSON.stringify(geomM);
};

/**
 * What to build chest, waist and hip to so that a tape round the form as
 * built reads the measurements: corrected against the built form's own
 * sections a few times over. A section is a smoothed hull of every part at
 * its height, so built straight from the measurements a female form's waist
 * read 6% over and a male one's hip 3% under.
 */
function formTapes(m: BodyFormMeasurements): Tapes {
  const key = geomCacheKey(m);
  let t = tapesCache.get(key);
  if (t) return t;
  t = { chest: m.chest, waist: m.waist, hip: m.hip };
  const P = proportions(m);
  const clampTape = (v: number, ref: number) => Math.min(ref * 1.5, Math.max(ref * 0.5, v));
  for (let it = 0; it < 5; it++) {
    const rows = torsoRows(m, bodyFormTorsoParts(m, 'form', t), P.crotchZ - 0.005 * P.s, P.neckTop, torsoProfile(m, t), false);
    const read = { chest: sectionGirth(sectionAt(rows, P.bustZ)), waist: sectionGirth(sectionAt(rows, P.waistZ)), hip: sectionGirth(sectionAt(rows, P.hipZ)) };
    if ((Object.keys(read) as (keyof Tapes)[]).every((k) => Math.abs(read[k] / m[k] - 1) < 0.003)) break;
    t = {
      chest: clampTape(t.chest * m.chest / Math.max(1e-3, read.chest), m.chest),
      waist: clampTape(t.waist * m.waist / Math.max(1e-3, read.waist), m.waist),
      hip: clampTape(t.hip * m.hip / Math.max(1e-3, read.hip), m.hip),
    };
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
  const key = geomCacheKey(m);
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
    drop: P.drop,
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
  const rows = prefix === 'form' ? formRows(m) : torsoRows(m, geoms.filter(isTorsoPart), P.crotchZ - 0.005 * P.s, P.neckTop, torsoProfile(m, formTapes(m)));
  const rgba = skinToneRgba(m.skinTone);
  return [...geoms.filter((g) => !isTorsoPart(g)), torsoSkin(rows, `${prefix}_skin`, rgba), ...torsoSlabs(rows, `${prefix}_torso`, rgba)];
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
      [P.hipZ + 0.05 * s, T.hip * 0.95, 0.72, C.hip],
      [P.hipZ, T.hip, 0.74, C.hip],
      [P.hipZ - 0.03 * s, T.hip * 0.985, 0.72, C.seat],
    ]
    : [
      [P.shoulderZ - 0.05 * s, T.chest * 0.96, 0.6, C.upper],
      [P.bustZ, T.chest, 0.68, C.bust],
      [P.waistZ, T.waist, 0.72, C.waist],
      [P.hipZ + 0.05 * s, T.hip * 0.96, 0.71, C.hip],
      [P.hipZ, T.hip, 0.72, C.hip],
      [P.hipZ - 0.03 * s, T.hip * 0.985, 0.7, C.seat],
    ];
  const top = keys[0][0], bottom = keys[keys.length - 1][0], cap = 0.08 * s;
  const crotchBottom = P.crotchZ - 0.012 * s;
  const ellipse = (c: number, k: number, cy: number, f = 1) => { const a = ellipseHalfWidth(c, k) * f; return { a, b: a * k, cy }; };
  return (z) => {
    if (z > top) { const t = (z - top) / cap; return t >= 1 ? null : ellipse(keys[0][1], keys[0][2], keys[0][3], Math.sqrt(1 - t * t)); }
    if (z < bottom) {
      if (z <= crotchBottom) return null;
      const l = keys[keys.length - 1], base = ellipse(l[1], l[2], l[3]);
      // Pelvic wedge: narrows gently along the groin creases between the thighs;
      // `loft(..., true)` closes the pelvic floor with a smooth equal-angle dome.
      const u = (bottom - z) / (bottom - crotchBottom);
      const sCurve = u * u * (3 - 2 * u);
      const a = base.a * (1 - sCurve) + 0.042 * s * sCurve;
      const b = base.b * (1 - 0.34 * sCurve);
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
  const s = P.s;
  const rgba = skinToneRgba(m.skinTone);
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
  add('neck', { type: 'capsule', size: [r4(L.neckRadius)], fromto: [0, 0, r4(P.shoulderZ - 0.02 * s), 0, r4(-0.012 * s), r4(P.neckTop)] });
  add('head', { type: 'ellipsoid', role: 'collision', size: [r4(0.075 * s), r4(0.095 * s), r4(0.115 * s)], pos: [0, r4(-0.015 * s), r4(P.crown - 0.115 * s)] });

  // Arms: one smooth limb each, tapering from the shoulder through the elbow
  // to the wrist and on into a slender hand, palm to the body, with a sculpted thumb.
  const rA = L.armRadius;
  const limbs = formLimbs(m);
  const handL = HAND_LENGTH * s;
  for (const side of [1, -1] as const) {
    const tag = side > 0 ? 'L' : 'R';
    const limb = limbs[side > 0 ? 'armL' : 'armR'], path = limb.path, A = m.armLength;
    add(`arm${tag}`, { type: 'mesh', size: [1, 1, 1], role: 'visual', ...limbLoft(limbSections(limb, 0.008), [0, 1, 0], { end: limb.endCap, capRings: 6 }) });
    const o = path.at(0), elbow = path.at(path.jointAt), wrist = path.at(A), tip = path.at(A + handL);
    add(`upperArm${tag}`, { type: 'capsule', role: 'collision', size: [r4(rA * 0.9)], fromto: [...o, ...elbow].map(r4) });
    add(`forearm${tag}`, { type: 'capsule', role: 'collision', size: [r4(rA * 0.7)], fromto: [...elbow, ...wrist].map(r4) });
    add(`hand${tag}`, { type: 'capsule', role: 'collision', size: [r4(0.013 * s)], fromto: [...wrist, ...tip].map(r4) });
    // Tapered anatomical thumb emerging smoothly from the radial-palmar thenar eminence.
    const thumbStation = (u: number, outOff: number, palmOff: number, w: number, h: number) => {
      const hs = limb.section(A + u * handL);
      const p = hs.c.map((v, k) => v + hs.side[k] * outOff * s - hs.up[k] * palmOff * s);
      return { p, w: w * s, h: h * s, side: hs.side };
    };
    const tSecs = [
      thumbStation(0.08, 0.017, 0.004, 0.0112, 0.0098),
      thumbStation(0.22, 0.029, 0.0058, 0.0098, 0.0086),
      thumbStation(0.37, 0.0385, 0.0062, 0.0082, 0.0074),
      thumbStation(0.51, 0.044, 0.0052, 0.0068, 0.006),
    ];
    add(`thumb${tag}`, { type: 'mesh', size: [1, 1, 1], role: 'visual', ...limbLoft(tSecs, tSecs[0].side, { start: 0.008 * s, end: 0.0085 * s, angles: 24, capRings: 5 }) });
    add(`thumbCol${tag}`, { type: 'capsule', role: 'collision', size: [r4(0.0075 * s)], fromto: [...tSecs[0].p, ...tSecs[tSecs.length - 1].p].map(r4) });
  }
  {
    const head = limbs.head;
    add('headSkin', { type: 'mesh', size: [1, 1, 1], role: 'visual', ...limbLoft(limbSections(head, 0.004), [1, 0, 0], { start: head.startCap, end: head.endCap, partialEnd: true, angles: 96 }) });
  }

  for (const side of [1, -1] as const) {
    const tag = side > 0 ? 'L' : 'R';
    const limb = limbs[side > 0 ? 'legL' : 'legR'], path = limb.path;
    add(`leg${tag}`, { type: 'mesh', size: [1, 1, 1], role: 'visual', ...limbLoft(limbSections(limb, 0.008), [1, 0, 0], { start: limb.startCap, end: limb.endCap, capRings: 6 }) });
    // Thigh and calf meet at a bent knee (hip, knee, ankle); with the knee straight, a little below it.
    const kneeAt = path.joints.length > 2 ? path.joints[path.joints.length - 2].at : path.jointAt * 0.55;
    const hip = path.at(0), knee = path.at(kneeAt), ankle = path.at(path.jointAt), toe = path.at(limb.length - 0.02 * s);
    add(`thigh${tag}`, { type: 'capsule', role: 'collision', size: [r4(limb.section(0).w * 0.8)], fromto: [...hip, ...knee].map(r4) });
    add(`calf${tag}`, { type: 'capsule', role: 'collision', size: [r4(limb.section(path.jointAt * 0.7).w * 0.7)], fromto: [...knee, ...ankle].map(r4) });
    add(`sole${tag}`, { type: 'capsule', role: 'collision', size: [r4(0.022 * s)], fromto: [...ankle, ...toe].map(r4) });
  }
  return geoms;
}

/** Points round the torso at each row: this many, at even angles round its own centre. */
export const TORSO_ANGLES = 144;
/** One row of the torso's surface: radius at each even angle round (0, centreY), at height z. */
export interface TorsoRow { z: number; centreY: number; radii: number[] }


/**
 * The torso's surface as rows: at each height the convex hull of the parts'
 * cross-sections (what a tape round the body traces), as radii at even angles
 * round its centre, then evened out up each column (the hull of each section
 * is smooth round the body but not up it, and followed every slice's bulge).
 */
function torsoRows(m: BodyFormMeasurements, parts: SceneGeom[], z0: number, z1: number, torso: ReturnType<typeof torsoProfile>, withHead = true, ang = TORSO_ANGLES, rowStep = 0.012): TorsoRow[] {
  const ANG = ang, ROWS = Math.max(8, Math.round((z1 - z0) / rowStep));
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
  // A running mean up each column, twice, over about +-4 cm (including row 0 so the pelvic bottom has no unsmoothed step).
  const W = 3;
  for (let pass = 0; pass < 2; pass++) {
    const copy = rows.map((r) => ({ ...r, radii: r.radii.slice() }));
    for (let r = 0; r + 1 < rows.length; r++) {
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
  const P = proportions(m), S = P.s;
  // The muscles, on the smoothed shape: applied before blending limb roots so
  // gluteal/abdominal relief cannot push the bottom of the pelvis back outside
  // the upper thighs.
  const marks = { bustZ: P.bustZ / S, shoulderZ: P.shoulderZ / S, waistZ: P.waistZ / S, hipZ: P.hipZ / S, crotchZ: P.crotchZ / S };
  for (const row of rows) {
    row.radii = row.radii.map((r, i) => {
      const th = (2 * Math.PI * i) / ANG, c = Math.cos(th), sn = Math.sin(th);
      const front = Math.min(1, Math.max(0, -sn / 0.45)), back = Math.min(1, Math.max(0, sn / 0.45));
      return r + torsoRelief(m.figure, (r * c) / S, row.z / S, front, back, marks) * S;
    });
  }
  blendLimbRoots(m, rows, P, withHead);
  // Smooth the pelvic/inguinal contours azimuthally and vertically below hipZ
  // (and lightly in the armpit) so the groin-to-thigh saddle has zero sharp creases
  // while bustZ, waistZ and hipZ tape circumferences stay exact.
  {
    for (let pass = 0; pass < 4; pass++) {
      for (const row of rows) {
        if (row.z >= P.hipZ - 0.004 * S) continue;
        const w = Math.min(1, (P.hipZ - 0.004 * S - row.z) / (0.022 * S));
        const src = row.radii.slice();
        for (let i = 0; i < ANG; i++) {
          const avg = (
            src[(i - 2 + ANG) % ANG] +
            4 * src[(i - 1 + ANG) % ANG] +
            6 * src[i] +
            4 * src[(i + 1) % ANG] +
            src[(i + 2) % ANG]
          ) / 16;
          row.radii[i] = src[i] * (1 - w) + avg * w;
        }
      }
    }
    for (let pass = 0; pass < 2; pass++) {
      const snap = rows.map((r) => r.radii.slice());
      for (let r = 0; r + 1 < rows.length; r++) {
        const z = rows[r].z;
        const inHip = z < P.hipZ - 0.006 * S ? Math.min(1, (P.hipZ - 0.006 * S - z) / (0.02 * S)) : 0;
        const inPit = z > P.shoulderZ - P.shoulderDrop - 0.04 * S && z < P.shoulderZ + 0.04 * S
          ? Math.sin(Math.PI * (z - (P.shoulderZ - P.shoulderDrop - 0.04 * S)) / Math.max(1e-3, P.shoulderDrop + 0.08 * S))
          : 0;
        const w = 0.65 * Math.max(inHip, inPit);
        if (w <= 0) continue;
        const lo = Math.max(0, r - 1), hi = Math.min(rows.length - 1, r + 1);
        rows[r].radii = snap[r].map((v, i) => v * (1 - w) + 0.25 * (snap[lo][i] + 2 * v + snap[hi][i]) * w);
      }
    }
  }
  // Above the shoulders the skin is the neck: evened out with them it ran up
  // wider, and stood as a collar round the head's own neck. Tucked inside that,
  // so the join never shows.
  const neckR = m.neck / (2 * Math.PI);
  for (const row of rows) {
    const t = Math.min(1, Math.max(0, (row.z - (P.shoulderZ - 0.012 * S)) / (0.075 * S))), k = t * t * (3 - 2 * t);
    const up = Math.min(1, Math.max(0, (row.z - (P.shoulderZ + 0.02 * S)) / (P.neckTop - (P.shoulderZ + 0.02 * S))));
    if (k > 0) row.radii = row.radii.map((r) => r + (Math.min(r, neckR * (1.03 - 0.14 * up)) - r) * k);
    if (k > 0) row.centreY += (neckAxisY(row.z, P.crown, S) - row.centreY) * k;
  }
  return rows;
}

/**
 * Ray from `(0, 0)` at angle `th` against the ellipse at `(cx, cy)` with
 * semi-axes `(a, b)`: returns `{ r, chord }` where `chord` (`0` at a grazing
 * tangent hit, `1` through the ellipse's centre) weights limb-root blends to `0`
 * at tangency so grazing rays never jump discontinuously.
 */
function rayEllipseHit(th: number, cx: number, cy: number, a: number, b: number): { r: number; chord: number } {
  const dx = Math.cos(th) / a, dy = Math.sin(th) / b, ox = -cx / a, oy = -cy / b;
  const A = dx * dx + dy * dy, B = ox * dx + oy * dy, C = ox * ox + oy * oy - 1, D = B * B - A * C;
  if (D <= 0) return { r: 0, chord: 0 };
  const r = Math.max(0, (-B + Math.sqrt(D)) / A);
  return r > 0 ? { r, chord: Math.sqrt(Math.max(0, D / A)) } : { r: 0, chord: 0 };
}

/** Find a leg's cross-section at world/form height `z` (accurate across both straight and posed legs). */
function legSectionAtZ(leg: FormLimb, z: number) {
  const zTop = leg.path.at(0)[2];
  if (z > zTop) return null;
  let lo = 0, hi = Math.min(leg.length, 0.35 * leg.length + 0.12);
  for (let it = 0; it < 12; it++) {
    const mid = 0.5 * (lo + hi);
    if (leg.path.at(mid)[2] > z) lo = mid;
    else hi = mid;
  }
  return leg.section(0.5 * (lo + hi));
}

/**
 * Runs the skin smoothly into the tops of the legs and over the shoulder
 * acromion, without overhanging the thighs at the crotch or jutting a shelf
 * into the armpit.
 */
function blendLimbRoots(m: BodyFormMeasurements, rows: TorsoRow[], P: ReturnType<typeof proportions>, withHead = true) {
  const limbs = formLimbs(m, withHead), S = P.s, N = rows[0].radii.length;
  const ease = (t: number) => { const u = Math.min(1, Math.max(0, t)); return u * u * (3 - 2 * u); };
  {
    // Loft smoothly from the hip section at `hipZ` to a cross-section tucked 3.5 mm
    // inside the full (untucked) thighs at `crotchZ`, so the torso skin never dips in
    // early at `hipZ - 2 cm` and never overhangs the legs at `crotchZ`.
    const legs = [limbs.legL, limbs.legR], top = P.hipZ, zLow = rows[0].z;
    const from = sectionAt(rows, top);
    const zRef = P.crotchZ + 0.005 * S;
    const secs = legs.map((leg) => legSectionAtZ(leg, zRef)).filter((q): q is NonNullable<typeof q> => q !== null);
    for (const row of rows) {
      if (row.z >= top || !secs.length) continue;
      const u = Math.min(1, Math.max(0, (top - row.z) / Math.max(1e-4, top - zLow)));
      const t = ease(u);
      const inset = 0.004 * S * ease((u - 0.2) / 0.65);
      row.radii = row.radii.map((r, i) => {
        const th = (2 * Math.PI * i) / N;
        let bestR = 0, bestW = 0;
        for (const sec of secs) {
          const a = sec.w / Math.max(0.55, Math.abs(sec.side[0]));
          const b = sec.h / Math.max(0.55, Math.abs(sec.up[1]));
          const hit = rayEllipseHit(th, sec.c[0], sec.c[1] - row.centreY, a, b);
          const wHit = ease(hit.chord / 0.55);
          if (wHit > bestW || (wHit === bestW && hit.r > bestR)) {
            bestW = wHit;
            bestR = hit.r;
          }
        }
        if (bestW <= 0 || bestR <= 0) return r;
        const lofted = from.radii[i] + (Math.max(0.02 * S, bestR - inset) - from.radii[i]) * t;
        return r + (lofted - r) * bestW;
      });
    }
  }
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
 * When `roundCaps` is true (for `torsoSkin`), closes the pelvic floor and neck
 * top with equal-normal-angle semi-ellipsoid domes instead of flat 90° lids.
 */
function loft(rows: TorsoRow[], roundCaps = false): { vertices: number[]; faces: number[] } {
  const ANG = rows[0].radii.length;
  let allRows = rows;
  let botTipZ = rows[0].z, topTipZ = rows[rows.length - 1].z;
  if (roundCaps && rows.length >= 2) {
    const capDome = (base: TorsoRow, dir: -1 | 1, depth: number, rings: number): TorsoRow[] => {
      const rMax = Math.max(depth, ...base.radii);
      const aspect = Math.min(1, depth / Math.max(1e-6, rMax));
      const out: TorsoRow[] = [];
      for (let c = 1; c <= rings; c++) {
        const psi = (c / (rings + 1)) * (Math.PI / 2);
        const a = aspect < 1 ? Math.atan(aspect * Math.tan(psi)) : psi;
        const k = Math.cos(a), zOff = depth * Math.sin(a);
        out.push({ z: base.z + dir * zOff, centreY: base.centreY, radii: base.radii.map((r) => r * k) });
      }
      return out;
    };
    const span = rows[rows.length - 1].z - rows[0].z;
    const botDepth = 0.032 * span, topDepth = 0.02 * span;
    botTipZ = rows[0].z - botDepth;
    topTipZ = rows[rows.length - 1].z + topDepth;
    allRows = [...capDome(rows[0], -1, botDepth, 7).reverse(), ...rows, ...capDome(rows[rows.length - 1], 1, topDepth, 6)];
  }
  const vertices: number[] = [];
  const push = (p: number[]) => { vertices.push(p[0], p[2], -p[1]); return vertices.length / 3 - 1; };
  const idx = allRows.map((row) => rowPoints(row).map(push));
  const faces: number[] = [];
  for (let r = 0; r + 1 < idx.length; r++) {
    for (let i = 0; i < ANG; i++) {
      const a = idx[r][i], b = idx[r][(i + 1) % ANG], c = idx[r + 1][(i + 1) % ANG], d = idx[r + 1][i];
      faces.push(a, b, c, a, c, d);
    }
  }
  const bottom = push([0, allRows[0].centreY, botTipZ]);
  const top = push([0, allRows[allRows.length - 1].centreY, topTipZ]);
  for (let i = 0; i < ANG; i++) {
    faces.push(bottom, idx[0][(i + 1) % ANG], idx[0][i]);
    faces.push(top, idx[idx.length - 1][i], idx[idx.length - 1][(i + 1) % ANG]);
  }
  return { vertices, faces };
}

/** The torso's surface, drawn only. */
function torsoSkin(rows: TorsoRow[], name: string, rgba: number[]): SceneGeom {
  return { name, type: 'mesh', size: [1, 1, 1], role: 'visual', rgba, ...loft(rows, true) } as SceneGeom;
}

/**
 * The same surface as convex slabs about 4 cm tall, collision only. Each is
 * the loft between two rows, both convex, so MuJoCo's hull of it is the slab
 * itself, and the slabs together are the surface that is drawn.
 */
function torsoSlabs(rows: TorsoRow[], prefix: string, rgba: number[]): SceneGeom[] {
  const every = Math.max(1, Math.round(0.04 / Math.max(1e-3, rows[1].z - rows[0].z)));
  const picks: number[] = [];
  for (let r = 0; r < rows.length; r += every) picks.push(r);
  if (picks[picks.length - 1] !== rows.length - 1) picks.push(rows.length - 1);
  const out: SceneGeom[] = [];
  for (let k = 0; k + 1 < picks.length; k++) {
    out.push({ name: `${prefix}${k}`, type: 'mesh', size: [1, 1, 1], role: 'collision', rgba: [...rgba], ...loft([rows[picks[k]], rows[picks[k + 1]]]) } as SceneGeom);
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
  const key = geomCacheKey(m);
  let rows = rowsCache.get(key);
  if (!rows) {
    const P = proportions(m);
    rows = torsoRows(m, bodyFormTorsoParts(m, 'form'), P.crotchZ - 0.005 * P.s, P.neckTop, torsoProfile(m, formTapes(m)), false);
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
