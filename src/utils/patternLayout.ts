// ---------------------------------------------------------------------------
// Laying a pattern out on the board it is cut into.
//
// Every generator draws a field that knows nothing about the board's edges: a
// 12 mm flute tiled from the corner of a 200 mm board ends on two-thirds of a
// flute at one side and a whole one at the other. That is what makes a
// pattern look like a sample of wallpaper rather than something made for this
// piece. Blender's modifiers look deliberate for the opposite reason -- an
// array fitted to a length, a mirror about the middle, a bevel on every edge.
//
// So each pattern is wrapped here with the same handful of controls:
//
// - Fit:      the repeat is stretched so a whole number of them spans the board,
//             and the edges fall between features (Array's "Fit Length").
// - Centre:   the pattern is symmetric about the board's middle at its own pitch.
// - Frame:    a plain border so the pattern stops on purpose, plain, grooved,
//             raised above the pattern or sunk below it.
// - Symmetry: mirror, quarter or kaleidoscope about the middle (Mirror).
// - Fade:     the depth tapers to nothing towards the frame.
// - Soften:   sharp edges rounded over by a radius (Bevel / Smooth).
//
// It all happens on the height grid, so it works for every pattern -- the
// simulated ones included -- with nothing written in any of them. Only Fit and
// Centre need a pattern's co-operation, which it gives by declaring `tile`.
// ---------------------------------------------------------------------------

import { clamp01 } from './patternNoise';
import {
  num,
  smoothstep,
  str,
  type PatternExtent,
  type PatternField,
  type PatternOptions,
  type PatternSpec,
} from './patternKit';

export type LayoutAlign = 'fit' | 'centre' | 'free';
export type FrameStyle = 'plain' | 'groove' | 'raised' | 'sunk';
export type Symmetry = 'none' | 'mirror_x' | 'mirror_y' | 'quarter' | 'k3' | 'k4' | 'k6' | 'k8' | 'k12';

/** What a pattern opens with when nothing about its layout has been touched. */
export function layoutDefaults(spec: PatternSpec): PatternOptions {
  return {
    ...(spec.tile ? { layoutAlign: 'fit' } : {}),
    frameMm: 0,
    frameStyle: 'plain',
    frameGrooveMm: 3,
    symmetry: 'none',
    fadeMm: 0,
    softenMm: 0,
  };
}

export function layoutFields(spec: PatternSpec): PatternField[] {
  const section = 'Layout';
  const fields: PatternField[] = [];
  if (spec.tile) {
    fields.push({
      kind: 'choice', key: 'layoutAlign', label: 'Fit to board', section, options: [
        { value: 'fit', label: 'Whole repeats, edge to edge' },
        { value: 'centre', label: 'Centred, pitch as set' },
        { value: 'free', label: 'From the corner' },
      ],
      hint: 'Fitting stretches the pitch a little so the pattern ends the same way at both edges. Only holds when the pattern is square to the board.',
    });
  }
  fields.push(
    { kind: 'number', key: 'frameMm', label: 'Frame', min: 0, max: 200, step: 1, unit: 'mm',
      section: spec.tile ? undefined : section,
      hint: 'A border left round the pattern, so it stops on purpose rather than running off the edge.' },
  );
  if (!spec.throughCut) {
    fields.push({
      kind: 'choice', key: 'frameStyle', label: 'Frame style', options: [
        { value: 'plain', label: 'Plain' },
        { value: 'groove', label: 'Grooved' },
        { value: 'raised', label: 'Raised (pattern sunk in a panel)' },
        { value: 'sunk', label: 'Sunk (pattern stands proud)' },
      ],
    });
    fields.push({
      kind: 'number', key: 'frameGrooveMm', label: 'Frame groove', min: 0.5, max: 30, step: 0.5, unit: 'mm',
      hint: 'Width of the groove round a grooved frame. It is cut as a V, to the floor.',
    });
  }
  fields.push(
    {
      kind: 'choice', key: 'symmetry', label: 'Symmetry', options: [
        { value: 'none', label: 'None' },
        { value: 'mirror_x', label: 'Mirror left/right (book-matched)' },
        { value: 'mirror_y', label: 'Mirror top/bottom' },
        { value: 'quarter', label: 'Quartered' },
        { value: 'k3', label: 'Kaleidoscope, 3' },
        { value: 'k4', label: 'Kaleidoscope, 4' },
        { value: 'k6', label: 'Kaleidoscope, 6' },
        { value: 'k8', label: 'Kaleidoscope, 8' },
        { value: 'k12', label: 'Kaleidoscope, 12' },
      ],
      hint: 'Folds the pattern about the middle of the board. A kaleidoscope turns anything into a rosette.',
    },
    { kind: 'number', key: 'fadeMm', label: 'Fade out', min: 0, max: 300, step: 1, unit: 'mm',
      hint: 'The pattern grows shallower towards its edge over this distance, and dissolves into the plain board.' },
    { kind: 'number', key: 'softenMm', label: 'Soften', min: 0, max: 20, step: 0.25, unit: 'mm',
      hint: 'Rounds over every sharp edge by about this radius. Matching the finishing cutter shows what it will leave.' },
  );
  return fields;
}

/** The pattern with the layout controls on it. Every registry entry is one of these. */
export function withLayout(spec: PatternSpec): PatternSpec {
  return {
    ...spec,
    defaults: { ...layoutDefaults(spec), ...spec.defaults },
    fields: [...spec.fields, ...layoutFields(spec)],
    build: (cols, rows, extent, opts) => buildLaidOut(spec, cols, rows, extent, opts),
  };
}

// --- Fit and centre ------------------------------------------------------------

/**
 * The options and extent that put the pattern's repeats where the layout wants
 * them: fitted, centred, or (free) from the board's corner as it always was.
 */
export function alignRepeats(
  spec: PatternSpec,
  opts: PatternOptions,
  extent: PatternExtent,
  align: LayoutAlign
): { opts: PatternOptions; extent: PatternExtent } {
  if (!spec.tile || align === 'free') return { opts, extent };
  const W = extent.widthM;
  const D = extent.depthM;
  const angle = spec.tile.angleKey ? num(opts, spec.tile.angleKey, 0) : 0;
  const a = ((angle % 180) + 180) % 180;
  const square = Math.abs(a) < 1e-6 || Math.abs(a - 180) < 1e-6;
  const quarter = Math.abs(a - 90) < 1e-6;

  // Centred: the pattern's origin -- a feature, or a lattice point -- sits in
  // the middle of the board, so whatever it does it does symmetrically.
  let x0 = -W / 2;
  let y0 = -D / 2;
  const out: PatternOptions = { ...opts };

  if (align === 'fit' && (square || quarter)) {
    const fittedKeys = new Set<string>();
    const fittedAxes = new Set<string>();
    for (const r of spec.tile.repeats) {
      const axis = quarter ? (r.axis === 'x' ? 'y' : 'x') : r.axis;
      if (fittedKeys.has(r.key) || fittedAxes.has(axis)) continue;
      const factor = r.factor ?? 1;
      const p = (num(out, r.key, NaN) * factor) / 1000;
      const L = axis === 'x' ? W : D;
      if (!(p > 0) || !(L > 0)) continue;
      const n = Math.max(1, Math.round(L / p));
      const fitted = L / n;
      out[r.key] = (fitted / factor) * 1000;
      // With a whole number of periods across, an edge at phase `edge` puts
      // the other edge at the same phase: the board ends the same both sides.
      const origin = (r.edge ?? 0) * fitted;
      if (axis === 'x') x0 = origin; else y0 = origin;
      fittedKeys.add(r.key);
      fittedAxes.add(axis);
    }
  }
  return { opts: out, extent: { ...extent, x0, y0 } };
}

// --- The whole layout ----------------------------------------------------------

export function buildLaidOut(
  spec: PatternSpec,
  cols: number,
  rows: number,
  extent: PatternExtent,
  opts: PatternOptions
): Float32Array {
  const cell = cols > 1 ? extent.widthM / (cols - 1) : extent.widthM;
  const frameM = Math.max(0, num(opts, 'frameMm', 0)) / 1000;
  let m = frameM > 0 && cell > 0 ? Math.round(frameM / cell) : 0;
  // A frame that leaves no pattern is no frame.
  if (cols - 2 * m < 3 || rows - 2 * m < 3) m = 0;
  const ic = cols - 2 * m;
  const ir = rows - 2 * m;
  const inner: PatternExtent = {
    widthM: m > 0 ? (ic - 1) * cell : extent.widthM,
    depthM: m > 0 ? (ir - 1) * cell : extent.depthM,
  };

  const align = str(opts, 'layoutAlign', spec.tile ? 'fit' : 'free') as LayoutAlign;
  const placed = alignRepeats(spec, opts, inner, align);
  let g = spec.build(ic, ir, placed.extent, placed.opts);
  if (g.length !== ic * ir) return g;

  g = applySymmetry(g, ic, ir, str(opts, 'symmetry', 'none') as Symmetry);
  const softenCells = cell > 0 ? Math.max(0, num(opts, 'softenMm', 0)) / 1000 / cell : 0;
  if (softenCells >= 0.5) g = soften(g, ic, ir, softenCells);
  const fadeCells = cell > 0 ? Math.max(0, num(opts, 'fadeMm', 0)) / 1000 / cell : 0;
  if (fadeCells >= 1) fadeToEdge(g, ic, ir, fadeCells);

  // Every consumer assumes 0..1; floating-point dust below zero from any one
  // generator must not reach the mesh as a sliver under the floor.
  for (let i = 0; i < g.length; i++) g[i] = clamp01(g[i]);

  const style = spec.throughCut ? 'plain' : (str(opts, 'frameStyle', 'plain') as FrameStyle);
  if (m === 0) {
    // No frame to stand above: a raised frame still has no width, so only the
    // pattern's own heights remain.
    return g;
  }
  return frame(g, ic, ir, cols, rows, m, style, Math.max(0.5, num(opts, 'frameGrooveMm', 3)) / 1000 / cell);
}

/** Paste the pattern into a frame `m` cells wide. */
function frame(
  g: Float32Array, ic: number, ir: number, cols: number, rows: number, m: number,
  style: FrameStyle, grooveCells: number
): Float32Array {
  const out = new Float32Array(cols * rows);
  // Raised: the pattern sits in a panel below the frame, so its peaks are no
  // longer the stock's top and the frame reads as a moulding round it.
  const scale = style === 'raised' ? 0.7 : 1;
  const frameLevel = style === 'sunk' ? 0 : 1;
  const half = Math.min(grooveCells / 2, m / 2);
  const centre = m / 2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ri = r - m;
      const ci = c - m;
      if (ri >= 0 && ri < ir && ci >= 0 && ci < ic) {
        out[r * cols + c] = g[ri * ic + ci] * scale;
        continue;
      }
      let h = frameLevel;
      if (style === 'groove' && half > 0) {
        // Distance in, from the board's edge, of this point of the frame:
        // the groove runs round the middle of the frame's width.
        const inset = Math.min(c, r, cols - 1 - c, rows - 1 - r);
        const d = Math.abs(inset - centre);
        if (d < half) h = d / half;
      }
      out[r * cols + c] = h;
    }
  }
  return out;
}

// --- Symmetry ------------------------------------------------------------------

/** Reflect `t` back into 0..L, as many times as it takes. */
const fold = (t: number, L: number): number => {
  if (L <= 0) return 0;
  const p = 2 * L;
  const a = ((t % p) + p) % p;
  return a > L ? p - a : a;
};

/** The grid at a fractional cell, bilinear, reflecting at the edges. */
function sampleGrid(g: Float32Array, cols: number, rows: number, x: number, y: number): number {
  const fx = fold(x, cols - 1);
  const fy = fold(y, rows - 1);
  const x0 = Math.min(cols - 2, Math.floor(fx));
  const y0 = Math.min(rows - 2, Math.floor(fy));
  if (x0 < 0 || y0 < 0) return g[0];
  const tx = fx - x0;
  const ty = fy - y0;
  const i = y0 * cols + x0;
  const a = g[i] + (g[i + 1] - g[i]) * tx;
  const b = g[i + cols] + (g[i + cols + 1] - g[i + cols]) * tx;
  return a + (b - a) * ty;
}

export function applySymmetry(g: Float32Array, cols: number, rows: number, sym: Symmetry): Float32Array {
  if (sym === 'none' || cols < 2 || rows < 2) return g;
  const out = new Float32Array(cols * rows);
  const cx = (cols - 1) / 2;
  const cy = (rows - 1) / 2;
  const k = sym.startsWith('k') ? Math.max(2, Number(sym.slice(1)) || 4) : 0;
  const wedge = k > 0 ? Math.PI / k : 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let x = c;
      let y = r;
      if (sym === 'mirror_x' || sym === 'quarter') x = c > cx ? 2 * cx - c : c;
      if (sym === 'mirror_y' || sym === 'quarter') y = r > cy ? 2 * cy - r : r;
      if (k > 0) {
        // Fold the angle into the first wedge, mirroring every other one, so
        // neighbouring wedges meet in a reflection rather than a seam. The
        // wedge points up the board, so its source is the board's top-middle.
        const dx = c - cx;
        const dy = r - cy;
        const rad = Math.hypot(dx, dy);
        let th = Math.atan2(dy, dx) + Math.PI / 2;
        th = ((th % (2 * wedge)) + 2 * wedge) % (2 * wedge);
        if (th > wedge) th = 2 * wedge - th;
        th -= wedge / 2;
        x = cx + rad * Math.sin(th);
        y = cy - rad * Math.cos(th);
      }
      out[r * cols + c] = x === c && y === r ? g[r * cols + c] : sampleGrid(g, cols, rows, x, y);
    }
  }
  return out;
}

// --- Soften and fade -------------------------------------------------------------

/** A Gaussian blur about `radius` cells across: every edge rounded over by it. */
export function soften(g: Float32Array, cols: number, rows: number, radius: number): Float32Array {
  const sigma = Math.max(0.3, radius / 2);
  const half = Math.min(64, Math.ceil(sigma * 2.5));
  const w = new Float32Array(2 * half + 1);
  let sum = 0;
  for (let i = -half; i <= half; i++) {
    w[i + half] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += w[i + half];
  }
  for (let i = 0; i < w.length; i++) w[i] /= sum;
  const tmp = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let s = 0;
      for (let i = -half; i <= half; i++) {
        const cc = c + i < 0 ? -(c + i) : c + i >= cols ? 2 * (cols - 1) - (c + i) : c + i;
        s += g[r * cols + Math.max(0, Math.min(cols - 1, cc))] * w[i + half];
      }
      tmp[r * cols + c] = s;
    }
  }
  const out = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let s = 0;
      for (let i = -half; i <= half; i++) {
        const rr = r + i < 0 ? -(r + i) : r + i >= rows ? 2 * (rows - 1) - (r + i) : r + i;
        s += tmp[Math.max(0, Math.min(rows - 1, rr)) * cols + c] * w[i + half];
      }
      out[r * cols + c] = clamp01(s);
    }
  }
  return out;
}

/** Ease the pattern up to the board's top over `cells` from its edge, in place. */
export function fadeToEdge(g: Float32Array, cols: number, rows: number, cells: number): void {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const d = Math.min(c, r, cols - 1 - c, rows - 1 - r);
      if (d >= cells) continue;
      const k = smoothstep(0, cells, d);
      const i = r * cols + c;
      g[i] = 1 - (1 - g[i]) * k;
    }
  }
}
