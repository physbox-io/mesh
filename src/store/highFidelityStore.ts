// The High Fidelity switch, in the settings panel: molds sampled twice as fine,
// for a printer with a nozzle that can show it.
//
// A store of its own, and remembered per machine, because it follows the
// printer on the bench rather than any one scene. MCP mold commands read it too,
// unless they say otherwise.

import { create } from 'zustand';

const STORAGE_KEY = 'mesh_high_fidelity';

function readHighFidelity(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

interface HighFidelityState {
  highFidelity: boolean;
  setHighFidelity: (on: boolean) => void;
}

export const useHighFidelity = create<HighFidelityState>((set) => ({
  highFidelity: readHighFidelity(),
  setHighFidelity: (highFidelity) => {
    try {
      localStorage.setItem(STORAGE_KEY, String(highFidelity));
    } catch {
      // Private window or blocked storage: the switch still works for this session.
    }
    set({ highFidelity });
  },
}));
