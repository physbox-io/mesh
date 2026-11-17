// ---------------------------------------------------------------------------
// The colours a boolean was built from, kept on the surface it made
// ---------------------------------------------------------------------------
//
// A boolean body compiles to one mesh, and a mesh geom has one rgba. A body of
// two colours (a white coat on a tan base) came out all in the first geom's
// colour the moment anything made it a boolean: a rounded edge, a hole. Each
// vertex of the result is painted (utils/vertexPaint) in the colour of the
// source geom whose material it is: the one it lies on the skin of, or for a
// face a cutter or a rounding made, the one it is inside. That is what makes
// a rounded rim or a hole through the coat come out in the coat's colour,
// where carrying colour only from the source surfaces (utils/sectionPaint,
// for Split for Print's pieces) leaves those faces in the base colour.
//
// Imported dynamically by csg.ts: laserCutExporter imports csg.ts, and a
// static import back would be a cycle.
// ---------------------------------------------------------------------------

import type { SceneGeom } from '../types/scene';
import {
  closestPointOnTriangleBary, paintMeshResolution, subdivideMeshForPaint, type PaintLayer,
} from './vertexPaint';
import { getGeomFrame, yupVertsToZup } from './laserCutExporter';

/** Triangle tests one mesh source may cost before it is judged by its nearest vertex. */
const MAX_MESH_TESTS = 20_000_000;

const sameRgb = (a: number[], b: number[]) =>
  [0, 1, 2].every((k) => Math.round((a[k] ?? 0.8) * 255) === Math.round((b[k] ?? 0.8) * 255));

/** Signed distance from a point in the geom's own frame to its surface; null when the type has no closed form. */
function primitiveSdf(geom: SceneGeom, halfLen: number, x: number, y: number, z: number): number | null {
  const s = geom.size || [];
  switch (geom.type) {
    case 'sphere':
      return Math.hypot(x, y, z) - (s[0] ?? 0.1);
    case 'box': {
      const qx = Math.abs(x) - (s[0] ?? 0.1), qy = Math.abs(y) - (s[1] ?? s[0] ?? 0.1), qz = Math.abs(z) - (s[2] ?? s[0] ?? 0.1);
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
    }
    case 'ellipsoid': {
      const ax = s[0] ?? 0.1, ay = s[1] ?? ax, az = s[2] ?? ax;
      return (Math.hypot(x / ax, y / ay, z / az) - 1) * Math.min(ax, ay, az);
    }
    case 'cylinder': {
      const dr = Math.hypot(x, y) - (s[0] ?? 0.1), dz = Math.abs(z) - halfLen;
      return Math.hypot(Math.max(dr, 0), Math.max(dz, 0)) + Math.min(Math.max(dr, dz), 0);
    }
    case 'capsule': {
      const cz = Math.max(-halfLen, Math.min(halfLen, z));
      return Math.hypot(x, y, z - cz) - (s[0] ?? 0.05);
    }
    default:
      return null;
  }
}

/** Distance from a point in the geom's frame to a mesh geom's surface (unsigned). */
function meshDistance(geom: SceneGeom, queries: number): ((x: number, y: number, z: number) => number) | null {
  const zup = geom.renderVertices ?? (geom.vertices ? yupVertsToZup(geom.vertices) : null);
  const faces = geom.faces;
  if (!zup?.length || !faces?.length) return null;
  if (queries * (faces.length / 3) > MAX_MESH_TESTS) {
    return (x, y, z) => {
      let best = Infinity;
      for (let i = 0; i < zup.length; i += 3) best = Math.min(best, (zup[i] - x) ** 2 + (zup[i + 1] - y) ** 2 + (zup[i + 2] - z) ** 2);
      return Math.sqrt(best);
    };
  }
  return (x, y, z) => {
    let best = Infinity;
    for (let t = 0; t + 2 < faces.length; t += 3) {
      const a = faces[t] * 3, b = faces[t + 1] * 3, c = faces[t + 2] * 3;
      const { d2 } = closestPointOnTriangleBary(
        x, y, z, zup[a], zup[a + 1], zup[a + 2], zup[b], zup[b + 1], zup[b + 2], zup[c], zup[c + 1], zup[c + 2],
      );
      if (d2 < best) best = d2;
    }
    return Math.sqrt(best);
  };
}

interface Source {
  rgba: number[];
  /** Distance from a body-frame point to the geom's surface, negative inside where that is known. */
  sdf: (x: number, y: number, z: number) => number;
}

function sourceOf(geom: SceneGeom, queries: number): Source | null {
  const frame = getGeomFrame(geom);
  const halfLen = frame.halfLen ?? (geom.type === 'cylinder' ? (geom.size?.[1] ?? geom.size?.[0] ?? 0.1) : (geom.size?.[1] ?? 0.1));
  const e = frame.matrix.clone().invert().elements;
  const local = geom.type === 'mesh' ? meshDistance(geom, queries) : primitiveSdf(geom, halfLen, 0, 0, 0) === null
    ? null
    : (x: number, y: number, z: number) => primitiveSdf(geom, halfLen, x, y, z)!;
  if (!local) return null;
  return {
    rgba: geom.rgba ?? [0.8, 0.8, 0.8, 1],
    sdf: (x, y, z) => local(
      e[0] * x + e[4] * y + e[8] * z + e[12],
      e[1] * x + e[5] * y + e[9] * z + e[13],
      e[2] * x + e[6] * y + e[10] * z + e[14],
    ),
  };
}

/**
 * Paint for a boolean's mesh (`zup`, its body-frame Z-up renderVertices, the
 * space a dynamic mesh is painted in) giving each part of its surface the
 * colour of the source geom it is made of. `positives` are the geoms that add
 * material, in the order authored; `rgba` is the colour the mesh is drawn in.
 * Undefined when every positive is that colour.
 */
export function csgSourcePaint(
  positives: SceneGeom[], zup: ArrayLike<number>, faces: ArrayLike<number>, rgba: number[],
): PaintLayer | undefined {
  if (positives.length < 2 || positives.every((g) => sameRgb(g.rgba ?? [0.8, 0.8, 0.8, 1], rgba))) return undefined;
  const res = paintMeshResolution(zup);
  const sub = subdivideMeshForPaint(zup, faces, res);
  const pts = sub.positions;
  const count = pts.length / 3;
  const sources = positives.map((g) => sourceOf(g, count)).filter((s): s is Source => !!s);
  if (sources.every((s) => sameRgb(s.rgba, rgba))) return undefined;

  let span = 0;
  for (let k = 0; k < 3; k++) {
    let lo = Infinity, hi = -Infinity;
    for (let i = k; i < pts.length; i += 3) { if (pts[i] < lo) lo = pts[i]; if (pts[i] > hi) hi = pts[i]; }
    span = Math.max(span, hi - lo);
  }
  // On a surface, as far as float32 and OpenSCAD's six decimals can tell.
  const tol = Math.max(2e-6, span * 1e-5);

  const idx: number[] = [];
  const out: number[] = [];
  for (let v = 0; v < count; v++) {
    const x = pts[v * 3], y = pts[v * 3 + 1], z = pts[v * 3 + 2];
    // Of the geoms the vertex is in or on, the one whose skin is nearest; on
    // the seam where two meet, the later (a coat laid over its base). A
    // vertex in none (it should not happen) goes to the nearest.
    let owner: Source | null = null, ownerScore = Infinity;
    let near: Source | null = null, nearScore = Infinity;
    for (const s of sources) {
      const d = s.sdf(x, y, z);
      if (d <= tol) {
        const score = Math.max(0, -d - tol);
        if (score <= ownerScore) { owner = s; ownerScore = score; }
      } else if (d < nearScore) {
        near = s; nearScore = d;
      }
    }
    const pick = owner ?? near;
    if (!pick || sameRgb(pick.rgba, rgba)) continue;
    idx.push(v);
    out.push(Math.round(pick.rgba[0] * 255), Math.round(pick.rgba[1] * 255), Math.round(pick.rgba[2] * 255), 255);
  }
  return idx.length ? { res, idx, rgba: out } : undefined;
}
