// ---------------------------------------------------------------------------
// Surface patterns laid onto a face of a part that already exists.
//
// The generators in surfacePatterns.ts are height fields over a board. This
// puts the same height field onto one region of any closed mesh: the region is
// grown from a picked point, given a (u, v) frame in real metres, refined until
// its triangles are small enough to carry the pattern, and its vertices moved
// along their normals by the sampled height.
//
// It is displacement rather than a boolean on purpose. A pattern is a few
// millimetres of detail, so the physics keeps the shape from before it (the
// MJCF never sees this mesh); what this builds is the surface that is drawn
// and exported. Displacement works the same on a flat face, a cylinder's side
// and the inside of a bowl, where a CSG cutter would have to be bent to fit.
//
// The mesh stays closed by construction. It is welded first, refinement splits
// each edge once for both triangles that share it -- including the triangle on
// the far side of the region's boundary -- and no vertex on the boundary ever
// moves, so the seam with the rest of the part is the seam it was.
//
// Pure: a mesh and a list of textures in, a mesh out. No store, no three.
// ---------------------------------------------------------------------------

import { MAX_PATTERN_CELLS, patternById, type PatternOptions } from './surfacePatterns';
import { EDGE_CREASE_DEG } from './featureEdges';
import { planeBasis, type Vec3 } from './measureSnap';
import type { PaintLayer } from './vertexPaint';

/** How a region's surface is mapped onto the flat pattern. */
export type TextureProjection = 'auto' | 'planar';

/**
 * One pattern on one region of a geom: the authoring intent, saved with the
 * scene. The region itself is not stored -- it is grown again from `seedAt`
 * every time the textured mesh is rebuilt, so it follows the face through a
 * resize or a recompiled boolean rather than pointing at triangles that no
 * longer exist.
 */
export interface SurfaceTexture {
  /** A PatternSpec id from surfacePatterns.ts. */
  pattern: string;
  options?: PatternOptions;
  /**
   * Signed metres along the surface's outward normal. Negative engraves: the
   * pattern's high ground is the face as it was and its low ground is sunk
   * this far. Positive embosses: the low ground is the face and the high
   * ground stands proud.
   */
  depthM: number;
  /** An untouched rim this wide round the region's edge, metres. */
  borderM?: number;
  /** Longest edge the region is refined to, metres. */
  cellM?: number;
  /** The point that was picked, in the frame of the positions given. */
  seedAt: number[];
  /** The outward normal there, which settles a pick on an edge between faces. */
  seedNormal?: number[];
  /** The region stops at an edge sharper than this, degrees. */
  creaseDeg?: number;
  /**
   * The region also stops where the surface has turned this far from the
   * picked point, degrees. A bowl blended into its rim by a fillet has no
   * crease at all, and without this the region would carry on over the rim
   * and down the outside.
   */
  maxTiltDeg?: number;
  projection?: TextureProjection;
  /** Turns the pattern on the face, degrees anticlockwise seen from outside. */
  twistDeg?: number;
  /** Pattern size multiplier: 2 draws every feature twice as big. */
  scale?: number;
}

export const DEFAULT_TEXTURE_CELL_M = 0.0004;
export const DEFAULT_TEXTURE_BORDER_M = 0.002;
export const DEFAULT_MAX_TILT_DEG = 75;
/**
 * Most triangles a textured mesh may have, all regions together. A region that
 * would take more is refined more coarsely, and says so.
 */
export const MAX_TEXTURE_TRIANGLES = 400_000;
/** Beyond this a planar projection is stretched by more than about 10 %. */
const PLANAR_TILT_DEG = 25;

/** What happened to one texture. */
export interface TextureRegionReport {
  /** Index into the textures given. */
  index: number;
  applied: boolean;
  /** Why it was not, when it was not. */
  reason?: string;
  /** Region area, m². */
  areaM2: number;
  /** The region's extent in the pattern's frame, metres. */
  extentM: [number, number];
  /** Triangles in the region once refined. */
  triangles: number;
  /** Cell size actually used, metres. */
  cellM: number;
  /** Depth actually used, metres; smaller than asked when the surface curves too tightly. */
  depthM: number;
  /** Area-weighted mean outward normal of the region. */
  normal: Vec3;
  /** Every facet within half a degree of the mean normal. */
  flat: boolean;
  /** The relief as laid, for drawing it in 2D (a laser's engrave layer). */
  field?: ReliefField;
}

/**
 * How much of the relief is at each point of a region, on a grid in the
 * pattern's frame: 0 is the face as it was, 1 the full depth (engraved) or
 * full height (embossed). Zero outside the region and across its border, so
 * a contour of it never runs off the face.
 */
export interface ReliefField {
  /** The grid's (0, 0) corner, and its u and v directions, in the geom's own frame. */
  origin: Vec3;
  u: Vec3;
  v: Vec3;
  cols: number;
  rows: number;
  /** Grid spacing, metres. */
  step: number;
  data: Float32Array;
  emboss: boolean;
  /** The pattern is two levels (see PatternSpec.flatTopped), so one contour says it all. */
  twoLevel: boolean;
}

export interface TexturedSurface {
  /** Welded positions, in the frame given. */
  vertices: number[];
  faces: number[];
  /** The patterns' palettes, on the displaced vertices. */
  paint?: PaintLayer;
  regions: TextureRegionReport[];
  warnings: string[];
}

// --- small vector helpers --------------------------------------------------

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 => {
  const l = len(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

// --- mesh plumbing -----------------------------------------------------------

/** Room for 2^26 vertices on either side of an edge key, inside 2^53. */
const KEY = 0x4000000;
const edgeKey = (a: number, b: number) => (a < b ? a * KEY + b : b * KEY + a);

interface Mesh {
  pos: number[];
  faces: number[];
}

/**
 * Merges coincident corners. An STL or a compiled boolean repeats every
 * corner once per triangle, and a region cannot be grown, or refined without
 * opening cracks, across edges the two sides do not share.
 */
function weld(positions: ArrayLike<number>, faces: ArrayLike<number>): Mesh {
  let extent = 0;
  for (let i = 0; i < positions.length; i++) extent = Math.max(extent, Math.abs(positions[i]));
  const tol = Math.max(1e-9, extent * 1e-7);
  const pos: number[] = [];
  const remap: number[] = [];
  const cells = new Map<string, number>();
  for (let i = 0; i < positions.length / 3; i++) {
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2];
    const key = `${Math.round(x / tol)},${Math.round(y / tol)},${Math.round(z / tol)}`;
    let idx = cells.get(key);
    if (idx === undefined) {
      idx = pos.length / 3;
      pos.push(x, y, z);
      cells.set(key, idx);
    }
    remap.push(idx);
  }
  const out: number[] = [];
  for (let f = 0; f + 2 < faces.length; f += 3) {
    const a = remap[faces[f]], b = remap[faces[f + 1]], c = remap[faces[f + 2]];
    if (a === b || b === c || a === c) continue;
    out.push(a, b, c);
  }
  return { pos, faces: out };
}

const vtx = (pos: number[], i: number): Vec3 => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];

/** Unnormalised: its length is twice the triangle's area. */
function faceCross(mesh: Mesh, f: number): Vec3 {
  const a = vtx(mesh.pos, mesh.faces[3 * f]);
  const b = vtx(mesh.pos, mesh.faces[3 * f + 1]);
  const c = vtx(mesh.pos, mesh.faces[3 * f + 2]);
  return cross(sub(b, a), sub(c, a));
}

function edgeFaces(mesh: Mesh): Map<number, number[]> {
  const map = new Map<number, number[]>();
  const n = mesh.faces.length / 3;
  for (let f = 0; f < n; f++) {
    for (let e = 0; e < 3; e++) {
      const key = edgeKey(mesh.faces[3 * f + e], mesh.faces[3 * f + ((e + 1) % 3)]);
      const list = map.get(key);
      if (list) list.push(f); else map.set(key, [f]);
    }
  }
  return map;
}

/** Squared distance from p to the triangle abc (Ericson, Real-Time Collision Detection 5.1.5). */
function pointTriangleDist2(p: Vec3, a: Vec3, b: Vec3, c: Vec3): number {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  let q: Vec3;
  if (d1 <= 0 && d2 <= 0) q = a;
  else {
    const bp = sub(p, b);
    const d3 = dot(ab, bp), d4 = dot(ac, bp);
    const cp = sub(p, c);
    const d5 = dot(ab, cp), d6 = dot(ac, cp);
    const vc = d1 * d4 - d3 * d2;
    const vb = d5 * d2 - d1 * d6;
    const va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) q = b;
    else if (d6 >= 0 && d5 <= d6) q = c;
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      const t = d1 / (d1 - d3);
      q = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
    } else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      const t = d2 / (d2 - d6);
      q = [a[0] + ac[0] * t, a[1] + ac[1] * t, a[2] + ac[2] * t];
    } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const t = (d4 - d3) / ((d4 - d3) + (d5 - d6));
      q = [b[0] + (c[0] - b[0]) * t, b[1] + (c[1] - b[1]) * t, b[2] + (c[2] - b[2]) * t];
    } else {
      const denom = 1 / (va + vb + vc);
      const v = vb * denom, w = vc * denom;
      q = [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
    }
  }
  const d = sub(p, q);
  return dot(d, d);
}

// --- the region ------------------------------------------------------------

/**
 * The face the seed lands on: the nearest triangle, and of several equally
 * near -- a pick on the edge of a box -- the one facing the way the pick did.
 * -1 when nothing is near enough to have been meant.
 */
function seedFace(mesh: Mesh, normals: Vec3[], at: Vec3, seedNormal: Vec3 | null, tol: number): number {
  const n = mesh.faces.length / 3;
  const d2 = new Float64Array(n);
  let best = Infinity;
  for (let f = 0; f < n; f++) {
    d2[f] = pointTriangleDist2(
      at,
      vtx(mesh.pos, mesh.faces[3 * f]),
      vtx(mesh.pos, mesh.faces[3 * f + 1]),
      vtx(mesh.pos, mesh.faces[3 * f + 2]),
    );
    if (d2[f] < best) best = d2[f];
  }
  if (!(best <= tol * tol)) return -1;
  const near = Math.sqrt(best) + tol * 1e-3;
  let pick = -1;
  let pickScore = -Infinity;
  for (let f = 0; f < n; f++) {
    if (d2[f] > near * near) continue;
    const score = seedNormal ? dot(normals[f], seedNormal) : -d2[f];
    if (score > pickScore) { pickScore = score; pick = f; }
  }
  return pick;
}

/**
 * Grows the region from its seed across edges gentler than the crease, while
 * the surface has not tilted more than `maxTilt` from the seed. Returns the
 * faces, or the reason there are none.
 */
function growRegion(
  mesh: Mesh,
  normals: Vec3[],
  edges: Map<number, number[]>,
  seed: number,
  creaseCos: number,
  tiltCos: number,
  claimed: Int32Array,
): number[] | 'overlap' {
  if (claimed[seed] >= 0) return 'overlap';
  const seedN = normals[seed];
  const inRegion = new Uint8Array(mesh.faces.length / 3);
  inRegion[seed] = 1;
  const region = [seed];
  for (let i = 0; i < region.length; i++) {
    const f = region[i];
    for (let e = 0; e < 3; e++) {
      const list = edges.get(edgeKey(mesh.faces[3 * f + e], mesh.faces[3 * f + ((e + 1) % 3)]));
      if (!list || list.length !== 2) continue;
      const g = list[0] === f ? list[1] : list[0];
      if (inRegion[g]) continue;
      if (dot(normals[f], normals[g]) < creaseCos) continue;
      if (dot(normals[g], seedN) < tiltCos) continue;
      if (claimed[g] >= 0) return 'overlap';
      inRegion[g] = 1;
      region.push(g);
    }
  }
  return region;
}

/**
 * The tightest the region curves, as a radius in metres: the angle between
 * neighbouring facets over the distance between their middles. Infinite on a
 * flat face.
 */
function minCurvatureRadius(mesh: Mesh, normals: Vec3[], edges: Map<number, number[]>, region: Set<number>): number {
  const centroid = (f: number): Vec3 => {
    const a = vtx(mesh.pos, mesh.faces[3 * f]);
    const b = vtx(mesh.pos, mesh.faces[3 * f + 1]);
    const c = vtx(mesh.pos, mesh.faces[3 * f + 2]);
    return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
  };
  let maxK = 0;
  for (const [key, list] of edges) {
    if (list.length !== 2 || !region.has(list[0]) || !region.has(list[1])) continue;
    const c = Math.min(1, Math.max(-1, dot(normals[list[0]], normals[list[1]])));
    const angle = Math.acos(c);
    if (angle < 1e-4) continue;
    // Across the edge, not along it: two long facets of a cylinder have their
    // middles far apart up the axis, and that distance says nothing about how
    // tightly the surface turns round it.
    const along = norm(sub(vtx(mesh.pos, key % KEY), vtx(mesh.pos, Math.floor(key / KEY))));
    const d = sub(centroid(list[0]), centroid(list[1]));
    const t = dot(d, along);
    const across = len([d[0] - along[0] * t, d[1] - along[1] * t, d[2] - along[2] * t]);
    if (across > 0) maxK = Math.max(maxK, angle / across);
  }
  return maxK > 0 ? 1 / maxK : Infinity;
}

// --- the pattern's frame -----------------------------------------------------

interface Frame {
  origin: Vec3;
  u: Vec3;
  v: Vec3;
  /** The region's extent along u and v, metres. */
  width: number;
  height: number;
}

/**
 * A planar frame for the region: u and v in the plane of its mean normal,
 * with u along whichever of the body's own axes the region is longest in, so
 * a pattern on the side of a box runs along the box rather than at whatever
 * angle a generic basis happens to give. (u, v, n) is right-handed, so the
 * pattern reads the right way round seen from outside.
 */
function planarFrame(points: Vec3[], n: Vec3, twistDeg: number): Frame {
  const span = (dir: Vec3) => {
    let lo = Infinity, hi = -Infinity;
    for (const p of points) {
      const t = dot(p, dir);
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
    return hi - lo;
  };
  let u: Vec3 | null = null;
  let best = -Infinity;
  for (const axis of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as Vec3[]) {
    const along = dot(axis, n);
    const inPlane: Vec3 = [axis[0] - n[0] * along, axis[1] - n[1] * along, axis[2] - n[2] * along];
    if (len(inPlane) < 0.5) continue;
    const dir = norm(inPlane);
    const s = span(dir);
    // A square face ties; the first axis wins, so the choice is stable.
    if (s > best * (1 + 1e-6)) { best = s; u = dir; }
  }
  if (!u) u = planeBasis(n).u;
  const t = (twistDeg * Math.PI) / 180;
  if (t !== 0) {
    const w = cross(n, u);
    u = norm([
      u[0] * Math.cos(t) + w[0] * Math.sin(t),
      u[1] * Math.cos(t) + w[1] * Math.sin(t),
      u[2] * Math.cos(t) + w[2] * Math.sin(t),
    ]);
  }
  const v = norm(cross(n, u));
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of points) {
    const a = dot(p, u), b = dot(p, v);
    if (a < u0) u0 = a;
    if (a > u1) u1 = a;
    if (b < v0) v0 = b;
    if (b > v1) v1 = b;
  }
  // On the region's own plane, not the parallel one through the frame's
  // origin: u and v alone would put the corner -- and every line drawn from
  // it -- in the middle of the part.
  let w = 0;
  for (const p of points) w += dot(p, n);
  w /= points.length || 1;
  return {
    origin: [
      u[0] * u0 + v[0] * v0 + n[0] * w,
      u[1] * u0 + v[1] * v0 + n[1] * w,
      u[2] * u0 + v[2] * v0 + n[2] * w,
    ],
    u,
    v,
    width: u1 - u0,
    height: v1 - v0,
  };
}

const project = (frame: Frame, p: Vec3): [number, number] => {
  const d = sub(p, frame.origin);
  return [dot(d, frame.u), dot(d, frame.v)];
};

// --- grids over the region ---------------------------------------------------

interface Grid {
  cols: number;
  rows: number;
  step: number;
  data: Float32Array;
}

function gridFor(width: number, height: number, cellM: number): { cols: number; rows: number; step: number } {
  // Half the cell, so the pattern is sampled finer than the mesh that carries it.
  let step = cellM / 2;
  const cells = (s: number) => (Math.ceil(width / s) + 1) * (Math.ceil(height / s) + 1);
  if (cells(step) > MAX_PATTERN_CELLS) step = Math.sqrt((width * height) / MAX_PATTERN_CELLS) * 1.05;
  while (cells(step) > MAX_PATTERN_CELLS) step *= 1.05;
  return { cols: Math.ceil(width / step) + 1, rows: Math.ceil(height / step) + 1, step };
}

function sample(grid: Grid, x: number, y: number): number {
  const fx = Math.min(grid.cols - 1, Math.max(0, x / grid.step));
  const fy = Math.min(grid.rows - 1, Math.max(0, y / grid.step));
  const c0 = Math.floor(fx), r0 = Math.floor(fy);
  const c1 = Math.min(grid.cols - 1, c0 + 1), r1 = Math.min(grid.rows - 1, r0 + 1);
  const tx = fx - c0, ty = fy - r0;
  const d = grid.data, cols = grid.cols;
  const top = d[r0 * cols + c0] * (1 - tx) + d[r0 * cols + c1] * tx;
  const bottom = d[r1 * cols + c0] * (1 - tx) + d[r1 * cols + c1] * tx;
  return top * (1 - ty) + bottom * ty;
}

/**
 * Distance in the pattern's plane to the region's edge, for every grid cell
 * within `reach` of it; `reach` everywhere else.
 */
function boundaryDistance(
  shape: { cols: number; rows: number; step: number },
  segments: [number, number, number, number][],
  reach: number,
): Grid {
  const { cols, rows, step } = shape;
  const data = new Float32Array(cols * rows).fill(reach);
  for (const [ax, ay, bx, by] of segments) {
    const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach) / step));
    const c1 = Math.min(cols - 1, Math.ceil((Math.max(ax, bx) + reach) / step));
    const r0 = Math.max(0, Math.floor((Math.min(ay, by) - reach) / step));
    const r1 = Math.min(rows - 1, Math.ceil((Math.max(ay, by) + reach) / step));
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    for (let r = r0; r <= r1; r++) {
      const y = r * step;
      for (let c = c0; c <= c1; c++) {
        const x = c * step;
        const t = l2 > 0 ? clamp01(((x - ax) * dx + (y - ay) * dy) / l2) : 0;
        const d = Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
        const i = r * cols + c;
        if (d < data[i]) data[i] = d;
      }
    }
  }
  return { cols, rows, step, data };
}

/**
 * The relief over the region's grid: the pattern, faded at the border, and
 * masked to the region by an even-odd scan of its edge -- the grid covers the
 * region's bounding box, and a face that is not a rectangle leaves corners of
 * it off the part.
 */
function reliefField(
  frame: Frame,
  heights: Grid,
  dist: Grid,
  segments: [number, number, number, number][],
  border: number,
  ramp: number,
  emboss: boolean,
  twoLevel: boolean,
): ReliefField {
  const { cols, rows, step } = heights;
  const data = new Float32Array(cols * rows);
  const crossings: number[] = [];
  for (let r = 0; r < rows; r++) {
    // Half a cell in, so a scanline never runs exactly through a corner.
    const y = Math.min((rows - 1) * step, r * step + step * 1e-3);
    crossings.length = 0;
    for (const [ax, ay, bx, by] of segments) {
      if ((ay > y) === (by > y)) continue;
      crossings.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
    }
    crossings.sort((a, b) => a - b);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(crossings[k] / step));
      const c1 = Math.min(cols - 1, Math.floor(crossings[k + 1] / step));
      for (let c = c0; c <= c1; c++) {
        const i = r * cols + c;
        const h = clamp01(heights.data[i]);
        const fade = clamp01((dist.data[i] - border) / ramp);
        data[i] = (emboss ? h : 1 - h) * fade;
      }
    }
  }
  return { origin: frame.origin, u: frame.u, v: frame.v, cols, rows, step, data, emboss, twoLevel };
}

// --- refinement --------------------------------------------------------------

/**
 * Splits every edge of a labelled face that is longer than its label's cell,
 * once per pass, until none is. Each midpoint is made once per edge and used
 * by both faces on it, so a face just outside the region is split along the
 * edge it shares and no crack opens; its other edges are left as they are.
 *
 * Returns false if it stopped at the triangle cap.
 */
function refine(mesh: Mesh, labels: number[], cells: number[], maxTriangles: number): boolean {
  const len2 = (a: number, b: number) => {
    const p = mesh.pos;
    const dx = p[3 * a] - p[3 * b], dy = p[3 * a + 1] - p[3 * b + 1], dz = p[3 * a + 2] - p[3 * b + 2];
    return dx * dx + dy * dy + dz * dz;
  };
  for (let pass = 0; pass < 64; pass++) {
    const mid = new Map<number, number>();
    const faceCount = mesh.faces.length / 3;
    for (let f = 0; f < faceCount; f++) {
      const label = labels[f];
      if (label < 0) continue;
      const limit2 = cells[label] * cells[label];
      for (let e = 0; e < 3; e++) {
        const a = mesh.faces[3 * f + e], b = mesh.faces[3 * f + ((e + 1) % 3)];
        if (len2(a, b) <= limit2) continue;
        const key = edgeKey(a, b);
        if (mid.has(key)) continue;
        const p = mesh.pos;
        mid.set(key, p.length / 3);
        p.push((p[3 * a] + p[3 * b]) / 2, (p[3 * a + 1] + p[3 * b + 1]) / 2, (p[3 * a + 2] + p[3 * b + 2]) / 2);
      }
    }
    if (mid.size === 0) return true;

    // The same face rewrites as refineInRadius in sculptMesh.ts, with each new
    // face keeping the label of the one it came from.
    const out: number[] = [];
    const outLabels: number[] = [];
    const emit = (label: number, ...v: number[]) => {
      out.push(...v);
      for (let i = 0; i < v.length / 3; i++) outLabels.push(label);
    };
    for (let f = 0; f < faceCount; f++) {
      const a = mesh.faces[3 * f], b = mesh.faces[3 * f + 1], c = mesh.faces[3 * f + 2];
      const label = labels[f];
      const ab = mid.get(edgeKey(a, b));
      const bc = mid.get(edgeKey(b, c));
      const ca = mid.get(edgeKey(c, a));
      const count = (ab !== undefined ? 1 : 0) + (bc !== undefined ? 1 : 0) + (ca !== undefined ? 1 : 0);
      if (count === 0) emit(label, a, b, c);
      else if (count === 3) emit(label, a, ab!, ca!, b, bc!, ab!, c, ca!, bc!, ab!, bc!, ca!);
      else if (count === 1) {
        if (ab !== undefined) emit(label, a, ab, c, ab, b, c);
        else if (bc !== undefined) emit(label, b, bc, a, bc, c, a);
        else emit(label, c, ca!, b, ca!, a, b);
      } else {
        let p0 = a, p1 = b, p2 = c, m01 = ab, m12 = bc;
        if (ca === undefined) {
          // already oriented: the unsplit edge is c -> a
        } else if (ab === undefined) {
          p0 = b; p1 = c; p2 = a; m01 = bc; m12 = ca;
        } else {
          p0 = c; p1 = a; p2 = b; m01 = ca; m12 = ab;
        }
        emit(label, p1, m12!, m01!);
        if (len2(m01!, p2) <= len2(m12!, p0)) emit(label, p0, m01!, p2, m01!, m12!, p2);
        else emit(label, p0, m12!, p2, p0, m01!, m12!);
      }
    }
    mesh.faces = out;
    // Copied rather than spread: a spread of this many arguments overflows the stack.
    labels.length = outLabels.length;
    for (let i = 0; i < outLabels.length; i++) labels[i] = outLabels[i];
    if (out.length / 3 > maxTriangles) return false;
  }
  return true;
}

// --- the whole job -------------------------------------------------------------

/** Faces whose normal turned round when the vertices moved: the surface folded. */
function countFolds(mesh: Mesh, labels: number[], label: number, before: Vec3[]): number {
  let folds = 0;
  for (let f = 0; f < labels.length; f++) {
    if (labels[f] !== label) continue;
    if (dot(faceCross(mesh, f), before[f]) <= 0) folds++;
  }
  return folds;
}

/**
 * Lays each texture onto its region of the mesh, in order.
 *
 * `positions` and `faces` are a closed, outward-wound mesh in any frame; the
 * textures' seeds are in the same one. A texture whose seed misses the mesh,
 * or whose region overlaps one laid before it, is reported and skipped; the
 * rest still go on.
 */
export function applySurfaceTextures(
  positions: ArrayLike<number>,
  faces: ArrayLike<number>,
  textures: SurfaceTexture[],
  options: { maxTriangles?: number } = {},
): TexturedSurface {
  const maxTriangles = options.maxTriangles ?? MAX_TEXTURE_TRIANGLES;
  const mesh = weld(positions, faces);
  const warnings: string[] = [];
  const regions: TextureRegionReport[] = [];
  const faceCount = mesh.faces.length / 3;

  const normals: Vec3[] = [];
  const areas: number[] = [];
  for (let f = 0; f < faceCount; f++) {
    const c = faceCross(mesh, f);
    normals.push(norm(c));
    areas.push(len(c) / 2);
  }
  const edges = edgeFaces(mesh);

  let extent = 0;
  {
    const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mesh.pos.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], mesh.pos[i + a]);
        hi[a] = Math.max(hi[a], mesh.pos[i + a]);
      }
    }
    if (mesh.pos.length) extent = len(sub(hi, lo));
  }
  // A pick is a point on the surface; this much slack covers a pick made on a
  // slightly different tessellation of the same shape.
  const seedTol = Math.max(5e-4, extent * 0.01);

  const claimed = new Int32Array(faceCount).fill(-1);
  interface Job {
    index: number;
    texture: SurfaceTexture;
    faces: number[];
    normal: Vec3;
    frame: Frame;
    cellM: number;
    depthM: number;
    report: TextureRegionReport;
  }
  const jobs: Job[] = [];
  const skip = (index: number, reason: string) => {
    regions.push({
      index, applied: false, reason, areaM2: 0, extentM: [0, 0], triangles: 0, cellM: 0, depthM: 0,
      normal: [0, 0, 0], flat: false,
    });
    warnings.push(`Pattern ${index + 1}: ${reason}`);
  };

  textures.forEach((texture, index) => {
    const spec = patternById(texture.pattern);
    if (!spec) return skip(index, `there is no pattern called "${texture.pattern}".`);
    if (spec.throughCut) return skip(index, `${spec.label} cuts right through a board, so it cannot be laid on a face.`);
    if (!(Math.abs(texture.depthM) > 0)) return skip(index, 'its depth is zero.');

    const at = texture.seedAt as Vec3;
    const seedN = texture.seedNormal ? norm(texture.seedNormal as Vec3) : null;
    const seed = seedFace(mesh, normals, at, seedN, seedTol);
    if (seed < 0) return skip(index, 'the point it was put on is no longer on the part.');

    const creaseCos = Math.cos(((texture.creaseDeg ?? EDGE_CREASE_DEG) * Math.PI) / 180);
    const tiltCos = Math.cos(((texture.maxTiltDeg ?? DEFAULT_MAX_TILT_DEG) * Math.PI) / 180);
    const grown = growRegion(mesh, normals, edges, seed, creaseCos, tiltCos, claimed);
    if (grown === 'overlap') return skip(index, 'it overlaps a pattern already on that face.');

    let area = 0;
    let sum: Vec3 = [0, 0, 0];
    for (const f of grown) {
      area += areas[f];
      sum = [sum[0] + normals[f][0] * areas[f], sum[1] + normals[f][1] * areas[f], sum[2] + normals[f][2] * areas[f]];
    }
    const normal = norm(sum);
    let minCos = 1;
    for (const f of grown) minCos = Math.min(minCos, dot(normals[f], normal));
    const flat = minCos >= Math.cos((0.5 * Math.PI) / 180);
    const tiltDeg = (Math.acos(Math.min(1, minCos)) * 180) / Math.PI;
    if (tiltDeg > PLANAR_TILT_DEG) {
      const stretch = Math.round((1 / Math.max(0.05, minCos) - 1) * 100);
      warnings.push(`Pattern ${index + 1}: the surface turns ${Math.round(tiltDeg)}° away from flat, so the pattern stretches by up to ${stretch} % there.`);
    }

    const verts = new Set<number>();
    for (const f of grown) for (let k = 0; k < 3; k++) verts.add(mesh.faces[3 * f + k]);
    const points = [...verts].map((i) => vtx(mesh.pos, i));
    const frame = planarFrame(points, normal, texture.twistDeg ?? 0);

    // A deep engrave on a tight curve folds the surface through itself.
    let depthM = texture.depthM;
    const radius = minCurvatureRadius(mesh, normals, edges, new Set(grown));
    if (Math.abs(depthM) > radius / 2) {
      depthM = Math.sign(depthM) * (radius / 2);
      warnings.push(`Pattern ${index + 1}: the surface curves too tightly for ${(Math.abs(texture.depthM) * 1000).toFixed(1)} mm, so it is ${(Math.abs(depthM) * 1000).toFixed(1)} mm deep.`);
    }

    for (const f of grown) claimed[f] = index;
    const cellM = Math.max(1e-5, texture.cellM ?? DEFAULT_TEXTURE_CELL_M);
    const report: TextureRegionReport = {
      index, applied: true, areaM2: area, extentM: [frame.width, frame.height], triangles: 0, cellM, depthM,
      normal, flat,
    };
    jobs.push({ index, texture, faces: grown, normal, frame, cellM, depthM, report });
  });

  // Coarsen to fit the cap before refining, rather than stopping half way:
  // a triangle refined to edges under c averages about c²/5 of area.
  const PER_TRIANGLE = 0.2;
  const budget = Math.max(0, maxTriangles - faceCount);
  const wanted = jobs.reduce((n, j) => n + j.report.areaM2 / (PER_TRIANGLE * j.cellM * j.cellM), 0);
  if (wanted > budget && jobs.length) {
    const k = Math.sqrt(wanted / Math.max(1, budget));
    for (const job of jobs) {
      job.cellM *= k;
      job.report.cellM = job.cellM;
    }
    warnings.push(`The patterned surface would be too many triangles at the size asked for, so it is refined to ${(jobs[0].cellM * 1000).toFixed(2)} mm.`);
  }

  const labels: number[] = Array.from(claimed).map((owner) => jobs.findIndex((j) => j.index === owner));
  if (jobs.length && !refine(mesh, labels, jobs.map((j) => j.cellM), maxTriangles * 1.25)) {
    warnings.push('Refinement stopped at the triangle limit; the pattern is coarser than asked for.');
  }

  // Which job each vertex is inside of; -1 outside every region, -2 on the
  // edge of one (shared with a face that is not in it), which never moves.
  const vertexCount = mesh.pos.length / 3;
  const owner = new Int32Array(vertexCount).fill(-3);
  for (let f = 0; f < labels.length; f++) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.faces[3 * f + k];
      if (owner[v] === -3) owner[v] = labels[f];
      else if (owner[v] !== labels[f]) owner[v] = -2;
    }
  }
  // An open mesh's own rim is an edge too.
  const faceEdges = edgeFaces(mesh);
  for (const [key, list] of faceEdges) {
    if (list.length === 2) continue;
    owner[Math.floor(key / KEY)] = -2;
    owner[key % KEY] = -2;
  }

  const before: Vec3[] = [];
  for (let f = 0; f < labels.length; f++) before.push(labels[f] >= 0 ? faceCross(mesh, f) : [0, 0, 0]);
  const original = mesh.pos.slice();

  // Vertex normals, area-weighted over each region's own faces only, so a
  // region's edge does not lean towards the face next door.
  const vNormal = new Float64Array(vertexCount * 3);
  for (let f = 0; f < labels.length; f++) {
    if (labels[f] < 0) continue;
    const c = before[f];
    for (let k = 0; k < 3; k++) {
      const v = mesh.faces[3 * f + k];
      vNormal[3 * v] += c[0];
      vNormal[3 * v + 1] += c[1];
      vNormal[3 * v + 2] += c[2];
    }
  }

  const paintIdx: number[] = [];
  const paintRgba: number[] = [];
  const members: number[][] = jobs.map(() => []);
  for (let v = 0; v < vertexCount; v++) if (owner[v] >= 0) members[owner[v]].push(v);

  jobs.forEach((job, j) => {
    const spec = patternById(job.texture.pattern)!;
    const opts = { ...spec.defaults, ...(job.texture.options ?? {}) };
    const scale = job.texture.scale && job.texture.scale > 0 ? job.texture.scale : 1;
    const shape = gridFor(job.frame.width, job.frame.height, job.cellM);
    const heights: Grid = {
      ...shape,
      data: spec.build(shape.cols, shape.rows, {
        widthM: ((shape.cols - 1) * shape.step) / scale,
        depthM: ((shape.rows - 1) * shape.step) / scale,
      }, opts),
    };

    // The region's edge, in the pattern's plane: every edge of one of its
    // faces that the face on the other side does not share the label of.
    const segments: [number, number, number, number][] = [];
    for (const [key, list] of faceEdges) {
      const inside = list.filter((f) => labels[f] === j).length;
      if (inside === 0 || inside === list.length) continue;
      const a = project(job.frame, vtx(mesh.pos, Math.floor(key / KEY)));
      const b = project(job.frame, vtx(mesh.pos, key % KEY));
      segments.push([a[0], a[1], b[0], b[1]]);
    }
    const border = Math.max(0, job.texture.borderM ?? DEFAULT_TEXTURE_BORDER_M);
    // The pattern comes in over one cell past the border, not as a step at it.
    const ramp = job.cellM;
    const dist = boundaryDistance(shape, segments, border + ramp * 2);

    const place = (depth: number) => {
      for (const v of members[j]) {
        const p: Vec3 = [original[3 * v], original[3 * v + 1], original[3 * v + 2]];
        const [x, y] = project(job.frame, p);
        const h = clamp01(sample(heights, x, y));
        const fade = clamp01((sample(dist, x, y) - border) / ramp);
        const offset = (depth < 0 ? depth * (1 - h) : depth * h) * fade;
        const n = norm([vNormal[3 * v], vNormal[3 * v + 1], vNormal[3 * v + 2]]);
        mesh.pos[3 * v] = p[0] + n[0] * offset;
        mesh.pos[3 * v + 1] = p[1] + n[1] * offset;
        mesh.pos[3 * v + 2] = p[2] + n[2] * offset;
      }
    };

    let depth = job.depthM;
    place(depth);
    for (let tries = 0; tries < 4 && countFolds(mesh, labels, j, before) > 0; tries++) {
      depth /= 2;
      place(depth);
    }
    if (countFolds(mesh, labels, j, before) > 0) {
      place(0);
      job.report.applied = false;
      job.report.reason = 'the surface folded through itself at every depth tried.';
      warnings.push(`Pattern ${job.index + 1}: ${job.report.reason}`);
      return;
    }
    if (depth !== job.depthM) {
      warnings.push(`Pattern ${job.index + 1}: it folded the surface at full depth, so it is ${(Math.abs(depth) * 1000).toFixed(1)} mm deep.`);
    }
    job.report.depthM = depth;
    job.report.triangles = labels.filter((l) => l === j).length;
    job.report.field = reliefField(job.frame, heights, dist, segments, border, ramp, depth > 0, !!spec.flatTopped);

    if (spec.palette) {
      for (const v of members[j]) {
        const [x, y] = project(job.frame, vtx(original, v));
        const [r, g, b] = spec.palette(clamp01(sample(heights, x, y)), opts);
        paintIdx.push(v);
        paintRgba.push(Math.round(clamp01(r) * 255), Math.round(clamp01(g) * 255), Math.round(clamp01(b) * 255), 255);
      }
    }
  });

  for (const job of jobs) regions.push(job.report);
  regions.sort((a, b) => a.index - b.index);

  return {
    vertices: mesh.pos,
    faces: mesh.faces,
    paint: paintIdx.length ? { res: [], idx: paintIdx, rgba: paintRgba } : undefined,
    regions,
    warnings,
  };
}
