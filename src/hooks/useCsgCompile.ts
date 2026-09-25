// Keeps every boolean-modifier body's generated mesh in step with its
// primitives.
//
// A CSG body stores a hash of the inputs its derived geoms were built from
// (node.csgHash). Any edit that changes the boolean — a size slider, moving the
// negative shape, switching collision mode — changes the hash, and this is what
// notices and recompiles. Debounced a little, so a dragging slider settles
// before its boolean is evaluated — a short wait now that the engine is
// Manifold and a typical cut evaluates in tens of milliseconds.
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
import { collidersAreStale, collisionHashOf, decomposeNodeColliders } from '../utils/convexDecomposition';
import type { SceneNode } from '../types/scene';
import { bodyEdges, bodyUp } from '../utils/edgeRoundBase';
import { keepFoundEdges } from '../utils/edgeRound';
import { findNodeById } from '../utils/sceneTree';

const COMPILE_DEBOUNCE_MS = 100;

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
  const mesh = (node.geoms || []).find((g) => g.type === 'mesh');
  return !mesh || !mesh.faces || mesh.faces.length === 0;
}

/**
 * Bodies whose convex colliders no longer match their mesh.
 *
 * Skips csgEnabled nodes deliberately: a boolean body's colliders are produced
 * by evaluateNodeCsg, in the same pass that builds its mesh. Two producers
 * writing colliders to one node would fight over them every compile.
 */
function collectStaleColliders(nodes: SceneNode[], out: SceneNode[] = []): SceneNode[] {
  for (const node of nodes || []) {
    if (!node.csgEnabled && collidersAreStale(node)) out.push(node);
    collectStaleColliders(node.children || [], out);
  }
  return out;
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
  if (stale.length === 0 && unbuilt.length === 0 && collectStaleColliders(scene.nodes).length === 0) return 0;

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

  await Promise.all(stale.map(async staleNode => {
    let node = staleNode;
    const hash = csgHashOf(node);
    try {
      // Roundings are stored as the edges they were put on. When the shape
      // under them changes in a way nothing mapped — an OpenSCAD source edited,
      // a hole moved — some of those edges are simply not there any more, and
      // rounding them anyway would cut where an edge used to be. So they are
      // checked against the part as it now is, and the lost ones dropped.
      if (node.edgeRounds?.length) {
        const nodes = useStore.getState().sceneGraph.nodes;
        const found = await bodyEdges(node, bodyUp(nodes, node.id));
        const { features, lost } = keepFoundEdges(node.edgeRounds, found.edges.map((c) => c.edge));
        if (lost > 0) {
          useStore.getState().dropLostEdgeRounds(node.id, features, lost);
          node = findNodeById(useStore.getState().sceneGraph.nodes, node.id) ?? node;
          if (csgHashOf(node) === node.csgHash) return;
        }
      }
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

  // Re-read the scene rather than reuse the copy above: a boolean body's mesh
  // was just installed by applyNodeCsg, and a body whose mesh changed in this
  // same pass has to be decomposed from what it is NOW, not from what it was.
  const staleColliders = collectStaleColliders(useStore.getState().sceneGraph.nodes);
  await Promise.all(staleColliders.map(async node => {
    try {
      const result = await decomposeNodeColliders(node);
      if (result) useStore.getState().applyNodeColliders(node.id, result, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Convex decomposition failed for ${node.id}:`, err);
      useStore.getState().setNodeCollisionError(node.id, message, collisionHashOf(node));
    }
  }));

  if (!skipFinalRecompile) {
    await useStore.getState().recompile(useStore.getState().sceneGraph, undefined, false);
  }
  return stale.length + unbuilt.length + staleColliders.length;
}

/**
 * One queued run at a time, and a new scene change does not push it back.
 *
 * This used to be a plain debounce: every scene change cleared the timer and
 * started it again. A scene that is written more often than the debounce —
 * anything that rewrites the graph on a stream of events — then never let it
 * fire, and a boolean edit (or an undo, which restores a stale boolean mesh
 * and leaves the rebuild to this) never built. A run reads the scene when it
 * FIRES, so one run picks up every change queued behind it, and anything
 * still stale when it finishes is caught by the next scene change.
 */
let queuedRun: ReturnType<typeof setTimeout> | null = null;

export function scheduleCsgCompile(): void {
  if (queuedRun) return;
  queuedRun = setTimeout(() => {
    queuedRun = null;
    compileCsgNodes().catch((err) => console.error('Automatic boolean compile failed:', err));
  }, COMPILE_DEBOUNCE_MS);
}

export function useCsgAutoCompile() {
  const sceneGraph = useStore(state => state.sceneGraph);

  useEffect(() => {
    if (collectStale(sceneGraph.nodes).length === 0 &&
        collectUnbuiltScad(sceneGraph.nodes).length === 0 &&
        collectStaleColliders(sceneGraph.nodes).length === 0) return;
    scheduleCsgCompile();
  }, [sceneGraph]);
}
