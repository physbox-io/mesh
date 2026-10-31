// ---------------------------------------------------------------------------
// The MCP sculpt commands' own state: which geom a sculpt is, and the agent's
// undo history of strokes (separate from the editor's)
// ---------------------------------------------------------------------------

import { useStore } from '../../store/useStore';
import { fromSceneGeom, toSceneGeom, splitComponents } from '../../utils/sculptMesh';
import { sculptSummary } from '../../utils/sculptCommands';
import { cutSculptOffThread } from '../../utils/sculptCutClient';
import type { SceneNode, SceneGeom } from '../../types/scene';
import type { SculptMesh, SculptUndoEntry } from '../../utils/sculptMesh';
import { findNodeInScene } from './bridgeUtils';

/**
 * The last few strokes on each sculpt, so they can be taken back off.
 *
 * Held here rather than in the store because it is the agent's own history:
 * a person's undo stack belongs to the editor and is driven by Ctrl-Z, and
 * mixing the two would let one of them silently swallow the other's work.
 * Capped because each entry can hold a copy of the mesh.
 */
export const sculptHistory = new Map<string, SculptUndoEntry[]>();

export const SCULPT_HISTORY_DEPTH = 8;

export function sculptMeshOf(node: SceneNode | null | undefined, geomIndex = sculptGeomIndex(node)) {
  const geom = node?.geoms?.[geomIndex];
  if (!geom?.renderVertices?.length || !geom?.faces?.length) {
    throw new Error(`'${node?.id}' has no sculptable mesh geom`);
  }
  return fromSceneGeom(geom.renderVertices, geom.faces);
}

/**
 * Which geom the brushes work on: a sculpt body's clay, or on any other body
 * the first mesh it carries that is not the output of a boolean - the rule the
 * inspector's "Sculpt This Mesh" button uses. -1 when there is none.
 */
export function sculptGeomIndex(node: SceneNode | null | undefined): number {
  const geoms = node?.geoms ?? [];
  if (node?.isSculpt) return geoms.findIndex((g) => g.type === 'mesh');
  return geoms.findIndex((g) => g.type === 'mesh' && !g.csgDerived && !!g.renderVertices?.length && !!g.faces?.length);
}

/**
 * Resolves an id to a body the sculpt tools can work on, and the geom they
 * work on, or explains why it is not one.
 *
 * Any mesh can be brushed: a sculpt body, an imported STL, a generated scene
 * mesh, a compiled OpenSCAD part. A boolean body cannot - what it draws is
 * rebuilt from its primitives on every compile, so a stroke would last until
 * the next one - and neither can a primitive, which has no mesh to move.
 */
/**
 * Puts a cut made off-thread (scissors or carve) onto the body: refused if
 * the body changed while the worker had it, split into one body per piece if
 * it came apart, and otherwise one entry in the agent's sculpt history.
 */
/** Whether two geoms hold the same mesh: same counts, and the same values at a spread of places. */
export function sameMesh(a: SceneGeom | undefined, b: SceneGeom | undefined): boolean {
  if (a === b) return true;
  const av = a?.renderVertices, bv = b?.renderVertices, af = a?.faces, bf = b?.faces;
  if (!av || !bv || !af || !bf) return false;
  if (av === bv && af === bf) return true;
  if (av.length !== bv.length || af.length !== bf.length) return false;
  const step = Math.max(1, Math.floor(av.length / 997));
  for (let i = 0; i < av.length; i += step) if (av[i] !== bv[i]) return false;
  const fstep = Math.max(1, Math.floor(af.length / 997));
  for (let i = 0; i < af.length; i += fstep) if (af[i] !== bf[i]) return false;
  return true;
}

export async function applySculptCutResult(
  targetId: string,
  geomIndex: number,
  geomBefore: SceneGeom | undefined,
  mesh: SculptMesh,
  result: Awaited<ReturnType<typeof cutSculptOffThread>>,
  opts: { add?: boolean } = {},
) {
  if (!result.ok) return { ok: false, id: targetId, error: result.error };

  // The worker had it for a while; if the body changed meanwhile, the
  // cut is of a shape that no longer exists. The clay is found again by its
  // geom's name and compared by the mesh it holds: the collider pass that
  // follows every edit rewrites the node and, once the clay is concave, adds
  // its convex pieces as geoms, so the old index and the old object both
  // refused the next carve while the clay itself was untouched.
  const live = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId);
  const liveIndex = live?.geoms?.findIndex((g) => g.name === geomBefore?.name) ?? -1;
  if (!live || liveIndex < 0 || !sameMesh(live.geoms[liveIndex], geomBefore)) {
    return { ok: false, id: targetId, error: 'The body changed while it was being cut; nothing was applied.' };
  }
  geomIndex = liveIndex;

  // A cut that splits the clay makes one body per piece, as the
  // Scissors do in the viewport. That is a change to the document, so
  // it is the editor's undo that reverses it, not this history.
  const pieces = splitComponents(result.mesh);
  // Clay added is added to this body. If it came out as a piece apart from
  // it, it never touched it; making a new body of it, and dropping this
  // one's undo history on the way, was not what was asked.
  if (opts.add && pieces.length > splitComponents(mesh).length) {
    return {
      ok: false, id: targetId,
      error: 'The added clay does not touch the body, so nothing was applied. Start the path on or inside the surface (physics_probe_sculpt finds it).',
      undoDepth: (sculptHistory.get(targetId) ?? []).length,
    };
  }
  if (pieces.length > 1) {
    const bodies = useStore.getState().separateSculpt(targetId, pieces, geomBefore?.name);
    sculptHistory.delete(targetId);
    const error = useStore.getState().lastCompileError;
    return {
      ok: !error, ...(error ? { error } : {}), id: targetId,
      facesBefore: result.facesBefore, facesAfter: pieces[0].faceCount,
      pieces: pieces.length, bodies,
      ...sculptSummary(pieces[0]),
      undoDepth: 0,
    };
  }

  const stack = sculptHistory.get(targetId) ?? [];
  stack.push({ indices: null, positions: null, mesh });
  while (stack.length > SCULPT_HISTORY_DEPTH) stack.shift();
  sculptHistory.set(targetId, stack);

  // Metadata first, geometry second — see SCULPT.
  const latest = useStore.getState();
  latest.updateNode(targetId, { sculptEdited: true, sculptVersion: (live.sculptVersion ?? 1) + 1 });
  const { vertices, renderVertices, faces } = toSceneGeom(result.mesh);
  latest.updateNodeGeom(targetId, { vertices, renderVertices, faces }, geomIndex);

  const error = useStore.getState().lastCompileError;
  return {
    ok: !error, ...(error ? { error } : {}), id: targetId,
    facesBefore: result.facesBefore, facesAfter: result.facesAfter, pieces: result.pieces,
    ...sculptSummary(result.mesh),
    undoDepth: stack.length,
  };
}

export function sculptTarget(store: ReturnType<typeof useStore.getState>, targetId: string): { node: SceneNode; geomIndex: number } {
  if (!targetId) throw new Error('Missing targetId');
  const node = findNodeInScene(store.sceneGraph.nodes, targetId);
  if (!node) throw new Error(`No object with id '${targetId}'`);
  if (node.csgEnabled && !node.isSculpt) {
    throw new Error(`'${targetId}' is a boolean body: its mesh is rebuilt from its primitives on every change, so a stroke would not last. Brush a sculpt body or a mesh instead.`);
  }
  const geomIndex = sculptGeomIndex(node);
  if (geomIndex < 0) {
    throw new Error(`'${targetId}' has no mesh to sculpt - a primitive (box, sphere, cylinder...) is not one. Start from physics_create_sculpt, or import the shape with physics_import_stl.`);
  }
  return { node, geomIndex };
}
