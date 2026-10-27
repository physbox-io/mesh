// ---------------------------------------------------------------------------
// The store's Duplicate, Copy and Paste
//
// Copy keeps a snapshot here in the page, not on the system clipboard: a body
// with meshes in it runs to megabytes, and nothing outside the app can use it.
// It outlives a scene change, so a part can be copied out of one scene and
// pasted into another. Copies land in the middle of the view, clear of what is
// there, so pasting three times gives a row of three rather than three in one
// place; a part copied out of an assembly goes back beside it instead.
// ---------------------------------------------------------------------------

import type { SceneGraph, SceneNode } from '../types/scene';
import { copyBodies, pasteBodies, type Clipboard } from '../utils/duplicateNodes';
import { viewCentre } from '../utils/liveCamera';
import type { PhysicsState } from './useStore';

export interface ClipboardActions {
  /** Copies the selected bodies into the middle of the view, and selects the copies. */
  duplicateSelection: () => string[];
  /** Keeps the selected bodies for Paste. False when nothing is selected. */
  copySelection: () => boolean;
  /** Puts the copied bodies into the middle of the view, and selects them. */
  pasteClipboard: () => string[];
}

interface Deps {
  set: (partial: Partial<PhysicsState>) => void;
  get: () => PhysicsState;
  clone: (scene: SceneGraph) => SceneGraph;
}

let clipboard: Clipboard | null = null;
let pastes = 0;

export function clipboardActions({ set, get, clone }: Deps): ClipboardActions {
  const cloneNodes = (nodes: SceneNode[]) => clone({ nodes } as SceneGraph).nodes;
  const selection = () => {
    const s = get();
    return [...(s.selectedNodeId ? [s.selectedNodeId] : []), ...s.extraSelectedIds];
  };
  const place = (board: Clipboard, times: number) => {
    get().prepareForDiscreteChange();
    const scene = clone(get().sceneGraph);
    const ids = pasteBodies(scene, board, times, cloneNodes, viewCentre());
    if (!ids.length) return ids;
    set({ sceneGraph: scene, selectedNodeId: ids[0], extraSelectedIds: ids.slice(1) });
    void get().recompile(get().sceneGraph, ids[0], false);
    return ids;
  };

  return {
    duplicateSelection: () => {
      const board = copyBodies(get().sceneGraph, selection(), cloneNodes);
      return board ? place(board, 1) : [];
    },

    copySelection: () => {
      const board = copyBodies(get().sceneGraph, selection(), cloneNodes);
      if (!board) return false;
      clipboard = board;
      pastes = 0;
      return true;
    },

    pasteClipboard: () => {
      if (!clipboard) return [];
      pastes += 1;
      return place(clipboard, pastes);
    },
  };
}
