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
import {
  band,
  fillGrid,
  mix,
  num,
  rotate,
  seedField,
  smoothstep,
  str,
  wrap,
  PATTERN_GROUPS,
  type PatternOptions,
  type PatternSpec,
} from './patternKit';
import { withLayout } from './patternLayout';
import { FITTED_PATTERNS } from './patternsFitted';
import { GEOMETRIC_PATTERNS } from './patternsGeometric';
import { NATURAL_PATTERNS } from './patternsNatural';
import { ORNAMENT_PATTERNS } from './patternsOrnament';
import { TEXT_PATTERN } from './textPattern';
import { IMAGE_PATTERN } from './imagePattern';

export {
  DEFAULT_DEPTH_FRACTION,
  MIN_SENSIBLE_DEPTH_MM,
  PATTERN_GROUPS,
  type PatternExtent,
  type PatternField,
  type PatternGroup,
  type PatternOptions,
  type PatternRepeat,
  type PatternSpec,
} from './patternKit';


// --- Wood grain ------------------------------------------------------------

const woodGrain: PatternSpec = {
  id: 'wood_grain',
  group: 'Wood & joinery',
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
  group: 'Water & terrain',
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

// --- Fluted ----------------------------------------------------------------


const fluted: PatternSpec = {
  id: 'fluted',
  group: 'Wood & joinery',
  tile: { repeats: [{ key: 'pitchMm', axis: 'x', edge: 0.5 }], angleKey: 'angleDeg' },
  label: 'Fluted',
  blurb: 'Parallel flutes or reeds, straight or meandering on a sine -- the wavy wall-panel look.',
  defaults: {
    pitchMm: 12, profile: 'flute', land: 0.15, meanderMm: 5, meanderWavelengthMm: 160,
    driftDeg: 0, angleDeg: 0,
  },
  fields: [
    { kind: 'number', key: 'pitchMm', label: 'Pitch', min: 2, max: 100, step: 0.5, unit: 'mm',
      hint: 'Centre to centre. A flute narrower than the cutter comes out as wide as the cutter, so keep this above its diameter.' },
    { kind: 'choice', key: 'profile', label: 'Profile', options: [
      { value: 'flute', label: 'Flutes (round grooves)' },
      { value: 'reed', label: 'Reeds (round beads)' },
      { value: 'v', label: 'V grooves' },
    ] },
    { kind: 'number', key: 'land', label: 'Land', min: 0, max: 0.8, step: 0.05,
      hint: 'Flat left between flutes, as a fraction of the pitch. Zero meets in a sharp ridge.' },
    { kind: 'number', key: 'meanderMm', label: 'Meander', min: 0, max: 100, step: 0.5, unit: 'mm',
      hint: 'How far each flute swings to either side. Zero is straight fluting.' },
    { kind: 'number', key: 'meanderWavelengthMm', label: 'Meander length', min: 10, max: 1000, step: 5, unit: 'mm',
      hint: 'Distance along a flute for one full swing.' },
    { kind: 'number', key: 'driftDeg', label: 'Phase drift', min: -180, max: 180, step: 5, unit: 'deg',
      hint: 'How far each flute\'s swing runs ahead of its neighbour\'s. Zero keeps them parallel; a little makes the wave travel across the board.' },
    { kind: 'number', key: 'angleDeg', label: 'Direction', min: -90, max: 90, step: 5, unit: 'deg' },
  ],
  build(cols, rows, extent, opts) {
    const pitch = Math.max(0.5, num(opts, 'pitchMm', 12)) / 1000;
    const profile = str(opts, 'profile', 'flute');
    const land = Math.min(0.95, Math.max(0, num(opts, 'land', 0.15)));
    const amp = Math.max(0, num(opts, 'meanderMm', 5)) / 1000;
    const lambda = Math.max(1, num(opts, 'meanderWavelengthMm', 160)) / 1000;
    const drift = (num(opts, 'driftDeg', 0) * Math.PI) / 180;
    const angle = (num(opts, 'angleDeg', 0) * Math.PI) / 180;

    const k = (2 * Math.PI) / lambda;
    // A flute can swing past its neighbours when the meander outruns the
    // pitch, so the nearest one is not always the one the point started over.
    const reach = Math.min(8, Math.ceil(amp / pitch) + 1);

    return normaliseGrid(
      fillGrid(cols, rows, extent, (x, y) => {
        const [u, v] = rotate(x, y, angle);
        const home = Math.round(u / pitch);
        let best = Infinity;
        for (let i = home - reach; i <= home + reach; i++) {
          const phase = k * v + i * drift;
          const centre = i * pitch + amp * Math.sin(phase);
          // Measured across the flute, not across the board: on the steep
          // part of a swing the horizontal gap overstates the distance, which
          // would pinch every flute thin wherever it turns.
          const slope = amp * k * Math.cos(phase);
          const d = Math.abs(u - centre) / Math.sqrt(1 + slope * slope);
          if (d < best) best = d;
        }
        // 0 at a flute's centre line, 1 halfway to the next.
        const t = best / (pitch / 2);
        if (profile === 'reed') {
          // A bead on every centre line, meeting its neighbour in a V.
          return Math.sqrt(Math.max(0, 1 - t * t));
        }
        // A groove takes the pitch less the land.
        const g = Math.min(1, t / Math.max(1e-6, 1 - land));
        if (profile === 'v') return g;
        // Half round: the section a ball-nose cutter leaves.
        return 1 - Math.sqrt(Math.max(0, 1 - g * g));
      })
    );
  },
};

// --- Wave slats ------------------------------------------------------------

const waveSlats: PatternSpec = {
  id: 'wave_slats',
  group: 'Wood & joinery',
  label: 'Wave Slats',
  blurb: 'A row of slats whose tops rise and fall with a wave running across them.',
  defaults: {
    pitchMm: 20, gapMm: 6, wavelengthMm: 200, waveAngleDeg: 30, low: 0.3, top: 'round', angleDeg: 0,
  },
  fields: [
    { kind: 'number', key: 'pitchMm', label: 'Slat pitch', min: 3, max: 200, step: 0.5, unit: 'mm',
      hint: 'Slat plus gap, centre to centre.' },
    { kind: 'number', key: 'gapMm', label: 'Gap', min: 0, max: 100, step: 0.5, unit: 'mm',
      hint: 'Cut to the floor between slats. Narrower than the cutter, and it comes out as wide as the cutter.' },
    { kind: 'number', key: 'wavelengthMm', label: 'Wavelength', min: 10, max: 2000, step: 5, unit: 'mm',
      hint: 'Crest to crest of the wave the slat tops follow.' },
    { kind: 'number', key: 'waveAngleDeg', label: 'Wave angle', min: -90, max: 90, step: 5, unit: 'deg',
      hint: 'Zero runs the wave along each slat, so they all match; 90 steps it from slat to slat. Between the two it travels diagonally.' },
    { kind: 'number', key: 'low', label: 'Trough height', min: 0.05, max: 0.9, step: 0.05,
      hint: 'How tall a slat stays at the bottom of the wave, as a fraction of the full height.' },
    { kind: 'choice', key: 'top', label: 'Slat top', options: [
      { value: 'round', label: 'Rounded' },
      { value: 'flat', label: 'Square' },
    ] },
    { kind: 'number', key: 'angleDeg', label: 'Direction', min: -90, max: 90, step: 5, unit: 'deg' },
  ],
  build(cols, rows, extent, opts) {
    const pitch = Math.max(1, num(opts, 'pitchMm', 20)) / 1000;
    const gap = Math.min(pitch * 0.9, Math.max(0, num(opts, 'gapMm', 6)) / 1000);
    const lambda = Math.max(1, num(opts, 'wavelengthMm', 200)) / 1000;
    const waveAngle = (num(opts, 'waveAngleDeg', 30) * Math.PI) / 180;
    const low = Math.min(0.95, Math.max(0.01, num(opts, 'low', 0.3)));
    const round = str(opts, 'top', 'round') === 'round';
    const angle = (num(opts, 'angleDeg', 0) * Math.PI) / 180;

    const k = (2 * Math.PI) / lambda;
    const slatW = pitch - gap;

    const out = fillGrid(cols, rows, extent, (x, y) => {
      const [u, v] = rotate(x, y, angle);
      // Each pitch is the gap followed by the slat.
      const i = Math.floor(u / pitch);
      const inPitch = u - i * pitch;
      if (inPitch < gap) return 0;
      // The wave is read at the slat's centre line, not at the point, so a
      // slat is one slat -- the same height across its width -- and the wave
      // shows as a step from each to the next, which is the whole look.
      const centre = i * pitch + gap + slatW / 2;
      const phase = k * (v * Math.cos(waveAngle) + centre * Math.sin(waveAngle));
      const height = low + (1 - low) * (0.5 + 0.5 * Math.sin(phase));
      if (!round) return height;
      const s = (inPitch - gap - slatW / 2) / (slatW / 2);
      // A rounded-over top, not a half cylinder: the flat of the slat still
      // carries the wave and only its edges fall away.
      const ease = Math.sqrt(Math.max(0, 1 - Math.pow(Math.abs(s), 4)));
      return height * (0.75 + 0.25 * ease);
    });
    // Not normalised: the gap floor is genuinely zero, and the slat tops are
    // already a fraction of full height by construction.
    return out;
  },
};

// --- Sliced ----------------------------------------------------------------

const sliced: PatternSpec = {
  id: 'sliced',
  group: 'Wood & joinery',
  throughCut: true,
  flatTopped: true,
  label: 'Sliced',
  blurb: 'A board cut right through into wavy strips that stay joined at both ends, like a sliced and fanned steak.',
  caveat:
    'Through-cut pattern (0.3 mm into spoilboard); requires a spoilboard, adequate end margin, and a cutter diameter ≤ slot width with flute length ≥ stock thickness.',
  defaults: {
    slices: 7, slotMm: 6.35, amplitudeMm: 12, wavelengthMm: 250, phaseDeg: 0, endMarginMm: 30,
    envelope: 'taper', axis: 'x',
  },
  fields: [
    { kind: 'number', key: 'slices', label: 'Strips', min: 2, max: 60, step: 1,
      hint: 'How many strips the board is cut into. One slot fewer than that.' },
    { kind: 'number', key: 'slotMm', label: 'Slot width', min: 0.5, max: 50, step: 0.05, unit: 'mm',
      hint: 'The cut between strips. It cannot be narrower than the cutter: 6.35 mm is a 1/4" end mill.' },
    { kind: 'number', key: 'amplitudeMm', label: 'Wave', min: 0, max: 200, step: 0.5, unit: 'mm',
      hint: 'How far the strips swing to either side at the middle of the board.' },
    { kind: 'number', key: 'wavelengthMm', label: 'Wavelength', min: 10, max: 3000, step: 5, unit: 'mm',
      hint: 'Length along the board of one full swing.' },
    { kind: 'number', key: 'phaseDeg', label: 'Phase shift', min: -180, max: 180, step: 5, unit: 'deg',
      hint: 'How far each slot\'s swing runs ahead of the last. Zero keeps the strips an even width; anything else makes them swell and pinch -- too much, with a big wave, and neighbouring slots meet and cut a strip in two.' },
    { kind: 'number', key: 'endMarginMm', label: 'End margin', min: 5, max: 500, step: 1, unit: 'mm',
      hint: 'Solid board left at each end, holding the strips together.' },
    { kind: 'choice', key: 'envelope', label: 'Wave shape', options: [
      { value: 'taper', label: 'Gathers at the ends' },
      { value: 'eased', label: 'Full swing, eased at the ends' },
    ], hint: 'Gathering brings every slot back to straight where it meets the solid ends, which is the classic look.' },
    { kind: 'choice', key: 'axis', label: 'Strips run', options: [
      { value: 'x', label: 'Along the width' },
      { value: 'y', label: 'Along the depth' },
    ] },
  ],
  build(cols, rows, extent, opts) {
    const n = Math.max(2, Math.round(num(opts, 'slices', 7)));
    const halfSlot = Math.max(0.05, num(opts, 'slotMm', 6.35)) / 2000;
    const amp = Math.max(0, num(opts, 'amplitudeMm', 12)) / 1000;
    const lambda = Math.max(1, num(opts, 'wavelengthMm', 250)) / 1000;
    const phase = (num(opts, 'phaseDeg', 0) * Math.PI) / 180;
    const margin = Math.max(0, num(opts, 'endMarginMm', 30)) / 1000;
    const taper = str(opts, 'envelope', 'taper') === 'taper';
    const alongY = str(opts, 'axis', 'x') === 'y';

    // Work along the strips (s) and across them (t), whichever way they run.
    const length = alongY ? extent.depthM : extent.widthM;
    const breadth = alongY ? extent.widthM : extent.depthM;
    const start = Math.min(margin, length / 2);
    const end = length - start;
    const run = Math.max(1e-6, end - start);
    const spacing = breadth / n;
    const k = (2 * Math.PI) / lambda;

    /** How much of the swing is allowed at s: nothing at the ends, all of it in the middle. */
    const envelope = (s: number): number => {
      const u = clamp01((s - start) / run);
      if (taper) return Math.sin(Math.PI * u);
      const ramp = clamp01(Math.min(u, 1 - u) / 0.2);
      return ramp * ramp * (3 - 2 * ramp);
    };
    const centre = (i: number, s: number): number =>
      i * spacing + amp * envelope(s) * Math.sin(k * (s - start) + i * phase);

    // Slots can swing past a neighbour's resting line, so look a few either side.
    const reach = Math.min(10, Math.ceil(amp / Math.max(1e-6, spacing)) + 1);
    const ds = Math.max(1e-5, run / 2000);

    return fillGrid(cols, rows, extent, (x, y) => {
      const s = alongY ? y : x;
      const t = alongY ? x : y;
      const home = Math.round(t / spacing);
      for (let i = Math.max(1, home - reach); i <= Math.min(n - 1, home + reach); i++) {
        let d: number;
        if (s < start || s > end) {
          // Past the end of the slot the cutter's own radius rounds it off.
          const e = s < start ? start : end;
          d = Math.hypot(s - e, t - centre(i, e));
        } else {
          const slope = (centre(i, s + ds) - centre(i, s - ds)) / (2 * ds);
          d = Math.abs(t - centre(i, s)) / Math.sqrt(1 + slope * slope);
        }
        if (d < halfSlot) return 0;
      }
      return 1;
    });
  },
};

// --- Topographic -----------------------------------------------------------

const topographic: PatternSpec = {
  id: 'topographic',
  group: 'Water & terrain',
  flatTopped: true,
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
  group: 'Nature',
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
  group: 'Geometric',
  tile: { repeats: [{ key: 'brickLengthMm', axis: 'x' }, { key: 'brickHeightMm', axis: 'y' }] },
  flatTopped: true,
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

// --- Parquet ---------------------------------------------------------------


/**
 * Which stave of a herringbone a point is on, in units of the stave width.
 *
 * The staves here are axis-aligned and `n` widths long; the board turns the
 * whole field 45 degrees afterwards, which is what makes it read as a
 * herringbone rather than as a staircase. Horizontal staves start at (t, t)
 * and vertical ones at (t, t + 1), and that pair repeats every (n, -n) -- a
 * lattice whose cell has area 2n, exactly one stave of each kind, so the two
 * tests below between them cover the plane once.
 */
function herringboneStave(x: number, y: number, n: number): { id: [number, number]; along: number; across: number } {
  const fy = Math.floor(y);
  const a = wrap(x - fy, 2 * n);
  if (a < n) {
    return { id: [Math.floor((x - fy) / (2 * n)) * 2, fy], along: a, across: y - fy };
  }
  const fx = Math.floor(x);
  const b = wrap(y - fx - 1, 2 * n);
  return { id: [Math.floor((y - fx - 1) / (2 * n)) * 2 + 1, fx], along: b, across: x - fx };
}

const parquet: PatternSpec = {
  id: 'parquet',
  group: 'Wood & joinery',
  flatTopped: true,
  label: 'Herringbone & Parquet',
  blurb: 'Staves laid in a herringbone, a chevron or a basket weave, with sunk joints.',
  defaults: { layout: 'herringbone', staveLengthMm: 80, staveWidthMm: 20, jointMm: 1.5, jitter: 0.5, seed: 1 },
  baseRgb: [0.66, 0.47, 0.28],
  // The joint is the floor; above it each stave takes its own tone from its own
  // height, which the per-stave lift sets -- so a board reads as separate
  // pieces of timber, the way parquet does.
  palette: (h) => (h < 0.3
    ? [0.22, 0.14, 0.08]
    : mix([0.50, 0.32, 0.17], [0.80, 0.62, 0.40], (h - 0.3) / 0.7)),
  fields: [
    { kind: 'choice', key: 'layout', label: 'Layout', options: [
      { value: 'herringbone', label: 'Herringbone' },
      { value: 'chevron', label: 'Chevron' },
      { value: 'basket', label: 'Basket weave' },
    ] },
    { kind: 'number', key: 'staveLengthMm', label: 'Stave length', min: 10, max: 600, step: 1, unit: 'mm',
      hint: 'Herringbone and basket weave round this to a whole number of stave widths, which is what lets the staves interlock.' },
    { kind: 'number', key: 'staveWidthMm', label: 'Stave width', min: 3, max: 150, step: 0.5, unit: 'mm' },
    { kind: 'number', key: 'jointMm', label: 'Joint', min: 0.3, max: 10, step: 0.1, unit: 'mm',
      hint: 'The sunk line between staves. Narrower than the cutter, and it comes out as wide as the cutter.' },
    { kind: 'number', key: 'jitter', label: 'Variation', min: 0, max: 1, step: 0.05,
      hint: 'Per-stave differences in height and tone. Zero is one flat floor with lines in it.' },
    seedField(),
  ],
  build(cols, rows, extent, opts) {
    const layout = str(opts, 'layout', 'herringbone');
    const W = Math.max(0.5, num(opts, 'staveWidthMm', 20)) / 1000;
    const lengthM = Math.max(1, num(opts, 'staveLengthMm', 80)) / 1000;
    const n = Math.max(2, Math.round(lengthM / W));
    const joint = Math.max(0.05, num(opts, 'jointMm', 1.5)) / 1000;
    const jitter = clamp01(num(opts, 'jitter', 0.5));
    const seed = Math.round(num(opts, 'seed', 1));

    // The chevron's staves are cut on the mitre, so a column is the stave's
    // length laid across at 45 degrees and a row is its width measured square
    // to the cut.
    const chevronCol = lengthM * Math.SQRT1_2;
    const chevronRow = W * Math.SQRT2;

    /** The stave a point is on, and how far it is from that stave's edge, in metres. */
    const locate = (x: number, y: number): { id: [number, number]; edge: number } => {
      if (layout === 'chevron') {
        const col = Math.floor(x / chevronCol);
        const xl = x - col * chevronCol;
        // Alternate columns slope opposite ways and meet at the seam.
        const rise = col % 2 === 0 ? xl : chevronCol - xl;
        const yy = y - rise;
        const row = Math.floor(yy / chevronRow);
        const f = yy / chevronRow - row;
        const acrossEdge = Math.min(f, 1 - f) * W;
        const seamEdge = Math.min(xl, chevronCol - xl);
        return { id: [col, row], edge: Math.min(acrossEdge, seamEdge) };
      }
      if (layout === 'basket') {
        const block = n * W;
        const bi = Math.floor(x / block);
        const bj = Math.floor(y / block);
        const xl = x - bi * block;
        const yl = y - bj * block;
        // Each block is n staves side by side, turned a quarter between neighbours.
        const flat = (bi + bj) % 2 === 0;
        const across = flat ? yl : xl;
        const s = Math.floor(across / W);
        const f = across - s * W;
        const edge = Math.min(f, W - f, xl, block - xl, yl, block - yl);
        return { id: [bi * n + (flat ? 0 : s), bj * n + (flat ? s : 0)], edge };
      }
      // Herringbone, worked in stave widths in a frame turned 45 degrees.
      const [u, v] = rotate(x, y, Math.PI / 4);
      const st = herringboneStave(u / W, v / W, n);
      if (st.along >= n) return { id: st.id, edge: 0 };
      const edge = Math.min(st.along, n - st.along, st.across, 1 - st.across) * W;
      return { id: st.id, edge };
    };

    return fillGrid(cols, rows, extent, (x, y) => {
      const { id, edge } = locate(x, y);
      const half = joint / 2;
      if (edge < half) return 0;
      const lift = jitter > 0 ? (hash2D(id[0], id[1], seed ^ 0x5a17) - 0.5) * jitter * 0.5 : 0;
      // Ease each stave into its joint, as the bricks do: a stave with a
      // knife edge is one a round cutter cannot make and real oak chips off.
      const arris = clamp01((edge - half) / (joint * 0.8));
      return clamp01(0.4 + (0.55 + lift) * arris);
    });
  },
};

// --- Faceted ---------------------------------------------------------------

/**
 * The offset from a point to the centre of its hexagon, in a lattice whose
 * centres are one unit apart.
 *
 * Two rectangular lattices of centres, one shifted half a cell, between them
 * hold every hexagon centre; the nearer of the two candidates is the one the
 * point is in.
 */
function hexOffset(x: number, y: number): [number, number] {
  const sy = Math.sqrt(3);
  const ax = wrap(x, 1) - 0.5;
  const ay = wrap(y, sy) - sy / 2;
  const bx = wrap(x - 0.5, 1) - 0.5;
  const by = wrap(y - sy / 2, sy) - sy / 2;
  return ax * ax + ay * ay < bx * bx + by * by ? [ax, ay] : [bx, by];
}

const faceted: PatternSpec = {
  id: 'faceted',
  group: 'Geometric',
  tile: { repeats: [{ key: 'cellMm', axis: 'x' }], angleKey: 'angleDeg' },
  label: 'Faceted',
  blurb: 'Fields of pyramids, diamonds or hexagons, or the tumbling-blocks cube illusion.',
  defaults: { form: 'pyramid', cellMm: 30, sharpness: 1, angleDeg: 0 },
  fields: [
    { kind: 'choice', key: 'form', label: 'Form', options: [
      { value: 'pyramid', label: 'Square pyramids' },
      { value: 'diamond', label: 'Diamonds' },
      { value: 'hex', label: 'Hex pyramids' },
      { value: 'blocks', label: 'Tumbling blocks' },
    ] },
    { kind: 'number', key: 'cellMm', label: 'Cell size', min: 3, max: 300, step: 1, unit: 'mm',
      hint: 'One pyramid or block, edge to edge.' },
    { kind: 'number', key: 'sharpness', label: 'Peak sharpness', min: 0, max: 1, step: 0.05,
      hint: 'One comes to a point; lower cuts the tops off flat. Tumbling blocks only read as cubes when sharp.' },
    { kind: 'number', key: 'angleDeg', label: 'Rotation', min: -90, max: 90, step: 5, unit: 'deg' },
  ],
  build(cols, rows, extent, opts) {
    const form = str(opts, 'form', 'pyramid');
    const cell = Math.max(0.5, num(opts, 'cellMm', 30)) / 1000;
    const sharp = clamp01(num(opts, 'sharpness', 1));
    const angle = (num(opts, 'angleDeg', 0) * Math.PI) / 180;
    // The three faces of a cube corner, pointing at alternate vertices of its
    // hexagon. Every point's height is set by whichever it faces most.
    const cubeFaces = [90, 210, 330].map((d) => [Math.cos((d * Math.PI) / 180), Math.sin((d * Math.PI) / 180)]);

    const raw = (x: number, y: number): number => {
      let [u, v] = rotate(x, y, angle);
      u /= cell;
      v /= cell;
      if (form === 'hex' || form === 'blocks') {
        const [gx, gy] = hexOffset(u, v);
        if (form === 'hex') {
          // Distance to the hexagon's edge, as a fraction of its inradius.
          const d = Math.max(Math.abs(gx), Math.abs(gx) * 0.5 + Math.abs(gy) * (Math.sqrt(3) / 2));
          return 1 - d / 0.5;
        }
        // Three planes meeting at the centre. Raking light gives each its own
        // shade, which is the whole illusion -- no paint involved.
        let m = 0;
        for (const [fx, fy] of cubeFaces) m = Math.max(m, gx * fx + gy * fy);
        return 1 - m * Math.sqrt(3);
      }
      if (form === 'diamond') {
        // A square pyramid field squashed along one axis and turned 45
        // degrees: the knurl a lathe leaves, at a larger scale.
        [u, v] = rotate(u, v / 1.6, Math.PI / 4);
      }
      const fu = wrap(u, 1) - 0.5;
      const fv = wrap(v, 1) - 0.5;
      return 1 - 2 * Math.max(Math.abs(fu), Math.abs(fv));
    };

    // Sharpness truncates the top: 1 leaves the point, 0 flattens the upper
    // 60% of every facet into a plateau.
    const scale = 0.4 + 0.6 * sharp;
    return fillGrid(cols, rows, extent, (x, y) => clamp01(raw(x, y) / scale));
  },
};

// --- Kumiko ----------------------------------------------------------------

/** Distance from a point to a segment. */
function segmentDistance(
  px: number, py: number, ax: number, ay: number, bx: number, by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp01(((px - ax) * dx + (py - ay) * dy) / len2) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const kumiko: PatternSpec = {
  id: 'kumiko',
  group: 'Wood & joinery',
  tile: { repeats: [{ key: 'cellMm', axis: 'x' }], angleKey: 'angleDeg' },
  label: 'Kumiko',
  blurb: 'Japanese lattice patterns as fine grooves in a flat face: hemp leaf, triangles, or squares and diagonals.',
  depthFraction: 0.15,
  defaults: { form: 'asanoha', cellMm: 40, lineMm: 2.5, profile: 'v', angleDeg: 0 },
  fields: [
    { kind: 'choice', key: 'form', label: 'Form', options: [
      { value: 'asanoha', label: 'Asanoha (hemp leaf)' },
      { value: 'triangle', label: 'Triangles' },
      { value: 'square', label: 'Squares & diagonals' },
    ] },
    { kind: 'number', key: 'cellMm', label: 'Cell size', min: 5, max: 300, step: 1, unit: 'mm',
      hint: 'The edge of one triangle or square.' },
    { kind: 'number', key: 'lineMm', label: 'Line width', min: 0.3, max: 20, step: 0.1, unit: 'mm',
      hint: 'Width at the surface. Cut with a V bit, the line\'s width follows from its depth.' },
    { kind: 'choice', key: 'profile', label: 'Groove', options: [
      { value: 'v', label: 'V' },
      { value: 'round', label: 'Round' },
    ] },
    { kind: 'number', key: 'angleDeg', label: 'Rotation', min: -90, max: 90, step: 5, unit: 'deg' },
  ],
  build(cols, rows, extent, opts) {
    const form = str(opts, 'form', 'asanoha');
    const s = Math.max(1, num(opts, 'cellMm', 40)) / 1000;
    const half = Math.max(0.05, num(opts, 'lineMm', 2.5)) / 2000;
    const round = str(opts, 'profile', 'v') === 'round';
    const angle = (num(opts, 'angleDeg', 0) * Math.PI) / 180;
    const h = (s * Math.sqrt(3)) / 2;

    /** Distance from a point to the nearest line of the lattice, in metres. */
    const distance = (x: number, y: number): number => {
      const [u, v] = rotate(x, y, angle);
      if (form === 'square') {
        // Every line here is infinite -- the grid and both diagonals of each
        // square -- so the distance is the nearest of four line families.
        const line = (a: number, period: number): number => Math.abs(wrap(a + period / 2, period) - period / 2);
        return Math.min(
          line(u, s),
          line(v, s),
          line(u - v, s) * Math.SQRT1_2,
          line(u + v, s) * Math.SQRT1_2
        );
      }
      // Find the triangle of a triangular lattice the point is in, from its
      // skewed coordinates.
      const j = v / h;
      const i = u / s - j / 2;
      const fi = Math.floor(i);
      const fj = Math.floor(j);
      const up = i - fi + (j - fj) < 1;
      const corners: Array<[number, number]> = up
        ? [[fi, fj], [fi + 1, fj], [fi, fj + 1]]
        : [[fi + 1, fj], [fi + 1, fj + 1], [fi, fj + 1]];
      const pts = corners.map(([ci, cj]) => [(ci + cj / 2) * s, cj * h]);
      let d = Infinity;
      for (let k = 0; k < 3; k++) {
        const [ax, ay] = pts[k];
        const [bx, by] = pts[(k + 1) % 3];
        d = Math.min(d, segmentDistance(u, v, ax, ay, bx, by));
      }
      if (form === 'asanoha') {
        // The hemp leaf adds a spoke from each triangle's centre to each of
        // its corners. The triangle's own edges are always drawn, so nothing
        // outside it can be nearer than they are; checking this one
        // triangle's spokes is enough.
        const cx = (pts[0][0] + pts[1][0] + pts[2][0]) / 3;
        const cy = (pts[0][1] + pts[1][1] + pts[2][1]) / 3;
        for (const [px, py] of pts) d = Math.min(d, segmentDistance(u, v, cx, cy, px, py));
      }
      return d;
    };

    return fillGrid(cols, rows, extent, (x, y) => {
      const t = distance(x, y) / half;
      if (t >= 1) return 1;
      return round ? 1 - Math.sqrt(Math.max(0, 1 - t * t)) : t;
    });
  },
};

// --- Guilloche -------------------------------------------------------------

const guilloche: PatternSpec = {
  id: 'guilloche',
  group: 'Geometric',
  label: 'Guilloché',
  blurb: 'Engine-turned interference lines: a moiré of two wavy line sets, or a spirograph rosette.',
  depthFraction: 0.1,
  defaults: { form: 'rosette', pitchMm: 3, lineMm: 1, amplitudeMm: 4, wavelengthMm: 60, crossDeg: 6, lobes: 12, twistDeg: 8 },
  fields: [
    { kind: 'choice', key: 'form', label: 'Form', options: [
      { value: 'rosette', label: 'Rosette' },
      { value: 'moire', label: 'Moiré' },
    ] },
    { kind: 'number', key: 'pitchMm', label: 'Line pitch', min: 0.5, max: 30, step: 0.1, unit: 'mm',
      hint: 'Spacing between neighbouring lines. Fine pitches need a fine V bit.' },
    { kind: 'number', key: 'lineMm', label: 'Line width', min: 0.1, max: 10, step: 0.05, unit: 'mm' },
    { kind: 'number', key: 'amplitudeMm', label: 'Wave', min: 0, max: 50, step: 0.5, unit: 'mm',
      hint: 'How far each line swings.' },
    { kind: 'number', key: 'wavelengthMm', label: 'Wavelength', min: 5, max: 500, step: 1, unit: 'mm',
      hint: 'Moiré only: the length of one swing along a line.' },
    { kind: 'number', key: 'crossDeg', label: 'Cross angle', min: 0, max: 45, step: 0.5, unit: 'deg',
      hint: 'Moiré only: the angle between the two line sets. Small angles give the broad, slow beats.' },
    { kind: 'number', key: 'lobes', label: 'Lobes', min: 2, max: 60, step: 1,
      hint: 'Rosette only: swings in one turn around the centre.' },
    { kind: 'number', key: 'twistDeg', label: 'Twist', min: 0, max: 90, step: 1, unit: 'deg',
      hint: 'Rosette only: how far each ring\'s swing turns from the last. The two sets twist opposite ways and weave.' },
  ],
  build(cols, rows, extent, opts) {
    const form = str(opts, 'form', 'rosette');
    const pitch = Math.max(0.1, num(opts, 'pitchMm', 3)) / 1000;
    const half = Math.max(0.05, num(opts, 'lineMm', 1)) / 2000;
    const amp = Math.max(0, num(opts, 'amplitudeMm', 4)) / 1000;
    const lambda = Math.max(1, num(opts, 'wavelengthMm', 60)) / 1000;
    const cross = (num(opts, 'crossDeg', 6) * Math.PI) / 180;
    const lobes = Math.max(1, Math.round(num(opts, 'lobes', 12)));
    const twist = (num(opts, 'twistDeg', 8) * Math.PI) / 180;
    const k = (2 * Math.PI) / lambda;
    const reach = Math.min(12, Math.ceil(amp / pitch) + 1);
    const cx = extent.widthM / 2;
    const cy = extent.depthM / 2;

    /** Groove height for a distance from the nearest line: 0 on it, 1 clear of it. */
    const groove = (d: number): number => Math.min(1, d / half);

    /** Distance to the nearest of a family of wavy straight lines turned by `a`. */
    const wavyLines = (x: number, y: number, a: number): number => {
      const [u, v] = rotate(x, y, a);
      const sway = amp * Math.sin(k * u);
      const slope = amp * k * Math.cos(k * u);
      const off = v - sway;
      return Math.abs(off - Math.round(off / pitch) * pitch) / Math.sqrt(1 + slope * slope);
    };

    /** Distance to the nearest of a family of wavy rings, whose swing turns by `tw` each ring. */
    const wavyRings = (x: number, y: number, tw: number): number => {
      const r = Math.hypot(x - cx, y - cy);
      const phi = Math.atan2(y - cy, x - cx);
      const home = Math.round(r / pitch);
      let best = Infinity;
      for (let i = Math.max(0, home - reach); i <= home + reach; i++) {
        const phase = lobes * phi + i * tw;
        const ring = i * pitch + amp * Math.sin(phase);
        const slope = r > 1e-6 ? (amp * lobes * Math.cos(phase)) / r : 0;
        best = Math.min(best, Math.abs(r - ring) / Math.sqrt(1 + slope * slope));
      }
      return best;
    };

    return fillGrid(cols, rows, extent, (x, y) => {
      if (form === 'moire') {
        return Math.min(groove(wavyLines(x, y, 0)), groove(wavyLines(x, y, cross)));
      }
      return Math.min(groove(wavyRings(x, y, twist)), groove(wavyRings(x, y, -twist)));
    });
  },
};

// --- Fish scales -----------------------------------------------------------

const scales: PatternSpec = {
  id: 'scales',
  group: 'Geometric',
  label: 'Fish Scales',
  blurb: 'Overlapping round scales in offset rows, each one lifting to its free edge.',
  defaults: { scaleMm: 24, overlap: 0.25, lift: 0.7, jitter: 0.3, angleDeg: 0, seed: 1 },
  fields: [
    { kind: 'number', key: 'scaleMm', label: 'Scale size', min: 3, max: 300, step: 1, unit: 'mm',
      hint: 'The width of one scale.' },
    { kind: 'number', key: 'overlap', label: 'Overlap', min: 0, max: 0.7, step: 0.05,
      hint: 'How much of each scale the next row covers. More overlap, shorter scales.' },
    { kind: 'number', key: 'lift', label: 'Lift', min: 0.1, max: 1, step: 0.05,
      hint: 'How much each scale rises from where it tucks under to its free edge. The step at the edge is what shows the overlap.' },
    { kind: 'number', key: 'jitter', label: 'Variation', min: 0, max: 1, step: 0.05,
      hint: 'Per-scale differences in height.' },
    { kind: 'number', key: 'angleDeg', label: 'Direction', min: -180, max: 180, step: 5, unit: 'deg',
      hint: 'Which way the free edges face.' },
    seedField(),
  ],
  build(cols, rows, extent, opts) {
    const R = Math.max(0.5, num(opts, 'scaleMm', 24)) / 2000;
    const overlap = Math.min(0.7, Math.max(0, num(opts, 'overlap', 0.25)));
    const lift = Math.min(1, Math.max(0.05, num(opts, 'lift', 0.7)));
    const jitter = clamp01(num(opts, 'jitter', 0.3));
    const angle = (num(opts, 'angleDeg', 0) * Math.PI) / 180;
    const seed = Math.round(num(opts, 'seed', 1));
    // Rows a radius apart on half-offset centres just cover the plane with
    // nothing to spare; closer rows overlap more. Never further apart than
    // that, or bare gaps open between the scales.
    const rowH = R * (1 - overlap);
    const span = Math.ceil(R / rowH);

    return normaliseGrid(
      fillGrid(cols, rows, extent, (x, y) => {
        const [u, v] = rotate(x, y, angle);
        const home = Math.floor(v / rowH);
        // Later rows lie on top, so the first scale found counting down from
        // the highest candidate row is the one that shows.
        for (let r = home + span; r >= home - span; r--) {
          const offset = (r & 1) * R;
          const i = Math.round((u - offset) / (2 * R));
          const d = Math.hypot(u - (offset + i * 2 * R), v - r * rowH);
          if (d >= R) continue;
          const bump = jitter > 0 ? (hash2D(i, r, seed ^ 0x3c1) - 0.5) * jitter * 0.3 : 0;
          return 1 - lift * (1 - d / R) + bump;
        }
        return 0;
      })
    );
  },
};

// --- Stud plate ------------------------------------------------------------

const studs: PatternSpec = {
  id: 'studs',
  group: 'Geometric',
  flatTopped: true,
  label: 'Stud Plate',
  blurb: 'A flat plate with rows of round studs standing proud of it.',
  caveat:
    'Decorative stud pattern only (no underside clutch tubes); finish with a ball-nose cutter to avoid flat-mill root fillets.',
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
  group: 'Nature',
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
  group: 'Nature',
  flatTopped: true,
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
  group: 'Nature',
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

const CORE_PATTERNS: PatternSpec[] = [
  woodGrain,
  masonry,
  parquet,
  faceted,
  kumiko,
  guilloche,
  scales,
  waves,
  fluted,
  waveSlats,
  sliced,
  topographic,
  crackedEarth,
  studs,
  animalPrint,
  reactionDiffusion,
  foliage,
];

/**
 * Every pattern, each wrapped with the layout controls (fit, frame, symmetry,
 * fade, soften) and listed in the order of its menu group. Text and the
 * picture come first and are not wrapped: they place themselves, and a frame
 * or a mirror is not something lettering or a height map wants.
 */
export const SURFACE_PATTERNS: PatternSpec[] = [TEXT_PATTERN, IMAGE_PATTERN, ...[
  ...ORNAMENT_PATTERNS,
  ...FITTED_PATTERNS,
  ...CORE_PATTERNS,
  ...GEOMETRIC_PATTERNS,
  ...NATURAL_PATTERNS,
]
  .map((spec, i) => ({ spec, i }))
  .sort((a, b) => groupRank(a.spec) - groupRank(b.spec) || a.i - b.i)
  .map(({ spec }) => withLayout(spec))];

function groupRank(spec: PatternSpec): number {
  const i = PATTERN_GROUPS.indexOf(spec.group ?? 'Nature');
  return i < 0 ? PATTERN_GROUPS.length : i;
}

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

/**
 * How far a through-cut goes past the bottom of the stock, in mm: enough to
 * clear the last skin of a board that is never quite the thickness it says,
 * not so much that the spoilboard is ploughed.
 */
export const THROUGH_CUT_OVERCUT_MM = 0.3;

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
  // A through-cut is the whole board with holes in it, so its depth is the
  // board's and nothing is left under it.
  const through = spec.throughCut === true;
  const panelMm = through ? stock.thicknessMm : patternDepthMm + PANEL_BASE_MM;
  if (!through && patternDepthMm <= 0) throw new Error('The pattern needs a depth to be cut to.');
  if (!through && panelMm + RELIEF_FLOOR_MM > stock.thicknessMm) {
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
    maxHeightM: (through ? stock.thicknessMm : patternDepthMm) / 1000,
    baseThicknessM: through ? 0 : PANEL_BASE_MM / 1000,
    holeBelow: through ? 0.5 : undefined,
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
