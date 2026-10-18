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
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import type { SceneGeom, SceneGraph, SceneNode } from '../types/scene';
import { createSculptMesh } from './sculptMesh';
import { toManifold } from './sculptCut';
import { weldSoup } from './printSplit';
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
  let topSpan1 = 0, topSpan2 = 0, botSpan1 = 0, botSpan2 = 0;
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
  topSpan1 = topHi1 - topLo1;
  topSpan2 = topHi2 - topLo2;
  botSpan1 = botHi1 - botLo1;
  botSpan2 = botHi2 - botLo2;

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
    const currIsLegs = curr.area < 0.38 * maxAreaZ && curr.count >= 2;
    const currIsSlab = curr.area > 0.5 * maxAreaZ && curr.count === 1;
    const prevIsLegs = prev.area < 0.38 * maxAreaZ && prev.count >= 2;
    if ((prevIsSlab && currIsLegs) || (prevIsLegs && currIsSlab)) {
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
 * Extract and classify all structural timber members from a list of metre
 * triangle soups (either multiple parts or a single combined solid).
 */
export function extractTimberMembers(
  wasm: ManifoldToplevel,
  soupsMetres: ArrayLike<number>[],
  options: ExtractMembersOptions = {},
): { ok: true; members: TimberMember[]; warnings: string[] } | { ok: false; error: string } {
  const maxBoardWidthMm = options.maxBoardWidthMm ?? 180;
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
  for (const m of decomposed) {
    const mesh = manifoldToMeshMm(m);
    const obb = computeMemberObb(mesh.positionsMm, mesh.faces);
    const role = classifyRole(obb.axes, obb.dimsMm);
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
  let minAll: Vec3 = [Infinity, Infinity, Infinity];
  let maxAll: Vec3 = [-Infinity, -Infinity, -Infinity];
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

    let id = `Part_${index + 1}`;
    let title = `Part ${index + 1}`;
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

