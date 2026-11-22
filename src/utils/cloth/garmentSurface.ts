/**
 * Helpers for a garment's modelled surface (points and triangles), shared
 * by the garment builder (garmentShell): its open edges, cutting it open
 * and along its seams, and its split into panels at them.
 */


/**
 * The surface split into panels along its seams: triangles joined across any
 * edge that is not a seam's, by flood fill.
 */
export function splitPanels(nPoints: number, tris: number[], seamPaths: number[][]): number[][] {
  const key = (a: number, b: number) => (a < b ? a * nPoints + b : b * nPoints + a);
  const seamEdges = new Set<number>();
  for (const path of seamPaths) for (let k = 1; k < path.length; k++) seamEdges.add(key(path[k - 1], path[k]));
  const byEdge = new Map<number, number[]>();
  const nT = tris.length / 3;
  for (let t = 0; t < nT; t++) {
    for (let e = 0; e < 3; e++) {
      const k = key(tris[3 * t + e], tris[3 * t + ((e + 1) % 3)]);
      if (seamEdges.has(k)) continue;
      (byEdge.get(k) ?? byEdge.set(k, []).get(k)!).push(t);
    }
  }
  const panelOf = new Int32Array(nT).fill(-1);
  const panels: number[][] = [];
  for (let t0 = 0; t0 < nT; t0++) {
    if (panelOf[t0] >= 0) continue;
    const id = panels.length, list: number[] = [], stack = [t0];
    panelOf[t0] = id;
    while (stack.length) {
      const t = stack.pop()!;
      list.push(t);
      for (let e = 0; e < 3; e++) {
        for (const u of byEdge.get(key(tris[3 * t + e], tris[3 * t + ((e + 1) % 3)])) ?? []) {
          if (panelOf[u] < 0) { panelOf[u] = id; stack.push(u); }
        }
      }
    }
    panels.push(list);
  }
  return panels;
}

/** The surface's open edges, as closed loops of point indices. */
export function boundaryLoops(nPoints: number, tris: number[]): number[][] {
  const count = new Map<number, number>();
  const key = (a: number, b: number) => a * nPoints + b;
  for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 3; e++) { const a = tris[t + e], b = tris[t + ((e + 1) % 3)]; count.set(key(a, b), (count.get(key(a, b)) ?? 0) + 1); }
  const next = new Map<number, number>();
  for (let t = 0; t < tris.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = tris[t + e], b = tris[t + ((e + 1) % 3)];
      if (!count.has(key(b, a))) next.set(a, b);
    }
  }
  const loops: number[][] = [], seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: number[] = [];
    let v: number | undefined = start;
    while (v !== undefined && !seen.has(v)) { seen.add(v); loop.push(v); v = next.get(v); }
    if (loop.length > 2) loops.push(loop);
  }
  return loops;
}


/**
 * The surface without the points no triangle uses (those its openings were
 * cut from), indices renumbered. Left in, they were particles that took no
 * part, held fixed where the neckline had been.
 */
export function compact<T extends { points: number[][]; cut?: number[][]; tris: number[]; seams: { path: number[] }[]; edges?: { path: number[] }[]; marks?: { path: number[] }[] }>(shell: T): T {
  const map = new Int32Array(shell.points.length).fill(-1);
  const points: number[][] = [], cut: number[][] = [];
  for (const i of shell.tris) if (map[i] < 0) { map[i] = points.length; points.push(shell.points[i]); cut.push((shell.cut ?? shell.points)[i]); }
  if (shell.cut) shell.cut = cut;
  for (let k = 0; k < shell.tris.length; k++) shell.tris[k] = map[shell.tris[k]];
  for (const sm of [...shell.seams, ...(shell.edges ?? []), ...(shell.marks ?? [])]) sm.path = sm.path.map((i) => map[i]).filter((i) => i >= 0);
  shell.points = points;
  return shell;
}

/**
 * A surface cut along the zero of `f` (negative cut away), by marching
 * triangles: triangles all kept stay, all cut go, and those across the line
 * are clipped to it, through points on their edges that neighbouring
 * triangles share. A point that the line passes close to moves onto it
 * instead, so the clipping leaves no slivers. `points` gains the edge points.
 */
export function clipSurface(points: number[][], tris: number[], f: (p: number[]) => number) {
  const value = points.map(f);
  // Where along an edge the line crosses: by bisection on f itself, since f
  // is not linear along an edge (a linear guess put a neck point 16 mm off
  // the neckline).
  const edgeT = (a: number, b: number) => {
    let lo = 0, hi = 1;
    const fa = value[a] > 0;
    for (let it = 0; it < 20; it++) {
      const m = (lo + hi) / 2;
      if ((f(points[a].map((v, k) => v + (points[b][k] - v) * m)) > 0) === fa) lo = m; else hi = m;
    }
    return (lo + hi) / 2;
  };
  const across = (a: number, b: number) => (value[a] > 0 && value[b] < 0) || (value[a] < 0 && value[b] > 0);
  // Snap: a point within a quarter of an edge of the line goes onto it, at
  // its nearest crossing. All chosen before any moves, so the result does not
  // depend on the order the triangles come in.
  const SNAP = 0.25;
  const snap = new Map<number, { dist: number; to: number[] }>();
  for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = tris[t + e], b = tris[t + ((e + 1) % 3)];
    if (!across(a, b)) continue;
    const u = edgeT(a, b), len = Math.hypot(points[b][0] - points[a][0], points[b][1] - points[a][1], points[b][2] - points[a][2]);
    for (const [id, frac] of [[a, u], [b, 1 - u]] as const) {
      // Nearest by distance, not by share of the edge: a long diagonal
      // carried a shoulder point 2 cm along the neckline.
      if (frac >= SNAP || (snap.get(id)?.dist ?? Infinity) <= frac * len) continue;
      snap.set(id, { dist: frac * len, to: points[a].map((v, k) => v + (points[b][k] - v) * u) });
    }
  }
  for (const [id, { to }] of snap) { points[id] = to; value[id] = 0; }
  const crossing = new Map<string, number>();
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  const pointOn = (a: number, b: number) => {
    const k = key(a, b);
    let id = crossing.get(k);
    if (id === undefined) {
      const u = edgeT(a, b);
      points.push(points[a].map((v, j) => v + (points[b][j] - v) * u));
      value.push(0);
      id = points.length - 1;
      crossing.set(k, id);
    }
    return id;
  };
  const out: number[] = [];
  for (let t = 0; t < tris.length; t += 3) {
    const tri = [tris[t], tris[t + 1], tris[t + 2]];
    if (tri.every((id) => value[id] >= 0)) { out.push(...tri); continue; }
    if (tri.every((id) => value[id] <= 0)) continue;
    const poly: number[] = [];
    for (let e = 0; e < 3; e++) {
      const a = tri[e], b = tri[(e + 1) % 3];
      if (value[a] >= 0) poly.push(a);
      if (across(a, b)) poly.push(pointOn(a, b));
    }
    for (let j = 1; j + 1 < poly.length; j++) if (poly[0] !== poly[j] && poly[j] !== poly[j + 1] && poly[0] !== poly[j + 1]) out.push(poly[0], poly[j], poly[j + 1]);
  }
  return { tris: out, crossing, value };
}

/**
 * A path along the surface's edges from `start` toward `target`, each step
 * to the neighbour nearest it, stopping `short` of it.
 */
export function walkToward(points: number[][], tris: number[], start: number, target: number[], short: number): number[] {
  const nbr = new Map<number, Set<number>>();
  for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = tris[t + e], b = tris[t + ((e + 1) % 3)];
    (nbr.get(a) ?? nbr.set(a, new Set()).get(a)!).add(b);
    (nbr.get(b) ?? nbr.set(b, new Set()).get(b)!).add(a);
  }
  const dist = (id: number) => Math.hypot(points[id][0] - target[0], points[id][1] - target[1], points[id][2] - target[2]);
  const path = [start];
  let cur = start;
  while (dist(cur) > short) {
    let best = -1, bd = dist(cur);
    for (const n of nbr.get(cur) ?? []) if (dist(n) < bd - 1e-9) { bd = dist(n); best = n; }
    if (best < 0) break;
    path.push(best);
    cur = best;
  }
  return path;
}

/**
 * Merges each point at the end of an edge shorter than `minLen` (a length,
 * or one for the edge between two points: a share of the triangles' size
 * there) that touches the surface's open edge into its neighbour on that
 * edge (which keeps its place). Returns where each point went.
 */
export function collapseShortBoundaryEdges(points: number[][], tris: number[], minLen: number | ((a: number, b: number) => number)): number[] {
  const shortOf = typeof minLen === 'number' ? () => minLen : minLen;
  const parent = points.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let pass = 0; pass < 4; pass++) {
    const live: number[] = [];
    for (let t = 0; t < tris.length; t += 3) {
      const a = find(tris[t]), b = find(tris[t + 1]), c = find(tris[t + 2]);
      if (a !== b && b !== c && a !== c) live.push(a, b, c);
    }
    const onEdge = new Set<number>();
    for (const loop of boundaryLoops(points.length, live)) for (const id of loop) onEdge.add(id);
    let merged = false;
    const len = (a: number, b: number) => Math.hypot(points[a][0] - points[b][0], points[a][1] - points[b][1], points[a][2] - points[b][2]);
    for (let t = 0; t < live.length; t += 3) {
      // A needle (shape quality under 0.3, 1 for equilateral) gives up its
      // shortest edge too: its lengths cannot all be met either.
      const ids = [find(live[t]), find(live[t + 1]), find(live[t + 2])];
      const ls = [len(ids[0], ids[1]), len(ids[1], ids[2]), len(ids[2], ids[0])];
      const p0 = points[ids[0]], p1 = points[ids[1]], p2 = points[ids[2]];
      const cr = [(p1[1] - p0[1]) * (p2[2] - p0[2]) - (p1[2] - p0[2]) * (p2[1] - p0[1]), (p1[2] - p0[2]) * (p2[0] - p0[0]) - (p1[0] - p0[0]) * (p2[2] - p0[2]), (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0])];
      const quality = (2 * Math.sqrt(3) * Math.hypot(cr[0], cr[1], cr[2])) / Math.max(1e-12, ls[0] ** 2 + ls[1] ** 2 + ls[2] ** 2);
      const shortest = ls.indexOf(Math.min(...ls));
      for (let e = 0; e < 3; e++) {
        const a = find(live[t + e]), b = find(live[t + ((e + 1) % 3)]);
        if (a === b || (!onEdge.has(a) && !onEdge.has(b))) continue;
        if (len(a, b) >= shortOf(a, b) && !(quality < 0.3 && e === shortest)) continue;
        // The point on the open edge stays; the other joins it.
        const [keep, drop] = onEdge.has(a) ? [a, b] : [b, a];
        parent[drop] = keep;
        merged = true;
      }
    }
    if (!merged) break;
  }
  return points.map((_, i) => find(i));
}

/**
 * The surface cut through along the zero of `f` wherever `where` holds of a
 * triangle (given its centroid and corners; a seam): each triangle across
 * it split in two along it, through points on
 * its edges that its neighbours share; a point near the line moved onto it
 * instead, so no slivers. Unlike clipSurface, both sides stay. Returns the
 * triangles, the seam's edges (pairs of points along the line), and the
 * edges it split.
 */
export function splitAlong(points: number[][], tris: number[], f: (p: number[]) => number, where: (centroid: number[], corners: number[][], triIdx: number) => boolean, locked?: Set<number>): { tris: number[]; edges: [number, number][]; split: Map<string, number> } {
  // f at a point, found when first wanted: only the corners of the triangles
  // the cut is in are (a drawn curve's f is costly far from it).
  const value: number[] = new Array(points.length).fill(NaN);
  const val = (i: number) => { let v = value[i]; if (Number.isNaN(v)) v = value[i] = f(points[i]); return v; };
  const len = (a: number, b: number) => Math.hypot(points[a][0] - points[b][0], points[a][1] - points[b][1], points[a][2] - points[b][2]);
  const across = (a: number, b: number) => (val(a) > 0 && val(b) < 0) || (val(a) < 0 && val(b) > 0);
  const edgeT = (a: number, b: number) => {
    let lo = 0, hi = 1;
    const fa = val(a) > 0;
    for (let it = 0; it < 20; it++) {
      const m = (lo + hi) / 2;
      if ((f(points[a].map((v, k) => v + (points[b][k] - v) * m)) > 0) === fa) lo = m; else hi = m;
    }
    return (lo + hi) / 2;
  };
  const centroid = (t: number[]) => [0, 1, 2].map((k) => (points[t[0]][k] + points[t[1]][k] + points[t[2]][k]) / 3);
  const keyOf = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  // Snap, all decided before any point moves: a point within a quarter of
  // an edge of the line goes onto it at its nearest crossing.
  const snap = new Map<number, { dist: number; to: number[] }>();
  for (let t = 0; t < tris.length; t += 3) {
    const tri = [tris[t], tris[t + 1], tris[t + 2]];
    if (!where(centroid(tri), tri.map((id) => points[id]), t / 3)) continue;
    for (let e = 0; e < 3; e++) {
      const a = tri[e], b = tri[(e + 1) % 3];
      if (!across(a, b)) continue;
      const u = edgeT(a, b), l = len(a, b), bothLocked = locked?.has(a) && locked?.has(b);
      for (const [id, frac] of [[a, u], [b, 1 - u]] as const) {
        if (frac >= 0.25 || (!bothLocked && locked?.has(id) && frac >= 0.05) || (snap.get(id)?.dist ?? Infinity) <= frac * l) continue;
        snap.set(id, { dist: frac * l, to: locked?.has(id) ? points[id] : points[a].map((v, k) => v + (points[b][k] - v) * u) });
      }
    }
  }
  for (const [id, { to }] of snap) { points[id] = to; value[id] = 0; }
  const crossing = new Map<string, number>();
  const pointOn = (a: number, b: number) => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    let id = crossing.get(key);
    if (id === undefined) {
      const u = edgeT(a, b);
      points.push(points[a].map((v, j) => v + (points[b][j] - v) * u));
      value.push(0);
      id = points.length - 1;
      crossing.set(key, id);
    }
    return id;
  };
  const out: number[] = [];
  const edges: [number, number][] = [];
  const fan = (poly: number[]) => { for (let j = 1; j + 1 < poly.length; j++) if (poly[0] !== poly[j] && poly[j] !== poly[j + 1] && poly[0] !== poly[j + 1]) out.push(poly[0], poly[j], poly[j + 1]); };
  // A triangle with points let into its edges, cut into triangles none of
  // them flat (a fan from a corner on a split edge made one of no area).
  const area2 = (a: number, b: number, c: number) => {
    const p = points[a], q = points[b], r = points[c];
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
  };
  const earClip = (poly: number[]) => {
    const ring = poly.slice();
    let guard = 0;
    while (ring.length > 3 && guard++ < 20) {
      // The ear with the most area: clip it.
      let best = -1, ba = 0;
      for (let i = 0; i < ring.length; i++) {
        const a2 = area2(ring[(i - 1 + ring.length) % ring.length], ring[i], ring[(i + 1) % ring.length]);
        if (a2 > ba) { ba = a2; best = i; }
      }
      if (best < 0) break;
      out.push(ring[(best - 1 + ring.length) % ring.length], ring[best], ring[(best + 1) % ring.length]);
      ring.splice(best, 1);
    }
    if (ring.length === 3 && area2(ring[0], ring[1], ring[2]) > 0) out.push(ring[0], ring[1], ring[2]);
  };
  const ons = [] as boolean[];
  for (let t = 0; t < tris.length; t += 3) {
    const tri = [tris[t], tris[t + 1], tris[t + 2]];
    const on = where(centroid(tri), tri.map((id) => points[id]), t / 3);
    ons.push(on);
    if (on && tri.some((id) => val(id) > 0) && tri.some((id) => val(id) < 0)) for (let e = 0; e < 3; e++) if (across(tri[e], tri[(e + 1) % 3])) pointOn(tri[e], tri[(e + 1) % 3]);
  }
  for (let t = 0; t < tris.length; t += 3) {
    const tri = [tris[t], tris[t + 1], tris[t + 2]];
    const on = ons[t / 3];
    const crosses = on && tri.some((id) => val(id) > 0) && tri.some((id) => val(id) < 0);
    if (!crosses) {
      // A neighbour split along an edge of this one (where the seam stops):
      // take its new point in, so no crack opens there.
      const poly: number[] = [];
      for (let e = 0; e < 3; e++) { poly.push(tri[e]); const c = crossing.get(keyOf(tri[e], tri[(e + 1) % 3])); if (c !== undefined) poly.push(c); }
      // An edge lying on the line (both ends snapped onto it) is the seam's too.
      if (on) for (let e = 0; e < 3; e++) { const a = tri[e], b = tri[(e + 1) % 3]; if (val(a) === 0 && val(b) === 0 && a !== b) edges.push([a, b]); }
      if (poly.length > 3) { earClip(poly); continue; }
      out.push(...tri);
      continue;
    }
    const pos: number[] = [], neg: number[] = [], cut: number[] = [];
    for (let e = 0; e < 3; e++) {
      const a = tri[e], b = tri[(e + 1) % 3];
      if (val(a) >= 0) pos.push(a);
      if (val(a) <= 0) neg.push(a);
      if (val(a) === 0) cut.push(a);
      if (across(a, b)) { const c = pointOn(a, b); pos.push(c); neg.push(c); cut.push(c); }
    }
    fan(pos); fan(neg);
    if (cut.length === 2) edges.push([cut[0], cut[1]]);
  }
  const seenEdges = new Set<string>();
  const uniqueEdges = edges.filter(([a, b]) => { const k = keyOf(a, b); if (seenEdges.has(k)) return false; seenEdges.add(k); return true; });
  // `split`: each edge a point was let into (key "a,b", a < b), so the
  // caller can carry seams already cut along it through the new point.
  return { tris: out, edges: uniqueEdges, split: crossing };
}

/**
 * The surface with no triangle of (nearly) no area. One lies flat where a
 * point was let into an edge of it but not of its neighbour across that
 * edge (a T-junction left by a cut): the neighbour takes the point in and
 * splits in two, and the flat one goes. One with two corners at the same
 * place merges them. Flat triangles broke the flattening of the panel they
 * were in (a sleeve at 93% strain, from one). Returns the edges split
 * (key "a,b", a < b, to the point let in), so seams along them can be
 * carried through, and where each point went.
 */
export function healFlatTriangles(points: number[][], tris: number[], minArea: number): { tris: number[]; split: Map<string, number>; remap: number[] } {
  const area = (a: number, b: number, c: number) => {
    const p = points[a], q = points[b], r = points[c];
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  };
  const len = (a: number, b: number) => Math.hypot(points[a][0] - points[b][0], points[a][1] - points[b][1], points[a][2] - points[b][2]);
  const remap = points.map((_, i) => i);
  const find = (i: number): number => { while (remap[i] !== i) { remap[i] = remap[remap[i]]; i = remap[i]; } return i; };
  const split = new Map<string, number>();
  const keyOf = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  let out = tris.slice();
  for (let pass = 0; pass < 4; pass++) {
    // Directed edges to their triangle, for finding the neighbour across one.
    const byEdge = new Map<string, number>();
    const undirected = new Set<string>();
    for (let t = 0; t < out.length; t += 3) for (let e = 0; e < 3; e++) {
      const u = out[t + e], v = out[t + ((e + 1) % 3)];
      byEdge.set(`${u},${v}`, t);
      undirected.add(keyOf(u, v));
    }
    const normalOf = (i0: number, i1: number, i2: number) => {
      const p = points[i0], q = points[i1], r = points[i2];
      const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2];
      const vx = r[0] - p[0], vy = r[1] - p[1], vz = r[2] - p[2];
      return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    };
    const gone = new Set<number>();
    const touched = new Set<number>();
    let changed = false;
    const origLen = out.length;
    for (let t = 0; t < origLen; t += 3) {
      if (gone.has(t) || touched.has(t)) continue;
      const tri = [out[t], out[t + 1], out[t + 2]];
      if (area(tri[0], tri[1], tri[2]) >= minArea) continue;
      const ls = [len(tri[0], tri[1]), len(tri[1], tri[2]), len(tri[2], tri[0])];
      const shortest = ls.indexOf(Math.min(...ls));
      if (ls[shortest] < 1e-7) {
        // Two corners in one place: one takes the other's place.
        remap[tri[(shortest + 1) % 3]] = tri[shortest];
        gone.add(t); changed = true;
        continue;
      }
      // The point between the other two lies on their edge: the neighbour across it takes it in,
      // provided b-d does not already exist (which would create a 4-face non-manifold edge) and
      // neither replacement triangle flips the neighbour's outward normal.
      const longest = ls.indexOf(Math.max(...ls));
      const a = tri[longest], c = tri[(longest + 1) % 3], b = tri[(longest + 2) % 3];
      const n = byEdge.get(`${c},${a}`);
      if (n === undefined || gone.has(n) || touched.has(n)) continue;
      const ntri = [out[n], out[n + 1], out[n + 2]];
      const d = ntri.find((id) => id !== a && id !== c)!;
      if (b === d || undirected.has(keyOf(b, d))) continue;
      const n0 = normalOf(c, a, d), n1 = normalOf(c, b, d), n2 = normalOf(b, a, d);
      if (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] <= 0 || n0[0] * n2[0] + n0[1] * n2[1] + n0[2] * n2[2] <= 0) continue;
      // (c, a, d) becomes (c, b, d) and (b, a, d), keeping the winding.
      out[n] = c; out[n + 1] = b; out[n + 2] = d;
      out.push(b, a, d);
      undirected.add(keyOf(b, d));
      touched.add(n);
      split.set(keyOf(a, c), b);
      gone.add(t); changed = true;
    }
    const kept: number[] = [];
    for (let t = 0; t < out.length; t += 3) {
      if (gone.has(t)) continue;
      const a = find(out[t]), b = find(out[t + 1]), c = find(out[t + 2]);
      if (a !== b && b !== c && a !== c) kept.push(a, b, c);
    }
    out = kept;
    if (!changed) break;
  }
  return { tris: out, split, remap: points.map((_, i) => find(i)) };
}

/**
 * Splits the edges near where `value` crosses zero, `levels` times over:
 * every edge with an end within its own length of the crossing (or across
 * it) is halved, and each triangle is re-cut by how many of its edges were.
 * A cut is then interpolated across triangles a quarter the size, so a
 * corner in it (a V's point, a hem's points) is not shaved off at the mesh's
 * scale. Points are added to `points`; the triangles are returned.
 */
export function refineNear(points: number[][], tris: number[], value: (p: number[]) => number, levels = 2): number[] {
  let T = tris;
  for (let lv = 0; lv < levels; lv++) {
    const v = new Map<number, number>();
    const at = (i: number) => { let x = v.get(i); if (x === undefined) { x = value(points[i]); v.set(i, x); } return x; };
    const mid = new Map<string, number>();
    const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
    const wants = (a: number, b: number) => {
      const l = Math.hypot(points[a][0] - points[b][0], points[a][1] - points[b][1], points[a][2] - points[b][2]);
      const va = at(a), vb = at(b);
      return va * vb <= 0 || Math.min(Math.abs(va), Math.abs(vb)) < l;
    };
    const split = (a: number, b: number): number => {
      const k = key(a, b);
      let m = mid.get(k);
      if (m === undefined) { m = points.length; points.push([(points[a][0] + points[b][0]) / 2, (points[a][1] + points[b][1]) / 2, (points[a][2] + points[b][2]) / 2]); mid.set(k, m); }
      return m;
    };
    // Decide per edge first, so both triangles on an edge agree.
    for (let t = 0; t < T.length; t += 3) for (let e = 0; e < 3; e++) { const a = T[t + e], b = T[t + (e + 1) % 3]; if (wants(a, b)) split(a, b); }
    const out: number[] = [];
    for (let t = 0; t < T.length; t += 3) {
      const c = [T[t], T[t + 1], T[t + 2]];
      const m = [0, 1, 2].map((e) => mid.get(key(c[e], c[(e + 1) % 3])));
      const n = m.filter((x) => x !== undefined).length;
      if (n === 0) { out.push(...c); continue; }
      if (n === 3) {
        const [ab, bc, ca] = m as number[];
        out.push(c[0], ab, ca, ab, c[1], bc, ca, bc, c[2], ab, bc, ca);
        continue;
      }
      // Rotate so the first split edge is edge 0 (a-b).
      let r = m.findIndex((x) => x !== undefined);
      if (n === 2 && m[(r + 2) % 3] !== undefined && m[r] !== undefined && m[(r + 1) % 3] === undefined) r = (r + 2) % 3;
      const a = c[r], b = c[(r + 1) % 3], cc = c[(r + 2) % 3];
      const ab = m[r]!, bc = m[(r + 1) % 3];
      if (n === 1) { out.push(a, ab, cc, ab, b, cc); continue; }
      // Edges a-b and b-c split.
      out.push(a, ab, cc, ab, b, bc!, ab, bc!, cc);
    }
    T = out;
  }
  return T;
}
