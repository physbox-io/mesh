/**
 * A body form's limbs, each a line from its root through one joint to its
 * end (limbPath) with a cross-section along it: the arms from the shoulder,
 * turning forward at the elbow, through the wrist into the hand; the legs
 * from the seat, turning forward at the ankle into the foot; the head from
 * the neck up to the crown.
 *
 * What the form draws each limb as (lofted through its sections) and what
 * any garment over a limb is built round (garmentShell): a sleeve, a trouser
 * leg, a sock, a glove or a hood is a span of one of these, the same way.
 *
 * Z-up, metres, in the form's frame; +x is the wearer's left.
 */

import type { BodyFormMeasurements } from '../../types/cloth';
import { ellipseHalfWidth, legTuck, NECK_TOP, proportions } from './formProportions';
import { headField, headRadius } from './formHead';
import { armRelief, legRelief } from './formMuscles';
import { makeLimbPath, type LimbPath } from './limbPath';

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
/** A hand's length past the wrist, at a 1.75 m figure. */
export const HAND_LENGTH = 0.168;

/** Room under a foot for cloth (twice its thickness, and a little), metres. */
const FOOT_ROOM = 0.012;

const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: number[]) => { const l = Math.sqrt(dot(a, a)) || 1; return a.map((v) => v / l); };

const smooth = (t0: number, t1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - t0) / (t1 - t0 || 1)));
  return t * t * (3 - 2 * t);
};

/** Linear through a table of [x, ...values]; clamped at the ends. */
function table(rows: number[][], x: number): number[] {
  if (x <= rows[0][0]) return rows[0].slice(1);
  for (let i = 1; i < rows.length; i++) if (x <= rows[i][0]) {
    const a = rows[i - 1], b = rows[i], t = (x - a[0]) / (b[0] - a[0] || 1);
    return a.slice(1).map((v, k) => v + (b[k + 1] - v) * t);
  }
  return rows[rows.length - 1].slice(1);
}

/** A section square to the line at s: `side` made square to it, `up` the third axis. */
function frame(path: LimbPath, s: number, side: number[], c: number[], w: number, h: number, shape?: (a: number) => [number, number]): LimbSectionAt {
  const t = path.tangent(s);
  const sd = unit(side.map((v, k) => v - t[k] * dot(side, t)));
  return { c, w, h, side: sd, up: cross(t, sd), ...(shape ? { shape } : {}) };
}

function arm(m: BodyFormMeasurements, side: 1 | -1): FormLimb {
  const P = proportions(m), S = P.s;
  const th = (m.armAngle * Math.PI) / 180;
  const rA = m.upperArm / (2 * Math.PI);
  const origin = [side * (m.shoulderWidth / 2 - P.shoulderR * 0.6), 0, P.shoulderZ - P.shoulderDrop - 0.01 * S];
  const path = makeLimbPath(origin, [side * Math.cos(th), 0, -Math.sin(th)], [0, -1, 0], m.armLength * ELBOW_AT, m.armLength, m.elbowBend, 0.07 * S);
  const A = m.armLength;
  // Real proportions (a man's arm about 31, 26, 27 and 17 cm round at the
  // bicep, elbow, forearm and wrist): [distance along, half width, half
  // height]; then the hand, a mitten curling a little toward the body:
  // [past the wrist, curl, half width, half height].
  const E = ELBOW_AT;
  const armRows = [[0, rA * 0.8, rA * 0.8], [0.1 * A, rA * 0.92, rA * 0.92], [0.25 * A, rA * 0.97, rA * 0.97], [(E - 0.09) * A, rA * 0.9, rA * 0.88], [E * A, rA * 0.82, rA * 0.76], [(E + 0.11) * A, rA * 0.84, rA * 0.74], [0.86 * A, rA * 0.66, rA * 0.54], [A, 0.029 * S, 0.0205 * S]];
  const handL = HAND_LENGTH * S;
  const handRows = [[0, 0, 0.029 * S, 0.0205 * S], [0.23 * handL, 0, 0.042 * S, 0.022 * S], [0.5 * handL, 0.004 * S, 0.045 * S, 0.019 * S], [0.75 * handL, 0.012 * S, 0.042 * S, 0.014 * S], [handL, 0.026 * S, 0.034 * S, 0.011 * S]];
  // The palm faces the body; across it lies the hand's width, thumb side to
  // the front and up. Widths elsewhere are square to the elbow's axis (so
  // the sections stay square through the turn), twisting to the hand's.
  const tw = path.tangent(A);
  const toBody = [-side, 0, 0].map((v, k) => v - tw[k] * -side * tw[0]);
  const inward = unit(toBody);
  let across = cross(tw, inward);
  if (-across[1] + across[2] < 0) across = across.map((v) => -v);
  const axis = cross(path.tangent(0), tw);
  const widthAt = (s: number) => {
    const t = path.tangent(s);
    let base = cross(axis, t);
    if (Math.sqrt(dot(base, base)) < 1e-6) base = [0, 1, 0];
    if (dot(base, across) < 0) base = base.map((v) => -v);
    const f = Math.min(1, Math.max(0, (s / A - 0.6) / 0.4));
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
    name: side > 0 ? 'armL' : 'armR', path, length: A + handL,
    section(s) {
      if (s <= A) {
        const [w, h] = table(armRows, s);
        const sec = frame(path, s, widthAt(s), path.at(s), w, h);
        const { fwd, out } = facings(s), u = Math.min(1, Math.max(0, s / A));
        const shape = (ang: number): [number, number] => {
          const ca = Math.cos(ang), sa = Math.sin(ang);
          const d = sec.side.map((v, k) => v * ca + sec.up[k] * sa);
          const r = armRelief(m.figure, u, E, dot(d, fwd), dot(d, out)) * S;
          return [ca * (w + r), sa * (h + r)];
        };
        return { ...sec, shape };
      }
      const [curl, w, h] = table(handRows, s - A);
      return frame(path, s, across, path.at(s).map((v, k) => v + inward[k] * curl), w, h);
    },
  };
}

function leg(m: BodyFormMeasurements, side: 1 | -1): FormLimb {
  const P = proportions(m), S = P.s, H = m.height, female = m.figure === 'female';
  const thighR = (m.hip * (female ? 0.58 : 0.55)) / (2 * Math.PI), calfR = thighR * 0.66;
  const hipHalf = ellipseHalfWidth(m.hip, female ? 0.74 : 0.72);
  const hipDepth = hipHalf * (female ? 0.74 : 0.72);
  // The foot stands a sock's thickness clear of the floor: with its sole on
  // the floor there was no room under it, and cloth there was crushed.
  // The leg's root sits up in the hip, its top section matching the hip's
  // outer contour and front-to-back depth there so the hip flows continuously
  // into the thigh with no cylinder step at the crotch.
  const kneeZ = 0.285 * H, footZ = 0.035 * S + FOOT_ROOM, topZ = P.hipZ - 0.015 * S;
  const xTop = side * hipHalf * 0.5, xAnkle = side * hipHalf * 0.56;
  const top = [xTop, P.centre.hip, topZ], ankle = [xAnkle, 0.01 * S, footZ];
  const down = unit(ankle.map((v, k) => v - top[k]));
  const fwd = unit([0, -1, 0].map((v, k) => v - down[k] * -down[1]));
  const bend = (Math.acos(Math.max(-1, Math.min(1, -down[1]))) * 180) / Math.PI;
  const upper = Math.sqrt(dot(ankle.map((v, k) => v - top[k]), ankle.map((v, k) => v - top[k])));
  const foot = 0.15 * S;
  // Rounded well at the ankle: sharp, the crease over the instep wedged a
  // hem or a sock's top and crushed it.
  const path = makeLimbPath(top, down, fwd, upper, upper + foot, bend, 0.08 * S);
  // Down the leg by height: [height, half width (across), half depth].
  const legRows = [
    [0.035 * S + 0.03 * S, calfR * 0.56, calfR * 0.66],
    [0.05 * H + 0.015 * S, calfR * 0.53, calfR * 0.6],
    [0.05 * H + 0.1 * S, calfR * 0.66, calfR * 0.72],
    [kneeZ - 0.12 * S, calfR * 0.86, calfR * 0.94],
    [kneeZ - 0.035 * S, thighR * 0.6, thighR * 0.6],
    [kneeZ + 0.03 * S, thighR * 0.62, thighR * 0.64],
    [P.crotchZ - (P.crotchZ - kneeZ) * 0.45, thighR * 0.78, thighR * 0.92],
    [P.crotchZ, hipHalf * 0.5, hipDepth * 0.86],
    [topZ, hipHalf * 0.47, hipDepth * 0.72],
  ];
  // Along the foot past the ankle: [distance, half width, half height, how far its centre drops].
  const footRows = [[-0.02 * S, calfR * 0.5, calfR * 0.56, 0], [0.01 * S, 0.034 * S, 0.033 * S, 0], [0.05 * S, 0.04 * S, 0.03 * S, 0.003 * S], [0.1 * S, 0.045 * S, 0.022 * S, 0.01 * S], [foot, 0.035 * S, 0.015 * S, 0.017 * S]];
  const soleZ = FOOT_ROOM + 0.004 * S;
  const yHeel = ankle[1] + calfR * 0.54;
  return {
    name: side > 0 ? 'legL' : 'legR', path, length: upper + foot, startCap: 0.045 * S,
    section(s) {
      const along = s - upper;
      const [w0, h0, drop] = along < -0.02 * S ? [...table(legRows, path.at(s)[2]), 0] : table(footRows, along);
      const p = path.at(s), c = [p[0], p[1], p[2] - drop];
      const tuck = legTuck(p[2], P.crotchZ, S), w = w0 - tuck, h = h0 - tuck;
      // Round the leg: `out` is away from the other leg, `fwd` to the front. Gone by the instep.
      const relief = (ang: number, sec: LimbSectionAt) => {
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const d = sec.side.map((v, k) => v * ca + sec.up[k] * sa);
        return legRelief(m.figure, (p[2] - kneeZ) / S, -d[1], d[0] * side) * S * (1 - smooth(-0.06 * S, -0.02 * S, along));
      };
      if (along < -0.08 * S) {
        const sec = frame(path, s, [1, 0, 0], c, w, h);
        const shape = (ang: number): [number, number] => { const r = relief(ang, sec); return [Math.cos(ang) * (w + r), Math.sin(ang) * (h + r)]; };
        return { ...sec, shape };
      }
      const base = frame(path, s, [1, 0, 0], c, w, h);
      const uy = base.up[1], uz = base.up[2];
      // The 0.08 S ankle fillet rounds the instep (+up), pulling the path
      // inward from the heel corner; on the heel/sole side (-up), reach back
      // to the Achilles line yHeel and down flat to soleZ from heel to toe.
      const toFloor = uz > 0.15 ? (c[2] - soleZ) / uz : Infinity;
      const toAchilles = -uy > 0.15 ? (yHeel - c[1]) / -uy : Infinity;
      // Smooth min (smin) at the back of the heel so the heel pad rounds onto the floor.
      const k = 0.018 * S, d = Math.max(0, k - Math.abs(toFloor - toAchilles)) / k;
      const hBot = Math.max(h, Math.min(toFloor, toAchilles) - 0.25 * k * d * d);
      const shape = (ang: number): [number, number] => {
        const ca = Math.cos(ang), sa = Math.sin(ang), r = relief(ang, base);
        return [ca * (w + r), sa * ((sa < 0 ? hBot : h) + r)];
      };
      return frame(path, s, [1, 0, 0], c, w, h, shape);
    },
  };
}

function head(m: BodyFormMeasurements): FormLimb {
  const P = proportions(m), S = P.s, H = m.height;
  const cTop = 0.076 * S, zc = H - cTop;
  const z0 = NECK_TOP * H - 0.03 * S;
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

/** The form's limbs (cached on its measurements); legs only if it has them. */
export function formLimbs(m: BodyFormMeasurements): Record<LimbName, FormLimb> {
  const key = JSON.stringify(m);
  let hit = cache.get(key);
  if (!hit) {
    hit = { armL: arm(m, 1), armR: arm(m, -1), legL: leg(m, 1), legR: leg(m, -1), head: head(m) };
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
