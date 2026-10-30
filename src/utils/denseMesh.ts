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

export interface ColliderCopy {
  /** Z-up, body frame, metres: the space of renderVertices (SceneGeom.colliderVertices). */
  colliderVertices: number[];
  colliderFaces: number[];
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
  { threshold = DENSE_MESH_TRIANGLES, budget = COLLIDER_TRIANGLE_BUDGET }: { threshold?: number; budget?: number } = {},
): Promise<ColliderCopy | null> {
  const triangles = Math.floor(faces.length / 3);
  if (triangles <= threshold) return null;
  const { MeshoptSimplifier } = await import('meshoptimizer/simplifier');
  await MeshoptSimplifier.ready;
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
  return { colliderVertices, colliderFaces, triangles, colliderTriangles: colliderFaces.length / 3 };
}

/**
 * The sentence an import says about a dense part: how many triangles it has,
 * that they are all drawn, and what it collides as.
 */
export function denseImportNote(copy: ColliderCopy): string {
  return `This part has ${copy.triangles.toLocaleString()} triangles. All of them are drawn and exported; it collides as a simplified ${copy.colliderTriangles.toLocaleString()}-triangle copy, because the full mesh would take about ${gb(engineBytesFor(copy.triangles))} of the physics engine's ${gb(ENGINE_HEAP_BYTES)} memory and the first rebuild or headless run would run out.`;
}
