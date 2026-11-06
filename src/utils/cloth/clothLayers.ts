/**
 * Cloth against cloth, by layer: every particle of a cloth stays its
 * thickness clear of the triangles of every cloth worn under it (a lower
 * `layer`): outside it if it is a garment, else on the side it was on at
 * the start of the substep. A jacket
 * over a shirt over jeans; an ornament on a gown. One way: the outer cloth
 * is kept off the inner, which does not feel it (it rests on the body).
 *
 * Triangles go into a spatial hash rebuilt every substep from where they
 * are; each particle looks only in its own cell (triangles are entered in
 * every cell their box, grown by the reach, touches).
 */

import type { ClothModel } from './clothModel';

const CELL = 0.04;
const BUCKETS = 1 << 17;
/**
 * The hash is rebuilt every this many substeps, its triangles' boxes grown
 * by how far cloth can move meanwhile: rebuilt every substep it cost more
 * than the rest of the solver together, three garments on a form.
 */
const REBUILD = 4;
const MOVE_MARGIN = 0.008;
/** How deep through an inner cloth a point may be found and still be put back. */
const MAX_DEPTH = 0.03;

interface Group {
  /** Inner cloth's triangles, by particle (global indices). */
  tris: Int32Array;
  /** Whether each faces out (a garment's do): its outside is then its normal's side, not just the side a point was on. */
  outward: Uint8Array;
  /** Outer particles to keep off them, and their friction. */
  particles: Int32Array;
  mu: Float64Array;
  start: Int32Array; // per bucket, into entries
  entries: Int32Array; // triangle numbers
  /** Each triangle's box as of the last build, grown by the reach: min x, y, z, max x, y, z. */
  box: Float64Array;
}

const hash = (ix: number, iy: number, iz: number) => ((Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) >>> 0) & (BUCKETS - 1);

export class LayerContacts {
  private groups: Group[] = [];
  private sinceBuild = REBUILD;

  constructor(pieces: { model: ClothModel; base: number }[], w: Float64Array) {
    const layers = [...new Set(pieces.map((p) => p.model.layer))].sort((a, b) => a - b);
    for (const layer of layers) {
      const inner = pieces.filter((p) => p.model.layer < layer);
      if (!inner.length) continue;
      const tris: number[] = [], outward: number[] = [];
      for (const { model, base } of inner) {
        for (const i of model.tris) tris.push(base + i);
        for (let t = 0; t < model.tris.length / 3; t++) outward.push(model.outward ? 1 : 0);
      }
      const particles: number[] = [], mu: number[] = [];
      for (const { model, base } of pieces.filter((p) => p.model.layer === layer)) {
        for (let i = 0; i < model.invMass.length; i++) if (w[base + i] > 0) { particles.push(base + i); mu.push(model.material.friction); }
      }
      this.groups.push({ tris: Int32Array.from(tris), outward: Uint8Array.from(outward), particles: Int32Array.from(particles), mu: Float64Array.from(mu), start: new Int32Array(BUCKETS + 1), entries: new Int32Array(0), box: new Float64Array((tris.length / 3) * 6) });
    }
    // Non-adjacent regions of a non-garment cloth also stay their thickness
    // clear of one another so separate pieces or folds cannot pass through
    // each other. Particles are grouped into topological bands by mesh-edge
    // distance; each band collides against earlier triangles outside its
    // local neighbourhood (including across stitches).
    for (const { model, base } of pieces) {
      if (model.outward) continue;
      const n = model.invMass.length;
      const meshAdj: number[][] = Array.from({ length: n }, () => []);
      const fullAdj: number[][] = Array.from({ length: n }, () => []);
      for (let e = 0; e < model.edges.length; e += 2) {
        const a = model.edges[e], b = model.edges[e + 1];
        meshAdj[a].push(b); meshAdj[b].push(a);
        fullAdj[a].push(b); fullAdj[b].push(a);
      }
      for (let s = 0; s < model.stitches.length; s += 2) {
        const a = model.stitches[s], b = model.stitches[s + 1];
        fullAdj[a].push(b); fullAdj[b].push(a);
      }
      const hop = new Int32Array(n).fill(-1);
      let nextStart = 0;
      for (let root = 0; root < n; root++) {
        if (hop[root] >= 0) continue;
        hop[root] = nextStart;
        let maxInComp = nextStart;
        const queue: number[] = [root];
        for (let head = 0; head < queue.length; head++) {
          const u = queue[head];
          for (const v of meshAdj[u]) if (hop[v] < 0) {
            hop[v] = hop[u] + 1;
            if (hop[v] > maxInComp) maxInComp = hop[v];
            queue.push(v);
          }
        }
        nextStart = maxInComp + 6;
      }
      // 4-hop neighbourhood across stitches so stitched seam vertices do not fight their own seam.
      const stitchNear: Set<number>[] = Array.from({ length: n }, (_, start) => {
        const seen = new Set<number>([start]);
        let frontier = [start];
        for (let d = 0; d < 4; d++) {
          const next: number[] = [];
          for (const u of frontier) for (const v of fullAdj[u]) if (!seen.has(v)) { seen.add(v); next.push(v); }
          frontier = next;
        }
        return seen;
      });
      const bandStep = 3, nBands = Math.ceil((nextStart + 1) / bandStep);
      for (let bi = 2; bi < nBands; bi++) {
        const hLo = bi * bandStep, hHi = hLo + bandStep;
        const bandPts: number[] = [];
        for (let p = 0; p < n; p++) if (hop[p] >= hLo && hop[p] < hHi && w[base + p] > 0) bandPts.push(p);
        if (!bandPts.length) continue;
        const nearSet = new Set<number>();
        for (const p of bandPts) for (const q of stitchNear[p]) nearSet.add(q);
        const tris: number[] = [], outward: number[] = [];
        for (let t = 0; t < model.tris.length; t += 3) {
          const a = model.tris[t], b = model.tris[t + 1], c = model.tris[t + 2];
          if (Math.max(hop[a], hop[b], hop[c]) >= hLo - 4) continue;
          if (nearSet.has(a) || nearSet.has(b) || nearSet.has(c)) continue;
          tris.push(base + a, base + b, base + c);
          outward.push(0);
        }
        if (!tris.length) continue;
        const particles = bandPts.map((p) => base + p);
        const mu = bandPts.map(() => model.material.friction);
        this.groups.push({ tris: Int32Array.from(tris), outward: Uint8Array.from(outward), particles: Int32Array.from(particles), mu: Float64Array.from(mu), start: new Int32Array(BUCKETS + 1), entries: new Int32Array(0), box: new Float64Array((tris.length / 3) * 6) });
      }
    }
  }

  get active() { return this.groups.length > 0; }

  /**
   * Keeps outer particles `thick` clear of inner cloth; records the contact
   * (normal, push, friction) for the velocity update's friction.
   */
  collide(x: Float64Array, prev: Float64Array, thick: number, contactN: Float64Array, contactPush: Float64Array, contactMu: Float64Array, step = true) {
    const reach = thick * 2;
    const rebuild = step && ++this.sinceBuild >= REBUILD;
    if (rebuild) this.sinceBuild = 0;
    for (const g of this.groups) {
      if (rebuild) this.build(g, x, reach + MOVE_MARGIN);
      const T = g.tris;
      for (let pi = 0; pi < g.particles.length; pi++) {
        const i = g.particles[pi], k = 3 * i;
        const px = x[k], py = x[k + 1], pz = x[k + 2];
        const b = hash(Math.floor(px / CELL), Math.floor(py / CELL), Math.floor(pz / CELL));
        let best = reach, bq0 = 0, bq1 = 0, bq2 = 0, bt = -1;
        const B = g.box;
        for (let e = g.start[b]; e < g.start[b + 1]; e++) {
          const t = g.entries[e], o = 6 * t;
          if (px < B[o] || py < B[o + 1] || pz < B[o + 2] || px > B[o + 3] || py > B[o + 4] || pz > B[o + 5]) continue;
          const a = 3 * T[3 * t], bb = 3 * T[3 * t + 1], c = 3 * T[3 * t + 2];
          closest(px, py, pz, x, a, bb, c, out);
          const dx = px - out[0], dy = py - out[1], dz = pz - out[2], d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d < best) { best = d; bq0 = out[0]; bq1 = out[1]; bq2 = out[2]; bt = t; }
        }
        if (bt < 0) continue;
        const a = 3 * T[3 * bt], bb = 3 * T[3 * bt + 1], c = 3 * T[3 * bt + 2];
        const ux = x[bb] - x[a], uy = x[bb + 1] - x[a + 1], uz = x[bb + 2] - x[a + 2];
        const vx = x[c] - x[a], vy = x[c + 1] - x[a + 1], vz = x[c + 2] - x[a + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (nl < 1e-14) continue;
        nx /= nl; ny /= nl; nz /= nl;
        // Outside a garment is its normal's side; of other cloth, the side
        // the point was on when the substep began. (By that rule alone, a
        // jacket's points that started inside a shirt were kept inside it.)
        if (!g.outward[bt]) {
          const dtx = ((x[a] - prev[a]) + (x[bb] - prev[bb]) + (x[c] - prev[c])) / 3;
          const dty = ((x[a + 1] - prev[a + 1]) + (x[bb + 1] - prev[bb + 1]) + (x[c + 1] - prev[c + 1])) / 3;
          const dtz = ((x[a + 2] - prev[a + 2]) + (x[bb + 2] - prev[bb + 2]) + (x[c + 2] - prev[c + 2])) / 3;
          const was = (prev[k] - bq0 + dtx) * nx + (prev[k + 1] - bq1 + dty) * ny + (prev[k + 2] - bq2 + dtz) * nz;
          if (was < 0) { nx = -nx; ny = -ny; nz = -nz; }
        }
        const sd = (px - bq0) * nx + (py - bq1) * ny + (pz - bq2) * nz;
        if (sd >= thick || sd < -MAX_DEPTH) continue;
        const depth = thick - sd;
        x[k] += nx * depth; x[k + 1] += ny * depth; x[k + 2] += nz * depth;
        contactN[k] = nx; contactN[k + 1] = ny; contactN[k + 2] = nz;
        contactPush[i] += depth; contactMu[i] = g.mu[pi];
      }
    }
  }

  /** The hash of the group's triangles, by counting sort into buckets. */
  private build(g: Group, x: Float64Array, reach: number) {
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
}

const out = [0, 0, 0];

/** Closest point on triangle (a, b, c), given as offsets into x, to p (Ericson); into `o`. */
function closest(px: number, py: number, pz: number, x: Float64Array, a: number, b: number, c: number, o: number[]) {
  const ax = x[a], ay = x[a + 1], az = x[a + 2];
  const abx = x[b] - ax, aby = x[b + 1] - ay, abz = x[b + 2] - az, acx = x[c] - ax, acy = x[c + 1] - ay, acz = x[c + 2] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { o[0] = ax; o[1] = ay; o[2] = az; return; }
  const bpx = px - x[b], bpy = py - x[b + 1], bpz = pz - x[b + 2];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { o[0] = x[b]; o[1] = x[b + 1]; o[2] = x[b + 2]; return; }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); o[0] = ax + v * abx; o[1] = ay + v * aby; o[2] = az + v * abz; return; }
  const cpx = px - x[c], cpy = py - x[c + 1], cpz = pz - x[c + 2];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { o[0] = x[c]; o[1] = x[c + 1]; o[2] = x[c + 2]; return; }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const v = d2 / (d2 - d6); o[0] = ax + v * acx; o[1] = ay + v * acy; o[2] = az + v * acz; return; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const v = (d4 - d3) / (d4 - d3 + (d5 - d6));
    o[0] = x[b] + v * (x[c] - x[b]); o[1] = x[b + 1] + v * (x[c + 1] - x[b + 1]); o[2] = x[b + 2] + v * (x[c + 2] - x[b + 2]); return;
  }
  const den = 1 / (va + vb + vc), v = vb * den, ww = vc * den;
  o[0] = ax + abx * v + acx * ww; o[1] = ay + aby * v + acy * ww; o[2] = az + abz * v + acz * ww;
}
