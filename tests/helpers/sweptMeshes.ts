// Lathed, swept and boxed fixtures for the concave-contact tests: cups, bores,
// bowls, a closed drum, half-pipe chutes and pockets. Z-up, closed, and
// outward-wound — each builder checks its own signed volume and turns the lot
// over if the rule it was written with came out inward, so a fixture can never
// be silently inside out (see the winding trap in CLAUDE.md). Re-exported by
// ./meshes.

import type { MeshData } from './meshes';

const quad = (f: number[], a: number, b: number, c: number, d: number) => f.push(a, b, c, a, c, d);

export function signedVolume(m: MeshData): number {
  let v = 0;
  for (let i = 0; i < m.faces.length; i += 3) {
    const a = m.faces[i] * 3, b = m.faces[i + 1] * 3, c = m.faces[i + 2] * 3;
    const [ax, ay, az] = [m.verts[a], m.verts[a + 1], m.verts[a + 2]];
    const [bx, by, bz] = [m.verts[b], m.verts[b + 1], m.verts[b + 2]];
    const [cx, cy, cz] = [m.verts[c], m.verts[c + 1], m.verts[c + 2]];
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

function orient(m: MeshData): MeshData {
  if (signedVolume(m) < 0) {
    for (let i = 0; i < m.faces.length; i += 3) { const t = m.faces[i + 1]; m.faces[i + 1] = m.faces[i + 2]; m.faces[i + 2] = t; }
  }
  return m;
}

/**
 * A solid of revolution about Z from a closed (r, z) profile with every r > 0,
 * so nothing lies on the axis: a pinhole of radius min(r) runs through it
 * where the profile comes nearest.
 */
export function lathe(profile: [number, number][], seg = 64): MeshData {
  const verts: number[] = [], faces: number[] = [];
  const P = profile.length;
  for (const [r, z] of profile) {
    for (let i = 0; i < seg; i++) { const t = (2 * Math.PI * i) / seg; verts.push(r * Math.cos(t), r * Math.sin(t), z); }
  }
  for (let k = 0; k < P; k++) {
    const k2 = (k + 1) % P;
    for (let i = 0; i < seg; i++) { const j = (i + 1) % seg; quad(faces, k * seg + i, k * seg + j, k2 * seg + j, k2 * seg + i); }
  }
  return orient({ verts, faces });
}

/**
 * The triangle soup OpenSCAD's `rotate_extrude` writes to STL for a profile
 * that may touch the axis (r = 0): one vertex per segment per profile point,
 * the axis points included, every quad as two triangles. Positions only, nine
 * per triangle, Z-up — what utils/scadMesh.ts is handed.
 */
export function latheSoup(profile: [number, number][], seg = 64): number[] {
  const m = lathe(profile.map(([r, z]) => [Math.max(r, 1e-300), z] as [number, number]), seg);
  // Put the axis points exactly on the axis, as OpenSCAD does.
  for (let i = 0; i < m.verts.length; i += 3) {
    if (Math.hypot(m.verts[i], m.verts[i + 1]) < 1e-12) { m.verts[i] = 0; m.verts[i + 1] = 0; }
  }
  const out: number[] = [];
  for (const f of m.faces) out.push(m.verts[f * 3], m.verts[f * 3 + 1], m.verts[f * 3 + 2]);
  return out;
}

export interface Station { p: number[]; u: number[]; v: number[] }

/**
 * A half-ring (U) section, open side up (+v), swept along stations: outer
 * radius `ro`, inner `ri`, `M` facets round each arc. The caps are strips
 * between the two arcs.
 */
export function halfPipeSweep(stations: Station[], ro: number, ri: number, M = 12): MeshData {
  const prof: [number, number][] = [];
  for (let k = 0; k <= M; k++) { const a = Math.PI + (Math.PI * k) / M; prof.push([ro * Math.cos(a), ro * Math.sin(a)]); }
  for (let k = 0; k <= M; k++) { const a = 2 * Math.PI - (Math.PI * k) / M; prof.push([ri * Math.cos(a), ri * Math.sin(a)]); }
  const L = prof.length;
  const verts: number[] = [], faces: number[] = [];
  for (const s of stations) {
    for (const [a, b] of prof) verts.push(s.p[0] + a * s.u[0] + b * s.v[0], s.p[1] + a * s.u[1] + b * s.v[1], s.p[2] + a * s.u[2] + b * s.v[2]);
  }
  const N = stations.length;
  for (let i = 0; i < N - 1; i++) for (let k = 0; k < L; k++) quad(faces, i * L + k, i * L + (k + 1) % L, (i + 1) * L + (k + 1) % L, (i + 1) * L + k);
  const end = (N - 1) * L;
  for (let k = 0; k < M; k++) {
    const o0 = k, o1 = k + 1, i1 = L - 2 - k, i0 = L - 1 - k;
    quad(faces, o1, o0, i0, i1);
    quad(faces, end + o0, end + o1, end + i1, end + i0);
  }
  return orient({ verts, faces });
}

/** A straight half-pipe from `a` to `b`, open side up. */
export function straightHalfPipe(a: number[], b: number[], ro: number, ri: number, stations = 21, M = 16): MeshData {
  const d = b.map((x, i) => x - a[i]);
  const len = Math.hypot(d[0], d[1], d[2]);
  const t = d.map(x => x / len);
  // u across the channel, level; v = t x u, the channel's up.
  const h = Math.hypot(t[0], t[1]);
  const u = h > 1e-9 ? [-t[1] / h, t[0] / h, 0] : [1, 0, 0];
  const v = [t[1] * u[2] - t[2] * u[1], t[2] * u[0] - t[0] * u[2], t[0] * u[1] - t[1] * u[0]];
  return halfPipeSweep(Array.from({ length: stations }, (_, i) => ({ p: a.map((x, k) => x + (d[k] * i) / (stations - 1)), u, v })), ro, ri, M);
}

/**
 * A helical half-pipe chute about Z: radius R to the channel's centre,
 * `turns` turns falling `drop`, open side up.
 */
export function helicalHalfPipe({ R = 0.06, turns = 2, top = 0.21, drop = 0.15, ro = 0.010, ri = 0.0075, stations = 144, M = 16 } = {}): MeshData {
  return halfPipeSweep(Array.from({ length: stations + 1 }, (_, i) => {
    const t = (2 * Math.PI * turns * i) / stations;
    return { p: [R * Math.cos(t), R * Math.sin(t), top - (drop * i) / stations], u: [Math.cos(t), Math.sin(t), 0], v: [0, 0, 1] };
  }), ro, ri, M);
}

/**
 * The boundary of a union of axis-aligned boxes minus some, on the grid their
 * faces make. Exact and manifold as long as no two filled cells touch along an
 * edge only.
 */
export function boxUnion(boxes: { min: number[]; max: number[] }[], holes: { min: number[]; max: number[] }[] = []): MeshData {
  const axes = [0, 1, 2].map(k => [...new Set([...boxes, ...holes].flatMap(b => [b.min[k], b.max[k]]))].sort((a, b) => a - b));
  const [nx, ny, nz] = axes.map(a => a.length - 1);
  const inside = (b: { min: number[]; max: number[] }, c: number[]) => c.every((v, k) => v > b.min[k] && v < b.max[k]);
  const filled = new Uint8Array(nx * ny * nz);
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
    const c = [(axes[0][i] + axes[0][i + 1]) / 2, (axes[1][j] + axes[1][j + 1]) / 2, (axes[2][k] + axes[2][k + 1]) / 2];
    filled[(i * ny + j) * nz + k] = boxes.some(b => inside(b, c)) && !holes.some(h => inside(h, c)) ? 1 : 0;
  }
  const at = (i: number, j: number, k: number) => (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) ? 0 : filled[(i * ny + j) * nz + k];
  const verts: number[] = [], faces: number[] = [];
  const vid = new Map<string, number>();
  const v = (i: number, j: number, k: number) => {
    const key = `${i},${j},${k}`;
    let id = vid.get(key);
    if (id === undefined) { id = verts.length / 3; vid.set(key, id); verts.push(axes[0][i], axes[1][j], axes[2][k]); }
    return id;
  };
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
    if (!at(i, j, k)) continue;
    if (!at(i + 1, j, k)) quad(faces, v(i + 1, j, k), v(i + 1, j + 1, k), v(i + 1, j + 1, k + 1), v(i + 1, j, k + 1));
    if (!at(i - 1, j, k)) quad(faces, v(i, j, k), v(i, j, k + 1), v(i, j + 1, k + 1), v(i, j + 1, k));
    if (!at(i, j + 1, k)) quad(faces, v(i, j + 1, k), v(i, j + 1, k + 1), v(i + 1, j + 1, k + 1), v(i + 1, j + 1, k));
    if (!at(i, j - 1, k)) quad(faces, v(i, j, k), v(i + 1, j, k), v(i + 1, j, k + 1), v(i, j, k + 1));
    if (!at(i, j, k + 1)) quad(faces, v(i, j, k + 1), v(i + 1, j, k + 1), v(i + 1, j + 1, k + 1), v(i, j + 1, k + 1));
    if (!at(i, j, k - 1)) quad(faces, v(i, j, k), v(i, j + 1, k), v(i + 1, j + 1, k), v(i + 1, j, k));
  }
  return orient({ verts, faces });
}

/** A Z-up mesh moved by d. */
export function translateMesh(m: MeshData, d: number[]): MeshData {
  return { verts: m.verts.map((x, i) => x + d[i % 3]), faces: m.faces.slice() };
}

/** A Z-up mesh turned so its +Z axis lies along +X: a lathed drum on its side. */
export function zToX(m: MeshData): MeshData {
  const v: number[] = [];
  for (let i = 0; i < m.verts.length; i += 3) v.push(m.verts[i + 2], m.verts[i + 1], -m.verts[i]);
  return { verts: v, faces: m.faces.slice() };
}

/**
 * A blind-bored cup: bore radius `ri`, wall `wall`, floor `floor`, height `h`.
 * A pinhole of 0.5 mm stands in for the axis, as the scratch scenes had it.
 */
export function boredCup(ri = 0.010, wall = 0.004, floor = 0.004, h = 0.05, seg = 64): MeshData {
  return lathe([[0.0005, 0], [ri + wall, 0], [ri + wall, h], [ri, h], [ri, floor], [0.0005, floor]], seg);
}

/** Every face turned over: the same surface, inside out. */
export function flipMesh(m: MeshData): MeshData {
  const faces = m.faces.slice();
  for (let i = 0; i < faces.length; i += 3) [faces[i + 1], faces[i + 2]] = [faces[i + 2], faces[i + 1]];
  return { verts: m.verts, faces };
}
