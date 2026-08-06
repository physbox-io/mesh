// Keeps every boolean-modifier body's generated mesh in step with its
// primitives.
//
// A CSG body stores a hash of the inputs its derived geoms were built from
// (node.csgHash). Any edit that changes the boolean — a size slider, moving the
// negative shape, switching collision mode — changes the hash, and this is what
// notices and recompiles. Debounced, because openscad-wasm is nowhere near fast
// enough to keep up with a dragging slider.
//
// The same walk also builds nodes carrying raw OpenSCAD source that have never
// been compiled — a preset or an MCP-created body arrives with `scad` text and
// an empty mesh, and without this it renders as nothing until someone happens to
// press Compile. Only a *missing* mesh triggers it; editing the source still
// applies on the Compile button, as before.
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

// Source that failed to compile, so a broken body isn't retried on every scene
// change. Keyed by the source itself: editing it arms the retry again.
const failedScad = new Set<string>();

/**
 * True for a body carrying OpenSCAD source that has never been built into a
 * mesh. Deliberately not a content hash: editing the source still applies on the
 * Compile button, and only an absent mesh triggers an automatic build.
 */
export function needsScadBuild(node: SceneNode): boolean {
  const scad = node.scad;
  if (scad === undefined || scad.trim() === '') return false;
  const mesh = (node.geoms || []).find((g: any) => g.type === 'mesh');
  return !mesh || !mesh.faces || mesh.faces.length === 0;
}

function collectUnbuiltScad(nodes: SceneNode[], out: SceneNode[] = []): SceneNode[] {
  for (const node of nodes || []) {
    if (needsScadBuild(node) && !failedScad.has(node.scad!)) out.push(node);
    collectUnbuiltScad(node.children || [], out);
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
  const scene = useStore.getState().sceneGraph;
  const stale = collectStale(scene.nodes);
  const unbuilt = collectUnbuiltScad(scene.nodes);
  if (stale.length === 0 && unbuilt.length === 0) return 0;

  if (unbuilt.length > 0) {
    const { compileSCAD } = await import('../utils/openscad');
    await Promise.all(unbuilt.map(async node => {
      const scad = node.scad!;
      try {
        const compiled = await compileSCAD(scad);
        useStore.getState().updateNodeScad(node.id, scad, compiled, true);
      } catch (err) {
        failedScad.add(scad);
        console.error(`OpenSCAD compilation failed for ${node.id}:`, err);
      }
    }));
  }

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
  return stale.length + unbuilt.length;
}

export function useCsgAutoCompile() {
  const sceneGraph = useStore(state => state.sceneGraph);

  useEffect(() => {
    if (collectStale(sceneGraph.nodes).length === 0 &&
        collectUnbuiltScad(sceneGraph.nodes).length === 0) return;
    const timer = setTimeout(() => { void compileCsgNodes(); }, COMPILE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [sceneGraph]);
}
