/**
 * The dimensions a drawing view puts on a part.
 *
 * A Top, Front or Side view is orthographic, so a dimension is a plain 2D
 * measurement on the sheet: (u, v) are screen right and screen up, in metres,
 * from VIEW_AXES. What gets dimensioned is what a person dimensions by hand:
 *
 *   - The overall size: width below the part, height on its left, in the outer
 *     row. A cylinder lying in the view has a width that IS its diameter, and
 *     says so (⌀).
 *   - A chain of the face edges in the inner row: every straight edge that runs
 *     up the sheet is a stop across it, and every edge that runs along the
 *     sheet a stop up it — the steps of a stepped block, the slot in a bracket.
 *     The centres of holes seen end-on are stops too, which is how a drawing
 *     locates a hole.
 *   - The diameter of every circle seen end-on, on a leader, and of every
 *     sphere. Both rims of a through hole are one hole; a row of equal holes
 *     is labelled once, "6× ⌀4".
 *
 * The edges come from findFeatureEdges, run on the part as drawn (world space,
 * document frame) — the same edge finder the rounding tool uses, which already
 * fits circles exactly. Pure: no three.js, no store.
 */
import { findFeatureEdges } from './featureEdges';
import { VIEW_AXES, type DrawingView } from './cameraViews';

type Vec3 = [number, number, number];

export interface BodyMesh {
  id: string;
  /** World-space document-frame (Z-up) xyz, metres. */
  positions: ArrayLike<number>;
  faces: ArrayLike<number>;
  /**
   * Whole spheres in the body, known exactly by whoever drew them. A sphere
   * has no edge for the edge finder to find, yet it is a circle in every view
   * — a pendulum's bob is dimensioned by its diameter like a hole is.
   */
  spheres?: { centre: Vec3; radius: number }[];
}

/** Positions along the sheet: u is screen right, v screen up, metres. */
export interface LinearDim {
  kind: 'linear';
  /** Which way it measures: along u (a width) or along v (a height). */
  axis: 'u' | 'v';
  /** The two ends, along `axis`. a < b. */
  a: number;
  b: number;
  /**
   * Where the extension lines start on the other axis — the part's edge or
   * feature each end belongs to. The dimension line itself is drawn outside
   * the part, `row` rows past `edge`.
   */
  anchorA: number;
  anchorB: number;
  /** The part's outline on the other axis that the rows hang off (its min). */
  edge: number;
  /** 1 = the chain, nearest the part; 2 = the overall size. */
  row: 1 | 2;
  valueMm: number;
  label: string;
}

export interface DiameterDim {
  kind: 'diameter';
  centre: [number, number];
  radius: number;
  /** How many equal holes this label stands for. */
  count: number;
  valueMm: number;
  label: string;
}

export type ViewDim = LinearDim | DiameterDim;

export interface BodyDimensions {
  id: string;
  /** The part's projected outline, metres. */
  bounds: { u: [number, number]; v: [number, number] };
  /** The depth of the part's face nearest the camera, along the view's forward axis. */
  near: number;
  dims: ViewDim[];
}

/** Bigger than this and only the overall size is given: the edge finder is not free. */
export const MAX_DIM_TRIANGLES = 60000;
/** Stops closer than this are one stop. */
const MERGE_M = 0.0005;
/** At most this many stops in a chain, the ends included. */
const MAX_STOPS = 8;
/** An edge shorter than this share of the part along its own direction is detail, not a face. */
const MIN_EDGE_SHARE = 0.1;
/** Within this, a straight edge lies in the sheet (|dir·forward|). */
const IN_PLANE = 0.03;
/** Within about 2°, a straight edge runs straight up or straight along the sheet. */
const SQUARE = Math.sin((2 * Math.PI) / 180);
/** Within this, a circle faces the camera. */
const END_ON = 0.98;
/** Sizes within this are the same size: 0.1 mm. */
const SAME_M = 0.0001;

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A length on the sheet, in mm, as a drawing writes it: one decimal, none when whole. */
export function formatDim(metres: number): string {
  const mm = Math.round(metres * 10000) / 10;
  return Number.isInteger(mm) ? mm.toFixed(0) : mm.toFixed(1);
}

interface Stop { at: number; anchor: number; weight: number }

/**
 * Sorted stops with the near-duplicates merged and the ends always in — or just
 * the two ends, when there are more than a chain can hold. A part with that many
 * edges square to the sheet (a gear's teeth, a grille) is not one a chain of
 * figures explains, and picking some of them would be arbitrary.
 */
function chainStops(stops: Stop[], lo: number, hi: number, loAnchor: number): Stop[] {
  const all = [...stops, { at: lo, anchor: loAnchor, weight: Infinity }, { at: hi, anchor: loAnchor, weight: Infinity }]
    .sort((x, y) => x.at - y.at);
  const merged: Stop[] = [];
  for (const s of all) {
    const last = merged[merged.length - 1];
    if (last && s.at - last.at < MERGE_M) {
      // The heavier stop's position wins; the extension line reaches the nearer of the two.
      if (s.weight > last.weight) last.at = s.at;
      last.anchor = Math.min(last.anchor, s.anchor);
      last.weight = Math.max(last.weight, s.weight);
      continue;
    }
    merged.push({ ...s });
  }
  if (merged.length <= MAX_STOPS) return merged;
  return [merged[0], merged[merged.length - 1]];
}

/** The dimensions for one part in one view. */
export function bodyViewDimensions(body: BodyMesh, view: DrawingView): BodyDimensions | null {
  const { forward, right, up } = VIEW_AXES[view];
  const p = body.positions;
  if (p.length < 9) return null;

  // --- the outline ---------------------------------------------------------
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, near = Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const q = [p[i], p[i + 1], p[i + 2]];
    const u = dot(q, right), v = dot(q, up), w = dot(q, forward);
    if (u < u0) u0 = u;
    if (u > u1) u1 = u;
    if (v < v0) v0 = v;
    if (v > v1) v1 = v;
    if (w < near) near = w;
  }
  if (!(u1 - u0 > SAME_M || v1 - v0 > SAME_M)) return null;
  const width = u1 - u0;
  const height = v1 - v0;

  // --- the edges -----------------------------------------------------------
  const uStops: Stop[] = [];
  const vStops: Stop[] = [];
  const circles: { centre: [number, number]; radius: number }[] = [];
  // A circle lying in the view (a cylinder seen side on) whose diameter spans
  // the part: that width or height is a diameter.
  let uIsDiameter = false;
  let vIsDiameter = false;

  if (body.faces.length / 3 <= MAX_DIM_TRIANGLES) {
    const found = findFeatureEdges(body.positions, body.faces);
    for (const candidate of found.edges) {
      const e = candidate.edge;
      if (e.kind === 'line') {
        const d: Vec3 = [e.b[0] - e.a[0], e.b[1] - e.a[1], e.b[2] - e.a[2]];
        const length = Math.hypot(d[0], d[1], d[2]);
        if (!(length > 0)) continue;
        if (Math.abs(dot(d, forward)) / length > IN_PLANE) continue;
        const du = dot(d, right) / length;
        const dv = dot(d, up) / length;
        const ua = dot(e.a, right), ub = dot(e.b, right);
        const va = dot(e.a, up), vb = dot(e.b, up);
        // Runs up the sheet: a stop across it, reaching down to the width row.
        if (Math.abs(du) < SQUARE && length >= MIN_EDGE_SHARE * height) {
          uStops.push({ at: (ua + ub) / 2, anchor: Math.min(va, vb), weight: length });
        }
        // Runs along the sheet: a stop up it, reaching left to the height row.
        if (Math.abs(dv) < SQUARE && length >= MIN_EDGE_SHARE * width) {
          vStops.push({ at: (va + vb) / 2, anchor: Math.min(ua, ub), weight: length });
        }
      } else {
        const facing = Math.abs(dot(e.axis, forward));
        const cu = dot(e.centre, right), cv = dot(e.centre, up);
        if (facing > END_ON) {
          circles.push({ centre: [cu, cv], radius: e.radius });
        } else if (facing < 1 - END_ON) {
          // In the sheet. Its diameter runs square to its axis.
          const diameter = 2 * e.radius;
          if (Math.abs(dot(e.axis, up)) > END_ON && Math.abs(diameter - width) < SAME_M) uIsDiameter = true;
          if (Math.abs(dot(e.axis, right)) > END_ON && Math.abs(diameter - height) < SAME_M) vIsDiameter = true;
        }
      }
    }
  }

  // A sphere wholly inside another is out of sight (an eye socket inside a
  // skull) and gets nothing. The rest get their diameter, but no chain stop:
  // a sphere's centre is not an edge anyone measures to on a drawing.
  const spheres = (body.spheres ?? []).filter((a, i, all) => !all.some((b, j) => j !== i &&
    b.radius > a.radius &&
    Math.hypot(a.centre[0] - b.centre[0], a.centre[1] - b.centre[1], a.centre[2] - b.centre[2]) + a.radius <= b.radius + SAME_M));
  const balls: { centre: [number, number]; radius: number }[] = spheres.map((sphere) => ({
    centre: [dot(sphere.centre, right), dot(sphere.centre, up)], radius: sphere.radius,
  }));

  // --- circles: one per hole, one label per size ---------------------------
  const holes: { centre: [number, number]; radius: number }[] = [];
  for (const c of [...circles, ...balls]) {
    const same = holes.find((h) =>
      Math.abs(h.radius - c.radius) < SAME_M &&
      Math.abs(h.centre[0] - c.centre[0]) < SAME_M &&
      Math.abs(h.centre[1] - c.centre[1]) < SAME_M);
    if (!same) holes.push(c);
  }
  // Seen end-on, a plain cylinder is its circle: the width and height are the
  // diameter, and three labels saying so is two too many.
  const wholeDisc = holes.find((h) =>
    Math.abs(2 * h.radius - width) < SAME_M && Math.abs(2 * h.radius - height) < SAME_M &&
    Math.abs(h.centre[0] - (u0 + u1) / 2) < SAME_M && Math.abs(h.centre[1] - (v0 + v1) / 2) < SAME_M);

  const dims: ViewDim[] = [];
  const sizes: { radius: number; members: typeof holes }[] = [];
  for (const h of holes) {
    const size = sizes.find((s) => Math.abs(s.radius - h.radius) < SAME_M);
    if (size) size.members.push(h);
    else sizes.push({ radius: h.radius, members: [h] });
  }
  for (const size of sizes) {
    // Labelled on the hole furthest up and right: the leader runs out that way.
    const at = size.members.reduce((best, h) =>
      h.centre[0] + h.centre[1] > best.centre[0] + best.centre[1] ? h : best);
    const count = size.members.length;
    const valueMm = Math.round(size.radius * 2 * 10000) / 10;
    dims.push({
      kind: 'diameter',
      centre: at.centre,
      radius: size.radius,
      count,
      valueMm,
      label: `${count > 1 ? `${count}× ` : ''}⌀${formatDim(size.radius * 2)}`,
    });
  }
  if (wholeDisc) {
    return { id: body.id, bounds: { u: [u0, u1], v: [v0, v1] }, near, dims };
  }

  // Holes seen end-on are located by their centres. A hole's extension line
  // starts at its centre: a centre line.
  for (const h of holes) {
    if (balls.includes(h)) continue;
    uStops.push({ at: h.centre[0], anchor: h.centre[1], weight: 2 * h.radius });
    vStops.push({ at: h.centre[1], anchor: h.centre[0], weight: 2 * h.radius });
  }

  // --- rows ----------------------------------------------------------------
  const linear = (axis: 'u' | 'v', a: Stop, b: Stop, row: 1 | 2, edge: number, diameter = false): LinearDim => ({
    kind: 'linear',
    axis,
    a: a.at,
    b: b.at,
    anchorA: a.anchor,
    anchorB: b.anchor,
    edge,
    row,
    valueMm: Math.round((b.at - a.at) * 10000) / 10,
    label: `${diameter ? '⌀' : ''}${formatDim(b.at - a.at)}`,
  });

  const rows = (axis: 'u' | 'v', stops: Stop[], lo: number, hi: number, edge: number, diameter: boolean) => {
    if (!(hi - lo > SAME_M)) return;
    const chain = chainStops(stops, lo, hi, edge);
    if (chain.length > 2) {
      for (let i = 0; i + 1 < chain.length; i++) dims.push(linear(axis, chain[i], chain[i + 1], 1, edge));
    }
    dims.push(linear(axis, chain[0], chain[chain.length - 1], 2, edge, diameter));
  };
  rows('u', uStops, u0, u1, v0, uIsDiameter);
  rows('v', vStops, v0, v1, u0, vIsDiameter);

  return { id: body.id, bounds: { u: [u0, u1], v: [v0, v1] }, near, dims };
}

/** Every part's dimensions in one view. */
export function viewDimensions(bodies: BodyMesh[], view: DrawingView): BodyDimensions[] {
  const out: BodyDimensions[] = [];
  for (const body of bodies) {
    const d = bodyViewDimensions(body, view);
    if (d) out.push(d);
  }
  return out;
}
