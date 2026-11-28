/**
 * A sparse symmetric positive definite matrix factored once (L L^T) and
 * solved against many right-hand sides: rows renumbered by reverse
 * Cuthill-McKee so the nonzeros hug the diagonal, then a profile (envelope)
 * Cholesky. For a mesh's Laplacian, whose matrix does not change while what
 * it is solved for does (ARAP's global step, garmentFlatten), each solve is
 * two triangular sweeps instead of a conjugate-gradient run.
 */

export interface EnvelopeCholesky {
  /** Solves A x = b; `x` may be `b`. */
  solve(b: Float64Array, x: Float64Array): void;
}

/** Reverse Cuthill-McKee order of the graph `rowPtr`/`colIdx` (each component from a vertex of least degree). */
function rcm(n: number, rowPtr: Int32Array, colIdx: Int32Array): Int32Array {
  const degree = new Int32Array(n);
  for (let i = 0; i < n; i++) degree[i] = rowPtr[i + 1] - rowPtr[i];
  const order = new Int32Array(n), seen = new Uint8Array(n);
  const byDegree = Array.from({ length: n }, (_, i) => i).sort((a, b) => degree[a] - degree[b]);
  let head = 0, tail = 0;
  const nbrs: number[] = [];
  for (const start of byDegree) {
    if (seen[start]) continue;
    seen[start] = 1; order[tail++] = start;
    while (head < tail) {
      const v = order[head++];
      nbrs.length = 0;
      for (let p = rowPtr[v]; p < rowPtr[v + 1]; p++) { const u = colIdx[p]; if (u !== v && !seen[u]) { seen[u] = 1; nbrs.push(u); } }
      nbrs.sort((a, b) => degree[a] - degree[b]);
      for (const u of nbrs) order[tail++] = u;
    }
  }
  return order.reverse();
}

/**
 * Factors A = diag + off-diagonal entries (`rowPtr`/`colIdx`/`val`, both
 * triangles, `sign` times each: -1 for a Laplacian stored by its weights).
 * Null if the envelope would be larger than `maxEntries`, or A is not
 * positive definite.
 */
export function envelopeCholesky(n: number, diag: ArrayLike<number>, rowPtr: Int32Array, colIdx: Int32Array, val: ArrayLike<number>, sign = 1, maxEntries = 20_000_000): EnvelopeCholesky | null {
  const perm = rcm(n, rowPtr, colIdx), at = new Int32Array(n);
  for (let k = 0; k < n; k++) at[perm[k]] = k;
  // Each new row's first column in the lower triangle.
  const first = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    let f = k;
    const i = perm[k];
    for (let p = rowPtr[i]; p < rowPtr[i + 1]; p++) { const c = at[colIdx[p]]; if (c < f) f = c; }
    first[k] = f;
  }
  const start = new Float64Array(n + 1);
  for (let k = 0; k < n; k++) start[k + 1] = start[k] + (k - first[k] + 1);
  if (start[n] > maxEntries) return null;
  const off = new Int32Array(n + 1);
  for (let k = 0; k <= n; k++) off[k] = start[k];
  // L, row by row: row k holds columns first[k] .. k.
  const L = new Float64Array(off[n]);
  for (let k = 0; k < n; k++) {
    const i = perm[k];
    L[off[k] + (k - first[k])] += diag[i];
    for (let p = rowPtr[i]; p < rowPtr[i + 1]; p++) {
      const c = at[colIdx[p]];
      if (c < k) L[off[k] + (c - first[k])] += sign * val[p];
      else if (c === k) L[off[k] + (k - first[k])] += sign * val[p];
    }
  }
  for (let k = 0; k < n; k++) {
    const fk = first[k], ok = off[k] - fk;
    for (let j = fk; j < k; j++) {
      const fj = first[j], oj = off[j] - fj;
      let s = L[ok + j];
      for (let q = fk > fj ? fk : fj; q < j; q++) s -= L[ok + q] * L[oj + q];
      L[ok + j] = s / L[oj + j];
    }
    let d = L[ok + k];
    for (let q = fk; q < k; q++) d -= L[ok + q] * L[ok + q];
    if (!(d > 0)) return null;
    L[ok + k] = Math.sqrt(d);
  }
  const y = new Float64Array(n);
  return {
    solve(b, x) {
      for (let k = 0; k < n; k++) {
        const fk = first[k], ok = off[k] - fk;
        let s = b[perm[k]];
        for (let q = fk; q < k; q++) s -= L[ok + q] * y[q];
        y[k] = s / L[ok + k];
      }
      // L^T, column-oriented over the rows.
      for (let k = n - 1; k >= 0; k--) {
        const fk = first[k], ok = off[k] - fk;
        const v = (y[k] /= L[ok + k]);
        for (let q = fk; q < k; q++) y[q] -= L[ok + q] * v;
      }
      for (let k = 0; k < n; k++) x[perm[k]] = y[k];
    },
  };
}
