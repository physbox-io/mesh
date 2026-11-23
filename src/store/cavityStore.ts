// Cavities measured with "Measure cavity", by body name.
//
// Kept out of the scene graph: a measurement is read off the body's mesh, not
// a property of it, and writing it onto the node would rebuild the MuJoCo
// model, which under a linked Volt resets the scene mid-run. A linked Volt
// reads these as `body:<name>.cavityVolume`, `.portLength` and `.portRadius`
// (see cavityChannels in utils/coSimLink.ts). Transient, like a dent: measure
// again after a reload, or after editing the body.

import { create } from 'zustand';
import type { MeasuredCavity } from '../utils/coSimLink';
import type { SceneNode } from '../types/scene';
import { useStore } from './useStore';

interface CavityState {
  measured: Record<string, MeasuredCavity>;
  setCavity: (body: string, cavity: MeasuredCavity) => void;
  clear: () => void;
  pruneToNodes: (validNames: Iterable<string>) => void;
}

export const useCavityStore = create<CavityState>((set) => ({
  measured: {},
  setCavity: (body, cavity) => set((s) => ({ measured: { ...s.measured, [body]: cavity } })),
  clear: () => set((s) => (Object.keys(s.measured).length === 0 ? s : { measured: {} })),
  pruneToNodes: (validNames) =>
    set((s) => {
      const keys = Object.keys(s.measured);
      if (keys.length === 0) return s;
      const keep = validNames instanceof Set ? validNames : new Set(validNames);
      let changed = false;
      const next: Record<string, MeasuredCavity> = {};
      for (const k of keys) {
        if (keep.has(k)) next[k] = s.measured[k];
        else changed = true;
      }
      return changed ? { measured: next } : s;
    }),
}));

export function clearCavities(): void {
  useCavityStore.getState().clear();
}

function collectNodeKeys(nodes: SceneNode[] | undefined, out = new Set<string>()): Set<string> {
  for (const n of nodes || []) {
    if (n.name) out.add(n.name);
    if (n.id) out.add(n.id);
    if (n.children?.length) collectNodeKeys(n.children, out);
  }
  return out;
}

// Keep measured cavities in sync with the active scene so stale measurements
// never leak across scene swaps or deleted bodies.
useStore.subscribe((state, prev) => {
  if (state.activePreset !== prev.activePreset || state.sceneGraph.name !== prev.sceneGraph.name) {
    useCavityStore.getState().clear();
    return;
  }
  if (state.sceneGraph !== prev.sceneGraph) {
    useCavityStore.getState().pruneToNodes(collectNodeKeys(state.sceneGraph.nodes));
  }
});
