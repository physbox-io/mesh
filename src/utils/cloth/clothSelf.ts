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
 * neighbours, and between rebuilds only those are tested. Most of a garment
 * lists none.
 */

import type { ClothModel } from './clothModel';

const CELL = 0.03;
const BUCKETS = 1 << 17;
const REBUILD = 4;
/** How far cloth may move between rebuilds: 4 substeps at 1 m/s relative is under 7 mm. */
const MOVE_MARGIN = 0.007;
/** Least separation between two sheets' middles, metres: thinner fabrics still keep this much. */
const MIN_SEP = 0.001;
/** How far through a triangle a point may be found and still be put back, past the separation. */
const MAX_DEPTH = 0.006;
/** Most a sheet's middle keeps off another's, counting its sagitta: half the slab cloth is drawn as. */
const MAX_HALF = 0.004 / 2; // CLOTH_THICKNESS / 2 (xpbd imports this module, so not imported back)

const NOGAP = Boolean((globalThis as { process?: { env?: Record<string, string> } }).process?.env?.CLOTH_NOGAP); // MEASURE-ONLY, remove
const hash = (ix: number, iy: number, iz: number) => ((Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) >>> 0) & (BUCKETS - 1);

interface Group {
  /** Triangles, by global particle. */
  tris: Int32Array;
  /** Particles tested against them, global. */
  particles: Int32Array;
  /** Each particle's separation (half its sheet and half the other's are added per contact: here its own half). */
  half: Float64Array;
  mu: Float64Array;
  /** Each triangle's sheet half-thickness. */
  triHalf: Float64Array;
  /** Every particle of the group (global) and its sheet's half-thickness, for the sagitta. */
  all: Int32Array;
  allHalf: Float64Array;
  /** Neighbours of each particle (sorted, global) in CSR: near[nearStart[pi]..nearStart[pi+1]). */
  nearStart: Int32Array;
  near: Int32Array;
  start: Int32Array;
  entries: Int32Array;
  box: Float64Array;
  /** Largest separation in the group: how far a triangle's box is grown. */
  reach: number;
  /**
   * As of the last rebuild: the particles with any triangle near enough that is
   * not their neighbour (`active`, into `particles`), and those triangles, CSR.
   * Most of a garment has none; only these are tested each substep.
   */
  active: Int32Array;
  activeCount: number;
  candStart: Int32Array;
  cand: Int32Array;
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

  constructor(pieces: SelfPiece[], w: Float64Array, links: ArrayLike<number> = [], x?: Float64Array) {
    this.w = w;
    this.extra = new Float64Array(w.length);
    this.normal = new Float64Array(3 * w.length);
    const layers = [...new Set(pieces.filter((p) => p.model.selfCollide !== false).map((p) => p.model.layer))];
    for (const layer of layers) {
      const mine = pieces.filter((p) => p.model.layer === layer && p.model.selfCollide !== false);
      const g = buildGroup(mine, w, links);
      if (g) this.groups.push(g);
    }
    if (x) for (const g of this.groups) this.sagitta(g, x);
  }

  /** Each particle's extra gap: its half thickness plus the sagitta of its edges, up to MAX_HALF. */
  private sagitta(g: Group, x: Float64Array) {
    const T = g.tris, N = this.normal, E = this.extra;
    for (const i of g.all) { N[3 * i] = 0; N[3 * i + 1] = 0; N[3 * i + 2] = 0; E[i] = 0; }
    for (let t = 0; t < T.length; t += 3) {
      const a = 3 * T[t], b = 3 * T[t + 1], c = 3 * T[t + 2];
      const ux = x[b] - x[a], uy = x[b + 1] - x[a + 1], uz = x[b + 2] - x[a + 2];
      const vx = x[c] - x[a], vy = x[c + 1] - x[a + 1], vz = x[c + 2] - x[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const q of [a, b, c]) { N[q] += nx; N[q + 1] += ny; N[q + 2] += nz; }
    }
    for (const i of g.all) {
      const k = 3 * i, l = Math.hypot(N[k], N[k + 1], N[k + 2]);
      if (l > 0) { N[k] /= l; N[k + 1] /= l; N[k + 2] /= l; }
    }
    // Largest sagitta over each point's edges (each interior edge is seen twice; harmless).
    for (let t = 0; t < T.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const i = T[t + e], j = T[t + (e + 1) % 3], a = 3 * i, b = 3 * j;
        const L = Math.hypot(x[a] - x[b], x[a + 1] - x[b + 1], x[a + 2] - x[b + 2]);
        const s = (L * Math.hypot(N[a] - N[b], N[a + 1] - N[b + 1], N[a + 2] - N[b + 2])) / 8;
        if (s > E[i]) E[i] = s;
        if (s > E[j]) E[j] = s;
      }
    }
    const off = NOGAP; // MEASURE-ONLY, remove
    for (let q = 0; q < g.all.length; q++) {
      const i = g.all[q], h = g.allHalf[q];
      if (off) { E[i] = 0; continue; }
      E[i] = Math.max(0, Math.min(MAX_HALF, h + E[i]) - h);
    }
  }

  get active() { return this.groups.length > 0; }

  /**
   * Keeps each particle clear of the non-neighbouring triangles of its layer,
   * both ways; `prev` is where everything was at the start of the substep.
   */
  collide(x: Float64Array, prev: Float64Array, step = true) {
    const rebuild = step && ++this.sinceBuild >= REBUILD;
    if (rebuild) this.sinceBuild = 0;
    const w = this.w;
    for (const g of this.groups) {
      const reach = g.reach + MAX_DEPTH;
      if (rebuild) { this.sagitta(g, x); build(g, x, reach + MOVE_MARGIN); candidates(g, x); }
      const X = this.extra;
      const T = g.tris, C = g.cand, CS = g.candStart;
      for (let ai = 0; ai < g.activeCount; ai++) {
        const pi = g.active[ai], i = g.particles[pi], k = 3 * i;
        const px = x[k], py = x[k + 1], pz = x[k + 2];
        let best = reach, bt = -1, bq0 = 0, bq1 = 0, bq2 = 0, bb1 = 0, bb2 = 0;
        for (let e = CS[ai]; e < CS[ai + 1]; e++) {
          const t = C[e];
          closest(px, py, pz, x, 3 * T[3 * t], 3 * T[3 * t + 1], 3 * T[3 * t + 2], out);
          const dx = px - out[0], dy = py - out[1], dz = pz - out[2], d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d >= best) continue;
          best = d; bt = t; bq0 = out[0]; bq1 = out[1]; bq2 = out[2]; bb1 = out[3]; bb2 = out[4];
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
        if (!NOGAP && best * best - sd * sd > sep * sep) continue;
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
        const tl = Math.sqrt(tx * tx + ty * ty + tz * tz), hold = g.mu[pi] * (sep - sd);
        if (tl > hold && tl > 0) { const s = hold / tl; tx *= s; ty *= s; tz *= s; }
        const fx = lam * nx - tx / den, fy = lam * ny - ty / den, fz = lam * nz - tz / den;
        x[k] += wp * fx; x[k + 1] += wp * fy; x[k + 2] += wp * fz;
        const sa = b0 * wa, sb = bb1 * wb, sc = bb2 * wc;
        x[a] -= sa * fx; x[a + 1] -= sa * fy; x[a + 2] -= sa * fz;
        x[bq] -= sb * fx; x[bq + 1] -= sb * fy; x[bq + 2] -= sb * fz;
        x[c] -= sc * fx; x[c + 1] -= sc * fy; x[c + 2] -= sc * fz;
      }
    }
  }
}

/**
 * Each particle's candidates from the hash just built: the triangles whose box
 * (grown by the reach and the margin) holds it, but for its own and its
 * neighbours' on the cloth.
 */
function candidates(g: Group, x: Float64Array) {
  const T = g.tris, B = g.box, NS = g.nearStart, NR = g.near;
  let count = 0, total = 0;
  g.candStart[0] = 0;
  for (let pi = 0; pi < g.particles.length; pi++) {
    const i = g.particles[pi], k = 3 * i;
    const px = x[k], py = x[k + 1], pz = x[k + 2];
    const b = hash(Math.floor(px / CELL), Math.floor(py / CELL), Math.floor(pz / CELL));
    const n0 = NS[pi], n1 = NS[pi + 1], from = total;
    for (let e = g.start[b]; e < g.start[b + 1]; e++) {
      const t = g.entries[e], o = 6 * t;
      if (px < B[o] || py < B[o + 1] || pz < B[o + 2] || px > B[o + 3] || py > B[o + 4] || pz > B[o + 5]) continue;
      const ia = T[3 * t], ib = T[3 * t + 1], ic = T[3 * t + 2];
      if (has(NR, n0, n1, ia) || has(NR, n0, n1, ib) || has(NR, n0, n1, ic)) continue;
      // Two cells hashed to one bucket enter a triangle twice.
      let dup = false;
      for (let q = from; q < total; q++) if (g.cand[q] === t) { dup = true; break; }
      if (dup) continue;
      if (total >= g.cand.length) { const grown = new Int32Array(Math.max(1024, g.cand.length * 2)); grown.set(g.cand); g.cand = grown; }
      g.cand[total++] = t;
    }
    if (total > from) { g.active[count++] = pi; g.candStart[count] = total; }
  }
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
  // Global indices of the layer's particles, and a local numbering for the walk.
  const local = new Map<number, number>(), glob: number[] = [], halfOf: number[] = [], muOf: number[] = [];
  for (const { model, base } of pieces) {
    const half = Math.max(MIN_SEP, model.material.thickness) / 2;
    for (let i = 0; i < model.invMass.length; i++) { local.set(base + i, glob.length); glob.push(base + i); halfOf.push(half); muOf.push(model.material.friction); }
  }
  const n = glob.length;
  // Adjacency: mesh edges at their cut lengths; stitches and tacks at none.
  const adj: [number, number][][] = Array.from({ length: n }, () => []);
  const join = (ga: number, gb: number, len: number) => {
    const a = local.get(ga), b = local.get(gb);
    if (a === undefined || b === undefined || a === b) return;
    adj[a].push([b, len]); adj[b].push([a, len]);
  };
  const tris: number[] = [], triHalf: number[] = [];
  for (const { model, base } of pieces) {
    for (let e = 0; e < model.edges.length; e += 2) {
      join(base + model.edges[e], base + model.edges[e + 1], model.edgeRest[e / 2]);
    }
    for (let s = 0; s < model.stitches.length; s += 2) join(base + model.stitches[s], base + model.stitches[s + 1], 0);
    // A zip's two sides at each tooth, done up or not: they meet where it is shut, and the slider runs them together.
    for (const z of model.zips ?? []) for (let s = 0; s < z.pairs.length; s += 2) join(base + z.pairs[s], base + z.pairs[s + 1], 0);
    for (const tk of model.tacks ?? []) for (const q of tk.tri) join(base + tk.particle, base + q, 0);
    const half = Math.max(MIN_SEP, model.material.thickness) / 2;
    for (let t = 0; t < model.tris.length; t += 3) { tris.push(base + model.tris[t], base + model.tris[t + 1], base + model.tris[t + 2]); triHalf.push(half); }
  }
  for (let s = 0; s + 1 < links.length; s += 2) join(links[s], links[s + 1], 0);
  let maxHalf = 0;
  for (const h of halfOf) maxHalf = Math.max(maxHalf, h);
  const thickHalf = maxHalf;
  maxHalf = Math.max(maxHalf, MAX_HALF);
  // Each moving point's neighbours: itself and what is sewn or tacked to it
  // (joined at no length), and anything nearer along the cloth than 1.5 times
  // the separation. Its own triangles are skipped; any other, on a flat sheet,
  // is a triangle's height away (edges are millimetres to centimetres, the
  // separation about one), so nearer than the separation is a fold. A wider
  // radius (the separation plus the longest edge near, 2-3 cm) let the two
  // sides of a sharply folded seam (a crotch, a collar's roll, a gathered
  // waist) pass through each other: they were neighbours.
  const particles: number[] = [], half: number[] = [], mu: number[] = [], nearStart: number[] = [0], near: number[] = [];
  const dist = new Float64Array(n).fill(Infinity), seen: number[] = [];
  for (let s = 0; s < n; s++) {
    if (!(w[glob[s]] > 0)) continue;
    const radius = 1.5 * 2 * thickHalf;
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
    particles.push(glob[s]); half.push(halfOf[s]); mu.push(muOf[s]);
    for (const q of ball) near.push(q);
    nearStart.push(near.length);
  }
  if (!particles.length || !tris.length) return null;
  return {
    tris: Int32Array.from(tris), particles: Int32Array.from(particles), half: Float64Array.from(half), mu: Float64Array.from(mu),
    triHalf: Float64Array.from(triHalf), all: Int32Array.from(glob), allHalf: Float64Array.from(halfOf), nearStart: Int32Array.from(nearStart), near: Int32Array.from(near),
    start: new Int32Array(BUCKETS + 1), entries: new Int32Array(0), box: new Float64Array((tris.length / 3) * 6),
    reach: 2 * maxHalf,
    active: new Int32Array(particles.length), activeCount: 0, candStart: new Int32Array(particles.length + 1), cand: new Int32Array(1024),
  };
}

/** The hash of the group's triangles, by counting sort into buckets. */
function build(g: Group, x: Float64Array, reach: number) {
  const T = g.tris, nt = T.length / 3, start = g.start, B = g.box;
  start.fill(0);
  const range = new Int32Array(nt * 6);
  let total = 0;
  for (let t = 0; t < nt; t++) {
    const a = 3 * T[3 * t], b = 3 * T[3 * t + 1], c = 3 * T[3 * t + 2], o = 6 * t;
    for (let k = 0; k < 3; k++) {
      B[o + k] = Math.min(x[a + k], x[b + k], x[c + k]) - reach;
      B[o + 3 + k] = Math.max(x[a + k], x[b + k], x[c + k]) + reach;
      range[o + k] = Math.floor(B[o + k] / CELL);
      range[o + 3 + k] = Math.floor(B[o + 3 + k] / CELL);
    }
    for (let ix = range[o]; ix <= range[o + 3]; ix++) for (let iy = range[o + 1]; iy <= range[o + 4]; iy++) for (let iz = range[o + 2]; iz <= range[o + 5]; iz++) {
      start[hash(ix, iy, iz) + 1]++; total++;
    }
  }
  for (let b = 0; b < BUCKETS; b++) start[b + 1] += start[b];
  if (g.entries.length < total) g.entries = new Int32Array(Math.ceil(total * 1.25));
  const fill = start.slice(0, BUCKETS);
  for (let t = 0; t < nt; t++) {
    const o = 6 * t;
    for (let ix = range[o]; ix <= range[o + 3]; ix++) for (let iy = range[o + 1]; iy <= range[o + 4]; iy++) for (let iz = range[o + 2]; iz <= range[o + 5]; iz++) {
      g.entries[fill[hash(ix, iy, iz)]++] = t;
    }
  }
}

/** Closest point and its barycentric (b1, b2) on triangle (a, b, c), offsets into x, to p: o = [x, y, z, b1, b2]. */
const out = [0, 0, 0, 0, 0];
function closest(px: number, py: number, pz: number, x: Float64Array, a: number, b: number, c: number, o: number[]) {
  const ax = x[a], ay = x[a + 1], az = x[a + 2];
  const abx = x[b] - ax, aby = x[b + 1] - ay, abz = x[b + 2] - az, acx = x[c] - ax, acy = x[c + 1] - ay, acz = x[c + 2] - az;
  const set = (v: number, ww: number) => { o[0] = ax + abx * v + acx * ww; o[1] = ay + aby * v + acy * ww; o[2] = az + abz * v + acz * ww; o[3] = v; o[4] = ww; };
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return set(0, 0);
  const bpx = px - x[b], bpy = py - x[b + 1], bpz = pz - x[b + 2];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return set(1, 0);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return set(d1 / (d1 - d3), 0);
  const cpx = px - x[c], cpy = py - x[c + 1], cpz = pz - x[c + 2];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return set(0, 1);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return set(0, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const v = (d4 - d3) / (d4 - d3 + (d5 - d6)); return set(1 - v, v); }
  const den = 1 / (va + vb + vc);
  return set(vb * den, vc * den);
}
