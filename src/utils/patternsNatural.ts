// ---------------------------------------------------------------------------
// Woven, watery and landscape patterns: weave, tartan, water drop, ocean,
// fractal landscape and cobblestones.
// ---------------------------------------------------------------------------

import { clamp01, fbm, fract, hash2D, mulberry32, normaliseGrid, valueNoise2D } from './patternNoise';
import {
  fillGrid,
  mix,
  num,
  rotate,
  seedField,
  smoothstep,
  str,
  type PatternOptions,
  type PatternSpec,
} from './patternKit';

const TAU = Math.PI * 2;

// --- Weave -----------------------------------------------------------------------

/** Whether the warp (running up the board) is over the weft at crossing (i, j). */
function warpOver(weave: string, i: number, j: number): boolean {
  const m = (a: number, n: number) => ((a % n) + n) % n;
  switch (weave) {
    case 'basket': return (Math.floor(i / 2) + Math.floor(j / 2)) % 2 === 0;
    case 'twill': return m(i + j, 4) < 2;
    case 'satin': return m(2 * i - j, 5) === 0;
    case 'herringbone': {
      // A twill that reverses every four ends.
      const block = Math.floor(i / 4);
      return m((block % 2 === 0 ? i : -i) + j, 4) < 2;
    }
    default: return m(i + j, 2) === 0;
  }
}

export const weave: PatternSpec = {
  id: 'weave',
  group: 'Textile',
  label: 'Weave',
  blurb: 'Strands woven over and under each other: plain, basket, twill, herringbone twill or satin -- cane, rattan or a leather weave at any scale.',
  defaults: { weave: 'plain', pitchMm: 12, gapMm: 1.5, undulation: 0.55, angleDeg: 0 },
  tile: { repeats: [{ key: 'pitchMm', axis: 'x', edge: 0.5 }], angleKey: 'angleDeg' },
  fields: [
    { kind: 'choice', key: 'weave', label: 'Weave', options: [
      { value: 'plain', label: 'Plain (one over, one under)' },
      { value: 'basket', label: 'Basket (two by two)' },
      { value: 'twill', label: 'Twill (diagonal)' },
      { value: 'herringbone', label: 'Herringbone twill' },
      { value: 'satin', label: 'Satin' },
    ] },
    { kind: 'number', key: 'pitchMm', label: 'Strand pitch', min: 1, max: 100, step: 0.5, unit: 'mm',
      hint: 'Centre to centre of neighbouring strands.' },
    { kind: 'number', key: 'gapMm', label: 'Gap', min: 0, max: 30, step: 0.25, unit: 'mm',
      hint: 'Open space between strands, cut to the floor.' },
    { kind: 'number', key: 'undulation', label: 'Over and under', min: 0, max: 1, step: 0.05,
      hint: 'How far a strand dips to pass under another. Zero is a flat weave read only from its edges.' },
    { kind: 'number', key: 'angleDeg', label: 'Direction', min: -90, max: 90, step: 5, unit: 'deg',
      hint: '45 lays the weave on the diagonal, the way cane chair seats are.' },
  ],
  build(cols, rows, extent, opts) {
    const p = Math.max(0.5, num(opts, 'pitchMm', 12)) / 1000;
    const gap = Math.min(p * 0.8, Math.max(0, num(opts, 'gapMm', 1.5)) / 1000);
    const und = clamp01(num(opts, 'undulation', 0.55));
    const kind = str(opts, 'weave', 'plain');
    const angle = (num(opts, 'angleDeg', 0) * Math.PI) / 180;
    const w = (p - gap) / 2;

    /** Height of the strand centred on line `i`, crossing `along` (in pitches). */
    const strand = (warp: boolean, i: number, along: number): number => {
      const j0 = Math.floor(along);
      const t = along - j0;
      const lv = (j: number) => ((warp ? warpOver(kind, i, j) : !warpOver(kind, j, i)) ? 1 : -1);
      const a = lv(j0);
      const b = lv(j0 + 1);
      // Cosine ease from one crossing to the next: over, then down and under.
      const z = a + (b - a) * (0.5 - 0.5 * Math.cos(Math.PI * t));
      return z;
    };

    return fillGrid(cols, rows, extent, (x, y) => {
      const [u, v] = rotate(x, y, angle);
      // Crossings sit on whole pitches; strands are centred on them.
      const ci = Math.round(u / p);
      const rj = Math.round(v / p);
      const du = Math.abs(u - ci * p);
      const dv = Math.abs(v - rj * p);
      let h = 0;
      if (du < w) {
        const z = strand(true, ci, v / p);
        const section = Math.sqrt(1 - (du / w) ** 2);
        h = Math.max(h, 0.3 + 0.35 * section + 0.35 * und * (z + 1) / 2 + (1 - und) * 0.175);
      }
      if (dv < w) {
        const z = strand(false, rj, u / p);
        const section = Math.sqrt(1 - (dv / w) ** 2);
        h = Math.max(h, 0.3 + 0.35 * section + 0.35 * und * (z + 1) / 2 + (1 - und) * 0.175);
      }
      return clamp01(h);
    });
  },
};

// --- Tartan ----------------------------------------------------------------------

/** Thread colours, darkest first: the order they are cut, deepest first. */
const TARTAN_COLOURS: Record<string, [number, number, number]> = {
  K: [0.08, 0.08, 0.09],
  B: [0.10, 0.14, 0.32],
  G: [0.08, 0.30, 0.17],
  R: [0.70, 0.10, 0.12],
  Az: [0.30, 0.55, 0.80],
  Y: [0.92, 0.78, 0.18],
  W: [0.93, 0.92, 0.88],
};

/**
 * Setts as thread counts from one pivot to the other; the sett is mirrored
 * about each pivot, as nearly every tartan is. These are the traditional
 * counts, rounded.
 */
const SETTS: Record<string, Array<[string, number]>> = {
  black_watch: [['B', 22], ['K', 2], ['B', 2], ['K', 2], ['B', 2], ['K', 16], ['G', 16], ['K', 2], ['G', 16], ['K', 16], ['B', 16], ['K', 2]],
  royal_stewart: [['R', 72], ['B', 8], ['K', 12], ['Y', 2], ['K', 12], ['W', 2], ['K', 2], ['W', 2], ['K', 12], ['G', 16], ['K', 2], ['R', 8], ['K', 2], ['W', 2]],
  dress_gordon: [['W', 24], ['B', 4], ['W', 4], ['B', 24], ['K', 24], ['G', 24], ['Y', 4], ['G', 24], ['K', 4]],
  gingham: [['W', 12], ['R', 12]],
  madras: [['Y', 10], ['R', 4], ['Az', 14], ['W', 2], ['G', 10], ['R', 8]],
};

function settColours(sett: string): string[] {
  const used = [...new Set((SETTS[sett] ?? SETTS.black_watch).map(([c]) => c))];
  const lum = (c: string) => { const [r, g, b] = TARTAN_COLOURS[c]; return 0.3 * r + 0.59 * g + 0.11 * b; };
  return used.sort((a, b) => lum(a) - lum(b));
}

/** The colour of the stripe `t` threads from a pivot, the sett mirrored at each end. */
function stripeAt(sett: Array<[string, number]>, t: number): string {
  const total = sett.reduce((s, [, n]) => s + n, 0);
  const p = 2 * total;
  let a = ((t % p) + p) % p;
  if (a > total) a = p - a;
  for (const [c, n] of sett) {
    if (a < n) return c;
    a -= n;
  }
  return sett[sett.length - 1][0];
}

export const tartan: PatternSpec = {
  id: 'tartan',
  group: 'Textile',
  label: 'Tartan',
  blurb: 'A tartan sett in a 2/2 twill: each colour carved to its own depth and painted, the darker the deeper.',
  depthFraction: 0.12,
  defaults: { sett: 'black_watch', threadMm: 0.9, twill: 0.6 },
  tile: { repeats: [] },
  fields: [
    { kind: 'choice', key: 'sett', label: 'Sett', options: [
      { value: 'black_watch', label: 'Black Watch' },
      { value: 'royal_stewart', label: 'Royal Stewart' },
      { value: 'dress_gordon', label: 'Dress Gordon' },
      { value: 'madras', label: 'Madras' },
      { value: 'gingham', label: 'Gingham' },
    ] },
    { kind: 'number', key: 'threadMm', label: 'Thread', min: 0.2, max: 10, step: 0.05, unit: 'mm',
      hint: 'One thread\'s width: the whole sett scales with it.' },
    { kind: 'number', key: 'twill', label: 'Twill texture', min: 0, max: 1, step: 0.05,
      hint: 'The diagonal ribs of the weave on top of the colour levels. Zero leaves each colour a flat terrace.' },
  ],
  palette: (h, opts) => {
    const levels = settColours(str(opts, 'sett', 'black_watch'));
    const k = Math.max(0, Math.min(levels.length - 1, Math.round(h * (levels.length - 1))));
    return TARTAN_COLOURS[levels[k]];
  },
  baseRgb: [0.10, 0.14, 0.32],
  build(cols, rows, extent, opts) {
    const settName = str(opts, 'sett', 'black_watch');
    const sett = SETTS[settName] ?? SETTS.black_watch;
    const levels = settColours(settName);
    const thread = Math.max(0.05, num(opts, 'threadMm', 0.9)) / 1000;
    const twill = clamp01(num(opts, 'twill', 0.6));
    const n = levels.length;
    // The ribs must stay well inside half a level, or the colour read back
    // from the height would jump to a neighbour.
    const amp = n > 1 ? (0.4 / (n - 1)) * twill : 0;
    return fillGrid(cols, rows, extent, (x, y) => {
      const tx = x / thread;
      const ty = y / thread;
      const ix = Math.floor(tx);
      const iy = Math.floor(ty);
      // 2/2 twill: the warp shows on two crossings in four, stepping one per row.
      const warpUp = ((((ix + iy) % 4) + 4) % 4) < 2;
      const c = warpUp ? stripeAt(sett, tx) : stripeAt(sett, ty);
      const level = n > 1 ? levels.indexOf(c) / (n - 1) : 1;
      const rib = amp * Math.sin(Math.PI * fract(warpUp ? ty : tx));
      return clamp01(level - amp + rib);
    });
  },
};

// --- Water drop ---------------------------------------------------------------------

export const waterDrop: PatternSpec = {
  id: 'water_drop',
  group: 'Water & terrain',
  label: 'Water Drop',
  blurb: 'Rings spreading from a drop into still water, dying away as they go -- one in the middle, a pair whose rings interfere, or rain.',
  defaults: { placement: 'centre', wavelengthMm: 16, damping: 0.55, jet: 0.6, drops: 7, seed: 1 },
  fields: [
    { kind: 'choice', key: 'placement', label: 'Drops', options: [
      { value: 'centre', label: 'One, in the middle' },
      { value: 'thirds', label: 'One, on a third' },
      { value: 'pair', label: 'Two, side by side' },
      { value: 'triad', label: 'Three, in a triangle' },
      { value: 'rain', label: 'Rain (scattered)' },
    ] },
    { kind: 'number', key: 'wavelengthMm', label: 'Wavelength', min: 3, max: 200, step: 0.5, unit: 'mm',
      hint: 'Crest to crest. Below about four times the cutter diameter the troughs cannot be reached.' },
    { kind: 'number', key: 'damping', label: 'Damping', min: 0, max: 1, step: 0.05,
      hint: 'How quickly the rings die away. Zero carries them undiminished to the edge.' },
    { kind: 'number', key: 'jet', label: 'Splash', min: 0, max: 1, step: 0.05,
      hint: 'The column of water a drop throws up at its centre.' },
    { kind: 'number', key: 'drops', label: 'Raindrops', min: 2, max: 40, step: 1 },
    seedField(),
  ],
  build(cols, rows, extent, opts) {
    const lambda = Math.max(0.5, num(opts, 'wavelengthMm', 16)) / 1000;
    const damping = clamp01(num(opts, 'damping', 0.55));
    const jet = clamp01(num(opts, 'jet', 0.6));
    const placement = str(opts, 'placement', 'centre');
    const { widthM: W, depthM: D } = extent;
    const k = TAU / lambda;
    const half = Math.min(W, D) / 2;
    // The seed is the moment the water is caught at: where in its cycle
    // each drop's rings are, and for rain, where the drops fell.
    const rnd = mulberry32(Math.round(num(opts, 'seed', 1)));
    const drops: Array<{ x: number; y: number; amp: number; reach: number; phase: number }> = [];
    const add = (x: number, y: number, amp = 1, reach = Math.hypot(W, D)) =>
      drops.push({ x, y, amp, reach, phase: rnd() * Math.PI * 0.6 });
    if (placement === 'thirds') add(W / 3, D / 3);
    else if (placement === 'pair') { add(W * 0.35, D / 2); add(W * 0.65, D / 2); }
    else if (placement === 'triad') {
      for (let i = 0; i < 3; i++) {
        const a = -Math.PI / 2 + (i * TAU) / 3;
        add(W / 2 + Math.cos(a) * half * 0.38, D / 2 + Math.sin(a) * half * 0.38);
      }
    } else if (placement === 'rain') {
      const n = Math.max(2, Math.round(num(opts, 'drops', 7)));
      // Each drop fell at a different moment, so its rings have spread a
      // different distance.
      for (let i = 0; i < n; i++) add(rnd() * W, rnd() * D, 0.5 + rnd() * 0.5, half * (0.25 + rnd() * 0.75));
    } else add(W / 2, D / 2);

    // Decay length: from "reaches the edge" to "a few rings and gone".
    const decay = damping > 0 ? half * (1.6 - 1.45 * damping) : Infinity;
    const out = fillGrid(cols, rows, extent, (x, y) => {
      let s = 0;
      for (const d of drops) {
        const r = Math.hypot(x - d.x, y - d.y);
        // The rings start a little way out from the splash and fade in, so the
        // centre is the jet rather than a sharp first crest.
        const start = smoothstep(lambda * 0.3, lambda * 1.2, r);
        const front = r < d.reach ? 1 : Math.exp(-(((r - d.reach) / (lambda * 1.5)) ** 2));
        const env = start * front * Math.exp(-r / decay) / Math.sqrt(1 + r / (lambda * 3));
        s += d.amp * env * Math.cos(k * r - d.phase);
        if (jet > 0) s += d.amp * jet * 1.4 * Math.exp(-((r / (lambda * 0.35)) ** 2));
      }
      return s;
    });
    // Still water sits a little below the board top, so the crests are the
    // highest thing and only they reach the surface.
    let max = 0;
    for (let i = 0; i < out.length; i++) max = Math.max(max, Math.abs(out[i]));
    if (max > 0) for (let i = 0; i < out.length; i++) out[i] = clamp01(0.6 + 0.4 * (out[i] / max));
    return out;
  },
};

// --- Ocean ---------------------------------------------------------------------------

export const ocean: PatternSpec = {
  id: 'ocean',
  group: 'Water & terrain',
  label: 'Ocean',
  blurb: 'A wind-driven sea: trochoidal waves with sharp crests and broad troughs, running mostly one way.',
  defaults: { wavelengthMm: 60, windDeg: 20, choppiness: 0.6, spread: 0.35, detail: 0.5, seed: 1 },
  fields: [
    { kind: 'number', key: 'wavelengthMm', label: 'Wavelength', min: 5, max: 500, step: 1, unit: 'mm',
      hint: 'Of the largest waves. Shorter ones ride on them.' },
    { kind: 'number', key: 'windDeg', label: 'Wind', min: -180, max: 180, step: 5, unit: 'deg' },
    { kind: 'number', key: 'choppiness', label: 'Choppiness', min: 0, max: 0.95, step: 0.05,
      hint: 'Sharpens the crests and flattens the troughs. Near 1 the crests are knife edges.' },
    { kind: 'number', key: 'spread', label: 'Spread', min: 0, max: 1, step: 0.05,
      hint: 'How far the waves wander from the wind\'s direction. Zero is an orderly swell.' },
    { kind: 'number', key: 'detail', label: 'Detail', min: 0, max: 1, step: 0.05,
      hint: 'How much of the surface the small waves carry.' },
    seedField(),
  ],
  build(cols, rows, extent, opts) {
    const lambda = Math.max(1, num(opts, 'wavelengthMm', 60)) / 1000;
    const wind = (num(opts, 'windDeg', 20) * Math.PI) / 180;
    const chop = Math.min(0.95, Math.max(0, num(opts, 'choppiness', 0.6)));
    const spread = clamp01(num(opts, 'spread', 0.35));
    const detail = clamp01(num(opts, 'detail', 0.5));
    const rnd = mulberry32(Math.round(num(opts, 'seed', 1)));
    const waves = Array.from({ length: 12 }, (_, i) => {
      const l = lambda * Math.pow(0.72, i);
      // Short waves are blown about far more than the swell, and break less:
      // with them all running one way the sea reads as scratches.
      const wander = i === 0 ? spread * 0.3 : Math.min(1, spread * 0.6 + 0.25 + i * 0.04);
      const dir = wind + (rnd() - 0.5) * Math.PI * wander;
      return {
        k: TAU / l, cx: Math.cos(dir), cy: Math.sin(dir), phase: rnd() * TAU,
        amp: Math.pow(0.6, i) * (i === 0 ? 1 : 0.5 + detail), q: chop * (i === 0 ? 1 : 0.35),
      };
    });
    return normaliseGrid(fillGrid(cols, rows, extent, (x, y) => {
      let h = 0;
      for (const w of waves) {
        // A Gerstner (trochoidal) wave: a point at parameter a sits at
        // X = a - q sin a, height cos a. Solve for a at this X by Newton.
        const X = (x * w.cx + y * w.cy) * w.k + w.phase;
        let a = X;
        for (let it = 0; it < 4; it++) a -= (a - w.q * Math.sin(a) - X) / (1 - w.q * Math.cos(a));
        h += w.amp * Math.cos(a);
      }
      return h;
    }));
  },
};

// --- Fractal landscape ------------------------------------------------------------------

/** Ridged multifractal: sharp ridges where plain noise has smooth hills. */
function ridged(x: number, y: number, seed: number, octaves: number, gain: number): number {
  let sum = 0;
  let amp = 0.5;
  let weight = 1;
  let norm = 0;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(valueNoise2D(x * f, y * f, seed + i * 977) * 2 - 1);
    n *= n;
    n *= weight;
    weight = clamp01(n * 2);
    sum += n * amp;
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

/** Droplet hydraulic erosion, in place, on a grid of heights in cell units. */
function erode(h: Float32Array, cols: number, rows: number, droplets: number, seed: number): void {
  const rnd = mulberry32(seed ^ 0x2f6b);
  const at = (x: number, y: number) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const i = iy * cols + ix;
    const a = h[i], b = h[i + 1], c = h[i + cols], d = h[i + cols + 1];
    return {
      i, fx, fy,
      height: a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy,
      gx: (b - a) * (1 - fy) + (d - c) * fy,
      gy: (c - a) * (1 - fx) + (d - b) * fx,
    };
  };
  const deposit = (s: ReturnType<typeof at>, amount: number) => {
    h[s.i] += amount * (1 - s.fx) * (1 - s.fy);
    h[s.i + 1] += amount * s.fx * (1 - s.fy);
    h[s.i + cols] += amount * (1 - s.fx) * s.fy;
    h[s.i + cols + 1] += amount * s.fx * s.fy;
  };
  for (let n = 0; n < droplets; n++) {
    let x = rnd() * (cols - 2);
    let y = rnd() * (rows - 2);
    let dx = 0, dy = 0, speed = 1, water = 1, sediment = 0;
    for (let step = 0; step < 40; step++) {
      const s = at(x, y);
      dx = dx * 0.1 - s.gx * 0.9;
      dy = dy * 0.1 - s.gy * 0.9;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) break;
      dx /= len; dy /= len;
      x += dx; y += dy;
      if (x < 0 || y < 0 || x >= cols - 1 || y >= rows - 1) break;
      const dh = at(x, y).height - s.height;
      const capacity = Math.max(-dh * speed * water * 4, 0.01);
      if (sediment > capacity || dh > 0) {
        const amount = dh > 0 ? Math.min(dh, sediment) : (sediment - capacity) * 0.3;
        sediment -= amount;
        deposit(s, amount);
      } else {
        const amount = Math.min((capacity - sediment) * 0.3, -dh);
        sediment += amount;
        deposit(s, -amount);
      }
      speed = Math.sqrt(Math.max(0, speed * speed + dh * -4));
      water *= 0.98;
    }
  }
}

/** One pass of a 3x3 box blur, in place. */
function smooth3(g: Float32Array, cols: number, rows: number): void {
  const src = g.slice();
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      let s = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) s += src[(r + dr) * cols + c + dc];
      g[r * cols + c] = s / 9;
    }
  }
}

export const landscape: PatternSpec = {
  id: 'landscape',
  group: 'Water & terrain',
  label: 'Fractal Landscape',
  blurb: 'Fractal terrain -- rolling hills, ridged mountains, mesas or an island -- with rivers cut by simulated rain, and a flat sea.',
  depthFraction: 0.45,
  defaults: {
    style: 'mountains', featureSizeMm: 140, roughness: 0.5, erosion: 0.5, terraces: 0, seaLevel: 0.12,
    edges: 'open', seed: 3,
  },
  fields: [
    { kind: 'choice', key: 'style', label: 'Terrain', options: [
      { value: 'hills', label: 'Rolling hills' },
      { value: 'mountains', label: 'Ridged mountains' },
      { value: 'mesas', label: 'Mesas (terraced)' },
      { value: 'dunes', label: 'Dunes' },
    ] },
    { kind: 'number', key: 'featureSizeMm', label: 'Feature size', min: 10, max: 2000, step: 5, unit: 'mm',
      hint: 'Distance between the largest peaks.' },
    { kind: 'number', key: 'roughness', label: 'Roughness', min: 0.2, max: 0.8, step: 0.05,
      hint: 'How much of the height the fine detail carries.' },
    { kind: 'number', key: 'erosion', label: 'Erosion', min: 0, max: 1, step: 0.05,
      hint: 'Simulated rain carving valleys and laying down fans. Slower the higher it is set.' },
    { kind: 'number', key: 'terraces', label: 'Terraces', min: 0, max: 40, step: 1,
      hint: 'Steps the land into flat levels, like rice terraces or a contour model. Zero is smooth.' },
    { kind: 'number', key: 'seaLevel', label: 'Sea level', min: 0, max: 0.8, step: 0.02,
      hint: 'Everything below it is cut flat, as water.' },
    { kind: 'choice', key: 'edges', label: 'Edges', options: [
      { value: 'open', label: 'Run off the board' },
      { value: 'island', label: 'Island (falls to the sea)' },
      { value: 'valley', label: 'Valley (rises to the edges)' },
    ] },
    seedField(),
  ],
  baseRgb: [0.45, 0.55, 0.32],
  palette: (h, opts) => {
    const sea = clamp01(num(opts, 'seaLevel', 0.12));
    if (h <= sea + 0.004) return [0.22, 0.42, 0.62];
    const t = (h - sea) / Math.max(1e-6, 1 - sea);
    if (t < 0.05) return mix([0.80, 0.74, 0.52], [0.40, 0.58, 0.30], t / 0.05);
    if (t < 0.45) return mix([0.40, 0.58, 0.30], [0.30, 0.45, 0.22], (t - 0.05) / 0.4);
    if (t < 0.75) return mix([0.30, 0.45, 0.22], [0.52, 0.42, 0.32], (t - 0.45) / 0.3);
    if (t < 0.9) return mix([0.52, 0.42, 0.32], [0.62, 0.60, 0.58], (t - 0.75) / 0.15);
    return mix([0.62, 0.60, 0.58], [0.96, 0.96, 0.97], (t - 0.9) / 0.1);
  },
  build(cols, rows, extent, opts) {
    const style = str(opts, 'style', 'mountains');
    const size = Math.max(1, num(opts, 'featureSizeMm', 140)) / 1000;
    const gain = Math.min(0.8, Math.max(0.2, num(opts, 'roughness', 0.5)));
    const erosion = clamp01(num(opts, 'erosion', 0.5));
    const terraces = Math.max(0, Math.round(num(opts, 'terraces', 0)));
    const sea = clamp01(num(opts, 'seaLevel', 0.12));
    const edges = str(opts, 'edges', 'open');
    const seed = Math.round(num(opts, 'seed', 3));
    const cell = cols > 1 ? extent.widthM / (cols - 1) : extent.widthM;
    // Octaves down to about two cells: finer than that cannot be cut or seen.
    const octaves = Math.max(2, Math.min(9, Math.ceil(Math.log2(size / Math.max(cell, 1e-6) / 2))));
    const { widthM: W, depthM: D } = extent;

    const g = fillGrid(cols, rows, extent, (x, y) => {
      // Domain warp: bends the land so ridges and valleys meander.
      const wx = (fbm(x / size + 3.1, y / size, seed + 11, 3) - 0.5) * 0.8;
      const wy = (fbm(x / size, y / size + 7.7, seed + 23, 3) - 0.5) * 0.8;
      const u = x / size + wx;
      const v = y / size + wy;
      let h: number;
      if (style === 'mountains') h = ridged(u, v, seed, octaves, gain) * 0.8 + fbm(u, v, seed + 5, 2) * 0.2;
      else if (style === 'dunes') {
        const ridge = 1 - Math.abs(Math.sin((u * 1.6 + fbm(u * 0.5, v * 0.5, seed, 2) * 2.5) * Math.PI));
        h = Math.pow(ridge, 1.6) * 0.75 + fbm(u, v, seed + 9, octaves, gain) * 0.25;
      } else {
        h = fbm(u, v, seed, octaves, gain);
        if (style === 'mesas') h = smoothstep(0.42, 0.5, h) * 0.55 + smoothstep(0.58, 0.64, h) * 0.45;
      }
      if (edges !== 'open') {
        const nx = (x / W) * 2 - 1;
        const ny = (y / D) * 2 - 1;
        // A coastline, not a circle: the radius wanders with the noise.
        const wobble = 0.75 + 0.5 * fbm(x / size * 0.7 + 9.3, y / size * 0.7, seed + 41, 3);
        const r = Math.min(1, Math.sqrt((nx * nx + ny * ny) / 2) * 1.25 * wobble);
        h = edges === 'island' ? h * (1 - smoothstep(0.45, 1, r)) : h * 0.6 + 0.4 * smoothstep(0.3, 1, r);
      }
      return h;
    });
    normaliseGrid(g);
    if (erosion > 0 && cols > 8 && rows > 8) {
      // Heights in cell units, so the droplets feel real slopes.
      const scale = Math.min(cols, rows) * 0.18;
      for (let i = 0; i < g.length; i++) g[i] *= scale;
      erode(g, cols, rows, Math.round(cols * rows * 0.6 * erosion), seed);
      // Droplets leave single-cell pits where they stop; one light pass of
      // smoothing takes those out without touching the valleys.
      smooth3(g, cols, rows);
      normaliseGrid(g);
    }
    for (let i = 0; i < g.length; i++) {
      let h = g[i];
      if (terraces > 0) {
        const s = h * terraces;
        const f = s - Math.floor(s);
        // A level tread and a short riser, rather than a pure staircase.
        h = (Math.floor(s) + smoothstep(0.75, 1, f)) / terraces;
      }
      g[i] = h <= sea ? sea : h;
    }
    return normaliseGrid(g);
  },
};

// --- Cobblestone ----------------------------------------------------------------------

export const cobblestone: PatternSpec = {
  id: 'cobblestone',
  group: 'Nature',
  label: 'Cobblestones',
  blurb: 'Rounded stones set in sunk joints: random cobbles, river pebbles, or setts laid in courses.',
  defaults: { layout: 'cobbles', stoneMm: 30, jointMm: 3, dome: 0.6, jitter: 0.5, seed: 1 },
  fields: [
    { kind: 'choice', key: 'layout', label: 'Layout', options: [
      { value: 'cobbles', label: 'Cobbles' },
      { value: 'pebbles', label: 'Pebbles (rounder, looser)' },
      { value: 'setts', label: 'Setts in courses' },
    ] },
    { kind: 'number', key: 'stoneMm', label: 'Stone size', min: 3, max: 300, step: 1, unit: 'mm' },
    { kind: 'number', key: 'jointMm', label: 'Joint', min: 0.5, max: 40, step: 0.5, unit: 'mm' },
    { kind: 'number', key: 'dome', label: 'Doming', min: 0, max: 1, step: 0.05,
      hint: 'How round each stone\'s top is. Zero is flat-topped.' },
    { kind: 'number', key: 'jitter', label: 'Variation', min: 0, max: 1, step: 0.05,
      hint: 'Differences in each stone\'s height.' },
    seedField(),
  ],
  build(cols, rows, extent, opts) {
    const layout = str(opts, 'layout', 'cobbles');
    const s = Math.max(1, num(opts, 'stoneMm', 30)) / 1000;
    const joint = Math.max(0.2, num(opts, 'jointMm', 3)) / 1000;
    const dome = clamp01(num(opts, 'dome', 0.6));
    const jitter = clamp01(num(opts, 'jitter', 0.5));
    const seed = Math.round(num(opts, 'seed', 1));
    const setts = layout === 'setts';
    const pebbles = layout === 'pebbles';
    const scatter = setts ? 0.12 : pebbles ? 0.9 : 0.7;

    const site = (i: number, j: number): [number, number] => {
      const off = setts && j % 2 !== 0 ? 0.5 : 0;
      return [
        (i + off + 0.5 + (hash2D(i, j, seed) - 0.5) * scatter) * s * (setts ? 1.6 : 1),
        (j + 0.5 + (hash2D(i, j, seed + 99) - 0.5) * scatter) * s,
      ];
    };
    const sx = setts ? s * 1.6 : s;

    return fillGrid(cols, rows, extent, (x, y) => {
      const ci = Math.floor(x / sx);
      const cj = Math.floor(y / s);
      let d1 = Infinity, d2 = Infinity, id: [number, number] = [0, 0];
      for (let j = cj - 2; j <= cj + 2; j++) {
        for (let i = ci - 2; i <= ci + 2; i++) {
          const p = site(i, j);
          // Setts are squarer: measure them in a stretched, near-Chebyshev way.
          const dx = (x - p[0]) / (setts ? 1.6 : 1);
          const dy = y - p[1];
          const d = setts ? Math.pow(Math.pow(Math.abs(dx), 4) + Math.pow(Math.abs(dy), 4), 0.25) : Math.hypot(dx, dy);
          if (d < d1) { d2 = d1; d1 = d; id = [i, j]; }
          else if (d < d2) d2 = d;
        }
      }
      // Distance to the joint between this stone and its nearest neighbour.
      const edge = (d2 - d1) / 2;
      const hj = joint / 2;
      if (edge < hj) return 0;
      const inner = (edge - hj) / (s * (pebbles ? 0.3 : 0.4));
      const roundTop = Math.sqrt(Math.min(1, inner * (pebbles ? 1.4 : 1.1)) * (2 - Math.min(1, inner)));
      const top = 1 - jitter * 0.35 * hash2D(id[0], id[1], seed + 7);
      return clamp01((0.35 + 0.65 * (dome * roundTop + (1 - dome) * Math.min(1, inner * 4))) * top);
    });
  },
};

export const NATURAL_PATTERNS: PatternSpec[] = [weave, tartan, waterDrop, ocean, landscape, cobblestone];

/** Exposed for tests: which colour a tartan height paints as. */
export function tartanLevels(opts: PatternOptions): string[] {
  return settColours(str(opts, 'sett', 'black_watch'));
}
