// The ARAP global step's factored solve (envelopeCholesky) against the
// matrix it factors: a mesh Laplacian, pinned at one vertex, as garmentFlatten
// builds it.

import { describe, it, expect } from 'vitest';
import { envelopeCholesky } from '../src/utils/cloth/envelopeCholesky';

/** A jittered triangulated grid's weighted Laplacian, CSR of the weights (both triangles), and its diagonal. */
function laplacian(w: number, h: number) {
  const n = w * h, rows: Map<number, number>[] = Array.from({ length: n }, () => new Map());
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const link = (a: number, b: number) => { const v = 0.2 + rand(); rows[a].set(b, (rows[a].get(b) ?? 0) + v); rows[b].set(a, (rows[b].get(a) ?? 0) + v); };
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const v = j * w + i;
    if (i + 1 < w) link(v, v + 1);
    if (j + 1 < h) link(v, v + w);
    if (i + 1 < w && j + 1 < h) link(v, v + w + 1);
  }
  const rowPtr = new Int32Array(n + 1), cols: number[] = [], vals: number[] = [], diag = new Float64Array(n);
  rows.forEach((r, i) => { for (const [c, v] of r) { cols.push(c); vals.push(v); diag[i] += v; } rowPtr[i + 1] = cols.length; });
  diag[0] += 1;
  return { n, rowPtr, colIdx: Int32Array.from(cols), val: Float64Array.from(vals), diag };
}

describe('envelope Cholesky', () => {
  it('solves the pinned Laplacian to round-off', () => {
    const { n, rowPtr, colIdx, val, diag } = laplacian(60, 45);
    const chol = envelopeCholesky(n, diag, rowPtr, colIdx, val, -1)!;
    expect(chol).not.toBeNull();
    const want = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.37) + 0.1 * i / n);
    const b = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = diag[i] * want[i]; for (let p = rowPtr[i]; p < rowPtr[i + 1]; p++) s -= val[p] * want[colIdx[p]]; b[i] = s; }
    const x = new Float64Array(n);
    chol.solve(b, x);
    let err = 0;
    for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(x[i] - want[i]));
    expect(err).toBeLessThan(1e-8);
  });

  it('refuses a matrix that is not positive definite, and one too big', () => {
    const { n, rowPtr, colIdx, val, diag } = laplacian(10, 10);
    const singular = diag.slice(); singular[0] -= 1;
    expect(envelopeCholesky(n, singular.map((d) => d - 5), rowPtr, colIdx, val, -1)).toBeNull();
    expect(envelopeCholesky(n, diag, rowPtr, colIdx, val, -1, 50)).toBeNull();
  });
});
