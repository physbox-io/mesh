// ---------------------------------------------------------------------------
// Split for Print: cutting a part into sections that each fit the printer
// ---------------------------------------------------------------------------
//
// A part bigger than the bed cannot be printed in one go. This cuts it into
// sections that each fit, turns each one to whichever way up needs the least
// support, and puts something on the cut faces to line them up again when they
// are glued: blind holes for bought dowels, or a printed peg on one side and a
// hole on the other.
//
// THE SEARCH. Greedy, binary and deterministic, so it is cheap enough for a
// worker and the same part always splits the same way:
//
//   1. If some way up fits the bed, the piece is a section. "Ways up" are the
//      six axes, the piece's own cut faces, and the biggest faces of its convex
//      hull — a part resting on a hull face is resting on something.
//   2. Otherwise it is cut in two. The planes tried are square to the world
//      axes and to the piece's principal axes, at the first of n even slabs
//      and a little either side of it. A cut that leaves a sliver, or a face
//      too thin to glue, loses; of the rest, the one predicted to need the
//      fewest sections wins, then the least support, then the smallest seam.
//   3. Both halves go back to 1.
//
// Joinery goes on once the cutting is done, joint by joint, where a joint is
// the patch of a cut plane that two final sections actually share — a cut made
// early is later cut again, so its face is shared out among several sections.
// Then every section's pose is searched again on its real geometry, which is
// what keeps a peg from being printed face down: standing on a peg leaves the
// whole face around it in the air, and the support says so.
//
// SPACES. In and out: the body's own frame, Z-up, metres — what the scene
// graph's renderVertices are in. Inside: the same frame in millimetres, because
// every limit here is a millimetre figure and Manifold's tolerances are
// relative to the model anyway.
//
// Pure, and Worker-free: the tests call it directly with the real wasm, and
// workers/printSplitWorker.ts is a thin shell over it.
// ---------------------------------------------------------------------------

import type { CrossSection, Manifold, ManifoldToplevel, Mat4 } from 'manifold-3d';
import { createSculptMesh } from './sculptMesh';
import { toManifold } from './sculptCut';
import { supportArea } from './printSupport';
import { rotatePoints, rotationBetween, rotationZ, mulMat3, type Mat3, type Vec3 } from './printPlate';
import type { PrintBed } from './printBedSettings';

export type JoineryKind = 'none' | 'dowel' | 'peg';

export interface Joinery {
  kind: JoineryKind;
  /** Dowel or peg diameter, mm. */
  diameterMm: number;
  /** Whole dowel length, mm; a peg stands half of it proud. */
  lengthMm: number;
  /** How much bigger a hole is than what goes in it, mm, on the diameter. */
  clearanceMm: number;
  /** Least material left between a hole and the edge of a face, mm. */
  minWallMm: number;
}

export const DEFAULT_JOINERY: Joinery = {
  kind: 'dowel',
  diameterMm: 6,
  lengthMm: 20,
  clearanceMm: 0.2,
  minWallMm: 2,
};

export interface SplitOptions {
  bed: PrintBed;
  /** Kept clear round the edge of the bed, mm. */
  marginMm?: number;
  /** Past this many degrees from vertical a face needs support. */
  overhangDeg?: number;
  joinery?: Partial<Joinery>;
  /** A safety cap on the number of sections. */
  maxSections?: number;
}

/** A hole or a peg on a section, for the physics to collide exactly. */
export interface JoineryFeature {
  kind: 'bore' | 'peg';
  /** Where its axis meets the cut face, body frame, metres. */
  at: Vec3;
  /** Into the material for a bore; out of the face for a peg. Unit. */
  axis: Vec3;
  /** metres */
  radius: number;
  /** How deep the bore goes, or how far the peg stands proud, metres. */
  depth: number;
  /** The joint this belongs to. */
  joint: number;
}

/**
 * An exactly shaped collider for the 'print' fidelity (SceneGraph.simFidelity):
 * the lining of a hole, the face round it, a peg. Body frame, Z-up, metres;
 * `quat` is MuJoCo's w, x, y, z. See SceneGeom.contactClass for why these are
 * separate from the body's own collider.
 */
export type FeatureCollider = {
  role: 'pin' | 'socket';
  /** The joint it belongs to: a socket meets only its own joint's pins. */
  group: number;
} & (
  | { shape: 'box'; pos: Vec3; quat: [number, number, number, number]; half: Vec3 }
  | { shape: 'cylinder'; pos: Vec3; quat: [number, number, number, number]; radius: number; halfLength: number }
  /** A convex slab of the face, as a closed mesh. */
  | { shape: 'prism'; positions: number[]; faces: number[] });

export interface SplitSection {
  /** The section as it will be printed, body frame, metres, Z-up. */
  positions: Float32Array;
  faces: Uint32Array;
  /** The same section before its joinery went on: what it collides as. */
  plainPositions: Float32Array;
  plainFaces: Uint32Array;
  /** Body-local direction that points up off the bed. */
  up: Vec3;
  /** Turn about the vertical after that, radians. */
  spin: number;
  supportMm2: number;
  /** Posed size along the bed's X, Y and Z, mm. */
  sizeMm: Vec3;
  fits: boolean;
  volumeMm3: number;
  features: JoineryFeature[];
  /** Its holes, the faces round them and its pegs, as exact colliders. */
  colliders: FeatureCollider[];
  /**
   * The plain section's volume over its convex hull's. Below about 0.92 the
   * hull MuJoCo collides it as is a poor stand-in, until it is decomposed.
   */
  solidity: number;
  /**
   * The plain section cut into convex pieces along its own face planes, body
   * frame, metres — empty when it is convex already. For a part made of flat
   * faces the pieces fill the section exactly, so they collide exactly: two
   * L-shaped halves meet at their cut, where their hulls (or V-HACD's
   * approximation) would overlap in the corner and hold them apart.
   */
  convexPieces: { positions: Float32Array; faces: Uint32Array }[];
  /** Which way to push it to pull the assembly apart: the sum of its cut sides. */
  explode: Vec3;
}

export interface SplitCut {
  /** Unit normal, body frame. */
  normal: Vec3;
  /** Plane offset along the normal, metres. */
  offset: number;
}

export interface SplitJoint {
  cut: number;
  /** The section on the side the normal points away from. */
  neg: number;
  /** The section on the side the normal points towards. */
  pos: number;
  /** Shared face area, mm². */
  areaMm2: number;
  /** Pin centres on the cut plane, body frame, metres. */
  pins: Vec3[];
  /** For a peg joint, which side carries the pegs. */
  pegSide?: 'neg' | 'pos';
}

export type SplitTree =
  | { section: number }
  | { cut: number; neg: SplitTree; pos: SplitTree };

export type SplitResult =
  | {
    ok: true;
    sections: SplitSection[];
    cuts: SplitCut[];
    joints: SplitJoint[];
    tree: SplitTree;
    joinery: Joinery;
    warnings: string[];
  }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------

const MM = 1000;
/** Segments round a pin or a hole: within 0.3% of a true circle's area. */
const PIN_SEGMENTS = 48;
/** How far either side of a cut plane its face is read, mm. */
const FACE_EPS = 0.01;
/** A half under this share of its piece is a sliver, not a section. */
const SLIVER_SHARE = 0.02;
/** A shared patch smaller than this is two corners touching, not a joint. */
const MIN_JOINT_AREA_MM2 = 1;
/** How deep a hole goes past half a dowel, so the dowel bottoms in it before the faces meet. */
const HOLE_EXTRA_MM = 0.5;
const PEG_CHAMFER_MM = 0.5;
/** A peg is sunk this far into its own face, so the union is one solid. */
const PEG_SINK_MM = 0.5;
/** How thick the exact colliders lining a hole, and covering the face round it, are. */
const LINING_MM = 1;
/** Flat sides round a hole's lining. */
const LINING_SIDES = 16;

interface Ctx {
  wasm: ManifoldToplevel;
  W: number; D: number; H: number;
  overhangDeg: number;
  joinery: Joinery;
  warnings: string[];
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v: ArrayLike<number>): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const neg3 = (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]];
const scale3 = (v: ArrayLike<number>, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];
const add3 = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

// ---------------------------------------------------------------------------
// Geometry in and out
// ---------------------------------------------------------------------------

/**
 * A triangle soup welded by position: shared corners become shared vertices,
 * which is what Manifold needs to see a closed surface. Degenerate triangles
 * (two corners welded together) are dropped.
 */
export function weldSoup(soup: ArrayLike<number>, quantum = 1e-4): { positions: number[]; faces: number[] } {
  const index = new Map<string, number>();
  const positions: number[] = [];
  const faces: number[] = [];
  const idOf = (i: number) => {
    const key = `${Math.round(soup[i] / quantum)},${Math.round(soup[i + 1] / quantum)},${Math.round(soup[i + 2] / quantum)}`;
    let id = index.get(key);
    if (id === undefined) {
      id = positions.length / 3;
      positions.push(soup[i], soup[i + 1], soup[i + 2]);
      index.set(key, id);
    }
    return id;
  };
  for (let t = 0; t + 8 < soup.length; t += 9) {
    const a = idOf(t), b = idOf(t + 3), c = idOf(t + 6);
    if (a === b || b === c || a === c) continue;
    faces.push(a, b, c);
  }
  return { positions, faces };
}

/** Each body-frame metre soup as a solid, in millimetres, unioned into one. */
function solidFrom(wasm: ManifoldToplevel, soups: ArrayLike<number>[]): { ok: true; solid: Manifold } | { ok: false; error: string } {
  const parts: Manifold[] = [];
  for (const soup of soups) {
    const mm = new Float64Array(soup.length);
    for (let i = 0; i < soup.length; i++) mm[i] = soup[i] * MM;
    const { positions, faces } = weldSoup(mm);
    if (faces.length < 12) continue;
    const made = toManifold(wasm, createSculptMesh(positions, faces));
    if (!made.ok) {
      for (const p of parts) p.delete();
      return { ok: false, error: made.error.replace('cannot be cut', 'cannot be split') };
    }
    parts.push(made.manifold);
  }
  if (!parts.length) return { ok: false, error: 'There is no solid here to split.' };
  const solid = parts.length === 1 ? parts[0] : wasm.Manifold.union(parts);
  if (parts.length > 1) for (const p of parts) p.delete();
  if (solid.isEmpty() || !(solid.volume() > 0)) {
    solid.delete();
    return { ok: false, error: 'This body encloses no volume (it may be inside out), so it cannot be split.' };
  }
  return { ok: true, solid };
}

/** A Manifold's surface as body-frame metres, ready for the scene graph. */
function toMetres(m: Manifold): { positions: Float32Array; faces: Uint32Array } {
  const mesh = m.getMesh();
  const positions = new Float32Array(mesh.numVert * 3);
  for (let v = 0; v < mesh.numVert; v++) {
    positions[v * 3] = mesh.vertProperties[v * mesh.numProp] / MM;
    positions[v * 3 + 1] = mesh.vertProperties[v * mesh.numProp + 1] / MM;
    positions[v * 3 + 2] = mesh.vertProperties[v * mesh.numProp + 2] / MM;
  }
  return { positions, faces: Uint32Array.from(mesh.triVerts) };
}

/** What the pose search needs of a piece: its triangles, and its hull. */
interface PieceGeo {
  /** Triangles, 9 numbers each, mm. */
  soup: Float64Array;
  /** Hull vertices, xyz, mm. */
  hull: Float64Array;
  /** Hull faces as directions to rest on (outward normals), largest first. */
  restDowns: Vec3[];
  volume: number;
}

function geoOf(m: Manifold): PieceGeo {
  const mesh = m.getMesh();
  const p = mesh.numProp;
  const soup = new Float64Array(mesh.numTri * 9);
  for (let t = 0; t < mesh.numTri; t++) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.triVerts[t * 3 + k];
      soup[t * 9 + k * 3] = mesh.vertProperties[v * p];
      soup[t * 9 + k * 3 + 1] = mesh.vertProperties[v * p + 1];
      soup[t * 9 + k * 3 + 2] = mesh.vertProperties[v * p + 2];
    }
  }
  const h = m.hull();
  const hm = h.getMesh();
  h.delete();
  const hull = new Float64Array(hm.numVert * 3);
  for (let v = 0; v < hm.numVert; v++) {
    hull[v * 3] = hm.vertProperties[v * hm.numProp];
    hull[v * 3 + 1] = hm.vertProperties[v * hm.numProp + 1];
    hull[v * 3 + 2] = hm.vertProperties[v * hm.numProp + 2];
  }
  // A hull face is a flat polygon cut into triangles, so the triangles are
  // gathered back up by normal to find its whole area.
  const facets = new Map<string, { n: Vec3; area: number }>();
  for (let t = 0; t < hm.numTri; t++) {
    const a = hm.triVerts[t * 3], b = hm.triVerts[t * 3 + 1], c = hm.triVerts[t * 3 + 2];
    const pa = [hull[a * 3], hull[a * 3 + 1], hull[a * 3 + 2]];
    const u = [hull[b * 3] - pa[0], hull[b * 3 + 1] - pa[1], hull[b * 3 + 2] - pa[2]];
    const w = [hull[c * 3] - pa[0], hull[c * 3 + 1] - pa[1], hull[c * 3 + 2] - pa[2]];
    const n = cross(u, w);
    const len = Math.hypot(n[0], n[1], n[2]);
    if (!(len > 1e-9)) continue;
    const nu = scale3(n, 1 / len);
    const key = nu.map((x) => Math.round(x * 1000)).join(',');
    const f = facets.get(key);
    if (f) f.area += len / 2;
    else facets.set(key, { n: nu, area: len / 2 });
  }
  const restDowns = [...facets.values()].sort((x, y) => y.area - x.area).slice(0, 24).map((f) => f.n);
  return { soup, hull, restDowns, volume: m.volume() };
}

// ---------------------------------------------------------------------------
// Which way up
// ---------------------------------------------------------------------------

export interface PoseEval {
  /** Body-local direction that faces the bed. */
  down: Vec3;
  spin: number;
  fits: boolean;
  supportMm2: number;
  heightMm: number;
  /** Posed size along bed X, Y, Z. */
  sizeMm: Vec3;
  /** How far over the bed it is, as a ratio; 1 or less fits. */
  overflow: number;
  cost: number;
}

/** Andrew's monotone chain. Points as [x, y]. */
function hull2d(pts: [number, number][]): [number, number][] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const crossZ = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of p) {
    while (lower.length >= 2 && crossZ(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && crossZ(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

/**
 * The footprint rectangle that fits the bed, by rotating calipers: the best
 * rectangle round a convex outline has a side along one of its edges. Of the
 * ones that fit, the smallest; if none does, the one that overflows least.
 */
function footprint(pts: [number, number][], W: number, D: number): { fits: boolean; spin: number; w: number; d: number; overflow: number } {
  const ring = hull2d(pts);
  let best: { fits: boolean; spin: number; w: number; d: number; overflow: number; area: number } | null = null;
  const consider = (theta: number) => {
    const c = Math.cos(theta), s = Math.sin(theta);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of ring) {
      const xr = x * c + y * s, yr = -x * s + y * c;
      if (xr < x0) x0 = xr; if (xr > x1) x1 = xr;
      if (yr < y0) y0 = yr; if (yr > y1) y1 = yr;
    }
    const w = x1 - x0, d = y1 - y0;
    for (const quarter of [false, true]) {
      const bw = quarter ? d : w, bd = quarter ? w : d;
      const overflow = Math.max(bw / W, bd / D);
      const fits = overflow <= 1 + 1e-9;
      const cand = { fits, spin: -theta + (quarter ? Math.PI / 2 : 0), w: bw, d: bd, overflow, area: w * d };
      if (!best
        || (fits && !best.fits)
        || (fits === best.fits && (fits ? cand.area < best.area - 1e-9 : cand.overflow < best.overflow - 1e-9))) {
        best = cand;
      }
    }
  };
  consider(0);
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    consider(Math.atan2(b[1] - a[1], b[0] - a[0]));
  }
  const b = best ?? { fits: false, spin: 0, w: 0, d: 0, overflow: Infinity, area: 0 };
  return { fits: b.fits, spin: b.spin, w: b.w, d: b.d, overflow: b.overflow };
}

function evaluatePose(geo: PieceGeo, down: Vec3, ctx: Ctx): PoseEval {
  const R = rotationBetween(down, [0, 0, -1]);
  const hp = rotatePoints(R, geo.hull);
  let z0 = Infinity, z1 = -Infinity;
  const pts: [number, number][] = [];
  for (let i = 0; i < hp.length; i += 3) {
    if (hp[i + 2] < z0) z0 = hp[i + 2];
    if (hp[i + 2] > z1) z1 = hp[i + 2];
    pts.push([hp[i], hp[i + 1]]);
  }
  const height = z1 - z0;
  const fp = footprint(pts, ctx.W, ctx.D);
  const overflow = Math.max(fp.overflow, height / ctx.H);
  const fits = overflow <= 1 + 1e-9;
  let support = 0;
  if (fits) {
    support = supportArea(rotatePoints(R, geo.soup), ctx.overhangDeg, 0.5).area;
  }
  return {
    down, spin: fp.spin, fits, supportMm2: support, heightMm: height,
    sizeMm: [fp.w, fp.d, height], overflow,
    // Support is what costs: time, material and a scarred face. Height breaks
    // ties, because a lower print is a quicker one.
    cost: fits ? support + 0.5 * height : Infinity,
  };
}

const AXES: Vec3[] = [[0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];

/** The cheapest way up that fits, or the nearest miss when none does. */
function bestPose(geo: PieceGeo, extraDowns: Vec3[], ctx: Ctx): PoseEval {
  const downs: Vec3[] = [];
  for (const d of [...AXES, ...extraDowns, ...geo.restDowns]) {
    const u = unit(d);
    if (downs.some((e) => dot(e, u) > 0.99996)) continue; // within half a degree
    downs.push(u);
  }
  let best: PoseEval | null = null;
  for (const d of downs) {
    const e = evaluatePose(geo, d, ctx);
    if (!best
      || (e.fits && !best.fits)
      || (e.fits && best.fits && e.cost < best.cost - 1e-6)
      || (!e.fits && !best.fits && e.overflow < best.overflow)) {
      best = e;
    }
  }
  return best!;
}

// ---------------------------------------------------------------------------
// Planes
// ---------------------------------------------------------------------------

/** u, v across the plane and n through it, right-handed: u × v = n. */
function planeAxes(n: Vec3): { u: Vec3; v: Vec3 } {
  const helper: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit(cross(helper, n));
  const v = cross(n, u);
  return { u, v };
}

/** Column-major affine taking body space to plane space (u, v, n). */
function toPlaneMatrix(n: Vec3): Mat4 {
  const { u, v } = planeAxes(n);
  return [u[0], v[0], n[0], 0, u[1], v[1], n[1], 0, u[2], v[2], n[2], 0, 0, 0, 0, 1];
}

/** A Mat3 (row-major) and a translation as Manifold's column-major Mat4. */
function affine(R: Mat3, t: ArrayLike<number>): Mat4 {
  return [R[0], R[3], R[6], 0, R[1], R[4], R[7], 0, R[2], R[5], R[8], 0, t[0], t[1], t[2], 1];
}

/** The piece's section where it crosses the plane n·p = offset, in plane (u, v) coordinates. */
function sliceAt(m: Manifold, n: Vec3, offset: number): CrossSection {
  const t = m.transform(toPlaneMatrix(n));
  try {
    return t.slice(offset);
  } finally {
    t.delete();
  }
}

function fromPlane(n: Vec3, offset: number, x: number, y: number): Vec3 {
  const { u, v } = planeAxes(n);
  return add3(add3(scale3(u, x), scale3(v, y)), scale3(n, offset));
}

/** Principal axes of a point cloud, by Jacobi on its covariance. */
function principalAxes(points: Float64Array): Vec3[] {
  const n = points.length / 3;
  if (n < 3) return [];
  let mx = 0, my = 0, mz = 0;
  for (let i = 0; i < points.length; i += 3) { mx += points[i]; my += points[i + 1]; mz += points[i + 2]; }
  mx /= n; my /= n; mz /= n;
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < points.length; i += 3) {
    const d = [points[i] - mx, points[i + 1] - my, points[i + 2] - mz];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r][c] += d[r] * d[c];
  }
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 32; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += C[p][q] * C[p][q];
    if (off < 1e-18) break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(C[p][q]) < 1e-30) continue;
        const theta = (C[q][q] - C[p][p]) / (2 * C[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 3; k++) {
          const ckp = C[k][p], ckq = C[k][q];
          C[k][p] = c * ckp - s * ckq; C[k][q] = s * ckp + c * ckq;
        }
        for (let k = 0; k < 3; k++) {
          const cpk = C[p][k], cqk = C[q][k];
          C[p][k] = c * cpk - s * cqk; C[q][k] = s * cpk + c * cqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return [0, 1, 2].map((k) => unit([V[0][k], V[1][k], V[2][k]]));
}

// ---------------------------------------------------------------------------
// Cutting
// ---------------------------------------------------------------------------

interface Piece {
  m: Manifold;
  geo: PieceGeo;
  pose: PoseEval;
  /** Outward normals of its cut faces, for the pose search. */
  cutDowns: Vec3[];
  explode: Vec3;
}

function makePiece(m: Manifold, cutDowns: Vec3[], explode: Vec3, ctx: Ctx): Piece {
  const geo = geoOf(m);
  return { m, geo, pose: bestPose(geo, cutDowns, ctx), cutDowns, explode };
}

/** Sections a piece will probably come to, from its bounding box against the bed. */
function predictedSections(p: Piece, ctx: Ctx): number {
  if (p.pose.fits) return 1;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.geo.hull.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], p.geo.hull[i + k]);
      hi[k] = Math.max(hi[k], p.geo.hull[i + k]);
    }
  }
  const ext = [0, 1, 2].map((k) => hi[k] - lo[k]).sort((a, b) => b - a);
  const bed = [ctx.W, ctx.D, ctx.H].sort((a, b) => b - a);
  return Math.max(2, ext.reduce((n, e, k) => n * Math.max(1, Math.ceil(e / bed[k] - 1e-9)), 1));
}

/** The pin hole's radius and the inset a pin needs from the edge of a face. */
function pinInset(j: Joinery): number {
  return (j.diameterMm + j.clearanceMm) / 2 + j.minWallMm;
}

/** What a cut's face looks like: is any of it too thin to glue, and how much has no room for a pin. */
function judgeFace(cs: CrossSection, ctx: Ctx): { area: number; thin: boolean; noRoom: number } {
  const area = cs.area();
  let thin = false, noRoom = 0;
  const parts = cs.decompose();
  for (const part of parts) {
    if (part.area() < MIN_JOINT_AREA_MM2) { part.delete(); continue; }
    const wall = part.offset(-ctx.joinery.minWallMm, 'Round');
    if (wall.isEmpty()) thin = true;
    wall.delete();
    if (ctx.joinery.kind !== 'none') {
      const room = part.offset(-pinInset(ctx.joinery), 'Round');
      if (room.isEmpty()) noRoom++;
      room.delete();
    }
    part.delete();
  }
  return { area, thin, noRoom };
}

interface CutChoice { n: Vec3; offset: number; pos: Piece; neg: Piece; score: number }

/** The best single cut of a piece that does not fit, or null if no cut works at all. */
function chooseCut(piece: Piece, ctx: Ctx): CutChoice | null {
  const normals: Vec3[] = [];
  for (const n of [[1, 0, 0], [0, 1, 0], [0, 0, 1], ...principalAxes(piece.geo.hull)] as Vec3[]) {
    const u = unit(n);
    if (normals.some((e) => Math.abs(dot(e, u)) > Math.cos(5 * Math.PI / 180))) continue;
    normals.push(u);
  }
  const usable = Math.max(ctx.W, ctx.D, ctx.H);
  let best: CutChoice | null = null;

  for (const n of normals) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < piece.geo.hull.length; i += 3) {
      const s = dot(n, [piece.geo.hull[i], piece.geo.hull[i + 1], piece.geo.hull[i + 2]]);
      if (s < lo) lo = s; if (s > hi) hi = s;
    }
    const extent = hi - lo;
    if (!(extent > 1)) continue;
    const slabs = Math.max(2, Math.ceil(extent / usable - 1e-9));
    const slab = extent / slabs;
    for (let step = -3; step <= 3; step++) {
      const offset = lo + slab + step * 0.05 * slab;
      if (offset <= lo + 0.5 || offset >= hi - 0.5) continue;
      const [posM, negM] = piece.m.splitByPlane(n, offset);
      const vp = posM.volume(), vn = negM.volume();
      if (posM.isEmpty() || negM.isEmpty() || vp < SLIVER_SHARE * piece.geo.volume || vn < SLIVER_SHARE * piece.geo.volume) {
        posM.delete(); negM.delete();
        continue;
      }
      const cs = sliceAt(piece.m, n, offset);
      const face = judgeFace(cs, ctx);
      cs.delete();
      // The pos half's cut face looks back down the normal, and the neg half's along it.
      const pos = makePiece(posM, [...piece.cutDowns, neg3(n)], add3(piece.explode, n), ctx);
      const neg = makePiece(negM, [...piece.cutDowns, n], add3(piece.explode, neg3(n)), ctx);
      const sections = predictedSections(pos, ctx) + predictedSections(neg, ctx);
      const support = (pos.pose.fits ? pos.pose.supportMm2 : 0) + (neg.pose.fits ? neg.pose.supportMm2 : 0);
      // Off the even split only for a reason: a tie goes to the even cut, so
      // the sections come out the same size rather than one barely fitting.
      const score = sections * 1e9 + (face.thin ? 1e12 : 0) + face.noRoom * 1e7 + support + 0.25 * face.area
        + Math.abs(step) * 0.01 * slab;
      if (!best || score < best.score) {
        if (best) { best.pos.m.delete(); best.neg.m.delete(); }
        best = { n, offset, pos, neg, score };
      } else {
        posM.delete(); negM.delete();
      }
    }
  }
  if (best && best.score >= 1e12) {
    ctx.warnings.push('One cut runs through material thinner than the minimum wall, because no cut avoided it. Check that seam before gluing.');
  }
  return best;
}

// ---------------------------------------------------------------------------
// Joinery
// ---------------------------------------------------------------------------

/** Pin centres for one patch of shared face, plane coordinates. */
function placePins(part: CrossSection, j: Joinery): [number, number][] {
  const region = part.offset(-pinInset(j), 'Round');
  try {
    if (region.isEmpty()) return [];
    const polys = region.toPolygons();
    const pts = polys.flat() as [number, number][];
    const inside = (x: number, y: number) => {
      let c = false;
      for (const poly of polys) {
        for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) {
          const [xi, yi] = poly[i], [xk, yk] = poly[k];
          if ((yi > y) !== (yk > y) && x < ((xk - xi) * (y - yi)) / (yk - yi) + xi) c = !c;
        }
      }
      return c;
    };

    // The two points of the region furthest apart. If they are far enough
    // apart for two pins to stop the joint turning, use two, pulled a little
    // in from the ends; the region's own boundary is already a full inset from
    // the edge, so the ends themselves are the fallback.
    let a = pts[0], b = pts[0], far = 0;
    for (let i = 0; i < pts.length; i++) {
      for (let k = i + 1; k < pts.length; k++) {
        const d = Math.hypot(pts[i][0] - pts[k][0], pts[i][1] - pts[k][1]);
        if (d > far) { far = d; a = pts[i]; b = pts[k]; }
      }
    }
    if (far > 4 * j.diameterMm) {
      const p: [number, number] = [a[0] + 0.15 * (b[0] - a[0]), a[1] + 0.15 * (b[1] - a[1])];
      const q: [number, number] = [b[0] - 0.15 * (b[0] - a[0]), b[1] - 0.15 * (b[1] - a[1])];
      return inside(p[0], p[1]) && inside(q[0], q[1]) ? [p, q] : [a, b];
    }

    // One pin, as deep in the region as it will go: shrink it until it is
    // about to vanish, and take what is left.
    const bounds = region.bounds();
    let lo = 0, hi = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]) / 2;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      const s = region.offset(-mid, 'Round');
      const empty = s.isEmpty();
      s.delete();
      if (empty) hi = mid; else lo = mid;
    }
    const core = region.offset(-lo, 'Round');
    const corePts = core.toPolygons().flat();
    core.delete();
    if (corePts.length) {
      const cx = corePts.reduce((s, p) => s + p[0], 0) / corePts.length;
      const cy = corePts.reduce((s, p) => s + p[1], 0) / corePts.length;
      if (inside(cx, cy)) return [[cx, cy]];
      return [corePts[0] as [number, number]];
    }
    return [pts[0]];
  } finally {
    region.delete();
  }
}

/** A hole already drilled, in mm. */
interface Drilled { section: number; at: Vec3; axis: Vec3; depth: number; radius: number }

/**
 * Where on a joint's face (plane coordinates) a new pin may NOT go, because its
 * hole would come within a wall's thickness of a hole already drilled in one of
 * the two sections. Null when nothing is in the way.
 *
 * Each existing hole is walked along its axis; wherever a point of it lies in
 * the slab the new hole would occupy (its depth into that section, padded by
 * the clearance), the disc of positions too close to it is ruled out.
 */
function clearOfHoles(
  wasm: ManifoldToplevel, n: Vec3, offset: number,
  sides: { section: number; inward: Vec3 }[], drilled: Drilled[], j: Joinery,
): CrossSection | null {
  const { u, v } = planeAxes(n);
  const rNew = (j.diameterMm + j.clearanceMm) / 2;
  const depthNew = j.lengthMm / 2 + HOLE_EXTRA_MM;
  const discs: CrossSection[] = [];
  const seen = new Set<string>();
  for (const { section, inward } of sides) {
    for (const d of drilled) {
      if (d.section !== section) continue;
      const reach = rNew + d.radius + j.minWallMm;
      const steps = Math.max(1, Math.ceil(d.depth / 0.5));
      for (let k = 0; k <= steps; k++) {
        const p = add3(d.at, scale3(d.axis, (d.depth * k) / steps));
        const h = dot(inward, p) - dot(inward, scale3(n, offset));
        if (h < -reach || h > depthNew + reach) continue;
        const x = dot(u, p), y = dot(v, p);
        const key = `${Math.round(x * 4)},${Math.round(y * 4)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        discs.push(wasm.CrossSection.circle(reach, 24).translate([x, y]));
      }
    }
  }
  if (!discs.length) return null;
  const all = wasm.CrossSection.union(discs);
  for (const disc of discs) disc.delete();
  return all;
}

/** A cylinder along `axis` from `start` for `length`, radius r1 at the start and r2 at the end. */
function cylinderAlong(wasm: ManifoldToplevel, start: Vec3, axis: Vec3, length: number, r1: number, r2 = r1): Manifold {
  const c = wasm.Manifold.cylinder(length, r1, r2, PIN_SEGMENTS);
  const R = rotationBetween([0, 0, 1], axis);
  try {
    return c.transform(affine(R, start));
  } finally {
    c.delete();
  }
}

/** The hole a pin goes into: from just outside the face, `depth` into the material along `inward`. */
function boreSolid(wasm: ManifoldToplevel, at: Vec3, inward: Vec3, j: Joinery): Manifold {
  const r = (j.diameterMm + j.clearanceMm) / 2;
  const depth = j.lengthMm / 2 + HOLE_EXTRA_MM;
  return cylinderAlong(wasm, add3(at, scale3(inward, -1)), inward, depth + 1, r);
}

/** A printed peg standing out of the face along `outward`, chamfered at the tip. */
function pegSolid(wasm: ManifoldToplevel, at: Vec3, outward: Vec3, j: Joinery): Manifold {
  const r = j.diameterMm / 2;
  const length = j.lengthMm / 2;
  const chamfer = r > PEG_CHAMFER_MM * 1.5 ? PEG_CHAMFER_MM : 0;
  const shaft = cylinderAlong(wasm, add3(at, scale3(outward, -PEG_SINK_MM)), outward, length - chamfer + PEG_SINK_MM, r);
  if (!chamfer) return shaft;
  const tip = cylinderAlong(wasm, add3(at, scale3(outward, length - chamfer)), outward, chamfer, r, r - chamfer);
  try {
    return shaft.add(tip);
  } finally {
    shaft.delete(); tip.delete();
  }
}

function replace(arr: Manifold[], i: number, next: Manifold) {
  arr[i].delete();
  arr[i] = next;
}

// ---------------------------------------------------------------------------
// Exact convex pieces
// ---------------------------------------------------------------------------

/** Solid enough to collide as its own hull. */
const CONVEX_ENOUGH = 0.995;
/** Pieces per section, at most: contact cost grows with the square. */
const MAX_PIECES = 16;
/** Planes tried per piece: the largest flat regions of its surface. */
const MAX_PLANES = 32;

/**
 * A solid cut into convex pieces along the planes of its own faces.
 *
 * Each step takes the plane that most reduces the pieces' combined hull volume
 * — for an L, the plane of the inside face of one leg, which leaves two boxes.
 * A part built of flat faces comes out exact. A curved one stops when no plane
 * helps any more, or at MAX_PIECES, and what is left collides as its hull.
 * Returns nothing when the solid is convex already. Does not take ownership of `m`.
 */
function convexPieces(m: Manifold): Manifold[] {
  const solidity = (p: Manifold) => {
    const h = p.hull();
    try { return p.volume() / Math.max(1e-12, h.volume()); } finally { h.delete(); }
  };
  if (solidity(m) >= CONVEX_ENOUGH) return [];
  const done: Manifold[] = [];
  const todo: Manifold[] = [m.translate([0, 0, 0])];
  while (todo.length) {
    const p = todo.pop()!;
    if (done.length + todo.length + 1 >= MAX_PIECES || solidity(p) >= CONVEX_ENOUGH) { done.push(p); continue; }
    // The surface's flat regions, largest first, as planes n·x = d.
    const mesh = p.getMesh();
    const planes = new Map<string, { n: Vec3; d: number; area: number }>();
    for (let t = 0; t < mesh.numTri; t++) {
      const v = [0, 1, 2].map((k) => {
        const i = mesh.triVerts[t * 3 + k] * mesh.numProp;
        return [mesh.vertProperties[i], mesh.vertProperties[i + 1], mesh.vertProperties[i + 2]];
      });
      const c = cross([v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]], [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]]);
      const len = Math.hypot(c[0], c[1], c[2]);
      if (!(len > 1e-9)) continue;
      const n = scale3(c, 1 / len);
      const d = dot(n, v[0]);
      const key = `${n.map((x) => Math.round(x * 1e4)).join(',')}:${Math.round(d * 100)}`;
      const e = planes.get(key);
      if (e) e.area += len / 2; else planes.set(key, { n, d, area: len / 2 });
    }
    const pv = p.volume();
    const h = p.hull();
    let bestHull = h.volume() * 0.99; // a split has to earn its keep
    h.delete();
    let best: [Manifold, Manifold] | null = null;
    for (const { n, d } of [...planes.values()].sort((a, b) => b.area - a.area).slice(0, MAX_PLANES)) {
      const [a, b] = p.splitByPlane(n, d);
      const va = a.volume(), vb = b.volume();
      if (va < 1e-3 * pv || vb < 1e-3 * pv) { a.delete(); b.delete(); continue; }
      const ha = a.hull(), hb = b.hull();
      const total = ha.volume() + hb.volume();
      ha.delete(); hb.delete();
      if (total < bestHull - 1e-9) {
        if (best) { best[0].delete(); best[1].delete(); }
        best = [a, b];
        bestHull = total;
      } else {
        a.delete(); b.delete();
      }
    }
    if (!best) { done.push(p); continue; }
    p.delete();
    todo.push(best[0], best[1]);
  }
  return done;
}

// ---------------------------------------------------------------------------
// Exact colliders
// ---------------------------------------------------------------------------

/** MuJoCo's w, x, y, z for the frame whose x, y and z axes are these. */
function quatFromAxes(x: Vec3, y: Vec3, z: Vec3): [number, number, number, number] {
  const m00 = x[0], m01 = y[0], m02 = z[0];
  const m10 = x[1], m11 = y[1], m12 = z[1];
  const m20 = x[2], m21 = y[2], m22 = z[2];
  const tr = m00 + m11 + m22;
  let w, qx, qy, qz;
  if (tr > 0) {
    const k = Math.sqrt(tr + 1) * 2;
    w = k / 4; qx = (m21 - m12) / k; qy = (m02 - m20) / k; qz = (m10 - m01) / k;
  } else if (m00 > m11 && m00 > m22) {
    const k = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / k; qx = k / 4; qy = (m01 + m10) / k; qz = (m02 + m20) / k;
  } else if (m11 > m22) {
    const k = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / k; qx = (m01 + m10) / k; qy = k / 4; qz = (m12 + m21) / k;
  } else {
    const k = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / k; qx = (m02 + m20) / k; qy = (m12 + m21) / k; qz = k / 4;
  }
  const l = Math.hypot(w, qx, qy, qz) || 1;
  return [w / l, qx / l, qy / l, qz / l];
}

/**
 * A hole's walls and floor as boxes: sixteen flat sides whose inner faces
 * touch the hole's circle, and a cap at the bottom. In millimetres; the caller
 * converts. The walls start at the face and run the hole's depth.
 */
/** A collider before it is told which joint it belongs to. */
type Ungrouped = FeatureCollider extends infer C ? (C extends unknown ? Omit<C, 'group'> : never) : never;

function boreLining(f: { at: Vec3; axis: Vec3; radius: number; depth: number }): Ungrouped[] {
  const { u, v } = planeAxes(f.axis);
  const R = f.radius, t = LINING_MM;
  const halfChord = (R + t) * Math.tan(Math.PI / LINING_SIDES);
  const out: Ungrouped[] = [];
  for (let k = 0; k < LINING_SIDES; k++) {
    const th = (2 * Math.PI * k) / LINING_SIDES;
    const radial = add3(scale3(u, Math.cos(th)), scale3(v, Math.sin(th)));
    const tangent = cross(f.axis, radial);
    const pos = add3(add3(f.at, scale3(radial, R + t / 2)), scale3(f.axis, f.depth / 2));
    out.push({ role: 'socket', shape: 'box', pos, quat: quatFromAxes(radial, tangent, f.axis), half: [t / 2, halfChord, f.depth / 2] });
  }
  out.push({
    role: 'socket',
    shape: 'box',
    pos: add3(f.at, scale3(f.axis, f.depth + t / 2)),
    quat: quatFromAxes(u, v, f.axis),
    half: [R + t, R + t, t / 2],
  });
  return out;
}

/** A closed prism: a convex polygon at `z0` and again at `z1`, in plane space, as body-space mm. */
function prism(n: Vec3, ring: [number, number][], z0: number, z1: number): Ungrouped {
  const k = ring.length;
  const positions: number[] = [];
  for (const z of [z0, z1]) for (const [x, y] of ring) positions.push(...fromPlane(n, z, x, y));
  const faces: number[] = [];
  for (let i = 1; i < k - 1; i++) { faces.push(0, i + 1, i); faces.push(k, k + i, k + i + 1); }
  for (let i = 0; i < k; i++) {
    const j = (i + 1) % k;
    faces.push(i, j, k + j, i, k + j, k + i);
  }
  // Whichever way the ring ran and whichever side z1 is, wind it outward.
  let vol = 0;
  for (let i = 0; i < faces.length; i += 3) {
    const a = faces[i] * 3, b = faces[i + 1] * 3, c = faces[i + 2] * 3;
    vol += dot(positions.slice(a, a + 3), cross(positions.slice(b, b + 3), positions.slice(c, c + 3)));
  }
  if (vol < 0) for (let i = 0; i < faces.length; i += 3) [faces[i + 1], faces[i + 2]] = [faces[i + 2], faces[i + 1]];
  return { role: 'socket', shape: 'prism', positions, faces };
}

/**
 * The face round a joint's holes, as convex slabs a lining's thickness deep.
 *
 * Needed because the holes' own colliders meet only other exact colliders: a
 * pin that misses its hole has to land on something it can touch, or it would
 * pass straight into the part. The face is cut into strips and cells along the
 * square round each hole, which keeps every piece convex for a convex face
 * (MuJoCo collides a mesh as its hull); a piece that still is not convex is
 * cut into triangles.
 */
function facePlates(
  wasm: ManifoldToplevel, patch: CrossSection, n: Vec3, faceAt: number, inward: number, holes: [number, number][], R: number,
): Ungrouped[] {
  const b = patch.bounds();
  const ys = [b.min[1], b.max[1], ...holes.flatMap(([, y]) => [y - R, y + R])]
    .filter((y) => y >= b.min[1] && y <= b.max[1]).sort((p, q) => p - q);
  const out: Ungrouped[] = [];
  const z1 = faceAt + inward * LINING_MM;
  for (let i = 0; i + 1 < ys.length; i++) {
    const y0 = ys[i], y1 = ys[i + 1];
    if (y1 - y0 < 1e-3) continue;
    const across = holes.filter(([, y]) => y - R <= y0 + 1e-9 && y + R >= y1 - 1e-9);
    const xs = [b.min[0], b.max[0], ...across.flatMap(([x]) => [x - R, x + R])]
      .filter((x) => x >= b.min[0] && x <= b.max[0]).sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k++) {
      const x0 = xs[k], x1 = xs[k + 1];
      if (x1 - x0 < 1e-3) continue;
      const mx = (x0 + x1) / 2;
      if (across.some(([x]) => Math.abs(x - mx) < R)) continue; // the hole itself
      const cell = new wasm.CrossSection([[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]);
      const piece = patch.intersect(cell);
      cell.delete();
      for (const part of piece.decompose()) {
        if (part.area() >= 0.5) {
          const hull = part.hull();
          const convex = hull.area() <= part.area() * 1.01;
          hull.delete();
          const polys = part.toPolygons();
          const r = part.bounds();
          const w = r.max[0] - r.min[0], h = r.max[1] - r.min[1];
          if (convex && polys.length === 1 && Math.abs(part.area() - w * h) < 1e-6 * w * h + 1e-6) {
            // A rectangle, which is what a rectangular face's cells all are:
            // a box, because MuJoCo collides boxes with each other exactly and
            // with several contacts, where two thin slabs of mesh go through
            // the general convex routine and rock on a single point.
            const { u, v } = planeAxes(n);
            const centre = fromPlane(n, (faceAt + z1) / 2, (r.min[0] + r.max[0]) / 2, (r.min[1] + r.max[1]) / 2);
            out.push({ role: 'socket', shape: 'box', pos: centre, quat: quatFromAxes(u, v, n), half: [w / 2, h / 2, LINING_MM / 2] });
          } else if (convex && polys.length === 1) {
            out.push(prism(n, polys[0] as [number, number][], faceAt, z1));
          } else {
            const pts = polys.flat() as [number, number][];
            for (const [a, c, d] of wasm.triangulate(polys)) {
              const ring: [number, number][] = [pts[a], pts[c], pts[d]];
              const area = Math.abs((ring[1][0] - ring[0][0]) * (ring[2][1] - ring[0][1]) - (ring[2][0] - ring[0][0]) * (ring[1][1] - ring[0][1])) / 2;
              if (area >= 0.5) out.push(prism(n, ring, faceAt, z1));
            }
          }
        }
        part.delete();
      }
      piece.delete();
    }
  }
  return out;
}

/** A collider in millimetres, scaled to metres. */
function colliderToMetres(c: FeatureCollider): FeatureCollider {
  if (c.shape === 'box') return { ...c, pos: scale3(c.pos, 1 / MM), half: scale3(c.half, 1 / MM) };
  if (c.shape === 'cylinder') return { ...c, pos: scale3(c.pos, 1 / MM), radius: c.radius / MM, halfLength: c.halfLength / MM };
  return { ...c, positions: c.positions.map((p) => p / MM) };
}

// ---------------------------------------------------------------------------
// The whole job
// ---------------------------------------------------------------------------

/**
 * Splits a body into sections that fit the bed.
 *
 * `soups` are the body's solids as triangle soups (9 numbers a triangle),
 * body frame, Z-up, metres; they are unioned. Never throws for bad geometry:
 * a body that cannot be made a solid says why in `error`.
 */
export function splitForPrint(wasm: ManifoldToplevel, soups: ArrayLike<number>[], opts: SplitOptions): SplitResult {
  const margin = opts.marginMm ?? 5;
  const joinery: Joinery = { ...DEFAULT_JOINERY, ...(opts.joinery ?? {}) };
  const maxSections = Math.max(1, Math.min(256, Math.round(opts.maxSections ?? 64)));
  const ctx: Ctx = {
    wasm,
    W: opts.bed.widthMm - 2 * margin,
    D: opts.bed.depthMm - 2 * margin,
    H: opts.bed.heightMm,
    overhangDeg: opts.overhangDeg ?? 45,
    joinery,
    warnings: [],
  };
  if (!(ctx.W > 0 && ctx.D > 0 && ctx.H > 0)) return { ok: false, error: 'The bed is smaller than its margins.' };

  const made = solidFrom(wasm, soups);
  if (!made.ok) return made;

  const cuts: SplitCut[] = [];
  const plain: Manifold[] = [];
  const leafInfo: { cutDowns: Vec3[]; explode: Vec3 }[] = [];
  let open = 1;
  let capped = false;

  const build = (piece: Piece): SplitTree => {
    if (!piece.pose.fits && plain.length + open < maxSections) {
      const choice = chooseCut(piece, ctx);
      if (choice) {
        piece.m.delete();
        const cut = cuts.length;
        cuts.push({ normal: choice.n, offset: choice.offset / MM });
        open++;
        const neg = build(choice.neg);
        const pos = build(choice.pos);
        return { cut, neg, pos };
      }
    } else if (!piece.pose.fits) {
      capped = true;
    }
    open--;
    plain.push(piece.m);
    leafInfo.push({ cutDowns: piece.cutDowns, explode: piece.explode });
    return { section: plain.length - 1 };
  };

  const tree = build(makePiece(made.solid, [], [0, 0, 0], ctx));
  if (capped) ctx.warnings.push(`Stopped at ${maxSections} sections, and some of them still do not fit the bed.`);

  // --- Joints: the face each pair of neighbouring sections actually shares.
  const joints: SplitJoint[] = [];
  const jointPatches: CrossSection[] = [];
  const leaves = (t: SplitTree): number[] => ('section' in t ? [t.section] : [...leaves(t.neg), ...leaves(t.pos)]);
  const walk = (t: SplitTree) => {
    if ('section' in t) return;
    const { normal: n } = cuts[t.cut];
    const o = cuts[t.cut].offset * MM;
    const negLeaves = leaves(t.neg), posLeaves = leaves(t.pos);
    const negFaces = negLeaves.map((s) => sliceAt(plain[s], n, o - FACE_EPS));
    const posFaces = posLeaves.map((s) => sliceAt(plain[s], n, o + FACE_EPS));
    negLeaves.forEach((a, i) => {
      posLeaves.forEach((b, k) => {
        const patch = negFaces[i].intersect(posFaces[k]);
        const area = patch.area();
        if (area < MIN_JOINT_AREA_MM2) { patch.delete(); return; }
        joints.push({ cut: t.cut, neg: a, pos: b, areaMm2: area, pins: [] });
        jointPatches.push(patch);
      });
    });
    for (const f of [...negFaces, ...posFaces]) f.delete();
    walk(t.neg); walk(t.pos);
  };
  walk(tree);

  // --- Joinery, joint by joint.
  const final: Manifold[] = plain.map((m) => m.translate([0, 0, 0]));
  const features: JoineryFeature[][] = plain.map(() => []);
  const colliders: FeatureCollider[][] = plain.map(() => []);
  const drilled: Drilled[] = [];
  if (joinery.kind !== 'none') {
    joints.forEach((joint, ji) => {
      const n = cuts[joint.cut].normal;
      const o = cuts[joint.cut].offset * MM;
      const centres: [number, number][] = [];
      const parts = jointPatches[ji].decompose();
      // Keep clear of every hole already drilled in either section: near a
      // corner a hole from this face could otherwise run into one from the
      // next, and two dowels crossing in a part cannot both go in.
      const clear = clearOfHoles(wasm, n, o, [
        { section: joint.neg, inward: neg3(n) },
        { section: joint.pos, inward: n },
      ], drilled, joinery);
      for (const whole of parts) {
        if (whole.area() >= MIN_JOINT_AREA_MM2) {
          const part = clear ? whole.subtract(clear) : whole;
          centres.push(...placePins(part, joinery));
          if (part !== whole) part.delete();
        }
        whole.delete();
      }
      clear?.delete();
      if (!centres.length) return;
      const at = centres.map(([x, y]) => fromPlane(n, o, x, y));
      joint.pins = at.map((p) => scale3(p, 1 / MM));

      const r = (joinery.diameterMm + joinery.clearanceMm) / 2;
      const depth = joinery.lengthMm / 2 + HOLE_EXTRA_MM;
      const bore = (s: number, inward: Vec3) => {
        const holes = at.map((p) => boreSolid(wasm, p, inward, joinery));
        const all = wasm.Manifold.union(holes);
        for (const h of holes) h.delete();
        replace(final, s, final[s].subtract(all));
        all.delete();
        for (const p of at) {
          drilled.push({ section: s, at: p, axis: inward, depth, radius: r });
          features[s].push({ kind: 'bore', at: scale3(p, 1 / MM), axis: inward, radius: r / MM, depth: depth / MM, joint: ji });
          colliders[s].push(...boreLining({ at: p, axis: inward, radius: r, depth }).map((c) => ({ ...c, group: ji })));
        }
        colliders[s].push(...facePlates(wasm, jointPatches[ji], n, o, dot(inward, n), centres, r).map((c) => ({ ...c, group: ji })));
      };
      const pegsOn = (s: number, outward: Vec3): Manifold => {
        const pegs = at.map((p) => pegSolid(wasm, p, outward, joinery));
        const all = wasm.Manifold.union(pegs);
        for (const p of pegs) p.delete();
        const out = final[s].add(all);
        all.delete();
        return out;
      };

      if (joinery.kind === 'dowel') {
        bore(joint.neg, neg3(n));
        bore(joint.pos, n);
        return;
      }

      // Pegs go on whichever side minds them least. Standing a peg on a face
      // rules that face out as the one to print on, so the side whose best
      // pose gets worse by less takes them — measured on the real geometry.
      const extraCost = (s: number, outward: Vec3) => {
        const withPeg = pegsOn(s, outward);
        const before = bestPose(geoOf(final[s]), leafInfo[s].cutDowns, ctx);
        const after = bestPose(geoOf(withPeg), leafInfo[s].cutDowns, ctx);
        const cost = !after.fits ? Infinity : after.cost - (before.fits ? before.cost : 0);
        return { withPeg, cost };
      };
      const onNeg = extraCost(joint.neg, n);
      const onPos = extraCost(joint.pos, neg3(n));
      const pegNeg = onNeg.cost <= onPos.cost;
      const [pegS, holeS, out] = pegNeg ? [joint.neg, joint.pos, n] : [joint.pos, joint.neg, neg3(n)];
      replace(final, pegS, pegNeg ? onNeg.withPeg : onPos.withPeg);
      (pegNeg ? onPos : onNeg).withPeg.delete();
      const { u: pu } = planeAxes(out);
      for (const p of at) {
        features[pegS].push({ kind: 'peg', at: scale3(p, 1 / MM), axis: out, radius: joinery.diameterMm / 2 / MM, depth: joinery.lengthMm / 2 / MM, joint: ji });
        colliders[pegS].push({
          role: 'pin',
          group: ji,
          shape: 'cylinder',
          pos: add3(p, scale3(out, joinery.lengthMm / 4)),
          quat: quatFromAxes(pu, cross(out, pu), out),
          radius: joinery.diameterMm / 2,
          halfLength: joinery.lengthMm / 4,
        });
      }
      bore(holeS, out);
      joint.pegSide = pegNeg ? 'neg' : 'pos';
    });
  }
  for (const p of jointPatches) p.delete();

  // A face with no pin is simply glued, and most such faces are slivers where
  // one cut ends against another, between sections that are pinned to the
  // part elsewhere. What matters is a section — or a group of them — that no
  // pin ties to the rest at all: that one has to be lined up by hand.
  if (joinery.kind !== 'none' && plain.length > 1) {
    const root = plain.map((_, i) => i);
    const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i])));
    for (const j of joints) if (j.pins.length) root[find(j.neg)] = find(j.pos);
    const groups = new Map<number, number[]>();
    plain.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));
    if (groups.size > 1) {
      const largest = [...groups.values()].sort((a, b) => b.length - a.length)[0];
      for (const g of groups.values()) {
        if (g === largest) continue;
        const names = g.map((i) => i + 1).join(', ');
        ctx.warnings.push(`Section${g.length > 1 ? 's' : ''} ${names} ${g.length > 1 ? 'are' : 'is'} held to the rest by glue alone: no face ${g.length > 1 ? 'they share' : 'it shares'} with the rest has room for a Ø${joinery.diameterMm} mm ${joinery.kind === 'dowel' ? 'dowel' : 'peg'} with ${joinery.minWallMm} mm of wall round it. Line ${g.length > 1 ? 'them' : 'it'} up by hand when gluing.`);
      }
    }
  }

  // --- Final poses, on the real geometry.
  const sections: SplitSection[] = final.map((m, s) => {
    const geo = geoOf(m);
    const pose = bestPose(geo, leafInfo[s].cutDowns, ctx);
    const out = toMetres(m);
    const raw = toMetres(plain[s]);
    const hull = plain[s].hull();
    const solidity = Math.min(1, plain[s].volume() / Math.max(1e-12, hull.volume()));
    hull.delete();
    const pieces = convexPieces(plain[s]);
    const convex = pieces.map(toMetres);
    for (const piece of pieces) piece.delete();
    return {
      positions: out.positions,
      faces: out.faces,
      plainPositions: raw.positions,
      plainFaces: raw.faces,
      up: neg3(pose.down),
      spin: pose.spin,
      supportMm2: pose.supportMm2,
      sizeMm: pose.sizeMm,
      fits: pose.fits,
      volumeMm3: geo.volume,
      features: features[s],
      colliders: colliders[s].map(colliderToMetres),
      solidity,
      convexPieces: convex,
      explode: leafInfo[s].explode,
    };
  });
  for (const m of final) m.delete();
  for (const m of plain) m.delete();

  const misfits = sections.filter((s) => !s.fits).length;
  if (misfits && !capped) {
    ctx.warnings.push(`${misfits} section${misfits === 1 ? '' : 's'} could not be made to fit the bed.`);
  }

  return { ok: true, sections, cuts, joints, tree, joinery, warnings: ctx.warnings };
}

/** The print rotation for a section, as the plate layout and the preview use it. */
export function sectionPoseMatrix(s: Pick<SplitSection, 'up' | 'spin'>): Mat3 {
  return mulMat3(rotationZ(s.spin), rotationBetween(s.up, [0, 0, 1]));
}

// ---------------------------------------------------------------------------
// Exact checks
// ---------------------------------------------------------------------------

export interface SplitChecks {
  /** Volume where two printed sections overlap, mm³. Should be nothing. */
  interferenceMm3: number;
  /** The worst overlapping pair, if any. */
  worstPair: [number, number] | null;
  /** How far the plain sections, put back together, are from the part they were cut from, mm³. */
  reunionErrorMm3: number;
  /** Pins whose hole or peg on one side has no partner on the other side's axis. */
  misalignedPins: number;
  ok: boolean;
}

function manifoldOf(wasm: ManifoldToplevel, positions: ArrayLike<number>, faces: ArrayLike<number>): Manifold {
  const vert = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i++) vert[i] = positions[i] * MM;
  return new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: vert, triVerts: Uint32Array.from(faces) }));
}

/**
 * What MuJoCo cannot resolve, checked exactly: that no two printed sections
 * overlap (a peg sits in a hole with clearance all round, so not even those),
 * that the plain sections add back up to the original part, and that every
 * pin has its partner on the same axis across the joint.
 *
 * `soups` is the original body, as given to splitForPrint.
 */
export function checkSplit(
  wasm: ManifoldToplevel,
  sections: Pick<SplitSection, 'positions' | 'faces' | 'plainPositions' | 'plainFaces' | 'features'>[],
  joints: Pick<SplitJoint, 'neg' | 'pos'>[],
  soups: ArrayLike<number>[],
): SplitChecks {
  const printed = sections.map((s) => manifoldOf(wasm, s.positions, s.faces));
  const plain = sections.map((s) => manifoldOf(wasm, s.plainPositions, s.plainFaces));
  try {
    let interferenceMm3 = 0;
    let worstPair: [number, number] | null = null, worst = 0;
    for (let a = 0; a < printed.length; a++) {
      const ba = printed[a].boundingBox();
      for (let b = a + 1; b < printed.length; b++) {
        const bb = printed[b].boundingBox();
        if ([0, 1, 2].some((k) => ba.max[k] < bb.min[k] || bb.max[k] < ba.min[k])) continue;
        const both = printed[a].intersect(printed[b]);
        const v = both.volume();
        both.delete();
        interferenceMm3 += v;
        if (v > worst) { worst = v; worstPair = [a, b]; }
      }
    }

    let reunionErrorMm3 = Infinity;
    const original = solidFrom(wasm, soups);
    if (original.ok) {
      const whole = wasm.Manifold.union(plain);
      const extra = whole.subtract(original.solid);
      const missing = original.solid.subtract(whole);
      const sum = plain.reduce((v, m) => v + m.volume(), 0);
      // Overlap between plain sections shows up as the sum exceeding the union.
      reunionErrorMm3 = extra.volume() + missing.volume() + Math.max(0, sum - whole.volume());
      for (const m of [whole, extra, missing, original.solid]) m.delete();
    }

    // Every pin on one side of a joint has its partner on the other, on the same axis.
    let misalignedPins = 0;
    for (const [ji] of joints.entries()) {
      const onNeg = sections[joints[ji].neg].features.filter((f) => f.joint === ji);
      const onPos = sections[joints[ji].pos].features.filter((f) => f.joint === ji);
      for (const f of onNeg) {
        const partner = onPos.find((g) => Math.hypot(g.at[0] - f.at[0], g.at[1] - f.at[1], g.at[2] - f.at[2]) < 1e-6
          && Math.abs(dot(g.axis, f.axis)) > 1 - 1e-9);
        if (!partner) misalignedPins++;
      }
      if (onPos.length !== onNeg.length) misalignedPins += Math.abs(onPos.length - onNeg.length);
    }

    const total = plain.reduce((v, m) => v + m.volume(), 0);
    return {
      interferenceMm3,
      worstPair,
      reunionErrorMm3,
      misalignedPins,
      ok: interferenceMm3 < 1e-6 * total + 1e-3 && reunionErrorMm3 < 1e-4 * total && misalignedPins === 0,
    };
  } finally {
    for (const m of [...printed, ...plain]) m.delete();
  }
}
