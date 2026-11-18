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

export interface BodyRayScene {
  positives: PreparedSolidGeom[];
  differences: PreparedSolidGeom[];
  intersections: PreparedSolidGeom[];
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
  /** Actual non-empty solid span [sMin, sMax] along lenAxis. */
  lenBounds: [number, number];
  /** Actual non-empty solid span [wMin, wMax] along widthAxis. */
  widthBounds: [number, number];
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
}

// ---------------------------------------------------------------------------
// 1D CSG Interval Operations
// ---------------------------------------------------------------------------

function normalizeIntervals(raw: Interval1D[]): Interval1D[] {
  if (raw.length === 0) return [];
  if (raw.length > 1) raw.sort((a, b) => a[0] - b[0]);
  const out: Interval1D[] = [];
  for (const [a, b] of raw) {
    if (!(b > a + 1e-9)) continue;
    if (out.length > 0 && a <= out[out.length - 1][1] + 1e-8) {
      if (b > out[out.length - 1][1]) out[out.length - 1][1] = b;
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
    const axes: [number, number, number][] = [[ox, dx, sx], [oy, dy, sy], [oz, dz, sz]];
    for (const [o, d, half] of axes) {
      if (Math.abs(d) < 1e-12) {
        if (Math.abs(o) > half) return;
      } else {
        const inv = 1 / d;
        let t1 = (-half - o) * inv;
        let t2 = (half - o) * inv;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
        if (t1 > tMin) tMin = t1;
        if (t2 < tMax) tMax = t2;
        if (tMin >= tMax) return;
      }
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
    out.push([(-b - sq) / (2 * a), (-b + sq) / (2 * a)]);
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
    out.push([(-b - sq) / (2 * a), (-b + sq) / (2 * a)]);
    return;
  }

  if (pg.type === 'cylinder' || pg.type === 'capsule') {
    const r = Math.max(1e-6, s[0] ?? 0.01);
    const halfH = Math.max(1e-6, s[1] ?? 0.05);
    let tCylMin = -Infinity;
    let tCylMax = Infinity;
    const a = dx * dx + dy * dy;
    if (a < 1e-14) {
      if (ox * ox + oy * oy > r * r) return;
    } else {
      const b = 2 * (ox * dx + oy * dy);
      const c = ox * ox + oy * oy - r * r;
      const disc = b * b - 4 * a * c;
      if (disc <= 0) {
        if (pg.type === 'cylinder') return;
        tCylMin = 1; tCylMax = -1;
      } else {
        const sq = Math.sqrt(disc);
        tCylMin = (-b - sq) / (2 * a);
        tCylMax = (-b + sq) / (2 * a);
      }
    }

    let tZMin = -Infinity;
    let tZMax = Infinity;
    if (Math.abs(dz) < 1e-12) {
      if (Math.abs(oz) > halfH) {
        tZMin = 1; tZMax = -1;
      }
    } else {
      let z1 = (-halfH - oz) / dz;
      let z2 = (halfH - oz) / dz;
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
      for (const cz of [-halfH, halfH]) {
        const ooz = oz - cz;
        const b3 = 2 * (ox * dx + oy * dy + ooz * dz);
        const c3 = ox * ox + oy * oy + ooz * ooz - r * r;
        const disc = b3 * b3 - 4 * a3 * c3;
        if (disc > 1e-14) {
          const sq = Math.sqrt(disc);
          localIntervals.push([(-b3 - sq) / (2 * a3), (-b3 + sq) / (2 * a3)]);
        }
      }
    }
    for (const iv of normalizeIntervals(localIntervals)) out.push(iv);
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

    const hits: number[] = [];

    const testTri = (t: number) => {
      const i0 = faces[3 * t] * 3;
      const i1 = faces[3 * t + 1] * 3;
      const i2 = faces[3 * t + 2] * 3;
      const ax = verts[i0], ay = verts[i0 + 1], az = verts[i0 + 2];
      const e1x = verts[i1] - ax, e1y = verts[i1 + 1] - ay, e1z = verts[i1 + 2] - az;
      const e2x = verts[i2] - ax, e2y = verts[i2 + 1] - ay, e2z = verts[i2 + 2] - az;
      // pvec = d x e2
      const px = dy * e2z - dz * e2y;
      const py = dz * e2x - dx * e2z;
      const pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-14) return;
      const invDet = 1 / det;
      const tx = jx - ax, ty = jy - ay, tz = jz - az;
      const u = (tx * px + ty * py + tz * pz) * invDet;
      if (u < 0 || u > 1) return;
      const qx = ty * e1z - tz * e1y;
      const qy = tz * e1x - tx * e1z;
      const qz = tx * e1y - ty * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * invDet;
      if (v < 0 || u + v > 1) return;
      const tHit = (e2x * qx + e2y * qy + e2z * qz) * invDet;
      hits.push(tHit);
    };

    if (alignedAxis !== -1) {
      if (!pg.meshGrids) pg.meshGrids = new Map();
      let grid = pg.meshGrids.get(alignedAxis);
      if (!grid) {
        grid = buildMeshBinGrid(verts, faces, alignedAxis);
        pg.meshGrids.set(alignedAxis, grid);
      }
      const oArr = [jx, jy, jz];
      const uCoord = oArr[grid.uAxis];
      const vCoord = oArr[grid.vAxis];
      const bu = Math.floor((uCoord - grid.uMin) * grid.invDu);
      const bv = Math.floor((vCoord - grid.vMin) * grid.invDv);
      if (bu < 0 || bu >= grid.nBins || bv < 0 || bv >= grid.nBins) return;
      const triList = grid.bins[bv * grid.nBins + bu];
      for (let k = 0; k < triList.length; k++) testTri(triList[k]);
    } else {
      const nTris = Math.floor(faces.length / 3);
      for (let t = 0; t < nTris; t++) testTri(t);
    }

    if (hits.length < 2) return;
    hits.sort((a, b) => a - b);
    // Deduplicate near-coincident double hits (e.g. duplicate vertices across seams)
    const dedup: number[] = [hits[0]];
    for (let i = 1; i < hits.length; i++) {
      if (hits[i] - dedup[dedup.length - 1] > 1e-6) dedup.push(hits[i]);
    }
    for (let i = 0; i + 1 < dedup.length; i += 2) {
      if (dedup[i + 1] > dedup[i] + 1e-8) {
        out.push([dedup[i], dedup[i + 1]]);
      }
    }
  }
}

function computeLocalBoundsInFrame(g: SceneGeom, mat: THREE.Matrix4): [number, number, number, number, number, number] {
  const verts = g.renderVertices ?? g.vertices;
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

function prepareGeomWithMatrix(g: SceneGeom, worldMat: THREE.Matrix4): PreparedSolidGeom | null {
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
  const verts = g.renderVertices ?? g.vertices;
  return {
    op: g.csg === 'difference' ? 'difference' : g.csg === 'intersection' ? 'intersection' : 'union',
    type: g.type,
    size: effectiveSize,
    invMat: Float64Array.from(invThree.elements),
    detScale: Math.cbrt(Math.abs(fullMat.determinant()) || 1),
    verts: g.type === 'mesh' ? verts : undefined,
    faces: g.type === 'mesh' ? g.faces : undefined,
    localBounds: bounds,
  };
}

export function buildBodyRayScene(node: SceneNode, includeAllGeoms = false): BodyRayScene | null {
  const positives: PreparedSolidGeom[] = [];
  const differences: PreparedSolidGeom[] = [];
  const intersections: PreparedSolidGeom[] = [];

  const collectFrom = (n: SceneNode, parentMat: THREE.Matrix4, isRoot: boolean, passOnlyColliding: boolean) => {
    if (!isRoot && ((n.joints?.length ?? 0) > 0 || n.simulation || n.acousticString)) return;
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

    for (const g of chosenList) {
      if (passOnlyColliding && g.csg !== 'difference' && g.csg !== 'intersection') {
        if (g.contype === 0 && g.conaffinity === 0) continue;
      }
      const pg = prepareGeomWithMatrix(g, curMat);
      if (!pg) continue;
      if (pg.op === 'difference') differences.push(pg);
      else if (pg.op === 'intersection') intersections.push(pg);
      else positives.push(pg);
    }

    for (const ch of n.children ?? []) {
      collectFrom(ch, curMat, false, passOnlyColliding);
    }
  };

  const identity = new THREE.Matrix4();
  collectFrom(node, identity, true, !includeAllGeoms);
  if (positives.length === 0 && !includeAllGeoms) {
    differences.length = 0;
    intersections.length = 0;
    collectFrom(node, identity, true, false);
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
    bounds: [x0, x1, y0, y1, z0, z1],
  };
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
  const posRaw: Interval1D[] = [];
  for (let i = 0; i < scene.positives.length; i++) {
    rayIntersectPreparedGeom(scene.positives[i], ox, oy, oz, dx, dy, dz, posRaw);
  }
  let cur = normalizeIntervals(posRaw);
  if (cur.length === 0) return cur;

  if (scene.differences.length > 0) {
    const negRaw: Interval1D[] = [];
    for (let i = 0; i < scene.differences.length; i++) {
      rayIntersectPreparedGeom(scene.differences[i], ox, oy, oz, dx, dy, dz, negRaw);
    }
    if (negRaw.length > 0) {
      cur = subtractIntervals(cur, normalizeIntervals(negRaw));
      if (cur.length === 0) return cur;
    }
  }

  for (let i = 0; i < scene.intersections.length; i++) {
    const intRaw: Interval1D[] = [];
    rayIntersectPreparedGeom(scene.intersections[i], ox, oy, oz, dx, dy, dz, intRaw);
    cur = intersectIntervals(cur, normalizeIntervals(intRaw));
    if (cur.length === 0) return cur;
  }

  return cur;
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

function legendreBasisWithD2(xi: number, nBasis: number): { p: number[]; d2p: number[] } {
  const p = new Array<number>(nBasis).fill(0);
  const dp = new Array<number>(nBasis).fill(0);
  const d2p = new Array<number>(nBasis).fill(0);
  p[0] = 1;
  if (nBasis > 1) {
    p[1] = xi;
    dp[1] = 1;
  }
  for (let k = 1; k + 1 < nBasis; k++) {
    p[k + 1] = ((2 * k + 1) * xi * p[k] - k * p[k - 1]) / (k + 1);
    dp[k + 1] = ((2 * k + 1) * (p[k] + xi * dp[k]) - k * dp[k - 1]) / (k + 1);
    d2p[k + 1] = ((2 * k + 1) * (2 * dp[k] + xi * d2p[k]) - k * d2p[k - 1]) / (k + 1);
  }
  return { p, d2p };
}

function jacobiEigenPairs(aIn: number[][]): { values: number[]; vectors: number[][] } {
  const n = aIn.length;
  const A = aIn.map((row) => row.slice());
  const V = Array.from({ length: n }, (_, i) => {
    const r = new Array<number>(n).fill(0);
    r[i] = 1;
    return r;
  });

  for (let sweep = 0; sweep < 50; sweep++) {
    let maxOff = 0;
    let p = 0;
    let q = 1;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const v = Math.abs(A[i][j]);
        if (v > maxOff) {
          maxOff = v;
          p = i;
          q = j;
        }
      }
    }
    if (maxOff < 1e-13) break;
    const diff = A[q][q] - A[p][p];
    const t = Math.abs(A[p][q]) < Math.abs(diff) * 1e-18
      ? A[p][q] / diff
      : (() => {
          const phi = diff / (2 * A[p][q]);
          return (1 / (Math.abs(phi) + Math.sqrt(phi * phi + 1))) * (phi < 0 ? -1 : 1);
        })();
    const c = 1 / Math.sqrt(1 + t * t);
    const s = t * c;
    const tau = s / (1 + c);
    const apq = A[p][q];
    A[p][q] = 0;
    A[q][p] = 0;
    A[p][p] -= t * apq;
    A[q][q] += t * apq;
    for (let k = 0; k < n; k++) {
      if (k !== p && k !== q) {
        const akp = A[k][p];
        const akq = A[k][q];
        A[k][p] = A[p][k] = akp - s * (akq + tau * akp);
        A[k][q] = A[q][k] = akq + s * (akp - tau * akq);
      }
      const vkp = V[k][p];
      const vkq = V[k][q];
      V[k][p] = vkp - s * (vkq + tau * vkp);
      V[k][q] = vkq + s * (vkp - tau * vkq);
    }
  }

  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => A[i][i] - A[j][j]);
  return {
    values: order.map((idx) => A[idx][idx]),
    vectors: order.map((col) => V.map((row) => row[col])),
  };
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
  const nBasis = 12; // P_0..P_11 -> 2 rigid modes + 10 elastic modes
  const nStations = areaSamples.length;
  const K = Array.from({ length: nBasis }, () => new Array<number>(nBasis).fill(0));
  const M = Array.from({ length: nBasis }, () => new Array<number>(nBasis).fill(0));

  const halfL = Math.max(1e-4, lengthM * 0.5);
  const invHalfL4 = 1 / Math.pow(halfL, 4);
  const dxi = 2 / nStations;

  let maxArea = 0;
  let sumArea = 0;
  let sumInertia = 0;
  for (let q = 0; q < nStations; q++) {
    if (areaSamples[q] > maxArea) maxArea = areaSamples[q];
    sumArea += areaSamples[q];
    sumInertia += inertiaSamples[q];
  }
  const floorArea = Math.max(1e-11, maxArea * 1e-3);
  const floorInertia = Math.max(1e-18, (sumInertia / Math.max(1, nStations)) * 1e-4);

  for (let q = 0; q < nStations; q++) {
    const xi = -1 + ((q + 0.5) * 2) / nStations;
    const area = Math.max(floorArea, areaSamples[q]);
    const inertia = Math.max(floorInertia, inertiaSamples[q]);
    const { p, d2p } = legendreBasisWithD2(xi, nBasis);
    const wK = modulusPa * inertia * invHalfL4 * halfL * dxi;
    const wM = densityKgM3 * area * halfL * dxi;
    for (let i = 0; i < nBasis; i++) {
      for (let j = i; j < nBasis; j++) {
        K[i][j] += wK * d2p[i] * d2p[j];
        M[i][j] += wM * p[i] * p[j];
      }
    }
  }
  for (let i = 0; i < nBasis; i++) {
    for (let j = 0; j < i; j++) {
      K[i][j] = K[j][i];
      M[i][j] = M[j][i];
    }
  }

  // Cholesky M = L * L^T
  const L = Array.from({ length: nBasis }, () => new Array<number>(nBasis).fill(0));
  for (let i = 0; i < nBasis; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = M[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        L[i][i] = Math.sqrt(Math.max(1e-30, sum));
      } else {
        L[i][j] = sum / L[j][j];
      }
    }
  }

  const Linv = Array.from({ length: nBasis }, () => new Array<number>(nBasis).fill(0));
  for (let i = 0; i < nBasis; i++) {
    Linv[i][i] = 1 / L[i][i];
    for (let j = 0; j < i; j++) {
      let sum = 0;
      for (let k = j; k < i; k++) sum += L[i][k] * Linv[k][j];
      Linv[i][j] = -sum / L[i][i];
    }
  }

  const tmp = Array.from({ length: nBasis }, () => new Array<number>(nBasis).fill(0));
  for (let i = 0; i < nBasis; i++) {
    for (let j = 0; j < nBasis; j++) {
      let s = 0;
      for (let k = 0; k <= i; k++) s += Linv[i][k] * K[k][j];
      tmp[i][j] = s;
    }
  }
  const C = Array.from({ length: nBasis }, () => new Array<number>(nBasis).fill(0));
  for (let i = 0; i < nBasis; i++) {
    for (let j = i; j < nBasis; j++) {
      let s = 0;
      for (let k = 0; k <= j; k++) s += tmp[i][k] * Linv[j][k];
      C[i][j] = C[j][i] = s;
    }
  }

  const { values, vectors } = jacobiEigenPairs(C);
  const meanA = Math.max(1e-11, sumArea / Math.max(1, nStations));
  const meanI = Math.max(1e-18, sumInertia / Math.max(1, nStations));
  const rgSqOverLSq = (meanI / meanA) / Math.max(1e-8, lengthM * lengthM);
  // Cowper rectangular Timoshenko transverse shear + rotary inertia coefficient
  const timoCoeff = 1.35;

  const frequenciesHz: number[] = [];
  const modeVectors: number[][] = [];

  for (let idx = 2; idx < Math.min(nBasis, 8); idx++) {
    const mElastic = idx - 1; // 1, 2, 3, ...
    let omegaSq = Math.max(0, values[idx]);
    if (applyTimoshenko) {
      const waveNumSq = Math.pow((mElastic + 0.5) * Math.PI, 2);
      omegaSq /= 1 + timoCoeff * waveNumSq * rgSqOverLSq;
    }
    frequenciesHz.push(Math.sqrt(omegaSq) / (2 * Math.PI));

    // Back-transform eigenvector y -> c = L^-T * y in Legendre polynomial basis
    const y = vectors[idx];
    const coeffs = new Array<number>(nBasis).fill(0);
    for (let i = 0; i < nBasis; i++) {
      let s = 0;
      for (let k = i; k < nBasis; k++) s += Linv[k][i] * y[k];
      coeffs[i] = s;
    }
    // Normalize so max |ψ_m(ξ)| across [-1, 1] is 1.0
    let peak = 1e-12;
    for (let s = 0; s <= 24; s++) {
      const xi = -1 + (2 * s) / 24;
      const p = evaluateLegendrePoly(xi, nBasis);
      let val = 0;
      for (let k = 0; k < nBasis; k++) val += coeffs[k] * p[k];
      if (Math.abs(val) > peak) peak = Math.abs(val);
    }
    modeVectors.push(coeffs.map((c) => c / peak));
  }

  return { frequenciesHz, modeVectors };
}

export function evaluateNormalizedModeShape(coeffs: number[], xi: number): number {
  const clamped = Math.max(-1, Math.min(1, xi));
  const p = evaluateLegendrePoly(clamped, coeffs.length);
  let sum = 0;
  for (let i = 0; i < coeffs.length; i++) sum += coeffs[i] * p[i];
  return Math.abs(sum);
}

// ---------------------------------------------------------------------------
// Caching Infrastructure (Zero Steady-State Frame Overhead, Instant on Edits)
// ---------------------------------------------------------------------------

function computeNodeGeomSignature(node: SceneNode): string {
  const parts: string[] = [
    node.id,
    String(node.deformMaterial ?? ''),
    String(node.density ?? ''),
    String(node.sculptVersion ?? 0),
    node.sculptEdited ? '1' : '0',
    node.csgEnabled ? '1' : '0',
    String(node.outerRadius ?? ''),
    String(node.innerRadius ?? ''),
    String(node.height ?? ''),
  ];
  const visit = (n: SceneNode, prefix: string) => {
    for (const g of n.geoms ?? []) {
      if (g.csgDerived || g.role === 'visual' || g.type === 'plane') continue;
      const rv = g.renderVertices ?? g.vertices;
      let meshHash = '';
      if (rv && rv.length > 0) {
        // Sample 16 evenly spaced coordinates + length + faces length so any sculpt/resize invalidates cache
        const step = Math.max(1, Math.floor(rv.length / 16));
        let acc = rv.length * 31 + (g.faces?.length ?? 0);
        for (let i = 0; i < rv.length; i += step) {
          acc = (acc * 131 + Math.round(rv[i] * 1e5)) | 0;
        }
        meshHash = `${rv.length}:${g.faces?.length ?? 0}:${acc}`;
      }
      parts.push(
        `${prefix}${g.name ?? ''}:${g.type}:${g.csg ?? 'u'}:${(g.size ?? []).join(',')}:${(g.pos ?? []).join(',')}:${(g.quat ?? []).join(',')}:${(g.euler ?? []).join(',')}:${(g.fromto ?? []).join(',')}:${meshHash}`,
      );
    }
    for (const ch of n.children ?? []) {
      if ((ch.joints?.length ?? 0) > 0 || ch.simulation || ch.acousticString) continue;
      visit(ch, `${prefix}${ch.id}/${(ch.pos ?? []).join(',')}/`);
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

export function analyze3DSolidCrossSections(node: SceneNode): Solid3DSectionAnalysis {
  const sig = computeNodeGeomSignature(node);
  const cached = sectionCache.get(sig);
  if (cached) return cached;

  const scene = buildBodyRayScene(node);
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
    { len: Math.max(0.001, bx1 - bx0), axis: 0, lo: bx0, hi: bx1 },
    { len: Math.max(0.001, by1 - by0), axis: 1, lo: by0, hi: by1 },
    { len: Math.max(0.001, bz1 - bz0), axis: 2, lo: bz0, hi: bz1 },
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
  let realThick = Number.isFinite(pass.actualTMax) ? Math.max(0.001, pass.actualTMax - pass.actualTMin) : rawLens[0].len;

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
    realThick = Number.isFinite(pass.actualTMax) ? Math.max(0.001, pass.actualTMax - pass.actualTMin) : postAxes[0].len;
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
  const org: [number, number, number] = [0, 0, 0];

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
          // Confirm at least the opposite wall exists on this ray (so we're over the box, not past its outer edge)
          if (ivs.length >= 1) {
            openCount++;
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
  if (cached) return cached;

  const scene = buildBodyRayScene(node, true);
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
    };
  }

  const [x0, x1, y0, y1, z0, z1] = scene.bounds;
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
  const topPlateThicknessM = topWallCount > 0 ? topWallSum / topWallCount : meanWallThicknessM;
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
    };
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
  type OpenFaceCell = { dirId: number; iu: number; iv: number; u: number; v: number; faceArea: number };
  const openFacesByDir: Map<string, OpenFaceCell>[] = Array.from({ length: 6 }, () => new Map());

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
    for (let iy = 0; iy < ny; iy++) {
      for (let iz = 0; iz < nz; iz++) {
        if (state[idxOf(ix, iy, iz)] !== 2) continue;
        const coords = [x0 + (ix + 0.5) * hx, y0 + (iy + 0.5) * hy, z0 + (iz + 0.5) * hz];
        const ijk = [ix, iy, iz];
        for (let d = 0; d < 6; d++) {
          const [ddx, ddy, ddz, nAxis, , fArea] = dirs[d];
          const nix = ix + ddx, niy = iy + ddy, niz = iz + ddz;
          const nState = (nix < 0 || nix >= nx || niy < 0 || niy >= ny || niz < 0 || niz >= nz)
            ? 0
            : state[idxOf(nix, niy, niz)];
          if (nState === 1) {
            totalSurfaceArea += fArea;
          } else if (nState === 0) {
            totalSurfaceArea += fArea;
            totalOpenFaceArea += fArea;
            const uAxis = ((nAxis + 1) % 3) as 0 | 1 | 2;
            const vAxis = ((nAxis + 2) % 3) as 0 | 1 | 2;
            const iu = ijk[uAxis];
            const iv = ijk[vAxis];
            openFacesByDir[d].set(`${iu},${iv}`, {
              dirId: d,
              iu,
              iv,
              u: coords[uAxis],
              v: coords[vAxis],
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
    const visited = new Set<string>();

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
          for (let dv = -1; dv <= 1; dv++) {
            if (du === 0 && dv === 0) continue;
            const nk = `${cur.iu + du},${cur.iv + dv}`;
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

      const stepU = nAxis === 0 ? hy : hx;
      const stepV = nAxis === 2 ? hy : hz;
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
        // Pick axis along which cutter is farthest from cavity center
        const rel: [number, number, number] = [
          Math.abs(cx - cavMid[0]) / dxSpan,
          Math.abs(cy - cavMid[1]) / dySpan,
          Math.abs(cz - cavMid[2]) / dzSpan,
        ];
        const pAxis = (rel[2] >= rel[0] && rel[2] >= rel[1] ? 2 : rel[1] >= rel[0] ? 1 : 0) as 0 | 1 | 2;
        const sideSign = ([cx, cy, cz][pAxis] >= cavMid[pAxis] ? 1 : -1) as 1 | -1;
        const uAx = ((pAxis + 1) % 3) as 0 | 1 | 2;
        const vAx = ((pAxis + 2) % 3) as 0 | 1 | 2;
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
          });
          portNeckVolTotal += refined.areaM2 * neckLengthM;
        }
      }
    }
  }

  ports.sort((a, b) => b.areaM2 - a.areaM2);
  const cavityVolumeM3 = Math.max(0, enclosedCount * voxelVol - portNeckVolTotal);
  const openAreaFraction = totalSurfaceArea > 1e-9 ? totalOpenFaceArea / totalSurfaceArea : 0;
  // If > 22% of total cavity surface is wide open (an entire missing roof/side), it's an open cup/trough/shell, not a Helmholtz neck!
  const isOpenCupOrShell = openAreaFraction > 0.22;
  const totalConductanceM = isOpenCupOrShell
    ? 0
    : ports.reduce((acc, p) => acc + p.conductanceM, 0);

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
  };

  if (cavityCache.size > 256) {
    const firstKey = cavityCache.keys().next().value;
    if (firstKey !== undefined) cavityCache.delete(firstKey);
  }
  cavityCache.set(sig, result);
  return result;
}
