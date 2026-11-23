/**
 * Untangling cloth that starts through cloth: intersection contour
 * minimisation (Volino and Magnenat-Thalmann, 2006).
 *
 * Where two cloth surfaces cross (two pieces, two layers, or one piece folded
 * through itself) they meet along a contour: each point of it is an edge of
 * one surface through a triangle of the other. Contact cannot undo that, since
 * it keeps each point on the side it is on. Shrinking the contour can: each of
 * its points is moved inward along the contour's own surfaces, by moving the
 * two surfaces along their normals, until the contour closes up and the
 * surfaces no longer cross. Which way is "inward" comes from the whole
 * contour, not from the one edge, so a region that has gone through is
 * brought back as a whole rather than pushed out half each way.
 *
 * Generic: it reads only positions, triangles and what is sewn to what. Any
 * builder that models cloth crossed (a pleat folded through itself, a collar
 * through its stand, a pocket through its panel) is untangled the same way.
 */

/** Cloth through cloth: an edge (a, b) through triangle t, at parameter s along the edge and (b1, b2) in t. */
export interface ClothCrossing { a: number; b: number; e: number; t: number; s: number; b1: number; b2: number; p: number[] }

interface UntangleHash {
  buckets: number;
  mask: number;
  start: Int32Array;
  fill: Int32Array;
  range: Int32Array;
  entries: Int32Array;
  box: Float64Array;
  triStamp: Int32Array;
  triGen: number;
  edgeStamp: Int32Array;
  edgeGen: number;
  activeEdges: Int32Array;
  inList: Uint8Array;
}

export interface UntangleMesh {
  tris: Int32Array;
  /** Each particle's representative after joining sewn particles (stitches): joined particles never cross each other. */
  root: Int32Array;
  /** Unique edges, by particle, and the (up to two) triangles on each. */
  edges: Int32Array;
  edgeTris: Int32Array;
  /** Per triangle, its 3 unique edge indices (3 * nt), for O(|only|) local crossing checks. */
  triEdges?: Int32Array;
  /** Reusable spatial-hash scratch buffers (allocated lazily and reused across calls). */
  _hash?: UntangleHash;
}

const nextPow2 = (v: number) => {
  let p = 1024;
  while (p < v) p <<= 1;
  return p;
};

/** The mesh as untangling needs it, from every cloth triangle and every stitch. */
export function untangleMesh(n: number, tris: Int32Array, stitches: ArrayLike<number>): UntangleMesh {
  const root = Int32Array.from({ length: n }, (_, i) => i);
  const find = (a: number): number => { while (root[a] !== a) { root[a] = root[root[a]]; a = root[a]; } return a; };
  for (let k = 0; k + 1 < stitches.length; k += 2) { const a = find(stitches[k]), b = find(stitches[k + 1]); if (a !== b) root[a] = b; }
  for (let i = 0; i < n; i++) root[i] = find(i);
  const nt = tris.length / 3;
  const index = new Map<number, number>(), E: number[] = [], ET: number[] = [];
  const triEdges = new Int32Array(tris.length);
  for (let t = 0; t < nt; t++) {
    const t3 = 3 * t;
    for (let k = 0; k < 3; k++) {
      const p = tris[t3 + k], q = tris[t3 + (k + 1) % 3], a = p < q ? p : q, b = p < q ? q : p, key = a * n + b;
      let e = index.get(key);
      if (e === undefined) { e = E.length / 2; index.set(key, e); E.push(a, b); ET.push(t, -1); }
      else if (ET[2 * e + 1] < 0) ET[2 * e + 1] = t;
      triEdges[t3 + k] = e;
    }
  }
  return { tris, root, edges: Int32Array.from(E), edgeTris: Int32Array.from(ET), triEdges };
}

const CELL = 0.02;
const INV_CELL = 1 / CELL;
/** How near two crossings missing an end are taken to be one contour. */
const LINK_NEAR = 0.015;
const cellKey = (ix: number, iy: number, iz: number) => (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) | 0;
const bucketHash = (ix: number, iy: number, iz: number, mask: number) => ((Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) >>> 0) & mask;

function ensureHash(m: UntangleMesh): UntangleHash {
  let h = m._hash;
  if (!h) {
    const nt = m.tris.length / 3, ne = m.edges.length / 2;
    const buckets = nextPow2(Math.max(1024, 2 * nt));
    h = {
      buckets,
      mask: buckets - 1,
      start: new Int32Array(buckets + 1),
      fill: new Int32Array(buckets),
      range: new Int32Array(6 * nt),
      entries: new Int32Array(Math.max(1024, 4 * nt)),
      box: new Float64Array(6 * nt),
      triStamp: new Int32Array(nt),
      triGen: 0,
      edgeStamp: new Int32Array(ne),
      edgeGen: 0,
      activeEdges: new Int32Array(ne),
      inList: new Uint8Array(nt),
    };
    m._hash = h;
  }
  return h;
}

const segHit = [0, 0, 0];

/**
 * Every edge through a triangle it is not joined to, among the triangles in
 * `only` (all when null) and the edges of those triangles.
 */
export function findCrossings(x: ArrayLike<number>, m: UntangleMesh, only: Int32Array | null = null): ClothCrossing[] {
  const T = m.tris, R = m.root, E = m.edges, nt = T.length / 3, ne = E.length / 2;
  const nList = only ? only.length : nt;
  if (nList === 0) return [];
  const h = ensureHash(m);
  const { start, fill, range, box, triStamp, mask, buckets } = h;
  start.fill(0);
  let total = 0;
  for (let li = 0; li < nList; li++) {
    const t = only ? only[li] : li;
    const t3 = 3 * t, a3 = 3 * T[t3], b3 = 3 * T[t3 + 1], c3 = 3 * T[t3 + 2], o = 6 * t;
    const x0 = x[a3], x1 = x[b3], x2 = x[c3];
    const loX = x0 < x1 ? (x0 < x2 ? x0 : x2) : (x1 < x2 ? x1 : x2);
    const hiX = x0 > x1 ? (x0 > x2 ? x0 : x2) : (x1 > x2 ? x1 : x2);
    const y0 = x[a3 + 1], y1 = x[b3 + 1], y2 = x[c3 + 1];
    const loY = y0 < y1 ? (y0 < y2 ? y0 : y2) : (y1 < y2 ? y1 : y2);
    const hiY = y0 > y1 ? (y0 > y2 ? y0 : y2) : (y1 > y2 ? y1 : y2);
    const z0 = x[a3 + 2], z1 = x[b3 + 2], z2 = x[c3 + 2];
    const loZ = z0 < z1 ? (z0 < z2 ? z0 : z2) : (z1 < z2 ? z1 : z2);
    const hiZ = z0 > z1 ? (z0 > z2 ? z0 : z2) : (z1 > z2 ? z1 : z2);
    box[o] = loX; box[o + 1] = loY; box[o + 2] = loZ; box[o + 3] = hiX; box[o + 4] = hiY; box[o + 5] = hiZ;
    const ix0 = Math.floor(loX * INV_CELL), ix1 = Math.floor(hiX * INV_CELL);
    const iy0 = Math.floor(loY * INV_CELL), iy1 = Math.floor(hiY * INV_CELL);
    const iz0 = Math.floor(loZ * INV_CELL), iz1 = Math.floor(hiZ * INV_CELL);
    range[o] = ix0; range[o + 1] = iy0; range[o + 2] = iz0; range[o + 3] = ix1; range[o + 4] = iy1; range[o + 5] = iz1;
    for (let ix = ix0; ix <= ix1; ix++)
      for (let iy = iy0; iy <= iy1; iy++)
        for (let iz = iz0; iz <= iz1; iz++) {
          start[bucketHash(ix, iy, iz, mask) + 1]++;
          total++;
        }
  }
  for (let b = 0; b < buckets; b++) start[b + 1] += start[b];
  if (h.entries.length < total) h.entries = new Int32Array(Math.ceil(total * 1.25));
  const entries = h.entries;
  fill.set(start.subarray(0, buckets));
  for (let li = 0; li < nList; li++) {
    const t = only ? only[li] : li, o = 6 * t;
    const ix0 = range[o], iy0 = range[o + 1], iz0 = range[o + 2], ix1 = range[o + 3], iy1 = range[o + 4], iz1 = range[o + 5];
    for (let ix = ix0; ix <= ix1; ix++)
      for (let iy = iy0; iy <= iy1; iy++)
        for (let iz = iz0; iz <= iz1; iz++) {
          entries[fill[bucketHash(ix, iy, iz, mask)]++] = t;
        }
  }

  // Collect only edges touching `only` triangles (O(|only|) when sparse, all edges when null).
  let nEdges = ne;
  const activeEdges = h.activeEdges;
  if (only) {
    const triEdges = m.triEdges;
    if (triEdges) {
      let eg = h.edgeGen + 1;
      if (eg >= 0x7fffffff) { h.edgeStamp.fill(0); eg = 1; }
      h.edgeGen = eg;
      const eStamp = h.edgeStamp;
      nEdges = 0;
      for (let li = 0; li < nList; li++) {
        const t3 = 3 * only[li];
        const e0 = triEdges[t3], e1 = triEdges[t3 + 1], e2 = triEdges[t3 + 2];
        if (eStamp[e0] !== eg) { eStamp[e0] = eg; activeEdges[nEdges++] = e0; }
        if (eStamp[e1] !== eg) { eStamp[e1] = eg; activeEdges[nEdges++] = e1; }
        if (eStamp[e2] !== eg) { eStamp[e2] = eg; activeEdges[nEdges++] = e2; }
      }
    } else {
      const inList = h.inList;
      for (let li = 0; li < nList; li++) inList[only[li]] = 1;
      nEdges = 0;
      for (let e = 0; e < ne; e++) {
        const t0 = m.edgeTris[2 * e], t1 = m.edgeTris[2 * e + 1];
        if (inList[t0] || (t1 >= 0 && inList[t1])) activeEdges[nEdges++] = e;
      }
      for (let li = 0; li < nList; li++) inList[only[li]] = 0;
    }
  }

  const out: ClothCrossing[] = [];
  let gen = h.triGen;
  for (let ei = 0; ei < nEdges; ei++) {
    const e = only ? activeEdges[ei] : ei;
    if (++gen >= 0x7fffffff) { triStamp.fill(0); gen = 1; }
    const a = E[2 * e], b = E[2 * e + 1], ra = R[a], rb = R[b];
    const a3 = 3 * a, b3 = 3 * b;
    const ax = x[a3], ay = x[a3 + 1], az = x[a3 + 2], bx = x[b3], by = x[b3 + 1], bz = x[b3 + 2];
    const lo0 = ax < bx ? ax : bx, hi0 = ax < bx ? bx : ax;
    const lo1 = ay < by ? ay : by, hi1 = ay < by ? by : ay;
    const lo2 = az < bz ? az : bz, hi2 = az < bz ? bz : az;
    const ix0 = Math.floor(lo0 * INV_CELL), ix1 = Math.floor(hi0 * INV_CELL);
    const iy0 = Math.floor(lo1 * INV_CELL), iy1 = Math.floor(hi1 * INV_CELL);
    const iz0 = Math.floor(lo2 * INV_CELL), iz1 = Math.floor(hi2 * INV_CELL);
    for (let ix = ix0; ix <= ix1; ix++)
      for (let iy = iy0; iy <= iy1; iy++)
        for (let iz = iz0; iz <= iz1; iz++) {
          const hb = bucketHash(ix, iy, iz, mask);
          for (let ci = start[hb], cEnd = start[hb + 1]; ci < cEnd; ci++) {
            const t = entries[ci];
            if (triStamp[t] === gen) continue;
            triStamp[t] = gen;
            const o = 6 * t;
            if (hi0 < box[o] || hi1 < box[o + 1] || hi2 < box[o + 2] || lo0 > box[o + 3] || lo1 > box[o + 4] || lo2 > box[o + 5]) continue;
            const i0 = T[3 * t], i1 = T[3 * t + 1], i2 = T[3 * t + 2];
            const r0 = R[i0], r1 = R[i1], r2 = R[i2];
            if (ra === r0 || ra === r1 || ra === r2 || rb === r0 || rb === r1 || rb === r2) continue;
            if (segmentTriangleInto(x, a, b, i0, i1, i2, segHit)) {
              const s = segHit[0];
              out.push({ a, b, e, t, s, b1: segHit[1], b2: segHit[2], p: [ax + s * (bx - ax), ay + s * (by - ay), az + s * (bz - az)] });
            }
          }
        }
  }
  h.triGen = gen;
  return out;
}

/**
 * The points of a surface (`points`, triangles `tris`, any unused points
 * among them) where it passes through itself: both ends of each edge through
 * a triangle, and the triangle's corners. For the mesh operations that move
 * a modelled surface's points, which keep it as uncrossed as it came.
 */
export function crossedPoints(points: number[][], tris: ArrayLike<number>): Set<number> {
  const x = new Float64Array(3 * points.length);
  for (let i = 0; i < points.length; i++) { const p = points[i]; x[3 * i] = p[0]; x[3 * i + 1] = p[1]; x[3 * i + 2] = p[2]; }
  const T = Int32Array.from(tris), out = new Set<number>();
  for (const c of findCrossings(x, untangleMesh(points.length, T, []))) {
    out.add(c.a); out.add(c.b);
    out.add(T[3 * c.t]); out.add(T[3 * c.t + 1]); out.add(T[3 * c.t + 2]);
  }
  return out;
}

/**
 * Points moved from `was` to `points` (same triangles) put back where the
 * move took the surface through itself, until it is through itself nowhere a
 * point moved. Where a surface comes near itself (between the legs at the
 * crotch, under an arm), evening its points out along it, each put back onto
 * the surface it stands for, can take one across the gap: a surface net's
 * points, uncrossed off the grid, came out of its relaxing through each other.
 */
export function undoCrossingMoves(points: number[][], was: number[][], tris: ArrayLike<number>): void {
  const n = points.length;
  const T = Int32Array.from(tris);
  const m = untangleMesh(n, T, []);
  const x = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) { const p = points[i]; x[3 * i] = p[0]; x[3 * i + 1] = p[1]; x[3 * i + 2] = p[2]; }
  const crossed = new Set<number>();
  for (let round = 0; round < 16; round++) {
    crossed.clear();
    const hits = findCrossings(x, m);
    if (!hits.length) return;
    for (let hi = 0; hi < hits.length; hi++) {
      const c = hits[hi];
      crossed.add(c.a); crossed.add(c.b);
      crossed.add(T[3 * c.t]); crossed.add(T[3 * c.t + 1]); crossed.add(T[3 * c.t + 2]);
    }
    let undone = 0;
    for (const v of crossed) {
      if (points[v] !== was[v]) {
        const wv = was[v];
        points[v] = wv;
        x[3 * v] = wv[0]; x[3 * v + 1] = wv[1]; x[3 * v + 2] = wv[2];
        undone++;
      }
    }
    if (!undone) return;
  }
}

/** Segment (a, b) through triangle (i0, i1, i2), strictly inside both: writes [s, b1, b2] into `out` and returns true (Moller-Trumbore). */
function segmentTriangleInto(x: ArrayLike<number>, a: number, b: number, i0: number, i1: number, i2: number, out: number[]): boolean {
  const k0 = 3 * i0, k1 = 3 * i1, k2 = 3 * i2, ka = 3 * a, kb = 3 * b;
  const v0x = x[k0], v0y = x[k0 + 1], v0z = x[k0 + 2];
  const e1x = x[k1] - v0x, e1y = x[k1 + 1] - v0y, e1z = x[k1 + 2] - v0z;
  const e2x = x[k2] - v0x, e2y = x[k2 + 1] - v0y, e2z = x[k2 + 2] - v0z;
  const dx = x[kb] - x[ka], dy = x[kb + 1] - x[ka + 1], dz = x[kb + 2] - x[ka + 2];
  const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(det) < 1e-18) return false;
  const inv = 1 / det, sx = x[ka] - v0x, sy = x[ka + 1] - v0y, sz = x[ka + 2] - v0z;
  const u = inv * (sx * hx + sy * hy + sz * hz);
  if (u <= 0 || u >= 1) return false;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = inv * (dx * qx + dy * qy + dz * qz);
  if (v <= 0 || u + v >= 1) return false;
  const s = inv * (e2x * qx + e2y * qy + e2z * qz);
  if (s <= 0 || s >= 1) return false;
  out[0] = s; out[1] = u; out[2] = v;
  return true;
}

function triNormal(x: ArrayLike<number>, T: Int32Array, t: number, out: number[]) {
  const a = 3 * T[3 * t], b = 3 * T[3 * t + 1], c = 3 * T[3 * t + 2];
  const ux = x[b] - x[a], uy = x[b + 1] - x[a + 1], uz = x[b + 2] - x[a + 2];
  const vx = x[c] - x[a], vy = x[c + 1] - x[a + 1], vz = x[c + 2] - x[a + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  out[0] = nx / l; out[1] = ny / l; out[2] = nz / l;
}

/**
 * One step of contour shrinking: the crossings joined into contours (two
 * crossings sharing a pair of triangles are the two ends of one segment), each
 * point's inward direction from its contour (toward the contour's middle,
 * square to it), and that move made by moving the two surfaces along their
 * normals. Writes displacements of at most `step` into `dx` (per particle,
 * averaged over the contour points that move it); returns how many particles move.
 */
export function contourStep(x: ArrayLike<number>, w: ArrayLike<number>, m: UntangleMesh, crossings: ClothCrossing[], step: number, dx: Float64Array, count: Float64Array): number {
  const T = m.tris, nt = T.length / 3, nc = crossings.length;
  // Contours: crossings linked by the triangle pair they share.
  const byPair = new Map<number, number[]>();
  const pairKey = (t1: number, t2: number) => (t1 < t2 ? t1 * nt + t2 : t2 * nt + t1);
  for (let i = 0; i < nc; i++) {
    const c = crossings[i];
    const ta0 = m.edgeTris[2 * c.e], ta1 = m.edgeTris[2 * c.e + 1];
    if (ta0 >= 0) {
      const k = pairKey(ta0, c.t);
      const l = byPair.get(k);
      if (l) l.push(i); else byPair.set(k, [i]);
    }
    if (ta1 >= 0) {
      const k = pairKey(ta1, c.t);
      const l = byPair.get(k);
      if (l) l.push(i); else byPair.set(k, [i]);
    }
  }
  const link: number[][] = Array.from({ length: nc }, () => []);
  for (const l of byPair.values()) if (l.length === 2) { link[l[0]].push(l[1]); link[l[1]].push(l[0]); }
  // A crossing left with fewer than its two ends (an edge through a corner or
  // along an edge, where the exact test lets one end go) joins the nearest
  // crossings instead, so its contour is not broken in two.
  const pending: number[] = [];
  for (let i = 0; i < nc; i++) if (link[i].length < 2) pending.push(i);
  for (const i of pending) {
    const p = crossings[i].p;
    const near = pending.filter((j) => j !== i && !link[i].includes(j))
      .map((j) => [j, Math.hypot(crossings[j].p[0] - p[0], crossings[j].p[1] - p[1], crossings[j].p[2] - p[2])] as const)
      .filter(([, d]) => d < LINK_NEAR).sort((u, v) => u[1] - v[1]);
    for (const [j] of near.slice(0, 2 - link[i].length)) { link[i].push(j); link[j].push(i); }
  }
  // Components, and each one's middle.
  const comp = new Int32Array(nc).fill(-1);
  const middles: number[][] = [];
  for (let i = 0; i < nc; i++) {
    if (comp[i] >= 0) continue;
    const id = middles.length, q = [i], mid = [0, 0, 0];
    comp[i] = id;
    for (let h = 0; h < q.length; h++) {
      const c = crossings[q[h]];
      mid[0] += c.p[0]; mid[1] += c.p[1]; mid[2] += c.p[2];
      for (const j of link[q[h]]) if (comp[j] < 0) { comp[j] = id; q.push(j); }
    }
    middles.push(mid.map((v) => v / q.length));
  }
  dx.fill(0); count.fill(0);
  const nA = [0, 0, 0], nA2 = [0, 0, 0], nB = [0, 0, 0];
  for (let i = 0; i < nc; i++) {
    const c = crossings[i];
    // The edge's surface: the mean normal of its triangles. The triangle's.
    triNormal(x, T, m.edgeTris[2 * c.e], nA);
    const t2 = m.edgeTris[2 * c.e + 1];
    if (t2 >= 0) { triNormal(x, T, t2, nA2); if (nA[0] * nA2[0] + nA[1] * nA2[1] + nA[2] * nA2[2] < 0) { nA2[0] = -nA2[0]; nA2[1] = -nA2[1]; nA2[2] = -nA2[2]; } nA[0] += nA2[0]; nA[1] += nA2[1]; nA[2] += nA2[2]; }
    let l = Math.hypot(nA[0], nA[1], nA[2]) || 1;
    nA[0] /= l; nA[1] /= l; nA[2] /= l;
    triNormal(x, T, c.t, nB);
    // The contour's direction here, and the inward move square to it.
    let cx = nA[1] * nB[2] - nA[2] * nB[1], cy = nA[2] * nB[0] - nA[0] * nB[2], cz = nA[0] * nB[1] - nA[1] * nB[0];
    const cl = Math.hypot(cx, cy, cz);
    const mid = middles[comp[i]];
    let gx = mid[0] - c.p[0], gy = mid[1] - c.p[1], gz = mid[2] - c.p[2];
    let hA: number, hB: number;
    // Surfaces at a shallow angle need no special case: a small move along
    // their normals moves the contour a long way (by 1 / sin of the angle), and
    // the moves below scale by it. Only surfaces lying in one plane have no
    // contour direction at all. (Parting those along the normal by a full step,
    // with no way to know which side, tangled pleats further.)
    if (cl < 1e-4) continue;
    {
      cx /= cl; cy /= cl; cz /= cl;
      const gc = gx * cx + gy * cy + gz * cz;
      gx -= gc * cx; gy -= gc * cy; gz -= gc * cz;
      l = Math.hypot(gx, gy, gz);
      if (l < 1e-12) continue;
      gx = (gx / l) * step; gy = (gy / l) * step; gz = (gz / l) * step;
      // In each surface, square to the contour.
      const uAx = cy * nA[2] - cz * nA[1], uAy = cz * nA[0] - cx * nA[2], uAz = cx * nA[1] - cy * nA[0];
      const uBx = cy * nB[2] - cz * nB[1], uBy = cz * nB[0] - cx * nB[2], uBz = cx * nB[1] - cy * nB[0];
      // Inward on each surface: the move's part along that surface, square to the contour.
      const ga = gx * uAx + gy * uAy + gz * uAz, gb = gx * uBx + gy * uBy + gz * uBz;
      // Moving the triangle's surface along its normal by h moves the contour across the edge's surface by h / (nB . uA).
      hB = ga * (nB[0] * uAx + nB[1] * uAy + nB[2] * uAz);
      hA = gb * (nA[0] * uBx + nA[1] * uBy + nA[2] * uBz);
      const cap = Math.max(Math.abs(hA), Math.abs(hB));
      if (cap > step) { hA *= step / cap; hB *= step / cap; }
    }
    // Spread over the particles that carry each surface there; what cannot move is made up by the other side.
    const ea = c.a, eb = c.b, t0 = T[3 * c.t], t1 = T[3 * c.t + 1], tt2 = T[3 * c.t + 2];
    const movesA = (w[ea] > 0 ? 1 - c.s : 0) + (w[eb] > 0 ? c.s : 0);
    const b0 = 1 - c.b1 - c.b2;
    const movesB = (w[t0] > 0 ? b0 : 0) + (w[t1] > 0 ? c.b1 : 0) + (w[tt2] > 0 ? c.b2 : 0);
    if (movesA <= 0 && movesB <= 0) continue;
    if (movesA <= 0) { hB -= hA; hA = 0; } else if (movesB <= 0) { hA -= hB; hB = 0; }
    const put = (v: number, wt: number, h: number, n: number[]) => {
      if (!(w[v] > 0) || wt <= 0) return;
      dx[3 * v] += wt * h * n[0]; dx[3 * v + 1] += wt * h * n[1]; dx[3 * v + 2] += wt * h * n[2]; count[v] += wt;
    };
    if (hA) { put(ea, 1 - c.s, hA, nA); put(eb, c.s, hA, nA); }
    if (hB) { put(t0, b0, hB, nB); put(t1, c.b1, hB, nB); put(tt2, c.b2, hB, nB); }
  }
  let moved = 0;
  for (let v = 0; v < count.length; v++) if (count[v] > 0) { dx[3 * v] /= count[v]; dx[3 * v + 1] /= count[v]; dx[3 * v + 2] /= count[v]; moved++; }
  return moved;
}

/** The triangles within `reach` of any crossing (by box), for re-testing only near them. */
export function trianglesNear(x: ArrayLike<number>, m: UntangleMesh, crossings: ClothCrossing[], reach: number): Int32Array {
  const T = m.tris, nt = T.length / 3, near: number[] = [];
  const pts = crossings.map((c) => c.p);
  const grid = new Map<number, number[][]>();
  for (const p of pts) {
    const key = cellKey(Math.floor(p[0] / reach), Math.floor(p[1] / reach), Math.floor(p[2] / reach));
    const l = grid.get(key);
    if (l) l.push(p); else grid.set(key, [p]);
  }
  for (let t = 0; t < nt; t++) {
    const a = 3 * T[3 * t];
    const ix = Math.floor(x[a] / reach), iy = Math.floor(x[a + 1] / reach), iz = Math.floor(x[a + 2] / reach);
    let hit = false;
    for (let dx = -1; dx <= 1 && !hit; dx++) for (let dy = -1; dy <= 1 && !hit; dy++) for (let dz = -1; dz <= 1 && !hit; dz++) if (grid.has(cellKey(ix + dx, iy + dy, iz + dz))) hit = true;
    if (hit) near.push(t);
  }
  return Int32Array.from(near);
}
