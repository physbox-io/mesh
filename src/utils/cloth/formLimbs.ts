/**
 * A body form's limbs, each a line from its root through its joints to its
 * end (limbPath) with a cross-section along it: the arms from the shoulder,
 * turning forward at the elbow, through the wrist into the hand; the legs
 * from the seat, turning forward at the ankle into the foot (posed, out and
 * forward at the hip and back at a bent knee first: legPose); the head from
 * the neck up to the crown.
 *
 * What the form draws each limb as (lofted through its sections) and what
 * any garment over a limb is built round (garmentShell): a sleeve, a trouser
 * leg, a sock, a glove or a hood is a span of one of these, the same way.
 *
 * Z-up, metres, in the form's frame; +x is the wearer's left.
 */

import type { BodyFormMeasurements } from '../../types/cloth';
import { ellipseHalfWidth, FOOT_ROOM, legPose, legTuck, proportions } from './formProportions';
import { headField, headRadius } from './formHead';
import { armRelief, legRelief } from './formMuscles';
import { makeJointedPath, makeLimbPath, type LimbPath } from './limbPath';

export type LimbName = 'armL' | 'armR' | 'legL' | 'legR' | 'head';
export const LIMB_NAMES: LimbName[] = ['armL', 'armR', 'legL', 'legR', 'head'];

export interface LimbSectionAt {
  /** Centre of the section. */
  c: number[];
  /** Half-width along `side`, and half-height along `up`; `side`, `up` and the line's direction square to each other. */
  w: number;
  h: number;
  side: number[];
  up: number[];
  /** Optional custom contour at angle `a` round the section, returning [along side, along up]. */
  shape?: (a: number) => [number, number];
}

export interface FormLimb {
  name: LimbName;
  path: LimbPath;
  /**
   * A leg's line hung straight from its root, as it stands with the knee
   * locked and the feet under the hips: what a garment over it is cut on
   * (garmentShell). The same object as `path` when it stands so.
   */
  straight?: LimbPath;
  /** Root to end, along the line. */
  length: number;
  /** How far the rounded start reaches before `0`, if not the start section's own size. */
  startCap?: number;
  /** How far the rounded end reaches past `length`, if not the end section's own size. */
  endCap?: number;
  section(s: number): LimbSectionAt;
}

/** Where the elbow falls along the arm: the upper arm is the longer of the two. */
const ELBOW_AT = 0.55;
/** A hand's length past the wrist (before its fingertip cap), at a 1.75 m figure. */
export const HAND_LENGTH = 0.148;

/** The radius a bent knee turns on, at a 1.75 m figure: about the knee's own depth, so the back of it does not fold through itself. */
const KNEE_FILLET = 0.09;
/** The radius the leg turns on at the hip, at a 1.75 m figure: the thigh's root rounds over it into the seat. */
const HIP_FILLET = 0.12;

const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: number[]) => { const l = Math.sqrt(dot(a, a)) || 1; return a.map((v) => v / l); };

const smooth = (t0: number, t1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - t0) / (t1 - t0 || 1)));
  return t * t * (3 - 2 * t);
};

/**
 * Monotone cubic Hermite (Fritsch–Carlson PCHIP) through a sorted table of
 * `[x, ...values]`, clamped flat outside the ends. Exact at every knot and C1
 * continuous with zero overshoot, so lofted limbs have no slope creases at
 * profile knots.
 */
function makeSmoothTable(rows: number[][]): (x: number) => number[] {
  const n = rows.length, cols = rows[0].length - 1;
  const xs = rows.map((r) => r[0]);
  const ys = Array.from({ length: cols }, (_, c) => rows.map((r) => r[c + 1]));
  const ms = ys.map((y) => {
    if (n < 2) return [0];
    const h = Array.from({ length: n - 1 }, (_, k) => Math.max(1e-9, xs[k + 1] - xs[k]));
    const d = h.map((hk, k) => (y[k + 1] - y[k]) / hk);
    if (n === 2) return [d[0], d[0]];
    const m = new Array<number>(n).fill(0);
    for (let k = 1; k < n - 1; k++) {
      if (d[k - 1] * d[k] > 0) {
        const w1 = 2 * h[k] + h[k - 1], w2 = h[k] + 2 * h[k - 1];
        m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k]);
      }
    }
    const endSlope = (h0: number, h1: number, d0: number, d1: number) => {
      let s = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
      if (s * d0 <= 0) return 0;
      if (Math.abs(s) > 3 * Math.abs(d0)) s = 3 * d0;
      return s;
    };
    m[0] = endSlope(h[0], h[1], d[0], d[1]);
    m[n - 1] = endSlope(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
    return m;
  });
  return (x: number) => {
    if (x <= xs[0]) return ys.map((y) => y[0]);
    if (x >= xs[n - 1]) return ys.map((y) => y[n - 1]);
    let k = 0;
    while (k + 2 < n && x > xs[k + 1]) k++;
    const hk = Math.max(1e-9, xs[k + 1] - xs[k]), t = (x - xs[k]) / hk;
    const t2 = t * t, omt = 1 - t, omt2 = omt * omt;
    const h00 = (1 + 2 * t) * omt2, h10 = t * omt2, h01 = t2 * (3 - 2 * t), h11 = t2 * (t - 1);
    return ys.map((y, c) => h00 * y[k] + h10 * hk * ms[c][k] + h01 * y[k + 1] + h11 * hk * ms[c][k + 1]);
  };
}

/** A section square to the line at s: `side` made square to it (with orthogonal fallback), `up` the third axis. */
function frame(path: LimbPath, s: number, side: number[], c: number[], w: number, h: number, shape?: (a: number) => [number, number]): LimbSectionAt {
  const t = path.tangent(s);
  const proj = side.map((v, k) => v - t[k] * dot(side, t));
  const pl = Math.sqrt(dot(proj, proj));
  const fb = Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const sd = pl >= 1e-6 ? proj.map((v) => v / pl) : unit(fb.map((v, k) => v - t[k] * dot(fb, t)));
  return { c, w, h, side: sd, up: cross(t, sd), ...(shape ? { shape } : {}) };
}

/** Perimeter of an ellipse of half-axes a and b (Ramanujan). */
const ellipseGirth = (a: number, b: number) => Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));

/** The wrist's half width and half height at scale S, before a wrist measurement scales them. */
const wristAxes = (S: number) => [0.029 * S, 0.0205 * S];

/** The thigh's and calf's radius from the hip, before girth measurements scale the leg's sections. */
function legRadii(m: BodyFormMeasurements) {
  const thighR = (m.hip * (m.figure === 'female' ? 0.58 : 0.55)) / (2 * Math.PI);
  return { thighR, calfR: thighR * 0.66 };
}

/**
 * The limb girths as the proportions give them: round the section at the
 * thigh, knee, calf, ankle and wrist (an ellipse; the muscles' relief over it
 * adds a few millimetres). A girth measurement scales its section to read it.
 */
export function defaultLimbGirths(m: BodyFormMeasurements) {
  const { thighR, calfR } = legRadii(m), S = m.height / 1.75, [wa, wb] = wristAxes(S);
  return {
    thigh: ellipseGirth(thighR * 0.78, thighR * 0.92),
    knee: ellipseGirth(thighR * 0.6, thighR * 0.6),
    calf: ellipseGirth(calfR * 0.86, calfR * 0.94),
    ankle: ellipseGirth(calfR * 0.53, calfR * 0.6),
    wrist: ellipseGirth(wa, wb),
  };
}

/** How much each girth measurement scales its section: 1 for one not set. */
function girthScales(m: BodyFormMeasurements) {
  const d = defaultLimbGirths(m);
  const f = (v: number | undefined, d0: number) => (v === undefined ? 1 : v / d0);
  return { thigh: f(m.thigh, d.thigh), knee: f(m.knee, d.knee), calf: f(m.calf, d.calf), ankle: f(m.ankle, d.ankle), wrist: f(m.wrist, d.wrist) };
}

function arm(m: BodyFormMeasurements, side: 1 | -1): FormLimb {
  const P = proportions(m), S = P.s;
  const th = (m.armAngle * Math.PI) / 180;
  const rA = m.upperArm / (2 * Math.PI);
  const origin = [side * (m.shoulderWidth / 2 - P.shoulderR * 0.6), 0, P.shoulderZ - P.shoulderDrop - 0.01 * S];
  const path = makeLimbPath(origin, [side * Math.cos(th), 0, -Math.sin(th)], [0, -1, 0], m.armLength * ELBOW_AT, m.armLength, m.elbowBend, 0.08 * S);
  const A = m.armLength;
  // Real proportions (a man's arm about 31, 26, 27 and 17 cm round at the
  // bicep, elbow, forearm and wrist), flowing smoothly through the wrist into
  // a slender, tapered studio-mannequin hand.
  const E = ELBOW_AT;
  // The wrist measurement scales the wrist, and half as much the forearm above it.
  const fw = girthScales(m).wrist, fwa = fw === 1 ? 1 : (1 + fw) / 2, fwh = Math.sqrt(fw), [wa, wb] = wristAxes(S);
  const handL = HAND_LENGTH * S;
  const armHandProfile = makeSmoothTable([
    [0, rA * 0.8, rA * 0.8],
    [0.1 * A, rA * 0.92, rA * 0.92],
    [0.25 * A, rA * 0.97, rA * 0.97],
    [(E - 0.09) * A, rA * 0.9, rA * 0.88],
    [E * A, rA * 0.82, rA * 0.76],
    [(E + 0.11) * A, rA * 0.84, rA * 0.74],
    [0.85 * A, rA * 0.64 * fwa, rA * 0.52 * fwa],
    [A, wa * fw, wb * fw],
    [A + 0.28 * handL, 0.0365 * S * fwh, 0.015 * S * fwh],
    [A + 0.56 * handL, 0.034 * S, 0.0118 * S],
    [A + 0.82 * handL, 0.0275 * S, 0.009 * S],
    [A + handL, 0.0185 * S, 0.0072 * S],
  ]);
  // The palm faces the body; across it lies the hand's width, thumb side to
  // the front and up. Widths elsewhere are square to the elbow's axis (so
  // the sections stay square through the turn), twisting smoothly to the hand's.
  const tw = path.tangent(A);
  const toBody = [-side, 0, 0].map((v, k) => v - tw[k] * -side * tw[0]);
  const inward = unit(toBody);
  let across = cross(tw, inward);
  if (-across[1] + across[2] < 0) across = across.map((v) => -v);
  const axis = cross(path.tangent(0), tw);
  const widthAt = (s: number) => {
    if (s >= A) return across;
    const t = path.tangent(s);
    let base = cross(axis, t);
    if (Math.sqrt(dot(base, base)) < 1e-6) base = [0, 1, 0];
    if (dot(base, across) < 0) base = base.map((v) => -v);
    const f = smooth(0.55 * A, A, s);
    return unit(base.map((v, k) => v * (1 - f) + across[k] * f));
  };
  // Which way a point on the arm faces: into the elbow's crook, and out away from the body.
  const facings = (s: number) => {
    const t = path.tangent(s);
    let fwd = cross(axis, t);
    if (Math.sqrt(dot(fwd, fwd)) < 1e-6) fwd = [0, -1, 0];
    fwd = unit(fwd.map((v, k) => v - t[k] * dot(fwd, t)));
    if (dot(fwd, [0, -1, 0]) + dot(fwd, tw) < 0) fwd = fwd.map((v) => -v);
    return { fwd, out: cross(fwd, t).map((v) => v * side) };
  };
  return {
    name: side > 0 ? 'armL' : 'armR', path, length: A + handL, endCap: 0.014 * S,
    section(s) {
      const [w, h] = armHandProfile(s);
      const uHand = s > A ? Math.min(1, (s - A) / handL) : 0;
      const curl = uHand > 0 ? 0.018 * S * uHand * uHand * (1.4 - 0.4 * uHand) : 0;
      const c = curl > 0 ? path.at(s).map((v, k) => v + inward[k] * curl) : path.at(s);
      const sec = frame(path, s, widthAt(s), c, w, h);
      if (s <= A) {
        const { fwd, out } = facings(s), u = Math.min(1, Math.max(0, s / A));
        const shape = (ang: number): [number, number] => {
          const ca = Math.cos(ang), sa = Math.sin(ang);
          const d = sec.side.map((v, k) => v * ca + sec.up[k] * sa);
          const r = armRelief(m.figure, u, E, dot(d, fwd), dot(d, out)) * S;
          return [ca * (w + r), sa * (h + r)];
        };
        return { ...sec, shape };
      }
      // Subtle anatomical thenar eminence on the radial-palmar side (+side, -up) where the thumb originates.
      const thenarAmp = 0.0042 * S * Math.sin(Math.PI * smooth(0.02, 0.55, uHand));
      const shape = (ang: number): [number, number] => {
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const thn = thenarAmp * Math.max(0, ca) ** 1.6 * Math.max(0, -sa * 0.75 + 0.35);
        return [ca * (w + thn), sa * (h + 0.65 * thn)];
      };
      return { ...sec, shape };
    },
  };
}

function leg(m: BodyFormMeasurements, side: 1 | -1): FormLimb {
  const P = proportions(m), S = P.s, H = m.height, female = m.figure === 'female';
  const { thighR, calfR } = legRadii(m), g = girthScales(m);
  const hipHalf = ellipseHalfWidth(m.hip, female ? 0.74 : 0.72);
  const hipDepth = hipHalf * (female ? 0.74 : 0.72);
  // The leg's root sits up in the hip, its top section matching the hip's
  // outer contour and front-to-back depth there so the hip flows continuously
  // into the thigh with no cylinder step at the crotch; the foot a sock's
  // thickness clear of the floor (legPose). The leg's rows are by height
  // standing straight, the hips not dropped.
  const pose = legPose(m), hipDrop = P.drop, { kneeZ, lz } = pose;
  const mirror = (p: number[]) => [side * p[0], p[1], p[2]];
  const crotchZ = P.crotchZ + hipDrop, topZ = pose.rest.top[2];
  // The leg hung straight from its root where the hips are: what its rows
  // are measured along, and what a garment over it is cut on.
  const top = mirror(pose.rest.top), ankle = mirror(pose.rest.ankle);
  top[2] -= hipDrop; ankle[2] -= hipDrop;
  const down = unit(ankle.map((v, k) => v - top[k]));
  const fwd = unit([0, -1, 0].map((v, k) => v - down[k] * -down[1]));
  const bend = (Math.acos(Math.max(-1, Math.min(1, -down[1]))) * 180) / Math.PI;
  const upper = Math.sqrt(dot(ankle.map((v, k) => v - top[k]), ankle.map((v, k) => v - top[k])));
  const foot = 0.184 * S;
  // Rounded well at the ankle: sharp, the crease over the instep wedged a
  // hem or a sock's top and crushed it.
  const straight = makeLimbPath(top, down, fwd, upper, upper + foot, bend, 0.08 * S);
  // As posed: from the root through the knee, if bent, to the ankle, and
  // forward into the foot, flat on the floor.
  let path = straight;
  if (pose.drop !== 0 || pose.knee) {
    const pTop = mirror(pose.top), pAnkle = mirror(pose.ankle), knee = pose.knee ? mirror(pose.knee) : null;
    const toward = (d: number[], f: number[]) => { const c = dot(d, f); return { forward: unit(f.map((v, k) => v - d[k] * c)), bend: (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI }; };
    // The ankle turns from the shin into the foot, pointing forward. Past a
    // right angle (a shin leaning over the foot) its arc is drawn in so the
    // turn reaches no further than a right angle's would: at the same radius
    // it ran on past the toes, and the foot never came down flat.
    const ankleJoint = (shin: number[]) => {
      const t = toward(shin, [0, -1, 0]);
      return { at: upper, ...t, fillet: 0.08 * S * Math.min(1, 1 / Math.tan((t.bend * Math.PI) / 360)) };
    };
    // Down from the root as it stands, turning at the hip toward the knee (or the ankle).
    const hip = mirror(pose.hip), next = knee ?? pAnkle, d0 = unit(next.map((v, k) => v - hip[k]));
    const joints = [{ at: pose.hipAt, ...toward(down, d0), fillet: HIP_FILLET * S }];
    if (knee) {
      const d1 = unit(pAnkle.map((v, k) => v - knee[k]));
      joints.push({ at: pose.thigh, ...toward(d0, d1), fillet: KNEE_FILLET * S }, ankleJoint(d1));
    } else joints.push(ankleJoint(d0));
    path = makeJointedPath(pTop, down, joints, upper + foot);
  }
  // Down the leg by height: [height, half width (across), half depth].
  // Each girth measurement scales its own row, and the rows between take the mean.
  const mid = (a: number, b: number) => (a === b ? a : (a + b) / 2);
  const legProfile = makeSmoothTable([
    [lz(0.035 * S + 0.025 * S), calfR * 0.50 * g.ankle, calfR * 0.57 * g.ankle],
    [lz(0.05 * H + 0.015 * S), calfR * 0.53 * g.ankle, calfR * 0.6 * g.ankle],
    [lz(0.05 * H + 0.1 * S), calfR * 0.66 * mid(g.ankle, g.calf), calfR * 0.72 * mid(g.ankle, g.calf)],
    [lz(0.285 * H - 0.12 * S), calfR * 0.86 * g.calf, calfR * 0.94 * g.calf],
    [lz(0.285 * H - 0.035 * S), thighR * 0.6 * g.knee, thighR * 0.6 * g.knee],
    [lz(0.285 * H + 0.03 * S), thighR * 0.62 * g.knee, thighR * 0.64 * g.knee],
    [crotchZ - (crotchZ - kneeZ) * 0.45, thighR * 0.78 * g.thigh, thighR * 0.92 * g.thigh],
    [crotchZ, hipHalf * 0.5, hipDepth * 0.85],
    [topZ, hipHalf * 0.49, hipDepth * 0.82],
  ]);
  // Along the foot past the ankle: [distance, half width, half height, how far its centre drops].
  const gAnk = Math.sqrt(g.ankle);
  const footProfile = makeSmoothTable([
    [-0.055 * S, calfR * 0.51 * g.ankle, calfR * 0.58 * g.ankle, 0],
    [-0.01 * S, 0.033 * S * gAnk, 0.031 * S * gAnk, 0.001 * S],
    [0.04 * S, 0.039 * S, 0.0265 * S, 0.005 * S],
    [0.105 * S, 0.0435 * S, 0.019 * S, 0.012 * S],
    [0.148 * S, 0.0375 * S, 0.0135 * S, 0.016 * S],
    [foot, 0.026 * S, 0.0095 * S, 0.0185 * S],
  ]);
  const soleZ = FOOT_ROOM + 0.004 * S;
  const yHeel = ankle[1] + calfR * 0.55 * gAnk;
  return {
    name: side > 0 ? 'legL' : 'legR', path, straight, length: upper + foot, startCap: 0.045 * S, endCap: 0.015 * S,
    section(s) {
      const along = s - upper;
      // Its height standing straight: what the rows and the muscles are placed by.
      const zr = straight.at(s)[2] + hipDrop;
      let w0: number, h0: number, drop: number;
      if (along <= -0.055 * S) {
        [w0, h0] = legProfile(zr);
        drop = 0;
      } else if (along >= 0.015 * S) {
        [w0, h0, drop] = footProfile(along);
      } else {
        const [lw, lh] = legProfile(zr), [fw, fh, fd] = footProfile(along);
        const bf = smooth(-0.055 * S, 0.015 * S, along);
        w0 = lw + (fw - lw) * bf;
        h0 = lh + (fh - lh) * bf;
        drop = fd * bf;
      }
      const p = path.at(s), c = [p[0], p[1], p[2] - drop];
      const tuck = legTuck(p[2], P.crotchZ, S), w = Math.max(0.012 * S, w0 - tuck), h = Math.max(0.009 * S, h0 - tuck);
      // Round the leg: `out` is away from the other leg, `fwd` to the front
      // (as it stands straight, turning with it as posed). Fades cleanly into
      // both the hip root above and the ankle below.
      const straightSec = straight === path ? null : frame(straight, s, [1, 0, 0], c, w, h);
      const hipFade = 1 - smooth(crotchZ - 0.06 * S, crotchZ - 0.008 * S, zr);
      const ankleFade = 1 - smooth(-0.065 * S, -0.02 * S, along);
      const relief = (ang: number, sec: LimbSectionAt) => {
        if (hipFade <= 0 || ankleFade <= 0) return 0;
        const ca = Math.cos(ang), sa = Math.sin(ang), rest = straightSec ?? sec;
        const d = rest.side.map((v, k) => v * ca + rest.up[k] * sa);
        return legRelief(m.figure, (zr - kneeZ) / S, -d[1], d[0] * side) * S * hipFade * ankleFade;
      };
      if (along < -0.08 * S) {
        const sec = frame(path, s, [1, 0, 0], c, w, h);
        const shape = (ang: number): [number, number] => { const r = relief(ang, sec); return [Math.cos(ang) * (w + r), Math.sin(ang) * (h + r)]; };
        return { ...sec, shape };
      }
      const base = frame(path, s, [1, 0, 0], c, w, h);
      // The heel as the leg has it standing straight (posed, it turns with the
      // shin), and never through the floor.
      const ref = straightSec ?? base, floorZ = straightSec ? soleZ - hipDrop : soleZ;
      const rc = straightSec ? (([x, y, z]) => [x, y, z - drop])(straight.at(s)) : c;
      const uy = ref.up[1], uz = ref.up[2];
      // The 0.08 S ankle fillet rounds the instep (+up), pulling the path
      // inward from the heel corner; on the heel/sole side (-up), reach back
      // to the Achilles line yHeel and down flat to soleZ from heel to toe.
      const toFloor = uz > 0.15 ? (rc[2] - floorZ) / uz : Infinity;
      const toAchilles = -uy > 0.15 ? (yHeel - rc[1]) / -uy : Infinity;
      // Generous calcaneal heel-pad rounding (0.048 S) so the back of the heel curves smoothly onto the sole.
      const k = 0.048 * S, d = Math.max(0, k - Math.abs(toFloor - toAchilles)) / k;
      let hBot = Math.max(h, Math.min(toFloor, toAchilles) - 0.25 * k * d * d);
      if (straightSec && base.up[2] > 0.15) hBot = Math.max(h, Math.min(hBot, (c[2] - soleZ) / base.up[2]));
      const shape = (ang: number): [number, number] => {
        const ca = Math.cos(ang), sa = Math.sin(ang), r = relief(ang, base);
        const botBlend = sa < 0 ? (-sa) ** 1.45 : 0;
        const radH = h + (hBot - h) * botBlend;
        return [ca * (w + r), sa * (radH + r)];
      };
      return frame(path, s, [1, 0, 0], c, w, h, shape);
    },
  };
}

function head(m: BodyFormMeasurements): FormLimb {
  const P = proportions(m), S = P.s, H = P.crown;
  const cTop = 0.076 * S, zc = H - cTop;
  const z0 = P.neckTop - 0.03 * S;
  const length = zc + 0.8 * cTop - z0;
  const axisY = -0.012 * S;
  const field = headField(m.figure, m.neck / (2 * Math.PI) / S);
  const path = makeLimbPath([0, axisY, z0], [0, 0, 1], [0, -1, 0], length, length, 0, 0.01);
  // The same heights and angles are asked for again whenever the form is built.
  const memo = new Map<number, Map<number, number>>();
  const radiusAt = (z: number, a: number) => {
    let row = memo.get(z);
    if (!row) memo.set(z, row = new Map());
    let r = row.get(a);
    if (r === undefined) row.set(a, r = headRadius(field, (z - H) / S, a) * S);
    return r;
  };
  return {
    name: 'head', path, length, startCap: 0.035 * S, endCap: 0.2 * cTop,
    section(s) {
      const z = z0 + s;
      const w = radiusAt(z, 0), h = (radiusAt(z, Math.PI / 2) + radiusAt(z, -Math.PI / 2)) / 2;
      const shape = (ang: number): [number, number] => {
        const r = radiusAt(z, ang);
        return [Math.cos(ang) * r, Math.sin(ang) * r];
      };
      return frame(path, s, [1, 0, 0], [0, axisY, z], w, h, shape);
    },
  };
}

const cache = new Map<string, Record<LimbName, FormLimb>>();

/** The form's limbs (cached on its measurements); head is constructed lazily unless requested. */
export function formLimbs(m: BodyFormMeasurements, _withHead = true): Record<LimbName, FormLimb> {
  const { skinTone: _st, ...geomM } = m;
  void _st;
  const key = JSON.stringify(geomM);
  let hit = cache.get(key);
  if (!hit) {
    let headLimb: FormLimb | undefined;
    hit = {
      armL: arm(m, 1),
      armR: arm(m, -1),
      legL: leg(m, 1),
      legR: leg(m, -1),
      get head() {
        headLimb ??= head(m);
        return headLimb;
      },
    } as Record<LimbName, FormLimb>;
    if (cache.size > 16) cache.clear();
    cache.set(key, hit);
  }
  return hit;
}

/** A limb's sections every `step` along it, for lofting. */
export function limbSections(limb: FormLimb, step = 0.015): { p: number[]; w: number; h: number; side: number[]; shape?: (a: number) => [number, number] }[] {
  const out: { p: number[]; w: number; h: number; side: number[]; shape?: (a: number) => [number, number] }[] = [];
  const n = Math.max(2, Math.ceil(limb.length / step));
  for (let i = 0; i <= n; i++) {
    const sec = limb.section((limb.length * i) / n);
    out.push({ p: sec.c, w: sec.w, h: sec.h, side: sec.side, ...(sec.shape ? { shape: sec.shape } : {}) });
  }
  return out;
}
