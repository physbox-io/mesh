/**
 * Cloth against itself: every particle stays clear of every triangle of its
 * own layer's cloth (its own piece, and the other pieces worn as the same
 * layer) that is not its neighbour on the cloth. A fold's two sides, pleats
 * and gathers, a sleeve against the body of its garment, two ribbon tails.
 *
 * Neighbours are by distance along the cloth, not in space: a point's own
 * triangles, and those of the points sewn or tacked to it. Any other triangle
 * is, on a flat sheet, a triangle's height away, so one nearer than the
 * separation is cloth folded back on itself or another piece.
 *
 * Two ways: the point and the triangle's corners each move by inverse mass
 * (the corners by barycentric weight), so a fold resting on a fold holds both.
 * The side is the one the point was on at the start of the substep, so cloth
 * that crosses within a substep is put back where it came from. Friction is on
 * the motion of the point relative to the triangle.
 *
 * Each sheet is a mesh, its triangles chords of the curved cloth: between
 * its points it strays from the true surface by up to its sagitta, L^2/8R
 * (an edge of length L whose two ends' normals differ by L/R strays L|dn|/8).
 * Two sheets kept a fabric's thickness apart (a pocket tacked on, a pleat
 * pressed on its underlay) cross wherever their triangles do not line up
 * once that is more than the gap. So each point keeps its half thickness
 * plus the sagitta of the edges round it, up to half the drawn slab
 * (CLOTH_THICKNESS): flat cloth keeps its thickness, curved cloth the gap its
 * mesh can hold. Tacks are held off by the same extra (xpbd solveTacks).
 *
 * Triangles go into a spatial hash rebuilt every few substeps with boxes grown
 * by how far cloth moves meanwhile, as the layer contacts do (clothLayers);
 * at each rebuild every point lists the triangles near it that are not its
 * neighbours, with how far each is, and between rebuilds only those are
 * tested, and of those only the ones it and they cannot have closed to within
 * reach since. Most of a garment lists none. Once the scene runs, a rebuild
 * waits until some point has strayed half the margin from the cloth's mean
 * motion: cloth at rest, or carried together, keeps its lists.
 */

import type { ClothModel } from './clothModel';
import { isLayeredPair } from './clothLayers';

const CELL = 0.03;
const INV_CELL = 1 / CELL;
const nextPow2 = (v: number) => {
  let p = 1024;
  while (p < v) p <<= 1;
  return p;
};
/** Substeps between remeasures of each point's gap (its sagitta). */
const REBUILD = 4;
/** How far cloth may move relative to itself between hash rebuilds: a rebuild comes once any point has strayed half this from the cloth's mean motion. */
const MOVE_MARGIN = 0.007;
/** Least separation between two sheets' middles, metres: thinner fabrics still keep this much. */
const MIN_SEP = 0.001;
/** How far through a triangle a point may be found and still be put back, past the separation. */
const MAX_DEPTH = 0.006;
/** Most a sheet's middle keeps off another's, counting its sagitta: half the slab cloth is drawn as. */
const MAX_HALF = 0.004 / 2; // CLOTH_THICKNESS / 2 (xpbd imports this module, so not imported back)

const hash = (ix: number, iy: number, iz: number, mask: number) => ((Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) >>> 0) & mask;

interface Group {
  /** Triangles, by global particle. */
  tris: Int32Array;
  /** Particles tested against them, global. */
  particles: Int32Array;
  /** Each particle's separation (half its sheet and half the other's are added per contact: here its own half). */
  half: Float64Array;
  mu: Float64Array;
  /** Each triangle's sheet half-thickness and friction. */
  triHalf: Float64Array;
  triMu: Float64Array;
  /** Piece index per tested particle and per triangle, and symmetric exclusion table for concentric `LayerContacts` pairs. */
  pPiece: Int32Array;
  tPiece: Int32Array;
  nPieces: number;
  layered: Uint8Array;
  /** Every particle of the group (global) and its sheet's half-thickness, for the sagitta. */
  all: Int32Array;
  allHalf: Float64Array;
  /** Neighbours of each particle (sorted, global) in CSR: near[nearStart[pi]..nearStart[pi+1]). */
  nearStart: Int32Array;
  near: Int32Array;
  buckets: number;
  mask: number;
  start: Int32Array;
  fill: Int32Array;
  range: Int32Array;
  entries: Int32Array;
  box: Float64Array;
  /** Largest separation in the group: how far a triangle's box is grown. */
  reach: number;
  /**
   * As of the last rebuild: the particles with any triangle near enough that is
   * not their neighbour (`active`, into `particles`), and those triangles, CSR.
   * Most of a garment has none; only these are tested each substep.
   */
  /** Unique undirected triangle edges (global particle pairs) for fast sagitta evaluation. */
  sagittaEdges: Int32Array;
  /** Per-triangle dedup stamp and generation counter for O(1) candidate deduplication. */
  triStamp: Int32Array;
  stampGen: number;
  active: Int32Array;
  activeCount: number;
  candStart: Int32Array;
  cand: Int32Array;
  /** Each candidate's distance from its particle at the rebuild. */
  candD: Float64Array;
  /** Where every particle of the group (`all`) was at the last hash rebuild; `built` once there has been one. */
  xb: Float64Array;
  built: boolean;
  /** Substeps since the last hash rebuild. */
  sinceHash: number;
}

export interface SelfPiece { model: ClothModel; base: number }

/**
 * Self contacts for every layer with cloth that self-collides. `links` are
 * extra zero-length joins between global particles (stitches across pieces).
 */
export class SelfContacts {
  private groups: Group[] = [];
  private w: Float64Array;
  private sinceBuild = REBUILD;
  /**
   * Per global particle: how much further than its half thickness it keeps
   * off other cloth, for the sagitta of the mesh round it (0 where flat, or
   * where its cloth does not self-collide). Tacks read it too.
   */
  readonly extra: Float64Array;
  private normal: Float64Array;
  /** Per global particle: how far it has moved since its group's last rebuild. */
  private moved: Float64Array;

  constructor(pieces: SelfPiece[], w: Float64Array, links: ArrayLike<number> = [], x?: Float64Array) {
    this.w = w;
    this.extra = new Float64Array(w.length);
    this.normal = new Float64Array(3 * w.length);
    this.moved = new Float64Array(w.length);
    const mine = pieces.filter((p) => p.model.selfCollide !== false);
    const g = buildGroup(mine, w, links);
    if (g) this.groups.push(g);
    if (x) for (const gr of this.groups) this.sagitta(gr, x);
  }

  /** Each particle's extra gap: its half thickness plus the sagitta of its edges, up to MAX_HALF. */
  private sagitta(g: Group, x: Float64Array) {
    const T = g.tris, N = this.normal, E = this.extra, all = g.all, allHalf = g.allHalf;
    for (let q = 0; q < all.length; q++) {
      const i = all[q], k = 3 * i;
      N[k] = 0; N[k + 1] = 0; N[k + 2] = 0; E[i] = 0;
    }
    for (let t = 0; t < T.length; t += 3) {
      const a = 3 * T[t], b = 3 * T[t + 1], c = 3 * T[t + 2];
      const ux = x[b] - x[a], uy = x[b + 1] - x[a + 1], uz = x[b + 2] - x[a + 2];
      const vx = x[c] - x[a], vy = x[c + 1] - x[a + 1], vz = x[c + 2] - x[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      N[a] += nx; N[a + 1] += ny; N[a + 2] += nz;
      N[b] += nx; N[b + 1] += ny; N[b + 2] += nz;
      N[c] += nx; N[c + 1] += ny; N[c + 2] += nz;
    }
    for (let q = 0; q < all.length; q++) {
      const k = 3 * all[q], nx = N[k], ny = N[k + 1], nz = N[k + 2];
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (l > 0) { const inv = 1 / l; N[k] = nx * inv; N[k + 1] = ny * inv; N[k + 2] = nz * inv; }
    }
    // Largest sagitta over each point's unique undirected triangle edges.
    const SE = g.sagittaEdges;
    for (let e = 0; e < SE.length; e += 2) {
      const i = SE[e], j = SE[e + 1], a = 3 * i, b = 3 * j;
      const dx = x[a] - x[b], dy = x[a + 1] - x[b + 1], dz = x[a + 2] - x[b + 2];
      const dnx = N[a] - N[b], dny = N[a + 1] - N[b + 1], dnz = N[a + 2] - N[b + 2];
      const s = 0.125 * Math.sqrt((dx * dx + dy * dy + dz * dz) * (dnx * dnx + dny * dny + dnz * dnz));
      if (s > E[i]) E[i] = s;
      if (s > E[j]) E[j] = s;
    }
    for (let q = 0; q < all.length; q++) {
      const i = all[q], h = allHalf[q];
      const v = Math.min(MAX_HALF, h + E[i]) - h;
      E[i] = v > 0 ? v : 0;
    }
  }

  get active() { return this.groups.length > 0; }

  /**
   * Keeps each particle clear of the non-neighbouring triangles of its layer,
   * both ways; `prev` is where everything was at the start of the substep.
   */
  collide(x: Float64Array, prev: Float64Array, step = true, live = false) {
    const remeasure = step && ++this.sinceBuild >= REBUILD;
    if (remeasure) this.sinceBuild = 0;
    const w = this.w;
    for (const g of this.groups) {
      const reach = acceptReach(g);
      if (remeasure) this.sagitta(g, x);
      // Every REBUILD substeps; once it runs (live), only if the cloth has
      // strayed since (at rest it keeps its lists, which then hold every
      // triangle that can come near: no point has moved the margin).
      if (step && (!g.built || (++g.sinceHash >= REBUILD && (!live || strayed(g, x))))) { build(g, x, g.reach + MAX_DEPTH + MOVE_MARGIN); candidates(g, x); g.sinceHash = 0; }
      movedSince(g, x, this.moved);
      const X = this.extra, CD = g.candD, mv = this.moved;
      const T = g.tris, C = g.cand, CS = g.candStart;
      // Nothing further than this can be put back (see acceptReach), so
      // nothing further can be the triangle that decides; a hair over it,
      // for the rounding of the distance against the bound.
      const reach2 = reach * reach * (1 + 1e-9), reachHair = reach * (1 + 1e-9) + 1e-12;
      for (let ai = 0; ai < g.activeCount; ai++) {
        const pi = g.active[ai], i = g.particles[pi], k = 3 * i;
        const px = x[k], py = x[k + 1], pz = x[k + 2];
        let best2 = reach2, bt = -1, bq0 = 0, bq1 = 0, bq2 = 0, bb1 = 0, bb2 = 0;
        const mp = mv[i];
        for (let e = CS[ai]; e < CS[ai + 1]; e++) {
          const t = C[e];
          // Its distance at the rebuild, less how far it and its corners have
          // moved since, is the least it can be now: past the reach, skip it.
          const t3 = 3 * t, ma = mv[T[t3]], mb = mv[T[t3 + 1]], mc = mv[T[t3 + 2]];
          if (CD[e] - mp - (ma > mb ? (ma > mc ? ma : mc) : (mb > mc ? mb : mc)) > reachHair) continue;
          closest(px, py, pz, x, 3 * T[3 * t], 3 * T[3 * t + 1], 3 * T[3 * t + 2], out);
          const dx = px - out[0], dy = py - out[1], dz = pz - out[2], d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= best2) continue;
          best2 = d2; bt = t; bq0 = out[0]; bq1 = out[1]; bq2 = out[2]; bb1 = out[3]; bb2 = out[4];
        }
        if (bt < 0) continue;
        const ia = T[3 * bt], ib = T[3 * bt + 1], ic = T[3 * bt + 2];
        const a = 3 * ia, bq = 3 * ib, c = 3 * ic;
        const ux = x[bq] - x[a], uy = x[bq + 1] - x[a + 1], uz = x[bq + 2] - x[a + 2];
        const vx = x[c] - x[a], vy = x[c + 1] - x[a + 1], vz = x[c + 2] - x[a + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (nl < 1e-14) continue;
        nx /= nl; ny /= nl; nz /= nl;
        const b0 = 1 - bb1 - bb2;
        // The side it was on: the point's start against where the triangle's point started.
        const qpx = b0 * prev[a] + bb1 * prev[bq] + bb2 * prev[c];
        const qpy = b0 * prev[a + 1] + bb1 * prev[bq + 1] + bb2 * prev[c + 1];
        const qpz = b0 * prev[a + 2] + bb1 * prev[bq + 2] + bb2 * prev[c + 2];
        const was = (prev[k] - qpx) * nx + (prev[k + 1] - qpy) * ny + (prev[k + 2] - qpz) * nz;
        if (was < 0) { nx = -nx; ny = -ny; nz = -nz; }
        const sep = g.half[pi] + X[i] + g.triHalf[bt] + b0 * X[ia] + bb1 * X[ib] + bb2 * X[ic];
        const sd = (px - bq0) * nx + (py - bq1) * ny + (pz - bq2) * nz;
        if (sd >= sep || sd < -MAX_DEPTH) continue;
        // Only a triangle the point is over (to within the separation): one
        // beside it on its own flat sheet is no fold, however near.
        if (best2 - sd * sd > sep * sep) continue;
        const wp = w[i], wa = w[ia], wb = w[ib], wc = w[ic];
        const den = wp + b0 * b0 * wa + bb1 * bb1 * wb + bb2 * bb2 * wc;
        if (den <= 0) continue;
        const lam = (sep - sd) / den;
        // Relative tangential motion over the substep, held by friction up to mu times the push.
        const rx = (x[k] - prev[k]) - (b0 * (x[a] - prev[a]) + bb1 * (x[bq] - prev[bq]) + bb2 * (x[c] - prev[c]));
        const ry = (x[k + 1] - prev[k + 1]) - (b0 * (x[a + 1] - prev[a + 1]) + bb1 * (x[bq + 1] - prev[bq + 1]) + bb2 * (x[c + 1] - prev[c + 1]));
        const rz = (x[k + 2] - prev[k + 2]) - (b0 * (x[a + 2] - prev[a + 2]) + bb1 * (x[bq + 2] - prev[bq + 2]) + bb2 * (x[c + 2] - prev[c + 2]));
        const rn = rx * nx + ry * ny + rz * nz;
        let tx = rx - rn * nx, ty = ry - rn * ny, tz = rz - rn * nz;
        const tl = Math.sqrt(tx * tx + ty * ty + tz * tz), hold = Math.min(g.mu[pi], g.triMu[bt]) * (sep - sd);
        if (tl > hold && tl > 0) { const s = hold / tl; tx *= s; ty *= s; tz *= s; }
        const fx = lam * nx - tx / den, fy = lam * ny - ty / den, fz = lam * nz - tz / den;
        x[k] += wp * fx; x[k + 1] += wp * fy; x[k + 2] += wp * fz;
        const sa = b0 * wa, sb = bb1 * wb, sc = bb2 * wc;
        x[a] -= sa * fx; x[a + 1] -= sa * fy; x[a + 2] -= sa * fz;
        x[bq] -= sb * fx; x[bq + 1] -= sb * fy; x[bq + 2] -= sb * fz;
        x[c] -= sc * fx; x[c + 1] -= sc * fy; x[c + 2] -= sc * fz;
        // Moved by this push as well, for the bound the later points read.
        const fl = Math.sqrt(fx * fx + fy * fy + fz * fz);
        mv[i] += wp * fl; mv[ia] += sa * fl; mv[ib] += sb * fl; mv[ic] += sc * fl;
      }
    }
  }
}

/**
 * Furthest a point can be from the triangle it is put back from: through it
 * by up to MAX_DEPTH (or short of it by the separation), and over it to
 * within the separation, which is at most the group's reach.
 */
const acceptReach = (g: Group) => Math.sqrt(Math.max(MAX_DEPTH, g.reach) ** 2 + g.reach * g.reach);

/** How far each point of the group has moved since the last rebuild, into `out` (by global particle). */
function movedSince(g: Group, x: Float64Array, out: Float64Array) {
  const all = g.all, xb = g.xb;
  for (let q = 0; q < all.length; q++) {
    const k = 3 * all[q], o = 3 * q, dx = x[k] - xb[o], dy = x[k + 1] - xb[o + 1], dz = x[k + 2] - xb[o + 2];
    out[all[q]] = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
}

/** Whether any point has strayed half the margin from the group's mean motion since the last hash rebuild. */
function strayed(g: Group, x: Float64Array): boolean {
  const all = g.all, xb = g.xb, n = all.length;
  let mx = 0, my = 0, mz = 0;
  for (let q = 0; q < n; q++) {
    const k = 3 * all[q], o = 3 * q;
    mx += x[k] - xb[o]; my += x[k + 1] - xb[o + 1]; mz += x[k + 2] - xb[o + 2];
  }
  const inv = 1 / Math.max(1, n);
  mx *= inv; my *= inv; mz *= inv;
  const lim2 = (0.5 * MOVE_MARGIN) ** 2;
  for (let q = 0; q < n; q++) {
    const k = 3 * all[q], o = 3 * q;
    const dx = x[k] - xb[o] - mx, dy = x[k + 1] - xb[o + 1] - my, dz = x[k + 2] - xb[o + 2] - mz;
    if (dx * dx + dy * dy + dz * dz > lim2) return true;
  }
  return false;
}

/**
 * Each particle's candidates from the hash just built: the triangles whose box
 * (grown by the reach and the margin) holds it, but for its own and its
 * neighbours' on the cloth, with how far each is from it now (candD); and
 * where every point is now (xb), and that none has moved since.
 */
function candidates(g: Group, x: Float64Array) {
  const all = g.all, xb = g.xb;
  for (let q = 0; q < all.length; q++) { const k = 3 * all[q], o = 3 * q; xb[o] = x[k]; xb[o + 1] = x[k + 1]; xb[o + 2] = x[k + 2]; }
  g.built = true;
  const T = g.tris, B = g.box, NS = g.nearStart, NR = g.near, mask = g.mask;
  const PP = g.pPiece, TP = g.tPiece, LP = g.layered, np = g.nPieces;
  const triStamp = g.triStamp;
  let stamp = g.stampGen;
  let count = 0, total = 0;
  g.candStart[0] = 0;
  for (let pi = 0; pi < g.particles.length; pi++) {
    const i = g.particles[pi], k = 3 * i, pRow = PP[pi] * np;
    const px = x[k], py = x[k + 1], pz = x[k + 2];
    const b = hash(Math.floor(px * INV_CELL), Math.floor(py * INV_CELL), Math.floor(pz * INV_CELL), mask);
    const e0 = g.start[b], e1 = g.start[b + 1];
    if (e0 === e1) continue;
    if (++stamp >= 0x7fffffff) { triStamp.fill(0); stamp = 1; }
    const n0 = NS[pi], n1 = NS[pi + 1], from = total;
    for (let e = e0; e < e1; e++) {
      const t = g.entries[e];
      if (triStamp[t] === stamp) continue;
      triStamp[t] = stamp;
      if (LP[pRow + TP[t]]) continue;
      const o = 6 * t;
      if (px < B[o] || py < B[o + 1] || pz < B[o + 2] || px > B[o + 3] || py > B[o + 4] || pz > B[o + 5]) continue;
      const ia = T[3 * t], ib = T[3 * t + 1], ic = T[3 * t + 2];
      if (has(NR, n0, n1, ia) || has(NR, n0, n1, ib) || has(NR, n0, n1, ic)) continue;
      closest(px, py, pz, x, 3 * ia, 3 * ib, 3 * ic, out);
      const dx = px - out[0], dy = py - out[1], dz = pz - out[2];
      if (total >= g.cand.length) {
        const grown = new Int32Array(Math.max(1024, g.cand.length * 2)); grown.set(g.cand); g.cand = grown;
        const grownD = new Float64Array(grown.length); grownD.set(g.candD); g.candD = grownD;
      }
      g.candD[total] = Math.sqrt(dx * dx + dy * dy + dz * dz);
      g.cand[total++] = t;
    }
    if (total > from) { g.active[count++] = pi; g.candStart[count] = total; }
  }
  g.stampGen = stamp;
  g.activeCount = count;
}

/** Binary search for v in sorted a[lo..hi). */
function has(a: Int32Array, lo: number, hi: number, v: number): boolean {
  while (lo < hi) {
    const m = (lo + hi) >> 1, x = a[m];
    if (x === v) return true;
    if (x < v) lo = m + 1; else hi = m;
  }
  return false;
}

function buildGroup(pieces: SelfPiece[], w: Float64Array, links: ArrayLike<number>): Group | null {
  if (!pieces.length) return null;
  const nPieces = pieces.length;
  const layered = new Uint8Array(nPieces * nPieces);
  for (let a = 0; a < nPieces; a++) {
    for (let b = a + 1; b < nPieces; b++) {
      if (isLayeredPair(pieces[a].model, pieces[b].model) || isLayeredPair(pieces[b].model, pieces[a].model)) {
        layered[a * nPieces + b] = 1;
        layered[b * nPieces + a] = 1;
      }
    }
  }
  // Global indices of the particles, and a local numbering for the walk.
  const local = new Map<number, number>(), glob: number[] = [], halfOf: number[] = [], muOf: number[] = [], pieceOf: number[] = [];
  pieces.forEach(({ model, base }, pIdx) => {
    const half = Math.max(MIN_SEP, model.material.thickness) / 2;
    for (let i = 0; i < model.invMass.length; i++) {
      local.set(base + i, glob.length); glob.push(base + i); halfOf.push(half); muOf.push(model.material.friction); pieceOf.push(pIdx);
    }
  });
  const n = glob.length;
  // Adjacency: mesh edges at their cut lengths; stitches and tacks at none.
  const adj: [number, number][][] = Array.from({ length: n }, () => []);
  const join = (ga: number, gb: number, len: number) => {
    const a = local.get(ga), b = local.get(gb);
    if (a === undefined || b === undefined || a === b) return;
    adj[a].push([b, len]); adj[b].push([a, len]);
  };
  const tris: number[] = [], triHalf: number[] = [], triMu: number[] = [], tPiece: number[] = [];
  pieces.forEach(({ model, base }, pIdx) => {
    for (let e = 0; e < model.edges.length; e += 2) {
      join(base + model.edges[e], base + model.edges[e + 1], model.edgeRest[e / 2]);
    }
    for (let s = 0; s < model.stitches.length; s += 2) join(base + model.stitches[s], base + model.stitches[s + 1], 0);
    // A zip's two sides at each tooth, done up or not: they meet where it is shut, and the slider runs them together.
    for (const z of model.zips ?? []) for (let s = 0; s < z.pairs.length; s += 2) join(base + z.pairs[s], base + z.pairs[s + 1], 0);
    for (const tk of model.tacks ?? []) for (const q of tk.tri) join(base + tk.particle, base + q, 0);
    const half = Math.max(MIN_SEP, model.material.thickness) / 2;
    for (let t = 0; t < model.tris.length; t += 3) {
      tris.push(base + model.tris[t], base + model.tris[t + 1], base + model.tris[t + 2]);
      triHalf.push(half);
      triMu.push(model.material.friction);
      tPiece.push(pIdx);
    }
  });
  for (let s = 0; s + 1 < links.length; s += 2) join(links[s], links[s + 1], 0);
  let maxHalf = MAX_HALF;
  for (const h of halfOf) maxHalf = Math.max(maxHalf, h);
  // Each moving point's neighbours: itself and what is sewn or tacked to it
  // (joined at no length), and anything nearer along the cloth than 1.5 times
  // its sheet separation. Its own triangles are skipped; any other, on a flat sheet,
  // is a triangle's height away (edges are millimetres to centimetres, the
  // separation about one), so nearer than the separation is a fold. A wider
  // radius (the separation plus the longest edge near, 2-3 cm) let the two
  // sides of a sharply folded seam (a crotch, a collar's roll, a gathered
  // waist) pass through each other: they were neighbours.
  const particles: number[] = [], half: number[] = [], mu: number[] = [], pPiece: number[] = [], nearStart: number[] = [0], near: number[] = [];
  const dist = new Float64Array(n).fill(Infinity), seen: number[] = [];
  for (let s = 0; s < n; s++) {
    if (!(w[glob[s]] > 0)) continue;
    const radius = 1.5 * 2 * halfOf[s];
    // Dijkstra over a small ball: a plain array as the frontier is fast enough at this size.
    const frontier: number[] = [s];
    dist[s] = 0; seen.push(s);
    while (frontier.length) {
      let bi = 0;
      for (let f = 1; f < frontier.length; f++) if (dist[frontier[f]] < dist[frontier[bi]]) bi = f;
      const u = frontier[bi];
      frontier[bi] = frontier[frontier.length - 1]; frontier.pop();
      for (const [v, len] of adj[u]) {
        const d = dist[u] + len;
        if (d > radius || d >= dist[v]) continue;
        if (dist[v] === Infinity) seen.push(v);
        dist[v] = d;
        frontier.push(v);
      }
    }
    const ball = seen.map((q) => glob[q]).sort((a, b) => a - b);
    for (const q of seen) dist[q] = Infinity;
    seen.length = 0;
    particles.push(glob[s]); half.push(halfOf[s]); mu.push(muOf[s]); pPiece.push(pieceOf[s]);
    for (const q of ball) near.push(q);
    nearStart.push(near.length);
  }
  if (!particles.length || !tris.length) return null;
  const nt = tris.length / 3;
  const buckets = nextPow2(Math.max(1024, 2 * nt));
  // Unique undirected triangle edges for sagitta pass (halves edge work on interior edges).
  const seenEdge = new Set<number>(), sagEdges: number[] = [];
  const stride = Math.max(1, w.length);
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t], b = tris[t + 1], c = tris[t + 2];
    const k0 = a < b ? a * stride + b : b * stride + a;
    if (!seenEdge.has(k0)) { seenEdge.add(k0); sagEdges.push(a, b); }
    const k1 = b < c ? b * stride + c : c * stride + b;
    if (!seenEdge.has(k1)) { seenEdge.add(k1); sagEdges.push(b, c); }
    const k2 = c < a ? c * stride + a : a * stride + c;
    if (!seenEdge.has(k2)) { seenEdge.add(k2); sagEdges.push(c, a); }
  }
  return {
    tris: Int32Array.from(tris), particles: Int32Array.from(particles), half: Float64Array.from(half), mu: Float64Array.from(mu),
    triHalf: Float64Array.from(triHalf), triMu: Float64Array.from(triMu),
    pPiece: Int32Array.from(pPiece), tPiece: Int32Array.from(tPiece), nPieces, layered,
    all: Int32Array.from(glob), allHalf: Float64Array.from(halfOf), nearStart: Int32Array.from(nearStart), near: Int32Array.from(near),
    buckets, mask: buckets - 1,
    start: new Int32Array(buckets + 1), fill: new Int32Array(buckets), range: new Int32Array(nt * 6), entries: new Int32Array(0), box: new Float64Array(nt * 6),
    reach: 2 * maxHalf,
    sagittaEdges: Int32Array.from(sagEdges), triStamp: new Int32Array(nt), stampGen: 0,
    active: new Int32Array(particles.length), activeCount: 0, candStart: new Int32Array(particles.length + 1), cand: new Int32Array(1024), candD: new Float64Array(1024),
    xb: new Float64Array(3 * glob.length), built: false, sinceHash: 0,
  };
}

/** The hash of the group's triangles, by counting sort into buckets. */
function build(g: Group, x: Float64Array, reach: number) {
  const T = g.tris, nt = T.length / 3, start = g.start, fill = g.fill, range = g.range, B = g.box, buckets = g.buckets, mask = g.mask;
  start.fill(0);
  let total = 0;
  for (let t = 0; t < nt; t++) {
    const a = 3 * T[3 * t], b = 3 * T[3 * t + 1], c = 3 * T[3 * t + 2], o = 6 * t;
    const ax = x[a], bx = x[b], cx = x[c];
    const loX = (ax < bx ? (ax < cx ? ax : cx) : (bx < cx ? bx : cx)) - reach;
    const hiX = (ax > bx ? (ax > cx ? ax : cx) : (bx > cx ? bx : cx)) + reach;
    const ay = x[a + 1], by = x[b + 1], cy = x[c + 1];
    const loY = (ay < by ? (ay < cy ? ay : cy) : (by < cy ? by : cy)) - reach;
    const hiY = (ay > by ? (ay > cy ? ay : cy) : (by > cy ? by : cy)) + reach;
    const az = x[a + 2], bz = x[b + 2], cz = x[c + 2];
    const loZ = (az < bz ? (az < cz ? az : cz) : (bz < cz ? bz : cz)) - reach;
    const hiZ = (az > bz ? (az > cz ? az : cz) : (bz > cz ? bz : cz)) + reach;
    B[o] = loX; B[o + 1] = loY; B[o + 2] = loZ; B[o + 3] = hiX; B[o + 4] = hiY; B[o + 5] = hiZ;
    const ix0 = Math.floor(loX * INV_CELL), ix1 = Math.floor(hiX * INV_CELL);
    const iy0 = Math.floor(loY * INV_CELL), iy1 = Math.floor(hiY * INV_CELL);
    const iz0 = Math.floor(loZ * INV_CELL), iz1 = Math.floor(hiZ * INV_CELL);
    range[o] = ix0; range[o + 1] = iy0; range[o + 2] = iz0; range[o + 3] = ix1; range[o + 4] = iy1; range[o + 5] = iz1;
    for (let ix = ix0; ix <= ix1; ix++) for (let iy = iy0; iy <= iy1; iy++) for (let iz = iz0; iz <= iz1; iz++) {
      start[hash(ix, iy, iz, mask) + 1]++; total++;
    }
  }
  for (let b = 0; b < buckets; b++) start[b + 1] += start[b];
  if (g.entries.length < total) g.entries = new Int32Array(Math.ceil(total * 1.25));
  fill.set(start.subarray(0, buckets));
  for (let t = 0; t < nt; t++) {
    const o = 6 * t;
    const ix0 = range[o], iy0 = range[o + 1], iz0 = range[o + 2], ix1 = range[o + 3], iy1 = range[o + 4], iz1 = range[o + 5];
    for (let ix = ix0; ix <= ix1; ix++) for (let iy = iy0; iy <= iy1; iy++) for (let iz = iz0; iz <= iz1; iz++) {
      g.entries[fill[hash(ix, iy, iz, mask)]++] = t;
    }
  }
}

/** Closest point and its barycentric (b1, b2) on triangle (a, b, c), offsets into x, to p: o = [x, y, z, b1, b2]. */
const out = [0, 0, 0, 0, 0];
function closest(px: number, py: number, pz: number, x: Float64Array, a: number, b: number, c: number, o: number[]) {
  const ax = x[a], ay = x[a + 1], az = x[a + 2];
  const abx = x[b] - ax, aby = x[b + 1] - ay, abz = x[b + 2] - az, acx = x[c] - ax, acy = x[c + 1] - ay, acz = x[c + 2] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { o[0] = ax; o[1] = ay; o[2] = az; o[3] = 0; o[4] = 0; return; }
  const bpx = px - x[b], bpy = py - x[b + 1], bpz = pz - x[b + 2];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { o[0] = x[b]; o[1] = x[b + 1]; o[2] = x[b + 2]; o[3] = 1; o[4] = 0; return; }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); o[0] = ax + abx * v; o[1] = ay + aby * v; o[2] = az + abz * v; o[3] = v; o[4] = 0; return; }
  const cpx = px - x[c], cpy = py - x[c + 1], cpz = pz - x[c + 2];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { o[0] = x[c]; o[1] = x[c + 1]; o[2] = x[c + 2]; o[3] = 0; o[4] = 1; return; }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const ww = d2 / (d2 - d6); o[0] = ax + acx * ww; o[1] = ay + acy * ww; o[2] = az + acz * ww; o[3] = 0; o[4] = ww; return; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const ww = (d4 - d3) / (d4 - d3 + (d5 - d6)), v = 1 - ww;
    o[0] = ax + abx * v + acx * ww; o[1] = ay + aby * v + acy * ww; o[2] = az + abz * v + acz * ww; o[3] = v; o[4] = ww;
    return;
  }
  const den = 1 / (va + vb + vc), v = vb * den, ww = vc * den;
  o[0] = ax + abx * v + acx * ww; o[1] = ay + aby * v + acy * ww; o[2] = az + abz * v + acz * ww; o[3] = v; o[4] = ww;
}
