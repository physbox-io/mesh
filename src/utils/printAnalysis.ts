// ---------------------------------------------------------------------------
// Exhaustive Mechanical & Manufacturing Failure Mode Analysis Engine (v11)
//
// Features:
// 1. Surface Point Anchoring (surfacePoint + visual 3D leader line offset).
// 2. 3D Print Failure Mode 1: Sub-Optimal Orientation / Support Material Volume.
// 3. 3D Print Failure Mode 2: Thin Hole-to-Edge & Hole Proximity Breakdown (<1.5mm).
// 4. Perfect 3D Euler & Quaternion Rotation Matrix Transform Resolution.
// ---------------------------------------------------------------------------

import type { SceneGraph, SceneNode, SceneGeom } from '../types/scene';
import { resolveCsgGeoms, positiveBounds } from './csg';
import { isBoughtIn } from './boughtIn';
import { isNodeRotationBaked } from './sceneTree';
import { getGeomFrame } from './laserCutExporter';
import * as THREE from 'three';

export type WeakSpotCategory = 'structural' | 'dynamic' | 'hardware' | 'manufacturing';
export type WeakSpotSeverity = 'critical' | 'warning' | 'info';

export interface WeakSpot {
  id: string;
  nodeId: string;
  nodeName: string;
  geomName?: string;
  category: WeakSpotCategory;
  severity: WeakSpotSeverity;
  title: string;
  description: string;
  recommendation: string;
  position: [number, number, number]; // Raw MuJoCo Z-up world position [X, Y, Z]
  surfacePoint?: [number, number, number]; // Exact point on mesh surface
  meshFaceCount?: number;
}

export interface AnalysisResult {
  score: number; // 0 to 100
  weakSpots: WeakSpot[];
  counts: {
    critical: number;
    warning: number;
    info: number;
    structural: number;
    dynamic: number;
    hardware: number;
    manufacturing: number;
  };
}

interface GeomTransform {
  pos: [number, number, number];
  mat: [number, number, number, number, number, number, number, number, number]; // 3x3 row-major matrix
  hasRotation: boolean;
  matrix4: THREE.Matrix4;
  halfLen?: number;
}

/** Local-to-world 4x4 matrix of a body node, composing parent rotations properly. */
function getNodeWorldMatrix(node: SceneNode, parentMatrix?: THREE.Matrix4): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  if (!isNodeRotationBaked(node)) {
    if (node.quat && node.quat.length === 4 && (node.quat[0] !== 1 || node.quat[1] !== 0 || node.quat[2] !== 0 || node.quat[3] !== 0)) {
      const q = new THREE.Quaternion(node.quat[1] || 0, node.quat[2] || 0, node.quat[3] || 0, node.quat[0] ?? 1).normalize();
      m.makeRotationFromQuaternion(q);
    } else if (node.rot && (node.rot[0] !== 0 || node.rot[1] !== 0 || node.rot[2] !== 0)) {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(node.rot[0] || 0, node.rot[1] || 0, node.rot[2] || 0, 'XYZ'));
      m.makeRotationFromQuaternion(q);
    } else if (node.euler && (node.euler[0] !== 0 || node.euler[1] !== 0 || node.euler[2] !== 0)) {
      const rx = (node.euler[0] * Math.PI) / 180;
      const ry = (node.euler[1] * Math.PI) / 180;
      const rz = (node.euler[2] * Math.PI) / 180;
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ'));
      m.makeRotationFromQuaternion(q);
    }
  }
  m.setPosition(node.pos?.[0] || 0, node.pos?.[1] || 0, node.pos?.[2] || 0);
  return parentMatrix ? new THREE.Matrix4().multiplyMatrices(parentMatrix, m) : m;
}

/**
 * World position and rotation of a node/geom in raw MuJoCo Z-up space, as
 * drawn. Composes parent body rotations and geom.quat / geom.euler / geom.fromto.
 */
function getGeomWorldTransform(
  bodyMatrix: THREE.Matrix4,
  geom: SceneGeom | null,
): GeomTransform {
  let matrix4 = bodyMatrix;
  let halfLen: number | undefined;
  if (geom) {
    const frame = getGeomFrame(geom);
    matrix4 = new THREE.Matrix4().multiplyMatrices(bodyMatrix, frame.matrix);
    halfLen = frame.halfLen;
  }
  const me = matrix4.elements;
  const mat: [number, number, number, number, number, number, number, number, number] = [
    me[0], me[4], me[8],
    me[1], me[5], me[9],
    me[2], me[6], me[10],
  ];
  const hasRotation =
    Math.abs(mat[0] - 1) > 1e-6 || Math.abs(mat[4] - 1) > 1e-6 || Math.abs(mat[8] - 1) > 1e-6 ||
    Math.abs(mat[1]) > 1e-6 || Math.abs(mat[2]) > 1e-6 || Math.abs(mat[3]) > 1e-6 ||
    Math.abs(mat[5]) > 1e-6 || Math.abs(mat[6]) > 1e-6 || Math.abs(mat[7]) > 1e-6;
  return { pos: [me[12], me[13], me[14]], mat, hasRotation, matrix4, halfLen };
}

/**
 * Computes exact bounds in raw MuJoCo Z-up space
 */
function getNodeRealWorldBounds(node: SceneNode, bodyMatrix: THREE.Matrix4) {
  const transform = getGeomWorldTransform(bodyMatrix, null);
  const nodeWorldPos = transform.pos;

  let min: [number, number, number] = [Infinity, Infinity, Infinity];
  let max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  const csgB = positiveBounds(node);
  if (csgB && isFinite(csgB.min[0]) && isFinite(csgB.max[0])) {
    const v = new THREE.Vector3();
    for (const cx of [csgB.min[0], csgB.max[0]]) {
      for (const cy of [csgB.min[1], csgB.max[1]]) {
        for (const cz of [csgB.min[2], csgB.max[2]]) {
          v.set(cx, cy, cz).applyMatrix4(bodyMatrix);
          if (v.x < min[0]) min[0] = v.x;
          if (v.x > max[0]) max[0] = v.x;
          if (v.y < min[1]) min[1] = v.y;
          if (v.y > max[1]) max[1] = v.y;
          if (v.z < min[2]) min[2] = v.z;
          if (v.z > max[2]) max[2] = v.z;
        }
      }
    }
  } else {
    const allGeoms = resolveCsgGeoms(node, 'render');
    for (const g of allGeoms) {
      if (g.role === 'collision') continue;
      const gTransform = getGeomWorldTransform(bodyMatrix, g);
      const gPos = gTransform.pos;
      const m = gTransform.mat;
      let sx = 0.05, sy = 0.05, sz = 0.05;
      if (g.size) {
        if (g.size.length >= 3) {
          sx = g.size[0]; sy = g.size[1]; sz = g.size[2];
        } else if (g.type === 'sphere') {
          sx = sy = sz = g.size[0];
        } else if (g.type === 'cylinder' || g.type === 'capsule') {
          sx = sy = g.size[0]; sz = gTransform.halfLen ?? g.size[1] ?? g.size[0];
        }
      }
      const ex = Math.abs(m[0]) * sx + Math.abs(m[1]) * sy + Math.abs(m[2]) * sz;
      const ey = Math.abs(m[3]) * sx + Math.abs(m[4]) * sy + Math.abs(m[5]) * sz;
      const ez = Math.abs(m[6]) * sx + Math.abs(m[7]) * sy + Math.abs(m[8]) * sz;

      min[0] = Math.min(min[0], gPos[0] - ex);
      max[0] = Math.max(max[0], gPos[0] + ex);
      min[1] = Math.min(min[1], gPos[1] - ey);
      max[1] = Math.max(max[1], gPos[1] + ey);
      min[2] = Math.min(min[2], gPos[2] - ez);
      max[2] = Math.max(max[2], gPos[2] + ez);
    }
  }

  if (min[0] === Infinity) {
    min = [nodeWorldPos[0] - 0.05, nodeWorldPos[1] - 0.05, nodeWorldPos[2] - 0.05];
    max = [nodeWorldPos[0] + 0.05, nodeWorldPos[1] + 0.05, nodeWorldPos[2] + 0.05];
  }

  const dimensions: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const center: [number, number, number] = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];

  return { worldPos: nodeWorldPos, min, max, dimensions, center };
}

/**
 * Slices mesh vertices to find downward overhang face clusters (>40°) and sub-optimal print orientation.
 * Anchors spots directly to mesh surface points.
 */
function analyzeMeshOverhangClusters(
  node: SceneNode,
  geom: SceneGeom,
  bodyMatrix: THREE.Matrix4
): WeakSpot[] {
  const spots: WeakSpot[] = [];

  const isRenderVerts = !!geom.renderVertices;
  const verts = geom.renderVertices || geom.vertices;
  if (!verts || verts.length < 9) return spots;

  const { pos: gPos, mat: m, hasRotation } = getGeomWorldTransform(bodyMatrix, geom);
  const useMat = hasRotation;

  const BUCKET_SIZE = 0.08; // 80mm spatial clusters
  const buckets = new Map<string, { count: number; sumX: number; sumY: number; sumZ: number }>();

  let totalFaceCount = 0;
  let overhangFaceCount = 0;

  for (let i = 0; i < verts.length; i += 9) {
    totalFaceCount++;
    const ax = verts[i], ay = verts[i + 1], az = verts[i + 2];
    const bx = verts[i + 3], by = verts[i + 4], bz = verts[i + 5];
    const cx = verts[i + 6], cy = verts[i + 7], cz = verts[i + 8];

    // Edge vectors AB and AC
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;

    // Normal cross product
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;

    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-6) continue;

    let spotMjX: number, spotMjY: number, spotMjZ: number;
    let isDownwardOverhang: boolean;

    if (isRenderVerts) {
      // renderVertices: raw MuJoCo Z-up frame (x, y, z) where +Z is up
      const rnz = useMat ? (m[6] * nx + m[7] * ny + m[8] * nz) : nz;
      const rNormZ = rnz / len;

      const cLocX = (ax + bx + cx) / 3;
      const cLocY = (ay + by + cy) / 3;
      const cLocZ = (az + bz + cz) / 3;

      if (useMat) {
        spotMjX = m[0] * cLocX + m[1] * cLocY + m[2] * cLocZ + gPos[0];
        spotMjY = m[3] * cLocX + m[4] * cLocY + m[5] * cLocZ + gPos[1];
        spotMjZ = m[6] * cLocX + m[7] * cLocY + m[8] * cLocZ + gPos[2];
      } else {
        spotMjX = cLocX + gPos[0];
        spotMjY = cLocY + gPos[1];
        spotMjZ = cLocZ + gPos[2];
      }

      isDownwardOverhang = rNormZ < -0.65 && spotMjZ > 0.006;
    } else {
      // vertices: Three.js Y-up frame (x, z, -y) -> map to MuJoCo Z-up (x, -z, y)
      const cThreeX = (ax + bx + cx) / 3;
      const cThreeY = (ay + by + cy) / 3;
      const cThreeZ = (az + bz + cz) / 3;

      const cLocX = cThreeX;
      const cLocY = -cThreeZ;
      const cLocZ = cThreeY;

      if (useMat) {
        spotMjX = m[0] * cLocX + m[1] * cLocY + m[2] * cLocZ + gPos[0];
        spotMjY = m[3] * cLocX + m[4] * cLocY + m[5] * cLocZ + gPos[1];
        spotMjZ = m[6] * cLocX + m[7] * cLocY + m[8] * cLocZ + gPos[2];

        const nLocX = nx;
        const nLocY = -nz;
        const nLocZ = ny;
        const rnz = m[6] * nLocX + m[7] * nLocY + m[8] * nLocZ;
        const rNormZ = rnz / len;
        isDownwardOverhang = rNormZ < -0.65 && spotMjZ > 0.006;
      } else {
        spotMjX = cLocX + gPos[0];
        spotMjY = cLocY + gPos[1];
        spotMjZ = cLocZ + gPos[2];

        const rNormZ = ny / len;
        isDownwardOverhang = rNormZ < -0.65 && spotMjZ > 0.006;
      }
    }

    if (isDownwardOverhang) {
      overhangFaceCount++;
      const bxIdx = Math.floor((spotMjX + 100) / BUCKET_SIZE);
      const byIdx = Math.floor((spotMjY + 100) / BUCKET_SIZE);
      const bzIdx = Math.floor((spotMjZ + 100) / BUCKET_SIZE);
      const key = `${bxIdx},${byIdx},${bzIdx}`;

      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { count: 0, sumX: 0, sumY: 0, sumZ: 0 };
        buckets.set(key, bucket);
      }
      bucket.count++;
      bucket.sumX += spotMjX;
      bucket.sumY += spotMjY;
      bucket.sumZ += spotMjZ;
    }
  }

  let clusterIdx = 0;
  for (const [, b] of buckets) {
    if (b.count >= 1) {
      clusterIdx++;
      const surfacePos: [number, number, number] = [b.sumX / b.count, b.sumY / b.count, b.sumZ / b.count];
      spots.push({
        id: `mesh_overhang_${node.id}_${geom.name || 'geom'}_${clusterIdx}`,
        nodeId: node.id,
        nodeName: node.name,
        geomName: geom.name,
        category: 'manufacturing',
        severity: 'critical',
        title: `Overhang >45° (${b.count} faces)`,
        description: `${b.count} downward-facing mesh faces exceed 45°.`,
        recommendation: 'Reorient part, chamfer overhangs, or enable supports.',
        position: surfacePos,
        surfacePoint: surfacePos,
        meshFaceCount: b.count,
      });
    }
  }

  // --- NEW 3D PRINT FAILURE MODE 1: Sub-Optimal Print Orientation / Excessive Support Material ---
  if (totalFaceCount > 20 && overhangFaceCount / totalFaceCount > 0.25) {
    const overhangRatio = ((overhangFaceCount / totalFaceCount) * 100).toFixed(0);
    const bounds = getNodeRealWorldBounds(node, bodyMatrix);
    spots.push({
      id: `print_orientation_${node.id}`,
      nodeId: node.id,
      nodeName: node.name,
      geomName: geom.name,
      category: 'manufacturing',
      severity: 'warning',
      title: `High overhang area (${overhangRatio}%)`,
      description: `${overhangRatio}% of face area overhangs >45°.`,
      recommendation: 'Lay widest flat face on the print bed.',
      position: bounds.center,
      surfacePoint: bounds.center,
    });
  }

  return spots;
}

/**
 * Runs complete failure analysis across scene graph
 */
export function analyzeSceneMechanicalWeaknesses(sceneGraph: SceneGraph): AnalysisResult {
  const weakSpots: WeakSpot[] = [];

  if (!sceneGraph || !sceneGraph.nodes) {
    return {
      score: 100,
      weakSpots: [],
      counts: { critical: 0, warning: 0, info: 0, structural: 0, dynamic: 0, hardware: 0, manufacturing: 0 },
    };
  }

  const allNodes: { node: SceneNode; bodyMatrix: THREE.Matrix4 }[] = [];
  const collect = (nodes: SceneNode[], parentMatrix?: THREE.Matrix4) => {
    for (const node of nodes) {
      const bodyMatrix = getNodeWorldMatrix(node, parentMatrix);
      allNodes.push({ node, bodyMatrix });
      if (node.children) collect(node.children, bodyMatrix);
    }
  };
  collect(sceneGraph.nodes);

  for (const { node, bodyMatrix } of allNodes) {
    // A bought bearing or screw is not made here, so has nothing to weaken.
    if (isBoughtIn(node)) continue;
    const { min, max, dimensions, center } = getNodeRealWorldBounds(node, bodyMatrix);
    const [dx, dy, dz] = dimensions;
    const isStatic = !node.joints || node.joints.length === 0;

    // --- PASS 1: PRIMITIVE GEOMS (node.geoms) ---
    const primGeoms = node.geoms || [];
    for (const g of primGeoms) {
      // Skip collision helpers and intentional visual-only/compliant flexure leaves.
      if (g.role === 'collision' || g.role === 'visual' || g.name?.startsWith('flexure_') || g.bend) continue;
      const gTransform = getGeomWorldTransform(bodyMatrix, g);

      // Thin Wall Section (<1.0mm)
      if (g.type === 'box' && g.size) {
        const wallThicknessMm = Math.min(g.size[0], g.size[1], g.size[2]) * 2 * 1000;
        if (wallThicknessMm > 0 && wallThicknessMm < 1.0) {
          weakSpots.push({
            id: `thin_wall_${node.id}_${g.name || 'box'}`,
            nodeId: node.id,
            nodeName: node.name,
            geomName: g.name,
            category: 'structural',
            severity: 'critical',
            title: `Thin wall (${wallThicknessMm.toFixed(1)} mm)`,
            description: 'Wall thickness is below 1.0 mm.',
            recommendation: 'Thicken to ≥ 1.2 mm.',
            position: gTransform.pos,
            surfacePoint: gTransform.pos,
          });
        }
      }

      // Fragile Vertical Pins (<3.2mm diameter). A cut cylinder is a hole, not a pin,
      // and a horizontal cylinder (rotated via geom.quat/euler/fromto) is not a vertical pin.
      const cut = g.csg === 'difference';
      if ((g.type === 'cylinder' || g.type === 'capsule') && g.size && !cut) {
        const diameterMm = g.size[0] * 2 * 1000;
        const lengthMm = (gTransform.halfLen ?? g.size[1] ?? 0) * 2 * 1000;
        const axisWorldZ = Math.abs(gTransform.mat[8]);
        if (axisWorldZ > 0.7 && diameterMm < 3.2 && lengthMm > 6.0) {
          weakSpots.push({
            id: `thin_pin_${node.id}_${g.name || 'pin'}`,
            nodeId: node.id,
            nodeName: node.name,
            geomName: g.name,
            category: 'manufacturing',
            severity: 'critical',
            title: `Slender vertical pin (⌀${diameterMm.toFixed(1)} mm)`,
            description: 'Small vertical cylinder is weak across Z layer lines.',
            recommendation: 'Increase diameter to ≥ 4 mm or print horizontally.',
            position: gTransform.pos,
            surfacePoint: gTransform.pos,
          });
        }
      }

      // --- NEW 3D PRINT FAILURE MODE 2: Hole-to-Edge / Hole Proximity Breakdown (<1.5mm) ---
      // Only a cut is a hole; a ring cut is a groove, which no fastener loads.
      if ((g.type === 'cylinder' || g.type === 'sphere') && g.size && cut && !g.ringInner) {
        const radius = g.size[0];
        const gPos = gTransform.pos;
        // Check distance from hole center to bounding box perimeter walls
        const marginX = Math.min(Math.abs(gPos[0] - min[0]), Math.abs(max[0] - gPos[0])) - radius;
        const marginY = Math.min(Math.abs(gPos[1] - min[1]), Math.abs(max[1] - gPos[1])) - radius;
        const minMarginMm = Math.min(marginX, marginY) * 1000;

        if (minMarginMm > 0 && minMarginMm < 1.5) {
          weakSpots.push({
            id: `hole_proximity_${node.id}_${g.name || 'hole'}`,
            nodeId: node.id,
            nodeName: node.name,
            geomName: g.name,
            category: 'manufacturing',
            severity: 'critical',
            title: `Hole near edge (${minMarginMm.toFixed(1)} mm wall)`,
            description: 'Wall between hole and outer edge is under 1.5 mm.',
            recommendation: 'Increase edge margin to ≥ 2.5 mm.',
            position: gPos,
            surfacePoint: gPos,
          });
        }
      }
    }

    // --- PASS 2: MESH OVERHANG ANALYSIS ---
    const allGeomsForMesh = resolveCsgGeoms(node, 'render');
    const visitedMeshGeoms = new Set<string>();

    for (const g of allGeomsForMesh) {
      if (g.role === 'collision') continue;
      if (g.type === 'mesh' && g.name && !visitedMeshGeoms.has(g.name)) {
        visitedMeshGeoms.add(g.name);
        const meshOverhangs = analyzeMeshOverhangClusters(node, g, bodyMatrix);
        weakSpots.push(...meshOverhangs);
      }
    }

    // --- PASS 4: BOUNDING BOX & SCALE EVALUATION ---
    const maxExtent = Math.max(dx, dy, dz);
    if (maxExtent > 20.0) {
      weakSpots.push({
        id: `scale_large_${node.id}`,
        nodeId: node.id,
        nodeName: node.name,
        category: 'manufacturing',
        severity: 'critical',
        title: 'Exceeds build envelope (>20 m)',
        description: `Part span is ${Math.round(maxExtent * 1000).toLocaleString()} mm (likely mm imported as m).`,
        recommendation: 'Scale by 0.001 or check import units.',
        position: center,
        surfacePoint: center,
      });
    } else if (maxExtent < 0.002 && maxExtent > 0) {
      weakSpots.push({
        id: `scale_small_${node.id}`,
        nodeId: node.id,
        nodeName: node.name,
        category: 'manufacturing',
        severity: 'warning',
        title: 'Micro Feature Size (<2mm)',
        description: `Part size is ${(maxExtent * 1000).toFixed(1)}mm. May fall below 3D printing nozzle resolution.`,
        recommendation: 'Scale up geometry or check unit conversion settings.',
        position: center,
        surfacePoint: center,
      });
    }

    // High Aspect Ratio Column (>8:1): slender whichever way it stands — its
    // longest side against its middle one, so a board, thin but wide, is not one.
    const [shortSide, midSide, longSide] = [dx, dy, dz].sort((a, b) => a - b);
    if (longSide > 0.05 && midSide > 0 && longSide / midSide > 8.0) {
      weakSpots.push({
        id: `buckling_${node.id}`,
        nodeId: node.id,
        nodeName: node.name,
        category: 'structural',
        severity: 'warning',
        title: `Slender feature (${(longSide / midSide).toFixed(1)}:1)`,
        description: `${(longSide * 1000).toFixed(0)} mm × ${(midSide * 1000).toFixed(0)} mm span may flex during printing.`,
        recommendation: 'Thicken section or add ribs/supports.',
        position: [center[0], center[1], max[2]],
        surfacePoint: [center[0], center[1], max[2]],
      });
    }

    // Cantilever Bending Risk: a long moving beam. A plate — a drawer bottom,
    // a deck — is wide as well as long, and spreads its load.
    if (dx > 0.15 || dy > 0.15) {
      const horizontalSpan = Math.max(dx, dy);
      const beam = longSide > 4 * midSide;
      if (horizontalSpan / dz > 4.0 && !isStatic && beam) {
        weakSpots.push({
          id: `cantilever_${node.id}`,
          nodeId: node.id,
          nodeName: node.name,
          category: 'structural',
          severity: 'info',
          title: 'Unsupported Cantilever',
          description: `Long horizontal span (${(horizontalSpan * 1000).toFixed(0)}mm) may sag or deflect.`,
          recommendation: 'Add angled support struts, stiffening ribs, or print supports.',
          position: [max[0], center[1], center[2]],
          surfacePoint: [max[0], center[1], center[2]],
        });
      }
    }

    // Weak Bed Contact Footprint: printed on its broadest face, as a slicer
    // would lay it, not standing as it sits in the scene.
    if (longSide > 0.08 && shortSide > 0) {
      const baseArea = midSide * longSide;
      const height = shortSide;
      if (baseArea / height < 0.015) {
        weakSpots.push({
          id: `bed_contact_${node.id}`,
          nodeId: node.id,
          nodeName: node.name,
          category: 'manufacturing',
          severity: 'warning',
          title: 'Small bed contact area',
          description: `Small base footprint relative to ${(height * 1000).toFixed(0)} mm height.`,
          recommendation: 'Use a brim/raft or reorient.',
          position: [center[0], center[1], min[2]],
          surfacePoint: [center[0], center[1], min[2]],
        });
      }
    }

    // Hardware Fastener Boss Inspection
    if (node.isHardwareComponent && node.hardwareType === 'heat_set_boss') {
      const spec = node.hardwareSpec;
      if (spec) {
        const outerD = Number(spec.outerDiameterMm) || 8;
        const innerH = Number(spec.innerHoleMm) || 4;
        const bossWallMm = (outerD - innerH) / 2;
        if (bossWallMm < 1.8) {
          weakSpots.push({
            id: `boss_wall_${node.id}`,
            nodeId: node.id,
            nodeName: node.name,
            category: 'hardware',
            severity: 'critical',
            title: `Thin insert boss wall (${bossWallMm.toFixed(1)} mm)`,
            description: `Wall around ${spec.size} insert is under 1.8 mm.`,
            recommendation: `Increase boss OD to ≥ ${(innerH + 3.6).toFixed(1)} mm.`,
            position: center,
            surfacePoint: center,
          });
        }
      }
    }
  }

  const criticalCount = weakSpots.filter(w => w.severity === 'critical').length;
  const warningCount = weakSpots.filter(w => w.severity === 'warning').length;
  const infoCount = weakSpots.filter(w => w.severity === 'info').length;

  const penalty = criticalCount * 18 + warningCount * 7 + infoCount * 2;
  const score = Math.max(0, Math.min(100, Math.round(100 - penalty)));

  return {
    score,
    weakSpots,
    counts: {
      critical: criticalCount,
      warning: warningCount,
      info: infoCount,
      structural: weakSpots.filter(w => w.category === 'structural').length,
      dynamic: weakSpots.filter(w => w.category === 'dynamic').length,
      hardware: weakSpots.filter(w => w.category === 'hardware').length,
      manufacturing: weakSpots.filter(w => w.category === 'manufacturing').length,
    },
  };
}

/**
 * Retired from the DFM lens: `boss_wall_*` now lives in `hardwareChecks.ts`
 * (with 1-click remediation), while thin-wall and orientation checks live in
 * `dfm.ts`. Returning `[]` prevents redundant worker CPU and noisy cards.
 */
export function structuralWeakSpots(_scene: SceneGraph): WeakSpot[] {
  return [];
}
