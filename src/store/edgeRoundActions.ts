// ---------------------------------------------------------------------------
// The store's edge rounding: a fillet or chamfer session on picked edges,
// and the roundings a body keeps
// ---------------------------------------------------------------------------

import type { SceneGeom, EdgeRoundFeature, RoundEdge } from '../types/scene';
import { withRoundFeature, withoutEdges } from '../utils/edgeRound';
import { hasBooleanOps } from '../utils/csg';
import { cloneSceneGraph, findNode } from './sceneClone';
import { writeEdgeRounds } from './geomEdits';
import type { SliceDeps } from './sliceDeps';

/** A session's roundings: the base, with its draft put in. */
function draftRounds(session: EdgeRoundSession): EdgeRoundFeature[] {
  return withRoundFeature(
    session.base,
    { mode: session.mode, size: session.size, edges: session.picked },
    session.editIndex,
  );
}

export interface EdgeRoundSession {
  nodeId: string;
  /** The body's roundings when the session opened: what Cancel puts back. */
  base: EdgeRoundFeature[];
  /** The rounding being changed, or null for a new one. */
  editIndex: number | null;
  mode: 'fillet' | 'chamfer';
  /** Metres. */
  size: number;
  picked: RoundEdge[];
}

export interface EdgeRoundActions {
  // --- Rounding edges ------------------------------------------------------
  //
  // A fillet or chamfer is a feature on the body (node.edgeRounds); this is
  // the tool that makes one. While a session is open its draft is written
  // straight onto the body, so the real boolean shows the result as the size
  // is dragged, and only Apply leaves an undo step. See utils/edgeRound.ts.
  edgeRoundSession: EdgeRoundSession | null;
  /** Open the tool on a body — on one of its roundings, to change which edges it has. */
  startEdgeRound: (nodeId: string, editIndex?: number) => void;
  updateEdgeRoundDraft: (patch: Partial<Pick<EdgeRoundSession, 'mode' | 'size' | 'picked'>>) => void;
  applyEdgeRound: () => void;
  cancelEdgeRound: () => void;
  /** Change a rounding's size or kind from the inspector. */
  setEdgeRoundFeature: (nodeId: string, index: number, patch: Partial<Pick<EdgeRoundFeature, 'mode' | 'size'>>) => void;
  removeEdgeRoundFeature: (nodeId: string, index: number) => void;
  /** Round edges in one step, for agents: no session, one undo entry. */
  roundEdges: (nodeId: string, feature: EdgeRoundFeature) => void;
  /** The compiler found some rounded edges gone from the part: keep the rest, and say how many went. */
  dropLostEdgeRounds: (nodeId: string, features: EdgeRoundFeature[], lost: number) => void;
  /** Take the rounding off these edges, whichever feature has them. */
  unroundEdges: (nodeId: string, edges: RoundEdge[]) => void;
}

export function edgeRoundActions({ set, get }: SliceDeps): EdgeRoundActions {
  return {
    edgeRoundSession: null,

    startEdgeRound: (nodeId, editIndex) => {
      const open = get().edgeRoundSession;
      if (open) get().cancelEdgeRound();
      const node = findNode(get().sceneGraph.nodes, nodeId);
      if (!node) return;
      const base = node.edgeRounds ?? [];
      const editing = editIndex !== undefined ? base[editIndex] : undefined;
      set({
        edgeRoundSession: {
          nodeId,
          base,
          editIndex: editing ? editIndex! : null,
          mode: editing?.mode ?? 'fillet',
          size: editing?.size ?? 0,
          picked: editing ? [...editing.edges] : [],
        },
        measureMode: null,
      });
    },

    updateEdgeRoundDraft: (patch) => {
      const session = get().edgeRoundSession;
      if (!session) return;
      const next = { ...session, ...patch };
      set({ edgeRoundSession: next });
      writeEdgeRounds(get, set, next.nodeId, draftRounds(next));
    },

    applyEdgeRound: () => {
      const session = get().edgeRoundSession;
      if (!session) return;
      set({ edgeRoundSession: null });
      // One undo step for the whole session: the snapshot is taken of the body as
      // it was before the draft, then the result goes on top of it.
      writeEdgeRounds(get, set, session.nodeId, session.base, false);
      get().prepareForDiscreteChange();
      writeEdgeRounds(get, set, session.nodeId, draftRounds(session));
    },

    cancelEdgeRound: () => {
      const session = get().edgeRoundSession;
      if (!session) return;
      set({ edgeRoundSession: null });
      writeEdgeRounds(get, set, session.nodeId, session.base);
    },

    setEdgeRoundFeature: (nodeId, index, patch) => {
      const node = findNode(get().sceneGraph.nodes, nodeId);
      const feature = node?.edgeRounds?.[index];
      if (!feature) return;
      get().recordInteraction('edge-round');
      const features = [...node!.edgeRounds!];
      features[index] = { ...feature, ...patch };
      writeEdgeRounds(get, set, nodeId, features);
    },

    removeEdgeRoundFeature: (nodeId, index) => {
      const node = findNode(get().sceneGraph.nodes, nodeId);
      if (!node?.edgeRounds?.[index]) return;
      get().prepareForDiscreteChange();
      writeEdgeRounds(get, set, nodeId, node.edgeRounds.filter((_, i) => i !== index));
    },

    roundEdges: (nodeId, feature) => {
      const node = findNode(get().sceneGraph.nodes, nodeId);
      if (!node) return;
      get().prepareForDiscreteChange();
      writeEdgeRounds(get, set, nodeId, withRoundFeature(node.edgeRounds, feature, null));
    },

    dropLostEdgeRounds: (nodeId, features, lost) => {
      // Not an undo step of its own: it is the consequence of the edit that
      // changed the shape, and undoing that edit brings the edges back.
      const newScene = cloneSceneGraph(get().sceneGraph);
      const node = findNode(newScene.nodes, nodeId);
      if (!node) return;
      if (features.length > 0) node.edgeRounds = features; else delete node.edgeRounds;
      node.edgeRoundsLost = (node.edgeRoundsLost ?? 0) + lost;
      if (!hasBooleanOps(node) && node.csgEnabled) {
        node.csgEnabled = false;
        node.geoms = (node.geoms || []).filter((g: SceneGeom) => !g.csgDerived);
        delete node.csgHash;
      }
      set({ sceneGraph: newScene });
      if (!node.csgEnabled) get().recompile(newScene, nodeId, false);
    },

    unroundEdges: (nodeId, edges) => {
      const node = findNode(get().sceneGraph.nodes, nodeId);
      if (!node?.edgeRounds) return;
      get().prepareForDiscreteChange();
      writeEdgeRounds(get, set, nodeId, withoutEdges(node.edgeRounds, edges));
    },
  };
}
