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
  /**
   * Open chains of vertices with no face on them — a curve drawn and not yet
   * closed into anything.
   *
   * A sketch is edges first and faces second: you draw the outline of a thing
   * and it becomes a face when the outline meets itself. Before these, an
   * unfinished outline lived only in the editor's memory and Esc threw it
   * away; a profile for a lathe had to be a face. A wire is the outline kept
   * in the document, so it can be closed later, continued from either end,
   * moved corner by corner, or swept about an axis as it is.
   */
  wires: number[][];
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
export type LatticeTool = 'place' | 'select' | 'extrude' | 'shape' | 'freehand' | 'line' | 'bezier';

/** The tools that draw a stroke on the work plane, and so need it held still. */
export const DRAWING_TOOLS: ReadonlySet<LatticeTool> = new Set<LatticeTool>(['freehand', 'line', 'bezier']);

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
    wires: [],
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

/**
 * Moves a set of corners towards or away from a point, each by its own step.
 *
 * The counterpart to `moveVertices`, which translates: here every corner takes
 * a different step, so the "two moving corners can never collide" argument that
 * one leans on does not hold. Scaling far enough in would put several corners on
 * the same grid point and weld a face into a line, so a factor that collides is
 * refused outright and nothing moves — a resize that eats the shape is not what
 * anybody dragging inwards is asking for, and the drag can simply continue.
 *
 * Steps are whole multiples of `step` measured from where each corner already
 * is, so a corner placed on a finer grid than the one in use keeps its offset
 * rather than being quietly dragged onto the coarse one.
 *
 * `axis` confines the scale to one world axis, which is the whole of what makes
 * this usable on a face: a face lies in a plane, and scaling it along its own
 * normal is a no-op that looks like a broken tool.
 */
export function scaleVertices(
  lattice: Lattice,
  vertices: number[],
  centre: [number, number, number],
  factor: number,
  step: number,
  axis: Axis | null = null,
): boolean {
  if (!(step > 0) || !Number.isFinite(factor)) return false;
  const moving = [...new Set(vertices)].filter((v) => v >= 0 && v < vertexCount(lattice));
  if (moving.length === 0) return false;

  const targets: LatticeCoord[] = [];
  const taken = new Set<string>();
  let changed = false;
  for (const v of moving) {
    const coord = coordOf(lattice, v);
    const target: LatticeCoord = [...coord];
    for (let k = 0; k < 3; k++) {
      if (axis !== null && AXIS_INDEX[axis] !== k) continue;
      target[k] = coord[k] + Math.round(((coord[k] - centre[k]) * (factor - 1)) / step) * step;
    }
    const id = `${target[0]},${target[1]},${target[2]}`;
    if (taken.has(id)) return false;
    taken.add(id);
    targets.push(target);
    if (target[0] !== coord[0] || target[1] !== coord[1] || target[2] !== coord[2]) changed = true;
  }
  if (!changed) return false;

  // Out of the index, then moved, then back in — the same order `moveVertices`
  // uses, and for the same reason: a corner must not weld to the old position of
  // another corner that is about to leave it.
  for (const v of moving) {
    const [i, j, k] = coordOf(lattice, v);
    if (lattice.index.get(key(i, j, k)) === v) lattice.index.delete(key(i, j, k));
  }
  moving.forEach((v, n) => {
    lattice.coords[v * 3] = targets[n][0];
    lattice.coords[v * 3 + 1] = targets[n][1];
    lattice.coords[v * 3 + 2] = targets[n][2];
  });

  // A corner landing on one that is NOT moving is still a real weld.
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
  // A wire through the corner is cut there: what is left either side stays.
  const wires: number[][] = [];
  for (const chain of lattice.wires) {
    let piece: number[] = [];
    for (const v of chain) {
      if (v === vertex) {
        if (piece.length >= 2) wires.push(piece);
        piece = [];
      } else {
        piece.push(v);
      }
    }
    if (piece.length >= 2) wires.push(piece);
  }
  lattice.wires = wires;
  const [i, j, k] = coordOf(lattice, vertex);
  if (lattice.index.get(key(i, j, k)) === vertex) lattice.index.delete(key(i, j, k));
  lattice.revision++;
  return true;
}

// ---------------------------------------------------------------------------
// Wires
// ---------------------------------------------------------------------------

/**
 * Keeps an open chain of corners. Consecutive repeats are collapsed; a chain
 * with fewer than two distinct corners is nothing and is refused. Returns the
 * wire's index.
 */
export function addWire(lattice: Lattice, verts: number[]): number {
  const chain: number[] = [];
  for (const v of verts) if (chain[chain.length - 1] !== v) chain.push(v);
  if (chain.length < 2) return -1;
  lattice.wires.push(chain);
  lattice.revision++;
  return lattice.wires.length - 1;
}

export function removeWire(lattice: Lattice, wire: number): boolean {
  if (wire < 0 || wire >= lattice.wires.length) return false;
  lattice.wires.splice(wire, 1);
  lattice.revision++;
  return true;
}

/**
 * The wire that starts or ends at this corner, if one does — the one a new
 * stroke from there would be continuing. Ends only: joining onto the middle
 * of a wire would be a branch, and a branch is not an outline.
 */
export function wireEndingAt(lattice: Lattice, vertex: number, except = -1): { wire: number; atStart: boolean } | null {
  for (let w = 0; w < lattice.wires.length; w++) {
    if (w === except) continue;
    const chain = lattice.wires[w];
    if (chain[chain.length - 1] === vertex) return { wire: w, atStart: false };
    if (chain[0] === vertex) return { wire: w, atStart: true };
  }
  return null;
}

/**
 * Takes one edge out of the wires it runs along, splitting them there.
 * Returns whether anything changed.
 */
export function removeWireEdge(lattice: Lattice, a: number, b: number): boolean {
  let changed = false;
  const wires: number[][] = [];
  for (const chain of lattice.wires) {
    let piece: number[] = [chain[0]];
    for (let i = 1; i < chain.length; i++) {
      const p = chain[i - 1];
      const q = chain[i];
      if ((p === a && q === b) || (p === b && q === a)) {
        changed = true;
        if (piece.length >= 2) wires.push(piece);
        piece = [q];
      } else {
        piece.push(q);
      }
    }
    if (piece.length >= 2) wires.push(piece);
  }
  if (changed) {
    lattice.wires = wires;
    lattice.revision++;
  }
  return changed;
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
): { cap: number; sides: number[]; floor: number } | null {
  const verts = lattice.faces[face];
  if (!verts || steps === 0) return null;
  // Copied up front: a face kept as the floor gets turned round at the end, and
  // flipFace reverses the very array the walls are built from.
  const ring = [...verts];

  const normal = faceNormal(lattice, face);
  if (!normal) return null;
  const dominant = dominantAxis(normal);
  const along = axis ?? dominant.axis;
  const a = AXIS_INDEX[along];
  // Along the face's own axis, "out" is where the normal points; along any
  // other, the sign the caller gave is the whole instruction.
  const travel = axis && axis !== dominant.axis ? steps : steps * dominant.sign;

  const moved = ring.map((v) => {
    const c = coordOf(lattice, v);
    c[a] += travel;
    return vertexAt(lattice, c[0], c[1], c[2]);
  });

  /*
    Whether the old face is swallowed or kept, which is the difference between
    a solid and a box with no bottom.

    Extruding one wall OF A SOLID, the old face becomes the inside of the wall
    and stops being a surface — keeping it would put a membrane across the
    middle. That is the case this only ever used to handle, and it is why it
    always removed it.

    Extruding a PLATE — a profile drawn on the work plane, whose edges belong to
    nothing else — the old face is not a membrane. It is the bottom of the solid
    you just made, and removing it leaves a shape that looks right from above,
    is open underneath, and is quietly refused by every exporter as not
    watertight. So a face with no neighbours at all is kept.

    All of its edges, not some: a face sharing even one edge would get three
    faces along that edge — the neighbour, the kept floor, and the wall rising
    off it — which is non-manifold, and worse than the hole it fixes. Those
    mixed cases keep the old behaviour.
  */
  const lone = ring.every((v, i) => facesAlong(lattice, v, ring[(i + 1) % ring.length]).length === 1);
  if (!lone) removeFace(lattice, face);

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
  for (let i = 0; i < ring.length; i++) {
    const next = (i + 1) % ring.length;
    const wall = backwards
      ? [ring[next], ring[i], moved[i], moved[next]]
      : [ring[i], ring[next], moved[next], moved[i]];
    const added = addFace(lattice, wall);
    if (added !== -1) sides.push(added);
  }

  const cap = addFace(lattice, backwards ? [...moved].reverse() : moved);
  // A kept floor points INTO the solid when the extrusion went the way the face
  // was facing, so it has to be turned round to be the underside. Pushed the
  // other way the solid is behind it and it already faces out.
  if (lone && !backwards) flipFace(lattice, face);
  return { cap, sides, floor: lone ? face : -1 };
}

// ---------------------------------------------------------------------------
// Bevel
// ---------------------------------------------------------------------------

/** The step from a to b reduced to its smallest whole form, or null if it is not one. */
export function unitStep(from: LatticeCoord, to: LatticeCoord): { dir: LatticeCoord; length: number } | null {
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
// Edge bevel — chamfer and fillet
// ---------------------------------------------------------------------------

export type BevelMode = 'chamfer' | 'fillet';

const sameCoord = (a: LatticeCoord, b: LatticeCoord) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** A ring with any run of repeated corners collapsed, ends included. */
function dedupeRing(ring: LatticeCoord[]): LatticeCoord[] {
  const out: LatticeCoord[] = [];
  for (const c of ring) if (out.length === 0 || !sameCoord(out[out.length - 1], c)) out.push(c);
  while (out.length > 1 && sameCoord(out[0], out[out.length - 1])) out.pop();
  return out;
}

/**
 * Cuts a strip off along an edge of a SOLID — the operation `bevelFace` refuses.
 *
 * `bevelFace` cuts the corners off one face and can only do it where those
 * corners belong to nothing else, which on a real part is almost nowhere: every
 * edge of a box is shared. Beveling a shared edge means pulling BOTH faces back
 * from it, which tears them off each other everywhere they met, and then
 * stitching the tear with a new strip. That stitching is what this is.
 *
 * The whole algorithm is one rule, applied at every corner of every face that
 * touches a beveled edge. At vertex `v`, a face has two edges — call the
 * neighbours `p` and `q` — and the corner is replaced by up to two new corners,
 * one on each side:
 *
 *   * on the p side: if (v,p) is being beveled, the face retreats FROM it,
 *     which within the face means stepping towards q. If it is not, the corner
 *     steps back along the edge itself, towards p.
 *   * the q side is the same sentence with p and q swapped.
 *
 * Both new corners lie in the face's own plane by construction, and when they
 * come out equal the corner stays a single vertex. That one rule produces every
 * case: a face flanking the bevel gets one new corner and slides back; a face
 * merely touching the end of it turns from a quad into a pentagon; and a corner
 * where two beveled edges meet gets notched by both.
 *
 * The strip itself then joins the two retreated corners on one face to the two
 * on the other. Anything still left open — the little triangle where three
 * beveled edges meet at a corner — is found by looking for edges with only one
 * face on them and closed with a patch, rather than by enumerating the cases.
 *
 * Chamfer and fillet are the same cut and differ only in what happens next: a
 * chamfer creases the strip's two long edges so smoothing keeps it flat, a
 * fillet leaves them soft so Catmull-Clark rounds the strip into an arc of
 * roughly the strip's own width. That is the radius control the app has been
 * missing — a rounded edge whose tightness is a number rather than whatever the
 * subdivision felt like.
 */
export function bevelEdges(
  lattice: Lattice,
  edges: [number, number][],
  steps: number,
  mode: BevelMode = 'chamfer',
): { strips: number[]; patches: number[] } | null {
  if (steps <= 0 || edges.length === 0) return null;

  const selected = new Set<string>();
  const pairs: [number, number][] = [];
  for (const [a, b] of edges) {
    if (a === b || !edgeExists(lattice, a, b)) return null;
    // Two faces exactly: an edge with one is the rim of an open surface and has
    // no second face to pull back, and an edge with three is not a surface.
    if (facesAlong(lattice, a, b).length !== 2) return null;
    const key = edgeKey(a, b);
    if (selected.has(key)) continue;
    selected.add(key);
    pairs.push([a, b]);
  }

  const touched = new Set<number>();
  for (const [a, b] of pairs) {
    touched.add(a);
    touched.add(b);
  }

  const affected = new Set<number>();
  for (const v of touched) for (const f of lattice.vertexFaces.get(v) ?? []) affected.add(f);

  // Where each corner goes, per face. `towards` is the same information keyed by
  // which of the corner's two edges it sits beside, which is what the strip
  // needs to know to find its own four corners.
  const chains = new Map<string, LatticeCoord[]>();
  const towards = new Map<string, LatticeCoord>();
  const born = new Map<number, LatticeCoord[]>();

  for (const f of affected) {
    const verts = lattice.faces[f];
    if (!verts) return null;
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      if (!touched.has(v)) continue;
      const p = verts[(i - 1 + verts.length) % verts.length];
      const q = verts[(i + 1) % verts.length];
      const here = coordOf(lattice, v);
      const toP = unitStep(here, coordOf(lattice, p));
      const toQ = unitStep(here, coordOf(lattice, q));
      if (!toP || !toQ) return null;
      // Room to cut. An edge whose far end is also being cut has to give up half
      // to each; one whose far end stays put only has to stop short of it.
      for (const [neighbour, step] of [[p, toP], [q, toQ]] as const) {
        const room = touched.has(neighbour) ? step.length / 2 : step.length - 1;
        if (steps > room) return null;
      }
      const along = (dir: LatticeCoord) => here.map((c, k) => c + dir[k] * steps) as LatticeCoord;
      const cutP = selected.has(edgeKey(v, p));
      const cutQ = selected.has(edgeKey(v, q));
      // Both of the face's edges here are being cut, so the corner retreats
      // from both at once — diagonally, to a single point. Retreating from each
      // separately would leave the corner notched, and it is that notch, not
      // the tear, that turns a beveled cube's faces into octagons instead of
      // the squares they should stay.
      const diagonal = here.map((c, k) => c + (toP.dir[k] + toQ.dir[k]) * steps) as LatticeCoord;
      const start = cutP && cutQ ? diagonal : cutP ? along(toQ.dir) : along(toP.dir);
      const end = cutP && cutQ ? diagonal : cutQ ? along(toP.dir) : along(toQ.dir);
      towards.set(`${f}:${v}:${p}`, start);
      towards.set(`${f}:${v}:${q}`, end);
      chains.set(`${f}:${v}`, sameCoord(start, end) ? [start] : [start, end]);
      const list = born.get(v) ?? [];
      for (const c of [start, end]) if (!list.some((had) => sameCoord(had, c))) list.push(c);
      born.set(v, list);
    }
  }

  // Every face redrawn with its corners moved, as coordinates — the vertices
  // they will become do not exist yet, and the ones they replace are about to
  // stop existing.
  const rebuilt: LatticeCoord[][] = [];
  for (const f of affected) {
    const verts = lattice.faces[f]!;
    const ring: LatticeCoord[] = [];
    for (const v of verts) {
      const chain = chains.get(`${f}:${v}`);
      if (chain) ring.push(...chain);
      else ring.push(coordOf(lattice, v));
    }
    const deduped = dedupeRing(ring);
    if (deduped.length >= 3) rebuilt.push(deduped);
  }

  const at = (f: number, v: number, neighbour: number) => towards.get(`${f}:${v}:${neighbour}`) ?? null;

  const strips: LatticeCoord[][] = [];
  for (const [a, b] of pairs) {
    const [f1, f2] = facesAlong(lattice, a, b);
    const verts1 = lattice.faces[f1]!;
    const forward = verts1[(verts1.indexOf(a) + 1) % verts1.length] === b;
    // The strip runs the shared edge backwards on the face that runs it
    // forwards, which is what any face neighbouring that one would have done.
    const [x, y] = forward ? [b, a] : [a, b];
    const quad = [at(f1, x, y), at(f1, y, x), at(f2, y, x), at(f2, x, y)];
    if (quad.some((c) => c === null)) return null;
    strips.push(dedupeRing(quad as LatticeCoord[]));
  }

  // Creases worth keeping, remembered as coordinates for the same reason: the
  // vertices they name are about to be replaced by several each, and which
  // replacement a crease means depends on the face it is seen from.
  const keptCreases: [LatticeCoord, LatticeCoord][] = [];
  for (const key of lattice.creases) {
    const [u, w] = key.split(':').map(Number);
    if (selected.has(edgeKey(u, w))) continue; // beveled away
    if (!touched.has(u) && !touched.has(w)) continue; // survives untouched
    for (const f of facesAlong(lattice, u, w)) {
      const from = touched.has(u) ? at(f, u, w) : coordOf(lattice, u);
      const to = touched.has(w) ? at(f, w, u) : coordOf(lattice, w);
      if (from && to && !sameCoord(from, to)) keptCreases.push([from, to]);
    }
  }

  for (const f of affected) removeFace(lattice, f);
  for (const v of touched) removeVertex(lattice, v);

  const index = (c: LatticeCoord) => vertexAt(lattice, c[0], c[1], c[2]);
  for (const ring of rebuilt) addFace(lattice, ring.map(index));

  const stripFaces: number[] = [];
  for (const quad of strips) {
    if (quad.length < 3) continue;
    const added = addFace(lattice, quad.map(index));
    if (added === -1) continue;
    stripFaces.push(added);
    // The long sides of the strip — the two that run along the old edge — are
    // what a chamfer keeps crisp and a fillet lets round.
    if (mode === 'chamfer' && quad.length === 4) {
      const corners = quad.map(index);
      setCrease(lattice, corners[0], corners[1], true);
      setCrease(lattice, corners[2], corners[3], true);
    }
  }

  // What is still open. Where three beveled edges meet, the strips leave a
  // triangular gap; rather than enumerate that case and the ones next to it,
  // find the edges that ended up with one face and close the ring they make.
  const patches: number[] = [];
  for (const [, coords] of born) {
    if (coords.length < 3) continue;
    const ring = coords.map(index);
    const open: [number, number][] = [];
    for (let i = 0; i < ring.length; i++) {
      for (let j = i + 1; j < ring.length; j++) {
        if (facesAlong(lattice, ring[i], ring[j]).length === 1) open.push([ring[i], ring[j]]);
      }
    }
    const cycle = walkCycle(open);
    if (cycle && cycle.length >= 3) {
      const added = addFace(lattice, cycle);
      if (added !== -1) patches.push(added);
    }
  }

  for (const [from, to] of keptCreases) setCrease(lattice, index(from), index(to), true);

  // The strips were wound from whichever face happened to be listed first, and
  // the patches from whatever order the open edges came out in. Rather than
  // reason about which is outward here, make the surface agree with itself.
  orientFaces(lattice);

  return { strips: stripFaces, patches };
}

/**
 * The single closed loop these edges form, or null if they form none.
 *
 * Used to close a corner gap: the open edges around it are a ring, and the ring
 * in order is the face that fills it. Anything else — two rings, a stray spur —
 * is not something to guess at.
 */
function walkCycle(edges: [number, number][]): number[] | null {
  if (edges.length < 3) return null;
  const links = new Map<number, number[]>();
  for (const [a, b] of edges) {
    links.set(a, [...(links.get(a) ?? []), b]);
    links.set(b, [...(links.get(b) ?? []), a]);
  }
  for (const [, to] of links) if (to.length !== 2) return null;

  const start = edges[0][0];
  const order = [start];
  let previous = -1;
  let here = start;
  for (let guard = 0; guard < edges.length; guard++) {
    const next = (links.get(here) ?? []).find((n) => n !== previous);
    if (next === undefined) return null;
    if (next === start) return order.length === links.size ? order : null;
    order.push(next);
    previous = here;
    here = next;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Curved profiles, and the operations that consume them
// ---------------------------------------------------------------------------
//
// The lattice is a superset of a sketcher for everything a sketcher draws with
// straight lines: a closed profile is a face, and a face can be any polygon at
// any depth. Two things it was not a superset of, and this is them.
//
// The first is CURVES. A sketcher's primitives are arcs and circles, and a
// lattice vertex is three integers — there is no circle on an integer grid. But
// there does not need to be one: the grid's finest step is 0.1 mm, so a polygon
// whose corners are rounded to it is within 0.05 mm of the true circle, which
// is finer than any machine in this app can cut and finer than a slicer's own
// tolerance. `ringCoords` picks the number of sides from that budget rather
// than from a preference, so "a circle" means "a polygon nobody can measure the
// difference from" and the cage stays integers.
//
// The second is REVOLVE. Extrude drags a face along its own normal, which makes
// prisms and nothing else; every turned part — a boss, a spigot, a knob, a
// funnel — is a profile swept about an axis, and there was no way to ask for
// one. `revolveChain` is that, and with `bridgeFaces` (a loft) and extrude the
// three profile-consuming operations a sketcher has are all present.
//
// What is still NOT a superset, and is worth saying plainly: an exact
// non-rational angle, a face with a hole in its interior (inset and delete the
// middle instead), and a dimension that is not a whole number of grid steps.
// ---------------------------------------------------------------------------

/**
 * The two in-plane axes for a plane whose normal is `axis`, in the order that
 * makes a counter-clockwise ring wind counter-clockwise seen from +axis.
 */
function planeAxes(axis: Axis): [0 | 1 | 2, 0 | 1 | 2] {
  if (axis === 'x') return [1, 2];
  if (axis === 'y') return [2, 0];
  return [0, 1];
}

/**
 * How many sides a circle of this radius needs to be within half a grid step
 * of the real thing.
 *
 * The sagitta of a chord — how far the flat falls short of the arc at its
 * middle — is r(1 - cos(pi/n)). Solving that for half a step is the whole
 * derivation, and it is why this is a function of the radius rather than a
 * constant: a 2 mm hole needs eight sides to be indistinguishable and a 100 mm
 * disc needs fifty.
 *
 * Capped at 64 because a cage is edited by hand, and floored at 6 because
 * fewer than that is a shape somebody asked for by name, not a circle.
 */
export function circleSides(radiusSteps: number): number {
  if (!(radiusSteps > 0)) return 6;
  const ratio = 1 - 0.5 / radiusSteps;
  if (ratio <= -1) return 6;
  // Ceiling, not floor: the requirement is that the sagitta stays UNDER half a
  // step, and rounding the side count down is rounding the error up.
  const sides = Math.ceil(Math.PI / Math.acos(Math.max(-1, Math.min(1, ratio))));
  return Math.max(6, Math.min(64, sides));
}

/**
 * The corners of a regular polygon on the grid, wound counter-clockwise seen
 * from the +`axis` side.
 *
 * Rounded to the grid on the way out, which is the point: the ring is exact
 * lattice data the moment it exists, so every later operation — mirroring,
 * bridging, a dimension typed in millimetres — behaves the same on it as on a
 * ring drawn by hand.
 *
 * Two corners that round to the same grid point are collapsed rather than
 * refused; a twelve-sided ring of radius 2 is an octagon and saying so is more
 * use than an error. Fewer than three left is not a profile.
 */
export function ringCoords(
  centre: LatticeCoord,
  radiusSteps: number,
  axis: Axis,
  sides = 0,
  startDegrees = 0,
): LatticeCoord[] | null {
  const count = sides > 0 ? Math.floor(sides) : circleSides(radiusSteps);
  if (count < 3 || !(radiusSteps > 0)) return null;
  const [u, v] = planeAxes(axis);
  const from = (startDegrees * Math.PI) / 180;

  const out: LatticeCoord[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    const theta = from + (2 * Math.PI * i) / count;
    const coord: LatticeCoord = [centre[0], centre[1], centre[2]];
    coord[u] = centre[u] + Math.round(radiusSteps * Math.cos(theta));
    coord[v] = centre[v] + Math.round(radiusSteps * Math.sin(theta));
    // Every corner, not just the one before it: at a radius of a step or two,
    // two corners a third of the way apart can round onto the same point, and a
    // face that visits one vertex twice is a face the evaluator cannot make
    // sense of.
    if (seen.has(`${coord[0]},${coord[1]},${coord[2]}`)) continue;
    seen.add(`${coord[0]},${coord[1]},${coord[2]}`);
    out.push(coord);
  }
  return out.length >= 3 ? out : null;
}

/**
 * A cubic Bézier curve, as the grid points it passes through — the START AND
 * END LEFT OUT, because the caller already has both and is joining them.
 *
 * Sampled densely enough that consecutive samples are never more than a grid
 * step apart, then rounded to the grid, so the result is a chain of distinct
 * lattice points that a face can be built from. Runs of points along one
 * straight line are reduced to their ends — a curve that happens to follow
 * an axis for a while should cost two corners there, not twenty — and if the
 * chain would still have more corners than `maxCorners` it is resampled
 * coarser until it does not, since a cage is edited by hand afterwards and a
 * five-hundred-cornered face is not one anybody can edit.
 *
 * The plane is whichever axis all four points share; a control point that has
 * wandered off it is flattened onto it rather than refused.
 */
export function curveCoords(
  from: LatticeCoord,
  control1: LatticeCoord,
  control2: LatticeCoord,
  to: LatticeCoord,
  axis: Axis,
  snap = 1,
  maxCorners = 64,
): LatticeCoord[] {
  const a = AXIS_INDEX[axis];
  const [u, v] = planeAxes(axis);
  const at = (t: number): [number, number] => {
    const s = 1 - t;
    const w0 = s * s * s;
    const w1 = 3 * s * s * t;
    const w2 = 3 * s * t * t;
    const w3 = t * t * t;
    return [
      w0 * from[u] + w1 * control1[u] + w2 * control2[u] + w3 * to[u],
      w0 * from[v] + w1 * control1[v] + w2 * control2[v] + w3 * to[v],
    ];
  };
  // The control polygon is never shorter than the curve, so its length in
  // grid steps is a safe count of samples for "never more than a step apart".
  const hull = Math.hypot(control1[u] - from[u], control1[v] - from[v])
    + Math.hypot(control2[u] - control1[u], control2[v] - control1[v])
    + Math.hypot(to[u] - control2[u], to[v] - control2[v]);
  let samples = Math.max(8, Math.ceil((hull / snap) * 2));

  const key = (c: LatticeCoord) => `${c[0]},${c[1]},${c[2]}`;
  const ends = new Set([key(from), key(to)]);
  for (;;) {
    const chain: LatticeCoord[] = [];
    const seen = new Set<string>();
    for (let i = 1; i < samples; i++) {
      const [pu, pv] = at(i / samples);
      const coord: LatticeCoord = [from[0], from[1], from[2]];
      coord[a] = from[a];
      coord[u] = Math.round(pu / snap) * snap;
      coord[v] = Math.round(pv / snap) * snap;
      const k = key(coord);
      if (seen.has(k) || ends.has(k)) continue;
      seen.add(k);
      chain.push(coord);
    }
    // Straight runs: a middle point on the line through its neighbours adds
    // nothing to the outline. Checked against the real ends too, so a curve
    // that leaves its start along an axis does not keep the first step of it.
    const kept: LatticeCoord[] = [];
    let p: LatticeCoord = from;
    for (let i = 0; i < chain.length; i++) {
      const q = chain[i];
      const r = chain[i + 1] ?? to;
      const cross = (q[u] - p[u]) * (r[v] - q[v]) - (q[v] - p[v]) * (r[u] - q[u]);
      const dot = (q[u] - p[u]) * (r[u] - q[u]) + (q[v] - p[v]) * (r[v] - q[v]);
      if (cross === 0 && dot > 0) continue;
      kept.push(q);
      p = q;
    }
    if (kept.length <= maxCorners || samples <= 8) return kept;
    samples = Math.max(8, Math.floor(samples / 2));
  }
}

/**
 * Pours one cage into another, each corner of the source landing where `map`
 * says — a source coordinate in, a target coordinate out.
 *
 * Corners that land on a target corner that already exists simply become that
 * corner, which is what lets two shapes drawn to meet at a face actually meet
 * there. A source face whose corners collapse onto each other (the map rounds
 * to the grid, and two corners a hair apart can round together) is dropped
 * rather than refused, the same allowance ringCoords makes. Creases come
 * across with the edges they were on. Returns how many faces were added.
 */
export function mergeLattice(
  target: Lattice,
  source: Lattice,
  map: (coord: LatticeCoord) => LatticeCoord,
): number {
  const remap = new Map<number, number>();
  const of = (v: number) => {
    let t = remap.get(v);
    if (t === undefined) {
      const [i, j, k] = map(coordOf(source, v));
      t = vertexAt(target, i, j, k);
      remap.set(v, t);
    }
    return t;
  };
  let added = 0;
  for (const verts of source.faces) {
    if (!verts) continue;
    const mapped = verts.map(of);
    const unique = mapped.filter((v, i) => mapped.indexOf(v) === i);
    if (unique.length < 3) continue;
    if (addFace(target, unique) !== -1) added++;
  }
  const sharp = creaseEdges(source);
  for (let i = 0; i < sharp.length; i += 2) setCrease(target, of(sharp[i]), of(sharp[i + 1]), true);
  for (const chain of source.wires) addWire(target, chain.map(of));
  return added;
}

/** Places a regular polygon as one closed face, and gives back its index. */
export function addRing(
  lattice: Lattice,
  centre: LatticeCoord,
  radiusSteps: number,
  axis: Axis,
  sides = 0,
  startDegrees = 0,
): number {
  const ring = ringCoords(centre, radiusSteps, axis, sides, startDegrees);
  if (!ring) return -1;
  return addFace(lattice, ring.map(([i, j, k]) => vertexAt(lattice, i, j, k)));
}

/**
 * Puts a set of edges in order, as a single open or closed run of vertices.
 *
 * What turns "the edges I selected" into "the profile" — a revolve needs to
 * know which end is which, and a selection is a bag. Anything that is not one
 * unbroken run — two separate pieces, or a junction where three edges meet — is
 * refused rather than guessed at, because the guess would be a shape nobody
 * asked for and the fix (select less) is obvious.
 */
export function chainFromEdges(edges: [number, number][]): { chain: number[]; closed: boolean } | null {
  if (edges.length === 0) return null;
  const links = new Map<number, number[]>();
  for (const [a, b] of edges) {
    if (a === b) return null;
    links.set(a, [...(links.get(a) ?? []), b]);
    links.set(b, [...(links.get(b) ?? []), a]);
  }
  const ends: number[] = [];
  for (const [vertex, to] of links) {
    if (to.length === 1) ends.push(vertex);
    else if (to.length !== 2) return null;
  }
  if (ends.length !== 0 && ends.length !== 2) return null;

  const closed = ends.length === 0;
  const start = closed ? edges[0][0] : Math.min(...ends);
  const chain = [start];
  let previous = -1;
  let here = start;
  for (let guard = 0; guard < edges.length; guard++) {
    const next = (links.get(here) ?? []).find((n) => n !== previous);
    if (next === undefined) break;
    if (next === start) break;
    chain.push(next);
    previous = here;
    here = next;
  }
  // Every edge accounted for, or the selection was in more than one piece.
  if (chain.length !== (closed ? links.size : links.size)) return null;
  return { chain, closed };
}

/**
 * Sweeps a profile about a grid axis, the way a lathe does.
 *
 * The operation the lattice was missing, and the reason "extrude a face" was
 * not enough: extrude makes prisms, and every turned feature — a boss, a
 * spigot, a knob, the bell of a funnel — is a profile taken round an axis.
 *
 * `through` names the line: only its two off-axis numbers matter, and they are
 * what the profile's radius is measured from. A profile point sitting ON the
 * line does not move, so the ring it would have made collapses to a single
 * vertex and the quads either side of it become triangles — which is exactly
 * what a pole is, and how a revolve closes at the ends without a special case.
 *
 * Rounded to the grid at every step, like `ringCoords`: the result is ordinary
 * lattice data, mirrorable, dimensionable and smoothable like anything else.
 */
export function revolveChain(
  lattice: Lattice,
  chain: number[],
  axis: Axis,
  through: LatticeCoord,
  segments = 0,
  degrees = 360,
): { faces: number[]; rings: number[][] } | null {
  if (chain.length < 2) return null;
  const spin = Math.max(-360, Math.min(360, degrees));
  if (Math.abs(spin) < 1) return null;
  const [u, v] = planeAxes(axis);
  const a = AXIS_INDEX[axis];

  const profile = chain.map((vertex) => coordOf(lattice, vertex));
  // The number of segments comes from the widest point, for the same reason a
  // circle's side count does: it is the one that decides how faceted the result
  // looks, and the narrow end of a profile costs nothing to oversample.
  let widest = 0;
  for (const point of profile) widest = Math.max(widest, Math.hypot(point[u] - through[u], point[v] - through[v]));
  const whole = Math.abs(spin) >= 359.999;
  const steps = segments > 0
    ? Math.floor(segments)
    : Math.max(3, Math.round((circleSides(widest) * Math.abs(spin)) / 360));
  if (steps < 1) return null;

  const rings: LatticeCoord[][] = [];
  const stops = whole ? steps : steps + 1;
  for (let k = 0; k < stops; k++) {
    const theta = ((spin * Math.PI) / 180) * (k / steps);
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    rings.push(profile.map((point) => {
      const du = point[u] - through[u];
      const dv = point[v] - through[v];
      const turned: LatticeCoord = [0, 0, 0];
      turned[a] = point[a];
      turned[u] = through[u] + Math.round(du * cos - dv * sin);
      turned[v] = through[v] + Math.round(du * sin + dv * cos);
      return turned;
    }));
  }

  const index = (c: LatticeCoord) => vertexAt(lattice, c[0], c[1], c[2]);
  const faces: number[] = [];
  for (let k = 0; k < steps; k++) {
    const here = rings[k];
    const next = rings[(k + 1) % rings.length];
    for (let j = 0; j + 1 < profile.length; j++) {
      // Deduped, so a point on the axis turns its quad into the triangle it
      // geometrically is rather than a quad with two corners in one place.
      const ring = [here[j], here[j + 1], next[j + 1], next[j]].map(index);
      const corners: number[] = [];
      for (const vertex of ring) if (corners[corners.length - 1] !== vertex) corners.push(vertex);
      if (corners.length > 2 && corners[0] === corners[corners.length - 1]) corners.pop();
      if (corners.length < 3) continue;
      const added = addFace(lattice, corners);
      if (added !== -1) faces.push(added);
    }
  }
  if (faces.length === 0) return null;
  orientFaces(lattice);
  // The profile at each stop, as vertices — what a caller needs to cap a
  // partial sweep, where the two ends are open by definition.
  return { faces, rings: rings.map((ring) => ring.map(index)) };
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

/** The vertices some face or wire still uses, in index order. */
function usedVertices(lattice: Lattice): number[] {
  const used = new Set<number>();
  for (const verts of lattice.faces) {
    if (!verts) continue;
    for (const v of verts) used.add(v);
  }
  for (const chain of lattice.wires) for (const v of chain) used.add(v);
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
    // How many separate bodies the cage could be split into.
    parts: separablePieces(lattice).length,
  };
}

/**
 * The cage as its separate pieces — groups of faces and wires that share no
 * corner with each other — each as a cage of its own, in the same frame.
 *
 * A lattice can be several things: two shapes drawn beside each other, a part
 * and the spare face left over from a change of mind, a cage that had two
 * bodies poured into it with Add. Modelling wants them as one; moving one
 * against the other, or subtracting one from the other, wants them apart.
 * One piece comes back as one cage; an empty cage comes back as none.
 */
/**
 * The pieces that could each be a body: those with faces. A wire on its own
 * is an outline, not a shape, and a body made of one cannot be built — so
 * wire-only pieces ride along with the first piece that has faces.
 */
export function separablePieces(lattice: Lattice): Lattice[] {
  const pieces = splitLattice(lattice);
  const solid = pieces.filter((p) => p.faces.some(Boolean));
  if (solid.length === 0) return pieces.length > 0 ? [pieces[0]] : [];
  for (const loose of pieces) {
    if (loose.faces.some(Boolean)) continue;
    mergeLattice(solid[0], loose, (c) => c);
  }
  return solid;
}

export function splitLattice(lattice: Lattice): Lattice[] {
  const n = vertexCount(lattice);
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (v: number): number => {
    while (parent[v] !== v) {
      parent[v] = parent[parent[v]];
      v = parent[v];
    }
    return v;
  };
  const unite = (a: number, b: number) => { parent[find(a)] = find(b); };
  for (const verts of lattice.faces) {
    if (!verts) continue;
    for (let i = 1; i < verts.length; i++) unite(verts[0], verts[i]);
  }
  for (const chain of lattice.wires) for (let i = 1; i < chain.length; i++) unite(chain[0], chain[i]);

  const pieces = new Map<number, Lattice>();
  const pieceOf = (v: number) => {
    const root = find(v);
    let piece = pieces.get(root);
    if (!piece) {
      piece = createLattice(lattice.unit);
      pieces.set(root, piece);
    }
    return piece;
  };
  const carry = (piece: Lattice, v: number) => {
    const [i, j, k] = coordOf(lattice, v);
    return vertexAt(piece, i, j, k);
  };
  for (const verts of lattice.faces) {
    if (!verts) continue;
    const piece = pieceOf(verts[0]);
    addFace(piece, verts.map((v) => carry(piece, v)));
  }
  for (const chain of lattice.wires) {
    const piece = pieceOf(chain[0]);
    addWire(piece, chain.map((v) => carry(piece, v)));
  }
  const sharp = creaseEdges(lattice);
  for (let i = 0; i < sharp.length; i += 2) {
    const piece = pieceOf(sharp[i]);
    setCrease(piece, carry(piece, sharp[i]), carry(piece, sharp[i + 1]), true);
  }
  return [...pieces.values()];
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

/**
 * Triangulates every polygon in a mesh, by clipping ears rather than fanning.
 *
 * A fan is correct only for a CONVEX polygon, and this mode goes out of its way
 * to let you draw polygons that are not: nothing auto-closes precisely so that
 * any outline can be drawn. Fanning an L-shaped face produces triangles that
 * cross the notch and overlap each other — a wrong solid that shows up as a
 * stray triangle flickering against its neighbours, which is exactly what it
 * looks like.
 *
 * Ear clipping runs in the face's own plane: the polygon is projected down the
 * axis its normal leans on most, wound counter-clockwise, and corners are
 * clipped off one at a time whenever the triangle they make is empty of the
 * other corners. Winding is preserved, so a face that pointed outwards still
 * does. Anything degenerate — a face folded on itself, three collinear corners
 * — falls back to the fan, which is no worse than what it replaced.
 */
export function triangulate(faces: number[][], positions: number[]): number[] {
  const out: number[] = [];
  for (const face of faces) {
    if (face.length < 3) continue;
    if (face.length === 3) {
      out.push(face[0], face[1], face[2]);
      continue;
    }
    const clipped = earClip(face, positions);
    if (clipped) out.push(...clipped);
    else for (let i = 1; i + 1 < face.length; i++) out.push(face[0], face[i], face[i + 1]);
  }
  return out;
}

/** The ears of one polygon, or null if it could not be clipped. */
function earClip(face: number[], positions: number[]): number[] | null {
  const at = (v: number, k: 0 | 1 | 2) => positions[v * 3 + k];

  // Newell's normal: right for any planar polygon, convex or not, and it does
  // not care which corner it starts at.
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < face.length; i++) {
    const a = face[i];
    const b = face[(i + 1) % face.length];
    nx += (at(a, 1) - at(b, 1)) * (at(a, 2) + at(b, 2));
    ny += (at(a, 2) - at(b, 2)) * (at(a, 0) + at(b, 0));
    nz += (at(a, 0) - at(b, 0)) * (at(a, 1) + at(b, 1));
  }
  const abs = [Math.abs(nx), Math.abs(ny), Math.abs(nz)];
  const drop = abs[0] >= abs[1] && abs[0] >= abs[2] ? 0 : abs[1] >= abs[2] ? 1 : 2;
  if (abs[drop] < 1e-18) return null; // no area to speak of

  // Project onto the two axes that survive, keeping the handedness of the
  // dropped one so that a counter-clockwise face stays counter-clockwise.
  const [u, v]: [0 | 1 | 2, 0 | 1 | 2] = drop === 0 ? [1, 2] : drop === 1 ? [2, 0] : [0, 1];
  const flip = (drop === 0 ? nx : drop === 1 ? ny : nz) < 0;
  const points = face.map((vertex) => ({ x: at(vertex, u), y: at(vertex, v) }));

  // Work on a ring wound counter-clockwise in the projection; the output is
  // written back in the original order, so the face keeps its side.
  const order = flip ? [...face.keys()].reverse() : [...face.keys()];
  const ring = [...order];

  const cross = (o: number, a: number, b: number) => {
    const pa = points[a], pb = points[b], po = points[o];
    return (pa.x - po.x) * (pb.y - po.y) - (pa.y - po.y) * (pb.x - po.x);
  };
  const inside = (a: number, b: number, c: number, p: number) => {
    const d1 = cross(a, b, p);
    const d2 = cross(b, c, p);
    const d3 = cross(c, a, p);
    return d1 >= 0 && d2 >= 0 && d3 >= 0;
  };

  const out: number[] = [];
  let guard = ring.length * ring.length + 16;
  while (ring.length > 3 && guard-- > 0) {
    let clippedOne = false;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[(i + ring.length - 1) % ring.length];
      const b = ring[i];
      const c = ring[(i + 1) % ring.length];
      if (cross(a, b, c) <= 0) continue; // reflex corner, or collinear
      let empty = true;
      for (const other of ring) {
        if (other === a || other === b || other === c) continue;
        if (inside(a, b, c, other)) { empty = false; break; }
      }
      if (!empty) continue;
      // Wound counter-clockwise in the projection. If the polygon had to be
      // reversed to get there, each triangle is reversed on the way back out,
      // or the face would come back pointing the wrong way.
      if (flip) out.push(face[c], face[b], face[a]);
      else out.push(face[a], face[b], face[c]);
      ring.splice(i, 1);
      clippedOne = true;
      break;
    }
    // A polygon with no ear left is one this cannot handle: self-intersecting,
    // or not flat enough to project.
    if (!clippedOne) return null;
  }
  if (ring.length !== 3) return null;
  if (flip) out.push(face[ring[2]], face[ring[1]], face[ring[0]]);
  else out.push(face[ring[0]], face[ring[1]], face[ring[2]]);
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

  return { vertices, renderVertices, faces: triangulate(poly.faces, poly.positions), origin };
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
  // Wires too: they are edges to pick, to loop along and to sweep, and a
  // profile drawn for a lathe has to be selectable before it is a face.
  for (const chain of lattice.wires) {
    for (let i = 1; i < chain.length; i++) {
      const a = chain[i - 1];
      const b = chain[i];
      const edge = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (seen.has(edge)) continue;
      seen.add(edge);
      out.push(a, b);
    }
  }
  return out;
}

/** The wires' edges alone, as vertex index pairs, for drawing them apart. */
export function wireEdges(lattice: Lattice): number[] {
  const out: number[] = [];
  for (const chain of lattice.wires) {
    for (let i = 1; i < chain.length; i++) out.push(chain[i - 1], chain[i]);
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
  /** Open chains back to back, like `faces`; `wireSizes` says where each ends. Absent before wires. */
  wires?: number[];
  wireSizes?: number[];
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
  const wires: number[] = [];
  const wireSizes: number[] = [];
  for (const chain of lattice.wires) {
    wireSizes.push(chain.length);
    for (const v of chain) wires.push(remap.get(v)!);
  }
  return { unit: lattice.unit, coords, faces, faceSizes, creases, wires, wireSizes };
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
  let wireAt = 0;
  for (const size of cage.wireSizes ?? []) {
    const chain: number[] = [];
    for (let i = 0; i < size; i++) chain.push(vertices[(cage.wires ?? [])[wireAt + i]]);
    wireAt += size;
    addWire(lattice, chain);
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
  copy.wires = lattice.wires.map((chain) => [...chain]);
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
  lattice.wires = snapshot.wires.map((chain) => [...chain]);
  lattice.revision++;
}
