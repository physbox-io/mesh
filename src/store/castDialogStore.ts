// What the Mold dialog remembers between openings: the tab last used for each
// scene, and the material and settings last used on each tab.
//
// A store of its own, like panelsStore: none of it is part of a scene, and a
// person who casts aluminium lands on the Sand tab with aluminium chosen every
// time after the first. Kept in localStorage, so it outlives a reload; every
// read and write is guarded, because storage can be missing or full.

import { create } from 'zustand';
import type { CastMaterialId } from '../utils/castMaterials';
import type { MoldTab } from '../utils/moldTabs';

interface Remembered {
  /** Scene key → the tab last used on it. */
  tabByScene: Record<string, MoldTab>;
  /** Per tab, and 'pour' for what the Cast button pours into a mold. */
  materialByTab: Partial<Record<MoldTab | 'pour', CastMaterialId>>;
}

interface CastDialogState extends Remembered {
  /** The tab the next opening should land on, and whether Advanced starts open; taken once. */
  request: { tab: MoldTab; advanced: boolean } | null;
  requestTab: (request: { tab: MoldTab; advanced: boolean }) => void;
  takeRequest: () => { tab: MoldTab; advanced: boolean } | null;
  rememberTab: (sceneKey: string, tab: MoldTab) => void;
  rememberMaterial: (tab: MoldTab | 'pour', material: CastMaterialId) => void;
}

const KEY = 'mesh.castDialog.v1';

function load(): Remembered {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Remembered>;
      return { tabByScene: parsed.tabByScene ?? {}, materialByTab: parsed.materialByTab ?? {} };
    }
  } catch {
    // No storage, or something unreadable in it: start fresh.
  }
  return { tabByScene: {}, materialByTab: {} };
}

function save(state: Remembered) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ tabByScene: state.tabByScene, materialByTab: state.materialByTab }));
  } catch {
    // Not remembered this time; nothing else depends on it.
  }
}

export const useCastDialog = create<CastDialogState>((set, get) => ({
  ...load(),
  request: null,
  requestTab: (request) => set({ request }),
  takeRequest: () => {
    const r = get().request;
    if (r) set({ request: null });
    return r;
  },
  rememberTab: (sceneKey, tab) => {
    set({ tabByScene: { ...get().tabByScene, [sceneKey]: tab } });
    save(get());
  },
  rememberMaterial: (tab, material) => {
    set({ materialByTab: { ...get().materialByTab, [tab]: material } });
    save(get());
  },
}));
