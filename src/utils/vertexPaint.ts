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
  idx: number[] | Uint32Array;
  /** r, g, b, coverage for each entry in `idx`, quantised to 0..255. */
  rgba: number[] | Uint8Array;
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

/** One pass of `subdivideMeshForPaint`, recorded for adaptive coarsening on export. */
export interface MeshPaintSubdivPass {
  inFaces: Uint32Array;
  /** Prefix sum (length `inFaces.length / 3 + 1`): children of triangle `t` sit at `childStart[t]..childStart[t+1]-1`. */
  childStart: Uint32Array;
  midpoints: Map<number, number>;
}

/** Result of `subdivideMeshForPaintWithTree`, including the pass hierarchy. */
export interface MeshPaintSubdivision {
  positions: Float32Array;
  faces: Uint32Array;
  canon: Int32Array;
  passes: MeshPaintSubdivPass[];
}

function splitTriangleByMidpoints(
  a: number,
  b: number,
  c: number,
  m0: number | undefined,
  m1: number | undefined,
  m2: number | undefined,
  dist2: (u: number, v: number) => number,
  out: number[],
): void {
  const count = (m0 !== undefined ? 1 : 0) + (m1 !== undefined ? 1 : 0) + (m2 !== undefined ? 1 : 0);
  if (count === 0) {
    out.push(a, b, c);
  } else if (count === 3) {
    out.push(
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
    out.push(u, m, w, m, v, w);
  } else {
    // Two split edges: rotate so the UNSPLIT edge is (w, u), and the split
    // edges are (u, v) at mUV and (v, w) at mVW.
    let u = a, v = b, w = c, mUV = m0!, mVW = m1!;
    if (m0 === undefined) { u = b; v = c; w = a; mUV = m1!; mVW = m2!; }
    else if (m1 === undefined) { u = c; v = a; w = b; mUV = m2!; mVW = m0!; }
    out.push(mUV, v, mVW);
    if (dist2(mUV, w) <= dist2(u, mVW)) {
      out.push(u, mUV, w, mUV, mVW, w);
    } else {
      out.push(u, mUV, mVW, u, mVW, w);
    }
  }
}

function runMeshPaintSubdivision(
  positions: ArrayLike<number>,
  faces: ArrayLike<number>,
  res: number[],
  recordTree: boolean,
): MeshPaintSubdivision {
  const toF32 = () => (positions instanceof Float32Array ? positions : new Float32Array(positions));
  const toU32 = () => (faces instanceof Uint32Array ? faces : new Uint32Array(faces));
  const initVerts = Math.floor((positions?.length ?? 0) / 3);
  if (!res?.length || res[0] <= 0 || initVerts < 3 || !faces || faces.length < 3 || initVerts >= MAX_MESH_PAINT_VERTICES) {
    return { positions: toF32(), faces: toU32(), canon: new Int32Array(0), passes: [] };
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
    return { positions: toF32(), faces: toU32(), canon: new Int32Array(0), passes: [] };
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
    return cu < cv ? cu * 1e7 + cv : cv * 1e7 + cu;
  };

  let curFaces = Uint32Array.from(faces);
  const passes: MeshPaintSubdivPass[] = [];

  for (let pass = 0; pass < MAX_MESH_SUBDIV_PASSES && vCount < MAX_MESH_PAINT_VERTICES; pass++) {
    const midpoints = new Map<number, number>();
    const maybeSplitEdge = (u: number, v: number) => {
      const cu = canon[u], cv = canon[v];
      if (cu === cv || dist2(cu, cv) <= maxEdge2) return;
      const key = edgeKey(cu, cv);
      if (midpoints.has(key) || vCount >= MAX_MESH_PAINT_VERTICES) return;
      const m = vCount++;
      const u3 = cu * 3, v3 = cv * 3, m3 = m * 3;
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

    const inTriCount = Math.floor(curFaces.length / 3);
    const childStart = recordTree ? new Uint32Array(inTriCount + 1) : null;
    const nextFaces: number[] = [];
    for (let t = 0; t < inTriCount; t++) {
      if (childStart) childStart[t] = nextFaces.length / 3;
      const a = curFaces[t * 3], b = curFaces[t * 3 + 1], c = curFaces[t * 3 + 2];
      const m0 = midpoints.get(edgeKey(a, b));
      const m1 = midpoints.get(edgeKey(b, c));
      const m2 = midpoints.get(edgeKey(c, a));
      splitTriangleByMidpoints(a, b, c, m0, m1, m2, dist2, nextFaces);
    }
    if (childStart) {
      childStart[inTriCount] = nextFaces.length / 3;
      passes.push({ inFaces: curFaces, childStart, midpoints });
    }
    curFaces = new Uint32Array(nextFaces);
  }

  return {
    positions: posBuf.subarray(0, vCount * 3).slice(),
    faces: curFaces,
    canon: recordTree ? canon.subarray(0, vCount).slice() : new Int32Array(0),
    passes,
  };
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
  const { positions: outPos, faces: outFaces } = runMeshPaintSubdivision(positions, faces, res, false);
  return { positions: outPos, faces: outFaces };
}

/**
 * Same subdivision as `subdivideMeshForPaint`, also returning the pass
 * hierarchy so export can collapse uniformly coloured regions back to coarse
 * triangles without introducing T-junctions.
 */
export function subdivideMeshForPaintWithTree(
  positions: ArrayLike<number>,
  faces: ArrayLike<number>,
  res: number[],
): MeshPaintSubdivision {
  return runMeshPaintSubdivision(positions, faces, res, true);
}

/**
 * Adaptively coarsens a subdivided painted mesh for 3MF export: collapses any
 * subdivision subtree whose vertices all share one colour, while splitting
 * adjacent uniform triangles conformingly along shared boundary midpoints so
 * the output stays watertight (zero T-junctions) and preserves exact colour
 * boundaries.
 */
export function coarsenPaintedMesh(
  sub: MeshPaintSubdivision,
  colors: Float32Array,
): Uint32Array {
  const numPasses = sub.passes.length;
  if (numPasses === 0) return sub.faces;

  const vCount = Math.floor(sub.positions.length / 3);
  const vColor = new Int32Array(vCount);
  for (let v = 0; v < vCount; v++) {
    const r = Math.min(255, Math.max(0, Math.round(colors[v * 3] * 255)));
    const g = Math.min(255, Math.max(0, Math.round(colors[v * 3 + 1] * 255)));
    const b = Math.min(255, Math.max(0, Math.round(colors[v * 3 + 2] * 255)));
    vColor[v] = (r << 16) | (g << 8) | b;
  }

  // Bottom-up uniformity pass: -1 means mixed colours inside this triangle's subtree.
  const levelColor: Int32Array[] = new Array(numPasses + 1);
  const leafCount = Math.floor(sub.faces.length / 3);
  const leafColor = new Int32Array(leafCount);
  for (let t = 0; t < leafCount; t++) {
    const ca = vColor[sub.faces[t * 3]];
    const cb = vColor[sub.faces[t * 3 + 1]];
    const cc = vColor[sub.faces[t * 3 + 2]];
    leafColor[t] = (ca === cb && cb === cc) ? ca : -1;
  }
  levelColor[numPasses] = leafColor;

  for (let p = numPasses - 1; p >= 0; p--) {
    const pass = sub.passes[p];
    const parentCount = Math.floor(pass.inFaces.length / 3);
    const childColors = levelColor[p + 1];
    const pColor = new Int32Array(parentCount);
    for (let t = 0; t < parentCount; t++) {
      const start = pass.childStart[t];
      const end = pass.childStart[t + 1];
      const first = childColors[start];
      if (first === -1) { pColor[t] = -1; continue; }
      let same = true;
      for (let c = start + 1; c < end; c++) {
        if (childColors[c] !== first) { same = false; break; }
      }
      pColor[t] = same ? first : -1;
    }
    levelColor[p] = pColor;
  }

  const pos = sub.positions;
  const canon = sub.canon;
  const dist2 = (u: number, v: number): number => {
    const u3 = u * 3, v3 = v * 3;
    const dx = pos[u3] - pos[v3];
    const dy = pos[u3 + 1] - pos[v3 + 1];
    const dz = pos[u3 + 2] - pos[v3 + 2];
    return dx * dx + dy * dy + dz * dz;
  };
  const edgeKey = (u: number, v: number): number => {
    const cu = canon[u], cv = canon[v];
    return cu < cv ? cu * 1e7 + cv : cv * 1e7 + cu;
  };

  // Top-down conforming emission: only mixed triangles initiate splits; uniform
  // neighbours split conformingly only along edges actually split by a mixed
  // neighbour, guaranteeing zero T-junctions.
  const rootFaces = sub.passes[0].inFaces;
  const rootCount = Math.floor(rootFaces.length / 3);
  let activeFaces: number[] = Array.from(rootFaces);
  let activeTreeIdx: number[] = Array.from({ length: rootCount }, (_, i) => i);
  const outFaces: number[] = [];

  for (let p = 0; p < numPasses && activeTreeIdx.length > 0; p++) {
    const pass = sub.passes[p];
    const pColor = levelColor[p];
    const nextFacesSrc = p + 1 < numPasses ? sub.passes[p + 1].inFaces : sub.faces;
    const activeMidpoints = new Map<number, number>();

    for (let i = 0; i < activeTreeIdx.length; i++) {
      const treeIdx = activeTreeIdx[i];
      if (treeIdx < 0 || pColor[treeIdx] !== -1) continue;
      const a = activeFaces[i * 3], b = activeFaces[i * 3 + 1], c = activeFaces[i * 3 + 2];
      const k0 = edgeKey(a, b);
      const m0 = pass.midpoints.get(k0);
      if (m0 !== undefined) activeMidpoints.set(k0, m0);
      const k1 = edgeKey(b, c);
      const m1 = pass.midpoints.get(k1);
      if (m1 !== undefined) activeMidpoints.set(k1, m1);
      const k2 = edgeKey(c, a);
      const m2 = pass.midpoints.get(k2);
      if (m2 !== undefined) activeMidpoints.set(k2, m2);
    }

    if (activeMidpoints.size === 0) break;

    const nextActiveFaces: number[] = [];
    const nextActiveTreeIdx: number[] = [];
    for (let i = 0; i < activeTreeIdx.length; i++) {
      const treeIdx = activeTreeIdx[i];
      const a = activeFaces[i * 3], b = activeFaces[i * 3 + 1], c = activeFaces[i * 3 + 2];
      if (treeIdx >= 0 && pColor[treeIdx] === -1) {
        const start = pass.childStart[treeIdx];
        const end = pass.childStart[treeIdx + 1];
        for (let ch = start; ch < end; ch++) {
          nextActiveFaces.push(nextFacesSrc[ch * 3], nextFacesSrc[ch * 3 + 1], nextFacesSrc[ch * 3 + 2]);
          nextActiveTreeIdx.push(ch);
        }
      } else {
        const m0 = activeMidpoints.get(edgeKey(a, b));
        const m1 = activeMidpoints.get(edgeKey(b, c));
        const m2 = activeMidpoints.get(edgeKey(c, a));
        if (m0 === undefined && m1 === undefined && m2 === undefined) {
          outFaces.push(a, b, c);
        } else {
          const before = nextActiveFaces.length;
          splitTriangleByMidpoints(a, b, c, m0, m1, m2, dist2, nextActiveFaces);
          const added = (nextActiveFaces.length - before) / 3;
          for (let k = 0; k < added; k++) nextActiveTreeIdx.push(-1);
        }
      }
    }
    activeFaces = nextActiveFaces;
    activeTreeIdx = nextActiveTreeIdx;
  }

  for (let i = 0; i < activeFaces.length; i++) outFaces.push(activeFaces[i]);
  return new Uint32Array(outFaces);
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
  // Read only where the material is smooth-shaded (a painted sculpt).
  geo.computeVertexNormals();
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

/**
 * The brush's hardness when nothing says otherwise, for the editor and MCP
 * alike: half the radius at full strength. The fully soft brush (0) took two
 * coats to cover a belly.
 */
export const DEFAULT_PAINT_HARDNESS = 0.5;

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
  /**
   * 0..1: the share of the radius laid down at full strength before the edge
   * starts to fall off. 0 (the default) is the soft round brush.
   */
  hardness?: number;
  /** Optional per-vertex unit normals (length = positions.length) for normal-filtered painting. */
  normals?: ArrayLike<number>;
  /** Optional unit facing vector in the surface's space: skip vertices whose normal dot product is < 0.1. */
  filterNormal?: readonly [number, number, number];
}

/** Area-weighted smooth per-vertex normals for a triangle mesh (positions, faces). */
export function computeVertexNormals(
  positions: ArrayLike<number>,
  faces: ArrayLike<number>,
): Float32Array {
  const n = Math.floor(positions.length / 3);
  const out = new Float32Array(n * 3);
  for (let t = 0; t + 2 < faces.length; t += 3) {
    const ia = faces[t] * 3, ib = faces[t + 1] * 3, ic = faces[t + 2] * 3;
    const ux = positions[ib] - positions[ia], uy = positions[ib + 1] - positions[ia + 1], uz = positions[ib + 2] - positions[ia + 2];
    const vx = positions[ic] - positions[ia], vy = positions[ic + 1] - positions[ia + 1], vz = positions[ic + 2] - positions[ia + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    out[ia] += nx; out[ia + 1] += ny; out[ia + 2] += nz;
    out[ib] += nx; out[ib + 1] += ny; out[ib + 2] += nz;
    out[ic] += nx; out[ic + 1] += ny; out[ic + 2] += nz;
  }
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    const len = Math.hypot(out[o], out[o + 1], out[o + 2]);
    if (len > 1e-12) {
      out[o] /= len; out[o + 1] /= len; out[o + 2] /= len;
    }
  }
  return out;
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

  const sum = va + vb + vc;
  if (!Number.isFinite(sum) || Math.abs(sum) <= 1e-24) {
    // Degenerate / zero-area triangle: fall back to the nearest vertex.
    const da = apx * apx + apy * apy + apz * apz;
    const db = bpx * bpx + bpy * bpy + bpz * bpz;
    const dc = cpx * cpx + cpy * cpy + cpz * cpz;
    if (da <= db && da <= dc) return { d2: da, wa: 1, wb: 0, wc: 0 };
    if (db <= dc) return { d2: db, wa: 0, wb: 1, wc: 0 };
    return { d2: dc, wa: 0, wb: 0, wc: 1 };
  }
  const denom = 1 / sum;
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
  { x, y, z, radius, color, flow, erase, hardness = 0, normals, filterNormal }: DabOptions,
  faces?: ArrayLike<number> | null,
): { lo: number; hi: number } | null {
  if (
    !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) ||
    !Number.isFinite(radius) || radius <= 0 ||
    !Number.isFinite(flow) || flow <= 0
  ) {
    return null;
  }
  const safeHardness = Number.isFinite(hardness) ? hardness : 0;
  const r2 = radius * radius;
  let lo = -1;
  let hi = -1;

  const paintVertex = (v: number, amount: number) => {
    if (!Number.isFinite(amount) || amount <= 0 || v < 0 || v >= canvas.count) return;
    const o = v * 4;
    const a = canvas.data[o + 3];

    if (erase) {
      canvas.data[o + 3] = a * (1 - amount);
    } else {
      // Porter-Duff src-over: new paint with coverage `amount` laid over
      // existing paint with coverage `a`. Each pass closes `amount` of what is
      // uncovered while blending the new colour over whatever is already down,
      // so `flow = 1` cleanly overwrites already-painted vertices and partial
      // flow walks through intermediate colours without stalling at `a = 1`.
      const keep = a * (1 - amount);
      const next = amount + keep;
      if (next > 0) {
        canvas.data[o] = (canvas.data[o] * keep + (color[0] ?? 0) * amount) / next;
        canvas.data[o + 1] = (canvas.data[o + 1] * keep + (color[1] ?? 0) * amount) / next;
        canvas.data[o + 2] = (canvas.data[o + 2] * keep + (color[2] ?? 0) * amount) / next;
      }
      canvas.data[o + 3] = next;
    }

    if (lo === -1 || v < lo) lo = v;
    if (v > hi) hi = v;
  };

  const fnx = filterNormal ? filterNormal[0] : 0;
  const fny = filterNormal ? filterNormal[1] : 0;
  const fnz = filterNormal ? filterNormal[2] : 0;
  const hasFilter = Boolean(normals && filterNormal && (fnx * fnx + fny * fny + fnz * fnz) > 1e-9);

  for (let v = 0; v < canvas.count; v++) {
    const dx = positions[v * 3] - x;
    const dy = positions[v * 3 + 1] - y;
    const dz = positions[v * 3 + 2] - z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= r2) continue;
    if (hasFilter) {
      const no = v * 3;
      const dot = normals![no] * fnx + normals![no + 1] * fny + normals![no + 2] * fnz;
      if (dot < 0.1) continue;
    }

    // Squared-cosine-ish falloff: full strength under the middle of the brush
    // and zero *slope* at the edge, so overlapping dabs down a stroke add up to
    // an even band instead of a row of visible rims.
    // Hardness holds the middle at full strength and fits the same falloff
    // into what is left of the radius.
    const core = Math.min(0.95, Math.max(0, safeHardness));
    const u = core > 0 ? Math.max(0, (Math.sqrt(d2) / radius - core) / (1 - core)) : 0;
    const t = core > 0 ? 1 - u * u : 1 - d2 / r2;
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

/**
 * Transfers a sparse `PaintLayer` from `sourcePositions` onto a new mesh's
 * `targetPositions` (both xyz flat arrays in the same coordinate space) by
 * nearest-vertex lookup using a uniform spatial grid.
 *
 * Used both when a surface pattern re-meshes a painted geom (so vertex paint
 * stays visible in the viewport alongside the pattern) and when mesh repair
 * welds/compacts vertices (so existing vertex paint is remapped instead of
 * scrambled across shifted vertex indices).
 */
export function transferPaintLayer(
  sourcePositions: ArrayLike<number>,
  sourceLayer: PaintLayer | undefined,
  targetPositions: ArrayLike<number>,
  targetRes: number[] = [],
): PaintLayer | undefined {
  if (!sourceLayer || !sourceLayer.idx.length) return undefined;
  const srcCount = Math.floor(sourcePositions.length / 3);
  const tgtCount = Math.floor(targetPositions.length / 3);
  if (srcCount === 0 || tgtCount === 0) return undefined;

  const srcCanvas = canvasFromLayer(sourceLayer, srcCount, sourceLayer.res);
  const tgtCanvas: PaintCanvas = { res: targetRes, count: tgtCount, data: new Float32Array(tgtCount * 4) };

  // Bounding box of source vertices to choose a balanced grid cell size.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < srcCount; i++) {
    const x = sourcePositions[i * 3];
    const y = sourcePositions[i * 3 + 1];
    const z = sourcePositions[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  const divs = Math.max(12, Math.min(64, Math.ceil(Math.cbrt(srcCount) * 1.5)));
  const cell = Math.max(diag / divs, 1e-5);
  const invCell = 1 / cell;

  const grid = new Map<string, number[]>();
  for (let i = 0; i < srcCount; i++) {
    const gx = Math.floor((sourcePositions[i * 3] - minX) * invCell);
    const gy = Math.floor((sourcePositions[i * 3 + 1] - minY) * invCell);
    const gz = Math.floor((sourcePositions[i * 3 + 2] - minZ) * invCell);
    const key = `${gx},${gy},${gz}`;
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = [];
      grid.set(key, bucket);
    }
    bucket.push(i);
  }

  const maxRing = Math.max(divs, 32);
  for (let v = 0; v < tgtCount; v++) {
    const x = targetPositions[v * 3];
    const y = targetPositions[v * 3 + 1];
    const z = targetPositions[v * 3 + 2];
    const gx = Math.floor((x - minX) * invCell);
    const gy = Math.floor((y - minY) * invCell);
    const gz = Math.floor((z - minZ) * invCell);

    let best = -1;
    let bestD2 = Infinity;
    for (let r = 0; r <= maxRing; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dz = -r; dz <= r; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
            const bucket = grid.get(`${gx + dx},${gy + dy},${gz + dz}`);
            if (!bucket) continue;
            for (let b = 0; b < bucket.length; b++) {
              const p = bucket[b];
              const ox = sourcePositions[p * 3] - x;
              const oy = sourcePositions[p * 3 + 1] - y;
              const oz = sourcePositions[p * 3 + 2] - z;
              const d2 = ox * ox + oy * oy + oz * oz;
              if (d2 < bestD2) {
                bestD2 = d2;
                best = p;
              }
            }
          }
        }
      }
      if (best >= 0 && bestD2 <= (r * cell) * (r * cell)) break;
    }
    if (best < 0) {
      for (let p = 0; p < srcCount; p++) {
        const ox = sourcePositions[p * 3] - x;
        const oy = sourcePositions[p * 3 + 1] - y;
        const oz = sourcePositions[p * 3 + 2] - z;
        const d2 = ox * ox + oy * oy + oz * oz;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = p;
        }
      }
    }
    if (best >= 0) {
      const a = srcCanvas.data[best * 4 + 3];
      if (a > 0) {
        tgtCanvas.data[v * 4] = srcCanvas.data[best * 4];
        tgtCanvas.data[v * 4 + 1] = srcCanvas.data[best * 4 + 1];
        tgtCanvas.data[v * 4 + 2] = srcCanvas.data[best * 4 + 2];
        tgtCanvas.data[v * 4 + 3] = a;
      }
    }
  }

  return layerFromCanvas(tgtCanvas);
}

/**
 * Alpha-over composites two `PaintLayer`s keyed to the same `vertexCount`
 * vertices (`over` drawn on top of `under`). Used when a surface pattern has
 * its own accent colour on top of existing `physics_paint` vertex colours.
 */
export function compositePaintLayers(
  under: PaintLayer | undefined,
  over: PaintLayer | undefined,
  vertexCount: number,
): PaintLayer | undefined {
  if (!under || !under.idx.length) return over;
  if (!over || !over.idx.length) return under;
  if (vertexCount <= 0) return undefined;

  const canvas = canvasFromLayer(under, vertexCount, over.res.length ? over.res : under.res);
  for (let i = 0; i < over.idx.length; i++) {
    const v = over.idx[i];
    if (v < 0 || v >= vertexCount) continue;
    const o4 = i * 4;
    const aOver = (over.rgba[o4 + 3] ?? 0) / 255;
    if (aOver <= 0) continue;
    const rOver = (over.rgba[o4] ?? 0) / 255;
    const gOver = (over.rgba[o4 + 1] ?? 0) / 255;
    const bOver = (over.rgba[o4 + 2] ?? 0) / 255;
    const c4 = v * 4;
    const aUnder = canvas.data[c4 + 3];
    const aOut = aOver + aUnder * (1 - aOver);
    if (aOut > 0) {
      canvas.data[c4] = (rOver * aOver + canvas.data[c4] * aUnder * (1 - aOver)) / aOut;
      canvas.data[c4 + 1] = (gOver * aOver + canvas.data[c4 + 1] * aUnder * (1 - aOver)) / aOut;
      canvas.data[c4 + 2] = (bOver * aOver + canvas.data[c4 + 2] * aUnder * (1 - aOver)) / aOut;
      canvas.data[c4 + 3] = aOut;
    }
  }
  return layerFromCanvas(canvas);
}

/**
 * Reconstructs the xyz vertex positions (in MuJoCo Z-up geom space) that a
 * geom's `PaintLayer` is keyed to, so paint can be transferred onto a
 * patterned or repaired mesh in the same Z-up frame.
 */
export function paintSurfacePositionsZup(params: {
  type: string;
  paint: PaintLayer;
  vertices?: ArrayLike<number>;
  renderVertices?: ArrayLike<number>;
  faces?: ArrayLike<number>;
  dynamic?: boolean;
  paintArgs?: number[];
}): Float32Array | null {
  const { type, paint, vertices, renderVertices, faces, dynamic, paintArgs } = params;
  const yupToZupF32 = (src: ArrayLike<number>): Float32Array => {
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      out[i] = src[i];
      out[i + 1] = -src[i + 2];
      out[i + 2] = src[i + 1];
    }
    return out;
  };

  if (type === 'mesh') {
    const isDynamic = dynamic !== false || !vertices?.length;
    const raw = isDynamic ? (renderVertices ?? vertices) : vertices;
    if (!raw?.length) return null;
    const pos = paint.res.length && faces?.length
      ? subdivideMeshForPaint(raw, faces, paint.res).positions
      : new Float32Array(raw);
    return isDynamic ? pos : yupToZupF32(pos);
  }

  if (!paintArgs?.length) return null;
  const built = buildPaintGeometry(type, paintArgs, paint.res);
  if (!built) return null;
  const posAttr = built.getAttribute('position');
  if (!posAttr || posAttr.count === 0) {
    built.dispose();
    return null;
  }
  let pos: Float32Array = new Float32Array(posAttr.array as ArrayLike<number>);
  built.dispose();
  if (type === 'ellipsoid') {
    for (let i = 0; i < pos.length; i++) {
      pos[i] *= paintArgs[i % 3] ?? 1;
    }
  }
  if (type === 'cylinder' || type === 'capsule') {
    pos = yupToZupF32(pos);
  }
  return pos;
}
