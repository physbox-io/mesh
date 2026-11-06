// Setting out brickwork as a bricklayer does: wall by wall.
//
// A course's slice is read as walls: every straight face paired with the
// parallel face opposite it, the gap between them the wall's thickness in
// leaves. Where walls meet (a corner, a junction) is a node; at each node one
// wall runs through, which one alternating course by course, and the others
// stop a joint short of it. A stopped end or an opening's side is just the
// end of a wall.
//
// Each wall is then a straight strip, laid in its bond as units across its
// thickness:
//   stretcher (or stack) — each leaf a row of stretchers;
//   English — stretcher courses as stretcher bond, header courses as headers
//     right across a one-brick wall, a queen closer beside the first;
//   Flemish — header and stretcher in turn along a one-brick wall, the
//     stretcher backed by another, a queen closer where a course starts with
//     a header.
// The pieces along a strip are whole bricks, three-quarter and half bats and
// closers, and a cut of any length only as a last resort; which, and where,
// is chosen against the joints of the course below (a small dynamic
// programme), so that every joint laps the one below by at least a quarter
// brick wherever the strip allows.
//
// Whatever is not a straight wall (a curve, a lump) is left for the face-by-
// face laying in brickwork.ts, which only fills what this leaves free.
//
// Millimetres; the slice's loops have the material on their left.

import type { PlacedBrick } from './brickwork';
import type { Point2D } from './laserCutExporter';

type V2 = Point2D;
const sub = (a: V2, b: V2): V2 => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: V2, b: V2): V2 => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: V2, k: number): V2 => ({ x: a.x * k, y: a.y * k });
const dot = (a: V2, b: V2) => a.x * b.x + a.y * b.y;
const len = (a: V2) => Math.hypot(a.x, a.y);

/** A straight stretch of face: from a to b, material on its left. */
interface Face { a: V2; b: V2; u: V2; n: V2; length: number; outer: boolean }

/** A straight wall: its outer face from `o` along `u`, thickness inward along `n`. */
export interface Wall { o: V2; u: V2; n: V2; length: number; thickness: number }

/** Where walls meet: each wall end that runs into it, and how far through it is. */
interface NodeEnd { wall: number; atStart: boolean; depth: number }

export interface BrickDims { L: number; W: number; H: number; j: number }

/** Straight faces of the loops, split at corners; curves are left out. */
function facesOf(loops: V2[][], outerFlags: boolean[]): Face[] {
  // Join collinear neighbours within each closed loop (including across its start/end seam).
  const sameLine = (p: Face, q: Face) =>
    dot(p.u, q.u) > 0.9999 && len(sub(p.b, q.a)) < 0.5 && Math.abs(dot(sub(q.b, p.a), p.n)) < 0.5;
  const merged: Face[] = [];
  loops.forEach((loop, li) => {
    const ring: Face[] = [];
    const n = loop.length;
    for (let i = 0; i < n; i++) {
      const a = loop[i], b = loop[(i + 1) % n];
      const d = sub(b, a), l = len(d);
      if (l < 1) continue;
      const u = mul(d, 1 / l);
      const f: Face = { a, b, u, n: { x: -u.y, y: u.x }, length: l, outer: outerFlags[li] };
      const last = ring[ring.length - 1];
      if (last && sameLine(last, f)) {
        last.b = f.b;
        last.length = len(sub(last.b, last.a));
      } else {
        ring.push(f);
      }
    }
    if (ring.length > 1 && sameLine(ring[ring.length - 1], ring[0])) {
      const tail = ring.pop()!;
      ring[0].a = tail.a;
      ring[0].length = len(sub(ring[0].b, ring[0].a));
    }
    merged.push(...ring);
  });
  // A facet of a curve is not a wall: a face that turns gently into the next
  // at both ends (a polygon round a tower) is left to the face-by-face laying.
  const turn = (f: Face, g: Face) => Math.acos(Math.max(-1, Math.min(1, dot(f.u, g.u))));
  return merged.filter((f, i) => {
    const prev = merged.find((g) => len(sub(g.b, f.a)) < 0.5);
    const next = merged.find((g) => len(sub(g.a, f.b)) < 0.5);
    const gentle = (g: Face | undefined) => !!g && turn(f, g) < Math.PI / 6;
    void i;
    return !(gentle(prev) && gentle(next));
  });
}

/**
 * The walls of a slice: each face with the nearest antiparallel face opposite
 * it, over the stretch where both are. `inside` says whether a point is
 * material.
 */
export function findWalls(loops: V2[][], outerFlags: boolean[], inside: (p: V2) => boolean, dims: BrickDims): Wall[] {
  const faces = facesOf(loops, outerFlags);
  const candidates: (Wall & { outer: boolean })[] = [];
  const minT = dims.W * 0.6, maxT = 2 * dims.L + 2 * dims.j + 5;
  faces.forEach((A, ai) => {
    // Every face opposite, nearest first, each over the stretch of A no
    // nearer one has taken: an outside face can be opposite the inside of a
    // room along most of its length and an opening's side near its end.
    const opposite: { t: number; o0: number; o1: number }[] = [];
    faces.forEach((B, bi) => {
      if (bi === ai || dot(A.u, B.u) > -0.999) return;
      const t = dot(sub(B.a, A.a), A.n);
      if (t < minT || t > maxT) return;
      const s0 = dot(sub(B.b, A.a), A.u), s1 = dot(sub(B.a, A.a), A.u);
      const o0 = Math.max(0, Math.min(s0, s1)), o1 = Math.min(A.length, Math.max(s0, s1));
      if (o1 - o0 < dims.W) return;
      opposite.push({ t, o0, o1 });
    });
    opposite.sort((a, b) => a.t - b.t);
    const taken: [number, number][] = [];
    for (const { t, o0, o1 } of opposite) {
      // What of [o0, o1] is not taken yet.
      let pieces: [number, number][] = [[o0, o1]];
      for (const [a, b] of taken) pieces = pieces.flatMap(([x, y]) => (b <= x || a >= y ? [[x, y]] : [[x, Math.min(y, a)], [Math.max(x, b), y]].filter(([p, q]) => q - p > 1)) as [number, number][]);
      for (const [x, y] of pieces) {
        if (y - x < dims.W) continue;
        const mid = add(A.a, mul(A.u, (x + y) / 2));
        if (!inside(add(mid, mul(A.n, t / 2)))) continue;
        candidates.push({ o: add(A.a, mul(A.u, x)), u: A.u, n: A.n, length: y - x, thickness: t, outer: A.outer });
        taken.push([x, y]);
      }
    }
  });
  // The same brickwork can read two ways (a pier 333 × 215 is a stub of the
  // front wall, or a 333-thick wall the other way). Thinnest first, then
  // longest, each kept only where nothing kept already is; of a wall's two
  // faces, the outside one.
  // Of a wall's two faces, the one further from the middle of the slice is
  // its outside, the face that is seen: closers and quoins belong there.
  let cx = 0, cy = 0, cnt = 0;
  for (const l of loops) for (const p of l) { cx += p.x; cy += p.y; cnt++; }
  const middle = { x: cx / Math.max(1, cnt), y: cy / Math.max(1, cnt) };
  const outward = (w: Wall) => dot(sub(middle, add(w.o, mul(w.u, w.length / 2))), w.n);
  // To the millimetre: a wall's two readings agree only to rounding.
  candidates.sort((a, b) => Math.round(a.thickness) - Math.round(b.thickness) || Math.round(b.length) - Math.round(a.length) || outward(b) - outward(a));
  const walls: Wall[] = [];
  for (const w of candidates) {
    // Shorter than it is thick is usually the same block read the other way
    // (a chimney's back read across, a pier read sideways), with air past
    // both its ends. Unless it turns a corner at one end: then it is the
    // stub of a wall between that corner and an opening, and a wall.
    if (w.length < w.thickness - 1) {
      const past = (s: number) => inside(add(add(w.o, mul(w.u, s)), mul(w.n, w.thickness / 2)));
      if (!past(-dims.j) && !past(w.length + dims.j)) continue;
    }
    const clash = walls.some((v) => {
      for (let a = 0.1; a < 1; a += 0.2) {
        for (const b of [0.1, 0.3, 0.5, 0.7, 0.9]) {
          if (inWall(v, add(add(w.o, mul(w.u, w.length * a)), mul(w.n, w.thickness * b)), -1)) return true;
        }
      }
      return false;
    });
    if (!clash) walls.push(w);
  }
  // A wall that carries straight on along the same outside face at much the
  // same thickness (a side wall reaching a pier) is one wall: laid as one,
  // at the thinner thickness, with no joint where the two readings met.
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < walls.length && !merged; i++) {
      for (let k = 0; k < walls.length && !merged; k++) {
        const A = walls[i], B = walls[k];
        if (i === k || dot(A.u, B.u) < 0.9999) continue;
        if (Math.abs(dot(sub(B.o, A.o), A.n)) > 1) continue;
        const gap = dot(sub(B.o, A.o), A.u) - A.length;
        if (gap < -1 || gap > dims.j + 1 || Math.abs(A.thickness - B.thickness) > dims.W) continue;
        walls[i] = { o: A.o, u: A.u, n: A.n, length: A.length + gap + B.length, thickness: Math.min(A.thickness, B.thickness) };
        walls.splice(k, 1);
        merged = true;
      }
    }
  }
  return walls;
}

/** Whether a point lies in a wall's strip. */
function inWall(w: Wall, p: V2, pad = 0): boolean {
  const d = sub(p, w.o);
  const s = dot(d, w.u), q = dot(d, w.n);
  return s > -pad && s < w.length + pad && q > -pad && q < w.thickness + pad;
}

/**
 * The nodes: what lies past each wall end, if it is material (a corner or a
 * junction) rather than air (a stopped end). Ends that run into the same
 * square are grouped.
 */
function findNodes(walls: Wall[], inside: (p: V2) => boolean, step: number): NodeEnd[][] {
  const ends: (NodeEnd & { centre: V2 })[] = [];
  walls.forEach((w, wi) => {
    for (const atStart of [true, false]) {
      const dir = atStart ? mul(w.u, -1) : w.u;
      const from = add(atStart ? w.o : add(w.o, mul(w.u, w.length)), mul(w.n, w.thickness / 2));
      const open = (d: number) => {
        const p = add(from, mul(dir, d));
        return !inside(p) || walls.some((v, vi) => vi !== wi && inWall(v, p, -1));
      };
      let depth = 0;
      while (depth < 3 * w.thickness + 50 && !open(depth + step / 2)) depth += step;
      // To a tenth of a millimetre: a corner 102.5 deep read as 100 put every
      // wall 2.5 mm out at each end, and an 88 mm cut in every course.
      if (depth > 0) {
        let lo = depth, hi = depth + step;
        while (hi - lo > 0.1) { const mid = (lo + hi) / 2; if (open(mid)) hi = mid; else lo = mid; }
        depth = lo;
      }
      if (depth >= step) ends.push({ wall: wi, atStart, depth, centre: add(from, mul(dir, depth / 2)) });
    }
  });
  // Ends whose squares meet are one node.
  const groups: (NodeEnd & { centre: V2 })[][] = [];
  for (const e of ends) {
    const g = groups.find((grp) => grp.some((f) => len(sub(f.centre, e.centre)) < Math.max(e.depth, f.depth, walls[e.wall].thickness)));
    if (g) g.push(e);
    else groups.push([e]);
  }
  return groups;
}

/** A piece along a strip: kind, length along it, and its cost before joints. */
type Kind = 'S' | 'H' | 'P' | 'Q';
interface Piece { kind: Kind; len: number; cost: number }

/**
 * The pieces along a strip, chosen by dynamic programme: whole units free,
 * bats and closers a little, a cut of any length more, and a joint within
 * `lap` of one below a lot. `alternate`: Flemish, header and stretcher in turn.
 */
function setOutStrip(
  length: number, pieces: Piece[], below: number[], dims: BrickDims, step: number, lap: number,
  opts: {
    alternate?: boolean; first?: Kind; anyCut?: { kind: Kind; min: number; max: number };
    /** Must start (end) with this kind: a queen closer beside a corner. */
    startWith?: Kind; endWith?: Kind;
    /** What a closer costs away from the start (broken bond). Default: 5. */
    closerMidCost?: number;
    /** Middle of the wall along this strip, mm (default: length / 2). */
    mid?: number;
  } = {},
): ({ kind: Kind; len: number; gapAfter: number }[] & { cost: number }) | null {
  const q = Math.round(length / step);
  const midQ = opts.mid !== undefined ? opts.mid / step : q / 2;
  const jq = Math.max(1, Math.round(dims.j / step));
  const all: Piece[] = pieces.map((p) => ({ ...p, len: Math.round(p.len / step) }));
  if (opts.anyCut) {
    // A cut of any length on the set-out grid: an English bond laps the
    // headers below within a few millimetres, and a cut in 10 mm steps
    // could not get back into step after one. A stretcher cut shorter than a
    // header (2 * lap - j) puts two perpends closer than 2 * lap, which the
    // next course cannot lap without a straight joint, so it costs more.
    const every = Math.max(1, Math.round(dims.j / (4 * step)));
    for (let c = Math.ceil(opts.anyCut.min / step); c <= Math.floor(opts.anyCut.max / step); c += every) {
      if (!all.some((p) => p.kind === opts.anyCut!.kind && p.len === c)) {
        const short = (opts.anyCut.kind === 'S' || opts.anyCut.kind === 'P') && c * step < dims.W - dims.j / 2 ? 1.5 : 0;
        all.push({ kind: opts.anyCut.kind, len: c, cost: 2.5 + short });
      }
    }
  }
  // Whether a joint at each grid position would sit on one below, worked out
  // once rather than at every step of the search. The nearer the seam below,
  // the heavier the penalty, so when a full lap cannot be had it still picks
  // the widest lap there is rather than a dead-on straight joint.
  const nearAt = new Uint8Array(q + jq + 2);
  const lapQ = lap / step;
  for (const b of below) {
    const bq = b / step;
    for (let at = Math.max(0, Math.ceil(bq - lapQ)); at <= Math.min(q + jq + 1, Math.floor(bq + lapQ)); at++) {
      if (Math.abs(bq - at) * step < lap) nearAt[at] = 1;
    }
  }
  const near = (at: number) => nearAt[Math.round(at)] === 1;
  const kinds: Kind[] = ['S', 'H', 'P', 'Q'];
  const K = kinds.length + 1;
  const ki = (k: Kind) => kinds.indexOf(k) + 1;
  const N = q + jq + 2;
  const cost = new Float64Array(N * K).fill(Infinity);
  const back = new Int32Array(N * K).fill(-1);
  const how = new Int32Array(N * K);
  cost[0] = 0;
  // The last piece may leave up to a joint's slack, taken up in the perpends
  // near the middle. (Fitting exactly instead, with a cut, measured worse on
  // a house: more cuts, and twice the short laps.)
  const slack = jq;
  let best = Infinity, bestState = -1, bestPiece = -1;
  for (let p = 0; p <= q; p++) {
    for (let last = 0; last < K; last++) {
      const here = cost[p * K + last];
      if (here === Infinity) continue;
      all.forEach((pc, i) => {
        const end = p + pc.len;
        if (end > q + 1) return;
        const lastKind = last ? kinds[last - 1] : null;
        if (pc.kind === 'Q' && lastKind === 'Q') return;
        // A queen closer goes beside the corner, first in the strip, and nowhere else.
        let c = here + pc.cost + (pc.kind === 'Q' && p !== 0 ? (opts.closerMidCost ?? 5) : 0);
        // A cut (not a standard bat or closer) at either end of the strip,
        // beside a corner or an opening, costs more: on site the quoin is a
        // whole brick and the cut goes in the middle, where the bond breaks.
        const odd = pc.cost >= 2.5;
        if (odd && (p === 0 || Math.abs(q - end) <= slack)) c += 1.5;
        // And the further from the middle, the more: the broken bond goes in
        // the middle of the wall, not a brick in from the corner.
        if (odd) c += Math.abs((p + end) / 2 - midQ) / Math.max(1, q);
        if (p === 0 && opts.startWith && pc.kind !== opts.startWith) c += 20;
        if (opts.alternate && pc.kind !== 'Q') {
          if (lastKind && lastKind !== 'Q' && lastKind === pc.kind) c += 3;
          if (!lastKind || lastKind === 'Q') { if (opts.first && pc.kind !== opts.first) c += 1; }
        }
        if (Math.abs(q - end) <= slack) {
          const fin = c + (opts.endWith && pc.kind !== opts.endWith ? 20 : 0);
          if (fin < best) { best = fin; bestState = p * K + last; bestPiece = i; }
        }
        const next = end + jq;
        if (next > q) return;
        const total = c + (near(end + jq / 2) ? 10 : 0);
        const st = next * K + ki(pc.kind);
        if (total < cost[st]) { cost[st] = total; back[st] = p * K + last; how[st] = i; }
      });
    }
  }
  if (bestPiece < 0) return null;
  const out = [{ kind: all[bestPiece].kind, len: all[bestPiece].len * step }];
  for (let st = bestState; st >= K; st = back[st]) out.unshift({ kind: all[how[st]].kind, len: all[how[st]].len * step });
  return Object.assign(fillJoints(out, length, dims.j), { cost: best });
}

/**
 * Takes up what the pieces leave of the strip in the joints, not the bricks:
 * a brick is the size it is. Each joint opens or closes by the same amount;
 * a single piece keeps its size and leaves the rest at its end.
 */
function fillJoints<T extends { len: number }>(out: T[], length: number, j: number): (T & { gapAfter: number })[] {
  const used = out.reduce((t, p) => t + p.len, 0) + j * (out.length - 1);
  let spare = length - used;
  const gaps = new Array(Math.max(0, out.length - 1)).fill(0);
  // In the joints nearest the middle, a few millimetres each, as a
  // bricklayer opens or closes perpends where nobody sights along them; the
  // ends stay true, and so does the bond over the course below at each end.
  // (Spread over every joint, a few millimetres drifted the joints along a
  // long wall far enough to break an English bond's quarter-brick lap.)
  const most = j * 0.3;
  const order = gaps.map((_, i) => i).sort((a, b) => Math.abs(a - (gaps.length - 1) / 2) - Math.abs(b - (gaps.length - 1) / 2));
  for (const i of order) {
    if (Math.abs(spare) < 1e-6) break;
    const take = Math.max(-most, Math.min(most, spare));
    gaps[i] += take;
    spare -= take;
  }
  // More than they can take: the rest evenly, as before.
  if (gaps.length && Math.abs(spare) > 1e-6) for (let i = 0; i < gaps.length; i++) gaps[i] += spare / gaps.length;
  return out.map((p, i) => ({ ...p, gapAfter: i < gaps.length ? gaps[i] : 0 }));
}

export interface StripLayer {
  /** Whether a brick there would touch nothing already laid. */
  free(o: V2, u: V2, n: V2, along: number, depth: number): boolean;
  /** Lays a brick: origin on the outer face line, along u for `along`, into the wall for `depth`, from `offset` in. */
  lay(o: V2, u: V2, n: V2, along: number, depth: number, flags: { header: boolean; closer: boolean; cut: boolean }): void;
}

/**
 * One course of every straight wall in a slice. Returns the bricks it laid
 * through `layer`, so the caller marks its grid and keeps its list.
 */
export function layWalls(args: {
  loops: V2[][];
  outerFlags: boolean[];
  inside: (p: V2) => boolean;
  dims: BrickDims;
  bond: 'stretcher' | 'stack' | 'english' | 'flemish';
  course: number;
  below: PlacedBrick[];
  step: number;
  layer: StripLayer;
  /**
   * Who ran through each corner in the course below, kept from course to
   * course by the caller: a corner given to the same wall twice running is
   * a straight joint up it.
   */
  owners?: Map<string, string>;
}): { headerless: number } {
  const { dims, bond, course: c } = args;
  const { L, W, j } = dims;
  const walls = findWalls(args.loops, args.outerFlags, args.inside, dims);
  const nodes = findNodes(walls, args.inside, args.step);
  // English bond: a course is headers on one face and stretchers on the
  // return, so which it is goes by the wall's direction, and the wall in its
  // stretcher course is the one that runs through the corner.
  const parity = (w: Wall) => (Math.abs(w.u.x) >= Math.abs(w.u.y) ? 0 : 1);
  const headerCourseOf = (w: Wall) => bond === 'english' && (c + parity(w)) % 2 === 1;
  const nodeKey = (node: NodeEnd[]) => {
    const c0 = (node[0] as NodeEnd & { centre?: V2 }).centre ?? { x: 0, y: 0 };
    return `${Math.round(c0.x / 10)},${Math.round(c0.y / 10)}`;
  };
  const wallSig = (w: Wall) => `${Math.round(w.u.x)},${Math.round(w.u.y)}`;
  const attempt = (strategy: 'pinwheel' | 'pairs') => {
  const actions: (() => void)[] = [];
  const owned = new Map<string, string>();
  let cost = 0;
  // Each wall's ends: how far it runs on (through a node it owns this course)
  // or stops short (a joint, against the one that does).
  const ext = walls.map(() => ({ start: 0, end: 0 }));
  // Which ends meet a wall that runs through (so start with a closer), and how
  // far short of a corner a running wall's inner leaves stop.
  const cornered = walls.map(() => ({ start: false, end: false }));
  const innerStop = walls.map(() => ({ start: 0, end: 0 }));
  for (const node of nodes) {
    const ordered = [...node].sort((a, b) => a.wall - b.wall || Number(a.atStart) - Number(b.atStart));
    let owner = ordered.length > 1 ? ordered[(bond === 'stack' ? 0 : c) % ordered.length] : ordered[0];
    // A plain corner, one wall ending and the next starting: alternate courses
    // give it to the wall starting there and the one ending there, so round a
    // ring of walls (a chimney) each wall owns one corner a course, a
    // pinwheel that turns the other way the next.
    if (ordered.length === 2 && ordered[0].atStart !== ordered[1].atStart) {
      if (strategy === 'pinwheel') {
        const want = bond === 'stack' ? true : c % 2 === 0;
        owner = ordered.find((e) => e.atStart === want)!;
      } else {
        // Opposite walls in pairs: the walls one way own their corners one
        // course, the walls the other way the next (a box of whole bricks).
        const want = bond === 'stack' ? 0 : c % 2;
        owner = ordered.find((e) => parity(walls[e.wall]) === want) ?? owner;
      }
    }
    // English, where the walls are a brick thick (headers need it): the wall
    // in its stretcher course runs through.
    const brickThick = (e: NodeEnd) => Math.round((walls[e.wall].thickness + j) / (W + j)) === 2;
    if (bond === 'english' && ordered.every(brickThick)) {
      const stretching = ordered.filter((e) => !headerCourseOf(walls[e.wall]));
      if (stretching.length === 1) owner = stretching[0];
    }
    if (ordered.length > 1) {
      const key = nodeKey(node), sig = wallSig(walls[owner.wall]);
      owned.set(key, sig);
      if (args.owners?.get(key) === sig) cost += 10;
    }
    for (const e of ordered) {
      let amount = e === owner ? e.depth : -j;
      // English: only the running wall's outside leaf goes through the
      // corner; the return's header course comes in to a leaf from the
      // outside, so its queen closer sits beside the quoin header.
      if (bond === 'english' && ordered.every(brickThick) && e !== owner && headerCourseOf(walls[e.wall]) && e.depth >= W + j) amount = e.depth - (W + j);
      if (e.atStart) { ext[e.wall].start = amount; cornered[e.wall].start = e !== owner; }
      else { ext[e.wall].end = amount; cornered[e.wall].end = e !== owner; }
      if (e === owner && bond === 'english' && ordered.every(brickThick)) innerStop[e.wall][e.atStart ? 'start' : 'end'] = e.depth + j;
    }
  }
  const lap = L / 4;
  // Set out on an eighth-joint grid (1.25 mm for a 10 mm joint): a UK header
  // (102.5), three-quarter bat (158.75), closer (46.25) and joint (10) all
  // fall on it exactly, so a course of headers does not drift off its lap.
  const setOutStep = Math.max(0.1, j / 8);
  let headerless = 0;
  walls.forEach((w, wi) => {
    const leaves = Math.max(1, Math.round((w.thickness + j) / (W + j)));
    const o = add(w.o, mul(w.u, -ext[wi].start));
    const length = w.length + ext[wi].start + ext[wi].end;
    if (length < L / 4) return;
    // Joints of the course below along this wall, per leaf (a header's on every leaf).
    const belowSeams: number[][] = Array.from({ length: leaves }, () => []);
    if (args.below.length === 0 && bond !== 'stack') {
      // On the first course there is no course below yet, but a corner this
      // wall runs through now will be owned by the return wall on the next
      // course, putting a corner joint at ext + j / 2 (and, if two leaves
      // deep, a collar joint between the return's leaves at W + j / 2).
      if (ext[wi].start > 0) {
        if (innerStop[wi].start > 0) belowSeams[0].push(W + j / 2);
        else {
          belowSeams.forEach((list) => list.push(ext[wi].start + j / 2));
          if (ext[wi].start > W + j) belowSeams.forEach((list) => list.push(W + j / 2));
        }
      }
      if (ext[wi].end > 0) {
        if (innerStop[wi].end > 0) belowSeams[0].push(length - W - j / 2);
        else {
          belowSeams.forEach((list) => list.push(length - ext[wi].end - j / 2));
          if (ext[wi].end > W + j) belowSeams.forEach((list) => list.push(length - W - j / 2));
        }
      }
    }
    for (const b of args.below) {
      const bu = { x: Math.cos(b.angle), y: Math.sin(b.angle) };
      if (Math.abs(dot(bu, w.u)) < 0.01) {
        // A brick of the return wall running through this corner in the course
        // below: its inner side (and the collar joint between its leaves) is a
        // seam this wall must lap across so the corner ties both leaves.
        const bn = { x: -bu.y, y: bu.x };
        for (const e of [1, -1]) {
          const p = add({ x: b.x, y: b.y }, mul(bn, e * (b.depthMm / 2 + j / 2)));
          const s = dot(sub(p, o), w.u), qn = dot(sub(p, o), w.n);
          if (s < lap || s > length - lap || qn < -1 || qn > w.thickness + 1) continue;
          belowSeams.forEach((list) => list.push(s));
        }
        continue;
      }
      if (Math.abs(dot(bu, w.u)) < 0.99) continue;
      for (const e of [1, -1]) {
        const p = add({ x: b.x, y: b.y }, mul(bu, e * (b.lengthMm / 2 + j / 2)));
        const s = dot(sub(p, o), w.u), qn = dot(sub(p, o), w.n);
        if (s < -lap || s > length + lap || qn < -1 || qn > w.thickness + 1) continue;
        if (b.depthMm > W + 1) belowSeams.forEach((list) => list.push(s));
        else belowSeams[Math.min(leaves - 1, Math.max(0, Math.floor(qn / (W + j))))].push(s);
      }
    }
    const lay = (kind: Kind, s: number, along: number, leaf: number) => {
      const at = add(add(o, mul(w.u, s)), mul(w.n, leaf * (W + j)));
      // Never over a brick already laid: what is left is the fallback's.
      const depth = kind === 'S' ? W : kind === 'P' ? w.thickness : w.thickness;
      actions.push(() => {
      if (!args.layer.free(at, w.u, w.n, along, depth)) return;
      if (kind === 'S') args.layer.lay(at, w.u, w.n, along, W, { header: false, closer: false, cut: along < L - j / 2 });
      else if (kind === 'H') args.layer.lay(at, w.u, w.n, along, w.thickness, { header: true, closer: false, cut: along < W - j / 2 });
      else if (kind === 'Q') args.layer.lay(at, w.u, w.n, along, w.thickness, { header: true, closer: true, cut: false });
      else { // a stretcher on each leaf
        for (let k = 0; k < leaves; k++) {
          const p = add(add(o, mul(w.u, s)), mul(w.n, k * (W + j)));
          args.layer.lay(p, w.u, w.n, along, W, { header: false, closer: false, cut: along < L - j / 2 });
        }
      }
      });
    };
    const placeAll = (plan: ({ kind: Kind; len: number; gapAfter?: number }[] & { cost?: number }) | null, leaf: number) => {
      if (!plan) return;
      cost += plan.cost ?? 0;
      let s = 0;
      for (const p of plan) { lay(p.kind, s, p.len, leaf); s += p.len + j + (p.gapAfter ?? 0); }
    };
    const stretchers: Piece[] = [
      { kind: 'S', len: L, cost: 0 },
      { kind: 'S', len: (3 * L - j) / 4, cost: 0.6 },
      { kind: 'S', len: (L - j) / 2, cost: 0.6 },
    ];
    const headerCourse = headerCourseOf(w);
    const twoLeaves = leaves === 2;
    if ((bond === 'english' && headerCourse) || bond === 'flemish') {
      if (!twoLeaves) {
        headerless++;
      } else if (bond === 'english') {
        // A header course, set out like the rest: whole headers, a cut one,
        // and a closer beside each corner the return runs through, or
        // anywhere a broken bond needs one to get back into step.
        placeAll(setOutStrip(length, [
          { kind: 'H', len: W, cost: 0 },
          { kind: 'Q', len: (W - j) / 2, cost: 0.6 },
        ], belowSeams.flat(), dims, setOutStep, lap, {
          anyCut: { kind: 'H', min: W / 2, max: W - j }, closerMidCost: 0.9,
          ...(cornered[wi].start ? { startWith: 'Q' as Kind } : {}), ...(cornered[wi].end ? { endWith: 'Q' as Kind } : {}),
        }), 0);
        return;
      } else {
        const merged = belowSeams.flat();
        const plan = setOutStrip(length, [
          { kind: 'H', len: W, cost: 0 },
          { kind: 'P', len: L, cost: 0 },
          { kind: 'Q', len: (W - j) / 2, cost: 0.3 },
          { kind: 'P', len: (3 * L - j) / 4, cost: 0.6 },
          { kind: 'P', len: (L - j) / 2, cost: 0.6 },
        ], merged, dims, setOutStep, lap, { alternate: true, first: c % 2 === 0 ? 'H' : 'P', anyCut: { kind: 'P', min: L / 4, max: L - j } });
        placeAll(plan, 0);
        return;
      }
    }
    // Stretchers, leaf by leaf; stack bond keeps its joints in line. An
    // inner leaf of a wall running through an English or stretcher corner
    // stops a joint short of it.
    for (let k = 0; k < leaves; k++) {
      const s0 = k > 0 ? innerStop[wi].start : 0, s1 = k > 0 ? innerStop[wi].end : 0;
      const leafLength = length - s0 - s1;
      if (leafLength < L / 4) continue;
      const plan = setOutStrip(leafLength, stretchers, bond === 'stack' ? [] : belowSeams[k].map((x) => x - s0), dims, setOutStep, lap,
        { anyCut: { kind: 'S', min: L / 4, max: L - j }, mid: length / 2 - s0 });
      if (!plan) continue;
      cost += plan.cost ?? 0;
      let s = s0;
      for (const p of plan) { lay(p.kind, s, p.len, k); s += p.len + j + (p.gapAfter ?? 0); }
    }
  });
  return { actions, cost, headerless, owned };
  };
  // Which wall runs through each corner is chosen course by course: as a
  // pinwheel (round a chimney, each wall owning one corner) or in opposite
  // pairs (round a box of whole bricks): whichever sets out cheaper.
  const tries = bond === 'stack' ? [attempt('pairs')] : [attempt('pinwheel'), attempt('pairs')];
  const best = tries.reduce((a, b) => (b.cost < a.cost ? b : a));
  for (const act of best.actions) act();
  if (args.owners) { args.owners.clear(); for (const [k, v] of best.owned) args.owners.set(k, v); }
  return { headerless: best.headerless };
}
