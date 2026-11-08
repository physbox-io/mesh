// ---------------------------------------------------------------------------
// Where air is trapped in a cavity filled from the top
// ---------------------------------------------------------------------------
//
// Shared by the silicone mold (vents cut through the rubber) and the lost-PLA
// pattern (vent rods fused on, burnt out with it). Works on a plain triangle
// soup so it runs without the geometry engine. Lengths are mm, Z up.

import { castColumnSpans } from './columnSolid';

export interface TrappedAirPoint {
  x: number;
  y: number;
  /** The trapped ceiling: the top of the metal there, where the air collects. */
  z: number;
  /** Bottom of the metal under that ceiling, so a vent can root in it without punching through. */
  floorZ: number;
  /** Metal above the ceiling in its own column (a ledge over the pocket), mm of height. */
  metalAboveMm: number;
  /**
   * How far the ceiling rises above the level at which the pocket's air could
   * spill out sideways to something that reaches the fill level, mm: the
   * height of the bubble left there. Infinity for a piece no passage reaches.
   */
  depthMm: number;
}

/**
 * Where air would be trapped in a cavity poured from the top to `level`.
 *
 * The cavity is read as columns of solid spans. Each span's top is a ceiling
 * (unless it is the free surface at the fill level), and air under it rises
 * into a neighbouring column's span that overlaps it and reaches higher. A
 * ceiling with nowhere higher to go traps air: every span is checked, not just
 * the top one in its column, so a pocket under a ledge under another ledge is
 * found too. Each connected patch of trapped ceilings gets one point, at its
 * highest. Highest first.
 */
export function trappedAirInSoup(tris: Float64Array, level: number): TrappedAirPoint[] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i], y = tris[i + 1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (!(maxX > minX) || !(maxY > minY)) return [];
  const span = Math.max(maxX - minX, maxY - minY);
  const cell = Math.max(0.5, span / 150);
  const cols = Math.ceil((maxX - minX) / cell) + 1;
  const rows = Math.ceil((maxY - minY) / cell) + 1;
  const spans = castColumnSpans(tris, { minX, minY, stepX: cell, stepY: cell, cols, rows });
  const tol = Math.max(0.5, cell);
  // Spans of column k are nodes offset[k]/2 .. offset[k+1]/2.
  const node = (k: number) => [spans.offset[k] / 2, spans.offset[k + 1] / 2] as const;
  const bot = (n: number) => spans.z[n * 2];
  const top = (n: number) => spans.z[n * 2 + 1];
  const nodeCount = spans.z.length / 2;
  const colOf = new Int32Array(nodeCount);
  for (let k = 0; k < cols * rows; k++) { const [a, b] = node(k); for (let n = a; n < b; n++) colOf[n] = k; }
  const overlapping = (n: number, k: number): number[] => {
    const out: number[] = [];
    const [a, b] = node(k);
    for (let m = a; m < b; m++) if (bot(m) < top(n) - 1e-6 && top(m) > bot(n) + 1e-6) out.push(m);
    return out;
  };
  const neighbours = (k: number): number[] => {
    const c = k % cols, r = Math.floor(k / cols);
    const out: number[] = [];
    for (const [dc, dr] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const cc = c + dc, rr = r + dr;
      if (cc >= 0 && rr >= 0 && cc < cols && rr < rows) out.push(rr * cols + cc);
    }
    return out;
  };
  const trapped = new Uint8Array(nodeCount);
  for (let n = 0; n < nodeCount; n++) {
    if (top(n) >= level - tol) continue;
    let escapes = false;
    for (const k of neighbours(colOf[n])) {
      if (overlapping(n, k).some((m) => top(m) > top(n) + 1e-4)) { escapes = true; break; }
    }
    if (!escapes) trapped[n] = 1;
  }
  // How deep each pocket is: the inverse of filling lakes in a terrain. Air
  // leaves through the spans that reach the fill level; working outward from
  // them highest-first, each span is reached at the lowest ceiling on the best
  // path to it, and that is the level its air spills at.
  const spill = new Float64Array(nodeCount).fill(-Infinity);
  const heap: number[] = [];
  const push = (n: number) => {
    heap.push(n);
    let i = heap.length - 1;
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
  for (let n = 0; n < nodeCount; n++) if (top(n) >= level - tol) { spill[n] = top(n); push(n); }
  const done = new Uint8Array(nodeCount);
  while (heap.length) {
    const n = pop();
    if (done[n]) continue;
    done[n] = 1;
    for (const k of neighbours(colOf[n])) {
      for (const m of overlapping(n, k)) {
        const s = Math.min(spill[n], top(m));
        if (!done[m] && s > spill[m]) { spill[m] = s; push(m); }
      }
    }
  }
  const seen = new Uint8Array(nodeCount);
  const out: TrappedAirPoint[] = [];
  for (let n0 = 0; n0 < nodeCount; n0++) {
    if (!trapped[n0] || seen[n0]) continue;
    let best = n0;
    const stack = [n0];
    seen[n0] = 1;
    while (stack.length) {
      const n = stack.pop()!;
      if (top(n) > top(best)) best = n;
      for (const k of neighbours(colOf[n])) {
        for (const m of overlapping(n, k)) if (trapped[m] && !seen[m]) { seen[m] = 1; stack.push(m); }
      }
    }
    const k = colOf[best];
    const [a, b] = node(k);
    let metalAboveMm = 0;
    for (let m = a; m < b; m++) if (bot(m) >= top(best) - 1e-6) metalAboveMm += top(m) - bot(m);
    out.push({
      x: minX + (k % cols) * cell,
      y: minY + Math.floor(k / cols) * cell,
      z: top(best),
      floorZ: bot(best),
      metalAboveMm,
      depthMm: Number.isFinite(spill[best]) ? Math.max(0, top(best) - spill[best]) : Infinity,
    });
  }
  return out.sort((p, q) => q.z - p.z);
}
