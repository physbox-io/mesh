// ---------------------------------------------------------------------------
// Regular geometric patterns: honeycomb, Greek key, Truchet tiles and the
// star-and-cross lattices of Islamic strapwork. All are drawn about their
// origin with `fillGrid`, so the layout can fit and centre them.
// ---------------------------------------------------------------------------

import { clamp01, hash2D } from './patternNoise';
import {
  fillGrid,
  grooveProfile,
  num,
  rotate,
  seedField,
  str,
  wrap,
  type PatternField,
  type PatternSpec,
} from './patternKit';

const SQRT3 = Math.sqrt(3);

const lineProfileField: PatternField = {
  kind: 'choice', key: 'profile', label: 'Line', options: [
    { value: 'v', label: 'V groove' },
    { value: 'round', label: 'Round groove' },
    { value: 'square', label: 'Square groove' },
    { value: 'raised', label: 'Raised strap' },
  ],
};

/** Height for a point `d` from a line of half-width `half`: a groove, or a raised strap. */
function lineHeight(d: number, half: number, profile: string): number {
  if (profile === 'raised') {
    if (d >= half) return 0.35;
    const t = d / half;
    return 0.35 + 0.65 * Math.sqrt(Math.max(0, 1 - t * t * t * t));
  }
  return grooveProfile(d, half, profile);
}

/** Offset from a point to its hexagon's centre, centres one unit apart along x. */
function hexCell(x: number, y: number): { ox: number; oy: number; i: number; j: number } {
  const ax = wrap(x, 1) - 0.5;
  const ay = wrap(y, SQRT3) - SQRT3 / 2;
  const bx = wrap(x - 0.5, 1) - 0.5;
  const by = wrap(y - SQRT3 / 2, SQRT3) - SQRT3 / 2;
  if (ax * ax + ay * ay < bx * bx + by * by) {
    return { ox: ax, oy: ay, i: Math.round(x - ax) * 2, j: Math.round((y - ay) / SQRT3) * 2 };
  }
  return { ox: bx, oy: by, i: Math.round(x - bx) * 2 + 1, j: Math.round((y - by) / SQRT3) * 2 + 1 };
}

// --- Honeycomb ----------------------------------------------------------------------

export const honeycomb: PatternSpec = {
  id: 'honeycomb',
  group: 'Geometric',
  label: 'Honeycomb',
  blurb: 'Hexagonal cells behind thin walls: sunk flat-bottomed cells, cupped cells, domes or hex pyramids.',
  defaults: { cellMm: 20, wallMm: 2, form: 'cupped', angleDeg: 0 },
  tile: { repeats: [{ key: 'cellMm', axis: 'x', edge: 0.5 }], angleKey: 'angleDeg' },
  fields: [
    { kind: 'number', key: 'cellMm', label: 'Cell', min: 2, max: 300, step: 0.5, unit: 'mm',
      hint: 'Centre to centre, across the flats.' },
    { kind: 'number', key: 'wallMm', label: 'Wall', min: 0, max: 30, step: 0.25, unit: 'mm' },
    { kind: 'choice', key: 'form', label: 'Cells', options: [
      { value: 'flat', label: 'Sunk, flat bottomed' },
      { value: 'cupped', label: 'Cupped' },
      { value: 'domed', label: 'Domed' },
      { value: 'pyramid', label: 'Hex pyramids' },
    ] },
    { kind: 'number', key: 'angleDeg', label: 'Rotation', min: -90, max: 90, step: 5, unit: 'deg' },
  ],
  build(cols, rows, extent, opts) {
    const s = Math.max(0.5, num(opts, 'cellMm', 20)) / 1000;
    const wall = Math.max(0, num(opts, 'wallMm', 2)) / 1000;
    const form = str(opts, 'form', 'cupped');
    const angle = (num(opts, 'angleDeg', 0) * Math.PI) / 180;
    const inr = 0.5;
    const wallU = wall / s / 2;
    return fillGrid(cols, rows, extent, (x, y) => {
      const [u, v] = rotate(x, y, angle);
      // Cells are pointy-topped with centres one unit apart across the flats.
      const { ox, oy } = hexCell(u / s, v / s);
      const d = Math.max(Math.abs(ox), Math.abs(ox) * 0.5 + Math.abs(oy) * (SQRT3 / 2));
      const edge = inr - d; // distance in from the cell's wall line
      if (edge < wallU) return form === 'domed' || form === 'pyramid' ? 0 : 1;
      const t = clamp01((edge - wallU) / (inr - wallU)); // 0 at the wall, 1 at the centre
      // Bowls and domes are round, not faceted: measured from the centre,
      // reaching the wall at the flats. The corners stay at wall height.
      const rho = Math.min(1, Math.hypot(ox, oy) / (inr - wallU));
      switch (form) {
        case 'flat': return t < 0.08 ? 1 - t / 0.08 : 0;
        case 'domed': return 0.25 + 0.75 * Math.sqrt(1 - rho * rho);
        case 'pyramid': return 0.15 + 0.85 * t;
        // A spherical bowl, deepest in the middle.
        default: return 1 - 0.85 * Math.sqrt(Math.max(0, 1 - rho * rho));
      }
    });
  },
};

// --- Greek key --------------------------------------------------------------------------

/**
 * One period of the meander, in units: a running baseline with a square
 * spiral rising from it. Five wide, four high; the next band starts six up.
 */
const KEY_PATH: Array<[number, number]> = [[0, 0], [0, 4], [4, 4], [4, 1], [2, 1], [2, 2], [3, 2]];

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? clamp01(((px - ax) * dx + (py - ay) * dy) / l2) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

export const greekKey: PatternSpec = {
  id: 'greek_key',
  group: 'Geometric',
  label: 'Greek Key',
  blurb: 'The meander: a line that turns back on itself in square spirals, in bands across the board.',
  depthFraction: 0.2,
  defaults: { unitMm: 6, lineMm: 2.5, profile: 'raised', bandGap: 2, angleDeg: 0 },
  tile: { repeats: [{ key: 'unitMm', axis: 'x', factor: 5, edge: 0 }, { key: 'unitMm', axis: 'y', factor: 6 }], angleKey: 'angleDeg' },
  fields: [
    { kind: 'number', key: 'unitMm', label: 'Unit', min: 1, max: 60, step: 0.5, unit: 'mm',
      hint: 'The spacing of the meander\'s grid. One repeat is five units wide.' },
    { kind: 'number', key: 'lineMm', label: 'Line width', min: 0.3, max: 30, step: 0.1, unit: 'mm' },
    lineProfileField,
    { kind: 'number', key: 'bandGap', label: 'Gap between bands', min: 1, max: 20, step: 1,
      hint: 'In units. A big gap leaves single bands, like a border.' },
    { kind: 'number', key: 'angleDeg', label: 'Direction', min: -90, max: 90, step: 90, unit: 'deg' },
  ],
  build(cols, rows, extent, opts) {
    const unit = Math.max(0.2, num(opts, 'unitMm', 6)) / 1000;
    const half = Math.max(0.05, num(opts, 'lineMm', 2.5)) / 2000;
    const profile = str(opts, 'profile', 'raised');
    const gap = Math.max(1, Math.round(num(opts, 'bandGap', 2)));
    const angle = (num(opts, 'angleDeg', 0) * Math.PI) / 180;
    const bandH = 4 + gap;
    return fillGrid(cols, rows, extent, (x, y) => {
      const [u0, v0] = rotate(x, y, angle);
      const u = u0 / unit;
      // Centre each band's four units in its period.
      const v = v0 / unit + 2;
      const lu = wrap(u, 5);
      const lv = wrap(v, bandH);
      let d = Infinity;
      // This period and its neighbours, for points near a period's edge.
      for (const sh of [-5, 0, 5]) {
        for (let k = 0; k + 1 < KEY_PATH.length; k++) {
          const [ax, ay] = KEY_PATH[k];
          const [bx, by] = KEY_PATH[k + 1];
          d = Math.min(d, segDist(lu, lv, ax + sh, ay, bx + sh, by));
        }
        // The baseline running on to the next period.
        d = Math.min(d, segDist(lu, lv, sh, 0, sh + 5, 0));
      }
      return lineHeight(d * unit, half, profile);
    });
  },
};

// --- Truchet ----------------------------------------------------------------------------

export const truchet: PatternSpec = {
  id: 'truchet',
  group: 'Geometric',
  label: 'Truchet',
  blurb: 'Square tiles each carrying two quarter-circle arcs, turned at random: they join up into endless meandering paths.',
  depthFraction: 0.2,
  defaults: { tileMm: 25, lineMm: 5, profile: 'round', style: 'arcs', seed: 1 },
  tile: { repeats: [{ key: 'tileMm', axis: 'x', edge: 0 }] },
  fields: [
    { kind: 'number', key: 'tileMm', label: 'Tile', min: 3, max: 300, step: 0.5, unit: 'mm' },
    { kind: 'number', key: 'lineMm', label: 'Line width', min: 0.3, max: 60, step: 0.1, unit: 'mm' },
    lineProfileField,
    { kind: 'choice', key: 'style', label: 'Tiles', options: [
      { value: 'arcs', label: 'Arcs' },
      { value: 'diagonals', label: 'Diagonals (maze)' },
      { value: 'circles', label: 'Arcs and crosses' },
    ] },
    seedField(),
  ],
  build(cols, rows, extent, opts) {
    const s = Math.max(0.5, num(opts, 'tileMm', 25)) / 1000;
    const half = Math.max(0.05, num(opts, 'lineMm', 5)) / 2000;
    const profile = str(opts, 'profile', 'round');
    const style = str(opts, 'style', 'arcs');
    const seed = Math.round(num(opts, 'seed', 1));
    return fillGrid(cols, rows, extent, (x, y) => {
      const i = Math.floor(x / s);
      const j = Math.floor(y / s);
      const u = x / s - i;
      const v = y / s - j;
      const r = hash2D(i, j, seed);
      const flip = r < 0.5;
      let d: number;
      if (style === 'diagonals') {
        d = flip ? Math.abs(u - v) / Math.SQRT2 : Math.abs(u + v - 1) / Math.SQRT2;
      } else if (style === 'circles' && r > 0.8) {
        // A crossing: two straight lines through the middle of the tile.
        d = Math.min(Math.abs(u - 0.5), Math.abs(v - 0.5));
      } else {
        const [ax, ay, bx, by] = flip ? [0, 0, 1, 1] : [1, 0, 0, 1];
        d = Math.min(Math.abs(Math.hypot(u - ax, v - ay) - 0.5), Math.abs(Math.hypot(u - bx, v - by) - 0.5));
      }
      return lineHeight(d * s, half, profile);
    });
  },
};

// --- Star lattice -------------------------------------------------------------------------

export const starLattice: PatternSpec = {
  id: 'star_lattice',
  group: 'Geometric',
  label: 'Star Lattice',
  blurb: 'Islamic strapwork: eight-pointed stars and crosses on a square grid, or six-pointed stars and hexagons.',
  depthFraction: 0.2,
  defaults: { form: 'eight', cellMm: 50, lineMm: 3, profile: 'raised', fill: 'stars', angleDeg: 0 },
  tile: { repeats: [{ key: 'cellMm', axis: 'x', edge: 0.5 }], angleKey: 'angleDeg' },
  fields: [
    { kind: 'choice', key: 'form', label: 'Stars', options: [
      { value: 'eight', label: 'Eight-pointed stars and crosses' },
      { value: 'six', label: 'Six-pointed stars and hexagons' },
    ] },
    { kind: 'number', key: 'cellMm', label: 'Star spacing', min: 5, max: 400, step: 1, unit: 'mm' },
    { kind: 'number', key: 'lineMm', label: 'Strap width', min: 0.3, max: 30, step: 0.1, unit: 'mm' },
    lineProfileField,
    { kind: 'choice', key: 'fill', label: 'Fields', options: [
      { value: 'flat', label: 'All at one level' },
      { value: 'stars', label: 'Stars sunk' },
      { value: 'crosses', label: 'Crosses sunk' },
    ] },
    { kind: 'number', key: 'angleDeg', label: 'Rotation', min: -90, max: 90, step: 5, unit: 'deg' },
  ],
  build(cols, rows, extent, opts) {
    const s = Math.max(1, num(opts, 'cellMm', 50)) / 1000;
    const half = Math.max(0.05, num(opts, 'lineMm', 3)) / 2000;
    const profile = str(opts, 'profile', 'raised');
    const fill = str(opts, 'fill', 'stars');
    const six = str(opts, 'form', 'eight') === 'six';
    const angle = (num(opts, 'angleDeg', 0) * Math.PI) / 180;
    return fillGrid(cols, rows, extent, (x, y) => {
      const [u, v] = rotate(x, y, angle);
      let sdf: number; // negative inside a star
      if (six) {
        const { ox, oy } = hexCell(u / s, v / s);
        // Two equilateral triangles whose tips touch the neighbours' tips.
        const R = 0.5;
        const tri = (rot: number) => {
          let m = -Infinity;
          for (let k = 0; k < 3; k++) {
            const a = rot + Math.PI + (k * 2 * Math.PI) / 3;
            m = Math.max(m, ox * Math.cos(a) + oy * Math.sin(a));
          }
          return m - R / 2;
        };
        sdf = Math.min(tri(0), tri(Math.PI / 3)) * s;
      } else {
        const ox = wrap(u / s, 1) - 0.5;
        const oy = wrap(v / s, 1) - 0.5;
        // A square and the same square turned 45 degrees, its points on the
        // axes reaching the cell's edge so neighbouring stars touch.
        const a = 0.5 / Math.SQRT2;
        const sq = Math.max(Math.abs(ox), Math.abs(oy)) - a;
        const dia = (Math.abs(ox) + Math.abs(oy)) / Math.SQRT2 - a;
        sdf = Math.min(sq, dia) * s;
      }
      const h = lineHeight(Math.abs(sdf), half, profile);
      if (Math.abs(sdf) < half || fill === 'flat') return h;
      const inStar = sdf < 0;
      const sunk = (fill === 'stars' && inStar) || (fill === 'crosses' && !inStar);
      return sunk ? h * 0.55 : h;
    });
  },
};

export const GEOMETRIC_PATTERNS: PatternSpec[] = [honeycomb, greekKey, truchet, starLattice];
