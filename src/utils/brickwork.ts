// Brickwork: any shape laid in brick, course by course, with the count to buy.
//
// The shape is sliced at every course. Each slice is a region; bricks are laid
// along its outline in rings working inward — a leaf along every face, then the
// next leaf behind it — until the region is full. Each ring's outline is split
// into runs at its corners, and the runs on alternate courses go down in the
// other order, so one wall runs through a corner and then the other: the bond
// at corners and stopped ends (and the half-brick lap of stretcher bond) falls
// out of that rather than being drawn per case. A curve is one run, each brick
// laid on the chord.
//
// What fills a course is kept on an occupancy grid. A run lays bricks only
// where its band is free, so a brick is cut where a run meets one already laid,
// and a joint's width is always left between two. A brick with less than half
// of itself over the course below is over an opening: a lintel is listed for
// it, with its bearing either side.
//
// Millimetres throughout; the scene is metres, Z up.

import type { BrickworkSource, SceneGeom, SceneGraph, SceneNode } from '../types/scene';
import type { Point2D } from './laserCutExporter';
import { collectSceneTriangles, contoursAtZ } from './contourSliceExporter';
import { nestingDepths, offsetNestedLoops, pointInPolygon, signedArea2 } from './polygonOffset';
import { DEFAULT_TOY_SIZES, layToyBricks, TOY_HEIGHT_MM, TOY_PITCH_MM, type ToySize } from './toyBricks';

export type BrickStandardId = 'uk' | 'us_modular' | 'eu_nf' | 'au' | 'mini_6' | 'mini_12' | 'toy';

export interface BrickStandard {
  id: BrickStandardId;
  label: string;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  /** The usual joint, mm. */
  jointMm: number;
  /** A scale-model brick, for a shape too small for real ones. */
  miniature?: boolean;
  /** Interlocking studded bricks on an 8 mm grid, in several sizes: see utils/toyBricks.ts. */
  toy?: boolean;
}

export const BRICK_STANDARDS: Record<BrickStandardId, BrickStandard> = {
  uk: { id: 'uk', label: 'UK standard 215 × 102.5 × 65', lengthMm: 215, widthMm: 102.5, heightMm: 65, jointMm: 10 },
  us_modular: { id: 'us_modular', label: 'US modular 7⅝ × 3⅝ × 2¼"', lengthMm: 194, widthMm: 92, heightMm: 57, jointMm: 10 },
  eu_nf: { id: 'eu_nf', label: 'European NF 240 × 115 × 71', lengthMm: 240, widthMm: 115, heightMm: 71, jointMm: 10 },
  au: { id: 'au', label: 'Australian 230 × 110 × 76', lengthMm: 230, widthMm: 110, heightMm: 76, jointMm: 10 },
  mini_6: { id: 'mini_6', label: 'Miniature 1:6 (36 × 17 × 11)', lengthMm: 36, widthMm: 17, heightMm: 11, jointMm: 1.6, miniature: true },
  mini_12: { id: 'mini_12', label: 'Miniature 1:12 (18 × 9 × 6)', lengthMm: 18, widthMm: 8.5, heightMm: 5.5, jointMm: 0.8, miniature: true },
  toy: { id: 'toy', label: 'Toy bricks (8 mm studs)', lengthMm: 2 * TOY_PITCH_MM, widthMm: TOY_PITCH_MM, heightMm: TOY_HEIGHT_MM, jointMm: 0, toy: true },
};

/**
 * 'stretcher': every brick along the wall, each course lapped half a brick.
 * 'stack': every brick along the wall, joints in line (decorative; not bonded).
 * 'english': stretcher courses and header courses in turn.
 * 'flemish': header and stretcher in turn along every course.
 * The two with headers need walls at least a brick long thick.
 */
export type BrickBond = 'stretcher' | 'stack' | 'english' | 'flemish';
export const BRICK_BONDS: { id: BrickBond; label: string }[] = [
  { id: 'stretcher', label: 'Stretcher bond' },
  { id: 'english', label: 'English bond' },
  { id: 'flemish', label: 'Flemish bond' },
  { id: 'stack', label: 'Stack bond' },
];

export interface BrickworkOptions {
  standardId: BrickStandardId;
  bond: BrickBond;
  /** Joint width, mm. Default: the standard's. */
  jointMm?: number;
  /** Extra bricks bought against breakage, percent. */
  wastagePct: number;
  /** Toy bricks: the sizes to build with. Default: all of them. */
  toySizes?: ToySize[];
}

export const DEFAULT_BRICKWORK_OPTIONS: BrickworkOptions = { standardId: 'uk', bond: 'stretcher', wastagePct: 5 };

/** More than this and the scene would be unworkable to draw; brick a wall at a time. */
export const MAX_BRICKS = 20_000;

export interface PlacedBrick {
  course: number;
  /** Centre of its footprint, mm. */
  x: number;
  y: number;
  /** Its bed, mm. */
  z: number;
  /** Direction of its length, radians about Z. */
  angle: number;
  /** Along the face, and into the wall, mm. */
  lengthMm: number;
  depthMm: number;
  header: boolean;
  /** A queen closer: a brick split lengthways, laid as a header beside the corner. */
  closer: boolean;
  /** Shorter than a whole brick along its face. */
  cut: boolean;
}

export interface BrickworkResult {
  standard: BrickStandard;
  bond: BrickBond;
  jointMm: number;
  courses: number;
  modelHeightMm: number;
  builtHeightMm: number;
  bricks: PlacedBrick[];
  /** Whole bricks laid, cut pieces laid, and bricks to buy (cuts paired from whole bricks, plus wastage). */
  whole: number;
  cutPieces: number;
  /** Queen closers (two from a brick). */
  closers: number;
  toBuy: number;
  /** Cut pieces by length, longest first. */
  cuts: { lengthMm: number; count: number }[];
  mortarLitres: number;
  /** 25 kg bags of premixed mortar. */
  mortarBags: number;
  /** Lintels over openings, by length (with bearing both ends). */
  lintels: { lengthMm: number; count: number }[];
  /** Toy bricks: how many of each size. */
  parts?: { size: ToySize; count: number }[];
  warnings: string[];
}

type V2 = Point2D;
const sub = (a: V2, b: V2): V2 => ({ x: a.x - b.x, y: a.y - b.y });
const len = (a: V2) => Math.hypot(a.x, a.y);

/** A stretch of outline with material on its left, by arc length. */
interface Run {
  pts: V2[]; s: number[]; total: number;
  /** A loop with no corner: it can start anywhere. */
  closed?: boolean;
  /** On the shape's outline rather than round a hole in it: the face seen. */
  outer?: boolean;
}

function runAt(run: Run, s: number): V2 {
  const t = Math.max(0, Math.min(run.total, s));
  let i = 1;
  while (i < run.s.length - 1 && run.s[i] < t) i++;
  const a = run.pts[i - 1], b = run.pts[i];
  const seg = run.s[i] - run.s[i - 1] || 1;
  const f = (t - run.s[i - 1]) / seg;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/** A closed loop (material on its left) split into runs at its corners. */
function runsOf(loop: V2[], cornerDeg = 30): Run[] {
  const n = loop.length;
  const corners: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = loop[(i - 1 + n) % n], b = loop[i], c = loop[(i + 1) % n];
    const d1 = sub(b, a), d2 = sub(c, b);
    const turn = Math.abs(Math.atan2(d1.x * d2.y - d1.y * d2.x, d1.x * d2.x + d1.y * d2.y));
    if (turn > (cornerDeg * Math.PI) / 180) corners.push(i);
  }
  // No corner: a curve all the way round, one run from anywhere.
  const starts = corners.length ? corners : [0];
  const runs: Run[] = [];
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = starts.length === 1 ? from + n : starts[(k + 1) % starts.length] + (k + 1 === starts.length ? n : 0);
    const pts: V2[] = [];
    for (let i = from; i <= to; i++) pts.push(loop[i % n]);
    const s = [0];
    for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + len(sub(pts[i], pts[i - 1])));
    if (s[s.length - 1] > 1e-6) runs.push({ pts, s, total: s[s.length - 1], closed: !corners.length });
  }
  return runs;
}

/** A closed run started `by` further round, so a ring of bricks laps the one below. */
function rotateRun(run: Run, by: number): Run {
  const at = ((by % run.total) + run.total) % run.total;
  if (at < 1e-6) return run;
  const pts: V2[] = [runAt(run, at)];
  for (let i = 1; i < run.pts.length; i++) if (run.s[i] > at) pts.push(run.pts[i]);
  for (let i = 1; i < run.pts.length; i++) if (run.s[i] <= at) pts.push(run.pts[i]);
  pts.push(pts[0]);
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + len(sub(pts[i], pts[i - 1])));
  return { pts, s, total: s[s.length - 1], closed: true };
}

/** Which cells of the course are taken. */
class Occupancy {
  readonly cells: Uint8Array;
  constructor(readonly x0: number, readonly y0: number, readonly nx: number, readonly ny: number, readonly cell: number) {
    this.cells = new Uint8Array(nx * ny);
  }
  at(p: V2): boolean {
    const i = Math.floor((p.x - this.x0) / this.cell), j = Math.floor((p.y - this.y0) / this.cell);
    return i >= 0 && j >= 0 && i < this.nx && j < this.ny && this.cells[j * this.nx + i] === 1;
  }
  /** Marks a rectangle: origin `o`, along `u` for `l`, across `n` for `d`, grown by `grow` all round. */
  mark(o: V2, u: V2, n: V2, l: number, d: number, grow: number) {
    const corners = [[-grow, -grow], [l + grow, -grow], [l + grow, d + grow], [-grow, d + grow]]
      .map(([a, b]) => ({ x: o.x + u.x * a + n.x * b, y: o.y + u.y * a + n.y * b }));
    const lo = { x: Math.min(...corners.map((c) => c.x)), y: Math.min(...corners.map((c) => c.y)) };
    const hi = { x: Math.max(...corners.map((c) => c.x)), y: Math.max(...corners.map((c) => c.y)) };
    const i0 = Math.max(0, Math.floor((lo.x - this.x0) / this.cell)), i1 = Math.min(this.nx - 1, Math.floor((hi.x - this.x0) / this.cell));
    const j0 = Math.max(0, Math.floor((lo.y - this.y0) / this.cell)), j1 = Math.min(this.ny - 1, Math.floor((hi.y - this.y0) / this.cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const p = { x: this.x0 + (i + 0.5) * this.cell - o.x, y: this.y0 + (j + 0.5) * this.cell - o.y };
        const a = p.x * u.x + p.y * u.y, b = p.x * n.x + p.y * n.y;
        if (a >= -grow && a <= l + grow && b >= -grow && b <= d + grow) this.cells[j * this.nx + i] = 1;
      }
    }
  }
}

/** The region as material-on-the-left loops, with what decides inside. */
function regionOf(loops: V2[][]): { loops: V2[][]; inside: (p: V2) => boolean } {
  const depths = nestingDepths(loops);
  const oriented = loops.map((l, i) => {
    const ccw = signedArea2(l) > 0;
    const hole = depths[i] % 2 === 1;
    return ccw === !hole ? l : [...l].reverse();
  });
  return {
    loops: oriented,
    inside: (p) => loops.reduce((n, l) => n + (pointInPolygon(p, l) ? 1 : 0), 0) % 2 === 1,
  };
}

/** What goes next along a run: a stretcher or a header. */
function unitsFor(bond: BrickBond, course: number): ('S' | 'H')[] {
  if (bond === 'english') return course % 2 === 1 ? ['H'] : ['S'];
  if (bond === 'flemish') return course % 2 === 1 ? ['S', 'H'] : ['H', 'S'];
  return ['S'];
}

/** The subject: the whole scene, or one body under its ancestors' frames. */
export function subjectScene(scene: SceneGraph, bodyId: string | null): SceneGraph {
  if (!bodyId) return { ...scene, nodes: scene.nodes.filter((n) => !n.simulation) };
  const path = (nodes: SceneNode[]): SceneNode[] | null => {
    for (const n of nodes) {
      if (n.id === bodyId) return [n];
      const below = path(n.children ?? []);
      if (below) return [n, ...below];
    }
    return null;
  };
  const chain = path(scene.nodes);
  if (!chain) throw new Error(`No body '${bodyId}'.`);
  let wrapped = chain[chain.length - 1];
  for (let i = chain.length - 2; i >= 0; i--) wrapped = { ...chain[i], geoms: [], children: [wrapped] };
  return { ...scene, nodes: [wrapped] };
}

/**
 * Whether a shape this size is brickwork in this brick: at least a brick long
 * across and four courses tall (a one-brick pier is real brickwork however
 * small). Below that it refuses, naming the bricks that would do.
 */
export function brickFits(s: BrickStandard, spanMm: number, heightMm: number): boolean {
  return spanMm >= s.lengthMm && heightMm >= 4 * (s.heightMm + s.jointMm) - s.jointMm;
}

/** The shape in toy bricks: every course on the stud grid, counted by size. */
function toyResult(
  std: BrickStandard, tris: number[], solidIds: number[], lo: number[], hi: number[], sizes: ToySize[], warnings: string[],
): BrickworkResult {
  const modelH = hi[2] - lo[2];
  const span = Math.max(hi[0] - lo[0], hi[1] - lo[1]);
  if (span < 2 * TOY_PITCH_MM || modelH < TOY_HEIGHT_MM / 2) {
    throw new Error(`The shape is ${Math.round(span)} mm across and ${Math.round(modelH)} mm tall, too small for toy bricks. Scale it up.`);
  }
  const courses = Math.max(1, Math.round(modelH / TOY_HEIGHT_MM));
  const { bricks, parts } = layToyBricks({
    lo: [lo[0], lo[1]], hi: [hi[0], hi[1]], courses, zBase: lo[2], sizes, maxBricks: MAX_BRICKS,
    solidAt: (c) => {
      const loops = contoursAtZ(tris, (lo[2] + ((c + 0.5) / courses) * modelH) / 1000, solidIds);
      return loops.length ? regionOf(loops).inside : null;
    },
  });
  if (!bricks.length) throw new Error('No toy brick fits in this shape.');
  return {
    standard: std, bond: 'stretcher', jointMm: 0, courses,
    modelHeightMm: modelH, builtHeightMm: courses * TOY_HEIGHT_MM,
    bricks, whole: bricks.length, cutPieces: 0, closers: 0, toBuy: bricks.length,
    cuts: [], mortarLitres: 0, mortarBags: 0, lintels: [], parts, warnings,
  };
}

/** Lays the scene's solids in brick. Throws, with what to change, when it cannot. */
export function layBricks(scene: SceneGraph, opts: Partial<BrickworkOptions> = {}): BrickworkResult {
  const o = { ...DEFAULT_BRICKWORK_OPTIONS, ...opts };
  const asked = BRICK_STANDARDS[o.standardId] ?? BRICK_STANDARDS.uk;
  const warnings: string[] = [];

  const { tris, solidIds, skipped } = collectSceneTriangles(scene);
  if (tris.length < 9) throw new Error('There is no solid here to lay in brick.');
  for (const s of skipped) warnings.push(`${s} has no volume, so it is left out.`);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i++) {
    const v = tris[i] * 1000;
    if (v < lo[i % 3]) lo[i % 3] = v;
    if (v > hi[i % 3]) hi[i % 3] = v;
  }
  const modelH = hi[2] - lo[2];
  const span = Math.max(hi[0] - lo[0], hi[1] - lo[1]);
  const std = asked;
  if (std.toy) return toyResult(std, tris, solidIds, lo, hi, o.toySizes ?? DEFAULT_TOY_SIZES, warnings);
  if (!brickFits(std, span, modelH)) {
    const smaller = Object.values(BRICK_STANDARDS).filter((s) => s.lengthMm < std.lengthMm && brickFits(s, span, modelH)).map((s) => s.label);
    throw new Error(`The shape is ${Math.round(span)} mm across and ${Math.round(modelH)} mm tall, too small for ${std.label} bricks. ` +
      (smaller.length ? `Choose ${smaller.join(' or ')}, or scale it up.` : 'Scale it up.'));
  }
  const j = o.jointMm && o.jointMm > 0 ? o.jointMm : std.jointMm;
  const L = std.lengthMm, W = std.widthMm, H = std.heightMm;
  const gauge = H + j;
  const courses = Math.max(1, Math.round((modelH + j) / gauge));

  // A grid fine enough to keep a joint between bricks, coarse enough to fit.
  const pad = L * 2;
  let cell = Math.max(j / 2, 0.25);
  const w = hi[0] - lo[0] + 2 * pad, d = hi[1] - lo[1] + 2 * pad;
  while ((w / cell) * (d / cell) > 16e6) cell *= 1.5;
  const grid = () => new Occupancy(lo[0] - pad, lo[1] - pad, Math.ceil(w / cell), Math.ceil(d / cell), cell);

  const bricks: PlacedBrick[] = [];
  let headerFallbacks = 0;
  let headersTried = 0;
  // What the shape is at each course: an opening is where it has nothing below.
  const solidAt = new Map<number, (p: V2) => boolean>();
  let thinCourses = 0;

  for (let c = 0; c < courses; c++) {
    // Sampled through the course, scaled to the model so the top course reads its top.
    const zSample = lo[2] + ((c + 0.5) / courses) * modelH;
    const loops = contoursAtZ(tris, zSample / 1000, solidIds);
    if (!loops.length) continue;
    const region = regionOf(loops);
    solidAt.set(c, region.inside);
    const here = grid();
    const z = lo[2] + c * gauge;
    const units = unitsFor(o.bond, c);
    let unitIx = 0;
    let thin = false;

    for (let ring = 0; ring < 200; ring++) {
      const ringLoops = ring === 0
        ? region.loops
        // A ring further in lies in the material; an offset that has come out
        // the far side of a wall thinner than the rings (a flue grown past
        // the chimney's outside) is not one.
        : regionOf(offsetNestedLoops(region.loops, -ring * (W + j), { joinStyle: 'miter' }).paths).loops
          .filter((l) => l.filter((p) => region.inside(p)).length * 2 > l.length);
      if (!ringLoops.length) break;
      // Which runs face out: the shape's outline, not the inside of a hole.
      const runs = ringLoops.flatMap((l) => runsOf(l).map((r) => ({ ...r, outer: signedArea2(l) > 0 })));
      // Alternate courses take the runs the other way round, so the walls
      // meeting at a corner take turns to run through it.
      const flip = o.bond === 'stack' ? 0 : c;
      const order = [...runs.keys()].sort((a, b) => ((a + flip) % 2) - ((b + flip) % 2) || a - b);
      let laidThisRing = 0;

      for (const r of order) {
        // A ring with no corner to lap at starts half a brick round on alternate courses.
        const run = runs[r].closed && o.bond !== 'stack' && c % 2 === 1 ? { ...rotateRun(runs[r], (L + j) / 2), outer: runs[r].outer } : runs[r];
        const step = cell;
        // What is free along the run: each point's band across the leaf.
        const free = (s: number, depth: number, along: number): boolean => {
          const a = runAt(run, s), b = runAt(run, Math.min(run.total, s + along));
          const u0 = sub(b, a), ul = len(u0) || 1;
          const u = { x: u0.x / ul, y: u0.y / ul }, n = { x: -u.y, y: u.x };
          for (let t = step / 2; t < along; t += step) {
            for (let q = step / 2; q < depth; q += step) {
              if (here.at({ x: a.x + u.x * t + n.x * q, y: a.y + u.y * t + n.y * q })) return false;
            }
          }
          return true;
        };
        let s = 0;
        // A fresh stretch (the run's start, or past a brick already laid)
        // starts the bond again: in a course with headers, a queen closer
        // beside the first header puts its joints a quarter brick off the
        // ones below.
        let fresh = true;
        let laidInRun = 0;
        let pending: ('S' | 'H' | 'Q')[] = [];
        while (s < run.total - step) {
          // Skip what is taken.
          // Only the run's own start (past a corner already laid) restarts the
          // bond; a gap between headers further along does not.
          if (!free(s, W, step)) { s += step; if (!laidInRun) fresh = true; continue; }
          if (fresh) {
            fresh = false;
            unitIx = 0;
            pending = ring === 0 && run.outer && units.includes('H') ? ['Q'] : [];
          }
          const kind = pending.length ? pending.shift()! : units[unitIx++ % units.length];
          const closer = kind === 'Q';
          let along = kind === 'H' ? W : closer ? (W - j) / 2 : L;
          let depth = kind === 'S' ? W : L;
          // How far the band is free from here, up to one unit.
          let room = 0;
          while (room < along && s + room < run.total && free(s + room, depth, step)) room += step;
          room = Math.min(room, run.total - s);
          if (kind === 'H') headersTried++;
          if (kind === 'H' || closer) {
            // A header needs the wall a brick thick behind it.
            const a = runAt(run, s), b = runAt(run, s + W);
            const u0 = sub(b, a), ul = len(u0) || 1;
            const back = { x: (a.x + b.x) / 2 - (u0.y / ul) * (L - W / 2), y: (a.y + b.y) / 2 + (u0.x / ul) * (L - W / 2) };
            if (closer && (!region.inside(back) || room < along)) continue;
            if (!closer && (!region.inside(back) || room < W)) {
              if (!region.inside(back)) headerFallbacks++;
              along = L; depth = W;
              room = 0;
              while (room < along && s + room < run.total && free(s + room, depth, step)) room += step;
              room = Math.min(room, run.total - s);
            }
          }
          const piece = Math.min(along, room);
          if (!closer && piece < Math.min(along, L / 4)) { s += Math.max(step, piece) + j; continue; }
          const a = runAt(run, s), b = runAt(run, s + piece);
          const u0 = sub(b, a), ul = len(u0) || 1;
          const u = { x: u0.x / ul, y: u0.y / ul }, n = { x: -u.y, y: u.x };
          const centre = { x: a.x + u.x * (ul / 2) + n.x * (depth / 2), y: a.y + u.y * (ul / 2) + n.y * (depth / 2) };
          // Past the first leaf, bricks stay inside the shape.
          if (ring > 0 && !region.inside(centre)) { s += step; continue; }
          if (ring === 0 && !region.inside({ x: a.x + u.x * (ul / 2) + n.x * Math.min(depth - step, W) , y: a.y + u.y * (ul / 2) + n.y * Math.min(depth - step, W) })) thin = true;
          here.mark(a, u, n, ul, depth, j - cell / 2);
          bricks.push({
            course: c, x: centre.x, y: centre.y, z, angle: Math.atan2(u.y, u.x),
            lengthMm: ul, depthMm: depth, header: depth > W + 1e-6, closer,
            // Within a couple of joints of whole: the perpends are closed up a
            // little instead, as a bricklayer would, rather than a brick cut.
            cut: !closer && piece < along - 2.5 * j,
          });
          laidThisRing++;
          laidInRun++;
          if (bricks.length > MAX_BRICKS) {
            throw new Error(`That is more than ${MAX_BRICKS.toLocaleString()} bricks. Lay one wall at a time (select it first), or scale the shape down.`);
          }
          s += piece + j;
        }
      }
      if (!laidThisRing && ring > 0) break;
    }
    if (thin) thinCourses++;
  }

  if (!bricks.length) throw new Error('No brick fits in this shape.');
  // A header or two at a corner goes in as a stretcher, as it would on site;
  // only a wall too thin for headers is worth saying.
  if (headerFallbacks > 0.25 * headersTried && (o.bond === 'english' || o.bond === 'flemish')) {
    warnings.push(`${headerFallbacks} headers would stick out of a wall thinner than a brick's length (${L} mm), so stretchers were laid there instead.`);
  }
  if (thinCourses) warnings.push(`In ${thinCourses} course${thinCourses === 1 ? '' : 's'} the wall is thinner than a brick (${W} mm): laid one brick wide.`);

  // Cut pieces: paired out of whole bricks where two fit in one, longest first.
  const cutLens = bricks.filter((b) => b.cut).map((b) => Math.round(b.lengthMm)).sort((x, y) => y - x);
  const bins: number[] = [];
  const kerf = Math.max(1, j / 3);
  for (const l of cutLens) {
    const k = bins.findIndex((used) => used + kerf + l <= L);
    if (k >= 0) bins[k] += kerf + l;
    else bins.push(l);
  }
  const byLen = new Map<number, number>();
  const bucket = Math.max(1, Math.round(L / 40));
  for (const l of cutLens) {
    const key = Math.round(l / bucket) * bucket;
    byLen.set(key, (byLen.get(key) ?? 0) + 1);
  }
  // A brick split lengthways makes two queen closers.
  const closers = bricks.filter((b) => b.closer).length;
  const whole = bricks.length - cutLens.length - closers;
  const toBuy = Math.ceil((whole + bins.length + Math.ceil(closers / 2)) * (1 + o.wastagePct / 100));

  // Mortar: a bed and a perpend for each brick, and a tenth for waste.
  const mortarMm3 = bricks.reduce((sum, b) => sum + (b.lengthMm * j + H * j + j * j) * b.depthMm, 0) * 1.1;
  const mortarLitres = mortarMm3 / 1e6;

  // Lintels: an opening's span, with the bearing either end, in stock steps.
  const bearing = 150 * (L / 215);
  const stock = 150 * (L / 215);
  const lintelMap = new Map<number, number>();
  for (const spanMm of openingSpans(bricks, solidAt, j)) {
    const l = Math.round(Math.ceil((spanMm + 2 * bearing) / stock) * stock);
    lintelMap.set(l, (lintelMap.get(l) ?? 0) + 1);
  }

  return {
    standard: std, bond: o.bond, jointMm: j, courses,
    modelHeightMm: modelH, builtHeightMm: courses * gauge - j,
    bricks, whole, cutPieces: cutLens.length, closers, toBuy,
    cuts: [...byLen.entries()].sort((a, b) => b[0] - a[0]).map(([lengthMm, count]) => ({ lengthMm, count })),
    mortarLitres, mortarBags: Math.ceil(mortarLitres / 12.5),
    lintels: [...lintelMap.entries()].sort((a, b) => a[0] - b[0]).map(([lengthMm, count]) => ({ lengthMm, count })),
    warnings,
  };
}

/**
 * Openings: in each course, bricks with nothing under most of them, joined
 * into one span where they sit end to end. Only the first course over an
 * opening counts; the ones above stand on it.
 */
function openingSpans(bricks: PlacedBrick[], solidAt: Map<number, (p: V2) => boolean>, j: number): number[] {
  const byCourse = new Map<number, PlacedBrick[]>();
  for (const b of bricks) {
    const list = byCourse.get(b.course);
    if (list) list.push(b);
    else byCourse.set(b.course, [b]);
  }
  const footprint = (b: PlacedBrick) => {
    const u = { x: Math.cos(b.angle), y: Math.sin(b.angle) }, n = { x: -u.y, y: u.x };
    return { u, n, o: { x: b.x - u.x * b.lengthMm / 2 - n.x * b.depthMm / 2, y: b.y - u.y * b.lengthMm / 2 - n.y * b.depthMm / 2 } };
  };
  const spans: number[] = [];
  const courses = [...byCourse.keys()].sort((a, b) => a - b);
  for (let k = 1; k < courses.length; k++) {
    // Nothing of the shape below at all: it stands on something else (a slab,
    // the ground at another level), not over an opening.
    const solidBelow = solidAt.get(courses[k] - 1);
    if (!solidBelow) continue;
    const loose: PlacedBrick[] = [];
    for (const b of byCourse.get(courses[k])!) {
      const f = footprint(b);
      let over = 0, total = 0;
      for (let t = 0.1; t < 1; t += 0.2) {
        for (const q of [0.25, 0.75]) {
          total++;
          const p = { x: f.o.x + f.u.x * b.lengthMm * t + f.n.x * b.depthMm * q, y: f.o.y + f.u.y * b.lengthMm * t + f.n.y * b.depthMm * q };
          if (solidBelow(p)) over++;
        }
      }
      if (over / total < 0.5) loose.push(b);
    }
    // Loose bricks near one another are one opening, whichever face they are
    // on: one lintel the wall's thickness.
    const used = new Set<PlacedBrick>();
    for (const seed of loose) {
      if (used.has(seed)) continue;
      used.add(seed);
      const group = [seed];
      for (let q = 0; q < group.length; q++) {
        for (const other of loose) {
          if (used.has(other)) continue;
          const reach = (Math.max(group[q].lengthMm, group[q].depthMm) + Math.max(other.lengthMm, other.depthMm)) / 2 + 2 * j;
          if (Math.hypot(other.x - group[q].x, other.y - group[q].y) <= reach) {
            used.add(other);
            group.push(other);
          }
        }
      }
      // Every brick's angle runs along the face it was laid on, header or not.
      const ref = group[0];
      const u = { x: Math.cos(ref.angle), y: Math.sin(ref.angle) }, n = { x: -u.y, y: u.x };
      const c0 = { x: group.reduce((t, x) => t + x.x, 0) / group.length, y: group.reduce((t, x) => t + x.y, 0) / group.length };
      const ext = group.map((x) => (x.x - c0.x) * u.x + (x.y - c0.y) * u.y);
      const reachMm = Math.max(...group.map((x) => Math.max(x.lengthMm, x.depthMm)));
      const lo = Math.min(...ext) - reachMm, hi = Math.max(...ext) + reachMm;
      // The course below along the wall's middle (and either side of a collar joint).
      const across = ref.depthMm / 4;
      const supportedAt = (t: number) => [-across, 0, across].some((w) =>
        solidBelow({ x: c0.x + u.x * t + n.x * w, y: c0.y + u.y * t + n.y * w }));
      // The unsupported stretch nearest the middle of the group is the opening.
      const step = Math.max(1, j / 4);
      const gaps: [number, number][] = [];
      let from: number | null = null;
      for (let t = lo; t <= hi + step; t += step) {
        const open = t <= hi && !supportedAt(t);
        if (open && from === null) from = t;
        // Only a gap with brickwork both sides is an opening; one open at an
        // end is an overhang.
        if (!open && from !== null) { if (from > lo) gaps.push([from, t]); from = null; }
      }
      const middle = gaps.find(([a, b]) => a <= 0 && b >= 0);
      const best = middle ? middle[1] - middle[0] : Math.max(0, ...gaps.map(([a, b]) => b - a));
      if (best > 0) spans.push(best);
    }
  }
  return spans;
}

export type BrickColour = (brick: PlacedBrick, index: number) => [number, number, number, number];

/** A little variation either way, the same for the same brick every time. */
const jitter = (i: number, amount: number) => {
  const h = Math.sin(i * 12.9898) * 43758.5453;
  return (h - Math.floor(h)) * 2 * amount - amount;
};

/** Brick reds with a little variation, the headers darker as burnt ends are. */
export const clayColour: BrickColour = (b, i) => {
  const v = jitter(i, 0.06);
  const base: [number, number, number] = b.header ? [0.52, 0.22, 0.15] : [0.68, 0.30, 0.20];
  return [base[0] + v, base[1] + v * 0.6, base[2] + v * 0.4, 1];
};

/** Toy red, each brick a shade off its neighbours so the seams read. */
export const toyColour: BrickColour = (_b, i) => {
  const v = jitter(i, 0.03);
  return [0.78 + v, 0.09 + v, 0.08 + v, 1];
};

/** Grey stone, the tops a shade lighter as weathered battlements are. */
export const stoneColour: BrickColour = (b, i) => {
  const v = jitter(i, 0.04);
  const top = b.z > 150 ? 0.04 : 0;
  return [0.6 + v + top, 0.6 + v + top, 0.58 + v + top, 1];
};

export const BRICK_COLOURS: Record<NonNullable<BrickworkSource['colour']>, BrickColour> = {
  clay: clayColour, toy: toyColour, stone: stoneColour,
};

/**
 * A brickwork body's bricks, laid from its source: box geoms in the body's
 * frame. Slow for a big shape; the compile pass runs it in the worker.
 */
export function brickworkSourceGeoms(source: BrickworkSource, prefix = 'brick'): { geoms: SceneGeom[]; result: BrickworkResult } {
  const result = layBricks(
    { nodes: [{ id: 'shape', name: 'Shape', type: 'body', pos: [0, 0, 0], joints: [], children: [], geoms: source.shape }] } as SceneGraph,
    {
      standardId: source.standardId as BrickStandardId,
      ...(source.bond ? { bond: source.bond as BrickBond } : {}),
      ...(source.jointMm ? { jointMm: source.jointMm } : {}),
      ...(source.toySizes ? { toySizes: source.toySizes as ToySize[] } : {}),
    },
  );
  const colour = BRICK_COLOURS[source.colour ?? (result.standard.toy ? 'toy' : 'clay')];
  return { geoms: brickworkNodes(result, prefix, [0, 0, 0], colour).flatMap((n) => n.geoms), result };
}

/**
 * Bricks as scene bodies, one per course, every brick a box. `shift` moves
 * them, mm; `colour` paints each (default: clay, or toy red for toy bricks).
 */
export function brickworkNodes(
  result: Pick<BrickworkResult, 'bricks' | 'standard'>, idPrefix: string, shift: [number, number, number] = [0, 0, 0], colour?: BrickColour,
): SceneNode[] {
  const paint = colour ?? (result.standard.toy ? toyColour : clayColour);
  const H = result.standard.heightMm;
  const byCourse = new Map<number, PlacedBrick[]>();
  for (const b of result.bricks) {
    const list = byCourse.get(b.course);
    if (list) list.push(b);
    else byCourse.set(b.course, [b]);
  }
  let i = 0;
  return [...byCourse.entries()].sort((a, b) => a[0] - b[0]).map(([course, list]) => ({
    id: `${idPrefix}_course_${course + 1}`,
    name: `Course ${course + 1}`,
    type: 'body' as const,
    pos: [0, 0, 0],
    joints: [],
    children: [],
    geoms: list.map((b) => {
      i++;
      return {
        name: `${idPrefix}_${course + 1}_${i}`,
        type: 'box' as const,
        size: [b.lengthMm / 2000, b.depthMm / 2000, H / 2000],
        pos: [(b.x + shift[0]) / 1000, (b.y + shift[1]) / 1000, (b.z + H / 2 + shift[2]) / 1000],
        quat: [Math.cos(b.angle / 2), 0, 0, Math.sin(b.angle / 2)],
        rgba: paint(b, i),
        // Fired clay; ABS for toy bricks, which are hollow underneath.
        density: result.standard.toy ? 550 : 1900,
      };
    }),
  }));
}

export type BrickPlacement = 'replace' | 'beside';

/**
 * The scene with a body (or everything, for null) laid in brick: the
 * brickwork in its place, or beside it along +X.
 */
export function brickworkInScene(
  scene: SceneGraph,
  bodyId: string | null,
  opts: Partial<BrickworkOptions> & { placement?: BrickPlacement } = {},
): { nodes: SceneNode[]; result: BrickworkResult } {
  const result = layBricks(subjectScene(scene, bodyId), opts);
  let shift: [number, number, number] = [0, 0, 0];
  if (opts.placement === 'beside') {
    let minX = Infinity, maxX = -Infinity;
    for (const b of result.bricks) {
      const r = Math.max(b.lengthMm, b.depthMm) / 2;
      minX = Math.min(minX, b.x - r);
      maxX = Math.max(maxX, b.x + r);
    }
    shift = [maxX - minX + 300, 0, 0];
  }
  const prefix = `brick_${Math.random().toString(36).slice(2, 7)}`;
  const laid = brickworkNodes(result, prefix, shift);
  const without = (list: SceneNode[]): SceneNode[] =>
    list.filter((n) => (bodyId ? n.id !== bodyId : !!n.simulation)).map((n) => (n.children?.length ? { ...n, children: without(n.children) } : n));
  const kept = opts.placement === 'beside' ? scene.nodes : without(scene.nodes);
  return { nodes: [...kept, ...laid], result };
}
