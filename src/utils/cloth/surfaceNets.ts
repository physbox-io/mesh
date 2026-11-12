/**
 * The zero set of a field on a grid, as triangles (naive surface nets): a
 * point in each cell the surface passes through, at the mean of its edges'
 * crossings; a quad across each grid edge it crosses, between the four cells
 * round it, wound so its normal points the way the field grows. Then evened
 * out along the surface a few times, each point put back on it, so the
 * triangles are near equal, about a cell across.
 */

import { sampleGrid, type Grid } from './formSdf';

export function surfaceNet(g: Grid, f: Float32Array, relax = 4): { points: number[][]; tris: number[] } {
  const [nx, ny, nz] = g.dims, h = g.h;
  const at = (i: number, j: number, k: number) => f[(k * ny + j) * nx + i];
  const cellId = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cid = (i: number, j: number, k: number) => (k * (ny - 1) + j) * (nx - 1) + i;
  const points: number[][] = [];
  const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const v = new Float64Array(8);
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let neg = 0;
    for (let c = 0; c < 8; c++) { v[c] = at(i + corners[c][0], j + corners[c][1], k + corners[c][2]); if (v[c] < 0) neg++; }
    if (neg === 0 || neg === 8) continue;
    let sx = 0, sy = 0, sz = 0, m = 0;
    for (const [a, b] of edges) {
      if ((v[a] < 0) === (v[b] < 0)) continue;
      const t = v[a] / (v[a] - v[b]);
      sx += corners[a][0] + (corners[b][0] - corners[a][0]) * t;
      sy += corners[a][1] + (corners[b][1] - corners[a][1]) * t;
      sz += corners[a][2] + (corners[b][2] - corners[a][2]) * t;
      m++;
    }
    cellId[cid(i, j, k)] = points.length;
    points.push([g.min[0] + (i + sx / m) * h, g.min[1] + (j + sy / m) * h, g.min[2] + (k + sz / m) * h]);
  }
  const tris: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) tris.push(a, c, b, a, d, c); else tris.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const f0 = at(i, j, k);
    // Along x: the cells round edge (i,j,k)-(i+1,j,k) are (i, j-1..j, k-1..k).
    if (i < nx - 1 && (f0 < 0) !== (at(i + 1, j, k) < 0)) {
      quad(cellId[cid(i, j - 1, k - 1)], cellId[cid(i, j, k - 1)], cellId[cid(i, j, k)], cellId[cid(i, j - 1, k)], f0 >= 0);
    }
    if (j < ny - 1 && (f0 < 0) !== (at(i, j + 1, k) < 0)) {
      quad(cellId[cid(i - 1, j, k - 1)], cellId[cid(i - 1, j, k)], cellId[cid(i, j, k)], cellId[cid(i, j, k - 1)], f0 >= 0);
    }
    if (k < nz - 1 && (f0 < 0) !== (at(i, j, k + 1) < 0)) {
      quad(cellId[cid(i - 1, j - 1, k)], cellId[cid(i, j - 1, k)], cellId[cid(i, j, k)], cellId[cid(i - 1, j, k)], f0 >= 0);
    }
  }
  // Even it out: each point toward its neighbours' mean, along the surface, then back onto it.
  const nbr: number[][] = points.map(() => []);
  for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = tris[t + e], b = tris[t + ((e + 1) % 3)];
    if (!nbr[a].includes(b)) nbr[a].push(b);
    if (!nbr[b].includes(a)) nbr[b].push(a);
  }
  const grad = fieldGradient(g, f), project = ontoField(g, f);
  for (let it = 0; it < relax; it++) {
    const next = points.map((p, i) => {
      if (!nbr[i].length) return p;
      const m = [0, 0, 0];
      for (const q of nbr[i]) for (let a = 0; a < 3; a++) m[a] += points[q][a] / nbr[i].length;
      const n = grad(p), l = Math.hypot(n[0], n[1], n[2]) || 1;
      const dlt = m.map((x, a) => x - p[a]), dn = (dlt[0] * n[0] + dlt[1] * n[1] + dlt[2] * n[2]) / l;
      const q = p.map((x, a) => x + 0.5 * (dlt[a] - (dn * n[a]) / l));
      project(q);
      return q;
    });
    for (let i = 0; i < points.length; i++) points[i] = next[i];
  }
  return { points, tris };
}

/** The gradient of a grid field at p, by central differences half a cell wide. */
export function fieldGradient(g: Grid, f: Float32Array): (p: number[]) => number[] {
  const e = g.h * 0.5;
  return (p) => [0, 1, 2].map((ax) => {
    const a = p.slice(), b = p.slice(); a[ax] += e; b[ax] -= e;
    return (sampleGrid(g, f, a) - sampleGrid(g, f, b)) / (2 * e);
  });
}

/** Moves a point onto the field's zero set, in place, by a few Newton steps along its gradient. */
export function ontoField(g: Grid, f: Float32Array): (p: number[]) => void {
  const grad = fieldGradient(g, f);
  return (p) => {
    for (let it = 0; it < 3; it++) {
      const val = sampleGrid(g, f, p), n = grad(p), l2 = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
      if (l2 < 1e-12) return;
      for (let a = 0; a < 3; a++) p[a] -= (val * n[a]) / l2;
    }
  };
}
