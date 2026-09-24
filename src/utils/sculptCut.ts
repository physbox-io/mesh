// ---------------------------------------------------------------------------
// Sculpt scissors: cutting clay with a lasso
// ---------------------------------------------------------------------------
//
// Every brush in utils/sculptMesh.ts moves, splits or merges triangles inside a
// closed surface, so none of them can do the two things you most often want
// from a knife: make a hole through the clay, or take a piece off. This does
// both with one gesture. A loop drawn on screen is swept straight away from the
// camera into a prism, and the prism is taken out of the mesh — a loop in the
// middle of the clay is a hole, a loop over its edge is a piece cut off. Or,
// the other way round, everything *outside* the prism goes and the inside is
// kept.
//
// The boolean itself is manifold-3d's. A sculpt is up to 250 k vertices of
// dynamic-topology slivers, which is the input that breaks a hand-rolled BSP
// (utils/latticeBoolean.ts is built for a lattice's few hundred integer-grid
// faces and nothing like this), and the OpenSCAD path is a worker round trip
// through polyhedron text that ends sculpting (csgEnabled). Manifold takes the
// mesh as arrays, guarantees a manifold result, and closes the cut as part of
// the boolean.
//
// Closing the cut is optional. Left open, the prism's own faces are dropped
// from the result, so the hole has a bare rim and you can see into the clay —
// a shell rather than a solid. Manifold only accepts closed input, so an
// already-open sculpt is closed temporarily first (one fan per open rim, round
// a new centre vertex) and that temporary fill is dropped again afterwards,
// which is what lets a second open hole follow the first. Each input is tagged
// with its own original ID, and every output triangle says which input it came
// from, so "drop the prism's faces" and "drop the fill" are both a filter.
//
// Coordinates are the sculpt's own: Z-up metres, as in SculptMesh.
// ---------------------------------------------------------------------------

import type { ManifoldToplevel, Manifold as ManifoldT } from 'manifold-3d';
import { createSculptMesh, meshBounds, type SculptMesh } from './sculptMesh';

let loading: Promise<ManifoldToplevel> | null = null;

/**
 * The manifold-3d module, loaded on first use.
 *
 * Lazily, because it is a megabyte of wasm that only the scissors need. In the
 * browser the wasm's URL comes from Vite; under Node (the tests) the module
 * finds the file next to itself, and a Vite URL would only send it looking in
 * the wrong place.
 */
export function loadManifold(): Promise<ManifoldToplevel> {
  if (!loading) {
    loading = (async () => {
      const { default: Module } = await import('manifold-3d');
      let config: { locateFile: () => string } | undefined;
      // A window or a worker is a Vite bundle; neither is Node.
      if (typeof window !== 'undefined' || typeof (globalThis as { importScripts?: unknown }).importScripts === 'function') {
        const { default: wasmUrl } = await import('manifold-3d/manifold.wasm?url');
        config = { locateFile: () => wasmUrl };
      }
      const wasm = await Module(config);
      wasm.setup();
      return wasm;
    })();
    // A failed load is not cached: the next attempt should try again.
    loading.catch(() => { loading = null; });
  }
  return loading;
}

/**
 * Maps a point of the unit prism to the sculpt's space.
 *
 * (x, y) is where it is on the loop — NDC for a lasso on screen, or plane
 * coordinates for an agent's polygon — and t in [0, 1] is how far along the
 * sweep. The prism is built in that space and warped through this; which way t
 * runs does not matter, since buildPrism turns a mirrored prism the right way
 * out.
 */
export type PrismMap = (x: number, y: number, t: number) => [number, number, number];

export type CutMode = 'remove' | 'keep';

export interface CutOptions {
  /** 'remove' takes the prism out; 'keep' keeps only what is inside it. */
  mode?: CutMode;
  /** Close the cut with new faces (true, the default), or leave it open. */
  cap?: boolean;
}

export type CutResult =
  | { ok: true; mesh: SculptMesh; facesBefore: number; facesAfter: number; pieces: number }
  | { ok: false; error: string };

/** Loops enclosing less than this (in the loop's own units) are a click, not a cut. */
const MIN_LOOP_AREA = 1e-8;

/**
 * The prism a loop sweeps out, as a Manifold. Null when the loop encloses
 * nothing — a click, or a scribble that folds back on itself.
 *
 * The loop is cleaned by the cross-section's NonZero fill rule rather than
 * taken as drawn: a freehand lasso crosses itself as often as not, and either
 * winding has to mean "inside".
 */
export function buildPrism(wasm: ManifoldToplevel, loop: [number, number][], map: PrismMap): ManifoldT | null {
  if (loop.length < 3) return null;
  const section = new wasm.CrossSection([loop], 'NonZero');
  try {
    // Measured after the clean-up, not before: a figure-eight's signed area
    // sums to nothing although both of its lobes enclose clay.
    if (section.isEmpty() || section.area() < MIN_LOOP_AREA) return null;
    // Unit height, warped afterwards. The side faces stay planar under the
    // warp — each joins two rays, which lie in one plane through the eye — and
    // so do the ends, which sit at a fixed depth.
    const unit = wasm.Manifold.extrude(section, 1);
    try {
      const warped = unit.warp((v) => {
        const p = map(v[0], v[1], v[2]);
        v[0] = p[0]; v[1] = p[1]; v[2] = p[2];
      });
      if (warped.volume() >= 0) return warped;
      // A map that mirrors — screen space is left-handed once depth runs away
      // from the viewer — turns the prism inside out, and an inside-out cutter
      // subtracts as if it were everything but itself. Sweeping the other way
      // mirrors it back.
      warped.delete();
      return unit.warp((v) => {
        const p = map(v[0], v[1], 1 - v[2]);
        v[0] = p[0]; v[1] = p[1]; v[2] = p[2];
      });
    } finally {
      unit.delete();
    }
  } finally {
    section.delete();
  }
}

/**
 * Every open rim of a mesh, as vertex loops — walked along the boundary
 * half-edges, the ones whose twin is missing.
 *
 * Null when a rim cannot be walked as a simple loop (two rims meeting at one
 * vertex), because the temporary fill below needs each one to be a cycle.
 */
function boundaryLoops(mesh: SculptMesh): number[][] | null {
  const { faces, faceCount, vertexCount } = mesh;
  // Numeric keys: a dense sculpt has a million and a half half-edges, and
  // building a string for each is most of the cost of the whole cut.
  const key = (a: number, b: number) => a * vertexCount + b;
  const half = new Set<number>();
  for (let f = 0; f < faceCount; f++) {
    for (let e = 0; e < 3; e++) {
      half.add(key(faces[f * 3 + e], faces[f * 3 + ((e + 1) % 3)]));
    }
  }
  // Boundary half-edge a→b, keyed by a. A vertex with two outgoing boundary
  // edges is where two rims touch.
  const next = new Map<number, number>();
  for (let f = 0; f < faceCount; f++) {
    for (let e = 0; e < 3; e++) {
      const a = faces[f * 3 + e];
      const b = faces[f * 3 + ((e + 1) % 3)];
      if (half.has(key(b, a))) continue;
      if (next.has(a)) return null;
      next.set(a, b);
    }
  }
  const loops: number[][] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: number[] = [];
    let v = start;
    while (!seen.has(v)) {
      seen.add(v);
      loop.push(v);
      const n = next.get(v);
      if (n === undefined) return null;
      v = n;
    }
    if (v !== start) return null;
    loops.push(loop);
  }
  return loops;
}

/**
 * Cut a sculpt with a prism. Pure: the mesh passed in is not touched, and the
 * result is a new one.
 */
export function cutSculpt(
  wasm: ManifoldToplevel,
  mesh: SculptMesh,
  prism: ManifoldT,
  options: CutOptions = {},
): CutResult {
  const mode = options.mode ?? 'remove';
  const cap = options.cap ?? true;

  // Close any open rims, so Manifold will accept the mesh. The fill goes in
  // after the clay's own triangles as a second run with its own ID, and is
  // filtered back out of the result.
  const loops = boundaryLoops(mesh);
  if (!loops) {
    return { ok: false, error: 'The surface has open edges that meet at a point, so it cannot be cut. Undo back to before they appeared.' };
  }
  const vertexCount = mesh.vertexCount + loops.length;
  const positions = new Float32Array(vertexCount * 3);
  positions.set(mesh.positions.subarray(0, mesh.vertexCount * 3));
  let fillTris = 0;
  for (const loop of loops) fillTris += loop.length;
  const triVerts = new Uint32Array((mesh.faceCount + fillTris) * 3);
  triVerts.set(mesh.faces.subarray(0, mesh.faceCount * 3));
  let t = mesh.faceCount * 3;
  loops.forEach((loop, k) => {
    const centre = mesh.vertexCount + k;
    let cx = 0, cy = 0, cz = 0;
    for (const v of loop) {
      cx += mesh.positions[v * 3]; cy += mesh.positions[v * 3 + 1]; cz += mesh.positions[v * 3 + 2];
    }
    positions[centre * 3] = cx / loop.length;
    positions[centre * 3 + 1] = cy / loop.length;
    positions[centre * 3 + 2] = cz / loop.length;
    // The rim runs a→b along the clay's boundary, so the fill has to walk it
    // b→a for the two to share the edge the other way round.
    for (let i = 0; i < loop.length; i++) {
      triVerts[t++] = loop[(i + 1) % loop.length];
      triVerts[t++] = loop[i];
      triVerts[t++] = centre;
    }
  });

  const clayId = wasm.Manifold.reserveIDs(2);
  const fillId = clayId + 1;
  const runIndex = loops.length
    ? new Uint32Array([0, mesh.faceCount * 3, triVerts.length])
    : new Uint32Array([0, triVerts.length]);
  const runOriginalID = loops.length ? new Uint32Array([clayId, fillId]) : new Uint32Array([clayId]);

  let clay: ManifoldT;
  try {
    clay = new wasm.Manifold(new wasm.Mesh({
      numProp: 3, vertProperties: positions, triVerts, runIndex, runOriginalID,
    }));
  } catch {
    return { ok: false, error: 'The surface is not a clean solid (some edge is shared by more than two triangles), so it cannot be cut.' };
  }

  let result: ManifoldT | null = null;
  try {
    const status = clay.status();
    if (status !== 'NoError') {
      return { ok: false, error: `The surface cannot be cut as it is (${status}).` };
    }
    result = mode === 'keep' ? clay.intersect(prism) : clay.subtract(prism);
    if (result.isEmpty()) {
      return {
        ok: false,
        error: mode === 'keep' ? 'The loop does not cover any of the clay.' : 'That cut would remove all of the clay.',
      };
    }

    const out = result.getMesh();
    const keep = (id: number) => id === clayId || (cap && id !== fillId);
    const kept: number[] = [];
    for (let run = 0; run < out.runOriginalID.length; run++) {
      if (!keep(out.runOriginalID[run])) continue;
      for (let i = out.runIndex[run]; i < out.runIndex[run + 1]; i++) kept.push(out.triVerts[i]);
    }
    if (!kept.length) return { ok: false, error: 'Nothing of the clay would be left.' };

    // Compact: dropping faces strands vertices, and a sculpt's vertex count is
    // what its budget and its stats are measured in.
    const remap = new Int32Array(out.numVert).fill(-1);
    const newPositions: number[] = [];
    const newFaces = new Uint32Array(kept.length);
    for (let i = 0; i < kept.length; i++) {
      const v = kept[i];
      if (remap[v] < 0) {
        remap[v] = newPositions.length / 3;
        newPositions.push(
          out.vertProperties[v * out.numProp],
          out.vertProperties[v * out.numProp + 1],
          out.vertProperties[v * out.numProp + 2],
        );
      }
      newFaces[i] = remap[v];
    }

    const next = createSculptMesh(newPositions, newFaces);
    next.topologyRevision = mesh.topologyRevision + 1;
    next.revision = mesh.revision + 1;
    return {
      ok: true,
      mesh: next,
      facesBefore: mesh.faceCount,
      facesAfter: next.faceCount,
      pieces: countPieces(result),
    };
  } finally {
    clay.delete();
    result?.delete();
  }
}

function countPieces(manifold: ManifoldT): number {
  const parts = manifold.decompose();
  for (const part of parts) part.delete();
  return parts.length;
}

/**
 * How far a sweep has to reach to go all the way through a mesh: its bounding
 * sphere, padded, so neither end of the prism lands inside the clay.
 */
export function sweepSphere(mesh: SculptMesh): { centre: [number, number, number]; radius: number } {
  const { min, max } = meshBounds(mesh);
  const centre: [number, number, number] = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2;
  return { centre, radius: Math.max(radius * 1.1, 1e-3) };
}

/**
 * The prism map for a polygon given in the sculpt's own space: projected onto
 * the plane through its centroid facing `direction`, and swept along that
 * direction through the whole mesh. This is the agent's scissors — a parallel
 * sweep, since there is no camera to take perspective from.
 *
 * `direction` defaults to the polygon's own normal. Returns the loop in plane
 * coordinates and the map that puts it back.
 */
export function polygonPrismMap(
  mesh: SculptMesh,
  polygon: number[][],
  direction?: number[],
): { loop: [number, number][]; map: PrismMap } | null {
  if (polygon.length < 3) return null;
  const c = [0, 0, 0];
  for (const p of polygon) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  c[0] /= polygon.length; c[1] /= polygon.length; c[2] /= polygon.length;

  let d = direction;
  if (!d) {
    // Newell's method: the normal of a polygon that need not be flat.
    const n = [0, 0, 0];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      n[0] += (a[1] - b[1]) * (a[2] + b[2]);
      n[1] += (a[2] - b[2]) * (a[0] + b[0]);
      n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    d = n;
  }
  const dl = Math.hypot(d[0], d[1], d[2]);
  if (dl < 1e-12) return null;
  const w = [d[0] / dl, d[1] / dl, d[2] / dl];
  // Any vector not parallel to w, crossed with it, gives the plane's axes.
  const helper = Math.abs(w[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = [
    helper[1] * w[2] - helper[2] * w[1],
    helper[2] * w[0] - helper[0] * w[2],
    helper[0] * w[1] - helper[1] * w[0],
  ];
  const ul = Math.hypot(u[0], u[1], u[2]);
  u[0] /= ul; u[1] /= ul; u[2] /= ul;
  const v = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];

  const loop = polygon.map((p): [number, number] => {
    const r = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    return [r[0] * u[0] + r[1] * u[1] + r[2] * u[2], r[0] * v[0] + r[1] * v[1] + r[2] * v[2]];
  });

  // Through everything: from the far side of the bounding sphere to the near.
  const { centre, radius } = sweepSphere(mesh);
  const along = (centre[0] - c[0]) * w[0] + (centre[1] - c[1]) * w[1] + (centre[2] - c[2]) * w[2];
  const near = along - radius;
  const far = along + radius;

  const map: PrismMap = (x, y, t) => {
    const s = near + (far - near) * t;
    return [
      c[0] + x * u[0] + y * v[0] + s * w[0],
      c[1] + x * u[1] + y * v[1] + s * w[1],
      c[2] + x * u[2] + y * v[2] + s * w[2],
    ];
  };
  return { loop, map };
}

/**
 * A 4x4 matrix, column-major — the layout of THREE.Matrix4.elements, so the
 * viewport can hand its matrices over as they are.
 */
type Mat4 = ArrayLike<number>;

function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
  ];
}

/**
 * The prism map for a lasso drawn on screen, in NDC.
 *
 * Each loop point is a ray from the camera, and t runs along it between two
 * planes of constant view depth that bracket the whole mesh. Built from the
 * two points where the ray crosses NDC z = -1 and z = +1 rather than from an
 * eye position, so an orthographic camera — parallel rays, no eye — comes out
 * right with the same code.
 *
 * `projectionInverse` is the camera's; `viewToLocal` takes view space to the
 * sculpt's own (the body's world matrix inverted, times the camera's world
 * matrix).
 */
export function viewPrismMap(mesh: SculptMesh, projectionInverse: Mat4, viewToLocal: Mat4): PrismMap {
  // The mesh's depth range in view space, from its bounding sphere. The
  // inverse of viewToLocal is not to hand, so the sphere's centre is found in
  // view space by solving along the view axis instead: viewToLocal is rigid,
  // and its third column is the view's +Z axis in local space.
  const { centre, radius } = sweepSphere(mesh);
  const origin = transformPoint(viewToLocal, 0, 0, 0);
  const zAxis = [viewToLocal[8], viewToLocal[9], viewToLocal[10]];
  const zLen = Math.hypot(zAxis[0], zAxis[1], zAxis[2]) || 1;
  const depth = -((centre[0] - origin[0]) * zAxis[0] + (centre[1] - origin[1]) * zAxis[1] + (centre[2] - origin[2]) * zAxis[2]) / zLen;
  // In front of the camera only: a perspective ray is a line through the eye,
  // and sweeping it behind the eye would turn the prism inside out through a
  // point.
  const nearDepth = Math.max(depth - radius, 1e-4);
  const farDepth = Math.max(depth + radius, nearDepth + 1e-4);

  return (x, y, t) => {
    const a = transformPoint(projectionInverse, x, y, -1);
    const b = transformPoint(projectionInverse, x, y, 1);
    const want = -(nearDepth + (farDepth - nearDepth) * t);
    const dz = b[2] - a[2];
    const s = Math.abs(dz) < 1e-12 ? 0 : (want - a[2]) / dz;
    return transformPoint(viewToLocal, a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, want);
  };
}

/**
 * What to cut with, as plain data — so it can cross to the worker, where a
 * function cannot.
 */
export type PrismSpec =
  | { kind: 'view'; loop: [number, number][]; projectionInverse: number[]; viewToLocal: number[] }
  | { kind: 'polygon'; polygon: number[][]; direction?: number[] };

/** Build the prism a spec describes and cut the mesh with it. */
export function cutSculptWith(
  wasm: ManifoldToplevel,
  mesh: SculptMesh,
  spec: PrismSpec,
  options: CutOptions = {},
): CutResult {
  let loop: [number, number][];
  let map: PrismMap;
  if (spec.kind === 'view') {
    loop = spec.loop;
    map = viewPrismMap(mesh, spec.projectionInverse, spec.viewToLocal);
  } else {
    const built = polygonPrismMap(mesh, spec.polygon, spec.direction);
    if (!built) return { ok: false, error: 'The polygon needs at least three points that are not all in a line.' };
    ({ loop, map } = built);
  }
  const prism = buildPrism(wasm, loop, map);
  if (!prism) return { ok: false, error: 'The loop does not enclose anything.' };
  try {
    return cutSculpt(wasm, mesh, prism, options);
  } finally {
    prism.delete();
  }
}
