// ---------------------------------------------------------------------------
// A simulated part as a closed mesh
// ---------------------------------------------------------------------------
//
// The milling simulation leaves a grid of heights. This turns that into the
// solid it describes: a top surface over every cell that still holds material,
// a bottom surface under it, and a wall down every edge where material stops,
// whether that is the outside of the stock or a hole cut through it.
//
// The grid's nodes are the cells' centres, and the outermost ones are pulled
// out to the stock's own edges, so the solid comes out the size of the stock.
// A quad between four nodes is solid when all four are.
//
// A board is millions of cells and most of them are flat: the background, the
// floor of a pocket, the stock's face, and the whole of the bottom. So the
// quads are merged into blocks, by quadtree, wherever the surface across a
// block is within `toleranceMm` of a plane through its corners. A merged block
// is drawn as a fan from its centre to every node on its boundary that a
// neighbour uses, which keeps the surface closed where a big block meets small
// ones. If the result is still over the triangle budget the tolerance is
// relaxed and the mesh rebuilt, so a heavily detailed carve loses its finest
// scallops before it loses its shape.
//
// Winding follows the geometry (see CLAUDE.md on face winding): the top is
// wound counter-clockwise seen from above, the bottom clockwise, and each wall
// so the solid is on its left walking the edge seen from above.

export interface HeightGrid {
  cols: number;
  rows: number;
  /** Cell size, mm. */
  cell: number;
  /** Work coordinates of the grid's low corner. */
  originX: number;
  originY: number;
  /** Stock size, mm: the outermost nodes are moved out to it. */
  widthMm: number;
  depthMm: number;
  /** Top of the material in each cell, Z up, row-major from the low-Y row. */
  top: ArrayLike<number>;
  /** Bottom of the material: one level for the whole stock, or one per cell. */
  bottom: number | ArrayLike<number>;
}

export interface SimulationMeshOptions {
  /** Starting merge tolerance, mm. Default 0.005. */
  toleranceMm?: number;
  /** Most triangles to emit; the tolerance is relaxed to get under it. Default 200 000, which is as large as `analyzeMesh` will check. */
  maxTriangles?: number;
}

export interface SimulationMesh {
  /** x, y, z per vertex, mm, in the grid's work coordinates, Z up. */
  positions: Float32Array;
  faces: Uint32Array;
  /** The merge tolerance the mesh was built at, mm. */
  toleranceMm: number;
  /** Enclosed volume, mm³. */
  volumeMm3: number;
}

/** Material thinner than this is no material. */
const MIN_THICKNESS = 1e-3;

export function buildSimulationMesh(grid: HeightGrid, opts: SimulationMeshOptions = {}): SimulationMesh {
  const maxTriangles = opts.maxTriangles ?? 200_000;
  let tol = Math.max(1e-6, opts.toleranceMm ?? 0.005);
  for (;;) {
    const mesh = buildAt(grid, tol, tol > 2 ? Infinity : maxTriangles);
    if (mesh && (mesh.faces.length / 3 <= maxTriangles || tol > 2)) return mesh;
    tol *= 2.5;
  }
}

function buildAt(grid: HeightGrid, tol: number, maxTriangles: number): SimulationMesh | null {
  const { cols, rows, top } = grid;
  const n = cols * rows;
  const flatBottom = typeof grid.bottom === 'number' ? grid.bottom : null;
  const bottomArr = typeof grid.bottom === 'number' ? null : grid.bottom;
  const bot = (k: number) => (flatBottom !== null ? flatBottom : bottomArr![k]);
  const topAt = (k: number) => Math.max(top[k], bot(k));

  // Node positions: cell centres, the outer ring at the stock's edge.
  const xs = new Float64Array(cols);
  const ys = new Float64Array(rows);
  for (let i = 0; i < cols; i++) xs[i] = grid.originX + (i + 0.5) * grid.cell;
  for (let j = 0; j < rows; j++) ys[j] = grid.originY + (j + 0.5) * grid.cell;
  xs[0] = grid.originX;
  ys[0] = grid.originY;
  if (cols > 1) xs[cols - 1] = grid.originX + grid.widthMm;
  if (rows > 1) ys[rows - 1] = grid.originY + grid.depthMm;

  const solidNode = new Uint8Array(n);
  for (let k = 0; k < n; k++) solidNode[k] = top[k] - bot(k) > MIN_THICKNESS ? 1 : 0;

  // Two solid quads that touch only at a corner would hang four walls on one
  // vertical edge there, and the mesh would not be a manifold. Material that
  // meets at a single node is not really joined at this resolution, so the
  // node goes, until no such corner is left.
  const quadAt = (i: number, j: number) => {
    const k = j * cols + i;
    return solidNode[k] & solidNode[k + 1] & solidNode[k + cols] & solidNode[k + cols + 1];
  };
  for (let changed = true; changed;) {
    changed = false;
    for (let j = 1; j < rows - 1; j++) {
      for (let i = 1; i < cols - 1; i++) {
        const k = j * cols + i;
        if (!solidNode[k]) continue;
        const sw = quadAt(i - 1, j - 1), se = quadAt(i, j - 1), nw = quadAt(i - 1, j), ne = quadAt(i, j);
        if ((sw && ne && !se && !nw) || (se && nw && !sw && !ne)) {
          solidNode[k] = 0;
          changed = true;
        }
      }
    }
  }

  // Quads between nodes; a summed-area table of the empty ones answers "is this
  // block all solid / all empty" in constant time.
  const qc = cols - 1, qr = rows - 1;
  const empty = new Int32Array((qc + 1) * (qr + 1));
  for (let j = 0; j < qr; j++) {
    let run = 0;
    for (let i = 0; i < qc; i++) {
      const k = j * cols + i;
      const solid = solidNode[k] & solidNode[k + 1] & solidNode[k + cols] & solidNode[k + cols + 1];
      run += solid ? 0 : 1;
      empty[(j + 1) * (qc + 1) + i + 1] = empty[j * (qc + 1) + i + 1] + run;
    }
  }
  const emptyIn = (i0: number, j0: number, w: number, hgt: number) =>
    empty[(j0 + hgt) * (qc + 1) + i0 + w] - empty[j0 * (qc + 1) + i0 + w] -
    empty[(j0 + hgt) * (qc + 1) + i0] + empty[j0 * (qc + 1) + i0];
  const quadSolid = (i: number, j: number) => i >= 0 && j >= 0 && i < qc && j < qr && emptyIn(i, j, 1, 1) === 0;

  /** Whether `get` over the block's nodes is within tol of the bilinear through its corners. */
  const planar = (get: (k: number) => number, i0: number, j0: number, w: number, hgt: number): boolean => {
    const a = get(j0 * cols + i0), b = get(j0 * cols + i0 + w);
    const c = get((j0 + hgt) * cols + i0), d = get((j0 + hgt) * cols + i0 + w);
    // Bilinear across a non-planar quad bows; a fan of flat triangles cannot follow it.
    if (Math.abs(a + d - b - c) > tol) return false;
    for (let j = 0; j <= hgt; j++) {
      const v = j / hgt;
      const row = (j0 + j) * cols + i0;
      const left = a + (c - a) * v, right = b + (d - b) * v;
      for (let i = 0; i <= w; i++) {
        const want = left + (right - left) * (i / w);
        if (Math.abs(get(row + i) - want) > tol) return false;
      }
    }
    return true;
  };

  // --- Blocks ---------------------------------------------------------------
  // The top and the bottom meet only at the walls, so each is merged on its
  // own: a carved top and a flat bottom do not share one subdivision.
  // [i0, j0, w, h] of every solid leaf.
  const blocks = (get: ((k: number) => number) | null): number[] => {
    const leaves: number[] = [];
    const split = (i0: number, j0: number, w: number, hgt: number) => {
      const holes = emptyIn(i0, j0, w, hgt);
      if (holes === w * hgt) return;
      if (w === 1 && hgt === 1) { leaves.push(i0, j0, 1, 1); return; }
      if (holes === 0 && (get === null || planar(get, i0, j0, w, hgt))) {
        leaves.push(i0, j0, w, hgt);
        return;
      }
      const w1 = w > 1 ? w >> 1 : w, h1 = hgt > 1 ? hgt >> 1 : hgt;
      split(i0, j0, w1, h1);
      if (w > 1) split(i0 + w1, j0, w - w1, h1);
      if (hgt > 1) split(i0, j0 + h1, w1, hgt - h1);
      if (w > 1 && hgt > 1) split(i0 + w1, j0 + h1, w - w1, hgt - h1);
    };
    if (qc > 0 && qr > 0) split(0, 0, qc, qr);
    return leaves;
  };
  const topLeaves = blocks(topAt);
  // At least two triangles a leaf: past the budget already, so do not build it.
  if (topLeaves.length / 2 > maxTriangles) return null;
  const botLeaves = blocks(flatBottom !== null ? null : bot);

  // Every node a leaf corner or a wall stands on is a vertex, and every block
  // takes in the vertices along its sides so the seams close.
  const usedTop = new Uint8Array(n);
  const usedBot = new Uint8Array(n);
  const markCorners = (leaves: number[], used: Uint8Array) => {
    for (let q = 0; q < leaves.length; q += 4) {
      const i0 = leaves[q], j0 = leaves[q + 1], w = leaves[q + 2], hgt = leaves[q + 3];
      used[j0 * cols + i0] = used[j0 * cols + i0 + w] = 1;
      used[(j0 + hgt) * cols + i0] = used[(j0 + hgt) * cols + i0 + w] = 1;
    }
  };
  markCorners(topLeaves, usedTop);
  markCorners(botLeaves, usedBot);

  const positions: number[] = [];
  const faces: number[] = [];
  const topIdx = new Int32Array(n).fill(-1);
  const botIdx = new Int32Array(n).fill(-1);
  const vertex = (x: number, y: number, z: number) => {
    positions.push(x, y, z);
    return positions.length / 3 - 1;
  };
  const topV = (k: number) => {
    if (topIdx[k] < 0) topIdx[k] = vertex(xs[k % cols], ys[(k / cols) | 0], topAt(k));
    return topIdx[k];
  };
  const botV = (k: number) => {
    if (botIdx[k] < 0) botIdx[k] = vertex(xs[k % cols], ys[(k / cols) | 0], bot(k));
    return botIdx[k];
  };

  // --- Walls ----------------------------------------------------------------
  // Each walked with the solid on its left, seen from above.
  const wall = (ka: number, kb: number) => {
    const ta = topV(ka), tb = topV(kb), ba = botV(ka), bb = botV(kb);
    faces.push(ta, ba, bb, ta, bb, tb);
    usedTop[ka] = usedTop[kb] = usedBot[ka] = usedBot[kb] = 1;
  };
  /*
   * A straight run of wall is one quad as far as its top and bottom edges stay
   * straight, over nodes neither surface needs. A node either surface does
   * use ends the quad there, or the surface's edge would be split where the
   * wall's is not, and the mesh would open along the seam.
   */
  const run: number[] = [];
  const straight = (get: (k: number) => number, from: number, to: number) => {
    const a = get(run[from]), b = get(run[to]);
    for (let t = from + 1; t < to; t++) {
      if (Math.abs(get(run[t]) - (a + ((b - a) * (t - from)) / (to - from))) > tol) return false;
    }
    return true;
  };
  /** Emits the wall along `run`, nodes in increasing order; `reverse` walks it back. */
  const emitRun = (reverse: boolean) => {
    let from = 0;
    while (from < run.length - 1) {
      let to = from + 1;
      while (
        to < run.length - 1 &&
        !usedTop[run[to]] && !usedBot[run[to]] &&
        straight(topAt, from, to + 1) && straight(bot, from, to + 1)
      ) to++;
      if (reverse) wall(run[to], run[from]);
      else wall(run[from], run[to]);
      from = to;
    }
    run.length = 0;
  };
  // Walls facing -Y (solid above) run +X; facing +Y, -X.
  for (const below of [true, false]) {
    for (let j = 0; j < qr; j++) {
      for (let i = 0; i <= qc; i++) {
        const isWall = i < qc && quadSolid(i, j) && !quadSolid(i, below ? j - 1 : j + 1);
        const k = (below ? j : j + 1) * cols + i;
        if (isWall) {
          if (run.length === 0) run.push(k);
          run.push(k + 1);
        } else if (run.length) emitRun(!below);
      }
    }
  }
  // Walls facing +X (solid to the left) run +Y; facing -X, -Y.
  for (const right of [true, false]) {
    for (let i = 0; i < qc; i++) {
      for (let j = 0; j <= qr; j++) {
        const isWall = j < qr && quadSolid(i, j) && !quadSolid(right ? i + 1 : i - 1, j);
        const k = j * cols + (right ? i + 1 : i);
        if (isWall) {
          if (run.length === 0) run.push(k);
          run.push(k + cols);
        } else if (run.length) emitRun(!right);
      }
    }
  }

  // --- Top and bottom -------------------------------------------------------
  const ring: number[] = [];
  const surface = (leaves: number[], used: Uint8Array, get: (k: number) => number, v: (k: number) => number, up: boolean) => {
    const tri = (a: number, b: number, c: number) => (up ? faces.push(a, b, c) : faces.push(a, c, b));
    for (let q = 0; q < leaves.length; q += 4) {
      const i0 = leaves[q], j0 = leaves[q + 1], w = leaves[q + 2], hgt = leaves[q + 3];
      const k00 = j0 * cols + i0;
      if (w === 1 && hgt === 1) {
        const a = k00, b = k00 + 1, c = k00 + cols + 1, d = k00 + cols;
        tri(v(a), v(b), v(c));
        tri(v(a), v(c), v(d));
        continue;
      }
      // Counter-clockwise round the block, seen from above.
      ring.length = 0;
      for (let i = 0; i < w; i++) if (used[k00 + i]) ring.push(k00 + i);
      for (let j = 0; j < hgt; j++) { const k = (j0 + j) * cols + i0 + w; if (used[k]) ring.push(k); }
      for (let i = w; i > 0; i--) { const k = (j0 + hgt) * cols + i0 + i; if (used[k]) ring.push(k); }
      for (let j = hgt; j > 0; j--) { const k = (j0 + j) * cols + i0; if (used[k]) ring.push(k); }
      const k10 = k00 + w, k01 = k00 + hgt * cols, k11 = k01 + w;
      const centre = vertex(
        (xs[i0] + xs[i0 + w]) / 2,
        (ys[j0] + ys[j0 + hgt]) / 2,
        (get(k00) + get(k10) + get(k01) + get(k11)) / 4
      );
      for (let r = 0; r < ring.length; r++) tri(centre, v(ring[r]), v(ring[(r + 1) % ring.length]));
    }
  };
  surface(topLeaves, usedTop, topAt, topV, true);
  surface(botLeaves, usedBot, bot, botV, false);

  const pos = new Float32Array(positions);
  const tri = new Uint32Array(faces);
  return { positions: pos, faces: tri, toleranceMm: tol, volumeMm3: enclosedVolume(pos, tri) };
}

/** Volume enclosed by a closed, outward-wound mesh. */
export function enclosedVolume(positions: ArrayLike<number>, faces: ArrayLike<number>): number {
  let v = 0;
  for (let t = 0; t < faces.length; t += 3) {
    const a = faces[t] * 3, b = faces[t + 1] * 3, c = faces[t + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}
