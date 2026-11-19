/**
 * What is sewn onto a garment once its panels are cut: patch pockets and belt
 * loops, placed on a panel as a pattern marks them (in the panel's own flat
 * coordinates, so anywhere on any panel: a chest, a trouser leg, a sleeve),
 * and a belt round it along one of its lines or at a height. Each is cloth of
 * its own, meshed flat, its points tacked to the garment's triangles under
 * them: sewn edges held there, the rest free to lift off but not to slide.
 * Tacks pull both ways, so a belt drawn tight takes the garment in.
 */

import type { ClothMaterial, ClothMaterialName, ClothPatternPrint, GarmentBelt, GarmentPocket, GarmentTrim } from '../../types/cloth';
import { meshOutline } from './clothMesh';

/** A panel of the garment as the add-ons see it: flat, by particle. */
export interface HostPanel {
  name: string;
  uv: number[][];
  /** Triangles, local. */
  tris: number[];
  /** Local point to particle. */
  particles: number[];
  /** Outward unit normal at a local point. */
  normal: (local: number) => number[];
}

export interface AddOnTack {
  /** Local point of the add-on. */
  local: number;
  /** The garment triangle under it, by particle, wound so its normal faces out; where on it. */
  tri: [number, number, number];
  bary: [number, number, number];
  /** Off the triangle along its normal, metres. */
  offset: number;
  /** Free to lift further off (held from sliding, and from sinking under `offset`). */
  lift: boolean;
  /**
   * On an add-on made before this one (by name), not on the garment: `tri`
   * is then that piece's local points (a belt over a pocket rests on the
   * pocket, and draws it in with the cloth under it).
   */
  onPiece?: string;
}

export interface AddOnPiece {
  name: string;
  rgba: number[];
  material?: ClothMaterialName;
  uv: number[][];
  tris: number[];
  outline: number[];
  /** Where each point starts, as the garment's particles are given. */
  start: number[][];
  tacks: AddOnTack[];
  /** Relaxed length over the length it starts at: a belt drawn in. */
  shrink?: number;
  /** Points sewn to a garment particle where they start (a button stand's edge to its front's). */
  stitches?: { local: number; particle: number; /** Closed over the sew time from where they start, not at once. */ sew?: boolean }[];
  trims?: { trim: GarmentTrim; local: number }[];
  /** Its fabric's properties changed from its material's. */
  materialOverrides?: Partial<ClothMaterial>;
  /** Starts lifted off the garment, to fall onto it before it is first drawn. */
  drop?: boolean;
  /** Printed on it, its own print (not the garment's). */
  pattern?: ClothPatternPrint;
  /** Its points sewn to another piece's (by name, its point `at`) over the sew time: pieces sewn together. */
  joinTo?: { local: number; piece: string; at: number }[];
  /** Its own points sewn together over the sew time (a fold sewn shut). */
  selfStitches?: [number, number][];
  /**
   * Points that are particles already, not new ones: a garment particle
   * (`particle`), or point `at` of an add-on made before this one (`piece`).
   * The cloth runs on through them, folded there as it starts (a lapel off
   * its front's roll line, a collar off the neckline).
   */
  shared?: { local: number; particle?: number; piece?: string; at?: number }[];
  /** Bends rest as it starts, not flat: pressed, or interfaced (a collar's roll, a lapel turned back). */
  pressed?: boolean;
  /** Its rest shape where not flat (GarmentAttachment.bend): a point per uv, metres, in its own frame. */
  rest3?: number[][];
  /**
   * Cut in one with this panel: `uv` is in the panel's flat frame, and
   * `joinPath` (from its first shared point round its own edges to its last)
   * takes the place of the stretch of the panel's outline between them.
   */
  joinPanel?: string;
  joinPath?: number[];
  /** How far it had to stretch to lie flat (cut from a modelled shape). */
  strain95?: number;
}

type V3 = number[];
const sub = (a: V3, b: V3) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: V3) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** A point in a panel's flat layout: the triangle it is in (or nearest), and where. */
function locateFlat(panel: HostPanel, q: number[]): { t: number; bary: [number, number, number]; inside: boolean } {
  let best = { t: 0, bary: [1, 0, 0] as [number, number, number], inside: false }, bestOut = Infinity;
  for (let t = 0; t < panel.tris.length; t += 3) {
    const a = panel.uv[panel.tris[t]], b = panel.uv[panel.tris[t + 1]], c = panel.uv[panel.tris[t + 2]];
    const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(d) < 1e-14) continue;
    const l0 = ((b[1] - c[1]) * (q[0] - c[0]) + (c[0] - b[0]) * (q[1] - c[1])) / d;
    const l1 = ((c[1] - a[1]) * (q[0] - c[0]) + (a[0] - c[0]) * (q[1] - c[1])) / d;
    const l2 = 1 - l0 - l1;
    const out = Math.max(0, -l0) + Math.max(0, -l1) + Math.max(0, -l2);
    if (out < bestOut) {
      bestOut = out;
      const cl = [Math.max(0, l0), Math.max(0, l1), Math.max(0, l2)], s = cl[0] + cl[1] + cl[2] || 1;
      best = { t, bary: [cl[0] / s, cl[1] / s, cl[2] / s], inside: out < 1e-9 };
      if (best.inside) break;
    }
  }
  return best;
}

/** A tack at a flat point of a panel, `offset` out, and where that puts the add-on's point. */
export function flatTack(panel: HostPanel, q: number[], x: number[][], offset: number, lift: boolean, local: number): { tack: AddOnTack; at: V3 } {
  const { t, bary } = locateFlat(panel, q);
  const ids = [panel.tris[t], panel.tris[t + 1], panel.tris[t + 2]];
  const p = ids.map((i) => panel.particles[i]);
  const n = unit([0, 1, 2].map((k) => ids.reduce((acc, i, j) => acc + bary[j] * panel.normal(i)[k], 0)));
  const pos = [0, 1, 2].map((k) => p.reduce((acc, i, j) => acc + bary[j] * x[i][k], 0));
  // Wound so the triangle's own normal faces out, as the solver reads it.
  const flip = dot(cross(sub(x[p[1]], x[p[0]]), sub(x[p[2]], x[p[0]])), n) < 0;
  const tri: [number, number, number] = flip ? [p[0], p[2], p[1]] : [p[0], p[1], p[2]];
  const b: [number, number, number] = flip ? [bary[0], bary[2], bary[1]] : bary;
  return { tack: { local, tri, bary: b, offset, lift }, at: [pos[0] + n[0] * offset, pos[1] + n[1] * offset, pos[2] + n[2] * offset] };
}

/** Panels a name picks: itself, or with an L or R after it (`front` takes frontL and frontR, as `cuff` takes both cuffs). */
const panelsNamed = (panels: HostPanel[], name: string) => panels.filter((p) => p.name === name || (p.name.length === name.length + 1 && p.name.startsWith(name) && /[LR]$/.test(p.name)));

const bbox = (uv: number[][]) => {
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [u, v] of uv) { u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
  return { u0, u1, v0, v1 };
};

/**
 * How fine an add-on is meshed where it lies: no coarser than the garment
 * under it. Its triangles are chords of the curved cloth as the garment's
 * are; a coarser one dips through it wherever it is curved (a 15-point back
 * pocket, 4.5 cm edges over a seat meshed at 2.2 cm, sagged 3 mm through
 * it though every point stood 3.5 mm clear). The median flat edge of the
 * panel's triangles with a corner in the box (u0, v0)-(u1, v1); of the
 * whole panel if none.
 */
function hostEdge(panel: HostPanel, u0: number, v0: number, u1: number, v1: number): number {
  const inBox = (q: number[]) => q[0] >= u0 && q[0] <= u1 && q[1] >= v0 && q[1] <= v1;
  const lens: number[] = [], all: number[] = [];
  for (let t = 0; t < panel.tris.length; t += 3) {
    const c = [panel.uv[panel.tris[t]], panel.uv[panel.tris[t + 1]], panel.uv[panel.tris[t + 2]]];
    const near = c.some(inBox);
    for (let e = 0; e < 3; e++) {
      const a = c[e], b = c[(e + 1) % 3], l = Math.hypot(a[0] - b[0], a[1] - b[1]);
      all.push(l);
      if (near) lens.push(l);
    }
  }
  const pick = lens.length ? lens : all;
  pick.sort((a, b) => a - b);
  return pick[pick.length >> 1] ?? Infinity;
}

/**
 * The add-on already on the garment lying furthest out along `n` from `pos`
 * (within 3 cm), if any: which piece, its triangle (local points, wound to
 * face along `n`), where on it, and how far out.
 */
export function topOver(pos: V3, n: V3, below: AddOnPiece[]): { height: number; piece: AddOnPiece; tri: [number, number, number]; bary: [number, number, number] } | null {
  let top: { height: number; piece: AddOnPiece; tri: [number, number, number]; bary: [number, number, number] } | null = null;
  for (const pc of below) {
    const P = pc.start, T = pc.tris;
    for (let t = 0; t < T.length; t += 3) {
      const a = P[T[t]], b = P[T[t + 1]], c = P[T[t + 2]];
      const e1 = sub(b, a), e2 = sub(c, a), h = cross(n, e2), det = dot(e1, h);
      if (Math.abs(det) < 1e-14) continue;
      const sv = sub(pos, a), u = dot(sv, h) / det;
      if (u < -0.02 || u > 1.02) continue;
      const q = cross(sv, e1), v = dot(n, q) / det;
      if (v < -0.02 || u + v > 1.02) continue;
      const along = dot(e2, q) / det;
      if (along > (top?.height ?? 0) && along < 0.03) {
        const cu = Math.max(0, Math.min(1, u)), cv = Math.max(0, Math.min(1 - cu, v));
        const bary: [number, number, number] = [1 - cu - cv, cu, cv];
        // Wound so the triangle's own normal faces along n, as the solver reads it.
        const flip = dot(cross(e1, e2), n) < 0;
        top = { height: along, piece: pc, tri: flip ? [T[t], T[t + 2], T[t + 1]] : [T[t], T[t + 1], T[t + 2]], bary: flip ? [bary[0], bary[2], bary[1]] : bary };
      }
    }
  }
  return top;
}

/**
 * How far out from the garment, along `n` from `pos`, the add-ons already on
 * it lie there (0 where none does): one sewn on over another (a belt loop
 * over a pocket's top) stacks on it rather than being sewn through it.
 */
export function heightOver(pos: V3, n: V3, below: AddOnPiece[]): number {
  return topOver(pos, n, below)?.height ?? 0;
}

/**
 * heightOver for many points against `below` as it stands now, its triangles
 * filed once in cells: placing a long ruffle in many pieces asked it of every
 * triangle sewn on so far for each point it tried, most of the build's time.
 * Each cell keeps topOver's order, so it finds the same triangle.
 */
export function heightsOver(below: AddOnPiece[]): (pos: V3, n: V3) => number {
  const cell = 0.04, key = (i: number, j: number, k: number) => ((i + 1024) * 2048 + (j + 1024)) * 2048 + (k + 1024);
  const cells = new Map<number, [AddOnPiece, number][]>();
  for (const pc of below) {
    const P = pc.start, T = pc.tris;
    for (let t = 0; t < T.length; t += 3) {
      const a = P[T[t]], b = P[T[t + 1]], c = P[T[t + 2]];
      // Anywhere topOver could take it from: on it (and 2% of its sides past) and up to 3 cm off it.
      const m = 0.03 + 0.02 * Math.max(Math.hypot(...sub(b, a)), Math.hypot(...sub(c, a)), Math.hypot(...sub(c, b))) + 1e-6;
      const lo = [0, 1, 2].map((q) => Math.floor((Math.min(a[q], b[q], c[q]) - m) / cell)), hi = [0, 1, 2].map((q) => Math.floor((Math.max(a[q], b[q], c[q]) + m) / cell));
      for (let i = lo[0]; i <= hi[0]; i++) for (let j = lo[1]; j <= hi[1]; j++) for (let k = lo[2]; k <= hi[2]; k++) {
        const kk = key(i, j, k);
        (cells.get(kk) ?? cells.set(kk, []).get(kk)!).push([pc, t]);
      }
    }
  }
  return (pos, n) => {
    const list = cells.get(key(Math.floor(pos[0] / cell), Math.floor(pos[1] / cell), Math.floor(pos[2] / cell)));
    let top = 0;
    for (const [pc, t] of list ?? []) {
      const P = pc.start, T = pc.tris, a = P[T[t]], b = P[T[t + 1]], c = P[T[t + 2]];
      const e1 = sub(b, a), e2 = sub(c, a), h = cross(n, e2), det = dot(e1, h);
      if (Math.abs(det) < 1e-14) continue;
      const sv = sub(pos, a), u = dot(sv, h) / det;
      if (u < -0.02 || u > 1.02) continue;
      const q = cross(sv, e1), v = dot(n, q) / det;
      if (v < -0.02 || u + v > 1.02) continue;
      const along = dot(e2, q) / det;
      if (along > top && along < 0.03) top = along;
    }
    return top;
  };
}

/** Clear of the garment as sewn on, and as a loop's middle stands off for a belt to pass under it. */
export const SEWN_OFF = 0.0024;
const LOOP_OFF = 0.0085, BELT_OFF = 0.0032;
/**
 * How far over what it laps a lapping end or edge starts, metres: a front
 * over the other at an opening (clothModel), a belt's end over its start, as
 * a button stand's edge over the under front (standPiece). Started in one
 * place, the two lay in each other's surface and the first settle pushed
 * each through the other.
 */
export const LAP_OFF = 0.0035;

/**
 * A rectangle (with a slight point at the bottom, if `point`) laid on a
 * panel at flat `centre`, meshed at `spacing`; its `sewn` edges tacked
 * down, the rest lifting off at `freeOff`. Slid along the panel, away from
 * its edge, until it lies on it whole.
 */
function patch(name: string, panel: HostPanel, centre: number[], w: number, h: number, point: number, sewn: Set<string>, freeOff: number, x: number[][], spacing: number, below: AddOnPiece[] = []): AddOnPiece {
  const edges = [
    { id: 'bottom', pts: point > 0 ? [[-w / 2, -h / 2], [0, -h / 2 - point], [w / 2, -h / 2]] : [[-w / 2, -h / 2], [w / 2, -h / 2]] },
    { id: 'right', pts: [[w / 2, -h / 2], [w / 2, h / 2]] },
    { id: 'top', pts: [[w / 2, h / 2], [-w / 2, h / 2]] },
    { id: 'left', pts: [[-w / 2, h / 2], [-w / 2, -h / 2]] },
  ] as { id: string; pts: [number, number][] }[];
  const box = bbox(panel.uv);
  const mid = [(box.u0 + box.u1) / 2, (box.v0 + box.v1) / 2];
  const r = Math.max(w, h + point) / 2;
  const m = meshOutline(edges, Math.min(spacing, Math.min(w, h) / 3, hostEdge(panel, centre[0] - r, centre[1] - r, centre[0] + r, centre[1] + r)));
  let c = centre.slice();
  for (let k = 0; k < 12; k++) {
    if (m.uv.every(([u, v]) => locateFlat(panel, [c[0] + u, c[1] + v]).inside)) break;
    c = [c[0] + (mid[0] - c[0]) * 0.15, c[1] + (mid[1] - c[1]) * 0.15];
  }
  const onSewn = new Set<number>();
  for (const id of sewn) for (const i of m.edgeVerts[id] ?? []) onSewn.add(i);
  const tacks: AddOnTack[] = [], start: number[][] = [];
  m.uv.forEach(([u, v], i) => {
    const sewnHere = onSewn.has(i), q = [c[0] + u, c[1] + v];
    let off = sewnHere ? SEWN_OFF : freeOff;
    if (below.length) {
      const pos = flatTack(panel, q, x, 0, false, i).at, n = unit(sub(flatTack(panel, q, x, 1, false, i).at, pos));
      off = Math.max(off, heightOver(pos, n, below) + SEWN_OFF);
    }
    const { tack, at } = flatTack(panel, q, x, off, !sewnHere, i);
    tacks.push(tack);
    start.push(at);
  });
  const outline = edges.flatMap((e) => m.edgeVerts[e.id].slice(0, -1));
  return { name, rgba: [0, 0, 0, 1], uv: m.uv, tris: m.tris, outline, start, tacks };
}

/** Pockets: on the panels named, at `at` (fractions across and up the panel; mirrored on a right-hand panel), sewn round three sides, open at the top. */
export function pocketPieces(pockets: GarmentPocket[], panels: HostPanel[], x: number[][], spacing: number, colour: number[]): AddOnPiece[] {
  const out: AddOnPiece[] = [];
  for (const pk of pockets) {
    for (const panel of panelsNamed(panels, pk.panel)) {
      const box = bbox(panel.uv);
      const [fu, fv] = pk.at ?? [0.5, 0.6];
      const across = panel.name.endsWith('R') ? 1 - fu : fu;
      const w = pk.width ?? 0.11, h = pk.height ?? 0.12;
      const centre = [box.u0 + across * (box.u1 - box.u0), box.v0 + fv * (box.v1 - box.v0)];
      const piece = patch(`pocket_${panel.name}`, panel, centre, w, h, 0.1 * h, new Set(['left', 'bottom', 'right']), SEWN_OFF + 0.0006, x, spacing, out);
      piece.rgba = pk.rgba ?? [colour[0] * 0.86, colour[1] * 0.86, colour[2] * 0.86, colour[3] ?? 1];
      out.push(piece);
    }
  }
  return out;
}

/**
 * The line a belt follows: closed polylines round the garment, as particle
 * positions. Along a named line of it, carried down the surface by half the
 * belt's width; or round it at a height, on the body (round the limbs only
 * where the body has none there: both ankles).
 */
export function beltPaths(belt: GarmentBelt, width: number, lines: { run: number[]; closed: boolean }[], hostTris: number[], partOf: (particle: number) => string, x: number[][], normalOf: (particle: number) => number[]): V3[][] {
  const paths: V3[][] = [];
  if (belt.at === undefined) {
    // Into the garment from its edge: toward the triangles beside it (along a seam, with cloth both sides, down).
    const beside = new Map<number, number[]>();
    for (let t = 0; t < hostTris.length; t += 3) {
      const ids = [hostTris[t], hostTris[t + 1], hostTris[t + 2]];
      const c = [0, 1, 2].map((k) => (x[ids[0]][k] + x[ids[1]][k] + x[ids[2]][k]) / 3);
      for (const i of ids) { const acc = beside.get(i) ?? beside.set(i, [0, 0, 0]).get(i)!; for (let k = 0; k < 3; k++) acc[k] += c[k] - x[i][k]; }
    }
    for (const { run } of lines) {
      if (run.length < 3) continue;
      const pts = run.map((p, i) => {
        const prev = x[run[Math.max(0, i - 1)]], next = x[run[Math.min(run.length - 1, i + 1)]];
        const t = unit(sub(next, prev)), n = normalOf(p);
        let d = unit(cross(n, t));
        const inward = beside.get(p) ?? [0, 0, -1], lean = dot(inward, d), along = Math.hypot(...(inward as [number, number, number]));
        if (Math.abs(lean) > 0.2 * along ? lean < 0 : d[2] > 0) d = [-d[0], -d[1], -d[2]];
        const off = width / 2 + 0.004;
        return [x[p][0] + d[0] * off, x[p][1] + d[1] * off, x[p][2] + d[2] * off];
      });
      paths.push(pts);
    }
    return paths;
  }
  // Round at a height: each triangle across it gives a segment, chained by the edges they cross.
  const z = belt.at, seg = new Map<string, string[]>(), where = new Map<string, V3>(), part = new Map<string, string>();
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (let t = 0; t < hostTris.length; t += 3) {
    const ids = [hostTris[t], hostTris[t + 1], hostTris[t + 2]];
    const crossings: string[] = [];
    for (let e = 0; e < 3; e++) {
      const a = ids[e], b = ids[(e + 1) % 3], za = x[a][2] - z, zb = x[b][2] - z;
      if ((za < 0) === (zb < 0)) continue;
      const k = key(a, b), f = za / (za - zb);
      where.set(k, [0, 1, 2].map((q) => x[a][q] + (x[b][q] - x[a][q]) * f));
      part.set(k, partOf(a));
      crossings.push(k);
    }
    if (crossings.length !== 2) continue;
    (seg.get(crossings[0]) ?? seg.set(crossings[0], []).get(crossings[0])!).push(crossings[1]);
    (seg.get(crossings[1]) ?? seg.set(crossings[1], []).get(crossings[1])!).push(crossings[0]);
  }
  const loops: { pts: V3[]; part: string }[] = [], seen = new Set<string>();
  for (const start of seg.keys()) {
    if (seen.has(start)) continue;
    const chainKeys = [start];
    seen.add(start);
    for (let cur = start; ;) {
      const nxt = (seg.get(cur) ?? []).find((k) => !seen.has(k));
      if (!nxt) break;
      seen.add(nxt); chainKeys.push(nxt); cur = nxt;
    }
    if (chainKeys.length >= 6) loops.push({ pts: chainKeys.map((k) => where.get(k)!), part: part.get(start)! });
  }
  const onBody = loops.filter((l) => l.part === 'skin');
  return (onBody.length ? onBody : loops).map((l) => l.pts);
}

/** Nearest point on the garment's triangles to `q`, as a tack `offset` out (wound to face out by `normalOf`). */
export function nearestTack(q: V3, hostTris: number[], x: number[][], normalOf: (p: number) => number[], offset: number, lift: boolean, local: number): { tack: AddOnTack; at: V3 } {
  let best = { d: Infinity, t: 0, bary: [1, 0, 0] as [number, number, number], p: q };
  for (let t = 0; t < hostTris.length; t += 3) {
    const a = x[hostTris[t]], b = x[hostTris[t + 1]], c = x[hostTris[t + 2]];
    // Quick reject: further than the best by its bounding sphere.
    const cx = (a[0] + b[0] + c[0]) / 3, cy = (a[1] + b[1] + c[1]) / 3, cz = (a[2] + b[2] + c[2]) / 3;
    const r = Math.max(Math.hypot(a[0] - cx, a[1] - cy, a[2] - cz), Math.hypot(b[0] - cx, b[1] - cy, b[2] - cz), Math.hypot(c[0] - cx, c[1] - cy, c[2] - cz));
    if (Math.hypot(q[0] - cx, q[1] - cy, q[2] - cz) - r > best.d) continue;
    const ab = sub(b, a), ac = sub(c, a), ap = sub(q, a);
    const d1 = dot(ab, ap), d2 = dot(ac, ap), d3 = dot(ab, ab), d4 = dot(ab, ac), d5 = dot(ac, ac), den = d3 * d5 - d4 * d4;
    let v = den > 1e-14 ? (d5 * d1 - d4 * d2) / den : 0, w = den > 1e-14 ? (d3 * d2 - d4 * d1) / den : 0;
    v = Math.max(0, Math.min(1, v)); w = Math.max(0, Math.min(1 - v, w));
    const p = [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
    const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    if (d < best.d) best = { d, t, bary: [1 - v - w, v, w], p };
  }
  const ids: [number, number, number] = [hostTris[best.t], hostTris[best.t + 1], hostTris[best.t + 2]];
  const n = unit([0, 1, 2].map((k) => ids.reduce((acc, i, j) => acc + best.bary[j] * normalOf(i)[k], 0)));
  const flip = dot(cross(sub(x[ids[1]], x[ids[0]]), sub(x[ids[2]], x[ids[0]])), n) < 0;
  const tri: [number, number, number] = flip ? [ids[0], ids[2], ids[1]] : ids;
  const bary: [number, number, number] = flip ? [best.bary[0], best.bary[2], best.bary[1]] : best.bary;
  return { tack: { local, tri, bary, offset, lift }, at: [best.p[0] + n[0] * offset, best.p[1] + n[1] * offset, best.p[2] + n[2] * offset] };
}

/** Arc length along a closed polyline, and the point and direction at `s` along it. */
function closedCurve(pts: V3[]) {
  const cum = [0];
  for (let i = 1; i <= pts.length; i++) cum.push(cum[i - 1] + Math.hypot(...sub(pts[i % pts.length], pts[i - 1]) as [number, number, number]));
  const total = cum[pts.length];
  const at = (s: number) => {
    const u = ((s % total) + total) % total;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < u) i++;
    const a = pts[i - 1], b = pts[i % pts.length], f = (u - cum[i - 1]) / Math.max(1e-12, cum[i] - cum[i - 1]);
    return { p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f], t: unit(sub(b, a)) };
  };
  return { total, at };
}

/**
 * A belt along each path, as cloth drawn in to `ratio` of the path's length
 * (so it pulls the garment in), its points tacked where they start, free to
 * lift; a buckle at its front; and, if asked, loops sewn to the garment over
 * it, top and bottom, their middles standing off for it to pass under.
 * Paths, `hostTris`, `wornPanels` and `normalOf` are the garment as worn
 * (`wornX`); the loops are sewn to `panels` as they are (`x`): the same, or
 * the pieces laid flat.
 */
export function beltPieces(belt: GarmentBelt, loops: number, paths: V3[][], hostTris: number[], wornPanels: HostPanel[], panels: HostPanel[], x: number[][], wornX: number[][], normalOf: (p: number) => number[], spacing: number, colour: number[], withBelt: boolean, below: AddOnPiece[] = []): AddOnPiece[] {
  const out: AddOnPiece[] = [];
  const width = belt.width ?? 0.032;
  paths.forEach((path, k) => {
    // Start at the front: the point most to the -y.
    let i0 = 0;
    path.forEach((p, i) => { if (p[1] < path[i0][1]) i0 = i; });
    const loopPts = [...path.slice(i0), ...path.slice(0, i0)];
    const curve = closedCurve(loopPts);
    const suffix = paths.length > 1 ? `${k + 1}` : '';
    let beltPiece: AddOnPiece | null = null;
    if (withBelt) {
      // No coarser than the garment along its line (hostEdge): the median worn
      // edge of the garment's triangles with a corner within a belt's width of it.
      const lens: number[] = [];
      for (let t = 0; t < hostTris.length; t += 3) {
        const c = [wornX[hostTris[t]], wornX[hostTris[t + 1]], wornX[hostTris[t + 2]]];
        if (!c.some((q) => loopPts.some((p) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < width))) continue;
        for (let e = 0; e < 3; e++) { const a = c[e], b = c[(e + 1) % 3]; lens.push(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])); }
      }
      lens.sort((a, b) => a - b);
      const step = Math.min(spacing, width / 2.5, lens[lens.length >> 1] ?? Infinity);
      // Round the whole of its line, its two ends a step apart, not on top of each other (each through the other).
      const len = curve.total - step;
      const edges = [
        { id: 'bottom', pts: [[0, -width / 2], [len, -width / 2]] },
        { id: 'right', pts: [[len, -width / 2], [len, width / 2]] },
        { id: 'top', pts: [[len, width / 2], [0, width / 2]] },
        { id: 'left', pts: [[0, width / 2], [0, -width / 2]] },
      ] as { id: string; pts: [number, number][] }[];
      const m = meshOutline(edges, step);
      const tacks: AddOnTack[] = [], start: number[][] = [];
      // Its two ends meet at the front: the end laps over the start, risen to
      // it over the last two widths, not cut to meet it in its own surface.
      const lapFrom = len - 2 * width;
      m.uv.forEach(([u, v], i) => {
        const { p, t } = curve.at(u);
        const n = normalOf(nearestTack(p, hostTris, wornX, normalOf, 0, false, 0).tack.tri[0]);
        let up = unit(cross(t, n));
        if (up[2] < 0) up = [-up[0], -up[1], -up[2]];
        const q = [p[0] + up[0] * v, p[1] + up[1] * v, p[2] + up[2] * v];
        const lap = u > lapFrom ? LAP_OFF * Math.min(1, (u - lapFrom) / (len - lapFrom)) : 0;
        const { tack, at } = nearestTack(q, hostTris, wornX, normalOf, BELT_OFF + lap, true, i);
        // Where it lies over what is sewn on already (a pocket's top at the
        // waist), it rests on that, its own offset off it, and draws it in
        // with the cloth under it. Tacked to the garment through it, the
        // belt drawn in squeezed the pocket under it and it buckled up
        // through the belt.
        const surf = nearestTack(q, hostTris, wornX, normalOf, 0, true, i).at, dir = unit(sub(at, surf));
        const over = below.length ? topOver(surf, dir, below) : null;
        if (over) {
          const P = over.piece.start, pos = [0, 1, 2].map((k) => over.bary[0] * P[over.tri[0]][k] + over.bary[1] * P[over.tri[1]][k] + over.bary[2] * P[over.tri[2]][k]);
          tacks.push({ local: i, tri: over.tri, bary: over.bary, offset: BELT_OFF + lap, lift: true, onPiece: over.piece.name });
          start.push([pos[0] + dir[0] * (BELT_OFF + lap), pos[1] + dir[1] * (BELT_OFF + lap), pos[2] + dir[2] * (BELT_OFF + lap)]);
          return;
        }
        tacks.push(tack);
        start.push(at);
      });
      const outline = edges.flatMap((e) => m.edgeVerts[e.id].slice(0, -1));
      const buckle: GarmentTrim = { kind: 'buckle', along: 'left', size: width * 1.15 };
      out.push(beltPiece = {
        name: `belt${suffix}`, rgba: belt.rgba ?? [0.18, 0.12, 0.08, 1], material: belt.material ?? 'leather',
        uv: m.uv, tris: m.tris, outline, start, tacks, shrink: Math.max(0.8, Math.min(1, belt.ratio ?? 0.97)),
        ...(belt.buckle !== false ? { trims: m.edgeVerts.left.map((local, j, arr) => (j === Math.floor(arr.length / 2) ? { trim: buckle, local } : null)).filter((q): q is { trim: GarmentTrim; local: number } => q !== null) } : {}),
      });
    }
    // Loops, evenly round from the back, each on the panel under it: one at
    // the centre back if there are an odd number, and so never one at the
    // front, over the fly and the belt's ends at its buckle (half a spacing
    // round from the back whatever the count, five put one there).
    for (let j = 0; j < loops; j++) {
      const { p } = curve.at(curve.total * (j + (loops % 2 ? 0 : 0.5)) / loops + curve.total / 2);
      const hit = nearestTack(p, hostTris, wornX, normalOf, 0, false, 0).tack;
      const worn = wornPanels.find((pn) => hit.tri.every((q) => pn.particles.includes(q)));
      const panel = worn && panels.find((pn) => pn.name === worn.name);
      if (!worn || !panel) continue;
      const local = hit.tri.map((q) => worn.particles.indexOf(q));
      const uv = [0, 1].map((c) => local.reduce((acc, l, i) => acc + hit.bary[i] * worn.uv[l][c], 0));
      const piece = patch(`beltLoop${suffix}_${j + 1}`, panel, uv, 0.013, width * 1.4, 0, new Set(['top', 'bottom']), LOOP_OFF, x, spacing, beltPiece ? [...below, beltPiece] : below);
      piece.rgba = [colour[0] * 0.78, colour[1] * 0.78, colour[2] * 0.78, colour[3] ?? 1];
      out.push(piece);
    }
  });
  return out;
}

/**
 * A button stand: where an opening is buttoned, the front that laps over
 * carries a strip `width` wide on from its edge, lying over the other front
 * (tacked down to it where `fastened`), the buttons through its holes down
 * its middle. `run` is the opening's shell points in order; `over` and
 * `under` the fronts either side (each with its shell points, `wornOf`);
 * `buttonAt` the run's points with a button.
 */
export function standPiece(name: string, run: number[], over: HostPanel, under: HostPanel, overShell: number[], underShell: number[], width: number, buttonAt: Set<number>, button: GarmentTrim, fastened: boolean, x: number[][]): AddOnPiece | null {
  const uLocal = run.map((g) => underShell.indexOf(g)), oLocal = run.map((g) => overShell.indexOf(g));
  if (uLocal.some((l) => l < 0) || oLocal.some((l) => l < 0) || run.length < 3) return null;
  const box = bbox(under.uv), mid = [(box.u0 + box.u1) / 2, (box.v0 + box.v1) / 2];
  const ROWS = 2, uv: number[][] = [], flat: number[][] = [], tacks: AddOnTack[] = [], start: number[][] = [], stitches: { local: number; particle: number }[] = [];
  let arc = 0;
  run.forEach((_, i) => {
    const q = under.uv[uLocal[i]], a = under.uv[uLocal[Math.max(0, i - 1)]], b = under.uv[uLocal[Math.min(run.length - 1, i + 1)]];
    if (i > 0) arc += Math.hypot(q[0] - under.uv[uLocal[i - 1]][0], q[1] - under.uv[uLocal[i - 1]][1]);
    const t = [b[0] - a[0], b[1] - a[1]], tl = Math.hypot(t[0], t[1]) || 1;
    let n = [-t[1] / tl, t[0] / tl];
    if (n[0] * (mid[0] - q[0]) + n[1] * (mid[1] - q[1]) < 0) n = [-n[0], -n[1]];
    for (let j = 0; j <= ROWS; j++) {
      const local = uv.length, off = (width * j) / ROWS;
      uv.push([q[0] + n[0] * off, q[1] + n[1] * off]);
      flat.push([off, arc]);
      if (j === 0) {
        // Its edge is the over front's edge, lapping over the under front's:
        // started (and, fastened, held) its offset off it like the rest of
        // the strip, the over front's edge raised with it. Left where the
        // fronts meet, in the under front's own surface, the strip's edge
        // started through it and contact kept it there (108 crossings on
        // the shirt, all on this row).
        const p = over.particles[oLocal[i]];
        const { tack, at } = flatTack(under, uv[local], x, 0.0035, true, local);
        if (fastened) tacks.push(tack);
        x[p] = at.slice();
        stitches.push({ local, particle: p });
        start.push(at);
      } else {
        const { tack, at } = flatTack(under, uv[local], x, 0.0035, true, local);
        if (fastened) tacks.push(tack);
        start.push(at);
      }
    }
  });
  const tris: number[] = [], R = ROWS + 1;
  for (let i = 0; i + 1 < run.length; i++) for (let j = 0; j < ROWS; j++) {
    const a = i * R + j, b = (i + 1) * R + j;
    tris.push(a, b, b + 1, a, b + 1, a + 1);
  }
  const outline = [
    ...run.map((_, i) => i * R),
    ...Array.from({ length: ROWS }, (_, j) => (run.length - 1) * R + j + 1),
    ...run.map((_, i) => (run.length - 1 - i) * R + ROWS).slice(1),
    ...Array.from({ length: ROWS - 1 }, (_, j) => ROWS - 1 - j),
  ];
  const trims: { trim: GarmentTrim; local: number }[] = [];
  run.forEach((g, i) => {
    if (!buttonAt.has(g)) return;
    trims.push({ trim: { ...button, kind: 'buttonhole', size: (button.size ?? 0.012) * 1.15, rgba: undefined }, local: i * R + ROWS / 2 }, { trim: button, local: i * R + ROWS / 2 });
  });
  return { name, rgba: [0, 0, 0, 1], uv: flat, tris, outline, start, tacks, trims, stitches };
}
