// ---------------------------------------------------------------------------
// The surface patterns' shared vocabulary: the spec every pattern is, the
// controls it describes, and the few helpers every generator leans on.
//
// Split out of surfacePatterns.ts so the generators can live in more than one
// module without importing the registry they are listed in -- a cycle the
// worker bundle has broken on before.
// ---------------------------------------------------------------------------

import { clamp01 } from './patternNoise';

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
      /** A heading drawn above this control: where a group of them starts. */
      section?: string;
    }
  | {
      kind: 'choice';
      key: string;
      label: string;
      options: Array<{ value: string; label: string }>;
      hint?: string;
      section?: string;
    }
  | { kind: 'seed'; key: string; label: string; hint?: string; section?: string };

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
  /**
   * Where the board's corner sits in pattern space, in metres. `fillGrid`
   * adds it to every point, which is how the layout centres a pattern or puts
   * its board edge between two features rather than through one. Only a
   * pattern that declares `tile` is ever handed one.
   */
  x0?: number;
  y0?: number;
}

/**
 * A repeat the layout may stretch so a whole number of them spans the board.
 *
 * `key` is the option holding it, in mm; the period along `axis` is that
 * times `factor`. `edge` is where in a period the board's edge should fall
 * once fitted: 0 on the feature the pattern draws at its origin (a lattice
 * line), 0.5 halfway between two (so a flute or a stud is whole at the edge).
 */
export interface PatternRepeat {
  key: string;
  axis: 'x' | 'y';
  factor?: number;
  edge?: number;
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
  /**
   * The pattern is two levels with walls between them, rather than a graded
   * surface.
   *
   * Roughing with a flat mill leaves such a pattern already finished: the tops
   * and floors are flat because the cutter is, and only the walls carry the
   * roughing layers' steps. The ball-nose finish then spends most of a day
   * smoothing walls a few millimetres tall, so the dialog offers to stop after
   * roughing, and opens that way for these.
   */
  flatTopped?: boolean;
  /**
   * Heights under one half are not the floor of a carve but no material at
   * all: the pattern is cut right through the stock.
   *
   * The panel is then the stock's full thickness, the depth is not the
   * user's to set, and the relief export is told to go through into the
   * spoilboard. Whatever the pattern leaves must still hold together -- a
   * slot that reaches the edge of the board sets a strip loose.
   */
  throughCut?: boolean;
  /**
   * The pattern is a regular repeat drawn with `fillGrid` about its origin,
   * so the layout can centre it and fit its pitch to the board. Left out for
   * anything scattered at random over the board, which has no middle to find.
   */
  tile?: {
    repeats: PatternRepeat[];
    /** The option that turns the pattern; fitting only holds square to the board. */
    angleKey?: string;
  };
  /** Which group the menus list it under. */
  group?: PatternGroup;
}

export type PatternGroup = 'Ornament' | 'Fitted to the board' | 'Wood & joinery' | 'Geometric' | 'Textile' | 'Water & terrain' | 'Nature';

/** The order the menus list the groups in. */
export const PATTERN_GROUPS: PatternGroup[] = [
  'Ornament', 'Fitted to the board', 'Wood & joinery', 'Geometric', 'Textile', 'Water & terrain', 'Nature',
];

/** What the dialog opens at when a pattern does not ask for something else. */
export const DEFAULT_DEPTH_FRACTION = 1 / 3;

/** The shallowest a carve is worth setting up for, in mm. */
export const MIN_SENSIBLE_DEPTH_MM = 1.2;

/** Mix two colours. */
export const mix = (
  a: [number, number, number], b: [number, number, number], t: number
): [number, number, number] => {
  const k = clamp01(t);
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
};

/** A hard edge between two colours, softened just enough not to look aliased. */
export const band = (
  low: [number, number, number], high: [number, number, number], h: number, edge = 0.5, soft = 0.12
): [number, number, number] => mix(low, high, (h - (edge - soft)) / (2 * soft));

export const num = (opts: PatternOptions, key: string, fallback: number): number => {
  const v = opts[key];
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
};

export const str = (opts: PatternOptions, key: string, fallback: string): string => {
  const v = opts[key];
  return typeof v === 'string' ? v : fallback;
};

export const seedField = (key = 'seed'): PatternField => ({
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
export function fillGrid(
  cols: number,
  rows: number,
  extent: PatternExtent,
  fn: (x: number, y: number) => number
): Float32Array {
  const out = new Float32Array(cols * rows);
  const x0 = extent.x0 ?? 0;
  const y0 = extent.y0 ?? 0;
  for (let r = 0; r < rows; r++) {
    const y = y0 + (rows > 1 ? r / (rows - 1) : 0) * extent.depthM;
    for (let c = 0; c < cols; c++) {
      const x = x0 + (cols > 1 ? c / (cols - 1) : 0) * extent.widthM;
      out[r * cols + c] = fn(x, y);
    }
  }
  return out;
}
/** Turn board coordinates into a frame rotated by `angle`: u across, v along. */
export const rotate = (x: number, y: number, angle: number): [number, number] => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [x * c + y * s, -x * s + y * c];
};

/** Positive modulo: `fract` for a period other than 1. */
export const wrap = (a: number, n: number): number => a - Math.floor(a / n) * n;

/** Smoothstep between two edges. */
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / Math.max(1e-9, e1 - e0));
  return t * t * (3 - 2 * t);
};

/**
 * A groove's cross-section, 0 on its centre line rising to 1 at its edge.
 * `d` is the distance from the centre line, `half` the groove's half-width.
 */
export function grooveProfile(d: number, half: number, profile: string): number {
  const t = Math.min(1, Math.abs(d) / Math.max(1e-9, half));
  if (profile === 'v') return t;
  if (profile === 'square') return t < 1 ? 0 : 1;
  // Round: the section a ball-nose cutter leaves.
  return 1 - Math.sqrt(Math.max(0, 1 - t * t));
}

/** Pick out the board's middle, its shorter half-span, and a point's offset from it. */
export function boardCentre(extent: PatternExtent): { cx: number; cy: number; half: number } {
  return { cx: extent.widthM / 2, cy: extent.depthM / 2, half: Math.min(extent.widthM, extent.depthM) / 2 };
}

/**
 * Signed distance inside a rounded rectangle the size of the board, inset by
 * nothing: 0 on the board's edge, growing towards its middle. `radius` rounds
 * the corners, so offsets of it come out as nested rounded rectangles.
 */
export function insideBoard(x: number, y: number, extent: PatternExtent, radius: number): number {
  const hx = extent.widthM / 2;
  const hy = extent.depthM / 2;
  const r = Math.max(0, Math.min(radius, hx, hy));
  const qx = Math.abs(x - hx) - (hx - r);
  const qy = Math.abs(y - hy) - (hy - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  return -outside;
}
