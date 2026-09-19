// ---------------------------------------------------------------------------
// Procedural surface patterns, carved into a board.
//
// Each pattern here is a pure function from a grid size to a grid of heights in
// 0..1. It knows nothing about meshes, stock, millimetres or cutters -- which
// is what makes every one of them testable without a browser, and what keeps
// the awkward parts (winding, coordinate spaces, tool dilation) in the one
// place that already solves them.
//
// The pipeline is: pattern -> height grid -> `buildHeightmapMesh` -> a board
// -> the existing relief carve exporter. Nothing new happens after the grid.
//
// The important idea, and the reason this reads as one plank rather than as a
// pattern floating above one: **the generated body IS the finished board.**
// Its footprint is the stock's footprint, its total thickness is the stock's
// thickness, and its top face is the pattern. There is no second object, so
// there is nothing in the viewport to confuse with the material. The relief
// exporter then samples that top face with Z0 at the stock's top, which makes
// the peaks untouched original surface and the valleys the only thing cut.
// ---------------------------------------------------------------------------

import type { SceneGeom, SceneNode } from '../types/scene';
import type { PaintLayer } from './vertexPaint';
import { buildHeightmapMesh, type HeightmapMeshResult } from './heightmapMesh';
import type { StockSize } from './stockSettings';
import {
  clamp01,
  fbm,
  fract,
  hash2D,
  mulberry32,
  normaliseGrid,
  valueNoise2D,
} from './patternNoise';

// --- The field descriptor the modal renders from ---------------------------

/**
 * One control in the generator dialog.
 *
 * The patterns describe their own controls rather than each getting bespoke
 * JSX, so adding a pattern is one object in one file and the modal never grows
 * a branch. `parametricShapes.ts` in Etch reached the same shape for the same
 * reason -- there, because "inner radius" means something different for a star
 * and a gear; here, because "scale" means ring spacing in one pattern and
 * brick length in another.
 */
export type PatternField =
  | {
      kind: 'number';
      key: string;
      label: string;
      min: number;
      max: number;
      step: number;
      /** Shown after the input: 'mm', 'x', and so on. */
      unit?: string;
      hint?: string;
    }
  | {
      kind: 'choice';
      key: string;
      label: string;
      options: Array<{ value: string; label: string }>;
      hint?: string;
    }
  | { kind: 'seed'; key: string; label: string; hint?: string };

export type PatternOptions = Record<string, number | string>;

/**
 * The board a pattern is being drawn onto, in **metres**.
 *
 * Pattern space is real space. Every parameter these generators take is a
 * physical size -- a ring spacing, a brick, a stud pitch -- so the space they
 * are evaluated in has to be one too. The first version of this ran x over
 * 0..aspect and y over 0..1, which quietly meant a ring spacing given in
 * millimetres only came out right on a board exactly one metre deep.
 */
export interface PatternExtent {
  widthM: number;
  depthM: number;
}

export interface PatternSpec {
  id: string;
  label: string;
  /** One line under the title in the dialog: what this is for. */
  blurb: string;
  /** Anything the material has to be told about this pattern before it is cut. */
  caveat?: string;
  defaults: PatternOptions;
  fields: PatternField[];
  /**
   * Build the height grid over a board of `extent` metres.
   *
   * Must return `cols * rows` values, row-major, spanning 0..1.
   */
  build(cols: number, rows: number, extent: PatternExtent, opts: PatternOptions): Float32Array;
  /**
   * What the surface looks like at a given height, 0..1.
   *
   * The same paint the colour sidebar puts on a body, laid down by the
   * generator instead of by hand: a tiger board that is orange with black bars
   * says what it is at a glance, where one in a single timber brown is a relief
   * you have to tilt to read. It is painted per vertex on the top surface, so
   * the physics, the mesh and every exporter are untouched -- the colour is
   * only ever a colour.
   *
   * Left out where colour would be a lie: a stud plate is whatever the stock
   * is, and so is a wave.
   */
  palette?: (h: number, opts: PatternOptions) => [number, number, number];
  /** The body's own colour under the paint. */
  baseRgb?: [number, number, number];
  /**
   * How deep the dialog opens at, as a fraction of the stock's thickness.
   *
   * Not one number for all of them, because depth is doing a different job in
   * each. A wood grain or a brick course is read by eye from its shadows, so it
   * wants to be deep. An animal print is read from its colour and only needs
   * enough relief to catch the light -- cutting a tiger 8 mm into a board
   * triples the machining time and puts every black stripe down a trench where
   * it is in shadow and barely orange any more.
   */
  depthFraction?: number;
}

/** What the dialog opens at when a pattern does not ask for something else. */
export const DEFAULT_DEPTH_FRACTION = 1 / 3;

/** The shallowest a carve is worth setting up for, in mm. */
export const MIN_SENSIBLE_DEPTH_MM = 1.2;

/** Mix two colours. */
const mix = (
  a: [number, number, number], b: [number, number, number], t: number
): [number, number, number] => {
  const k = clamp01(t);
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
};

/** A hard edge between two colours, softened just enough not to look aliased. */
const band = (
  low: [number, number, number], high: [number, number, number], h: number, edge = 0.5, soft = 0.12
): [number, number, number] => mix(low, high, (h - (edge - soft)) / (2 * soft));

const num = (opts: PatternOptions, key: string, fallback: number): number => {
  const v = opts[key];
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
};

const str = (opts: PatternOptions, key: string, fallback: string): string => {
  const v = opts[key];
  return typeof v === 'string' ? v : fallback;
};

const seedField = (key = 'seed'): PatternField => ({
  kind: 'seed',
  key,
  label: 'Seed',
  hint: 'The same seed always gives the same pattern. Change it for a different one of the same kind.',
});

/**
 * Walk the grid in metres: x across the board's width, y down its depth.
 *
 * Because both axes are in the same real units, a feature is the size it says
 * it is and is never stretched by the board's shape -- a stud is round on a
 * 300x100 plank as well as on a square one.
 */
function fillGrid(
  cols: number,
  rows: number,
  extent: PatternExtent,
  fn: (x: number, y: number) => number
): Float32Array {
  const out = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const y = (rows > 1 ? r / (rows - 1) : 0) * extent.depthM;
    for (let c = 0; c < cols; c++) {
      const x = (cols > 1 ? c / (cols - 1) : 0) * extent.widthM;
      out[r * cols + c] = fn(x, y);
    }
  }
  return out;
}

// --- Wood grain ------------------------------------------------------------

const woodGrain: PatternSpec = {
  id: 'wood_grain',
  label: 'Wood Grain',
  blurb: 'Exaggerated growth rings, wandering the way real grain does, with knots.',
  defaults: { ringSpacingMm: 9, wander: 0.45, knots: 2, angleDeg: 0, seed: 1 },
  // Earlywood is the soft pale band, latewood the hard dark one. The board is
  // the pale timber and the rings are what is darker than it.
  baseRgb: [0.78, 0.60, 0.36],
  palette: (h) => mix([0.34, 0.20, 0.10], [0.82, 0.63, 0.38], Math.pow(h, 0.7)),
  fields: [
    { kind: 'number', key: 'ringSpacingMm', label: 'Ring spacing', min: 1, max: 60, step: 0.5, unit: 'mm',
      hint: 'Distance between growth rings. Tight rings are slow-grown timber; wide rings are fast.' },
    { kind: 'number', key: 'wander', label: 'Wander', min: 0, max: 1.5, step: 0.05,
      hint: 'How far the rings drift from concentric. Zero gives a machine-made look; this is the setting that makes it read as wood.' },
    { kind: 'number', key: 'knots', label: 'Knots', min: 0, max: 8, step: 1,
      hint: 'Rings close around a knot, so each one pulls the whole pattern towards it.' },
    { kind: 'number', key: 'angleDeg', label: 'Grain angle', min: -90, max: 90, step: 5, unit: 'deg' },
    seedField(),
  ],
  build(cols, rows, extent, opts) {
    const spacing = Math.max(0.2, num(opts, 'ringSpacingMm', 9)) / 1000;
    const wander = Math.max(0, num(opts, 'wander', 0.45));
    const knotCount = Math.max(0, Math.round(num(opts, 'knots', 2)));
    const angle = (num(opts, 'angleDeg', 0) * Math.PI) / 180;
    const seed = Math.round(num(opts, 'seed', 1));
    const { widthM, depthM } = extent;

    const rnd = mulberry32(seed);
    const knots = Array.from({ length: knotCount }, () => ({
      x: rnd() * widthM,
      y: rnd() * depthM,
      // A knot's whorl has to die away well inside the board or it flattens
      // everything; a fifth of the depth is about what a real one occupies.
      radius: depthM * (0.06 + rnd() * 0.12),
      strength: 0.5 + rnd() * 0.9,
    }));

    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    // The pith sits off the board, a little over a board's depth away. That is
    // what makes this a flat-sawn plank -- long gentle arcs -- rather than the
    // bullseye of a slice straight through a trunk.
    const pithY = -depthM * 1.4;

    // Rings are arcs, not circles: a real ring is metres across and the board
    // is a few hundred millimetres, so the curvature visible on one plank is
    // slight. Squashing x is what turns concentric circles into that.
    const squash = 0.32;

    // Two lengths, and keeping them apart is the whole difference between
    // grain and noise. The wander is a long, low-frequency swell measured in
    // RINGS, so "wander 0.5" means half a ring's drift at any grain size; the
    // texture is a fine streak stretched along the grain. Both are kept well
    // above the cell size of the grid they will be sampled onto -- the first
    // version of this warped at a frequency finer than the grid and the right
    // hand end of the board came out as speckle.
    const warpLen = depthM * 0.8;
    const warpAmp = wander * spacing * 1.6;
    const streakAlong = spacing * 6;
    const streakAcross = spacing * 0.5;

    return normaliseGrid(
      fillGrid(cols, rows, extent, (x, y) => {
        // Rotate into grain space, so the rings run along the chosen angle.
        const gx = x * cosA - y * sinA;
        const gy = x * sinA + y * cosA;

        let d = Math.hypot(gx * squash, gy - pithY);

        // Each knot pulls the ring distance down towards a local minimum, so
        // the rings close around it in a whorl.
        //
        // A bounded smoothstep bump rather than the inverse distance this
        // started as. Inverse distance has no upper limit, so next to a knot
        // the ring count changed by tens of rings from one cell to the next,
        // and the whole neighbourhood aliased into speckle. The pull is a
        // fixed few rings deep and spread over the knot's whole reach, which
        // keeps its gradient well under one ring per grid cell.
        for (const k of knots) {
          const kx = k.x * cosA - k.y * sinA;
          const ky = k.x * sinA + k.y * cosA;
          const reach = k.radius * 5;
          const dist = Math.hypot(gx - kx, gy - ky);
          if (dist < reach) {
            const t = 1 - dist / reach;
            d -= k.strength * spacing * 2.5 * t * t * (3 - 2 * t);
          }
        }

        // Warp the distance, not the ring function: rings are a trivial
        // repeating ramp and all the character is in where they are read.
        d += (fbm(gx / warpLen, gy / warpLen, seed, 4) - 0.5) * 2 * warpAmp;

        const rings = fract(d / spacing);

        // Late wood is a hard narrow band, early wood a soft wide one; a plain
        // sawtooth gives every ring the same slope and looks printed.
        const band = Math.pow(rings, 0.6);
        const streak =
          (fbm(gx / streakAlong, gy / streakAcross, seed ^ 0x51, 2) - 0.5) * 0.16;
        return clamp01(band * 0.88 + streak);
      })
    );
  },
};

// --- Waves -----------------------------------------------------------------

const waves: PatternSpec = {
  id: 'waves',
  label: 'Waves',
  blurb: 'Summed sine waves: a swell, a crossed chop, or rings from point sources.',
  defaults: { wavelengthMm: 25, sources: 3, mode: 'linear', angleDeg: 0, chop: 0.35, seed: 1 },
  fields: [
    { kind: 'number', key: 'wavelengthMm', label: 'Wavelength', min: 2, max: 300, step: 1, unit: 'mm',
      hint: 'Crest to crest. Below about four times the cutter diameter the tool cannot reach the troughs.' },
    { kind: 'choice', key: 'mode', label: 'Form', options: [
      { value: 'linear', label: 'Swell' },
      { value: 'crossed', label: 'Crossed' },
      { value: 'radial', label: 'Ripples' },
    ] },
    { kind: 'number', key: 'sources', label: 'Sources', min: 1, max: 8, step: 1,
      hint: 'More sources interfere into a less regular surface.' },
    { kind: 'number', key: 'angleDeg', label: 'Direction', min: -90, max: 90, step: 5, unit: 'deg' },
    { kind: 'number', key: 'chop', label: 'Chop', min: 0, max: 1, step: 0.05,
      hint: 'Short steep detail riding on the main wave.' },
    seedField(),
  ],
  build(cols, rows, extent, opts) {
    const lambda = Math.max(0.5, num(opts, 'wavelengthMm', 25)) / 1000;
    const sources = Math.max(1, Math.round(num(opts, 'sources', 3)));
    const mode = str(opts, 'mode', 'linear');
    const angle = (num(opts, 'angleDeg', 0) * Math.PI) / 180;
    const chop = Math.max(0, num(opts, 'chop', 0.35));
    const seed = Math.round(num(opts, 'seed', 1));
    const rnd = mulberry32(seed);

    // Pattern space is metres, so a wavelength in metres is a wavelength.
    const k = (2 * Math.PI) / Math.max(1e-6, lambda);

    const emitters = Array.from({ length: sources }, (_, i) => ({
      // Spread the directions around the chosen angle rather than randomly, so
      // "Direction" still means something with several sources.
      dir: angle + (i === 0 ? 0 : (rnd() - 0.5) * 1.2),
      phase: rnd() * Math.PI * 2,
      amp: i === 0 ? 1 : 0.35 + rnd() * 0.5,
      cx: rnd() * extent.widthM,
      cy: rnd() * extent.depthM,
    }));

    return normaliseGrid(
      fillGrid(cols, rows, extent, (x, y) => {
        let sum = 0;
        let norm = 0;
        for (const e of emitters) {
          let phase: number;
          if (mode === 'radial') {
            phase = Math.hypot(x - e.cx, y - e.cy) * k + e.phase;
          } else if (mode === 'crossed') {
            phase = (x * Math.cos(e.dir) + y * Math.sin(e.dir)) * k + e.phase;
          } else {
            // A swell keeps every source running the same way; only the phase
            // and amplitude differ, which is what makes it a swell and not a
            // chop.
            phase = (x * Math.cos(angle) + y * Math.sin(angle)) * k + e.phase;
          }
          sum += Math.sin(phase) * e.amp;
          norm += e.amp;
        }
        const base = norm > 0 ? sum / norm : 0;
        // Chop rides on the main wave at a few times its frequency, so it
        // stays chop rather than becoming a second swell at any wavelength.
        const detail = chop > 0 ? (fbm(x / lambda * 4, y / lambda * 4, seed, 3) - 0.5) * chop : 0;
        return base * 0.5 + 0.5 + detail;
      })
    );
  },
};

// --- Topographic -----------------------------------------------------------

const topographic: PatternSpec = {
  id: 'topographic',
  label: 'Topographic',
  blurb: 'A landscape cut into flat terraces, like a contour model.',
  caveat: 'Every terrace is flat, so this is the one pattern here a flat end mill cuts as well as a ball nose.',
  defaults: { levels: 7, featureSizeMm: 60, sharpness: 0.85, seed: 1 },
  baseRgb: [0.45, 0.55, 0.38],
  // A contour model reads the way a map does: low ground green, high ground
  // bare rock, tops bleached out.
  palette: (h) => (h < 0.45
    ? mix([0.23, 0.42, 0.28], [0.52, 0.60, 0.33], h / 0.45)
    : h < 0.8
      ? mix([0.52, 0.60, 0.33], [0.58, 0.47, 0.35], (h - 0.45) / 0.35)
      : mix([0.58, 0.47, 0.35], [0.93, 0.93, 0.92], (h - 0.8) / 0.2)),
  fields: [
    { kind: 'number', key: 'levels', label: 'Levels', min: 2, max: 24, step: 1,
      hint: 'How many flat steps between the lowest point and the highest.' },
    { kind: 'number', key: 'featureSizeMm', label: 'Feature size', min: 5, max: 500, step: 5, unit: 'mm',
      hint: 'Roughly how far it is across one hill.' },
    { kind: 'number', key: 'sharpness', label: 'Step sharpness', min: 0, max: 1, step: 0.05,
      hint: '1 gives vertical risers between terraces; lower rounds them into ramps a cutter enters more gently.' },
    seedField(),
  ],
  build(cols, rows, extent, opts) {
    // Two levels is a plateau and a floor, which is the shallowest thing that
    // is still terrain. One level is a flat board -- not a pattern, and not
    // something to let a dialog produce.
    const levels = Math.max(2, Math.round(num(opts, 'levels', 7)));
    const feature = Math.max(1, num(opts, 'featureSizeMm', 60)) / 1000;
    const sharpness = clamp01(num(opts, 'sharpness', 0.85));
    const seed = Math.round(num(opts, 'seed', 1));
    const freq = 1 / Math.max(1e-4, feature);

    const raw = fillGrid(cols, rows, extent, (x, y) =>
      fbm(x * freq, y * freq, seed, 5)
    );
    normaliseGrid(raw);

    // Quantise after normalising, or the number of terraces that actually
    // appear depends on how much of the range the noise happened to use.
    //
    // A terrace is a flat top and a riser, so the shape wanted here is a
    // smoothstep whose transition occupies only part of each step: at
    // sharpness 1 the riser is vertical and the terrace is the whole step; at
    // 0 the riser is the whole step and nothing is flat, which is the original
    // landscape back again.
    const riser = Math.max(1e-4, 1 - sharpness);
    const lo = 0.5 - riser / 2;
    const hi = 0.5 + riser / 2;
    for (let i = 0; i < raw.length; i++) {
      const scaled = raw[i] * (levels - 1);
      const floorLevel = Math.floor(scaled);
      const frac = scaled - floorLevel;
      const t = frac <= lo ? 0 : frac >= hi ? 1 : (frac - lo) / riser;
      // Smoothstep the riser itself, so the cutter is never asked to turn a
      // corner it cannot: a linear riser meets the terrace at a hard edge.
      const eased = t * t * (3 - 2 * t);
      raw[i] = (floorLevel + eased) / (levels - 1);
    }
    return normaliseGrid(raw);
  },
};

// --- Voronoi / cracked earth ----------------------------------------------

const crackedEarth: PatternSpec = {
  id: 'voronoi',
  label: 'Cracked Earth',
  blurb: 'Cells with chamfered walls: dried mud, stone, crazed glaze, leather.',
  defaults: { cells: 40, wallWidthMm: 3, profile: 'chamfer', seed: 1 },
  baseRgb: [0.60, 0.45, 0.32],
  // Dried mud: the cracks are in shadow and hold the damp, the plates are
  // bleached by the sun.
  palette: (h) => mix([0.24, 0.16, 0.11], [0.72, 0.57, 0.40], Math.pow(h, 0.8)),
  fields: [
    { kind: 'number', key: 'cells', label: 'Cells', min: 3, max: 400, step: 1 },
    { kind: 'number', key: 'wallWidthMm', label: 'Crack width', min: 0.5, max: 30, step: 0.5, unit: 'mm',
      hint: 'How wide the groove between cells is at the surface. Narrower than the cutter and it simply will not be cut that narrow.' },
    { kind: 'choice', key: 'profile', label: 'Crack profile', options: [
      { value: 'chamfer', label: 'Chamfer' },
      { value: 'round', label: 'Round' },
      { value: 'square', label: 'Square' },
    ] },
    seedField(),
  ],
  build(cols, rows, extent, opts) {
    const cellCount = Math.max(2, Math.round(num(opts, 'cells', 40)));
    // A zero-width crack is a scribed line, which is a V-carve job and one Etch
    // already does properly. Floor it at something a pattern can express.
    const wall = Math.max(0.2, num(opts, 'wallWidthMm', 3)) / 1000;
    const profile = str(opts, 'profile', 'chamfer');
    const seed = Math.round(num(opts, 'seed', 1));
    const rnd = mulberry32(seed);

    const sites = Array.from({ length: cellCount }, () => ({
      x: rnd() * extent.widthM,
      y: rnd() * extent.depthM,
      // A little height variation between cells so the surface is not a single
      // plane with grooves scratched in it.
      lift: rnd(),
    }));

    return normaliseGrid(
      fillGrid(cols, rows, extent, (x, y) => {
        // Nearest and second nearest. The distance between the two is what
        // says "how close to a boundary am I" -- distance to the nearest site
        // alone gives cones, not cells.
        let d1 = Infinity;
        let d2 = Infinity;
        let lift = 0;
        for (const s of sites) {
          const d = Math.hypot(x - s.x, y - s.y);
          if (d < d1) {
            d2 = d1;
            d1 = d;
            lift = s.lift;
          } else if (d < d2) {
            d2 = d;
          }
        }
        const edge = (d2 - d1) / 2;
        let t = clamp01(edge / wall);
        if (profile === 'round') t = Math.sin((t * Math.PI) / 2);
        else if (profile === 'square') t = t > 0.5 ? 1 : 0;
        return t * 0.82 + lift * 0.18;
      })
    );
  },
};

// --- Masonry ---------------------------------------------------------------

const masonry: PatternSpec = {
  id: 'masonry',
  label: 'Brick Courses',
  blurb: 'Courses of brick with recessed mortar, in a running, stack or Flemish bond.',
  defaults: {
    brickLengthMm: 60, brickHeightMm: 20, mortarMm: 5, bond: 'running', jitter: 0.35, seed: 1,
  },
  baseRgb: [0.62, 0.30, 0.22],
  // Mortar is the floor of the pattern and brick is everything standing on it,
  // so the two separate cleanly at the bottom of the range.
  palette: (h) => (h < 0.3
    ? mix([0.74, 0.72, 0.68], [0.80, 0.78, 0.74], h / 0.3)
    : mix([0.52, 0.24, 0.17], [0.72, 0.38, 0.28], (h - 0.3) / 0.7)),
  fields: [
    { kind: 'number', key: 'brickLengthMm', label: 'Brick length', min: 5, max: 400, step: 1, unit: 'mm' },
    { kind: 'number', key: 'brickHeightMm', label: 'Brick height', min: 2, max: 200, step: 1, unit: 'mm' },
    { kind: 'number', key: 'mortarMm', label: 'Mortar joint', min: 0.5, max: 40, step: 0.5, unit: 'mm',
      hint: 'The recessed gap. A joint narrower than the cutter will come out as wide as the cutter.' },
    { kind: 'choice', key: 'bond', label: 'Bond', options: [
      { value: 'running', label: 'Running' },
      { value: 'stack', label: 'Stack' },
      { value: 'flemish', label: 'Flemish' },
    ] },
    { kind: 'number', key: 'jitter', label: 'Variation', min: 0, max: 1, step: 0.05,
      hint: 'Per-brick differences in height and face texture. Zero is a machine-laid wall; some variation is what stops it reading as a grid.' },
    seedField(),
  ],
  build(cols, rows, extent, opts) {
    const brickL = Math.max(0.5, num(opts, 'brickLengthMm', 60)) / 1000;
    const brickH = Math.max(0.5, num(opts, 'brickHeightMm', 20)) / 1000;
    const mortar = Math.max(0.1, num(opts, 'mortarMm', 5)) / 1000;
    const bond = str(opts, 'bond', 'running');
    const jitter = clamp01(num(opts, 'jitter', 0.35));
    const seed = Math.round(num(opts, 'seed', 1));

    const courseH = brickH + mortar;

    // Per-brick values are looked up by (course, index) rather than generated
    // into an array: the grid is sampled in arbitrary order and the board may
    // be any size, so a hash is both simpler and stable.
    const brickLift = (course: number, index: number): number =>
      valueNoise2D(index * 3.7 + 0.5, course * 5.3 + 0.5, seed ^ 0x9e37);

    return normaliseGrid(
      fillGrid(cols, rows, extent, (x, y) => {
        const course = Math.floor(y / courseH);
        const yInCourse = y - course * courseH;

        // Where this course starts, which is the whole difference between the
        // bonds. Flemish alternates a full and a half brick along the course,
        // so its offset is per brick rather than per course.
        let offset = 0;
        if (bond === 'running') offset = (course % 2) * brickL * 0.5;
        else if (bond === 'flemish') offset = (course % 2) * brickL * 0.25;

        const along = x + offset;
        let index = Math.floor(along / brickL);
        let xInBrick = along - index * brickL;
        let thisBrickL = brickL;

        if (bond === 'flemish') {
          // Alternate stretcher and header: a full brick then a half, repeating.
          const pairPos = fract(along / (brickL * 1.5)) * 1.5;
          index = Math.floor(along / (brickL * 1.5)) * 2;
          if (pairPos < 1) {
            xInBrick = pairPos * brickL;
            thisBrickL = brickL;
          } else {
            index += 1;
            xInBrick = (pairPos - 1) * brickL;
            thisBrickL = brickL * 0.5;
          }
        }

        // Mortar is a recess on all four sides of every brick face.
        const half = mortar / 2;
        const inMortar =
          yInCourse < mortar ||
          xInBrick < half ||
          xInBrick > thisBrickL - half;

        if (inMortar) return 0;

        // The brick face: mostly flat, lifted a little per brick, with a light
        // texture so it does not read as polished plastic.
        const lift = jitter > 0 ? (brickLift(course, index) - 0.5) * jitter * 0.35 : 0;
        const grit = jitter > 0 ? (fbm(x / brickH * 6, y / brickH * 6, seed ^ 0x77, 2) - 0.5) * jitter * 0.12 : 0;

        // Ease the face down into the joint over a fraction of the mortar
        // width, so the brick has an arris rather than a knife edge -- which a
        // round cutter cannot make anyway, and which chips out in real wood.
        const edge = Math.min(
          yInCourse - mortar,
          xInBrick - half,
          thisBrickL - half - xInBrick
        );
        const arris = clamp01(edge / (mortar * 0.6));

        return 0.35 + (0.65 + lift + grit) * arris;
      })
    );
  },
};

// --- Stud plate ------------------------------------------------------------

const studs: PatternSpec = {
  id: 'studs',
  label: 'Stud Plate',
  blurb: 'A flat plate with rows of round studs standing proud of it.',
  caveat:
    'This is the look, not a working brick. A carved surface has no undercuts, so there are no tubes underneath and nothing to clutch with -- a brick that actually grips needs a solid model and a fit measured in hundredths of a millimetre. A flat mill also leaves a fillet of its own radius around each stud root; a ball nose is the better finishing tool here.',
  defaults: { pitchMm: 8, diameterMm: 4.8, marginMm: 4, shoulder: 0.25 },
  fields: [
    { kind: 'number', key: 'pitchMm', label: 'Stud pitch', min: 1, max: 100, step: 0.1, unit: 'mm',
      hint: 'Centre to centre. 8 mm is the familiar one.' },
    { kind: 'number', key: 'diameterMm', label: 'Stud diameter', min: 0.5, max: 90, step: 0.1, unit: 'mm' },
    { kind: 'number', key: 'marginMm', label: 'Plate margin', min: 0, max: 100, step: 0.5, unit: 'mm',
      hint: 'Bare plate left around the edge of the board.' },
    { kind: 'number', key: 'shoulder', label: 'Edge softness', min: 0, max: 1, step: 0.05,
      hint: 'How much the top edge of each stud is rounded over. A cutter puts some there whatever this says.' },
  ],
  build(cols, rows, extent, opts) {
    const pitch = Math.max(0.2, num(opts, 'pitchMm', 8)) / 1000;
    const radius = Math.max(0.1, num(opts, 'diameterMm', 4.8)) / 2000;
    const margin = Math.max(0, num(opts, 'marginMm', 4)) / 1000;
    const shoulder = clamp01(num(opts, 'shoulder', 0.25));

    // Centre the field of studs on the board rather than starting at a corner,
    // so a partial stud never hangs off one edge with a wide bare strip at the
    // other.
    const usableW = Math.max(0, extent.widthM - margin * 2);
    const usableH = Math.max(0, extent.depthM - margin * 2);
    const nx = Math.max(0, Math.floor(usableW / pitch));
    const ny = Math.max(0, Math.floor(usableH / pitch));
    const originX = margin + (usableW - (nx - 1) * pitch) / 2;
    const originY = margin + (usableH - (ny - 1) * pitch) / 2;

    const out = fillGrid(cols, rows, extent, (x, y) => {
      if (nx < 1 || ny < 1) return 0;
      // Nearest stud centre, found by rounding rather than by searching every
      // one: the studs are on a regular lattice, so there is nothing to search.
      const ix = Math.min(nx - 1, Math.max(0, Math.round((x - originX) / pitch)));
      const iy = Math.min(ny - 1, Math.max(0, Math.round((y - originY) / pitch)));
      const d = Math.hypot(x - (originX + ix * pitch), y - (originY + iy * pitch));
      if (d >= radius) return 0;
      if (shoulder <= 0) return 1;
      // Round the top edge over the outer fraction of the radius.
      const soft = radius * shoulder * 0.6;
      if (d <= radius - soft) return 1;
      const t = (radius - d) / Math.max(1e-9, soft);
      return clamp01(Math.sin((t * Math.PI) / 2));
    });

    // Deliberately not normalised: a plate with no studs on it (a margin wider
    // than the board) is genuinely flat, and normalising would amplify the
    // floating-point dust into a full-depth pattern.
    return out;
  },
};

// --- Reaction-diffusion ----------------------------------------------------

/**
 * Gray-Scott, which is where tiger stripes, leopard rosettes, giraffe cracking
 * and coral all come from -- the same two numbers at different values.
 *
 * That is why there is one generator here rather than four stripe functions:
 * the family is the interesting thing, and the named presets below are only
 * feed/kill pairs.
 */
const REACTION_PRESETS: Record<string, { feed: number; kill: number }> = {
  // Measured, not cited: these came out of a sweep of feed against kill,
  // scored on how much structure each pair produced and then looked at. The
  // parameter space is mostly dead -- either the whole field decays to bare
  // substrate or it saturates -- and the band that is alive is narrow, so
  // these are not values to nudge without rendering the result.
  //
  // They are named for what they are. An earlier version of this called them
  // tiger, leopard and coral, which was wrong: Gray-Scott is isotropic, so it
  // has no way to prefer a direction and cannot make the parallel bars of a
  // tiger. Everything it makes is some arrangement of worms, spots and holes.
  // Anisotropic diffusion was tried and only elongates the blobs. Animal
  // markings have their own generator; see `animalPrint` below.
  labyrinth: { feed: 0.026, kill: 0.057 },   // long turning worms
  fingerprint: { feed: 0.030, kill: 0.057 }, // the same, tighter
  cells: { feed: 0.030, kill: 0.062 },       // rings and enclosures
  spots: { feed: 0.034, kill: 0.065 },       // separated round dots
  islands: { feed: 0.046, kill: 0.065 },     // broad irregular lobes
};

const reactionDiffusion: PatternSpec = {
  id: 'reaction_diffusion',
  label: 'Turing Pattern',
  blurb: 'Two chemicals, one eating the other: worms, spots and cells settle out of the mix.',
  caveat: 'Iterative, so the preview lags a moment behind the controls. For animal markings use Animal Print — this chemistry has no sense of direction and cannot make parallel stripes.',
  defaults: { preset: 'labyrinth', scale: 1, iterations: 3500, seed: 1 },
  // Colour carries this one; the relief only has to catch the light.
  depthFraction: 0.1,
  baseRgb: [0.24, 0.42, 0.52],
  palette: (h) => mix([0.10, 0.20, 0.28], [0.55, 0.82, 0.83], Math.pow(h, 0.8)),
  fields: [
    { kind: 'choice', key: 'preset', label: 'Regime', options: [
      { value: 'labyrinth', label: 'Labyrinth' },
      { value: 'fingerprint', label: 'Fingerprint' },
      { value: 'cells', label: 'Cells' },
      { value: 'spots', label: 'Spots' },
      { value: 'islands', label: 'Islands' },
    ] },
    { kind: 'number', key: 'scale', label: 'Feature scale', min: 0.25, max: 4, step: 0.05, unit: 'x',
      hint: 'Larger makes fewer, bigger features.' },
    { kind: 'number', key: 'iterations', label: 'Settling', min: 200, max: 8000, step: 100,
      hint: 'How long the chemistry runs. Too few and the pattern has not formed; past a few thousand it stops changing.' },
    seedField(),
  ],
  build(cols, rows, _extent, opts) {
    const preset = REACTION_PRESETS[str(opts, 'preset', 'labyrinth')] ?? REACTION_PRESETS.labyrinth;
    const scale = Math.max(0.05, num(opts, 'scale', 1));
    const iterations = Math.max(50, Math.round(num(opts, 'iterations', 3500)));
    const seed = Math.round(num(opts, 'seed', 1));

    // The simulation runs on its own grid, not the output grid: the pattern's
    // feature size is set by the lattice, so simulating at the export
    // resolution would make the markings shrink every time the resolution went
    // up. A fixed working size, sampled up afterwards, keeps "scale" meaning
    // what it says.
    const simW = Math.max(16, Math.min(320, Math.round(180 / scale)));
    const simH = Math.max(16, Math.min(320, Math.round((simW * rows) / Math.max(1, cols))));
    const n = simW * simH;

    const a = new Float32Array(n).fill(1);
    const b = new Float32Array(n);
    const rnd = mulberry32(seed);

    // Seed with a few random blobs. A single blob grows a symmetrical rosette;
    // scattered ones interfere and give a natural-looking field.
    const blobs = 12 + Math.floor(rnd() * 12);
    for (let i = 0; i < blobs; i++) {
      const bx = Math.floor(rnd() * simW);
      const by = Math.floor(rnd() * simH);
      const r = 2 + Math.floor(rnd() * 3);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const j = ((by + dy + simH) % simH) * simW + ((bx + dx + simW) % simW);
          // The seed is a half-depleted patch, not a saturated one. Setting
          // b to 1 against a = 1 makes the reaction term a*b*b equal 1 on the
          // very first step, which is a far larger kick than the diffusion can
          // carry and is what sent the first version of this to infinity.
          b[j] = 0.25;
          a[j] = 0.5;
        }
      }
    }

    const dA = 1.0;
    const dB = 0.5;
    const { feed, kill } = preset;
    const nextA = new Float32Array(n);
    const nextB = new Float32Array(n);

    for (let step = 0; step < iterations; step++) {
      for (let y = 0; y < simH; y++) {
        const yUp = ((y - 1 + simH) % simH) * simW;
        const yDn = ((y + 1) % simH) * simW;
        const yC = y * simW;
        for (let x = 0; x < simW; x++) {
          const xL = (x - 1 + simW) % simW;
          const xR = (x + 1) % simW;
          const i = yC + x;
          // The standard nine-point weighted Laplacian, with wraparound so
          // the pattern tiles and has no edge artefacts to trim off later.
          //
          // The weights sum to zero and are normalised: an unweighted
          // five-point stencil with these diffusion rates and a unit timestep
          // is unstable, and the whole field decays to bare substrate --
          // which is exactly what the first version of this did.
          const lapA =
            (a[yUp + xL] + a[yUp + xR] + a[yDn + xL] + a[yDn + xR]) * 0.05 +
            (a[yC + xL] + a[yC + xR] + a[yUp + x] + a[yDn + x]) * 0.2 -
            a[i];
          const lapB =
            (b[yUp + xL] + b[yUp + xR] + b[yDn + xL] + b[yDn + xR]) * 0.05 +
            (b[yC + xL] + b[yC + xR] + b[yUp + x] + b[yDn + x]) * 0.2 -
            b[i];
          const abb = a[i] * b[i] * b[i];
          const va = a[i] + (dA * lapA - abb + feed * (1 - a[i]));
          const vb = b[i] + (dB * lapB + abb - (kill + feed) * b[i]);
          // Both are concentrations, so both belong in 0..1. Without the
          // clamp a dips below zero somewhere, `abb` changes sign, and the
          // whole field diverges within a few dozen steps -- silently, because
          // the NaNs that come out the far end normalise to a flat board.
          nextA[i] = va < 0 ? 0 : va > 1 ? 1 : va;
          nextB[i] = vb < 0 ? 0 : vb > 1 ? 1 : vb;
        }
      }
      a.set(nextA);
      b.set(nextB);
    }

    // Sample the simulation up to the output grid, bilinearly, so the markings
    // have soft shoulders a cutter can follow instead of single-cell cliffs.
    const out = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      const sy = (r / Math.max(1, rows - 1)) * (simH - 1);
      const y0 = Math.floor(sy);
      const y1 = Math.min(simH - 1, y0 + 1);
      const fy = sy - y0;
      for (let c = 0; c < cols; c++) {
        const sx = (c / Math.max(1, cols - 1)) * (simW - 1);
        const x0 = Math.floor(sx);
        const x1 = Math.min(simW - 1, x0 + 1);
        const fx = sx - x0;
        const v00 = b[y0 * simW + x0];
        const v10 = b[y0 * simW + x1];
        const v01 = b[y1 * simW + x0];
        const v11 = b[y1 * simW + x1];
        out[r * cols + c] =
          (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
      }
    }
    return normaliseGrid(out);
  },
};

// --- Animal markings --------------------------------------------------------

/**
 * Coats, built the way they look rather than the way they grow.
 *
 * Reaction-diffusion is the famous answer to "where do animal markings come
 * from", and it is the wrong tool for drawing one. Gray-Scott is isotropic: it
 * has no way to prefer a direction, so it settles into worms and spots and can
 * never produce the parallel bars of a tiger. What it does make is under
 * `Turing Pattern`, named for what it is.
 *
 * These are drawn directly instead. A stripe is a warped band with a width that
 * varies along its length, which is what makes it taper and break the way a
 * real one does; a rosette is a broken ring with a small centre, on a jittered
 * lattice so the spacing is even without being a grid.
 */

/** Smoothstep between two edges. */
const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / Math.max(1e-9, e1 - e0));
  return t * t * (3 - 2 * t);
};

/**
 * One band of a striped coat at a point.
 *
 * The bar's *width* is modulated along its length rather than its position:
 * moving it would slide the whole stripe sideways, whereas pinching it makes
 * the stripe taper to a point and break in two, which is what tiger and zebra
 * markings actually do.
 */
function stripeAt(
  x: number, y: number, seed: number, pitch: number, duty: number, warp: number
): number {
  const wx = (fbm(x / (pitch * 7), y / (pitch * 2.2), seed, 4) - 0.5) * 2 * warp * pitch;
  const d = Math.abs(fract((x + wx) / pitch) - 0.5) * 2;
  const taper = 0.25 + 1.5 * fbm(x / (pitch * 9), y / (pitch * 0.7), seed ^ 0x77, 3);
  const w = clamp01(duty * taper);
  return 1 - smoothstep(w * 0.75, w * 1.25, d);
}

/**
 * One spot of a spotted coat at a point.
 *
 * The lattice is jittered rather than random: real spots are evenly spaced
 * without being in rows, and scattering points at random leaves clumps and bald
 * patches. Only the nine surrounding cells are searched, because a jittered
 * lattice cannot put a nearer spot any further away than that.
 */
function spotAt(
  x: number, y: number, seed: number, pitch: number, radius: number, ringed: boolean
): number {
  const cx = Math.floor(x / pitch);
  const cy = Math.floor(y / pitch);
  let best = Infinity;
  let bx = 0, by = 0, gi = 0, gj = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const gx = cx + i;
      const gy = cy + j;
      const px = (gx + 0.15 + 0.7 * hash2D(gx, gy, seed)) * pitch;
      const py = (gy + 0.15 + 0.7 * hash2D(gx, gy, seed ^ 0x51)) * pitch;
      const d = Math.hypot(x - px, y - py);
      if (d < best) { best = d; bx = px; by = py; gi = gx; gj = gy; }
    }
  }
  const r = radius * (0.65 + 0.7 * hash2D(gi, gj, seed ^ 0x99));
  const t = best / Math.max(1e-9, r);
  if (t > 1.2) return 0;
  if (!ringed) return 1 - smoothstep(0.8, 1, t);
  // A rosette: an outer ring broken into arcs, with a small centre inside it.
  // The angle is measured from this spot's own centre, so each rosette breaks
  // in its own places rather than all of them breaking along one direction.
  const ang = Math.atan2(y - by, x - bx);
  const arc = fbm(Math.cos(ang) * 1.6 + gi * 3.1, Math.sin(ang) * 1.6 + gj * 3.1, seed ^ 0x33, 2);
  // Eased rather than switched. A hard on/off around the ring put a cliff
  // between neighbouring cells wherever the gate crossed, which reads as
  // speckle on the rim instead of as a broken ring.
  const gate = 0.25 + 0.75 * smoothstep(0.36, 0.54, arc);
  const ring = (1 - smoothstep(0.82, 1, t)) * smoothstep(0.46, 0.68, t) * gate;
  const core = (1 - smoothstep(0.2, 0.34, t)) * 0.5;
  return Math.max(ring, core);
}

const animalPrint: PatternSpec = {
  id: 'animal_print',
  label: 'Animal Print',
  blurb: 'Tiger and zebra bars, leopard rosettes, cheetah spots, giraffe patches, cow blotches.',
  defaults: { coat: 'tiger', scaleMm: 22, boldness: 0.45, wander: 0.9, seed: 7 },
  // Colour carries this one; the relief only has to catch the light.
  depthFraction: 0.1,
  baseRgb: [0.82, 0.55, 0.22],
  /*
   * The markings are the raised part of the field, so `h` near 1 is marking and
   * near 0 is bare coat. Each coat names its own two colours; the edge is
   * softened over a narrow band so the boundary is smooth rather than stepped
   * from one vertex to the next.
   */
  palette: (h, opts) => {
    const coats: Record<string, [[number, number, number], [number, number, number]]> = {
      tiger: [[0.85, 0.47, 0.13], [0.09, 0.07, 0.06]],
      zebra: [[0.93, 0.91, 0.87], [0.08, 0.08, 0.09]],
      leopard: [[0.83, 0.64, 0.33], [0.16, 0.11, 0.07]],
      cheetah: [[0.86, 0.71, 0.42], [0.12, 0.09, 0.07]],
      giraffe: [[0.91, 0.84, 0.66], [0.47, 0.26, 0.12]],
      cow: [[0.94, 0.93, 0.91], [0.13, 0.11, 0.10]],
    };
    const coat = typeof opts.coat === 'string' ? opts.coat : 'tiger';
    const [ground, marking] = coats[coat] ?? coats.tiger;
    // Giraffe is the odd one: its patches are the raised part and the pale
    // seams are the gaps, so it reads the other way round from a spotted coat.
    return coat === 'giraffe'
      ? band(ground, marking, h, 0.5, 0.1)
      : band(ground, marking, h, 0.45, 0.12);
  },
  fields: [
    { kind: 'choice', key: 'coat', label: 'Coat', options: [
      { value: 'tiger', label: 'Tiger' },
      { value: 'zebra', label: 'Zebra' },
      { value: 'leopard', label: 'Leopard' },
      { value: 'cheetah', label: 'Cheetah' },
      { value: 'giraffe', label: 'Giraffe' },
      { value: 'cow', label: 'Cow' },
    ] },
    { kind: 'number', key: 'scaleMm', label: 'Marking size', min: 2, max: 400, step: 1, unit: 'mm',
      hint: 'Stripe pitch, or how far apart the spots sit.' },
    { kind: 'number', key: 'boldness', label: 'Boldness', min: 0.05, max: 0.95, step: 0.05,
      hint: 'How much of the coat the markings cover.' },
    { kind: 'number', key: 'wander', label: 'Wander', min: 0, max: 2, step: 0.05,
      hint: 'How far the markings stray from regular. Zero is wallpaper.' },
    seedField(),
  ],
  build(cols, rows, extent, opts) {
    const coat = str(opts, 'coat', 'tiger');
    const scale = Math.max(0.5, num(opts, 'scaleMm', 22)) / 1000;
    const boldness = clamp01(num(opts, 'boldness', 0.45));
    const wander = Math.max(0, num(opts, 'wander', 0.9));
    const seed = Math.round(num(opts, 'seed', 7));

    const field = (x: number, y: number): number => {
      switch (coat) {
        case 'zebra':
          // Bolder and straighter than a tiger, and the bars reach right round.
          return stripeAt(x, y, seed, scale * 1.4, boldness * 1.35, wander * 0.6);
        case 'leopard':
          // Rosettes sit about a diameter apart: closer and the rings merge
          // into a net, which is a giraffe rather than a leopard.
          return spotAt(x, y, seed, scale, scale * 0.34 * (0.7 + boldness), true);
        case 'cheetah':
          // Smaller, rounder and more of them than a leopard's.
          return spotAt(x, y, seed, scale * 0.55, scale * 0.13 * (0.7 + boldness), false);
        case 'giraffe': {
          // Polygonal patches parted by pale seams: a Voronoi diagram with wide
          // joints, which is what a reticulated hide is.
          const rnd = seed;
          const cx = Math.floor(x / scale);
          const cy = Math.floor(y / scale);
          let d1 = Infinity;
          let d2 = Infinity;
          for (let j = -1; j <= 1; j++) {
            for (let i = -1; i <= 1; i++) {
              const gx = cx + i;
              const gy = cy + j;
              const px = (gx + 0.1 + 0.8 * hash2D(gx, gy, rnd)) * scale;
              const py = (gy + 0.1 + 0.8 * hash2D(gx, gy, rnd ^ 0x71)) * scale;
              // Wobble the seam so the patches are not straight-edged polygons.
              const wob = (fbm(x / (scale * 0.6), y / (scale * 0.6), rnd, 3) - 0.5) * scale * 0.25 * wander;
              const d = Math.hypot(x - px, y - py) + wob;
              if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
            }
          }
          const seam = scale * 0.18 * (1.3 - boldness);
          return smoothstep(0, seam, (d2 - d1) / 2);
        }
        case 'cow': {
          // Big soft blotches: low-frequency noise cut at a level, with the
          // edge left soft enough for a cutter to follow.
          const n = fbm(x / (scale * 1.6), y / (scale * 1.6), seed, 4);
          const edge = 0.04 + 0.05 * wander;
          return smoothstep(0.5 - edge, 0.5 + edge, n + (boldness - 0.5) * 0.4);
        }
        case 'tiger':
        default:
          return stripeAt(x, y, seed, scale, boldness, wander);
      }
    };

    // Not normalised: a coat is markings on bare ground, and the ground is
    // genuinely flat. Stretching it would turn the gaps into their own relief.
    return fillGrid(cols, rows, extent, (x, y) => clamp01(field(x, y)));
  },
};

// --- Foliage ---------------------------------------------------------------

const foliage: PatternSpec = {
  id: 'foliage',
  label: 'Vines & Leaves',
  blurb: 'A climbing vine with leaves, grown branch by branch and carved in relief.',
  defaults: { iterations: 7, branchAngleDeg: 28, decay: 0.76, leafSizeMm: 7, stemWidthMm: 3, seed: 1 },
  baseRgb: [0.55, 0.45, 0.32],
  // Bare ground under the vine, greener the further the growth stands proud.
  palette: (h) => (h < 0.08
    ? [0.58, 0.48, 0.35]
    : mix([0.26, 0.34, 0.16], [0.44, 0.66, 0.26], (h - 0.08) / 0.92)),
  fields: [
    { kind: 'number', key: 'iterations', label: 'Growth', min: 2, max: 11, step: 1,
      hint: 'How many times the vine branches. Each step roughly doubles the stems.' },
    { kind: 'number', key: 'branchAngleDeg', label: 'Branch angle', min: 5, max: 80, step: 1, unit: 'deg' },
    { kind: 'number', key: 'decay', label: 'Taper', min: 0.4, max: 0.95, step: 0.01,
      hint: 'How much shorter and thinner each branch is than its parent.' },
    { kind: 'number', key: 'leafSizeMm', label: 'Leaf size', min: 0, max: 60, step: 0.5, unit: 'mm',
      hint: 'Zero leaves a bare vine.' },
    { kind: 'number', key: 'stemWidthMm', label: 'Stem width', min: 0.5, max: 30, step: 0.5, unit: 'mm' },
    seedField(),
  ],
  build(cols, rows, extent, opts) {
    const iterations = Math.max(1, Math.round(num(opts, 'iterations', 7)));
    const branchAngle = (num(opts, 'branchAngleDeg', 28) * Math.PI) / 180;
    const decay = Math.min(0.98, Math.max(0.3, num(opts, 'decay', 0.76)));
    const leafSize = Math.max(0, num(opts, 'leafSizeMm', 7)) / 1000;
    const stemWidth = Math.max(0.1, num(opts, 'stemWidthMm', 3)) / 1000;
    const seed = Math.round(num(opts, 'seed', 1));
    const rnd = mulberry32(seed);

    // Grow the skeleton first, as segments and leaf discs. Rasterising comes
    // after, because a relief wants distance-to-the-skeleton, not a stroked
    // line: a stem has to be a rounded ridge, not a flat-topped wall.
    interface Seg { x0: number; y0: number; x1: number; y1: number; w: number }
    const segs: Seg[] = [];
    const leaves: Array<{ x: number; y: number; r: number; angle: number }> = [];

    const grow = (
      x: number, y: number, angle: number, length: number, width: number, depth: number
    ): void => {
      if (depth <= 0 || length < 0.002) return;
      // Vines wander; a straight L-system reads as a circuit diagram.
      const wobble = (rnd() - 0.5) * 0.35;
      const x1 = x + Math.cos(angle + wobble) * length;
      const y1 = y + Math.sin(angle + wobble) * length;
      segs.push({ x0: x, y0: y, x1, y1, w: width });

      if (leafSize > 0 && depth <= Math.max(1, iterations - 3)) {
        leaves.push({
          x: x1, y: y1,
          r: leafSize * (0.6 + rnd() * 0.6),
          angle: angle + (rnd() - 0.5),
        });
      }

      const spread = branchAngle * (0.7 + rnd() * 0.6);
      grow(x1, y1, angle - spread, length * decay, width * decay, depth - 1);
      grow(x1, y1, angle + spread, length * decay, width * decay, depth - 1);
      // A third shoot now and then, so the vine is not a perfect binary tree.
      if (rnd() < 0.25) {
        grow(x1, y1, angle + (rnd() - 0.5) * 0.4, length * decay * 0.8, width * decay * 0.8, depth - 2);
      }
    };

    // Two or three vines rooted along the bottom edge, growing up the board.
    // The first stem is a quarter of the board's depth, so the vine fills the
    // board at any size rather than being a fixed number of millimetres tall.
    const roots = 2 + Math.floor(rnd() * 2);
    for (let i = 0; i < roots; i++) {
      const x = extent.widthM * ((i + 0.5 + (rnd() - 0.5) * 0.4) / roots);
      grow(x, extent.depthM, -Math.PI / 2 + (rnd() - 0.5) * 0.5, extent.depthM * 0.26, stemWidth, iterations);
    }

    // Distance from a point to a segment, which is what makes the stem round.
    const distToSeg = (px: number, py: number, s: Seg): number => {
      const dx = s.x1 - s.x0;
      const dy = s.y1 - s.y0;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? clamp01(((px - s.x0) * dx + (py - s.y0) * dy) / len2) : 0;
      return Math.hypot(px - (s.x0 + t * dx), py - (s.y0 + t * dy));
    };

    const out = fillGrid(cols, rows, extent, (x, y) => {
      let best = 0;
      for (const s of segs) {
        const d = distToSeg(x, y, s);
        if (d < s.w) {
          // A circular cross-section: full height on the centreline, falling to
          // nothing at the edge.
          const h = Math.sqrt(Math.max(0, 1 - (d / s.w) ** 2));
          if (h > best) best = h;
        }
      }
      for (const l of leaves) {
        // An ellipse, long axis along the leaf's angle, pointed at both ends.
        const dx = x - l.x;
        const dy = y - l.y;
        const ca = Math.cos(-l.angle);
        const sa = Math.sin(-l.angle);
        const lx = (dx * ca - dy * sa) / l.r;
        const ly = (dx * sa + dy * ca) / (l.r * 0.45);
        const r2 = lx * lx + ly * ly;
        if (r2 < 1) {
          const h = Math.sqrt(1 - r2) * 0.72;
          if (h > best) best = h;
        }
      }
      return best;
    });

    // Not normalised, for the same reason as the stud plate: a vine occupies
    // part of the board and the bare ground between stems is genuinely flat.
    return out;
  },
};

// --- The registry ----------------------------------------------------------

export const SURFACE_PATTERNS: PatternSpec[] = [
  woodGrain,
  masonry,
  waves,
  topographic,
  crackedEarth,
  studs,
  animalPrint,
  reactionDiffusion,
  foliage,
];

export function patternById(id: string): PatternSpec | undefined {
  return SURFACE_PATTERNS.find((p) => p.id === id);
}

// --- Grid -> board ---------------------------------------------------------

/**
 * The most cells worth building. Matches the relief exporter's own cap: a grid
 * finer than the one that will be machined from it is detail that cannot reach
 * the material.
 */
export const MAX_PATTERN_CELLS = 260_000;

/**
 * The solid left under the pattern, in mm.
 *
 * The generated body is the **carved panel**, not the whole board: the pattern,
 * plus enough material under it to be a watertight solid rather than a shell.
 *
 * It is not the stock's full thickness, and that is not a shortcut. The relief
 * exporter takes its carve depth from the model's total height -- and that
 * number then decides the roughing layers and how far the cutter has to reach.
 * Hand it a 20 mm board carrying a 5 mm pattern and it plans a 20 mm carve:
 * fifteen millimetres of roughing passes through air, and a recommendation for
 * a cutter long enough to reach a floor nothing is ever cut down to.
 *
 * So the panel's height IS the carve depth, which is the contract the exporter
 * was built around. What it is cut from is the stock thickness, which the
 * generator checks the pattern will fit inside and otherwise leaves alone.
 */
export const PANEL_BASE_MM = 2;

/**
 * Material the exporter insists on leaving under the deepest cut, in mm.
 * Matches its own `stockThicknessMm - 1` rule; the generator refuses a pattern
 * that would breach it rather than letting the exporter warn about it later.
 */
export const RELIEF_FLOOR_MM = 1;

export interface PlankResult {
  node: SceneNode;
  mesh: HeightmapMeshResult;
  cols: number;
  rows: number;
  /**
   * How far the board's depth misses the stock's, in mm.
   *
   * `buildHeightmapMesh` uses square cells, so the Y extent is a whole number
   * of cells and generally cannot land exactly on the stock's depth. The grid
   * is chosen to make this as small as it can be -- under half a cell -- but
   * it is not always zero, and the dialog shows the size that will actually be
   * cut rather than the one that was asked for.
   */
  depthErrorMm: number;
}

/**
 * Turn a pattern into the carved panel.
 *
 * Its footprint is the stock's, so there is one object in the scene and nothing
 * to confuse with the material; its height is the pattern depth plus
 * `PANEL_BASE_MM`, which is the carve depth the exporter is then told about.
 * With the plan scale left at 1:1 the pattern's peaks land on the stock's top
 * face, so they are untouched original surface and only the valleys are cut.
 */
export function buildPatternPlank(
  spec: PatternSpec,
  opts: PatternOptions,
  stock: StockSize,
  patternDepthMm: number,
  gridCols: number
): PlankResult {
  if (!(stock.widthMm > 0) || !(stock.depthMm > 0) || !(stock.thicknessMm > 0)) {
    throw new Error('Stock must have a width, a depth and a thickness.');
  }
  const panelMm = patternDepthMm + PANEL_BASE_MM;
  if (patternDepthMm <= 0) throw new Error('The pattern needs a depth to be cut to.');
  if (panelMm + RELIEF_FLOOR_MM > stock.thicknessMm) {
    const deepest = stock.thicknessMm - PANEL_BASE_MM - RELIEF_FLOOR_MM;
    throw new Error(
      `A ${patternDepthMm} mm pattern does not fit in ${stock.thicknessMm} mm stock — ` +
        `the deepest it can go is ${Math.max(0, deepest).toFixed(1)} mm, which leaves ` +
        `${PANEL_BASE_MM} mm of panel under the pattern and ${RELIEF_FLOOR_MM} mm of stock under that.`
    );
  }

  const widthM = stock.widthMm / 1000;
  const depthM = stock.depthMm / 1000;

  // Cells are square -- `buildHeightmapMesh` takes its Y extent from the X cell
  // size -- so the row count is "how many whole cells fit down the board", not
  // "cols divided by the aspect ratio". Getting that wrong is a sub-millimetre
  // error on the finished board, which is exactly the kind that is never
  // noticed until a part does not fit.
  const rowsFor = (c: number): number => Math.max(2, Math.round(depthM / (widthM / (c - 1))) + 1);

  let cols = Math.max(2, Math.round(gridCols));
  let rows = rowsFor(cols);
  // Shrink both axes together if the grid is too big, so the pattern keeps its
  // proportions rather than being squashed on one. Rows follow from cols, so
  // this settles rather than solving in one step; two passes is plenty, and
  // the floor guarantees it terminates.
  while (cols * rows > MAX_PATTERN_CELLS && cols > 2) {
    cols = Math.max(2, Math.floor(cols * Math.sqrt(MAX_PATTERN_CELLS / (cols * rows))));
    rows = rowsFor(cols);
  }

  const cellM = widthM / (cols - 1);
  const depthErrorMm = (cellM * (rows - 1) - depthM) * 1000;

  // The pattern is evaluated over the board the mesh will actually be, not the
  // one that was asked for, so a feature near the far edge is not cut short.
  const grid = spec.build(cols, rows, { widthM, depthM: cellM * (rows - 1) }, opts);
  if (grid.length !== cols * rows) {
    throw new Error(`Pattern "${spec.id}" returned ${grid.length} cells, expected ${cols * rows}.`);
  }

  const mesh = buildHeightmapMesh(grid, cols, rows, {
    widthM,
    maxHeightM: patternDepthMm / 1000,
    baseThicknessM: PANEL_BASE_MM / 1000,
    mapping: 'white-high',
    gridCols: cols,
    // The pattern decides its own smoothness; blurring it here would quietly
    // undo the sharpness controls the dialog offers.
    smoothPasses: 0,
    profile: 'grayscale',
  });

  /*
   * Paint the top surface, the same way the colour sidebar does.
   *
   * `buildHeightmapMesh` lays the top surface out first, one vertex per grid
   * cell at `r * cols + c`, so the height grid and the vertex indices are the
   * same thing and no lookup is needed. The skirt and the underside are left
   * unpainted and fall back to the body's own colour -- they are the sawn edge
   * of the board, not part of the pattern.
   *
   * Cost: one index and four bytes per top vertex, which roughly doubles what
   * the geom carries. Worth it for the patterns where the colour IS the
   * pattern; the ones where it would only be a guess at what the timber looks
   * like declare no palette and pay nothing.
   */
  let paint: PaintLayer | undefined;
  if (spec.palette) {
    const idx: number[] = [];
    const rgba: number[] = [];
    for (let i = 0; i < cols * rows; i++) {
      const [r, g, b] = spec.palette(mesh.heights[i], opts);
      idx.push(i);
      rgba.push(
        Math.round(clamp01(r) * 255),
        Math.round(clamp01(g) * 255),
        Math.round(clamp01(b) * 255),
        255
      );
    }
    // `res: []` is what a mesh geom's paint carries: it is painted at its own
    // vertex density rather than at a tessellation the app chose.
    paint = { res: [], idx, rgba };
  }

  const id = `pattern_${spec.id}`;
  const node: SceneNode = {
    id,
    name: spec.label,
    pos: [0, 0, mesh.sizeM[2] / 2],
    geoms: [
      {
        name: `${id}_geom`,
        type: 'mesh',
        // A workpiece clamped to a bed, not a body that falls: static, so it is
        // drawn exactly where its vertices put it and the exporter samples it
        // where it sits.
        rgba: [...(spec.baseRgb ?? [0.76, 0.62, 0.42]), 1],
        vertices: mesh.vertices,
        renderVertices: mesh.renderVertices,
        faces: mesh.faces,
        paint,
      } as SceneGeom,
    ],
    joints: [],
    children: [],
  };

  return { node, mesh, cols, rows, depthErrorMm };
}
