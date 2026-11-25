// ---------------------------------------------------------------------------
// Universal 3D Geometry-Driven Structural & Cavity Acoustics
// ---------------------------------------------------------------------------
//
// Evaluates ANY 3D body (analytic primitives, arbitrary CSG boolean unions /
// differences / intersections, multi-plank shells, imported STLs, or freehand
// Sculpt-mode meshes) via fast 2D-binned ray-interval calculus:
//
// 1. Cross-Sectional Variational Beam / Plate / Shell Solver:
//    - Slices the actual post-CSG / post-Sculpt 3D solid at 48 stations to
//      integrate true cross-sectional area A(s), neutral axis z_c(s), and
//      second moments of area I_thick(s), I_width(s).
//    - Solves the 12-basis Legendre Rayleigh–Ritz generalized eigenproblem
//      K v = ω² M v (with Timoshenko shear + rotary inertia correction) and
//      returns both eigenfrequencies and normalized Legendre mode shapes ψ_m(ξ)
//      so impacts at ξ_hit excite each mode according to |ψ_m(ξ_hit)|.
//
// 2. Multi-Port 3D Cavity & Soundboard Analyzer:
//    - Classifies 3D interior cavity air vs solid walls vs open ports across
//      all 3 orthogonal ray pencils (refining each detected port with a local
//      sub-grid), measuring cavity volume V, wall/soundboard thickness h_top,
//      every individual hole/port (CSG or Sculpt!), and total parallel
//      Rayleigh conductance G_total = Σ A_p / (L_p + 1.7 r_p).
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { SceneGeom, SceneNode } from '../types/scene';
import { fromtoFrame, geomMatrixOf } from './csg';

export type Interval1D = [number, number];

interface MeshBinGrid2D {
  axis: 0 | 1 | 2; // ray direction axis in geom-local frame
  uAxis: 0 | 1 | 2;
  vAxis: 0 | 1 | 2;
  uMin: number;
  vMin: number;
  invDu: number;
  invDv: number;
  nBins: number;
  bins: Int32Array[];
}

interface PreparedSolidGeom {
  op: 'union' | 'difference' | 'intersection';
  type: SceneGeom['type'];
  size: number[];
  invMat: Float64Array; // 16-element column-major inverse of geom-to-body matrix
  detScale: number;
  verts?: ArrayLike<number>;
  faces?: ArrayLike<number>;
  localBounds: [number, number, number, number, number, number]; // minX,maxX,minY,maxY,minZ,maxZ in body frame
  meshGrids?: Map<number, MeshBinGrid2D>;
}

export interface NodeRayCsgGroup {
  positives: PreparedSolidGeom[];
  differences: PreparedSolidGeom[];
  intersections: PreparedSolidGeom[];
}

export interface BodyRayScene {
  positives: PreparedSolidGeom[];
  differences: PreparedSolidGeom[];
  intersections: PreparedSolidGeom[];
  nodeGroups?: NodeRayCsgGroup[];
  bounds: [number, number, number, number, number, number];
}

export interface VariableSectionEigenResult {
  frequenciesHz: number[];
  /** Legendre polynomial coefficients c_{m,0..nBasis-1} for each elastic mode m, normalized so max |ψ_m(ξ)| ≈ 1. */
  modeVectors: number[][];
}

export interface Solid3DSectionAnalysis {
  /** Post-CSG / post-Sculpt non-empty solid dimensions sorted ascending: [hMin, bMid, lMax]. */
  dimsSortedAsc: [number, number, number];
  /** Corresponding body-local axes [thickAxis, widthAxis, lenAxis]. */
  axisOrderAsc: [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2];
  /** Actual non-empty solid span [sMin, sMax] along lenAxis (or principalLenDir when oriented). */
  lenBounds: [number, number];
  /** Actual non-empty solid span [wMin, wMax] along widthAxis. */
  widthBounds: [number, number];
  /** Unit principal longitudinal direction in body-local Z-up frame (present when a single solid geom is rotated / `fromto`). */
  principalLenDir?: [number, number, number];
  /** Body-local Z-up origin for `principalLenDir` projection when oriented. */
  principalOrigin?: [number, number, number];
  /** Integrated 3D solid material volume (m³). */
  solidVolumeM3: number;
  /** Fraction of interior cross-sectional rays that pierce >= 2 separated walls (hollow tube/shell/bell/box). */
  hollowFraction: number;
  /** Mean thickness of individual solid walls (m) when hollow, or mean thickness overall. */
  meanWallThicknessM: number;
  /** 48-station cross-sectional area A(s) (m²) along lenAxis. */
  areaProfile: Float64Array;
  /** 48-station thickness-bending second moment I_thick(s) (m⁴) about local neutral axis. */
  inertiaThickProfile: Float64Array;
  /** 48-station width-bending second moment I_width(s) (m⁴) about local neutral axis. */
  inertiaWidthProfile: Float64Array;
  /** Secondary (widthAxis) 32-station profiles for 2D Kirchhoff plate / shell coupling. */
  transverseAreaProfile: Float64Array;
  transverseInertiaProfile: Float64Array;
  /** True when the body consists of a single small solid sphere without cavities or cuts. */
  isPureSolidSphere: boolean;
}

export interface DetectedPort3D {
  areaM2: number;
  eqRadiusM: number;
  neckLengthM: number;
  conductanceM: number;
  normalAxis?: 0 | 1 | 2;
  sideSign?: 1 | -1;
}

export interface Cavity3DAnalysis {
  hasHollowCavity: boolean;
  isOpenCupOrShell: boolean;
  cavityVolumeM3: number;
  solidVolumeM3: number;
  topPlateThicknessM: number;
  meanWallThicknessM: number;
  plateSpanAM: number;
  plateSpanBM: number;
  ports: DetectedPort3D[];
  totalConductanceM: number;
  openAreaFraction: number;
  cavityRegime?: 'helmholtz' | 'quarter_wave_tube' | 'half_wave_tube' | 'open_shell' | 'sealed';
  airResonanceHz?: number | null;
}

// ---------------------------------------------------------------------------
// 1D CSG Interval Operations
// ---------------------------------------------------------------------------

function normalizeIntervals(raw: Interval1D[]): Interval1D[] {
  const n = raw.length;
  if (n === 0) return raw;
  if (n === 1) {
    const iv = raw[0];
    return iv[1] > iv[0] + 1e-9 ? raw : [];
  }
  raw.sort((a, b) => a[0] - b[0]);
  const out: Interval1D[] = [];
  for (let i = 0; i < n; i++) {
    const iv = raw[i];
    const a = iv[0];
    const b = iv[1];
    if (!(b > a + 1e-9)) continue;
    const outLen = out.length;
    if (outLen > 0 && a <= out[outLen - 1][1] + 1e-8) {
      if (b > out[outLen - 1][1]) out[outLen - 1][1] = b;
    } else {
      out.push([a, b]);
    }
  }
  return out;
}

function subtractIntervals(pos: Interval1D[], neg: Interval1D[]): Interval1D[] {
  if (pos.length === 0 || neg.length === 0) return pos;
  let cur = pos;
  for (const [na, nb] of neg) {
    if (nb <= na + 1e-9) continue;
    const next: Interval1D[] = [];
    for (const [pa, pb] of cur) {
      if (nb <= pa || na >= pb) {
        next.push([pa, pb]);
      } else {
        if (na > pa + 1e-9) next.push([pa, na]);
        if (nb < pb - 1e-9) next.push([nb, pb]);
      }
    }
    cur = next;
    if (cur.length === 0) break;
  }
  return cur;
}

function intersectIntervals(a: Interval1D[], b: Interval1D[]): Interval1D[] {
  if (a.length === 0 || b.length === 0) return [];
  const out: Interval1D[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i][0], b[j][0]);
    const hi = Math.min(a[i][1], b[j][1]);
    if (hi > lo + 1e-9) out.push([lo, hi]);
    if (a[i][1] < b[j][1]) i++;
    else j++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Analytic & 2D-Binned Mesh Ray Intersectors
// ---------------------------------------------------------------------------

function buildMeshBinGrid(verts: ArrayLike<number>, faces: ArrayLike<number>, axis: 0 | 1 | 2): MeshBinGrid2D {
  const uAxis = ((axis + 1) % 3) as 0 | 1 | 2;
  const vAxis = ((axis + 2) % 3) as 0 | 1 | 2;
  let uMin = Infinity, uMax = -Infinity;
  let vMin = Infinity, vMax = -Infinity;
  for (let i = 0; i + 2 < verts.length; i += 3) {
    const u = verts[i + uAxis];
    const v = verts[i + vAxis];
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  if (!Number.isFinite(uMin)) {
    uMin = vMin = -0.1;
    uMax = vMax = 0.1;
  }
  const pad = 1e-5;
  uMin -= pad; uMax += pad;
  vMin -= pad; vMax += pad;
  const nBins = 16;
  const invDu = nBins / Math.max(1e-7, uMax - uMin);
  const invDv = nBins / Math.max(1e-7, vMax - vMin);
  const buckets: number[][] = Array.from({ length: nBins * nBins }, () => []);

  const nTris = Math.floor(faces.length / 3);
  for (let t = 0; t < nTris; t++) {
    const i0 = faces[3 * t] * 3;
    const i1 = faces[3 * t + 1] * 3;
    const i2 = faces[3 * t + 2] * 3;
    const u0 = verts[i0 + uAxis], u1 = verts[i1 + uAxis], u2 = verts[i2 + uAxis];
    const v0 = verts[i0 + vAxis], v1 = verts[i1 + vAxis], v2 = verts[i2 + vAxis];
    const bu0 = Math.max(0, Math.min(nBins - 1, Math.floor((Math.min(u0, u1, u2) - uMin) * invDu)));
    const bu1 = Math.max(0, Math.min(nBins - 1, Math.floor((Math.max(u0, u1, u2) - uMin) * invDu)));
    const bv0 = Math.max(0, Math.min(nBins - 1, Math.floor((Math.min(v0, v1, v2) - vMin) * invDv)));
    const bv1 = Math.max(0, Math.min(nBins - 1, Math.floor((Math.max(v0, v1, v2) - vMin) * invDv)));
    for (let bv = bv0; bv <= bv1; bv++) {
      for (let bu = bu0; bu <= bu1; bu++) {
        buckets[bv * nBins + bu].push(t);
      }
    }
  }

  return {
    axis,
    uAxis,
    vAxis,
    uMin,
    vMin,
    invDu,
    invDv,
    nBins,
    bins: buckets.map((b) => Int32Array.from(b)),
  };
}

// Scratch buffer for mesh ray-triangle hits (single-threaded JS, zero per-ray alloc)
const meshRayHitsScratch: number[] = [];

function intersectMeshTriangle(
  verts: ArrayLike<number>,
  faces: ArrayLike<number>,
  t: number,
  jx: number,
  jy: number,
  jz: number,
  dx: number,
  dy: number,
  dz: number,
  hits: number[],
): void {
  const f3 = 3 * t;
  const i0 = faces[f3] * 3;
  const i1 = faces[f3 + 1] * 3;
  const i2 = faces[f3 + 2] * 3;
  const ax = verts[i0], ay = verts[i0 + 1], az = verts[i0 + 2];
  const e1x = verts[i1] - ax, e1y = verts[i1 + 1] - ay, e1z = verts[i1 + 2] - az;
  const e2x = verts[i2] - ax, e2y = verts[i2 + 1] - ay, e2z = verts[i2 + 2] - az;
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -1e-14 && det < 1e-14) return;
  const invDet = 1 / det;
  const tx = jx - ax, ty = jy - ay, tz = jz - az;
  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < 0 || u > 1) return;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * invDet;
  if (v < 0 || u + v > 1) return;
  hits.push((e2x * qx + e2y * qy + e2z * qz) * invDet);
}

function rayIntersectPreparedGeom(
  pg: PreparedSolidGeom,
  oxWorld: number,
  oyWorld: number,
  ozWorld: number,
  dxWorld: number,
  dyWorld: number,
  dzWorld: number,
  out: Interval1D[],
): void {
  // Fast O(1) AABB reject for axis-aligned ray pencils (99%+ of acoustic rays!)
  const lb = pg.localBounds;
  if (dyWorld === 0 && dzWorld === 0) {
    if (oyWorld < lb[2] - 1e-6 || oyWorld > lb[3] + 1e-6 || ozWorld < lb[4] - 1e-6 || ozWorld > lb[5] + 1e-6) return;
  } else if (dxWorld === 0 && dzWorld === 0) {
    if (oxWorld < lb[0] - 1e-6 || oxWorld > lb[1] + 1e-6 || ozWorld < lb[4] - 1e-6 || ozWorld > lb[5] + 1e-6) return;
  } else if (dxWorld === 0 && dyWorld === 0) {
    if (oxWorld < lb[0] - 1e-6 || oxWorld > lb[1] + 1e-6 || oyWorld < lb[2] - 1e-6 || oyWorld > lb[3] + 1e-6) return;
  }

  const m = pg.invMat;
  const ox = m[0] * oxWorld + m[4] * oyWorld + m[8] * ozWorld + m[12];
  const oy = m[1] * oxWorld + m[5] * oyWorld + m[9] * ozWorld + m[13];
  const oz = m[2] * oxWorld + m[6] * oyWorld + m[10] * ozWorld + m[14];
  const dx = m[0] * dxWorld + m[4] * dyWorld + m[8] * dzWorld;
  const dy = m[1] * dxWorld + m[5] * dyWorld + m[9] * dzWorld;
  const dz = m[2] * dxWorld + m[6] * dyWorld + m[10] * dzWorld;

  const s = pg.size;

  if (pg.type === 'box') {
    const sx = Math.max(1e-6, s[0] ?? 0.02);
    const sy = Math.max(1e-6, s[1] ?? sx);
    const sz = Math.max(1e-6, s[2] ?? sx);
    let tMin = -Infinity;
    let tMax = Infinity;
    // Unrolled X slab
    if (dx > -1e-12 && dx < 1e-12) {
      if (ox < -sx || ox > sx) return;
    } else {
      const inv = 1 / dx;
      let t1 = (-sx - ox) * inv;
      let t2 = (sx - ox) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tMin) tMin = t1;
      if (t2 < tMax) tMax = t2;
      if (tMin >= tMax) return;
    }
    // Unrolled Y slab
    if (dy > -1e-12 && dy < 1e-12) {
      if (oy < -sy || oy > sy) return;
    } else {
      const inv = 1 / dy;
      let t1 = (-sy - oy) * inv;
      let t2 = (sy - oy) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tMin) tMin = t1;
      if (t2 < tMax) tMax = t2;
      if (tMin >= tMax) return;
    }
    // Unrolled Z slab
    if (dz > -1e-12 && dz < 1e-12) {
      if (oz < -sz || oz > sz) return;
    } else {
      const inv = 1 / dz;
      let t1 = (-sz - oz) * inv;
      let t2 = (sz - oz) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tMin) tMin = t1;
      if (t2 < tMax) tMax = t2;
      if (tMin >= tMax) return;
    }
    if (tMax > tMin + 1e-9) out.push([tMin, tMax]);
    return;
  }

  if (pg.type === 'sphere') {
    const r = Math.max(1e-6, s[0] ?? 0.02);
    const a = dx * dx + dy * dy + dz * dz;
    const b = 2 * (ox * dx + oy * dy + oz * dz);
    const c = ox * ox + oy * oy + oz * oz - r * r;
    const disc = b * b - 4 * a * c;
    if (disc <= 1e-14 || a < 1e-14) return;
    const sq = Math.sqrt(disc);
    const inv2a = 0.5 / a;
    out.push([(-b - sq) * inv2a, (-b + sq) * inv2a]);
    return;
  }

  if (pg.type === 'ellipsoid') {
    const rx = Math.max(1e-6, s[0] ?? 0.02);
    const ry = Math.max(1e-6, s[1] ?? rx);
    const rz = Math.max(1e-6, s[2] ?? rx);
    const nox = ox / rx, noy = oy / ry, noz = oz / rz;
    const ndx = dx / rx, ndy = dy / ry, ndz = dz / rz;
    const a = ndx * ndx + ndy * ndy + ndz * ndz;
    const b = 2 * (nox * ndx + noy * ndy + noz * ndz);
    const c = nox * nox + noy * noy + noz * noz - 1;
    const disc = b * b - 4 * a * c;
    if (disc <= 1e-14 || a < 1e-14) return;
    const sq = Math.sqrt(disc);
    const inv2a = 0.5 / a;
    out.push([(-b - sq) * inv2a, (-b + sq) * inv2a]);
    return;
  }

  if (pg.type === 'cylinder' || pg.type === 'capsule') {
    const r = Math.max(1e-6, s[0] ?? 0.01);
    const halfH = Math.max(1e-6, s[1] ?? 0.05);
    const rSq = r * r;
    let tCylMin = -Infinity;
    let tCylMax = Infinity;
    const a = dx * dx + dy * dy;
    if (a < 1e-14) {
      if (ox * ox + oy * oy > rSq) return;
    } else {
      const b = 2 * (ox * dx + oy * dy);
      const c = ox * ox + oy * oy - rSq;
      const disc = b * b - 4 * a * c;
      if (disc <= 0) {
        if (pg.type === 'cylinder') return;
        tCylMin = 1; tCylMax = -1;
      } else {
        const sq = Math.sqrt(disc);
        const inv2a = 0.5 / a;
        tCylMin = (-b - sq) * inv2a;
        tCylMax = (-b + sq) * inv2a;
      }
    }

    let tZMin = -Infinity;
    let tZMax = Infinity;
    if (dz > -1e-12 && dz < 1e-12) {
      if (oz < -halfH || oz > halfH) {
        tZMin = 1; tZMax = -1;
      }
    } else {
      const invDz = 1 / dz;
      let z1 = (-halfH - oz) * invDz;
      let z2 = (halfH - oz) * invDz;
      if (z1 > z2) { const tmp = z1; z1 = z2; z2 = tmp; }
      tZMin = z1;
      tZMax = z2;
    }

    const trunkLo = Math.max(tCylMin, tZMin);
    const trunkHi = Math.min(tCylMax, tZMax);
    if (pg.type === 'cylinder') {
      if (trunkHi > trunkLo + 1e-9) out.push([trunkLo, trunkHi]);
      return;
    }

    // Capsule: union of trunk interval with top (+halfH) and bottom (-halfH) sphere caps
    const localIntervals: Interval1D[] = [];
    if (trunkHi > trunkLo + 1e-9) localIntervals.push([trunkLo, trunkHi]);
    const a3 = dx * dx + dy * dy + dz * dz;
    if (a3 > 1e-14) {
      const inv2a3 = 0.5 / a3;
      const oxDxOyDy = ox * dx + oy * dy;
      const ox2Oy2MinR2 = ox * ox + oy * oy - rSq;
      for (let cap = 0; cap < 2; cap++) {
        const ooz = cap === 0 ? oz + halfH : oz - halfH;
        const b3 = 2 * (oxDxOyDy + ooz * dz);
        const c3 = ox2Oy2MinR2 + ooz * ooz;
        const disc = b3 * b3 - 4 * a3 * c3;
        if (disc > 1e-14) {
          const sq = Math.sqrt(disc);
          localIntervals.push([(-b3 - sq) * inv2a3, (-b3 + sq) * inv2a3]);
        }
      }
    }
    const merged = normalizeIntervals(localIntervals);
    for (let i = 0; i < merged.length; i++) out.push(merged[i]);
    return;
  }

  if (pg.type === 'mesh' && pg.verts && pg.faces) {
    const verts = pg.verts;
    const faces = pg.faces;
    // Slight irrational jitter prevents rays from hitting shared mesh edges twice
    const jx = ox + 1.37e-8;
    const jy = oy - 1.91e-8;
    const jz = oz + 1.13e-8;

    // Fast path if ray aligns with local X, Y, or Z axis (true for >=95% of sculpted/mesh bodies!)
    let alignedAxis: (0 | 1 | 2) | -1 = -1;
    if (Math.abs(dy) < 1e-6 && Math.abs(dz) < 1e-6 && Math.abs(dx) > 0.5) alignedAxis = 0;
    else if (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6 && Math.abs(dy) > 0.5) alignedAxis = 1;
    else if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6 && Math.abs(dz) > 0.5) alignedAxis = 2;

    const hits = meshRayHitsScratch;
    hits.length = 0;

    if (alignedAxis !== -1) {
      if (!pg.meshGrids) pg.meshGrids = new Map();
      let grid = pg.meshGrids.get(alignedAxis);
      if (!grid) {
        grid = buildMeshBinGrid(verts, faces, alignedAxis);
        pg.meshGrids.set(alignedAxis, grid);
      }
      const uCoord = grid.uAxis === 0 ? jx : grid.uAxis === 1 ? jy : jz;
      const vCoord = grid.vAxis === 0 ? jx : grid.vAxis === 1 ? jy : jz;
      const bu = Math.floor((uCoord - grid.uMin) * grid.invDu);
      const bv = Math.floor((vCoord - grid.vMin) * grid.invDv);
      if (bu < 0 || bu >= grid.nBins || bv < 0 || bv >= grid.nBins) return;
      const triList = grid.bins[bv * grid.nBins + bu];
      for (let k = 0; k < triList.length; k++) {
        intersectMeshTriangle(verts, faces, triList[k], jx, jy, jz, dx, dy, dz, hits);
      }
    } else {
      const nTris = Math.floor(faces.length / 3);
      for (let t = 0; t < nTris; t++) {
        intersectMeshTriangle(verts, faces, t, jx, jy, jz, dx, dy, dz, hits);
      }
    }

    const nHits = hits.length;
    if (nHits < 2) return;
    if (nHits === 2) {
      let h0 = hits[0], h1 = hits[1];
      if (h0 > h1) { const tmp = h0; h0 = h1; h1 = tmp; }
      if (h1 > h0 + 1e-6) out.push([h0, h1]);
      return;
    }
    hits.sort((a, b) => a - b);
    // In-place deduplicate near-coincident double hits (e.g. duplicate vertices across seams)
    let write = 1;
    for (let i = 1; i < nHits; i++) {
      if (hits[i] - hits[write - 1] > 1e-6) {
        hits[write++] = hits[i];
      }
    }
    for (let i = 0; i + 1 < write; i += 2) {
      if (hits[i + 1] > hits[i] + 1e-8) {
        out.push([hits[i], hits[i + 1]]);
      }
    }
  }
}

const zUpMeshVertsCache = new WeakMap<object, Float64Array>();

/**
 * Returns mesh vertices in MuJoCo Z-up space: prefers `renderVertices` (already Z-up),
 * and converts Three.js Y-up `vertices` via `(x, y, z) -> (x, -z, y)` when `renderVertices` is absent.
 */
export function getZUpMeshVertices(g: SceneGeom): ArrayLike<number> | undefined {
  if (g.renderVertices && g.renderVertices.length >= 9) return g.renderVertices;
  const yup = g.vertices;
  if (!yup || yup.length < 9) return undefined;
  const key = yup as unknown as object;
  let cached = zUpMeshVertsCache.get(key);
  if (!cached || cached.length !== yup.length) {
    cached = new Float64Array(yup.length);
    for (let i = 0; i + 2 < yup.length; i += 3) {
      cached[i] = yup[i];
      cached[i + 1] = -yup[i + 2];
      cached[i + 2] = yup[i + 1];
    }
    zUpMeshVertsCache.set(key, cached);
  }
  return cached;
}

function computeLocalBoundsInFrame(g: SceneGeom, mat: THREE.Matrix4): [number, number, number, number, number, number] {
  const verts = getZUpMeshVertices(g);
  if (g.type === 'mesh' && verts && verts.length >= 9) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    const e = mat.elements;
    for (let i = 0; i + 2 < verts.length; i += 3) {
      const lx = verts[i], ly = verts[i + 1], lz = verts[i + 2];
      const wx = e[0] * lx + e[4] * ly + e[8] * lz + e[12];
      const wy = e[1] * lx + e[5] * ly + e[9] * lz + e[13];
      const wz = e[2] * lx + e[6] * ly + e[10] * lz + e[14];
      if (wx < x0) x0 = wx; if (wx > x1) x1 = wx;
      if (wy < y0) y0 = wy; if (wy > y1) y1 = wy;
      if (wz < z0) z0 = wz; if (wz > z1) z1 = wz;
    }
    return [x0, x1, y0, y1, z0, z1];
  }

  let hx = 0.02, hy = 0.02, hz = 0.02;
  const s = g.size;
  if (g.type === 'box') {
    hx = s[0] ?? 0.02; hy = s[1] ?? hx; hz = s[2] ?? hx;
  } else if (g.type === 'sphere') {
    hx = hy = hz = s[0] ?? 0.02;
  } else if (g.type === 'ellipsoid') {
    hx = s[0] ?? 0.02; hy = s[1] ?? hx; hz = s[2] ?? hx;
  } else if (g.type === 'cylinder') {
    hx = hy = s[0] ?? 0.01; hz = s[1] ?? 0.05;
  } else if (g.type === 'capsule') {
    const r = s[0] ?? 0.01;
    hx = hy = r; hz = (s[1] ?? 0.05) + r;
  }
  const e = mat.elements;
  const cx = e[12], cy = e[13], cz = e[14];
  const ex = Math.abs(e[0]) * hx + Math.abs(e[4]) * hy + Math.abs(e[8]) * hz;
  const ey = Math.abs(e[1]) * hx + Math.abs(e[5]) * hy + Math.abs(e[9]) * hz;
  const ez = Math.abs(e[2]) * hx + Math.abs(e[6]) * hy + Math.abs(e[10]) * hz;
  return [cx - ex, cx + ex, cy - ey, cy + ey, cz - ez, cz + ez];
}

function prepareGeomWithMatrix(
  g: SceneGeom,
  worldMat: THREE.Matrix4,
  csgEnabledOnNode = true,
): PreparedSolidGeom | null {
  if (g.type === 'plane') return null;
  let localMat: THREE.Matrix4;
  let effectiveSize = g.size;
  if ((g.type === 'cylinder' || g.type === 'capsule') && g.fromto && g.fromto.length >= 6) {
    const ff = fromtoFrame(g.fromto);
    localMat = ff.matrix;
    effectiveSize = [g.size[0] ?? 0.01, ff.halfLen];
  } else {
    localMat = geomMatrixOf(g);
  }
  const fullMat = new THREE.Matrix4().multiplyMatrices(worldMat, localMat);
  const invThree = fullMat.clone().invert();
  const bounds = computeLocalBoundsInFrame(
    effectiveSize === g.size ? g : { ...g, size: effectiveSize, fromto: undefined },
    fullMat,
  );
  const verts = g.type === 'mesh' ? getZUpMeshVertices(g) : undefined;
  const op = !csgEnabledOnNode
    ? 'union'
    : g.csg === 'difference'
      ? 'difference'
      : g.csg === 'intersection'
        ? 'intersection'
        : 'union';
  return {
    op,
    type: g.type,
    size: effectiveSize,
    invMat: Float64Array.from(invThree.elements),
    detScale: Math.cbrt(Math.abs(fullMat.determinant()) || 1),
    verts,
    faces: g.type === 'mesh' ? g.faces : undefined,
    localBounds: bounds,
  };
}

export function buildBodyRayScene(
  node: SceneNode,
  includeAllGeoms = false,
  rootMat?: THREE.Matrix4,
  shellFootprintBounds?: [number, number, number, number, number, number],
): BodyRayScene | null {
  const positives: PreparedSolidGeom[] = [];
  const differences: PreparedSolidGeom[] = [];
  const intersections: PreparedSolidGeom[] = [];
  const nodeGroups: NodeRayCsgGroup[] = [];

  const collectFrom = (n: SceneNode, parentMat: THREE.Matrix4, isRoot: boolean, passOnlyColliding: boolean) => {
    if (!isRoot && ((n.joints?.length ?? 0) > 0 || n.simulation || n.acousticString || n.acousticMembrane)) return;
    let curMat = parentMat;
    if (!isRoot) {
      const childLocal = geomMatrixOf({
        name: '',
        type: 'box',
        size: [1, 1, 1],
        pos: n.pos,
        quat: n.quat,
        euler: n.euler,
      });
      curMat = new THREE.Matrix4().multiplyMatrices(parentMat, childLocal);
    }

    const geoms = n.geoms ?? [];
    // Source geoms (!csgDerived) capture live primitives, live CSG boolean cutters, AND live Sculpt meshes!
    // Fall back to compiled visual mesh only if no source geoms exist.
    const sourceGeoms = geoms.filter((g) => !g.csgDerived && g.role !== 'visual' && g.type !== 'plane');
    const chosenList = sourceGeoms.length > 0
      ? sourceGeoms
      : geoms.filter((g) => g.csgDerived === 'visual' && g.type === 'mesh');

    // If `shellFootprintBounds` is supplied (cavity analysis), skip external non-colliding child appendages
    // (such as necks, pegboxes, tailpieces, or standing bridges protruding well outside the shell corpus)
    // while keeping internal non-colliding bracing (soundposts, bass bars) inside the shell!
    const allNonCollidingChild =
      !isRoot &&
      chosenList.length > 0 &&
      chosenList.every((g) => g.contype === 0 && g.conaffinity === 0);

    const group: NodeRayCsgGroup = { positives: [], differences: [], intersections: [] };
    const allowCsg = n.csgEnabled !== false;

    for (const g of chosenList) {
      const effectiveOp = allowCsg ? g.csg : undefined;
      if (passOnlyColliding && effectiveOp !== 'difference' && effectiveOp !== 'intersection') {
        if (g.contype === 0 && g.conaffinity === 0) continue;
      }
      const pg = prepareGeomWithMatrix(g, curMat, allowCsg);
      if (!pg) continue;
      if (allNonCollidingChild && shellFootprintBounds && pg.op === 'union') {
        const b = pg.localBounds;
        const sb = shellFootprintBounds;
        if (
          b[0] < sb[0] - 0.025 ||
          b[1] > sb[1] + 0.025 ||
          b[2] < sb[2] - 0.025 ||
          b[3] > sb[3] + 0.025 ||
          b[4] < sb[4] - 0.020 ||
          b[5] > sb[5] + 0.020
        ) {
          continue;
        }
      }
      if (pg.op === 'difference') {
        group.differences.push(pg);
        differences.push(pg);
      } else if (pg.op === 'intersection') {
        group.intersections.push(pg);
        intersections.push(pg);
      } else {
        group.positives.push(pg);
        positives.push(pg);
      }
    }

    if (group.positives.length > 0) {
      nodeGroups.push(group);
    }

    for (const ch of n.children ?? []) {
      collectFrom(ch, curMat, false, passOnlyColliding);
    }
  };

  const baseMat = rootMat ?? new THREE.Matrix4();
  collectFrom(node, baseMat, true, !includeAllGeoms);
  if (positives.length === 0 && !includeAllGeoms) {
    differences.length = 0;
    intersections.length = 0;
    nodeGroups.length = 0;
    collectFrom(node, baseMat, true, false);
  }
  if (positives.length === 0) return null;

  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of positives) {
    const b = p.localBounds;
    if (b[0] < x0) x0 = b[0]; if (b[1] > x1) x1 = b[1];
    if (b[2] < y0) y0 = b[2]; if (b[3] > y1) y1 = b[3];
    if (b[4] < z0) z0 = b[4]; if (b[5] > z1) z1 = b[5];
  }
  if (!Number.isFinite(x0)) return null;

  return {
    positives,
    differences,
    intersections,
    nodeGroups,
    bounds: [x0, x1, y0, y1, z0, z1],
  };
}

function castGroupRay(
  group: NodeRayCsgGroup,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
): Interval1D[] {
  const posRaw: Interval1D[] = [];
  for (let i = 0; i < group.positives.length; i++) {
    rayIntersectPreparedGeom(group.positives[i], ox, oy, oz, dx, dy, dz, posRaw);
  }
  let cur = normalizeIntervals(posRaw);
  if (cur.length === 0) return cur;

  if (group.differences.length > 0) {
    const negRaw: Interval1D[] = [];
    for (let i = 0; i < group.differences.length; i++) {
      rayIntersectPreparedGeom(group.differences[i], ox, oy, oz, dx, dy, dz, negRaw);
    }
    if (negRaw.length > 0) {
      cur = subtractIntervals(cur, normalizeIntervals(negRaw));
      if (cur.length === 0) return cur;
    }
  }

  for (let i = 0; i < group.intersections.length; i++) {
    const intRaw: Interval1D[] = [];
    rayIntersectPreparedGeom(group.intersections[i], ox, oy, oz, dx, dy, dz, intRaw);
    cur = intersectIntervals(cur, normalizeIntervals(intRaw));
    if (cur.length === 0) return cur;
  }

  return cur;
}

export function castSceneRay(
  scene: BodyRayScene,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
): Interval1D[] {
  if (scene.nodeGroups && scene.nodeGroups.length > 0) {
    if (scene.nodeGroups.length === 1) {
      return castGroupRay(scene.nodeGroups[0], ox, oy, oz, dx, dy, dz);
    }
    const merged: Interval1D[] = [];
    for (let g = 0; g < scene.nodeGroups.length; g++) {
      const ivs = castGroupRay(scene.nodeGroups[g], ox, oy, oz, dx, dy, dz);
      for (let k = 0; k < ivs.length; k++) merged.push(ivs[k]);
    }
    return normalizeIntervals(merged);
  }
  return castGroupRay(scene, ox, oy, oz, dx, dy, dz);
}

// ---------------------------------------------------------------------------
// Legendre Polynomial Basis & Generalized Rayleigh–Ritz Eigensolver
// ---------------------------------------------------------------------------

export function evaluateLegendrePoly(xi: number, maxOrder: number): number[] {
  const p = new Array<number>(maxOrder).fill(0);
  p[0] = 1;
  if (maxOrder > 1) p[1] = xi;
  for (let k = 1; k + 1 < maxOrder; k++) {
    p[k + 1] = ((2 * k + 1) * xi * p[k] - k * p[k - 1]) / (k + 1);
  }
  return p;
}

const BEAM_N_BASIS = 12;
const BEAM_N_NORM_PTS = 25;

interface LegendreQuadTable {
  p: Float64Array; // [nStations * BEAM_N_BASIS]
  d2p: Float64Array; // [nStations * BEAM_N_BASIS]
}

const legendreQuadCache = new Map<number, LegendreQuadTable>();

function getLegendreQuadTable(nStations: number): LegendreQuadTable {
  let tab = legendreQuadCache.get(nStations);
  if (tab) return tab;
  const p = new Float64Array(nStations * BEAM_N_BASIS);
  const d2p = new Float64Array(nStations * BEAM_N_BASIS);
  const dp = new Float64Array(BEAM_N_BASIS);
  for (let q = 0; q < nStations; q++) {
    const xi = -1 + ((q + 0.5) * 2) / nStations;
    const base = q * BEAM_N_BASIS;
    p[base] = 1;
    p[base + 1] = xi;
    dp.fill(0);
    dp[1] = 1;
    for (let k = 1; k + 1 < BEAM_N_BASIS; k++) {
      const invKp1 = 1 / (k + 1);
      const twoKp1 = 2 * k + 1;
      p[base + k + 1] = (twoKp1 * xi * p[base + k] - k * p[base + k - 1]) * invKp1;
      dp[k + 1] = (twoKp1 * (p[base + k] + xi * dp[k]) - k * dp[k - 1]) * invKp1;
      d2p[base + k + 1] = (twoKp1 * (2 * dp[k] + xi * d2p[base + k]) - k * d2p[base + k - 1]) * invKp1;
    }
  }
  tab = { p, d2p };
  if (legendreQuadCache.size > 16) legendreQuadCache.clear();
  legendreQuadCache.set(nStations, tab);
  return tab;
}

const LEGENDRE_NORM_TABLE: Float64Array = (() => {
  const out = new Float64Array(BEAM_N_NORM_PTS * BEAM_N_BASIS);
  for (let s = 0; s < BEAM_N_NORM_PTS; s++) {
    const xi = -1 + (2 * s) / (BEAM_N_NORM_PTS - 1);
    const base = s * BEAM_N_BASIS;
    out[base] = 1;
    out[base + 1] = xi;
    for (let k = 1; k + 1 < BEAM_N_BASIS; k++) {
      out[base + k + 1] = ((2 * k + 1) * xi * out[base + k] - k * out[base + k - 1]) / (k + 1);
    }
  }
  return out;
})();

// Pre-allocated flat 12x12 scratch matrices for solveGeneralSectionBeamModes (single-threaded JS)
const beamKScratch = new Float64Array(BEAM_N_BASIS * BEAM_N_BASIS);
const beamMScratch = new Float64Array(BEAM_N_BASIS * BEAM_N_BASIS);
const beamLScratch = new Float64Array(BEAM_N_BASIS * BEAM_N_BASIS);
const beamLinvScratch = new Float64Array(BEAM_N_BASIS * BEAM_N_BASIS);
const beamTmpScratch = new Float64Array(BEAM_N_BASIS * BEAM_N_BASIS);
const beamCScratch = new Float64Array(BEAM_N_BASIS * BEAM_N_BASIS);
const beamVScratch = new Float64Array(BEAM_N_BASIS * BEAM_N_BASIS);
const beamOrderScratch = new Int32Array(BEAM_N_BASIS);

function jacobiEigenPairsFlat(A: Float64Array, V: Float64Array, n: number): void {
  V.fill(0);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;

  for (let sweep = 0; sweep < 50; sweep++) {
    let maxOff = 0;
    let p = 0;
    let q = 1;
    for (let i = 0; i < n; i++) {
      const rowI = i * n;
      for (let j = i + 1; j < n; j++) {
        const v = Math.abs(A[rowI + j]);
        if (v > maxOff) {
          maxOff = v;
          p = i;
          q = j;
        }
      }
    }
    if (maxOff < 1e-13) break;
    const apq = A[p * n + q];
    const diff = A[q * n + q] - A[p * n + p];
    let t: number;
    if (Math.abs(apq) < Math.abs(diff) * 1e-18) {
      t = apq / diff;
    } else {
      const phi = diff / (2 * apq);
      t = (1 / (Math.abs(phi) + Math.sqrt(phi * phi + 1))) * (phi < 0 ? -1 : 1);
    }
    const c = 1 / Math.sqrt(1 + t * t);
    const s = t * c;
    const tau = s / (1 + c);
    A[p * n + q] = 0;
    A[q * n + p] = 0;
    A[p * n + p] -= t * apq;
    A[q * n + q] += t * apq;
    const rowP = p * n;
    const rowQ = q * n;
    for (let k = 0; k < n; k++) {
      const rowK = k * n;
      if (k !== p && k !== q) {
        const akp = A[rowK + p];
        const akq = A[rowK + q];
        const newAkp = akp - s * (akq + tau * akp);
        const newAkq = akq + s * (akp - tau * akq);
        A[rowK + p] = newAkp;
        A[rowP + k] = newAkp;
        A[rowK + q] = newAkq;
        A[rowQ + k] = newAkq;
      }
      const vkp = V[rowK + p];
      const vkq = V[rowK + q];
      V[rowK + p] = vkp - s * (vkq + tau * vkp);
      V[rowK + q] = vkq + s * (vkp - tau * vkq);
    }
  }
}

/**
 * Solves free-free flexural eigenvalues and mode-shape vectors for ANY variable
 * cross-section beam with arbitrary area profile A(s) and second moment I(s),
 * including Timoshenko transverse shear + rotary inertia correction for stubby bodies.
 */
export function solveGeneralSectionBeamModes(
  lengthM: number,
  modulusPa: number,
  densityKgM3: number,
  areaSamples: Float64Array,
  inertiaSamples: Float64Array,
  applyTimoshenko = true,
): VariableSectionEigenResult {
  const nBasis = BEAM_N_BASIS; // P_0..P_11 -> 2 rigid modes + 10 elastic modes
  const nStations = areaSamples.length;
  const K = beamKScratch;
  const M = beamMScratch;
  K.fill(0);
  M.fill(0);

  const halfL = Math.max(1e-4, lengthM * 0.5);
  const invHalfL3 = 1 / (halfL * halfL * halfL);
  const dxi = 2 / nStations;
  const kScale = modulusPa * invHalfL3 * dxi;
  const mScale = densityKgM3 * halfL * dxi;

  let maxArea = 0;
  let sumArea = 0;
  let sumInertia = 0;
  for (let q = 0; q < nStations; q++) {
    const a = areaSamples[q];
    if (a > maxArea) maxArea = a;
    sumArea += a;
    sumInertia += inertiaSamples[q];
  }
  const floorArea = Math.max(1e-11, maxArea * 1e-3);
  const floorInertia = Math.max(1e-18, (sumInertia / Math.max(1, nStations)) * 1e-4);

  const quad = getLegendreQuadTable(nStations);
  const pTab = quad.p;
  const d2pTab = quad.d2p;

  for (let q = 0; q < nStations; q++) {
    const area = areaSamples[q] > floorArea ? areaSamples[q] : floorArea;
    const inertia = inertiaSamples[q] > floorInertia ? inertiaSamples[q] : floorInertia;
    const wK = kScale * inertia;
    const wM = mScale * area;
    const qBase = q * nBasis;
    for (let i = 0; i < nBasis; i++) {
      const rowI = i * nBasis;
      const wK_d2i = wK * d2pTab[qBase + i];
      const wM_pi = wM * pTab[qBase + i];
      for (let j = i; j < nBasis; j++) {
        K[rowI + j] += wK_d2i * d2pTab[qBase + j];
        M[rowI + j] += wM_pi * pTab[qBase + j];
      }
    }
  }
  for (let i = 0; i < nBasis; i++) {
    const rowI = i * nBasis;
    for (let j = 0; j < i; j++) {
      K[rowI + j] = K[j * nBasis + i];
      M[rowI + j] = M[j * nBasis + i];
    }
  }

  // Cholesky M = L * L^T
  const L = beamLScratch;
  L.fill(0);
  for (let i = 0; i < nBasis; i++) {
    const rowI = i * nBasis;
    for (let j = 0; j <= i; j++) {
      const rowJ = j * nBasis;
      let sum = M[rowI + j];
      for (let k = 0; k < j; k++) sum -= L[rowI + k] * L[rowJ + k];
      if (i === j) {
        L[rowI + i] = Math.sqrt(sum > 1e-30 ? sum : 1e-30);
      } else {
        L[rowI + j] = sum / L[rowJ + j];
      }
    }
  }

  const Linv = beamLinvScratch;
  Linv.fill(0);
  for (let i = 0; i < nBasis; i++) {
    const rowI = i * nBasis;
    const invLii = 1 / L[rowI + i];
    Linv[rowI + i] = invLii;
    for (let j = 0; j < i; j++) {
      let sum = 0;
      for (let k = j; k < i; k++) sum += L[rowI + k] * Linv[k * nBasis + j];
      Linv[rowI + j] = -sum * invLii;
    }
  }

  const tmp = beamTmpScratch;
  for (let i = 0; i < nBasis; i++) {
    const rowI = i * nBasis;
    for (let j = 0; j < nBasis; j++) {
      let s = 0;
      for (let k = 0; k <= i; k++) s += Linv[rowI + k] * K[k * nBasis + j];
      tmp[rowI + j] = s;
    }
  }
  const C = beamCScratch;
  for (let i = 0; i < nBasis; i++) {
    const rowI = i * nBasis;
    for (let j = i; j < nBasis; j++) {
      const rowJ = j * nBasis;
      let s = 0;
      for (let k = 0; k <= j; k++) s += tmp[rowI + k] * Linv[rowJ + k];
      C[rowI + j] = s;
      C[rowJ + i] = s;
    }
  }

  const V = beamVScratch;
  jacobiEigenPairsFlat(C, V, nBasis);

  // Insertion-sort eigenvalue column indices ascending (nBasis = 12)
  const order = beamOrderScratch;
  for (let i = 0; i < nBasis; i++) order[i] = i;
  for (let i = 1; i < nBasis; i++) {
    const cur = order[i];
    const curVal = C[cur * nBasis + cur];
    let j = i - 1;
    while (j >= 0 && C[order[j] * nBasis + order[j]] > curVal) {
      order[j + 1] = order[j];
      j--;
    }
    order[j + 1] = cur;
  }

  const meanA = Math.max(1e-11, sumArea / Math.max(1, nStations));
  const meanI = Math.max(1e-18, sumInertia / Math.max(1, nStations));
  const rgSqOverLSq = (meanI / meanA) / Math.max(1e-8, lengthM * lengthM);
  // Cowper rectangular Timoshenko transverse shear + rotary inertia coefficient
  const timoCoeff = 1.35;
  const invTwoPi = 1 / (2 * Math.PI);

  const frequenciesHz: number[] = [];
  const modeVectors: number[][] = [];

  for (let idx = 2; idx < 8; idx++) {
    const col = order[idx];
    const mElastic = idx - 1; // 1, 2, 3, ...
    let omegaSq = C[col * nBasis + col];
    if (omegaSq < 0) omegaSq = 0;
    if (applyTimoshenko) {
      const wn = (mElastic + 0.5) * Math.PI;
      omegaSq /= 1 + timoCoeff * wn * wn * rgSqOverLSq;
    }
    frequenciesHz.push(Math.sqrt(omegaSq) * invTwoPi);

    // Back-transform eigenvector y -> c = L^-T * y in Legendre polynomial basis
    const coeffs = new Array<number>(nBasis);
    for (let i = 0; i < nBasis; i++) {
      let s = 0;
      for (let k = i; k < nBasis; k++) s += Linv[k * nBasis + i] * V[k * nBasis + col];
      coeffs[i] = s;
    }
    // Normalize so max |ψ_m(ξ)| across [-1, 1] is 1.0 using precomputed table
    let peak = 1e-12;
    for (let s = 0; s < BEAM_N_NORM_PTS; s++) {
      const base = s * nBasis;
      let val = 0;
      for (let k = 0; k < nBasis; k++) val += coeffs[k] * LEGENDRE_NORM_TABLE[base + k];
      const av = val < 0 ? -val : val;
      if (av > peak) peak = av;
    }
    const invPeak = 1 / peak;
    for (let k = 0; k < nBasis; k++) coeffs[k] *= invPeak;
    modeVectors.push(coeffs);
  }

  return { frequenciesHz, modeVectors };
}

export function evaluateNormalizedModeShape(coeffs: number[], xi: number): number {
  const n = coeffs.length;
  if (n === 0) return 0;
  const x = xi < -1 ? -1 : xi > 1 ? 1 : xi;
  let sum = coeffs[0];
  if (n > 1) {
    let pPrev = 1;
    let pCur = x;
    sum += coeffs[1] * pCur;
    for (let k = 1; k + 1 < n; k++) {
      const pNext = ((2 * k + 1) * x * pCur - k * pPrev) / (k + 1);
      sum += coeffs[k + 1] * pNext;
      pPrev = pCur;
      pCur = pNext;
    }
  }
  return sum < 0 ? -sum : sum;
}

// ---------------------------------------------------------------------------
// Caching Infrastructure (Zero Steady-State Frame Overhead, Instant on Edits)
// ---------------------------------------------------------------------------

function computeNodeGeomSignature(node: SceneNode): string {
  const parts: string[] = [
    node.id,
    String(node.deformMaterial ?? ''),
    String(node.density ?? ''),
    String(node.mass ?? ''),
    String(node.sculptVersion ?? 0),
    node.sculptEdited ? '1' : '0',
    node.csgEnabled === false ? '0' : node.csgEnabled ? '1' : 'u',
    String(node.outerRadius ?? ''),
    String(node.innerRadius ?? ''),
    String(node.height ?? ''),
  ];
  const visit = (n: SceneNode, prefix: string) => {
    for (const g of n.geoms ?? []) {
      if (g.csgDerived || g.role === 'visual' || g.type === 'plane') continue;
      const rv = g.type === 'mesh' ? getZUpMeshVertices(g) : (g.renderVertices ?? g.vertices);
      let meshHash = '';
      if (rv && rv.length > 0) {
        // Sample up to 256 coordinates + exact min/max AABB so local sculpt/dent/lattice strokes always invalidate cache!
        const step = Math.max(1, Math.floor(rv.length / 256));
        let acc = (rv.length * 31 + (g.faces?.length ?? 0)) | 0;
        let minC = Infinity;
        let maxC = -Infinity;
        for (let i = 0; i < rv.length; i += step) {
          const v = rv[i];
          if (v < minC) minC = v;
          if (v > maxC) maxC = v;
          acc = (Math.imul(acc, 131) + Math.round(v * 1e5)) | 0;
        }
        // Also scan full coordinate min/max cheaply when mesh is <= 12k floats so sparse local brushes never hide
        if (rv.length <= 12000 && step > 1) {
          for (let i = 0; i < rv.length; i++) {
            const v = rv[i];
            if (v < minC) minC = v;
            if (v > maxC) maxC = v;
            if ((i & 31) === 0) acc = (Math.imul(acc, 33) + Math.round(v * 1e5)) | 0;
          }
        }
        const spanTag = Number.isFinite(minC) ? `${Math.round(minC * 1e5)}:${Math.round(maxC * 1e5)}` : '0';
        meshHash = `${rv.length}:${g.faces?.length ?? 0}:${acc}:${spanTag}`;
      }
      parts.push(
        `${prefix}${g.name ?? ''}:${g.type}:${g.csg ?? 'u'}:${(g.size ?? []).join(',')}:${(g.pos ?? []).join(',')}:${(g.quat ?? []).join(',')}:${(g.euler ?? []).join(',')}:${(g.fromto ?? []).join(',')}:${g.density ?? ''}:${g.mass ?? ''}:${g.contype ?? ''}:${g.conaffinity ?? ''}:${meshHash}`,
      );
    }
    for (const ch of n.children ?? []) {
      if ((ch.joints?.length ?? 0) > 0 || ch.simulation || ch.acousticString || ch.acousticMembrane) continue;
      visit(
        ch,
        `${prefix}${ch.id}/${(ch.pos ?? []).join(',')}/${(ch.quat ?? []).join(',')}/${(ch.euler ?? []).join(',')}/${ch.deformMaterial ?? ''}:${ch.density ?? ''}:${ch.csgEnabled === false ? '0' : '1'}/`,
      );
    }
  };
  visit(node, '');
  return parts.join('|');
}

const sectionCache = new Map<string, Solid3DSectionAnalysis>();
const cavityCache = new Map<string, Cavity3DAnalysis>();

// ---------------------------------------------------------------------------
// 1. 3D Cross-Sectional Structural Analyzer (All Solids)
// ---------------------------------------------------------------------------

function sliceSceneAlongAxis(
  scene: BodyRayScene,
  lenAxis: 0 | 1 | 2,
  widthAxis: 0 | 1 | 2,
  thickAxis: 0 | 1 | 2,
  lenMin: number,
  lenMax: number,
  wMin: number,
  wMax: number,
  nSlices: number,
  nRaysPerSlice: number,
): {
  areas: Float64Array;
  inertiasThick: Float64Array;
  inertiasWidth: Float64Array;
  actualSMin: number;
  actualSMax: number;
  actualWMin: number;
  actualWMax: number;
  actualTMin: number;
  actualTMax: number;
  volume: number;
  hollowRays: number;
  hitRays: number;
  wallThicknessSum: number;
  wallSegmentCount: number;
} {
  const areas = new Float64Array(nSlices);
  const inertiasThick = new Float64Array(nSlices);
  const inertiasWidth = new Float64Array(nSlices);

  const spanL = Math.max(1e-5, lenMax - lenMin);
  const spanW = Math.max(1e-5, wMax - wMin);
  const ds = spanL / nSlices;
  const dw = spanW / nRaysPerSlice;

  const dir: [number, number, number] = [0, 0, 0];
  dir[thickAxis] = 1;

  let actualSMin = Infinity, actualSMax = -Infinity;
  let actualWMin = Infinity, actualWMax = -Infinity;
  let actualTMin = Infinity, actualTMax = -Infinity;
  let volume = 0;
  let hollowRays = 0;
  let hitRays = 0;
  let wallThicknessSum = 0;
  let wallSegmentCount = 0;

  const origin: [number, number, number] = [0, 0, 0];

  for (let q = 0; q < nSlices; q++) {
    const s = lenMin + (q + 0.5) * ds;
    const stripIntervals: { w: number; ivs: Interval1D[] }[] = [];
    let sliceArea = 0;
    let momentT = 0;
    let momentW = 0;

    for (let p = 0; p < nRaysPerSlice; p++) {
      const w = wMin + (p + 0.5) * dw;
      origin[lenAxis] = s;
      origin[widthAxis] = w;
      origin[thickAxis] = 0;
      const ivs = castSceneRay(scene, origin[0], origin[1], origin[2], dir[0], dir[1], dir[2]);
      if (ivs.length === 0) continue;

      hitRays++;
      if (ivs.length >= 2) hollowRays++;
      stripIntervals.push({ w, ivs });

      let hRay = 0;
      for (const [ta, tb] of ivs) {
        const segH = tb - ta;
        hRay += segH;
        wallThicknessSum += segH;
        wallSegmentCount++;
        if (ta < actualTMin) actualTMin = ta;
        if (tb > actualTMax) actualTMax = tb;
        momentT += 0.5 * (tb * tb - ta * ta) * dw;
      }
      const dA = hRay * dw;
      sliceArea += dA;
      momentW += w * dA;
      if (w - 0.5 * dw < actualWMin) actualWMin = w - 0.5 * dw;
      if (w + 0.5 * dw > actualWMax) actualWMax = w + 0.5 * dw;
    }

    if (sliceArea > 1e-12) {
      if (s - 0.5 * ds < actualSMin) actualSMin = s - 0.5 * ds;
      if (s + 0.5 * ds > actualSMax) actualSMax = s + 0.5 * ds;
      const tc = momentT / sliceArea;
      const wc = momentW / sliceArea;
      let iThick = 0;
      let iWidth = 0;
      for (const { w, ivs } of stripIntervals) {
        let hRay = 0;
        for (const [ta, tb] of ivs) {
          const da = ta - tc;
          const db = tb - tc;
          iThick += ((db * db * db - da * da * da) / 3) * dw;
          hRay += tb - ta;
        }
        const dwCenter = w - wc;
        iWidth += hRay * dw * (dwCenter * dwCenter + (dw * dw) / 12);
      }
      areas[q] = sliceArea;
      inertiasThick[q] = Math.max(1e-18, iThick);
      inertiasWidth[q] = Math.max(1e-18, iWidth);
      volume += sliceArea * ds;
    }
  }

  return {
    areas,
    inertiasThick,
    inertiasWidth,
    actualSMin,
    actualSMax,
    actualWMin,
    actualWMax,
    actualTMin,
    actualTMax,
    volume,
    hollowRays,
    hitRays,
    wallThicknessSum,
    wallSegmentCount,
  };
}

function detectSingleSolidPrincipalPose(node: SceneNode): THREE.Matrix4 | null {
  let singlePos: SceneGeom | null = null;
  let hasWeldedChildSolid = false;
  for (const ch of node.children ?? []) {
    if ((ch.joints?.length ?? 0) > 0 || ch.simulation || ch.acousticString || ch.acousticMembrane) continue;
    if ((ch.geoms ?? []).some((g) => !g.csgDerived && g.role !== 'visual' && g.type !== 'plane' && g.csg !== 'difference')) {
      hasWeldedChildSolid = true;
      break;
    }
  }
  if (hasWeldedChildSolid) return null;

  const allowCsg = node.csgEnabled !== false;
  const sourceGeoms = (node.geoms ?? []).filter((g) => !g.csgDerived && g.role !== 'visual' && g.type !== 'plane');
  for (const g of sourceGeoms) {
    const op = allowCsg ? g.csg : undefined;
    if (op === 'difference' || op === 'intersection') continue;
    if (singlePos) return null; // Multiple unioned solids -> analyze in shared body frame
    singlePos = g;
  }
  if (!singlePos) return null;

  let mat: THREE.Matrix4;
  if ((singlePos.type === 'cylinder' || singlePos.type === 'capsule') && singlePos.fromto && singlePos.fromto.length >= 6) {
    mat = fromtoFrame(singlePos.fromto).matrix;
  } else if (singlePos.quat || singlePos.euler) {
    mat = geomMatrixOf(singlePos);
  } else {
    return null;
  }

  // Only switch to oriented principal frame when rotation is NOT already a clean 90° axis permutation!
  const e = mat.elements;
  const c0Max = Math.max(Math.abs(e[0]), Math.abs(e[1]), Math.abs(e[2]));
  const c1Max = Math.max(Math.abs(e[4]), Math.abs(e[5]), Math.abs(e[6]));
  const c2Max = Math.max(Math.abs(e[8]), Math.abs(e[9]), Math.abs(e[10]));
  if (c0Max > 0.9995 && c1Max > 0.9995 && c2Max > 0.9995) return null;
  return mat;
}

export function analyze3DSolidCrossSections(node: SceneNode): Solid3DSectionAnalysis {
  const sig = computeNodeGeomSignature(node);
  const cached = sectionCache.get(sig);
  if (cached) {
    sectionCache.delete(sig);
    sectionCache.set(sig, cached);
    return cached;
  }

  const principalPose = detectSingleSolidPrincipalPose(node);
  const invPrincipal = principalPose ? principalPose.clone().invert() : undefined;
  const scene = buildBodyRayScene(node, false, invPrincipal);
  if (!scene) {
    const fallback: Solid3DSectionAnalysis = {
      dimsSortedAsc: [0.02, 0.04, 0.08],
      axisOrderAsc: [2, 0, 1],
      lenBounds: [-0.04, 0.04],
      widthBounds: [-0.02, 0.02],
      solidVolumeM3: 0.02 * 0.04 * 0.08,
      hollowFraction: 0,
      meanWallThicknessM: 0.02,
      areaProfile: new Float64Array(48).fill(0.02 * 0.04),
      inertiaThickProfile: new Float64Array(48).fill((0.04 * Math.pow(0.02, 3)) / 12),
      inertiaWidthProfile: new Float64Array(48).fill((0.02 * Math.pow(0.04, 3)) / 12),
      transverseAreaProfile: new Float64Array(32).fill(0.02 * 0.08),
      transverseInertiaProfile: new Float64Array(32).fill((0.08 * Math.pow(0.02, 3)) / 12),
      isPureSolidSphere: false,
    };
    return fallback;
  }

  const [bx0, bx1, by0, by1, bz0, bz1] = scene.bounds;
  const rawLens: { len: number; axis: 0 | 1 | 2; lo: number; hi: number }[] = [
    { len: Math.max(0.0001, bx1 - bx0), axis: 0, lo: bx0, hi: bx1 },
    { len: Math.max(0.0001, by1 - by0), axis: 1, lo: by0, hi: by1 },
    { len: Math.max(0.0001, bz1 - bz0), axis: 2, lo: bz0, hi: bz1 },
  ];
  rawLens.sort((a, b) => a.len - b.len);
  let thickAxis = rawLens[0].axis;
  let widthAxis = rawLens[1].axis;
  let lenAxis = rawLens[2].axis;

  const boundsByAxis: [number, number][] = [[bx0, bx1], [by0, by1], [bz0, bz1]];

  // Initial pass to find actual post-boolean non-empty extents (in case a CSG/Sculpt cut shortened the body!)
  let pass = sliceSceneAlongAxis(
    scene,
    lenAxis,
    widthAxis,
    thickAxis,
    boundsByAxis[lenAxis][0],
    boundsByAxis[lenAxis][1],
    boundsByAxis[widthAxis][0],
    boundsByAxis[widthAxis][1],
    48,
    20,
  );

  let realLen = Number.isFinite(pass.actualSMax) ? Math.max(0.002, pass.actualSMax - pass.actualSMin) : rawLens[2].len;
  let realWidth = Number.isFinite(pass.actualWMax) ? Math.max(0.002, pass.actualWMax - pass.actualWMin) : rawLens[1].len;
  let realThick = Number.isFinite(pass.actualTMax) ? Math.max(0.0001, pass.actualTMax - pass.actualTMin) : rawLens[0].len;

  // If a boolean cut trimmed the former longest axis shorter than another axis, re-orient to the true post-cut axes!
  const trimmedSpan = (pass.actualSMax - pass.actualSMin) / Math.max(1e-6, rawLens[2].len);
  if (Number.isFinite(pass.actualSMax) && (trimmedSpan < 0.94 || realLen < realWidth)) {
    const postAxes: { len: number; axis: 0 | 1 | 2; lo: number; hi: number }[] = [
      { len: realThick, axis: thickAxis, lo: pass.actualTMin, hi: pass.actualTMax },
      { len: realWidth, axis: widthAxis, lo: pass.actualWMin, hi: pass.actualWMax },
      { len: realLen, axis: lenAxis, lo: pass.actualSMin, hi: pass.actualSMax },
    ].sort((a, b) => a.len - b.len);
    thickAxis = postAxes[0].axis;
    widthAxis = postAxes[1].axis;
    lenAxis = postAxes[2].axis;
    pass = sliceSceneAlongAxis(
      scene,
      lenAxis,
      widthAxis,
      thickAxis,
      postAxes[2].lo,
      postAxes[2].hi,
      postAxes[1].lo,
      postAxes[1].hi,
      48,
      20,
    );
    realLen = Number.isFinite(pass.actualSMax) ? Math.max(0.002, pass.actualSMax - pass.actualSMin) : postAxes[2].len;
    realWidth = Number.isFinite(pass.actualWMax) ? Math.max(0.002, pass.actualWMax - pass.actualWMin) : postAxes[1].len;
    realThick = Number.isFinite(pass.actualTMax) ? Math.max(0.0001, pass.actualTMax - pass.actualTMin) : postAxes[0].len;
  }

  // Secondary slice along widthAxis for 2D plate / shell mode coupling
  const sLo = Number.isFinite(pass.actualSMin) ? pass.actualSMin : boundsByAxis[lenAxis][0];
  const sHi = Number.isFinite(pass.actualSMax) ? pass.actualSMax : boundsByAxis[lenAxis][1];
  const wLo = Number.isFinite(pass.actualWMin) ? pass.actualWMin : boundsByAxis[widthAxis][0];
  const wHi = Number.isFinite(pass.actualWMax) ? pass.actualWMax : boundsByAxis[widthAxis][1];

  const transverse = sliceSceneAlongAxis(
    scene,
    widthAxis,
    lenAxis,
    thickAxis,
    wLo,
    wHi,
    sLo,
    sHi,
    32,
    16,
  );

  const dimsSortedAsc: [number, number, number] = [realThick, realWidth, realLen];
  const axisOrderAsc: [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2] = [thickAxis, widthAxis, lenAxis];

  let principalLenDir: [number, number, number] | undefined;
  let principalOrigin: [number, number, number] | undefined;
  if (principalPose) {
    const pe = principalPose.elements;
    const dx = pe[4 * lenAxis];
    const dy = pe[4 * lenAxis + 1];
    const dz = pe[4 * lenAxis + 2];
    const dNorm = Math.hypot(dx, dy, dz) || 1;
    principalLenDir = [dx / dNorm, dy / dNorm, dz / dNorm];
    principalOrigin = [pe[12], pe[13], pe[14]];
  }

  const hollowFraction = pass.hitRays > 0 ? pass.hollowRays / pass.hitRays : 0;
  const meanWallThicknessM = pass.wallSegmentCount > 0
    ? pass.wallThicknessSum / pass.wallSegmentCount
    : realThick;

  const isPureSolidSphere =
    scene.positives.length === 1 &&
    scene.positives[0].type === 'sphere' &&
    scene.differences.length === 0 &&
    scene.intersections.length === 0 &&
    hollowFraction === 0;

  const result: Solid3DSectionAnalysis = {
    dimsSortedAsc,
    axisOrderAsc,
    lenBounds: [sLo, sHi],
    widthBounds: [wLo, wHi],
    ...(principalLenDir ? { principalLenDir, principalOrigin } : {}),
    solidVolumeM3: Math.max(1e-10, pass.volume),
    hollowFraction,
    meanWallThicknessM,
    areaProfile: pass.areas,
    inertiaThickProfile: pass.inertiasThick,
    inertiaWidthProfile: pass.inertiasWidth,
    transverseAreaProfile: transverse.areas,
    transverseInertiaProfile: transverse.inertiasThick,
    isPureSolidSphere,
  };

  if (sectionCache.size > 256) {
    const firstKey = sectionCache.keys().next().value;
    if (firstKey !== undefined) sectionCache.delete(firstKey);
  }
  sectionCache.set(sig, result);
  return result;
}

// ---------------------------------------------------------------------------
// 2. Multi-Port 3D Cavity & Soundboard Analyzer (CSG, Multi-Plank, & Sculpt)
// ---------------------------------------------------------------------------

function pointInsideIntervals(ivs: Interval1D[], coord: number): boolean {
  for (let i = 0; i < ivs.length; i++) {
    if (coord >= ivs[i][0] && coord <= ivs[i][1]) return true;
  }
  return false;
}

function bracketedBySolidWalls(ivs: Interval1D[], coord: number): boolean {
  if (ivs.length === 0) return false;
  return ivs[0][0] < coord - 1e-6 && ivs[ivs.length - 1][1] > coord + 1e-6;
}

/**
 * Refines the open area A_p and surrounding wall thickness L_p of a detected
 * port patch on a wall normal to `normalAxis` (+1 or -1 side) using a fine
 * 14×14 local sub-grid of rays!
 */
function refinePortPatch(
  scene: BodyRayScene,
  normalAxis: 0 | 1 | 2,
  sideSign: 1 | -1,
  uMin: number,
  uMax: number,
  vMin: number,
  vMax: number,
  cavityMidNormalCoord: number,
  fallbackWallThick: number,
): { areaM2: number; neckLengthM: number } {
  const uAxis = ((normalAxis + 1) % 3) as 0 | 1 | 2;
  const vAxis = ((normalAxis + 2) % 3) as 0 | 1 | 2;
  const marginU = Math.max(0.004, (uMax - uMin) * 0.28);
  const marginV = Math.max(0.004, (vMax - vMin) * 0.28);
  const loU = uMin - marginU, hiU = uMax + marginU;
  const loV = vMin - marginV, hiV = vMax + marginV;
  const nSub = 16;
  const du = (hiU - loU) / nSub;
  const dv = (hiV - loV) / nSub;

  const dir: [number, number, number] = [0, 0, 0];
  dir[normalAxis] = 1;
  const uDir: [number, number, number] = [0, 0, 0];
  uDir[uAxis] = 1;
  const vDir: [number, number, number] = [0, 0, 0];
  vDir[vAxis] = 1;
  const org: [number, number, number] = [0, 0, 0];
  const latOrg: [number, number, number] = [0, 0, 0];

  let openCount = 0;
  let rimWallSum = 0;
  let rimWallCount = 0;

  for (let iu = 0; iu < nSub; iu++) {
    const u = loU + (iu + 0.5) * du;
    for (let iv = 0; iv < nSub; iv++) {
      const v = loV + (iv + 0.5) * dv;
      org[uAxis] = u;
      org[vAxis] = v;
      org[normalAxis] = 0;
      const ivs = castSceneRay(scene, org[0], org[1], org[2], dir[0], dir[1], dir[2]);
      // Check if there is a solid wall on `sideSign` of `cavityMidNormalCoord`
      let wallOnSide: Interval1D | null = null;
      for (const seg of ivs) {
        const segMid = 0.5 * (seg[0] + seg[1]);
        if (sideSign > 0 && segMid > cavityMidNormalCoord) {
          wallOnSide = seg;
        } else if (sideSign < 0 && segMid < cavityMidNormalCoord) {
          if (!wallOnSide) wallOnSide = seg;
        }
      }
      if (!wallOnSide) {
        // Verify this ray actually passes over the interior laterally (not outside the body's perimeter!)
        if (u >= uMin - marginU * 0.5 && u <= uMax + marginU * 0.5 && v >= vMin - marginV * 0.5 && v <= vMax + marginV * 0.5) {
          if (ivs.length >= 1) {
            openCount++;
          } else {
            // Through-all cut (`cutDepth: 0`) or aligned opposite ports: verify lateral cavity walls bracket (u, v) at cavityMidNormalCoord!
            latOrg[normalAxis] = cavityMidNormalCoord;
            latOrg[uAxis] = 0;
            latOrg[vAxis] = v;
            const uIvs = castSceneRay(scene, latOrg[0], latOrg[1], latOrg[2], uDir[0], uDir[1], uDir[2]);
            if (bracketedBySolidWalls(uIvs, u)) {
              openCount++;
            } else {
              latOrg[uAxis] = u;
              latOrg[vAxis] = 0;
              const vIvs = castSceneRay(scene, latOrg[0], latOrg[1], latOrg[2], vDir[0], vDir[1], vDir[2]);
              if (bracketedBySolidWalls(vIvs, v)) openCount++;
            }
          }
        }
      } else {
        rimWallSum += wallOnSide[1] - wallOnSide[0];
        rimWallCount++;
      }
    }
  }

  const areaM2 = openCount * du * dv;
  const neckLengthM = rimWallCount > 0 ? rimWallSum / rimWallCount : fallbackWallThick;
  return { areaM2, neckLengthM };
}

export function analyze3DCavityAndPorts(node: SceneNode): Cavity3DAnalysis {
  const sig = computeNodeGeomSignature(node);
  const cached = cavityCache.get(sig);
  if (cached) {
    cavityCache.delete(sig);
    cavityCache.set(sig, cached);
    return cached;
  }

  // Bound the cavity voxel grid and plate spans on the colliding shell corpus when present so external
  // non-colliding appendages (cello necks, pegboxes, standing bridges, tailpieces) never inflate corpus dimensions!
  const shellOnly = buildBodyRayScene(node, false);
  const scene = shellOnly
    ? (buildBodyRayScene(node, true, undefined, shellOnly.bounds) ?? shellOnly)
    : buildBodyRayScene(node, true);
  if (!scene) {
    return {
      hasHollowCavity: false,
      isOpenCupOrShell: false,
      cavityVolumeM3: 0,
      solidVolumeM3: 0,
      topPlateThicknessM: 0.004,
      meanWallThicknessM: 0.004,
      plateSpanAM: 0.16,
      plateSpanBM: 0.24,
      ports: [],
      totalConductanceM: 0,
      openAreaFraction: 0,
      cavityRegime: 'sealed',
      airResonanceHz: null,
    };
  }

  const [x0, x1, y0, y1, z0, z1] = shellOnly ? shellOnly.bounds : scene.bounds;
  const dxSpan = Math.max(0.002, x1 - x0);
  const dySpan = Math.max(0.002, y1 - y0);
  const dzSpan = Math.max(0.002, z1 - z0);

  // 34 x 34 x 28 3-axis orthogonal ray grid -> ~4.5 mm resolution on a 160 mm soundbox, runs in ~0.9 ms!
  const nx = 34;
  const ny = 34;
  const nz = 28;
  const hx = dxSpan / nx;
  const hy = dySpan / ny;
  const hz = dzSpan / nz;
  const voxelVol = hx * hy * hz;

  const zRays: Interval1D[][] = new Array(nx * ny);
  let topWallSum = 0;
  let topWallCount = 0;
  let allWallSum = 0;
  let allWallCount = 0;

  for (let ix = 0; ix < nx; ix++) {
    const x = x0 + (ix + 0.5) * hx;
    for (let iy = 0; iy < ny; iy++) {
      const y = y0 + (iy + 0.5) * hy;
      const ivs = castSceneRay(scene, x, y, 0, 0, 0, 1);
      zRays[ix * ny + iy] = ivs;
      if (ivs.length >= 2) {
        const topSeg = ivs[ivs.length - 1];
        topWallSum += topSeg[1] - topSeg[0];
        topWallCount++;
        for (const seg of ivs) {
          allWallSum += seg[1] - seg[0];
          allWallCount++;
        }
      }
    }
  }

  const xRays: Interval1D[][] = new Array(ny * nz);
  for (let iy = 0; iy < ny; iy++) {
    const y = y0 + (iy + 0.5) * hy;
    for (let iz = 0; iz < nz; iz++) {
      const z = z0 + (iz + 0.5) * hz;
      const ivs = castSceneRay(scene, 0, y, z, 1, 0, 0);
      xRays[iy * nz + iz] = ivs;
      if (ivs.length >= 2) {
        for (const seg of ivs) {
          allWallSum += seg[1] - seg[0];
          allWallCount++;
        }
      }
    }
  }

  const yRays: Interval1D[][] = new Array(nx * nz);
  for (let ix = 0; ix < nx; ix++) {
    const x = x0 + (ix + 0.5) * hx;
    for (let iz = 0; iz < nz; iz++) {
      const z = z0 + (iz + 0.5) * hz;
      const ivs = castSceneRay(scene, x, 0, z, 0, 1, 0);
      yRays[ix * nz + iz] = ivs;
      if (ivs.length >= 2) {
        for (const seg of ivs) {
          allWallSum += seg[1] - seg[0];
          allWallCount++;
        }
      }
    }
  }

  // Voxel states: 0 = exterior air, 1 = solid material, 2 = enclosed cavity/port air
  const totalVoxels = nx * ny * nz;
  const state = new Uint8Array(totalVoxels);
  let solidCount = 0;
  let enclosedCount = 0;
  let cavSumX = 0, cavSumY = 0, cavSumZ = 0;

  const idxOf = (ix: number, iy: number, iz: number) => (ix * ny + iy) * nz + iz;

  for (let ix = 0; ix < nx; ix++) {
    const x = x0 + (ix + 0.5) * hx;
    for (let iy = 0; iy < ny; iy++) {
      const y = y0 + (iy + 0.5) * hy;
      const zr = zRays[ix * ny + iy];
      for (let iz = 0; iz < nz; iz++) {
        const z = z0 + (iz + 0.5) * hz;
        const xr = xRays[iy * nz + iz];
        const yr = yRays[ix * nz + iz];

        const inZ = pointInsideIntervals(zr, z) ? 1 : 0;
        const inX = pointInsideIntervals(xr, x) ? 1 : 0;
        const inY = pointInsideIntervals(yr, y) ? 1 : 0;
        const vIdx = idxOf(ix, iy, iz);

        if (inZ + inX + inY >= 2) {
          state[vIdx] = 1;
          solidCount++;
        } else {
          const bZ = bracketedBySolidWalls(zr, z) ? 1 : 0;
          const bX = bracketedBySolidWalls(xr, x) ? 1 : 0;
          const bY = bracketedBySolidWalls(yr, y) ? 1 : 0;
          if (bZ + bX + bY >= 2) {
            state[vIdx] = 2;
            enclosedCount++;
            cavSumX += x;
            cavSumY += y;
            cavSumZ += z;
          }
        }
      }
    }
  }

  const meanWallThicknessM = allWallCount > 0 ? allWallSum / allWallCount : Math.min(dxSpan, dySpan, dzSpan) * 0.08;
  // Measure `topPlateThicknessM` strictly from the solid wall segment immediately bounding the +Z roof of `state === 2`
  // cavity voxels so hovering bridges, fingerboards, or tailpieces never pollute soundboard thickness!
  let cavRoofSum = 0;
  let cavRoofCount = 0;
  const cavAxisMin: [number, number, number] = [Infinity, Infinity, Infinity];
  const cavAxisMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let ix = 0; ix < nx; ix++) {
    const xLo = x0 + ix * hx, xHi = xLo + hx;
    for (let iy = 0; iy < ny; iy++) {
      const yLo = y0 + iy * hy, yHi = yLo + hy;
      let topCavIz = -1;
      for (let iz = 0; iz < nz; iz++) {
        if (state[idxOf(ix, iy, iz)] === 2) {
          topCavIz = iz;
          const zLo = z0 + iz * hz, zHi = zLo + hz;
          if (xLo < cavAxisMin[0]) cavAxisMin[0] = xLo;
          if (xHi > cavAxisMax[0]) cavAxisMax[0] = xHi;
          if (yLo < cavAxisMin[1]) cavAxisMin[1] = yLo;
          if (yHi > cavAxisMax[1]) cavAxisMax[1] = yHi;
          if (zLo < cavAxisMin[2]) cavAxisMin[2] = zLo;
          if (zHi > cavAxisMax[2]) cavAxisMax[2] = zHi;
        }
      }
      if (topCavIz >= 0) {
        const zCavTop = z0 + (topCavIz + 0.5) * hz;
        const zr = zRays[ix * ny + iy];
        for (let s = 0; s < zr.length; s++) {
          if (zr[s][1] > zCavTop + 1e-6 && zr[s][0] >= zCavTop - hz) {
            cavRoofSum += zr[s][1] - zr[s][0];
            cavRoofCount++;
            break;
          }
        }
      }
    }
  }
  const topPlateThicknessM = cavRoofCount > 0
    ? cavRoofSum / cavRoofCount
    : topWallCount > 0
      ? topWallSum / topWallCount
      : meanWallThicknessM;
  const solidVolumeM3 = solidCount * voxelVol;

  const sortedSpans = [dxSpan, dySpan, dzSpan].sort((a, b) => a - b);
  const plateSpanAM = sortedSpans[1];
  const plateSpanBM = sortedSpans[2];

  if (enclosedCount < 8) {
    const none: Cavity3DAnalysis = {
      hasHollowCavity: false,
      isOpenCupOrShell: false,
      cavityVolumeM3: 0,
      solidVolumeM3,
      topPlateThicknessM,
      meanWallThicknessM,
      plateSpanAM,
      plateSpanBM,
      ports: [],
      totalConductanceM: 0,
      openAreaFraction: 0,
      cavityRegime: 'sealed',
      airResonanceHz: null,
    };
    if (cavityCache.size >= 256) {
      const firstKey = cavityCache.keys().next().value;
      if (firstKey !== undefined) cavityCache.delete(firstKey);
    }
    cavityCache.set(sig, none);
    return none;
  }

  const cavMid: [number, number, number] = [
    cavSumX / enclosedCount,
    cavSumY / enclosedCount,
    cavSumZ / enclosedCount,
  ];

  // Collect all open boundary faces between CAVITY_AIR (2) and EXTERIOR_AIR (0 or grid outside),
  // grouped by normal direction (0..5: -X, +X, -Y, +Y, -Z, +Z) and 2D connected component!
  // Uses packed integer keys `(iu << 8) | iv` (zero string allocations across 32k voxels!).
  type OpenFaceCell = { dirId: number; iu: number; iv: number; u: number; v: number; faceArea: number };
  const openFacesByDir: Map<number, OpenFaceCell>[] = [
    new Map(), new Map(), new Map(), new Map(), new Map(), new Map(),
  ];

  let totalSurfaceArea = 0;
  let totalOpenFaceArea = 0;

  const dirs: [number, number, number, 0 | 1 | 2, 1 | -1, number][] = [
    [-1, 0, 0, 0, -1, hy * hz],
    [1, 0, 0, 0, 1, hy * hz],
    [0, -1, 0, 1, -1, hx * hz],
    [0, 1, 0, 1, 1, hx * hz],
    [0, 0, -1, 2, -1, hx * hy],
    [0, 0, 1, 2, 1, hx * hy],
  ];

  for (let ix = 0; ix < nx; ix++) {
    const cx = x0 + (ix + 0.5) * hx;
    const xBase = ix * ny;
    for (let iy = 0; iy < ny; iy++) {
      const cy = y0 + (iy + 0.5) * hy;
      const xyBase = (xBase + iy) * nz;
      const zRay = zRays[xBase + iy];
      for (let iz = 0; iz < nz; iz++) {
        if (state[xyBase + iz] !== 2) continue;
        const cz = z0 + (iz + 0.5) * hz;
        for (let d = 0; d < 6; d++) {
          const dirInfo = dirs[d];
          const ddx = dirInfo[0], ddy = dirInfo[1], ddz = dirInfo[2];
          const nAxis = dirInfo[3], fArea = dirInfo[5];
          const nix = ix + ddx, niy = iy + ddy, niz = iz + ddz;
          const nState = (nix < 0 || nix >= nx || niy < 0 || niy >= ny || niz < 0 || niz >= nz)
            ? 0
            : state[(nix * ny + niy) * nz + niz];
          if (nState === 1) {
            totalSurfaceArea += fArea;
          } else if (nState === 0) {
            // Check exact 1D ray intervals along nAxis so thin curved/end walls narrower than one voxel step
            // are never mistaken for open ports!
            const stepH = nAxis === 0 ? hx : nAxis === 1 ? hy : hz;
            const cFrom = nAxis === 0 ? cx : nAxis === 1 ? cy : cz;
            const cTo = cFrom + (ddx + ddy + ddz) * stepH;
            const segLo = cFrom < cTo ? cFrom : cTo;
            const segHi = cFrom < cTo ? cTo : cFrom;
            const axisRay =
              nAxis === 0
                ? xRays[iy * nz + iz]
                : nAxis === 1
                  ? yRays[ix * nz + iz]
                  : zRay;
            let wallBetween = false;
            for (let s = 0; s < axisRay.length; s++) {
              if (axisRay[s][1] > segLo + 1e-7 && axisRay[s][0] < segHi - 1e-7) {
                wallBetween = true;
                break;
              }
            }
            totalSurfaceArea += fArea;
            if (wallBetween) continue;
            totalOpenFaceArea += fArea;
            const iu = nAxis === 0 ? iy : nAxis === 1 ? iz : ix;
            const iv = nAxis === 0 ? iz : nAxis === 1 ? ix : iy;
            const uVal = nAxis === 0 ? cy : nAxis === 1 ? cz : cx;
            const vVal = nAxis === 0 ? cz : nAxis === 1 ? cx : cy;
            openFacesByDir[d].set((iu << 8) | iv, {
              dirId: d,
              iu,
              iv,
              u: uVal,
              v: vVal,
              faceArea: fArea,
            });
          }
        }
      }
    }
  }

  // Extract 2D connected port patches on each face and refine each port's exact area & wall thickness!
  const ports: DetectedPort3D[] = [];
  let portNeckVolTotal = 0;

  for (let d = 0; d < 6; d++) {
    const faceMap = openFacesByDir[d];
    if (faceMap.size === 0) continue;
    const [, , , nAxis, sideSign] = dirs[d];
    const visited = new Set<number>();

    for (const [startKey, startCell] of faceMap) {
      if (visited.has(startKey)) continue;
      const queue: OpenFaceCell[] = [startCell];
      visited.add(startKey);
      let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
      let coarseArea = 0;

      while (queue.length > 0) {
        const cur = queue.pop()!;
        coarseArea += cur.faceArea;
        if (cur.u < uMin) uMin = cur.u;
        if (cur.u > uMax) uMax = cur.u;
        if (cur.v < vMin) vMin = cur.v;
        if (cur.v > vMax) vMax = cur.v;
        for (let du = -1; du <= 1; du++) {
          const nu = cur.iu + du;
          if (nu < 0) continue;
          for (let dv = -1; dv <= 1; dv++) {
            if (du === 0 && dv === 0) continue;
            const nv = cur.iv + dv;
            if (nv < 0) continue;
            const nk = (nu << 8) | nv;
            if (!visited.has(nk)) {
              const neigh = faceMap.get(nk);
              if (neigh) {
                visited.add(nk);
                queue.push(neigh);
              }
            }
          }
        }
      }

      const stepU = nAxis === 0 ? hy : nAxis === 1 ? hz : hx;
      const stepV = nAxis === 0 ? hz : nAxis === 1 ? hx : hy;
      const refined = refinePortPatch(
        scene,
        nAxis,
        sideSign,
        uMin - 0.5 * stepU,
        uMax + 0.5 * stepU,
        vMin - 0.5 * stepV,
        vMax + 0.5 * stepV,
        cavMid[nAxis],
        nAxis === 2 && sideSign > 0 ? topPlateThicknessM : meanWallThicknessM,
      );

      const areaM2 = refined.areaM2 > 1e-7 ? refined.areaM2 : coarseArea;
      if (areaM2 < 4e-6) continue; // ignore sub-2mm numeric pinholes
      const eqRadiusM = Math.sqrt(areaM2 / Math.PI);
      const neckLengthM = Math.max(0.0012, refined.neckLengthM);
      // Flanged Rayleigh end correction on inner + outer sides of wall: +1.7 * r_eq
      const conductanceM = areaM2 / (neckLengthM + 1.7 * eqRadiusM);
      ports.push({
        areaM2,
        eqRadiusM,
        neckLengthM,
        conductanceM,
        normalAxis: nAxis,
        sideSign,
      });
      portNeckVolTotal += areaM2 * neckLengthM;
    }
  }

  // Also check if any tiny analytic CSG `difference` hole was narrower than a single 4.5 mm coarse grid step!
  if (ports.length === 0 && scene.differences.length > 0) {
    for (const diff of scene.differences) {
      const b = diff.localBounds;
      const wX = b[1] - b[0], wY = b[3] - b[2], wZ = b[5] - b[4];
      const maxDim = Math.max(wX, wY, wZ);
      const minDim = Math.min(wX, wY, wZ);
      // Small narrow cutter (not the main chamber void itself!)
      if (maxDim < Math.max(dxSpan, dySpan, dzSpan) * 0.35 && minDim > 0.0015) {
        const cx = 0.5 * (b[0] + b[1]), cy = 0.5 * (b[2] + b[3]), cz = 0.5 * (b[4] + b[5]);
        // Pick axis along which cutter is farthest from cavity center (or longest through-cut axis when centered!)
        const rel: [number, number, number] = [
          Math.abs(cx - cavMid[0]) / dxSpan,
          Math.abs(cy - cavMid[1]) / dySpan,
          Math.abs(cz - cavMid[2]) / dzSpan,
        ];
        const maxRel = Math.max(rel[0], rel[1], rel[2]);
        const pAxis: 0 | 1 | 2 = maxRel > 0.08
          ? (rel[2] >= rel[0] && rel[2] >= rel[1] ? 2 : rel[1] >= rel[0] ? 1 : 0)
          : (wZ >= wX && wZ >= wY ? 2 : wY >= wX ? 1 : 0);
        const uAx = ((pAxis + 1) % 3) as 0 | 1 | 2;
        const vAx = ((pAxis + 2) % 3) as 0 | 1 | 2;
        // A through-cut (`cutDepth: 0`) centered on `cavMid` can pierce BOTH +1 and -1 faces!
        const candidateSigns: (1 | -1)[] = [];
        if (b[2 * pAxis + 1] > cavAxisMax[pAxis] - 1e-4) candidateSigns.push(1);
        if (b[2 * pAxis] < cavAxisMin[pAxis] + 1e-4) candidateSigns.push(-1);
        if (candidateSigns.length === 0) {
          candidateSigns.push(([cx, cy, cz][pAxis] >= cavMid[pAxis] ? 1 : -1) as 1 | -1);
        }
        for (const sideSign of candidateSigns) {
          const refined = refinePortPatch(
            scene,
            pAxis,
            sideSign,
            b[2 * uAx],
            b[2 * uAx + 1],
            b[2 * vAx],
            b[2 * vAx + 1],
            cavMid[pAxis],
            meanWallThicknessM,
          );
          if (refined.areaM2 > 3e-6) {
            const eqRadiusM = Math.sqrt(refined.areaM2 / Math.PI);
            const neckLengthM = Math.max(0.0012, refined.neckLengthM);
            ports.push({
              areaM2: refined.areaM2,
              eqRadiusM,
              neckLengthM,
              conductanceM: refined.areaM2 / (neckLengthM + 1.7 * eqRadiusM),
              normalAxis: pAxis,
              sideSign,
            });
            portNeckVolTotal += refined.areaM2 * neckLengthM;
          }
        }
      }
    }
  }

  ports.sort((a, b) => b.areaM2 - a.areaM2);
  let cavityVolumeM3 = Math.max(0, enclosedCount * voxelVol - portNeckVolTotal);
  const openAreaFraction = totalSurfaceArea > 1e-9 ? totalOpenFaceArea / totalSurfaceArea : 0;

  // Detect unconstricted open standing-wave tubes (λ/4 closed-bottom or λ/2 open-open) so wide-open tube mouths
  // are never plugged into lumped flanged-neck Helmholtz conductance (which would overpredict pitch by ~2x / 1 octave)!
  let cavityRegime: Cavity3DAnalysis['cavityRegime'] = ports.length === 0 ? 'sealed' : 'helmholtz';
  let tubeResonanceHz: number | null = null;
  if (ports.length === 1 || ports.length === 2) {
    const p0 = ports[0];
    const tAxis = p0.normalAxis;
    const sameAxisOpposite =
      ports.length === 1 ||
      (ports[1].normalAxis === tAxis && ports[1].sideSign !== undefined && p0.sideSign !== ports[1].sideSign);
    if (tAxis !== undefined && sameAxisOpposite && Number.isFinite(cavAxisMax[tAxis])) {
      // Unconstricted open tube: interior air column includes the open mouth voxel layer
      const rawCavVol = enclosedCount * voxelVol;
      const axialLenM = Math.max(0.005, cavAxisMax[tAxis] - cavAxisMin[tAxis]);
      const meanCrossAreaM2 = rawCavVol / axialLenM;
      const eqBoreDiamM = 2 * Math.sqrt(Math.max(1e-9, meanCrossAreaM2) / Math.PI);
      if (axialLenM >= 1.45 * eqBoreDiamM && p0.areaM2 >= 0.55 * meanCrossAreaM2) {
        cavityVolumeM3 = rawCavVol;
        if (ports.length === 1) {
          cavityRegime = 'quarter_wave_tube';
          tubeResonanceHz = 343.0 / (4 * (axialLenM + 0.6133 * p0.eqRadiusM));
        } else {
          cavityRegime = 'half_wave_tube';
          const rMean = 0.5 * (p0.eqRadiusM + ports[1].eqRadiusM);
          tubeResonanceHz = 343.0 / (2 * (axialLenM + 2 * 0.6133 * rMean));
        }
      }
    }
  }

  // If > 22% of total cavity surface is wide open AND it is not an elongated standing-wave tube, it's an open cup/trough/shell!
  const isOpenCupOrShell = tubeResonanceHz === null && openAreaFraction > 0.22;
  if (isOpenCupOrShell) cavityRegime = 'open_shell';

  let totalConductanceM = 0;
  let airResonanceHz: number | null = null;
  if (!isOpenCupOrShell && cavityVolumeM3 > 1e-6) {
    if (tubeResonanceHz !== null) {
      airResonanceHz = +tubeResonanceHz.toFixed(2);
      // Equivalent conductance so existing `(343 / 2π) * sqrt(G / V)` callers resolve the exact λ/4 or λ/2 standing-wave pitch!
      totalConductanceM = cavityVolumeM3 * Math.pow((2 * Math.PI * tubeResonanceHz) / 343.0, 2);
    } else if (ports.length > 0) {
      totalConductanceM = ports.reduce((acc, p) => acc + p.conductanceM, 0);
      airResonanceHz = +((343.0 / (2 * Math.PI)) * Math.sqrt(totalConductanceM / cavityVolumeM3)).toFixed(2);
    }
  }

  const result: Cavity3DAnalysis = {
    hasHollowCavity: cavityVolumeM3 > 1e-6,
    isOpenCupOrShell,
    cavityVolumeM3,
    solidVolumeM3,
    topPlateThicknessM: Math.max(0.0008, topPlateThicknessM),
    meanWallThicknessM: Math.max(0.0008, meanWallThicknessM),
    plateSpanAM,
    plateSpanBM,
    ports: isOpenCupOrShell ? [] : ports,
    totalConductanceM,
    openAreaFraction,
    cavityRegime,
    airResonanceHz,
  };

  if (cavityCache.size > 256) {
    const firstKey = cavityCache.keys().next().value;
    if (firstKey !== undefined) cavityCache.delete(firstKey);
  }
  cavityCache.set(sig, result);
  return result;
}

// ---------------------------------------------------------------------------
// 3. Fast 3D Coupled Vibro-Acoustic Impulse-Response Simulator (FDTD Air + Kirchhoff Shell)
// ---------------------------------------------------------------------------
//
// Runs a ~4 ms time-domain 3D coupled fluid-structure simulation at 48 kHz directly
// on the voxelized 3D body + internal air cavity + open CSG/Sculpt ports + standing
// bridge, injecting a band-limited force impulse at the exact 3D bridge bearing point
// and recording the radiated 4096-sample (85.3 ms) acoustic impulse response for
// real-time WebAudio `ConvolverNode` synthesis!

export interface VibroAcousticMaterialSpec {
  modulusGPa: number;
  density: number;
  qualityQ: number;
}

export interface VibroAcousticIRResult {
  signature: string;
  sampleRate: number;
  ir: Float32Array<ArrayBuffer>;
  rawRmsPa: number;
  radiationGain: number;
}

const vibroIrCache = new Map<string, VibroAcousticIRResult>();

function intervalsTouchCell(ivs: Interval1D[], center: number, halfH: number): { hit: boolean; chordM: number } {
  let bestChord = Infinity;
  let hit = false;
  const lo = center - halfH * 0.52;
  const hi = center + halfH * 0.52;
  for (let i = 0; i < ivs.length; i++) {
    const a = ivs[i][0];
    const b = ivs[i][1];
    if (b >= lo && a <= hi) {
      hit = true;
      const chord = Math.max(0.0008, b - a);
      if (chord < bestChord) bestChord = chord;
    }
  }
  return { hit, chordM: hit ? bestChord : 0 };
}

export function simulate3DVibroAcousticIR(
  hostNode: SceneNode,
  hostMat: VibroAcousticMaterialSpec,
  bridgeNode?: SceneNode | null,
  bridgeMat?: VibroAcousticMaterialSpec | null,
  drivePointHostLocal?: [number, number, number],
): VibroAcousticIRResult | null {
  const hostSig = computeNodeGeomSignature(hostNode);
  const bridgeSig = bridgeNode ? computeNodeGeomSignature(bridgeNode) : 'nobridge';
  const bxOff = bridgeNode?.pos?.[0] ?? 0;
  const byOff = bridgeNode?.pos?.[1] ?? 0;
  const bzOff = bridgeNode?.pos?.[2] ?? 0;
  // Quantize drive coordinate to 80 mm zones (or bridge center when bridged!) so multi-string instruments
  // share one cached 3D corpus FIR instead of re-simulating per string!
  const dpKey = bridgeNode
    ? 'bridge'
    : drivePointHostLocal
      ? `${Math.round(drivePointHostLocal[0] / 0.08)},${Math.round(drivePointHostLocal[1] / 0.08)},${Math.round(drivePointHostLocal[2] / 0.08)}`
      : 'center';
  const fullSig = [
    hostSig,
    `${hostMat.modulusGPa.toFixed(3)}:${hostMat.density.toFixed(0)}:${hostMat.qualityQ.toFixed(0)}`,
    bridgeSig,
    bridgeNode
      ? `${bxOff.toFixed(3)},${byOff.toFixed(3)},${bzOff.toFixed(3)}:${(bridgeNode.quat ?? []).join(',')}:${(bridgeNode.euler ?? []).join(',')}`
      : '',
    bridgeMat ? `${bridgeMat.modulusGPa.toFixed(3)}:${bridgeMat.density.toFixed(0)}:${bridgeMat.qualityQ.toFixed(0)}` : '',
    dpKey,
  ].join('|');

  const cached = vibroIrCache.get(fullSig);
  if (cached) {
    vibroIrCache.delete(fullSig);
    vibroIrCache.set(fullSig, cached);
    return cached;
  }

  const hostScene = buildBodyRayScene(hostNode, false) ?? buildBodyRayScene(hostNode, true);
  if (!hostScene) return null;
  const bridgePoseMat = bridgeNode
    ? geomMatrixOf({
        name: '',
        type: 'box',
        size: [1, 1, 1],
        pos: bridgeNode.pos,
        quat: bridgeNode.quat,
        euler: bridgeNode.euler,
      })
    : undefined;
  const bridgeScene = bridgeNode ? buildBodyRayScene(bridgeNode, true, bridgePoseMat) : null;
  const cav = analyze3DCavityAndPorts(hostNode);

  // Collect internal welded structural bracing (e.g. Spruce Soundpost & Bass Bar inside a cello corpus)
  // whose bounds overlap `hostScene.bounds` so CSG cavity differences don't subtract out internal bracing!
  const [hx0, hx1, hy0, hy1, hz0, hz1] = hostScene.bounds;
  const internalBraceScenes: BodyRayScene[] = [];
  for (const ch of hostNode.children ?? []) {
    if (ch === bridgeNode || ch.acousticString || ch.acousticMembrane || (ch.joints?.length ?? 0) > 0) continue;
    const chMat = geomMatrixOf({
      name: '',
      type: 'box',
      size: [1, 1, 1],
      pos: ch.pos,
      quat: ch.quat,
      euler: ch.euler,
    });
    const cs = buildBodyRayScene(ch, true, chMat);
    if (!cs) continue;
    const cb = cs.bounds;
    // Only include internal/surface bracing largely inside the corpus XYZ footprint (skip external necks/tailpieces)
    if (
      cb[0] >= hx0 - 0.02 &&
      cb[1] <= hx1 + 0.02 &&
      cb[2] >= hy0 - 0.02 &&
      cb[3] <= hy1 + 0.02 &&
      cb[4] >= hz0 - 0.015 &&
      cb[5] <= hz1 + 0.015
    ) {
      internalBraceScenes.push(cs);
    }
  }

  let [x0, x1, y0, y1, z0, z1] = hostScene.bounds;
  if (bridgeScene) {
    const bb = bridgeScene.bounds;
    x0 = Math.min(x0, bb[0]);
    x1 = Math.max(x1, bb[1]);
    y0 = Math.min(y0, bb[2]);
    y1 = Math.max(y1, bb[3]);
    z0 = Math.min(z0, bb[4]);
    z1 = Math.max(z1, bb[5]);
  }

  const spanX = Math.max(0.03, x1 - x0);
  const spanY = Math.max(0.03, y1 - y0);
  const spanZ = Math.max(0.02, z1 - z0);
  const maxSpan = Math.max(spanX, spanY, spanZ);

  // Step 3D coupled FDTD + Kirchhoff shell at 24 kHz (`2048` steps = 85.3 ms decay, covering 0-12 kHz!)
  // with cubic voxels h >= 32 mm (`c_air * dt / h <= 0.44 < 0.577`), then cubic-upsample 2x to 4096 @ 48 kHz:
  // ~8x fewer grid cells & 2x fewer steps -> runs in ~5 ms total!
  const minSpan = Math.min(spanX, spanY, spanZ);
  // Ensure hollow soundboxes (e.g. 64 mm deep lyre!) get >= 3.8 voxels across their thinnest dimension
  // so top & back walls enclose real interior air-cavity cells, stepping at 48 kHz whenever h < 29 mm for Courant stability!
  const h = cav.hasHollowCavity
    ? Math.max(0.015, Math.min(minSpan / 3.8, Math.max(0.032, maxSpan / 15)))
    : Math.max(0.032, maxSpan / 15);
  const simRate = h >= 0.029 ? 24000 : 48000;
  const outSampleRate = 48000;
  const dt = 1 / simRate;
  const cAir = 343.0;
  const rhoAir = 1.204;
  const bulkAir = rhoAir * cAir * cAir;

  const pad = 2;
  const nx = Math.max(7, Math.min(20, Math.ceil(spanX / h) + 2 * pad));
  const ny = Math.max(7, Math.min(22, Math.ceil(spanY / h) + 2 * pad));
  const nz = Math.max(7, Math.min(14, Math.ceil(spanZ / h) + 2 * pad));

  const gx0 = 0.5 * (x0 + x1) - 0.5 * nx * h;
  const gy0 = 0.5 * (y0 + y1) - 0.5 * ny * h;
  const gz0 = 0.5 * (z0 + z1) - 0.5 * nz * h;

  const nCells = nx * ny * nz;
  const strideY = nz;
  const strideX = ny * nz;
  const cellIdx = (ix: number, iy: number, iz: number) => ix * strideX + iy * strideY + iz;

  // cellType: 0 = air, 1 = host solid, 2 = bridge solid
  const cellType = new Uint8Array(nCells);
  const cellWallThick = new Float32Array(nCells);

  // Pre-cast orthogonal ray pencils across the grid centers (`bridgeScene` and `internalBraceScenes` already carry full pose matrices!)
  const zHostRays: Interval1D[][] = new Array(nx * ny);
  const zBridgeRays: Interval1D[][] = new Array(nx * ny);
  for (let ix = 0; ix < nx; ix++) {
    const cx = gx0 + (ix + 0.5) * h;
    for (let iy = 0; iy < ny; iy++) {
      const cy = gy0 + (iy + 0.5) * h;
      zHostRays[ix * ny + iy] = castSceneRay(hostScene, cx, cy, 0, 0, 0, 1);
      zBridgeRays[ix * ny + iy] = bridgeScene
        ? castSceneRay(bridgeScene, cx, cy, 0, 0, 0, 1)
        : [];
    }
  }

  const xHostRays: Interval1D[][] = new Array(ny * nz);
  const xBridgeRays: Interval1D[][] = new Array(ny * nz);
  for (let iy = 0; iy < ny; iy++) {
    const cy = gy0 + (iy + 0.5) * h;
    for (let iz = 0; iz < nz; iz++) {
      const cz = gz0 + (iz + 0.5) * h;
      xHostRays[iy * nz + iz] = castSceneRay(hostScene, 0, cy, cz, 1, 0, 0);
      xBridgeRays[iy * nz + iz] = bridgeScene
        ? castSceneRay(bridgeScene, 0, cy, cz, 1, 0, 0)
        : [];
    }
  }

  const yHostRays: Interval1D[][] = new Array(nx * nz);
  const yBridgeRays: Interval1D[][] = new Array(nx * nz);
  for (let ix = 0; ix < nx; ix++) {
    const cx = gx0 + (ix + 0.5) * h;
    for (let iz = 0; iz < nz; iz++) {
      const cz = gz0 + (iz + 0.5) * h;
      yHostRays[ix * nz + iz] = castSceneRay(hostScene, cx, 0, cz, 0, 1, 0);
      yBridgeRays[ix * nz + iz] = bridgeScene
        ? castSceneRay(bridgeScene, cx, 0, cz, 0, 1, 0)
        : [];
    }
  }

  for (let ix = 1; ix < nx - 1; ix++) {
    const cx = gx0 + (ix + 0.5) * h;
    for (let iy = 1; iy < ny - 1; iy++) {
      const cy = gy0 + (iy + 0.5) * h;
      const zrH = zHostRays[ix * ny + iy];
      const zrB = zBridgeRays[ix * ny + iy];
      const inFootprintXY = zrH.length > 0;
      for (let iz = 1; iz < nz - 1; iz++) {
        const cz = gz0 + (iz + 0.5) * h;
        const c = cellIdx(ix, iy, iz);

        // Check standing bridge first
        if (bridgeScene) {
          const bzHit = intervalsTouchCell(zrB, cz, h);
          const bxHit = intervalsTouchCell(xBridgeRays[iy * nz + iz], cx, h);
          const byHit = intervalsTouchCell(yBridgeRays[ix * nz + iz], cy, h);
          if ((bzHit.hit ? 1 : 0) + (bxHit.hit ? 1 : 0) + (byHit.hit ? 1 : 0) >= 2) {
            cellType[c] = 2;
            const minCh = Math.min(
              bzHit.hit ? bzHit.chordM : Infinity,
              bxHit.hit ? bxHit.chordM : Infinity,
              byHit.hit ? byHit.chordM : Infinity,
            );
            cellWallThick[c] = Math.max(0.0015, Math.min(h, Number.isFinite(minCh) ? minCh : 0.005));
            continue;
          }
        }

        // Check internal structural bracing (e.g. Soundpost coupling belly <-> back, Bass Bar under bass foot!)
        // Fast AABB reject avoids casting 3D rays on ~98% of voxels outside the brace bounds!
        let hitBrace = false;
        const halfCellPad = 0.55 * h;
        for (let bi = 0; bi < internalBraceScenes.length; bi++) {
          const br = internalBraceScenes[bi];
          const bb = br.bounds;
          if (
            cx < bb[0] - halfCellPad || cx > bb[1] + halfCellPad ||
            cy < bb[2] - halfCellPad || cy > bb[3] + halfCellPad ||
            cz < bb[4] - halfCellPad || cz > bb[5] + halfCellPad
          ) {
            continue;
          }
          const zIvs = castSceneRay(br, cx, cy, 0, 0, 0, 1);
          const zH = intervalsTouchCell(zIvs, cz, h);
          if (!zH.hit) continue;
          const xIvs = castSceneRay(br, 0, cy, cz, 1, 0, 0);
          const yIvs = castSceneRay(br, cx, 0, cz, 0, 1, 0);
          const xH = intervalsTouchCell(xIvs, cx, h);
          const yH = intervalsTouchCell(yIvs, cy, h);
          if (xH.hit || yH.hit || zH.chordM > 0.02) {
            cellType[c] = 1;
            cellWallThick[c] = Math.max(0.004, Math.min(h, Math.min(xH.hit ? xH.chordM : h, yH.hit ? yH.chordM : h)));
            hitBrace = true;
            break;
          }
        }
        if (hitBrace) continue;

        // Check host body walls (watertight thin-shell capture so 4.5 mm plates have zero pinhole leaks,
        // while true CSG/Sculpt openings where `zrH` has a missing wall stay open!)
        const hzHit = intervalsTouchCell(zrH, cz, h);
        const hxHit = intervalsTouchCell(xHostRays[iy * nz + iz], cx, h);
        const hyHit = intervalsTouchCell(yHostRays[ix * nz + iz], cy, h);
        const hitCount = (hzHit.hit ? 1 : 0) + (hxHit.hit ? 1 : 0) + (hyHit.hit ? 1 : 0);
        if (hitCount >= 2 || (hzHit.hit && inFootprintXY && hzHit.chordM < h * 0.85)) {
          cellType[c] = 1;
          const minCh = Math.min(
            hzHit.hit ? hzHit.chordM : Infinity,
            hxHit.hit ? hxHit.chordM : Infinity,
            hyHit.hit ? hyHit.chordM : Infinity,
          );
          cellWallThick[c] = Math.max(
            0.0012,
            Math.min(h, Number.isFinite(minCh) ? minCh : cav.meanWallThicknessM),
          );
        }
      }
    }
  }

  // Ensure narrow CSG/Sculpt soundholes (< h wide, such as 12 mm cello f-holes!) have an exact-conductance
  // open air channel connecting the enclosed cavity to exterior air (zero extra 3x3 CSG raycasts!)
  const faceApertureZ = new Float32Array(nCells).fill(1.0);
  if (cav.hasHollowCavity && cav.ports.length > 0) {
    const totalPortArea = cav.ports.reduce((acc, p) => acc + p.areaM2, 0);
    const portCandidates: number[] = [];
    const midZ = 0.5 * (z0 + z1);
    for (let ix = 2; ix < nx - 2; ix++) {
      for (let iy = 2; iy < ny - 2; iy++) {
        const zrH = zHostRays[ix * ny + iy];
        if (zrH.length === 1 && zrH[0][1] < midZ) {
          for (let iz = Math.floor(nz * 0.45); iz < nz - 1; iz++) {
            const c = cellIdx(ix, iy, iz);
            if (cellType[c] === 1) {
              cellType[c] = 0;
              portCandidates.push(c);
            }
          }
        }
      }
    }
    // Fallback if narrow slit fell between coarse grid centers: open cells along top-plate negative CSG port cutters
    // (sorted by proximity to the +Z top plate so interior main-chamber voids at z ≈ 0 never masquerade as soundholes!)
    if (portCandidates.length === 0) {
      const topPlateCutters = (hostNode.geoms ?? [])
        .filter((g) => g.csg === 'difference' && g.pos && g.pos[2] > midZ + 0.18 * spanZ)
        .sort((a, b) => (b.pos![2] ?? 0) - (a.pos![2] ?? 0))
        .slice(0, Math.max(1, cav.ports.length));
      const seedSet = new Set<string>();
      const seeds: [number, number][] = [];
      const addSeedCell = (px: number, py: number) => {
        const ix = Math.max(2, Math.min(nx - 3, Math.floor((px - gx0) / h)));
        const iy = Math.max(2, Math.min(ny - 3, Math.floor((py - gy0) / h)));
        const key = `${ix},${iy}`;
        if (!seedSet.has(key)) {
          seedSet.add(key);
          seeds.push([gx0 + (ix + 0.5) * h, gy0 + (iy + 0.5) * h]);
        }
      };
      if (topPlateCutters.length > 0) {
        for (const g of topPlateCutters) {
          const px = g.pos![0];
          const py = g.pos![1];
          const halfSlotY = g.type === 'box' ? (g.size[1] ?? 0) : (g.size[0] ?? 0);
          if (halfSlotY > 0.75 * h) {
            const nPts = Math.max(3, Math.ceil((2 * halfSlotY) / h) + 1);
            for (let k = 0; k < nPts; k++) {
              const yk = py - halfSlotY + (2 * halfSlotY * k) / (nPts - 1);
              addSeedCell(px, yk);
            }
          } else {
            addSeedCell(px, py);
          }
        }
      } else {
        addSeedCell(0.5 * (x0 + x1), 0.5 * (y0 + y1));
      }
      for (const [px, py] of seeds) {
        const ix = Math.max(2, Math.min(nx - 3, Math.floor((px - gx0) / h)));
        const iy = Math.max(2, Math.min(ny - 3, Math.floor((py - gy0) / h)));
        for (let iz = Math.floor(nz * 0.48); iz < nz - 1; iz++) {
          const c = cellIdx(ix, iy, iz);
          if (cellType[c] === 1) {
            cellType[c] = 0;
            portCandidates.push(c);
          }
        }
      }
    }
    if (portCandidates.length > 0) {
      // Match discrete 3D FDTD throat conductance `G_fdtd = nPortCols * perCellAper * h / mzSeries`
      // to physical `cav.totalConductanceM` so narrow f-holes radiate true ~98 Hz Helmholtz bloom without choked-throat 1 kHz pipe ringing!
      const colSet = new Set<number>();
      for (const pc of portCandidates) colSet.add(Math.floor(pc / strideY));
      const nPortCols = Math.max(1, colSet.size);
      const mzSeries = Math.max(1, portCandidates.length / nPortCols) + 1;
      const targetG = cav.totalConductanceM > 0 ? cav.totalConductanceM : totalPortArea / Math.max(0.01, h);
      const perCellAper = Math.max(0.08, Math.min(1.15, (mzSeries * targetG) / (nPortCols * h)));
      for (const pc of portCandidates) {
        faceApertureZ[pc] = perCellAper;
        if (pc - 1 >= 0) faceApertureZ[pc - 1] = perCellAper;
      }
    }
  }

  // Pack compact solid-element tables for fast cache-friendly Kirchhoff + shell stepping
  const solidToGrid: number[] = [];
  const gridToSolid = new Int32Array(nCells).fill(-1);
  for (let c = 0; c < nCells; c++) {
    if (cellType[c] !== 0) {
      gridToSolid[c] = solidToGrid.length;
      solidToGrid.push(c);
    }
  }

  const nSolid = solidToGrid.length;
  if (nSolid === 0) return null;

  const sMass = new Float32Array(nSolid);
  const sKBend = new Float32Array(nSolid);
  const sKShear = new Float32Array(nSolid);
  const sKArch = new Float32Array(nSolid);
  const sDampMass = new Float32Array(nSolid);
  const sDampVoigt = new Float32Array(nSolid);
  const sNbrCount = new Uint8Array(nSolid);
  const sNbrIdx = new Int32Array(nSolid * 6).fill(-1);

  // Coupled solid-air faces (top/bottom Z faces & X/Y rib faces)
  const saSolid: number[] = [];
  const saAir: number[] = [];
  const saSign: number[] = [];

  const effBridgeMat = bridgeMat ?? hostMat;
  const nu = 0.30;
  const charSpan = Math.max(0.06, Math.min(spanX, spanY));
  const offsets6 = [strideX, -strideX, strideY, -strideY, 1, -1];
  // Sign of outward normal projection along primary soundboard axis (+Z / -Z dominant, plus lateral rib radiation)
  const faceOutwardWeight = [0.35, -0.35, 0.35, -0.35, 1.0, -1.0];

  for (let s = 0; s < nSolid; s++) {
    const c = solidToGrid[s];
    const isBridge = cellType[c] === 2;
    const mat = isBridge ? effBridgeMat : hostMat;
    const E = Math.max(1e6, mat.modulusGPa * 1e9);
    const rho = Math.max(80, mat.density);
    const Q = Math.max(4, mat.qualityQ);
    const hW = cellWallThick[c];

    const mass = rho * h * h * hW;
    sMass[s] = mass;

    let deg = 0;
    for (let d = 0; d < 6; d++) {
      const nc = c + offsets6[d];
      if (nc < 0 || nc >= nCells) continue;
      const ns = gridToSolid[nc];
      if (ns >= 0) {
        sNbrIdx[s * 6 + deg] = ns;
        deg++;
      } else {
        // Solid-Air interface! Couple solid shell velocity <-> air pressure!
        saSolid.push(s);
        saAir.push(nc);
        saSign.push(faceOutwardWeight[d]);
      }
    }
    sNbrCount[s] = deg;

    // Kirchhoff flexural rigidity D = E * h_w^3 / (12 * (1 - nu^2)) + curved-shell arch stiffness
    const D = (E * hW * hW * hW) / (12 * (1 - nu * nu));
    // Stability budget of explicit leapfrog at 48 kHz: total stiffness eigenvalue * dt^2 / m <= 3.1
    const degSafe = Math.max(2, deg);
    const maxTotalStiff = (2.85 * mass) / (dt * dt);

    const rawKBend = D / (h * h);
    // Standing bridge couples stiffly via relative shear bonds to the soundboard underneath (NEVER grounded to u = 0!)
    const rawKShear = isBridge
      ? Math.min(maxTotalStiff / (2.4 * degSafe), (0.35 * E * hW * h) / 0.04)
      : (Math.PI * Math.PI * D) / (charSpan * charSpan);
    const rawKArch = !isBridge && deg <= 3 ? (0.06 * E * hW * h * h) / (charSpan * charSpan) : 0;

    const eigBend = rawKBend * 4 * degSafe * degSafe;
    const eigShear = rawKShear * 2 * degSafe;
    const totalEig = eigBend + eigShear + rawKArch;
    const cflScale = totalEig > maxTotalStiff ? maxTotalStiff / totalEig : 1.0;

    sKBend[s] = rawKBend * cflScale;
    sKShear[s] = rawKShear * cflScale;
    sKArch[s] = rawKArch * cflScale;

    // Rayleigh + Kelvin-Voigt material damping calibrated to physical material Q:
    // Low modes decay with Q_material; >900 Hz grid modes get realistic wood viscoelastic rolloff (`Q ~ 55`)
    // instead of ringing like an undamped 1 kHz bell!
    sDampMass[s] = Math.min(0.18 / dt, (2 * Math.PI * 145) / Q);
    const maxVoigt = (0.24 * mass) / (dt * 2 * degSafe);
    sDampVoigt[s] = Math.min(maxVoigt, (2 * Math.PI * 1950 * mass) / (Q * degSafe));
  }

  const nCoupledFaces = saSolid.length;
  const cSolidArr = Int32Array.from(saSolid);
  const cAirArr = Int32Array.from(saAir);
  const cSignArr = Float32Array.from(saSign);

  // Locate the 3D drive solid voxels nearest the bridge/string bearing point!
  const targetX = drivePointHostLocal ? drivePointHostLocal[0] : bxOff;
  const targetY = drivePointHostLocal ? drivePointHostLocal[1] : byOff;
  const targetZ = drivePointHostLocal ? drivePointHostLocal[2] : z1 - 0.005;

  const driveList: { s: number; distSq: number }[] = [];
  for (let s = 0; s < nSolid; s++) {
    const c = solidToGrid[s];
    // Prefer driving bridge voxels when a standing bridge is present!
    if (bridgeScene && cellType[c] !== 2) continue;
    const ix = Math.floor(c / strideX);
    const rem = c - ix * strideX;
    const iy = Math.floor(rem / strideY);
    const iz = rem - iy * strideY;
    const cx = gx0 + (ix + 0.5) * h;
    const cy = gy0 + (iy + 0.5) * h;
    const cz = gz0 + (iz + 0.5) * h;
    const dSq = (cx - targetX) * (cx - targetX) + (cy - targetY) * (cy - targetY) + (cz - targetZ) * (cz - targetZ);
    driveList.push({ s, distSq: dSq });
  }
  if (driveList.length === 0) {
    for (let s = 0; s < nSolid; s++) {
      const c = solidToGrid[s];
      const ix = Math.floor(c / strideX);
      const rem = c - ix * strideX;
      const iy = Math.floor(rem / strideY);
      const iz = rem - iy * strideY;
      const cx = gx0 + (ix + 0.5) * h;
      const cy = gy0 + (iy + 0.5) * h;
      const cz = gz0 + (iz + 0.5) * h;
      const dSq = (cx - targetX) * (cx - targetX) + (cy - targetY) * (cy - targetY) + (cz - targetZ) * (cz - targetZ);
      driveList.push({ s, distSq: dSq });
    }
  }
  driveList.sort((a, b) => a.distSq - b.distSq);
  const driveNodes = driveList.slice(0, Math.min(4, driveList.length)).map((d) => d.s);
  const driveShare = 1 / Math.max(1, driveNodes.length);

  // Virtual near-field listener ring in the exterior air shell (1 voxel inside Sommerfeld boundary)
  const micCells: number[] = [];
  const micIxMid = Math.floor(nx * 0.5);
  const micIyMid = Math.floor(ny * 0.5);
  const micIzTop = nz - 2;
  const micIzBot = 1;
  for (const dx of [-2, 0, 2]) {
    for (const dy of [-3, 0, 3]) {
      const ix = Math.max(1, Math.min(nx - 2, micIxMid + dx));
      const iy = Math.max(1, Math.min(ny - 2, micIyMid + dy));
      const cTop = cellIdx(ix, iy, micIzTop);
      if (cellType[cTop] === 0) micCells.push(cTop);
    }
  }
  const cBot = cellIdx(micIxMid, micIyMid, micIzBot);
  if (cellType[cBot] === 0) micCells.push(cBot);
  const invMicCount = 1 / Math.max(1, micCells.length);

  // Precompute flat outer/inner Sommerfeld boundary index pairs once (eliminates 6 nested 2D loops per step!)
  const bOuterList: number[] = [];
  const bInnerList: number[] = [];
  const seenOuter = new Uint8Array(nCells);
  const addBound = (outer: number, inner: number) => {
    if (!seenOuter[outer]) {
      seenOuter[outer] = 1;
      bOuterList.push(outer);
      bInnerList.push(inner);
    }
  };
  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy < ny; iy++) {
      addBound(cellIdx(ix, iy, 0), cellIdx(ix, iy, 1));
      addBound(cellIdx(ix, iy, nz - 1), cellIdx(ix, iy, nz - 2));
    }
  }
  for (let ix = 0; ix < nx; ix++) {
    for (let iz = 0; iz < nz; iz++) {
      addBound(cellIdx(ix, 0, iz), cellIdx(ix, 1, iz));
      addBound(cellIdx(ix, ny - 1, iz), cellIdx(ix, ny - 2, iz));
    }
  }
  for (let iy = 0; iy < ny; iy++) {
    for (let iz = 0; iz < nz; iz++) {
      addBound(cellIdx(0, iy, iz), cellIdx(1, iy, iz));
      addBound(cellIdx(nx - 1, iy, iz), cellIdx(nx - 2, iy, iz));
    }
  }
  const nBound = bOuterList.length;
  const boundOuter = Int32Array.from(bOuterList);
  const boundInner = Int32Array.from(bInnerList);
  const pPrevOuter = new Float32Array(nBound);
  const pPrevInner = new Float32Array(nBound);

  // Allocate state arrays for 85.3 ms symplectic integration (2048 @ 24 kHz upsampled 2x, or 4096 @ 48 kHz direct)
  const nOutSamples = 4096;
  const nSteps = simRate === 24000 ? 2048 : nOutSamples;
  const irBuf = new ArrayBuffer(nOutSamples * 4);
  const ir = new Float32Array(irBuf);
  const irAir = new Float32Array(nSteps);
  const irSolid = new Float32Array(nSteps);

  const u = new Float32Array(nSolid);
  const vu = new Float32Array(nSolid);
  const lap = new Float32Array(nSolid);

  const p = new Float32Array(nCells);
  const vx = new Float32Array(nCells);
  const vy = new Float32Array(nCells);
  const vz = new Float32Array(nCells);

  const velCoeffAir = dt / (rhoAir * h);
  const pCoeffAir = (bulkAir * dt) / h;
  const murCoeff = (cAir * dt - h) / (cAir * dt + h);
  const faceArea = h * h;

  // Precompute per-solid inverse-mass*dt, Rayleigh damping*mass, and coupled-face coefficients
  // (eliminates millions of floating-point divisions inside the 2048/4096-step FDTD loop!)
  const sInvMassDt = new Float32Array(nSolid);
  const sDampMassMul = new Float32Array(nSolid);
  for (let s = 0; s < nSolid; s++) {
    sInvMassDt[s] = dt / sMass[s];
    sDampMassMul[s] = sDampMass[s] * sMass[s];
  }
  const cForceCoeff = new Float32Array(nCoupledFaces);
  const cPressCoeff = new Float32Array(nCoupledFaces);
  for (let cf = 0; cf < nCoupledFaces; cf++) {
    const s = cSolidArr[cf];
    const sign = cSignArr[cf];
    cForceCoeff[cf] = sInvMassDt[s] * faceArea * sign;
    cPressCoeff[cf] = pCoeffAir * sign;
  }

  // Precompute compact flat lists of active AIR-AIR faces and interior AIR pressure cells
  // so FDTD velocity/divergence steps run linear branch-free loops instead of 3D nested branchy scans!
  const airVxList: number[] = [];
  const airVyList: number[] = [];
  const airVzList: number[] = [];
  const airVzCoeffList: number[] = [];
  for (let ix = 0; ix < nx - 1; ix++) {
    const xOff = ix * strideX;
    for (let iy = 0; iy < ny - 1; iy++) {
      const xyOff = xOff + iy * strideY;
      for (let iz = 0; iz < nz - 1; iz++) {
        const c = xyOff + iz;
        if (cellType[c] !== 0) continue;
        if (cellType[c + strideX] === 0) airVxList.push(c);
        if (cellType[c + strideY] === 0) airVyList.push(c);
        if (cellType[c + 1] === 0) {
          airVzList.push(c);
          airVzCoeffList.push(velCoeffAir * faceApertureZ[c]);
        }
      }
    }
  }
  const airVxIdx = Int32Array.from(airVxList);
  const airVyIdx = Int32Array.from(airVyList);
  const airVzIdx = Int32Array.from(airVzList);
  const airVzCoeff = Float32Array.from(airVzCoeffList);
  const nAirVx = airVxIdx.length;
  const nAirVy = airVyIdx.length;
  const nAirVz = airVzIdx.length;

  const airPList: number[] = [];
  for (let ix = 1; ix < nx - 1; ix++) {
    const xOff = ix * strideX;
    for (let iy = 1; iy < ny - 1; iy++) {
      const xyOff = xOff + iy * strideY;
      for (let iz = 1; iz < nz - 1; iz++) {
        const c = xyOff + iz;
        if (cellType[c] === 0) airPList.push(c);
      }
    }
  }
  const airPIdx = Int32Array.from(airPList);
  const nAirP = airPIdx.length;

  const driveNodesArr = Int32Array.from(driveNodes);
  const nDrive = driveNodesArr.length;
  const micCellsArr = Int32Array.from(micCells);
  const nMics = micCellsArr.length;

  let prevBridgeVel = 0;
  let hpBridgeState = 0;
  let velPotMic = 0;

  // Band-limited 0.25 ms raised-cosine impulse (6 samples @ 24 kHz, 12 samples @ 48 kHz; unit 1e-3 N·s momentum kick)
  const rateScale = 24000 / simRate;
  const pulseLen = Math.max(6, Math.round(6 * (simRate / 24000)));
  const pulseAmp = (1.0e-3 / dt) * (2 / pulseLen);
  const velPotPole = Math.pow(0.985, rateScale);
  const velPotGain = 2 * Math.PI * 320 * dt;
  const accelRateScale = simRate / 24000;
  const hpBridgeAlpha = 1 - Math.pow(1 - 0.24, rateScale);
  const sheenStartStep = pulseLen + Math.round(2 * accelRateScale);
  const airPMicW = cav.hasHollowCavity ? 0.25 : 0.42;
  const airVelPotW = cav.hasHollowCavity ? 0.94 : 0.78;

  for (let step = 0; step < nSteps; step++) {
    // 1. Save boundary pressure for 1st-order Sommerfeld/Mur radiation absorption
    for (let b = 0; b < nBound; b++) {
      pPrevOuter[b] = p[boundOuter[b]];
      pPrevInner[b] = p[boundInner[b]];
    }

    // 2. Solid Pass 1: discrete curvature Laplacian
    for (let s = 0; s < nSolid; s++) {
      const deg = sNbrCount[s];
      const base = s * 6;
      const us = u[s];
      let sum = 0;
      for (let d = 0; d < deg; d++) {
        sum += u[sNbrIdx[base + d]] - us;
      }
      lap[s] = sum;
    }

    // 3. Solid Pass 2: Kirchhoff biharmonic bending + arch restoring + Voigt damping + external bridge impulse
    const fExt =
      step < pulseLen
        ? pulseAmp * 0.5 * (1 - Math.cos((2 * Math.PI * (step + 0.5)) / pulseLen)) * driveShare
        : 0;

    for (let s = 0; s < nSolid; s++) {
      const deg = sNbrCount[s];
      const base = s * 6;
      const laps = lap[s];
      const vus = vu[s];
      let biharm = 0;
      let vLap = 0;
      for (let d = 0; d < deg; d++) {
        const nbr = sNbrIdx[base + d];
        biharm += lap[nbr] - laps;
        vLap += vu[nbr] - vus;
      }
      const fElastic = -sKBend[s] * biharm + sKShear[s] * laps - sKArch[s] * u[s];
      const fDamp = -sDampMassMul[s] * vus + sDampVoigt[s] * vLap;
      vu[s] = vus + sInvMassDt[s] * (fElastic + fDamp);
    }

    if (fExt !== 0) {
      for (let i = 0; i < nDrive; i++) {
        const ds = driveNodesArr[i];
        vu[ds] += sInvMassDt[ds] * fExt;
      }
    }

    // Back-pressure reaction from interior/exterior air onto solid shell walls!
    for (let cf = 0; cf < nCoupledFaces; cf++) {
      vu[cSolidArr[cf]] -= cForceCoeff[cf] * p[cAirArr[cf]];
    }

    // Advance solid displacement
    for (let s = 0; s < nSolid; s++) {
      u[s] += dt * vu[s];
    }

    // 4. Staggered 3D Acoustic Air Velocity Update across compact active AIR-AIR faces
    for (let i = 0; i < nAirVx; i++) {
      const c = airVxIdx[i];
      vx[c] -= velCoeffAir * (p[c + strideX] - p[c]);
    }
    for (let i = 0; i < nAirVy; i++) {
      const c = airVyIdx[i];
      vy[c] -= velCoeffAir * (p[c + strideY] - p[c]);
    }
    for (let i = 0; i < nAirVz; i++) {
      const c = airVzIdx[i];
      vz[c] -= airVzCoeff[i] * (p[c + 1] - p[c]);
    }

    // 5. Acoustic Air Pressure Update from velocity divergence + Solid-Wall Piston Velocity Injection!
    for (let i = 0; i < nAirP; i++) {
      const c = airPIdx[i];
      p[c] -= pCoeffAir * ((vx[c] - vx[c - strideX]) + (vy[c] - vy[c - strideY]) + (vz[c] - vz[c - 1]));
    }

    for (let cf = 0; cf < nCoupledFaces; cf++) {
      p[cAirArr[cf]] += cPressCoeff[cf] * vu[cSolidArr[cf]];
    }

    // 6. 1st-Order Sommerfeld / Mur Free-Space Radiation Boundary Absorption on all 6 outer faces
    for (let b = 0; b < nBound; b++) {
      p[boundOuter[b]] = pPrevInner[b] + murCoeff * (p[boundInner[b]] - pPrevOuter[b]);
    }

    // 7. Virtual Listener Array Readout: blend radiated pressure `pMic` + leaky acoustic velocity potential `velPotMic`
    let pMic = 0;
    for (let m = 0; m < nMics; m++) {
      pMic += p[micCellsArr[m]];
    }
    pMic *= invMicCount;
    velPotMic = velPotPole * velPotMic + pMic * velPotGain;

    let bVel = 0;
    for (let i = 0; i < nDrive; i++) {
      bVel += vu[driveNodesArr[i]];
    }
    bVel *= driveShare;
    const bAccel = (bVel - prevBridgeVel) * accelRateScale;
    prevBridgeVel = bVel;
    hpBridgeState += hpBridgeAlpha * (bAccel - hpBridgeState);

    irAir[step] = airPMicW * pMic + airVelPotW * velPotMic;
    irSolid[step] = step >= sheenStartStep ? bAccel - hpBridgeState : 0;
  }

  // Post-process both radiated air pressure & free solid/bridge modes separately (sample-rate-consistent poles & 16 ms fade)
  let dcAx = 0, dcAy = 0;
  let dcSx = 0, dcSy = 0;
  let sumSqAir = 0;
  let sumSqSolid = 0;
  const dcAirPole = Math.pow(0.993, rateScale);
  const dcSolidPole = Math.pow(0.986, rateScale);
  const tailSamples = Math.round(384 * (simRate / 24000));
  const tailStart = nSteps - tailSamples;
  for (let i = 0; i < nSteps; i++) {
    const xa = Number.isFinite(irAir[i]) ? irAir[i] : 0;
    const xs = Number.isFinite(irSolid[i]) ? irSolid[i] : 0;
    dcAy = xa - dcAx + dcAirPole * dcAy;
    dcAx = xa;
    dcSy = xs - dcSx + dcSolidPole * dcSy;
    dcSx = xs;
    let win = 1.0;
    if (i >= tailStart) {
      const uTail = (i - tailStart) / tailSamples;
      win = 0.5 * (1 + Math.cos(Math.PI * uTail));
    }
    const ya = dcAy * win;
    const ys = dcSy * win;
    irAir[i] = ya;
    irSolid[i] = ys;
    sumSqAir += ya * ya;
    sumSqSolid += ys * ys;
  }

  const rawRmsPa = Math.sqrt(sumSqAir / nSteps);
  const airL2 = Math.sqrt(sumSqAir);
  const solidL2 = Math.sqrt(sumSqSolid);
  const scaleAir = airL2 > 1e-14 ? 0.88 / airL2 : 0;
  const solidBlend = cav.hasHollowCavity ? 0.14 : 0.24;
  const scaleSolid = solidL2 > 1e-14 ? (airL2 > 1e-14 ? solidBlend : 0.84) / solidL2 : 0;

  const ir24k = new Float32Array(nSteps);
  for (let i = 0; i < nSteps; i++) {
    ir24k[i] = irAir[i] * scaleAir + irSolid[i] * scaleSolid;
  }

  if (simRate === 24000) {
    // 2x Catmull-Rom cubic upsample from 2048 @ 24 kHz -> 4096 @ 48 kHz (1/sqrt(2) preserves 4096-tap L2 energy!)
    const invSqrt2 = Math.SQRT1_2;
    for (let i = 0; i < nSteps; i++) {
      const y0s = ir24k[Math.max(0, i - 1)];
      const y1s = ir24k[i];
      const y2s = ir24k[Math.min(nSteps - 1, i + 1)];
      const y3s = ir24k[Math.min(nSteps - 1, i + 2)];
      const mid = 0.5625 * (y1s + y2s) - 0.0625 * (y0s + y3s);
      ir[2 * i] = y1s * invSqrt2;
      ir[2 * i + 1] = mid * invSqrt2;
    }
  } else {
    // Direct 48 kHz simulation already has 4096 taps at target L2 energy (no 2x upsample attenuation!)
    for (let i = 0; i < nOutSamples; i++) {
      ir[i] = ir24k[i];
    }
  }

  // Exact post-window zero-DC removal (tapered at both ends so ir[nOutSamples - 1] stays strictly 0)
  let dcSum = 0;
  let wSum = 0;
  const outTailStart = nOutSamples - 768;
  for (let i = 0; i < nOutSamples; i++) {
    const v = Number.isFinite(ir[i]) ? ir[i] : 0;
    ir[i] = v;
    dcSum += v;
    const w = i < outTailStart ? 1.0 : 0.5 * (1 + Math.cos((Math.PI * (i - outTailStart)) / 768));
    wSum += w;
  }
  const dcOffset = wSum > 1e-6 ? dcSum / wSum : 0;
  let peak = 0;
  for (let i = 0; i < nOutSamples; i++) {
    const w = i < outTailStart ? 1.0 : 0.5 * (1 + Math.cos((Math.PI * (i - outTailStart)) / 768));
    const s = ir[i] - dcOffset * w;
    ir[i] = s;
    const av = Math.abs(s);
    if (av > peak) peak = av;
  }
  if (peak < 1e-6) return null;
  if (peak > 0.72) {
    const lim = 0.72 / peak;
    for (let i = 0; i < nOutSamples; i++) ir[i] *= lim;
  }

  // Reference hollow spruce soundbox radiates ~2.4e-4 Pa RMS in exterior Sommerfeld field under 1e-3 N·s impulse
  const radiationGain = +Math.max(0.28, Math.min(1.55, Math.pow(Math.max(1e-8, rawRmsPa) / 2.4e-4, 0.30))).toFixed(3);

  const out: VibroAcousticIRResult = {
    signature: fullSig,
    sampleRate: outSampleRate,
    ir,
    rawRmsPa,
    radiationGain,
  };

  if (vibroIrCache.size > 64) {
    const firstKey = vibroIrCache.keys().next().value;
    if (firstKey !== undefined) vibroIrCache.delete(firstKey);
  }
  vibroIrCache.set(fullSig, out);
  return out;
}

/**
 * Resamples a 48 kHz impulse response to `targetSampleRate` (e.g. 44.1 kHz WASAPI or 96 kHz studio)
 * with non-finite sanitization and `sourceSampleRate / targetSampleRate` tap-gain scaling so discrete
 * convolution `sum_k x[n - k] * h[k]` has identical dB transfer gain across all sample rates!
 */
export function resampleIrToContextRate(
  ir48k: Float32Array,
  targetSampleRate: number,
  sourceSampleRate = 48000,
): Float32Array<ArrayBuffer> {
  const safeTargetRate = Number.isFinite(targetSampleRate) && targetSampleRate >= 8000 ? targetSampleRate : sourceSampleRate;
  const safeSourceRate = Number.isFinite(sourceSampleRate) && sourceSampleRate >= 8000 ? sourceSampleRate : 48000;
  if (ir48k.length === 0) {
    return new Float32Array(new ArrayBuffer(64 * 4));
  }
  if (Math.abs(safeTargetRate - safeSourceRate) < 1) {
    const copy = new Float32Array(new ArrayBuffer(ir48k.length * 4));
    for (let i = 0; i < ir48k.length; i++) {
      const v = ir48k[i];
      copy[i] = Number.isFinite(v) ? v : 0;
    }
    return copy;
  }
  const outLen = Math.max(64, Math.round((ir48k.length * safeTargetRate) / safeSourceRate));
  const out = new Float32Array(new ArrayBuffer(outLen * 4));
  const ratio = safeSourceRate / safeTargetRate;
  const gainScale = ratio; // dt_target / dt_source = f_source / f_target preserves |H(f)| when conv.normalize === false
  const maxIdx = ir48k.length - 1;
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio;
    const i0 = Math.min(maxIdx, Math.floor(srcPos));
    const i1 = Math.min(maxIdx, i0 + 1);
    const frac = srcPos - i0;
    const s0 = Number.isFinite(ir48k[i0]) ? ir48k[i0] : 0;
    const s1 = Number.isFinite(ir48k[i1]) ? ir48k[i1] : 0;
    out[i] = (s0 + (s1 - s0) * frac) * gainScale;
  }
  return out;
}
