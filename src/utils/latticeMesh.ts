// ---------------------------------------------------------------------------
// Lattice modelling
// ---------------------------------------------------------------------------
//
// The third way to make a shape in this app, and the one the other two leave a
// hole for. Primitives and CSG make what can be described; the sculpt tools in
// utils/sculptMesh.ts make what can be pushed into being. Neither makes a
// crisp, dimensioned, hard-surface part — the sort of thing where it matters
// that two faces are exactly 40 mm apart and that an edge is straight.
//
// So this is box modelling: a field of points on a regular grid, and a shape
// built by connecting them. Two decisions carry the whole file.
//
//   * A vertex is a TRIPLE OF INTEGERS, not a position. Snapping is then not a
//     rounding step that runs on input, it is the only state that exists —
//     two vertices are the same vertex when their integers match, mirroring is
//     `i -> -i` with no epsilon, and a coarse grid is the fine grid with a
//     bigger step rather than a second grid that nearly lines up with it. The
//     metric position exists only at the moment of emitting a mesh.
//
//   * Faces stay QUADS where they were drawn as quads. A quad mesh is what
//     Catmull-Clark subdivision wants (see utils/subdivide.ts); triangulating
//     on the way in would throw away the structure that makes a coarse cage
//     turn into a smooth surface, and put a pole at every vertex.
//
// Coordinates are Z-up metres once multiplied by `unit`, matching
// `SculptMesh` and utils/stlParser.ts; `toSceneGeom` emits the Y-up copy the
// renderer wants alongside them, so nothing downstream has to know a mesh was
// built this way.
// ---------------------------------------------------------------------------

import { subdivide, type PolyMesh } from './subdivide';
import { solidify } from './solidify';

/** Where a lattice vertex is, in whole grid steps from the body origin. */
export type LatticeCoord = [number, number, number];

export interface Lattice {
  /**
   * Metres per grid step — the FINEST step. Coarser snapping is a multiple of
   * this (see `SNAP_MULTIPLES`) rather than a unit of its own, which is what
   * keeps a coarsely placed vertex exactly on top of a finely placed one
   * instead of a micron away from it.
   */
  unit: number;
  /** Three integers per vertex. Length is `vertexCount * 3`. */
  coords: number[];
  /** "i,j,k" -> vertex index, so placing on an occupied node reuses it. */
  index: Map<string, number>;
  /**
   * Vertex indices per face, 3 or 4 of them, wound counter-clockwise seen from
   * outside. A hole is a tombstone rather than a splice: face indices are
   * referred to by the selection, the adjacency and the undo history, and
   * renumbering them behind those is how a selection ends up pointing at
   * somebody else's face.
   */
  faces: (number[] | null)[];
  /** vertex index -> the faces using it. Maintained as faces come and go. */
  vertexFaces: Map<number, Set<number>>;
  /**
   * Edges that stay sharp when the cage is smoothed, as "lower:higher" vertex
   * indices.
   *
   * Without these, smoothing is all or nothing: every level of Catmull-Clark
   * rounds every edge, so a cage either stays a faceted box or becomes a
   * pebble. Almost nothing anybody wants to make is one of those. A bracket is
   * flat faces with rounded corners; a housing is a curved shell with a crisp
   * rim. A crease is what lets one cage be both.
   */
  creases: Set<string>;
  /** Bumped on any change, so caches can tell one cage from another. */
  revision: number;
}

/**
 * The snap steps offered, as multiples of `unit`: 0.1 mm, 1 mm, 10 mm, 100 mm.
 *
 * Each is a whole multiple of the one below it, and that is the requirement
 * rather than a preference. Two steps that share only every sixth point put a
 * face drawn on one and a face drawn on the other along an edge whose endpoints
 * are not the same vertices — a crack, and one that survives all the way to the
 * exported STL. Decades nest exactly, so a 100 mm corner is also a 0.1 mm
 * corner and the coarse work can be refined without rebuilding it.
 */
export const SNAP_MULTIPLES = [1, 10, 100, 1000] as const;
export type SnapMultiple = (typeof SNAP_MULTIPLES)[number];

/**
 * Metres per grid step: 0.1 mm, the finest thing the snapping offers.
 *
 * The lattice is integers, so the fine end costs nothing to have — a 100 mm
 * step is just a stride of a thousand — and it means a part laid out in
 * hundreds of millimetres can still be detailed in tenths without any of the
 * earlier work having to move.
 */
export const DEFAULT_UNIT = 0.0001;

export type Axis = 'x' | 'y' | 'z';

/**
 * What a click does. Named here rather than in the UI because each one is an
 * operation this module implements, not a mode the UI invents.
 */
export type LatticeTool = 'place' | 'select' | 'extrude';

export const AXIS_INDEX: Record<Axis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function createLattice(unit = DEFAULT_UNIT): Lattice {
  return {
    unit,
    coords: [],
    index: new Map(),
    faces: [],
    vertexFaces: new Map(),
    creases: new Set(),
    revision: 0,
  };
}

const key = (i: number, j: number, k: number) => `${i},${j},${k}`;

/**
 * The shape a new lattice body starts as: a box, centred on the body origin.
 *
 * A box rather than a single face, because the first thing anybody does here is
 * push a side out, and that needs a side to push. It is also the honest
 * demonstration of the mode — six quads that subdivide into a rounded solid,
 * so the relationship between the cage and the shape is visible before any work
 * has been put in. 200 steps of 0.1 mm makes it 40 mm across: a bench-scale
 * part, and a whole number of the 10 mm steps the grid starts on.
 */
export function boxLattice(unit = DEFAULT_UNIT, halfSteps = 200): Lattice {
  const lattice = createLattice(unit);
  const h = Math.max(1, Math.round(halfSteps));
  const v = (i: number, j: number, k: number) => vertexAt(lattice, i * h, j * h, k * h);
  addFace(lattice, [v(-1, -1, -1), v(-1, 1, -1), v(1, 1, -1), v(1, -1, -1)]);
  addFace(lattice, [v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1), v(-1, 1, 1)]);
  addFace(lattice, [v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1), v(-1, -1, 1)]);
  addFace(lattice, [v(-1, 1, -1), v(-1, 1, 1), v(1, 1, 1), v(1, 1, -1)]);
  addFace(lattice, [v(-1, -1, -1), v(-1, -1, 1), v(-1, 1, 1), v(-1, 1, -1)]);
  addFace(lattice, [v(1, -1, -1), v(1, 1, -1), v(1, 1, 1), v(1, -1, 1)]);
  return lattice;
}

export function vertexCount(lattice: Lattice): number {
  return lattice.coords.length / 3;
}

/** How many faces are actually there, tombstones not counted. */
export function faceCount(lattice: Lattice): number {
  let n = 0;
  for (const face of lattice.faces) if (face) n++;
  return n;
}

export function coordOf(lattice: Lattice, vertex: number): LatticeCoord {
  return [
    lattice.coords[vertex * 3],
    lattice.coords[vertex * 3 + 1],
    lattice.coords[vertex * 3 + 2],
  ];
}

/** The vertex at these grid coordinates, or -1 if nothing has been placed. */
export function findVertex(lattice: Lattice, i: number, j: number, k: number): number {
  const found = lattice.index.get(key(i, j, k));
  return found === undefined ? -1 : found;
}

/** The vertex at these grid coordinates, placing one if there is not one yet. */
export function vertexAt(lattice: Lattice, i: number, j: number, k: number): number {
  const existing = lattice.index.get(key(i, j, k));
  if (existing !== undefined) return existing;
  const vertex = vertexCount(lattice);
  lattice.coords.push(i, j, k);
  lattice.index.set(key(i, j, k), vertex);
  lattice.revision++;
  return vertex;
}

// ---------------------------------------------------------------------------
// Faces
// ---------------------------------------------------------------------------

/**
 * The cycle in a canonical form, so that the same ring of vertices drawn from a
 * different corner, or in the other direction, is recognised as the same face.
 *
 * Direction is included deliberately: a face and its flip are the same ring but
 * opposite surfaces, and quietly treating a re-draw as a duplicate would take
 * away the only way to fix a face that came out inside-out.
 */
function cycleKey(verts: number[]): string {
  let start = 0;
  for (let i = 1; i < verts.length; i++) if (verts[i] < verts[start]) start = i;
  const rotated: number[] = [];
  for (let i = 0; i < verts.length; i++) rotated.push(verts[(start + i) % verts.length]);
  return rotated.join(',');
}

/** The face using exactly this cycle, or -1. */
export function findFace(lattice: Lattice, verts: number[]): number {
  const wanted = cycleKey(verts);
  for (let f = 0; f < lattice.faces.length; f++) {
    const face = lattice.faces[f];
    if (face && face.length === verts.length && cycleKey(face) === wanted) return f;
  }
  return -1;
}

function link(lattice: Lattice, face: number, verts: number[]) {
  for (const v of verts) {
    let set = lattice.vertexFaces.get(v);
    if (!set) {
      set = new Set();
      lattice.vertexFaces.set(v, set);
    }
    set.add(face);
  }
}

function unlink(lattice: Lattice, face: number, verts: number[]) {
  for (const v of verts) lattice.vertexFaces.get(v)?.delete(face);
}

/**
 * Adds a face through these vertices, in order.
 *
 * Returns the face index, or -1 if it was refused. A face is refused when it
 * has fewer than three corners, repeats a corner, or already exists with this
 * winding — all three are things a click can produce and none of them is worth
 * an error dialog.
 */
export function addFace(lattice: Lattice, verts: number[]): number {
  if (verts.length < 3) return -1;
  if (new Set(verts).size !== verts.length) return -1;
  if (findFace(lattice, verts) !== -1) return -1;

  const face = [...verts];
  const index = lattice.faces.length;
  lattice.faces.push(face);
  link(lattice, index, face);
  lattice.revision++;
  return index;
}

export function removeFace(lattice: Lattice, face: number): boolean {
  const verts = lattice.faces[face];
  if (!verts) return false;
  unlink(lattice, face, verts);
  lattice.faces[face] = null;
  // A crease on an edge nothing runs along any more is a stale pair of numbers;
  // it would come back to life pointing at the wrong edge the next time a face
  // happened to reuse those corners.
  pruneCreases(lattice);
  lattice.revision++;
  return true;
}

/** Turns a face inside out. The fix for one drawn from the wrong side. */
export function flipFace(lattice: Lattice, face: number): boolean {
  const verts = lattice.faces[face];
  if (!verts) return false;
  verts.reverse();
  lattice.revision++;
  return true;
}

/**
 * Moves a vertex to different grid coordinates.
 *
 * Landing on an occupied node WELDS: the moved vertex is merged into the one
 * already there and any face that collapsed to fewer than three distinct
 * corners is dropped. That is what a modeller expects from dragging one corner
 * onto another, and refusing instead would leave two vertices at one point,
 * which looks identical and exports as a crack.
 */
export function moveVertex(lattice: Lattice, vertex: number, i: number, j: number, k: number): boolean {
  const [ci, cj, ck] = coordOf(lattice, vertex);
  if (ci === i && cj === j && ck === k) return false;

  const target = findVertex(lattice, i, j, k);
  if (target !== -1 && target !== vertex) {
    mergeVertex(lattice, vertex, target);
    return true;
  }

  lattice.index.delete(key(ci, cj, ck));
  lattice.coords[vertex * 3] = i;
  lattice.coords[vertex * 3 + 1] = j;
  lattice.coords[vertex * 3 + 2] = k;
  lattice.index.set(key(i, j, k), vertex);
  lattice.revision++;
  return true;
}

/**
 * Moves a whole set of corners by the same step, at once.
 *
 * Not a loop over `moveVertex`, and the difference matters: moved one at a
 * time, the first corner can land on the second's old position and weld to it,
 * so a selection dragged one step collapses instead of translating. So every
 * corner leaves the index first, then they all move, then they are put back —
 * and only then can a collision with a corner that ISN'T moving be a real weld.
 *
 * Two moving corners can never collide with each other: they share a
 * translation, so they stay as far apart as they started.
 */
export function moveVertices(lattice: Lattice, vertices: number[], di: number, dj: number, dk: number): boolean {
  if (di === 0 && dj === 0 && dk === 0) return false;
  const moving = [...new Set(vertices)].filter((v) => v >= 0 && v < vertexCount(lattice));
  if (moving.length === 0) return false;

  for (const v of moving) {
    const [i, j, k] = coordOf(lattice, v);
    if (lattice.index.get(key(i, j, k)) === v) lattice.index.delete(key(i, j, k));
  }

  for (const v of moving) {
    lattice.coords[v * 3] += di;
    lattice.coords[v * 3 + 1] += dj;
    lattice.coords[v * 3 + 2] += dk;
  }

  const welds: [number, number][] = [];
  for (const v of moving) {
    const [i, j, k] = coordOf(lattice, v);
    const occupant = lattice.index.get(key(i, j, k));
    if (occupant === undefined) lattice.index.set(key(i, j, k), v);
    else welds.push([v, occupant]);
  }
  for (const [from, into] of welds) mergeVertex(lattice, from, into);

  lattice.revision++;
  return true;
}

/** Rewrites every use of `from` as `into`, dropping faces that degenerate. */
function mergeVertex(lattice: Lattice, from: number, into: number) {
  const users = [...(lattice.vertexFaces.get(from) ?? [])];
  for (const f of users) {
    const verts = lattice.faces[f];
    if (!verts) continue;
    unlink(lattice, f, verts);
    // Collapse runs of the merged vertex: a quad with two corners welded is a
    // triangle, not a quad with a zero-length edge.
    const rewritten: number[] = [];
    for (const v of verts) {
      const mapped = v === from ? into : v;
      if (rewritten.length === 0 || rewritten[rewritten.length - 1] !== mapped) rewritten.push(mapped);
    }
    while (rewritten.length > 1 && rewritten[0] === rewritten[rewritten.length - 1]) rewritten.pop();

    if (rewritten.length < 3) {
      lattice.faces[f] = null;
      continue;
    }
    lattice.faces[f] = rewritten;
    link(lattice, f, rewritten);
  }
  lattice.vertexFaces.delete(from);

  // Creases follow the weld: an edge into the merged corner is now an edge into
  // the one it merged with, and an edge that collapsed to a point is gone.
  for (const key of [...lattice.creases]) {
    const [a, b] = key.split(':').map(Number);
    if (a !== from && b !== from) continue;
    lattice.creases.delete(key);
    const mapped = edgeKey(a === from ? into : a, b === from ? into : b);
    if (!mapped.startsWith(`${into}:${into}`)) lattice.creases.add(mapped);
  }
  pruneCreases(lattice);

  const [fi, fj, fk] = coordOf(lattice, from);
  // The orphan keeps its slot but leaves the index, so nothing finds it again
  // and no face index has to shift. `toSceneGeom` drops unused vertices anyway.
  if (lattice.index.get(key(fi, fj, fk)) === from) lattice.index.delete(key(fi, fj, fk));
  lattice.revision++;
}

/** Removes a vertex and every face that used it. */
export function removeVertex(lattice: Lattice, vertex: number): boolean {
  const users = lattice.vertexFaces.get(vertex);
  if (!users && findVertex(lattice, ...coordOf(lattice, vertex)) !== vertex) return false;
  for (const f of [...(users ?? [])]) removeFace(lattice, f);
  lattice.vertexFaces.delete(vertex);
  for (const key of [...lattice.creases]) {
    const [a, b] = key.split(':').map(Number);
    if (a === vertex || b === vertex) lattice.creases.delete(key);
  }
  const [i, j, k] = coordOf(lattice, vertex);
  if (lattice.index.get(key(i, j, k)) === vertex) lattice.index.delete(key(i, j, k));
  lattice.revision++;
  return true;
}

// ---------------------------------------------------------------------------
// Creases
// ---------------------------------------------------------------------------

/** The canonical key for an undirected edge. */
export const edgeKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

export function isCrease(lattice: Lattice, a: number, b: number): boolean {
  return lattice.creases.has(edgeKey(a, b));
}

/**
 * Marks an edge sharp, or lets it round off again.
 *
 * Refused for an edge no face uses: a crease on nothing would survive in the
 * saved cage as a pair of numbers that mean less and less as the shape around
 * them changes.
 */
export function setCrease(lattice: Lattice, a: number, b: number, sharp: boolean): boolean {
  if (a === b) return false;
  if (sharp && !edgeExists(lattice, a, b)) return false;
  const key = edgeKey(a, b);
  const had = lattice.creases.has(key);
  if (had === sharp) return false;
  if (sharp) lattice.creases.add(key);
  else lattice.creases.delete(key);
  lattice.revision++;
  return true;
}

/** Whether some face runs along this edge. */
export function edgeExists(lattice: Lattice, a: number, b: number): boolean {
  for (const f of lattice.vertexFaces.get(a) ?? []) {
    const verts = lattice.faces[f];
    if (!verts) continue;
    for (let i = 0; i < verts.length; i++) {
      const p = verts[i];
      const q = verts[(i + 1) % verts.length];
      if ((p === a && q === b) || (p === b && q === a)) return true;
    }
  }
  return false;
}

/** Every crease still attached to a face, as vertex pairs. */
export function creaseEdges(lattice: Lattice): number[] {
  const out: number[] = [];
  for (const key of lattice.creases) {
    const [a, b] = key.split(':').map(Number);
    if (edgeExists(lattice, a, b)) out.push(a, b);
  }
  return out;
}

/** The corners joined to this one by some face's edge. */
export function neighbours(lattice: Lattice, vertex: number): number[] {
  const found = new Set<number>();
  for (const f of lattice.vertexFaces.get(vertex) ?? []) {
    const verts = lattice.faces[f];
    if (!verts) continue;
    for (let i = 0; i < verts.length; i++) {
      if (verts[i] !== vertex) continue;
      found.add(verts[(i + 1) % verts.length]);
      found.add(verts[(i - 1 + verts.length) % verts.length]);
    }
  }
  return [...found];
}

/** The faces running along an edge — two on a closed surface, one on a border. */
export function facesAlong(lattice: Lattice, a: number, b: number): number[] {
  const found: number[] = [];
  for (const f of lattice.vertexFaces.get(a) ?? []) {
    const verts = lattice.faces[f];
    if (!verts) continue;
    for (let i = 0; i < verts.length; i++) {
      const p = verts[i];
      const q = verts[(i + 1) % verts.length];
      if ((p === a && q === b) || (p === b && q === a)) {
        found.push(f);
        break;
      }
    }
  }
  return found;
}

/**
 * Where an edge loop carries on, arriving at `vertex` along the edge from
 * `from`, or -1 where it stops.
 *
 * On a border it follows the border, which is the loop somebody means when they
 * point at the rim of an open shell. Inside the surface it takes the edge on
 * the far side of a four-way corner — the one sharing no face with the edge it
 * came in on — which is what makes a loop run straight on rather than turning
 * into whichever face happens to be next. Anywhere else, at a corner of three
 * or five edges, there is no "straight on" and the loop honestly ends.
 */
function continueLoop(lattice: Lattice, vertex: number, from: number): number {
  const around = neighbours(lattice, vertex);
  const arrivedOnBorder = facesAlong(lattice, from, vertex).length === 1;

  if (arrivedOnBorder) {
    const onward = around.filter((w) => w !== from && facesAlong(lattice, vertex, w).length === 1);
    return onward.length === 1 ? onward[0] : -1;
  }

  if (around.length !== 4) return -1;
  const arrivedFaces = new Set(facesAlong(lattice, from, vertex));
  const onward = around.filter((w) => w !== from && facesAlong(lattice, vertex, w).every((f) => !arrivedFaces.has(f)));
  return onward.length === 1 ? onward[0] : -1;
}

/**
 * The whole loop an edge belongs to.
 *
 * The reason to have it is that the interesting edges come in rings: the rim of
 * a shell, the top of a cylinder, the seam around a boss. Creasing one of those
 * an edge at a time is a dozen clicks that have to be got exactly right, and
 * missing one leaves a single soft edge in a hard rim — which shows up only
 * once the shape is smoothed, and looks like a dent.
 *
 * Always includes the edge given, and never repeats one, so a closed loop comes
 * back once round rather than for ever.
 */
export function edgeLoop(lattice: Lattice, a: number, b: number): [number, number][] {
  if (!edgeExists(lattice, a, b)) return [];
  const seen = new Set<string>([edgeKey(a, b)]);
  const loop: [number, number][] = [[a, b]];

  const walk = (from: number, to: number, append: boolean) => {
    let previous = from;
    let current = to;
    for (;;) {
      const next = continueLoop(lattice, current, previous);
      if (next === -1 || seen.has(edgeKey(current, next))) return;
      seen.add(edgeKey(current, next));
      if (append) loop.push([current, next]);
      else loop.unshift([next, current]);
      previous = current;
      current = next;
    }
  };

  walk(a, b, true);
  walk(b, a, false);
  return loop;
}

/** Drops creases whose edge no longer exists, after faces have been removed. */
function pruneCreases(lattice: Lattice) {
  for (const key of [...lattice.creases]) {
    const [a, b] = key.split(':').map(Number);
    if (!edgeExists(lattice, a, b)) lattice.creases.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Geometry of a face
// ---------------------------------------------------------------------------

/**
 * The face normal in lattice space, by Newell's method.
 *
 * Newell rather than a cross product of the first two edges because a face is
 * allowed to be a polygon and is not guaranteed convex; the first corner of a
 * concave one gives a normal pointing the wrong way.
 */
export function faceNormal(lattice: Lattice, face: number): [number, number, number] | null {
  const verts = lattice.faces[face];
  if (!verts) return null;
  let nx = 0, ny = 0, nz = 0;
  for (let a = 0; a < verts.length; a++) {
    const [x1, y1, z1] = coordOf(lattice, verts[a]);
    const [x2, y2, z2] = coordOf(lattice, verts[(a + 1) % verts.length]);
    nx += (y1 - y2) * (z1 + z2);
    ny += (z1 - z2) * (x1 + x2);
    nz += (x1 - x2) * (y1 + y2);
  }
  const length = Math.hypot(nx, ny, nz);
  if (length === 0) return null;
  return [nx / length, ny / length, nz / length];
}

/** The axis a face most nearly faces, and which way along it. */
export function dominantAxis(normal: [number, number, number]): { axis: Axis; sign: 1 | -1 } {
  const axes: Axis[] = ['x', 'y', 'z'];
  let best = 0;
  for (let a = 1; a < 3; a++) if (Math.abs(normal[a]) > Math.abs(normal[best])) best = a;
  return { axis: axes[best], sign: normal[best] >= 0 ? 1 : -1 };
}

/** Where a face's corners average out, in grid steps. Not necessarily integer. */
export function faceCentre(lattice: Lattice, face: number): [number, number, number] | null {
  const verts = lattice.faces[face];
  if (!verts) return null;
  let x = 0, y = 0, z = 0;
  for (const v of verts) {
    const c = coordOf(lattice, v);
    x += c[0]; y += c[1]; z += c[2];
  }
  return [x / verts.length, y / verts.length, z / verts.length];
}

// ---------------------------------------------------------------------------
// Extrude
// ---------------------------------------------------------------------------

/**
 * Pushes a face out along an axis, walling in the gap it leaves.
 *
 * This is the tool that makes the mode worth using: without it every vertex of
 * every side of a box is placed by hand, and a shape that takes four clicks in
 * a modeller takes forty here.
 *
 * The travel is a whole number of grid steps along an axis rather than along
 * the face's own normal, because a diagonal normal has no integer multiple that
 * lands on the grid, and a lattice vertex that is not on the lattice is the one
 * thing this file exists to prevent. `axis` defaults to whichever the face most
 * nearly points along.
 */
export function extrudeFace(
  lattice: Lattice,
  face: number,
  steps: number,
  axis?: Axis,
): { cap: number; sides: number[] } | null {
  const verts = lattice.faces[face];
  if (!verts || steps === 0) return null;

  const normal = faceNormal(lattice, face);
  if (!normal) return null;
  const dominant = dominantAxis(normal);
  const along = axis ?? dominant.axis;
  const a = AXIS_INDEX[along];
  // Along the face's own axis, "out" is where the normal points; along any
  // other, the sign the caller gave is the whole instruction.
  const travel = axis && axis !== dominant.axis ? steps : steps * dominant.sign;

  const moved = verts.map((v) => {
    const c = coordOf(lattice, v);
    c[a] += travel;
    return vertexAt(lattice, c[0], c[1], c[2]);
  });

  // The old face becomes the inside of the wall and stops being a surface: what
  // was the outside is now the cap, and leaving both would put a membrane
  // across the middle of the solid.
  removeFace(lattice, face);

  /*
    Which way round the new faces go.

    Pushed ALONG its normal, a face sweeps a solid that lies behind it, and the
    winding that made the original face outward makes the sides and the cap
    outward too. Pushed the other way — dragged back through the shape, or given
    a negative distance — the solid ends up on the other side of every one of
    those faces, and keeping the same winding turns the whole extrusion
    inside-out: it draws correctly in the editor, which is double-sided, and
    then loses half its faces the moment the ordinary renderer culls backfaces.

    So a backwards extrusion is wound backwards. This is not a matter of taste:
    an inside-out solid is one nothing downstream will accept.
  */
  const backwards = travel * normal[a] < 0;

  const sides: number[] = [];
  for (let i = 0; i < verts.length; i++) {
    const next = (i + 1) % verts.length;
    const wall = backwards
      ? [verts[next], verts[i], moved[i], moved[next]]
      : [verts[i], verts[next], moved[next], moved[i]];
    const added = addFace(lattice, wall);
    if (added !== -1) sides.push(added);
  }

  const cap = addFace(lattice, backwards ? [...moved].reverse() : moved);
  return { cap, sides };
}

// ---------------------------------------------------------------------------
// Bevel
// ---------------------------------------------------------------------------

/** The step from a to b reduced to its smallest whole form, or null if it is not one. */
function unitStep(from: LatticeCoord, to: LatticeCoord): { dir: LatticeCoord; length: number } | null {
  const delta: LatticeCoord = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const gcd = (a: number, b: number): number => (b === 0 ? Math.abs(a) : gcd(b, a % b));
  const divisor = delta.reduce((acc, d) => gcd(acc, d), 0);
  if (divisor === 0) return null;
  const dir = delta.map((d) => d / divisor) as LatticeCoord;
  // An edge along an axis or a true 45 degrees can be walked in whole steps; a
  // 2:1 slope cannot, and a corner cut off one would land between grid points.
  if (dir.some((d) => Math.abs(d) > 1)) return null;
  return { dir, length: divisor };
}

/**
 * Cuts the corners off a face, turning an n-gon into a 2n-gon.
 *
 * This is how a square becomes a circle. Smoothing rounds a four-cornered cage
 * into a rounded square and no amount of it will do better — the limit surface
 * of four corners is a squircle, and the roundness has to come from the cage.
 * Bevel a square into an octagon and smooth THAT, and it reads as a circle;
 * extrude it first and the result is a cylinder.
 *
 * Only for a face whose corners belong to nothing else. A corner shared with
 * another face cannot be replaced by two without tearing that face away from
 * this one, and stitching the tear is a different operation (a proper bevel of
 * a solid's edges) with different questions to answer.
 */
export function bevelFace(lattice: Lattice, face: number, steps: number): boolean {
  const verts = lattice.faces[face];
  if (!verts || steps <= 0) return false;
  if (verts.some((v) => (lattice.vertexFaces.get(v)?.size ?? 0) > 1)) return false;

  const ring = verts.map((v) => coordOf(lattice, v));
  const cut: LatticeCoord[] = [];

  for (let i = 0; i < ring.length; i++) {
    const previous = ring[(i - 1 + ring.length) % ring.length];
    const next = ring[(i + 1) % ring.length];
    const back = unitStep(ring[i], previous);
    const forward = unitStep(ring[i], next);
    if (!back || !forward) return false;
    // Cutting deeper than half an edge from both ends would cross over the
    // corner coming the other way and turn the ring inside out.
    if (steps * 2 > back.length || steps * 2 > forward.length) return false;
    cut.push(
      ring[i].map((c, k) => c + back.dir[k] * steps) as LatticeCoord,
      ring[i].map((c, k) => c + forward.dir[k] * steps) as LatticeCoord,
    );
  }

  const creased = verts.map((v, i) => isCrease(lattice, v, verts[(i + 1) % verts.length]));
  removeFace(lattice, face);
  for (const v of verts) removeVertex(lattice, v);

  const corners = cut.map(([i, j, k]) => vertexAt(lattice, i, j, k));
  const added = addFace(lattice, corners);
  if (added === -1) return false;

  // An edge that was sharp stays sharp: the cut leaves the middle of each
  // original edge intact, and it is the same edge as far as anybody looking at
  // it is concerned.
  for (let i = 0; i < verts.length; i++) {
    if (!creased[i]) continue;
    setCrease(lattice, corners[i * 2 + 1], corners[((i + 1) % verts.length) * 2], true);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Inset
// ---------------------------------------------------------------------------

/**
 * Shrinks a face inside itself, leaving a border of quads around it.
 *
 * The other half of bridging. Two whole walls of a box cannot be joined into a
 * tunnel — they share the edges of everything around them, and a band between
 * them would run along faces that are already there. What a tunnel needs is a
 * SMALLER face on each wall, and that is what this makes: the face is pulled in
 * by `steps` on both of its in-plane axes, the gap becomes a ring of quads, and
 * the shrunken face is left selected-shaped and ready to be pushed in, pulled
 * out, or bridged to another.
 *
 * It is also the whole answer to a hole in a plate: inset a face, delete what
 * is left in the middle.
 *
 * Only axis-aligned faces, because "inwards" for a face lying at an angle is a
 * direction with no exact answer on a grid, and a corner that lands between
 * grid points is the one thing this file exists to prevent.
 */
export function insetFace(lattice: Lattice, face: number, steps: number): { inner: number; border: number[] } | null {
  const verts = lattice.faces[face];
  if (!verts || steps === 0) return null;

  const normal = faceNormal(lattice, face);
  if (!normal) return null;
  const { axis } = dominantAxis(normal);
  const a = AXIS_INDEX[axis];
  // Anything but flat-on to an axis has no whole-number "inwards".
  if (Math.abs(normal[a]) < 0.999) return null;

  const centre = faceCentre(lattice, face)!;
  const moved: LatticeCoord[] = verts.map((v) => {
    const coord = coordOf(lattice, v);
    for (let k = 0; k < 3; k++) {
      if (k === a) continue;
      const away = coord[k] - centre[k];
      // A corner already on the centre line has no side to come in from, so it
      // stays: insetting a triangle moves two corners and pivots on the third.
      if (away === 0) continue;
      coord[k] += away > 0 ? -steps : steps;
    }
    return coord;
  });

  // Pulled in further than it is wide, the ring turns itself inside out.
  const seen = new Set(moved.map(([i, j, k]) => `${i},${j},${k}`));
  if (seen.size !== moved.length) return null;
  for (let i = 0; i < verts.length; i++) {
    const before = coordOf(lattice, verts[i]);
    const after = moved[i];
    for (let k = 0; k < 3; k++) {
      if (k === a) continue;
      const wasAway = before[k] - centre[k];
      const nowAway = after[k] - centre[k];
      if (wasAway !== 0 && Math.sign(nowAway) !== Math.sign(wasAway)) return null;
    }
  }

  const inner = moved.map(([i, j, k]) => vertexAt(lattice, i, j, k));
  removeFace(lattice, face);

  const border: number[] = [];
  for (let i = 0; i < verts.length; i++) {
    const next = (i + 1) % verts.length;
    const added = addFace(lattice, [verts[i], verts[next], inner[next], inner[i]]);
    if (added !== -1) border.push(added);
  }
  const innerFace = addFace(lattice, inner);
  return { inner: innerFace, border };
}

// ---------------------------------------------------------------------------
// Bridging
// ---------------------------------------------------------------------------

/**
 * Joins two faces with a band of quads, opening both.
 *
 * The band is easy; the PAIRING is the whole problem. Which corner of one face
 * meets which corner of the other decides whether the result is a clean tube or
 * a bowtie — a band with a twist in it, self-intersecting, watertight by every
 * count and impossible to make. So the rings are matched by trying every
 * rotation and taking the one where the paired corners are closest overall: a
 * twisted pairing is always the longer one, which is what rules it out.
 *
 * One ring is reversed first. Two faces that bound the same span run opposite
 * ways when seen from the same side — a cap on top of one shape and a cap on
 * the bottom of another — so pairing them as given would twist the band by a
 * whole face.
 *
 * Both faces are removed: they become the openings of what is now a tube. That
 * is what makes this the tool for two different jobs at once — join two shapes
 * into one, or, on two faces of the SAME shape, drill a tunnel through it.
 */
export function bridgeFaces(lattice: Lattice, faceA: number, faceB: number): { walls: number[] } | null {
  const a = lattice.faces[faceA];
  const b = lattice.faces[faceB];
  if (!a || !b || faceA === faceB) return null;
  if (a.length !== b.length) return null;
  // Sharing a corner means they already meet; a band between them would be a
  // wall of no width, which is a crease in the surface rather than a shape.
  if (a.some((v) => b.includes(v))) return null;

  const reversed = [...b].reverse();
  const at = (v: number) => coordOf(lattice, v);

  let bestOffset = 0;
  let bestCost = Infinity;
  for (let offset = 0; offset < reversed.length; offset++) {
    let cost = 0;
    for (let i = 0; i < a.length; i++) {
      const [x1, y1, z1] = at(a[i]);
      const [x2, y2, z2] = at(reversed[(i + offset) % reversed.length]);
      cost += (x1 - x2) ** 2 + (y1 - y2) ** 2 + (z1 - z2) ** 2;
    }
    if (cost < bestCost) {
      bestCost = cost;
      bestOffset = offset;
    }
  }

  // Corners that are already joined by an edge are corners the band would run
  // alongside a face that exists — the two opposite walls of a box, where every
  // pair is the two ends of an edge of the walls between them. Bridging those
  // produces a surface folded onto itself: closed by every count, and nothing
  // anybody can make. Inset them first and join the smaller faces.
  for (let i = 0; i < a.length; i++) {
    if (edgeExists(lattice, a[i], reversed[(i + bestOffset) % reversed.length])) return null;
  }

  removeFace(lattice, faceA);
  removeFace(lattice, faceB);

  const walls: number[] = [];
  for (let i = 0; i < a.length; i++) {
    const next = (i + 1) % a.length;
    const wall = addFace(lattice, [
      a[i],
      a[next],
      reversed[(next + bestOffset) % reversed.length],
      reversed[(i + bestOffset) % reversed.length],
    ]);
    if (wall !== -1) walls.push(wall);
  }

  // The band's winding follows the face it was built from, and whether that
  // makes it outward depends on which way the two faces were pointing — a tube
  // between two shapes and a tunnel through one want opposite answers. Rather
  // than reason about which case this is, make the surface agree with itself
  // and let the piece as a whole decide which way is out.
  orientFaces(lattice);

  return { walls };
}

// ---------------------------------------------------------------------------
// Mirror
// ---------------------------------------------------------------------------

/** A coordinate reflected through the body origin on one axis. */
export function mirrorCoord(coord: LatticeCoord, axis: Axis): LatticeCoord {
  const out: LatticeCoord = [coord[0], coord[1], coord[2]];
  out[AXIS_INDEX[axis]] = -out[AXIS_INDEX[axis]];
  return out;
}

/**
 * The face that is this one's reflection, if it has already been made.
 *
 * Wanted whenever an operation has to be applied to both halves of a mirrored
 * model: the partner is found by reflecting the corners and reversing them,
 * which is exactly how `mirrorFace` made it.
 */
export function findMirrorFace(lattice: Lattice, face: number, axis: Axis): number {
  const verts = lattice.faces[face];
  if (!verts) return -1;
  const reflected: number[] = [];
  for (const v of verts) {
    const [i, j, k] = mirrorCoord(coordOf(lattice, v), axis);
    const found = findVertex(lattice, i, j, k);
    if (found === -1) return -1;
    reflected.push(found);
  }
  reflected.reverse();
  return findFace(lattice, reflected);
}

/**
 * The mirror image of a face, added.
 *
 * Reflecting reverses handedness, so the winding is reversed too — otherwise
 * every mirrored face comes out inside-out and the export is a solid with half
 * its surface facing in.
 */
export function mirrorFace(lattice: Lattice, face: number, axis: Axis): number {
  const verts = lattice.faces[face];
  if (!verts) return -1;
  const reflected = verts.map((v) => {
    const [i, j, k] = mirrorCoord(coordOf(lattice, v), axis);
    return vertexAt(lattice, i, j, k);
  });
  reflected.reverse();
  return addFace(lattice, reflected);
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/**
 * Six times the volume the faces enclose, signed.
 *
 * Positive when the surface is closed and wound outwards, negative when it is
 * inside-out — which is the only way to tell the two apart, since they look
 * identical anywhere backfaces are drawn. Meaningless in magnitude for an open
 * surface, where `outwardness` is the question to ask instead.
 */
export function signedVolume(lattice: Lattice): number {
  const poly = toPolyMesh(lattice);
  const at = (v: number): [number, number, number] => [poly.positions[v * 3], poly.positions[v * 3 + 1], poly.positions[v * 3 + 2]];
  let total = 0;
  for (const face of poly.faces) {
    for (let i = 1; i + 1 < face.length; i++) {
      const a = at(face[0]);
      const b = at(face[i]);
      const c = at(face[i + 1]);
      total +=
        a[0] * (b[1] * c[2] - b[2] * c[1]) -
        a[1] * (b[0] * c[2] - b[2] * c[0]) +
        a[2] * (b[0] * c[1] - b[1] * c[0]);
    }
  }
  return total / 6;
}

/**
 * Makes every face agree with its neighbours about which side is out, and turns
 * each connected piece the right way round.
 *
 * Two things go wrong on their own and neither is visible while you work. Faces
 * drawn by hand take their winding from the order the corners were clicked, so
 * a shape built by clicking can disagree with itself; and until it was fixed, a
 * backwards extrusion produced a piece that was consistent and entirely
 * inside-out. Both draw perfectly in the editor, which is double-sided, and
 * then lose faces the moment anything culls backfaces — a part that looks
 * finished and exports full of holes.
 *
 * Consistency comes first, by walking each piece and flipping any face that
 * runs a shared edge in the same direction as its neighbour (agreeing faces
 * traverse a shared edge in OPPOSITE directions). Then the piece as a whole is
 * turned outwards, judged by whether its faces lean away from its own centre —
 * which works for an open shell, where there is no volume to take the sign of.
 *
 * Returns how many faces were turned round.
 */
export function orientFaces(lattice: Lattice): number {
  const alive: number[] = [];
  lattice.faces.forEach((verts, f) => { if (verts) alive.push(f); });
  if (alive.length === 0) return 0;

  // Which faces meet along each edge, and which way each runs along it.
  const along = new Map<string, { face: number; forwards: boolean }[]>();
  for (const f of alive) {
    const verts = lattice.faces[f]!;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      const key = edgeKey(a, b);
      const list = along.get(key) ?? [];
      list.push({ face: f, forwards: a < b });
      along.set(key, list);
    }
  }

  const runsForwards = (f: number, key: string) =>
    along.get(key)!.find((use) => use.face === f)!.forwards;

  let flipped = 0;
  const seen = new Set<number>();

  for (const start of alive) {
    if (seen.has(start)) continue;

    const piece: number[] = [];
    const queue = [start];
    seen.add(start);
    while (queue.length > 0) {
      const f = queue.pop()!;
      piece.push(f);
      const verts = lattice.faces[f]!;
      for (let i = 0; i < verts.length; i++) {
        const key = edgeKey(verts[i], verts[(i + 1) % verts.length]);
        for (const use of along.get(key) ?? []) {
          if (use.face === f || seen.has(use.face)) continue;
          seen.add(use.face);
          // Both running the edge the same way means one of them is the wrong
          // way round; the one being visited is the one that moves.
          if (runsForwards(use.face, key) === runsForwards(f, key)) {
            lattice.faces[use.face]!.reverse();
            // The direction table describes the old winding, so it has to be
            // corrected too or the next neighbour is judged against a lie.
            for (const [, uses] of along) {
              for (const entry of uses) if (entry.face === use.face) entry.forwards = !entry.forwards;
            }
            flipped++;
          }
          queue.push(use.face);
        }
      }
    }

    if (outwardness(lattice, piece) >= 0) continue;
    for (const f of piece) {
      lattice.faces[f]!.reverse();
      flipped++;
    }
  }

  if (flipped > 0) lattice.revision++;
  return flipped;
}

/**
 * How far a set of faces lean away from their own centre, area-weighted.
 *
 * Positive means they face outwards. For a closed shape this is three times its
 * volume; for an open one it is still the right question, which a volume is
 * not.
 */
function outwardness(lattice: Lattice, faces: number[]): number {
  let cx = 0, cy = 0, cz = 0, count = 0;
  for (const f of faces) {
    for (const v of lattice.faces[f]!) {
      const c = coordOf(lattice, v);
      cx += c[0]; cy += c[1]; cz += c[2];
      count++;
    }
  }
  if (count === 0) return 0;
  cx /= count; cy /= count; cz /= count;

  let total = 0;
  for (const f of faces) {
    const centre = faceCentre(lattice, f);
    const normal = faceNormal(lattice, f);
    if (!centre || !normal) continue;
    total += (centre[0] - cx) * normal[0] + (centre[1] - cy) * normal[1] + (centre[2] - cz) * normal[2];
  }
  return total;
}

/** How many faces disagree with their neighbours or face inwards. */
export function inconsistentFaces(lattice: Lattice): number {
  const copy = cloneLattice(lattice);
  return orientFaces(copy);
}

/**
 * Whether the surface is closed.
 *
 * Reported rather than enforced: an open surface is a perfectly good thing to
 * be halfway through making, and it is only downstream — a mold, a relief
 * carve, a 3MF — that it becomes a file nobody will accept. The panel shows it
 * because nothing in the viewport does.
 */
export function isWatertight(lattice: Lattice): boolean {
  const uses = new Map<string, number>();
  let any = false;
  for (const verts of lattice.faces) {
    if (!verts) continue;
    any = true;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      const edge = a < b ? `${a}:${b}` : `${b}:${a}`;
      uses.set(edge, (uses.get(edge) ?? 0) + 1);
    }
  }
  if (!any) return false;
  for (const count of uses.values()) if (count !== 2) return false;
  return true;
}

/** Grid-step bounds of everything placed, or null when nothing has been. */
export function latticeBounds(lattice: Lattice): { min: LatticeCoord; max: LatticeCoord } | null {
  const used = usedVertices(lattice);
  if (used.length === 0) return null;
  const min: LatticeCoord = [Infinity, Infinity, Infinity];
  const max: LatticeCoord = [-Infinity, -Infinity, -Infinity];
  for (const v of used) {
    const c = coordOf(lattice, v);
    for (let a = 0; a < 3; a++) {
      if (c[a] < min[a]) min[a] = c[a];
      if (c[a] > max[a]) max[a] = c[a];
    }
  }
  return { min, max };
}

/** The vertices some face still uses, in index order. */
function usedVertices(lattice: Lattice): number[] {
  const used = new Set<number>();
  for (const verts of lattice.faces) {
    if (!verts) continue;
    for (const v of verts) used.add(v);
  }
  return [...used].sort((a, b) => a - b);
}

export function latticeStats(lattice: Lattice) {
  let quads = 0;
  let tris = 0;
  for (const verts of lattice.faces) {
    if (!verts) continue;
    if (verts.length === 4) quads++;
    else if (verts.length === 3) tris++;
  }
  return {
    vertices: usedVertices(lattice).length,
    faces: faceCount(lattice),
    quads,
    tris,
    creases: creaseEdges(lattice).length / 2,
    // Faces that disagree with their neighbours or face inwards. Reported
    // because the cost of not knowing is a part that looks finished and exports
    // full of holes.
    inconsistent: inconsistentFaces(lattice),
    watertight: isWatertight(lattice),
  };
}

// ---------------------------------------------------------------------------
// Out to a mesh
// ---------------------------------------------------------------------------

/** The cage as metric polygons, Z-up, dropping orphaned vertices. */
export function toPolyMesh(lattice: Lattice): PolyMesh {
  const used = usedVertices(lattice);
  const remap = new Map<number, number>();
  const positions: number[] = [];
  for (const v of used) {
    remap.set(v, positions.length / 3);
    positions.push(
      lattice.coords[v * 3] * lattice.unit,
      lattice.coords[v * 3 + 1] * lattice.unit,
      lattice.coords[v * 3 + 2] * lattice.unit,
    );
  }
  const faces: number[][] = [];
  for (const verts of lattice.faces) {
    if (!verts) continue;
    faces.push(verts.map((v) => remap.get(v)!));
  }
  const creases = new Set<string>();
  for (const key of lattice.creases) {
    const [a, b] = key.split(':').map(Number);
    const ra = remap.get(a);
    const rb = remap.get(b);
    if (ra !== undefined && rb !== undefined) creases.add(ra < rb ? `${ra}:${rb}` : `${rb}:${ra}`);
  }
  return { positions, faces, creases };
}

/** Triangulates a polygon by fanning from its first corner. */
function triangulate(faces: number[][]): number[] {
  const out: number[] = [];
  for (const face of faces) {
    for (let i = 1; i + 1 < face.length; i++) out.push(face[0], face[i], face[i + 1]);
  }
  return out;
}

/**
 * Where the solid balances, in metres, in cage space.
 *
 * The VOLUME centroid, by the signed-tetrahedron sum, not the average of the
 * corners — and the difference is not academic. MuJoCo translates every mesh
 * asset so that its centre of mass sits at the mesh frame's origin, so a mesh
 * handed over with its mass off to one side is silently moved, and then draws
 * in one place while it collides in another and swings around a point outside
 * itself when the body turns.
 *
 * An open surface has no volume to speak of, so the corner average stands in;
 * it is not exactly what MuJoCo will do with such a mesh, but nothing is, and
 * an open mesh is not a solid anybody can simulate anyway.
 */
export function meshCentroid(poly: PolyMesh): [number, number, number] {
  const at = (v: number): [number, number, number] => [poly.positions[v * 3], poly.positions[v * 3 + 1], poly.positions[v * 3 + 2]];
  let volume = 0;
  let cx = 0, cy = 0, cz = 0;

  for (const face of poly.faces) {
    for (let i = 1; i + 1 < face.length; i++) {
      const a = at(face[0]);
      const b = at(face[i]);
      const c = at(face[i + 1]);
      // Six times the signed volume of the tetrahedron on the origin.
      const v6 =
        a[0] * (b[1] * c[2] - b[2] * c[1]) -
        a[1] * (b[0] * c[2] - b[2] * c[0]) +
        a[2] * (b[0] * c[1] - b[1] * c[0]);
      volume += v6;
      cx += (a[0] + b[0] + c[0]) * v6;
      cy += (a[1] + b[1] + c[1]) * v6;
      cz += (a[2] + b[2] + c[2]) * v6;
    }
  }

  if (Math.abs(volume) > 1e-15) {
    return [cx / (4 * volume), cy / (4 * volume), cz / (4 * volume)];
  }

  const count = poly.positions.length / 3;
  if (count === 0) return [0, 0, 0];
  let sx = 0, sy = 0, sz = 0;
  for (let i = 0; i < count; i++) {
    sx += poly.positions[i * 3];
    sy += poly.positions[i * 3 + 1];
    sz += poly.positions[i * 3 + 2];
  }
  return [sx / count, sy / count, sz / count];
}

/**
 * The shape as a `SceneGeom` pair, optionally smoothed, centred on its own
 * centre of mass.
 *
 * `subdivLevel` is applied HERE rather than kept as a display setting, because
 * everything downstream — the physics, the STL, the relief carve — has to see
 * the shape that was meant, not the blocky cage that produced it. The cage is
 * drawn separately as an overlay, and is preserved on the node so it can be
 * edited again (see `serializeCage`); it cannot be recovered from this.
 *
 * `thickness` turns an open surface into a shell of that wall thickness, in
 * metres, and is applied AFTER smoothing so the wall follows the rounded
 * surface rather than the blocky cage that produced it. A closed shape ignores
 * it — see utils/solidify.ts.
 *
 * The centring is not cosmetic. A body's frame is where it spins and where
 * MuJoCo expects the mesh's mass to be, so a shape built off to one side of the
 * origin — which is exactly what happens when somebody extrudes away from where
 * they started — would orbit its own origin when rotated instead of turning in
 * place. `origin` is how far the shape was moved, so the caller can shift the
 * body by the same amount and leave the shape where the person put it.
 */
export function toSceneGeom(
  lattice: Lattice,
  subdivLevel = 0,
  thickness = 0,
): { vertices: number[]; renderVertices: number[]; faces: number[]; origin: [number, number, number] } {
  const smoothed = subdivLevel > 0 ? subdivide(toPolyMesh(lattice), subdivLevel) : toPolyMesh(lattice);
  const poly = thickness > 0 ? solidify(smoothed, thickness) : smoothed;
  const origin = meshCentroid(poly);

  const count = poly.positions.length / 3;
  const renderVertices = new Array<number>(count * 3);
  const vertices = new Array<number>(count * 3);
  for (let i = 0; i < count; i++) {
    const x = poly.positions[i * 3] - origin[0];
    const y = poly.positions[i * 3 + 1] - origin[1];
    const z = poly.positions[i * 3 + 2] - origin[2];
    renderVertices[i * 3] = x;
    renderVertices[i * 3 + 1] = y;
    renderVertices[i * 3 + 2] = z;
    // Same Z-up -> Y-up swap as sculptMesh.toSceneGeom, so a lattice body and a
    // sculpted one arrive at the renderer identically.
    vertices[i * 3] = x;
    vertices[i * 3 + 1] = z;
    vertices[i * 3 + 2] = -y;
  }

  return { vertices, renderVertices, faces: triangulate(poly.faces), origin };
}

/** The cage's edges, as vertex index pairs, for drawing the wireframe. */
export function cageEdges(lattice: Lattice): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  for (const verts of lattice.faces) {
    if (!verts) continue;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      const edge = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (seen.has(edge)) continue;
      seen.add(edge);
      out.push(a, b);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface LatticeCage {
  unit: number;
  /** Three integers per vertex, orphans already dropped. */
  coords: number[];
  /** Face corners back to back; `faceSizes` says where each one ends. */
  faces: number[];
  faceSizes: number[];
  /** Sharp edges, two vertex indices per crease. Absent on cages saved before them. */
  creases?: number[];
}

/**
 * The cage in a form that survives being saved.
 *
 * A lattice body's geom holds the SUBDIVIDED mesh, which cannot be turned back
 * into the cage that made it — so without this, saving a document and reopening
 * it would leave a lattice that can be looked at and never edited again.
 * Compacted on the way out: tombstoned faces and orphaned vertices are the
 * bookkeeping of one session, not part of the shape.
 */
export function serializeCage(lattice: Lattice): LatticeCage {
  const used = usedVertices(lattice);
  const remap = new Map<number, number>();
  const coords: number[] = [];
  for (const v of used) {
    remap.set(v, coords.length / 3);
    coords.push(lattice.coords[v * 3], lattice.coords[v * 3 + 1], lattice.coords[v * 3 + 2]);
  }
  const faces: number[] = [];
  const faceSizes: number[] = [];
  for (const verts of lattice.faces) {
    if (!verts) continue;
    faceSizes.push(verts.length);
    for (const v of verts) faces.push(remap.get(v)!);
  }
  const creases: number[] = [];
  for (const key of lattice.creases) {
    const [a, b] = key.split(':').map(Number);
    const ra = remap.get(a);
    const rb = remap.get(b);
    if (ra !== undefined && rb !== undefined) creases.push(ra, rb);
  }
  return { unit: lattice.unit, coords, faces, faceSizes, creases };
}

export function deserializeCage(cage: LatticeCage): Lattice {
  const lattice = createLattice(cage.unit ?? DEFAULT_UNIT);
  const vertices: number[] = [];
  for (let i = 0; i < cage.coords.length; i += 3) {
    vertices.push(vertexAt(lattice, cage.coords[i], cage.coords[i + 1], cage.coords[i + 2]));
  }
  let at = 0;
  for (const size of cage.faceSizes) {
    const verts: number[] = [];
    for (let i = 0; i < size; i++) verts.push(vertices[cage.faces[at + i]]);
    at += size;
    addFace(lattice, verts);
  }
  // After the faces, so `setCrease` can check the edge is really there — a cage
  // written by an older version has no creases at all, which is simply a cage
  // where nothing is sharp.
  for (let i = 0; i + 1 < (cage.creases?.length ?? 0); i += 2) {
    setCrease(lattice, vertices[cage.creases![i]], vertices[cage.creases![i + 1]], true);
  }
  return lattice;
}

/**
 * A shallow copy deep enough to undo onto.
 *
 * The undo history here is snapshots rather than inverse operations, which is
 * the opposite of what utils/sculptMesh.ts does — and for the opposite reason.
 * A sculpt stroke touches a mesh of a quarter of a million vertices, so a
 * snapshot per stroke is megabytes and the history has to be built out of
 * deltas. A cage is coarse by construction; a hundred of these is smaller than
 * one sculpt stroke, and a snapshot cannot get an inverse subtly wrong.
 */
export function cloneLattice(lattice: Lattice): Lattice {
  const copy = createLattice(lattice.unit);
  copy.coords = [...lattice.coords];
  copy.index = new Map(lattice.index);
  copy.faces = lattice.faces.map((face) => (face ? [...face] : null));
  copy.vertexFaces = new Map();
  for (const [v, set] of lattice.vertexFaces) copy.vertexFaces.set(v, new Set(set));
  copy.creases = new Set(lattice.creases);
  copy.revision = lattice.revision;
  return copy;
}

/** Puts a snapshot back, in place, so holders of the live lattice see it. */
export function restoreLattice(lattice: Lattice, snapshot: Lattice) {
  lattice.unit = snapshot.unit;
  lattice.coords = [...snapshot.coords];
  lattice.index = new Map(snapshot.index);
  lattice.faces = snapshot.faces.map((face) => (face ? [...face] : null));
  lattice.vertexFaces = new Map();
  for (const [v, set] of snapshot.vertexFaces) lattice.vertexFaces.set(v, new Set(set));
  lattice.creases = new Set(snapshot.creases);
  lattice.revision++;
}
