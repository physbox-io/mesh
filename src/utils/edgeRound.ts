/**
 * Fillets and chamfers, as OpenSCAD.
 *
 * A rounded edge is a boolean like any other: a convex edge has a sliver of
 * material taken off it, a concave one has a sliver added. Each sliver is the
 * edge's cross-section — the little region between the corner and the arc (or
 * the flat, for a chamfer) — swept along the edge: `linear_extrude` for a
 * straight edge, `rotate_extrude` for a round rim.
 *
 * The cross-section, for faces meeting at angle θ (measured through whatever
 * the sliver sits in: the material for a convex edge, the air for a concave
 * one), with t1 and t2 running along each face away from the corner C:
 *
 *   setback d = r / tan(θ/2)        how far back along each face it starts
 *   T1 = C + d·t1, T2 = C + d·t2    where the arc meets the faces, tangent
 *   O  = C + r / sin(θ/2) · bisector   the arc's centre
 *
 * and the sliver is C → T1 → arc → T2 → C. It is pushed a little past the
 * faces (outward for a cutter, inward for a filler) so no face of it is ever
 * flush with the part — a flush face is how a boolean comes back not solid.
 *
 * Where three rounded edges of one size meet square at a corner (every corner
 * of a box), their three cutters leave a blunt point: each rounds its own edge
 * and none of them rounds the corner. A corner patch — the corner's cube minus
 * a ball — takes that off, leaving the ball's eighth a CAD fillet would.
 */
import type { EdgeRoundFeature, RoundEdge, SceneNode } from '../types/scene';
import { sameEdge, type EdgeCandidate } from './featureEdges';

type Vec3 = [number, number, number];

const sub = (a: number[], b: number[]): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: number[], b: number[]): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: number[], s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: number[]) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: number[]): Vec3 => {
  const l = len(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

const fmt = (n: number) => (Number.isFinite(n) ? +n.toFixed(7) : 0);

/**
 * Repairs circular rims whose flat-face tangent `t1` (and thus `convex`) was
 * flipped by a flat-face triangle wrapping around the rim's curvature.
 *
 * On any 2-manifold solid where a flat face (outward normal `n1`) meets a
 * perpendicular cylindrical wall (direction into wall `t2` along `±n1`), the
 * rim is convex iff `t2 · n1 < 0` (the wall goes into the solid, opposite the
 * flat face's normal) and concave iff `t2 · n1 > 0` (the wall rises out of the
 * flat face). `t1` must agree with `convex` via `sign(t1 · n2) === sign(t2 · n1)`.
 */
export function normalizeRoundEdge(edge: RoundEdge): RoundEdge {
  if (edge.kind !== 'circle') return edge;
  const wallVsPlane = dot(edge.t2, edge.n1);
  if (Math.abs(wallVsPlane) <= 0.1) return edge;
  const trueConvex = wallVsPlane < 0;
  const planeVsWall = dot(edge.t1, edge.n2);
  const t1Flipped = Math.abs(planeVsWall) > 0.1 && (planeVsWall < 0) !== trueConvex;
  if (edge.convex === trueConvex && !t1Flipped) return edge;
  return {
    ...edge,
    convex: trueConvex,
    t1: t1Flipped ? [(-edge.t1[0]) || 0, (-edge.t1[1]) || 0, (-edge.t1[2]) || 0] : edge.t1,
  };
}

/** The angle between the faces, through the side the sliver sits in. */
export function wedgeAngle(edge: RoundEdge): number {
  return Math.acos(Math.max(-1, Math.min(1, dot(edge.t1, edge.t2))));
}

const MIN_WEDGE_ANGLE = 1e-4;
const MAX_WEDGE_ANGLE = Math.PI - 1e-4;

/** How far back along each face a rounding of this size starts. */
export function setbackOf(edge: RoundEdge, mode: 'fillet' | 'chamfer', size: number): number {
  if (mode === 'chamfer') return size;
  const theta = Math.max(MIN_WEDGE_ANGLE, Math.min(MAX_WEDGE_ANGLE, wedgeAngle(edge)));
  return size / Math.tan(theta / 2);
}

/**
 * The sliver's outline, as points relative to the corner, in 3D (they all lie
 * in the plane square to the edge). Wound C-side last, so the list reads
 * pushed-T1, T1, [arc…], T2, pushed-T2, pushed-C.
 */
export function crossSection(edge: RoundEdge, mode: 'fillet' | 'chamfer', size: number, arcSegments: number): Vec3[] {
  const theta = Math.max(MIN_WEDGE_ANGLE, Math.min(MAX_WEDGE_ANGLE, wedgeAngle(edge)));
  const d = setbackOf(edge, mode, size);
  const t1 = norm(edge.t1);
  const t2 = norm(edge.t2);
  // Outward for a cutter (into the air), inward for a filler (into the part).
  const sign = edge.convex ? 1 : -1;
  const o1 = scale(norm(edge.n1), sign);
  const o2 = scale(norm(edge.n2), sign);
  const eps = Math.max(size * 0.05, 1e-6);

  const T1 = scale(t1, d);
  const T2 = scale(t2, d);
  const out: Vec3[] = [add(T1, scale(o1, eps)), T1];
  if (mode === 'fillet') {
    const sumT = add(t1, t2);
    const bis = len(sumT) > 1e-9 ? norm(sumT) : norm(add(o1, o2));
    const O = scale(bis, size / Math.sin(theta / 2));
    const a1 = sub(T1, O);
    const a2 = sub(T2, O);
    const sweep = Math.PI - theta; // the arc's angle, always under 180°
    const sinSweep = Math.sin(sweep);
    const n = Math.max(2, arcSegments);
    for (let k = 1; k < n; k++) {
      const f = k / n;
      // Slerp between the two radii: both have length `size`.
      const w1 = sinSweep > 1e-6 ? Math.sin((1 - f) * sweep) / sinSweep : 1 - f;
      const w2 = sinSweep > 1e-6 ? Math.sin(f * sweep) / sinSweep : f;
      out.push(add(O, add(scale(a1, w1), scale(a2, w2))));
    }
  }
  out.push(T2, add(T2, scale(o2, eps)), scale(add(o1, o2), eps));
  return out;
}

/** Arc facets for a fillet: the body's $fn spread over the arc's share of a turn. */
function arcSegmentsFor(edge: RoundEdge, fn: number): number {
  const sweep = Math.PI - wedgeAngle(edge);
  return Math.max(2, Math.round((fn * sweep) / (2 * Math.PI)));
}

function matrixRows(cols: [number[], number[], number[]], origin: number[]): string {
  const [x, y, z] = cols;
  const rows = [
    [x[0], y[0], z[0], origin[0]],
    [x[1], y[1], z[1], origin[1]],
    [x[2], y[2], z[2], origin[2]],
    [0, 0, 0, 1],
  ];
  return `[${rows.map((r) => `[${r.map(fmt).join(', ')}]`).join(', ')}]`;
}

/** How far a straight cutter runs past each end: enough to clear, too little to see. */
const OVERRUN = 1e-5;

/** One edge's sliver as a positioned OpenSCAD solid. */
export function edgeSolidScad(rawEdge: RoundEdge, mode: 'fillet' | 'chamfer', size: number, fn: number): string {
  const edge = normalizeRoundEdge(rawEdge);
  const section = crossSection(edge, mode, size, arcSegmentsFor(edge, fn));
  if (edge.kind === 'line') {
    const dir = norm(sub(edge.b, edge.a));
    const length = len(sub(edge.b, edge.a));
    const u = norm(edge.t1);
    const v = cross(dir, u);
    const pts = section.map((p) => `[${fmt(dot(p, u))},${fmt(dot(p, v))}]`).join(',');
    // A cutter runs a hair past each end into air; a filler must not, or the
    // part grows a skin that far past its own faces.
    const overrun = edge.convex ? OVERRUN : 0;
    const origin = sub(edge.a, scale(dir, overrun));
    const swept = `multmatrix(${matrixRows([u, v, dir], origin)}) linear_extrude(height=${fmt(length + 2 * overrun)}) polygon([${pts}]);`;
    if (!edge.stops?.length) return swept;
    // Cut short at each face the edge runs away from: the half-space above
    // that face, as a block big enough to hold the whole sliver.
    const reach = length + 10 * size + 0.001;
    const blocks = edge.stops.map((stop) => {
      const n = norm(stop.normal);
      const x = norm(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]));
      const y = cross(n, x);
      return `multmatrix(${matrixRows([x, y, n], stop.point)}) translate([${fmt(-reach)}, ${fmt(-reach)}, 0]) cube([${fmt(2 * reach)}, ${fmt(2 * reach)}, ${fmt(reach)}]);`;
    });
    return `intersection() { ${swept} ${blocks.join(' ')} }`;
  }
  // A rim. rotate_extrude spins the X-Y plane about Y→Z, X being the radius.
  const ref = norm(edge.ref);
  const axis = norm(edge.axis);
  const side = cross(axis, ref);
  const pts = section.map((p) => `[${fmt(Math.max(0, edge.radius + dot(p, ref)))},${fmt(dot(p, axis))}]`).join(',');
  return `multmatrix(${matrixRows([ref, side, axis], edge.centre)}) rotate_extrude($fn=${Math.max(3, edge.segments)}) polygon([${pts}]);`;
}

/**
 * The corner patches for one feature: every point where three of its straight
 * convex edges meet at right angles. Fillets only — three chamfers already
 * meet in a clean point.
 */
export function cornerPatchesScad(feature: EdgeRoundFeature, fn: number): string[] {
  if (feature.mode !== 'fillet') return [];
  const r = feature.size;
  const tol = 1e-6;
  const lines = feature.edges.filter((e): e is Extract<RoundEdge, { kind: 'line' }> => e.kind === 'line' && e.convex);
  const ends: { p: number[]; edge: (typeof lines)[number] }[] = [];
  for (const e of lines) ends.push({ p: e.a, edge: e }, { p: e.b, edge: e });
  const done: number[][] = [];
  const out: string[] = [];
  for (const { p } of ends) {
    if (done.some((q) => len(sub(p, q)) < tol)) continue;
    const meeting = ends.filter((x) => len(sub(x.p, p)) < tol).map((x) => x.edge);
    if (meeting.length !== 3) continue;
    // The three faces are the distinct normals of the three edges.
    const normals: Vec3[] = [];
    for (const e of meeting) {
      for (const n of [e.n1, e.n2]) {
        if (!normals.some((m) => dot(m, n) > 0.999)) normals.push(norm(n));
      }
    }
    if (normals.length !== 3) continue;
    const square = Math.abs(dot(normals[0], normals[1])) < 1e-3 &&
      Math.abs(dot(normals[0], normals[2])) < 1e-3 && Math.abs(dot(normals[1], normals[2])) < 1e-3;
    if (!square) continue;
    done.push(p);
    // In the corner's own frame the part lies at negative x, y and z: the
    // patch is the cube [-r, eps]³ less the ball at (-r, -r, -r).
    const eps = Math.max(r * 0.05, 1e-6);
    out.push(
      `multmatrix(${matrixRows([normals[0], normals[1], normals[2]], p)}) difference() { ` +
      `translate([${fmt(-r)}, ${fmt(-r)}, ${fmt(-r)}]) cube([${fmt(r + eps)}, ${fmt(r + eps)}, ${fmt(r + eps)}]); ` +
      `translate([${fmt(-r)}, ${fmt(-r)}, ${fmt(-r)}]) sphere(r=${fmt(r)}, $fn=${Math.max(8, fn)}); }`,
    );
  }
  return out;
}

/**
 * An outside edge that ends in an inside corner which is itself being rounded
 * — a gusset's top edge running down into the fillet at its foot — stops at
 * the top of that fillet rather than at the face beneath it.
 *
 * Carried down to the face, the outside edge's cutter bites into the fillet
 * that was just added there, and the two leave notches and slivers where a
 * CAD system would have blended them. Stopping short leaves the last few
 * millimetres of the outside edge sharp, which reads as finished; the notches
 * do not.
 */
type ConcaveFiller = { edge: RoundEdge; mode: 'fillet' | 'chamfer'; size: number };

function stopShortOfFillers(
  edge: RoundEdge,
  concave: ConcaveFiller[],
): RoundEdge {
  if (edge.kind !== 'line' || !edge.stops?.length || concave.length === 0) return edge;
  const stops = edge.stops.map((stop) => {
    let lift = 0;
    const stopN = norm(stop.normal);
    for (const c of concave) {
      if (c.edge.kind === 'line') {
        // The fillet lies along the stop's face, and passes through the stop.
        const onFace = dot(c.edge.n1, stopN) > 0.999 ? c.edge.t2 : dot(c.edge.n2, stopN) > 0.999 ? c.edge.t1 : null;
        if (!onFace) continue;
        const ab = sub(c.edge.b, c.edge.a);
        const t = Math.max(0, Math.min(1, dot(sub(stop.point, c.edge.a), ab) / Math.max(dot(ab, ab), 1e-18)));
        const nearest = add(c.edge.a, scale(ab, t));
        if (len(sub(stop.point, nearest)) > 1e-6) continue;
        // How far the fillet climbs the other face, measured off the stop's face.
        lift = Math.max(lift, setbackOf(c.edge, c.mode, c.size) * Math.abs(dot(onFace, stopN)));
      } else {
        // Circular concave rim (boss foot or counterbore floor) lying on the stop's face.
        const axis = norm(c.edge.axis);
        if (dot(norm(c.edge.n1), stopN) <= 0.999) continue;
        const rel = sub(stop.point, c.edge.centre);
        const axial = dot(rel, axis);
        if (Math.abs(axial) > 1e-4) continue;
        const radial = len(sub(rel, scale(axis, axial)));
        const setback = setbackOf(c.edge, c.mode, c.size);
        const outward = dot(c.edge.t1, norm(c.edge.ref)) >= 0;
        const rMin = outward ? c.edge.radius - 1e-5 : c.edge.radius - setback - 1e-5;
        const rMax = outward ? c.edge.radius + setback + 1e-5 : c.edge.radius + 1e-5;
        if (radial < rMin || radial > rMax) continue;
        lift = Math.max(lift, setback * Math.abs(dot(norm(c.edge.t2), stopN)));
      }
    }
    return lift > 0 ? { ...stop, point: add(stop.point, scale(stopN, lift)) } : stop;
  });
  return { ...edge, stops };
}

/**
 * Every rounding on a body, split into what is taken away and what is added.
 *
 * Corners are found across features, not within each: round the top edges
 * today and the vertical ones tomorrow at the same size, and the corners where
 * they meet still get their ball.
 */
export function edgeRoundSolids(features: EdgeRoundFeature[] | undefined, fn: number): { cutters: string[]; fillers: string[] } {
  const cutters: string[] = [];
  const fillers: string[] = [];
  const filletsBySize = new Map<number, RoundEdge[]>();
  const concave: ConcaveFiller[] = [];
  for (const feature of features || []) {
    if (!Number.isFinite(feature.size) || !(feature.size > 0)) continue;
    for (const rawEdge of feature.edges) {
      const edge = normalizeRoundEdge(rawEdge);
      if (!edge.convex) concave.push({ edge, mode: feature.mode, size: feature.size });
    }
  }
  for (const feature of features || []) {
    if (!Number.isFinite(feature.size) || !(feature.size > 0)) continue;
    for (const rawEdge of feature.edges) {
      const edge = normalizeRoundEdge(rawEdge);
      const solid = edgeSolidScad(edge.convex ? stopShortOfFillers(edge, concave) : edge, feature.mode, feature.size, fn);
      (edge.convex ? cutters : fillers).push(solid);
    }
    if (feature.mode === 'fillet') {
      const key = Math.round(feature.size * 1e7);
      filletsBySize.set(key, [...(filletsBySize.get(key) ?? []), ...feature.edges.map(normalizeRoundEdge)]);
    }
  }
  for (const [key, edges] of filletsBySize) {
    cutters.push(...cornerPatchesScad({ mode: 'fillet', size: key / 1e7, edges }, fn));
  }
  return { cutters, fillers };
}

export function hasEdgeRounds(node: SceneNode): boolean {
  return !!node.edgeRounds?.some((f) => Number.isFinite(f.size) && f.size > 0 && f.edges.length > 0);
}

/**
 * Moves a body's roundings with a resize.
 *
 * The edges are stored as points, and a resized box has its edges somewhere
 * else. Mapping each point through the change in the positive geoms' bounding
 * box — per axis, like the resize itself — puts a box's edges back on the
 * box. Directions are unchanged by an axis-aligned stretch (normals of a box
 * stay axis-aligned), so only points and radii move. Returns true if anything
 * moved.
 */
export function reconcileEdgeRounds(
  node: SceneNode,
  before: { min: number[]; max: number[] } | null,
  after: { min: number[]; max: number[] } | null,
): boolean {
  if (!node.edgeRounds?.length || !before || !after) return false;
  const map = (p: number[]): number[] => p.map((c, k) => {
    const span = before.max[k] - before.min[k];
    if (span <= 1e-12) return c + (after.min[k] - before.min[k]);
    return after.min[k] + ((c - before.min[k]) / span) * (after.max[k] - after.min[k]);
  });
  const same = [0, 1, 2].every((k) => Math.abs(before.min[k] - after.min[k]) < 1e-12 && Math.abs(before.max[k] - after.max[k]) < 1e-12);
  if (same) return false;
  for (const feature of node.edgeRounds) {
    feature.edges = feature.edges.map((e) => {
      if (e.kind === 'line') return { ...e, a: map(e.a), b: map(e.b), ...(e.stops ? { stops: e.stops.map((st) => ({ ...st, point: map(st.point) })) } : {}) };
      const centre = map(e.centre);
      const rimPoint = map(add(e.centre, scale(e.ref, e.radius)));
      const radius = len(sub(rimPoint, centre).map((c, k) => c - dot(sub(rimPoint, centre), e.axis) * e.axis[k]));
      return { ...e, centre, radius };
    });
  }
  return true;
}

/**
 * A body's roundings with `feature` put in: in place of feature `replace` when
 * editing one, otherwise added at the end. An edge belongs to one rounding at
 * a time, so any of its edges another feature already had are taken from it —
 * and a feature left with no edges is dropped. So is `feature` itself when it
 * has no edges or no size, which is how an edit that unpicks everything
 * removes the rounding.
 */
export function withRoundFeature(
  features: EdgeRoundFeature[] | undefined,
  feature: EdgeRoundFeature,
  replace: number | null,
): EdgeRoundFeature[] {
  const keep = feature.edges.length > 0 && Number.isFinite(feature.size) && feature.size > 0;
  const out: EdgeRoundFeature[] = [];
  (features || []).forEach((f, i) => {
    if (i === replace) {
      if (keep) out.push(feature);
      return;
    }
    const edges = keep ? f.edges.filter((e) => !feature.edges.some((p) => sameEdge(p, e))) : f.edges;
    if (edges.length > 0) out.push(edges.length === f.edges.length ? f : { ...f, edges });
  });
  if (keep && (replace === null || replace >= (features || []).length)) out.push(feature);
  return out;
}

/** A body's roundings with these edges taken off whichever features had them. */
export function withoutEdges(features: EdgeRoundFeature[] | undefined, edges: RoundEdge[]): EdgeRoundFeature[] {
  const out: EdgeRoundFeature[] = [];
  for (const f of features || []) {
    const kept = f.edges.filter((e) => !edges.some((x) => sameEdge(x, e)));
    if (kept.length > 0) out.push(kept.length === f.edges.length ? f : { ...f, edges: kept });
  }
  return out;
}

/**
 * A body's roundings with only the edges that are still on it. `lost` counts
 * the edges dropped; a feature left with none is dropped with them.
 */
export function keepFoundEdges(features: EdgeRoundFeature[], found: RoundEdge[]): { features: EdgeRoundFeature[]; lost: number } {
  let lost = 0;
  const kept: EdgeRoundFeature[] = [];
  for (const f of features) {
    const edges = f.edges.filter((e) => found.some((c) => sameEdge(c, e)));
    lost += f.edges.length - edges.length;
    if (edges.length > 0) kept.push(edges.length === f.edges.length ? f : { ...f, edges });
  }
  return { features: lost ? kept : features, lost };
}

export type ClampedRoundingPlan =
  | { ok: true; groups: { size: number; edges: RoundEdge[] }[]; clampedCount: number; skippedCount: number }
  | { ok: false; maxFit: number };

const MIN_CLAMPED_ROUND_SIZE_M = 1e-5; // 0.01 mm

/**
 * Plans rounding sizes for a selection of edges, clamping tight/short facet
 * edges individually when a multi-edge selection has ample room on the main
 * edges. Each resulting group has its own uniform size so OpenSCAD subtracts
 * (or unions) watertight closed solids without one tiny facet rejecting the
 * whole loop.
 *
 * Rejects when a single picked edge cannot fit `requestedSize`, or when no
 * edge in the selection can fit `requestedSize`.
 */
export function planClampedRoundings(
  picked: EdgeCandidate[],
  mode: 'fillet' | 'chamfer',
  requestedSize: number,
): ClampedRoundingPlan {
  if (picked.length === 0) return { ok: false, maxFit: 0 };
  const fits = picked.map((e) => {
    const half = ((e.angleDeg * Math.PI) / 180) / 2;
    return mode === 'chamfer' ? e.maxSetback : e.maxSetback * Math.tan(half);
  });
  let minFit = Infinity;
  let maxFit = -Infinity;
  for (const f of fits) {
    if (f < minFit) minFit = f;
    if (f > maxFit) maxFit = f;
  }
  if (!Number.isFinite(minFit)) return { ok: false, maxFit: 0 };
  if (requestedSize <= minFit + 1e-9) {
    return { ok: true, groups: [{ size: requestedSize, edges: picked.map((e) => e.edge) }], clampedCount: 0, skippedCount: 0 };
  }
  if (picked.length === 1 || requestedSize > maxFit + 1e-9) {
    return { ok: false, maxFit: minFit };
  }

  const buckets = new Map<number, { size: number; edges: RoundEdge[] }>();
  let clampedCount = 0;
  let skippedCount = 0;
  for (let i = 0; i < picked.length; i++) {
    const edgeMax = fits[i];
    let size: number;
    if (edgeMax >= requestedSize - 1e-9) {
      size = requestedSize;
    } else if (edgeMax >= MIN_CLAMPED_ROUND_SIZE_M) {
      size = Math.floor(edgeMax * 1e5) / 1e5;
      clampedCount++;
    } else {
      skippedCount++;
      continue;
    }
    const key = Math.round(size * 1e7);
    const bucket = buckets.get(key);
    if (bucket) bucket.edges.push(picked[i].edge);
    else buckets.set(key, { size, edges: [picked[i].edge] });
  }
  if (buckets.size === 0) return { ok: false, maxFit: minFit };
  return { ok: true, groups: [...buckets.values()], clampedCount, skippedCount };
}
