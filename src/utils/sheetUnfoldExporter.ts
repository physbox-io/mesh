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
import { buildEtchHandoffUrl, etchBaseUrl } from './etchHandoff';
import { toBase64Url } from './shareLink';

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

/**
 * Checks whether two 2D polygons have a positive-area interior overlap.
 * Polygons that merely share a hinge edge or touch at a corner return false.
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

  const cA = polygonCentroid2D(polyA);
  if (pointStrictlyInPolygon2D(polyB, cA, epsMm)) return true;
  const cB = polygonCentroid2D(polyB);
  if (pointStrictlyInPolygon2D(polyA, cB, epsMm)) return true;

  for (const p of polyA) {
    const inset = { x: p.x + (cA.x - p.x) * 0.15, y: p.y + (cA.y - p.y) * 0.15 };
    if (pointStrictlyInPolygon2D(polyB, inset, epsMm)) return true;
  }
  for (const p of polyB) {
    const inset = { x: p.x + (cB.x - p.x) * 0.15, y: p.y + (cB.y - p.y) * 0.15 };
    if (pointStrictlyInPolygon2D(polyA, inset, epsMm)) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// 3D Polygonal Mesh Representation & Coplanar Triangle Clustering
// ---------------------------------------------------------------------------

interface PolyFace3D {
  index: number;
  /** Vertex indices into `PolySurface3D.vertices`, wound CCW around `normal`. */
  verts: number[];
  normal: THREE.Vector3;
  centroid: THREE.Vector3;
  areaM2: number;
  /** Local 2D coordinates in mm (isometric to 3D face, wound CCW). */
  local2D: Point2D[];
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

function buildPolyFace3D(index: number, verts: number[], vertices: THREE.Vector3[]): PolyFace3D | null {
  if (verts.length < 3) return null;

  // Compute Newell normal and area-weighted centroid
  const normal = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  let areaM2 = 0;

  const v0 = vertices[verts[0]];
  for (let i = 1; i + 1 < verts.length; i++) {
    const a = v0;
    const b = vertices[verts[i]];
    const c = vertices[verts[i + 1]];
    const ab = new THREE.Vector3().subVectors(b, a);
    const ac = new THREE.Vector3().subVectors(c, a);
    const cross = new THREE.Vector3().crossVectors(ab, ac);
    const triArea = cross.length() * 0.5;
    normal.add(cross);
    areaM2 += triArea;
    centroid.addScaledVector(a, triArea / 3);
    centroid.addScaledVector(b, triArea / 3);
    centroid.addScaledVector(c, triArea / 3);
  }

  if (areaM2 < 1e-9 || normal.lengthSq() < 1e-18) return null;
  normal.normalize();
  centroid.divideScalar(areaM2);

  // Build local orthonormal right-handed 2D basis (u, v) in face plane
  let uAxis = new THREE.Vector3().subVectors(vertices[verts[1]], v0);
  uAxis.addScaledVector(normal, -uAxis.dot(normal));
  if (uAxis.lengthSq() < 1e-12) {
    uAxis = Math.abs(normal.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    uAxis.addScaledVector(normal, -uAxis.dot(normal));
  }
  uAxis.normalize();
  const vAxis = new THREE.Vector3().crossVectors(normal, uAxis).normalize();

  const local2D: Point2D[] = verts.map((vi) => {
    const d = new THREE.Vector3().subVectors(vertices[vi], v0);
    return {
      x: d.dot(uAxis) * 1000,
      y: d.dot(vAxis) * 1000,
    };
  });

  if (polygonSignedArea2D(local2D) < 0) {
    verts.reverse();
    local2D.reverse();
  }

  return {
    index,
    verts,
    normal,
    centroid,
    areaM2,
    local2D,
  };
}

/**
 * Clusters coplanar adjacent triangles into polygonal faces within `coplanarToleranceDeg`.
 */
function clusterTrianglesToPolyFaces(
  vertices: THREE.Vector3[],
  triIndices: number[],
  coplanarToleranceDeg: number
): PolyFace3D[] {
  interface TriInfo {
    id: number;
    v: [number, number, number];
    normal: THREE.Vector3;
    area: number;
  }

  const tris: TriInfo[] = [];
  for (let i = 0; i + 2 < triIndices.length; i += 3) {
    const a = triIndices[i];
    const b = triIndices[i + 1];
    const c = triIndices[i + 2];
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
          // Check consistent winding across shared edge (curr has u->v, nb should have v->u)
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

  // Count how many distinct clusters touch each vertex so we can safely collapse
  // collinear intermediate vertices along straight shared edges.
  const vertexClusters = new Map<number, Set<number>>();
  for (let tId = 0; tId < tris.length; tId++) {
    const cid = triClusterId[tId];
    for (const v of tris[tId].v) {
      let set = vertexClusters.get(v);
      if (!set) {
        set = new Set();
        vertexClusters.set(v, set);
      }
      set.add(cid);
    }
  }

  const polyFaces: PolyFace3D[] = [];

  for (const cluster of clusters) {
    // Collect directed half-edges in this cluster; cancel interior opposite pairs
    const directedSet = new Set<string>();
    const halfEdges: [number, number][] = [];
    for (const tId of cluster) {
      const v = tris[tId].v;
      for (let e = 0; e < 3; e++) {
        const a = v[e];
        const b = v[(e + 1) % 3];
        directedSet.add(`${a}:${b}`);
        halfEdges.push([a, b]);
      }
    }

    const boundaryEdges = halfEdges.filter(([a, b]) => !directedSet.has(`${b}:${a}`));
    if (boundaryEdges.length < 3) continue;

    // Chain directed boundary edges into closed loop(s)
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
      let currV = boundaryEdges[s][1];

      for (let guard = 0; guard <= boundaryEdges.length; guard++) {
        if (currV === startV) break;
        loop.push(currV);
        const candidates = nextMap.get(currV) || [];
        let chosen = -1;
        for (const cIdx of candidates) {
          if (!usedEdge[cIdx]) {
            chosen = cIdx;
            break;
          }
        }
        if (chosen < 0) break;
        usedEdge[chosen] = 1;
        currV = boundaryEdges[chosen][1];
      }

      if (loop.length >= 3) {
        loops.push(loop);
      }
    }

    if (loops.length === 0) continue;

    // Pick outer boundary loop (largest area)
    let bestLoop = loops[0];
    let bestFace = buildPolyFace3D(polyFaces.length, [...bestLoop], vertices);
    for (let l = 1; l < loops.length; l++) {
      const candidate = buildPolyFace3D(polyFaces.length, [...loops[l]], vertices);
      if (candidate && (!bestFace || candidate.areaM2 > bestFace.areaM2)) {
        bestLoop = loops[l];
        bestFace = candidate;
      }
    }

    if (!bestFace) continue;

    // Simplify collinear vertices that only belong to at most 2 clusters
    // so both adjacent faces simplify the same intermediate point identically.
    const simplified: number[] = [];
    const n = bestLoop.length;
    for (let i = 0; i < n; i++) {
      const prevV = bestLoop[(i - 1 + n) % n];
      const currV = bestLoop[i];
      const nextV = bestLoop[(i + 1) % n];
      const cSet = vertexClusters.get(currV);
      if (cSet && cSet.size <= 2 && n > 3) {
        const d1 = new THREE.Vector3().subVectors(vertices[currV], vertices[prevV]).normalize();
        const d2 = new THREE.Vector3().subVectors(vertices[nextV], vertices[currV]).normalize();
        if (d1.dot(d2) > 0.9995) {
          continue;
        }
      }
      simplified.push(currV);
    }

    const finalFace = buildPolyFace3D(polyFaces.length, simplified.length >= 3 ? simplified : bestLoop, vertices);
    if (finalFace) {
      polyFaces.push(finalFace);
    }
  }

  return polyFaces;
}

/**
 * Extracts 3D polygonal surfaces from a scene graph.
 * Supports:
 *   1. `node.latticeCage` polygonal faces directly when present (and unsubdivided)
 *   2. Box, cylinder, wedge, pyramid, and cone primitives
 *   3. Compiled CSG or triangle meshes (`geom.type === 'mesh'`)
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
      const f = buildPolyFace3D(faces.length, [...q], rawCorners);
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

    const faces: PolyFace3D[] = [];
    // Bottom cap (-Z): reversed so normal points -Z
    const bottomLoop = Array.from({ length: n }, (_, i) => n - 1 - i);
    const bottomFace = buildPolyFace3D(faces.length, bottomLoop, vertices);
    if (bottomFace) faces.push(bottomFace);

    // Top cap (+Z)
    const topLoop = Array.from({ length: n }, (_, i) => n + i);
    const topFace = buildPolyFace3D(faces.length, topLoop, vertices);
    if (topFace) faces.push(topFace);

    // Side quads
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      const side = buildPolyFace3D(faces.length, [i, next, n + next, n + i], vertices);
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
    if (isBoughtIn(node)) {
      for (const child of node.children || []) traverse(child, bodyMatrix);
      return;
    }

    const includeNode = !targetSet || targetSet.has(node.id) || targetSet.has(node.name);

    if (includeNode) {
      let extractedForNode = false;

      // 1. Direct latticeCage polygonal faces when present and unsubdivided
      if (
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
          rawVerts.push(applyTransformAndScale(local, bodyMatrix));
        }

        const faces: PolyFace3D[] = [];
        let cursor = 0;
        for (const sz of cage.faceSizes) {
          if (sz >= 3 && cursor + sz <= cage.faces.length) {
            const loop = cage.faces.slice(cursor, cursor + sz);
            const pf = buildPolyFace3D(faces.length, loop, rawVerts);
            if (pf) faces.push(pf);
          }
          cursor += sz;
        }

        if (faces.length > 0) {
          surfaces.push({
            nodeId: node.id,
            nodeName: node.name || node.id,
            vertices: rawVerts,
            faces,
          });
          extractedForNode = true;
        }
      }

      // 2. Compiled CSG visual mesh or node geoms
      if (!extractedForNode) {
        const geoms = node.geoms || [];
        const compiledVisual = geoms.find(
          (g) => g.type === 'mesh' && g.csgDerived === 'visual' && (g.renderVertices || g.vertices) && g.faces
        );

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
            const remappedTris = geom.faces.map((idx) => remap[idx] ?? 0);
            const polyFaces = clusterTrianglesToPolyFaces(
              vertices,
              remappedTris,
              options.coplanarToleranceDeg
            );
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
  polygon2D: Point2D[];
  /** Maps local 2D point of this face into island 2D space. */
  transformPoint: (localPt: Point2D) => Point2D;
  /**
   * How far each edge is moved in for a bend's setback, mm (sheet metal). The
   * face is drawn to the model's outside; the flat stops this short of it.
   */
  setbacks: number[];
}

/**
 * How far a bend's flat stops short of the model's corner, mm. The model is
 * the outside of the part, the sheet behind it, so a mountain (convex) bend's
 * outside is the model side, radius R + T, and a valley's inside is, radius R.
 * Either way the flat ends where the arc starts, r·tan(θ/2) from the corner.
 */
export function bendSetbackMm(angleDeg: number, bendRadiusMm: number, thicknessMm: number): number {
  const half = (Math.min(170, Math.abs(angleDeg)) * Math.PI) / 360;
  const r = Math.max(0, bendRadiusMm) + (angleDeg >= 0 ? Math.max(0, thicknessMm) : 0);
  return r * Math.tan(half);
}

/**
 * A face's polygon with each edge moved in by its setback, the corners where
 * the moved lines meet. Vertex i stays vertex i.
 */
function trimPolygon2D(poly: Point2D[], setbacks: number[]): Point2D[] {
  const n = poly.length;
  if (!setbacks.some((d) => d > 0)) return poly.map((p) => ({ ...p }));
  // Each edge as a point and direction, moved left (inward: the face is CCW).
  const lines = poly.map((p, i) => {
    const q = poly[(i + 1) % n];
    const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
    const ux = (q.x - p.x) / len, uy = (q.y - p.y) / len;
    const d = setbacks[i] || 0;
    return { x: p.x - uy * d, y: p.y + ux * d, ux, uy };
  });
  return poly.map((p, i) => {
    const a = lines[(i - 1 + n) % n], b = lines[i];
    const det = a.ux * b.uy - a.uy * b.ux;
    if (Math.abs(det) < 1e-9) {
      // Straight on: the vertex moves in by the larger of the two.
      const d = Math.max(setbacks[(i - 1 + n) % n] || 0, setbacks[i] || 0);
      return { x: p.x - b.uy * d, y: p.y + b.ux * d };
    }
    const s = ((b.x - a.x) * b.uy - (b.y - a.y) * b.ux) / det;
    return { x: a.x + a.ux * s, y: a.y + a.uy * s };
  });
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

/**
 * Unfolds a single 3D polygonal surface into one or more non-overlapping 2D islands.
 */
function unfoldSurfaceToIslands(
  surface: PolySurface3D,
  options: SheetUnfoldOptions,
  startPairId: number,
  startIslandIndex: number
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
        // Both flats stop short of the model's corner by the setback, and the
        // bend's own length goes between them.
        const setbackMm = bent ? bendSetbackMm(se.angleDeg, options.bendRadiusMm, options.thicknessMm) : 0;

        const { transform, targetV1, targetV2 } = buildUnfoldTransform2D(
          placedA_v1,
          placedA_v2,
          localB_v1,
          localB_v2,
          baMm - 2 * setbackMm
        );

        const candidatePoly2D = childFace.local2D.map(transform);
        const childSetbacks = childFace.verts.map((_, i) => (i === childEdgeIdx ? setbackMm : 0));
        const parentSetbacks = parentState.setbacks.map((d, i) => (i === parentEdgeIdx ? setbackMm : d));

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

        // Commit child face to this island
        faceVisited[childIdx] = 1;
        usedTreeEdgeIds.add(se.id);
        totalBendAllowanceMm += baMm;

        parentState.setbacks = parentSetbacks;
        placedFaces.set(childIdx, {
          faceIndex: childIdx,
          polygon2D: candidatePoly2D,
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
    // zone between the two trimmed edges.
    for (const st of placedFaces.values()) st.polygon2D = trimPolygon2D(st.polygon2D, st.setbacks);
    for (const te of treeEdges) {
      const parent = placedFaces.get(te.parentFace)!.polygon2D;
      const child = placedFaces.get(te.childFace)!.polygon2D;
      te.p1 = parent[te.parentEnds[0]];
      te.p2 = parent[te.parentEnds[1]];
      te.childP1 = child[te.childEnds[0]];
      te.childP2 = child[te.childEnds[1]];
    }

    rawIslands.push({ placedFaces, treeEdges });
  }

  // 3. Assign edge-pair IDs to all split shared edges (non-tree edges)
  let nextPairId = startPairId;
  const splitEdgePairId = new Map<number, number>();
  // Decide which side (faceA or faceB) of each split edge gets the glue tab
  const glueTabOwnerFace = new Map<number, number>();

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
      const polyA = islA.placedFaces.get(se.faceA)!.polygon2D;
      const polyB = islB.placedFaces.get(se.faceB)!.polygon2D;

      const a1 = polyA[se.edgeIdxInA];
      const a2 = polyA[(se.edgeIdxInA + 1) % polyA.length];
      const b1 = polyB[se.edgeIdxInB];
      const b2 = polyB[(se.edgeIdxInB + 1) % polyB.length];

      const tabA = buildGlueTabPolygon(a1, a2, options.tabWidthMm, options.tabAngleDeg);
      const tabB = buildGlueTabPolygon(b1, b2, options.tabWidthMm, options.tabAngleDeg);

      const clearanceScore = (tab: Point2D[], isl: RawIsland, ownFace: number): number => {
        if (tab.length < 4) return -Infinity;
        for (const [fi, st] of isl.placedFaces.entries()) {
          if (fi === ownFace) continue;
          if (polygonsOverlap2D(tab, st.polygon2D, 0.05)) return -1e6;
        }
        for (const existingTab of placedTabPolysByIsland.get(isl) || []) {
          if (polygonsOverlap2D(tab, existingTab, 0.05)) return -5e5;
        }
        const tipMid = {
          x: (tab[1].x + tab[2].x) * 0.5,
          y: (tab[1].y + tab[2].y) * 0.5,
        };
        let minDist = 1e6;
        for (const [fi, st] of isl.placedFaces.entries()) {
          if (fi === ownFace) continue;
          const c = polygonCentroid2D(st.polygon2D);
          const d = Math.hypot(tipMid.x - c.x, tipMid.y - c.y);
          if (d < minDist) minDist = d;
        }
        return minDist;
      };

      const scoreA = clearanceScore(tabA, islA, se.faceA);
      const scoreB = clearanceScore(tabB, islB, se.faceB);

      if (scoreA >= scoreB) {
        glueTabOwnerFace.set(se.id, se.faceA);
        placedTabPolysByIsland.get(islA)!.push(tabA);
      } else {
        glueTabOwnerFace.set(se.id, se.faceB);
        placedTabPolysByIsland.get(islB)!.push(tabB);
      }
    }
  }

  // 4. Construct final UnfoldIsland objects with fold edges, cut seams, glue tabs,
  //    bend zones / relief notches, or seam allowance + stitch holes.
  const islands: UnfoldIsland[] = [];

  for (let ii = 0; ii < rawIslands.length; ii++) {
    const raw = rawIslands[ii];
    const islandId = `${surface.nodeId}_island_${startIslandIndex + ii + 1}`;

    const unfoldedFaces: UnfoldedFace2D[] = [];
    for (const st of raw.placedFaces.values()) {
      unfoldedFaces.push({
        faceIndex: st.faceIndex,
        polygon2D: st.polygon2D,
        centroid2D: polygonCentroid2D(st.polygon2D),
        areaMm2: polygonArea2D(st.polygon2D),
        model3DMm: faces[st.faceIndex].verts.map((v) => [vertices[v].x * 1000, vertices[v].y * 1000, vertices[v].z * 1000]),
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
      }
    >();

    const foldEdges: UnfoldFoldEdge[] = [];
    const bendCornerPoints: Point2D[] = [];

    for (let ti = 0; ti < raw.treeEdges.length; ti++) {
      const te = raw.treeEdges[ti];
      const se = te.shared;
      const parentEdge = se.faceA === te.parentFace ? se.edgeIdxInA : se.edgeIdxInB;
      const childEdge = se.faceA === te.parentFace ? se.edgeIdxInB : se.edgeIdxInA;

      treeTwinMap.set(`${te.parentFace}:${parentEdge}`, {
        twinFace: te.childFace,
        twinEdge: childEdge,
        bridgeStart: te.p2,
        bridgeEnd: te.childP2,
      });
      treeTwinMap.set(`${te.childFace}:${childEdge}`, {
        twinFace: te.parentFace,
        twinEdge: parentEdge,
        bridgeStart: te.childP1,
        bridgeEnd: te.p1,
      });

      if (Math.abs(se.angleDeg) < options.coplanarToleranceDeg) continue;

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

      foldEdges.push({
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
      });

      bendCornerPoints.push(centerP1, centerP2);
    }

    // Collect exterior boundary half-edges and chain them in topological CCW order
    interface ExtHalfEdge {
      faceIndex: number;
      edgeIndex: number;
      p1: Point2D;
      p2: Point2D;
      outwardNormal: Point2D;
      sharedEdge?: SharedMeshEdge;
    }

    const extHalfEdges: ExtHalfEdge[] = [];
    const extKeyToIndex = new Map<string, number>();

    for (const [fi, st] of raw.placedFaces.entries()) {
      const poly = st.polygon2D;
      const m = poly.length;
      for (let ei = 0; ei < m; ei++) {
        if (treeTwinMap.has(`${fi}:${ei}`)) continue;
        const p1 = poly[ei];
        const p2 = poly[(ei + 1) % m];
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

        // Advance around planar tree
        let f = curr.faceIndex;
        let e = (curr.edgeIndex + 1) % faces[f].verts.length;
        for (let hop = 0; hop <= raw.placedFaces.size * 2; hop++) {
          const twin = treeTwinMap.get(`${f}:${e}`);
          if (!twin) break;
          f = twin.twinFace;
          e = (twin.twinEdge + 1) % faces[f].verts.length;
        }
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

    for (const cycle of orderedCycles) {
      const seamLoop: Point2D[] = [];
      const cutLoop: Point2D[] = [];

      for (let ci = 0; ci < cycle.length; ci++) {
        const ext = cycle[ci];
        seamLoop.push(ext.p1);

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

        let alignmentNotches: [Point2D, Point2D][] | undefined;

        if (options.mode === 'soft_goods') {
          const dx = ext.p2.x - ext.p1.x;
          const dy = ext.p2.y - ext.p1.y;
          const len = Math.hypot(dx, dy);

          // Perpendicular alignment notches along mating seam edges
          if (len >= 6 && options.notchLengthMm > 0) {
            const notchFractions = len > 80 ? [1 / 3, 2 / 3] : [0.5];
            alignmentNotches = notchFractions.map((frac) => {
              const bx = ext.p1.x + dx * frac;
              const by = ext.p1.y + dy * frac;
              return [
                { x: bx, y: by },
                {
                  x: bx + ext.outwardNormal.x * options.notchLengthMm,
                  y: by + ext.outwardNormal.y * options.notchLengthMm,
                },
              ];
            });
          }

          // Equidistant stitch-hole punch points along the original seam line
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

        cutSeams.push({
          pairId,
          faceIndex: ext.faceIndex,
          matingFaceIndex,
          p1: ext.p1,
          p2: ext.p2,
          outwardNormal2D: ext.outwardNormal,
          hasGlueTab,
          alignmentNotches,
        });

        if (hasGlueTab) {
          const tabPoly = buildGlueTabPolygon(ext.p1, ext.p2, options.tabWidthMm, options.tabAngleDeg);
          if (tabPoly.length === 4) {
            glueTabs.push({
              pairId,
              faceIndex: ext.faceIndex,
              polygon2D: tabPoly,
              baseEdge: [ext.p1, ext.p2],
            });
            cutLoop.push(tabPoly[0], tabPoly[1], tabPoly[2], tabPoly[3]);
          } else {
            cutLoop.push(ext.p1, ext.p2);
          }
        } else if (options.mode !== 'soft_goods') {
          cutLoop.push(ext.p1, ext.p2);
        }
      }

      if (seamLoop.length >= 3) {
        seamPolylines2D.push([...seamLoop, seamLoop[0]]);
      }

      if (options.mode === 'soft_goods' && options.seamAllowanceMm > 0) {
        // Offset each exterior edge outward by seamAllowanceMm and miter/bevel corners
        const d = options.seamAllowanceMm;
        const expandedLoop: Point2D[] = [];
        const m = cycle.length;
        for (let i = 0; i < m; i++) {
          const prev = cycle[(i - 1 + m) % m];
          const curr = cycle[i];

          const d1x = prev.p2.x - prev.p1.x;
          const d1y = prev.p2.y - prev.p1.y;
          const l1 = Math.hypot(d1x, d1y) || 1;
          const u1x = d1x / l1;
          const u1y = d1y / l1;

          const d2x = curr.p2.x - curr.p1.x;
          const d2y = curr.p2.y - curr.p1.y;
          const l2 = Math.hypot(d2x, d2y) || 1;
          const u2x = d2x / l2;
          const u2y = d2y / l2;

          const p1Off = {
            x: prev.p2.x + prev.outwardNormal.x * d,
            y: prev.p2.y + prev.outwardNormal.y * d,
          };
          const p2Off = {
            x: curr.p1.x + curr.outwardNormal.x * d,
            y: curr.p1.y + curr.outwardNormal.y * d,
          };

          const det = u1x * u2y - u1y * u2x;
          if (Math.abs(det) > 0.15) {
            const dx = p2Off.x - p1Off.x;
            const dy = p2Off.y - p1Off.y;
            const s = (dx * u2y - dy * u2x) / det;
            const miter = { x: p1Off.x + u1x * s, y: p1Off.y + u1y * s };
            if (Math.hypot(miter.x - curr.p1.x, miter.y - curr.p1.y) <= 2.2 * d) {
              expandedLoop.push(miter);
            } else {
              expandedLoop.push(p1Off, p2Off);
            }
          } else {
            expandedLoop.push(p1Off, p2Off);
          }
        }
        if (expandedLoop.length >= 3) {
          cutPolylines2D.push([...expandedLoop, expandedLoop[0]]);
        }
      } else if (cutLoop.length >= 3) {
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

    // Sheet-metal bend relief notches at vertices where 2+ fold edges meet
    if (
      options.mode === 'sheet_metal' &&
      options.bendReliefWidthMm > 0 &&
      options.bendReliefDepthMm > 0 &&
      foldEdges.length >= 2
    ) {
      const rw = options.bendReliefWidthMm;
      const rd = options.bendReliefDepthMm;
      for (let i = 0; i < bendCornerPoints.length; i++) {
        const pt = bendCornerPoints[i];
        let meetCount = 1;
        for (let j = 0; j < bendCornerPoints.length; j++) {
          if (i !== j && Math.hypot(pt.x - bendCornerPoints[j].x, pt.y - bendCornerPoints[j].y) < 5 + rw * 2) {
            meetCount++;
          }
        }
        if (meetCount >= 2) {
          const alreadyAdded = reliefNotches.some(
            (n) => Math.hypot(n.center2D.x - pt.x, n.center2D.y - pt.y) < rw * 2
          );
          if (!alreadyAdded) {
            const hw = rw * 0.5;
            const hd = rd * 0.5;
            reliefNotches.push({
              center2D: { ...pt },
              widthMm: rw,
              depthMm: rd,
              polygon2D: [
                { x: pt.x - hw, y: pt.y - hd },
                { x: pt.x + hw, y: pt.y - hd },
                { x: pt.x + hw, y: pt.y + hd },
                { x: pt.x - hw, y: pt.y + hd },
              ],
            });
          }
        }
      }
    }

    // Compute island bounding box and normalize to (0, 0)
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

    if (!Number.isFinite(minX)) {
      minX = 0; maxX = 0; minY = 0; maxY = 0;
    }

    const shiftPt = (p: Point2D): Point2D => ({ x: p.x - minX, y: p.y - minY });
    for (const f of unfoldedFaces) {
      f.polygon2D = f.polygon2D.map(shiftPt);
      f.centroid2D = shiftPt(f.centroid2D);
    }
    for (let k = 0; k < cutPolylines2D.length; k++) {
      cutPolylines2D[k] = cutPolylines2D[k].map(shiftPt);
    }
    for (let k = 0; k < seamPolylines2D.length; k++) {
      seamPolylines2D[k] = seamPolylines2D[k].map(shiftPt);
    }
    for (const fe of foldEdges) {
      fe.p1 = shiftPt(fe.p1);
      fe.p2 = shiftPt(fe.p2);
      if (fe.bendZonePolygon2D) {
        fe.bendZonePolygon2D = fe.bendZonePolygon2D.map(shiftPt);
      }
    }
    for (const cs of cutSeams) {
      cs.p1 = shiftPt(cs.p1);
      cs.p2 = shiftPt(cs.p2);
      if (cs.alignmentNotches) {
        cs.alignmentNotches = cs.alignmentNotches.map(([a, b]) => [shiftPt(a), shiftPt(b)]);
      }
    }
    for (const gt of glueTabs) {
      gt.polygon2D = gt.polygon2D.map(shiftPt);
      gt.baseEdge = [shiftPt(gt.baseEdge[0]), shiftPt(gt.baseEdge[1])];
    }
    for (const rn of reliefNotches) {
      rn.center2D = shiftPt(rn.center2D);
      rn.polygon2D = rn.polygon2D.map(shiftPt);
    }
    for (let k = 0; k < stitchHoles.length; k++) {
      stitchHoles[k] = shiftPt(stitchHoles[k]);
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
  const sheetGap = 15;
  const numSheets = Math.max(1, sheets.length);
  const totalHeight = numSheets * sheetH + (numSheets - 1) * sheetGap;

  const fmt = (n: number) => Number(n.toFixed(3));
  const sheetYOffset = (sheetIdx: number) => sheetIdx * (sheetH + sheetGap);

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
        `    <rect x="0" y="${fmt(y0)}" width="${fmt(sheetW)}" height="${fmt(sheetH)}" fill="none" stroke="#94a3b8" stroke-width="0.35" stroke-dasharray="6,4" />`
      );
      if (options.includeLabels) {
        labelParts.push(
          `    <text x="4" y="${fmt(y0 + 5)}" font-family="monospace" font-size="3.2" fill="#475569">Sheet ${s + 1} (${fmt(sheetW)}×${fmt(sheetH)} mm, ${options.mode})</text>`
        );
      }
    }
  }

  for (const isl of islands) {
    const yOff = sheetYOffset(isl.sheetIndex);
    const ptsToPath = (pts: Point2D[], close = false): string => {
      if (pts.length === 0) return '';
      const segs = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${fmt(p.x)} ${fmt(p.y + yOff)}`);
      if (close) segs.push('Z');
      return segs.join(' ');
    };

    // 1. Outer cut outlines
    for (const loop of isl.cutPolylines2D) {
      if (loop.length < 2) continue;
      cutParts.push(`    <path d="${ptsToPath(loop, false)}" />`);
    }

    // Sheet-metal corner relief notches (also on cut layer)
    for (const rn of isl.reliefNotches) {
      cutParts.push(`    <path d="${ptsToPath(rn.polygon2D, true)}" />`);
    }

    // 2. Original seam lines & alignment notches (soft_goods) or glue tab fold bases (papercraft)
    if (options.mode === 'soft_goods') {
      for (const seamLoop of isl.seamPolylines2D) {
        seamTabParts.push(`    <path d="${ptsToPath(seamLoop, false)}" stroke-dasharray="2.5,1.5" />`);
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

    // 3. Mountain & Valley fold lines (plus bend zones and callouts in sheet_metal mode)
    for (const fe of isl.foldEdges) {
      if (fe.bendZonePolygon2D && fe.bendZonePolygon2D.length === 4) {
        const bz = fe.bendZonePolygon2D;
        seamTabParts.push(
          `    <line x1="${fmt(bz[0].x)}" y1="${fmt(bz[0].y + yOff)}" x2="${fmt(bz[1].x)}" y2="${fmt(bz[1].y + yOff)}" stroke-dasharray="1.5,1.5" />`,
          `    <line x1="${fmt(bz[3].x)}" y1="${fmt(bz[3].y + yOff)}" x2="${fmt(bz[2].x)}" y2="${fmt(bz[2].y + yOff)}" stroke-dasharray="1.5,1.5" />`
        );
        // Side bridges connecting bend zone to outer cut contour
        cutParts.push(
          `    <line x1="${fmt(bz[0].x)}" y1="${fmt(bz[0].y + yOff)}" x2="${fmt(bz[3].x)}" y2="${fmt(bz[3].y + yOff)}" />`,
          `    <line x1="${fmt(bz[1].x)}" y1="${fmt(bz[1].y + yOff)}" x2="${fmt(bz[2].x)}" y2="${fmt(bz[2].y + yOff)}" />`
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
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(sheetW)}mm" height="${fmt(totalHeight)}mm" viewBox="0 0 ${fmt(sheetW)} ${fmt(totalHeight)}">`,
    sheetOutlineParts.length > 0 ? `  <g id="layer-sheet-bounds">\n${sheetOutlineParts.join('\n')}\n  </g>` : '',
    seamTabParts.length > 0
      ? `  <g id="layer-seams-tabs" fill="none" stroke="#9333ea" stroke-width="0.25">\n${seamTabParts.join('\n')}\n  </g>`
      : '',
    mountainParts.length > 0
      ? `  <g id="layer-mountain-folds" fill="none" stroke="#2563eb" stroke-width="0.3" stroke-dasharray="4,2">\n${mountainParts.join('\n')}\n  </g>`
      : '',
    valleyParts.length > 0
      ? `  <g id="layer-valley-folds" fill="none" stroke="#16a34a" stroke-width="0.3" stroke-dasharray="5,2,1.2,2">\n${valleyParts.join('\n')}\n  </g>`
      : '',
    stitchHoleParts.length > 0
      ? `  <g id="layer-stitch-holes" fill="none" stroke="#9333ea" stroke-width="0.25">\n${stitchHoleParts.join('\n')}\n  </g>`
      : '',
    cutParts.length > 0
      ? `  <g id="layer-cut" fill="none" stroke="#e11d48" stroke-width="0.35">\n${cutParts.join('\n')}\n  </g>`
      : '',
    labelParts.length > 0 ? `  <g id="layer-labels">\n${labelParts.join('\n')}\n  </g>` : '',
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
  options?: Partial<SheetUnfoldOptions>,
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
    const res = unfoldSurfaceToIslands(surface, opts, nextPairId, allIslands.length);
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
    thickness: String(opts.thicknessMm),
  });
  const etchUrl = `${base}#${syncParams.toString()}`;

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
  options?: Partial<SheetUnfoldOptions>,
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
    },
    baseUrl
  );
}
