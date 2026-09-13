// ---------------------------------------------------------------------------
// Booleans on the cage itself
// ---------------------------------------------------------------------------
//
// Combining two lattice bodies used to concatenate their cages: every face of
// each, kept as it was. That is a JOIN, not a union. Where the two solids met
// or overlapped, both surfaces stayed in the model — a double wall buried down
// the seam, and the second body's corners still sitting inside the first. It
// passed every check the cage has, because every edge still had exactly two
// faces on it, and it was wrong in the way that matters: the thing you had was
// not the shape you asked for.
//
// So this does the real operation. The classic BSP polygon CSG — build a tree
// of each solid's faces, clip each against the other, and reassemble — chosen
// over the alternatives for one reason above all: IT KEEPS POLYGONS. A face
// neither solid cut stays the quad it was drawn as, which is what Catmull-Clark
// wants and what a triangle-soup kernel would have thrown away. (The app's other
// boolean, the OpenSCAD one in utils/csg.ts, is async, worker-bound and returns
// triangles; it is the right tool for the exported mesh and the wrong one here.)
//
// The grid is the one place this is not textbook. A cage vertex is three
// integers, and the intersection of two grid solids is not in general on the
// grid — a sloping face crossing an axis plane lands at a fraction. So the tree
// is walked in continuous space, where the arithmetic is well conditioned, and
// the result is rounded onto the grid once at the end. Original corners are
// already integers and do not move; only genuinely new corners do, by at most
// half a step — 0.05 mm at the finest grid, under anything the machines here
// can hold. Rounding can collapse a sliver, so degenerate faces are dropped
// rather than kept and left to fail somewhere later.
// ---------------------------------------------------------------------------

import {
  addFace, coordOf, createLattice, faceCount, faceNormal, facesAlong, isWatertight,
  orientFaces, removeFace, removeVertex, setCrease, vertexAt,
  type Lattice, type LatticeCoord,
} from './latticeMesh';

export type BooleanOp = 'union' | 'difference' | 'intersection';

/** A point in grid space. Fractional while the tree is being walked. */
type Vec = [number, number, number];

/**
 * How far off a plane a point may be and still count as on it.
 *
 * In GRID STEPS, and that is what makes it safe to be this loose: every input
 * corner is a whole number of steps, so nothing legitimate is ever a thousandth
 * of a step from a plane. The only things in that band are rounding noise from
 * the plane arithmetic itself.
 */
const EPSILON = 1e-5;

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec, b: Vec): Vec => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lerp = (a: Vec, b: Vec, t: number): Vec => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

interface Plane {
  normal: Vec;
  w: number;
}

/**
 * The plane of a polygon, by Newell's method.
 *
 * Newell rather than a cross product of the first two edges, for the same
 * reason `faceNormal` uses it: a cage face is allowed to be any polygon and is
 * not guaranteed convex, and the first corner of a concave one gives a normal
 * pointing the wrong way. A whole solid built on one flipped plane is a boolean
 * that quietly returns the wrong half.
 */
function planeOf(points: Vec[]): Plane | null {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1, z1] = points[i];
    const [x2, y2, z2] = points[(i + 1) % points.length];
    nx += (y1 - y2) * (z1 + z2);
    ny += (z1 - z2) * (x1 + x2);
    nz += (x1 - x2) * (y1 + y2);
  }
  const length = Math.hypot(nx, ny, nz);
  if (length < EPSILON) return null;
  const normal: Vec = [nx / length, ny / length, nz / length];
  return { normal, w: dot(normal, points[0]) };
}

interface Polygon {
  points: Vec[];
  plane: Plane;
}

const flip = (polygon: Polygon): Polygon => ({
  points: [...polygon.points].reverse(),
  plane: {
    normal: [-polygon.plane.normal[0], -polygon.plane.normal[1], -polygon.plane.normal[2]],
    w: -polygon.plane.w,
  },
});

const COPLANAR = 0;
const FRONT = 1;
const BACK = 2;
const SPANNING = 3;

/**
 * Cuts a polygon by a plane, dropping each piece into the right bucket.
 *
 * The heart of the algorithm, and the only part where a cage's habits matter.
 * Coplanar faces are COMMON here, not a corner case: two parts butted together
 * share a wall exactly, because both were drawn on the same grid. That is why
 * the coplanar pieces are sorted by which way they face rather than lumped in
 * with the front — a shared wall has one face pointing each way, and it is the
 * facing that decides which of them survives the operation.
 */
function splitPolygon(
  plane: Plane,
  polygon: Polygon,
  coplanarFront: Polygon[],
  coplanarBack: Polygon[],
  front: Polygon[],
  back: Polygon[],
) {
  let polygonType = 0;
  const types: number[] = [];
  for (const point of polygon.points) {
    const t = dot(plane.normal, point) - plane.w;
    const type = t < -EPSILON ? BACK : t > EPSILON ? FRONT : COPLANAR;
    polygonType |= type;
    types.push(type);
  }

  switch (polygonType) {
    case COPLANAR:
      (dot(plane.normal, polygon.plane.normal) > 0 ? coplanarFront : coplanarBack).push(polygon);
      return;
    case FRONT:
      front.push(polygon);
      return;
    case BACK:
      back.push(polygon);
      return;
    default: {
      const f: Vec[] = [];
      const b: Vec[] = [];
      for (let i = 0; i < polygon.points.length; i++) {
        const j = (i + 1) % polygon.points.length;
        const ti = types[i];
        const tj = types[j];
        const vi = polygon.points[i];
        const vj = polygon.points[j];
        if (ti !== BACK) f.push(vi);
        if (ti !== FRONT) b.push(ti !== BACK ? [...vi] as Vec : vi);
        if ((ti | tj) === SPANNING) {
          const t = (plane.w - dot(plane.normal, vi)) / dot(plane.normal, sub(vj, vi));
          const cut = lerp(vi, vj, t);
          f.push(cut);
          b.push([...cut] as Vec);
        }
      }
      // A piece with fewer than three corners is the polygon grazing the plane
      // along one edge; it has no area and nothing downstream can use it.
      if (f.length >= 3) {
        const p = planeOf(f);
        if (p) front.push({ points: f, plane: polygon.plane });
      }
      if (b.length >= 3) {
        const p = planeOf(b);
        if (p) back.push({ points: b, plane: polygon.plane });
      }
    }
  }
}

/**
 * A node of the BSP tree: a dividing plane, the faces lying in it, and the two
 * half-spaces either side.
 *
 * Cages are small — hundreds of faces, not the hundreds of thousands a
 * subdivided mesh runs to — so the recursion here is bounded by something a
 * person drew, and the tree is rebuilt from scratch on every operation rather
 * than cached. The thing being combined is the CAGE, never the smoothed mesh.
 */
class Node {
  plane: Plane | null = null;
  front: Node | null = null;
  back: Node | null = null;
  polygons: Polygon[] = [];

  constructor(polygons?: Polygon[]) {
    if (polygons && polygons.length > 0) this.build(polygons);
  }

  invert() {
    this.polygons = this.polygons.map(flip);
    if (this.plane) {
      this.plane = {
        normal: [-this.plane.normal[0], -this.plane.normal[1], -this.plane.normal[2]],
        w: -this.plane.w,
      };
    }
    this.front?.invert();
    this.back?.invert();
    const swap = this.front;
    this.front = this.back;
    this.back = swap;
  }

  /** The parts of these polygons that lie outside this node's solid. */
  clipPolygons(polygons: Polygon[]): Polygon[] {
    if (!this.plane) return [...polygons];
    let front: Polygon[] = [];
    let back: Polygon[] = [];
    for (const polygon of polygons) {
      splitPolygon(this.plane, polygon, front, back, front, back);
    }
    if (this.front) front = this.front.clipPolygons(front);
    // No back child means everything behind this plane is inside the solid, so
    // it is dropped. This one line is where a boolean actually removes material.
    back = this.back ? this.back.clipPolygons(back) : [];
    return [...front, ...back];
  }

  clipTo(other: Node) {
    this.polygons = other.clipPolygons(this.polygons);
    this.front?.clipTo(other);
    this.back?.clipTo(other);
  }

  allPolygons(): Polygon[] {
    const out = [...this.polygons];
    if (this.front) out.push(...this.front.allPolygons());
    if (this.back) out.push(...this.back.allPolygons());
    return out;
  }

  build(polygons: Polygon[]) {
    if (polygons.length === 0) return;
    if (!this.plane) this.plane = polygons[0].plane;
    const front: Polygon[] = [];
    const back: Polygon[] = [];
    for (const polygon of polygons) {
      splitPolygon(this.plane, polygon, this.polygons, this.polygons, front, back);
    }
    if (front.length > 0) {
      this.front ??= new Node();
      this.front.build(front);
    }
    if (back.length > 0) {
      this.back ??= new Node();
      this.back.build(back);
    }
  }
}

/** Every face of a cage as a polygon in grid space. */
function polygonsOf(lattice: Lattice): Polygon[] {
  const out: Polygon[] = [];
  for (const verts of lattice.faces) {
    if (!verts || verts.length < 3) continue;
    const points = verts.map((v) => coordOf(lattice, v) as Vec);
    const plane = planeOf(points);
    if (plane) out.push({ points, plane });
  }
  return out;
}

/** The creases of a cage, as the two ends of each edge in grid space. */
function creaseSegments(lattice: Lattice): [Vec, Vec][] {
  const out: [Vec, Vec][] = [];
  for (const key of lattice.creases) {
    const [a, b] = key.split(':').map(Number);
    out.push([coordOf(lattice, a) as Vec, coordOf(lattice, b) as Vec]);
  }
  return out;
}

/** Whether a point lies on the segment from `a` to `b`, within a whisker. */
function onSegment(point: Vec, a: Vec, b: Vec): boolean {
  const along = sub(b, a);
  const length = Math.hypot(...along);
  if (length < EPSILON) return false;
  const offset = sub(point, a);
  const t = dot(offset, along) / (length * length);
  if (t < -EPSILON || t > 1 + EPSILON) return false;
  return Math.hypot(...cross(offset, along)) / length < 1e-3;
}

const sameCoord = (a: LatticeCoord, b: LatticeCoord) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/**
 * Puts back every corner that landed in the middle of somebody else's edge.
 *
 * The one thing a BSP boolean leaves behind, and the one thing a cage cannot
 * live with. When a cut crosses a face it splits that face's edge in two and
 * gives the halves a new corner in the middle — but the face on the OTHER side
 * of that edge was not cut, so it still runs the whole length in one step. The
 * surface is closed to look at and broken to count: the two halves have one
 * face each instead of two, so `isWatertight` says no, no edge loop runs
 * through there, a crease stops halfway, and a bevel along it refuses.
 *
 * Fixing it is inserting the middle corner into the long edge as well. The
 * arithmetic is EXACT because everything has been rounded onto the grid first —
 * collinearity is a cross product of integers being zero, with no tolerance to
 * choose and nothing to get wrong near a corner.
 */
function weldTJunctions(rings: LatticeCoord[][]): LatticeCoord[][] {
  const corners: LatticeCoord[] = [];
  const seen = new Set<string>();
  for (const ring of rings) {
    for (const c of ring) {
      const key = `${c[0]},${c[1]},${c[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      corners.push(c);
    }
  }

  return rings.map((ring) => {
    const out: LatticeCoord[] = [];
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      out.push(p);

      const d: LatticeCoord = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
      const span = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
      if (span === 0) continue;

      const between: { coord: LatticeCoord; t: number }[] = [];
      for (const c of corners) {
        const e: LatticeCoord = [c[0] - p[0], c[1] - p[1], c[2] - p[2]];
        const t = e[0] * d[0] + e[1] * d[1] + e[2] * d[2];
        // Strictly between, so the two ends are never re-added.
        if (t <= 0 || t >= span) continue;
        if (e[1] * d[2] - e[2] * d[1] !== 0) continue;
        if (e[2] * d[0] - e[0] * d[2] !== 0) continue;
        if (e[0] * d[1] - e[1] * d[0] !== 0) continue;
        between.push({ coord: c, t });
      }
      between.sort((a, b) => a.t - b.t);
      for (const { coord } of between) out.push(coord);
    }

    // A corner that was already elsewhere in the ring would make a face that
    // visits one vertex twice, which is worse than the T-junction it fixes.
    const keys = out.map((c) => `${c[0]},${c[1]},${c[2]}`);
    return new Set(keys).size === keys.length ? out : ring;
  });
}

/**
 * Turns the polygons back into a cage, on the grid.
 *
 * Three things have to happen here and the order matters. Corners round to the
 * nearest grid point — originals do not move, only the ones the cut invented.
 * Runs of corners that rounded onto the same point collapse, because a face
 * that visits one vertex twice is a face the evaluator cannot make sense of.
 * And what is left is only kept if it still has three distinct corners and some
 * area: a sliver that rounded flat is not a face, it is a crack waiting to be
 * found by an exporter.
 */
function cageFrom(polygons: Polygon[], unit: number): Lattice {
  const lattice = createLattice(unit);

  const rings: LatticeCoord[][] = [];
  for (const polygon of polygons) {
    const ring: LatticeCoord[] = [];
    for (const point of polygon.points) {
      const coord: LatticeCoord = [Math.round(point[0]), Math.round(point[1]), Math.round(point[2])];
      if (ring.length > 0 && sameCoord(ring[ring.length - 1], coord)) continue;
      ring.push(coord);
    }
    while (ring.length > 1 && sameCoord(ring[0], ring[ring.length - 1])) ring.pop();
    if (ring.length < 3) continue;
    if (!planeOf(ring.map((c) => c as Vec))) continue; // rounded flat
    rings.push(ring);
  }

  for (const ring of weldTJunctions(rings)) {
    const verts = ring.map(([i, j, k]) => vertexAt(lattice, i, j, k));
    if (new Set(verts).size !== verts.length) continue; // folded back on itself
    addFace(lattice, verts);
  }

  return lattice;
}

/**
 * Puts the sharp edges back, wherever an edge of the result runs along one.
 *
 * ALONG, not between: a boolean cuts edges and then the seam tidy-up joins them
 * up again, so a rim that was sharp can come back as three short edges or as
 * one longer one than it started as. Matching on the line rather than on the
 * two end corners is what survives both.
 *
 * Run last, after the seam has been tidied. Applied any earlier and the tidying
 * removes the very edges the creases were put on, and `removeFace` prunes the
 * crease along with them — a rim that quietly goes soft, and shows itself only
 * once the shape is smoothed, as a dent.
 */
function applyCreases(lattice: Lattice, creases: [Vec, Vec][]) {
  for (const [a, b] of creases) {
    for (let f = 0; f < lattice.faces.length; f++) {
      const verts = lattice.faces[f];
      if (!verts) continue;
      for (let i = 0; i < verts.length; i++) {
        const p = coordOf(lattice, verts[i]) as Vec;
        const q = coordOf(lattice, verts[(i + 1) % verts.length]) as Vec;
        if (onSegment(p, a, b) && onSegment(q, a, b)) {
          setCrease(lattice, verts[i], verts[(i + 1) % verts.length], true);
        }
      }
    }
  }
}


// ---------------------------------------------------------------------------
// Tidying the seam
// ---------------------------------------------------------------------------

/** Whether two faces lie in the same plane, facing the same way. */
function samePlane(lattice: Lattice, f: number, g: number): boolean {
  const nf = faceNormal(lattice, f);
  const ng = faceNormal(lattice, g);
  if (!nf || !ng) return false;
  if (Math.abs(nf[0] - ng[0]) > 1e-9 || Math.abs(nf[1] - ng[1]) > 1e-9 || Math.abs(nf[2] - ng[2]) > 1e-9) return false;
  const a = coordOf(lattice, lattice.faces[f]![0]);
  const b = coordOf(lattice, lattice.faces[g]![0]);
  const offset = nf[0] * (b[0] - a[0]) + nf[1] * (b[1] - a[1]) + nf[2] * (b[2] - a[2]);
  return Math.abs(offset) < 1e-9;
}

/**
 * The run of edges two faces have in common, as the corners along it.
 *
 * A seam is rarely one edge. Where a boolean has cut across a face, the piece
 * that survives meets its neighbour along a RUN of two, three, a dozen edges —
 * and the whole run has to go at once, because removing one edge of it would
 * leave the rest as a slit through the middle of the merged face.
 *
 * Null unless the shared edges form ONE unbroken run. Two faces meeting along
 * two separate runs wrap around something between them, and splicing those
 * gives a ring that passes through the same corner twice.
 */
function sharedRun(a: number[], b: number[]): number[] | null {
  const shares = a.map((p, i) => {
    const q = a[(i + 1) % a.length];
    return b.some((r, j) => {
      const s = b[(j + 1) % b.length];
      return (p === r && q === s) || (p === s && q === r);
    });
  });
  const count = shares.filter(Boolean).length;
  if (count === 0 || count === a.length) return null;

  // The start of the run is the shared edge whose predecessor is not shared;
  // with at least one of each there is exactly one such place if the run is
  // unbroken, and more than one if it is not.
  const starts = shares
    .map((yes, i) => (yes && !shares[(i - 1 + a.length) % a.length] ? i : -1))
    .filter((i) => i !== -1);
  if (starts.length !== 1) return null;

  const run: number[] = [a[starts[0]]];
  for (let n = 0; n < count; n++) run.push(a[(starts[0] + n + 1) % a.length]);
  return run;
}

/**
 * Two polygons sharing a run of edges, spliced into one.
 *
 * Each ring is walked from the far end of the run all the way round to the near
 * end, so the run's interior corners are left out entirely — which is the point:
 * they are corners of nothing once the two faces are one, and leaving them is
 * what "the vertices did not collapse" looks like.
 */
function spliceRings(a: number[], b: number[], run: number[]): number[] | null {
  const k = run.length - 1;
  const first = run[0];
  const last = run[k];
  const i = a.indexOf(first);
  const j = b.indexOf(last);
  if (i === -1 || j === -1 || k < 1) return null;
  // The run has to read forwards along a and backwards along b, or these are
  // not the two sides of one seam.
  for (let n = 0; n <= k; n++) {
    if (a[(i + n) % a.length] !== run[n]) return null;
    if (b[(j + n) % b.length] !== run[k - n]) return null;
  }

  const ring: number[] = [];
  for (let n = 0; n <= a.length - k; n++) ring.push(a[(i + k + n) % a.length]);
  for (let n = k + 1; n < b.length; n++) ring.push(b[(j + n) % b.length]);
  if (ring.length < 3) return null;
  return new Set(ring).size === ring.length ? ring : null;
}

/** Whether the edge p-q lies along one of these sharp segments. */
function isSharp(p: Vec, q: Vec, sharp: [Vec, Vec][]): boolean {
  return sharp.some(([a, b]) => onSegment(p, a, b) && onSegment(q, a, b));
}

/**
 * Joins faces that lie in the same plane and share an edge.
 *
 * A boolean leaves the seam as a row of separate faces: butt two boxes together
 * and the top of the result is the top of each of them, meeting along a line
 * that is no longer an edge of anything. It is a correct surface and it is not
 * the cage anybody would have drawn, and it is the thing that gets reported —
 * "the vertices are still there".
 *
 * Only faces sharing EXACTLY ONE edge are joined. Two that meet along two
 * separate edges wrap round something between them, and splicing those gives a
 * ring that passes through the same corner twice.
 */
export function mergeCoplanarFaces(lattice: Lattice, sharp: [Vec, Vec][] = []): number {
  let merged = 0;
  for (;;) {
    let joined = false;
    for (let f = 0; f < lattice.faces.length && !joined; f++) {
      const a = lattice.faces[f];
      if (!a) continue;
      for (let i = 0; i < a.length && !joined; i++) {
        const g = facesAlong(lattice, a[i], a[(i + 1) % a.length]).find((other) => other !== f);
        if (g === undefined) continue;
        const b = lattice.faces[g];
        if (!b || !samePlane(lattice, f, g)) continue;
        const run = sharedRun(a, b);
        if (!run) continue;
        // A sharp edge is an edge somebody asked for. Two faces either side of
        // one are two faces on purpose, however flat the pair of them is.
        if (run.some((v, n) => n > 0 && isSharp(
          coordOf(lattice, run[n - 1]) as Vec, coordOf(lattice, v) as Vec, sharp,
        ))) continue;
        const ring = spliceRings(a, b, run);
        if (!ring) continue;
        const touched = [...new Set([...a, ...b])];
        removeFace(lattice, f);
        removeFace(lattice, g);
        if (addFace(lattice, ring) !== -1) merged++;
        // The run's interior corners now belong to nothing. Left behind they
        // are loose numbers in the cage that no face, edge loop or selection
        // can reach — and they are exactly what somebody means by "the
        // vertices did not collapse".
        for (const v of touched) {
          if ((lattice.vertexFaces.get(v)?.size ?? 0) === 0) removeVertex(lattice, v);
        }
        joined = true;
      }
    }
    if (!joined) return merged;
  }
}

/**
 * Removes corners that are no longer corners.
 *
 * After the seam faces are joined, the old ends of the seam are left sitting in
 * the middle of a straight edge with exactly two faces on them. They are not
 * edges of anything, nothing can be selected or dragged by them, and they are
 * precisely the "overlapped vertices" a person expects a join to have tidied
 * away. A corner with three or more faces on it is a real corner and is left
 * alone however flat it looks.
 */
export function dissolveCollinearCorners(lattice: Lattice, sharp: [Vec, Vec][] = []): number {
  let dissolved = 0;
  for (;;) {
    let dropped = false;
    for (const [vertex, users] of [...lattice.vertexFaces]) {
      if (users.size !== 2) continue;
      const faces = [...users];
      const rings = faces.map((f) => lattice.faces[f]);
      if (rings.some((r) => !r || r.length <= 3)) continue;

      let mixedSharpness = false;
      const straight = rings.every((ring) => {
        const n = ring!.indexOf(vertex);
        const before = coordOf(lattice, ring![(n - 1 + ring!.length) % ring!.length]);
        const here = coordOf(lattice, vertex);
        const after = coordOf(lattice, ring![(n + 1) % ring!.length]);
        const d: LatticeCoord = [here[0] - before[0], here[1] - before[1], here[2] - before[2]];
        const e: LatticeCoord = [after[0] - here[0], after[1] - here[1], after[2] - here[2]];
        // One side sharp and the other soft is a corner that is doing a job:
        // dissolving it would run the two together and the whole length would
        // have to be one or the other. A rim that goes soft for half its length
        // shows itself only after smoothing, as a dent.
        if (isSharp(before as Vec, here as Vec, sharp) !== isSharp(here as Vec, after as Vec, sharp)) {
          mixedSharpness = true;
        }
        return d[1] * e[2] - d[2] * e[1] === 0
          && d[2] * e[0] - d[0] * e[2] === 0
          && d[0] * e[1] - d[1] * e[0] === 0
          && d[0] * e[0] + d[1] * e[1] + d[2] * e[2] > 0;
      });
      if (!straight || mixedSharpness) continue;

      const without = rings.map((ring) => ring!.filter((v) => v !== vertex));
      for (const f of faces) removeFace(lattice, f);
      for (const ring of without) addFace(lattice, ring);
      removeVertex(lattice, vertex);
      dissolved++;
      dropped = true;
      break;
    }
    if (!dropped) return dissolved;
  }
}

/**
 * Union, difference or intersection of two cages, as a new cage.
 *
 * Both must be CLOSED. A boolean asks which side of a surface a point is on,
 * and an open shell has no answer — run it on one and the result is not a
 * near-miss, it is arbitrary. The cage already knows (`isWatertight`), so this
 * refuses rather than producing something that looks plausible and is not.
 *
 * `b` is expected in `a`'s coordinates already: getting the two into one frame
 * is the caller's job, because only the caller knows where the two bodies sit.
 */
export function latticeBoolean(a: Lattice, b: Lattice, op: BooleanOp): Lattice | null {
  if (faceCount(a) === 0 || faceCount(b) === 0) return null;
  if (!isWatertight(a) || !isWatertight(b)) return null;

  const nodeA = new Node(polygonsOf(a));
  const nodeB = new Node(polygonsOf(b));

  // The standard recipes. Each is "clip both trees against each other, with
  // whichever inversions turn the operation into a union", which is why they
  // look so alike and why getting one inversion wrong gives a shape that is
  // almost right.
  if (op === 'union') {
    nodeA.clipTo(nodeB);
    nodeB.clipTo(nodeA);
    nodeB.invert();
    nodeB.clipTo(nodeA);
    nodeB.invert();
    nodeA.build(nodeB.allPolygons());
  } else if (op === 'difference') {
    nodeA.invert();
    nodeA.clipTo(nodeB);
    nodeB.clipTo(nodeA);
    nodeB.invert();
    nodeB.clipTo(nodeA);
    nodeB.invert();
    nodeA.build(nodeB.allPolygons());
    nodeA.invert();
  } else {
    nodeA.invert();
    nodeB.clipTo(nodeA);
    nodeB.invert();
    nodeA.clipTo(nodeB);
    nodeB.clipTo(nodeA);
    nodeA.build(nodeB.allPolygons());
    nodeA.invert();
  }

  const result = cageFrom(nodeA.allPolygons(), a.unit);
  if (faceCount(result) === 0) return null;

  // The recipes above flip whole subtrees, so the winding of what comes out
  // follows the arithmetic rather than the shape. Let the piece decide — and
  // again after the seam is tidied, because splicing two faces into one and
  // dropping corners out of the middle of edges both rewrite face rings.
  orientFaces(result);
  // The sharp edges are carried through the tidy-up as GEOMETRY rather than as
  // creases on the cage. They cannot be creases yet: joining two faces removes
  // the edge between them for a moment, and `removeFace` prunes any crease on
  // an edge nothing runs along — so a crease set now would be tidied away by
  // the very pass that has to know about it.
  const sharp: [Vec, Vec][] = [...creaseSegments(a), ...creaseSegments(b)];
  mergeCoplanarFaces(result, sharp);
  dissolveCollinearCorners(result, sharp);
  orientFaces(result);
  applyCreases(result, sharp);
  return result;
}
