// ---------------------------------------------------------------------------
// Laser Cut Face Unwrapping & SVG Export Engine
// ---------------------------------------------------------------------------

import type { SceneGraph, SceneNode, SceneGeom } from '../types/scene';
import { csgSourceGeoms, fromtoFrame } from './csg';
import * as THREE from 'three';
import { splitPanelsToFit } from './panelSplitter';
import { appendBaseGeomTriangles, texturedSurfaceOf } from './geomSurface';
import { reliefContours } from './patternEngrave';
import { isBoughtIn } from './boughtIn';
import { isNodeRotationBaked } from './sceneTree';
import { HARDWARE_KINDS } from './hardwareCuts';
import { tapDrillRadius } from './metricThreads';
import { SHEET_MARGIN } from './sheetCutRecipe';

export interface LaserCutOptions {
  jointMode: 'finger' | 'slot' | 'glue';
  materialThickness: number; // in meters (default 0.003 = 3mm)
  /**
   * Nominal width of one finger along the joint, in meters.
   *
   * Only read when `fingerWidthAuto` is off. Left automatic it is derived from
   * the stock — see `derivedFingerWidthMm`.
   */
  fingerWidth: number;
  /**
   * Derive the finger width from the material thickness instead of using the
   * number above. On by default.
   *
   * A fixed width cannot be right across the range: 10 mm fingers are sensible
   * in 3 mm ply and far too narrow in 18 mm, where each finger is barely wider
   * than the material is thick and snaps across the grain. The override stays
   * because a specific box sometimes wants a specific tooth count — but nobody
   * should have to know the rule to get a sound joint.
   */
  fingerWidthAuto: boolean;
  /**
   * Extra tab length beyond flush, in meters. At 0 a tab finishes level with the
   * mating panel's outer face. Raising it pushes tabs proud, which gives a small
   * part more to grip than its own thickness allows.
   */
  tabOverhang: number;
  /**
   * Fit adjustment across the width of every finger, in meters. 0 cuts them to
   * nominal size. Negative makes tabs wider than their slots for a press fit —
   * the lever for small parts that need to grip. Positive leaves clearance.
   */
  jointClearance: number;
  kerf: number;              // in meters (default 0.00015 = 0.15mm)
  /**
   * Inside-corner relief for CNC routing. A round end mill cannot cut a sharp
   * inside corner, so it leaves a radius that stops a tab entering its slot.
   * 'dogbone' overcuts along the corner bisector — smallest bite, but visible
   * at the corner. 'tbone' hides the same overcut in the longer wall, leaving
   * the mating face flat, which is what you want on a visible joint. 'none' is
   * correct for a laser, which cuts genuinely sharp corners.
   */
  cornerRelief: 'none' | 'dogbone' | 'tbone';
  /** End mill diameter, in meters. Only read when cornerRelief is not 'none'. */
  bitDiameter: number;
  sheetWidth: number;        // in meters (default 0.600 = 600mm)
  sheetHeight: number;       // in meters (default 0.400 = 400mm)
  margin: number;            // in meters (default 0.008 = 8mm)
  /** Distance the cutter's outer edge stands outside each part's outline, in meters (bitDiameter on CNC, 0 on laser). */
  cutOutset?: number;
  scaleFactor?: number;      // scale factor (default 1.0 = 100%)
  autoScale?: boolean;        // automatically scale down cuts to fit sheet/sheet limit
  maxSheets?: number;        // maximum allowed sheets (0 = unlimited)
  /** Engrave each panel's name, and caption each sheet. */
  includeLabels: boolean;
  /** Draw the dashed sheet boundaries. Off leaves nothing but cut paths. */
  includeSheetOutline: boolean;
  /**
   * The stock actually available, when it is more than one size.
   *
   * Left undefined — which is the ordinary case and every existing caller — the
   * inventory is a single unlimited item built from `sheetWidth`,
   * `sheetHeight` and `materialThickness`, and everything behaves exactly as it
   * did. Listing pieces here is how you say "this is what I have in the rack",
   * which is what makes a job bigger than the machine cuttable at all.
   */
  stock?: StockItem[];
  /**
   * Cut a part from stock thinner than it was drawn.
   *
   * Off, and it is an error rather than a warning. This is a modelling app: a
   * panel's thickness is a dimension of a physical object, not a hint. Cut an
   * 8 mm plate from 6 mm and it keeps barely half its stiffness in bending —
   * thickness enters that as a square — and it may simply not fit the slot,
   * rebate or mortise something else in the model presents to it.
   *
   * What makes it worth refusing rather than warning is that nothing about the
   * result looks wrong: joints are sized from the stock, so the thin part fits
   * its neighbours perfectly and assembles exactly as drawn. The only evidence
   * is a number nobody re-checks. Turning this on is how you say you know.
   */
  allowThinnerStock?: boolean;
  /**
   * Cut a part the rack cannot hold whole as several pieces, joined.
   *
   * Off by default. It turns one part into four that have to be glued up, which
   * is a change to the object rather than to how it is cut — so it is never
   * done on the app's own initiative, only when a part would otherwise be
   * reported oversized and you have said you would rather join it.
   *
   * See `panelSplitter.ts`. A part that already fits is never touched.
   */
  splitOversized?: boolean;
}

/** One size of stock in the rack, and how much of it there is. */
export interface StockItem {
  widthMm: number;
  heightMm: number;
  thicknessMm: number;
  /** How many pieces. `null` means as many as needed — a size you can buy. */
  quantity: number | null;
}

export const DEFAULT_LASER_OPTIONS: LaserCutOptions = {
  jointMode: 'finger',
  materialThickness: 0.003,
  fingerWidth: 0.010,
  fingerWidthAuto: true,
  tabOverhang: 0,
  jointClearance: 0,
  kerf: 0.00015,
  cornerRelief: 'none',
  bitDiameter: 0.003175, // 1/8"
  sheetWidth: 0.600,
  sheetHeight: 0.400,
  margin: SHEET_MARGIN,
  scaleFactor: 1.0,
  autoScale: false,
  maxSheets: 0,
  includeLabels: true,
  includeSheetOutline: true,
};

export interface Point2D {
  x: number;
  y: number;
}

export interface Point3D {
  x: number;
  y: number;
  z: number;
}

export interface LaserPanelEdge {
  p1: Point3D;
  p2: Point3D;
  sharedPanelId?: string;
  isMaleTab?: boolean;
}

export interface BlindPocket2D {
  /** Outer perimeter of the pocket in the panel's local 2D mm frame. */
  outer: Point2D[];
  /** Solid raised islands inside the pocket that the cutter must avoid. */
  holes?: Point2D[][];
  /** Depth of the pocket floor measured from the panel face (mm, < thickness * 1000). */
  depthMm: number;
  /** True when the pocket sits on the underside face (-normal3D) of a double-pocketed panel. */
  under?: boolean;
}

export interface LaserPanel {
  id: string;
  name: string;
  thickness: number;
  origin3D: Point3D;
  normal3D: Point3D;
  uAxis3D: Point3D;
  vAxis3D: Point3D;
  // 2D boundary polygon points (in local mm coordinates)
  outerPolygon2D: Point2D[];
  // 2D interior cutout loops (holes, e.g. entrance hole, interior mortise slots)
  innerCutouts2D: Point2D[][];
  /**
   * Partial-depth blind pockets/steps recovered from mesh geometry, machined to
   * `depthMm` in CNC mode and emitted on `data-operation="fill"` in SVG.
   */
  blindPockets2D?: BlindPocket2D[];
  /** True when the panel carries blind pockets on both faces so underside ones need a flip. */
  blindPocketsUnderside?: boolean;
  /**
   * Lines to engrave rather than cut: the outlines of a surface pattern laid
   * on this panel's face (see utils/patternEngrave), open polylines in the
   * same local mm frame as the loops above.
   */
  engrave2D?: Point2D[][];
  /**
   * Patterns on both faces: only the upper one can be engraved as cut, so the
   * other is engraved on the top too and the panel is turned over for it.
   */
  engraveUnderside?: boolean;
  /** Cut face down, because its only pattern is on the face that would lie on the bed. */
  cutFaceDown?: boolean;
  // 3D edge information for joint matching
  edges3D: LaserPanelEdge[];
  /**
   * Translation that was subtracted from the 2D loops to move the panel into
   * sheet space. Add it back to recover model-space (u, v) coordinates.
   */
  modelOffset2D?: Point2D;
  // Final placed 2D position, in the coordinates of its own sheet: every sheet
  // is loaded against the same machine zero, so this is what the cut actually
  // runs at. Which sheet it belongs to is `sheetIndex`; only the combined SVG
  // adds that back as a y offset to stack the sheets down one drawing.
  placedPos2D?: Point2D;
  /** Which sheet of stock this panel is nested on, counting from 0. */
  sheetIndex?: number;
  /**
   * The packer turned the loops a quarter turn to fit the stock (see
   * `rotatePanel90`). The 3D frame is not turned with them, so undoing this is
   * how a loop point goes back to the panel's place in the model.
   */
  turnedOnSheet?: boolean;
  /** The panel this piece was split from, whose stock it is cut from. */
  splitFrom?: string;
  width2D?: number;
  height2D?: number;
}

/** One sheet of the finished cut: which stock it is, and how big. */
export interface SheetSpec {
  widthMm: number;
  heightMm: number;
  thicknessMm: number;
}

export interface LaserCutResult {
  success: boolean;
  svg?: string;
  panels?: LaserPanel[];
  sheetCount?: number;
  /**
   * The sheets in order, each with its own size and thickness. With one stock
   * size they are all identical; with a mixed rack they are not, which is why
   * the caller cannot infer them from a single sheet dimension any more.
   */
  sheets?: SheetSpec[];
  scaleFactor?: number;
  error?: string;
  /** Panels short of a margin on both sides of their sheet. */
  oversized?: string[];
  /** Panels that run past the far edge of the sheet, placed one margin in. They must not be cut. */
  offSheet?: string[];
  /**
   * Non-fatal notes about the cut: panels that got no joints because nothing
   * butts against them, or joints the chosen mode could not express. These need
   * glue or a model change, so they are worth showing rather than swallowing.
   */
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Matrix & Geometry Helpers
// ---------------------------------------------------------------------------

function quatToMatrix4(q: number[]): THREE.Matrix4 {
  const t = new THREE.Quaternion(q[1] || 0, q[2] || 0, q[3] || 0, q[0] ?? 1).normalize();
  return new THREE.Matrix4().makeRotationFromQuaternion(t);
}

function eulerToMatrix4(e: number[]): THREE.Matrix4 {
  const rx = new THREE.Matrix4().makeRotationX((e[0] || 0) * THREE.MathUtils.DEG2RAD);
  const ry = new THREE.Matrix4().makeRotationY((e[1] || 0) * THREE.MathUtils.DEG2RAD);
  const rz = new THREE.Matrix4().makeRotationZ((e[2] || 0) * THREE.MathUtils.DEG2RAD);
  return rx.multiply(ry).multiply(rz);
}

export function getNodeWorldTransform(node: SceneNode, parentMatrix?: THREE.Matrix4): THREE.Matrix4 {
  // A mesh body whose rotation was baked into its vertices keeps its euler for
  // the inspector, but its frame has no rotation (mjcf.ts emits none), so
  // applying it here would turn the vertices a second time.
  const m = isNodeRotationBaked(node)
    ? new THREE.Matrix4()
    : node.quat
    ? quatToMatrix4(node.quat)
    : node.euler
      ? eulerToMatrix4(node.euler)
      : new THREE.Matrix4();
  const p = node.pos || [0, 0, 0];
  m.setPosition(p[0] || 0, p[1] || 0, p[2] || 0);

  if (parentMatrix) {
    return new THREE.Matrix4().multiplyMatrices(parentMatrix, m);
  }
  return m;
}

/**
 * A geom's own frame plus, for cylinders and capsules, its half-length along
 * local +Z. A `fromto` pair supersedes pos/quat/euler and size[1] entirely —
 * the same precedence src/utils/csg.ts applies when it emits the solid, so a
 * hole cuts where the CSG evaluator actually put it.
 */
export function getGeomFrame(geom: SceneGeom): { matrix: THREE.Matrix4; halfLen?: number } {
  if (geom.fromto && geom.fromto.length >= 6 && (geom.type === 'cylinder' || geom.type === 'capsule')) {
    const f = fromtoFrame(geom.fromto);
    return { matrix: f.matrix, halfLen: f.halfLen };
  }
  const m = geom.quat
    ? quatToMatrix4(geom.quat)
    : geom.euler
      ? eulerToMatrix4(geom.euler)
      : new THREE.Matrix4();
  const p = geom.pos || [0, 0, 0];
  m.setPosition(p[0] || 0, p[1] || 0, p[2] || 0);
  return { matrix: m };
}

function getGeomTransform(geom: SceneGeom, bodyMatrix: THREE.Matrix4): THREE.Matrix4 {
  return new THREE.Matrix4().multiplyMatrices(bodyMatrix, getGeomFrame(geom).matrix);
}

/** Y-up (three.js) vertex array to the Z-up space that pos/euler/size use. */
export function yupVertsToZup(v: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < v.length; i += 3) out.push(v[i], -v[i + 2], v[i + 1]);
  return out;
}

function pointInPolygon2D(poly: Point2D[], pt: Point2D): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) &&
        pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Panel names come from user-edited scene data, so they cannot go in raw. */
function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] as string
  ));
}

function polygonArea(pts: Point2D[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % pts.length];
    a += p1.x * p2.y - p2.x * p1.y;
  }
  return Math.abs(a / 2);
}

function polygonSignedArea(pts: Point2D[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % pts.length];
    a += p1.x * p2.y - p2.x * p1.y;
  }
  return a / 2;
}

/**
 * Simplifies a 2D polygon by collapsing colinear sub-segments.
 * Eliminates micro-step staircase patterns along polygon edges.
 *
 * Each point's turn is measured from the last point kept, not from its
 * neighbour in the input. Measured from the neighbour, a fine arc whose every
 * step turns less than the tolerance lost all of its points and came out as
 * one straight chord. Exported for tests.
 */
export function simplifyPolygon2D(pts: Point2D[], tolDegrees: number = 2.0): Point2D[] {
  if (pts.length <= 3) return pts;

  // 1. Remove duplicate adjacent vertices
  const cleaned: Point2D[] = [];
  for (let i = 0; i < pts.length; i++) {
    const next = pts[(i + 1) % pts.length];
    if (Math.hypot(pts[i].x - next.x, pts[i].y - next.y) > 0.05) {
      cleaned.push(pts[i]);
    }
  }

  if (cleaned.length <= 3) return cleaned;

  // 2. Collapse colinear intermediate points
  const result: Point2D[] = [];
  const cosTol = Math.cos(tolDegrees * THREE.MathUtils.DEG2RAD);

  for (let i = 0; i < cleaned.length; i++) {
    const prev = result.length > 0 ? result[result.length - 1] : cleaned[cleaned.length - 1];
    const curr = cleaned[i];
    const next = cleaned[(i + 1) % cleaned.length];

    const v1x = curr.x - prev.x;
    const v1y = curr.y - prev.y;
    const len1 = Math.hypot(v1x, v1y);

    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    const len2 = Math.hypot(v2x, v2y);

    if (len1 < 1e-4 || len2 < 1e-4) continue;

    const dot = (v1x * v2x + v1y * v2y) / (len1 * len2);

    // If angle change is nearly 0 (colinear segment), skip intermediate point `curr`
    if (dot > cosTol) {
      continue;
    }

    result.push(curr);
  }

  return result.length >= 3 ? result : pts;
}

/**
 * Ramer–Douglas–Peucker simplification of a closed loop.
 *
 * `simplifyPolygon2D` only removes points that are already colinear, so it
 * leaves quantised CSG output as a visible staircase. This removes any run of
 * points that never strays further than `tolMm` from its own chord, which
 * collapses those steps into the straight line they are approximating. The
 * tolerance is well below a laser's own precision, so nothing real is lost.
 */
function simplifyPolyline2D(pts: Point2D[], tolMm: number): Point2D[] {
  if (pts.length <= 4) return pts;

  const perpDist = (p: Point2D, a: Point2D, b: Point2D): number => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
    return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
  };

  const keep = new Uint8Array(pts.length);

  const rdp = (first: number, last: number) => {
    if (last <= first + 1) return;
    let worst = -1;
    let worstDist = tolMm;
    for (let i = first + 1; i < last; i++) {
      const d = perpDist(pts[i], pts[first], pts[last]);
      if (d > worstDist) {
        worstDist = d;
        worst = i;
      }
    }
    if (worst < 0) return;
    keep[worst] = 1;
    rdp(first, worst);
    rdp(worst, last);
  };

  // Split the closed loop at two far-apart anchors so both arcs are simplified.
  let anchor = 0;
  let bestD = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[0].x, pts[i].y - pts[0].y);
    if (d > bestD) {
      bestD = d;
      anchor = i;
    }
  }

  keep[0] = 1;
  keep[anchor] = 1;
  rdp(0, anchor);
  rdp(anchor, pts.length - 1);
  keep[pts.length - 1] = 1;

  const out = pts.filter((_, i) => keep[i]);
  return out.length >= 3 ? out : pts;
}

/**
 * Chains 2D undirected edges into closed boundary loops.
 *
 * Each edge is tracked by index and consumed exactly once. Storing an edge as
 * two independent half-entries instead lets the walk immediately step back the
 * way it came, so every loop closes after two points and gets discarded.
 */
function chainBoundaryLoops2D(edges: { p1: Point2D; p2: Point2D }[]): Point2D[][] {
  if (edges.length === 0) return [];

  const key = (p: Point2D) => `${Math.round(p.x * 100) / 100},${Math.round(p.y * 100) / 100}`;

  const adj = new Map<string, number[]>();
  for (let i = 0; i < edges.length; i++) {
    for (const p of [edges[i].p1, edges[i].p2]) {
      const k = key(p);
      if (!adj.has(k)) adj.set(k, []);
      adj.get(k)!.push(i);
    }
  }

  const used = new Array<boolean>(edges.length).fill(false);
  const loops: Point2D[][] = [];

  for (let start = 0; start < edges.length; start++) {
    if (used[start]) continue;

    used[start] = true;
    const startKey = key(edges[start].p1);
    const loop: Point2D[] = [edges[start].p1];
    let current = edges[start].p2;

    for (let guard = 0; guard <= edges.length; guard++) {
      if (key(current) === startKey) break; // loop closed
      loop.push(current);

      const currentKey = key(current);
      let nextIdx = -1;
      for (const ei of adj.get(currentKey) || []) {
        if (!used[ei]) {
          nextIdx = ei;
          break;
        }
      }
      if (nextIdx < 0) break; // open chain

      used[nextIdx] = true;
      const e = edges[nextIdx];
      current = key(e.p1) === currentKey ? e.p2 : e.p1;
    }

    if (loop.length >= 3) loops.push(loop);
  }

  loops.sort((a, b) => polygonArea(b) - polygonArea(a));
  return loops;
}

const CUTOUT_ARC_STEPS = 48;
/** How far a cutter has to be into, or short of, a sheet's skin to count, in m. */
const SHEET_TOUCH_M = 1e-5;

/** Andrew's monotone chain. Returns a CCW hull with colinear points dropped. */
function convexHull2D(pts: Point2D[]): Point2D[] {
  if (pts.length < 3) return pts.slice();

  const sorted = pts.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
  const cross = (o: Point2D, a: Point2D, b: Point2D) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const half = (src: Point2D[]) => {
    const out: Point2D[] = [];
    for (const p of src) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 1e-9) out.pop();
      out.push(p);
    }
    out.pop(); // shared with the other half
    return out;
  };

  const hull = half(sorted).concat(half(sorted.reverse()));
  return hull.length >= 3 ? hull : pts.slice();
}

function ensureCW(pts: Point2D[]): Point2D[] {
  return polygonSignedArea(pts) > 0 ? [...pts].reverse() : pts;
}

/** Drops strictly collinear intermediate split points without altering curved facets. */
function dropCollinearVertices2D(loop: Point2D[]): Point2D[] {
  let pts = loop.slice();
  let changed = true;
  while (changed && pts.length >= 3) {
    changed = false;
    const nextPts: Point2D[] = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[(i - 1 + n) % n];
      const b = pts[i];
      const c = pts[(i + 1) % n];
      const ux = b.x - a.x, uy = b.y - a.y;
      const vx = c.x - b.x, vy = c.y - b.y;
      const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
      if (lu < 1e-5) { changed = true; continue; }
      if (lv < 1e-5) continue;
      const sinTurn = Math.abs(ux * vy - uy * vx) / (lu * lv);
      const dot = (ux * vx + uy * vy) / (lu * lv);
      // Drop pure collinear splits (dot > 0, sin < 1e-5) and zero-area hairpins (dot < -0.99999).
      if ((dot > 0 && sinTurn < 1e-5) || dot < -0.99999) {
        changed = true;
        continue;
      }
      nextPts.push(b);
    }
    pts = nextPts;
  }
  return pts;
}

/** Odd-even membership in a planar region represented by non-crossing loops. */
function pointInRegion2D(pt: Point2D, loops: Point2D[][]): boolean {
  let inside = false;
  for (const l of loops) {
    if (l.length >= 3 && pointInPolygon2D(l, pt)) inside = !inside;
  }
  return inside;
}

/** True if two closed loops cross, touch, or share boundary segments within `epsMm`. */
function loopsTouchOrCross2D(a: Point2D[], b: Point2D[], epsMm = 1e-3): boolean {
  for (let i = 0; i < a.length; i++) {
    const a0 = a[i], a1 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const b0 = b[j], b1 = b[(j + 1) % b.length];
      if (segmentSegmentDist(a0, a1, b0, b1) <= epsMm) return true;
    }
  }
  return false;
}

/**
 * Exact 2D planar region boolean arrangement: splits all input segments at
 * mutual crossings and collinear overlaps, filters sub-segments by `inTarget`
 * on left vs right, and chains surviving directed boundary edges into loops.
 */
function booleanArrangeLoops2D(
  seedLoops: Point2D[][],
  inTarget: (pt: Point2D) => boolean
): { outers: Point2D[][]; holes: Point2D[][] } {
  const segs: { a: Point2D; b: Point2D }[] = [];
  for (const loop of seedLoops) {
    if (loop.length < 3) continue;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      if (Math.hypot(b.x - a.x, b.y - a.y) > 1e-6) segs.push({ a, b });
    }
  }
  if (segs.length === 0) return { outers: [], holes: [] };

  const PARAM_EPS = 1e-8;
  const COLLINEAR_TOL = 1e-4;
  const cuts: number[][] = segs.map(() => []);

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const sx = s.b.x - s.a.x, sy = s.b.y - s.a.y;
    const sMinX = Math.min(s.a.x, s.b.x) - COLLINEAR_TOL;
    const sMaxX = Math.max(s.a.x, s.b.x) + COLLINEAR_TOL;
    const sMinY = Math.min(s.a.y, s.b.y) - COLLINEAR_TOL;
    const sMaxY = Math.max(s.a.y, s.b.y) + COLLINEAR_TOL;
    const sLen2 = sx * sx + sy * sy;
    if (sLen2 < 1e-12) continue;

    for (let j = 0; j < segs.length; j++) {
      if (j === i) continue;
      const o = segs[j];
      if (
        Math.max(o.a.x, o.b.x) < sMinX ||
        Math.min(o.a.x, o.b.x) > sMaxX ||
        Math.max(o.a.y, o.b.y) < sMinY ||
        Math.min(o.a.y, o.b.y) > sMaxY
      ) {
        continue;
      }
      const ox = o.b.x - o.a.x, oy = o.b.y - o.a.y;
      const den = sx * oy - sy * ox;
      if (Math.abs(den) < 1e-10 * Math.sqrt(sLen2 * (ox * ox + oy * oy))) {
        const perp = Math.abs((o.a.x - s.a.x) * sy - (o.a.y - s.a.y) * sx) / Math.sqrt(sLen2);
        if (perp <= COLLINEAR_TOL) {
          for (const end of [o.a, o.b]) {
            const t = ((end.x - s.a.x) * sx + (end.y - s.a.y) * sy) / sLen2;
            if (t > PARAM_EPS && t < 1 - PARAM_EPS) cuts[i].push(t);
          }
        }
        continue;
      }
      const dx = o.a.x - s.a.x, dy = o.a.y - s.a.y;
      const t = (dx * oy - dy * ox) / den;
      const u = (dx * sy - dy * sx) / den;
      if (t > PARAM_EPS && t < 1 - PARAM_EPS && u >= -1e-6 && u <= 1 + 1e-6) {
        cuts[i].push(t);
      }
    }
  }

  // Weld split vertices within 1e-4 mm so intersection endpoints match identically.
  const WELD_MM = 1e-4;
  const CELL_MM = 1e-3;
  const verts: Point2D[] = [];
  const buckets = new Map<string, number[]>();
  const weldVertex = (p: Point2D): number => {
    const gx = Math.floor(p.x / CELL_MM);
    const gy = Math.floor(p.y / CELL_MM);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = buckets.get(`${gx + dx},${gy + dy}`);
        if (!list) continue;
        for (const id of list) {
          if (Math.hypot(verts[id].x - p.x, verts[id].y - p.y) <= WELD_MM) return id;
        }
      }
    }
    const id = verts.length;
    verts.push({ x: p.x, y: p.y });
    const k = `${gx},${gy}`;
    const list = buckets.get(k);
    if (list) list.push(id);
    else buckets.set(k, [id]);
    return id;
  };

  const edgeSet = new Set<string>();
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const ts = cuts[i];
    ts.sort((a, b) => a - b);
    let prevT = 0;
    const ptAt = (t: number): Point2D => ({
      x: s.a.x + (s.b.x - s.a.x) * t,
      y: s.a.y + (s.b.y - s.a.y) * t,
    });
    const stops = ts.length ? [...ts, 1] : [1];
    for (const t of stops) {
      if (t - prevT <= PARAM_EPS) continue;
      const uId = weldVertex(ptAt(prevT));
      const vId = weldVertex(ptAt(t));
      prevT = t;
      if (uId === vId) continue;
      const u = verts[uId], v = verts[vId];
      const dx = v.x - u.x, dy = v.y - u.y;
      const len = Math.hypot(dx, dy);
      if (len < WELD_MM) continue;
      const mx = (u.x + v.x) / 2, my = (u.y + v.y) / 2;
      const nx = -dy / len, ny = dx / len;
      const eps = Math.min(2e-3, len * 0.25);
      const leftIn = inTarget({ x: mx + nx * eps, y: my + ny * eps });
      const rightIn = inTarget({ x: mx - nx * eps, y: my - ny * eps });
      if (leftIn === rightIn) continue;
      const from = leftIn ? uId : vId;
      const to = leftIn ? vId : uId;
      const revKey = `${to}->${from}`;
      if (edgeSet.has(revKey)) {
        edgeSet.delete(revKey);
      } else {
        edgeSet.add(`${from}->${to}`);
      }
    }
  }

  const dirEdges: { from: number; to: number }[] = [];
  const outgoing = new Map<number, number[]>();
  for (const key of edgeSet) {
    const sep = key.indexOf('->');
    const from = Number(key.slice(0, sep));
    const to = Number(key.slice(sep + 2));
    const idx = dirEdges.length;
    dirEdges.push({ from, to });
    const list = outgoing.get(from);
    if (list) list.push(idx);
    else outgoing.set(from, [idx]);
  }

  const used = new Uint8Array(dirEdges.length);
  const rawLoops: Point2D[][] = [];
  for (let start = 0; start < dirEdges.length; start++) {
    if (used[start]) continue;
    used[start] = 1;
    const startVert = dirEdges[start].from;
    let prevVert = startVert;
    let curVert = dirEdges[start].to;
    const pts: Point2D[] = [{ ...verts[startVert] }];

    for (let guard = 0; guard <= dirEdges.length; guard++) {
      if (curVert === startVert) break;
      pts.push({ ...verts[curVert] });
      const candidates = (outgoing.get(curVert) ?? []).filter((ei) => !used[ei]);
      if (candidates.length === 0) { pts.length = 0; break; }
      let chosen = candidates[0];
      if (candidates.length > 1) {
        const backAng = Math.atan2(
          verts[prevVert].y - verts[curVert].y,
          verts[prevVert].x - verts[curVert].x
        );
        let bestDelta = Infinity;
        for (const ei of candidates) {
          const nxt = dirEdges[ei].to;
          const outAng = Math.atan2(
            verts[nxt].y - verts[curVert].y,
            verts[nxt].x - verts[curVert].x
          );
          let delta = (outAng - backAng) % (Math.PI * 2);
          if (delta < 0) delta += Math.PI * 2;
          if (delta < 1e-9) delta = Math.PI * 2;
          if (delta < bestDelta) {
            bestDelta = delta;
            chosen = ei;
          }
        }
      }
      used[chosen] = 1;
      prevVert = curVert;
      curVert = dirEdges[chosen].to;
    }

    const cleaned = dropCollinearVertices2D(pts);
    if (cleaned.length >= 3 && polygonArea(cleaned) > 1e-4) {
      rawLoops.push(cleaned);
    }
  }

  // Classify loops by nesting depth using an interior sample point on the left of edge 0.
  const interiorSample = (loop: Point2D[]): Point2D => {
    const a = loop[0], b = loop[1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const eps = Math.min(1e-3, len * 0.2);
    const sign = polygonSignedArea(loop) >= 0 ? 1 : -1;
    return {
      x: (a.x + b.x) / 2 + sign * (-dy / len) * eps,
      y: (a.y + b.y) / 2 + sign * (dx / len) * eps,
    };
  };

  const outers: Point2D[][] = [];
  const holes: Point2D[][] = [];
  for (let i = 0; i < rawLoops.length; i++) {
    // Signed area immediately distinguishes outer boundaries (CCW > 0, material on left)
    // from holes (CW < 0, material on left outside the hole).
    if (polygonSignedArea(rawLoops[i]) > 0) {
      outers.push(ensureCCW(rawLoops[i]));
    } else {
      // Confirm it sits inside at least one outer loop.
      const sample = interiorSample(rawLoops[i]);
      let depth = 0;
      for (let j = 0; j < rawLoops.length; j++) {
        if (j !== i && polygonSignedArea(rawLoops[j]) > 0 && pointInPolygon2D(rawLoops[j], sample)) {
          depth++;
        }
      }
      if (depth > 0) holes.push(ensureCW(rawLoops[i]));
    }
  }
  outers.sort((a, b) => polygonArea(b) - polygonArea(a));
  return { outers, holes };
}

/** Boolean union of multiple 2D regions, returning `[outerCCW, ...holesCW][]`. */
function unionRegions2D(regions: Point2D[][][]): Point2D[][][] {
  const valid = regions.filter((r) => r.length > 0);
  if (valid.length === 0) return [];
  const orientRegion = (loops: Point2D[][]): Point2D[][] => {
    if (loops.length === 0) return [];
    const sorted = [...loops].sort((a, b) => polygonArea(b) - polygonArea(a));
    return sorted.map((l, idx) => (idx === 0 ? ensureCCW(l) : ensureCW(l)));
  };
  const oriented = valid.map(orientRegion);
  const res = booleanArrangeLoops2D(
    oriented.flat(),
    (pt) => oriented.some((reg) => pointInRegion2D(pt, reg))
  );
  if (res.outers.length === 0) return [];
  const grouped: Point2D[][][] = res.outers.map((o) => [o]);
  for (const h of res.holes) {
    // Attach each hole to the smallest outer loop that contains it.
    let bestIdx = -1;
    let bestArea = Infinity;
    for (let i = 0; i < res.outers.length; i++) {
      if (pointInPolygon2D(res.outers[i], h[0])) {
        const a = polygonArea(res.outers[i]);
        if (a < bestArea) {
          bestArea = a;
          bestIdx = i;
        }
      }
    }
    if (bestIdx >= 0) grouped[bestIdx].push(h);
  }
  return grouped;
}

/**
 * Subtracts 2D cutout regions from `(outerPolygon2D, existingHoles)`.
 *
 * - Isolated interior cutouts that do not touch the outer boundary, existing holes,
 *   or one another keep their exact unperturbed vertex loops (fast path).
 * - Cutouts that straddle `outerPolygon2D` become clean perimeter notches on
 *   `outerPolygon2D`, and overlapping interior cutouts union into non-overlapping holes.
 */
function subtractCutoutsFromPanel2D(
  outerPolygon2D: Point2D[],
  existingHoles: Point2D[][],
  cutoutRegions: Point2D[][][]
): { outer: Point2D[]; holes: Point2D[][] } {
  if (cutoutRegions.length === 0 || outerPolygon2D.length < 3) {
    return { outer: outerPolygon2D, holes: existingHoles };
  }

  const baseOuter = ensureCCW(outerPolygon2D);
  const baseHoles = existingHoles.filter((h) => h.length >= 3).map(ensureCW);
  const baseRegion = [baseOuter, ...baseHoles];

  // Partition cutouts into:
  // 1) pure isolated single-loop interior holes (fast path, preserves exact vertex count)
  // 2) cutouts that overlap/cross outer boundary, existing holes, or another cutout
  const activeCutouts = cutoutRegions.filter((reg) => {
    if (reg.length === 0) return false;
    // Does this cutout interact with the panel region at all?
    for (const loop of reg) {
      if (loop.some((p) => pointInRegion2D(p, baseRegion))) return true;
      if (loopsTouchOrCross2D(loop, baseOuter)) return true;
      for (const h of baseHoles) if (loopsTouchOrCross2D(loop, h)) return true;
    }
    // Check if the entire panel sits inside the cutout!
    return pointInRegion2D(baseOuter[0], reg);
  });

  if (activeCutouts.length === 0) {
    return { outer: outerPolygon2D, holes: existingHoles };
  }

  const isolatedHoles: Point2D[][] = [];
  const complexCutouts: Point2D[][][] = [];

  for (let i = 0; i < activeCutouts.length; i++) {
    const reg = activeCutouts[i];
    let isolated = reg.length === 1;
    if (isolated) {
      const loop = reg[0];
      if (!loop.every((p) => pointInRegion2D(p, baseRegion))) isolated = false;
      if (isolated && loopsTouchOrCross2D(loop, baseOuter)) isolated = false;
      if (isolated) {
        for (const h of baseHoles) {
          if (loopsTouchOrCross2D(loop, h) || pointInPolygon2D(loop, h[0])) {
            isolated = false;
            break;
          }
        }
      }
      if (isolated) {
        for (let j = 0; j < activeCutouts.length; j++) {
          if (j === i) continue;
          for (const other of activeCutouts[j]) {
            if (
              loopsTouchOrCross2D(loop, other) ||
              pointInPolygon2D(loop, other[0]) ||
              pointInPolygon2D(other, loop[0])
            ) {
              isolated = false;
              break;
            }
          }
          if (!isolated) break;
        }
      }
    }
    if (isolated) isolatedHoles.push(ensureCW(reg[0]));
    else complexCutouts.push(reg);
  }

  if (complexCutouts.length === 0) {
    return { outer: outerPolygon2D, holes: [...existingHoles, ...isolatedHoles] };
  }

  const orientedCutouts = complexCutouts.map((reg) => {
    const sorted = [...reg].sort((a, b) => polygonArea(b) - polygonArea(a));
    return sorted.map((l, idx) => (idx === 0 ? ensureCCW(l) : ensureCW(l)));
  });

  const seedLoops: Point2D[][] = [
    baseOuter,
    ...baseHoles,
    // Reverse cutout orientations so remaining panel material stays on the left.
    ...orientedCutouts.flatMap((reg) => reg.map((l) => [...l].reverse())),
  ];

  const arranged = booleanArrangeLoops2D(
    seedLoops,
    (pt) =>
      pointInRegion2D(pt, baseRegion) &&
      !orientedCutouts.some((cut) => pointInRegion2D(pt, cut))
  );

  if (arranged.outers.length === 0) {
    return { outer: [], holes: [] };
  }
  const mainOuter = arranged.outers[0];
  const mainHoles = [
    ...arranged.holes.filter((h) => pointInPolygon2D(mainOuter, h[0])),
    ...isolatedHoles.filter((h) => pointInPolygon2D(mainOuter, h[0])),
  ];
  return { outer: mainOuter, holes: mainHoles };
}

/**
 * Sample points on the hull of a convex primitive cutter, in the geom's own frame.
 *
 * `pad` is an isotropic radius to be added around every sample — it carries the
 * part of a shape whose silhouette is direction-independent (a sphere, or a
 * capsule's end caps), which no finite set of surface samples can capture.
 */
function cutoutHullSamples(geom: SceneGeom): { local: THREE.Vector3[]; pad: number } | null {
  const s = geom.size || [];
  // A tapped hole is modelled at the thread's major diameter; what gets cut is
  // the hole the tap goes into.
  const r = tapDrillRadius(geom) ?? (s[0] || 0.018);

  switch (geom.type) {
    case 'box': {
      const h = [s[0] || 0.01, s[1] || 0.01, s[2] || 0.01];
      const local: THREE.Vector3[] = [];
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        local.push(new THREE.Vector3(sx * h[0], sy * h[1], sz * h[2]));
      }
      return { local, pad: 0 };
    }
    case 'cylinder': {
      // Both end discs. A cylinder is their convex hull, so their projections
      // bound the cutout for any panel orientation: a circle when the axis runs
      // through the panel, a slot when it lies in it.
      const hl = getGeomFrame(geom).halfLen ?? (s[1] ?? r);
      const local: THREE.Vector3[] = [];
      for (let k = 0; k < CUTOUT_ARC_STEPS; k++) {
        const ang = (k / CUTOUT_ARC_STEPS) * Math.PI * 2;
        const x = Math.cos(ang) * r;
        const y = Math.sin(ang) * r;
        local.push(new THREE.Vector3(x, y, -hl), new THREE.Vector3(x, y, hl));
      }
      return { local, pad: 0 };
    }
    case 'capsule': {
      // The hull of the two cap spheres; the pad supplies their radius.
      const hl = getGeomFrame(geom).halfLen ?? (s[1] ?? r);
      return {
        local: [new THREE.Vector3(0, 0, -hl), new THREE.Vector3(0, 0, hl)],
        pad: r,
      };
    }
    case 'sphere':
      return { local: [new THREE.Vector3(0, 0, 0)], pad: r };
    default:
      return null;
  }
}

/**
 * Extracts one subtractive cutter's normal interval `[cutLo, cutHi]` along `worldN`
 * and its 2D cutout region loops in `(worldU, worldV)` mm, supporting convex
 * primitives (`box`, `cylinder`, `capsule`, `sphere`), `ellipsoid`, and arbitrary
 * (including concave) `mesh` cutters.
 */
function extractSingleCutout2D(
  diffGeom: SceneGeom,
  bodyMatrix: THREE.Matrix4,
  worldOrigin: THREE.Vector3,
  worldU: THREE.Vector3,
  worldV: THREE.Vector3,
  worldN: THREE.Vector3,
  sheet: { lo: number; hi: number }
): { cutLo: number; cutHi: number; loops: Point2D[][] } | null {
  const m = getGeomTransform(diffGeom, bodyMatrix);

  if (diffGeom.type === 'ellipsoid') {
    const s = diffGeom.size || [];
    const rx = s[0] || 0.01;
    const ry = s[1] ?? rx;
    const rz = s[2] ?? rx;
    const cWorld = new THREE.Vector3(0, 0, 0).applyMatrix4(m).sub(worldOrigin);
    const ax = new THREE.Vector3(rx, 0, 0).applyMatrix4(m).sub(worldOrigin).sub(cWorld);
    const ay = new THREE.Vector3(0, ry, 0).applyMatrix4(m).sub(worldOrigin).sub(cWorld);
    const az = new THREE.Vector3(0, 0, rz).applyMatrix4(m).sub(worldOrigin).sub(cWorld);

    const nc = cWorld.dot(worldN);
    const nx = ax.dot(worldN), ny = ay.dot(worldN), nz = az.dot(worldN);
    const dn = Math.hypot(nx, ny, nz);
    if (dn < 1e-9) return null;
    const cutLo = nc - dn;
    const cutHi = nc + dn;

    // Evaluate at the widest plane inside [sheet.lo, sheet.hi] (the full silhouette
    // when the ellipsoid's centre sits inside the slab, or the entry cross-section
    // when its centre sits outside).
    const nPlane = Math.max(sheet.lo, Math.min(sheet.hi, nc));
    const q = Math.max(-1, Math.min(1, (nPlane - nc) / dn));
    // Unit vector along normal in unit-sphere parameter space: s_n = (nx, ny, nz) / dn
    const snx = nx / dn, sny = ny / dn, snz = nz / dn;
    const shiftS = q;
    const radScale = Math.sqrt(Math.max(0, 1 - q * q));

    // Orthonormal tangent basis (t1, t2) orthogonal to s_n in R^3:
    const ref = Math.abs(snx) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const snVec = new THREE.Vector3(snx, sny, snz);
    const t1 = new THREE.Vector3().crossVectors(snVec, ref).normalize();
    const t2 = new THREE.Vector3().crossVectors(snVec, t1).normalize();

    const mapSphereVec = (sv: THREE.Vector3): Point2D => {
      const p3 = new THREE.Vector3()
        .addScaledVector(ax, sv.x)
        .addScaledVector(ay, sv.y)
        .addScaledVector(az, sv.z);
      return { x: p3.dot(worldU) * 1000, y: p3.dot(worldV) * 1000 };
    };
    const center2D = {
      x: (cWorld.dot(worldU) + shiftS * (ax.dot(worldU) * snx + ay.dot(worldU) * sny + az.dot(worldU) * snz)) * 1000,
      y: (cWorld.dot(worldV) + shiftS * (ax.dot(worldV) * snx + ay.dot(worldV) * sny + az.dot(worldV) * snz)) * 1000,
    };
    const e1 = mapSphereVec(t1);
    const e2 = mapSphereVec(t2);
    if (radScale < 1e-6) return null;

    const loop: Point2D[] = [];
    for (let k = 0; k < CUTOUT_ARC_STEPS; k++) {
      const ang = (k / CUTOUT_ARC_STEPS) * Math.PI * 2;
      const ca = Math.cos(ang) * radScale;
      const sa = Math.sin(ang) * radScale;
      loop.push({
        x: center2D.x + ca * e1.x + sa * e2.x,
        y: center2D.y + ca * e1.y + sa * e2.y,
      });
    }
    return polygonArea(loop) > 1e-4 ? { cutLo, cutHi, loops: [ensureCCW(loop)] } : null;
  }

  if (diffGeom.type === 'mesh') {
    const rawVerts = diffGeom.renderVertices ?? yupVertsToZup(diffGeom.vertices || []);
    if (rawVerts.length < 9) return null;
    const pts2D: Point2D[] = [];
    const ns: number[] = [];
    let cutLo = Infinity;
    let cutHi = -Infinity;
    for (let i = 0; i < rawVerts.length; i += 3) {
      const d = new THREE.Vector3(rawVerts[i], rawVerts[i + 1], rawVerts[i + 2])
        .applyMatrix4(m)
        .sub(worldOrigin);
      const n = d.dot(worldN);
      if (n < cutLo) cutLo = n;
      if (n > cutHi) cutHi = n;
      ns.push(n);
      pts2D.push({ x: d.dot(worldU) * 1000, y: d.dot(worldV) * 1000 });
    }

    const rawFaces = diffGeom.faces || [];
    if (rawFaces.length >= 3) {
      // Slice mesh triangles at the mid-plane (or widest interior plane) to preserve
      // concave cutouts, slots, stars, and interior islands accurately.
      const nPlane = Math.max(sheet.lo, Math.min(sheet.hi, (sheet.lo + sheet.hi) / 2));
      const sliceEdges: { p1: Point2D; p2: Point2D }[] = [];
      for (let i = 0; i + 2 < rawFaces.length; i += 3) {
        const ia = rawFaces[i], ib = rawFaces[i + 1], ic = rawFaces[i + 2];
        if (ia >= pts2D.length || ib >= pts2D.length || ic >= pts2D.length) continue;
        const idx = [ia, ib, ic];
        const hits: Point2D[] = [];
        for (let e = 0; e < 3; e++) {
          const u = idx[e], v = idx[(e + 1) % 3];
          const nu = ns[u] - nPlane;
          const nv = ns[v] - nPlane;
          if ((nu <= 0 && nv > 0) || (nu > 0 && nv <= 0)) {
            const t = nu / (nu - nv);
            hits.push({
              x: pts2D[u].x + (pts2D[v].x - pts2D[u].x) * t,
              y: pts2D[u].y + (pts2D[v].y - pts2D[u].y) * t,
            });
          }
        }
        if (hits.length === 2 && Math.hypot(hits[1].x - hits[0].x, hits[1].y - hits[0].y) > 1e-5) {
          sliceEdges.push({ p1: hits[0], p2: hits[1] });
        }
      }
      const chained = chainBoundaryLoops2D(sliceEdges)
        .map((l) => simplifyPolyline2D(simplifyPolygon2D(l), 0.05))
        .filter((l) => l.length >= 3 && polygonArea(l) > 1e-4);
      if (chained.length > 0) {
        return { cutLo, cutHi, loops: chained };
      }
    }

    const hull = convexHull2D(pts2D);
    return hull.length >= 3 && polygonArea(hull) > 1e-4 ? { cutLo, cutHi, loops: [hull] } : null;
  }

  const samples = cutoutHullSamples(diffGeom);
  if (!samples) return null;

  const padMm = samples.pad * 1000;
  const projected: Point2D[] = [];
  let nLo = Infinity;
  let nHi = -Infinity;

  for (const lp of samples.local) {
    const d = lp.clone().applyMatrix4(m).sub(worldOrigin);
    const n = d.dot(worldN);
    if (n < nLo) nLo = n;
    if (n > nHi) nHi = n;

    const p = { x: d.dot(worldU) * 1000, y: d.dot(worldV) * 1000 };
    if (padMm > 0) {
      for (let k = 0; k < CUTOUT_ARC_STEPS; k++) {
        const ang = (k / CUTOUT_ARC_STEPS) * Math.PI * 2;
        projected.push({ x: p.x + Math.cos(ang) * padMm, y: p.y + Math.sin(ang) * padMm });
      }
    } else {
      projected.push(p);
    }
  }

  const cutLo = nLo - samples.pad;
  const cutHi = nHi + samples.pad;
  const loop = convexHull2D(projected);
  return loop.length >= 3 ? { cutLo, cutHi, loops: [loop] } : null;
}

/**
 * Projects and clips a body's subtractive geoms against a panel's 2D region
 * `(outerPolygon2D, existingHoles)`.
 *
 * - Cutters clear of `sheet` along `worldN` are ignored.
 * - Cutters entering `sheet` and stopping inside it are recorded on `blind`.
 * - Through-cutters are boolean-subtracted from `(outerPolygon2D, existingHoles)`:
 *   edge-straddling cutters notch `outerPolygon2D`, and overlapping interior
 *   cutters union cleanly into valid non-overlapping `innerCutouts2D` loops.
 */
function applySubtractiveCutouts2D(
  outerPolygon2D: Point2D[],
  existingHoles: Point2D[][],
  diffGeoms: SceneGeom[],
  bodyMatrix: THREE.Matrix4,
  worldOrigin: THREE.Vector3,
  worldU: THREE.Vector3,
  worldV: THREE.Vector3,
  sheet: { lo: number; hi: number },
  blind: SceneGeom[]
): { outer: Point2D[]; holes: Point2D[][] } {
  if (diffGeoms.length === 0 || outerPolygon2D.length < 3) {
    return { outer: outerPolygon2D, holes: existingHoles };
  }

  const worldN = new THREE.Vector3().crossVectors(worldU, worldV).normalize();
  const baseOuter = ensureCCW(outerPolygon2D);
  const baseHoles = existingHoles.filter((h) => h.length >= 3).map(ensureCW);
  const baseRegion = [baseOuter, ...baseHoles];
  const throughCutouts: Point2D[][][] = [];

  for (const diffGeom of diffGeoms) {
    const extracted = extractSingleCutout2D(
      diffGeom,
      bodyMatrix,
      worldOrigin,
      worldU,
      worldV,
      worldN,
      sheet
    );
    if (!extracted) continue;
    const { cutLo, cutHi, loops } = extracted;
    if (Math.min(cutHi, sheet.hi) - Math.max(cutLo, sheet.lo) <= SHEET_TOUCH_M) continue;

    // Does the cutter's 2D silhouette intersect this panel's material region?
    let touchesPanel = pointInRegion2D(baseOuter[0], loops);
    if (!touchesPanel) {
      for (const loop of loops) {
        let cx = 0, cy = 0;
        for (const p of loop) { cx += p.x; cy += p.y; }
        const centre = { x: cx / loop.length, y: cy / loop.length };
        if (
          pointInRegion2D(centre, baseRegion) ||
          loop.some((p) => pointInRegion2D(p, baseRegion)) ||
          loopsTouchOrCross2D(loop, baseOuter) ||
          baseHoles.some((h) => loopsTouchOrCross2D(loop, h))
        ) {
          touchesPanel = true;
          break;
        }
      }
    }
    if (!touchesPanel) continue;

    if (cutLo > sheet.lo + SHEET_TOUCH_M || cutHi < sheet.hi - SHEET_TOUCH_M) {
      blind.push(diffGeom);
      continue;
    }
    throughCutouts.push(loops);
  }

  return subtractCutoutsFromPanel2D(outerPolygon2D, existingHoles, throughCutouts);
}

// ---------------------------------------------------------------------------
// 3D Panel Extraction Logic
// ---------------------------------------------------------------------------

interface RawTriFace {
  a: THREE.Vector3;
  b: THREE.Vector3;
  c: THREE.Vector3;
  normal: THREE.Vector3;
  planeDist: number;
}

interface CoplanarGroup {
  normal: THREE.Vector3;
  planeDist: number;
  tris: RawTriFace[];
}

/**
 * Gives a panel the engrave lines of any surface pattern on the face it was
 * cut from: a region of `geom` whose plane is one of the panel's two skins.
 */
function attachPatternEngraving(panel: LaserPanel, geom: SceneGeom, geomMatrix: THREE.Matrix4): void {
  if (!geom.textures?.length) return;
  const surface = texturedSurfaceOf(geom, getGeomFrame(geom).halfLen);
  if (!surface) return;
  const n = v3(panel.normal3D);
  const origin = v3(panel.origin3D);
  // Both skins of a sheet sit half a thickness off the mid-plane; a shelled
  // box's panel has its outer skin there too.
  const reach = panel.thickness / 2 + 1e-3;
  const found: { lines: THREE.Vector3[][]; under: boolean }[] = [];
  for (const region of surface.regions) {
    const field = region.applied ? region.field : undefined;
    if (!field) continue;
    const normal = new THREE.Vector3(...region.normal).transformDirection(geomMatrix);
    const facing = normal.dot(n);
    if (Math.abs(facing) < 0.99) continue;
    const at = new THREE.Vector3(...field.origin).applyMatrix4(geomMatrix);
    if (Math.abs(at.clone().sub(origin).dot(n)) > reach) continue;
    const lines = reliefContours(field).map((line) =>
      line.map((p) => new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(geomMatrix)),
    );
    if (lines.length) found.push({ lines, under: facing < 0 });
  }
  if (!found.length) return;

  /*
   * A pattern only on the face that would lie on the bed: cut the panel face
   * down instead, so that face is up under the laser. Its whole frame turns
   * over — outline, holes and the joints still to come — so it goes into the
   * assembly exactly as cut. Engraving it on the top and turning the panel
   * over afterwards put every off-centre hole and joint on the wrong side.
   */
  if (found.every((r) => r.under) && !panel.blindPockets2D?.some((bp) => !bp.under)) {
    mirrorPanelFrame(panel);
    panel.cutFaceDown = true;
  } else if (found.some((r) => r.under)) {
    panel.engraveUnderside = true;
  }
  for (const r of found) {
    (panel.engrave2D ??= []).push(...r.lines.map((line) => line.map((p) => toPanel2D(panel, p))));
  }
}

/**
 * Views a panel from its other face: u and the normal reverse, and its 2D
 * loops mirror with them, rewound so an outline stays anticlockwise.
 */
function mirrorPanelFrame(panel: LaserPanel): void {
  const flip = (loop: Point2D[]) => loop.map((p) => ({ x: -p.x, y: p.y })).reverse();
  panel.uAxis3D = v3(panel.uAxis3D).multiplyScalar(-1);
  panel.normal3D = v3(panel.normal3D).multiplyScalar(-1);
  panel.outerPolygon2D = flip(panel.outerPolygon2D);
  panel.innerCutouts2D = panel.innerCutouts2D.map(flip);
  if (panel.engrave2D) panel.engrave2D = panel.engrave2D.map((l) => l.map((p) => ({ x: -p.x, y: p.y })));
  if (panel.blindPockets2D) {
    panel.blindPockets2D = panel.blindPockets2D.map((bp) => ({
      ...bp,
      outer: flip(bp.outer),
      holes: bp.holes?.map(flip),
      under: !bp.under,
    }));
  }
}

/**
 * A primitive as a welded, world-space mesh geom, for the mesh panel path.
 * Curves get chords within 0.01 mm of true, since this is the outline that
 * is cut; null for what has no solid (a plane).
 */
function primitiveAsMesh(geom: SceneGeom, geomMatrix: THREE.Matrix4): SceneGeom | null {
  const rMm = Math.max(...(geom.size ?? [0.01]).slice(0, geom.type === 'ellipsoid' ? 3 : 1)) * 1000;
  const radial = Math.max(48, Math.min(256, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - 0.01 / Math.max(rMm, 0.01))))));
  const soup: number[] = [];
  if (!appendBaseGeomTriangles(geom, getGeomFrame(geom).halfLen, geomMatrix, soup, radial)) return null;
  // Welded, so the mesh path sees one surface rather than loose triangles.
  const index = new Map<string, number>();
  const verts: number[] = [];
  const faces: number[] = [];
  for (let i = 0; i < soup.length; i += 3) {
    const key = `${soup[i].toFixed(9)},${soup[i + 1].toFixed(9)},${soup[i + 2].toFixed(9)}`;
    let k = index.get(key);
    if (k === undefined) {
      k = verts.length / 3;
      index.set(key, k);
      verts.push(soup[i], soup[i + 1], soup[i + 2]);
    }
    faces.push(k);
  }
  return { name: geom.name, type: 'mesh', size: [1], renderVertices: verts, faces } as SceneGeom;
}

export function extractPanelsFromScene(
  scene: SceneGraph,
  options: LaserCutOptions
): { panels: LaserPanel[]; invalidGeoms: string[]; blindCuts: string[] } {
  const panels: LaserPanel[] = [];
  const invalidGeoms: string[] = [];
  const blindCuts = new Set<string>();

  let panelIdCounter = 1;

  function traverseNode(node: SceneNode, parentMatrix?: THREE.Matrix4) {
    const bodyMatrix = getNodeWorldTransform(node, parentMatrix);
    if (isBoughtIn(node)) {
      for (const child of node.children || []) traverseNode(child, bodyMatrix);
      return;
    }

    const rawGeoms = node.geoms || [];
    const diffGeoms = rawGeoms.filter(g => g.csg === 'difference');
    const blind: SceneGeom[] = [];
    // Subtractive geoms are cutters, not stock: a `difference` box became six
    // panels of its own, and a `difference` capsule failed the whole export as
    // an unsupported curved solid. They are projected as cutouts instead.
    const positiveGeoms = csgSourceGeoms(node)
      .filter(g => g.role !== 'collision' && g.csg !== 'difference');

    for (const geom of positiveGeoms) {
      const geomMatrix = getGeomTransform(geom, bodyMatrix);

      if (geom.type !== 'box' && geom.type !== 'mesh') {
        // Every other primitive (cylinder, sphere, capsule, ellipsoid) as the
        // mesh it is, through the mesh path below: whatever has two flat
        // skins cuts as its outline (a disc, a round lid), and whatever has
        // none is said to be curved. Primitives other than boxes used to be
        // skipped or refused by type, so a disc came back as "nothing to cut".
        const asMesh = primitiveAsMesh(geom, geomMatrix);
        const meshPanels = asMesh
          ? extractPanelsFromMeshGeom(asMesh, new THREE.Matrix4(), node.name, options, panelIdCounter, diffGeoms, bodyMatrix, blind)
          : [];
        if (meshPanels.length === 0) {
          invalidGeoms.push(`${node.name} (${geom.name || geom.type}: curved sides a flat sheet cannot make)`);
        } else {
          for (const panel of meshPanels) {
            panel.name = meshPanels.length === 1 ? (geom.name || node.name) : panel.name;
            attachPatternEngraving(panel, geom, geomMatrix);
          }
          panels.push(...meshPanels);
          panelIdCounter += meshPanels.length;
        }
        continue;
      }

      if (geom.type === 'box') {
        const size = geom.size || [0.05, 0.05, 0.05];
        const fullX = size[0] * 2;
        const fullY = size[1] * 2;
        const fullZ = size[2] * 2;

        // Is this box a sheet already, or a solid to be shelled into six?
        //
        // "Smallest of the three dimensions" is not a thinness test — one axis
        // is always the smallest, so it classified a cube as a sheet and cut it
        // as a single square. A box counts as a sheet when its thinnest axis is
        // near the stock thickness, or is far thinner than the face it carries.
        const minDim = Math.min(fullX, fullY, fullZ);
        const midDim = fullX + fullY + fullZ - minDim - Math.max(fullX, fullY, fullZ);
        const isSheet =
          Math.abs(minDim - options.materialThickness) <= 0.5 * options.materialThickness ||
          minDim <= 0.2 * midDim;

        const isThinX = isSheet && minDim === fullX;
        const isThinY = isSheet && minDim === fullY && !isThinX;

        if (isSheet) {
          let w = fullX;
          let h = fullY;
          let th = fullZ;

          let localU = new THREE.Vector3(1, 0, 0);
          let localV = new THREE.Vector3(0, 1, 0);
          let localN = new THREE.Vector3(0, 0, 1);

          if (isThinX) {
            w = fullY;
            h = fullZ;
            th = fullX;
            localU = new THREE.Vector3(0, 1, 0);
            localV = new THREE.Vector3(0, 0, 1);
            localN = new THREE.Vector3(1, 0, 0);
          } else if (isThinY) {
            w = fullX;
            h = fullZ;
            th = fullY;
            localU = new THREE.Vector3(1, 0, 0);
            localV = new THREE.Vector3(0, 0, 1);
            localN = new THREE.Vector3(0, 1, 0);
          }

          const worldOrigin = new THREE.Vector3(0, 0, 0).applyMatrix4(geomMatrix);
          const worldU = localU.clone().transformDirection(geomMatrix).normalize();
          const worldV = localV.clone().transformDirection(geomMatrix).normalize();
          const worldN = localN.clone().transformDirection(geomMatrix).normalize();

          const hw = w / 2;
          const hh = h / 2;
          const rawOuterPolygon2D: Point2D[] = [
            { x: -hw * 1000, y: -hh * 1000 },
            { x:  hw * 1000, y: -hh * 1000 },
            { x:  hw * 1000, y:  hh * 1000 },
            { x: -hw * 1000, y:  hh * 1000 },
          ];

          const cutRes = applySubtractiveCutouts2D(
            rawOuterPolygon2D,
            [],
            diffGeoms,
            bodyMatrix,
            worldOrigin,
            worldU,
            worldV,
            { lo: -th / 2, hi: th / 2 },
            blind
          );
          const outerPolygon2D = cutRes.outer;
          const innerCutouts2D = cutRes.holes;

          if (outerPolygon2D.length >= 3) {
            const edges3D: LaserPanelEdge[] = outerPolygon2D.map((pt, idx) => {
              const nxt = outerPolygon2D[(idx + 1) % outerPolygon2D.length];
              return {
                p1: worldOrigin.clone().addScaledVector(worldU, pt.x / 1000).addScaledVector(worldV, pt.y / 1000),
                p2: worldOrigin.clone().addScaledVector(worldU, nxt.x / 1000).addScaledVector(worldV, nxt.y / 1000),
              };
            });

            panels.push({
              id: `panel_${panelIdCounter++}`,
              name: geom.name || node.name,
              thickness: th,
              origin3D: worldOrigin,
              normal3D: worldN,
              uAxis3D: worldU,
              vAxis3D: worldV,
              outerPolygon2D,
              innerCutouts2D,
              edges3D,
            });
            attachPatternEngraving(panels[panels.length - 1], geom, geomMatrix);
          }
        } else {
          const facesSpec = [
            { name: 'front',  u: new THREE.Vector3(1, 0, 0),  v: new THREE.Vector3(0, 0, 1), n: new THREE.Vector3(0, 1, 0),  pos: new THREE.Vector3(0, fullY/2, 0),  w: fullX, h: fullZ },
            { name: 'back',   u: new THREE.Vector3(-1, 0, 0), v: new THREE.Vector3(0, 0, 1), n: new THREE.Vector3(0, -1, 0), pos: new THREE.Vector3(0, -fullY/2, 0), w: fullX, h: fullZ },
            { name: 'left',   u: new THREE.Vector3(0, 1, 0),  v: new THREE.Vector3(0, 0, 1), n: new THREE.Vector3(-1, 0, 0), pos: new THREE.Vector3(-fullX/2, 0, 0), w: fullY, h: fullZ },
            { name: 'right',  u: new THREE.Vector3(0, -1, 0), v: new THREE.Vector3(0, 0, 1), n: new THREE.Vector3(1, 0, 0),  pos: new THREE.Vector3(fullX/2, 0, 0),  w: fullY, h: fullZ },
            { name: 'top',    u: new THREE.Vector3(1, 0, 0),  v: new THREE.Vector3(0, 1, 0), n: new THREE.Vector3(0, 0, 1),  pos: new THREE.Vector3(0, 0, fullZ/2),  w: fullX, h: fullY },
            { name: 'bottom', u: new THREE.Vector3(1, 0, 0),  v: new THREE.Vector3(0, -1, 0),n: new THREE.Vector3(0, 0, -1), pos: new THREE.Vector3(0, 0, -fullZ/2), w: fullX, h: fullY },
          ];

          for (const f of facesSpec) {
            // A solid box is shelled into 6 sheets. The face spec sits on the box's outer
            // surface; shift it inward by half the material so each panel represents a real
            // slab whose outer skin matches the original box dimensions. Joint depths are
            // derived from these mid-planes, so this offset is what makes corners interlock.
            const midPos = f.pos.clone().addScaledVector(f.n, -options.materialThickness / 2);
            const worldOrigin = midPos.applyMatrix4(geomMatrix);
            const worldU = f.u.clone().transformDirection(geomMatrix).normalize();
            const worldV = f.v.clone().transformDirection(geomMatrix).normalize();
            const worldN = f.n.clone().transformDirection(geomMatrix).normalize();

            const hw = f.w / 2;
            const hh = f.h / 2;

            const rawOuterPolygon2D: Point2D[] = [
              { x: -hw * 1000, y: -hh * 1000 },
              { x:  hw * 1000, y: -hh * 1000 },
              { x:  hw * 1000, y:  hh * 1000 },
              { x: -hw * 1000, y:  hh * 1000 },
            ];

            // The sheet's thickness, not the solid's: a hole through this
            // wall has only the wall to get through.
            const cutRes = applySubtractiveCutouts2D(
              rawOuterPolygon2D,
              [],
              diffGeoms,
              bodyMatrix,
              worldOrigin,
              worldU,
              worldV,
              { lo: -options.materialThickness / 2, hi: options.materialThickness / 2 },
              blind
            );
            const outerPolygon2D = cutRes.outer;
            if (outerPolygon2D.length < 3) continue;
            const innerCutouts2D = cutRes.holes;

            const edges3D: LaserPanelEdge[] = outerPolygon2D.map((pt, idx) => {
              const nxt = outerPolygon2D[(idx + 1) % outerPolygon2D.length];
              return {
                p1: worldOrigin.clone().addScaledVector(worldU, pt.x / 1000).addScaledVector(worldV, pt.y / 1000),
                p2: worldOrigin.clone().addScaledVector(worldU, nxt.x / 1000).addScaledVector(worldV, nxt.y / 1000),
              };
            });

            panels.push({
              id: `panel_${panelIdCounter++}`,
              name: `${geom.name || node.name}_${f.name}`,
              thickness: options.materialThickness,
              origin3D: worldOrigin,
              normal3D: worldN,
              uAxis3D: worldU,
              vAxis3D: worldV,
              outerPolygon2D,
              innerCutouts2D,
              edges3D,
            });
            attachPatternEngraving(panels[panels.length - 1], geom, geomMatrix);
          }
        }
      } else if (geom.type === 'mesh' && (geom.renderVertices || geom.vertices) && geom.faces) {
        const meshPanels = extractPanelsFromMeshGeom(
          geom,
          geomMatrix,
          node.name,
          options,
          panelIdCounter,
          diffGeoms,
          bodyMatrix,
          blind
        );

        if (meshPanels.length === 0) {
          invalidGeoms.push(`${node.name} (${geom.name || 'mesh'}: curved sides a flat sheet cannot make)`);
        } else {
          for (const panel of meshPanels) attachPatternEngraving(panel, geom, geomMatrix);
          panels.push(...meshPanels);
          panelIdCounter += meshPanels.length;
        }
      }
    }

    for (const g of blind) {
      const kind = g.hardware ? HARDWARE_KINDS[g.hardware.kind]?.label : undefined;
      blindCuts.add(`${kind ?? g.name ?? 'A cut'} in ${node.name}`);
    }

    if (node.children) {
      for (const child of node.children) {
        traverseNode(child, bodyMatrix);
      }
    }
  }

  for (const rootNode of scene.nodes) {
    traverseNode(rootNode);
  }

  return { panels, invalidGeoms, blindCuts: [...blindCuts] };
}

function samplePointInLoop2D(loop: Point2D[]): Point2D {
  if (loop.length === 0) return { x: 0, y: 0 };
  let cx = 0, cy = 0;
  for (const p of loop) { cx += p.x; cy += p.y; }
  const avg = { x: cx / loop.length, y: cy / loop.length };
  if (pointInPolygon2D(loop, avg)) return avg;

  const ccw = ensureCCW(loop);
  for (let i = 0; i < ccw.length; i++) {
    const a = ccw[i];
    const b = ccw[(i + 1) % ccw.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const mx = 0.5 * (a.x + b.x);
    const my = 0.5 * (a.y + b.y);
    const nx = -dy / len;
    const ny = dx / len;
    for (const eps of [Math.min(0.2, len * 0.2), 0.02, 1e-3]) {
      const cand = { x: mx + nx * eps, y: my + ny * eps };
      if (pointInPolygon2D(loop, cand)) return cand;
    }
  }
  return loop[0];
}

function samplePointInRegion2D(region: Point2D[][]): Point2D {
  if (region.length === 0) return { x: 0, y: 0 };
  const outer = ensureCCW(region[0]);
  const avg = samplePointInLoop2D(outer);
  if (pointInRegion2D(avg, region)) return avg;
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i];
    const b = outer[(i + 1) % outer.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const mx = 0.5 * (a.x + b.x);
    const my = 0.5 * (a.y + b.y);
    const nx = -dy / len;
    const ny = dx / len;
    for (const eps of [Math.min(0.2, len * 0.15), 0.02, 1e-3]) {
      const cand = { x: mx + nx * eps, y: my + ny * eps };
      if (pointInRegion2D(cand, region)) return cand;
    }
  }
  return outer[0] ?? { x: 0, y: 0 };
}

function extractGroupRegions2D(
  group: CoplanarGroup,
  origin3D: THREE.Vector3,
  uAxis: THREE.Vector3,
  vAxis: THREE.Vector3
): Point2D[][][] {
  const edgeMap = new Map<string, { p1: THREE.Vector3; p2: THREE.Vector3; count: number }>();
  const edgeKey = (p1: THREE.Vector3, p2: THREE.Vector3): string => {
    const k1 = `${p1.x.toFixed(4)},${p1.y.toFixed(4)},${p1.z.toFixed(4)}`;
    const k2 = `${p2.x.toFixed(4)},${p2.y.toFixed(4)},${p2.z.toFixed(4)}`;
    return k1 < k2 ? `${k1}_${k2}` : `${k2}_${k1}`;
  };

  for (const tri of group.tris) {
    for (const e of [
      { p1: tri.a, p2: tri.b },
      { p1: tri.b, p2: tri.c },
      { p1: tri.c, p2: tri.a },
    ]) {
      const key = edgeKey(e.p1, e.p2);
      const existing = edgeMap.get(key);
      if (existing) existing.count++;
      else edgeMap.set(key, { p1: e.p1, p2: e.p2, count: 1 });
    }
  }

  const edges2D: { p1: Point2D; p2: Point2D }[] = [];
  for (const entry of edgeMap.values()) {
    if (entry.count !== 1) continue;
    const d1 = new THREE.Vector3().subVectors(entry.p1, origin3D);
    const d2 = new THREE.Vector3().subVectors(entry.p2, origin3D);
    edges2D.push({
      p1: { x: d1.dot(uAxis) * 1000, y: d1.dot(vAxis) * 1000 },
      p2: { x: d2.dot(uAxis) * 1000, y: d2.dot(vAxis) * 1000 },
    });
  }
  if (edges2D.length < 3) return [];

  // Triangulated boundaries arrive as long runs of nearly-colinear points and,
  // where a CSG result was quantised, as sub-millimetre staircases. Both are
  // below any cutter's resolution, so flatten them before joints are cut.
  // 0.05 mm: under any kerf, and an arc stays an arc rather than facets.
  const clean = (l: Point2D[]) => simplifyPolyline2D(simplifyPolygon2D(l), 0.05);
  const rawLoops = chainBoundaryLoops2D(edges2D).map(clean).filter((l) => l.length >= 3);
  if (rawLoops.length === 0) return [];
  if (rawLoops.length === 1) return [[ensureCCW(rawLoops[0])]];

  // Classify loops into [ccwOuter, ...cwHoles] regions by nesting depth so a
  // blind groove/dado that splits a top skin into two islands keeps both islands
  // as outer regions rather than misclassifying the second island as a hole.
  const samples = rawLoops.map(samplePointInLoop2D);
  const depths = rawLoops.map((_, i) => {
    let d = 0;
    for (let j = 0; j < i; j++) {
      if (pointInPolygon2D(rawLoops[j], samples[i])) d++;
    }
    return d;
  });

  const regions: Point2D[][][] = [];
  const outerIndices: number[] = [];
  for (let i = 0; i < rawLoops.length; i++) {
    if (depths[i] % 2 === 0) {
      regions.push([ensureCCW(rawLoops[i])]);
      outerIndices.push(i);
    }
  }
  for (let i = 0; i < rawLoops.length; i++) {
    if (depths[i] % 2 !== 1) continue;
    let ownerRegion = -1;
    for (let r = outerIndices.length - 1; r >= 0; r--) {
      const oi = outerIndices[r];
      if (oi < i && depths[oi] === depths[i] - 1 && pointInPolygon2D(rawLoops[oi], samples[i])) {
        ownerRegion = r;
        break;
      }
    }
    if (ownerRegion >= 0) regions[ownerRegion].push(ensureCW(rawLoops[i]));
  }
  return regions;
}

function regionsInteriorOverlap2D(regsA: Point2D[][][], regsB: Point2D[][][]): boolean {
  const distToLoop = (pt: Point2D, loop: Point2D[]): number => {
    let best = Infinity;
    for (let i = 0; i < loop.length; i++) {
      best = Math.min(best, pointSegmentDist(pt, loop[i], loop[(i + 1) % loop.length]));
    }
    return best;
  };
  const strictlyIn = (pt: Point2D, reg: Point2D[][]): boolean =>
    pointInRegion2D(pt, reg) && reg.every((l) => distToLoop(pt, l) > 0.05);

  for (const ra of regsA) {
    const sa = samplePointInRegion2D(ra);
    if (regsB.some((rb) => strictlyIn(sa, rb))) return true;
  }
  for (const rb of regsB) {
    const sb = samplePointInRegion2D(rb);
    if (regsA.some((ra) => strictlyIn(sb, ra))) return true;
  }

  // Fallback for crossing strips where neither sample lands inside the other:
  // check bbox overlap, then compare union area against sum of areas.
  const bboxOf = (regs: Point2D[][][]) => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const r of regs) for (const p of r[0]) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, maxX, minY, maxY };
  };
  const ba = bboxOf(regsA);
  const bb = bboxOf(regsB);
  if (ba.maxX <= bb.minX + 0.05 || bb.maxX <= ba.minX + 0.05 || ba.maxY <= bb.minY + 0.05 || bb.maxY <= ba.minY + 0.05) {
    return false;
  }
  const areaOf = (regs: Point2D[][][]) =>
    regs.reduce(
      (sum, r) =>
        sum +
        Math.abs(polygonSignedArea(r[0])) -
        r.slice(1).reduce((hs, h) => hs + Math.abs(polygonSignedArea(h)), 0),
      0
    );
  const sumArea = areaOf(regsA) + areaOf(regsB);
  const unionArea = areaOf(unionRegions2D([...regsA, ...regsB]));
  return sumArea - unionArea > 0.5;
}

function extractPanelsFromMeshGeom(
  geom: SceneGeom,
  geomMatrix: THREE.Matrix4,
  nodeName: string,
  options: LaserCutOptions,
  startId: number,
  diffGeoms: SceneGeom[],
  bodyMatrix: THREE.Matrix4,
  blind: SceneGeom[]
): LaserPanel[] {
  const meshPanels: LaserPanel[] = [];
  // SceneGeom.vertices is Y-up (three.js); renderVertices is the Z-up copy that
  // shares a space with pos/euler/size — and therefore with geomMatrix. Using
  // the raw Y-up array here unwraps every mesh into the wrong plane.
  const rawVerts = geom.renderVertices ?? yupVertsToZup(geom.vertices || []);
  const rawFaces = geom.faces || [];

  if (rawVerts.length === 0 || rawFaces.length === 0) return [];

  const worldVerts: THREE.Vector3[] = [];
  for (let i = 0; i < rawVerts.length; i += 3) {
    const v = new THREE.Vector3(rawVerts[i], rawVerts[i + 1], rawVerts[i + 2]).applyMatrix4(geomMatrix);
    worldVerts.push(v);
  }

  const tris: RawTriFace[] = [];
  for (let i = 0; i < rawFaces.length; i += 3) {
    const ia = rawFaces[i];
    const ib = rawFaces[i + 1];
    const ic = rawFaces[i + 2];
    if (ia >= worldVerts.length || ib >= worldVerts.length || ic >= worldVerts.length) continue;

    const a = worldVerts[ia];
    const b = worldVerts[ib];
    const c = worldVerts[ic];

    const ab = new THREE.Vector3().subVectors(b, a);
    const ac = new THREE.Vector3().subVectors(c, a);
    const normal = new THREE.Vector3().crossVectors(ab, ac).normalize();

    if (normal.lengthSq() < 1e-6) continue;

    const planeDist = normal.dot(a);
    tris.push({ a, b, c, normal, planeDist });
  }

  // Group triangles into planes. Facing must match: the two skins of a sheet are
  // antiparallel and get paired up below into a single panel with a real
  // thickness, rather than being merged into one confused boundary loop.
  const coplanarGroups: CoplanarGroup[] = [];

  for (const tri of tris) {
    let matchedGroup: CoplanarGroup | null = null;

    for (const group of coplanarGroups) {
      if (
        group.normal.dot(tri.normal) > 0.999 &&
        Math.abs(group.planeDist - tri.planeDist) < 0.0004
      ) {
        matchedGroup = group;
        break;
      }
    }

    if (matchedGroup) {
      matchedGroup.tris.push(tri);
    } else {
      coplanarGroups.push({
        normal: tri.normal.clone(),
        planeDist: tri.planeDist,
        tris: [tri],
      });
    }
  }

  interface GroupInfo {
    group: CoplanarGroup;
    area: number;
    centroid: THREE.Vector3;
  }

  // Area-weighted, not a plain vertex average: a triangulator is free to put
  // most of a face's vertices along one edge, which drags a vertex-average
  // centroid far off the face and makes the pairing test below miss.
  const infos: GroupInfo[] = coplanarGroups.map(group => {
    let area = 0;
    const centroid = new THREE.Vector3();
    for (const tri of group.tris) {
      const ab = new THREE.Vector3().subVectors(tri.b, tri.a);
      const ac = new THREE.Vector3().subVectors(tri.c, tri.a);
      const triArea = new THREE.Vector3().crossVectors(ab, ac).length() * 0.5;
      area += triArea;
      centroid.addScaledVector(tri.a, triArea / 3);
      centroid.addScaledVector(tri.b, triArea / 3);
      centroid.addScaledVector(tri.c, triArea / 3);
    }
    if (area > 0) centroid.divideScalar(area);
    return { group, area, centroid };
  });

  // Group parallel/antiparallel planes into canonical axis families so outer-skin
  // pairing and blind-pocket floor extraction are completely independent of the
  // order triangles appear in `geom.faces`.
  interface FamilyMember {
    idx: number;
    info: GroupInfo;
    facing: 1 | -1;
    h: number;
    regions: Point2D[][][];
    bbox: { minX: number; maxX: number; minY: number; maxY: number };
  }
  interface AxisFamily {
    axis: THREE.Vector3;
    uAxis: THREE.Vector3;
    vAxis: THREE.Vector3;
    members: FamilyMember[];
  }

  const canonicalAxis = (n: THREE.Vector3): THREE.Vector3 => {
    const comps = [n.x, n.y, n.z];
    let dom = 2;
    if (Math.abs(comps[0]) > Math.abs(comps[dom]) + 1e-4) dom = 0;
    if (Math.abs(comps[1]) > Math.abs(comps[dom]) + 1e-4) dom = 1;
    return comps[dom] >= 0 ? n.clone().normalize() : n.clone().multiplyScalar(-1).normalize();
  };

  const families: AxisFamily[] = [];
  const zeroOrigin = new THREE.Vector3(0, 0, 0);
  infos.forEach((info, idx) => {
    const canon = canonicalAxis(info.group.normal);
    let fam = families.find((f) => f.axis.dot(canon) > 0.999);
    if (!fam) {
      const axis = canon;
      let uAxis: THREE.Vector3;
      let vAxis: THREE.Vector3;
      if (Math.abs(axis.z) < 0.9) {
        vAxis = new THREE.Vector3(0, 0, 1).addScaledVector(axis, -axis.z).normalize();
        uAxis = new THREE.Vector3().crossVectors(vAxis, axis).normalize();
      } else {
        uAxis = new THREE.Vector3(1, 0, 0);
        vAxis = new THREE.Vector3().crossVectors(axis, uAxis).normalize();
        uAxis = new THREE.Vector3().crossVectors(vAxis, axis).normalize();
      }
      fam = { axis, uAxis, vAxis, members: [] };
      families.push(fam);
    }
    const facing: 1 | -1 = info.group.normal.dot(fam.axis) >= 0 ? 1 : -1;
    const h = facing * info.group.planeDist;
    const regions = extractGroupRegions2D(info.group, zeroOrigin, fam.uAxis, fam.vAxis);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const r of regions) for (const pt of r[0]) {
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
    }
    fam.members.push({ idx, info, facing, h, regions, bbox: { minX, maxX, minY, maxY } });
  });

  interface ExtractedSlab {
    paired: boolean;
    thickness: number;
    normalN: THREE.Vector3;
    uAxis: THREE.Vector3;
    vAxis: THREE.Vector3;
    origin3D: THREE.Vector3;
    outerPolygon2D: Point2D[];
    innerCutouts2D: Point2D[][];
    blindPockets2D?: BlindPocket2D[];
    rawSkinArea: number;
  }

  const stockMaxM = Math.max(
    options.materialThickness,
    ...(options.stock ?? []).map((s) => s.thicknessMm / 1000)
  );
  const maxPairTh = Math.max(0.03, 1.5 * stockMaxM);
  const consumed = new Set<number>();
  const slabs: ExtractedSlab[] = [];

  for (const fam of families) {
    const bots = fam.members.filter((m) => m.facing === -1 && m.regions.length > 0 && m.info.area >= 0.00005);
    const tops = fam.members.filter((m) => m.facing === 1 && m.regions.length > 0 && m.info.area >= 0.00005);

    interface PairCandidate {
      bot: FamilyMember;
      top: FamilyMember;
      floors: FamilyMember[];
      th: number;
      withinStock: boolean;
      lateral: number;
      combinedArea: number;
    }
    const candidates: PairCandidate[] = [];

    for (const bot of bots) {
      for (const top of tops) {
        if (Math.max(bot.info.area, top.info.area) < 0.0004) continue;
        const th = top.h - bot.h;
        if (th < 0.0002 || th > maxPairTh) continue;

        const envMinX = Math.min(bot.bbox.minX, top.bbox.minX) - 0.5;
        const envMaxX = Math.max(bot.bbox.maxX, top.bbox.maxX) + 0.5;
        const envMinY = Math.min(bot.bbox.minY, top.bbox.minY) - 0.5;
        const envMaxY = Math.max(bot.bbox.maxY, top.bbox.maxY) + 0.5;
        if (
          Math.min(bot.bbox.maxX, top.bbox.maxX) <= Math.max(bot.bbox.minX, top.bbox.minX) ||
          Math.min(bot.bbox.maxY, top.bbox.maxY) <= Math.max(bot.bbox.minY, top.bbox.minY)
        ) {
          // Even a half-lap step has touching or overlapping XY bounds across bot/top;
          // completely separated coplanar islands are distinct parts, not one slab.
          if (
            Math.max(bot.bbox.minX - top.bbox.maxX, top.bbox.minX - bot.bbox.maxX) > 0.5 ||
            Math.max(bot.bbox.minY - top.bbox.maxY, top.bbox.minY - bot.bbox.maxY) > 0.5
          ) {
            continue;
          }
        }

        // Reject if an intermediate parallel skin overlaps `top` or `bot` in 2D
        // interior (e.g. two separate parallel shelves or a closed hollow box).
        let blocked = false;
        const floors: FamilyMember[] = [];
        for (const mid of fam.members) {
          if (mid === bot || mid === top || mid.regions.length === 0) continue;
          if (mid.h <= bot.h + 0.0003 || mid.h >= top.h - 0.0003) continue;
          if (
            mid.bbox.maxX < envMinX || mid.bbox.minX > envMaxX ||
            mid.bbox.maxY < envMinY || mid.bbox.minY > envMaxY
          ) {
            continue;
          }
          const sameSkin = mid.facing > 0 ? top : bot;
          if (regionsInteriorOverlap2D(mid.regions, sameSkin.regions)) {
            blocked = true;
            break;
          }
          floors.push(mid);
        }
        if (blocked) continue;

        const withinStock = th <= 1.5 * stockMaxM + 1e-6;
        if (!withinStock) {
          if (top.info.area < bot.info.area * 0.25 || bot.info.area < top.info.area * 0.25) continue;
        }

        let posArea = top.info.area;
        const posCentroid = top.info.centroid.clone().multiplyScalar(top.info.area);
        let negArea = bot.info.area;
        const negCentroid = bot.info.centroid.clone().multiplyScalar(bot.info.area);
        for (const f of floors) {
          if (f.facing > 0) {
            posArea += f.info.area;
            posCentroid.addScaledVector(f.info.centroid, f.info.area);
          } else {
            negArea += f.info.area;
            negCentroid.addScaledVector(f.info.centroid, f.info.area);
          }
        }
        if (posArea < negArea * 0.25 || negArea < posArea * 0.25) continue;
        posCentroid.divideScalar(posArea);
        negCentroid.divideScalar(negArea);

        const delta = new THREE.Vector3().subVectors(posCentroid, negCentroid);
        delta.addScaledVector(fam.axis, -delta.dot(fam.axis));
        const lateral = delta.length();
        if (lateral > 0.25 * Math.sqrt(Math.max(posArea, negArea))) continue;

        candidates.push({
          bot,
          top,
          floors,
          th,
          withinStock,
          lateral,
          combinedArea: posArea + negArea,
        });
      }
    }

    candidates.sort((a, b) => {
      if (a.withinStock !== b.withinStock) return a.withinStock ? -1 : 1;
      if (Math.abs(b.th - a.th) > 0.0004) return b.th - a.th;
      if (Math.abs(a.lateral - b.lateral) > 1e-4) return a.lateral - b.lateral;
      return b.combinedArea - a.combinedArea;
    });

    for (const cand of candidates) {
      if (consumed.has(cand.bot.idx) || consumed.has(cand.top.idx)) continue;
      consumed.add(cand.bot.idx);
      consumed.add(cand.top.idx);

      const activeFloors = cand.floors.filter((f) => !consumed.has(f.idx));
      const fastSingle =
        activeFloors.length === 0 &&
        cand.bot.regions.length === 1 &&
        cand.top.regions.length === 1 &&
        cand.bot.regions[0].length === cand.top.regions[0].length &&
        Math.abs(cand.bot.info.area - cand.top.info.area) <= 1e-3 * Math.max(cand.bot.info.area, cand.top.info.area);

      const slabRegions = fastSingle
        ? cand.top.regions
        : unionRegions2D([
            ...cand.bot.regions,
            ...cand.top.regions,
            ...activeFloors.flatMap((f) => f.regions),
          ]);

      for (const f of activeFloors) {
        const fs = samplePointInRegion2D(f.regions[0]);
        if (slabRegions.some((sr) => pointInPolygon2D(sr[0], fs))) {
          consumed.add(f.idx);
        }
      }

      const midH = 0.5 * (cand.bot.h + cand.top.h);
      for (const reg of slabRegions) {
        const outerFam = reg[0];
        const holesFam = reg.slice(1);
        let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
        for (const pt of outerFam) {
          if (pt.x < minU) minU = pt.x;
          if (pt.x > maxU) maxU = pt.x;
          if (pt.y < minV) minV = pt.y;
          if (pt.y > maxV) maxV = pt.y;
        }
        const cu = 0.5 * (minU + maxU);
        const cv = 0.5 * (minV + maxV);
        const shiftPt = (p: Point2D): Point2D => ({ x: p.x - cu, y: p.y - cv });

        const pockets: BlindPocket2D[] = [];
        for (const f of activeFloors) {
          const under = f.facing < 0;
          const depthMm = (under ? f.h - cand.bot.h : cand.top.h - f.h) * 1000;
          if (depthMm < 0.1 || depthMm >= cand.th * 1000 - 0.1) continue;

          const raisedRegions: Point2D[][][] = under
            ? [
                ...cand.bot.regions,
                ...activeFloors.filter((o) => o.facing < 0 && o.h < f.h - 0.0003).flatMap((o) => o.regions),
              ]
            : [
                ...cand.top.regions,
                ...activeFloors.filter((o) => o.facing > 0 && o.h > f.h + 0.0003).flatMap((o) => o.regions),
              ];

          for (const fReg of f.regions) {
            const sample = samplePointInRegion2D(fReg);
            if (!pointInPolygon2D(outerFam, sample)) continue;
            const keptHoles = fReg.slice(1).filter((hLoop) => {
              const hs = samplePointInLoop2D(hLoop);
              return raisedRegions.some((rr) => pointInRegion2D(hs, rr));
            });
            pockets.push({
              outer: ensureCCW(fReg[0].map(shiftPt)),
              holes: keptHoles.length > 0 ? keptHoles.map((h) => ensureCW(h.map(shiftPt))) : undefined,
              depthMm,
              under,
            });
          }
        }

        const origin3D = new THREE.Vector3()
          .addScaledVector(fam.axis, midH)
          .addScaledVector(fam.uAxis, cu / 1000)
          .addScaledVector(fam.vAxis, cv / 1000);
        const outerPolygon2D = ensureCCW(outerFam.map(shiftPt));
        const innerCutouts2D = holesFam.map((h) => ensureCW(h.map(shiftPt)));
        const footprintAreaM2 =
          (Math.abs(polygonSignedArea(outerPolygon2D)) -
            innerCutouts2D.reduce((s, h) => s + Math.abs(polygonSignedArea(h)), 0)) *
          1e-6;

        slabs.push({
          paired: true,
          thickness: cand.th,
          normalN: fam.axis.clone(),
          uAxis: fam.uAxis.clone(),
          vAxis: fam.vAxis.clone(),
          origin3D,
          outerPolygon2D,
          innerCutouts2D,
          blindPockets2D: pockets.length > 0 ? pockets : undefined,
          rawSkinArea: Math.max(footprintAreaM2, cand.bot.info.area, cand.top.info.area),
        });
      }
    }
  }

  // Remaining unpaired faces (e.g. a solid mesh shelled into flat panels).
  for (let i = 0; i < infos.length; i++) {
    if (consumed.has(i)) continue;
    const gi = infos[i];
    if (gi.area < 0.0004) continue;
    const normalN = gi.group.normal.clone().normalize();
    let uAxis: THREE.Vector3;
    let vAxis: THREE.Vector3;
    if (Math.abs(normalN.z) < 0.9) {
      vAxis = new THREE.Vector3(0, 0, 1).addScaledVector(normalN, -normalN.z).normalize();
      uAxis = new THREE.Vector3().crossVectors(vAxis, normalN).normalize();
    } else {
      uAxis = new THREE.Vector3(1, 0, 0);
      vAxis = new THREE.Vector3().crossVectors(normalN, uAxis).normalize();
      uAxis = new THREE.Vector3().crossVectors(vAxis, normalN).normalize();
    }
    const origin3D = gi.centroid.clone();
    const regs = extractGroupRegions2D(gi.group, origin3D, uAxis, vAxis);
    for (const reg of regs) {
      slabs.push({
        paired: false,
        thickness: options.materialThickness,
        normalN: normalN.clone(),
        uAxis: uAxis.clone(),
        vAxis: vAxis.clone(),
        origin3D: origin3D.clone(),
        outerPolygon2D: ensureCCW(reg[0]),
        innerCutouts2D: reg.slice(1).map(ensureCW),
        rawSkinArea: gi.area,
      });
    }
  }

  const totalArea = tris.reduce(
    (sum, t) =>
      sum + new THREE.Vector3().subVectors(t.b, t.a).cross(new THREE.Vector3().subVectors(t.c, t.a)).length() * 0.5,
    0
  );
  const totalAreaMm2 = totalArea * 1e6;
  let idCounter = startId;
  // A solid shelled into panels (each face cut from stock, as a box is)
  // must be flat-faced all over: where its sides curve, the panels leave
  // them open, and a cylinder came out as two loose discs.
  let shelledArea = 0;
  const pairedPanels = new Set<number>();
  const stoppedBy = new Map<number, SceneGeom[]>();

  for (const slab of slabs) {
    const { normalN, uAxis, vAxis, origin3D } = slab;

    // Holes modelled as CSG subtractions live on the body, not in the mesh, so
    // they have to be projected on separately — otherwise a laser-cut panel
    // comes out solid where the model has an opening.
    const stoppedIn: SceneGeom[] = [];
    const cutRes = applySubtractiveCutouts2D(
      slab.outerPolygon2D,
      slab.innerCutouts2D,
      diffGeoms,
      bodyMatrix,
      origin3D,
      uAxis,
      vAxis,
      // A paired slab stands either side of its mid-plane; a
      // lone face is a solid's skin, the sheet behind it.
      slab.paired
        ? { lo: -slab.thickness / 2, hi: slab.thickness / 2 }
        : { lo: -slab.thickness, hi: 0 },
      stoppedIn
    );
    const outerPolygon2D = cutRes.outer;
    const innerCutouts2D = cutRes.holes;
    if (outerPolygon2D.length < 3) continue;

    // Reject the edge bands of a sheet rather than cutting them as panels.
    const loopPerimeter = (l: Point2D[]) => {
      let sum = 0;
      for (let i = 0; i < l.length; i++) {
        const a = l[i];
        const b = l[(i + 1) % l.length];
        sum += Math.hypot(b.x - a.x, b.y - a.y);
      }
      return sum;
    };
    const perimeterMm =
      loopPerimeter(outerPolygon2D) +
      innerCutouts2D.reduce((acc, l) => acc + loopPerimeter(l), 0);
    const areaMm2 = slab.rawSkinArea * 1e6;
    const wholePrism =
      slab.paired &&
      Math.abs(totalAreaMm2 - (2 * areaMm2 + perimeterMm * slab.thickness * 1000)) <= 0.03 * totalAreaMm2;
    if (!wholePrism) {
      if (areaMm2 < 1.5 * perimeterMm * slab.thickness * 1000) continue;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const pt of outerPolygon2D) {
        minX = Math.min(minX, pt.x); maxX = Math.max(maxX, pt.x);
        minY = Math.min(minY, pt.y); maxY = Math.max(maxY, pt.y);
      }
      if (Math.min(maxX - minX, maxY - minY) < 2 * slab.thickness * 1000) continue;
    }

    const edges3D: LaserPanelEdge[] = outerPolygon2D.map((pt, idx) => {
      const nxt = outerPolygon2D[(idx + 1) % outerPolygon2D.length];
      return {
        p1: origin3D.clone().addScaledVector(uAxis, pt.x / 1000).addScaledVector(vAxis, pt.y / 1000),
        p2: origin3D.clone().addScaledVector(uAxis, nxt.x / 1000).addScaledVector(vAxis, nxt.y / 1000),
      };
    });

    // Only now: an edge band dropped above is no panel to stop inside.
    stoppedBy.set(idCounter, stoppedIn);
    if (!slab.paired) shelledArea += slab.rawSkinArea;
    else pairedPanels.add(idCounter);

    const panel: LaserPanel = {
      id: `panel_${idCounter++}`,
      name: `${geom.name || nodeName}_poly_${meshPanels.length + 1}`,
      thickness: slab.thickness,
      origin3D,
      normal3D: normalN,
      uAxis3D: uAxis,
      vAxis3D: vAxis,
      outerPolygon2D,
      innerCutouts2D,
      blindPockets2D: slab.blindPockets2D,
      edges3D,
    };

    if (panel.blindPockets2D?.length) {
      const hasTop = panel.blindPockets2D.some((bp) => !bp.under);
      const hasUnder = panel.blindPockets2D.some((bp) => bp.under);
      if (hasUnder && !hasTop) {
        mirrorPanelFrame(panel);
        panel.cutFaceDown = true;
      } else if (hasUnder && hasTop) {
        panel.blindPocketsUnderside = true;
      }
    }

    meshPanels.push(panel);
  }

  const kept = shelledArea > 0 && shelledArea < 0.95 * totalArea
    ? meshPanels.filter((p) => pairedPanels.has(Number(p.id.replace('panel_', ''))))
    : meshPanels;
  for (const p of kept) blind.push(...(stoppedBy.get(Number(p.id.replace('panel_', ''))) ?? []));
  return kept;
}

// ---------------------------------------------------------------------------
// Joint Engine
// ---------------------------------------------------------------------------
//
// Joints are derived from actual 3D panel adjacency rather than being stamped
// onto every edge of every panel. For each pair of panels we intersect their
// mid-planes; if that line runs along a boundary edge of *both* panels (within
// roughly a material thickness) the panels genuinely butt against each other
// there and the overlapping portion becomes one joint.
//
// Along a joint each panel alternates between two offsets measured from its own
// modelled edge: the mating panel's far face (`on` cells, where this panel owns
// the corner) and its near face (`off` cells, where the mating panel does). The
// two are exactly one mating thickness apart, so the pair always interlocks with
// no gap and no overlap regardless of how the model was drawn — a panel whose
// edge already runs to the far face simply gets a zero-depth `on` cell, and one
// that stops at the near face gets a zero-depth `off` cell instead.
//
// Every joint is also pulled back from both of its corners by more than the
// deepest feature it generates, so profiles on perpendicular edges of the same
// panel can never run into each other. That is what the old per-edge, per-panel
// stamping got wrong, and it is where the self-intersections came from.

/** A rectangular in/out feature applied to one boundary edge of one panel. */
interface EdgeFeature {
  edgeIdx: number;
  /** Start/end distance along the edge, measured from its first vertex (mm). */
  ta: number;
  tb: number;
  /** Positive recedes into the panel, negative protrudes outward (mm). */
  depth: number;
}

interface PanelJointWork {
  features: EdgeFeature[];
  mortises: Point2D[][];
  crossLaps: Point2D[][];
}

/**
 * Finger width as a multiple of the stock thickness.
 *
 * Two. A finger narrower than the material is thick is short-grained and snaps
 * out under assembly; much wider than about three thicknesses and there are too
 * few fingers to hold the corner square while the glue goes off. Two sits in
 * the middle of the range every box generator and woodworking text uses, and it
 * reproduces roughly the old fixed 10 mm at the 3-6 mm ply the default was
 * chosen for — so existing thin-stock jobs barely move, and thick stock stops
 * being wrong.
 */
const FINGER_WIDTH_PER_THICKNESS = 2;

/** Bounds on the derived width, in mm. */
const MIN_FINGER_WIDTH_MM = 5;
const MAX_FINGER_WIDTH_MM = 25;

/**
 * The finger width to cut, in mm, for a given stock thickness.
 *
 * Clamped at both ends: below about 5 mm the kerf is a serious fraction of the
 * finger and the fit goes to pieces, and above 25 mm a joint is down to two or
 * three fingers, which no longer holds a corner square.
 */
export function derivedFingerWidthMm(thicknessMm: number): number {
  const wanted = Math.max(thicknessMm, 0) * FINGER_WIDTH_PER_THICKNESS;
  return Math.min(Math.max(wanted, MIN_FINGER_WIDTH_MM), MAX_FINGER_WIDTH_MM);
}

/**
 * What a set of options actually cuts fingers at, in mm.
 *
 * One place, so the dialog can show the number it is about to use rather than
 * leaving the operator to infer it — a derived value nobody can see reads as
 * the setting being ignored.
 */
export function effectiveFingerWidthMm(options: LaserCutOptions): number {
  return options.fingerWidthAuto
    ? derivedFingerWidthMm(options.materialThickness * 1000)
    : options.fingerWidth * 1000;
}

// ---------------------------------------------------------------------------
// Stock inventory
// ---------------------------------------------------------------------------
//
// Stock used to be one size, and everything asked "does this fit the sheet". It
// is now a rack: a list of pieces, each with its own size, thickness and count.
// A rack of one unlimited item is exactly the old behaviour, which is how every
// existing job and every existing caller is left alone.
//
// Thickness is the part that changes how the cut is *made* rather than merely
// where it lands, and it is deliberately an input rather than an outcome. A
// panel's thickness comes from the model — `extractPanelsFromScene` has always
// recorded it — so joints can be sized before anything is packed. Deciding
// thickness by where a panel happened to land would be circular: joints change
// a panel's size, and its size decides where it lands.

/** The rack, normalised. A job always has one of these, even by default. */
export function resolveStock(options: LaserCutOptions): StockItem[] {
  const listed = (options.stock ?? []).filter(
    (s) => s.widthMm > 0 && s.heightMm > 0 && s.thicknessMm > 0 && (s.quantity === null || s.quantity > 0)
  );
  if (listed.length) return listed;
  return [
    {
      widthMm: options.sheetWidth * 1000,
      heightMm: options.sheetHeight * 1000,
      thicknessMm: options.materialThickness * 1000,
      quantity: null,
    },
  ];
}

/** The distinct thicknesses in a rack, thinnest first. */
export function stockThicknesses(stock: StockItem[]): number[] {
  return [...new Set(stock.map((s) => s.thicknessMm))].sort((a, b) => a - b);
}

/**
 * Decides which thickness of stock each panel is cut from.
 *
 * One thickness in the rack and every panel takes it — the old behaviour, and
 * the reason a birdhouse exports today exactly as it did yesterday. Several,
 * and each panel takes the one nearest its own modelled slab: you already said
 * which parts were thick when you drew them, so nothing needs asking twice.
 *
 * Measured against the panel as modelled, never as scaled. Scaling a model down
 * does not make the plywood thinner, and reading a scaled thickness would walk
 * a 9 mm panel onto 3 mm stock at 33%.
 */
/**
 * How much thinner than drawn passes without complaint, as a fraction and as an
 * absolute, whichever is larger.
 *
 * Sheet goods are routinely undersized — "6 mm" ply is very often 5.5 — and
 * refusing to cut a 6 mm model from the 6 mm sheet in the rack because of it
 * would be intolerable. Half a millimetre absorbs that. The case this exists to
 * catch is the real one: 8 mm drawn, 6 mm in the rack.
 */
const THIN_STOCK_TOLERANCE_MM = 0.5;
const THIN_STOCK_TOLERANCE_FRACTION = 0.05;

export function assignPanelThickness(
  panels: LaserPanel[],
  stock: StockItem[],
  options: LaserCutOptions
): { byPanelId: Map<string, number>; warnings: string[]; tooThin: string[] } {
  const available = stockThicknesses(stock);
  const byPanelId = new Map<string, number>();
  const warnings: string[] = [];

  const tooThin: string[] = [];
  /** Thinner than drawn by more than sheet-goods undersizing accounts for. */
  const isTooThin = (cut: number, drawn: number) =>
    drawn - cut > Math.max(THIN_STOCK_TOLERANCE_MM, drawn * THIN_STOCK_TOLERANCE_FRACTION);

  if (available.length === 1) {
    for (const p of panels) {
      byPanelId.set(p.id, available[0]);
      if (isTooThin(available[0], p.thickness * 1000)) {
        tooThin.push(`${p.name} (${(p.thickness * 1000).toFixed(1)} mm drawn, ${available[0].toFixed(1)} mm available)`);
      }
    }
    return { byPanelId, warnings, tooThin };
  }

  const defaultMm = options.materialThickness * 1000;
  const thinner: string[] = [];
  const thicker: string[] = [];
  for (const panel of panels) {
    const wanted = panel.thickness * 1000;
    let best = available[0];
    let bestGap = Infinity;
    for (const t of available) {
      const gap = Math.abs(t - wanted);
      // Ties go to the job's own default thickness, so a model drawn at a
      // thickness the rack does not stock lands somewhere predictable rather
      // than on whichever item was listed first.
      if (gap < bestGap - 1e-6 || (Math.abs(gap - bestGap) < 1e-6 && t === defaultMm)) {
        best = t;
        bestGap = gap;
      }
    }
    byPanelId.set(panel.id, best);
    if (isTooThin(best, wanted)) {
      tooThin.push(`${panel.name} (${wanted.toFixed(1)} mm drawn, ${best.toFixed(1)} mm available)`);
    } else if (bestGap > 0.1) {
      const entry = `${panel.name} (${wanted.toFixed(1)} mm drawn, ${best.toFixed(1)} mm cut)`;
      if (best < wanted) thinner.push(entry);
      else thicker.push(entry);
    }
  }

  /*
   * Thinner and thicker are different problems and are worth saying separately.
   *
   * Cut thinner than drawn and the part is weaker than it was designed to be —
   * the joints still fit each other, because they are sized from the stock, so
   * nothing about the cut looks wrong. That one is only ever caught by being
   * told. Cut thicker and the parts no longer seat where the model spaced them,
   * which at least shows up as panels that will not close.
   *
   * Neither refuses. A thinner box still goes together, and the app cannot
   * judge whether this one carries a load; the operator can. What it must not
   * do is substitute silently.
   */
  const list = (items: string[]) =>
    `${items.slice(0, 4).join(', ')}${items.length > 4 ? `, +${items.length - 4} more` : ''}`;
  if (thinner.length) {
    warnings.push(
      `Cut from thinner stock than modelled (${list(thinner)}); joints are adjusted to match stock thickness.`
    );
  }
  if (thicker.length) {
    warnings.push(
      `Cut from thicker stock than modelled (${list(thicker)}); joints fit the stock, but face-to-face panel spacing follows the model.`
    );
  }

  return { byPanelId, warnings, tooThin };
}

const JOINT_PARALLEL_COS = 0.985;
const EDGE_PARALLEL_TOL = 0.03;
const MIN_FEATURE_MM = 0.2;

function v3(p: Point3D): THREE.Vector3 {
  return p instanceof THREE.Vector3 ? p : new THREE.Vector3(p.x, p.y, p.z);
}

function cross2(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

function ensureCCW(pts: Point2D[]): Point2D[] {
  return polygonSignedArea(pts) < 0 ? [...pts].reverse() : pts;
}

/** Projects a world-space point into a panel's local 2D frame (mm). */
function toPanel2D(panel: LaserPanel, p: THREE.Vector3): Point2D {
  const d = p.clone().sub(v3(panel.origin3D));
  return { x: d.dot(v3(panel.uAxis3D)) * 1000, y: d.dot(v3(panel.vAxis3D)) * 1000 };
}

interface EdgeMatch {
  edgeIdx: number;
  /** Inward distance from the edge line to the joint line (mm, may be negative). */
  dEdge: number;
  /** Joint-line parameters of the edge's two endpoints. */
  s0: number;
  s1: number;
  /** +1 if the edge runs with the joint line direction, -1 against. */
  sign: number;
  /** Joint-line parameter at the edge's first vertex. */
  sAtE0: number;
}

/**
 * Finds the boundary edge of `panel` that lies along the given 3D line, within
 * `tolMm`. Returns null when the line crosses the panel's interior or misses it,
 * which is how non-adjacent panels (and roof panels resting on a wall) get
 * rejected instead of sprouting spurious fingers.
 */
function matchPanelEdgeToLine(
  panel: LaserPanel,
  linePoint: THREE.Vector3,
  lineDir: THREE.Vector3,
  tolMm: number
): EdgeMatch | null {
  const poly = panel.outerPolygon2D;
  if (poly.length < 3) return null;

  const q = toPanel2D(panel, linePoint);
  const uAxis = v3(panel.uAxis3D);
  const vAxis = v3(panel.vAxis3D);
  let wx = lineDir.dot(uAxis);
  let wy = lineDir.dot(vAxis);
  const wLen = Math.hypot(wx, wy);
  if (wLen < 0.9) return null; // line is not (close to) in-plane
  wx /= wLen;
  wy /= wLen;

  let best: EdgeMatch | null = null;
  let bestDist = Infinity;

  for (let i = 0; i < poly.length; i++) {
    const e0 = poly[i];
    const e1 = poly[(i + 1) % poly.length];
    const dx = e1.x - e0.x;
    const dy = e1.y - e0.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-3) continue;

    const ex = dx / len;
    const ey = dy / len;
    if (Math.abs(cross2(ex, ey, wx, wy)) > EDGE_PARALLEL_TOL) continue;

    // Perpendicular distance from the joint line to this edge.
    const dist = Math.abs(cross2(e0.x - q.x, e0.y - q.y, wx, wy));
    if (dist > tolMm || dist >= bestDist) continue;

    // Inward normal of a CCW polygon edge.
    const mx = -ey;
    const my = ex;
    const dEdge = (q.x - e0.x) * mx + (q.y - e0.y) * my;

    const sAtE0 = (e0.x - q.x) * wx + (e0.y - q.y) * wy;
    const sAtE1 = (e1.x - q.x) * wx + (e1.y - q.y) * wy;

    bestDist = dist;
    best = {
      edgeIdx: i,
      dEdge,
      s0: Math.min(sAtE0, sAtE1),
      s1: Math.max(sAtE0, sAtE1),
      sign: ex * wx + ey * wy >= 0 ? 1 : -1,
      sAtE0,
    };
  }

  return best;
}

/** Maps a joint-line parameter to a distance along the matched edge. */
function sToEdgeT(m: EdgeMatch, s: number): number {
  return m.sign > 0 ? s - m.sAtE0 : m.sAtE0 - s;
}

/**
 * Detects every panel-to-panel joint in the scene and records the resulting
 * edge features / mortises per panel.
 */
/** A detected panel-to-panel joint, before its finger cells have been laid out. */
interface RawJoint {
  ia: number;
  ib: number;
  mA: EdgeMatch;
  mB: EdgeMatch;
  /** Offsets from each panel's edge to the mate's near face (recede, positive). */
  offA: number;
  offB: number;
  /** ...and to the mate's far face (own the corner; negative means protrude). */
  onA: number;
  onB: number;
  /** Raw overlap of the two edges, in joint-line parameters. */
  lo: number;
  hi: number;
  tA: number;
  tB: number;
  /**
   * Stock thickness each panel is cut from (mm).
   *
   * Two, not one: a tab has to span the material it passes *through*, so A's
   * reach is sized from B's stock and B's from A's. With one stock size they
   * are equal and this is the figure the joint was always sized for.
   */
  stockA: number;
  stockB: number;
  /**
   * Which side can act as the mortised (female) panel in Tab & Slot mode, i.e.
   * has enough material beyond the mate's slab for the slot to be an interior
   * hole. -1 when neither does and the joint has to fall back to fingers.
   */
  slotFemale: 0 | 1 | -1;
  /** Inward distance from the female panel's edge to the near side of the slot. */
  mortiseInner: number;
}

function jointPanel(j: RawJoint, side: 0 | 1) {
  return side === 0
    ? { idx: j.ia, m: j.mA, off: j.offA, on: j.onA }
    : { idx: j.ib, m: j.mB, off: j.offB, on: j.onB };
}

/** Detects every panel pair that butts along a shared boundary edge. */
function detectJoints(
  panels: LaserPanel[],
  options: LaserCutOptions,
  thicknessOf: (panel: LaserPanel) => number
): RawJoint[] {
  // Joints are sized from the stock being cut, not from how thick the panels
  // happen to have been drawn. A tab has to span the material it passes through,
  // so a model drawn in 3 mm and cut from 6 mm needs 6 mm tabs — sizing them off
  // the model instead is what made the thickness setting look inert.
  //
  // With a mixed rack there is no single answer, so each panel brings its own:
  // a 6 mm back let into 18 mm sides needs 18 mm tabs on the back and 6 mm
  // notches in the sides, not one figure applied to both.
  const overhangMm = Math.max(0, options.tabOverhang * 1000);
  const joints: RawJoint[] = [];

  for (let ia = 0; ia < panels.length; ia++) {
    for (let ib = ia + 1; ib < panels.length; ib++) {
      const A = panels[ia];
      const B = panels[ib];

      const nA = v3(A.normal3D).clone().normalize();
      const nB = v3(B.normal3D).clone().normalize();
      if (Math.abs(nA.dot(nB)) > JOINT_PARALLEL_COS) continue; // parallel / coplanar

      const tA = A.thickness * 1000;
      const tB = B.thickness * 1000;

      // Intersection line of the two mid-planes.
      const dA = nA.dot(v3(A.origin3D));
      const dB = nB.dot(v3(B.origin3D));
      const dir = new THREE.Vector3().crossVectors(nA, nB);
      const dir2 = dir.lengthSq();
      if (dir2 < 1e-9) continue;
      const p0 = new THREE.Vector3()
        .addScaledVector(nB, dA)
        .addScaledVector(nA, -dB)
        .cross(dir)
        .divideScalar(dir2);
      const dirN = dir.clone().normalize();

      // The line must run along a boundary edge of both panels. A butt joint puts
      // it half a thickness inside each panel, hence the tolerance. Panels that
      // merely cross (a roof plane sweeping over a wall) are rejected here.
      // Panels meeting at an angle present a wider cross-section to each other:
      // a slab of thickness t crossing at angle b spans t / sin(b) measured in
      // the other panel's plane. Every depth below is scaled by that factor, so
      // a roof ridge interlocks as exactly as a right-angled corner does.
      const invSin = 1 / Math.sqrt(dir2);
      // Each panel's own stock, and the reach *into* it that its mate must
      // span. A's features are sized from B's material and vice versa.
      const stockA = thicknessOf(A);
      const stockB = thicknessOf(B);
      const reachA = (stockB / 2) * invSin;
      const reachB = (stockA / 2) * invSin;

      // A plain butt joint puts the line half a thickness inside each panel, but
      // a panel can also be set into its neighbour's face (a floor sitting above
      // the bottom of its walls). Allowing a further thickness covers that
      // without admitting panels that merely cross each other far from an edge.
      //
      // Measured against the model's own slabs, never the stock. Whether two
      // panels touch is a fact about the drawing; the stock only decides how deep
      // the resulting fingers are cut. Sizing the search off a stock thicker than
      // the model widens it until a roof sweeping over a wall lands inside the
      // tolerance and sprouts fingers along an edge it never meets — which is
      // exactly what a scaled-down cut does, shrinking the model away from a
      // fixed sheet thickness.
      const modelT = Math.max(tA, tB);
      const tol = (modelT / 2) * invSin + modelT + 0.6;
      const mA = matchPanelEdgeToLine(A, p0, dirN, tol);
      if (!mA) continue;
      const mB = matchPanelEdgeToLine(B, p0, dirN, tol);
      if (!mB) continue;

      // 'off' recedes to the mate's near face; 'on' reaches its far face, plus
      // any overhang the user asked for on top. Overhang is how far the tab
      // stands proud measured off the mate's face, so on an angled joint it
      // spans the same 1 / sin(b) that the thickness does — without that factor
      // a ridge tab lands short of the amount asked for.
      const proud = overhangMm * invSin;
      const offA = mA.dEdge + reachA;
      const onA = mA.dEdge - reachA - proud;
      const offB = mB.dEdge + reachB;
      const onB = mB.dEdge - reachB - proud;
      // A panel sitting entirely past its neighbour's near face is not a joint.
      // Check contact against the model's own slabs (with the same 0.6 mm tolerance
      // used for edge-to-line matching) so sibling bodies touching edge-to-edge or
      // cut from slightly thinner stock still form joints.
      const modelOffA = mA.dEdge + (tB / 2) * invSin;
      const modelOffB = mB.dEdge + (tA / 2) * invSin;
      if (modelOffA < -0.6 || modelOffB < -0.6) continue;

      const lo = Math.max(mA.s0, mB.s0);
      const hi = Math.min(mA.s1, mB.s1);
      if (hi - lo < Math.max(6, 1.5 * Math.max(tA, tB))) continue;

      // A mortise has to be a closed hole, so the female panel needs material
      // beyond the tenon's slab. Either side may qualify; prefer whichever has
      // more room rather than always mortising the same one.
      const roomA = mA.dEdge - reachA;
      const roomB = mB.dEdge - reachB;
      const bestRoom = Math.max(roomA, roomB);
      const slotFemale: 0 | 1 | -1 = bestRoom < 0.8 ? -1 : (roomA >= roomB ? 0 : 1);

      joints.push({
        ia, ib, mA, mB, offA, offB, onA, onB, lo, hi, tA, tB, stockA, stockB,
        slotFemale,
        mortiseInner: bestRoom,
      });
    }
  }

  return joints;
}

/**
 * Where two jointed edges of the same panel meet at a corner, both panels cannot
 * cut away the corner square — one of them has to keep it. This works out, per
 * joint end, which panel needs to own the end cell so that its recesses on the
 * two edges never run into each other. A `null` means either panel will do.
 */
/** What each end of a joint does about the corner it runs into. */
interface CornerPlan {
  lo: number | null;
  hi: number | null;
  insetLo: number;
  insetHi: number;
  /**
   * Per end, per side: whether that panel's inset band should be pared back to
   * the mate's near face instead of left at full width.
   *
   * A pull-back leaves the panel's plain edge running into the corner. Where the
   * neighbouring cells recede past that edge — which is what happens once both
   * panels want the corner and neither can have it — the untouched band is left
   * standing proud of them: a small block, joined to nothing, that has to be
   * snapped off the finished part. Cutting the band to the same depth as the
   * cells beside it merges the two into one straight run and the block is never
   * cut in the first place. Only sound where receding is safe at all, so an
   * obtuse corner (which a recess would pare to a feather) keeps its material.
   */
  trimLo: [boolean, boolean];
  trimHi: [boolean, boolean];
}

function resolveCornerOwners(
  panels: LaserPanel[],
  joints: RawJoint[]
): CornerPlan[] {
  // Index joints by the panel edge they sit on.
  const byPanelEdge = new Map<string, RawJoint[]>();
  for (const j of joints) {
    for (const side of [0, 1] as const) {
      const p = jointPanel(j, side);
      const key = `${p.idx}:${p.m.edgeIdx}`;
      if (!byPanelEdge.has(key)) byPanelEdge.set(key, []);
      byPanelEdge.get(key)!.push(j);
    }
  }

  const tSpan = (j: RawJoint, m: EdgeMatch) => {
    const a = sToEdgeT(m, j.lo);
    const b = sToEdgeT(m, j.hi);
    return { t0: Math.min(a, b), t1: Math.max(a, b) };
  };

  /** Unit direction and outward normal of a polygon edge (outlines are CCW). */
  const edgeFrame = (poly: Point2D[], edgeIdx: number) => {
    const a = poly[edgeIdx];
    const b = poly[(edgeIdx + 1) % poly.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const dx = (b.x - a.x) / len;
    const dy = (b.y - a.y) / len;
    return { len, dir: { x: dx, y: dy }, out: { x: dy, y: -dx } };
  };

  /** Which corner a joint end sits nearest, and the edge that meets it there. */
  const cornerAt = (p: { idx: number; m: EdgeMatch }, s: number) => {
    const poly = panels[p.idx].outerPolygon2D;
    const n = poly.length;
    const here = edgeFrame(poly, p.m.edgeIdx);
    const t = sToEdgeT(p.m, s);
    const atStart = t <= here.len - t;
    return {
      poly,
      dist: Math.max(0, atStart ? t : here.len - t),
      here,
      // Points along this edge, away from the corner.
      u: atStart ? here.dir : { x: -here.dir.x, y: -here.dir.y },
      adjEdge: atStart ? (p.m.edgeIdx - 1 + n) % n : (p.m.edgeIdx + 1) % n,
      atStart,
    };
  };

  /**
   * Whether a feature reaching this corner would spoil it.
   *
   * At a right angle it never does: a tab extends the silhouette squarely and a
   * recess leaves a clean square notch, which is why box corners can be cut
   * right to the end. At an obtuse corner both go wrong — a tab juts out past
   * the adjoining edge, and a recess pares the corner down to a feather. Either
   * way the joint has to stop short, so the test is simply whether an obtuse
   * corner lies within reach of the joint's end.
   */
  /**
   * How far from a corner a tab of height `h` has to start before it stops
   * jutting out past the adjoining edge.
   *
   * Zero at a right angle — a tab there grows straight out along its own edge,
   * however long it is. At an obtuse corner it leans across, and the taller the
   * tab the further back it has to begin. Solving for where the tab's near
   * corner crosses the adjoining edge's line gives the distance exactly.
   */
  const tabClearance = (c: ReturnType<typeof cornerAt>, h: number): number => {
    if (h < MIN_FEATURE_MM) return 0;
    const adj = edgeFrame(c.poly, c.adjEdge);
    const mm = c.here.out.x * adj.out.x + c.here.out.y * adj.out.y;
    if (mm <= 1e-9) return 0; // tab leans away from the adjoining edge
    const um = c.u.x * adj.out.x + c.u.y * adj.out.y;
    if (um >= -1e-9) return c.here.len; // edges diverge; pull back off this edge
    return Math.min((h * mm) / -um, c.here.len);
  };

  /** A corner wider than a right angle, where cuts and tabs both misbehave. */
  const isObtuse = (c: ReturnType<typeof cornerAt>): boolean => {
    const adj = edgeFrame(c.poly, c.adjEdge);
    // Direction along the adjoining edge, away from the shared corner.
    const w = c.atStart ? { x: -adj.dir.x, y: -adj.dir.y } : adj.dir;
    return c.u.x * w.x + c.u.y * w.y < -0.087; // interior angle wider than ~95 degrees
  };

  /**
   * What this panel needs from the end cell of a joint.
   *
   * `prefer` is the parity that keeps the corner clean: 'recede' when owning
   * would put a jutting tab there, 'own' when receding would pare the corner to
   * a feather or collide with the adjoining edge's recess. Honouring it costs
   * `softInset` (usually nothing); overriding it costs `hardInset`.
   *
   * Parity is what makes long tabs affordable. Pulling the joint back by a tab's
   * own length would strip the fingers either side of every corner, whereas
   * putting the recess at the corner leaves the tab a whole cell inboard, where
   * it has all the room it needs.
   */
  interface CornerNeed {
    prefer: 'own' | 'recede' | null;
    softInset: number;
    hardInset: number;
    /** Whether receding at this corner would pare it to a feather. */
    recBad: boolean;
  }

  const cornerNeed = (j: RawJoint, side: 0 | 1, end: 'lo' | 'hi'): CornerNeed => {
    const p = jointPanel(j, side);
    const c = cornerAt(p, end === 'lo' ? j.lo : j.hi);

    const tabH = Math.max(0, -p.on);
    const recH = Math.max(0, p.off);

    const tabCrit = tabClearance(c, tabH);
    const tabBad = c.dist < tabCrit - 1e-6;
    const recBad = recH >= MIN_FEATURE_MM && isObtuse(c) && c.dist < recH - 1e-6;

    let collides = false;
    if (recH >= MIN_FEATURE_MM) {
      const adjLen = edgeFrame(c.poly, c.adjEdge).len;
      for (const j2 of byPanelEdge.get(`${p.idx}:${c.adjEdge}`) || []) {
        if (j2 === j) continue;
        const side2: 0 | 1 = j2.ia === p.idx && j2.mA.edgeIdx === c.adjEdge ? 0 : 1;
        const p2 = jointPanel(j2, side2);
        if (p2.idx !== p.idx || p2.off < MIN_FEATURE_MM) continue;

        // How close the neighbouring joint comes to the same corner.
        const s2 = tSpan(j2, p2.m);
        const dist2 = Math.max(0, c.atStart ? adjLen - s2.t1 : s2.t0);

        // The two recesses overlap only if each reaches into the other's depth.
        if (c.dist < p2.off - 1e-6 && dist2 < p.off - 1e-6) {
          collides = true;
          break;
        }
      }
    }

    // Receding is the cheap escape from a jutting tab, so it wins where the two
    // pull in opposite directions; the pull-back covers whichever is left over.
    if (tabBad) {
      return {
        prefer: 'recede',
        softInset: recBad ? recH : 0,
        hardInset: Math.max(tabCrit, recBad ? recH : 0),
        recBad,
      };
    }
    if (recBad || collides) {
      return { prefer: 'own', softInset: 0, hardInset: recH, recBad };
    }
    return { prefer: null, softInset: 0, hardInset: 0, recBad };
  };

  return joints.map(j => {
    const result: CornerPlan = {
      lo: null, hi: null, insetLo: 0, insetHi: 0,
      trimLo: [false, false], trimHi: [false, false],
    };
    for (const end of ['lo', 'hi'] as const) {
      const needA = cornerNeed(j, 0, end);
      const needB = cornerNeed(j, 1, end);

      // Each panel's preference names who should own the corner; one wanting to
      // recede is the same as saying the other should own it.
      const aOwns = needA.prefer === 'own' || needB.prefer === 'recede';
      const bOwns = needB.prefer === 'own' || needA.prefer === 'recede';
      // Both wanting the same side is the only case parity cannot settle.
      const deadlocked = aOwns && bOwns;

      // Any pull-back leaves at least a full thickness of material at the
      // corner, so the web there is never more fragile than the sheet itself.
      // The floor is the stock, not the tab length — that is what stops a long
      // tab from stripping the fingers either side of every corner.
      const raw = deadlocked
        ? Math.max(needA.hardInset, needB.hardInset)
        : Math.max(needA.softInset, needB.softInset);
      const inset = raw > 0 ? Math.max(raw, Math.max(j.stockA, j.stockB)) : 0;

      if (end === 'lo') result.insetLo = inset;
      else result.insetHi = inset;

      // Only a deadlock strands a band with recesses on both sides of it; a
      // pull-back either panel asked for on its own has a reason to keep the
      // material there.
      if (deadlocked && inset > 0) {
        const trim: [boolean, boolean] = [!needA.recBad, !needB.recBad];
        if (end === 'lo') result.trimLo = trim;
        else result.trimHi = trim;
      }

      if (!deadlocked) {
        if (aOwns) result[end] = j.ia;
        else if (bOwns) result[end] = j.ib;
      }
    }
    return result;
  });
}

function lineIntervalInPanel2D(
  panel: LaserPanel,
  linePoint: THREE.Vector3,
  lineDir: THREE.Vector3
): {
  q: Point2D;
  w: Point2D;
  intervals: [number, number][];
  perpClearanceAt: (s: number) => { pos: number; neg: number } | null;
} | null {
  const poly = panel.outerPolygon2D;
  if (poly.length < 3) return null;

  const q = toPanel2D(panel, linePoint);
  const uAxis = v3(panel.uAxis3D);
  const vAxis = v3(panel.vAxis3D);
  let wx = lineDir.dot(uAxis);
  let wy = lineDir.dot(vAxis);
  const wLen = Math.hypot(wx, wy);
  if (wLen < 0.9) return null;
  wx /= wLen;
  wy /= wLen;
  const nx = -wy;
  const ny = wx;

  const sHits: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const d0 = (a.x - q.x) * nx + (a.y - q.y) * ny;
    const d1 = (b.x - q.x) * nx + (b.y - q.y) * ny;
    if ((d0 <= 0 && d1 > 0) || (d1 <= 0 && d0 > 0)) {
      const t = d0 / (d0 - d1);
      const px = a.x + t * (b.x - a.x);
      const py = a.y + t * (b.y - a.y);
      sHits.push((px - q.x) * wx + (py - q.y) * wy);
    }
  }
  sHits.sort((a, b) => a - b);
  const intervals: [number, number][] = [];
  for (let k = 0; k + 1 < sHits.length; k += 2) {
    if (sHits[k + 1] - sHits[k] > 1e-3) intervals.push([sHits[k], sHits[k + 1]]);
  }
  if (intervals.length === 0) return null;

  const region = [ensureCCW(poly), ...panel.innerCutouts2D.map(ensureCW)];
  const perpClearanceAt = (s: number): { pos: number; neg: number } | null => {
    const px = q.x + wx * s;
    const py = q.y + wy * s;
    if (!pointInRegion2D({ x: px, y: py }, region)) return null;
    let pos = Infinity;
    let neg = Infinity;
    for (const loop of region) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        const u0 = (a.x - px) * wx + (a.y - py) * wy;
        const u1 = (b.x - px) * wx + (b.y - py) * wy;
        if ((u0 <= 0 && u1 > 0) || (u1 <= 0 && u0 > 0)) {
          const t = u0 / (u0 - u1);
          const hx = a.x + t * (b.x - a.x);
          const hy = a.y + t * (b.y - a.y);
          const d = (hx - px) * nx + (hy - py) * ny;
          if (d >= 0) pos = Math.min(pos, d);
          if (d <= 0) neg = Math.min(neg, -d);
        }
      }
    }
    if (!Number.isFinite(pos) || !Number.isFinite(neg)) return null;
    return { pos, neg };
  };

  return { q, w: { x: wx, y: wy }, intervals, perpClearanceAt };
}

function rectAlongLine2D(
  q: Point2D,
  w: Point2D,
  sa: number,
  sb: number,
  widthMm: number
): Point2D[] {
  const s0 = Math.min(sa, sb);
  const s1 = Math.max(sa, sb);
  const hw = widthMm / 2;
  const nx = -w.y;
  const ny = w.x;
  const at = (s: number, d: number): Point2D => ({
    x: q.x + w.x * s + nx * d,
    y: q.y + w.y * s + ny * d,
  });
  return [at(s0, -hw), at(s1, -hw), at(s1, hw), at(s0, hw)];
}

function buildJointWork(
  panels: LaserPanel[],
  options: LaserCutOptions,
  fallbacks: string[],
  thicknessOf: (panel: LaserPanel) => number
): PanelJointWork[] {
  const work: PanelJointWork[] = panels.map(() => ({ features: [], mortises: [], crossLaps: [] }));
  const fingerWidthMm = effectiveFingerWidthMm(options);
  const kerfMm = options.kerf * 1000;
  const clearanceMm = options.jointClearance * 1000;
  const overhangMm = Math.max(0, options.tabOverhang * 1000);
  // Across a finger's width, the fit is whatever the user asked for on top of
  // the kerf. Along its depth only the kerf matters — that governs whether a tab
  // bottoms out, not how tightly it grips.
  const widthHalf = (kerfMm - clearanceMm) / 2;
  const depthHalf = kerfMm / 2;

  // Cut profiles are computed against a CCW outline so "inward" is unambiguous.
  for (const panel of panels) {
    panel.outerPolygon2D = ensureCCW(panel.outerPolygon2D);
  }

  const joints = detectJoints(panels, options, thicknessOf);
  const owners = resolveCornerOwners(panels, joints);

  const pushFeature = (panelIdx: number, m: EdgeMatch, sa: number, sb: number, depth: number) => {
    if (Math.abs(depth) < 1e-6) return;
    const t0 = sToEdgeT(m, sa);
    const t1 = sToEdgeT(m, sb);
    work[panelIdx].features.push({
      edgeIdx: m.edgeIdx,
      ta: Math.min(t0, t1),
      tb: Math.max(t0, t1),
      depth,
    });
  };

  joints.forEach((j, jointIdx) => {
    const { ia, ib, mA, mB, offA, offB, onA, onB, tA, tB } = j;
    const owner = owners[jointIdx];
    const lo = j.lo + owner.insetLo;
    const hi = j.hi - owner.insetHi;
    const span = hi - lo;
    if (span < Math.max(6, 1.5 * Math.max(tA, tB))) return;

    // Cell count and parity are chosen together so the end cells land on the
    // panels that need to own their corners. An odd count gives both ends to the
    // same panel, an even count gives one to each.
    let cells = Math.max(3, Math.round(span / Math.max(fingerWidthMm, 1)));
    const wantSameOwner =
      owner.lo === null || owner.hi === null || owner.lo === owner.hi;
    if (wantSameOwner ? cells % 2 === 0 : cells % 2 === 1) cells += 1;
    const firstOwner = owner.lo ?? owner.hi ?? ia;
    const aOwnsEvenCells = firstOwner === ia;

    const step = span / cells;
    if (step - Math.abs(widthHalf) * 2 < MIN_FEATURE_MM) return;

    // Tab & Slot needs the mortise to sit wholly inside the female panel; it
    // cannot be nudged inward because it has to line up with the male panel's
    // actual slab. Where neither side has the material for that, this joint
    // falls back to fingers and says so.
    const useSlot = options.jointMode === 'slot' && j.slotFemale >= 0;
    if (options.jointMode === 'slot' && !useSlot) {
      fallbacks.push(`${panels[ia].name} \u2194 ${panels[ib].name}`);
    }

    // In slot mode the panel with room to spare is mortised; the other one keeps
    // a straight edge and grows tenons through it.
    const female = j.slotFemale === 1 ? 1 : 0;
    const maleIdx = female === 0 ? ib : ia;
    const femaleIdx = female === 0 ? ia : ib;
    const maleMatch = female === 0 ? mB : mA;
    const femaleMatch = female === 0 ? mA : mB;
    const maleOn = female === 0 ? onB : onA;
    const maleOff = female === 0 ? offB : offA;
    const maleOwnsCell = female === 0 ? !aOwnsEvenCells : aOwnsEvenCells;
    // The tenon is the male panel's own slab passing through the female, so it
    // is that panel's stock — not the female's, and not a single job figure.
    const tenonThickness = maleIdx === ia ? j.stockA : j.stockB;

    const push = pushFeature;

    /** Whether `side`'s panel keeps the material in cell `k` rather than receding. */
    const sideOwnsCell = (side: 0 | 1, k: number): boolean => {
      const even = k % 2 === 0;
      if (useSlot) {
        const maleOwns = even === maleOwnsCell;
        return (side === 0 ? ia : ib) === maleIdx ? maleOwns : !maleOwns;
      }
      const aOwns = even === aOwnsEvenCells;
      return side === 0 ? aOwns : !aOwns;
    };

    for (const end of ['lo', 'hi'] as const) {
      const trim = end === 'lo' ? owner.trimLo : owner.trimHi;
      const k = end === 'lo' ? 0 : cells - 1;
      for (const side of [0, 1] as const) {
        if (!trim[side]) continue;
        if (sideOwnsCell(side, k)) continue;
        const p = jointPanel(j, side);
        if (useSlot && p.idx === femaleIdx) continue;
        push(
          p.idx, p.m,
          end === 'lo' ? p.m.s0 : hi - widthHalf,
          end === 'lo' ? lo + widthHalf : p.m.s1,
          p.off - depthHalf
        );
      }
    }

    for (let k = 0; k < cells; k++) {
      const s0 = lo + k * step;
      const s1 = lo + (k + 1) * step;
      const aOwns = (k % 2 === 0) === aOwnsEvenCells;

      if (useSlot) {
        const maleOwns = (k % 2 === 0) === maleOwnsCell;
        push(maleIdx, maleMatch,
             maleOwns ? s0 - widthHalf : s0 + widthHalf,
             maleOwns ? s1 + widthHalf : s1 - widthHalf,
             (maleOwns ? maleOn : maleOff) - depthHalf);
        if (maleOwns) {
          work[femaleIdx].mortises.push(
            buildMortise(panels[femaleIdx], femaleMatch, s0 + widthHalf, s1 - widthHalf,
                         j.mortiseInner + depthHalf,
                         tenonThickness - kerfMm + clearanceMm)
          );
        }
        continue;
      }

      // Finger joint. Each cell boundary shifts by half a kerf toward whichever
      // side is receding there, so both parts come out at nominal size once the
      // beam width has been burnt away.
      push(ia, mA,
           aOwns ? s0 - widthHalf : s0 + widthHalf,
           aOwns ? s1 + widthHalf : s1 - widthHalf,
           (aOwns ? onA : offA) - depthHalf);
      push(ib, mB,
           aOwns ? s0 + widthHalf : s0 - widthHalf,
           aOwns ? s1 - widthHalf : s1 + widthHalf,
           (aOwns ? offB : onB) - depthHalf);
    }
  });

  // Interior crossings:
  // 1) Cross-lap joints (`!mA && !mB`): two non-parallel sheets crossing through
  //    each other's interiors receive complementary half-length open slots so they
  //    slide together flush (egg-crate grids, X-stands, slotted partitions).
  // 2) T-joints (`Boolean(mA) !== Boolean(mB)`): a divider or shelf whose boundary
  //    edge butts into the middle of another panel receives tenons along its edge
  //    and matching interior mortises in the crossed panel.
  const edgeButtPairs = new Set(joints.map((j) => `${Math.min(j.ia, j.ib)}:${Math.max(j.ia, j.ib)}`));
  for (let ia = 0; ia < panels.length; ia++) {
    for (let ib = ia + 1; ib < panels.length; ib++) {
      if (edgeButtPairs.has(`${ia}:${ib}`)) continue;
      const A = panels[ia];
      const B = panels[ib];
      const nA = v3(A.normal3D).clone().normalize();
      const nB = v3(B.normal3D).clone().normalize();
      if (Math.abs(nA.dot(nB)) > JOINT_PARALLEL_COS) continue;

      const dir = new THREE.Vector3().crossVectors(nA, nB);
      const dir2 = dir.lengthSq();
      if (dir2 < 1e-9) continue;
      const dA = nA.dot(v3(A.origin3D));
      const dB = nB.dot(v3(B.origin3D));
      const p0 = new THREE.Vector3()
        .addScaledVector(nB, dA)
        .addScaledVector(nA, -dB)
        .cross(dir)
        .divideScalar(dir2);
      const dirN = dir.clone().normalize();
      const invSin = 1 / Math.sqrt(dir2);

      const tA = A.thickness * 1000;
      const tB = B.thickness * 1000;
      const stockA = thicknessOf(A);
      const stockB = thicknessOf(B);
      const modelT = Math.max(tA, tB);
      const tol = (modelT / 2) * invSin + modelT + 0.6;
      const mA = matchPanelEdgeToLine(A, p0, dirN, tol);
      const mB = matchPanelEdgeToLine(B, p0, dirN, tol);
      if (mA && mB) continue;

      if (!mA && !mB) {
        const lineA = lineIntervalInPanel2D(A, p0, dirN);
        const lineB = lineIntervalInPanel2D(B, p0, dirN);
        if (!lineA || !lineB) continue;

        const halfNeedA = (stockB * invSin) / 2 + 1.5;
        const halfNeedB = (stockA * invSin) / 2 + 1.5;
        const slotWidthOnA = stockB * invSin - kerfMm + clearanceMm;
        const slotWidthOnB = stockA * invSin - kerfMm + clearanceMm;
        if (slotWidthOnA < MIN_FEATURE_MM || slotWidthOnB < MIN_FEATURE_MM) continue;

        for (const [sA0, sA1] of lineA.intervals) {
          for (const [sB0, sB1] of lineB.intervals) {
            const lo = Math.max(sA0, sB0);
            const hi = Math.min(sA1, sB1);
            const span = hi - lo;
            if (span < Math.max(6, 2 * Math.max(stockA, stockB))) continue;

            const samples = [lo + 0.15 * span, 0.5 * (lo + hi), hi - 0.15 * span];
            const clearBoth = samples.every((s) => {
              const cA = lineA.perpClearanceAt(s);
              const cB = lineB.perpClearanceAt(s);
              return (
                cA !== null &&
                cB !== null &&
                cA.pos >= halfNeedA &&
                cA.neg >= halfNeedA &&
                cB.pos >= halfNeedB &&
                cB.neg >= halfNeedB
              );
            });
            if (!clearBoth) continue;

            const sMid = 0.5 * (lo + hi);
            const endExtra = -depthHalf + clearanceMm / 2;
            const aOpensLo = (lo - sA0) + (sB1 - hi) <= (sA1 - hi) + (lo - sB0);
            const [openA0, openA1] = aOpensLo
              ? [sA0 - 1, sMid + endExtra]
              : [sMid - endExtra, sA1 + 1];
            const [openB0, openB1] = aOpensLo
              ? [sMid - endExtra, sB1 + 1]
              : [sB0 - 1, sMid + endExtra];

            work[ia].crossLaps.push(rectAlongLine2D(lineA.q, lineA.w, openA0, openA1, slotWidthOnA));
            work[ib].crossLaps.push(rectAlongLine2D(lineB.q, lineB.w, openB0, openB1, slotWidthOnB));
          }
        }
        continue;
      }

      // T-joint: one panel's boundary edge meets the interior of the other panel.
      const maleIdx = mA ? ia : ib;
      const femaleIdx = mA ? ib : ia;
      const mMale = (mA ?? mB)!;
      const male = panels[maleIdx];
      const female = panels[femaleIdx];
      const tMale = male.thickness * 1000;
      const tFemale = female.thickness * 1000;
      const stockMale = thicknessOf(male);
      const stockFemale = thicknessOf(female);

      const dNear = mMale.dEdge + (tFemale / 2) * invSin;
      const dFar = mMale.dEdge - (tFemale / 2) * invSin;
      if (dNear < -0.02 * Math.min(tMale, tFemale)) continue;
      if (dFar > 0.5 * tFemale * invSin + 0.2) continue;

      const fLine = lineIntervalInPanel2D(female, p0, dirN);
      if (!fLine) continue;
      const halfNeedF = (stockMale * invSin) / 2 + 1.5;
      const mortiseWidth = stockMale * invSin - kerfMm + clearanceMm;
      if (mortiseWidth < MIN_FEATURE_MM) continue;

      for (const [sF0, sF1] of fLine.intervals) {
        const edgeInset = Math.max(stockMale, stockFemale);
        const lo = Math.max(mMale.s0, sF0 + edgeInset);
        const hi = Math.min(mMale.s1, sF1 - edgeInset);
        const span = hi - lo;
        if (span < Math.max(6, 2 * Math.max(tMale, tFemale))) continue;

        const samples = [lo + 0.15 * span, 0.5 * (lo + hi), hi - 0.15 * span];
        const clearF = samples.every((s) => {
          const cF = fLine.perpClearanceAt(s);
          return cF !== null && cF.pos >= halfNeedF && cF.neg >= halfNeedF;
        });
        if (!clearF) continue;

        let cells = Math.max(3, Math.round(span / Math.max(fingerWidthMm, 1)));
        if (cells % 2 === 0) cells += 1;
        const step = span / cells;
        if (step - Math.abs(widthHalf) * 2 < MIN_FEATURE_MM) continue;

        const proud = overhangMm * invSin;
        const maleOff = mMale.dEdge + (stockFemale / 2) * invSin;
        const maleOn = mMale.dEdge - (stockFemale / 2) * invSin - proud;

        if (lo > mMale.s0 + 1e-6) {
          pushFeature(maleIdx, mMale, mMale.s0, lo + widthHalf, maleOff - depthHalf);
        }
        if (hi < mMale.s1 - 1e-6) {
          pushFeature(maleIdx, mMale, hi - widthHalf, mMale.s1, maleOff - depthHalf);
        }

        for (let k = 0; k < cells; k++) {
          const s0 = lo + k * step;
          const s1 = lo + (k + 1) * step;
          const maleOwns = k % 2 === 1;
          pushFeature(
            maleIdx,
            mMale,
            maleOwns ? s0 - widthHalf : s0 + widthHalf,
            maleOwns ? s1 + widthHalf : s1 - widthHalf,
            (maleOwns ? maleOn : maleOff) - depthHalf
          );
          if (maleOwns) {
            work[femaleIdx].mortises.push(
              rectAlongLine2D(fLine.q, fLine.w, s0 + widthHalf, s1 - widthHalf, mortiseWidth)
            );
          }
        }
      }
    }
  }

  return work;
}

/** Builds one interior mortise rectangle in the female panel's 2D frame. */
function buildMortise(
  panel: LaserPanel,
  m: EdgeMatch,
  sa: number,
  sb: number,
  inner: number,
  depth: number
): Point2D[] {
  const poly = panel.outerPolygon2D;
  const e0 = poly[m.edgeIdx];
  const e1 = poly[(m.edgeIdx + 1) % poly.length];
  const dx = e1.x - e0.x;
  const dy = e1.y - e0.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;

  const ta = sToEdgeT(m, sa);
  const tb = sToEdgeT(m, sb);
  const t0 = Math.min(ta, tb);
  const t1 = Math.max(ta, tb);
  const d0 = inner;
  const d1 = inner + depth;

  const at = (t: number, d: number) => ({
    x: e0.x + ux * t + nx * d,
    y: e0.y + uy * t + ny * d,
  });

  return [at(t0, d0), at(t1, d0), at(t1, d1), at(t0, d1)];
}

/**
 * Rewrites a panel outline, inserting the rectangular in/out features recorded
 * for each edge. Features on one edge are clipped against each other and against
 * the edge's own length, so the result cannot fold back on itself.
 */
/**
 * Rewrites a panel outline, cutting the recorded features into each edge.
 *
 * An edge becomes a run of constant-depth stretches. Where a run reaches a
 * corner the original corner vertex no longer exists — the material there has
 * been cut away — so corners are rebuilt by intersecting the two offset
 * profiles that meet at them. Emitting the modelled corner instead sends the
 * outline diving to a point that isn't on the boundary and straight back out
 * again, which is where the stray hairlines at corners came from.
 */
function applyEdgeFeatures(poly: Point2D[], features: EdgeFeature[], kerfMm: number): Point2D[] {
  if (features.length === 0) return poly;

  const n = poly.length;
  const byEdge = new Map<number, EdgeFeature[]>();
  for (const f of features) {
    if (!byEdge.has(f.edgeIdx)) byEdge.set(f.edgeIdx, []);
    byEdge.get(f.edgeIdx)!.push(f);
  }

  interface EdgeProfile {
    origin: Point2D;
    u: Point2D;          // along the edge
    m: Point2D;          // inward normal
    len: number;
    /** Constant-depth stretches covering [0, len] in order. */
    runs: { t0: number; t1: number; depth: number }[];
  }

  const profiles: EdgeProfile[] = [];

  for (let i = 0; i < n; i++) {
    const e0 = poly[i];
    const e1 = poly[(i + 1) % n];
    const dx = e1.x - e0.x;
    const dy = e1.y - e0.y;
    const len = Math.hypot(dx, dy);
    const u = len < 1e-9 ? { x: 1, y: 0 } : { x: dx / len, y: dy / len };
    const m = { x: -u.y, y: u.x };

    const runs: { t0: number; t1: number; depth: number }[] = [];
    const feats = (byEdge.get(i) || []).slice().sort((a, b) => a.ta - b.ta);

    let cursor = 0;
    for (const f of feats) {
      let ta = Math.max(cursor, f.ta);
      let tb = Math.min(len, f.tb);
      // Kerf compensation nudges a cell boundary in by half a beam width. Where
      // that boundary is the panel's own corner it would leave a nub thinner
      // than the beam cutting it, so snap those onto the corner. By the beam,
      // not a fixed figure: past 0.4 mm of kerf the nub cleared a fixed 0.2 and
      // stood as a fin the full depth of the joint.
      const nub = Math.max(MIN_FEATURE_MM, kerfMm);
      if (ta < nub) ta = 0;
      if (len - tb < nub) tb = len;
      if (tb - ta < MIN_FEATURE_MM) continue;

      // Neighbouring stretches at the same depth are one stretch. Keeping them
      // apart emits a step of zero height, and the pair of points either side of
      // it reads as a sub-kerf segment in the finished path.
      const add = (t0: number, t1: number, depth: number) => {
        const prev = runs[runs.length - 1];
        if (prev && Math.abs(prev.depth - depth) < 1e-9) prev.t1 = t1;
        else runs.push({ t0, t1, depth });
      };

      if (ta > cursor + 1e-9) add(cursor, ta, 0);
      add(ta, tb, f.depth);
      cursor = tb;
    }
    if (cursor < len - 1e-9 || runs.length === 0) {
      const prev = runs[runs.length - 1];
      if (prev && Math.abs(prev.depth) < 1e-9) prev.t1 = len;
      else runs.push({ t0: cursor, t1: len, depth: 0 });
    }

    // What is flush on an edge is one line. Where its tabs grow half a kerf the
    // stretches between them go with them: left behind, each is a jog thinner
    // than the beam that has to cut it.
    const grown = runs.find((r) => r.depth !== 0 && Math.abs(r.depth) <= kerfMm / 2 + 1e-6);
    const line: typeof runs = [];
    for (const r of runs) {
      const depth = grown && r.depth === 0 ? grown.depth : r.depth;
      const prev = line[line.length - 1];
      if (prev && Math.abs(prev.depth - depth) < 1e-9) prev.t1 = r.t1;
      else line.push({ ...r, depth });
    }

    profiles.push({ origin: e0, u, m, len, runs: line });
  }

  const at = (p: EdgeProfile, t: number, d: number): Point2D => ({
    x: p.origin.x + p.u.x * t + p.m.x * d,
    y: p.origin.y + p.u.y * t + p.m.y * d,
  });

  /**
   * Where the outgoing profile of one edge meets the incoming profile of the
   * next. Both are lines parallel to their edge, offset inward by that end's
   * depth; with both depths zero this is exactly the modelled corner.
   */
  const cornerBetween = (prev: EdgeProfile, next: EdgeProfile): Point2D => {
    const dPrev = prev.runs[prev.runs.length - 1].depth;
    const dNext = next.runs[0].depth;
    if (dPrev === 0 && dNext === 0) return next.origin;

    const p1 = at(prev, prev.len, dPrev);
    const p2 = at(next, 0, dNext);
    const cross = prev.u.x * next.u.y - prev.u.y * next.u.x;
    if (Math.abs(cross) < 1e-9) return p2; // collinear edges: no corner to mitre

    const s = ((p2.x - p1.x) * next.u.y - (p2.y - p1.y) * next.u.x) / cross;
    // A near-parallel pair can throw the intersection a long way off; keep the
    // corner local rather than letting it shoot away from the panel.
    if (!Number.isFinite(s) || Math.abs(s) > prev.len + next.len) return p2;
    return { x: p1.x + prev.u.x * s, y: p1.y + prev.u.y * s };
  };

  const out: Point2D[] = [];
  const push = (p: Point2D) => {
    // A rebuilt corner often lands exactly on the step point the edge is about
    // to emit — a tab that reaches the corner has no separate mitre. Emitting
    // both leaves a zero-length move in the path, which some controllers stall
    // on and every cutter fires a needless pierce for.
    const last = out[out.length - 1];
    if (last && Math.hypot(last.x - p.x, last.y - p.y) < 1e-6) return;
    out.push(p);
  };

  for (let i = 0; i < n; i++) {
    const prof = profiles[i];
    push(cornerBetween(profiles[(i - 1 + n) % n], prof));
    // Step between successive depths along the edge; the ends are corners.
    for (let r = 0; r + 1 < prof.runs.length; r++) {
      const t = prof.runs[r].t1;
      push(at(prof, t, prof.runs[r].depth));
      push(at(prof, t, prof.runs[r + 1].depth));
    }
  }

  // The loop closes back onto its first point, so guard that seam too.
  while (
    out.length > 1 &&
    Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < 1e-6
  ) {
    out.pop();
  }

  return out;
}

// ---------------------------------------------------------------------------
// CNC Inside-Corner Relief
// ---------------------------------------------------------------------------

/**
 * Corners shallower than this are left alone. A round bit only strands material
 * worth relieving in a reasonably sharp corner, and the cutouts projected from
 * CSG cylinders arrive as 48-gons whose ~172 degree vertices must not each
 * sprout a relief circle.
 */
const RELIEF_MAX_ANGLE_DEG = 135;

/**
 * How much room the relief leaves the bit beyond its own size, in mm: it may
 * drive this much past the point where its edge reaches the corner, and its
 * travel is this much wide. A relief exactly the bit's own sweep shrinks, once
 * the G-code stands the bit off by its radius, to a path of zero width, which
 * the offset throws away; this keeps it a channel the bit can follow.
 */
const RELIEF_OVERLAP_MM = 0.05;

/** Segments per full turn on a relief's round ends. */
const RELIEF_ARC_STEPS = 48;

/**
 * Cuts inside-corner relief into one closed loop.
 *
 * `loop` must be wound with material on the left — outline CCW, hole CW — so
 * that a right turn is a corner the material wraps around, i.e. one the bit has
 * to reach into. The relief is what the bit sweeps when it is driven on from
 * where its path turns the corner (a radius off both walls) until its edge
 * reaches the corner: along the bisector for a dog-bone, square into the
 * longer wall for a t-bone, so the shorter wall a tenon seats on stays flat.
 * The corner vertex is replaced by that sweep's outline where it runs out into
 * the material.
 *
 * The sweep is drawn rather than left to the G-code because a stood-off path
 * cannot find it: offsetting the outline by the bit radius rounds every inside
 * corner, and the relief is exactly the material that rounding leaves.
 */
function applyCornerRelief(
  loop: Point2D[],
  radiusMm: number,
  style: 'dogbone' | 'tbone'
): { loop: Point2D[]; skipped: number } {
  const n = loop.length;
  if (n < 3 || radiusMm <= 0) return { loop, skipped: 0 };

  const cosLimit = Math.cos(RELIEF_MAX_ANGLE_DEG * Math.PI / 180);
  // Material is on the left of travel either way, so the winding says which
  // side of the loop it is on: enclosed for an outline, outside it for a hole.
  const materialInside = polygonSignedArea(loop) > 0;
  const slack = RELIEF_OVERLAP_MM;

  interface Relief {
    i: number;
    /** The bit centre's travel, start and end, widened by `slack`. */
    travel: Point2D[];
    /** Full convex sweep polygon of the relief cut. */
    sweep: Point2D[];
    /** Where the bit centre stops, the deepest into the material it goes. */
    end: Point2D;
    qA: Point2D;     // crossing on the outgoing edge
    qB: Point2D;     // crossing on the incoming edge
    xAT: number;
    xBT: number;
    aLen: number;
    /** The sweep's outline from qB to qA through the material, both excluded. */
    chain: Point2D[];
  }

  const candidates: Relief[] = [];
  let skipped = 0;

  for (let i = 0; i < n; i++) {
    const p = loop[i];
    const prev = loop[(i - 1 + n) % n];
    const next = loop[(i + 1) % n];

    const bLen = Math.hypot(prev.x - p.x, prev.y - p.y);
    const aLen = Math.hypot(next.x - p.x, next.y - p.y);
    if (aLen < 1e-9 || bLen < 1e-9) continue;

    // Unit directions leaving the corner along each adjacent edge.
    const eB = { x: (prev.x - p.x) / bLen, y: (prev.y - p.y) / bLen };
    const eA = { x: (next.x - p.x) / aLen, y: (next.y - p.y) / aLen };

    // Turn direction: with material on the left, a right turn wraps material
    // around the corner. cross(incoming, outgoing) = cross(-eB, eA).
    const turn = (-eB.x) * eA.y - (-eB.y) * eA.x;
    if (turn >= -1e-9) continue;

    // Angle through the void, straight from the two edge directions.
    const dot = Math.max(-1, Math.min(1, eA.x * eB.x + eA.y * eB.y));
    if (dot < cosLimit) continue; // too shallow to strand material

    const bx = eA.x + eB.x;
    const by = eA.y + eB.y;
    const bl = Math.hypot(bx, by);
    if (bl < 1e-9) continue; // 180 degrees; nothing to relieve
    const v = { x: bx / bl, y: by / bl }; // bisector, into the void
    // Where the stood-off path turns the corner: a radius off both walls.
    const halfAngle = Math.acos(dot) / 2;
    const o = { x: p.x + v.x * radiusMm / Math.sin(halfAngle), y: p.y + v.y * radiusMm / Math.sin(halfAngle) };

    let end: Point2D;
    let side: Point2D; // which way the travel is widened
    let sideBoth: boolean;
    if (style === 'tbone') {
      // Square into the longer wall until the bit's centre is on it; its edge
      // is then on the corner, and it is still a radius off the shorter wall.
      const eL = aLen >= bLen ? eA : eB;
      let nrm = { x: -eL.y, y: eL.x };
      if (nrm.x * v.x + nrm.y * v.y > 0) nrm = { x: -nrm.x, y: -nrm.y };
      const toWall = (o.x - p.x) * -nrm.x + (o.y - p.y) * -nrm.y; // o's distance from the long wall
      end = { x: o.x + nrm.x * (toWall + slack), y: o.y + nrm.y * (toWall + slack) };
      // Widened away from the shorter wall only, so that wall is not touched.
      side = eL;
      sideBoth = false;
    } else {
      // Down the bisector until the bit's edge is on the corner.
      end = { x: p.x + v.x * (radiusMm - slack), y: p.y + v.y * (radiusMm - slack) };
      side = { x: -v.y, y: v.x };
      sideBoth = true;
    }
    const w = sideBoth ? slack / 2 : slack;
    const lo = sideBoth ? -w : 0;
    const travel = [
      { x: o.x + side.x * lo, y: o.y + side.y * lo },
      { x: end.x + side.x * lo, y: end.y + side.y * lo },
      { x: end.x + side.x * w, y: end.y + side.y * w },
      { x: o.x + side.x * w, y: o.y + side.y * w },
    ];

    // The sweep: the travel grown by the bit radius. Each round end is drawn
    // around its circle rather than inside it, so no chord cuts in under the
    // radius and the stood-off path still fits.
    const rc = radiusMm / Math.cos(Math.PI / RELIEF_ARC_STEPS);
    const ring: Point2D[] = [];
    for (const q of travel) {
      for (let k = 0; k < RELIEF_ARC_STEPS; k++) {
        const ang = (k / RELIEF_ARC_STEPS) * Math.PI * 2;
        ring.push({ x: q.x + Math.cos(ang) * rc, y: q.y + Math.sin(ang) * rc });
      }
    }
    const sweep = convexHull2D(ring);

    // Where each edge leaves the sweep, walking out from the corner. The
    // corner is inside it and the sweep is convex, so there is one crossing.
    const exitAlong = (e: Point2D, limit: number): { t: number; k: number } | null => {
      let best: { t: number; k: number } | null = null;
      for (let k = 0; k < sweep.length; k++) {
        const a = sweep[k];
        const b = sweep[(k + 1) % sweep.length];
        const t = raySegment(p, e, a, b);
        if (t !== null && (!best || t > best.t)) best = { t, k };
      }
      return best && best.t > 1e-9 && best.t < limit ? best : null;
    };

    const xA = exitAlong(eA, aLen);
    const xB = exitAlong(eB, bLen);
    if (xA === null || xB === null) { skipped++; continue; }

    const qB = { x: p.x + eB.x * xB.t, y: p.y + eB.y * xB.t };
    const qA = { x: p.x + eA.x * xA.t, y: p.y + eA.y * xA.t };

    // Of the two ways round the sweep between the crossings, take the one in
    // the material — the other runs back through the void the corner opens onto.
    const walk = (dir: 1 | -1): Point2D[] => {
      const out: Point2D[] = [];
      const m = sweep.length;
      // Edge k runs sweep[k] -> sweep[k+1]; leave qB along it in `dir`.
      let k = dir === 1 ? (xB.k + 1) % m : xB.k;
      const stop = dir === 1 ? (xA.k + 1) % m : xA.k;
      for (let guard = 0; guard <= m && k !== stop; guard++) {
        out.push(sweep[k]);
        k = (k + dir + m) % m;
      }
      return out;
    };
    const fwd = walk(1);
    const back = walk(-1);
    const inMaterial = (chain: Point2D[]) => {
      if (chain.length === 0) return false;
      const mid = chain[Math.floor(chain.length / 2)];
      return pointInPolygon2D(loop, mid) === materialInside;
    };
    const chain = inMaterial(fwd) ? fwd : back;

    candidates.push({ i, travel, sweep, end, qA, qB, xAT: xA.t, xBT: xB.t, aLen, chain });
  }

  // A relief is only usable if it stays clear of the rest of the outline. Two
  // of them can also collide with each other without either touching a far
  // edge — except at the two concave corners of the *same* slot/mortise end
  // wall, where the bit centres overlap inside the slot channel that is already
  // being milled out (`slotWidth > bitDiameter`).
  const travelDist = (t: Point2D[], a: Point2D, b: Point2D) =>
    Math.min(...t.map((q, k) => segmentSegmentDist(q, t[(k + 1) % t.length], a, b)));
  const polylinesCross = (c1: Point2D[], c2: Point2D[]): boolean => {
    for (let a = 0; a + 1 < c1.length; a++) {
      for (let b = 0; b + 1 < c2.length; b++) {
        if (segmentSegmentDist(c1[a], c1[a + 1], c2[b], c2[b + 1]) <= 1e-5) return true;
      }
    }
    return false;
  };
  const spliceChains = (c1: Point2D[], c2: Point2D[]): Point2D[] | null => {
    const hits: { posA: number; posB: number; a: number; b: number; pt: Point2D }[] = [];
    for (let a = 0; a + 1 < c1.length; a++) {
      const p1 = c1[a], p2 = c1[a + 1];
      const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
      for (let b = 0; b + 1 < c2.length; b++) {
        const q1 = c2[b], q2 = c2[b + 1];
        const d2x = q2.x - q1.x, d2y = q2.y - q1.y;
        const den = d1x * d2y - d1y * d2x;
        if (Math.abs(den) < 1e-12) continue;
        const dx = q1.x - p1.x, dy = q1.y - p1.y;
        const ta = (dx * d2y - dy * d2x) / den;
        const tb = (dx * d1y - dy * d1x) / den;
        if (ta >= -1e-6 && ta <= 1 + 1e-6 && tb >= -1e-6 && tb <= 1 + 1e-6) {
          const tcA = Math.max(0, Math.min(1, ta));
          const tcB = Math.max(0, Math.min(1, tb));
          hits.push({
            posA: a + tcA,
            posB: b + tcB,
            a,
            b,
            pt: { x: p1.x + d1x * tcA, y: p1.y + d1y * tcA },
          });
        }
      }
    }
    if (hits.length === 0) return null;
    hits.sort((u, v) => u.posA - v.posA);
    const first = hits[0];
    let last = first;
    for (const h of hits) {
      if (h.posB > last.posB) last = h;
    }
    const merged: Point2D[] = c1.slice(0, first.a + 1);
    const pushDedup = (pt: Point2D) => {
      const prev = merged[merged.length - 1];
      if (!prev || Math.hypot(pt.x - prev.x, pt.y - prev.y) > 1e-6) merged.push(pt);
    };
    pushDedup(first.pt);
    pushDedup(last.pt);
    for (let k = last.b + 1; k < c2.length; k++) pushDedup(c2[k]);
    return merged;
  };

  const accepted: Relief[] = [];
  for (const r of candidates) {
    let clear = true;
    const rChain = [r.qB, ...r.chain, r.qA];

    const rMaxReach = radiusMm / Math.cos(Math.PI / RELIEF_ARC_STEPS) + 0.05;
    for (let e = 0; e < n && clear; e++) {
      // The corner's own two edges are what the sweep is meant to cross.
      if (e === r.i || e === (r.i - 1 + n) % n) continue;
      const td = travelDist(r.travel, loop[e], loop[(e + 1) % n]);
      if (td < radiusMm - 1e-6) {
        clear = false;
        break;
      }
      if (td <= rMaxReach) {
        for (let k = 0; k + 1 < rChain.length; k++) {
          if (segmentSegmentDist(rChain[k], rChain[k + 1], loop[e], loop[(e + 1) % n]) <= 1e-5) {
            clear = false;
            break;
          }
        }
      }
    }

    if (clear) {
      for (const o of accepted) {
        const sameSlotEnd =
          ((o.i + 1) % n === r.i && o.aLen >= radiusMm * 2 - 1e-6) ||
          ((r.i + 1) % n === o.i && r.aLen >= radiusMm * 2 - 1e-6);
        if (!sameSlotEnd) {
          const oChain = [o.qB, ...o.chain, o.qA];
          if (Math.hypot(r.end.x - o.end.x, r.end.y - o.end.y) < radiusMm * 2 - 1e-6 || polylinesCross(rChain, oChain)) {
            clear = false;
            break;
          }
        }
      }
    }

    if (clear) accepted.push(r);
    else skipped++;
  }

  if (accepted.length === 0) return { loop, skipped };

  const byIndex = new Map(accepted.map(r => [r.i, r]));
  let startIdx = 0;
  for (let i = 0; i < n; i++) {
    if (!byIndex.has(i)) {
      startIdx = i;
      break;
    }
  }

  const out: Point2D[] = [];
  for (let step = 0; step < n; step++) {
    const idx = (startIdx + step) % n;
    let curR = byIndex.get(idx);
    if (!curR) {
      out.push(loop[idx]);
      continue;
    }
    let curChain: Point2D[] = [curR.qB, ...curR.chain, curR.qA];
    while (step + 1 < n) {
      const nxtIdx = (startIdx + step + 1) % n;
      const nxtR = byIndex.get(nxtIdx);
      if (!nxtR) break;
      const nxtChain = [nxtR.qB, ...nxtR.chain, nxtR.qA];
      const spliced = spliceChains(curChain, nxtChain);
      if (spliced) {
        curChain = spliced;
        curR = nxtR;
        step++;
      } else if (curR.xAT + nxtR.xBT >= curR.aLen - 1e-5) {
        const mid = { x: 0.5 * (curR.qA.x + nxtR.qB.x), y: 0.5 * (curR.qA.y + nxtR.qB.y) };
        curChain = [...curChain.slice(0, -1), mid, ...nxtChain.slice(1)];
        curR = nxtR;
        step++;
      } else {
        break;
      }
    }
    out.push(...curChain);
  }

  return { loop: out, skipped };
}

/** How far along the ray p + t·e it meets segment ab, or null if it does not. */
function raySegment(p: Point2D, e: Point2D, a: Point2D, b: Point2D): number | null {
  const sx = b.x - a.x;
  const sy = b.y - a.y;
  const den = e.x * sy - e.y * sx;
  if (Math.abs(den) < 1e-12) return null;
  const ax = a.x - p.x;
  const ay = a.y - p.y;
  const t = (ax * sy - ay * sx) / den;
  const u = (ax * e.y - ay * e.x) / den;
  return t >= 0 && u >= -1e-9 && u <= 1 + 1e-9 ? t : null;
}

function segmentSegmentDist(a: Point2D, b: Point2D, c: Point2D, d: Point2D): number {
  const o = (p: Point2D, q: Point2D, r: Point2D) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(a, b, c), d2 = o(a, b, d), d3 = o(c, d, a), d4 = o(c, d, b);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(pointSegmentDist(a, c, d), pointSegmentDist(b, c, d), pointSegmentDist(c, a, b), pointSegmentDist(d, a, b));
}

function pointSegmentDist(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-18) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function reliefWarnings(panels: LaserPanel[], options: LaserCutOptions): string[] {
  const skipped = applyCornerReliefToPanels(panels, options);
  if (skipped === 0) return [];
  return [
    `${skipped} inside corner${skipped === 1 ? ' was' : 's were'} left un-relieved — ` +
    `a ${(options.bitDiameter * 1000).toFixed(2)} mm bit does not fit there. Use a smaller ` +
    `bit, or widen the joints, or those corners will need finishing by hand.`,
  ];
}

/** Relieves every panel's outline and cutouts. Returns how many corners had no room. */
function applyCornerReliefToPanels(panels: LaserPanel[], options: LaserCutOptions): number {
  if (options.cornerRelief === 'none') return 0;

  const radiusMm = (options.bitDiameter * 1000) / 2;
  if (radiusMm <= 0) return 0;

  const style = options.cornerRelief;
  let skipped = 0;

  for (const panel of panels) {
    // Outlines carry material inside, holes carry it outside; both want the
    // walk oriented so material is on the left.
    const outer = applyCornerRelief(ensureCCW(panel.outerPolygon2D), radiusMm, style);
    panel.outerPolygon2D = outer.loop;
    skipped += outer.skipped;

    panel.innerCutouts2D = panel.innerCutouts2D.map(cutout => {
      const cw = polygonSignedArea(cutout) > 0 ? cutout.slice().reverse() : cutout;
      const r = applyCornerRelief(cw, radiusMm, style);
      skipped += r.skipped;
      return r.loop;
    });
  }

  return skipped;
}

function applyJointsToPanels(
  panels: LaserPanel[],
  options: LaserCutOptions,
  thicknessOf: (panel: LaserPanel) => number,
  /**
   * The job's one stock thickness, or null when the rack holds several.
   *
   * The model-versus-stock warning below compares a single modelled thickness
   * against a single stock thickness, which only means anything when there *is*
   * one. With a mixed rack `assignPanelThickness` has already reported the
   * panels whose thickness it could not match, and saying it twice in different
   * words would leave the operator working out whether they are the same
   * complaint.
   */
  singleThicknessMm: number | null
): string[] {
  const warnings: string[] = [];

  if (options.jointMode === 'glue') {
    for (const panel of panels) {
      panel.outerPolygon2D = ensureCCW(simplifyPolygon2D(panel.outerPolygon2D));
    }
    warnings.push(...reliefWarnings(panels, options));
    return warnings;
  }

  for (const panel of panels) {
    panel.outerPolygon2D = simplifyPolygon2D(panel.outerPolygon2D);
  }

  const fallbacks: string[] = [];
  const work = buildJointWork(panels, options, fallbacks, thicknessOf);

  const unjointed: string[] = [];
  for (let i = 0; i < panels.length; i++) {
    const panel = panels[i];
    if (
      work[i].features.length === 0 &&
      work[i].mortises.length === 0 &&
      work[i].crossLaps.length === 0 &&
      !panel.splitFrom
    ) {
      unjointed.push(panel.name);
    }
    panel.outerPolygon2D = applyEdgeFeatures(panel.outerPolygon2D, work[i].features, options.kerf * 1000);
    if (work[i].crossLaps.length > 0) {
      const cut = subtractCutoutsFromPanel2D(
        panel.outerPolygon2D,
        panel.innerCutouts2D,
        work[i].crossLaps.map((rect) => [ensureCCW(rect)])
      );
      panel.outerPolygon2D = cut.outer;
      panel.innerCutouts2D = cut.holes;
    }
    for (const mortise of work[i].mortises) {
      panel.innerCutouts2D.push(mortise);
    }
  }

  // Relief comes last: it needs the finished outline, with every finger notch
  // and mortise already cut, because those are what create the inside corners.
  warnings.push(...reliefWarnings(panels, options));

  // A lone part (a disc, a sign, a bracket) joins nothing by design.
  if (unjointed.length > 0 && panels.length > 1) {
    warnings.push(
      `No joints were cut for ${unjointed.join(', ')} — nothing in the model butts against ` +
      `${unjointed.length === 1 ? 'this panel' : 'these panels'} edge-to-edge, so ` +
      `${unjointed.length === 1 ? 'it' : 'they'} will need glue or fixings.`
    );
  }
  // Joints are cut for the stock, but the panels sit where the model put them.
  // If the two disagree badly the parts still interlock, yet the model's own
  // spacing no longer suits the material — a thicker roof sinks into its walls.
  const modelled = panels.map(p => p.thickness * 1000).filter(t => t > 0).sort((a, b) => a - b);
  const stockMm = singleThicknessMm ?? 0;
  if (modelled.length > 0 && singleThicknessMm !== null) {
    const typical = modelled[Math.floor(modelled.length / 2)];
    if (stockMm > 1.5 * typical) {
      warnings.push(
        `Model panels are ${typical.toFixed(1)} mm thick but joints are sized for ${stockMm.toFixed(1)} mm stock; adjacent panels will overlap at corners. Use ~${typical.toFixed(1)} mm stock or scale the model up.`
      );
    } else if (Math.abs(typical - stockMm) > 0.25 * stockMm) {
      warnings.push(
        `Model panels are ${typical.toFixed(1)} mm thick while stock is ${stockMm.toFixed(1)} mm; joints fit the stock, but face-to-face spacing follows the model.`
      );
    }
  }

  if (fallbacks.length > 0) {
    warnings.push(
      `Tab & Slot fell back to finger joints at ${[...new Set(fallbacks)].join(', ')} — ` +
      `a mortise needs the slotted panel to extend past its neighbour's thickness, ` +
      `and these edges are flush.`
    );
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// 2D Panel Packing & SVG Export
// ---------------------------------------------------------------------------

function clonePanels(panels: LaserPanel[]): LaserPanel[] {
  return panels.map(p => ({
    ...p,
    origin3D: { ...p.origin3D },
    normal3D: { ...p.normal3D },
    uAxis3D: { ...p.uAxis3D },
    vAxis3D: { ...p.vAxis3D },
    outerPolygon2D: p.outerPolygon2D.map(pt => ({ ...pt })),
    innerCutouts2D: p.innerCutouts2D.map(loop => loop.map(pt => ({ ...pt }))),
    blindPockets2D: p.blindPockets2D?.map(bp => ({
      ...bp,
      outer: bp.outer.map(pt => ({ ...pt })),
      holes: bp.holes?.map(h => h.map(pt => ({ ...pt }))),
    })),
    engrave2D: p.engrave2D?.map(line => line.map(pt => ({ ...pt }))),
    edges3D: p.edges3D.map(e => ({ ...e, p1: { ...e.p1 }, p2: { ...e.p2 } })),
  }));
}

function scalePanels(panels: LaserPanel[], s: number): void {
  for (const panel of panels) {
    // The slab shrinks with everything else. Leaving it at full size describes a
    // model that no longer exists — one whose panels are thicker than the box
    // they enclose — and every test that asks "do these two panels butt?" or
    // "does the model match the stock?" then reads the wrong number.
    panel.thickness *= s;
    for (const pt of panel.outerPolygon2D) {
      pt.x *= s;
      pt.y *= s;
    }
    for (const loop of [...panel.innerCutouts2D, ...(panel.engrave2D ?? [])]) {
      for (const pt of loop) {
        pt.x *= s;
        pt.y *= s;
      }
    }
    for (const bp of panel.blindPockets2D ?? []) {
      bp.depthMm *= s;
      for (const pt of bp.outer) {
        pt.x *= s;
        pt.y *= s;
      }
      for (const h of bp.holes ?? []) {
        for (const pt of h) {
          pt.x *= s;
          pt.y *= s;
        }
      }
    }
    for (const edge of panel.edges3D) {
      edge.p1.x *= s; edge.p1.y *= s; edge.p1.z *= s;
      edge.p2.x *= s; edge.p2.y *= s; edge.p2.z *= s;
    }
    panel.origin3D.x *= s;
    panel.origin3D.y *= s;
    panel.origin3D.z *= s;
  }
}

/** Measure each panel and shift its loops so the bounding box starts at (0, 0). */
function normalizePanelBounds(panels: LaserPanel[]): void {
  for (const panel of panels) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const visit = (pt: Point2D) => {
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
    };
    panel.outerPolygon2D.forEach(visit);
    for (const cutout of panel.innerCutouts2D) cutout.forEach(visit);

    panel.width2D = maxX - minX;
    panel.height2D = maxY - minY;
    panel.modelOffset2D = { x: minX, y: minY };

    for (const pt of panel.outerPolygon2D) {
      pt.x -= minX;
      pt.y -= minY;
    }
    // Engrave lines and blind pockets move with the panel but never size it.
    for (const loop of [...panel.innerCutouts2D, ...(panel.engrave2D ?? [])]) {
      for (const pt of loop) {
        pt.x -= minX;
        pt.y -= minY;
      }
    }
    for (const bp of panel.blindPockets2D ?? []) {
      for (const pt of bp.outer) {
        pt.x -= minX;
        pt.y -= minY;
      }
      for (const h of bp.holes ?? []) {
        for (const pt of h) {
          pt.x -= minX;
          pt.y -= minY;
        }
      }
    }
  }
}

/**
 * Shelf-pack the panels down a vertical stack of sheets, tallest first so short
 * offcut panels fill the gaps beside a tall one instead of starting a new row.
 * Panels must already be normalized. Writes placedPos2D in sheet-local
 * coordinates plus the sheetIndex it belongs to; the combined SVG stacks sheet
 * N at y = N * sheetHeightMm when it draws.
 */
/**
 * Turns a normalised panel a quarter turn in its own plane.
 *
 * Needed because a long thin part and a long thin offcut only meet if they
 * agree which way round they are: a 240 x 30 length will not go on a 320 x 50
 * bar until one of them turns. Applied to the 2D loops only — the panel's 3D
 * frame is where it sat in the model and has nothing to do with how it is laid
 * on the stock.
 */
function rotatePanel90(panel: LaserPanel): void {
  const h = panel.height2D || 0;
  const turn = (pt: Point2D) => {
    const x = pt.x;
    pt.x = h - pt.y;
    pt.y = x;
  };
  panel.outerPolygon2D.forEach(turn);
  for (const cutout of panel.innerCutouts2D) cutout.forEach(turn);
  for (const bp of panel.blindPockets2D ?? []) {
    bp.outer.forEach(turn);
    for (const hole of bp.holes ?? []) hole.forEach(turn);
  }
  for (const line of panel.engrave2D ?? []) line.forEach(turn);
  const w = panel.width2D || 0;
  panel.width2D = h;
  panel.height2D = w;
  panel.turnedOnSheet = !panel.turnedOnSheet;
}

function packPanels(
  panels: LaserPanel[],
  stock: StockItem[],
  marginMm: number,
  thicknessOf: (panel: LaserPanel) => number,
  outsetMm = 0
): { sheetCount: number; oversized: string[]; offSheet: string[]; unplaced: string[]; sheets: SheetSpec[]; rotated: string[] } {
  const oversized: string[] = [];
  const offSheet: string[] = [];
  const unplaced: string[] = [];
  const sheets: SheetSpec[] = [];
  const rotated: string[] = [];

  /*
   * One packing problem per thickness. A panel can only be cut from stock of
   * its own thickness, so the rack divides into independent racks and the
   * sheets come out grouped — which is also how they get used, since the
   * machine is set up once per material.
   */
  const byThickness = new Map<number, LaserPanel[]>();
  for (const panel of panels) {
    const t = thicknessOf(panel);
    const list = byThickness.get(t);
    if (list) list.push(panel);
    else byThickness.set(t, [panel]);
  }

  for (const thicknessMm of [...byThickness.keys()].sort((a, b) => a - b)) {
    const mine = byThickness.get(thicknessMm)!;
    /*
     * Bins largest first, so a big panel is not stranded because a small
     * offcut was opened for it first — and within a bin, tallest panel first,
     * which is the shelf heuristic that was already here.
     */
    const bins = stock
      .filter((item) => Math.abs(item.thicknessMm - thicknessMm) < 1e-6)
      .sort((a, b) => b.widthMm * b.heightMm - a.widthMm * a.heightMm)
      .map((item) => ({ item, left: item.quantity }));

    const fitsAnywhere = (w: number, h: number) =>
      bins.some(
        (b) => w + 2 * marginMm <= b.item.widthMm && h + 2 * marginMm <= b.item.heightMm
      );

    /*
     * Turn anything that only fits the other way round, before ordering or
     * placing. A part's orientation on the stock is not a property of the part,
     * and refusing to turn it means a long strip and a long bar never meet.
     */
    for (const panel of mine) {
      const w = panel.width2D || 50;
      const h = panel.height2D || 50;
      if (!fitsAnywhere(w, h) && fitsAnywhere(h, w)) {
        rotatePanel90(panel);
        rotated.push(panel.name);
      }
    }

    const order = [...mine].sort((a, b) => (b.height2D || 0) - (a.height2D || 0));

    let openSheet = -1;
    let currentX = marginMm;
    let currentY = marginMm;
    let rowHeight = 0;

    /**
     * Starts a fresh piece of stock, the largest left that holds this panel. A
     * panel that fits nothing takes the largest left, to be drawn overhanging.
     */
    const openNext = (pw: number, ph: number): boolean => {
      const left = bins.filter((b) => b.left === null || b.left > 0);
      const bin = fitsAnywhere(pw, ph)
        ? left.find((b) => pw + 2 * marginMm <= b.item.widthMm && ph + 2 * marginMm <= b.item.heightMm)
        : left[0];
      if (!bin) return false;
      if (bin.left !== null) bin.left -= 1;
      sheets.push({
        widthMm: bin.item.widthMm,
        heightMm: bin.item.heightMm,
        thicknessMm,
      });
      openSheet = sheets.length - 1;
      currentX = marginMm;
      currentY = marginMm;
      rowHeight = 0;
      return true;
    };

    for (const panel of order) {
      const pw = panel.width2D || 50;
      const ph = panel.height2D || 50;
      const fits = fitsAnywhere(pw, ph);

      if (!fits) {
        oversized.push(`${panel.name} (${pw.toFixed(0)} x ${ph.toFixed(0)} mm, ${thicknessMm.toFixed(1)} mm)`);
        if (!bins.some((b) => pw + marginMm + outsetMm <= b.item.widthMm && ph + marginMm + outsetMm <= b.item.heightMm)) offSheet.push(panel.name);
      }

      if (openSheet < 0 && !openNext(pw, ph)) {
        unplaced.push(panel.name);
        continue;
      }

      // Wrap to the next row, then to the next piece of stock. A panel that
      // fits nothing still gets placed — on the last sheet, overhanging and
      // reported — rather than vanishing from the drawing. One that would fit
      // if there were stock left is not placed at all, and the job is refused.
      const sheet = sheets[openSheet];
      if (currentX + pw + marginMm > sheet.widthMm) {
        currentX = marginMm;
        currentY += rowHeight + marginMm;
        rowHeight = 0;
      }
      const pastEdge =
        currentY + ph + marginMm > sheet.heightMm || (fits && currentX + pw + marginMm > sheet.widthMm);
      if (pastEdge && !openNext(pw, ph) && fits) {
        unplaced.push(panel.name);
        continue;
      }

      panel.placedPos2D = { x: currentX, y: currentY };
      panel.sheetIndex = openSheet;
      currentX += pw + marginMm;
      if (ph > rowHeight) rowHeight = ph;
    }
  }

  return { sheetCount: Math.max(sheets.length, 1), oversized, offSheet, unplaced, sheets, rotated };
}

export function exportLaserCutSvg(
  scene: SceneGraph,
  userOptions?: Partial<LaserCutOptions>
): LaserCutResult {
  const options: LaserCutOptions = { ...DEFAULT_LASER_OPTIONS, ...userOptions };

  const extracted = extractPanelsFromScene(scene, options);
  const invalidGeoms = extracted.invalidGeoms;
  let panels = extracted.panels;

  if (extracted.blindCuts.length > 0) {
    return {
      success: false,
      error: `A sheet cut only goes right through, and these stop inside the sheet: ${extracted.blindCuts.join(', ')}. Make them through cuts, or machine the part instead.`,
    };
  }

  if (panels.length === 0) {
    if (invalidGeoms.length > 0) {
      return {
        success: false,
        error: `Nothing here cuts from sheet: ${invalidGeoms.join(
          ', '
        )}. Flat cutting takes parts that are a sheet (any outline, about the stock's thickness) or solids with flat faces all over; a curved solid slices with Contour or unfolds with Unfold.`,
      };
    }
    return {
      success: false,
      error: 'No valid planar panels or box objects found in the scene to cut.',
    };
  }

  const marginMm = options.margin * 1000;

  /*
   * The rack, and which thickness each panel is cut from — both decided here,
   * once, before any scaling. Scaling a model down does not make the plywood
   * thinner, so the assignment is made against the panels as modelled and then
   * carried through every scale probe by panel id.
   */
  const stock = resolveStock(options);
  const thicknesses = stockThicknesses(stock);
  const assignment = assignPanelThickness(panels, stock, options);

  /*
   * Refused, not warned. See `allowThinnerStock`: a part cut thinner than it was
   * drawn assembles perfectly and is quietly weaker than the model called for,
   * so the only moment it can be caught is before the cut.
   */
  if (assignment.tooThin.length && !options.allowThinnerStock) {
    const list = assignment.tooThin.join(', ');
    return {
      success: false,
      error: `Stock is thinner than modelled (${list}). Add matching stock to the rack or pass allowThinnerStock: true.`,
      warnings: assignment.warnings,
    };
  }
  const thicknessOf = (panel: LaserPanel) =>
    assignment.byPanelId.get(panel.splitFrom ?? panel.id) ?? options.materialThickness * 1000;
  const singleThicknessMm = thicknesses.length === 1 ? thicknesses[0] : null;
  const maxSheets = options.maxSheets && options.maxSheets > 0 ? options.maxSheets : 0;

  // Determine scale factor S (1.0 = 100%)
  let scaleFactor = Math.max(0.05, Math.min(2.0, options.scaleFactor ?? 1.0));

  /**
   * Cut, joint and pack a fresh copy of the panels at scale S. Joints have to be
   * applied before measuring: finger tabs stick out by the material thickness and
   * mortises widen an outline, and none of that shrinks with S. Sizing the sheet
   * off the raw faces is what let a "fits in 1 sheet" answer spill onto 2.
   */
  const buildAtScale = (s: number) => {
    let working = clonePanels(panels);
    if (Math.abs(s - 1.0) > 1e-4) scalePanels(working, s);
    /*
     * Split before joints, not after. A strip's mitred ends are part of its
     * outline, and cutting a ring into four *after* its edges had been profiled
     * would slice through whatever the joint engine had put there.
     */
    const localSplitNotes: string[] = [];
    if (options.splitOversized) {
      const divided = splitPanelsToFit(
        working,
        stock,
        thicknessOf,
        marginMm,
        options.kerf * 1000,
        options.jointClearance * 1000
      );
      working = divided.panels;
      localSplitNotes.push(...divided.notes);
    }
    const warnings = applyJointsToPanels(working, options, thicknessOf, singleThicknessMm);
    normalizePanelBounds(working);
    const packed = packPanels(working, stock, marginMm, thicknessOf, (options.cutOutset ?? 0) * 1000);
    return { panels: working, warnings: [...assignment.warnings, ...localSplitNotes, ...warnings], ...packed };
  };

  const fits = (b: { sheetCount: number; oversized: string[]; unplaced: string[] }) =>
    b.oversized.length === 0 && b.unplaced.length === 0 && (maxSheets === 0 || b.sheetCount <= maxSheets);

  // Search from full size (auto) or the user's own scale (manual + sheet cap) for
  // the largest scale that still respects the sheet budget. Percent steps,
  // bisected — each probe is a full joint + pack pass, so keep the count low.
  const searching = options.autoScale || maxSheets > 0;
  const startPct = Math.round((options.autoScale ? 1.0 : scaleFactor) * 100);
  let build = buildAtScale((searching ? startPct : Math.round(scaleFactor * 100)) / 100);

  if (searching) {
    let candidate = build;
    if (fits(candidate)) {
      scaleFactor = startPct / 100;
    } else {
      let lo = 5;
      let hi = startPct - 1;
      let bestPct = -1;
      let bestBuild: typeof build | null = null;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        candidate = buildAtScale(mid / 100);
        if (fits(candidate)) {
          bestPct = mid;
          bestBuild = candidate;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (bestBuild) {
        scaleFactor = bestPct / 100;
        build = bestBuild;
      } else {
        // Nothing fits even at 5% — the sheet is smaller than the joints.
        scaleFactor = 0.05;
        build = buildAtScale(0.05);
      }
    }
  }

  if (build.unplaced.length) {
    const named = build.unplaced.slice(0, 4).join(', ');
    const more = build.unplaced.length > 4 ? `, +${build.unplaced.length - 4} more` : '';
    return {
      success: false,
      error: `The rack has run out of stock for ${named}${more}. Add stock or enable Auto Scale.`,
      warnings: build.warnings,
    };
  }

  panels = build.panels;
  const warnings = build.warnings;
  const sheetCount = build.sheetCount;
  const oversized = build.oversized;
  const offSheet = build.offSheet;
  const sheets = build.sheets;

  // A pattern on the face that lies down on the bed is engraved on the face
  // that is up, where the laser can reach it; the panel then goes in the
  // other way round.
  const underside = panels.filter((p) => p.engraveUnderside && p.engrave2D?.length).map((p) => p.name);
  if (underside.length) {
    warnings.push(
      `${underside.join(', ')}: patterned on both faces. A laser can only reach the upper one, so both ` +
        `patterns are engraved on it; the other face's lines will be on the wrong side.`
    );
  }
  const faceDown = panels.filter((p) => p.cutFaceDown && p.engrave2D?.length).map((p) => p.name);
  if (faceDown.length) {
    warnings.push(
      `${faceDown.join(', ')}: the pattern is on the face that would lie on the bed, so ` +
        `${faceDown.length === 1 ? 'that panel is' : 'those panels are'} laid out face down, pattern up. ` +
        `It goes into the assembly as cut, no turning over.`
    );
  }
  const pocketUnderside = panels.filter((p) => p.blindPocketsUnderside).map((p) => p.name);
  if (pocketUnderside.length) {
    warnings.push(
      `${pocketUnderside.join(', ')}: blind pockets sit on both faces; only the upper-face pockets are emitted in a single-sided setup.`
    );
  }
  const pocketFaceDown = panels
    .filter((p) => p.cutFaceDown && p.blindPockets2D?.length && !p.engrave2D?.length)
    .map((p) => p.name);
  if (pocketFaceDown.length) {
    warnings.push(
      `${pocketFaceDown.join(', ')}: blind pockets sit on the underside face in the model, so ` +
        `${pocketFaceDown.length === 1 ? 'that panel is' : 'those panels are'} laid out pocket-side up for machining.`
    );
  }

  /*
   * Parts laid on the stock the other way round. Said because the app cannot
   * know which way the grain runs, and on timber that is the difference between
   * a part that looks right and one that does not — or, across a narrow piece,
   * one that snaps.
   */
  if (build.rotated.length) {
    warnings.push(
      `Turned a quarter turn to fit the stock: ${build.rotated.slice(0, 4).join(', ')}` +
        `${build.rotated.length > 4 ? `, +${build.rotated.length - 4} more` : ''}. ` +
        `If the material has a grain or a face that matters, check these before cutting.`
    );
  }

  if (maxSheets > 0 && sheetCount > maxSheets) {
    warnings.unshift(
      `Could not get the cuts onto ${maxSheets} sheet${maxSheets === 1 ? '' : 's'} — even at ` +
      `${(scaleFactor * 100).toFixed(0)}% they need ${sheetCount}. Joint tabs and mortises are ` +
      `sized from the ${(options.materialThickness * 1000).toFixed(1)} mm stock and do not shrink ` +
      `with the scale, so a bigger sheet or thinner material is the way down.`
    );
  }

  /** The biggest piece in the rack, which is what "too big" is measured against. */
  const largest = stock.reduce((a, b) => (a.widthMm * a.heightMm >= b.widthMm * b.heightMm ? a : b));
  // Worded exactly as it always was for a single stock size, so the sentence an
  // operator has read a hundred times does not change because a feature they
  // are not using now exists.
  const rackLabel =
    stock.length === 1
      ? `a ${largest.widthMm.toFixed(0)} x ${largest.heightMm.toFixed(0)} mm sheet`
      : `the largest stock (${largest.widthMm.toFixed(0)} x ${largest.heightMm.toFixed(0)} mm)`;

  if (Math.abs(scaleFactor - 1.0) > 1e-3) {
    warnings.unshift(
      `Cuts scaled to ${(scaleFactor * 100).toFixed(0)}% (${scaleFactor.toFixed(2)}x) to fit ${rackLabel} bounds${maxSheets > 0 ? ` (limited to ${maxSheets} sheet${maxSheets === 1 ? '' : 's'})` : ''}.`
    );
  } else if (oversized.length > 0) {
    warnings.push(
      `Too big for ${rackLabel}: ${oversized.join(', ')}. Pick larger stock or enable ` +
      `Auto Scale — these are drawn overflowing their sheet outline.`
    );
  }

  /*
   * The sheets are stacked one below the next, and with a mixed rack they are
   * not the same size — so the drawing is as wide as the widest and each sheet
   * starts where the previous one ended, rather than at a fixed pitch.
   */
  const sheetTop: number[] = [];
  let stackY = 0;
  for (const sheet of sheets) {
    sheetTop.push(stackY);
    stackY += sheet.heightMm;
  }
  const totalSvgWidth = sheets.length ? Math.max(...sheets.map((sh) => sh.widthMm)) : largest.widthMm;
  const totalSvgHeight = stackY || largest.heightMm;

  let svg = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n`;
  svg += `<svg width="${totalSvgWidth}mm" height="${totalSvgHeight}mm" viewBox="0 0 ${totalSvgWidth} ${totalSvgHeight}" xmlns="http://www.w3.org/2000/svg">\n`;
  svg += `  <!-- Generated by PhysBox Laser Cut Engine -->\n`;
  svg += `  <!-- Settings: Joint=${options.jointMode}, Thickness=${(options.materialThickness*1000).toFixed(1)}mm, Finger=${effectiveFingerWidthMm(options).toFixed(1)}mm${options.fingerWidthAuto ? ' (auto)' : ''}, Kerf=${(options.kerf*1000).toFixed(2)}mm, Scale=${(scaleFactor*100).toFixed(0)}%, Relief=${
    options.cornerRelief === 'none'
      ? 'none'
      : `${options.cornerRelief} @ ${(options.bitDiameter*1000).toFixed(2)}mm bit`
  } -->\n\n`;

  if (options.includeSheetOutline) {
    for (let s = 0; s < sheets.length; s++) {
      const sheet = sheets[s];
      const sheetY = sheetTop[s];
      svg += `  <!-- Sheet ${s + 1} Frame -->\n`;
      svg += `  <rect x="0" y="${sheetY}" width="${sheet.widthMm}" height="${sheet.heightMm}" data-operation="ghost" fill="none" stroke="#94A3B8" stroke-width="0.5" stroke-dasharray="4 4" />\n`;
      if (options.includeLabels) {
        // The thickness joins the caption only when the rack holds more than
        // one, because then it is what decides which pile of material this
        // sheet comes off and it cannot be read back off the drawing. With one
        // thickness it would be noise on every caption of every existing job.
        const thick = thicknesses.length > 1 ? ` x ${sheet.thicknessMm.toFixed(1)}mm` : '';
        svg += `  <text x="10" y="${sheetY + 20}" data-operation="ghost" fill="#64748B" font-family="sans-serif" font-size="12" font-weight="bold">Sheet ${s + 1} (${sheet.widthMm}mm x ${sheet.heightMm}mm${thick}${scaleFactor !== 1 ? ` @ ${(scaleFactor*100).toFixed(0)}% scale` : ''})</text>\n`;
      }
      svg += `\n`;
    }
  }

  // Flip each panel's local Y into top-down SVG coordinates while keeping its
  // nested placement `(pos.x, pos.y)` aligned with `exportContourSliceSvg` and
  // preserving part chirality relative to CNC/laser G-code (`pos.y + pt.y`).
  const sheetTopOf = (panel: LaserPanel): number =>
    sheetTop[panel.sheetIndex || 0] ?? 0;
  const drawPoint = (panel: LaserPanel, pt: Point2D) => {
    const pos = panel.placedPos2D || { x: 0, y: 0 };
    const xSvg = pos.x + pt.x;
    const ySvg = sheetTopOf(panel) + pos.y + (panel.height2D || 0) - pt.y;
    return `${xSvg.toFixed(2)} ${ySvg.toFixed(2)}`;
  };

  if (panels.some((p) => p.blindPockets2D?.some((bp) => !bp.under))) {
    svg += `  <g id="blind-pockets" data-operation="fill" stroke="#D97706" stroke-width="0.2" fill="#D97706" fill-opacity="0.18" fill-rule="evenodd" stroke-linejoin="round" stroke-linecap="round">\n`;
    for (const panel of panels) {
      for (const bp of panel.blindPockets2D ?? []) {
        if (bp.under || bp.outer.length < 3) continue;
        let d = `M ${drawPoint(panel, bp.outer[0])}`;
        for (let i = 1; i < bp.outer.length; i++) d += ` L ${drawPoint(panel, bp.outer[i])}`;
        d += ` Z`;
        for (const hole of bp.holes ?? []) {
          if (hole.length < 3) continue;
          d += ` M ${drawPoint(panel, hole[0])}`;
          for (let i = 1; i < hole.length; i++) d += ` L ${drawPoint(panel, hole[i])}`;
          d += ` Z`;
        }
        svg += `    <path d="${d}" data-depth-mm="${bp.depthMm.toFixed(2)}" />\n`;
      }
    }
    svg += `  </g>\n\n`;
  }

  svg += `  <g id="cut-paths" data-operation="cut" stroke="#FF0000" stroke-width="0.2" fill="none" stroke-linejoin="round" stroke-linecap="round">\n`;

  for (const panel of panels) {
    const subpaths: string[] = [];
    if (panel.outerPolygon2D.length > 0) {
      let outerD = `M ${drawPoint(panel, panel.outerPolygon2D[0])}`;
      for (let i = 1; i < panel.outerPolygon2D.length; i++) {
        outerD += ` L ${drawPoint(panel, panel.outerPolygon2D[i])}`;
      }
      outerD += ` Z`;
      subpaths.push(outerD);
    }
    for (const cutout of panel.innerCutouts2D) {
      if (cutout.length === 0) continue;
      let cutoutD = `M ${drawPoint(panel, cutout[0])}`;
      for (let i = 1; i < cutout.length; i++) {
        cutoutD += ` L ${drawPoint(panel, cutout[i])}`;
      }
      cutoutD += ` Z`;
      subpaths.push(cutoutD);
    }
    if (subpaths.length === 0) continue;
    const fillRule = subpaths.length > 1 ? ` fill-rule="evenodd"` : '';
    svg += `    <path d="${subpaths.join(' ')}"${fillRule} data-panel-id="${escapeXml(panel.id)}" data-panel="${escapeXml(panel.name)}" />\n`;
  }
  svg += `  </g>\n\n`;

  // Surface patterns, as lines to engrave: blue, the colour the labels already
  // use for "mark, do not cut", in a group of their own so a laser's software
  // can give them their own power and speed.
  if (panels.some((p) => p.engrave2D?.length)) {
    svg += `  <g id="engrave-patterns" data-operation="etch" stroke="#0000FF" stroke-width="0.1" fill="none" stroke-linejoin="round" stroke-linecap="round">\n`;
    for (const panel of panels) {
      for (const line of panel.engrave2D ?? []) {
        if (line.length < 2) continue;
        let d = `M ${drawPoint(panel, line[0])}`;
        for (let i = 1; i < line.length; i++) d += ` L ${drawPoint(panel, line[i])}`;
        svg += `    <path d="${d}" />\n`;
      }
    }
    svg += `  </g>\n\n`;
  }

  if (options.includeLabels) {
    svg += `  <g id="engrave-labels" data-operation="etch" fill="#0000FF" font-family="sans-serif" font-size="8" text-anchor="middle">\n`;
    for (const panel of panels) {
      const pos = panel.placedPos2D || { x: 0, y: 0 };
      const cx = pos.x + (panel.width2D || 50) / 2;
      const cy = sheetTopOf(panel) + pos.y + (panel.height2D || 50) / 2;
      svg += `    <text x="${cx.toFixed(2)}" y="${cy.toFixed(2)}">${escapeXml(panel.name)}</text>\n`;
    }
    svg += `  </g>\n`;
  }

  svg += `</svg>`;

  if (invalidGeoms.length > 0) {
    warnings.unshift(
      `Skipped curved geometry that cannot be cut flat: ${invalidGeoms.join(', ')}.`
    );
  }

  return {
    success: true,
    svg,
    panels,
    sheetCount,
    sheets,
    scaleFactor,
    oversized,
    offSheet,
    warnings,
  };
}
