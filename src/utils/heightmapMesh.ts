// ---------------------------------------------------------------------------
// 2D image -> 3D heightmap ("lithophane" / relief) mesh
//
// Grayscale drives Z: each pixel becomes a grid vertex whose height is the
// luminance of that pixel, mapped onto [0, maxHeight] either way round —
// white = tall (a raised relief) or white = flat (a carved/engraved relief,
// and the mapping a backlit lithophane needs, where thin = bright).
//
// Coordinate spaces follow utils/stlParser.ts: `renderVertices` is Z-up
// (OpenSCAD / app convention, metres) and `vertices` is the Three.js Y-up copy
// (x, z, -y) that mjcf.ts expects in SceneGeom.vertices.
// ---------------------------------------------------------------------------

import { computeBoundingBox, type BoundingBox } from './stlParser';

/** Which end of the grayscale ramp is the high end. */
export type HeightMapping = 'white-high' | 'white-low';

/**
 * How pixel values become height.
 *
 * `grayscale` reads every tone as its own height — right for photos and
 * gradients. `sloped` first cuts the image in two at a threshold, then ramps
 * the height across the boundary over a fixed distance, which is what a
 * pure black-and-white logo or stencil wants: the grayscale path gives it
 * vertical cliffs at every edge, and a ramp turns those into a constant draft
 * angle a router bit or a printer's overhang limit can actually follow.
 */
export type HeightProfile = 'grayscale' | 'sloped';

/** Which side of the black/white boundary the slope eats into. */
export type SlopeStyle = 'inward' | 'outward' | 'centred';

export interface HeightmapOptions {
  /** Physical X extent of the plaque, metres. Y follows the image aspect. */
  widthM: number;
  /** Relief amplitude above the base, metres. */
  maxHeightM: number;
  /** Solid slab carried under the relief, metres. 0 leaves an open shell. */
  baseThicknessM: number;
  /** `white-high`: white is z = base + maxHeight. `white-low`: white is z = base. */
  mapping: HeightMapping;
  /** Samples across X. Rows follow from the image aspect ratio. */
  gridCols: number;
  /** Box-blur passes over the sampled heights; smooths photo noise into slopes. */
  smoothPasses: number;
  /** Ignore heights below this (0..1) — trims flat background off a cutout. */
  floor?: number;
  /** `grayscale` (per-pixel tone) or `sloped` (threshold, then ramped edges). */
  profile?: HeightProfile;
  /** `sloped` only: how many flat levels to quantise to. 2 is black/white. */
  slopeLevels?: number;
  /**
   * `sloped`, two levels only: cut point between low and high, 0..1. Above two
   * levels the cuts are evenly spaced (see `evenThresholds`) and this is unused.
   */
  threshold?: number;
  /** `sloped` only: horizontal run of the ramp, metres. 0 keeps vertical walls. */
  slopeWidthM?: number;
  /** `sloped` only: which side of the boundary the ramp is carved out of. */
  slopeStyle?: SlopeStyle;
}

export interface HeightmapMeshResult {
  /** Three.js Y-up vertices, for SceneGeom.vertices. */
  vertices: number[];
  /** Z-up vertices, for SceneGeom.renderVertices. */
  renderVertices: number[];
  faces: number[];
  boundingBox: BoundingBox;
  cols: number;
  rows: number;
  /** Normalised heights (0..1) after mapping/smoothing, row-major, for preview. */
  heights: Float32Array;
  triangleCount: number;
  /** Physical size in metres, [x, y, z]. */
  sizeM: [number, number, number];
}

export const DEFAULT_HEIGHTMAP_OPTIONS: HeightmapOptions = {
  widthM: 0.1,
  maxHeightM: 0.015,
  baseThicknessM: 0.003,
  mapping: 'white-high',
  gridCols: 160,
  smoothPasses: 1,
  floor: 0,
  profile: 'grayscale',
  slopeLevels: 2,
  threshold: 0.5,
  slopeWidthM: 0.004,
  slopeStyle: 'centred',
};

/** Rec. 709 luminance, 0 (black) .. 1 (white). */
function luminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Box-downsample RGBA pixels to a `cols × rows` grid of 0..1 luminance.
 *
 * Averaging over each source block rather than point-sampling matters: a photo
 * resampled to 160 columns by nearest-neighbour keeps its pixel noise as spikes
 * in the mesh, which then show up as visible facets on the printed relief.
 *
 * Fully transparent pixels are treated as black, so a cutout PNG drops to the
 * base plane instead of inheriting whatever colour sits in its unused channels.
 */
export function sampleLuminanceGrid(
  data: Uint8ClampedArray,
  imgWidth: number,
  imgHeight: number,
  cols: number,
  rows: number
): Float32Array {
  const out = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const y0 = Math.floor((r * imgHeight) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((r + 1) * imgHeight) / rows));
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor((c * imgWidth) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((c + 1) * imgWidth) / cols));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1 && y < imgHeight; y++) {
        for (let x = x0; x < x1 && x < imgWidth; x++) {
          const i = (y * imgWidth + x) * 4;
          const a = data[i + 3] / 255;
          sum += luminance(data[i], data[i + 1], data[i + 2]) * a;
          n++;
        }
      }
      out[r * cols + c] = n > 0 ? sum / n : 0;
    }
  }
  return out;
}

/** In-place 3×3 box blur, clamped at the edges. */
function blur(grid: Float32Array, cols: number, rows: number, passes: number): Float32Array {
  let src = grid;
  for (let p = 0; p < passes; p++) {
    const dst = new Float32Array(src.length);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let sum = 0;
        let n = 0;
        for (let dr = -1; dr <= 1; dr++) {
          const rr = r + dr;
          if (rr < 0 || rr >= rows) continue;
          for (let dc = -1; dc <= 1; dc++) {
            const cc = c + dc;
            if (cc < 0 || cc >= cols) continue;
            sum += src[rr * cols + cc];
            n++;
          }
        }
        dst[r * cols + c] = sum / n;
      }
    }
    src = dst;
  }
  return src;
}


/**
 * Felzenszwalb & Huttenlocher exact squared Euclidean distance transform.
 *
 * `seed[i]` true marks a source pixel; the result is the squared distance in
 * cells from each pixel to the nearest source. Rows with no source at all stay
 * at INF, which is what lets a shape run off the edge of the image without the
 * border being mistaken for a boundary to slope away from.
 */
export function squaredDistanceTransform(seed: Uint8Array, cols: number, rows: number): Float64Array {
  const INF = 1e20;
  const f = new Float64Array(cols * rows);
  for (let i = 0; i < f.length; i++) f[i] = seed[i] ? 0 : INF;

  const n = Math.max(cols, rows);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);

  // 1D transform of one strip, read/written through index callbacks.
  const dt1d = (len: number, get: (i: number) => number, set: (i: number, val: number) => void) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q++) {
      const fq = get(q);
      let s = ((fq + q * q) - (get(v[k]) + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = ((fq + q * q) - (get(v[k]) + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      const dq = q - v[k];
      d[q] = dq * dq + get(v[k]);
    }
    for (let q = 0; q < len; q++) set(q, d[q]);
  };

  for (let r = 0; r < rows; r++) {
    const off = r * cols;
    dt1d(cols, (i) => f[off + i], (i, val) => { f[off + i] = val; });
  }
  for (let c = 0; c < cols; c++) {
    dt1d(rows, (i) => f[i * cols + c], (i, val) => { f[i * cols + c] = val; });
  }
  return f;
}

/**
 * Ramp across one black/white boundary in the mapped heights.
 *
 * Distance is measured to the nearest pixel of the *other* class on each side,
 * so the signed distance is continuous through the edge and the ramp comes out
 * at a constant slope in every direction — a cone from a dot, a clean chamfer
 * along a straight edge — rather than the staircase a per-axis blur leaves.
 *
 * Returns 0..1 across this one boundary; `applyMultiLevelSlopeProfile` stacks
 * several of these to get more than two levels.
 */
export function applySlopeProfile(
  heights: Float32Array,
  cols: number,
  rows: number,
  threshold: number,
  rampCells: number,
  style: SlopeStyle
): Float32Array<ArrayBuffer> {
  const high = new Uint8Array(cols * rows);
  let nHigh = 0;
  for (let i = 0; i < heights.length; i++) {
    if (heights[i] >= threshold) { high[i] = 1; nHigh++; }
  }
  // All one class: nothing to slope between, so keep the flat result.
  const out = new Float32Array(cols * rows);
  if (nHigh === 0 || nHigh === heights.length) {
    out.fill(nHigh === 0 ? 0 : 1);
    return out;
  }
  if (!(rampCells > 0)) {
    for (let i = 0; i < out.length; i++) out[i] = high[i] ? 1 : 0;
    return out;
  }

  const low = new Uint8Array(cols * rows);
  for (let i = 0; i < low.length; i++) low[i] = high[i] ? 0 : 1;

  // Distance from every pixel to the nearest pixel of the opposite class.
  const distToLow = squaredDistanceTransform(low, cols, rows);
  const distToHigh = squaredDistanceTransform(high, cols, rows);

  for (let i = 0; i < out.length; i++) {
    // Sub-cell offset: the true edge sits half a cell outside the last pixel of
    // each class, so both sides measure from the same line.
    const dIn = Math.sqrt(distToLow[i]) - 0.5;
    const dOut = Math.sqrt(distToHigh[i]) - 0.5;
    let t: number;
    if (style === 'inward') {
      // Full height only once you are `rampCells` inside the shape.
      t = high[i] ? dIn / rampCells : 0;
    } else if (style === 'outward') {
      // Shape keeps its full footprint; the ramp spreads into the background.
      t = high[i] ? 1 : 1 - dOut / rampCells;
    } else {
      // Centred: half the ramp each side, so the original outline stays at
      // mid-height and the footprint neither grows nor shrinks.
      const signed = high[i] ? dIn : -dOut;
      t = 0.5 + signed / rampCells;
    }
    out[i] = Math.min(1, Math.max(0, t));
  }
  return out;
}

/**
 * Where the cuts between levels sit, for an evenly quantised image.
 *
 * Levels land on 0, 1/(n-1) … 1, so the cuts go midway between them: three
 * levels means tones near 0, 0.5 and 1, split at 0.25 and 0.75. Two levels
 * gives the single 0.5 cut the black-and-white path has always used.
 */
export function evenThresholds(levels: number): number[] {
  const n = Math.max(2, Math.round(levels));
  const cuts: number[] = [];
  for (let k = 1; k < n; k++) cuts.push((k - 0.5) / (n - 1));
  return cuts;
}

/**
 * Quantise into flat treads with a sloped riser between each pair.
 *
 * Each cut contributes its own ramp and they are summed, which works because
 * the masks are nested — a pixel above cut 2 is also above cut 1 — so the
 * total is a monotone staircase whatever the ramps do locally. Where two cuts
 * fall closer together than the slope run their ramps overlap and the tread
 * between them vanishes; that is the honest answer for detail finer than the
 * requested draft angle, and it degrades smoothly rather than jumping.
 *
 * With a single cut this reduces to exactly `applySlopeProfile` — the
 * two-level black-and-white result is untouched.
 */
export function applyMultiLevelSlopeProfile(
  heights: Float32Array,
  cols: number,
  rows: number,
  thresholds: number[],
  rampCells: number,
  style: SlopeStyle
): Float32Array<ArrayBuffer> {
  if (thresholds.length === 0) return new Float32Array(cols * rows);
  if (thresholds.length === 1) {
    return applySlopeProfile(heights, cols, rows, thresholds[0], rampCells, style);
  }
  const step = 1 / thresholds.length;
  const out = new Float32Array(cols * rows);
  for (const t of thresholds) {
    const band = applySlopeProfile(heights, cols, rows, t, rampCells, style);
    for (let i = 0; i < out.length; i++) out[i] += band[i] * step;
  }
  for (let i = 0; i < out.length; i++) out[i] = Math.min(1, Math.max(0, out[i]));
  return out;
}

/**
 * Guess how many flat tones an image is built from, 2..`maxLevels`.
 *
 * A 64-bin histogram, then a count of the peaks that carry real area: line art
 * and stencils show two or three tall spikes, a photo shows a spread with no
 * bin dominant. Falls back to 2, which is what most sloped imports want.
 */
export function detectLevels(lum: Float32Array, maxLevels = 8): number {
  const BINS = 64;
  const hist = new Float64Array(BINS);
  for (let i = 0; i < lum.length; i++) {
    const b = Math.min(BINS - 1, Math.max(0, Math.round(lum[i] * (BINS - 1))));
    hist[b]++;
  }
  const total = lum.length || 1;
  // A tone has to hold 4% of the image to count as a level of its own, which
  // keeps antialiasing fringes and JPEG ringing out of the tally.
  const minShare = 0.04 * total;
  let peaks = 0;
  for (let b = 0; b < BINS; b++) {
    if (hist[b] < minShare) continue;
    const left = b > 0 ? hist[b - 1] : -1;
    const right = b < BINS - 1 ? hist[b + 1] : -1;
    // `>` on the left and `>=` on the right so a plateau counts once.
    if (hist[b] > left && hist[b] >= right) peaks++;
  }
  return Math.min(maxLevels, Math.max(2, peaks));
}

export function bimodality(lum: Float32Array): number {
  let extreme = 0;
  for (let i = 0; i < lum.length; i++) {
    if (lum[i] <= 0.2 || lum[i] >= 0.8) extreme++;
  }
  return lum.length ? extreme / lum.length : 0;
}

/**
 * Turn a luminance grid into a watertight solid: a relief surface on top, a
 * flat bottom at z = 0, and skirt walls closing the two together.
 *
 * The bottom is a fan over the perimeter ring rather than a mirrored copy of
 * the whole grid — the underside is a plane, so the full grid there would
 * double the triangle count for no shape.
 */
export function buildHeightmapMesh(
  lum: Float32Array,
  cols: number,
  rows: number,
  options: HeightmapOptions
): HeightmapMeshResult {
  if (cols < 2 || rows < 2) throw new Error('Heightmap needs at least a 2×2 grid.');
  if (lum.length !== cols * rows) throw new Error('Luminance grid size does not match cols × rows.');

  const { widthM, maxHeightM, baseThicknessM, mapping } = options;
  const floor = Math.min(Math.max(options.floor ?? 0, 0), 1);

  const smoothed = options.smoothPasses > 0 ? blur(lum, cols, rows, options.smoothPasses) : lum;

  // Cell size is square in X and Y so the image is never stretched: rows were
  // chosen from the aspect ratio, and the Y extent follows from that.
  const dx = widthM / (cols - 1);

  // Map luminance -> normalised height.
  let heights: Float32Array<ArrayBuffer> = new Float32Array(cols * rows);
  for (let i = 0; i < heights.length; i++) {
    const g = Math.min(Math.max(smoothed[i], 0), 1);
    heights[i] = mapping === 'white-high' ? g : 1 - g;
  }

  if ((options.profile ?? 'grayscale') === 'sloped') {
    const levels = Math.max(2, Math.round(options.slopeLevels ?? 2));
    // Two levels keep the explicit threshold; more than two are evenly spaced.
    const thresholds = levels === 2
      ? [Math.min(Math.max(options.threshold ?? 0.5, 0), 1)]
      : evenThresholds(levels);
    heights = applyMultiLevelSlopeProfile(
      heights,
      cols,
      rows,
      thresholds,
      (options.slopeWidthM ?? 0) / dx,
      options.slopeStyle ?? 'centred'
    );
  }

  // Clamp away the flat background last, so it also trims the foot of a ramp.
  if (floor > 0) {
    for (let i = 0; i < heights.length; i++) if (heights[i] < floor) heights[i] = 0;
  }

  const heightM = dx * (rows - 1);
  const x0 = -widthM / 2;
  const y0 = heightM / 2; // row 0 is the top of the image, at +Y

  const zUp: number[] = [];
  const faces: number[] = [];

  // --- Top surface ---------------------------------------------------------
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      zUp.push(x0 + c * dx, y0 - r * dx, baseThicknessM + heights[r * cols + c] * maxHeightM);
    }
  }
  const top = (r: number, c: number) => r * cols + c;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = top(r, c), b = top(r, c + 1), d = top(r + 1, c), e = top(r + 1, c + 1);
      faces.push(a, d, e, a, e, b); // CCW seen from +Z
    }
  }

  // --- Perimeter ring, counter-clockwise seen from +Z ----------------------
  const ring: number[] = [];
  for (let c = 0; c < cols; c++) ring.push(top(rows - 1, c));            // front edge, +X
  for (let r = rows - 2; r >= 0; r--) ring.push(top(r, cols - 1));        // right edge, +Y
  for (let c = cols - 2; c >= 0; c--) ring.push(top(0, c));               // back edge, -X
  for (let r = 1; r <= rows - 2; r++) ring.push(top(r, 0));               // left edge, -Y

  // Bottom copies of the ring, at z = 0.
  const bottomStart = zUp.length / 3;
  for (const v of ring) zUp.push(zUp[v * 3], zUp[v * 3 + 1], 0);

  // --- Skirt walls ---------------------------------------------------------
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    const t0 = ring[i], t1 = ring[j];
    const b0 = bottomStart + i, b1 = bottomStart + j;
    faces.push(t0, b0, b1, t0, b1, t1); // outward-facing
  }

  // --- Bottom fan ----------------------------------------------------------
  const centre = zUp.length / 3;
  zUp.push(0, 0, 0);
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    faces.push(centre, bottomStart + j, bottomStart + i); // normal -Z
  }

  // Three.js Y-up copy: (x, z, -y), matching stlParser.
  const yUp: number[] = new Array(zUp.length);
  for (let i = 0; i < zUp.length; i += 3) {
    yUp[i] = zUp[i];
    yUp[i + 1] = zUp[i + 2];
    yUp[i + 2] = -zUp[i + 1];
  }

  const boundingBox = computeBoundingBox(zUp);

  return {
    vertices: yUp,
    renderVertices: zUp,
    faces,
    boundingBox,
    cols,
    rows,
    heights,
    triangleCount: faces.length / 3,
    sizeM: [widthM, heightM, baseThicknessM + maxHeightM],
  };
}

/** Rows that keep the image's aspect ratio at a given column count. */
export function rowsForAspect(imgWidth: number, imgHeight: number, cols: number): number {
  return Math.max(2, Math.round(((cols - 1) * imgHeight) / imgWidth) + 1);
}

/** One-shot: RGBA pixels in, mesh out. */
export function imageToHeightmapMesh(
  data: Uint8ClampedArray,
  imgWidth: number,
  imgHeight: number,
  options: HeightmapOptions
): HeightmapMeshResult {
  const cols = Math.max(2, Math.round(options.gridCols));
  const rows = rowsForAspect(imgWidth, imgHeight, cols);
  const lum = sampleLuminanceGrid(data, imgWidth, imgHeight, cols, rows);
  return buildHeightmapMesh(lum, cols, rows, options);
}
