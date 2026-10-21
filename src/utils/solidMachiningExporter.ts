// ---------------------------------------------------------------------------
// Solid part machining — cut the model itself out of a block
// ---------------------------------------------------------------------------
//
// The relief exporter squashes a model into the face of a board. This one
// makes the model: the part at true scale, cut out of a block of stock on a
// three-axis router, the way a machinist would do it by hand — face the top,
// machine everything that can be seen from above down to a channel round the
// part, then flip the block over on a pair of pins and machine the other side
// until the two cuts meet. What holds the part while that happens is a set of
// tabs left across the channel, sawn off afterwards.
//
// A three-axis machine sees a part as a heightmap from each direction it can
// look at it, so each side is exactly the surface-machining job the relief
// exporter already knows how to do (see `machineSurface`). What this file adds
// is everything around that: where the part sits in the block, the channel and
// the frame, the tabs, the pins the flip registers on, the mirror that turns
// side A's coordinates into side B's, and an honest count of the material
// neither side can reach.
//
// Everything is millimetres in work coordinates: origin at the near-left corner
// of the stock's top face, cuts running negative Z. The same convention as the
// relief and contour exports, and the corner the machine panel zeros on.

import type { SceneGraph } from '../types/scene';
import { collectSceneTriangles } from './contourSliceExporter';
import {
  DEFAULT_RELIEF_OPTIONS,
  deriveReliefFeeds,
  machineSurface,
  MAX_REACH_DIAMETERS,
  type Heightmap,
  type ReliefCarveOptions,
  type StockTransform,
  type SurfaceMachiningResult,
  type ToolpathSegment,
} from './reliefCarveExporter';
import { materialSpec, type SpindleRange } from './feedsAndSpeeds';
import { ORIENT_MATRIX, orient, type BlockFace, type UpAxis } from './orient';
import { generateSetups, sidesAsSetups, type SetupPlanSummary, type SolidSetupResult } from './solidSetups';

export type { UpAxis };

/** The options that only mean something to a relief, and are not offered here. */
type ReliefOnly =
  | 'carveDepthMm'
  | 'verticalScaleMode'
  | 'verticalExaggeration'
  | 'fitMode'
  | 'backgroundMode'
  | 'invertRelief'
  | 'stockWidthMm'
  | 'stockDepthMm'
  | 'stockThicknessMm';

export interface SolidMachiningOptions extends Omit<ReliefCarveOptions, ReliefOnly> {
  /**
   * One side or two.
   *
   * A part with a flat bottom — a bracket lying on its plate, a plaque, a
   * cam — is finished from above alone, held by tabs at the bottom of the
   * channel. Anything with shape underneath needs the block turned over and
   * cut again from the other side.
   */
  sides: 1 | 2;
  /** Which model axis points at the spindle in the first setup. */
  up: UpAxis;
  /** Plan-view scale as a percentage; 100 cuts the model the size it was drawn. */
  scalePercent: number;
  /**
   * Stock size, or 0 to take it from the part.
   *
   * Auto is the part's footprint plus a channel and a frame on every side,
   * and the part's height plus a skin on every machined face. Given sizes are
   * used as they are, with the part centred in them.
   */
  stockWidthMm: number;
  stockDepthMm: number;
  stockThicknessMm: number;
  /**
   * The board the operator has, when the block is to be cut from it: what the
   * dialogs and MCP plan with. Too small for the part and the job is refused;
   * near enough the block the job wants, it is used as it is, the part
   * centred in it; much bigger, or bigger where a side setup needs the block
   * flush with the part, and the job is planned on the block the part needs,
   * with `boardPrep` saying what to cut the board down to first.
   */
  board?: { widthMm: number; depthMm: number; thicknessMm: number } | null;
  /**
   * Width of the channel cut round the part, down to the floor. 0 derives one
   * from the roughing cutter: wide enough for it to get round every corner
   * with room to clear chips.
   */
  moatWidthMm: number;
  /**
   * Stock left standing outside the channel, all the way round. It is what the
   * clamps hold and what the tabs hold the part to, and on a two-sided job it
   * is also where the registration pins go.
   */
  frameWidthMm: number;
  /**
   * Stock above the part's top face, faced off at the start of each side. A
   * sawn or extruded surface is neither flat nor at a known height, so the
   * part's top is put a little below the stock's and everything above it is
   * skimmed away.
   */
  topSkinMm: number;
  /** Bridges left across the channel to hold the part. 0 leaves it loose, which is a bad idea. */
  tabCount: number;
  /** Width of each tab along the part's edge, mm. */
  tabWidthMm: number;
  /** Height of each tab, mm — how much you have to saw through afterwards. */
  tabThicknessMm: number;
  /**
   * Bore two holes through the frame on the first side, for the dowel pins
   * the flipped block lands back on. Without them the second side lines up
   * with the first only as well as the operator can re-zero.
   */
  registrationPins: boolean;
  /**
   * Dowel diameter, mm. Bored with the roughing cutter, so it has to be at
   * least as wide as that: 8 mm suits a 1/4" mill, and 8 mm dowel is a stock
   * item.
   */
  pinDiaMm: number;
  /** How far past the bottom of the stock the pin holes go, into the spoilboard. */
  pinDepthMm: number;
  /**
   * On a one-sided job, how far past the bottom of the stock the channel is
   * cut, into the spoilboard, so the part is cut clean through rather than
   * left on a skin.
   */
  throughCutMm: number;
  /**
   * How many setups, or which faces. Absent, 1 or 2 is `sides` as it has
   * always been. 'auto' lets the planner choose the way up and the faces,
   * the fewest that reach the part; a list of faces (named as the block
   * stands for setup 1) uses those.
   */
  setups?: 'auto' | 1 | 2 | BlockFace[];
  /** With 'auto', at most this many setups. Default 6, one per face. */
  maxSetups?: number;
  /** With 'auto', whether the planner may choose a different way up. Default true. */
  autoOrient?: boolean;
  /** Height free under the spindle above the bed, mm, for a block stood on end. 0 is unknown. */
  clearanceMm?: number;
  /**
   * Sides of an automatically sized block that end flush with the part: no
   * channel and no frame there. Set by the setup planner for a side the block
   * is stood on, so the bit goes straight into the part instead of first
   * through 15-20 mm of stock. The top and flip run off that edge.
   */
  flushFaces?: BlockFace[];
}

export const DEFAULT_SOLID_OPTIONS: SolidMachiningOptions = {
  ...(() => {
    // Everything the two exporters share starts from the relief defaults, so
    // the tooling a person has seen in one dialog is the tooling in the other.
    const {
      carveDepthMm: _d, verticalScaleMode: _v, verticalExaggeration: _e, fitMode: _f,
      backgroundMode: _b, invertRelief: _i, stockWidthMm: _w, stockDepthMm: _sd,
      stockThicknessMm: _t, ...shared
    } = DEFAULT_RELIEF_OPTIONS;
    void _d; void _v; void _e; void _f; void _b; void _i; void _w; void _sd; void _t;
    return shared;
  })(),
  sides: 2,
  up: '+z',
  scalePercent: 100,
  stockWidthMm: 0,
  stockDepthMm: 0,
  stockThicknessMm: 0,
  moatWidthMm: 0,
  frameWidthMm: 15,
  topSkinMm: 1,
  tabCount: 4,
  tabWidthMm: 6,
  tabThicknessMm: 2,
  registrationPins: true,
  pinDiaMm: 8,
  pinDepthMm: 8,
  throughCutMm: 0.2,
  // A solid part is machined to size, so the finishing bit is a flat mill by
  // default: it leaves walls square and flats flat, where a ball nose leaves
  // scallops on both.
  finishingToolType: 'flat',
  finishingStepoverPercent: 30,
  // Hybrid, as for a relief. A raster leaves a wall square only where its
  // passes cross it; where they run along it, the wall is the side of
  // whichever pass came nearest, a stepover apart: a 100 mm cylinder came out
  // striped and up to 1 mm proud down its sides. The waterline takes the
  // walls to within half a sample (49.55-50.35 mm on that 50 mm radius) for
  // 131 minutes a side against 103.
  finishingStrategy: 'hybrid',
};

/** A plan-view mask on a grid over the stock, its (0, 0) sample at (minX, minY). */
export interface PartFootprint {
  minX: number;
  minY: number;
  stepX: number;
  stepY: number;
  cols: number;
  rows: number;
  mask: Uint8Array;
}

/** One setup's worth of program. */
export interface SolidSideResult extends SurfaceMachiningResult {
  /** 'A' for the first side, 'B' for the second. */
  side: 'A' | 'B';
  /** Deepest this side cuts below its own top face, mm. */
  depthMm: number;
}

export interface SolidMachiningResult {
  success: boolean;
  error?: string;
  warnings: string[];
  /** One program per setup, in the order they are run. */
  sides: SolidSideResult[];
  /** The stock the job wants, in mm. */
  stock: { widthMm: number; depthMm: number; thicknessMm: number };
  /** What to cut the board down to before the first setup, when it has to be. */
  boardPrep?: string;
  /** The stock block in work coordinates, for the preview and the travel check. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number; minZ: number; maxZ: number };
  /** Where the part lands on the stock, plan view. */
  partBounds: { minX: number; minY: number; maxX: number; maxY: number };
  /**
   * The part's own outline on side A's stock, as the columns it was sampled
   * on: 1 where the part has material. The bounding box above also takes in
   * the stock round a part that is not a rectangle.
   */
  footprint?: PartFootprint;
  /** The part as cut, mm. */
  partSizeMm: { x: number; y: number; z: number };
  /** Part volume from the mesh, mm³. */
  partVolumeMm3: number;
  /**
   * Share of the part's volume that stays uncut because no side can see it —
   * the underside of a horizontal hole, the roof of a slot. 0 for anything a
   * three-axis machine can make in two setups.
   */
  unreachablePercent: number;
  /** Tabs actually placed. Fewer than asked for means the edge had no room. */
  tabsPlaced: number;
  /**
   * Each tab, by the outline cell it is joined to (stock mm), and the heights
   * it spans in side A's coordinates (stock top 0, negative down).
   */
  tabs: { x: number; y: number; topZ: number; bottomZ: number }[];
  /** Registration pin centres in work coordinates, if bored. */
  pins: { x: number; y: number }[];
  /**
   * Every setup in the order it runs, when the job was planned (`setups`
   * 'auto' or a list of faces). The top and the flip are `sides` again, here
   * with their frames; the turns onto the block's sides are only here.
   */
  setups?: SolidSetupResult[];
  /** What the plan leaves and why, when there is a plan. */
  plan?: SetupPlanSummary;
  /** The way up the planner chose, which may not be the one asked for. */
  upChosen?: UpAxis;
  /**
   * How the model was turned and put in the stock, side A's frame, so a
   * simulated cut can be put back on the model.
   */
  stockTransform?: StockTransform;
  estimatedTimeSeconds: number;
  totalCutDistanceMm: number;
}

/** Beyond this the heightmap costs more than the extra fidelity is worth. */
const MAX_HEIGHTMAP_CELLS = 260_000;

/**
 * The largest part, any way, this will plan. A router's bed is about a metre
 * and a half and no bit reaches a metre down; past this the plan only takes
 * minutes, and a few metres overflowed the page.
 */
export const MAX_SOLID_PART_MM = 1000;

/** What a part this big opens at in the dialog when 100% will not do. */
const FIT_PART_MM = 200;

/**
 * A round scale that brings a part `naturalMm` across at 100% to about
 * FIT_PART_MM: 100 when it is already no bigger than MAX_SOLID_PART_MM.
 */
export function fittingScalePercent(naturalMm: number): number {
  if (!(naturalMm > MAX_SOLID_PART_MM)) return 100;
  const exact = (100 * FIT_PART_MM) / naturalMm;
  // Two significant figures: 5.4%, not 5.3717%.
  const p = 10 ** (Math.floor(Math.log10(exact)) - 1);
  return Math.max(0.01, +(Math.floor(exact / p) * p).toPrecision(2));
}

/** The two sides' channels overlap by this much at the midplane, so they meet. */
const SIDE_OVERLAP_MM = 0.5;

/** Tabs are looked for on the part's outline this far apart, as a fraction of a full turn. */
const TAB_SEARCH_STEPS = 720;
/** A pin hole whose helix radius is under this is drilled in pecks instead. */
const PECK_BELOW_MM = 0.25;
/** How far above the hole (or the last peck) a peck drill starts and clears to. */
const PECK_CLEAR_MM = 0.5;

function f(num: number): string {
  return (Math.round(num * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '') || '0';
}

/**
 * The part as a set of vertical columns: for each cell, the height of its
 * upper surface, its lower surface, and how much of the column is actually
 * inside the part.
 *
 * Three numbers rather than the one a heightmap keeps, because this job looks
 * at the part from both sides and needs to know what is left in between. The
 * top and bottom are the two heightmaps; the thickness, summed over the hits
 * in pairs, is the truth they are compared against.
 */
export function sampleColumns(
  tris: Float64Array,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  cols: number,
  rows: number
): { top: Float32Array; bottom: Float32Array; thickness: Float32Array; hit: Uint8Array } {
  const stepX = cols > 1 ? (bounds.maxX - bounds.minX) / (cols - 1) : 0;
  const stepY = rows > 1 ? (bounds.maxY - bounds.minY) / (rows - 1) : 0;
  const top = new Float32Array(cols * rows).fill(-Infinity);
  const bottom = new Float32Array(cols * rows).fill(Infinity);
  const thickness = new Float32Array(cols * rows);
  const hit = new Uint8Array(cols * rows);

  const triCount = tris.length / 9;
  if (triCount === 0) return { top, bottom, thickness, hit };

  // Bucketed by plan-view bounding box, as buildHeightmap does, so each column
  // only tests the triangles that could be over it.
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

  // Sampled a hundredth of a cell off the grid lines. A model drawn on a
  // millimetre grid puts its faces on round numbers, and so does a sampling
  // grid, so rays land exactly on edges — where a vertical face is skipped as
  // having no plan area and a slanted one is hit twice — and the count of
  // hits comes out wrong for a whole row at a time. Off the line, they don't.
  const NUDGE = 0.0137;
  const midRow = (rows - 1) * 0.5;
  const midCol = (cols - 1) * 0.5;
  const hitZ: number[] = [];
  const hitDir: number[] = [];
  const order: number[] = [];
  for (let row = 0; row < rows; row++) {
    const nudgeY = row < midRow ? NUDGE : row > midRow ? -NUDGE : 0;
    const py = bounds.minY + (row + nudgeY) * stepY;
    const br = bucketRow(py);
    for (let col = 0; col < cols; col++) {
      const nudgeX = col < midCol ? NUDGE : col > midCol ? -NUDGE : 0;
      const px = bounds.minX + (col + nudgeX) * stepX;
      const bucket = buckets[br * side + bucketCol(px)];
      if (bucket.length === 0) continue;
      hitZ.length = 0;
      hitDir.length = 0;

      for (const i of bucket) {
        const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
        const bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5];
        const cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];
        const v0x = cx - ax, v0y = cy - ay;
        const v1x = bx - ax, v1y = by - ay;
        const v2x = px - ax, v2y = py - ay;
        const den = v0x * v1y - v1x * v0y;
        if (den === 0) continue;
        const u = (v2x * v1y - v1x * v2y) / den;
        const v = (v0x * v2y - v2x * v0y) / den;
        if (u < 0 || v < 0 || u + v > 1) continue;
        hitZ.push(az + u * (cz - az) + v * (bz - az));
        // Which way the face looks. `den` is minus the Z of the face normal,
        // so a positive one is a face looking down — the underside of a
        // solid, which a ray travelling upward enters.
        hitDir.push(den > 0 ? 1 : -1);
      }
      if (hitZ.length === 0) continue;

      order.length = hitZ.length;
      for (let h = 0; h < order.length; h++) order[h] = h;
      order.sort((a, b) => hitZ[a] - hitZ[b]);

      const k = row * cols + col;
      hit[k] = 1;
      top[k] = hitZ[order[order.length - 1]];
      bottom[k] = hitZ[order[0]];

      // Inside the part wherever more solids have been entered than left.
      //
      // A winding count rather than pairing the hits off, because a model
      // is often a union of overlapping pieces that were never merged — a
      // gusset sunk a millimetre into the arm it braces — and pairing reads
      // the overlap as a gap. A ray hitting the shared edge of two triangles
      // of one face sees that face twice, which the count survives only if
      // the duplicate is dropped: coincident hits facing the same way are one.
      let inside = 0;
      let depth = 0;
      let lastZ = NaN;
      let lastDir = 0;
      let enteredAt = 0;
      for (let h = 0; h < order.length; h++) {
        const z = hitZ[order[h]];
        const dir = hitDir[order[h]];
        if (dir === lastDir && Math.abs(z - lastZ) <= 1e-4) continue;
        if (dir > 0) {
          if (depth === 0) enteredAt = z;
          depth++;
        } else {
          depth--;
          if (depth === 0) inside += z - enteredAt;
        }
        lastZ = z;
        lastDir = dir;
      }
      // A mesh whose faces do not agree on which way is out never closes the
      // count. The span from bottom to top is the honest fallback for that.
      thickness[k] = depth === 0 ? inside : top[k] - bottom[k];
    }
  }

  return { top, bottom, thickness, hit };
}

/**
 * Exact Euclidean distance from every cell to the nearest set cell, in cells.
 *
 * Felzenszwalb and Huttenlocher's two-pass parabola method: a 1D transform
 * down every column, then along every row of the result. Linear in the number
 * of cells, where scanning a kernel round each cell is quadratic in the
 * channel width — and the channel here is tens of cells wide.
 */
function distanceTransform(mask: Uint8Array, cols: number, rows: number): Float32Array {
  const INF = 1e20;
  const g = new Float32Array(cols * rows);
  for (let i = 0; i < g.length; i++) g[i] = mask[i] ? 0 : INF;

  const n = Math.max(cols, rows);
  const fIn = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);

  const edt1d = (len: number) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = ((fIn[q] + q * q) - (fIn[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = ((fIn[q] + q * q) - (fIn[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + fIn[v[k]];
    }
  };

  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) fIn[r] = g[r * cols + c];
    edt1d(rows);
    for (let r = 0; r < rows; r++) g[r * cols + c] = d[r];
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) fIn[c] = g[r * cols + c];
    edt1d(cols);
    for (let c = 0; c < cols; c++) g[r * cols + c] = Math.sqrt(d[c]);
  }
  return g;
}

/**
 * Cells not under the part that can be reached from the edge of the stock.
 *
 * What is left — empty cells the part surrounds — is a hole or a pocket, which
 * is cut to the floor rather than left standing as an island the last pass
 * would set loose under a spinning cutter.
 */
function outsideMask(hit: Uint8Array, cols: number, rows: number): Uint8Array {
  const outside = new Uint8Array(cols * rows);
  const stack: number[] = [];
  const push = (k: number) => {
    if (!hit[k] && !outside[k]) {
      outside[k] = 1;
      stack.push(k);
    }
  };
  for (let c = 0; c < cols; c++) {
    push(c);
    push((rows - 1) * cols + c);
  }
  for (let r = 0; r < rows; r++) {
    push(r * cols);
    push(r * cols + cols - 1);
  }
  while (stack.length > 0) {
    const k = stack.pop()!;
    const r = Math.floor(k / cols);
    const c = k - r * cols;
    if (c > 0) push(k - 1);
    if (c < cols - 1) push(k + 1);
    if (r > 0) push(k - cols);
    if (r < rows - 1) push(k + cols);
  }
  return outside;
}

/**
 * Where the tabs go: strips across the channel from the part's outline to the
 * frame, spread evenly round the part.
 *
 * Evenly by angle about the part's centre, because that is what "spread out"
 * means for a shape nobody has described in advance: four tabs on a rectangle
 * land one per side, and on an L they land where the outline actually is
 * rather than in the notch. Each tab runs from its outline cell towards the
 * nearest frame cell, which is the shortest way across the channel and so the
 * one that is sure to reach.
 */
function placeTabs(
  hit: Uint8Array,
  moat: Uint8Array,
  frame: Uint8Array,
  cols: number,
  rows: number,
  cellMm: number,
  count: number,
  tabWidthMm: number,
  moatWidthMm: number
): { mask: Int32Array; anchors: number[] } {
  // Which tab each channel cell belongs to, 1-based; 0 for none.
  const mask = new Int32Array(cols * rows);
  const anchors: number[] = [];
  if (count <= 0) return { mask, anchors };

  // The outline: part cells with a channel cell beside them.
  let cxSum = 0, cySum = 0, n = 0;
  const outline: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      if (!hit[k]) continue;
      cxSum += c; cySum += r; n++;
      if (
        (c > 0 && moat[k - 1]) || (c < cols - 1 && moat[k + 1]) ||
        (r > 0 && moat[k - cols]) || (r < rows - 1 && moat[k + cols])
      ) outline.push(k);
    }
  }
  if (n === 0 || outline.length === 0) return { mask, anchors };
  const cx = cxSum / n;
  const cy = cySum / n;

  // Outline cells by bearing from the centre, so a target bearing can be
  // answered with the nearest cell to it.
  const byAngle = outline
    .map((k) => {
      const r = Math.floor(k / cols);
      const c = k - r * cols;
      return { k, c, r, a: Math.atan2(r - cy, c - cx) };
    })
    .sort((p, q) => p.a - q.a);

  const reach = Math.ceil(moatWidthMm / cellMm) + 2;
  const halfW = tabWidthMm / 2 / cellMm;
  /*
   * How far apart two tabs' anchors must be, in cells. Bearings are spread
   * evenly about the centre, but the outline is not: on a long thin bar two
   * bearings land a couple of millimetres apart on its long side, and two
   * tabs were reported where there was one, cut twice.
   */
  const spacing = (1.5 * tabWidthMm) / cellMm;

  for (let i = 0; i < count; i++) {
    const want = -Math.PI + ((i + 0.5) * 2 * Math.PI) / count;
    // Nearest outline cell by bearing, trying its neighbours in turn when the
    // one found has no frame within reach — an inside corner, say.
    let lo = 0, hi = byAngle.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (byAngle[mid].a < want) lo = mid + 1; else hi = mid;
    }
    let done = false;
    for (let step = 0; step < TAB_SEARCH_STEPS && !done; step++) {
      const idx = (lo + (step % 2 === 0 ? step / 2 : -(step + 1) / 2) + byAngle.length * 4) % byAngle.length;
      const p = byAngle[idx];
      if (anchors.some((k) => {
        const r = Math.floor(k / cols);
        return Math.hypot(k - r * cols - p.c, r - p.r) < spacing;
      })) continue;

      // Nearest frame cell within reach of the channel's width.
      let best = Infinity, bc = 0, br = 0;
      for (let dr = -reach; dr <= reach; dr++) {
        const r = p.r + dr;
        if (r < 0 || r >= rows) continue;
        for (let dc = -reach; dc <= reach; dc++) {
          const c = p.c + dc;
          if (c < 0 || c >= cols) continue;
          if (!frame[r * cols + c]) continue;
          const d2 = dr * dr + dc * dc;
          if (d2 < best) { best = d2; bc = c; br = r; }
        }
      }
      if (best === Infinity) continue;

      const len = Math.sqrt(best);
      const nx = (bc - p.c) / len;
      const ny = (br - p.r) / len;
      // Every channel cell in the strip from the outline to the frame.
      const box = Math.ceil(len + halfW) + 1;
      for (let dr = -box; dr <= box; dr++) {
        const r = p.r + dr;
        if (r < 0 || r >= rows) continue;
        for (let dc = -box; dc <= box; dc++) {
          const c = p.c + dc;
          if (c < 0 || c >= cols) continue;
          const k = r * cols + c;
          if (!moat[k]) continue;
          const along = dc * nx + dr * ny;
          const across = -dc * ny + dr * nx;
          if (along >= -1 && along <= len + 1 && Math.abs(across) <= halfW && !mask[k]) {
            mask[k] = anchors.length + 1;
          }
        }
      }
      anchors.push(p.k);
      done = true;
    }
  }

  return { mask, anchors };
}

/**
 * A helical bore for one registration pin, as G-code lines.
 *
 * The tool circles down at the plunge rate on a helix the width of the pin
 * less its own diameter, then takes one flat lap at the bottom to true the
 * hole, and comes back up to safe Z. Circles are written as short lines
 * rather than arcs so that a controller without G2/G3 turned on cuts the same
 * hole.
 */
function pinBore(
  cx: number,
  cy: number,
  toolDiaMm: number,
  pinDiaMm: number,
  toZ: number,
  pitchMm: number,
  plungeRate: number,
  feedRate: number,
  safeZ: number
): string[] {
  const r = Math.max(0, (pinDiaMm - toolDiaMm) / 2);
  const out: string[] = [];
  const segs = 24;
  out.push(`; registration pin ${f(pinDiaMm)} mm at X${f(cx)} Y${f(cy)}`);
  out.push(`G0 Z${f(safeZ)}`);

  /*
   * No room for a helix: drilled, in pecks at the plunge rate.
   *
   * A helix with no radius is a straight plunge, and it was being fed at the
   * cutting rate - four times the plunge rate - the whole depth of the block
   * and on into the spoilboard, with nowhere for the chips to go. Each peck
   * is no deeper than the cutter is wide, and the tool comes out of the hole
   * after each to clear them.
   */
  if (r < PECK_BELOW_MM) {
    const peck = Math.max(0.5, Math.min(toolDiaMm, pitchMm));
    out.push(`G0 X${f(cx)} Y${f(cy)}`);
    out.push(`G0 Z${f(PECK_CLEAR_MM)}`);
    let z = 0;
    while (z > toZ + 1e-6) {
      const next = Math.max(toZ, z - peck);
      // Back down at rapid to just above the last peck's bottom.
      if (z < 0) out.push(`G0 Z${f(z + PECK_CLEAR_MM)}`);
      out.push(`G1 Z${f(next)} F${Math.round(plungeRate)}`);
      out.push(`G0 Z${f(PECK_CLEAR_MM)}`);
      z = next;
    }
    out.push(`G0 Z${f(safeZ)}`);
    return out;
  }

  out.push(`G0 X${f(cx + r)} Y${f(cy)}`);
  out.push(`G1 Z0 F${Math.round(plungeRate)}`);
  const turns = Math.max(1, Math.ceil(-toZ / Math.max(0.1, pitchMm)));
  const turnXY = 2 * Math.PI * r;
  const turnZ = -toZ / turns;
  const helixFeed = Math.min(
    feedRate,
    Math.max(1, (plungeRate * Math.hypot(turnXY, turnZ)) / Math.max(1e-6, turnZ))
  );
  const total = turns * segs;
  for (let i = 1; i <= total; i++) {
    const a = (i / segs) * 2 * Math.PI;
    const z = toZ * (i / total);
    out.push(`G1 X${f(cx + r * Math.cos(a))} Y${f(cy + r * Math.sin(a))} Z${f(z)} F${Math.round(helixFeed)}`);
  }
  for (let i = 1; i <= segs; i++) {
    const a = (i / segs) * 2 * Math.PI;
    out.push(`G1 X${f(cx + r * Math.cos(a))} Y${f(cy + r * Math.sin(a))} F${Math.round(feedRate)}`);
  }
  out.push(`G0 Z${f(safeZ)}`);
  return out;
}

/**
 * What a block of bore lines cuts, for the preview and the cut distance: each
 * stretch of feed moves between rapids as one segment of tip positions.
 */
function boreSegments(lines: string[]): { segments: ToolpathSegment[]; distanceMm: number } {
  const segments: ToolpathSegment[] = [];
  let x = 0, y = 0, z = 0, distanceMm = 0;
  let points: { x: number; y: number; z: number }[] = [];
  let traverseZ = 0;
  const word = (line: string, axis: string, was: number) => {
    const m = new RegExp(`${axis}(-?[\\d.]+)`).exec(line);
    return m ? parseFloat(m[1]) : was;
  };
  for (const raw of lines) {
    const line = raw.split(';')[0].trim();
    const g = /^G([01])\b/.exec(line);
    if (!g) continue;
    const nx = word(line, 'X', x), ny = word(line, 'Y', y), nz = word(line, 'Z', z);
    if (g[1] === '1') {
      if (points.length === 0) points.push({ x, y, z });
      points.push({ x: nx, y: ny, z: nz });
      distanceMm += Math.hypot(nx - x, ny - y, nz - z);
    } else {
      if (points.length > 1) segments.push({ type: 'roughing', points, traverseZ });
      points = [];
      traverseZ = Math.max(z, nz);
    }
    x = nx; y = ny; z = nz;
  }
  if (points.length > 1) segments.push({ type: 'roughing', points, traverseZ });
  return { segments, distanceMm };
}

/**
 * The part's size the way the job will see it, before any of the job is
 * planned: this way up, at this scale, in millimetres.
 *
 * The dialog needs it ahead of the export — the feeds are derated for the
 * depth of cut, and the depth of cut is the part's height — and it is far
 * cheaper than the export, so it is measured on its own.
 */
export function measurePart(
  scene: SceneGraph,
  up: UpAxis,
  scalePercent: number
): { x: number; y: number; z: number } | null {
  const { tris } = collectSceneTriangles(scene);
  if (tris.length === 0) return null;
  const scale = Math.max(0.01, scalePercent / 100) * 1000;
  let mnX = Infinity, mnY = Infinity, mnZ = Infinity;
  let mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    const [x, y, z] = orient(up, tris[i] * scale, tris[i + 1] * scale, tris[i + 2] * scale);
    if (x < mnX) mnX = x; if (x > mxX) mxX = x;
    if (y < mnY) mnY = y; if (y > mxY) mxY = y;
    if (z < mnZ) mnZ = z; if (z > mxZ) mxZ = z;
  }
  return { x: mxX - mnX, y: mxY - mnY, z: mxZ - mnZ };
}

/**
 * The options a job is actually cut with when nobody has tuned them: the
 * defaults, what was asked for, and then the feeds, speeds, stepdowns and
 * allowance worked out for that material, those cutters and this part's
 * height — what the dialog does before it shows its numbers.
 *
 * Without this, `material` only changed the label. The MCP export passed the
 * defaults straight to `generateSolidMachining`, which are a wood recipe, so
 * a job asked for in aluminium came out with hardwood's feeds and spindle
 * speed and a 2 mm base stepdown that adaptive clearing deepened to 3.67 mm on
 * a 3 mm cutter — where aluminium's own base is a tenth of the cutter.
 */
export function deriveSolidOptions(
  scene: SceneGraph,
  asked: Partial<SolidMachiningOptions>,
  spindle?: SpindleRange | null,
  maxFeedMmMin?: number
): SolidMachiningOptions {
  const opts: SolidMachiningOptions = { ...DEFAULT_SOLID_OPTIONS, ...asked };
  const part = measurePart(scene, opts.up, opts.scalePercent);
  return {
    ...opts,
    ...deriveReliefFeeds(
      {
        material: opts.material,
        finishingToolDiaMm: opts.finishingToolDiaMm,
        finishingFlutes: opts.finishingFlutes,
        roughingToolDiaMm: opts.roughingToolDiaMm,
        roughingFlutes: opts.roughingFlutes,
        carveDepthMm: part?.z ?? 10,
      },
      spindle,
      maxFeedMmMin
    ),
  };
}

/**
 * How deep each side of the job cuts, from the part and the options, without
 * running the job. The same arithmetic the exporter uses.
 */
export function sideDepthMm(partHeightMm: number, opts: SolidMachiningOptions): number {
  const skin = Math.max(0, opts.topSkinMm);
  const twoSided = opts.sides === 2;
  const wantT = partHeightMm + (twoSided ? 2 * skin : skin);
  const stockT = opts.stockThicknessMm > 0
    ? opts.stockThicknessMm
    : opts.board && opts.board.thicknessMm >= partHeightMm && opts.board.thicknessMm <= wantT + BOARD_SLACK_THICK_MM
      ? opts.board.thicknessMm
      : wantT;
  return twoSided ? stockT / 2 + SIDE_OVERLAP_MM : stockT + Math.max(0, opts.throughCutMm);
}

/** The scene's triangles turned `up` and scaled to mm, with their bounds. */
export function orientPart(sceneTris: ArrayLike<number>, up: UpAxis, scale: number) {
  const oriented = new Float64Array(sceneTris.length);
  let mnX = Infinity, mnY = Infinity, mnZ = Infinity;
  let mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity;
  for (let i = 0; i < sceneTris.length; i += 3) {
    const [x, y, z] = orient(up, sceneTris[i] * scale, sceneTris[i + 1] * scale, sceneTris[i + 2] * scale);
    oriented[i] = x; oriented[i + 1] = y; oriented[i + 2] = z;
    if (x < mnX) mnX = x; if (x > mxX) mxX = x;
    if (y < mnY) mnY = y; if (y > mxY) mxY = y;
    if (z < mnZ) mnZ = z; if (z > mxZ) mxZ = z;
  }
  return { oriented, mnX, mnY, mnZ, mxX, mxY, mxZ, partW: mxX - mnX, partD: mxY - mnY, partH: mxZ - mnZ };
}

/** The block a part needs: as given, or the part plus channel and frame, and its skins. */
function blockFor(partW: number, partD: number, partH: number, opts: SolidMachiningOptions) {
  const roughDia = opts.roughingEnabled ? opts.roughingToolDiaMm : opts.finishingToolDiaMm;
  const moat = opts.moatWidthMm > 0 ? opts.moatWidthMm : Math.max(3, roughDia * 1.5);
  const frame = Math.max(0, opts.frameWidthMm);
  const twoSided = opts.sides === 2;
  const skin = Math.max(0, opts.topSkinMm);
  const stockT =
    opts.stockThicknessMm > 0 ? opts.stockThicknessMm : partH + (twoSided ? 2 * skin : skin);
  const flush = new Set(opts.flushFaces ?? []);
  if (flush.size === 0) {
    const stockW = opts.stockWidthMm > 0 ? opts.stockWidthMm : partW + 2 * (moat + frame);
    const stockD = opts.stockDepthMm > 0 ? opts.stockDepthMm : partD + 2 * (moat + frame);
    return { stockW, stockD, stockT, partCx: stockW / 2, partCy: stockD / 2 };
  }
  // A flush side has no margin; the part sits against it.
  const m = moat + frame;
  const lo = (f: BlockFace) => (flush.has(f) ? 0 : m);
  const stockW = opts.stockWidthMm > 0 ? opts.stockWidthMm : partW + lo('-x') + lo('+x');
  const stockD = opts.stockDepthMm > 0 ? opts.stockDepthMm : partD + lo('-y') + lo('+y');
  const partCx = opts.stockWidthMm > 0 ? stockW / 2 : lo('-x') + partW / 2;
  const partCy = opts.stockDepthMm > 0 ? stockD / 2 : lo('-y') + partD / 2;
  return { stockW, stockD, stockT, partCx, partCy };
}

/** A board this much longer or wider than the block the job wants is cut down first. */
const BOARD_SLACK_PLAN_MM = 50;
/** A board this much thicker is planed or resawn first, rather than faced off for an hour. */
const BOARD_SLACK_THICK_MM = 10;

/**
 * The block the job is planned on. Without a board, `blockFor`. With one: the
 * board, if it holds the part and its channel and is not much bigger than the
 * block the part wants; the wanted block, with `prep` saying what to cut the
 * board down to, if it is much bigger or a side setup needs the block flush
 * with the part; `tooSmall` if it cannot hold the part at all.
 */
export function stockFor(partW: number, partD: number, partH: number, opts: SolidMachiningOptions) {
  const want = blockFor(partW, partD, partH, opts);
  const board = opts.board;
  if (!board) return { ...want, prep: null as string | null, tooSmall: null as string | null };

  const roughDia = opts.roughingEnabled ? opts.roughingToolDiaMm : opts.finishingToolDiaMm;
  const moat = opts.moatWidthMm > 0 ? opts.moatWidthMm : Math.max(3, roughDia * 1.5);
  const flush = new Set(opts.flushFaces ?? []);
  const lo = (face: BlockFace) => (flush.has(face) ? 0 : moat);
  // Sizes said to the operator are ones a saw can be set to: whole
  // millimetres, rounded up, or tenths where a side must end flush with the part.
  const up = (v: number, step: number) => Math.ceil(v / step - 1e-9) * step;
  const minW = up(partW + lo('-x') + lo('+x'), 1);
  const minD = up(partD + lo('-y') + lo('+y'), 1);
  if (board.widthMm < minW - 1e-6 || board.depthMm < minD - 1e-6 || board.thicknessMm < partH - 1e-6) {
    return {
      ...want, prep: null,
      tooSmall:
        `Your ${f(board.widthMm)} x ${f(board.depthMm)} x ${f(board.thicknessMm)} mm board is too small: ` +
        `this part needs at least ${minW} x ${minD} x ${up(partH, 1)} mm, and ${up(want.stockW, 1)} x ` +
        `${up(want.stockD, 1)} x ${up(want.stockT, 1)} mm with a full frame to clamp. Set the board in the status bar.`,
    };
  }

  const thick = board.thicknessMm > want.stockT + BOARD_SLACK_THICK_MM;
  const stockT = thick ? up(want.stockT, 1) : board.thicknessMm;
  const cutPlan =
    (flush.size > 0 && (board.widthMm > want.stockW + 0.5 || board.depthMm > want.stockD + 0.5)) ||
    board.widthMm > want.stockW + BOARD_SLACK_PLAN_MM ||
    board.depthMm > want.stockD + BOARD_SLACK_PLAN_MM;
  const step = flush.size > 0 ? 0.1 : 1;
  const cutW = +up(want.stockW, step).toFixed(1);
  const cutD = +up(want.stockD, step).toFixed(1);
  const sizes = [
    cutPlan ? `${cutW} x ${cutD} mm` : null,
    thick ? `${stockT} mm thick` : null,
  ].filter(Boolean).join(', ');
  const why = flush.size > 0 && cutPlan
    ? 'the side setups stand it on faces flush with the part'
    : 'the rest would only be faced and cut away';
  const prep = sizes ? `Cut the board down to ${sizes} first: ${why}.` : null;
  if (!cutPlan) {
    // The board as it is, the part centred in it.
    return { stockW: board.widthMm, stockD: board.depthMm, stockT, partCx: board.widthMm / 2, partCy: board.depthMm / 2, prep, tooSmall: null };
  }
  // What rounding up adds goes on the side away from a flush face, or half
  // each side when neither is: a flush face stays on the part.
  const shift = (lo: BlockFace, hi: BlockFace, spare: number) =>
    flush.has(lo) ? 0 : flush.has(hi) ? spare : spare / 2;
  return {
    stockW: cutW,
    stockD: cutD,
    stockT,
    partCx: want.partCx + shift('-x', '+x', cutW - want.stockW),
    partCy: want.partCy + shift('-y', '+y', cutD - want.stockD),
    prep,
    tooSmall: null,
  };
}

/** Oriented triangles centred in the stock in plan, their top at `topZ`. */
export function placeInStock(
  oriented: Float64Array,
  b: { mnX: number; mnY: number; mxX: number; mxY: number; mxZ: number },
  stockCx: number,
  stockCy: number,
  topZ: number
): Float64Array {
  const tris = new Float64Array(oriented.length);
  for (let i = 0; i < oriented.length; i += 3) {
    tris[i] = oriented[i] - (b.mnX + b.mxX) / 2 + stockCx;
    tris[i + 1] = oriented[i + 1] - (b.mnY + b.mxY) / 2 + stockCy;
    tris[i + 2] = oriented[i + 2] - b.mxZ + topZ;
  }
  return tris;
}

/**
 * Turns a scene into the programs that machine it out of a block.
 *
 * One or two sides as solid machining always has, or, with `setups` 'auto'
 * or a list of faces, as many setups as the part needs (`solidSetups.ts`).
 */
export function generateSolidMachining(
  scene: SceneGraph,
  userOptions?: Partial<SolidMachiningOptions>
): SolidMachiningResult {
  const opts: SolidMachiningOptions = { ...DEFAULT_SOLID_OPTIONS, ...userOptions };
  if (opts.setups === undefined) return generateSolidSides(scene, opts);
  if (opts.setups === 1 || opts.setups === 2) {
    const sided = { ...opts, sides: opts.setups };
    return sidesAsSetups(generateSolidSides(scene, sided), sided);
  }
  return generateSetups(scene, opts, { generateSides: generateSolidSides, orientPart, stockFor, placeInStock });
}

/** One side or two, the top and the flip. */
function generateSolidSides(
  scene: SceneGraph,
  userOptions?: Partial<SolidMachiningOptions>
): SolidMachiningResult {
  const opts: SolidMachiningOptions = { ...DEFAULT_SOLID_OPTIONS, ...userOptions };
  const warnings: string[] = [];

  const fail = (error: string): SolidMachiningResult => ({
    success: false,
    error,
    warnings,
    sides: [],
    stock: { widthMm: 0, depthMm: 0, thicknessMm: 0 },
    bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0, minZ: 0, maxZ: 0 },
    partBounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    partSizeMm: { x: 0, y: 0, z: 0 },
    partVolumeMm3: 0,
    unreachablePercent: 0,
    tabsPlaced: 0,
    tabs: [],
    pins: [],
    estimatedTimeSeconds: 0,
    totalCutDistanceMm: 0,
  });

  const { tris: sceneTris, skipped, warnings: sceneWarnings } = collectSceneTriangles(scene);
  warnings.push(...sceneWarnings);
  if (skipped.length > 0) warnings.push(`Skipped (no solid volume to cut): ${skipped.join(', ')}.`);
  if (sceneTris.length === 0) return fail('No solid geometry found in the scene to machine.');

  // --- The part, the right way up and at size -------------------------------
  const scale = Math.max(0.01, opts.scalePercent / 100) * 1000;
  const { oriented, mnX, mnY, mxX, mxY, mxZ, partW, partD, partH } = orientPart(sceneTris, opts.up, scale);
  if (partW <= 1e-6 || partD <= 1e-6 || partH <= 1e-6) {
    return fail('The scene has no volume in this orientation, so there is no part to cut.');
  }
  const largest = Math.max(partW, partD, partH);
  if (largest > MAX_SOLID_PART_MM) {
    const fit = fittingScalePercent(largest / opts.scalePercent * 100);
    return fail(
      `At ${opts.scalePercent}% the part is ${f(partW)} x ${f(partD)} x ${f(partH)} mm, past the ` +
        `${MAX_SOLID_PART_MM} mm a router can mill from solid. Scale it down: ${fit}% makes it ` +
        `${f((largest * fit) / opts.scalePercent)} mm at its largest.`
    );
  }

  // --- Stock, channel and frame ----------------------------------------------
  const roughDia = opts.roughingEnabled ? opts.roughingToolDiaMm : opts.finishingToolDiaMm;
  const moat = opts.moatWidthMm > 0 ? opts.moatWidthMm : Math.max(3, roughDia * 1.5);
  const frame = Math.max(0, opts.frameWidthMm);
  const twoSided = opts.sides === 2;

  const { stockW, stockD, stockT, partCx, partCy, prep, tooSmall } = stockFor(partW, partD, partH, opts);
  if (tooSmall) return fail(tooSmall);
  if (prep) warnings.unshift(prep);
  const flush = new Set(opts.flushFaces ?? []);

  if (stockW < partW - 1e-6 || stockD < partD - 1e-6) {
    const need = blockFor(partW, partD, partH, { ...opts, stockWidthMm: 0, stockDepthMm: 0, stockThicknessMm: 0 });
    return fail(
      `The ${stockW} x ${stockD} mm stock is smaller than the ${f(partW)} x ${f(partD)} mm part this way up. ` +
        `It needs at least ${f(need.stockW)} x ${f(need.stockD)} x ${f(need.stockT)} mm with its channel and frame: ` +
        `set a bigger board, or size the block to the part.`
    );
  }
  if (flush.size === 0 && (stockW < partW + 2 * moat || stockD < partD + 2 * moat)) {
    warnings.push(
      `The ${stockW} x ${stockD} mm stock is too small for the ${partW.toFixed(1)} x ` +
        `${partD.toFixed(1)} mm part with a ${moat.toFixed(1)} mm channel round it; the channel ` +
        `is cropped at the edge of the stock and the frame there is gone.`
    );
  }
  if (stockT < partH - 1e-6) {
    return fail(
      `The stock is ${stockT} mm thick and the part is ${partH.toFixed(1)} mm tall this way up. ` +
        `Use thicker stock, or turn the part so a shorter axis points up.`
    );
  }

  const bounds = { minX: 0, minY: 0, maxX: stockW, maxY: stockD, minZ: -stockT, maxZ: 0 };

  // Where the part sits: centred in plan, or against a flush side. Two-sided,
  // it is centred in the thickness too, so each side faces the same skin and
  // the cuts meet in the middle. One-sided, it sits on the bed and the spare
  // thickness is all skin on top.
  const stockCx = partCx;
  const stockCy = partCy;
  const topZ = twoSided ? -(stockT - partH) / 2 : -(stockT - partH);
  const tris = placeInStock(oriented, { mnX, mnY, mxX, mxY, mxZ }, stockCx, stockCy, topZ);
  const partBounds = {
    minX: Math.max(0, stockCx - partW / 2),
    minY: Math.max(0, stockCy - partD / 2),
    maxX: Math.min(stockW, stockCx + partW / 2),
    maxY: Math.min(stockD, stockCy + partD / 2),
  };

  // Each side's floor: through the middle on a two-sided job, through the
  // bottom and a touch into the spoilboard on a one-sided one.
  const depthA = sideDepthMm(partH, { ...opts, stockThicknessMm: stockT });
  const floorZ = -depthA;

  // --- Sample the part from above ---------------------------------------------
  const stepover = Math.max(
    0.05,
    (opts.finishingToolDiaMm * Math.min(100, Math.max(2, opts.finishingStepoverPercent))) / 100
  );
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
        `${stepover.toFixed(2)} mm stepover. Detail finer than that is smoothed out, and so is ` +
        `the part's size, by up to that much.`
    );
  }
  const stepX = cols > 1 ? stockW / (cols - 1) : res;
  const stepY = rows > 1 ? stockD / (rows - 1) : res;

  const { top, bottom, thickness, hit } = sampleColumns(tris, bounds, cols, rows);

  // What is round the part: the channel, the frame beyond it, and any hole
  // the part encloses.
  const outside = outsideMask(hit, cols, rows);
  const dist = distanceTransform(hit, cols, rows);
  const moatMask = new Uint8Array(cols * rows);
  const frameMask = new Uint8Array(cols * rows);
  const moatCells = moat / res;
  for (let k = 0; k < hit.length; k++) {
    if (hit[k]) continue;
    if (!outside[k]) continue; // enclosed: floor, handled below
    if (dist[k] <= moatCells) moatMask[k] = 1;
    else frameMask[k] = 1;
  }

  const tabs = placeTabs(
    hit, moatMask, frameMask, cols, rows, res,
    Math.max(0, Math.round(opts.tabCount)), opts.tabWidthMm, moat
  );
  const tabsPlaced = tabs.anchors.length;
  if (tabsPlaced < Math.round(opts.tabCount)) {
    warnings.push(
      `Only ${tabsPlaced} of ${Math.round(opts.tabCount)} tabs could be placed: the part's ` +
        `outline has no frame within reach at the other positions. Widen the frame, or ask for fewer.`
    );
  }
  if (tabsPlaced === 0) {
    warnings.push(
      `Nothing holds the part once the channel is through. It will come loose under the cutter ` +
        `on the last pass — add tabs, or fix the part down some other way.`
    );
  }
  /*
   * Each tab's height, from the part at the cell it is joined to.
   *
   * One-sided, a tab stands on the bottom of the stock, which is always solid
   * under the part. Two-sided, it was put at the stock's midplane whatever the
   * part was doing there - and where the edge does not span the middle, as on
   * a flange at the bottom of a tall boss or a tapered side, the tab was
   * machined joined to nothing while the part beside it was cut away. Now it
   * is as near the middle as the part's edge at that point allows.
   */
  const tabT = opts.tabThicknessMm;
  const tabZ = tabs.anchors.map((k) => {
    if (!twoSided) {
      const topZ = Math.min(0, Math.max(floorZ, -(stockT - tabT)));
      return { topZ, bottomZ: Math.max(floorZ, -stockT) };
    }
    let topZ = Math.min(0, Math.min(top[k], Math.max(-stockT / 2 + tabT / 2, bottom[k] + tabT)));
    let bottomZ = Math.max(-stockT, topZ - tabT);
    if (top[k] >= floorZ && -stockT - bottom[k] >= floorZ) {
      topZ = Math.max(floorZ, Math.min(0, topZ));
      bottomZ = Math.max(-stockT, Math.min(-stockT - floorZ, topZ - tabT));
    }
    return { topZ, bottomZ };
  });

  // --- Registration pins ----------------------------------------------------
  const pins: { x: number; y: number }[] = [];
  // Pins go in the frame at the ends, so not with an end flush.
  if (twoSided && opts.registrationPins && !flush.has('-x') && !flush.has('+x')) {
    const px = [frame / 2, stockW - frame / 2];
    for (const x of px) {
      const c = Math.round(x / stepX);
      const r = Math.round(stockCy / stepY);
      const k = Math.min(rows - 1, Math.max(0, r)) * cols + Math.min(cols - 1, Math.max(0, c));
      // The whole hole in the frame with a millimetre to spare, not only its
      // centre: a stock given narrower than part, channel and frame leaves
      // less frame than was asked for, and the hole ran into the channel.
      const clear = dist[k] * res - opts.pinDiaMm / 2;
      if (frame < opts.pinDiaMm + 2 || !frameMask[k] || clear < moat + 1) {
        warnings.push(
          `No room in the frame for a ${opts.pinDiaMm} mm registration pin at X${f(x)}: the frame ` +
            `needs to be wider than the pin with stock either side of it. Widen the frame or turn pins off.`
        );
        pins.length = 0;
        break;
      }
      pins.push({ x, y: stockCy });
    }
  }

  const reachWarn = (depthMm: number, dia: number, label: string) => {
    const ratio = depthMm / Math.max(0.05, dia);
    if (ratio > MAX_REACH_DIAMETERS) {
      warnings.push(
        `${label}: a ${depthMm.toFixed(1)} mm bore is ${ratio.toFixed(1)} diameters of stickout for the ` +
          `${dia} mm bit (past ${MAX_REACH_DIAMETERS}\u00d7D); ensure the cutter's flute and stickout reach ` +
          `${depthMm.toFixed(1)} mm without the collet hitting the top of the stock.`
      );
    }
  };

  // Bored with whichever cutter does the roughing.
  const pinToolDia = opts.roughingEnabled ? opts.roughingToolDiaMm : opts.finishingToolDiaMm;
  if (pins.length > 0) {
    const boreDepth = stockT + opts.pinDepthMm;
    // A pin hole has to go right through the block to register the flip, so
    // one the holder stops short of is no hole at all.
    const holderAt = opts.holderDiaMm > 0 && opts.toolStickoutMm > 0 ? opts.toolStickoutMm : Infinity;
    if (pinToolDia > opts.pinDiaMm + 1e-6) {
      warnings.push(
        `The ${pinToolDia} mm cutter is too wide to bore a ${opts.pinDiaMm} mm pin hole; the pins are skipped.`
      );
      pins.length = 0;
    } else if (boreDepth > holderAt - 0.5) {
      warnings.push(
        `The pin holes go ${f(boreDepth)} mm deep, through the block and into the spoilboard, ` +
          `but the cutter only sticks ${f(holderAt)} mm out of its holder; the pins are skipped. ` +
          `Fit the cutter longer, or register the flip by hand.`
      );
      pins.length = 0;
    } else {
      reachWarn(boreDepth, pinToolDia, 'Pin bore');
      if (opts.pinDiaMm - pinToolDia < 2 * PECK_BELOW_MM) {
        warnings.push(
          `The ${opts.pinDiaMm} mm pin holes are barely wider than the ${pinToolDia} mm cutter, so they ` +
            `are drilled in pecks rather than bored on a helix, and come out the cutter's size. ` +
            `Use a wider pin for a hole that is cut to size.`
        );
      }
    }
  }

  // --- What neither side can reach --------------------------------------------
  // The two heightmaps between them leave every column filled from its top
  // surface to its bottom; the part only occupies `thickness` of it. The gap
  // is material that stays, and on a one-sided job so does everything below
  // the top surface.
  const cellArea = stepX * stepY;
  let partVolume = 0;
  let leftover = 0;
  for (let k = 0; k < hit.length; k++) {
    if (!hit[k]) continue;
    partVolume += thickness[k] * cellArea;
    const kept = twoSided ? top[k] - bottom[k] : top[k] - (-stockT);
    leftover += Math.max(0, kept - thickness[k]) * cellArea;
  }
  const unreachablePercent = partVolume > 0 ? (100 * leftover) / partVolume : 0;
  if (unreachablePercent > 1) {
    warnings.push(
      twoSided
        ? `About ${unreachablePercent.toFixed(0)}% of the part's volume is material neither side ` +
          `can see — the inside of a sideways hole, the roof of a slot. It is left in. A hole ` +
          `like that is drilled afterwards, or the part is turned so the hole points up.`
        : `About ${unreachablePercent.toFixed(0)}% of the part's volume is under a surface the ` +
          `one side cannot see past, so it stays solid below it. Cut both sides, or turn the part ` +
          `so its flat face is down.`
    );
  }

  // --- The two surfaces -------------------------------------------------------
  const material = materialSpec(opts.material);
  const finishRad = Math.max(0.05, opts.finishingToolDiaMm / 2);
  const toolClearRad = Math.max(finishRad, opts.roughingEnabled ? opts.roughingToolDiaMm / 2 : 0);
  const distToMoat = distanceTransform(moatMask, cols, rows);

  const surfaceFor = (side: 'A' | 'B'): Heightmap => {
    const z = new Float32Array(cols * rows);
    const deepSources: number[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // Side B looks at the block turned over left to right: its column c is
        // side A's column cols-1-c, and its heights are A's bottoms, measured
        // up from what was the underside.
        const src = side === 'A' ? r * cols + c : r * cols + (cols - 1 - c);
        const k = r * cols + c;
        if (hit[src]) {
          // The part's own surface, however deep it is. Held to the floor,
          // which is half way through on a two-sided job, anything below the
          // half that faces this side was cut by neither: the floor of a
          // pocket deeper than half the part, the lower half of a cone. A
          // 50 mm cup came out with 16 mm of its pocket left in. Only the
          // channel round the part is split between the sides.
          let h = side === 'A' ? top[src] : -stockT - bottom[src];
          if (twoSided && h < floorZ && distToMoat[src] * res <= finishRad) {
            const oppH = side === 'A' ? -stockT - bottom[src] : top[src];
            if (oppH >= floorZ) {
              h = Math.max(floorZ, h);
            } else {
              deepSources.push(k);
            }
          }
          z[k] = Math.min(0, Math.max(-stockT, h));
        } else if (frameMask[src]) {
          z[k] = 0;
        } else if (tabs.mask[src]) {
          // Side A cuts down to the tab's top; side B, looking up from the
          // underside, up to its bottom.
          const tab = tabZ[tabs.mask[src] - 1];
          const hTab = side === 'A' ? tab.topZ : -stockT - tab.bottomZ;
          z[k] = Math.min(0, Math.max(-stockT, hTab));
          if (z[k] < floorZ - 1e-6) deepSources.push(k);
        } else {
          z[k] = floorZ;
        }
      }
    }
    if (deepSources.length > 0) {
      const clearCells = Math.ceil(toolClearRad / res) + 1;
      for (const k0 of deepSources) {
        const r0 = Math.floor(k0 / cols);
        const c0 = k0 - r0 * cols;
        const targetZ = z[k0];
        for (let dr = -clearCells; dr <= clearCells; dr++) {
          const r = r0 + dr;
          if (r < 0 || r >= rows) continue;
          for (let dc = -clearCells; dc <= clearCells; dc++) {
            if (Math.hypot(dc * stepX, dr * stepY) > toolClearRad + res) continue;
            const c = c0 + dc;
            if (c < 0 || c >= cols) continue;
            const src = side === 'A' ? r * cols + c : r * cols + (cols - 1 - c);
            if (!moatMask[src] || tabs.mask[src]) continue;
            const k = r * cols + c;
            if (targetZ < z[k]) z[k] = targetZ;
          }
        }
      }
    }
    return { minX: 0, minY: 0, maxX: stockW, maxY: stockD, cols, rows, stepX, stepY, z };
  };

  // Tooling the shared core reads. The relief-only fields are given values
  // that describe this job rather than left at the relief defaults, because
  // the core prints some of them.
  const carveOpts: ReliefCarveOptions = {
    ...opts,
    stockWidthMm: stockW,
    stockDepthMm: stockD,
    stockThicknessMm: stockT,
    carveDepthMm: depthA,
    verticalScaleMode: 'proportional',
    verticalExaggeration: 1,
    fitMode: 'manual',
    backgroundMode: 'carve',
    invertRelief: false,
  };

  const common = [
    `; Stock       : ${f(stockW)} x ${f(stockD)} x ${f(stockT)} mm ${material.label.toLowerCase()}`,
    `; Part        : ${f(partW)} x ${f(partD)} x ${f(partH)} mm, model ${opts.up} up, ${opts.scalePercent}% scale`,
    `; Channel     : ${f(moat)} mm round the part, ${f(frame)} mm frame beyond it`,
    `; Tabs        : ${tabsPlaced} x ${f(opts.tabWidthMm)} mm wide, ${f(opts.tabThicknessMm)} mm thick`,
    '; Origin      : near-left corner of the stock, top face, Z0',
    `; Extents     : X0..${f(stockW)}  Y0..${f(stockD)} (all cuts are +X +Y of zero)`,
  ];

  const sides: SolidSideResult[] = [];
  const sideCount = twoSided ? 2 : 1;
  for (let s = 0; s < sideCount; s++) {
    const side: 'A' | 'B' = s === 0 ? 'A' : 'B';
    const header =
      side === 'A'
        ? [
            twoSided ? '; Solid part machining — SIDE A of 2' : '; Solid part machining — one side',
            ...common,
            ...(twoSided
              ? [
                  `; Then        : flip the block over LEFT TO RIGHT (about the Y axis)${
                    pins.length ? ' and drop it back onto the pins' : ', re-zero X and Y on the new near-left corner'
                  }, re-zero Z on the new top face, and run side B`,
                ]
              : [`; Through cut : ${f(opts.throughCutMm)} mm into the spoilboard`]),
          ]
        : [
            '; Solid part machining — SIDE B of 2',
            ...common,
            `; Setup       : side A already cut; block flipped LEFT TO RIGHT${
              pins.length ? ' onto the registration pins' : ''
            }, Z zeroed on this face. Do not re-zero X or Y${pins.length ? '' : ' unless the stock was cut to size'}.`,
          ];

    let prelude: string[] | undefined;
    if (side === 'A' && pins.length > 0) {
      const plunge = opts.roughingEnabled ? opts.roughingPlungeRate : opts.finishingPlungeRate;
      const feed = opts.roughingEnabled ? opts.roughingFeedrate : opts.finishingFeedrate;
      const pitch = opts.roughingEnabled ? opts.roughingStepdownMm : Math.max(0.2, opts.finishingToolDiaMm / 2);
      prelude = ['; --- OP 0: registration pins ----------------------------------'];
      for (const p of pins) {
        prelude.push(
          ...pinBore(p.x, p.y, pinToolDia, opts.pinDiaMm, -(stockT + opts.pinDepthMm), pitch, plunge, feed, opts.safeZ)
        );
      }
      prelude.push('G0 X0 Y0 ; back over the origin before the part');
    }

    const surface = surfaceFor(side);
    // As deep as this side's own surfaces go, which on a pocketed part is
    // further than the half way it shares the channel at.
    let deepest = 0;
    for (let k = 0; k < surface.z.length; k++) deepest = Math.max(deepest, -surface.z[k]);
    // Past the half only by more than the surface's own float rounding.
    const depth = deepest > depthA + 1e-3 ? deepest : depthA;
    const cut = machineSurface(
      {
        surface, bounds, depthMm: depth, resolution: res, header, prelude, noun: 'cut',
        // Off a flush side, as the relief runs off an open edge. Side B is
        // turned left to right, so its ends are the other way round.
        ...(flush.size > 0
          ? {
              runOff: {
                minX: flush.has(side === 'A' ? '-x' : '+x'),
                maxX: flush.has(side === 'A' ? '+x' : '-x'),
                minY: flush.has('-y'),
                maxY: flush.has('+y'),
              },
            }
          : {}),
      },
      {
        ...carveOpts,
        carveDepthMm: depth,
        applyMeshLeveling: side === 'A' ? opts.applyMeshLeveling : false,
        meshLevelGrid: side === 'A' ? opts.meshLevelGrid : null,
      },
      warnings
    );
    if (!cut.success) return fail(`Side ${side}: ${cut.error ?? 'no toolpath.'}`);
    // The pin bores are in the program, so the time estimate has them; the
    // preview and the cut distance are built from the surface's own moves,
    // and had nothing of them.
    const bores = boreSegments(prelude ?? []);
    sides.push({
      ...cut,
      segments: [...bores.segments, ...cut.segments],
      totalCutDistanceMm: cut.totalCutDistanceMm + bores.distanceMm,
      side,
      depthMm: depth,
    });
  }

  // The grid is measured on whatever face was up when it was probed. After the
  // flip that face is underneath, so side B wants a grid of its own.
  if (twoSided && opts.applyMeshLeveling && opts.meshLevelGrid) {
    warnings.push(
      `Bed levelling follows the surface probed before side A. Probe again after flipping the ` +
        `block, before cutting side B: its top is the other face, and the old grid does not describe it.`
    );
  }

  if (!twoSided && opts.throughCutMm > 0) {
    warnings.push(
      `The channel goes ${opts.throughCutMm} mm below the bottom of the stock, into whatever is ` +
        `under it. Cut on a spoilboard, not on the bed.`
    );
  }

  // Both sides raise the same tooling warnings, because they are the same
  // tooling at the same depth. Said once.
  const seen = new Set<string>();
  const unique = warnings.filter((w) => !seen.has(w) && (seen.add(w), true));

  return {
    success: true,
    warnings: unique,
    sides,
    stock: { widthMm: stockW, depthMm: stockD, thicknessMm: stockT },
    ...(prep ? { boardPrep: prep } : {}),
    bounds,
    partBounds,
    footprint: { minX: 0, minY: 0, stepX, stepY, cols, rows, mask: hit },
    partSizeMm: { x: partW, y: partD, z: partH },
    partVolumeMm3: partVolume,
    unreachablePercent,
    tabsPlaced,
    tabs: tabs.anchors.map((k, i) => {
      const r = Math.floor(k / cols);
      return { x: (k - r * cols) * stepX, y: r * stepY, ...tabZ[i] };
    }),
    pins,
    stockTransform: (() => {
      // The scene's own millimetres, before the scale.
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < sceneTris.length; i++) {
        lo[i % 3] = Math.min(lo[i % 3], sceneTris[i] * 1000);
        hi[i % 3] = Math.max(hi[i % 3], sceneTris[i] * 1000);
      }
      const s = scale / 1000;
      return {
        rotation: [...ORIENT_MATRIX[opts.up]],
        modelOriginMm: [0, 0, 0] as [number, number, number],
        workOriginMm: [stockCx - (mnX + mxX) / 2, stockCy - (mnY + mxY) / 2, topZ - mxZ] as [number, number, number],
        scale: [s, s, s] as [number, number, number],
        modelMinMm: lo as [number, number, number],
        modelMaxMm: hi as [number, number, number],
      };
    })(),
    estimatedTimeSeconds: sides.reduce((t, s) => t + s.estimatedTimeSeconds, 0),
    totalCutDistanceMm: sides.reduce((t, s) => t + s.totalCutDistanceMm, 0),
  };
}
