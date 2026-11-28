/**
 * Lines drawn on a garment (GarmentDraft.curves), as the shell cuts them: a
 * curve laid on the modelled surface, and the ribbon it sweeps square to the
 * surface as a signed distance, which splitAlong cuts along like a plane, in
 * a band round the curve only (the ribbon's far reaches would cut the other
 * side of the body).
 *
 * Pure: points and triangles in.
 */

import type { GarmentCurve } from '../../types/cloth';

const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-12 ? a.map((v) => v / l) : null; };
const dist2 = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** Laid this finely along the surface, metres. */
const STEP = 0.004;
/** An open end this near an open edge runs on through it, so the cut meets the edge. */
const END_TO_EDGE = 0.025;
/** Points each side a curve's facing is averaged over (STEP apart). */
const NORMAL_WINDOW = 6;
/** Points each side its move onto the surface is averaged over: about two triangles. */
const OFFSET_WINDOW = 6;

/**
 * Which of a mirrored pair is the wearer's left (+x): the first of its
 * measures, each of which the mirror negates, that is not zero; null where
 * every one is (it is its own mirror image).
 */
export function mirrorSide(key: number[]): 'L' | 'R' | null {
  for (const v of key) if (Math.abs(v) > 1e-9) return v > 0 ? 'L' : 'R';
  return null;
}

/** Each line, and its mirror (named L and R) where it has one. */
export function draftLines(lines: GarmentCurve[] | undefined): GarmentCurve[] {
  return (lines ?? []).flatMap((l) => {
    if (l.points.length < 2) return [];
    if (!l.mirror) return [l];
    // Its side by where it lies on the whole, else point by point (a curve across the centre); its own mirror image, one line.
    const side = mirrorSide([l.points.reduce((a, p) => a + p[0], 0), ...l.points.map((p) => p[0])]);
    if (!side) return [l];
    const m: GarmentCurve = { ...l, points: l.points.map((p) => [-p[0], p[1], p[2]] as [number, number, number]) };
    return [{ ...l, name: `${l.name}${side}` }, { ...m, name: `${l.name}${side === 'L' ? 'R' : 'L'}` }];
  });
}

function closestOnTriangle(p: number[], a: number[], b: number[], c: number[]): number[] {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return a.map((x, k) => x + v * ab[k]); }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return a.map((x, k) => x + w * ac[k]); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); return b.map((x, k) => x + w * (c[k] - b[k])); }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return a.map((x, k) => x + ab[k] * v + ac[k] * w);
}

export interface SurfaceCurve {
  /** Points along it on the surface, STEP apart. */
  path: number[][];
  /** The surface's outward normal at each. */
  normal: number[][];
  closed: boolean;
  /** Whether each open end (first, last) runs out through an open edge: cut on past it. */
  through: [boolean, boolean];
  /** Minimum Euclidean distance (metres) from any input control point to the nearest surface point. */
  minControlDist?: number;
}

/**
 * The nearest point of the surface to each of `pts`, and the way it faces
 * there: the nearest corner, then the triangles round it (the surface is
 * finer than a drawn line is far off it).
 */
function project(pts: number[][], points: number[][], tris: number[]): { p: number[]; n: number[] }[] {
  const round = new Map<number, number[]>();
  for (let t = 0; t < tris.length; t += 3) for (let k = 0; k < 3; k++) (round.get(tris[t + k]) ?? round.set(tris[t + k], []).get(tris[t + k])!).push(t);
  const used = [...round.keys()];
  return pts.map((q) => {
    let vi = used[0], vd = Infinity;
    for (const i of used) { const d = dist2(points[i], q); if (d < vd) { vd = d; vi = i; } }
    let best = points[vi], bd = Infinity, bn = [0, 0, 1];
    // The ring round the nearest corner, and the ring round those.
    const near = new Set<number>();
    for (const t of round.get(vi)!) for (let k = 0; k < 3; k++) for (const u of round.get(tris[t + k])!) near.add(u);
    for (const t of near) {
      const a = points[tris[t]], b = points[tris[t + 1]], c = points[tris[t + 2]];
      const on = closestOnTriangle(q, a, b, c), d = dist2(on, q);
      if (d < bd) { bd = d; best = on; bn = unit(cross(sub(b, a), sub(c, a))) ?? bn; }
    }
    return { p: best, n: bn };
  });
}

/**
 * A drawn line laid on the surface, its open ends run on through any open
 * edge they stop short of, and on to any of `stops` (the points of seams cut
 * already) and a little past, so a line drawn to a seam meets it (the bit
 * past it is taken off again: trimOvershoot).
 */
export function surfaceCurve(line: GarmentCurve, points: number[][], tris: number[], stops: number[][] = []): SurfaceCurve | null {
  const closed = !!line.closed;
  const raw = line.points.map((p) => [p[0], p[1], p[2]]);
  // Finely along the drawn line first (its points may be far apart), then onto the surface.
  const fine: number[][] = [];
  const segs = closed ? raw.length : raw.length - 1;
  for (let i = 0; i < segs; i++) {
    const a = raw[i], b = raw[(i + 1) % raw.length], n = Math.max(1, Math.ceil(Math.sqrt(dist2(a, b)) / STEP));
    for (let k = 0; k < n; k++) fine.push(a.map((v, j) => v + ((b[j] - v) * k) / n));
  }
  if (!closed) fine.push(raw[raw.length - 1]);
  if (fine.length < 2 || tris.length < 3) return null;
  const rawProj = project(raw, points, tris);
  const minControlDist = Math.min(...raw.map((q, i) => Math.sqrt(dist2(q, rawProj[i].p))));
  const on = project(fine, points, tris);
  // How far each point moved onto the surface, smoothed along the line: from
  // a line drawn off the surface (round the body, under a puffed garment) the
  // nearest point jumped facet to facet, and the cut zigzagged at triangle
  // scale. The drawn line's own corners stay; only the move is smoothed.
  const moved = on.map((o, i) => sub(o.p, fine[i]));
  const path = fine.map((q, i) => {
    const acc = [0, 0, 0];
    let w = 0;
    for (let d = -OFFSET_WINDOW; d <= OFFSET_WINDOW; d++) {
      let j = i + d;
      if (closed) j = ((j % fine.length) + fine.length) % fine.length; else if (j < 0 || j >= fine.length) continue;
      for (let c = 0; c < 3; c++) acc[c] += moved[j][c];
      w++;
    }
    return q.map((v, c) => v + acc[c] / w);
  });
  const normal = on.map((o) => o.n);
  const through: [boolean, boolean] = [false, false];
  if (!closed) {
    // The open edges' points, to find an end that stops just short of one.
    const n = points.length, seen = new Set<number>(), once = new Map<number, [number, number]>();
    for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 3; e++) {
      const a = tris[t + e], b = tris[t + ((e + 1) % 3)], k = a < b ? a * n + b : b * n + a;
      if (seen.has(k)) once.delete(k); else { seen.add(k); once.set(k, [a, b]); }
    }
    const rim: number[][] = [];
    for (const [a, b] of once.values()) rim.push(points[a], points[b]);
    for (const end of [0, 1]) {
      const i = end ? path.length - 1 : 0, j = end ? Math.max(0, path.length - 4) : Math.min(path.length - 1, 3);
      const p = path[i];
      const nearRim = rim.some((r) => dist2(r, p) < END_TO_EDGE * END_TO_EDGE);
      if (!nearRim && !stops.some((r) => dist2(r, p) < END_TO_EDGE * END_TO_EDGE)) continue;
      const dir = unit(sub(p, path[j]));
      if (!dir) continue;
      through[end] = true;
      // Walked on over the surface (straight on, it left a curving surface
      // and stopped short of the edge), to the edge and a little past it.
      const ext: number[][] = [], nn: number[][] = [];
      let last = p, heading = dir, after = -1;
      for (let k = 0; k * STEP <= 1.5 * END_TO_EDGE; k++) {
        // Past a seam by a couple of steps: far enough.
        if (after < 0 && stops.some((r) => dist2(r, last) < STEP * STEP)) after = 0;
        if (after >= 0 && after++ >= 2) break;
        const ahead = last.map((v, q) => v + heading[q] * STEP);
        const [on] = project([ahead], points, tris);
        const moved = Math.sqrt(dist2(on.p, last)), turned = moved > 0 ? dot(sub(on.p, last), heading) / moved : 0;
        // Held back, or turned aside along the edge: at it.
        if (moved < 0.3 * STEP || turned < 0.7) {
          // At the edge: on past it, off the cloth, so the cut crosses it.
          for (let j = 1; j <= 3; j++) { ext.push(last.map((v, q) => v + heading[q] * j * STEP)); nn.push(normal[i]); }
          break;
        }
        heading = unit(sub(on.p, last)) ?? heading;
        ext.push(on.p); nn.push(on.n);
        last = on.p;
      }
      if (end) { path.push(...ext); normal.push(...nn); } else { path.unshift(...ext.reverse()); normal.unshift(...nn); }
    }
  }
  // The way it faces, smoothed along it: each projected point's own triangle
  // tipped its side this way and that, and the cut along it came out in teeth.
  const smoothN = normal.map((_, i) => {
    const acc = [0, 0, 0];
    for (let d = -NORMAL_WINDOW; d <= NORMAL_WINDOW; d++) {
      let j = i + d;
      if (closed) j = ((j % normal.length) + normal.length) % normal.length; else if (j < 0 || j >= normal.length) continue;
      for (let c = 0; c < 3; c++) acc[c] += normal[j][c];
    }
    return unit(acc) ?? normal[i];
  });
  return { path, normal: smoothN, closed, through, minControlDist };
}

/**
 * The cut a curve makes: its ribbon as a signed distance (for splitAlong),
 * and which triangles it applies in (those within a band of the curve, and
 * not past an open end).
 */
export function curveSlit(c: SurfaceCurve): { f: (p: number[]) => number; where: (centroid: number[], corners: number[][]) => boolean } {
  const { path, normal, closed, through } = c;
  const nSeg = closed ? path.length : path.length - 1;
  // Each segment's side: square to it and to the surface.
  const side: number[][] = [];
  for (let i = 0; i < nSeg; i++) {
    const a = path[i], b = path[(i + 1) % path.length], t = unit(sub(b, a)) ?? [1, 0, 0];
    const nrm = unit(normal[i].map((v, k) => v + normal[(i + 1) % path.length][k])) ?? normal[i];
    side.push(unit(cross(t, nrm)) ?? [0, 0, 1]);
  }
  // Segments bucketed by their midpoints' cells; a query searches outward
  // ring by ring until nothing unsearched can be nearer.
  const cell = 0.03, at = (v: number) => Math.floor(v / cell), key = (x: number, y: number, z: number) => ((x + 1024) * 2048 + (y + 1024)) * 2048 + (z + 1024);
  const buckets = new Map<number, number[]>();
  let longest = 0;
  for (let i = 0; i < nSeg; i++) {
    const a = path[i], b = path[(i + 1) % path.length];
    longest = Math.max(longest, Math.sqrt(dist2(a, b)));
    const k = key(at((a[0] + b[0]) / 2), at((a[1] + b[1]) / 2), at((a[2] + b[2]) / 2));
    (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(i);
  }
  const lo = [0, 1, 2].map((k) => Math.min(...path.map((p) => at(p[k])))), hi = [0, 1, 2].map((k) => Math.max(...path.map((p) => at(p[k]))));
  /**
   * The nearest segment, the point on it, and how far past an open end it is
   * (0 if not); none (i -1) if none is within `reach`. Every segment counts:
   * a corner of a big triangle beyond a fixed search, taken as off the line,
   * read as the positive side and the cut zigzagged.
   */
  const nearest = (p: number[], reach = Infinity) => {
    // Further than `reach` from the curve's box: none.
    for (let k = 0; k < 3; k++) if (p[k] < lo[k] * cell - reach || p[k] > (hi[k] + 1) * cell + reach) return { i: -1, d: Infinity, q: p, past: 0 };
    const c = p.map(at);
    let best = { i: -1, d: Infinity, q: p, past: 0 };
    // Past the curve's own box by r cells, every segment has been searched.
    const rMax = Math.max(...[0, 1, 2].map((k) => Math.max(c[k] - lo[k], hi[k] - c[k]))) + 1;
    for (let r = 0; r <= rMax; r++) {
      const near: number[] = [];
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
        const got = buckets.get(key(c[0] + dx, c[1] + dy, c[2] + dz));
        if (got) near.push(...got);
      }
      if (near.length) { const s = scan(p, near); if (s.d < best.d) best = s; }
      // Any segment not yet searched has its midpoint over r cells off.
      const unseen = r * cell - longest / 2;
      if (best.d <= unseen) return best;
      if (unseen > reach) return { i: -1, d: Infinity, q: p, past: 0 };
    }
    return best;
  };
  const scan = (p: number[], near: number[]) => {
    let bi = -1, bd = Infinity, bq = p, past = 0;
    for (const i of near) {
      const a = path[i], b = path[(i + 1) % path.length], ab = sub(b, a), l2 = dot(ab, ab);
      const raw = l2 > 0 ? dot(sub(p, a), ab) / l2 : 0, u = Math.max(0, Math.min(1, raw));
      const q = a.map((v, k) => v + ab[k] * u), d = dist2(p, q);
      if (d < bd) {
        bd = d; bi = i; bq = q;
        const l = Math.sqrt(l2);
        past = !closed && i === 0 && raw < 0 && !through[0] ? -raw * l : !closed && i === nSeg - 1 && raw > 1 && !through[1] ? (raw - 1) * l : 0;
      }
    }
    return { i: bi, d: Math.sqrt(bd), q: bq, past };
  };
  const f = (p: number[]) => {
    const n = nearest(p);
    if (n.i < 0) return 1;
    // Exactly on it is a little to one side, so a point on the line is decided.
    const v = dot(sub(p, n.q), side[n.i]);
    return v === 0 ? 1e-9 : v;
  };
  const where = (centroid: number[], corners: number[][]) => {
    const size = Math.max(...corners.map((a, k) => Math.sqrt(dist2(a, corners[(k + 1) % 3]))));
    const n = nearest(centroid, 1.2 * size);
    if (n.i < 0 || n.past > 1e-4) return false;
    return n.d < 1.2 * size;
  };
  return { f, where };
}

/**
 * A drawn seam's run past a seam it was drawn to, taken off again: from each
 * loose end of its chain back to where it meets another seam or edge
 * (`anchored`), if that is within `reach`. A loose end further from any is
 * meant: it ends inside a panel (a dart).
 */
export function trimOvershoot(chain: [number, number][], anchored: Set<number>, points: number[][], reach = 0.015): Set<string> {
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  const by = new Map<number, number[]>();
  for (const [a, b] of chain) { (by.get(a) ?? by.set(a, []).get(a)!).push(b); (by.get(b) ?? by.set(b, []).get(b)!).push(a); }
  const drop = new Set<string>();
  for (const [v, nb] of by) {
    if (nb.length !== 1 || anchored.has(v)) continue;
    const run: string[] = [];
    let prev = -1, cur = v, len = 0, met = false;
    while (len <= reach) {
      const next = (by.get(cur) ?? []).filter((u) => u !== prev);
      if (next.length !== 1) break;
      const u = next[0];
      len += Math.sqrt(dist2(points[cur], points[u]));
      run.push(key(cur, u));
      if (anchored.has(u)) { met = len <= reach; break; }
      prev = cur; cur = u;
    }
    if (met) for (const k of run) drop.add(k);
  }
  return drop;
}

/** A pen's points this far apart along a stroke, metres. */
export const PEN_STEP = 0.01;
/** A pen stroke ending this near where it began closes round. */
const CLOSE_WITHIN = 0.03;

/** A pen stroke (garment frame) as a curve: closed if it came back to its start, mirrored only if it keeps to one side. */
export function penCurve(pts: number[][], kind: GarmentCurve['kind'], mirror: boolean, taken: string[]): GarmentCurve | null {
  if (pts.length < 2) return null;
  let length = 0;
  for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
  if (length < 2 * PEN_STEP) return null;
  const first = pts[0], last = pts[pts.length - 1];
  const closed = length > 4 * CLOSE_WITHIN && Math.hypot(last[0] - first[0], last[1] - first[1], last[2] - first[2]) < CLOSE_WITHIN;
  const kept = closed ? pts.filter((p, i) => i < pts.length / 2 || Math.hypot(p[0] - first[0], p[1] - first[1], p[2] - first[2]) > PEN_STEP) : pts;
  const oneSide = pts.every((p) => p[0] > 0.01) || pts.every((p) => p[0] < -0.01);
  const base = kind === 'open' ? 'opening' : kind;
  let k = 1;
  while (taken.some((n) => n === `${base}${k}` || n === `${base}${k}L` || n === `${base}${k}R`)) k++;
  const round = (v: number) => Math.round(v * 1e4) / 1e4;
  return {
    name: `${base}${k}`, kind,
    points: kept.map((p) => [round(p[0]), round(p[1]), round(p[2])] as [number, number, number]),
    ...(closed ? { closed: true } : {}),
    ...(mirror && oneSide ? { mirror: true } : {}),
  };
}

