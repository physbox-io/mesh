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
const INV_CELL = 1 / CELL;
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

function boxesOverlap(a: Float64Array, b: Float64Array, pad: number): boolean {
  if (!a.length || !b.length) return false;
  let ax0 = Infinity, ay0 = Infinity, az0 = Infinity, ax1 = -Infinity, ay1 = -Infinity, az1 = -Infinity;
  for (let i = 0; i < a.length; i += 3) {
    if (a[i] < ax0) ax0 = a[i]; if (a[i] > ax1) ax1 = a[i];
    if (a[i + 1] < ay0) ay0 = a[i + 1]; if (a[i + 1] > ay1) ay1 = a[i + 1];
    if (a[i + 2] < az0) az0 = a[i + 2]; if (a[i + 2] > az1) az1 = a[i + 2];
  }
  let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
  for (let i = 0; i < b.length; i += 3) {
    if (b[i] < bx0) bx0 = b[i]; if (b[i] > bx1) bx1 = b[i];
    if (b[i + 1] < by0) by0 = b[i + 1]; if (b[i + 1] > by1) by1 = b[i + 1];
    if (b[i + 2] < bz0) bz0 = b[i + 2]; if (b[i + 2] > bz1) bz1 = b[i + 2];
  }
  return ax1 + pad >= bx0 && bx1 + pad >= ax0 && ay1 + pad >= by0 && by1 + pad >= ay0 && az1 + pad >= bz0 && bz1 + pad >= az0;
}

/**
 * Whether `outer` is concentrically worn over `inner` (handled one-way by
 * `LayerContacts` rather than two-way by `SelfContacts`): `inner.layer < outer.layer`,
 * neither is an unfitted loose garment, they are not fitted to different forms
 * or disjoint body parts (e.g. a hat on `head` vs a jacket on `skin`/`arm`),
 * and their initial rest bounds overlap within `SETTLE_DEPTH`.
 */
export function isLayeredPair(inner: ClothModel, outer: ClothModel): boolean {
  if (!(inner.layer < outer.layer)) return false;
  if (inner.loose || outer.loose) return false;
  if (inner.fitTo && outer.fitTo && inner.fitTo !== outer.fitTo) return false;
  if (inner.parts?.length && outer.parts?.length) {
    let shared = false;
    for (const p of inner.parts) if (outer.parts.includes(p)) { shared = true; break; }
    if (!shared) return false;
  }
  return boxesOverlap(inner.x0, outer.x0, SETTLE_DEPTH);
}

export class LayerContacts {
  private groups: Group[] = [];
  private w: Float64Array;
  private sinceBuild = REBUILD;
  private settling = false;

  constructor(pieces: { model: ClothModel; base: number }[], w: Float64Array) {
    this.w = w;
    const layers = [...new Set(pieces.map((p) => p.model.layer))].sort((a, b) => a - b);
    for (const layer of layers) {
      const outerAtLayer = pieces.filter((p) => p.model.layer === layer);
      // Group outer pieces that share concentric inner pieces in ascending inner-layer order,
      // finishing both forward and reciprocal (`pushTris`) passes for `layer` before `layer + 1`.
      const candidateInners = pieces.filter((p) => p.model.layer < layer).sort((a, b) => a.model.layer - b.model.layer);
      for (const inn of candidateInners) {
        const outerPieces = outerAtLayer.filter((o) => isLayeredPair(inn.model, o.model));
        if (!outerPieces.length) continue;
        const particles: number[] = [], mu: number[] = [];
        for (const { model, base } of outerPieces) {
          for (let i = 0; i < model.invMass.length; i++) if (w[base + i] > 0) { particles.push(base + i); mu.push(model.material.friction); }
        }
        if (!particles.length) continue;
        const { model, base } = inn;
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
      // Reciprocal pass for this layer: keep outer garment triangles clear of concentric inner particles.
      for (const outPiece of outerAtLayer) {
        if (!outPiece.model.outward) continue;
        const inner = candidateInners.filter((p) => isLayeredPair(p.model, outPiece.model));
        if (!inner.length) continue;
        const split = outPiece.model.overlayTrisStart ?? outPiece.model.tris.length;
        if (split <= 0) continue;
        const outerTris: number[] = [], outerOutward: number[] = [];
        for (let k = 0; k < split; k++) outerTris.push(outPiece.base + outPiece.model.tris[k]);
        for (let t = 0; t < split / 3; t++) outerOutward.push(1);
        const innerParticles: number[] = [], innerMu: number[] = [];
        for (const { model, base } of inner) {
          const onCloth = new Uint8Array(model.invMass.length);
          for (const q of model.tris) onCloth[q] = 1;
          for (let i = 0; i < model.invMass.length; i++) if (onCloth[i]) { innerParticles.push(base + i); innerMu.push(model.material.friction); }
        }
        if (!innerParticles.length) continue;
        const nt = outerTris.length / 3;
        const buckets = nextPow2(Math.max(1024, 2 * nt));
        this.groups.push({ tris: Int32Array.from(outerTris), outward: Uint8Array.from(outerOutward), particles: Int32Array.from(innerParticles), mu: Float64Array.from(innerMu), pushTris: true, buckets, mask: buckets - 1, start: new Int32Array(buckets + 1), fill: new Int32Array(buckets), range: new Int32Array(nt * 6), entries: new Int32Array(0), box: new Float64Array(nt * 6) });
      }
    }
    // Cloth against itself and non-concentric cloth: clothSelf.
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
    settled = false,
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
      const T = g.tris, mask = g.mask, B = g.box, reach2 = reach * reach;
      for (let pi = 0; pi < g.particles.length; pi++) {
        const i = g.particles[pi], k = 3 * i;
        const px = x[k], py = x[k + 1], pz = x[k + 2];
        const b = hash(Math.floor(px * INV_CELL), Math.floor(py * INV_CELL), Math.floor(pz * INV_CELL), mask);
        const e0 = g.start[b], e1 = g.start[b + 1];
        if (e0 === e1) continue;
        let best2 = reach2, bq0 = 0, bq1 = 0, bq2 = 0, bt = -1;
        for (let e = e0; e < e1; e++) {
          const t = g.entries[e], o = 6 * t;
          if (px < B[o] || py < B[o + 1] || pz < B[o + 2] || px > B[o + 3] || py > B[o + 4] || pz > B[o + 5]) continue;
          const a = 3 * T[3 * t], bb = 3 * T[3 * t + 1], c = 3 * T[3 * t + 2];
          closest(px, py, pz, x, a, bb, c, out);
          const dx = px - out[0], dy = py - out[1], dz = pz - out[2], d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < best2) { best2 = d2; bq0 = out[0]; bq1 = out[1]; bq2 = out[2]; bt = t; }
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
          // Only push when the inner particle projects onto the outer triangle (not past an open hem/edge).
          if (best2 - sd * sd > 0.0035 * 0.0035) continue;
          const wx = bq0 - x[a], wy = bq1 - x[a + 1], wz = bq2 - x[a + 2];
          const d00 = ux * ux + uy * uy + uz * uz, d01 = ux * vx + uy * vy + uz * vz, d11 = vx * vx + vy * vy + vz * vz;
          const d20 = wx * ux + wy * uy + wz * uz, d21 = wx * vx + wy * vy + wz * vz, den = d00 * d11 - d01 * d01;
          if (den < 1e-20) continue;
          const b1 = (d11 * d20 - d01 * d21) / den, b2 = (d00 * d21 - d01 * d20) / den, b0 = 1 - b1 - b2;
          const qpx = b0 * prev[a] + b1 * prev[bb] + b2 * prev[c];
          const qpy = b0 * prev[a + 1] + b1 * prev[bb + 1] + b2 * prev[c + 1];
          const qpz = b0 * prev[a + 2] + b1 * prev[bb + 2] + b2 * prev[c + 2];
          const was = (qpx - prev[k]) * nx + (qpy - prev[k + 1]) * ny + (qpz - prev[k + 2]) * nz;
          // Once settled (live run with CCD active), never pull an outer triangle outward across an inner-layer point that is already on its exterior (+n) side.
          if (settled && was < 0) {
            const outSd = -sd;
            if (w[i] <= 0 || outSd >= thick || outSd < -MAX_DEPTH) continue;
            const depth = thick - outSd;
            const dtx = ((x[a] - prev[a]) + (x[bb] - prev[bb]) + (x[c] - prev[c])) / 3;
            const dty = ((x[a + 1] - prev[a + 1]) + (x[bb + 1] - prev[bb + 1]) + (x[c + 1] - prev[c + 1])) / 3;
            const dtz = ((x[a + 2] - prev[a + 2]) + (x[bb + 2] - prev[bb + 2]) + (x[c + 2] - prev[c + 2])) / 3;
            x[k] += nx * depth; x[k + 1] += ny * depth; x[k + 2] += nz * depth;
            contactN[k] += nx * depth; contactN[k + 1] += ny * depth; contactN[k + 2] += nz * depth;
            contactDisp[k] += dtx * depth; contactDisp[k + 1] += dty * depth; contactDisp[k + 2] += dtz * depth;
            contactPush[i] += depth; contactMu[i] += g.mu[pi] * depth;
            continue;
          }
          if (sd >= minSep || sd < -MAX_DEPTH) continue;
          const depth = minSep - sd;
          const v0 = T[3 * bt], v1 = T[3 * bt + 1], v2 = T[3 * bt + 2];
          const sum = b0 * b0 * w[v0] + b1 * b1 * w[v1] + b2 * b2 * w[v2];
          if (sum <= 0) continue;
          const pdx = x[k] - prev[k], pdy = x[k + 1] - prev[k + 1], pdz = x[k + 2] - prev[k + 2];
          const mu = g.mu[pi], scale = depth / sum;
          const p0 = b0 * w[v0] * scale;
          if (p0 > 0) {
            x[a] += nx * p0; x[a + 1] += ny * p0; x[a + 2] += nz * p0;
            contactN[a] += nx * p0; contactN[a + 1] += ny * p0; contactN[a + 2] += nz * p0;
            contactDisp[a] += pdx * p0; contactDisp[a + 1] += pdy * p0; contactDisp[a + 2] += pdz * p0;
            contactPush[v0] += p0; contactMu[v0] += mu * p0;
          }
          const p1 = b1 * w[v1] * scale;
          if (p1 > 0) {
            x[bb] += nx * p1; x[bb + 1] += ny * p1; x[bb + 2] += nz * p1;
            contactN[bb] += nx * p1; contactN[bb + 1] += ny * p1; contactN[bb + 2] += nz * p1;
            contactDisp[bb] += pdx * p1; contactDisp[bb + 1] += pdy * p1; contactDisp[bb + 2] += pdz * p1;
            contactPush[v1] += p1; contactMu[v1] += mu * p1;
          }
          const p2 = b2 * w[v2] * scale;
          if (p2 > 0) {
            x[c] += nx * p2; x[c + 1] += ny * p2; x[c + 2] += nz * p2;
            contactN[c] += nx * p2; contactN[c + 1] += ny * p2; contactN[c + 2] += nz * p2;
            contactDisp[c] += pdx * p2; contactDisp[c + 1] += pdy * p2; contactDisp[c + 2] += pdz * p2;
            contactPush[v2] += p2; contactMu[v2] += mu * p2;
          }
          continue;
        }
        const dtx = ((x[a] - prev[a]) + (x[bb] - prev[bb]) + (x[c] - prev[c])) / 3;
        const dty = ((x[a + 1] - prev[a + 1]) + (x[bb + 1] - prev[bb + 1]) + (x[c + 1] - prev[c + 1])) / 3;
        const dtz = ((x[a + 2] - prev[a + 2]) + (x[bb + 2] - prev[bb + 2]) + (x[c + 2] - prev[c + 2])) / 3;
        if (settled || !g.outward[bt]) {
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
