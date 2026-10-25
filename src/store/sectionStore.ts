// The section view: whether the drawing views cut the parts, where, and the
// cut the Dims overlay last made, for SectionCut to draw.
//
// A store of its own rather than a slice of useStore: none of it is part of a
// scene, and editing useStore reloads the app and the scene with it.

import { create } from 'zustand';

type Vec3 = [number, number, number];

/** The cut on screen: its plane, and per part the outline and fill of its section. */
export interface DrawnCut {
  /** The plane, document frame: dot(p, normal) = offset. normal is the view's line of sight. */
  normal: Vec3;
  offset: number;
  /** Per part: filled triangles on the plane and its outline loops, flat xyz. */
  parts: { id: string; fill: number[]; loops: Vec3[][] }[];
}

interface SectionState {
  enabled: boolean;
  /** Where to cut, as a share of the parts' depth along the line of sight; null picks the cut that shows most. */
  at: number | null;
  /** Where the last cut was, whichever way it was chosen: what the slider shows. */
  shownAt: number | null;
  cut: DrawnCut | null;
  setEnabled: (enabled: boolean) => void;
  setAt: (at: number | null) => void;
  setCut: (cut: DrawnCut | null, shownAt: number | null) => void;
}

export const useSection = create<SectionState>((set) => ({
  enabled: false,
  at: null,
  shownAt: null,
  cut: null,
  setEnabled: (enabled) => set({ enabled, ...(enabled ? {} : { cut: null, shownAt: null }) }),
  setAt: (at) => set({ at }),
  setCut: (cut, shownAt) => set({ cut, shownAt }),
}));
