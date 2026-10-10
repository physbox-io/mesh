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

interface CavityState {
  measured: Record<string, MeasuredCavity>;
  setCavity: (body: string, cavity: MeasuredCavity) => void;
}

export const useCavityStore = create<CavityState>((set) => ({
  measured: {},
  setCavity: (body, cavity) => set((s) => ({ measured: { ...s.measured, [body]: cavity } })),
}));
