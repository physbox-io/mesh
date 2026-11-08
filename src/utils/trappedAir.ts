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

interface GraphOptions {
  /** Cells across the longer side of the soup. */
  cellsAcross: number;
  /** Never finer than this, mm. */
  minCellMm: number;
  /** Most columns to sample; the cell grows to stay under it. */
  maxColumns: number;
  /** Join diagonal neighbours too, so a thin wall running at 45° stays one piece. */
  diagonals: boolean;
}

/** The silicone mold's reading, as it has always been. */
const SILICONE_GRAPH: GraphOptions = { cellsAcross: 150, minCellMm: 0.5, maxColumns: Infinity, diagonals: false };
/**
 * Fine enough that a 1.5 mm wall on a 300 mm part, or a thin plate on a steep
 * slope, stays joined: a coarse grid broke such shells into dozens of pieces
 * the metal "could not reach".
 */
const BURNOUT_GRAPH: GraphOptions = { cellsAcross: 400, minCellMm: 0.25, maxColumns: 400_000, diagonals: true };

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
 * Samples each solid on its own, over its own footprint, and unions the spans
 * per column. A winding count over the raw scene drops the second of two hits
 * at one height facing one way (the right call for an edge two triangles of
 * ONE mesh share), so two bodies standing on the same floor read as one, cut
 * short at the lower top. Spans that touch (a post on a plate) are one piece.
 */
function buildGraph(tris: Float64Array, solidIds: ArrayLike<number> | undefined, o: GraphOptions): SpanGraph | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i], y = tris[i + 1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (!(maxX > minX) || !(maxY > minY)) return null;
  const span = Math.max(maxX - minX, maxY - minY);
  let cell = Math.max(o.minCellMm, span / o.cellsAcross);
  let cols = Math.ceil((maxX - minX) / cell) + 1;
  let rows = Math.ceil((maxY - minY) / cell) + 1;
  if (cols * rows > o.maxColumns) {
    cell *= Math.sqrt((cols * rows) / o.maxColumns);
    cols = Math.ceil((maxX - minX) / cell) + 1;
    rows = Math.ceil((maxY - minY) / cell) + 1;
  }

  // One soup per solid, with its footprint on the grid.
  const groups: { soup: Float64Array; c0: number; c1: number; r0: number; r1: number }[] = [];
  const addGroup = (soup: Float64Array) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < soup.length; i += 3) {
      if (soup[i] < x0) x0 = soup[i]; if (soup[i] > x1) x1 = soup[i];
      if (soup[i + 1] < y0) y0 = soup[i + 1]; if (soup[i + 1] > y1) y1 = soup[i + 1];
    }
    if (!(x1 >= x0)) return;
    groups.push({
      soup,
      c0: Math.max(0, Math.floor((x0 - minX) / cell) - 1), c1: Math.min(cols - 1, Math.ceil((x1 - minX) / cell) + 1),
      r0: Math.max(0, Math.floor((y0 - minY) / cell) - 1), r1: Math.min(rows - 1, Math.ceil((y1 - minY) / cell) + 1),
    });
  };
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
      addGroup(s);
    }
  } else {
    addGroup(tris);
  }

  // Every span of every solid as (column, bottom, top), bucketed by column.
  const rawK: number[] = [], rawB: number[] = [], rawT: number[] = [];
  for (const gr of groups) {
    const subCols = gr.c1 - gr.c0 + 1, subRows = gr.r1 - gr.r0 + 1;
    const sp = castColumnSpans(gr.soup, { minX: minX + gr.c0 * cell, minY: minY + gr.r0 * cell, stepX: cell, stepY: cell, cols: subCols, rows: subRows });
    for (let rr = 0; rr < subRows; rr++) {
      for (let cc = 0; cc < subCols; cc++) {
        const sk = rr * subCols + cc;
        const k = (gr.r0 + rr) * cols + (gr.c0 + cc);
        for (let i = sp.offset[sk]; i < sp.offset[sk + 1]; i += 2) {
          if (sp.z[i + 1] - sp.z[i] < MIN_SPAN_MM) continue;
          rawK.push(k); rawB.push(sp.z[i]); rawT.push(sp.z[i + 1]);
        }
      }
    }
  }
  const counts = new Int32Array(cols * rows + 1);
  for (const k of rawK) counts[k + 1]++;
  for (let k = 0; k < cols * rows; k++) counts[k + 1] += counts[k];
  const fill = counts.slice(0, cols * rows);
  const order = new Int32Array(rawK.length);
  for (let i = 0; i < rawK.length; i++) order[fill[rawK[i]]++] = i;

  const touch = Math.max(1e-3, cell * 1e-3);
  const bot: number[] = [], top: number[] = [], colOf: number[] = [];
  const colStart = new Int32Array(cols * rows + 1);
  const local: number[] = [];
  for (let k = 0; k < cols * rows; k++) {
    colStart[k] = bot.length;
    local.length = 0;
    for (let i = counts[k]; i < counts[k + 1]; i++) local.push(order[i]);
    if (local.length > 1) local.sort((a, b) => rawB[a] - rawB[b]);
    for (const i of local) {
      const last = bot.length - 1;
      if (last >= colStart[k] && rawB[i] <= top[last] + touch) top[last] = Math.max(top[last], rawT[i]);
      else { bot.push(rawB[i]); top.push(rawT[i]); colOf.push(k); }
    }
  }
  colStart[cols * rows] = bot.length;
  const n = bot.length;
  const isColumnTop = new Uint8Array(n);
  for (let k = 0; k < cols * rows; k++) if (colStart[k + 1] > colStart[k]) isColumnTop[colStart[k + 1] - 1] = 1;

  const steps = o.diagonals
    ? [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]
    : [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const adjStart = new Int32Array(n + 1);
  const adj: number[] = [];
  for (let a = 0; a < n; a++) {
    adjStart[a] = adj.length;
    const k = colOf[a];
    const c = k % cols, r = Math.floor(k / cols);
    for (const [dc, dr] of steps) {
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

/** A max-heap (or min-heap, with `min`) of node ids keyed by `key`. */
function makeHeap(key: Float64Array, min = false) {
  const heap: number[] = [];
  const better = (a: number, b: number) => (min ? key[a] < key[b] : key[a] > key[b]);
  return {
    get size() { return heap.length; },
    push(nd: number) {
      heap.push(nd);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!better(heap[i], heap[p])) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    },
    pop(): number {
      const head = heap[0];
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && better(heap[l], heap[m])) m = l;
          if (r < heap.length && better(heap[r], heap[m])) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return head;
    },
  };
}

/**
 * The level each span's air spills at — the inverse of filling lakes in a
 * terrain. Air leaves through the outlets; working outward from them
 * highest-first, each span is reached at the lowest ceiling on the best path
 * to it. -Infinity for a span no outlet reaches; walled-off spans are skipped.
 */
function spillLevels(g: SpanGraph, outlets: Iterable<number>, walled?: Uint8Array): Float64Array {
  const n = g.top.length;
  const spill = new Float64Array(n).fill(-Infinity);
  const heap = makeHeap(spill);
  for (const o of outlets) { spill[o] = g.top[o]; heap.push(o); }
  const done = new Uint8Array(n);
  while (heap.size) {
    const a = heap.pop();
    if (done[a]) continue;
    done[a] = 1;
    for (let j = g.adjStart[a]; j < g.adjStart[a + 1]; j++) {
      const m = g.adj[j];
      if (walled?.[m]) continue;
      const s = Math.min(spill[a], g.top[m]);
      if (!done[m] && s > spill[m]) { spill[m] = s; heap.push(m); }
    }
  }
  return spill;
}

/** Distance through the cavity from `sources`, mm in plan; Infinity where none reaches. */
function cavityDistance(g: SpanGraph, sources: Iterable<number>): Float64Array {
  const n = g.top.length;
  const dist = new Float64Array(n).fill(Infinity);
  const heap = makeHeap(dist, true);
  for (const s of sources) { dist[s] = 0; heap.push(s); }
  const done = new Uint8Array(n);
  while (heap.size) {
    const a = heap.pop();
    if (done[a]) continue;
    done[a] = 1;
    const ka = g.col[a];
    for (let j = g.adjStart[a]; j < g.adjStart[a + 1]; j++) {
      const m = g.adj[j];
      const km = g.col[m];
      const diag = km % g.cols !== ka % g.cols && Math.floor(km / g.cols) !== Math.floor(ka / g.cols);
      const d = dist[a] + (diag ? g.cell * Math.SQRT2 : g.cell);
      if (!done[m] && d < dist[m]) { dist[m] = d; heap.push(m); }
    }
  }
  return dist;
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
  const g = buildGraph(tris, solidIds, SILICONE_GRAPH);
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
  /** How far the feature extends round the vent's axis near its ceiling, mm: the widest rod (radius) that sits on it. */
  insetMm: number;
  /** Why it is there: a pocket that would hold air, or a far end of the casting from the sprue. */
  reason: 'pocket' | 'far-end';
}

export interface BurnoutVentPlan {
  vents: BurnoutVent[];
  /** Pockets still holding air when the vent limit was reached. */
  leftOver: number;
  /** Pockets with no place a vent fits clear of the sprue: highest point of each. */
  unventable: { x: number; y: number; z: number }[];
  /** Pockets too fine anywhere for a rod worth printing, left to the investment: highest point and air depth of each. */
  tooFine: { x: number; y: number; z: number; depthMm: number }[];
  /** Pieces of the cavity the metal never reaches from the outlets: highest point of each. */
  unreached: { x: number; y: number; z: number }[];
}

export interface BurnoutVentOptions {
  /** A pocket whose air stands at least this deep, mm, is vented... */
  minDepthMm: number;
  /** ...and so is one holding at least this much air, mm³, however shallow. */
  minAirMm3: number;
  maxVents: number;
  /**
   * Each end of the casting further than this from the sprue, mm along the
   * cavity, gets a vent, unless one is already within reach of it.
   */
  farEndMm: number;
  /**
   * Whether a vent rod can stand on (x, y) from a ceiling at z, on a feature
   * that extends `insetMm` round it: 'ok', 'too-fine' for a feature narrower
   * than any rod worth printing, or 'blocked' where the rod would foul the rig.
   */
  fits: (x: number, y: number, z: number, floorZ: number, insetMm: number) => 'ok' | 'too-fine' | 'blocked';
}

/**
 * Plans the vents for a cavity filled from its outlets — whatever reaches
 * `level`, the sprue and cup — as a skilled caster would place them:
 *
 *   - Deepest pocket first (the one most likely to misrun), and each vent then
 *     counts as an outlet before the next is chosen, so the bumps of a texture
 *     on one boss are one pocket and two blind pins side by side are two.
 *   - A pocket matters by how deep its air stands or how much of it there is;
 *     a shallow, small one is left to the investment, which breathes.
 *   - The vent goes at the top of the pocket, in the middle of the feature
 *     there and, along a long flat, at its far end from the inflow, where the
 *     driven air ends up; never where `accepts` says it would not fit.
 *   - Each far end of the casting gets a vent even where no pocket is: the
 *     metal front drives the air ahead of it to there.
 */
export function planBurnoutVents(
  tris: Float64Array,
  level: number,
  opts: BurnoutVentOptions,
  solidIds?: ArrayLike<number>,
): BurnoutVentPlan {
  const plan: BurnoutVentPlan = { vents: [], leftOver: 0, unventable: [], tooFine: [], unreached: [] };
  const g = buildGraph(tris, solidIds, BURNOUT_GRAPH);
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
  const walled = new Uint8Array(n);
  for (let a = 0; a < n; a++) if (reached[a] === -Infinity) walled[a] = 1;

  const ventAt = (a: number, insetMm: number, reason: BurnoutVent['reason']): BurnoutVent => {
    let metalAboveMm = 0;
    const k = g.col[a];
    for (let m = a + 1; m < n && g.col[m] === k; m++) metalAboveMm += g.top[m] - g.bot[m];
    return { ...pointOf(a), floorZ: g.bot[a], metalAboveMm, insetMm, reason };
  };

  // The head of a pocket: what stands within this of its top. A vent anywhere
  // on it leaves less air than is worth venting. What the rod stands on is
  // read a little deeper, the shoulder: a steep fin's head is a sliver one
  // column wide, but the fin under it is what the rod's foot sits in.
  const headMm = Math.max(g.cell, opts.minDepthMm * 0.5);
  const shoulderMm = Math.max(2 * g.cell, opts.minDepthMm * 2);
  const neighbourSlots = (a: number) => {
    const k = g.col[a], c = k % g.cols, r = Math.floor(k / g.cols);
    let slots = 0;
    for (let dc = -1; dc <= 1; dc++) for (let dr = -1; dr <= 1; dr++) {
      if ((dc || dr) && c + dc >= 0 && r + dr >= 0 && c + dc < g.cols && r + dr < g.rows) slots++;
    }
    return slots;
  };

  /** The head of `cands`, each node with how far in from the shoulder's edge it is, mm. */
  const headOf = (cands: number[]) => {
    let maxTop = -Infinity;
    for (const a of cands) if (g.top[a] > maxTop) maxTop = g.top[a];
    const head = cands.filter((a) => g.top[a] >= maxTop - headMm);
    const shoulder = new Set(cands.filter((a) => g.top[a] >= maxTop - shoulderMm));
    const steps = new Map<number, number>();
    const queue: number[] = [];
    for (const a of shoulder) {
      const cols = new Set<number>();
      for (let j = g.adjStart[a]; j < g.adjStart[a + 1]; j++) if (shoulder.has(g.adj[j])) cols.add(g.col[g.adj[j]]);
      if (cols.size < 8 || neighbourSlots(a) < 8) { steps.set(a, 0); queue.push(a); }
    }
    for (let i = 0; i < queue.length; i++) {
      const a = queue[i];
      for (let j = g.adjStart[a]; j < g.adjStart[a + 1]; j++) {
        const m = g.adj[j];
        if (shoulder.has(m) && !steps.has(m)) { steps.set(m, steps.get(a)! + 1); queue.push(m); }
      }
    }
    return { head, shoulder: [...shoulder], insetMm: (a: number) => ((steps.get(a) ?? 0) + 0.5) * g.cell };
  };

  /**
   * The best place on the head of `cands` for a rod: furthest in from the
   * head's edge, then furthest from the inflow, then highest.
   */
  const placeIn = (cands: number[], inflow: Float64Array): { at: number; inset: number } | 'too-fine' | 'blocked' => {
    const { head, insetMm } = headOf(cands);
    const order = head
      .map((a) => ({ a, inset: insetMm(a) }))
      .sort((p, q) =>
        q.inset - p.inset ||
        (Number.isFinite(inflow[q.a]) ? inflow[q.a] : 0) - (Number.isFinite(inflow[p.a]) ? inflow[p.a] : 0) ||
        g.top[q.a] - g.top[p.a]);
    let blocked = false;
    for (const { a, inset } of order) {
      const f = opts.fits(xOf(g, a), yOf(g, a), g.top[a], g.bot[a], inset);
      if (f === 'ok') return { at: a, inset };
      if (f === 'blocked') blocked = true;
    }
    return blocked ? 'blocked' : 'too-fine';
  };

  const ventNodes: number[] = [];
  // Spans walled off as the head of a pocket no vent fits on. A pocket whose
  // head keeps failing is walled a layer at a time down its feature; that is
  // one pocket, one warning, and a bounded number of tries — past which what
  // is left counts as left over.
  const unventableSpan = new Uint8Array(n);
  let tries = 0;
  for (;;) {
    if (++tries > 4 * opts.maxVents + 64) { plan.leftOver = Math.max(plan.leftOver, 1); break; }
    const spill = spillLevels(g, [...outlets, ...ventNodes], walled);
    const depth = (a: number) => (walled[a] || spill[a] === -Infinity ? 0 : g.top[a] - spill[a]);
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
      .sort((a, b) => b.deepest - a.deepest || b.air - a.air);
    if (pockets.length === 0) break;
    if (plan.vents.length >= opts.maxVents) { plan.leftOver = pockets.length; break; }
    const p = pockets[0];
    const spot = placeIn(p.comp, cavityDistance(g, [...outlets, ...ventNodes]));
    if (typeof spot === 'string') {
      // Wall off only the head that cannot be vented: the rest of the pocket
      // re-forms against the real spill level and gets its own chance.
      // Too fine: the whole shoulder goes, and what widens out below it
      // re-forms as a pocket of its own that may take a rod. Blocked by the
      // sprue: only the head, so the rest is tried further out.
      const { head: h, shoulder } = headOf(p.comp);
      const head = spot === 'too-fine' ? shoulder : h;
      const continues = head.some((a) => {
        for (let j = g.adjStart[a]; j < g.adjStart[a + 1]; j++) if (unventableSpan[g.adj[j]]) return true;
        return false;
      });
      if (!continues) {
        if (spot === 'blocked') plan.unventable.push(pointOf(highest(p.comp)));
        else plan.tooFine.push({ ...pointOf(highest(p.comp)), depthMm: p.deepest });
      }
      for (const a of head) { walled[a] = 1; unventableSpan[a] = 1; }
      continue;
    }
    ventNodes.push(spot.at);
    plan.vents.push(ventAt(spot.at, spot.inset, 'pocket'));
  }

  // The far ends from the sprue, measured along the cavity: every separate
  // region that lies within a fifth of the furthest reach of it.
  if (plan.vents.length < opts.maxVents && opts.farEndMm > 0) {
    const dist = cavityDistance(g, outlets);
    let far = 0;
    for (let a = 0; a < n; a++) if (g.isColumnTop[a] && Number.isFinite(dist[a])) far = Math.max(far, dist[a]);
    if (far > opts.farEndMm) {
      const inRegion = (a: number) => g.isColumnTop[a] === 1 && !walled[a] && Number.isFinite(dist[a]) && dist[a] >= far * 0.8;
      const regions = components(g, inRegion)
        .map((comp) => ({ comp, reach: comp.reduce((m, a) => Math.max(m, dist[a]), 0) }))
        .sort((a, b) => b.reach - a.reach);
      for (const r of regions) {
        if (plan.vents.length >= opts.maxVents) break;
        const furthest = r.comp.reduce((b, a) => (dist[a] > dist[b] ? a : b), r.comp[0]);
        const covered = plan.vents.some((v) => Math.hypot(v.x - xOf(g, furthest), v.y - yOf(g, furthest)) < opts.farEndMm * 0.8);
        if (covered) continue;
        const spot = placeIn(r.comp, dist);
        if (typeof spot !== 'string') plan.vents.push(ventAt(spot.at, spot.inset, 'far-end'));
      }
    }
  }
  return plan;
}
