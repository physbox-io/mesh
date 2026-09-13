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
  machineSurface,
  type Heightmap,
  type ReliefCarveOptions,
  type SurfaceMachiningResult,
} from './reliefCarveExporter';
import { materialSpec } from './feedsAndSpeeds';

/** Which way up the model goes in the first setup. */
export type UpAxis = '+z' | '-z' | '+x' | '-x' | '+y' | '-y';

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
};

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
  /** The stock block in work coordinates, for the preview and the travel check. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number; minZ: number; maxZ: number };
  /** Where the part lands on the stock, plan view. */
  partBounds: { minX: number; minY: number; maxX: number; maxY: number };
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
  /** Registration pin centres in work coordinates, if bored. */
  pins: { x: number; y: number }[];
  estimatedTimeSeconds: number;
  totalCutDistanceMm: number;
}

/** Beyond this the heightmap costs more than the extra fidelity is worth. */
const MAX_HEIGHTMAP_CELLS = 260_000;

/** The two sides' channels overlap by this much at the midplane, so they meet. */
const SIDE_OVERLAP_MM = 0.5;

/** Tabs are looked for on the part's outline this far apart, as a fraction of a full turn. */
const TAB_SEARCH_STEPS = 720;

function f(num: number): string {
  return (Math.round(num * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '') || '0';
}

/**
 * Turns the model so the chosen axis points at the spindle.
 *
 * All six are proper rotations rather than mirrors, so a right-handed part
 * stays right-handed: the piece that comes off the machine is the part, not its
 * reflection.
 */
function orient(up: UpAxis, x: number, y: number, z: number): [number, number, number] {
  switch (up) {
    case '+z': return [x, y, z];
    case '-z': return [x, -y, -z];
    case '+x': return [-z, y, x];
    case '-x': return [z, y, -x];
    case '+y': return [x, -z, y];
    case '-y': return [x, z, -y];
  }
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
  const hitZ: number[] = [];
  const hitDir: number[] = [];
  const order: number[] = [];
  for (let row = 0; row < rows; row++) {
    const py = bounds.minY + (row + NUDGE) * stepY;
    const br = bucketRow(py);
    for (let col = 0; col < cols; col++) {
      const px = bounds.minX + (col + NUDGE) * stepX;
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
): { mask: Uint8Array; placed: number } {
  const mask = new Uint8Array(cols * rows);
  if (count <= 0) return { mask, placed: 0 };

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
  if (n === 0 || outline.length === 0) return { mask, placed: 0 };
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
  let placed = 0;

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
          if (along >= -1 && along <= len + 1 && Math.abs(across) <= halfW) mask[k] = 1;
        }
      }
      placed++;
      done = true;
    }
  }

  return { mask, placed };
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
  out.push(`G0 X${f(cx + r)} Y${f(cy)}`);
  out.push(`G1 Z0 F${Math.round(plungeRate)}`);
  const turns = Math.max(1, Math.ceil(-toZ / Math.max(0.1, pitchMm)));
  const total = turns * segs;
  for (let i = 1; i <= total; i++) {
    const a = (i / segs) * 2 * Math.PI;
    const z = toZ * (i / total);
    out.push(`G1 X${f(cx + r * Math.cos(a))} Y${f(cy + r * Math.sin(a))} Z${f(z)}`);
  }
  for (let i = 1; i <= segs; i++) {
    const a = (i / segs) * 2 * Math.PI;
    out.push(`G1 X${f(cx + r * Math.cos(a))} Y${f(cy + r * Math.sin(a))} F${Math.round(feedRate)}`);
  }
  out.push(`G0 Z${f(safeZ)}`);
  return out;
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
 * How deep each side of the job cuts, from the part and the options, without
 * running the job. The same arithmetic the exporter uses.
 */
export function sideDepthMm(partHeightMm: number, opts: SolidMachiningOptions): number {
  const skin = Math.max(0, opts.topSkinMm);
  const twoSided = opts.sides === 2;
  const stockT =
    opts.stockThicknessMm > 0 ? opts.stockThicknessMm : partHeightMm + (twoSided ? 2 * skin : skin);
  return twoSided ? stockT / 2 + SIDE_OVERLAP_MM : stockT + Math.max(0, opts.throughCutMm);
}

/**
 * Turns a scene into the programs that machine it out of a block.
 */
export function generateSolidMachining(
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
  const oriented = new Float64Array(sceneTris.length);
  let mnX = Infinity, mnY = Infinity, mnZ = Infinity;
  let mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity;
  for (let i = 0; i < sceneTris.length; i += 3) {
    const [x, y, z] = orient(opts.up, sceneTris[i] * scale, sceneTris[i + 1] * scale, sceneTris[i + 2] * scale);
    oriented[i] = x; oriented[i + 1] = y; oriented[i + 2] = z;
    if (x < mnX) mnX = x; if (x > mxX) mxX = x;
    if (y < mnY) mnY = y; if (y > mxY) mxY = y;
    if (z < mnZ) mnZ = z; if (z > mxZ) mxZ = z;
  }
  const partW = mxX - mnX;
  const partD = mxY - mnY;
  const partH = mxZ - mnZ;
  if (partW <= 1e-6 || partD <= 1e-6 || partH <= 1e-6) {
    return fail('The scene has no volume in this orientation, so there is no part to cut.');
  }

  // --- Stock, channel and frame ----------------------------------------------
  const roughDia = opts.roughingEnabled ? opts.roughingToolDiaMm : opts.finishingToolDiaMm;
  const moat = opts.moatWidthMm > 0 ? opts.moatWidthMm : Math.max(3, roughDia * 1.5);
  const frame = Math.max(0, opts.frameWidthMm);
  const twoSided = opts.sides === 2;
  const skin = Math.max(0, opts.topSkinMm);

  const stockW = opts.stockWidthMm > 0 ? opts.stockWidthMm : partW + 2 * (moat + frame);
  const stockD = opts.stockDepthMm > 0 ? opts.stockDepthMm : partD + 2 * (moat + frame);
  const stockT =
    opts.stockThicknessMm > 0 ? opts.stockThicknessMm : partH + (twoSided ? 2 * skin : skin);

  if (stockW < partW + 2 * moat || stockD < partD + 2 * moat) {
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

  // Where the part sits: centred in plan. Two-sided, it is centred in the
  // thickness too, so each side faces the same skin and the cuts meet in the
  // middle. One-sided, it sits on the bed and the spare thickness is all skin
  // on top.
  const stockCx = stockW / 2;
  const stockCy = stockD / 2;
  const topZ = twoSided ? -(stockT - partH) / 2 : -(stockT - partH);
  const tris = new Float64Array(oriented.length);
  for (let i = 0; i < oriented.length; i += 3) {
    tris[i] = oriented[i] - (mnX + mxX) / 2 + stockCx;
    tris[i + 1] = oriented[i + 1] - (mnY + mxY) / 2 + stockCy;
    tris[i + 2] = oriented[i + 2] - mxZ + topZ;
  }
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
    (opts.finishingToolDiaMm * Math.min(50, Math.max(2, opts.finishingStepoverPercent))) / 100
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
  if (tabs.placed < Math.round(opts.tabCount)) {
    warnings.push(
      `Only ${tabs.placed} of ${Math.round(opts.tabCount)} tabs could be placed: the part's ` +
        `outline has no frame within reach at the other positions. Widen the frame, or ask for fewer.`
    );
  }
  if (tabs.placed === 0) {
    warnings.push(
      `Nothing holds the part once the channel is through. It will come loose under the cutter ` +
        `on the last pass — add tabs, or fix the part down some other way.`
    );
  }
  const tabTopZ = twoSided
    ? -(stockT / 2 - opts.tabThicknessMm / 2)
    : -(stockT - opts.tabThicknessMm);

  // --- Registration pins ----------------------------------------------------
  const pins: { x: number; y: number }[] = [];
  if (twoSided && opts.registrationPins) {
    const px = [frame / 2, stockW - frame / 2];
    for (const x of px) {
      const c = Math.round(x / stepX);
      const r = Math.round(stockCy / stepY);
      const k = Math.min(rows - 1, Math.max(0, r)) * cols + Math.min(cols - 1, Math.max(0, c));
      if (frame < opts.pinDiaMm + 2 || !frameMask[k]) {
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

  const surfaceFor = (side: 'A' | 'B'): Heightmap => {
    const z = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // Side B looks at the block turned over left to right: its column c is
        // side A's column cols-1-c, and its heights are A's bottoms, measured
        // up from what was the underside.
        const src = side === 'A' ? r * cols + c : r * cols + (cols - 1 - c);
        const k = r * cols + c;
        if (hit[src]) {
          const h = side === 'A' ? top[src] : -stockT - bottom[src];
          z[k] = Math.min(0, Math.max(floorZ, h));
        } else if (frameMask[src]) {
          z[k] = 0;
        } else if (tabs.mask[src]) {
          z[k] = tabTopZ;
        } else {
          z[k] = floorZ;
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
    `; Tabs        : ${tabs.placed} x ${f(opts.tabWidthMm)} mm wide, ${f(opts.tabThicknessMm)} mm thick`,
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
      const toolDia = opts.roughingEnabled ? opts.roughingToolDiaMm : opts.finishingToolDiaMm;
      if (toolDia > opts.pinDiaMm + 1e-6) {
        warnings.push(
          `The ${toolDia} mm cutter is too wide to bore a ${opts.pinDiaMm} mm pin hole; the pins are skipped.`
        );
        pins.length = 0;
      } else {
        if (opts.pinDiaMm - toolDia < 0.5) {
          warnings.push(
            `The ${opts.pinDiaMm} mm pin holes are barely wider than the ${toolDia} mm cutter, so they ` +
              `are drilled straight down rather than bored on a helix. Fine in wood; in aluminium ` +
              `peck it or use a wider pin.`
          );
        }
        const plunge = opts.roughingEnabled ? opts.roughingPlungeRate : opts.finishingPlungeRate;
        const feed = opts.roughingEnabled ? opts.roughingFeedrate : opts.finishingFeedrate;
        const pitch = opts.roughingEnabled ? opts.roughingStepdownMm : Math.max(0.2, opts.finishingToolDiaMm / 2);
        prelude = ['; --- OP 0: registration pins ----------------------------------'];
        for (const p of pins) {
          prelude.push(
            ...pinBore(p.x, p.y, toolDia, opts.pinDiaMm, -(stockT + opts.pinDepthMm), pitch, plunge, feed, opts.safeZ)
          );
        }
        prelude.push('G0 X0 Y0 ; back over the origin before the part');
      }
    }

    const cut = machineSurface(
      { surface: surfaceFor(side), bounds, depthMm: depthA, resolution: res, header, prelude, noun: 'cut' },
      carveOpts,
      warnings
    );
    if (!cut.success) return fail(`Side ${side}: ${cut.error ?? 'no toolpath.'}`);
    sides.push({ ...cut, side, depthMm: depthA });
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
    bounds,
    partBounds,
    partSizeMm: { x: partW, y: partD, z: partH },
    partVolumeMm3: partVolume,
    unreachablePercent,
    tabsPlaced: tabs.placed,
    pins,
    estimatedTimeSeconds: sides.reduce((t, s) => t + s.estimatedTimeSeconds, 0),
    totalCutDistanceMm: sides.reduce((t, s) => t + s.totalCutDistanceMm, 0),
  };
}
