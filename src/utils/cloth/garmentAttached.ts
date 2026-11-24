/**
 * Cloth of any shape sewn onto a garment along one of its lines
 * (GarmentDraft.attached): a flat outline, meshed, the stretch of it that is
 * sewn laid along the line (by fraction of its length, so a longer edge is
 * gathered onto a shorter line) and tacked there; the rest started hanging
 * from the line, down the garment where it lies over it and on down past
 * it, and left free to fall as the cloth does.
 */

import { BOARD_STIFFNESS } from './clothBoards';
import type { ClothMaterialName, GarmentAttachment } from '../../types/cloth';
import { CLOTH_MATERIALS, clothBendRigidity, meshOutline, resolveClothMaterial } from './clothMesh';
import { heightsOver, nearestTack, SEWN_OFF, type AddOnPiece, type AddOnTack } from './garmentAddOns';

type V3 = number[];
const sub = (a: V3, b: V3) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: V3) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : null; };

/** Passes relaxing a start toward its cut lengths. */
const RELAX_PASSES = 40;

/** Clear of the garment where it starts lying over it, past the sewn edge. */
const LIE_OFF = 0.006;
/** How far off the face of a garment's edge a piece sewn to that edge starts, metres: off it, not in it. */
const EDGE_OFF = 0.0006;
const DOWN = [0, 0, -1];
/** The finest a piece sewn on is meshed, metres. */
const MIN_STEP = 0.008;
/** The most a piece is lifted, point by point, to lie over what it hangs on; more, and it is moved clear and sewn on. */
const LIFT_MAX = 0.06;
/**
 * Whether a piece may start laid on the garment, lifted point by point: off,
 * as measured on a hem ruffle and a cape (3 and 28 crossings moved clear and
 * sewn on; 50 and 150 laid on).
 */
const LAY_ON = false;
/** The share of its points that may start not quite clear, for it to start laid on all the same. */
const STRAY = 0.03;

/** The outline's points from `i` round to `j`, both included. */
function chain(outline: [number, number][], i: number, j: number): [number, number][] {
  const n = outline.length, out: [number, number][] = [];
  for (let k = i; ; k = (k + 1) % n) { out.push(outline[k]); if (k === j) break; }
  return out;
}

/**
 * The angle round a closed line from straight ahead (its front middle),
 * toward the wearer's left, about its middle: the middle by length along it,
 * not by its points, which bunch where its mesh is finer (by its points, a
 * cap's band read its front 2 mm to one side, and its peak sat off centre).
 */
function turnRound(run: number[], x: number[][]): (i: number) => number {
  const c = [0, 0, 0];
  let total = 0;
  for (let k = 0; k < run.length; k++) {
    const a = x[run[k]], b = x[run[(k + 1) % run.length]], l = Math.hypot(...sub(b, a) as [number, number, number]);
    for (let q = 0; q < 3; q++) c[q] += ((a[q] + b[q]) / 2) * l;
    total += l;
  }
  for (let q = 0; q < 3; q++) c[q] /= total || 1;
  return (i: number) => Math.atan2(x[i][0] - c[0], -(x[i][1] - c[1]));
}

/**
 * A line's points in the order its fractions run: round a closed one from
 * its front middle toward the wearer's left (+x), as an edge profile runs;
 * along an open one toward the wearer's left, or down if it runs more down
 * than across. In the world frame the garment stands in: +x its left, -y its front.
 */
export function orientRun(run: number[], closed: boolean, x: number[][]): number[] {
  if (closed) {
    const turn = turnRound(run, x);
    let k0 = 0;
    for (let k = 1; k < run.length; k++) if (Math.abs(turn(run[k])) < Math.abs(turn(run[k0]))) k0 = k;
    const r = [...run.slice(k0), ...run.slice(0, k0)];
    // Toward +x first: the turn grows from the start.
    const ahead = r.findIndex((i, k) => k > 0 && Math.abs(turn(i)) > 0.2);
    return ahead > 0 && turn(r[ahead]) < 0 ? [r[0], ...r.slice(1).reverse()] : r;
  }
  const a = x[run[0]], b = x[run[run.length - 1]];
  const across = b[0] - a[0], down = a[2] - b[2];
  const forward = Math.abs(across) >= Math.abs(down) ? across > 0 : down > 0;
  return forward ? run : [...run].reverse();
}

/** A line of the garment by its points: where it is, which way it runs and faces, at a fraction of its length. */
function lineAlong(run: number[], closed: boolean, x: number[][], normalOf: (p: number) => number[]) {
  const ids = closed ? [...run, run[0]] : run;
  const cum = [0];
  for (let k = 1; k < ids.length; k++) cum.push(cum[k - 1] + Math.hypot(...sub(x[ids[k]], x[ids[k - 1]])));
  const length = cum[cum.length - 1];
  // Round a closed line, 0 exactly straight ahead, between its points: at the
  // point nearest it, a stretch sewn on was up to half a point's spacing to
  // one side (a cap's peak, one end reaching 4 mm further than the other).
  let s0 = 0;
  if (closed && run.length > 2) {
    const turn = turnRound(run, x), t0 = turn(run[0]);
    if (t0 < 0) { const t1 = turn(run[1]); if (t1 > t0) s0 = Math.min(1, -t0 / (t1 - t0)) * cum[1]; }
    else if (t0 > 0) { const tl = turn(run[run.length - 1]); if (tl < t0) s0 = -Math.min(1, t0 / (t0 - tl)) * (length - cum[cum.length - 2]); }
  }
  const at = (f: number) => {
    const s = closed ? ((((f * length + s0) % length) + length) % length) : Math.max(0, Math.min(1, f)) * length;
    let k = 1;
    while (k < cum.length - 1 && cum[k] < s) k++;
    const a = ids[k - 1], b = ids[k], u = cum[k] > cum[k - 1] ? (s - cum[k - 1]) / (cum[k] - cum[k - 1]) : 0;
    const p = x[a].map((v, q) => v + (x[b][q] - v) * u);
    const t = unit(sub(x[b], x[a])) ?? [1, 0, 0];
    const na = normalOf(a), nb = normalOf(b);
    const n = unit(na.map((v, q) => v + (nb[q] - v) * u)) ?? na;
    return { p, t, n, particle: u < 0.5 ? a : b };
  };
  return { length, at };
}

/**
 * Where a flat point is from the sewn side: the fraction along it of its
 * nearest point, and its offset from there, along the side (past an end)
 * and away from it (toward the piece's inside, positive).
 */
function fromEdge(q: number[], edge: [number, number][], inward: number): { f: number; along: number; away: number } {
  const cum = [0];
  for (let k = 1; k < edge.length; k++) cum.push(cum[k - 1] + Math.hypot(edge[k][0] - edge[k - 1][0], edge[k][1] - edge[k - 1][1]));
  const L = cum[cum.length - 1] || 1;
  let best = { f: 0, along: 0, away: 0, d: Infinity };
  for (let k = 1; k < edge.length; k++) {
    const a = edge[k - 1], b = edge[k], ab = [b[0] - a[0], b[1] - a[1]], l = Math.hypot(ab[0], ab[1]);
    if (l < 1e-12) continue;
    const t = [ab[0] / l, ab[1] / l], nv = [-t[1] * inward, t[0] * inward];
    const raw = (q[0] - a[0]) * t[0] + (q[1] - a[1]) * t[1], u = Math.max(0, Math.min(l, raw));
    const rel = [q[0] - a[0] - t[0] * u, q[1] - a[1] - t[1] * u], d = Math.hypot(rel[0], rel[1]);
    if (d < best.d) best = { f: (cum[k - 1] + u) / L, along: rel[0] * t[0] + rel[1] * t[1], away: rel[0] * nv[0] + rel[1] * nv[1], d };
  }
  return best;
}

/** The garment's surface, for the nearest point of it to a point, quickly: its triangles bucketed. */
function hostSurface(x: number[][], tris: number[], normalOf: (p: number) => number[]) {
  // Numbered cells, and only those the surface spans looked in: a point far
  // off (deep inside, out past a flare) searched every empty cell out to its
  // reach by string key, most of the time a long ruffle took to place.
  const cell = 0.03, key = (i: number, j: number, k: number) => ((i + 1024) * 2048 + (j + 1024)) * 2048 + (k + 1024);
  const buckets = new Map<number, number[]>();
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < tris.length; t += 3) {
    const c = [0, 1, 2].map((q) => Math.floor((x[tris[t]][q] + x[tris[t + 1]][q] + x[tris[t + 2]][q]) / 3 / cell));
    for (let q = 0; q < 3; q++) { lo[q] = Math.min(lo[q], c[q]); hi[q] = Math.max(hi[q], c[q]); }
    const kk = key(c[0], c[1], c[2]);
    (buckets.get(kk) ?? buckets.set(kk, []).get(kk)!).push(t);
  }
  /** The nearest point within `reach` (or null), the way the surface faces there, and how far off it sideways `q` is. */
  return (q: number[], reach = 0.06): { p: number[]; n: number[]; h: number; side: number } | null => {
    const R = Math.ceil(reach / cell), ci = q.map((v) => Math.floor(v / cell));
    let best: { p: number[]; t: number; w: number[]; d: number } | null = null;
    // Shell by shell outward, done once nothing nearer can be further out.
    for (let r = 0; r <= R; r++) {
      if (best && best.d < (r - 1) * cell) break;
      const k0 = Math.max(-r, lo[2] - ci[2]), k1 = Math.min(r, hi[2] - ci[2]);
      for (let i = Math.max(-r, lo[0] - ci[0]); i <= Math.min(r, hi[0] - ci[0]); i++) for (let j = Math.max(-r, lo[1] - ci[1]); j <= Math.min(r, hi[1] - ci[1]); j++) {
      // The shell's cells only: its two caps in k, unless this column is on its side.
      const side = Math.abs(i) === r || Math.abs(j) === r;
      for (let k = side ? k0 : -r; k <= (side ? k1 : r); k += side || r === 0 ? 1 : 2 * r) {
      if (k < k0 || k > k1) continue;
      for (const t of buckets.get(key(ci[0] + i, ci[1] + j, ci[2] + k)) ?? []) {
        const a = x[tris[t]], b = x[tris[t + 1]], c = x[tris[t + 2]];
        const ab = sub(b, a), ac = sub(c, a), ap = sub(q, a);
        const d1 = dot(ab, ap), d2 = dot(ac, ap), d3 = dot(ab, ab), d4 = dot(ab, ac), d5 = dot(ac, ac), den = d3 * d5 - d4 * d4;
        let v = den > 1e-14 ? (d5 * d1 - d4 * d2) / den : 0, w = den > 1e-14 ? (d3 * d2 - d4 * d1) / den : 0;
        v = Math.max(0, Math.min(1, v)); w = Math.max(0, Math.min(1 - v, w));
        const p = [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
        const d = Math.hypot(...sub(p, q));
        if (!best || d < best.d) best = { p, t, w: [1 - v - w, v, w], d };
      }
      }
      }
    }
    if (!best || best.d > reach) return null;
    const ids = [tris[best.t], tris[best.t + 1], tris[best.t + 2]];
    const n = unit([0, 1, 2].map((k) => ids.reduce((acc, id, m) => acc + best!.w[m] * normalOf(id)[k], 0))) ?? [0, 0, 1];
    const rel = sub(q, best.p), h = dot(rel, n);
    return { p: best.p, n, h, side: Math.hypot(...rel.map((v, k) => v - n[k] * h)) };
  };
}

/**
 * The attached pieces, on the garment's lines as they start: `runsOf` the
 * runs of particles a line name picks (both of a pair), `x` the particles,
 * `hostTris` and `normalOf` the garment's surface, `below` what is sewn on
 * already (stacked over, not through), `clearOf` other surfaces to start
 * clear of (the body the garment is on), `turns` how far a piece (by name)
 * is turned about its line as it is arranged (ClothTurn), degrees.
 */
export function attachedPieces(list: GarmentAttachment[], runsOf: (along: string) => { run: number[]; closed: boolean }[], x: number[][], hostTris: number[], normalOf: (p: number) => number[], spacing: number, colour: number[], below: AddOnPiece[] = [], clearOf: { x: number[][]; tris: number[]; normalOf: (p: number) => number[] }[] = [], turns: Map<string, number> = new Map(), hostMaterial: ClothMaterialName = 'jersey'): AddOnPiece[] {
  const out: AddOnPiece[] = [];
  // Each piece's stretches by point, for joins between pieces, made once both are.
  const built = new Map<string, { stretch: (i: number, j: number) => number[]; n: number }>();
  let freeEdges: Map<string, number> | null = null;
  const later: { from: string; jn: NonNullable<GarmentAttachment['joins']>[number] }[] = [];
  for (const a of list) {
    if (a.outline.length < 3) continue;
    const n = a.outline.length;
    const [i0, i1] = (a.sewn ?? [0, 1]).map((i) => ((Math.round(i) % n) + n) % n);
    if (i0 === i1) continue;
    const sewnEdge = chain(a.outline, i0, i1);
    let sewnLen = 0;
    for (let k = 1; k < sewnEdge.length; k++) sewnLen += Math.hypot(sewnEdge[k][0] - sewnEdge[k - 1][0], sewnEdge[k][1] - sewnEdge[k - 1][1]);
    const runs = runsOf(a.along).filter((r) => r.run.length >= 2);
    const copies = Math.max(1, Math.round(a.repeat ?? 1));
    const [s0, sTo] = a.span ?? [0, 1];
    // Fine enough that its sewn side has a few points, and no coarser than the cloth.
    // Meshed side by side of its outline, so any stretch of it (sewn on, joined) is known by its points.
    // Fine enough for its sewn side and its narrowest part to bend (a band
    // one triangle deep could not fold over the line it hangs from), and no
    // coarser than the cloth.
    let shortest = Infinity;
    for (let k = 0; k < n; k++) { const l = Math.hypot(a.outline[(k + 1) % n][0] - a.outline[k][0], a.outline[(k + 1) % n][1] - a.outline[k][1]); if (l > 1e-6) shortest = Math.min(shortest, l); }
    const step = Math.max(MIN_STEP, Math.min(spacing, sewnLen / 4, shortest / 2));
    const mesh = meshOutline(a.outline.map((q, k) => ({ id: `s${k}`, pts: [q, a.outline[(k + 1) % n]] })), step);
    const stretch = (i: number, j: number) => { const out: number[] = []; for (let k = i; k !== j; k = (k + 1) % n) out.push(...(out.length ? mesh.edgeVerts[`s${k}`].slice(1) : mesh.edgeVerts[`s${k}`])); return out; };
    const onSewn = new Set(stretch(i0, i1));
    const pm = resolveClothMaterial(CLOTH_MATERIALS[a.material ?? hostMaterial] ?? CLOTH_MATERIALS.jersey, a.materialOverrides);
    const board = clothBendRigidity(pm) >= BOARD_STIFFNESS;
    // Its own stretches sewn together (a hood's crown, anything folded and sewn): paired by fraction along each.
    const selfStitches: [number, number][] = [];
    built.set(a.name, { stretch, n });
    for (const jn of a.joins ?? []) {
      if (jn.with) { later.push({ from: a.name, jn }); continue; }
      const ix = (v: number) => ((Math.round(v) % n) + n) % n;
      const B0 = stretch(ix(jn.b[0]), ix(jn.b[1]));
      for (const [v, w] of pairByFraction(stretch(ix(jn.a[0]), ix(jn.a[1])), jn.reversed ? [...B0].reverse() : B0)) if (v !== w) selfStitches.push([v, w]);
    }
    // Which side of the sewn side the piece is on: the side a step off it,
    // along it, falls inside the outline (by most of its length). Toward the
    // outline's middle instead, a deep crescent (a peak curved to a head) was
    // laid out on the wrong side, into the head.
    let votes = 0;
    for (let k = 1; k < sewnEdge.length; k++) {
      const p0 = sewnEdge[k - 1], p1 = sewnEdge[k], dx = p1[0] - p0[0], dy = p1[1] - p0[1], l = Math.hypot(dx, dy);
      if (l < 1e-9) continue;
      const m = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2], step = Math.min(1e-3, l / 4);
      if (insideOutline([m[0] - (dy / l) * step, m[1] + (dx / l) * step], a.outline)) votes += l; else votes -= l;
    }
    const inward = votes >= 0 ? 1 : -1;
    const flat = mesh.uv.map((q) => fromEdge(q, sewnEdge, inward));
    // Its rest shape set in a curve (bend): round an axis out from the middle
    // of its sewn side, across the chord of that side, its sides down off its
    // face, the side the garment is on (the outline runs round anticlockwise
    // seen from its face, the one it shows: GarmentAttachment).
    let rest3: number[][] | undefined;
    if (a.bend && Math.abs(a.bend) > 1e-3) {
      const e0 = sewnEdge[0], e1 = sewnEdge[sewnEdge.length - 1], cl = Math.hypot(e1[0] - e0[0], e1[1] - e0[1]) || 1;
      const c = [(e1[0] - e0[0]) / cl, (e1[1] - e0[1]) / cl], mid = [(e0[0] + e1[0]) / 2, (e0[1] + e1[1]) / 2], R = Math.abs(a.bend), down = Math.sign(a.bend) * inward;
      rest3 = mesh.uv.map((q) => {
        const s0 = (q[0] - mid[0]) * c[0] + (q[1] - mid[1]) * c[1], w = -(q[0] - mid[0]) * c[1] + (q[1] - mid[1]) * c[0], th = s0 / R;
        const s1 = R * Math.sin(th);
        return [mid[0] + c[0] * s1 - c[1] * w, mid[1] + c[1] * s1 + c[0] * w, down * R * (1 - Math.cos(th))];
      });
    }
    const surface = hostSurface(x, hostTris, normalOf);
    // The garment's free edges (an edge of one triangle only).
    if (!freeEdges) { freeEdges = new Map(); for (let t = 0; t < hostTris.length; t += 3) for (let e = 0; e < 3; e++) { const i = hostTris[t + e], j = hostTris[t + ((e + 1) % 3)], key = i < j ? `${i},${j}` : `${j},${i}`; freeEdges.set(key, (freeEdges.get(key) ?? 0) + 1); } }
    const free = freeEdges;
    const others = clearOf.map((o) => hostSurface(o.x, o.tris, o.normalOf));
    runs.forEach(({ run, closed }, r) => {
      // Sewn to a garment's edge, its sewn side on the edge itself, as a seam
      // turned in holds it: stood off the edge's face as on a line drawn
      // across the cloth, a slit of what is under showed between them all
      // along (a cap's band and its peak).
      let onEdge = true;
      for (let k = 1; k < run.length && onEdge; k++) { const i = run[k - 1], j = run[k]; onEdge = free.get(i < j ? `${i},${j}` : `${j},${i}`) === 1; }
      // On the edge, a hair off its face rather than in it: started in it, the
      // edge's own points lay in the piece's first triangles (its sewn side
      // runs along the edge's chords at its own spacing), and every cloth
      // edge from them up the garment counted through it (a cap's peak, 120).
      const off = onEdge ? EDGE_OFF : SEWN_OFF;
      // Round a closed line, a span may run on across its start (from 0.9 to 0.1: across the front).
      const s1 = closed && sTo < s0 ? sTo + 1 : sTo;
      const line = lineAlong(orientRun(run, closed, x), closed, x, normalOf);
      // Round the whole of a closed line, its two ends a step apart rather than on top of each other.
      const gap = closed && s1 - s0 >= 1 ? step / Math.max(1e-6, line.length) : 0;
      for (let k = 0; k < copies; k++) {
        // Its share of the span. A sewn side longer than its share is
        // gathered into it; a shorter one is sewn at its own length in the
        // middle of it (cloth gathers onto a shorter line, it does not stretch onto a longer one).
        const g0 = s0 + ((s1 - s0) * k) / copies, g1 = s0 + ((s1 - s0) * (k + 1)) / copies - (k === copies - 1 ? gap : 0);
        // A board is not gathered either: it takes as much of the line as its
        // own sewn side, about the middle of its share, and the line eases onto
        // it (a cap's peak, 7% longer than the band it was given, crinkled the
        // band all along its seam).
        const own = sewnLen / Math.max(1e-6, line.length), half = (board ? own : Math.min(g1 - g0, own)) / 2, mid = (g0 + g1) / 2;
        const f0 = mid - half, f1 = mid + half;
        const name = `${a.name}${runs.length > 1 ? `_${r + 1}` : ''}${copies > 1 ? `_${k + 1}` : ''}`;
        const whole = closed && f1 - f0 + gap >= 0.999;
        const chordDir = unit(sub(line.at(f1).p, line.at(f0).p)) ?? line.at(f0).t;
        // Where each point hangs from the line, its offset along the line
        // kept. Past an end of a stretch, on the way the stretch goes as a
        // whole (where a line curves, its own way at an end points anywhere).
        const base: number[][] = [], onFace: number[][] = [], lineAt: ReturnType<typeof line.at>[] = [], hangs: { root: number[]; down: number[]; out: number[]; away: number }[] = [];
        mesh.uv.forEach((_, i) => {
          const { f, along, away } = flat[i];
          const L = line.at(f0 + (f1 - f0) * f);
          let hang = unit([L.t[1] * L.n[2] - L.t[2] * L.n[1], L.t[2] * L.n[0] - L.t[0] * L.n[2], L.t[0] * L.n[1] - L.t[1] * L.n[0]]) ?? DOWN;
          if (hang[2] > 0) hang = hang.map((v) => -v);
          // Down the garment's face where it slopes (over a chest, down a back,
          // off a flared hem: it starts lying near where it hangs); straight
          // down where the face is near level (a shoulder's top, where down
          // the face runs off along the shoulder).
          // Straight down; across the surface where the line itself runs more down than across.
          const down = Math.abs(L.t[2]) < 0.7 ? DOWN : hang;
          const aside = whole ? L.t : chordDir;
          base.push([0, 1, 2].map((c) => L.p[c] + L.n[c] * off + aside[c] * along + down[c] * away));
          lineAt.push(L);
          // Swung out about the line: off the face, square to how it hangs.
          const dn = dot(L.n, down), out = unit(L.n.map((v, c) => v - down[c] * dn)) ?? L.n;
          hangs.push({ root: [0, 1, 2].map((c) => L.p[c] + L.n[c] * off + aside[c] * along), down, out, away });
          // Laid on the garment instead: down its face from the line, however gently it slopes.
          const face = hang[2] < -1e-3 ? hang : DOWN;
          onFace.push([0, 1, 2].map((c) => L.p[c] + L.n[c] * off + aside[c] * along + face[c] * away));
        });
        // Then out from the garment, all of it together, as far as it takes
        // to start clear of it, of the body, and of what is sewn on already,
        // and sewn on over the sew time (stitched to the line's own points).
        // Each point pushed out onto the garment by itself instead, or the
        // piece stood out and dropped, its triangles started through the
        // garment wherever it curved.
        const horizontal = (v: number[]) => unit([v[0], v[1], 0]);
        const mean = [0, 0, 0];
        for (const L of lineAt) { const h = horizontal(L.n); if (h) for (let c = 0; c < 3; c++) mean[c] += h[c]; }
        // Out its own way, level, round the whole of a closed line (a ruffle
        // round a hem); the stretch's way on a stretch of one, so it moves as
        // one piece, undistorted.
        const outward = lineAt.map((L) => (whole ? horizontal(L.n) : unit(mean)) ?? unit(mean) ?? L.n);
        const over = heightsOver([...below, ...out]), lie = (q: number[]) => LIE_OFF + over(q, [0, 0, 1]);
        // Far enough round to see a point deep inside (from a neck's side straight down is inside the chest, a long way from any surface).
        const clearAt = (q: number[]) => { const hit = surface(q, 0.4); if (hit && hit.h <= lie(hit.p)) return false; return others.every((o) => { const h = o(q, 0.4); return !h || h.h > LIE_OFF; }); };
        // First swung out about its sewn line, as little as clears it, its
        // sewn side on the line, and let fall onto the garment before it is
        // first drawn (AddOnPiece.drop). Where no swing clears it (a hood off
        // a neck that curves round), moved out instead and sewn on.
        const swung = (i: number, th: number) => { const h = hangs[i], c0 = Math.cos(th), s0 = Math.sin(th); return h.root.map((v, c) => v + (c0 * h.down[c] + s0 * h.out[c]) * h.away); };
        // Where each point need only be lifted a little off what it hangs over
        // (a quilted chest's bumps), laid on it so: the lifts smoothed over the
        // piece, never under what a point needs. Lifts that small hardly
        // distort it, and it starts where it hangs, nothing to draw in (drawn
        // in from a hand's breadth off, a neckerchief swung up over itself).
        // Off the garment's face where it is sewn (up off a shoulder, out off a chest).
        // On an edge, a point a step off its sewn side cannot be clear of the
        // cloth it is sewn to: judged so, no start cleared and the piece was
        // pulled in from afar, its seam ragged.
        const atSeam = (i: number) => onSewn.has(i) || (onEdge && flat[i].away < 1.5 * LIE_OFF);
        const radial = lineAt.map((L) => L.n);
        const need = onFace.map((b, i) => {
          if (atSeam(i)) return 0;
          for (let d = 0; d <= LIFT_MAX + 1e-9; d += 0.004) if (clearAt(b.map((v, c) => v + radial[i][c] * d))) return d;
          return Infinity;
        });
        // Arranged turned about its line (ClothTurn): started so, let settle.
        const turned = turns.get(name) ?? turns.get(a.name);
        let lifted: number[][] | null = null;
        // A stray few that cannot be cleared so (by the garment's edge) do not stop it; the settle sees to them.
        const stray = need.filter((v) => !Number.isFinite(v)).length, few = Math.floor(STRAY * need.length);
        if (turned === undefined && stray <= few && LAY_ON) {
          for (let i = 0; i < need.length; i++) if (!Number.isFinite(need[i])) need[i] = LIFT_MAX;
          const nbr: number[][] = base.map(() => []);
          for (let t = 0; t < mesh.tris.length; t += 3) for (let e = 0; e < 3; e++) nbr[mesh.tris[t + e]].push(mesh.tris[t + ((e + 1) % 3)]);
          let lift = need.slice();
          for (let it = 0; it < 30; it++) lift = lift.map((_, i) => (onSewn.has(i) ? 0 : Math.max(need[i], nbr[i].reduce((acc, j) => acc + lift[j], 0) / Math.max(1, nbr[i].length))));
          const at = onFace.map((b, i) => b.map((v, c) => v + radial[i][c] * lift[i]));
          if (at.filter((q, i) => !atSeam(i) && !clearAt(q)).length <= few) lifted = at;
        }
        let swing = turned !== undefined ? (turned * Math.PI) / 180 : lifted ? 0 : -1;
        if (!lifted && turned === undefined) for (let th = 0; th <= Math.PI / 2 + 1e-9; th += Math.PI / 30) if (base.every((_, i) => atSeam(i) || clearAt(swung(i, th)))) { swing = th; break; }
        // Started as it would rest: of hanging and swung out about its line,
        // whichever takes least energy to hold (bent, by its own stiffness;
        // raised, by its weight). A soft piece hangs; a stiff one cut to stand
        // (a cap's peak, a brim, an interfaced collar) starts standing, and
        // the settle keeps it there. Started hanging, a peak sat jammed down
        // over the eyes, too stiff to bend back up and nothing to make it.
        if (turned === undefined && (lifted || swing >= 0)) {
          // Each relaxed to its cut lengths first (its sewn side held): laid out
          // from its line, a curved piece's corners came out folded, and every
          // start read as bent.
          const hangs = relaxed(lifted ?? base.map((_, i) => swung(i, swing)), mesh, onSewn);
          let bestE = restEnergy(hangs, mesh.tris, pm), bestTh = -1, bestAt: number[][] | null = null;
          // On past square to the face: where the face slopes back (a forehead
          // under a cap's band), the one start a peak lies in unbent, level,
          // is beyond 90 deg from hanging; stopped at 90, it started (and its
          // seam rested) pitched down over the eyes.
          for (let th = Math.max(swing, 0) + Math.PI / 24; th <= (3 * Math.PI) / 4 + 1e-9; th += Math.PI / 24) {
            const at = relaxed(base.map((_, i) => swung(i, th)), mesh, onSewn);
            if (!at.every((q, i) => atSeam(i) || clearAt(q))) continue;
            const e = restEnergy(at, mesh.tris, pm);
            if (e < bestE) { bestE = e; bestTh = th; bestAt = at; }
          }
          if (bestTh >= 0 && bestAt) { lifted = bestAt; swing = bestTh; }
        }
        let clear = 0;
        if (swing < 0) while (clear < 0.6 && !base.every((b, i) => atSeam(i) || clearAt(b.map((v, c) => v + outward[i][c] * clear)))) clear += 0.01;
        const start = lifted ?? (swing >= 0 ? base.map((_, i) => swung(i, swing)) : base.map((b, i) => b.map((v, c) => v + outward[i][c] * clear)));
        // Its sewn side on the line where it starts there; else stitched to the line's points and sewn on over the sew time.
        const tacks: AddOnTack[] = [], stitches: { local: number; particle: number; sew: boolean }[] = [];
        for (const i of onSewn) {
          if (swing >= 0 || clear < 0.005) { const tk = nearestTack(lineAt[i].p, hostTris, x, normalOf, off, false, i); tacks.push(tk.tack); start[i] = tk.at; }
          else stitches.push({ local: i, particle: lineAt[i].particle, sew: true });
        }
        // Outward normal of the attached sheet: at swing = 0 (hanging) it faces +out away from the garment;
        // swung out by `swing` (e.g. ~90 deg for a level cap visor or hat brim) it rotates with the sheet to
        // cos(swing)*out - sin(swing)*down (+Z upward on a visor, instead of grazing ~90 deg against the crown).
        let facing = hangs.map((h, i) => {
          if (swing < 0) return outward[i];
          const c0 = Math.cos(swing), s0 = Math.sin(swing);
          return unit([c0 * h.out[0] - s0 * h.down[0], c0 * h.out[1] - s0 * h.down[1], c0 * h.out[2] - s0 * h.down[2]]) ?? h.out;
        });
        if (swing >= 0 && Math.cos(swing) < -0.5 && others.length) {
          let bodyAlign = 0;
          start.forEach((q, i) => {
            if (atSeam(i)) return;
            const hit = others[0](q, 0.25);
            if (hit) bodyAlign += dot(facing[i], hit.n);
          });
          if (bodyAlign < 0) facing = facing.map((f) => [-f[0], -f[1], -f[2]]);
        }
        out.push({ name, rgba: a.rgba ?? colour, ...(a.material ? { material: a.material } : {}), ...(a.pattern ? { pattern: a.pattern } : {}), ...(a.materialOverrides ? { materialOverrides: a.materialOverrides } : {}), ...(rest3 ? { rest3 } : {}), facing, uv: mesh.uv, tris: mesh.tris, outline: a.outline.flatMap((_, k) => mesh.edgeVerts[`s${k}`].slice(0, -1)), start, tacks, ...(stitches.length ? { stitches } : {}), ...(swing > 1e-6 ? { drop: true } : {}), ...(selfStitches.length ? { selfStitches } : {}) });
      }
    });
  }
  // Pieces sewn to each other.
  for (const { from, jn } of later) {
    const A = built.get(from), B = built.get(jn.with!), pa = out.find((p) => p.name === from), pb = out.find((p) => p.name === jn.with);
    if (!A || !B || !pa || !pb) continue;
    const ia = (v: number) => ((Math.round(v) % A.n) + A.n) % A.n, ib = (v: number) => ((Math.round(v) % B.n) + B.n) % B.n;
    const sb = B.stretch(ib(jn.b[0]), ib(jn.b[1]));
    for (const [v, w] of pairByFraction(A.stretch(ia(jn.a[0]), ia(jn.a[1])), jn.reversed ? [...sb].reverse() : sb)) (pa.joinTo ??= []).push({ local: v, piece: pb.name, at: w });
  }
  return out;
}

/** Two runs of points paired by fraction along each, every point of the longer to the nearest of the shorter: as a seam sews them. */
function pairByFraction(A: number[], B: number[]): [number, number][] {
  if (A.length < 2 || B.length < 2) return [];
  const [long, short, flip] = A.length >= B.length ? [A, B, false] : [B, A, true];
  const out: [number, number][] = [], seen = new Set<string>();
  long.forEach((v, k) => {
    const w = short[Math.round((k / (long.length - 1)) * (short.length - 1))];
    const key = `${v},${w}`;
    if (!seen.has(key)) { seen.add(key); out.push(flip ? [w, v] : [v, w]); }
  });
  return out;
}

/**
 * The stretch of an outline along its top (as drawn, hanging): its longest
 * run of points within a sliver of its highest. What is sewn, for a piece
 * drawn or imported as it hangs.
 */
export function topStretch(outline: [number, number][]): [number, number] {
  const n = outline.length;
  const vs = outline.map((q) => q[1]), top = Math.max(...vs), low = Math.min(...vs);
  const near = vs.map((v) => v >= top - 0.03 * Math.max(1e-6, top - low));
  let best: [number, number] = [0, 1], bestLen = -1;
  for (let i = 0; i < n; i++) {
    if (!near[i] || near[(i - 1 + n) % n]) continue;
    let j = i, len = 0;
    while (near[(j + 1) % n] && (j + 1) % n !== i) { len += Math.hypot(outline[(j + 1) % n][0] - outline[j % n][0], outline[(j + 1) % n][1] - outline[j % n][1]); j++; }
    if (len > bestLen && j > i) { bestLen = len; best = [i, j % n]; }
  }
  // Round the whole outline near the top (every point): its first side.
  return bestLen < 0 ? [0, 1] : best;
}

/**
 * Roughly the energy a piece holds in a shape: bending, by its stiffness
 * (E t^3 / 12(1 - nu^2)) and the angle between each pair of its triangles,
 * and its weight's height. Only to tell one start from another.
 */
function restEnergy(x: number[][], tris: number[], m: { young: number; thickness: number; poisson: number; arealDensity: number; bendFactor?: number }): number {
  const kb = clothBendRigidity(m) / (1 - m.poisson * m.poisson);
  const normal: number[][] = [], area: number[] = [], edge = new Map<string, number[]>();
  let weight = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
    const n = [0, 0, 0], u = sub(x[b], x[a]), v = sub(x[c], x[a]);
    n[0] = u[1] * v[2] - u[2] * v[1]; n[1] = u[2] * v[0] - u[0] * v[2]; n[2] = u[0] * v[1] - u[1] * v[0];
    const A = Math.hypot(n[0], n[1], n[2]) / 2;
    normal.push(unit(n) ?? [0, 0, 1]); area.push(A);
    weight += m.arealDensity * A * 9.81 * (x[a][2] + x[b][2] + x[c][2]) / 3;
    for (const [p, q] of [[a, b], [b, c], [c, a]]) { const k = p < q ? `${p},${q}` : `${q},${p}`; (edge.get(k) ?? edge.set(k, []).get(k)!).push(t / 3); }
  }
  let bend = 0;
  for (const [k, ts] of edge) {
    if (ts.length !== 2) continue;
    const [p, q] = k.split(',').map(Number), l2 = (x[p][0] - x[q][0]) ** 2 + (x[p][1] - x[q][1]) ** 2 + (x[p][2] - x[q][2]) ** 2;
    const phi = Math.acos(Math.max(-1, Math.min(1, dot(normal[ts[0]], normal[ts[1]]))));
    bend += (3 * l2 * phi * phi) / Math.max(1e-12, area[ts[0]] + area[ts[1]]);
  }
  return 0.5 * kb * bend + weight;
}

/** Positions drawn toward the piece's cut lengths (its flat edges), a few passes, `fixed` points held. */
function relaxed(x: number[][], mesh: { uv: number[][]; tris: number[] }, fixed: Set<number>): number[][] {
  const p = x.map((q) => q.slice()), edges: [number, number, number][] = [], seen = new Set<string>();
  for (let t = 0; t < mesh.tris.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = mesh.tris[t + e], b = mesh.tris[t + ((e + 1) % 3)], k = a < b ? `${a},${b}` : `${b},${a}`;
    if (seen.has(k)) continue;
    seen.add(k);
    edges.push([a, b, Math.hypot(mesh.uv[a][0] - mesh.uv[b][0], mesh.uv[a][1] - mesh.uv[b][1])]);
  }
  for (let it = 0; it < RELAX_PASSES; it++) for (const [a, b, l] of edges) {
    const wa = fixed.has(a) ? 0 : 1, wb = fixed.has(b) ? 0 : 1;
    if (!wa && !wb) continue;
    const d = sub(p[b], p[a]), len = Math.hypot(d[0], d[1], d[2]);
    if (len < 1e-12) continue;
    const c = (len - l) / len / (wa + wb);
    for (let k = 0; k < 3; k++) { p[a][k] += wa * c * d[k]; p[b][k] -= wb * c * d[k]; }
  }
  return p;
}

/** Whether a flat point is inside an outline (even-odd). */
function insideOutline(q: number[], poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > q[1]) !== (yj > q[1]) && q[0] < ((xj - xi) * (q[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
