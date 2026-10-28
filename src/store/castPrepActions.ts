// ---------------------------------------------------------------------------
// The store's Cast prep: draft and rounded edges baked into the scene for
// casting, the edit guard that protects them, and taking them off again
// ---------------------------------------------------------------------------

import type { EdgeRoundFeature, CastPrep } from '../types/scene';
import { bakeDraftInto, copyPrep, restoreShape, shapeSignature, unprepScene, type DraftParams } from '../utils/castPrep';
import { cloneSceneGraph, findNode } from './sceneClone';
import { withCastPrepBypass } from './editGuard';
import { rebuildBooleansAfterRestore, setNodeEdgeRounds } from './geomEdits';
import type { SliceDeps } from './sliceDeps';

export interface CastPrepActions {
  // --- Prepare for casting (utils/castPrep.ts, driven by castPrepRunner) ---
  /** What the running prep is doing, for the modal; null when none is running. */
  castPrepBusy: string | null;
  setCastPrepBusy: (busy: string | null) => void;
  /** The guard modal: an edit was turned away because draft is baked in. */
  castPrepGuardOpen: boolean;
  /** Counts edits the guard turned away, so a caller can tell its own was one. */
  castPrepBlocked: number;
  closeCastPrepGuard: () => void;
  /** Starts prep: one undo step for all of it, and the originals on the graph. */
  beginCastPrep: (prep: CastPrep) => void;
  /** Puts prep's roundings on, no undo step of its own. The caller compiles them. */
  writeCastPrepEdges: (features: Record<string, EdgeRoundFeature[]>) => void;
  /** Bodies whose roundings would not compile: back to how they were, still in prep for draft. */
  revertCastPrepEdges: (failed: { id: string; reason: string }[]) => void;
  /** Bakes draft into every prepped body. */
  bakeCastPrepDraft: (params: DraftParams) => void;
  /** Records what prep did, and fingerprints each body as prep left it. */
  finishCastPrep: (patch: Partial<Pick<CastPrep, 'edges' | 'sharpEdges'>>) => void;
  /** Switches prep off: each body nobody has changed since gets its originals back. */
  clearCastPrep: () => { restored: string[]; kept: { id: string; name: string }[] };
  /** Keeps the prepped shapes as the model, and forgets the originals. */
  bakeCastPrep: () => void;
}

export function castPrepActions({ set, get }: SliceDeps): CastPrepActions {
  return {
    castPrepBusy: null,

    setCastPrepBusy: (busy) => set({ castPrepBusy: busy }),

    castPrepGuardOpen: false,

    castPrepBlocked: 0,

    closeCastPrepGuard: () => set({ castPrepGuardOpen: false }),

    beginCastPrep: (prep) => {
      get().prepareForDiscreteChange();
      const newScene = cloneSceneGraph(get().sceneGraph);
      newScene.castPrep = prep;
      set({ sceneGraph: newScene });
    },

    writeCastPrepEdges: (features) => {
      const newScene = cloneSceneGraph(get().sceneGraph);
      for (const [id, list] of Object.entries(features)) {
        const node = findNode(newScene.nodes, id);
        if (node) setNodeEdgeRounds(node, list);
      }
      set({ sceneGraph: newScene });
    },

    revertCastPrepEdges: (failed) => {
      const sg = get().sceneGraph;
      if (!sg.castPrep || failed.length === 0) return;
      const newScene = cloneSceneGraph(sg);
      const prep = copyPrep(sg.castPrep);
      for (const { id, reason } of failed) {
        const node = findNode(newScene.nodes, id);
        const entry = prep.originals[id];
        if (!node || !entry) continue;
        restoreShape(node, entry.shape);
        prep.skipped.push({ nodeId: id, name: node.name, reason });
      }
      newScene.castPrep = prep;
      set({ sceneGraph: newScene });
    },

    bakeCastPrepDraft: (params) => {
      const sg = get().sceneGraph;
      if (!sg.castPrep) return;
      const newScene = cloneSceneGraph(sg);
      const prep = copyPrep(sg.castPrep);
      bakeDraftInto(newScene, prep, params);
      prep.draftDeg = params.deg;
      prep.draftMode = params.mode;
      prep.partingZ = params.partingZ;
      newScene.castPrep = prep;
      set({ sceneGraph: newScene });
      get().recompile(newScene, undefined, true);
    },

    finishCastPrep: (patch) => {
      const sg = get().sceneGraph;
      if (!sg.castPrep) return;
      const newScene = cloneSceneGraph(sg);
      const prep = { ...copyPrep(sg.castPrep), ...patch };
      for (const [id, entry] of Object.entries(prep.originals)) {
        const node = findNode(newScene.nodes, id);
        if (node) entry.signature = shapeSignature(node);
      }
      newScene.castPrep = prep;
      set({ sceneGraph: newScene });
    },

    clearCastPrep: () => withCastPrepBypass(() => {
      const sg = get().sceneGraph;
      if (!sg.castPrep) return { restored: [], kept: [] };
      get().prepareForDiscreteChange();
      const newScene = cloneSceneGraph(sg);
      const result = unprepScene(newScene);
      set({ sceneGraph: newScene, castPrepGuardOpen: false });
      get().recompile(newScene, undefined, true);
      // A restored boolean comes back with the mesh it had; one whose mesh the
      // compiler since replaced is rebuilt here rather than left to chance.
      rebuildBooleansAfterRestore();
      return result;
    }),

    bakeCastPrep: () => withCastPrepBypass(() => {
      const sg = get().sceneGraph;
      if (!sg.castPrep) return;
      // Not an undo step of its own. Baking changes no shape, only forgets the
      // originals, so a step for it undid to a scene that looked identical and
      // took a second Ctrl+Z to see anything happen. One undo now goes straight
      // back to before the prep, which is the step the person can see.
      get().flushPendingUndo();
      const newScene = cloneSceneGraph(sg);
      delete newScene.castPrep;
      set({ sceneGraph: newScene, castPrepGuardOpen: false });
    }),
  };
}
