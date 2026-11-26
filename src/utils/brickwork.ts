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
import { DEFAULT_TOY_SIZES, layToyBricks, TOY_HEIGHT_MM, TOY_PITCH_MM, type ToyInventory, type ToySize } from './toyBricks';
import { bondReport, type BondReport } from './brickBond';
import { layWalls } from './brickSetOut';
import { MORTAR_BAG_LITRES, mortarLitresFor } from './brickMortar';

export type BrickStandardId = 'uk' | 'us_modular' | 'eu_nf' | 'au' | 'mini_6' | 'mini_12' | 'toy';

export interface BrickStandard {
  id: BrickStandardId;
  label: string;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  /** The usual joint, mm. */
  jointMm: number;
  /** Share of a brick's volume its frog or cores take in mortar. Absent: solid. */
  frogFill?: number;
  /** A scale-model brick, for a shape too small for real ones. */
  miniature?: boolean;
  /** Interlocking studded bricks on an 8 mm grid, in several sizes: see utils/toyBricks.ts. */
  toy?: boolean;
}

/** Sets the UK brick at the 25 bricks a 25 kg bag that premix datasheets give. */
const FROG_FILL = 0.11;

export const BRICK_STANDARDS: Record<BrickStandardId, BrickStandard> = {
  uk: { id: 'uk', label: 'UK standard 215 × 102.5 × 65', lengthMm: 215, widthMm: 102.5, heightMm: 65, jointMm: 10, frogFill: FROG_FILL },
  us_modular: { id: 'us_modular', label: 'US modular 7⅝ × 3⅝ × 2¼"', lengthMm: 194, widthMm: 92, heightMm: 57, jointMm: 10, frogFill: FROG_FILL },
  eu_nf: { id: 'eu_nf', label: 'European NF 240 × 115 × 71', lengthMm: 240, widthMm: 115, heightMm: 71, jointMm: 10, frogFill: FROG_FILL },
  au: { id: 'au', label: 'Australian 230 × 110 × 76', lengthMm: 230, widthMm: 110, heightMm: 76, jointMm: 10, frogFill: FROG_FILL },
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
  /** Toy bricks: the sizes to build with, as many as it takes. Default: every size. */
  toySizes?: ToySize[];
  /** Toy bricks: size → how many the builder has (null: any number). Wins over toySizes. */
  toyInventory?: ToyInventory;
  /** Toy bricks: hollow, walls this many studs thick and capped top and bottom. 0 or absent: solid. */
  hollowStuds?: number;
  /** Add a slightly recessed mortar-colored backing/bedding core inside the walls so joints are visually solid. */
  includeMortar?: boolean;
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
  /** Precast lintel beam (used by bondReport for connectivity/support, excluded from perpend straight-joint checks). */
  lintel?: boolean;
}

export interface PlacedLintel {
  course: number;
  /** Centre of its footprint, mm. */
  x: number;
  y: number;
  /** Its bed, mm. */
  z: number;
  /** Direction of its length, radians about Z. */
  angle: number;
  /** Length along the wall (matching BOM stock length / slot span), mm. */
  lengthMm: number;
  /** Wall thickness across the opening, mm. */
  depthMm: number;
  /** Height of the lintel (one course height), mm. */
  heightMm: number;
}

export interface BrickworkResult {
  standard: BrickStandard;
  bondType: BrickBond;
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
  /** Concrete/stone lintel beams placed over detected openings. */
  placedLintels?: PlacedLintel[];
  /** Toy bricks: how many of each size. */
  parts?: { size: ToySize; count: number }[];
  /** Toy bricks: what the build needs more of than the builder has. */
  short?: { size: ToySize; count: number }[];
  /** How well it holds together: see utils/brickBond.ts. */
  bond: BondReport;
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
  // Past an end, straight on along the end's own line: a run carried through
  // an inside corner (toothing) goes on into the other wall.
  if (s < 0 || s > run.total) {
    const [a, b] = s < 0 ? [run.pts[0], run.pts[1]] : [run.pts[run.pts.length - 2], run.pts[run.pts.length - 1]];
    const d = sub(b, a), l = len(d) || 1;
    const from = s < 0 ? a : b, by = s < 0 ? s : s - run.total;
    return { x: from.x + (d.x / l) * by, y: from.y + (d.y / l) * by };
  }
  const t = s;
  let i = 1;
  while (i < run.s.length - 1 && run.s[i] < t) i++;
  const a = run.pts[i - 1], b = run.pts[i];
  const seg = run.s[i] - run.s[i - 1] || 1;
  const f = (t - run.s[i - 1]) / seg;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/** A closed loop (material on its left) split into runs at its corners. */
function runsOf(loop: V2[], cornerDeg = 30, minEdge = 0): Run[] {
  const n = loop.length;
  const corners: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = loop[(i - 1 + n) % n], b = loop[i], c = loop[(i + 1) % n];
    const d1 = sub(b, a), d2 = sub(c, b);
    // A notch (where two overlapping parts' corners poke through) is not a
    // corner to set out from: a corner has a real edge either side.
    if (len(d1) < minEdge || len(d2) < minEdge) continue;
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
  readonly x0: number;
  readonly y0: number;
  readonly nx: number;
  readonly ny: number;
  readonly cell: number;
  constructor(x0: number, y0: number, nx: number, ny: number, cell: number) {
    this.x0 = x0; this.y0 = y0; this.nx = nx; this.ny = ny; this.cell = cell;
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
/**
 * Whether a body is already a laid course of bricks, so laying beside the
 * shape does not re-brick the courses just added. Tested on the course id and
 * brick geom names, which survive uniqueNames and renaming.
 */
const isLaidCourse = (n: SceneNode) =>
  Boolean(n.brickwork) ||
  (/_(?:course_\d+|mortar)(?:_\d+)?$/.test(n.id) && Boolean(n.geoms?.length) && n.geoms.every((g) => /^brick_/.test(g.name ?? '')));

/**
 * Whether the whole scene's brickwork takes this body. Not a simulated cut,
 * not already-laid brick courses, and not anything that moves: a hinged door
 * or a drawbridge is not brick.
 */
const laidWithScene = (n: SceneNode) => !n.simulation && !(n.joints?.length) && !isLaidCourse(n);

function pruneFixed(nodes: SceneNode[]): SceneNode[] {
  return nodes.filter(laidWithScene).map((n) => (n.children?.length ? { ...n, children: pruneFixed(n.children) } : n));
}

/** Whether two bricks in the same course intersect (or touch within `pad` mm). */
function bricksOverlap2D(a: Pick<PlacedBrick, 'x' | 'y' | 'angle' | 'lengthMm' | 'depthMm'>, b: Pick<PlacedBrick, 'x' | 'y' | 'angle' | 'lengthMm' | 'depthMm'>, pad = 0.02): boolean {
  const dx = b.x - a.x, dy = b.y - a.y;
  const maxR = (Math.hypot(a.lengthMm, a.depthMm) + Math.hypot(b.lengthMm, b.depthMm)) / 2 + pad;
  if (dx * dx + dy * dy >= maxR * maxR) return false;
  const quad = (p: typeof a) => {
    const u = { x: Math.cos(p.angle), y: Math.sin(p.angle) }, n = { x: -u.y, y: u.x };
    const l = p.lengthMm / 2 + pad / 2, d = p.depthMm / 2 + pad / 2;
    return [[-l, -d], [l, -d], [l, d], [-l, d]].map(([s, q]) => ({ x: p.x + u.x * s + n.x * q, y: p.y + u.y * s + n.y * q }));
  };
  const A = quad(a), B = quad(b);
  for (const P of [A, B]) {
    for (let i = 0; i < 2; i++) {
      const ex = P[i + 1].x - P[i].x, ey = P[i + 1].y - P[i].y;
      const ax = -ey, ay = ex;
      const pa = A.map((p) => p.x * ax + p.y * ay), pb = B.map((p) => p.x * ax + p.y * ay);
      if (Math.min(...pa) >= Math.max(...pb) || Math.min(...pb) >= Math.max(...pa)) return false;
    }
  }
  return true;
}

export function subjectScene(scene: SceneGraph, bodyId: string | null): SceneGraph {
  if (!bodyId) return { ...scene, nodes: pruneFixed(scene.nodes) };
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
  const target = chain[chain.length - 1];
  if (chain.some((n) => (n.joints?.length ?? 0) > 0)) {
    throw new Error(`'${target.name || target.id}' has a joint (a moving part) and cannot be laid in brick.`);
  }
  let wrapped: SceneNode = target.children?.length ? { ...target, children: pruneFixed(target.children) } : target;
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
  std: BrickStandard, tris: number[], solidIds: number[], lo: number[], hi: number[], o: BrickworkOptions, warnings: string[],
): BrickworkResult {
  const inventory: ToyInventory = o.toyInventory
    ?? Object.fromEntries((o.toySizes ?? DEFAULT_TOY_SIZES).map((s) => [s, null]));
  const modelH = hi[2] - lo[2];
  const span = Math.max(hi[0] - lo[0], hi[1] - lo[1]);
  if (span < 2 * TOY_PITCH_MM || modelH < TOY_HEIGHT_MM / 2) {
    throw new Error(`The shape is ${Math.round(span)} mm across and ${Math.round(modelH)} mm tall, too small for toy bricks. Scale it up.`);
  }
  const courses = Math.max(1, Math.round(modelH / TOY_HEIGHT_MM));
  const nx = Math.max(1, Math.ceil((hi[0] - lo[0]) / TOY_PITCH_MM));
  const ny = Math.max(1, Math.ceil((hi[1] - lo[1]) / TOY_PITCH_MM));
  // Pre-flight stud/brick-count estimate before allocating per-course masks:
  // avoids OOM / multi-minute worker freeze on building-scale models.
  const MAX_TOY_GRID_CELLS = 5_000_000;
  const gridCells = nx * ny * courses;
  const sampleCount = Math.min(courses, 24);
  let sampledArea = 0;
  for (let s = 0; s < sampleCount; s++) {
    const c = sampleCount === courses ? s : Math.floor(((s + 0.5) * courses) / sampleCount);
    const loops = contoursAtZ(tris, (lo[2] + ((c + 0.5) / courses) * modelH) / 1000, solidIds);
    sampledArea += Math.abs(loops.reduce((t, l) => t + signedArea2(l) / 2, 0));
  }
  const estTotalStuds = (sampledArea * (courses / sampleCount)) / (TOY_PITCH_MM * TOY_PITCH_MM);
  const maxBrickStuds = Math.max(
    1,
    ...Object.entries(inventory)
      .filter(([, count]) => count === null || count === undefined || count > 0)
      .map(([sz]) => {
        const parts = sz.split('x').map(Number);
        return parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1]) ? parts[0] * parts[1] : 1;
      }),
  );
  const hollow = (o.hollowStuds ?? 0) > 0;
  const minSolidBricks = estTotalStuds / maxBrickStuds;
  if ((!hollow && minSolidBricks > MAX_BRICKS * 1.1) || gridCells > MAX_TOY_GRID_CELLS) {
    const approxBricks = Math.max(MAX_BRICKS + 1, Math.round(estTotalStuds / Math.min(8, maxBrickStuds) / 1000) * 1000);
    throw new Error(
      `That is about ${approxBricks.toLocaleString()} toy bricks, more than ${MAX_BRICKS.toLocaleString()}. Build one part at a time (select it first), make it hollow, or scale it down.`,
    );
  }
  const { bricks, parts, short } = layToyBricks({
    lo: [lo[0], lo[1]], hi: [hi[0], hi[1]], courses, zBase: lo[2], inventory, hollowStuds: o.hollowStuds, maxBricks: MAX_BRICKS,
    solidAt: (c) => {
      const loops = contoursAtZ(tris, (lo[2] + ((c + 0.5) / courses) * modelH) / 1000, solidIds);
      return loops.length ? regionOf(loops).inside : null;
    },
  });
  if (!bricks.length) throw new Error('No toy brick fits in this shape.');
  if (short.length) {
    warnings.push(`Short of ${short.map((s) => `${s.count} × ${s.size.replace('x', '×')}`).join(', ')}: more than you have.`);
  }
  const bond = bondReport(bricks, 0.2, { sides: true });
  bondWarnings(bond, warnings, true);
  return {
    standard: std, bondType: 'stretcher', jointMm: 0, courses,
    modelHeightMm: modelH, builtHeightMm: courses * TOY_HEIGHT_MM,
    bricks, whole: bricks.length, cutPieces: 0, closers: 0, toBuy: bricks.length,
    cuts: [], mortarLitres: 0, mortarBags: 0, lintels: [], parts, short, bond, warnings,
  };
}


/** Lays the scene's solids in brick. Throws, with what to change, when it cannot. */
export function layBricks(scene: SceneGraph, opts: Partial<BrickworkOptions> = {}): BrickworkResult {
  const saved = scene.brickwork;
  const sameStd = !opts.standardId || !saved?.standardId || opts.standardId === saved.standardId;
  const o: BrickworkOptions = {
    ...DEFAULT_BRICKWORK_OPTIONS,
    ...saved,
    ...(sameStd ? {} : { jointMm: undefined }),
    ...(opts.toySizes && !opts.toyInventory ? { toyInventory: undefined } : {}),
    ...(opts.toyInventory && !opts.toySizes ? { toySizes: undefined } : {}),
    ...opts,
  };
  const std = BRICK_STANDARDS[o.standardId] ?? BRICK_STANDARDS.uk;
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
  if (std.toy) return toyResult(std, tris, solidIds, lo, hi, o, warnings);
  if (!brickFits(std, span, modelH)) {
    const smaller = Object.values(BRICK_STANDARDS).filter((s) => s.lengthMm < std.lengthMm && brickFits(s, span, modelH)).map((s) => s.label);
    throw new Error(`The shape is ${Math.round(span)} mm across and ${Math.round(modelH)} mm tall, too small for ${std.label} bricks. ` +
      (smaller.length ? `Choose ${smaller.join(' or ')}, or scale it up.` : 'Scale it up.'));
  }
  const j = o.jointMm && o.jointMm > 0 ? o.jointMm : std.jointMm;
  const L = std.lengthMm, W = std.widthMm, H = std.heightMm;
  const gauge = H + j;
  const courses = Math.max(1, Math.round((modelH + j) / gauge));
  // Too many to lay is said before laying them: the courses' area over a
  // brick's bed, give or take the joints.
  {
    let area = 0;
    for (let c = 0; c < courses; c++) {
      const loops = contoursAtZ(tris, (lo[2] + ((c + 0.5) / courses) * modelH) / 1000, solidIds);
      area += Math.abs(loops.reduce((t, l) => t + signedArea2(l) / 2, 0));
    }
    const estimate = area / ((L + j) * (W + j));
    if (estimate > MAX_BRICKS * 1.1) {
      throw new Error(`That is about ${Math.round(estimate / 1000) * 1000} bricks, more than ${MAX_BRICKS.toLocaleString()}. Lay one wall at a time (select it first), or scale the shape down.`);
    }
  }

  // A grid fine enough to keep a joint between bricks, coarse enough to fit.
  const pad = L * 2;
  let cell = Math.max(j / 2, W / 50, 0.25);
  const w = hi[0] - lo[0] + 2 * pad, d = hi[1] - lo[1] + 2 * pad;
  while ((w / cell) * (d / cell) > 1e6) cell *= 1.4;
  const markGrow = Math.max(0.05, j - cell / 2);
  const grid = () => new Occupancy(lo[0] - pad, lo[1] - pad, Math.ceil(w / cell), Math.ceil(d / cell), cell);

  const bricks: PlacedBrick[] = [];
  let headerFallbacks = 0;
  // The widest face joint a curve opened to (0: none).
  let widestWedge = 0;
  // Who ran through each corner last course (utils/brickSetOut.ts).
  const cornerOwners = new Map<string, string>();
  // Wall-courses too thin for headers (a half-brick chimney in English bond).
  let thinForHeaders = 0;
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
    const prevCourse = bricks.filter((b) => b.course === c - 1);
    const courseBricks: PlacedBrick[] = [];
    let unitIx = 0;
    let thin = false;

    // Straight walls first, set out as a bricklayer would (utils/brickSetOut.ts);
    // the face-by-face laying below only fills what they leave: curves, lumps.
    {
      const { headerless } = layWalls({
        loops: region.loops,
        outerFlags: region.loops.map((l) => signedArea2(l) > 0),
        inside: region.inside,
        dims: { L, W, H, j },
        bond: o.bond,
        course: c,
        below: prevCourse,
        step: cell,
        owners: cornerOwners,
        layer: {
          // A safety net against another wall's bricks, tested inside the
          // set-out's perpend slack on the grid plus an exact footprint check.
          free: (at, u, n, along, depth) => {
            const inset = Math.max(0, Math.min(along / 2 - cell / 2, j * 0.35));
            for (let t = inset + cell / 2; t < along - inset; t += cell) for (let q = cell / 2; q < depth; q += cell) if (here.at({ x: at.x + u.x * t + n.x * q, y: at.y + u.y * t + n.y * q })) return false;
            const cand = { x: at.x + u.x * along / 2 + n.x * depth / 2, y: at.y + u.y * along / 2 + n.y * depth / 2, angle: Math.atan2(u.y, u.x), lengthMm: along, depthMm: depth };
            return !courseBricks.some((b) => bricksOverlap2D(cand, b));
          },
          lay: (at, u, n, along, depth, flags) => {
            here.mark(at, u, n, along, depth, markGrow);
            const placed: PlacedBrick = {
              course: c, x: at.x + u.x * along / 2 + n.x * depth / 2, y: at.y + u.y * along / 2 + n.y * depth / 2, z,
              angle: Math.atan2(u.y, u.x), lengthMm: along, depthMm: depth, ...flags,
            };
            courseBricks.push(placed);
            bricks.push(placed);
            if (bricks.length > MAX_BRICKS) {
              throw new Error(`That is more than ${MAX_BRICKS.toLocaleString()} bricks. Lay one wall at a time (select it first), or scale the shape down.`);
            }
          },
        },
      });
      thinForHeaders += headerless;
    }

    for (let ring = 0; ring < 200; ring++) {
      const ringLoops = ring === 0
        ? region.loops
        // A ring further in lies in the material; an offset that has come out
        // the far side of a wall thinner than the rings (a flue grown past
        // the chimney's outside) is not one.
        // A leaf further in, and a grid step more: on a curve each brick of
        // the leaf outside is a chord that sags into this one.
        : regionOf(offsetNestedLoops(region.loops, -(ring * (W + j) + cell), { joinStyle: 'miter' }).paths).loops
          .filter((l) => l.filter((p) => region.inside(p)).length * 2 > l.length);
      if (!ringLoops.length) break;
      // Which runs face out: the shape's outline, not the inside of a hole.
      // (Ignoring notch corners, runsOf's minEdge, joined the tower's runs
      // across them and its chord bricks then overlapped at their inner
      // corners: left at 0 until curves are set out properly.)
      const perLoop = ringLoops.map((l) => runsOf(l).map((r) => ({ ...r, outer: signedArea2(l) > 0 })));
      const runs = perLoop.flat();
      const order = [...runs.keys()];
      let laidThisRing = 0;

      for (const r of order) {
        // A ring with no corner to lap at starts half a brick round on alternate courses.
        const run = runs[r].closed && o.bond !== 'stack' && c % 2 === 1 ? { ...rotateRun(runs[r], (L + j) / 2), outer: runs[r].outer } : runs[r];
        const endAt = run.total;
        const step = cell;
        // What is free along the run: each point's band across the leaf.
        const free = (s: number, depth: number, along: number): boolean => {
          const a = runAt(run, s), b = runAt(run, Math.min(endAt, s + along));
          const u0 = sub(b, a), ul = len(u0) || 1;
          const u = { x: u0.x / ul, y: u0.y / ul }, n = { x: -u.y, y: u.x };
          for (let t = step / 2; t < along; t += step) {
            for (let q = step / 2; q < depth; q += step) {
              if (here.at({ x: a.x + u.x * t + n.x * q, y: a.y + u.y * t + n.y * q })) return false;
            }
          }
          return true;
        };
        // The back of a brick is checked short of a joint: on a curve the
        // collar joint between two leaves narrows where a straight brick sags
        // into it, as it does in a real curved wall.
        const backClear = (depth: number) => (run.closed ? Math.max(step, depth - j) : depth);
        let s = 0;
        // A fresh stretch (the run's start, or past a brick already laid)
        // starts the bond again: in a course with headers, a queen closer
        // beside the first header puts its joints a quarter brick off the
        // ones below.
        let fresh = true;
        let laidInRun = 0;
        let pending: ('S' | 'H' | 'Q')[] = [];
        while (s < endAt - step) {
          // Skip what is taken.
          // Only the run's own start (past a corner already laid) restarts the
          // bond; a gap between headers further along does not.
          if (!free(s, W, step)) { s += step; if (!laidInRun) fresh = true; continue; }
          if (fresh) {
            fresh = false;
            unitIx = 0;
            // Only in a course that starts with a header: the closer sets its
            // headers a quarter brick off, centred on the stretchers below.
            pending = ring === 0 && run.outer && units[0] === 'H' ? ['Q'] : [];
          }
          // Headers are laid from the face; a ring further in is stretchers
          // behind them (a header there would reach out past the wall).
          const kind = pending.length ? pending.shift()! : ring > 0 ? 'S' : units[unitIx++ % units.length];
          const closer = kind === 'Q';
          let along = kind === 'H' ? W : closer ? (W - j) / 2 : L;
          let depth = kind === 'S' ? W : L;
          // How far the band is free from here, up to one unit.
          let room = 0;
          while (room < along && s + room < endAt && free(s + room, backClear(depth), step)) room += step;
          room = Math.min(room, endAt - s);
          let triedHeader = false;
          let fellBackHeader = false;
          if (kind === 'H') triedHeader = true;
          if (kind === 'H' || closer) {
            // A header needs the wall a brick thick behind it.
            const a = runAt(run, s), b = runAt(run, s + W);
            const u0 = sub(b, a), ul = len(u0) || 1;
            const back = { x: (a.x + b.x) / 2 - (u0.y / ul) * (L - W / 2), y: (a.y + b.y) / 2 + (u0.x / ul) * (L - W / 2) };
            if (closer && (!region.inside(back) || room < along)) continue;
            if (!closer && (!region.inside(back) || room < W)) {
              if (!region.inside(back)) fellBackHeader = true;
              along = L; depth = W;
              room = 0;
              while (room < along && s + room < endAt && free(s + room, backClear(depth), step)) room += step;
              room = Math.min(room, endAt - s);
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
          const candAngle = Math.atan2(u.y, u.x);
          if (courseBricks.some((prev) => bricksOverlap2D({ x: centre.x, y: centre.y, angle: candAngle, lengthMm: ul, depthMm: depth }, prev))) {
            s += step;
            continue;
          }
          if (triedHeader) headersTried++;
          if (fellBackHeader) headerFallbacks++;
          // Thinner than a brick: the shape ends well short of the brick's back
          // (not the few millimetres a chord on a curve sags past it).
          const back = Math.min(depth, W) * 0.8;
          if (ring === 0 && !region.inside({ x: a.x + u.x * (ul / 2) + n.x * back, y: a.y + u.y * (ul / 2) + n.y * back })) thin = true;
          here.mark(a, u, n, ul, depth, markGrow);
          const placed: PlacedBrick = {
            course: c, x: centre.x, y: centre.y, z, angle: candAngle,
            lengthMm: ul, depthMm: depth, header: depth > W + 1e-6, closer,
            cut: !closer && piece < (depth > W + 1e-6 ? W : L) - j / 2,
          };
          courseBricks.push(placed);
          bricks.push(placed);
          laidThisRing++;
          laidInRun++;
          if (bricks.length > MAX_BRICKS) {
            throw new Error(`That is more than ${MAX_BRICKS.toLocaleString()} bricks. Lay one wall at a time (select it first), or scale the shape down.`);
          }
          // On a curve turning into the wall, the next brick's back corner
          // would meet this one's: the joint opens on the face instead, as a
          // curved wall's joints are wedges.
          const ahead = runAt(run, Math.min(endAt, s + piece + j + 1)), after = runAt(run, Math.min(endAt, s + piece + j + 1 + L / 2));
          const t0 = sub(after, ahead), tl = len(t0) || 1;
          const turn = Math.atan2(u.x * t0.y / tl - u.y * t0.x / tl, u.x * t0.x / tl + u.y * t0.y / tl);
          const wedge = turn > 0.01 && turn < Math.PI / 2 - 0.15
            ? Math.max(0, Math.min(depth * 2, depth * Math.tan(turn)))
            : 0;
          if (wedge > 0) widestWedge = Math.max(widestWedge, j + wedge);
          s += piece + j + wedge;
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
  if (widestWedge > 2 * j) {
    warnings.push(`On the curve the joints open to ${Math.round(widestWedge)} mm on the face, as a curve this tight in whole bricks must: a builder would lay it in headers or radial bricks, or with wider-than-usual joints.`);
  }
  if (thinForHeaders) {
    warnings.push(`${thinForHeaders} course${thinForHeaders === 1 ? '' : 's'} of half-brick wall (a chimney, a pier) laid in stretchers: ${o.bond === 'english' ? 'English' : 'Flemish'} bond needs walls a brick thick.`);
  }
  if (thinCourses) warnings.push(`In ${thinCourses} course${thinCourses === 1 ? '' : 's'} the wall is thinner than a brick (${W} mm): laid one brick wide.`);

  // Lintels: an opening's span, with the bearing either end, in stock steps.
  const bearing = 150 * (L / 215);
  const stock = 150 * (L / 215);
  const lintelMap = new Map<number, number>();
  const openings = openingSpans(bricks, solidAt, j);
  const placedLintels: PlacedLintel[] = [];
  for (const op of openings) {
    const l = op.slot ? Math.round(op.span) : Math.round(Math.ceil((op.span + 2 * bearing) / stock) * stock);
    lintelMap.set(l, (lintelMap.get(l) ?? 0) + 1);
    const lintelCourse = op.slot ? op.course - 1 : op.course;
    placedLintels.push({
      course: lintelCourse,
      x: op.centre.x,
      y: op.centre.y,
      z: lo[2] + lintelCourse * gauge,
      angle: op.angle,
      lengthMm: l,
      depthMm: op.depth,
      heightMm: H,
    });
  }

  // Replace/trim regular bricks in the lintel course that overlap a placed
  // non-slot lintel so the scene shows the concrete lintel beam instead of
  // floating/bridging bricks over the opening.
  if (placedLintels.length > 0) {
    const kept: PlacedBrick[] = [];
    for (const b of bricks) {
      let current: PlacedBrick | null = b;
      for (const ln of placedLintels) {
        if (!current || current.course !== ln.course) continue;
        if (!bricksOverlap2D(current, ln, j * 0.5)) continue;
        const u = { x: Math.cos(ln.angle), y: Math.sin(ln.angle) };
        const align = Math.abs(Math.cos(current.angle) * u.x + Math.sin(current.angle) * u.y);
        if (align < 0.85) {
          // Perpendicular return brick intersecting the lintel's bearing: drop if mostly inside.
          current = null;
          break;
        }
        // Project brick interval onto lintel's axis `u` relative to lintel center.
        const cur: PlacedBrick = current;
        const proj: number = (cur.x - ln.x) * u.x + (cur.y - ln.y) * u.y;
        const bLo: number = proj - cur.lengthMm / 2;
        const bHi: number = proj + cur.lengthMm / 2;
        const clearLo: number = -(ln.lengthMm / 2 + j);
        const clearHi: number = ln.lengthMm / 2 + j;
        const leftRem: number = clearLo - bLo;
        const rightRem: number = bHi - clearHi;
        const minPiece: number = L / 4;
        if (leftRem >= minPiece && rightRem < minPiece) {
          const newMid: number = (bLo + clearLo) / 2;
          const shiftU: number = newMid - proj;
          current = {
            ...cur,
            x: cur.x + u.x * shiftU,
            y: cur.y + u.y * shiftU,
            lengthMm: leftRem,
            cut: true,
          };
        } else if (rightRem >= minPiece && leftRem < minPiece) {
          const newMid: number = (clearHi + bHi) / 2;
          const shiftU: number = newMid - proj;
          current = {
            ...cur,
            x: cur.x + u.x * shiftU,
            y: cur.y + u.y * shiftU,
            lengthMm: rightRem,
            cut: true,
          };
        } else {
          // Fully covered by lintel or remaining stub too short to lay.
          current = null;
          break;
        }
      }
      if (current) kept.push(current);
    }
    bricks.length = 0;
    bricks.push(...kept);
  }

  // Cut pieces: paired out of whole bricks where two fit in one, longest first.
  // Only stretchers: a cut header is trimmed across the brick's width, and what
  // comes off is no brick.
  const cutLens = bricks.filter((b) => b.cut).map((b) => Math.round(b.lengthMm)).sort((x, y) => y - x);
  const cutHeaders = bricks.filter((b) => b.cut && b.header).length;
  const bins: number[] = [];
  const kerf = Math.max(1, j / 3);
  for (const l of bricks.filter((b) => b.cut && !b.header).map((b) => Math.round(b.lengthMm)).sort((x, y) => y - x)) {
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
  const toBuy = Math.ceil((whole + bins.length + cutHeaders + Math.ceil(closers / 2)) * (1 + o.wastagePct / 100));

  const mortarLitres = mortarLitresFor(bricks, std, j);

  // How it holds together, with each lintel in as what it is: a beam in its
  // course bearing on the brickwork either side, so the jambs and courses above
  // are tied together. A quarter brick is the least lap a bond should have.
  const lintels: PlacedBrick[] = placedLintels.map((ln) => ({
    course: ln.course, x: ln.x, y: ln.y, z: ln.z, angle: ln.angle,
    lengthMm: ln.lengthMm, depthMm: ln.depthMm, header: false, closer: false, cut: false, lintel: true,
  }));
  // A quarter brick (with its joint) is the least lap a bond should have,
  // give or take half a joint as the perpends are opened or closed.
  const bond = bondReport([...bricks, ...lintels], j, { lap: (L + j) / 4 - j / 2 });
  bondWarnings(bond, warnings, false);

  return {
    standard: std, bondType: o.bond, jointMm: j, courses,
    modelHeightMm: modelH, builtHeightMm: courses * gauge - j,
    bricks, whole, cutPieces: cutLens.length, closers, toBuy,
    cuts: [...byLen.entries()].sort((a, b) => b[0] - a[0]).map(([lengthMm, count]) => ({ lengthMm, count })),
    mortarLitres, mortarBags: Math.ceil(mortarLitres / MORTAR_BAG_LITRES),
    lintels: [...lintelMap.entries()].sort((a, b) => a[0] - b[0]).map(([lengthMm, count]) => ({ lengthMm, count })),
    ...(placedLintels.length ? { placedLintels } : {}),
    bond, warnings,
  };
}

/** What the bond report means for the builder, said once. */
function bondWarnings(bond: BondReport, warnings: string[], toy: boolean) {
  if (toy && bond.pieces > 1) warnings.push(`It comes apart into ${bond.pieces} pieces: nothing grips them together.`);
  // A part standing on something else (a chimney on its slab) is a piece of
  // its own and fine; pieces side by side with nothing crossing them are not.
  if (!toy && bond.sideBySide > 0) {
    warnings.push(`${bond.sideBySide + 1} pieces of brickwork stand side by side with no brick crossing between them: tie the leaves with wall ties, or lay English or Flemish bond.`);
  }
  // In brickwork a brick over an opening sits on its lintel (listed with
  // the count); only a toy brick can hang on nothing.
  if (toy && bond.unsupported) warnings.push(`${bond.unsupported} brick${bond.unsupported === 1 ? ' has' : 's have'} nothing under ${bond.unsupported === 1 ? 'it' : 'them'}.`);
}

/**
 * Openings: in each course, bricks with nothing under most of them, joined
 * into one span where they sit end to end. Only the first course over an
 * opening counts; the ones above stand on it.
 */
interface Opening {
  span: number; course: number; centre: V2; angle: number; depth: number;
  /** The gap is a slot left for a lintel over a narrower opening below: the lintel is the slot. */
  slot: boolean;
}
function openingSpans(bricks: PlacedBrick[], solidAt: Map<number, (p: V2) => boolean>, j: number): Opening[] {
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
  const spans: Opening[] = [];
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
      let lo = Math.min(...ext) - reachMm, hi = Math.max(...ext) + reachMm;
      // The course below along the wall's middle (and either side of a collar joint).
      const across = ref.depthMm / 4;
      const supportedAt = (t: number) => [-across, 0, across].some((w) =>
        solidBelow({ x: c0.x + u.x * t + n.x * w, y: c0.y + u.y * t + n.y * w }));
      const solidHere = solidAt.get(courses[k]);
      const solidHereAt = (t: number) => !!solidHere && [-across, 0, across].some((w) =>
        solidHere({ x: c0.x + u.x * t + n.x * w, y: c0.y + u.y * t + n.y * w }));
      // The unsupported stretch nearest the middle of the group is the opening.
      // Walk outward while this course continues over the opening so jamb bricks
      // with >=50% solid bearing never hide the jamb beyond `reachMm`.
      const step = Math.max(1, j / 4);
      const maxWalk = 12 * reachMm;
      while (lo > Math.min(...ext) - maxWalk && !supportedAt(lo) && solidHereAt(lo)) lo -= step;
      if (supportedAt(lo)) lo -= step;
      while (hi < Math.max(...ext) + maxWalk && !supportedAt(hi) && solidHereAt(hi)) hi += step;
      if (supportedAt(hi)) hi += step;
      const gaps: [number, number][] = [];
      let from: number | null = null;
      for (let t = lo; t <= hi + step; t += step) {
        const open = t <= hi && !supportedAt(t);
        if (open && from === null) from = t;
        // Only a gap with brickwork both sides is an opening; one open at an
        // end is an overhang.
        if (!open && from !== null) { if (from > lo) gaps.push([from, t]); from = null; }
      }
      const found = gaps.find(([a, b]) => a <= 0 && b >= 0) ?? gaps.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0];
      // Each end to a tenth of a millimetre: a lintel is bought to length.
      const edge = (inSide: number, outSide: number) => {
        let a = inSide, b = outSide;
        for (let i = 0; i < 20 && Math.abs(b - a) > 0.1; i++) { const m = (a + b) / 2; if (supportedAt(m)) b = m; else a = m; }
        return (a + b) / 2;
      };
      const middle = found && [edge(found[0] + step, found[0] - step), edge(found[1] - step, found[1] + step)] as [number, number];
      if (middle && middle[1] > middle[0]) {
        const at = (middle[0] + middle[1]) / 2;
        // A slot: the course under the gap has brickwork at both ends of it
        // and the opening narrower, so the gap is where the lintel is meant
        // to sit, bearing on that brickwork, and it is the lintel's length.
        const twoBelow = solidAt.get(courses[k] - 2);
        const solidTwoBelow = (t: number) => !!twoBelow && [-across, 0, across].some((w) => twoBelow({ x: c0.x + u.x * t + n.x * w, y: c0.y + u.y * t + n.y * w }));
        const slot = solidTwoBelow(middle[0] + 2 * step) && solidTwoBelow(middle[1] - 2 * step) && !solidTwoBelow(at);
        let minN = Infinity, maxN = -Infinity;
        for (const b of group) {
          const projN = (b.x - c0.x) * n.x + (b.y - c0.y) * n.y;
          minN = Math.min(minN, projN - b.depthMm / 2);
          maxN = Math.max(maxN, projN + b.depthMm / 2);
        }
        const depth = Math.max(Math.max(...group.map((x) => x.depthMm)), maxN - minN);
        const midN = Number.isFinite(minN) && Number.isFinite(maxN) ? (minN + maxN) / 2 : 0;
        spans.push({
          span: middle[1] - middle[0], course: courses[k], slot,
          centre: { x: c0.x + u.x * at + n.x * midN, y: c0.y + u.y * at + n.y * midN },
          angle: Math.atan2(u.y, u.x), depth,
        });
      }
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
      ...(source.toyInventory ? { toyInventory: source.toyInventory } : {}),
      ...(source.hollowStuds ? { hollowStuds: source.hollowStuds } : {}),
    },
  );
  const colour = BRICK_COLOURS[source.colour ?? (result.standard.toy ? 'toy' : 'clay')];
  return { geoms: brickworkNodes(result, prefix, [0, 0, 0], colour).flatMap((n) => n.geoms), result };
}

/** Concrete/stone lintel colour (light precast concrete grey). */
const LINTEL_RGBA: [number, number, number, number] = [0.72, 0.71, 0.68, 1];
/** Recessed mortar backing/bedding core colour (warm cement mortar grey). */
const MORTAR_RGBA: [number, number, number, number] = [0.76, 0.74, 0.70, 1];

/**
 * Builds slightly recessed mortar-colored visual backing/bedding strips inside
 * each course's brickwork so masonry walls look solid without see-through air
 * gaps, while stopping recessed inside faces, ends, and opening jambs.
 */
function buildMortarCoreGeoms(
  result: Pick<BrickworkResult, 'bricks' | 'standard' | 'jointMm'>,
  idPrefix: string,
  shift: [number, number, number],
): SceneGeom[] {
  if (result.standard.toy || result.jointMm <= 0 || !result.bricks.length) return [];
  const j = result.jointMm;
  const H = result.standard.heightMm;
  const recess = Math.min(j * 0.4, 4);

  const byCourse = new Map<number, PlacedBrick[]>();
  let minCourse = Infinity;
  let maxCourse = -Infinity;
  for (const b of result.bricks) {
    if (b.course < minCourse) minCourse = b.course;
    if (b.course > maxCourse) maxCourse = b.course;
    const list = byCourse.get(b.course);
    if (list) list.push(b);
    else byCourse.set(b.course, [b]);
  }

  const geoms: SceneGeom[] = [];
  let idx = 0;

  for (const [course, list] of [...byCourse.entries()].sort((a, b) => a[0] - b[0])) {
    const z = list[0].z;
    const zLo = course === minCourse ? z + recess : z;
    const zHi = course < maxCourse ? z + H + j : z + H - recess;
    const heightMm = zHi - zLo;
    if (heightMm <= 0.5) continue;
    const zMid = (zLo + zHi) / 2;

    // Group collinear bricks (same angle mod pi, same transverse offset along n, same depth).
    interface StripGroup {
      angle: number;
      u: V2;
      n: V2;
      nPos: number;
      depthMm: number;
      items: { s0: number; s1: number }[];
    }
    const groups: StripGroup[] = [];
    for (const b of list) {
      let a = ((b.angle % Math.PI) + Math.PI) % Math.PI;
      if (Math.PI - a < 0.01) a = 0;
      const u = { x: Math.cos(a), y: Math.sin(a) };
      const n = { x: -u.y, y: u.x };
      const sMid = b.x * u.x + b.y * u.y;
      const nMid = b.x * n.x + b.y * n.y;
      const s0 = sMid - b.lengthMm / 2;
      const s1 = sMid + b.lengthMm / 2;
      let grp = groups.find(
        (g) =>
          Math.abs(g.angle - a) < 0.02 &&
          Math.abs(g.nPos - nMid) < 1.5 &&
          Math.abs(g.depthMm - b.depthMm) < 1.5,
      );
      if (!grp) {
        grp = { angle: a, u, n, nPos: nMid, depthMm: b.depthMm, items: [] };
        groups.push(grp);
      }
      grp.items.push({ s0, s1 });
    }

    // Merge consecutive bricks along u separated by <= 2.5 * joint into contiguous strips.
    interface Strip {
      angle: number;
      u: V2;
      n: V2;
      s0: number;
      s1: number;
      n0: number;
      n1: number;
    }
    const strips: Strip[] = [];
    for (const grp of groups) {
      grp.items.sort((a, b) => a.s0 - b.s0);
      let curS0 = grp.items[0].s0;
      let curS1 = grp.items[0].s1;
      for (let k = 1; k < grp.items.length; k++) {
        if (grp.items[k].s0 - curS1 <= j * 2.5) {
          curS1 = Math.max(curS1, grp.items[k].s1);
        } else {
          strips.push({
            angle: grp.angle, u: grp.u, n: grp.n,
            s0: curS0, s1: curS1,
            n0: grp.nPos - grp.depthMm / 2, n1: grp.nPos + grp.depthMm / 2,
          });
          curS0 = grp.items[k].s0;
          curS1 = grp.items[k].s1;
        }
      }
      strips.push({
        angle: grp.angle, u: grp.u, n: grp.n,
        s0: curS0, s1: curS1,
        n0: grp.nPos - grp.depthMm / 2, n1: grp.nPos + grp.depthMm / 2,
      });
    }

    // Merge parallel leaves separated by a collar joint (<= 2.5 * joint) with matching s-span
    // so two-leaf walls get a single solid recessed mortar core including the collar joint.
    const merged: Strip[] = [];
    const used = new Array<boolean>(strips.length).fill(false);
    for (let i = 0; i < strips.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      const cur = { ...strips[i] };
      let grew = true;
      while (grew) {
        grew = false;
        for (let k = 0; k < strips.length; k++) {
          if (used[k]) continue;
          const other = strips[k];
          if (Math.abs(other.angle - cur.angle) > 0.02) continue;
          const nGap = Math.max(other.n0 - cur.n1, cur.n0 - other.n1);
          const sOverlap = Math.min(cur.s1, other.s1) - Math.max(cur.s0, other.s0);
          const minSpan = Math.min(cur.s1 - cur.s0, other.s1 - other.s0);
          if (nGap <= j * 2.5 && sOverlap >= minSpan * 0.85 && Math.abs(cur.s0 - other.s0) <= j * 2 && Math.abs(cur.s1 - other.s1) <= j * 2) {
            cur.n0 = Math.min(cur.n0, other.n0);
            cur.n1 = Math.max(cur.n1, other.n1);
            cur.s0 = Math.min(cur.s0, other.s0);
            cur.s1 = Math.max(cur.s1, other.s1);
            used[k] = true;
            grew = true;
          }
        }
      }
      merged.push(cur);
    }

    for (const st of merged) {
      const lengthMm = (st.s1 - st.s0) - 2 * recess;
      const rawDepth = st.n1 - st.n0;
      const depthMm = Math.max(rawDepth - 2 * recess, rawDepth * 0.4);
      if (lengthMm <= 1 || depthMm <= 1) continue;
      const sMid = (st.s0 + st.s1) / 2;
      const nMid = (st.n0 + st.n1) / 2;
      const cx = st.u.x * sMid + st.n.x * nMid;
      const cy = st.u.y * sMid + st.n.y * nMid;
      idx++;
      geoms.push({
        name: `${idPrefix}_mortar_${course + 1}_${idx}`,
        type: 'box',
        role: 'visual',
        size: [lengthMm / 2000, depthMm / 2000, heightMm / 2000],
        pos: [(cx + shift[0]) / 1000, (cy + shift[1]) / 1000, (zMid + shift[2]) / 1000],
        quat: [Math.cos(st.angle / 2), 0, 0, Math.sin(st.angle / 2)],
        rgba: MORTAR_RGBA,
      });
    }
  }
  return geoms;
}

/**
 * Bricks as scene bodies, one per course, every brick a box. `shift` moves
 * them, mm; `colour` paints each (default: clay, or toy red for toy bricks).
 */
export function brickworkNodes(
  result: Pick<BrickworkResult, 'bricks' | 'standard' | 'placedLintels' | 'jointMm'>, idPrefix: string, shift: [number, number, number] = [0, 0, 0], colour?: BrickColour,
  laidFrom?: string,
  includeMortar?: boolean,
): SceneNode[] {
  const paint = colour ?? (result.standard.toy ? toyColour : clayColour);
  const H = result.standard.heightMm;
  const byCourse = new Map<number, PlacedBrick[]>();
  for (const b of result.bricks) {
    const list = byCourse.get(b.course);
    if (list) list.push(b);
    else byCourse.set(b.course, [b]);
  }
  const lintelsByCourse = new Map<number, PlacedLintel[]>();
  for (const ln of result.placedLintels ?? []) {
    const list = lintelsByCourse.get(ln.course);
    if (list) list.push(ln);
    else lintelsByCourse.set(ln.course, [ln]);
    if (!byCourse.has(ln.course)) byCourse.set(ln.course, []);
  }
  let i = 0;
  let lintelIdx = 0;
  const nodes: SceneNode[] = [...byCourse.entries()].sort((a, b) => a[0] - b[0]).map(([course, list]) => {
    const brickGeoms: SceneGeom[] = list.map((b) => {
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
    });
    const lintelGeoms: SceneGeom[] = (lintelsByCourse.get(course) ?? []).map((ln) => {
      lintelIdx++;
      return {
        name: `${idPrefix}_lintel_${course + 1}_${lintelIdx}`,
        type: 'box' as const,
        size: [ln.lengthMm / 2000, ln.depthMm / 2000, ln.heightMm / 2000],
        pos: [(ln.x + shift[0]) / 1000, (ln.y + shift[1]) / 1000, (ln.z + ln.heightMm / 2 + shift[2]) / 1000],
        quat: [Math.cos(ln.angle / 2), 0, 0, Math.sin(ln.angle / 2)],
        rgba: LINTEL_RGBA,
        // Precast concrete lintel.
        density: 2400,
      };
    });
    return {
      id: `${idPrefix}_course_${course + 1}`,
      name: `Course ${course + 1}`,
      type: 'body' as const,
      pos: [0, 0, 0],
      joints: [],
      children: [],
      ...(laidFrom ? { laidFrom } : {}),
      geoms: [...brickGeoms, ...lintelGeoms],
    };
  });
  if (includeMortar) {
    const mortarGeoms = buildMortarCoreGeoms(result, idPrefix, shift);
    if (mortarGeoms.length > 0) {
      nodes.push({
        id: `${idPrefix}_mortar`,
        name: 'Mortar Core',
        type: 'body' as const,
        pos: [0, 0, 0],
        joints: [],
        children: [],
        ...(laidFrom ? { laidFrom } : {}),
        geoms: mortarGeoms,
      });
    }
  }
  return nodes;
}

export type BrickPlacement = 'replace' | 'beside';

/** The colour most of a shape is, as toy bricks a shade either side of it; toy red if it has none. */
function colourOf(scene: SceneGraph): BrickColour | undefined {
  const tally = new Map<string, { rgba: number[]; n: number }>();
  const walk = (nodes: SceneNode[]) => nodes.forEach((n) => {
    for (const g of n.geoms ?? []) {
      if (!g.rgba || g.csg === 'difference') continue;
      const key = g.rgba.slice(0, 3).map((v) => v.toFixed(2)).join(',');
      const t = tally.get(key) ?? { rgba: g.rgba, n: 0 };
      t.n++;
      tally.set(key, t);
    }
    walk(n.children ?? []);
  });
  walk(scene.nodes);
  const top = [...tally.values()].sort((a, b) => b.n - a.n)[0];
  if (!top) return undefined;
  const [r, g, b] = top.rgba;
  return (_brick, i) => {
    const v = jitter(i, 0.04);
    return [Math.min(1, Math.max(0, r + v)), Math.min(1, Math.max(0, g + v)), Math.min(1, Math.max(0, b + v)), 1];
  };
}

/**
 * The scene with a body (or everything, for null) laid in brick: the
 * brickwork in its place, or beside it along +X.
 */
export function brickworkInScene(
  scene: SceneGraph,
  bodyId: string | null,
  opts: Partial<BrickworkOptions> & { placement?: BrickPlacement } = {},
): { nodes: SceneNode[]; result: BrickworkResult } {
  const subject = subjectScene(scene, bodyId);
  const result = layBricks(subject, opts);
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
  // Toy bricks come in every colour: they take the model's, so a grey castle
  // builds grey. Real bricks are the colour bricks are.
  const from = bodyId ?? '*';
  const laid = brickworkNodes(
    result,
    prefix,
    shift,
    result.standard.toy ? colourOf(subject) : undefined,
    opts.placement === 'beside' ? from : undefined,
    opts.includeMortar,
  );
  // Keep anything not laid in brick, including hinged/jointed subtrees hung off a replaced parent body.
  const withoutWholeScene = (list: SceneNode[]): SceneNode[] => list.flatMap((n) => {
    if (!laidWithScene(n)) return [n];
    const keptChildren = withoutWholeScene(n.children ?? []);
    return keptChildren.length ? [{ ...n, geoms: [], children: keptChildren }] : [];
  });
  const withoutBody = (list: SceneNode[]): SceneNode[] => list.flatMap((n) => {
    if (n.id === bodyId) {
      const keptChildren = withoutWholeScene(n.children ?? []);
      return keptChildren.length ? [{ ...n, geoms: [], children: keptChildren }] : [];
    }
    return [n.children?.length ? { ...n, children: withoutBody(n.children) } : n];
  });
  // Laid beside again from the same model: the courses laid before go.
  const kept = opts.placement === 'beside' ? scene.nodes.filter((n) => n.laidFrom !== from) : (bodyId ? withoutBody(scene.nodes) : withoutWholeScene(scene.nodes));
  return { nodes: [...kept, ...laid], result };
}
