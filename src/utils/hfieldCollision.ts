// Automatic and explicit MuJoCo <hfield> heightfield collision for static 2.5D
// relief and terrain meshes.
//
// A 2.5D relief (like California terrain, a carved plaque, or a mold half) is a
// single-valued height surface z = f(x, y) over XY. Sending it through V-HACD
// produces hundreds of approximate convex hulls and can take 60+ seconds (or
// time out and fall back to a convex hull lid). MuJoCo's native <hfield>
// primitive collides directly against a 2D height grid in O(1) per contact,
// rasterises in a few milliseconds, and has zero filled cavities.
//
// Pure, worker-free module so both Vitest and the app can call it directly.

import type { SceneGeom } from '../types/scene';

/** Minimum triangle count for automatic <hfield> selection (simple prisms stay on exact reflex cuts). */
export const MIN_HFIELD_TRIANGLES = 200;

/** Minimum XY AABB coverage for an elevated (non-grounded) 2.5D mesh to qualify automatically. */
export const HFIELD_MIN_XY_COVERAGE = 0.95;

/** Maximum |worldMinZ| (metres) for an irregular 2.5D silhouette to count as grounded on z = 0. */
export const HFIELD_GROUNDED_TOL_M = 0.005;

/** Default maximum grid dimension (nrow or ncol) for rasterized heightfields. */
export const MAX_HFIELD_DIM = 128;

/** Normal Z threshold separating vertical side walls from upward/downward faces. */
const WALL_NZ_TOL = 0.05;

/** Normal Z threshold for a flat bottom cap. */
const BOTTOM_CAP_NZ = -0.95;

export interface HfieldBBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface HfieldEligibilityResult {
  eligible: boolean;
  reason:
    | 'eligible-rectangular'
    | 'eligible-grounded'
    | 'not-static'
    | 'too-coarse'
    | 'degenerate'
    | 'overhang'
    | 'multi-layer'
    | 'flat-stepped'
    | 'elevated-irregular';
  triangles: number;
  xyCoverage: number;
  worldMinZ: number;
  bbox: HfieldBBox;
}

export interface HfieldRasterResult {
  nrow: number;
  ncol: number;
  /** Row-major [row * ncol + col], row 0 = -Y, col 0 = -X, normalized in [0, 1]. */
  data: number[];
  /** Body-local Z-up center of XY footprint and Z of the elevation=0 plane. */
  pos: [number, number, number];
  /** MuJoCo hfield size: [radius_x, radius_y, elevation_z, base_z]. */
  size: [number, number, number, number];
  /** True if two upward-facing triangles overlapped at the same (x, y) with different Z heights. */
  hasMultiLayerOverlap: boolean;
}

export function computeVertsBBox(verts: ArrayLike<number>): HfieldBBox {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i + 2 < verts.length; i += 3) {
    const x = verts[i], y = verts[i + 1], z = verts[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

/** Minimum world Z of a body-local bbox under worldPos and worldQuat [w, x, y, z]. */
function worldBBoxMinZ(
  bbox: HfieldBBox,
  worldPos: readonly number[] = [0, 0, 0],
  worldQuat: readonly number[] = [1, 0, 0, 0],
): number {
  const tz = worldPos[2] ?? 0;
  let [w, qx, qy, qz] = worldQuat;
  const n = Math.hypot(w, qx, qy, qz) || 1;
  w /= n; qx /= n; qy /= n; qz /= n;
  const rotated = Math.abs(qx) > 1e-7 || Math.abs(qy) > 1e-7 || Math.abs(qz) > 1e-7;
  if (!rotated) return bbox.minZ + tz;

  let minWorldZ = Infinity;
  const xs = [bbox.minX, bbox.maxX];
  const ys = [bbox.minY, bbox.maxY];
  const zs = [bbox.minZ, bbox.maxZ];
  for (const x of xs) {
    for (const y of ys) {
      for (const z of zs) {
        // Rotate (x, y, z) by unit quaternion (w, qx, qy, qz), keep Z component.
        const cx = qy * z - qz * y;
        const cy = qz * x - qx * z;
        const cz = qx * y - qy * x;
        const dz = qx * cy - qy * cx;
        const wz = z + 2 * (w * cz + dz) + tz;
        if (wz < minWorldZ) minWorldZ = wz;
      }
    }
  }
  return minWorldZ;
}

/**
 * Fast O(triangles) geometric check for whether a body-frame Z-up mesh
 * qualifies automatically for MuJoCo <hfield> collision.
 *
 * All four gates must pass:
 * 1. Static body (no joints and not nested under a moving parent).
 * 2. Non-trivial triangle count (>= MIN_HFIELD_TRIANGLES).
 * 3. Strictly 2.5D: every triangle is either a top/sloped surface (nz > 0.05),
 *    a vertical wall (|nz| <= 0.05), or a flat bottom cap (nz < -0.95 at minZ).
 * 4. No invisible floating shelf outside the silhouette: XY coverage >= 95%
 *    OR resting near the ground plane (|worldMinZ| <= 5 mm).
 *
 * Overlapping top-surface layers at different Z heights are caught by
 * `rasterizeHeightfield().hasMultiLayerOverlap`.
 */
export function checkHfieldEligibility(
  verts: ArrayLike<number>,
  faces: ArrayLike<number>,
  opts: {
    isStatic: boolean;
    worldPos?: readonly number[];
    worldQuat?: readonly number[];
    skipMinTriangles?: boolean;
  },
): HfieldEligibilityResult {
  const triangles = Math.floor(faces.length / 3);
  const bbox = computeVertsBBox(verts);
  const worldMinZ = Number.isFinite(bbox.minZ)
    ? worldBBoxMinZ(bbox, opts.worldPos, opts.worldQuat)
    : Infinity;

  if (!opts.isStatic) {
    return { eligible: false, reason: 'not-static', triangles, xyCoverage: 0, worldMinZ, bbox };
  }
  if (!opts.skipMinTriangles && triangles < MIN_HFIELD_TRIANGLES) {
    return { eligible: false, reason: 'too-coarse', triangles, xyCoverage: 0, worldMinZ, bbox };
  }

  const dx = bbox.maxX - bbox.minX;
  const dy = bbox.maxY - bbox.minY;
  const dz = bbox.maxZ - bbox.minZ;
  if (!(dx > 1e-6) || !(dy > 1e-6) || !(dz > 1e-6)) {
    return { eligible: false, reason: 'degenerate', triangles, xyCoverage: 0, worldMinZ, bbox };
  }

  const bottomTol = Math.max(1e-4, dz * 0.005);
  let topProjectedArea = 0;
  let slopedTopArea = 0;

  for (let i = 0; i + 2 < faces.length; i += 3) {
    const i0 = faces[i] * 3;
    const i1 = faces[i + 1] * 3;
    const i2 = faces[i + 2] * 3;
    const x0 = verts[i0], y0 = verts[i0 + 1], z0 = verts[i0 + 2];
    const x1 = verts[i1], y1 = verts[i1 + 1], z1 = verts[i1 + 2];
    const x2 = verts[i2], y2 = verts[i2 + 1], z2 = verts[i2 + 2];

    const e1x = x1 - x0, e1y = y1 - y0, e1z = z1 - z0;
    const e2x = x2 - x0, e2y = y2 - y0, e2z = z2 - z0;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;

    const unitNz = nz / len;
    if (unitNz > WALL_NZ_TOL) {
      const proj = 0.5 * nz;
      topProjectedArea += proj;
      if (unitNz < 0.999) slopedTopArea += proj;
    } else if (unitNz < -WALL_NZ_TOL) {
      // Only a flat bottom cap lying at bbox.minZ is permitted.
      const isFlatBottom =
        unitNz < BOTTOM_CAP_NZ
        && z0 <= bbox.minZ + bottomTol
        && z1 <= bbox.minZ + bottomTol
        && z2 <= bbox.minZ + bottomTol;
      if (!isFlatBottom) {
        return { eligible: false, reason: 'overhang', triangles, xyCoverage: 0, worldMinZ, bbox };
      }
    }
  }

  const aabbArea = dx * dy;
  const xyCoverage = aabbArea > 0 ? topProjectedArea / aabbArea : 0;

  if (xyCoverage <= 0) {
    return { eligible: false, reason: 'degenerate', triangles, xyCoverage, worldMinZ, bbox };
  }
  // If total projected top area exceeds the XY AABB by more than 1%, multiple
  // upward-facing layers must overlap in XY (e.g. stacked shelves).
  if (xyCoverage > 1.01) {
    return { eligible: false, reason: 'multi-layer', triangles, xyCoverage, worldMinZ, bbox };
  }
  // A true 2.5D relief/terrain has sloped top faces, not purely flat horizontal
  // surfaces joined by vertical walls (like a straight-walled cylindrical cup
  // or open-top box, which belong to exact sector/reflex cuts).
  if (slopedTopArea / topProjectedArea < 0.01) {
    return { eligible: false, reason: 'flat-stepped', triangles, xyCoverage, worldMinZ, bbox };
  }

  if (xyCoverage >= HFIELD_MIN_XY_COVERAGE) {
    return { eligible: true, reason: 'eligible-rectangular', triangles, xyCoverage, worldMinZ, bbox };
  }
  if (Math.abs(worldMinZ) <= HFIELD_GROUNDED_TOL_M) {
    return { eligible: true, reason: 'eligible-grounded', triangles, xyCoverage, worldMinZ, bbox };
  }

  return { eligible: false, reason: 'elevated-irregular', triangles, xyCoverage, worldMinZ, bbox };
}

/**
 * Rasterizes the upward-facing surface of a body-frame Z-up mesh onto an
 * `nrow × ncol` MuJoCo heightfield grid.
 *
 * Grid conventions match MuJoCo's `<hfield>`:
 * - `row = 0` is `minY` (`-Y`), `row = nrow - 1` is `maxY` (`+Y`)
 * - `col = 0` is `minX` (`-X`), `col = ncol - 1` is `maxX` (`+X`)
 * - Row-major index `row * ncol + col`, normalized to `[0, 1]`
 * - `pos = [centerX, centerY, zLow]` (elevation 0 sits at `zLow`)
 * - `size = [radiusX, radiusY, elevZ, baseZ]`
 */
export function rasterizeHeightfield(
  verts: ArrayLike<number>,
  faces: ArrayLike<number>,
  opts: { maxDim?: number } = {},
): HfieldRasterResult | null {
  const bbox = computeVertsBBox(verts);
  const dx = bbox.maxX - bbox.minX;
  const dy = bbox.maxY - bbox.minY;
  const dz = bbox.maxZ - bbox.minZ;
  if (!(dx > 1e-6) || !(dy > 1e-6) || !(dz > 0)) return null;

  const maxDim = Math.max(2, Math.min(256, Math.round(opts.maxDim ?? MAX_HFIELD_DIM)));
  let ncol: number;
  let nrow: number;
  if (dx >= dy) {
    ncol = maxDim;
    nrow = Math.max(2, Math.round(maxDim * (dy / dx)));
  } else {
    nrow = maxDim;
    ncol = Math.max(2, Math.round(maxDim * (dx / dy)));
  }

  const total = nrow * ncol;
  const grid = new Float32Array(total);
  grid.fill(-Infinity);

  const stepX = dx / (ncol - 1);
  const stepY = dy / (nrow - 1);
  const invStepX = 1 / stepX;
  const invStepY = 1 / stepY;
  const overlapTol = Math.max(2e-4, dz * 0.01);
  let hasMultiLayerOverlap = false;

  for (let i = 0; i + 2 < faces.length; i += 3) {
    const i0 = faces[i] * 3;
    const i1 = faces[i + 1] * 3;
    const i2 = faces[i + 2] * 3;
    const x0 = verts[i0], y0 = verts[i0 + 1], z0 = verts[i0 + 2];
    const x1 = verts[i1], y1 = verts[i1 + 1], z1 = verts[i1 + 2];
    const x2 = verts[i2], y2 = verts[i2 + 1], z2 = verts[i2 + 2];

    const e1x = x1 - x0, e1y = y1 - y0, e1z = z1 - z0;
    const e2x = x2 - x0, e2y = y2 - y0, e2z = z2 - z0;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12 || nz / len <= WALL_NZ_TOL) continue;

    // 2D barycentric denominator in XY (equals nz > 0 for upward-facing CCW triangles).
    const det = e1x * e2y - e2x * e1y;
    if (Math.abs(det) < 1e-14) continue;
    const invDet = 1 / det;

    const tMinX = Math.min(x0, x1, x2);
    const tMaxX = Math.max(x0, x1, x2);
    const tMinY = Math.min(y0, y1, y2);
    const tMaxY = Math.max(y0, y1, y2);

    const c0 = Math.max(0, Math.floor((tMinX - bbox.minX) * invStepX));
    const c1 = Math.min(ncol - 1, Math.ceil((tMaxX - bbox.minX) * invStepX));
    const r0 = Math.max(0, Math.floor((tMinY - bbox.minY) * invStepY));
    const r1 = Math.min(nrow - 1, Math.ceil((tMaxY - bbox.minY) * invStepY));

    for (let r = r0; r <= r1; r++) {
      const gy = bbox.minY + r * stepY;
      const py = gy - y0;
      const rowOff = r * ncol;
      for (let c = c0; c <= c1; c++) {
        const gx = bbox.minX + c * stepX;
        const px = gx - x0;
        const u = (px * e2y - e2x * py) * invDet;
        const v = (e1x * py - px * e1y) * invDet;
        const w = 1 - u - v;
        if (u >= -1e-5 && v >= -1e-5 && w >= -1e-5) {
          const z = w * z0 + u * z1 + v * z2;
          const idx = rowOff + c;
          const prev = grid[idx];
          if (prev > -Infinity) {
            if (Math.abs(z - prev) > overlapTol) hasMultiLayerOverlap = true;
            if (z > prev) grid[idx] = z;
          } else {
            grid[idx] = z;
          }
        }
      }
    }
  }

  let zLow = Infinity;
  let zHigh = -Infinity;
  for (let i = 0; i < total; i++) {
    if (grid[i] === -Infinity) grid[i] = bbox.minZ;
    if (grid[i] < zLow) zLow = grid[i];
    if (grid[i] > zHigh) zHigh = grid[i];
  }

  const elevZ = zHigh - zLow > 1e-5 ? zHigh - zLow : 1e-4;
  const invElev = 1 / elevZ;
  const data = new Array<number>(total);
  for (let i = 0; i < total; i++) {
    const h = (grid[i] - zLow) * invElev;
    data[i] = h <= 0 ? 0 : h >= 1 ? 1 : h;
  }

  // Base extends down from zLow to bbox.minZ (or at least 2 mm so MuJoCo's
  // base_z > 0 requirement is satisfied and thin floors don't tunnel).
  const baseZ = Math.max(0.002, zLow - bbox.minZ);
  const cx = 0.5 * (bbox.minX + bbox.maxX);
  const cy = 0.5 * (bbox.minY + bbox.maxY);

  return {
    nrow,
    ncol,
    data,
    pos: [+cx.toFixed(6), +cy.toFixed(6), +zLow.toFixed(6)],
    size: [+(0.5 * dx).toFixed(6), +(0.5 * dy).toFixed(6), +elevZ.toFixed(6), +baseZ.toFixed(6)],
    hasMultiLayerOverlap,
  };
}

/** Builds a derived collision-only SceneGeom for a rasterized heightfield. */
export function hfieldToColliderGeom(
  raster: HfieldRasterResult,
  name: string,
  sourceName: string,
  template?: Partial<SceneGeom>,
): SceneGeom {
  return {
    ...(template ?? {}),
    name,
    type: 'hfield',
    role: 'collision',
    csgDerived: 'collider',
    colliderOf: sourceName,
    pos: raster.pos,
    size: raster.size,
    hfield: {
      nrow: raster.nrow,
      ncol: raster.ncol,
      data: raster.data,
    },
    mass: 0,
    density: undefined,
    quat: undefined,
    euler: undefined,
    vertices: undefined,
    faces: undefined,
    renderVertices: undefined,
    fromto: undefined,
  };
}
