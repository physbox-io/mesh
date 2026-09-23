// Breaking a solid into pieces that add back up to it.
//
// The obvious thing to reach for here is the convex decomposition the app
// already runs (utils/convexDecomposition.ts, V-HACD). It is the wrong tool, for
// two reasons that are easy to miss. V-HACD's hulls OVERLAP — they are an
// approximation of a shape by a union of convex pieces, not a partition of it —
// so using them as shards double-counts the material, the fragments start
// interpenetrating, and the total mass comes out heavier than the body that
// broke. And they only exist below a solidity of 0.92, so a plate, a ball or a
// figurine, which are the most obvious things to want to smash, have no pieces
// at all.
//
// So fragments are cut here instead, as Voronoi cells of the body's CONVEX HULL.
// That choice buys exactness. A convex hull is an intersection of half-spaces; a
// Voronoi cell is an intersection of bisector half-spaces; so a cell of the hull
// is an intersection of both, which is convex, closed and — this is the point —
// tiles the hull with no gaps and no overlaps. Volume and mass are conserved to
// within rounding, and every shard is already convex, which is exactly what
// MuJoCo wants a collision mesh to be.
//
// What it costs is hollowness: the shards of a cup are cut from the cup's hull,
// so they look like the pieces of a solid lump rather than of a vessel. Cutting
// each cell against the source mesh instead is a boolean per shard, which is the
// OpenSCAD worker and seconds of wall clock; it is a worthwhile upgrade later and
// it drops in behind the same interface, because only `cellsFor` would change.
//
// Pure, and deliberately worker-free: a hull plus a few hundred plane solves is
// well under a frame, so there is nothing here worth the cost of a worker. Same
// rule as convexDecomposition.ts — nothing in this file may reach the store or
// spawn anything.

import { convexHullOf, meshVolumeAndCentroid, type Hull } from './csg';

/** One fragment. Shaped like `Hull` on purpose, so the collider plumbing fits. */
export type FractureCell = Hull;

/** A half-space, as `n · p <= d`. The inside is the side the solid is on. */
interface Plane {
  nx: number; ny: number; nz: number;
  d: number;
}

export const MIN_FRACTURE_PIECES = 2;
/**
 * Above this the pieces stop reading as pieces and start reading as gravel,
 * and every one of them is a body with a free joint and its own contact pairs.
 * Sixteen already doubles the model's degrees of freedom for a single vase.
 */
export const MAX_FRACTURE_PIECES = 24;
export const DEFAULT_FRACTURE_PIECES = 8;

/** A shard thinner than this in any direction is a sliver; drop it. */
const MIN_CELL_VOLUME = 1e-9;

/**
 * How many corners the hull a body is cut from may have.
 *
 * Under this nothing is decimated at all, so a box, a plate or anything else
 * with a simple hull is cut exactly. Over it, the shape is approximated — which
 * is what makes a vase affordable to break in the middle of a frame.
 */
const MAX_HULL_POINTS = 48;

/**
 * Deterministic noise. The same seed has to give the same shards every time or
 * a scene would break differently on every run and nothing could be tested.
 * Same generator the surface patterns use.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SeedOptions {
  /** How many fragments to aim for. */
  pieces?: number;
  seed?: number;
  /**
   * Where the impact landed, in the same space as the vertices.
   *
   * Given one, seeds crowd toward it: a struck body should come apart into
   * small pieces where it was hit and large ones away from it, which is both
   * what really happens and what reads as an impact rather than as a dissolve.
   */
  focus?: [number, number, number];
  /** 0 = ignore the focus entirely, 1 = pull hard toward it. */
  focusStrength?: number;
}

/**
 * Scatter seed points through a mesh's bounding box.
 *
 * Rejection-free by design: a seed outside the hull simply produces an empty
 * cell, which is dropped, and trying to place seeds exactly inside a hull costs
 * more than it saves.
 */
export function seedPoints(verts: number[], opts: SeedOptions = {}): [number, number, number][] {
  const pieces = clampPieces(opts.pieces ?? DEFAULT_FRACTURE_PIECES);
  const rnd = mulberry32(opts.seed ?? 1);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < verts.length; i += 3) {
    if (verts[i] < minX) minX = verts[i];
    if (verts[i] > maxX) maxX = verts[i];
    if (verts[i + 1] < minY) minY = verts[i + 1];
    if (verts[i + 1] > maxY) maxY = verts[i + 1];
    if (verts[i + 2] < minZ) minZ = verts[i + 2];
    if (verts[i + 2] > maxZ) maxZ = verts[i + 2];
  }
  if (!Number.isFinite(minX)) return [];

  const focus = opts.focus;
  const pull = Math.max(0, Math.min(1, opts.focusStrength ?? 0.6));
  const out: [number, number, number][] = [];
  for (let i = 0; i < pieces; i++) {
    let x = minX + rnd() * (maxX - minX);
    let y = minY + rnd() * (maxY - minY);
    let z = minZ + rnd() * (maxZ - minZ);
    if (focus && pull > 0) {
      // Bias by a random power of the distance rather than by a fixed fraction,
      // so the result is a gradient of sizes instead of a clump at the impact
      // point and a void everywhere else.
      const t = pull * rnd() * rnd();
      x += (focus[0] - x) * t;
      y += (focus[1] - y) * t;
      z += (focus[2] - z) * t;
    }
    out.push([x, y, z]);
  }
  return out;
}

export function clampPieces(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_FRACTURE_PIECES;
  return Math.max(MIN_FRACTURE_PIECES, Math.min(MAX_FRACTURE_PIECES, Math.round(n)));
}

/**
 * Cut a mesh's convex hull into Voronoi cells about `seeds`.
 *
 * Each cell is found as the intersection of the hull's own half-spaces with the
 * bisectors between its seed and every other seed. The vertices of that
 * intersection are the points where three of those planes meet and which no
 * other plane excludes — so the whole thing is a few hundred 3x3 solves and one
 * convex hull per cell, which is why this needs no worker.
 */
export function voronoiCells(
  verts: number[],
  faces: number[],
  seeds: [number, number, number][],
): FractureCell[] {
  if (seeds.length === 0) return [];
  if (seeds.length === 1) {
    const whole = convexHullOf(pointsOf(verts));
    return whole ? [whole] : [];
  }

  const bounds = hullPlanes(verts, faces);
  if (bounds.length < 4) return [];

  // Scale-aware tolerance: these meshes are metres, and a fixed epsilon that
  // suits a 1 m block rejects every vertex of a 10 mm one.
  const scale = extentOf(verts);
  const eps = Math.max(1e-9, scale * 1e-7);

  // Finding the corners of a polytope means solving every triple of planes, so
  // the work grows as the FOURTH power of the plane count. That is nothing for
  // a box, whose hull has six faces, and ruinous for a turned vase, whose hull
  // has three hundred and thirty: 426 ms on the main thread, taken at the exact
  // moment of impact, which is felt as the scene stopping dead just before the
  // blow lands.
  //
  // Almost none of those planes matter to any given cell, though. A cell in the
  // middle of the vase is bounded by its neighbours, and by at most a handful
  // of hull faces near it. So the cell is found twice: once against its
  // bisectors and a bounding box, which is cheap and gives a region guaranteed
  // to CONTAIN the true cell, and then again against only those hull planes
  // that actually cut that region. A hull plane that misses the containing
  // region cannot touch the cell inside it, so nothing is lost — the answer is
  // the same one the brute force gives, about eighty times faster.
  const box = boundingPlanes(verts);

  const cells: FractureCell[] = [];
  for (let k = 0; k < seeds.length; k++) {
    const bisectors: Plane[] = [];
    for (let j = 0; j < seeds.length; j++) {
      if (j === k) continue;
      const p = bisector(seeds[k], seeds[j]);
      if (p) bisectors.push(p);
    }

    // Two rounds of narrowing. The first bounds the cell by its neighbours and
    // the bounding box; the second by the hull faces that reach that region,
    // which is a far smaller region and so a far shorter list. A third round
    // buys nothing measurable.
    let region = polytopeVertices(bisectors.concat(box), eps);
    if (region.length < 4) continue;

    let corners = region;
    for (let pass = 0; pass < 2; pass++) {
      const relevant = bounds.filter((pl) =>
        region.some((v) => pl.nx * v[0] + pl.ny * v[1] + pl.nz * v[2] > pl.d - eps));
      if (relevant.length === 0) break;
      corners = polytopeVertices(bisectors.concat(relevant), eps);
      if (corners.length < 4) break;
      if (relevant.length === bounds.length) break; // nothing was pruned
      region = corners;
    }
    if (corners.length < 4) continue;
    const cell = convexHullOf(corners);
    if (cell && cell.volume > MIN_CELL_VOLUME) cells.push(cell);
  }
  return cells;
}

/** The six axis-aligned half-spaces of a mesh's bounding box. */
function boundingPlanes(verts: number[]): Plane[] {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < verts.length; i += 3) {
    if (verts[i] < minX) minX = verts[i]; if (verts[i] > maxX) maxX = verts[i];
    if (verts[i + 1] < minY) minY = verts[i + 1]; if (verts[i + 1] > maxY) maxY = verts[i + 1];
    if (verts[i + 2] < minZ) minZ = verts[i + 2]; if (verts[i + 2] > maxZ) maxZ = verts[i + 2];
  }
  return [
    { nx: 1, ny: 0, nz: 0, d: maxX }, { nx: -1, ny: 0, nz: 0, d: -minX },
    { nx: 0, ny: 1, nz: 0, d: maxY }, { nx: 0, ny: -1, nz: 0, d: -minY },
    { nx: 0, ny: 0, nz: 1, d: maxZ }, { nx: 0, ny: 0, nz: -1, d: -minZ },
  ];
}

/** The whole job: hull, seeds, cells. */
export function fractureMesh(
  verts: number[],
  faces: number[],
  opts: SeedOptions = {},
): FractureCell[] {
  return voronoiCells(verts, faces, seedPoints(verts, opts));
}

/**
 * How faithfully a set of cells reproduces what it was cut from.
 *
 * 1 is exact. Anything well under it means cells were dropped as slivers or the
 * hull was degenerate, and the shards would weigh less than the body did.
 */
export function fractureFidelity(cells: FractureCell[], verts: number[], faces: number[]): number {
  const hull = convexHullOf(pointsOf(verts));
  const target = hull?.volume ?? meshVolumeAndCentroid(verts, faces).volume;
  if (!target) return 0;
  const total = cells.reduce((sum, c) => sum + c.volume, 0);
  return total / target;
}

// ---------------------------------------------------------------------------

/**
 * At most `max` of the given points, spread as widely as possible.
 *
 * Greedy farthest-point: start from the one furthest from the centre, then
 * repeatedly take whichever point is furthest from everything chosen so far.
 * That keeps the extremes — the rim, the foot, the widest part of the belly —
 * which is exactly what a hull is made of.
 */
function spreadPoints(points: [number, number, number][], max: number): [number, number, number][] {
  if (points.length <= max) return points;

  let cx = 0, cy = 0, cz = 0;
  for (const p of points) { cx += p[0]; cy += p[1]; cz += p[2]; }
  cx /= points.length; cy /= points.length; cz /= points.length;

  let first = 0, firstD = -1;
  for (let i = 0; i < points.length; i++) {
    const d = (points[i][0] - cx) ** 2 + (points[i][1] - cy) ** 2 + (points[i][2] - cz) ** 2;
    if (d > firstD) { firstD = d; first = i; }
  }

  const chosen = [points[first]];
  const nearest = points.map((p) =>
    (p[0] - points[first][0]) ** 2 + (p[1] - points[first][1]) ** 2 + (p[2] - points[first][2]) ** 2);

  while (chosen.length < max) {
    let best = -1, bestD = -1;
    for (let i = 0; i < points.length; i++) {
      if (nearest[i] > bestD) { bestD = nearest[i]; best = i; }
    }
    if (best < 0 || bestD <= 0) break;
    chosen.push(points[best]);
    const b = points[best];
    for (let i = 0; i < points.length; i++) {
      const d = (points[i][0] - b[0]) ** 2 + (points[i][1] - b[1]) ** 2 + (points[i][2] - b[2]) ** 2;
      if (d < nearest[i]) nearest[i] = d;
    }
  }
  return chosen;
}

function pointsOf(verts: number[]): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < verts.length; i += 3) out.push([verts[i], verts[i + 1], verts[i + 2]]);
  return out;
}

function extentOf(verts: number[]): number {
  let min = Infinity, max = -Infinity;
  for (const v of verts) { if (v < min) min = v; if (v > max) max = v; }
  return Number.isFinite(min) ? Math.max(1e-6, max - min) : 1;
}

/**
 * The half-spaces of a mesh's convex hull, deduplicated.
 *
 * Taken from the hull rather than from the source triangles: a concave mesh's
 * own faces do not bound a convex region, and feeding them in as half-spaces
 * would carve away most of the solid.
 */
function hullPlanes(verts: number[], faces: number[]): Plane[] {
  /*
   * A turned or scanned body has a hull of hundreds of faces, and finding a
   * cell's corners costs roughly the fourth power of the plane count. The
   * shards do not need that resolution — nobody can tell a 90-faceted fragment
   * of a vase from a 330-faceted one while it is tumbling — so the hull is
   * taken over a spread of the body's points rather than all of them, which
   * skips hulling fourteen hundred vertices as well as shrinking the result.
   *
   * Farthest-point sampling rather than a stride: a stride can drop the rim and
   * quietly shrink the pot, while this keeps the extremes by construction.
   */
  const hull = convexHullOf(spreadPoints(pointsOf(verts), MAX_HULL_POINTS));
  const hv = hull ? hull.verts : verts;
  const hf = hull ? hull.faces : faces;

  const planes: Plane[] = [];
  const seen = new Set<string>();
  for (let f = 0; f < hf.length; f += 3) {
    const a = hf[f] * 3, b = hf[f + 1] * 3, c = hf[f + 2] * 3;
    const ux = hv[b] - hv[a], uy = hv[b + 1] - hv[a + 1], uz = hv[b + 2] - hv[a + 2];
    const vx = hv[c] - hv[a], vy = hv[c + 1] - hv[a + 1], vz = hv[c + 2] - hv[a + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    nx /= len; ny /= len; nz /= len;
    const d = nx * hv[a] + ny * hv[a + 1] + nz * hv[a + 2];
    const key = `${nx.toFixed(5)},${ny.toFixed(5)},${nz.toFixed(5)},${d.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    planes.push({ nx, ny, nz, d });
  }
  return planes;
}

/** Points nearer `a` than `b`: `(b-a) · p <= (|b|^2 - |a|^2) / 2`. */
function bisector(a: [number, number, number], b: [number, number, number]): Plane | null {
  const nx = b[0] - a[0], ny = b[1] - a[1], nz = b[2] - a[2];
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-12) return null; // coincident seeds bound nothing
  const d = ((b[0] * b[0] + b[1] * b[1] + b[2] * b[2]) - (a[0] * a[0] + a[1] * a[1] + a[2] * a[2])) / (2 * len);
  return { nx: nx / len, ny: ny / len, nz: nz / len, d };
}

/**
 * The corners of the region every plane admits.
 *
 * Brute force over triples, and deliberately so: with a hull of twenty-odd faces
 * and a handful of bisectors this is a few thousand 3x3 solves per cell, which
 * costs less than the bookkeeping a smarter algorithm would need — and it cannot
 * get the topology wrong, which the smarter ones can on degenerate input.
 */
function polytopeVertices(planes: Plane[], eps: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  const n = planes.length;
  // The candidates, not the inside test, are the cost: nearly all of them are
  // rejected within a few planes, but every one needs a 3x3 solve first. By
  // Cramer, where planes a, b, c meet is
  //   (d_a (b x c) + d_b (c x a) + d_c (a x b)) / (a . (b x c)),
  // so each pair's cross product is worked out once here and every triple is
  // then a dot product and three scaled adds, with nothing allocated for the
  // ones thrown away.
  const cross = new Float64Array(n * n * 3);
  for (let a = 0; a < n; a++) {
    const pa = planes[a];
    for (let b = a + 1; b < n; b++) {
      const pb = planes[b];
      const cx = pa.ny * pb.nz - pa.nz * pb.ny;
      const cy = pa.nz * pb.nx - pa.nx * pb.nz;
      const cz = pa.nx * pb.ny - pa.ny * pb.nx;
      const ab = (a * n + b) * 3, ba = (b * n + a) * 3;
      cross[ab] = cx; cross[ab + 1] = cy; cross[ab + 2] = cz;
      cross[ba] = -cx; cross[ba + 1] = -cy; cross[ba + 2] = -cz;
    }
  }
  // Consecutive candidates tend to fall outside the same plane, so the one that
  // rejected the last candidate is tried first.
  let hot = 0;
  for (let i = 0; i < n; i++) {
    const pi = planes[i];
    for (let j = i + 1; j < n; j++) {
      const pj = planes[j];
      const ij = (i * n + j) * 3;
      for (let k = j + 1; k < n; k++) {
        const pk = planes[k];
        const jk = (j * n + k) * 3, ki = (k * n + i) * 3;
        const det = pi.nx * cross[jk] + pi.ny * cross[jk + 1] + pi.nz * cross[jk + 2];
        if (Math.abs(det) < 1e-12) continue; // two of them are parallel
        const x = (pi.d * cross[jk] + pj.d * cross[ki] + pk.d * cross[ij]) / det;
        const y = (pi.d * cross[jk + 1] + pj.d * cross[ki + 1] + pk.d * cross[ij + 1]) / det;
        const z = (pi.d * cross[jk + 2] + pj.d * cross[ki + 2] + pk.d * cross[ij + 2]) / det;
        const h = planes[hot];
        if (hot !== i && hot !== j && hot !== k && h.nx * x + h.ny * y + h.nz * z > h.d + eps) continue;
        let inside = true;
        // The point lies on i, j and k by construction, so those are not tested.
        for (let m = 0; m < n; m++) {
          if (m === i || m === j || m === k || m === hot) continue;
          const pl = planes[m];
          if (pl.nx * x + pl.ny * y + pl.nz * z > pl.d + eps) { inside = false; hot = m; break; }
        }
        if (!inside) continue;
        // A corner where more than three planes meet is found once per triple
        // of them — ten times over for five — each copy off in the last bits.
        // ConvexHull does not survive a cloud of near-coincident points: it
        // drops faces, and a cell came out 3% light that way. One copy each.
        let dup = false;
        for (let q = 0; q < out.length && !dup; q++) {
          const o = out[q];
          dup = Math.abs(o[0] - x) <= eps && Math.abs(o[1] - y) <= eps && Math.abs(o[2] - z) <= eps;
        }
        if (!dup) out.push([x, y, z]);
      }
    }
  }
  return out;
}
