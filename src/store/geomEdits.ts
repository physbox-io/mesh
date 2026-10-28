// ---------------------------------------------------------------------------
// What several of the store's shape edits share: settling a body's boolean
// state, its roundings and convex pieces after an edit, and the rebuild
// ---------------------------------------------------------------------------

import type { SceneGraph, SceneNode, SceneGeom, EdgeRoundFeature } from '../types/scene';
import { hasBooleanOps, csgHashOf } from '../utils/csg';
import { collidersAreStale } from '../utils/convexDecomposition';
import { cloneSceneGraph, findNode } from './sceneClone';
import type { PhysicsState } from './useStore';

/**
 * Takes a body's convex pieces off it once its mesh has changed shape.
 *
 * A decomposed body collides ONLY as its pieces — the mesh they were cut from
 * is dropped from the model (resolveCsgGeoms) — so after a sculpt stroke it
 * went on colliding as the shape before the stroke until the decomposer
 * caught up, a few seconds later. Pressed Play in that window and a part you
 * had just pulled downward was drawn sunk into the floor; when the new pieces
 * landed mid-run they arrived already buried, and the solver threw the body
 * across the scene. Without pieces it collides as its convex hull, which
 * always contains the mesh: coarser for a moment, never inside anything.
 * The hash is left alone, so the edit still reads as stale and the
 * decomposer still runs. Returns whether there was anything to take off.
 */
export function dropStaleColliders(node: SceneNode): boolean {
  if (node.csgEnabled || !node.geoms?.some((g) => g.csgDerived === 'collider')) return false;
  node.geoms = node.geoms.filter((g) => g.csgDerived !== 'collider');
  delete node.collisionDecomposed;
  return true;
}

/**
 * Rebuilds the physics model after an edit to a body's shapes — unless the
 * edit left a boolean body's mesh stale, in which case the build is skipped.
 *
 * useCsgAutoCompile notices the stale hash, evaluates the boolean and runs
 * its own build a moment later. Building here as well means every cut edit
 * costs two model builds, and the first one installs colliders for a mesh
 * that is about to be replaced: pure waste, and a visible stutter before the
 * real result lands. The scene graph itself is already set by the caller, so
 * the panel shows the edit at once either way.
 */
export function rebuildAfterGeomEdit(get: () => PhysicsState, newScene: SceneGraph, nodeId: string) {
  const node = findNode(newScene.nodes, nodeId);
  if (node?.csgEnabled && hasBooleanOps(node) && csgHashOf(node) !== node.csgHash) return;
  // Same reasoning for a body about to be re-decomposed, but only once it has
  // colliders to go stale: a body that has never been decomposed must still
  // build, or a mesh edit would show nothing until the decomposer caught up —
  // and a convex body, which never gains colliders, would never build at all.
  if (node && !node.csgEnabled && node.collisionDecomposed && collidersAreStale(node)) return;
  get().recompile(newScene, nodeId, false);
}

/**
 * After undo or redo: build any boolean body whose generated mesh no longer
 * matches what was restored.
 *
 * A snapshot carries a body's generated mesh as it was when the snapshot was
 * taken, which is not always the mesh of the shape it restores — undoing a
 * rounding puts the roundings back to none while the mesh saved with them is
 * still the rounded one. The removal button rebuilds straight away; undo has
 * to as well, rather than hope the auto-compiler gets round to it. Imported
 * lazily: the compiler's module imports this store.
 */
export function rebuildBooleansAfterRestore(): void {
  void import('../hooks/useCsgCompile')
    .then(({ compileCsgNodes }) => compileCsgNodes())
    .catch((err) => console.error('Rebuilding booleans after undo failed:', err));
}

/**
 * Puts a body's roundings on it and rebuilds. Rounding makes a body a boolean
 * one; taking the last rounding off a body with no other boolean makes it an
 * ordinary one again, and its generated mesh has to go with it or the rounded
 * shape would keep drawing over the square one.
 */
export function writeEdgeRounds(
  get: () => PhysicsState,
  set: (partial: Partial<PhysicsState>) => void,
  nodeId: string,
  features: EdgeRoundFeature[],
  rebuild = true,
) {
  const newScene = cloneSceneGraph(get().sceneGraph);
  const node = findNode(newScene.nodes, nodeId);
  if (!node) return;
  setNodeEdgeRounds(node, features);
  set({ sceneGraph: newScene });
  if (rebuild) rebuildAfterGeomEdit(get, newScene, nodeId);
}

/** writeEdgeRounds' edit to the node itself, on a graph the caller has cloned. */
export function setNodeEdgeRounds(node: SceneNode, features: EdgeRoundFeature[]) {
  if (features.length > 0) node.edgeRounds = features; else delete node.edgeRounds;
  delete node.edgeRoundsLost;
  settleBooleanState(node);
}

/**
 * Makes a body a boolean one when its shapes describe a boolean, and an
 * ordinary one again when they stop — taking the generated mesh with it, or the
 * old shape would keep drawing over the new one.
 */
export function settleBooleanState(node: SceneNode) {
  if (hasBooleanOps(node)) {
    node.csgEnabled = true;
    if (node.csgCollision === undefined) node.csgCollision = 'auto';
  } else if (node.csgEnabled) {
    node.csgEnabled = false;
    node.geoms = (node.geoms || []).filter((g: SceneGeom) => !g.csgDerived);
    delete node.csgHash;
  }
}
