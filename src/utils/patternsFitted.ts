// ---------------------------------------------------------------------------
// Patterns drawn from the board's own shape: its middle, its outline, its
// size. None of them tiles, so none of them can run off an edge -- they are
// the "made for this piece" end of the generators, where Blender would reach
// for a radial array, a fitted array or an inset.
// ---------------------------------------------------------------------------

import { clamp01, fract } from './patternNoise';
import {
  boardCentre,
  fillGrid,
  grooveProfile,
  insideBoard,
  num,
  smoothstep,
  str,
  type PatternField,
  type PatternSpec,
} from './patternKit';

const profileField = (label = 'Profile'): PatternField => ({
  kind: 'choice', key: 'profile', label, options: [
    { value: 'round', label: 'Round (ball-nose)' },
    { value: 'v', label: 'V' },
    { value: 'square', label: 'Square' },
  ],
});

// --- Rosette ---------------------------------------------------------------------

export const rosette: PatternSpec = {
  id: 'rosette',
  group: 'Ornament',
  label: 'Rosette & Sunburst',
  blurb: 'A radial array about the middle of the board: layered petals, a sunburst, a fan or a wheel, sized to the stock.',
  defaults: { form: 'petals', count: 12, layers: 2, hubPct: 18, origin: 'centre', twistDeg: 0 },
  fields: [
    { kind: 'choice', key: 'form', label: 'Form', options: [
      { value: 'petals', label: 'Petals (carved rosette)' },
      { value: 'sunburst', label: 'Sunburst rays' },
      { value: 'spokes', label: 'Wheel and spokes' },
      { value: 'scallops', label: 'Scalloped shell' },
    ] },
    { kind: 'number', key: 'count', label: 'Count', min: 3, max: 96, step: 1,
      hint: 'Petals, rays or spokes around the full circle.' },
    { kind: 'number', key: 'layers', label: 'Layers', min: 1, max: 4, step: 1,
      hint: 'Petals only: rings of petals inside one another, each turned half a petal.' },
    { kind: 'number', key: 'hubPct', label: 'Hub', min: 0, max: 60, step: 1, unit: '%',
      hint: 'The boss in the middle, as a share of the radius.' },
    { kind: 'choice', key: 'origin', label: 'Centre', options: [
      { value: 'centre', label: 'Middle of the board' },
      { value: 'bottom', label: 'Bottom edge (Art Deco fan)' },
    ] },
    { kind: 'number', key: 'twistDeg', label: 'Twist', min: -90, max: 90, step: 5, unit: 'deg',
      hint: 'Rays and petals curve as they leave the middle, like a turbine. Zero is straight.' },
  ],
  build(cols, rows, extent, opts) {
    const form = str(opts, 'form', 'petals');
    const n = Math.max(3, Math.round(num(opts, 'count', 12)));
    const layers = Math.max(1, Math.min(4, Math.round(num(opts, 'layers', 2))));
    const hub = clamp01(num(opts, 'hubPct', 18) / 100);
    const fan = str(opts, 'origin', 'centre') === 'bottom';
    const twist = (num(opts, 'twistDeg', 0) * Math.PI) / 180;
    const { cx, half } = boardCentre(extent);
    const cy = fan ? extent.depthM : extent.depthM / 2;
    // A fan reaches the top corners; a rosette fills the inscribed circle.
    const R = fan ? Math.min(extent.depthM, extent.widthM / 2) : half;

    return fillGrid(cols, rows, extent, (x, y) => {
      const dx = x - cx;
      const dy = y - cy;
      const rho = Math.hypot(dx, dy) / Math.max(1e-9, R);
      const theta = Math.atan2(dy, dx) + twist * rho;
      // Where the point is round its sector: -0.5..0.5, 0 on the sector's axis.
      const sector = (offset: number) => fract((theta / (2 * Math.PI)) * n + offset) - 0.5;
      const hubH = hub > 0 && rho < hub ? 0.75 + 0.25 * Math.sqrt(Math.max(0, 1 - (rho / hub) ** 2)) : 0;

      if (form === 'sunburst') {
        // V flutes that widen as they go, across the whole board.
        const ray = 1 - 2 * Math.abs(sector(0));
        const h = 0.25 + 0.75 * ray * smoothstep(0, Math.max(0.02, hub), rho);
        return Math.max(h, hubH);
      }
      if (form === 'spokes') {
        if (rho > 1) return 1;
        const rimW = 0.08;
        if (rho > 1 - rimW) return 0.85 + 0.15 * Math.sin(((1 - rho) / rimW) * Math.PI);
        const spokeHalf = 0.12 + 0.12 * (1 - rho);
        const a = Math.abs(sector(0));
        const spoke = a < spokeHalf / 2 ? 0.7 + 0.25 * Math.cos((a / (spokeHalf / 2)) * (Math.PI / 2)) : 0;
        return Math.max(0.05, spoke, hubH);
      }
      if (form === 'scallops') {
        // One fluted shell: each lobe a round-bottomed groove, the rim
        // scalloped where the lobes end.
        const a = sector(0);
        const edge = 1 - 0.06 * Math.cos(a * Math.PI * 2);
        if (rho > edge) return 1;
        const flute = Math.cos(a * Math.PI);
        return Math.max(hubH, 0.25 + 0.65 * flute * Math.sqrt(clamp01(rho / Math.max(0.05, hub || 0.05))));
      }
      // Petals: outermost ring longest and lowest, each ring inside it turned
      // half a petal and standing above it.
      if (rho > 1) return 1;
      let h = 0.12;
      const inner = Math.max(hub * 0.8, 0.02);
      for (let L = 0; L < layers; L++) {
        const outer = 1 - (L * (1 - inner)) / (layers + 0.5);
        if (rho < inner || rho > outer) continue;
        const t = (rho - inner) / (outer - inner);
        // Almond-shaped: widest two-thirds of the way out, pointed at the tip.
        const width = 0.5 * Math.sin(Math.PI * Math.pow(t, 0.8)) * 0.98;
        const a = Math.abs(sector(L % 2 === 0 ? 0 : 0.5));
        if (a >= width) continue;
        const across = a / Math.max(1e-6, width);
        const lift = 0.45 + (0.5 * (L + 1)) / layers;
        // A dished petal: proud at the edges, a shallow vein down the middle.
        const body = Math.sqrt(Math.max(0, 1 - across * across)) * (0.85 + 0.15 * across);
        h = Math.max(h, lift * (0.35 + 0.65 * body) * (1 - 0.25 * t));
      }
      return Math.max(h, hubH);
    });
  },
};

// --- Raised panel ------------------------------------------------------------------

export const raisedPanel: PatternSpec = {
  id: 'raised_panel',
  group: 'Fitted to the board',
  label: 'Raised Panel & Stepped Frames',
  blurb: 'Frames stepping in from the edge of the board: a cabinet door\'s raised panel, an Art Deco step, or a sunk tray.',
  defaults: { steps: 4, stepMm: 10, profile: 'ogee', direction: 'up', cornerMm: 0, plateau: 'flat' },
  fields: [
    { kind: 'number', key: 'steps', label: 'Steps', min: 1, max: 30, step: 1 },
    { kind: 'number', key: 'stepMm', label: 'Step width', min: 1, max: 200, step: 0.5, unit: 'mm',
      hint: 'How far each step moves in. The steps stop where they meet in the middle.' },
    { kind: 'choice', key: 'profile', label: 'Step profile', options: [
      { value: 'square', label: 'Square steps' },
      { value: 'bevel', label: 'Bevel (one slope)' },
      { value: 'cove', label: 'Cove' },
      { value: 'round', label: 'Roundover' },
      { value: 'ogee', label: 'Ogee' },
    ] },
    { kind: 'choice', key: 'direction', label: 'Middle', options: [
      { value: 'up', label: 'Highest (raised panel)' },
      { value: 'down', label: 'Lowest (stepped tray)' },
    ] },
    { kind: 'number', key: 'cornerMm', label: 'Corner radius', min: 0, max: 300, step: 1, unit: 'mm',
      hint: 'Rounds the outline every step follows. Large values turn the panel into a stadium or an oval.' },
    { kind: 'choice', key: 'plateau', label: 'Middle field', options: [
      { value: 'flat', label: 'Flat' },
      { value: 'cushion', label: 'Cushioned' },
    ] },
  ],
  build(cols, rows, extent, opts) {
    const S = Math.max(1, Math.round(num(opts, 'steps', 4)));
    const w = Math.max(0.5, num(opts, 'stepMm', 10)) / 1000;
    const profile = str(opts, 'profile', 'ogee');
    const up = str(opts, 'direction', 'up') !== 'down';
    const corner = Math.max(0, num(opts, 'cornerMm', 0)) / 1000;
    const cushion = str(opts, 'plateau', 'flat') === 'cushion';
    const { half } = boardCentre(extent);

    const rise = (f: number): number => {
      switch (profile) {
        case 'square': return f < 0.5 ? 0 : 1;
        case 'bevel': return f;
        case 'cove': return 1 - Math.sqrt(Math.max(0, 1 - f * f));
        case 'round': return Math.sqrt(Math.max(0, 1 - (1 - f) * (1 - f)));
        default: return smoothstep(0, 1, f);
      }
    };

    return fillGrid(cols, rows, extent, (x, y) => {
      const d = Math.max(0, insideBoard(x, y, extent, corner));
      const t = d / w;
      let level: number;
      if (t >= S) {
        level = S;
        if (cushion) level += 0.6 * clamp01((d - S * w) / Math.max(1e-9, half - S * w));
      } else {
        const k = Math.floor(t);
        level = k + rise(t - k);
      }
      const top = S + (cushion ? 0.6 : 0);
      const h = level / top;
      return up ? h : 1 - h;
    });
  },
};

// --- Tiles -------------------------------------------------------------------------

type Motif = 'dome' | 'pyramid' | 'coffer' | 'dimple' | 'diamond' | 'checker' | 'flutes' | 'rays' | 'quatrefoil';

export const tiles: PatternSpec = {
  id: 'tiles',
  group: 'Fitted to the board',
  label: 'Tiles',
  blurb: 'The board divided into a whole number of cells with sunk joints, each carrying a motif: coffers, domes, dimples, knurls, alternating flutes.',
  defaults: { cellMm: 40, gutterMm: 3, motif: 'coffer', chamferMm: 2, rise: 0.65, flutes: 3 },
  fields: [
    { kind: 'number', key: 'cellMm', label: 'Cell size', min: 4, max: 500, step: 1, unit: 'mm',
      hint: 'Rounded so a whole number of cells fills the board each way. They are as near square as that allows.' },
    { kind: 'number', key: 'gutterMm', label: 'Joint', min: 0, max: 40, step: 0.5, unit: 'mm',
      hint: 'The sunk line between cells. Zero butts them together.' },
    { kind: 'choice', key: 'motif', label: 'Motif', options: [
      { value: 'coffer', label: 'Coffer (sunk pyramid)' },
      { value: 'pyramid', label: 'Pyramid' },
      { value: 'dome', label: 'Dome' },
      { value: 'dimple', label: 'Dimple' },
      { value: 'diamond', label: 'Diamond (knurl)' },
      { value: 'checker', label: 'Checkerboard' },
      { value: 'flutes', label: 'Flutes, turned cell to cell' },
      { value: 'rays', label: 'Sunburst in each cell' },
      { value: 'quatrefoil', label: 'Quatrefoil' },
    ] },
    { kind: 'number', key: 'chamferMm', label: 'Joint chamfer', min: 0, max: 30, step: 0.5, unit: 'mm',
      hint: 'Eases each cell into its joint.' },
    { kind: 'number', key: 'rise', label: 'Motif relief', min: 0.1, max: 1, step: 0.05,
      hint: 'How much of the depth the motif takes; the rest is the joint.' },
    { kind: 'number', key: 'flutes', label: 'Flutes per cell', min: 1, max: 12, step: 1 },
  ],
  build(cols, rows, extent, opts) {
    const want = Math.max(1, num(opts, 'cellMm', 40)) / 1000;
    const nx = Math.max(1, Math.round(extent.widthM / want));
    const ny = Math.max(1, Math.round(extent.depthM / want));
    const cw = extent.widthM / nx;
    const ch = extent.depthM / ny;
    const gutter = Math.max(0, num(opts, 'gutterMm', 3)) / 1000;
    const chamfer = Math.max(0, num(opts, 'chamferMm', 2)) / 1000;
    const motif = str(opts, 'motif', 'coffer') as Motif;
    const rise = Math.min(1, Math.max(0.05, num(opts, 'rise', 0.65)));
    const flutes = Math.max(1, Math.round(num(opts, 'flutes', 3)));
    const base = 1 - rise;
    const gh = gutter / 2;

    return fillGrid(cols, rows, extent, (x, y) => {
      const i = Math.min(nx - 1, Math.floor(x / cw));
      const j = Math.min(ny - 1, Math.floor(y / ch));
      const lx = x - i * cw;
      const ly = y - j * ch;
      const edge = Math.min(lx, cw - lx, ly, ch - ly);
      if (gutter > 0 && edge < gh) return 0;
      // -1..1 across the cell, inside its joint.
      const u = ((lx - gh) / Math.max(1e-9, cw - gutter)) * 2 - 1;
      const v = ((ly - gh) / Math.max(1e-9, ch - gutter)) * 2 - 1;
      const odd = (i + j) % 2 === 1;
      let m: number;
      switch (motif) {
        case 'pyramid': m = 1 - Math.max(Math.abs(u), Math.abs(v)); break;
        case 'coffer': m = 0.15 + 0.85 * Math.pow(Math.max(Math.abs(u), Math.abs(v)), 1.5); break;
        case 'dome': m = Math.sqrt(Math.max(0, 1 - (u * u + v * v) / 2)); break;
        case 'dimple': m = 1 - 0.85 * Math.sqrt(Math.max(0, 1 - (u * u + v * v) / 0.7)); break;
        case 'diamond': m = 1 - Math.min(1, Math.abs(u) + Math.abs(v)) * 0.9; break;
        case 'checker': m = odd ? 0.45 : 1; break;
        case 'flutes': {
          const a = odd ? u : v;
          m = 0.25 + 0.75 * (1 - grooveProfile(Math.abs(fract(((a + 1) / 2) * flutes) - 0.5) * 2, 1, 'round'));
          m = 1 - m + 0.25;
          break;
        }
        case 'rays': {
          const th = Math.atan2(v, u);
          m = 0.3 + 0.7 * (1 - 2 * Math.abs(fract((th / (2 * Math.PI)) * 16) - 0.5)) * clamp01(Math.hypot(u, v) * 3);
          break;
        }
        default: {
          // Four overlapping lobes: the Gothic quatrefoil.
          const r = 0.42;
          let d = Infinity;
          for (const [px, py] of [[0.38, 0], [-0.38, 0], [0, 0.38], [0, -0.38]]) d = Math.min(d, Math.hypot(u - px, v - py) - r);
          m = d < 0 ? 0.35 + 0.65 * Math.sqrt(clamp01(-d / r)) : 1;
          m = d < 0 ? 1 - m + 0.35 : 1;
          break;
        }
      }
      const ease = chamfer > 0 ? clamp01((edge - gh) / chamfer) : 1;
      return clamp01(base + rise * clamp01(m)) * (gutter > 0 || chamfer > 0 ? 0.3 + 0.7 * ease : 1);
    });
  },
};

// --- Contour rings ------------------------------------------------------------------

export const contourRings: PatternSpec = {
  id: 'contour_rings',
  group: 'Fitted to the board',
  label: 'Contour Rings',
  blurb: 'Grooves following the outline of the board inward, like ripples in a square pond: nested rounded rectangles, circles or diamonds.',
  defaults: { pitchMm: 8, profile: 'round', land: 0.25, shape: 'board', cornerMm: 10, fit: 'fit', ripple: 0 },
  fields: [
    { kind: 'number', key: 'pitchMm', label: 'Pitch', min: 1, max: 100, step: 0.5, unit: 'mm' },
    profileField('Groove'),
    { kind: 'number', key: 'land', label: 'Land', min: 0, max: 0.9, step: 0.05,
      hint: 'Flat left between grooves, as a share of the pitch.' },
    { kind: 'choice', key: 'shape', label: 'Shape', options: [
      { value: 'board', label: 'The board\'s outline' },
      { value: 'circle', label: 'Circles' },
      { value: 'diamond', label: 'Diamonds' },
      { value: 'squircle', label: 'Squircles' },
    ] },
    { kind: 'number', key: 'cornerMm', label: 'Corner radius', min: 0, max: 300, step: 1, unit: 'mm',
      hint: 'For the board\'s outline: rounds the outer ring; the inner ones round more as they shrink.' },
    { kind: 'choice', key: 'fit', label: 'Rings', options: [
      { value: 'fit', label: 'Whole rings to the middle' },
      { value: 'free', label: 'Pitch as set' },
    ] },
    { kind: 'number', key: 'ripple', label: 'Ripple decay', min: 0, max: 1, step: 0.05,
      hint: 'Shallower rings towards the outside, like a ripple dying away. Zero keeps every ring the same depth.' },
  ],
  build(cols, rows, extent, opts) {
    let p = Math.max(0.5, num(opts, 'pitchMm', 8)) / 1000;
    const profile = str(opts, 'profile', 'round');
    const land = clamp01(num(opts, 'land', 0.25));
    const shape = str(opts, 'shape', 'board');
    const corner = Math.max(0, num(opts, 'cornerMm', 10)) / 1000;
    const ripple = clamp01(num(opts, 'ripple', 0));
    const { cx, cy, half } = boardCentre(extent);
    // Distance from the centre outwards, so the middle is a point (or a spine).
    const span = shape === 'board' ? half : Math.hypot(extent.widthM, extent.depthM) / 2;
    if (str(opts, 'fit', 'fit') === 'fit') p = half / Math.max(1, Math.round(half / p));

    return fillGrid(cols, rows, extent, (x, y) => {
      const dx = x - cx;
      const dy = y - cy;
      let r: number;
      switch (shape) {
        case 'circle': r = Math.hypot(dx, dy); break;
        case 'diamond': r = (Math.abs(dx) + Math.abs(dy)) * Math.SQRT1_2; break;
        case 'squircle': r = Math.pow(Math.pow(Math.abs(dx), 4) + Math.pow(Math.abs(dy), 4), 0.25); break;
        default: r = half - Math.max(0, insideBoard(x, y, extent, corner));
      }
      // Grooves centred half a pitch in from the edge of each ring, so the
      // outermost one is whole and the middle is a land.
      const phase = fract(r / p) - 0.5;
      const g = grooveProfile(Math.abs(phase) * 2, Math.max(0.01, 1 - land), profile);
      const depthScale = ripple > 0 ? 1 - ripple * clamp01(r / span) : 1;
      return 1 - (1 - g) * depthScale;
    });
  },
};

// --- Spiral --------------------------------------------------------------------------

export const spiral: PatternSpec = {
  id: 'spiral',
  group: 'Fitted to the board',
  label: 'Spiral',
  blurb: 'One continuous groove wound out from the middle -- a record, a raked gravel garden, a square labyrinth.',
  defaults: { pitchMm: 8, arms: 1, shape: 'circle', profile: 'round', land: 0.3 },
  fields: [
    { kind: 'number', key: 'pitchMm', label: 'Pitch', min: 1, max: 100, step: 0.5, unit: 'mm',
      hint: 'Distance between neighbouring turns.' },
    { kind: 'number', key: 'arms', label: 'Arms', min: 1, max: 8, step: 1,
      hint: 'Separate grooves wound together, like the starts of a thread.' },
    { kind: 'choice', key: 'shape', label: 'Shape', options: [
      { value: 'circle', label: 'Round' },
      { value: 'square', label: 'Square' },
    ] },
    profileField('Groove'),
    { kind: 'number', key: 'land', label: 'Land', min: 0, max: 0.9, step: 0.05 },
  ],
  build(cols, rows, extent, opts) {
    const p = Math.max(0.5, num(opts, 'pitchMm', 8)) / 1000;
    const arms = Math.max(1, Math.round(num(opts, 'arms', 1)));
    const square = str(opts, 'shape', 'circle') === 'square';
    const profile = str(opts, 'profile', 'round');
    const land = clamp01(num(opts, 'land', 0.3));
    const { cx, cy } = boardCentre(extent);
    return fillGrid(cols, rows, extent, (x, y) => {
      const dx = x - cx;
      const dy = y - cy;
      let r: number;
      let s: number;
      if (square) {
        r = Math.max(Math.abs(dx), Math.abs(dy));
        // How far round the square, 0..1, measured along its perimeter so
        // the turns stay evenly spaced on the straights.
        const a = r > 0 ? (Math.abs(dx) >= Math.abs(dy) ? dy / r : dx / r) : 0;
        const side = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 0 : 2) : (dy > 0 ? 1 : 3);
        const along = side === 0 ? a : side === 1 ? -a : side === 2 ? -a : a;
        s = fract((side + (along + 1) / 2) / 4);
      } else {
        r = Math.hypot(dx, dy);
        s = (Math.atan2(dy, dx) / (2 * Math.PI) + 1) % 1;
      }
      const turns = (r / p) * arms - s;
      const phase = fract(turns) - 0.5;
      return grooveProfile(Math.abs(phase) * 2, Math.max(0.01, 1 - land), profile);
    });
  },
};

export const FITTED_PATTERNS: PatternSpec[] = [rosette, raisedPanel, tiles, contourRings, spiral];
