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

const cross = (u: number[], v: number[]) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

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
  const normal = (t: number, v?: number, at?: number[]) => {
    const i0 = T[3 * t], i1 = T[3 * t + 1], i2 = T[3 * t + 2];
    const a = i0 === v ? at! : P[i0], b = i1 === v ? at! : P[i1], c = i2 === v ? at! : P[i2];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  };
  const turnsOk = (t: number, v: number, at: number[]) => {
    const n0 = normal(t), n1 = normal(t, v, at), l0 = Math.hypot(n0[0], n0[1], n0[2]), l1 = Math.hypot(n1[0], n1[1], n1[2]);
    if (l1 < 1e-14 || l0 < 1e-14) return false;
    return (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]) / (l0 * l1) > TURN;
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
      T.splice(0, T.length, ...savedT);
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
        const other = around(a).filter((u) => u !== t && has(u, b));
        if (other.length !== 1) continue;
        const u = other[0], d = [0, 1, 2].map((q) => T[3 * u + q]).find((v) => v !== a && v !== b)!;
        if (ring(c).has(d)) continue;
        const dev = (v: number, k: number) => Math.abs(valence[v] + k - 6);
        const before = dev(a, 0) + dev(b, 0) + dev(c, 0) + dev(d, 0), after = dev(a, -1) + dev(b, -1) + dev(c, 1) + dev(d, 1);
        if (after >= before) continue;
        // The two new triangles (c, a, d) and (d, b, c) face as the old did.
        const n0 = normal(t), n1 = normal(u);
        const nn = [n0[0] + n1[0], n0[1] + n1[1], n0[2] + n1[2]];
        const f1 = cross(sub(P[a], P[c]), sub(P[d], P[c])), f2 = cross(sub(P[b], P[d]), sub(P[c], P[d]));
        const ln = Math.hypot(nn[0], nn[1], nn[2]);
        const cosA = (f1[0] * nn[0] + f1[1] * nn[1] + f1[2] * nn[2]) / (Math.hypot(f1[0], f1[1], f1[2]) * ln || 1);
        const cosB = (f2[0] * nn[0] + f2[1] * nn[1] + f2[2] * nn[2]) / (Math.hypot(f2[0], f2[1], f2[2]) * ln || 1);
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
      const m = [0, 0, 0];
      for (const q of r) for (let k = 0; k < 3; k++) m[k] += P[q][k] / r.size;
      const nrm = [0, 0, 0];
      for (const t of around(v)) { const n = normal(t); for (let k = 0; k < 3; k++) nrm[k] += n[k]; }
      const ln = Math.hypot(nrm[0], nrm[1], nrm[2]) || 1, d = sub(m, P[v]), dn = (d[0] * nrm[0] + d[1] * nrm[1] + d[2] * nrm[2]) / ln;
      const q = [0, 1, 2].map((k) => P[v][k] + 0.5 * (d[k] - (dn * nrm[k]) / ln));
      project(q);
      if (around(v).every((t) => turnsOk(t, v, q))) P[v] = q;
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
export function curvatureSize(field: (p: number[]) => number, p: number[], step: number, min: number, max: number): number {
  const f0 = field(p), e = step;
  const q = [0, 0, 0];
  const at = (dx: number, dy: number, dz: number) => { q[0] = p[0] + dx; q[1] = p[1] + dy; q[2] = p[2] + dz; return field(q); };
  const gx = (at(e, 0, 0) - at(-e, 0, 0)) / (2 * e);
  const gy = (at(0, e, 0) - at(0, -e, 0)) / (2 * e);
  const gz = (at(0, 0, e) - at(0, 0, -e)) / (2 * e);
  const gl = Math.hypot(gx, gy, gz);
  if (gl < 1e-9) return min;
  const invE2 = 1 / (e * e), inv4E2 = 0.25 * invE2;
  const h00 = (at(e, 0, 0) - 2 * f0 + at(-e, 0, 0)) * invE2;
  const h11 = (at(0, e, 0) - 2 * f0 + at(0, -e, 0)) * invE2;
  const h22 = (at(0, 0, e) - 2 * f0 + at(0, 0, -e)) * invE2;
  const h01 = (at(e, e, 0) - at(e, -e, 0) - at(-e, e, 0) + at(-e, -e, 0)) * inv4E2;
  const h02 = (at(e, 0, e) - at(e, 0, -e) - at(-e, 0, e) + at(-e, 0, -e)) * inv4E2;
  const h12 = (at(0, e, e) - at(0, e, -e) - at(0, -e, e) + at(0, -e, -e)) * inv4E2;
  // The shape operator: the Hessian across the surface (I - n n) H (I - n n) / |g|; its size, sqrt(k1^2 + k2^2).
  const nx = gx / gl, ny = gy / gl, nz = gz / gl;
  const p00 = 1 - nx * nx, p01 = -nx * ny, p02 = -nx * nz;
  const p11 = 1 - ny * ny, p12 = -ny * nz, p22 = 1 - nz * nz;
  // First compute M = H * P
  const m00 = h00 * p00 + h01 * p01 + h02 * p02, m01 = h00 * p01 + h01 * p11 + h02 * p12, m02 = h00 * p02 + h01 * p12 + h02 * p22;
  const m10 = h01 * p00 + h11 * p01 + h12 * p02, m11 = h01 * p01 + h11 * p11 + h12 * p12, m12 = h01 * p02 + h11 * p12 + h12 * p22;
  const m20 = h02 * p00 + h12 * p01 + h22 * p02, m21 = h02 * p01 + h12 * p11 + h22 * p12, m22 = h02 * p02 + h12 * p12 + h22 * p22;
  // Then S = P * M (symmetric)
  const s00 = p00 * m00 + p01 * m10 + p02 * m20, s01 = p00 * m01 + p01 * m11 + p02 * m21, s02 = p00 * m02 + p01 * m12 + p02 * m22;
  const s11 = p01 * m01 + p11 * m11 + p12 * m21, s12 = p01 * m02 + p11 * m12 + p12 * m22, s22 = p02 * m02 + p12 * m12 + p22 * m22;
  const k = Math.sqrt(s00 * s00 + s11 * s11 + s22 * s22 + 2 * (s01 * s01 + s02 * s02 + s12 * s12)) / gl;
  return Math.min(max, Math.max(min, k > 1e-9 ? SEGMENT / k : max));
}

/** An edge this share of the radius of curvature: about thirty round a tube (at sixteen, a gown's bust and batwing came out half a percent harder to flatten than off the fine grid). */
const SEGMENT = 0.2;
