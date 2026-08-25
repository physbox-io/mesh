// ---------------------------------------------------------------------------
// Isosurface extraction (surface nets)
// ---------------------------------------------------------------------------
//
// Turning a scalar field into a triangle mesh is how the organic sculpt bases
// are built: a humanoid is not modelled, it is *described* — a handful of
// tapered capsules blended together — and this is what turns that description
// into something you can push around with a brush.
//
// Marching cubes is the famous way to do this and the wrong one here. It emits
// long slivers wherever the surface crosses a cell diagonally, and a sculpting
// mesh made of slivers has bad normals, bad smoothing and a dynamic-topology
// pass that spends itself repairing the tessellation instead of adding detail.
//
// Surface nets puts a vertex in each cell the surface passes through, placed at
// the average of where the surface cuts that cell's edges, and joins the four
// cells around every crossed grid edge into a quad. The result is dual to the
// grid rather than carved out of it: near-uniform quads, no slivers, and about a
// tenth of the code — there is no 256-case table because there are no cases.
//
// The one place the textbook version is wrong is a cell the surface passes
// through *twice*, which is common the moment a model has thin features near
// each other. One vertex cannot serve two sheets, and the result is a pinch that
// cannot be repaired afterwards. So a cell gets one vertex per connected group
// of its inside corners, which makes those cells expressible and the output
// manifold.
//
// Everything is in the caller's units. The sculpt bases call it in metres.
// ---------------------------------------------------------------------------

/** A signed distance (or any scalar) field. Negative is inside the surface. */
export type ScalarField = (x: number, y: number, z: number) => number;

export interface SurfaceNetsOptions {
  /** The box to sample. The surface must lie strictly inside it. */
  min: [number, number, number];
  max: [number, number, number];
  /** Cells along each axis. Vertex count scales with the square of this. */
  resolution: number;
  /** The level to extract. 0 for a signed distance field. */
  isoLevel?: number;
}

export interface ExtractedSurface {
  /** xyz per vertex. */
  positions: Float32Array;
  /** Three indices per triangle. */
  faces: Uint32Array;
}

/**
 * The eight corners of a cell, indexed so that corner = dx + 2·dy + 4·dz.
 *
 * Every lookup below depends on that packing, which is why it is written once
 * here rather than being open-coded at each use.
 */
const CORNERS: [number, number, number][] = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
];

/** The twelve edges of a cell, as pairs of corner indices. */
const EDGES: [number, number][] = [
  [0, 1], [2, 3], [4, 5], [6, 7], // along x
  [0, 2], [1, 3], [4, 6], [5, 7], // along y
  [0, 4], [1, 5], [2, 6], [3, 7], // along z
];

/**
 * Extracts the surface where `field` crosses `isoLevel`.
 *
 * The surface must not touch the sampling box: a crossing on the boundary has
 * no cell on the far side of it to join to, so it would come out as a hole. The
 * bases all pad their bounds for this reason, and it is worth padding yours.
 */
export function surfaceNets(field: ScalarField, options: SurfaceNetsOptions): ExtractedSurface {
  const iso = options.isoLevel ?? 0;
  const n = Math.max(2, Math.floor(options.resolution));
  const [minX, minY, minZ] = options.min;
  const [maxX, maxY, maxZ] = options.max;

  const stepX = (maxX - minX) / n;
  const stepY = (maxY - minY) / n;
  const stepZ = (maxZ - minZ) / n;

  // --- 1. Sample the field on the grid corners ------------------------------
  const side = n + 1;
  const values = new Float32Array(side * side * side);
  const at = (i: number, j: number, k: number) => values[(k * side + j) * side + i];

  for (let k = 0; k < side; k++) {
    const z = minZ + k * stepZ;
    for (let j = 0; j < side; j++) {
      const y = minY + j * stepY;
      for (let i = 0; i < side; i++) {
        values[(k * side + j) * side + i] = field(minX + i * stepX, y, z) - iso;
      }
    }
  }

  // --- 2. One vertex per connected inside-component of each crossed cell ----
  //
  // The naive version puts one vertex in each crossed cell, which is right
  // almost everywhere and topologically impossible in the cells where the
  // surface passes through twice — between a finger and its neighbour, or where
  // a tail brushes a flank. There the single vertex has to serve two sheets, and
  // what comes out is pinched: an edge with four triangles on it, which no
  // slicer, boolean or CAM job will accept, and which cannot be repaired
  // afterwards without tearing a hole.
  //
  // Splitting the cell's inside corners into connected groups first, and giving
  // each group its own vertex, is what makes those cells expressible. Two
  // groups cannot be adjacent along a cube edge — adjacency is what would have
  // merged them — so each group's vertex is placed from exactly the crossings
  // that belong to it.
  const cellCorners = new Map<number, Int32Array>();
  const positions: number[] = [];
  const corner = new Float32Array(8);
  const componentOf = new Int32Array(8);

  for (let k = 0; k < n; k++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        let negative = 0;
        for (let c = 0; c < 8; c++) {
          const value = at(i + CORNERS[c][0], j + CORNERS[c][1], k + CORNERS[c][2]);
          corner[c] = value;
          if (value < 0) negative++;
        }
        // Entirely inside or entirely outside: no surface here.
        if (negative === 0 || negative === 8) continue;

        // Group the inside corners. Union-find over eight elements is a loop
        // to a fixed point rather than a data structure.
        for (let c = 0; c < 8; c++) componentOf[c] = corner[c] < 0 ? c : -1;
        for (let pass = 0; pass < 3; pass++) {
          for (const [a, b] of EDGES) {
            if (componentOf[a] < 0 || componentOf[b] < 0) continue;
            const low = Math.min(componentOf[a], componentOf[b]);
            componentOf[a] = low;
            componentOf[b] = low;
          }
        }

        const perCorner = new Int32Array(8).fill(-1);
        for (let root = 0; root < 8; root++) {
          if (componentOf[root] !== root) continue;

          // This group's vertex sits at the average of the crossings on the
          // edges that leave it.
          let sumX = 0, sumY = 0, sumZ = 0, crossings = 0;
          for (const [a, b] of EDGES) {
            const aIn = componentOf[a] === root;
            const bIn = componentOf[b] === root;
            if (aIn === bIn) continue;
            const va = corner[a];
            const vb = corner[b];
            const t = va / (va - vb);
            const ca = CORNERS[a];
            const cb = CORNERS[b];
            sumX += ca[0] + (cb[0] - ca[0]) * t;
            sumY += ca[1] + (cb[1] - ca[1]) * t;
            sumZ += ca[2] + (cb[2] - ca[2]) * t;
            crossings++;
          }
          if (crossings === 0) continue;

          const index = positions.length / 3;
          positions.push(
            minX + (i + sumX / crossings) * stepX,
            minY + (j + sumY / crossings) * stepY,
            minZ + (k + sumZ / crossings) * stepZ
          );
          for (let c = 0; c < 8; c++) if (componentOf[c] === root) perCorner[c] = index;
        }

        cellCorners.set((k * n + j) * n + i, perCorner);
      }
    }
  }

  // --- 3. A quad around every crossed grid edge -----------------------------
  // Each interior grid edge that changes sign is surrounded by exactly four
  // cells, and in each of those the quad's corner is the vertex belonging to
  // the group that holds the edge's *inside* end. That last part is what keeps
  // the two sheets of an ambiguous cell apart instead of merging them.
  const faces: number[] = [];

  /**
   * The vertex a cell contributes for a given grid point.
   *
   * `gi/gj/gk` is the grid point in global indices; the cell is identified by
   * its own minimum corner, so the difference is the local corner offset.
   */
  const vertexIn = (ci: number, cj: number, ck: number, gi: number, gj: number, gk: number): number => {
    const perCorner = cellCorners.get((ck * n + cj) * n + ci);
    if (!perCorner) return -1;
    return perCorner[(gi - ci) + 2 * (gj - cj) + 4 * (gk - ck)];
  };

  /**
   * `inside` is whether the *first* corner of the grid edge is inside the
   * surface. It decides the winding: the quad has to face away from the solid,
   * and which of its two orientations does that flips with the direction the
   * field crosses zero along the edge.
   */
  const quad = (a: number, b: number, c: number, d: number, inside: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (inside) faces.push(a, b, c, a, c, d);
    else faces.push(a, c, b, a, d, c);
  };

  for (let k = 0; k < side; k++) {
    for (let j = 0; j < side; j++) {
      for (let i = 0; i < side; i++) {
        const inside = at(i, j, k) < 0;

        // Along x: the four cells sharing this edge are the ones at j-1/j and
        // k-1/k. An edge on the boundary does not have four of them, and is
        // skipped — both because there is no quad to make and because reading
        // cell n would run off the end of the grid. The surface is not allowed
        // to reach the boundary anyway.
        if (i < n && j > 0 && j < n && k > 0 && k < n && inside !== (at(i + 1, j, k) < 0)) {
          // The inside end of the edge is the grid point whose group each cell
          // must contribute.
          const gi = inside ? i : i + 1;
          quad(
            vertexIn(i, j - 1, k - 1, gi, j, k), vertexIn(i, j, k - 1, gi, j, k),
            vertexIn(i, j, k, gi, j, k), vertexIn(i, j - 1, k, gi, j, k),
            inside
          );
        }
        if (j < n && i > 0 && i < n && k > 0 && k < n && inside !== (at(i, j + 1, k) < 0)) {
          const gj = inside ? j : j + 1;
          quad(
            vertexIn(i - 1, j, k - 1, i, gj, k), vertexIn(i - 1, j, k, i, gj, k),
            vertexIn(i, j, k, i, gj, k), vertexIn(i, j, k - 1, i, gj, k),
            inside
          );
        }
        if (k < n && i > 0 && i < n && j > 0 && j < n && inside !== (at(i, j, k + 1) < 0)) {
          const gk = inside ? k : k + 1;
          quad(
            vertexIn(i - 1, j - 1, k, i, j, gk), vertexIn(i, j - 1, k, i, j, gk),
            vertexIn(i, j, k, i, j, gk), vertexIn(i - 1, j, k, i, j, gk),
            inside
          );
        }
      }
    }
  }

  return { positions: Float32Array.from(positions), faces: Uint32Array.from(faces) };
}

// ---------------------------------------------------------------------------
// Fields to extract
// ---------------------------------------------------------------------------

/**
 * One limb: a cone with a rounded cap at each end.
 *
 * A tapered capsule is the right unit for describing a body because it is what
 * a limb *is* — a thick end, a thin end, and roundness at both. Building the
 * same shape out of untapered capsules takes several and still steps at each
 * joint.
 */
export interface Bone {
  /** Start point. */
  a: [number, number, number];
  /** End point. */
  b: [number, number, number];
  /** Radius at `a`. */
  ra: number;
  /** Radius at `b`. */
  rb: number;
}

/**
 * Signed distance to a tapered capsule (a "round cone").
 *
 * The exact form, not the cheap approximation of "distance to the axis minus an
 * interpolated radius" — that one is wrong wherever the taper is steep, and it
 * is wrong in the visible direction: it bulges the thick end and pinches the
 * thin one, which on a limb is exactly the shape you did not ask for.
 *
 * The three cases are the two spherical caps and the conical side between them,
 * chosen by where the point falls relative to the cone's tangent lines.
 */
export function boneDistance(x: number, y: number, z: number, bone: Bone): number {
  const ax = bone.a[0], ay = bone.a[1], az = bone.a[2];
  const bax = bone.b[0] - ax, bay = bone.b[1] - ay, baz = bone.b[2] - az;
  const px = x - ax, py = y - ay, pz = z - az;

  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = bone.ra - bone.rb;
  const a2 = l2 - rr * rr;

  // Degenerate: one end sphere swallows the other, so there is no conical side
  // and the shape is just the larger sphere.
  if (l2 < 1e-18 || a2 <= 1e-18) {
    const da = Math.hypot(px, py, pz) - bone.ra;
    const db = Math.hypot(x - bone.b[0], y - bone.b[1], z - bone.b[2]) - bone.rb;
    return Math.min(da, db);
  }

  const yDot = px * bax + py * bay + pz * baz;
  const zDot = yDot - l2;

  const xpx = px * l2 - bax * yDot;
  const xpy = py * l2 - bay * yDot;
  const xpz = pz * l2 - baz * yDot;
  const x2 = xpx * xpx + xpy * xpy + xpz * xpz;
  const y2 = yDot * yDot * l2;
  const z2 = zDot * zDot * l2;

  const il2 = 1 / l2;
  const k = Math.sign(rr) * rr * rr * x2;

  if (Math.sign(zDot) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - bone.rb;
  if (Math.sign(yDot) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - bone.ra;
  return (Math.sqrt(x2 * a2 * il2) + yDot * rr) * il2 - bone.ra;
}

/**
 * Blends two distances so limbs meet in a fillet rather than a crease.
 *
 * A plain `min` unions two shapes with a sharp seam where they cross, and a
 * seam is exactly where a sculptor does not want to start — the first thing you
 * would do is smooth it out. `k` is how wide the blend is, in the field's units.
 */
export function smoothUnion(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k));
  return b * (1 - h) + a * h - k * h * (1 - h);
}

/** The blended union of a skeleton, as a field ready for `surfaceNets`. */
export function skeletonField(bones: Bone[], blend: number): ScalarField {
  return (x, y, z) => {
    let d = Infinity;
    for (const bone of bones) {
      const bd = boneDistance(x, y, z, bone);
      d = d === Infinity ? bd : smoothUnion(d, bd, blend);
    }
    return d;
  };
}

/** Bounds that comfortably contain a skeleton, padded so nothing touches them. */
export function skeletonBounds(bones: Bone[], blend: number): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  for (const bone of bones) {
    for (const [point, radius] of [[bone.a, bone.ra], [bone.b, bone.rb]] as [number[], number][]) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], point[k] - radius);
        max[k] = Math.max(max[k], point[k] + radius);
      }
    }
  }

  // The blend pushes the surface outward past the bones themselves, and the
  // extraction needs a clear cell beyond that or the surface reaches the
  // boundary and comes out open.
  const pad = blend * 2 + Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) * 0.08;
  for (let k = 0; k < 3; k++) {
    min[k] -= pad;
    max[k] += pad;
  }
  return { min, max };
}
