// ---------------------------------------------------------------------------
// 3D CNC Relief Carving Export Engine
// ---------------------------------------------------------------------------
//
// The laser exporter unwraps flat faces onto sheet stock; the contour exporter
// stacks the model out of horizontal slices. This one carves the model into the
// face of a solid block, the way a relief plaque is carved: the scene is
// sampled from directly above into a heightmap, that heightmap is squashed into
// the depth the user is willing to cut, and a ball-nose (or flat) mill sweeps
// it in parallel passes.
//
// The pipeline is: tessellate the scene into world triangles, fit them onto the
// stock, drop a ray down through every grid cell to get the surface height,
// dilate that surface by the cutter's own shape so the tool sits ON the surface
// instead of THROUGH it, then emit an optional layered roughing pass followed by
// the finishing raster.
//
// Everything in here is millimetres in machine coordinates, with the top face of
// the stock at Z = 0 and cuts running negative.

import type { SceneGraph } from '../types/scene';
import { collectSceneTriangles } from './contourSliceExporter';
import { warpGcode, type ProbeGrid } from './meshLeveler';

export interface ReliefCarveOptions {
  /** Stock width (X extent) in mm. */
  stockWidthMm: number;
  /** Stock depth (Y extent) in mm. */
  stockDepthMm: number;
  /** Stock thickness in mm. Only used to sanity-check the carve depth. */
  stockThicknessMm: number;
  /**
   * How far below the stock's top face the deepest point of the relief goes.
   * The model's whole height range is compressed into this, which is what makes
   * it a relief rather than a full 3D machining job.
   */
  carveDepthMm: number;
  /** 'fit' scales the model to the stock; 'manual' honours `scalePercent`. */
  fitMode: 'fit' | 'manual';
  /** Plan-view scale when `fitMode` is 'manual', as a percentage of 1 m : 1 mm. */
  scalePercent: number;
  /**
   * What to do with the stock the model does not cover. 'carve' takes the
   * background down to the floor so the model stands proud of it; 'skip' leaves
   * it at full stock height and only cuts where the model actually dips.
   */
  backgroundMode: 'carve' | 'skip';
  /** Clear waste with a flat mill before the finishing raster. */
  roughingEnabled: boolean;
  /** Roughing tool diameter in mm. */
  roughingToolDiaMm: number;
  /** Roughing Z stepdown per layer in mm. */
  roughingStepdownMm: number;
  /** Roughing cut feedrate in mm/min. */
  roughingFeedrate: number;
  /** Z plunge rate in mm/min. */
  roughingPlungeRate: number;
  /** Material left on the surface for the finishing pass to take off, in mm. */
  roughingAllowanceMm: number;
  /** Finishing tool shape. A ball nose is what makes a curved surface smooth. */
  finishingToolType: 'ball_nose' | 'flat';
  /** Finishing tool diameter in mm. */
  finishingToolDiaMm: number;
  /** Distance between finishing passes, as a percentage of tool diameter. */
  finishingStepoverPercent: number;
  /** Finishing cut feedrate in mm/min. */
  finishingFeedrate: number;
  /** Finishing Z plunge rate in mm/min. */
  finishingPlungeRate: number;
  /** Which axis the finishing passes sweep along. */
  finishingDirection: 'x' | 'y';
  /** Retract height above the stock's top face in mm. */
  safeZ: number;
  /** Spindle speed in RPM. */
  spindleRpm: number;
  /** Probed bed mesh, if the bed has been mapped. */
  meshLevelGrid: ProbeGrid | null;
  /** Ride the probed mesh so a warped bed still cuts to a constant depth. */
  applyMeshLeveling: boolean;
}

export const DEFAULT_RELIEF_OPTIONS: ReliefCarveOptions = {
  stockWidthMm: 150,
  stockDepthMm: 150,
  stockThicknessMm: 18,
  carveDepthMm: 10,
  fitMode: 'fit',
  scalePercent: 100,
  backgroundMode: 'carve',
  roughingEnabled: true,
  roughingToolDiaMm: 6.35,
  roughingStepdownMm: 2.0,
  roughingFeedrate: 1200,
  roughingPlungeRate: 300,
  roughingAllowanceMm: 0.5,
  finishingToolType: 'ball_nose',
  finishingToolDiaMm: 3.175,
  finishingStepoverPercent: 15,
  finishingFeedrate: 1500,
  finishingPlungeRate: 300,
  finishingDirection: 'x',
  safeZ: 5.0,
  spindleRpm: 12000,
  meshLevelGrid: null,
  applyMeshLeveling: false,
};

export interface ToolpathSegment {
  type: 'roughing' | 'finishing';
  points: { x: number; y: number; z: number }[];
}

export interface ReliefCarveResult {
  success: boolean;
  gcode: string;
  /** Cutting travel in mm — rapids excluded. */
  totalCutDistanceMm: number;
  /** Cutting time plus rapids and plunges, in seconds. */
  estimatedTimeSeconds: number;
  roughingPassCount: number;
  finishingRasterLines: number;
  /** Whether the job stops for a tool change between the two passes. */
  toolChange: boolean;
  /** Plan-view scale actually applied to the model, 1.0 = 1 m per mm. */
  scaleFactor: number;
  /** Footprint the model occupies on the stock, in machine mm. */
  carveBounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** The stock block itself. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number; minZ: number; maxZ: number };
  /** Decimated toolpath polylines for the 3D preview. */
  segments: ToolpathSegment[];
  warnings: string[];
  error?: string;
}

/** Beyond this the heightmap costs more than the extra fidelity is worth. */
const MAX_HEIGHTMAP_CELLS = 260_000;
/** Rapid rate assumed for time estimates (mm/min). */
const RAPID_FEEDRATE = 3000;
/** A finishing point this close to the straight line through its neighbours is noise (mm). */
const PATH_SIMPLIFY_MM = 0.01;
/** How far the simplifier looks ahead before it commits to a point. */
const SIMPLIFY_LOOKAHEAD = 48;
/** Preview vertex budget — past this the viewport, not the mill, is the bottleneck. */
const MAX_PREVIEW_POINTS = 60_000;

function f(num: number): string {
  return num.toFixed(3);
}

// ---------------------------------------------------------------------------
// Heightmap
// ---------------------------------------------------------------------------

export interface Heightmap {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cols: number;
  rows: number;
  stepX: number;
  stepY: number;
  /** Surface Z per cell, row-major with row 0 at minY. Stock top is 0. */
  z: Float32Array;
}

/**
 * Samples a heightmap between its cells. Outside the grid it clamps to the
 * edge, which is what the tool dilation below wants at the stock boundary.
 */
export function sampleHeightmap(hm: Heightmap, x: number, y: number): number {
  const fx = Math.min(hm.cols - 1, Math.max(0, (x - hm.minX) / hm.stepX));
  const fy = Math.min(hm.rows - 1, Math.max(0, (y - hm.minY) / hm.stepY));

  const c0 = Math.min(hm.cols - 1, Math.floor(fx));
  const r0 = Math.min(hm.rows - 1, Math.floor(fy));
  const c1 = Math.min(hm.cols - 1, c0 + 1);
  const r1 = Math.min(hm.rows - 1, r0 + 1);

  const tx = fx - c0;
  const ty = fy - r0;

  const z00 = hm.z[r0 * hm.cols + c0];
  const z10 = hm.z[r0 * hm.cols + c1];
  const z01 = hm.z[r1 * hm.cols + c0];
  const z11 = hm.z[r1 * hm.cols + c1];

  return (z00 * (1 - tx) + z10 * tx) * (1 - ty) + (z01 * (1 - tx) + z11 * tx) * ty;
}

/**
 * Drops a vertical ray through every cell and keeps the highest triangle it
 * hits — the model as seen from the spindle.
 *
 * Testing every triangle against every cell is what makes the naive version of
 * this unusable on a real mesh (a 300 x 300 grid against a 20 k triangle model
 * is 1.8 billion tests), so triangles are bucketed by their plan-view bounding
 * box first and each ray only visits its own bucket.
 */
export function buildHeightmap(
  tris: Float64Array,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  cols: number,
  rows: number,
  floorZ: number
): Heightmap {
  const stepX = cols > 1 ? (bounds.maxX - bounds.minX) / (cols - 1) : 0;
  const stepY = rows > 1 ? (bounds.maxY - bounds.minY) / (rows - 1) : 0;
  const z = new Float32Array(cols * rows).fill(floorZ);

  const triCount = tris.length / 9;
  if (triCount === 0) {
    return { ...bounds, cols, rows, stepX, stepY, z };
  }

  // One bucket per few triangles, capped so the index itself stays small.
  const side = Math.max(1, Math.min(128, Math.round(Math.sqrt(triCount / 2))));
  const bw = (bounds.maxX - bounds.minX) / side || 1;
  const bh = (bounds.maxY - bounds.minY) / side || 1;
  const buckets: number[][] = Array.from({ length: side * side }, () => []);

  const bucketCol = (x: number) => Math.min(side - 1, Math.max(0, Math.floor((x - bounds.minX) / bw)));
  const bucketRow = (y: number) => Math.min(side - 1, Math.max(0, Math.floor((y - bounds.minY) / bh)));

  for (let t = 0; t < triCount; t++) {
    const i = t * 9;
    const ax = tris[i], ay = tris[i + 1];
    const bx = tris[i + 3], by = tris[i + 4];
    const cx = tris[i + 6], cy = tris[i + 7];

    // A triangle entirely off the stock can never be hit by a ray we cast.
    if (Math.max(ax, bx, cx) < bounds.minX || Math.min(ax, bx, cx) > bounds.maxX) continue;
    if (Math.max(ay, by, cy) < bounds.minY || Math.min(ay, by, cy) > bounds.maxY) continue;

    const c0 = bucketCol(Math.min(ax, bx, cx));
    const c1 = bucketCol(Math.max(ax, bx, cx));
    const r0 = bucketRow(Math.min(ay, by, cy));
    const r1 = bucketRow(Math.max(ay, by, cy));

    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) buckets[r * side + c].push(i);
    }
  }

  for (let row = 0; row < rows; row++) {
    const py = bounds.minY + row * stepY;
    const br = bucketRow(py);

    for (let col = 0; col < cols; col++) {
      const px = bounds.minX + col * stepX;
      const bucket = buckets[br * side + bucketCol(px)];
      if (bucket.length === 0) continue;

      let best = floorZ;

      for (const i of bucket) {
        const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
        const bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5];
        const cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];

        // Barycentric coordinates of (px, py) in the triangle's plan view.
        const v0x = cx - ax, v0y = cy - ay;
        const v1x = bx - ax, v1y = by - ay;
        const v2x = px - ax, v2y = py - ay;

        const den = v0x * v1y - v1x * v0y;
        if (den === 0) continue; // Edge-on triangle: it has no plan-view area.

        const u = (v2x * v1y - v1x * v2y) / den;
        const v = (v0x * v2y - v2x * v0y) / den;
        if (u < 0 || v < 0 || u + v > 1) continue;

        const hitZ = az + u * (cz - az) + v * (bz - az);
        if (hitZ > best) best = hitZ;
      }

      if (best > floorZ) z[row * cols + col] = best;
    }
  }

  return { ...bounds, cols, rows, stepX, stepY, z };
}

/**
 * Lifts the surface into the height the tool's *tip* has to sit at to graze it
 * without cutting into it anywhere under the cutter — a Minkowski dilation by
 * the tool's own shape.
 *
 * This is the step that decides whether the carve is a carve. Driving the tip
 * straight along the sampled surface gouges every convex feature by up to the
 * tool radius, because the shank cuts material the tip never touched.
 */
export function dilateForTool(hm: Heightmap, toolRadiusMm: number, ballNose: boolean): Heightmap {
  const out = new Float32Array(hm.z);
  if (toolRadiusMm <= 0) return { ...hm, z: out };

  const kx = Math.max(1, Math.round(toolRadiusMm / (hm.stepX || toolRadiusMm)));
  const ky = Math.max(1, Math.round(toolRadiusMm / (hm.stepY || toolRadiusMm)));

  // Tip lift for a ball of radius r touching a point dx,dy away, precomputed
  // per kernel cell: the ball's centre rides at h + sqrt(r^2 - d^2), and its
  // tip is one radius below that. A flat mill lifts by nothing — its whole
  // flat bottom has to clear the highest point under it.
  const lift = new Float32Array((2 * ky + 1) * (2 * kx + 1)).fill(-Infinity);
  for (let dy = -ky; dy <= ky; dy++) {
    for (let dx = -kx; dx <= kx; dx++) {
      const ox = dx * hm.stepX;
      const oy = dy * hm.stepY;
      const d2 = ox * ox + oy * oy;
      if (d2 > toolRadiusMm * toolRadiusMm) continue;
      lift[(dy + ky) * (2 * kx + 1) + (dx + kx)] = ballNose
        ? Math.sqrt(toolRadiusMm * toolRadiusMm - d2) - toolRadiusMm
        : 0;
    }
  }

  for (let row = 0; row < hm.rows; row++) {
    for (let col = 0; col < hm.cols; col++) {
      let best = -Infinity;

      for (let dy = -ky; dy <= ky; dy++) {
        const r = Math.min(hm.rows - 1, Math.max(0, row + dy));
        for (let dx = -kx; dx <= kx; dx++) {
          const l = lift[(dy + ky) * (2 * kx + 1) + (dx + kx)];
          if (l === -Infinity) continue;
          const c = Math.min(hm.cols - 1, Math.max(0, col + dx));
          const candidate = hm.z[r * hm.cols + c] + l;
          if (candidate > best) best = candidate;
        }
      }

      out[row * hm.cols + col] = best;
    }
  }

  return { ...hm, z: out };
}

// ---------------------------------------------------------------------------
// Path building
// ---------------------------------------------------------------------------

interface PathPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * Thins a raster pass down to the points that carry its shape.
 *
 * A relief raster samples on a fixed grid, so a flat stretch of background
 * arrives as hundreds of identical moves. GRBL only swallows a few hundred
 * lines a second over serial, and a job that streams slower than it cuts stalls
 * the spindle in the cut — so points that sit on the straight line between the
 * ones either side of them are dropped.
 */
function simplifyPass(points: PathPoint[], tolMm: number): PathPoint[] {
  if (points.length <= 2) return points;

  const kept: PathPoint[] = [points[0]];
  let anchor = 0;

  for (let i = 1; i < points.length; i++) {
    const a = points[anchor];
    const b = points[i];
    const spanX = b.x - a.x;
    const spanY = b.y - a.y;
    const span = Math.hypot(spanX, spanY);

    let fits = i - anchor <= SIMPLIFY_LOOKAHEAD;
    if (fits && span > 1e-9) {
      for (let j = anchor + 1; j < i; j++) {
        const p = points[j];
        const t = (Math.hypot(p.x - a.x, p.y - a.y)) / span;
        if (Math.abs(p.z - (a.z + (b.z - a.z) * t)) > tolMm) {
          fits = false;
          break;
        }
      }
    }

    if (!fits) {
      kept.push(points[i - 1]);
      anchor = i - 1;
    }
  }

  kept.push(points[points.length - 1]);
  return kept;
}

/** Sample positions along one axis, inclusive of both ends. */
function axisSamples(from: number, to: number, step: number): number[] {
  if (to <= from) return [(from + to) / 2];
  const count = Math.max(1, Math.ceil((to - from) / step));
  const out: number[] = [];
  for (let i = 0; i <= count; i++) out.push(from + ((to - from) * i) / count);
  return out;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Turns a scene into a relief carving job for a 3-axis CNC router.
 */
export function generateReliefCarveGcode(
  scene: SceneGraph,
  userOptions?: Partial<ReliefCarveOptions>
): ReliefCarveResult {
  const opts: ReliefCarveOptions = { ...DEFAULT_RELIEF_OPTIONS, ...userOptions };
  const warnings: string[] = [];

  const stockW = Math.max(1, opts.stockWidthMm);
  const stockD = Math.max(1, opts.stockDepthMm);
  // Work origin is the stock's near-left corner, top face — the same corner the
  // machine panel tells you to jog to before zeroing, and the same convention the
  // laser and contour exports already use. A centred origin here meant a job
  // zeroed on the corner ran off the stock down and to the left of zero.
  const bounds = {
    minX: 0,
    minY: 0,
    maxX: stockW,
    maxY: stockD,
    minZ: -opts.stockThicknessMm,
    maxZ: 0,
  };

  const empty = (error: string): ReliefCarveResult => ({
    success: false,
    error,
    gcode: '',
    totalCutDistanceMm: 0,
    estimatedTimeSeconds: 0,
    roughingPassCount: 0,
    finishingRasterLines: 0,
    toolChange: false,
    scaleFactor: 1,
    carveBounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    bounds,
    segments: [],
    warnings,
  });

  const { tris: sceneTris, skipped, warnings: sceneWarnings } = collectSceneTriangles(scene);
  warnings.push(...sceneWarnings);
  if (skipped.length > 0) {
    warnings.push(`Skipped (no solid volume to carve): ${skipped.join(', ')}.`);
  }
  if (sceneTris.length === 0) {
    return empty('No solid geometry found in the scene to carve.');
  }

  const carveDepth = Math.max(0.1, opts.carveDepthMm);
  if (carveDepth > opts.stockThicknessMm - 1) {
    warnings.push(
      `A ${carveDepth} mm relief in ${opts.stockThicknessMm} mm stock leaves under 1 mm underneath. ` +
        `Cut the relief depth, or use thicker stock.`
    );
  }

  // The raster is inset by the finishing tool's radius so the cutter stays over
  // the stock, which is also the area a fitted model has to land inside.
  const finishRad = Math.max(0.05, opts.finishingToolDiaMm / 2);
  const stepover = Math.max(
    0.05,
    (opts.finishingToolDiaMm * Math.min(50, Math.max(2, opts.finishingStepoverPercent))) / 100
  );
  const usableW = Math.max(1, stockW - 2 * finishRad);
  const usableD = Math.max(1, stockD - 2 * finishRad);

  // --- Fit the model onto the stock -----------------------------------------
  // Scene units are metres; 1 m maps to 1000 mm before any user scaling.
  let mnX = Infinity, mnY = Infinity, mnZ = Infinity;
  let mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity;
  for (let i = 0; i < sceneTris.length; i += 3) {
    const x = sceneTris[i] * 1000;
    const y = sceneTris[i + 1] * 1000;
    const z = sceneTris[i + 2] * 1000;
    if (x < mnX) mnX = x;
    if (x > mxX) mxX = x;
    if (y < mnY) mnY = y;
    if (y > mxY) mxY = y;
    if (z < mnZ) mnZ = z;
    if (z > mxZ) mxZ = z;
  }

  const modelW = mxX - mnX;
  const modelD = mxY - mnY;
  const modelH = mxZ - mnZ;
  if (modelW <= 1e-6 || modelD <= 1e-6) {
    return empty('The scene has no plan-view area, so there is no surface to carve.');
  }
  if (modelH <= 1e-6) {
    return empty('The scene is flat along Z, so a relief of it would be a flat pocket.');
  }

  const fitScale = Math.min(usableW / modelW, usableD / modelD);
  const scaleFactor = opts.fitMode === 'fit' ? fitScale : Math.max(0.01, opts.scalePercent / 100);

  if (opts.fitMode === 'manual' && scaleFactor > fitScale * 1.0001) {
    warnings.push(
      `At ${opts.scalePercent}% the model is ${(modelW * scaleFactor).toFixed(0)} x ` +
        `${(modelD * scaleFactor).toFixed(0)} mm and overhangs the stock — anything past the edge is ` +
        `cropped. It fits at ${(fitScale * 100).toFixed(0)}%.`
    );
  }

  // Model centre lands on the stock centre; the model's highest point lands on
  // the stock's top face, and its lowest on the floor of the relief.
  const cx = (mnX + mxX) / 2;
  const cy = (mnY + mxY) / 2;
  const floorZ = -carveDepth;

  // Centre of the stock in work coordinates, which with a corner origin is half
  // the stock rather than zero.
  const stockCx = stockW / 2;
  const stockCy = stockD / 2;

  const tris = new Float64Array(sceneTris.length);
  for (let i = 0; i < sceneTris.length; i += 3) {
    tris[i] = (sceneTris[i] * 1000 - cx) * scaleFactor + stockCx;
    tris[i + 1] = (sceneTris[i + 1] * 1000 - cy) * scaleFactor + stockCy;
    tris[i + 2] = ((sceneTris[i + 2] * 1000 - mxZ) / modelH) * carveDepth;
  }

  const carveBounds = {
    minX: Math.max(bounds.minX, stockCx - (modelW * scaleFactor) / 2),
    minY: Math.max(bounds.minY, stockCy - (modelD * scaleFactor) / 2),
    maxX: Math.min(bounds.maxX, stockCx + (modelW * scaleFactor) / 2),
    maxY: Math.min(bounds.maxY, stockCy + (modelD * scaleFactor) / 2),
  };

  // --- Sample the surface ----------------------------------------------------
  let res = Math.min(stepover, 0.6);
  let cols = Math.ceil(stockW / res) + 1;
  let rows = Math.ceil(stockD / res) + 1;
  if (cols * rows > MAX_HEIGHTMAP_CELLS) {
    const shrink = Math.sqrt((cols * rows) / MAX_HEIGHTMAP_CELLS);
    res *= shrink;
    cols = Math.ceil(stockW / res) + 1;
    rows = Math.ceil(stockD / res) + 1;
    warnings.push(
      `Surface sampled every ${res.toFixed(2)} mm — the stock is too large to sample at the ` +
        `${stepover.toFixed(2)} mm stepover. Detail finer than that is smoothed out.`
    );
  }

  // Cells the model does not cover are marked, not floored, so that a model
  // whose own lowest face sits exactly on the floor is not mistaken for bare
  // background and left uncut.
  const surface = buildHeightmap(tris, bounds, cols, rows, -Infinity);
  const backgroundZ = opts.backgroundMode === 'skip' ? 0 : floorZ;
  for (let i = 0; i < surface.z.length; i++) {
    if (surface.z[i] === -Infinity) surface.z[i] = backgroundZ;
    else if (surface.z[i] < floorZ) surface.z[i] = floorZ;
  }

  const finishMap = dilateForTool(surface, finishRad, opts.finishingToolType === 'ball_nose');

  const segments: ToolpathSegment[] = [];
  const gcode: string[] = [];
  let cutDistance = 0;
  let cutSeconds = 0;
  let rapidDistance = 0;

  // Rapids and plunges are a real share of a raster job's clock, so they are
  // tracked rather than assumed away.
  let atX = 0;
  let atY = 0;
  let atZ = opts.safeZ;

  const rapidTo = (x: number, y: number, z: number) => {
    rapidDistance += Math.hypot(x - atX, y - atY) + Math.abs(z - atZ);
    atX = x; atY = y; atZ = z;
  };
  const plungeTo = (z: number, rate: number) => {
    cutSeconds += (Math.abs(z - atZ) / Math.max(1, rate)) * 60;
    atZ = z;
  };
  const cutTo = (x: number, y: number, z: number, rate: number) => {
    const d = Math.hypot(x - atX, y - atY, z - atZ);
    cutDistance += d;
    cutSeconds += (d / Math.max(1, rate)) * 60;
    atX = x; atY = y; atZ = z;
  };

  gcode.push('; ---------------------------------------------------------------');
  gcode.push('; 3D CNC Relief Carving');
  gcode.push(`; Stock       : ${stockW} x ${stockD} x ${opts.stockThicknessMm} mm`);
  gcode.push(`; Relief depth: ${carveDepth} mm below the top face`);
  gcode.push(`; Model scale : ${(scaleFactor * 100).toFixed(1)}% (${(modelW * scaleFactor).toFixed(1)} x ${(modelD * scaleFactor).toFixed(1)} mm)`);
  gcode.push('; Origin      : near-left corner of the stock, top face, Z0');
  gcode.push(`; Extents     : X0..${f(stockW)}  Y0..${f(stockD)} (all cuts are +X +Y of zero)`);
  gcode.push('; ---------------------------------------------------------------');
  gcode.push('G21 ; millimetres');
  gcode.push('G90 ; absolute positioning');
  gcode.push('G94 ; feed per minute');
  gcode.push(`G0 Z${f(opts.safeZ)}`);
  gcode.push(`M3 S${Math.round(opts.spindleRpm)} ; spindle on`);
  gcode.push('G4 P2 ; let the spindle come up to speed');

  // --- Roughing --------------------------------------------------------------
  let roughingPassCount = 0;
  const roughRad = Math.max(0.05, opts.roughingToolDiaMm / 2);
  const allowance = Math.max(0, opts.roughingAllowanceMm);

  if (opts.roughingEnabled) {
    const roughMap = dilateForTool(surface, roughRad, false);
    const stepdown = Math.max(0.1, opts.roughingStepdownMm);
    const roughStepover = Math.max(0.2, opts.roughingToolDiaMm * 0.45);

    // Deepest the roughing tool is allowed to go: the allowance above the
    // lowest point it can reach at all.
    let deepest = 0;
    for (let i = 0; i < roughMap.z.length; i++) {
      if (roughMap.z[i] < deepest) deepest = roughMap.z[i];
    }
    const roughFloor = deepest + allowance;

    const layers: number[] = [];
    for (let z = -stepdown; z > roughFloor + 1e-6; z -= stepdown) layers.push(z);
    if (roughFloor < -1e-6) layers.push(roughFloor);
    roughingPassCount = layers.length;

    if (layers.length > 0) {
      gcode.push('; --- OP 1: roughing ---------------------------------------------');
      gcode.push(`; ${opts.roughingToolDiaMm} mm flat end mill, ${stepdown} mm stepdown, ${allowance} mm left on`);
    }

    const xs = axisSamples(bounds.minX + roughRad, bounds.maxX - roughRad, res);
    const ys = axisSamples(bounds.minY + roughRad, bounds.maxY - roughRad, roughStepover);

    for (const layerZ of layers) {
      let forward = true;

      for (const y of ys) {
        const lineXs = forward ? xs : [...xs].reverse();
        forward = !forward;

        // A run is the stretch of this line where there is still material below
        // the layer height and the tool can reach it without gouging.
        let run: PathPoint[] = [];
        const flushRun = () => {
          if (run.length >= 2) {
            rapidTo(run[0].x, run[0].y, opts.safeZ);
            plungeTo(layerZ, opts.roughingPlungeRate);
            gcode.push(`G0 X${f(run[0].x)} Y${f(run[0].y)}`);
            gcode.push(`G1 Z${f(layerZ)} F${Math.round(opts.roughingPlungeRate)}`);

            const last = run[run.length - 1];
            cutTo(last.x, last.y, layerZ, opts.roughingFeedrate);
            gcode.push(`G1 X${f(last.x)} Y${f(last.y)} F${Math.round(opts.roughingFeedrate)}`);
            gcode.push(`G0 Z${f(opts.safeZ)}`);
            atZ = opts.safeZ;

            // One segment per run: the preview must not draw a line across the
            // gap the tool actually flew over at safe height.
            segments.push({ type: 'roughing', points: [run[0], run[run.length - 1]] });
          }
          run = [];
        };

        for (const x of lineXs) {
          const target = sampleHeightmap(roughMap, x, y) + allowance;
          if (target <= layerZ - 1e-6) run.push({ x, y, z: layerZ });
          else flushRun();
        }
        flushRun();
      }
    }
  }

  // --- Tool change -----------------------------------------------------------
  const toolChange =
    opts.roughingEnabled && Math.abs(opts.roughingToolDiaMm - opts.finishingToolDiaMm) > 0.01;
  if (toolChange) {
    gcode.push('M5 ; spindle off for the tool change');
    gcode.push(`G0 Z${f(Math.max(opts.safeZ, 20))}`);
    gcode.push(`T2 M6 ; fit the ${opts.finishingToolDiaMm} mm ${opts.finishingToolType === 'ball_nose' ? 'ball-nose' : 'flat'} mill and re-zero Z`);
    gcode.push(`M3 S${Math.round(opts.spindleRpm)}`);
    gcode.push('G4 P2');
    atZ = Math.max(opts.safeZ, 20);
  }

  // --- Finishing -------------------------------------------------------------
  gcode.push('; --- OP 2: finishing raster -------------------------------------');
  gcode.push(
    `; ${opts.finishingToolDiaMm} mm ${opts.finishingToolType === 'ball_nose' ? 'ball-nose' : 'flat'} mill, ` +
      `${stepover.toFixed(2)} mm stepover along ${opts.finishingDirection.toUpperCase()}`
  );

  const alongX = opts.finishingDirection === 'x';
  // The sweep runs the full width of the stock; the passes step across it.
  const sweep = axisSamples(
    (alongX ? bounds.minX : bounds.minY) + finishRad,
    (alongX ? bounds.maxX : bounds.maxY) - finishRad,
    res
  );
  const across = axisSamples(
    (alongX ? bounds.minY : bounds.minX) + finishRad,
    (alongX ? bounds.maxY : bounds.maxX) - finishRad,
    stepover
  );

  let finishingRasterLines = 0;
  let forward = true;

  for (const a of across) {
    const line = forward ? sweep : [...sweep].reverse();
    forward = !forward;

    const raw: PathPoint[] = line.map((s) => {
      const x = alongX ? s : a;
      const y = alongX ? a : s;
      const z = Math.min(0, Math.max(floorZ, sampleHeightmap(finishMap, x, y)));
      return { x, y, z };
    });

    // Stretches where the tool would only skim the stock's own top face have no
    // material under them. Flying over them instead of tracing them is what
    // keeps a small model on a big board from costing a full-board raster.
    const runs: PathPoint[][] = [];
    let run: PathPoint[] = [];
    for (const p of raw) {
      if (p.z < -1e-6) run.push(p);
      else if (run.length > 0) { runs.push(run); run = []; }
    }
    if (run.length > 0) runs.push(run);

    for (const r of runs) {
      const pass = simplifyPass(r, PATH_SIMPLIFY_MM);
      if (pass.length < 2) continue;
      finishingRasterLines++;

      rapidTo(pass[0].x, pass[0].y, opts.safeZ);
      gcode.push(`G0 X${f(pass[0].x)} Y${f(pass[0].y)}`);
      plungeTo(pass[0].z, opts.finishingPlungeRate);
      gcode.push(`G1 Z${f(pass[0].z)} F${Math.round(opts.finishingPlungeRate)}`);

      // GRBL keeps the last feedrate, so it is only stated when it changes.
      let first = true;
      for (let i = 1; i < pass.length; i++) {
        const p = pass[i];
        cutTo(p.x, p.y, p.z, opts.finishingFeedrate);
        gcode.push(
          `G1 X${f(p.x)} Y${f(p.y)} Z${f(p.z)}${first ? ` F${Math.round(opts.finishingFeedrate)}` : ''}`
        );
        first = false;
      }

      gcode.push(`G0 Z${f(opts.safeZ)}`);
      atZ = opts.safeZ;
      segments.push({ type: 'finishing', points: pass });
    }
  }

  if (finishingRasterLines === 0) {
    return empty('The chosen stock and stepover produced no finishing passes.');
  }

  gcode.push('; ---------------------------------------------------------------');
  gcode.push('M5 ; spindle off');
  gcode.push(`G0 Z${f(opts.safeZ)}`);
  gcode.push('G0 X0 Y0 ; back to the work origin');
  gcode.push('M30 ; end of program');

  let text = gcode.join('\n');
  if (opts.applyMeshLeveling && opts.meshLevelGrid) {
    text = warpGcode(text, opts.meshLevelGrid);
  }

  // Preview only needs the shape of the path, and a raster has far more points
  // than a viewport can usefully draw.
  const totalPreview = segments.reduce((n, s) => n + s.points.length, 0);
  const stride = Math.max(1, Math.ceil(totalPreview / MAX_PREVIEW_POINTS));
  const previewSegments =
    stride === 1
      ? segments
      : segments.map((s) => {
          const points = s.points.filter((_, i) => i % stride === 0);
          const last = s.points[s.points.length - 1];
          if (points[points.length - 1] !== last) points.push(last);
          return { type: s.type, points };
        });

  return {
    success: true,
    gcode: text,
    totalCutDistanceMm: cutDistance,
    estimatedTimeSeconds: cutSeconds + (rapidDistance / RAPID_FEEDRATE) * 60,
    roughingPassCount,
    finishingRasterLines,
    toolChange,
    scaleFactor,
    carveBounds,
    bounds,
    segments: previewSegments,
    warnings,
  };
}
