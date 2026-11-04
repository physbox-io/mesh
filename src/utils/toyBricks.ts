// Toy bricks: a shape built from interlocking studded bricks on an 8 mm grid,
// in as few bricks as hold together.
//
// Each course is a grid of stud cells; a cell is the shape's if a quarter of
// it is inside the slice, so a thin board still gets a row. Hollow, only the
// cells within a few studs of the outside are kept, and a roof corbelled in
// a stud a course so no roof brick hangs on nothing; open underneath.
//
// A course is tiled from the bottom up, biggest brick first from each free
// cell in turn (and only bricks still in hand, if the builder has said how
// many they have), each placement weighed by:
//   - the cells it covers: every one is a brick not needed later, which is
//     what keeps the count down,
//   - a seam sitting on a seam in the course below (a straight joint, the
//     line it comes apart along),
//   - resting wholly on one brick below (it ties nothing together),
//   - gripping nothing below at all, which is all but forbidden: over an
//     opening, a brick must reach a stud beside it.
// Alternate courses scan the other way, and several scans from different
// corners are tried, keeping the cheapest.

// Millimetres; no mortar. Each brick is 0.2 mm short of its grid, as real
// ones are, so neighbours do not touch.

import type { PlacedBrick } from './brickwork';

export const TOY_PITCH_MM = 8;
export const TOY_HEIGHT_MM = 9.6;
const TOY_GAP_MM = 0.2;

/** Studs across × studs along, as sold. Any other `AxB` can be asked for too. */
export const TOY_SIZES = [
  '1x1', '1x2', '1x3', '1x4', '1x6', '1x8', '1x10', '1x12', '1x16',
  '2x2', '2x3', '2x4', '2x6', '2x8', '2x10',
  '4x6', '4x10', '4x12',
] as const;
export type ToySize = string;
export const DEFAULT_TOY_SIZES: ToySize[] = [...TOY_SIZES];

/** Size → how many the builder has (null: as many as it takes). Sizes not listed are not used. */
export type ToyInventory = Record<ToySize, number | null>;

/** `AxB` with A ≤ B, or null if it is not a brick. */
export function normalToySize(s: string): ToySize | null {
  const m = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i.exec(s);
  if (!m) return null;
  const a = +m[1], b = +m[2];
  if (a < 1 || b < 1 || a > 32 || b > 32) return null;
  return `${Math.min(a, b)}x${Math.max(a, b)}`;
}

const dims = (s: ToySize): [number, number] => s.split('x').map(Number) as [number, number];

export interface ToyLayout {
  bricks: PlacedBrick[];
  /** Bricks gripping nothing below (over a gap nothing in hand could span). */
  loose: number;
  parts: { size: ToySize; count: number }[];
  /** Sizes the build needed more of than the builder has: how many more. */
  short: { size: ToySize; count: number }[];
}

// What a placement costs, in bricks. A brick is 1; a seam edge (one stud
// long) on a seam below 0.6, so a straight joint across a two-stud wall costs
// more than the extra brick that avoids it (at 0.45 a wall of 2×10s split
// down the middle, course after course, into two pieces); resting on one
// brick 0.3; a stud gripping nothing below is never worth it.
const W_SEAM = 0.6;
const W_SINGLE = 0.3;
const W_LOOSE = 50;
const RESTARTS = 10;
const CELLS_PER_BRICK = 8;

/** A small seeded random, so the same shape always builds the same way. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

interface Brick { i: number; j: number; w: number; h: number }

/**
 * Lays the courses. `solidAt(c)` is the slice of course c (or null for none);
 * `lo`/`hi` its plan bounds, mm.
 */
type ToyArgs = {
  lo: [number, number];
  hi: [number, number];
  courses: number;
  zBase: number;
  solidAt: (course: number) => ((p: { x: number; y: number }) => boolean) | null;
  inventory: ToyInventory;
  /** Keep only this many studs in from the outside, capped top and bottom; 0 for solid. */
  hollowStuds?: number;
  maxBricks: number;
};

/**
 * Lays the courses. If the builder has only so many of some sizes and the
 * first build leaves a brick gripping nothing (the long bricks that would
 * have spanned an opening spent lower down), it builds again holding those
 * sizes back for where they bridge, and keeps the better.
 */
export function layToyBricks(args: ToyArgs): ToyLayout {
  const first = layToyBricksOnce(args, false);
  const scarce = Object.values(args.inventory).some((n) => n !== null && n !== undefined);
  if (!scarce || first.loose === 0) return first;
  const hoarded = layToyBricksOnce(args, true);
  return hoarded.loose < first.loose || (hoarded.loose === first.loose && hoarded.bricks.length < first.bricks.length) ? hoarded : first;
}

function layToyBricksOnce(args: ToyArgs, hoard: boolean): ToyLayout & { loose: number } {
  const P = TOY_PITCH_MM;
  const nx = Math.max(1, Math.ceil((args.hi[0] - args.lo[0]) / P));
  const ny = Math.max(1, Math.ceil((args.hi[1] - args.lo[1]) / P));
  const N = nx * ny;

  // Which cells are the shape's in every course: a quarter of 4 × 4 samples.
  const masks: (Uint8Array | null)[] = [];
  for (let c = 0; c < args.courses; c++) {
    const inside = args.solidAt(c);
    if (!inside) { masks.push(null); continue; }
    const m = new Uint8Array(N);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let hits = 0;
        for (let a = 0; a < 4; a++) {
          for (let b = 0; b < 4; b++) {
            if (inside({ x: args.lo[0] + (i + (a + 0.5) / 4) * P, y: args.lo[1] + (j + (b + 0.5) / 4) * P })) hits++;
          }
        }
        if (hits >= 4) m[j * nx + i] = 1;
      }
    }
    masks.push(m);
  }
  // The shape's own cells, before any hollowing: what is outside the model.
  const solid = masks.slice();
  // Hollow: a cell further in than the wall from every outside cell goes,
  // unless the course above or below has nothing there (a floor or a roof).
  const shell = args.hollowStuds ?? 0;
  if (shell > 0) {
    const shelled = masks.map((m, c) => {
      if (!m) return m;
      const dist = new Int32Array(N).fill(-1);
      const queue: number[] = [];
      for (let k = 0; k < N; k++) {
        const i = k % nx, j = (k - i) / nx;
        const edge = !m[k] ? false : [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([di, dj]) => {
          const a = i + di, b = j + dj;
          return a < 0 || b < 0 || a >= nx || b >= ny || !m[b * nx + a];
        });
        if (edge) { dist[k] = 1; queue.push(k); }
      }
      for (let q = 0; q < queue.length; q++) {
        const k = queue[q], i = k % nx, j = (k - i) / nx;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const a = i + di, b = j + dj;
          if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
          const n = b * nx + a;
          if (m[n] && dist[n] < 0) { dist[n] = dist[k] + 1; queue.push(n); }
        }
      }
      const out = new Uint8Array(N);
      let deepest = 0;
      for (let k = 0; k < N; k++) if (dist[k] > deepest) deepest = dist[k];
      for (let k = 0; k < N; k++) {
        if (!m[k]) continue;
        // Courses of shape above this cell before its top.
        let up = 0;
        while (masks[c + up + 1]?.[k]) up++;
        // The walls, and the roof corbelled in: below the top the hollow
        // narrows by a stud a course, so every roof brick grips the course
        // under it, as a builder closes a hollow over. No floor: open
        // underneath, a floor brick under the hollow would grip nothing.
        // Hollow where it is nearer the middle than a stud for every course
        // still above it; the rest of the way in is the roof. A stud a course:
        // a two-stud step let a two-wide brick sit wholly on the step and
        // grip nothing.
        const roof = deepest - dist[k] >= up;
        if (dist[k] <= shell || roof) out[k] = 1;
      }
      return out;
    });
    masks.splice(0, masks.length, ...shelled);
  }

  // What may be used, and how many are left.
  const left = new Map<ToySize, number>();
  const allowed: { size: ToySize; w: number; h: number }[] = [];
  for (const [raw, have] of Object.entries(args.inventory)) {
    const size = normalToySize(raw);
    if (!size) continue;
    left.set(size, have === null || have === undefined ? Infinity : Math.max(0, have));
    const [a, b] = dims(size);
    allowed.push({ size, w: a, h: b });
    if (a !== b) allowed.push({ size, w: b, h: a });
  }
  if (allowed.length === 0) {
    throw new Error('Tick at least one brick size to build with.');
  }
  const scarceSizes = new Set([...left.entries()].filter(([, n]) => Number.isFinite(n)).map(([sz]) => sz));
  // A gap no ticked brick fits into has to be filled with a 1×1, counted short.
  if (!left.has('1x1')) left.set('1x1', 0);
  const fits = new Map<string, ToySize>(allowed.map((a) => [`${a.w}x${a.h}`, a.size]));
  const sizeOf = (w: number, h: number): ToySize | null => (w === 1 && h === 1 ? '1x1' : fits.get(`${w}x${h}`) ?? null);

  const bricks: PlacedBrick[] = [];
  const used = new Map<ToySize, number>();
  const short = new Map<ToySize, number>();
  let below: Int32Array | null = null;
  let nextId = 1;
  let loose = 0;
  const random = rng(nx * 7919 + ny * 104729 + args.courses);

  for (let c = 0; c < args.courses; c++) {
    const want = masks[c];
    if (!want) { below = null; continue; }
    const original = solid[c] ?? want;
    const under = below;
    const anyBelow = !!under && under.some((v, k) => v > 0 && want[k] === 1);

    // Cost of one brick, against the course below.
    // A joint on a joint: this course has brick both sides of the edge (the
    // edge of the course, a merlon's side, is no joint) and so does the one
    // below, of two different bricks.
    const seamBelow = (i0: number, j0: number, i1: number, j1: number) =>
      !!under && i0 >= 0 && j0 >= 0 && i1 < nx && j1 < ny &&
      want[j0 * nx + i0] === 1 && want[j1 * nx + i1] === 1 &&
      under[j0 * nx + i0] > 0 && under[j1 * nx + i1] > 0 && under[j0 * nx + i0] !== under[j1 * nx + i1];
    const brickCost = (b: Brick): number => {
      let cost = 1;
      if (!under || !anyBelow) return cost;
      const rest = new Set<number>();
      let gripped = 0;
      for (let j = b.j; j < b.j + b.h; j++) {
        for (let i = b.i; i < b.i + b.w; i++) {
          const v = under[j * nx + i];
          if (v > 0) { rest.add(v); gripped++; }
        }
      }
      // By the stud, so joining two loose cells saves nothing: only reaching
      // something below does.
      if (gripped === 0) cost += W_LOOSE * b.w * b.h;
      else if (rest.size === 1 && gripped === b.w * b.h) cost += W_SINGLE;
      // Its outline against the seams below: each stud of edge on one counts.
      let seams = 0;
      for (let j = b.j; j < b.j + b.h; j++) {
        if (seamBelow(b.i - 1, j, b.i, j)) seams++;
        if (seamBelow(b.i + b.w - 1, j, b.i + b.w, j)) seams++;
      }
      for (let i = b.i; i < b.i + b.w; i++) {
        if (seamBelow(i, b.j - 1, i, b.j)) seams++;
        if (seamBelow(i, b.j + b.h - 1, i, b.j + b.h)) seams++;
      }
      // Each seam is shared by two bricks; half to each.
      return cost + (W_SEAM * seams) / 2;
    };

    let best: { tiles: Brick[]; cost: number; missing: number } | null = null;
    for (let attempt = 0; attempt < RESTARTS; attempt++) {
      // Biggest brick first from each free cell in turn. Alternate courses
      // scan the other way (rows, then columns), and each attempt from a
      // different corner, so seams fall differently course to course.
      const taken = new Uint8Array(N);
      const inUse = new Map<ToySize, number>();
      const room = (size: ToySize) => (left.get(size) ?? 0) - (inUse.get(size) ?? 0);
      const flipI = (attempt & 1) === 1, flipJ = (attempt & 2) === 2;
      const byColumns = (c + (attempt >> 2)) % 2 === 1;
      const cells: number[] = [];
      for (let a = 0; a < (byColumns ? nx : ny); a++) {
        for (let b = 0; b < (byColumns ? ny : nx); b++) {
          const i = byColumns ? (flipI ? nx - 1 - a : a) : (flipI ? nx - 1 - b : b);
          const j = byColumns ? (flipJ ? ny - 1 - b : b) : (flipJ ? ny - 1 - a : a);
          cells.push(j * nx + i);
        }
      }
      const tiles: Brick[] = [];
      let total = 0;
      const no1x1 = (left.get('1x1') ?? 0) - (inUse.get('1x1') ?? 0) < 1;
      for (const k of cells) {
        if (!want[k] || taken[k]) continue;
        const ai = k % nx, aj = (k - ai) / nx;
        const evaluateCandidate = (size: ToySize, w: number, h: number): { b: Brick; size: ToySize; score: number } | null => {
          // Grows away from where the scan came from.
          const b: Brick = { i: flipI ? ai - w + 1 : ai, j: flipJ ? aj - h + 1 : aj, w, h };
          if (b.i < 0 || b.j < 0 || b.i + w > nx || b.j + h > ny) return null;
          let ok = true;
          for (let j = b.j; ok && j < b.j + h; j++) for (let i = b.i; ok && i < b.i + w; i++) if (!want[j * nx + i] || taken[j * nx + i]) ok = false;
          if (!ok) return null;
          // Cells covered now are bricks not needed later: the count; less
          // what it costs the bond, in cells at a 2×4's worth a brick, so that
          // a bigger brick cannot simply buy its way onto a seam.
          // With no 1×1s in hand, a brick that leaves a cell beside it no brick
          // in hand can still cover (a one-stud strip, with only two-wide
          // bricks) costs what a missing brick would.
          let stranded = 0;
          if (no1x1) {
            const covers = (x: number, y: number) => x >= b.i && x < b.i + w && y >= b.j && y < b.j + h;
            const freeCell = (x: number, y: number) => x >= 0 && y >= 0 && x < nx && y < ny && want[y * nx + x] === 1 && !taken[y * nx + x] && !covers(x, y);
            const reachable = (x: number, y: number) => allowed.some((o) => {
              if (o.size === '1x1' || room(o.size) < 1) return false;
              for (let ox = x - o.w + 1; ox <= x; ox++) {
                for (let oy = y - o.h + 1; oy <= y; oy++) {
                  let fitsHere = true;
                  for (let p = ox; fitsHere && p < ox + o.w; p++) for (let q = oy; fitsHere && q < oy + o.h; q++) if (!freeCell(p, q)) fitsHere = false;
                  if (fitsHere) return true;
                }
              }
              return false;
            });
            for (let x = b.i - 1; x <= b.i + w; x++) {
              for (let y = b.j - 1; y <= b.j + h; y++) {
                if (covers(x, y) || !freeCell(x, y)) continue;
                if (!reachable(x, y)) stranded++;
              }
            }
          }
          // Holding back sizes the builder has few of, for where only they will do.
          const hold = hoard && scarceSizes.has(size) ? 1 : 0;
          const score = w * h - CELLS_PER_BRICK * (brickCost(b) - 1 + stranded + hold) + random() * 0.01;
          return { b, size, score };
        };

        let pick: { b: Brick; size: ToySize; score: number } | null = null;
        // 1. Prefer bricks still in hand.
        for (const { size, w, h } of allowed) {
          if (room(size) < 1) continue;
          const cand = evaluateCandidate(size, w, h);
          if (cand && (!pick || cand.score > pick.score)) pick = cand;
        }
        // 2. When no brick in hand fits here, use a ticked size (and count it short) before falling back to 1×1.
        if (!pick) {
          for (const { size, w, h } of allowed) {
            if (room(size) >= 1) continue;
            const cand = evaluateCandidate(size, w, h);
            if (cand && (!pick || cand.score > pick.score)) pick = cand;
          }
        }
        if (!pick) {
          pick = evaluateCandidate('1x1', 1, 1);
        }
        if (!pick) continue;
        // Only a 1×1 fits here and the builder has none: inside the model a
        // gap does no harm, so leave it; on its outside it is counted short.
        if (pick.size === '1x1' && (left.get('1x1') ?? 0) - (inUse.get('1x1') ?? 0) < 1) {
          const outside = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([di, dj]) => {
            const a = ai + di, b = aj + dj;
            return a < 0 || b < 0 || a >= nx || b >= ny || !original[b * nx + a];
          });
          if (!outside) continue;
        }
        for (let j = pick.b.j; j < pick.b.j + pick.b.h; j++) for (let i = pick.b.i; i < pick.b.i + pick.b.w; i++) taken[j * nx + i] = 1;
        inUse.set(pick.size, (inUse.get(pick.size) ?? 0) + 1);
        tiles.push(pick.b);
        // A brick the builder does not have counts against the pass heavily:
        // of the scans tried, the one that needs none of them wins.
        total += brickCost(pick.b) + ((left.get(pick.size) ?? 0) - (inUse.get(pick.size) ?? 0) < 0 ? 5 : 0);
      }
      if (!best || total < best.cost) best = { tiles, cost: total, missing: [...inUse].reduce((t, [sz, n]) => t + Math.max(0, n - (left.get(sz) ?? 0)), 0) };
    }

    // Still needing bricks the builder has none of (a 1×1 strip left where
    // only two-wide bricks are in hand)? One brick at a time cannot look
    // ahead, so search: the first empty cell, each brick in hand that could
    // cover it, best first, backing out of dead ends, within a budget.
    if (best!.missing > 0) {
      for (const [flipI, flipJ, byColumns] of [[false, false, false], [false, false, true], [true, true, false], [true, true, true]] as const) {
        const cells: number[] = [];
        for (let a = 0; a < (byColumns ? nx : ny); a++) {
          for (let b = 0; b < (byColumns ? ny : nx); b++) {
            const i = byColumns ? (flipI ? nx - 1 - a : a) : (flipI ? nx - 1 - b : b);
            const jj = byColumns ? (flipJ ? ny - 1 - b : b) : (flipJ ? ny - 1 - a : a);
            cells.push(jj * nx + i);
          }
        }
        const taken = new Uint8Array(N);
        const inUse = new Map<ToySize, number>();
        const out: Brick[] = [];
        let budget = 40000;
        const rec = (pos: number): boolean => {
          while (pos < cells.length && (!want[cells[pos]] || taken[cells[pos]])) pos++;
          if (pos === cells.length) return true;
          if (--budget < 0) return false;
          const k = cells[pos], ai = k % nx, aj = (k - ai) / nx;
          const options: { b: Brick; size: ToySize; score: number }[] = [];
          for (const { size, w, h } of allowed) {
            if ((left.get(size) ?? 0) - (inUse.get(size) ?? 0) < 1) continue;
            const b: Brick = { i: flipI ? ai - w + 1 : ai, j: flipJ ? aj - h + 1 : aj, w, h };
            if (b.i < 0 || b.j < 0 || b.i + w > nx || b.j + h > ny) continue;
            let ok = true;
            for (let y = b.j; ok && y < b.j + h; y++) for (let x = b.i; ok && x < b.i + w; x++) if (!want[y * nx + x] || taken[y * nx + x]) ok = false;
            if (ok) options.push({ b, size, score: w * h - CELLS_PER_BRICK * (brickCost(b) - 1) });
          }
          options.sort((p, q) => q.score - p.score);
          for (const o of options) {
            for (let y = o.b.j; y < o.b.j + o.b.h; y++) for (let x = o.b.i; x < o.b.i + o.b.w; x++) taken[y * nx + x] = 1;
            inUse.set(o.size, (inUse.get(o.size) ?? 0) + 1);
            out.push(o.b);
            if (rec(pos + 1)) return true;
            out.pop();
            inUse.set(o.size, inUse.get(o.size)! - 1);
            for (let y = o.b.j; y < o.b.j + o.b.h; y++) for (let x = o.b.i; x < o.b.i + o.b.w; x++) taken[y * nx + x] = 0;
          }
          // Nothing in hand fits: inside the model a gap does no harm.
          const outside = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([di, dj]) => {
            const a = ai + di, b = aj + dj;
            return a < 0 || b < 0 || a >= nx || b >= ny || !original[b * nx + a];
          });
          return !outside && rec(pos + 1);
        };
        if (rec(0)) {
          best = { tiles: out, cost: out.reduce((t, b) => t + brickCost(b), 0), missing: 0 };
          break;
        }
      }
    }

    const owner = new Int32Array(N);
    for (const b of best!.tiles) {
      if (under && anyBelow) {
        let grips = false;
        for (let y = b.j; !grips && y < b.j + b.h; y++) for (let x = b.i; !grips && x < b.i + b.w; x++) if (under[y * nx + x] > 0) grips = true;
        if (!grips) loose++;
      }
      const id = nextId++;
      for (let j = b.j; j < b.j + b.h; j++) for (let i = b.i; i < b.i + b.w; i++) owner[j * nx + i] = id;
      const size = sizeOf(b.w, b.h)!;
      used.set(size, (used.get(size) ?? 0) + 1);
      left.set(size, (left.get(size) ?? 0) - 1);
      if ((left.get(size) ?? 0) < 0) short.set(size, (short.get(size) ?? 0) + 1);
      bricks.push({
        course: c,
        x: args.lo[0] + (b.i + b.w / 2) * P,
        y: args.lo[1] + (b.j + b.h / 2) * P,
        z: args.zBase + c * TOY_HEIGHT_MM,
        angle: 0,
        lengthMm: b.w * P - TOY_GAP_MM,
        depthMm: b.h * P - TOY_GAP_MM,
        header: false,
        closer: false,
        cut: false,
      });
      if (bricks.length > args.maxBricks) {
        throw new Error(`That is more than ${args.maxBricks.toLocaleString()} toy bricks. Build one part at a time (select it first), make it hollow, or scale it down.`);
      }
    }
    below = owner;
  }

  const order = (s: ToySize) => { const [a, b] = dims(s); return -(a * b) * 100 - b; };
  return {
    bricks,
    loose,
    parts: [...used.entries()].sort((a, b) => order(a[0]) - order(b[0])).map(([size, count]) => ({ size, count })),
    short: [...short.entries()].map(([size, count]) => ({ size, count })),
  };
}
