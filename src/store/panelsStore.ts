// Which of the app's panels are open: the reference guide and the two side
// drawers.
//
// A store of its own rather than a slice of useStore: none of it is part of a
// scene, useStore is big enough already, and editing useStore reloads the app
// and the scene with it. It is a store at all, rather than App state, because
// the things that open these panels are spread through components App renders
// — the docs (i) buttons sit in property cards all over the inspector, and the
// hierarchy, palette and inspector each close their own drawer.

import { create } from 'zustand';
import type { DocsTabId } from '../utils/docsTabs';

interface PanelsState {
  isDocsOpen: boolean;
  docsTab: DocsTabId;
  openDocs: (tab: DocsTabId) => void;
  setDocsTab: (tab: DocsTabId) => void;
  closeDocs: () => void;
  /**
   * The side drawers. Only read below the `md` (palette) and `lg`
   * (inspector) breakpoints — at desktop width both are permanent columns and
   * these are ignored. The inspector opens only from its toolbar button: on a
   * phone the drawer covers the model, so selecting a body to *see* it would
   * otherwise hide it behind the panel describing it.
   */
  isLeftSidebarOpen: boolean;
  isPropertiesOpen: boolean;
  setLeftSidebarOpen: (open: boolean) => void;
  setPropertiesOpen: (open: boolean) => void;
}

export const usePanels = create<PanelsState>((set) => ({
  isDocsOpen: false,
  docsTab: 'gravity',
  openDocs: (docsTab) => set({ docsTab, isDocsOpen: true }),
  setDocsTab: (docsTab) => set({ docsTab }),
  closeDocs: () => set({ isDocsOpen: false }),
  isLeftSidebarOpen: false,
  isPropertiesOpen: false,
  setLeftSidebarOpen: (isLeftSidebarOpen) => set({ isLeftSidebarOpen }),
  setPropertiesOpen: (isPropertiesOpen) => set({ isPropertiesOpen }),
}));
