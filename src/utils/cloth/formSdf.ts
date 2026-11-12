/**
 * Signed distance to a closed mesh (Z-up points, outward triangles) on a
 * regular grid, everywhere on it: exact within a band of the surface, then
 * carried out (and in) by fast sweeping, signed by flood fill from the
 * grid's edge. What a garment is modelled off (garmentShell): the surface
 * at the garment's ease from the form, at any distance, a full skirt's too.
 *
 * One grid per part of the form, unioned by taking the least: built over
 * all the parts' triangles at once, a part inside another (the top of an arm
 * inside the torso) read as outside there, and grew a surface inside the body.
 */

import { closestOnTri } from './clothColliders';

export interface Grid {
  min: number[];
  h: number;
  dims: [number, number, number];
}

const BAND = 2;

export function gridOver(lo: number[], hi: number[], h: number): Grid {
  const dims = [0, 1, 2].map((a) => Math.max(2, Math.ceil((hi[a] - lo[a]) / h) + 1)) as [number, number, number];
  const min = lo.slice();
  if (Math.abs(lo[0] + hi[0]) < 1e-6) {
    if (dims[0] % 2 === 0) dims[0]++;
    min[0] = -((dims[0] - 1) * h) / 2;
  }
  return { min, h, dims };
}

export const gridPoint = (g: Grid, i: number, j: number, k: number) => [g.min[0] + i * g.h, g.min[1] + j * g.h, g.min[2] + k * g.h];

/** Signed distance on the grid (negative inside), for one closed mesh. */
export function meshSdf(g: Grid, points: number[][], tris: ArrayLike<number>): Float32Array {
  const [nx, ny, nz] = g.dims, h = g.h, N = nx * ny * nz;
  const d = new Float32Array(N).fill(Infinity);
  const align = new Float32Array(N);
  const fixed = new Uint8Array(N);
  const q = [0, 0, 0];
  for (let t = 0; t < tris.length; t += 3) {
    const a = points[tris[t]], b = points[tris[t + 1]], c = points[tris[t + 2]];
    const n = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])];
    const nl = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]) || 1e-12;
    const lo = [0, 1, 2].map((ax) => Math.max(0, Math.floor((Math.min(a[ax], b[ax], c[ax]) - g.min[ax]) / h) - BAND));
    const hi = [0, 1, 2].map((ax) => Math.min(g.dims[ax] - 1, Math.ceil((Math.max(a[ax], b[ax], c[ax]) - g.min[ax]) / h) + BAND));
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
      const px = g.min[0] + i * h, py = g.min[1] + j * h, pz = g.min[2] + k * h;
      closestOnTri(px, py, pz, a, b, c, q);
      const dist = Math.sqrt((px - q[0]) ** 2 + (py - q[1]) ** 2 + (pz - q[2]) ** 2);
      if (dist > BAND * h) continue;
      const idx = (k * ny + j) * nx + i;
      const side = (px - q[0]) * n[0] + (py - q[1]) * n[1] + (pz - q[2]) * n[2];
      // Where two faces are as near (their shared edge), the one facing the point most squarely decides the side.
      const facing = Math.abs(side) / (nl * Math.max(dist, 1e-12));
      const cur = Math.abs(d[idx]), tie = Math.abs(dist - cur) <= 1e-6 + 1e-4 * dist;
      if ((dist < cur && !tie) || (tie && facing > align[idx])) {
        d[idx] = side < 0 ? -dist : dist;
        align[idx] = facing;
        fixed[idx] = 1;
      }
    }
  }
  // Outside: reachable from the grid's edge without crossing the band's inside.
  const outside = new Uint8Array(N);
  const stack: number[] = [];
  const visit = (idx: number) => { if (!outside[idx] && !(fixed[idx] && d[idx] < 0)) { outside[idx] = 1; if (!fixed[idx]) stack.push(idx); } };
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) visit((k * ny + j) * nx + i);
  }
  while (stack.length) {
    const idx = stack.pop()!, i = idx % nx, j = Math.floor(idx / nx) % ny, k = Math.floor(idx / (nx * ny));
    if (i > 0) visit(idx - 1); if (i < nx - 1) visit(idx + 1);
    if (j > 0) visit(idx - nx); if (j < ny - 1) visit(idx + nx);
    if (k > 0) visit(idx - nx * ny); if (k < nz - 1) visit(idx + nx * ny);
  }
  // Unsigned distance beyond the band, by fast sweeping, from the band's.
  const u = new Float32Array(N);
  for (let idx = 0; idx < N; idx++) u[idx] = fixed[idx] ? Math.abs(d[idx]) : 1e9;
  sweepDistance(g, u, fixed);
  for (let idx = 0; idx < N; idx++) if (!fixed[idx]) d[idx] = outside[idx] ? u[idx] : -u[idx];
  return d;
}

/**
 * Distance out from the cells marked `fixed` (whose values in `u` are their
 * own distances) to every other cell, by fast sweeping (Zhao, 2005): the
 * cells not fixed should hold 1e9.
 */
function sweepDistance(g: Grid, u: Float32Array, fixed: Uint8Array): void {
  const [nx, ny, nz] = g.dims, h = g.h;
  const update = (idx: number, i: number, j: number, k: number) => {
    if (fixed[idx]) return;
    const a = Math.min(i > 0 ? u[idx - 1] : 1e9, i < nx - 1 ? u[idx + 1] : 1e9);
    const b = Math.min(j > 0 ? u[idx - nx] : 1e9, j < ny - 1 ? u[idx + nx] : 1e9);
    const c = Math.min(k > 0 ? u[idx - nx * ny] : 1e9, k < nz - 1 ? u[idx + nx * ny] : 1e9);
    let x0 = a, x1 = b, x2 = c, tmp;
    if (x0 > x1) { tmp = x0; x0 = x1; x1 = tmp; }
    if (x1 > x2) { tmp = x1; x1 = x2; x2 = tmp; }
    if (x0 > x1) { tmp = x0; x0 = x1; x1 = tmp; }
    if (x0 >= 1e9) return;
    let v = x0 + h;
    if (v > x1) {
      v = (x0 + x1 + Math.sqrt(Math.max(0, 2 * h * h - (x0 - x1) ** 2))) / 2;
      if (v > x2) {
        const s = x0 + x1 + x2, s2 = x0 * x0 + x1 * x1 + x2 * x2;
        v = (s + Math.sqrt(Math.max(0, s * s - 3 * (s2 - h * h)))) / 3;
      }
    }
    if (v < u[idx]) u[idx] = v;
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let dir = 0; dir < 8; dir++) {
      const di = dir & 1 ? -1 : 1, dj = dir & 2 ? -1 : 1, dk = dir & 4 ? -1 : 1;
      for (let k = dk > 0 ? 0 : nz - 1; k >= 0 && k < nz; k += dk) for (let j = dj > 0 ? 0 : ny - 1; j >= 0 && j < ny; j += dj) for (let i = di > 0 ? 0 : nx - 1; i >= 0 && i < nx; i += di) {
        update((k * ny + j) * nx + i, i, j, k);
      }
    }
  }
}

/**
 * The distance to a shape closed by a ball of radius r (in place): the shape
 * with every hollow the ball cannot reach the bottom of filled, as cloth
 * stretched over it spans the dip between two muscles rather than following
 * it down. Its bumps are left as they are. The shape grown by r, then shrunk
 * by r: where d >= r, the distance is as it was; within, it is r less the
 * distance in to the grown shape's surface.
 */
export function closeSdf(g: Grid, d: Float32Array, r: number): void {
  if (r <= 0) return;
  const N = d.length, h = g.h;
  const u = new Float32Array(N).fill(1e9);
  const fixed = new Uint8Array(N);
  // Seeded at the grown surface to within a cell, from the distance itself.
  for (let idx = 0; idx < N; idx++) if (d[idx] >= r) { u[idx] = 0; fixed[idx] = 1; } else if (d[idx] > r - 1.5 * h) { u[idx] = r - d[idx]; fixed[idx] = 1; }
  sweepDistance(g, u, fixed);
  for (let idx = 0; idx < N; idx++) if (d[idx] < r) d[idx] = r - u[idx];
}

/** Trilinear value of a grid field at p (clamped to the grid). */
export function sampleGrid(g: Grid, f: Float32Array, p: number[]): number {
  const [nx, ny, nz] = g.dims;
  const fx = Math.min(nx - 1.0001, Math.max(0, (p[0] - g.min[0]) / g.h));
  const fy = Math.min(ny - 1.0001, Math.max(0, (p[1] - g.min[1]) / g.h));
  const fz = Math.min(nz - 1.0001, Math.max(0, (p[2] - g.min[2]) / g.h));
  const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz), a = fx - i, b = fy - j, c = fz - k;
  const o = (k * ny + j) * nx + i, sy = nx, sz = nx * ny;
  const x00 = f[o] + (f[o + 1] - f[o]) * a, x10 = f[o + sy] + (f[o + sy + 1] - f[o + sy]) * a;
  const x01 = f[o + sz] + (f[o + sz + 1] - f[o + sz]) * a, x11 = f[o + sz + sy] + (f[o + sz + sy + 1] - f[o + sz + sy]) * a;
  const y0 = x00 + (x10 - x00) * b, y1 = x01 + (x11 - x01) * b;
  return y0 + (y1 - y0) * c;
}

/**
 * meshSdf worked only within a box of the grid (from `lo` to `hi`, which
 * should hold the mesh and as far round it as its distance matters): past
 * the box, the distance at the nearest point of the box plus the way there,
 * which it is at most. A part's distance is needed only as far as the
 * garment stands off it and blends with its neighbours, and an arm's box is
 * a small share of a gown's grid. Closed by a ball of radius `close`
 * (closeSdf), if given.
 */
export function meshSdfWithin(g: Grid, points: number[][], tris: ArrayLike<number>, lo: number[], hi: number[], close = 0): Float32Array {
  const [nx, ny, nz] = g.dims, h = g.h;
  const a = [0, 1, 2].map((ax) => Math.max(0, Math.min(g.dims[ax] - 2, Math.floor((lo[ax] - g.min[ax]) / h))));
  const b = [0, 1, 2].map((ax) => Math.max(a[ax] + 1, Math.min(g.dims[ax] - 1, Math.ceil((hi[ax] - g.min[ax]) / h))));
  const sub: Grid = { min: a.map((v, ax) => g.min[ax] + v * h), h, dims: [b[0] - a[0] + 1, b[1] - a[1] + 1, b[2] - a[2] + 1] };
  const inner = meshSdf(sub, points, tris);
  closeSdf(sub, inner, close);
  if (sub.dims[0] === nx && sub.dims[1] === ny && sub.dims[2] === nz) return inner;
  const out = new Float32Array(nx * ny * nz);
  const [sx, sy] = sub.dims;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const ci = Math.min(b[0], Math.max(a[0], i)), cj = Math.min(b[1], Math.max(a[1], j)), ck = Math.min(b[2], Math.max(a[2], k));
    const v = inner[((ck - a[2]) * sy + (cj - a[1])) * sx + (ci - a[0])];
    out[(k * ny + j) * nx + i] = ci === i && cj === j && ck === k ? v : v + h * Math.hypot(i - ci, j - cj, k - ck);
  }
  return out;
}
