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

import { MAX_PATTERN_CELLS, patternById, type PatternOptions, type PatternSpec } from './surfacePatterns';
import { EDGE_CREASE_DEG } from './featureEdges';
import { planeBasis, type Vec3 } from './measureSnap';
import { cutToDisc, cylinderAngle, cylinderReference, fitCylinder, lscm, triangleStretch } from './surfaceUv';
import type { PaintLayer } from './vertexPaint';

/**
 * How a region's surface is mapped onto the flat pattern: projected straight
 * onto a plane, unrolled round a cylinder's axis, or unwrapped by a conformal
 * map (utils/surfaceUv.ts). 'auto' picks by the shape of the region.
 */
export type TextureProjection = 'auto' | 'planar' | 'cylindrical' | 'unwrap';

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
/** A region counts as a cylinder's side when no facet leans further along the axis than this. */
const CYLINDER_LEAN_DEG = 5;
/** ...and its points sit this close to the fitted circle, as a fraction of the radius. */
const CYLINDER_ERROR = 0.03;
/** Stretch the modal warns about. */
export const STRETCH_WARNING = 0.15;

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
  /** The projection used, once 'auto' has picked one. */
  projection?: Exclude<TextureProjection, 'auto'>;
  /**
   * How much the flat map distorts the surface, over all but the worst 5 % of
   * it: 0.41 is a planar projection of a 45° wall. See triangleStretch.
   */
  stretch?: number;
  /**
   * The region goes all the way round a cylinder, so the pattern has to meet
   * itself. `scaled` is the factor the pattern was resized by so a whole number
   * of its repeats go round; a pattern that does not repeat is blended across
   * the join instead.
   */
  wrap?: { scaled: number; blended: boolean };
  /** A tube, or a face with a hole, had to be cut open to be laid flat; the cut is left plain. */
  seam?: boolean;
  /**
   * The relief as laid, for drawing it in 2D (a laser's engrave layer). Only
   * for a planar projection: a curved region is never one flat panel.
   */
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

/** A welded surface with what growing regions on it needs. */
interface IndexedSurface {
  mesh: Mesh;
  normals: Vec3[];
  areas: number[];
  edges: Map<number, number[]>;
  /**
   * How far a seed may sit off the surface and still be on it: slack for a
   * pick made on a slightly different tessellation of the same shape.
   */
  seedTol: number;
}

function indexSurface(positions: ArrayLike<number>, faces: ArrayLike<number>): IndexedSurface {
  const mesh = weld(positions, faces);
  const normals: Vec3[] = [];
  const areas: number[] = [];
  for (let f = 0; f < mesh.faces.length / 3; f++) {
    const c = faceCross(mesh, f);
    normals.push(norm(c));
    areas.push(len(c) / 2);
  }
  let extent = 0;
  if (mesh.pos.length) {
    const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mesh.pos.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], mesh.pos[i + a]);
        hi[a] = Math.max(hi[a], mesh.pos[i + a]);
      }
    }
    extent = len(sub(hi, lo));
  }
  return { mesh, normals, areas, edges: edgeFaces(mesh), seedTol: Math.max(5e-4, extent * 0.01) };
}

/** The faces a texture's region takes, grown from its seed, or why it has none. */
function textureRegion(surface: IndexedSurface, texture: SurfaceTexture, claimed: Int32Array): number[] | 'missed' | 'overlap' {
  const { mesh, normals, edges, seedTol } = surface;
  const seedN = texture.seedNormal ? norm(texture.seedNormal as Vec3) : null;
  const seed = seedFace(mesh, normals, texture.seedAt as Vec3, seedN, seedTol);
  if (seed < 0) return 'missed';
  const creaseCos = Math.cos(((texture.creaseDeg ?? EDGE_CREASE_DEG) * Math.PI) / 180);
  // 180 degrees is no limit at all: its cosine is -1, and the facet exactly
  // opposite the pick reads a hair under that, so it was left out.
  const tilt = texture.maxTiltDeg ?? DEFAULT_MAX_TILT_DEG;
  const tiltCos = tilt >= 180 ? -Infinity : Math.cos((tilt * Math.PI) / 180);
  const grown = growRegion(mesh, normals, edges, seed, creaseCos, tiltCos, claimed);
  /*
   * The tilt limit is for a bowl blended into its rim, where no crease stops
   * the region going over the top and down the outside. A cylinder's side is
   * bounded by the creases at its ends, and stopped by the tilt it covered
   * only the part of the side facing the picker. Left at its default, a
   * region that is a cylinder's side carries on round, as long as all of it
   * is the same cylinder.
   */
  if (texture.maxTiltDeg === undefined && typeof grown !== 'string' && isCylinderSide(surface, grown)) {
    const round = growRegion(mesh, normals, edges, seed, creaseCos, -Infinity, claimed);
    if (typeof round !== 'string' && round.length > grown.length && isCylinderSide(surface, round)) return round;
  }
  return grown;
}

/** The faces lie on one cylinder's side, and are not all one flat face. */
function isCylinderSide(surface: IndexedSurface, faces: number[]): boolean {
  const { mesh, normals, areas } = surface;
  const n0 = normals[faces[0]];
  if (faces.every((f) => dot(normals[f], n0) > Math.cos((5 * Math.PI) / 180))) return false;
  const verts = new Set<number>();
  for (const f of faces) for (let k = 0; k < 3; k++) verts.add(mesh.faces[3 * f + k]);
  const centroids = faces.map((f): Vec3 => {
    const a = vtx(mesh.pos, mesh.faces[3 * f]), b = vtx(mesh.pos, mesh.faces[3 * f + 1]), c = vtx(mesh.pos, mesh.faces[3 * f + 2]);
    return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
  });
  const fit = fitCylinder([...verts].map((i) => vtx(mesh.pos, i)), centroids, faces.map((f) => normals[f]), faces.map((f) => areas[f]));
  return !!fit && fit.leanDeg <= CYLINDER_LEAN_DEG && fit.error <= CYLINDER_ERROR;
}

/**
 * Which of `textures` already covers the point picked, or -1. Picking a face
 * that has a pattern on it opens that pattern rather than laying a second one,
 * which would only be refused as an overlap.
 */
export function textureIndexAt(
  positions: ArrayLike<number>,
  faces: ArrayLike<number>,
  textures: SurfaceTexture[],
  at: number[],
  normal?: number[],
): number {
  const surface = indexSurface(positions, faces);
  const picked = seedFace(surface.mesh, surface.normals, at as Vec3, normal ? norm(normal as Vec3) : null, surface.seedTol);
  if (picked < 0) return -1;
  // Claimed in order, as applySurfaceTextures does, so a pattern refused for
  // overlapping an earlier one does not own the earlier one's faces.
  const claimed = new Int32Array(surface.mesh.faces.length / 3).fill(-1);
  for (let i = 0; i < textures.length; i++) {
    const spec = patternById(textures[i].pattern);
    if (!spec || spec.throughCut || !(Math.abs(textures[i].depthM) > 0)) continue;
    const grown = textureRegion(surface, textures[i], claimed);
    if (typeof grown === 'string') continue;
    if (grown.includes(picked)) return i;
    for (const f of grown) claimed[f] = i;
  }
  return -1;
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

// --- laying the region flat --------------------------------------------------

type Segment = [number, number, number, number];
type Uv = [number, number];

/**
 * A region laid out flat: the pattern coordinates (metres) of every corner of
 * every one of its faces, before refinement. A refined vertex takes its
 * coordinates from the face it was cut from (see refine's `parents`), so the
 * map is set once, on the coarse mesh, whatever shape it is.
 *
 * Corners are kept per face rather than per vertex because a vertex on a cut
 * has a different place on each side of it.
 */
interface RegionUv {
  kind: Exclude<TextureProjection, 'auto'>;
  corners: Map<number, number[]>;
  width: number;
  height: number;
  /** The circumference, when the region wraps all the way round a cylinder; 0 otherwise. */
  wrapC: number;
  /** Rotation still to apply when the pattern is looked up, degrees. A planar frame has it built in. */
  twistDeg: number;
  /** The region's edge, in pattern coordinates. */
  segments: Segment[];
  /** Both sides of a cut made to open the region out; empty unless there was one. */
  seam: Segment[];
  /** The planar frame, for the relief field the laser draws. */
  frame?: Frame;
  note?: string;
}

/** The pattern coordinates of each face's corners, from a function of the corner's vertex. */
function cornersBy(mesh: Mesh, faces: number[], at: (f: number, v: number) => Uv): Map<number, number[]> {
  const corners = new Map<number, number[]>();
  for (const f of faces) {
    const c: number[] = [];
    for (let k = 0; k < 3; k++) c.push(...at(f, mesh.faces[3 * f + k]));
    corners.set(f, c);
  }
  return corners;
}

/** Every edge of the region that the face across it is not part of, as drawn in pattern coordinates. */
function edgeSegments(mesh: Mesh, edges: Map<number, number[]>, faces: number[], corners: Map<number, number[]>): Segment[] {
  const out: Segment[] = [];
  for (const f of faces) {
    const c = corners.get(f)!;
    for (let k = 0; k < 3; k++) {
      const a = mesh.faces[3 * f + k], b = mesh.faces[3 * f + ((k + 1) % 3)];
      const list = edges.get(edgeKey(a, b)) ?? [];
      if (list.length === 2 && corners.has(list[0]) && corners.has(list[1])) continue;
      const k2 = (k + 1) % 3;
      out.push([c[2 * k], c[2 * k + 1], c[2 * k2], c[2 * k2 + 1]]);
    }
  }
  return out;
}

function planarUv(surface: IndexedSurface, faces: number[], frame: Frame): RegionUv {
  const { mesh, edges } = surface;
  const corners = cornersBy(mesh, faces, (_f, v) => project(frame, vtx(mesh.pos, v)));
  return {
    kind: 'planar', corners, width: frame.width, height: frame.height, wrapC: 0, twistDeg: 0,
    segments: edgeSegments(mesh, edges, faces, corners), seam: [], frame,
  };
}

/** Wraps an angle into (-π, π]. */
const wrapPi = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
const mod = (x: number, m: number) => ((x % m) + m) % m;

/**
 * A cylinder's side unrolled: arc length round the axis and distance along it.
 * A region that goes all the way round is cut opposite the point picked and
 * keeps its full circumference; one that does not is cut in the widest gap,
 * so the cut is off the part.
 */
function cylinderUv(surface: IndexedSurface, faces: number[], fit: NonNullable<ReturnType<typeof fitCylinder>>, seedAt: Vec3, twistDeg: number): RegionUv {
  const { mesh, edges } = surface;
  const ref = cylinderReference(fit);
  const angle = (v: number) => cylinderAngle(fit, ref, vtx(mesh.pos, v));

  // Which angles the region covers, in half-degree bins.
  const BINS = 720;
  const covered = new Uint8Array(BINS);
  const spans = new Map<number, number[]>();
  for (const f of faces) {
    const t0 = angle(mesh.faces[3 * f]);
    const t = [t0, t0 + wrapPi(angle(mesh.faces[3 * f + 1]) - t0), t0 + wrapPi(angle(mesh.faces[3 * f + 2]) - t0)];
    spans.set(f, t);
    const lo = Math.min(...t), hi = Math.max(...t);
    const b0 = Math.ceil((lo / (2 * Math.PI)) * BINS - 0.5), b1 = Math.floor((hi / (2 * Math.PI)) * BINS - 0.5);
    for (let b = b0; b <= b1; b++) covered[mod(b, BINS)] = 1;
  }
  const wrapped = covered.every((c) => c === 1);
  let cut: number;
  if (wrapped) {
    cut = cylinderAngle(fit, ref, seedAt) + Math.PI;
  } else {
    // The middle of the longest run of bins nothing covers, going round.
    let best = -1, bestLen = 0;
    for (let start = 0; start < BINS; start++) {
      if (covered[start] || !covered[mod(start - 1, BINS)]) continue;
      let n = 0;
      while (n < BINS && !covered[mod(start + n, BINS)]) n++;
      if (n > bestLen) { bestLen = n; best = start; }
    }
    cut = (((best + bestLen / 2) / BINS) * 2 * Math.PI);
  }

  // Unrolled so that (u, v, outward normal) is right-handed: anticlockwise
  // round the axis and up it from outside a rod, down it from inside a pipe.
  const side = fit.outward ? 1 : -1;
  const along = (v: number) => side * dot(sub(vtx(mesh.pos, v), fit.centre), fit.axis);
  let v0 = Infinity, v1 = -Infinity, u0 = Infinity, u1 = -Infinity;
  const raw = new Map<number, number[]>();
  for (const f of faces) {
    const t = spans.get(f)!;
    const start = mod(t[0] - cut, 2 * Math.PI);
    const c: number[] = [];
    for (let k = 0; k < 3; k++) {
      const u = fit.radius * (start + (t[k] - t[0]));
      const v = along(mesh.faces[3 * f + k]);
      c.push(u, v);
      u0 = Math.min(u0, u); u1 = Math.max(u1, u);
      v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    raw.set(f, c);
  }
  const wrapC = wrapped ? 2 * Math.PI * fit.radius : 0;
  const shiftU = wrapped ? 0 : u0;
  for (const c of raw.values()) for (let k = 0; k < 3; k++) { c[2 * k] -= shiftU; c[2 * k + 1] -= v0; }

  let segments = edgeSegments(mesh, edges, faces, raw);
  // Round a full wrap the edge is periodic: a corner either side of the
  // join sees the edge across it.
  if (wrapped) segments = segments.flatMap((s) => [s, [s[0] - wrapC, s[1], s[2] - wrapC, s[3]], [s[0] + wrapC, s[1], s[2] + wrapC, s[3]]] as Segment[]);
  return {
    kind: 'cylindrical', corners: raw, width: wrapped ? wrapC : u1 - u0, height: v1 - v0, wrapC, twistDeg,
    segments, seam: [],
  };
}

/**
 * Anything else, unwrapped by a conformal map (utils/surfaceUv.ts), with the
 * planar frame's projection as the starting guess and its two farthest points
 * pinned where the projection put them, so the pattern turns the way Rotate
 * says. Null for a closed surface, which has no edge to open it from.
 */
function unwrapUv(surface: IndexedSurface, faces: number[], frame: Frame, seedAt: Vec3): RegionUv | null {
  const { mesh, edges } = surface;
  const regionFaces: number[] = [];
  for (const f of faces) for (let k = 0; k < 3; k++) regionFaces.push(mesh.faces[3 * f + k]);
  const disc = cutToDisc(mesh.pos, regionFaces, seedAt);
  if (!disc.ok) return null;

  const n = disc.source.length;
  const pos = new Float64Array(3 * n);
  const guess = new Float64Array(2 * n);
  disc.source.forEach((v, i) => {
    const p = vtx(mesh.pos, v);
    pos.set(p, 3 * i);
    guess.set(project(frame, p), 2 * i);
  });

  // Two pins as far apart as the region goes.
  const at = (i: number): Vec3 => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
  const farthest = (from: Vec3) => {
    let best = 0, bestD = -1;
    for (let i = 0; i < n; i++) {
      const d = len(sub(at(i), from));
      if (d > bestD) { bestD = d; best = i; }
    }
    return best;
  };
  const centre: Vec3 = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) centre[a] += pos[3 * i + a] / n;
  const p0 = farthest(centre);
  const p1 = farthest(at(p0));
  const uv = lscm(pos, disc.faces, [p0, p1], [[guess[2 * p0], guess[2 * p0 + 1]], [guess[2 * p1], guess[2 * p1 + 1]]], guess);

  // Sized so the pattern covers the same area it would on a flat face.
  let area3 = 0, areaUv = 0;
  for (let f = 0; f < disc.faces.length; f += 3) {
    const [i, j, k] = [disc.faces[f], disc.faces[f + 1], disc.faces[f + 2]];
    area3 += len(cross(sub(at(j), at(i)), sub(at(k), at(i)))) / 2;
    areaUv += ((uv[2 * j] - uv[2 * i]) * (uv[2 * k + 1] - uv[2 * i + 1]) - (uv[2 * k] - uv[2 * i]) * (uv[2 * j + 1] - uv[2 * i + 1])) / 2;
  }
  const k = areaUv > 0 ? Math.sqrt(area3 / areaUv) : 1;
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let i = 0; i < n; i++) {
    uv[2 * i] *= k; uv[2 * i + 1] *= k;
    u0 = Math.min(u0, uv[2 * i]); u1 = Math.max(u1, uv[2 * i]);
    v0 = Math.min(v0, uv[2 * i + 1]); v1 = Math.max(v1, uv[2 * i + 1]);
  }

  const corners = new Map<number, number[]>();
  faces.forEach((f, i) => {
    const c: number[] = [];
    for (let k2 = 0; k2 < 3; k2++) {
      const d = disc.faces[3 * i + k2];
      c.push(uv[2 * d] - u0, uv[2 * d + 1] - v0);
    }
    corners.set(f, c);
  });

  // The cut, from both sides: the faces either side of a cut edge place its
  // ends in different spots.
  const seam: Segment[] = [];
  if (disc.seam.length) {
    const cutKeys = new Set(disc.seam.map(([a, b]) => edgeKey(a, b)));
    for (const f of faces) {
      const c = corners.get(f)!;
      for (let k2 = 0; k2 < 3; k2++) {
        const a = mesh.faces[3 * f + k2], b = mesh.faces[3 * f + ((k2 + 1) % 3)];
        if (!cutKeys.has(edgeKey(a, b))) continue;
        const k3 = (k2 + 1) % 3;
        seam.push([c[2 * k2], c[2 * k2 + 1], c[2 * k3], c[2 * k3 + 1]]);
      }
    }
  }
  return {
    kind: 'unwrap', corners, width: u1 - u0, height: v1 - v0, wrapC: 0, twistDeg: 0,
    segments: edgeSegments(mesh, edges, faces, corners), seam,
  };
}

/**
 * The region laid flat by the projection asked for -- or for 'auto', by its
 * shape: planar while every facet is within PLANAR_TILT_DEG of the mean,
 * unrolled when it is a cylinder's side, unwrapped otherwise.
 */
function regionUv(surface: IndexedSurface, faces: number[], normal: Vec3, minCos: number, texture: SurfaceTexture): RegionUv {
  const { mesh, normals, areas } = surface;
  const want = texture.projection ?? 'auto';
  const twist = texture.twistDeg ?? 0;
  const verts = new Set<number>();
  for (const f of faces) for (let k = 0; k < 3; k++) verts.add(mesh.faces[3 * f + k]);
  const points = [...verts].map((i) => vtx(mesh.pos, i));
  const frame = planarFrame(points, normal, twist);

  if (want === 'planar' || (want === 'auto' && minCos >= Math.cos((PLANAR_TILT_DEG * Math.PI) / 180))) {
    return planarUv(surface, faces, frame);
  }
  if (want === 'auto' || want === 'cylindrical') {
    const centroids = faces.map((f): Vec3 => {
      const a = vtx(mesh.pos, mesh.faces[3 * f]), b = vtx(mesh.pos, mesh.faces[3 * f + 1]), c = vtx(mesh.pos, mesh.faces[3 * f + 2]);
      return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    });
    const fit = fitCylinder(points, centroids, faces.map((f) => normals[f]), faces.map((f) => areas[f]));
    const isCylinder = !!fit && fit.leanDeg <= CYLINDER_LEAN_DEG && fit.error <= CYLINDER_ERROR;
    if (fit && (isCylinder || want === 'cylindrical')) return cylinderUv(surface, faces, fit, texture.seedAt as Vec3, twist);
  }
  const unwrapped = unwrapUv(surface, faces, frame, texture.seedAt as Vec3);
  if (unwrapped) return unwrapped;
  return { ...planarUv(surface, faces, frame), note: 'a closed surface has no edge to unwrap it from, so it is projected flat.' };
}

/** The flat map's stretch over the region, ignoring its worst 5 % by area. */
function regionStretch(mesh: Mesh, faces: number[], uv: RegionUv, areas: number[]): number {
  const rows: [number, number][] = [];
  let total = 0;
  for (const f of faces) {
    const c = uv.corners.get(f)!;
    const s = triangleStretch(
      vtx(mesh.pos, mesh.faces[3 * f]), vtx(mesh.pos, mesh.faces[3 * f + 1]), vtx(mesh.pos, mesh.faces[3 * f + 2]),
      [c[0], c[1]], [c[2], c[3]], [c[4], c[5]],
    );
    rows.push([s, areas[f]]);
    total += areas[f];
  }
  rows.sort((a, b) => a[0] - b[0]);
  let acc = 0;
  for (const [s, a] of rows) {
    acc += a;
    if (acc >= total * 0.95) return s;
  }
  return rows.length ? rows[rows.length - 1][0] : 0;
}

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

// --- looking the pattern up ----------------------------------------------------

/** The pattern's heights over a w x h rectangle of pattern coordinates. */
function patternGrid(spec: PatternSpec, opts: PatternOptions, scale: number, width: number, height: number, cellM: number): Grid {
  const shape = gridFor(width, height, cellM);
  return {
    ...shape,
    data: spec.build(shape.cols, shape.rows, {
      widthM: ((shape.cols - 1) * shape.step) / scale,
      depthM: ((shape.rows - 1) * shape.step) / scale,
    }, opts),
  };
}

/**
 * The pattern over a w x h rectangle, turned by `twistDeg` about its middle:
 * the grid is built over the turned rectangle's bounding box.
 */
function rectLookup(spec: PatternSpec, opts: PatternOptions, scale: number, width: number, height: number, cellM: number, twistDeg: number) {
  const t = (twistDeg * Math.PI) / 180;
  if (t === 0) {
    const grid = patternGrid(spec, opts, scale, width, height, cellM);
    return { grid, heightAt: (u: number, v: number) => clamp01(sample(grid, u, v)) };
  }
  const c = Math.cos(t), s = Math.sin(t);
  const w2 = Math.abs(width * c) + Math.abs(height * s), h2 = Math.abs(width * s) + Math.abs(height * c);
  const grid = patternGrid(spec, opts, scale, w2, h2, cellM);
  return {
    grid,
    heightAt: (u: number, v: number) => {
      const du = u - width / 2, dv = v - height / 2;
      return clamp01(sample(grid, c * du + s * dv + w2 / 2, -s * du + c * dv + h2 / 2));
    },
  };
}

/**
 * The distance near `around` at which the pattern repeats itself along u, or
 * null if it does not. Measured, because a pattern's repeat is not something
 * a PatternSpec states: it depends on its options, its Direction and Rotate.
 * Rows of samples are compared with themselves shifted by every lag from 3/4
 * to 4/3 of `around`, and the lag nearest `around` that matches is kept.
 */
function findRepeat(heightAt: (u: number, v: number) => number, around: number, height: number, step: number): number | null {
  const n = Math.floor((1.6 * around) / step);
  const R = Math.max(1, Math.min(48, Math.round(height / step)));
  const S = new Float64Array(R * n);
  let mean = 0;
  for (let r = 0; r < R; r++) {
    const v = ((r + 0.5) / R) * height;
    for (let c = 0; c < n; c++) {
      const h = heightAt(c * step, v);
      S[r * n + c] = h;
      mean += h;
    }
  }
  mean /= S.length || 1;
  let variance = 0;
  for (const h of S) variance += (h - mean) * (h - mean);
  variance /= S.length || 1;
  // The same all the way along: any length goes round.
  if (variance < 1e-6) return around;

  const window = Math.max(1, Math.floor((0.25 * around) / step));
  const lo = Math.ceil((0.75 * around) / step);
  const hi = Math.min(Math.floor((1.34 * around) / step), n - 1 - window);
  if (hi <= lo) return null;
  const D = new Float64Array(hi + 2).fill(Infinity);
  for (let lag = lo; lag <= hi; lag++) {
    let sum = 0;
    for (let r = 0; r < R; r++) {
      const row = r * n;
      for (let c = 0; c < window; c++) {
        const d = S[row + c] - S[row + c + lag];
        sum += d * d;
      }
    }
    D[lag] = sum / (R * window * 2 * variance);
  }
  const target = around / step;
  let best = -1;
  for (let lag = lo; lag <= hi; lag++) {
    if (!(D[lag] < 0.02)) continue;
    if (lag > lo && D[lag - 1] < D[lag]) continue;
    if (lag < hi && D[lag + 1] < D[lag]) continue;
    if (best < 0 || Math.abs(lag - target) < Math.abs(best - target)) best = lag;
  }
  if (best < 0) return null;
  // Between samples, by the parabola through the minimum and its neighbours.
  let shift = 0;
  if (best > lo && best < hi) {
    const a = D[best - 1], b = D[best], c = D[best + 1];
    const den = a - 2 * b + c;
    if (den > 0) shift = Math.max(-0.5, Math.min(0.5, (a - c) / (2 * den)));
  }
  return (best + shift) * step;
}

interface Lookup {
  heightAt: (u: number, v: number) => number;
  /** The grid in pattern coordinates, for the relief field; only when it is one. */
  grid?: Grid;
  wrap?: { scaled: number; blended: boolean };
}

/**
 * The pattern's height at any point of the region's map. Round a full wrap it
 * has to meet itself: a pattern that repeats is resized so a whole number of
 * repeats go round, and one that does not is cross-faded with itself over a
 * short band either side of the join.
 */
function patternLookup(spec: PatternSpec, opts: PatternOptions, scale: number, uv: RegionUv, cellM: number): Lookup {
  if (!uv.wrapC) {
    const r = rectLookup(spec, opts, scale, uv.width, uv.height, cellM, uv.twistDeg);
    return { heightAt: r.heightAt, grid: uv.twistDeg === 0 ? r.grid : undefined };
  }
  const C = uv.wrapC;
  const probe = rectLookup(spec, opts, scale, 1.6 * C, uv.height, cellM, uv.twistDeg);
  const repeat = findRepeat(probe.heightAt, C, uv.height, probe.grid.step);
  if (repeat) {
    const scaled = C / repeat;
    const r = rectLookup(spec, opts, scale * scaled, C, uv.height, cellM, uv.twistDeg);
    return { heightAt: (u, v) => r.heightAt(mod(u, C), v), wrap: { scaled, blended: false } };
  }
  const band = Math.min(C / 4, 0.02);
  const r = rectLookup(spec, opts, scale, C + band, uv.height, cellM, uv.twistDeg);
  return {
    heightAt: (u, v) => {
      const x = mod(u, C);
      if (x >= band) return r.heightAt(x, v);
      const t = x / band;
      const s = t * t * (3 - 2 * t);
      return r.heightAt(x + C, v) * (1 - s) + r.heightAt(x, v) * s;
    },
    wrap: { scaled: 1, blended: true },
  };
}

// --- refinement --------------------------------------------------------------

/**
 * Splits every edge of a labelled face that is longer than its label's cell,
 * once per pass, until none is. Each midpoint is made once per edge and used
 * by both faces on it, so a face just outside the region is split along the
 * edge it shares and no crack opens; its other edges are left as they are.
 *
 * `parents` says, for every face, which of the faces given it was cut from,
 * and is kept up to date as `labels` is.
 *
 * Returns false if it stopped at the triangle cap.
 */
function refine(mesh: Mesh, labels: number[], parents: number[], cells: number[], maxTriangles: number): boolean {
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
    const outParents: number[] = [];
    let parent = 0;
    const emit = (label: number, ...v: number[]) => {
      out.push(...v);
      for (let i = 0; i < v.length / 3; i++) { outLabels.push(label); outParents.push(parent); }
    };
    for (let f = 0; f < faceCount; f++) {
      const a = mesh.faces[3 * f], b = mesh.faces[3 * f + 1], c = mesh.faces[3 * f + 2];
      const label = labels[f];
      parent = parents[f];
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
    parents.length = outParents.length;
    for (let i = 0; i < outParents.length; i++) parents[i] = outParents[i];
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
  const surface = indexSurface(positions, faces);
  const { mesh, normals, areas, edges } = surface;
  const warnings: string[] = [];
  const regions: TextureRegionReport[] = [];
  const faceCount = mesh.faces.length / 3;

  const claimed = new Int32Array(faceCount).fill(-1);
  interface Job {
    index: number;
    texture: SurfaceTexture;
    faces: number[];
    normal: Vec3;
    uv: RegionUv;
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

    const grown = textureRegion(surface, texture, claimed);
    if (grown === 'missed') return skip(index, 'the point it was put on is no longer on the part.');
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
    const uv = regionUv(surface, grown, normal, minCos, texture);
    if (uv.note) warnings.push(`Pattern ${index + 1}: ${uv.note}`);
    const stretch = regionStretch(mesh, grown, uv, areas);
    if (stretch > STRETCH_WARNING) {
      const pct = Number.isFinite(stretch) ? `${Math.round(stretch * 100)} %` : 'a great deal';
      const fix = uv.kind === 'planar' && !uv.note ? ' Projection Auto lays it out evenly.' : '';
      warnings.push(`Pattern ${index + 1}: the surface stretches the pattern by up to ${pct}.${fix}`);
    }

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
      index, applied: true, areaM2: area, extentM: [uv.width, uv.height], triangles: 0, cellM, depthM,
      normal, flat, projection: uv.kind, stretch, seam: uv.seam.length > 0 || undefined,
    };
    jobs.push({ index, texture, faces: grown, normal, uv, cellM, depthM, report });
  });

  // Coarsen to fit the cap before refining, rather than stopping half way:
  // a triangle refined to edges under c averages about c²/5 of area.
  const PER_TRIANGLE = 0.2;
  const budget = Math.max(0, maxTriangles - faceCount);
  const wanted = jobs.reduce((n, j) => n + j.report.areaM2 / (PER_TRIANGLE * j.cellM * j.cellM), 0);
  const askedCell = jobs.length ? jobs[0].cellM : 0;
  if (wanted > budget && jobs.length) {
    const k = Math.sqrt(wanted / Math.max(1, budget));
    for (const job of jobs) {
      job.cellM *= k;
      job.report.cellM = job.cellM;
    }
  }

  const labels: number[] = Array.from(claimed).map((owner) => jobs.findIndex((j) => j.index === owner));
  const coarseFaces = mesh.faces.slice();
  const coarseLabels = labels.slice();
  const coarseVerts = mesh.pos.length;
  const parents: number[] = labels.map((_, f) => f);
  /*
   * Refined from the start again, a quarter coarser, until it fits. The
   * estimate above is for well-shaped faces; a long thin one (the side of a
   * tall cylinder, two triangles the height of the part) takes many more,
   * and refinement stopped at the cap left it in slivers that folded at
   * almost any depth: 1 mm of scales on a 560 mm post came out 0.06 mm deep.
   */
  for (let attempt = 0; jobs.length; attempt++) {
    if (refine(mesh, labels, parents, jobs.map((j) => j.cellM), maxTriangles * 1.25)) break;
    if (attempt === 8) {
      warnings.push('Refinement stopped at the triangle limit; the pattern is coarser than asked for.');
      break;
    }
    mesh.faces = coarseFaces.slice();
    mesh.pos.length = coarseVerts;
    labels.length = coarseLabels.length;
    parents.length = coarseLabels.length;
    for (let f = 0; f < coarseLabels.length; f++) { labels[f] = coarseLabels[f]; parents[f] = f; }
    for (const job of jobs) {
      job.cellM *= 1.25;
      job.report.cellM = job.cellM;
    }
  }
  if (jobs.length && jobs[0].cellM > askedCell * 1.001) {
    warnings.push(`The patterned surface would be too many triangles at the size asked for, so it is refined to ${(jobs[0].cellM * 1000).toFixed(2)} mm.`);
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

  /*
   * Which way each vertex moves: the normals at the corners of the faces the
   * region started as, area-weighted over the region's own faces (so its edge
   * does not lean towards the face next door), blended across each face the
   * way Phong shading blends them. Taken from the refined facets instead,
   * every vertex inside one flat facet of a faceted cylinder moved along that
   * facet's normal and those on its edges along an average, 3.75 degrees
   * apart on a 48-sided drum, which dragged the triangles along the edges over
   * and held 1 mm flutes to 0.3 mm.
   */
  const coarseNormals = jobs.map((_, j) => {
    const n = new Float64Array(coarseVerts);
    for (let f = 0; f < coarseLabels.length; f++) {
      if (coarseLabels[f] !== j) continue;
      const a = vtx(original, coarseFaces[3 * f]);
      const c = cross(sub(vtx(original, coarseFaces[3 * f + 1]), a), sub(vtx(original, coarseFaces[3 * f + 2]), a));
      for (let k = 0; k < 3; k++) {
        const v = coarseFaces[3 * f + k];
        n[3 * v] += c[0];
        n[3 * v + 1] += c[1];
        n[3 * v + 2] += c[2];
      }
    }
    return n;
  });
  const vNormal = new Float64Array(vertexCount * 3);

  const paintIdx: number[] = [];
  const paintRgba: number[] = [];
  const members: number[][] = jobs.map(() => []);
  for (let v = 0; v < vertexCount; v++) if (owner[v] >= 0) members[owner[v]].push(v);

  /** Where a vertex of a refined face sits in its coarse parent, as weights of the parent's corners. */
  const weights = (v: number, parent: number): [number, number, number] => {
    const a = vtx(original, coarseFaces[3 * parent]);
    const v0 = sub(vtx(original, coarseFaces[3 * parent + 1]), a);
    const v1 = sub(vtx(original, coarseFaces[3 * parent + 2]), a);
    const v2 = sub(vtx(original, v), a);
    const d00 = dot(v0, v0), d01 = dot(v0, v1), d11 = dot(v1, v1), d20 = dot(v2, v0), d21 = dot(v2, v1);
    const den = d00 * d11 - d01 * d01;
    if (!(Math.abs(den) > 0)) return [1, 0, 0];
    const wb = (d11 * d20 - d01 * d21) / den, wc = (d00 * d21 - d01 * d20) / den;
    return [1 - wb - wc, wb, wc];
  };

  jobs.forEach((job, j) => {
    const spec = patternById(job.texture.pattern)!;
    const opts = { ...spec.defaults, ...(job.texture.options ?? {}) };
    const scale = job.texture.scale && job.texture.scale > 0 ? job.texture.scale : 1;
    const { uv } = job;
    const look = patternLookup(spec, opts, scale, uv, job.cellM);
    if (look.wrap) job.report.wrap = look.wrap;

    // Each vertex's place on the pattern, from the coarse face it was cut
    // from. One on a cut has a place on each side; either will do, since the
    // cut is left plain.
    const vu = new Float64Array(vertexCount);
    const vv = new Float64Array(vertexCount);
    const placed = new Uint8Array(vertexCount);
    for (let f = 0; f < labels.length; f++) {
      if (labels[f] !== j) continue;
      const c = uv.corners.get(parents[f])!;
      for (let k = 0; k < 3; k++) {
        const v = mesh.faces[3 * f + k];
        if (placed[v]) continue;
        placed[v] = 1;
        const w = weights(v, parents[f]);
        vu[v] = w[0] * c[0] + w[1] * c[2] + w[2] * c[4];
        vv[v] = w[0] * c[1] + w[1] * c[3] + w[2] * c[5];
        const cn = coarseNormals[j];
        for (let axis = 0; axis < 3; axis++) {
          let sum = 0;
          for (let corner = 0; corner < 3; corner++) {
            const cv = coarseFaces[3 * parents[f] + corner];
            const len3 = Math.hypot(cn[3 * cv], cn[3 * cv + 1], cn[3 * cv + 2]) || 1;
            sum += w[corner] * (cn[3 * cv + axis] / len3);
          }
          vNormal[3 * v + axis] = sum;
        }
      }
    }
    // Round a full wrap, back into the one turn the grids cover.
    const wrapU = (u: number) => (uv.wrapC ? mod(u, uv.wrapC) : u);

    const shape = look.grid ?? gridFor(uv.width, uv.height, job.cellM);
    const border = Math.max(0, job.texture.borderM ?? DEFAULT_TEXTURE_BORDER_M);
    // The pattern comes in over one cell past the border, not as a step at it.
    const ramp = job.cellM;
    const dist = boundaryDistance(shape, uv.segments, border + ramp * 2);
    // A cut made to lay the region flat is left plain, half a border wide either side.
    const seamDist = uv.seam.length ? boundaryDistance(shape, uv.seam, border + ramp * 2) : null;
    const fadeAt = (u: number, v: number) => {
      const x = wrapU(u);
      let fade = clamp01((sample(dist, x, v) - border) / ramp);
      if (seamDist) fade = Math.min(fade, clamp01((sample(seamDist, x, v) - border / 2) / ramp));
      return fade;
    };

    const place = (depth: number) => {
      for (const v of members[j]) {
        const p: Vec3 = [original[3 * v], original[3 * v + 1], original[3 * v + 2]];
        const h = look.heightAt(vu[v], vv[v]);
        const fade = fadeAt(vu[v], vv[v]);
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
    if (uv.frame && look.grid) {
      job.report.field = reliefField(uv.frame, look.grid, dist, uv.segments, border, ramp, depth > 0, !!spec.flatTopped);
    }

    if (spec.palette) {
      for (const v of members[j]) {
        const [r, g, b] = spec.palette(look.heightAt(vu[v], vv[v]), opts);
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
