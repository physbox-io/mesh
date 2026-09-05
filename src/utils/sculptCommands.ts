// ---------------------------------------------------------------------------
// Sculpting without a cursor
// ---------------------------------------------------------------------------
//
// The brush in utils/sculptMesh.ts is driven by a pointer: the viewport casts a
// ray under the mouse, and the hit position and surface normal become the stamp.
// That is the whole interface, and it is unavailable to a caller that has no
// screen — which is every caller arriving over MCP.
//
// So an agent says WHERE in the body's own frame, and this file works out the
// rest. A requested point is snapped to the nearest point on the surface and the
// normal there is read off the mesh, which is the same information the raycast
// would have produced, obtained without a camera. Points are in the body's own
// frame in metres — the convention physics_paint already uses, so "the tip of
// the +Z axis" means the same thing to both tools.
//
// Everything here is a pure function of a mesh and a request. The bridge does
// the store work; this does the geometry, and can be tested without a viewport.
// ---------------------------------------------------------------------------

import {
  applyBrush,
  applyUndo,
  beginStroke,
  buildSpatialHash,
  endStroke,
  isWatertight,
  meshBounds,
  queryRadius,
  recomputeNormals,
  DEFAULT_BRUSH,
  type BrushSettings,
  type BrushType,
  type SculptMesh,
  type SculptUndoEntry,
} from './sculptMesh';

export const BRUSH_TYPES: BrushType[] = ['draw', 'inflate', 'smooth', 'flatten', 'pinch', 'grab'];

export interface SculptStrokeRequest {
  /** Brush to use. Defaults to 'draw'. */
  brush?: BrushType;
  /** Points in the body's own frame, metres. Each is one dab. */
  at: number[][];
  /** Brush radius in metres. */
  radius?: number;
  /** 0..1. */
  strength?: number;
  /** Carve in rather than push out. */
  invert?: boolean;
  /** Mirror every dab across a plane through the body's origin. */
  symmetryX?: boolean;
  /**
   * Which plane to mirror in. The figure bases face +X, so their left and right
   * lie along Y: 'y' is what pairs a body's ears, eyes or limbs, and 'x' — the
   * default, for compatibility — reflects front to back.
   */
  symmetry?: 'x' | 'y' | 'z';
  /** Target edge length as a fraction of the radius. */
  detail?: number;
  /** Let the brush add and collapse triangles as it passes. */
  dynamicTopology?: boolean;
  /**
   * For 'grab' only: how far to drag, in metres, in the body's frame. Grab
   * catches the surface under the dab and moves it; with no delta it does
   * nothing at all, which is why this is the one brush that needs it.
   */
  delta?: number[];
}

/**
 * A dab that found nothing, and the way to fix it.
 *
 * A caller sculpting a humanoid or a bird cannot guess where the surface is —
 * the shape is irregular and they have no view of it. Reporting only that the
 * point missed would leave them guessing again, so each miss carries the nearest
 * surface point and how far away it was: the correction is then a copy of
 * `nearest` into the next call rather than another guess.
 */
export interface MissedDab {
  at: number[];
  nearest: number[] | null;
  distance: number | null;
}

export interface SculptStrokeResult {
  vertices: number;
  faces: number;
  watertight: boolean;
  /** Dabs that found no surface within reach, each with the point that would have worked. */
  missed: MissedDab[];
  applied: number;
  /**
   * How many vertices the stroke actually moved, and how far the furthest one
   * went, in metres.
   *
   * Without these there is no way to tell a stroke that worked from one that did
   * nothing. The obvious check — did the bounding box change — only answers for
   * a stroke at the extremity of the model: sculpt the cheek of a head and every
   * number a caller can see stays exactly as it was, because the widest point is
   * still the back of the skull. That reads as a broken tool, and it is what a
   * caller with no view of the surface will conclude.
   */
  moved: number;
  maxDisplacement: number;
}

/** A dab in mesh space, with the surface normal that the raycast would have given. */
interface ResolvedStamp {
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
}

/**
 * Find the surface point nearest a requested one, and the outward normal there.
 *
 * Nearest-vertex rather than a ray: a ray needs a direction, and there is no
 * non-arbitrary one to pick without a camera. Casting outward from the body's
 * centre would work on a ball and fail on anything concave — a request aimed
 * into an armpit would land on a shoulder. The nearest surface point is what the
 * caller meant in every shape.
 *
 * Returns null when nothing is within `reach`, so a point in mid-air is reported
 * back rather than silently dragged onto the far side of the model.
 */
export function resolveStamp(
  mesh: SculptMesh,
  point: number[],
  reach: number,
): ResolvedStamp | null {
  const found = nearestSurfacePoint(mesh, point);
  if (!found || found.distance > reach) return null;
  return found.stamp;
}

/**
 * The closest point on the surface to an arbitrary one, however far away.
 *
 * Separate from resolveStamp's bounded lookup because a miss needs this too:
 * the answer to "that was nowhere near the model" is the point that is.
 */
export function nearestSurfacePoint(
  mesh: SculptMesh,
  point: number[],
): { stamp: ResolvedStamp; distance: number } | null {
  const [px, py, pz] = point;
  let bestIndex = -1;
  let bestDistanceSq = Infinity;

  // Straight scan. The hash is built for radius queries around a known surface
  // point; here the point may be anywhere, including far outside the mesh, and
  // widening the query until it finds something costs more than one pass.
  for (let i = 0; i < mesh.vertexCount; i++) {
    const dx = mesh.positions[i * 3] - px;
    const dy = mesh.positions[i * 3 + 1] - py;
    const dz = mesh.positions[i * 3 + 2] - pz;
    const distanceSq = dx * dx + dy * dy + dz * dz;
    if (distanceSq < bestDistanceSq) {
      bestDistanceSq = distanceSq;
      bestIndex = i;
    }
  }
  if (bestIndex < 0) return null;

  return {
    stamp: {
      x: mesh.positions[bestIndex * 3],
      y: mesh.positions[bestIndex * 3 + 1],
      z: mesh.positions[bestIndex * 3 + 2],
      nx: mesh.normals[bestIndex * 3],
      ny: mesh.normals[bestIndex * 3 + 1],
      nz: mesh.normals[bestIndex * 3 + 2],
    },
    distance: Math.sqrt(bestDistanceSq),
  };
}

/**
 * Apply a stroke to a mesh, in place.
 *
 * One `beginStroke`/`endStroke` around the whole request, so a list of points is
 * one stroke and one undo step — the same as a single drag with the mouse,
 * rather than a dozen separate ones for the user to unpick.
 */
export function applySculptStroke(
  mesh: SculptMesh,
  request: SculptStrokeRequest,
  /**
   * Receives what it would take to put this stroke back.
   *
   * Handed out rather than returned because it holds typed arrays the size of
   * the region touched — sometimes the whole mesh — and the result of a stroke
   * is serialised and sent to the caller. A caller who wants to undo asks for
   * that separately; nobody wants a megabyte of Float32Array in their reply.
   */
  sink?: { undo?: SculptUndoEntry | null },
): SculptStrokeResult {
  const settings: BrushSettings = {
    ...DEFAULT_BRUSH,
    type: request.brush ?? 'draw',
    radius: request.radius ?? DEFAULT_BRUSH.radius,
    strength: request.strength ?? DEFAULT_BRUSH.strength,
    invert: request.invert ?? false,
    symmetryX: request.symmetryX ?? Boolean(request.symmetry),
    symmetryAxis: request.symmetry ?? 'x',
    detail: request.detail ?? DEFAULT_BRUSH.detail,
    dynamicTopology: request.dynamicTopology ?? DEFAULT_BRUSH.dynamicTopology,
  };

  // The mesh arrives from the scene graph with no normals computed; the brush
  // needs them for direction and resolveStamp reads them for the stamp.
  recomputeNormals(mesh);

  // How far off the surface a request may sit and still be understood as
  // pointing at it. A brush radius is the natural tolerance: closer than the
  // brush is wide is "on" the surface as far as this stroke is concerned.
  const reach = Math.max(settings.radius, 1e-4);

  const session = beginStroke(mesh, settings);
  const missed: MissedDab[] = [];
  let applied = 0;

  for (const point of request.at) {
    const found = nearestSurfacePoint(mesh, point);
    if (!found || found.distance > reach) {
      missed.push({
        at: point,
        nearest: found ? [found.stamp.x, found.stamp.y, found.stamp.z] : null,
        distance: found ? found.distance : null,
      });
      continue;
    }
    const stamp = found.stamp;
    applyBrush(session, settings, {
      ...stamp,
      ...(request.delta
        ? { dx: request.delta[0] ?? 0, dy: request.delta[1] ?? 0, dz: request.delta[2] ?? 0 }
        : {}),
    });
    applied++;
  }

  // Measured from the stroke's own undo record — the vertices it touched, with
  // the positions they held before it — so nothing extra is copied to find out.
  const undo = endStroke(session);
  if (sink) sink.undo = undo;
  let moved = 0;
  let maxDisplacement = 0;
  if (undo?.indices && undo.positions) {
    for (let i = 0; i < undo.indices.length; i++) {
      const v = undo.indices[i];
      const distance = Math.hypot(
        mesh.positions[v * 3] - undo.positions[i * 3],
        mesh.positions[v * 3 + 1] - undo.positions[i * 3 + 1],
        mesh.positions[v * 3 + 2] - undo.positions[i * 3 + 2],
      );
      if (distance > 1e-9) moved++;
      if (distance > maxDisplacement) maxDisplacement = distance;
    }
  } else if (undo?.mesh) {
    // The brush changed the topology, so there is no index-to-index mapping to
    // measure against. Vertex count is the honest answer available.
    moved = Math.abs(mesh.vertexCount - undo.mesh.vertexCount);
  }

  recomputeNormals(mesh);

  return {
    vertices: mesh.vertexCount,
    faces: mesh.faceCount,
    watertight: isWatertight(mesh),
    missed,
    applied,
    moved,
    maxDisplacement,
  };
}

/** What a caller can learn about a sculpt without pulling the whole mesh over. */
export function sculptSummary(mesh: SculptMesh) {
  const bounds = meshBounds(mesh);
  const size: [number, number, number] = [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ];
  return {
    vertices: mesh.vertexCount,
    faces: mesh.faceCount,
    watertight: isWatertight(mesh),
    bounds: { min: bounds.min, max: bounds.max },
    size,
  };
}

/**
 * Vertices within `radius` of a point — how a caller checks a stroke landed
 * without downloading a quarter of a million positions.
 */
export function verticesNear(mesh: SculptMesh, point: number[], radius: number): number {
  const hash = buildSpatialHash(mesh, Math.max(radius, 1e-3));
  return queryRadius(mesh, hash, point[0], point[1], point[2], radius).length;
}

/**
 * Put a mesh back to before a stroke.
 *
 * Sculpting through an API is sculpting blind: a stroke can only be judged after
 * the fact, by the numbers it reports and by looking at a render. A caller that
 * has just pulled a limb out of the wrong place has no cursor to sweep it back
 * with, and "fix it with more strokes" is how a mistake becomes a lump. So the
 * stroke that went wrong is simply taken off again.
 */
export function undoSculptStroke(mesh: SculptMesh, entry: SculptUndoEntry): SculptUndoEntry {
  const redo = applyUndo(mesh, entry);
  recomputeNormals(mesh);
  return redo;
}

/**
 * Where the surface actually is, near a set of guesses.
 *
 * A caller with no view of the model has to get its coordinates from somewhere,
 * and the bounding box only locates the extremities: the belly of a bird, the
 * side of a head, the inside of a hand are all points you cannot name without
 * asking. Every one of those was found during development by firing a
 * deliberately useless stroke and reading the misses, which works but is a poor
 * thing to have to teach people.
 */
export function probeSurface(mesh: SculptMesh, points: number[][]) {
  recomputeNormals(mesh);
  return points.map((point) => {
    const found = nearestSurfacePoint(mesh, point);
    if (!found) return { at: point, nearest: null, normal: null, distance: null };
    return {
      at: point,
      nearest: [found.stamp.x, found.stamp.y, found.stamp.z],
      normal: [found.stamp.nx, found.stamp.ny, found.stamp.nz],
      distance: found.distance,
    };
  });
}
