/**
 * Gathers and pleats: a panel's flat piece widened along the seam it is sewn
 * into (slash and spread: cut across the seam and opened, every slash keeping
 * its direction), meshed afresh, and folded back to the seam's length to
 * start, so that every edge starts at its cut length and nothing is pulled.
 *
 * Along the seam, s is arc length on the piece as flattened and sigma on the
 * piece as spread. Gathers spread it evenly (sigma = s * ratio over their
 * stretch); a pleat inserts a strip at one s. Each point of the piece keeps
 * its offset from the seam, so the slashes run on down to the hem: a gathered
 * skirt is a wider rectangle, a pleated one has its pleats all the way down.
 *
 * Folded to start: gathers in an accordion, one fold every few points, deep
 * enough that the cloth's length is all there, flat at the seam itself; a
 * knife pleat in three layers (the cloth on top, turned under at its crease,
 * back under itself, turned again and on), its folds as round as the mesh
 * allows. Sewn: each of its points on the seam held to the point of the seam
 * it is sewn to on the other panel (a tack on that panel's triangle there),
 * so the extra is eased in along the seam as the pattern says; pressed
 * (`stitched`), each pleat's upper layers held to the layer under them down
 * that far.
 */

import type { GarmentFullness } from '../../types/cloth';
import { meshOutline } from './clothMesh';
import type { FlatPiece } from './garmentFlatten';
import type { FullSide } from './garmentFullness';
import type { GarmentShell } from './garmentShell';
import { CLOTH_THICKNESS } from './xpbd';

type V2 = [number, number];

export interface SpreadPanel {
  /** Shell point of each point, or -1 for a point of its own. */
  points: number[];
  uv: V2[];
  tris: number[];
  outline: number[];
  /** Where each point starts, folded, in the shell's frame; and the garment's outward normal there. */
  start: number[][];
  normal: number[][];
  /**
   * How much of each point's folded shape the cloth keeps as its rest (1: set
   * as folded; less, relaxing toward flat): unpressed pleats below their stitching.
   */
  set: number[];
  /** Its own shell points (on no other panel), which start where it folds them rather than where the shell has them. */
  own: boolean[];
  /**
   * Its points on the seam, each to be held to the seam edge a-b (shell
   * points) of the panel across, at t along it, `offset` out: to that panel's
   * triangle there, found once every panel is meshed (it may be spread too).
   */
  seamTacks: { local: number; a: number; b: number; t: number; offset: number; across: number }[];
  /** Its edges along the seam (local points), in order: what a fuller panel across the same seam is tacked to. */
  seamRow: [number, number][];
  /** Its cloth over the seam's length. */
  ratio: number;
  /** Pressed pleats: a point held to its own triangle under it (local points). */
  pressTacks: { local: number; tri: [number, number, number]; bary: [number, number, number]; offset: number }[];
  /**
   * Edges (local points) free to be shorter than cut, by `ratio`: along the
   * seam, crushed into it; and the cloth just below, gathered finer than the
   * mesh can fold (resisting that, the first row pushed sideways and pulled
   * the edges up to the seam to twice their length).
   */
  crushed: [number, number, number][];
  /** For pieces laid out flat: each seam point and the shell point of the seam nearest where it goes. */
  seamStitches: { local: number; point: number }[];
}

/** One knife fold: crease at seam position x, facing +s (dir 1) or -s (-1), taking up 2d of cloth. */
interface Knife { x: number; d: number; dir: 1 | -1; r: number; L: number; sigma0: number }

/**
 * Below its stitching, an unpressed pleat's set relaxes over this far (metres)
 * to this much of its folded shape. Flat: a pleated skirt (2.5x, stitched
 * 10 cm) opens to a plain flare at the hem (cloth/round 1.01, pressed 1.81)
 * and settles, slowly (2.9 mm/s at 4 s, 7.7 at 2.5 s). Keeping 0.3 of the set,
 * 1.6 mm/s at 2.5 s, half open (1.29). Pleats can open flat, so their cloth
 * comes to rest flat; gathers cannot (their extra must fold), and resting flat they never settled.
 */
const UNPRESS = 0.15, UNPRESSED_SET = 0;
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1]] as V2;

/** Nearest point on a polyline extended straight past both ends: its arc parameter, and the point. */
function project(pts: V2[], at: number[], q: number[]): { s: number; p: V2 } {
  let best = Infinity, bs = 0, bp: V2 = [pts[0][0], pts[0][1]];
  const last = pts.length - 2;
  for (let k = 0; k <= last; k++) {
    const a = pts[k], b = pts[k + 1], d = sub(b, a), l2 = d[0] * d[0] + d[1] * d[1];
    if (l2 < 1e-18) continue;
    let t = ((q[0] - a[0]) * d[0] + (q[1] - a[1]) * d[1]) / l2;
    if (k > 0) t = Math.max(0, t);
    if (k < last) t = Math.min(1, t);
    const p: V2 = [a[0] + t * d[0], a[1] + t * d[1]], dist = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (dist < best) { best = dist; bs = at[k] + t * (at[k + 1] - at[k]); bp = p; }
  }
  return { s: bs, p: bp };
}

/** The point at arc parameter s on a polyline, extended straight past its ends. */
function pointAt(pts: V2[], at: number[], s: number): V2 {
  const n = pts.length;
  let k = 0;
  while (k < n - 2 && at[k + 1] < s) k++;
  const a = pts[k], b = pts[k + 1], span = at[k + 1] - at[k];
  const t = span > 1e-12 ? (s - at[k]) / span : 0;
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}

/** Piecewise-linear lookup in increasing xs (clamped, and extended with slope 1 past the ends). */
function interp(xs: number[], ys: number[], x: number): number {
  const n = xs.length;
  if (x <= xs[0]) return ys[0] + (x - xs[0]);
  if (x >= xs[n - 1]) return ys[n - 1] + (x - xs[n - 1]);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
  const span = xs[hi] - xs[lo];
  return span > 1e-12 ? ys[lo] + ((x - xs[lo]) / span) * (ys[hi] - ys[lo]) : ys[hi];
}

/** Triangles of a flat layout, found by a point: the one it is in, or the nearest, and where in it. */
function locator(uv: number[][], tris: number[]) {
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (const [u, v] of uv) { u0 = Math.min(u0, u); v0 = Math.min(v0, v); u1 = Math.max(u1, u); v1 = Math.max(v1, v); }
  const T = tris.length / 3, cell = Math.max(1e-3, Math.sqrt(((u1 - u0) * (v1 - v0)) / Math.max(1, T)) * 2);
  const nu = Math.max(1, Math.ceil((u1 - u0) / cell)), nv = Math.max(1, Math.ceil((v1 - v0) / cell));
  const grid: number[][] = Array.from({ length: nu * nv }, () => []);
  const ci = (u: number) => Math.min(nu - 1, Math.max(0, Math.floor((u - u0) / cell))), cj = (v: number) => Math.min(nv - 1, Math.max(0, Math.floor((v - v0) / cell)));
  for (let t = 0; t < T; t++) {
    const ps = [uv[tris[3 * t]], uv[tris[3 * t + 1]], uv[tris[3 * t + 2]]];
    const a = ci(Math.min(ps[0][0], ps[1][0], ps[2][0])), b = ci(Math.max(ps[0][0], ps[1][0], ps[2][0]));
    const c = cj(Math.min(ps[0][1], ps[1][1], ps[2][1])), d = cj(Math.max(ps[0][1], ps[1][1], ps[2][1]));
    for (let i = a; i <= b; i++) for (let j = c; j <= d; j++) grid[i * nv + j].push(t);
  }
  const bary = (t: number, q: number[]) => {
    const a = uv[tris[3 * t]], b = uv[tris[3 * t + 1]], c = uv[tris[3 * t + 2]];
    const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(det) < 1e-16) return null;
    const l0 = ((b[1] - c[1]) * (q[0] - c[0]) + (c[0] - b[0]) * (q[1] - c[1])) / det;
    const l1 = ((c[1] - a[1]) * (q[0] - c[0]) + (a[0] - c[0]) * (q[1] - c[1])) / det;
    return [l0, l1, 1 - l0 - l1];
  };
  return (q: number[]): { t: number; w: [number, number, number] } => {
    let best = { t: 0, w: [1, 0, 0] as [number, number, number] }, bestOut = Infinity;
    const i0 = ci(q[0]), j0 = cj(q[1]);
    for (let ring = 0; ring <= Math.max(nu, nv); ring++) {
      for (let i = i0 - ring; i <= i0 + ring; i++) for (let j = j0 - ring; j <= j0 + ring; j++) {
        if (i < 0 || j < 0 || i >= nu || j >= nv || (Math.abs(i - i0) !== ring && Math.abs(j - j0) !== ring)) continue;
        for (const t of grid[i * nv + j]) {
          const l = bary(t, q);
          if (!l) continue;
          const out = Math.max(0, -l[0]) + Math.max(0, -l[1]) + Math.max(0, -l[2]);
          if (out < bestOut) {
            bestOut = out;
            const cl = [Math.max(0, l[0]), Math.max(0, l[1]), Math.max(0, l[2])], sum = cl[0] + cl[1] + cl[2] || 1;
            best = { t, w: [cl[0] / sum, cl[1] / sum, cl[2] / sum] };
          }
        }
      }
      // Inside one, or past the ring that could hold anything nearer.
      if (bestOut < 1e-9 || (bestOut < Infinity && ring * cell > bestOut * cell + 2 * cell)) break;
    }
    return best;
  };
}

/** The knife folds a pleated side asks for, on a seam `S` long (sorted along it). */
function knives(spec: GarmentFullness, kind: FullSide['kind'], ratio: number, x0: number, x1: number, thickness: number): Omit<Knife, 'sigma0'>[] {
  const S = x1 - x0;
  const n = Math.max(1, Math.round(spec.at?.length ?? spec.count ?? Math.max(1, S / 0.08)));
  const at = spec.at?.length ? spec.at.slice() : Array.from({ length: n }, (_, i) => (i + 0.5) / n);
  const extra = ((ratio - 1) * S) / at.length;
  const facing: 1 | -1 = spec.facing === 'left' ? -1 : 1;
  const out: Omit<Knife, 'sigma0'>[] = [];
  const fold = (x: number, d: number, dir: 1 | -1) => {
    // Its layers the fabric's thickness apart, the turns between them sharp:
    // an edge across a turn is crushed (below), as a crease is finer than the
    // mesh. Turns as round as the mesh could draw stood the layers a
    // centimetre apart, and the cloth on top had to climb and fall 3.6 cm
    // either side of every pleat, stretching a fifth as it did. Stood the
    // solver's contact thickness (4 mm) apart, the top layer, round a skirt
    // 20 cm in radius, was 4% longer round than it was cut, and pressed, held there.
    const r = Math.max(1e-4, Math.min(thickness / 2, (0.8 * d) / Math.PI));
    const xc = dir > 0 ? Math.min(x1, Math.max(x0 + d, x)) : Math.min(x1 - d, Math.max(x0, x));
    out.push({ x: xc, d, dir, r, L: d - Math.PI * r });
  };
  const pitch = S / at.length;
  for (const f of at) {
    const x = x0 + f * S;
    if (kind === 'knife') fold(x, extra / 2, facing);
    // A box pleat's two creases face away from each other, a face between; an inverted one's meet.
    else if (kind === 'box') { fold(x - pitch / 4, extra / 4, -1); fold(x + pitch / 4, extra / 4, 1); }
    else { fold(x - 1e-4, extra / 4, 1); fold(x + 1e-4, extra / 4, -1); }
  }
  return out.sort((a, b) => a.x - b.x);
}

/**
 * One wave of a gathered start, `period` of cloth long: its point at tau as
 * (fraction of a wave along the seam, out from the garment).
 */
function gatherWave(ratio: number, period: number): (tau: number) => V2 {
  const J0 = (phi: number) => { let m = 0; for (let i = 0; i < 64; i++) m += Math.cos(phi * Math.sin(((i + 0.5) / 64) * 2 * Math.PI)); return m / 64; };
  let lo = 0, hi = 2.4048;
  for (let it = 0; it < 50; it++) { const mid = (lo + hi) / 2; if (J0(mid) > 1 / ratio) lo = mid; else hi = mid; }
  const phiMax = (lo + hi) / 2, steps = 256, X = [0], Y = [0];
  for (let i = 0; i < steps; i++) {
    const phi = phiMax * Math.sin(((i + 0.5) / steps) * 2 * Math.PI), d = period / steps;
    X.push(X[i] + Math.cos(phi) * d); Y.push(Y[i] + Math.sin(phi) * d);
  }
  const Xp = X[steps];
  return (tau) => {
    const f = Math.max(0, Math.min(steps, (tau / period) * steps)), i = Math.min(steps - 1, Math.floor(f)), t = f - i;
    return [(X[i] + t * (X[i + 1] - X[i])) / Xp, Y[i] + t * (Y[i + 1] - Y[i])];
  };
}

/** A knife fold (facing +s) as a curve from its crease: along the seam and out from the garment, by cloth length tau in [0, 2d]. */
function knifeCurve(k: Knife, tau: number): V2 {
  const { r, L } = k, pr = Math.PI * r;
  if (tau < pr) { const f = tau / r; return [r * Math.sin(f), 3 * r + r * Math.cos(f)]; }
  if (tau < pr + L) return [-(tau - pr), 2 * r];
  if (tau < 2 * pr + L) { const f = (tau - pr - L) / r; return [-L - r * Math.sin(f), r + r * Math.cos(f)]; }
  return [-L + (tau - 2 * pr - L), 0];
}

/** `thickness`: the fabric's, metres: how far apart a pleat's layers lie. */
export function spreadPanel(shell: GarmentShell, k: number, piece: FlatPiece, sides: FullSide[], thickness = CLOTH_THICKNESS): SpreadPanel | null {
  const side = sides.find((s) => s.panel === k && s.kind !== 'ease');
  if (!side) return null;
  const n0 = shell.points.length, key = (a: number, b: number) => (a < b ? a * n0 + b : b * n0 + a);
  const { uv, tris, outline } = piece;
  const m = outline.length;
  // The seam on the piece: the outline's longest run of the side's edges.
  const onSeam = outline.map((l, i) => side.edges.has(key(piece.points[l], piece.points[outline[(i + 1) % m]])));
  let bestStart = -1, bestLen = 0;
  for (let i = 0; i < m; i++) {
    if (!onSeam[i] || onSeam[(i - 1 + m) % m]) continue;
    let len = 0;
    while (len < m && onSeam[(i + len) % m]) len++;
    if (len > bestLen) { bestLen = len; bestStart = i; }
  }
  if (bestStart < 0 || bestLen < 2) return null;
  // Run order: the outline goes round with the piece on its left; the seam
  // runs from the piece's left as seen from outside, so with the piece on its right.
  const runOutline = Array.from({ length: bestLen + 1 }, (_, j) => outline[(bestStart + j) % m]);
  const run = runOutline.slice().reverse();
  const W: V2[] = run.map((l) => [uv[l][0], uv[l][1]]);
  const s: number[] = [0];
  for (let i = 1; i < W.length; i++) s.push(s[i - 1] + Math.hypot(W[i][0] - W[i - 1][0], W[i][1] - W[i - 1][1]));
  const S = s[s.length - 1];
  // Mesh spacing: the piece's own (median edge, flat).
  const lens: number[] = [];
  for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 3; e++) { const a = uv[tris[t + e]], b = uv[tris[t + ((e + 1) % 3)]]; lens.push(Math.hypot(a[0] - b[0], a[1] - b[1])); }
  lens.sort((a, b) => a - b);
  const spacing = lens[Math.floor(lens.length / 2)];

  // ---- The spread: sigma as a function of s, and the seam as spread.
  // Only between the panel's other seams where they leave this one: a side
  // seam that leans in under the seam's end would otherwise be spread along
  // with the cloth (its length changed, and its points, shared with the next
  // panel, folded).
  const elsewhere = new Set<number>();
  shell.panels.forEach((p, kk) => { if (kk !== k) for (const t of p.tris) for (let cc = 0; cc < 3; cc++) elsewhere.add(shell.tris[3 * t + cc]); });
  const runInner = new Set(run.slice(1, -1));
  // The panel's other seams: those leaving the seam's ends (walked from each
  // end along the outline while they run away from it, not along it) bound the
  // stretch spread; any further off (a bodice's shoulders beyond its waist, a
  // yoke's other edge) the spread must have faded out before, pivoting there,
  // as a slash is spread to a point short of a seam it must not change.
  const proj = outline.map((l) => { const { s: x, p } = project(W, s, uv[l]); return { x, depth: Math.hypot(uv[l][0] - p[0], uv[l][1] - p[1]) }; });
  const shared = outline.map((l) => !runInner.has(l) && elsewhere.has(piece.points[l]));
  const sideOf = new Set<number>();
  for (const [startAt, step] of [[bestStart, -1], [(bestStart + bestLen) % m, 1]] as const) {
    sideOf.add(startAt);
    for (let j = 1, i = startAt; j < m; j++) {
      const next = (((startAt + step * j) % m) + m) % m;
      if (!shared[next]) break;
      const dd = proj[next].depth - proj[i].depth, ds = Math.abs(proj[next].x - proj[i].x);
      if (dd <= 0 || ds > dd) break;
      sideOf.add(next);
      i = next;
    }
  }
  let gL = 0, gR = S, fadeAt = Infinity;
  outline.forEach((_, i) => {
    if (!shared[i]) return;
    if (sideOf.has(i)) { const x = proj[i].x; if (x < S / 2) gL = Math.max(gL, x); else gR = Math.min(gR, x); } else fadeAt = Math.min(fadeAt, proj[i].depth);
  });
  // All of it at the seam, none at the far seam (a little short of it).
  const keep = (depth: number) => { if (!Number.isFinite(fadeAt)) return 1; const u = Math.min(1, depth / (0.85 * fadeAt)); return 1 - u * u * (3 - 2 * u); };
  const ratio = side.ratio;
  const gather = side.kind === 'gather';
  const ga = gather ? gL + Math.max(0, Math.min(1, side.spec.from ?? 0)) * (gR - gL) : 0, gb = gather ? gL + Math.max(0, Math.min(1, side.spec.to ?? 1)) * (gR - gL) : 0;
  const folds: Knife[] = gather ? [] : knives(side.spec, side.kind, ratio, gL, gR, thickness).map((f) => ({ ...f, sigma0: 0 }));
  // Breakpoints: the seam's own points, the gathered stretch's ends, the folds.
  const breaks = [...new Set([...s, ...(gather ? [ga, gb] : []), ...folds.map((f) => f.x)])].sort((a, b) => a - b);
  const tangent = (x: number): V2 => {
    let i = 0;
    while (i < W.length - 2 && s[i + 1] <= x) i++;
    const d = sub(W[i + 1], W[i]), l = Math.hypot(d[0], d[1]) || 1;
    return [d[0] / l, d[1] / l];
  };
  const c = (x0: number, x1: number) => (gather && x0 >= ga - 1e-12 && x1 <= gb + 1e-12 ? ratio : 1);
  // sigma at each breakpoint (the s->sigma map, a fold's strip as a flat step), and the spread seam's polyline.
  const mapS: number[] = [], mapSig: number[] = [];
  const Wp: V2[] = [[W[0][0], W[0][1]]], atp: number[] = [0];
  let sig = 0;
  mapS.push(0); mapSig.push(0);
  for (let i = 0; i < breaks.length; i++) {
    const x = breaks[i];
    if (i > 0) {
      const x0 = breaks[i - 1], T = tangent((x0 + x) / 2), dsig = (x - x0) * c(x0, x);
      const p = Wp[Wp.length - 1];
      Wp.push([p[0] + T[0] * dsig, p[1] + T[1] * dsig]);
      sig += dsig; atp.push(sig);
      mapS.push(x); mapSig.push(sig);
    }
    for (const f of folds) {
      if (f.x !== x) continue;
      f.sigma0 = sig;
      const T = tangent(x), p = Wp[Wp.length - 1];
      Wp.push([p[0] + T[0] * 2 * f.d, p[1] + T[1] * 2 * f.d]);
      sig += 2 * f.d; atp.push(sig);
      mapS.push(x); mapSig.push(sig);
    }
  }
  const Sp = sig;
  const sOf = (sigma: number) => interp(mapSig, mapS, sigma);
  const sigmaOf = (x: number) => {
    // Right-continuous: past a fold's strip once at its x.
    let lo = 0;
    while (lo < mapS.length - 1 && mapS[lo + 1] <= x) lo++;
    if (x <= 0) return x;
    if (x >= S) return Sp + (x - S);
    const span = mapS[lo + 1] - mapS[lo];
    return span > 1e-12 ? mapSig[lo] + ((x - mapS[lo]) / span) * (mapSig[lo + 1] - mapSig[lo]) : mapSig[lo + 1];
  };
  // Each point of the piece, spread: the same offset from the seam, at its sigma.
  // Faded (keep < 1), it moves only that share of the way.
  const fwd = uv.map((q) => {
    const { s: x, p } = project(W, s, q);
    const sigma = sigmaOf(x), w = pointAt(Wp, atp, sigma), off: V2 = [q[0] - p[0], q[1] - p[1]], k = keep(Math.hypot(off[0], off[1]));
    return { s: x, sigma, off, k, at: [q[0] + k * (w[0] + off[0] - q[0]), q[1] + k * (w[1] + off[1] - q[1])] as V2 };
  });
  const spread = (l: number): V2 => fwd[l].at;

  // ---- The spread outline: its own points kept but along the seam, which is the spread seam resampled.
  const seamKeys = new Set<number>();
  for (const sm of shell.seams) for (let i = 1; i < sm.path.length; i++) seamKeys.add(key(sm.path[i - 1], sm.path[i]));
  const runSet = new Set(runOutline.slice(1, -1));
  const first = (bestStart + bestLen) % m; // the run's last point in outline order: the walk starts there
  const edges: { id: string; pts: V2[] }[] = [], counts: Record<string, number> = {}, keptAt: number[] = [];
  for (let j = 0; j < m - bestLen; j++) {
    const a = outline[(first + j) % m], b = outline[(first + j + 1) % m];
    if (runSet.has(a)) continue;
    const pa = spread(a), pb = spread(b);
    const id = `e${edges.length}`;
    edges.push({ id, pts: [pa, pb] });
    keptAt.push(a);
    counts[id] = seamKeys.has(key(piece.points[a], piece.points[b])) ? 1 : Math.max(1, Math.round(Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) / spacing));
  }
  // The seam, back in outline order (from the run's first outline point to its last).
  const seamPts: V2[] = Wp.slice().reverse();
  edges.push({ id: 'seam', pts: seamPts });
  keptAt.push(runOutline[0]);
  counts.seam = Math.max(2, Math.round(Sp / spacing));
  const mesh = meshOutline(edges, spacing, counts);
  const N = mesh.uv.length;
  const points = new Array(N).fill(-1);
  edges.forEach((e, i) => { points[mesh.edgeVerts[e.id][0]] = piece.points[keptAt[i]]; });
  const seamVerts = mesh.edgeVerts.seam;

  // ---- Folded to start.
  const locate = locator(uv, tris);
  const shellNormal = vertexNormals(shell);
  const P = shell.points;
  const at3 = (q: number[]) => {
    const { t, w } = locate(q), ids = [tris[3 * t], tris[3 * t + 1], tris[3 * t + 2]].map((l) => piece.points[l]);
    const x = [0, 1, 2].map((cc) => w[0] * P[ids[0]][cc] + w[1] * P[ids[1]][cc] + w[2] * P[ids[2]][cc]);
    const nn = [0, 1, 2].map((cc) => w[0] * shellNormal[ids[0]][cc] + w[1] * shellNormal[ids[1]][cc] + w[2] * shellNormal[ids[2]][cc]);
    const nl = Math.hypot(nn[0], nn[1], nn[2]) || 1;
    return { x, n: [nn[0] / nl, nn[1] / nl, nn[2] / nl] };
  };
  // Gathers: whole waves over the gathered stretch, the cloth's direction
  // swinging to and fro (angle phiMax sin), so it runs at its own length all
  // the way: a zigzag does too, but a mesh point astride one of its corners
  // finds its neighbour across it half as far away. Six points a wave keeps an
  // edge's chord within ~10% of its arc; the mean of cos(phi), J0(phiMax), is
  // how far along the seam it gets for its length, 1 / ratio.
  const sa = sigmaOf(ga), sb = sigmaOf(gb);
  const period = gather ? (sb - sa) / Math.max(1, Math.round((sb - sa) / (6 * spacing))) : 1;
  // Further from the seam the piece may be wider (a flared skirt's rows grow
  // with the seam's turning), the same extra spread over more: gathered less.
  const turning = (() => {
    let th = 0;
    for (let i = 1; i < W.length - 1; i++) {
      if (s[i] <= ga || s[i] >= gb) continue;
      const a = sub(W[i], W[i - 1]), b = sub(W[i + 1], W[i]);
      th += Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]);
    }
    return th;
  })();
  const waves = new Map<number, (tau: number) => V2>();
  const waveAt = (depth: number) => {
    const Sg = Math.max(1e-6, gb - ga), row = Math.max(0.25 * Sg, Sg + depth * turning);
    const cd = Math.round((1 + ((ratio - 1) * Sg) / row) * 100) / 100;
    return waves.get(cd) ?? waves.set(cd, gatherWave(cd, period)).get(cd)!;
  };
  /** Along the seam (s) and out from the garment, where cloth at sigma starts. */
  const fold = (sigma: number, depth: number): { x: number; y: number; knife?: Knife } => {
    if (gather) {
      if (sigma <= sa || sigma >= sb) return { x: sOf(sigma), y: 0 };
      const nP = Math.floor((sigma - sa) / period), [wx, wy] = waveAt(depth)((sigma - sa) - nP * period);
      return { x: ga + (gb - ga) * ((nP + wx) * period) / (sb - sa), y: wy };
    }
    for (const f of folds) {
      if (sigma < f.sigma0 || sigma > f.sigma0 + 2 * f.d) continue;
      // Facing -s: the mirror image, its cloth run the other way.
      if (f.dir > 0) { const [dx, dy] = knifeCurve(f, sigma - f.sigma0); return { x: f.x + dx, y: dy, knife: f }; }
      const [dx, dy] = knifeCurve(f, f.sigma0 + 2 * f.d - sigma);
      return { x: f.x - dx, y: dy, knife: f };
    }
    // On top of a fold beside it: raised over its two layers, easing down past them.
    const x = sOf(sigma);
    let y = 0;
    for (const f of folds) {
      const reach = f.L + f.r, ramp = Math.max(2 * spacing, 6 * f.r);
      // How far short of the fold's under layers (negative: over them), for the cloth on its open side.
      const onTop = f.dir > 0 ? sigma < f.sigma0 : sigma > f.sigma0 + 2 * f.d;
      if (!onTop) continue;
      const beyond = f.dir > 0 ? f.x - reach - x : x - f.x - reach;
      if (beyond < -reach - 1e-9 || beyond >= ramp) continue;
      const t = beyond <= 0 ? 1 : 1 - beyond / ramp;
      y += 4 * f.r * t * t * (3 - 2 * t);
    }
    return { x, y };
  };
  let deepest = 0;
  if (gather) for (let i = 0; i <= 64; i++) deepest = Math.max(deepest, waveAt(0)((i / 64) * period)[1]);
  else for (const f of folds) deepest = Math.max(deepest, 4 * f.r);
  const rampDepth = Math.max(1.5 * spacing, 3 * deepest);
  const start: number[][] = [], normal: number[][] = [], foldAt: { sigma: number; off: V2; y: number; x: number; knife?: Knife; depth: number }[] = [];
  // Where each new point came from: found in the piece's own triangles as
  // spread, its sigma and offset from the seam between theirs (a pleat's strip
  // lies across triangles stretched over it). Projecting it back onto the
  // spread seam instead put points far down a flared side on the wrong slash.
  const fromSpread = locator(fwd.map((f) => f.at), tris);
  for (let i = 0; i < N; i++) {
    const { t: ft, w: fw } = fromSpread(mesh.uv[i]), fl = [tris[3 * ft], tris[3 * ft + 1], tris[3 * ft + 2]];
    const mix = (key: 'sigma' | 's' | 'k') => fw[0] * fwd[fl[0]][key] + fw[1] * fwd[fl[1]][key] + fw[2] * fwd[fl[2]][key];
    const sigma = mix('sigma'), sFlat = mix('s'), k = mix('k');
    const off: V2 = [0, 1].map((cc) => fw[0] * fwd[fl[0]].off[cc] + fw[1] * fwd[fl[1]].off[cc] + fw[2] * fwd[fl[2]].off[cc]) as V2;
    const depth = Math.hypot(off[0], off[1]);
    const f = fold(sigma, depth);
    // Flat at the seam itself, folds full below it, rising no steeper than
    // half their depth per unit down (steeper, the cloth between the seam and
    // the first row of folds started stretched by half); a pleat's layers at
    // the seam as close as the cloth's thickness lets them lie.
    const u = Math.min(1, depth / rampDepth), ramp = u * u * (3 - 2 * u);
    const atSeam = gather || !folds.length ? 0 : Math.min(1, thickness / (2 * folds[0].r));
    // Faded, folded only that much: along the seam between where it was cut and where the fold puts it.
    const y = k * f.y * (atSeam + (1 - atSeam) * ramp);
    // (Not sFlat plus the fold's shift from sOf(sigma): across a pleat's strip
    // sFlat runs on between its neighbours either side, where every point of
    // the strip was cut at the one s, and the layers came out up to half a
    // mesh step out of place, stretched by up to 45%.)
    const base = pointAt(W, s, (1 - k) * sFlat + k * f.x);
    const { x, n } = at3([base[0] + off[0], base[1] + off[1]]);
    start.push([x[0] + n[0] * y, x[1] + n[1] * y, x[2] + n[2] * y]);
    normal.push(n);
    foldAt.push({ sigma, off, y, x: f.x, knife: f.knife, depth });
  }
  // Kept points on another panel stay where the shell has them (they are at the
  // seam's ends or off it, where the fold is flat).
  const own = points.map((g) => g >= 0 && !elsewhere.has(g));
  points.forEach((g, i) => { if (g >= 0 && !own[i]) start[i] = P[g].slice(); });

  // ---- Sewn: each point along the seam to the other panel's triangle there.
  const seamTacks: SpreadPanel['seamTacks'] = [], seamStitches: SpreadPanel['seamStitches'] = [];
  const runG = run.map((l) => piece.points[l]);
  for (let j = 1; j < seamVerts.length - 1; j++) {
    const i = seamVerts[j], fa = foldAt[i];
    const x = Math.min(S, Math.max(0, fa.x));
    let seg = 0;
    while (seg < s.length - 2 && s[seg + 1] < x) seg++;
    const span = s[seg + 1] - s[seg], t = span > 1e-12 ? (x - s[seg]) / span : 0;
    const a = runG[seg], b = runG[seg + 1];
    seamStitches.push({ local: i, point: t < 0.5 ? a : b });
    seamTacks.push({ local: i, a, b, t, offset: fa.y, across: side.across.get(key(a, b)) ?? -1 });
  }
  const crushed: [number, number, number][] = [];
  const seamRow: [number, number][] = [];
  for (let j = 1; j < seamVerts.length; j++) { crushed.push([seamVerts[j - 1], seamVerts[j], 0.05]); seamRow.push([seamVerts[j - 1], seamVerts[j]]); }
  const near = gather ? 1 / ratio : 0.5;
  for (let t = 0; t < mesh.tris.length; t += 3) {
    const c3 = [mesh.tris[t], mesh.tris[t + 1], mesh.tris[t + 2]];
    if (Math.min(...c3.map((l) => foldAt[l].depth)) > 1.5 * spacing) continue;
    for (let e = 0; e < 3; e++) crushed.push([c3[e], c3[(e + 1) % 3], near]);
  }
  // Edges across a pleat's turns: their ends a layer apart.
  for (const f of folds) {
    const pr = Math.PI * f.r, turns = f.dir > 0 ? [[0, pr], [pr + f.L, 2 * pr + f.L]] : [[2 * f.d - pr, 2 * f.d], [2 * f.d - 2 * pr - f.L, 2 * f.d - pr - f.L]];
    for (let t = 0; t < mesh.tris.length; t += 3) for (let e = 0; e < 3; e++) {
      const a = mesh.tris[t + e], b = mesh.tris[t + ((e + 1) % 3)];
      const lo = Math.min(foldAt[a].sigma, foldAt[b].sigma) - f.sigma0, hi = Math.max(foldAt[a].sigma, foldAt[b].sigma) - f.sigma0;
      if (turns.some(([t0, t1]) => lo < t1 && hi > t0)) crushed.push([a, b, 0.1]);
    }
  }

  // ---- Pressed: a pleat's upper layers held to the layer under them, down to `stitched`.
  // The point under each is found where they start, on that layer's own
  // triangles: found in the spread piece instead, a mesh triangle there can
  // span two layers, and the point it gave lay up to 2 cm aside (median 8 mm)
  // from the one under it, which the tacks then held, stretching the cloth
  // round them by a quarter to a third.
  const pressTacks: SpreadPanel['pressTacks'] = [];
  const pressed = side.spec.stitched ?? 0;
  if (pressed > 0 && folds.length) {
    for (const f of folds) {
      const pr = Math.PI * f.r;
      // Its under layer, the one the cloth runs on in, by cloth length along the
      // fold, and that sheet on a little past the crease (where it comes out
      // from under): a narrow tuck's under layer alone had too few triangles
      // whole on it, and its pressing was lost.
      const [i0, i1] = f.dir > 0 ? [2 * pr + f.L, 2 * f.d + 2 * spacing] : [-2 * spacing, f.L];
      const under = (l: number) => { const tau = foldAt[l].sigma - f.sigma0; return tau >= i0 - 1e-9 && tau <= i1 + 1e-9; };
      const underTris: [number, number, number][] = [];
      for (let t = 0; t < mesh.tris.length; t += 3) {
        const tr = [mesh.tris[t], mesh.tris[t + 1], mesh.tris[t + 2]] as [number, number, number];
        if (tr.every(under) && tr.some((l) => foldAt[l].depth <= pressed + spacing)) underTris.push(tr);
      }
      if (!underTris.length) continue;
      for (let i = 0; i < N; i++) {
        const fa = foldAt[i];
        if (fa.depth > pressed || fa.y <= 0 || under(i)) continue;
        // Over this fold's under layer: its x within the run the layer makes.
        if (f.dir > 0 ? fa.x < f.x - f.L - 1e-9 || fa.x > f.x + 1e-9 : fa.x < f.x - 1e-9 || fa.x > f.x + f.L + 1e-9) continue;
        // (Held only along its crease, the stitched band's layers came apart
        // and the pleats below opened half as far: x1.25 near the hem against
        // 0.89 pressed through.)
        let best = Infinity, hit: { tri: [number, number, number]; w: [number, number, number]; at: number[] } | null = null;
        for (const tr of underTris) {
          if (tr.includes(i)) continue;
          const c = closestOnTriangle(start[i], start[tr[0]], start[tr[1]], start[tr[2]]);
          const d = Math.hypot(start[i][0] - c.at[0], start[i][1] - c.at[1], start[i][2] - c.at[2]);
          if (d < best) { best = d; hit = { tri: tr, w: c.w, at: c.at }; }
        }
        if (!hit) continue;
        // Wound outward, as a tack reads its triangle's normal; held as far off it as it starts.
        const [A, B, C] = hit.tri.map((l) => start[l]);
        const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
        const nn = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], nl = Math.hypot(nn[0], nn[1], nn[2]) || 1;
        const flip = nn[0] * normal[i][0] + nn[1] * normal[i][1] + nn[2] * normal[i][2] < 0, sg = flip ? -1 : 1;
        const off = sg * ((start[i][0] - hit.at[0]) * nn[0] + (start[i][1] - hit.at[1]) * nn[1] + (start[i][2] - hit.at[2]) * nn[2]) / nl;
        // Not over the layer's triangles (beside a turn, where none of them lie
        // under it): held to the nearest edge of them, it was pulled aside.
        const along = Math.sqrt(Math.max(0, best * best - off * off));
        if (along > 0.25 * spacing) continue;
        pressTacks.push({ local: i, tri: flip ? [hit.tri[0], hit.tri[2], hit.tri[1]] : hit.tri, bary: flip ? [hit.w[0], hit.w[2], hit.w[1]] : hit.w, offset: Math.max(0, off) });
      }
    }
  }
  // Unpressed pleats: set as folded down to their stitching, relaxing below
  // it over UNPRESS to what is left of the set (UNPRESSED_SET).
  const set = foldAt.map(({ depth }) => {
    if (gather || side.spec.pressed !== false) return 1;
    const u = Math.min(1, Math.max(0, (depth - pressed) / UNPRESS));
    return 1 - (1 - UNPRESSED_SET) * u * u * (3 - 2 * u);
  });
  const outlineOut = edges.flatMap((e) => mesh.edgeVerts[e.id].slice(0, -1));
  return { points, uv: mesh.uv.map(([u, v]) => [u, v] as V2), tris: mesh.tris, outline: outlineOut, start, normal, own, seamTacks, seamRow, ratio, pressTacks, crushed, seamStitches, set };
}

/** The point of triangle abc nearest p, and its barycentric weights. */
function closestOnTriangle(p: number[], a: number[], b: number[], c: number[]): { at: number[]; w: [number, number, number] } {
  const sub3 = (x: number[], y: number[]) => [x[0] - y[0], x[1] - y[1], x[2] - y[2]], dot3 = (x: number[], y: number[]) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const ab = sub3(b, a), ac = sub3(c, a), ap = sub3(p, a);
  const d1 = dot3(ab, ap), d2 = dot3(ac, ap);
  const at = (w: [number, number, number]) => ({ at: [0, 1, 2].map((k) => w[0] * a[k] + w[1] * b[k] + w[2] * c[k]), w });
  if (d1 <= 0 && d2 <= 0) return at([1, 0, 0]);
  const bp = sub3(p, b), d3 = dot3(ab, bp), d4 = dot3(ac, bp);
  if (d3 >= 0 && d4 <= d3) return at([0, 1, 0]);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return at([1 - v, v, 0]); }
  const cp = sub3(p, c), d5 = dot3(ab, cp), d6 = dot3(ac, cp);
  if (d6 >= 0 && d5 <= d6) return at([0, 0, 1]);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return at([1 - w, 0, w]); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); return at([0, 1 - w, w]); }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return at([1 - v - w, v, w]);
}

/** Each shell point's outward normal, area-weighted over its triangles. */
function vertexNormals(shell: GarmentShell): number[][] {
  const P = shell.points, n = P.map(() => [0, 0, 0]);
  for (let t = 0; t < shell.tris.length; t += 3) {
    const [a, b, c] = [shell.tris[t], shell.tris[t + 1], shell.tris[t + 2]];
    const u = [P[b][0] - P[a][0], P[b][1] - P[a][1], P[b][2] - P[a][2]], v = [P[c][0] - P[a][0], P[c][1] - P[a][1], P[c][2] - P[a][2]];
    const f = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    for (const i of [a, b, c]) for (let k = 0; k < 3; k++) n[i][k] += f[k];
  }
  return n.map((v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; });
}
