/**
 * Turns a ClothSpec into triangles and stitches: each piece's outline is
 * resampled at the mesh spacing, filled with a triangular lattice,
 * Delaunay-triangulated and clipped to the outline, then placed in 3D. Seams
 * become vertex pairs; ties become vertex lists. Pure, and cached by spec, so
 * the MJCF compiler can call it on every rebuild.
 */

import { delaunay } from './delaunay';
import type {
  AlongPlacement, ClothEdge, ClothMaterial, ClothMaterialName, ClothPiece, ClothPlacement, ClothSpec, GirthPlacement, SeamSide, UV,
} from '../../types/cloth';

/*
 * Damping 0.2 throughout. At MuJoCo's lighter defaults a tensioned sheet on a
 * fine mesh rang itself apart, and at 0.05 a shade sail still grew a flutter
 * that tore it loose after ~15 s, calm or windy. Damping does not change where
 * cloth comes to rest (the sail's corner loads were the same), only whether
 * it gets there. Cloth is heavily damped in life too: it does not ring.
 */
export const CLOTH_MATERIALS: Record<ClothMaterialName, ClothMaterial> = {
  // 160 g/m2 cotton jersey, a t-shirt: 0.8 mm, as jersey is. Modelled 2 mm
  // thick (the same stretch at 2.5x less modulus), it was 15x stiffer to
  // bend, could not follow the form into the armpit, and chattered there.
  jersey: { arealDensity: 0.16, young: 2.5e6, poisson: 0.2, thickness: 0.0008, bending: true, damping: 0.2, friction: 0.6, windCd: 1.2 },
  // Shirting or poplin: about twice as heavy for its stretch, and stiffer.
  woven: { arealDensity: 0.12, young: 4e6, poisson: 0.2, thickness: 0.0015, bending: true, damping: 0.2, friction: 0.5, windCd: 1.2 },
  // Heavy cotton duck.
  canvas: { arealDensity: 0.4, young: 1e7, poisson: 0.25, thickness: 0.001, bending: true, damping: 0.2, friction: 0.7, windCd: 1.2 },
  // Knitted HDPE shade cloth. Open, so it takes less of the wind; a membrane
  // with no bending stiffness worth paying for.
  shadeCloth: { arealDensity: 0.185, young: 1e7, poisson: 0.3, thickness: 0.0008, bending: false, damping: 0.2, friction: 0.6, windCd: 0.8 },
};

/**
 * The stiffest a sheet may be on a mesh this fine, as the square of its wave
 * speed (E*t / areal density, m^2/s^2) per metre of spacing. Stiffer than this
 * and the 4 ms step cannot keep up: measured on a tied sail, shade cloth at
 * 3e7 Pa held at 15 cm spacing and rang loose at 5 cm, and 1e7 held at 3 cm.
 * So cloth on a fine mesh is a little stretchier than the fabric it names.
 */
export const CLOTH_STIFFNESS_PER_SPACING = 1e6;

/** Young's modulus to emit for this material on a mesh of this spacing. */
export function stableYoung(mat: ClothMaterial, spacing: number, scale = 1): number {
  const wanted = mat.young * scale;
  const ceiling = (CLOTH_STIFFNESS_PER_SPACING * spacing * mat.arealDensity) / mat.thickness;
  return Math.min(wanted, ceiling);
}

export const DEFAULT_CLOTH_SPACING = 0.04;
export const DEFAULT_SEW_TIME = 1.5;

export function clothMaterial(spec: ClothSpec): ClothMaterial {
  return { ...CLOTH_MATERIALS[spec.material ?? 'jersey'], ...(spec.materialOverrides ?? {}) };
}

// ---------- 2D ----------

export const polyLen = (pts: UV[]) =>
  pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);

/** `n` equal steps along a polyline, both ends included. */
function resample(pts: UV[], step: number, count?: number): UV[] {
  const L = polyLen(pts);
  const n = count ?? Math.max(1, Math.round(L / step));
  const out: UV[] = [];
  let seg = 0, acc = 0;
  for (let i = 0; i <= n; i++) {
    const target = (L * i) / n;
    while (seg < pts.length - 2) {
      const l = Math.hypot(pts[seg + 1][0] - pts[seg][0], pts[seg + 1][1] - pts[seg][1]);
      if (acc + l >= target) break;
      acc += l;
      seg++;
    }
    const a = pts[seg], b = pts[seg + 1] ?? a;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const t = Math.min(1, Math.max(0, (target - acc) / l));
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

const inside = (poly: UV[], [x, y]: UV) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

const distToPoly = (poly: UV[], [x, y]: UV) => {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    d = Math.min(d, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return d;
};

export interface PieceMesh {
  /** Pattern-space points; the outline's come first, in order. */
  uv: UV[];
  /** Placed points, body frame: the rest shape. */
  pts: number[][];
  /** Where each point starts, body frame (the piece's `start`, else `pts`). */
  start: number[][];
  /** Triangles, wound counter-clockwise in pattern space. */
  tris: number[];
  /** Point indices along each edge, first to last; the last is the next edge's first. */
  edgeVerts: Record<string, number[]>;
}

/** Boundary sampled at `step`, interior a triangular lattice, Delaunay, clipped to the outline. */
export function meshOutline(edges: ClothEdge[], step: number, counts: Record<string, number> = {}): Omit<PieceMesh, 'pts'> {
  if (edges.length === 0) throw new Error('a cloth piece needs at least one edge');
  const uv: UV[] = [];
  const ids: number[][] = [];
  for (const e of edges) {
    if (e.pts.length < 2) throw new Error(`cloth edge "${e.id}" needs at least two points`);
    const r = resample(e.pts, step, counts[e.id]);
    const list: number[] = [];
    for (let i = 0; i < r.length - 1; i++) { list.push(uv.length); uv.push(r[i]); }
    list.push(-1); // the next edge's first point
    ids.push(list);
  }
  for (let k = 0; k < ids.length; k++) ids[k][ids[k].length - 1] = ids[(k + 1) % ids.length][0];
  const outline = uv.slice();
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const [u, v] of outline) { minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v); }
  const dv = (step * Math.sqrt(3)) / 2;
  for (let row = 0, v = minV + dv / 2; v < maxV; v += dv, row++) {
    for (let u = minU + (row % 2 ? step / 2 : 0); u < maxU; u += step) {
      const p: UV = [u, v];
      if (inside(outline, p) && distToPoly(outline, p) > step * 0.55) uv.push(p);
    }
  }
  const all = delaunay(uv);
  const tris: number[] = [];
  for (let t = 0; t < all.length; t += 3) {
    const a = all[t], b = all[t + 1], c = all[t + 2];
    const cx = (uv[a][0] + uv[b][0] + uv[c][0]) / 3, cy = (uv[a][1] + uv[b][1] + uv[c][1]) / 3;
    if (!inside(outline, [cx, cy])) continue;
    // Three collinear points along a straight edge make a zero-area sliver,
    // and a flex element with no area has no defined stiffness.
    const cross = (uv[b][0] - uv[a][0]) * (uv[c][1] - uv[a][1]) - (uv[c][0] - uv[a][0]) * (uv[b][1] - uv[a][1]);
    if (Math.abs(cross) / 2 < 0.05 * step * step) continue;
    // Counter-clockwise in (u, v), so every piece faces the same way out of its pattern.
    if (cross > 0) tris.push(a, b, c); else tris.push(a, c, b);
  }
  const edgeVerts: Record<string, number[]> = {};
  edges.forEach((e, k) => { edgeVerts[e.id] = ids[k]; });
  return { uv, tris, edgeVerts };
}

// ---------- 3D ----------

const norm = (v: number[]) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross3 = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Half the u-extent of an outline's row at height v (its widest point either side of u = 0). */
function rowHalfWidth(outline: UV[], v: number): number {
  let h = 0;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [ui, vi] = outline[i], [uj, vj] = outline[j];
    if ((vi > v) !== (vj > v)) h = Math.max(h, Math.abs(ui + ((v - vi) * (uj - ui)) / (vj - vi)));
  }
  return h;
}

/** Arc length round an ellipse (half-axes a, b) from its front point, tabulated against angle. */
function ellipseArc(a: number, b: number, n = 96) {
  const phi: number[] = [0], len: number[] = [0];
  for (let i = 1; i <= n; i++) {
    const t = (Math.PI * i) / n, t0 = (Math.PI * (i - 1)) / n;
    phi.push(t);
    len.push(len[i - 1] + Math.hypot(a * (Math.sin(t) - Math.sin(t0)), b * (Math.cos(t) - Math.cos(t0))));
  }
  const quarter = len[n >> 1];
  /** The angle at which arc length `s` is reached (clamped to the back point). */
  const angle = (s: number) => {
    if (s >= len[n]) return Math.PI;
    let i = 1;
    while (len[i] < s) i++;
    const f = (s - len[i - 1]) / (len[i] - len[i - 1] || 1);
    return phi[i - 1] + f * (phi[i] - phi[i - 1]);
  };
  return { quarter, angle };
}

function girthPlacer(p: GirthPlacement, outline: UV[]): (q: UV) => number[] {
  const prof = p.profile.slice().sort((x, y) => x.v - y.v);
  if (!prof.length) throw new Error('a girth placement needs a profile');
  const at = (v: number) => {
    if (v <= prof[0].v) return prof[0];
    for (let i = 1; i < prof.length; i++) {
      if (v <= prof[i].v) {
        const a = prof[i - 1], b = prof[i], t = (v - a.v) / (b.v - a.v || 1);
        return { v, halfWidth: a.halfWidth + (b.halfWidth - a.halfWidth) * t, halfDepth: a.halfDepth + (b.halfDepth - a.halfDepth) * t, centreY: a.centreY + (b.centreY - a.centreY) * t };
      }
    }
    return prof[prof.length - 1];
  };
  const rows = new Map<number, { A: number; B: number; cy: number; angle: (s: number) => number }>();
  const row = (v: number) => {
    const key = Math.round(v * 1e4);
    let r = rows.get(key);
    if (!r) {
      const c = at(v), a0 = c.halfWidth + p.gap, b0 = Math.max(1e-3, c.halfDepth + p.gap);
      // Enlarged until the row reaches the side: then front and back, each
      // wrapped the same way, start with their side seams together. A row a
      // little shorter than the body (a close fit) may tuck in slightly.
      const k = Math.max(0.9, rowHalfWidth(outline, v) / ellipseArc(a0, b0).quarter);
      const A = a0 * k, B = b0 * k;
      r = { A, B, cy: c.centreY, angle: ellipseArc(A, B).angle };
      rows.set(key, r);
    }
    return r;
  };
  const sy = p.facing === 'front' ? -1 : 1;
  return ([u, v]) => {
    const r = row(v), phi = r.angle(Math.abs(u));
    return [p.origin[0] + Math.sign(u) * r.A * Math.sin(phi), p.origin[1] + r.cy + sy * r.B * Math.cos(phi), p.origin[2] + v];
  };
}

export function placer(p: ClothPlacement | undefined, outline: UV[] = []): (q: UV) => number[] {
  if (p?.kind === 'girth') return girthPlacer(p, outline);
  if (p?.kind === 'along') throw new Error('an along placement is placed after the pieces it follows');
  if (!p || p.kind === 'plane') {
    const o = p?.origin ?? [0, 0, 0], U = p?.uAxis ?? [1, 0, 0], V = p?.vAxis ?? [0, 1, 0];
    return ([u, v]) => [0, 1, 2].map((k) => o[k] + u * U[k] + v * V[k]);
  }
  const axis = norm(p.axis);
  // Make `ref` square to the axis, so a careless one still rolls a true tube.
  const d = p.ref[0] * axis[0] + p.ref[1] * axis[1] + p.ref[2] * axis[2];
  const ref = norm([p.ref[0] - d * axis[0], p.ref[1] - d * axis[1], p.ref[2] - d * axis[2]]);
  const turn = cross3(axis, ref);
  const side = p.clockwise ? turn.map((x) => -x) : turn;
  const r0 = p.radius, taper = p.taper ?? 0, u0 = p.startU ?? 0;
  return ([u, v]) => {
    const th = (u - u0) / r0, r = Math.max(1e-3, r0 + taper * v), c = Math.cos(th), s = Math.sin(th);
    return [0, 1, 2].map((k) => p.origin[k] + v * axis[k] + r * (c * ref[k] + s * side[k]));
  };
}

export interface ClothMesh {
  spacing: number;
  pieces: Record<string, PieceMesh>;
  /** Stitches: [pieceA, vertA, pieceB, vertB, seam index]. */
  stitches: { a: [string, number]; b: [string, number]; seam: number }[];
  /** Per tie, the vertices it holds and, when anchored, where each should end. */
  ties: { tie: number; piece: string; verts: number[] }[];
}

/** Vertex chain along one seam side, with arc-length fractions measured flat. */
function chain(side: SeamSide, pieces: Record<string, PieceMesh>) {
  const out: { piece: string; id: number; t: number }[] = [];
  for (const { piece, edge, reversed } of side) {
    const m = pieces[piece];
    if (!m) throw new Error(`seam names piece "${piece}", which this cloth does not have`);
    const ev = m.edgeVerts[edge];
    if (!ev) throw new Error(`seam names edge "${edge}" of "${piece}", which it does not have`);
    const ids = reversed ? ev.slice().reverse() : ev;
    for (const id of out.length ? ids.slice(1) : ids) out.push({ piece, id, t: 0 });
  }
  let f = 0;
  for (let i = 1; i < out.length; i++) {
    const p = pieces[out[i].piece].uv[out[i].id], q = pieces[out[i - 1].piece].uv[out[i - 1].id];
    // Successive edges of different pieces meet at a seam corner: no length between them.
    if (out[i].piece === out[i - 1].piece) f += Math.hypot(p[0] - q[0], p[1] - q[1]);
    out[i].t = f;
  }
  for (const q of out) q.t = f ? q.t / f : 0;
  return out;
}

type ChainPoint = { piece: string; id: number; t: number };

/**
 * One stitch per point of the shorter side, to the point at the nearest
 * fraction of the longer, each used once: the longer side's spare points
 * gather between stitches, which is what easing is. Stitching every point of
 * the longer side instead put two neighbours onto one point, asking the cloth
 * between them to shrink to nothing; it never could, and the seam fought it
 * forever, jittering and holding the seam open. Pairs come back as [a, b].
 */
function pairChains(a: ChainPoint[], b: ChainPoint[]): [ChainPoint, ChainPoint][] {
  const [long, short, swap] = a.length >= b.length ? [a, b, false] : [b, a, true];
  const out: [ChainPoint, ChainPoint][] = [];
  let from = 0;
  short.forEach((r, k) => {
    // Leave enough of the longer side for the points still to come.
    const last = long.length - (short.length - k);
    let best = from;
    for (let i = from; i <= last; i++) {
      if (Math.abs(long[i].t - r.t) < Math.abs(long[best].t - r.t)) best = i;
      else if (long[i].t > r.t) break;
    }
    from = best + 1;
    out.push(swap ? [r, long[best]] : [long[best], r]);
  });
  return out;
}

/**
 * Segment counts for edges sewn edge to edge at nearly the same length (within
 * 10%): both sides of such a pair get the same number, so every point has a
 * partner. Resampled independently, a dart's two legs came out at 5 and 4
 * points, and the one left over puckered open. Edges sewn at different
 * lengths on purpose (a sleeve cap eased into its armhole) keep theirs.
 */
function matchedCounts(spec: ClothSpec, spacing: number): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  const piece = (name: string) => spec.pieces.find((p) => p.name === name);
  const len = (side: SeamSide[number]) => {
    const e = piece(side.piece)?.edges.find((x) => x.id === side.edge);
    return e ? polyLen(e.pts) : 0;
  };
  const step = (side: SeamSide[number]) => spacing * (piece(side.piece)?.spacingScale ?? 1);
  for (const s of spec.seams ?? []) {
    const parts: [SeamSide[number], SeamSide[number]][] = s.a.length === s.b.length ? s.a.map((e, k) => [e, s.b[k]]) : [];
    for (const [a, b] of parts) {
      const la = len(a), lb = len(b);
      if (!la || !lb || Math.abs(la - lb) > 0.1 * Math.max(la, lb)) continue;
      const n = Math.max(1, Math.round(la / step(a)), Math.round(lb / step(b)));
      for (const side of [a, b]) {
        const prev = out[side.piece]?.[side.edge];
        (out[side.piece] ??= {})[side.edge] = Math.max(prev ?? 0, n);
      }
    }
  }
  return out;
}

const cache = new Map<string, ClothMesh>();
const CACHE_MAX = 32;

export function meshCloth(spec: ClothSpec): ClothMesh {
  const spacing = spec.spacing ?? DEFAULT_CLOTH_SPACING;
  const key = JSON.stringify([spec.pieces, spec.seams, spec.ties, spacing]);
  const hit = cache.get(key);
  if (hit) return hit;
  if (!(spacing > 0.002)) throw new Error('cloth spacing must be over 2 mm');
  const pieces: Record<string, PieceMesh> = {};
  const counts = matchedCounts(spec, spacing);
  for (const p of spec.pieces) {
    if (pieces[p.name]) throw new Error(`two cloth pieces are called "${p.name}"`);
    const m = meshOutline(p.edges, spacing * (p.spacingScale ?? 1), counts[p.name]);
    const outline = p.edges.flatMap((e) => e.pts.slice(0, -1));
    const pts = m.uv.map(placer(p.placement, outline));
    const start = p.start && p.start.kind !== 'along' ? m.uv.map(placer(p.start, outline)) : pts;
    pieces[p.name] = { ...m, pts, start };
  }
  // Then whatever starts along the others, now they are placed.
  for (const p of spec.pieces) {
    if (p.start?.kind === 'along') pieces[p.name].start = placeAlong(p.start, pieces[p.name], pieces);
  }
  const stitches: ClothMesh['stitches'] = [];
  (spec.seams ?? []).forEach((s, seam) => {
    // Notches. When both sides are walked over the same number of edges, each
    // edge is sewn to its counterpart, so every place one edge gives way to
    // the next is a mark the two sides must meet at: a sleeve's crown at the
    // shoulder seam, say. Sewn by fraction of the whole length instead, the
    // shoulder point slid past the crown wherever the front and back armholes
    // differed, and left a hole at the top of the sleeve.
    const parts: [SeamSide, SeamSide][] = s.a.length === s.b.length && s.a.length > 1
      ? s.a.map((e, k) => [[e], [s.b[k]]])
      : [[s.a, s.b]];
    const seen = new Set<string>();
    for (const [sa, sb] of parts) {
      for (const [x, y] of pairChains(chain(sa, pieces), chain(sb, pieces))) {
        const key = `${x.piece}:${x.id}|${y.piece}:${y.id}`;
        if (seen.has(key) || (x.piece === y.piece && x.id === y.id)) continue;
        seen.add(key);
        stitches.push({ a: [x.piece, x.id], b: [y.piece, y.id], seam });
      }
    }
  });
  const ties: ClothMesh['ties'] = [];
  (spec.ties ?? []).forEach((t, tie) => {
    const m = pieces[t.piece];
    if (!m) throw new Error(`tie names piece "${t.piece}", which this cloth does not have`);
    const ev = m.edgeVerts[t.edge];
    if (!ev) throw new Error(`tie names edge "${t.edge}" of "${t.piece}", which it does not have`);
    if (t.at === undefined) { ties.push({ tie, piece: t.piece, verts: ev.slice() }); return; }
    // The vertex nearest that fraction of the edge's length.
    const uv = ev.map((i) => m.uv[i]);
    const target = Math.min(1, Math.max(0, t.at)) * polyLen(uv);
    let acc = 0, best = 0, bestD = Infinity;
    for (let i = 0; i < uv.length; i++) {
      if (i) acc += Math.hypot(uv[i][0] - uv[i - 1][0], uv[i][1] - uv[i - 1][1]);
      if (Math.abs(acc - target) < bestD) { bestD = Math.abs(acc - target); best = i; }
    }
    ties.push({ tie, piece: t.piece, verts: [ev[best]] });
  });
  const out = { spacing, pieces, stitches, ties };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, out);
  return out;
}

/** A piece's start along the 3D path of others' edges: u by fraction of its extent, v along `up`. */
function placeAlong(p: AlongPlacement, m: PieceMesh, pieces: Record<string, PieceMesh>): number[][] {
  const path: number[][] = [];
  for (const { piece, edge, reversed } of p.path) {
    const pm = pieces[piece];
    const ev = pm?.edgeVerts[edge];
    if (!ev) throw new Error(`along names edge "${edge}" of "${piece}", which is not there`);
    for (const i of reversed ? ev.slice().reverse() : ev) path.push(pm.start[i]);
  }
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]));
  const total = cum[cum.length - 1] || 1;
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity;
  for (const [u, v] of m.uv) { uMin = Math.min(uMin, u); uMax = Math.max(uMax, u); vMin = Math.min(vMin, v); }
  const up = norm(p.up);
  return m.uv.map(([u, v]) => {
    const s = ((u - uMin) / (uMax - uMin || 1)) * total;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const f = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    return [0, 1, 2].map((k) => path[i - 1][k] + (path[i][k] - path[i - 1][k]) * f + (v - vMin) * up[k]);
  });
}

/** Fabric area of one piece, m^2, measured flat. */
export function pieceArea(m: PieceMesh): number {
  let a = 0;
  for (let t = 0; t < m.tris.length; t += 3) {
    const [p, q, r] = [m.uv[m.tris[t]], m.uv[m.tris[t + 1]], m.uv[m.tris[t + 2]]];
    a += Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1])) / 2;
  }
  return a;
}

export type { ClothPiece };
