/**
 * Exact Euclidean distance from every cell to the nearest set cell, in cells.
 *
 * Felzenszwalb and Huttenlocher's two-pass parabola method: a 1D transform
 * down every column, then along every row of the result. Linear in the number
 * of cells, where scanning a kernel round each cell is quadratic in the
 * channel width — and the channel here is tens of cells wide.
 */
export function distanceTransform(mask: Uint8Array, cols: number, rows: number): Float32Array {
  const INF = 1e20;
  const g = new Float32Array(cols * rows);
  for (let i = 0; i < g.length; i++) g[i] = mask[i] ? 0 : INF;

  const n = Math.max(cols, rows);
  const fIn = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);

  const edt1d = (len: number) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = ((fIn[q] + q * q) - (fIn[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = ((fIn[q] + q * q) - (fIn[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + fIn[v[k]];
    }
  };

  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) fIn[r] = g[r * cols + c];
    edt1d(rows);
    for (let r = 0; r < rows; r++) g[r * cols + c] = d[r];
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) fIn[c] = g[r * cols + c];
    edt1d(cols);
    for (let c = 0; c < cols; c++) g[r * cols + c] = Math.sqrt(d[c]);
  }
  return g;
}
