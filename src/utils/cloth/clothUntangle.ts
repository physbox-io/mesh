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

export interface UntangleMesh {
  tris: Int32Array;
  /** Each particle's representative after joining sewn particles (stitches): joined particles never cross each other. */
  root: Int32Array;
  /** Unique edges, by particle, and the (up to two) triangles on each. */
  edges: Int32Array;
  edgeTris: Int32Array;
}

/** The mesh as untangling needs it, from every cloth triangle and every stitch. */
export function untangleMesh(n: number, tris: Int32Array, stitches: ArrayLike<number>): UntangleMesh {
  const root = Int32Array.from({ length: n }, (_, i) => i);
  const find = (a: number): number => { while (root[a] !== a) { root[a] = root[root[a]]; a = root[a]; } return a; };
  for (let k = 0; k + 1 < stitches.length; k += 2) { const a = find(stitches[k]), b = find(stitches[k + 1]); if (a !== b) root[a] = b; }
  for (let i = 0; i < n; i++) root[i] = find(i);
  const index = new Map<number, number>(), E: number[] = [], ET: number[] = [];
  for (let t = 0; t < tris.length / 3; t++) for (let k = 0; k < 3; k++) {
    const p = tris[3 * t + k], q = tris[3 * t + (k + 1) % 3], a = Math.min(p, q), b = Math.max(p, q), key = a * n + b;
    let e = index.get(key);
    if (e === undefined) { e = E.length / 2; index.set(key, e); E.push(a, b); ET.push(t, -1); }
    else if (ET[2 * e + 1] < 0) ET[2 * e + 1] = t;
  }
  return { tris, root, edges: Int32Array.from(E), edgeTris: Int32Array.from(ET) };
}

const CELL = 0.02;
/** How near two crossings missing an end are taken to be one contour. */
const LINK_NEAR = 0.015;
const cellKey = (ix: number, iy: number, iz: number) => (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) | 0;

/**
 * Every edge through a triangle it is not joined to, among the triangles in
 * `only` (all when null) and the edges of those triangles.
 */
export function findCrossings(x: ArrayLike<number>, m: UntangleMesh, only: Int32Array | null = null): ClothCrossing[] {
  const T = m.tris, R = m.root, nt = T.length / 3;
  const nList = only ? only.length : nt;
  if (nList === 0) return [];
  const sparse = only !== null && nList * 4 < nt;
  const grid = new Map<number, number[]>();
  // When testing a small local neighbourhood (`only`), pack AABBs into `6 * nList`
  // instead of allocating `6 * nt` across the whole wardrobe on every untangle step.
  const box = new Float64Array(6 * (sparse ? nList : nt));
  const localIdx = sparse ? new Map<number, number>() : null;
  for (let li = 0; li < nList; li++) {
    const t = only ? only[li] : li;
    if (localIdx) localIdx.set(t, li);
    const o = 6 * (sparse ? li : t);
    for (let k = 0; k < 3; k++) {
      const v0 = x[3 * T[3 * t] + k], v1 = x[3 * T[3 * t + 1] + k], v2 = x[3 * T[3 * t + 2] + k];
      box[o + k] = Math.min(v0, v1, v2); box[o + 3 + k] = Math.max(v0, v1, v2);
    }
    for (let ix = Math.floor(box[o] / CELL); ix <= Math.floor(box[o + 3] / CELL); ix++)
      for (let iy = Math.floor(box[o + 1] / CELL); iy <= Math.floor(box[o + 4] / CELL); iy++)
        for (let iz = Math.floor(box[o + 2] / CELL); iz <= Math.floor(box[o + 5] / CELL); iz++) {
          const key = cellKey(ix, iy, iz);
          const c = grid.get(key);
          if (c) c.push(t); else grid.set(key, [t]);
        }
  }
  const out: ClothCrossing[] = [];
  if (sparse) {
    const seenTri = new Map<number, number>();
    for (let e = 0; e < m.edges.length / 2; e++) {
      const t0 = m.edgeTris[2 * e], t1 = m.edgeTris[2 * e + 1];
      if (!localIdx!.has(t0) && !(t1 >= 0 && localIdx!.has(t1))) continue;
      const a = m.edges[2 * e], b = m.edges[2 * e + 1], ra = R[a], rb = R[b];
      const lo0 = Math.min(x[3 * a], x[3 * b]), lo1 = Math.min(x[3 * a + 1], x[3 * b + 1]), lo2 = Math.min(x[3 * a + 2], x[3 * b + 2]);
      const hi0 = Math.max(x[3 * a], x[3 * b]), hi1 = Math.max(x[3 * a + 1], x[3 * b + 1]), hi2 = Math.max(x[3 * a + 2], x[3 * b + 2]);
      for (let ix = Math.floor(lo0 / CELL); ix <= Math.floor(hi0 / CELL); ix++)
        for (let iy = Math.floor(lo1 / CELL); iy <= Math.floor(hi1 / CELL); iy++)
          for (let iz = Math.floor(lo2 / CELL); iz <= Math.floor(hi2 / CELL); iz++) {
            const c = grid.get(cellKey(ix, iy, iz));
            if (!c) continue;
            for (let ci = 0; ci < c.length; ci++) {
              const t = c[ci];
              if (seenTri.get(t) === e) continue;
              seenTri.set(t, e);
              const o = 6 * localIdx!.get(t)!;
              if (hi0 < box[o] || hi1 < box[o + 1] || hi2 < box[o + 2] || lo0 > box[o + 3] || lo1 > box[o + 4] || lo2 > box[o + 5]) continue;
              const i0 = T[3 * t], i1 = T[3 * t + 1], i2 = T[3 * t + 2];
              const r0 = R[i0], r1 = R[i1], r2 = R[i2];
              if (ra === r0 || ra === r1 || ra === r2 || rb === r0 || rb === r1 || rb === r2) continue;
              const hit = segmentTriangle(x, a, b, i0, i1, i2);
              if (hit) out.push({ a, b, e, t, s: hit[0], b1: hit[1], b2: hit[2], p: [x[3 * a] + hit[0] * (x[3 * b] - x[3 * a]), x[3 * a + 1] + hit[0] * (x[3 * b + 1] - x[3 * a + 1]), x[3 * a + 2] + hit[0] * (x[3 * b + 2] - x[3 * a + 2])] });
            }
          }
    }
    return out;
  }
  const inList = only ? new Uint8Array(nt) : null;
  if (inList && only) for (let li = 0; li < only.length; li++) inList[only[li]] = 1;
  const stamp = new Int32Array(nt).fill(-1);
  for (let e = 0; e < m.edges.length / 2; e++) {
    if (inList) {
      const t0 = m.edgeTris[2 * e], t1 = m.edgeTris[2 * e + 1];
      if (!inList[t0] && !(t1 >= 0 && inList[t1])) continue;
    }
    const a = m.edges[2 * e], b = m.edges[2 * e + 1], ra = R[a], rb = R[b];
    const lo0 = Math.min(x[3 * a], x[3 * b]), lo1 = Math.min(x[3 * a + 1], x[3 * b + 1]), lo2 = Math.min(x[3 * a + 2], x[3 * b + 2]);
    const hi0 = Math.max(x[3 * a], x[3 * b]), hi1 = Math.max(x[3 * a + 1], x[3 * b + 1]), hi2 = Math.max(x[3 * a + 2], x[3 * b + 2]);
    for (let ix = Math.floor(lo0 / CELL); ix <= Math.floor(hi0 / CELL); ix++)
      for (let iy = Math.floor(lo1 / CELL); iy <= Math.floor(hi1 / CELL); iy++)
        for (let iz = Math.floor(lo2 / CELL); iz <= Math.floor(hi2 / CELL); iz++) {
          const c = grid.get(cellKey(ix, iy, iz));
          if (!c) continue;
          for (let ci = 0; ci < c.length; ci++) {
            const t = c[ci];
            if (stamp[t] === e) continue;
            stamp[t] = e;
            const o = 6 * t;
            if (hi0 < box[o] || hi1 < box[o + 1] || hi2 < box[o + 2] || lo0 > box[o + 3] || lo1 > box[o + 4] || lo2 > box[o + 5]) continue;
            const i0 = T[3 * t], i1 = T[3 * t + 1], i2 = T[3 * t + 2];
            const r0 = R[i0], r1 = R[i1], r2 = R[i2];
            if (ra === r0 || ra === r1 || ra === r2 || rb === r0 || rb === r1 || rb === r2) continue;
            const hit = segmentTriangle(x, a, b, i0, i1, i2);
            if (hit) out.push({ a, b, e, t, s: hit[0], b1: hit[1], b2: hit[2], p: [x[3 * a] + hit[0] * (x[3 * b] - x[3 * a]), x[3 * a + 1] + hit[0] * (x[3 * b + 1] - x[3 * a + 1]), x[3 * a + 2] + hit[0] * (x[3 * b + 2] - x[3 * a + 2])] });
          }
        }
  }
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
  points.forEach((p, i) => { x[3 * i] = p[0]; x[3 * i + 1] = p[1]; x[3 * i + 2] = p[2]; });
  const T = Int32Array.from(tris), out = new Set<number>();
  for (const c of findCrossings(x, untangleMesh(points.length, T, []))) {
    out.add(c.a); out.add(c.b);
    for (let k = 0; k < 3; k++) out.add(T[3 * c.t + k]);
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
  for (let round = 0; round < 16; round++) {
    let undone = 0;
    for (const v of crossedPoints(points, tris)) if (points[v] !== was[v]) { points[v] = was[v]; undone++; }
    if (!undone) return;
  }
}

/** Segment (a, b) through triangle (i0, i1, i2), strictly inside both: [s along the segment, b1, b2] or null (Moller-Trumbore). */
function segmentTriangle(x: ArrayLike<number>, a: number, b: number, i0: number, i1: number, i2: number): number[] | null {
  const v0x = x[3 * i0], v0y = x[3 * i0 + 1], v0z = x[3 * i0 + 2];
  const e1x = x[3 * i1] - v0x, e1y = x[3 * i1 + 1] - v0y, e1z = x[3 * i1 + 2] - v0z;
  const e2x = x[3 * i2] - v0x, e2y = x[3 * i2 + 1] - v0y, e2z = x[3 * i2 + 2] - v0z;
  const dx = x[3 * b] - x[3 * a], dy = x[3 * b + 1] - x[3 * a + 1], dz = x[3 * b + 2] - x[3 * a + 2];
  const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(det) < 1e-18) return null;
  const inv = 1 / det, sx = x[3 * a] - v0x, sy = x[3 * a + 1] - v0y, sz = x[3 * a + 2] - v0z;
  const u = inv * (sx * hx + sy * hy + sz * hz);
  if (u <= 0 || u >= 1) return null;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = inv * (dx * qx + dy * qy + dz * qz);
  if (v <= 0 || u + v >= 1) return null;
  const s = inv * (e2x * qx + e2y * qy + e2z * qz);
  if (s <= 0 || s >= 1) return null;
  return [s, u, v];
}

function triNormal(x: ArrayLike<number>, T: Int32Array, t: number, out: number[]) {
  const a = 3 * T[3 * t], b = 3 * T[3 * t + 1], c = 3 * T[3 * t + 2];
  const ux = x[b] - x[a], uy = x[b + 1] - x[a + 1], uz = x[b + 2] - x[a + 2];
  const vx = x[c] - x[a], vy = x[c + 1] - x[a + 1], vz = x[c + 2] - x[a + 2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;
  out[0] = nx; out[1] = ny; out[2] = nz;
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
  const T = m.tris, nc = crossings.length;
  // Contours: crossings linked by the triangle pair they share.
  const byPair = new Map<string, number[]>();
  const pairKey = (t1: number, t2: number) => (t1 < t2 ? `${t1},${t2}` : `${t2},${t1}`);
  crossings.forEach((c, i) => {
    for (const ta of [m.edgeTris[2 * c.e], m.edgeTris[2 * c.e + 1]]) {
      if (ta < 0) continue;
      const k = pairKey(ta, c.t);
      const l = byPair.get(k);
      if (l) l.push(i); else byPair.set(k, [i]);
    }
  });
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
