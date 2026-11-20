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
const nextPow2 = (v: number) => {
  let p = 1024;
  while (p < v) p <<= 1;
  return p;
};
/**
 * The hash is rebuilt every this many substeps, its triangles' boxes grown
 * by how far cloth can move meanwhile: rebuilt every substep it cost more
 * than the rest of the solver together, three garments on a form.
 */
const REBUILD = 4;
const MOVE_MARGIN = 0.008;
/** How deep through an inner cloth a point may be found and still be put back. */
const MAX_DEPTH = 0.03;
/**
 * In the settle, how far inside a garment a point is looked for: its outward
 * normals say which side is out, so a cloth modelled deep inside (a bow's
 * tails, placed from a guess at the gown's back) is brought out before it is
 * first drawn. The nearest triangle within this decides, so a point outside
 * between two parts (an arm and the body) still reads outside.
 */
const SETTLE_DEPTH = 0.08;

interface Group {
  /** Triangles in the spatial hash, by particle (global indices). */
  tris: Int32Array;
  /** Whether each faces out (a garment's do): its outside is then its normal's side, not just the side a point was on. */
  outward: Uint8Array;
  /** Particles to test against `tris`, and their friction. */
  particles: Int32Array;
  mu: Float64Array;
  /** When true, `tris` belong to the outer garment and `particles` to the inner cloth (pushes the outer triangle's corners outward). */
  pushTris?: boolean;
  buckets: number;
  mask: number;
  start: Int32Array; // per bucket, into entries
  fill: Int32Array; // scratch cursor per bucket
  range: Int32Array; // scratch cell bounds per triangle (6 * nt)
  entries: Int32Array; // triangle numbers
  /** Each triangle's box as of the last build, grown by the reach: min x, y, z, max x, y, z. */
  box: Float64Array;
}

const hash = (ix: number, iy: number, iz: number, mask: number) => ((Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) >>> 0) & mask;

export class LayerContacts {
  private groups: Group[] = [];
  private w: Float64Array;
  private sinceBuild = REBUILD;
  private settling = false;

  constructor(pieces: { model: ClothModel; base: number }[], w: Float64Array) {
    this.w = w;
    const layers = [...new Set(pieces.map((p) => p.model.layer))].sort((a, b) => a - b);
    for (const layer of layers) {
      const inner = pieces.filter((p) => p.model.layer < layer).sort((a, b) => a.model.layer - b.model.layer);
      if (!inner.length) continue;
      const outerPieces = pieces.filter((p) => p.model.layer === layer);
      const particles: number[] = [], mu: number[] = [];
      for (const { model, base } of outerPieces) {
        for (let i = 0; i < model.invMass.length; i++) if (w[base + i] > 0) { particles.push(base + i); mu.push(model.material.friction); }
      }
      if (!particles.length) continue;
      // Separate group per inner surface (base shell first, then tacked overlays, in layer order)
      // so a deeper shell never shadows a raised pocket, belt, or higher inner layer.
      for (const { model, base } of inner) {
        const split = model.overlayTrisStart ?? model.tris.length;
        for (const [t0, t1] of [[0, split], [split, model.tris.length]] as const) {
          if (t1 <= t0) continue;
          const tris: number[] = [], outward: number[] = [];
          for (let k = t0; k < t1; k++) tris.push(base + model.tris[k]);
          const nt = (t1 - t0) / 3;
          for (let t = 0; t < nt; t++) outward.push(model.outward ? 1 : 0);
          const buckets = nextPow2(Math.max(1024, 2 * nt));
          this.groups.push({ tris: Int32Array.from(tris), outward: Uint8Array.from(outward), particles: Int32Array.from(particles), mu: Float64Array.from(mu), buckets, mask: buckets - 1, start: new Int32Array(buckets + 1), fill: new Int32Array(buckets), range: new Int32Array(nt * 6), entries: new Int32Array(0), box: new Float64Array(nt * 6) });
        }
      }
      // Reciprocal pass: keep outer garment triangles clear of inner particles (such as raised pocket corners,
      // belt loops, or curved hip vertices that fall under the interior of an outer triangle).
      const outerTris: number[] = [], outerOutward: number[] = [];
      for (const { model, base } of outerPieces) {
        if (!model.outward) continue;
        const split = model.overlayTrisStart ?? model.tris.length;
        for (let k = 0; k < split; k++) outerTris.push(base + model.tris[k]);
        for (let t = 0; t < split / 3; t++) outerOutward.push(1);
      }
      if (outerTris.length) {
        const innerParticles: number[] = [], innerMu: number[] = [];
        for (const { model, base } of inner) {
          // Its points on its triangles only: a gathered or pleated panel's shell points, on none, are no cloth (clothCcd).
          const onCloth = new Uint8Array(model.invMass.length);
          for (const q of model.tris) onCloth[q] = 1;
          for (let i = 0; i < model.invMass.length; i++) if (onCloth[i]) { innerParticles.push(base + i); innerMu.push(model.material.friction); }
        }
        const nt = outerTris.length / 3;
        const buckets = nextPow2(Math.max(1024, 2 * nt));
        this.groups.push({ tris: Int32Array.from(outerTris), outward: Uint8Array.from(outerOutward), particles: Int32Array.from(innerParticles), mu: Float64Array.from(innerMu), pushTris: true, buckets, mask: buckets - 1, start: new Int32Array(buckets + 1), fill: new Int32Array(buckets), range: new Int32Array(nt * 6), entries: new Int32Array(0), box: new Float64Array(nt * 6) });
      }
    }
    // Cloth against itself and its own layer: clothSelf.
  }

  get active() { return this.groups.length > 0; }

  /**
   * Keeps outer particles `thick` clear of inner cloth; records the contact
   * (weighted normal, push, weighted friction, relative inner displacement) for Coulomb friction.
   */
  collide(
    x: Float64Array,
    prev: Float64Array,
    thick: number,
    contactN: Float64Array,
    contactPush: Float64Array,
    contactMu: Float64Array,
    contactDisp: Float64Array,
    step = true,
    settle = false,
  ) {
    const minSep = thick * 1.2;
    // Into and out of the settle the reach changes, so the hash is rebuilt for it.
    const switched = settle !== this.settling;
    this.settling = settle;
    const rebuild = switched || (step && ++this.sinceBuild >= REBUILD);
    if (rebuild) this.sinceBuild = 0;
    const w = this.w;
    for (const g of this.groups) {
      const deep = settle && !g.pushTris && g.outward[0] === 1;
      const reach = deep ? SETTLE_DEPTH : g.pushTris || g.outward[0] ? thick * 2.5 : thick * 2;
      const maxDepth = deep ? SETTLE_DEPTH : MAX_DEPTH;
      if (rebuild) this.build(g, x, reach + MOVE_MARGIN);
      const T = g.tris, mask = g.mask;
      for (let pi = 0; pi < g.particles.length; pi++) {
        const i = g.particles[pi], k = 3 * i;
        const px = x[k], py = x[k + 1], pz = x[k + 2];
        const b = hash(Math.floor(px / CELL), Math.floor(py / CELL), Math.floor(pz / CELL), mask);
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
        if (g.pushTris) {
          const sd = (bq0 - px) * nx + (bq1 - py) * ny + (bq2 - pz) * nz;
          if (sd >= minSep || sd < -MAX_DEPTH) continue;
          // Only push when the inner particle projects onto the outer triangle (not past an open hem/edge).
          if (best * best - sd * sd > 0.0035 * 0.0035) continue;
          const depth = minSep - sd;
          const wx = bq0 - x[a], wy = bq1 - x[a + 1], wz = bq2 - x[a + 2];
          const d00 = ux * ux + uy * uy + uz * uz, d01 = ux * vx + uy * vy + uz * vz, d11 = vx * vx + vy * vy + vz * vz;
          const d20 = wx * ux + wy * uy + wz * uz, d21 = wx * vx + wy * vy + wz * vz, den = d00 * d11 - d01 * d01;
          if (den < 1e-20) continue;
          const b1 = (d11 * d20 - d01 * d21) / den, b2 = (d00 * d21 - d01 * d20) / den, b0 = 1 - b1 - b2;
          const v0 = T[3 * bt], v1 = T[3 * bt + 1], v2 = T[3 * bt + 2];
          const sum = b0 * b0 * w[v0] + b1 * b1 * w[v1] + b2 * b2 * w[v2];
          if (sum <= 0) continue;
          const pdx = x[k] - prev[k], pdy = x[k + 1] - prev[k + 1], pdz = x[k + 2] - prev[k + 2];
          const mu = g.mu[pi];
          const pushCorner = (vtx: number, bwq: number) => {
            const push = (bwq * w[vtx] * depth) / sum;
            if (push <= 0) return;
            const vk = 3 * vtx;
            x[vk] += nx * push; x[vk + 1] += ny * push; x[vk + 2] += nz * push;
            contactN[vk] += nx * push; contactN[vk + 1] += ny * push; contactN[vk + 2] += nz * push;
            contactDisp[vk] += pdx * push; contactDisp[vk + 1] += pdy * push; contactDisp[vk + 2] += pdz * push;
            contactPush[vtx] += push; contactMu[vtx] += mu * push;
          };
          pushCorner(v0, b0); pushCorner(v1, b1); pushCorner(v2, b2);
          continue;
        }
        const dtx = ((x[a] - prev[a]) + (x[bb] - prev[bb]) + (x[c] - prev[c])) / 3;
        const dty = ((x[a + 1] - prev[a + 1]) + (x[bb + 1] - prev[bb + 1]) + (x[c + 1] - prev[c + 1])) / 3;
        const dtz = ((x[a + 2] - prev[a + 2]) + (x[bb + 2] - prev[bb + 2]) + (x[c + 2] - prev[c + 2])) / 3;
        if (!g.outward[bt]) {
          const was = (prev[k] - bq0 + dtx) * nx + (prev[k + 1] - bq1 + dty) * ny + (prev[k + 2] - bq2 + dtz) * nz;
          if (was < 0) { nx = -nx; ny = -ny; nz = -nz; }
        }
        const sd = (px - bq0) * nx + (py - bq1) * ny + (pz - bq2) * nz;
        const target = g.outward[bt] ? minSep : thick;
        if (sd >= target || sd < -maxDepth) continue;
        const depth = target - sd;
        x[k] += nx * depth; x[k + 1] += ny * depth; x[k + 2] += nz * depth;
        contactN[k] += nx * depth; contactN[k + 1] += ny * depth; contactN[k + 2] += nz * depth;
        contactDisp[k] += dtx * depth; contactDisp[k + 1] += dty * depth; contactDisp[k + 2] += dtz * depth;
        contactPush[i] += depth; contactMu[i] += g.mu[pi] * depth;
      }
    }
  }

  /** The hash of the group's triangles, by counting sort into buckets. */
  private build(g: Group, x: Float64Array, reach: number) {
    const T = g.tris, nt = T.length / 3, start = g.start, fill = g.fill, range = g.range, B = g.box, buckets = g.buckets, mask = g.mask;
    start.fill(0);
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
        start[hash(ix, iy, iz, mask) + 1]++; total++;
      }
    }
    for (let b = 0; b < buckets; b++) start[b + 1] += start[b];
    if (g.entries.length < total) g.entries = new Int32Array(Math.ceil(total * 1.25));
    fill.set(start.subarray(0, buckets));
    for (let t = 0; t < nt; t++) {
      const o = 6 * t;
      for (let ix = range[o]; ix <= range[o + 3]; ix++) for (let iy = range[o + 1]; iy <= range[o + 4]; iy++) for (let iz = range[o + 2]; iz <= range[o + 5]; iz++) {
        g.entries[fill[hash(ix, iy, iz, mask)]++] = t;
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
