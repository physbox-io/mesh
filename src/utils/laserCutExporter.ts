// ---------------------------------------------------------------------------
// Laser Cut Face Unwrapping & SVG Export Engine
// ---------------------------------------------------------------------------

import type { SceneGraph, SceneNode, SceneGeom } from '../types/scene';
import { csgSourceGeoms, fromtoFrame } from './csg';
import * as THREE from 'three';

export interface LaserCutOptions {
  jointMode: 'finger' | 'slot' | 'glue';
  materialThickness: number; // in meters (default 0.003 = 3mm)
  fingerWidth: number;       // in meters (default 0.010 = 10mm)
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
  scaleFactor?: number;      // scale factor (default 1.0 = 100%)
  autoScale?: boolean;        // automatically scale down cuts to fit sheet/sheet limit
  maxSheets?: number;        // maximum allowed sheets (0 = unlimited)
  /** Engrave each panel's name, and caption each sheet. */
  includeLabels: boolean;
  /** Draw the dashed sheet boundaries. Off leaves nothing but cut paths. */
  includeSheetOutline: boolean;
}

export const DEFAULT_LASER_OPTIONS: LaserCutOptions = {
  jointMode: 'finger',
  materialThickness: 0.003,
  fingerWidth: 0.010,
  tabOverhang: 0,
  jointClearance: 0,
  kerf: 0.00015,
  cornerRelief: 'none',
  bitDiameter: 0.003175, // 1/8"
  sheetWidth: 0.600,
  sheetHeight: 0.400,
  margin: 0.008,
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
  width2D?: number;
  height2D?: number;
}

export interface LaserCutResult {
  success: boolean;
  svg?: string;
  panels?: LaserPanel[];
  sheetCount?: number;
  scaleFactor?: number;
  error?: string;
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
 */
function simplifyPolygon2D(pts: Point2D[], tolDegrees: number = 2.0): Point2D[] {
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
    const prev = cleaned[(i - 1 + cleaned.length) % cleaned.length];
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

/**
 * Sample points on the hull of a subtractive geom, in the geom's own frame.
 *
 * `pad` is an isotropic radius to be added around every sample — it carries the
 * part of a shape whose silhouette is direction-independent (a sphere, or a
 * capsule's end caps), which no finite set of surface samples can capture.
 * Together the two describe the solid as `hull(samples) ⊕ ball(pad)`, whose
 * projection onto any plane is exactly `hull(projected samples) ⊕ disc(pad)`.
 */
function cutoutHullSamples(geom: SceneGeom): { local: THREE.Vector3[]; pad: number } | null {
  const s = geom.size || [];
  const r = s[0] || 0.018;

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
      return null; // ellipsoids and meshes are not projected
  }
}

/**
 * Projects a body's subtractive geoms onto a panel's own (u, v) frame. Works for
 * any panel orientation — the panel may be thin in X, Y or Z, or be an
 * arbitrarily oriented plane recovered from a mesh — and for any cutter
 * orientation, including geoms rotated by quat/euler or placed by fromto.
 *
 * `planeTol` is how far off the panel's plane a cutter may sit and still count
 * as passing through it. Panel planes are mid-planes or outer skins depending
 * on how the panel was found, so this wants to be about the stock thickness.
 * Without it, a pocket in one face of a shelled solid would also be cut out of
 * the opposite face, whose 2D bounds contain the same projected point.
 */
function projectCutouts2D(
  diffGeoms: SceneGeom[],
  bodyMatrix: THREE.Matrix4,
  worldOrigin: THREE.Vector3,
  worldU: THREE.Vector3,
  worldV: THREE.Vector3,
  contains: (pt: Point2D) => boolean,
  planeTol: number
): Point2D[][] {
  const worldN = new THREE.Vector3().crossVectors(worldU, worldV).normalize();
  const cutouts: Point2D[][] = [];

  for (const diffGeom of diffGeoms) {
    const samples = cutoutHullSamples(diffGeom);
    if (!samples) continue;

    const m = getGeomTransform(diffGeom, bodyMatrix);
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

    // Ignore cutters that never reach this panel's plane.
    if (nHi + samples.pad < -planeTol || nLo - samples.pad > planeTol) continue;

    const loop = convexHull2D(projected);
    if (loop.length < 3) continue;

    // Ignore cutouts that miss this panel's outline. Testing the silhouette and
    // not just its centre keeps a hole that straddles a panel edge.
    let cx = 0;
    let cy = 0;
    for (const p of loop) { cx += p.x; cy += p.y; }
    const centre = { x: cx / loop.length, y: cy / loop.length };
    if (!contains(centre) && !loop.some(contains)) continue;

    cutouts.push(loop);
  }

  return cutouts;
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

export function extractPanelsFromScene(
  scene: SceneGraph,
  options: LaserCutOptions
): { panels: LaserPanel[]; invalidGeoms: string[] } {
  const panels: LaserPanel[] = [];
  const invalidGeoms: string[] = [];

  let panelIdCounter = 1;

  function traverseNode(node: SceneNode, parentMatrix?: THREE.Matrix4) {
    const bodyMatrix = getNodeWorldTransform(node, parentMatrix);

    const rawGeoms = node.geoms || [];
    const diffGeoms = rawGeoms.filter(g => g.csg === 'difference');
    // Subtractive geoms are cutters, not stock: a `difference` box became six
    // panels of its own, and a `difference` capsule failed the whole export as
    // an unsupported curved solid. They are projected as cutouts instead.
    const positiveGeoms = csgSourceGeoms(node)
      .filter(g => g.role !== 'collision' && g.csg !== 'difference');

    for (const geom of positiveGeoms) {
      const geomMatrix = getGeomTransform(geom, bodyMatrix);

      if (geom.type === 'sphere' || geom.type === 'ellipsoid' || geom.type === 'capsule') {
        invalidGeoms.push(`${node.name} (${geom.name || geom.type})`);
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
          const outerPolygon2D: Point2D[] = [
            { x: -hw * 1000, y: -hh * 1000 },
            { x:  hw * 1000, y: -hh * 1000 },
            { x:  hw * 1000, y:  hh * 1000 },
            { x: -hw * 1000, y:  hh * 1000 },
          ];

          const innerCutouts2D = projectCutouts2D(
            diffGeoms, bodyMatrix, worldOrigin, worldU, worldV,
            (pt) => Math.abs(pt.x) <= hw * 1000 && Math.abs(pt.y) <= hh * 1000,
            Math.max(th, options.materialThickness)
          );

          const p1_3d = worldOrigin.clone().addScaledVector(worldU, -hw).addScaledVector(worldV, -hh);
          const p2_3d = worldOrigin.clone().addScaledVector(worldU,  hw).addScaledVector(worldV, -hh);
          const p3_3d = worldOrigin.clone().addScaledVector(worldU,  hw).addScaledVector(worldV,  hh);
          const p4_3d = worldOrigin.clone().addScaledVector(worldU, -hw).addScaledVector(worldV,  hh);

          const edges3D: LaserPanelEdge[] = [
            { p1: p1_3d, p2: p2_3d },
            { p1: p2_3d, p2: p3_3d },
            { p1: p3_3d, p2: p4_3d },
            { p1: p4_3d, p2: p1_3d },
          ];

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

            const outerPolygon2D: Point2D[] = [
              { x: -hw * 1000, y: -hh * 1000 },
              { x:  hw * 1000, y: -hh * 1000 },
              { x:  hw * 1000, y:  hh * 1000 },
              { x: -hw * 1000, y:  hh * 1000 },
            ];

            const p1_3d = worldOrigin.clone().addScaledVector(worldU, -hw).addScaledVector(worldV, -hh);
            const p2_3d = worldOrigin.clone().addScaledVector(worldU,  hw).addScaledVector(worldV, -hh);
            const p3_3d = worldOrigin.clone().addScaledVector(worldU,  hw).addScaledVector(worldV,  hh);
            const p4_3d = worldOrigin.clone().addScaledVector(worldU, -hw).addScaledVector(worldV,  hh);

            const edges3D: LaserPanelEdge[] = [
              { p1: p1_3d, p2: p2_3d },
              { p1: p2_3d, p2: p3_3d },
              { p1: p3_3d, p2: p4_3d },
              { p1: p4_3d, p2: p1_3d },
            ];

            panels.push({
              id: `panel_${panelIdCounter++}`,
              name: `${geom.name || node.name}_${f.name}`,
              thickness: options.materialThickness,
              origin3D: worldOrigin,
              normal3D: worldN,
              uAxis3D: worldU,
              vAxis3D: worldV,
              outerPolygon2D,
              innerCutouts2D: [],
              edges3D,
            });
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
          bodyMatrix
        );

        if (meshPanels.length === 0) {
          invalidGeoms.push(`${node.name} (curved non-planar mesh)`);
        } else {
          panels.push(...meshPanels);
          panelIdCounter += meshPanels.length;
        }
      }
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

  return { panels, invalidGeoms };
}

function extractPanelsFromMeshGeom(
  geom: SceneGeom,
  geomMatrix: THREE.Matrix4,
  nodeName: string,
  options: LaserCutOptions,
  startId: number,
  diffGeoms: SceneGeom[],
  bodyMatrix: THREE.Matrix4
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

  // Pair each outer skin with the parallel skin behind it so one sheet yields one
  // panel, positioned on its mid-plane with its measured thickness. The joint
  // engine works from mid-planes, so getting this right is what lets meshed
  // geometry interlock with the same accuracy as box primitives.
  const consumed = new Set<number>();
  const slabs: { info: GroupInfo; thickness: number; offset: number }[] = [];

  for (let i = 0; i < infos.length; i++) {
    if (consumed.has(i)) continue;
    const gi = infos[i];
    if (gi.area < 0.0004) continue;

    let bestJ = -1;
    let bestSep = 0;
    let bestLateral = Infinity;

    for (let j = 0; j < infos.length; j++) {
      if (j === i || consumed.has(j)) continue;
      const gj = infos[j];
      if (gi.group.normal.dot(gj.group.normal) > -0.999) continue;

      // Signed distance from plane i to plane j along plane i's normal.
      const sep = -(gi.group.planeDist + gj.group.planeDist);
      const th = Math.abs(sep);
      if (th < 0.0002 || th > 0.03) continue;
      if (gj.area < gi.area * 0.25 || gj.area > gi.area * 4) continue;

      // The two skins must sit on top of each other, not merely be parallel.
      const delta = new THREE.Vector3().subVectors(gj.centroid, gi.centroid);
      delta.addScaledVector(gi.group.normal, -delta.dot(gi.group.normal));
      const lateral = delta.length();
      if (lateral > 0.25 * Math.sqrt(gi.area)) continue;

      if (lateral < bestLateral) {
        bestLateral = lateral;
        bestJ = j;
        bestSep = sep;
      }
    }

    consumed.add(i);
    if (bestJ >= 0) {
      consumed.add(bestJ);
      slabs.push({ info: gi, thickness: Math.abs(bestSep), offset: bestSep / 2 });
    } else {
      slabs.push({ info: gi, thickness: options.materialThickness, offset: 0 });
    }
  }

  let idCounter = startId;
  for (const slab of slabs) {
    const group = slab.info.group;

    const normalN = group.normal.clone().normalize();
    let uAxis = new THREE.Vector3(1, 0, 0);
    if (Math.abs(normalN.dot(uAxis)) > 0.9) {
      uAxis = new THREE.Vector3(0, 1, 0);
    }
    const vAxis = new THREE.Vector3().crossVectors(normalN, uAxis).normalize();
    uAxis = new THREE.Vector3().crossVectors(vAxis, normalN).normalize();

    // Sits on the sheet's mid-plane; the in-plane coordinates are unaffected.
    const origin3D = slab.info.centroid.clone().addScaledVector(normalN, slab.offset);

    const edgeMap = new Map<string, { p1: THREE.Vector3; p2: THREE.Vector3; count: number }>();

    function edgeKey(p1: THREE.Vector3, p2: THREE.Vector3): string {
      const k1 = `${p1.x.toFixed(4)},${p1.y.toFixed(4)},${p1.z.toFixed(4)}`;
      const k2 = `${p2.x.toFixed(4)},${p2.y.toFixed(4)},${p2.z.toFixed(4)}`;
      return k1 < k2 ? `${k1}_${k2}` : `${k2}_${k1}`;
    }

    for (const tri of group.tris) {
      const edges = [
        { p1: tri.a, p2: tri.b },
        { p1: tri.b, p2: tri.c },
        { p1: tri.c, p2: tri.a },
      ];
      for (const e of edges) {
        const key = edgeKey(e.p1, e.p2);
        const existing = edgeMap.get(key);
        if (existing) {
          existing.count++;
        } else {
          edgeMap.set(key, { p1: e.p1, p2: e.p2, count: 1 });
        }
      }
    }

    const boundaryEdges: { p1: THREE.Vector3; p2: THREE.Vector3 }[] = [];
    for (const entry of edgeMap.values()) {
      if (entry.count === 1) {
        boundaryEdges.push(entry);
      }
    }

    if (boundaryEdges.length < 3) continue;

    const edges2D: { p1: Point2D; p2: Point2D }[] = [];
    const edges3D: LaserPanelEdge[] = [];

    for (const e of boundaryEdges) {
      edges3D.push({ p1: e.p1, p2: e.p2 });

      const d1 = new THREE.Vector3().subVectors(e.p1, origin3D);
      const u1 = d1.dot(uAxis) * 1000;
      const v1 = d1.dot(vAxis) * 1000;

      const d2 = new THREE.Vector3().subVectors(e.p2, origin3D);
      const u2 = d2.dot(uAxis) * 1000;
      const v2 = d2.dot(vAxis) * 1000;

      edges2D.push({ p1: { x: u1, y: v1 }, p2: { x: u2, y: v2 } });
    }

    const loops = chainBoundaryLoops2D(edges2D);
    if (loops.length === 0) continue;

    // Triangulated boundaries arrive as long runs of nearly-colinear points and,
    // where a CSG result was quantised, as sub-millimetre staircases. Both are
    // below any cutter's resolution, so flatten them before joints are cut.
    const clean = (l: Point2D[]) => simplifyPolyline2D(simplifyPolygon2D(l), 0.25);
    const outerPolygon2D = clean(loops[0]);
    const innerCutouts2D = loops.slice(1).map(clean).filter(l => l.length >= 3);

    // Holes modelled as CSG subtractions live on the body, not in the mesh, so
    // they have to be projected on separately — otherwise a laser-cut panel
    // comes out solid where the model has an opening.
    innerCutouts2D.push(
      ...projectCutouts2D(diffGeoms, bodyMatrix, origin3D, uAxis, vAxis,
                          pt => pointInPolygon2D(outerPolygon2D, pt),
                          Math.max(slab.thickness, options.materialThickness))
    );

    if (outerPolygon2D.length < 3) continue;

    // Reject the edge bands of a sheet rather than cutting them as panels. A
    // band that runs around a sheet's rim has an area of roughly its perimeter
    // times the material thickness, however large its bounding box is (the
    // bottom rim of a hollow shell is a full-size square annulus). A real face's
    // area outruns that by a wide margin. Both tests are needed: this one
    // catches rings, the extent test catches long straight strips.
    const loopPerimeter = (l: Point2D[]) => {
      let sum = 0;
      for (let i = 0; i < l.length; i++) {
        const a = l[i];
        const b = l[(i + 1) % l.length];
        sum += Math.hypot(b.x - a.x, b.y - a.y);
      }
      return sum;
    };
    const perimeterMm = loopPerimeter(outerPolygon2D) +
      innerCutouts2D.reduce((acc, l) => acc + loopPerimeter(l), 0);
    const areaMm2 = slab.info.area * 1e6;
    if (areaMm2 < 1.5 * perimeterMm * slab.thickness * 1000) continue;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const pt of outerPolygon2D) {
      minX = Math.min(minX, pt.x); maxX = Math.max(maxX, pt.x);
      minY = Math.min(minY, pt.y); maxY = Math.max(maxY, pt.y);
    }
    if (Math.min(maxX - minX, maxY - minY) < 2 * slab.thickness * 1000) continue;

    meshPanels.push({
      id: `panel_${idCounter++}`,
      name: `${geom.name || nodeName}_poly_${meshPanels.length + 1}`,
      thickness: slab.thickness,
      origin3D,
      normal3D: normalN,
      uAxis3D: uAxis,
      vAxis3D: vAxis,
      outerPolygon2D,
      innerCutouts2D,
      edges3D,
    });
  }

  return meshPanels;
  return meshPanels;
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
  /** Stock thickness the joint was sized for (mm). */
  stock: number;
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
function detectJoints(panels: LaserPanel[], options: LaserCutOptions): RawJoint[] {
  // Joints are sized from the stock being cut, not from how thick the panels
  // happen to have been drawn. A tab has to span the material it passes through,
  // so a model drawn in 3 mm and cut from 6 mm needs 6 mm tabs — sizing them off
  // the model instead is what made the thickness setting look inert.
  const stockMm = options.materialThickness * 1000;
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
      const reach = (stockMm / 2) * invSin;

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
      const offA = mA.dEdge + reach;
      const onA = mA.dEdge - reach - proud;
      const offB = mB.dEdge + reach;
      const onB = mB.dEdge - reach - proud;
      // A panel sitting entirely past its neighbour's near face is not a joint.
      if (offA < -MIN_FEATURE_MM || offB < -MIN_FEATURE_MM) continue;

      const lo = Math.max(mA.s0, mB.s0);
      const hi = Math.min(mA.s1, mB.s1);
      if (hi - lo < Math.max(6, 3 * Math.max(tA, tB))) continue;

      // A mortise has to be a closed hole, so the female panel needs material
      // beyond the tenon's slab. Either side may qualify; prefer whichever has
      // more room rather than always mortising the same one.
      const roomA = mA.dEdge - reach;
      const roomB = mB.dEdge - reach;
      const bestRoom = Math.max(roomA, roomB);
      const slotFemale: 0 | 1 | -1 = bestRoom < 0.8 ? -1 : (roomA >= roomB ? 0 : 1);

      joints.push({
        ia, ib, mA, mB, offA, offB, onA, onB, lo, hi, tA, tB, stock: stockMm,
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
      const inset = raw > 0 ? Math.max(raw, j.stock) : 0;

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

function buildJointWork(
  panels: LaserPanel[],
  options: LaserCutOptions,
  fallbacks: string[]
): PanelJointWork[] {
  const work: PanelJointWork[] = panels.map(() => ({ features: [], mortises: [] }));
  const fingerWidthMm = options.fingerWidth * 1000;
  const kerfMm = options.kerf * 1000;
  // Across a finger's width, the fit is whatever the user asked for on top of
  // the kerf. Along its depth only the kerf matters — that governs whether a tab
  // bottoms out, not how tightly it grips.
  const widthHalf = (kerfMm - options.jointClearance * 1000) / 2;
  const depthHalf = kerfMm / 2;

  // Cut profiles are computed against a CCW outline so "inward" is unambiguous.
  for (const panel of panels) {
    panel.outerPolygon2D = ensureCCW(panel.outerPolygon2D);
  }

  const joints = detectJoints(panels, options);
  const owners = resolveCornerOwners(panels, joints);

  joints.forEach((j, jointIdx) => {
    const { ia, ib, mA, mB, offA, offB, onA, onB, tA, tB } = j;
    const owner = owners[jointIdx];
    const lo = j.lo + owner.insetLo;
    const hi = j.hi - owner.insetHi;
    const span = hi - lo;
    if (span < Math.max(6, 3 * Math.max(tA, tB))) return;

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
    const tenonThickness = j.stock;

    const push = (panelIdx: number, m: EdgeMatch, sa: number, sb: number, depth: number) => {
      if (Math.abs(depth) < MIN_FEATURE_MM) return;
      const t0 = sToEdgeT(m, sa);
      const t1 = sToEdgeT(m, sb);
      work[panelIdx].features.push({
        edgeIdx: m.edgeIdx,
        ta: Math.min(t0, t1),
        tb: Math.max(t0, t1),
        depth,
      });
    };

    // Pare back the bands the joint pulled away from its corners, so the outline
    // runs straight from the corner into the first cell rather than stepping out
    // over a block that mates with nothing. In Tab & Slot the female's edge is
    // straight anyway — there is no recess beside its band to strand it, and
    // notching it here would cut into the panel for no reason.
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
        // Only the panel that recedes in the end cell gives up its band. Doing
        // it to both would cut the corner away twice over; doing it to the one
        // that keeps the cell would strand its tab on a pared-back edge. This
        // way exactly one panel holds the contested corner, and its band is
        // simply part of the tab beside it.
        if (sideOwnsCell(side, k)) continue;
        const p = jointPanel(j, side);
        if (useSlot && p.idx === femaleIdx) continue;
        // Runs from the panel's own corner — not merely from where the two
        // edges stop overlapping — to where the receding cell starts, half a
        // kerf inboard of the nominal boundary. Stopping anywhere short leaves
        // a tooth of the old block behind.
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
        // The male panel's edge alternates exactly as it would for a finger
        // joint: tenons reach through to the far face, and between them it draws
        // back to the female's near face. Skipping that draw-back would leave
        // the male's full edge buried inside the female panel. What differs from
        // a finger joint is only the female side — its edge stays straight and
        // the tenons pass through interior mortises instead.
        const maleOwns = (k % 2 === 0) === maleOwnsCell;
        push(maleIdx, maleMatch,
             maleOwns ? s0 - widthHalf : s0 + widthHalf,
             maleOwns ? s1 + widthHalf : s1 - widthHalf,
             (maleOwns ? maleOn : maleOff) - depthHalf);
        if (maleOwns) {
          work[femaleIdx].mortises.push(
            buildMortise(panels[femaleIdx], femaleMatch, s0 + widthHalf, s1 - widthHalf,
                         j.mortiseInner + depthHalf,
                         tenonThickness - kerfMm + options.jointClearance * 1000)
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
function applyEdgeFeatures(poly: Point2D[], features: EdgeFeature[]): Point2D[] {
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
      // than the beam cutting it, so snap those onto the corner.
      if (ta < MIN_FEATURE_MM) ta = 0;
      if (len - tb < MIN_FEATURE_MM) tb = len;
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

    profiles.push({ origin: e0, u, m, len, runs });
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
 * How far past the corner the relief circle reaches, in mm. Placing the circle
 * so it merely touches the corner point leaves the union pinched to zero width
 * there, which is not a polygon a cutter can follow; a few hundredths of a
 * millimetre of overlap gives two clean crossings instead.
 */
const RELIEF_OVERLAP_MM = 0.05;

/**
 * Cuts inside-corner relief into one closed loop.
 *
 * `loop` must be wound with material on the left — outline CCW, hole CW — so
 * that a right turn is a corner the material wraps around, i.e. one the bit has
 * to reach into. At each such corner a circle of the bit's radius is unioned in:
 * the corner vertex is replaced by the two points where the circle crosses the
 * adjacent edges, joined by the arc that runs out into the material.
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

  interface Relief {
    i: number;
    c: Point2D;      // circle centre
    qA: Point2D;     // crossing on the outgoing edge
    qB: Point2D;     // crossing on the incoming edge
    angA: number;
    angB: number;
    sweep: number;
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

    let dir: Point2D;
    if (style === 'tbone') {
      // Bite into the longer wall, so the shorter one — the face a tenon seats
      // against — stays flat.
      dir = aLen >= bLen ? eA : eB;
    } else {
      const bx = eA.x + eB.x;
      const by = eA.y + eB.y;
      const bl = Math.hypot(bx, by);
      if (bl < 1e-9) continue; // 180 degrees; nothing to relieve
      dir = { x: -bx / bl, y: -by / bl }; // bisector, into the material
    }

    const d = Math.max(0, radiusMm - RELIEF_OVERLAP_MM);
    const c = { x: p.x + dir.x * d, y: p.y + dir.y * d };

    // Where each edge leaves the circle, walking out from the corner. The
    // corner sits inside the circle, so there is exactly one crossing each.
    const exitAlong = (e: Point2D, limit: number): number | null => {
      const fx = p.x - c.x;
      const fy = p.y - c.y;
      const b = fx * e.x + fy * e.y;
      const cc = fx * fx + fy * fy - radiusMm * radiusMm;
      const disc = b * b - cc;
      if (disc < 0) return null;
      const t = -b + Math.sqrt(disc);
      return t > 1e-9 && t < limit ? t : null;
    };

    const tA = exitAlong(eA, aLen);
    const tB = exitAlong(eB, bLen);
    if (tA === null || tB === null) { skipped++; continue; }

    const qB = { x: p.x + eB.x * tB, y: p.y + eB.y * tB };
    const qA = { x: p.x + eA.x * tA, y: p.y + eA.y * tA };

    const angB = Math.atan2(qB.y - c.y, qB.x - c.x);
    const angA = Math.atan2(qA.y - c.y, qA.x - c.x);

    // Of the two arcs between the crossings, take the one lying in the
    // material — the other one doubles back through the void the corner opens
    // onto. Distance from the corner does not decide this: for a t-bone, whose
    // circle straddles the wall it is centred on, both arcs bulge well clear of
    // the corner and only one of them is cutting anything.
    let sweep = angA - angB;
    while (sweep <= 0) sweep += Math.PI * 2;
    const mid = angB + sweep / 2;
    const midPt = { x: c.x + Math.cos(mid) * radiusMm, y: c.y + Math.sin(mid) * radiusMm };
    if (pointInPolygon2D(loop, midPt) !== materialInside) sweep -= Math.PI * 2;

    candidates.push({ i, c, qA, qB, angA, angB, sweep });
  }

  // A relief circle is only usable if it stays clear of the rest of the
  // outline. Two of them can also collide with each other without either
  // touching a far edge — a mortise shallower than the bit puts one at each end
  // of its short wall, and the two bites merge into a figure of eight. Both
  // checks have to run, and a rejected corner is a corner this bit cannot cut.
  const accepted: Relief[] = [];
  for (const r of candidates) {
    let clear = true;

    for (let e = 0; e < n && clear; e++) {
      // The corner's own two edges are what the circle is meant to cross.
      if (e === r.i || e === (r.i - 1 + n) % n) continue;
      if (pointSegmentDist(r.c, loop[e], loop[(e + 1) % n]) < radiusMm - 1e-6) clear = false;
    }

    for (const o of accepted) {
      if (Math.hypot(r.c.x - o.c.x, r.c.y - o.c.y) < radiusMm * 2 - 1e-6) { clear = false; break; }
    }

    if (clear) accepted.push(r);
    else skipped++;
  }

  if (accepted.length === 0) return { loop, skipped };

  const byIndex = new Map(accepted.map(r => [r.i, r]));
  const out: Point2D[] = [];

  for (let i = 0; i < n; i++) {
    const r = byIndex.get(i);
    if (!r) { out.push(loop[i]); continue; }

    const steps = Math.max(4, Math.ceil(Math.abs(r.sweep) / (Math.PI * 2) * 32));
    out.push(r.qB);
    for (let k = 1; k < steps; k++) {
      const ang = r.angB + (r.sweep * k) / steps;
      out.push({ x: r.c.x + Math.cos(ang) * radiusMm, y: r.c.y + Math.sin(ang) * radiusMm });
    }
    out.push(r.qA);
  }

  return { loop: out, skipped };
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

function applyJointsToPanels(panels: LaserPanel[], options: LaserCutOptions): string[] {
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
  const work = buildJointWork(panels, options, fallbacks);

  const unjointed: string[] = [];
  for (let i = 0; i < panels.length; i++) {
    const panel = panels[i];
    if (work[i].features.length === 0 && work[i].mortises.length === 0) {
      unjointed.push(panel.name);
    }
    panel.outerPolygon2D = applyEdgeFeatures(panel.outerPolygon2D, work[i].features);
    for (const mortise of work[i].mortises) {
      panel.innerCutouts2D.push(mortise);
    }
  }

  // Relief comes last: it needs the finished outline, with every finger notch
  // and mortise already cut, because those are what create the inside corners.
  warnings.push(...reliefWarnings(panels, options));

  if (unjointed.length > 0) {
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
  const stockMm = options.materialThickness * 1000;
  if (modelled.length > 0) {
    const typical = modelled[Math.floor(modelled.length / 2)];
    if (stockMm > 1.5 * typical) {
      // Past this point the stock is thicker than the gap the model leaves for
      // it, so neighbouring panels overlap in space. Every joint then wants the
      // material at the corner it shares with the next one, and both keep it —
      // the small proud blocks that have to be snapped off after cutting. It is
      // the model that has to change, so name the thickness that would suit it.
      warnings.push(
        `The model is drawn with ${typical.toFixed(1)} mm panels but joints are cut for ` +
        `${stockMm.toFixed(1)} mm stock — too thick for the spacing the model leaves. ` +
        `Panels will overlap where they meet, and corners come out with small proud ` +
        `blocks that have to be broken off. Cut this from about ${typical.toFixed(1)} mm ` +
        `stock, or scale the model up until it suits ${stockMm.toFixed(1)} mm.`
      );
    } else if (Math.abs(typical - stockMm) > 0.25 * stockMm) {
      warnings.push(
        `The model is drawn with ${typical.toFixed(1)} mm panels but joints are cut for ` +
        `${stockMm.toFixed(1)} mm stock. The joints themselves will fit, but panel spacing ` +
        `still follows the model, so parts may not seat where they meet face-to-face.`
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
    for (const cutout of panel.innerCutouts2D) {
      for (const pt of cutout) {
        pt.x *= s;
        pt.y *= s;
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
    for (const cutout of panel.innerCutouts2D) {
      for (const pt of cutout) {
        pt.x -= minX;
        pt.y -= minY;
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
function packPanels(
  panels: LaserPanel[],
  sheetWidthMm: number,
  sheetHeightMm: number,
  marginMm: number
): { sheetCount: number; oversized: string[] } {
  let currentX = marginMm;
  let currentY = marginMm;
  let rowHeight = 0;
  let sheetIndex = 0;
  const oversized: string[] = [];

  const order = [...panels].sort((a, b) => (b.height2D || 0) - (a.height2D || 0));

  for (const panel of order) {
    const pw = panel.width2D || 50;
    const ph = panel.height2D || 50;

    if (pw + 2 * marginMm > sheetWidthMm || ph + 2 * marginMm > sheetHeightMm) {
      oversized.push(`${panel.name} (${pw.toFixed(0)} x ${ph.toFixed(0)} mm)`);
    }

    if (currentX + pw + marginMm > sheetWidthMm) {
      currentX = marginMm;
      currentY += rowHeight + marginMm;
      rowHeight = 0;
    }

    if (currentY + ph + marginMm > sheetHeightMm) {
      sheetIndex++;
      currentX = marginMm;
      currentY = marginMm;
      rowHeight = 0;
    }

    panel.placedPos2D = { x: currentX, y: currentY };
    panel.sheetIndex = sheetIndex;
    currentX += pw + marginMm;
    if (ph > rowHeight) rowHeight = ph;
  }

  return { sheetCount: sheetIndex + 1, oversized };
}

export function exportLaserCutSvg(
  scene: SceneGraph,
  userOptions?: Partial<LaserCutOptions>
): LaserCutResult {
  const options: LaserCutOptions = { ...DEFAULT_LASER_OPTIONS, ...userOptions };

  const extracted = extractPanelsFromScene(scene, options);
  const invalidGeoms = extracted.invalidGeoms;
  let panels = extracted.panels;

  if (panels.length === 0) {
    if (invalidGeoms.length > 0) {
      return {
        success: false,
        error: `Laser cut export failed: Scene contains unsupported curved geometries [${invalidGeoms.join(
          ', '
        )}]. Laser cutting requires flat planar panels or box primitives.`,
      };
    }
    return {
      success: false,
      error: 'No valid planar panels or box objects found in the scene to cut.',
    };
  }

  const sheetWidthMm = options.sheetWidth * 1000;
  const sheetHeightMm = options.sheetHeight * 1000;
  const marginMm = options.margin * 1000;
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
    const working = clonePanels(panels);
    if (Math.abs(s - 1.0) > 1e-4) scalePanels(working, s);
    const warnings = applyJointsToPanels(working, options);
    normalizePanelBounds(working);
    const packed = packPanels(working, sheetWidthMm, sheetHeightMm, marginMm);
    return { panels: working, warnings, ...packed };
  };

  const fits = (b: { sheetCount: number; oversized: string[] }) =>
    b.oversized.length === 0 && (maxSheets === 0 || b.sheetCount <= maxSheets);

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

  panels = build.panels;
  const warnings = build.warnings;
  const sheetCount = build.sheetCount;
  const oversized = build.oversized;

  if (maxSheets > 0 && sheetCount > maxSheets) {
    warnings.unshift(
      `Could not get the cuts onto ${maxSheets} sheet${maxSheets === 1 ? '' : 's'} — even at ` +
      `${(scaleFactor * 100).toFixed(0)}% they need ${sheetCount}. Joint tabs and mortises are ` +
      `sized from the ${(options.materialThickness * 1000).toFixed(1)} mm stock and do not shrink ` +
      `with the scale, so a bigger sheet or thinner material is the way down.`
    );
  }

  if (Math.abs(scaleFactor - 1.0) > 1e-3) {
    warnings.unshift(
      `Cuts scaled to ${(scaleFactor * 100).toFixed(0)}% (${scaleFactor.toFixed(2)}x) to fit ${sheetWidthMm.toFixed(0)} x ${sheetHeightMm.toFixed(0)} mm sheet bounds${maxSheets > 0 ? ` (limited to ${maxSheets} sheet${maxSheets === 1 ? '' : 's'})` : ''}.`
    );
  } else if (oversized.length > 0) {
    warnings.push(
      `Too big for a ${sheetWidthMm.toFixed(0)} x ${sheetHeightMm.toFixed(0)} mm sheet: ` +
      `${oversized.join(', ')}. Pick a larger sheet or enable Auto Scale — these are ` +
      `drawn overflowing their sheet outline.`
    );
  }

  const totalSvgWidth = sheetWidthMm;
  const totalSvgHeight = sheetHeightMm * sheetCount;

  let svg = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n`;
  svg += `<svg width="${totalSvgWidth}mm" height="${totalSvgHeight}mm" viewBox="0 0 ${totalSvgWidth} ${totalSvgHeight}" xmlns="http://www.w3.org/2000/svg">\n`;
  svg += `  <!-- Generated by PhysBox Laser Cut Engine -->\n`;
  svg += `  <!-- Settings: Joint=${options.jointMode}, Thickness=${(options.materialThickness*1000).toFixed(1)}mm, Kerf=${(options.kerf*1000).toFixed(2)}mm, Scale=${(scaleFactor*100).toFixed(0)}%, Relief=${
    options.cornerRelief === 'none'
      ? 'none'
      : `${options.cornerRelief} @ ${(options.bitDiameter*1000).toFixed(2)}mm bit`
  } -->\n\n`;

  if (options.includeSheetOutline) {
    for (let s = 0; s < sheetCount; s++) {
      const sheetY = s * sheetHeightMm;
      svg += `  <!-- Sheet ${s + 1} Frame -->\n`;
      svg += `  <rect x="0" y="${sheetY}" width="${sheetWidthMm}" height="${sheetHeightMm}" fill="none" stroke="#94A3B8" stroke-width="0.5" stroke-dasharray="4 4" />\n`;
      if (options.includeLabels) {
        svg += `  <text x="10" y="${sheetY + 20}" fill="#64748B" font-family="sans-serif" font-size="12" font-weight="bold">Sheet ${s + 1} (${sheetWidthMm}mm x ${sheetHeightMm}mm${scaleFactor !== 1 ? ` @ ${(scaleFactor*100).toFixed(0)}% scale` : ''})</text>\n`;
      }
      svg += `\n`;
    }
  }

  svg += `  <g id="cut-paths" stroke="#FF0000" stroke-width="0.2" fill="none" stroke-linejoin="round" stroke-linecap="round">\n`;

  // Panels are packed in the coordinates of their own sheet. The drawing stacks
  // the sheets one below the next, so that is where the offset goes back in.
  const drawPos = (panel: LaserPanel): Point2D => {
    const pos = panel.placedPos2D || { x: 0, y: 0 };
    return { x: pos.x, y: pos.y + (panel.sheetIndex || 0) * sheetHeightMm };
  };

  for (const panel of panels) {
    const pos = drawPos(panel);

    if (panel.outerPolygon2D.length > 0) {
      let pathData = `M ${(pos.x + panel.outerPolygon2D[0].x).toFixed(2)} ${(pos.y + panel.outerPolygon2D[0].y).toFixed(2)}`;
      for (let i = 1; i < panel.outerPolygon2D.length; i++) {
        pathData += ` L ${(pos.x + panel.outerPolygon2D[i].x).toFixed(2)} ${(pos.y + panel.outerPolygon2D[i].y).toFixed(2)}`;
      }
      pathData += ` Z`;
      svg += `    <path d="${pathData}" />\n`;
    }

    for (const cutout of panel.innerCutouts2D) {
      if (cutout.length === 0) continue;
      let cData = `M ${(pos.x + cutout[0].x).toFixed(2)} ${(pos.y + cutout[0].y).toFixed(2)}`;
      for (let i = 1; i < cutout.length; i++) {
        cData += ` L ${(pos.x + cutout[i].x).toFixed(2)} ${(pos.y + cutout[i].y).toFixed(2)}`;
      }
      cData += ` Z`;
      svg += `    <path d="${cData}" />\n`;
    }
  }
  svg += `  </g>\n\n`;

  if (options.includeLabels) {
    svg += `  <g id="engrave-labels" fill="#0000FF" font-family="sans-serif" font-size="8" text-anchor="middle">\n`;
    for (const panel of panels) {
      const pos = drawPos(panel);
      const cx = pos.x + (panel.width2D || 50) / 2;
      const cy = pos.y + (panel.height2D || 50) / 2;
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
    scaleFactor,
    warnings,
  };
}
