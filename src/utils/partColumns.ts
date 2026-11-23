// The part sampled as vertical columns, shared by solid machining, the DFM
// checks and the casting pattern. Kept on its own, with no imports, so the
// pattern code (which runs on the mold worker) does not pull the CNC stack in.

/**
 * The part as a set of vertical columns: for each cell, the height of its
 * upper surface, its lower surface, and how much of the column is actually
 * inside the part.
 *
 * Three numbers rather than the one a heightmap keeps, because this job looks
 * at the part from both sides and needs to know what is left in between. The
 * top and bottom are the two heightmaps; the thickness, summed over the hits
 * in pairs, is the truth they are compared against.
 */
const sampleColumnsCache = new WeakMap<
  Float64Array,
  Map<string, { top: Float32Array; bottom: Float32Array; thickness: Float32Array; hit: Uint8Array }>
>();

export function sampleColumns(
  tris: Float64Array,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  cols: number,
  rows: number
): { top: Float32Array; bottom: Float32Array; thickness: Float32Array; hit: Uint8Array } {
  const safeCols = Number.isFinite(cols) ? Math.max(0, Math.floor(cols)) : 0;
  const safeRows = Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0;
  if (
    safeCols === 0 ||
    safeRows === 0 ||
    !Number.isFinite(bounds.minX) ||
    !Number.isFinite(bounds.minY) ||
    !Number.isFinite(bounds.maxX) ||
    !Number.isFinite(bounds.maxY)
  ) {
    const n = safeCols * safeRows;
    return {
      top: new Float32Array(n).fill(-Infinity),
      bottom: new Float32Array(n).fill(Infinity),
      thickness: new Float32Array(n),
      hit: new Uint8Array(n),
    };
  }
  cols = safeCols;
  rows = safeRows;
  const cacheKey = `${bounds.minX},${bounds.minY},${bounds.maxX},${bounds.maxY},${cols},${rows}`;
  let perTris = sampleColumnsCache.get(tris);
  if (perTris) {
    const cached = perTris.get(cacheKey);
    if (cached) return cached;
  } else {
    perTris = new Map();
    sampleColumnsCache.set(tris, perTris);
  }
  const spanX = bounds.maxX - bounds.minX;
  const spanY = bounds.maxY - bounds.minY;
  const stepX = cols > 1 && Number.isFinite(spanX) ? spanX / (cols - 1) : 0;
  const stepY = rows > 1 && Number.isFinite(spanY) ? spanY / (rows - 1) : 0;
  const top = new Float32Array(cols * rows).fill(-Infinity);
  const bottom = new Float32Array(cols * rows).fill(Infinity);
  const thickness = new Float32Array(cols * rows);
  const hit = new Uint8Array(cols * rows);

  const triCount = Math.floor(tris.length / 9);
  if (triCount === 0) return { top, bottom, thickness, hit };

  // Bucketed by plan-view bounding box, as buildHeightmap does, so each column
  // only tests the triangles that could be over it.
  const side = Math.max(1, Math.min(128, Math.round(Math.sqrt(triCount / 2))));
  const bw = spanX > 1e-12 && Number.isFinite(spanX) ? spanX / side : 1;
  const bh = spanY > 1e-12 && Number.isFinite(spanY) ? spanY / side : 1;
  const buckets: number[][] = Array.from({ length: side * side }, () => []);
  const bucketCol = (x: number) => (Number.isFinite(x) ? Math.min(side - 1, Math.max(0, Math.floor((x - bounds.minX) / bw))) : 0);
  const bucketRow = (y: number) => (Number.isFinite(y) ? Math.min(side - 1, Math.max(0, Math.floor((y - bounds.minY) / bh))) : 0);

  for (let t = 0; t < triCount; t++) {
    const i = t * 9;
    const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
    const bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5];
    const cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];
    if (
      !Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az) ||
      !Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(bz) ||
      !Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)
    ) continue;
    if (Math.max(ax, bx, cx) < bounds.minX || Math.min(ax, bx, cx) > bounds.maxX) continue;
    if (Math.max(ay, by, cy) < bounds.minY || Math.min(ay, by, cy) > bounds.maxY) continue;
    const c0 = bucketCol(Math.min(ax, bx, cx));
    const c1 = bucketCol(Math.max(ax, bx, cx));
    const r0 = bucketRow(Math.min(ay, by, cy));
    const r1 = bucketRow(Math.max(ay, by, cy));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) buckets[r * side + c].push(i);
    }
  }

  // Sampled a hundredth of a cell off the grid lines. A model drawn on a
  // millimetre grid puts its faces on round numbers, and so does a sampling
  // grid, so rays land exactly on edges — where a vertical face is skipped as
  // having no plan area and a slanted one is hit twice — and the count of
  // hits comes out wrong for a whole row at a time. Off the line, they don't.
  const NUDGE = 0.0137;
  const midRow = (rows - 1) * 0.5;
  const midCol = (cols - 1) * 0.5;
  const hitZ: number[] = [];
  const hitDir: number[] = [];
  const order: number[] = [];
  for (let row = 0; row < rows; row++) {
    const nudgeY = row < midRow ? NUDGE : row > midRow ? -NUDGE : 0;
    const py = bounds.minY + (row + nudgeY) * stepY;
    const br = bucketRow(py);
    for (let col = 0; col < cols; col++) {
      const nudgeX = col < midCol ? NUDGE : col > midCol ? -NUDGE : 0;
      const px = bounds.minX + (col + nudgeX) * stepX;
      const bucket = buckets[br * side + bucketCol(px)];
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
        // Which way the face looks. `den` is minus the Z of the face normal,
        // so a positive one is a face looking down — the underside of a
        // solid, which a ray travelling upward enters.
        hitDir.push(den > 0 ? 1 : -1);
      }
      if (hitZ.length === 0) continue;

      order.length = hitZ.length;
      for (let h = 0; h < order.length; h++) order[h] = h;
      order.sort((a, b) => hitZ[a] - hitZ[b]);

      const k = row * cols + col;
      hit[k] = 1;
      top[k] = hitZ[order[order.length - 1]];
      bottom[k] = hitZ[order[0]];

      // Inside the part wherever more solids have been entered than left.
      //
      // A winding count rather than pairing the hits off, because a model
      // is often a union of overlapping pieces that were never merged — a
      // gusset sunk a millimetre into the arm it braces — and pairing reads
      // the overlap as a gap. A ray hitting the shared edge of two triangles
      // of one face sees that face twice, which the count survives only if
      // the duplicate is dropped: coincident hits facing the same way are one.
      let inside = 0;
      let depth = 0;
      let lastZ = NaN;
      let lastDir = 0;
      let enteredAt = 0;
      for (let h = 0; h < order.length; h++) {
        const z = hitZ[order[h]];
        const dir = hitDir[order[h]];
        if (dir === lastDir && Math.abs(z - lastZ) <= 1e-4) continue;
        if (dir > 0) {
          if (depth === 0) enteredAt = z;
          depth++;
        } else {
          depth--;
          if (depth === 0) inside += z - enteredAt;
        }
        lastZ = z;
        lastDir = dir;
      }
      // A mesh whose faces do not agree on which way is out never closes the
      // count. The span from bottom to top is the honest fallback for that.
      thickness[k] = depth === 0 ? inside : top[k] - bottom[k];
    }
  }

  const result = { top, bottom, thickness, hit };
  if (perTris.size >= 16) {
    const oldest = perTris.keys().next().value;
    if (oldest !== undefined) perTris.delete(oldest);
  }
  perTris.set(cacheKey, result);
  return result;
}

/**
 * The part's upper and lower surface at any point of plan, not only on a
 * grid: null where the point misses the part. For placing what the grid can
 * only put somewhere in a cell - where a wall stands - to the model's own
 * accuracy. Triangles are bucketed once, as `sampleColumns` does.
 */
export function columnProbe(
  tris: Float64Array,
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
): (x: number, y: number) => { top: number; bottom: number } | null {
  const triCount = Math.floor(tris.length / 9);
  if (
    triCount === 0 ||
    !Number.isFinite(bounds.minX) ||
    !Number.isFinite(bounds.minY) ||
    !Number.isFinite(bounds.maxX) ||
    !Number.isFinite(bounds.maxY)
  ) {
    return () => null;
  }
  // Each triangle goes only in the buckets it actually crosses, not every one
  // its bounding box does: a cap fanned from its centre is slivers that each
  // span the part, and by bounding box every bucket held a quarter of them.
  const side = Math.max(1, Math.min(256, Math.round(Math.sqrt(triCount) * 2)));
  const spanX = bounds.maxX - bounds.minX;
  const spanY = bounds.maxY - bounds.minY;
  const bw = spanX > 1e-12 && Number.isFinite(spanX) ? spanX / side : 1;
  const bh = spanY > 1e-12 && Number.isFinite(spanY) ? spanY / side : 1;
  const bucketCol = (x: number) => (Number.isFinite(x) ? Math.min(side - 1, Math.max(0, Math.floor((x - bounds.minX) / bw))) : 0);
  const bucketRow = (y: number) => (Number.isFinite(y) ? Math.min(side - 1, Math.max(0, Math.floor((y - bounds.minY) / bh))) : 0);
  const buckets: number[][] = Array.from({ length: side * side }, () => []);
  /** Whether the triangle's plan crosses the box (separating axes: the box's two and the three edge normals). */
  const crosses = (i: number, x0: number, y0: number, x1: number, y1: number) => {
    const xs = [tris[i], tris[i + 3], tris[i + 6]], ys = [tris[i + 1], tris[i + 4], tris[i + 7]];
    for (let e = 0; e < 3; e++) {
      const ax = xs[e], ay = ys[e], bx = xs[(e + 1) % 3], by = ys[(e + 1) % 3], cx = xs[(e + 2) % 3], cy = ys[(e + 2) % 3];
      const nx = ay - by, ny = bx - ax;
      const side3 = nx * (cx - ax) + ny * (cy - ay);
      const sign = side3 >= 0 ? 1 : -1;
      // All four corners on the far side of this edge from the third vertex: apart.
      let apart = true;
      for (const [px, py] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
        if (sign * (nx * (px - ax) + ny * (py - ay)) >= 0) { apart = false; break; }
      }
      if (apart) return false;
    }
    return true;
  };
  for (let t = 0; t < triCount; t++) {
    const i = t * 9;
    const xs = [tris[i], tris[i + 3], tris[i + 6]], ys = [tris[i + 1], tris[i + 4], tris[i + 7]];
    if (Math.max(...xs) < bounds.minX || Math.min(...xs) > bounds.maxX) continue;
    if (Math.max(...ys) < bounds.minY || Math.min(...ys) > bounds.maxY) continue;
    // A vertical face has no plan area and no ray hits it.
    if ((xs[2] - xs[0]) * (ys[1] - ys[0]) - (xs[1] - xs[0]) * (ys[2] - ys[0]) === 0) continue;
    for (let r = bucketRow(Math.min(...ys)); r <= bucketRow(Math.max(...ys)); r++) {
      for (let c = bucketCol(Math.min(...xs)); c <= bucketCol(Math.max(...xs)); c++) {
        const x0 = bounds.minX + c * bw, y0 = bounds.minY + r * bh;
        if (crosses(i, x0 - 1e-9, y0 - 1e-9, x0 + bw + 1e-9, y0 + bh + 1e-9)) buckets[r * side + c].push(i);
      }
    }
  }
  return (px, py) => {
    if (px < bounds.minX || px > bounds.maxX || py < bounds.minY || py > bounds.maxY) return null;
    let top = -Infinity, bottom = Infinity;
    for (const i of buckets[bucketRow(py) * side + bucketCol(px)]) {
      const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
      const v0x = tris[i + 6] - ax, v0y = tris[i + 7] - ay;
      const v1x = tris[i + 3] - ax, v1y = tris[i + 4] - ay;
      const v2x = px - ax, v2y = py - ay;
      const den = v0x * v1y - v1x * v0y;
      if (den === 0) continue;
      const u = (v2x * v1y - v1x * v2y) / den;
      const v = (v0x * v2y - v2x * v0y) / den;
      if (u < 0 || v < 0 || u + v > 1) continue;
      const z = az + u * (tris[i + 8] - az) + v * (tris[i + 5] - az);
      if (z > top) top = z;
      if (z < bottom) bottom = z;
    }
    return top === -Infinity ? null : { top, bottom };
  };
}

export interface WallSpanSample {
  /** Per-column offset into `spanZ0` / `spanZ1` (length `cols * rows + 1`). */
  spanStart: Uint32Array;
  /** Entry Z of every closed solid span, in the soup's units. */
  spanZ0: Float32Array;
  /** Exit Z of every closed solid span, in the soup's units. */
  spanZ1: Float32Array;
  /** Minimum valid wall span thickness in each column (Infinity if no valid wall span). */
  minWall: Float32Array;
  /** Midpoint Z of that thinnest valid wall span. */
  minWallMid: Float32Array;
  /** Entry/exit Z of that thinnest valid wall span. */
  minWallZ0: Float32Array;
  minWallZ1: Float32Array;
  /** 1 where the column hit at least one closed solid span. */
  hit: Uint8Array;
}

/**
 * Samples individual closed solid spans along Z for wall-thickness checks.
 *
 * Unlike `sampleColumns` (which sums all solid spans in a column for CNC
 * undercut volume), this keeps every individual solid span separate so a
 * hollow box with two thin walls does not sum them into one thick wall.
 * It also records the entry/exit face normals of each span and only counts
 * spans whose entry and exit faces oppose each other along the ray axis
 * (`|n_in.z| >= 0.5`, `|n_out.z| >= 0.5`, `dot(n_in, n_out) <= -0.7`),
 * rejecting grazing mountain-ridge crests, thread tips, and silhouette edges.
 */
export function sampleWallSpans(
  tris: Float64Array,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  cols: number,
  rows: number,
): WallSpanSample {
  const safeCols = Number.isFinite(cols) ? Math.max(0, Math.floor(cols)) : 0;
  const safeRows = Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0;
  const nCells = safeCols * safeRows;
  const spanStart = new Uint32Array(nCells + 1);
  const minWall = new Float32Array(nCells).fill(Infinity);
  const minWallMid = new Float32Array(nCells);
  const minWallZ0 = new Float32Array(nCells);
  const minWallZ1 = new Float32Array(nCells);
  const hit = new Uint8Array(nCells);

  const triCount = Math.floor(tris.length / 9);
  if (
    nCells === 0 ||
    triCount === 0 ||
    !Number.isFinite(bounds.minX) ||
    !Number.isFinite(bounds.minY) ||
    !Number.isFinite(bounds.maxX) ||
    !Number.isFinite(bounds.maxY)
  ) {
    return {
      spanStart,
      spanZ0: new Float32Array(0),
      spanZ1: new Float32Array(0),
      minWall,
      minWallMid,
      minWallZ0,
      minWallZ1,
      hit,
    };
  }

  const spanX = bounds.maxX - bounds.minX;
  const spanY = bounds.maxY - bounds.minY;
  const stepX = safeCols > 1 && Number.isFinite(spanX) ? spanX / (safeCols - 1) : 0;
  const stepY = safeRows > 1 && Number.isFinite(spanY) ? spanY / (safeRows - 1) : 0;

  const side = Math.max(1, Math.min(128, Math.round(Math.sqrt(triCount / 2))));
  const bw = spanX > 1e-12 && Number.isFinite(spanX) ? spanX / side : 1;
  const bh = spanY > 1e-12 && Number.isFinite(spanY) ? spanY / side : 1;
  const buckets: number[][] = Array.from({ length: side * side }, () => []);
  const bucketCol = (x: number) => (Number.isFinite(x) ? Math.min(side - 1, Math.max(0, Math.floor((x - bounds.minX) / bw))) : 0);
  const bucketRow = (y: number) => (Number.isFinite(y) ? Math.min(side - 1, Math.max(0, Math.floor((y - bounds.minY) / bh))) : 0);

  for (let t = 0; t < triCount; t++) {
    const i = t * 9;
    const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
    const bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5];
    const cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];
    if (
      !Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az) ||
      !Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(bz) ||
      !Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)
    ) continue;
    if (Math.max(ax, bx, cx) < bounds.minX || Math.min(ax, bx, cx) > bounds.maxX) continue;
    if (Math.max(ay, by, cy) < bounds.minY || Math.min(ay, by, cy) > bounds.maxY) continue;
    const c0 = bucketCol(Math.min(ax, bx, cx));
    const c1 = bucketCol(Math.max(ax, bx, cx));
    const r0 = bucketRow(Math.min(ay, by, cy));
    const r1 = bucketRow(Math.max(ay, by, cy));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) buckets[r * side + c].push(i);
    }
  }

  const NUDGE = 0.0137;
  const midRow = (safeRows - 1) * 0.5;
  const midCol = (safeCols - 1) * 0.5;
  const hitZ: number[] = [];
  const hitDir: number[] = [];
  const hitNx: number[] = [];
  const hitNy: number[] = [];
  const hitNz: number[] = [];
  const order: number[] = [];
  const rawZ0: number[] = [];
  const rawZ1: number[] = [];

  for (let row = 0; row < safeRows; row++) {
    const nudgeY = row < midRow ? NUDGE : row > midRow ? -NUDGE : 0;
    const py = bounds.minY + (row + nudgeY) * stepY;
    const br = bucketRow(py);
    for (let col = 0; col < safeCols; col++) {
      const k = row * safeCols + col;
      spanStart[k] = rawZ0.length;
      const nudgeX = col < midCol ? NUDGE : col > midCol ? -NUDGE : 0;
      const px = bounds.minX + (col + nudgeX) * stepX;
      const bucket = buckets[br * side + bucketCol(px)];
      if (bucket.length === 0) continue;

      hitZ.length = 0;
      hitDir.length = 0;
      hitNx.length = 0;
      hitNy.length = 0;
      hitNz.length = 0;

      for (const i of bucket) {
        const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
        const bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5];
        const cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];
        const v0x = cx - ax, v0y = cy - ay, v0z = cz - az;
        const v1x = bx - ax, v1y = by - ay, v1z = bz - az;
        const v2x = px - ax, v2y = py - ay;
        const den = v0x * v1y - v1x * v0y;
        if (den === 0) continue;
        const u = (v2x * v1y - v1x * v2y) / den;
        const v = (v0x * v2y - v2x * v0y) / den;
        if (u < 0 || v < 0 || u + v > 1) continue;
        // Outward unit normal = normalize((B - A) × (C - A)) = normalize(v1 × v0).
        const nx = v1y * v0z - v1z * v0y;
        const ny = v1z * v0x - v1x * v0z;
        const nz = -den;
        const nLen = Math.hypot(nx, ny, nz);
        if (!(nLen > 1e-18)) continue;
        hitZ.push(az + u * v0z + v * v1z);
        hitDir.push(den > 0 ? 1 : -1);
        hitNx.push(nx / nLen);
        hitNy.push(ny / nLen);
        hitNz.push(nz / nLen);
      }
      if (hitZ.length === 0) continue;

      order.length = hitZ.length;
      for (let h = 0; h < order.length; h++) order[h] = h;
      order.sort((a, b) => hitZ[a] - hitZ[b]);

      let depth = 0;
      let lastZ = NaN;
      let lastDir = 0;
      let enteredAt = 0;
      let enX = 0, enY = 0, enZ = 0;
      let bestThick = Infinity;
      let bestZ0 = 0, bestZ1 = 0;
      let anySpan = false;

      for (let h = 0; h < order.length; h++) {
        const idx = order[h];
        const z = hitZ[idx];
        const dir = hitDir[idx];
        if (dir === lastDir && Math.abs(z - lastZ) <= 1e-4) continue;
        if (dir > 0) {
          if (depth === 0) {
            enteredAt = z;
            enX = hitNx[idx]; enY = hitNy[idx]; enZ = hitNz[idx];
          }
          depth++;
        } else if (depth > 0) {
          depth--;
          if (depth === 0 && z > enteredAt) {
            anySpan = true;
            rawZ0.push(enteredAt);
            rawZ1.push(z);
            const thick = z - enteredAt;
            const exX = hitNx[idx], exY = hitNy[idx], exZ = hitNz[idx];
            // A real wall has entry and exit faces aligned with the ray axis
            // and opposing each other (not a grazing surface crest or sharp ridge).
            const dot = enX * exX + enY * exY + enZ * exZ;
            if (Math.abs(enZ) >= 0.5 && Math.abs(exZ) >= 0.5 && dot <= -0.7 && thick < bestThick) {
              bestThick = thick;
              bestZ0 = enteredAt;
              bestZ1 = z;
            }
          }
        }
        lastZ = z;
        lastDir = dir;
      }

      if (anySpan) {
        hit[k] = 1;
        if (bestThick < Infinity) {
          minWall[k] = bestThick;
          minWallZ0[k] = bestZ0;
          minWallZ1[k] = bestZ1;
          minWallMid[k] = (bestZ0 + bestZ1) * 0.5;
        }
      }
    }
  }
  spanStart[nCells] = rawZ0.length;

  return {
    spanStart,
    spanZ0: Float32Array.from(rawZ0),
    spanZ1: Float32Array.from(rawZ1),
    minWall,
    minWallMid,
    minWallZ0,
    minWallZ1,
    hit,
  };
}
