/**
 * A section through a part: the cut a drawing makes to show what the outside
 * views cannot — a pocket's depth, a channel's round floor, a wall's
 * thickness.
 *
 * The part is cut by a plane square to the view's line of sight (w), and the
 * cut face is built as a thin slab: its front at the plane, facing the
 * camera, its walls along the outline of the cut. That slab is an ordinary
 * part as far as viewDimensions is concerned, so the section is dimensioned
 * by the same rules as every view — its steps, its radii, its holes — with
 * nothing special about sections in the measuring.
 *
 * Everything is world space, document frame (Z-up), metres. Pure: three is
 * used only for its polygon triangulation.
 */
import { ShapeUtils, Vector2 } from 'three';
import type { BodyMesh } from './viewDimensions';
import { VIEW_AXES, type DrawingView } from './cameraViews';

type Vec3 = [number, number, number];

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The slab's thickness behind the plane: thin, but more than a rounding error. */
const SLAB_M = 0.0005;
/** Points this close are one point: the cut lands on shared edges of separate pieces. */
const WELD_M = 1e-7;
/** How many planes to try across the part when choosing where to cut. */
const TRIES = 33;
/** Planes scoring within this of the best are as good, and the one nearest the middle wins. */
const SCORE_TIE = 0.002;
/** Planes tried either side of the pick, within one step, to find the hollowest near it. */
const REFINE = 4;
/** A cut whose outline spans less than this share of the part's box on the sheet is a sliver. */
const MIN_BOX = 0.25;

/**
 * The outline of the cut where the plane `dot(p, normal) = offset` crosses
 * the mesh: closed loops of points on the plane. A mesh need not be welded:
 * crossings are matched by where they are, not by vertex index.
 */
export function sliceLoops(positions: ArrayLike<number>, faces: ArrayLike<number>, normal: Vec3, offset: number): Vec3[][] {
  const side = (i: number) => dot([positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]], normal) - offset;
  const key = (p: Vec3) => `${Math.round(p[0] / WELD_M)},${Math.round(p[1] / WELD_M)},${Math.round(p[2] / WELD_M)}`;
  const points = new Map<string, Vec3>();
  const links = new Map<string, string[]>();
  const cross = (i: number, j: number, di: number, dj: number): string => {
    const t = di / (di - dj);
    const p: Vec3 = [0, 1, 2].map((k) => positions[i * 3 + k] + t * (positions[j * 3 + k] - positions[i * 3 + k])) as Vec3;
    const id = key(p);
    if (!points.has(id)) points.set(id, p);
    return id;
  };
  const link = (a: string, b: string) => {
    if (a === b) return;
    (links.get(a) ?? links.set(a, []).get(a)!).push(b);
    (links.get(b) ?? links.set(b, []).get(b)!).push(a);
  };
  for (let t = 0; t + 2 < faces.length; t += 3) {
    const v = [faces[t], faces[t + 1], faces[t + 2]];
    // A vertex on the plane counts as in front of it, so every triangle is
    // cut cleanly through two of its edges or not at all.
    const d = v.map((i) => side(i)).map((x) => (Math.abs(x) < 1e-12 ? 1e-12 : x));
    const ends: string[] = [];
    for (let e = 0; e < 3; e++) {
      const a = e, b = (e + 1) % 3;
      if ((d[a] > 0) !== (d[b] > 0)) ends.push(cross(v[a], v[b], d[a], d[b]));
    }
    if (ends.length === 2) link(ends[0], ends[1]);
  }
  // Walk each loop. A clean solid gives every point two links.
  const loops: Vec3[][] = [];
  const used = new Set<string>();
  for (const start of links.keys()) {
    if (used.has(start)) continue;
    const loop: Vec3[] = [];
    let prev = '';
    let at = start;
    while (at && !used.has(at)) {
      used.add(at);
      loop.push(points.get(at)!);
      const next = (links.get(at) ?? []).find((n) => n !== prev && !used.has(n));
      prev = at;
      at = next ?? '';
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/** A loop on the sheet: its points' (u, v). */
export type Flat = [number, number][];

/**
 * Merges the cuts of a part's pieces into one outline: each piece's loops
 * in, the union's loops out. A part built from several solids that overlap
 * (a box with a cylinder pushed into it) is never merged into one mesh, and
 * its pieces' loops overlap on the cut; told apart by parity alone, the
 * overlap would read as a hole. The union needs a polygon library, so the
 * caller brings it (see sectionMerge).
 */
export type Merge = (pieces: Flat[][]) => Flat[];

/** The cut's outline on the sheet: every piece's loops, merged into one outline when they are several. */
function cutOutline(pieces: BodyMesh[], view: DrawingView, offset: number, merge?: Merge): Flat[] {
  const { w, u, v } = planeAxes(view);
  const per = pieces
    .map((piece) => sliceLoops(piece.positions, piece.faces, w, offset)
      .map((loop) => simplify(loop.map((p) => [dot(p, u), dot(p, v)] as [number, number])))
      .filter((loop) => loop.length >= 3))
    .filter((loops) => loops.length);
  const loops = per.length > 1 && merge ? merge(per).map(simplify) : per.flat();
  return loops.filter((loop) => loop.length >= 3);
}

function area(loop: Flat): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x0, y0] = loop[i], [x1, y1] = loop[(i + 1) % loop.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

function inside(p: [number, number], loop: Flat): boolean {
  let hit = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i], [xj, yj] = loop[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Within this (the sine of the angle), three points in a row are on one line. */
const COLLINEAR = 1e-4;

/**
 * A loop with its points on straight runs dropped. A cut crosses a long facet
 * through both its triangles, so a straight run, or one facet of a round,
 * comes back as several points in a line; the edge finder wants one segment
 * per facet, as the part itself has.
 */
function simplify(loop: Flat): Flat {
  let out = loop;
  for (let changed = true; changed && out.length > 3;) {
    changed = false;
    const keep: Flat = [];
    for (let i = 0; i < out.length; i++) {
      const a = keep.length ? keep[keep.length - 1] : out[(i - 1 + out.length) % out.length];
      const b = out[i], c = out[(i + 1) % out.length];
      const ab = [b[0] - a[0], b[1] - a[1]], bc = [c[0] - b[0], c[1] - b[1]];
      const lab = Math.hypot(ab[0], ab[1]), lbc = Math.hypot(bc[0], bc[1]);
      if (lab < 1e-9 || (lbc > 1e-9 && Math.abs(ab[0] * bc[1] - ab[1] * bc[0]) < COLLINEAR * lab * lbc && ab[0] * bc[0] + ab[1] * bc[1] > 0)) {
        changed = true;
        continue;
      }
      keep.push(b);
    }
    out = keep;
  }
  return out;
}

/** How many other loops each loop lies inside: even is material's outline, odd a hole in it. */
function depths(flat: Flat[]): number[] {
  return flat.map((loop, i) => flat.reduce((n, other, j) => n + (j !== i && inside(loop[0], other) ? 1 : 0), 0));
}

/** The sheet's right and up for a view: the plane's own axes. */
function planeAxes(view: DrawingView) {
  const { forward, right, up } = VIEW_AXES[view];
  return { w: forward as Vec3, u: right as Vec3, v: up as Vec3 };
}

/** The area of a loop's convex hull. */
function hullArea(loop: Flat): number {
  const pts = [...loop].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const turn = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: Flat) => {
    const out: Flat = [];
    for (const p of list) {
      while (out.length >= 2 && turn(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return Math.abs(area([...half(pts), ...half([...pts].reverse())]));
}

/**
 * The cut's material area and how hollow it is: one less the share of its
 * outlines' convex hulls that is material — how much is carved out of the
 * material's own envelope. A cut through a tray's channels is hollow; one
 * through the wall between them is not, nor one through a row of pegs, each
 * a solid disc, nor a slice off the tip of a cone.
 */
function measure(flat: Flat[]): { material: number; hollow: number; box: number } {
  if (!flat.length) return { material: 0, hollow: 0, box: 0 };
  const deep = depths(flat);
  let material = 0, envelope = 0, u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  flat.forEach((loop, i) => {
    material += (deep[i] % 2 === 0 ? 1 : -1) * Math.abs(area(loop));
    if (deep[i] === 0) envelope += hullArea(loop);
    for (const [x, y] of loop) {
      u0 = Math.min(u0, x); u1 = Math.max(u1, x); v0 = Math.min(v0, y); v1 = Math.max(v1, y);
    }
  });
  const box = (u1 - u0) * (v1 - v0);
  return { material, hollow: envelope > 0 ? Math.max(0, 1 - material / envelope) : 0, box };
}

/** How far into the part along the line of sight, as a share of its depth, a cut at `at` (0–1) is. */
export function sectionPlane(body: BodyMesh, view: DrawingView, at: number): { normal: Vec3; offset: number; lo: number; hi: number } {
  const { w } = planeAxes(view);
  let lo = Infinity, hi = -Infinity;
  const p = body.positions;
  for (let i = 0; i + 2 < p.length; i += 3) {
    const d = p[i] * w[0] + p[i + 1] * w[1] + p[i + 2] * w[2];
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return { normal: w, offset: lo + Math.min(1, Math.max(0, at)) * (hi - lo), lo, hi };
}

/**
 * Where to cut when nobody has said: the plane across the part that shows the
 * most — the hollowest cut, and of cuts about as hollow, the one nearest the
 * middle. The answer is a share of the part's depth, 0 at the near side.
 */
export function bestSectionAt(body: BodyMesh, view: DrawingView, pieces: BodyMesh[] = [body], merge?: Merge): number {
  // The part's own box on the sheet, which a cut worth showing spans a fair share of.
  const { u, v } = planeAxes(view);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let i = 0; i + 2 < body.positions.length; i += 3) {
    const q = [body.positions[i], body.positions[i + 1], body.positions[i + 2]];
    const x = dot(q, u), y = dot(q, v);
    u0 = Math.min(u0, x); u1 = Math.max(u1, x); v0 = Math.min(v0, y); v1 = Math.max(v1, y);
  }
  const whole = (u1 - u0) * (v1 - v0);
  // A sliver through a few pegs is all hollow and shows nothing.
  const fairCut = (m: { material: number; box: number }) => m.material > 0 && m.box >= MIN_BOX * whole;
  const scored: { at: number; hollow: number }[] = [];
  for (let k = 1; k <= TRIES; k++) {
    const at = k / (TRIES + 1);
    const { offset } = sectionPlane(body, view, at);
    const m = measure(cutOutline(pieces, view, offset, merge));
    if (fairCut(m)) scored.push({ at, hollow: m.hollow });
  }
  if (!scored.length) return 0.5;
  const fair = scored;
  const best = Math.max(...fair.map((s) => s.hollow));
  let pick = fair[0];
  for (const s of fair) {
    if (s.hollow >= best - SCORE_TIE && (pick.hollow < best - SCORE_TIE || Math.abs(s.at - 0.5) < Math.abs(pick.at - 0.5))) pick = s;
  }
  // Then the hollowest cut near it: the middle of the channel it went
  // through, not a side of it a step away.
  const step = 1 / (TRIES + 1);
  let refined = pick;
  for (let k = -REFINE; k <= REFINE; k++) {
    const at = pick.at + (k / REFINE) * step;
    const { offset } = sectionPlane(body, view, at);
    const m = measure(cutOutline(pieces, view, offset, merge));
    if (fairCut(m) && m.hollow > refined.hollow + 1e-9) refined = { at, hollow: m.hollow };
  }
  return refined.at;
}

/** The cut face as the overlay draws it: its loops, and the triangles that fill it. */
export interface Section {
  loops: Vec3[][];
  /** Filled triangles on the plane, flat xyz. */
  fill: number[];
  /** The cut face as a thin slab, for viewDimensions. */
  body: BodyMesh;
}

/**
 * The section of a part on the plane at `offset` along the view's line of
 * sight: its outline, its fill, and the slab that stands for it when it is
 * dimensioned. Null where the plane misses the part. A part drawn as several
 * pieces is cut piece by piece and the cuts merged by `merge`.
 */
export function sectionOf(body: BodyMesh, view: DrawingView, offset: number, pieces: BodyMesh[] = [body], merge?: Merge): Section | null {
  const { w, u, v } = planeAxes(view);
  const flat = cutOutline(pieces, view, offset, merge);
  if (!flat.length) return null;
  const deep = depths(flat);
  // Material outlines and their holes, each loop turned the way the
  // triangulator and the walls below expect: outlines anticlockwise.
  const turned = flat.map((loop, i) => {
    const ccw = area(loop) > 0;
    return (deep[i] % 2 === 0) === ccw ? loop : [...loop].reverse();
  });
  const at = (x: number, y: number, depth: number): Vec3 =>
    [0, 1, 2].map((k) => u[k] * x + v[k] * y + w[k] * depth) as Vec3;
  const positions: number[] = [];
  const faces: number[] = [];
  const fill: number[] = [];
  const vertex = (p: Vec3) => { positions.push(...p); return positions.length / 3 - 1; };
  // Seen down w, u × v points back at the camera: an anticlockwise outline's
  // triangles, in order, face it. The back cap faces away.
  for (let i = 0; i < turned.length; i++) {
    if (deep[i] % 2 !== 0) continue;
    const holes = turned.filter((_, j) => deep[j] === deep[i] + 1 && inside(turned[j][0], turned[i]));
    const contour = turned[i].map(([x, y]) => new Vector2(x, y));
    const holePoints = holes.map((h) => h.map(([x, y]) => new Vector2(x, y)));
    const tris = ShapeUtils.triangulateShape(contour, holePoints);
    const all = [...turned[i], ...holes.flat()];
    const front = all.map(([x, y]) => vertex(at(x, y, offset)));
    const back = all.map(([x, y]) => vertex(at(x, y, offset + SLAB_M)));
    for (const tri of tris) {
      // Anticlockwise on the sheet, whatever order the triangulator gave.
      const [a, b, c] = area([all[tri[0]], all[tri[1]], all[tri[2]]]) >= 0 ? tri : [tri[0], tri[2], tri[1]];
      faces.push(front[a], front[b], front[c], back[a], back[c], back[b]);
      for (const k of [a, b, c]) fill.push(...at(all[k][0], all[k][1], offset));
    }
  }
  // The walls: along each loop, outward. An outline runs anticlockwise with
  // the material on its left, a hole clockwise with it on its left too, so
  // the same winding faces out for both.
  for (const loop of turned) {
    for (let i = 0; i < loop.length; i++) {
      const [x0, y0] = loop[i], [x1, y1] = loop[(i + 1) % loop.length];
      const a = vertex(at(x0, y0, offset)), b = vertex(at(x1, y1, offset));
      const c = vertex(at(x1, y1, offset + SLAB_M)), d = vertex(at(x0, y0, offset + SLAB_M));
      faces.push(a, d, c, a, c, b);
    }
  }
  return {
    loops: turned.map((loop) => loop.map(([x, y]) => at(x, y, offset))),
    fill,
    body: { id: body.id, positions, faces, frame: body.frame },
  };
}

/**
 * The 45° hatching of a cut face, as a drawing marks a section: line pairs,
 * flat xyz, `spacing` apart on the sheet, on the plane at `offset`. Each
 * hatch line is cut where it crosses the outlines, and kept where it is in
 * material — in an outline, out of its holes.
 */
export function hatchSegments(loops: Vec3[][], view: DrawingView, offset: number, spacing: number): number[] {
  const { w, u, v } = planeAxes(view);
  const s2 = Math.SQRT1_2;
  // Along the hatch, and across it.
  const along: Vec3 = [0, 1, 2].map((k) => (u[k] + v[k]) * s2) as Vec3;
  const across: Vec3 = [0, 1, 2].map((k) => (u[k] - v[k]) * s2) as Vec3;
  const edges: [number, number, number, number][] = [];
  let lo = Infinity, hi = -Infinity;
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length];
      const e: [number, number, number, number] = [dot(a, across), dot(a, along), dot(b, across), dot(b, along)];
      edges.push(e);
      lo = Math.min(lo, e[0], e[2]);
      hi = Math.max(hi, e[0], e[2]);
    }
  }
  const out: number[] = [];
  if (!(spacing > 0) || !edges.length) return out;
  const point = (c: number, t: number) => [0, 1, 2].map((k) => across[k] * c + along[k] * t + w[k] * offset);
  for (let c = Math.ceil(lo / spacing) * spacing; c <= hi; c += spacing) {
    const hits: number[] = [];
    for (const [c0, t0, c1, t1] of edges) {
      // Half-open, so a line through a vertex counts it once.
      if ((c0 > c) === (c1 > c)) continue;
      hits.push(t0 + ((c - c0) / (c1 - c0)) * (t1 - t0));
    }
    hits.sort((a, b) => a - b);
    for (let i = 0; i + 1 < hits.length; i += 2) out.push(...point(c, hits[i]), ...point(c, hits[i + 1]));
  }
  return out;
}
