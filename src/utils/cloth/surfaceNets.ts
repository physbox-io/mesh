/**
 * The zero set of a field on a grid, as triangles (naive surface nets): a
 * point in each cell the surface passes through, at the mean of its edges'
 * crossings; a quad across each grid edge it crosses, between the four cells
 * round it, wound so its normal points the way the field grows. Then evened
 * out along the surface a few times, each point put back on it, so the
 * triangles are near equal, about a cell across, and never so as to take
 * it through itself.
 */

import { sampleGridXYZ, type Grid } from './formSdf';
import { undoCrossingMoves } from './clothUntangle';

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
  // Resolve checkerboard saddle pinches (edges shared by >2 triangles where a 2x2 face
  // has diagonal signs): collapse (a, b) to its midpoint whenever the combined link
  // forms a single manifold fan, eliminating microscopic non-manifold Z-folds before relax.
  {
    const nP = points.length;
    const edgeCount = new Map<number, number>();
    for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 3; e++) {
      const a = tris[t + e], b = tris[t + ((e + 1) % 3)], key = a < b ? a * nP + b : b * nP + a;
      edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
    }
    const pinch: [number, number][] = [];
    for (const [key, cnt] of edgeCount) if (cnt > 2) pinch.push([Math.floor(key / nP), key % nP]);
    if (pinch.length > 0) {
      const vt: number[][] = points.map(() => []);
      for (let t = 0; t < tris.length; t += 3) { vt[tris[t]].push(t); vt[tris[t + 1]].push(t); vt[tris[t + 2]].push(t); }
      const parent = Array.from({ length: nP }, (_, i) => i);
      const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
      for (const [ra, rb] of pinch) {
        const a = find(ra), b = find(rb);
        if (a === b) continue;
        const star = new Set<number>([...vt[a], ...vt[b]]);
        const next = new Map<number, number>(), prev = new Map<number, number>();
        let manifold = true, links = 0;
        for (const t of star) {
          const i0 = find(tris[t]), i1 = find(tris[t + 1]), i2 = find(tris[t + 2]);
          const m0 = i0 === a || i0 === b, m1 = i1 === a || i1 === b, m2 = i2 === a || i2 === b;
          const mc = (m0 ? 1 : 0) + (m1 ? 1 : 0) + (m2 ? 1 : 0);
          if (mc >= 2) continue;
          const [u, v] = m0 ? [i1, i2] : m1 ? [i2, i0] : [i0, i1];
          if (u === v || next.has(u) || prev.has(v)) { manifold = false; break; }
          next.set(u, v); prev.set(v, u); links++;
        }
        if (!manifold || links === 0) continue;
        // Verify all link edges form a single connected cycle or chain around the merged vertex.
        let start = next.keys().next().value!;
        for (let guard = 0; guard <= links && prev.has(start); guard++) {
          const p = prev.get(start)!;
          if (p === next.keys().next().value) break;
          start = p;
        }
        let walked = 0, cur: number | undefined = start;
        const seen = new Set<number>();
        while (cur !== undefined && !seen.has(cur)) { seen.add(cur); cur = next.get(cur); if (cur !== undefined) walked++; }
        if (seen.size < next.size && walked < links) continue;
        points[a] = [(points[a][0] + points[b][0]) / 2, (points[a][1] + points[b][1]) / 2, (points[a][2] + points[b][2]) / 2];
        parent[b] = a;
        for (const t of vt[b]) if (!star.has(t) || !vt[a].includes(t)) vt[a].push(t);
      }
      const clean: number[] = [];
      for (let t = 0; t < tris.length; t += 3) {
        const a = find(tris[t]), b = find(tris[t + 1]), c = find(tris[t + 2]);
        if (a !== b && b !== c && a !== c) clean.push(a, b, c);
      }
      tris.length = 0;
      for (let i = 0; i < clean.length; i++) tris.push(clean[i]);
    }
  }
  // Even it out: each point toward its neighbours' mean, along the surface, then back onto it.
  const nbr: number[][] = points.map(() => []);
  for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = tris[t + e], b = tris[t + ((e + 1) % 3)];
    if (!nbr[a].includes(b)) nbr[a].push(b);
    if (!nbr[b].includes(a)) nbr[b].push(a);
  }
  const project = ontoField(g, f);
  const e = g.h * 0.5, inv2e = 1 / (2 * e);
  for (let it = 0; it < relax; it++) {
    const next: number[][] = new Array(points.length);
    for (let i = 0; i < points.length; i++) {
      const p = points[i], nb = nbr[i], deg = nb.length;
      if (!deg) { next[i] = p; continue; }
      let mx = 0, my = 0, mz = 0;
      for (let j = 0; j < deg; j++) { const pq = points[nb[j]]; mx += pq[0]; my += pq[1]; mz += pq[2]; }
      const invDeg = 1 / deg;
      mx *= invDeg; my *= invDeg; mz *= invDeg;
      const px = p[0], py = p[1], pz = p[2];
      const nxG = (sampleGridXYZ(g, f, px + e, py, pz) - sampleGridXYZ(g, f, px - e, py, pz)) * inv2e;
      const nyG = (sampleGridXYZ(g, f, px, py + e, pz) - sampleGridXYZ(g, f, px, py - e, pz)) * inv2e;
      const nzG = (sampleGridXYZ(g, f, px, py, pz + e) - sampleGridXYZ(g, f, px, py, pz - e)) * inv2e;
      const l2 = nxG * nxG + nyG * nyG + nzG * nzG;
      const invL2 = l2 > 0 ? 1 / l2 : 1;
      const dx = mx - px, dy = my - py, dz = mz - pz;
      const dn = (dx * nxG + dy * nyG + dz * nzG) * invL2;
      const q = [px + 0.5 * (dx - dn * nxG), py + 0.5 * (dy - dn * nyG), pz + 0.5 * (dz - dn * nzG)];
      project(q);
      next[i] = q;
    }
    const was = points.slice();
    for (let i = 0; i < points.length; i++) points[i] = next[i];
    // Never through itself: off the grid it is not, and a step that took it there is undone where it did.
    undoCrossingMoves(points, was, tris);
  }
  return { points, tris };
}

/** The gradient of a grid field at p, by central differences half a cell wide. */
export function fieldGradient(g: Grid, f: Float32Array): (p: number[]) => number[] {
  const e = g.h * 0.5, inv2e = 1 / (2 * e);
  return (p) => {
    const px = p[0], py = p[1], pz = p[2];
    return [
      (sampleGridXYZ(g, f, px + e, py, pz) - sampleGridXYZ(g, f, px - e, py, pz)) * inv2e,
      (sampleGridXYZ(g, f, px, py + e, pz) - sampleGridXYZ(g, f, px, py - e, pz)) * inv2e,
      (sampleGridXYZ(g, f, px, py, pz + e) - sampleGridXYZ(g, f, px, py, pz - e)) * inv2e,
    ];
  };
}

/** Moves a point onto the field's zero set, in place, by a few Newton steps along its gradient. */
export function ontoField(g: Grid, f: Float32Array): (p: number[]) => void {
  const e = g.h * 0.5, inv2e = 1 / (2 * e);
  return (p) => {
    for (let it = 0; it < 3; it++) {
      const px = p[0], py = p[1], pz = p[2];
      const val = sampleGridXYZ(g, f, px, py, pz);
      const nx = (sampleGridXYZ(g, f, px + e, py, pz) - sampleGridXYZ(g, f, px - e, py, pz)) * inv2e;
      const ny = (sampleGridXYZ(g, f, px, py + e, pz) - sampleGridXYZ(g, f, px, py - e, pz)) * inv2e;
      const nz = (sampleGridXYZ(g, f, px, py, pz + e) - sampleGridXYZ(g, f, px, py, pz - e)) * inv2e;
      const l2 = nx * nx + ny * ny + nz * nz;
      if (l2 < 1e-12) return;
      const s = val / l2;
      p[0] = px - s * nx; p[1] = py - s * ny; p[2] = pz - s * nz;
    }
  };
}
