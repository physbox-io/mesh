// ---------------------------------------------------------------------------
// Carved ornament: the lotus mandala and Thai tiles.
//
// These are built from a few carved primitives -- a lotus petal, a bead, a
// seed pod, a boss -- placed in polar rings about a centre. Each primitive
// returns the height of the carving where it covers the point, or -1 where it
// does not, and a scene is the highest of whatever covers each point. That is
// how layered petals work in a real carving too: the inner ring is cut
// standing above the outer one, so its petals hide the outer ones' bases and
// only their tips show between them.
//
// Heights are 0..1 with 0 the sunk background. Every petal carries its own
// modelling (a domed body, a carved inner outline, a raised vein) so the
// relief reads under raking light rather than as flat cut-outs.
// ---------------------------------------------------------------------------

import { clamp01, fract } from './patternNoise';
import { fillGrid, num, smoothstep, str, type PatternSpec } from './patternKit';

const TAU = Math.PI * 2;

/** Signed angle from `a` to `b`, in -PI..PI. */
const angleBetween = (a: number, b: number): number => {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
};

export type PetalStyle = 'lotus' | 'round' | 'flame';

/**
 * The petal's half-width along its length, as a share of its widest, for
 * `u` 0 at the base and 1 at the tip.
 *
 * A lotus petal is broad and rounded at the shoulder and draws in to a point
 * with a slight hollow either side -- an ogee. `round` is the plain rounded
 * petal of a daisy or a marigold; `flame` is the long, flicking tip of a Thai
 * kranok.
 */
function petalWidth(u: number, style: PetalStyle): number {
  if (u <= 0 || u >= 1) return 0;
  if (style === 'round') return Math.sqrt(Math.sin(Math.PI * Math.pow(u, 0.85)));
  // Broad, rounded shoulder low down...
  const body = Math.pow(Math.sin(Math.PI * Math.min(1, Math.pow(u, style === 'flame' ? 0.45 : 0.55) / 1)), 0.6);
  // ...then hollow sides drawing in to a long point: (1-u)^p with p > 1 is
  // concave, which is the ogee. A flame draws in later and harder.
  const start = style === 'flame' ? 0.6 : 0.45;
  const tip = u < start ? 1 : Math.pow((1 - u) / (1 - start), style === 'flame' ? 1.6 : 1.3);
  return body * tip;
}

export interface PetalRing {
  /** Petals round the circle. */
  n: number;
  /** Turn, in petals: 0.5 puts this ring's petals between the last one's. */
  offset: number;
  /** Where the petals start and where their tips reach, as radii. */
  rBase: number;
  rTip: number;
  /** Widest half-width, as a share of the half-gap between petal axes. 1 touches. */
  width: number;
  /** The ring's highest point. */
  top: number;
  style: PetalStyle;
  /** Carve an inner outline: 0 none, 1 single, 2 double. */
  outline: number;
  vein: boolean;
  /**
   * Half the carved line's width, in the ring's own units. Left out, it is a
   * share of the petal; set, it is what the finishing cutter can get into --
   * a line narrower than the ball nose comes out as a faint scratch or not
   * at all. Never more than a sixth of the petal, so a line cannot eat it.
   */
  lineHalf?: number;
}

/** The carved height of a ring of petals at polar (r, th), or -1 where none is. */
export function petalRingAt(r: number, th: number, ring: PetalRing): number {
  if (r < ring.rBase || r > ring.rTip) return -1;
  const len = ring.rTip - ring.rBase;
  const u = (r - ring.rBase) / len;
  const step = TAU / ring.n;
  const k = Math.round(th / step - ring.offset);
  const axis = (k + ring.offset) * step;
  // Arc length across the petal, at this radius.
  const q = Math.abs(angleBetween(axis, th)) * r;
  // Half the gap between petal axes at the petal's widest radius.
  const maxHalf = (step / 2) * (ring.rBase + len * 0.45) * ring.width;
  const hw = petalWidth(u, ring.style) * maxHalf;
  if (q >= hw) return -1;
  const m = q / Math.max(1e-9, hw); // 0 on the axis, 1 at the edge

  // A domed body that rolls over at its edge, and drops towards its base
  // where it tucks under the ring inside it.
  let h = Math.sqrt(Math.max(0, 1 - m * m * m)) * (0.55 + 0.45 * smoothstep(0, 0.35, u));
  // A carved inner outline: the same petal again, smaller and set back from
  // the tip, cut as a shallow V.
  const line = Math.max(1e-6, Math.min(ring.lineHalf ?? maxHalf * 0.05, maxHalf / 6));
  for (let o = 0; o < ring.outline; o++) {
    const s = 0.72 - o * 0.2;
    const uIn = u / (0.88 - o * 0.12);
    if (uIn < 1) {
      const hwIn = petalWidth(uIn, ring.style) * maxHalf * s;
      const d = Math.abs(q - hwIn);
      if (d < line) h -= 0.26 * (1 - d / line);
    }
    // Close the outline across its tip as well.
    const tipD = Math.abs(uIn - 1) * len * (0.88 - o * 0.12);
    if (uIn >= 0.9 && uIn < 1.06 && q < maxHalf * 0.3 && tipD < line) h -= 0.26 * (1 - tipD / line);
  }
  if (ring.vein) {
    const w = maxHalf * 0.07;
    if (q < w && u > 0.15 && u < 0.85) h += 0.1 * (1 - q / w) * Math.sin(Math.PI * (u - 0.15) / 0.7);
  }
  return ring.top * (0.45 + 0.55 * clamp01(h));
}

/** A ring of beads at radius `rc`, each `br` in radius, at height `top`. -1 where none. */
export function beadRingAt(r: number, th: number, rc: number, br: number, top: number): number {
  if (Math.abs(r - rc) > br) return -1;
  const n = Math.max(6, Math.round((TAU * rc) / (br * 2.3)));
  const step = TAU / n;
  const k = Math.round(th / step);
  const bx = rc * Math.cos(k * step);
  const by = rc * Math.sin(k * step);
  const d = Math.hypot(r * Math.cos(th) - bx, r * Math.sin(th) - by);
  if (d >= br) return -1;
  return top * (0.55 + 0.45 * Math.sqrt(1 - (d / br) ** 2));
}

/** A plain round band (a fillet or a rope's core) between two radii. */
export function bandAt(r: number, r0: number, r1: number, top: number): number {
  if (r < r0 || r > r1) return -1;
  const t = ((r - r0) / (r1 - r0)) * 2 - 1;
  return top * (0.7 + 0.3 * Math.sqrt(Math.max(0, 1 - t * t)));
}

/** A twisted rope band: diagonal strands round the circle. */
export function ropeAt(r: number, th: number, r0: number, r1: number, top: number): number {
  if (r < r0 || r > r1) return -1;
  const w = r1 - r0;
  const t = (r - r0) / w;
  const n = Math.max(8, Math.round((TAU * (r0 + r1)) / 2 / (w * 1.2)));
  const s = fract((th / TAU) * n + t * 0.9);
  const strand = Math.sin(Math.PI * s);
  return top * (0.55 + 0.45 * strand * Math.sqrt(Math.max(0, 1 - (2 * t - 1) ** 2)));
}

/** A lotus seed pod seen from above: a flat-topped boss studded with seeds. */
export function seedPodAt(r: number, th: number, R: number, top: number): number {
  if (r > R) return -1;
  let h = 0.82 + 0.18 * Math.sqrt(Math.max(0, 1 - (r / R) ** 2));
  // A rim, then seeds in one centre and one or two rings.
  if (r > R * 0.86) h = 0.9 + 0.1 * Math.sin(((r - R * 0.86) / (R * 0.14)) * Math.PI);
  const x = r * Math.cos(th);
  const y = r * Math.sin(th);
  const seed = R * 0.13;
  const spots: Array<[number, number]> = [[0, 0]];
  for (const [rr, n] of [[R * 0.38, 6], [R * 0.68, 11]] as Array<[number, number]>) {
    for (let i = 0; i < n; i++) spots.push([rr * Math.cos((i * TAU) / n), rr * Math.sin((i * TAU) / n)]);
  }
  for (const [sx, sy] of spots) {
    const d = Math.hypot(x - sx, y - sy);
    if (d < seed) h = Math.max(h, 0.85 + 0.15 * Math.sqrt(1 - (d / seed) ** 2)) + 0.08 * (1 - d / seed);
    else if (d < seed * 1.35) h -= 0.12 * (1 - (d - seed) / (seed * 0.35));
  }
  return top * clamp01(h);
}

/** A domed boss. */
export function bossAt(r: number, R: number, top: number): number {
  if (r > R) return -1;
  return top * (0.6 + 0.4 * Math.sqrt(1 - (r / R) ** 2));
}

// --- Lotus mandala -------------------------------------------------------------

export interface MandalaOptions {
  rings: number;
  petals: number;
  /** Each ring out has this many times the petals of the one inside it. */
  growth: number;
  style: PetalStyle;
  outline: number;
  vein: boolean;
  centre: 'pod' | 'flower' | 'boss';
  /** Share of the radius the centre takes. */
  centreFrac: number;
  band: 'beads' | 'rope' | 'fillet' | 'none';
  /** An outer ring of small pointed petals, like a sun's corona. */
  corona: boolean;
  /** Half a carved line's width, in the mandala's units (see PetalRing). */
  lineHalf?: number;
}

/** The mandala's height at polar (r, th) in a circle of radius R; -1 off it. */
export function mandalaAt(r: number, th: number, R: number, o: MandalaOptions): number {
  let best = -1;
  const take = (h: number) => { if (h > best) best = h; };
  const bandW = o.band === 'none' ? 0 : R * 0.045;
  const coronaW = o.corona ? R * 0.12 : 0;
  // The rings of petals fill the space between the centre and the bands.
  const c = R * o.centreFrac;
  const outerTip = R - bandW * 2.2 - coronaW;
  const rings = Math.max(1, o.rings);
  const span = outerTip - c;

  // Centre.
  if (o.centre === 'pod') take(seedPodAt(r, th, c, 1));
  else if (o.centre === 'boss') take(bossAt(r, c, 1));
  else {
    take(bossAt(r, c * 0.38, 1));
    take(petalRingAt(r, th, {
      n: 8, offset: 0, rBase: c * 0.2, rTip: c, width: 0.95, top: 0.95,
      style: 'round', outline: 0, vein: true,
    }));
  }
  if (o.band !== 'none' && c > 0) take(beadRingAt(r, th, c + bandW * 0.5, bandW * 0.5, 0.88));

  // Rings of petals, inner ones standing higher.
  let n = Math.max(3, Math.round(o.petals));
  for (let k = 0; k < rings; k++) {
    const tip = c + span * ((k + 1) / rings);
    const top = 0.92 - (0.42 * k) / Math.max(1, rings);
    // Petals spring from just inside the ring before, so their bases tuck
    // under it.
    const base = k === 0 ? c * 0.6 : c + span * ((k - 0.75) / rings);
    take(petalRingAt(r, th, {
      n, offset: k % 2 === 0 ? 0 : 0.5, rBase: base, rTip: tip, width: 1.0, top,
      style: o.style, outline: o.outline, vein: o.vein, lineHalf: o.lineHalf,
    }));
    // A second layer behind each ring, between its petals, so no background
    // shows through the notches -- the way a real lotus is packed.
    take(petalRingAt(r, th, {
      n, offset: (k % 2 === 0 ? 0 : 0.5) + 0.5, rBase: base, rTip: tip - span / rings * 0.3, width: 0.6,
      top: top * 0.82, style: o.style, outline: Math.min(1, o.outline), vein: false, lineHalf: o.lineHalf,
    }));
    n = Math.max(3, Math.round(n * o.growth));
  }

  if (o.corona) {
    take(petalRingAt(r, th, {
      n: Math.min(48, Math.max(16, n * 2)), offset: 0.5, rBase: outerTip - R * 0.02, rTip: outerTip + coronaW, width: 0.9,
      top: 0.42, style: 'flame', outline: 0, vein: false,
    }));
  }
  // The border bands that close the mandala.
  if (o.band !== 'none') {
    const r0 = R - bandW * 2.2;
    if (o.band === 'beads') {
      take(bandAt(r, r0, r0 + bandW * 0.5, 0.5));
      take(beadRingAt(r, th, r0 + bandW * 1.15, bandW * 0.55, 0.55));
      take(bandAt(r, R - bandW * 0.5, R, 0.5));
    } else if (o.band === 'rope') {
      take(ropeAt(r, th, r0, R, 0.55));
    } else {
      take(bandAt(r, r0, R, 0.5));
    }
  }
  return best;
}

const ornamentStyleField = {
  kind: 'choice' as const, key: 'petalStyle', label: 'Petal', options: [
    { value: 'lotus', label: 'Lotus (pointed ogee)' },
    { value: 'round', label: 'Rounded' },
    { value: 'flame', label: 'Flame (Thai kranok tip)' },
  ],
};

const outlineField = {
  kind: 'choice' as const, key: 'outline', label: 'Petal outline', options: [
    { value: '0', label: 'None' },
    { value: '1', label: 'Single carved line' },
    { value: '2', label: 'Double carved line' },
  ],
  hint: 'The petal\'s shape carved again inside it: what makes a petal read as carved rather than cut out.',
};

const lineField = {
  kind: 'number' as const, key: 'lineMm', label: 'Carved line width', min: 0.5, max: 12, step: 0.1, unit: 'mm',
  hint: 'Width of the outlines carved inside the petals. Keep it at least the finishing bit\'s diameter -- 3.2 mm for a 1/8" ball nose -- or the lines come out faint.',
};

export const lotusMandala: PatternSpec = {
  id: 'lotus_mandala',
  group: 'Ornament',
  label: 'Lotus Mandala',
  blurb: 'Layered rings of lotus petals round a seed pod, closed by a beaded border: a carved relief sized to the stock.',
  depthFraction: 0.4,
  defaults: {
    rings: 3, petals: 10, growth: 1, petalStyle: 'lotus', outline: '2', lineMm: 3.2, vein: 'yes', centre: 'pod',
    centrePct: 18, band: 'beads', corona: 'yes', background: 'sunk', corners: 'quarter',
  },
  fields: [
    { kind: 'number', key: 'rings', label: 'Petal rings', min: 1, max: 6, step: 1 },
    { kind: 'number', key: 'petals', label: 'Petals, first ring', min: 3, max: 32, step: 1 },
    { kind: 'choice', key: 'growth', label: 'Each ring out', options: [
      { value: '1', label: 'Same number of petals' },
      { value: '1.5', label: 'Half as many again' },
      { value: '2', label: 'Twice as many' },
    ] },
    ornamentStyleField,
    outlineField,
    lineField,
    { kind: 'choice', key: 'vein', label: 'Centre vein', options: [
      { value: 'yes', label: 'Raised vein' },
      { value: 'no', label: 'None' },
    ] },
    { kind: 'choice', key: 'centre', label: 'Centre', options: [
      { value: 'pod', label: 'Lotus seed pod' },
      { value: 'flower', label: 'Small flower' },
      { value: 'boss', label: 'Plain boss' },
    ] },
    { kind: 'number', key: 'centrePct', label: 'Centre size', min: 5, max: 45, step: 1, unit: '%' },
    { kind: 'choice', key: 'band', label: 'Border', options: [
      { value: 'beads', label: 'Beads between fillets' },
      { value: 'rope', label: 'Rope' },
      { value: 'fillet', label: 'Plain band' },
      { value: 'none', label: 'None' },
    ] },
    { kind: 'choice', key: 'corona', label: 'Outer flames', options: [
      { value: 'yes', label: 'A ring of small flame petals' },
      { value: 'no', label: 'None' },
    ] },
    { kind: 'choice', key: 'background', label: 'Background', options: [
      { value: 'sunk', label: 'Sunk (the mandala stands proud)' },
      { value: 'board', label: 'Board top (carved into a round recess)' },
    ] },
    { kind: 'choice', key: 'corners', label: 'Corners', options: [
      { value: 'quarter', label: 'Quarter rosettes' },
      { value: 'plain', label: 'Plain' },
    ], hint: 'Fills the corners a circle leaves on a rectangular board.' },
  ],
  build(cols, rows, extent, opts) {
    const o: MandalaOptions = {
      rings: Math.round(num(opts, 'rings', 3)),
      petals: Math.round(num(opts, 'petals', 8)),
      growth: num(opts, 'growth', 2),
      style: str(opts, 'petalStyle', 'lotus') as PetalStyle,
      outline: Math.round(num(opts, 'outline', 2)),
      vein: str(opts, 'vein', 'yes') === 'yes',
      centre: str(opts, 'centre', 'pod') as MandalaOptions['centre'],
      centreFrac: clamp01(num(opts, 'centrePct', 18) / 100),
      band: str(opts, 'band', 'beads') as MandalaOptions['band'],
      corona: str(opts, 'corona', 'yes') === 'yes',
      lineHalf: Math.max(0.1, num(opts, 'lineMm', 3.2)) / 2000,
    };
    const sunk = str(opts, 'background', 'sunk') === 'sunk';
    const corners = str(opts, 'corners', 'quarter') === 'quarter';
    const cx = extent.widthM / 2;
    const cy = extent.depthM / 2;
    const R = Math.min(cx, cy) * 0.98;
    const bg = sunk ? 0 : 1;
    // A quarter rosette in each corner: a small fan of petals about the
    // corner itself, as big as the corner allows.
    const cornerR = Math.max(0, Math.hypot(cx, cy) - R) * 0.75;
    const cornerRing: PetalRing = {
      n: 16, offset: 0, rBase: cornerR * 0.25, rTip: cornerR, width: 0.95, top: 0.6,
      style: o.style, outline: Math.min(1, o.outline), vein: false, lineHalf: o.lineHalf,
    };
    return fillGrid(cols, rows, extent, (x, y) => {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.hypot(dx, dy);
      const th = Math.atan2(dy, dx);
      const h = mandalaAt(r, th, R, o);
      if (h >= 0) return sunk ? h : Math.max(h, 0.05);
      if (corners && cornerR > R * 0.08) {
        const kx = x < cx ? 0 : extent.widthM;
        const ky = y < cy ? 0 : extent.depthM;
        const cr = Math.hypot(x - kx, y - ky);
        const ch = Math.max(bossAt(cr, cornerR * 0.22, 0.6), petalRingAt(cr, Math.atan2(y - ky, x - kx), cornerRing));
        if (ch >= 0) return ch;
      }
      // Board-top background: a little fillet down into the recess.
      return sunk ? bg : r < R * 1.02 ? 0.05 : bg;
    });
  },
};

// --- Thai tiles -----------------------------------------------------------------

/**
 * One Thai tile motif at a point, in tile coordinates: u, v across -1..1.
 * Returns 0..1, the background being 0.
 */
function thaiMotif(motif: string, u: number, v: number, style: PetalStyle, outline: number, lineHalf: number): number {
  const r = Math.hypot(u, v);
  const th = Math.atan2(v, u);
  let best = -1;
  const take = (h: number) => { if (h > best) best = h; };
  switch (motif) {
    case 'lotus':
      take(mandalaAt(r, th, 0.92, {
        rings: 2, petals: 8, growth: 1, style, outline, vein: true, centre: 'pod',
        centreFrac: 0.26, band: 'none', corona: false, lineHalf,
      }));
      break;
    case 'phikun': {
      // Dok phikun: a small star of notched petals, in a ring of beads.
      take(bossAt(r, 0.16, 1));
      take(beadRingAt(r, th, 0.21, 0.045, 0.9));
      take(petalRingAt(r, th, { n: 8, offset: 0, rBase: 0.18, rTip: 0.72, width: 0.75, top: 0.9, style: 'round', outline, vein: true, lineHalf }));
      take(petalRingAt(r, th, { n: 8, offset: 0.5, rBase: 0.22, rTip: 0.58, width: 0.6, top: 0.7, style: 'lotus', outline: 0, vein: false }));
      take(beadRingAt(r, th, 0.84, 0.05, 0.6));
      break;
    }
    case 'diamond': {
      // Kraeng: a diamond lattice cell with a lotus bud at its heart.
      const d = Math.abs(u) + Math.abs(v);
      if (d > 0.82 && d < 0.94) take(0.65);
      take(petalRingAt(r, th, { n: 4, offset: 0, rBase: 0.08, rTip: 0.72, width: 0.7, top: 0.95, style, outline, vein: true, lineHalf }));
      take(petalRingAt(r, th, { n: 4, offset: 0.5, rBase: 0.1, rTip: 0.45, width: 0.65, top: 0.75, style: 'flame', outline: 0, vein: false }));
      take(bossAt(r, 0.13, 1));
      break;
    }
    default: {
      // Pra jam yam: four petals on the axes, four leaves on the diagonals,
      // a beaded boss, all in a ring -- the four-petalled flower that is on
      // half the temple walls in Thailand.
      take(bossAt(r, 0.17, 1));
      take(beadRingAt(r, th, 0.225, 0.042, 0.9));
      take(petalRingAt(r, th, { n: 4, offset: 0, rBase: 0.14, rTip: 0.98, width: 0.78, top: 0.95, style, outline, vein: true, lineHalf }));
      take(petalRingAt(r, th, { n: 4, offset: 0.5, rBase: 0.16, rTip: 0.8, width: 0.62, top: 0.75, style: 'flame', outline: Math.min(1, outline), vein: false, lineHalf }));
      break;
    }
  }
  return best;
}

export const thaiTiles: PatternSpec = {
  id: 'thai_tiles',
  group: 'Ornament',
  label: 'Thai Tiles',
  blurb: 'The board divided into whole tiles, each a carved Thai flower in a raised border: pra jam yam, lotus, dok phikun, or a diamond lattice.',
  depthFraction: 0.35,
  defaults: {
    tileMm: 100, motif: 'prajamyam', alternate: 'none', petalStyle: 'lotus', outline: '1', lineMm: 3.2,
    borderMm: 4, gutterMm: 1.5, corners: 'quarter',
  },
  fields: [
    { kind: 'number', key: 'tileMm', label: 'Tile size', min: 20, max: 600, step: 1, unit: 'mm',
      hint: 'Rounded so a whole number of tiles fills the board each way. Set it to the board\'s size for one tile.' },
    { kind: 'choice', key: 'motif', label: 'Motif', options: [
      { value: 'prajamyam', label: 'Pra jam yam (four-petal flower)' },
      { value: 'lotus', label: 'Lotus, from above' },
      { value: 'phikun', label: 'Dok phikun (star flower)' },
      { value: 'diamond', label: 'Kraeng (diamond lattice)' },
    ] },
    { kind: 'choice', key: 'alternate', label: 'Alternate with', options: [
      { value: 'none', label: 'Every tile the same' },
      { value: 'prajamyam', label: 'Pra jam yam' },
      { value: 'lotus', label: 'Lotus' },
      { value: 'phikun', label: 'Dok phikun' },
      { value: 'diamond', label: 'Kraeng' },
    ], hint: 'A second motif on every other tile, like a chequerboard.' },
    ornamentStyleField,
    outlineField,
    lineField,
    { kind: 'number', key: 'borderMm', label: 'Tile border', min: 0, max: 40, step: 0.5, unit: 'mm',
      hint: 'The raised frame round each tile.' },
    { kind: 'number', key: 'gutterMm', label: 'Joint', min: 0, max: 20, step: 0.5, unit: 'mm',
      hint: 'A sunk line between tiles, as if they were laid separately.' },
    { kind: 'choice', key: 'corners', label: 'Tile corners', options: [
      { value: 'quarter', label: 'Quarter flowers (join across tiles)' },
      { value: 'plain', label: 'Plain' },
    ] },
  ],
  build(cols, rows, extent, opts) {
    const want = Math.max(5, num(opts, 'tileMm', 100)) / 1000;
    const nx = Math.max(1, Math.round(extent.widthM / want));
    const ny = Math.max(1, Math.round(extent.depthM / want));
    const tw = extent.widthM / nx;
    const th = extent.depthM / ny;
    const motif = str(opts, 'motif', 'prajamyam');
    const alt = str(opts, 'alternate', 'none');
    const style = str(opts, 'petalStyle', 'lotus') as PetalStyle;
    const outline = Math.round(num(opts, 'outline', 1));
    const lineM = Math.max(0.1, num(opts, 'lineMm', 3.2)) / 1000;
    const border = Math.max(0, num(opts, 'borderMm', 4)) / 1000;
    const gutter = Math.max(0, num(opts, 'gutterMm', 1.5)) / 1000;
    const corners = str(opts, 'corners', 'quarter') === 'quarter';
    const half = Math.min(tw, th) / 2;
    const cornerRing: PetalRing = {
      n: 8, offset: 0.5, rBase: 0.06, rTip: 0.42, width: 0.85, top: 0.7, style, outline: 0, vein: false,
    };

    return fillGrid(cols, rows, extent, (x, y) => {
      const i = Math.min(nx - 1, Math.floor(x / tw));
      const j = Math.min(ny - 1, Math.floor(y / th));
      const lx = x - i * tw;
      const ly = y - j * th;
      const edge = Math.min(lx, tw - lx, ly, th - ly);
      if (gutter > 0 && edge < gutter / 2) return clamp01(0.165 * (edge / (gutter / 2)));
      if (border > 0 && edge < gutter / 2 + border) {
        const t = (edge - gutter / 2) / border;
        return 0.62 + 0.18 * Math.sin(Math.PI * t);
      }
      // Tile coordinates, the motif's circle touching the border.
      const inner = half - gutter / 2 - border;
      const u = (lx - tw / 2) / inner;
      const v = (ly - th / 2) / inner;
      const which = alt !== 'none' && (i + j) % 2 === 1 ? alt : motif;
      let h = thaiMotif(which, u, v, style, outline, lineM / 2 / inner);
      if (corners) {
        // A quarter of a flower in each corner, so four tiles make one.
        const ku = lx < tw / 2 ? -tw / 2 / inner : tw / 2 / inner;
        const kv = ly < th / 2 ? -th / 2 / inner : th / 2 / inner;
        const cr = Math.hypot(u - ku, v - kv);
        const ca = Math.atan2(v - kv, u - ku);
        h = Math.max(h, petalRingAt(cr, ca, cornerRing), bossAt(cr, 0.09, 0.75));
      }
      return clamp01(h);
    });
  },
};

export const ORNAMENT_PATTERNS: PatternSpec[] = [lotusMandala, thaiTiles];
