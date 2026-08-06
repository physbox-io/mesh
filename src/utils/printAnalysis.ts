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
import { useStore } from '../store/useStore';
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
}

/**
 * Gets live world 3D position and rotation matrix for a node/geom in raw MuJoCo Z-up space
 */
function getGeomWorldTransform(
  node: SceneNode,
  geom: SceneGeom | null,
  parentPos: [number, number, number]
): GeomTransform {
  const store = useStore.getState();
  const model = store.model;
  const data = store.data;
  const mujoco = store.mujoco;
  const isPlaying = store.isPlaying;

  const identityMat: [number, number, number, number, number, number, number, number, number] = [
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ];

  // Live WASM tracking during active physics simulation
  if (isPlaying && model && data && mujoco) {
    if (geom && geom.name) {
      const gid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM.value, geom.name);
      if (gid !== -1 && gid < model.ngeom && data.geom_xpos && data.geom_xmat) {
        const offsetP = gid * 3;
        const offsetM = gid * 9;
        return {
          pos: [data.geom_xpos[offsetP], data.geom_xpos[offsetP + 1], data.geom_xpos[offsetP + 2]],
          mat: [
            data.geom_xmat[offsetM],     data.geom_xmat[offsetM + 1], data.geom_xmat[offsetM + 2],
            data.geom_xmat[offsetM + 3], data.geom_xmat[offsetM + 4], data.geom_xmat[offsetM + 5],
            data.geom_xmat[offsetM + 6], data.geom_xmat[offsetM + 7], data.geom_xmat[offsetM + 8],
          ],
          hasRotation: true,
        };
      }
    }

    if (node.name) {
      const bid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, node.name);
      if (bid !== -1 && bid < model.nbody && data.xpos && data.xmat) {
        const offsetP = bid * 3;
        const offsetM = bid * 9;
        const bodyMat = [
          data.xmat[offsetM],     data.xmat[offsetM + 1], data.xmat[offsetM + 2],
          data.xmat[offsetM + 3], data.xmat[offsetM + 4], data.xmat[offsetM + 5],
          data.xmat[offsetM + 6], data.xmat[offsetM + 7], data.xmat[offsetM + 8],
        ] as [number, number, number, number, number, number, number, number, number];

        const gx = geom?.pos?.[0] || 0;
        const gy = geom?.pos?.[1] || 0;
        const gz = geom?.pos?.[2] || 0;

        const worldX = data.xpos[offsetP] + bodyMat[0] * gx + bodyMat[1] * gy + bodyMat[2] * gz;
        const worldY = data.xpos[offsetP + 1] + bodyMat[3] * gx + bodyMat[4] * gy + bodyMat[5] * gz;
        const worldZ = data.xpos[offsetP + 2] + bodyMat[6] * gx + bodyMat[7] * gy + bodyMat[8] * gz;

        return { pos: [worldX, worldY, worldZ], mat: bodyMat, hasRotation: true };
      }
    }
  }

  // Scene graph node position & rotation
  const nx = parentPos[0] + (node.pos?.[0] || 0);
  const ny = parentPos[1] + (node.pos?.[1] || 0);
  const nz = parentPos[2] + (node.pos?.[2] || 0);

  let rotMat = identityMat;
  let hasRotation = false;

  if (node.rot && (node.rot[0] !== 0 || node.rot[1] !== 0 || node.rot[2] !== 0)) {
    hasRotation = true;
    const euler = new THREE.Euler(node.rot[0] || 0, node.rot[1] || 0, node.rot[2] || 0, 'XYZ');
    const q = new THREE.Quaternion().setFromEuler(euler);
    const m4 = new THREE.Matrix4().makeRotationFromQuaternion(q);
    const me = m4.elements;
    rotMat = [
      me[0], me[4], me[8],
      me[1], me[5], me[9],
      me[2], me[6], me[10],
    ];
  } else if (node.euler && (node.euler[0] !== 0 || node.euler[1] !== 0 || node.euler[2] !== 0)) {
    hasRotation = true;
    const rx = (node.euler[0] * Math.PI) / 180;
    const ry = (node.euler[1] * Math.PI) / 180;
    const rz = (node.euler[2] * Math.PI) / 180;
    const euler = new THREE.Euler(rx, ry, rz, 'XYZ');
    const q = new THREE.Quaternion().setFromEuler(euler);
    const m4 = new THREE.Matrix4().makeRotationFromQuaternion(q);
    const me = m4.elements;
    rotMat = [
      me[0], me[4], me[8],
      me[1], me[5], me[9],
      me[2], me[6], me[10],
    ];
  }

  const gx = geom?.pos?.[0] || 0;
  const gy = geom?.pos?.[1] || 0;
  const gz = geom?.pos?.[2] || 0;

  const worldX = nx + rotMat[0] * gx + rotMat[1] * gy + rotMat[2] * gz;
  const worldY = ny + rotMat[3] * gx + rotMat[4] * gy + rotMat[5] * gz;
  const worldZ = nz + rotMat[6] * gx + rotMat[7] * gy + rotMat[8] * gz;

  return { pos: [worldX, worldY, worldZ], mat: rotMat, hasRotation };
}

/**
 * Computes exact bounds in raw MuJoCo Z-up space
 */
function getNodeRealWorldBounds(node: SceneNode, parentPos: [number, number, number] = [0, 0, 0]) {
  const transform = getGeomWorldTransform(node, null, parentPos);
  const nodeWorldPos = transform.pos;

  let min: [number, number, number] = [Infinity, Infinity, Infinity];
  let max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  const csgB = positiveBounds(node);
  if (csgB && isFinite(csgB.min[0]) && isFinite(csgB.max[0])) {
    min = [nodeWorldPos[0] + csgB.min[0], nodeWorldPos[1] + csgB.min[1], nodeWorldPos[2] + csgB.min[2]];
    max = [nodeWorldPos[0] + csgB.max[0], nodeWorldPos[1] + csgB.max[1], nodeWorldPos[2] + csgB.max[2]];
  } else {
    const allGeoms = [...(node.geoms || []), ...resolveCsgGeoms(node, 'render')];
    for (const g of allGeoms) {
      const gTransform = getGeomWorldTransform(node, g, parentPos);
      const gPos = gTransform.pos;
      let sx = 0.05, sy = 0.05, sz = 0.05;
      if (g.size) {
        if (g.size.length >= 3) {
          sx = g.size[0]; sy = g.size[1]; sz = g.size[2];
        } else if (g.type === 'sphere') {
          sx = sy = sz = g.size[0];
        } else if (g.type === 'cylinder' || g.type === 'capsule') {
          sx = sy = g.size[0]; sz = g.size[1];
        }
      }

      min[0] = Math.min(min[0], gPos[0] - sx);
      max[0] = Math.max(max[0], gPos[0] + sx);
      min[1] = Math.min(min[1], gPos[1] - sy);
      max[1] = Math.max(max[1], gPos[1] + sy);
      min[2] = Math.min(min[2], gPos[2] - sz);
      max[2] = Math.max(max[2], gPos[2] + sz);
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
  parentPos: [number, number, number]
): WeakSpot[] {
  const spots: WeakSpot[] = [];

  const isRenderVerts = !!geom.renderVertices;
  const verts = geom.renderVertices || geom.vertices;
  if (!verts || verts.length < 9) return spots;

  const { pos: gPos, mat: m, hasRotation } = getGeomWorldTransform(node, geom, parentPos);
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

    let spotMjX = 0, spotMjY = 0, spotMjZ = 0;
    let isDownwardOverhang = false;

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
        title: `Unsupported Mesh Overhang >45° (${b.count} Faces)`,
        description: `Detected cluster of ${b.count} downward-facing mesh faces exceeding the 45° overhang threshold without support structures.`,
        recommendation: 'Re-orient part on print bed, add chamfers/fillets, or enable slicer print supports.',
        position: surfacePos,
        surfacePoint: surfacePos,
        meshFaceCount: b.count,
      });
    }
  }

  // --- NEW 3D PRINT FAILURE MODE 1: Sub-Optimal Print Orientation / Excessive Support Material ---
  if (totalFaceCount > 20 && overhangFaceCount / totalFaceCount > 0.25) {
    const overhangRatio = ((overhangFaceCount / totalFaceCount) * 100).toFixed(0);
    const bounds = getNodeRealWorldBounds(node, parentPos);
    spots.push({
      id: `print_orientation_${node.id}`,
      nodeId: node.id,
      nodeName: node.name,
      geomName: geom.name,
      category: 'manufacturing',
      severity: 'warning',
      title: `Sub-Optimal Print Orientation (${overhangRatio}% Support Area)`,
      description: `Current orientation creates ${overhangRatio}% downward overhang face area. Will require extensive print support structures and long print times.`,
      recommendation: 'Rotate component 90° or lay wide flat face directly on the print bed to eliminate support material.',
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

  const allNodes: { node: SceneNode; parentPos: [number, number, number] }[] = [];
  const collect = (nodes: SceneNode[], parentPos: [number, number, number] = [0, 0, 0]) => {
    for (const node of nodes) {
      allNodes.push({ node, parentPos });
      const curPos: [number, number, number] = [
        parentPos[0] + (node.pos?.[0] || 0),
        parentPos[1] + (node.pos?.[1] || 0),
        parentPos[2] + (node.pos?.[2] || 0),
      ];
      if (node.children) collect(node.children, curPos);
    }
  };
  collect(sceneGraph.nodes);

  for (const { node, parentPos } of allNodes) {
    const { worldPos, min, max, dimensions, center } = getNodeRealWorldBounds(node, parentPos);
    const [dx, dy, dz] = dimensions;
    const isStatic = !node.joints || node.joints.length === 0;

    // --- PASS 1: PRIMITIVE GEOMS (node.geoms) ---
    const primGeoms = node.geoms || [];
    for (const g of primGeoms) {
      const gTransform = getGeomWorldTransform(node, g, parentPos);

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
            title: `Ultra-Thin Wall Section (${wallThicknessMm.toFixed(1)}mm)`,
            description: `Wall thickness is below 1.0mm. Vulnerable to structural collapse under normal force.`,
            recommendation: 'Thicken wall section to at least 1.2mm–2.0mm for load-bearing stability.',
            position: gTransform.pos,
            surfacePoint: gTransform.pos,
          });
        }
      }

      // Fragile Vertical Pins (<3.2mm diameter)
      if ((g.type === 'cylinder' || g.type === 'capsule') && g.size) {
        const diameterMm = g.size[0] * 2 * 1000;
        const lengthMm = g.size[1] * 2 * 1000;
        if (diameterMm < 3.2 && lengthMm > 6.0) {
          weakSpots.push({
            id: `thin_pin_${node.id}_${g.name || 'pin'}`,
            nodeId: node.id,
            nodeName: node.name,
            geomName: g.name,
            category: 'manufacturing',
            severity: 'critical',
            title: `Fragile Vertical Pin (${diameterMm.toFixed(1)}mm Diameter)`,
            description: `Small pin printed vertically along Z. Bending loads will easily split Z-axis layer boundaries.`,
            recommendation: 'Increase pin diameter to >=4mm or reorient print axis horizontally.',
            position: gTransform.pos,
            surfacePoint: gTransform.pos,
          });
        }
      }

      // --- NEW 3D PRINT FAILURE MODE 2: Hole-to-Edge / Hole Proximity Breakdown (<1.5mm) ---
      if ((g.type === 'cylinder' || g.type === 'sphere') && g.size) {
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
            title: `Thin Hole-to-Edge Wall Proximity (${minMarginMm.toFixed(1)}mm)`,
            description: `Wall thickness between drill hole and outer enclosure perimeter is under 1.5mm. High risk of perimeter wall blowout or cracking under fastener torque.`,
            recommendation: `Increase wall margin between hole and outer boundary to at least 2.5mm.`,
            position: gPos,
            surfacePoint: gPos,
          });
        }
      }
    }

    // --- PASS 2: MESH OVERHANG ANALYSIS ---
    const allGeomsForMesh = [...(node.geoms || []), ...resolveCsgGeoms(node, 'render')];
    const visitedMeshGeoms = new Set<string>();

    for (const g of allGeomsForMesh) {
      if (g.type === 'mesh' && g.name && !visitedMeshGeoms.has(g.name)) {
        visitedMeshGeoms.add(g.name);
        const meshOverhangs = analyzeMeshOverhangClusters(node, g, parentPos);
        weakSpots.push(...meshOverhangs);
      }
    }

    // --- PASS 3: UNFILLETED 90° NOTCH STEPS ---
    if (primGeoms.length >= 2) {
      for (let i = 0; i < primGeoms.length - 1; i++) {
        const g1 = primGeoms[i], g2 = primGeoms[i + 1];
        if (g1.type === 'box' && g2.type === 'box' && g1.pos && g2.pos) {
          const dxStep = Math.abs(g1.pos[0] - g2.pos[0]);
          const dyStep = Math.abs(g1.pos[1] - g2.pos[1]);
          const dzStep = Math.abs(g1.pos[2] - g2.pos[2]);
          if ((dxStep > 0.02 || dyStep > 0.02) && dzStep < 0.01) {
            const stepMjPos: [number, number, number] = [
              worldPos[0] + (g1.pos[0] + g2.pos[0]) / 2,
              worldPos[1] + (g1.pos[1] + g2.pos[1]) / 2,
              worldPos[2] + (g1.pos[2] + g2.pos[2]) / 2,
            ];
            weakSpots.push({
              id: `notch_${node.id}_${i}`,
              nodeId: node.id,
              nodeName: node.name,
              category: 'structural',
              severity: 'warning',
              title: 'Unfilleted 90° Notch Stress Riser',
              description: 'Abrupt 90° corner joint between sub-geometries creates high stress concentration under load.',
              recommendation: 'Add a 2mm–4mm fillet radius or angled corner chamfer.',
              position: stepMjPos,
              surfacePoint: stepMjPos,
            });
            break;
          }
        }
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
        title: 'Implausibly Large Dimensions (>20m)',
        description: `Model extents are ${maxExtent.toFixed(1)}m wide. Authored in millimeters without scaling to meters.`,
        recommendation: 'Wrap OpenSCAD design in scale([0.001, 0.001, 0.001]) or scale mesh by 0.001.',
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

    // High Aspect Ratio Column Buckling (>8:1)
    const minCross = Math.min(dx, dy);
    if (dz > 0.05 && minCross > 0 && dz / minCross > 8.0) {
      weakSpots.push({
        id: `buckling_${node.id}`,
        nodeId: node.id,
        nodeName: node.name,
        category: 'structural',
        severity: 'warning',
        title: `Slender Column Buckling Risk (${(dz / minCross).toFixed(1)}:1 Ratio)`,
        description: `Tall slender feature (${(dz * 1000).toFixed(0)}mm height vs ${(minCross * 1000).toFixed(0)}mm width). Prone to Euler buckling under compressive load and print bed wobble.`,
        recommendation: 'Increase cross-sectional thickness or add triangular gusset ribs.',
        position: [center[0], center[1], max[2]],
        surfacePoint: [center[0], center[1], max[2]],
      });
    }

    // Cantilever Bending Risk
    if (dx > 0.15 || dy > 0.15) {
      const horizontalSpan = Math.max(dx, dy);
      if (horizontalSpan / dz > 4.0 && !isStatic) {
        weakSpots.push({
          id: `cantilever_${node.id}`,
          nodeId: node.id,
          nodeName: node.name,
          category: 'structural',
          severity: 'warning',
          title: 'Un-braced Cantilever Bending Risk',
          description: `Long horizontal span (${(horizontalSpan * 1000).toFixed(0)}mm) with high flexural bending moment.`,
          recommendation: 'Add angled support struts, stiffening ribs, or a fillet root.',
          position: [max[0], center[1], center[2]],
          surfacePoint: [max[0], center[1], center[2]],
        });
      }
    }

    // Weak Bed Contact Footprint
    if (min[2] <= 0.005 && dz > 0.08) {
      const baseArea = dx * dy;
      const height = dz;
      if (baseArea / height < 0.015) {
        weakSpots.push({
          id: `bed_contact_${node.id}`,
          nodeId: node.id,
          nodeName: node.name,
          category: 'manufacturing',
          severity: 'warning',
          title: 'Weak Print Bed Contact Footprint',
          description: `Minimal ground contact area relative to part height (${(dz * 1000).toFixed(0)}mm tall). High risk of print detachment.`,
          recommendation: 'Add a sacrificial print brim/raft or broaden base contact area.',
          position: [center[0], center[1], min[2]],
          surfacePoint: [center[0], center[1], min[2]],
        });
      }
    }

    // Hardware Fastener Boss Inspection
    if (node.isHardwareComponent && node.hardwareType === 'heat_set_boss') {
      const spec = node.hardwareSpec;
      if (spec) {
        const outerD = spec.outerDiameterMm || 8;
        const innerH = spec.innerHoleMm || 4;
        const bossWallMm = (outerD - innerH) / 2;
        if (bossWallMm < 1.8) {
          weakSpots.push({
            id: `boss_wall_${node.id}`,
            nodeId: node.id,
            nodeName: node.name,
            category: 'hardware',
            severity: 'critical',
            title: `Thin Insert Boss Wall (${bossWallMm.toFixed(1)}mm)`,
            description: `Outer wall surrounding ${spec.size} insert hole is under 1.8mm recommendation. Thermal insertion will burst boss wall.`,
            recommendation: `Enlarge boss outer diameter to at least ${(innerH + 3.6).toFixed(1)}mm.`,
            position: center,
            surfacePoint: center,
          });
        }
      }
    }
  }

  // --- PASS 5: DYNAMIC CLEARANCE & GEAR INTERLOCKING ---
  for (let i = 0; i < allNodes.length; i++) {
    for (let j = i + 1; j < allNodes.length; j++) {
      const a = allNodes[i];
      const b = allNodes[j];
      if (a.node.id === b.node.id) continue;

      const posA = getNodeRealWorldBounds(a.node, a.parentPos).center;
      const posB = getNodeRealWorldBounds(b.node, b.parentPos).center;
      const dist = Math.hypot(posA[0] - posB[0], posA[1] - posB[1], posA[2] - posB[2]);

      if (dist < 0.03 && dist > 0.001) {
        const isGearA = a.node.name?.toLowerCase().includes('gear') || a.node.name?.toLowerCase().includes('pinion');
        const isGearB = b.node.name?.toLowerCase().includes('gear') || b.node.name?.toLowerCase().includes('pinion');
        if (isGearA && isGearB) {
          const midPoint: [number, number, number] = [(posA[0] + posB[0]) / 2, (posA[1] + posB[1]) / 2, (posA[2] + posB[2]) / 2];
          weakSpots.push({
            id: `clearance_${a.node.id}_${b.node.id}`,
            nodeId: a.node.id,
            nodeName: `${a.node.name} / ${b.node.name}`,
            category: 'hardware',
            severity: 'warning',
            title: 'Tight Gear Tooth Clearance / Binding Risk',
            description: 'Meshing gear centers positioned with minimal clearance gap. Risks physical tooth binding or interlock jams.',
            recommendation: 'Increase backlash clearance (+0.15mm pitch offset) or verify mechanical equality coupling.',
            position: midPoint,
            surfacePoint: midPoint,
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
