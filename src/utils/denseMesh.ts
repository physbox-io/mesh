// ---------------------------------------------------------------------------
// Dense meshes: what a scanned or finely exported part costs the physics, and
// the lighter copy it collides as instead.
//
// MuJoCo keeps a bounding-volume tree, normals and a hull for every mesh in the
// model, and they cost about 1.3 KB per triangle: measured, a 200k-triangle
// mesh took the engine's heap to 255 MB and a 1.4M-triangle one to 1.85 GB, of
// the 2 GB a wasm module can have. That one model fits. Nothing else does: a
// rebuild holds the old model and the new one at once, and a headless run builds
// a second model beside the live one, so the first edit or the first headless
// run aborted the engine. The import itself had replied ok.
//
// So a dense part keeps every triangle where they are seen (drawn, measured,
// exported) and collides as a simplified copy, through the geom's collider
// source (SceneGeom.colliderVertices). mjcf.ts emits that copy as the body's
// collider and leaves the drawn mesh of a moving body out of the model.
//
// Simplification is meshoptimizer's edge collapse, which keeps the surface's
// topology and winding, so a closed part stays closed and still earns exact
// inertia. Pure apart from the wasm it awaits; no store, no worker. The
// simplifier is loaded on first use, so the parser and the MJCF compiler can
// read the thresholds here without pulling its wasm into their bundles.
// ---------------------------------------------------------------------------

import { PairMemo } from './arrayMemo';
import type { SceneGeom } from '../types/scene';

type Simplifier = typeof import('meshoptimizer/simplifier')['MeshoptSimplifier'];
let simplifier: Simplifier | null = null;
let loading: Promise<Simplifier> | null = null;

/** Loads the simplifier's wasm once; later calls return the same promise. */
export function loadSimplifier(): Promise<Simplifier> {
  loading ??= import('meshoptimizer/simplifier').then(async ({ MeshoptSimplifier }) => {
    await MeshoptSimplifier.ready;
    simplifier = MeshoptSimplifier;
    return MeshoptSimplifier;
  });
  return loading;
}

/** Whether colliderCopySync can run now. */
export const simplifierReady = () => simplifier !== null;

/** Above this many triangles a mesh gets a simplified copy to collide as. */
export const DENSE_MESH_TRIANGLES = 200_000;

/**
 * What the collision copy is simplified to. Collision sees a hull, or convex
 * pieces voxelised from the surface, and neither shows the difference between
 * fifty thousand triangles and a million; V-HACD takes this many in seconds.
 */
export const COLLIDER_TRIANGLE_BUDGET = 50_000;

/** Bytes of engine heap a model takes per mesh triangle (measured, see above). */
export const ENGINE_BYTES_PER_TRIANGLE = 1300;

/** The physics engine's wasm heap ceiling. */
export const ENGINE_HEAP_BYTES = 2 * 1024 ** 3;

/** The share of the heap two models may take: what is left is the engine's own working memory. */
const USABLE_HEAP_SHARE = 0.85;

/** Bytes of engine heap a model with this many mesh triangles is expected to take. */
export const engineBytesFor = (triangles: number) => triangles * ENGINE_BYTES_PER_TRIANGLE;

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/**
 * Why a headless run of a model with this many mesh triangles cannot work, or
 * null when it fits. The run builds its own model beside the live one, so two
 * of them must fit under the heap ceiling; past that the engine aborts part way
 * through the build and the run comes back as a crash.
 */
export function headlessMeshBudgetError(triangles: number): string | null {
  const twoModels = 2 * engineBytesFor(triangles);
  if (twoModels <= ENGINE_HEAP_BYTES * USABLE_HEAP_SHARE) return null;
  return `The physics model holds ${Math.round(triangles).toLocaleString()} mesh triangles — about ${gb(engineBytesFor(triangles))} of the physics engine's ${gb(ENGINE_HEAP_BYTES)} memory — and a headless run builds a second copy beside the live one, which does not fit. Re-import the part (physics_import_stl gives a dense mesh a simplified collision copy) or simplify its mesh, then run again.`;
}

const fingerprints = new PairMemo<string>();
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/**
 * A fingerprint of a mesh's vertices and faces: what a dense geom's collider
 * was made from (SceneGeom.denseColliderOf). Each coordinate is hashed as the
 * float32 it rounds to, so a scene saved (meshPacking stores float32) and
 * loaded again has the same fingerprint, and its collider is not rebuilt for
 * nothing. Remembered against the arrays, which are never edited in place.
 */
export function meshFingerprint(vertices: ArrayLike<number>, faces: ArrayLike<number>): string {
  return fingerprints.get(vertices, faces, () => {
    let h = 0x811c9dc5;
    for (let i = 0; i < vertices.length; i++) {
      f32[0] = vertices[i];
      h = Math.imul(h ^ u32[0], 0x01000193) >>> 0;
    }
    for (let i = 0; i < faces.length; i++) h = Math.imul(h ^ faces[i], 0x01000193) >>> 0;
    return `${vertices.length}:${faces.length}:${h.toString(16)}`;
  });
}

export interface ColliderCopy {
  /** Z-up, body frame, metres: the space of renderVertices (SceneGeom.colliderVertices). */
  colliderVertices: number[];
  colliderFaces: number[];
  /** meshFingerprint of the mesh it was made from, for SceneGeom.denseColliderOf. */
  source: string;
  /** Triangles in the mesh as given. */
  triangles: number;
  /** Triangles in the copy. */
  colliderTriangles: number;
}

/**
 * The simplified copy a dense mesh collides as, or null when the mesh is under
 * DENSE_MESH_TRIANGLES and collides as itself. `vertices` are Z-up
 * (renderVertices); the copy is in the same space.
 *
 * Edge collapse first, which keeps the topology; when that stalls above the
 * budget (open borders and seams it may not move), the rest is taken by the
 * sloppy simplifier, which does not care about topology and always gets there.
 */
export async function colliderCopyOf(
  vertices: ArrayLike<number>,
  faces: ArrayLike<number>,
  opts: { threshold?: number; budget?: number } = {},
): Promise<ColliderCopy | null> {
  if (Math.floor(faces.length / 3) <= (opts.threshold ?? DENSE_MESH_TRIANGLES)) return null;
  await loadSimplifier();
  return colliderCopySync(vertices, faces, opts);
}

/** colliderCopyOf once the simplifier has loaded (simplifierReady); throws before. */
export function colliderCopySync(
  vertices: ArrayLike<number>,
  faces: ArrayLike<number>,
  { threshold = DENSE_MESH_TRIANGLES, budget = COLLIDER_TRIANGLE_BUDGET }: { threshold?: number; budget?: number } = {},
): ColliderCopy | null {
  const triangles = Math.floor(faces.length / 3);
  if (triangles <= threshold) return null;
  const MeshoptSimplifier = simplifier;
  if (!MeshoptSimplifier) throw new Error('The mesh simplifier has not loaded yet (await loadSimplifier()).');
  const positions = Float32Array.from(vertices);
  const indices = Uint32Array.from(faces);
  const target = Math.max(3, Math.min(budget, triangles) * 3);
  // target_error 1 is the mesh's whole extent, relative: no bound but the count.
  let [out] = MeshoptSimplifier.simplify(indices, positions, 3, target, 1);
  if (out.length > target) [out] = MeshoptSimplifier.simplifySloppy(out, positions, 3, null, target, 1);

  // Keep only the vertices the copy uses, renumbered in order of first use.
  const remap = new Int32Array(positions.length / 3).fill(-1);
  const colliderVertices: number[] = [];
  const colliderFaces: number[] = new Array(out.length);
  for (let i = 0; i < out.length; i++) {
    const v = out[i];
    if (remap[v] === -1) {
      remap[v] = colliderVertices.length / 3;
      colliderVertices.push(vertices[v * 3], vertices[v * 3 + 1], vertices[v * 3 + 2]);
    }
    colliderFaces[i] = remap[v];
  }
  return {
    colliderVertices, colliderFaces, source: meshFingerprint(vertices, faces),
    triangles, colliderTriangles: colliderFaces.length / 3,
  };
}

/**
 * The mesh a dense geom's collider is made from, and fingerprinted on: its
 * Z-up renderVertices, or its Y-up vertices turned Z-up when it has none.
 * `key` is the array the fingerprint is remembered against.
 */
function colliderSource(g: SceneGeom): { key: number[]; zUp: () => number[] } | null {
  if (!g.faces?.length) return null;
  if (g.renderVertices?.length) return { key: g.renderVertices, zUp: () => g.renderVertices! };
  const v = g.vertices;
  if (!v?.length) return null;
  return {
    key: v,
    zUp: () => {
      const out = new Array<number>(v.length);
      for (let i = 0; i < v.length; i += 3) { out[i] = v[i]; out[i + 1] = -v[i + 2]; out[i + 2] = v[i + 1]; }
      return out;
    },
  };
}

/**
 * A dense geom whose mesh still is what its collider was made from comes back
 * as it is. One whose mesh has changed since (rescaled, simplified, repaired,
 * sculpted: any write of new arrays) comes back with a collider made from the
 * new mesh, or, if the mesh is no longer dense, with no collider and no mark,
 * so it collides as itself. Null when it needs rebuilding and the simplifier
 * has not loaded yet: the caller loads it and asks again.
 */
export function refreshDenseCollider(g: SceneGeom): SceneGeom | null {
  if (!g.denseColliderOf) return g;
  const source = colliderSource(g);
  if (!source) return g;
  if (meshFingerprint(source.key, g.faces!) === g.denseColliderOf) return g;
  if (!simplifierReady()) return null;
  const copy = colliderCopySync(source.zUp(), g.faces!);
  if (!copy) {
    const { colliderVertices: _v, colliderFaces: _f, denseColliderOf: _d, ...rest } = g;
    return rest;
  }
  return {
    ...g,
    colliderVertices: copy.colliderVertices,
    colliderFaces: copy.colliderFaces,
    denseColliderOf: meshFingerprint(source.key, g.faces!),
  };
}

/**
 * The sentence an import says about a dense part: how many triangles it has,
 * that they are all drawn, and what it collides as.
 */
export function denseImportNote(copy: ColliderCopy): string {
  return `This part has ${copy.triangles.toLocaleString()} triangles. All of them are drawn and exported; it collides as a simplified ${copy.colliderTriangles.toLocaleString()}-triangle copy, because the full mesh would take about ${gb(engineBytesFor(copy.triangles))} of the physics engine's ${gb(ENGINE_HEAP_BYTES)} memory and the first rebuild or headless run would run out.`;
}
