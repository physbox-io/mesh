// ---------------------------------------------------------------------------
// Contour Slice ("relief map") Export Engine
// ---------------------------------------------------------------------------
//
// The laser exporter unwraps a model's flat faces so the sheet stock becomes the
// skin of a hollow shell. This one does the opposite: it cuts the model into
// horizontal layers, one stock thickness apart, so the stack rebuilds the solid
// the way a contour relief map rebuilds a landscape. Anything can be cut this
// way — spheres, capsules, arbitrary meshes — because nothing has to be planar.
//
// The pipeline is: tessellate the scene into world-space triangles, intersect
// them with each layer's sampling plane, chain the resulting segments into
// closed contours, punch a common set of alignment-pin holes through every
// layer, then nest the parts onto sheets and emit SVG.

import * as THREE from 'three';
import type { SceneGraph, SceneNode, SceneGeom } from '../types/scene';
import { resolveCsgGeoms } from './csg';
import {
  getNodeWorldTransform,
  getGeomFrame,
  yupVertsToZup,
  type Point2D,
} from './laserCutExporter';

export interface ContourSliceOptions {
  /** Stock thickness, in meters. One layer is cut per thickness of model height. */
  materialThickness: number;
  /**
   * Override the layer count instead of deriving it from the model height. The
   * layers still span the whole model, so a count that disagrees with
   * height / thickness builds a stack that is not the modelled height — which is
   * exactly what you want when proofing a tall model on a handful of layers.
   */
  sliceCount: number | null;
  /**
   * Where inside its own layer a contour is sampled. 'middle' splits the error
   * of the staircase both ways; 'bottom' keeps the stack inside the model's
   * silhouette on an outward-sloping wall, 'top' outside it.
   */
  slicePosition: 'bottom' | 'middle' | 'top';
  /** Cut width, in meters. Applied to pin holes so a dowel actually fits. */
  kerf: number;
  /** Punch dowel holes through every layer so the stack can be registered. */
  pinHoles: boolean;
  /** Dowel diameter, in meters. */
  pinDiameter: number;
  /** How many dowels to place. Fewer are placed if the model has no room. */
  pinCount: number;
  sheetWidth: number;  // meters
  sheetHeight: number; // meters
  margin: number;      // meters
  scaleFactor?: number; // scale factor (default 1.0 = 100%)
  autoScale?: boolean;  // auto-scale down cuts to fit sheet/sheet limit
  maxSheets?: number;  // max allowed sheets (0 = unlimited)
  /** Engrave each layer's number, and caption each sheet. */
  includeLabels: boolean;
  /** Draw the dashed sheet boundaries. */
  includeSheetOutline: boolean;
}

export const DEFAULT_CONTOUR_OPTIONS: ContourSliceOptions = {
  materialThickness: 0.003,
  sliceCount: null,
  slicePosition: 'middle',
  kerf: 0.00015,
  pinHoles: true,
  pinDiameter: 0.003,
  pinCount: 2,
  sheetWidth: 0.600,
  sheetHeight: 0.400,
  margin: 0.008,
  scaleFactor: 1.0,
  autoScale: false,
  maxSheets: 0,
  includeLabels: true,
  includeSheetOutline: true,
};

export interface ContourLayer {
  index: number;      // 0 at the bottom
  /** World height the contour was sampled at, in meters. */
  z: number;
  /** Closed cut contours in millimetres. Outer loops are CCW, holes CW. */
  loops: Point2D[][];
  /** How many separate pieces this layer falls into. */
  pieceCount: number;
  /** Cut area in mm², holes excluded. */
  areaMm2: number;
  /** Where the engraved layer number goes, in the same frame as `loops`. */
  labelPos2D?: Point2D;
  /**
   * The layer's model-space corner that lands on `placedPos2D`: its minimum x,
   * and its *maximum* y, because plan-view y runs up and SVG y runs down.
   */
  modelOffset2D?: Point2D;
  placedPos2D?: Point2D;
  width2D?: number;
  height2D?: number;
}

export interface ContourSliceResult {
  success: boolean;
  /** The nested cut sheets. */
  svg?: string;
  /** All contours overlaid in model space — the relief map itself. */
  mapSvg?: string;
  layers?: ContourLayer[];
  sheetCount?: number;
  /** Model height along Z, in meters. */
  modelHeight?: number;
  /** Assembled height of the cut stack, in meters. */
  stackHeight?: number;
  /** Where the dowels ended up, in model millimetres. */
  pins?: { x: number; y: number; radiusMm: number }[];
  scaleFactor?: number;
  error?: string;
  warnings?: string[];
}

/** Cutting more layers than this is a mis-set thickness, not a plan. */
const MAX_LAYERS = 600;
/** Contour vertices closer than this are the same point (mm). */
const WELD_MM = 0.02;
/** Contours smaller than this are slicing noise off a near-tangent face (mm²). */
const MIN_LOOP_AREA_MM2 = 0.5;
/** Contour simplification tolerance (mm) — well below any cutter's precision. */
const SIMPLIFY_MM = 0.05;
const PIN_SEGMENTS = 32;

// ---------------------------------------------------------------------------
// Scene tessellation
// ---------------------------------------------------------------------------

/**
 * Every geom in the scene as world-space triangles, flat as x,y,z per vertex.
 *
 * The coordinates are the scene's own Z-up metres, so Z is height and the
 * slicing planes below are plain z = constant.
 */
/**
 * Six times the volume enclosed by a run of triangles, via the divergence
 * theorem. Positive when the winding is outward-facing. A surface that is not
 * closed lands near zero, which is why the caller only acts on a clear negative.
 */
function signedVolume(tris: number[], from: number, to: number): number {
  let v = 0;
  for (let t = from; t + 8 < to; t += 9) {
    const ax = tris[t], ay = tris[t + 1], az = tris[t + 2];
    const bx = tris[t + 3], by = tris[t + 4], bz = tris[t + 5];
    const cx = tris[t + 6], cy = tris[t + 7], cz = tris[t + 8];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v;
}

/** Reverses each triangle in a run, turning a surface inside out. */
function flipWinding(tris: number[], from: number, to: number): void {
  for (let t = from; t + 8 < to; t += 9) {
    for (let k = 0; k < 3; k++) {
      const tmp = tris[t + 3 + k];
      tris[t + 3 + k] = tris[t + 6 + k];
      tris[t + 6 + k] = tmp;
    }
  }
}

export function collectSceneTriangles(scene: SceneGraph): {
  tris: number[];
  /** Which solid each triangle came from, one entry per triangle. */
  solidIds: number[];
  skipped: string[];
  warnings: string[];
} {
  const tris: number[] = [];
  const solidIds: number[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  let solid = 0;

  const traverse = (node: SceneNode, parentMatrix?: THREE.Matrix4) => {
    const bodyMatrix = getNodeWorldTransform(node, parentMatrix);

    // A body whose holes have never been evaluated still lists its cutters as
    // authored geoms, and resolveCsgGeoms drops them. Slicing the un-subtracted
    // solid silently would hand back layers with no holes in them, so say so.
    if (
      node.csgEnabled &&
      (node.geoms || []).some(g => g.csg === 'difference') &&
      !(node.geoms || []).some(g => g.csgDerived === 'visual')
    ) {
      warnings.push(`${node.name}: CSG has not been compiled, so its holes are not cut.`);
    }

    for (const geom of resolveCsgGeoms(node, 'render')) {
      if (geom.role === 'collision') continue;
      const frame = getGeomFrame(geom);
      const matrix = new THREE.Matrix4().multiplyMatrices(bodyMatrix, frame.matrix);
      const before = tris.length;
      if (!appendGeomTriangles(geom, frame.halfLen, matrix, tris)) {
        skipped.push(`${node.name} (${geom.name || geom.type})`);
        continue;
      }
      const added = (tris.length - before) / 9;
      // Slicing reads winding to decide which side of a contour is material, so
      // an inside-out mesh yields segments that all get unioned away and the
      // export reports no closed contours. Mesh data is not always wound the way
      // a renderer's double-sided material lets it get away with, so flip a
      // solid that encloses negative volume rather than losing it.
      if (signedVolume(tris, before, tris.length) < 0) flipWinding(tris, before, tris.length);
      for (let i = 0; i < added; i++) solidIds.push(solid);
      solid++;
    }

    for (const child of node.children || []) traverse(child, bodyMatrix);
  };

  for (const root of scene.nodes) traverse(root);
  return { tris, solidIds, skipped, warnings };
}

/** Appends one geom's world triangles. Returns false for shapes with no volume. */
function appendGeomTriangles(
  geom: SceneGeom,
  halfLen: number | undefined,
  matrix: THREE.Matrix4,
  out: number[]
): boolean {
  const s = geom.size || [];
  const r = s[0] || 0.01;
  let geometry: THREE.BufferGeometry | null = null;

  switch (geom.type) {
    case 'box':
      geometry = new THREE.BoxGeometry(2 * (s[0] || 0.01), 2 * (s[1] || 0.01), 2 * (s[2] || 0.01));
      break;
    case 'sphere':
      geometry = new THREE.SphereGeometry(r, 48, 24);
      break;
    case 'ellipsoid':
      geometry = new THREE.SphereGeometry(1, 48, 24).scale(s[0] || 0.01, s[1] || 0.01, s[2] || 0.01);
      break;
    case 'cylinder':
      // three builds these around +Y; the scene's primitives run along local +Z.
      geometry = new THREE.CylinderGeometry(r, r, 2 * (halfLen ?? s[1] ?? r), 48).rotateX(Math.PI / 2);
      break;
    case 'capsule':
      geometry = new THREE.CapsuleGeometry(r, 2 * (halfLen ?? s[1] ?? r), 12, 32).rotateX(Math.PI / 2);
      break;
    case 'mesh': {
      // vertices is the Y-up (three.js) copy; renderVertices shares its space
      // with pos/euler/size, and therefore with `matrix`.
      const verts = geom.renderVertices ?? yupVertsToZup(geom.vertices || []);
      const faces = geom.faces || [];
      if (verts.length === 0 || faces.length === 0) return false;
      const v = new THREE.Vector3();
      for (let i = 0; i + 2 < faces.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          const vi = faces[i + k] * 3;
          if (vi + 2 >= verts.length) return false;
          v.set(verts[vi], verts[vi + 1], verts[vi + 2]).applyMatrix4(matrix);
          out.push(v.x, v.y, v.z);
        }
      }
      return true;
    }
    // A plane is the infinite ground, not stock to be cut.
    default:
      return false;
  }

  const nonIndexed = geometry.index ? geometry.toNonIndexed() : geometry;
  nonIndexed.applyMatrix4(matrix);
  const pos = nonIndexed.attributes.position.array;
  for (let i = 0; i < pos.length; i++) out.push(pos[i]);
  return true;
}

// ---------------------------------------------------------------------------
// Slicing
// ---------------------------------------------------------------------------

interface Segment {
  a: Point2D;
  b: Point2D;
  /** The solid this piece of contour came off, so overlaps can be unioned. */
  solid: number;
}

/**
 * Cross-section of a triangle soup at height `z`, as directed segments in
 * millimetres with the solid always on their left.
 *
 * A vertex sitting exactly on the plane would make a triangle produce one point
 * or three, and either way the contour stops chaining. Nudging any such vertex
 * onto the positive side keeps every crossing triangle at exactly two
 * intersections without moving the contour by anything measurable.
 */
export function sliceTrianglesAtZ(tris: number[], z: number, solidIds?: number[]): Segment[] {
  const EPS = 1e-9;
  const segs: Segment[] = [];
  const d = [0, 0, 0];
  const px = [0, 0, 0];
  const py = [0, 0, 0];
  const pz = [0, 0, 0];

  for (let t = 0; t + 8 < tris.length; t += 9) {
    let pos = 0;
    for (let k = 0; k < 3; k++) {
      px[k] = tris[t + k * 3];
      py[k] = tris[t + k * 3 + 1];
      pz[k] = tris[t + k * 3 + 2];
      let dk = pz[k] - z;
      if (dk > -EPS && dk < EPS) dk = EPS;
      d[k] = dk;
      if (dk > 0) pos++;
    }
    if (pos === 0 || pos === 3) continue;

    const hits: Point2D[] = [];
    for (let k = 0; k < 3; k++) {
      const j = (k + 1) % 3;
      if ((d[k] > 0) === (d[j] > 0)) continue;
      const f = d[k] / (d[k] - d[j]);
      hits.push({
        x: (px[k] + (px[j] - px[k]) * f) * 1000,
        y: (py[k] + (py[j] - py[k]) * f) * 1000,
      });
    }
    if (hits.length !== 2) continue;

    // Orient so the interior is on the left: the in-plane part of the outward
    // normal points away from the solid, and rotating it a quarter turn CCW
    // gives the direction to walk. Outer contours then come out CCW, holes CW.
    const ux = px[1] - px[0], uy = py[1] - py[0], uz = pz[1] - pz[0];
    const vx = px[2] - px[0], vy = py[2] - py[0], vz = pz[2] - pz[0];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const dirX = -ny;
    const dirY = nx;

    const solid = solidIds ? solidIds[t / 9] : 0;
    const [h0, h1] = hits;
    if ((h1.x - h0.x) * dirX + (h1.y - h0.y) * dirY >= 0) segs.push({ a: h0, b: h1, solid });
    else segs.push({ a: h1, b: h0, solid });
  }

  return segs;
}

// ---------------------------------------------------------------------------
// Union of overlapping cross-sections
// ---------------------------------------------------------------------------
//
// Two solids that overlap — a roof sitting into a wall, a leg buried in a
// tabletop — each contribute a full closed contour, and the parts of those
// contours running through the other solid are inside the material, not on its
// edge. Cutting them would saw the layer apart along a seam that is not there in
// the model, so they have to go.
//
// Every contour arrives wound with the solid on its left, which makes the union
// boundary easy to state: split each segment wherever another crosses it, then
// keep only the pieces whose *right* side — the side facing out of their own
// solid — is outside every solid, i.e. has winding number zero.

/** Probe distance to the right of an edge when testing what is outside it (mm). */
const UNION_PROBE_MM = 0.005;
const WINDING_BANDS = 128;

/** Bins segments by the horizontal bands they span, for ray casting. */
function bandIndex(segs: Segment[], minY: number, maxY: number) {
  const height = Math.max(maxY - minY, 1e-6);
  const bandH = height / WINDING_BANDS;
  const bands: number[][] = Array.from({ length: WINDING_BANDS }, () => []);
  const bandOf = (y: number) =>
    Math.min(WINDING_BANDS - 1, Math.max(0, Math.floor((y - minY) / bandH)));

  for (let i = 0; i < segs.length; i++) {
    const lo = bandOf(Math.min(segs[i].a.y, segs[i].b.y));
    const hi = bandOf(Math.max(segs[i].a.y, segs[i].b.y));
    for (let b = lo; b <= hi; b++) bands[b].push(i);
  }
  return { bands, bandOf };
}

/**
 * Winding number of `p` with respect to the closed contours in `segs`: how many
 * solids cover it. Crossings are counted along a ray to +x, half-open in y so a
 * ray passing exactly through a vertex is still counted once.
 */
function windingAt(
  p: Point2D,
  segs: Segment[],
  index: ReturnType<typeof bandIndex>
): number {
  let w = 0;
  for (const i of index.bands[index.bandOf(p.y)]) {
    const { a, b } = segs[i];
    const up = a.y <= p.y && b.y > p.y;
    const down = b.y <= p.y && a.y > p.y;
    if (!up && !down) continue;
    const x = a.x + ((p.y - a.y) / (b.y - a.y)) * (b.x - a.x);
    if (x <= p.x) continue;
    w += up ? 1 : -1;
  }
  return w;
}

/**
 * Replaces overlapping cross-sections with the boundary of their union.
 *
 * Returns the segments unchanged when only one solid reaches this height — a
 * single closed solid never overlaps itself, and the split-and-test pass is the
 * expensive part of slicing.
 */
export function unionSegments(segs: Segment[]): Segment[] {
  if (segs.length === 0) return segs;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const solids = new Set<number>();
  for (const s of segs) {
    solids.add(s.solid);
    minX = Math.min(minX, s.a.x, s.b.x);
    maxX = Math.max(maxX, s.a.x, s.b.x);
    minY = Math.min(minY, s.a.y, s.b.y);
    maxY = Math.max(maxY, s.a.y, s.b.y);
  }
  if (solids.size < 2) return segs;

  // Cell size from the model's own scale: big enough that a segment touches only
  // a couple of cells, small enough that a cell holds only a few segments.
  const span = Math.max(maxX - minX, maxY - minY, 1e-6);
  const cell = span / 128;
  const cols = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
  const cellKey = (i: number, j: number) => j * cols + i;
  const grid = new Map<number, number[]>();

  const cellRange = (s: Segment) => ({
    i0: Math.floor((Math.min(s.a.x, s.b.x) - minX) / cell),
    i1: Math.floor((Math.max(s.a.x, s.b.x) - minX) / cell),
    j0: Math.floor((Math.min(s.a.y, s.b.y) - minY) / cell),
    j1: Math.floor((Math.max(s.a.y, s.b.y) - minY) / cell),
  });

  for (let i = 0; i < segs.length; i++) {
    const r = cellRange(segs[i]);
    for (let j = r.j0; j <= r.j1; j++) {
      for (let k = r.i0; k <= r.i1; k++) {
        const key = cellKey(k, j);
        const list = grid.get(key);
        if (list) list.push(i);
        else grid.set(key, [i]);
      }
    }
  }

  // ---- split every segment where another one crosses it ----
  const PARAM_EPS = 1e-9;
  const cuts: number[][] = segs.map(() => []);

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const sx = s.b.x - s.a.x;
    const sy = s.b.y - s.a.y;
    const r = cellRange(s);
    const seen = new Set<number>();

    for (let j = r.j0; j <= r.j1; j++) {
      for (let k = r.i0; k <= r.i1; k++) {
        for (const oi of grid.get(cellKey(k, j)) || []) {
          if (oi === i || seen.has(oi)) continue;
          seen.add(oi);
          const o = segs[oi];
          // Two pieces of the same solid meet only end to end, never across.
          if (o.solid === s.solid) continue;

          const ox = o.b.x - o.a.x;
          const oy = o.b.y - o.a.y;
          const den = sx * oy - sy * ox;

          if (Math.abs(den) < 1e-12) {
            // Parallel. If it is also collinear, the two solids share a stretch
            // of edge, and splitting at the other's endpoints is what lets the
            // duplicate halves be recognised and collapsed further down. Two
            // boxes meeting on a face divide that face differently between their
            // triangles, so without this the copies never line up.
            const sLen2 = sx * sx + sy * sy;
            if (sLen2 < 1e-18) continue;
            const off = Math.abs((o.a.x - s.a.x) * sy - (o.a.y - s.a.y) * sx) / Math.sqrt(sLen2);
            if (off > WELD_MM / 2) continue;
            for (const end of [o.a, o.b]) {
              const t = ((end.x - s.a.x) * sx + (end.y - s.a.y) * sy) / sLen2;
              if (t > PARAM_EPS && t < 1 - PARAM_EPS) cuts[i].push(t);
            }
            continue;
          }

          const dx = o.a.x - s.a.x;
          const dy = o.a.y - s.a.y;
          const t = (dx * oy - dy * ox) / den;
          const u = (dx * sy - dy * sx) / den;
          // `t` strictly interior: an endpoint is already a split. `u` inclusive,
          // so a segment ending on this one still splits it (a T-junction).
          if (t <= PARAM_EPS || t >= 1 - PARAM_EPS) continue;
          if (u < -PARAM_EPS || u > 1 + PARAM_EPS) continue;
          cuts[i].push(t);
        }
      }
    }
  }

  const pieces: Segment[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (cuts[i].length === 0) { pieces.push(s); continue; }
    cuts[i].sort((a, b) => a - b);
    let prev = 0;
    const at = (t: number) => ({ x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t });
    for (const t of [...cuts[i], 1]) {
      if (t - prev > PARAM_EPS) pieces.push({ a: at(prev), b: at(t), solid: s.solid });
      prev = t;
    }
  }

  // ---- keep only the pieces on the outside of every solid ----
  //
  // Two solids flush against each other cancel out here without any special
  // case: each one's outward side is the other's inside, so both faces of the
  // shared wall are dropped, which is right — the union has no edge there.
  // Solids that share an *outer* edge instead (two boxes lined up along one
  // face) leave two copies of the same boundary, and cutting the same line twice
  // scorches it, so identical pieces are collapsed as they are collected.
  const index = bandIndex(segs, minY, maxY);
  const kept: Segment[] = [];
  const midGrid = new Map<string, number[]>();
  const cellOf = (v: number) => Math.floor(v / WELD_MM);

  for (const p of pieces) {
    const dx = p.b.x - p.a.x;
    const dy = p.b.y - p.a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;

    const mid = { x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 };
    // The solid is on the left, so its outside is a step to the right.
    const probe = {
      x: mid.x + (dy / len) * UNION_PROBE_MM,
      y: mid.y - (dx / len) * UNION_PROBE_MM,
    };
    if (windingAt(probe, segs, index) !== 0) continue;

    const ci = cellOf(mid.x);
    const cj = cellOf(mid.y);
    let duplicate = false;
    for (let dj = -1; dj <= 1 && !duplicate; dj++) {
      for (let di = -1; di <= 1 && !duplicate; di++) {
        for (const ki of midGrid.get(`${ci + di}|${cj + dj}`) || []) {
          const q = kept[ki];
          if (Math.hypot(q.a.x - p.a.x, q.a.y - p.a.y) <= WELD_MM &&
              Math.hypot(q.b.x - p.b.x, q.b.y - p.b.y) <= WELD_MM) {
            duplicate = true;
            break;
          }
        }
      }
    }
    if (duplicate) continue;

    const key = `${ci}|${cj}`;
    const list = midGrid.get(key);
    if (list) list.push(kept.length);
    else midGrid.set(key, [kept.length]);
    kept.push(p);
  }

  return kept;
}

/**
 * Chains directed segments into closed contours.
 *
 * Endpoints of neighbouring triangles are computed from the same edge but not
 * always in the same order, so they agree only to rounding, and a split point
 * shared by two pieces agrees only to floating-point noise. Successors are
 * therefore looked up in a bucket grid *and its neighbours*, then accepted on
 * real distance — bucketing alone drops any join that straddles a bucket edge,
 * however close the two points actually are. A chain that runs out of
 * successors is closed anyway: a cut path has to be closed, and the alternative
 * is dropping the contour.
 */
export function chainSegments(segs: Segment[], weldMm: number = WELD_MM): Point2D[][] {
  const cellOf = (v: number) => Math.floor(v / weldMm);
  const key = (i: number, j: number) => `${i}|${j}`;

  const starts = new Map<string, number[]>();
  for (let i = 0; i < segs.length; i++) {
    const k = key(cellOf(segs[i].a.x), cellOf(segs[i].a.y));
    const list = starts.get(k);
    if (list) list.push(i);
    else starts.set(k, [i]);
  }

  const used = new Array<boolean>(segs.length).fill(false);
  const near = (p: Point2D, q: Point2D) => Math.hypot(p.x - q.x, p.y - q.y) <= weldMm;

  /** The nearest unused segment starting at `p`, or -1. */
  const successorOf = (p: Point2D): number => {
    const ci = cellOf(p.x);
    const cj = cellOf(p.y);
    let best = -1;
    let bestDist = Infinity;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        for (const si of starts.get(key(ci + di, cj + dj)) || []) {
          if (used[si]) continue;
          const d = Math.hypot(segs[si].a.x - p.x, segs[si].a.y - p.y);
          if (d <= weldMm && d < bestDist) { bestDist = d; best = si; }
        }
      }
    }
    return best;
  };

  const loops: Point2D[][] = [];

  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;

    const start = segs[i].a;
    const loop: Point2D[] = [start];
    let cur = segs[i].b;

    for (let guard = 0; guard <= segs.length; guard++) {
      if (near(cur, start)) break;
      loop.push(cur);

      const next = successorOf(cur);
      if (next < 0) break;
      used[next] = true;
      cur = segs[next].b;
    }

    if (loop.length >= 3) loops.push(loop);
  }

  return loops;
}

function signedArea(pts: Point2D[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Ramer–Douglas–Peucker on a closed loop, splitting it at two far-apart anchors. */
function simplifyLoop(pts: Point2D[], tolMm: number): Point2D[] {
  if (pts.length <= 4) return pts;

  const perp = (p: Point2D, a: Point2D, b: Point2D) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
    return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
  };

  const keep = new Uint8Array(pts.length);
  const rdp = (first: number, last: number) => {
    if (last <= first + 1) return;
    let worst = -1;
    let worstDist = tolMm;
    for (let i = first + 1; i < last; i++) {
      const dd = perp(pts[i], pts[first], pts[last]);
      if (dd > worstDist) { worstDist = dd; worst = i; }
    }
    if (worst < 0) return;
    keep[worst] = 1;
    rdp(first, worst);
    rdp(worst, last);
  };

  let anchor = 0;
  let best = -1;
  for (let i = 1; i < pts.length; i++) {
    const dd = Math.hypot(pts[i].x - pts[0].x, pts[i].y - pts[0].y);
    if (dd > best) { best = dd; anchor = i; }
  }

  keep[0] = 1;
  keep[anchor] = 1;
  keep[pts.length - 1] = 1;
  rdp(0, anchor);
  rdp(anchor, pts.length - 1);

  const out = pts.filter((_, i) => keep[i]);
  return out.length >= 3 ? out : pts;
}

/**
 * Drops vertices that sit on the line through their neighbours.
 *
 * RDP always keeps the first and last point of the run it is given, so the
 * vertex a contour happens to have been chained from survives even when it is
 * the middle of a straight edge. On a box that leaves a redundant node on one
 * side of every layer; this closes the loop properly.
 */
function dropCollinear(pts: Point2D[], tolMm: number): Point2D[] {
  let current = pts;
  for (let pass = 0; pass < 3; pass++) {
    if (current.length <= 3) break;
    const out: Point2D[] = [];
    for (let i = 0; i < current.length; i++) {
      const prev = out.length ? out[out.length - 1] : current[(i - 1 + current.length) % current.length];
      const curr = current[i];
      const next = current[(i + 1) % current.length];
      const dx = next.x - prev.x;
      const dy = next.y - prev.y;
      const len = Math.hypot(dx, dy);
      const dist = len < 1e-9
        ? Math.hypot(curr.x - prev.x, curr.y - prev.y)
        : Math.abs((curr.x - prev.x) * dy - (curr.y - prev.y) * dx) / len;
      if (dist > tolMm) out.push(curr);
    }
    if (out.length === current.length || out.length < 3) break;
    current = out;
  }
  return current;
}

/** All closed contours of the scene at one height, cleaned up (mm, model frame). */
function contoursAtZ(tris: number[], z: number, solidIds: number[]): Point2D[][] {
  const loops = chainSegments(unionSegments(sliceTrianglesAtZ(tris, z, solidIds)));
  const out: Point2D[][] = [];
  for (const loop of loops) {
    const simplified = dropCollinear(simplifyLoop(loop, SIMPLIFY_MM), SIMPLIFY_MM);
    if (simplified.length < 3) continue;
    if (Math.abs(signedArea(simplified)) < MIN_LOOP_AREA_MM2) continue;
    out.push(simplified);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Alignment pins
// ---------------------------------------------------------------------------
//
// A stack of loose contours is a pile, not a model. Two dowels running the whole
// height fix every layer's position and rotation, but they can only go where
// every layer has material — and far enough inside its edge that the hole does
// not break out. That is a distance-transform question, so each layer is
// rasterised once, the rasters are intersected, and pins are placed at the
// deepest points of what survives.

interface Raster {
  cols: number;
  rows: number;
  step: number;   // mm per cell
  minX: number;
  minY: number;
  cells: Uint8Array;
}

const MAX_RASTER_CELLS = 160;

function makeRasterGrid(minX: number, minY: number, maxX: number, maxY: number): Omit<Raster, 'cells'> {
  const w = Math.max(maxX - minX, 1e-3);
  const h = Math.max(maxY - minY, 1e-3);
  const step = Math.max(w, h) / MAX_RASTER_CELLS;
  return {
    cols: Math.max(1, Math.ceil(w / step)),
    rows: Math.max(1, Math.ceil(h / step)),
    step,
    minX,
    minY,
  };
}

/** Even-odd scanline fill, so nested contours punch holes whatever their winding. */
function rasterizeLoops(loops: Point2D[][], grid: Omit<Raster, 'cells'>): Uint8Array {
  const cells = new Uint8Array(grid.cols * grid.rows);
  const xs: number[] = [];

  for (let j = 0; j < grid.rows; j++) {
    const y = grid.minY + (j + 0.5) * grid.step;
    xs.length = 0;
    for (const loop of loops) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i];
        const b = loop[(i + 1) % loop.length];
        if ((a.y > y) === (b.y > y)) continue;
        xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);

    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - grid.minX) / grid.step - 0.5));
      const i1 = Math.min(grid.cols - 1, Math.floor((xs[k + 1] - grid.minX) / grid.step - 0.5));
      for (let i = i0; i <= i1; i++) cells[j * grid.cols + i] = 1;
    }
  }

  return cells;
}

/**
 * Distance from each filled cell to the nearest empty one, in millimetres.
 * Two-pass chamfer; anything off the grid counts as empty.
 */
function distanceTransform(raster: Raster): Float32Array {
  const { cols, rows, cells, step } = raster;
  const d = new Float32Array(cols * rows);
  const BIG = 1e9;
  for (let i = 0; i < d.length; i++) d[i] = cells[i] ? BIG : 0;

  const at = (i: number, j: number) => (i < 0 || j < 0 || i >= cols || j >= rows ? 0 : d[j * cols + i]);
  const DIAG = Math.SQRT2;

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const idx = j * cols + i;
      if (d[idx] === 0) continue;
      d[idx] = Math.min(
        d[idx],
        at(i - 1, j) + 1, at(i, j - 1) + 1,
        at(i - 1, j - 1) + DIAG, at(i + 1, j - 1) + DIAG
      );
    }
  }
  for (let j = rows - 1; j >= 0; j--) {
    for (let i = cols - 1; i >= 0; i--) {
      const idx = j * cols + i;
      if (d[idx] === 0) continue;
      d[idx] = Math.min(
        d[idx],
        at(i + 1, j) + 1, at(i, j + 1) + 1,
        at(i + 1, j + 1) + DIAG, at(i - 1, j + 1) + DIAG
      );
    }
  }

  // The cell's own half-width is not proven clear, so keep it out of the answer.
  for (let i = 0; i < d.length; i++) d[i] = Math.max(0, (d[i] - 0.5) * step);
  return d;
}

function cellCentre(raster: Omit<Raster, 'cells'>, idx: number): Point2D {
  const i = idx % raster.cols;
  const j = Math.floor(idx / raster.cols);
  return { x: raster.minX + (i + 0.5) * raster.step, y: raster.minY + (j + 0.5) * raster.step };
}

/** The deepest point inside a rasterised layer, for putting an engraved label. */
function deepestPoint(raster: Raster): { pt: Point2D; clearanceMm: number } | null {
  const d = distanceTransform(raster);
  let best = -1;
  let bestIdx = -1;
  for (let i = 0; i < d.length; i++) {
    if (d[i] > best) { best = d[i]; bestIdx = i; }
  }
  return bestIdx < 0 || best <= 0 ? null : { pt: cellCentre(raster, bestIdx), clearanceMm: best };
}

/**
 * Picks up to `count` pin positions that clear every layer's edge by
 * `requiredMm`, spread as far apart as the common region allows — two pins in a
 * line through the middle of a part constrain it far better than two that end up
 * next to each other.
 */
function choosePins(common: Raster, count: number, requiredMm: number): Point2D[] {
  const d = distanceTransform(common);
  const candidates: number[] = [];
  for (let i = 0; i < d.length; i++) if (d[i] >= requiredMm) candidates.push(i);
  if (candidates.length === 0) return [];

  const pins: Point2D[] = [];
  // The first pin goes at the deepest point; each one after it as far from the
  // pins already placed as clearance permits.
  let firstIdx = candidates[0];
  for (const i of candidates) if (d[i] > d[firstIdx]) firstIdx = i;
  pins.push(cellCentre(common, firstIdx));

  while (pins.length < count) {
    let bestIdx = -1;
    let bestScore = -1;
    for (const i of candidates) {
      const p = cellCentre(common, i);
      let nearest = Infinity;
      for (const q of pins) nearest = Math.min(nearest, Math.hypot(p.x - q.x, p.y - q.y));
      // Pins closer together than their own clearance would tear the material
      // between them, and they register no better than one pin would.
      if (nearest < 3 * requiredMm) continue;
      if (nearest > bestScore) { bestScore = nearest; bestIdx = i; }
    }
    if (bestIdx < 0) break;
    pins.push(cellCentre(common, bestIdx));
  }

  return pins;
}

function circleLoop(centre: Point2D, radiusMm: number): Point2D[] {
  const pts: Point2D[] = [];
  // Clockwise, matching the winding this engine gives every other hole.
  for (let k = 0; k < PIN_SEGMENTS; k++) {
    const ang = -(k / PIN_SEGMENTS) * Math.PI * 2;
    pts.push({ x: centre.x + Math.cos(ang) * radiusMm, y: centre.y + Math.sin(ang) * radiusMm });
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] as string
  ));
}

/**
 * Emits contours as SVG paths. Plan-view y runs up and SVG y runs down, so y is
 * negated on the way out — without that every layer, and so the whole assembled
 * stack, comes out mirrored.
 */
function loopsPath(loops: Point2D[][], dx: number, dy: number): string {
  let out = '';
  for (const loop of loops) {
    if (loop.length < 3) continue;
    let d = `M ${(dx + loop[0].x).toFixed(2)} ${(dy - loop[0].y).toFixed(2)}`;
    for (let i = 1; i < loop.length; i++) {
      d += ` L ${(dx + loop[i].x).toFixed(2)} ${(dy - loop[i].y).toFixed(2)}`;
    }
    out += `    <path d="${d} Z" />\n`;
  }
  return out;
}

export function exportContourSliceSvg(
  scene: SceneGraph,
  userOptions?: Partial<ContourSliceOptions>
): ContourSliceResult {
  const options: ContourSliceOptions = { ...DEFAULT_CONTOUR_OPTIONS, ...userOptions };
  const warnings: string[] = [];

  const { tris, solidIds, skipped, warnings: sceneWarnings } = collectSceneTriangles(scene);
  warnings.push(...sceneWarnings);

  if (tris.length === 0) {
    return { success: false, error: 'No solid geometry found in the scene to slice.' };
  }

  let zMin = Infinity;
  let zMax = -Infinity;
  for (let i = 2; i < tris.length; i += 3) {
    if (tris[i] < zMin) zMin = tris[i];
    if (tris[i] > zMax) zMax = tris[i];
  }
  const modelHeight = zMax - zMin;
  const thickness = options.materialThickness;

  if (!(thickness > 0)) {
    return { success: false, error: 'Material thickness must be greater than zero.' };
  }
  if (modelHeight <= 1e-6) {
    return { success: false, error: 'The scene is flat along Z, so there is nothing to slice into layers.' };
  }

  const autoCount = Math.max(1, Math.round(modelHeight / thickness));
  const layerCount = Math.max(1, Math.floor(options.sliceCount ?? autoCount));

  if (layerCount > MAX_LAYERS) {
    return {
      success: false,
      error: `${layerCount} layers at ${(thickness * 1000).toFixed(1)} mm — more than the ${MAX_LAYERS} ` +
        `this export handles. Use thicker stock, or set a layer count.`,
    };
  }

  // Each layer owns an equal share of the model's height, and is sampled at one
  // spot inside its own share. With the layer count left on auto that share is
  // the stock thickness; an override stretches or squeezes it, which is why the
  // assembled stack is reported separately below.
  const step = modelHeight / layerCount;
  const inset = options.slicePosition === 'bottom'
    ? step * 0.02
    : options.slicePosition === 'top'
      ? step * 0.98
      : step * 0.5;

  const layers: ContourLayer[] = [];
  let emptyLayers = 0;

  for (let i = 0; i < layerCount; i++) {
    const z = zMin + i * step + inset;
    const loops = contoursAtZ(tris, z, solidIds);
    if (loops.length === 0) { emptyLayers++; continue; }

    let area = 0;
    let pieces = 0;
    for (const loop of loops) {
      const a = signedArea(loop);
      if (a > 0) { pieces++; area += a; } else area += a;
    }

    layers.push({
      index: i,
      z,
      loops,
      pieceCount: Math.max(1, pieces),
      areaMm2: Math.abs(area),
    });
  }

  if (layers.length === 0) {
    return { success: false, error: 'Slicing produced no closed contours. The geometry may not be a closed solid.' };
  }

  if (emptyLayers > 0) {
    warnings.push(
      `${emptyLayers} layer${emptyLayers === 1 ? '' : 's'} came out empty and ${emptyLayers === 1 ? 'was' : 'were'} ` +
      `dropped — usually the very top of a dome or a gap in the model.`
    );
  }

  // A part with a constant cross-section — a post, a rod, a straight column —
  // slices into a run of layers that are all the same shape. That is what the
  // model says, but it is worth naming: cutting one and repeating it beats
  // nesting ninety copies, and it is usually the sign that a part wanted to be
  // left out of the stack altogether.
  {
    let runStart = 0;
    let longest = { start: 0, length: 1 };
    for (let i = 1; i <= layers.length; i++) {
      const same =
        i < layers.length &&
        layers[i].pieceCount === layers[i - 1].pieceCount &&
        Math.abs(layers[i].areaMm2 - layers[i - 1].areaMm2) <= 0.01 * Math.max(layers[i].areaMm2, 1);
      if (same) continue;
      if (i - runStart > longest.length) longest = { start: runStart, length: i - runStart };
      runStart = i;
    }
    if (longest.length >= 8) {
      const first = layers[longest.start].index + 1;
      const last = layers[longest.start + longest.length - 1].index + 1;
      warnings.push(
        `Layers ${first}–${last} are ${longest.length} copies of the same cross-section — something in ` +
        `the model has a constant profile over ${(longest.length * step * 1000).toFixed(0)} mm. Cut one and ` +
        `repeat it rather than nesting every copy, or leave that part out of the slice.`
      );
    }
  }

  const multiPiece = layers.filter(l => l.pieceCount > 1);
  if (multiPiece.length > 0) {
    warnings.push(
      `${multiPiece.length} layer${multiPiece.length === 1 ? '' : 's'} fall into separate pieces ` +
      `(e.g. layer ${multiPiece[0].index + 1}, ${multiPiece[0].pieceCount} pieces). Each piece is cut, but only ` +
      `pieces the dowels pass through are located by them.`
    );
  }

  // ---- model-space bounds, shared by the pin search and the map preview ----
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const layer of layers) {
    for (const loop of layer.loops) {
      for (const p of loop) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    }
  }

  const grid = makeRasterGrid(minX, minY, maxX, maxY);
  const rasters = layers.map(l => ({ ...grid, cells: rasterizeLoops(l.loops, grid) } as Raster));

  // ---- alignment pins ----
  const pins: { x: number; y: number; radiusMm: number }[] = [];
  if (options.pinHoles && options.pinCount > 0) {
    const pinRadiusMm = (options.pinDiameter * 1000) / 2;
    // Enough material has to survive around a dowel for the layer not to break
    // out at the hole; one dowel diameter of wall is the usual rule of thumb.
    const requiredMm = pinRadiusMm * 2 + 0.5;

    const commonCells = new Uint8Array(grid.cols * grid.rows).fill(1);
    for (const r of rasters) {
      for (let i = 0; i < commonCells.length; i++) if (!r.cells[i]) commonCells[i] = 0;
    }

    // A hole cut on its nominal line comes out a kerf wider than the dowel.
    const cutRadiusMm = Math.max(0.1, pinRadiusMm - (options.kerf * 1000) / 2);
    const placed = choosePins({ ...grid, cells: commonCells }, options.pinCount, requiredMm);
    for (const p of placed) pins.push({ x: p.x, y: p.y, radiusMm: cutRadiusMm });

    if (placed.length === 0) {
      warnings.push(
        `No dowel position clears every layer's edge by ${requiredMm.toFixed(1)} mm, so the layers are cut ` +
        `without alignment holes — the model has at least one layer too small or too narrow to take this ` +
        `dowel. Glue up against the printed layer map instead, or set Dowels to None if that was the plan; ` +
        `a thinner dowel may also fit.`
      );
    } else if (placed.length < options.pinCount) {
      warnings.push(
        `Only ${placed.length} of ${options.pinCount} dowel holes fit; the layers can still rotate about a ` +
        `single pin, so check the alignment as you glue up.`
      );
    }

    for (const layer of layers) {
      for (const pin of pins) layer.loops.push(circleLoop({ x: pin.x, y: pin.y }, pin.radiusMm));
    }
  }

  // ---- label anchors ----
  if (options.includeLabels) {
    for (let i = 0; i < layers.length; i++) {
      const deep = deepestPoint(rasters[i]);
      // Below this the number is bigger than the material it is engraved on.
      if (deep && deep.clearanceMm >= 3) layers[i].labelPos2D = deep.pt;
    }
  }

  // ---- nest onto sheets ----
  const sheetWidthMm = options.sheetWidth * 1000;
  const sheetHeightMm = options.sheetHeight * 1000;
  const marginMm = options.margin * 1000;
  const maxSheets = options.maxSheets && options.maxSheets > 0 ? options.maxSheets : 0;

  let scaleFactor = Math.max(0.05, Math.min(2.0, options.scaleFactor ?? 1.0));

  if (options.autoScale || maxSheets > 0) {
    const evaluateScale = (s: number): { sheetCount: number; fitSingleSheet: boolean } => {
      let currentX = marginMm;
      let currentY = marginMm;
      let rowHeight = 0;
      let sheetIndex = 0;
      let fitSingleSheet = true;

      for (const layer of layers) {
        let lminX = Infinity, lminY = Infinity, lmaxX = -Infinity, lmaxY = -Infinity;
        for (const loop of layer.loops) {
          for (const p of loop) {
            const sx = p.x * s, sy = p.y * s;
            if (sx < lminX) lminX = sx; if (sx > lmaxX) lmaxX = sx;
            if (sy < lminY) lminY = sy; if (sy > lmaxY) lmaxY = sy;
          }
        }
        const w = Math.max(1, lmaxX - lminX);
        const h = Math.max(1, lmaxY - lminY);

        if (w + 2 * marginMm > sheetWidthMm || h + 2 * marginMm > sheetHeightMm) {
          fitSingleSheet = false;
        }
        if (currentX + w + marginMm > sheetWidthMm) {
          currentX = marginMm;
          currentY += rowHeight + marginMm;
          rowHeight = 0;
        }
        if (currentY + h + marginMm > sheetHeightMm) {
          sheetIndex++;
          currentX = marginMm;
          currentY = marginMm;
          rowHeight = 0;
        }
        currentX += w + marginMm;
        if (h > rowHeight) rowHeight = h;
      }
      return { sheetCount: sheetIndex + 1, fitSingleSheet };
    };

    let bestScale = scaleFactor;
    const startScale = options.autoScale ? 1.0 : scaleFactor;
    for (let s = startScale; s >= 0.05; s = Math.round((s - 0.01) * 100) / 100) {
      const res = evaluateScale(s);
      if (res.fitSingleSheet && (maxSheets === 0 || res.sheetCount <= maxSheets)) {
        bestScale = s;
        break;
      }
      bestScale = s;
    }
    scaleFactor = bestScale;
  }

  // Apply scaleFactor to layer loops
  if (Math.abs(scaleFactor - 1.0) > 1e-4) {
    for (const layer of layers) {
      for (const loop of layer.loops) {
        for (const p of loop) {
          p.x *= scaleFactor;
          p.y *= scaleFactor;
        }
      }
    }
    for (const pin of pins) {
      pin.x *= scaleFactor;
      pin.y *= scaleFactor;
      pin.radiusMm *= scaleFactor;
    }
  }

  for (const layer of layers) {
    let lminX = Infinity, lminY = Infinity, lmaxX = -Infinity, lmaxY = -Infinity;
    for (const loop of layer.loops) {
      for (const p of loop) {
        if (p.x < lminX) lminX = p.x;
        if (p.x > lmaxX) lmaxX = p.x;
        if (p.y < lminY) lminY = p.y;
        if (p.y > lmaxY) lmaxY = p.y;
      }
    }
    layer.width2D = lmaxX - lminX;
    layer.height2D = lmaxY - lminY;
    layer.modelOffset2D = { x: lminX, y: lmaxY };
  }

  let currentX = marginMm;
  let currentY = marginMm;
  let rowHeight = 0;
  let sheetIndex = 0;
  const oversized: string[] = [];

  for (const layer of layers) {
    const w = layer.width2D || 1;
    const h = layer.height2D || 1;

    if (w + 2 * marginMm > sheetWidthMm || h + 2 * marginMm > sheetHeightMm) {
      oversized.push(`layer ${layer.index + 1}`);
    }
    if (currentX + w + marginMm > sheetWidthMm) {
      currentX = marginMm;
      currentY += rowHeight + marginMm;
      rowHeight = 0;
    }
    if (currentY + h + marginMm > sheetHeightMm) {
      sheetIndex++;
      currentX = marginMm;
      currentY = marginMm;
      rowHeight = 0;
    }

    layer.placedPos2D = { x: currentX, y: currentY + sheetIndex * sheetHeightMm };
    currentX += w + marginMm;
    if (h > rowHeight) rowHeight = h;
  }

  const sheetCount = sheetIndex + 1;

  if (Math.abs(scaleFactor - 1.0) > 1e-3) {
    warnings.unshift(
      `Slices scaled to ${(scaleFactor * 100).toFixed(0)}% (${scaleFactor.toFixed(2)}x) to fit ${sheetWidthMm.toFixed(0)} x ${sheetHeightMm.toFixed(0)} mm sheet bounds${maxSheets > 0 ? ` (limited to ${maxSheets} sheet${maxSheets === 1 ? '' : 's'})` : ''}.`
    );
  } else if (oversized.length > 0) {
    warnings.push(
      `Too big for a ${sheetWidthMm.toFixed(0)} x ${sheetHeightMm.toFixed(0)} mm sheet: ` +
      `${oversized.slice(0, 6).join(', ')}${oversized.length > 6 ? ` and ${oversized.length - 6} more` : ''}. ` +
      `Enable Auto Scale to shrink them onto sheets.`
    );
  }

  const stackHeight = layers.length * thickness;
  if (Math.abs(stackHeight - modelHeight) > Math.max(thickness, modelHeight * 0.02)) {
    warnings.push(
      `${layers.length} layers of ${(thickness * 1000).toFixed(1)} mm stack up to ` +
      `${(stackHeight * 1000).toFixed(0)} mm, but the model is ${(modelHeight * 1000).toFixed(0)} mm tall. ` +
      `Leave the layer count on auto to build it at true height.`
    );
  }

  // ---- cut sheets ----
  const totalWidth = sheetWidthMm;
  const totalHeight = sheetHeightMm * sheetCount;

  let svg = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n`;
  svg += `<svg width="${totalWidth}mm" height="${totalHeight}mm" viewBox="0 0 ${totalWidth} ${totalHeight}" xmlns="http://www.w3.org/2000/svg">\n`;
  svg += `  <!-- Generated by PhysBox Contour Slice Engine -->\n`;
  svg += `  <!-- Settings: Layers=${layers.length}, Thickness=${(thickness * 1000).toFixed(1)}mm, ` +
    `Sample=${options.slicePosition}, Kerf=${(options.kerf * 1000).toFixed(2)}mm, ` +
    `Scale=${(scaleFactor * 100).toFixed(0)}%, Pins=${pins.length ? `${pins.length} x ${(options.pinDiameter * 1000).toFixed(1)}mm` : 'none'} -->\n\n`;

  if (options.includeSheetOutline) {
    for (let s = 0; s < sheetCount; s++) {
      const sheetY = s * sheetHeightMm;
      svg += `  <rect x="0" y="${sheetY}" width="${sheetWidthMm}" height="${sheetHeightMm}" fill="none" stroke="#94A3B8" stroke-width="0.5" stroke-dasharray="4 4" />\n`;
      if (options.includeLabels) {
        svg += `  <text x="10" y="${sheetY + 20}" fill="#64748B" font-family="sans-serif" font-size="12" font-weight="bold">Sheet ${s + 1} (${sheetWidthMm}mm x ${sheetHeightMm}mm${scaleFactor !== 1 ? ` @ ${(scaleFactor * 100).toFixed(0)}% scale` : ''})</text>\n`;
      }
    }
    svg += `\n`;
  }

  svg += `  <g id="cut-paths" stroke="#FF0000" stroke-width="0.2" fill="none" stroke-linejoin="round" stroke-linecap="round">\n`;
  for (const layer of layers) {
    const pos = layer.placedPos2D!;
    const off = layer.modelOffset2D!;
    svg += loopsPath(layer.loops, pos.x - off.x, pos.y + off.y);
  }
  svg += `  </g>\n\n`;

  if (options.includeLabels) {
    svg += `  <g id="engrave-labels" fill="#0000FF" font-family="sans-serif" font-size="8" text-anchor="middle">\n`;
    for (const layer of layers) {
      const anchor = layer.labelPos2D;
      if (!anchor) continue;
      const pos = layer.placedPos2D!;
      const off = layer.modelOffset2D!;
      const x = pos.x - off.x + anchor.x * scaleFactor;
      const y = pos.y + off.y - anchor.y * scaleFactor;
      svg += `    <text x="${x.toFixed(2)}" y="${y.toFixed(2)}">${escapeXml(String(layer.index + 1))}</text>\n`;
    }
    svg += `  </g>\n`;
  }

  svg += `</svg>`;

  // ---- relief map preview: every contour where it actually sits ----
  const pad = 6;
  const mapW = Math.max(maxX - minX, 1) + pad * 2;
  const mapH = Math.max(maxY - minY, 1) + pad * 2;

  let mapSvg = `<svg width="100%" viewBox="${(minX - pad).toFixed(2)} ${(-maxY - pad).toFixed(2)} ${mapW.toFixed(2)} ${mapH.toFixed(2)}" xmlns="http://www.w3.org/2000/svg">\n`;
  mapSvg += `  <g fill="none" stroke-width="${(Math.max(mapW, mapH) / 400).toFixed(3)}" stroke-linejoin="round">\n`;
  for (const layer of layers) {
    const t = layers.length > 1 ? layer.index / (layers.length - 1) : 1;
    const hue = 210 - 190 * t;
    mapSvg += `    <g stroke="hsl(${hue.toFixed(0)}, 85%, ${(45 + 20 * t).toFixed(0)}%)">\n`;
    mapSvg += loopsPath(layer.loops, 0, 0);
    mapSvg += `    </g>\n`;
  }
  mapSvg += `  </g>\n</svg>`;

  if (skipped.length > 0) {
    warnings.unshift(`Skipped geometry with no volume to slice: ${skipped.join(', ')}.`);
  }

  return {
    success: true,
    svg,
    mapSvg,
    layers,
    sheetCount,
    modelHeight,
    stackHeight,
    pins,
    scaleFactor,
    warnings,
  };
}
