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
  /** Distance and outward normal from one read of the eight surrounding cells (trilinear and its gradient). */
  query(x: number, y: number, z: number): Contact | null {
    const fx = (x - this.min[0]) / this.cell, fy = (y - this.min[1]) / this.cell, fz = (z - this.min[2]) / this.cell;
    const [nx, ny, nz] = this.dims;
    if (fx < 0 || fy < 0 || fz < 0 || fx >= nx - 1 || fy >= ny - 1 || fz >= nz - 1) return null;
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
    // Flat where it is all one fill, well clear of the surface (or deep in): no direction, but the distance stands.
    if (!(l > 1e-12)) return dist > 0 ? { d: dist, n: [0, 0, 1] } : null;
    return { d: dist, n: [gx / l, gy / l, gz / l] };
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
  const SKIN = 0.5 * cell;
  const outside = new Uint8Array(nx * ny * nz);
  const queue: number[] = [];
  const push = (i: number, j: number, k: number) => {
    const idx = (k * ny + j) * nx + i;
    if (outside[idx] || (near[idx] && Math.abs(d[idx]) < SKIN)) return;
    outside[idx] = 1; queue.push(idx);
  };
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) push(i, j, k);
  }
  while (queue.length) {
    const idx = queue.pop()!, i = idx % nx, j = Math.floor(idx / nx) % ny, k = Math.floor(idx / (nx * ny));
    if (i > 0) push(i - 1, j, k); if (i < nx - 1) push(i + 1, j, k);
    if (j > 0) push(i, j - 1, k); if (j < ny - 1) push(i, j + 1, k);
    if (k > 0) push(i, j, k - 1); if (k < nz - 1) push(i, j, k + 1);
  }
  const far = cell * (BAND + 1);
  for (let idx = 0; idx < d.length; idx++) {
    if (!near[idx]) d[idx] = outside[idx] ? far : -far;
    else if (Math.abs(d[idx]) >= SKIN) d[idx] = outside[idx] ? Math.abs(d[idx]) : -Math.abs(d[idx]);
  }
  return new SdfGrid(min, cell, dims, d);
}

// ---------------------------------------------------------------------------
// Primitives, in their own frame.

function primitive(shape: ColliderShape, x: number, y: number, z: number): Contact | null {
  switch (shape.kind) {
    case 'sphere': {
      const l = Math.sqrt(x * x + y * y + z * z) || 1e-12;
      return { d: l - shape.r, n: [x / l, y / l, z / l] };
    }
    case 'plane':
      return { d: z, n: [0, 0, 1] };
    case 'capsule':
    case 'cylinder': {
      const { a, b, r } = shape;
      const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1e-12;
      const tRaw = ((x - a[0]) * ab[0] + (y - a[1]) * ab[1] + (z - a[2]) * ab[2]) / L2;
      const t = Math.min(1, Math.max(0, tRaw));
      const c = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
      const v = [x - c[0], y - c[1], z - c[2]], l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1e-12;
      if (shape.kind === 'capsule' || (tRaw > 0 && tRaw < 1)) return { d: l - r, n: [v[0] / l, v[1] / l, v[2] / l] };
      // A cylinder's flat end.
      const L = Math.sqrt(L2), axis = ab.map((q) => q / L), sgn = tRaw <= 0 ? -1 : 1;
      const along = (tRaw <= 0 ? -tRaw : tRaw - 1) * L;
      const radial = [v[0] - axis[0] * along * sgn, v[1] - axis[1] * along * sgn, v[2] - axis[2] * along * sgn];
      const rl = Math.sqrt(radial[0] * radial[0] + radial[1] * radial[1] + radial[2] * radial[2]);
      if (rl <= r) return { d: along, n: axis.map((q) => q * sgn) as [number, number, number] };
      return { d: Math.sqrt(along * along + (rl - r) * (rl - r)), n: [v[0] / l, v[1] / l, v[2] / l] };
    }
    case 'box': {
      const h = shape.half, q = [Math.abs(x) - h[0], Math.abs(y) - h[1], Math.abs(z) - h[2]];
      const out = [Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0)], ol = Math.sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2]);
      if (ol > 0) return { d: ol, n: [Math.sign(x) * out[0] / ol, Math.sign(y) * out[1] / ol, Math.sign(z) * out[2] / ol] };
      const m = Math.max(q[0], q[1], q[2]), ax = q.indexOf(m), n: [number, number, number] = [0, 0, 0];
      n[ax] = Math.sign([x, y, z][ax]) || 1;
      return { d: m, n };
    }
    case 'ellipsoid': {
      // Inigo Quilez's bound, with the gradient of the scaled sphere.
      const r = shape.r;
      const k0 = Math.sqrt(x / r[0] * x / r[0] + y / r[1] * y / r[1] + z / r[2] * z / r[2]), k1 = Math.hypot(x / (r[0] * r[0]), y / (r[1] * r[1]), z / (r[2] * r[2])) || 1e-12;
      const g = [x / (r[0] * r[0]), y / (r[1] * r[1]), z / (r[2] * r[2])], gl = Math.sqrt(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]) || 1e-12;
      return { d: (k0 * (k0 - 1)) / k1, n: [g[0] / gl, g[1] / gl, g[2] / gl] };
    }
    case 'sdf':
      return shape.grid.query(x, y, z);
  }
}

export function colliderContact(c: Collider, local: number[]): Contact | null {
  const { min, max } = c.bounds;
  if (local[0] < min[0] || local[1] < min[1] || local[2] < min[2] || local[0] > max[0] || local[1] > max[1] || local[2] > max[2]) return null;
  return primitive(c.shape, local[0], local[1], local[2]);
}

/**
 * A mesh as a collider: a signed-distance grid of it, cached by its data.
 * `yUp` for the scene graph's Three.js vertices; MuJoCo's are already Z-up.
 */
export function meshShape(v: ArrayLike<number>, f: ArrayLike<number>, yUp: boolean): { shape: ColliderShape; bounds: { min: number[]; max: number[] } } {
  const key = `${yUp}:${v.length}:${f.length}:${v[0]}:${v[v.length - 1]}:${v[Math.floor(v.length / 2)]}:${f[Math.floor(f.length / 3)]}`;
  let grid = gridCache.get(key);
  if (!grid) {
    const pts: number[][] = [];
    for (let i = 0; i < v.length; i += 3) pts.push(yUp ? threeToZUp(v, i) : [v[i], v[i + 1], v[i + 2]]);
    grid = buildSdf(pts, f);
    if (gridCache.size > 32) gridCache.clear();
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
        for (const g of resolveCsgGeoms(n, 'render')) {
          if (g.type === 'mesh' && g.role !== 'collision' && g.csg !== 'difference') out.push({ name: g.name, friction: g.friction?.[0] ?? 0.6 });
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
 */
export function sceneColliders(nodes: SceneNode[], floor = true): Collider[] {
  const out: Collider[] = [];
  if (floor) out.push({ body: null, local: new THREE.Matrix4(), shape: { kind: 'plane' }, friction: 0.6, bounds: { min: [-1e9, -1e9, -1e9], max: [1e9, 1e9, 1e9] } });
  const visit = (list: SceneNode[]) => {
    for (const n of list) {
      if (!n.cloth && !n.isPulleyRope) {
        for (const g of resolveCsgGeoms(n, 'render')) {
          if (g.role === 'collision' || g.csg === 'difference') continue;
          const s = shapeOf(g);
          if (s) out.push({ body: n.name || n.id, friction: g.friction?.[0] ?? 0.6, ...s });
        }
      }
      if (n.children) visit(n.children);
    }
  };
  visit(nodes);
  return out;
}
