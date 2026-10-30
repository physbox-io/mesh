// ---------------------------------------------------------------------------
// Keeping a dense import's collision copy in step with the mesh it is drawn as
//
// A dense geom collides as a simplified copy of its mesh (utils/denseMesh.ts).
// Anything that rewrites the mesh — a rescale, Simplify in the inspector, a
// repair, a sculpt, an agent's update — hands the graph new arrays and left the
// copy behind, so the part collided at its old shape. Rather than teach every
// one of those paths, the store's set middleware runs every new graph through
// here: a geom whose mesh no longer matches the fingerprint its copy was made
// from gets a new copy. Arrays are never edited in place, so the fingerprint
// is remembered against them and an unchanged geom costs a lookup.
// ---------------------------------------------------------------------------

import { loadSimplifier, refreshDenseCollider } from '../utils/denseMesh';
import type { SceneGraph, SceneNode } from '../types/scene';

let settling: Promise<void> | null = null;

/**
 * Resolves once no rebuild is waiting for the simplifier to load. A headless
 * run awaits it, so it never runs a part at the shape it had before an edit.
 */
export const denseCollidersSettled = (): Promise<void> => settling ?? Promise.resolve();

/**
 * The graph with every stale dense collider rebuilt, or the same graph when
 * none was. Rebuilding needs the simplifier's wasm; in the moments after a page
 * load before it is ready, the stale geom is left as it is and `retry` is
 * called once it has loaded, to write the graph again.
 */
export function withFreshDenseColliders(graph: SceneGraph, retry: () => void): SceneGraph {
  let waiting = false;
  let marked = false;
  const visit = (nodes: SceneNode[]): SceneNode[] => {
    let changed = false;
    const out = nodes.map((node) => {
      let geoms = node.geoms;
      if (geoms?.some((g) => g.denseColliderOf)) {
        marked = true;
        const next = geoms.map((g) => {
          const fresh = refreshDenseCollider(g);
          if (fresh === null) { waiting = true; return g; }
          return fresh;
        });
        if (next.some((g, i) => g !== geoms![i])) geoms = next;
      }
      const children = node.children?.length ? visit(node.children) : node.children;
      if (geoms === node.geoms && children === node.children) return node;
      changed = true;
      return { ...node, geoms, children };
    });
    return changed ? out : nodes;
  };
  const nodes = graph.nodes ? visit(graph.nodes) : graph.nodes;
  // A scene holding a dense part loads the simplifier in the background, so it
  // is ready by the time anything edits the part.
  if (marked) void loadSimplifier().catch(() => {});
  if (waiting && !settling) {
    settling = loadSimplifier().then(
      () => { settling = null; retry(); },
      () => { settling = null; },
    );
  }
  return nodes === graph.nodes ? graph : { ...graph, nodes };
}
