// ---------------------------------------------------------------------------
// Vertex painting
// ---------------------------------------------------------------------------
//
// Colour applied to *part* of a surface rather than to a whole body, and built
// up by going over the same place twice — the pips on a die, a stripe down a
// wheel, a dirty patch on a wall.
//
// Three things follow from that, and they are the whole design:
//
//  1. Paint lives per vertex, so a shape needs enough vertices to hold it. A
//     box is six quads until something asks otherwise; `paintResolution` works
//     out how finely to re-tessellate it, and the answer is kept with the paint
//     so that resizing the body later moves the pips with it instead of
//     stranding a colour array of the wrong length.
//
//  2. What is stored is coverage, not colour: rgb plus how much of it is down,
//     0..1. The body's own rgba still shows through underneath, so the base
//     colour stays live and a half-covered vertex is genuinely half-painted
//     rather than pre-mixed against a colour that may since have changed.
//
//  3. It is stored sparsely. Pips cover a percent or two of a die, and a dense
//     array would put tens of thousands of mostly-zero floats into every save
//     file for the sake of them.
//
// None of this reaches the physics. MuJoCo is handed a geom's rgba and does
// nothing with it, the MJCF emitter names the attributes it writes, and no
// exporter reads vertex colour — a painted body cuts, prints and simulates
// exactly as the unpainted one did.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { srgbToLinear } from './bodyColor';

/**
 * A geom's paint, as it is stored in the scene graph.
 *
 * `res` is the tessellation the paint was laid down on — the segment counts
 * passed to the geometry constructor, not a vertex count. Keeping the segments
 * rather than the count is what lets a painted die be resized: the geometry is
 * rebuilt at the new size with the same subdivisions, so vertex N is still the
 * same point on the same face and the pips travel with it.
 */
export interface PaintLayer {
  /**
   * Segment counts the surface was built with for a primitive, or `[maxEdgeUm]`
   * for a subdivided mesh geom (empty on legacy un-subdivided mesh layers).
   */
  res: number[];
  /** Indices of the vertices carrying paint. */
  idx: number[];
  /** r, g, b, coverage for each entry in `idx`, quantised to 0..255. */
  rgba: number[];
}

/** The live, dense form of a PaintLayer — what a stroke actually writes into. */
export interface PaintCanvas {
  res: number[];
  /** Vertex count of the surface this canvas covers. */
  count: number;
  /** r, g, b, coverage per vertex, 0..1. Coverage 0 means bare. */
  data: Float32Array;
}

/**
 * Edge length the tessellation aims for, in metres.
 *
 * Vertex colour is interpolated across a triangle, so this is also the width of
 * the blur at the edge of a mark: at 0.7 mm the pips on a 20 mm die come out
 * with edges tighter than the eye reads as soft, and the die costs about six
 * thousand vertices. Ten times finer would be crisper and cost a hundred times
 * the memory to draw a dot.
 */
const TARGET_EDGE = 0.0007;

/** Nothing is subdivided past this per axis, however big it is. */
const MAX_SEGMENTS = 96;

const segmentsFor = (length: number, min = 1, max = MAX_SEGMENTS) =>
  Math.min(max, Math.max(min, Math.round(Math.abs(length) / TARGET_EDGE)));

/**
 * Whether a geom type can hold paint at all.
 *
 * The list is the types this module knows how to re-tessellate, plus meshes,
 * which arrive dense enough to paint as they are. A wedge builds its geometry
 * from a bespoke six-vertex prism and is left alone — six vertices cannot hold
 * a pip, and one dab would flood a whole face.
 */
export const PAINTABLE_TYPES = new Set(['box', 'sphere', 'ellipsoid', 'cylinder', 'capsule', 'mesh']);

export const isPaintable = (type: string, customRender?: boolean) =>
  !customRender && PAINTABLE_TYPES.has(type);

/**
 * How finely to subdivide a primitive so it can hold paint.
 *
 * `args` is the same argument list the ordinary renderer passes to the geometry
 * constructor, so that the painted surface is the same shape and orientation as
 * the one it replaces — only denser.
 */
export function paintResolution(type: string, args: number[]): number[] {
  switch (type) {
    case 'box':
      // width, height, depth -> a segment count per axis, so a long thin bar is
      // not subdivided into slivers on its short sides.
      return [segmentsFor(args[0]), segmentsFor(args[1]), segmentsFor(args[2])];
    case 'sphere': {
      const r = args[0] ?? 0.1;
      return [segmentsFor(2 * Math.PI * r, 16), segmentsFor(Math.PI * r, 8, 64)];
    }
    case 'ellipsoid': {
      // Drawn as a unit sphere scaled by the three radii, so the circumference
      // that matters is the largest of them.
      const r = Math.max(args[0] ?? 0.1, args[1] ?? 0.1, args[2] ?? 0.1);
      return [segmentsFor(2 * Math.PI * r, 16), segmentsFor(Math.PI * r, 8, 64)];
    }
    case 'cylinder': {
      const r = args[0] ?? 0.1;
      const h = args[2] ?? 0.1;
      return [segmentsFor(2 * Math.PI * r, 16), segmentsFor(h, 1, 64)];
    }
    case 'capsule': {
      const r = args[0] ?? 0.05;
      const len = args[1] ?? 0.1;
      return [segmentsFor(Math.PI * r * 0.5, 4, 32), segmentsFor(2 * Math.PI * r, 16), segmentsFor(len, 1, 64)];
    }
    default:
      return [];
  }
}

/**
 * The constructor arguments for a primitive, from the half-extents a geom is
 * authored with.
 *
 * One place, because two callers need to agree exactly: the renderer, which
 * builds the surface a stroke lands on, and the MCP bridge, which lays paint
 * down without a renderer at all. A disagreement here would put an agent's
 * pips on a differently tessellated die from the one on screen.
 */
export function paintArgsFromSize(type: string, size: number[]): number[] {
  const [a = 0.1, b = 0.1, c = 0.1] = size;
  switch (type) {
    // MJCF sizes a box by its half-extents; BoxGeometry takes full ones.
    case 'box': return [a * 2, b * 2, c * 2];
    case 'sphere': return [a];
    case 'ellipsoid': return [a, b, c];
    case 'cylinder': return [a, a, b * 2];
    case 'capsule': return [a, b * 2];
    default: return [];
  }
}

/**
 * A point in a geom's own Z-up frame, moved into the space its geometry is
 * actually built in.
 *
 * Cylinders and capsules are the exception the rest of the app already lives
 * with: Three builds them along Y, and the renderer stands them up with a
 * quarter turn about X. Anything addressing a point on one — an agent painting
 * a stripe down a roller — should be able to think in the geom's frame and let
 * this do the turn.
 */
export function toGeometrySpace(type: string, point: number[], dynamicMesh = true): [number, number, number] {
  const [x = 0, y = 0, z = 0] = point;
  if (type === 'cylinder' || type === 'capsule') return [x, z, -y];
  if (type === 'mesh' && !dynamicMesh) return [x, z, -y];
  return [x, y, z];
}

/** Maximum vertex count for a subdivided paint mesh, so huge parts stay fast. */
const MAX_MESH_PAINT_VERTICES = 32768;
const MAX_MESH_SUBDIV_PASSES = 8;

/**
 * Target edge resolution `[maxEdgeUm]` for painting a mesh geom.
 *
 * OpenSCAD, boolean CSG, extruded and CAD-exported meshes have flat faces made
 * of a handful of large triangles whose vertices sit only at the corners — a
 * 50 mm cube is eight vertices and twelve triangles, so a brush dab in the
 * middle of a face found no vertices within reach. Subdividing edges longer
 * than `max(TARGET_EDGE, span / MAX_SEGMENTS)` gives mesh faces the same
 * vertex density primitives get from `paintResolution`.
 */
export function paintMeshResolution(positions: ArrayLike<number>): number[] {
  if (!positions || positions.length < 9) return [];
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  if (!Number.isFinite(span) || span <= 0) return [];
  const edge = Math.max(TARGET_EDGE, span / MAX_SEGMENTS);
  return [Math.max(100, Math.round(edge * 1e6))];
}

/**
 * Deterministically subdivides triangles of `(positions, faces)` whose edges
 * exceed `res[0]` micrometres, up to `MAX_MESH_PAINT_VERTICES`.
 *
 * When `res` is empty (legacy saved paint layers) or all edges are already
 * short enough (dense sculpt meshes), the original arrays are returned without
 * splitting so existing vertex indices stay unchanged.
 */
export function subdivideMeshForPaint(
  positions: ArrayLike<number>,
  faces: ArrayLike<number>,
  res: number[],
): { positions: Float32Array; faces: Uint32Array } {
  const toF32 = () => (positions instanceof Float32Array ? positions : new Float32Array(positions));
  const toU32 = () => (faces instanceof Uint32Array ? faces : new Uint32Array(faces));
  const initVerts = Math.floor((positions?.length ?? 0) / 3);
  if (!res?.length || res[0] <= 0 || initVerts < 3 || !faces || faces.length < 3 || initVerts >= MAX_MESH_PAINT_VERTICES) {
    return { positions: toF32(), faces: toU32() };
  }

  const maxEdge = res[0] / 1e6;
  const maxEdge2 = maxEdge * maxEdge;

  // Quick check: if no edge exceeds maxEdge, return untouched (e.g. sculpts).
  let needsSplit = false;
  for (let t = 0; t + 2 < faces.length; t += 3) {
    const a = faces[t] * 3, b = faces[t + 1] * 3, c = faces[t + 2] * 3;
    const ab = (positions[a] - positions[b]) ** 2 + (positions[a + 1] - positions[b + 1]) ** 2 + (positions[a + 2] - positions[b + 2]) ** 2;
    const bc = (positions[b] - positions[c]) ** 2 + (positions[b + 1] - positions[c + 1]) ** 2 + (positions[b + 2] - positions[c + 2]) ** 2;
    const ca = (positions[c] - positions[a]) ** 2 + (positions[c + 1] - positions[a + 1]) ** 2 + (positions[c + 2] - positions[a + 2]) ** 2;
    if (ab > maxEdge2 || bc > maxEdge2 || ca > maxEdge2) {
      needsSplit = true;
      break;
    }
  }
  if (!needsSplit) {
    return { positions: toF32(), faces: toU32() };
  }

  const posBuf = new Float32Array(MAX_MESH_PAINT_VERTICES * 3);
  posBuf.set(positions instanceof Float32Array ? positions : Float32Array.from(positions));
  let vCount = initVerts;

  // Canonical vertex lookup so shared geometric edges split at the same midpoint
  // even if the source mesh had duplicate seam vertices.
  const canon = new Int32Array(MAX_MESH_PAINT_VERTICES);
  const coordMap = new Map<string, number>();
  for (let v = 0; v < vCount; v++) {
    const k = `${Math.round(posBuf[v * 3] * 1e6)},${Math.round(posBuf[v * 3 + 1] * 1e6)},${Math.round(posBuf[v * 3 + 2] * 1e6)}`;
    const existing = coordMap.get(k);
    if (existing !== undefined) {
      canon[v] = existing;
    } else {
      coordMap.set(k, v);
      canon[v] = v;
    }
  }

  const dist2 = (u: number, v: number): number => {
    const u3 = u * 3, v3 = v * 3;
    const dx = posBuf[u3] - posBuf[v3];
    const dy = posBuf[u3 + 1] - posBuf[v3 + 1];
    const dz = posBuf[u3 + 2] - posBuf[v3 + 2];
    return dx * dx + dy * dy + dz * dz;
  };

  const edgeKey = (u: number, v: number): number => {
    const cu = canon[u], cv = canon[v];
    return cu < cv ? (cu << 16) | cv : (cv << 16) | cu;
  };

  let curFaces = Uint32Array.from(faces);

  for (let pass = 0; pass < MAX_MESH_SUBDIV_PASSES && vCount < MAX_MESH_PAINT_VERTICES; pass++) {
    const midpoints = new Map<number, number>();
    const maybeSplitEdge = (u: number, v: number) => {
      if (dist2(u, v) <= maxEdge2) return;
      const key = edgeKey(u, v);
      if (midpoints.has(key) || vCount >= MAX_MESH_PAINT_VERTICES) return;
      const m = vCount++;
      const u3 = u * 3, v3 = v * 3, m3 = m * 3;
      posBuf[m3] = 0.5 * (posBuf[u3] + posBuf[v3]);
      posBuf[m3 + 1] = 0.5 * (posBuf[u3 + 1] + posBuf[v3 + 1]);
      posBuf[m3 + 2] = 0.5 * (posBuf[u3 + 2] + posBuf[v3 + 2]);
      canon[m] = m;
      midpoints.set(key, m);
    };

    for (let t = 0; t + 2 < curFaces.length; t += 3) {
      const a = curFaces[t], b = curFaces[t + 1], c = curFaces[t + 2];
      maybeSplitEdge(a, b);
      maybeSplitEdge(b, c);
      maybeSplitEdge(c, a);
    }

    if (midpoints.size === 0) break;

    const nextFaces: number[] = [];
    for (let t = 0; t + 2 < curFaces.length; t += 3) {
      const a = curFaces[t], b = curFaces[t + 1], c = curFaces[t + 2];
      const m0 = midpoints.get(edgeKey(a, b));
      const m1 = midpoints.get(edgeKey(b, c));
      const m2 = midpoints.get(edgeKey(c, a));
      const count = (m0 !== undefined ? 1 : 0) + (m1 !== undefined ? 1 : 0) + (m2 !== undefined ? 1 : 0);

      if (count === 0) {
        nextFaces.push(a, b, c);
      } else if (count === 3) {
        nextFaces.push(
          a, m0!, m2!,
          m0!, b, m1!,
          m2!, m1!, c,
          m0!, m1!, m2!,
        );
      } else if (count === 1) {
        // Rotate (a, b, c) so the single split edge is (u, v) with midpoint m.
        let u = a, v = b, w = c, m = m0!;
        if (m1 !== undefined) { u = b; v = c; w = a; m = m1; }
        else if (m2 !== undefined) { u = c; v = a; w = b; m = m2; }
        nextFaces.push(u, m, w, m, v, w);
      } else {
        // Two split edges: rotate so the UNSPLIT edge is (w, u), and the split
        // edges are (u, v) at mUV and (v, w) at mVW.
        let u = a, v = b, w = c, mUV = m0!, mVW = m1!;
        if (m0 === undefined) { u = b; v = c; w = a; mUV = m1!; mVW = m2!; }
        else if (m1 === undefined) { u = c; v = a; w = b; mUV = m2!; mVW = m0!; }
        nextFaces.push(mUV, v, mVW);
        if (dist2(mUV, w) <= dist2(u, mVW)) {
          nextFaces.push(u, mUV, w, mUV, mVW, w);
        } else {
          nextFaces.push(u, mUV, mVW, u, mVW, w);
        }
      }
    }
    curFaces = new Uint32Array(nextFaces);
  }

  return {
    positions: posBuf.subarray(0, vCount * 3).slice(),
    faces: curFaces,
  };
}

/** Builds a subdivided Three.js BufferGeometry for painting a mesh geom. */
export function buildMeshPaintGeometry(
  positions: ArrayLike<number>,
  faces: ArrayLike<number>,
  res: number[],
): THREE.BufferGeometry {
  const sub = subdivideMeshForPaint(positions, faces, res);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(sub.positions, 3));
  geo.setIndex(new THREE.BufferAttribute(sub.faces, 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * The paintable form of a primitive: same shape, same orientation, more vertices.
 *
 * Returns null for anything this module does not tessellate — the caller keeps
 * drawing whatever it was drawing.
 */
export function buildPaintGeometry(type: string, args: number[], res: number[]): THREE.BufferGeometry | null {
  switch (type) {
    case 'box':
      return new THREE.BoxGeometry(args[0], args[1], args[2], res[0], res[1], res[2]);
    case 'sphere':
      return new THREE.SphereGeometry(args[0], res[0], res[1]);
    case 'ellipsoid':
      // Unit sphere: the caller scales the mesh by the radii, exactly as the
      // unpainted renderer does.
      return new THREE.SphereGeometry(1, res[0], res[1]);
    case 'cylinder':
      return new THREE.CylinderGeometry(args[0], args[1], args[2], res[0], res[1]);
    case 'capsule':
      return new THREE.CapsuleGeometry(args[0], args[1], res[0], res[1], res[2]);
    default:
      return null;
  }
}

/** An empty canvas for a surface of `count` vertices. */
export function emptyCanvas(count: number, res: number[]): PaintCanvas {
  return { res, count, data: new Float32Array(count * 4) };
}

/**
 * Expands stored paint back into a canvas.
 *
 * A layer whose indices do not fit the surface is dropped rather than partially
 * applied: that only happens when the tessellation has changed underneath it,
 * and half a set of pips is worse than none.
 */
export function canvasFromLayer(layer: PaintLayer | undefined, count: number, res: number[]): PaintCanvas {
  const canvas = emptyCanvas(count, res);
  if (!layer?.idx?.length) return canvas;
  for (let i = 0; i < layer.idx.length; i++) {
    const v = layer.idx[i];
    if (v < 0 || v >= count) continue;
    canvas.data[v * 4] = (layer.rgba[i * 4] ?? 0) / 255;
    canvas.data[v * 4 + 1] = (layer.rgba[i * 4 + 1] ?? 0) / 255;
    canvas.data[v * 4 + 2] = (layer.rgba[i * 4 + 2] ?? 0) / 255;
    canvas.data[v * 4 + 3] = (layer.rgba[i * 4 + 3] ?? 0) / 255;
  }
  return canvas;
}

/**
 * Squeezes a canvas back down for storage.
 *
 * Quantised to a byte a channel and sparse over the vertices: a die with pips
 * on it saves a few hundred numbers rather than the thirty thousand its dense
 * canvas holds, and a byte of coverage is finer than the eye resolves in a
 * colour that is being blended anyway.
 */
export function layerFromCanvas(canvas: PaintCanvas): PaintLayer | undefined {
  const idx: number[] = [];
  const rgba: number[] = [];
  for (let v = 0; v < canvas.count; v++) {
    const a = canvas.data[v * 4 + 3];
    // Below half a byte of coverage there is nothing to see and nothing worth
    // storing — this is also what stops an erased stroke leaving a trail of
    // near-zero entries behind in the save file forever.
    if (a < 1 / 255) continue;
    idx.push(v);
    rgba.push(
      Math.round(canvas.data[v * 4] * 255),
      Math.round(canvas.data[v * 4 + 1] * 255),
      Math.round(canvas.data[v * 4 + 2] * 255),
      Math.round(a * 255),
    );
  }
  return idx.length ? { res: canvas.res, idx, rgba } : undefined;
}

/**
 * Writes the colour attribute the material reads: the body's own colour with
 * whatever paint is on top of it mixed in.
 *
 * The body colour and the paint are both sRGB, and are mixed as sRGB, the way
 * a picker shows them; the attribute is written linear, because three reads a
 * colour attribute as linear (see bodyColor).
 */
export function writeVertexColors(target: Float32Array, base: number[], canvas: PaintCanvas) {
  const [br, bg, bb] = [base[0] ?? 0.8, base[1] ?? 0.8, base[2] ?? 0.8];
  for (let v = 0; v < canvas.count; v++) {
    const a = canvas.data[v * 4 + 3];
    if (a <= 0) {
      target[v * 3] = srgbToLinear(br);
      target[v * 3 + 1] = srgbToLinear(bg);
      target[v * 3 + 2] = srgbToLinear(bb);
      continue;
    }
    target[v * 3] = srgbToLinear(br + (canvas.data[v * 4] - br) * a);
    target[v * 3 + 1] = srgbToLinear(bg + (canvas.data[v * 4 + 1] - bg) * a);
    target[v * 3 + 2] = srgbToLinear(bb + (canvas.data[v * 4 + 2] - bb) * a);
  }
}

/**
 * The colour attribute for a copy of a painted surface whose vertices were
 * renumbered but whose triangles kept their order -- what creasedGeometry
 * hands back. Each corner of the copy takes the colour of the welded vertex
 * at the same corner of the same triangle.
 */
export function colorsForCopy(
  base: number[],
  layer: PaintLayer,
  weldedFaces: ArrayLike<number>,
  copyIndex: ArrayLike<number>,
  copyCount: number,
): Float32Array {
  let weldedCount = 0;
  for (let i = 0; i < weldedFaces.length; i++) weldedCount = Math.max(weldedCount, weldedFaces[i] + 1);
  const welded = new Float32Array(weldedCount * 3);
  writeVertexColors(welded, base, canvasFromLayer(layer, weldedCount, layer.res));
  const out = new Float32Array(copyCount * 3);
  for (let c = 0; c < copyIndex.length; c++) {
    const from = weldedFaces[c] * 3, to = copyIndex[c] * 3;
    out[to] = welded[from];
    out[to + 1] = welded[from + 1];
    out[to + 2] = welded[from + 2];
  }
  return out;
}

export interface DabOptions {
  /** Centre of the dab, in the surface's own space. */
  x: number; y: number; z: number;
  radius: number;
  /** 0..1 rgb the brush is holding. */
  color: number[];
  /** How much coverage one dab lays down at the centre of the brush. */
  flow: number;
  /** Take paint off instead of putting it on. */
  erase?: boolean;
}

/**
 * Closest point on triangle (A, B, C) to P, returning squared distance and
 * barycentric weights [wa, wb, wc].
 */
export function closestPointOnTriangleBary(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): { d2: number; wa: number; wb: number; wc: number } {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) {
    return { d2: apx * apx + apy * apy + apz * apz, wa: 1, wb: 0, wc: 0 };
  }

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) {
    return { d2: bpx * bpx + bpy * bpy + bpz * bpz, wa: 0, wb: 1, wc: 0 };
  }

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const qx = ax + v * abx - px, qy = ay + v * aby - py, qz = az + v * abz - pz;
    return { d2: qx * qx + qy * qy + qz * qz, wa: 1 - v, wb: v, wc: 0 };
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) {
    return { d2: cpx * cpx + cpy * cpy + cpz * cpz, wa: 0, wb: 0, wc: 1 };
  }

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const qx = ax + w * acx - px, qy = ay + w * acy - py, qz = az + w * acz - pz;
    return { d2: qx * qx + qy * qy + qz * qz, wa: 1 - w, wb: 0, wc: w };
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const qx = bx + w * (cx - bx) - px, qy = by + w * (cy - by) - py, qz = bz + w * (cz - bz) - pz;
    return { d2: qx * qx + qy * qy + qz * qz, wa: 0, wb: 1 - w, wc: w };
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  const u = 1 - v - w;
  const qx = ax + abx * v + acx * w - px;
  const qy = ay + aby * v + acy * w - py;
  const qz = az + abz * v + acz * w - pz;
  return { d2: qx * qx + qy * qy + qz * qz, wa: u, wb: v, wc: w };
}

/**
 * Lays one dab of paint onto the canvas.
 *
 * Returns the vertex range it touched so the caller can upload just that slice
 * of the colour attribute rather than the whole buffer — a dab on a dense mesh
 * moves a few dozen vertices out of tens of thousands, and re-uploading all of
 * them sixty times a second is most of what a naive painting tool spends its
 * frame on.
 */
export function applyDab(
  canvas: PaintCanvas,
  positions: ArrayLike<number>,
  { x, y, z, radius, color, flow, erase }: DabOptions,
  faces?: ArrayLike<number> | null,
): { lo: number; hi: number } | null {
  const r2 = radius * radius;
  let lo = -1;
  let hi = -1;

  const paintVertex = (v: number, amount: number) => {
    if (amount <= 0 || v < 0 || v >= canvas.count) return;
    const o = v * 4;
    const a = canvas.data[o + 3];

    if (erase) {
      canvas.data[o + 3] = a * (1 - amount);
    } else {
      // Painting over, the way a wash does: each pass closes some fraction of
      // what is still uncovered, so going over the same spot repeatedly
      // approaches full strength without ever banding past it.
      const next = a + (1 - a) * amount;
      if (next > 0) {
        // The colour already down keeps its share; the new colour takes the
        // coverage this dab just added. Painting red over blue therefore walks
        // through purple rather than flipping, which is what makes a second
        // colour over a first behave like paint.
        const added = next - a;
        canvas.data[o] = (canvas.data[o] * a + (color[0] ?? 0) * added) / next;
        canvas.data[o + 1] = (canvas.data[o + 1] * a + (color[1] ?? 0) * added) / next;
        canvas.data[o + 2] = (canvas.data[o + 2] * a + (color[2] ?? 0) * added) / next;
      }
      canvas.data[o + 3] = next;
    }

    if (lo === -1 || v < lo) lo = v;
    if (v > hi) hi = v;
  };

  for (let v = 0; v < canvas.count; v++) {
    const dx = positions[v * 3] - x;
    const dy = positions[v * 3 + 1] - y;
    const dz = positions[v * 3 + 2] - z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= r2) continue;

    // Squared-cosine-ish falloff: full strength under the middle of the brush
    // and zero *slope* at the edge, so overlapping dabs down a stroke add up to
    // an even band instead of a row of visible rims.
    const t = 1 - d2 / r2;
    const amount = Math.min(1, Math.max(0, t * t * flow));
    paintVertex(v, amount);
  }

  // If the brush is smaller than the local triangle spacing and landed inside a
  // triangle without reaching its corners directly, transfer coverage to the
  // enclosing triangle's vertices weighted by barycentric coordinates.
  if (lo === -1 && faces && faces.length >= 3) {
    let bestD2 = r2;
    let bestA = -1, bestB = -1, bestC = -1;
    let bestWa = 0, bestWb = 0, bestWc = 0;
    for (let t = 0; t + 2 < faces.length; t += 3) {
      const ia = faces[t], ib = faces[t + 1], ic = faces[t + 2];
      const a3 = ia * 3, b3 = ib * 3, c3 = ic * 3;
      const res = closestPointOnTriangleBary(
        x, y, z,
        positions[a3], positions[a3 + 1], positions[a3 + 2],
        positions[b3], positions[b3 + 1], positions[b3 + 2],
        positions[c3], positions[c3 + 1], positions[c3 + 2],
      );
      if (res.d2 < bestD2) {
        bestD2 = res.d2;
        bestA = ia; bestB = ib; bestC = ic;
        bestWa = res.wa; bestWb = res.wb; bestWc = res.wc;
      }
    }
    if (bestA !== -1) {
      const falloff = (1 - bestD2 / r2) ** 2 * flow;
      paintVertex(bestA, Math.min(1, Math.max(0, falloff * bestWa)));
      paintVertex(bestB, Math.min(1, Math.max(0, falloff * bestWb)));
      paintVertex(bestC, Math.min(1, Math.max(0, falloff * bestWc)));
    }
  }

  return lo === -1 ? null : { lo, hi };
}

/**
 * The colour showing at the vertex nearest a point — what the eyedropper picks
 * up, so that alt-clicking a pip gives back the pip's colour rather than the
 * colour of the body it sits on.
 */
export function sampleColor(
  canvas: PaintCanvas,
  positions: ArrayLike<number>,
  base: number[],
  x: number, y: number, z: number,
): [number, number, number] | null {
  let best = Infinity;
  let bestV = -1;
  for (let v = 0; v < canvas.count; v++) {
    const dx = positions[v * 3] - x;
    const dy = positions[v * 3 + 1] - y;
    const dz = positions[v * 3 + 2] - z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < best) { best = d2; bestV = v; }
  }
  if (bestV === -1) return null;

  const a = canvas.data[bestV * 4 + 3];
  const mix = (channel: number, baseValue: number) => baseValue + (channel - baseValue) * a;
  return [
    mix(canvas.data[bestV * 4], base[0] ?? 0.8),
    mix(canvas.data[bestV * 4 + 1], base[1] ?? 0.8),
    mix(canvas.data[bestV * 4 + 2], base[2] ?? 0.8),
  ];
}
