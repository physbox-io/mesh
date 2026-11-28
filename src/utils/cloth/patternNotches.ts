/**
 * Where a garment's pieces are notched so they go together: balance marks at
 * matching points of every seam, the same shell point on both pieces where
 * the pieces share one, else the same share of the seam's length (a gathered
 * side, meshed afresh). Pure: pieces in, notch positions out.
 */

import type { FlatEdge } from './patternEdges';

interface NotchPiece {
  name: string;
  uv: [number, number][];
  outline: number[];
  ids?: number[];
  edges?: FlatEdge[];
}

/** A stretch of a piece's outline along one line, sewn to the same pieces: outline edges start .. start + count - 1. */
export interface EdgeRun {
  start: number;
  count: number;
  edge: FlatEdge;
  /** Its length, metres. */
  length: number;
}

const runKey = (e: FlatEdge | undefined) => (e ? `${e.line ?? ''}|${e.sewn ? 1 : 0}|${e.open ? 1 : 0}|${[...(e.to ?? [])].sort().join(',')}` : '');

/** A piece's outline in runs of like edges; edges in `skip` (a dart's legs) break runs and belong to none. */
export function edgeRuns(p: NotchPiece, skip: Set<number> = new Set()): EdgeRun[] {
  const m = p.outline.length;
  if (!p.edges || p.edges.length !== m || m < 3) return [];
  const key = (k: number) => (skip.has(k) ? '\u0000skip' : runKey(p.edges![k]));
  let first = 0;
  while (first < m && key(first) === key((first - 1 + m) % m)) first++;
  if (first === m) first = 0;
  const len = (k: number) => {
    const a = p.uv[p.outline[k]], b = p.uv[p.outline[(k + 1) % m]];
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  };
  const runs: EdgeRun[] = [];
  for (let n = 0; n < m;) {
    const s = (first + n) % m, kk = key(s);
    let c = 0, L = 0;
    while (n < m && key((first + n) % m) === kk) { L += len((first + n) % m); c++; n++; }
    if (kk !== '\u0000skip') runs.push({ start: s, count: c, edge: p.edges[s], length: L });
  }
  return runs;
}

/** The point `f` of the way along a run, as (outline edge, t along it). */
function along(p: NotchPiece, run: EdgeRun, f: number): { k: number; t: number } {
  const m = p.outline.length;
  let goal = Math.max(0, Math.min(1, f)) * run.length;
  for (let j = 0; j < run.count; j++) {
    const k = (run.start + j) % m;
    const a = p.uv[p.outline[k]], b = p.uv[p.outline[(k + 1) % m]];
    const l = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (goal <= l || j === run.count - 1) return { k, t: l > 0 ? Math.min(1, goal / l) : 0 };
    goal -= l;
  }
  return { k: run.start, t: 0 };
}

/** How many notches a seam this long (mm) takes, and where: off-centre, so a piece cannot be sewn in upside down. */
function fractions(lengthMm: number): number[] {
  if (lengthMm < 60) return [];
  const n = lengthMm < 300 ? 1 : Math.min(4, Math.round(lengthMm / 250));
  return Array.from({ length: n }, (_, i) => (i + 1) / (n + 1) - 0.08 / (n + 1));
}

/**
 * Notches on every sewn run of every piece, matched across the seam: per
 * piece (by index), the points as (outline edge, t along it).
 */
export function placeNotches(pieces: NotchPiece[], skips: Set<number>[]): { k: number; t: number }[][] {
  const out = pieces.map(() => [] as { k: number; t: number }[]);
  const runs = pieces.map((p, i) => edgeRuns(p, skips[i]));
  // The notches each seam's first side chose, run by run: the shell point at each, and its share of the way along.
  const chosen = new Map<string, { id: number; f: number }[][]>();
  const seamOf = (p: NotchPiece, r: EdgeRun) => `${r.edge.line ?? ''}|${[p.name, ...(r.edge.to ?? [])].filter((v, i, a) => a.indexOf(v) === i).sort().join(',')}`;
  const isFirst = (pi: number, r: EdgeRun) => {
    const p = pieces[pi], names = [p.name, ...(r.edge.to ?? [])].sort();
    if (names[0] !== p.name) return false;
    if ((r.edge.to ?? []).some((n) => n !== p.name)) return true;
    // Sewn only to itself (a sleeve's underarm): its first run along the line is the first side.
    const same = runs[pi].filter((o) => o.edge.sewn && seamOf(p, o) === seamOf(p, r));
    return same[0] === r;
  };
  const sewnRuns = (pi: number) => runs[pi].filter((r) => r.edge.sewn && (r.edge.to?.length ?? 0) > 0);
  const choose = (pi: number, r: EdgeRun) => {
    const p = pieces[pi], m = p.outline.length;
    return fractions(r.length * 1000).map((f) => {
      const at = along(p, r, f);
      // On a point (t 0 or 1), so the other side can find the same shell point.
      const k = at.t > 0.5 ? (at.k + 1) % m : at.k;
      out[pi].push({ k, t: 0 });
      return { id: p.ids?.[p.outline[k]] ?? -1, f };
    });
  };
  pieces.forEach((p, pi) => {
    for (const r of sewnRuns(pi)) if (isFirst(pi, r)) {
      const key = seamOf(p, r);
      (chosen.get(key) ?? chosen.set(key, []).get(key)!).push(choose(pi, r));
    }
  });
  pieces.forEach((p, pi) => {
    const m = p.outline.length, nth = new Map<string, number>();
    for (const r of sewnRuns(pi)) {
      if (isFirst(pi, r)) continue;
      const key = seamOf(p, r), lists = chosen.get(key);
      const j = nth.get(key) ?? 0;
      nth.set(key, j + 1);
      // A second side whose first is not in the pattern chooses its own.
      if (!lists?.length) { (chosen.get(key) ?? chosen.set(key, []).get(key)!).push(choose(pi, r)); continue; }
      const vertexOf = (id: number) => {
        if (id < 0 || !p.ids) return -1;
        for (let q = 0; q <= r.count; q++) { const k = (r.start + q) % m; if (p.ids[p.outline[k]] === id) return k; }
        return -1;
      };
      // The first side's run this one shares the most notch points with; else the one in the same order.
      let list = lists[Math.min(j, lists.length - 1)], hits = 0;
      for (const l of lists) { const h = l.filter((c) => vertexOf(c.id) >= 0).length; if (h > hits) { hits = h; list = l; } }
      for (const c of list) {
        const k = vertexOf(c.id);
        // Sewn face to face, the two sides run opposite ways round their pieces.
        out[pi].push(k >= 0 ? { k, t: 0 } : along(p, r, 1 - c.f));
      }
    }
  });
  return out;
}
