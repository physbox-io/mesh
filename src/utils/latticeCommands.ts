// ---------------------------------------------------------------------------
// Lattice modelling without a pointer
// ---------------------------------------------------------------------------
//
// The viewport resolves a click into a grid coordinate by raycasting a dot
// field; a caller arriving over MCP has no pointer, no camera and no dots. What
// it has instead is better: this mode's whole state is integers on a grid, so a
// position can simply be SAID.
//
// That is the one place lattice modelling is easier to drive blind than
// sculpting is. A sculpt request has to be snapped to a surface whose shape the
// caller cannot see, and a coordinate guessed from a bounding box is usually
// thin air — hence physics_probe_sculpt. Here, "the corner at 20, -10, 0" is
// exactly a corner, it is the same corner on the next call, and reading the
// model back gives coordinates that can be fed straight in again.
//
// Callers speak MILLIMETRES in the body's own frame, not grid steps: millimetres
// are what a part is specified in, and the grid is 0.1 mm, so every tenth of a
// millimetre is exactly representable and nothing is lost in the conversion.
//
// Everything here is a pure function of a cage and a request. The bridge does
// the store work; this does the geometry, and can be tested without a viewport.
// ---------------------------------------------------------------------------

import {
  addFace, coordOf, edgeKey, extrudeFace, faceNormal, findFace, findMirrorFace, findVertex,
  edgeLoop, isCrease, isWatertight, latticeBounds, latticeStats, mirrorCoord, mirrorFace,
  removeFace, setCrease, vertexAt, dominantAxis,
  type Axis, type Lattice, type LatticeCoord,
} from './latticeMesh';

/** Millimetres per grid step. */
const mmPerStep = (unit: number) => unit * 1000;

/** A point in millimetres, as the nearest grid coordinate. */
export function coordFromMm(point: number[], unit: number): LatticeCoord {
  const step = mmPerStep(unit);
  return [
    Math.round(point[0] / step),
    Math.round(point[1] / step),
    Math.round(point[2] / step),
  ];
}

/** A grid coordinate, in millimetres. */
export function mmFromCoord(coord: LatticeCoord, unit: number): number[] {
  const step = mmPerStep(unit);
  // Rounded to the tenth: the arithmetic is exact but binary floats are not, and
  // a reply full of 19.900000000000002 is a reply a caller cannot compare.
  return coord.map((c) => Math.round(c * step * 10) / 10);
}

/** How far a requested point had to move to land on the grid, in millimetres. */
function snapError(point: number[], coord: LatticeCoord, unit: number): number {
  const landed = mmFromCoord(coord, unit);
  return Math.max(...landed.map((v, i) => Math.abs(v - point[i])));
}

function validPoint(point: unknown): point is number[] {
  return Array.isArray(point) && point.length >= 3 && point.every((v) => typeof v === 'number' && Number.isFinite(v));
}

export interface FaceReport {
  /** Corners as given, so a caller can tell which request this refers to. */
  face: number[][];
  reason: string;
}

/**
 * Adds faces given as lists of corners in millimetres.
 *
 * Corners that do not fall on the grid are snapped rather than refused — a
 * caller working in whole millimetres on a 0.1 mm grid is always exact, and one
 * that is a little off meant the nearest point — but the largest correction made
 * is reported, because a snap of half a step is a rounding and a snap of five is
 * a mistake in the numbers.
 */
export function addFacesMm(
  lattice: Lattice,
  faces: unknown,
  mirror?: Axis,
): { added: number; skipped: FaceReport[]; snappedBy: number } {
  if (!Array.isArray(faces) || faces.length === 0) {
    throw new Error('faces must be a list of faces, each a list of 3 or 4 corners [x, y, z] in millimetres');
  }

  let added = 0;
  let snappedBy = 0;
  const skipped: FaceReport[] = [];

  for (const face of faces) {
    if (!Array.isArray(face) || face.length < 3 || face.length > 4 || !face.every(validPoint)) {
      skipped.push({ face: face as number[][], reason: 'a face is 3 or 4 corners, each [x, y, z] in millimetres' });
      continue;
    }
    const corners = face.map((point) => {
      const coord = coordFromMm(point, lattice.unit);
      snappedBy = Math.max(snappedBy, snapError(point, coord, lattice.unit));
      return coord;
    });
    const verts = corners.map(([i, j, k]) => vertexAt(lattice, i, j, k));
    if (new Set(verts).size !== verts.length) {
      skipped.push({ face, reason: 'two corners are the same point once snapped to the grid' });
      continue;
    }
    const index = addFace(lattice, verts);
    if (index === -1) {
      skipped.push({ face, reason: 'a face with these corners and this winding already exists' });
      continue;
    }
    added++;
    if (mirror) mirrorFace(lattice, index, mirror);
  }

  return { added, skipped, snappedBy: Math.round(snappedBy * 100) / 100 };
}

/** The face with these corners, whatever order they are given in. */
export function findFaceMm(lattice: Lattice, face: unknown): number {
  if (!Array.isArray(face) || !face.every(validPoint)) return -1;
  const verts: number[] = [];
  for (const point of face) {
    const [i, j, k] = coordFromMm(point, lattice.unit);
    const vertex = findVertex(lattice, i, j, k);
    if (vertex === -1) return -1;
    verts.push(vertex);
  }
  const forwards = findFace(lattice, verts);
  if (forwards !== -1) return forwards;
  // Corners given the other way round name the same face to a human, and a
  // caller reading a face back and passing it to delete should not have to care
  // which way the winding happened to come out.
  return findFace(lattice, [...verts].reverse());
}

export function removeFacesMm(lattice: Lattice, faces: unknown, mirror?: Axis): { removed: number; missing: FaceReport[] } {
  if (!Array.isArray(faces) || faces.length === 0) {
    throw new Error('faces must be a list of faces to remove, each a list of corners [x, y, z] in millimetres');
  }
  let removed = 0;
  const missing: FaceReport[] = [];
  for (const face of faces) {
    const index = findFaceMm(lattice, face);
    if (index === -1) {
      missing.push({ face: face as number[][], reason: 'no face has these corners' });
      continue;
    }
    const partner = mirror ? findMirrorFace(lattice, index, mirror) : -1;
    if (removeFace(lattice, index)) removed++;
    if (partner !== -1) removeFace(lattice, partner);
  }
  return { removed, missing };
}

/**
 * Pushes a face out by a distance in millimetres.
 *
 * The distance is rounded to whole grid steps, because an extrusion that landed
 * between grid points would put corners off the lattice and every later
 * operation on them would miss.
 */
export function extrudeMm(
  lattice: Lattice,
  face: unknown,
  distanceMm: number,
  axis?: Axis,
  mirror?: Axis,
): { steps: number; distanceMm: number; sides: number; cap: number[][] } {
  const index = findFaceMm(lattice, face);
  if (index === -1) {
    throw new Error('No face has those corners — read the shape back with physics_get_lattice and use the corners it reports');
  }
  const steps = Math.round(distanceMm / mmPerStep(lattice.unit));
  if (steps === 0) {
    throw new Error(`A distance of ${distanceMm} mm is less than half a grid step (${mmPerStep(lattice.unit)} mm), so it would move nothing`);
  }

  const partner = mirror ? findMirrorFace(lattice, index, mirror) : -1;
  const result = extrudeFace(lattice, index, steps, axis);
  if (!result) throw new Error('That face could not be extruded');
  if (partner !== -1) extrudeFace(lattice, partner, steps, axis);

  const capVerts = lattice.faces[result.cap] ?? [];
  return {
    steps,
    distanceMm: Math.round(steps * mmPerStep(lattice.unit) * 10) / 10,
    sides: result.sides.length,
    cap: capVerts.map((v) => mmFromCoord(coordOf(lattice, v), lattice.unit)),
  };
}

/**
 * Marks edges sharp, or lets them round off again.
 *
 * Each edge is a PAIR of corners in millimetres. Without this, smoothing is all
 * or nothing — a cage is either a faceted box or a pebble, and almost nothing
 * worth making is either.
 *
 * `loop` grows each edge to the whole ring it belongs to, which is what a rim
 * usually is. Naming a dozen edges by their coordinates is a dozen chances to
 * get one wrong, and a single soft edge in a hard rim only shows itself after
 * the shape is smoothed, as a dent.
 *
 * An entry of THREE OR MORE corners is read as a face rather than an edge, and
 * marks that face's whole border. It is the only cheap way to reach the rim of
 * a cap: the corners around one are three-way, so no loop runs through them and
 * none ever will, and the alternative is naming four edges that share eight
 * corners between them.
 */
export function sharpenEdgesMm(
  lattice: Lattice,
  edges: unknown,
  sharp: boolean,
  mirror?: Axis,
  loop = false,
): { changed: number; skipped: FaceReport[] } {
  if (!Array.isArray(edges) || edges.length === 0) {
    throw new Error('edges must be a list of edges, each a pair of corners [[x, y, z], [x, y, z]] in millimetres');
  }
  let changed = 0;
  const skipped: FaceReport[] = [];

  for (const edge of edges) {
    if (!Array.isArray(edge) || edge.length < 2 || !edge.every(validPoint)) {
      skipped.push({ face: edge as number[][], reason: 'an edge is two corners, or three and up for a whole face border, each [x, y, z] in millimetres' });
      continue;
    }
    const verts = edge.map((point) => {
      const [i, j, k] = coordFromMm(point, lattice.unit);
      return findVertex(lattice, i, j, k);
    });
    if (verts.some((v) => v === -1)) {
      skipped.push({ face: edge, reason: 'no corner of the shape is at one of those points' });
      continue;
    }

    let targets: [number, number][];
    if (verts.length > 2) {
      const face = findFaceMm(lattice, edge);
      if (face === -1) {
        skipped.push({ face: edge, reason: 'no face has those corners' });
        continue;
      }
      const corners = lattice.faces[face]!;
      targets = corners.map((v, i) => [v, corners[(i + 1) % corners.length]] as [number, number]);
    } else {
      targets = loop ? edgeLoop(lattice, verts[0], verts[1]) : [[verts[0], verts[1]] as [number, number]];
    }
    let touched = 0;
    for (const [p, q] of targets) if (setCrease(lattice, p, q, sharp)) touched++;
    changed += touched;
    if (touched === 0) {
      skipped.push({ face: edge, reason: sharp ? 'no face runs along that edge, or it is sharp already' : 'that edge was not sharp' });
    }

    if (mirror) {
      for (const [p, q] of targets) {
        const reflected = [p, q].map((v) => {
          const [i, j, k] = mirrorCoord(coordOf(lattice, v), mirror);
          return findVertex(lattice, i, j, k);
        });
        if (!reflected.some((v) => v === -1)) setCrease(lattice, reflected[0], reflected[1], sharp);
      }
    }
  }

  return { changed, skipped };
}

/** Counts, bounds and health — the reply every operation ends with. */
export function latticeSummary(lattice: Lattice) {
  const stats = latticeStats(lattice);
  const bounds = latticeBounds(lattice);
  return {
    ...stats,
    stepMm: mmPerStep(lattice.unit),
    bounds: bounds
      ? { min: mmFromCoord(bounds.min, lattice.unit), max: mmFromCoord(bounds.max, lattice.unit) }
      : null,
    sizeMm: bounds
      ? bounds.max.map((v, i) => Math.round((v - bounds.min[i]) * mmPerStep(lattice.unit) * 10) / 10)
      : null,
  };
}

/**
 * The whole shape, as the corners it is made of.
 *
 * Faces come back as coordinates rather than indices into a vertex list, so a
 * reply can be fed straight back into extrude or delete without the caller
 * keeping a table of what index meant what — the numbers ARE the identity here,
 * which is not true of any other geometry in this app.
 */
export function describeLattice(lattice: Lattice) {
  const faces: { corners: number[][]; normal: string; sharpEdges: number[][][] }[] = [];
  lattice.faces.forEach((verts, f) => {
    if (!verts) return;
    const normal = faceNormal(lattice, f);
    const facing = normal ? dominantAxis(normal) : null;
    // Reported per face rather than as a separate list, because a crease is
    // only meaningful as an edge OF something — and a caller that has just read
    // a face has the corners it needs to pass straight back.
    const sharpEdges: number[][][] = [];
    const seen = new Set<string>();
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      if (!isCrease(lattice, a, b) || seen.has(edgeKey(a, b))) continue;
      seen.add(edgeKey(a, b));
      sharpEdges.push([mmFromCoord(coordOf(lattice, a), lattice.unit), mmFromCoord(coordOf(lattice, b), lattice.unit)]);
    }
    faces.push({
      corners: verts.map((v) => mmFromCoord(coordOf(lattice, v), lattice.unit)),
      normal: facing ? `${facing.sign > 0 ? '+' : '-'}${facing.axis}` : 'degenerate',
      sharpEdges,
    });
  });
  return { ...latticeSummary(lattice), watertight: isWatertight(lattice), faces };
}
