/**
 * What cloth lies on: every drawn geom of every body that is not itself
 * cloth (a collision-only proxy is left out, so cloth lies on the surface you
 * see). Primitives are exact distance functions in their own frame; a mesh is
 * a signed-distance grid built once in its body's frame, so cloth collides
 * with its real, concave shape. Each collider is posed every step from its
 * body, so a moving body pushes cloth.
 *
 * Z-up metres throughout, mesh vertices converted from the scene graph's
 * Three.js Y-up as they are read.
 */

import * as THREE from 'three';
import type { SceneGeom, SceneNode } from '../../types/scene';
import { resolveCsgGeoms } from '../csg';
import { bodyLocalMatrix } from '../bodyWorld';
import { generateWedgeMeshData } from '../geom';

export type ColliderShape =
  | { kind: 'sphere'; r: number }
  | { kind: 'capsule'; a: number[]; b: number[]; r: number }
  | { kind: 'cylinder'; a: number[]; b: number[]; r: number }
  | { kind: 'box'; half: number[] }
  | { kind: 'ellipsoid'; r: number[] }
  | { kind: 'plane' }
  | { kind: 'sdf'; grid: SdfGrid };

export interface Collider {
  /** The MuJoCo body it moves with; null for the world (the floor). */
  body: string | null;
  /**
   * Or the MuJoCo geom it is, posed by the geom itself (a mesh read from
   * MuJoCo's own copy, which is in the geom's frame).
   */
  geom?: number;
  /** Geom frame in its body's frame. */
  local: THREE.Matrix4;
  shape: ColliderShape;
  friction: number;
  /** Bounds in the geom frame, for a quick rejection. */
  bounds: { min: number[]; max: number[] };
}

/** Signed distance and outward normal at a point in the collider's own frame. */
export interface Contact { d: number; n: [number, number, number] }
export interface ContactOut { d: number; nx: number; ny: number; nz: number }

// ---------------------------------------------------------------------------
// Signed-distance grids for meshes.

export class SdfGrid {
  readonly min: number[];
  readonly cell: number;
  readonly dims: [number, number, number];
  readonly d: Float32Array;
  constructor(min: number[], cell: number, dims: [number, number, number], d: Float32Array) {
    this.min = min; this.cell = cell; this.dims = dims; this.d = d;
  }
  private at(i: number, j: number, k: number): number {
    const [nx, ny, nz] = this.dims;
    i = Math.min(nx - 1, Math.max(0, i)); j = Math.min(ny - 1, Math.max(0, j)); k = Math.min(nz - 1, Math.max(0, k));
    return this.d[(k * ny + j) * nx + i];
  }
  /** Trilinear distance; NaN outside the grid. */
  value(x: number, y: number, z: number): number {
    const fx = (x - this.min[0]) / this.cell, fy = (y - this.min[1]) / this.cell, fz = (z - this.min[2]) / this.cell;
    const [nx, ny, nz] = this.dims;
    if (fx < 0 || fy < 0 || fz < 0 || fx > nx - 1 || fy > ny - 1 || fz > nz - 1) return NaN;
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz), u = fx - i, v = fy - j, w = fz - k;
    const c00 = this.at(i, j, k) * (1 - u) + this.at(i + 1, j, k) * u;
    const c10 = this.at(i, j + 1, k) * (1 - u) + this.at(i + 1, j + 1, k) * u;
    const c01 = this.at(i, j, k + 1) * (1 - u) + this.at(i + 1, j, k + 1) * u;
    const c11 = this.at(i, j + 1, k + 1) * (1 - u) + this.at(i + 1, j + 1, k + 1) * u;
    return (c00 * (1 - v) + c10 * v) * (1 - w) + (c01 * (1 - v) + c11 * v) * w;
  }
  /** Zero-allocation distance and outward normal into `out`; false outside the grid or at an unresolved interior point. */
  queryInto(x: number, y: number, z: number, out: ContactOut): boolean {
    const fx = (x - this.min[0]) / this.cell, fy = (y - this.min[1]) / this.cell, fz = (z - this.min[2]) / this.cell;
    const [nx, ny, nz] = this.dims;
    if (fx < 0 || fy < 0 || fz < 0 || fx >= nx - 1 || fy >= ny - 1 || fz >= nz - 1) return false;
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz), u = fx - i, v = fy - j, w = fz - k;
    const d = this.d, o = (k * ny + j) * nx + i, sy = nx, sz = nx * ny;
    const c000 = d[o], c100 = d[o + 1], c010 = d[o + sy], c110 = d[o + sy + 1];
    const c001 = d[o + sz], c101 = d[o + sz + 1], c011 = d[o + sz + sy], c111 = d[o + sz + sy + 1];
    const x00 = c000 + (c100 - c000) * u, x10 = c010 + (c110 - c010) * u, x01 = c001 + (c101 - c001) * u, x11 = c011 + (c111 - c011) * u;
    const y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
    const dist = y0 + (y1 - y0) * w;
    // Partial derivatives of the trilinear blend.
    const gx = ((c100 - c000) * (1 - v) + (c110 - c010) * v) * (1 - w) + ((c101 - c001) * (1 - v) + (c111 - c011) * v) * w;
    const gy = (x10 - x00) * (1 - w) + (x11 - x01) * w;
    const gz = y1 - y0;
    const l = Math.sqrt(gx * gx + gy * gy + gz * gz);
    if (!(l > 1e-12)) {
      if (dist > 0) { out.d = dist; out.nx = 0; out.ny = 0; out.nz = 1; return true; }
      // Deep interior local minimum where 8 surrounding nodes share the maximum inward BFS depth: push outward from grid centre.
      const cx = this.min[0] + 0.5 * (nx - 1) * this.cell, cy = this.min[1] + 0.5 * (ny - 1) * this.cell, cz = this.min[2] + 0.5 * (nz - 1) * this.cell;
      const rx = x - cx, ry = y - cy, rz = z - cz, rl = Math.hypot(rx, ry, rz);
      out.d = dist;
      if (rl > 1e-12) { out.nx = rx / rl; out.ny = ry / rl; out.nz = rz / rl; }
      else { out.nx = 0; out.ny = 0; out.nz = 1; }
      return true;
    }
    out.d = dist; out.nx = gx / l; out.ny = gy / l; out.nz = gz / l;
    return true;
  }
  /** Distance and outward normal from one read of the eight surrounding cells (trilinear and its gradient). */
  query(x: number, y: number, z: number): Contact | null {
    const tmp: ContactOut = { d: 0, nx: 0, ny: 0, nz: 0 };
    return this.queryInto(x, y, z, tmp) ? { d: tmp.d, n: [tmp.nx, tmp.ny, tmp.nz] } : null;
  }
}

const gridCache = new Map<string, SdfGrid>();

/** Closest point on triangle abc to p (Ericson), written into `out`; no allocation, as it runs a million times per grid. */
export function closestOnTri(px: number, py: number, pz: number, a: number[], b: number[], c: number[], out: number[]): void {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2], acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
  const apx = px - a[0], apy = py - a[1], apz = pz - a[2];
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; return; }
  const bpx = px - b[0], bpy = py - b[1], bpz = pz - b[2];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { out[0] = b[0]; out[1] = b[1]; out[2] = b[2]; return; }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); out[0] = a[0] + v * abx; out[1] = a[1] + v * aby; out[2] = a[2] + v * abz; return; }
  const cpx = px - c[0], cpy = py - c[1], cpz = pz - c[2];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; return; }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); out[0] = a[0] + w * acx; out[1] = a[1] + w * acy; out[2] = a[2] + w * acz; return; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    out[0] = b[0] + w * (c[0] - b[0]); out[1] = b[1] + w * (c[1] - b[1]); out[2] = b[2] + w * (c[2] - b[2]); return;
  }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  out[0] = a[0] + abx * v + acx * w; out[1] = a[1] + aby * v + acy * w; out[2] = a[2] + abz * v + acz * w;
}

/**
 * A signed-distance grid for a closed mesh (Z-up points, outward triangles),
 * exact within a band of the surface and filled beyond it: outside by flood
 * from the grid's edge, inside as minus the band.
 */
export function buildSdf(points: number[][], tris: ArrayLike<number>): SdfGrid {
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], p[a]); max[a] = Math.max(max[a], p[a]); }
  const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  // Fine enough for the thinnest part of a limb: at a ninetieth of a leg's
  // length (1 cm) a foot was three cells thick, and a sock 6 mm off it read
  // as a centimetre inside.
  const cell = Math.min(0.02, Math.max(0.004, extent / 180));
  const BAND = 2;
  const pad = cell * (BAND + 2);
  min = min.map((v) => v - pad); max = max.map((v) => v + pad);
  const dims = [0, 1, 2].map((a) => Math.ceil((max[a] - min[a]) / cell) + 1) as [number, number, number];
  const [nx, ny, nz] = dims;
  const d = new Float32Array(nx * ny * nz).fill(Infinity);
  const near = new Uint8Array(nx * ny * nz);
  const align = new Float32Array(nx * ny * nz);
  const q = [0, 0, 0];
  for (let t = 0; t < tris.length; t += 3) {
    const a = points[tris[t]], b = points[tris[t + 1]], c = points[tris[t + 2]];
    const n = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])];
    const lo = [0, 1, 2].map((ax) => Math.max(0, Math.floor((Math.min(a[ax], b[ax], c[ax]) - min[ax]) / cell) - BAND));
    const hi = [0, 1, 2].map((ax) => Math.min(dims[ax] - 1, Math.ceil((Math.max(a[ax], b[ax], c[ax]) - min[ax]) / cell) + BAND));
    const nl = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]) || 1e-12, reach = BAND * cell * 1.8;
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++) {
      const px = min[0] + i * cell, py = min[1] + j * cell, pz = min[2] + k * cell;
      // Too far from the triangle's plane to be in its band: skip the closest point.
      if (Math.abs((px - a[0]) * n[0] + (py - a[1]) * n[1] + (pz - a[2]) * n[2]) / nl > reach) continue;
      closestOnTri(px, py, pz, a, b, c, q);
      const dist = Math.sqrt((px - q[0]) * (px - q[0]) + (py - q[1]) * (py - q[1]) + (pz - q[2]) * (pz - q[2]));
      const idx = (k * ny + j) * nx + i;
      const side = (px - q[0]) * n[0] + (py - q[1]) * n[1] + (pz - q[2]) * n[2];
      // Inside or out by the nearest face; where two are as near (the
      // nearest point on the edge or corner they share), by the one facing
      // the point most squarely. By the first of them found instead, a point
      // beside the edge of a flat lid read as inside it, from the lid's side.
      const facing = Math.abs(side) / (nl * Math.max(dist, 1e-12));
      const cur = Math.abs(d[idx]), tie = Math.abs(dist - cur) <= 1e-6 + 1e-4 * dist;
      if ((dist < cur && !tie) || (tie && facing > align[idx])) {
        d[idx] = side < 0 ? -dist : dist;
        align[idx] = facing;
        near[idx] = 1;
      }
    }
  }
  // Only within the band is every triangle near enough sure to have been
  // tried; a cell further off may have met only far ones and taken its
  // distance and side from them (one beside a torso's hip read 3 cm inside
  // it). Those go to the fill below.
  for (let idx = 0; idx < d.length; idx++) if (near[idx] && Math.abs(d[idx]) > BAND * cell) { near[idx] = 0; d[idx] = Infinity; }
  // Which side: by flood from the grid's edge, through every cell further
  // than half a cell from the surface (the cells within half a cell of it
  // close it off, so the flood cannot cross), reached means outside. Those
  // nearest cells keep the side their nearest face gave them. By that face
  // alone, a cell a centimetre off a foot's toe read inside it, and a sock
  // started there.
  const SKIN = 0.6 * cell;
  const outside = new Uint8Array(nx * ny * nz);
  const queue: number[] = [];
  const push = (i: number, j: number, k: number, fromIdx = -1) => {
    const idx = (k * ny + j) * nx + i;
    if (outside[idx]) return;
    if (near[idx]) {
      if (Math.abs(d[idx]) < SKIN) return;
      if (fromIdx >= 0 && near[fromIdx] && d[fromIdx] * d[idx] <= 0) return;
    }
    outside[idx] = 1; queue.push(idx);
  };
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) push(i, j, k);
  }
  while (queue.length) {
    const idx = queue.pop()!, i = idx % nx, j = Math.floor(idx / nx) % ny, k = Math.floor(idx / (nx * ny));
    if (i > 0) push(i - 1, j, k, idx); if (i < nx - 1) push(i + 1, j, k, idx);
    if (j > 0) push(i, j - 1, k, idx); if (j < ny - 1) push(i, j + 1, k, idx);
    if (k > 0) push(i, j, k - 1, idx); if (k < nz - 1) push(i, j, k + 1, idx);
  }
  const far = cell * (BAND + 1);
  const inVisited = new Uint8Array(nx * ny * nz);
  const inQueue = new Int32Array(nx * ny * nz);
  let inHead = 0, inTail = 0;
  for (let idx = 0; idx < d.length; idx++) {
    if (!near[idx]) {
      d[idx] = outside[idx] ? far : -far;
    } else {
      if (Math.abs(d[idx]) >= SKIN) d[idx] = outside[idx] ? Math.abs(d[idx]) : -Math.abs(d[idx]);
      if (d[idx] <= 0) {
        inVisited[idx] = 1;
        inQueue[inTail++] = idx;
      }
    }
  }
  // Propagate signed distance inward (-cell per step) from the narrow band so
  // deep interior cells (> 2 cells inside) still carry an outward gradient.
  while (inHead < inTail) {
    const idx = inQueue[inHead++], base = d[idx] - cell;
    const i = idx % nx, j = Math.floor(idx / nx) % ny, k = Math.floor(idx / (nx * ny));
    const step = (ni: number, nj: number, nk: number) => {
      const nIdx = (nk * ny + nj) * nx + ni;
      if (outside[nIdx] || near[nIdx] || inVisited[nIdx]) return;
      inVisited[nIdx] = 1;
      d[nIdx] = base;
      inQueue[inTail++] = nIdx;
    };
    if (i > 0) step(i - 1, j, k); if (i < nx - 1) step(i + 1, j, k);
    if (j > 0) step(i, j - 1, k); if (j < ny - 1) step(i, j + 1, k);
    if (k > 0) step(i, j, k - 1); if (k < nz - 1) step(i, j, k + 1);
  }
  return new SdfGrid(min, cell, dims, d);
}

// ---------------------------------------------------------------------------
// Primitives, in their own frame.

function primitiveInto(shape: ColliderShape, x: number, y: number, z: number, out: ContactOut): boolean {
  switch (shape.kind) {
    case 'sphere': {
      const l = Math.sqrt(x * x + y * y + z * z);
      if (l < 1e-12) { out.d = -shape.r; out.nx = 0; out.ny = 0; out.nz = 1; return true; }
      out.d = l - shape.r; out.nx = x / l; out.ny = y / l; out.nz = z / l;
      return true;
    }
    case 'plane':
      out.d = z; out.nx = 0; out.ny = 0; out.nz = 1;
      return true;
    case 'capsule':
    case 'cylinder': {
      const { a, b, r } = shape;
      const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
      const L2 = abx * abx + aby * aby + abz * abz || 1e-12;
      const tRaw = ((x - a[0]) * abx + (y - a[1]) * aby + (z - a[2]) * abz) / L2;
      const t = Math.min(1, Math.max(0, tRaw));
      const cx = a[0] + abx * t, cy = a[1] + aby * t, cz = a[2] + abz * t;
      const vx = x - cx, vy = y - cy, vz = z - cz;
      const l = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1e-12;
      if (shape.kind === 'capsule' || (tRaw > 0 && tRaw < 1)) {
        out.d = l - r; out.nx = vx / l; out.ny = vy / l; out.nz = vz / l;
        return true;
      }
      // A cylinder's flat end.
      const L = Math.sqrt(L2), ax0 = abx / L, ax1 = aby / L, ax2 = abz / L, sgn = tRaw <= 0 ? -1 : 1;
      const along = (tRaw <= 0 ? -tRaw : tRaw - 1) * L;
      const rdx = vx - ax0 * along * sgn, rdy = vy - ax1 * along * sgn, rdz = vz - ax2 * along * sgn;
      const rl = Math.sqrt(rdx * rdx + rdy * rdy + rdz * rdz);
      if (rl <= r) { out.d = along; out.nx = ax0 * sgn; out.ny = ax1 * sgn; out.nz = ax2 * sgn; return true; }
      out.d = Math.sqrt(along * along + (rl - r) * (rl - r));
      out.nx = vx / l; out.ny = vy / l; out.nz = vz / l;
      return true;
    }
    case 'box': {
      const h = shape.half;
      const q0 = Math.abs(x) - h[0], q1 = Math.abs(y) - h[1], q2 = Math.abs(z) - h[2];
      const o0 = Math.max(q0, 0), o1 = Math.max(q1, 0), o2 = Math.max(q2, 0);
      const ol = Math.sqrt(o0 * o0 + o1 * o1 + o2 * o2);
      if (ol > 0) {
        out.d = ol; out.nx = (Math.sign(x) * o0) / ol; out.ny = (Math.sign(y) * o1) / ol; out.nz = (Math.sign(z) * o2) / ol;
        return true;
      }
      if (q0 >= q1 && q0 >= q2) { out.d = q0; out.nx = Math.sign(x) || 1; out.ny = 0; out.nz = 0; }
      else if (q1 >= q2) { out.d = q1; out.nx = 0; out.ny = Math.sign(y) || 1; out.nz = 0; }
      else { out.d = q2; out.nx = 0; out.ny = 0; out.nz = Math.sign(z) || 1; }
      return true;
    }
    case 'ellipsoid': {
      // Inigo Quilez's bound, with the gradient of the scaled sphere.
      const rx = Math.max(1e-9, shape.r[0]), ry = Math.max(1e-9, shape.r[1]), rz = Math.max(1e-9, shape.r[2]);
      const ux = x / rx, uy = y / ry, uz = z / rz;
      const k0 = Math.sqrt(ux * ux + uy * uy + uz * uz);
      if (k0 < 1e-9) {
        const minR = Math.min(rx, ry, rz);
        out.d = -minR;
        out.nx = rx === minR ? 1 : 0; out.ny = rx !== minR && ry === minR ? 1 : 0; out.nz = rx !== minR && ry !== minR ? 1 : 0;
        return true;
      }
      const gx = x / (rx * rx), gy = y / (ry * ry), gz = z / (rz * rz);
      const gl = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1e-12;
      out.d = (k0 * (k0 - 1)) / gl;
      out.nx = gx / gl; out.ny = gy / gl; out.nz = gz / gl;
      return true;
    }
    case 'sdf':
      return shape.grid.queryInto(x, y, z, out);
  }
}

export function colliderContactInto(c: Collider, lx: number, ly: number, lz: number, out: ContactOut): boolean {
  const { min, max } = c.bounds;
  if (lx < min[0] || ly < min[1] || lz < min[2] || lx > max[0] || ly > max[1] || lz > max[2]) return false;
  return primitiveInto(c.shape, lx, ly, lz, out);
}

export function colliderContact(c: Collider, local: number[]): Contact | null {
  const tmp: ContactOut = { d: 0, nx: 0, ny: 0, nz: 0 };
  return colliderContactInto(c, local[0], local[1], local[2], tmp) ? { d: tmp.d, n: [tmp.nx, tmp.ny, tmp.nz] } : null;
}

const fnvBuf = new Float32Array(1);
const fnvU32 = new Uint32Array(fnvBuf.buffer);
function hashMeshArrays(yUp: boolean, v: ArrayLike<number>, f: ArrayLike<number>): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < v.length; i++) {
    fnvBuf[0] = v[i];
    h = Math.imul(h ^ fnvU32[0], 0x01000193) >>> 0;
  }
  for (let i = 0; i < f.length; i++) h = Math.imul(h ^ f[i], 0x01000193) >>> 0;
  return `${yUp}:${v.length}:${f.length}:${h.toString(16)}`;
}

/**
 * A mesh as a collider: a signed-distance grid of it, cached by its data.
 * `yUp` for the scene graph's Three.js vertices; MuJoCo's are already Z-up.
 */
export function meshShape(v: ArrayLike<number>, f: ArrayLike<number>, yUp: boolean): { shape: ColliderShape; bounds: { min: number[]; max: number[] } } {
  const key = hashMeshArrays(yUp, v, f);
  let grid = gridCache.get(key);
  if (!grid) {
    const pts: number[][] = [];
    for (let i = 0; i < v.length; i += 3) pts.push(yUp ? threeToZUp(v, i) : [v[i], v[i + 1], v[i + 2]]);
    grid = buildSdf(pts, f);
    if (gridCache.size > 64) gridCache.clear();
    gridCache.set(key, grid);
  }
  const max = [0, 1, 2].map((a) => grid!.min[a] + (grid!.dims[a] - 1) * grid!.cell);
  return { shape: { kind: 'sdf', grid }, bounds: { min: grid.min.slice(), max } };
}

/** The drawn mesh geoms of the scene's bodies (not cloth), by name: what a mesh collider should be made of. */
export function sceneMeshGeoms(nodes: SceneNode[]): { name: string; friction: number }[] {
  const out: { name: string; friction: number }[] = [];
  const visit = (list: SceneNode[]) => {
    for (const n of list) {
      if (!n.cloth && !n.isPulleyRope) {
        if (n.isWedge && n.geoms?.length) {
          const g = n.geoms[0];
          if (g.role !== 'collision' && g.csg !== 'difference') out.push({ name: g.name, friction: g.friction?.[0] ?? 0.6 });
        } else {
          for (const g of resolveCsgGeoms(n, 'render')) {
            if (g.type === 'mesh' && g.role !== 'collision' && g.csg !== 'difference') out.push({ name: g.name, friction: g.friction?.[0] ?? 0.6 });
          }
        }
      }
      if (n.children) visit(n.children);
    }
  };
  visit(nodes);
  return out;
}

// ---------------------------------------------------------------------------
// From the scene graph.

const threeToZUp = (v: ArrayLike<number>, i: number) => [v[i], -v[i + 2], v[i + 1]];

function shapeOf(g: SceneGeom): { shape: ColliderShape; local: THREE.Matrix4; bounds: { min: number[]; max: number[] } } | null {
  const s = g.size ?? [];
  const local = g.fromto ? new THREE.Matrix4() : bodyLocalMatrix(g);
  const box = (h: number[]) => ({ min: h.map((v) => -v), max: h.slice() });
  switch (g.type) {
    case 'sphere': return { shape: { kind: 'sphere', r: s[0] }, local, bounds: box([s[0], s[0], s[0]]) };
    case 'ellipsoid': return { shape: { kind: 'ellipsoid', r: [s[0], s[1], s[2]] }, local, bounds: box([s[0], s[1], s[2]]) };
    case 'box': return { shape: { kind: 'box', half: [s[0], s[1], s[2]] }, local, bounds: box([s[0], s[1], s[2]]) };
    case 'plane': return { shape: { kind: 'plane' }, local, bounds: { min: [-1e9, -1e9, -1e9], max: [1e9, 1e9, 1e9] } };
    case 'capsule':
    case 'cylinder': {
      const a = g.fromto ? g.fromto.slice(0, 3) : [0, 0, -s[1]];
      const b = g.fromto ? g.fromto.slice(3, 6) : [0, 0, s[1]];
      const r = s[0];
      return {
        shape: { kind: g.type, a, b, r }, local,
        bounds: { min: [0, 1, 2].map((k) => Math.min(a[k], b[k]) - r), max: [0, 1, 2].map((k) => Math.max(a[k], b[k]) + r) },
      };
    }
    case 'mesh': {
      const v = g.vertices, f = g.faces;
      if (!v?.length || !f?.length) return null;
      return { local, ...meshShape(v, f, true) };
    }
    default: return null;
  }
}

/**
 * Every collider in the scene: the floor, and each drawn geom of each body
 * that is not cloth. Bodies are named as MuJoCo names them (the graph's).
 * Note: mesh geoms (and wedges, which compile to prism meshes in MJCF) are
 * skipped when `skipMeshes` is true so `mujocoMeshColliders` provides them
 * once from `MjModel` without duplicating when unstripped graphs are passed.
 */
export function sceneColliders(nodes: SceneNode[], floor = true, skipMeshes = false): Collider[] {
  const out: Collider[] = [];
  if (floor) out.push({ body: null, local: new THREE.Matrix4(), shape: { kind: 'plane' }, friction: 0.6, bounds: { min: [-1e9, -1e9, -1e9], max: [1e9, 1e9, 1e9] } });
  const visit = (list: SceneNode[]) => {
    for (const n of list) {
      if (!n.cloth && !n.isPulleyRope) {
        if (n.isWedge && n.geoms?.length) {
          if (!skipMeshes) {
            const g0 = n.geoms[0];
            if (g0.role !== 'collision' && g0.csg !== 'difference') {
              const { vertices, faces } = generateWedgeMeshData(n.width || 2.0, n.depth || 1.0, n.height || 0.5);
              const s = shapeOf({ ...g0, type: 'mesh', vertices, faces });
              if (s) out.push({ body: n.name || n.id, friction: g0.friction?.[0] ?? 0.6, ...s });
            }
          }
        } else {
          for (const g of resolveCsgGeoms(n, 'render')) {
            if (g.role === 'collision' || g.csg === 'difference') continue;
            if (skipMeshes && g.type === 'mesh') continue;
            const s = shapeOf(g);
            if (s) out.push({ body: n.name || n.id, friction: g.friction?.[0] ?? 0.6, ...s });
          }
        }
      }
      if (n.children) visit(n.children);
    }
  };
  visit(nodes);
  return out;
}
