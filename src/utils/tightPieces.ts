// Convex pieces pulled in to the surface they stand for.
//
// V-HACD is a voxel method. Its pieces are hulls of voxels, so each one
// stands proud of the real surface wherever the surface is not on the voxel
// grid: a flat wall by up to a voxel (1.7 mm on a 21 mm square pocket), a
// round bore by the chord of whatever arc a piece happens to span (a 10 mm
// bore cleared only 8.35 mm in 12 pieces), and a channel floor by both, in
// steps from one piece to the next that stopped a 6 mm marble dead on an 11°
// slope. Pegs with 0.5 mm clearance stopped at the rim. None of it was
// reported, because filledCavities.ts deliberately ignores small overshoot.
//
// So each piece is rebuilt as the hull of the SOLID inside it: the mesh's own
// triangles clipped to the piece, the piece's corners that are inside the
// mesh, and the points where its edges pierce the surface. That is the
// tightest convex shape covering exactly the material the piece covered, so
// nothing the piece held is lost, and what still stands proud is only the
// surface's own concavity within the piece — the chord of an arc, the fillet
// across an inside corner.
//
// Then the piece that stands proudest is cut in two, and each half rebuilt
// the same way, until nothing stands more than the tolerance proud or the
// piece budget is spent. The cut goes through the deepest point, across the
// direction in which the surface it faces turns: an arc is halved, which
// quarters its chord; an inside corner is split along its edge. Nothing here
// knows about cups, pegs or channels.
//
// Pure, store-free and Worker-safe: it runs in the V-HACD worker after the
// decomposition.

import { convexHullOf, meshVolumeAndCentroid, usableColliderHulls, type Hull } from './csg';
import { buildMeshQuery, type MeshQuery } from './meshQuery';

export interface TightenOptions {
  /** Stop cutting a piece once nothing stands more than this proud of the surface, metres. */
  tolerance: number;
  /** Stop cutting once there are this many pieces. */
  maxPieces: number;
  /** And once this long has been spent, ms. */
  timeBudgetMs?: number;
  /**
   * No cut may leave a piece thinner than this (twice its volume over its
   * area), metres: a backstop to cutting only across the surface (cutPlanes).
   * A ball dropped into a cup whose floor had been cut into 0.5 mm slabs went
   * straight through it: it sank further in one step than a slab was thick,
   * and MuJoCo pushed it out of the far side.
   */
  minThickness?: number;
  /** How far each half of a cut reaches past the cut into the other, metres. */
  overlap?: number;
}

export interface TightenResult {
  hulls: Hull[];
  /** How far the pieces stand proud of the surface into the air, at most, metres. */
  intrusion: number;
  /** Where, in the mesh's frame. */
  intrusionAt?: [number, number, number];
  /** The same, of the pieces as V-HACD made them. */
  intrusionBefore: number;
  cuts: number;
}

interface Plane { n: [number, number, number]; d: number }

interface Piece {
  hull: Hull;
  planes: Plane[];
  /** Clipped surface inside the piece: normal and area of each scrap, and its centroid. */
  scraps: { n: [number, number, number]; area: number; c: [number, number, number]; poly: number[] }[];
  depth: number;
  deepest: [number, number, number] | null;
  /** Cutting it got nowhere; leave it be. */
  stuck?: boolean;
}

const EPS = 1e-9;

function planesOf(h: Hull): Plane[] {
  const v = h.verts, out: Plane[] = [];
  for (let i = 0; i < h.faces.length; i += 3) {
    const a = h.faces[i] * 3, b = h.faces[i + 1] * 3, c = h.faces[i + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
    const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-20) continue;
    nx /= len; ny /= len; nz /= len;
    out.push({ n: [nx, ny, nz], d: nx * v[a] + ny * v[a + 1] + nz * v[a + 2] });
  }
  return out;
}

function boundsOf(v: number[]): { lo: number[]; hi: number[] } {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) {
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[i + k]); hi[k] = Math.max(hi[k], v[i + k]); }
  }
  return { lo, hi };
}

/** A polygon clipped to n·x <= d (Sutherland–Hodgman), as flat xyz triples. */
function clipPolygon(poly: number[], p: Plane, eps: number): number[] {
  const out: number[] = [];
  const m = poly.length / 3;
  if (m === 0) return out;
  const [nx, ny, nz] = p.n;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const ax = poly[i * 3], ay = poly[i * 3 + 1], az = poly[i * 3 + 2];
    const bx = poly[j * 3], by = poly[j * 3 + 1], bz = poly[j * 3 + 2];
    const da = nx * ax + ny * ay + nz * az - p.d;
    const db = nx * bx + ny * by + nz * bz - p.d;
    if (da <= eps) out.push(ax, ay, az);
    if ((da <= eps) !== (db <= eps)) {
      const t = (da - eps) / (da - db);
      if (t > 0 && t < 1) out.push(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t);
    }
  }
  return out;
}

/** Where segment a→b crosses triangle `o` of the corner array, if it does. */
function segmentTriangle(a: number[], b: number[], tri: Float64Array, o: number): number[] | null {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const e1x = tri[o + 3] - tri[o], e1y = tri[o + 4] - tri[o + 1], e1z = tri[o + 5] - tri[o + 2];
  const e2x = tri[o + 6] - tri[o], e2y = tri[o + 7] - tri[o + 1], e2z = tri[o + 8] - tri[o + 2];
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-24) return null;
  const inv = 1 / det;
  const sx = a[0] - tri[o], sy = a[1] - tri[o + 1], sz = a[2] - tri[o + 2];
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < 0 || u > 1) return null;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return null;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  if (t < 0 || t > 1) return null;
  return [a[0] + dx * t, a[1] + dy * t, a[2] + dz * t];
}

/**
 * convexHullOf, given points already rounded to the micron it welds its output
 * to. Hulled unrounded, two corners closer than that came out as one, folded
 * the faces between them over, and MuJoCo refused the piece for faces of
 * inconsistent orientation.
 */
function hullOfPoints(points: number[][]): Hull | null {
  const seen = new Set<string>();
  const kept: number[][] = [];
  for (const p of points) {
    const r = [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6, Math.round(p[2] * 1e6) / 1e6];
    const key = `${r[0]},${r[1]},${r[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(r);
  }
  return kept.length >= 4 ? convexHullOf(kept) : null;
}

function uniqueEdges(faces: number[]): [number, number][] {
  const seen = new Set<number>();
  const out: [number, number][] = [];
  const big = 1 << 20;
  for (let i = 0; i < faces.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const a = faces[i + k], b = faces[i + (k + 1) % 3];
      const key = a < b ? a * big + b : b * big + a;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([a, b]);
    }
  }
  return out;
}

/**
 * The hull of the solid inside a convex region, or null when the region holds
 * none. Also returns the clipped surface, for choosing where to cut.
 */
function solidInside(q: MeshQuery, region: Hull): { hull: Hull; scraps: Piece['scraps']; planes: Plane[] } | null {
  const planes = planesOf(region);
  const { lo, hi } = boundsOf(region.verts);
  const pad = 1e-7;
  const tris = q.near(lo.map(v => v - pad), hi.map(v => v + pad));
  const points: number[][] = [];
  const scraps: Piece['scraps'] = [];
  for (const t of tris) {
    const o = t * 9;
    let poly = Array.from(q.tri.subarray(o, o + 9));
    for (const p of planes) {
      poly = clipPolygon(poly, p, 1e-10);
      if (poly.length < 9) break;
    }
    if (poly.length < 9) continue;
    let cx = 0, cy = 0, cz = 0;
    const m = poly.length / 3;
    for (let i = 0; i < poly.length; i += 3) {
      points.push([poly[i], poly[i + 1], poly[i + 2]]);
      cx += poly[i]; cy += poly[i + 1]; cz += poly[i + 2];
    }
    let area = 0;
    for (let i = 1; i + 1 < m; i++) {
      const ux = poly[i * 3] - poly[0], uy = poly[i * 3 + 1] - poly[1], uz = poly[i * 3 + 2] - poly[2];
      const wx = poly[i * 3 + 3] - poly[0], wy = poly[i * 3 + 4] - poly[1], wz = poly[i * 3 + 5] - poly[2];
      area += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
    }
    if (area > 0) {
      scraps.push({ n: [q.normal[t * 3], q.normal[t * 3 + 1], q.normal[t * 3 + 2]], area, c: [cx / m, cy / m, cz / m], poly });
    }
  }
  // The region's own corners that are in the material, and where its edges
  // run into the surface: the corners of the region's faces cut by the solid.
  const v = region.verts;
  for (let i = 0; i < v.length; i += 3) {
    if (q.inside(v[i], v[i + 1], v[i + 2])) points.push([v[i], v[i + 1], v[i + 2]]);
  }
  for (const [ia, ib] of uniqueEdges(region.faces)) {
    const a = [v[ia * 3], v[ia * 3 + 1], v[ia * 3 + 2]], b = [v[ib * 3], v[ib * 3 + 1], v[ib * 3 + 2]];
    const elo = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
    const ehi = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
    for (const t of q.near(elo, ehi)) {
      const hit = segmentTriangle(a, b, q.tri, t * 9);
      if (hit) points.push(hit);
    }
  }
  if (points.length < 4) return null;
  const hull = hullOfPoints(points);
  if (!hull) return null;
  const { volume, centroid } = meshVolumeAndCentroid(hull.verts, hull.faces);
  return { hull: { ...hull, volume: Math.abs(volume), centroid }, scraps, planes: planesOf(hull) };
}

/**
 * How far a piece stands proud of the surface into the air, and where: its
 * faces sampled, each sample outside the mesh measured to the surface. A face
 * lying on the surface is skipped after a few samples.
 */
function standsProud(q: MeshQuery, h: Hull, cap: number, quick: number): { depth: number; at: [number, number, number] | null } {
  const v = h.verts;
  let depth = 0;
  let at: [number, number, number] | null = null;
  const probe = (x: number, y: number, z: number): number => {
    if (q.inside(x, y, z)) return 0;
    return q.distance(x, y, z, cap);
  };
  const S = 4;
  for (let f = 0; f < h.faces.length; f += 3) {
    const a = h.faces[f] * 3, b = h.faces[f + 1] * 3, c = h.faces[f + 2] * 3;
    const at3 = (u: number, w: number): [number, number, number] => {
      const r = 1 - u - w;
      return [r * v[a] + u * v[b] + w * v[c], r * v[a + 1] + u * v[b + 1] + w * v[c + 1], r * v[a + 2] + u * v[b + 2] + w * v[c + 2]];
    };
    // The centroid and the edge midpoints first: on the surface, they are all
    // there is to it.
    const first: [number, number][] = [[1 / 3, 1 / 3], [0.5, 0], [0, 0.5], [0.5, 0.5]];
    let worst = 0;
    for (const [u, w] of first) {
      const p = at3(u, w);
      const d = probe(p[0], p[1], p[2]);
      if (d > worst) worst = d;
      if (d > depth) { depth = d; at = p; }
    }
    if (worst < quick) continue;
    for (let i = 0; i <= S; i++) for (let j = 0; i + j <= S; j++) {
      if ((i === 0 && j === 0) || i === S || j === S) continue;
      const p = at3(i / S, j / S);
      const d = probe(p[0], p[1], p[2]);
      if (d > depth) { depth = d; at = p; }
    }
  }
  return { depth, at };
}

/** The region cut by n·x <= e (keep) — a convex hull's corners and edge crossings on that side. */
function cutRegion(h: Hull, n: number[], e: number): Hull | null {
  const v = h.verts, pts: number[][] = [];
  const side = (i: number) => n[0] * v[i * 3] + n[1] * v[i * 3 + 1] + n[2] * v[i * 3 + 2] - e;
  const count = v.length / 3;
  for (let i = 0; i < count; i++) if (side(i) <= EPS) pts.push([v[i * 3], v[i * 3 + 1], v[i * 3 + 2]]);
  for (const [a, b] of uniqueEdges(h.faces)) {
    const sa = side(a), sb = side(b);
    if ((sa < -EPS && sb > EPS) || (sa > EPS && sb < -EPS)) {
      const t = sa / (sa - sb);
      pts.push([0, 1, 2].map(k => v[a * 3 + k] + (v[b * 3 + k] - v[a * 3 + k]) * t));
    }
  }
  return pts.length >= 4 ? hullOfPoints(pts) : null;
}

/** The leading eigenvector of a symmetric 3x3, by power iteration from a start that cannot be orthogonal to all three. */
function leadingAxis(m: number[][]): { axis: number[]; value: number } {
  let x = [0.6, 0.7, 0.4];
  let value = 0;
  for (let it = 0; it < 40; it++) {
    const y = [0, 1, 2].map(r => m[r][0] * x[0] + m[r][1] * x[1] + m[r][2] * x[2]);
    const len = Math.hypot(y[0], y[1], y[2]);
    if (len < 1e-30) return { axis: x, value: 0 };
    value = len;
    x = y.map(c => c / len);
  }
  return { axis: x, value };
}

/**
 * Planes to cut a piece by, best guess first. Each is across the direction in
 * which the surface facing the piece's deepest point turns most: an arc's
 * tangent, the line across an inside corner. One goes through the deepest
 * point; one through where the surface turned, between the scraps whose
 * normals lie either side of the mean — which for an inside corner is the
 * corner's own edge, and halves it exactly.
 */
function cutPlanes(piece: Piece): { n: number[]; e: number }[] {
  const p = piece.deepest;
  if (!p) return [];
  const facing = piece.scraps.filter(s => s.n[0] * (p[0] - s.c[0]) + s.n[1] * (p[1] - s.c[1]) + s.n[2] * (p[2] - s.c[2]) > 0);
  let total = 0;
  const mean = [0, 0, 0];
  for (const s of facing) { total += s.area; for (let k = 0; k < 3; k++) mean[k] += s.n[k] * s.area; }
  let n: number[] | null = null;
  let second: number[] | null = null;
  if (total > 0) {
    for (let k = 0; k < 3; k++) mean[k] /= total;
    const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const s of facing) {
      const d = [s.n[0] - mean[0], s.n[1] - mean[1], s.n[2] - mean[2]];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cov[r][c] += s.area * d[r] * d[c];
    }
    const { axis, value } = leadingAxis(cov);
    if (value / total > 1e-6) {
      n = axis;
      // And the next: deflated, so a piece holding both an arc and the floor
      // under it can be cut either way.
      const defl = cov.map((row, r) => row.map((x, c) => x - value * axis[r] * axis[c]));
      const next = leadingAxis(defl);
      if (next.value / total > 1e-6) second = next.axis;
    }
  }
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (!n) {
    // A flat face with air beside it: cut across the piece's longest side.
    const { lo, hi } = boundsOf(piece.hull.verts);
    const k = [0, 1, 2].reduce((best, i) => (hi[i] - lo[i] > hi[best] - lo[best] ? i : best), 0);
    n = [0, 0, 0];
    n[k] = 1;
    return [{ n, e: dot(n, p) }];
  }
  const out: { n: number[]; e: number }[] = [];
  const meanLen = Math.hypot(mean[0], mean[1], mean[2]) || 1;
  for (const axis of second ? [n, second] : [n]) {
    // Never along the way the surface faces: that slices material off in
    // slabs (a cup's floor came out as 0.5 mm sheets a falling ball went
    // straight through), where every useful cut — halving an arc, splitting
    // an inside corner along its edge — runs across it.
    if (Math.abs(dot(axis, mean)) / meanLen > 0.5) continue;
    out.push({ n: axis, e: dot(axis, p) });
    // Where the turn is: between the scraps turned one way and those turned
    // the other, whichever side of each other they lie.
    const a = [Infinity, -Infinity], b = [Infinity, -Infinity];
    for (const s of facing) {
      const g = dot(s.n, axis) < dot(mean, axis) ? a : b;
      for (let i = 0; i < s.poly.length; i += 3) {
        const at = axis[0] * s.poly[i] + axis[1] * s.poly[i + 1] + axis[2] * s.poly[i + 2];
        g[0] = Math.min(g[0], at); g[1] = Math.max(g[1], at);
      }
    }
    if (Number.isFinite(a[0]) && Number.isFinite(b[0])) {
      // Apart, the gap; overlapping, the middle of the overlap.
      const e = a[1] <= b[0] ? (a[1] + b[0]) / 2 : b[1] <= a[0] ? (b[1] + a[0]) / 2
        : (Math.max(a[0], b[0]) + Math.min(a[1], b[1])) / 2;
      out.push({ n: axis, e });
    }
  }
  return out;
}

/** Twice volume over area: a slab's thickness, near enough a stubby piece's least extent. */
function thicknessOf(h: Hull): number {
  let area = 0;
  const v = h.verts;
  for (let i = 0; i < h.faces.length; i += 3) {
    const a = h.faces[i] * 3, b = h.faces[i + 1] * 3, c = h.faces[i + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
    const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    area += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
  }
  return area > 0 ? (2 * h.volume) / area : 0;
}

function makePiece(q: MeshQuery, region: Hull, cap: number, quick: number): Piece | null {
  const solid = solidInside(q, region);
  if (!solid) return null;
  if (usableColliderHulls([solid.hull]).length === 0) return null;
  const { depth, at } = standsProud(q, solid.hull, cap, quick);
  return { hull: solid.hull, planes: solid.planes, scraps: solid.scraps, depth, deepest: at };
}

/**
 * Pulls each piece in to the solid it covers, then cuts the proudest until
 * none stands more than `tolerance` proud or the budget is spent.
 */
export function tightenPieces(verts: number[], faces: number[], hulls: Hull[], opts: TightenOptions): TightenResult {
  const started = Date.now();
  const q = buildMeshQuery(verts, faces);
  const size = Math.max(q.hi[0] - q.lo[0], q.hi[1] - q.lo[1], q.hi[2] - q.lo[2]);
  // Anything deeper than this is a filled cavity, which filledCavities.ts names.
  const cap = Math.max(size / 4, opts.tolerance * 4);
  const quick = opts.tolerance / 4;

  let intrusionBefore = 0;
  for (const h of hulls) intrusionBefore = Math.max(intrusionBefore, standsProud(q, h, cap, quick).depth);

  const pieces: Piece[] = [];
  for (const h of hulls) {
    const p = makePiece(q, h, cap, quick);
    if (p) pieces.push(p);
  }
  // Rebuilding can only drop a piece that held no material at all.
  if (pieces.length === 0) return { hulls, intrusion: intrusionBefore, intrusionBefore, cuts: 0 };

  let cuts = 0;
  const budget = opts.timeBudgetMs ?? Infinity;
  while (pieces.length < opts.maxPieces && Date.now() - started < budget) {
    let worst = -1;
    for (let i = 0; i < pieces.length; i++) {
      if (pieces[i].stuck || pieces[i].depth <= opts.tolerance) continue;
      if (worst < 0 || pieces[i].depth > pieces[worst].depth) worst = i;
    }
    if (worst < 0) break;
    const piece = pieces[worst];
    let best: Piece[] | null = null;
    let bestScore = Infinity;
    for (const plane of cutPlanes(piece)) {
      // The halves overlap across the cut rather than meet on it. Meeting
      // exactly, they left a seam a ball sank into: an 8 mm ball dropped
      // 100 mm into a cup went through its 4 mm floor where two floor pieces
      // met, each pushing it sideways off its own edge.
      const lap = opts.overlap ?? 0;
      const halves = [cutRegion(piece.hull, plane.n, plane.e + lap), cutRegion(piece.hull, plane.n.map(c => -c), -plane.e + lap)];
      if (!halves[0] || !halves[1]) continue;
      const made = halves.map(h => makePiece(q, h!, cap, quick));
      if (!made[0] || !made[1]) continue;
      if (opts.minThickness && made.some(m => thicknessOf(m!.hull) < opts.minThickness!)) continue;
      const deeper = Math.max(made[0].depth, made[1].depth);
      // Progress is one side clearly shallower, or a good share of the air
      // gone, and neither side deeper. A piece wrapping the round corner at
      // the foot of a bore is both an arc and a corner: halving the arc
      // leaves the corner as deep in each half, but takes air away, and the
      // corner can be cut once it is short enough to be nearly straight.
      const shallower = Math.min(made[0].depth, made[1].depth);
      const kept = (made[0].hull.volume + made[1].hull.volume) / piece.hull.volume;
      const score = deeper + shallower + kept * piece.depth;
      // Within sampling: a face is sampled at a few points, so a half can
      // measure a little deeper than the whole it was cut from.
      if (deeper <= piece.depth * 1.05 && (shallower < piece.depth * 0.9 || kept < 0.97) && (!best || score < bestScore)) {
        best = made as Piece[];
        bestScore = score;
      }
    }
    // A cut that leaves either side empty, or no shallower than before, is no use.
    if (!best) {
      piece.stuck = true;
      continue;
    }
    const made = best;
    pieces.splice(worst, 1, made[0], made[1]);
    cuts++;
  }

  let intrusion = 0;
  let intrusionAt: [number, number, number] | undefined;
  for (const p of pieces) {
    if (p.depth > intrusion) { intrusion = p.depth; intrusionAt = p.deepest ?? undefined; }
  }
  return { hulls: pieces.map(p => p.hull), intrusion, ...(intrusionAt ? { intrusionAt } : {}), intrusionBefore, cuts };
}
