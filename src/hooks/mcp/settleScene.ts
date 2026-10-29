// ---------------------------------------------------------------------------
// Putting a scene an agent built into the store, and waiting for it to settle
// ---------------------------------------------------------------------------

import { useStore } from '../../store/useStore';
import { compileSCAD } from '../../utils/openscad';
import { compileCsgNodes } from '../useCsgCompile';
import type { SceneNode } from '../../types/scene';
import { type PhysicsWindow, countBodies } from './bridgeUtils';
import { applyDeclarativePreCsgFeatures, applyDeclarativePostCsgFeatures } from './bodyFeatures';

export const autoCompileScad = async (nodes: SceneNode[]) => {
  const scadNodes: SceneNode[] = [];
  const collect = (nodesList: SceneNode[]) => {
    if (!nodesList) return;
    for (const node of nodesList) {
      if (node.scad) scadNodes.push(node);
      collect(node.children || []);
    }
  };
  collect(nodes);

  // These used to be compiled strictly sequentially: openscad-wasm has shared
  // global state, and running two compiles concurrently was observed to silently
  // return an empty mesh for one of them. That constraint is per-realm, and
  // compileSCAD now dispatches across a pool of workers that each get their own
  // realm - so firing them together is safe, and a scene with several scad nodes
  // compiles in parallel instead of paying the sum of every node's compile time.
  // (Within any one worker compiles are still serialized; excess nodes queue.)
  await Promise.all(scadNodes.map(async (node) => {
    // openscad-wasm has been observed to intermittently fail (throw, or return
    // empty output) on a compile immediately following another one, even when
    // run strictly sequentially with a fresh instance each time - some global
    // state in the library isn't fully torn down between calls. Retry a couple
    // of times before giving up, since a clean retry reliably succeeds.
    let compiled: { vertices: number[]; faces: number[]; renderVertices: number[] } | null = null;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3 && !compiled; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 100));
      try {
        // `collect` only ever pushes a node that has one.
        const result = await compileSCAD(node.scad!);
        // A technically-valid but empty STL (zero triangles) doesn't throw in
        // compileSCAD but is just as much a failed compile - retry it too.
        if (result.faces.length === 0) {
          lastErr = new Error('Compile produced an empty mesh (0 faces)');
          continue;
        }
        compiled = result;
      } catch (err) {
        lastErr = err;
      }
    }
    if (compiled) {
      // skipRecompile: the caller (settleScene) runs a single recompile after
      // every node is done. Without this, each node's own recompile fires an
      // unawaited MJCF/WASM build using whatever the scene looked like at that
      // moment - e.g. compiled while a later node's mesh doesn't exist yet - and
      // these overlapping builds race. Letting one of the stale/erroring ones
      // finish last silently corrupts lastCompileError even when the scene is fine.
      useStore.getState().updateNodeScad(node.id, node.scad!, compiled, true);
    } else {
      console.error(`Failed to auto-compile SCAD for node ${node.id} after 3 attempts:`, lastErr);
    }
  }));
};

// Loads a scene and waits for it to fully settle before responding: SCAD bodies
// compile asynchronously, so a caller that gets an immediate ok:true has no way
// to know whether the scene it just loaded actually built successfully. This
// awaits the whole pipeline (all scad compiles, then a single final recompile)
// and reports the real MJCF compile result instead.
export const settleScene = async (
  nodes: SceneNode[],
  { replacesScene = true, freshStart = false }: { replacesScene?: boolean; freshStart?: boolean } = {},
): Promise<{ ok: boolean; error?: string; nodeCount: number; topLevelCount: number }> => {
  const store = useStore.getState();
  // A freshly built/replaced scene (BUILD_SCENE/UPDATE_SCENE) is never a preset
  // load, so any note card left over from a previously-loaded preset (e.g.
  // "Double Pendulum") is now describing a scene that no longer exists. Clear
  // it here rather than relying on callers to remember to. Not for a caller
  // that only adds a body to the scene (CREATE_LATTICE, IMPORT_STL): that
  // wiped the user's own notes.
  if (replacesScene) (window as unknown as PhysicsWindow)._physics_setNoteCards?.([]);
  // skipRecompile: this initial set uses placeholder (pre-scad) mesh geoms, so
  // an immediate recompile here would be both wasted work and another stale
  // build racing against the final one below.
  // A caller that only adds a body keeps what the scene says about itself:
  // print fidelity, cast prep, reference pictures, its name.
  store.updateScene(replacesScene ? { nodes } : { ...store.sceneGraph, nodes }, true);
  await autoCompileScad(nodes);
  await applyDeclarativePreCsgFeatures(nodes);
  // Boolean bodies compile through the same OpenSCAD pool, and just as
  // asynchronously — a caller that got ok:true before they finished would be
  // told a scene built when its geometry didn't exist yet. skipFinalRecompile:
  // the single build below covers it.
  await compileCsgNodes(true);
  await applyDeclarativePostCsgFeatures(nodes);
  // This is now the ONLY recompile triggered by this load, so there's nothing
  // left to race against. forceReset is false so recompile() preserves qpos/qvel
  // when the edit didn't change the DOF count (e.g. tweaking a color or adding a
  // fixed body) instead of always snapping the sim back to its initial state.
  // A new scene altogether (freshStart) starts its clock at zero instead of
  // carrying the old scene's time into its telemetry.
  await useStore.getState().recompile(useStore.getState().sceneGraph, undefined, freshStart, true);
  const error = useStore.getState().lastCompileError;
  // nodeCount is every body, nested ones included: a ten-body ride built as
  // one tower with everything hung off it used to report nodeCount 1.
  return { ok: !error, ...(error ? { error } : {}), nodeCount: countBodies(nodes), topLevelCount: nodes.length };
};
