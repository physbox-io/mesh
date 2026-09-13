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
  bevelFace, bridgeFaces, edgeLoop, insetFace, isCrease, isWatertight, latticeBounds,
  latticeStats, mirrorCoord, mirrorFace,
  removeFace, setCrease, vertexAt, dominantAxis,
  moveVertices, scaleVertices, vertexCount, AXIS_INDEX,
  bevelEdges, ringCoords, revolveChain,
  type Axis, type Lattice, type LatticeCoord, type BevelMode,
} from './latticeMesh';

/** Millimetres per grid step. */
const mmPerStep = (unit: number) => unit * 1000;

/**
 * Millimetres as a whole number of grid steps.
 *
 * The rounding goes through a nine-place round trip first, because the division
 * that gets here is floating point and lands just under the halfway mark far
 * more often than it lands just over: 6.35 / 0.1 is 63.49999999999999, which
 * rounds DOWN to 6.3 mm — a tenth short of a number somebody typed, in the one
 * part of the app whose whole purpose is saying an exact dimension.
 */
const stepsOf = (mm: number, step: number) => Math.round(Number((mm / step).toFixed(9)));

/** A point in millimetres, as the nearest grid coordinate. */
export function coordFromMm(point: number[], unit: number): LatticeCoord {
  const step = mmPerStep(unit);
  return [
    stepsOf(point[0], step),
    stepsOf(point[1], step),
    stepsOf(point[2], step),
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
    throw new Error('faces must be a list of faces, each a list of three or more corners [x, y, z] in millimetres');
  }

  let added = 0;
  let snappedBy = 0;
  const skipped: FaceReport[] = [];

  for (const face of faces) {
    // Three corners and up. The cap of four this used to have was left over
    // from when a cage was quads and triangles; the editor has drawn any
    // polygon since the day it shipped ("nothing auto-closes" exists precisely
    // so it can), physics_lattice_circle emits up to 64 corners, and the
    // triangulator clips ears rather than fanning. A T-shaped profile is eight
    // corners and was refused here for no reason the rest of the app agrees
    // with.
    if (!Array.isArray(face) || face.length < 3 || !face.every(validPoint)) {
      skipped.push({ face: face as number[][], reason: 'a face is three or more corners, each [x, y, z] in millimetres' });
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

/** Steps for a distance in millimetres, at least one. */
function stepsFromMm(mm: unknown, unit: number): number {
  const steps = stepsOf(typeof mm === 'number' ? mm : 0, mmPerStep(unit));
  if (steps < 1) {
    throw new Error(`That is less than one grid step (${unit * 1000} mm), so it would change nothing`);
  }
  return steps;
}

/**
 * Shrinks a face inside itself, leaving a ring of quads around it.
 *
 * The start of every hole. A face cannot be bridged to another on the same
 * solid until it is smaller than the wall it is in — bridging two whole walls
 * runs the new band along faces that already exist — so this is what makes a
 * tunnel possible, and on its own it is a raised or recessed panel.
 */
export function insetFaceMm(lattice: Lattice, face: unknown, amountMm: number, mirror?: Axis) {
  const index = findFaceMm(lattice, face);
  if (index === -1) {
    throw new Error('No face has those corners — read the shape back with physics_get_lattice and use the corners it reports');
  }
  const steps = stepsFromMm(amountMm, lattice.unit);
  const partner = mirror ? findMirrorFace(lattice, index, mirror) : -1;
  const result = insetFace(lattice, index, steps);
  if (!result) {
    throw new Error('That face cannot be inset by that much — it must lie flat on to an axis, and the inset must be less than half its width');
  }
  if (partner !== -1) insetFace(lattice, partner, steps);
  const innerVerts = lattice.faces[result.inner] ?? [];
  return {
    amountMm: Math.round(steps * lattice.unit * 1000 * 10) / 10,
    border: result.border.length,
    inner: innerVerts.map((v) => mmFromCoord(coordOf(lattice, v), lattice.unit)),
  };
}

/**
 * Cuts the corners off a face, doubling its corner count.
 *
 * How a square becomes a circle: smoothing turns four corners into a rounded
 * square and no amount of it does better, so the roundness has to be in the
 * cage. Bevel a square into an octagon, smooth that, and it reads as round;
 * extrude first and the result is a cylinder.
 */
export function bevelFaceMm(lattice: Lattice, face: unknown, amountMm: number, mirror?: Axis) {
  const index = findFaceMm(lattice, face);
  if (index === -1) {
    throw new Error('No face has those corners — read the shape back with physics_get_lattice and use the corners it reports');
  }
  const steps = stepsFromMm(amountMm, lattice.unit);
  const partner = mirror ? findMirrorFace(lattice, index, mirror) : -1;
  if (!bevelFace(lattice, index, steps)) {
    throw new Error('That face cannot be bevelled — its corners must belong to no other face, its edges must run along an axis or at 45 degrees, and the cut must be under half of every edge');
  }
  if (partner !== -1) bevelFace(lattice, partner, steps);
  return { amountMm: Math.round(steps * lattice.unit * 1000 * 10) / 10 };
}

/**
 * Chamfers or rounds edges of the solid, given in millimetres.
 *
 * The operation `bevelFaceMm` could not do. That one cuts the corners off ONE
 * face and only where those corners belong to nothing else, which on a real
 * part is almost nowhere — every edge of a box is shared. This pulls both faces
 * back from the edge and stitches the tear, which is what a chamfer on a solid
 * actually is.
 *
 * An "edge" here is two corners, or three and up for a whole face's border —
 * the same convenience `sharpenEdgesMm` has, and the reason "chamfer that rim"
 * is one call. `loop` grows a single edge to its whole ring first.
 *
 * All of them go in ONE call to `bevelEdges`, deliberately: a bevel has to see
 * its neighbours to get the corner where two of them meet right, and cutting
 * them one at a time would cut the second from a shape the first had moved.
 */
export function bevelEdgesMm(
  lattice: Lattice,
  edges: unknown,
  radiusMm: number,
  mode: BevelMode = 'chamfer',
  mirror?: Axis,
  loop = false,
): { radiusMm: number; edges: number; strips: number; patches: number } {
  if (!Array.isArray(edges) || edges.length === 0) {
    throw new Error('edges must be a list of edges, each a pair of corners [[x, y, z], [x, y, z]] in millimetres — or three corners and up for a whole face border');
  }
  const steps = stepsFromMm(radiusMm, lattice.unit);

  const targets: [number, number][] = [];
  const seen = new Set<string>();
  const take = (a: number, b: number) => {
    const key = edgeKey(a, b);
    if (seen.has(key)) return;
    seen.add(key);
    targets.push([a, b]);
  };

  for (const edge of edges) {
    if (!Array.isArray(edge) || edge.length < 2 || !edge.every(validPoint)) {
      throw new Error('an edge is two corners, or three and up for a whole face border, each [x, y, z] in millimetres');
    }
    const verts = edge.map((point) => {
      const [i, j, k] = coordFromMm(point, lattice.unit);
      return findVertex(lattice, i, j, k);
    });
    if (verts.some((v) => v === -1)) {
      throw new Error('No corner of the shape is at one of those points — read the shape back with physics_get_lattice and use the corners it reports');
    }
    if (verts.length > 2) {
      const face = findFaceMm(lattice, edge);
      if (face === -1) throw new Error('No face has those corners');
      const corners = lattice.faces[face]!;
      for (let i = 0; i < corners.length; i++) take(corners[i], corners[(i + 1) % corners.length]);
    } else if (loop) {
      for (const [a, b] of edgeLoop(lattice, verts[0], verts[1])) take(a, b);
    } else {
      take(verts[0], verts[1]);
    }
  }

  if (mirror) {
    const reflect = (v: number) => {
      const [i, j, k] = mirrorCoord(coordOf(lattice, v), mirror);
      return findVertex(lattice, i, j, k);
    };
    for (const [a, b] of [...targets]) {
      const [ma, mb] = [reflect(a), reflect(b)];
      // An edge lying in the mirror plane is its own reflection, and cutting it
      // twice is cutting a shape that is no longer there.
      if (ma !== -1 && mb !== -1 && !(ma === a && mb === b)) take(ma, mb);
    }
  }

  const asked = targets.length;
  const result = bevelEdges(lattice, targets, steps, mode);
  if (!result) {
    throw new Error(`Those edges cannot be ${mode === 'fillet' ? 'rounded' : 'chamfered'} by ${radiusMm} mm — every edge must have exactly two faces on it, run along an axis or at 45 degrees, and the cut must leave room on the edges either side of it (half of each where both ends are being cut). Try a smaller radius.`);
  }
  return {
    radiusMm: Math.round(steps * lattice.unit * 1000 * 10) / 10,
    edges: asked,
    strips: result.strips.length,
    patches: result.patches.length,
  };
}

/**
 * Places a circle — or any regular polygon — as one face.
 *
 * There is no circle on an integer grid, and there does not need to be one: at
 * 0.1 mm a polygon rounded to the grid is within 0.05 mm of the true arc, which
 * is finer than anything this app drives can cut. `sides` of 0 works out how
 * many corners that takes from the radius, so a 2 mm hole is light and a 60 mm
 * disc is smooth without either being a guess. Give it 6 for a hex boss, 4 for
 * a square post.
 *
 * The corners come back in millimetres because that is how every other call
 * here names a face: pass them to `physics_lattice_extrude` for a cylinder, or
 * to `physics_lattice_inset` for a rim.
 */
export function addRingMm(
  lattice: Lattice,
  centre: unknown,
  diameterMm: number,
  axis: Axis,
  sides = 0,
  mirror?: Axis,
): { corners: number[][]; sides: number; diameterMm: number } {
  if (!validPoint(centre)) {
    throw new Error('centre must be a point [x, y, z] in millimetres');
  }
  if (typeof diameterMm !== 'number' || !(diameterMm > 0)) {
    throw new Error('diameterMm must be a positive number of millimetres');
  }
  const middle = coordFromMm(centre, lattice.unit);
  const radius = stepsFromMm(diameterMm / 2, lattice.unit);
  const ring = ringCoords(middle, radius, axis, sides);
  if (!ring) {
    throw new Error(`A ring of ${diameterMm} mm with ${sides || 'auto'} sides comes to fewer than three distinct grid points — make it bigger, or ask for fewer sides`);
  }
  const verts = ring.map(([i, j, k]) => vertexAt(lattice, i, j, k));
  const face = addFace(lattice, verts);
  if (face === -1) {
    throw new Error('A face with those corners already exists');
  }
  if (mirror) mirrorFace(lattice, face, mirror);
  return {
    corners: ring.map((coord) => mmFromCoord(coord, lattice.unit)),
    sides: ring.length,
    diameterMm: Math.round(radius * 2 * lattice.unit * 1000 * 10) / 10,
  };
}

/**
 * Sweeps a profile about one of the body's axes, the way a lathe does.
 *
 * The operation extrude is not: extrude drags a face along its own normal and
 * makes prisms, and every turned feature — a boss, a spigot, a knob, the bell
 * of a funnel — is a profile taken round an axis.
 *
 * The profile is a run of points in order, and it does not have to be drawn
 * first: corners that are not there yet are created, so a whole turned part is
 * one call. How far each point sits from the axis IS its radius, so there is no
 * second number to get wrong; a point sitting ON the axis becomes the pole,
 * which is how a cone is a two-point profile. `closed` joins the last point
 * back to the first, which is what makes a solid ring rather than a shell.
 */
export function revolveMm(
  lattice: Lattice,
  profile: unknown,
  axis: Axis,
  degrees = 360,
  options: { throughMm?: number[]; segments?: number; closed?: boolean } = {},
): { facesAdded: number; segments: number; degrees: number; closed: boolean } {
  if (!Array.isArray(profile) || profile.length < 2 || !profile.every(validPoint)) {
    throw new Error('profile must be two or more points [x, y, z] in millimetres, in the order they run along the profile');
  }
  const spin = typeof degrees === 'number' && Number.isFinite(degrees) ? degrees : 360;
  if (Math.abs(spin) < 1 || Math.abs(spin) > 360) {
    throw new Error('degrees must be between 1 and 360 — a full turn closes the shape onto itself, anything less leaves both ends open');
  }
  const through = validPoint(options.throughMm)
    ? coordFromMm(options.throughMm, lattice.unit)
    : ([0, 0, 0] as LatticeCoord);

  const points = profile.map((point) => coordFromMm(point, lattice.unit));
  const closed = options.closed === true;
  const run = closed ? [...points, points[0]] : points;
  const chain = run.map(([i, j, k]) => vertexAt(lattice, i, j, k));

  const result = revolveChain(lattice, chain, axis, through, options.segments ?? 0, spin);
  if (!result) {
    throw new Error('That profile could not be swept — it needs at least two distinct points, and at least one of them off the axis');
  }
  return {
    // `facesAdded`, not `faces`: the bridge spreads a whole-cage summary over
    // this reply and that summary already has a `faces` in it. The one that
    // survived was the total, silently, which is a different number.
    facesAdded: result.faces.length,
    segments: result.rings.length,
    degrees: spin,
    closed,
  };
}

/** Joins two faces with a band of quads, opening both. */
export function bridgeFacesMm(lattice: Lattice, faceA: unknown, faceB: unknown) {
  const a = findFaceMm(lattice, faceA);
  const b = findFaceMm(lattice, faceB);
  if (a === -1 || b === -1) {
    throw new Error('One of those faces is not there — read the shape back with physics_get_lattice and use the corners it reports');
  }
  const result = bridgeFaces(lattice, a, b);
  if (!result) {
    throw new Error('Those two cannot be joined: a face cannot be joined to itself, they must have the same number of corners, and they must share none. Two whole walls of one solid share the edges of everything between them — inset each of them first, then join the smaller faces.');
  }
  return { walls: result.walls.length };
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------
//
// Everything above sizes a shape by saying how far to push it. This says how
// big it should END UP, which is the number a part is actually specified by: a
// bracket is 40 mm across because the thing it bolts to is, and arriving at
// that by pushing a face 7 mm and then 3 mm more is arithmetic nobody should be
// doing in their head.
//
// The corners stay integers throughout. A typed millimetre is rounded onto the
// grid like any other placement, so a dimension can never introduce a corner
// the rest of the mode could not have made.

/** The corners of a selection, bounded, in millimetres on the cage's grid. */
export function selectionBoundsMm(
  lattice: Lattice,
  vertices: number[],
): { minMm: number[]; maxMm: number[] } | null {
  const corners = [...new Set(vertices)].filter((v) => v >= 0 && v < vertexCount(lattice));
  if (corners.length === 0) return null;
  const min: LatticeCoord = [Infinity, Infinity, Infinity];
  const max: LatticeCoord = [-Infinity, -Infinity, -Infinity];
  for (const v of corners) {
    const at = coordOf(lattice, v);
    for (let k = 0; k < 3; k++) {
      if (at[k] < min[k]) min[k] = at[k];
      if (at[k] > max[k]) max[k] = at[k];
    }
  }
  const step = mmPerStep(lattice.unit);
  return { minMm: min.map((v) => v * step), maxMm: max.map((v) => v * step) };
}

/**
 * Sets one dimension of a set of corners: either how far they reach along an
 * axis, or where their middle sits on it.
 *
 * A size scales them about their own middle, so both ends move and the shape
 * stays where it is; a position translates the lot. Returns false when the
 * request cannot mean anything — a size for a selection that is flat on that
 * axis (scaling zero by any factor is still zero), or a number that rounds to
 * the grid position the corners are already on.
 */
export function dimensionMm(
  lattice: Lattice,
  vertices: number[],
  axis: Axis,
  mode: 'size' | 'position',
  valueMm: number,
): boolean {
  const corners = [...new Set(vertices)].filter((v) => v >= 0 && v < vertexCount(lattice));
  const bounds = selectionBoundsMm(lattice, corners);
  if (!bounds) return false;

  const k = AXIS_INDEX[axis];
  const step = mmPerStep(lattice.unit);
  const wanted = stepsOf(valueMm, step);
  const min = stepsOf(bounds.minMm[k], step);
  const max = stepsOf(bounds.maxMm[k], step);

  if (mode === 'position') {
    // The middle of the selection, which for a face is the plane it lies in —
    // the number somebody means by "put this face at 20".
    const move: LatticeCoord = [0, 0, 0];
    move[k] = Math.round(wanted - (min + max) / 2);
    return moveVertices(lattice, corners, move[0], move[1], move[2]);
  }

  const extent = max - min;
  if (extent <= 0 || wanted <= 0) return false;
  const about: LatticeCoord = [
    (stepsOf(bounds.minMm[0], step) + stepsOf(bounds.maxMm[0], step)) / 2,
    (stepsOf(bounds.minMm[1], step) + stepsOf(bounds.maxMm[1], step)) / 2,
    (stepsOf(bounds.minMm[2], step) + stepsOf(bounds.maxMm[2], step)) / 2,
  ];
  // Whole steps of the FINEST grid, not of the snap the viewport happens to be
  // set to: a dimension is a statement about the part, and rounding it to a
  // 10 mm grid because that is what clicks are landing on would answer a
  // different question than the one that was asked.
  return scaleVertices(lattice, corners, about, wanted / extent, 1, axis);
}

/**
 * The same dimension edit, addressed the way a caller without a pointer has to
 * address things: by naming the corners in millimetres.
 *
 * Points that are not on the grid are snapped, and points that are not corners
 * of this shape are reported rather than silently ignored — a dimension applied
 * to three of the four corners you meant is a shape quietly pulled out of
 * square, which is much worse than an error.
 */
export function dimensionSelectionMm(
  lattice: Lattice,
  selection: unknown,
  axis: Axis,
  mode: 'size' | 'position',
  valueMm: number,
): { changed: boolean; corners: number[][]; missing: number[][] } {
  if (!Array.isArray(selection) || selection.length === 0) {
    throw new Error('Give the corners to measure, as [x, y, z] points in millimetres — read them back with physics_get_lattice');
  }
  const vertices: number[] = [];
  const missing: number[][] = [];
  for (const point of selection) {
    if (!Array.isArray(point) || point.length < 3) {
      throw new Error('Every corner must be an [x, y, z] point in millimetres');
    }
    const coord = coordFromMm(point as number[], lattice.unit);
    const found = findVertex(lattice, coord[0], coord[1], coord[2]);
    if (found === -1) missing.push(mmFromCoord(coord, lattice.unit));
    else vertices.push(found);
  }
  if (missing.length > 0) {
    throw new Error(
      `No corner of this shape is at ${missing.map(p => `[${p.join(', ')}]`).join(' or ')} — `
      + 'read the shape back with physics_get_lattice and use the corners it reports',
    );
  }
  return {
    changed: dimensionMm(lattice, vertices, axis, mode, valueMm),
    corners: vertices.map(v => mmFromCoord(coordOf(lattice, v), lattice.unit)),
    missing,
  };
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
