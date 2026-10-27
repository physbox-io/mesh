/**
 * The dimensions a drawing view puts on a part.
 *
 * A Top, Front or Side view is orthographic. A part is measured along its OWN
 * axes (BodyMesh.frame), not the sheet's: a blade turned 120° and pitched 12°
 * is still 400 long, 60 wide and 10 thick, and those are the figures a person
 * needs to make it. Of the part's three axes, the one nearest the line of
 * sight is depth and the other two are its sheet axes u and v (SheetAxes);
 * every position below is along those, in metres. A part square to the view
 * has the view's own right and up as u and v, and everything reads as it
 * always has. One turned in the view gets aligned dimensions, along its edges
 * at their slant. One tilted in depth is dimensioned the way an isometric
 * drawing is: the line is drawn foreshortened, the figure is the true size.
 *
 * What gets dimensioned is what a person dimensions by hand:
 *
 *   - The overall size: width below the part, height on its left, in the outer
 *     row. A round lying in the view whose width IS its diameter says so (⌀).
 *   - A chain of the face edges in the inner row: every straight edge that runs
 *     up the part is a stop across it, and every edge that runs along it a stop
 *     up it — the steps of a stepped block, the slot in a bracket. A round seen
 *     side on adds its silhouette, and the rim where it steps (a mast standing
 *     on a wider base) — but only a rim that shows: one buried in other
 *     material is a hidden line, which a drawing does not dimension. The
 *     centres of holes seen end-on are stops too, which is how a drawing
 *     locates a hole. Its smallest link is left out, as the overall already
 *     gives it (see omittedLink); a diameter never is.
 *   - The diameter of every circle seen end-on, on a leader, and of every
 *     sphere and rod seen end-on. Both rims of a through hole are one hole; a
 *     row of equal holes is labelled once, "6× ⌀4".
 *   - The part's angle, when it is turned in the view: its long axis against
 *     the sheet's horizontal or vertical, whichever is nearer.
 *
 * Where each part sits is locationDimensions: its origin from its parent's.
 *
 * The edges come from findFeatureEdges, run on the part as drawn (world space,
 * document frame) — the same edge finder the rounding tool uses, which already
 * fits circles exactly. Pure: no three.js, no store.
 */
import { PairMemo } from './arrayMemo';
import { findFeatureEdges, type EdgeCandidate } from './featureEdges';
import { fitCircle } from './measureSnap';
import { VIEW_AXES, type DrawingView } from './cameraViews';
import type { ToothForm } from '../types/scene';

const featureEdgesMemo = new PairMemo<ReturnType<typeof findFeatureEdges>>();

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
  /**
   * Round rods with domed ends (capsules): the ends of the straight part's
   * axis, and the radius. Smooth all over, so as edgeless as a sphere.
   */
  rods?: { a: Vec3; b: Vec3; radius: number }[];
  /**
   * The part's own axes, document frame, orthonormal: the frame it was built
   * in, which its edges run along. Absent: the world's.
   */
  frame?: [Vec3, Vec3, Vec3];
  /**
   * The tooth form a gear, rack or pulley was cut to, and the body frame it is
   * stated in (document frame, metres): its origin and its X, Y and Z axes.
   * Known exactly by the builder, and not to be read off a tessellated flank.
   */
  toothForm?: { form: ToothForm; origin: Vec3; axes: [Vec3, Vec3, Vec3] };
}

/** A part's own axes as a view draws them: u across, v up, w into the sheet. */
export interface SheetAxes {
  u: Vec3;
  v: Vec3;
  w: Vec3;
}

/** Positions along the part's sheet axes, metres. */
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
  /**
   * A run of equal steps stood in for by one figure, "7× 10": how many. Then
   * valueMm is one step (the pitch), and the line spans them all.
   */
  count?: number;
  valueMm: number;
  label: string;
}

export interface DiameterDim {
  kind: 'diameter';
  centre: [number, number];
  /** A polygonal hole's inradius: half its size across the flats. */
  radius: number;
  /**
   * A regular polygonal hole (a hex bore, a square drive) has this many sides,
   * and valueMm is its size across the flats: "hex 5 A/F". Absent: round.
   */
  sides?: number;
  /** How many equal holes this label stands for. */
  count: number;
  valueMm: number;
  label: string;
}

export interface AngleDim {
  kind: 'angle';
  /** Where the arc is centred, on the part's sheet axes. */
  centre: [number, number];
  /**
   * The sheet's horizontal or vertical the angle is measured from, and the
   * part's axis it is measured to: document-frame unit vectors, both lying in
   * the view's plane.
   */
  from: Vec3;
  to: Vec3;
  valueDeg: number;
  /** How many equal slants the label stands for ("2× 45°"); the part's own turn has none. */
  count?: number;
  label: string;
}

/**
 * The radius of a rounded corner or fillet seen square on, on a leader that
 * touches the arc at its middle: "R6", or "2× R6" for equal ones.
 */
export interface RadiusDim {
  kind: 'radius';
  centre: [number, number];
  radius: number;
  /** From the centre to the middle of the arc, on the part's sheet axes: a unit vector. */
  toward: [number, number];
  count: number;
  valueMm: number;
  label: string;
}

/**
 * A toothed part's gear data, as a gear drawing gives it: a block of figures on
 * a leader, and the pitch circle (or a rack's pitch line) chain-dotted when it
 * is seen square on. Positions are on the part's sheet axes.
 */
export interface GearDim {
  kind: 'gear';
  pitchCircle?: { centre: [number, number]; radius: number };
  pitchLine?: { a: [number, number]; b: [number, number] };
  /** Where the leader starts, and the way it runs out: a unit vector. */
  anchor: [number, number];
  toward: [number, number];
  /** The figures, a line each: "16T · m1.5 · PA 20°", the diameters, … */
  lines: string[];
  label: string;
}

export type ViewDim = LinearDim | DiameterDim | RadiusDim | AngleDim | GearDim;

export interface BodyDimensions {
  id: string;
  /** The axes every position here is measured along. */
  axes: SheetAxes;
  /** The part's outline on its own sheet axes, metres. */
  bounds: { u: [number, number]; v: [number, number] };
  /** The middle of the part along w, so a figure drawn at it lands on the part. */
  depth: number;
  dims: ViewDim[];
}

/** Bigger than this and only the overall size is given: the edge finder is not free. */
export const MAX_DIM_TRIANGLES = 60000;
/** Stops closer than this are one stop. */
const MERGE_M = 0.0005;
/** At most this many stops in a chain, the ends included. */
const MAX_STOPS = 8;
/**
 * A chain whose repeats are each one figure ("3× 42") may run this far: it
 * reads as fewer figures than its stops.
 */
const MAX_REPEAT_STOPS = 10;
/** An edge at least this share of the part along its own direction runs its whole span. */
const FULL_SPAN = 0.9;
/** An edge shorter than this share of the part along its own direction is detail, not a face. */
const MIN_EDGE_SHARE = 0.1;
/** Within about 2°, a straight edge runs straight up or straight along the sheet. */
const SQUARE = Math.sin((2 * Math.PI) / 180);
/** Within this, a circle faces the camera. */
const END_ON = 0.98;
/** Sizes within this are the same size: 0.1 mm. */
const SAME_M = 0.0001;
/** Within 1°, an axis lies in the view's plane, so the angle it is drawn at is its true angle. */
const IN_SHEET = Math.sin((1 * Math.PI) / 180);
/** Turned less than this, a part is square and has no angle to give. */
const MIN_ANGLE_DEG = 0.5;
/** How far past a rim or a rod's tip to look for other material, metres. */
const PAST_M = 0.0002;

const WORLD: [Vec3, Vec3, Vec3] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const neg = (a: Vec3): Vec3 => [0 - a[0], 0 - a[1], 0 - a[2]];

/**
 * Which link of a chain to leave out, given the overall size beside it. A
 * chain and the overall together state one figure twice (715 beside 655 + 60),
 * which a drawing never does; the one left out is still there as the overall
 * less the rest. A figure the chain gives twice goes first (a gear's 115.7 |
 * 18.7 | 115.7 keeps the tooth, not both sides); otherwise the smallest. The
 * last of equals, and never one marked `keep`: a diameter says the size is
 * round, which a difference cannot. -1 when every link is kept.
 */
export function omittedLink(lengths: number[], keep: boolean[] = []): number {
  const repeated = (i: number) => lengths.some((x, j) => j !== i && Math.abs(x - lengths[i]) <= SAME_M);
  const pick = (allowed: (i: number) => boolean) => {
    let at = -1;
    for (let i = 0; i < lengths.length; i++) {
      if (keep[i] || !allowed(i)) continue;
      if (at < 0 || lengths[i] <= lengths[at] + SAME_M) at = i;
    }
    return at;
  };
  const twice = pick(repeated);
  return twice >= 0 ? twice : pick(() => true);
}

/** A length on the sheet, in mm, as a drawing writes it: one decimal, none when whole. */
export function formatDim(metres: number): string {
  const mm = Math.round(metres * 10000) / 10;
  return Number.isInteger(mm) ? mm.toFixed(0) : mm.toFixed(1);
}

/** An angle as a drawing writes it: one decimal, none when whole. */
export function formatAngle(degrees: number): string {
  const d = Math.round(degrees * 10) / 10;
  return `${Number.isInteger(d) ? d.toFixed(0) : d.toFixed(1)}°`;
}

/**
 * A part's own axes as a view draws them. The one nearest the line of sight
 * is depth; of the other two, the one nearer screen right is u. Each is turned
 * to point right, up and away, as the view's own do, so a part square to the
 * view gets the view's axes exactly.
 */
export function sheetAxes(frame: [Vec3, Vec3, Vec3] | undefined, view: DrawingView): SheetAxes {
  const { forward, right, up } = VIEW_AXES[view];
  const axes = frame ?? WORLD;
  let wi = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(dot(axes[i], forward)) > Math.abs(dot(axes[wi], forward)) + 1e-9) wi = i;
  let [a, b] = axes.filter((_, i) => i !== wi);
  if (Math.abs(dot(b, right)) > Math.abs(dot(a, right)) + 1e-9) [a, b] = [b, a];
  const toward = (x: Vec3, first: Vec3, second: Vec3) => {
    const d = dot(x, first);
    return d < -1e-9 || (Math.abs(d) <= 1e-9 && dot(x, second) < 0) ? neg(x) : x;
  };
  return { u: toward(a, right, up), v: toward(b, up, right), w: toward(axes[wi], forward, right) };
}

/** `centre`: a hole's or pin's centre line, not an edge of the part. */
/**
 * `centre`: a hole's or pin's centre line, not an edge of the part. `repeat`:
 * the link from this stop to the next stands for `count` equal steps of `pitch`.
 */
interface Stop { at: number; anchor: number; weight: number; centre?: boolean; repeat?: { count: number; pitch: number } }

/**
 * The longest run of a chain that repeats — the same figures again and again,
 * as a tray's rows (label, gap, channel, wall) or a row of holes — strictly
 * between its two ends, which are the part's own and never part of a run.
 * `start` is the first stop, `period` the links in one repeat, `count` the
 * repeats. Null when nothing repeats enough to save a stop.
 */
export function repeatedRun(at: number[]): { start: number; period: number; count: number } | null {
  const links = at.slice(1).map((x, i) => x - at[i]);
  const n = links.length;
  let best: { start: number; period: number; count: number } | null = null;
  for (let period = 1; 2 * period <= n - 2; period++) {
    for (let start = 1; start + 2 * period <= n - 1; start++) {
      let count = 1;
      const same = (k: number) => {
        for (let j = 0; j < period; j++) if (Math.abs(links[start + k * period + j] - links[start + j]) > SAME_M) return false;
        return true;
      };
      while (start + (count + 1) * period <= n - 1 && same(count)) count++;
      // A period of one is a single figure "count× pitch"; longer ones keep
      // their first repeat spelled out, so they must hide at least two stops.
      const saved = period === 1 ? count - 1 : (count - 1) * period - 1;
      if (count < 2 || saved < 2) continue;
      if (!best || count * period > best.count * best.period) best = { start, period, count };
    }
  }
  return best;
}

/**
 * Sorted stops with the near-duplicates merged and the ends always in — or, when
 * there are more than a chain can hold, only the edges that run the part's whole
 * span across (`across`): its own outline, as a tray's back plate is, where the
 * rest are its channels. A part with that many edges square to the sheet (a
 * gear's teeth, a grille) is not one a chain of figures explains, and picking
 * some of them would be arbitrary; the whole-span ones are not a pick.
 */
function chainStops(stops: Stop[], lo: number, hi: number, across: number, loAnchor: number, hiAnchor = loAnchor): { chain: Stop[]; whole: boolean } {
  const all = [...stops, { at: lo, anchor: loAnchor, weight: Infinity }, { at: hi, anchor: hiAnchor, weight: Infinity }]
    .sort((x, y) => x.at - y.at);
  const merged: Stop[] = [];
  for (const s of all) {
    const last = merged[merged.length - 1];
    if (last && s.at - last.at < MERGE_M) {
      // The heavier stop's position wins; the extension line reaches the nearer of the two.
      if (s.weight > last.weight) last.at = s.at;
      last.anchor = Math.min(last.anchor, s.anchor);
      last.weight = Math.max(last.weight, s.weight);
      last.centre = !!last.centre && !!s.centre;
      continue;
    }
    merged.push({ ...s });
  }
  // A centre line exactly halfway between the two edges either side of it (a
  // pin through the middle of a post, the axle under a tooth) cuts one feature
  // into two halves, 10 + 10 for a ⌀20. The edges give the feature; the centre
  // adds nothing they do not. Between the part's own ends it stays: that is a
  // hole located from the outline.
  for (let i = merged.length - 2; i >= 1; i--) {
    const [prev, s, next] = [merged[i - 1], merged[i], merged[i + 1]];
    if (s.centre && !prev.centre && !next.centre && prev.weight !== Infinity && next.weight !== Infinity &&
      Math.abs(s.at - (prev.at + next.at) / 2) < MERGE_M) merged.splice(i, 1);
  }
  if (merged.length <= MAX_STOPS) return { chain: merged, whole: true };
  // A run that repeats is said once: one repeat's own figures, then the rest
  // as "3× 42" — or, for a row of equal steps, just "8× 10".
  const run = repeatedRun(merged.map((x) => x.at));
  if (run) {
    const { start, period, count } = run;
    const pitch = merged[start + period].at - merged[start].at;
    const end = start + count * period;
    const spelled = period === 1 ? start : start + period;
    const left = period === 1 ? count : count - 1;
    const short = [
      ...merged.slice(0, spelled),
      { ...merged[spelled], repeat: { count: left, pitch } },
      ...merged.slice(end),
    ];
    if (short.length <= MAX_REPEAT_STOPS) return { chain: short, whole: true };
  }
  const outline = merged.filter((s) => s.weight >= FULL_SPAN * across);
  return { chain: outline.length <= MAX_STOPS ? outline : [merged[0], merged[merged.length - 1]], whole: false };
}

/**
 * Whether a point on the part's sheet is covered by any of its triangles, as
 * drawn looking along w: what tells a rim that shows from one buried in other
 * material. Built on first use, as most parts have no rim to ask about.
 */
function coverage(positions: ArrayLike<number>, faces: ArrayLike<number>, axes: SheetAxes) {
  let tris: Float64Array | null = null;
  return (pu: number, pv: number): boolean => {
    if (!tris) {
      tris = new Float64Array((faces.length / 3) * 6);
      for (let t = 0, k = 0; t < faces.length; t++) {
        const i = faces[t] * 3;
        const q = [positions[i], positions[i + 1], positions[i + 2]];
        tris[k++] = dot(q, axes.u);
        tris[k++] = dot(q, axes.v);
      }
    }
    const eps = 1e-9;
    for (let k = 0; k < tris.length; k += 6) {
      const ax = tris[k], ay = tris[k + 1], bx = tris[k + 2], by = tris[k + 3], cx = tris[k + 4], cy = tris[k + 5];
      if (pu < Math.min(ax, bx, cx) - eps || pu > Math.max(ax, bx, cx) + eps) continue;
      if (pv < Math.min(ay, by, cy) - eps || pv > Math.max(ay, by, cy) + eps) continue;
      const d1 = (bx - ax) * (pv - ay) - (by - ay) * (pu - ax);
      const d2 = (cx - bx) * (pv - by) - (cy - by) * (pu - bx);
      const d3 = (ax - cx) * (pv - cy) - (ay - cy) * (pu - cx);
      const area = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
      const tol = eps * Math.max(1, area);
      if ((d1 >= -tol && d2 >= -tol && d3 >= -tol) || (d1 <= tol && d2 <= tol && d3 <= tol)) {
        if (area > 0) return true;
      }
    }
    return false;
  };
}

/** A square edge too short to stop a chain alone; `reach` is its far end, along it. */
type Piece = Stop & { reach: number };

/** A slanted outline edge: its ends on the sheet, and in the document frame. */
interface Slant { a: [number, number]; b: [number, number]; pa: Vec3; pb: Vec3 }
/** A square edge that shows: its ends on the sheet, and which axis it runs along. */
interface SquareEdge { a: [number, number]; b: [number, number]; drawn: number; along: 'u' | 'v' }

/** Samples along an edge when finding the run of it that shows. */
const RUN_SAMPLES = 16;

/**
 * The longest run along an edge, from 0 to 1, where `seen` holds, its ends
 * found to a thousandth of the edge. Null when none of it shows.
 */
function visibleRun(seen: (t: number) => boolean): [number, number] | null {
  const ok = Array.from({ length: RUN_SAMPLES + 1 }, (_, i) => seen(i / RUN_SAMPLES));
  let best: [number, number] | null = null;
  for (let i = 0; i <= RUN_SAMPLES;) {
    if (!ok[i]) { i++; continue; }
    let j = i;
    while (j + 1 <= RUN_SAMPLES && ok[j + 1]) j++;
    if (!best || j - i > best[1] - best[0]) best = [i, j];
    i = j + 1;
  }
  if (!best) return null;
  const edge = (inside: number, outside: number) => {
    for (let k = 0; k < 10; k++) {
      const mid = (inside + outside) / 2;
      if (seen(mid)) inside = mid; else outside = mid;
    }
    return inside;
  };
  const t0 = best[0] / RUN_SAMPLES, t1 = best[1] / RUN_SAMPLES;
  return [t0 > 0 ? edge(t0, t0 - 1 / RUN_SAMPLES) : 0, t1 < 1 ? edge(t1, t1 + 1 / RUN_SAMPLES) : 1];
}

/** Within this of 45°, a slant between a horizontal and a vertical edge is a chamfer. */
const CHAMFER_TOL_DEG = 0.1;
/** A chamfer's neighbours run on at least this many times its leg: it cuts a corner off, it is not the side of a triangle. */
const CHAMFER_SHORTER = 1.5;

/**
 * What the slanted edges add. A chamfer — 45°, cutting a corner off between a
 * horizontal edge and a vertical one, both longer than it — is "5 × 45°" and
 * nothing more, as a drawing gives it. Any other slant puts both its ends in
 * the chains, which sizes it, and its angle from the nearer of the sheet's
 * axes, which says which way it runs; equal ones are labelled once.
 */
function slantDims(slants: Slant[], squares: SquareEdge[], U: Vec3, V: Vec3): { uStops: Stop[]; vStops: Stop[]; dims: AngleDim[] } {
  const uStops: Stop[] = [], vStops: Stop[] = [];
  const found: { label: string; dim: AngleDim }[] = [];
  const near = (p: [number, number], q: [number, number]) => Math.hypot(p[0] - q[0], p[1] - q[1]) < MERGE_M;
  const meets = (p: [number, number], along: 'u' | 'v', longer: number) =>
    squares.some((e) => e.along === along && e.drawn >= longer && (near(e.a, p) || near(e.b, p)));
  for (const s of slants) {
    const du = s.b[0] - s.a[0], dv = s.b[1] - s.a[1];
    const fromLevel = (Math.atan2(Math.abs(dv), Math.abs(du)) * 180) / Math.PI;
    const leg = Math.abs(du);
    const chamfer = Math.abs(fromLevel - 45) <= CHAMFER_TOL_DEG &&
      [[s.a, s.b], [s.b, s.a]].some(([p, q]) => meets(p, 'u', CHAMFER_SHORTER * leg) && meets(q, 'v', CHAMFER_SHORTER * leg));
    if (!chamfer) {
      uStops.push({ at: s.a[0], anchor: s.a[1], weight: Math.abs(du) }, { at: s.b[0], anchor: s.b[1], weight: Math.abs(du) });
      vStops.push({ at: s.a[1], anchor: s.a[0], weight: Math.abs(dv) }, { at: s.b[1], anchor: s.b[0], weight: Math.abs(dv) });
    }
    // From the sheet's horizontal when it runs nearer that, else its vertical,
    // measured at the end the reference line runs out of.
    const level = fromLevel <= 45;
    const deg = level ? fromLevel : 90 - fromLevel;
    const startAtA = level ? s.a[1] <= s.b[1] : s.a[0] <= s.b[0];
    const [p0, p1] = startAtA ? [s.pa, s.pb] : [s.pb, s.pa];
    const d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const k = Math.hypot(d[0], d[1], d[2]);
    const to: Vec3 = [d[0] / k, d[1] / k, d[2] / k];
    const axis = level ? U : V;
    const from: Vec3 = dot(to, axis) >= 0 ? axis : neg(axis);
    const label = chamfer ? `${formatDim(leg)} × 45°` : formatAngle(deg);
    const same = found.find((f) => f.label === label);
    if (same) { same.dim.count = (same.dim.count ?? 1) + 1; continue; }
    found.push({ label, dim: { kind: 'angle', centre: startAtA ? s.a : s.b, from, to, valueDeg: Math.round(deg * 10) / 10, label } });
  }
  for (const f of found) if (f.dim.count) f.dim.label = `${f.dim.count}× ${f.label}`;
  return { uStops, vStops, dims: found.map((f) => f.dim) };
}

/** A circular arc found in an edge: its centre, axis and radius, its middle, and a few points on it. */
interface Arc { centre: Vec3; axis: Vec3; radius: number; mid: Vec3; samples: Vec3[]; sweep: number }

/** A vertex turning less than this is straight on; more than this is a corner, not a facet of a round. */
const ARC_TURN_MIN = (0.5 * Math.PI) / 180;
const ARC_TURN_MAX = (40 * Math.PI) / 180;
/** Least an arc must sweep to be one, and how round it must be: RMS radial error as a share of its radius. */
const ARC_MIN_SWEEP = (20 * Math.PI) / 180;
const ARC_MAX_ERROR = 0.005;
/**
 * How far the radii of an arc's two halves may differ, as a share. A round
 * has one curvature all along; a gear tooth's involute flank fits a circle
 * closely over its short run, but its curvature grows from root to tip.
 */
const ARC_HALVES_AGREE = 0.03;
/**
 * An arc sweeping this far (a channel's round floor, a slot's end) is located
 * by its centre, as a hole is; a corner's quarter round is placed by the
 * edges it runs into.
 */
const ARC_LOCATED_SWEEP = (150 * Math.PI) / 180;

/**
 * The arcs in an edge's polyline: the runs where it turns steadily one way, a
 * little at each vertex as a tessellated round does, each fitted to a circle.
 * A rounded corner's outline runs straight, round, straight with no crease
 * between, so the edge finder hands it over whole; this finds the round in it.
 */
export function arcsOf(points: Vec3[], closed: boolean): Arc[] {
  const n = points.length;
  if (n < 4) return [];
  const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const crossU = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const count = closed ? n : n - 1;
  const segs = Array.from({ length: count }, (_, i) => {
    const d = sub3(points[(i + 1) % n], points[i]);
    const length = Math.hypot(d[0], d[1], d[2]);
    return { from: i, length, dir: (length > 0 ? d.map((x) => x / length) : [0, 0, 0]) as Vec3 };
  });
  /** The turn from segment a into segment b, and which way it bends. */
  const turn = (a: number, b: number) => {
    const c = crossU(segs[a].dir, segs[b].dir);
    const s3 = Math.hypot(c[0], c[1], c[2]);
    return { angle: Math.atan2(s3, dot(segs[a].dir, segs[b].dir)), bend: (s3 > 0 ? c.map((x) => x / s3) : [0, 0, 0]) as Vec3 };
  };
  // Facets of one round: about the same length, each turned a little from the
  // last, all the same way. The straight runs either side of a rounded corner
  // are one long segment each, so they never join.
  const joins = (a: number, b: number, bend: Vec3 | null) => {
    const ratio = segs[a].length / segs[b].length;
    if (!(ratio < 1.5 && ratio > 1 / 1.5)) return null;
    const t = turn(a, b);
    if (!(t.angle > ARC_TURN_MIN && t.angle < ARC_TURN_MAX)) return null;
    if (bend && dot(bend, t.bend) < 0.9) return null;
    return t;
  };
  // A closed ring that is all one round is a circle the edge finder already
  // has, or something round that is not one (an ellipse): not an arc.
  if (closed && segs.every((_, i) => joins(i, (i + 1) % count, null))) return [];
  let begin = 0;
  if (closed) while (begin < count && joins((begin - 1 + count) % count, begin, null)) begin++;
  const out: Arc[] = [];
  for (let k = 0; k < count;) {
    const run = [(begin + k) % count];
    let bend: Vec3 | null = null;
    let sweep = 0;
    while (k + run.length < count + (closed ? 0 : 0)) {
      const next = (begin + k + run.length) % count;
      if (!closed && next < run[run.length - 1]) break;
      const t = joins(run[run.length - 1], next, bend);
      if (!t) break;
      bend = t.bend;
      sweep += t.angle;
      run.push(next);
    }
    k += run.length;
    if (run.length < 3 || sweep < ARC_MIN_SWEEP) continue;
    const all = [...run.map((i) => points[segs[i].from]), points[(segs[run[run.length - 1]].from + 1) % n]];
    // The facet at either end can be the step into what comes next — a bore's
    // flat, short and turned like a facet but with its far end off the round —
    // so a run that does not fit is tried again without it.
    for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const arc = fitArc(all.slice(a, all.length - b));
      if (arc) {
        out.push(arc);
        break;
      }
    }
  }
  return out;
}

/** The arc through a run of facet corners, or null when they are not one round. */
function fitArc(pts: Vec3[]): Arc | null {
  if (pts.length < 4) return null;
  const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  let sweep = 0;
  for (let i = 0; i + 2 < pts.length; i++) {
    const d1 = sub3(pts[i + 1], pts[i]), d2 = sub3(pts[i + 2], pts[i + 1]);
    const c: Vec3 = [d1[1] * d2[2] - d1[2] * d2[1], d1[2] * d2[0] - d1[0] * d2[2], d1[0] * d2[1] - d1[1] * d2[0]];
    sweep += Math.atan2(Math.hypot(c[0], c[1], c[2]), dot(d1, d2));
  }
  if (sweep < ARC_MIN_SWEEP) return null;
  const fit = fitCircle(pts);
  if (!fit || fit.error > ARC_MAX_ERROR) return null;
  const off = Math.max(...pts.map((q) => Math.abs(dot(sub3(q, fit.centre), fit.normal))));
  if (off > ARC_MAX_ERROR * fit.radius) return null;
  if (pts.length >= 7) {
    const half = Math.floor(pts.length / 2);
    const first = fitCircle(pts.slice(0, half + 1));
    const second = fitCircle(pts.slice(half));
    if (!first || !second || Math.abs(first.radius - second.radius) > ARC_HALVES_AGREE * fit.radius) return null;
  }
  const mid = pts[Math.floor(pts.length / 2)];
  return { centre: fit.centre, axis: fit.normal, radius: fit.radius, mid, samples: [pts[1], mid, pts[pts.length - 2]], sweep };
}

/**
 * Short square edges that lie on one line, as one edge: a face line broken by
 * a cut (a channel's end where a finger scoop takes its middle out, the same
 * end on every row of channels) is still the line a drawing measures to. Two
 * or more pieces whose line runs `min` from the first to the last are a stop,
 * weighed by that run.
 */
function joinPieces(pieces: Piece[], min: number): Stop[] {
  const out: Stop[] = [];
  const sorted = [...pieces].sort((a, b) => a.at - b.at);
  for (let i = 0; i < sorted.length;) {
    let j = i, lo = Infinity, hi = -Infinity, at = 0;
    while (j < sorted.length && sorted[j].at - sorted[i].at < MERGE_M) {
      lo = Math.min(lo, sorted[j].anchor);
      hi = Math.max(hi, sorted[j].reach);
      at += sorted[j].at;
      j++;
    }
    if (j - i >= 2 && hi - lo >= min) out.push({ at: at / (j - i), anchor: lo, weight: hi - lo });
    i = j;
  }
  return out;
}

/**
 * Where a round seen side on stands out of the part, found from one of its
 * rims: the stretch of its axis where it stands proud (its centre line
 * covered, the sheet just past its radius either side not), from where it
 * leaves the part to its tip, domed or flat. A peg leaving a plate has a rim
 * only where it meets the plate, often just inside it, or where its shank
 * meets its dome, and none at the tip itself. Null when it stands proud on
 * neither side within a few radii of the rim.
 */
function proudRound(
  covered: (u: number, v: number) => boolean,
  along: 'u' | 'v',
  cu: number,
  cv: number,
  radius: number,
): { from: number; tip: number } | null {
  const centre = along === 'v' ? cv : cu;
  const at = (s: number, off: number) => along === 'v' ? covered(cu + off, s) : covered(s, cv + off);
  const onAxis = (s: number) => at(s, 0);
  const proud = (s: number) => onAxis(s) && !at(s, radius + PAST_M) && !at(s, -radius - PAST_M);
  /** The boundary between `inside` (test true) and `outside`, to a micron. */
  const refine = (inside: number, outside: number, test: (s: number) => boolean) => {
    for (let i = 0; i < 24 && Math.abs(outside - inside) > 1e-6; i++) {
      const mid = (inside + outside) / 2;
      if (test(mid)) inside = mid;
      else outside = mid;
    }
    return inside;
  };
  const step = radius / 4;
  /** From `s`, along `dir` while `test` holds: the last step it held and the first it did not. */
  const walk = (s: number, dir: number, test: (s: number) => boolean) => {
    let next = s + dir * step;
    for (let k = 0; k < 100000 && test(next); k++) { s = next; next = s + dir * step; }
    return { last: s, first: next };
  };
  let p: number | null = null;
  for (let k = 0; k <= 16 && p === null; k++) {
    for (const dir of [1, -1]) if (p === null && proud(centre + dir * k * step)) p = centre + dir * k * step;
  }
  if (p === null) return null;
  // Each way, out to where it stops standing proud: past the tip, where its
  // centre line leaves the part; into the part it stands out of, where
  // material covers it both sides; or into a bend, one side still clear.
  const clear = (s: number) => !at(s, radius + PAST_M) || !at(s, -radius - PAST_M);
  const ends = [1, -1].map((dir) => {
    const { last, first } = walk(p, dir, proud);
    return { dir, last, first, tip: !onAxis(first), bend: clear(first) };
  });
  const tipEnd = ends.find((e) => e.tip) ?? ends.find((e) => e.bend) ??
    // Into material both ways: the tip is the way its centre line leaves the part sooner.
    ends.reduce((a, b) => (Math.abs(walk(a.last, a.dir, onAxis).last - p) <= Math.abs(walk(b.last, b.dir, onAxis).last - p) ? a : b));
  const base = ends.find((e) => e !== tipEnd)!;
  const out = walk(tipEnd.last, tipEnd.dir, onAxis);
  return {
    from: refine(base.last, base.first, base.tip ? onAxis : proud),
    tip: refine(out.last, out.first, onAxis),
  };
}

/**
 * Whether a circular edge is the rim of a boss (a round standing out, which a
 * side view shows) rather than of a hole (cut in, which it does not). Of the
 * edge's two surfaces, the round wall is the one whose facets face away from
 * the axis — or toward it, for a hole.
 */
function bossTest(positions: ArrayLike<number>, faces: ArrayLike<number>, triangleSurface: number[]) {
  const first = new Map<number, number>();
  triangleSurface.forEach((s, t) => { if (s >= 0 && !first.has(s)) first.set(s, t); });
  return (surfaces: [number, number], centre: ArrayLike<number>, axis: ArrayLike<number>): boolean => {
    let best: { across: number; outward: number } | null = null;
    for (const s of surfaces) {
      const t = first.get(s);
      if (t === undefined) continue;
      const q = [0, 1, 2].map((k) => {
        const i = faces[t * 3 + k] * 3;
        return [positions[i], positions[i + 1], positions[i + 2]];
      });
      const ab = [q[1][0] - q[0][0], q[1][1] - q[0][1], q[1][2] - q[0][2]];
      const ac = [q[2][0] - q[0][0], q[2][1] - q[0][1], q[2][2] - q[0][2]];
      const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      const length = Math.hypot(n[0], n[1], n[2]);
      if (!(length > 0)) continue;
      const along = Math.abs(dot(n, axis)) / length;
      const c = [0, 1, 2].map((k) => (q[0][k] + q[1][k] + q[2][k]) / 3 - centre[k]);
      const h = dot(c, axis);
      const radial = [c[0] - axis[0] * h, c[1] - axis[1] * h, c[2] - axis[2] * h];
      // The wall is the surface square to the axis.
      if (!best || along < best.across) best = { across: along, outward: dot(n, radial) };
    }
    return !!best && best.across < 0.5 && best.outward > 0;
  };
}

/**
 * Whether a point is behind the part's own surface, seen along w: some
 * triangle covering it on the sheet lies nearer. Built on first use.
 */
function occlusion(positions: ArrayLike<number>, faces: ArrayLike<number>, axes: SheetAxes) {
  let tris: Float64Array | null = null;
  return (pu: number, pv: number, pw: number): boolean => {
    if (!tris) {
      tris = new Float64Array(faces.length * 3);
      for (let t = 0, k = 0; t < faces.length; t++) {
        const i = faces[t] * 3;
        const q = [positions[i], positions[i + 1], positions[i + 2]];
        tris[k++] = dot(q, axes.u);
        tris[k++] = dot(q, axes.v);
        tris[k++] = dot(q, axes.w);
      }
    }
    for (let k = 0; k < tris.length; k += 9) {
      const ax = tris[k], ay = tris[k + 1], aw = tris[k + 2];
      const bx = tris[k + 3], by = tris[k + 4], bw = tris[k + 5];
      const cx = tris[k + 6], cy = tris[k + 7], cw = tris[k + 8];
      if (Math.min(aw, bw, cw) >= pw - PAST_M) continue;
      if (pu < Math.min(ax, bx, cx) || pu > Math.max(ax, bx, cx)) continue;
      if (pv < Math.min(ay, by, cy) || pv > Math.max(ay, by, cy)) continue;
      const det = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(det) < 1e-18) continue;
      const l1 = ((pu - ax) * (cy - ay) - (pv - ay) * (cx - ax)) / det;
      const l2 = ((bx - ax) * (pv - ay) - (by - ay) * (pu - ax)) / det;
      if (l1 < 0 || l2 < 0 || l1 + l2 > 1) continue;
      if (aw + l1 * (bw - aw) + l2 * (cw - aw) < pw - PAST_M) return true;
    }
    return false;
  };
}

/** What a drawing calls a regular polygonal hole of so many sides. */
const POLYGON_NAMES: Record<number, string> = { 3: 'tri', 4: 'square', 5: 'pent', 6: 'hex', 8: 'oct' };

/**
 * Regular polygonal holes seen end on — a hex bore, a square drive: a closed
 * ring of equal straight edges lying in the sheet round an empty middle. A
 * drawing gives one figure across its flats and locates its centre, as it does
 * a round hole; its sides are not outline edges to chain and slant. Returns the
 * holes and the edges that make them.
 */
function polygonHoles(
  edges: EdgeCandidate[], axes: SheetAxes, covered: (u: number, v: number) => boolean,
): { holes: { centre: [number, number]; radius: number; sides: number }[]; edgeIds: Set<number> } {
  const { u: U, v: V, w: W } = axes;
  const key = (p: ArrayLike<number>) => [0, 1, 2].map((i) => Math.round(p[i] / MERGE_M * 4)).join(',');
  type Line = { id: number; a: number[]; b: number[] };
  const lines: Line[] = [];
  for (const c of edges) {
    if (c.edge.kind !== 'line') continue;
    const { a, b } = c.edge;
    const d = [0, 1, 2].map((i) => b[i] - a[i]);
    const length = Math.hypot(d[0], d[1], d[2]);
    if (length > SAME_M && Math.abs(dot(d, W)) / length < IN_SHEET) lines.push({ id: c.id, a, b });
  }
  const at = new Map<string, Line[]>();
  for (const c of lines) {
    for (const p of [c.a, c.b]) {
      const k = key(p);
      at.set(k, [...(at.get(k) ?? []), c]);
    }
  }
  const holes: { centre: [number, number]; radius: number; sides: number }[] = [];
  const edgeIds = new Set<number>();
  const visited = new Set<number>();
  for (const start of lines) {
    if (visited.has(start.id)) continue;
    // Walk the ring corner to corner, through corners shared by exactly two.
    const ring: Line[] = [start];
    const points: ArrayLike<number>[] = [start.a, start.b];
    visited.add(start.id);
    let corner = key(start.b);
    let closed = false;
    while (ring.length <= 12) {
      const here = at.get(corner) ?? [];
      if (here.length !== 2) break;
      const next = here.find((c) => c !== ring[ring.length - 1])!;
      if (next === start) { closed = true; break; }
      if (visited.has(next.id)) break;
      visited.add(next.id);
      ring.push(next);
      const far = key(next.a) === corner ? next.b : next.a;
      points.push(far);
      corner = key(far);
    }
    if (!closed || ring.length < 3 || ring.length > 12) continue;
    const corners = points.slice(0, ring.length).map((q) => [dot(q, U), dot(q, V)]);
    const centre: [number, number] = [
      corners.reduce((t, q) => t + q[0], 0) / corners.length,
      corners.reduce((t, q) => t + q[1], 0) / corners.length,
    ];
    const lengths = ring.map((c) => Math.hypot(...[0, 1, 2].map((i) => c.b[i] - c.a[i])));
    const spokes = corners.map((q) => Math.hypot(q[0] - centre[0], q[1] - centre[1]));
    const even = (xs: number[]) => Math.max(...xs) - Math.min(...xs) <= 0.02 * Math.max(...xs);
    if (!even(lengths) || !even(spokes) || covered(centre[0], centre[1])) continue;
    for (const c of ring) edgeIds.add(c.id);
    const radius = (spokes.reduce((t, x) => t + x, 0) / spokes.length) * Math.cos(Math.PI / ring.length);
    // Both rims of a through hole are one hole.
    if (!holes.some((h) => h.sides === ring.length && Math.abs(h.radius - radius) < SAME_M &&
      Math.hypot(h.centre[0] - centre[0], h.centre[1] - centre[1]) < SAME_M)) {
      holes.push({ centre, radius, sides: ring.length });
    }
  }
  return { holes, edgeIds };
}

/** A gear figure to the hundredth of a mm, or of a module: no trailing zeros. */
const gearFigure = (v: number) => String(+v.toFixed(2));

/**
 * The gear data of a toothed part in one view. The pitch circle is drawn only
 * when the gear's axis looks straight at the sheet, where it is a circle; the
 * figures are given in every view, as a gear drawing's data table is.
 */
export function gearDim(tooth: NonNullable<BodyMesh['toothForm']>, axes: SheetAxes, forward: Vec3): GearDim {
  const { form, origin, axes: [X, Y, Z] } = tooth;
  const sheet = (x: number, y: number): [number, number] => {
    const q = [0, 1, 2].map((i) => origin[i] + X[i] * x + Y[i] * y);
    return [dot(q, axes.u), dot(q, axes.v)];
  };
  const endOn = Math.abs(dot(Z, forward)) > END_ON;
  const centre = sheet(0, 0);
  const toward: [number, number] = [Math.SQRT1_2, Math.SQRT1_2];
  const lines: string[] = [];
  let pitchCircle: GearDim['pitchCircle'];
  let pitchLine: GearDim['pitchLine'];
  let anchor = centre;
  const onCircle = (diameterMm: number) => {
    const radius = diameterMm / 2000;
    pitchCircle = { centre, radius };
    anchor = [centre[0] + toward[0] * radius, centre[1] + toward[1] * radius];
  };
  if (form.kind === 'involute') {
    lines.push(`${form.teeth}T · m${gearFigure(form.moduleMm)} · PA ${formatAngle(form.pressureAngleDeg)}`);
    if (Math.abs(form.profileShift) >= 0.005) lines.push(`x ${form.profileShift > 0 ? '+' : ''}${gearFigure(form.profileShift)}`);
    lines.push(`d ⌀${gearFigure(form.pitchDiameterMm)} · da ⌀${gearFigure(form.tipDiameterMm)} · df ⌀${gearFigure(form.rootDiameterMm)}`);
    if (form.backlashMm > 0) lines.push(`backlash ${gearFigure(form.backlashMm)}`);
    if (endOn) onCircle(form.pitchDiameterMm);
  } else if (form.kind === 'gt2') {
    lines.push(`GT2 ${form.teeth}T · p ${gearFigure(form.pitchMm)}`);
    lines.push(`PD ⌀${gearFigure(form.pitchDiameterMm)} · OD ⌀${gearFigure(form.outsideDiameterMm)}`);
    if (endOn) onCircle(form.pitchDiameterMm);
  } else {
    lines.push(`Rack ${form.teeth}T · m${gearFigure(form.moduleMm)} · PA ${formatAngle(form.pressureAngleDeg)}`);
    lines.push(`p ${gearFigure(form.pitchMm)}${form.backlashMm > 0 ? ` · backlash ${gearFigure(form.backlashMm)}` : ''}`);
    if (endOn) {
      const half = form.lengthMm / 2000;
      pitchLine = { a: sheet(-half, 0), b: sheet(half, 0) };
      anchor = pitchLine.b;
    }
  }
  return { kind: 'gear', pitchCircle, pitchLine, anchor, toward, lines, label: lines.join(' · ') };
}

/** The dimensions for one part in one view. */
export function bodyViewDimensions(body: BodyMesh, view: DrawingView): BodyDimensions | null {
  const { forward, right, up } = VIEW_AXES[view];
  const axes = sheetAxes(body.frame, view);
  const { u: U, v: V, w: W } = axes;
  const p = body.positions;
  if (p.length < 9) return null;

  // --- the outline, on the part's own axes ---------------------------------
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, w0 = Infinity, w1 = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const q = [p[i], p[i + 1], p[i + 2]];
    const u = dot(q, U), v = dot(q, V), w = dot(q, W);
    if (u < u0) u0 = u;
    if (u > u1) u1 = u;
    if (v < v0) v0 = v;
    if (v > v1) v1 = v;
    if (w < w0) w0 = w;
    if (w > w1) w1 = w;
  }
  if (!(u1 - u0 > SAME_M || v1 - v0 > SAME_M)) return null;
  const width = u1 - u0;
  const height = v1 - v0;
  let u0Anchor = Infinity, u1Anchor = Infinity, v0Anchor = Infinity, v1Anchor = Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const q = [p[i], p[i + 1], p[i + 2]];
    const u = dot(q, U), v = dot(q, V);
    if (u <= u0 + MERGE_M && v < u0Anchor) u0Anchor = v;
    if (u >= u1 - MERGE_M && v < u1Anchor) u1Anchor = v;
    if (v <= v0 + MERGE_M && u < v0Anchor) v0Anchor = u;
    if (v >= v1 - MERGE_M && u < v1Anchor) v1Anchor = u;
  }
  const covered = coverage(body.positions, body.faces, axes);

  // --- the edges -----------------------------------------------------------
  const uStops: Stop[] = [];
  const vStops: Stop[] = [];
  const circles: { centre: [number, number]; radius: number }[] = [];
  let polygons: ReturnType<typeof polygonHoles>['holes'] = [];
  const balls: { centre: [number, number]; radius: number }[] = [];
  const hidden = occlusion(body.positions, body.faces, { u: right, v: up, w: forward });
  /**
   * Whether any of a round's near face shows past the rest of the part: its
   * nearest point and four around it, a little in from its rim. An eye inside
   * a skull, or a ball behind a plate, gets no leader pointing at nothing.
   */
  const inSight = (c: ArrayLike<number>, radius: number) => {
    const at = (du: number, dv: number) => {
      const k = Math.sqrt(Math.max(0, 1 - du * du - dv * dv));
      const q = [0, 1, 2].map((i) => c[i] + radius * (du * right[i] + dv * up[i] - k * forward[i]));
      return !hidden(dot(q, right), dot(q, up), dot(q, forward));
    };
    return at(0, 0) || at(0.7, 0) || at(-0.7, 0) || at(0, 0.7) || at(0, -0.7);
  };
  // Rounds lying in the view: across them, from silhouette to silhouette, is a diameter.
  const sideOn: { axis: 'u' | 'v'; lo: number; hi: number }[] = [];
  // Whether something straight runs along each axis, which is what makes the
  // part's turn in the view an angle worth giving: a plain disc's is not.
  const straight = { u: false, v: false };
  // Square edges too short to be a face on their own, kept in case they line
  // up into one that is (see joinPieces).
  const pieces: { u: Piece[]; v: Piece[] } = { u: [], v: [] };
  // Slanted outline edges, for their ends and their angles (see slantDims).
  const slants: Slant[] = [];
  // The square edges that show, for telling a chamfer from any other slant.
  const squares: SquareEdge[] = [];
  // Arcs of the edges, for their radii (see arcsOf).
  const arcs: Arc[] = [];
  // Rounds standing out of the part whose rims are buried (see proudRound).
  const pegs: { along: 'u' | 'v'; cu: number; cv: number; radius: number }[] = [];

  /**
   * A round seen side on, its axis along `along`: its silhouette is a stop each
   * side across it, and a diameter between them. `at` is where to stand along
   * the axis to look across.
   */
  const silhouette = (along: 'u' | 'v', cu: number, cv: number, radius: number, weight: number) => {
    if (along === 'v') {
      uStops.push({ at: cu - radius, anchor: cv, weight }, { at: cu + radius, anchor: cv, weight });
      sideOn.push({ axis: 'u', lo: cu - radius, hi: cu + radius });
    } else {
      vStops.push({ at: cv - radius, anchor: cu, weight }, { at: cv + radius, anchor: cu, weight });
      sideOn.push({ axis: 'v', lo: cv - radius, hi: cv + radius });
    }
  };

  if (body.faces.length / 3 <= MAX_DIM_TRIANGLES) {
    const found = featureEdgesMemo.get(body.positions, body.faces, () =>
      findFeatureEdges(body.positions, body.faces),
    );
    const isBoss = bossTest(body.positions, body.faces, found.triangleSurface);
    /**
     * A straight edge, judged by how it is drawn on the part's own sheet, not
     * how it lies: seen along w, an edge tilted away in depth is still a
     * vertical line at one place across it, and that place is what a
     * dimension measures to. `outline`: one of its faces lies in the sheet.
     * `pieces`: one too short to stop a chain may still join others in line.
     */
    const straightEdge = (ea: Vec3, eb: Vec3, faceSquareTo: (axis: Vec3) => boolean, outline: boolean, pieces_: boolean) => {
      const delta = [eb[0] - ea[0], eb[1] - ea[1], eb[2] - ea[2]];
      const du = dot(delta, U);
      const dv = dot(delta, V);
      const drawn = Math.hypot(du, dv);
      if (!(drawn > SAME_M)) return;
      const ua = dot(ea, U), ub = dot(eb, U);
      const va = dot(ea, V), vb = dot(eb, V);
      const length = Math.hypot(delta[0], delta[1], delta[2]);
      const point = (t: number): Vec3 => [ea[0] + t * delta[0], ea[1] + t * delta[1], ea[2] + t * delta[2]];
      const seen = (t: number) => {
        const q = point(t);
        return !hidden(dot(q, right), dot(q, up), dot(q, forward));
      };
      const square = Math.abs(du) / drawn < SQUARE || Math.abs(dv) / drawn < SQUARE;
      if (!square) {
        // Slanted on the sheet: a chamfer, a draft, a dovetail's flank, a
        // gusset's hypotenuse. Only an outline edge, lying in the sheet
        // itself so the angle drawn is its true angle — and only the run of
        // it that shows: a gusset's hypotenuse ends where it meets the plate
        // and the arm, not at its corners buried in them.
        const inSheet = Math.abs(dot(delta, W)) / length < IN_SHEET;
        if (!inSheet || !outline || drawn < MIN_EDGE_SHARE * Math.min(width, height)) return;
        const run = visibleRun(seen);
        if (!run) return;
        const pa = point(run[0]), pb = point(run[1]);
        slants.push({ a: [dot(pa, U), dot(pa, V)], b: [dot(pb, U), dot(pb, V)], pa, pb });
        return;
      }
      // A hidden edge is not dimensioned (a rib's end buried in the plate it
      // stiffens): looked at a quarter, half and three quarters along.
      if (![0.5, 0.25, 0.75].some(seen)) return;
      const along: 'u' | 'v' = Math.abs(du) / drawn < SQUARE ? 'v' : 'u';
      const share = MIN_EDGE_SHARE * (along === 'v' ? height : width);
      if (drawn < share && !pieces_) return;
      squares.push({ a: [ua, va], b: [ub, vb], drawn, along });
      // Runs up the part: a stop across it, reaching down to the width row.
      if (along === 'v' && faceSquareTo(U)) {
        const stop = { at: (ua + ub) / 2, anchor: Math.min(va, vb), weight: drawn };
        if (drawn >= share) uStops.push(stop);
        else pieces.u.push({ ...stop, reach: Math.max(va, vb) });
        if (drawn >= share && Math.abs(dv) / length > 1 - SQUARE) straight.v = true;
      }
      // Runs along the part: a stop up it, reaching left to the height row.
      if (along === 'u' && faceSquareTo(V)) {
        const stop = { at: (va + vb) / 2, anchor: Math.min(ua, ub), weight: drawn };
        if (drawn >= share) vStops.push(stop);
        else pieces.v.push({ ...stop, reach: Math.max(ua, ub) });
        if (drawn >= share && Math.abs(du) / length > 1 - SQUARE) straight.u = true;
      }
    };
    const polygonal = polygonHoles(found.edges, axes, covered);
    polygons = polygonal.holes;
    for (const candidate of found.edges) {
      if (polygonal.edgeIds.has(candidate.id)) continue;
      const e = candidate.edge;
      if (e.kind === 'line') {
        // Only an edge where at least one of its two faces stands square to the
        // measured axis (a step wall) or lies in the sheet (a front/back face)
        // is a step: a ridge between two banked/slanted faces is not.
        const faceSquareTo = (axis: Vec3) => candidate.surfaces.some((s) => {
          const n = found.surfaces[s]?.normal;
          return !!n && (Math.abs(dot(n, axis)) >= 1 - SQUARE || Math.abs(dot(n, W)) >= 1 - SQUARE);
        });
        const outline = candidate.surfaces.some((s) => {
          const n = found.surfaces[s]?.normal;
          return !!n && Math.abs(dot(n, W)) >= 1 - SQUARE;
        });
        straightEdge(e.a as Vec3, e.b as Vec3, faceSquareTo, outline, true);
      } else {
        const facing = Math.abs(dot(e.axis, W));
        const cu = dot(e.centre, U), cv = dot(e.centre, V);
        if (facing > END_ON) {
          circles.push({ centre: [cu, cv], radius: e.radius });
          continue;
        }
        if (facing >= 1 - END_ON) continue;
        // In the sheet, so drawn as a straight line across the round. Where the
        // round steps (a mast on a wider base) or ends, the rim is a stop along
        // its axis — if it shows. Looked for just either side of the rim, a
        // little inside the round's radius: material on both sides means the
        // rim is buried (a shaft's end inside the sail it carries).
        const along = Math.abs(dot(e.axis, V)) > END_ON ? 'v' : Math.abs(dot(e.axis, U)) > END_ON ? 'u' : null;
        // A hole seen side on is out of sight inside the part: only a boss shows.
        if (!along || !isBoss(candidate.surfaces, e.centre, e.axis)) continue;
        const r = 0.9 * e.radius;
        const shows = along === 'v'
          ? [cv - PAST_M, cv + PAST_M].some((v) => !covered(cu - r, v) || !covered(cu + r, v))
          : [cu - PAST_M, cu + PAST_M].some((u) => !covered(u, cv - r) || !covered(u, cv + r));
        if (!shows) {
          // Covered both sides can still be a peg: the plate on one side, the
          // peg itself on the other, out to a domed tip that has no edge.
          const peg = proudRound(covered, along, cu, cv, e.radius);
          if (!peg) continue;
          const stops = along === 'v' ? vStops : uStops;
          const across = along === 'v' ? cu : cv;
          stops.push(
            { at: peg.from, anchor: across - e.radius, weight: 2 * e.radius },
            { at: peg.tip, anchor: across - e.radius, weight: 2 * e.radius },
          );
          pegs.push({ along, cu, cv, radius: e.radius });
          continue;
        }
        if (along === 'v') vStops.push({ at: cv, anchor: cu - e.radius, weight: 2 * e.radius });
        else uStops.push({ at: cu, anchor: cv - e.radius, weight: 2 * e.radius });
        silhouette(along, cu, cv, e.radius, 2 * e.radius);
      }
    }
    // Edges that are neither line nor circle: an outline running round a
    // rounded corner, tangent to the faces either side, is one of them.
    // Its straight runs are edges like any other — the top of a plate between
    // its two rounded corners — but only whole ones: a round's facets are not.
    for (const chain of found.other) {
      arcs.push(...arcsOf(chain.points, chain.closed));
      const n = chain.points.length;
      for (let i = 0; i < (chain.closed ? n : n - 1); i++) {
        straightEdge(chain.points[i] as Vec3, chain.points[(i + 1) % n] as Vec3, () => true, true, false);
      }
    }
  }

  uStops.push(...joinPieces(pieces.u, MIN_EDGE_SHARE * height));
  vStops.push(...joinPieces(pieces.v, MIN_EDGE_SHARE * width));
  // A part with no edge square to the sheet is turned in it, not slanted in
  // places: its slants are its outline at an angle, not features to size.
  const slanted = squares.length ? slantDims(slants, squares, U, V) : { uStops: [], vStops: [], dims: [] };
  uStops.push(...slanted.uStops);
  vStops.push(...slanted.vStops);

  // A peg's sides, unless an end-on round of its size is on its axis (a hook's
  // leg in line with its arm seen end-on): that circle already gives its ⌀ and
  // locates it, and its two sides would crowd the chain past MAX_STOPS.
  for (const peg of pegs) {
    const inLine = circles.some((c) => Math.abs(c.radius - peg.radius) < 0.1 * peg.radius &&
      (peg.along === 'v' ? Math.abs(c.centre[0] - peg.cu) : Math.abs(c.centre[1] - peg.cv)) < MERGE_M);
    if (!inLine) silhouette(peg.along, peg.cu, peg.cv, peg.radius, 2 * peg.radius);
  }

  // Rods: seen end-on, a circle; seen side on, a silhouette each side, and the
  // tip of each domed end where it is not buried in the part.
  for (const rod of body.rods ?? []) {
    const axis = [rod.b[0] - rod.a[0], rod.b[1] - rod.a[1], rod.b[2] - rod.a[2]];
    const length = Math.hypot(axis[0], axis[1], axis[2]);
    const mid: Vec3 = [(rod.a[0] + rod.b[0]) / 2, (rod.a[1] + rod.b[1]) / 2, (rod.a[2] + rod.b[2]) / 2];
    const cu = dot(mid, U), cv = dot(mid, V);
    const t = length > 0 ? axis.map((x) => x / length) : [0, 0, 1];
    if (Math.abs(dot(t, W)) > END_ON) {
      // Seen from the end nearer the camera, its dome's centre.
      const near = dot(rod.a, forward) < dot(rod.b, forward) ? rod.a : rod.b;
      if (inSight(near, rod.radius)) balls.push({ centre: [cu, cv], radius: rod.radius });
      continue;
    }
    const along = Math.abs(dot(t, V)) > END_ON ? 'v' : Math.abs(dot(t, U)) > END_ON ? 'u' : null;
    if (!along) continue;
    straight[along] = true;
    const half = length / 2 + rod.radius;
    const across = along === 'v' ? cu : cv;
    const centre = along === 'v' ? cv : cu;
    const stops = along === 'v' ? vStops : uStops;
    for (const tip of [centre - half, centre + half]) {
      const past = tip + Math.sign(tip - centre) * PAST_M;
      if (!(along === 'v' ? covered(across, past) : covered(past, across))) {
        stops.push({ at: tip, anchor: across - rod.radius, weight: 2 * rod.radius });
      }
    }
    const looks = along === 'v'
      ? [cu - rod.radius - PAST_M, cu + rod.radius + PAST_M].some((u) => !covered(u, cv))
      : [cv - rod.radius - PAST_M, cv + rod.radius + PAST_M].some((v) => !covered(cu, v));
    if (looks) silhouette(along, cu, cv, rod.radius, 2 * rod.radius);
  }

  // A sphere wholly inside another is out of sight (an eye socket inside a
  // skull) and gets nothing. The rest get their diameter, but no chain stop:
  // a sphere's centre is not an edge anyone measures to on a drawing.
  const spheres = (body.spheres ?? []).filter((a, i, all) => !all.some((b, j) => j !== i &&
    b.radius > a.radius &&
    Math.hypot(a.centre[0] - b.centre[0], a.centre[1] - b.centre[1], a.centre[2] - b.centre[2]) + a.radius <= b.radius + SAME_M));
  for (const sphere of spheres) {
    if (!inSight(sphere.centre, sphere.radius)) continue;
    balls.push({ centre: [dot(sphere.centre, U), dot(sphere.centre, V)], radius: sphere.radius });
  }

  // --- circles: one per hole, one label per size ---------------------------
  const holes: { centre: [number, number]; radius: number }[] = [];
  // An arc of more than half a circle is given by its diameter, as a drawing
  // gives it: a D-shaft bore is "⌀5" with its flat, not "R2.5".
  const overHalf = arcs
    .filter((arc) => arc.sweep > Math.PI && Math.abs(dot(arc.axis, W)) > END_ON &&
      arc.samples.some((q) => !hidden(dot(q, right), dot(q, up), dot(q, forward))))
    .map((arc) => ({ centre: [dot(arc.centre, U), dot(arc.centre, V)] as [number, number], radius: arc.radius }));
  for (const c of [...circles, ...balls, ...overHalf]) {
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

  const dims: ViewDim[] = [...slanted.dims];
  if (body.toothForm) dims.push(gearDim(body.toothForm, axes, forward));
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
  const polygonSizes: { sides: number; radius: number; members: typeof polygons }[] = [];
  for (const h of polygons) {
    const size = polygonSizes.find((x) => x.sides === h.sides && Math.abs(x.radius - h.radius) < SAME_M);
    if (size) size.members.push(h);
    else polygonSizes.push({ sides: h.sides, radius: h.radius, members: [h] });
  }
  for (const size of polygonSizes) {
    const at = size.members.reduce((best, h) =>
      h.centre[0] + h.centre[1] > best.centre[0] + best.centre[1] ? h : best);
    const count = size.members.length;
    const name = POLYGON_NAMES[size.sides] ?? `${size.sides}-gon`;
    dims.push({
      kind: 'diameter',
      centre: at.centre,
      radius: size.radius,
      sides: size.sides,
      count,
      valueMm: Math.round(size.radius * 2 * 10000) / 10,
      label: `${count > 1 ? `${count}× ` : ''}${name} ${formatDim(size.radius * 2)} A/F`,
    });
  }
  // --- radii: each arc that faces the sheet and shows, one label per size ---
  // An arc drawn square on is its true radius. Both ends of a rounded plate
  // draw the same arc, so one per place; one hidden behind the part, none.
  const radii: { centre: [number, number]; radius: number; toward: [number, number] }[] = [];
  for (const arc of arcs) {
    if (Math.abs(dot(arc.axis, W)) <= END_ON) continue;
    if (!arc.samples.some((q) => !hidden(dot(q, right), dot(q, up), dot(q, forward)))) continue;
    const centre: [number, number] = [dot(arc.centre, U), dot(arc.centre, V)];
    if (holes.some((h) => Math.abs(h.radius - arc.radius) < SAME_M &&
      Math.hypot(h.centre[0] - centre[0], h.centre[1] - centre[1]) < SAME_M)) continue;
    if (radii.some((r) => Math.abs(r.radius - arc.radius) < SAME_M &&
      Math.hypot(r.centre[0] - centre[0], r.centre[1] - centre[1]) < MERGE_M)) continue;
    const du = dot(arc.mid, U) - centre[0], dv = dot(arc.mid, V) - centre[1];
    const k = Math.hypot(du, dv) || 1;
    radii.push({ centre, radius: arc.radius, toward: [du / k, dv / k] });
    if (arc.sweep >= ARC_LOCATED_SWEEP) {
      uStops.push({ at: centre[0], anchor: centre[1], weight: 2 * arc.radius, centre: true });
      vStops.push({ at: centre[1], anchor: centre[0], weight: 2 * arc.radius, centre: true });
    }
  }
  const radiusSizes: { radius: number; members: typeof radii }[] = [];
  for (const r of radii) {
    const size = radiusSizes.find((x) => Math.abs(x.radius - r.radius) < SAME_M);
    if (size) size.members.push(r);
    else radiusSizes.push({ radius: r.radius, members: [r] });
  }
  for (const size of radiusSizes) {
    // On the arc furthest up and right, as a ⌀ is.
    const at = size.members.reduce((best, r) =>
      r.centre[0] + r.toward[0] * r.radius + r.centre[1] + r.toward[1] * r.radius >
      best.centre[0] + best.toward[0] * best.radius + best.centre[1] + best.toward[1] * best.radius ? r : best);
    const count = size.members.length;
    dims.push({
      kind: 'radius',
      centre: at.centre,
      radius: size.radius,
      toward: at.toward,
      count,
      valueMm: Math.round(size.radius * 10000) / 10,
      label: `${count > 1 ? `${count}× ` : ''}R${formatDim(size.radius)}`,
    });
  }

  const result = (): BodyDimensions => ({ id: body.id, axes, bounds: { u: [u0, u1], v: [v0, v1] }, depth: (w0 + w1) / 2, dims });
  if (wholeDisc) return result();

  // Holes seen end-on are located by their centres. A hole's extension line
  // starts at its centre: a centre line.
  for (const h of [...holes, ...polygons]) {
    if (balls.includes(h)) continue;
    uStops.push({ at: h.centre[0], anchor: h.centre[1], weight: 2 * h.radius, centre: true });
    vStops.push({ at: h.centre[1], anchor: h.centre[0], weight: 2 * h.radius, centre: true });
  }

  // --- rows ----------------------------------------------------------------
  const isDiameter = (axis: 'u' | 'v', a: number, b: number) =>
    sideOn.some((s) => s.axis === axis && Math.abs(s.lo - a) < MERGE_M && Math.abs(s.hi - b) < MERGE_M);
  const linear = (axis: 'u' | 'v', a: Stop, b: Stop, row: 1 | 2, edge: number, repeat?: Stop['repeat']): LinearDim => ({
    kind: 'linear',
    axis,
    a: a.at,
    b: b.at,
    anchorA: a.anchor,
    anchorB: b.anchor,
    edge,
    row,
    ...(repeat ? {
      count: repeat.count,
      valueMm: Math.round(repeat.pitch * 10000) / 10,
      label: `${repeat.count}× ${formatDim(repeat.pitch)}`,
    } : {
      valueMm: Math.round((b.at - a.at) * 10000) / 10,
      label: `${isDiameter(axis, a.at, b.at) ? '⌀' : ''}${formatDim(b.at - a.at)}`,
    }),
  });

  // A sphere as wide as the part, centred on it (a pendulum's bob on its rod):
  // its ⌀ leader already gives that size, and the steps from the rod out to the
  // ball's sides (18 − 5 = 13) are not the size of anything. That way, only the
  // diameters of rounds seen side on are given.
  const sphereSpans = (axis: 'u' | 'v', lo: number, hi: number) => balls.some((b) => {
    const c = axis === 'u' ? b.centre[0] : b.centre[1];
    return Math.abs(c - b.radius - lo) < MERGE_M && Math.abs(c + b.radius - hi) < MERGE_M;
  });
  const rows = (axis: 'u' | 'v', stops: Stop[], lo: number, hi: number, edge: number, loAnchor: number, hiAnchor: number) => {
    if (!(hi - lo > SAME_M)) return;
    const across = axis === 'u' ? height : width;
    const found = chainStops(stops, lo, hi, across, loAnchor, hiAnchor);
    // Too many for one chain, but the edges and the centres of the holes and
    // pins each fit their own: two rows, as a drawing gives them, the centres'
    // drawn the row further out.
    let chains = [found.chain];
    if (!found.whole && stops.some((x) => x.centre)) {
      const edges = chainStops(stops.filter((x) => !x.centre), lo, hi, across, loAnchor, hiAnchor);
      const centres = chainStops(stops.filter((x) => x.centre), lo, hi, across, loAnchor, hiAnchor);
      if (edges.whole && centres.whole) chains = [edges.chain, centres.chain];
    }
    const chain = chains[0];
    if (sphereSpans(axis, lo, hi)) {
      for (let i = 0; i + 1 < chain.length; i++) {
        if (isDiameter(axis, chain[i].at, chain[i + 1].at)) dims.push(linear(axis, chain[i], chain[i + 1], 1, edge));
      }
      return;
    }
    for (const links of chains) {
      if (links.length <= 2) continue;
      const lengths = links.slice(1).map((stop, i) => stop.at - links[i].at);
      // A repeat is never the one left out: "3× 42" is not a length to subtract.
      const skip = omittedLink(lengths, lengths.map((_, i) => !!links[i].repeat || isDiameter(axis, links[i].at, links[i + 1].at)));
      for (let i = 0; i + 1 < links.length; i++) {
        if (i !== skip) dims.push(linear(axis, links[i], links[i + 1], 1, edge, links[i].repeat));
      }
    }
    dims.push(linear(axis, chain[0], chain[chain.length - 1], 2, edge));
  };
  rows('u', uStops, u0, u1, v0, u0Anchor, u1Anchor);
  rows('v', vStops, v0, v1, u0, v0Anchor, v1Anchor);

  // --- the angle -----------------------------------------------------------
  // Measured on the part's long axis, and only when that axis lies in the
  // view's plane, where the angle it is drawn at is the angle it is at.
  const main = width >= height ? 'u' : 'v';
  const m = main === 'u' ? U : V;
  if (straight[main] && Math.abs(dot(m, forward)) < IN_SHEET) {
    const x = dot(m, right), y = dot(m, up);
    const off = (Math.atan2(Math.abs(y), Math.abs(x)) * 180) / Math.PI;
    const [deg, ref] = off <= 45 ? [off, right] : [90 - off, up];
    if (deg > MIN_ANGLE_DEG) {
      dims.push({
        kind: 'angle',
        centre: [(u0 + u1) / 2, (v0 + v1) / 2],
        from: dot(m, ref) >= 0 ? ref : neg(ref),
        to: m,
        valueDeg: Math.round(deg * 10) / 10,
        label: formatAngle(deg),
      });
    }
  }

  return result();
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

/**
 * Where a part sits: its origin from its parent's (from the world's, for a
 * part with none), across the sheet and up it. The two figures and the third
 * from another view put every part where it goes; each part's own dimensions
 * then say what it is.
 */
export interface LocationDim {
  id: string;
  /** The reference and the located origin, on the view's own right and up, metres. */
  from: [number, number];
  to: [number, number];
  /** The two figures; null where the part is not moved that way. */
  across: { valueMm: number; label: string } | null;
  up: { valueMm: number; label: string } | null;
}

export function locationDimensions(links: { id: string; from: Vec3; to: Vec3 }[], view: DrawingView): LocationDim[] {
  const { right, up } = VIEW_AXES[view];
  const figure = (d: number) => (Math.abs(d) < MERGE_M ? null : {
    valueMm: Math.round(Math.abs(d) * 10000) / 10,
    label: formatDim(Math.abs(d)),
  });
  const out: LocationDim[] = [];
  for (const link of links) {
    const from: [number, number] = [dot(link.from, right), dot(link.from, up)];
    const to: [number, number] = [dot(link.to, right), dot(link.to, up)];
    const across = figure(to[0] - from[0]);
    const upFigure = figure(to[1] - from[1]);
    if (across || upFigure) out.push({ id: link.id, from, to, across, up: upFigure });
  }
  return out;
}
