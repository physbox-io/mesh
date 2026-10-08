// The viewport's Hi-Res switch, in the settings panel.
//
// Hi-Res holds the rendering that costs frame time: MSAA on the composer, the
// tone-mapping pass, and the finer tessellation of curved primitives. Off, the
// viewport goes back to the cheaper settings it had before those were added.
// The lighting and materials stay as they are either way; they cost nothing per
// frame.
//
// A store of its own rather than a slice of useStore: it is a per-machine
// display preference, not part of a scene, and editing useStore reloads the app
// and the scene with it.

import { create } from 'zustand';

const STORAGE_KEY = 'mesh_hi_res';

function readHiRes(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

interface ViewQualityState {
  hiRes: boolean;
  setHiRes: (hiRes: boolean) => void;
}

export const useViewQuality = create<ViewQualityState>((set) => ({
  hiRes: readHiRes(),
  setHiRes: (hiRes) => {
    try {
      localStorage.setItem(STORAGE_KEY, String(hiRes));
    } catch {
      // Private window or blocked storage: the switch still works for this session.
    }
    set({ hiRes });
  },
}));
