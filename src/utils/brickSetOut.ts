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
    const clashPad = -Math.min(1, dims.W * 0.05);
    const clash = walls.some((v) => {
      for (let a = 0.1; a < 1; a += 0.2) {
        for (const b of [0.1, 0.3, 0.5, 0.7, 0.9]) {
          if (inWall(v, add(add(w.o, mul(w.u, w.length * a)), mul(w.n, w.thickness * b)), clashPad)) return true;
        }
      }
      return false;
    });
    if (!clash) walls.push(w);
  }
  // A wall that carries straight on along the same outside face at much the
  // same thickness (a side wall reaching a pier) is one wall: laid as one,
  // at the thinner thickness, with no joint where the two readings met.
  const leavesOf = (t: number) => Math.max(1, Math.round((t + dims.j) / (dims.W + dims.j)));
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < walls.length && !merged; i++) {
      for (let k = 0; k < walls.length && !merged; k++) {
        const A = walls[i], B = walls[k];
        if (i === k || dot(A.u, B.u) < 0.9999) continue;
        if (Math.abs(dot(sub(B.o, A.o), A.n)) > 1) continue;
        const gap = dot(sub(B.o, A.o), A.u) - A.length;
        if (gap < -1 || gap > dims.j + 1) continue;
        if (leavesOf(A.thickness) !== leavesOf(B.thickness) || Math.abs(A.thickness - B.thickness) > dims.W * 0.4) continue;
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
        return !inside(p) || walls.some((v, vi) => vi !== wi && inWall(v, p, -1e-3));
      };
      let depth = 0;
      while (depth < 3 * w.thickness + 50 && !open(depth + step / 2)) depth += step;
      // To a hundredth of a millimetre: a corner 102.5 deep read as 100 put every
      // wall 2.5 mm out at each end, and small scale joints (0.5–0.8 mm) leave no slack.
      if (depth > 0) {
        let lo = depth, hi = depth + step;
        while (hi - lo > 0.01) { const mid = (lo + hi) / 2; if (open(mid)) hi = mid; else lo = mid; }
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
    /** Graduated lap penalty at T/cross junctions so an unavoidable short lap never picks a dead-on severing seam. */
    graduatedLap?: boolean;
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
    const every = Math.max(1, Math.round(Math.max(dims.j / 4, (opts.anyCut.max - opts.anyCut.min) / 64) / step));
    for (let c = Math.ceil(opts.anyCut.min / step); c <= Math.floor(opts.anyCut.max / step); c += every) {
      if (!all.some((p) => p.kind === opts.anyCut!.kind && p.len === c)) {
        const short = (opts.anyCut.kind === 'S' || opts.anyCut.kind === 'P') && c * step < dims.W - dims.j / 2 ? 1.5 : 0;
        all.push({ kind: opts.anyCut.kind, len: c, cost: 2.5 + short });
      }
    }
  }
  // Whether a joint at each grid position would sit on one below, worked out
  // once rather than at every step of the search. The nearer the seam below,
  // the heavier the penalty at junctions, so when a full lap cannot be had it
  // still picks the widest lap there is rather than a dead-on straight joint.
  const nearPenalty = new Float32Array(q + jq + 2);
  const lapQ = lap / step;
  for (const b of below) {
    const bq = b / step;
    for (let at = Math.max(0, Math.ceil(bq - lapQ)); at <= Math.min(q + jq + 1, Math.floor(bq + lapQ)); at++) {
      const d = Math.abs(bq - at) * step;
      if (d < lap) {
        const pen = opts.graduatedLap ? 10 + 15 * (1 - d / lap) : 10;
        if (pen > nearPenalty[at]) nearPenalty[at] = pen;
      }
    }
  }
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
        if (end > (p === 0 ? q : q + 1)) return;
        const lastKind = last ? kinds[last - 1] : null;
        if (pc.kind === 'Q' && lastKind === 'Q') return;
        // A queen closer goes beside a corner (first, or last when ending at a quoin).
        const nearQuoin = p === 0 || (opts.endWith === 'Q' && Math.abs(q - end) <= slack);
        let c = here + pc.cost + (pc.kind === 'Q' && !nearQuoin ? (opts.closerMidCost ?? 5) : 0);
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
        const total = c + (nearPenalty[Math.round(end + jq / 2)] ?? 0);
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
  // More than they can take: the rest evenly, never closing a joint past 40% of j.
  if (gaps.length && Math.abs(spare) > 1e-6) {
    for (let i = 0; i < gaps.length; i++) gaps[i] = Math.max(-j * 0.6, gaps[i] + spare / gaps.length);
  }
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
  const leavesOf = (t: number) => Math.max(1, Math.round((t + j) / (W + j)));
  // English bond: a course is headers on one face and stretchers on the
  // return, so which it is goes by the wall's direction, and the wall in its
  // stretcher course is the one that runs through the corner.
  const parity = (w: Wall) => (Math.abs(w.u.x) >= Math.abs(w.u.y) ? 0 : 1);
  const headerCourseOf = (w: Wall) => bond === 'english' && (c + parity(w)) % 2 === 1;
  const keyScale = Math.max(1, W / 8);
  const nodeKey = (node: NodeEnd[]) => {
    const c0 = (node[0] as NodeEnd & { centre?: V2 }).centre ?? { x: 0, y: 0 };
    return `${Math.round(c0.x / keyScale)},${Math.round(c0.y / keyScale)}`;
  };
  const wallSig = (w: Wall) => {
    const flip = w.u.x < -0.01 || (Math.abs(w.u.x) <= 0.01 && w.u.y < 0);
    const ux = flip ? -w.u.x : w.u.x, uy = flip ? -w.u.y : w.u.y;
    return `${Math.round(ux * 10)},${Math.round(uy * 10)}`;
  };
  const orientWall = (w: Wall, uRef: V2): { w: Wall; flipped: boolean } =>
    dot(w.u, uRef) >= 0
      ? { w, flipped: false }
      : {
        w: { o: add(add(w.o, mul(w.u, w.length)), mul(w.n, w.thickness)), u: mul(w.u, -1), n: mul(w.n, -1), length: w.length, thickness: w.thickness },
        flipped: true,
      };
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
  const splices: [NodeEnd, NodeEnd][] = [];
  const brickThick = (e: NodeEnd) => leavesOf(walls[e.wall].thickness) === 2;
  for (const node of nodes) {
    const ordered = [...node].sort((a, b) => a.wall - b.wall || Number(a.atStart) - Number(b.atStart));
    if (ordered.length >= 3) {
      // A T-junction or cross-junction: two axes meet. One axis runs straight
      // through (splicing collinear arms across the junction) and the other
      // stops a joint short, alternating every course.
      const ax0 = ordered.filter((e) => Math.abs(dot(walls[e.wall].u, walls[ordered[0].wall].u)) > 0.7);
      const ax1 = ordered.filter((e) => !ax0.includes(e));
      const axes = ax1.length ? [ax0, ax1].sort((a, b) => parity(walls[a[0].wall]) - parity(walls[b[0].wall])) : [ax0];
      let winAxis = axes[0];
      if (bond !== 'stack' && axes.length > 1) {
        const stretchAxis = bond === 'english' && ordered.every(brickThick)
          ? axes.find((ax) => !headerCourseOf(walls[ax[0].wall]))
          : undefined;
        winAxis = stretchAxis ?? axes[(c + (strategy === 'pinwheel' ? 1 : 0)) % axes.length];
      }
      const key = nodeKey(node), sig = wallSig(walls[winAxis[0].wall]);
      owned.set(key, sig);
      if (args.owners?.get(key) === sig) cost += 50;
      const canSplice = winAxis.length === 2 &&
        leavesOf(walls[winAxis[0].wall].thickness) === leavesOf(walls[winAxis[1].wall].thickness) &&
        Math.abs(walls[winAxis[0].wall].thickness - walls[winAxis[1].wall].thickness) <= W * 0.4;
      if (canSplice) {
        splices.push([winAxis[0], winAxis[1]]);
      } else {
        winAxis.forEach((e, idx) => {
          const amount = idx === 0 ? e.depth : -j;
          if (e.atStart) { ext[e.wall].start = amount; cornered[e.wall].start = idx > 0; }
          else { ext[e.wall].end = amount; cornered[e.wall].end = idx > 0; }
        });
      }
      for (const e of ordered) {
        if (winAxis.includes(e)) continue;
        if (e.atStart) { ext[e.wall].start = -j; cornered[e.wall].start = false; }
        else { ext[e.wall].end = -j; cornered[e.wall].end = false; }
      }
      continue;
    }
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
    if (bond === 'english' && ordered.every(brickThick)) {
      const stretching = ordered.filter((e) => !headerCourseOf(walls[e.wall]));
      if (stretching.length === 1) owner = stretching[0];
    }
    if (ordered.length > 1) {
      const key = nodeKey(node), sig = wallSig(walls[owner.wall]);
      owned.set(key, sig);
      if (args.owners?.get(key) === sig) cost += 50;
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

  // Stepped collinear reveals: a short 1-leaf corner pier continuing the outer
  // face of a 2-leaf wall shares its outer leaf on stretcher courses and stops
  // a joint short on header/Flemish courses.
  const skipWall = new Uint8Array(walls.length);
  const revealStub = new Uint8Array(walls.length);
  walls.forEach((stub, si) => {
    if (leavesOf(stub.thickness) !== 1 || stub.length > L + W) return;
    if (splices.some(([a, b]) => a.wall === si || b.wall === si)) return;
    walls.forEach((main, mi) => {
      if (mi === si || skipWall[si] || leavesOf(main.thickness) !== 2) return;
      if (dot(stub.u, main.u) < 0.9999 || Math.abs(dot(sub(stub.o, main.o), main.n)) > 2) return;
      const gapAfterMain = dot(sub(stub.o, main.o), main.u) - main.length;
      const gapBeforeMain = dot(sub(main.o, stub.o), stub.u) - stub.length;
      const mainStretching = !(bond === 'english' && headerCourseOf(main)) && bond !== 'flemish';
      if (gapAfterMain >= -1 && gapAfterMain <= j + 1) {
        revealStub[si] = 1;
        if (mainStretching) {
          const extra = gapAfterMain + stub.length + ext[si].end;
          ext[mi].end = extra;
          innerStop[mi].end += extra;
          skipWall[si] = 1;
        } else {
          ext[si].start = -j - gapAfterMain;
        }
      } else if (gapBeforeMain >= -1 && gapBeforeMain <= j + 1) {
        revealStub[si] = 1;
        if (mainStretching) {
          const extra = gapBeforeMain + stub.length + ext[si].start;
          ext[mi].start = extra;
          innerStop[mi].start += extra;
          skipWall[si] = 1;
        } else {
          ext[si].end = -j - gapBeforeMain;
        }
      }
    });
  });

  // Build effective strips, chaining collinear walls spliced across T/cross junctions.
  interface StripSpec {
    w: Wall;
    extStart: number;
    extEnd: number;
    cornerStart: boolean;
    cornerEnd: boolean;
    innerStart: number;
    innerEnd: number;
    junctions: [number, number][];
    reveal: boolean;
  }
  const strips: StripSpec[] = [];
  const visited = new Uint8Array(walls.length);
  const adj = walls.map(() => [] as number[]);
  for (const [a, b] of splices) {
    adj[a.wall].push(b.wall);
    adj[b.wall].push(a.wall);
  }
  for (let wi = 0; wi < walls.length; wi++) {
    if (visited[wi] || skipWall[wi]) continue;
    if (!adj[wi].length) {
      visited[wi] = 1;
      strips.push({
        w: walls[wi],
        extStart: ext[wi].start, extEnd: ext[wi].end,
        cornerStart: cornered[wi].start, cornerEnd: cornered[wi].end,
        innerStart: innerStop[wi].start, innerEnd: innerStop[wi].end,
        junctions: [],
        reveal: revealStub[wi] === 1,
      });
      continue;
    }
    const comp: number[] = [];
    const q = [wi];
    visited[wi] = 1;
    while (q.length) {
      const cur = q.shift()!;
      comp.push(cur);
      for (const nx of adj[cur]) if (!visited[nx] && !skipWall[nx]) { visited[nx] = 1; q.push(nx); }
    }
    const uRef = walls[comp[0]].u;
    const segs = comp.map((idx) => {
      const { w: ow, flipped } = orientWall(walls[idx], uRef);
      return {
        idx, w: ow, flipped,
        pos: dot(ow.o, uRef),
        extStart: flipped ? ext[idx].end : ext[idx].start,
        extEnd: flipped ? ext[idx].start : ext[idx].end,
        cornerStart: flipped ? cornered[idx].end : cornered[idx].start,
        cornerEnd: flipped ? cornered[idx].start : cornered[idx].end,
        innerStart: flipped ? innerStop[idx].end : innerStop[idx].start,
        innerEnd: flipped ? innerStop[idx].start : innerStop[idx].end,
      };
    }).sort((a, b) => a.pos - b.pos);
    const first = segs[0], last = segs[segs.length - 1];
    const aligned = segs.every((sg) => Math.abs(dot(sub(sg.w.o, first.w.o), first.w.n)) <= 2);
    if (!aligned) {
      for (const sg of segs) {
        strips.push({
          w: walls[sg.idx],
          extStart: ext[sg.idx].start, extEnd: ext[sg.idx].end,
          cornerStart: cornered[sg.idx].start, cornerEnd: cornered[sg.idx].end,
          innerStart: innerStop[sg.idx].start, innerEnd: innerStop[sg.idx].end,
          junctions: [],
          reveal: revealStub[sg.idx] === 1,
        });
      }
      continue;
    }
    const totalLen = dot(sub(last.w.o, first.w.o), uRef) + last.w.length;
    const minThick = Math.min(...segs.map((sg) => sg.w.thickness));
    const junctions: [number, number][] = [];
    for (let m = 1; m < segs.length; m++) {
      const s0 = dot(sub(segs[m - 1].w.o, first.w.o), uRef) + segs[m - 1].w.length;
      const s1 = dot(sub(segs[m].w.o, first.w.o), uRef);
      if (s1 > s0) junctions.push([s0, s1]);
    }
    strips.push({
      w: { o: first.w.o, u: first.w.u, n: first.w.n, length: totalLen, thickness: minThick },
      extStart: first.extStart, extEnd: last.extEnd,
      cornerStart: first.cornerStart, cornerEnd: last.cornerEnd,
      innerStart: first.innerStart, innerEnd: last.innerEnd,
      junctions,
      reveal: false,
    });
  }

  // Set out on an eighth-joint grid (1.25 mm for a 10 mm joint), bounded so a
  // tiny mortar joint (0.5 mm) on a multi-metre wall never blows up the DP.
  const maxWallLen = Math.max(L, ...strips.map((st) => st.w.length + Math.max(0, st.extStart) + Math.max(0, st.extEnd)));
  const setOutStep = Math.max(0.1, j / 8, L / 250, maxWallLen / 4000);
  const hasJunction = nodes.some((n) => n.length >= 3);
  const lap = L / 4;
  let headerless = 0;
  strips.forEach((st) => {
    const { w } = st;
    const leaves = leavesOf(w.thickness);
    const o = add(w.o, mul(w.u, -st.extStart));
    const length = w.length + st.extStart + st.extEnd;
    if (length < L / 4) return;
    // Joints of the course below along this wall, per leaf (a header's on every leaf).
    const belowSeams: number[][] = Array.from({ length: leaves }, () => []);
    if (args.below.length === 0 && bond !== 'stack') {
      // On the first course there is no course below yet, but a corner this
      // wall runs through now will be owned by the return wall on the next
      // course, putting a corner joint at ext + j / 2 (and, if two leaves
      // deep, a collar joint between the return's leaves at W + j / 2).
      if (st.extStart > 0) {
        if (st.innerStart > 0) belowSeams[0].push(W + j / 2);
        else {
          belowSeams.forEach((list) => list.push(st.extStart + j / 2));
          if (st.extStart > W + j) belowSeams.forEach((list) => list.push(W + j / 2));
        }
      }
      if (st.extEnd > 0) {
        if (st.innerEnd > 0) belowSeams[0].push(length - W - j / 2);
        else {
          belowSeams.forEach((list) => list.push(length - st.extEnd - j / 2));
          if (st.extEnd > W + j) belowSeams.forEach((list) => list.push(length - W - j / 2));
        }
      }
      for (const [j0, j1] of st.junctions) {
        belowSeams.forEach((list) => {
          list.push(st.extStart + j0 - j / 2, st.extStart + j1 + j / 2);
          if (j1 - j0 > W + j) list.push(st.extStart + j0 + W + j / 2);
        });
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
    const hDepth = Math.min(w.thickness, L);
    const hPad = (w.thickness - hDepth) / 2;
    const lay = (kind: Kind, s: number, along: number, leaf: number) => {
      const at = add(add(o, mul(w.u, s)), mul(w.n, leaf * (W + j)));
      // Never over a brick already laid: what is left is the fallback's.
      const depth = kind === 'S' ? W : kind === 'P' ? w.thickness : hDepth;
      const origin = kind === 'H' || kind === 'Q' ? add(at, mul(w.n, hPad)) : at;
      actions.push(() => {
      if (!args.layer.free(origin, w.u, w.n, along, depth)) return;
      if (kind === 'S') args.layer.lay(origin, w.u, w.n, along, W, { header: false, closer: false, cut: along < L - j / 2 });
      else if (kind === 'H') args.layer.lay(origin, w.u, w.n, along, hDepth, { header: true, closer: false, cut: along < W - j / 2 });
      else if (kind === 'Q') args.layer.lay(origin, w.u, w.n, along, hDepth, { header: true, closer: true, cut: false });
      else { // a stretcher on each leaf
        for (let k = 0; k < leaves; k++) {
          const off = k === leaves - 1 && leaves > 1 ? Math.max(k * (W + j), w.thickness - W) : k * (W + j);
          const p = add(add(o, mul(w.u, s)), mul(w.n, off));
          args.layer.lay(p, w.u, w.n, along, W, { header: false, closer: false, cut: along < L - j / 2 });
        }
      }
      });
    };
    const placeAll = (plan: ({ kind: Kind; len: number; gapAfter?: number }[] & { cost?: number }) | null, leaf: number, joint = j) => {
      if (!plan) return;
      cost += plan.cost ?? 0;
      let s = 0;
      for (const p of plan) { lay(p.kind, s, p.len, leaf); s += p.len + joint + (p.gapAfter ?? 0); }
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
        if (!st.reveal) headerless++;
      } else if (bond === 'english') {
        // A header course, set out like the rest: whole headers, a cut one,
        // and a closer beside each corner the return runs through. Where a
        // scale brick's 2W + j differs slightly from L (mini_6, mini_12),
        // butter header perpends to keep gauge with the stretchers below.
        const jH = Math.abs(L - 2 * W - j) <= 0.6 * j && L - 2 * W + j > 0 ? (L - 2 * W + j) / 2 : j;
        placeAll(setOutStrip(length, [
          { kind: 'H', len: W, cost: 0 },
          { kind: 'Q', len: (W - jH) / 2, cost: 0.6 },
        ], belowSeams.flat(), { ...dims, j: jH }, setOutStep, lap, {
          anyCut: { kind: 'H', min: W / 2, max: W - jH }, closerMidCost: 0.9, graduatedLap: hasJunction,
          ...(st.cornerStart ? { startWith: 'Q' as Kind } : {}), ...(st.cornerEnd ? { endWith: 'Q' as Kind } : {}),
        }), 0, jH);
        return;
      } else {
        const merged = belowSeams.flat();
        const plan = setOutStrip(length, [
          { kind: 'H', len: W, cost: 0 },
          { kind: 'P', len: L, cost: 0 },
          { kind: 'Q', len: (W - j) / 2, cost: 0.3 },
          { kind: 'P', len: (3 * L - j) / 4, cost: 0.6 },
          { kind: 'P', len: (L - j) / 2, cost: 0.6 },
        ], merged, dims, setOutStep, lap, { alternate: true, first: c % 2 === 0 ? 'H' : 'P', anyCut: { kind: 'P', min: L / 4, max: L - j }, graduatedLap: hasJunction });
        placeAll(plan, 0);
        return;
      }
    }
    // Stretchers, leaf by leaf; stack bond keeps its joints in line. An
    // inner leaf of a wall running through an English or stretcher corner
    // stops a joint short of it.
    for (let k = 0; k < leaves; k++) {
      const s0 = k > 0 ? st.innerStart : 0, s1 = k > 0 ? st.innerEnd : 0;
      const leafLength = length - s0 - s1;
      if (leafLength < L / 4) continue;
      const plan = setOutStrip(leafLength, stretchers, bond === 'stack' ? [] : belowSeams[k].map((x) => x - s0), dims, setOutStep, lap,
        { anyCut: { kind: 'S', min: L / 4, max: L - j }, mid: length / 2 - s0, graduatedLap: hasJunction });
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
