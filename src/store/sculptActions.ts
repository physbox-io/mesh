// ---------------------------------------------------------------------------
// The store's sculpt mode: the body being sculpted, its brush, base and size,
// and separating a sculpt into the pieces it has come apart into
// ---------------------------------------------------------------------------

import type { SceneNode, SceneGeom, SceneJoint } from '../types/scene';
import { DEFAULT_BRUSH, fromSceneGeom, toSceneGeom, type BrushSettings, type SculptMesh } from '../utils/sculptMesh';
import {
  buildSculptBaseSized, DEFAULT_SCULPT_SIZE, longestSide, resizeSculptMesh, resizeSculptMeshAxes,
  type SculptBaseId,
} from '../utils/sculptBases';
import { cloneSceneGraph, findNode } from './sceneClone';
import { getPhysicsWorkerClient } from './physicsEngine';
import { dropStaleColliders } from './geomEdits';
import type { SliceDeps } from './sliceDeps';

export interface SculptActions {
  // --- Sculpting ----------------------------------------------------------
  /** The body being sculpted, or null when the sculpt tools are closed. */
  sculptNodeId: string | null;
  /** The brush the sculpt tools are holding. */
  sculptBrush: BrushSettings;
  /** Live vertex/face counts and watertightness of the mesh being sculpted. */
  sculptStats: { vertices: number; faces: number; watertight: boolean; atBudget: boolean; pieces?: number } | null;
  setSculptNodeId: (id: string | null) => void;
  setSculptStats: (stats: { vertices: number; faces: number; watertight: boolean; atBudget: boolean; pieces?: number } | null) => void;
  /**
   * What the scissors are doing, for the panel: a cut in progress, or why the
   * last one was refused. The cut runs in a worker, so neither shows up in the
   * viewport on its own.
   */
  sculptNotice: { text: string; tone: 'busy' | 'error' | 'info' } | null;
  setSculptNotice: (notice: { text: string; tone: 'busy' | 'error' | 'info' } | null) => void;
  /** Replaces a sculpt body's mesh with a different base shape, discarding the old one. */
  setSculptBase: (nodeId: string, base: SculptBaseId) => void;
  /**
   * Scales a sculpt body's mesh about its origin: to `size` metres on its
   * longest side, or with [x, y, z] (null keeps an axis) to that size on each.
   */
  resizeSculpt: (nodeId: string, size: number | (number | null)[]) => void;
  setSculptBrush: (patch: Partial<BrushSettings>) => void;
  /**
   * Makes a sculpt that is in several pieces one body per piece, as one undo
   * step. `pieces` is the mesh already split, largest first: the first stays
   * on this body, in the geom named `geomName` (default: its sculpt mesh), and
   * each of the rest becomes a new sculpt body beside it, at the same pose and
   * in the same frame, so nothing moves. Returns every body's id, this one first.
   */
  separateSculpt: (nodeId: string, pieces: SculptMesh[], geomName?: string) => string[];
}

export function sculptActions({ set, get }: SliceDeps): SculptActions {
  return {
    sculptNodeId: null,

    sculptBrush: DEFAULT_BRUSH,

    // Sculpting a body that is being simulated means chasing it around the scene,
    // so entering the tools pauses the sim. Leaving them does not restart it —
    // that is the user's call, and starting a sim behind someone's back is how a
    // half-finished shape ends up on the floor.
    sculptStats: null,

    // The worker is told as well as the UI. With shared memory it runs its own
    // step loop, and flipping only the store's flag showed "paused" while the
    // body went on falling under the brush.
    setSculptNodeId: (id) => {
      if (id && typeof Worker !== 'undefined') getPhysicsWorkerClient().setPlaying(false);
      set(id
        ? { sculptNodeId: id, latticeNodeId: null, selectedNodeId: id, isPlaying: false, sculptNotice: null }
        : { sculptNodeId: null, sculptStats: null, sculptNotice: null });
    },

    setSculptStats: (stats) => set({ sculptStats: stats }),

    sculptNotice: null,

    setSculptNotice: (notice) => set({ sculptNotice: notice }),

    // Wholesale replacement, not an edit: the version bump is what tells the
    // viewport to load the new mesh rather than carry on with the one it holds.
    // At the size the body already is, so swapping a base never jumps in scale.
    setSculptBase: (nodeId, base) => {
      const node = findNode(get().sceneGraph.nodes, nodeId);
      const geomIndex = Math.max(0, (node?.geoms ?? []).findIndex((g: SceneGeom) => g.type === 'mesh'));
      const old = node?.geoms?.[geomIndex];
      const size = old?.renderVertices?.length && old.faces?.length
        ? longestSide(fromSceneGeom(old.renderVertices, old.faces))
        : DEFAULT_SCULPT_SIZE;
      const mesh = buildSculptBaseSized(base, size || DEFAULT_SCULPT_SIZE);
      const { vertices, renderVertices, faces } = toSceneGeom(mesh);
      get().updateNodeGeom(nodeId, { vertices, renderVertices, faces }, geomIndex);
      get().updateNode(nodeId, {
        sculptBase: base,
        sculptVersion: (node?.sculptVersion ?? 1) + 1,
        sculptEdited: false,
      });
    },

    resizeSculpt: (nodeId, size) => {
      const node = findNode(get().sceneGraph.nodes, nodeId);
      const geomIndex = (node?.geoms ?? []).findIndex((g: SceneGeom) => g.type === 'mesh' && !g.csgDerived);
      const geom = geomIndex >= 0 ? node!.geoms[geomIndex] : undefined;
      if (!geom?.renderVertices?.length || !geom.faces?.length) return;
      const source = fromSceneGeom(geom.renderVertices, geom.faces);
      const mesh = Array.isArray(size) ? resizeSculptMeshAxes(source, size) : resizeSculptMesh(source, size);
      get().updateNodeGeom(nodeId, toSceneGeom(mesh), geomIndex);
      get().updateNode(nodeId, { sculptVersion: (node?.sculptVersion ?? 1) + 1 });
    },

    setSculptBrush: (patch) => set((state) => ({ sculptBrush: { ...state.sculptBrush, ...patch } })),

    separateSculpt: (nodeId, pieces, geomName) => {
      const node = findNode(get().sceneGraph.nodes, nodeId);
      if (!node || pieces.length === 0) return [nodeId];
      get().prepareForDiscreteChange();
      const newScene = cloneSceneGraph(get().sceneGraph);
      const first = findNode(newScene.nodes, nodeId);
      if (!first) return [nodeId];

      const index = (() => {
        const byName = geomName ? (first.geoms ?? []).findIndex((g: SceneGeom) => g.name === geomName) : -1;
        return byName >= 0 ? byName : Math.max(0, (first.geoms ?? []).findIndex((g: SceneGeom) => g.type === 'mesh' && !g.csgDerived));
      })();
      const template = first.geoms[index];
      Object.assign(template, toSceneGeom(pieces[0]));
      dropStaleColliders(first);
      first.sculptEdited = true;
      first.sculptVersion = (first.sculptVersion ?? 1) + 1;

      // The list the original hangs in, so the pieces hang from the same parent
      // and the copied pose means the same thing.
      const siblings = (() => {
        const walk = (list: SceneNode[]): SceneNode[] | null => {
          for (const n of list) {
            if (n.id === nodeId) return list;
            const found = walk(n.children || []);
            if (found) return found;
          }
          return null;
        };
        return walk(newScene.nodes) ?? newScene.nodes;
      })();
      const at = siblings.indexOf(first);

      const ids = [nodeId];
      pieces.slice(1).forEach((piece, k) => {
        const id = `sculpt_${Math.random().toString(36).substring(2, 10)}`;
        ids.push(id);
        /*
          A copy of the body with nothing but the piece in it: same pose, same
          joints (renamed, since MuJoCo names are global), same material, and
          the mesh in the same frame, so the piece stays exactly where it was
          cut. Its own children, colliders and cuts stay with the original.
        */
        const { children: _children, geoms: _geoms, ...rest } = first;
        void _children; void _geoms;
        const copy: SceneNode = JSON.parse(JSON.stringify(rest));
        siblings.splice(at + 1 + k, 0, {
          ...copy,
          id,
          // Named by its id, as separateLattice does: the viewport finds a
          // body in the model by id, and the model names bodies by name.
          name: id,
          joints: (first.joints || []).map((j: SceneJoint) => ({ ...j, name: `${id}_${String(j.name || 'joint').split('_').pop()}` })),
          isSculpt: true,
          sculptEdited: true,
          sculptVersion: 1,
          // Not the original's links to other bodies, or its script: a piece
          // cut off a welded handle is not welded to anything.
          weldTargetId: undefined,
          coupleTargetId: undefined,
          connectTargetId: undefined,
          script: undefined,
          collisionDecomposed: undefined,
          collisionHash: undefined,
          // Paint is per vertex, and these are different vertices.
          geoms: [{ ...JSON.parse(JSON.stringify(template)), name: `${id}_mesh`, paint: undefined, ...toSceneGeom(piece) }],
          children: [],
        });
      });
      set({ sceneGraph: newScene, extraSelectedIds: [] });
      get().recompile(newScene, undefined, true);
      return ids;
    },
  };
}
