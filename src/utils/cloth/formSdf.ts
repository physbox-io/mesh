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
  const [nx, ny, nz] = g.dims, h = g.h, invH = 1 / h, N = nx * ny * nz, nyNx = nx * ny;
  const gMin0 = g.min[0], gMin1 = g.min[1], gMin2 = g.min[2];
  const d = new Float32Array(N).fill(Infinity);
  const align = new Float32Array(N);
  const fixed = new Uint8Array(N);
  const q = [0, 0, 0];
  const bandDist = BAND * h, bandDist2 = bandDist * bandDist;
  for (let t = 0; t < tris.length; t += 3) {
    const a = points[tris[t]], b = points[tris[t + 1]], c = points[tris[t + 2]];
    const ax0 = a[0], ay0 = a[1], az0 = a[2];
    const bx0 = b[0], by0 = b[1], bz0 = b[2];
    const cx0 = c[0], cy0 = c[1], cz0 = c[2];
    const n0 = (by0 - ay0) * (cz0 - az0) - (bz0 - az0) * (cy0 - ay0);
    const n1 = (bz0 - az0) * (cx0 - ax0) - (bx0 - ax0) * (cz0 - az0);
    const n2 = (bx0 - ax0) * (cy0 - ay0) - (by0 - ay0) * (cx0 - ax0);
    const nl = Math.sqrt(n0 * n0 + n1 * n1 + n2 * n2) || 1e-12;
    const planeBound = bandDist * nl;
    let minX = ax0 < bx0 ? ax0 : bx0; if (cx0 < minX) minX = cx0;
    let maxX = ax0 > bx0 ? ax0 : bx0; if (cx0 > maxX) maxX = cx0;
    let minY = ay0 < by0 ? ay0 : by0; if (cy0 < minY) minY = cy0;
    let maxY = ay0 > by0 ? ay0 : by0; if (cy0 > maxY) maxY = cy0;
    let minZ = az0 < bz0 ? az0 : bz0; if (cz0 < minZ) minZ = cz0;
    let maxZ = az0 > bz0 ? az0 : bz0; if (cz0 > maxZ) maxZ = cz0;
    const lo0 = Math.max(0, Math.floor((minX - gMin0) * invH) - BAND);
    const hi0 = Math.min(nx - 1, Math.ceil((maxX - gMin0) * invH) + BAND);
    const lo1 = Math.max(0, Math.floor((minY - gMin1) * invH) - BAND);
    const hi1 = Math.min(ny - 1, Math.ceil((maxY - gMin1) * invH) + BAND);
    const lo2 = Math.max(0, Math.floor((minZ - gMin2) * invH) - BAND);
    const hi2 = Math.min(nz - 1, Math.ceil((maxZ - gMin2) * invH) + BAND);
    for (let k = lo2; k <= hi2; k++) {
      const pz = gMin2 + k * h, kOff = k * nyNx, dzA = (pz - az0) * n2;
      for (let j = lo1; j <= hi1; j++) {
        const py = gMin1 + j * h, jkOff = kOff + j * nx, dyzA = (py - ay0) * n1 + dzA;
        for (let i = lo0; i <= hi0; i++) {
          const px = gMin0 + i * h;
          const pDist = (px - ax0) * n0 + dyzA;
          if (pDist > planeBound || pDist < -planeBound) continue;
          closestOnTri(px, py, pz, a, b, c, q);
          const dx = px - q[0], dy = py - q[1], dz = pz - q[2];
          const dist2 = dx * dx + dy * dy + dz * dz;
          if (dist2 > bandDist2) continue;
          const dist = Math.sqrt(dist2);
          const idx = jkOff + i;
          const side = dx * n0 + dy * n1 + dz * n2;
          // Where two faces are as near (their shared edge), the one facing the point most squarely decides the side.
          const facing = Math.abs(side) / (nl * (dist > 1e-12 ? dist : 1e-12));
          const cur = Math.abs(d[idx]), tie = Math.abs(dist - cur) <= 1e-6 + 1e-4 * dist;
          if ((dist < cur && !tie) || (tie && facing > align[idx])) {
            d[idx] = side < 0 ? -dist : dist;
            align[idx] = facing;
            fixed[idx] = 1;
          }
        }
      }
    }
  }
  // Outside: reachable from the grid's edge without crossing the band's
  // inside. The flood carries on through band cells clearly outside (by
  // their nearest face), not only through the cells beyond the band: stopped
  // at the band, air reached only through a gap of a few cells (a hollow's
  // narrow mouth) read as inside the body.
  const skin = 0.5 * h;
  const outside = new Uint8Array(N);
  const stack = new Int32Array(N);
  let sp = 0;
  for (let k = 0; k < nz; k++) {
    const kEdge = k === 0 || k === nz - 1, kOff = k * nyNx;
    for (let j = 0; j < ny; j++) {
      const jkEdge = kEdge || j === 0 || j === ny - 1, jkOff = kOff + j * nx;
      if (jkEdge) {
        for (let i = 0; i < nx; i++) {
          const idx = jkOff + i;
          if (!outside[idx] && !(fixed[idx] && d[idx] < 0)) { outside[idx] = 1; if (!fixed[idx] || d[idx] >= skin) stack[sp++] = idx; }
        }
      } else {
        const i0 = jkOff;
        if (!outside[i0] && !(fixed[i0] && d[i0] < 0)) { outside[i0] = 1; if (!fixed[i0] || d[i0] >= skin) stack[sp++] = i0; }
        const i1 = jkOff + nx - 1;
        if (!outside[i1] && !(fixed[i1] && d[i1] < 0)) { outside[i1] = 1; if (!fixed[i1] || d[i1] >= skin) stack[sp++] = i1; }
      }
    }
  }
  while (sp > 0) {
    const idx = stack[--sp];
    const k = (idx / nyNx) | 0;
    const rem = idx - k * nyNx;
    const j = (rem / nx) | 0;
    const i = rem - j * nx;
    if (i > 0) { const ni = idx - 1; if (!outside[ni] && !(fixed[ni] && d[ni] < 0)) { outside[ni] = 1; if (!fixed[ni] || d[ni] >= skin) stack[sp++] = ni; } }
    if (i < nx - 1) { const ni = idx + 1; if (!outside[ni] && !(fixed[ni] && d[ni] < 0)) { outside[ni] = 1; if (!fixed[ni] || d[ni] >= skin) stack[sp++] = ni; } }
    if (j > 0) { const ni = idx - nx; if (!outside[ni] && !(fixed[ni] && d[ni] < 0)) { outside[ni] = 1; if (!fixed[ni] || d[ni] >= skin) stack[sp++] = ni; } }
    if (j < ny - 1) { const ni = idx + nx; if (!outside[ni] && !(fixed[ni] && d[ni] < 0)) { outside[ni] = 1; if (!fixed[ni] || d[ni] >= skin) stack[sp++] = ni; } }
    if (k > 0) { const ni = idx - nyNx; if (!outside[ni] && !(fixed[ni] && d[ni] < 0)) { outside[ni] = 1; if (!fixed[ni] || d[ni] >= skin) stack[sp++] = ni; } }
    if (k < nz - 1) { const ni = idx + nyNx; if (!outside[ni] && !(fixed[ni] && d[ni] < 0)) { outside[ni] = 1; if (!fixed[ni] || d[ni] >= skin) stack[sp++] = ni; } }
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
function sweepDistance(
  g: Grid,
  u: Float32Array,
  fixed: Uint8Array,
  iMin = 0,
  iMax = g.dims[0] - 1,
  jMin = 0,
  jMax = g.dims[1] - 1,
  kMin = 0,
  kMax = g.dims[2] - 1,
): void {
  const [nx, ny, nz] = g.dims, h = g.h, h2 = h * h, twoH2 = 2 * h2, nyNx = nx * ny;
  const nx1 = nx - 1, ny1 = ny - 1, nz1 = nz - 1;
  for (let pass = 0; pass < 2; pass++) {
    for (let dir = 0; dir < 8; dir++) {
      const di = dir & 1 ? -1 : 1, dj = dir & 2 ? -1 : 1, dk = dir & 4 ? -1 : 1;
      const kStart = dk > 0 ? kMin : kMax, jStart = dj > 0 ? jMin : jMax, iStart = di > 0 ? iMin : iMax;
      for (let k = kStart; k >= kMin && k <= kMax; k += dk) {
        const kOff = k * nyNx, hasKm = k > 0, hasKp = k < nz1;
        for (let j = jStart; j >= jMin && j <= jMax; j += dj) {
          const jkOff = kOff + j * nx, hasJm = j > 0, hasJp = j < ny1;
          for (let i = iStart; i >= iMin && i <= iMax; i += di) {
            const idx = jkOff + i;
            if (fixed[idx]) continue;
            const am = i > 0 ? u[idx - 1] : 1e9, ap = i < nx1 ? u[idx + 1] : 1e9;
            const a = am < ap ? am : ap;
            const bm = hasJm ? u[idx - nx] : 1e9, bp = hasJp ? u[idx + nx] : 1e9;
            const b = bm < bp ? bm : bp;
            const cm = hasKm ? u[idx - nyNx] : 1e9, cp = hasKp ? u[idx + nyNx] : 1e9;
            const c = cm < cp ? cm : cp;
            let x0 = a, x1 = b, x2 = c, tmp;
            if (x0 > x1) { tmp = x0; x0 = x1; x1 = tmp; }
            if (x1 > x2) { tmp = x1; x1 = x2; x2 = tmp; }
            if (x0 > x1) { tmp = x0; x0 = x1; x1 = tmp; }
            if (x0 >= 1e9) continue;
            let v = x0 + h;
            if (v > x1) {
              const d01 = x0 - x1;
              const disc2 = twoH2 - d01 * d01;
              v = 0.5 * (x0 + x1 + (disc2 > 0 ? Math.sqrt(disc2) : 0));
              if (v > x2) {
                const s = x0 + x1 + x2, s2 = x0 * x0 + x1 * x1 + x2 * x2;
                const disc3 = s * s - 3 * (s2 - h2);
                v = (s + (disc3 > 0 ? Math.sqrt(disc3) : 0)) / 3;
              }
            }
            if (v < u[idx]) u[idx] = v;
          }
        }
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
  const [nx, ny, nz] = g.dims;
  const N = d.length, h = g.h, nyNx = nx * ny;
  const u = new Float32Array(N).fill(1e9);
  const fixed = new Uint8Array(N);
  // Seeded at the grown surface to within a cell, from the distance itself.
  // Restrict sweeping to the tight bounding box of unfixed (d <= thresh) cells.
  const thresh = r - 1.5 * h;
  let iLo = nx, iHi = -1, jLo = ny, jHi = -1, kLo = nz, kHi = -1;
  let idx = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, idx++) {
        const dv = d[idx];
        if (dv >= r) { u[idx] = 0; fixed[idx] = 1; }
        else if (dv > thresh) { u[idx] = r - dv; fixed[idx] = 1; }
        else {
          if (i < iLo) iLo = i; if (i > iHi) iHi = i;
          if (j < jLo) jLo = j; if (j > jHi) jHi = j;
          if (k < kLo) kLo = k; if (k > kHi) kHi = k;
        }
      }
    }
  }
  if (iLo <= iHi) {
    sweepDistance(g, u, fixed, iLo, iHi, jLo, jHi, kLo, kHi);
    for (let k = kLo; k <= kHi; k++) {
      const kOff = k * nyNx;
      for (let j = jLo; j <= jHi; j++) {
        const jkOff = kOff + j * nx;
        for (let i = iLo; i <= iHi; i++) {
          const p = jkOff + i;
          if (d[p] < r) d[p] = r - u[p];
        }
      }
    }
  }
}

/** Zero-allocation trilinear value of a grid field at (px, py, pz) (clamped to the grid). */
export function sampleGridXYZ(g: Grid, f: Float32Array, px: number, py: number, pz: number): number {
  const [nx, ny, nz] = g.dims, invH = 1 / g.h;
  let fx = (px - g.min[0]) * invH;
  if (fx < 0) fx = 0; else if (fx > nx - 1.0001) fx = nx - 1.0001;
  let fy = (py - g.min[1]) * invH;
  if (fy < 0) fy = 0; else if (fy > ny - 1.0001) fy = ny - 1.0001;
  let fz = (pz - g.min[2]) * invH;
  if (fz < 0) fz = 0; else if (fz > nz - 1.0001) fz = nz - 1.0001;
  const i = fx | 0, j = fy | 0, k = fz | 0, a = fx - i, b = fy - j, c = fz - k;
  const sy = nx, sz = nx * ny, o = k * sz + j * sy + i;
  const f000 = f[o], f100 = f[o + 1], f010 = f[o + sy], f110 = f[o + sy + 1];
  const f001 = f[o + sz], f101 = f[o + sz + 1], f011 = f[o + sz + sy], f111 = f[o + sz + sy + 1];
  const x00 = f000 + (f100 - f000) * a, x10 = f010 + (f110 - f010) * a;
  const x01 = f001 + (f101 - f001) * a, x11 = f011 + (f111 - f011) * a;
  const y0 = x00 + (x10 - x00) * b, y1 = x01 + (x11 - x01) * b;
  return y0 + (y1 - y0) * c;
}

/** Trilinear value of a grid field at p (clamped to the grid). */
export function sampleGrid(g: Grid, f: Float32Array, p: number[]): number {
  return sampleGridXYZ(g, f, p[0], p[1], p[2]);
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
  const [nx, ny, nz] = g.dims, h = g.h, invH = 1 / h;
  const a0 = Math.max(0, Math.min(nx - 2, Math.floor((lo[0] - g.min[0]) * invH)));
  const a1 = Math.max(0, Math.min(ny - 2, Math.floor((lo[1] - g.min[1]) * invH)));
  const a2 = Math.max(0, Math.min(nz - 2, Math.floor((lo[2] - g.min[2]) * invH)));
  const b0 = Math.max(a0 + 1, Math.min(nx - 1, Math.ceil((hi[0] - g.min[0]) * invH)));
  const b1 = Math.max(a1 + 1, Math.min(ny - 1, Math.ceil((hi[1] - g.min[1]) * invH)));
  const b2 = Math.max(a2 + 1, Math.min(nz - 1, Math.ceil((hi[2] - g.min[2]) * invH)));
  const sx = b0 - a0 + 1, sy = b1 - a1 + 1, sz = b2 - a2 + 1;
  const sub: Grid = { min: [g.min[0] + a0 * h, g.min[1] + a1 * h, g.min[2] + a2 * h], h, dims: [sx, sy, sz] };
  const inner = meshSdf(sub, points, tris);
  closeSdf(sub, inner, close);
  if (sx === nx && sy === ny && sz === nz) return inner;
  const out = new Float32Array(nx * ny * nz);
  const nyNx = nx * ny, sySx = sx * sy;
  for (let k = 0; k < nz; k++) {
    const ck = k < a2 ? a2 : k > b2 ? b2 : k;
    const dk = k - ck, dk2 = dk * dk, kOut = k * nyNx, ckOff = (ck - a2) * sySx;
    for (let j = 0; j < ny; j++) {
      const cj = j < a1 ? a1 : j > b1 ? b1 : j;
      const dj = j - cj, djk2 = dk2 + dj * dj, jkOut = kOut + j * nx, cjkOff = ckOff + (cj - a1) * sx;
      for (let i = 0; i < nx; i++) {
        const ci = i < a0 ? a0 : i > b0 ? b0 : i;
        const v = inner[cjkOff + (ci - a0)];
        const di = i - ci;
        const d2 = djk2 + di * di;
        out[jkOut + i] = d2 === 0 ? v : v + h * Math.sqrt(d2);
      }
    }
  }
  return out;
}
