/**
 * Where a closed mesh is solid, column by column and voxel by voxel.
 *
 * The setup planner has to know what a cutter can reach from each of the
 * block's six faces, which a heightmap from above cannot say: it sees the first
 * surface and nothing under it. So the part is cast once along Z into exact
 * solid intervals per column, and those are turned into a coarse voxel grid
 * that each face can be scanned from.
 */

export interface ColumnGrid {
  minX: number;
  minY: number;
  stepX: number;
  stepY: number;
  cols: number;
  rows: number;
}

/** Solid spans per column: column k's spans are `z[offset[k] .. offset[k+1])`, as (bottom, top) pairs. */
export interface ColumnSpans {
  grid: ColumnGrid;
  offset: Uint32Array;
  z: Float32Array;
}

/**
 * Off the grid lines by this fraction of a cell, towards the middle. A model
 * drawn on a millimetre grid puts its faces on round numbers and so does a
 * sampling grid, so rays land on edges, where a vertical face has no plan area
 * and a sloped one is hit twice. Same figure as solid machining's sampler.
 */
const NUDGE = 0.0137;

/**
 * Casts a ray up every column of `grid` through `tris` (flat xyz triples, mm)
 * and keeps where it is inside. A winding count, not hits paired off, so
 * overlapping solids that were never merged read as one; coincident hits
 * facing the same way (a ray through an edge two triangles share) count once.
 */
const columnSpansCache = new WeakMap<Float64Array, Map<string, ColumnSpans>>();

export function castColumnSpans(tris: Float64Array, grid: ColumnGrid): ColumnSpans {
  const { minX, minY, stepX, stepY, cols, rows } = grid;
  const cacheKey = `${minX},${minY},${stepX},${stepY},${cols},${rows}`;
  let perTris = columnSpansCache.get(tris);
  if (perTris) {
    const cached = perTris.get(cacheKey);
    if (cached) return cached;
  } else {
    perTris = new Map();
    columnSpansCache.set(tris, perTris);
  }
  const maxX = minX + stepX * Math.max(0, cols - 1);
  const maxY = minY + stepY * Math.max(0, rows - 1);
  const triCount = tris.length / 9;
  const side = Math.max(1, Math.min(128, Math.round(Math.sqrt(triCount / 2))));
  const bw = (maxX - minX) / side || 1;
  const bh = (maxY - minY) / side || 1;
  const buckets: number[][] = Array.from({ length: side * side }, () => []);
  const bucketCol = (x: number) => Math.min(side - 1, Math.max(0, Math.floor((x - minX) / bw)));
  const bucketRow = (y: number) => Math.min(side - 1, Math.max(0, Math.floor((y - minY) / bh)));
  for (let t = 0; t < triCount; t++) {
    const i = t * 9;
    const x0 = Math.min(tris[i], tris[i + 3], tris[i + 6]), x1 = Math.max(tris[i], tris[i + 3], tris[i + 6]);
    const y0 = Math.min(tris[i + 1], tris[i + 4], tris[i + 7]), y1 = Math.max(tris[i + 1], tris[i + 4], tris[i + 7]);
    if (x1 < minX - stepX || x0 > maxX + stepX || y1 < minY - stepY || y0 > maxY + stepY) continue;
    for (let r = bucketRow(y0); r <= bucketRow(y1); r++) {
      for (let c = bucketCol(x0); c <= bucketCol(x1); c++) buckets[r * side + c].push(i);
    }
  }

  const offset = new Uint32Array(cols * rows + 1);
  const out: number[] = [];
  const hitZ: number[] = [];
  const hitDir: number[] = [];
  const order: number[] = [];
  const midRow = (rows - 1) / 2, midCol = (cols - 1) / 2;
  for (let row = 0; row < rows; row++) {
    const py = minY + (row + (row < midRow ? NUDGE : row > midRow ? -NUDGE : 0)) * stepY;
    for (let col = 0; col < cols; col++) {
      const k = row * cols + col;
      offset[k] = out.length;
      const px = minX + (col + (col < midCol ? NUDGE : col > midCol ? -NUDGE : 0)) * stepX;
      const bucket = buckets[bucketRow(py) * side + bucketCol(px)];
      if (bucket.length === 0) continue;
      hitZ.length = 0;
      hitDir.length = 0;
      for (const i of bucket) {
        const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
        const bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5];
        const cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];
        const v0x = cx - ax, v0y = cy - ay;
        const v1x = bx - ax, v1y = by - ay;
        const v2x = px - ax, v2y = py - ay;
        const den = v0x * v1y - v1x * v0y;
        if (den === 0) continue;
        const u = (v2x * v1y - v1x * v2y) / den;
        const v = (v0x * v2y - v2x * v0y) / den;
        if (u < 0 || v < 0 || u + v > 1) continue;
        hitZ.push(az + u * (cz - az) + v * (bz - az));
        // `den` is minus the face normal's Z: positive looks down, which a ray
        // going up enters through.
        hitDir.push(den > 0 ? 1 : -1);
      }
      if (hitZ.length === 0) continue;
      order.length = hitZ.length;
      for (let h = 0; h < order.length; h++) order[h] = h;
      order.sort((a, b) => hitZ[a] - hitZ[b]);
      // A mesh wound inside out enters through its up-facing faces; read it flipped.
      const flip = hitDir[order[0]] < 0 ? -1 : 1;
      let depth = 0, lastZ = NaN, lastDir = 0, enteredAt = 0;
      for (const h of order) {
        const z = hitZ[h], dir = hitDir[h] * flip;
        if (dir === lastDir && Math.abs(z - lastZ) <= 1e-4) continue;
        lastZ = z;
        lastDir = dir;
        if (dir > 0) {
          if (depth === 0) enteredAt = z;
          depth++;
        } else if (depth > 0) {
          depth--;
          if (depth === 0 && z > enteredAt) out.push(enteredAt, z);
        }
      }
      // A count that never closes is a mesh that is not closed; the span from
      // the first hit to the last is the honest reading of it.
      if (depth !== 0) {
        out.length = offset[k];
        out.push(hitZ[order[0]], hitZ[order[order.length - 1]]);
      }
    }
  }
  offset[cols * rows] = out.length;
  const result: ColumnSpans = { grid, offset, z: Float32Array.from(out) };
  if (perTris.size >= 16) {
    const oldest = perTris.keys().next().value;
    if (oldest !== undefined) perTris.delete(oldest);
  }
  perTris.set(cacheKey, result);
  return result;
}

/** A box of voxels, x fastest, then y, then z. */
export interface VoxelGrid {
  minX: number;
  minY: number;
  minZ: number;
  /** Cell size, mm: the same along every axis. */
  cell: number;
  nx: number;
  ny: number;
  nz: number;
  /** 1 where the voxel's centre is inside the part. */
  solid: Uint8Array;
}

const voxelizeCache = new WeakMap<Float64Array, Map<string, VoxelGrid>>();

/**
 * The part as voxels of `cell` mm over `box`, read off column spans cast
 * through voxel centres. Exact at the voxel centres, which is all a plan that
 * then re-samples the faces it picks at full resolution needs.
 */
export function voxelize(
  tris: Float64Array,
  box: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number },
  cell: number
): VoxelGrid {
  const cacheKey = `${box.minX},${box.minY},${box.minZ},${box.maxX},${box.maxY},${box.maxZ},${cell}`;
  let perTris = voxelizeCache.get(tris);
  if (perTris) {
    const cached = perTris.get(cacheKey);
    if (cached) return cached;
  } else {
    perTris = new Map();
    voxelizeCache.set(tris, perTris);
  }
  const nx = Math.max(1, Math.ceil((box.maxX - box.minX) / cell - 1e-9));
  const ny = Math.max(1, Math.ceil((box.maxY - box.minY) / cell - 1e-9));
  const nz = Math.max(1, Math.ceil((box.maxZ - box.minZ) / cell - 1e-9));
  const spans = castColumnSpans(tris, {
    minX: box.minX + cell / 2,
    minY: box.minY + cell / 2,
    stepX: cell,
    stepY: cell,
    cols: nx,
    rows: ny,
  });
  const solid = new Uint8Array(nx * ny * nz);
  const plane = nx * ny;
  for (let k = 0; k < plane; k++) {
    for (let s = spans.offset[k]; s < spans.offset[k + 1]; s += 2) {
      const lo = Math.max(0, Math.ceil((spans.z[s] - box.minZ) / cell - 0.5));
      const hi = Math.min(nz - 1, Math.floor((spans.z[s + 1] - box.minZ) / cell - 0.5));
      for (let iz = lo; iz <= hi; iz++) solid[iz * plane + k] = 1;
    }
  }
  const result: VoxelGrid = { minX: box.minX, minY: box.minY, minZ: box.minZ, cell, nx, ny, nz, solid };
  if (perTris.size >= 16) {
    const oldest = perTris.keys().next().value;
    if (oldest !== undefined) perTris.delete(oldest);
  }
  perTris.set(cacheKey, result);
  return result;
}
