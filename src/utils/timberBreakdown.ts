// ---------------------------------------------------------------------------
// Timber & Joinery Breakdown — Phase 1: Member Extraction & Classification
// ---------------------------------------------------------------------------
//
// Turns a modelled table, chair, or 3 ft flower stand into individual structural
// timber members (legs/posts, rails/stretchers/aprons, and tabletop/shelf
// panels), whether the user modelled it as:
//   (A) Separate touching or overlapping bodies/geoms, or
//   (B) One unified solid / lattice / CSG body.
//
// Each extracted member carries its Manifold solid (in body-frame millimetres),
// its oriented bounding box (grain axis along length, width, thickness), its
// semantic woodworking role and positional name (e.g. Leg_FL, Leg_FR, Leg_BL,
// Leg_BR, Apron_Front, Stretcher_Left, Tabletop_Plank_1), and explicit
// Reference Faces (Face 1 = Outer Show Face, Face 2 = Reference Edge) so a
// novice woodworker never loses their datum at the bandsaw or CNC fence.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { Manifold, ManifoldToplevel, Mat4 } from 'manifold-3d';
import type { SceneGeom, SceneGraph, SceneNode } from '../types/scene';
import { createSculptMesh } from './sculptMesh';
import { toManifold } from './sculptCut';
import { weldSoup, type FeatureCollider, type JoineryFeature, type SplitSection } from './printSplit';
import { appendSolidTriangles } from './contourSliceExporter';
import { getNodeWorldTransform } from './laserCutExporter';
import { resolveCsgGeoms } from './csg';
import type { Vec3 } from './printPlate';

const MM = 1000;

export type MemberRole = 'leg' | 'rail' | 'panel';
export type CornerTag = 'FL' | 'FR' | 'BL' | 'BR' | 'C';

export interface ReferenceFaceSpec {
  /** Outward unit normal in the root body frame (Z-up). */
  normal: Vec3;
  /** Human-readable direction label for the shop card, e.g. "Front (+Y exterior)". */
  label: string;
}

export interface TimberMember {
  /** Internal index 0..N-1. */
  index: number;
  /** Semantic identifier, e.g. 'Leg_FL', 'Apron_Front', 'Stretcher_Lower_Left', 'Tabletop'. */
  id: string;
  /** Human-readable title for the Part Card, e.g. 'Front-Left Leg (Leg_FL)'. */
  title: string;
  role: MemberRole;
  /** Positional corner for legs/posts so the 4 legs are never confused. */
  cornerTag?: CornerTag;
  /** Mirror partner ID if this leg/rail is a left/right mirror pair. */
  mirrorOf?: string;
  /** Center of the plain member in root body frame, mm. */
  centerMm: Vec3;
  /**
   * Orthonormal principal axes in root body frame:
   *   axes[0] = length / grain direction (longest extent for legs & rails)
   *   axes[1] = width direction (wider cross-section axis)
   *   axes[2] = thickness direction (thinner cross-section axis)
   */
  axes: [Vec3, Vec3, Vec3];
  /** Extents [lengthMm, widthMm, thicknessMm] along `axes` (shoulder-to-shoulder for rails). */
  dimsMm: [number, number, number];
  /** Axis-aligned bounding box in root body frame, mm. */
  bboxMm: { min: Vec3; max: Vec3 };
  /** Face 1 (Show Face / Exterior datum) and Face 2 (Reference Edge datum). */
  face1: ReferenceFaceSpec;
  face2: ReferenceFaceSpec;
  /** Whether the member's cross-section tapers along its length (e.g. tapered leg). */
  isTapered: boolean;
  /** Minimum cross-section at the narrowest end if tapered, mm. */
  taperEndMm?: [number, number];
  /** Triangles of the plain extracted member in root body frame, mm (Manifold mesh). */
  positionsMm: Float32Array;
  faces: Uint32Array;
  volumeMm3: number;
  /** If split from a wide tabletop/seat panel, which plank index (1-based) and total planks. */
  plankInfo?: { index: number; total: number; parentName: string };
}

export interface ExtractMembersOptions {
  /**
   * Maximum single-board width available in the shop before edge-gluing is
   * needed for a tabletop or chair seat, in mm. Default 180 mm.
   */
  maxBoardWidthMm?: number;
  /**
   * Whether to split wide panels (like a tabletop or wide chair seat) into
   * edge-glued planks along their grain. Default true.
   */
  splitWidePanels?: boolean;
}

const dot3 = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const cross3 = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const unit3 = (v: ArrayLike<number>): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

const scale3 = (v: ArrayLike<number>, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];

/** Convert a metre soup into a Manifold in millimetres. */
export function soupToManifoldMm(wasm: ManifoldToplevel, soupMetres: ArrayLike<number>): Manifold | null {
  const mm = new Float64Array(soupMetres.length);
  for (let i = 0; i < soupMetres.length; i++) mm[i] = soupMetres[i] * MM;
  const { positions, faces } = weldSoup(mm);
  if (faces.length < 12) return null;
  const made = toManifold(wasm, createSculptMesh(positions, faces));
  if (!made.ok) return null;
  if (made.manifold.isEmpty() || !(made.manifold.volume() > 1e-2)) {
    made.manifold.delete();
    return null;
  }
  return made.manifold;
}

/** Extract positions (in mm) and triangle indices from a Manifold. */
export function manifoldToMeshMm(m: Manifold): { positionsMm: Float32Array; faces: Uint32Array; volumeMm3: number } {
  const mesh = m.getMesh();
  const positionsMm = new Float32Array(mesh.numVert * 3);
  for (let v = 0; v < mesh.numVert; v++) {
    positionsMm[v * 3] = mesh.vertProperties[v * mesh.numProp];
    positionsMm[v * 3 + 1] = mesh.vertProperties[v * mesh.numProp + 1];
    positionsMm[v * 3 + 2] = mesh.vertProperties[v * mesh.numProp + 2];
  }
  return {
    positionsMm,
    faces: Uint32Array.from(mesh.triVerts),
    volumeMm3: m.volume(),
  };
}

/** Rebuild a Manifold from millimetre vertex positions and triangle faces. */
export function meshMmToManifold(wasm: ManifoldToplevel, positionsMm: Float32Array, faces: Uint32Array): Manifold {
  return new wasm.Manifold(
    new wasm.Mesh({
      numProp: 3,
      vertProperties: new Float32Array(positionsMm),
      triVerts: new Uint32Array(faces),
    }),
  );
}

/**
 * Collect individual geom soups from a selection of scene nodes, preserving
 * per-geom separation when a body is built from multiple positive geoms or
 * child bodies, in the first selected node's local frame (Z-up, metres).
 */
export function collectIndividualPartSoups(
  scene: SceneGraph,
  ids: string[],
): { items: { soup: Float64Array; hintName?: string; hintQuat?: [number, number, number, number] }[]; absorbed: string[] } {
  const worlds = new Map<string, { node: SceneNode; world: THREE.Matrix4 }>();
  const walk = (nodes: SceneNode[], parent?: THREE.Matrix4) => {
    for (const n of nodes) {
      const world = getNodeWorldTransform(n, parent);
      worlds.set(n.id, { node: n, world });
      walk(n.children || [], world);
    }
  };
  walk(scene.nodes);
  const picked = ids.map((id) => worlds.get(id)).filter((x): x is { node: SceneNode; world: THREE.Matrix4 } => !!x);
  if (!picked.length) return { items: [], absorbed: [] };

  const first = picked[0];
  const toFirst = first.world.clone().invert();
  const items: { soup: Float64Array; hintName?: string; hintQuat?: [number, number, number, number] }[] = [];
  const absorbed: string[] = [];
  const seen = new Set<string>([first.node.id]);

  const collectFromNode = (n: SceneNode, frame: THREE.Matrix4) => {
    const geoms = resolveCsgGeoms(n, 'render').filter((g: SceneGeom) => g.role !== 'collision');
    for (const geom of geoms) {
      const out: number[] = [];
      if (appendSolidTriangles(geom, frame, out) && out.length >= 36) {
        items.push({
          soup: Float64Array.from(out),
          hintName: geom.name || n.name,
        });
      }
    }
    for (const child of n.children || []) {
      if (child.joints?.length) continue;
      if (!seen.has(child.id)) {
        seen.add(child.id);
        absorbed.push(child.id);
      }
      collectFromNode(child, getNodeWorldTransform(child, frame));
    }
  };

  collectFromNode(first.node, new THREE.Matrix4());
  for (const { node, world } of picked.slice(1)) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    absorbed.push(node.id);
    collectFromNode(node, new THREE.Matrix4().multiplyMatrices(toFirst, world));
  }

  return { items, absorbed };
}

/**
 * Find the Oriented Bounding Box (OBB) of a millimetre vertex buffer.
 * Tests world axes first, plus dominant triangle face normals and PCA directions
 * so angled chair legs or splayed flower-stand stretchers get tight bounds along
 * their true timber axis.
 */
function computeMemberObb(positionsMm: Float32Array, faces: Uint32Array): {
  centerMm: Vec3;
  axes: [Vec3, Vec3, Vec3];
  dimsMm: [number, number, number];
  bboxMm: { min: Vec3; max: Vec3 };
  isTapered: boolean;
  taperEndMm?: [number, number];
} {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positionsMm.length; i += 3) {
    const x = positionsMm[i], y = positionsMm[i + 1], z = positionsMm[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const bboxMm = { min: [minX, minY, minZ] as Vec3, max: [maxX, maxY, maxZ] as Vec3 };

  // Gather candidate primary axes from face normals + world axes.
  const candidates: Vec3[] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const normalBuckets = new Map<string, { n: Vec3; area: number }>();
  for (let t = 0; t < faces.length; t += 3) {
    const i0 = faces[t] * 3, i1 = faces[t + 1] * 3, i2 = faces[t + 2] * 3;
    const ux = positionsMm[i1] - positionsMm[i0];
    const uy = positionsMm[i1 + 1] - positionsMm[i0 + 1];
    const uz = positionsMm[i1 + 2] - positionsMm[i0 + 2];
    const vx = positionsMm[i2] - positionsMm[i0];
    const vy = positionsMm[i2 + 1] - positionsMm[i0 + 1];
    const vz = positionsMm[i2 + 2] - positionsMm[i0 + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-6) continue;
    let u: Vec3 = [nx / len, ny / len, nz / len];
    // Canonicalize sign
    if (u[2] < -1e-4 || (Math.abs(u[2]) <= 1e-4 && (u[1] < -1e-4 || (Math.abs(u[1]) <= 1e-4 && u[0] < 0)))) {
      u = [-u[0], -u[1], -u[2]];
    }
    const key = `${Math.round(u[0] * 50)},${Math.round(u[1] * 50)},${Math.round(u[2] * 50)}`;
    const prev = normalBuckets.get(key);
    if (prev) prev.area += len * 0.5;
    else normalBuckets.set(key, { n: u, area: len * 0.5 });
  }
  const topNormals = [...normalBuckets.values()].sort((a, b) => b.area - a.area).slice(0, 8);
  for (const { n } of topNormals) candidates.push(n);

  // Evaluate candidate orthonormal frames and pick the smallest-volume OBB
  // (with a tiny preference for world-aligned axes on ties).
  let bestVol = Infinity;
  let bestFrame: [Vec3, Vec3, Vec3] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  let bestMin: Vec3 = [minX, minY, minZ];
  let bestMax: Vec3 = [maxX, maxY, maxZ];

  const tryFrame = (u: Vec3, v: Vec3, w: Vec3, penalty = 1) => {
    let lo0 = Infinity, hi0 = -Infinity;
    let lo1 = Infinity, hi1 = -Infinity;
    let lo2 = Infinity, hi2 = -Infinity;
    for (let i = 0; i < positionsMm.length; i += 3) {
      const p: Vec3 = [positionsMm[i], positionsMm[i + 1], positionsMm[i + 2]];
      const d0 = dot3(p, u), d1 = dot3(p, v), d2 = dot3(p, w);
      if (d0 < lo0) lo0 = d0; if (d0 > hi0) hi0 = d0;
      if (d1 < lo1) lo1 = d1; if (d1 > hi1) hi1 = d1;
      if (d2 < lo2) lo2 = d2; if (d2 > hi2) hi2 = d2;
    }
    const vol = Math.max(1e-3, hi0 - lo0) * Math.max(1e-3, hi1 - lo1) * Math.max(1e-3, hi2 - lo2) * penalty;
    if (vol < bestVol) {
      bestVol = vol;
      bestFrame = [u, v, w];
      bestMin = [lo0, lo1, lo2];
      bestMax = [hi0, hi1, hi2];
    }
  };

  tryFrame([1, 0, 0], [0, 1, 0], [0, 0, 1], 0.99);
  for (let i = 0; i < candidates.length; i++) {
    const u = unit3(candidates[i]);
    for (let j = i + 1; j < candidates.length; j++) {
      const rawV = candidates[j];
      const dotUV = dot3(u, rawV);
      if (Math.abs(dotUV) > 0.95) continue;
      const v = unit3([rawV[0] - dotUV * u[0], rawV[1] - dotUV * u[1], rawV[2] - dotUV * u[2]]);
      const w = unit3(cross3(u, v));
      tryFrame(u, v, w, 1.0);
    }
  }

  // Sort the 3 axes of bestFrame by extent descending:
  //   0 -> length (grain), 1 -> width, 2 -> thickness
  const extents = [
    { axis: bestFrame[0], lo: bestMin[0], hi: bestMax[0], span: bestMax[0] - bestMin[0] },
    { axis: bestFrame[1], lo: bestMin[1], hi: bestMax[1], span: bestMax[1] - bestMin[1] },
    { axis: bestFrame[2], lo: bestMin[2], hi: bestMax[2], span: bestMax[2] - bestMin[2] },
  ].sort((a, b) => b.span - a.span);

  // Canonicalize axis directions so +Z or +X/+Y is preferred
  const canon = (a: Vec3): Vec3 => {
    if (a[2] < -1e-3) return [-a[0], -a[1], -a[2]];
    if (Math.abs(a[2]) <= 1e-3 && a[1] < -1e-3) return [-a[0], -a[1], -a[2]];
    if (Math.abs(a[2]) <= 1e-3 && Math.abs(a[1]) <= 1e-3 && a[0] < 0) return [-a[0], -a[1], -a[2]];
    return a;
  };
  const a0 = canon(extents[0].axis);
  const a1 = canon(extents[1].axis);
  let a2 = unit3(cross3(a0, a1));
  if (dot3(a2, extents[2].axis) === 0) a2 = canon(extents[2].axis);

  const mid0 = 0.5 * (extents[0].lo + extents[0].hi);
  const mid1 = 0.5 * (extents[1].lo + extents[1].hi);
  const mid2 = 0.5 * (extents[2].lo + extents[2].hi);
  const centerMm: Vec3 = [
    bestFrame[0][0] * (0.5 * (bestMin[0] + bestMax[0])) +
      bestFrame[1][0] * (0.5 * (bestMin[1] + bestMax[1])) +
      bestFrame[2][0] * (0.5 * (bestMin[2] + bestMax[2])),
    bestFrame[0][1] * (0.5 * (bestMin[0] + bestMax[0])) +
      bestFrame[1][1] * (0.5 * (bestMin[1] + bestMax[1])) +
      bestFrame[2][1] * (0.5 * (bestMin[2] + bestMax[2])),
    bestFrame[0][2] * (0.5 * (bestMin[0] + bestMax[0])) +
      bestFrame[1][2] * (0.5 * (bestMin[1] + bestMax[1])) +
      bestFrame[2][2] * (0.5 * (bestMin[2] + bestMax[2])),
  ];
  void mid0; void mid1; void mid2;

  const lengthMm = extents[0].span;
  const widthMm = extents[1].span;
  const thicknessMm = extents[2].span;

  // Check if the member tapers along its primary length axis (e.g. a tapered table or stand leg)
  let topLo1 = Infinity, topHi1 = -Infinity, topLo2 = Infinity, topHi2 = -Infinity;
  let botLo1 = Infinity, botHi1 = -Infinity, botLo2 = Infinity, botHi2 = -Infinity;
  const lenBand = Math.max(15, lengthMm * 0.12);
  let lLo = Infinity, lHi = -Infinity;
  for (let i = 0; i < positionsMm.length; i += 3) {
    const d = positionsMm[i] * a0[0] + positionsMm[i + 1] * a0[1] + positionsMm[i + 2] * a0[2];
    if (d < lLo) lLo = d;
    if (d > lHi) lHi = d;
  }
  for (let i = 0; i < positionsMm.length; i += 3) {
    const px = positionsMm[i], py = positionsMm[i + 1], pz = positionsMm[i + 2];
    const d0 = px * a0[0] + py * a0[1] + pz * a0[2];
    const d1 = px * a1[0] + py * a1[1] + pz * a1[2];
    const d2 = px * a2[0] + py * a2[1] + pz * a2[2];
    if (d0 <= lLo + lenBand) {
      if (d1 < botLo1) botLo1 = d1; if (d1 > botHi1) botHi1 = d1;
      if (d2 < botLo2) botLo2 = d2; if (d2 > botHi2) botHi2 = d2;
    }
    if (d0 >= lHi - lenBand) {
      if (d1 < topLo1) topLo1 = d1; if (d1 > topHi1) topHi1 = d1;
      if (d2 < topLo2) topLo2 = d2; if (d2 > topHi2) topHi2 = d2;
    }
  }
  const topSpan1 = topHi1 - topLo1;
  const topSpan2 = topHi2 - topLo2;
  const botSpan1 = botHi1 - botLo1;
  const botSpan2 = botHi2 - botLo2;

  const minEndW = Math.min(topSpan1, botSpan1);
  const maxEndW = Math.max(topSpan1, botSpan1);
  const minEndT = Math.min(topSpan2, botSpan2);
  const maxEndT = Math.max(topSpan2, botSpan2);
  const isTapered =
    Number.isFinite(minEndW) &&
    minEndW > 5 &&
    (maxEndW - minEndW >= 4 || maxEndT - minEndT >= 4) &&
    minEndW < widthMm * 0.9;

  return {
    centerMm,
    axes: [a0, a1, a2],
    dimsMm: [lengthMm, widthMm, thicknessMm],
    bboxMm,
    isTapered,
    ...(isTapered ? { taperEndMm: [Math.round(minEndW * 10) / 10, Math.round(minEndT * 10) / 10] } : {}),
  };
}

/**
 * Decompose a single unified furniture solid (e.g. a table, bench, or flower
 * stand modelled as one combined solid or lattice mesh) into individual
 * rectangular/prismatic members:
 *   1. Horizontal broad slabs (tabletops, seats, shelves) are sliced off where
 *      the cross-sectional area jumps sharply along Z (e.g. legs meeting the
 *      underside of a tabletop).
 *   2. Inside the remaining frame, horizontal rails/stretchers are separated
 *      from vertical legs/posts along the vertical planes of the leg columns.
 */
function decomposeSingleSolidIntoManifolds(wasm: ManifoldToplevel, solid: Manifold): Manifold[] {
  const initialPieces = solid.decompose();
  if (initialPieces.length > 1) {
    return initialPieces;
  }
  const root = initialPieces[0] ?? solid.translate([0, 0, 0]);
  const box = root.boundingBox();
  const spanX = box.max[0] - box.min[0];
  const spanY = box.max[1] - box.min[1];
  const spanZ = box.max[2] - box.min[2];
  const hull = root.hull();
  const solidity = root.volume() / Math.max(1e-6, hull.volume());
  hull.delete();

  // If the solid is already a single convex block (a single board or post), keep it whole.
  if (solidity > 0.88 || Math.min(spanX, spanY, spanZ) < 10) {
    return [root];
  }

  // Step 1: Detect horizontal slab transitions (e.g. tabletop or shelf sitting
  // on vertical legs) by sampling horizontal cross-section area along Z.
  const SAMPLES_Z = 48;
  const areasZ: { z: number; area: number; count: number }[] = [];
  for (let i = 1; i < SAMPLES_Z; i++) {
    const z = box.min[2] + ((i + 0.5) / SAMPLES_Z) * spanZ;
    const cs = root.slice(z);
    const area = cs.area();
    const parts = cs.decompose();
    const count = parts.length;
    for (const p of parts) p.delete();
    cs.delete();
    areasZ.push({ z, area, count });
  }

  const maxAreaZ = Math.max(...areasZ.map((a) => a.area), 1);
  // Look for a transition between a full horizontal slab (area > 0.55 * maxAreaZ,
  // count === 1) and multi-leg columns (area < 0.35 * maxAreaZ, count >= 2).
  const zSplitPlanes: number[] = [];
  for (let i = 1; i < areasZ.length; i++) {
    const prev = areasZ[i - 1];
    const curr = areasZ[i];
    const prevIsSlab = prev.area > 0.5 * maxAreaZ && prev.count === 1;
    const currIsFrame = curr.area < 0.42 * maxAreaZ;
    const currIsSlab = curr.area > 0.5 * maxAreaZ && curr.count === 1;
    const prevIsFrame = prev.area < 0.42 * maxAreaZ;
    if ((prevIsSlab && currIsFrame) || (prevIsFrame && currIsSlab)) {
      // Refine transition height by binary search
      let lo = prev.z, hi = curr.z;
      for (let step = 0; step < 8; step++) {
        const mid = 0.5 * (lo + hi);
        const cs = root.slice(mid);
        const a = cs.area();
        cs.delete();
        const midIsSlab = a > 0.44 * maxAreaZ;
        if (midIsSlab === prevIsSlab) lo = mid;
        else hi = mid;
      }
      const splitZ = 0.5 * (lo + hi);
      if (!zSplitPlanes.some((z) => Math.abs(z - splitZ) < 8)) {
        zSplitPlanes.push(splitZ);
      }
    }
  }

  let stage1: Manifold[] = [root];
  for (const z of zSplitPlanes.sort((a, b) => a - b)) {
    const next: Manifold[] = [];
    for (const piece of stage1) {
      const pBox = piece.boundingBox();
      if (z <= pBox.min[2] + 3 || z >= pBox.max[2] - 3) {
        next.push(piece);
        continue;
      }
      const [above, below] = piece.splitByPlane([0, 0, 1], z);
      piece.delete();
      for (const half of [below, above]) {
        const comps = half.decompose();
        half.delete();
        for (const c of comps) {
          if (c.volume() > 1000) next.push(c);
          else c.delete();
        }
      }
    }
    stage1 = next;
  }

  // Step 2: For any piece in stage1 that is still a hollow/concave frame (legs +
  // rails/aprons/stretchers joined together), locate the vertical leg columns
  // from a horizontal slice where only the legs are cut, and split rails off
  // the inner faces of the legs.
  const finalPieces: Manifold[] = [];
  for (const piece of stage1) {
    const pHull = piece.hull();
    const pSolidity = piece.volume() / Math.max(1e-6, pHull.volume());
    pHull.delete();
    if (pSolidity > 0.82) {
      finalPieces.push(piece);
      continue;
    }

    const pBox = piece.boundingBox();
    const pSpanZ = pBox.max[2] - pBox.min[2];
    // Find a Z height where the cross-section has >= 2 separate leg islands and minimum total area.
    let bestLegZ: number | null = null;
    let bestLegArea = Infinity;
    for (let k = 1; k < 24; k++) {
      const z = pBox.min[2] + (k / 24) * pSpanZ;
      const cs = piece.slice(z);
      const islands = cs.decompose();
      const area = cs.area();
      cs.delete();
      if (islands.length >= 2 && area < bestLegArea && area > 100) {
        bestLegArea = area;
        bestLegZ = z;
      }
      for (const isl of islands) isl.delete();
    }

    if (bestLegZ === null) {
      finalPieces.push(piece);
      continue;
    }

    const cs = piece.slice(bestLegZ);
    const islands = cs.decompose();
    cs.delete();
    const legBounds = islands.map((isl) => {
      const b = isl.bounds();
      isl.delete();
      return { minX: b.min[0], minY: b.min[1], maxX: b.max[0], maxY: b.max[1] };
    });

    // Collect interior vertical cut planes along X and Y from the inner faces of the legs.
    const xPlanes: number[] = [];
    const yPlanes: number[] = [];
    const midX = 0.5 * (pBox.min[0] + pBox.max[0]);
    const midY = 0.5 * (pBox.min[1] + pBox.max[1]);
    for (const lb of legBounds) {
      const cx = 0.5 * (lb.minX + lb.maxX);
      const cy = 0.5 * (lb.minY + lb.maxY);
      const innerX = cx < midX ? lb.maxX : lb.minX;
      const innerY = cy < midY ? lb.maxY : lb.minY;
      if (innerX > pBox.min[0] + 8 && innerX < pBox.max[0] - 8 && !xPlanes.some((x) => Math.abs(x - innerX) < 4)) {
        xPlanes.push(innerX);
      }
      if (innerY > pBox.min[1] + 8 && innerY < pBox.max[1] - 8 && !yPlanes.some((y) => Math.abs(y - innerY) < 4)) {
        yPlanes.push(innerY);
      }
    }

    // Separate the vertical leg columns first by extruding each leg footprint
    // over the piece's Z height, and subtract the leg columns from the frame to
    // leave the rails/stretchers cleanly separated!
    const legColumns: Manifold[] = [];
    for (const lb of legBounds) {
      const w = lb.maxX - lb.minX + 0.04;
      const d = lb.maxY - lb.minY + 0.04;
      const h = pSpanZ + 2;
      const colBox = wasm.Manifold.cube([w, d, h], false).translate([
        lb.minX - 0.02,
        lb.minY - 0.02,
        pBox.min[2] - 1,
      ]);
      const legSolid = piece.intersect(colBox);
      colBox.delete();
      if (legSolid.volume() > 1000) {
        legColumns.push(legSolid);
      } else {
        legSolid.delete();
      }
    }

    if (legColumns.length >= 2) {
      const allLegs = wasm.Manifold.union(legColumns);
      const railsOnly = piece.subtract(allLegs);
      allLegs.delete();
      piece.delete();
      for (const leg of legColumns) {
        const comps = leg.decompose();
        leg.delete();
        for (const c of comps) {
          if (c.volume() > 1000) finalPieces.push(c);
          else c.delete();
        }
      }
      const railComps = railsOnly.decompose();
      railsOnly.delete();
      for (const rc of railComps) {
        if (rc.volume() > 1000) finalPieces.push(rc);
        else rc.delete();
      }
    } else {
      for (const lc of legColumns) lc.delete();
      void xPlanes; void yPlanes;
      finalPieces.push(piece);
    }
  }

  return finalPieces;
}

/**
 * Classify a member's woodworking role from its dimensions and orientation:
 * - 'panel': broad along two axes, thin along the third (width >= 2.6 * thickness and width > 110 mm)
 * - 'leg': long axis predominantly vertical (|axis0.z| >= 0.65) and bar/post section
 * - 'rail': horizontal or angled bar/stretcher/apron
 */
function classifyRole(axes: [Vec3, Vec3, Vec3], dimsMm: [number, number, number]): MemberRole {
  const [L, W, T] = dimsMm;
  if (W >= 2.6 * T && W >= 110 && L >= 110) {
    return 'panel';
  }
  if (Math.abs(axes[0][2]) >= 0.65) {
    return 'leg';
  }
  return 'rail';
}

function directionPhrase(n: Vec3): string {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  if (az >= ax && az >= ay) return n[2] >= 0 ? 'Top (+Z)' : 'Bottom (-Z)';
  if (ay >= ax) return n[1] >= 0 ? 'Back (+Y)' : 'Front (-Y)';
  return n[0] >= 0 ? 'Right (+X)' : 'Left (-X)';
}

/**
 * Choose Face 1 (Show Face / Exterior datum) and Face 2 (Reference Edge datum)
 * relative to the furniture assembly's overall center so outer faces always
 * register against the CNC fence and bandsaw table.
 */
function chooseReferenceFaces(
  role: MemberRole,
  centerMm: Vec3,
  axes: [Vec3, Vec3, Vec3],
  assemblyCenterMm: Vec3,
): { face1: ReferenceFaceSpec; face2: ReferenceFaceSpec } {
  const outward: Vec3 = [
    centerMm[0] - assemblyCenterMm[0],
    centerMm[1] - assemblyCenterMm[1],
    centerMm[2] - assemblyCenterMm[2],
  ];
  const [, wAxis, tAxis] = axes;

  if (role === 'panel') {
    const topNormal: Vec3 = dot3(tAxis, [0, 0, 1]) >= 0 ? tAxis : scale3(tAxis, -1);
    const frontEdge: Vec3 = dot3(wAxis, [0, -1, 0]) >= 0 ? wAxis : scale3(wAxis, -1);
    return {
      face1: { normal: topNormal, label: `${directionPhrase(topNormal)} Show Face` },
      face2: { normal: frontEdge, label: `${directionPhrase(frontEdge)} Jointed Edge` },
    };
  }

  if (role === 'leg') {
    const n1: Vec3 = dot3(wAxis, outward) >= 0 ? wAxis : scale3(wAxis, -1);
    const n2: Vec3 = dot3(tAxis, outward) >= 0 ? tAxis : scale3(tAxis, -1);
    return {
      face1: { normal: n1, label: `${directionPhrase(n1)} Exterior Show Face` },
      face2: { normal: n2, label: `${directionPhrase(n2)} Exterior Show Face` },
    };
  }

  // Rail / stretcher / apron: Face 1 is the outward-facing broad face, Face 2 is the top edge.
  const n1: Vec3 = dot3(tAxis, outward) >= 0 ? tAxis : scale3(tAxis, -1);
  const n2: Vec3 = dot3(wAxis, [0, 0, 1]) >= 0 ? wAxis : scale3(wAxis, -1);
  return {
    face1: { normal: n1, label: `${directionPhrase(n1)} Outer Show Face` },
    face2: { normal: n2, label: `${directionPhrase(n2)} Top Reference Edge` },
  };
}

/**
 * Strip thin protruding joinery tabs or tongues (such as edge-glue alignment
 * tenon tabs sticking out of a plank's seam edge) from a panel Manifold so its
 * OBB reflects the true shoulder-to-shoulder board blank rather than the
 * protruding tabs.
 */
function stripProtrudingPanelTabs(
  manifold: Manifold,
  obb: ReturnType<typeof computeMemberObb>,
): Manifold {
  let current = manifold;
  // Check both in-plane axes of the panel: width axis (axes[1]) and length axis (axes[0])
  for (const axisIdx of [1, 0] as const) {
    const axis = obb.axes[axisIdx];
    const u = obb.axes[axisIdx === 1 ? 0 : 1];
    const v = obb.axes[2];
    // Rotate so `axis` maps to +Z for fast cross-sectional slicing via `.slice(z)`
    const rotToZ: Mat4 = [
      u[0], v[0], axis[0], 0,
      u[1], v[1], axis[1], 0,
      u[2], v[2], axis[2], 0,
      0, 0, 0, 1,
    ];
    const rotated = current.transform(rotToZ);
    const box = rotated.boundingBox();
    const lo = box.min[2];
    const hi = box.max[2];
    const span = hi - lo;
    if (span <= 40) {
      rotated.delete();
      continue;
    }

    const midCs = rotated.slice(0.5 * (lo + hi));
    const midArea = midCs.area();
    midCs.delete();
    if (midArea <= 50) {
      rotated.delete();
      continue;
    }

    // Check near negative end (`lo + 1 mm`)
    const loCs = rotated.slice(lo + 1.0);
    const loArea = loCs.area();
    loCs.delete();
    let cutLo: number | null = null;
    if (loArea < midArea * 0.45) {
      let sLo = lo + 0.5;
      let sHi = lo + span * 0.25;
      for (let step = 0; step < 14; step++) {
        const sMid = 0.5 * (sLo + sHi);
        const cs = rotated.slice(sMid);
        const a = cs.area();
        cs.delete();
        if (a < midArea * 0.55) sLo = sMid;
        else sHi = sMid;
      }
      const candidate = Math.round(0.5 * (sLo + sHi) * 10) / 10;
      // Verify this is a sharp step shoulder (jump from <45% outside to >88% inside
      // within 1.5 mm), not a smoothly curved circular/oval/tapered panel edge.
      const outCs = rotated.slice(Math.max(lo + 0.2, candidate - 1.0));
      const inCs = rotated.slice(Math.min(hi - 0.2, candidate + 1.5));
      const outArea = outCs.area();
      const inArea = inCs.area();
      outCs.delete();
      inCs.delete();
      if (outArea < midArea * 0.45 && inArea > midArea * 0.88) {
        cutLo = candidate;
      }
    }

    // Check near positive end (`hi - 1 mm`)
    const hiCs = rotated.slice(hi - 1.0);
    const hiArea = hiCs.area();
    hiCs.delete();
    let cutHi: number | null = null;
    if (hiArea < midArea * 0.45) {
      let sLo = hi - span * 0.25;
      let sHi = hi - 0.5;
      for (let step = 0; step < 14; step++) {
        const sMid = 0.5 * (sLo + sHi);
        const cs = rotated.slice(sMid);
        const a = cs.area();
        cs.delete();
        if (a < midArea * 0.55) sHi = sMid;
        else sLo = sMid;
      }
      const candidate = Math.round(0.5 * (sLo + sHi) * 10) / 10;
      const outCs = rotated.slice(Math.min(hi - 0.2, candidate + 1.0));
      const inCs = rotated.slice(Math.max(lo + 0.2, candidate - 1.5));
      const outArea = outCs.area();
      const inArea = inCs.area();
      outCs.delete();
      inCs.delete();
      if (outArea < midArea * 0.45 && inArea > midArea * 0.88) {
        cutHi = candidate;
      }
    }
    rotated.delete();

    if (cutLo !== null && cutLo > lo + 0.5) {
      const [keptPos, droppedNeg] = current.splitByPlane(axis, cutLo);
      droppedNeg.delete();
      if (keptPos.volume() > current.volume() * 0.6) {
        current.delete();
        current = keptPos;
      } else {
        keptPos.delete();
      }
    }
    if (cutHi !== null && cutHi < hi - 0.5) {
      const [droppedPos, keptNeg] = current.splitByPlane(axis, cutHi);
      droppedPos.delete();
      if (keptNeg.volume() > current.volume() * 0.6) {
        current.delete();
        current = keptNeg;
      } else {
        keptNeg.delete();
      }
    }
  }
  return current;
}

/**
 * Extract and classify all structural timber members from a list of metre
 * triangle soups (either multiple parts or a single combined solid).
 */
export function extractTimberMembers(
  wasm: ManifoldToplevel,
  soupsMetres: ArrayLike<number>[],
  options: ExtractMembersOptions = {},
): { ok: true; members: TimberMember[]; warnings: string[] } | { ok: false; error: string } {
  const maxBoardWidthMm = options.maxBoardWidthMm ?? 200;
  const splitWidePanels = options.splitWidePanels ?? true;
  const warnings: string[] = [];

  const rawManifolds: Manifold[] = [];
  for (const soup of soupsMetres) {
    const m = soupToManifoldMm(wasm, soup);
    if (m) rawManifolds.push(m);
  }
  if (!rawManifolds.length) {
    return { ok: false, error: 'This selection has no closed 3D solid geometry to break down into timber parts.' };
  }

  // If the input is a single soup (or a single connected component), run our
  // concave furniture decomposition so a one-piece table becomes legs, rails, and top.
  let decomposed: Manifold[] = [];
  if (rawManifolds.length === 1) {
    decomposed = decomposeSingleSolidIntoManifolds(wasm, rawManifolds[0]);
  } else {
    // Even with multiple soups, each soup may contain disjoint components; decompose them.
    for (const rm of rawManifolds) {
      const comps = rm.decompose();
      rm.delete();
      decomposed.push(...comps);
    }
    // If all components still merged into 1 single manifold, decompose it.
    if (decomposed.length === 1) {
      decomposed = decomposeSingleSolidIntoManifolds(wasm, decomposed[0]);
    }
  }

  // Optional wide-panel plank splitting (e.g. a 600 mm wide tabletop split into
  // narrower boards that fit a bandsaw / benchtop thicknesser and edge-glue together).
  const splitPieces: { manifold: Manifold; plankInfo?: { index: number; total: number; parentName: string } }[] = [];
  for (let m of decomposed) {
    let mesh = manifoldToMeshMm(m);
    let obb = computeMemberObb(mesh.positionsMm, mesh.faces);
    const role = classifyRole(obb.axes, obb.dimsMm);
    if (role === 'panel') {
      const stripped = stripProtrudingPanelTabs(m, obb);
      if (stripped !== m) {
        m = stripped;
        mesh = manifoldToMeshMm(m);
        obb = computeMemberObb(mesh.positionsMm, mesh.faces);
      }
    }
    const widthMm = obb.dimsMm[1];
    if (role === 'panel' && splitWidePanels && widthMm > maxBoardWidthMm * 1.05) {
      const plankCount = Math.min(8, Math.max(2, Math.ceil(widthMm / maxBoardWidthMm)));
      const wAxis = obb.axes[1];
      let loW = Infinity, hiW = -Infinity;
      for (let i = 0; i < mesh.positionsMm.length; i += 3) {
        const d = mesh.positionsMm[i] * wAxis[0] + mesh.positionsMm[i + 1] * wAxis[1] + mesh.positionsMm[i + 2] * wAxis[2];
        if (d < loW) loW = d;
        if (d > hiW) hiW = d;
      }
      const stepW = (hiW - loW) / plankCount;
      let remainder = m;
      const planks: Manifold[] = [];
      for (let k = 1; k < plankCount; k++) {
        const cutOffset = loW + k * stepW;
        const [pos, neg] = remainder.splitByPlane(wAxis, cutOffset);
        remainder.delete();
        if (neg.volume() > 500) planks.push(neg);
        else neg.delete();
        remainder = pos;
      }
      if (remainder.volume() > 500) planks.push(remainder);
      else remainder.delete();

      planks.forEach((p, idx) => {
        splitPieces.push({
          manifold: p,
          plankInfo: { index: idx + 1, total: planks.length, parentName: 'Tabletop' },
        });
      });
      warnings.push(
        `Top/panel (${Math.round(widthMm)} mm wide) exceeds max board width (${maxBoardWidthMm} mm) and was split into ${planks.length} edge-glued planks (~${Math.round(stepW)} mm wide each).`,
      );
    } else {
      splitPieces.push({ manifold: m });
    }
  }

  // Compute overall assembly center for outward reference face assignment.
  const minAll: Vec3 = [Infinity, Infinity, Infinity];
  const maxAll: Vec3 = [-Infinity, -Infinity, -Infinity];
  const prelim = splitPieces.map((sp) => {
    const mesh = manifoldToMeshMm(sp.manifold);
    sp.manifold.delete();
    const obb = computeMemberObb(mesh.positionsMm, mesh.faces);
    for (let k = 0; k < 3; k++) {
      if (obb.bboxMm.min[k] < minAll[k]) minAll[k] = obb.bboxMm.min[k];
      if (obb.bboxMm.max[k] > maxAll[k]) maxAll[k] = obb.bboxMm.max[k];
    }
    return { mesh, obb, plankInfo: sp.plankInfo };
  });

  // Group coplanar side-by-side panels (including pre-split planks like
  // Top_Plank_1 & Top_Plank_2 in `flowerStandPreset`, or a wide tabletop
  // re-split across multiple planks) into ordered plank sets so they receive
  // sequential `Top_Plank_1..N` IDs and edge-glue alignment dowels.
  const panelIndices = prelim
    .map((item, idx) => ({ item, idx }))
    .filter(({ item }) => item.plankInfo || classifyRole(item.obb.axes, item.obb.dimsMm) === 'panel');
  if (panelIndices.length >= 2) {
    // Group by approximate Z height (within 15 mm)
    const zGroups: typeof panelIndices[] = [];
    for (const entry of panelIndices) {
      const z = entry.item.obb.centerMm[2];
      const g = zGroups.find((grp) => Math.abs(grp[0].item.obb.centerMm[2] - z) < 15);
      if (g) g.push(entry);
      else zGroups.push([entry]);
    }
    for (const grp of zGroups) {
      if (grp.length < 2) continue;
      const wAxis = grp[0].item.obb.axes[1];
      grp.sort((a, b) => dot3(a.item.obb.centerMm, wAxis) - dot3(b.item.obb.centerMm, wAxis));
      grp.forEach((entry, pIdx) => {
        entry.item.plankInfo = {
          index: pIdx + 1,
          total: grp.length,
          parentName: 'Tabletop',
        };
      });
    }
  }

  const assemblyCenterMm: Vec3 = [
    0.5 * (minAll[0] + maxAll[0]),
    0.5 * (minAll[1] + maxAll[1]),
    0.5 * (minAll[2] + maxAll[2]),
  ];
  const assemblyHeightMm = Math.max(1, maxAll[2] - minAll[2]);

  // Assign semantic names (Leg_FL, Leg_FR, Leg_BL, Leg_BR, Apron_Front, etc.)
  let legCounter = 1;
  let railCounter = 1;
  let panelCounter = 1;
  const usedIds = new Set<string>();
  const uniqueId = (base: string): string => {
    if (!usedIds.has(base)) {
      usedIds.add(base);
      return base;
    }
    let k = 2;
    while (usedIds.has(`${base}_${k}`)) k++;
    const next = `${base}_${k}`;
    usedIds.add(next);
    return next;
  };

  const members: TimberMember[] = prelim.map((item, index) => {
    const { mesh, obb, plankInfo } = item;
    const role = plankInfo ? 'panel' : classifyRole(obb.axes, obb.dimsMm);
    const { face1, face2 } = chooseReferenceFaces(role, obb.centerMm, obb.axes, assemblyCenterMm);

    let id: string;
    let title: string;
    let cornerTag: CornerTag | undefined;

    if (role === 'leg') {
      const dx = obb.centerMm[0] - assemblyCenterMm[0];
      const dy = obb.centerMm[1] - assemblyCenterMm[1];
      const spanXY = Math.hypot(maxAll[0] - minAll[0], maxAll[1] - minAll[1]);
      if (Math.hypot(dx, dy) < spanXY * 0.12) {
        cornerTag = 'C';
        id = uniqueId('Post_Center');
        title = `Center Pedestal Post (${id})`;
      } else {
        // Front is -Y, Back is +Y, Left is -X, Right is +X
        const frontBack = dy <= 0 ? 'F' : 'B';
        const leftRight = dx <= 0 ? 'L' : 'R';
        cornerTag = `${frontBack}${leftRight}` as CornerTag;
        id = uniqueId(`Leg_${cornerTag}`);
        const fbWord = frontBack === 'F' ? 'Front' : 'Back';
        const lrWord = leftRight === 'L' ? 'Left' : 'Right';
        title = `${fbWord}-${lrWord} Leg (${id})`;
      }
      legCounter++;
      void legCounter;
    } else if (role === 'rail') {
      const relZ = (obb.centerMm[2] - minAll[2]) / assemblyHeightMm;
      const tierPrefix = relZ >= 0.62 ? 'Apron' : 'Stretcher';
      const dx = obb.centerMm[0] - assemblyCenterMm[0];
      const dy = obb.centerMm[1] - assemblyCenterMm[1];
      // Check whether the rail runs along X (Front/Back) or along Y (Left/Right)
      const runsAlongX = Math.abs(obb.axes[0][0]) >= Math.abs(obb.axes[0][1]);
      let sideSuffix: string;
      if (runsAlongX) {
        sideSuffix = Math.abs(dy) < (maxAll[1] - minAll[1]) * 0.15 ? 'Center' : dy < 0 ? 'Front' : 'Back';
      } else {
        sideSuffix = Math.abs(dx) < (maxAll[0] - minAll[0]) * 0.15 ? 'Center' : dx < 0 ? 'Left' : 'Right';
      }
      id = uniqueId(`${tierPrefix}_${sideSuffix}`);
      title = `${sideSuffix} ${tierPrefix} Rail (${id})`;
      railCounter++;
      void railCounter;
    } else {
      if (plankInfo) {
        id = uniqueId(`Top_Plank_${plankInfo.index}`);
        title = `Tabletop Plank ${plankInfo.index} of ${plankInfo.total} (${id})`;
      } else {
        const relZ = (obb.centerMm[2] - minAll[2]) / assemblyHeightMm;
        const kind = relZ >= 0.7 ? 'Tabletop' : 'Shelf';
        id = uniqueId(panelCounter === 1 && kind === 'Tabletop' ? 'Tabletop' : `${kind}_${panelCounter}`);
        title = `${kind} Panel (${id})`;
        panelCounter++;
      }
    }

    return {
      index,
      id,
      title,
      role,
      cornerTag,
      centerMm: obb.centerMm,
      axes: obb.axes,
      dimsMm: [
        Math.round(obb.dimsMm[0] * 10) / 10,
        Math.round(obb.dimsMm[1] * 10) / 10,
        Math.round(obb.dimsMm[2] * 10) / 10,
      ],
      bboxMm: obb.bboxMm,
      face1,
      face2,
      isTapered: obb.isTapered,
      taperEndMm: obb.taperEndMm,
      positionsMm: mesh.positionsMm,
      faces: mesh.faces,
      volumeMm3: mesh.volumeMm3,
      plankInfo,
    };
  });

  // Pair left/right mirrored legs & rails so the Part Cards can point out mirror pairs!
  for (const m of members) {
    if (m.cornerTag === 'FL') {
      const fr = members.find((o) => o.cornerTag === 'FR');
      if (fr) { m.mirrorOf = fr.id; fr.mirrorOf = m.id; }
    } else if (m.cornerTag === 'BL') {
      const br = members.find((o) => o.cornerTag === 'BR');
      if (br) { m.mirrorOf = br.id; br.mirrorOf = m.id; }
    } else if (m.id.endsWith('_Left')) {
      const rightId = m.id.replace(/_Left$/, '_Right');
      const partner = members.find((o) => o.id === rightId);
      if (partner) { m.mirrorOf = partner.id; partner.mirrorOf = m.id; }
    }
  }

  return { ok: true, members, warnings };
}

// ---------------------------------------------------------------------------
// Hollow-Shell & Plank Decomposition of Large Solids
// ---------------------------------------------------------------------------
//
// Decomposes oversized architectural / cabinet / furniture / sculpted solids
// into machinable timber planks with interlocking corner & seam joinery
// (`rabbet`, `miter`, `finger`, or `butt`), alignment dowel holes (`dowelDiaMm`),
// glued-assembly explosion vectors (`explodedOffsetMm`), and a 2D Plank
// Lay-Flat Sheet packing so every plank can be previewed flat, exported to
// STL/ZIP, split into scene bodies, or sent directly to Solid Machining.
// ---------------------------------------------------------------------------

export type PlankJointType = 'rabbet' | 'miter' | 'finger' | 'butt';
export type GrainAxis = 'x' | 'y' | 'z';
export type ShellWallFace = '-z' | '+z' | '-x' | '+x' | '-y' | '+y' | 'layer';

export interface TimberPlankOptions {
  /** Nominal board thickness in mm (default 18 mm). */
  boardThicknessMm?: number;
  /** Maximum single-board width across the grain in mm (default 180 mm). */
  maxBoardWidthMm?: number;
  /** Maximum single-board length along the grain in mm (default 1200 mm). */
  maxBoardLengthMm?: number;
  /** Corner / edge joint style (default 'rabbet'). */
  jointType?: PlankJointType;
  /** Target finger/box joint tab width in mm when `jointType === 'finger'` (default 24 mm). */
  fingerWidthMm?: number;
  /** Alignment dowel diameter in mm along edge-glue & butt/rabbet seams (default 8 mm; 0 disables dowels). */
  dowelDiaMm?: number;
  /** Alignment dowel length in mm (default 30 mm). */
  dowelLengthMm?: number;
  /** Joint clearance in mm (default 0.15 mm). */
  clearanceMm?: number;
  /** Shell wall thickness in mm when `hollowInterior` is true (default 18 mm). */
  wallThicknessMm?: number;
  /** Whether to hollow out the solid's interior into a 6-sided plank shell (default true). */
  hollowInterior?: boolean;
}

export const DEFAULT_TIMBER_PLANK_OPTIONS: Required<TimberPlankOptions> = {
  boardThicknessMm: 18,
  maxBoardWidthMm: 180,
  maxBoardLengthMm: 1200,
  jointType: 'rabbet',
  fingerWidthMm: 24,
  dowelDiaMm: 8,
  dowelLengthMm: 30,
  clearanceMm: 0.15,
  wallThicknessMm: 18,
  hollowInterior: true,
};

export interface PlankDowelHole {
  centerMm: Vec3;
  axis: Vec3;
  diameterMm: number;
  depthMm: number;
}

export interface PlankJointSummary {
  neighborId: string;
  jointType: PlankJointType | 'dowel_seam' | 'length_splice';
  dowelCount: number;
  description: string;
}

export interface TimberPlank {
  index: number;
  id: string;
  name: string;
  wallFace: ShellWallFace;
  /** Finished board dimensions [lengthMm (along grain), widthMm (across grain), thicknessMm]. */
  dimensionsMm: [number, number, number];
  /** Primary wood grain axis in the root body frame ('x' | 'y' | 'z'). */
  grainAxis: GrainAxis;
  /** Outward face normal (thickness direction) in the root body frame. */
  upNormal: Vec3;
  /** Center of the plank in the root body frame, mm. */
  centerMm: Vec3;
  /** Axis-aligned bounding box in the root body frame, mm. */
  bboxMm: { min: Vec3; max: Vec3 };
  /** Exact Manifold volume of the plank (with joints and dowel holes cut), mm³. */
  volumeMm3: number;
  /**
   * Glued-assembly explosion offset vector in mm (direction and relative
   * magnitude when the assembly is pulled apart in the 3D preview).
   */
  explodedOffsetMm: Vec3;
  /** Triangle vertex positions in the root body frame, mm. */
  positionsMm: Float32Array;
  /** Triangle vertex indices. */
  faces: Uint32Array;
  /**
   * Vertex positions in metres laid flat on the Z=0 sheet plane (thickness
   * along +Z, grain along +X) for the "Plank Lay-Flat Sheet" preview mode.
   */
  layFlatPositionsM: Float32Array;
  /** 2D bounding origin [xMm, yMm, 0] on the lay-flat sheet. */
  layFlatOffsetMm: Vec3;
  /** Bounding dimensions [lengthXMm, widthYMm, thicknessZMm] when laid flat. */
  layFlatSizeMm: [number, number, number];
  /** Summary of joints and dowels connecting this plank to its neighbors. */
  joints: PlankJointSummary[];
  /** Summary string of all joints on this plank for the BOM table. */
  jointSummary: string;
  /** Individual alignment dowel holes bored into this plank. */
  dowelHoles: PlankDowelHole[];
  /** SplitSection compatible with `splitBodyForPrint` and `AssemblyPreview`. */
  section: SplitSection;
}

export interface TimberPlankBreakdownResult {
  ok: true;
  options: Required<TimberPlankOptions>;
  planks: TimberPlank[];
  sections: SplitSection[];
  totalVolumeMm3: number;
  originalVolumeMm3: number;
  hollowedVolumeMm3: number;
  layFlatSheetMm: [number, number];
  bomMarkdown: string;
  warnings: string[];
}

export type TimberPlankBreakdownOutcome =
  | TimberPlankBreakdownResult
  | { ok: false; error: string };

/** Create an axis-aligned box Manifold from [x0, y0, z0] to [x1, y1, z1] in mm. */
function aabbBoxManifold(
  wasm: ManifoldToplevel,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
): Manifold | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  if (dx <= 1e-3 || dy <= 1e-3 || dz <= 1e-3) return null;
  const cube = wasm.Manifold.cube([dx, dy, dz], false);
  const moved = cube.translate([x0, y0, z0]);
  cube.delete();
  return moved;
}

/** Build an oriented cylinder Manifold centered at `centerMm` along `axis`. */
function dowelCylinderManifold(
  wasm: ManifoldToplevel,
  centerMm: Vec3,
  axis: Vec3,
  lengthMm: number,
  radiusMm: number,
  segments = 20,
): Manifold {
  const w = unit3(axis);
  const ref: Vec3 = Math.abs(w[2]) < 0.85 ? [0, 0, 1] : [1, 0, 0];
  const u = unit3(cross3(ref, w));
  const v = unit3(cross3(w, u));
  const cyl = wasm.Manifold.cylinder(lengthMm, radiusMm, radiusMm, segments, true);
  const m: Mat4 = [
    u[0], u[1], u[2], 0,
    v[0], v[1], v[2], 0,
    w[0], w[1], w[2], 0,
    centerMm[0], centerMm[1], centerMm[2], 1,
  ];
  const out = cyl.transform(m);
  cyl.delete();
  return out;
}

/**
 * Construct the 6 hollow-shell wall templates (`-z`, `+z`, `-x`, `+x`, `-y`, `+y`)
 * over bounding box `[x0..x3] x [y0..y3] x [z0..z3]` with wall thickness `t`
 * and interlocking corner joinery (`butt`, `rabbet`, `miter`, or `finger`).
 */
function buildHollowShellWallTemplates(
  wasm: ManifoldToplevel,
  bbox: { min: Vec3; max: Vec3 },
  wallThicknessMm: number,
  jointType: PlankJointType,
  fingerWidthMm: number,
  clearanceMm: number,
): { face: ShellWallFace; label: string; normal: Vec3; grainAxis: GrainAxis; widthAxis: GrainAxis; manifold: Manifold }[] {
  const [x0, y0, z0] = bbox.min;
  const [x3, y3, z3] = bbox.max;
  const t = wallThicknessMm;
  const c = Math.max(0, Math.min(clearanceMm, t * 0.2));
  const x1 = x0 + t, x2 = x3 - t;
  const y1 = y0 + t, y2 = y3 - t;
  const z1 = z0 + t, z2 = z3 - t;

  const spanX = x3 - x0;
  const spanY = y3 - y0;
  const spanZ = z3 - z0;
  const topBotGrain: GrainAxis = spanX >= spanY ? 'x' : 'y';
  const topBotWidth: GrainAxis = spanX >= spanY ? 'y' : 'x';
  const leftRightGrain: GrainAxis = spanY >= spanZ ? 'y' : 'z';
  const leftRightWidth: GrainAxis = spanY >= spanZ ? 'z' : 'y';
  const frontBackGrain: GrainAxis = spanX >= spanZ ? 'x' : 'z';
  const frontBackWidth: GrainAxis = spanX >= spanZ ? 'z' : 'x';

  const specs: {
    face: ShellWallFace;
    label: string;
    normal: Vec3;
    grainAxis: GrainAxis;
    widthAxis: GrainAxis;
    manifold: Manifold | null;
  }[] = [
    { face: '-z', label: 'Bottom', normal: [0, 0, -1], grainAxis: topBotGrain, widthAxis: topBotWidth, manifold: null },
    { face: '+z', label: 'Top', normal: [0, 0, 1], grainAxis: topBotGrain, widthAxis: topBotWidth, manifold: null },
    { face: '-x', label: 'Left', normal: [-1, 0, 0], grainAxis: leftRightGrain, widthAxis: leftRightWidth, manifold: null },
    { face: '+x', label: 'Right', normal: [1, 0, 0], grainAxis: leftRightGrain, widthAxis: leftRightWidth, manifold: null },
    { face: '-y', label: 'Front', normal: [0, -1, 0], grainAxis: frontBackGrain, widthAxis: frontBackWidth, manifold: null },
    { face: '+y', label: 'Back', normal: [0, 1, 0], grainAxis: frontBackGrain, widthAxis: frontBackWidth, manifold: null },
  ];

  if (jointType === 'butt') {
    // Priority: Top/Bottom (-Z/+Z) cover full XY; Left/Right (-X/+X) span between Z walls and cover full Y;
    // Front/Back (-Y/+Y) fit inside both X and Z walls.
    specs[0].manifold = aabbBoxManifold(wasm, x0, x3, y0, y3, z0, z1 - c);
    specs[1].manifold = aabbBoxManifold(wasm, x0, x3, y0, y3, z2 + c, z3);
    specs[2].manifold = aabbBoxManifold(wasm, x0, x1 - c, y0, y3, z1, z2);
    specs[3].manifold = aabbBoxManifold(wasm, x2 + c, x3, y0, y3, z1, z2);
    specs[4].manifold = aabbBoxManifold(wasm, x1, x2, y0, y1 - c, z1, z2);
    specs[5].manifold = aabbBoxManifold(wasm, x1, x2, y2 + c, y3, z1, z2);
  } else if (jointType === 'rabbet') {
    // Half-lap rabbet joints on all 12 box edges:
    // - Top & Bottom have an outer lip of thickness t/2 over the full XY footprint,
    //   plus an inner plug inset by t/2 + c on all 4 sides.
    // - Left & Right reach into the Top/Bottom rabbet step by t/2 on their outer X half,
    //   and have vertical rabbet steps on their front/back edges to receive Front & Back tongues.
    const h = t * 0.5;
    const hc = c * 0.5;

    const unionBoxes = (boxes: (Manifold | null)[]): Manifold | null => {
      const valid = boxes.filter((b): b is Manifold => b !== null);
      if (!valid.length) return null;
      if (valid.length === 1) return valid[0];
      const u = wasm.Manifold.union(valid);
      for (const b of valid) b.delete();
      return u;
    };

    // Bottom (-Z)
    specs[0].manifold = unionBoxes([
      aabbBoxManifold(wasm, x0, x3, y0, y3, z0, z0 + h - hc),
      aabbBoxManifold(wasm, x0 + h + hc, x3 - h - hc, y0 + h + hc, y3 - h - hc, z0 + h - hc, z1 - c),
    ]);
    // Top (+Z)
    specs[1].manifold = unionBoxes([
      aabbBoxManifold(wasm, x0, x3, y0, y3, z3 - h + hc, z3),
      aabbBoxManifold(wasm, x0 + h + hc, x3 - h - hc, y0 + h + hc, y3 - h - hc, z2 + c, z3 - h + hc),
    ]);
    // Left (-X): outer X half [x0, x0 + h - hc] runs full Y [y0, y3] and into Top/Bottom rabbet [z0 + h + hc, z3 - h - hc];
    // inner X half [x0 + h - hc, x1 - c] is inset in Y [y0 + h + hc, y3 - h - hc] and Z [z1, z2].
    specs[2].manifold = unionBoxes([
      aabbBoxManifold(wasm, x0, x0 + h - hc, y0, y3, z0 + h + hc, z3 - h - hc),
      aabbBoxManifold(wasm, x0 + h - hc, x1 - c, y0 + h + hc, y3 - h - hc, z1, z2),
    ]);
    // Right (+X)
    specs[3].manifold = unionBoxes([
      aabbBoxManifold(wasm, x3 - h + hc, x3, y0, y3, z0 + h + hc, z3 - h - hc),
      aabbBoxManifold(wasm, x2 + c, x3 - h + hc, y0 + h + hc, y3 - h - hc, z1, z2),
    ]);
    // Front (-Y): outer Y half [y0, y0 + h - hc] reaches into Left/Right rabbet [x0 + h + hc, x3 - h - hc]
    // and Top/Bottom rabbet [z0 + h + hc, z3 - h - hc]; inner Y half fits [x1, x2] x [z1, z2].
    specs[4].manifold = unionBoxes([
      aabbBoxManifold(wasm, x0 + h + hc, x3 - h - hc, y0, y0 + h - hc, z0 + h + hc, z3 - h - hc),
      aabbBoxManifold(wasm, x1, x2, y0 + h - hc, y1 - c, z1, z2),
    ]);
    // Back (+Y)
    specs[5].manifold = unionBoxes([
      aabbBoxManifold(wasm, x0 + h + hc, x3 - h - hc, y3 - h + hc, y3, z0 + h + hc, z3 - h - hc),
      aabbBoxManifold(wasm, x1, x2, y2 + c, y3 - h + hc, z1, z2),
    ]);
  } else if (jointType === 'miter') {
    // 45° beveled miter joints across all 12 edges!
    // For each wall W, its inward depth coordinate from its inner face is u_W in [0, t]:
    //   u_-x = x1 - x,  u_+x = x - x2
    //   u_-y = y1 - y,  u_+y = y - y2
    //   u_-z = z1 - z,  u_+z = z - z2
    // A point belongs to wall W iff u_W >= u_N + c/sqrt(2) for all 4 perpendicular walls N.
    const trimPlane = (m: Manifold, normalToDiscard: Vec3, offset: number): Manifold => {
      // splitByPlane returns [first (in direction of normal), second (behind normal)].
      // Keeping `second` discards points where dot(normalToDiscard, p) > offset.
      const [front, back] = m.splitByPlane(normalToDiscard, offset);
      front.delete();
      m.delete();
      return back;
    };
    const invSqrt2 = Math.SQRT1_2;
    const gap = c * 0.5;

    // Helper: enforce u_W >= u_N + gap*sqrt(2)  <=>  (u_N - u_W)/sqrt(2) <= -gap
    // Wait: let's write each u_W in terms of distance from the OUTER corner so it's even simpler:
    // Distance from outer face of W: d_W >= 0 (e.g. d_-z = z - z0, d_+z = z3 - z, d_-x = x - x0, d_+x = x3 - x).
    // Wall W owns points closer to its outer face than to neighbor N's outer face:
    //   d_W + gap <= d_N   <=>   (d_W - d_N) * invSqrt2 <= -gap * invSqrt2.
    const cutBevel = (m: Manifold, gradDwMinusDn: Vec3, constTerm: number): Manifold => {
      // Condition to KEEP: grad · p + constTerm <= -gap
      // => dot(unitGrad, p) <= (-gap - constTerm) * invSqrt2
      const unitGrad: Vec3 = [
        gradDwMinusDn[0] * invSqrt2,
        gradDwMinusDn[1] * invSqrt2,
        gradDwMinusDn[2] * invSqrt2,
      ];
      const planeOffset = (-gap - constTerm) * invSqrt2;
      return trimPlane(m, unitGrad, planeOffset);
    };

    // d_-x = x - x0; d_+x = x3 - x; d_-y = y - y0; d_+y = y3 - y; d_-z = z - z0; d_+z = z3 - z
    // 1. Bottom (-Z): d_-z = z - z0
    let bot = aabbBoxManifold(wasm, x0, x3, y0, y3, z0, z1 - c)!;
    bot = cutBevel(bot, [-1, 0, 1], x0 - z0);   // vs -X: (z - z0) - (x - x0)
    bot = cutBevel(bot, [1, 0, 1], -z0 - x3);   // vs +X: (z - z0) - (x3 - x)
    bot = cutBevel(bot, [0, -1, 1], y0 - z0);   // vs -Y: (z - z0) - (y - y0)
    bot = cutBevel(bot, [0, 1, 1], -z0 - y3);   // vs +Y: (z - z0) - (y3 - y)
    specs[0].manifold = bot;

    // 2. Top (+Z): d_+z = z3 - z
    let top = aabbBoxManifold(wasm, x0, x3, y0, y3, z2 + c, z3)!;
    top = cutBevel(top, [-1, 0, -1], z3 + x0);  // vs -X: (z3 - z) - (x - x0)
    top = cutBevel(top, [1, 0, -1], z3 - x3);   // vs +X: (z3 - z) - (x3 - x)
    top = cutBevel(top, [0, -1, -1], z3 + y0);  // vs -Y: (z3 - z) - (y - y0)
    top = cutBevel(top, [0, 1, -1], z3 - y3);   // vs +Y: (z3 - z) - (y3 - y)
    specs[1].manifold = top;

    // 3. Left (-X): d_-x = x - x0
    let left = aabbBoxManifold(wasm, x0, x1 - c, y0, y3, z0, z3)!;
    left = cutBevel(left, [1, 0, -1], z0 - x0);  // vs -Z
    left = cutBevel(left, [1, 0, 1], -x0 - z3);  // vs +Z
    left = cutBevel(left, [1, -1, 0], y0 - x0);  // vs -Y
    left = cutBevel(left, [1, 1, 0], -x0 - y3);  // vs +Y
    specs[2].manifold = left;

    // 4. Right (+X): d_+x = x3 - x
    let right = aabbBoxManifold(wasm, x2 + c, x3, y0, y3, z0, z3)!;
    right = cutBevel(right, [-1, 0, -1], x3 + z0); // vs -Z
    right = cutBevel(right, [-1, 0, 1], x3 - z3);  // vs +Z
    right = cutBevel(right, [-1, -1, 0], x3 + y0); // vs -Y
    right = cutBevel(right, [-1, 1, 0], x3 - y3);  // vs +Y
    specs[3].manifold = right;

    // 5. Front (-Y): d_-y = y - y0
    let front = aabbBoxManifold(wasm, x0, x3, y0, y1 - c, z0, z3)!;
    front = cutBevel(front, [0, 1, -1], z0 - y0);  // vs -Z
    front = cutBevel(front, [0, 1, 1], -y0 - z3);  // vs +Z
    front = cutBevel(front, [-1, 1, 0], x0 - y0);  // vs -X
    front = cutBevel(front, [1, 1, 0], -y0 - x3);  // vs +X
    specs[4].manifold = front;

    // 6. Back (+Y): d_+y = y3 - y
    let back = aabbBoxManifold(wasm, x0, x3, y2 + c, y3, z0, z3)!;
    back = cutBevel(back, [0, -1, -1], y3 + z0);   // vs -Z
    back = cutBevel(back, [0, -1, 1], y3 - z3);    // vs +Z
    back = cutBevel(back, [-1, -1, 0], y3 + x0);   // vs -X
    back = cutBevel(back, [1, -1, 0], y3 - x3);    // vs +X
    specs[5].manifold = back;
  } else {
    // `finger` (interlocking box joints along all 12 edges):
    // Core plates fit the interior spans:
    //   Bottom (-Z): [x1, x2] x [y1, y2] x [z0, z1 - c]
    //   Top    (+Z): [x1, x2] x [y1, y2] x [z2 + c, z3]
    //   Left   (-X): [x0, x1 - c] x [y1, y2] x [z1, z2]
    //   Right  (+X): [x2 + c, x3] x [y1, y2] x [z1, z2]
    //   Front  (-Y): [x1, x2] x [y0, y1 - c] x [z1, z2]
    //   Back   (+Y): [x1, x2] x [y2 + c, y3] x [z1, z2]
    const partsByWall: Manifold[][] = [[], [], [], [], [], []];
    const addBox = (wallIdx: number, bx0: number, bx1: number, by0: number, by1: number, bz0: number, bz1: number) => {
      const b = aabbBoxManifold(wasm, bx0, bx1, by0, by1, bz0, bz1);
      if (b) partsByWall[wallIdx].push(b);
    };

    addBox(0, x1, x2, y1, y2, z0, z1 - c);
    addBox(1, x1, x2, y1, y2, z2 + c, z3);
    addBox(2, x0, x1 - c, y1, y2, z1, z2);
    addBox(3, x2 + c, x3, y1, y2, z1, z2);
    addBox(4, x1, x2, y0, y1 - c, z1, z2);
    addBox(5, x1, x2, y2 + c, y3, z1, z2);

    const oddCount = (span: number) => {
      const raw = Math.max(3, Math.round(span / Math.max(8, fingerWidthMm)));
      return raw % 2 === 1 ? raw : raw + 1;
    };

    // 4 edges along Y where Top/Bottom (0, 1) meet Left/Right (2, 3) over Y in [y0, y3]
    // Even fingers (including k=0 and k=N-1 at the 8 box vertices!) go to Top/Bottom;
    // Odd fingers go to Left/Right.
    const nY = oddCount(y3 - y0);
    const stepY = (y3 - y0) / nY;
    for (let k = 0; k < nY; k++) {
      const fy0 = y0 + k * stepY;
      const fy1 = y0 + (k + 1) * stepY;
      const isEven = k % 2 === 0;
      if (isEven) {
        // Belongs to Bottom (0) and Top (1)
        addBox(0, x0, x1, fy0, fy1, z0, z1 - c);
        addBox(0, x2, x3, fy0, fy1, z0, z1 - c);
        addBox(1, x0, x1, fy0, fy1, z2 + c, z3);
        addBox(1, x2, x3, fy0, fy1, z2 + c, z3);
      } else {
        // Belongs to Left (2) and Right (3)
        addBox(2, x0, x1 - c, fy0 + c, fy1 - c, z0, z1);
        addBox(3, x2 + c, x3, fy0 + c, fy1 - c, z0, z1);
        addBox(2, x0, x1 - c, fy0 + c, fy1 - c, z2, z3);
        addBox(3, x2 + c, x3, fy0 + c, fy1 - c, z2, z3);
      }
    }

    // 4 edges along X where Top/Bottom (0, 1) meet Front/Back (4, 5) over X in [x1, x2]
    const nX = oddCount(x2 - x1);
    const stepX = (x2 - x1) / nX;
    for (let k = 0; k < nX; k++) {
      const fx0 = x1 + k * stepX;
      const fx1 = x1 + (k + 1) * stepX;
      const isEven = k % 2 === 0;
      if (isEven) {
        addBox(0, fx0, fx1, y0, y1, z0, z1 - c);
        addBox(0, fx0, fx1, y2, y3, z0, z1 - c);
        addBox(1, fx0, fx1, y0, y1, z2 + c, z3);
        addBox(1, fx0, fx1, y2, y3, z2 + c, z3);
      } else {
        addBox(4, fx0 + c, fx1 - c, y0, y1 - c, z0, z1);
        addBox(5, fx0 + c, fx1 - c, y2 + c, y3, z0, z1);
        addBox(4, fx0 + c, fx1 - c, y0, y1 - c, z2, z3);
        addBox(5, fx0 + c, fx1 - c, y2 + c, y3, z2, z3);
      }
    }

    // 4 vertical edges along Z where Left/Right (2, 3) meet Front/Back (4, 5) over Z in [z1, z2]
    const nZ = oddCount(z2 - z1);
    const stepZ = (z2 - z1) / nZ;
    for (let k = 0; k < nZ; k++) {
      const fz0 = z1 + k * stepZ;
      const fz1 = z1 + (k + 1) * stepZ;
      const isEven = k % 2 === 0;
      if (isEven) {
        // Belongs to Left (2) and Right (3)
        addBox(2, x0, x1 - c, y0, y1, fz0, fz1);
        addBox(2, x0, x1 - c, y2, y3, fz0, fz1);
        addBox(3, x2 + c, x3, y0, y1, fz0, fz1);
        addBox(3, x2 + c, x3, y2, y3, fz0, fz1);
      } else {
        // Belongs to Front (4) and Back (5)
        addBox(4, x0, x1, y0, y1 - c, fz0 + c, fz1 - c);
        addBox(4, x2, x3, y0, y1 - c, fz0 + c, fz1 - c);
        addBox(5, x0, x1, y2 + c, y3, fz0 + c, fz1 - c);
        addBox(5, x2, x3, y2 + c, y3, fz0 + c, fz1 - c);
      }
    }

    for (let w = 0; w < 6; w++) {
      const list = partsByWall[w];
      if (list.length === 1) {
        specs[w].manifold = list[0];
      } else if (list.length > 1) {
        specs[w].manifold = wasm.Manifold.union(list);
        for (const p of list) p.delete();
      }
    }
  }

  return specs.filter((s): s is typeof s & { manifold: Manifold } => s.manifold !== null);
}

/**
 * Rotate a millimetre vertex buffer so the plank lies flat on the Z=0 plane:
 *   - `upNormal` -> +Z (thickness axis, Z in [0..thickness])
 *   - `grainAxis` -> +X (length axis, X in [0..length])
 *   - perpendicular width axis -> +Y (width axis, Y in [0..width])
 */
function buildLayFlatMesh(
  positionsMm: Float32Array,
  grainAxis: GrainAxis,
  upNormal: Vec3,
): { flatPositionsMm: Float32Array; sizeMm: [number, number, number] } {
  const w = unit3(upNormal);
  const grainVec: Vec3 =
    grainAxis === 'x' ? [1, 0, 0] : grainAxis === 'y' ? [0, 1, 0] : [0, 0, 1];
  // Project grainVec perpendicular to w
  const dotGW = dot3(grainVec, w);
  let u: Vec3 = [
    grainVec[0] - dotGW * w[0],
    grainVec[1] - dotGW * w[1],
    grainVec[2] - dotGW * w[2],
  ];
  if (Math.hypot(u[0], u[1], u[2]) < 1e-3) {
    u = Math.abs(w[0]) < 0.85 ? unit3(cross3([1, 0, 0], w)) : unit3(cross3([0, 1, 0], w));
  } else {
    u = unit3(u);
  }
  const v = unit3(cross3(w, u));

  const out = new Float32Array(positionsMm.length);
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < positionsMm.length; i += 3) {
    const px = positionsMm[i], py = positionsMm[i + 1], pz = positionsMm[i + 2];
    const rx = px * u[0] + py * u[1] + pz * u[2];
    const ry = px * v[0] + py * v[1] + pz * v[2];
    const rz = px * w[0] + py * w[1] + pz * w[2];
    out[i] = rx;
    out[i + 1] = ry;
    out[i + 2] = rz;
    if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
    if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
    if (rz < minZ) minZ = rz; if (rz > maxZ) maxZ = rz;
  }

  for (let i = 0; i < out.length; i += 3) {
    out[i] -= minX;
    out[i + 1] -= minY;
    out[i + 2] -= minZ;
  }

  return {
    flatPositionsMm: out,
    sizeMm: [
      Math.max(0.1, +(maxX - minX).toFixed(1)),
      Math.max(0.1, +(maxY - minY).toFixed(1)),
      Math.max(0.1, +(maxZ - minZ).toFixed(1)),
    ],
  };
}

/**
 * Decompose one or more solid triangle soups (in metres) into machinable timber
 * planks with interlocking `rabbet`, `miter`, `finger`, or `butt` joinery,
 * alignment dowel holes, explosion vectors, and a 2D Lay-Flat Sheet layout.
 */
export function decomposeSolidIntoPlanks(
  wasm: ManifoldToplevel,
  soupsMetres: ArrayLike<number>[],
  rawOptions: TimberPlankOptions = {},
): TimberPlankBreakdownOutcome {
  const options: Required<TimberPlankOptions> = {
    ...DEFAULT_TIMBER_PLANK_OPTIONS,
    ...Object.fromEntries(Object.entries(rawOptions).filter(([, v]) => v !== undefined)),
  };
  options.boardThicknessMm = Math.max(4, options.boardThicknessMm);
  options.wallThicknessMm = Math.max(4, rawOptions.wallThicknessMm ?? options.boardThicknessMm);
  options.maxBoardWidthMm = Math.max(20, options.maxBoardWidthMm);
  options.maxBoardLengthMm = Math.max(40, options.maxBoardLengthMm);
  options.fingerWidthMm = Math.max(8, options.fingerWidthMm);
  options.dowelDiaMm = Math.max(0, options.dowelDiaMm);
  options.dowelLengthMm = Math.max(10, options.dowelLengthMm);
  options.clearanceMm = Math.max(0, Math.min(2, options.clearanceMm));

  const inputManifolds: Manifold[] = [];
  for (const soup of soupsMetres) {
    const m = soupToManifoldMm(wasm, soup);
    if (m) inputManifolds.push(m);
  }
  if (!inputManifolds.length) {
    return { ok: false, error: 'Selected body has no valid watertight 3D solid geometry to decompose into timber planks.' };
  }

  const outerSolid =
    inputManifolds.length === 1 ? inputManifolds[0] : wasm.Manifold.union(inputManifolds);
  if (inputManifolds.length > 1) {
    for (const m of inputManifolds) m.delete();
  }

  const warnings: string[] = [];
  const originalVolumeMm3 = outerSolid.volume();
  const bbox = outerSolid.boundingBox();
  const spanX = bbox.max[0] - bbox.min[0];
  const spanY = bbox.max[1] - bbox.min[1];
  const spanZ = bbox.max[2] - bbox.min[2];
  const assemblyCenterMm: Vec3 = [
    0.5 * (bbox.min[0] + bbox.max[0]),
    0.5 * (bbox.min[1] + bbox.max[1]),
    0.5 * (bbox.min[2] + bbox.max[2]),
  ];

  interface RawPlankItem {
    id: string;
    name: string;
    wallFace: ShellWallFace;
    upNormal: Vec3;
    grainAxis: GrainAxis;
    widthAxis: GrainAxis;
    solid: Manifold;
    joints: PlankJointSummary[];
  }

  const rawPlanks: RawPlankItem[] = [];
  let hollowedVolumeMm3 = 0;

  try {
    const wallT = options.wallThicknessMm;
    const canHollow =
      options.hollowInterior &&
      spanX > 2 * wallT + 8 &&
      spanY > 2 * wallT + 8 &&
      spanZ > 2 * wallT + 8;

    if (options.hollowInterior && !canHollow) {
      warnings.push(
        `Part (${Math.round(spanX)}×${Math.round(spanY)}×${Math.round(spanZ)} mm) is too thin for a ${wallT} mm hollow shell; using laminated board layers instead.`,
      );
    }

    const axisIdx = (a: GrainAxis): 0 | 1 | 2 => (a === 'x' ? 0 : a === 'y' ? 1 : 2);
    const axisVec = (a: GrainAxis): Vec3 => (a === 'x' ? [1, 0, 0] : a === 'y' ? [0, 1, 0] : [0, 0, 1]);

    // Helper: subdivide a wall/layer Manifold across `widthAxis` (maxBoardWidthMm)
    // and along `grainAxis` (maxBoardLengthMm), recording seam pairs for dowel boring.
    const subdivideIntoPlanks = (
      wallSolid: Manifold,
      baseId: string,
      baseLabel: string,
      wallFace: ShellWallFace,
      upNormal: Vec3,
      grainAxis: GrainAxis,
      widthAxis: GrainAxis,
      cornerJoints: PlankJointSummary[],
    ) => {
      const wBox = wallSolid.boundingBox();
      const wIdx = axisIdx(widthAxis);
      const gIdx = axisIdx(grainAxis);
      const wLo = wBox.min[wIdx], wHi = wBox.max[wIdx];
      const gLo = wBox.min[gIdx], gHi = wBox.max[gIdx];
      const wSpan = wHi - wLo;
      const gSpan = gHi - gLo;

      const nW = Math.max(1, Math.ceil((wSpan - 0.5) / options.maxBoardWidthMm));
      const nG = Math.max(1, Math.ceil((gSpan - 0.5) / options.maxBoardLengthMm));
      const stepW = wSpan / nW;
      const stepG = gSpan / nG;
      const c = options.clearanceMm;

      if (nW > 1) {
        warnings.push(
          `${baseLabel} (${Math.round(wSpan)} mm wide) exceeds max board width (${options.maxBoardWidthMm} mm) -> split into ${nW} planks.`,
        );
      }
      if (nG > 1) {
        warnings.push(
          `${baseLabel} (${Math.round(gSpan)} mm long) exceeds max board length (${options.maxBoardLengthMm} mm) -> spliced into ${nG} lengths.`,
        );
      }

      for (let iw = 0; iw < nW; iw++) {
        for (let ig = 0; ig < nG; ig++) {
          const cutW0 = wLo + iw * stepW + (iw > 0 ? c * 0.5 : -2);
          const cutW1 = wLo + (iw + 1) * stepW - (iw + 1 < nW ? c * 0.5 : -2);
          const cutG0 = gLo + ig * stepG + (ig > 0 ? c * 0.5 : -2);
          const cutG1 = gLo + (ig + 1) * stepG - (ig + 1 < nG ? c * 0.5 : -2);

          const clipMin: Vec3 = [wBox.min[0] - 2, wBox.min[1] - 2, wBox.min[2] - 2];
          const clipMax: Vec3 = [wBox.max[0] + 2, wBox.max[1] + 2, wBox.max[2] + 2];
          clipMin[wIdx] = cutW0;
          clipMax[wIdx] = cutW1;
          clipMin[gIdx] = cutG0;
          clipMax[gIdx] = cutG1;

          const clipBox = aabbBoxManifold(
            wasm,
            clipMin[0], clipMax[0],
            clipMin[1], clipMax[1],
            clipMin[2], clipMax[2],
          );
          if (!clipBox) continue;
          const piece = wallSolid.intersect(clipBox);
          clipBox.delete();

          if (piece.isEmpty() || piece.volume() < 10) {
            piece.delete();
            continue;
          }

          const suffix =
            nW === 1 && nG === 1
              ? ''
              : nG === 1
                ? `_${iw + 1}`
                : `_${iw + 1}_${ig + 1}`;
          const id = `${baseId}${suffix}`;
          const name =
            nW === 1 && nG === 1
              ? `${baseLabel} Plank`
              : `${baseLabel} Plank ${iw + 1}${nG > 1 ? `.${ig + 1}` : ''}`;

          rawPlanks.push({
            id,
            name,
            wallFace,
            upNormal,
            grainAxis,
            widthAxis,
            solid: piece,
            joints: cornerJoints.map((j) => ({ ...j })),
          });
        }
      }
    };

    if (canHollow) {
      // Subtract interior void core
      const innerVoid = aabbBoxManifold(
        wasm,
        bbox.min[0] + wallT, bbox.max[0] - wallT,
        bbox.min[1] + wallT, bbox.max[1] - wallT,
        bbox.min[2] + wallT, bbox.max[2] - wallT,
      );
      let shellSolid = outerSolid;
      if (innerVoid) {
        const VoidInter = outerSolid.intersect(innerVoid);
        hollowedVolumeMm3 = VoidInter.volume();
        VoidInter.delete();
        shellSolid = outerSolid.subtract(innerVoid);
        innerVoid.delete();
      }

      const templates = buildHollowShellWallTemplates(
        wasm,
        bbox,
        wallT,
        options.jointType,
        options.fingerWidthMm,
        options.clearanceMm,
      );

      for (const tmpl of templates) {
        const wallPiece = shellSolid.intersect(tmpl.manifold);
        tmpl.manifold.delete();
        if (wallPiece.isEmpty() || wallPiece.volume() < 10) {
          wallPiece.delete();
          continue;
        }
        const cornerJoints: PlankJointSummary[] = [
          {
            neighborId: 'Adjacent Shell Walls',
            jointType: options.jointType,
            dowelCount: 0,
            description: `${options.jointType.toUpperCase()} corner joints on perimeter edges`,
          },
        ];
        subdivideIntoPlanks(
          wallPiece,
          `Plank_${tmpl.label}`,
          `${tmpl.label} Wall`,
          tmpl.face,
          tmpl.normal,
          tmpl.grainAxis,
          tmpl.widthAxis,
          cornerJoints,
        );
        wallPiece.delete();
      }

      if (shellSolid !== outerSolid) shellSolid.delete();
    } else {
      // Solid laminated layer breakdown along Z (or thinnest axis)
      const boardT = options.boardThicknessMm;
      const nLayers = Math.max(1, Math.ceil((spanZ - 0.2) / boardT));
      const c = options.clearanceMm;
      const grainAxis: GrainAxis = spanX >= spanY ? 'x' : 'y';
      const widthAxis: GrainAxis = spanX >= spanY ? 'y' : 'x';

      for (let iz = 0; iz < nLayers; iz++) {
        const z0 = bbox.min[2] + iz * boardT + (iz > 0 ? c * 0.5 : -1);
        const z1 = Math.min(bbox.max[2] + 1, bbox.min[2] + (iz + 1) * boardT - (iz + 1 < nLayers ? c * 0.5 : -1));
        const slab = aabbBoxManifold(
          wasm,
          bbox.min[0] - 2, bbox.max[0] + 2,
          bbox.min[1] - 2, bbox.max[1] + 2,
          z0, z1,
        );
        if (!slab) continue;
        const layerSolid = outerSolid.intersect(slab);
        slab.delete();
        if (layerSolid.isEmpty() || layerSolid.volume() < 10) {
          layerSolid.delete();
          continue;
        }
        const layerJoints: PlankJointSummary[] =
          nLayers > 1
            ? [
                {
                  neighborId: iz > 0 ? `Layer_${iz}` : `Layer_${iz + 2}`,
                  jointType: options.jointType,
                  dowelCount: 0,
                  description: `Laminated face glue-up (${options.jointType})`,
                },
              ]
            : [];
        subdivideIntoPlanks(
          layerSolid,
          `Layer_${iz + 1}_Plank`,
          `Layer ${iz + 1}`,
          'layer',
          [0, 0, 1],
          grainAxis,
          widthAxis,
          layerJoints,
        );
        layerSolid.delete();
      }
    }

    if (!rawPlanks.length) {
      return { ok: false, error: 'No timber planks could be extracted with the current board dimensions.' };
    }

    // -------------------------------------------------------------------------
    // Bore Alignment Dowel Holes (`dowelDiaMm > 0`) between Adjacent Planks
    // -------------------------------------------------------------------------
    const dowelsByPlank: PlankDowelHole[][] = rawPlanks.map(() => []);
    if (options.dowelDiaMm > 0) {
      const holeRadius = (options.dowelDiaMm + options.clearanceMm) * 0.5;
      const halfDepth = options.dowelLengthMm * 0.5 + 1.0;

      for (let i = 0; i < rawPlanks.length; i++) {
        for (let j = i + 1; j < rawPlanks.length; j++) {
          const pA = rawPlanks[i];
          const pB = rawPlanks[j];
          const boxA = pA.solid.boundingBox();
          const boxB = pB.solid.boundingBox();

          // Check if pA and pB share an edge-glue seam in the same wall/layer
          // OR meet at a butt/rabbet corner seam.
          const overlapX = Math.min(boxA.max[0], boxB.max[0]) - Math.max(boxA.min[0], boxB.min[0]);
          const overlapY = Math.min(boxA.max[1], boxB.max[1]) - Math.max(boxA.min[1], boxB.min[1]);
          const overlapZ = Math.min(boxA.max[2], boxB.max[2]) - Math.max(boxA.min[2], boxB.min[2]);

          // Find which axis is the contact normal (small gap/overlap: -2.0 .. +wallT)
          // while the other two axes have positive overlap
          let seamAxis: 0 | 1 | 2 | null = null;
          let longAxis: 0 | 1 | 2 = 0;
          let thickAxis: 0 | 1 | 2 = 2;

          if (pA.wallFace === pB.wallFace) {
            // Same wall or layer: edge seam across widthAxis
            const wIdx = axisIdx(pA.widthAxis);
            const gIdx = axisIdx(pA.grainAxis);
            const tIdx = ([0, 1, 2].find((k) => k !== wIdx && k !== gIdx) ?? 2) as 0 | 1 | 2;
            const gapW = Math.max(boxA.min[wIdx] - boxB.max[wIdx], boxB.min[wIdx] - boxA.max[wIdx]);
            const sharedG = Math.min(boxA.max[gIdx], boxB.max[gIdx]) - Math.max(boxA.min[gIdx], boxB.min[gIdx]);
            const sharedT = Math.min(boxA.max[tIdx], boxB.max[tIdx]) - Math.max(boxA.min[tIdx], boxB.min[tIdx]);
            if (gapW <= 2.5 && sharedG >= options.dowelDiaMm * 3 && sharedT >= options.dowelDiaMm + 3) {
              seamAxis = wIdx;
              longAxis = gIdx;
              thickAxis = tIdx;
            }
          } else if (options.jointType === 'butt' || options.jointType === 'rabbet') {
            // Corner or layer contact between two perpendicular walls or stacked layers
            const overlaps = [overlapX, overlapY, overlapZ];
            for (const cand of [0, 1, 2] as const) {
              const o1 = ((cand + 1) % 3) as 0 | 1 | 2;
              const o2 = ((cand + 2) % 3) as 0 | 1 | 2;
              if (
                overlaps[cand] >= -2.0 &&
                overlaps[cand] <= options.wallThicknessMm + 1 &&
                overlaps[o1] >= options.dowelDiaMm + 3 &&
                overlaps[o2] >= options.dowelDiaMm + 3 &&
                Math.max(overlaps[o1], overlaps[o2]) >= options.dowelDiaMm * 3
              ) {
                seamAxis = cand;
                longAxis = overlaps[o1] >= overlaps[o2] ? o1 : o2;
                thickAxis = overlaps[o1] >= overlaps[o2] ? o2 : o1;
                break;
              }
            }
          }

          if (seamAxis === null) continue;

          // Contact plane coordinate along seamAxis
          const seamCoord =
            boxA.max[seamAxis] <= boxB.min[seamAxis] + options.wallThicknessMm
              ? 0.5 * (boxA.max[seamAxis] + boxB.min[seamAxis])
              : 0.5 * (boxB.max[seamAxis] + boxA.min[seamAxis]);
          const longLo = Math.max(boxA.min[longAxis], boxB.min[longAxis]);
          const longHi = Math.min(boxA.max[longAxis], boxB.max[longAxis]);
          const thickMid = 0.5 * (
            Math.max(boxA.min[thickAxis], boxB.min[thickAxis]) +
            Math.min(boxA.max[thickAxis], boxB.max[thickAxis])
          );
          const spanLong = longHi - longLo;
          const nDowels = spanLong >= 160 ? 3 : 2;
          const dowelAxis: Vec3 = [0, 0, 0];
          dowelAxis[seamAxis] = boxB.min[seamAxis] + boxB.max[seamAxis] >= boxA.min[seamAxis] + boxA.max[seamAxis] ? 1 : -1;

          let boredCount = 0;
          for (let d = 0; d < nDowels; d++) {
            const frac = nDowels === 2 ? (d === 0 ? 0.28 : 0.72) : (d === 0 ? 0.2 : d === 1 ? 0.5 : 0.8);
            const pt: Vec3 = [0, 0, 0];
            pt[seamAxis] = seamCoord;
            pt[longAxis] = longLo + frac * spanLong;
            pt[thickAxis] = thickMid;

            const cyl = dowelCylinderManifold(wasm, pt, dowelAxis, halfDepth * 2, holeRadius, 20);
            const nextA = pA.solid.subtract(cyl);
            const nextB = pB.solid.subtract(cyl);
            cyl.delete();
            pA.solid.delete();
            pB.solid.delete();
            pA.solid = nextA;
            pB.solid = nextB;

            dowelsByPlank[i].push({
              centerMm: pt,
              axis: dowelAxis,
              diameterMm: options.dowelDiaMm,
              depthMm: +(halfDepth - 1).toFixed(1),
            });
            dowelsByPlank[j].push({
              centerMm: pt,
              axis: [-dowelAxis[0], -dowelAxis[1], -dowelAxis[2]],
              diameterMm: options.dowelDiaMm,
              depthMm: +(halfDepth - 1).toFixed(1),
            });
            boredCount++;
          }

          if (boredCount > 0) {
            pA.joints.push({
              neighborId: pB.id,
              jointType: pA.wallFace === pB.wallFace ? 'dowel_seam' : options.jointType,
              dowelCount: boredCount,
              description: `${boredCount}× Ø${options.dowelDiaMm} mm alignment dowels to ${pB.id}`,
            });
            pB.joints.push({
              neighborId: pA.id,
              jointType: pA.wallFace === pB.wallFace ? 'dowel_seam' : options.jointType,
              dowelCount: boredCount,
              description: `${boredCount}× Ø${options.dowelDiaMm} mm alignment dowels to ${pA.id}`,
            });
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // Package TimberPlanks, Explosion Offsets & 2D Lay-Flat Sheet Packing
    // -------------------------------------------------------------------------
    const planks: TimberPlank[] = [];
    const sections: SplitSection[] = [];
    let totalVolumeMm3 = 0;

    // 2D shelf packing state for the Lay-Flat Sheet view
    const SHEET_GAP_MM = 18;
    const targetRowWidthMm = Math.max(
      400,
      Math.min(1800, rawPlanks.reduce((acc, p) => {
        const b = p.solid.boundingBox();
        return acc + Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
      }, 0) * 0.55),
    );
    let cursorXMm = 0;
    let cursorYMm = 0;
    let rowMaxHeightYMm = 0;
    let maxSheetXMm = 0;

    for (let i = 0; i < rawPlanks.length; i++) {
      const rp = rawPlanks[i];
      const mesh = manifoldToMeshMm(rp.solid);
      totalVolumeMm3 += mesh.volumeMm3;

      const pBox = rp.solid.boundingBox();
      const centerMm: Vec3 = [
        +(0.5 * (pBox.min[0] + pBox.max[0])).toFixed(2),
        +(0.5 * (pBox.min[1] + pBox.max[1])).toFixed(2),
        +(0.5 * (pBox.min[2] + pBox.max[2])).toFixed(2),
      ];

      // Measure dimensions along grainAxis, widthAxis, and thickness axis
      const gIdx = axisIdx(rp.grainAxis);
      const wIdx = axisIdx(rp.widthAxis);
      const tIdx = ([0, 1, 2].find((k) => k !== gIdx && k !== wIdx) ?? 2) as 0 | 1 | 2;
      const spans = [
        pBox.max[0] - pBox.min[0],
        pBox.max[1] - pBox.min[1],
        pBox.max[2] - pBox.min[2],
      ];
      const dimensionsMm: [number, number, number] = [
        Math.max(0.1, +spans[gIdx].toFixed(1)),
        Math.max(0.1, +spans[wIdx].toFixed(1)),
        Math.max(0.1, +spans[tIdx].toFixed(1)),
      ];

      // Compute outward explosion vector `explodedOffsetMm`:
      // Combines the wall's outward normal with a small tangential spread from
      // the assembly center so side-by-side planks in the same wall also separate!
      const radial: Vec3 = [
        centerMm[0] - assemblyCenterMm[0],
        centerMm[1] - assemblyCenterMm[1],
        centerMm[2] - assemblyCenterMm[2],
      ];
      const radialLen = Math.hypot(radial[0], radial[1], radial[2]) || 1;
      const radialUnit: Vec3 = [radial[0] / radialLen, radial[1] / radialLen, radial[2] / radialLen];
      const explodeDir = unit3([
        rp.upNormal[0] * 0.75 + radialUnit[0] * 0.55,
        rp.upNormal[1] * 0.75 + radialUnit[1] * 0.55,
        rp.upNormal[2] * 0.75 + radialUnit[2] * 0.55,
      ]);
      const explodedOffsetMm: Vec3 = [
        +(explodeDir[0] * 45).toFixed(2),
        +(explodeDir[1] * 45).toFixed(2),
        +(explodeDir[2] * 45).toFixed(2),
      ];

      // Lay-flat mesh on Z=0 plane
      const { flatPositionsMm, sizeMm: layFlatSizeMm } = buildLayFlatMesh(
        mesh.positionsMm,
        rp.grainAxis,
        rp.upNormal,
      );
      if (cursorXMm > 0 && cursorXMm + layFlatSizeMm[0] > targetRowWidthMm) {
        cursorXMm = 0;
        cursorYMm += rowMaxHeightYMm + SHEET_GAP_MM;
        rowMaxHeightYMm = 0;
      }
      const layFlatOffsetMm: Vec3 = [cursorXMm, cursorYMm, 0];
      cursorXMm += layFlatSizeMm[0] + SHEET_GAP_MM;
      if (cursorXMm - SHEET_GAP_MM > maxSheetXMm) maxSheetXMm = cursorXMm - SHEET_GAP_MM;
      if (layFlatSizeMm[1] > rowMaxHeightYMm) rowMaxHeightYMm = layFlatSizeMm[1];

      const layFlatPositionsM = new Float32Array(flatPositionsMm.length);
      for (let k = 0; k < flatPositionsMm.length; k += 3) {
        layFlatPositionsM[k] = (flatPositionsMm[k] + layFlatOffsetMm[0]) / MM;
        layFlatPositionsM[k + 1] = (flatPositionsMm[k + 1] + layFlatOffsetMm[1]) / MM;
        layFlatPositionsM[k + 2] = (flatPositionsMm[k + 2] + layFlatOffsetMm[2]) / MM;
      }

      const positionsM = new Float32Array(mesh.positionsMm.length);
      for (let k = 0; k < mesh.positionsMm.length; k++) {
        positionsM[k] = mesh.positionsMm[k] / MM;
      }

      const hull = rp.solid.hull();
      const solidity = Math.min(1, mesh.volumeMm3 / Math.max(1e-6, hull.volume()));
      hull.delete();

      const features: JoineryFeature[] = dowelsByPlank[i].map((dh, dIdx) => ({
        kind: 'bore' as const,
        at: [dh.centerMm[0] / MM, dh.centerMm[1] / MM, dh.centerMm[2] / MM],
        axis: dh.axis,
        radius: (dh.diameterMm * 0.5) / MM,
        depth: dh.depthMm / MM,
        joint: dIdx,
      }));
      const colliders: FeatureCollider[] = [];

      const section: SplitSection = {
        positions: positionsM,
        faces: mesh.faces,
        plainPositions: positionsM,
        plainFaces: mesh.faces,
        up: rp.upNormal,
        spin: 0,
        supportMm2: 0,
        sizeMm: dimensionsMm,
        fits: true,
        volumeMm3: mesh.volumeMm3,
        features,
        colliders,
        solidity,
        convexPieces: [{ positions: positionsM, faces: mesh.faces }],
        explode: explodeDir,
      };

      const totalDowels = dowelsByPlank[i].length;
      const jointSummary =
        rp.joints.length > 0
          ? `${options.jointType.toUpperCase()}${totalDowels > 0 ? ` + ${totalDowels}× Ø${options.dowelDiaMm}mm dowels` : ''}`
          : options.jointType.toUpperCase();

      void axisVec;
      sections.push(section);
      planks.push({
        index: i,
        id: rp.id,
        name: rp.name,
        wallFace: rp.wallFace,
        dimensionsMm,
        grainAxis: rp.grainAxis,
        upNormal: rp.upNormal,
        centerMm,
        bboxMm: { min: pBox.min as Vec3, max: pBox.max as Vec3 },
        volumeMm3: +mesh.volumeMm3.toFixed(1),
        explodedOffsetMm,
        positionsMm: mesh.positionsMm,
        faces: mesh.faces,
        layFlatPositionsM,
        layFlatOffsetMm,
        layFlatSizeMm,
        joints: rp.joints,
        jointSummary,
        dowelHoles: dowelsByPlank[i],
        section,
      });
    }

    const totalSheetYMm = cursorYMm + rowMaxHeightYMm;
    // Recenter layFlatPositionsM around (0, 0, 0) in X and Y so AssemblyPreview frames the sheet cleanly
    const sheetCenterX = (maxSheetXMm * 0.5) / MM;
    const sheetCenterY = (totalSheetYMm * 0.5) / MM;
    for (const p of planks) {
      for (let k = 0; k < p.layFlatPositionsM.length; k += 3) {
        p.layFlatPositionsM[k] -= sheetCenterX;
        p.layFlatPositionsM[k + 1] -= sheetCenterY;
      }
    }

    const totalDowelPins = Math.round(
      planks.reduce((acc, p) => acc + p.dowelHoles.length, 0) * 0.5,
    );

    const bomLines: string[] = [
      `# Timber Plank Breakdown & Bill of Materials`,
      ``,
      `- **Joint Style:** ${options.jointType.toUpperCase()}${options.jointType === 'finger' ? ` (${options.fingerWidthMm} mm fingers)` : ''}`,
      `- **Construction:** ${canHollow ? `Hollow 6-Wall Shell (${options.wallThicknessMm} mm walls)` : `Solid Laminated Planks (${options.boardThicknessMm} mm layers)`}`,
      `- **Max Board Stock:** ${options.boardThicknessMm} mm thick × ${options.maxBoardWidthMm} mm wide × ${options.maxBoardLengthMm} mm long`,
      `- **Alignment Dowels:** ${options.dowelDiaMm > 0 ? `${totalDowelPins}× Ø${options.dowelDiaMm}×${options.dowelLengthMm} mm fluted beech/birch dowels` : 'None'}`,
      `- **Total Planks:** ${planks.length} (${(totalVolumeMm3 / 1000).toFixed(1)} cm³ timber)`,
      ``,
      `## Per-Plank Cut List`,
      ``,
      `| # | Plank ID | Name | Length × Width × Thick (mm) | Grain | Volume (cm³) | Joinery Summary |`,
      `|---|----------|------|-----------------------------|-------|--------------|-----------------|`,
      ...planks.map(
        (p) =>
          `| ${p.index + 1} | \`${p.id}\` | ${p.name} | ${p.dimensionsMm[0]} × ${p.dimensionsMm[1]} × ${p.dimensionsMm[2]} | ${p.grainAxis.toUpperCase()}-axis | ${(p.volumeMm3 / 1000).toFixed(1)} | ${p.jointSummary} |`,
      ),
      ``,
    ];

    return {
      ok: true,
      options,
      planks,
      sections,
      totalVolumeMm3: +totalVolumeMm3.toFixed(1),
      originalVolumeMm3: +originalVolumeMm3.toFixed(1),
      hollowedVolumeMm3: +hollowedVolumeMm3.toFixed(1),
      layFlatSheetMm: [+maxSheetXMm.toFixed(1), +totalSheetYMm.toFixed(1)],
      bomMarkdown: bomLines.join('\n'),
      warnings,
    };
  } finally {
    for (const rp of rawPlanks) rp.solid.delete();
    outerSolid.delete();
  }
}

/**
 * Serialize a triangle mesh (positions in millimetres, 0-based triangle indices)
 * into a standard binary STL byte buffer.
 */
export function meshToBinaryStl(
  positionsMm: Float32Array,
  faces: Uint32Array,
  headerLabel = 'physbox-timber-plank',
): Uint8Array {
  const triCount = Math.floor(faces.length / 3);
  const byteLength = 84 + triCount * 50;
  const buffer = new ArrayBuffer(byteLength);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  const headerText = headerLabel.slice(0, 79);
  for (let i = 0; i < headerText.length; i++) {
    bytes[i] = headerText.charCodeAt(i) & 0x7f;
  }
  view.setUint32(80, triCount, true);

  for (let t = 0; t < triCount; t++) {
    const i0 = faces[t * 3] * 3;
    const i1 = faces[t * 3 + 1] * 3;
    const i2 = faces[t * 3 + 2] * 3;

    const x0 = positionsMm[i0], y0 = positionsMm[i0 + 1], z0 = positionsMm[i0 + 2];
    const x1 = positionsMm[i1], y1 = positionsMm[i1 + 1], z1 = positionsMm[i1 + 2];
    const x2 = positionsMm[i2], y2 = positionsMm[i2 + 1], z2 = positionsMm[i2 + 2];

    const ux = x1 - x0, uy = y1 - y0, uz = z1 - z0;
    const vx = x2 - x0, vy = y2 - y0, vz = z2 - z0;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const nLen = Math.hypot(nx, ny, nz) || 1;

    const offset = 84 + t * 50;
    view.setFloat32(offset, nx / nLen, true);
    view.setFloat32(offset + 4, ny / nLen, true);
    view.setFloat32(offset + 8, nz / nLen, true);

    view.setFloat32(offset + 12, x0, true);
    view.setFloat32(offset + 16, y0, true);
    view.setFloat32(offset + 20, z0, true);

    view.setFloat32(offset + 24, x1, true);
    view.setFloat32(offset + 28, y1, true);
    view.setFloat32(offset + 32, z1, true);

    view.setFloat32(offset + 36, x2, true);
    view.setFloat32(offset + 40, y2, true);
    view.setFloat32(offset + 44, z2, true);
    view.setUint16(offset + 48, 0, true);
  }

  return bytes;
}

/**
 * Build a standalone single-node `SceneGraph` containing a single timber plank
 * or joinery member laid flat (thickness along +Z, grain along +X) and centered
 * at the origin, ready to hand straight to `ExportSolidMachiningModal`.
 */
export function buildSinglePlankScene(
  baseScene: SceneGraph,
  part: {
    id: string;
    name: string;
    positionsMm: Float32Array;
    faces: Uint32Array;
    grainAxis: GrainAxis;
    upNormal: Vec3;
  },
): { scene: SceneGraph; sizeMm: [number, number, number] } {
  const { flatPositionsMm, sizeMm } = buildLayFlatMesh(
    part.positionsMm,
    part.grainAxis,
    part.upNormal,
  );
  const cx = sizeMm[0] * 0.5;
  const cy = sizeMm[1] * 0.5;
  const cz = sizeMm[2] * 0.5;

  const renderVertices = new Array<number>(flatPositionsMm.length);
  const vertices = new Array<number>(flatPositionsMm.length);
  for (let i = 0; i < flatPositionsMm.length; i += 3) {
    const rx = (flatPositionsMm[i] - cx) / MM;
    const ry = (flatPositionsMm[i + 1] - cy) / MM;
    const rz = (flatPositionsMm[i + 2] - cz) / MM;
    renderVertices[i] = rx;
    renderVertices[i + 1] = ry;
    renderVertices[i + 2] = rz;
    vertices[i] = rx;
    vertices[i + 1] = rz;
    vertices[i + 2] = -ry;
  }

  const node: SceneNode = {
    id: part.id,
    name: part.name || part.id,
    pos: [0, 0, sizeMm[2] / (2 * MM)],
    joints: [],
    geoms: [
      {
        name: `${part.id}_mesh`,
        type: 'mesh',
        size: [1],
        rgba: [0.78, 0.56, 0.34, 1],
        dynamic: false,
        vertices,
        renderVertices,
        faces: Array.from(part.faces),
      },
    ],
    children: [],
  };

  return {
    scene: {
      ...baseScene,
      nodes: [node],
    },
    sizeMm,
  };
}

/**
 * Pack an array of parts (each with `positions` in metres, `upNormal`, and a
 * dominant `grainAxis` or length vector) onto a 2D Lay-Flat Sheet (Z = 0..thickness)
 * centered at the origin in metres, for 3D Lay-Flat Sheet previewing.
 */
export function packPartsLayFlatMetres(
  parts: {
    positionsM: Float32Array;
    upNormal: Vec3;
    grainAxis: GrainAxis;
  }[],
): { layFlatPositionsM: Float32Array[]; sheetSizeMm: [number, number] } {
  if (!parts.length) return { layFlatPositionsM: [], sheetSizeMm: [0, 0] };

  const flatMeshes = parts.map((p) => {
    const posMm = new Float32Array(p.positionsM.length);
    for (let i = 0; i < p.positionsM.length; i++) posMm[i] = p.positionsM[i] * MM;
    return buildLayFlatMesh(posMm, p.grainAxis, p.upNormal);
  });

  const SHEET_GAP_MM = 18;
  const totalLengths = flatMeshes.reduce((s, m) => s + m.sizeMm[0], 0);
  const targetRowWidthMm = Math.max(400, Math.min(1800, totalLengths * 0.55));
  let cursorXMm = 0;
  let cursorYMm = 0;
  let rowMaxHeightYMm = 0;
  let maxSheetXMm = 0;

  const offsets: Vec3[] = [];
  for (const fm of flatMeshes) {
    if (cursorXMm > 0 && cursorXMm + fm.sizeMm[0] > targetRowWidthMm) {
      cursorXMm = 0;
      cursorYMm += rowMaxHeightYMm + SHEET_GAP_MM;
      rowMaxHeightYMm = 0;
    }
    offsets.push([cursorXMm, cursorYMm, 0]);
    cursorXMm += fm.sizeMm[0] + SHEET_GAP_MM;
    if (cursorXMm - SHEET_GAP_MM > maxSheetXMm) maxSheetXMm = cursorXMm - SHEET_GAP_MM;
    if (fm.sizeMm[1] > rowMaxHeightYMm) rowMaxHeightYMm = fm.sizeMm[1];
  }

  const totalSheetYMm = cursorYMm + rowMaxHeightYMm;
  const centerXMm = maxSheetXMm * 0.5;
  const centerYMm = totalSheetYMm * 0.5;

  const layFlatPositionsM = flatMeshes.map((fm, idx) => {
    const [ox, oy, oz] = offsets[idx];
    const buf = new Float32Array(fm.flatPositionsMm.length);
    for (let i = 0; i < fm.flatPositionsMm.length; i += 3) {
      buf[i] = (fm.flatPositionsMm[i] + ox - centerXMm) / MM;
      buf[i + 1] = (fm.flatPositionsMm[i + 1] + oy - centerYMm) / MM;
      buf[i + 2] = (fm.flatPositionsMm[i + 2] + oz) / MM;
    }
    return buf;
  });

  return {
    layFlatPositionsM,
    sheetSizeMm: [+maxSheetXMm.toFixed(1), +totalSheetYMm.toFixed(1)],
  };
}



