// The surface a carve cuts to: sampling a scene into a heightmap, and offsetting it for the cutter.

import { WALL_SLOPE } from './finishingPaths';
import { vBitHalfAngleRad, type CutterShape, type CutterTip } from './reliefOptions';

/** What `findUndercut` reports, in machine mm. */
export interface Undercut {
  /** Plan area over hidden space. */
  areaMm2: number;
  /** Volume of hidden space that will be left solid. */
  volumeMm3: number;
  /** Thickest hidden gap in one column. */
  maxMm: number;
  /** Plan extent of the undercut cells. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}


// ---------------------------------------------------------------------------
// Heightmap
// ---------------------------------------------------------------------------

/**
 * A part of the tool above its cutting end, as a cylinder.
 *
 * The shank of a small bit is wider than the bit, and the collet nut is wider
 * again; both have to clear the work even though neither cuts. Modelling them
 * as (how far up, how wide) is enough to catch the two ways that goes wrong —
 * the shank rubbing a wall the flutes cleared, and the nut striking something
 * standing proud a centimetre away.
 */
export interface ToolBodySection {
  /** Height of the bottom of this section above the tip of the tool, in mm. */
  aboveTipMm: number;
  /** Radius of this section in mm. */
  radiusMm: number;
}

export interface Heightmap {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cols: number;
  rows: number;
  stepX: number;
  stepY: number;
  /** Surface Z per cell, row-major with row 0 at minY. Stock top is 0. */
  z: Float32Array;
}

/**
 * How narrow the relief's valleys are, in mm — the widest bit that still gets
 * into them.
 *
 * The cells below six tenths of the way to the relief's floor are the valley
 * floors and lower walls. The floor is the depth one cell in a hundred lies
 * below, not the nominal depth and not the single lowest sample: a generated
 * panel carries a base its pattern never reaches, and a sample that catches
 * the panel's side wall reads the base, which put the threshold in the last
 * few tenths of a millimetre of every seam and measured hairlines. A disc of
 * diameter d reaches the part of that area that survives an opening by d:
 * erode by d/2, so only the cells a disc centre can sit in are left, then
 * grow back by d/2 to get the area such discs sweep. The answer is the
 * largest d that still sweeps half the valley area — the typical valley by
 * area, rather than the finest line, because a sampled relief always has
 * hairlines at the cell level and a bit sized to those is a bit sized to
 * noise. A giraffe hide's seams are all the valley there is, so this is the
 * seam; a wood grain's is its wide earlywood bands, not its ring lines.
 *
 * Both erosion and growth are chamfer distance transforms, so the whole thing
 * is linear in the grid and the search over d is a handful of them.
 *
 * Undefined when the relief has no valleys or is all valley, and both mean
 * the same thing: nothing here constrains the bit.
 */
export function measureDetailMm(hm: Heightmap, depthMm: number): number | undefined {
  const { cols, rows, z } = hm;
  if (cols < 3 || rows < 3 || depthMm <= 0) return undefined;
  const sorted = Float32Array.from(z).sort();
  const lowest = Math.min(0, sorted[Math.floor(sorted.length * 0.01)]);
  if (lowest > -1e-6) return undefined;
  const threshold = 0.6 * lowest;
  const deep = new Uint8Array(cols * rows);
  let deepCells = 0;
  for (let i = 0; i < z.length; i++) {
    if (z[i] <= threshold) {
      deep[i] = 1;
      deepCells++;
    }
  }
  if (deepCells === 0 || deepCells === z.length) return undefined;

  const cell = (hm.stepX + hm.stepY) / 2;
  const toWall = chamferDistance(deep, cols, rows, 1);

  const coverage = (diaMm: number): number => {
    const r = diaMm / 2 / cell;
    // Cells a disc of this size can centre on.
    const core = new Uint8Array(cols * rows);
    let any = false;
    for (let i = 0; i < toWall.length; i++) {
      if (deep[i] && toWall[i] >= r) {
        core[i] = 1;
        any = true;
      }
    }
    if (!any) return 0;
    const toCore = chamferDistance(core, cols, rows, 0);
    let swept = 0;
    for (let i = 0; i < toCore.length; i++) if (deep[i] && toCore[i] <= r) swept++;
    return swept / deepCells;
  };

  // Coverage only falls as the disc grows, so bisect on it.
  const ENOUGH = 0.5;
  let lo = cell;
  if (coverage(lo) < ENOUGH) return Math.round(lo * 100) / 100;
  let hi = Math.max(hm.maxX - hm.minX, hm.maxY - hm.minY);
  if (coverage(hi) >= ENOUGH) return undefined;
  while (hi - lo > 0.1) {
    const mid = (lo + hi) / 2;
    if (coverage(mid) >= ENOUGH) lo = mid;
    else hi = mid;
  }
  return Math.round(lo * 100) / 100;
}

/**
 * Distance, in cells, from every cell to the nearest cell whose mark differs
 * from `from` — for `from` = 1, how far each marked cell is from an unmarked
 * one, and 0 on the unmarked cells themselves. The 3-4 chamfer, which is
 * within a few percent of Euclidean and two passes over the grid. Cells that
 * never see the other kind come back as Infinity.
 */
function chamferDistance(mark: Uint8Array, cols: number, rows: number, from: 0 | 1): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(cols * rows);
  for (let i = 0; i < d.length; i++) d[i] = mark[i] === from ? INF : 0;
  const at = (c: number, r: number) => d[r * cols + c];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let v = d[r * cols + c];
      if (v === 0) continue;
      if (c > 0) v = Math.min(v, at(c - 1, r) + 3);
      if (r > 0) {
        v = Math.min(v, at(c, r - 1) + 3);
        if (c > 0) v = Math.min(v, at(c - 1, r - 1) + 4);
        if (c < cols - 1) v = Math.min(v, at(c + 1, r - 1) + 4);
      }
      d[r * cols + c] = v;
    }
  }
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      let v = d[r * cols + c];
      if (v === 0) continue;
      if (c < cols - 1) v = Math.min(v, at(c + 1, r) + 3);
      if (r < rows - 1) {
        v = Math.min(v, at(c, r + 1) + 3);
        if (c < cols - 1) v = Math.min(v, at(c + 1, r + 1) + 4);
        if (c > 0) v = Math.min(v, at(c - 1, r + 1) + 4);
      }
      d[r * cols + c] = v;
    }
  }
  for (let i = 0; i < d.length; i++) d[i] = d[i] >= INF ? Infinity : d[i] / 3;
  return d;
}

/**
 * Samples a heightmap between its cells. Outside the grid it clamps to the
 * edge, which is what the tool dilation below wants at the stock boundary.
 */
export function sampleHeightmap(hm: Heightmap, x: number, y: number): number {
  const fx = Math.min(hm.cols - 1, Math.max(0, (x - hm.minX) / hm.stepX));
  const fy = Math.min(hm.rows - 1, Math.max(0, (y - hm.minY) / hm.stepY));

  const c0 = Math.min(hm.cols - 1, Math.floor(fx));
  const r0 = Math.min(hm.rows - 1, Math.floor(fy));
  const c1 = Math.min(hm.cols - 1, c0 + 1);
  const r1 = Math.min(hm.rows - 1, r0 + 1);

  const tx = fx - c0;
  const ty = fy - r0;

  const z00 = hm.z[r0 * hm.cols + c0];
  const z10 = hm.z[r0 * hm.cols + c1];
  const z01 = hm.z[r1 * hm.cols + c0];
  const z11 = hm.z[r1 * hm.cols + c1];

  return (z00 * (1 - tx) + z10 * tx) * (1 - ty) + (z01 * (1 - tx) + z11 * tx) * ty;
}

/**
 * Drops a vertical ray through every cell and keeps the highest triangle it
 * hits — the model as seen from the spindle.
 *
 * Testing every triangle against every cell is what makes the naive version of
 * this unusable on a real mesh (a 300 x 300 grid against a 20 k triangle model
 * is 1.8 billion tests), so triangles are bucketed by their plan-view bounding
 * box first and each ray only visits its own bucket.
 */
export function buildHeightmap(
  tris: Float64Array,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  cols: number,
  rows: number,
  floorZ: number,
  /**
   * When given, receives per cell the height of air the ray passed through
   * *below* the first surface it met — space under an overhang, which a
   * cutter coming down from above cannot reach. Gaps are only counted down
   * to `floorZ`. See `hiddenGap`.
   */
  hidden?: { gap: Float32Array; floorZ: number }
): Heightmap {
  const stepX = cols > 1 ? (bounds.maxX - bounds.minX) / (cols - 1) : 0;
  const stepY = rows > 1 ? (bounds.maxY - bounds.minY) / (rows - 1) : 0;
  const z = new Float32Array(cols * rows).fill(floorZ);

  const triCount = tris.length / 9;
  if (triCount === 0) {
    return { ...bounds, cols, rows, stepX, stepY, z };
  }

  // One bucket per few triangles, capped so the index itself stays small.
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

    // A triangle entirely off the stock can never be hit by a ray we cast.
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

  // Each hit's height, and whether the ray met the triangle's outside (an
  // up-facing face, where it enters solid) or its inside.
  const hits: number[] = [];
  const entering: boolean[] = [];
  for (let row = 0; row < rows; row++) {
    const py = bounds.minY + row * stepY;
    const br = bucketRow(py);

    for (let col = 0; col < cols; col++) {
      const px = bounds.minX + col * stepX;
      const bucket = buckets[br * side + bucketCol(px)];
      if (bucket.length === 0) continue;

      let best = floorZ;
      hits.length = 0;
      entering.length = 0;

      for (const i of bucket) {
        const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
        const bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5];
        const cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];

        // Barycentric coordinates of (px, py) in the triangle's plan view.
        const v0x = cx - ax, v0y = cy - ay;
        const v1x = bx - ax, v1y = by - ay;
        const v2x = px - ax, v2y = py - ay;

        const den = v0x * v1y - v1x * v0y;
        if (den === 0) continue; // Edge-on triangle: it has no plan-view area.

        const u = (v2x * v1y - v1x * v2y) / den;
        const v = (v0x * v2y - v2x * v0y) / den;
        if (u < 0 || v < 0 || u + v > 1) continue;

        const hitZ = az + u * (cz - az) + v * (bz - az);
        if (hitZ > best) best = hitZ;
        if (hidden) {
          hits.push(hitZ);
          // `den` is the plan-view cross product of (c - a) and (b - a): the
          // opposite of the face normal's Z for a counter-clockwise triangle.
          entering.push(den < 0);
        }
      }

      if (best > floorZ) z[row * cols + col] = best;
      if (hidden && hits.length >= 3) {
        hidden.gap[row * cols + col] = hiddenGap(hits, entering, hidden.floorZ);
      }
    }
  }

  return { ...bounds, cols, rows, stepX, stepY, z };
}

/**
 * Air under the first surface a vertical ray meets, down to `floorZ`.
 *
 * Walking down the ray, an outward-facing (up) face is a way into solid and
 * an inward one a way out; air is wherever the count is back to zero. A count
 * rather than plain alternation, because a scene is often several solids that
 * overlap — a wall box standing in a floor box — and alternation reads the
 * floor's top inside the wall as a cavity. A ray through an edge two faces
 * share meets both at one height, so hits at one height facing one way are
 * counted once. A column whose first face looks inward is from a mesh wound
 * inside out, and is read with every face flipped.
 */
function hiddenGap(hits: number[], entering: boolean[], floorZ: number): number {
  const order = hits.map((_, i) => i).sort((a, b) => hits[b] - hits[a]);
  const flip = !entering[order[0]];
  let depth = 0;
  let airFrom: number | null = null;
  let gap = 0;
  let lastZ = Infinity;
  let lastIn: boolean | null = null;
  let started = false;
  for (const i of order) {
    const h = hits[i];
    if (h <= floorZ) break;
    const into = entering[i] !== flip;
    if (lastIn === into && lastZ - h < 1e-4) continue;
    lastZ = h;
    lastIn = into;
    depth += into ? 1 : -1;
    if (!started) {
      started = true;
      continue;
    }
    if (depth <= 0 && airFrom === null) airFrom = h;
    else if (depth > 0 && airFrom !== null) {
      gap += airFrom - h;
      airFrom = null;
    }
  }
  // Air with no solid under it before the floor is below the model, not
  // under an overhang of it.
  return gap;
}

/**
 * Totals the hidden gaps `buildHeightmap` found into one figure, ignoring
 * gaps too thin to matter (a coarse mesh's seams, a tenth of a millimetre of
 * draft) so the warning means something when it appears.
 */
export function findUndercut(
  gap: Float32Array,
  hm: Pick<Heightmap, 'cols' | 'rows' | 'minX' | 'minY' | 'stepX' | 'stepY'>,
  minGapMm = 0.25
): Undercut | null {
  let cells = 0;
  let volume = 0;
  let maxMm = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const cellArea = hm.stepX * hm.stepY;
  for (let i = 0; i < gap.length; i++) {
    const g = gap[i];
    if (!(g > minGapMm)) continue;
    cells++;
    volume += g * cellArea;
    if (g > maxMm) maxMm = g;
    const x = hm.minX + (i % hm.cols) * hm.stepX;
    const y = hm.minY + Math.floor(i / hm.cols) * hm.stepY;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const areaMm2 = cells * cellArea;
  // A handful of cells is a mesh artefact, not a feature anybody modelled.
  if (areaMm2 < 4 || volume < 2) return null;
  return { areaMm2, volumeMm3: volume, maxMm, bounds: { minX, minY, maxX, maxY } };
}

/**
 * The deepest point of a sampled surface that a cutter can actually be asked
 * to reach: the lowest covered cell whose four neighbours are covered too.
 * The rim cells are skipped because a ray grazing the foot of a vertical side
 * wall can hit it at its base, and one such cell would otherwise set the
 * depth of the whole job to the model's full height.
 */
export function lowestInteriorZ(hm: Heightmap): number {
  const { cols, rows, z } = hm;
  let lowest = Infinity;
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const i = r * cols + c;
      const v = z[i];
      if (v === -Infinity || v >= lowest) continue;
      if (z[i - 1] === -Infinity || z[i + 1] === -Infinity) continue;
      if (z[i - cols] === -Infinity || z[i + cols] === -Infinity) continue;
      lowest = v;
    }
  }
  return lowest;
}

/**
 * Lifts the surface into the height the tool's *tip* has to sit at to graze it
 * without cutting into it anywhere under the cutter — a Minkowski dilation by
 * the tool's own shape.
 *
 * This is the step that decides whether the carve is a carve. Driving the tip
 * straight along the sampled surface gouges every convex feature by up to the
 * tool radius, because the shank cuts material the tip never touched.
 */
export function dilateForTool(
  hm: Heightmap,
  toolRadiusMm: number,
  /**
   * The cutting end's shape. `true`/`false` is the old ball/flat switch, still
   * accepted so that callers and tests that only ever knew about those two
   * shapes read the same.
   */
  tip: boolean | CutterTip,
  body: ToolBodySection[] = [],
  /**
   * Where a wall stands inside the cell it was sampled across, which the
   * samples alone cannot say.
   *
   * 'samples' trusts only the samples, so a cutter may stand up to a cell
   * inside a wall: slots a cutter wide still go through, at the price of
   * cutting into the side of a part by as much as a cell.
   *
   * 'middle' (the default) puts the wall where the samples' bilinear crosses
   * half way between the cell's lowest and highest corner. Wrong by at most
   * half a cell either way, against the full cell 'samples' can cut in by,
   * and a slot a cutter wide still goes through.
   *
   * 'clear' assumes the wall is at the edge of its cell nearest the cutter,
   * so the cutter never enters it. It leaves up to a cell on, which costs
   * roughing nothing: roughing leaves an allowance anyway, and a roughing bit
   * that cuts into a finished wall cannot be undone.
   */
  walls: 'samples' | 'middle' | 'clear' = 'middle'
): Heightmap {
  const out = new Float32Array(hm.z);
  if (toolRadiusMm <= 0) return { ...hm, z: out };
  const { kx, ky, lift, extraX, extraY, extraLift, at } = toolProbe(hm, toolRadiusMm, tip, body, walls);

  for (let row = 0; row < hm.rows; row++) {
    for (let col = 0; col < hm.cols; col++) {
      let best = -Infinity;

      for (let dy = -ky; dy <= ky; dy++) {
        const r = Math.min(hm.rows - 1, Math.max(0, row + dy));
        for (let dx = -kx; dx <= kx; dx++) {
          const l = lift[(dy + ky) * (2 * kx + 1) + (dx + kx)];
          if (l === -Infinity) continue;
          const c = Math.min(hm.cols - 1, Math.max(0, col + dx));
          const candidate = hm.z[r * hm.cols + c] + l;
          if (candidate > best) best = candidate;
        }
      }
      for (let e = 0; e < extraLift.length; e++) {
        const candidate = at(col + extraX[e], row + extraY[e]) + extraLift[e];
        if (candidate > best) best = candidate;
      }

      out[row * hm.cols + col] = best;
    }
  }

  return { ...hm, z: out };
}

/**
 * What `dilateForTool` measures a tool against: the kernel of samples round
 * the tip with the lift each one asks for, the points between samples that
 * hold it up on a slope or a rim, and how the surface is read between samples
 * (`at`, in cells, by the `walls` rule).
 */
function toolProbe(
  hm: Heightmap,
  toolRadiusMm: number,
  tip: boolean | CutterTip,
  body: ToolBodySection[],
  walls: 'samples' | 'middle' | 'clear'
) {
  const shape: CutterShape =
    typeof tip === 'boolean' ? (tip ? 'ball_nose' : 'flat') : tip.shape;
  // Rise per mm of radius on the cone's flank: the tip has to sit this much
  // lower than a point one millimetre out for the flank to just graze it.
  const coneSlope =
    shape === 'v_bit'
      ? 1 / Math.tan(vBitHalfAngleRad(typeof tip === 'boolean' ? 60 : tip.vBitAngleDeg ?? 60))
      : 0;

  // The kernel has to be wide enough for the widest part of the tool, not just
  // the cutting end — the whole point of the body sections is that they stick
  // out past it.
  const reach = Math.max(toolRadiusMm, ...body.map((s) => s.radiusMm));
  const kx = Math.max(1, Math.round(reach / (hm.stepX || reach)));
  const ky = Math.max(1, Math.round(reach / (hm.stepY || reach)));

  // Lift is how far the tip has to sit above a neighbouring cell for the tool
  // to clear it, precomputed per kernel cell.
  //
  // For the cutting end that is the tool's own shape, worked out per shape
  // below.
  //
  // For a body section — the shank above the flutes, the collet nut above that
  // — the section is a cylinder of radius R sitting H above the tip, so the tip
  // may go H *below* whatever that cylinder has to clear: a lift of -H, out to
  // radius R. Sections are wider and higher than the cutter, so they bind
  // exactly where the cutter alone would have said the path was clear.
  //
  // A cell covered by more than one section takes whichever binds hardest,
  // which is the largest lift, so the pass below can stay a plain max.
  const lift = new Float32Array((2 * ky + 1) * (2 * kx + 1)).fill(-Infinity);
  for (let dy = -ky; dy <= ky; dy++) {
    for (let dx = -kx; dx <= kx; dx++) {
      const ox = dx * hm.stepX;
      const oy = dy * hm.stepY;
      const d2 = ox * ox + oy * oy;

      let best = -Infinity;
      if (d2 <= toolRadiusMm * toolRadiusMm) {
        // A ball of radius r touching a point d away rides with its centre at
        // h + sqrt(r^2 - d^2), so its tip is one radius below that. A cone of
        // half-angle t has its flank d/tan(t) above the point, so the tip goes
        // that far below — which is why a V-bit drops into a groove no ball
        // nose of the same nominal size can enter. A flat mill lifts by
        // nothing: its whole flat bottom has to clear the highest point under
        // it.
        if (shape === 'ball_nose') {
          best = Math.sqrt(toolRadiusMm * toolRadiusMm - d2) - toolRadiusMm;
        } else if (shape === 'v_bit') {
          best = -Math.sqrt(d2) * coneSlope;
        } else {
          best = 0;
        }
      }
      for (const s of body) {
        if (d2 <= s.radiusMm * s.radiusMm && -s.aboveTipMm > best) best = -s.aboveTipMm;
      }
      if (best > -Infinity) lift[(dy + ky) * (2 * kx + 1) + (dx + kx)] = best;
    }
  }

  /*
   * Points between the samples.
   *
   * The surface between samples is the bilinear the rest of the exporter reads
   * it as, and the samples alone do not bound it. On a slope the highest point
   * under a flat cutter is on its rim, uphill, and the nearest sample inside
   * the rim can be most of a cell short of it: the tip was set that much too
   * low, a slope times half a cell. On a 100 mm dome sampled every 0.6 mm that
   * put the finishing pass 0.23 mm into the surface with a flat finisher, and
   * 0.075 mm with a ball nose.
   *
   * Along any line parallel to an axis a bilinear is straight, so over a disc
   * it peaks either at a sample inside or on the rim, and rim points close the
   * gap for anything that lifts by a constant: the flat end and each body
   * section. A ball or a V lifts less towards its axis, so it can be held up
   * from inside a cell as well, and takes a finer lattice across its face.
   * Cells with a wall in them are read by the `walls` rule (see `at`).
   */
  const extra: { ox: number; oy: number; lift: number }[] = [];
  const pitch = Math.min(hm.stepX || Infinity, hm.stepY || Infinity);
  if (Number.isFinite(pitch) && pitch > 0) {
    const sub = pitch / 3;
    const tipLift = (d: number) =>
      shape === 'ball_nose'
        ? Math.sqrt(Math.max(0, toolRadiusMm * toolRadiusMm - d * d)) - toolRadiusMm
        : shape === 'v_bit' ? -d * coneSlope : 0;
    const rim = (radius: number, l: number) => {
      const n = Math.max(8, Math.ceil((2 * Math.PI * radius) / sub));
      for (let k = 0; k < n; k++) {
        const a = (2 * Math.PI * k) / n;
        extra.push({ ox: radius * Math.cos(a), oy: radius * Math.sin(a), lift: l });
      }
    };
    rim(toolRadiusMm, tipLift(toolRadiusMm));
    for (const s of body) rim(s.radiusMm, -s.aboveTipMm);
    if (shape !== 'flat') {
      const nx = Math.ceil(toolRadiusMm / (hm.stepX / 3));
      const ny = Math.ceil(toolRadiusMm / (hm.stepY / 3));
      for (let b = -ny; b <= ny; b++) {
        for (let a = -nx; a <= nx; a++) {
          if (a % 3 === 0 && b % 3 === 0) continue; // a sample: in the kernel already
          const ox = (a * hm.stepX) / 3, oy = (b * hm.stepY) / 3;
          const d = Math.hypot(ox, oy);
          if (d < toolRadiusMm) extra.push({ ox, oy, lift: tipLift(d) });
        }
      }
    }
  }
  const at = (x: number, y: number) => {
    const fx = Math.min(hm.cols - 1, Math.max(0, x)), fy = Math.min(hm.rows - 1, Math.max(0, y));
    const c0 = Math.min(hm.cols - 2, Math.floor(fx)), r0 = Math.min(hm.rows - 2, Math.floor(fy));
    if (c0 < 0 || r0 < 0) return hm.z[Math.round(fy) * hm.cols + Math.round(fx)];
    const tx = fx - c0, ty = fy - r0;
    const k = r0 * hm.cols + c0;
    const z00 = hm.z[k], z10 = hm.z[k + 1], z01 = hm.z[k + hm.cols], z11 = hm.z[k + hm.cols + 1];
    // A wall is sampled as a ramp a cell wide, but it stands somewhere in that
    // cell, not across it: read as a ramp it lifted the cutter a cell clear of
    // every wall, and slots stopped going through. Where in the cell it is
    // read to stand is the `walls` rule; 'middle' reads either side of the
    // half-way line as the level on that side.
    const wall = WALL_SLOPE * Math.min(hm.stepX || Infinity, hm.stepY || Infinity);
    if (
      Math.abs(z10 - z00) > wall || Math.abs(z11 - z01) > wall ||
      Math.abs(z01 - z00) > wall || Math.abs(z11 - z10) > wall
    ) {
      const high = Math.max(z00, z10, z01, z11);
      if (walls === 'clear') return high;
      const low = Math.min(z00, z10, z01, z11);
      if (walls === 'samples') {
        const rx = Math.round(fx), ry = Math.round(fy);
        if (Math.abs(fx - rx) < 1e-6 && Math.abs(fy - ry) < 1e-6) {
          return hm.z[ry * hm.cols + rx];
        }
        return low;
      }
      const here = (z00 * (1 - tx) + z10 * tx) * (1 - ty) + (z01 * (1 - tx) + z11 * tx) * ty;
      return here >= (low + high) / 2 ? high : low;
    }
    return (z00 * (1 - tx) + z10 * tx) * (1 - ty) + (z01 * (1 - tx) + z11 * tx) * ty;
  };
  // In cells, so the inner loop is additions.
  const extraX = Float64Array.from(extra, (e) => (hm.stepX ? e.ox / hm.stepX : 0));
  const extraY = Float64Array.from(extra, (e) => (hm.stepY ? e.oy / hm.stepY : 0));
  const extraLift = Float64Array.from(extra, (e) => e.lift);

  return { kx, ky, lift, extraX, extraY, extraLift, at };
}

/**
 * The height the tool's tip has to sit at to clear the surface, at any point
 * rather than only on a sample: `dilateForTool` for one place. A waterline's
 * points lie between samples, and the dilated grid read back there is a
 * bilinear that a wall rises across; this reads the surface under the cutter
 * itself, by the same `walls` rule.
 */
export function toolTipHeightAt(
  hm: Heightmap,
  toolRadiusMm: number,
  tip: boolean | CutterTip,
  body: ToolBodySection[] = [],
  walls: 'samples' | 'middle' | 'clear' = 'middle'
): (xMm: number, yMm: number) => number {
  if (toolRadiusMm <= 0) return (x, y) => sampleHeightmap(hm, x, y);
  const { kx, ky, lift, extraX, extraY, extraLift, at } = toolProbe(hm, toolRadiusMm, tip, body, walls);
  return (xMm, yMm) => {
    const col = hm.stepX ? (xMm - hm.minX) / hm.stepX : 0;
    const row = hm.stepY ? (yMm - hm.minY) / hm.stepY : 0;
    let best = -Infinity;
    for (let dy = -ky; dy <= ky; dy++) {
      for (let dx = -kx; dx <= kx; dx++) {
        const l = lift[(dy + ky) * (2 * kx + 1) + (dx + kx)];
        if (l === -Infinity) continue;
        const candidate = at(col + dx, row + dy) + l;
        if (candidate > best) best = candidate;
      }
    }
    for (let e = 0; e < extraLift.length; e++) {
      const candidate = at(col + extraX[e], row + extraY[e]) + extraLift[e];
      if (candidate > best) best = candidate;
    }
    return best;
  };
}
