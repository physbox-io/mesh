/**
 * Cloth of any shape sewn onto a garment along one of its lines
 * (GarmentDraft.attached): a flat outline, meshed, the stretch of it that is
 * sewn laid along the line (by fraction of its length, so a longer edge is
 * gathered onto a shorter line) and tacked there; the rest started hanging
 * from the line, down the garment where it lies over it and on down past
 * it, and left free to fall as the cloth does.
 */

import type { GarmentAttachment } from '../../types/cloth';
import { meshOutline } from './clothMesh';
import { heightOver, nearestTack, SEWN_OFF, type AddOnPiece, type AddOnTack } from './garmentAddOns';

type V3 = number[];
const sub = (a: V3, b: V3) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: V3) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : null; };

/** Clear of the garment where it starts lying over it, past the sewn edge. */
const LIE_OFF = 0.006;
const DOWN = [0, 0, -1], UP = [0, 0, 1];
/** How far out of upright a piece turned up starts, as a slope (about 15 degrees). */
const UP_LEAN = 0.27;
/** The finest a piece sewn on is meshed, metres. */
const MIN_STEP = 0.008;
/** The most a piece is lifted, point by point, to lie over what it hangs on; more, and it is moved clear and sewn on. */
const LIFT_MAX = 0.06;
/** The share of its points that may start not quite clear, for it to start laid on all the same. */
const STRAY = 0.03;

/** The outline's points from `i` round to `j`, both included. */
function chain(outline: [number, number][], i: number, j: number): [number, number][] {
  const n = outline.length, out: [number, number][] = [];
  for (let k = i; ; k = (k + 1) % n) { out.push(outline[k]); if (k === j) break; }
  return out;
}

/**
 * A line's points in the order its fractions run: round a closed one from
 * its front middle toward the wearer's left (+x), as an edge profile runs;
 * along an open one toward the wearer's left, or down if it runs more down
 * than across. In the world frame the garment stands in: +x its left, -y its front.
 */
export function orientRun(run: number[], closed: boolean, x: number[][]): number[] {
  if (closed) {
    const c = [0, 1, 2].map((q) => run.reduce((acc, i) => acc + x[i][q], 0) / run.length);
    const turn = (i: number) => Math.atan2(x[i][0] - c[0], -(x[i][1] - c[1]));
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
  const at = (f: number) => {
    const s = (closed ? ((f % 1) + 1) % 1 : Math.max(0, Math.min(1, f))) * length;
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
  const cell = 0.03, key = (i: number, j: number, k: number) => `${i},${j},${k}`;
  const buckets = new Map<string, number[]>();
  for (let t = 0; t < tris.length; t += 3) {
    const c = [0, 1, 2].map((q) => (x[tris[t]][q] + x[tris[t + 1]][q] + x[tris[t + 2]][q]) / 3);
    const kk = key(Math.floor(c[0] / cell), Math.floor(c[1] / cell), Math.floor(c[2] / cell));
    (buckets.get(kk) ?? buckets.set(kk, []).get(kk)!).push(t);
  }
  /** The nearest point within `reach` (or null), the way the surface faces there, and how far off it sideways `q` is. */
  return (q: number[], reach = 0.06): { p: number[]; n: number[]; h: number; side: number } | null => {
    const R = Math.ceil(reach / cell), ci = q.map((v) => Math.floor(v / cell));
    let best: { p: number[]; t: number; w: number[]; d: number } | null = null;
    // Shell by shell outward, done once nothing nearer can be further out.
    for (let r = 0; r <= R; r++) {
      if (best && best.d < (r - 1) * cell) break;
      for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) for (let k = -r; k <= r; k++) {
      if (Math.max(Math.abs(i), Math.abs(j), Math.abs(k)) !== r) continue;
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
 * clear of (the body the garment is on).
 */
export function attachedPieces(list: GarmentAttachment[], runsOf: (along: string) => { run: number[]; closed: boolean }[], x: number[][], hostTris: number[], normalOf: (p: number) => number[], spacing: number, colour: number[], below: AddOnPiece[] = [], clearOf: { x: number[][]; tris: number[]; normalOf: (p: number) => number[] }[] = []): AddOnPiece[] {
  const out: AddOnPiece[] = [];
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
    const up = a.turn === 'up', outward0 = a.turn === 'out';
    // Its own stretches sewn together (a hood's crown, anything folded and sewn): paired by fraction along each.
    const selfStitches: [number, number][] = [];
    for (const jn of a.joins ?? []) {
      const ix = (v: number) => ((Math.round(v) % n) + n) % n;
      const A = stretch(ix(jn.a[0]), ix(jn.a[1])), B0 = stretch(ix(jn.b[0]), ix(jn.b[1])), B = jn.reversed ? [...B0].reverse() : B0;
      if (A.length < 2 || B.length < 2) continue;
      const [long, short, flip] = A.length >= B.length ? [A, B, false] : [B, A, true];
      const seen = new Set<string>();
      long.forEach((v, k) => {
        const w = short[Math.round((k / (long.length - 1)) * (short.length - 1))];
        const key = `${v},${w}`;
        if (v !== w && !seen.has(key)) { seen.add(key); selfStitches.push(flip ? [w, v] : [v, w]); }
      });
    }
    // Which side of the sewn side the piece is on: toward the middle of its outline.
    const mid = a.outline.reduce((acc, q) => [acc[0] + q[0] / n, acc[1] + q[1] / n], [0, 0]);
    const probe = fromEdge(mid, sewnEdge, 1);
    const flat = mesh.uv.map((q) => fromEdge(q, sewnEdge, probe.away >= 0 ? 1 : -1));
    const surface = hostSurface(x, hostTris, normalOf);
    const others = clearOf.map((o) => hostSurface(o.x, o.tris, o.normalOf));
    runs.forEach(({ run, closed }, r) => {
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
        const own = sewnLen / Math.max(1e-6, line.length), half = Math.min(g1 - g0, own) / 2, mid = (g0 + g1) / 2;
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
          // Turned up, leant out a little off the line: stood straight up it
          // balanced there and never fell (unless what it is sewn into holds it up: a hood's crown round a head).
          const lean = unit([L.n[0], L.n[1], 0]);
          const down = outward0 ? L.n : up ? unit(UP.map((v, c) => v + UP_LEAN * (lean?.[c] ?? 0))) ?? UP : hang[2] < -0.45 ? hang : DOWN;
          const aside = whole ? L.t : chordDir;
          base.push([0, 1, 2].map((c) => L.p[c] + L.n[c] * SEWN_OFF + aside[c] * along + down[c] * away));
          lineAt.push(L);
          // Swung out about the line: off the face, square to how it hangs.
          const dn = dot(L.n, down), out = unit(L.n.map((v, c) => v - down[c] * dn)) ?? L.n;
          hangs.push({ root: [0, 1, 2].map((c) => L.p[c] + L.n[c] * SEWN_OFF + aside[c] * along), down, out, away });
          // Laid on the garment instead: down its face from the line, however gently it slopes.
          const face = hang[2] < -1e-3 ? hang : DOWN;
          onFace.push([0, 1, 2].map((c) => L.p[c] + L.n[c] * SEWN_OFF + aside[c] * along + face[c] * away));
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
        // Turned up, each its own way too: it rises round what is above the line (a hood round a head).
        const outward = lineAt.map((L) => (whole || up ? horizontal(L.n) : unit(mean)) ?? unit(mean) ?? L.n);
        const lie = (q: number[]) => LIE_OFF + heightOver(q, [0, 0, 1], [...below, ...out]);
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
        const radial = lineAt.map((L) => L.n);
        const need = onFace.map((b, i) => {
          if (onSewn.has(i)) return 0;
          for (let d = 0; d <= LIFT_MAX + 1e-9; d += 0.004) if (clearAt(b.map((v, c) => v + radial[i][c] * d))) return d;
          return Infinity;
        });
        let lifted: number[][] | null = null;
        // A stray few that cannot be cleared so (by the garment's edge) do not stop it; the settle sees to them.
        const stray = need.filter((v) => !Number.isFinite(v)).length, few = Math.floor(STRAY * need.length);
        if (!up && !outward0 && stray <= few) {
          for (let i = 0; i < need.length; i++) if (!Number.isFinite(need[i])) need[i] = LIFT_MAX;
          const nbr: number[][] = base.map(() => []);
          for (let t = 0; t < mesh.tris.length; t += 3) for (let e = 0; e < 3; e++) nbr[mesh.tris[t + e]].push(mesh.tris[t + ((e + 1) % 3)]);
          let lift = need.slice();
          for (let it = 0; it < 30; it++) lift = lift.map((_, i) => (onSewn.has(i) ? 0 : Math.max(need[i], nbr[i].reduce((acc, j) => acc + lift[j], 0) / Math.max(1, nbr[i].length))));
          const at = onFace.map((b, i) => b.map((v, c) => v + radial[i][c] * lift[i]));
          if (at.filter((q, i) => !onSewn.has(i) && !clearAt(q)).length <= few) lifted = at;
        }
        let swing = lifted ? 0 : -1;
        if (!up && !outward0 && !lifted) for (let th = 0; th <= Math.PI / 2 + 1e-9; th += Math.PI / 30) if (base.every((_, i) => onSewn.has(i) || clearAt(swung(i, th)))) { swing = th; break; }
        let clear = 0;
        if (swing < 0 && !outward0) while (clear < 0.6 && !base.every((b, i) => onSewn.has(i) || clearAt(b.map((v, c) => v + outward[i][c] * clear)))) clear += 0.01;
        const start = lifted ?? (swing >= 0 ? base.map((_, i) => swung(i, swing)) : base.map((b, i) => b.map((v, c) => v + outward[i][c] * clear)));
        // Its sewn side on the line where it starts there; else stitched to the line's points and sewn on over the sew time.
        const tacks: AddOnTack[] = [], stitches: { local: number; particle: number; sew: boolean }[] = [];
        for (const i of onSewn) {
          if (swing >= 0 || clear < 0.005) { const tk = nearestTack(lineAt[i].p, hostTris, x, normalOf, SEWN_OFF, false, i); tacks.push(tk.tack); start[i] = tk.at; }
          else stitches.push({ local: i, particle: lineAt[i].particle, sew: true });
        }
        out.push({ name, rgba: a.rgba ?? colour, ...(a.material ? { material: a.material } : {}), ...(a.pattern ? { pattern: a.pattern } : {}), ...(a.pressed ? { pressed: true } : {}), uv: mesh.uv, tris: mesh.tris, outline: a.outline.flatMap((_, k) => mesh.edgeVerts[`s${k}`].slice(0, -1)), start, tacks, ...(stitches.length ? { stitches } : {}), ...(swing > 1e-6 || up ? { drop: true } : {}), ...(selfStitches.length ? { selfStitches } : {}) });
      }
    });
  }
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
