// ---------------------------------------------------------------------------
// Sheet-Goods 3D-to-2D Unfolding & Flat-Pattern Net Exporter (Mesh -> Etch)
//
// Unfolds 3D polygonal meshes, lattice cages, and solid primitives into flat
// 2D fabrication nets across three modes:
//   1. 'papercraft'  — Cardstock, Pepakura, packaging & origami nets with
//                      mountain/valley fold lines, non-overlapping spanning-tree
//                      unfolding, trapezoidal glue tabs, and edge-pair IDs.
//   2. 'sheet_metal' — Brake-formed sheet metal enclosures & brackets with
//                      K-factor bend allowance BA = theta * (R + K * T), bend
//                      centerlines, UP/DN angle callouts, and corner relief notches.
//   3. 'soft_goods'  — Leathercraft & sewing patterns with outward seam allowance,
//                      perpendicular alignment notches, and equidistant stitch-hole
//                      punch points along mating seams.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { SceneGraph, SceneNode, SceneGeom } from '../types/scene';
import { csgSourceGeoms, fromtoFrame } from './csg';
import { isBoughtIn } from './boughtIn';
import { isNodeRotationBaked } from './sceneTree';
import { buildEtchHandoffUrl, etchBaseUrl, HANDOFF_SOFT_LIMIT } from './etchHandoff';
import type { MaterialId } from './feedsAndSpeeds';
import { toBase64Url } from './shareLink';
import { nestingDepths, offsetLoop, offsetNestedLoops, pointInPolygon } from './polygonOffset';

export type SheetUnfoldMode = 'papercraft' | 'sheet_metal' | 'soft_goods';

export interface SheetUnfoldOptions {
  mode: SheetUnfoldMode;
  /** Coplanar angle tolerance in degrees for merging adjacent triangles into polygon faces (default 2.5). */
  coplanarToleranceDeg: number;
  /** Papercraft glue tab width in mm (default 6). Set to 0 to omit glue tabs. */
  tabWidthMm: number;
  /** Papercraft glue tab taper angle in degrees (default 45). */
  tabAngleDeg: number;
  /** Material thickness T in mm (default 1.5). */
  thicknessMm: number;
  /** Inside bend radius R in mm for sheet metal (default 1.5). */
  bendRadiusMm: number;
  /** Neutral axis K-factor for sheet metal bend allowance (default 0.44). */
  kFactor: number;
  /** Rectangular bend relief width in mm at corners where bends meet (default 1.5, 0 to disable). */
  bendReliefWidthMm: number;
  /** Rectangular bend relief depth in mm (default 2.0, 0 to disable). */
  bendReliefDepthMm: number;
  /** Outward seam allowance in mm for soft_goods mode (default 6). */
  seamAllowanceMm: number;
  /** Stitch hole pitch in mm for soft_goods mode (default 4.0, 0 to disable). */
  stitchPitchMm: number;
  /** Alignment notch length in mm for soft_goods mode (default 2.5). */
  notchLengthMm: number;
  /** Sheet width in mm (default 600). */
  sheetWidthMm: number;
  /** Sheet height in mm (default 400). */
  sheetHeightMm: number;
  /** Sheet margin in mm (default 8). */
  marginMm: number;
  /** Minimum spacing between packed islands in mm (default 5). */
  partSpacingMm: number;
  /** Scale factor applied to 3D geometry before unfolding (default 1.0). */
  scaleFactor: number;
  /** Emit edge-pair ID numbers, bend callouts, and island labels in SVG (default true). */
  includeLabels: boolean;
  /** Emit dashed sheet boundary in SVG (default true). */
  includeSheetOutline: boolean;
}

export const DEFAULT_SHEET_UNFOLD_OPTIONS: SheetUnfoldOptions = {
  mode: 'papercraft',
  coplanarToleranceDeg: 2.5,
  tabWidthMm: 6,
  tabAngleDeg: 45,
  thicknessMm: 1.5,
  bendRadiusMm: 1.5,
  kFactor: 0.44,
  bendReliefWidthMm: 1.5,
  bendReliefDepthMm: 2.0,
  seamAllowanceMm: 6,
  stitchPitchMm: 4.0,
  notchLengthMm: 2.5,
  sheetWidthMm: 600,
  sheetHeightMm: 400,
  marginMm: 8,
  partSpacingMm: 5,
  scaleFactor: 1.0,
  includeLabels: true,
  includeSheetOutline: true,
};

export interface Point2D {
  x: number;
  y: number;
}

export interface UnfoldedFace2D {
  faceIndex: number;
  polygon2D: Point2D[];
  /** Interior cutout loops on this face in placed sheet coordinates (mm). */
  holes2D?: Point2D[][];
  centroid2D: Point2D;
  areaMm2: number;
  /**
   * The model face this was unfolded from, mm, Z up, at `scaleFactor`: vertex
   * i is `polygon2D[i]`. Not part of the cut; it is what a simulation folding
   * the net back up is measured against.
   */
  model3DMm: [number, number, number][];
}

export interface UnfoldFoldEdge {
  id: string;
  faceA: number;
  faceB: number;
  p1: Point2D;
  p2: Point2D;
  /** Fold direction: 'mountain' (convex outward fold, > 0) or 'valley' (concave inward fold, < 0). */
  kind: 'mountain' | 'valley';
  /** Signed dihedral bend angle in degrees (0 = flat, +90 = 90 deg mountain fold, -90 = valley fold). */
  angleDeg: number;
  /** Sheet-metal bend allowance in mm (0 in papercraft/soft_goods). */
  bendAllowanceMm: number;
  /** Sheet-metal bend zone polygon [a1, a2, b2, b1] when bendAllowanceMm > 0. */
  bendZonePolygon2D?: Point2D[];
  /** Bend callout label for sheet_metal mode, e.g. "UP 90° R1.5" or "DN 45° R1.5". */
  callout?: string;
}

export interface UnfoldCutSeam {
  pairId: number;
  faceIndex: number;
  matingFaceIndex: number | null;
  p1: Point2D;
  p2: Point2D;
  /** Outward normal in 2D pointing away from `faceIndex`. */
  outwardNormal2D: Point2D;
  hasGlueTab: boolean;
  /** Perpendicular alignment notch ticks [start, end] for soft_goods mode. */
  alignmentNotches?: [Point2D, Point2D][];
}

export interface UnfoldGlueTab {
  pairId: number;
  faceIndex: number;
  /** 4-vertex trapezoid [baseP1, tipP1, tipP2, baseP2] in 2D sheet coordinates. */
  polygon2D: Point2D[];
  /** Base edge on the face [baseP1, baseP2]. */
  baseEdge: [Point2D, Point2D];
}

export interface UnfoldReliefNotch {
  center2D: Point2D;
  polygon2D: Point2D[];
  widthMm: number;
  depthMm: number;
}

export interface UnfoldIsland {
  id: string;
  nodeId: string;
  nodeName: string;
  sheetIndex: number;
  placedOffsetMm: Point2D;
  faceCount: number;
  faces: UnfoldedFace2D[];
  /** Outer cut boundary polylines/loops in placed sheet coordinates (mm). */
  cutPolylines2D: Point2D[][];
  /** Original seam boundary loops (before seam allowance expansion in soft_goods). */
  seamPolylines2D: Point2D[][];
  foldEdges: UnfoldFoldEdge[];
  cutSeams: UnfoldCutSeam[];
  glueTabs: UnfoldGlueTab[];
  reliefNotches: UnfoldReliefNotch[];
  stitchHoles: Point2D[];
  stitchHoleCount: number;
  boundsMm: { width: number; height: number };
}

export interface UnfoldSheet {
  index: number;
  widthMm: number;
  heightMm: number;
  islandIds: string[];
}

export interface SheetUnfoldResult {
  success: boolean;
  mode: SheetUnfoldMode;
  svg: string;
  sheets: UnfoldSheet[];
  islands: UnfoldIsland[];
  totalFaces: number;
  foldCount: number;
  seamCount: number;
  glueTabCount: number;
  stitchHoleCount: number;
  /** Total bend allowance added across all fold edges in sheet_metal mode (mm). */
  totalBendAllowanceMm: number;
  warnings: string[];
  etchUrl?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Math & Geometry Helpers
// ---------------------------------------------------------------------------

/**
 * Sheet-metal bend allowance formula:
 *   BA = |theta_rad| * (R_inside + K * T)
 */
export function computeBendAllowanceMm(
  angleDeg: number,
  bendRadiusMm: number,
  thicknessMm: number,
  kFactor: number
): number {
  const thetaRad = Math.abs(angleDeg) * (Math.PI / 180);
  const r = Math.max(0, bendRadiusMm);
  const t = Math.max(0, thicknessMm);
  const k = Math.max(0, kFactor);
  return thetaRad * (r + k * t);
}

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

function getNodeWorldTransform(node: SceneNode, parentMatrix?: THREE.Matrix4): THREE.Matrix4 {
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
 * World transform for `node.latticeCage`, whose `coords` are NEVER baked by
 * `updateNodeRotation` even when `node.geoms` has `baseVertices` set.
 */
function getCageWorldTransform(node: SceneNode, parentMatrix?: THREE.Matrix4): THREE.Matrix4 {
  const m = node.quat
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

function getGeomFrame(geom: SceneGeom): { matrix: THREE.Matrix4; halfLen?: number } {
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

function yupVertsToZup(v: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < v.length; i += 3) {
    out.push(v[i], -v[i + 2], v[i + 1]);
  }
  return out;
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] as string
  ));
}

function polygonSignedArea2D(pts: Point2D[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % pts.length];
    a += p1.x * p2.y - p2.x * p1.y;
  }
  return a / 2;
}

function polygonArea2D(pts: Point2D[]): number {
  return Math.abs(polygonSignedArea2D(pts));
}

function polygonCentroid2D(pts: Point2D[]): Point2D {
  if (pts.length === 0) return { x: 0, y: 0 };
  let cx = 0;
  let cy = 0;
  let area2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % pts.length];
    const cross = p1.x * p2.y - p2.x * p1.y;
    area2 += cross;
    cx += (p1.x + p2.x) * cross;
    cy += (p1.y + p2.y) * cross;
  }
  if (Math.abs(area2) > 1e-7) {
    return { x: cx / (3 * area2), y: cy / (3 * area2) };
  }
  let sx = 0;
  let sy = 0;
  for (const p of pts) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / pts.length, y: sy / pts.length };
}

function pointToSegmentDist2D(pt: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return Math.hypot(pt.x - a.x, pt.y - a.y);
  const t = Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / lenSq));
  return Math.hypot(pt.x - (a.x + t * dx), pt.y - (a.y + t * dy));
}

function segmentToSegmentDist2D(a1: Point2D, a2: Point2D, b1: Point2D, b2: Point2D): number {
  const d1x = a2.x - a1.x;
  const d1y = a2.y - a1.y;
  const d2x = b2.x - b1.x;
  const d2y = b2.y - b1.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) > 1e-12) {
    const dx = b1.x - a1.x;
    const dy = b1.y - a1.y;
    const t = (dx * d2y - dy * d2x) / denom;
    const u = (dx * d1y - dy * d1x) / denom;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(
    pointToSegmentDist2D(a1, b1, b2),
    pointToSegmentDist2D(a2, b1, b2),
    pointToSegmentDist2D(b1, a1, a2),
    pointToSegmentDist2D(b2, a1, a2)
  );
}

/**
 * Unzips consecutive 180-degree zero-width backtrack spikes (`a -> b -> c` where
 * `b` folds right back along `a -> b`) so hairline slits between adjacent unfolded
 * flaps do not break outward offsetting.
 */
function unzipBacktrackSlits2D(loop: Point2D[], tol: number = 1e-3): Point2D[] {
  let pts = loop.map((p) => ({ ...p }));
  let changed = true;
  while (changed && pts.length >= 3) {
    changed = false;
    const deduped: Point2D[] = [];
    for (const p of pts) {
      const prev = deduped[deduped.length - 1];
      if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > tol) {
        deduped.push(p);
      } else {
        changed = true;
      }
    }
    while (
      deduped.length > 2 &&
      Math.hypot(deduped[0].x - deduped[deduped.length - 1].x, deduped[0].y - deduped[deduped.length - 1].y) <= tol
    ) {
      deduped.pop();
      changed = true;
    }
    pts = deduped;
    if (pts.length < 3) break;

    const m = pts.length;
    for (let i = 0; i < m; i++) {
      const prev = pts[(i - 1 + m) % m];
      const curr = pts[i];
      const next = pts[(i + 1) % m];
      const ux = curr.x - prev.x;
      const uy = curr.y - prev.y;
      const vx = next.x - curr.x;
      const vy = next.y - curr.y;
      const lu = Math.hypot(ux, uy);
      const lv = Math.hypot(vx, vy);
      if (lu <= tol || lv <= tol) {
        pts.splice(i, 1);
        changed = true;
        break;
      }
      const dot = ux * vx + uy * vy;
      const cross = ux * vy - uy * vx;
      if (dot < 0 && Math.abs(cross) <= Math.min(lu, lv) * 2e-3) {
        pts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return pts.length >= 3 ? pts : [];
}

/**
 * Heals both consecutive 180-degree backtrack slits and non-consecutive anti-parallel
 * zero-width touching seam segments (splitting self-kissing C-frame loops into clean
 * outer + inner loops).
 */
function healHairlineSlits2D(inputLoops: Point2D[][]): Point2D[][] {
  const queue = inputLoops.map((l) => unzipBacktrackSlits2D(l, 1e-3)).filter((l) => l.length >= 3);
  const out: Point2D[][] = [];
  let splits = 0;

  while (queue.length > 0) {
    const lp = unzipBacktrackSlits2D(queue.shift()!, 1e-3);
    if (lp.length < 3) continue;
    if (splits >= 16) {
      out.push(lp);
      continue;
    }

    const n = lp.length;
    let splitFound = false;
    for (let i = 0; i < n && !splitFound; i++) {
      const a1 = lp[i];
      const a2 = lp[(i + 1) % n];
      const ax = a2.x - a1.x;
      const ay = a2.y - a1.y;
      const aLen = Math.hypot(ax, ay);
      if (aLen < 1e-2) continue;
      const aux = ax / aLen;
      const auy = ay / aLen;

      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const b1 = lp[j];
        const b2 = lp[(j + 1) % n];
        const bx = b2.x - b1.x;
        const by = b2.y - b1.y;
        const bLen = Math.hypot(bx, by);
        if (bLen < 1e-2) continue;
        // Must be anti-parallel along the same line
        if (ax * bx + ay * by >= -0.999 * aLen * bLen) continue;
        const perp1 = Math.abs((b1.x - a1.x) * auy - (b1.y - a1.y) * aux);
        const perp2 = Math.abs((b2.x - a1.x) * auy - (b2.y - a1.y) * aux);
        if (perp1 > 2e-3 || perp2 > 2e-3) continue;

        const tB1 = (b1.x - a1.x) * aux + (b1.y - a1.y) * auy;
        const tB2 = (b2.x - a1.x) * aux + (b2.y - a1.y) * auy;
        const lo = Math.max(0, Math.min(tB1, tB2));
        const hi = Math.min(aLen, Math.max(tB1, tB2));
        if (hi - lo <= 1e-2) continue;

        const pLo = { x: a1.x + aux * lo, y: a1.y + auy * lo };
        const pHi = { x: a1.x + aux * hi, y: a1.y + auy * hi };

        // Loop 1: pLo -> b2 -> ... -> a1 -> pLo
        const loop1: Point2D[] = [pLo];
        for (let k = (j + 1) % n; ; k = (k + 1) % n) {
          loop1.push(lp[k]);
          if (k === i) break;
        }
        // Loop 2: pHi -> a2 -> ... -> b1 -> pHi
        const loop2: Point2D[] = [pHi];
        for (let k = (i + 1) % n; ; k = (k + 1) % n) {
          loop2.push(lp[k]);
          if (k === j) break;
        }

        splits++;
        const clean1 = unzipBacktrackSlits2D(loop1, 1e-3);
        const clean2 = unzipBacktrackSlits2D(loop2, 1e-3);
        if (clean1.length >= 3) queue.push(clean1);
        if (clean2.length >= 3) queue.push(clean2);
        splitFound = true;
        break;
      }
    }

    if (!splitFound) {
      out.push(lp);
    }
  }

  return out;
}

function isConvexPolygonCCW(poly: Point2D[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const c = poly[(i + 2) % n];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross < -1e-6) return false;
  }
  return true;
}

function clipPolygonByConvexCCW2D(subject: Point2D[], convexClipCCW: Point2D[]): Point2D[] {
  let poly = subject.map((p) => ({ ...p }));
  const m = convexClipCCW.length;
  for (let ci = 0; ci < m && poly.length >= 3; ci++) {
    const c1 = convexClipCCW[ci];
    const c2 = convexClipCCW[(ci + 1) % m];
    const ex = c2.x - c1.x;
    const ey = c2.y - c1.y;
    const next: Point2D[] = [];
    const kLen = poly.length;
    for (let i = 0; i < kLen; i++) {
      const prev = poly[(i - 1 + kLen) % kLen];
      const curr = poly[i];
      const sPrev = ex * (prev.y - c1.y) - ey * (prev.x - c1.x);
      const sCurr = ex * (curr.y - c1.y) - ey * (curr.x - c1.x);
      const inPrev = sPrev >= -1e-9;
      const inCurr = sCurr >= -1e-9;
      if (inPrev !== inCurr) {
        const denom = sPrev - sCurr;
        const t = Math.abs(denom) > 1e-18 ? Math.max(0, Math.min(1, sPrev / denom)) : 0.5;
        next.push({
          x: prev.x + (curr.x - prev.x) * t,
          y: prev.y + (curr.y - prev.y) * t,
        });
      }
      if (inCurr) {
        next.push(curr);
      }
    }
    poly = next;
  }
  return poly;
}

function dropCollinear2D(pts: Point2D[], tol: number = 1e-5): Point2D[] {
  if (pts.length <= 3) return pts;
  const out: Point2D[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n];
    const b = pts[i];
    const c = pts[(i + 1) % n];
    const span = Math.hypot(c.x - a.x, c.y - a.y);
    const cross = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    if (span > 1e-8 && cross / span < tol) continue;
    out.push(b);
  }
  return out.length >= 3 ? out : pts;
}

/**
 * Intersects an arbitrary 2D polygon `subjectPoly` with `clipPoly` (supporting both
 * convex and non-convex polygons, including cases where clipping splits a hole into
 * multiple disjoint regions). Returns CCW loops.
 */
function intersectPolygons2D(subjectPoly: Point2D[], clipPoly: Point2D[]): Point2D[][] {
  const sClean = unzipBacktrackSlits2D(subjectPoly, 1e-5);
  const cClean = unzipBacktrackSlits2D(clipPoly, 1e-5);
  if (sClean.length < 3 || cClean.length < 3) return [];

  const sCCW = polygonSignedArea2D(sClean) < 0 ? [...sClean].reverse() : sClean;
  const cCCW = polygonSignedArea2D(cClean) < 0 ? [...cClean].reverse() : cClean;

  if (isConvexPolygonCCW(sCCW) && isConvexPolygonCCW(cCCW)) {
    const clipped = dropCollinear2D(unzipBacktrackSlits2D(clipPolygonByConvexCCW2D(sCCW, cCCW), 1e-4));
    return clipped.length >= 3 && polygonSignedArea2D(clipped) > 1e-3 ? [clipped] : [];
  }

  const trisS = isConvexPolygonCCW(sCCW)
    ? Array.from({ length: sCCW.length - 2 }, (_, i) => [0, i + 1, i + 2] as [number, number, number])
    : THREE.ShapeUtils.triangulateShape(sCCW.map((p) => new THREE.Vector2(p.x, p.y)), []);
  const trisC = isConvexPolygonCCW(cCCW)
    ? Array.from({ length: cCCW.length - 2 }, (_, i) => [0, i + 1, i + 2] as [number, number, number])
    : THREE.ShapeUtils.triangulateShape(cCCW.map((p) => new THREE.Vector2(p.x, p.y)), []);

  const toCCWTri = (pts: Point2D[], [i0, i1, i2]: number[]): Point2D[] => {
    const a = pts[i0], b = pts[i1], c = pts[i2];
    const area2 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    return area2 >= 0 ? [a, b, c] : [a, c, b];
  };

  const weldTol = 1e-4;
  const welded: Point2D[] = [];
  const weldIdx = (pt: Point2D): number => {
    for (let i = 0; i < welded.length; i++) {
      if (Math.hypot(welded[i].x - pt.x, welded[i].y - pt.y) <= weldTol) return i;
    }
    welded.push({ x: pt.x, y: pt.y });
    return welded.length - 1;
  };

  const subTris: [number, number, number][] = [];
  for (const ts of trisS) {
    const polyS = toCCWTri(sCCW, ts);
    if (polygonSignedArea2D(polyS) <= 1e-6) continue;
    for (const tc of trisC) {
      const polyC = toCCWTri(cCCW, tc);
      if (polygonSignedArea2D(polyC) <= 1e-6) continue;
      const piece = unzipBacktrackSlits2D(clipPolygonByConvexCCW2D(polyS, polyC), 1e-5);
      if (piece.length < 3 || polygonSignedArea2D(piece) <= 1e-5) continue;
      const idxs = piece.map(weldIdx);
      for (let k = 1; k + 1 < idxs.length; k++) {
        const u = idxs[0], v = idxs[k], w = idxs[k + 1];
        if (u !== v && v !== w && w !== u) {
          const pu = welded[u], pv = welded[v], pw = welded[w];
          const area2 = (pv.x - pu.x) * (pw.y - pu.y) - (pv.y - pu.y) * (pw.x - pu.x);
          if (area2 > 1e-6) subTris.push([u, v, w]);
          else if (area2 < -1e-6) subTris.push([u, w, v]);
        }
      }
    }
  }

  if (subTris.length === 0) return [];

  // Split any half-edge (u -> v) at intermediate welded T-vertices so shared diagonals cancel cleanly
  const edgeCounts = new Map<string, number>();
  const addDirected = (u: number, v: number) => {
    if (u === v) return;
    const revKey = `${v}:${u}`;
    const revCount = edgeCounts.get(revKey) ?? 0;
    if (revCount > 0) {
      if (revCount === 1) edgeCounts.delete(revKey);
      else edgeCounts.set(revKey, revCount - 1);
    } else {
      const key = `${u}:${v}`;
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
  };

  for (const [i0, i1, i2] of subTris) {
    for (const [u, v] of [[i0, i1], [i1, i2], [i2, i0]] as [number, number][]) {
      const pu = welded[u], pv = welded[v];
      const dx = pv.x - pu.x, dy = pv.y - pu.y;
      const len = Math.hypot(dx, dy);
      if (len <= weldTol) continue;
      const mids: { idx: number; t: number }[] = [];
      for (let w = 0; w < welded.length; w++) {
        if (w === u || w === v) continue;
        const pw = welded[w];
        const t = ((pw.x - pu.x) * dx + (pw.y - pu.y) * dy) / (len * len);
        if (t <= 1e-4 || t >= 1 - 1e-4) continue;
        const perp = Math.abs((pw.x - pu.x) * dy - (pw.y - pu.y) * dx) / len;
        if (perp <= weldTol * 2) mids.push({ idx: w, t });
      }
      if (mids.length === 0) {
        addDirected(u, v);
      } else {
        mids.sort((a, b) => a.t - b.t);
        let prev = u;
        for (const m of mids) {
          addDirected(prev, m.idx);
          prev = m.idx;
        }
        addDirected(prev, v);
      }
    }
  }

  const outgoing = new Map<number, number[]>();
  for (const [key, count] of edgeCounts.entries()) {
    const [uStr, vStr] = key.split(':');
    const u = Number(uStr), v = Number(vStr);
    for (let c = 0; c < count; c++) {
      let arr = outgoing.get(u);
      if (!arr) {
        arr = [];
        outgoing.set(u, arr);
      }
      arr.push(v);
    }
  }

  const loops: Point2D[][] = [];
  for (const [startU, list] of outgoing.entries()) {
    while (list.length > 0) {
      const nextV = list.pop()!;
      const idxs = [startU];
      let prev = startU;
      let curr = nextV;
      for (let guard = 0; guard <= welded.length * 4; guard++) {
        if (curr === startU) break;
        idxs.push(curr);
        const nextList = outgoing.get(curr);
        if (!nextList || nextList.length === 0) break;
        let pickIdx = nextList.length - 1;
        if (nextList.length > 1) {
          // At a pinch vertex, turn right-most (CW) to keep simple minimal CCW cycles separate
          const inAng = Math.atan2(welded[prev].y - welded[curr].y, welded[prev].x - welded[curr].x);
          let bestTurn = Infinity;
          for (let k = 0; k < nextList.length; k++) {
            const cand = nextList[k];
            const outAng = Math.atan2(welded[cand].y - welded[curr].y, welded[cand].x - welded[curr].x);
            let turn = outAng - inAng;
            while (turn <= 0) turn += Math.PI * 2;
            if (turn < bestTurn) {
              bestTurn = turn;
              pickIdx = k;
            }
          }
        }
        const nxt = nextList.splice(pickIdx, 1)[0];
        prev = curr;
        curr = nxt;
      }
      if (curr === startU && idxs.length >= 3) {
        const pts = dropCollinear2D(unzipBacktrackSlits2D(idxs.map((id) => welded[id]), 1e-3));
        if (pts.length >= 3 && polygonSignedArea2D(pts) > 1e-3) {
          loops.push(pts);
        }
      }
    }
  }

  return loops;
}

/**
 * Validates and clips interior face hole cutouts against `outerPoly` (inset by
 * `clearanceMm`) so holes that enter a sheet-metal bend setback zone never cross
 * the trimmed face boundary or break 3D slab triangulation (`closed: false`).
 */
export function clipFaceHolesToPolygon2D(
  outerPoly: Point2D[],
  holes: Point2D[][],
  clearanceMm: number = 0.08
): { holes: Point2D[][]; encroachedIndices: number[] } {
  if (holes.length === 0) return { holes: [], encroachedIndices: [] };
  if (outerPoly.length < 3) {
    return { holes: [], encroachedIndices: holes.map((_, i) => i) };
  }

  const outerSigned = polygonSignedArea2D(outerPoly);
  const outerCCW = outerSigned < 0 ? [...outerPoly].reverse() : outerPoly;
  const wantHoleSignedNegative = outerSigned >= 0;

  const orientHole = (lp: Point2D[]): Point2D[] => {
    const s = polygonSignedArea2D(lp);
    if ((s < 0) === wantHoleSignedNegative) return lp;
    return [...lp].reverse();
  };

  const isStrictlyInsideWithClearance = (h: Point2D[], tol: number): boolean => {
    if (h.length < 3) return false;
    if (!pointInPolygon(h[0], outerCCW)) return false;
    if (pointInPolygon(outerCCW[0], h)) return false;
    for (let i = 0; i < h.length; i++) {
      const a1 = h[i];
      const a2 = h[(i + 1) % h.length];
      for (let j = 0; j < outerCCW.length; j++) {
        const b1 = outerCCW[j];
        const b2 = outerCCW[(j + 1) % outerCCW.length];
        if (segmentToSegmentDist2D(a1, a2, b1, b2) < tol) return false;
      }
    }
    return true;
  };

  let safeOuterLoops: Point2D[][] | null = null;
  const kept: Point2D[][] = [];
  const encroachedIndices: number[] = [];

  for (let hi = 0; hi < holes.length; hi++) {
    const h = holes[hi];
    if (isStrictlyInsideWithClearance(h, clearanceMm)) {
      kept.push(orientHole(h.map((p) => ({ ...p }))));
      continue;
    }

    encroachedIndices.push(hi);
    if (safeOuterLoops === null) {
      safeOuterLoops = offsetLoop(outerCCW, -clearanceMm, {
        joinStyle: 'miter',
        miterLimit: 3,
        arcTolerance: 0.02,
      });
    }
    if (safeOuterLoops.length === 0) continue;

    for (const safeLoop of safeOuterLoops) {
      const pieces = intersectPolygons2D(h, safeLoop);
      for (const piece of pieces) {
        if (piece.length < 3 || polygonArea2D(piece) < 0.25) continue;
        if (!isStrictlyInsideWithClearance(piece, clearanceMm * 0.25)) continue;
        kept.push(orientHole(piece));
      }
    }
  }

  return { holes: kept, encroachedIndices };
}

function pointStrictlyInPolygon2D(poly: Point2D[], pt: Point2D, epsMm: number = 0.08): boolean {
  for (let i = 0; i < poly.length; i++) {
    if (pointToSegmentDist2D(pt, poly[i], poly[(i + 1) % poly.length]) <= epsMm) {
      return false;
    }
  }
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

function segmentsProperlyIntersect2D(
  a1: Point2D,
  a2: Point2D,
  b1: Point2D,
  b2: Point2D,
  epsMm: number = 0.08
): boolean {
  const d1x = a2.x - a1.x;
  const d1y = a2.y - a1.y;
  const d2x = b2.x - b1.x;
  const d2y = b2.y - b1.y;
  const len1 = Math.hypot(d1x, d1y);
  const len2 = Math.hypot(d2x, d2y);
  if (len1 < epsMm || len2 < epsMm) return false;

  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-7 * len1 * len2) return false;

  const dx = b1.x - a1.x;
  const dy = b1.y - a1.y;
  const t = (dx * d2y - dy * d2x) / denom;
  const u = (dx * d1y - dy * d1x) / denom;

  const marginT = epsMm / len1;
  const marginU = epsMm / len2;
  return t > marginT && t < 1 - marginT && u > marginU && u < 1 - marginU;
}

function samplePolygonInteriorPoints2D(poly: Point2D[]): Point2D[] {
  const clean: Point2D[] = [];
  for (const p of poly) {
    const prev = clean[clean.length - 1];
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > 1e-5) {
      clean.push(p);
    }
  }
  if (
    clean.length > 2 &&
    Math.hypot(clean[0].x - clean[clean.length - 1].x, clean[0].y - clean[clean.length - 1].y) <= 1e-5
  ) {
    clean.pop();
  }
  if (clean.length < 3) return [];

  const pts: Point2D[] = [];
  for (let i = 0; i < clean.length; i++) {
    const a = clean[i];
    const b = clean[(i + 1) % clean.length];
    pts.push({ x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 });
  }

  const ccw = polygonSignedArea2D(clean) < 0 ? [...clean].reverse() : clean;
  const contour = ccw.map((p) => new THREE.Vector2(p.x, p.y));
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  for (const [i0, i1, i2] of tris) {
    const p0 = ccw[i0];
    const p1 = ccw[i1];
    const p2 = ccw[i2];
    if (!p0 || !p1 || !p2) continue;
    const area2 = Math.abs((p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x));
    if (area2 > 1e-6) {
      pts.push({
        x: (p0.x + p1.x + p2.x) / 3,
        y: (p0.y + p1.y + p2.y) / 3,
      });
    }
  }
  return pts;
}

/**
 * Checks whether two 2D polygons have a positive-area interior overlap.
 * Polygons that merely share a hinge edge or touch at a corner return false.
 * Handles both convex and non-convex (L/U/frame) polygons regardless of winding.
 */
export function polygonsOverlap2D(polyA: Point2D[], polyB: Point2D[], epsMm: number = 0.08): boolean {
  if (polyA.length < 3 || polyB.length < 3) return false;

  let minAx = Infinity, maxAx = -Infinity, minAy = Infinity, maxAy = -Infinity;
  for (const p of polyA) {
    if (p.x < minAx) minAx = p.x;
    if (p.x > maxAx) maxAx = p.x;
    if (p.y < minAy) minAy = p.y;
    if (p.y > maxAy) maxAy = p.y;
  }
  let minBx = Infinity, maxBx = -Infinity, minBy = Infinity, maxBy = -Infinity;
  for (const p of polyB) {
    if (p.x < minBx) minBx = p.x;
    if (p.x > maxBx) maxBx = p.x;
    if (p.y < minBy) minBy = p.y;
    if (p.y > maxBy) maxBy = p.y;
  }
  if (maxAx <= minBx + epsMm || maxBx <= minAx + epsMm || maxAy <= minBy + epsMm || maxBy <= minAy + epsMm) {
    return false;
  }

  for (let i = 0; i < polyA.length; i++) {
    const a1 = polyA[i];
    const a2 = polyA[(i + 1) % polyA.length];
    for (let j = 0; j < polyB.length; j++) {
      const b1 = polyB[j];
      const b2 = polyB[(j + 1) % polyB.length];
      if (segmentsProperlyIntersect2D(a1, a2, b1, b2, epsMm)) {
        return true;
      }
    }
  }

  for (const pt of samplePolygonInteriorPoints2D(polyA)) {
    if (pointStrictlyInPolygon2D(polyB, pt, epsMm)) return true;
  }
  for (const pt of samplePolygonInteriorPoints2D(polyB)) {
    if (pointStrictlyInPolygon2D(polyA, pt, epsMm)) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// 3D Polygonal Mesh Representation & Coplanar Triangle Clustering
// ---------------------------------------------------------------------------

export interface PolyFace3D {
  index: number;
  /** Vertex indices into `PolySurface3D.vertices`, wound CCW around `normal`. */
  verts: number[];
  /** Optional interior hole loops into `PolySurface3D.vertices`, wound CW around `normal`. */
  holesVerts?: number[][];
  normal: THREE.Vector3;
  centroid: THREE.Vector3;
  areaM2: number;
  /** Local 2D coordinates in mm (isometric to 3D face, wound CCW). */
  local2D: Point2D[];
  /** Optional interior hole loops in local 2D coordinates in mm (wound CW). */
  holesLocal2D?: Point2D[][];
}

interface PolySurface3D {
  nodeId: string;
  nodeName: string;
  /** Welded 3D vertex positions in world space (metres, scaled by scaleFactor). */
  vertices: THREE.Vector3[];
  faces: PolyFace3D[];
}

const WELD_TOL_M = 1e-5;

function weldVertices3D(rawVerts: THREE.Vector3[]): { vertices: THREE.Vector3[]; remap: number[] } {
  const map = new Map<string, number>();
  const vertices: THREE.Vector3[] = [];
  const remap: number[] = [];

  for (const v of rawVerts) {
    const key = `${Math.round(v.x / WELD_TOL_M)},${Math.round(v.y / WELD_TOL_M)},${Math.round(v.z / WELD_TOL_M)}`;
    let idx = map.get(key);
    if (idx === undefined) {
      idx = vertices.length;
      map.set(key, idx);
      vertices.push(v.clone());
    }
    remap.push(idx);
  }
  return { vertices, remap };
}

function buildFaceBasis3D(
  normal: THREE.Vector3,
  refOrigin: THREE.Vector3,
  nextHint?: THREE.Vector3
): { uAxis: THREE.Vector3; vAxis: THREE.Vector3 } {
  const uAxis = new THREE.Vector3();
  if (nextHint) {
    uAxis.subVectors(nextHint, refOrigin);
    uAxis.addScaledVector(normal, -uAxis.dot(normal));
  }
  if (uAxis.lengthSq() < 1e-12) {
    uAxis.set(Math.abs(normal.x) < 0.9 ? 1 : 0, Math.abs(normal.x) < 0.9 ? 0 : 1, 0);
    uAxis.addScaledVector(normal, -uAxis.dot(normal));
  }
  uAxis.normalize();
  const vAxis = new THREE.Vector3().crossVectors(normal, uAxis).normalize();
  return { uAxis, vAxis };
}

function buildPolyFace3D(
  index: number,
  vertsIn: number[],
  vertices: THREE.Vector3[],
  hintNormal?: THREE.Vector3,
  holesVertsIn?: number[][]
): PolyFace3D | null {
  if (vertsIn.length < 3) return null;
  const verts = [...vertsIn];

  // Exact Newell vector (2 * vector area, handles concave polygons properly)
  const newell = new THREE.Vector3();
  for (let i = 0; i < verts.length; i++) {
    const curr = vertices[verts[i]];
    const next = vertices[verts[(i + 1) % verts.length]];
    if (!curr || !next) return null;
    newell.x += (curr.y - next.y) * (curr.z + next.z);
    newell.y += (curr.z - next.z) * (curr.x + next.x);
    newell.z += (curr.x - next.x) * (curr.y + next.y);
  }

  let normal: THREE.Vector3;
  if (newell.lengthSq() > 1e-18) {
    normal = newell.clone().normalize();
    if (hintNormal && hintNormal.lengthSq() > 1e-12 && normal.dot(hintNormal) < 0) {
      normal.negate();
    }
  } else if (hintNormal && hintNormal.lengthSq() > 1e-12) {
    normal = hintNormal.clone().normalize();
  } else {
    return null;
  }

  const v0 = vertices[verts[0]];
  let secondPt = vertices[verts[1]];
  for (let i = 1; i < verts.length; i++) {
    if (vertices[verts[i]].distanceToSquared(v0) > 1e-12) {
      secondPt = vertices[verts[i]];
      break;
    }
  }
  const { uAxis, vAxis } = buildFaceBasis3D(normal, v0, secondPt);

  const projectMm = (vi: number): Point2D => {
    const d = new THREE.Vector3().subVectors(vertices[vi], v0);
    return {
      x: d.dot(uAxis) * 1000,
      y: d.dot(vAxis) * 1000,
    };
  };

  const local2D: Point2D[] = verts.map(projectMm);
  let outerSignedMm2 = polygonSignedArea2D(local2D);
  if (Math.abs(outerSignedMm2) < 1e-3) return null;

  if (outerSignedMm2 < 0) {
    verts.reverse();
    local2D.reverse();
    outerSignedMm2 = -outerSignedMm2;
  }

  const outerC = polygonCentroid2D(local2D);
  let netAreaMm2 = outerSignedMm2;
  let momentX = outerC.x * outerSignedMm2;
  let momentY = outerC.y * outerSignedMm2;

  const holesVerts: number[][] = [];
  const holesLocal2D: Point2D[][] = [];

  if (holesVertsIn && holesVertsIn.length > 0) {
    for (const rawHole of holesVertsIn) {
      if (rawHole.length < 3) continue;
      const hv = [...rawHole];
      const hl2d = hv.map(projectMm);
      let hSigned = polygonSignedArea2D(hl2d);
      if (Math.abs(hSigned) < 1e-3) continue;
      // Interior holes wind CW (negative signed area) around `normal`
      if (hSigned > 0) {
        hv.reverse();
        hl2d.reverse();
        hSigned = -hSigned;
      }
      const hArea = Math.abs(hSigned);
      const hC = polygonCentroid2D(hl2d);
      netAreaMm2 -= hArea;
      momentX -= hC.x * hArea;
      momentY -= hC.y * hArea;
      holesVerts.push(hv);
      holesLocal2D.push(hl2d);
    }
  }

  if (netAreaMm2 < 1e-3) return null;

  const cxMm = momentX / netAreaMm2;
  const cyMm = momentY / netAreaMm2;
  const centroid = v0
    .clone()
    .addScaledVector(uAxis, cxMm / 1000)
    .addScaledVector(vAxis, cyMm / 1000);

  return {
    index,
    verts,
    holesVerts: holesVerts.length > 0 ? holesVerts : undefined,
    normal,
    centroid,
    areaM2: netAreaMm2 * 1e-6,
    local2D,
    holesLocal2D: holesLocal2D.length > 0 ? holesLocal2D : undefined,
  };
}

/**
 * Ensures consistent manifold triangle winding per connected component and
 * flips closed inside-out shells (`signedVolume < 0`) so outward normals point out.
 */
function normalizeTriangleMeshWinding(vertices: THREE.Vector3[], triIndices: number[]): number[] {
  const nTris = Math.floor(triIndices.length / 3);
  if (nTris === 0) return triIndices;

  const tris: [number, number, number][] = [];
  const areas: number[] = [];
  const validIdxMap: number[] = [];

  for (let t = 0; t < nTris; t++) {
    const a = triIndices[t * 3];
    const b = triIndices[t * 3 + 1];
    const c = triIndices[t * 3 + 2];
    if (a === b || b === c || c === a) continue;
    const va = vertices[a], vb = vertices[b], vc = vertices[c];
    if (!va || !vb || !vc) continue;
    const ab = new THREE.Vector3().subVectors(vb, va);
    const ac = new THREE.Vector3().subVectors(vc, va);
    const area = new THREE.Vector3().crossVectors(ab, ac).length() * 0.5;
    if (area < 1e-10) continue;
    validIdxMap.push(tris.length);
    tris.push([a, b, c]);
    areas.push(area);
  }

  if (tris.length === 0) return [];

  const undirKey = (u: number, v: number) => (u < v ? `${u}:${v}` : `${v}:${u}`);
  const edgeToTris = new Map<string, number[]>();
  for (let ti = 0; ti < tris.length; ti++) {
    const v = tris[ti];
    for (let e = 0; e < 3; e++) {
      const k = undirKey(v[e], v[(e + 1) % 3]);
      let list = edgeToTris.get(k);
      if (!list) {
        list = [];
        edgeToTris.set(k, list);
      }
      list.push(ti);
    }
  }

  const visited = new Uint8Array(tris.length);
  for (let start = 0; start < tris.length; start++) {
    if (visited[start]) continue;
    visited[start] = 1;
    const comp: number[] = [start];
    const queue: number[] = [start];
    let keptArea = areas[start];
    let flippedArea = 0;

    while (queue.length > 0) {
      const currId = queue.shift()!;
      const cv = tris[currId];
      for (let e = 0; e < 3; e++) {
        const u = cv[e];
        const v = cv[(e + 1) % 3];
        const shared = edgeToTris.get(undirKey(u, v));
        // Only propagate orientation across manifold 2-triangle edges
        if (!shared || shared.length !== 2) continue;
        const nbId = shared[0] === currId ? shared[1] : shared[0];
        if (visited[nbId]) continue;
        visited[nbId] = 1;

        const nv = tris[nbId];
        // Consistent manifold neighbor traverses shared edge as v -> u.
        // If it traverses u -> v instead, flip neighbor triangle.
        let sameDir = false;
        for (let ne = 0; ne < 3; ne++) {
          if (nv[ne] === u && nv[(ne + 1) % 3] === v) {
            sameDir = true;
            break;
          }
        }
        if (sameDir) {
          const tmp = nv[1];
          nv[1] = nv[2];
          nv[2] = tmp;
          flippedArea += areas[nbId];
        } else {
          keptArea += areas[nbId];
        }
        comp.push(nbId);
        queue.push(nbId);
      }
    }

    // Check if this component is closed (every edge in comp is shared by 2 tris in comp)
    const compEdgeCounts = new Map<string, number>();
    for (const ti of comp) {
      const v = tris[ti];
      for (let e = 0; e < 3; e++) {
        const k = undirKey(v[e], v[(e + 1) % 3]);
        compEdgeCounts.set(k, (compEdgeCounts.get(k) ?? 0) + 1);
      }
    }
    let isClosed = comp.length >= 4;
    for (const cnt of compEdgeCounts.values()) {
      if (cnt !== 2) {
        isClosed = false;
        break;
      }
    }

    let flipAll = false;
    if (isClosed) {
      const ref = vertices[tris[comp[0]][0]];
      let vol6 = 0;
      const d1 = new THREE.Vector3();
      const d2 = new THREE.Vector3();
      const d3 = new THREE.Vector3();
      const cr = new THREE.Vector3();
      for (const ti of comp) {
        const [a, b, c] = tris[ti];
        d1.subVectors(vertices[a], ref);
        d2.subVectors(vertices[b], ref);
        d3.subVectors(vertices[c], ref);
        cr.crossVectors(d2, d3);
        vol6 += d1.dot(cr);
      }
      if (vol6 < -1e-15) flipAll = true;
    } else if (flippedArea > keptArea + 1e-12) {
      flipAll = true;
    }

    if (flipAll) {
      for (const ti of comp) {
        const nv = tris[ti];
        const tmp = nv[1];
        nv[1] = nv[2];
        nv[2] = tmp;
      }
    }
  }

  const out: number[] = [];
  for (const [a, b, c] of tris) {
    out.push(a, b, c);
  }
  return out;
}

/**
 * Clusters coplanar adjacent triangles into polygonal faces within `coplanarToleranceDeg`,
 * preserving interior hole boundary loops (`holesVerts` / `holesLocal2D`).
 */
export function clusterTrianglesToPolyFaces(
  vertices: THREE.Vector3[],
  triIndices: number[],
  coplanarToleranceDeg: number
): PolyFace3D[] {
  const orientedIndices = normalizeTriangleMeshWinding(vertices, triIndices);

  interface TriInfo {
    id: number;
    v: [number, number, number];
    normal: THREE.Vector3;
    area: number;
  }

  const tris: TriInfo[] = [];
  for (let i = 0; i + 2 < orientedIndices.length; i += 3) {
    const a = orientedIndices[i];
    const b = orientedIndices[i + 1];
    const c = orientedIndices[i + 2];
    if (a === b || b === c || c === a) continue;
    const va = vertices[a];
    const vb = vertices[b];
    const vc = vertices[c];
    if (!va || !vb || !vc) continue;
    const ab = new THREE.Vector3().subVectors(vb, va);
    const ac = new THREE.Vector3().subVectors(vc, va);
    const cross = new THREE.Vector3().crossVectors(ab, ac);
    const len = cross.length();
    if (len < 1e-9) continue;
    tris.push({
      id: tris.length,
      v: [a, b, c],
      normal: cross.divideScalar(len),
      area: len * 0.5,
    });
  }

  if (tris.length === 0) return [];

  // Map undirected edge -> triangles sharing it
  const edgeToTris = new Map<string, number[]>();
  const undirectedKey = (u: number, v: number) => (u < v ? `${u}:${v}` : `${v}:${u}`);
  for (const t of tris) {
    for (let e = 0; e < 3; e++) {
      const k = undirectedKey(t.v[e], t.v[(e + 1) % 3]);
      let list = edgeToTris.get(k);
      if (!list) {
        list = [];
        edgeToTris.set(k, list);
      }
      list.push(t.id);
    }
  }

  const cosTol = Math.cos(Math.max(0.01, coplanarToleranceDeg) * THREE.MathUtils.DEG2RAD);
  const visited = new Uint8Array(tris.length);
  const clusters: number[][] = [];
  const triClusterId = new Int32Array(tris.length).fill(-1);

  for (let i = 0; i < tris.length; i++) {
    if (visited[i]) continue;
    visited[i] = 1;
    const clusterId = clusters.length;
    const cluster: number[] = [i];
    triClusterId[i] = clusterId;
    const seedNormal = tris[i].normal.clone();
    const queue: number[] = [i];

    while (queue.length > 0) {
      const currId = queue.shift()!;
      const curr = tris[currId];
      for (let e = 0; e < 3; e++) {
        const u = curr.v[e];
        const v = curr.v[(e + 1) % 3];
        const neighbors = edgeToTris.get(undirectedKey(u, v)) || [];
        for (const nbId of neighbors) {
          if (visited[nbId]) continue;
          const nb = tris[nbId];
          let consistent = false;
          for (let ne = 0; ne < 3; ne++) {
            if (nb.v[ne] === v && nb.v[(ne + 1) % 3] === u) {
              consistent = true;
              break;
            }
          }
          if (!consistent) continue;
          if (curr.normal.dot(nb.normal) >= cosTol && seedNormal.dot(nb.normal) >= cosTol) {
            visited[nbId] = 1;
            triClusterId[nbId] = clusterId;
            cluster.push(nbId);
            queue.push(nbId);
          }
        }
      }
    }
    clusters.push(cluster);
  }

  // Track which clusters touch each vertex and each undirected edge so we only collapse
  // collinear intermediate vertices when both incident edges and the vertex itself belong
  // to the exact same set of clusters (preserving partial-flange T-junctions like b0-b1-b2).
  const vertexClusters = new Map<number, Set<number>>();
  const edgeClusters = new Map<string, Set<number>>();
  for (let tId = 0; tId < tris.length; tId++) {
    const cid = triClusterId[tId];
    const tv = tris[tId].v;
    for (let e = 0; e < 3; e++) {
      const u = tv[e];
      const v = tv[(e + 1) % 3];
      let vSet = vertexClusters.get(u);
      if (!vSet) {
        vSet = new Set();
        vertexClusters.set(u, vSet);
      }
      vSet.add(cid);

      const ek = undirectedKey(u, v);
      let eSet = edgeClusters.get(ek);
      if (!eSet) {
        eSet = new Set();
        edgeClusters.set(ek, eSet);
      }
      eSet.add(cid);
    }
  }

  const sameClusterSet = (a?: Set<number>, b?: Set<number>): boolean => {
    if (!a || !b || a.size !== b.size) return false;
    for (const x of a) {
      if (!b.has(x)) return false;
    }
    return true;
  };

  const simplifyLoop = (loop: number[]): number[] => {
    let curr = loop.slice();
    let changed = true;
    while (changed && curr.length > 3) {
      changed = false;
      const next: number[] = [];
      const n = curr.length;
      for (let i = 0; i < n; i++) {
        const prevV = curr[(i - 1 + n) % n];
        const currV = curr[i];
        const nextV = curr[(i + 1) % n];
        const vSet = vertexClusters.get(currV);
        const ePrev = edgeClusters.get(undirectedKey(prevV, currV));
        const eNext = edgeClusters.get(undirectedKey(currV, nextV));
        if (
          curr.length - (i - next.length) > 3 &&
          vSet &&
          vSet.size <= 2 &&
          sameClusterSet(ePrev, eNext) &&
          sameClusterSet(vSet, ePrev)
        ) {
          const d1 = new THREE.Vector3().subVectors(vertices[currV], vertices[prevV]).normalize();
          const d2 = new THREE.Vector3().subVectors(vertices[nextV], vertices[currV]).normalize();
          if (d1.dot(d2) > 0.9995) {
            changed = true;
            continue;
          }
        }
        next.push(currV);
      }
      curr = next;
    }
    return curr.length >= 3 ? curr : loop;
  };

  const polyFaces: PolyFace3D[] = [];

  for (const cluster of clusters) {
    const clusterNormal = new THREE.Vector3();
    for (const tId of cluster) {
      clusterNormal.addScaledVector(tris[tId].normal, tris[tId].area);
    }
    if (clusterNormal.lengthSq() < 1e-18) continue;
    clusterNormal.normalize();

    // Collect directed half-edges and cancel interior opposite pairs by count
    const dirCount = new Map<string, number>();
    const halfEdges: [number, number][] = [];
    for (const tId of cluster) {
      const v = tris[tId].v;
      for (let e = 0; e < 3; e++) {
        const a = v[e];
        const b = v[(e + 1) % 3];
        const k = `${a}:${b}`;
        dirCount.set(k, (dirCount.get(k) ?? 0) + 1);
        halfEdges.push([a, b]);
      }
    }

    const canceled = new Map<string, number>();
    const boundaryEdges: [number, number][] = [];
    for (const [a, b] of halfEdges) {
      const revKey = `${b}:${a}`;
      const oppAvail = (dirCount.get(revKey) ?? 0) - (canceled.get(revKey) ?? 0);
      if (oppAvail > 0) {
        canceled.set(revKey, (canceled.get(revKey) ?? 0) + 1);
      } else {
        boundaryEdges.push([a, b]);
      }
    }
    if (boundaryEdges.length < 3) continue;

    const refOrigin = vertices[boundaryEdges[0][0]];
    const { uAxis, vAxis } = buildFaceBasis3D(clusterNormal, refOrigin, vertices[boundaryEdges[0][1]]);
    const proj2D = (vi: number): Point2D => {
      const d = new THREE.Vector3().subVectors(vertices[vi], refOrigin);
      return { x: d.dot(uAxis) * 1000, y: d.dot(vAxis) * 1000 };
    };

    // Chain directed boundary edges into closed loop(s), resolving pinch vertices cleanly
    const nextMap = new Map<number, number[]>();
    for (let idx = 0; idx < boundaryEdges.length; idx++) {
      const a = boundaryEdges[idx][0];
      let list = nextMap.get(a);
      if (!list) {
        list = [];
        nextMap.set(a, list);
      }
      list.push(idx);
    }

    const usedEdge = new Uint8Array(boundaryEdges.length);
    const loops: number[][] = [];

    for (let s = 0; s < boundaryEdges.length; s++) {
      if (usedEdge[s]) continue;
      usedEdge[s] = 1;
      const startV = boundaryEdges[s][0];
      const loop: number[] = [startV];
      let prevV = startV;
      let currV = boundaryEdges[s][1];

      for (let guard = 0; guard <= boundaryEdges.length; guard++) {
        if (currV === startV) break;
        loop.push(currV);
        const candidates = (nextMap.get(currV) || []).filter((cIdx) => !usedEdge[cIdx]);
        if (candidates.length === 0) break;

        let chosen = candidates[0];
        if (candidates.length > 1) {
          // Turn maximally clockwise relative to incoming reverse vector to keep loops uncrossed
          const pPrev = proj2D(prevV);
          const pCurr = proj2D(currV);
          const inAngle = Math.atan2(pPrev.y - pCurr.y, pPrev.x - pCurr.x);
          let bestSweep = Infinity;
          for (const cIdx of candidates) {
            const pNext = proj2D(boundaryEdges[cIdx][1]);
            const outAngle = Math.atan2(pNext.y - pCurr.y, pNext.x - pCurr.x);
            let cwSweep = inAngle - outAngle;
            while (cwSweep <= 0) cwSweep += Math.PI * 2;
            if (cwSweep < bestSweep) {
              bestSweep = cwSweep;
              chosen = cIdx;
            }
          }
        }
        usedEdge[chosen] = 1;
        prevV = currV;
        currV = boundaryEdges[chosen][1];
      }

      if (loop.length >= 3) {
        loops.push(simplifyLoop(loop));
      }
    }

    if (loops.length === 0) continue;

    if (loops.length === 1) {
      const pf = buildPolyFace3D(polyFaces.length, loops[0], vertices, clusterNormal);
      if (pf) polyFaces.push(pf);
      continue;
    }

    const validLoops: number[][] = [];
    const loops2D: Point2D[][] = [];
    for (const lp of loops) {
      const l2 = lp.map(proj2D);
      if (polygonArea2D(l2) >= 1e-3) {
        validLoops.push(lp);
        loops2D.push(l2);
      }
    }

    if (validLoops.length === 0) continue;
    if (validLoops.length === 1) {
      const pf = buildPolyFace3D(polyFaces.length, validLoops[0], vertices, clusterNormal);
      if (pf) polyFaces.push(pf);
      continue;
    }

    const depths = nestingDepths(loops2D);
    for (let oi = 0; oi < validLoops.length; oi++) {
      if (depths[oi] % 2 !== 0) continue;
      const holeLoops: number[][] = [];
      for (let hi = 0; hi < validLoops.length; hi++) {
        if (depths[hi] === depths[oi] + 1 && pointInPolygon(loops2D[hi][0], loops2D[oi])) {
          holeLoops.push(validLoops[hi]);
        }
      }
      const pf = buildPolyFace3D(polyFaces.length, validLoops[oi], vertices, clusterNormal, holeLoops);
      if (pf) polyFaces.push(pf);
    }
  }

  return polyFaces;
}

/**
 * Removes recessed internal hole/bore wall facet strips that attach to the body
 * solely along `holesVerts` rims and extend inward behind the host face(s),
 * leaving clean planar cutout loops (`holesVerts`) on the host faces.
 */
function filterInternalBoreFacets(vertices: THREE.Vector3[], faces: PolyFace3D[]): PolyFace3D[] {
  if (faces.length < 2) return faces;

  const undirKey = (u: number, v: number) => (u < v ? `${u}:${v}` : `${v}:${u}`);
  const holeRimEdges = new Set<string>();
  const holeEdgeHosts = new Map<string, PolyFace3D[]>();
  const hostFaceSet = new Set<number>();

  for (let fi = 0; fi < faces.length; fi++) {
    const f = faces[fi];
    if (!f.holesVerts || f.holesVerts.length === 0) continue;
    hostFaceSet.add(fi);
    for (const hLoop of f.holesVerts) {
      for (let i = 0; i < hLoop.length; i++) {
        const k = undirKey(hLoop[i], hLoop[(i + 1) % hLoop.length]);
        holeRimEdges.add(k);
        let list = holeEdgeHosts.get(k);
        if (!list) {
          list = [];
          holeEdgeHosts.set(k, list);
        }
        list.push(f);
      }
    }
  }

  if (holeRimEdges.size === 0) return faces;

  // Build face adjacency excluding `holeRimEdges`
  const nonHoleEdgeToFaces = new Map<string, number[]>();
  const faceAllLoops = (f: PolyFace3D): number[][] => [f.verts, ...(f.holesVerts ?? [])];

  for (let fi = 0; fi < faces.length; fi++) {
    for (const lp of faceAllLoops(faces[fi])) {
      for (let i = 0; i < lp.length; i++) {
        const k = undirKey(lp[i], lp[(i + 1) % lp.length]);
        if (holeRimEdges.has(k)) continue;
        let list = nonHoleEdgeToFaces.get(k);
        if (!list) {
          list = [];
          nonHoleEdgeToFaces.set(k, list);
        }
        list.push(fi);
      }
    }
  }

  const visited = new Uint8Array(faces.length);
  const dropFace = new Uint8Array(faces.length);

  for (let s = 0; s < faces.length; s++) {
    if (visited[s]) continue;
    visited[s] = 1;
    const comp: number[] = [s];
    const queue: number[] = [s];

    while (queue.length > 0) {
      const curr = queue.shift()!;
      for (const lp of faceAllLoops(faces[curr])) {
        for (let i = 0; i < lp.length; i++) {
          const k = undirKey(lp[i], lp[(i + 1) % lp.length]);
          if (holeRimEdges.has(k)) continue;
          for (const nb of nonHoleEdgeToFaces.get(k) || []) {
            if (!visited[nb]) {
              visited[nb] = 1;
              comp.push(nb);
              queue.push(nb);
            }
          }
        }
      }
    }

    if (comp.some((fi) => hostFaceSet.has(fi))) continue;

    // Check if this severed component attaches to host faces via holeRimEdges and sits recessed behind them
    const touchedHosts = new Set<PolyFace3D>();
    const compVerts = new Set<number>();
    for (const fi of comp) {
      const f = faces[fi];
      for (let i = 0; i < f.verts.length; i++) {
        const u = f.verts[i];
        const v = f.verts[(i + 1) % f.verts.length];
        compVerts.add(u);
        const hosts = holeEdgeHosts.get(undirKey(u, v));
        if (hosts) {
          for (const h of hosts) touchedHosts.add(h);
        }
      }
    }

    if (touchedHosts.size === 0) continue;

    let recessedBehindAll = true;
    let strictlyInsideSome = false;
    const diff = new THREE.Vector3();
    for (const host of touchedHosts) {
      const ref = vertices[host.verts[0]];
      for (const vi of compVerts) {
        const d = diff.subVectors(vertices[vi], ref).dot(host.normal);
        if (d > 2e-4) {
          recessedBehindAll = false;
          break;
        }
        if (d < -1e-4) {
          strictlyInsideSome = true;
        }
      }
      if (!recessedBehindAll) break;
    }

    if (recessedBehindAll && strictlyInsideSome && comp.length < faces.length) {
      for (const fi of comp) dropFace[fi] = 1;
    }
  }

  const kept = faces.filter((_, idx) => !dropFace[idx]);
  if (kept.length === 0 || kept.length === faces.length) return faces;
  return kept.map((f, idx) => ({ ...f, index: idx }));
}

/**
 * Detects thin-walled 3D solid shells (two antiparallel offset skins separated by
 * uniform wall thickness `~W` bounded by thin rim strips, such as thickened brackets,
 * hollow open-top trays, or sheet plates with cutouts) and extracts a single outer
 * reference skin, leaving thick closed polyhedra (cubes, prisms, pyramids) intact.
 */
function extractSingleSkinIfThinShell(
  vertices: THREE.Vector3[],
  faces: PolyFace3D[],
  options: SheetUnfoldOptions
): PolyFace3D[] {
  if (faces.length < 4) return faces;

  const undirKey = (u: number, v: number) => (u < v ? `${u}:${v}` : `${v}:${u}`);
  const faceAllLoops = (f: PolyFace3D): number[][] => [f.verts, ...(f.holesVerts ?? [])];

  // Split into 3D edge-connected solid components (including hole rim connections)
  const edgeToFaces = new Map<string, number[]>();
  for (let fi = 0; fi < faces.length; fi++) {
    for (const lp of faceAllLoops(faces[fi])) {
      for (let i = 0; i < lp.length; i++) {
        const k = undirKey(lp[i], lp[(i + 1) % lp.length]);
        let list = edgeToFaces.get(k);
        if (!list) {
          list = [];
          edgeToFaces.set(k, list);
        }
        list.push(fi);
      }
    }
  }

  const visitedComp = new Uint8Array(faces.length);
  const keptFaces: PolyFace3D[] = [];

  for (let s = 0; s < faces.length; s++) {
    if (visitedComp[s]) continue;
    visitedComp[s] = 1;
    const compIndices: number[] = [s];
    const qComp: number[] = [s];
    while (qComp.length > 0) {
      const curr = qComp.shift()!;
      for (const lp of faceAllLoops(faces[curr])) {
        for (let i = 0; i < lp.length; i++) {
          const k = undirKey(lp[i], lp[(i + 1) % lp.length]);
          for (const nb of edgeToFaces.get(k) || []) {
            if (!visitedComp[nb]) {
              visitedComp[nb] = 1;
              compIndices.push(nb);
              qComp.push(nb);
            }
          }
        }
      }
    }

    const comp = compIndices.map((idx) => faces[idx]);
    if (comp.length < 4) {
      keptFaces.push(...comp);
      continue;
    }

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (const f of comp) {
      for (const vi of f.verts) {
        const p = vertices[vi];
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
      }
    }
    const bboxDiagMm = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * 1000;
    if (bboxDiagMm < 1e-3) {
      keptFaces.push(...comp);
      continue;
    }

    const maxWallMm = Math.min(
      0.22 * bboxDiagMm,
      Math.max(3.5 * Math.max(0.5, options.thicknessMm), Math.min(8.0, 0.15 * bboxDiagMm))
    );

    const grossAreasMm2 = comp.map((f) => polygonArea2D(f.local2D));
    const netAreasMm2 = comp.map((f) => f.areaM2 * 1e6);
    const compNetAreaMm2 = netAreasMm2.reduce((acc, a) => acc + a, 0);

    interface WallPair {
      a: number;
      b: number;
      sepMm: number;
      weight: number;
    }
    const candidatePairs: WallPair[] = [];
    const diff = new THREE.Vector3();

    for (let i = 0; i < comp.length; i++) {
      const fa = comp[i];
      for (let j = i + 1; j < comp.length; j++) {
        const fb = comp[j];
        if (fa.normal.dot(fb.normal) > -0.95) continue;

        // Solid wall lies behind fa (`-fa.normal`), so `(fa.centroid - fb.centroid) . fa.normal > 0`
        const sepMm = diff.subVectors(fa.centroid, fb.centroid).dot(fa.normal) * 1000;
        if (sepMm <= 0.05 || sepMm > maxWallMm) continue;

        const minFaceArea = Math.min(netAreasMm2[i], netAreasMm2[j]);
        if (minFaceArea < 1.5 * sepMm * sepMm) continue;

        // Reject pairing a thin open-mouth picture-frame rim (>60% hole) against a solid floor panel
        const fillRatioA = grossAreasMm2[i] > 1e-6 ? netAreasMm2[i] / grossAreasMm2[i] : 1;
        const fillRatioB = grossAreasMm2[j] > 1e-6 ? netAreasMm2[j] / grossAreasMm2[j] : 1;
        if ((fillRatioA < 0.4 && fillRatioB > 0.8) || (fillRatioB < 0.4 && fillRatioA > 0.8)) continue;

        // Project both faces onto fa's tangent plane and check 2D overlap
        const ref = vertices[fa.verts[0]];
        const { uAxis, vAxis } = buildFaceBasis3D(fa.normal, ref, vertices[fa.verts[1]]);
        const proj = (vi: number): Point2D => {
          diff.subVectors(vertices[vi], ref);
          return { x: diff.dot(uAxis) * 1000, y: diff.dot(vAxis) * 1000 };
        };
        const polyA = fa.verts.map(proj);
        const polyB = fb.verts.map(proj);

        let aMinX = Infinity, aMaxX = -Infinity, aMinY = Infinity, aMaxY = -Infinity;
        for (const p of polyA) {
          if (p.x < aMinX) aMinX = p.x;
          if (p.x > aMaxX) aMaxX = p.x;
          if (p.y < aMinY) aMinY = p.y;
          if (p.y > aMaxY) aMaxY = p.y;
        }
        let bMinX = Infinity, bMaxX = -Infinity, bMinY = Infinity, bMaxY = -Infinity;
        for (const p of polyB) {
          if (p.x < bMinX) bMinX = p.x;
          if (p.x > bMaxX) bMaxX = p.x;
          if (p.y < bMinY) bMinY = p.y;
          if (p.y > bMaxY) bMaxY = p.y;
        }
        const ovX = Math.max(0, Math.min(aMaxX, bMaxX) - Math.max(aMinX, bMinX));
        const ovY = Math.max(0, Math.min(aMaxY, bMaxY) - Math.max(aMinY, bMinY));
        if (ovX * ovY < 0.25 * minFaceArea) continue;
        if (!polygonsOverlap2D(polyA, polyB, 0.05)) continue;

        candidatePairs.push({ a: i, b: j, sepMm, weight: minFaceArea });
      }
    }

    if (candidatePairs.length === 0) {
      keptFaces.push(...comp);
      continue;
    }

    // Find dominant wall thickness W across candidate pairs
    let dominantW = candidatePairs[0].sepMm;
    let bestWeight = -1;
    for (const p of candidatePairs) {
      const tol = Math.max(0.5, 0.30 * p.sepMm);
      let wSum = 0;
      for (const q of candidatePairs) {
        if (Math.abs(q.sepMm - p.sepMm) <= tol) wSum += q.weight;
      }
      if (wSum > bestWeight) {
        bestWeight = wSum;
        dominantW = p.sepMm;
      }
    }

    const wTol = Math.max(0.5, 0.30 * dominantW);
    const validPairs = candidatePairs.filter((p) => Math.abs(p.sepMm - dominantW) <= wTol);
    const pairedSet = new Set<number>();
    for (const p of validPairs) {
      pairedSet.add(p.a);
      pairedSet.add(p.b);
    }

    let pairedNetAreaMm2 = 0;
    for (const idx of pairedSet) pairedNetAreaMm2 += netAreasMm2[idx];
    if (pairedNetAreaMm2 < 0.55 * compNetAreaMm2) {
      keptFaces.push(...comp);
      continue;
    }

    // Build 2-coloring graph on pairedSet:
    //   same-color across shared outer edges (`n1 . n2 > -0.85`)
    //   opposite-color across antiparallel `validPairs`
    const sameAdj = new Map<number, Set<number>>();
    const oppAdj = new Map<number, Set<number>>();
    for (const idx of pairedSet) {
      sameAdj.set(idx, new Set());
      oppAdj.set(idx, new Set());
    }
    for (const p of validPairs) {
      oppAdj.get(p.a)!.add(p.b);
      oppAdj.get(p.b)!.add(p.a);
    }

    const outerEdgeToPaired = new Map<string, number[]>();
    for (const idx of pairedSet) {
      const v = comp[idx].verts;
      for (let e = 0; e < v.length; e++) {
        const k = undirKey(v[e], v[(e + 1) % v.length]);
        let list = outerEdgeToPaired.get(k);
        if (!list) {
          list = [];
          outerEdgeToPaired.set(k, list);
        }
        list.push(idx);
      }
    }
    for (const list of outerEdgeToPaired.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j];
          if (comp[a].normal.dot(comp[b].normal) > -0.85) {
            sameAdj.get(a)!.add(b);
            sameAdj.get(b)!.add(a);
          }
        }
      }
    }

    const color = new Int8Array(comp.length).fill(-1);
    let hasConflict = false;
    const selectedSkin = new Set<number>();

    for (const seed of pairedSet) {
      if (color[seed] !== -1) continue;
      color[seed] = 0;
      const group0: number[] = [seed];
      const group1: number[] = [];
      const bfs: number[] = [seed];

      while (bfs.length > 0 && !hasConflict) {
        const u = bfs.shift()!;
        const cu = color[u];
        for (const v of sameAdj.get(u) || []) {
          if (color[v] === -1) {
            color[v] = cu;
            (cu === 0 ? group0 : group1).push(v);
            bfs.push(v);
          } else if (color[v] !== cu) {
            hasConflict = true;
            break;
          }
        }
        if (hasConflict) break;
        const oppColor = cu === 0 ? 1 : 0;
        for (const v of oppAdj.get(u) || []) {
          if (color[v] === -1) {
            color[v] = oppColor;
            (oppColor === 0 ? group0 : group1).push(v);
            bfs.push(v);
          } else if (color[v] !== oppColor) {
            hasConflict = true;
            break;
          }
        }
      }

      if (hasConflict) break;

      const area0 = group0.reduce((sum, idx) => sum + netAreasMm2[idx], 0);
      const area1 = group1.reduce((sum, idx) => sum + netAreasMm2[idx], 0);
      const winners = area0 >= area1 ? group0 : group1;
      for (const idx of winners) selectedSkin.add(idx);
    }

    if (hasConflict || selectedSkin.size === 0) {
      keptFaces.push(...comp);
    } else {
      for (let i = 0; i < comp.length; i++) {
        if (selectedSkin.has(i)) keptFaces.push(comp[i]);
      }
    }
  }

  return keptFaces.map((f, idx) => ({ ...f, index: idx }));
}

/**
 * Extracts 3D polygonal surfaces from a scene graph.
 * Supports:
 *   1. `node.latticeCage` polygonal faces directly when present, unsubdivided, unbaked, and without CSG modifiers
 *   2. Box and cylinder primitives
 *   3. Compiled CSG or triangle meshes (`geom.type === 'mesh'`), with internal bore filtering and thin-shell single-skin extraction
 */
function extractSurfacesFromScene(
  scene: SceneGraph,
  options: SheetUnfoldOptions,
  targetNodeIds?: string[]
): { surfaces: PolySurface3D[]; warnings: string[] } {
  const surfaces: PolySurface3D[] = [];
  const warnings: string[] = [];
  const targetSet = targetNodeIds && targetNodeIds.length > 0 ? new Set(targetNodeIds) : null;
  const scale = options.scaleFactor > 0 ? options.scaleFactor : 1.0;

  function applyTransformAndScale(v: THREE.Vector3, matrix: THREE.Matrix4): THREE.Vector3 {
    return v.clone().applyMatrix4(matrix).multiplyScalar(scale);
  }

  function extractFromBox(
    nodeId: string,
    nodeName: string,
    hx: number,
    hy: number,
    hz: number,
    matrix: THREE.Matrix4
  ): PolySurface3D | null {
    const rawCorners = [
      new THREE.Vector3(-hx, -hy, -hz), // 0
      new THREE.Vector3( hx, -hy, -hz), // 1
      new THREE.Vector3( hx,  hy, -hz), // 2
      new THREE.Vector3(-hx,  hy, -hz), // 3
      new THREE.Vector3(-hx, -hy,  hz), // 4
      new THREE.Vector3( hx, -hy,  hz), // 5
      new THREE.Vector3( hx,  hy,  hz), // 6
      new THREE.Vector3(-hx,  hy,  hz), // 7
    ].map((p) => applyTransformAndScale(p, matrix));

    const flip = matrix.determinant() < 0;
    // Six quad faces wound CCW seen from outside
    const quadIndices = [
      [0, 3, 2, 1], // bottom (-Z)
      [4, 5, 6, 7], // top (+Z)
      [0, 1, 5, 4], // front (-Y)
      [2, 3, 7, 6], // back (+Y)
      [0, 4, 7, 3], // left (-X)
      [1, 2, 6, 5], // right (+X)
    ];

    const faces: PolyFace3D[] = [];
    for (const q of quadIndices) {
      const loop = flip ? [...q].reverse() : [...q];
      const f = buildPolyFace3D(faces.length, loop, rawCorners);
      if (f) faces.push(f);
    }
    return faces.length > 0 ? { nodeId, nodeName, vertices: rawCorners, faces } : null;
  }

  function extractFromCylinder(
    nodeId: string,
    nodeName: string,
    radius: number,
    halfLen: number,
    facets: number,
    matrix: THREE.Matrix4
  ): PolySurface3D | null {
    const n = Math.max(3, Math.min(36, facets));
    const vertices: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2;
      const x = Math.cos(ang) * radius;
      const y = Math.sin(ang) * radius;
      vertices.push(applyTransformAndScale(new THREE.Vector3(x, y, -halfLen), matrix));
    }
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2;
      const x = Math.cos(ang) * radius;
      const y = Math.sin(ang) * radius;
      vertices.push(applyTransformAndScale(new THREE.Vector3(x, y, halfLen), matrix));
    }

    const flip = matrix.determinant() < 0;
    const maybeFlip = (lp: number[]) => (flip ? [...lp].reverse() : lp);

    const faces: PolyFace3D[] = [];
    const bottomLoop = maybeFlip(Array.from({ length: n }, (_, i) => n - 1 - i));
    const bottomFace = buildPolyFace3D(faces.length, bottomLoop, vertices);
    if (bottomFace) faces.push(bottomFace);

    const topLoop = maybeFlip(Array.from({ length: n }, (_, i) => n + i));
    const topFace = buildPolyFace3D(faces.length, topLoop, vertices);
    if (topFace) faces.push(topFace);

    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      const side = buildPolyFace3D(faces.length, maybeFlip([i, next, n + next, n + i]), vertices);
      if (side) faces.push(side);
    }

    return faces.length > 0 ? { nodeId, nodeName, vertices, faces } : null;
  }

  function traverse(node: SceneNode, parentMatrix?: THREE.Matrix4) {
    // A folded-up net already in the scene is not part of what is unfolded.
    if (node.simulation) {
      warnings.push(`${node.name}: a simulation, so it is left out.`);
      return;
    }
    const bodyMatrix = getNodeWorldTransform(node, parentMatrix);
    const cageMatrix = getCageWorldTransform(node, parentMatrix);
    if (isBoughtIn(node)) {
      for (const child of node.children || []) traverse(child, bodyMatrix);
      return;
    }

    const includeNode = !targetSet || targetSet.has(node.id) || targetSet.has(node.name);

    if (includeNode) {
      let extractedForNode = false;
      const geoms = node.geoms || [];
      const compiledVisual = geoms.find(
        (g) => g.type === 'mesh' && g.csgDerived === 'visual' && (g.renderVertices || g.vertices) && g.faces
      );
      const hasCsgModifiers =
        Boolean(compiledVisual) ||
        Boolean(node.csgEnabled && geoms.some((g) => Boolean(g.csg))) ||
        Boolean(node.edgeRounds && node.edgeRounds.length > 0);

      // 1. Direct latticeCage polygonal faces when present, unsubdivided, unbaked, and without CSG modifiers
      if (
        !hasCsgModifiers &&
        !node.latticeBaked &&
        node.isLattice !== false &&
        node.latticeCage &&
        node.latticeCage.coords.length >= 9 &&
        node.latticeCage.faces.length >= 3 &&
        node.latticeCage.faceSizes.length >= 1 &&
        (node.latticeSubdiv ?? 0) === 0
      ) {
        const cage = node.latticeCage;
        const unit = cage.unit || 0.0001;
        const origin = node.latticeOrigin || [0, 0, 0];
        const rawVerts: THREE.Vector3[] = [];
        for (let i = 0; i + 2 < cage.coords.length; i += 3) {
          const local = new THREE.Vector3(
            cage.coords[i] * unit - (origin[0] || 0),
            cage.coords[i + 1] * unit - (origin[1] || 0),
            cage.coords[i + 2] * unit - (origin[2] || 0)
          );
          rawVerts.push(applyTransformAndScale(local, cageMatrix));
        }

        const { vertices, remap } = weldVertices3D(rawVerts);
        const flip = cageMatrix.determinant() < 0;
        const triIndices: number[] = [];
        let cursor = 0;
        for (const sz of cage.faceSizes) {
          if (sz >= 3 && cursor + sz <= cage.faces.length) {
            const rawLoop = cage.faces.slice(cursor, cursor + sz).map((vi) => remap[vi] ?? 0);
            const loop = flip ? [...rawLoop].reverse() : rawLoop;
            if (loop.length === 3) {
              triIndices.push(loop[0], loop[1], loop[2]);
            } else {
              const pf = buildPolyFace3D(0, loop, vertices);
              if (pf) {
                const contour = pf.local2D.map((p) => new THREE.Vector2(p.x, p.y));
                const localTris = THREE.ShapeUtils.triangulateShape(contour, []);
                for (const [a, b, c] of localTris) {
                  triIndices.push(pf.verts[a], pf.verts[b], pf.verts[c]);
                }
              }
            }
          }
          cursor += sz;
        }

        let polyFaces = clusterTrianglesToPolyFaces(vertices, triIndices, options.coplanarToleranceDeg);
        polyFaces = extractSingleSkinIfThinShell(vertices, polyFaces, options);
        polyFaces = filterInternalBoreFacets(vertices, polyFaces);

        if (polyFaces.length > 0) {
          surfaces.push({
            nodeId: node.id,
            nodeName: node.name || node.id,
            vertices,
            faces: polyFaces,
          });
          extractedForNode = true;
        }
      }

      // 2. Compiled CSG visual mesh or node geoms
      if (!extractedForNode) {
        const geomsToProcess = compiledVisual
          ? [compiledVisual]
          : csgSourceGeoms(node).filter((g) => g.role !== 'collision' && g.csg !== 'difference');

        for (let gi = 0; gi < geomsToProcess.length; gi++) {
          const geom = geomsToProcess[gi];
          const geomMatrix = new THREE.Matrix4().multiplyMatrices(bodyMatrix, getGeomFrame(geom).matrix);
          const partName =
            geomsToProcess.length === 1
              ? node.name || geom.name || node.id
              : `${node.name || node.id}_${geom.name || gi + 1}`;

          if (geom.type === 'box') {
            const sz = geom.size || [0.05, 0.05, 0.05];
            const surf = extractFromBox(
              node.id,
              partName,
              sz[0] || 0.05,
              sz[1] || 0.05,
              sz[2] || 0.05,
              geomMatrix
            );
            if (surf) surfaces.push(surf);
          } else if (geom.type === 'cylinder') {
            const sz = geom.size || [0.025, 0.05];
            const r = sz[0] || 0.025;
            const hl = getGeomFrame(geom).halfLen ?? (sz[1] ?? r);
            const surf = extractFromCylinder(node.id, partName, r, hl, geom.facets ?? 12, geomMatrix);
            if (surf) surfaces.push(surf);
          } else if (geom.type === 'mesh' && (geom.renderVertices || geom.vertices) && geom.faces) {
            const rawCoords = geom.renderVertices ?? yupVertsToZup(geom.vertices || []);
            const rawPts: THREE.Vector3[] = [];
            for (let i = 0; i + 2 < rawCoords.length; i += 3) {
              rawPts.push(
                applyTransformAndScale(
                  new THREE.Vector3(rawCoords[i], rawCoords[i + 1], rawCoords[i + 2]),
                  geomMatrix
                )
              );
            }
            const { vertices, remap } = weldVertices3D(rawPts);
            const flip = geomMatrix.determinant() < 0;
            const remappedTris: number[] = [];
            for (let i = 0; i + 2 < geom.faces.length; i += 3) {
              const a = remap[geom.faces[i]] ?? 0;
              const b = remap[geom.faces[i + 1]] ?? 0;
              const c = remap[geom.faces[i + 2]] ?? 0;
              if (flip) remappedTris.push(a, c, b);
              else remappedTris.push(a, b, c);
            }
            let polyFaces = clusterTrianglesToPolyFaces(
              vertices,
              remappedTris,
              options.coplanarToleranceDeg
            );
            polyFaces = extractSingleSkinIfThinShell(vertices, polyFaces, options);
            polyFaces = filterInternalBoreFacets(vertices, polyFaces);

            if (polyFaces.length > 0) {
              surfaces.push({
                nodeId: node.id,
                nodeName: partName,
                vertices,
                faces: polyFaces,
              });
            } else {
              warnings.push(`Could not extract planar faces from mesh "${partName}".`);
            }
          } else if (geom.type === 'sphere' || geom.type === 'ellipsoid' || geom.type === 'capsule') {
            warnings.push(
              `Skipped non-developable primitive "${partName}" (${geom.type}); convert to a faceted mesh or lattice cage to unfold.`
            );
          }
        }
      }
    }

    for (const child of node.children || []) {
      traverse(child, bodyMatrix);
    }
  }

  for (const root of scene.nodes || []) {
    traverse(root);
  }

  return { surfaces, warnings };
}

// ---------------------------------------------------------------------------
// Face Adjacency Graph, Dihedral Angles & Spanning-Tree Unfolding
// ---------------------------------------------------------------------------

interface SharedMeshEdge {
  id: number;
  v1: number;
  v2: number;
  faceA: number;
  edgeIdxInA: number;
  faceB: number;
  edgeIdxInB: number;
  lengthMm: number;
  /** Signed dihedral angle in degrees (> 0 = mountain/convex, < 0 = valley/concave). */
  angleDeg: number;
  kind: 'mountain' | 'valley';
}

interface PlacedFaceState {
  faceIndex: number;
  /** Placed 2D vertices corresponding to `face.verts` (or stepped vertices after trimming). */
  polygon2D: Point2D[];
  holes2D: Point2D[][];
  /** Maps local 2D point of this face into island 2D space. */
  transformPoint: (localPt: Point2D) => Point2D;
  /**
   * How far each edge is moved in for a bend's setback, mm (sheet metal). The
   * face is drawn to the model's outside; the flat stops this short of it.
   */
  setbacks: number[];
  /** Trimmed start/end points indexed by original `face.verts` edge index. */
  edgeStarts?: Point2D[];
  edgeEnds?: Point2D[];
  /** Maps each vertex of `polygon2D` back to its index in `face.verts`. */
  vertexMap?: number[];
}

/**
 * How far a bend's flat stops short of the model's corner, mm. The model is
 * the outside of the part, the sheet behind it, so a mountain (convex) bend's
 * outside is the model side, radius R + T, and a valley's inside is, radius R.
 * Either way the flat ends where the arc starts, r·tan(θ/2) from the corner.
 */
export function bendSetbackMm(angleDeg: number, bendRadiusMm: number, thicknessMm: number): number {
  const half = (Math.min(179.5, Math.abs(angleDeg)) * Math.PI) / 360;
  const r = Math.max(0, bendRadiusMm) + (angleDeg >= 0 ? Math.max(0, thicknessMm) : 0);
  return r * Math.tan(half);
}

interface TrimmedFace2D {
  polygon2D: Point2D[];
  edgeStarts: Point2D[];
  edgeEnds: Point2D[];
  vertexMap: number[];
}

/**
 * Trims each edge of `poly` inward by its setback, inserting a crisp perpendicular
 * setback step at collinear partial-flange vertices where `setbacks[prev] !== setbacks[i]`
 * so adjacent free edges remain straight rather than shearing diagonally.
 */
function trimPolygonEdges2D(poly: Point2D[], setbacks: number[]): TrimmedFace2D {
  const n = poly.length;
  if (!setbacks.some((d) => d > 0)) {
    return {
      polygon2D: poly.map((p) => ({ ...p })),
      edgeStarts: poly.map((p) => ({ ...p })),
      edgeEnds: poly.map((_, i) => ({ ...poly[(i + 1) % n] })),
      vertexMap: poly.map((_, i) => i),
    };
  }

  // Each edge as a point, direction, and length, moved left (inward: the face is CCW).
  const lines = poly.map((p, i) => {
    const q = poly[(i + 1) % n];
    const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
    const ux = (q.x - p.x) / len, uy = (q.y - p.y) / len;
    const d = setbacks[i] || 0;
    return { x: p.x - uy * d, y: p.y + ux * d, ux, uy, len };
  });

  const edgeStarts: Point2D[] = new Array(n);
  const edgeEnds: Point2D[] = new Array(n);
  const polygon2D: Point2D[] = [];
  const vertexMap: number[] = [];

  const emitPerpStep = (
    i: number,
    prevIdx: number,
    p: Point2D,
    a: (typeof lines)[number],
    b: (typeof lines)[number],
    dPrev: number,
    dCurr: number
  ) => {
    const pIn = { x: p.x - a.uy * dPrev, y: p.y + a.ux * dPrev };
    const pOut = { x: p.x - b.uy * dCurr, y: p.y + b.ux * dCurr };
    edgeEnds[prevIdx] = pIn;
    edgeStarts[i] = pOut;
    polygon2D.push(pIn);
    vertexMap.push(i);
    if (Math.hypot(pOut.x - pIn.x, pOut.y - pIn.y) > 1e-4) {
      polygon2D.push(pOut);
      vertexMap.push(i);
    }
  };

  for (let i = 0; i < n; i++) {
    const p = poly[i];
    const prevIdx = (i - 1 + n) % n;
    const a = lines[prevIdx], b = lines[i];
    const dPrev = setbacks[prevIdx] || 0;
    const dCurr = setbacks[i] || 0;
    const dMax = Math.max(dPrev, dCurr);
    const det = a.ux * b.uy - a.uy * b.ux;

    if (Math.abs(det) < 1e-6) {
      emitPerpStep(i, prevIdx, p, a, b, dPrev, dCurr);
      continue;
    }

    const s = ((b.x - a.x) * b.uy - (b.y - a.y) * b.ux) / det;
    let hit = { x: a.x + a.ux * s, y: a.y + a.uy * s };
    const dist = Math.hypot(hit.x - p.x, hit.y - p.y);

    // When unequal setbacks meet at a shallow corner (e.g. a single bent tab on a
    // 24- or 36-gon cylinder cap where adjacent cap edges are free cut seams with
    // setback 0), mitering shifts the vertex by d / sin(theta) >> edge length.
    // Insert a perpendicular setback step instead so the hinge keeps its true width.
    if (Math.abs(dPrev - dCurr) > 1e-4) {
      const dot = a.ux * b.ux + a.uy * b.uy;
      const trimPrev = (p.x - hit.x) * a.ux + (p.y - hit.y) * a.uy;
      const trimCurr = (hit.x - p.x) * b.ux + (hit.y - p.y) * b.uy;
      if (
        dot > 0.9 ||
        (dot > 0.5 && (trimPrev > 0.85 * a.len || trimCurr > 0.85 * b.len))
      ) {
        emitPerpStep(i, prevIdx, p, a, b, dPrev, dCurr);
        continue;
      }
    }

    // Miter guard on acute corners so setbacks cannot shoot spikes far out of bounds
    if (dMax > 0 && dist > 4 * dMax) {
      const scale = (4 * dMax) / dist;
      hit = { x: p.x + (hit.x - p.x) * scale, y: p.y + (hit.y - p.y) * scale };
    }
    edgeEnds[prevIdx] = hit;
    edgeStarts[i] = { ...hit };
    polygon2D.push(hit);
    vertexMap.push(i);
  }

  return { polygon2D, edgeStarts, edgeEnds, vertexMap };
}

function trimPolygon2D(poly: Point2D[], setbacks: number[]): Point2D[] {
  return trimPolygonEdges2D(poly, setbacks).polygon2D;
}

function isTrimmedPolygonValid2D(origPoly: Point2D[], tr: TrimmedFace2D): boolean {
  const n = origPoly.length;
  const trimmed = tr.polygon2D;
  const m = trimmed.length;
  if (n < 3 || m < 3) return false;
  const origArea = polygonSignedArea2D(origPoly);
  const trimArea = polygonSignedArea2D(trimmed);
  if (origArea <= 1e-6) return true;
  // Prevent inside-out polygon inversion or complete area collapse
  if (trimArea < Math.min(0.2, 0.04 * origArea)) return false;

  // Ensure no boundary edge reverses direction relative to original edge
  for (let i = 0; i < n; i++) {
    const o1 = origPoly[i];
    const o2 = origPoly[(i + 1) % n];
    const oDx = o2.x - o1.x;
    const oDy = o2.y - o1.y;
    const oLen = Math.hypot(oDx, oDy);
    if (oLen < 1e-3) continue;
    const t1 = tr.edgeStarts[i];
    const t2 = tr.edgeEnds[i];
    const projLen = ((t2.x - t1.x) * oDx + (t2.y - t1.y) * oDy) / oLen;
    if (projLen < Math.min(0.15, 0.05 * oLen)) return false;
  }

  // Ensure no non-adjacent edges cross each other
  for (let i = 0; i < m; i++) {
    const a1 = trimmed[i];
    const a2 = trimmed[(i + 1) % m];
    for (let j = i + 2; j < m; j++) {
      if (i === 0 && j === m - 1) continue;
      const b1 = trimmed[j];
      const b2 = trimmed[(j + 1) % m];
      if (segmentsProperlyIntersect2D(a1, a2, b1, b2, 1e-3)) return false;
    }
  }
  return true;
}

/**
 * Evaluates all prospective bend setbacks on a face simultaneously (so multi-bend
 * faceted caps like 24- and 36-sided cylinders shrink cleanly as a whole without
 * premature single-edge clamping), relaxing uniformly and then per-edge only when
 * simultaneous trimming genuinely self-intersects or collapses a narrow web.
 */
function solveSimultaneousSetbacks2D(
  poly: Point2D[],
  desiredSetbacks: number[]
): { setbacks: number[]; clamped: boolean[] } {
  if (!desiredSetbacks.some((d) => d > 0)) {
    return {
      setbacks: desiredSetbacks.map(() => 0),
      clamped: desiredSetbacks.map(() => false),
    };
  }

  const valid = (sb: number[]) => isTrimmedPolygonValid2D(poly, trimPolygonEdges2D(poly, sb));
  if (valid(desiredSetbacks)) {
    return {
      setbacks: [...desiredSetbacks],
      clamped: desiredSetbacks.map(() => false),
    };
  }

  // Uniform relaxation across all bends on the face first so opposing bends share space symmetrically
  let lo = 0;
  let hi = 1;
  for (let iter = 0; iter < 20; iter++) {
    const mid = (lo + hi) * 0.5;
    if (valid(desiredSetbacks.map((d) => d * mid))) lo = mid;
    else hi = mid;
  }

  const best = desiredSetbacks.map((d) => d * lo);
  // Allow individual non-bottleneck edges on a wider portion of the face to recover toward desiredSetbacks
  for (let i = 0; i < desiredSetbacks.length; i++) {
    if (desiredSetbacks[i] <= best[i] + 1e-4) continue;
    let eLo = best[i];
    let eHi = desiredSetbacks[i];
    for (let iter = 0; iter < 14; iter++) {
      const mid = (eLo + eHi) * 0.5;
      const cand = best.map((d, idx) => (idx === i ? mid : d));
      if (valid(cand)) eLo = mid;
      else eHi = mid;
    }
    best[i] = eLo;
  }

  return {
    setbacks: best,
    clamped: best.map((v, i) => v < desiredSetbacks[i] - 1e-3),
  };
}

/**
 * Clamps a candidate setback `desiredSetback` on edge `edgeIdx` (keeping other
 * already-committed `baseSetbacks` fixed) so `trimPolygonEdges2D` never inverts a
 * narrow web or flange inside-out.
 */
function clampEdgeSetbackForPolygon2D(
  poly: Point2D[],
  baseSetbacks: number[],
  edgeIdx: number,
  desiredSetback: number
): { setback: number; clamped: boolean } {
  if (desiredSetback <= 0) return { setback: 0, clamped: false };
  const testWith = (val: number) => {
    const sb = baseSetbacks.map((d, i) => (i === edgeIdx ? val : d));
    return isTrimmedPolygonValid2D(poly, trimPolygonEdges2D(poly, sb));
  };
  if (testWith(desiredSetback)) {
    return { setback: desiredSetback, clamped: false };
  }
  let lo = 0;
  let hi = desiredSetback;
  for (let iter = 0; iter < 18; iter++) {
    const mid = (lo + hi) * 0.5;
    if (testWith(mid)) lo = mid;
    else hi = mid;
  }
  return { setback: lo, clamped: true };
}

/**
 * Computes rigid 2D transform mapping local points of faceB so that its shared
 * edge (localB_v1, localB_v2) lands on faceA's placed edge (placedA_v1, placedA_v2),
 * shifted outward from faceA by `offsetOutwardMm` (for sheet-metal bend allowance).
 */
function buildUnfoldTransform2D(
  placedA_v1: Point2D,
  placedA_v2: Point2D,
  localB_v1: Point2D,
  localB_v2: Point2D,
  offsetOutwardMm: number
): {
  transform: (pt: Point2D) => Point2D;
  targetV1: Point2D;
  targetV2: Point2D;
  outwardNormal: Point2D;
} {
  const dxP = placedA_v2.x - placedA_v1.x;
  const dyP = placedA_v2.y - placedA_v1.y;
  const lenP = Math.hypot(dxP, dyP) || 1;
  const uxP = dxP / lenP;
  const uyP = dyP / lenP;

  // In Face A (wound CCW), edge runs v1 -> v2, so outward normal is to the right: (uyP, -uxP)
  const outX = uyP;
  const outY = -uxP;

  const targetV1: Point2D = {
    x: placedA_v1.x + outX * offsetOutwardMm,
    y: placedA_v1.y + outY * offsetOutwardMm,
  };
  const targetV2: Point2D = {
    x: placedA_v2.x + outX * offsetOutwardMm,
    y: placedA_v2.y + outY * offsetOutwardMm,
  };

  const dxQ = localB_v2.x - localB_v1.x;
  const dyQ = localB_v2.y - localB_v1.y;
  const lenQ = Math.hypot(dxQ, dyQ) || 1;
  const uxQ = dxQ / lenQ;
  const uyQ = dyQ / lenQ;

  // Rotation R(phi) mapping (uxQ, uyQ) -> (uxP, uyP)
  const cosPhi = uxQ * uxP + uyQ * uyP;
  const sinPhi = uxQ * uyP - uyQ * uxP;

  const transform = (pt: Point2D): Point2D => {
    const rx = pt.x - localB_v1.x;
    const ry = pt.y - localB_v1.y;
    return {
      x: targetV1.x + (rx * cosPhi - ry * sinPhi),
      y: targetV1.y + (rx * sinPhi + ry * cosPhi),
    };
  };

  return {
    transform,
    targetV1,
    targetV2,
    outwardNormal: { x: outX, y: outY },
  };
}

function rayHitExpandedLoops2D(origin: Point2D, dir: Point2D, loops: Point2D[][]): number | null {
  let bestT = Infinity;
  for (const lp of loops) {
    for (let i = 0; i < lp.length; i++) {
      const a = lp[i];
      const b = lp[(i + 1) % lp.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const denom = dir.x * dy - dir.y * dx;
      if (Math.abs(denom) < 1e-8) continue;
      const rx = a.x - origin.x;
      const ry = a.y - origin.y;
      const t = (rx * dy - ry * dx) / denom;
      const u = (rx * dir.y - ry * dir.x) / denom;
      if (t > 1e-3 && u >= -1e-4 && u <= 1 + 1e-4 && t < bestT) {
        bestT = t;
      }
    }
  }
  return Number.isFinite(bestT) ? bestT : null;
}

/**
 * Unfolds a single 3D polygonal surface into one or more non-overlapping 2D islands.
 */
function unfoldSurfaceToIslands(
  surface: PolySurface3D,
  options: SheetUnfoldOptions,
  startPairId: number,
  startIslandIndex: number,
  warnings: string[]
): {
  islands: UnfoldIsland[];
  nextPairId: number;
  totalBendAllowanceMm: number;
} {
  const { faces, vertices } = surface;
  if (faces.length === 0) {
    return { islands: [], nextPairId: startPairId, totalBendAllowanceMm: 0 };
  }

  // 1. Build face adjacency graph across shared 3D edges
  const sharedEdges: SharedMeshEdge[] = [];
  const halfEdgeLookup = new Map<string, { faceIdx: number; edgeIdx: number; v1: number; v2: number }>();
  const faceEdgeToShared = new Map<string, SharedMeshEdge>();

  for (let fi = 0; fi < faces.length; fi++) {
    const f = faces[fi];
    const m = f.verts.length;
    for (let ei = 0; ei < m; ei++) {
      const v1 = f.verts[ei];
      const v2 = f.verts[(ei + 1) % m];
      const twin = halfEdgeLookup.get(`${v2}:${v1}`);
      if (twin) {
        const p1 = vertices[twin.v1];
        const p2 = vertices[twin.v2];
        const edgeVec = new THREE.Vector3().subVectors(p2, p1);
        const lenMm = edgeVec.length() * 1000;
        const eHat = edgeVec.clone().normalize();
        const nA = faces[twin.faceIdx].normal;
        const nB = f.normal;

        // Outward tangent in faceA perpendicular to directed edge v1->v2: tA = eHat x nA
        const tA = new THREE.Vector3().crossVectors(eHat, nA);
        const sinTheta = THREE.MathUtils.clamp(nB.dot(tA), -1, 1);
        const cosTheta = THREE.MathUtils.clamp(nA.dot(nB), -1, 1);
        const angleDeg = Math.atan2(sinTheta, cosTheta) * THREE.MathUtils.RAD2DEG;

        const shared: SharedMeshEdge = {
          id: sharedEdges.length,
          v1: twin.v1,
          v2: twin.v2,
          faceA: twin.faceIdx,
          edgeIdxInA: twin.edgeIdx,
          faceB: fi,
          edgeIdxInB: ei,
          lengthMm: lenMm,
          angleDeg,
          kind: angleDeg >= 0 ? 'mountain' : 'valley',
        };
        sharedEdges.push(shared);
        faceEdgeToShared.set(`${twin.faceIdx}:${twin.edgeIdx}`, shared);
        faceEdgeToShared.set(`${fi}:${ei}`, shared);
      } else {
        halfEdgeLookup.set(`${v1}:${v2}`, { faceIdx: fi, edgeIdx: ei, v1, v2 });
      }
    }
  }

  // Adjacency list per face
  const adjByFace: SharedMeshEdge[][] = Array.from({ length: faces.length }, () => []);
  for (const se of sharedEdges) {
    adjByFace[se.faceA].push(se);
    adjByFace[se.faceB].push(se);
  }
  for (const list of adjByFace) {
    // Prefer longer hinge edges to minimize cut seam perimeter
    list.sort((a, b) => b.lengthMm - a.lengthMm || a.id - b.id);
  }

  // 2. Unfold connected faces via BFS spanning tree with 2D overlap prevention
  const faceVisited = new Uint8Array(faces.length);
  const usedTreeEdgeIds = new Set<number>();

  interface RawIsland {
    placedFaces: Map<number, PlacedFaceState>;
    treeEdges: {
      shared: SharedMeshEdge;
      parentFace: number;
      childFace: number;
      p1: Point2D;
      p2: Point2D;
      childP1: Point2D;
      childP2: Point2D;
      bendAllowanceMm: number;
      /** The edge's ends in each face's polygon, to take the trimmed corners from. */
      parentEnds: [number, number];
      childEnds: [number, number];
    }[];
  }

  const rawIslands: RawIsland[] = [];
  let totalBendAllowanceMm = 0;
  let setbackClampedCount = 0;

  // Precompute simultaneous feasible setbacks per face across all of its bent shared edges
  // so multi-bend polygons (e.g. 24- and 36-sided cylinder caps) never clamp prematurely
  // from evaluating a single edge against zeroed neighbors.
  const faceSimultSetbacks = faces.map((f, fi) => {
    const desired = f.verts.map((_, ei) => {
      const se = faceEdgeToShared.get(`${fi}:${ei}`);
      if (!se || options.mode !== 'sheet_metal' || Math.abs(se.angleDeg) < options.coplanarToleranceDeg) {
        return 0;
      }
      return bendSetbackMm(se.angleDeg, options.bendRadiusMm, options.thicknessMm);
    });
    return solveSimultaneousSetbacks2D(f.local2D, desired);
  });

  while (true) {
    // Pick unvisited seed face with largest area
    let seedFace = -1;
    let bestArea = -1;
    for (let fi = 0; fi < faces.length; fi++) {
      if (!faceVisited[fi] && faces[fi].areaM2 > bestArea) {
        bestArea = faces[fi].areaM2;
        seedFace = fi;
      }
    }
    if (seedFace < 0) break;

    faceVisited[seedFace] = 1;
    const placedFaces = new Map<number, PlacedFaceState>();
    placedFaces.set(seedFace, {
      faceIndex: seedFace,
      polygon2D: faces[seedFace].local2D.map((p) => ({ ...p })),
      holes2D: (faces[seedFace].holesLocal2D ?? []).map((h) => h.map((p) => ({ ...p }))),
      transformPoint: (pt) => ({ ...pt }),
      setbacks: faces[seedFace].verts.map(() => 0),
    });

    const treeEdges: RawIsland['treeEdges'] = [];
    const queue: number[] = [seedFace];

    while (queue.length > 0) {
      const parentIdx = queue.shift()!;
      const parentState = placedFaces.get(parentIdx)!;
      const parentFace = faces[parentIdx];

      for (const se of adjByFace[parentIdx]) {
        const childIdx = se.faceA === parentIdx ? se.faceB : se.faceA;
        if (faceVisited[childIdx]) continue;

        const childFace = faces[childIdx];
        const parentEdgeIdx = se.faceA === parentIdx ? se.edgeIdxInA : se.edgeIdxInB;
        const childEdgeIdx = se.faceA === parentIdx ? se.edgeIdxInB : se.edgeIdxInA;

        // In parentFace (CCW), directed edge is pV1 -> pV2
        const pV1Idx = parentEdgeIdx;
        const pV2Idx = (parentEdgeIdx + 1) % parentFace.verts.length;
        // In childFace (CCW), the same 3D vertices are traversed in reverse: cV2 -> cV1
        const cV2Idx = childEdgeIdx;
        const cV1Idx = (childEdgeIdx + 1) % childFace.verts.length;

        const placedA_v1 = parentState.polygon2D[pV1Idx];
        const placedA_v2 = parentState.polygon2D[pV2Idx];
        const localB_v1 = childFace.local2D[cV1Idx];
        const localB_v2 = childFace.local2D[cV2Idx];

        const bent = options.mode === 'sheet_metal' && Math.abs(se.angleDeg) >= options.coplanarToleranceDeg;
        const baMm = bent
          ? computeBendAllowanceMm(se.angleDeg, options.bendRadiusMm, options.thicknessMm, options.kFactor)
          : 0;
        const rawSetbackMm = bent ? bendSetbackMm(se.angleDeg, options.bendRadiusMm, options.thicknessMm) : 0;

        const parentSimult = faceSimultSetbacks[parentIdx];
        const childSimult = faceSimultSetbacks[childIdx];
        const parentTarget = parentSimult.clamped[parentEdgeIdx]
          ? parentSimult.setbacks[parentEdgeIdx]
          : rawSetbackMm;
        const childTarget = childSimult.clamped[childEdgeIdx]
          ? childSimult.setbacks[childEdgeIdx]
          : rawSetbackMm;

        // Verify partial trim validity on committed edges; if all bends simultaneously succeed
        // (`!clamped`), keep full `rawSetbackMm` even if neighbors are not yet visited.
        const parentPartial = clampEdgeSetbackForPolygon2D(
          parentState.polygon2D,
          parentState.setbacks,
          parentEdgeIdx,
          parentTarget
        );
        const effParentSetback = !parentSimult.clamped[parentEdgeIdx]
          ? rawSetbackMm
          : parentPartial.setback;
        const parentWasClamped = effParentSetback < rawSetbackMm - 1e-3;

        const zeroChildSetbacks = childFace.verts.map(() => 0);
        const childPartial = clampEdgeSetbackForPolygon2D(
          childFace.local2D,
          zeroChildSetbacks,
          childEdgeIdx,
          childTarget
        );
        const effChildSetback = !childSimult.clamped[childEdgeIdx]
          ? rawSetbackMm
          : childPartial.setback;
        const childWasClamped = effChildSetback < rawSetbackMm - 1e-3;

        const { transform, targetV1, targetV2 } = buildUnfoldTransform2D(
          placedA_v1,
          placedA_v2,
          localB_v1,
          localB_v2,
          baMm - effParentSetback - effChildSetback
        );

        const candidatePoly2D = childFace.local2D.map(transform);
        const childSetbacks = childFace.verts.map((_, i) => (i === childEdgeIdx ? effChildSetback : 0));
        const parentSetbacks = parentState.setbacks.map((d, i) => (i === parentEdgeIdx ? effParentSetback : d));

        // Check if the candidate overlaps any already-placed face in this island,
        // each as its flat will be cut: the full faces overlap by the setbacks.
        const candidateTrimmed = trimPolygon2D(candidatePoly2D, childSetbacks);
        let overlaps = false;
        for (const existing of placedFaces.values()) {
          const trimmed = trimPolygon2D(existing.polygon2D, existing === parentState ? parentSetbacks : existing.setbacks);
          if (polygonsOverlap2D(candidateTrimmed, trimmed)) {
            overlaps = true;
            break;
          }
        }

        if (overlaps) {
          continue;
        }

        if (parentWasClamped || childWasClamped) {
          setbackClampedCount++;
        }

        // Commit child face to this island
        faceVisited[childIdx] = 1;
        usedTreeEdgeIds.add(se.id);
        totalBendAllowanceMm += baMm;

        parentState.setbacks = parentSetbacks;
        placedFaces.set(childIdx, {
          faceIndex: childIdx,
          polygon2D: candidatePoly2D,
          holes2D: (childFace.holesLocal2D ?? []).map((h) => h.map(transform)),
          transformPoint: transform,
          setbacks: childSetbacks,
        });

        treeEdges.push({
          shared: se,
          parentFace: parentIdx,
          childFace: childIdx,
          p1: placedA_v1,
          p2: placedA_v2,
          childP1: targetV1,
          childP2: targetV2,
          bendAllowanceMm: baMm,
          parentEnds: [pV1Idx, pV2Idx],
          childEnds: [cV1Idx, cV2Idx],
        });

        queue.push(childIdx);
      }
    }

    // The flats as cut: every bent edge in by its setback, and each bend's
    // zone between the two trimmed edges. If a subset of bends on a face ended
    // up invalid when combined with unvisited free edges, relax that face safely.
    for (const st of placedFaces.values()) {
      let tr = trimPolygonEdges2D(st.polygon2D, st.setbacks);
      if (st.setbacks.some((d) => d > 0) && !isTrimmedPolygonValid2D(st.polygon2D, tr)) {
        const relaxed = solveSimultaneousSetbacks2D(st.polygon2D, st.setbacks);
        st.setbacks = relaxed.setbacks;
        tr = trimPolygonEdges2D(st.polygon2D, st.setbacks);
        if (relaxed.clamped.some(Boolean)) setbackClampedCount++;
      }
      st.polygon2D = tr.polygon2D;
      st.edgeStarts = tr.edgeStarts;
      st.edgeEnds = tr.edgeEnds;
      st.vertexMap = tr.vertexMap;
    }
    for (const te of treeEdges) {
      const parent = placedFaces.get(te.parentFace)!;
      const child = placedFaces.get(te.childFace)!;
      const pEdge = te.parentEnds[0];
      const cEdge = te.childEnds[1];
      te.p1 = parent.edgeStarts![pEdge];
      te.p2 = parent.edgeEnds![pEdge];
      te.childP1 = child.edgeEnds![cEdge];
      te.childP2 = child.edgeStarts![cEdge];
    }

    // Detect and clip any interior face holes that enter a bend setback / forming zone
    for (const st of placedFaces.values()) {
      if (st.holes2D.length === 0) continue;
      const incidentBentEdges = treeEdges.filter(
        (te) =>
          (te.parentFace === st.faceIndex || te.childFace === st.faceIndex) &&
          Math.abs(te.shared.angleDeg) >= options.coplanarToleranceDeg
      );
      const holeClips = clipFaceHolesToPolygon2D(st.polygon2D, st.holes2D, 0.08);
      for (const hi of holeClips.encroachedIndices) {
        const rawHole = st.holes2D[hi];
        const hc = polygonCentroid2D(rawHole);
        let bestBend: (typeof incidentBentEdges)[number] | null = null;
        let bestDist = Infinity;
        for (const te of incidentBentEdges) {
          const d = Math.min(
            pointToSegmentDist2D(hc, te.p1, te.p2),
            pointToSegmentDist2D(hc, te.childP1, te.childP2)
          );
          if (d < bestDist) {
            bestDist = d;
            bestBend = te;
          }
        }
        if (bestBend) {
          const deg = Math.round(Math.abs(bestBend.shared.angleDeg) * 10) / 10;
          warnings.push(
            `Hole ${hi + 1} on face ${st.faceIndex} of "${surface.nodeName}" enters ${deg}° ${bestBend.shared.kind} bend setback zone; clipped cutout to flat face boundary.`
          );
        } else {
          warnings.push(
            `Hole ${hi + 1} on face ${st.faceIndex} of "${surface.nodeName}" crosses trimmed face boundary; clipped cutout to face interior.`
          );
        }
      }
      st.holes2D = holeClips.holes;
    }

    rawIslands.push({ placedFaces, treeEdges });
  }

  if (setbackClampedCount > 0) {
    warnings.push(
      `Bend setback (R=${options.bendRadiusMm}mm, T=${options.thicknessMm}mm) exceeds flange/web width on ${setbackClampedCount} bend(s) in "${surface.nodeName}"; clamped setback to prevent flat-pattern inversion.`
    );
  }

  // 3. Assign edge-pair IDs to all split shared edges (non-tree edges)
  let nextPairId = startPairId;
  const splitEdgePairId = new Map<number, number>();
  // Decide which side (faceA or faceB) of each split edge gets the glue tab (and its effective width)
  const glueTabOwnerFace = new Map<number, number>();
  const glueTabEffectiveWidth = new Map<number, number>();
  const omittedGlueTabPairs: number[] = [];

  // Map faceIndex -> its RawIsland
  const faceToIsland = new Map<number, RawIsland>();
  for (const isl of rawIslands) {
    for (const fi of isl.placedFaces.keys()) {
      faceToIsland.set(fi, isl);
    }
  }

  function buildGlueTabPolygon(p1: Point2D, p2: Point2D, tabWidthMm: number, tabAngleDeg: number): Point2D[] {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-3 || tabWidthMm <= 0) return [];
    const ux = dx / len;
    const uy = dy / len;
    // Outward normal to CCW edge p1 -> p2 is (uy, -ux)
    const nx = uy;
    const ny = -ux;

    const tanAlpha = Math.tan(Math.max(15, Math.min(80, tabAngleDeg)) * THREE.MathUtils.DEG2RAD);
    const maxW = 0.35 * len * tanAlpha;
    const effW = Math.min(tabWidthMm, maxW);
    const inset = effW / tanAlpha;

    return [
      { x: p1.x, y: p1.y },
      { x: p1.x + ux * inset + nx * effW, y: p1.y + uy * inset + ny * effW },
      { x: p2.x - ux * inset + nx * effW, y: p2.y - uy * inset + ny * effW },
      { x: p2.x, y: p2.y },
    ];
  }

  const placedTabPolysByIsland = new Map<RawIsland, Point2D[][]>();
  for (const isl of rawIslands) placedTabPolysByIsland.set(isl, []);

  for (const se of sharedEdges) {
    if (usedTreeEdgeIds.has(se.id)) continue;
    const pairId = nextPairId++;
    splitEdgePairId.set(se.id, pairId);

    if (options.mode === 'papercraft' && options.tabWidthMm > 0) {
      const islA = faceToIsland.get(se.faceA)!;
      const islB = faceToIsland.get(se.faceB)!;
      const stA = islA.placedFaces.get(se.faceA)!;
      const stB = islB.placedFaces.get(se.faceB)!;

      const a1 = stA.edgeStarts ? stA.edgeStarts[se.edgeIdxInA] : stA.polygon2D[se.edgeIdxInA];
      const a2 = stA.edgeEnds ? stA.edgeEnds[se.edgeIdxInA] : stA.polygon2D[(se.edgeIdxInA + 1) % stA.polygon2D.length];
      const b1 = stB.edgeStarts ? stB.edgeStarts[se.edgeIdxInB] : stB.polygon2D[se.edgeIdxInB];
      const b2 = stB.edgeEnds ? stB.edgeEnds[se.edgeIdxInB] : stB.polygon2D[(se.edgeIdxInB + 1) % stB.polygon2D.length];

      const clearanceScore = (tab: Point2D[], isl: RawIsland, ownFace: number): number => {
        if (tab.length < 4) return -Infinity;
        // Shrink tab base slightly off the shared hinge edge [tab[0], tab[3]] when testing
        // against ownFace so touching the hinge edge itself never false-triggers, while any
        // protrusion across a concave pocket/slot into ownFace is caught.
        const shrunkOwnTab: Point2D[] = [
          { x: tab[0].x + (tab[1].x - tab[0].x) * 0.08, y: tab[0].y + (tab[1].y - tab[0].y) * 0.08 },
          tab[1],
          tab[2],
          { x: tab[3].x + (tab[2].x - tab[3].x) * 0.08, y: tab[3].y + (tab[2].y - tab[3].y) * 0.08 },
        ];
        const tipMid = {
          x: (tab[1].x + tab[2].x) * 0.5,
          y: (tab[1].y + tab[2].y) * 0.5,
        };
        for (const [fi, st] of isl.placedFaces.entries()) {
          if (fi === ownFace) {
            if (polygonsOverlap2D(shrunkOwnTab, st.polygon2D, 0.03)) return -1e6;
            const m = st.polygon2D.length;
            for (let ei = 0; ei < m; ei++) {
              const pA = st.polygon2D[ei];
              const pB = st.polygon2D[(ei + 1) % m];
              if (
                Math.hypot(pA.x - tab[0].x, pA.y - tab[0].y) < 0.05 ||
                Math.hypot(pB.x - tab[0].x, pB.y - tab[0].y) < 0.05 ||
                Math.hypot(pA.x - tab[3].x, pA.y - tab[3].y) < 0.05 ||
                Math.hypot(pB.x - tab[3].x, pB.y - tab[3].y) < 0.05
              ) {
                continue;
              }
              if (segmentToSegmentDist2D(tab[1], tab[2], pA, pB) < 0.15) return -1e6;
            }
            continue;
          }
          if (polygonsOverlap2D(tab, st.polygon2D, 0.05)) return -1e6;
        }
        for (const existingTab of placedTabPolysByIsland.get(isl) || []) {
          if (polygonsOverlap2D(tab, existingTab, 0.05)) return -5e5;
        }
        let minDist = 1e6;
        for (const [fi, st] of isl.placedFaces.entries()) {
          if (fi === ownFace) continue;
          const c = polygonCentroid2D(st.polygon2D);
          const d = Math.hypot(tipMid.x - c.x, tipMid.y - c.y);
          if (d < minDist) minDist = d;
        }
        return minDist;
      };

      let chosenFace: number | null = null;
      let chosenTab: Point2D[] | null = null;
      let chosenIsl: RawIsland | null = null;

      for (const factor of [1, 0.75, 0.55, 0.4, 0.25]) {
        const w = options.tabWidthMm * factor;
        if (w < 1.0 && factor < 1) break;
        const tabA = buildGlueTabPolygon(a1, a2, w, options.tabAngleDeg);
        const tabB = buildGlueTabPolygon(b1, b2, w, options.tabAngleDeg);
        const scoreA = clearanceScore(tabA, islA, se.faceA);
        const scoreB = clearanceScore(tabB, islB, se.faceB);
        if (scoreA >= 0 || scoreB >= 0) {
          if (scoreA >= scoreB) {
            chosenFace = se.faceA;
            chosenTab = tabA;
            chosenIsl = islA;
          } else {
            chosenFace = se.faceB;
            chosenTab = tabB;
            chosenIsl = islB;
          }
          glueTabEffectiveWidth.set(se.id, w);
          break;
        }
      }

      if (chosenFace !== null && chosenTab && chosenIsl) {
        glueTabOwnerFace.set(se.id, chosenFace);
        placedTabPolysByIsland.get(chosenIsl)!.push(chosenTab);
      } else {
        omittedGlueTabPairs.push(pairId);
      }
    }
  }

  if (omittedGlueTabPairs.length > 0) {
    warnings.push(
      `Omitted ${omittedGlueTabPairs.length} colliding glue tab(s) on "${surface.nodeName}" (seam pair ${omittedGlueTabPairs.join(', ')}) where adjacent unfolded faces leave insufficient clearance.`
    );
  }

  // 4. Construct final UnfoldIsland objects with fold edges, cut seams, glue tabs,
  //    bend zones / relief notches, or seam allowance + stitch holes.
  const islands: UnfoldIsland[] = [];

  for (let ii = 0; ii < rawIslands.length; ii++) {
    const raw = rawIslands[ii];
    const islandId = `${surface.nodeId}_island_${startIslandIndex + ii + 1}`;

    const unfoldedFaces: UnfoldedFace2D[] = [];
    for (const st of raw.placedFaces.values()) {
      const holeAreaSum = st.holes2D.reduce((acc, h) => acc + polygonArea2D(h), 0);
      const rawVerts3D = faces[st.faceIndex].verts;
      const vMap = st.vertexMap ?? rawVerts3D.map((_, idx) => idx);
      unfoldedFaces.push({
        faceIndex: st.faceIndex,
        polygon2D: st.polygon2D,
        holes2D: st.holes2D.length > 0 ? st.holes2D.map((h) => h.map((p) => ({ ...p }))) : undefined,
        centroid2D: polygonCentroid2D(st.polygon2D),
        areaMm2: Math.max(0, polygonArea2D(st.polygon2D) - holeAreaSum),
        model3DMm: vMap.map((vi) => {
          const v = rawVerts3D[vi];
          return [vertices[v].x * 1000, vertices[v].y * 1000, vertices[v].z * 1000];
        }),
      });
    }

    // Build tree hinge lookup for topological boundary walk: `${faceIdx}:${edgeIdx}` -> twin
    const treeTwinMap = new Map<
      string,
      {
        twinFace: number;
        twinEdge: number;
        bridgeStart?: Point2D;
        bridgeEnd?: Point2D;
        foldEdge?: UnfoldFoldEdge;
      }
    >();

    const foldEdges: UnfoldFoldEdge[] = [];

    for (let ti = 0; ti < raw.treeEdges.length; ti++) {
      const te = raw.treeEdges[ti];
      const se = te.shared;
      const parentEdge = se.faceA === te.parentFace ? se.edgeIdxInA : se.edgeIdxInB;
      const childEdge = se.faceA === te.parentFace ? se.edgeIdxInB : se.edgeIdxInA;

      let foldObj: UnfoldFoldEdge | undefined;
      if (Math.abs(se.angleDeg) >= options.coplanarToleranceDeg) {
        const centerP1 = {
          x: (te.p1.x + te.childP1.x) * 0.5,
          y: (te.p1.y + te.childP1.y) * 0.5,
        };
        const centerP2 = {
          x: (te.p2.x + te.childP2.x) * 0.5,
          y: (te.p2.y + te.childP2.y) * 0.5,
        };

        const roundedDeg = Math.round(Math.abs(se.angleDeg) * 10) / 10;
        const rLabel = Number(options.bendRadiusMm.toFixed(2));
        const dirPrefix = se.angleDeg >= 0 ? 'UP' : 'DN';
        const callout =
          options.mode === 'sheet_metal' ? `${dirPrefix} ${roundedDeg}° R${rLabel}` : undefined;

        const bendZonePolygon2D =
          te.bendAllowanceMm > 1e-4
            ? [te.p1, te.p2, te.childP2, te.childP1]
            : undefined;

        foldObj = {
          id: `${islandId}_fold_${ti + 1}`,
          faceA: te.parentFace,
          faceB: te.childFace,
          p1: centerP1,
          p2: centerP2,
          kind: se.kind,
          angleDeg: se.angleDeg,
          bendAllowanceMm: te.bendAllowanceMm,
          bendZonePolygon2D,
          callout,
        };
        foldEdges.push(foldObj);
      }

      treeTwinMap.set(`${te.parentFace}:${parentEdge}`, {
        twinFace: te.childFace,
        twinEdge: childEdge,
        bridgeStart: te.p2,
        bridgeEnd: te.childP2,
        foldEdge: foldObj,
      });
      treeTwinMap.set(`${te.childFace}:${childEdge}`, {
        twinFace: te.parentFace,
        twinEdge: parentEdge,
        bridgeStart: te.childP1,
        bridgeEnd: te.p1,
        foldEdge: foldObj,
      });
    }

    // Collect exterior boundary half-edges and chain them in topological CCW order
    interface ExtHalfEdge {
      faceIndex: number;
      edgeIndex: number;
      p1: Point2D;
      p2: Point2D;
      outwardNormal: Point2D;
      sharedEdge?: SharedMeshEdge;
      crossedBentHinges: UnfoldFoldEdge[];
    }

    const extHalfEdges: ExtHalfEdge[] = [];
    const extKeyToIndex = new Map<string, number>();

    for (const [fi, st] of raw.placedFaces.entries()) {
      const m = faces[fi].verts.length;
      for (let ei = 0; ei < m; ei++) {
        if (treeTwinMap.has(`${fi}:${ei}`)) continue;
        const p1 = st.edgeStarts ? st.edgeStarts[ei] : st.polygon2D[ei];
        const p2 = st.edgeEnds ? st.edgeEnds[ei] : st.polygon2D[(ei + 1) % st.polygon2D.length];
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const len = Math.hypot(dx, dy) || 1;
        const outwardNormal = { x: dy / len, y: -dx / len };
        const se = faceEdgeToShared.get(`${fi}:${ei}`);
        extKeyToIndex.set(`${fi}:${ei}`, extHalfEdges.length);
        extHalfEdges.push({
          faceIndex: fi,
          edgeIndex: ei,
          p1,
          p2,
          outwardNormal,
          sharedEdge: se,
          crossedBentHinges: [],
        });
      }
    }

    // Walk exterior half-edges around the spanning tree to get ordered boundary cycle(s)
    const visitedExt = new Uint8Array(extHalfEdges.length);
    const orderedCycles: ExtHalfEdge[][] = [];

    for (let s = 0; s < extHalfEdges.length; s++) {
      if (visitedExt[s]) continue;
      const cycle: ExtHalfEdge[] = [];
      let currIdx = s;

      for (let guard = 0; guard <= extHalfEdges.length * 4; guard++) {
        if (visitedExt[currIdx]) break;
        visitedExt[currIdx] = 1;
        const curr = extHalfEdges[currIdx];
        cycle.push(curr);

        // Advance around planar tree, recording any bent hinges crossed at this corner
        let f = curr.faceIndex;
        let e = (curr.edgeIndex + 1) % faces[f].verts.length;
        const crossed: UnfoldFoldEdge[] = [];
        for (let hop = 0; hop <= raw.placedFaces.size * 2; hop++) {
          const twin = treeTwinMap.get(`${f}:${e}`);
          if (!twin) break;
          if (twin.foldEdge) crossed.push(twin.foldEdge);
          f = twin.twinFace;
          e = (twin.twinEdge + 1) % faces[f].verts.length;
        }
        curr.crossedBentHinges = crossed;
        const nextExt = extKeyToIndex.get(`${f}:${e}`);
        if (nextExt === undefined) break;
        currIdx = nextExt;
      }

      if (cycle.length > 0) {
        orderedCycles.push(cycle);
      }
    }

    const cutSeams: UnfoldCutSeam[] = [];
    const glueTabs: UnfoldGlueTab[] = [];
    const cutPolylines2D: Point2D[][] = [];
    const seamPolylines2D: Point2D[][] = [];
    const stitchHoles: Point2D[] = [];
    const reliefNotches: UnfoldReliefNotch[] = [];

    const cleanSeamLoopsForOffset: Point2D[][] = [];
    const pendingNotchSeamEntries: { seam: UnfoldCutSeam; bases: Point2D[] }[] = [];

    for (const cycle of orderedCycles) {
      const seamLoop: Point2D[] = [];
      const cutLoop: Point2D[] = [];
      const nCyc = cycle.length;

      // Precompute any corner trims needed when splicing sheet-metal bend relief notches
      const startOverrides: (Point2D | null)[] = new Array(nCyc).fill(null);
      const endOverrides: (Point2D | null)[] = new Array(nCyc).fill(null);
      const cornerSlotPoints: (Point2D[] | null)[] = new Array(nCyc).fill(null);

      if (
        options.mode === 'sheet_metal' &&
        options.bendReliefWidthMm > 0 &&
        options.bendReliefDepthMm > 0 &&
        nCyc >= 2
      ) {
        for (let ci = 0; ci < nCyc; ci++) {
          const curr = cycle[ci];
          if (curr.crossedBentHinges.length < 2) continue;
          const next = cycle[(ci + 1) % nCyc];

          const d1x = curr.p2.x - curr.p1.x;
          const d1y = curr.p2.y - curr.p1.y;
          const len1 = Math.hypot(d1x, d1y);
          const d2x = next.p2.x - next.p1.x;
          const d2y = next.p2.y - next.p1.y;
          const len2 = Math.hypot(d2x, d2y);
          if (len1 < 0.5 || len2 < 0.5) continue;

          const u1 = { x: d1x / len1, y: d1y / len1 };
          const u2 = { x: d2x / len2, y: d2y / len2 };
          // Inward normals (left of CCW exterior edges)
          let bisX = -u1.y + -u2.y;
          let bisY = u1.x + u2.x;
          let bisLen = Math.hypot(bisX, bisY);
          if (bisLen < 1e-4) {
            const bx = next.p1.x - curr.p2.x;
            const by = next.p1.y - curr.p2.y;
            const bl = Math.hypot(bx, by) || 1;
            bisX = -by / bl;
            bisY = bx / bl;
            bisLen = 1;
          }
          const inwardDir = { x: bisX / bisLen, y: bisY / bisLen };
          const tPerp = { x: inwardDir.y, y: -inwardDir.x };

          const mid = {
            x: (curr.p2.x + next.p1.x) * 0.5,
            y: (curr.p2.y + next.p1.y) * 0.5,
          };

          let cornerProj = 0;
          for (const fh of curr.crossedBentHinges) {
            for (const fp of [fh.p1, fh.p2]) {
              if (Math.hypot(fp.x - mid.x, fp.y - mid.y) < 25) {
                const proj = (fp.x - mid.x) * inwardDir.x + (fp.y - mid.y) * inwardDir.y;
                if (proj > cornerProj) cornerProj = proj;
              }
            }
          }

          const hw = Math.min(options.bendReliefWidthMm * 0.5, Math.min(len1, len2) * 0.25);
          const slotDepth = Math.min(
            Math.max(options.bendReliefDepthMm, cornerProj + options.bendReliefDepthMm * 0.5),
            Math.min(len1, len2) * 0.35
          );
          if (hw <= 0.1 || slotDepth <= 0.15) continue;

          const chordSpan = (next.p1.x - curr.p2.x) * tPerp.x + (next.p1.y - curr.p2.y) * tPerp.y;
          let s1: Point2D;
          let s4: Point2D;
          if (chordSpan >= 2 * hw - 1e-3) {
            const fHalf = chordSpan > 1e-6 ? hw / chordSpan : 0.5;
            const tA = 0.5 - fHalf;
            const tB = 0.5 + fHalf;
            s1 = {
              x: curr.p2.x + (next.p1.x - curr.p2.x) * tA,
              y: curr.p2.y + (next.p1.y - curr.p2.y) * tA,
            };
            s4 = {
              x: curr.p2.x + (next.p1.x - curr.p2.x) * tB,
              y: curr.p2.y + (next.p1.y - curr.p2.y) * tB,
            };
          } else {
            const need = hw - 0.5 * Math.max(0, chordSpan);
            const trim1 = Math.min(len1 * 0.35, need / Math.max(0.25, Math.abs(u1.x * tPerp.x + u1.y * tPerp.y)));
            const trim2 = Math.min(len2 * 0.35, need / Math.max(0.25, Math.abs(u2.x * tPerp.x + u2.y * tPerp.y)));
            s1 = { x: curr.p2.x - u1.x * trim1, y: curr.p2.y - u1.y * trim1 };
            s4 = { x: next.p1.x + u2.x * trim2, y: next.p1.y + u2.y * trim2 };
            endOverrides[ci] = s1;
            startOverrides[(ci + 1) % nCyc] = s4;
          }

          const s2 = { x: s1.x + inwardDir.x * slotDepth, y: s1.y + inwardDir.y * slotDepth };
          const s3 = { x: s4.x + inwardDir.x * slotDepth, y: s4.y + inwardDir.y * slotDepth };
          cornerSlotPoints[ci] = [s1, s2, s3, s4];
          reliefNotches.push({
            center2D: {
              x: (s1.x + s2.x + s3.x + s4.x) * 0.25,
              y: (s1.y + s2.y + s3.y + s4.y) * 0.25,
            },
            widthMm: options.bendReliefWidthMm,
            depthMm: options.bendReliefDepthMm,
            polygon2D: [s1, s2, s3, s4],
          });
        }
      }

      for (let ci = 0; ci < nCyc; ci++) {
        const ext = cycle[ci];
        seamLoop.push(ext.p1);
        if (Math.hypot(ext.p2.x - cycle[(ci + 1) % nCyc].p1.x, ext.p2.y - cycle[(ci + 1) % nCyc].p1.y) > 1e-3) {
          seamLoop.push(ext.p2);
        }

        const se = ext.sharedEdge;
        const pairId = se ? (splitEdgePairId.get(se.id) ?? 0) : 0;
        const matingFaceIndex = se
          ? se.faceA === ext.faceIndex
            ? se.faceB
            : se.faceA
          : null;
        const hasGlueTab =
          options.mode === 'papercraft' &&
          options.tabWidthMm > 0 &&
          se !== undefined &&
          glueTabOwnerFace.get(se.id) === ext.faceIndex;

        const seamObj: UnfoldCutSeam = {
          pairId,
          faceIndex: ext.faceIndex,
          matingFaceIndex,
          p1: ext.p1,
          p2: ext.p2,
          outwardNormal2D: ext.outwardNormal,
          hasGlueTab,
        };
        cutSeams.push(seamObj);

        // Soft goods: emit stitch holes & alignment notches ONLY on mated split seam edges (`se !== undefined`)
        if (options.mode === 'soft_goods' && se !== undefined) {
          const dx = ext.p2.x - ext.p1.x;
          const dy = ext.p2.y - ext.p1.y;
          const len = Math.hypot(dx, dy);

          if (len >= 6 && options.notchLengthMm > 0 && options.seamAllowanceMm > 0.5) {
            const notchFractions = len > 80 ? [1 / 3, 2 / 3] : [0.5];
            const bases = notchFractions.map((frac) => ({
              x: ext.p1.x + dx * frac,
              y: ext.p1.y + dy * frac,
            }));
            pendingNotchSeamEntries.push({ seam: seamObj, bases });
          }

          if (options.stitchPitchMm > 0 && len >= options.stitchPitchMm) {
            const pitch = options.stitchPitchMm;
            const intervals = Math.max(0, Math.floor((len - pitch * 0.5) / pitch));
            const span = intervals * pitch;
            const startDist = (len - span) * 0.5;
            const ux = dx / len;
            const uy = dy / len;
            for (let k = 0; k <= intervals; k++) {
              const d = startDist + k * pitch;
              const pt = { x: ext.p1.x + ux * d, y: ext.p1.y + uy * d };
              const tooClose = stitchHoles.some(
                (existing) => Math.hypot(existing.x - pt.x, existing.y - pt.y) < pitch * 0.45
              );
              if (!tooClose) {
                stitchHoles.push(pt);
              }
            }
          }
        }

        const effP1 = startOverrides[ci] ?? ext.p1;
        const effP2 = endOverrides[ci] ?? ext.p2;

        if (hasGlueTab && se !== undefined) {
          const effW = glueTabEffectiveWidth.get(se.id) ?? options.tabWidthMm;
          const tabPoly = buildGlueTabPolygon(effP1, effP2, effW, options.tabAngleDeg);
          if (tabPoly.length === 4) {
            glueTabs.push({
              pairId,
              faceIndex: ext.faceIndex,
              polygon2D: tabPoly,
              baseEdge: [effP1, effP2],
            });
            cutLoop.push(tabPoly[0], tabPoly[1], tabPoly[2], tabPoly[3]);
          } else {
            cutLoop.push(effP1, effP2);
          }
        } else if (options.mode !== 'soft_goods' || options.seamAllowanceMm <= 0) {
          cutLoop.push(effP1, effP2);
        }

        const slotPts = cornerSlotPoints[ci];
        if (slotPts) {
          cutLoop.push(...slotPts);
        }
      }

      const dedupSeam: Point2D[] = [];
      for (const pt of seamLoop) {
        const prev = dedupSeam[dedupSeam.length - 1];
        if (!prev || Math.hypot(pt.x - prev.x, pt.y - prev.y) > 1e-3) {
          dedupSeam.push(pt);
        }
      }
      if (
        dedupSeam.length > 2 &&
        Math.hypot(dedupSeam[0].x - dedupSeam[dedupSeam.length - 1].x, dedupSeam[0].y - dedupSeam[dedupSeam.length - 1].y) <= 1e-3
      ) {
        dedupSeam.pop();
      }
      if (dedupSeam.length >= 3) {
        seamPolylines2D.push([...dedupSeam, { ...dedupSeam[0] }]);
        cleanSeamLoopsForOffset.push(dedupSeam);
      }

      if (!(options.mode === 'soft_goods' && options.seamAllowanceMm > 0) && cutLoop.length >= 3) {
        const deduped: Point2D[] = [];
        for (const pt of cutLoop) {
          const prev = deduped[deduped.length - 1];
          if (!prev || Math.hypot(pt.x - prev.x, pt.y - prev.y) > 1e-3) {
            deduped.push(pt);
          }
        }
        if (deduped.length >= 3) {
          const first = deduped[0];
          const last = deduped[deduped.length - 1];
          if (Math.hypot(first.x - last.x, first.y - last.y) > 1e-3) {
            deduped.push({ ...first });
          }
          cutPolylines2D.push(deduped);
        }
      }
    }

    // Soft goods outward seam allowance via polygon boolean offset (eliminates concave bowties,
    // heals hairline slits between adjacent flaps, and falls back with warning only on degeneracy)
    if (options.mode === 'soft_goods' && options.seamAllowanceMm > 0 && cleanSeamLoopsForOffset.length > 0) {
      const healedSeamLoops = healHairlineSlits2D(cleanSeamLoopsForOffset);
      const loopsForOffset = healedSeamLoops.length > 0 ? healedSeamLoops : cleanSeamLoopsForOffset;
      const rawDepths = nestingDepths(loopsForOffset);
      const { paths: miterLoops, dropped } = offsetNestedLoops(
        loopsForOffset,
        options.seamAllowanceMm,
        { joinStyle: 'miter', miterLimit: 2.2, arcTolerance: 0.05 }
      );

      const expandedLoops: Point2D[][] = [...miterLoops];
      // Inner void loops (odd depth) smaller than 2 * seamAllowanceMm legitimately close up;
      // outer material loops (even depth) must never vanish silently.
      for (const droppedIdx of dropped) {
        if (rawDepths[droppedIdx] % 2 === 1) continue;
        const srcLoop = loopsForOffset[droppedIdx];
        if (!srcLoop || srcLoop.length < 3) continue;
        const roundFallback = offsetLoop(srcLoop, options.seamAllowanceMm, {
          joinStyle: 'round',
          arcTolerance: 0.05,
        });
        if (roundFallback.length > 0) {
          expandedLoops.push(...roundFallback);
        } else {
          warnings.push(
            `Seam allowance offset (${options.seamAllowanceMm}mm) failed on degenerate outline of "${surface.nodeName}"; fell back to un-offset seam boundary.`
          );
          expandedLoops.push(srcLoop);
        }
      }

      for (const expLoop of expandedLoops) {
        if (expLoop.length >= 3) {
          cutPolylines2D.push([...expLoop, { ...expLoop[0] }]);
        }
      }

      // Place alignment notches inward from the outer cut perimeter, stopping short of the stitch line
      for (const { seam, bases } of pendingNotchSeamEntries) {
        const notches: [Point2D, Point2D][] = [];
        const dir = seam.outwardNormal2D;
        for (const base of bases) {
          const tHit = rayHitExpandedLoops2D(base, dir, expandedLoops);
          if (tHit !== null && tHit > 0.6 && tHit <= options.seamAllowanceMm * 2.5) {
            const outerPt = { x: base.x + dir.x * tHit, y: base.y + dir.y * tHit };
            const effLen = Math.min(options.notchLengthMm, tHit * 0.65);
            const innerPt = { x: outerPt.x - dir.x * effLen, y: outerPt.y - dir.y * effLen };
            notches.push([outerPt, innerPt]);
          }
        }
        if (notches.length > 0) {
          seam.alignmentNotches = notches;
        }
      }
    }

    // Append interior planar face cutout loops (`holes2D`) to `cutPolylines2D`
    for (const f of unfoldedFaces) {
      for (const hole of f.holes2D ?? []) {
        if (hole.length >= 3) {
          cutPolylines2D.push([...hole, { ...hole[0] }]);
        }
      }
    }

    // Compute island bounding box and map right-handed `(x_right, y_up)` into SVG `(x_right, y_down)`
    // so that folding on the laser bed with etched lines facing UP reproduces the true 3D chirality!
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const includePt = (p: Point2D) => {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    };

    for (const f of unfoldedFaces) for (const p of f.polygon2D) includePt(p);
    for (const loop of cutPolylines2D) for (const p of loop) includePt(p);
    for (const gt of glueTabs) for (const p of gt.polygon2D) includePt(p);
    for (const rn of reliefNotches) for (const p of rn.polygon2D) includePt(p);

    if (!Number.isFinite(minX)) {
      minX = 0; maxX = 0; minY = 0; maxY = 0;
    }

    const toSvgPt = (p: Point2D): Point2D => ({ x: p.x - minX, y: maxY - p.y });
    const toSvgVec = (v: Point2D): Point2D => ({ x: v.x, y: -v.y });

    for (const f of unfoldedFaces) {
      f.polygon2D = f.polygon2D.map(toSvgPt);
      if (f.holes2D) {
        f.holes2D = f.holes2D.map((h) => h.map(toSvgPt));
      }
      f.centroid2D = toSvgPt(f.centroid2D);
    }
    for (let k = 0; k < cutPolylines2D.length; k++) {
      cutPolylines2D[k] = cutPolylines2D[k].map(toSvgPt);
    }
    for (let k = 0; k < seamPolylines2D.length; k++) {
      seamPolylines2D[k] = seamPolylines2D[k].map(toSvgPt);
    }
    for (const fe of foldEdges) {
      fe.p1 = toSvgPt(fe.p1);
      fe.p2 = toSvgPt(fe.p2);
      if (fe.bendZonePolygon2D) {
        fe.bendZonePolygon2D = fe.bendZonePolygon2D.map(toSvgPt);
      }
    }
    for (const cs of cutSeams) {
      cs.p1 = toSvgPt(cs.p1);
      cs.p2 = toSvgPt(cs.p2);
      cs.outwardNormal2D = toSvgVec(cs.outwardNormal2D);
      if (cs.alignmentNotches) {
        cs.alignmentNotches = cs.alignmentNotches.map(([a, b]) => [toSvgPt(a), toSvgPt(b)]);
      }
    }
    for (const gt of glueTabs) {
      gt.polygon2D = gt.polygon2D.map(toSvgPt);
      gt.baseEdge = [toSvgPt(gt.baseEdge[0]), toSvgPt(gt.baseEdge[1])];
    }
    for (const rn of reliefNotches) {
      rn.center2D = toSvgPt(rn.center2D);
      rn.polygon2D = rn.polygon2D.map(toSvgPt);
    }
    for (let k = 0; k < stitchHoles.length; k++) {
      stitchHoles[k] = toSvgPt(stitchHoles[k]);
    }

    islands.push({
      id: islandId,
      nodeId: surface.nodeId,
      nodeName: surface.nodeName,
      sheetIndex: 0,
      placedOffsetMm: { x: 0, y: 0 },
      faceCount: unfoldedFaces.length,
      faces: unfoldedFaces,
      cutPolylines2D,
      seamPolylines2D,
      foldEdges,
      cutSeams,
      glueTabs,
      reliefNotches,
      stitchHoles,
      stitchHoleCount: stitchHoles.length,
      boundsMm: {
        width: Math.max(0, maxX - minX),
        height: Math.max(0, maxY - minY),
      },
    });
  }

  return { islands, nextPairId, totalBendAllowanceMm };
}

// ---------------------------------------------------------------------------
// Multi-Sheet 2D Shelf Packing & SVG Generation
// ---------------------------------------------------------------------------

function translateIslandInPlace(island: UnfoldIsland, dx: number, dy: number): void {
  const shift = (p: Point2D): Point2D => ({ x: p.x + dx, y: p.y + dy });
  island.placedOffsetMm = { x: dx, y: dy };
  for (const f of island.faces) {
    f.polygon2D = f.polygon2D.map(shift);
    if (f.holes2D) {
      f.holes2D = f.holes2D.map((h) => h.map(shift));
    }
    f.centroid2D = shift(f.centroid2D);
  }
  island.cutPolylines2D = island.cutPolylines2D.map((l) => l.map(shift));
  island.seamPolylines2D = island.seamPolylines2D.map((l) => l.map(shift));
  for (const fe of island.foldEdges) {
    fe.p1 = shift(fe.p1);
    fe.p2 = shift(fe.p2);
    if (fe.bendZonePolygon2D) {
      fe.bendZonePolygon2D = fe.bendZonePolygon2D.map(shift);
    }
  }
  for (const cs of island.cutSeams) {
    cs.p1 = shift(cs.p1);
    cs.p2 = shift(cs.p2);
    if (cs.alignmentNotches) {
      cs.alignmentNotches = cs.alignmentNotches.map(([a, b]) => [shift(a), shift(b)]);
    }
  }
  for (const gt of island.glueTabs) {
    gt.polygon2D = gt.polygon2D.map(shift);
    gt.baseEdge = [shift(gt.baseEdge[0]), shift(gt.baseEdge[1])];
  }
  for (const rn of island.reliefNotches) {
    rn.center2D = shift(rn.center2D);
    rn.polygon2D = rn.polygon2D.map(shift);
  }
  island.stitchHoles = island.stitchHoles.map(shift);
}

function rotateIsland90InPlace(island: UnfoldIsland): void {
  const h = island.boundsMm.height;
  const rotPt = (p: Point2D): Point2D => ({ x: h - p.y, y: p.x });
  const rotVec = (v: Point2D): Point2D => ({ x: -v.y, y: v.x });

  for (const f of island.faces) {
    f.polygon2D = f.polygon2D.map(rotPt);
    if (f.holes2D) {
      f.holes2D = f.holes2D.map((hole) => hole.map(rotPt));
    }
    f.centroid2D = rotPt(f.centroid2D);
  }
  island.cutPolylines2D = island.cutPolylines2D.map((l) => l.map(rotPt));
  island.seamPolylines2D = island.seamPolylines2D.map((l) => l.map(rotPt));
  for (const fe of island.foldEdges) {
    fe.p1 = rotPt(fe.p1);
    fe.p2 = rotPt(fe.p2);
    if (fe.bendZonePolygon2D) {
      fe.bendZonePolygon2D = fe.bendZonePolygon2D.map(rotPt);
    }
  }
  for (const cs of island.cutSeams) {
    cs.p1 = rotPt(cs.p1);
    cs.p2 = rotPt(cs.p2);
    cs.outwardNormal2D = rotVec(cs.outwardNormal2D);
    if (cs.alignmentNotches) {
      cs.alignmentNotches = cs.alignmentNotches.map(([a, b]) => [rotPt(a), rotPt(b)]);
    }
  }
  for (const gt of island.glueTabs) {
    gt.polygon2D = gt.polygon2D.map(rotPt);
    gt.baseEdge = [rotPt(gt.baseEdge[0]), rotPt(gt.baseEdge[1])];
  }
  for (const rn of island.reliefNotches) {
    rn.center2D = rotPt(rn.center2D);
    rn.polygon2D = rn.polygon2D.map(rotPt);
  }
  island.stitchHoles = island.stitchHoles.map(rotPt);
  island.boundsMm = { width: island.boundsMm.height, height: island.boundsMm.width };
}

function packIslandsOntoSheets(
  islands: UnfoldIsland[],
  options: SheetUnfoldOptions,
  warnings: string[]
): UnfoldSheet[] {
  if (islands.length === 0) return [];

  const sheetW = Math.max(50, options.sheetWidthMm);
  const sheetH = Math.max(50, options.sheetHeightMm);
  const margin = Math.max(0, options.marginMm);
  const spacing = Math.max(0, options.partSpacingMm);
  const usableW = Math.max(10, sheetW - 2 * margin);
  const usableH = Math.max(10, sheetH - 2 * margin);

  // Rotate any island that only fits the sheet when turned 90 deg
  for (const isl of islands) {
    const fitsUpright = isl.boundsMm.width <= usableW && isl.boundsMm.height <= usableH;
    const fitsRotated = isl.boundsMm.height <= usableW && isl.boundsMm.width <= usableH;
    if (!fitsUpright && fitsRotated) {
      rotateIsland90InPlace(isl);
    }
  }

  // Sort by height descending for shelf packing
  const sorted = [...islands].sort(
    (a, b) => b.boundsMm.height - a.boundsMm.height || b.boundsMm.width - a.boundsMm.width
  );

  const sheets: UnfoldSheet[] = [];
  let currentSheetIdx = 0;
  let cursorX = margin;
  let cursorY = margin;
  let shelfHeight = 0;

  sheets.push({
    index: 0,
    widthMm: sheetW,
    heightMm: sheetH,
    islandIds: [],
  });

  for (const isl of sorted) {
    const w = isl.boundsMm.width;
    const h = isl.boundsMm.height;

    if (w > usableW || h > usableH) {
      warnings.push(
        `Unfolded pattern "${isl.nodeName}" (${w.toFixed(1)} × ${h.toFixed(1)} mm) exceeds usable sheet size (${usableW.toFixed(0)} × ${usableH.toFixed(0)} mm).`
      );
    }

    if (cursorX > margin && cursorX + w > sheetW - margin) {
      // Advance to next shelf on current sheet
      cursorX = margin;
      cursorY += shelfHeight + spacing;
      shelfHeight = 0;
    }

    if (sheets[currentSheetIdx].islandIds.length > 0 && cursorY + h > sheetH - margin) {
      // Open a new sheet
      currentSheetIdx++;
      sheets.push({
        index: currentSheetIdx,
        widthMm: sheetW,
        heightMm: sheetH,
        islandIds: [],
      });
      cursorX = margin;
      cursorY = margin;
      shelfHeight = 0;
    }

    isl.sheetIndex = currentSheetIdx;
    translateIslandInPlace(isl, cursorX, cursorY);
    sheets[currentSheetIdx].islandIds.push(isl.id);

    cursorX += w + spacing;
    if (h > shelfHeight) shelfHeight = h;
  }

  return sheets;
}

function renderSheetUnfoldSvg(
  islands: UnfoldIsland[],
  sheets: UnfoldSheet[],
  options: SheetUnfoldOptions
): string {
  const sheetW = Math.max(50, options.sheetWidthMm);
  const sheetH = Math.max(50, options.sheetHeightMm);
  const numSheets = Math.max(1, sheets.length);
  const totalHeight = numSheets * sheetH;

  const fmt = (n: number) => Number(n.toFixed(3));
  const sheetYOffset = (sheetIdx: number) => sheetIdx * sheetH;

  const sheetOutlineParts: string[] = [];
  const cutParts: string[] = [];
  const mountainParts: string[] = [];
  const valleyParts: string[] = [];
  const seamTabParts: string[] = [];
  const stitchHoleParts: string[] = [];
  const labelParts: string[] = [];

  if (options.includeSheetOutline) {
    for (let s = 0; s < numSheets; s++) {
      const y0 = sheetYOffset(s);
      sheetOutlineParts.push(
        `    <rect x="0" y="${fmt(y0)}" width="${fmt(sheetW)}" height="${fmt(sheetH)}" data-operation="ghost" fill="none" stroke="#94a3b8" stroke-width="0.35" stroke-dasharray="6,4" />`
      );
      if (options.includeLabels) {
        sheetOutlineParts.push(
          `    <text x="10" y="${fmt(y0 + 20)}" data-operation="ghost" font-family="sans-serif" font-size="12" font-weight="bold" fill="#64748b">Sheet ${s + 1} (${fmt(sheetW)}mm x ${fmt(sheetH)}mm, ${options.mode})</text>`
        );
      }
    }
  }

  for (const isl of islands) {
    const yOff = sheetYOffset(isl.sheetIndex);
    const loopToPath = (pts: Point2D[]): string => {
      if (pts.length === 0) return '';
      const isClosed =
        pts.length >= 3 &&
        Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) <= 1e-3;
      const body = isClosed ? pts.slice(0, -1) : pts;
      const segs = body.map((p, i) => `${i === 0 ? 'M' : 'L'} ${fmt(p.x)} ${fmt(p.y + yOff)}`);
      if (isClosed) segs.push('Z');
      return segs.join(' ');
    };

    // 1. Outer & interior hole cut outlines (includes spliced corner bend reliefs)
    for (const loop of isl.cutPolylines2D) {
      if (loop.length < 2) continue;
      cutParts.push(`    <path d="${loopToPath(loop)}" />`);
    }

    // 2. Original seam lines & alignment notches (soft_goods) or glue tab fold bases (papercraft)
    if (options.mode === 'soft_goods') {
      if (options.seamAllowanceMm > 0) {
        for (const seamLoop of isl.seamPolylines2D) {
          seamTabParts.push(`    <path d="${loopToPath(seamLoop)}" stroke-dasharray="2.5,1.5" />`);
        }
      }
      for (const cs of isl.cutSeams) {
        for (const [n1, n2] of cs.alignmentNotches || []) {
          cutParts.push(
            `    <line x1="${fmt(n1.x)}" y1="${fmt(n1.y + yOff)}" x2="${fmt(n2.x)}" y2="${fmt(n2.y + yOff)}" />`
          );
        }
      }
    }

    for (const gt of isl.glueTabs) {
      const [b1, b2] = gt.baseEdge;
      seamTabParts.push(
        `    <line x1="${fmt(b1.x)}" y1="${fmt(b1.y + yOff)}" x2="${fmt(b2.x)}" y2="${fmt(b2.y + yOff)}" stroke-dasharray="3,1.5" />`
      );
    }

    // 3. Mountain & Valley fold lines (plus ghost bend zone tangent lines and callouts in sheet_metal mode)
    for (const fe of isl.foldEdges) {
      if (fe.bendZonePolygon2D && fe.bendZonePolygon2D.length === 4) {
        const bz = fe.bendZonePolygon2D;
        seamTabParts.push(
          `    <line x1="${fmt(bz[0].x)}" y1="${fmt(bz[0].y + yOff)}" x2="${fmt(bz[1].x)}" y2="${fmt(bz[1].y + yOff)}" stroke-dasharray="1.5,1.5" data-operation="ghost" />`,
          `    <line x1="${fmt(bz[3].x)}" y1="${fmt(bz[3].y + yOff)}" x2="${fmt(bz[2].x)}" y2="${fmt(bz[2].y + yOff)}" stroke-dasharray="1.5,1.5" data-operation="ghost" />`
        );
      }

      const lineSvg = `    <line x1="${fmt(fe.p1.x)}" y1="${fmt(fe.p1.y + yOff)}" x2="${fmt(fe.p2.x)}" y2="${fmt(fe.p2.y + yOff)}" />`;
      if (fe.kind === 'mountain') {
        mountainParts.push(lineSvg);
      } else {
        valleyParts.push(lineSvg);
      }

      if (options.includeLabels && fe.callout) {
        const mx = (fe.p1.x + fe.p2.x) * 0.5;
        const my = (fe.p1.y + fe.p2.y) * 0.5 + yOff;
        labelParts.push(
          `    <text x="${fmt(mx)}" y="${fmt(my - 1.2)}" text-anchor="middle" font-family="monospace" font-size="2.6" fill="#475569">${escapeXml(fe.callout)}</text>`
        );
      }
    }

    // 4. Stitch holes (soft_goods)
    for (const sh of isl.stitchHoles) {
      stitchHoleParts.push(
        `    <circle cx="${fmt(sh.x)}" cy="${fmt(sh.y + yOff)}" r="0.55" />`
      );
    }

    // 5. Edge-pair ID numbers & island labels
    if (options.includeLabels) {
      for (const cs of isl.cutSeams) {
        if (cs.pairId <= 0) continue;
        const mx = (cs.p1.x + cs.p2.x) * 0.5;
        const my = (cs.p1.y + cs.p2.y) * 0.5;
        // Place edge-pair number slightly inside the face edge
        const lx = mx - cs.outwardNormal2D.x * 2.4;
        const ly = my - cs.outwardNormal2D.y * 2.4 + yOff;
        labelParts.push(
          `    <text x="${fmt(lx)}" y="${fmt(ly)}" text-anchor="middle" dominant-baseline="central" font-family="monospace" font-size="2.5" fill="#475569">${cs.pairId}</text>`
        );
      }

      if (isl.faces.length > 0) {
        const c = isl.faces[0].centroid2D;
        labelParts.push(
          `    <text x="${fmt(c.x)}" y="${fmt(c.y + yOff)}" text-anchor="middle" dominant-baseline="central" font-family="monospace" font-size="3.0" fill="#475569">${escapeXml(isl.nodeName)}</text>`
        );
      }
    }
  }

  return [
    `<svg width="${fmt(sheetW)}mm" height="${fmt(totalHeight)}mm" viewBox="0 0 ${fmt(sheetW)} ${fmt(totalHeight)}" xmlns="http://www.w3.org/2000/svg">`,
    `  <!-- Generated by PhysBox Sheet Unfold Engine -->`,
    `  <!-- Settings: Mode=${options.mode}, Thickness=${options.thicknessMm.toFixed(1)}mm, Scale=${(options.scaleFactor * 100).toFixed(0)}% -->`,
    sheetOutlineParts.length > 0 ? `  <g id="layer-sheet-bounds" data-operation="ghost">\n${sheetOutlineParts.join('\n')}\n  </g>` : '',
    seamTabParts.length > 0
      ? `  <g id="layer-seams-tabs" data-operation="etch" fill="none" stroke="#9333ea" stroke-width="0.25">\n${seamTabParts.join('\n')}\n  </g>`
      : '',
    mountainParts.length > 0
      ? `  <g id="layer-mountain-folds" data-operation="etch" fill="none" stroke="#2563eb" stroke-width="0.3" stroke-dasharray="4,2">\n${mountainParts.join('\n')}\n  </g>`
      : '',
    valleyParts.length > 0
      ? `  <g id="layer-valley-folds" data-operation="etch" fill="none" stroke="#16a34a" stroke-width="0.3" stroke-dasharray="5,2,1.2,2">\n${valleyParts.join('\n')}\n  </g>`
      : '',
    stitchHoleParts.length > 0
      ? `  <g id="layer-stitch-holes" data-operation="cut" fill="none" stroke="#d97706" stroke-width="0.25">\n${stitchHoleParts.join('\n')}\n  </g>`
      : '',
    cutParts.length > 0
      ? `  <g id="layer-cut" data-operation="cut" fill="none" stroke="#e11d48" stroke-width="0.35">\n${cutParts.join('\n')}\n  </g>`
      : '',
    labelParts.length > 0 ? `  <g id="layer-labels" data-operation="etch">\n${labelParts.join('\n')}\n  </g>` : '',
    `</svg>`,
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Public API: exportSheetUnfold & buildSheetUnfoldEtchUrl
// ---------------------------------------------------------------------------

export function exportSheetUnfold(
  scene: SceneGraph,
  options?: Partial<SheetUnfoldOptions> & { material?: MaterialId; machine?: 'laser' | 'cnc' },
  targetNodeIds?: string[]
): SheetUnfoldResult {
  const opts: SheetUnfoldOptions = {
    ...DEFAULT_SHEET_UNFOLD_OPTIONS,
    ...options,
  };

  const { surfaces, warnings } = extractSurfacesFromScene(scene, opts, targetNodeIds);

  if (surfaces.length === 0) {
    const emptySvg = renderSheetUnfoldSvg([], [], opts);
    return {
      success: false,
      mode: opts.mode,
      svg: emptySvg,
      sheets: [],
      islands: [],
      totalFaces: 0,
      foldCount: 0,
      seamCount: 0,
      glueTabCount: 0,
      stitchHoleCount: 0,
      totalBendAllowanceMm: 0,
      warnings,
      error: 'No unfoldable 3D faces found in the scene.',
    };
  }

  const allIslands: UnfoldIsland[] = [];
  let nextPairId = 1;
  let totalBendAllowanceMm = 0;

  for (const surface of surfaces) {
    const res = unfoldSurfaceToIslands(surface, opts, nextPairId, allIslands.length, warnings);
    allIslands.push(...res.islands);
    nextPairId = res.nextPairId;
    totalBendAllowanceMm += res.totalBendAllowanceMm;
  }

  const sheets = packIslandsOntoSheets(allIslands, opts, warnings);
  const svg = renderSheetUnfoldSvg(allIslands, sheets, opts);

  let totalFaces = 0;
  let foldCount = 0;
  let glueTabCount = 0;
  let stitchHoleCount = 0;
  const distinctSeamPairs = new Set<number>();
  let unmatedSeamEdges = 0;

  for (const isl of allIslands) {
    totalFaces += isl.faceCount;
    foldCount += isl.foldEdges.length;
    glueTabCount += isl.glueTabs.length;
    stitchHoleCount += isl.stitchHoleCount;
    for (const cs of isl.cutSeams) {
      if (cs.pairId > 0) distinctSeamPairs.add(cs.pairId);
      else unmatedSeamEdges++;
    }
  }

  const seamCount = distinctSeamPairs.size + unmatedSeamEdges;

  const base =
    typeof window !== 'undefined' && window.location
      ? etchBaseUrl(window.location)
      : etchBaseUrl({ hostname: 'localhost', protocol: 'http:' });
  const syncParams = new URLSearchParams({
    v: '1',
    gz: '0',
    data: toBase64Url(new TextEncoder().encode(svg)),
    name: `unfold_${opts.mode}`,
  });
  if (opts.thicknessMm > 0) {
    syncParams.set('thickness', String(opts.thicknessMm));
  }
  if (options?.material) {
    syncParams.set('material', options.material);
  }
  if (options?.machine) {
    syncParams.set('machine', options.machine);
  }
  if (sheets.length > 1) {
    syncParams.set(
      'sheets',
      sheets
        .map((s) =>
          opts.thicknessMm > 0
            ? `${s.widthMm}x${s.heightMm}x${opts.thicknessMm}`
            : `${s.widthMm}x${s.heightMm}`
        )
        .join(',')
    );
  }
  const fragment = syncParams.toString();
  const etchUrl = fragment.length <= HANDOFF_SOFT_LIMIT ? `${base}#${fragment}` : undefined;
  if (!etchUrl) {
    warnings.push(
      `Unfolded SVG encodes to ${Math.round(fragment.length / 1024)} KB uncompressed; use buildSheetUnfoldEtchUrl (gzip) or save the .svg file.`
    );
  }

  return {
    success: true,
    mode: opts.mode,
    svg,
    sheets,
    islands: allIslands,
    totalFaces,
    foldCount,
    seamCount,
    glueTabCount,
    stitchHoleCount,
    totalBendAllowanceMm,
    warnings,
    etchUrl,
  };
}

/**
 * Builds the Etch handoff URL carrying the unfolded flat-pattern SVG and material thickness.
 */
export async function buildSheetUnfoldEtchUrl(
  result: SheetUnfoldResult,
  options?: Partial<SheetUnfoldOptions> & { material?: MaterialId; machine?: 'laser' | 'cnc' },
  baseUrl: string = typeof window !== 'undefined' && window.location
    ? etchBaseUrl(window.location)
    : etchBaseUrl({ hostname: 'localhost', protocol: 'http:' })
): Promise<string> {
  const opts = { ...DEFAULT_SHEET_UNFOLD_OPTIONS, ...options };
  return buildEtchHandoffUrl(
    {
      svg: result.svg,
      name: `unfold_${result.mode}`,
      thicknessMm: opts.thicknessMm,
      material: options?.material,
      machine: options?.machine,
      sheets: result.sheets.map((s) => ({
        widthMm: s.widthMm,
        heightMm: s.heightMm,
        thicknessMm: opts.thicknessMm,
      })),
    },
    baseUrl
  );
}
