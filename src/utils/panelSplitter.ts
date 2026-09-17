/**
 * Cutting a part that does not fit the stock into pieces that do.
 *
 * The constraint this exists for is not tidiness, it is capability. A sand
 * casting flask is a 300 x 300 ring 60 mm tall; nobody has a 300 x 300 slab of
 * 60 mm timber, and everybody has 60 mm bar. Cut as four mitred lengths it needs
 * four pieces 300 x 20. The part is unchanged — it is the same ring when it is
 * glued up — but it becomes something the rack can actually produce.
 *
 * The first strategy here is the rectangular ring, because that is the shape
 * whose one-piece cut wastes the most and whose split is least ambiguous: the
 * four corner diagonals, which for a ring of even border width are exactly 45
 * degrees. Straight cuts across an arbitrary oversized panel are the same
 * machinery with a different line-placement rule and a splice at the seam
 * rather than a plain mitre; they belong here when they land.
 *
 * Nothing splits unless it is asked for. Turning one part into four that must
 * be glued up is a change to the object, not to how it is cut, and it is not a
 * decision this file may take on the operator's behalf.
 */
import type { LaserPanel, Point2D, StockItem } from './laserCutExporter';

/** Closes the loop for indexing: vertex after the last is the first. */
const at = (poly: Point2D[], i: number) => poly[((i % poly.length) + poly.length) % poly.length];

function signedArea(pts: Point2D[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = at(pts, i + 1);
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

const ccw = (pts: Point2D[]): Point2D[] => (signedArea(pts) < 0 ? [...pts].reverse() : pts);

/** Drops vertices that sit on the line between their neighbours. */
function dedupe(pts: Point2D[], tol = 0.05): Point2D[] {
  const out: Point2D[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(last.x - p.x, last.y - p.y) > tol) out.push(p);
  }
  while (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= tol) {
    out.pop();
  }
  return out;
}

/**
 * True when a loop is a rectangle: four corners, each a right angle.
 *
 * Tested by angle rather than by axis alignment, because a panel's 2D frame is
 * whatever its 3D face gave it — a perfectly rectangular ring can arrive at
 * any rotation within its own plane.
 */
function isRectangle(pts: Point2D[], toleranceDeg = 2): boolean {
  if (pts.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const prev = at(pts, i - 1);
    const here = pts[i];
    const next = at(pts, i + 1);
    const ax = prev.x - here.x;
    const ay = prev.y - here.y;
    const bx = next.x - here.x;
    const by = next.y - here.y;
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (la < 1e-6 || lb < 1e-6) return false;
    const cos = (ax * bx + ay * by) / (la * lb);
    if (Math.abs(cos) > Math.sin((toleranceDeg * Math.PI) / 180)) return false;
  }
  return true;
}

/** The narrowest strip worth cutting and gluing, in mm. */
const MIN_STRIP_MM = 4;

/**
 * True when every turn round a loop goes the same way.
 *
 * The check that catches a bow tie: a quadrilateral whose vertices are paired
 * up in the wrong order still has four points and a plausible area, and only
 * reveals itself by turning back on itself at two of them.
 */
function isConvex(pts: Point2D[]): boolean {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = at(pts, i + 1);
    const c = at(pts, i + 2);
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
}

export interface RingSplit {
  /** The four strips, in order round the ring. */
  strips: Point2D[][];
}

/**
 * Splits a rectangular ring into four mitred strips.
 *
 * Each strip runs between one outer edge and the inner edge facing it, and is
 * closed at both ends by the diagonal from the outer corner to the inner corner
 * beside it. Where the border is an even width those diagonals are at 45
 * degrees; where it is not they still meet cleanly, because both strips meeting
 * at a corner are cut on the same line.
 *
 * Returns null for anything that is not a rectangular ring. Declining is the
 * right answer for a round frame or an irregular outline: there is no corner to
 * mitre at, and guessing one puts a seam through the middle of a part.
 */
export function splitRectangularRing(outer: Point2D[], hole: Point2D[]): RingSplit | null {
  const o = ccw(dedupe(outer));
  const h = ccw(dedupe(hole));
  if (!isRectangle(o) || !isRectangle(h)) return null;

  /*
   * Pair each outer corner with the inner corner nearest it. Both loops are
   * rectangles wound the same way, so this is a rotation of one against the
   * other — matching by index alone would twist the strips into bow ties
   * whenever the two loops happened to start at different corners.
   */
  const pairing: number[] = [];
  for (let i = 0; i < 4; i++) {
    let best = 0;
    let bestD = Infinity;
    for (let j = 0; j < 4; j++) {
      const d = Math.hypot(o[i].x - h[j].x, o[i].y - h[j].y);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    pairing.push(best);
  }
  if (new Set(pairing).size !== 4) return null;

  /*
   * The hole has to be properly inside, with a real border on every side.
   * Without this a "ring" whose cutout runs out to an edge — which is what a
   * shelled box hands over — splits into strips of nothing, and one of them
   * comes back a bow tie.
   */
  const box = (pts: Point2D[]) => ({
    minX: Math.min(...pts.map((p) => p.x)),
    maxX: Math.max(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)),
    maxY: Math.max(...pts.map((p) => p.y)),
  });
  const bo = box(o);
  const bh = box(h);
  if (
    bh.minX - bo.minX < MIN_STRIP_MM ||
    bh.minY - bo.minY < MIN_STRIP_MM ||
    bo.maxX - bh.maxX < MIN_STRIP_MM ||
    bo.maxY - bh.maxY < MIN_STRIP_MM
  ) {
    return null;
  }

  /*
   * Fresh points, never the ones the loops are made of. Adjacent strips share
   * corners, and `normalizePanelBounds` shifts a panel's points in place — so
   * a shared vertex gets moved once per strip that references it, and the
   * geometry comes apart *after* the split, looking correct the moment it was
   * made. That is a bow tie in the finished cut and nothing upstream to blame.
   */
  const copy = (p: Point2D): Point2D => ({ x: p.x, y: p.y });

  const strips: Point2D[][] = [];
  for (let i = 0; i < 4; i++) {
    const strip = [o[i], at(o, i + 1), h[pairing[(i + 1) % 4]], h[pairing[i]]].map(copy);
    // A ring whose border is a hair wide is not four strips, it is swarf.
    if (Math.abs(signedArea(strip)) < MIN_STRIP_MM * MIN_STRIP_MM) return null;
    // A mitred length is a trapezoid, so it is convex. Anything that is not has
    // had its corners paired up wrongly and is a bow tie — a closed path that
    // crosses itself, which cuts as two triangles and a ruined part.
    if (!isConvex(strip)) return null;
    strips.push(strip);
  }
  return { strips };
}

/** Whether a panel fits any piece in the rack, at either rotation. */
export function fitsAnyStock(
  widthMm: number,
  heightMm: number,
  stock: StockItem[],
  thicknessMm: number,
  marginMm: number
): boolean {
  const w = widthMm + 2 * marginMm;
  const h = heightMm + 2 * marginMm;
  return stock.some(
    (s) =>
      Math.abs(s.thicknessMm - thicknessMm) < 1e-6 &&
      ((w <= s.widthMm && h <= s.heightMm) || (h <= s.widthMm && w <= s.heightMm))
  );
}

/**
 * Splices a length into pieces the rack can hold, or null when it already fits.
 *
 * The longest piece in the rack of this thickness sets the limit — measuring
 * against anything else would splice a length that a bar on the shelf could
 * have taken whole.
 */
function fitLength(
  strip: Point2D[],
  stock: StockItem[],
  thicknessMm: number,
  marginMm: number,
  kerfMm: number
): Point2D[][] | null {
  const longest = stock
    .filter((s) => Math.abs(s.thicknessMm - thicknessMm) < 1e-6)
    .reduce((best, s) => Math.max(best, s.widthMm, s.heightMm), 0);
  if (!(longest > 0)) return null;
  return splitLengthwise(strip, longest - 2 * marginMm, { kerfMm });
}

export interface SplitReport {
  panels: LaserPanel[];
  /** How many parts were divided, and what they became. */
  notes: string[];
}

/**
 * Divides panels the rack cannot cut whole.
 *
 * Only ever touches a panel that does not fit — a part that fits is left
 * exactly as it was, so switching the option on cannot quietly re-shape a job
 * that was already cuttable.
 */
export function splitPanelsToFit(
  panels: LaserPanel[],
  stock: StockItem[],
  thicknessOf: (panel: LaserPanel) => number,
  marginMm: number,
  kerfMm = 0
): SplitReport {
  const out: LaserPanel[] = [];
  const notes: string[] = [];

  for (const panel of panels) {
    const xs = panel.outerPolygon2D.map((p) => p.x);
    const ys = panel.outerPolygon2D.map((p) => p.y);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);

    if (fitsAnyStock(w, h, stock, thicknessOf(panel), marginMm)) {
      out.push(panel);
      continue;
    }

    const split =
      panel.innerCutouts2D.length === 1
        ? splitRectangularRing(panel.outerPolygon2D, panel.innerCutouts2D[0])
        : null;

    if (!split) {
      // Left whole and reported oversized downstream, which is what happened
      // before this existed. Better a part that plainly does not fit than a
      // seam this file invented.
      out.push(panel);
      continue;
    }

    /*
     * Mitring fixes the width. A length still wants stock as long as itself, so
     * anything still too long is spliced end to end — which is the case where
     * the offcuts are short rather than merely narrow.
     */
    let spliced = 0;
    split.strips.forEach((strip, i) => {
      const pieces = fitLength(strip, stock, thicknessOf(panel), marginMm, kerfMm) ?? [strip];
      if (pieces.length > 1) spliced += pieces.length;
      pieces.forEach((piece, j) => {
        out.push({
          ...panel,
          id: `${panel.id}_s${i + 1}${pieces.length > 1 ? `_${j + 1}` : ''}`,
          name: `${panel.name}_${i + 1}${pieces.length > 1 ? `${String.fromCharCode(97 + j)}` : ''}`,
          outerPolygon2D: piece,
          innerCutouts2D: [],
          // The lengths are coplanar with one another and joined by glue, so
          // there is no 3D adjacency for the joint engine to find.
          edges3D: [],
        } as LaserPanel);
      });
    });
    notes.push(
      `${panel.name} does not fit the rack whole, so it is cut as 4 mitred lengths ` +
        `glued at the corners. The assembled part is the same size as the model.` +
        (spliced
          ? ` The lengths are longer than the stock too, so they are spliced from ` +
            `${spliced} pieces joined by interlocking fingers.`
          : '')
    );
  }

  return { panels: out, notes };
}

// ---------------------------------------------------------------------------
// Splicing along the length
// ---------------------------------------------------------------------------
//
// Mitring a ring solves the *width* problem: four lengths, each no wider than
// the frame's border. It does nothing about *length* — a 300 mm side still
// wants a 300 mm piece of stock. Splicing is the other half: cut the length in
// two and join it end to end.
//
// The seam is a run of interlocking square fingers rather than a butt or a
// scarf. A butt has almost no glue area and no alignment; a scarf has plenty of
// both and eats length to get it — a 1:8 scarf on 20 mm stock is 160 mm of
// overlap, which is exactly the length short offcuts do not have. Fingers cost
// nothing in length, register the two halves against each other while the glue
// goes off, and cut with the same perpendicular pass as everything else.

/** Unit vector along a polygon's longest edge, which is its length. */
function longestAxis(poly: Point2D[]): { ux: number; uy: number } {
  let best = { ux: 1, uy: 0 };
  let bestLen = -1;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = at(poly, i + 1);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > bestLen) {
      bestLen = len;
      best = { ux: (b.x - a.x) / len, uy: (b.y - a.y) / len };
    }
  }
  return best;
}

/** Sutherland–Hodgman against the half-plane u <= c (or u >= c). */
function clipHalfPlane(
  poly: Point2D[],
  axis: { ux: number; uy: number },
  c: number,
  keepBelow: boolean
): Point2D[] {
  const u = (p: Point2D) => p.x * axis.ux + p.y * axis.uy;
  const inside = (p: Point2D) => (keepBelow ? u(p) <= c + 1e-9 : u(p) >= c - 1e-9);
  const out: Point2D[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = at(poly, i + 1);
    const ia = inside(a);
    const ib = inside(b);
    if (ia) out.push({ x: a.x, y: a.y });
    if (ia !== ib) {
      const ua = u(a);
      const ub = u(b);
      const t = (c - ua) / (ub - ua);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

/**
 * Replaces the straight seam edge of a clipped piece with a finger profile.
 *
 * Both halves are built from the same nominal wave — cell `k` sits at `c + d`
 * for one and the other recedes to exactly that line — so they interlock by
 * construction rather than by two calculations agreeing. Each is then pulled
 * back half a kerf from it, which is what leaves both halves the size they were
 * drawn once the cut has burnt its width away.
 */
function fingerSeam(
  piece: Point2D[],
  axis: { ux: number; uy: number },
  c: number,
  fingers: number,
  depthMm: number,
  kerfMm: number,
  male: boolean
): Point2D[] | null {
  const u = (p: Point2D) => p.x * axis.ux + p.y * axis.uy;
  const v = (p: Point2D) => -p.x * axis.uy + p.y * axis.ux;
  const onSeam = (p: Point2D) => Math.abs(u(p) - c) < 1e-6;

  // The seam is the one edge with both ends on the cut line.
  let seamAt = -1;
  for (let i = 0; i < piece.length; i++) {
    if (onSeam(piece[i]) && onSeam(at(piece, i + 1))) {
      seamAt = i;
      break;
    }
  }
  if (seamAt < 0) return null;

  const v0 = v(piece[seamAt]);
  const v1 = v(at(piece, seamAt + 1));
  const span = v1 - v0;
  // A finger narrower than the stock is thick has no strength across the grain.
  if (Math.abs(span) / fingers < MIN_STRIP_MM) return null;

  const toXY = (uu: number, vv: number): Point2D => ({
    x: uu * axis.ux - vv * axis.uy,
    y: uu * axis.uy + vv * axis.ux,
  });

  const step = span / fingers;
  const vdir = Math.sign(span) || 1;
  const half = kerfMm / 2;
  // Material lies on the low side of the seam for one half and the high side
  // for the other, so "pull back" is a different direction for each.
  const pull = male ? -half : half;
  /** Whether this half keeps the material in cell k. */
  const owns = (k: number) => (male ? k % 2 === 0 : k % 2 === 1);
  /*
   * Which way "protruding" points depends on which side of the seam this half's
   * material is. Reading it the same way round for both gave two halves that
   * each claimed the cells they owned *and* the cells they did not — they
   * overlapped along the whole seam and their areas summed to more than the
   * length they came from.
   */
  const dir = male ? 1 : -1;
  const uOf = (k: number) => c + dir * (owns(k) ? depthMm : -depthMm) + pull;

  /*
   * Where one cell gives way to the next, nudged toward whichever of the two
   * this half owns — narrowing its own finger by half a kerf on each side, and
   * widening the socket beside it by the same, so the pair still closes.
   */
  const breakAt = (k: number) => v0 + step * k + (owns(k) ? half : -half) * vdir;

  const wave: Point2D[] = [];
  for (let k = 0; k < fingers; k++) {
    const uk = uOf(k);
    wave.push(toXY(uk, k === 0 ? v0 : breakAt(k)));
    wave.push(toXY(uk, k === fingers - 1 ? v1 : breakAt(k + 1)));
  }

  /*
   * Both ends of the straight seam are dropped, not kept either side of the
   * wave. They sit on the nominal cut line, and the wave already carries the
   * seam's own end faces at v0 and v1 — keeping them too leaves the outline
   * running out to the bare cut line and back at each end of the joint, which
   * is a small spike at the root of the first and last finger.
   */
  const n = piece.length;
  const rebuilt: Point2D[] = [];
  if (seamAt + 1 < n) {
    for (let i = 0; i < seamAt; i++) rebuilt.push(piece[i]);
    for (const p of wave) rebuilt.push(p);
    for (let i = seamAt + 2; i < n; i++) rebuilt.push(piece[i]);
  } else {
    // The seam edge wraps the end of the list, so it is the last vertex and the
    // first that go.
    for (const p of wave) rebuilt.push(p);
    for (let i = 1; i < n - 1; i++) rebuilt.push(piece[i]);
  }
  return dedupe(rebuilt, 1e-6);
}

/**
 * Cuts a length into pieces that fit, spliced end to end.
 *
 * Returns null when it is already short enough, or when the shape is not one
 * this can divide honestly — a cut that cannot be made cleanly is better
 * reported as a part that does not fit than emitted as geometry nobody checked.
 */
export function splitLengthwise(
  poly: Point2D[],
  maxLengthMm: number,
  opts: { fingers?: number; depthMm?: number; kerfMm?: number } = {}
): Point2D[][] | null {
  const axis = longestAxis(poly);
  const u = (p: Point2D) => p.x * axis.ux + p.y * axis.uy;
  const us = poly.map(u);
  const lo = Math.min(...us);
  const hi = Math.max(...us);
  const length = hi - lo;
  if (!(length > maxLengthMm)) return null;

  const fingers = Math.max(3, Math.round(opts.fingers ?? 5));
  const kerfMm = opts.kerfMm ?? 0;

  /*
   * Fingers reach *past* the line they are cut on, so a piece is longer than
   * the segment it was cut from. Sizing segments off the raw length ignored
   * that and handed back pieces longer than the stock they were cut to fit.
   *
   * Rather than shrink the segments — which costs a whole extra piece to buy
   * room most of them do not need — take the fewest pieces the length actually
   * needs and let what is left over decide how deep the fingers can be. Halved,
   * because a piece in the middle of a run has a seam at both ends.
   */
  let pieces = Math.ceil(length / maxLengthMm);
  let depthMm = 0;
  for (; pieces <= Math.ceil(length / MIN_STRIP_MM); pieces++) {
    const room = maxLengthMm - length / pieces;
    depthMm = Math.min(opts.depthMm ?? maxLengthMm / 10, room / 2);
    // A finger shallower than a millimetre is a scratch, not a joint.
    if (depthMm >= 1) break;
  }
  if (!(depthMm >= 1)) return null;

  let remaining = poly;
  const out: Point2D[][] = [];
  for (let i = 1; i < pieces; i++) {
    const c = lo + (length * i) / pieces;
    const left = clipHalfPlane(remaining, axis, c, true);
    const right = clipHalfPlane(remaining, axis, c, false);
    if (left.length < 3 || right.length < 3) return null;
    const maleHalf = fingerSeam(left, axis, c, fingers, depthMm, kerfMm, true);
    const femaleHalf = fingerSeam(right, axis, c, fingers, depthMm, kerfMm, false);
    if (!maleHalf || !femaleHalf) return null;
    out.push(maleHalf);
    remaining = femaleHalf;
  }
  out.push(remaining);
  return out;
}
