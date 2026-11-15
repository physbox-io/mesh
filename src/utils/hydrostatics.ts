// ---------------------------------------------------------------------------
// True Waterline Hydrostatics & Vessel Flooding
//
// Computes exact Archimedes buoyancy (displaced volume and true 3D Centre of
// Buoyancy below a free water surface Z = waterLevel), open-vessel gunwale
// air displacement vs swamping when heeled past the rim, and unconditionally
// stable hydrodynamic drag for the MuJoCo step loop and static trim solver.
//
// Pure & store-free: runs identically in the physics worker, in inspector
// stability checks, and in Vitest.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import type { SceneGeom, SceneNode } from '../types/scene';
import { fromtoFrame, geomMatrixOf, meshVolumeAndCentroid } from './csg';

export const FRESHWATER_DENSITY = 1000; // kg/m³

/** Precomputed body-frame triangle soup(s) for fast, zero-allocation step evaluation. */
export interface HydroBodyModel {
  nodeId: string;
  /** Flat world/body Z-up triangles: 9 floats per triangle [x1,y1,z1, x2,y2,z2, x3,y3,z3]. */
  solidTris: Float64Array;
  /** Total closed solid volume (m³). */
  solidVolume: number;
  /**
   * Optional outer hull envelope for open-top vessels (cups, bowls, boats)
   * whose solidity < 0.88: displaces interior air until water tops the rim.
   */
  vessel?: {
    hullTris: Float64Array;
    hullVolume: number;
    /** Rim sample points [x,y,z, ...] in body frame where water can spill in. */
    rimPoints: Float64Array;
    /** Vertical freeboard transition band (m) over which swamping ramps 0 -> 1. */
    spillBandM: number;
  };
}

export interface SubmergedResult {
  /** Displaced fluid volume below Z = waterLevel (m³). */
  volume: number;
  /** World-space Centre of Buoyancy [x, y, z] (m). */
  cob: [number, number, number];
  /** Fraction [0..1] of an open vessel's interior that has flooded over the rim. */
  floodedFraction: number;
}

export interface BuoyancyWrench {
  submergedVolume: number;
  cob: [number, number, number];
  floodedFraction: number;
  /** World force [fx, fy, fz] (N) to apply at the body's CoM (xipos). */
  force: [number, number, number];
  /** World torque [tx, ty, tz] (N·m) about the body's CoM (xipos). */
  torque: [number, number, number];
}

// ---------------------------------------------------------------------------
// Divergence-theorem exact clipped triangle integral against Z <= waterLevel
//
// Using u = z - waterLevel, the vector fields F_V = (0, 0, u), F_X = (0, 0, x*u),
// F_Y = (0, 0, y*u), and F_Z = (0, 0, 0.5*u^2) have divergences 1, x, y, u and
// vanish identically on the cut plane u = 0 — so the waterplane cap contributes
// zero flux and never needs to be triangulated.
// ---------------------------------------------------------------------------

interface SubAccum {
  vol: number;
  xVol: number;
  yVol: number;
  uVol: number;
}

function addSubmergedTri(
  acc: SubAccum,
  x1: number, y1: number, u1: number,
  x2: number, y2: number, u2: number,
  x3: number, y3: number, u3: number,
): void {
  const nz = 0.5 * ((x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1));
  if (nz === 0) return;
  acc.vol += nz * ((u1 + u2 + u3) / 3);
  acc.xVol += nz * (
    (2 * x1 + x2 + x3) * u1 +
    (x1 + 2 * x2 + x3) * u2 +
    (x1 + x2 + 2 * x3) * u3
  ) / 12;
  acc.yVol += nz * (
    (2 * y1 + y2 + y3) * u1 +
    (y1 + 2 * y2 + y3) * u2 +
    (y1 + y2 + 2 * y3) * u3
  ) / 12;
  acc.uVol += nz * (u1 * u1 + u2 * u2 + u3 * u3 + u1 * u2 + u2 * u3 + u3 * u1) / 12;
}

function clipAndAddTri(
  acc: SubAccum,
  ax: number, ay: number, ua: number,
  bx: number, by: number, ub: number,
  cx: number, cy: number, uc: number,
): void {
  const aIn = ua <= 0;
  const bIn = ub <= 0;
  const cIn = uc <= 0;
  const count = (aIn ? 1 : 0) + (bIn ? 1 : 0) + (cIn ? 1 : 0);
  if (count === 0) return;
  if (count === 3) {
    addSubmergedTri(acc, ax, ay, ua, bx, by, ub, cx, cy, uc);
    return;
  }

  // Rotate vertex order cyclically (preserving CCW outward orientation) so:
  // - count === 1: p0 is inside (u0 <= 0), p1 & p2 are outside (u > 0)
  // - count === 2: p0 & p1 are inside (u <= 0), p2 is outside (u2 > 0)
  let x0 = ax, y0 = ay, u0 = ua;
  let x1 = bx, y1 = by, u1 = ub;
  let x2 = cx, y2 = cy, u2 = uc;

  if (count === 1) {
    if (bIn) {
      x0 = bx; y0 = by; u0 = ub;
      x1 = cx; y1 = cy; u1 = uc;
      x2 = ax; y2 = ay; u2 = ua;
    } else if (cIn) {
      x0 = cx; y0 = cy; u0 = uc;
      x1 = ax; y1 = ay; u1 = ua;
      x2 = bx; y2 = by; u2 = ub;
    }
    const t01 = u0 / (u0 - u1);
    const t02 = u0 / (u0 - u2);
    const p01x = x0 + t01 * (x1 - x0);
    const p01y = y0 + t01 * (y1 - y0);
    const p02x = x0 + t02 * (x2 - x0);
    const p02y = y0 + t02 * (y2 - y0);
    addSubmergedTri(acc, x0, y0, u0, p01x, p01y, 0, p02x, p02y, 0);
  } else {
    // count === 2: put the single outside vertex at p2
    if (!aIn) {
      x0 = bx; y0 = by; u0 = ub;
      x1 = cx; y1 = cy; u1 = uc;
      x2 = ax; y2 = ay; u2 = ua;
    } else if (!bIn) {
      x0 = cx; y0 = cy; u0 = uc;
      x1 = ax; y1 = ay; u1 = ua;
      x2 = bx; y2 = by; u2 = ub;
    }
    const t12 = u1 / (u1 - u2);
    const t02 = u0 / (u0 - u2);
    const p12x = x1 + t12 * (x2 - x1);
    const p12y = y1 + t12 * (y2 - y1);
    const p02x = x0 + t02 * (x2 - x0);
    const p02y = y0 + t02 * (y2 - y0);
    addSubmergedTri(acc, x0, y0, u0, x1, y1, u1, p12x, p12y, 0);
    addSubmergedTri(acc, x0, y0, u0, p12x, p12y, 0, p02x, p02y, 0);
  }
}

/**
 * Evaluates exact submerged volume and world Centre of Buoyancy of a body-local
 * triangle soup transformed by body world position `pos` and row-major 3x3 `xmat`.
 */
export function integrateSubmergedTris(
  tris: Float64Array,
  pos: ArrayLike<number>,
  xmat: ArrayLike<number>,
  waterLevel: number,
): { volume: number; cob: [number, number, number] } {
  const px = pos[0], py = pos[1], pz = pos[2];
  const r00 = xmat[0], r01 = xmat[1], r02 = xmat[2];
  const r10 = xmat[3], r11 = xmat[4], r12 = xmat[5];
  const r20 = xmat[6], r21 = xmat[7], r22 = xmat[8];

  const acc: SubAccum = { vol: 0, xVol: 0, yVol: 0, uVol: 0 };
  for (let i = 0; i + 8 < tris.length; i += 9) {
    const lx0 = tris[i], ly0 = tris[i + 1], lz0 = tris[i + 2];
    const lx1 = tris[i + 3], ly1 = tris[i + 4], lz1 = tris[i + 5];
    const lx2 = tris[i + 6], ly2 = tris[i + 7], lz2 = tris[i + 8];

    const wx0 = px + r00 * lx0 + r01 * ly0 + r02 * lz0;
    const wy0 = py + r10 * lx0 + r11 * ly0 + r12 * lz0;
    const wz0 = pz + r20 * lx0 + r21 * ly0 + r22 * lz0;

    const wx1 = px + r00 * lx1 + r01 * ly1 + r02 * lz1;
    const wy1 = py + r10 * lx1 + r11 * ly1 + r12 * lz1;
    const wz1 = pz + r20 * lx1 + r21 * ly1 + r22 * lz1;

    const wx2 = px + r00 * lx2 + r01 * ly2 + r02 * lz2;
    const wy2 = py + r10 * lx2 + r11 * ly2 + r12 * lz2;
    const wz2 = pz + r20 * lx2 + r21 * ly2 + r22 * lz2;

    clipAndAddTri(
      acc,
      wx0, wy0, wz0 - waterLevel,
      wx1, wy1, wz1 - waterLevel,
      wx2, wy2, wz2 - waterLevel,
    );
  }

  if (!(acc.vol > 1e-12)) {
    return { volume: 0, cob: [px, py, Math.min(pz, waterLevel)] };
  }
  return {
    volume: acc.vol,
    cob: [
      acc.xVol / acc.vol,
      acc.yVol / acc.vol,
      waterLevel + acc.uVol / acc.vol,
    ],
  };
}

// ---------------------------------------------------------------------------
// Primitive & mesh triangle-soup builders (body-local Z-up metres)
// ---------------------------------------------------------------------------

function appendBufferGeometry(out: number[], geo: THREE.BufferGeometry, matrix: THREE.Matrix4): void {
  const g = geo.index ? geo : geo.toNonIndexed();
  const posAttr = g.getAttribute('position');
  const idx = g.getIndex();
  const v = new THREE.Vector3();
  if (idx) {
    for (let i = 0; i < idx.count; i += 3) {
      for (let k = 0; k < 3; k++) {
        v.fromBufferAttribute(posAttr, idx.getX(i + k)).applyMatrix4(matrix);
        out.push(v.x, v.y, v.z);
      }
    }
  } else {
    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(matrix);
      out.push(v.x, v.y, v.z);
    }
  }
  if (g !== geo) g.dispose();
}

/** Z-up local triangles of one solid geom (excluding boolean negatives and pure collision proxies). */
export function geomHydroTriangles(geom: SceneGeom, out: number[]): void {
  if (geom.csg === 'difference' || geom.csg === 'intersection') return;
  if (geom.csgDerived === 'collider' || geom.contactClass) return;
  if (geom.role === 'collision') return;

  const s = geom.size || [];
  let matrix = geomMatrixOf(geom);

  switch (geom.type) {
    case 'box': {
      const hx = s[0] ?? 0, hy = s[1] ?? 0, hz = s[2] ?? 0;
      if (!(hx > 0 && hy > 0 && hz > 0)) return;
      const geo = new THREE.BoxGeometry(2 * hx, 2 * hy, 2 * hz);
      appendBufferGeometry(out, geo, matrix);
      geo.dispose();
      return;
    }
    case 'sphere': {
      const r = s[0] ?? 0;
      if (!(r > 0)) return;
      const geo = new THREE.SphereGeometry(r, 20, 14);
      appendBufferGeometry(out, geo, matrix);
      geo.dispose();
      return;
    }
    case 'ellipsoid': {
      const rx = s[0] ?? 0, ry = s[1] ?? 0, rz = s[2] ?? 0;
      if (!(rx > 0 && ry > 0 && rz > 0)) return;
      const geo = new THREE.SphereGeometry(1, 20, 14);
      const scaled = matrix.clone().scale(new THREE.Vector3(rx, ry, rz));
      appendBufferGeometry(out, geo, scaled);
      geo.dispose();
      return;
    }
    case 'cylinder': {
      const r = s[0] ?? 0;
      let halfLen = s[1] ?? 0;
      if (geom.fromto && geom.fromto.length >= 6) {
        const ft = fromtoFrame(geom.fromto);
        matrix = ft.matrix;
        halfLen = ft.halfLen;
      }
      if (!(r > 0 && halfLen > 0)) return;
      // Three.js CylinderGeometry stands along +Y; rotate +90° about X so axis is +Z.
      const geo = new THREE.CylinderGeometry(r, r, 2 * halfLen, 24, 1);
      geo.rotateX(Math.PI / 2);
      appendBufferGeometry(out, geo, matrix);
      geo.dispose();
      return;
    }
    case 'capsule': {
      const r = s[0] ?? 0;
      let halfLen = s[1] ?? 0;
      if (geom.fromto && geom.fromto.length >= 6) {
        const ft = fromtoFrame(geom.fromto);
        matrix = ft.matrix;
        halfLen = ft.halfLen;
      }
      if (!(r > 0)) return;
      const geo = new THREE.CapsuleGeometry(r, Math.max(0, 2 * halfLen), 8, 16);
      geo.rotateX(Math.PI / 2);
      appendBufferGeometry(out, geo, matrix);
      geo.dispose();
      return;
    }
    case 'mesh': {
      const faces = geom.faces;
      if (!faces || faces.length < 3) return;
      const zup = geom.renderVertices;
      const yup = geom.vertices;
      if (!zup?.length && !yup?.length) return;
      const v = new THREE.Vector3();
      const hasPose = !!(geom.pos || geom.quat || geom.euler);
      for (let i = 0; i + 2 < faces.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          const vi = faces[i + k] * 3;
          if (zup?.length) {
            v.set(zup[vi], zup[vi + 1], zup[vi + 2]);
          } else {
            // Y-up (x, y, z) -> Z-up (x, -z, y)
            v.set(yup![vi], -yup![vi + 2], yup![vi + 1]);
          }
          if (hasPose) v.applyMatrix4(matrix);
          out.push(v.x, v.y, v.z);
        }
      }
      return;
    }
    default:
      return;
  }
}

function soupSignedVolume(tris: Float64Array): number {
  let vol6 = 0;
  for (let i = 0; i + 8 < tris.length; i += 9) {
    const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
    const bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5];
    const cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];
    vol6 += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return vol6 / 6;
}

/**
 * Builds an open-vessel hull envelope when a body encloses an open-top air
 * cavity (cup, bowl, rowboat): solidity < 0.88 and an upward/side opening.
 */
function buildVesselEnvelope(solidTris: Float64Array, solidVol: number): HydroBodyModel['vessel'] | undefined {
  if (solidTris.length < 36 || solidTris.length > 90_000 || !(solidVol > 1e-9)) return undefined;

  const pts: THREE.Vector3[] = [];
  let minZ = Infinity, maxZ = -Infinity;
  const step = Math.max(1, Math.floor((solidTris.length / 3) / 1200));
  for (let i = 0; i < solidTris.length; i += 3 * step) {
    const x = solidTris[i], y = solidTris[i + 1], z = solidTris[i + 2];
    pts.push(new THREE.Vector3(x, y, z));
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (pts.length < 8 || !(maxZ - minZ > 1e-4)) return undefined;

  let hull: ConvexHull;
  try {
    hull = new ConvexHull().setFromPoints(pts);
  } catch {
    return undefined;
  }
  const hullOut: number[] = [];
  for (const face of hull.faces) {
    let edge = face.edge;
    const verts: THREE.Vector3[] = [];
    do {
      verts.push(edge.head().point);
      edge = edge.next;
    } while (edge !== face.edge && verts.length < 64);
    for (let k = 1; k + 1 < verts.length; k++) {
      hullOut.push(
        verts[0].x, verts[0].y, verts[0].z,
        verts[k].x, verts[k].y, verts[k].z,
        verts[k + 1].x, verts[k + 1].y, verts[k + 1].z,
      );
    }
  }
  const hullTris = new Float64Array(hullOut);
  const hullVolume = Math.abs(soupSignedVolume(hullTris));
  if (!(hullVolume > 0)) return undefined;

  const solidity = solidVol / hullVolume;
  if (solidity >= 0.88) return undefined;

  // Verify the cavity actually opens near the top (not a sealed hollow sphere):
  // find the convex-hull cap face(s) spanning empty air — hull triangles whose
  // centroid lies far from ANY solid surface triangle are the open mouth of the vessel!
  const pointToTriSq = (
    px: number, py: number, pz: number,
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    x3: number, y3: number, z3: number,
  ): number => {
    const abx = x2 - x1, aby = y2 - y1, abz = z2 - z1;
    const acx = x3 - x1, acy = y3 - y1, acz = z3 - z1;
    const apx = px - x1, apy = py - y1, apz = pz - z1;
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;

    const bpx = px - x2, bpy = py - y2, bpz = pz - z2;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;

    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      const v = d1 / (d1 - d3);
      const qx = x1 + v * abx - px, qy = y1 + v * aby - py, qz = z1 + v * abz - pz;
      return qx * qx + qy * qy + qz * qz;
    }

    const cpx = px - x3, cpy = py - y3, cpz = pz - z3;
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;

    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      const w = d2 / (d2 - d6);
      const qx = x1 + w * acx - px, qy = y1 + w * acy - py, qz = z1 + w * acz - pz;
      return qx * qx + qy * qy + qz * qz;
    }

    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
      const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
      const qx = x2 + w * (x3 - x2) - px, qy = y2 + w * (y3 - y2) - py, qz = z2 + w * (z3 - z2) - pz;
      return qx * qx + qy * qy + qz * qz;
    }

    const denom = 1 / (va + vb + vc);
    const v = vb * denom;
    const w = vc * denom;
    const qx = x1 + abx * v + acx * w - px;
    const qy = y1 + aby * v + acy * w - py;
    const qz = z1 + abz * v + acz * w - pz;
    return qx * qx + qy * qy + qz * qz;
  };

  const rimCoords: number[] = [];
  const height = maxZ - minZ;
  const airGapSq = Math.pow(Math.max(0.002, height * 0.08), 2);
  let openMouthArea = 0;

  for (let i = 0; i + 8 < hullTris.length; i += 9) {
    const ax = hullTris[i], ay = hullTris[i + 1], az = hullTris[i + 2];
    const bx = hullTris[i + 3], by = hullTris[i + 4], bz = hullTris[i + 5];
    const cx = hullTris[i + 6], cy = hullTris[i + 7], cz = hullTris[i + 8];
    const mx = (ax + bx + cx) / 3;
    const my = (ay + by + cy) / 3;
    const mz = (az + bz + cz) / 3;

    let nearestSq = Infinity;
    for (let j = 0; j + 8 < solidTris.length; j += 9) {
      const d2 = pointToTriSq(
        mx, my, mz,
        solidTris[j], solidTris[j + 1], solidTris[j + 2],
        solidTris[j + 3], solidTris[j + 4], solidTris[j + 5],
        solidTris[j + 6], solidTris[j + 7], solidTris[j + 8],
      );
      if (d2 < nearestSq) {
        nearestSq = d2;
        if (d2 < airGapSq) break;
      }
    }
    if (nearestSq >= airGapSq) {
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      openMouthArea += 0.5 * Math.hypot(nx, ny, nz);
      rimCoords.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    }
  }

  // Sealed hollow drum has openMouthArea === 0: its solidTris already enclose the
  // sealed void (inward inner shell), so solidTris alone already displaces the whole drum!
  if (!(openMouthArea > 1e-6) || rimCoords.length === 0) return undefined;

  // Deduplicate rim points
  const seen = new Set<string>();
  const uniqueRim: number[] = [];
  for (let i = 0; i + 2 < rimCoords.length; i += 3) {
    const key = `${Math.round(rimCoords[i] * 2000)},${Math.round(rimCoords[i + 1] * 2000)},${Math.round(rimCoords[i + 2] * 2000)}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueRim.push(rimCoords[i], rimCoords[i + 1], rimCoords[i + 2]);
    }
  }

  return {
    hullTris,
    hullVolume,
    rimPoints: new Float64Array(uniqueRim),
    spillBandM: Math.max(0.004, height * 0.12),
  };
}

/**
 * Builds the body-frame hydrostatic model for one `SceneNode` (including any
 * fixed child bodies that move rigidly with it when they have no joints).
 */
export function buildHydroBodyModel(node: SceneNode): HydroBodyModel | null {
  if (node.simulation) return null;
  const geoms = node.csgEnabled
    ? (node.geoms || []).filter((g) => g.csgDerived === 'visual')
    : (node.geoms || []);
  const sourceGeoms = geoms.length > 0 ? geoms : (node.geoms || []);

  const rawTris: number[] = [];
  for (const g of sourceGeoms) {
    geomHydroTriangles(g, rawTris);
  }
  // Include welded jointless child bodies (e.g. ballast nuts or compound keel) in parent frame
  const addFixedChildren = (children: SceneNode[], parentMat: THREE.Matrix4) => {
    for (const ch of children) {
      if ((ch.joints?.length ?? 0) > 0 || ch.simulation || ch.hardwarePart) continue;
      const m = geomMatrixOf({
        name: ch.id,
        type: 'box',
        size: [1, 1, 1],
        pos: ch.pos,
        quat: ch.quat,
        euler: ch.euler,
      });
      const worldInRoot = parentMat.clone().multiply(m);
      const childTris: number[] = [];
      const childGeoms = ch.csgEnabled
        ? (ch.geoms || []).filter((g) => g.csgDerived === 'visual')
        : (ch.geoms || []);
      for (const g of (childGeoms.length ? childGeoms : (ch.geoms || []))) {
        geomHydroTriangles(g, childTris);
      }
      const v = new THREE.Vector3();
      for (let i = 0; i + 2 < childTris.length; i += 3) {
        v.set(childTris[i], childTris[i + 1], childTris[i + 2]).applyMatrix4(worldInRoot);
        rawTris.push(v.x, v.y, v.z);
      }
      if (ch.children?.length) addFixedChildren(ch.children, worldInRoot);
    }
  };
  if (node.children?.length) addFixedChildren(node.children, new THREE.Matrix4());

  if (rawTris.length < 9) return null;
  const solidTris = new Float64Array(rawTris);
  let solidVolume = soupSignedVolume(solidTris);
  if (solidVolume < 0) {
    // Flip inverted winding so outward normals point out of solid
    for (let i = 0; i + 8 < solidTris.length; i += 9) {
      const tx = solidTris[i + 3], ty = solidTris[i + 4], tz = solidTris[i + 5];
      solidTris[i + 3] = solidTris[i + 6];
      solidTris[i + 4] = solidTris[i + 7];
      solidTris[i + 5] = solidTris[i + 8];
      solidTris[i + 6] = tx;
      solidTris[i + 7] = ty;
      solidTris[i + 8] = tz;
    }
    solidVolume = -solidVolume;
  }
  if (!(solidVolume > 1e-12)) return null;

  return {
    nodeId: node.id,
    solidTris,
    solidVolume,
    vessel: buildVesselEnvelope(solidTris, solidVolume),
  };
}

/** Evaluates submerged volume, CoB, and vessel flooding at a given pose and waterLevel. */
export function evaluateSubmerged(
  hydro: HydroBodyModel,
  pos: ArrayLike<number>,
  xmat: ArrayLike<number>,
  waterLevel: number,
): SubmergedResult {
  const solid = integrateSubmergedTris(hydro.solidTris, pos, xmat, waterLevel);
  if (!hydro.vessel) {
    return { volume: solid.volume, cob: solid.cob, floodedFraction: 0 };
  }

  // Check lowest rim point in world Z to see if water spills over the gunwale
  const { rimPoints, spillBandM, hullTris } = hydro.vessel;
  const pz = pos[2];
  const r20 = xmat[6], r21 = xmat[7], r22 = xmat[8];
  let minRimZ = Infinity;
  for (let i = 0; i + 2 < rimPoints.length; i += 3) {
    const wz = pz + r20 * rimPoints[i] + r21 * rimPoints[i + 1] + r22 * rimPoints[i + 2];
    if (wz < minRimZ) minRimZ = wz;
  }

  const flooded = Math.max(0, Math.min(1, (waterLevel - minRimZ) / spillBandM));
  if (flooded >= 0.999) {
    return { volume: solid.volume, cob: solid.cob, floodedFraction: 1 };
  }

  const hull = integrateSubmergedTris(hullTris, pos, xmat, waterLevel);
  if (hull.volume <= solid.volume) {
    return { volume: solid.volume, cob: solid.cob, floodedFraction: flooded };
  }

  const airFraction = 1 - flooded;
  const vol = solid.volume + airFraction * (hull.volume - solid.volume);
  const wHull = (airFraction * (hull.volume - solid.volume)) / vol;
  const wSolid = 1 - wHull;
  return {
    volume: vol,
    cob: [
      wSolid * solid.cob[0] + wHull * hull.cob[0],
      wSolid * solid.cob[1] + wHull * hull.cob[1],
      wSolid * solid.cob[2] + wHull * hull.cob[2],
    ],
    floodedFraction: flooded,
  };
}

/**
 * Full 6-DOF Archimedes buoyancy + clamped quadratic water drag wrench about a
 * body's centre of mass `xipos`.
 */
export function computeBuoyancyWrench(
  hydro: HydroBodyModel,
  pos: ArrayLike<number>,
  xmat: ArrayLike<number>,
  xipos: ArrayLike<number>,
  velAtCom: ArrayLike<number>,
  angVelWorld: ArrayLike<number>,
  massKg: number,
  inertiaDiag: ArrayLike<number>,
  waterLevel: number,
  gravityZ: number,
  timestep: number,
  fluidDensity = FRESHWATER_DENSITY,
): BuoyancyWrench {
  const sub = evaluateSubmerged(hydro, pos, xmat, waterLevel);
  if (!(sub.volume > 1e-12)) {
    return {
      submergedVolume: 0,
      cob: sub.cob,
      floodedFraction: sub.floodedFraction,
      force: [0, 0, 0],
      torque: [0, 0, 0],
    };
  }

  // Upward buoyant force opposing gravityZ (for gravityZ = -9.81, F_bz = +rho * V * 9.81)
  const fBuoyZ = -fluidDensity * sub.volume * gravityZ;
  const rx = sub.cob[0] - xipos[0];
  const ry = sub.cob[1] - xipos[1];
  const rz = sub.cob[2] - xipos[2];

  // Velocity at Centre of Buoyancy: v_cob = v_com + w x r
  const wx = angVelWorld[0], wy = angVelWorld[1], wz = angVelWorld[2];
  const vcx = velAtCom[0] + (wy * rz - wz * ry);
  const vcy = velAtCom[1] + (wz * rx - wx * rz);
  const vcz = velAtCom[2] + (wx * ry - wy * rx);
  const speed = Math.hypot(vcx, vcy, vcz);

  // Characteristic wetted area A_eff ~ V^(2/3), Cd ~ 0.9 + linear Stokes/wave damping
  const areaEff = Math.pow(sub.volume, 2 / 3);
  const dt = Math.max(1e-4, timestep);
  let fdx = 0, fdy = 0, fdz = 0;
  if (speed > 1e-5) {
    const rawDragMag = 0.5 * fluidDensity * 0.9 * areaEff * speed * speed + 18 * areaEff * speed;
    // Clamp impulse to <= 35% of body momentum per step so ultra-light corks never invert velocity
    const maxSafeForce = (0.35 * Math.max(1e-4, massKg) * speed) / dt;
    const dragMag = Math.min(rawDragMag, maxSafeForce);
    fdx = (-vcx / speed) * dragMag;
    fdy = (-vcy / speed) * dragMag;
    fdz = (-vcz / speed) * dragMag;
  }

  const fx = fdx;
  const fy = fdy;
  const fz = fBuoyZ + fdz;

  // Torque from buoyancy + drag acting at CoB relative to CoM: r x F
  let tx = ry * fz - rz * fy;
  let ty = rz * fx - rx * fz;
  let tz = rx * fy - ry * fx;

  // Rotational water damping (essential so boats settle roll/pitch smoothly)
  const wMag = Math.hypot(wx, wy, wz);
  if (wMag > 1e-5) {
    const rotCoeff = 2.5 * fluidDensity * Math.pow(sub.volume, 5 / 3);
    const rawRotTorque = rotCoeff * (1 + 0.6 * wMag) * wMag;
    const iMean = Math.max(1e-7, (inertiaDiag[0] + inertiaDiag[1] + inertiaDiag[2]) / 3);
    const maxSafeTorque = (0.35 * iMean * wMag) / dt;
    const dampTorque = Math.min(rawRotTorque, maxSafeTorque);
    tx -= (wx / wMag) * dampTorque;
    ty -= (wy / wMag) * dampTorque;
    tz -= (wz / wMag) * dampTorque;
  }

  return {
    submergedVolume: sub.volume,
    cob: sub.cob,
    floodedFraction: sub.floodedFraction,
    force: [fx, fy, fz],
    torque: [tx, ty, tz],
  };
}

/** Quick helper used by static stability readouts: exact mesh volume & centroid. */
export { meshVolumeAndCentroid };
