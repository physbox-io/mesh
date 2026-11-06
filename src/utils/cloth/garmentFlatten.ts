/**
 * A garment's panels flattened into pieces of cloth to cut. Each panel of the
 * modelled surface (garmentShell.ts) is laid flat: first conformally (LSCM,
 * angles kept), then relaxed as-rigid-as-possible (ARAP) so every triangle
 * keeps its size as well, because cloth does not stretch to order. What is
 * left over is the distortion: how much a panel had to stretch or shrink to
 * lie flat, which says whether it can be cut as it is or wants a dart.
 *
 * Pure: points and triangles in, flat pieces out.
 */

export interface FlatPiece {
  name: string;
  /** Shell point index of each of the piece's points. */
  points: number[];
  /** Flat position of each point, metres: v runs up the body. */
  uv: [number, number][];
  /** Triangles, as indices into `points`/`uv`. */
  tris: number[];
  /** The piece's outline: indices into `points`, in order round it. */
  outline: number[];
  /** Most any edge had to stretch (+) or shrink (-) to lie flat, as a fraction. */
  maxStrain: number;
  /** Area flat over area in 3D, minus one. */
  areaChange: number;
  /** The strain 95% of the piece's edges are within, as a fraction: maxStrain without its few worst slivers. */
  strain95: number;
}

type V2 = [number, number];

/**
 * A panel's own points and triangles, from the shell's. A seam that runs
 * through the panel (a sleeve's underarm, a dart's slit) is opened: each of
 * its points gets one copy per side, so the panel can lie flat. Two
 * triangles share a point here only if they are joined round it by edges
 * that are not seams.
 */
function submesh(tris: number[], panelTris: number[], seamEdge: (a: number, b: number) => boolean) {
  // Triangles round each point, then grouped by flood fill across non-seam edges.
  const around = new Map<number, number[]>();
  for (const t of panelTris) for (let k = 0; k < 3; k++) {
    const g = tris[3 * t + k];
    (around.get(g) ?? around.set(g, []).get(g)!).push(t);
  }
  const copyOf = new Map<string, number>(); // `${t}:${g}` -> local point
  const points: number[] = [];
  for (const [g, ts] of around) {
    const group = new Map<number, number>();
    for (const t0 of ts) {
      if (group.has(t0)) continue;
      const id = points.length;
      points.push(g);
      const stack = [t0];
      group.set(t0, id);
      while (stack.length) {
        const t = stack.pop()!;
        // The two other corners: an edge g-o of t joins it to the other triangle round g with that edge.
        for (let k = 0; k < 3; k++) {
          const o = tris[3 * t + k];
          if (o === g || seamEdge(g, o)) continue;
          for (const u of ts) {
            if (group.has(u)) continue;
            if (tris[3 * u] === o || tris[3 * u + 1] === o || tris[3 * u + 2] === o) { group.set(u, id); stack.push(u); }
          }
        }
      }
    }
    for (const [t, id] of group) copyOf.set(`${t}:${g}`, id);
  }
  const local: number[] = [];
  for (const t of panelTris) for (let k = 0; k < 3; k++) local.push(copyOf.get(`${t}:${tris[3 * t + k]}`)!);
  return { points, tris: local };
}

/** Each triangle laid in its own plane: 2D coordinates of its corners, and its area. */
function triangleFrames(P: number[][], tris: number[]) {
  const out: { p: V2[]; area: number }[] = [];
  for (let t = 0; t < tris.length; t += 3) {
    const a = P[tris[t]], b = P[tris[t + 1]], c = P[tris[t + 2]];
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const l1 = Math.hypot(e1[0], e1[1], e1[2]) || 1e-12;
    const x = e1.map((v) => v / l1);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const area = Math.hypot(n[0], n[1], n[2]) / 2;
    const y = [n[1] * x[2] - n[2] * x[1], n[2] * x[0] - n[0] * x[2], n[0] * x[1] - n[1] * x[0]];
    const yl = Math.hypot(y[0], y[1], y[2]) || 1e-12;
    const px = e2[0] * x[0] + e2[1] * x[1] + e2[2] * x[2], py = (e2[0] * y[0] + e2[1] * y[1] + e2[2] * y[2]) / yl;
    out.push({ p: [[0, 0], [l1, 0], [px, py]], area });
  }
  return out;
}

/**
 * Conjugate gradients on a symmetric positive (semi)definite operator,
 * preconditioned by its diagonal `diag` (Jacobi): without it the conformal
 * map of a panel of several thousand triangles had not converged in its
 * budget of steps, and the layout folded over itself.
 */
function cg(apply: (x: Float64Array, out: Float64Array) => void, b: Float64Array, x: Float64Array, diag: Float64Array, iters = 2000, tol = 1e-12) {
  const n = b.length, r = new Float64Array(n), z = new Float64Array(n), p = new Float64Array(n), Ap = new Float64Array(n);
  const inv = diag.map((d) => (d > 1e-300 ? 1 / d : 1));
  apply(x, Ap);
  for (let i = 0; i < n; i++) { r[i] = b[i] - Ap[i]; z[i] = inv[i] * r[i]; p[i] = z[i]; }
  let rz = 0, rr = 0;
  for (let i = 0; i < n; i++) { rz += r[i] * z[i]; rr += r[i] * r[i]; }
  const stop = tol * Math.max(1e-30, b.reduce((s, v) => s + v * v, 0));
  for (let it = 0; it < iters && rr > stop; it++) {
    apply(p, Ap);
    let pAp = 0;
    for (let i = 0; i < n; i++) pAp += p[i] * Ap[i];
    if (Math.abs(pAp) < 1e-300) break;
    const alpha = rz / pAp;
    rr = 0;
    for (let i = 0; i < n; i++) { x[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; z[i] = inv[i] * r[i]; rr += r[i] * r[i]; }
    let rz2 = 0;
    for (let i = 0; i < n; i++) rz2 += r[i] * z[i];
    const beta = rz2 / rz;
    rz = rz2;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
  }
  return x;
}

/**
 * Least-squares conformal map. Unknowns u and v per point; per triangle, the
 * residual of the Cauchy-Riemann condition (grad v = R90 grad u), weighted by
 * the root of its area. Two points pinned, far apart, so the map is fixed.
 */
function lscm(n: number, tris: number[], frames: { p: V2[]; area: number }[], pin: [number, V2][]): V2[] {
  // Each triangle's rows: r = sum_j (v_j g_j - u_j R90 g_j), g_j = grad phi_j.
  const rows: { idx: number[]; cu: number[][]; cv: number[][] }[] = [];
  frames.forEach(({ p, area }, t) => {
    const w = Math.sqrt(Math.max(area, 1e-16));
    const idx = [tris[3 * t], tris[3 * t + 1], tris[3 * t + 2]];
    const cu: number[][] = [[0, 0, 0], [0, 0, 0]], cv: number[][] = [[0, 0, 0], [0, 0, 0]];
    for (let j = 0; j < 3; j++) {
      const a = p[(j + 1) % 3], b = p[(j + 2) % 3];
      // Opposite edge turned a quarter, over twice the area.
      const g: V2 = [-(b[1] - a[1]) / (2 * area || 1e-16), (b[0] - a[0]) / (2 * area || 1e-16)];
      const r90: V2 = [-g[1], g[0]];
      for (let c = 0; c < 2; c++) { cv[c][j] = w * g[c]; cu[c][j] = -w * r90[c]; }
    }
    rows.push({ idx, cu, cv });
  });
  const pinned = new Map(pin);
  const x = new Float64Array(2 * n); // u0 v0 u1 v1 ...
  for (const [i, q] of pin) { x[2 * i] = q[0]; x[2 * i + 1] = q[1]; }
  // Normal equations restricted to the free unknowns.
  const apply = (y: Float64Array, out: Float64Array) => {
    out.fill(0);
    for (const { idx, cu, cv } of rows) {
      for (let c = 0; c < 2; c++) {
        let r = 0;
        for (let j = 0; j < 3; j++) r += cu[c][j] * y[2 * idx[j]] + cv[c][j] * y[2 * idx[j] + 1];
        for (let j = 0; j < 3; j++) { out[2 * idx[j]] += cu[c][j] * r; out[2 * idx[j] + 1] += cv[c][j] * r; }
      }
    }
    for (const i of pinned.keys()) { out[2 * i] = 0; out[2 * i + 1] = 0; }
  };
  // Right-hand side: minus what the pinned values contribute.
  const xp = new Float64Array(2 * n);
  for (const [i, q] of pin) { xp[2 * i] = q[0]; xp[2 * i + 1] = q[1]; }
  const b = new Float64Array(2 * n);
  for (const { idx, cu, cv } of rows) {
    for (let c = 0; c < 2; c++) {
      let r = 0;
      for (let j = 0; j < 3; j++) r += cu[c][j] * xp[2 * idx[j]] + cv[c][j] * xp[2 * idx[j] + 1];
      for (let j = 0; j < 3; j++) { b[2 * idx[j]] -= cu[c][j] * r; b[2 * idx[j] + 1] -= cv[c][j] * r; }
    }
  }
  for (const i of pinned.keys()) { b[2 * i] = 0; b[2 * i + 1] = 0; }
  const diag = new Float64Array(2 * n);
  for (const { idx, cu, cv } of rows) for (let c = 0; c < 2; c++) for (let j = 0; j < 3; j++) { diag[2 * idx[j]] += cu[c][j] ** 2; diag[2 * idx[j] + 1] += cv[c][j] ** 2; }
  for (const i of pinned.keys()) { diag[2 * i] = 1; diag[2 * i + 1] = 1; }
  const free = new Float64Array(2 * n);
  cg(apply, b, free, diag, 4000, 1e-20);
  const out: V2[] = [];
  for (let i = 0; i < n; i++) out.push(pinned.get(i) ?? [free[2 * i], free[2 * i + 1]]);
  return out;
}

/**
 * As-rigid-as-possible relaxation (local/global): each triangle's best
 * rotation of its true shape onto the current layout, then the layout that
 * best fits those rotated triangles (a cotangent Laplacian, solved by CG).
 */
function arap(n: number, tris: number[], frames: { p: V2[]; area: number }[], init: V2[], iters: number): V2[] {
  const uv = init.map((q) => [q[0], q[1]] as V2);
  // Cotangent weights per triangle edge (half the cotangent of the opposite angle).
  const cot = frames.map(({ p }) => [0, 1, 2].map((j) => {
    const a = p[j], b = p[(j + 1) % 3], c = p[(j + 2) % 3];
    const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - a[0], c[1] - a[1]];
    const cr = Math.abs(u[0] * v[1] - u[1] * v[0]) || 1e-12;
    return Math.max(1e-6, (u[0] * v[0] + u[1] * v[1]) / cr) / 2;
  }));
  const applyL = (x: Float64Array, out: Float64Array) => {
    out.fill(0);
    for (let t = 0; t < frames.length; t++) {
      for (let j = 0; j < 3; j++) {
        // Edge opposite corner j: between corners j+1 and j+2.
        const a = tris[3 * t + ((j + 1) % 3)], b = tris[3 * t + ((j + 2) % 3)], w = cot[t][j];
        out[a] += w * (x[a] - x[b]); out[b] += w * (x[b] - x[a]);
      }
    }
    out[0] += x[0]; // anchor the first point, so the system is not singular
  };
  const diag = new Float64Array(n);
  for (let t = 0; t < frames.length; t++) for (let j = 0; j < 3; j++) { const w = cot[t][j]; diag[tris[3 * t + ((j + 1) % 3)]] += w; diag[tris[3 * t + ((j + 2) % 3)]] += w; }
  diag[0] += 1;
  for (let it = 0; it < iters; it++) {
    const bu = new Float64Array(n), bv = new Float64Array(n);
    for (let t = 0; t < frames.length; t++) {
      const p = frames[t].p, ids = [tris[3 * t], tris[3 * t + 1], tris[3 * t + 2]];
      // Best rotation: from the covariance of true and current edges.
      let s00 = 0, s01 = 0, s10 = 0, s11 = 0;
      for (let j = 0; j < 3; j++) {
        const a = (j + 1) % 3, b = (j + 2) % 3, w = cot[t][j];
        const ex = p[a][0] - p[b][0], ey = p[a][1] - p[b][1];
        const ux = uv[ids[a]][0] - uv[ids[b]][0], uy = uv[ids[a]][1] - uv[ids[b]][1];
        s00 += w * ux * ex; s01 += w * ux * ey; s10 += w * uy * ex; s11 += w * uy * ey;
      }
      const ang = Math.atan2(s10 - s01, s00 + s11), c = Math.cos(ang), s = Math.sin(ang);
      for (let j = 0; j < 3; j++) {
        const a = (j + 1) % 3, b = (j + 2) % 3, w = cot[t][j];
        const ex = p[a][0] - p[b][0], ey = p[a][1] - p[b][1];
        const rx = c * ex - s * ey, ry = s * ex + c * ey;
        bu[ids[a]] += w * rx; bu[ids[b]] -= w * rx;
        bv[ids[a]] += w * ry; bv[ids[b]] -= w * ry;
      }
    }
    bu[0] += uv[0][0]; bv[0] += uv[0][1];
    const xu = Float64Array.from(uv.map((q) => q[0])), xv = Float64Array.from(uv.map((q) => q[1]));
    // Warm-started from the last layout, so a few hundred steps converge.
    cg(applyL, bu, xu, diag, 300, 1e-14);
    cg(applyL, bv, xv, diag, 300, 1e-14);
    for (let i = 0; i < n; i++) uv[i] = [xu[i], xv[i]];
  }
  return uv;
}

/** The piece's outline, in order: its boundary edges chained. */
function outlineOf(n: number, tris: number[]): number[] {
  const key = (a: number, b: number) => a * n + b;
  const has = new Set<number>();
  for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 3; e++) has.add(key(tris[t + e], tris[t + ((e + 1) % 3)]));
  const next = new Map<number, number>();
  for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = tris[t + e], b = tris[t + ((e + 1) % 3)];
    if (!has.has(key(b, a))) next.set(a, b);
  }
  let best: number[] = [];
  const seen = new Set<number>();
  for (const s of next.keys()) {
    if (seen.has(s)) continue;
    const loop: number[] = [];
    let v: number | undefined = s;
    while (v !== undefined && !seen.has(v)) { seen.add(v); loop.push(v); v = next.get(v); }
    if (loop.length > best.length) best = loop;
  }
  return best;
}

export function flattenPanel(name: string, shellPoints: number[][], shellTris: number[], panelTris: number[], seamPaths: number[][] = [], arapIters = 15): FlatPiece {
  const n0 = shellPoints.length;
  const seams = new Set<number>();
  for (const path of seamPaths) for (let k = 1; k < path.length; k++) { const a = path[k - 1], b = path[k]; seams.add(a < b ? a * n0 + b : b * n0 + a); }
  const { points, tris } = submesh(shellTris, panelTris, (a, b) => seams.has(a < b ? a * n0 + b : b * n0 + a));
  const P = points.map((g) => shellPoints[g]);
  const frames = triangleFrames(P, tris);
  // Pin the two points furthest apart, at their true distance, along u.
  let a = 0, b = 0, far = -1;
  for (let i = 0; i < P.length; i += Math.max(1, Math.floor(P.length / 200))) {
    for (let j = 0; j < P.length; j++) {
      const dd = Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1], P[i][2] - P[j][2]);
      if (dd > far) { far = dd; a = i; b = j; }
    }
  }
  let uv = lscm(P.length, tris, frames, [[a, [0, 0]], [b, [far, 0]]]);
  uv = arap(P.length, tris, frames, uv, arapIters);
  const outline = outlineOf(P.length, tris);
  // Fair smooth runs of the 2D outline between corners (Taubin lambda/mu
  // filter, which removes alternating triangle-split sawtooth noise without
  // shrinking curved edges), then relax a few ARAP steps so interior
  // triangles conform smoothly.
  if (outline.length >= 6) {
    const m = outline.length;
    const smoothVtx: [number, number, number][] = [];
    for (let k = 0; k < m; k++) {
      const iPrev = outline[(k - 1 + m) % m], iCur = outline[k], iNext = outline[(k + 1) % m];
      const u1 = [P[iCur][0] - P[iPrev][0], P[iCur][1] - P[iPrev][1], P[iCur][2] - P[iPrev][2]];
      const u2 = [P[iNext][0] - P[iCur][0], P[iNext][1] - P[iCur][1], P[iNext][2] - P[iCur][2]];
      const l1 = Math.hypot(u1[0], u1[1], u1[2]) || 1, l2 = Math.hypot(u2[0], u2[1], u2[2]) || 1;
      const cos3 = (u1[0] * u2[0] + u1[1] * u2[1] + u1[2] * u2[2]) / (l1 * l2);
      const v1 = [uv[iCur][0] - uv[iPrev][0], uv[iCur][1] - uv[iPrev][1]];
      const v2 = [uv[iNext][0] - uv[iCur][0], uv[iNext][1] - uv[iCur][1]];
      const d1 = Math.hypot(v1[0], v1[1]) || 1, d2 = Math.hypot(v2[0], v2[1]) || 1;
      const cos2 = (v1[0] * v2[0] + v1[1] * v2[1]) / (d1 * d2);
      if (cos3 > 0.78 && cos2 > 0.78) smoothVtx.push([iPrev, iCur, iNext]);
    }
    for (let pass = 0; pass < 4; pass++) {
      for (const w of [0.40, -0.41]) {
        const next = new Map<number, V2>();
        for (const [iPrev, iCur, iNext] of smoothVtx) {
          const pa = uv[iPrev], pv = uv[iCur], pb = uv[iNext];
          const cu = pb[0] - pa[0], cv = pb[1] - pa[1];
          const c2 = cu * cu + cv * cv;
          if (c2 < 1e-12) continue;
          const t = ((pv[0] - pa[0]) * cu + (pv[1] - pa[1]) * cv) / c2;
          next.set(iCur, [
            pv[0] + w * (pa[0] + t * cu - pv[0]),
            pv[1] + w * (pa[1] + t * cv - pv[1]),
          ]);
        }
        for (const [iCur, q] of next) uv[iCur] = q;
      }
    }
  }
  // Turned so the body's up (z) runs up the piece (+v), and mirrored if the
  // layout came out face down.
  let su = 0, sv = 0;
  const zMean = P.reduce((s, q) => s + q[2], 0) / P.length;
  for (let i = 0; i < P.length; i++) { su += uv[i][0] * (P[i][2] - zMean); sv += uv[i][1] * (P[i][2] - zMean); }
  const ang = Math.PI / 2 - Math.atan2(sv, su), c = Math.cos(ang), s = Math.sin(ang);
  uv = uv.map(([u, v]) => [c * u - s * v, s * u + c * v] as V2);
  let signed = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const [p, q, r] = [uv[tris[t]], uv[tris[t + 1]], uv[tris[t + 2]]];
    signed += (q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1]);
  }
  if (signed < 0) uv = uv.map(([u, v]) => [-u, v] as V2);
  // Distortion: edges and area, flat against true.
  let maxStrain = 0, area3 = 0, area2 = 0;
  const strains: number[] = [];
  for (let t = 0; t < tris.length; t += 3) {
    area3 += frames[t / 3].area;
    const [p, q, r] = [uv[tris[t]], uv[tris[t + 1]], uv[tris[t + 2]]];
    area2 += Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1])) / 2;
    for (let e = 0; e < 3; e++) {
      const i = tris[t + e], j = tris[t + ((e + 1) % 3)];
      const l3 = Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1], P[i][2] - P[j][2]);
      const l2 = Math.hypot(uv[i][0] - uv[j][0], uv[i][1] - uv[j][1]);
      if (l3 > 1e-6) { const st = l2 / l3 - 1; strains.push(Math.abs(st)); if (Math.abs(st) > Math.abs(maxStrain)) maxStrain = st; }
    }
  }
  // Centred on its own bounding box.
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [u, v] of uv) { u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
  uv = uv.map(([u, v]) => [u - (u0 + u1) / 2, v - (v0 + v1) / 2] as V2);
  strains.sort((x, y) => x - y);
  const strain95 = strains[Math.floor(strains.length * 0.95)] ?? 0;
  return { name, points, uv, tris, outline: outlineOf(P.length, tris), maxStrain, strain95, areaChange: area2 / Math.max(1e-12, area3) - 1 };
}
