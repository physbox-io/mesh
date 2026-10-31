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
  /**
   * The share of the path's length, at each end, over which the cutter
   * narrows and shallows to a point (0 to 0.5). A rib valley that fades into
   * the stem instead of stopping in a round end.
   */
  taper?: number;
  /** Radians the cutter leans sideways, about the path: a slanted cut, an undercut lid. */
  tilt?: number;
  /**
   * Added clay only: the ball swept along the path squashed along `normal`
   * (in the sculpt's frame) to `ratio` of its width, so a fluke, a flipper or
   * an ear comes out as a blade rather than a round tube.
   */
  flatten?: { normal: number[]; ratio: number };
  /**
   * Join the swept tool onto the clay instead of cutting it away: a ball of
   * `width` swept along the path, which here may leave the surface. A
   * tapered, curving tube: a stem, a horn, a handle.
   */
  add?: boolean;
}

/** Points round the cutter: enough that its facets are under a hair at any size anyone carves. */
const SEGMENTS = 64;
/** How big a tapered cutter is at the very ends of its path, as a share of its full size. */
const TAPER_TIP = 0.15;
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

/** A ball of the given diameter, centred on the path: the tool Add sweeps. */
function ballRings(width: number): [number, number][] {
  const r = width / 2;
  const rings: [number, number][] = [];
  for (let k = 0; k <= BALL_RINGS * 2; k++) {
    const phi = (k / (BALL_RINGS * 2)) * Math.PI;
    rings.push([r * Math.sin(phi), -r * Math.cos(phi)]);
  }
  return rings;
}

/** The cutter's points at one path point, in the sculpt's space. */
function cutterPoints(
  rings: [number, number][],
  p: number[],
  n: number[],
  scale = 1,
  tilt = 0,
  tangent?: number[],
): number[][] {
  const nl = Math.hypot(n[0], n[1], n[2]) || 1;
  let w = [n[0] / nl, n[1] / nl, n[2] / nl];
  if (tilt && tangent) {
    // Rodrigues, about the path's direction.
    const tl = Math.hypot(tangent[0], tangent[1], tangent[2]) || 1;
    const k = [tangent[0] / tl, tangent[1] / tl, tangent[2] / tl];
    const c = Math.cos(tilt), s = Math.sin(tilt);
    const kxw = [k[1] * w[2] - k[2] * w[1], k[2] * w[0] - k[0] * w[2], k[0] * w[1] - k[1] * w[0]];
    const kdw = k[0] * w[0] + k[1] * w[1] + k[2] * w[2];
    w = [0, 1, 2].map((i) => w[i] * c + kxw[i] * s + k[i] * kdw * (1 - c));
  }
  const helper = Math.abs(w[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = [helper[1] * w[2] - helper[2] * w[1], helper[2] * w[0] - helper[0] * w[2], helper[0] * w[1] - helper[1] * w[0]];
  const ul = Math.hypot(u[0], u[1], u[2]);
  u[0] /= ul; u[1] /= ul; u[2] /= ul;
  const v = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
  const out: number[][] = [];
  for (const [r0, h0] of rings) {
    const radius = r0 * scale, h = h0 * scale;
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
  if (!(width > 0) || (!(depth > 0) && !spec.add) || spec.path.length === 0 || spec.normals.length !== spec.path.length) return null;

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
  // Only the drawn path tapers; the scanlines that fill an outline do not.
  const runs: { path: number[][]; normals: number[][]; profile: CarveProfile; tapered: boolean }[] = [
    { ...thin(spec.path, spec.normals), profile, tapered: true },
    ...(spec.extra ?? []).map((r) => ({ ...thin(r.path, r.normals), profile: r.profile ?? profile, tapered: false })),
  ].filter((r) => r.path.length > 0);
  if (spec.mirror) {
    const axis = spec.mirror;
    runs.push(...runs.map((r) => ({ ...r, path: mirrored(r.path, axis), normals: mirrored(r.normals, axis) })));
  }
  const ringsFor = new Map<CarveProfile, [number, number][]>();
  const cutterRings = (p: CarveProfile) => {
    if (spec.add) return ballRings(width);
    if (!ringsFor.has(p)) ringsFor.set(p, profileRings(p, width, depth));
    return ringsFor.get(p)!;
  };
  const taper = Math.max(0, Math.min(0.5, spec.taper ?? 0));
  /** The cutter's size at each point of a run: 1, narrowing to TAPER_TIP over `taper` of the length at each end. */
  const scales = (path: number[][], tapered: boolean): number[] => {
    if (!tapered || taper <= 0 || path.length < 2) return path.map(() => 1);
    const along = [0];
    for (let i = 1; i < path.length; i++) {
      along.push(along[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]));
    }
    const total = along[along.length - 1] || 1;
    return along.map((a) => {
      const t = Math.min(a / total, 1 - a / total) / taper;
      const e = Math.min(1, t);
      return TAPER_TIP + (1 - TAPER_TIP) * e * e * (3 - 2 * e);
    });
  };
  const tangentAt = (path: number[][], i: number): number[] => {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
    return [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  };

  const pieces: ManifoldT[] = [];
  try {
    for (const run of runs) {
      const size = scales(run.path, run.tapered);
      const flat = spec.add && spec.flatten && spec.flatten.ratio > 0 && spec.flatten.ratio < 1 ? spec.flatten : null;
      const nl = flat ? Math.hypot(flat.normal[0], flat.normal[1], flat.normal[2]) || 1 : 1;
      const fn = flat ? flat.normal.map((c) => c / nl) : [0, 0, 1];
      const tools = run.path.map((p, i) => {
        const points = cutterPoints(
          cutterRings(run.profile), p, run.normals[i], size[i], run.tapered ? spec.tilt ?? 0 : 0, tangentAt(run.path, i),
        );
        if (flat) {
          for (const q of points) {
            const along = ((q[0] - p[0]) * fn[0] + (q[1] - p[1]) * fn[1] + (q[2] - p[2]) * fn[2]) * (1 - flat.ratio);
            for (let k = 0; k < 3; k++) q[k] -= fn[k] * along;
          }
        }
        return points;
      });
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
    // Never NaN: a NaN fails every comparison after it, so each later face
    // replaced it and the snap returned whichever face came last.
    if (!Number.isFinite(d) || (best && d >= best.distance)) continue;
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
  // A face with no area (Manifold leaves slivers in what it cuts) has no
  // inside to land in, and its weights divide by zero: the nearest corner.
  const area2 = va + vb + vc;
  if (!(Math.abs(area2) > 1e-30)) {
    const da = ap[0] * ap[0] + ap[1] * ap[1] + ap[2] * ap[2];
    const db = bp[0] * bp[0] + bp[1] * bp[1] + bp[2] * bp[2];
    const dc = cp[0] * cp[0] + cp[1] * cp[1] + cp[2] * cp[2];
    return da <= db && da <= dc ? [1, 0, 0] : db <= dc ? [0, 1, 0] : [0, 0, 1];
  }
  const denom = 1 / area2;
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
  options: {
    width: number; depth: number; profile: CarveProfile; mirror?: 'x' | 'y' | 'z'; reach?: number; fill?: boolean;
    taper?: number; tilt?: number; add?: boolean; flatten?: GrooveSpec['flatten'];
  },
): { spec: GrooveSpec; missed: number[][] } {
  // Added clay goes where it is drawn, on the surface or off it: a stem
  // leaves the clay at its first point and runs on into the air.
  if (options.add) {
    // Rooted, though. A first point a few millimetres off the surface made a
    // tail that never touched the cat, and it came back as a body of its
    // own; so a start outside the clay is joined to it from below the skin.
    if (path.length > 0) {
      recomputeNormals(mesh);
      const hit = closestOnSurface(mesh, path[0], longestEdgeOf(mesh));
      if (hit) {
        const off = [0, 1, 2].map((i) => path[0][i] - hit.point[i]);
        const outside = off[0] * hit.normal[0] + off[1] * hit.normal[1] + off[2] * hit.normal[2] > 0;
        if (outside && hit.distance > options.width / 4) {
          path = [[0, 1, 2].map((i) => hit.point[i] - hit.normal[i] * options.width / 2), ...path];
        }
      }
    }
    return {
      spec: {
        kind: 'groove', path, normals: path.map(() => [0, 0, 1]), width: options.width, depth: options.depth,
        profile: 'round', add: true, ...(options.taper ? { taper: options.taper } : {}),
        ...(options.flatten ? { flatten: options.flatten } : {}),
        ...(options.mirror ? { mirror: options.mirror } : {}),
      },
      missed: [],
    };
  }
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
      ...(options.taper ? { taper: options.taper } : {}),
      ...(options.tilt ? { tilt: options.tilt } : {}),
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
