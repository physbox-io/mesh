// ---------------------------------------------------------------------------
// Sculpt carve: a scalpel drawn across the clay
// ---------------------------------------------------------------------------
//
// The brushes move vertices, and a moved vertex can only make an edge as clean
// as the triangles happen to lie: a hard brush on clay left a groove whose rim
// zigzagged with the mesh, however fine the mesh was made. A cut made with a
// tool does not have that problem. This sweeps a cutter along a path on the
// surface, each point of it sunk to the depth asked for along the surface
// normal there, and subtracts the swept solid with the same Manifold boolean
// the scissors use (utils/sculptCut.ts). The groove's walls, floor and rim are
// the cutter's own surfaces, so they are as smooth as the cutter is round, and
// exactly as deep and as wide as asked, whatever the clay's triangles were.
//
// The swept solid is the union of convex hulls of the cutter at consecutive
// path points: exact for a straight run, and a smooth joint at every bend,
// since both neighbouring hulls contain the cutter at the shared point.
//
// Coordinates are the sculpt's own: Z-up metres.
// ---------------------------------------------------------------------------

import type { ManifoldToplevel, Manifold as ManifoldT } from 'manifold-3d';
import { recomputeNormals, type SculptMesh } from './sculptMesh';

/** round: a ball-nosed U. v: a V, `width` across at the surface. flat: square walls and a flat floor. */
export type CarveProfile = 'round' | 'v' | 'flat';

export interface GrooveSpec {
  kind: 'groove';
  /** Points on the surface, in order, metres. One point is a single pit. */
  path: number[][];
  /** The outward surface normal at each point. */
  normals: number[][];
  /** Across the groove at the surface, metres. */
  width: number;
  /** Below the surface at the path, metres, along the normal. */
  depth: number;
  profile: CarveProfile;
  /** Also cut the path mirrored across this plane through the origin. */
  mirror?: 'x' | 'y' | 'z';
  /**
   * More paths cut by the same cutter in the same boolean: the scanlines that
   * fill an outline (grooveAlongSurface's `fill`).
   */
  extra?: { path: number[][]; normals: number[][]; profile?: CarveProfile }[];
}

/** Points round the cutter: enough that its facets are under a hair at any size anyone carves. */
const SEGMENTS = 64;
/** Rings down the ball of a round cutter. */
const BALL_RINGS = 12;

/**
 * The cutter as rings in its own frame: [radius, height] pairs, height along
 * the outward normal with the surface at 0. Each reaches `clear` above the
 * surface, so the groove opens out of the clay however it curves away.
 */
function profileRings(profile: CarveProfile, width: number, depth: number): [number, number][] {
  const r = width / 2;
  const clear = Math.max(width, depth);
  if (profile === 'flat') return [[r, -depth], [r, clear]];
  if (profile === 'v') {
    // The walls run on up at the same angle, so the groove is `width` across
    // exactly where the surface is.
    return [[0, -depth], [r * (depth + clear) / depth, clear]];
  }
  // A ball whose bottom is at the depth, on a shank of its own width. A groove
  // shallower than the ball's radius comes out narrower than `width`: it is
  // the ball's cap.
  const centre = -depth + r;
  const rings: [number, number][] = [];
  for (let k = 0; k <= BALL_RINGS; k++) {
    const phi = (k / BALL_RINGS) * (Math.PI / 2);
    rings.push([r * Math.sin(phi), centre - r * Math.cos(phi)]);
  }
  rings.push([r, Math.max(clear, centre + r)]);
  return rings;
}

/** The cutter's points at one path point, in the sculpt's space. */
function cutterPoints(rings: [number, number][], p: number[], n: number[]): number[][] {
  const nl = Math.hypot(n[0], n[1], n[2]) || 1;
  const w = [n[0] / nl, n[1] / nl, n[2] / nl];
  const helper = Math.abs(w[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = [helper[1] * w[2] - helper[2] * w[1], helper[2] * w[0] - helper[0] * w[2], helper[0] * w[1] - helper[1] * w[0]];
  const ul = Math.hypot(u[0], u[1], u[2]);
  u[0] /= ul; u[1] /= ul; u[2] /= ul;
  const v = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
  const out: number[][] = [];
  for (const [radius, h] of rings) {
    if (radius < 1e-9) {
      out.push([p[0] + w[0] * h, p[1] + w[1] * h, p[2] + w[2] * h]);
      continue;
    }
    for (let s = 0; s < SEGMENTS; s++) {
      const a = (s / SEGMENTS) * Math.PI * 2;
      const c = Math.cos(a) * radius, d = Math.sin(a) * radius;
      out.push([
        p[0] + u[0] * c + v[0] * d + w[0] * h,
        p[1] + u[1] * c + v[1] * d + w[1] * h,
        p[2] + u[2] * c + v[2] * d + w[2] * h,
      ]);
    }
  }
  return out;
}

function mirrored(points: number[][], axis: 'x' | 'y' | 'z'): number[][] {
  const i = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  return points.map((p) => { const q = [...p]; q[i] = -q[i]; return q; });
}

/**
 * The solid a groove removes, or null for a spec with nothing in it. The
 * caller deletes it.
 */
export function buildGroove(wasm: ManifoldToplevel, spec: GrooveSpec): ManifoldT | null {
  const { width, depth, profile } = spec;
  if (!(width > 0) || !(depth > 0) || spec.path.length === 0 || spec.normals.length !== spec.path.length) return null;

  // Points closer than this add nothing but hulls to union.
  const minStep = width * 0.1;
  const thin = (path: number[][], normals: number[][]) => {
    const run: { path: number[][]; normals: number[][] } = { path: [], normals: [] };
    for (let i = 0; i < path.length; i++) {
      const last = run.path[run.path.length - 1];
      const p = path[i];
      if (last && Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]) < minStep && i < path.length - 1) continue;
      run.path.push(p);
      run.normals.push(normals[i]);
    }
    return run;
  };
  const runs = [
    { ...thin(spec.path, spec.normals), profile },
    ...(spec.extra ?? []).map((r) => ({ ...thin(r.path, r.normals), profile: r.profile ?? profile })),
  ].filter((r) => r.path.length > 0);
  if (spec.mirror) {
    const axis = spec.mirror;
    runs.push(...runs.map((r) => ({ path: mirrored(r.path, axis), normals: mirrored(r.normals, axis), profile: r.profile })));
  }
  const ringsFor = new Map<CarveProfile, [number, number][]>();
  const cutterRings = (p: CarveProfile) => {
    if (!ringsFor.has(p)) ringsFor.set(p, profileRings(p, width, depth));
    return ringsFor.get(p)!;
  };

  const pieces: ManifoldT[] = [];
  try {
    for (const run of runs) {
      const tools = run.path.map((p, i) => cutterPoints(cutterRings(run.profile), p, run.normals[i]));
      if (tools.length === 1) {
        pieces.push(wasm.Manifold.hull(tools[0] as [number, number, number][]));
        continue;
      }
      for (let i = 1; i < tools.length; i++) {
        pieces.push(wasm.Manifold.hull([...tools[i - 1], ...tools[i]] as [number, number, number][]));
      }
    }
    if (!pieces.length) return null;
    return pieces.length === 1 ? pieces.pop()! : wasm.Manifold.union(pieces);
  } finally {
    for (const piece of pieces) piece.delete();
  }
}

/**
 * The closest point on the surface itself, not the nearest vertex, and the
 * normal there blended from its triangle's corners. A nearest vertex is up to
 * half an edge off, 3 mm on new clay, which is a groove in the wrong place.
 * Faces are rejected by a cheap corner-distance test before the exact one.
 */
export function closestOnSurface(
  mesh: SculptMesh,
  point: number[],
  longestEdge: number,
): { point: number[]; normal: number[]; distance: number } | null {
  const { positions: P, normals: N, faces: F } = mesh;
  const [px, py, pz] = point;
  let near = Infinity;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const d = (P[i * 3] - px) ** 2 + (P[i * 3 + 1] - py) ** 2 + (P[i * 3 + 2] - pz) ** 2;
    if (d < near) near = d;
  }
  const reach = Math.sqrt(near) + longestEdge;
  const reach2 = reach * reach;
  let best: { point: number[]; normal: number[]; distance: number } | null = null;
  for (let f = 0; f < mesh.faceCount; f++) {
    const a = F[f * 3], b = F[f * 3 + 1], c = F[f * 3 + 2];
    const da = (P[a * 3] - px) ** 2 + (P[a * 3 + 1] - py) ** 2 + (P[a * 3 + 2] - pz) ** 2;
    if (da > reach2) continue;
    const [u, v, w] = closestBarycentric(P, a, b, c, px, py, pz);
    const q = [0, 1, 2].map((k) => P[a * 3 + k] * u + P[b * 3 + k] * v + P[c * 3 + k] * w);
    const d = Math.hypot(q[0] - px, q[1] - py, q[2] - pz);
    if (best && d >= best.distance) continue;
    const n = [0, 1, 2].map((k) => N[a * 3 + k] * u + N[b * 3 + k] * v + N[c * 3 + k] * w);
    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
    best = { point: q, normal: [n[0] / nl, n[1] / nl, n[2] / nl], distance: d };
  }
  return best;
}

/** Barycentric weights of the point of triangle abc closest to p (Ericson, Real-Time Collision Detection 5.1.5). */
function closestBarycentric(P: Float32Array, a: number, b: number, c: number, px: number, py: number, pz: number): [number, number, number] {
  const ab = [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]];
  const ac = [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]];
  const ap = [px - P[a * 3], py - P[a * 3 + 1], pz - P[a * 3 + 2]];
  const dot = (x: number[], y: number[]) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return [1, 0, 0];
  const bp = [px - P[b * 3], py - P[b * 3 + 1], pz - P[b * 3 + 2]];
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return [0, 1, 0];
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const t = d1 / (d1 - d3); return [1 - t, t, 0]; }
  const cp = [px - P[c * 3], py - P[c * 3 + 1], pz - P[c * 3 + 2]];
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return [0, 0, 1];
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const t = d2 / (d2 - d6); return [1 - t, 0, t]; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const t = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return [0, 1 - t, t]; }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  return [1 - v - w, v, w];
}

function longestEdgeOf(mesh: SculptMesh): number {
  const { positions: P, faces: F } = mesh;
  let worst = 0;
  for (let f = 0; f < mesh.faceCount; f++) {
    for (let e = 0; e < 3; e++) {
      const a = F[f * 3 + e], b = F[f * 3 + ((e + 1) % 3)];
      worst = Math.max(worst, (P[a * 3] - P[b * 3]) ** 2 + (P[a * 3 + 1] - P[b * 3 + 1]) ** 2 + (P[a * 3 + 2] - P[b * 3 + 2]) ** 2);
    }
  }
  return Math.sqrt(worst);
}

/**
 * A groove along a path given roughly: each point snapped onto the surface,
 * the path filled in so no step is longer than half the width (a long chord
 * would dip under a curved surface and cut deeper in its middle), and the
 * normals smoothed along it so the cutter does not rock from one triangle's
 * facet to the next. Points further than `reach` from the clay are dropped and
 * returned in `missed`.
 */
export function grooveAlongSurface(
  mesh: SculptMesh,
  path: number[][],
  options: { width: number; depth: number; profile: CarveProfile; mirror?: 'x' | 'y' | 'z'; reach?: number; fill?: boolean },
): { spec: GrooveSpec; missed: number[][] } {
  if (options.fill && path.length >= 3) {
    const first = path[0], last = path[path.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1], first[2] - last[2]) > 1e-9) path = [...path, first];
  }
  recomputeNormals(mesh);
  const longest = longestEdgeOf(mesh);
  const reach = options.reach ?? Math.max(options.width * 2, 0.002);
  const step = options.width / 2;
  const missed: number[][] = [];
  const snapped: { point: number[]; normal: number[] }[] = [];
  const snap = (p: number[]) => {
    const hit = closestOnSurface(mesh, p, longest);
    if (!hit || hit.distance > reach) return null;
    return hit;
  };
  let previous: number[] | null = null;
  for (const p of path) {
    if (previous) {
      const d = Math.hypot(p[0] - previous[0], p[1] - previous[1], p[2] - previous[2]);
      const n = Math.min(200, Math.ceil(d / step));
      for (let k = 1; k < n; k++) {
        const t = k / n;
        const hit = snap([0, 1, 2].map((i) => previous![i] + (p[i] - previous![i]) * t));
        if (hit) snapped.push(hit);
      }
    }
    const hit = snap(p);
    if (hit) snapped.push(hit); else missed.push(p);
    previous = p;
  }
  // A short moving average over the normals: the blend inside one triangle is
  // smooth, but the corners' normals of a coarse mesh still turn in steps.
  const normals = snapped.map((_, i) => {
    const sum = [0, 0, 0];
    for (let j = Math.max(0, i - 2); j <= Math.min(snapped.length - 1, i + 2); j++) {
      for (let k = 0; k < 3; k++) sum[k] += snapped[j].normal[k];
    }
    const l = Math.hypot(sum[0], sum[1], sum[2]) || 1;
    return [sum[0] / l, sum[1] / l, sum[2] / l];
  });
  const extra = options.fill && snapped.length >= 3
    ? fillScanlines(mesh, snapped.map((s) => s.point), normals, options.width, longest)
    : [];
  return {
    spec: {
      kind: 'groove',
      path: snapped.map((s) => s.point),
      normals,
      width: options.width,
      depth: options.depth,
      profile: options.profile,
      ...(options.mirror ? { mirror: options.mirror } : {}),
      ...(extra.length ? { extra } : {}),
    },
    missed,
  };
}

/**
 * Lines across a closed outline, half a cutter apart, so that cutting them
 * all takes out the whole area to the depth, not only a groove round its
 * edge. Drawn in the plane through the outline that faces the way it does on
 * average, along the outline's longer side so the lines are few and long,
 * clipped to the outline even-odd, then laid back onto the clay.
 */
function fillScanlines(
  mesh: SculptMesh,
  outline: number[][],
  normals: number[][],
  width: number,
  longest: number,
): { path: number[][]; normals: number[][]; profile: CarveProfile }[] {
  const c = [0, 0, 0], n = [0, 0, 0];
  for (let i = 0; i < outline.length; i++) {
    for (let k = 0; k < 3; k++) { c[k] += outline[i][k] / outline.length; n[k] += normals[i][k]; }
  }
  const nl = Math.hypot(n[0], n[1], n[2]) || 1;
  const w = [n[0] / nl, n[1] / nl, n[2] / nl];
  const helper = Math.abs(w[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let u = [helper[1] * w[2] - helper[2] * w[1], helper[2] * w[0] - helper[0] * w[2], helper[0] * w[1] - helper[1] * w[0]];
  const ul = Math.hypot(u[0], u[1], u[2]);
  u = [u[0] / ul, u[1] / ul, u[2] / ul];
  let v = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
  const flat = (p: number[]) => {
    const r = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    return [r[0] * u[0] + r[1] * u[1] + r[2] * u[2], r[0] * v[0] + r[1] * v[1] + r[2] * v[2]];
  };
  let loop = outline.map(flat);
  // Lines along the longer side.
  const span = (i: number) => Math.max(...loop.map((p) => p[i])) - Math.min(...loop.map((p) => p[i]));
  if (span(1) > span(0)) {
    [u, v] = [v, u];
    loop = outline.map(flat);
  }
  const step = width / 2;
  const lo = Math.min(...loop.map((p) => p[1])), hi = Math.max(...loop.map((p) => p[1]));
  const runs: { path: number[][]; normals: number[][]; profile: CarveProfile }[] = [];
  for (let y = lo + step / 2; y < hi; y += step) {
    const xs: number[] = [];
    for (let i = 0; i + 1 < loop.length; i++) {
      const [ax, ay] = loop[i], [bx, by] = loop[i + 1];
      if ((ay <= y && by > y) || (by <= y && ay > y)) xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      // Flat-ended, and stopping half a cutter short of the outline: a round
      // cutter left a ridge between every two lines (0.2 mm at half a width
      // apart, stripes in the light), and the outline's own round cutter
      // already gives the pocket its rounded edge.
      const x0 = xs[k] + width / 2, x1 = xs[k + 1] - width / 2;
      if (x1 < x0) continue;
      const run: { path: number[][]; normals: number[][]; profile: CarveProfile } = { path: [], normals: [], profile: 'flat' };
      const count = Math.max(1, Math.ceil((x1 - x0) / step));
      for (let j = 0; j <= count; j++) {
        const x = x0 + ((x1 - x0) * j) / count;
        const hit = closestOnSurface(mesh, [0, 1, 2].map((i) => c[i] + u[i] * x + v[i] * y), longest);
        if (!hit) continue;
        run.path.push(hit.point);
        run.normals.push(hit.normal);
      }
      if (run.path.length) runs.push(run);
    }
  }
  return runs;
}
