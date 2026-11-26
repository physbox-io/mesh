/**
 * The edges a body offers for rounding, found on its UNROUNDED shape.
 *
 * Edges are picked on the solid as modelled — holes cut, booleans done, but no
 * roundings — because that is where the edges a person means actually are: a
 * rounded edge has no edge left to click, and the one next to it is two
 * tangent seams. So the body's program is compiled once more with its
 * roundings left out (csgProgram's `rounds: false`), through the same OpenSCAD
 * pool and cache as everything else, and the edges are found on that.
 *
 * The result is in the body's source frame. Anything drawn over the compiled
 * body has to shift by csgFrameOffset, the same as the cut ghosts do.
 */
import * as THREE from 'three';
import type { SceneNode } from '../types/scene';
import { csgProgram } from './csg';
import { findFeatureEdges, type EdgeCandidate, type FeatureEdges } from './featureEdges';
import { nodeWorldMatrix } from './combineBodies';

export interface BodyEdges extends FeatureEdges {
  /** The unrounded solid the edges were found on, source frame, Z-up. */
  positions: number[];
  faces: number[];
  /** The smallest side of its bounding box, metres — what a suggested size is scaled to. */
  smallestDimension: number;
}

const cache = new Map<string, BodyEdges>();
const inflight = new Map<string, Promise<BodyEdges>>();
const CACHE_LIMIT = 8;

/** Why a body cannot be rounded, in words for the panel; null when it can. */
export function whyNotRoundable(node: SceneNode | null | undefined): string | null {
  if (!node) return 'Select a part first.';
  if (node.isSculpt) return 'Sculpted clay has no sharp edges to round — smooth it with the brushes instead.';
  const solid = (node.geoms || []).some((g) => !g.csgDerived && g.type !== 'plane' && (!g.csg || g.csg === 'union') && g.role !== 'visual');
  if (!solid) return 'This part has no solid shape to round.';
  return null;
}

/** Which way is up in this body's own frame, so Top and Bottom mean the world's. */
export function bodyUp(nodes: SceneNode[], id: string): [number, number, number] {
  const m = nodeWorldMatrix(nodes, id);
  if (!m) return [0, 0, 1];
  const rotation = new THREE.Matrix4().extractRotation(m).invert();
  const up = new THREE.Vector3(0, 0, 1).applyMatrix4(rotation).normalize();
  return [up.x, up.y, up.z];
}

const vDot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vLen = (a: readonly number[]) => Math.hypot(a[0], a[1], a[2]);
const vSub = (a: readonly number[], b: readonly number[]): [number, number, number] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

function pointToSegDist(p: readonly number[], a: readonly number[], b: readonly number[]): number {
  const ab = vSub(b, a);
  const l2 = vDot(ab, ab);
  const t = l2 > 0 ? Math.max(0, Math.min(1, vDot(vSub(p, a), ab) / l2)) : 0;
  return Math.hypot(p[0] - (a[0] + ab[0] * t), p[1] - (a[1] + ab[1] * t), p[2] - (a[2] + ab[2] * t));
}

function edgePolylineGap(a: EdgeCandidate, b: EdgeCandidate): number {
  const segs = (e: EdgeCandidate): [readonly number[], readonly number[]][] => {
    const out: [readonly number[], readonly number[]][] = [];
    const n = e.closed ? e.points.length : e.points.length - 1;
    for (let i = 0; i < n; i++) out.push([e.points[i], e.points[(i + 1) % e.points.length]]);
    return out;
  };
  let best = Infinity;
  for (const [p, q] of [[a, b], [b, a]] as const) {
    for (const v of p.points) {
      for (const [s0, s1] of segs(q)) best = Math.min(best, pointToSegDist(v, s0, s1));
    }
  }
  return best;
}

function edgesTouch(a: EdgeCandidate, b: EdgeCandidate): boolean {
  const ends = (e: EdgeCandidate) => (e.closed ? [] : [e.points[0], e.points[e.points.length - 1]]);
  return ends(a).some((p) => ends(b).some((q) => vLen(vSub(p, q)) < 1e-9 + 1e-6 * vLen(p)));
}

/**
 * Recomputes per-edge `maxSetback` so consecutive facets along a curved or
 * segmented boundary on a flat face do not cap each other to half a single
 * facet length.
 *
 * `findFeatureEdges`'s `limitByNeighbours` only skips edges that share an
 * endpoint; on a `$fn=32` extruded curve, edges 2 hops apart are separated by
 * a single tiny facet even though both advance in the same inward direction
 * into the face rather than opposing each other across it. Skipping same-side
 * pairs (`dot(tE, tOther) > 0.25`) preserves accurate limits across opposite
 * walls, holes, narrow slots, and sharp serration teeth while allowing
 * practical bevels/fillets on faceted curves.
 */
export function relaxFacetedCurveSetbacks(
  found: FeatureEdges,
  positions: ArrayLike<number>,
  faces: ArrayLike<number>,
): void {
  if (found.edges.length === 0) return;

  // Collect vertex indices per surface directly from triangleSurface.
  const surfaceVerts: Set<number>[] = found.surfaces.map(() => new Set<number>());
  const triCount = Math.min(found.triangleSurface.length, Math.floor(faces.length / 3));
  for (let t = 0; t < triCount; t++) {
    const s = found.triangleSurface[t];
    if (s < 0 || s >= surfaceVerts.length) continue;
    const set = surfaceVerts[s];
    set.add(faces[3 * t]);
    set.add(faces[3 * t + 1]);
    set.add(faces[3 * t + 2]);
  }
  const reach = (s: number, p: readonly number[], dir: readonly number[]): number => {
    let far = 0;
    const verts = surfaceVerts[s];
    if (!verts) return 0;
    for (const idx of verts) {
      const i = 3 * idx;
      const d = (positions[i] - p[0]) * dir[0] + (positions[i + 1] - p[1]) * dir[1] + (positions[i + 2] - p[2]) * dir[2];
      if (d > far) far = d;
    }
    return far;
  };

  const bySurface = new Map<number, EdgeCandidate[]>();
  for (const e of found.edges) {
    for (const s of e.surfaces) {
      const list = bySurface.get(s);
      if (list) list.push(e); else bySurface.set(s, [e]);
    }
  }

  for (const e of found.edges) {
    let limit: number;
    if (e.edge.kind === 'line') {
      const mid: [number, number, number] = [
        (e.edge.a[0] + e.edge.b[0]) * 0.5,
        (e.edge.a[1] + e.edge.b[1]) * 0.5,
        (e.edge.a[2] + e.edge.b[2]) * 0.5,
      ];
      limit = Math.min(reach(e.surfaces[0], mid, e.edge.t1), reach(e.surfaces[1], mid, e.edge.t2)) / 2;
    } else {
      const p0 = e.points[0];
      limit = Math.min(reach(e.surfaces[0], p0, e.edge.t1), reach(e.surfaces[1], p0, e.edge.t2)) / 2;
      if (vDot(e.edge.t1, e.edge.ref) < 0) limit = Math.min(limit, e.edge.radius * 0.95);
    }

    for (const surface of e.surfaces) {
      const flat = found.surfaces[surface]?.flat ?? false;
      for (const other of bySurface.get(surface) ?? []) {
        if (other === e || edgesTouch(e, other)) continue;
        if (flat && e.edge.kind === 'line' && other.edge.kind === 'line') {
          const tE = surface === e.surfaces[0] ? e.edge.t1 : e.edge.t2;
          const tOther = surface === other.surfaces[0] ? other.edge.t1 : other.edge.t2;
          if (vDot(tE, tOther) > 0.25) continue;
        }
        limit = Math.min(limit, edgePolylineGap(e, other) / 2);
      }
    }
    e.maxSetback = limit;
  }
}

export async function bodyEdges(node: SceneNode, up: [number, number, number] = [0, 0, 1]): Promise<BodyEdges> {
  const program = csgProgram(node, { rounds: false, always: true });
  if (!program) throw new Error('This part has no solid shape to round.');
  const key = `${up.map((c) => c.toFixed(4)).join(',')}\n${program}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = inflight.get(key);
  if (pending) return pending;

  const work = (async () => {
    const { compileSCAD } = await import('./openscad');
    const compiled = await compileSCAD(program);
    const positions = compiled.renderVertices;
    const faces = compiled.faces;
    const found = findFeatureEdges(positions, faces, { up });
    relaxFacetedCurveSetbacks(found, positions, faces);

    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], positions[i + k]);
        max[k] = Math.max(max[k], positions[i + k]);
      }
    }
    const smallestDimension = Math.min(max[0] - min[0], max[1] - min[1], max[2] - min[2]);

    const result: BodyEdges = { ...found, positions, faces, smallestDimension };
    cache.set(key, result);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    return result;
  })();

  inflight.set(key, work);
  try {
    return await work;
  } finally {
    inflight.delete(key);
  }
}
