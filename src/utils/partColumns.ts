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
  const cacheKey = `${bounds.minX},${bounds.minY},${bounds.maxX},${bounds.maxY},${cols},${rows}`;
  let perTris = sampleColumnsCache.get(tris);
  if (perTris) {
    const cached = perTris.get(cacheKey);
    if (cached) return cached;
  } else {
    perTris = new Map();
    sampleColumnsCache.set(tris, perTris);
  }
  const stepX = cols > 1 ? (bounds.maxX - bounds.minX) / (cols - 1) : 0;
  const stepY = rows > 1 ? (bounds.maxY - bounds.minY) / (rows - 1) : 0;
  const top = new Float32Array(cols * rows).fill(-Infinity);
  const bottom = new Float32Array(cols * rows).fill(Infinity);
  const thickness = new Float32Array(cols * rows);
  const hit = new Uint8Array(cols * rows);

  const triCount = tris.length / 9;
  if (triCount === 0) return { top, bottom, thickness, hit };

  // Bucketed by plan-view bounding box, as buildHeightmap does, so each column
  // only tests the triangles that could be over it.
  const side = Math.max(1, Math.min(128, Math.round(Math.sqrt(triCount / 2))));
  const bw = (bounds.maxX - bounds.minX) / side || 1;
  const bh = (bounds.maxY - bounds.minY) / side || 1;
  const buckets: number[][] = Array.from({ length: side * side }, () => []);
  const bucketCol = (x: number) => Math.min(side - 1, Math.max(0, Math.floor((x - bounds.minX) / bw)));
  const bucketRow = (y: number) => Math.min(side - 1, Math.max(0, Math.floor((y - bounds.minY) / bh)));

  for (let t = 0; t < triCount; t++) {
    const i = t * 9;
    const ax = tris[i], ay = tris[i + 1];
    const bx = tris[i + 3], by = tris[i + 4];
    const cx = tris[i + 6], cy = tris[i + 7];
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
