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
  /**
   * The strain 95% of the piece is within, as a fraction: maxStrain without
   * its few worst slivers. Each edge counts for the cloth it stands for (a
   * third of each triangle it bounds): the triangles are smaller where the surface curves, which
   * is where a piece must stretch to lie flat, and counted alike, those edges
   * read half as much again as the cloth they are.
   */
  strain95: number;
  /** Loops inside the outline along seams, as indices into `points`: double-ended darts, their slits opened. */
  darts?: number[][];
  /** Eased cloth: per triangle corner j (indices into `tris`), how much longer than it is the edge from corner j to j+1 lies flat by its ease. */
  edgeEase?: number[];
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
interface CgScratch {
  r: Float64Array;
  z: Float64Array;
  p: Float64Array;
  Ap: Float64Array;
  inv: Float64Array;
}

function makeCgScratch(diag: Float64Array): CgScratch {
  const n = diag.length;
  const inv = new Float64Array(n);
  for (let i = 0; i < n; i++) inv[i] = diag[i] > 1e-300 ? 1 / diag[i] : 1;
  return { r: new Float64Array(n), z: new Float64Array(n), p: new Float64Array(n), Ap: new Float64Array(n), inv };
}

function cg(apply: (x: Float64Array, out: Float64Array) => void, b: Float64Array, x: Float64Array, diag: Float64Array, iters = 2000, tol = 1e-12, scratch?: CgScratch) {
  const n = b.length;
  const { r, z, p, Ap, inv } = scratch ?? makeCgScratch(diag);
  apply(x, Ap);
  let rz = 0, rr = 0, bb = 0;
  for (let i = 0; i < n; i++) {
    const ri = b[i] - Ap[i], zi = inv[i] * ri;
    r[i] = ri; z[i] = zi; p[i] = zi;
    rz += ri * zi; rr += ri * ri; bb += b[i] * b[i];
  }
  const stop = tol * Math.max(1e-30, bb);
  for (let it = 0; it < iters && rr > stop; it++) {
    apply(p, Ap);
    let pAp = 0;
    for (let i = 0; i < n; i++) pAp += p[i] * Ap[i];
    if (Math.abs(pAp) < 1e-300) break;
    const alpha = rz / pAp;
    rr = 0;
    let rz2 = 0;
    for (let i = 0; i < n; i++) {
      x[i] += alpha * p[i];
      const ri = r[i] - alpha * Ap[i];
      const zi = inv[i] * ri;
      r[i] = ri; z[i] = zi;
      rr += ri * ri;
      rz2 += ri * zi;
    }
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
  // Assemble exact symmetric normal equations M = A^T A in vertex-level CSR:
  // each off-diagonal 2x2 block between vertices (i, j) has the form
  // [[s, a], [-a, s]] where s = sum w^2 (g_i . g_j) and a = sum w^2 (g_i x g_j),
  // and each diagonal 2x2 block is diagV[i] * I_2.
  const T = frames.length;
  const pinned = new Map(pin);
  const isPinned = new Uint8Array(n);
  const pinU = new Float64Array(n), pinV = new Float64Array(n);
  for (const [i, q] of pin) { isPinned[i] = 1; pinU[i] = q[0]; pinV[i] = q[1]; }

  // Pass 1: count directed off-diagonal triangle contributions per free row.
  const rawCount = new Int32Array(n);
  for (let t = 0; t < T; t++) {
    const v0 = tris[3 * t], v1 = tris[3 * t + 1], v2 = tris[3 * t + 2];
    const f0 = !isPinned[v0], f1 = !isPinned[v1], f2 = !isPinned[v2];
    if (f0) { if (f1) rawCount[v0]++; if (f2) rawCount[v0]++; }
    if (f1) { if (f0) rawCount[v1]++; if (f2) rawCount[v1]++; }
    if (f2) { if (f0) rawCount[v2]++; if (f1) rawCount[v2]++; }
  }
  const rawPtr = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) rawPtr[i + 1] = rawPtr[i] + rawCount[i];
  const rawTotal = rawPtr[n];
  const rawCol = new Int32Array(rawTotal);
  const rawSym = new Float64Array(rawTotal);
  const rawSkew = new Float64Array(rawTotal);
  const rawFill = rawPtr.slice(0, n);
  const diagFree = new Float64Array(n);
  const b = new Float64Array(2 * n);

  const gx = new Float64Array(3), gy = new Float64Array(3), vs = new Int32Array(3);
  for (let t = 0; t < T; t++) {
    const { p, area } = frames[t];
    const w2 = Math.max(area, 1e-16);
    const inv2A = 1 / (2 * area || 1e-16);
    vs[0] = tris[3 * t]; vs[1] = tris[3 * t + 1]; vs[2] = tris[3 * t + 2];
    for (let j = 0; j < 3; j++) {
      const a = p[(j + 1) % 3], bp = p[(j + 2) % 3];
      gx[j] = -(bp[1] - a[1]) * inv2A;
      gy[j] = (bp[0] - a[0]) * inv2A;
    }
    for (let j = 0; j < 3; j++) {
      const vi = vs[j];
      if (isPinned[vi]) continue;
      const gxj = gx[j], gyj = gy[j];
      diagFree[vi] += w2 * (gxj * gxj + gyj * gyj);
      for (let k = 0; k < 3; k++) {
        if (k === j) continue;
        const vj = vs[k], gxk = gx[k], gyk = gy[k];
        const s = w2 * (gxj * gxk + gyj * gyk);
        const sk = w2 * (gyj * gxk - gxj * gyk);
        if (isPinned[vj]) {
          const xu = pinU[vj], xv = pinV[vj];
          b[2 * vi] -= s * xu + sk * xv;
          b[2 * vi + 1] -= s * xv - sk * xu;
        } else {
          const pos = rawFill[vi]++;
          rawCol[pos] = vj;
          rawSym[pos] = s;
          rawSkew[pos] = sk;
        }
      }
    }
  }

  // Pass 2: deduplicate each row into compact CSR (merges interior edges shared by 2 triangles).
  const stamp = new Int32Array(n).fill(-1);
  const slotOf = new Int32Array(n);
  const rowPtr = new Int32Array(n + 1);
  const colIdx = new Int32Array(rawTotal);
  const valSym = new Float64Array(rawTotal);
  const valSkew = new Float64Array(rawTotal);
  let nnz = 0;
  for (let i = 0; i < n; i++) {
    rowPtr[i] = nnz;
    for (let p = rawPtr[i], end = rawPtr[i + 1]; p < end; p++) {
      const j = rawCol[p];
      if (stamp[j] === i) {
        const dst = slotOf[j];
        valSym[dst] += rawSym[p];
        valSkew[dst] += rawSkew[p];
      } else {
        stamp[j] = i;
        slotOf[j] = nnz;
        colIdx[nnz] = j;
        valSym[nnz] = rawSym[p];
        valSkew[nnz] = rawSkew[p];
        nnz++;
      }
    }
  }
  rowPtr[n] = nnz;

  const apply = (y: Float64Array, out: Float64Array) => {
    for (let i = 0; i < n; i++) {
      const i2 = 2 * i, d = diagFree[i];
      let su = d * y[i2], sv = d * y[i2 + 1];
      for (let p = rowPtr[i], end = rowPtr[i + 1]; p < end; p++) {
        const j2 = 2 * colIdx[p];
        const yu = y[j2], yv = y[j2 + 1];
        const s = valSym[p], sk = valSkew[p];
        su += s * yu + sk * yv;
        sv += s * yv - sk * yu;
      }
      out[i2] = su;
      out[i2 + 1] = sv;
    }
  };
  const diag = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    const dv = isPinned[i] ? 1 : diagFree[i];
    diag[2 * i] = dv;
    diag[2 * i + 1] = dv;
  }
  const free = new Float64Array(2 * n);
  cg(apply, b, free, diag, 4000, 1e-18);
  const out: V2[] = [];
  for (let i = 0; i < n; i++) out.push(pinned.get(i) ?? [free[2 * i], free[2 * i + 1]]);
  return out;
}

/**
 * As-rigid-as-possible relaxation (local/global): each triangle's best
 * rotation of its true shape onto the current layout, then the layout that
 * best fits those rotated triangles (a cotangent Laplacian, solved by CG).
 */
function arap(n: number, tris: number[], frames: { p: V2[]; area: number }[], init: V2[], iters: number, eased: EasedTri[] = [], slitEdge?: (va: number, vb: number) => boolean): V2[] {
  const uv = init.map((q) => [q[0], q[1]] as V2);
  const frames0 = eased.length ? frames.map((f) => f.p.map((q) => [q[0], q[1]] as V2)) : [];
  // Edge opposite corner j of triangle t (between corners j+1 and j+2), its cotangent weight, flat.
  const nF = frames.length, E = 3 * nF;
  const ea = new Int32Array(E), eb = new Int32Array(E), ew = new Float64Array(E);
  const diag = new Float64Array(n);
  const rawCount = new Int32Array(n);
  for (let t = 0; t < nF; t++) {
    const p = frames[t].p;
    for (let j = 0; j < 3; j++) {
      const a = p[j], b = p[(j + 1) % 3], c = p[(j + 2) % 3];
      const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - a[0], vy = c[1] - a[1];
      const cr = Math.abs(ux * vy - uy * vx) || 1e-12;
      const va = tris[3 * t + ((j + 1) % 3)], vb = tris[3 * t + ((j + 2) % 3)];
      const boost = slitEdge?.(va, vb) ? 3.5 : 1;
      const w = Math.max(1e-6, (ux * vx + uy * vy) / cr) * 0.5 * boost;
      ea[3 * t + j] = va;
      eb[3 * t + j] = vb;
      ew[3 * t + j] = w;
      diag[va] += w;
      diag[vb] += w;
      rawCount[va]++;
      rawCount[vb]++;
    }
  }
  diag[0] += 1;
  // Assemble deduplicated CSR for the fixed cotangent Laplacian L (cuts half-edge work in half + sequential writes).
  const rawPtr = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) rawPtr[i + 1] = rawPtr[i] + rawCount[i];
  const rawTotal = rawPtr[n];
  const rawCol = new Int32Array(rawTotal), rawVal = new Float64Array(rawTotal);
  const rawFill = rawPtr.slice(0, n);
  for (let e = 0; e < E; e++) {
    const a = ea[e], b = eb[e], w = ew[e];
    const pa = rawFill[a]++; rawCol[pa] = b; rawVal[pa] = w;
    const pb = rawFill[b]++; rawCol[pb] = a; rawVal[pb] = w;
  }
  const stamp = new Int32Array(n).fill(-1), slotOf = new Int32Array(n);
  const rowPtr = new Int32Array(n + 1);
  const colIdx = new Int32Array(rawTotal), val = new Float64Array(rawTotal);
  let nnz = 0;
  for (let i = 0; i < n; i++) {
    rowPtr[i] = nnz;
    for (let p = rawPtr[i], end = rawPtr[i + 1]; p < end; p++) {
      const j = rawCol[p];
      if (stamp[j] === i) {
        val[slotOf[j]] += rawVal[p];
      } else {
        stamp[j] = i;
        slotOf[j] = nnz;
        colIdx[nnz] = j;
        val[nnz] = rawVal[p];
        nnz++;
      }
    }
  }
  rowPtr[n] = nnz;
  const applyL = (x: Float64Array, out: Float64Array) => {
    for (let i = 0; i < n; i++) {
      let sum = diag[i] * x[i];
      for (let p = rowPtr[i], end = rowPtr[i + 1]; p < end; p++) sum -= val[p] * x[colIdx[p]];
      out[i] = sum;
    }
  };
  const scratch = makeCgScratch(diag);
  const bu = new Float64Array(n), bv = new Float64Array(n);
  const xu = new Float64Array(n), xv = new Float64Array(n);
  for (let i = 0; i < n; i++) { xu[i] = uv[i][0]; xv[i] = uv[i][1]; }
  // Flat edge vectors per triangle (6 floats per triangle: e0x, e0y, e1x, e1y, e2x, e2y) for fast local-step access.
  const triEdge = new Float64Array(6 * nF);
  for (let t = 0; t < nF; t++) {
    const p = frames[t].p, o = 6 * t;
    triEdge[o] = p[1][0] - p[2][0]; triEdge[o + 1] = p[1][1] - p[2][1];
    triEdge[o + 2] = p[2][0] - p[0][0]; triEdge[o + 3] = p[2][1] - p[0][1];
    triEdge[o + 4] = p[0][0] - p[1][0]; triEdge[o + 5] = p[0][1] - p[1][1];
  }
  for (let it = 0; it < iters; it++) {
    // Eased cloth rests as long along the seam as the layout makes it, between
    // its true length and that plus its ease: its triangle stretched that way.
    for (const { t, ease, dir } of eased) {
      const p0 = frames0[t], i0 = tris[3 * t], i1 = tris[3 * t + 1], i2 = tris[3 * t + 2];
      const ax = p0[1][0] - p0[0][0], ay = p0[1][1] - p0[0][1], bx = p0[2][0] - p0[0][0], by = p0[2][1] - p0[0][1];
      const det = ax * by - ay * bx;
      if (Math.abs(det) < 1e-16) continue;
      // The layout's stretch along the seam: F dir, F = (current edges) (true edges)^-1.
      const x = (dir[0] * by - dir[1] * bx) / det, y = (ax * dir[1] - ay * dir[0]) / det;
      const fx = x * (xu[i1] - xu[i0]) + y * (xu[i2] - xu[i0]), fy = x * (xv[i1] - xv[i0]) + y * (xv[i2] - xv[i0]);
      const f = Math.min(1 + ease, Math.max(1, Math.sqrt(fx * fx + fy * fy)));
      const fp = p0.map((q) => { const along = (q[0] - p0[0][0]) * dir[0] + (q[1] - p0[0][1]) * dir[1]; return [q[0] + (f - 1) * along * dir[0], q[1] + (f - 1) * along * dir[1]] as V2; });
      frames[t].p = fp;
      const o = 6 * t;
      triEdge[o] = fp[1][0] - fp[2][0]; triEdge[o + 1] = fp[1][1] - fp[2][1];
      triEdge[o + 2] = fp[2][0] - fp[0][0]; triEdge[o + 3] = fp[2][1] - fp[0][1];
      triEdge[o + 4] = fp[0][0] - fp[1][0]; triEdge[o + 5] = fp[0][1] - fp[1][1];
    }
    bu.fill(0); bv.fill(0);
    for (let t = 0; t < nF; t++) {
      const e0 = 3 * t, o = 6 * t;
      const va0 = ea[e0], vb0 = eb[e0], w0 = ew[e0];
      const va1 = ea[e0 + 1], vb1 = eb[e0 + 1], w1 = ew[e0 + 1];
      const va2 = ea[e0 + 2], vb2 = eb[e0 + 2], w2 = ew[e0 + 2];
      const ex0 = triEdge[o], ey0 = triEdge[o + 1];
      const ex1 = triEdge[o + 2], ey1 = triEdge[o + 3];
      const ex2 = triEdge[o + 4], ey2 = triEdge[o + 5];
      const ux0 = xu[va0] - xu[vb0], uy0 = xv[va0] - xv[vb0];
      const ux1 = xu[va1] - xu[vb1], uy1 = xv[va1] - xv[vb1];
      const ux2 = xu[va2] - xu[vb2], uy2 = xv[va2] - xv[vb2];
      // Best rotation: from the covariance of true and current edges.
      const s00 = w0 * ux0 * ex0 + w1 * ux1 * ex1 + w2 * ux2 * ex2;
      const s01 = w0 * ux0 * ey0 + w1 * ux1 * ey1 + w2 * ux2 * ey2;
      const s10 = w0 * uy0 * ex0 + w1 * uy1 * ex1 + w2 * uy2 * ex2;
      const s11 = w0 * uy0 * ey0 + w1 * uy1 * ey1 + w2 * uy2 * ey2;
      const ang = Math.atan2(s10 - s01, s00 + s11), c = Math.cos(ang), s = Math.sin(ang);
      const rx0 = w0 * (c * ex0 - s * ey0), ry0 = w0 * (s * ex0 + c * ey0);
      const rx1 = w1 * (c * ex1 - s * ey1), ry1 = w1 * (s * ex1 + c * ey1);
      const rx2 = w2 * (c * ex2 - s * ey2), ry2 = w2 * (s * ex2 + c * ey2);
      bu[va0] += rx0; bu[vb0] -= rx0; bv[va0] += ry0; bv[vb0] -= ry0;
      bu[va1] += rx1; bu[vb1] -= rx1; bv[va1] += ry1; bv[vb1] -= ry1;
      bu[va2] += rx2; bu[vb2] -= rx2; bv[va2] += ry2; bv[vb2] -= ry2;
    }
    bu[0] += xu[0]; bv[0] += xv[0];
    // Warm-started from the last layout; intermediate steps only need modest CG accuracy.
    const tol = it >= iters - 2 ? 1e-13 : 1e-10;
    cg(applyL, bu, xu, diag, 300, tol, scratch);
    cg(applyL, bv, xv, diag, 300, tol, scratch);
  }
  for (let i = 0; i < n; i++) { uv[i][0] = xu[i]; uv[i][1] = xv[i]; }
  return uv;
}

/** The piece's boundary loops, in order, each its boundary edges chained: the longest first (its outline), then any inside it (a double-ended dart's slit, opened). */
function loopsOf(n: number, tris: number[]): number[][] {
  const key = (a: number, b: number) => a * n + b;
  const has = new Set<number>();
  for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 3; e++) has.add(key(tris[t + e], tris[t + ((e + 1) % 3)]));
  const next = new Map<number, number>();
  for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = tris[t + e], b = tris[t + ((e + 1) % 3)];
    if (!has.has(key(b, a))) next.set(a, b);
  }
  const loops: number[][] = [];
  const seen = new Set<number>();
  for (const s of next.keys()) {
    if (seen.has(s)) continue;
    const loop: number[] = [];
    let v: number | undefined = s;
    while (v !== undefined && !seen.has(v)) { seen.add(v); loop.push(v); v = next.get(v); }
    loops.push(loop);
  }
  return loops.sort((a, b) => b.length - a.length);
}

/** The piece's outline, in order: its boundary edges chained. */
const outlineOf = (n: number, tris: number[]): number[] => loopsOf(n, tris)[0] ?? [];

/** A triangle within EASE_BAND of an eased edge: how much longer it may lie along the seam (`dir`, in its own frame). */
interface EasedTri { t: number; ease: number; dir: V2 }

/**
 * How far from an eased edge its ease is worked in, metres: a cap's ease is
 * shrunk into its seam allowance and the cloth just inside it. Measured on a
 * woven shirt's caps at 4%: over 3 cm, strain95 4.9%; over 2 cm (about a ring
 * of triangles), 5.4-5.7%; tapered to nothing at 3 cm, 5.4-5.8% even at 5%;
 * none, 6.2-6.4%.
 */
const EASE_BAND = 0.03;

/**
 * `edgeEase` (shell points a, b of an outline edge): how much longer than it
 * is that edge may lie flat, a fraction (a sleeve cap eased into its
 * armhole). The cloth along it, within EASE_BAND inside it, is
 * free to lie that much longer along the seam, and that much of its stretch
 * along the seam is not counted as strain.
 */
export function flattenPanel(name: string, shellPoints: number[][], shellTris: number[], panelTris: number[], seamPaths: number[][] = [], arapIters = 15, upAxis: number[] = [0, 0, 1], edgeEase?: (a: number, b: number) => number): FlatPiece {
  const n0 = shellPoints.length;
  const seams = new Set<number>();
  for (const path of seamPaths) for (let k = 1; k < path.length; k++) { const a = path[k - 1], b = path[k]; seams.add(a < b ? a * n0 + b : b * n0 + a); }
  const { points, tris } = submesh(shellTris, panelTris, (a, b) => seams.has(a < b ? a * n0 + b : b * n0 + a));
  const P = points.map((g) => shellPoints[g]);
  if (P.length < 3 || tris.length < 3) {
    return { name, points, uv: P.map(() => [0, 0] as V2), tris, outline: outlineOf(P.length, tris), maxStrain: 0, strain95: 0, areaChange: 0 };
  }
  const frames = triangleFrames(P, tris);
  // Pin the two points furthest apart, at their true distance, along u. A
  // panel across the body's middle (x = 0: a front, a back) is pinned at the
  // two ends of its centre line instead, so a piece the same either side
  // flattens the same either side: pinned at a sleeve's cuff and the hem's
  // far corner, a batwing gown's front came out lopsided, one sleeve higher.
  let a = 0, b = 1;
  let xLo = Infinity, xHi = -Infinity, yLo = Infinity, yHi = -Infinity, ySum = 0;
  for (const q of P) {
    xLo = Math.min(xLo, q[0]); xHi = Math.max(xHi, q[0]);
    yLo = Math.min(yLo, q[1]); yHi = Math.max(yHi, q[1]);
    ySum += q[1];
  }
  const across = xHi - xLo, depth = yHi - yLo;
  const mid = across > 0 && xLo < -0.25 * across && xHi > 0.25 * across;
  const rawMid = mid ? P.map((_, i) => i).filter((i) => Math.abs(P[i][0]) < 0.02 * across) : [];
  // Only restrict `onMid` to the dominant front/back side when `rawMid` itself spans BOTH front (-y)
  // and back (+y) across the body's depth (e.g. a 1-piece dual-crossing panel wrapping over head/shoulders),
  // never on an arc/collar whose centre-back naturally sits on one side while its tips curve forward!
  let midYLo = Infinity, midYHi = -Infinity;
  for (const i of rawMid) { midYLo = Math.min(midYLo, P[i][1]); midYHi = Math.max(midYHi, P[i][1]); }
  const dualCrossing = depth > 0 && midYLo < -0.15 * depth && midYHi > 0.15 * depth && (midYHi - midYLo) > 0.5 * depth;
  const domSign = ySum >= 0 ? 1 : -1;
  const sameSideMid = dualCrossing ? rawMid.filter((i) => P[i][1] * domSign >= 0) : rawMid;
  const onMid = sameSideMid.length >= 2 ? sameSideMid : rawMid;
  const stride = Math.max(1, Math.floor(P.length / 200));
  let far2 = -1;
  for (let i = 0; i < P.length; i += stride) {
    const pi = P[i], px = pi[0], py = pi[1], pz = pi[2];
    for (let j = 0; j < P.length; j++) {
      if (i === j) continue;
      const pj = P[j], dx = px - pj[0], dy = py - pj[1], dz = pz - pj[2];
      const dd2 = dx * dx + dy * dy + dz * dz;
      if (dd2 > far2) { far2 = dd2; a = i; b = j; }
    }
  }
  let far = far2 >= 0 ? Math.sqrt(far2) : -1;
  // Only where the centre line runs most of the piece: two pins close together
  // (a one-shouldered front that crosses the middle for a hand's breadth) would
  // leave the map's turn and scale to chance.
  let midFar = -1, ma = 0, mb = 0, midOff = Infinity;
  for (let ii = 0; ii < onMid.length; ii++) for (let jj = ii + 1; jj < onMid.length; jj++) {
    const i = onMid[ii], j = onMid[jj];
    const dd = Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1], P[i][2] - P[j][2]);
    const xOff = Math.abs(P[i][0]) + Math.abs(P[j][0]);
    if (dd > midFar + 1e-6 || (Math.abs(dd - midFar) <= 1e-6 && xOff < midOff)) { midFar = dd; ma = i; mb = j; midOff = xOff; }
  }
  if (ma !== mb && midFar >= 0.6 * far && midFar > 1e-6) { far = midFar; a = ma; b = mb; }
  if (a === b || !(far > 1e-9)) { a = 0; b = 1; far = Math.max(1e-6, Math.hypot(P[0][0] - P[1][0], P[0][1] - P[1][1], P[0][2] - P[1][2])); }
  let uv = lscm(P.length, tris, frames, [[a, [0, 0]], [b, [far, 0]]]);
  const eased: EasedTri[] = [];
  if (edgeEase) {
    const has = new Set<number>();
    for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 3; e++) has.add(tris[t + e] * P.length + tris[t + ((e + 1) % 3)]);
    const segs: { a: number[]; b: number[]; ease: number }[] = [];
    for (let t = 0; t < tris.length; t += 3) for (let j = 0; j < 3; j++) {
      const a = tris[t + j], b = tris[t + ((j + 1) % 3)];
      if (has.has(b * P.length + a)) continue; // inside the piece
      const ease = edgeEase(points[a], points[b]);
      if (ease > 0) segs.push({ a: P[a], b: P[b], ease });
    }
    if (segs.length) {
      for (let t = 0; t < tris.length; t += 3) {
        const A = P[tris[t]], B = P[tris[t + 1]], C = P[tris[t + 2]];
        const c = [0, 1, 2].map((k) => (A[k] + B[k] + C[k]) / 3);
        let best = Infinity, dir3 = [0, 0, 0], ease = 0;
        for (const sg of segs) {
          const d = [sg.b[0] - sg.a[0], sg.b[1] - sg.a[1], sg.b[2] - sg.a[2]], l2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2] || 1e-18;
          const u = Math.max(0, Math.min(1, ((c[0] - sg.a[0]) * d[0] + (c[1] - sg.a[1]) * d[1] + (c[2] - sg.a[2]) * d[2]) / l2));
          const dist = Math.hypot(c[0] - sg.a[0] - u * d[0], c[1] - sg.a[1] - u * d[1], c[2] - sg.a[2] - u * d[2]);
          if (dist < best) { best = dist; const l = Math.sqrt(l2); dir3 = [d[0] / l, d[1] / l, d[2] / l]; ease = sg.ease; }
        }
        const e = best < EASE_BAND ? ease : 0;
        if (e <= 0) continue;
        // The seam's direction in the triangle's own frame (triangleFrames: x along its first edge).
        const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
        const l1 = Math.hypot(e1[0], e1[1], e1[2]) || 1e-12, x = e1.map((v) => v / l1);
        const nn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const y = [nn[1] * x[2] - nn[2] * x[1], nn[2] * x[0] - nn[0] * x[2], nn[0] * x[1] - nn[1] * x[0]], yl = Math.hypot(y[0], y[1], y[2]) || 1e-12;
        const dx = dir3[0] * x[0] + dir3[1] * x[1] + dir3[2] * x[2], dy = (dir3[0] * y[0] + dir3[1] * y[1] + dir3[2] * y[2]) / yl, dl = Math.hypot(dx, dy);
        if (dl < 1e-6) continue;
        eased.push({ t: t / 3, ease: e, dir: [dx / dl, dy / dl] });
      }
    }
  }
  const easeOf = new Map(eased.map((et) => [et.t, et]));
  const frames3 = eased.length ? frames.map((f) => ({ p: f.p.map((q) => [q[0], q[1]] as V2), area: f.area })) : frames;
  // Edges where the piece was slit open along an internal seam or dart (both sides
  // in this piece, sharing shell endpoints) sew back to each other, so keep both
  // sides true to their shared 3D length.
  const shellEdgeCount = new Map<number, number>();
  for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 3; e++) {
    const ga = points[tris[t + e]], gb = points[tris[t + ((e + 1) % 3)]];
    const k = ga < gb ? ga * n0 + gb : gb * n0 + ga;
    if (seams.has(k)) shellEdgeCount.set(k, (shellEdgeCount.get(k) ?? 0) + 1);
  }
  const isSlitEdge = shellEdgeCount.size
    ? (va: number, vb: number) => {
        const ga = points[va], gb = points[vb];
        const k = ga < gb ? ga * n0 + gb : gb * n0 + ga;
        return (shellEdgeCount.get(k) ?? 0) >= 2;
      }
    : undefined;
  uv = arap(P.length, tris, frames3, uv, arapIters, eased, isSlitEdge);
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
    const minEdge = new Float64Array(P.length).fill(Infinity);
    for (let t = 0; t < tris.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const i = tris[t + e], j = tris[t + ((e + 1) % 3)];
        const l3 = Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1], P[i][2] - P[j][2]);
        if (l3 < minEdge[i]) minEdge[i] = l3;
        if (l3 < minEdge[j]) minEdge[j] = l3;
      }
    }
    const uv0 = uv.map((q) => [q[0], q[1]] as V2);
    for (let pass = 0; pass < 4; pass++) {
      for (const w of [0.40, -0.41]) {
        const next = new Map<number, V2>();
        for (const [iPrev, iCur, iNext] of smoothVtx) {
          const pa = uv[iPrev], pv = uv[iCur], pb = uv[iNext];
          const cu = pb[0] - pa[0], cv = pb[1] - pa[1];
          const c2 = cu * cu + cv * cv;
          if (c2 < 1e-12) continue;
          const t = ((pv[0] - pa[0]) * cu + (pv[1] - pa[1]) * cv) / c2;
          let nu = pv[0] + w * (pa[0] + t * cu - pv[0]);
          let nv = pv[1] + w * (pa[1] + t * cv - pv[1]);
          const du = nu - uv0[iCur][0], dv = nv - uv0[iCur][1], dl = Math.hypot(du, dv);
          const cap = 0.03 * minEdge[iCur];
          if (dl > cap && dl > 1e-12) { nu = uv0[iCur][0] + (du * cap) / dl; nv = uv0[iCur][1] + (dv * cap) / dl; }
          next.set(iCur, [nu, nv]);
        }
        for (const [iCur, q] of next) uv[iCur] = q;
      }
    }
  }
  // Turned so `upAxis` (the body's +z, or along a limb toward its root) runs
  // up the piece (+v), and mirrored if the layout came out face down.
  // Which way is up, triangle by triangle (the way height climbs across it
  // flat), each by its area and how steeply it climbs: a short band wrapped round the body flattens to
  // an arc, and its points' height against where they lie flat turned the
  // grain of a puffer's channels diagonal.
  let su = 0, sv = 0;
  const hAt = (q: number[]) => q[0] * upAxis[0] + q[1] * upAxis[1] + q[2] * upAxis[2];
  for (let t = 0; t < tris.length; t += 3) {
    const [i, j, k] = [tris[t], tris[t + 1], tris[t + 2]];
    const e1 = [uv[j][0] - uv[i][0], uv[j][1] - uv[i][1]], e2 = [uv[k][0] - uv[i][0], uv[k][1] - uv[i][1]];
    const det = e1[0] * e2[1] - e1[1] * e2[0];
    if (Math.abs(det) < 1e-14) continue;
    const d1 = hAt(P[j]) - hAt(P[i]), d2 = hAt(P[k]) - hAt(P[i]);
    // Not made unit: a triangle lying level (the top of a shoulder) has no up to give.
    const gu = (d1 * e2[1] - d2 * e1[1]) / det, gv = (e1[0] * d2 - e2[0] * d1) / det, area = Math.abs(det) / 2;
    su += gu * area; sv += gv * area;
  }
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
  const edgeEaseOut = eased.length ? new Array(tris.length).fill(0) : undefined;
  const strains: [number, number][] = [];
  for (let t = 0; t < tris.length; t += 3) {
    area3 += frames[t / 3].area;
    const [p, q, r] = [uv[tris[t]], uv[tris[t + 1]], uv[tris[t + 2]]];
    area2 += Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1])) / 2;
    for (let e = 0; e < 3; e++) {
      const i = tris[t + e], j = tris[t + ((e + 1) % 3)];
      const l3 = Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1], P[i][2] - P[j][2]);
      const l2 = Math.hypot(uv[i][0] - uv[j][0], uv[i][1] - uv[j][1]);
      // Eased cloth: its stretch along the seam, up to its ease, is the ease.
      const et = easeOf.get(t / 3);
      let allowed = 0;
      if (et) {
        const fp = frames[t / 3].p, ex = fp[(e + 1) % 3][0] - fp[e][0], ey = fp[(e + 1) % 3][1] - fp[e][1], el2 = ex * ex + ey * ey || 1e-18;
        allowed = (et.ease * (ex * et.dir[0] + ey * et.dir[1]) ** 2) / el2;
        edgeEaseOut![t + e] = allowed;
      }
      if (l3 > 1e-6) { const st0 = l2 / l3 - 1, st = st0 > 0 ? Math.max(0, st0 - allowed) : st0; strains.push([Math.abs(st), frames[t / 3].area / 3]); if (Math.abs(st) > Math.abs(maxStrain)) maxStrain = st; }
    }
  }
  // Centred on its own bounding box.
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [u, v] of uv) { u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
  uv = uv.map(([u, v]) => [u - (u0 + u1) / 2, v - (v0 + v1) / 2] as V2);
  strains.sort((x, y) => x[0] - y[0]);
  const whole = strains.reduce((acc, [, w]) => acc + w, 0);
  let strain95 = 0;
  for (let k = 0, acc = 0; k < strains.length; k++) { acc += strains[k][1]; strain95 = strains[k][0]; if (acc >= 0.95 * whole) break; }
  // Loops inside it that run all along seams: slits sewn closed, darts.
  const [outer = [], ...inner] = loopsOf(P.length, tris);
  const sewnShut = (l: number[]) => l.length >= 3 && l.every((v, k) => { const a = points[v], b = points[l[(k + 1) % l.length]]; return seams.has(a < b ? a * n0 + b : b * n0 + a); });
  const darts = inner.filter(sewnShut);
  return { name, points, uv, tris, outline: outer, ...(darts.length ? { darts } : {}), maxStrain, strain95, areaChange: area2 / Math.max(1e-12, area3) - 1, ...(edgeEaseOut ? { edgeEase: edgeEaseOut } : {}) };
}
