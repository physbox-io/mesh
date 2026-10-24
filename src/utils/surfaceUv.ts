// ---------------------------------------------------------------------------
// Laying a curved region of a mesh out flat, for a surface pattern.
//
// A planar projection is exact on a flat face and stretches a pattern by
// 1/cos(slope) everywhere else: +41 % on a 45° wall, smeared to nothing near
// vertical. These are the two maps surfaceTexture.ts uses instead:
//
// - a cylinder's side unrolls exactly, as arc length round the axis and
//   height along it (fitCylinder);
// - anything else is unwrapped by a least-squares conformal map, which keeps
//   the pattern's cells square at the cost of letting their size drift
//   (lscm). It needs the region to be a disc, so a region with more than one
//   edge -- a tube, or a face with a hole in it -- is cut open first
//   (cutToDisc).
//
// Pure: positions and faces in, coordinates out. Nothing here knows about
// patterns.
// ---------------------------------------------------------------------------

import { fitCircle, planeBasis, smallestEigenvector, type Vec3 } from './measureSnap';

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 => {
  const l = len(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
const vtx = (pos: ArrayLike<number>, i: number): Vec3 => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];

// --- cylinders -----------------------------------------------------------------

export interface CylinderFit {
  axis: Vec3;
  /** A point on the axis. */
  centre: Vec3;
  radius: number;
  /** The worst any facet's normal leans along the axis, degrees. 0 on a true cylinder. */
  leanDeg: number;
  /** RMS distance of the points from the fitted surface, as a fraction of the radius. */
  error: number;
  /** The normals point away from the axis: the outside of a rod rather than the inside of a pipe. */
  outward: boolean;
}

/**
 * The cylinder a region lies on, if it lies on one. The axis is the direction
 * every facet normal is most nearly perpendicular to -- the smallest
 * eigenvector of the area-weighted sum of n nᵀ -- and the circle is fitted to
 * the points seen down it.
 */
export function fitCylinder(points: Vec3[], centroids: Vec3[], normals: Vec3[], areas: number[]): CylinderFit | null {
  if (points.length < 4 || normals.length < 2) return null;
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let f = 0; f < normals.length; f++) {
    const n = normals[f], w = areas[f] ?? 1;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] += w * n[i] * n[j];
  }
  const axis = norm(smallestEigenvector(m));
  if (len(axis) < 0.5) return null;
  let lean = 0;
  for (const n of normals) lean = Math.max(lean, Math.abs(dot(n, axis)));

  const down = (p: Vec3): Vec3 => {
    const t = dot(p, axis);
    return [p[0] - axis[0] * t, p[1] - axis[1] * t, p[2] - axis[2] * t];
  };
  const circle = fitCircle(points.map(down));
  if (!circle || !(circle.radius > 0)) return null;

  // Facets facing away from the axis are the outside of a rod; facing it, the inside of a pipe.
  let out = 0;
  normals.forEach((n, f) => { out += (areas[f] ?? 1) * dot(sub(down(centroids[f]), circle.centre), n); });
  return {
    axis,
    centre: circle.centre,
    radius: circle.radius,
    leanDeg: (Math.asin(Math.min(1, lean)) * 180) / Math.PI,
    error: circle.error,
    outward: out >= 0,
  };
}

/**
 * Angle round the axis, radians, measured anticlockwise looking down +axis
 * from a fixed reference direction.
 */
export function cylinderAngle(fit: CylinderFit, ref: Vec3, p: Vec3): number {
  const side = cross(fit.axis, ref);
  const d = sub(p, fit.centre);
  return Math.atan2(dot(d, side), dot(d, ref));
}

/** A reference direction square to the axis, for cylinderAngle. */
export function cylinderReference(fit: CylinderFit): Vec3 {
  return planeBasis(fit.axis).u;
}

// --- surfaces of revolution -----------------------------------------------------

export interface RevolutionFit {
  axis: Vec3;
  /** A point on the axis. */
  centre: Vec3;
  /** Area-weighted RMS of the facet normals' component round the axis (sin of the angle). */
  error: number;
  /** The normals point away from the axis. */
  outward: boolean;
}

/** Eigenvalues (ascending) and eigenvectors (columns, same order) of a symmetric matrix. */
function symmetricEigen(m: number[][]): { values: number[]; vectors: number[][] } {
  const n = m.length;
  const a = m.map((row) => [...row]);
  const v = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j): number => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 64; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-26) break;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[i][i] - a[j][j]);
  return { values: order.map((i) => a[i][i]), vectors: order.map((i) => v.map((row) => row[i])) };
}

/**
 * The axis a surface of revolution turns about -- a vase, a bulb, a cone, as
 * well as a cylinder -- if the region lies on one.
 *
 * On such a surface every facet normal lies in a plane through the axis, so
 * it has no component round it: n · (a × (p − c)) = 0. With b = c × a that is
 * a · (p × n) + n · b = 0, linear in the axis's Plücker coordinates (a, b),
 * and the axis is the smallest eigenvector of the area-weighted sum of
 * q qᵀ, q = (p × n, n). Null when there is no such axis (a free-form shape) or
 * more than one (a sphere turns about any line through its centre, and a
 * plane about any normal).
 */
export function fitRevolution(centroids: Vec3[], normals: Vec3[], areas: number[]): RevolutionFit | null {
  if (normals.length < 8) return null;
  // Centred and scaled, so p × n and n weigh alike.
  let W = 0;
  const mid: Vec3 = [0, 0, 0];
  centroids.forEach((p, f) => { const w = areas[f] ?? 1; W += w; for (let k = 0; k < 3; k++) mid[k] += w * p[k]; });
  if (!(W > 0)) return null;
  for (let k = 0; k < 3; k++) mid[k] /= W;
  let L = 0;
  for (const p of centroids) L = Math.max(L, len(sub(p, mid)));
  if (!(L > 0)) return null;

  const m = Array.from({ length: 6 }, () => [0, 0, 0, 0, 0, 0]);
  centroids.forEach((p0, f) => {
    const p: Vec3 = [(p0[0] - mid[0]) / L, (p0[1] - mid[1]) / L, (p0[2] - mid[2]) / L];
    const n = normals[f];
    const q = [...cross(p, n), ...n];
    const w = areas[f] ?? 1;
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) m[i][j] += w * q[i] * q[j];
  });
  const { values, vectors } = symmetricEigen(m);
  // A second solution as good as the first: no single axis.
  if (values[1] < 1e-4 * W) return null;
  const e = vectors[0];
  let axis: Vec3 = [e[0], e[1], e[2]];
  const al = len(axis);
  if (al < 0.3) return null;
  axis = [axis[0] / al, axis[1] / al, axis[2] / al];
  const b: Vec3 = [e[3] / al, e[4] / al, e[5] / al];
  const c = cross(axis, b);
  const centre: Vec3 = [mid[0] + L * c[0], mid[1] + L * c[1], mid[2] + L * c[2]];

  let err = 0, out = 0;
  centroids.forEach((p, f) => {
    const w = areas[f] ?? 1;
    const d = sub(p, centre);
    const radial = sub(d, [axis[0] * dot(d, axis), axis[1] * dot(d, axis), axis[2] * dot(d, axis)]);
    const round = norm(cross(axis, d));
    err += w * dot(normals[f], round) ** 2;
    out += w * dot(radial, normals[f]);
  });
  return { axis, centre, error: Math.sqrt(err / W), outward: out >= 0 };
}

// --- cutting a region open -------------------------------------------------------

export interface DiscRegion {
  /** Each corner of each face, as an index into `source`. */
  faces: number[];
  /** The original vertex each disc vertex is a copy of. */
  source: number[];
  /** Edges of the cut, as pairs of original vertex indices. */
  seam: [number, number][];
  /** False when the region has no edge at all (a closed surface), which no cut here can flatten. */
  ok: boolean;
}

/**
 * The region as a disc: if it has more than one edge loop, it is cut along the
 * cheapest path joining each extra loop to the first, and the vertices on that
 * path are split in two, one copy for each side. `avoid` is the point the
 * user picked: paths near it cost more, so the cut goes round the back.
 */
export function cutToDisc(pos: ArrayLike<number>, faces: number[], avoid: Vec3): DiscRegion {
  const fc = faces.length / 3;
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  const edgeFaces = new Map<string, number[]>();
  for (let f = 0; f < fc; f++) {
    for (let k = 0; k < 3; k++) {
      const e = key(faces[3 * f + k], faces[3 * f + ((k + 1) % 3)]);
      const list = edgeFaces.get(e);
      if (list) list.push(f); else edgeFaces.set(e, [f]);
    }
  }

  // The region's edge loops, by joining boundary edges that share a vertex.
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let y = x;
    while (parent.get(y) !== r) { const n = parent.get(y)!; parent.set(y, r); y = n; }
    return r;
  };
  const boundaryVerts = new Set<number>();
  for (const [e, list] of edgeFaces) {
    if (list.length !== 1) continue;
    const [a, b] = e.split(',').map(Number);
    for (const v of [a, b]) if (!parent.has(v)) { parent.set(v, v); boundaryVerts.add(v); }
    parent.set(find(a), find(b));
  }
  const loops = new Map<number, number[]>();
  for (const v of boundaryVerts) {
    const r = find(v);
    const list = loops.get(r);
    if (list) list.push(v); else loops.set(r, [v]);
  }
  const identity = { faces: faces.slice(), source: [] as number[], seam: [] as [number, number][], ok: true };
  if (loops.size === 0) return { ...identity, ok: false };

  const cut = new Set<string>();
  const seam: [number, number][] = [];
  if (loops.size > 1) {
    // Vertex adjacency over the region's edges.
    const adj = new Map<number, number[]>();
    for (const e of edgeFaces.keys()) {
      const [a, b] = e.split(',').map(Number);
      (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
      (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
    }
    let reach = 0;
    for (const v of adj.keys()) reach = Math.max(reach, len(sub(vtx(pos, v), avoid)));
    reach = reach || 1;
    const cost = (a: number, b: number) => {
      const pa = vtx(pos, a), pb = vtx(pos, b);
      const mid: Vec3 = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
      const near = Math.max(0, 1 - len(sub(mid, avoid)) / reach);
      return len(sub(pa, pb)) * (1 + 8 * near * near);
    };

    const [first, ...rest] = [...loops.values()];
    const reached = new Set<number>(first);
    for (const loop of rest) {
      // Dijkstra from this loop to anything already joined up.
      const dist = new Map<number, number>();
      const prev = new Map<number, number>();
      const heap: [number, number][] = [];
      const push = (d: number, v: number) => {
        heap.push([d, v]);
        let i = heap.length - 1;
        while (i > 0) {
          const p = (i - 1) >> 1;
          if (heap[p][0] <= heap[i][0]) break;
          [heap[p], heap[i]] = [heap[i], heap[p]];
          i = p;
        }
      };
      const pop = (): [number, number] => {
        const top = heap[0];
        const last = heap.pop()!;
        if (heap.length) {
          heap[0] = last;
          let i = 0;
          for (;;) {
            const l = 2 * i + 1, r = l + 1;
            let m = i;
            if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
            if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
            if (m === i) break;
            [heap[m], heap[i]] = [heap[i], heap[m]];
            i = m;
          }
        }
        return top;
      };
      for (const v of loop) { dist.set(v, 0); push(0, v); }
      let end = -1;
      while (heap.length) {
        const [d, v] = pop();
        if (d > (dist.get(v) ?? Infinity)) continue;
        if (reached.has(v)) { end = v; break; }
        for (const w of adj.get(v) ?? []) {
          const nd = d + cost(v, w);
          if (nd < (dist.get(w) ?? Infinity)) { dist.set(w, nd); prev.set(w, v); push(nd, w); }
        }
      }
      if (end < 0) continue;
      for (let v = end; prev.has(v); v = prev.get(v)!) {
        const u = prev.get(v)!;
        cut.add(key(u, v));
        seam.push([u, v]);
        reached.add(u);
        reached.add(v);
      }
      for (const v of loop) reached.add(v);
    }
  }

  // Split every vertex into one copy per fan of faces still joined round it
  // once the cut edges are taken away. Untouched vertices keep one copy.
  const incident = new Map<number, number[]>();
  for (let f = 0; f < fc; f++) for (let k = 0; k < 3; k++) {
    const v = faces[3 * f + k];
    (incident.get(v) ?? incident.set(v, []).get(v)!).push(f);
  }
  const outFaces = new Array<number>(faces.length);
  const source: number[] = [];
  for (const [v, fans] of incident) {
    const group = new Map<number, number>(fans.map((f) => [f, f]));
    const root = (f: number): number => {
      let r = f;
      while (group.get(r) !== r) r = group.get(r)!;
      return r;
    };
    for (const f of fans) {
      for (let k = 0; k < 3; k++) {
        const a = faces[3 * f + k], b = faces[3 * f + ((k + 1) % 3)];
        if (a !== v && b !== v) continue;
        const e = key(a, b);
        if (cut.has(e)) continue;
        const list = edgeFaces.get(e)!;
        if (list.length !== 2) continue;
        group.set(root(list[0]), root(list[1]));
      }
    }
    const ids = new Map<number, number>();
    for (const f of fans) {
      const r = root(f);
      let id = ids.get(r);
      if (id === undefined) { id = source.length; source.push(v); ids.set(r, id); }
      for (let k = 0; k < 3; k++) if (faces[3 * f + k] === v) outFaces[3 * f + k] = id;
    }
  }
  return { faces: outFaces, source, seam, ok: true };
}

// --- the conformal map ----------------------------------------------------------

/**
 * A least-squares conformal map (Lévy et al. 2002) of a disc-shaped mesh:
 * flat coordinates that keep every triangle as near its own shape as one map
 * can, so a pattern's square cells stay square. Two vertices are pinned at
 * the coordinates given, which fixes where the map sits, which way it turns
 * and how big it is; `guess` starts the solve (a planar projection is a good
 * one, and saves most of the iterations).
 *
 * Each triangle is measured in its own plane with its outward normal towards
 * the viewer, so a map of an outward-wound mesh reads the right way round from
 * outside. Solved by conjugate gradients on the normal equations, AᵀA x = 0
 * with the pins held, preconditioned by symmetric Gauss-Seidel.
 */
export function lscm(
  pos: ArrayLike<number>,
  faces: number[],
  pins: [number, number],
  pinUv: [[number, number], [number, number]],
  guess: Float64Array,
): Float64Array {
  const n = pos.length / 3;
  const fc = faces.length / 3;
  // Two rows per triangle, each with six entries: u and v of three corners.
  const cols = new Int32Array(fc * 12);
  const vals = new Float64Array(fc * 12);
  for (let f = 0; f < fc; f++) {
    const i = faces[3 * f], j = faces[3 * f + 1], k = faces[3 * f + 2];
    const a = vtx(pos, i), b = vtx(pos, j), c = vtx(pos, k);
    const ab = sub(b, a), ac = sub(c, a);
    const nrm = cross(ab, ac);
    const twiceArea = len(nrm);
    const base = 12 * f;
    if (!(twiceArea > 0)) { cols.fill(0, base, base + 12); vals.fill(0, base, base + 12); continue; }
    const e1 = norm(ab);
    const e2 = norm(cross(norm(nrm), e1));
    const z: [number, number][] = [[0, 0], [len(ab), 0], [dot(ac, e1), dot(ac, e2)]];
    // W_m = z_{m+2} - z_{m+1}: sum W_m z_m is zero for the triangle itself.
    const w = (m: number): [number, number] => {
      const p = z[(m + 2) % 3], q = z[(m + 1) % 3];
      return [p[0] - q[0], p[1] - q[1]];
    };
    const s = 1 / Math.sqrt(twiceArea);
    [i, j, k].forEach((vi, m) => {
      const [wr, wi] = w(m);
      // Real part: wr u - wi v.   Imaginary part: wi u + wr v.
      cols[base + 2 * m] = 2 * vi; vals[base + 2 * m] = wr * s;
      cols[base + 2 * m + 1] = 2 * vi + 1; vals[base + 2 * m + 1] = -wi * s;
      cols[base + 6 + 2 * m] = 2 * vi; vals[base + 6 + 2 * m] = wi * s;
      cols[base + 6 + 2 * m + 1] = 2 * vi + 1; vals[base + 6 + 2 * m + 1] = wr * s;
    });
  }

  const x = Float64Array.from(guess);
  const fixed = new Uint8Array(2 * n);
  pins.forEach((p, q) => {
    fixed[2 * p] = fixed[2 * p + 1] = 1;
    x[2 * p] = pinUv[q][0];
    x[2 * p + 1] = pinUv[q][1];
  });

  // K = AᵀA, assembled per vertex pair as 2x2 blocks [uu uv; vu vv] in
  // compressed rows. It is a Laplacian in all but name, and solving it
  // directly lets the preconditioner below see its off-diagonal terms.
  const neighbours: number[][] = Array.from({ length: n }, (_, i) => [i]);
  for (let f = 0; f < fc; f++) {
    const t = [faces[3 * f], faces[3 * f + 1], faces[3 * f + 2]];
    for (const a of t) for (const b of t) if (a !== b && !neighbours[a].includes(b)) neighbours[a].push(b);
  }
  const start = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    neighbours[i].sort((a, b) => a - b);
    start[i + 1] = start[i] + neighbours[i].length;
  }
  const colOf = new Int32Array(start[n]);
  for (let i = 0; i < n; i++) colOf.set(neighbours[i], start[i]);
  const block = new Float64Array(4 * start[n]);
  const slot = (a: number, b: number) => {
    let lo = start[a], hi = start[a + 1] - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (colOf[mid] < b) lo = mid + 1; else hi = mid;
    }
    return lo;
  };
  for (let row = 0; row < 2 * fc; row++) {
    for (let s1 = 6 * row; s1 < 6 * row + 6; s1++) {
      const ca = cols[s1], va = vals[s1];
      if (va === 0) continue;
      for (let s2 = 6 * row; s2 < 6 * row + 6; s2++) {
        const cb = cols[s2], vb = vals[s2];
        if (vb === 0) continue;
        block[4 * slot(ca >> 1, cb >> 1) + 2 * (ca & 1) + (cb & 1)] += va * vb;
      }
    }
  }

  /** out = K v over the free unknowns; fixed ones read as given and come out 0. */
  const mulK = (v: Float64Array, out: Float64Array) => {
    for (let i = 0; i < n; i++) {
      let su = 0, sv = 0;
      for (let e = start[i]; e < start[i + 1]; e++) {
        const j = colOf[e], b = 4 * e;
        const uj = v[2 * j], vj = v[2 * j + 1];
        su += block[b] * uj + block[b + 1] * vj;
        sv += block[b + 2] * uj + block[b + 3] * vj;
      }
      out[2 * i] = fixed[2 * i] ? 0 : su;
      out[2 * i + 1] = fixed[2 * i + 1] ? 0 : sv;
    }
  };
  const diagAt = new Int32Array(n);
  for (let i = 0; i < n; i++) diagAt[i] = slot(i, i);
  const diagOf = (i: number, c: number) => block[4 * diagAt[i] + 3 * c];
  /** Symmetric Gauss-Seidel over the free unknowns: z = M⁻¹ r. */
  const precondition = (r: Float64Array, z: Float64Array) => {
    // Forward: (D + L) y = r.
    for (let k = 0; k < 2 * n; k++) {
      if (fixed[k]) { z[k] = 0; continue; }
      const i = k >> 1, c = k & 1;
      let sum = r[k];
      for (let e = start[i]; e < start[i + 1]; e++) {
        const j = colOf[e], b = 4 * e + 2 * c;
        if (2 * j < k) sum -= block[b] * z[2 * j];
        if (2 * j + 1 < k) sum -= block[b + 1] * z[2 * j + 1];
      }
      const d = diagOf(i, c);
      z[k] = d > 0 ? sum / d : 0;
    }
    // Backward: (D + U) z = D y.
    for (let k = 2 * n - 1; k >= 0; k--) {
      if (fixed[k]) continue;
      const i = k >> 1, c = k & 1;
      const d = diagOf(i, c);
      if (!(d > 0)) continue;
      let sum = d * z[k];
      for (let e = start[i]; e < start[i + 1]; e++) {
        const j = colOf[e], b = 4 * e + 2 * c;
        if (2 * j > k) sum -= block[b] * z[2 * j];
        if (2 * j + 1 > k) sum -= block[b + 1] * z[2 * j + 1];
      }
      z[k] = sum / d;
    }
  };
  const dotv = (a: Float64Array, b: Float64Array) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  };

  // Preconditioned conjugate gradients on K x = 0, the pins held.
  const r = new Float64Array(2 * n);
  mulK(x, r);
  for (let i = 0; i < r.length; i++) r[i] = -r[i];
  const z = new Float64Array(2 * n);
  precondition(r, z);
  const p = Float64Array.from(z);
  const q = new Float64Array(2 * n);
  let gamma = dotv(r, z);
  // A pattern cell is a millimetre or so across: a residual a millionth of
  // the starting one moves nothing anyone could see.
  const stop = gamma * 1e-12;
  // About √n iterations: 170 at 3 000 vertices, 1 100 at 50 000 (18 s, in the
  // worker). Cascading through coarser copies of the system was tried, and
  // clumped vertices lose the balance between the map's stretch and its area
  // term, so the coarse answer starts the fine solve no closer.
  const maxIter = 2500;
  for (let it = 0; it < maxIter && gamma > stop && gamma > 0; it++) {
    mulK(p, q);
    const pq = dotv(p, q);
    if (!(pq > 0)) break;
    const alpha = gamma / pq;
    for (let i = 0; i < x.length; i++) { x[i] += alpha * p[i]; r[i] -= alpha * q[i]; }
    precondition(r, z);
    const next = dotv(r, z);
    const beta = next / gamma;
    gamma = next;
    for (let i = 0; i < p.length; i++) p[i] = z[i] + beta * p[i];
  }
  return x;
}

// --- how far a map stretches ---------------------------------------------------

/**
 * How much the flat map distorts one triangle: the larger of how far it
 * enlarges and how far it shrinks the triangle in any direction, less one.
 * 0 is a perfect copy; 0.41 is a planar projection of a 45° wall. A triangle
 * the map turns over counts as infinitely stretched.
 */
export function triangleStretch(a: Vec3, b: Vec3, c: Vec3, ua: [number, number], ub: [number, number], uc: [number, number]): number {
  const ab = sub(b, a), ac = sub(c, a);
  const nrm = cross(ab, ac);
  if (!(len(nrm) > 0)) return 0;
  const e1 = norm(ab);
  const e2 = norm(cross(norm(nrm), e1));
  // Local 2D corners: (0,0), (x1,0), (x2,y2).
  const x1 = len(ab), x2 = dot(ac, e1), y2 = dot(ac, e2);
  const du1 = ub[0] - ua[0], dv1 = ub[1] - ua[1];
  const du2 = uc[0] - ua[0], dv2 = uc[1] - ua[1];
  // J maps local (x, y) to (u, v): J [x1 x2; 0 y2] = [du1 du2; dv1 dv2].
  const j00 = du1 / x1, j10 = dv1 / x1;
  const j01 = (du2 - j00 * x2) / y2, j11 = (dv2 - j10 * x2) / y2;
  const det = j00 * j11 - j01 * j10;
  if (!(det > 0)) return Infinity;
  const e = j00 * j00 + j01 * j01 + j10 * j10 + j11 * j11;
  const root = Math.sqrt(Math.max(0, e * e - 4 * det * det));
  const s1 = Math.sqrt((e + root) / 2);
  const s2 = Math.sqrt(Math.max(1e-300, (e - root) / 2));
  return Math.max(s1, 1 / s2) - 1;
}
