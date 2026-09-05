// ---------------------------------------------------------------------------
// Polygon offsetting — the primitive a router needs and a laser does not
// ---------------------------------------------------------------------------
//
// A laser beam is a line. It burns a slot about as wide as a human hair either
// side of the path it is given, and the exporter deals with that by nudging
// joint boundaries half a kerf — a correction small enough that it only ever
// matters where two parts have to fit each other.
//
// An end mill is not a line. It is a 3 or 6 mm circle, and driving its centre
// along a part's outline does not cut that outline: it cuts a path a full
// radius inside it. A 3.175 mm bit run on the line returns every part 1.6 mm
// undersized on each face and every mortise 1.6 mm oversized — which is to say
// the joinery this app computes to a hundredth of a millimetre does not fit at
// all. The fix is as old as CAM: cut the outline offset outward by the cutter's
// radius, and cut holes offset inward by the same, so the *edge* of the tool
// travels the geometry the model asked for.
//
// Offsetting a polygon is easy right up until the offset distance exceeds some
// local feature of the shape, at which point the naive result folds through
// itself and encloses regions that were never in the original. A narrow slot
// offset inward past half its width, a spike offset outward — both produce a
// curve with loops in it that have to be found and thrown away. That pruning is
// most of what this file is, and it is why the offset lives here rather than
// inline in an exporter.
//
// Everything here is plane geometry in whatever unit the caller is using. The
// exporters call it in millimetres.

import type { Point2D } from './laserCutExporter';

export interface OffsetOptions {
  /**
   * How far a discretised arc may deviate from the true one, in the caller's
   * units. Corners are the only curved part of an offset, and this decides how
   * many segments they get: tighter tolerance, more points, larger file.
   *
   * 0.01 mm is well under what any hobby router can hold and well under the
   * 0.001 mm resolution the G-code is written at.
   */
  arcTolerance?: number;
  /**
   * How to turn the outside of a corner.
   *
   * 'round' is what a round cutter physically does — it cannot leave a sharp
   * outside corner, so the arc is not an approximation of the truth, it *is*
   * the truth. 'miter' extends both edges to their intersection instead, which
   * is what a laser wants and what keeps a rectangle a rectangle, but it runs
   * away to infinity as a corner gets sharper, so it falls back to a bevel past
   * `miterLimit`.
   */
  joinStyle?: 'round' | 'miter';
  /**
   * Cap on how far a mitered corner may be pushed out, as a multiple of the
   * offset distance. Past this the corner is bevelled off instead. 2 is the
   * usual default and corresponds to about a 60° corner.
   */
  miterLimit?: number;
}

const DEFAULTS: Required<OffsetOptions> = {
  arcTolerance: 0.01,
  joinStyle: 'round',
  miterLimit: 2,
};

// ---------------------------------------------------------------------------
// Small plane-geometry helpers
// ---------------------------------------------------------------------------

/**
 * Twice the signed area. Positive is counter-clockwise, which is the
 * orientation everything below assumes internally — a loop that arrives the
 * other way round is flipped on the way in and flipped back on the way out, so
 * callers never have to care which way their loops wind.
 */
export function signedArea2(pts: Point2D[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a;
}

/**
 * Which side of a closed loop holds the material the cutter is about to meet.
 *
 * Not the same question as "which side is the part". A ring of a clearing pass
 * that steps inward has stock on its inner side because the ring outside it has
 * already gone, whichever of those the finished piece is made of.
 */
export type MaterialSide = 'inside' | 'outside';

/**
 * A closed loop wound so the cutter climb-mills it.
 *
 * In climb milling the tooth enters the cut at full chip thickness and leaves
 * at nothing, so the heat it makes goes out with the chip. Conventional milling
 * is the other way round — every tooth starts at zero thickness and rubs its
 * way in, and the heat that rubbing makes has nowhere to go but the tool and
 * the work. In aluminium that is the mechanism by which swarf welds itself to
 * the flutes, takes the edge with it, and snaps the cutter.
 *
 * Which winding gives it follows from the rotation. A spindle turns a
 * right-hand cutter clockwise seen from above, and for that rotation the tooth
 * enters thick when the material lies to the **right** of the direction of
 * travel. A loop's interior is on the right when the loop is travelled
 * clockwise, so:
 *
 *   - material inside the loop  → cut it clockwise
 *   - material outside the loop → cut it anti-clockwise
 *
 * which is the pair of rules a machinist states directly: clockwise around the
 * outside of a part, anti-clockwise around a hole.
 *
 * Everything in this app emits work coordinates directly, with Y up, so the
 * winding here is the winding the machine sees. An exporter that mirrored an
 * axis on the way out would be reversing the handedness of every one of these
 * loops and would have to say so.
 *
 * Reversing a closed loop leaves its start point where it was, so anything
 * already positioned to begin there stays correct.
 */
export function orientForClimb(loop: Point2D[], material: MaterialSide): Point2D[] {
  if (loop.length < 3) return loop;
  const closed =
    Math.hypot(loop[0].x - loop[loop.length - 1].x, loop[0].y - loop[loop.length - 1].y) < 1e-9;
  const ring = closed ? loop.slice(0, -1) : loop;
  if (ring.length < 3) return loop;

  const ccw = signedArea2(ring) > 0;
  if (ccw === (material === 'outside')) return loop;

  const flipped = [ring[0], ...ring.slice(1).reverse()];
  if (closed) flipped.push({ ...flipped[0] });
  return flipped;
}

/** Signed area proper. Sign is orientation, magnitude is the enclosed area. */
export function polygonArea(pts: Point2D[]): number {
  return signedArea2(pts) / 2;
}

/** Drops repeated points, which otherwise give an edge no direction to offset along. */
function dedupe(pts: Point2D[], eps: number): Point2D[] {
  const out: Point2D[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) <= eps) continue;
    out.push({ x: p.x, y: p.y });
  }
  // A closed loop repeats its first point at the end often enough to be worth
  // handling here rather than in every caller.
  while (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) <= eps) out.pop();
    else break;
  }
  return out;
}

/**
 * Drops vertices that sit on the straight line between their neighbours.
 *
 * A mitred corner is built as "offset edge end, corner, next offset edge start"
 * and the first of those three is already on the line the corner extends, so
 * every rectangle would otherwise come out with twelve vertices instead of
 * four. The tolerance is deliberately far tighter than the arc tolerance: this
 * is here to remove points that are redundant to within rounding, not to
 * simplify arcs, which have to keep every point they were given.
 */
function dropCollinear(pts: Point2D[]): Point2D[] {
  if (pts.length < 3) return pts;
  const out: Point2D[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[(i - 1 + pts.length) % pts.length];
    const b = pts[i];
    const c = pts[(i + 1) % pts.length];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const spread = Math.hypot(c.x - a.x, c.y - a.y);
    // |cross| / |ac| is b's perpendicular distance from the line ac.
    if (spread > 1e-12 && Math.abs(cross) / spread < 1e-7) continue;
    out.push(b);
  }
  return out.length >= 3 ? out : pts;
}

/** Squared distance from p to the segment ab. Squared to keep the sqrt out of the inner loop. */
function distSqToSegment(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-18) return (p.x - a.x) ** 2 + (p.y - a.y) ** 2;
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = a.x + t * dx;
  const qy = a.y + t * dy;
  return (p.x - qx) ** 2 + (p.y - qy) ** 2;
}

/** Shortest distance from a point to the boundary of any of the given loops. */
function distToLoops(p: Point2D, loops: Point2D[][]): number {
  let best = Infinity;
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const d = distSqToSegment(p, loop[i], loop[(i + 1) % loop.length]);
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

/**
 * Where two segments cross, or null if they do not.
 *
 * Endpoint-touching is deliberately excluded (the parameters must land strictly
 * inside both segments): consecutive edges of the raw offset curve always share
 * an endpoint, and treating that as a crossing would split the curve at every
 * single vertex.
 */
function segmentIntersection(
  a1: Point2D, a2: Point2D, b1: Point2D, b2: Point2D
): { point: Point2D; ta: number; tb: number } | null {
  const rx = a2.x - a1.x;
  const ry = a2.y - a1.y;
  const sx = b2.x - b1.x;
  const sy = b2.y - b1.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null; // parallel, including collinear overlap
  const qpx = b1.x - a1.x;
  const qpy = b1.y - a1.y;
  const ta = (qpx * sy - qpy * sx) / denom;
  const tb = (qpx * ry - qpy * rx) / denom;
  const EPS = 1e-9;
  if (ta <= EPS || ta >= 1 - EPS || tb <= EPS || tb >= 1 - EPS) return null;
  return { point: { x: a1.x + ta * rx, y: a1.y + ta * ry }, ta, tb };
}

// ---------------------------------------------------------------------------
// Stage 1: the raw offset curve
// ---------------------------------------------------------------------------

/**
 * Every edge pushed out along its own normal, with the gaps at convex corners
 * filled in. The result is closed but very often *not* simple — it may cross
 * itself repeatedly — which is stage 2's problem.
 *
 * The loop must arrive counter-clockwise. Its interior is then to the left of
 * every directed edge, so the outward normal is the right-hand one, and a
 * positive delta grows the shape.
 */
function rawOffset(loop: Point2D[], delta: number, opt: Required<OffsetOptions>): Point2D[] {
  const n = loop.length;
  const out: Point2D[] = [];

  for (let i = 0; i < n; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % n];
    const c = loop[(i + 2) % n];

    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const elen = Math.hypot(ex, ey);
    if (elen < 1e-12) continue;
    // Right-hand normal of a->b, which points out of a CCW polygon.
    const nx = ey / elen;
    const ny = -ex / elen;

    out.push({ x: a.x + nx * delta, y: a.y + ny * delta });
    out.push({ x: b.x + nx * delta, y: b.y + ny * delta });

    // Now bridge from this edge's offset end to the next edge's offset start.
    const fx = c.x - b.x;
    const fy = c.y - b.y;
    const flen = Math.hypot(fx, fy);
    if (flen < 1e-12) continue;
    const mx = fy / flen;
    const my = -fx / flen;

    const cross = ex * fy - ey * fx;
    // A corner that turns the same way the offset is going is a corner the
    // offset has to reach *around*: the two offset edges pull apart and leave a
    // wedge with the vertex at its point. The other kind overlaps instead, and
    // the straight line between the two offset endpoints is all that is needed
    // — the overlap it creates is a self-intersection that stage 3 prunes.
    if (cross * delta <= 0) continue;

    // The arc is centred on the vertex and runs between the two offset points,
    // so its endpoints are in the direction the offset actually went — which is
    // the *inward* normal when delta is negative, half a turn from the outward
    // one. Taking the raw normal angle here instead puts the whole arc on the
    // far side of the vertex, which is wrong everywhere and only visible on a
    // reflex corner, since that is the only corner an inward offset arcs around.
    const sgn = delta > 0 ? 1 : -1;
    const startAng = Math.atan2(ny * sgn, nx * sgn);
    const endAng = Math.atan2(my * sgn, mx * sgn);
    // The gap at a corner is its exterior angle, always less than a half turn,
    // so the short way round is the right way round.
    let sweep = endAng - startAng;
    while (sweep <= -Math.PI) sweep += Math.PI * 2;
    while (sweep > Math.PI) sweep -= Math.PI * 2;

    if (opt.joinStyle === 'miter') {
      // Where the two offset edges would meet if extended. The half-angle falls
      // out of the sweep, and 1/cos(half) is how far past the corner that
      // intersection sits — the quantity the miter limit caps.
      const half = Math.abs(sweep) / 2;
      const cosHalf = Math.cos(half);
      if (cosHalf > 1e-6 && 1 / cosHalf <= opt.miterLimit) {
        const bisAng = startAng + sweep / 2;
        const reach = Math.abs(delta) / cosHalf;
        out.push({
          x: b.x + Math.cos(bisAng) * reach,
          y: b.y + Math.sin(bisAng) * reach,
        });
        continue;
      }
      // Past the limit the corner is bevelled, which is the straight line the
      // two already-emitted offset endpoints make on their own.
      continue;
    }

    // Round join. The step comes from the sagitta of a chord on a circle of
    // radius |delta|: a chord subtending angle t deviates from the arc by
    // r(1 - cos(t/2)), so solving for the tolerance gives the largest step that
    // still holds it.
    const r = Math.abs(delta);
    const ratio = Math.max(-1, Math.min(1, 1 - opt.arcTolerance / r));
    const step = 2 * Math.acos(ratio);
    const segments = Math.max(1, Math.ceil(Math.abs(sweep) / Math.max(step, 1e-3)));
    for (let k = 1; k < segments; k++) {
      const ang = startAng + (sweep * k) / segments;
      out.push({ x: b.x + Math.cos(ang) * r, y: b.y + Math.sin(ang) * r });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Stage 2: split the raw curve into simple loops
// ---------------------------------------------------------------------------

interface TaggedPoint {
  x: number;
  y: number;
  /** Non-null when this vertex is one of the two copies of a crossing point. */
  crossId: number | null;
}

/**
 * The raw curve with every self-crossing inserted as a vertex, so that each
 * crossing appears exactly twice in the sequence carrying the same id.
 */
function insertCrossings(curve: Point2D[]): TaggedPoint[] {
  const n = curve.length;
  // Per original segment, the crossings that land on it, with the parameter
  // along the segment so they can be threaded back in the right order.
  const hits: { t: number; point: Point2D; id: number }[][] = Array.from({ length: n }, () => []);
  let nextId = 0;

  for (let i = 0; i < n; i++) {
    const a1 = curve[i];
    const a2 = curve[(i + 1) % n];
    // j starts at i+2 because neighbouring segments share an endpoint by
    // construction; the last segment's neighbour is the first, hence the guard.
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const b1 = curve[j];
      const b2 = curve[(j + 1) % n];
      const hit = segmentIntersection(a1, a2, b1, b2);
      if (!hit) continue;
      const id = nextId++;
      hits[i].push({ t: hit.ta, point: hit.point, id });
      hits[j].push({ t: hit.tb, point: hit.point, id });
    }
  }

  const out: TaggedPoint[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ x: curve[i].x, y: curve[i].y, crossId: null });
    hits[i].sort((p, q) => p.t - q.t);
    for (const h of hits[i]) out.push({ x: h.point.x, y: h.point.y, crossId: h.id });
  }
  return out;
}

/**
 * Decomposes the crossing-annotated curve into simple closed loops.
 *
 * Walking the curve and pushing onto a stack, a crossing id met for the second
 * time means everything pushed since the first time forms a closed loop: pop it
 * off and keep walking. What remains on the stack at the end is the last loop.
 * This is the standard decomposition of a closed curve at its own crossings,
 * and it is what turns one folded-over offset into the handful of candidate
 * regions stage 3 then judges.
 */
function splitLoops(tagged: TaggedPoint[]): Point2D[][] {
  const loops: Point2D[][] = [];
  const stack: TaggedPoint[] = [];
  const seenAt = new Map<number, number>();

  for (const v of tagged) {
    if (v.crossId !== null && seenAt.has(v.crossId)) {
      const start = seenAt.get(v.crossId)!;
      const loop = stack.slice(start);
      for (const popped of loop) {
        if (popped.crossId !== null) seenAt.delete(popped.crossId);
      }
      stack.length = start;
      if (loop.length >= 3) loops.push(loop.map((p) => ({ x: p.x, y: p.y })));
      // The crossing itself stays on the stack: the curve continues through it
      // into whatever region comes next.
      seenAt.set(v.crossId, stack.length);
      stack.push(v);
      continue;
    }
    if (v.crossId !== null) seenAt.set(v.crossId, stack.length);
    stack.push(v);
  }

  if (stack.length >= 3) loops.push(stack.map((p) => ({ x: p.x, y: p.y })));
  return loops;
}

// ---------------------------------------------------------------------------
// The offset itself
// ---------------------------------------------------------------------------

/**
 * Offsets one closed loop by `delta`, positive outward.
 *
 * "Outward" is relative to the loop's own interior, not to any winding
 * convention the caller happens to use: a clockwise loop and its
 * counter-clockwise twin both grow under a positive delta, and both come back
 * wound the way they arrived. Callers that want to shrink a shape pass a
 * negative delta.
 *
 * Returns zero or more loops. Zero means the shape did not survive — an inward
 * offset larger than the part's own half-width consumes it entirely, which is
 * exactly what happens when someone tries to cut a 2 mm slot with a 3 mm bit,
 * and the empty result is the honest answer rather than an error.
 */
export function offsetLoop(
  loop: Point2D[],
  delta: number,
  options?: OffsetOptions
): Point2D[][] {
  const opt = { ...DEFAULTS, ...options };
  const eps = Math.max(1e-9, opt.arcTolerance * 0.01);

  const clean = dedupe(loop, eps);
  if (clean.length < 3) return [];
  if (Math.abs(delta) < eps) return [clean];

  // Work counter-clockwise throughout, and undo the flip at the end.
  const wasClockwise = signedArea2(clean) < 0;
  const ccw = wasClockwise ? [...clean].reverse() : clean;

  const raw = rawOffset(ccw, delta, opt);
  if (raw.length < 3) return [];

  const candidates = splitLoops(insertCrossings(dedupe(raw, eps)));

  // Stage 3: judge each candidate.
  //
  // Two tests, and both are needed. A folded-over offset throws off loops that
  // wind the wrong way — those are always spurious. But it can also throw off
  // correctly-wound loops that simply sit in the wrong place: the give-away is
  // that they run closer to the original outline than the offset distance,
  // which no point of a true offset ever does.
  const keepDist = Math.abs(delta) - opt.arcTolerance - eps;
  const result: Point2D[][] = [];

  for (const cand of candidates) {
    const c = dedupe(cand, eps);
    if (c.length < 3) continue;
    if (signedArea2(c) <= 0) continue; // wrong orientation: an inversion, not a region

    let valid = true;
    for (let i = 0; i < c.length; i++) {
      // Midpoints as well as vertices: a spurious loop can be pinched such that
      // its vertices clear the test while the edge between them does not.
      const a = c[i];
      const b = c[(i + 1) % c.length];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (distToLoops(a, [ccw]) < keepDist || distToLoops(mid, [ccw]) < keepDist) {
        valid = false;
        break;
      }
    }
    if (!valid) continue;

    const tidy = dropCollinear(c);
    result.push(wasClockwise ? tidy.reverse() : tidy);
  }

  return result;
}

export interface RegionOffsetResult {
  /** The outline's toolpath. Empty when the part is thinner than the cutter. */
  outer: Point2D[][];
  /** The toolpaths for the holes that survived. */
  holes: Point2D[][];
  /**
   * Which holes vanished, by their index in the input.
   *
   * This is the failure worth shouting about. Everything else about cutter
   * compensation is a correction; this is a feature that will not be on the
   * finished part at all. A 3 mm bolt hole asked of a 6 mm bit cannot be
   * plunged, so its offset closes to nothing and the hole simply does not get
   * cut — and unless someone says so, the first anyone knows of it is a panel
   * with no holes in it.
   */
  droppedHoles: number[];
}

/**
 * Offsets a whole region — one outer boundary and any number of holes — by the
 * same distance, growing the *material* by `delta`.
 *
 * Holes are offset the opposite way to the outer boundary, because growing the
 * material means shrinking the voids in it. Callers pass loops in whatever
 * orientation they have; what marks a loop as a hole is being passed in
 * `holes`, not its winding.
 *
 * Each loop is offset on its own, which is right for cutter compensation: the
 * tool stays on its own side of every boundary, so a wall between two features
 * comes out at exactly its modelled thickness no matter how thin that is. Thin
 * walls are a question of whether the material survives being cut, not of
 * whether the toolpath is correct, and this file does not have an opinion on
 * the strength of anyone's plywood.
 */
export function offsetRegion(
  outer: Point2D[],
  holes: Point2D[][],
  delta: number,
  options?: OffsetOptions
): RegionOffsetResult {
  const offsetHoles: Point2D[][] = [];
  const droppedHoles: number[] = [];

  holes.forEach((h, i) => {
    const res = offsetLoop(h, -delta, options);
    if (res.length === 0) droppedHoles.push(i);
    else offsetHoles.push(...res);
  });

  /*
   * The tool goes round the outside of the part and round the inside of every
   * hole, so the material — the side that becomes a finished wall — is inside
   * the outer boundary and outside each hole. That is the whole of the climb
   * decision; see `orientForClimb`.
   */
  return {
    outer: offsetLoop(outer, delta, options).map((l) => orientForClimb(l, 'inside')),
    holes: offsetHoles.map((h) => orientForClimb(h, 'outside')),
    droppedHoles,
  };
}

/** Whether a point lies inside a closed loop, by the usual ray cast. */
export function pointInPolygon(p: Point2D, loop: Point2D[]): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i];
    const b = loop[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * How deeply each loop is nested inside the others.
 *
 * Depth 0 is an outermost boundary, 1 is a hole in it, 2 an island standing in
 * that hole, and so on. Since the loops of a well-formed region never cross,
 * any vertex of one loop is unambiguously inside or outside every other, so a
 * single vertex is enough to place it.
 */
export function nestingDepths(loops: Point2D[][]): number[] {
  return loops.map((loop, i) => {
    if (loop.length === 0) return 0;
    let depth = 0;
    for (let j = 0; j < loops.length; j++) {
      if (i === j || loops[j].length < 3) continue;
      if (pointInPolygon(loop[0], loops[j])) depth++;
    }
    return depth;
  });
}

/**
 * Offsets a flat list of loops that together bound one region, growing the
 * material by `delta`.
 *
 * Which loops are material boundaries and which are voids is worked out from
 * how they nest rather than from how they wind — a contour sliced out of a mesh
 * comes back with its own winding conventions, and a convention is a worse
 * thing to depend on than the geometry itself. Even depths are material and
 * grow; odd depths are voids and shrink.
 */
export function offsetNestedLoops(
  loops: Point2D[][],
  delta: number,
  options?: OffsetOptions
): { paths: Point2D[][]; dropped: number[] } {
  const depths = nestingDepths(loops);
  const paths: Point2D[][] = [];
  const dropped: number[] = [];

  loops.forEach((loop, i) => {
    if (loop.length < 3) return;
    const isHole = depths[i] % 2 === 1;
    const dir = isHole ? -delta : delta;
    const res = offsetLoop(loop, dir, options);
    if (res.length === 0) dropped.push(i);
    // The nesting that decided which side to stand off on also decides which
    // side the material is on, and therefore which way round to cut: a hole
    // keeps its material outside it, everything else inside.
    else paths.push(...res.map((l) => orientForClimb(l, isHole ? 'outside' : 'inside')));
  });

  return { paths, dropped };
}

/**
 * Repeated inward offsets of a region, each one `step` further in than the last,
 * until nothing is left.
 *
 * This is what clears a pocket, and it is also the skeleton of the adaptive
 * roughing pass: concentric rings of material, outside in. The rings come back
 * outermost first, which is the order they have to be cut in — an inner ring
 * cut first leaves the tool fully buried when it comes back out to the wall.
 *
 * `maxRings` is a backstop, not a feature: a step small enough relative to the
 * region can otherwise generate thousands of rings and take the tab with it.
 */
export function offsetRings(
  loop: Point2D[],
  firstOffset: number,
  step: number,
  maxRings = 2000,
  options?: OffsetOptions
): Point2D[][] {
  const rings: Point2D[][] = [];
  const stepSize = Math.max(1e-6, Math.abs(step));

  let frontier: Point2D[][] = offsetLoop(loop, -Math.abs(firstOffset), options);
  let guard = 0;

  while (frontier.length > 0 && guard < maxRings) {
    /*
     * These rings are cut outermost first, so every one after the first has
     * open air outside it and stock within — material inside the loop, which
     * climb-mills clockwise. It is the opposite hand from a pocket cleared
     * outward from a slot, and the reason `orientForClimb` is told the side
     * rather than asked to work it out.
     */
    rings.push(...frontier.map((r) => orientForClimb(r, 'inside')));
    guard += frontier.length;
    // Each surviving ring is offset again on its own: once the region has split
    // into separate lobes they shrink independently, and a lobe that vanishes
    // must not stop its neighbours.
    frontier = frontier.flatMap((r) => offsetLoop(r, -stepSize, options));
  }

  return rings;
}
