/**
 * A surface's triangles brought up to the size the cloth needs, wherever
 * the surface is smaller than that: shortest edges collapsed first, each
 * pair of points merged at its middle and put back on the surface; then
 * edges flipped toward six round each point and the points evened out.
 *
 * The garment's surface comes off a grid as fine as the thinnest limb it
 * goes round needs (a wrist), so a whole gown's skirt came in triangles a
 * cell across: 50,000 of them, which the browser flattened and draped for
 * minutes. Here each part keeps triangles as small as its own curvature
 * asks (`target`), a cuff fine and a skirt at a garment's spacing.
 *
 * Open edges, and the points on them, stay where they are; and it is taken
 * through itself nowhere it was not.
 */

import { crossedPoints } from './clothUntangle';

const dist = (a: number[], b: number[]) => {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

/** Collapse an edge shorter than this share of its target; never make one longer than LONG of it. */
const SHORT = 0.8;
const LONG = 4 / 3;
/** A triangle's normal may turn this much (cosine) when a point moves, and no more. */
const TURN = 0.4;

export function coarsenSurface(
  points: number[][],
  tris: number[],
  /** The edge length wanted at each point. */
  target: number[],
  /** Puts a point back onto the surface, in place. */
  project: (p: number[]) => void,
): { points: number[][]; tris: number[] } {
  const P = points.map((p) => p.slice()), size = target.slice();
  const T = tris.slice(), nT = T.length / 3;
  const dead = new Uint8Array(nT);
  const gone = new Uint8Array(P.length);
  const vt: number[][] = P.map(() => []);
  for (let t = 0; t < nT; t++) for (let q = 0; q < 3; q++) vt[T[3 * t + q]].push(t);
  // Points on an open edge are fixed.
  const fixed = new Uint8Array(P.length);
  {
    const count = new Map<number, number>(), n = P.length;
    for (let t = 0; t < nT; t++) for (let e = 0; e < 3; e++) {
      const a = T[3 * t + e], b = T[3 * t + ((e + 1) % 3)], k = a < b ? a * n + b : b * n + a;
      count.set(k, (count.get(k) ?? 0) + 1);
    }
    for (const [k, c] of count) if (c !== 2) { fixed[Math.floor(k / n)] = 1; fixed[k % n] = 1; }
  }
  const has = (t: number, v: number) => T[3 * t] === v || T[3 * t + 1] === v || T[3 * t + 2] === v;
  const around = (v: number) => {
    const list = vt[v];
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (!dead[t] && has(t, v)) list[w++] = t;
    }
    list.length = w;
    return list;
  };
  const ring = (v: number) => { const s = new Set<number>(); for (const t of around(v)) for (let q = 0; q < 3; q++) if (T[3 * t + q] !== v) s.add(T[3 * t + q]); return s; };
  const turnsOk = (t: number, v: number, at: number[]) => {
    const i0 = T[3 * t], i1 = T[3 * t + 1], i2 = T[3 * t + 2];
    const p0 = P[i0], p1 = P[i1], p2 = P[i2];
    const ux0 = p1[0] - p0[0], uy0 = p1[1] - p0[1], uz0 = p1[2] - p0[2];
    const vx0 = p2[0] - p0[0], vy0 = p2[1] - p0[1], vz0 = p2[2] - p0[2];
    const n0x = uy0 * vz0 - uz0 * vy0, n0y = uz0 * vx0 - ux0 * vz0, n0z = ux0 * vy0 - uy0 * vx0;
    const l0 = Math.sqrt(n0x * n0x + n0y * n0y + n0z * n0z);
    if (l0 < 1e-14) return false;
    const a = i0 === v ? at : p0, b = i1 === v ? at : p1, c = i2 === v ? at : p2;
    const ux1 = b[0] - a[0], uy1 = b[1] - a[1], uz1 = b[2] - a[2];
    const vx1 = c[0] - a[0], vy1 = c[1] - a[1], vz1 = c[2] - a[2];
    const n1x = uy1 * vz1 - uz1 * vy1, n1y = uz1 * vx1 - ux1 * vz1, n1z = ux1 * vy1 - uy1 * vx1;
    const l1 = Math.sqrt(n1x * n1x + n1y * n1y + n1z * n1z);
    if (l1 < 1e-14) return false;
    return (n0x * n1x + n0y * n1y + n0z * n1z) / (l0 * l1) > TURN;
  };

  // Never through itself: what crosses as given may, nothing else. A pass
  // (of collapses, or of flips and evening out) that takes it through itself
  // is made again with the points there kept where they are. Between the
  // legs at a crotch, merging two points and putting the middle back on the
  // surface took it across the gap to the other leg's side.
  const live = () => { const out: number[] = []; for (let t = 0; t < nT; t++) if (!dead[t]) out.push(T[3 * t], T[3 * t + 1], T[3 * t + 2]); return out; };
  const crossedAtFirst = crossedPoints(P, T);
  const rebuildVt = () => {
    for (let i = 0; i < vt.length; i++) vt[i].length = 0;
    for (let t = 0; t < nT; t++) if (!dead[t]) for (let q = 0; q < 3; q++) vt[T[3 * t + q]].push(t);
  };
  const uncrossed = (pass: () => number): number => {
    for (let attempt = 0; ; attempt++) {
      const savedP = P.slice(), savedT = T.slice(), savedDead = dead.slice(), savedGone = gone.slice(), savedSize = size.slice();
      const done = pass();
      if (done <= 0) return done;
      const crossed = crossedPoints(P, live());
      const fresh: number[] = [];
      for (const v of crossed) if (!crossedAtFirst.has(v)) fresh.push(v);
      if (!fresh.length) return done;
      for (let i = 0; i < P.length; i++) { P[i] = savedP[i]; size[i] = savedSize[i]; }
      T.length = savedT.length;
      for (let i = 0; i < savedT.length; i++) T[i] = savedT[i];
      dead.set(savedDead); gone.set(savedGone);
      rebuildVt();
      if (attempt >= 20) return 0;
      for (const v of fresh) fixed[v] = 1;
    }
  };

  // ---- Collapses, shortest first, until none is short.
  for (let pass = 0; pass < 12; pass++) if (uncrossed(() => {
    const cand: [number, number, number][] = [];
    const seen = new Set<number>(), n = P.length;
    for (let t = 0; t < nT; t++) {
      if (dead[t]) continue;
      for (let e = 0; e < 3; e++) {
        const a = T[3 * t + e], b = T[3 * t + ((e + 1) % 3)], k = a < b ? a * n + b : b * n + a;
        if (seen.has(k)) continue;
        seen.add(k);
        if (fixed[a] || fixed[b]) continue;
        const l = dist(P[a], P[b]) / Math.min(size[a], size[b]);
        if (l < SHORT) cand.push([l, a, b]);
      }
    }
    if (!cand.length) return 0;
    cand.sort((x, y) => x[0] - y[0]);
    let done = 0;
    for (const [, a, b] of cand) {
      if (gone[a] || gone[b]) continue;
      const want = Math.min(size[a], size[b]);
      if (dist(P[a], P[b]) >= SHORT * want) continue;
      const ra = ring(a), rb = ring(b);
      if (!ra.has(b)) continue;
      // The link condition: a and b share just the two points across their edge.
      const shared = around(a).filter((t) => has(t, b));
      if (shared.length !== 2) continue;
      let common = 0;
      for (const v of ra) if (rb.has(v)) common++;
      if (common !== 2 || ra.size + rb.size - 4 > 10) continue;
      const m = [(P[a][0] + P[b][0]) / 2, (P[a][1] + P[b][1]) / 2, (P[a][2] + P[b][2]) / 2];
      project(m);
      let ok = true;
      for (const v of ra) if (v !== b && dist(m, P[v]) > LONG * want) { ok = false; break; }
      if (ok) for (const v of rb) if (v !== a && dist(m, P[v]) > LONG * want) { ok = false; break; }
      if (ok) for (const t of around(a)) if (!has(t, b) && !turnsOk(t, a, m)) { ok = false; break; }
      if (ok) for (const t of around(b)) if (!has(t, a) && !turnsOk(t, b, m)) { ok = false; break; }
      if (!ok) continue;
      for (const t of shared) dead[t] = 1;
      for (const t of around(b)) {
        for (let q = 0; q < 3; q++) if (T[3 * t + q] === b) T[3 * t + q] = a;
        vt[a].push(t);
      }
      vt[b] = [];
      gone[b] = 1;
      P[a] = m;
      size[a] = want;
      done++;
    }
    return done;
  }) <= 0) break;

  // ---- Edges flipped toward six round each point, then the points evened out.
  const valence = new Int32Array(P.length);
  const countValence = () => { valence.fill(0); for (let v = 0; v < P.length; v++) if (!gone[v]) valence[v] = ring(v).size; };
  for (let round = 0; round < 3; round++) uncrossed(() => {
    countValence();
    for (let t = 0; t < nT; t++) {
      if (dead[t]) continue;
      for (let e = 0; e < 3; e++) {
        if (dead[t]) break;
        const a = T[3 * t + e], b = T[3 * t + ((e + 1) % 3)], c = T[3 * t + ((e + 2) % 3)];
        if (fixed[a] && fixed[b]) continue;
        const other = around(a);
        let u = -1, otherCount = 0;
        for (let oi = 0; oi < other.length; oi++) {
          const ot = other[oi];
          if (ot !== t && has(ot, b)) { u = ot; otherCount++; }
        }
        if (otherCount !== 1) continue;
        const u0 = T[3 * u], u1 = T[3 * u + 1], u2 = T[3 * u + 2];
        const d = u0 !== a && u0 !== b ? u0 : u1 !== a && u1 !== b ? u1 : u2;
        if (ring(c).has(d)) continue;
        const dev = (v: number, k: number) => Math.abs(valence[v] + k - 6);
        const before = dev(a, 0) + dev(b, 0) + dev(c, 0) + dev(d, 0), after = dev(a, -1) + dev(b, -1) + dev(c, 1) + dev(d, 1);
        if (after >= before) continue;
        // The two new triangles (c, a, d) and (d, b, c) face as the old did.
        const t0 = P[T[3 * t]], t1 = P[T[3 * t + 1]], t2 = P[T[3 * t + 2]];
        const n0x = (t1[1] - t0[1]) * (t2[2] - t0[2]) - (t1[2] - t0[2]) * (t2[1] - t0[1]);
        const n0y = (t1[2] - t0[2]) * (t2[0] - t0[0]) - (t1[0] - t0[0]) * (t2[2] - t0[2]);
        const n0z = (t1[0] - t0[0]) * (t2[1] - t0[1]) - (t1[1] - t0[1]) * (t2[0] - t0[0]);
        const q0 = P[u0], q1 = P[u1], q2 = P[u2];
        const nnx = n0x + ((q1[1] - q0[1]) * (q2[2] - q0[2]) - (q1[2] - q0[2]) * (q2[1] - q0[1]));
        const nny = n0y + ((q1[2] - q0[2]) * (q2[0] - q0[0]) - (q1[0] - q0[0]) * (q2[2] - q0[2]));
        const nnz = n0z + ((q1[0] - q0[0]) * (q2[1] - q0[1]) - (q1[1] - q0[1]) * (q2[0] - q0[0]));
        const pa = P[a], pb = P[b], pc = P[c], pd = P[d];
        const acx = pa[0] - pc[0], acy = pa[1] - pc[1], acz = pa[2] - pc[2];
        const dcx = pd[0] - pc[0], dcy = pd[1] - pc[1], dcz = pd[2] - pc[2];
        const f1x = acy * dcz - acz * dcy, f1y = acz * dcx - acx * dcz, f1z = acx * dcy - acy * dcx;
        const bdx = pb[0] - pd[0], bdy = pb[1] - pd[1], bdz = pb[2] - pd[2];
        const cdx = -dcx, cdy = -dcy, cdz = -dcz;
        const f2x = bdy * cdz - bdz * cdy, f2y = bdz * cdx - bdx * cdz, f2z = bdx * cdy - bdy * cdx;
        const ln = Math.sqrt(nnx * nnx + nny * nny + nnz * nnz);
        const lf1 = Math.sqrt(f1x * f1x + f1y * f1y + f1z * f1z);
        const lf2 = Math.sqrt(f2x * f2x + f2y * f2y + f2z * f2z);
        const cosA = (f1x * nnx + f1y * nny + f1z * nnz) / (lf1 * ln || 1);
        const cosB = (f2x * nnx + f2y * nny + f2z * nnz) / (lf2 * ln || 1);
        if (!(cosA > 0.5 && cosB > 0.5)) continue;
        T[3 * t] = c; T[3 * t + 1] = a; T[3 * t + 2] = d;
        T[3 * u] = d; T[3 * u + 1] = b; T[3 * u + 2] = c;
        vt[c].push(u); vt[d].push(t);
        valence[a]--; valence[b]--; valence[c]++; valence[d]++;
      }
    }
    // Evened out along the surface, each point toward the middle of its ring, and back onto it.
    for (let v = 0; v < P.length; v++) {
      if (gone[v] || fixed[v]) continue;
      const r = ring(v);
      if (r.size < 3) continue;
      let mx = 0, my = 0, mz = 0;
      for (const q of r) { const pq = P[q]; mx += pq[0]; my += pq[1]; mz += pq[2]; }
      const invR = 1 / r.size;
      mx *= invR; my *= invR; mz *= invR;
      let nrx = 0, nry = 0, nrz = 0;
      const ar = around(v);
      for (let ti = 0; ti < ar.length; ti++) {
        const t = ar[ti];
        const p0 = P[T[3 * t]], p1 = P[T[3 * t + 1]], p2 = P[T[3 * t + 2]];
        nrx += (p1[1] - p0[1]) * (p2[2] - p0[2]) - (p1[2] - p0[2]) * (p2[1] - p0[1]);
        nry += (p1[2] - p0[2]) * (p2[0] - p0[0]) - (p1[0] - p0[0]) * (p2[2] - p0[2]);
        nrz += (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
      }
      const ln2 = nrx * nrx + nry * nry + nrz * nrz;
      const invLn2 = ln2 > 0 ? 1 / ln2 : 1;
      const pv = P[v], dx = mx - pv[0], dy = my - pv[1], dz = mz - pv[2];
      const dn = (dx * nrx + dy * nry + dz * nrz) * invLn2;
      const q = [pv[0] + 0.5 * (dx - dn * nrx), pv[1] + 0.5 * (dy - dn * nry), pv[2] + 0.5 * (dz - dn * nrz)];
      project(q);
      let ok = true;
      for (let ti = 0; ti < ar.length; ti++) if (!turnsOk(ar[ti], v, q)) { ok = false; break; }
      if (ok) P[v] = q;
    }
    return 1;
  });

  // ---- Only the points still used, in order.
  const remap = new Int32Array(P.length).fill(-1), outP: number[][] = [], outT: number[] = [];
  for (let t = 0; t < nT; t++) {
    if (dead[t]) continue;
    for (let q = 0; q < 3; q++) {
      const v = T[3 * t + q];
      if (remap[v] < 0) { remap[v] = outP.length; outP.push(P[v]); }
      outT.push(remap[v]);
    }
  }
  return { points: outP, tris: outT };
}

/**
 * The edge length a surface given as the zero set of `field` wants at p:
 * a share of its radius of curvature there (from the field's second
 * derivatives across the surface, both ways it bends, so a saddle counts),
 * between `min` and `max`.
 */
const curvQ = [0, 0, 0];
export function curvatureSize(field: (p: number[]) => number, p: number[], step: number, min: number, max: number): number {
  const px = p[0], py = p[1], pz = p[2], e = step, f0 = field(p);
  const q = curvQ;
  q[1] = py; q[2] = pz;
  q[0] = px + e; const fxp = field(q);
  q[0] = px - e; const fxm = field(q);
  q[0] = px;
  q[1] = py + e; const fyp = field(q);
  q[1] = py - e; const fym = field(q);
  q[1] = py;
  q[2] = pz + e; const fzp = field(q);
  q[2] = pz - e; const fzm = field(q);
  const inv2e = 0.5 / e;
  const gx = (fxp - fxm) * inv2e, gy = (fyp - fym) * inv2e, gz = (fzp - fzm) * inv2e;
  const gl = Math.sqrt(gx * gx + gy * gy + gz * gz);
  if (gl < 1e-9) return min;
  const invE2 = 1 / (e * e), inv4E2 = 0.25 * invE2;
  const h00 = (fxp - 2 * f0 + fxm) * invE2;
  const h11 = (fyp - 2 * f0 + fym) * invE2;
  const h22 = (fzp - 2 * f0 + fzm) * invE2;
  q[2] = pz;
  q[0] = px + e; q[1] = py + e; const fpp0 = field(q);
  q[1] = py - e; const fpm0 = field(q);
  q[0] = px - e; q[1] = py + e; const fmp0 = field(q);
  q[1] = py - e; const fmm0 = field(q);
  const h01 = (fpp0 - fpm0 - fmp0 + fmm0) * inv4E2;
  q[1] = py;
  q[0] = px + e; q[2] = pz + e; const fp0p = field(q);
  q[2] = pz - e; const fp0m = field(q);
  q[0] = px - e; q[2] = pz + e; const fm0p = field(q);
  q[2] = pz - e; const fm0m = field(q);
  const h02 = (fp0p - fp0m - fm0p + fm0m) * inv4E2;
  q[0] = px;
  q[1] = py + e; q[2] = pz + e; const f0pp = field(q);
  q[2] = pz - e; const f0pm = field(q);
  q[1] = py - e; q[2] = pz + e; const f0mp = field(q);
  q[2] = pz - e; const f0mm = field(q);
  const h12 = (f0pp - f0pm - f0mp + f0mm) * inv4E2;
  // The shape operator: the Hessian across the surface (I - n n) H (I - n n) / |g|; its size, sqrt(k1^2 + k2^2).
  const invGl = 1 / gl;
  const nx = gx * invGl, ny = gy * invGl, nz = gz * invGl;
  const p00 = 1 - nx * nx, p01 = -nx * ny, p02 = -nx * nz;
  const p11 = 1 - ny * ny, p12 = -ny * nz, p22 = 1 - nz * nz;
  // First compute M = H * P
  const m00 = h00 * p00 + h01 * p01 + h02 * p02, m01 = h00 * p01 + h01 * p11 + h02 * p12, m02 = h00 * p02 + h01 * p12 + h02 * p22;
  const m10 = h01 * p00 + h11 * p01 + h12 * p02, m11 = h01 * p01 + h11 * p11 + h12 * p12, m12 = h01 * p02 + h11 * p12 + h12 * p22;
  const m20 = h02 * p00 + h12 * p01 + h22 * p02, m21 = h02 * p01 + h12 * p11 + h22 * p12, m22 = h02 * p02 + h12 * p12 + h22 * p22;
  // Then S = P * M (symmetric)
  const s00 = p00 * m00 + p01 * m10 + p02 * m20, s01 = p00 * m01 + p01 * m11 + p02 * m21, s02 = p00 * m02 + p01 * m12 + p02 * m22;
  const s11 = p01 * m01 + p11 * m11 + p12 * m21, s12 = p01 * m02 + p11 * m12 + p12 * m22, s22 = p02 * m02 + p12 * m12 + p22 * m22;
  const k = Math.sqrt(s00 * s00 + s11 * s11 + s22 * s22 + 2 * (s01 * s01 + s02 * s02 + s12 * s12)) * invGl;
  return Math.min(max, Math.max(min, k > 1e-9 ? SEGMENT / k : max));
}

/** An edge this share of the radius of curvature: about thirty round a tube (at sixteen, a gown's bust and batwing came out half a percent harder to flatten than off the fine grid). */
const SEGMENT = 0.2;
