// How much of each body the hierarchy lists. A store of its own: it is view
// state, not part of a scene, and both the tree and the inspector's
// sub-geometry picker read it.

import { create } from 'zustand';

interface TreeViewState {
  /**
   * List geoms marked `internal` (made by a builder, such as a dress form's
   * forty primitives) as well as authored ones. Off by default.
   */
  showInternalParts: boolean;
  setShowInternalParts: (show: boolean) => void;
}

export const useTreeView = create<TreeViewState>((set) => ({
  showInternalParts: false,
  setShowInternalParts: (show) => set({ showInternalParts: show }),
}));
