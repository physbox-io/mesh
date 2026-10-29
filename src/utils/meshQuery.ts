// Point and box questions against a closed triangle mesh, fast enough to ask a
// few hundred thousand times: is a point inside, how far is it from the
// surface, which triangles might a box touch.
//
// Two uniform grids. A 3D one buckets triangles by the cells their bounds
// cover, for "what is near here". A 2D one over X and Y buckets them by the
// columns they cover, for the inside test: a vertical ray from the point up,
// counted against only the triangles in its column. Pure and Worker-safe.

export interface MeshQuery {
  /** Triangle corners, nine per triangle. */
  readonly tri: Float64Array;
  /** Unit normals, three per triangle (outward for an outward-wound mesh). */
  readonly normal: Float64Array;
  readonly count: number;
  readonly lo: number[];
  readonly hi: number[];
  /** True when the point is inside the closed mesh. */
  inside(x: number, y: number, z: number): boolean;
  /** Distance to the nearest triangle, or `cap` when none is nearer than that. */
  distance(x: number, y: number, z: number, cap: number): number;
  /** Indices of triangles whose bounds may meet the box. Each appears once. */
  near(lo: number[], hi: number[]): number[];
}

/**
 * Grid cells, roughly. Enough that a cell holds a handful of triangles on a
 * fine mesh, few enough that an empty one costs little.
 */
const TARGET_CELLS = 64_000;

export function buildMeshQuery(verts: ArrayLike<number>, faces: ArrayLike<number>): MeshQuery {
  const count = faces.length / 3;
  const tri = new Float64Array(count * 9);
  const normal = new Float64Array(count * 3);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < count; t++) {
    for (let c = 0; c < 3; c++) {
      const v = faces[t * 3 + c] * 3;
      for (let k = 0; k < 3; k++) {
        const x = verts[v + k];
        tri[t * 9 + c * 3 + k] = x;
        if (x < lo[k]) lo[k] = x;
        if (x > hi[k]) hi[k] = x;
      }
    }
    const o = t * 9;
    const ux = tri[o + 3] - tri[o], uy = tri[o + 4] - tri[o + 1], uz = tri[o + 5] - tri[o + 2];
    const wx = tri[o + 6] - tri[o], wy = tri[o + 7] - tri[o + 1], wz = tri[o + 8] - tri[o + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz) || 1;
    normal[t * 3] = nx / len; normal[t * 3 + 1] = ny / len; normal[t * 3 + 2] = nz / len;
  }
  const size = [0, 1, 2].map(k => Math.max(hi[k] - lo[k], 1e-9));
  const cell = Math.max(Math.cbrt((size[0] * size[1] * size[2]) / TARGET_CELLS), Math.max(...size) / 256);
  const n = size.map(s => Math.max(1, Math.ceil(s / cell)));
  const cellOf = (v: number, k: number) => Math.min(n[k] - 1, Math.max(0, Math.floor((v - lo[k]) / cell)));

  // 3D buckets, as CSR arrays: start[c]..start[c+1] into items.
  const ranges = new Int32Array(count * 6);
  const cells = n[0] * n[1] * n[2];
  const start = new Int32Array(cells + 1);
  for (let t = 0; t < count; t++) {
    for (let k = 0; k < 3; k++) {
      const a = tri[t * 9 + k], b = tri[t * 9 + 3 + k], c = tri[t * 9 + 6 + k];
      ranges[t * 6 + k] = cellOf(Math.min(a, b, c), k);
      ranges[t * 6 + 3 + k] = cellOf(Math.max(a, b, c), k);
    }
    for (let z = ranges[t * 6 + 2]; z <= ranges[t * 6 + 5]; z++) {
      for (let y = ranges[t * 6 + 1]; y <= ranges[t * 6 + 4]; y++) {
        for (let x = ranges[t * 6]; x <= ranges[t * 6 + 3]; x++) start[(z * n[1] + y) * n[0] + x + 1]++;
      }
    }
  }
  for (let c = 0; c < cells; c++) start[c + 1] += start[c];
  const items = new Int32Array(start[cells]);
  const fill = start.slice(0, cells);
  for (let t = 0; t < count; t++) {
    for (let z = ranges[t * 6 + 2]; z <= ranges[t * 6 + 5]; z++) {
      for (let y = ranges[t * 6 + 1]; y <= ranges[t * 6 + 4]; y++) {
        for (let x = ranges[t * 6]; x <= ranges[t * 6 + 3]; x++) items[fill[(z * n[1] + y) * n[0] + x]++] = t;
      }
    }
  }

  // 2D column buckets for the inside test.
  const cols = n[0] * n[1];
  const colStart = new Int32Array(cols + 1);
  for (let t = 0; t < count; t++) {
    for (let y = ranges[t * 6 + 1]; y <= ranges[t * 6 + 4]; y++) {
      for (let x = ranges[t * 6]; x <= ranges[t * 6 + 3]; x++) colStart[y * n[0] + x + 1]++;
    }
  }
  for (let c = 0; c < cols; c++) colStart[c + 1] += colStart[c];
  const colItems = new Int32Array(colStart[cols]);
  const colFill = colStart.slice(0, cols);
  for (let t = 0; t < count; t++) {
    for (let y = ranges[t * 6 + 1]; y <= ranges[t * 6 + 4]; y++) {
      for (let x = ranges[t * 6]; x <= ranges[t * 6 + 3]; x++) colItems[colFill[y * n[0] + x]++] = t;
    }
  }

  const stamp = new Int32Array(count);
  let epoch = 0;

  function near(blo: number[], bhi: number[]): number[] {
    epoch++;
    const out: number[] = [];
    const x0 = cellOf(blo[0], 0), x1 = cellOf(bhi[0], 0);
    const y0 = cellOf(blo[1], 1), y1 = cellOf(bhi[1], 1);
    const z0 = cellOf(blo[2], 2), z1 = cellOf(bhi[2], 2);
    if (bhi[0] < lo[0] || bhi[1] < lo[1] || bhi[2] < lo[2] || blo[0] > hi[0] || blo[1] > hi[1] || blo[2] > hi[2]) return out;
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const c = (z * n[1] + y) * n[0] + x;
      for (let i = start[c]; i < start[c + 1]; i++) {
        const t = items[i];
        if (stamp[t] === epoch) continue;
        stamp[t] = epoch;
        out.push(t);
      }
    }
    return out;
  }

  // An irrational nudge to the ray, so it does not run exactly through the
  // shared edges and corners of a mesh drawn on a round-number grid.
  const JX = 1.2345678e-9, JY = 2.3456789e-9;
  function inside(px: number, py: number, pz: number): boolean {
    const x = px + JX, y = py + JY;
    if (x < lo[0] || x > hi[0] || y < lo[1] || y > hi[1] || pz > hi[2]) return false;
    const c = cellOf(y, 1) * n[0] + cellOf(x, 0);
    let crossings = 0;
    for (let i = colStart[c]; i < colStart[c + 1]; i++) {
      const o = colItems[i] * 9;
      const ax = tri[o], ay = tri[o + 1], bx = tri[o + 3], by = tri[o + 4], cx = tri[o + 6], cy = tri[o + 7];
      const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (den === 0) continue;
      const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / den;
      const w = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / den;
      if (u < 0 || w < 0 || u + w > 1) continue;
      const z = u * tri[o + 2] + w * tri[o + 5] + (1 - u - w) * tri[o + 8];
      if (z > pz) crossings++;
    }
    return crossings % 2 === 1;
  }

  // Searched outward from a cell, doubling, so a point near the surface looks
  // at a handful of triangles rather than everything within the cap.
  function distance(px: number, py: number, pz: number, cap: number): number {
    for (let r = Math.min(cap, cell); ; r = Math.min(cap, r * 2)) {
      let best = r * r;
      const ts = near([px - r, py - r, pz - r], [px + r, py + r, pz + r]);
      for (const t of ts) {
        const d = pointTriangleDist2(px, py, pz, tri, t * 9);
        if (d < best) best = d;
      }
      if (best < r * r || r >= cap) return Math.sqrt(best);
    }
  }

  return { tri, normal, count, lo, hi, inside, distance, near };
}

/** Squared distance from a point to triangle `o` of a corner array (Ericson, RTCD 5.1.5). */
export function pointTriangleDist2(px: number, py: number, pz: number, tri: Float64Array, o: number): number {
  const ax = tri[o], ay = tri[o + 1], az = tri[o + 2];
  const bx = tri[o + 3], by = tri[o + 4], bz = tri[o + 5];
  const cx = tri[o + 6], cy = tri[o + 7], cz = tri[o + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let qx: number, qy: number, qz: number;
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; } else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { qx = bx; qy = by; qz = bz; } else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        qx = ax + v * abx; qy = ay + v * aby; qz = az + v * abz;
      } else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { qx = cx; qy = cy; qz = cz; } else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6);
            qx = ax + w * acx; qy = ay + w * acy; qz = az + w * acz;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
              qx = bx + w * (cx - bx); qy = by + w * (cy - by); qz = bz + w * (cz - bz);
            } else {
              const denom = 1 / (va + vb + vc);
              const v = vb * denom, w = vc * denom;
              qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
            }
          }
        }
      }
    }
  }
  return (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2;
}
