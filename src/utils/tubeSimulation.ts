// ---------------------------------------------------------------------------
// Tube & Wire, made from what the dialog hands over
// ---------------------------------------------------------------------------
//
// Each tab of Tube & Wire hands over something to make a part from, and none
// of them is the model. This makes the part from each, the way the shop would,
// and measures it where it meets the next part:
//
// - The pipe frame's cut list: every tube cut to its listed length and pushed
//   home in its start hub, against the shoulder the hub puts the pipe stop at.
//   What is left between its far end and the far hub's shoulder is the gap at
//   that joint, short or long; tubes whose ends run into each other inside a
//   hub are a clash.
// - The cope template: the tube end cut along the template's line, wrapped on
//   the outside of the tube and cut square through the wall, and slid along
//   its axis onto the target until it touches. Where the target is, is worked
//   out here by casting rays down the tube onto the target cylinder or plane,
//   not read from the template. The gap that leaves is what the weld has to
//   bridge; the template is right when it is nothing but the wall's bevel.
// - The bend schedule: a wire fed, turned and bent step by step at the bend
//   radius, each bend sprung back by the springback factor from what the
//   schedule says to bend it to, then fitted to the model's path and measured
//   at its corners.

import type {
  PipeFrameBreakdownResult,
  TubeCopeProfile,
  WireBendSchedule,
} from './tubeAndWireExporter';
import { enclosedVolume } from './simulationMesh';
import type { StockTransform } from './reliefCarveExporter';
import type { AddSimulationRequest } from '../hooks/useAddSimulation';

type V3 = [number, number, number];

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => scale(a, 1 / (len(a) || 1));

/** Turn `v` by `angle` about unit `axis` (right hand). */
function turn(v: V3, axis: V3, angle: number): V3 {
  const c = Math.cos(angle), s = Math.sin(angle);
  return add(add(scale(v, c), scale(cross(axis, v), s)), scale(axis, dot(axis, v) * (1 - c)));
}

/** Any unit vector square to unit `d`. */
const across = (d: V3): V3 => norm(cross(d, Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));

export interface TubeSimMesh {
  /** mm, Z up, in the model's frame. */
  positions: Float32Array;
  faces: Uint32Array;
  volumeMm3: number;
}

/** Closed pieces into one mesh, each turned outward by its own volume. */
class Pieces {
  positions: number[] = [];
  faces: number[] = [];
  push(pts: V3[], tris: number[]) {
    const base = this.positions.length / 3;
    const v = enclosedVolume(pts.flat(), tris);
    for (const p of pts) this.positions.push(p[0], p[1], p[2]);
    for (let i = 0; i < tris.length; i += 3) {
      if (v >= 0) this.faces.push(base + tris[i], base + tris[i + 1], base + tris[i + 2]);
      else this.faces.push(base + tris[i], base + tris[i + 2], base + tris[i + 1]);
    }
  }
  mesh(): TubeSimMesh {
    const positions = new Float32Array(this.positions);
    const faces = new Uint32Array(this.faces);
    return { positions, faces, volumeMm3: enclosedVolume(positions, faces) };
  }
}

/**
 * A tube between rings: `outer[k]` and `inner[k]` are the k-th ring's corners
 * round the outside and the inside, the same count each, walked the same way.
 * Its ends are the first and last rings. With no inside it is a solid rod.
 */
function ringTube(outer: V3[][], inner: V3[][] | null): { pts: V3[]; tris: number[] } {
  const n = outer[0].length;
  const rings = outer.length;
  const pts: V3[] = [...outer.flat(), ...(inner ? inner.flat() : [])];
  const o = (k: number, i: number) => k * n + (i % n);
  const q = (k: number, i: number) => rings * n + k * n + (i % n);
  const tris: number[] = [];
  for (let k = 0; k + 1 < rings; k++) {
    for (let i = 0; i < n; i++) {
      tris.push(o(k, i), o(k, i + 1), o(k + 1, i + 1), o(k, i), o(k + 1, i + 1), o(k + 1, i));
      if (inner) tris.push(q(k, i), q(k + 1, i + 1), q(k, i + 1), q(k, i), q(k + 1, i), q(k + 1, i + 1));
    }
  }
  const last = rings - 1;
  if (inner) {
    for (let i = 0; i < n; i++) {
      tris.push(o(0, i), q(0, i), q(0, i + 1), o(0, i), q(0, i + 1), o(0, i + 1));
      tris.push(o(last, i), o(last, i + 1), q(last, i + 1), o(last, i), q(last, i + 1), q(last, i));
    }
  } else {
    // Fans from each end's centre.
    const c0 = pts.length, c1 = pts.length + 1;
    const mid = (ring: V3[]) => scale(ring.reduce((s, p) => add(s, p), [0, 0, 0] as V3), 1 / ring.length);
    pts.push(mid(outer[0]), mid(outer[last]));
    for (let i = 0; i < n; i++) {
      tris.push(c0, o(0, i + 1), o(0, i));
      tris.push(c1, o(last, i), o(last, i + 1));
    }
  }
  return { pts, tris };
}

const ring = (centre: V3, u: V3, v: V3, r: number, n: number, phase = 0): V3[] =>
  Array.from({ length: n }, (_, i) => {
    const a = phase + (i / n) * Math.PI * 2;
    return add(centre, add(scale(u, r * Math.cos(a)), scale(v, r * Math.sin(a))));
  });

/** A straight tube, or a rod when `innerR` is 0, from `start` along unit `dir`. */
function straightTube(pieces: Pieces, start: V3, dir: V3, length: number, outerR: number, innerR: number, n = 32) {
  const u = across(dir), v = cross(dir, u);
  const end = add(start, scale(dir, length));
  const { pts, tris } = ringTube(
    [ring(start, u, v, outerR, n), ring(end, u, v, outerR, n)],
    innerR > 0 ? [ring(start, u, v, innerR, n), ring(end, u, v, innerR, n)] : null
  );
  pieces.push(pts, tris);
}

// ---------------------------------------------------------------------------
// The pipe frame
// ---------------------------------------------------------------------------

export interface PipeJointGap {
  strutId: string;
  name: string;
  /** Far end of the tube to the far hub's shoulder, mm: positive is short, negative is long. */
  gapMm: number;
}

export interface PipeHubClash {
  hubId: string;
  name: string;
  /** How far two tubes' ends run into each other inside the hub, mm. */
  overlapMm: number;
  struts: [string, string];
}

export interface PipeFrameSimulation extends TubeSimMesh {
  tubes: number;
  gaps: PipeJointGap[];
  /** The largest gap at any joint, either way, mm. */
  maxGapMm: number;
  clashes: PipeHubClash[];
}

export function simulatePipeFrame(b: Pick<PipeFrameBreakdownResult, 'pipeSpec' | 'struts' | 'hubs' | 'sticks'>): PipeFrameSimulation {
  const ro = b.pipeSpec.odMm / 2, ri = b.pipeSpec.idMm / 2;
  const hubs = new Map(b.hubs.map((h) => [h.id, h]));
  // What the cut list says to cut for each strut: every piece of it on every stick, end to end.
  const cut = new Map<string, number>();
  for (const stick of b.sticks) {
    for (const c of stick.cuts) cut.set(c.strutId, (cut.get(c.strutId) ?? 0) + c.cutLengthMm);
  }

  const pieces = new Pieces();
  const gaps: PipeJointGap[] = [];
  for (const s of b.struts) {
    const h0 = hubs.get(s.startHubId), h1 = hubs.get(s.endHubId);
    const p0 = h0?.ports.find((p) => p.strutId === s.id), p1 = h1?.ports.find((p) => p.strutId === s.id);
    const length = cut.get(s.id);
    if (!h0 || !h1 || !p0 || !p1 || !length) continue;
    // Pushed home against the start hub's shoulder.
    const start = add(h0.centerMm, scale(p0.dir, p0.shoulderOffsetMm));
    const end = add(start, scale(p0.dir, length));
    const stop = add(h1.centerMm, scale(p1.dir, p1.shoulderOffsetMm));
    // Along the far port, back towards the hub: how far the end is short of its stop.
    gaps.push({ strutId: s.id, name: s.name, gapMm: dot(sub(end, stop), p1.dir) });
    straightTube(pieces, start, p0.dir, length, ro, ri);
  }

  // Two tubes' ends in one hub: the near rims of the end faces, a shoulder
  // out along each port, are clear of each other when the shoulder is at
  // least (OD / 2) / tan(half the angle between them).
  const clashes: PipeHubClash[] = [];
  for (const h of b.hubs) {
    for (let i = 0; i < h.ports.length; i++) {
      for (let j = i + 1; j < h.ports.length; j++) {
        const a = h.ports[i], c = h.ports[j];
        const angle = Math.acos(Math.max(-1, Math.min(1, dot(a.dir, c.dir))));
        if (angle > Math.PI - 1e-6) continue;
        const half = angle / 2;
        // Each end face's near rim, from the hub centre, along the bisector and across it.
        const shoulder = Math.min(a.shoulderOffsetMm, c.shoulderOffsetMm);
        const clear = shoulder * Math.sin(half) - ro * Math.cos(half);
        if (clear < -0.05) clashes.push({ hubId: h.id, name: h.name, overlapMm: -clear * 2, struts: [a.strutId, c.strutId] });
      }
    }
  }

  return {
    ...pieces.mesh(),
    tubes: gaps.length,
    gaps,
    maxGapMm: gaps.reduce((m, g) => Math.max(m, Math.abs(g.gapMm)), 0),
    clashes,
  };
}

// ---------------------------------------------------------------------------
// A coped joint
// ---------------------------------------------------------------------------

export interface CopeSimulation extends TubeSimMesh {
  /** The widest gap the weld has to bridge round the joint, mm: 0 when the template is right. */
  maxGapMm: number;
  /** Across the wall, how much the square cut leaves to grind off for the end to sit flush, mm. */
  bevelMm: number;
}

/**
 * Where a line down the cut tube, at (x, y) across it, first meets the
 * target, as a height along the tube. The cut tube runs along +Z; the target
 * stands at `angleDeg` to it, its axis in the X-Z plane, `offsetMm` off in Y.
 */
function targetHeight(x: number, y: number, p: TubeCopeProfile['spec']): number | null {
  const alpha = (Math.max(10, Math.min(170, p.angleDeg)) * Math.PI) / 180;
  if (p.targetKind === 'plane') {
    // The plane's normal is the target axis turned a right angle in X-Z.
    const n: V3 = [Math.cos(alpha), 0, -Math.sin(alpha)];
    // n · (x, y, z) = 0, solved for z.
    return Math.abs(n[2]) < 1e-9 ? null : -(n[0] * x) / n[2];
  }
  const R = Math.max(1, (p.targetTubeOdMm ?? p.cutTubeOdMm) / 2);
  const a: V3 = [Math.sin(alpha), 0, Math.cos(alpha)];
  // Its axis crosses the tube's at Z0; the tube's axis is `offsetMm` off the
  // target's along +Y, so the target's is that far the other way.
  const c: V3 = [0, -(p.offsetMm ?? 0), 0];
  // |w - (w · a) a|² = R², w = (x, y, z) - c, along +Z from below.
  const o: V3 = [x - c[0], y - c[1], -c[2]];
  const d: V3 = [0, 0, 1];
  const dp = sub(d, scale(a, dot(d, a)));
  const op = sub(o, scale(a, dot(o, a)));
  const A = dot(dp, dp), B = 2 * dot(op, dp), C = dot(op, op) - R * R;
  const disc = B * B - 4 * A * C;
  if (A < 1e-12 || disc < 0) return null;
  // The near side: the smaller root, coming up from below.
  return (-B - Math.sqrt(disc)) / (2 * A);
}

export function simulateCope(profile: TubeCopeProfile, lengthMm?: number): CopeSimulation {
  const spec = profile.spec;
  const ro = Math.max(1, spec.cutTubeOdMm / 2);
  const wall = Math.max(0.1, Math.min(ro - 0.2, spec.cutTubeWallMm));
  const ri = Math.max(0.2, ro - wall);
  const clock = ((spec.clockAngleDeg ?? 0) * Math.PI) / 180;
  // The template's points, one per angle round the tube, without the repeat at 360.
  const pts = profile.points.filter((pt, i) => i === 0 || pt.angleDeg < 360 - 1e-6);
  // Where on the tube each template point lands: wrapped on the outside, its
  // arc from the seam is the angle.
  const at = pts.map((pt) => (pt.arcMm / (Math.PI * 2 * ro)) * Math.PI * 2 + clock);

  // How far each point of the cut end stands below the target, across the wall.
  const radii = Array.from({ length: 13 }, (_, i) => ro - ((ro - ri) * i) / 12);
  const room = at.map((theta, k) => radii.map((r) => {
    const h = targetHeight(r * Math.cos(theta), r * Math.sin(theta), spec);
    return h === null ? Infinity : h - pts[k].cutZMm;
  }));
  // Slid along the axis until the first point touches.
  const slide = Math.min(...room.flat());
  const shift = Number.isFinite(slide) ? slide : 0;
  let maxGapMm = 0, bevelMm = 0;
  room.forEach((wallRoom) => {
    const seated = wallRoom.map((g) => g - shift).filter(Number.isFinite);
    if (!seated.length) return;
    // The wall touches where it comes closest; the rest is what is left to fill.
    maxGapMm = Math.max(maxGapMm, Math.min(...seated));
    bevelMm = Math.max(bevelMm, Math.max(...seated) - Math.min(...seated));
  });

  // The coped tube, its end on the template's line, seated.
  const pieces = new Pieces();
  const length = lengthMm ?? Math.max(60, spec.cutTubeOdMm * 3);
  const floor = Math.min(...pts.map((p) => p.cutZMm)) + shift - length;
  const outer: V3[][] = [[], []], inner: V3[][] = [[], []];
  at.forEach((theta, k) => {
    const top = pts[k].cutZMm + shift;
    const cx = Math.cos(theta), cy = Math.sin(theta);
    outer[0].push([ro * cx, ro * cy, floor]);
    outer[1].push([ro * cx, ro * cy, top]);
    inner[0].push([ri * cx, ri * cy, floor]);
    inner[1].push([ri * cx, ri * cy, top]);
  });
  const tube = ringTube(outer, inner);
  pieces.push(tube.pts, tube.tris);

  // The target, a length of it either side of the joint.
  const alpha = (Math.max(10, Math.min(170, spec.angleDeg)) * Math.PI) / 180;
  const a: V3 = [Math.sin(alpha), 0, Math.cos(alpha)];
  if (spec.targetKind === 'plane') {
    const n: V3 = [Math.cos(alpha), 0, -Math.sin(alpha)];
    const side = Math.max(80, spec.cutTubeOdMm * 4);
    const u = a, v: V3 = [0, 1, 0];
    // A plate on the plane, its thickness the tube's wall, on the far side from the tube.
    const away = n[2] < 0 ? scale(n, -1) : n;
    const t = Math.max(2, wall);
    const corner = (i: number, j: number, k: number): V3 =>
      add(add(scale(u, (i - 0.5) * side), scale(v, (j - 0.5) * side)), scale(away, k * t));
    const box: V3[] = [corner(0, 0, 0), corner(1, 0, 0), corner(1, 1, 0), corner(0, 1, 0), corner(0, 0, 1), corner(1, 0, 1), corner(1, 1, 1), corner(0, 1, 1)];
    pieces.push(box, [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
  } else {
    const R = Math.max(1, (spec.targetTubeOdMm ?? spec.cutTubeOdMm) / 2);
    const span = Math.max(100, R * 6);
    const centre: V3 = [0, -(spec.offsetMm ?? 0), 0];
    straightTube(pieces, add(centre, scale(a, -span / 2)), a, span, R, Math.max(0.5, R - wall), 48);
  }

  return { ...pieces.mesh(), maxGapMm, bevelMm };
}

// ---------------------------------------------------------------------------
// A bent wire
// ---------------------------------------------------------------------------

export interface WireSimulation extends TubeSimMesh {
  /** Fitted to the model's path: how far its corners and ends are from the bent wire's, mm. */
  deviation: { maxMm: number; meanMm: number };
  /** The length of wire bent, mm. */
  lengthMm: number;
  bends: number;
}

/** The closest points of two lines, and their midpoint: a skew pair's best corner. */
function corner(p: V3, d: V3, q: V3, e: V3): V3 | null {
  const w = sub(p, q);
  const a = dot(d, d), b = dot(d, e), c = dot(e, e), dd = dot(d, w), ee = dot(e, w);
  const den = a * c - b * b;
  if (Math.abs(den) < 1e-12) return null;
  const s = (b * ee - c * dd) / den, t = (a * ee - b * dd) / den;
  return scale(add(add(p, scale(d, s)), add(q, scale(e, t))), 0.5);
}

/** The rigid motion taking `from` closest onto `to` (Horn's quaternion, Jacobi). */
function fitPoints(from: V3[], to: V3[]): (p: V3) => V3 {
  const n = from.length;
  const cf = scale(from.reduce((s, p) => add(s, p), [0, 0, 0] as V3), 1 / n);
  const ct = scale(to.reduce((s, p) => add(s, p), [0, 0, 0] as V3), 1 / n);
  const S = new Array(9).fill(0);
  for (let k = 0; k < n; k++) {
    const a = sub(from[k], cf), b = sub(to[k], ct);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) S[i * 3 + j] += a[i] * b[j];
  }
  const [xx, xy, xz, yx, yy, yz, zx, zy, zz] = S;
  const m = [
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ];
  const v = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += m[p][q] * m[p][q];
    if (off < 1e-20) break;
    for (let p = 0; p < 4; p++) {
      for (let q = p + 1; q < 4; q++) {
        if (Math.abs(m[p][q]) < 1e-30) continue;
        const th = (m[q][q] - m[p][p]) / (2 * m[p][q]);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 4; k++) { const a = m[k][p], b = m[k][q]; m[k][p] = c * a - s * b; m[k][q] = s * a + c * b; }
        for (let k = 0; k < 4; k++) { const a = m[p][k], b = m[q][k]; m[p][k] = c * a - s * b; m[q][k] = s * a + c * b; }
        for (let k = 0; k < 4; k++) { const a = v[k][p], b = v[k][q]; v[k][p] = c * a - s * b; v[k][q] = s * a + c * b; }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < 4; i++) if (m[i][i] > m[best][best]) best = i;
  const [w, x, y, z] = [v[0][best], v[1][best], v[2][best], v[3][best]];
  const r = [
    w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z,
  ];
  return (p) => {
    const q = sub(p, cf);
    return add([r[0] * q[0] + r[1] * q[1] + r[2] * q[2], r[3] * q[0] + r[4] * q[1] + r[5] * q[2], r[6] * q[0] + r[7] * q[1] + r[8] * q[2]], ct);
  };
}

export function simulateWire(schedule: WireBendSchedule): WireSimulation {
  const { bendRadiusMm: R, wireDiameterMm, springbackFactor } = schedule.options;
  const sb = springbackFactor > 0 ? springbackFactor : 1;
  // The wire's centreline, sampled: straights as their ends, bends finely.
  const path: V3[] = [[0, 0, 0]];
  // Each straight's start and direction, for the corners.
  const straights: { at: V3; dir: V3 }[] = [];
  let pos: V3 = [0, 0, 0];
  let dir: V3 = [1, 0, 0];
  // The bending plane's normal; the first bend sets which way is which.
  let normal: V3 = [0, 0, 1];
  let lengthMm = 0;
  const feed = (mm: number) => {
    straights.push({ at: pos, dir });
    pos = add(pos, scale(dir, mm));
    lengthMm += mm;
    path.push(pos);
  };
  let bends = 0;
  for (const step of schedule.steps) {
    feed(step.straightFeedMm);
    // Turned in the hands about its own length, then bent as far as the
    // schedule says to bend it, and let go: it springs back.
    normal = turn(normal, dir, (step.rotateAngleDeg * Math.PI) / 180);
    const angle = ((step.overbendAngleDeg / sb) * Math.PI) / 180;
    if (angle <= 1e-9) continue;
    bends++;
    // Round a former of radius R, its centre R to the inside of the bend.
    const inside = cross(normal, dir);
    const centre = add(pos, scale(inside, R));
    const n = Math.max(4, Math.ceil(angle / (Math.PI / 36)));
    const from = sub(pos, centre);
    for (let k = 1; k <= n; k++) path.push(add(centre, turn(from, normal, (angle * k) / n)));
    pos = path[path.length - 1];
    dir = norm(turn(dir, normal, angle));
    lengthMm += R * angle;
  }
  feed(schedule.finalStraightMm);

  // The bent wire's corners: where each straight meets the next, as lines,
  // with its two ends, against the model's path.
  const model = schedule.pointsMm as V3[];
  const mine: V3[] = [straights[0].at];
  for (let i = 0; i + 1 < straights.length; i++) {
    const c = corner(straights[i].at, straights[i].dir, straights[i + 1].at, straights[i + 1].dir);
    mine.push(c ?? straights[i + 1].at);
  }
  mine.push(pos);
  let deviation = { maxMm: 0, meanMm: 0 };
  let place: (p: V3) => V3 = (p) => p;
  if (mine.length === model.length && model.length >= 2) {
    place = fitPoints(mine, model);
    const d = mine.map((p, k) => len(sub(place(p), model[k])));
    deviation = { maxMm: Math.max(...d), meanMm: d.reduce((s, x) => s + x, 0) / d.length };
  }

  // Swept round the centreline.
  const r = Math.max(0.1, wireDiameterMm / 2);
  const pts = path.map(place);
  const rings: V3[][] = [];
  let u: V3 | null = null;
  for (let i = 0; i < pts.length; i++) {
    const t = norm(sub(pts[Math.min(i + 1, pts.length - 1)], pts[Math.max(0, i - 1)]));
    // Carried along without twisting.
    u = u ? norm(sub(u, scale(t, dot(u, t)))) : across(t);
    rings.push(ring(pts[i], u, cross(t, u), r, 16));
  }
  // A straight fed nothing leaves two rings in one place.
  const kept = rings.filter((rg, i) => i === 0 || len(sub(pts[i], pts[i - 1])) > 1e-6);
  const pieces = new Pieces();
  if (kept.length >= 2) {
    const { pts: p, tris } = ringTube(kept, null);
    pieces.push(p, tris);
  }
  return { ...pieces.mesh(), deviation, lengthMm, bends };
}

/** A transform that changes nothing, round what was made: for parts already in the model's millimetres. */
export function meshStockTransform(positions: ArrayLike<number>): StockTransform {
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], positions[i]);
    hi[i % 3] = Math.max(hi[i % 3], positions[i]);
  }
  if (!positions.length) { lo.fill(0); hi.fill(0); }
  return { modelOriginMm: [0, 0, 0], workOriginMm: [0, 0, 0], scale: [1, 1, 1], modelMinMm: lo, modelMaxMm: hi };
}

export type TubeSimulationJob =
  | { frame: PipeFrameBreakdownResult }
  | { cope: TubeCopeProfile }
  | { wire: WireBendSchedule };

const mmText = (v: number) => `${v.toFixed(2)} mm`;

/**
 * Add Simulation for one tab of Tube & Wire, shared by the dialog and the MCP
 * bridge. `transform` is the scene's own place (`sceneStockTransform`): the
 * frame and the wire are made in the model's millimetres, so they lie over it
 * as they are; a cope is made on its own and only ever goes beside.
 */
export function tubeSimulationRequest(
  job: TubeSimulationJob,
  transform: StockTransform
): {
  figures: Record<string, unknown>;
  request: Omit<AddSimulationRequest, 'placement'>;
} {
  if ('frame' in job) {
    const b = job.frame;
    const sim = simulatePipeFrame(b);
    const worst = sim.gaps.reduce<PipeJointGap | null>((w, g) => (!w || Math.abs(g.gapMm) > Math.abs(w.gapMm) ? g : w), null);
    const deepest = sim.clashes.reduce<PipeHubClash | null>((w, c) => (!w || c.overlapMm > w.overlapMm ? c : w), null);
    return {
      figures: {
        job: 'frame',
        tubes: sim.tubes,
        maxGapMm: +sim.maxGapMm.toFixed(3),
        worstJoint: worst ? { strut: worst.name, gapMm: +worst.gapMm.toFixed(3) } : null,
        clashes: sim.clashes.map((c) => ({ hub: c.name, overlapMm: +c.overlapMm.toFixed(2), struts: c.struts })),
      },
      request: {
        mesh: sim,
        transform,
        kind: 'tube',
        label: 'Pipe frame',
        details: [
          `${sim.tubes} lengths of ${b.pipeSpec.label}, cut as listed and pushed home at each start hub`,
          sim.maxGapMm < 0.05
            ? 'Every tube reaches the shoulder of the hub at its far end'
            : `**${worst!.name} ends ${mmText(Math.abs(worst!.gapMm))} ${worst!.gapMm > 0 ? 'short of' : 'past'} its far hub's shoulder**`,
          ...(deepest
            ? [`**${sim.clashes.length} hub${sim.clashes.length === 1 ? '' : 's'} where tubes run into each other**, ${mmText(deepest.overlapMm)} at ${deepest.name}`]
            : []),
          'Hubs not drawn: the dialog adds the printable ones to the scene',
        ],
      },
    };
  }
  if ('cope' in job) {
    const sim = simulateCope(job.cope);
    const s = job.cope.spec;
    const target = s.targetKind === 'plane' ? 'a flat face' : `a ${s.targetTubeOdMm ?? s.cutTubeOdMm} mm tube`;
    return {
      figures: { job: 'cope', maxGapMm: +sim.maxGapMm.toFixed(3), bevelMm: +sim.bevelMm.toFixed(2) },
      request: {
        mesh: sim,
        transform,
        kind: 'tube',
        label: 'Coped joint',
        details: [
          `A ${s.cutTubeOdMm} mm tube cut along the template and seated on ${target} at ${s.angleDeg}°`,
          sim.maxGapMm < 0.05
            ? 'It sits on the target all the way round'
            : `**Leaves up to ${mmText(sim.maxGapMm)} to fill at the joint**`,
          `Cut square through the wall, it leaves ${mmText(sim.bevelMm)} at most to grind for a flush fit`,
        ],
      },
    };
  }
  const sim = simulateWire(job.wire);
  const o = job.wire.options;
  return {
    figures: {
      job: 'wire',
      bends: sim.bends,
      lengthMm: +sim.lengthMm.toFixed(2),
      maxDeviationMm: +sim.deviation.maxMm.toFixed(3),
      meanDeviationMm: +sim.deviation.meanMm.toFixed(3),
    },
    request: {
      mesh: sim,
      transform,
      kind: 'tube',
      label: 'Bent wire',
      details: [
        `${o.wireDiameterMm} mm wire, ${sim.bends} bend${sim.bends === 1 ? '' : 's'} at R${o.bendRadiusMm}, ${mmText(sim.lengthMm)} of it`,
        `Each bend made ×${o.springbackFactor} and sprung back by the same factor: only a test bend says what this wire really does`,
        sim.deviation.maxMm < 0.1
          ? `Its corners are on the model's path to within ${mmText(Math.max(0.01, sim.deviation.maxMm))}`
          : `**Its corners are up to ${mmText(sim.deviation.maxMm)} off the model's path**`,
      ],
    },
  };
}
