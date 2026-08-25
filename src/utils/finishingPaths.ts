// ---------------------------------------------------------------------------
// Finishing pass path strategies
// ---------------------------------------------------------------------------
//
// The relief exporter used to have exactly one way of laying its finishing
// passes down: parallel lines, along X or along Y. That is the simplest thing
// that works, and on a surface with any modelling in it, it is also the thing
// you can see from across the room. Parallel passes carry a direction, and the
// eye reads that direction as grain: a face carved with an X raster has a fine
// horizontal corduroy over it that has nothing to do with the face.
//
// Worse than the look is the geometry. A pass crossing a slope at a shallow
// angle takes a wide, thin cut and leaves a scallop far bigger than the
// stepover implies; the same pass running straight up the slope leaves almost
// none. A fixed axis is therefore right for parts of the model and wrong for
// the rest of it, and no stepover setting fixes that, because the error is in
// the direction, not the spacing.
//
// This module produces the plan-view (XY) polylines a finishing pass follows,
// leaving Z entirely to the caller — the exporter still samples its own
// tool-dilated surface at every point, still clamps to the layer limit, still
// splits at the stock's top face and still simplifies. All that changes is
// where in plan the tool is asked to go.
//
// Everything here is millimetres, matching the exporter that calls it.
// ---------------------------------------------------------------------------

import type { Point2D } from './laserCutExporter';
import { isoContours } from './marchingSquares';
import { offsetRings } from './polygonOffset';

/**
 * How the finishing passes are laid out in plan.
 *
 * 'raster' is the classical parallel sweep, now at any angle rather than only
 * along an axis. It is predictable, it is the fastest to compute and to cut,
 * and it is still the right answer for a broadly flat relief.
 *
 * 'crosshatch' runs two rasters ninety degrees apart. It costs twice the cutting
 * time and it removes the directional grain almost entirely, because the second
 * pass cuts the scallops the first one left. This is the cheap fix when the
 * complaint is purely how the surface looks.
 *
 * 'concentric' walks rings inward from the stock boundary. Every pass is a
 * closed loop, so there is no reversal at the end of a line — which matters more
 * than it sounds, since a raster spends much of its time decelerating into and
 * out of turns it only makes because the path told it to.
 *
 * 'spiral' is 'concentric' with the rings joined into one continuous path, so
 * the tool enters once and stays down. Fewest retracts of anything here.
 *
 * 'contour' is a waterline: passes follow the surface's own level lines, so the
 * tool always travels along the form rather than across it. On steep ground this
 * is far and away the best finish available — the stepover is measured down the
 * wall, where it belongs. On flat ground it is useless, because level lines on a
 * plane are infinitely far apart.
 *
 * 'hybrid' is what CAM packages call 3D finishing and what this whole module is
 * really for: waterline where the surface is steep, raster where it is shallow,
 * each doing the job the other is bad at. Slowest to compute, and the one to
 * reach for on a sculpted or organic relief.
 */
export type FinishingStrategy =
  | 'raster'
  | 'crosshatch'
  | 'concentric'
  | 'spiral'
  | 'contour'
  | 'hybrid';

/** A grid of surface heights, as the relief exporter builds one. */
export interface SurfaceGrid {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cols: number;
  rows: number;
  stepX: number;
  stepY: number;
  /** Surface Z per cell, row-major with row 0 at minY. Stock top is 0. */
  z: Float32Array;
}

export interface FinishingPathInput {
  /** The rectangle the tool centre is allowed into — already inset by its radius. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** Distance between neighbouring passes, mm. */
  stepover: number;
  /** Distance between sampled points along a pass, mm. */
  resolution: number;
  /** Raster angle in degrees, measured from +X. Ignored by the loop strategies. */
  angleDeg: number;
  /** The tool-dilated finishing surface. Needed by 'contour' and 'hybrid'. */
  surface: SurfaceGrid;
  /** Deepest the job cuts, mm (negative). Bounds the waterline levels. */
  floorZ: number;
  /**
   * Slope, in degrees from horizontal, at which 'hybrid' switches from raster to
   * waterline. 30-45 is the usual band; lower sends more of the model to the
   * waterline pass.
   */
  steepAngleDeg?: number;
}

const DEFAULT_STEEP_ANGLE_DEG = 35;

/** A closed loop is emitted with its first point repeated, so the tool closes it. */
function closeLoop(loop: Point2D[]): Point2D[] {
  if (loop.length < 2) return loop;
  const first = loop[0];
  const last = loop[loop.length - 1];
  if (Math.hypot(last.x - first.x, last.y - first.y) < 1e-9) return loop;
  return [...loop, { x: first.x, y: first.y }];
}

/**
 * Walks a polyline putting a point down every `step` mm.
 *
 * The exporter samples its surface at every point it is handed, so a pass made
 * of four long rectangle edges would be cut as four straight lines through
 * whatever the relief does in between. Resampling is what turns a geometric
 * path into a path that follows the model.
 */
export function resamplePolyline(points: Point2D[], step: number): Point2D[] {
  if (points.length < 2) return [...points];
  const stepSize = Math.max(1e-6, step);
  const out: Point2D[] = [{ x: points[0].x, y: points[0].y }];

  // Each segment is divided evenly rather than walked in fixed strides. Even
  // division keeps every original vertex — the corners of a ring are where its
  // shape lives — and it never leaves the ragged short step at the end of a
  // segment that a fixed stride does, which on a long pass is a move a
  // thousandth of the length of its neighbours for the controller to plan.
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-12) continue;

    const parts = Math.max(1, Math.ceil(len / stepSize));
    for (let k = 1; k <= parts; k++) {
      const t = k / parts;
      out.push({ x: a.x + dx * t, y: a.y + dy * t });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Raster
// ---------------------------------------------------------------------------

/**
 * Clips a segment to an axis-aligned rectangle (Liang-Barsky).
 *
 * A raster at an angle is generated across the rectangle's *rotated* bounding
 * box, which is bigger than the rectangle, so most lines overhang it at both
 * ends. Clipping analytically is what keeps the tool inside the stock without
 * relying on the caller to notice.
 */
function clipToRect(
  a: Point2D,
  b: Point2D,
  rect: { minX: number; minY: number; maxX: number; maxY: number }
): [Point2D, Point2D] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;

  const edges: [number, number][] = [
    [-dx, a.x - rect.minX],
    [dx, rect.maxX - a.x],
    [-dy, a.y - rect.minY],
    [dy, rect.maxY - a.y],
  ];

  for (const [p, q] of edges) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return null; // parallel to this edge and outside it
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }

  if (t1 - t0 < 1e-9) return null;
  return [
    { x: a.x + dx * t0, y: a.y + dy * t0 },
    { x: a.x + dx * t1, y: a.y + dy * t1 },
  ];
}

/**
 * Parallel passes across `bounds` at `angleDeg`, alternating direction.
 *
 * The lines are laid out in a frame rotated to the pass angle, spanning the
 * rotated bounding box of the rectangle's four corners, then clipped back to the
 * rectangle itself. At 0 and 90 degrees this reduces exactly to the axis sweep
 * the exporter did before.
 */
export function rasterPasses(input: FinishingPathInput, angleDeg: number): Point2D[][] {
  const { bounds, stepover, resolution } = input;
  const theta = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  // Corners into the rotated frame, to find how far the passes have to reach.
  const corners: Point2D[] = [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY },
  ];
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const c of corners) {
    const u = c.x * cos + c.y * sin;
    const v = -c.x * sin + c.y * cos;
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }

  const span = vMax - vMin;
  const step = Math.max(1e-6, stepover);
  // Divided evenly across the span, inclusive of both edges, so the outermost
  // pass sits ON the boundary. Striding by exactly the stepover instead would
  // leave the last pass short of the far edge — an uncut strip up to a stepover
  // wide down one side of the work, which is a defect, not a rounding error.
  const count = Math.max(1, Math.ceil(span / step));

  const passes: Point2D[][] = [];
  let forward = true;

  for (let i = 0; i <= count; i++) {
    const v = vMin + (span * i) / count;
    const a = { x: uMin * cos - v * sin, y: uMin * sin + v * cos };
    const b = { x: uMax * cos - v * sin, y: uMax * sin + v * cos };
    const clipped = clipToRect(a, b, bounds);
    if (!clipped) continue;

    const [start, end] = forward ? clipped : [clipped[1], clipped[0]];
    forward = !forward;
    passes.push(resamplePolyline([start, end], resolution));
  }

  return passes;
}

// ---------------------------------------------------------------------------
// Concentric and spiral
// ---------------------------------------------------------------------------

/** Rings stepping inward from the stock boundary, outermost first. */
export function concentricPasses(input: FinishingPathInput): Point2D[][] {
  const { bounds, stepover, resolution } = input;
  const rect: Point2D[] = [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY },
  ];

  // firstOffset 0 keeps the outermost ring on the boundary itself; `bounds` has
  // already been inset by the tool radius by the time it gets here.
  const rings = offsetRings(rect, 0, Math.max(1e-6, stepover));
  return rings
    .map((r) => resamplePolyline(closeLoop(r), resolution))
    .filter((r) => r.length >= 2);
}

/**
 * The concentric rings joined into one continuous path.
 *
 * A true Archimedean spiral would blend the radius continuously, which needs a
 * parametrisation the offsetter does not give us for an arbitrary outline. What
 * this does instead is walk each ring in full, then step across to the nearest
 * point on the next ring in and start there — one connected path, with the
 * crossings a stepover long rather than a retract to safe Z. Where the region
 * splits into separate lobes each lobe becomes its own path, because there is
 * nothing sensible to connect across the gap between them.
 */
export function spiralPasses(input: FinishingPathInput): Point2D[][] {
  const rings = concentricPasses(input);
  if (rings.length === 0) return [];

  const bridgeLimit = Math.max(input.stepover * 3, input.resolution * 4);
  const paths: Point2D[][] = [];
  let current: Point2D[] = [];

  for (const ring of rings) {
    if (current.length === 0) {
      current = [...ring];
      continue;
    }

    const from = current[current.length - 1];
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const d = Math.hypot(ring[i].x - from.x, ring[i].y - from.y);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }

    // Too far to bridge means these rings are not neighbours — the region split.
    if (bestDist > bridgeLimit) {
      paths.push(current);
      current = [...ring];
      continue;
    }

    // Re-phase the ring so it starts nearest the tool, then close it there.
    const head = ring.slice(best);
    const tail = ring.slice(1, best + 1); // skip the duplicated closing point
    const rephased = closeLoop([...head, ...tail]);
    current.push(...rephased);
  }

  if (current.length >= 2) paths.push(current);
  return paths;
}

// ---------------------------------------------------------------------------
// Waterline
// ---------------------------------------------------------------------------

/** Grid coordinates from marching squares back into millimetres on the stock. */
function gridToMm(p: Point2D, s: SurfaceGrid): Point2D {
  return { x: s.minX + p.x * s.stepX, y: s.minY + p.y * s.stepY };
}

/**
 * Level lines of the surface, from the stock's top face down to the floor.
 *
 * The levels are spaced by the stepover, which is the honest reading of what a
 * stepover means on a wall: the distance between neighbouring passes measured
 * across the surface, and on a vertical wall that distance is purely vertical.
 * On anything shallower the passes spread out — which is the known weakness of
 * a waterline, and the reason 'hybrid' exists.
 */
export function contourPasses(input: FinishingPathInput): Point2D[][] {
  const { surface, stepover, resolution, floorZ, bounds } = input;
  const step = Math.max(1e-6, stepover);
  const passes: Point2D[][] = [];

  // Skip level 0 itself: the top face is not a feature, and a contour exactly on
  // it is the outline of every uncarved patch on the board.
  for (let level = -step; level > floorZ - step; level -= step) {
    const clamped = Math.max(level, floorZ + 1e-6);
    const loops = isoContours(surface.z, surface.cols, surface.rows, clamped);
    for (const loop of loops) {
      const mm = loop.map((p) => gridToMm(p, surface));
      // A contour can run onto ground the tool centre may not enter.
      const inside = mm.filter(
        (p) =>
          p.x >= bounds.minX - 1e-6 &&
          p.x <= bounds.maxX + 1e-6 &&
          p.y >= bounds.minY - 1e-6 &&
          p.y <= bounds.maxY + 1e-6
      );
      if (inside.length < 3) continue;
      const closed = inside.length === mm.length ? closeLoop(inside) : inside;
      const pass = resamplePolyline(closed, resolution);
      if (pass.length >= 2) passes.push(pass);
    }
    if (clamped <= floorZ + 1e-6) break;
  }

  return passes;
}

// ---------------------------------------------------------------------------
// Hybrid
// ---------------------------------------------------------------------------

/**
 * Slope of the surface at a point, in degrees from horizontal.
 *
 * Central differences on the grid. The surface here is already dilated by the
 * tool, so this is the slope the tool actually rides, not the slope of the
 * model — which is the one that decides whether a raster or a waterline leaves
 * the better finish.
 */
export function surfaceSlopeDeg(s: SurfaceGrid, x: number, y: number): number {
  const fx = Math.min(s.cols - 1, Math.max(0, (x - s.minX) / (s.stepX || 1)));
  const fy = Math.min(s.rows - 1, Math.max(0, (y - s.minY) / (s.stepY || 1)));
  const c = Math.min(s.cols - 1, Math.max(0, Math.round(fx)));
  const r = Math.min(s.rows - 1, Math.max(0, Math.round(fy)));

  const at = (cc: number, rr: number) =>
    s.z[Math.min(s.rows - 1, Math.max(0, rr)) * s.cols + Math.min(s.cols - 1, Math.max(0, cc))];

  const spanX = s.stepX > 1e-9 ? 2 * s.stepX : 1;
  const spanY = s.stepY > 1e-9 ? 2 * s.stepY : 1;
  const dzdx = (at(c + 1, r) - at(c - 1, r)) / spanX;
  const dzdy = (at(c, r + 1) - at(c, r - 1)) / spanY;

  return (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
}

/**
 * Cuts a pass into the runs whose points pass a test, dropping the rest.
 *
 * Single points are dropped too: a one-point run is a plunge and a retract for
 * nothing, and there are a great many of them along the boundary between steep
 * and shallow ground.
 */
function splitWhere(pass: Point2D[], keep: (p: Point2D) => boolean): Point2D[][] {
  const runs: Point2D[][] = [];
  let run: Point2D[] = [];
  for (const p of pass) {
    if (keep(p)) {
      run.push(p);
    } else if (run.length > 0) {
      if (run.length >= 2) runs.push(run);
      run = [];
    }
  }
  if (run.length >= 2) runs.push(run);
  return runs;
}

/**
 * Waterline on the steep ground, raster on the shallow, and neither one wasting
 * time where the other is doing the work.
 *
 * The two sets are generated over the whole model and then masked against each
 * other, rather than each being generated over its own region: masking is exact
 * where a region boundary would have to be approximated, and the passes that
 * survive are already in the order the tool wants them.
 */
export function hybridPasses(input: FinishingPathInput): Point2D[][] {
  const threshold = input.steepAngleDeg ?? DEFAULT_STEEP_ANGLE_DEG;
  const isSteep = (p: Point2D) => surfaceSlopeDeg(input.surface, p.x, p.y) >= threshold;

  const steep = contourPasses(input).flatMap((pass) => splitWhere(pass, isSteep));
  const shallow = rasterPasses(input, input.angleDeg).flatMap((pass) =>
    splitWhere(pass, (p) => !isSteep(p))
  );

  // Shallow first: it is the bulk of the surface on most reliefs, and finishing
  // the walls last leaves the crisp edges the least time to be knocked about.
  return [...shallow, ...steep];
}

// ---------------------------------------------------------------------------

/** The plan-view passes for a strategy, in the order they should be cut. */
export function finishingPasses(
  strategy: FinishingStrategy,
  input: FinishingPathInput
): Point2D[][] {
  switch (strategy) {
    case 'crosshatch':
      return [...rasterPasses(input, input.angleDeg), ...rasterPasses(input, input.angleDeg + 90)];
    case 'concentric':
      return concentricPasses(input);
    case 'spiral':
      return spiralPasses(input);
    case 'contour':
      return contourPasses(input);
    case 'hybrid':
      return hybridPasses(input);
    case 'raster':
    default:
      return rasterPasses(input, input.angleDeg);
  }
}

/** One line describing a strategy, for the G-code header and the UI. */
export function describeFinishingStrategy(strategy: FinishingStrategy, angleDeg: number): string {
  switch (strategy) {
    case 'crosshatch':
      return `crosshatch at ${angleDeg}/${angleDeg + 90} degrees`;
    case 'concentric':
      return 'concentric rings inward from the boundary';
    case 'spiral':
      return 'continuous spiral inward from the boundary';
    case 'contour':
      return 'waterline, following the surface level lines';
    case 'hybrid':
      return 'hybrid: waterline on steep ground, raster on shallow';
    case 'raster':
    default:
      return `parallel raster at ${angleDeg} degrees`;
  }
}
