// Keeps every boolean-modifier body's generated mesh in step with its
// primitives.
//
// A CSG body stores a hash of the inputs its derived geoms were built from
// (node.csgHash). Any edit that changes the boolean — a size slider, moving the
// negative shape, switching collision mode — changes the hash, and this is what
// notices and recompiles. Debounced, because openscad-wasm is nowhere near fast
// enough to keep up with a dragging slider.
//
// The same walk is exported for headless/MCP flows, which need to AWAIT the
// compile rather than let an effect catch up later.

import { useEffect } from 'react';
import { useStore } from '../store/useStore';
import { csgHashOf, evaluateNodeCsg, hasBooleanOps } from '../utils/csg';
import type { SceneNode } from '../types/scene';

const COMPILE_DEBOUNCE_MS = 250;

function collectStale(nodes: SceneNode[], out: SceneNode[] = []): SceneNode[] {
  for (const node of nodes || []) {
    if (node.csgEnabled && hasBooleanOps(node) && csgHashOf(node) !== node.csgHash) out.push(node);
    collectStale(node.children || [], out);
  }
  return out;
}

/**
 * Recompiles every boolean body whose mesh is out of date. Reads the scene from
 * the store at call time (not from a captured copy) so it can't install geoms
 * derived from primitives the user has since changed.
 *
 * Returns the number of bodies compiled. Errors are recorded on the node
 * (csgError) rather than thrown — one broken shape shouldn't stop the others.
 */
export async function compileCsgNodes(skipFinalRecompile = false): Promise<number> {
  const stale = collectStale(useStore.getState().sceneGraph.nodes);
  if (stale.length === 0) return 0;

  await Promise.all(stale.map(async node => {
    const hash = csgHashOf(node);
    try {
      const result = await evaluateNodeCsg(node);
      // skipRecompile: one build at the end, so several boolean bodies in a
      // scene can't race overlapping MJCF/WASM builds against each other.
      if (result) useStore.getState().applyNodeCsg(node.id, result, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`CSG evaluation failed for ${node.id}:`, err);
      useStore.getState().setNodeCsgError(node.id, message, hash);
    }
  }));

  if (!skipFinalRecompile) {
    await useStore.getState().recompile(useStore.getState().sceneGraph, undefined, false);
  }
  return stale.length;
}

export function useCsgAutoCompile() {
  const sceneGraph = useStore(state => state.sceneGraph);

  useEffect(() => {
    if (collectStale(sceneGraph.nodes).length === 0) return;
    const timer = setTimeout(() => { void compileCsgNodes(); }, COMPILE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [sceneGraph]);
}
