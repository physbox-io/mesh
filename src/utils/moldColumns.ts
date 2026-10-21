// ---------------------------------------------------------------------------
// Mold column sampling
// ---------------------------------------------------------------------------
//
// Everything here works on vertical columns through the part: for each (x, y)
// on a grid, the lowest and the highest point of the part's surface. A mold half
// is then a block with one of those surfaces sunk into its face, which is what
// makes the whole build a heightfield and lets pins, sockets, sprues and vents
// be written as edits to the same two height arrays. The pull-direction search
// samples the same columns to see how much of the part each direction loses.

export interface Grid {
  cols: number;
  rows: number;
  stepX: number;
  stepY: number;
  /** Half extents of the mold block the grid spans, so x = -halfW + c * stepX. */
  halfW: number;
  halfD: number;
}

export interface ColumnField {
  /** Lowest surface point in the column; only meaningful where hit is 1. */
  minZ: Float64Array;
  /** Highest surface point in the column. */
  maxZ: Float64Array;
  hit: Uint8Array;
  /** 1 where the column's ray enters and leaves the part more than once. */
  multiCrossings: Uint8Array;
  /** Columns whose line enters and leaves the part more than once, or floats off the parting plane. */
  undercutColumns: number;
  hitColumns: number;
  /** Exact solid Z spans per column as flat (bottom, top) pairs in part Z coords. */
  spans: Float64Array[];
}

/**
 * Buckets triangles by their XY footprint so a column only tests the handful
 * that can possibly be over it. Without this the sampler is columns x triangles,
 * which on a terrain relief is hundreds of millions of point-in-triangle tests.
 */
function binTriangles(tris: Float64Array, triCount: number, halfW: number, halfD: number, nx: number, ny: number) {
  const bins: number[][] = new Array(nx * ny);
  for (let i = 0; i < bins.length; i++) bins[i] = [];
  const spanX = 2 * halfW || 1;
  const spanY = 2 * halfD || 1;

  for (let t = 0; t < triCount; t++) {
    const i = t * 9;
    const minX = Math.min(tris[i], tris[i + 3], tris[i + 6]);
    const maxX = Math.max(tris[i], tris[i + 3], tris[i + 6]);
    const minY = Math.min(tris[i + 1], tris[i + 4], tris[i + 7]);
    const maxY = Math.max(tris[i + 1], tris[i + 4], tris[i + 7]);

    const c0 = Math.max(0, Math.min(nx - 1, Math.floor(((minX + halfW) / spanX) * nx)));
    const c1 = Math.max(0, Math.min(nx - 1, Math.floor(((maxX + halfW) / spanX) * nx)));
    const r0 = Math.max(0, Math.min(ny - 1, Math.floor(((minY + halfD) / spanY) * ny)));
    const r1 = Math.max(0, Math.min(ny - 1, Math.floor(((maxY + halfD) / spanY) * ny)));

    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) bins[r * nx + c].push(i);
    }
  }
  return { bins, nx, ny, spanX, spanY, halfW, halfD };
}

/** Samples the part's lowest and highest surface over every grid column. */
export function sampleColumns(
  tris: Float64Array,
  triCount: number,
  grid: Grid,
  partHalfW: number,
  partHalfD: number
): ColumnField {
  const n = grid.cols * grid.rows;
  const minZ = new Float64Array(n);
  const maxZ = new Float64Array(n);
  const hit = new Uint8Array(n);
  const multiCrossings = new Uint8Array(n);
  const spans: Float64Array[] = new Array(n);
  for (let i = 0; i < n; i++) spans[i] = new Float64Array(0);

  const nx = Math.max(1, Math.min(96, Math.round(Math.sqrt(triCount / 4)) || 1));
  const binned = binTriangles(tris, triCount, partHalfW, partHalfD, nx, nx);

  let undercutColumns = 0;
  let hitColumns = 0;
  const eps = 1e-6;

  const hitZ: number[] = [];
  const hitDir: number[] = [];
  const order: number[] = [];
  const colSpans: number[] = [];

  for (let r = 0; r < grid.rows; r++) {
    const py = -grid.halfD + r * grid.stepY;
    if (py < -partHalfD - eps || py > partHalfD + eps) continue;
    const by = Math.max(0, Math.min(nx - 1, Math.floor(((py + partHalfD) / (2 * partHalfD || 1)) * nx)));

    for (let c = 0; c < grid.cols; c++) {
      const px = -grid.halfW + c * grid.stepX;
      if (px < -partHalfW - eps || px > partHalfW + eps) continue;
      const bx = Math.max(0, Math.min(nx - 1, Math.floor(((px + partHalfW) / (2 * partHalfW || 1)) * nx)));

      const bucket = binned.bins[by * nx + bx];
      hitZ.length = 0;
      hitDir.length = 0;
      colSpans.length = 0;

      for (let k = 0; k < bucket.length; k++) {
        const i = bucket[k];
        const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
        const bxv = tris[i + 3], byv = tris[i + 4], bz = tris[i + 5];
        const cxv = tris[i + 6], cyv = tris[i + 7], cz = tris[i + 8];

        if (Math.max(ax, bxv, cxv) < px || Math.min(ax, bxv, cxv) > px) continue;
        if (Math.max(ay, byv, cyv) < py || Math.min(ay, byv, cyv) > py) continue;

        const v0x = cxv - ax, v0y = cyv - ay;
        const v1x = bxv - ax, v1y = byv - ay;
        const v2x = px - ax, v2y = py - ay;

        const den = v0x * v1y - v1x * v0y;
        if (den === 0) continue;

        const u = (v2x * v1y - v1x * v2y) / den;
        const v = (v0x * v2y - v2x * v0y) / den;
        if (u < 0 || v < 0 || u + v > 1) continue;

        const z = az + u * (cz - az) + v * (bz - az);
        hitZ.push(z);
        hitDir.push(den > 0 ? 1 : -1);
      }

      if (hitZ.length === 0) continue;

      order.length = hitZ.length;
      for (let h = 0; h < order.length; h++) order[h] = h;
      order.sort((a, b) => hitZ[a] - hitZ[b]);

      const flip = hitDir[order[0]] < 0 ? -1 : 1;
      let depth = 0;
      let lastZ = NaN;
      let lastDir = 0;
      let enteredAt = 0;
      let distinctHits = 0;

      for (const h of order) {
        const z = hitZ[h];
        const dir = hitDir[h] * flip;
        if (dir === lastDir && Math.abs(z - lastZ) <= 1e-4) continue;
        if (lastDir < 0 && dir > 0 && Math.abs(z - lastZ) <= 1e-4) {
          // Internal coincident interface between touching solids:
          // The ray exited one solid at lastZ and enters the next at z.
          // Undo the exit from the previous hit so depth remains > 0 and
          // neither internal face counts as a surface crossing.
          depth++;
          distinctHits--;
          if (colSpans.length >= 2 && Math.abs(colSpans[colSpans.length - 1] - lastZ) <= 1e-4) {
            enteredAt = colSpans[colSpans.length - 2];
            colSpans.length -= 2;
          }
          lastZ = z;
          lastDir = dir;
          continue;
        }
        lastZ = z;
        lastDir = dir;
        distinctHits++;

        if (dir > 0) {
          if (depth === 0) enteredAt = z;
          depth++;
        } else if (depth > 0) {
          depth--;
          if (depth === 0 && z > enteredAt) {
            colSpans.push(enteredAt, z);
          }
        }
      }

      if (distinctHits === 0) continue;

      const lo = hitZ[order[0]];
      const hi = hitZ[order[order.length - 1]];

      if (depth !== 0 || colSpans.length === 0) {
        colSpans.length = 0;
        colSpans.push(lo, hi);
      }

      const idx = r * grid.cols + c;
      minZ[idx] = lo;
      maxZ[idx] = hi;
      hit[idx] = 1;
      hitColumns++;
      spans[idx] = Float64Array.from(colSpans);

      // Two crossings is a column that goes in one face and out the other. More
      // than that is an overhang or a hollow, and a heightfield cavity cannot
      // hold it: the mold fills it in solid.
      if (distinctHits > 2 || colSpans.length > 2) {
        multiCrossings[idx] = 1;
        undercutColumns++;
      }
    }
  }

  return { minZ, maxZ, hit, multiCrossings, undercutColumns, hitColumns, spans };
}

/**
 * Picks the parting plane: the height whose cross-section covers the most of the
 * part's footprint, which is the plane the two halves pull apart along with the
 * least material trapped behind an edge. Ties go to the lowest such plane, so a
 * relief or any other flat-backed part parts at its flat back and puts all of
 * its detail in one half rather than being sliced through the middle.
 */
export function choosePartingZ(field: ColumnField, zMin: number, zMax: number): number {
  const span = zMax - zMin;
  if (!(span > 1e-9)) return zMin;

  const SAMPLES = 128;
  const eps = span * 1e-6;
  let best = -1;
  let bestZ = zMin;

  const coverageAt = (z: number) => {
    let n = 0;
    for (let i = 0; i < field.hit.length; i++) {
      if (field.hit[i] && field.minZ[i] <= z + eps && field.maxZ[i] >= z - eps) n++;
    }
    return n;
  };

  for (let s = 0; s <= SAMPLES; s++) {
    const z = zMin + (span * s) / SAMPLES;
    const cov = coverageAt(z);
    // Strictly greater, so a run of equally good planes keeps the lowest one.
    if (cov > best * 1.0001) {
      best = cov;
      bestZ = z;
    }
  }
  return bestZ;
}
