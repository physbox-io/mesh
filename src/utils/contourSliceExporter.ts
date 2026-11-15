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
  type Point2D,
} from './laserCutExporter';
import { appendGeomTriangles } from './geomSurface';
import { nestingDepths, offsetLoop } from './polygonOffset';
import { dropCollinear, simplifyLoop } from './loopSimplify';
import type { StockTransform } from './reliefCarveExporter';
import { isBoughtIn } from './boughtIn';
import { SHEET_MARGIN } from './sheetCutRecipe';

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
  /** Distance the cutter's outer edge stands outside each slice outline, in meters (bitDiameter on CNC, 0 on laser). */
  cutOutset?: number;
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
  margin: SHEET_MARGIN,
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
  /** Uncompensated closed contours in millimetres (before laser kerf offset), for true-size simulation. */
  nominalLoops?: Point2D[][];
  /** How many separate pieces this layer falls into. */
  pieceCount: number;
  /** Cut area in mm², holes excluded. */
  areaMm2: number;
  /**
   * How thick this layer finishes, mm, when that is less than a sheet: the top
   * layer, whose band stops at the model's top. A router faces a full sheet
   * down to it before cutting the profile, so the stack finishes at the
   * model's height. Absent for a full sheet.
   */
  facedToMm?: number;
  /** Where the engraved layer number goes on the primary island, in the same frame as `loops`. */
  labelPos2D?: Point2D;
  /** Engraved layer number anchors for every solid island large enough to hold one, primary island first. */
  labelPositions2D?: Point2D[];
  /**
   * The layer's model-space corner that lands on `placedPos2D`: its minimum x,
   * and its *maximum* y, because plan-view y runs up and SVG y runs down.
   */
  modelOffset2D?: Point2D;
  /** Which sheet the layer is cut from, 0 first. */
  sheetIndex?: number;
  /** Where the layer sits on its own sheet, mm from that sheet's corner. */
  placedPos2D?: Point2D;
  width2D?: number;
  height2D?: number;
}

export interface ContourSliceResult {
  success: boolean;
  /** Layers short of a margin on both sides of their sheet. */
  oversized?: string[];
  /** Layers that run past the far edge of the sheet, placed one margin in. They must not be cut. */
  offSheet?: string[];
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
  /**
   * How the stack stands for the model: layer i is cut in the plan's scaled
   * millimetres and stacked at i sheet thicknesses up, while it stands for
   * the i-th share of the model's height.
   */
  stockTransform?: StockTransform;
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

const sceneTrianglesCache = new WeakMap<
  SceneGraph,
  { tris: number[]; solidIds: number[]; solidNames: string[]; skipped: string[]; warnings: string[] }
>();

/** Said when a body's holes have never been evaluated: its cutters are dropped, so the solid is cut whole. */
export function uncompiledCsgWarning(node: SceneNode): string | null {
  return node.csgEnabled &&
    (node.geoms || []).some(g => g.csg === 'difference') &&
    !(node.geoms || []).some(g => g.csgDerived === 'visual')
    ? `${node.name}: CSG has not been compiled, so its holes are not cut.`
    : null;
}

export function collectSceneTriangles(scene: SceneGraph): {
  tris: number[];
  /** Which solid each triangle came from, one entry per triangle. */
  solidIds: number[];
  /** The body each solid belongs to, indexed by solid id. */
  solidNames: string[];
  skipped: string[];
  warnings: string[];
} {
  const cached = sceneTrianglesCache.get(scene);
  if (cached) {
    return {
      tris: cached.tris,
      solidIds: cached.solidIds,
      solidNames: cached.solidNames,
      skipped: [...cached.skipped],
      warnings: [...cached.warnings],
    };
  }
  const tris: number[] = [];
  const solidIds: number[] = [];
  const solidNames: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  let solid = 0;

  const traverse = (node: SceneNode, parentMatrix?: THREE.Matrix4) => {
    // What a program will leave is not part of what it is planned from.
    if (node.simulation) {
      warnings.push(`${node.name}: a simulated cut, so it is left out.`);
      return;
    }
    const bodyMatrix = getNodeWorldTransform(node, parentMatrix);
    // Bought, not made: a bearing in a pocket is not part of what is cut or
    // printed. What is fixed to it may well be, so its children still are.
    if (isBoughtIn(node)) {
      for (const child of node.children || []) traverse(child, bodyMatrix);
      return;
    }

    // A body whose holes have never been evaluated still lists its cutters as
    // authored geoms, and resolveCsgGeoms drops them. Slicing the un-subtracted
    // solid silently would hand back layers with no holes in them, so say so.
    const uncompiled = uncompiledCsgWarning(node);
    if (uncompiled) warnings.push(uncompiled);

    for (const geom of resolveCsgGeoms(node, 'render')) {
      if (geom.role === 'collision') continue;
      const before = tris.length;
      if (!appendSolidTriangles(geom, bodyMatrix, tris)) {
        skipped.push(`${node.name} (${geom.name || geom.type})`);
        continue;
      }
      if (geom.type === 'mesh') {
        // An imported or boolean-merged mesh often packs several overlapping
        // shells into one geom; giving each vertex-connected shell its own
        // solid id lets `unionSegments` dissolve internal overlap seams.
        const { shellIds, shellCount } = splitMeshShells(tris, before, tris.length);
        for (let i = 0; i < shellIds.length; i++) solidIds.push(solid + shellIds[i]);
        for (let s = 0; s < shellCount; s++) solidNames.push(node.name);
        solid += shellCount;
      } else {
        const added = (tris.length - before) / 9;
        for (let i = 0; i < added; i++) solidIds.push(solid);
        solidNames.push(node.name);
        solid++;
      }
    }

    for (const child of node.children || []) traverse(child, bodyMatrix);
  };

  for (const root of scene.nodes) traverse(root);
  const result = { tris, solidIds, solidNames, skipped, warnings };
  sceneTrianglesCache.set(scene, result);
  return {
    tris,
    solidIds,
    solidNames,
    skipped: [...skipped],
    warnings: [...warnings],
  };
}

/**
 * Appends one geom's triangles, placed by its body's world matrix and wound
 * outward. Returns false for shapes with no volume, and appends nothing then.
 */
export function appendSolidTriangles(geom: SceneGeom, bodyMatrix: THREE.Matrix4, out: number[]): boolean {
  const frame = getGeomFrame(geom);
  const matrix = new THREE.Matrix4().multiplyMatrices(bodyMatrix, frame.matrix);
  const before = out.length;
  if (!appendGeomTriangles(geom, frame.halfLen, matrix, out)) {
    out.length = before;
    return false;
  }
  // Slicing reads winding to decide which side of a contour is material, so
  // an inside-out mesh yields segments that all get unioned away and the
  // export reports no closed contours. Mesh data is not always wound the way
  // a renderer's double-sided material lets it get away with, so flip a
  // solid that encloses negative volume rather than losing it.
  if (signedVolume(out, before, out.length) < 0) flipWinding(out, before, out.length);
  return true;
}

/**
 * Splits a run of triangles into 3D vertex-connected shells (welded to 1 µm) so
 * multi-shell meshes carried inside a single `SceneGeom` get distinct solid IDs.
 */
function splitMeshShells(tris: number[], from: number, to: number): { shellIds: number[]; shellCount: number } {
  const count = (to - from) / 9;
  if (count <= 1) return { shellIds: count === 1 ? [0] : [], shellCount: count };

  const parent = new Int32Array(count);
  for (let i = 0; i < count; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const next = parent[x];
      parent[x] = r;
      x = next;
    }
    return r;
  };

  const vertOwner = new Map<string, number>();
  for (let t = 0; t < count; t++) {
    const base = from + t * 9;
    for (let k = 0; k < 3; k++) {
      const key = `${Math.round(tris[base + k * 3] * 1e6)}|${Math.round(tris[base + k * 3 + 1] * 1e6)}|${Math.round(tris[base + k * 3 + 2] * 1e6)}`;
      const prev = vertOwner.get(key);
      if (prev === undefined) {
        vertOwner.set(key, t);
      } else {
        const ra = find(t);
        const rb = find(prev);
        if (ra !== rb) parent[ra] = rb;
      }
    }
  }

  const rootToShell = new Map<number, number>();
  const shellIds = new Array<number>(count);
  let shellCount = 0;
  for (let t = 0; t < count; t++) {
    const r = find(t);
    let s = rootToShell.get(r);
    if (s === undefined) {
      s = shellCount++;
      rootToShell.set(r, s);
    }
    shellIds[t] = s;
  }
  return { shellIds, shellCount };
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

function sharesSegmentEndpoint(s: Segment, o: Segment, tolMm: number): boolean {
  return (
    Math.hypot(s.a.x - o.a.x, s.a.y - o.a.y) <= tolMm ||
    Math.hypot(s.a.x - o.b.x, s.a.y - o.b.y) <= tolMm ||
    Math.hypot(s.b.x - o.a.x, s.b.y - o.a.y) <= tolMm ||
    Math.hypot(s.b.x - o.b.x, s.b.y - o.b.y) <= tolMm
  );
}

function hasOpenEndpoints(segs: Segment[], weldMm: number): boolean {
  const cellOf = (v: number) => Math.floor(v / weldMm);
  const starts = new Map<string, number[]>();
  for (let i = 0; i < segs.length; i++) {
    const k = `${cellOf(segs[i].a.x)}|${cellOf(segs[i].a.y)}`;
    const list = starts.get(k);
    if (list) list.push(i);
    else starts.set(k, [i]);
  }
  for (let i = 0; i < segs.length; i++) {
    const p = segs[i].b;
    const ci = cellOf(p.x);
    const cj = cellOf(p.y);
    let matched = false;
    for (let dj = -1; dj <= 1 && !matched; dj++) {
      for (let di = -1; di <= 1 && !matched; di++) {
        for (const si of starts.get(`${ci + di}|${cj + dj}`) || []) {
          if (si === i) continue;
          if (Math.hypot(segs[si].a.x - p.x, segs[si].a.y - p.y) <= weldMm) {
            matched = true;
            break;
          }
        }
      }
    }
    if (!matched) return true;
  }
  return false;
}

/**
 * Replaces overlapping cross-sections with the boundary of their union,
 * including self-overlapping or multi-shell contours carried under one solid id.
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
  let totalCuts = 0;

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
          // Adjacent edges of the same contour meet at a shared vertex; non-adjacent
          // edges of the same solid are still checked so self-overlapping shells union.
          if (o.solid === s.solid && sharesSegmentEndpoint(s, o, WELD_MM)) continue;

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
              if (t > PARAM_EPS && t < 1 - PARAM_EPS) {
                cuts[i].push(t);
                totalCuts++;
              }
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
          totalCuts++;
        }
      }
    }
  }

  // Leave uncrossed open chains of a single solid intact so `chainSegments`
  // can bridge the non-manifold crack instead of ray-casting through an open gap.
  if (solids.size < 2 && totalCuts === 0 && hasOpenEndpoints(segs, WELD_MM)) {
    return segs;
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

export interface ChainStats {
  openChainsClosed: number;
  maxGapMm: number;
}

/**
 * Chains directed segments into closed contours.
 *
 * Endpoints of neighbouring triangles are computed from the same edge but not
 * always in the same order, so they agree only to rounding, and a split point
 * shared by two pieces agrees only to floating-point noise. Successors and
 * predecessors are looked up in a bucket grid *and its neighbours*, then
 * accepted on real distance. A chain that still has a gap at its ends is closed
 * across that gap and recorded in `stats` so the caller can warn about
 * non-manifold / open mesh geometry.
 */
export function chainSegments(segs: Segment[], weldMm: number = WELD_MM, stats?: ChainStats): Point2D[][] {
  const cellOf = (v: number) => Math.floor(v / weldMm);
  const key = (i: number, j: number) => `${i}|${j}`;

  const starts = new Map<string, number[]>();
  const ends = new Map<string, number[]>();
  for (let i = 0; i < segs.length; i++) {
    const ks = key(cellOf(segs[i].a.x), cellOf(segs[i].a.y));
    const sList = starts.get(ks);
    if (sList) sList.push(i);
    else starts.set(ks, [i]);

    const ke = key(cellOf(segs[i].b.x), cellOf(segs[i].b.y));
    const eList = ends.get(ke);
    if (eList) eList.push(i);
    else ends.set(ke, [i]);
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

  /** The nearest unused segment ending at `p`, or -1. */
  const predecessorOf = (p: Point2D): number => {
    const ci = cellOf(p.x);
    const cj = cellOf(p.y);
    let best = -1;
    let bestDist = Infinity;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        for (const si of ends.get(key(ci + di, cj + dj)) || []) {
          if (used[si]) continue;
          const d = Math.hypot(segs[si].b.x - p.x, segs[si].b.y - p.y);
          if (d <= weldMm && d < bestDist) { bestDist = d; best = si; }
        }
      }
    }
    return best;
  };

  const loops: Point2D[][] = [];
  const gapWarnThreshold = Math.max(weldMm * 2, 0.05);

  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;

    let headPt = segs[i].a;
    const loop: Point2D[] = [headPt];
    let tailPt = segs[i].b;

    for (let guard = 0; guard <= segs.length; guard++) {
      if (near(tailPt, headPt)) break;
      loop.push(tailPt);

      const next = successorOf(tailPt);
      if (next < 0) break;
      used[next] = true;
      tailPt = segs[next].b;
    }

    if (!near(tailPt, headPt)) {
      const prefix: Point2D[] = [];
      for (let guard = 0; guard <= segs.length; guard++) {
        const prev = predecessorOf(headPt);
        if (prev < 0) break;
        used[prev] = true;
        headPt = segs[prev].a;
        if (near(tailPt, headPt)) {
          // Closed from behind: `tailPt` is already at the end of `loop` and matches `headPt`.
          break;
        }
        prefix.push(headPt);
      }
      if (prefix.length > 0) {
        prefix.reverse();
        loop.unshift(...prefix);
      }
      if (near(tailPt, headPt) && loop.length > 1) {
        // Avoid duplicating the closing vertex when backward walk closed onto `tailPt`.
        loop.unshift(headPt);
        loop.pop();
      }
    }

    const gapMm = Math.hypot(tailPt.x - headPt.x, tailPt.y - headPt.y);
    if (loop.length >= 3) {
      if (stats && gapMm > gapWarnThreshold && Math.abs(signedArea(loop)) >= MIN_LOOP_AREA_MM2) {
        stats.openChainsClosed++;
        if (gapMm > stats.maxGapMm) stats.maxGapMm = gapMm;
      }
      loops.push(loop);
    }
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

/** All closed contours of the scene at one height, cleaned up (mm, model frame). */
export function contoursAtZ(tris: number[], z: number, solidIds: number[], stats?: ChainStats): Point2D[][] {
  const loops = chainSegments(unionSegments(sliceTrianglesAtZ(tris, z, solidIds)), WELD_MM, stats);
  const out: Point2D[][] = [];
  for (const loop of loops) {
    const simplified = dropCollinear(simplifyLoop(loop, SIMPLIFY_MM), SIMPLIFY_MM);
    if (simplified.length < 3) continue;
    if (Math.abs(signedArea(simplified)) < MIN_LOOP_AREA_MM2) continue;
    out.push(simplified);
  }
  if (out.length > 0) {
    const depths = nestingDepths(out);
    for (let i = 0; i < out.length; i++) {
      const wantCcw = depths[i] % 2 === 0;
      const isCcw = signedArea(out[i]) > 0;
      if (wantCcw !== isCcw) out[i].reverse();
    }
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

interface RasterGrid {
  cols: number;
  rows: number;
  step: number;   // mm per cell
  minX: number;
  minY: number;
}

const MAX_RASTER_CELLS = 320;
const MAX_ISLAND_LABEL_CELLS = 160;

function makeRasterGrid(minX: number, minY: number, maxX: number, maxY: number, maxCells = MAX_RASTER_CELLS): RasterGrid {
  const w = Math.max(maxX - minX, 1e-3);
  const h = Math.max(maxY - minY, 1e-3);
  const step = Math.max(w, h) / maxCells;
  return {
    cols: Math.max(1, Math.ceil(w / step)),
    rows: Math.max(1, Math.ceil(h / step)),
    step,
    minX,
    minY,
  };
}

function pointToSegmentDist(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-18) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function minDistToLoops(p: Point2D, loops: Point2D[][]): number {
  let best = Infinity;
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const d = pointToSegmentDist(p, loop[i], loop[(i + 1) % loop.length]);
      if (d < best) best = d;
    }
  }
  return best;
}

function pointInLoop(p: Point2D, loop: Point2D[]): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i];
    const b = loop[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function isInsideLayer(p: Point2D, loops: Point2D[][]): boolean {
  let count = 0;
  for (const loop of loops) {
    if (pointInLoop(p, loop)) count++;
  }
  return count % 2 === 1;
}

/** Even-odd scanline fill, so nested contours punch holes whatever their winding. */
function rasterizeLoops(loops: Point2D[][], grid: RasterGrid): Uint8Array {
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

function cellCentre(grid: RasterGrid, idx: number): Point2D {
  const i = idx % grid.cols;
  const j = Math.floor(idx / grid.cols);
  return { x: grid.minX + (i + 0.5) * grid.step, y: grid.minY + (j + 0.5) * grid.step };
}

/**
 * Distance from each interior cell centre to the nearest contour or hole edge,
 * in millimetres. Every boundary segment (including sub-cell bolt holes and
 * slits that fall between scanlines) is stamped with exact point-to-segment
 * distance before the two-pass chamfer sweep propagates it across the grid.
 */
function clearanceField(loops: Point2D[][], grid: RasterGrid): Float32Array {
  const { cols, rows, step } = grid;
  const cells = rasterizeLoops(loops, grid);
  const d = new Float32Array(cols * rows);
  const BIG = 1e9;
  for (let i = 0; i < d.length; i++) d[i] = cells[i] ? BIG : 0;

  // Clear any cell centre sitting inside a sub-cell loop that fell between
  // scanlines, and stamp exact point-to-segment distances along every edge.
  for (const loop of loops) {
    let lMinX = Infinity, lMaxX = -Infinity, lMinY = Infinity, lMaxY = -Infinity;
    for (const p of loop) {
      if (p.x < lMinX) lMinX = p.x;
      if (p.x > lMaxX) lMaxX = p.x;
      if (p.y < lMinY) lMinY = p.y;
      if (p.y > lMaxY) lMaxY = p.y;
    }
    if (lMaxY - lMinY < step * 1.5) {
      const ci0 = Math.max(0, Math.floor((lMinX - grid.minX) / step));
      const ci1 = Math.min(cols - 1, Math.ceil((lMaxX - grid.minX) / step));
      const cj0 = Math.max(0, Math.floor((lMinY - grid.minY) / step));
      const cj1 = Math.min(rows - 1, Math.ceil((lMaxY - grid.minY) / step));
      for (let j = cj0; j <= cj1; j++) {
        for (let i = ci0; i <= ci1; i++) {
          const idx = j * cols + i;
          if (d[idx] === 0) continue;
          const centre = { x: grid.minX + (i + 0.5) * step, y: grid.minY + (j + 0.5) * step };
          if (!isInsideLayer(centre, loops)) d[idx] = 0;
        }
      }
    }

    for (let k = 0; k < loop.length; k++) {
      const a = loop[k];
      const b = loop[(k + 1) % loop.length];
      const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - grid.minX) / step) - 1);
      const i1 = Math.min(cols - 1, Math.ceil((Math.max(a.x, b.x) - grid.minX) / step) + 1);
      const j0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - grid.minY) / step) - 1);
      const j1 = Math.min(rows - 1, Math.ceil((Math.max(a.y, b.y) - grid.minY) / step) + 1);
      for (let j = j0; j <= j1; j++) {
        const y = grid.minY + (j + 0.5) * step;
        for (let i = i0; i <= i1; i++) {
          const idx = j * cols + i;
          if (d[idx] === 0) continue;
          const exactCells = pointToSegmentDist({ x: grid.minX + (i + 0.5) * step, y }, a, b) / step;
          if (exactCells < d[idx]) d[idx] = exactCells;
        }
      }
    }
  }

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

  for (let i = 0; i < d.length; i++) d[i] = Math.max(0, d[i] * step);
  return d;
}

/** Decomposes a layer's loops into independent solid islands (even-depth outer + direct odd-depth holes), largest first. */
function extractSolidIslands(loops: Point2D[][]): { loops: Point2D[][]; areaMm2: number }[] {
  const valid = loops.filter((l) => l.length >= 3);
  if (valid.length === 0) return [];
  const depths = nestingDepths(valid);
  const islands: { loops: Point2D[][]; areaMm2: number }[] = [];

  for (let i = 0; i < valid.length; i++) {
    if (depths[i] % 2 !== 0) continue;
    const outer = valid[i];
    const islandLoops: Point2D[][] = [outer];
    let area = Math.abs(signedArea(outer));
    for (let j = 0; j < valid.length; j++) {
      if (depths[j] !== depths[i] + 1) continue;
      if (pointInLoop(valid[j][0], outer)) {
        islandLoops.push(valid[j]);
        area -= Math.abs(signedArea(valid[j]));
      }
    }
    islands.push({ loops: islandLoops, areaMm2: Math.max(0, area) });
  }

  islands.sort((a, b) => b.areaMm2 - a.areaMm2);
  return islands;
}

/** The deepest point inside one solid island (including its dowel holes), verified analytically. */
function deepestIslandPoint(islandLoops: Point2D[][]): { pt: Point2D; clearanceMm: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of islandLoops[0]) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (!isFinite(minX)) return null;
  const grid = makeRasterGrid(minX, minY, maxX, maxY, MAX_ISLAND_LABEL_CELLS);
  const d = clearanceField(islandLoops, grid);

  let best = -1;
  let bestIdx = -1;
  for (let i = 0; i < d.length; i++) {
    if (d[i] > best) { best = d[i]; bestIdx = i; }
  }
  if (bestIdx < 0 || best <= 0) return null;
  const pt = cellCentre(grid, bestIdx);
  if (!isInsideLayer(pt, islandLoops)) return null;
  const exactClearance = minDistToLoops(pt, islandLoops);
  return exactClearance > 0 ? { pt, clearanceMm: exactClearance } : null;
}

/**
 * Picks up to `count` pin positions that clear every layer's outer boundary and
 * internal holes by `requiredMm`, verified analytically against exact segment
 * geometry so sub-cell holes or thin walls are never grazed.
 */
function choosePins(
  grid: RasterGrid,
  commonClearance: Float32Array,
  layers: ContourLayer[],
  count: number,
  requiredMm: number,
): Point2D[] {
  const candidates: number[] = [];
  for (let i = 0; i < commonClearance.length; i++) {
    if (commonClearance[i] >= requiredMm - grid.step) candidates.push(i);
  }
  if (candidates.length === 0) return [];

  const analyticallyValid = (p: Point2D): boolean => {
    for (const layer of layers) {
      if (!isInsideLayer(p, layer.loops)) return false;
      if (minDistToLoops(p, layer.loops) < requiredMm - 1e-6) return false;
    }
    return true;
  };

  candidates.sort((a, b) => commonClearance[b] - commonClearance[a]);
  const pins: Point2D[] = [];
  for (const idx of candidates) {
    const p = cellCentre(grid, idx);
    if (analyticallyValid(p)) {
      pins.push(p);
      break;
    }
  }
  if (pins.length === 0) return [];

  while (pins.length < count) {
    let bestPt: Point2D | null = null;
    let bestScore = -1;
    for (const i of candidates) {
      const p = cellCentre(grid, i);
      let nearest = Infinity;
      for (const q of pins) nearest = Math.min(nearest, Math.hypot(p.x - q.x, p.y - q.y));
      // Pins closer together than their own clearance would tear the material
      // between them, and they register no better than one pin would.
      if (nearest < 3 * requiredMm || nearest <= bestScore) continue;
      if (!analyticallyValid(p)) continue;
      bestScore = nearest;
      bestPt = p;
    }
    if (!bestPt) break;
    pins.push(bestPt);
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

/** Fast XY bounding box of a triangle soup's intersection with plane `z` (in metres). */
function sliceBoundsAtZ(tris: number[], z: number): { minX: number; maxX: number; minY: number; maxY: number } | null {
  const EPS = 1e-9;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let hit = false;
  const d = [0, 0, 0];
  const px = [0, 0, 0];
  const py = [0, 0, 0];

  for (let t = 0; t + 8 < tris.length; t += 9) {
    let pos = 0;
    for (let k = 0; k < 3; k++) {
      px[k] = tris[t + k * 3];
      py[k] = tris[t + k * 3 + 1];
      let dk = tris[t + k * 3 + 2] - z;
      if (dk > -EPS && dk < EPS) dk = EPS;
      d[k] = dk;
      if (dk > 0) pos++;
    }
    if (pos === 0 || pos === 3) continue;
    for (let k = 0; k < 3; k++) {
      const j = (k + 1) % 3;
      if ((d[k] > 0) === (d[j] > 0)) continue;
      const f = d[k] / (d[k] - d[j]);
      const x = px[k] + (px[j] - px[k]) * f;
      const y = py[k] + (py[j] - py[k]) * f;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      hit = true;
    }
  }
  return hit ? { minX, maxX, minY, maxY } : null;
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

/**
 * Lays rectangles out in rows, left to right, top to bottom, starting a new
 * sheet when a row runs off the bottom. A row or sheet that is still empty is
 * never left behind: a part too big for it goes there anyway (the caller warns
 * about it), rather than leaving an empty row or a blank first sheet.
 */
export function shelfPack(
  sizes: { w: number; h: number }[],
  sheetWidthMm: number,
  sheetHeightMm: number,
  marginMm: number,
): { placed: { sheet: number; x: number; y: number }[]; sheetCount: number } {
  let x = marginMm;
  let y = marginMm;
  let rowHeight = 0;
  let sheet = 0;
  const placed = sizes.map(({ w, h }) => {
    if (x > marginMm && x + w + marginMm > sheetWidthMm) {
      x = marginMm;
      y += rowHeight + marginMm;
      rowHeight = 0;
    }
    // On the top row a part too tall for any sheet overflows wherever it goes,
    // so it stays alongside the others rather than taking a sheet to itself.
    const tooTall = h + 2 * marginMm > sheetHeightMm;
    const sheetUsed = x > marginMm || y > marginMm;
    if (sheetUsed && y + h + marginMm > sheetHeightMm && !(tooTall && y === marginMm)) {
      sheet++;
      x = marginMm;
      y = marginMm;
      rowHeight = 0;
    }
    const at = { sheet, x, y };
    x += w + marginMm;
    if (h > rowHeight) rowHeight = h;
    return at;
  });
  return { placed, sheetCount: sheet + 1 };
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

  let unscaledZMin = Infinity;
  let unscaledZMax = -Infinity;
  for (let i = 2; i < tris.length; i += 3) {
    if (tris[i] < unscaledZMin) unscaledZMin = tris[i];
    if (tris[i] > unscaledZMax) unscaledZMax = tris[i];
  }
  const modelHeight = unscaledZMax - unscaledZMin;
  const thickness = options.materialThickness;

  if (!(thickness > 0)) {
    return { success: false, error: 'Material thickness must be greater than zero.' };
  }
  if (modelHeight <= 1e-6) {
    return { success: false, error: 'The scene is flat along Z, so there is nothing to slice into layers.' };
  }

  // ---- uniform 3D scale ----
  // Settled before computing layerCount and slicing Z planes so scaling is
  // uniform in X, Y, and Z (preserving 3D aspect ratio and reducing sheet count
  // along Z as well as XY when autoScale is enabled).
  const sheetWidthMm = options.sheetWidth * 1000;
  const sheetHeightMm = options.sheetHeight * 1000;
  const marginMm = options.margin * 1000;
  const outsetMm = (options.cutOutset ?? 0) * 1000;
  const maxSheets = options.maxSheets && options.maxSheets > 0 ? options.maxSheets : 0;
  const sampleAt = options.slicePosition === 'bottom'
    ? 0.02
    : options.slicePosition === 'top'
      ? 0.98
      : 0.5;

  let scaleFactor = Math.max(0.05, Math.min(2.0, options.scaleFactor ?? 1.0));

  if (options.autoScale || maxSheets > 0) {
    const kerfGrowMm = Math.max(0, options.kerf * 1000);
    const reqBorderMm = Math.max(2 * marginMm, marginMm + outsetMm);
    const evaluateScale = (s: number): { sheetCount: number; fitSingleSheet: boolean } => {
      const scaledH = modelHeight * s;
      const countS = options.sliceCount != null
        ? Math.max(1, Math.floor(options.sliceCount))
        : Math.max(1, Math.ceil(scaledH / thickness - 0.1));
      if (countS > MAX_LAYERS) return { sheetCount: Infinity, fitSingleSheet: false };

      const stepS = options.sliceCount == null ? thickness : scaledH / countS;
      const sizes: { w: number; h: number }[] = [];
      let fitSingleSheet = true;

      for (let i = 0; i < countS; i++) {
        const bandLo = i * stepS;
        const band = Math.min(stepS, scaledH - bandLo);
        const z0 = unscaledZMin + (bandLo + sampleAt * band) / s;
        let b = sliceBoundsAtZ(tris, z0);
        if (!b) {
          const tries = [0.5, 0.25, 0.75, 0.1, 0.9, 0.02, 0.98]
            .map((f) => unscaledZMin + (bandLo + f * band) / s)
            .sort((p, q) => Math.abs(p - z0) - Math.abs(q - z0));
          for (const alt of tries) {
            b = sliceBoundsAtZ(tris, alt);
            if (b) break;
          }
        }
        if (!b) continue;
        const w = Math.max(1, (b.maxX - b.minX) * 1000 * s + kerfGrowMm);
        const h = Math.max(1, (b.maxY - b.minY) * 1000 * s + kerfGrowMm);
        if (w + reqBorderMm > sheetWidthMm || h + reqBorderMm > sheetHeightMm) {
          fitSingleSheet = false;
        }
        sizes.push({ w, h });
      }
      if (sizes.length === 0) return { sheetCount: 1, fitSingleSheet };
      return { sheetCount: shelfPack(sizes, sheetWidthMm, sheetHeightMm, marginMm).sheetCount, fitSingleSheet };
    };

    let bestScale = scaleFactor;
    const startScale = options.autoScale ? 1.0 : scaleFactor;
    for (let s = startScale; s >= 0.05 - 1e-9; s = Math.round((s - 0.01) * 100) / 100) {
      const res = evaluateScale(s);
      bestScale = s;
      if (res.fitSingleSheet && (maxSheets === 0 || res.sheetCount <= maxSheets)) {
        break;
      }
    }
    scaleFactor = bestScale;
  }

  // Uniformly scale triangles into as-cut 3D model space (keeping the base at `unscaledZMin`).
  const scaledTris = Math.abs(scaleFactor - 1.0) > 1e-6
    ? (() => {
        const out = new Array<number>(tris.length);
        for (let i = 0; i < tris.length; i += 3) {
          out[i] = tris[i] * scaleFactor;
          out[i + 1] = tris[i + 1] * scaleFactor;
          out[i + 2] = unscaledZMin + (tris[i + 2] - unscaledZMin) * scaleFactor;
        }
        return out;
      })()
    : tris;
  const zMin = unscaledZMin;
  const scaledModelHeight = modelHeight * scaleFactor;
  const zMax = zMin + scaledModelHeight;

  // Rounded up, never to the nearest: a stack can be planed down to height but
  // not built up to it, and rounding 121 mm over 50 mm stock gave two sheets,
  // a stack 21 mm short. The slack forgives a model a hair over a whole number
  // of sheets (a flask's 1 mm clearance) rather than adding a sheet for it.
  const autoCount = Math.max(1, Math.ceil(scaledModelHeight / thickness - 0.1));
  const layerCount = Math.max(1, Math.floor(options.sliceCount ?? autoCount));

  if (layerCount > MAX_LAYERS) {
    return {
      success: false,
      error: `${layerCount} layers at ${(thickness * 1000).toFixed(1)} mm — more than the ${MAX_LAYERS} ` +
        `this export handles. Use thicker stock, or set a layer count.`,
    };
  }

  // Each layer owns a band of the scaled model's height and is sampled at one spot
  // inside it. On auto the band is one sheet thick from the bottom up, so the
  // stack is the model at true height, and the top band stops at the model's
  // top: that layer is faced down to match. An explicit `sliceCount` override
  // cuts `sliceCount` full-thickness sheets without facing every sheet down.
  const step = options.sliceCount == null ? thickness : scaledModelHeight / layerCount;

  const layers: ContourLayer[] = [];
  let emptyLayers = 0;
  let openLayerCount = 0;
  let totalOpenChains = 0;
  let worstOpenGapMm = 0;

  for (let i = 0; i < layerCount; i++) {
    // The chosen spot can land in a gap the layer spans — the clearance
    // between a flask's cope and drag sits exactly at mid-height, so one thick
    // layer over both used to come out empty and the export failed. The layer
    // still has material in it, so look elsewhere in its band, nearest first.
    const bandLo = zMin + i * step;
    const band = Math.min(step, zMax - bandLo);
    let z = bandLo + sampleAt * band;
    let layerStats: ChainStats = { openChainsClosed: 0, maxGapMm: 0 };
    let loops = contoursAtZ(scaledTris, z, solidIds, layerStats);
    if (loops.length === 0) {
      const tries = [0.5, 0.25, 0.75, 0.1, 0.9, 0.02, 0.98]
        .map((f) => bandLo + f * band)
        .sort((a, b) => Math.abs(a - z) - Math.abs(b - z));
      for (const alt of tries) {
        const altStats: ChainStats = { openChainsClosed: 0, maxGapMm: 0 };
        const found = contoursAtZ(scaledTris, alt, solidIds, altStats);
        if (found.length > 0) {
          z = alt;
          loops = found;
          layerStats = altStats;
          break;
        }
      }
    }
    if (loops.length === 0) { emptyLayers++; continue; }

    if (layerStats.openChainsClosed > 0) {
      openLayerCount++;
      totalOpenChains += layerStats.openChainsClosed;
      if (layerStats.maxGapMm > worstOpenGapMm) worstOpenGapMm = layerStats.maxGapMm;
    }

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
      // Only face the top remainder layer when deriving layer count automatically;
      // an explicit `sliceCount` override means `sliceCount` full-thickness sheets.
      ...(options.sliceCount == null && band < thickness - 1e-4
        ? { facedToMm: +(band * 1000).toFixed(1) }
        : {}),
    });
  }

  if (layers.length === 0) {
    return { success: false, error: 'Slicing produced no closed contours. The geometry may not be a closed solid.' };
  }

  if (openLayerCount > 0) {
    warnings.push(
      `Non-manifold or open mesh edges detected on ${openLayerCount} layer${openLayerCount === 1 ? '' : 's'} ` +
      `(${totalOpenChains} open contour${totalOpenChains === 1 ? '' : 's'} closed across gaps up to ` +
      `${worstOpenGapMm.toFixed(2)} mm); check the slice preview before cutting.`
    );
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
        `Layers ${first}–${last} (${longest.length} layers, ${(longest.length * step * 1000).toFixed(0)} mm) have an identical cross-section.`
      );
    }
  }

  const multiPiece = layers.filter(l => l.pieceCount > 1);
  if (multiPiece.length > 0) {
    warnings.push(
      `${multiPiece.length} layer${multiPiece.length === 1 ? ' splits' : 's split'} into multiple islands (e.g. layer ${multiPiece[0].index + 1}: ${multiPiece[0].pieceCount} pieces); only islands intersected by dowels are registered.`
    );
  }

  // ---- bounds (as cut, after 3D scaling), shared by the pin search and the map preview ----
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

  // ---- alignment pins ----
  const pins: { x: number; y: number; radiusMm: number }[] = [];
  if (options.pinHoles && options.pinCount > 0) {
    const grid = makeRasterGrid(minX, minY, maxX, maxY);
    const pinRadiusMm = (options.pinDiameter * 1000) / 2;
    // Enough material has to survive around a dowel for the layer not to break
    // out at the hole: pin radius + one full dowel diameter of surviving wall.
    const requiredMm = pinRadiusMm * 3;

    const commonClearance = new Float32Array(grid.cols * grid.rows).fill(Infinity);
    for (const layer of layers) {
      const d = clearanceField(layer.loops, grid);
      for (let i = 0; i < commonClearance.length; i++) {
        if (d[i] < commonClearance[i]) commonClearance[i] = d[i];
      }
    }

    // A hole cut on its nominal line comes out a kerf wider than the dowel.
    const cutRadiusMm = Math.max(0.1, pinRadiusMm - (options.kerf * 1000) / 2);
    const placed = choosePins(grid, commonClearance, layers, options.pinCount, requiredMm);
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

    // Check per-island registration on multi-island / concentric-ring layers so
    // unpinned or single-pin islands are flagged even when `placed.length === options.pinCount`.
    if (placed.length > 0 && multiPiece.length > 0) {
      let zeroPinIslands = 0;
      let singlePinIslands = 0;
      for (const layer of multiPiece) {
        for (const island of extractSolidIslands(layer.loops)) {
          let count = 0;
          for (const pin of placed) {
            if (isInsideLayer(pin, island.loops)) count++;
          }
          if (count === 0) zeroPinIslands++;
          else if (count === 1) singlePinIslands++;
        }
      }
      if (zeroPinIslands > 0 || (singlePinIslands > 0 && options.pinCount >= 2)) {
        const parts: string[] = [];
        if (zeroPinIslands > 0) {
          parts.push(`${zeroPinIslands} island${zeroPinIslands === 1 ? ' has' : 's have'} 0 alignment pins (align visually with the relief map)`);
        }
        if (singlePinIslands > 0 && options.pinCount >= 2) {
          parts.push(`${singlePinIslands} island${singlePinIslands === 1 ? ' has' : 's have'} only 1 pin and can rotate around it`);
        }
        warnings.push(`Disconnected island registration: ${parts.join('; ')}.`);
      }
    }

    for (const layer of layers) {
      for (const pin of pins) layer.loops.push(circleLoop({ x: pin.x, y: pin.y }, pinRadiusMm));
    }
  }

  // Snapshot uncompensated geometry (including dowel holes) before applying
  // laser kerf compensation, so 3D stack simulation builds true nominal dimensions.
  for (const layer of layers) {
    layer.nominalLoops = layer.loops.map((loop) => loop.map((p) => ({ x: p.x, y: p.y })));
  }

  // ---- label anchors (computed AFTER dowel holes are punched, per solid island) ----
  if (options.includeLabels) {
    for (const layer of layers) {
      const islands = extractSolidIslands(layer.nominalLoops ?? layer.loops);
      const anchors: Point2D[] = [];
      for (const island of islands) {
        const deep = deepestIslandPoint(island.loops);
        // Below this the number is bigger than the material it is engraved on.
        if (deep && deep.clearanceMm >= 3) anchors.push(deep.pt);
      }
      if (anchors.length > 0) {
        layer.labelPositions2D = anchors;
        layer.labelPos2D = anchors[0];
      }
    }
  }

  // ---- kerf ----
  // A laser burns away half its kerf either side of the line, so every layer
  // is offset by that much: outlines out, holes (dowel holes among them) in,
  // and the layer comes out at the size it was modelled. A router is sent no
  // kerf; its G-code stands the bit off by its own radius instead.
  const kerfHalfMm = (options.kerf * 1000) / 2;
  if (kerfHalfMm > 1e-6) {
    for (const layer of layers) {
      const depths = nestingDepths(layer.loops);
      layer.loops = layer.loops.flatMap((loop, i) =>
        loop.length < 3 ? [loop] : offsetLoop(loop, depths[i] % 2 === 1 ? -kerfHalfMm : kerfHalfMm, { joinStyle: 'miter' }));
    }
  }

  // ---- nest onto sheets ----
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

  const oversized: string[] = [];
  const offSheet: string[] = [];
  const sizes = layers.map((layer) => {
    const w = layer.width2D || 1;
    const h = layer.height2D || 1;
    if (w + 2 * marginMm > sheetWidthMm || h + 2 * marginMm > sheetHeightMm) {
      oversized.push(`layer ${layer.index + 1}`);
      if (w + marginMm + outsetMm > sheetWidthMm || h + marginMm + outsetMm > sheetHeightMm) offSheet.push(`layer ${layer.index + 1}`);
    }
    return { w, h };
  });
  const packed = shelfPack(sizes, sheetWidthMm, sheetHeightMm, marginMm);
  layers.forEach((layer, i) => {
    layer.sheetIndex = packed.placed[i].sheet;
    layer.placedPos2D = { x: packed.placed[i].x, y: packed.placed[i].y };
  });
  const sheetCount = packed.sheetCount;

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

  const lastLayer = layers[layers.length - 1];
  const stackHeight = layers.reduce(
    (sum, l) => sum + (l.facedToMm !== undefined ? l.facedToMm / 1000 : thickness),
    0,
  );
  if (lastLayer.facedToMm !== undefined) {
    warnings.push(
      `The${Math.abs(scaleFactor - 1.0) > 1e-3 ? ' scaled' : ''} model is ${(scaledModelHeight * 1000).toFixed(0)} mm tall, not a whole number of ` +
      `${(thickness * 1000).toFixed(1)} mm sheets, so the top layer is faced down to ` +
      `${lastLayer.facedToMm} mm before its profile is cut. A laser cannot face: cut that ` +
      `layer from ${lastLayer.facedToMm} mm stock instead.`
    );
  } else if (Math.abs(stackHeight - scaledModelHeight) > Math.max(thickness, scaledModelHeight * 0.02)) {
    warnings.push(
      `${layers.length} layers of ${(thickness * 1000).toFixed(1)} mm stack up to ` +
      `${(stackHeight * 1000).toFixed(0)} mm, but the${Math.abs(scaleFactor - 1.0) > 1e-3 ? ' scaled' : ''} model is ${(scaledModelHeight * 1000).toFixed(0)} mm tall. ` +
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
      svg += `  <rect x="0" y="${sheetY}" width="${sheetWidthMm}" height="${sheetHeightMm}" data-operation="ghost" fill="none" stroke="#94A3B8" stroke-width="0.5" stroke-dasharray="4 4" />\n`;
      if (options.includeLabels) {
        svg += `  <text x="10" y="${sheetY + 20}" data-operation="ghost" fill="#64748B" font-family="sans-serif" font-size="12" font-weight="bold">Sheet ${s + 1} (${sheetWidthMm}mm x ${sheetHeightMm}mm${scaleFactor !== 1 ? ` @ ${(scaleFactor * 100).toFixed(0)}% scale` : ''})</text>\n`;
      }
    }
    svg += `\n`;
  }

  svg += `  <g id="cut-paths" data-operation="cut" stroke="#FF0000" stroke-width="0.2" fill="none" stroke-linejoin="round" stroke-linecap="round">\n`;
  // The sheets are drawn one below another, so each layer drops by its sheet.
  const sheetTop = (layer: ContourLayer) => (layer.sheetIndex ?? 0) * sheetHeightMm;
  for (const layer of layers) {
    const pos = layer.placedPos2D!;
    const off = layer.modelOffset2D!;
    svg += loopsPath(layer.loops, pos.x - off.x, sheetTop(layer) + pos.y + off.y);
  }
  svg += `  </g>\n\n`;

  if (options.includeLabels) {
    svg += `  <g id="engrave-labels" data-operation="etch" fill="#0000FF" font-family="sans-serif" font-size="8" text-anchor="middle" dominant-baseline="central">\n`;
    for (const layer of layers) {
      const anchors = layer.labelPositions2D ?? (layer.labelPos2D ? [layer.labelPos2D] : []);
      if (anchors.length === 0) continue;
      const pos = layer.placedPos2D!;
      const off = layer.modelOffset2D!;
      for (const anchor of anchors) {
        const x = pos.x - off.x + anchor.x;
        const y = sheetTop(layer) + pos.y + off.y - anchor.y;
        svg += `    <text x="${x.toFixed(2)}" y="${y.toFixed(2)}">${escapeXml(String(layer.index + 1))}</text>\n`;
      }
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

  const zScale = options.sliceCount == null ? scaleFactor : stackHeight / modelHeight;

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
    oversized,
    offSheet,
    stockTransform: (() => {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < tris.length; i++) {
        lo[i % 3] = Math.min(lo[i % 3], tris[i] * 1000);
        hi[i % 3] = Math.max(hi[i % 3], tris[i] * 1000);
      }
      return {
        modelOriginMm: [0, 0, unscaledZMin * 1000] as [number, number, number],
        workOriginMm: [0, 0, 0] as [number, number, number],
        scale: [scaleFactor, scaleFactor, zScale] as [number, number, number],
        modelMinMm: lo as [number, number, number],
        modelMaxMm: hi as [number, number, number],
      };
    })(),
    warnings,
  };
}
