/**
 * Collars and lapels, as cloth like any other add-on (garmentAddOns): cut
 * flat, sewn on, and started in the shape they are worn in, so the drape has
 * nothing to fold.
 *
 *  - Lapels: the plan cuts each front along its roll line (`lapelCuts`, a
 *    plane from the break at the opening up to the neckline). The front then
 *    runs on past that line, and past the opening, into the lapel: one
 *    pattern piece with the front, its points along the roll line the front's
 *    own. It starts turned back over the front, each point where it lands
 *    folded across the roll line, and is pressed there (its bends rest as
 *    it starts).
 *  - A collar: a band along the neckline, its neck edge the neckline's own
 *    points (sewn by arc length because it is built on them), standing up
 *    the neck, folded at the roll line and coming down over the stand and
 *    onto the garment. Modelled in 3D like the garment, then flattened: the
 *    pattern piece is whatever that shape cuts flat to. A fall wider than the
 *    stand reaches further from the neck, so its outer edge comes out longer,
 *    as a drafted collar's is.
 */

import type { BodyFormMeasurements, GarmentCollar, GarmentLapels, GarmentPlane } from '../../types/cloth';
import type { BodyLandmarks } from './bodyForm';
import { bodyFormSection } from './bodyForm';
import { meshOutline } from './clothMesh';
import { flattenPanel } from './garmentFlatten';
import { flatTack, nearestTack, type AddOnPiece, type AddOnTack, type HostPanel } from './garmentAddOns';

type V3 = number[];
const sub = (a: V3, b: V3) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const given = <T extends object>(o: T | undefined): Partial<T> => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;

export const LAPEL_DEFAULTS: Required<GarmentLapels> = { break: 0.22, width: 0.075, peak: 0.01, rollAt: 0.8, notch: 0.035, shawl: false };
export const COLLAR_DEFAULTS: Required<Omit<GarmentCollar, 'standFront' | 'material' | 'materialOverrides' | 'rgba'>> = { stand: 0.03, fall: 0.045, point: 0, round: 0, separateStand: false };

/** How far a turned-back or overlying layer stands off the cloth under it: the cloth's thickness and a little. */
const LAYER_OFF = 0.0045;
/** A collar's stand leans in toward the neck at most this much (tan 15 degrees), and stays this far off it past its garment's own room off the body (restOff), metres. */
const STAND_LEAN = 0.27, STAND_CLEAR = 0.003;
/** A lapel's gorge follows the neckline into its roll line, turned at most this far from square to the roll line, radians. */
const GORGE_TURN = Math.PI / 6;
/** How far apart a collar's two ends start where they meet round a closed neckline, metres. */
const END_GAP = 0.001;

/**
 * The cuts that make lapels: each front cut along its roll line, a plane
 * through the break (at the centre front, `break` below the neck point) and
 * the point where the roll line meets the neckline (`rollAt` of the way out
 * to the neck's side), square to the front. What lies between it and the
 * opening is taken off the front here and comes back, turned over, as the
 * lapel. Edges named `roll`.
 */
export function lapelCuts(lapels: GarmentLapels, L: BodyLandmarks, neck: { half: number; front: number }): ({ kind: 'plane'; name: string } & GarmentPlane)[] {
  const o = { ...LAPEL_DEFAULTS, ...given(lapels) };
  const f = Math.min(0.98, Math.max(0.2, o.rollAt));
  const xr = f * neck.half, zr = L.hpsZ - neck.front * Math.sqrt(1 - f * f);
  const zb = Math.min(zr - 0.03, L.hpsZ - o.break);
  const dz = zr - zb;
  // Normal toward the opening (and up): the side cut away. Only up to the
  // neckline at zr (above it, further out, is the shoulder).
  return [1, -1].map((side) => ({
    kind: 'plane' as const, name: 'roll', point: [0, 0, zb], normal: [-side * dz, 0, xr], front: true,
    z: [zb, zr] as [number, number], x: (side > 0 ? [0, 1] : [-1, 0]) as [number, number],
  }));
}

export interface LapelBuilt {
  piece: AddOnPiece;
  /** The gorge: its top edge from the roll line out to where the notch begins (all of it, for a shawl), as local points. A collar's end is sewn along it. */
  gorge: number[];
}

/**
 * The lapels, one on each roll line run (`runs`, shell points). Each is the
 * front's own cloth past the roll line: laid out in the front's flat piece
 * on the far side of the line from it, `width` across at the top, its point
 * `peak` above square, its front edge back down to the break with a little
 * belly; started turned back over the front (each point folded across the
 * line onto the front, a layer off it, held from sinking into it or sliding).
 */
export function lapelPieces(lapels: GarmentLapels, runs: number[][], hostPanels: HostPanel[], wornPanels: HostPanel[], x: number[][], spacing: number): LapelBuilt[] {
  const o = { ...LAPEL_DEFAULTS, ...given(lapels) };
  const out: LapelBuilt[] = [];
  for (const run0 of runs) {
    if (run0.length < 3) continue;
    const k = wornPanels.findIndex((p) => run0.every((g) => p.particles.includes(g)));
    if (k < 0) continue;
    const worn = wornPanels[k], host = hostPanels[k];
    const local0 = run0.map((g) => worn.particles.indexOf(g));
    // From the break (lowest up the flat piece) to the neckline.
    const flip = worn.uv[local0[0]][1] > worn.uv[local0[local0.length - 1]][1];
    const local = flip ? local0.slice().reverse() : local0;
    const q = local.map((l) => worn.uv[l]);
    // Out of the front: away from the triangles along the line.
    const onRun = new Set(local);
    const inner = [0, 0];
    let nIn = 0;
    for (let t = 0; t < worn.tris.length; t += 3) {
      const tri = [worn.tris[t], worn.tris[t + 1], worn.tris[t + 2]];
      if (!tri.some((i) => onRun.has(i))) continue;
      for (const i of tri) { inner[0] += worn.uv[i][0]; inner[1] += worn.uv[i][1]; nIn++; }
    }
    inner[0] /= nIn; inner[1] /= nIn;
    const q0 = q[0], qe = q[q.length - 1], A = Math.hypot(qe[0] - q0[0], qe[1] - q0[1]);
    const ea = [(qe[0] - q0[0]) / A, (qe[1] - q0[1]) / A];
    let ew = [-ea[1], ea[0]];
    const mid = [(q0[0] + qe[0]) / 2, (q0[1] + qe[1]) / 2];
    if (ew[0] * (mid[0] - inner[0]) + ew[1] * (mid[1] - inner[1]) < 0) ew = [-ew[0], -ew[1]];
    // The top edge along the gorge line: the front's neckline run on past
    // the top of the roll line, as a tailor draws it, so the collar's neck
    // edge goes on from the neckline along the gorge without a corner (at a
    // corner, the fall walked off either side into itself). Out to `width`
    // from the roll line, raised by `peak`. Square to the roll line if the
    // neckline does not come into it from the front's side.
    const rLocal = local[local.length - 1];
    const edgeUse = new Map<string, number>();
    for (let t = 0; t < worn.tris.length; t += 3) for (let e = 0; e < 3; e++) {
      const a = worn.tris[t + e], b = worn.tris[t + ((e + 1) % 3)], key = a < b ? `${a},${b}` : `${b},${a}`;
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
    // The neckline's way into the top of the roll line, taken over a span of
    // it (a third of the lapel's width, along its outline) rather than from
    // its last edge, and turned no further than GORGE_TURN from square to the
    // roll line: a lowered neckline comes into it nearly along it, and run on
    // that way one gorge went 12 cm down the front (its reach out the width
    // over a third of its length) while the other, just under the old
    // threshold, went square; the collar's end down the long one folded
    // through itself.
    const boundary = new Map<number, number[]>();
    for (const [key, count] of edgeUse) {
      if (count !== 1) continue;
      const [a, b] = key.split(',').map(Number);
      boundary.set(a, [...(boundary.get(a) ?? []), b]);
      boundary.set(b, [...(boundary.get(b) ?? []), a]);
    }
    const span = o.width / 3;
    let gorgeDir = ew, bestOut = 0;
    for (const first of boundary.get(rLocal) ?? []) {
      if (onRun.has(first)) continue;
      let prev = rLocal, cur = first, walked = Math.hypot(worn.uv[cur][0] - qe[0], worn.uv[cur][1] - qe[1]);
      while (walked < span) {
        const next = (boundary.get(cur) ?? []).find((c) => c !== prev && !onRun.has(c));
        if (next === undefined) break;
        walked += Math.hypot(worn.uv[next][0] - worn.uv[cur][0], worn.uv[next][1] - worn.uv[cur][1]);
        prev = cur; cur = next;
      }
      const d = [qe[0] - worn.uv[cur][0], qe[1] - worn.uv[cur][1]];
      const out = d[0] * ew[0] + d[1] * ew[1], up = d[0] * ea[0] + d[1] * ea[1], cos = out / (Math.hypot(out, up) || 1);
      if (out <= 0 || cos <= bestOut) continue;
      bestOut = cos;
      const turn = Math.max(-GORGE_TURN, Math.min(GORGE_TURN, Math.atan2(up, out)));
      gorgeDir = [ew[0] * Math.cos(turn) + ea[0] * Math.sin(turn), ew[1] * Math.cos(turn) + ea[1] * Math.sin(turn)];
    }
    const reachOut = o.width / (gorgeDir[0] * ew[0] + gorgeDir[1] * ew[1]);
    // Outline round the piece: up the roll line (the front's own points, a
    // segment each), across the top to the point, back down the front edge.
    const tip: [number, number] = [qe[0] + gorgeDir[0] * reachOut + ea[0] * o.peak, qe[1] + gorgeDir[1] * reachOut + ea[1] * o.peak];
    const belly = Math.min(0.008, 0.08 * o.width);
    const frontEdge: [number, number][] = [];
    for (let i = 0; i <= 8; i++) {
      const s = i / 8, b = belly * 4 * s * (1 - s);
      frontEdge.push([tip[0] + (q0[0] - tip[0]) * s + ew[0] * b, tip[1] + (q0[1] - tip[1]) * s + ew[1] * b]);
    }
    const edges = [
      ...q.slice(0, -1).map((p, i) => ({ id: `roll${i}`, pts: [p as [number, number], q[i + 1] as [number, number]] })),
      { id: 'top', pts: [qe as [number, number], tip] },
      { id: 'front', pts: frontEdge },
    ];
    const counts = Object.fromEntries(q.slice(0, -1).map((_, i) => [`roll${i}`, 1]));
    const m = meshOutline(edges, Math.min(spacing, o.width / 4), counts);
    // Shared with the front along the roll line.
    const shared = q.map((_, i) => ({ local: i < q.length - 1 ? m.edgeVerts[`roll${i}`][0] : m.edgeVerts.top[0], particle: host.particles[local[i]] }));
    const sharedAt = new Map(shared.map((s) => [s.local, s.particle]));
    // Each point folded across the roll line (the nearest of its segments,
    // run on past its ends) onto the front, a layer off it.
    const fold = (u: number[]) => {
      let best = { d: Infinity, r: u };
      for (let i = 0; i + 1 < q.length; i++) {
        const a = q[i], b = q[i + 1], t = [b[0] - a[0], b[1] - a[1]], tl = Math.hypot(t[0], t[1]) || 1;
        let f = ((u[0] - a[0]) * t[0] + (u[1] - a[1]) * t[1]) / (tl * tl);
        if (i > 0) f = Math.max(0, f);
        if (i + 2 < q.length) f = Math.min(1, f);
        const foot = [a[0] + t[0] * f, a[1] + t[1] * f], d = Math.hypot(u[0] - foot[0], u[1] - foot[1]);
        if (d < best.d) best = { d, r: [2 * foot[0] - u[0], 2 * foot[1] - u[1]] };
      }
      return best.r;
    };
    const tacks: AddOnTack[] = [], start: number[][] = [];
    m.uv.forEach((u, i) => {
      const p = sharedAt.get(i);
      if (p !== undefined) { start.push(x[p].slice()); return; }
      const { tack, at: pos } = flatTack(host, fold(u), x, LAYER_OFF, true, i);
      tacks.push(tack);
      start.push(pos);
    });
    const ids = (id: string) => m.edgeVerts[id];
    const outline = edges.flatMap((e) => ids(e.id).slice(0, -1));
    // From the break round its own edges to the top of the roll line: what replaces the roll line in the front's outline.
    const joinPath = [...ids('front').slice().reverse(), ...ids('top').slice(0, -1).reverse()];
    // The gorge: the top edge but its last `notch` (to the point), at least its first segment.
    const top = ids('top'), topLen = Math.hypot(tip[0] - qe[0], tip[1] - qe[1]);
    const gorge = o.shawl ? top : top.filter((l, i) => i < 2 || Math.hypot(m.uv[l][0] - qe[0], m.uv[l][1] - qe[1]) <= topLen - o.notch + 1e-9);
    out.push({
      piece: { name: `lapel${host.name.endsWith('R') ? 'R' : 'L'}`, rgba: [0, 0, 0, 1], uv: m.uv, tris: m.tris, outline, start, tacks, shared, pressed: true, joinPanel: host.name, joinPath },
      gorge,
    });
  }
  return out;
}

/** The form round the neck: its section at a height, memoised (each is a lookup through the torso's rows). */
function neckOf(form: BodyFormMeasurements) {
  const memo = new Map<number, { centreY: number; radii: number[] }>();
  const sec = (z: number) => {
    const key = Math.round(z * 2000);
    let s = memo.get(key);
    if (!s) { s = bodyFormSection(form, key / 2000); memo.set(key, s); }
    return s;
  };
  return {
    centreY: (z: number) => sec(z).centreY,
    /** Radius at angle th (0 at +x, toward +y). */
    radius: (z: number, th: number) => {
      const r = sec(z).radii, n = r.length, f = ((((th / (2 * Math.PI)) % 1) + 1) % 1) * n, i = Math.floor(f), t = f - i;
      return r[i % n] * (1 - t) + r[(i + 1) % n] * t;
    },
  };
}

/** Nearest points on a set of triangles, and the surface's normal there. */
function surfaceOf(points: number[][], tris: number[], normals: number[][]) {
  const cell = 0.03, key = (i: number, j: number, k: number) => ((i + 1024) * 2048 + (j + 1024)) * 2048 + (k + 1024);
  const buckets = new Map<number, number[]>();
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let maxR = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = points[tris[t]], b = points[tris[t + 1]], c = points[tris[t + 2]];
    const cx = (a[0] + b[0] + c[0]) / 3, cy = (a[1] + b[1] + c[1]) / 3, cz = (a[2] + b[2] + c[2]) / 3;
    const r = Math.max(len(sub(a, [cx, cy, cz])), len(sub(b, [cx, cy, cz])), len(sub(c, [cx, cy, cz])));
    if (r > maxR) maxR = r;
    const ci = [Math.floor(cx / cell), Math.floor(cy / cell), Math.floor(cz / cell)];
    for (let q = 0; q < 3; q++) { lo[q] = Math.min(lo[q], ci[q]); hi[q] = Math.max(hi[q], ci[q]); }
    const kk = key(ci[0], ci[1], ci[2]), list = buckets.get(kk);
    if (list) list.push(t); else buckets.set(kk, [t]);
  }
  const margin = maxR + cell * Math.SQRT2;
  return (p: V3): { p: V3; n: V3 } => {
    let best = { d: Infinity, p, n: [0, 0, 1] };
    const test = (t: number) => {
      const a = points[tris[t]], b = points[tris[t + 1]], c = points[tris[t + 2]];
      const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
      const d1 = dot(ab, ap), d2 = dot(ac, ap), d3 = dot(ab, ab), d4 = dot(ab, ac), d5 = dot(ac, ac), den = d3 * d5 - d4 * d4;
      let v = den > 1e-14 ? (d5 * d1 - d4 * d2) / den : 0, w = den > 1e-14 ? (d3 * d2 - d4 * d1) / den : 0;
      v = Math.max(0, Math.min(1, v)); w = Math.max(0, Math.min(1 - v, w));
      const q = add(add(a, ab, v), ac, w), d = len(sub(q, p));
      if (d < best.d) {
        const na = normals[tris[t]], nb = normals[tris[t + 1]], nc = normals[tris[t + 2]];
        best = { d, p: q, n: unit([0, 1, 2].map((k) => na[k] * (1 - v - w) + nb[k] * v + nc[k] * w)) };
      }
    };
    const ci = p.map((v) => Math.floor(v / cell));
    const maxRing = Math.max(Math.abs(lo[0] - ci[0]), Math.abs(hi[0] - ci[0]), Math.abs(lo[1] - ci[1]), Math.abs(hi[1] - ci[1]), Math.abs(lo[2] - ci[2]), Math.abs(hi[2] - ci[2]));
    for (let r = 0; r <= maxRing; r++) {
      // Any centroid at L_infinity ring >= r lies outside [-r+1..r]^3 * cell, so its Euclidean distance
      // to p in cell ci is at least (r - 1) * cell; subtract `margin` for centroid cell rounding + triangle radius.
      if (r > 1 && best.d < (r - 1) * cell - margin) break;
      const k0 = Math.max(-r, lo[2] - ci[2]), k1 = Math.min(r, hi[2] - ci[2]);
      for (let i = Math.max(-r, lo[0] - ci[0]); i <= Math.min(r, hi[0] - ci[0]); i++) {
        for (let j = Math.max(-r, lo[1] - ci[1]); j <= Math.min(r, hi[1] - ci[1]); j++) {
          const side = Math.abs(i) === r || Math.abs(j) === r;
          for (let k = side ? k0 : -r; k <= (side ? k1 : r); k += side || r === 0 ? 1 : 2 * r) {
            if (k < k0 || k > k1) continue;
            for (const t of buckets.get(key(ci[0] + i, ci[1] + j, ci[2] + k)) ?? []) test(t);
          }
        }
      }
    }
    if (!Number.isFinite(best.d)) for (let t = 0; t < tris.length; t += 3) test(t);
    return { p: best.p, n: best.n };
  };
}

export interface CollarContext {
  /** The garment's points as modelled (the form's frame), its triangles, and its outward normals there. */
  points: number[][];
  tris: number[];
  normals: number[][];
  form: BodyFormMeasurements;
  /** The form's frame to the world's and back, as the particles are placed. */
  toWorld: (p: number[]) => number[];
  fromWorld: (p: number[]) => number[];
  /** Particles where they start (world), and the garment's outward normal at a shell point (world). */
  x: number[][];
  worldNormal: (i: number) => number[];
  spacing: number;
  /** The garment's own room off the body for the layer it is worn as (garmentPlan's restOff): its stand keeps it off the neck too, for what is worn under it. */
  room?: number;
  /** Lapels the collar meets: its end is sewn along each one's gorge, and its fall over them stands a layer further off. */
  lapels: LapelBuilt[];
  /** A panel's shell points, by name (which neckline points a shawl's half shares with its front), and where one lies in its flat piece. */
  panelPoints: (name: string) => Set<number>;
  panelUv: (name: string, shellPoint: number) => number[] | undefined;
  /** The garment's colour, the collar's unless it has its own. */
  colour: number[];
}

/** Where a collar column's neck point is: a garment particle, or an earlier add-on's point. */
type NeckRef = { particle?: number; piece?: string; at?: number };
interface NeckPoint { pos: V3; ref: NeckRef; shell?: number; lapel?: LapelBuilt }

/** Least-squares rigid fit of 2D points `a` onto `b` (mirrored first, if `mirror`), as a map. */
function fit2(a: number[][], b: number[][], mirror: boolean): (p: number[]) => number[] {
  const ca = [0, 1].map((k) => a.reduce((s, p) => s + p[k], 0) / a.length), cb = [0, 1].map((k) => b.reduce((s, p) => s + p[k], 0) / b.length);
  const best = [mirror ? -1 : 1].map((m) => {
    let sc = 0, ss = 0;
    a.forEach((p, i) => { const u = [(p[0] - ca[0]) * m, p[1] - ca[1]], v = [b[i][0] - cb[0], b[i][1] - cb[1]]; sc += u[0] * v[0] + u[1] * v[1]; ss += u[0] * v[1] - u[1] * v[0]; });
    const th = Math.atan2(ss, sc), c = Math.cos(th), s = Math.sin(th);
    const map = (p: number[]) => { const u = [(p[0] - ca[0]) * m, p[1] - ca[1]]; return [cb[0] + c * u[0] - s * u[1], cb[1] + s * u[0] + c * u[1]]; };
    return { map, err: a.reduce((e, p, i) => { const q = map(p); return e + (q[0] - b[i][0]) ** 2 + (q[1] - b[i][1]) ** 2; }, 0) };
  })[0];
  return best.map;
}

/**
 * A collar along the neckline `run` (shell points in order; `closed` round
 * a neckline with no opening, cut at the centre front), run on at either end
 * along the gorge of a lapel there: its neck edge is the neckline's points
 * and the gorge's, so it is sewn to both (the gorge seam) by sharing them.
 * Columns at those points; rows up the stand, then over the roll line and
 * down the fall: over the stand a layer off it, then on along the garment's
 * surface away from the neck (away from the lapel, along a gorge). Toward its
 * ends the fall's outer rows reach on past them by `point` (a pointed collar)
 * and are drawn back round the corner by `round` (a Peter Pan collar).
 * Flattened as modelled; started there; pressed so.
 *
 * With `shawl` lapels it is no piece of its own: it narrows along each gorge
 * to the lapel's point, is cut at the centre back into halves sewn together
 * there, and each half is cut in one with its front, as the lapel is.
 */
export function collarPieces(collar: GarmentCollar, run0: number[], closed: boolean, ctx: CollarContext, suffix = '', shawl = false): AddOnPiece[] {
  const o = { ...COLLAR_DEFAULTS, ...(shawl ? { round: 0.6 * (collar.fall ?? COLLAR_DEFAULTS.fall) } : {}), ...given(collar) };
  const hBack = Math.max(0, o.stand), hFront = Math.max(0, o.standFront ?? o.stand), F = Math.max(0, o.fall);
  const hMax = Math.max(hBack, hFront);
  if (run0.length < 3 || hMax + F < 0.005) return [];
  const P0 = ctx.points;
  // Round a closed neckline: open at the front (least y), its two ends at the same point.
  let run = run0;
  if (closed) {
    let i0 = 0;
    run0.forEach((g, i) => { if (P0[g][1] < P0[run0[i0]][1]) i0 = i; });
    run = [...run0.slice(i0), ...run0.slice(0, i0), run0[i0]];
  }
  let neckPts: NeckPoint[] = run.map((g) => ({ pos: P0[g], ref: { particle: g }, shell: g }));
  // On along a lapel's gorge at either end (the lapel whose roll line starts nearest).
  if (!closed) {
    const gorgeAt = (end: V3) => {
      let best: { l: LapelBuilt; d: number } | null = null;
      for (const l of ctx.lapels) { const d = len(sub(ctx.fromWorld(l.piece.start[l.gorge[0]]), end)); if (d < 0.06 && (!best || d < best.d)) best = { l, d }; }
      return best ? best.l.gorge.map((at) => ({ pos: ctx.fromWorld(best!.l.piece.start[at]), ref: { piece: best!.l.piece.name, at }, lapel: best!.l })) : [];
    };
    neckPts = [...gorgeAt(neckPts[0].pos).reverse(), ...neckPts, ...gorgeAt(neckPts[neckPts.length - 1].pos)];
  }
  // Columns at those points, but not at points crowded closer than half the
  // usual spacing (where a cut crossed near a seam, or the neckline's end
  // beside the roll line's): a column there makes slivers the collar strains
  // across. The neck edge still runs through every column's point; the one
  // passed over lies on the seam. A gorge's own points are all kept.
  {
    const seg = neckPts.slice(1).map((q, i) => len(sub(q.pos, neckPts[i].pos))).sort((a, b) => a - b);
    const min = 0.5 * (seg[seg.length >> 1] ?? 0), last = neckPts[neckPts.length - 1];
    const kept = [neckPts[0]];
    for (let i = 1; i < neckPts.length - 1; i++) {
      const q = neckPts[i];
      if (q.lapel || (len(sub(q.pos, kept[kept.length - 1].pos)) >= min && len(sub(q.pos, last.pos)) >= min && !(neckPts[i + 1].lapel && len(sub(q.pos, neckPts[i + 1].pos)) < min))) kept.push(q);
    }
    kept.push(last);
    neckPts = kept;
  }
  const neck = neckOf(ctx.form);
  // Only the garment within the collar's reach of the neckline is looked at.
  const reachOut = hMax + F + 0.04, near: number[] = [];
  for (let t = 0; t < ctx.tris.length; t += 3) {
    const c = [0, 1, 2].map((k) => (P0[ctx.tris[t]][k] + P0[ctx.tris[t + 1]][k] + P0[ctx.tris[t + 2]][k]) / 3);
    if (neckPts.some(({ pos }) => Math.abs(pos[0] - c[0]) < reachOut && Math.abs(pos[1] - c[1]) < reachOut && Math.abs(pos[2] - c[2]) < reachOut)) near.push(ctx.tris[t], ctx.tris[t + 1], ctx.tris[t + 2]);
  }
  const onSurface = surfaceOf(P0, near, ctx.normals);
  const P = neckPts.map((q) => q.pos);
  // Which way is off the neck edge, over the garment: from a neckline point
  // toward the middle of the garment's triangles round it; from a gorge
  // point, as from the neckline's end beside it (the collar's end lies on
  // over the lapel as it lies off the neckline's end: away from the lapel's
  // middle, it ran into the opening and the collar's own neckline part).
  const beside = new Map<number, V3>();
  {
    const onRun = new Set(neckPts.map((q) => q.shell).filter((g): g is number => g !== undefined));
    for (let t = 0; t < near.length; t += 3) {
      const tri = [near[t], near[t + 1], near[t + 2]];
      const c = [0, 1, 2].map((k) => (P0[tri[0]][k] + P0[tri[1]][k] + P0[tri[2]][k]) / 3);
      for (const g of tri) if (onRun.has(g)) beside.set(g, add(beside.get(g) ?? [0, 0, 0], sub(c, P0[g])));
    }
  }
  const offNeck = (i: number): V3 | undefined => {
    let k = i;
    while (neckPts[k] && neckPts[k].shell === undefined) k += i < neckPts.length / 2 ? 1 : -1;
    return neckPts[k]?.shell !== undefined ? beside.get(neckPts[k].shell!) : undefined;
  };
  const n = neckPts.length;
  const arc = [0];
  for (let i = 1; i < n; i++) arc.push(arc[i - 1] + len(sub(P[i], P[i - 1])));
  const total = arc[n - 1];
  // The centre back: where the neckline crosses the middle (x = 0) behind the
  // neck. Half its length round is only that when the run is symmetric, and
  // run on along two lapels' gorges it is not (the seam stood 1.5-4 cm off).
  let cbArc = total / 2;
  {
    let best = Infinity;
    for (let i = 1; i < n; i++) {
      const a = P[i - 1], b = P[i];
      if (a[0] * b[0] > 0 || a[1] + b[1] < 2 * neck.centreY((a[2] + b[2]) / 2)) continue;
      const f = Math.abs(a[0]) / Math.max(1e-12, Math.abs(a[0]) + Math.abs(b[0])), s = arc[i - 1] + f * (arc[i] - arc[i - 1]);
      if (Math.abs(s - total / 2) < best) { best = Math.abs(s - total / 2); cbArc = s; }
    }
  }
  // The run's way at a column, over a fall's length of it: where the run
  // turns sharply (a gorge off the neckline), frames from the next point
  // only fanned the fall's rows through each other on the inside of the
  // turn, as any offset curve past its radius does.
  const SPAN = Math.max(0.01, F);
  const tangent = (i: number) => {
    let j0 = i, j1 = i;
    while (j0 > 0 && arc[i] - arc[j0] < SPAN / 2) j0--;
    while (j1 < n - 1 && arc[j1] - arc[i] < SPAN / 2) j1++;
    return unit(sub(P[Math.max(j1, Math.min(n - 1, i + 1))], P[Math.min(j0, Math.max(0, i - 1))]));
  };
  // Along the gorges (a shawl's), how far from the roll line toward the lapel's point, 0 to 1.
  const gorgeFrac = neckPts.map((q, i) => {
    if (!q.lapel) return 0;
    const g = q.lapel.gorge, r = neckPts.findIndex((c) => c.lapel === q.lapel && c.ref.at === g[0]), e = neckPts.findIndex((c) => c.lapel === q.lapel && c.ref.at === g[g.length - 1]);
    return r >= 0 && e >= 0 && Math.abs(arc[e] - arc[r]) > 1e-9 ? Math.abs(arc[i] - arc[r]) / Math.abs(arc[e] - arc[r]) : 0;
  });
  // A point on the neckline by arc length, run on along its end tangents past its ends (then back onto the garment).
  const alongNeck = (s: number): V3 => {
    if (s <= 0) return onSurface(add(P[0], tangent(0), s)).p;
    if (s >= total) return onSurface(add(P[n - 1], tangent(n - 1), s - total)).p;
    let i = 1;
    while (i < n - 1 && arc[i] < s) i++;
    const f = (s - arc[i - 1]) / Math.max(1e-12, arc[i] - arc[i - 1]);
    return add(P[i - 1], sub(P[i], P[i - 1]), f);
  };
  // Walks `dist` over the garment from `p`, setting off along `d`.
  const walk = (p: V3, d: V3, dist: number): { p: V3; n: V3 } => {
    let cur = onSurface(p), dir = d, left = dist;
    for (let it = 0; it < 400 && left > 1e-6; it++) {
      const step = Math.min(0.005, left);
      const nxt = onSurface(add(cur.p, dir, step));
      const moved = sub(nxt.p, cur.p), l = len(moved);
      if (l < 1e-7) break;
      dir = unit(moved);
      left -= l;
      cur = nxt;
    }
    return cur;
  };

  const nS = hMax > 0 ? Math.max(1, Math.round(hMax / 0.01)) : 0, nF = F > 0 ? Math.max(1, Math.round(F / 0.01)) : 0;
  const rows = nS + nF + 1;
  const Lb = Math.max(0.04, 2 * Math.abs(o.point), 1.5 * o.round);
  const grid: V3[] = [];
  const onGarment: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const p = P[i], t = tangent(i);
    // The stand from the centre back's height to the fronts'; a shawl's
    // whole collar narrowing along each gorge to two fifths at the lapel's
    // point, its corner rounded off there.
    const toFront = Math.min(1, Math.abs(arc[i] - cbArc) / (arc[i] < cbArc ? cbArc : total - cbArc)), ease = toFront * toFront * (3 - 2 * toFront);
    const narrow = shawl ? 1 - 0.6 * gorgeFrac[i] : 1;
    const h = (hBack + (hFront - hBack) * ease) * narrow, Fi = F * narrow;
    const th = Math.atan2(p[1] - neck.centreY(p[2]), p[0]);
    const rhat = [Math.cos(th), Math.sin(th), 0];
    const rP = Math.hypot(p[0], p[1] - neck.centreY(p[2]));
    // Up the neck, leaning in toward it no more than STAND_LEAN, and kept
    // off it. A stand drawn in hard to the neck is a cone whose top is much
    // shorter than its neck edge, and the fall, folded over it, would then
    // have to be shorter still where it comes down: no flat piece does that.
    // (An outer layer's collar stays outside an inner one's: its neckline is.)
    // Kept off the neck by the room its layer leaves, as the rest of the
    // garment is: 7 mm off whatever its layer, a puffer's (worn over a
    // neckerchief, 12 mm off the neck) was modelled inside it and crushed.
    const clear = (ctx.room ?? 0.004) + STAND_CLEAR;
    let top = p.slice();
    if (h > 0) {
      let z1 = p[2] + h;
      for (let it = 0; it < 4; it++) {
        const r1 = Math.max(neck.radius(z1, th) + clear, rP - STAND_LEAN * h), cy = neck.centreY(z1);
        top = [r1 * Math.cos(th), cy + r1 * Math.sin(th), z1];
        const across = Math.hypot(top[0] - p[0], top[1] - p[1]);
        z1 = p[2] + Math.sqrt(Math.max(0.25 * h * h, h * h - across * across));
      }
    }
    const S = sub(top, p);
    const nP = onSurface(p).n;
    let away = unit(cross(nP, t));
    if (dot(away, offNeck(i) ?? sub(rhat, [0, 0, 1])) < 0) away = away.map((v) => -v);
    // Along a sloped gorge (or the neckline corner turning onto it) on a folded
    // collar, perpendicular-to-gorge points uphill onto the shoulder: keep the
    // fall headed slightly downward so it folds below the roll line without
    // turning down into the lapel.
    if (!shawl && h > 0 && F > 0 && away[2] > -0.15) {
      const horiz = Math.max(1e-6, Math.hypot(away[0], away[1]));
      const k = Math.sqrt(1 - 0.15 * 0.15) / horiz;
      const d = [away[0] * k, away[1] * k, -0.15];
      const proj = sub(d, nP.map((v) => v * dot(d, nP)));
      if (len(proj) > 1e-6) away = unit(proj);
    }
    // The stand's outside: the side the fall comes down on, toward where it
    // then lies over the garment. (Taken as away from the neck's axis, it was
    // a guess along a gorge, which runs out from the neck: the stand there
    // faces round the neck, and the fall was folded down its inside, through it.)
    let out = h > 0 ? unit(cross(t, S)) : rhat;
    if (dot(out, h > 0 ? away : rhat) < 0) out = out.map((v) => -v);
    // Toward the nearer end; how much of the corner shaping reaches here.
    const fromEnd = Math.min(arc[i], total - arc[i]), endward = arc[i] < total / 2 ? -1 : 1;
    const reach = Math.max(0, 1 - fromEnd / Lb);
    // The fall's way, as a line from the roll: down over the stand a layer
    // off it, then on over the garment a layer off it. Where the two meet
    // neither runs on past the other (the stand's part stops where it would
    // come nearer the garment than a layer; the garment's starts where it is
    // out past the stand's): else the line doubles back at the turn. Its
    // rows are evenly along the line's own length; spaced by the lengths
    // asked instead, two rows met at the turn a millimetre apart and the
    // drape stretched the cloth between them sevenfold.
    const way: { q: V3; w: number }[] = [{ q: top, w: -1 }];
    if (h > 0) for (let k = 1; k <= 6; k++) {
      const q = add(add(top, S, -k / 6), out, LAYER_OFF), under = onSurface(q);
      if (k > 1 && dot(sub(q, under.p), under.n) < 0.9 * LAYER_OFF) break;
      way.push({ q, w: -1 });
    }
    {
      let cur = onSurface(p), dir = away, walked = 0;
      const push = () => { const q = add(cur.p, cur.n, LAYER_OFF); if (h <= 0 || dot(sub(q, p), out) >= 0.9 * LAYER_OFF) way.push({ q, w: walked }); };
      push();
      for (let it = 0; it < 400 && walked < Fi + 0.01; it++) {
        const nxt = onSurface(add(cur.p, dir, 0.005));
        const moved = sub(nxt.p, cur.p), l = len(moved);
        if (l < 1e-7) break;
        dir = unit(moved); walked += l; cur = nxt;
        push();
      }
    }
    // Where the garment ends before the fall does (the opening), on straight.
    if (way.length > 1) {
      const last = way[way.length - 1], prev = way[way.length - 2], d = unit(sub(last.q, prev.q));
      way.push({ q: add(last.q, d, Fi + 0.01), w: last.w < 0 ? -1 : last.w + Fi + 0.01 });
    }
    const along = [0];
    for (let k = 1; k < way.length; k++) along.push(along[k - 1] + len(sub(way[k].q, way[k - 1].q)));
    for (let j = 0; j < rows; j++) {
      if (j <= nS) { grid.push(nS ? add(p, S, j / nS) : p.slice()); onGarment.push(false); continue; }
      const f = Math.min(along[along.length - 1], (Fi * (j - nS)) / nF);
      let k = 1;
      while (k < along.length - 1 && along[k] < f) k++;
      const u = (f - along[k - 1]) / Math.max(1e-12, along[k] - along[k - 1]);
      const at = add(way[k - 1].q, sub(way[k].q, way[k - 1].q), u);
      if (way[k].w < 0 || way[k - 1].w < 0) { grid.push(at); onGarment.push(false); continue; }
      // On the garment: toward the ends, reaching on past them (`point`) and drawn back round the corner (`round`).
      const beyond = way[k - 1].w + (way[k].w - way[k - 1].w) * u, span = Math.max(1e-6, along[along.length - 1] - along[way.findIndex((e) => e.w >= 0)]);
      const pull = o.round > 0 && f > Fi - o.round ? o.round - Math.sqrt(Math.max(0, o.round * o.round - (f - (Fi - o.round)) ** 2)) : 0;
      const shift = reach * (o.point * Math.min(1, beyond / span) - pull);
      if (Math.abs(shift) > 1e-6) { const hit = walk(alongNeck(arc[i] + endward * shift), away, beyond); grid.push(add(hit.p, hit.n, LAYER_OFF)); } else grid.push(at);
      onGarment.push(true);
    }
  }
  const id = (i: number, j: number) => i * rows + j;
  const colour = collar.rgba ?? ctx.colour;
  const lapelPts = ctx.lapels.flatMap((l) => l.piece.start);
  /**
   * A piece of the collar: columns i0..i1, rows j0..j1, flattened as
   * modelled (its grain up column `grain`), started there, its rows on the
   * garment held from sinking into it. `sharedOf` names its points that are
   * points already.
   */
  const piece = (name: string, i0: number, i1: number, j0: number, j1: number, grain: number, sharedOf: (i: number, j: number) => NeckRef | undefined): AddOnPiece & { loc: (i: number, j: number) => number } => {
    const cols = j1 - j0 + 1;
    const loc = (i: number, j: number) => (i - i0) * cols + (j - j0);
    const pts: V3[] = [];
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) pts.push(grid[id(i, j)]);
    const tris: number[] = [];
    for (let i = i0; i < i1; i++) for (let j = j0; j < j1; j++) {
      const a = loc(i, j), b = loc(i + 1, j);
      tris.push(a, b, b + 1, a, b + 1, a + 1);
    }
    const flat = flattenPanel(name, pts, tris, Array.from({ length: tris.length / 3 }, (_, t) => t), [], 15, [0, 0, 1]);
    const uv: number[][] = new Array(pts.length);
    flat.points.forEach((g, l) => { uv[g] = flat.uv[l]; });
    const up = [uv[loc(grain, j1)][0] - uv[loc(grain, j0)][0], uv[loc(grain, j1)][1] - uv[loc(grain, j0)][1]];
    const ang = Math.PI / 2 - Math.atan2(up[1], up[0]), ca = Math.cos(ang), sa = Math.sin(ang);
    for (let l = 0; l < uv.length; l++) { const [u, v] = uv[l]; uv[l] = [ca * u - sa * v, sa * u + ca * v]; }
    const start = pts.map((q) => ctx.toWorld(q));
    // Round a closed neckline its two ends meet: they start a hair apart
    // (each drawn toward its own next column), not on top of each other,
    // where continuous collision (clothCcd) found them meeting at every look
    // and held the collar round them still. Its neck point stays shared.
    if (closed) for (const [a, b] of [[0, 1], [n - 1, n - 2]]) {
      if (a < i0 || a > i1 || b < i0 || b > i1) continue;
      for (let j = Math.max(j0, 1); j <= j1; j++) {
        const d = sub(start[loc(b, j)], start[loc(a, j)]), l = len(d);
        if (l > 1e-9) start[loc(a, j)] = add(start[loc(a, j)], d, END_GAP / 2 / l);
      }
    }
    const shared: AddOnPiece['shared'] = [];
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const r = sharedOf(i, j); if (r) shared.push({ local: loc(i, j), ...r }); }
    const isShared = new Set(shared.map((q) => q.local));
    const tacks: AddOnTack[] = [];
    for (let i = i0; i <= i1; i++) for (let j = j0 + 1; j <= j1; j++) {
      const l = loc(i, j);
      if (!onGarment[id(i, j)] || isShared.has(l)) continue;
      const w = start[l];
      // Over a lapel, a layer further off.
      const overLapel = lapelPts.some((q) => len(sub(q, w)) < 1.5 * ctx.spacing);
      const { tack, at } = nearestTack(w, ctx.tris, ctx.x, ctx.worldNormal, overLapel ? 2 * LAYER_OFF : LAYER_OFF, true, l);
      if (overLapel || !shawl) start[l] = at;
      tacks.push(tack);
    }
    const m = i1 - i0 + 1;
    const outline = [
      ...Array.from({ length: m }, (_, k) => loc(i0 + k, j0)),
      ...Array.from({ length: cols - 1 }, (_, k) => loc(i1, j0 + k + 1)),
      ...Array.from({ length: m - 1 }, (_, k) => loc(i1 - 1 - k, j1)),
      ...Array.from({ length: cols - 2 }, (_, k) => loc(i0, j1 - 1 - k)),
    ];
    return { name, rgba: colour, ...(collar.material ? { material: collar.material } : {}), ...(collar.materialOverrides ? { materialOverrides: collar.materialOverrides } : {}), uv, tris, outline, start, tacks, shared, pressed: true, strain95: flat.strain95, loc };
  };
  const onNeck = (i: number, j: number) => (j === 0 ? neckPts[i].ref : undefined);
  if (shawl) {
    // Halves either side of the centre back, the right one's centre-back
    // column the left one's points (the seam); each cut in one with the
    // front its gorge is on, laid in that front's pattern where its gorge
    // and neckline points already are.
    let mid = 0;
    for (let i = 0; i < n; i++) if (Math.abs(arc[i] - cbArc) < Math.abs(arc[mid] - cbArc)) mid = i;
    const halves: AddOnPiece[] = [];
    for (const [i0, i1, endCol] of [[0, mid, 0], [mid, n - 1, n - 1]] as const) {
      const lapel = neckPts[endCol].lapel;
      const left = halves[0] as (AddOnPiece & { loc: (i: number, j: number) => number }) | undefined;
      const half = piece(`shawl${suffix}${lapel ? lapel.piece.name.slice(-1) : halves.length ? 'R' : 'L'}`, i0, i1, 0, rows - 1, mid, (i, j) => onNeck(i, j) ?? (left && i === mid ? { piece: left.name, at: left.loc(mid, j) } : undefined));
      if (lapel?.piece.joinPanel) {
        const front = ctx.panelPoints(lapel.piece.joinPanel);
        const inFront = (i: number) => !!neckPts[i].lapel || (neckPts[i].shell !== undefined && front.has(neckPts[i].shell!));
        // Round its own edges from the lapel's point to where its neck edge comes onto the front at the shoulder.
        const dir = endCol === 0 ? 1 : -1;
        let junction = mid;
        while (junction !== endCol && !inFront(junction)) junction -= dir;
        const path = [
          ...Array.from({ length: rows }, (_, j) => half.loc(endCol, j)),
          ...Array.from({ length: Math.abs(mid - endCol) }, (_, k) => half.loc(endCol + dir * (k + 1), rows - 1)),
          ...Array.from({ length: rows - 1 }, (_, j) => half.loc(mid, rows - 2 - j)),
          ...Array.from({ length: Math.abs(mid - junction) }, (_, k) => half.loc(mid - dir * (k + 1), 0)),
        ];
        // Laid in the front's pattern by its gorge: fitted onto the lapel's top edge as the lapel lies there.
        // Laid in the front's pattern where its neck edge's points already are
        // (the gorge, and the neckline up to the shoulder). Mirrored first if
        // its triangles are wound in toward the neck: the front's are wound
        // out, and both lie counter-clockwise flat.
        const onFront = Array.from({ length: n }, (_, i) => i).filter((i) => (dir > 0 ? i <= junction : i >= junction) && inFront(i));
        const frontUv = (i: number): number[] | undefined => {
          const q = neckPts[i];
          if (q.lapel) return q.lapel.piece.uv[q.ref.at!];
          const pn = ctx.panelUv(lapel.piece.joinPanel!, q.shell!);
          return pn;
        };
        const pairs = onFront.map((i) => [half.uv[half.loc(i, 0)], frontUv(i)] as const).filter((pr): pr is readonly [number[], number[]] => !!pr[1]);
        const c = Math.floor((i0 + i1) / 2), ta = half.start[half.loc(c, 0)], tb = half.start[half.loc(c + 1, 0)], tc = half.start[half.loc(c + 1, 1)];
        const wound = cross(sub(tb, ta), sub(tc, ta)), radial = ctx.fromWorld(ta);
        const inward = dot(wound, [radial[0], radial[1] - neck.centreY(radial[2]), 0]) < 0;
        const place = fit2(pairs.map((pr) => pr[0]), pairs.map((pr) => pr[1]), inward);
        half.uv = half.uv.map(place);
        half.joinPanel = lapel.piece.joinPanel;
        half.joinPath = path;
      }
      halves.push(half);
    }
    return halves;
  }
  const grainCol = Math.floor(n / 2);
  if (o.separateStand && nS > 0 && nF > 0) {
    const band = piece(`collarStand${suffix}`, 0, n - 1, 0, nS, grainCol, onNeck);
    const fall = piece(`collar${suffix}`, 0, n - 1, nS, rows - 1, grainCol, (i, j) => (j === nS ? { piece: band.name, at: band.loc(i, nS) } : undefined));
    return [band, fall];
  }
  return [piece(`collar${suffix}`, 0, n - 1, 0, rows - 1, grainCol, onNeck)];
}
