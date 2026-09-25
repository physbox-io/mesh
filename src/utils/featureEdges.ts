/**
 * The edges of a solid that can be rounded or bevelled.
 *
 * A body arrives here as triangles — whatever OpenSCAD made of its primitives
 * and booleans — and nothing in a triangle soup says "edge". An edge is
 * recovered the way a person sees one: two surfaces meeting at an angle.
 *
 *   1. Weld the soup, so triangles that share a corner share an index.
 *   2. Group triangles into SURFACES: neighbours whose normals are within the
 *      crease angle are the same surface. A flat face is one surface; so is a
 *      32-facet cylinder wall, whose neighbouring facets differ by 11°.
 *   3. A mesh edge between two different surfaces is part of a feature edge.
 *      Chain those, breaking wherever the pair of surfaces changes — which is
 *      exactly at a box's corners, and never round a hole's rim.
 *   4. Say what each chain is. A straight run is a LINE; a closed flat ring is
 *      a CIRCLE. Anything else (a sculpted crease, a helix) is reported so it
 *      can be drawn, but it cannot be rounded — the cutters are straight and
 *      round, and an honest "not this one" beats a wrong result.
 *
 * Everything is in the body's source frame, Z-up, metres. Pure: no three, no
 * store, so it runs in tests and in a worker alike.
 */
import type { RoundEdge } from '../types/scene';
import { detectCircle } from './measureSnap';

type Vec3 = [number, number, number];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 => {
  const l = len(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
/** The part of `v` square to the unit direction `d`. */
const reject = (v: Vec3, d: Vec3): Vec3 => sub(v, scale(d, dot(v, d)));

/** Neighbouring facets closer than this are one surface. Matches the edge view's line. */
export const EDGE_CREASE_DEG = 20;

export interface EdgeCandidate {
  /** Stable for one mesh: the index in `edges`. */
  id: number;
  edge: RoundEdge;
  /** Points along the edge, for drawing and picking. Closed rings repeat nothing. */
  points: Vec3[];
  closed: boolean;
  /** The two surfaces it lies between (indices into `surfaces`). */
  surfaces: [number, number];
  /** Angle between the faces, measured through the material (convex) or the air (concave), degrees. */
  angleDeg: number;
  /** The largest setback (distance back from the edge along either face) that fits. */
  maxSetback: number;
  top: boolean;
  bottom: boolean;
  vertical: boolean;
}

export interface Surface {
  /** Area-weighted mean outward normal. */
  normal: Vec3;
  /** True when every facet has the same normal (within 0.5°): a flat face. */
  flat: boolean;
}

export interface FeatureEdges {
  edges: EdgeCandidate[];
  /** Chains that are edges but not ones this can round. */
  other: { points: Vec3[]; closed: boolean }[];
  surfaces: Surface[];
  /** Which surface each input triangle belongs to (-1 for degenerate ones). */
  triangleSurface: number[];
}

export interface FeatureEdgeOptions {
  creaseDeg?: number;
  /** The body frame's idea of up, for the Top/Bottom/Vertical groups. */
  up?: Vec3;
}

/**
 * Finds the edges of a closed, outward-wound mesh.
 *
 * `positions` is flat xyz, `faces` flat triangle indices into it.
 */
export function findFeatureEdges(positions: ArrayLike<number>, faces: ArrayLike<number>, options: FeatureEdgeOptions = {}): FeatureEdges {
  const creaseCos = Math.cos(((options.creaseDeg ?? EDGE_CREASE_DEG) * Math.PI) / 180);
  const up = norm(options.up ?? [0, 0, 1]);

  // --- 1. weld -------------------------------------------------------------
  // OpenSCAD writes STL, a triangle soup with every corner repeated. Welded on
  // a micron grid: far finer than any feature, far coarser than float noise.
  let extent = 0;
  for (let i = 0; i < positions.length; i++) extent = Math.max(extent, Math.abs(positions[i]));
  const tol = Math.max(1e-9, extent * 1e-7, 1e-7);
  const verts: Vec3[] = [];
  const remap: number[] = [];
  const cells = new Map<string, number>();
  for (let i = 0; i < positions.length / 3; i++) {
    const p: Vec3 = [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]];
    const key = `${Math.round(p[0] / tol)},${Math.round(p[1] / tol)},${Math.round(p[2] / tol)}`;
    let idx = cells.get(key);
    if (idx === undefined) {
      idx = verts.length;
      verts.push(p);
      cells.set(key, idx);
    }
    remap.push(idx);
  }

  const triCount = Math.floor(faces.length / 3);
  const tris: [number, number, number][] = [];
  const triNormal: Vec3[] = [];
  const triArea: number[] = [];
  const triOk: boolean[] = [];
  for (let t = 0; t < triCount; t++) {
    const a = remap[faces[3 * t]];
    const b = remap[faces[3 * t + 1]];
    const c = remap[faces[3 * t + 2]];
    tris.push([a, b, c]);
    const n = cross(sub(verts[b], verts[a]), sub(verts[c], verts[a]));
    const area = len(n) / 2;
    const ok = a !== b && b !== c && a !== c && area > tol * tol;
    triOk.push(ok);
    triNormal.push(ok ? norm(n) : [0, 0, 0]);
    triArea.push(ok ? area : 0);
  }

  // --- 2. surfaces -----------------------------------------------------------
  const edgeTris = new Map<string, number[]>();
  const edgeKey = (i: number, j: number) => (i < j ? `${i},${j}` : `${j},${i}`);
  for (let t = 0; t < triCount; t++) {
    if (!triOk[t]) continue;
    const [a, b, c] = tris[t];
    for (const [i, j] of [[a, b], [b, c], [c, a]] as const) {
      const key = edgeKey(i, j);
      const list = edgeTris.get(key);
      if (list) list.push(t); else edgeTris.set(key, [t]);
    }
  }

  const parent = Array.from({ length: triCount }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (const list of edgeTris.values()) {
    if (list.length !== 2) continue;
    const [s, t] = list;
    if (dot(triNormal[s], triNormal[t]) >= creaseCos) parent[find(s)] = find(t);
  }
  const rootToSurface = new Map<number, number>();
  const triangleSurface: number[] = [];
  const surfaceNormalSum: Vec3[] = [];
  const surfaceVerts: Set<number>[] = [];
  const surfaceFirstNormal: Vec3[] = [];
  const surfaceFlat: boolean[] = [];
  for (let t = 0; t < triCount; t++) {
    if (!triOk[t]) { triangleSurface.push(-1); continue; }
    const root = find(t);
    let s = rootToSurface.get(root);
    if (s === undefined) {
      s = surfaceNormalSum.length;
      rootToSurface.set(root, s);
      surfaceNormalSum.push([0, 0, 0]);
      surfaceVerts.push(new Set());
      surfaceFirstNormal.push(triNormal[t]);
      surfaceFlat.push(true);
    }
    triangleSurface.push(s);
    surfaceNormalSum[s] = add(surfaceNormalSum[s], scale(triNormal[t], triArea[t]));
    for (const v of tris[t]) surfaceVerts[s].add(v);
    if (dot(triNormal[t], surfaceFirstNormal[s]) < Math.cos((0.5 * Math.PI) / 180)) surfaceFlat[s] = false;
  }
  const surfaces: Surface[] = surfaceNormalSum.map((n, i) => ({ normal: norm(n), flat: surfaceFlat[i] }));
  // Which surfaces meet at each corner, for where a straight edge runs out.
  const vertexSurfaces = new Map<number, Set<number>>();
  for (let t = 0; t < triCount; t++) {
    const surface = triangleSurface[t];
    if (surface < 0) continue;
    for (const v of tris[t]) {
      const set = vertexSurfaces.get(v);
      if (set) set.add(surface); else vertexSurfaces.set(v, new Set([surface]));
    }
  }

  // --- 3. feature segments, chained ------------------------------------------
  interface Segment { i: number; j: number; tA: number; tB: number; pair: string }
  const segments: Segment[] = [];
  for (const [key, list] of edgeTris) {
    if (list.length !== 2) continue;
    const [tA, tB] = list;
    const sA = triangleSurface[tA];
    const sB = triangleSurface[tB];
    if (sA === sB) continue;
    const [i, j] = key.split(',').map(Number);
    segments.push({ i, j, tA, tB, pair: sA < sB ? `${sA}|${sB}` : `${sB}|${sA}` });
  }
  const atVertex = new Map<number, number[]>();
  segments.forEach((s, k) => {
    for (const v of [s.i, s.j]) {
      const list = atVertex.get(v);
      if (list) list.push(k); else atVertex.set(v, [k]);
    }
  });
  const used = new Uint8Array(segments.length);
  /** The next segment of the same edge from vertex `v`, not `from`. */
  const continuation = (v: number, from: number): number => {
    const list = atVertex.get(v) || [];
    const same = list.filter((k) => k !== from && segments[k].pair === segments[from].pair);
    return same.length === 1 && list.filter((k) => segments[k].pair === segments[from].pair).length === 2 ? same[0] : -1;
  };
  const chains: { segs: number[]; verts: number[]; closed: boolean }[] = [];
  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    used[start] = 1;
    // Walk backwards to the chain's start, then forwards collecting.
    let headSeg = start;
    let headVert = segments[start].i;
    for (;;) {
      const prev = continuation(headVert, headSeg);
      if (prev === -1 || prev === start) break;
      if (used[prev]) break;
      headSeg = prev;
      headVert = segments[prev].i === headVert ? segments[prev].j : segments[prev].i;
      used[prev] = 1;
    }
    // headSeg's far end from headVert is the direction of travel.
    const segs = [headSeg];
    const vertsInChain = [headVert];
    let v = segments[headSeg].i === headVert ? segments[headSeg].j : segments[headSeg].i;
    let cur = headSeg;
    let closed = false;
    for (;;) {
      vertsInChain.push(v);
      const next = continuation(v, cur);
      if (next === -1) break;
      if (next === headSeg) { closed = true; vertsInChain.pop(); break; }
      if (segs.includes(next)) break;
      used[next] = 1;
      segs.push(next);
      v = segments[next].i === v ? segments[next].j : segments[next].i;
      cur = next;
    }
    chains.push({ segs, verts: vertsInChain, closed });
  }

  // --- 4. classify ------------------------------------------------------------
  const edges: EdgeCandidate[] = [];
  const other: FeatureEdges['other'] = [];

  /** The direction along triangle t, square to the edge (p, dir), away from the edge. */
  const inFace = (t: number, p: Vec3, dir: Vec3): Vec3 => {
    const [a, b, c] = tris[t];
    // The triangle's centroid is always strictly on its own side of the edge.
    const centroid = scale(add(add(verts[a], verts[b]), verts[c]), 1 / 3);
    return norm(reject(sub(centroid, p), dir));
  };
  /** How far surface s reaches from point p in direction t. */
  const reach = (s: number, p: Vec3, t: Vec3): number => {
    let far = 0;
    for (const v of surfaceVerts[s]) far = Math.max(far, dot(sub(verts[v], p), t));
    return far;
  };

  for (const chain of chains) {
    const points = chain.verts.map((v) => verts[v]);
    const seg = segments[chain.segs[0]];
    const sA = triangleSurface[seg.tA];
    const sB = triangleSurface[seg.tB];
    const pair: [number, number] = [sA, sB];
    const nA = surfaces[sA].flat ? surfaces[sA].normal : triNormal[seg.tA];
    const nB = surfaces[sB].flat ? surfaces[sB].normal : triNormal[seg.tB];

    // A straight run?
    const first = points[0];
    const last = points[points.length - 1];
    const span = sub(last, first);
    const spanLen = len(span);
    const lineTol = tol * 10 + spanLen * 1e-5;
    const straight = !chain.closed && spanLen > tol * 10 &&
      points.every((p) => len(reject(sub(p, first), norm(span))) <= lineTol);

    if (straight) {
      const dir = norm(span);
      const t1 = inFace(seg.tA, first, dir);
      const t2 = inFace(seg.tB, first, dir);
      const convex = dot(t1, nB) < 0;
      const angleDeg = (Math.acos(Math.max(-1, Math.min(1, dot(t1, t2)))) * 180) / Math.PI;
      const mid = scale(add(first, last), 0.5);
      const maxSetback = Math.min(reach(sA, mid, t1), reach(sB, mid, t2)) / 2;
      // At each end, the flat faces the edge rises away from: a gusset's edge
      // leaving the floor. Its rounding must stop at that floor, not carry on
      // square to the edge and into it. A box's edge runs INTO the face at its
      // end (the sign test), where the square end sits in air and needs nothing.
      //
      // An inside corner's rounding ADDS material, so for it every face at the
      // end is a stop, whichever way the edge meets it: a filler running along
      // a gusset's foot must not poke up through the gusset's sloping top where
      // the gusset gets lower than the filler is tall.
      const convexHere = dot(inFace(seg.tA, first, norm(span)), nB) < 0;
      const stops: { point: number[]; normal: number[] }[] = [];
      for (const [endVertex, endPoint, otherPoint] of [
        [chain.verts[0], first, last],
        [chain.verts[chain.verts.length - 1], last, first],
      ] as const) {
        for (const surface of vertexSurfaces.get(endVertex) ?? []) {
          if (surface === sA || surface === sB || !surfaces[surface].flat) continue;
          const n = surfaces[surface].normal;
          const along = dot(sub(otherPoint, endPoint), n);
          if (along > spanLen * 1e-3) stops.push({ point: endPoint, normal: n });
          else if (!convexHere && along < -spanLen * 1e-3) stops.push({ point: endPoint, normal: scale(n, -1) });
        }
      }
      edges.push({
        id: edges.length,
        edge: { kind: 'line', a: first, b: last, n1: nA, n2: nB, t1, t2, convex, ...(stops.length ? { stops } : {}) },
        points: [first, last],
        closed: false,
        surfaces: pair,
        angleDeg,
        maxSetback,
        top: dot(nA, up) > 0.95 || dot(nB, up) > 0.95,
        bottom: dot(nA, up) < -0.95 || dot(nB, up) < -0.95,
        vertical: Math.abs(dot(dir, up)) > 0.99,
      });
      continue;
    }

    // A round rim: closed, flat on one side.
    const fit = chain.closed ? detectCircle(points, { minCoverage: 300, maxError: 0.01, maxFlatness: 0.01 }) : null;
    const planeSide = fit
      ? (surfaces[sA].flat && Math.abs(dot(surfaces[sA].normal, fit.normal as Vec3)) > 0.999 ? 0
        : surfaces[sB].flat && Math.abs(dot(surfaces[sB].normal, fit.normal as Vec3)) > 0.999 ? 1 : -1)
      : -1;
    if (fit && planeSide !== -1) {
      const centre = fit.centre as Vec3;
      const planeSurface = pair[planeSide];
      const wallSurface = pair[1 - planeSide];
      const axis = surfaces[planeSurface].normal;
      const p0 = points[0];
      const ref = norm(reject(sub(p0, centre), axis));
      const radius = len(reject(sub(p0, centre), axis));
      const tangent = norm(cross(axis, ref));
      // Which triangle of the first segment is on which side.
      const planeTri = triangleSurface[seg.tA] === planeSurface ? seg.tA : seg.tB;
      const wallTri = planeTri === seg.tA ? seg.tB : seg.tA;
      const tPlane: Vec3 = dot(inFace(planeTri, p0, tangent), ref) >= 0 ? ref : scale(ref, -1);
      const nWall: Vec3 = dot(triNormal[wallTri], ref) >= 0 ? ref : scale(ref, -1);
      const tWall: Vec3 = dot(inFace(wallTri, p0, tangent), axis) >= 0 ? axis : scale(axis, -1);
      const convex = dot(tPlane, nWall) < 0;
      let maxSetback = Math.min(reach(planeSurface, p0, tPlane), reach(wallSurface, p0, tWall)) / 2;
      // A rim whose flat face runs in toward the centre (the top of a boss)
      // can only be set back so far before the cutter crosses the axis.
      if (dot(tPlane, ref) < 0) maxSetback = Math.min(maxSetback, radius * 0.95);
      edges.push({
        id: edges.length,
        edge: {
          kind: 'circle',
          centre,
          axis,
          radius,
          ref,
          segments: points.length,
          n1: axis, n2: nWall,
          t1: tPlane, t2: tWall,
          convex,
        },
        points,
        closed: true,
        surfaces: planeSide === 0 ? pair : [pair[1], pair[0]],
        angleDeg: 90,
        maxSetback,
        top: dot(axis, up) > 0.95,
        bottom: dot(axis, up) < -0.95,
        vertical: false,
      });
      continue;
    }

    other.push({ points, closed: chain.closed });
  }

  limitByNeighbours(edges);
  return { edges, other, surfaces, triangleSurface };
}

/** Distance from p to the segment ab. */
function pointSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  return len(sub(p, add(a, scale(ab, t))));
}

/** Closest approach of two polylines, near enough: every vertex of each against every segment of the other. */
function polylineGap(a: EdgeCandidate, b: EdgeCandidate): number {
  const segs = (e: EdgeCandidate): [Vec3, Vec3][] => {
    const out: [Vec3, Vec3][] = [];
    const n = e.closed ? e.points.length : e.points.length - 1;
    for (let i = 0; i < n; i++) out.push([e.points[i], e.points[(i + 1) % e.points.length]]);
    return out;
  };
  let best = Infinity;
  for (const [p, q] of [[a, b], [b, a]] as const) {
    for (const v of p.points) for (const [s0, s1] of segs(q)) best = Math.min(best, pointSegment(v, s0, s1));
  }
  return best;
}

/**
 * Tightens each edge's room by the other edges on the faces beside it.
 *
 * A face's reach says how wide it is, but not what is IN it: the top of a
 * block with a hole through it is 40 mm across and 14 mm from its edge to the
 * hole. Two roundings on one face meet halfway at worst, so each gets half the
 * gap to the nearest other edge of that face — edges that touch this one at a
 * corner excepted, since those run away from it rather than across.
 */
function limitByNeighbours(edges: EdgeCandidate[]): void {
  const touches = (a: EdgeCandidate, b: EdgeCandidate) => {
    const ends = (e: EdgeCandidate) => (e.closed ? [] : [e.points[0], e.points[e.points.length - 1]]);
    return ends(a).some((p) => ends(b).some((q) => len(sub(p, q)) < 1e-9 + 1e-6 * len(p)));
  };
  for (const e of edges) {
    for (const surface of e.surfaces) {
      for (const other of edges) {
        if (other === e || !other.surfaces.includes(surface) || touches(e, other)) continue;
        e.maxSetback = Math.min(e.maxSetback, polylineGap(e, other) / 2);
      }
    }
  }
}

/** The candidates that border a surface — what clicking a face picks. */
export function edgesOfSurface(edges: EdgeCandidate[], surface: number): EdgeCandidate[] {
  return edges.filter((e) => e.surfaces[0] === surface || e.surfaces[1] === surface);
}

/**
 * Whether two stored edges are the same edge, within `tol` metres. Used to
 * match a feature's saved edges back to the candidates found on a fresh mesh.
 */
export function sameEdge(a: RoundEdge, b: RoundEdge, tol = 1e-5): boolean {
  const near = (p: number[], q: number[]) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) <= tol;
  if (a.kind === 'line' && b.kind === 'line') {
    return (near(a.a, b.a) && near(a.b, b.b)) || (near(a.a, b.b) && near(a.b, b.a));
  }
  if (a.kind === 'circle' && b.kind === 'circle') {
    return near(a.centre, b.centre) && Math.abs(a.radius - b.radius) <= tol &&
      Math.abs(dot(a.axis as Vec3, b.axis as Vec3)) > 0.999 && near(a.t1, b.t1);
  }
  return false;
}

/**
 * The largest size that fits every edge in the list, for the given kind.
 *
 * A setback is how far back along each face the rounding starts. For a chamfer
 * it IS the size; for a fillet of radius r between faces meeting at θ it is
 * r / tan(θ/2), so a 90° corner takes the radius and a shallower one less.
 * Assumes the edge across each face may be rounded too, hence half the face.
 */
export function maxSizeFor(edges: EdgeCandidate[], mode: 'fillet' | 'chamfer'): number {
  let best = Infinity;
  for (const e of edges) {
    const half = ((e.angleDeg * Math.PI) / 180) / 2;
    const size = mode === 'chamfer' ? e.maxSetback : e.maxSetback * Math.tan(half);
    best = Math.min(best, size);
  }
  return Number.isFinite(best) ? best : 0;
}

/**
 * A size worth offering first: about 8% of the part's smallest dimension, on a
 * friendly number, and never more than fits. In metres.
 */
export function suggestedSize(smallestDimension: number, maxSize: number): number {
  const friendly = [0.0005, 0.001, 0.002, 0.003, 0.005, 0.01, 0.02, 0.05];
  const target = smallestDimension * 0.08;
  let pick = friendly[0];
  for (const f of friendly) if (f <= target) pick = f;
  if (maxSize > 0 && pick > maxSize) {
    // Largest friendly value that fits, else the fit itself on a 0.1 mm grid.
    const fitting = friendly.filter((f) => f <= maxSize);
    pick = fitting.length ? fitting[fitting.length - 1] : Math.floor(maxSize * 1e4 + 1e-6) / 1e4;
  }
  return pick;
}

/**
 * The groups a person picks edges by. 'all' is every OUTSIDE edge — what
 * "round it off" means — and 'inside' the inside corners, which add material
 * rather than take it away and are asked for separately. The other three are
 * outside edges too.
 */
export type EdgeGroup = 'all' | 'top' | 'bottom' | 'vertical' | 'inside';

/** The candidates a group names, or those with the given ids. Unknown ids are reported, not ignored. */
export function selectEdges(edges: EdgeCandidate[], which: EdgeGroup | number[]): { picked: EdgeCandidate[]; unknown: number[] } {
  if (Array.isArray(which)) {
    const byId = new Map(edges.map((e) => [e.id, e]));
    return {
      picked: which.filter((id) => byId.has(id)).map((id) => byId.get(id)!),
      unknown: which.filter((id) => !byId.has(id)),
    };
  }
  if (which === 'inside') return { picked: edges.filter((e) => !e.edge.convex), unknown: [] };
  const outside = edges.filter((e) => e.edge.convex);
  if (which === 'all') return { picked: outside, unknown: [] };
  return { picked: outside.filter((e) => e[which]), unknown: [] };
}
