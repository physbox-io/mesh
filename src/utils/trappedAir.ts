// ---------------------------------------------------------------------------
// Where air is trapped in a cavity filled from the top
// ---------------------------------------------------------------------------
//
// Shared by the silicone mold (vents cut through the rubber) and the lost-PLA
// pattern (vent rods fused on, burnt out with it). Works on a plain triangle
// soup so it runs without the geometry engine. Lengths are mm, Z up.
//
// The cavity is read as columns of solid spans, and the spans as a graph: two
// spans in neighbouring columns are joined where their heights overlap, which
// is where metal (and the air ahead of it) can pass from one to the other.

import { castColumnSpans } from './columnSolid';

/** Thinner than this, mm, a span is a ray grazing an edge, not metal. */
const MIN_SPAN_MM = 0.05;

interface SpanGraph {
  cols: number;
  rows: number;
  cell: number;
  minX: number;
  minY: number;
  bot: Float64Array;
  top: Float64Array;
  col: Int32Array;
  /** Whether the span is the highest in its column: nothing is over its ceiling. */
  isColumnTop: Uint8Array;
  /** Joined spans, node n's are adj[adjStart[n] .. adjStart[n + 1]). */
  adjStart: Int32Array;
  adj: Int32Array;
}

/**
 * Samples each solid on its own and unions the spans per column. A winding
 * count over the raw scene drops the second of two hits at one height facing
 * one way (the right call for an edge two triangles of ONE mesh share), so two
 * bodies standing on the same floor read as one, cut short at the lower top.
 * Spans that touch (a post standing on a plate) are one piece of metal.
 */
function buildGraph(tris: Float64Array, solidIds?: ArrayLike<number>): SpanGraph | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i], y = tris[i + 1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (!(maxX > minX) || !(maxY > minY)) return null;
  const span = Math.max(maxX - minX, maxY - minY);
  const cell = Math.max(0.5, span / 150);
  const cols = Math.ceil((maxX - minX) / cell) + 1;
  const rows = Math.ceil((maxY - minY) / cell) + 1;
  const grid = { minX, minY, stepX: cell, stepY: cell, cols, rows };

  // One soup per solid.
  const soups: Float64Array[] = [];
  if (solidIds && solidIds.length * 9 >= tris.length) {
    const byId = new Map<number, number[]>();
    for (let t = 0; t < tris.length / 9; t++) {
      const id = solidIds[t] ?? 0;
      let list = byId.get(id);
      if (!list) byId.set(id, (list = []));
      list.push(t);
    }
    for (const list of byId.values()) {
      const s = new Float64Array(list.length * 9);
      list.forEach((t, j) => s.set(tris.subarray(t * 9, t * 9 + 9), j * 9));
      soups.push(s);
    }
  } else {
    soups.push(tris);
  }
  const perSolid = soups.map((s) => castColumnSpans(s, grid));

  const touch = Math.max(1e-3, cell * 1e-3);
  const bot: number[] = [], top: number[] = [], colOf: number[] = [];
  const colStart = new Int32Array(cols * rows + 1);
  const pairs: [number, number][] = [];
  for (let k = 0; k < cols * rows; k++) {
    colStart[k] = bot.length;
    pairs.length = 0;
    for (const sp of perSolid) {
      for (let i = sp.offset[k]; i < sp.offset[k + 1]; i += 2) {
        if (sp.z[i + 1] - sp.z[i] >= MIN_SPAN_MM) pairs.push([sp.z[i], sp.z[i + 1]]);
      }
    }
    pairs.sort((a, b) => a[0] - b[0]);
    for (const [b, t] of pairs) {
      const last = bot.length - 1;
      if (last >= colStart[k] && b <= top[last] + touch) top[last] = Math.max(top[last], t);
      else { bot.push(b); top.push(t); colOf.push(k); }
    }
  }
  colStart[cols * rows] = bot.length;
  const n = bot.length;
  const isColumnTop = new Uint8Array(n);
  for (let k = 0; k < cols * rows; k++) if (colStart[k + 1] > colStart[k]) isColumnTop[colStart[k + 1] - 1] = 1;

  const adjStart = new Int32Array(n + 1);
  const adj: number[] = [];
  for (let a = 0; a < n; a++) {
    adjStart[a] = adj.length;
    const k = colOf[a];
    const c = k % cols, r = Math.floor(k / cols);
    for (const [dc, dr] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const cc = c + dc, rr = r + dr;
      if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) continue;
      const kk = rr * cols + cc;
      for (let m = colStart[kk]; m < colStart[kk + 1]; m++) {
        if (bot[m] < top[a] - 1e-6 && top[m] > bot[a] + 1e-6) adj.push(m);
      }
    }
  }
  adjStart[n] = adj.length;
  return {
    cols, rows, cell, minX, minY,
    bot: Float64Array.from(bot), top: Float64Array.from(top), col: Int32Array.from(colOf),
    isColumnTop, adjStart, adj: Int32Array.from(adj),
  };
}

const xOf = (g: SpanGraph, n: number) => g.minX + (g.col[n] % g.cols) * g.cell;
const yOf = (g: SpanGraph, n: number) => g.minY + Math.floor(g.col[n] / g.cols) * g.cell;

/**
 * The level each span's air spills at — the inverse of filling lakes in a
 * terrain. Air leaves through the outlets; working outward from them
 * highest-first, each span is reached at the lowest ceiling on the best path
 * to it. -Infinity for a span no outlet reaches.
 */
function spillLevels(g: SpanGraph, outlets: Iterable<number>): Float64Array {
  const n = g.top.length;
  const spill = new Float64Array(n).fill(-Infinity);
  const heap: number[] = [];
  const up = (i: number) => {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (spill[heap[p]] >= spill[heap[i]]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): number => {
    const head = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && spill[heap[l]] > spill[heap[m]]) m = l;
        if (r < heap.length && spill[heap[r]] > spill[heap[m]]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return head;
  };
  for (const o of outlets) { spill[o] = g.top[o]; heap.push(o); up(heap.length - 1); }
  const done = new Uint8Array(n);
  while (heap.length) {
    const a = pop();
    if (done[a]) continue;
    done[a] = 1;
    for (let j = g.adjStart[a]; j < g.adjStart[a + 1]; j++) {
      const m = g.adj[j];
      const s = Math.min(spill[a], g.top[m]);
      if (!done[m] && s > spill[m]) { spill[m] = s; heap.push(m); up(heap.length - 1); }
    }
  }
  return spill;
}

/** Connected groups of the nodes `member` admits. */
function components(g: SpanGraph, member: (n: number) => boolean): number[][] {
  const seen = new Uint8Array(g.top.length);
  const out: number[][] = [];
  for (let n0 = 0; n0 < g.top.length; n0++) {
    if (seen[n0] || !member(n0)) continue;
    const comp = [n0];
    seen[n0] = 1;
    for (let i = 0; i < comp.length; i++) {
      const a = comp[i];
      for (let j = g.adjStart[a]; j < g.adjStart[a + 1]; j++) {
        const m = g.adj[j];
        if (!seen[m] && member(m)) { seen[m] = 1; comp.push(m); }
      }
    }
    out.push(comp);
  }
  return out;
}

/**
 * Where air would be trapped in a cavity poured from the top to `level`: every
 * span whose ceiling has nowhere higher to go, grouped into connected patches,
 * one point per patch at its highest. Every span is checked, not just the top
 * one in its column, so a pocket under a ledge under another ledge is found
 * too. Highest first. This is the silicone mold's rule: rubber does not
 * breathe, so every patch gets its vent.
 */
export function trappedAirInSoup(tris: Float64Array, level: number, solidIds?: ArrayLike<number>): { x: number; y: number; z: number }[] {
  const g = buildGraph(tris, solidIds);
  if (!g) return [];
  const tol = Math.max(0.5, g.cell);
  const trapped = new Uint8Array(g.top.length);
  for (let n = 0; n < g.top.length; n++) {
    if (g.top[n] >= level - tol) continue;
    let escapes = false;
    for (let j = g.adjStart[n]; j < g.adjStart[n + 1]; j++) if (g.top[g.adj[j]] > g.top[n] + 1e-4) { escapes = true; break; }
    if (!escapes) trapped[n] = 1;
  }
  return components(g, (n) => trapped[n] === 1)
    .map((comp) => {
      const best = comp.reduce((b, n) => (g.top[n] > g.top[b] ? n : b), comp[0]);
      return { x: xOf(g, best), y: yOf(g, best), z: g.top[best] };
    })
    .sort((a, b) => b.z - a.z);
}

export interface BurnoutVent {
  x: number;
  y: number;
  /** The ceiling the vent leaves from, where the air collects. */
  z: number;
  /** Bottom of the metal under that ceiling, so the vent roots in it without punching through. */
  floorZ: number;
  /** Metal above the ceiling in its own column (a ledge over the pocket), mm of height. */
  metalAboveMm: number;
  /** Why it is there: a pocket that would hold air, or the far end of the casting from the sprue. */
  reason: 'pocket' | 'far-end';
}

export interface BurnoutVentPlan {
  vents: BurnoutVent[];
  /** Pockets still holding air when the vent limit was reached. */
  leftOver: number;
  /** Pockets with no place a vent clears the sprue and cup: highest point of each. */
  unventable: { x: number; y: number; z: number }[];
  /** Pieces of the cavity the metal never reaches from the outlets: highest point of each. */
  unreached: { x: number; y: number; z: number }[];
}

export interface BurnoutVentOptions {
  /** A pocket whose air stands at least this deep, mm, is vented... */
  minDepthMm: number;
  /** ...and so is one holding at least this much air, mm³, however shallow. */
  minAirMm3: number;
  maxVents: number;
  /** The far end of the casting gets a vent if it is further than this from the sprue and every vent, mm along the cavity. */
  farEndMm: number;
  /** Whether a vent rod standing on (x, y) from a ceiling at z clears everything else on the rig. */
  accepts: (x: number, y: number, z: number, floorZ: number) => boolean;
}

/**
 * Plans the vents for a cavity filled from its outlets — whatever reaches
 * `level`, the sprue and cup — as a skilled caster would place them:
 *
 *   - Biggest pocket first, and each vent then counts as an outlet before the
 *     next is chosen, so the bumps of a texture on one boss are one pocket and
 *     two blind pins side by side are two.
 *   - A pocket matters by how deep its air stands or how much of it there is;
 *     a shallow, small one is left to the investment, which breathes.
 *   - On a flat ceiling the vent goes in the middle of it, not on a corner the
 *     rod would hang off; and never where `accepts` says it would foul the
 *     sprue or the cup.
 *   - The far end of a casting gets a vent even where no pocket is: the metal
 *     front drives the air ahead of it to there.
 */
export function planBurnoutVents(
  tris: Float64Array,
  level: number,
  opts: BurnoutVentOptions,
  solidIds?: ArrayLike<number>,
): BurnoutVentPlan {
  const plan: BurnoutVentPlan = { vents: [], leftOver: 0, unventable: [], unreached: [] };
  const g = buildGraph(tris, solidIds);
  if (!g) return plan;
  const n = g.top.length;
  const cellArea = g.cell * g.cell;
  const tol = Math.max(0.5, g.cell);
  const outlets: number[] = [];
  for (let a = 0; a < n; a++) if (g.top[a] >= level - tol) outlets.push(a);
  const highest = (comp: number[]) => comp.reduce((b, a) => (g.top[a] > g.top[b] ? a : b), comp[0]);
  const pointOf = (a: number) => ({ x: xOf(g, a), y: yOf(g, a), z: g.top[a] });

  const reached = spillLevels(g, outlets);
  for (const comp of components(g, (a) => reached[a] === -Infinity)) plan.unreached.push(pointOf(highest(comp)));
  const live = (a: number) => reached[a] !== -Infinity;

  const ventAt = (a: number, reason: BurnoutVent['reason']): BurnoutVent => {
    let metalAboveMm = 0;
    const k = g.col[a];
    for (let m = a + 1; m < n && g.col[m] === k; m++) metalAboveMm += g.top[m] - g.bot[m];
    return { ...pointOf(a), floorZ: g.bot[a], metalAboveMm, reason };
  };

  /**
   * The best place in `cands` for a rod: the highest, and among spans level
   * with it the one furthest inside their flat, then lower ones that still
   * leave less than the minimum depth of air above the vent.
   */
  const placeIn = (cands: number[], within: number): number | null => {
    let maxTop = -Infinity;
    for (const a of cands) if (g.top[a] > maxTop) maxTop = g.top[a];
    const flat = new Set(cands.filter((a) => g.top[a] >= maxTop - MIN_SPAN_MM));
    // Distance in from the edge of the flat, by breadth-first steps.
    const depthIn = new Map<number, number>();
    const queue: number[] = [];
    for (const a of flat) {
      let nb = 0;
      for (let j = g.adjStart[a]; j < g.adjStart[a + 1]; j++) if (flat.has(g.adj[j])) nb++;
      if (nb < 4) { depthIn.set(a, 0); queue.push(a); }
    }
    for (let i = 0; i < queue.length; i++) {
      const a = queue[i];
      for (let j = g.adjStart[a]; j < g.adjStart[a + 1]; j++) {
        const m = g.adj[j];
        if (flat.has(m) && !depthIn.has(m)) { depthIn.set(m, depthIn.get(a)! + 1); queue.push(m); }
      }
    }
    const order = [...flat].sort((a, b) => (depthIn.get(b) ?? 0) - (depthIn.get(a) ?? 0));
    const lower = cands.filter((a) => !flat.has(a) && g.top[a] >= maxTop - within).sort((a, b) => g.top[b] - g.top[a]);
    for (const a of [...order, ...lower]) if (opts.accepts(xOf(g, a), yOf(g, a), g.top[a], g.bot[a])) return a;
    return null;
  };

  const ventNodes: number[] = [];
  const blocked: number[] = [];
  for (;;) {
    const spill = spillLevels(g, [...outlets, ...ventNodes, ...blocked]);
    const depth = (a: number) => (live(a) ? g.top[a] - spill[a] : 0);
    const pockets = components(g, (a) => depth(a) > 1e-3)
      .map((comp) => {
        let air = 0, deepest = 0;
        for (const a of comp) {
          air += Math.max(0, g.top[a] - Math.max(spill[a], g.bot[a])) * cellArea;
          deepest = Math.max(deepest, depth(a));
        }
        return { comp, air, deepest };
      })
      .filter((p) => p.deepest >= opts.minDepthMm || p.air >= opts.minAirMm3)
      .sort((a, b) => b.air - a.air);
    if (pockets.length === 0) break;
    if (plan.vents.length >= opts.maxVents) { plan.leftOver = pockets.length; break; }
    const p = pockets[0];
    const at = placeIn(p.comp, opts.minDepthMm);
    if (at === null) {
      plan.unventable.push(pointOf(highest(p.comp)));
      blocked.push(...p.comp);
      continue;
    }
    ventNodes.push(at);
    plan.vents.push(ventAt(at, 'pocket'));
  }

  // The far end from the sprue: reached through the cavity, measured straight
  // back to the outlet it was reached from. A vent already near it counts.
  if (plan.vents.length < opts.maxVents && opts.farEndMm > 0) {
    const origin = new Int32Array(n).fill(-1);
    const queue: number[] = [];
    for (const a of outlets) { origin[a] = a; queue.push(a); }
    for (let i = 0; i < queue.length; i++) {
      const a = queue[i];
      for (let j = g.adjStart[a]; j < g.adjStart[a + 1]; j++) {
        const m = g.adj[j];
        if (origin[m] < 0) { origin[m] = origin[a]; queue.push(m); }
      }
    }
    const dist = (a: number) => {
      const o = origin[a];
      return o < 0 ? -1 : Math.hypot(xOf(g, a) - xOf(g, o), yOf(g, a) - yOf(g, o));
    };
    let far = 0;
    for (let a = 0; a < n; a++) if (g.isColumnTop[a]) far = Math.max(far, dist(a));
    if (far > opts.farEndMm) {
      // The far region: column tops within a fifth of the way back; the vent
      // goes at its highest, where the driven air ends up.
      const region: number[] = [];
      for (let a = 0; a < n; a++) if (g.isColumnTop[a] && dist(a) >= far * 0.8) region.push(a);
      const at = placeIn(region, Infinity);
      const near = (a: number) =>
        plan.vents.some((v) => Math.hypot(v.x - xOf(g, a), v.y - yOf(g, a)) < opts.farEndMm * 0.8);
      if (at !== null && !near(at)) plan.vents.push(ventAt(at, 'far-end'));
    }
  }
  return plan;
}
