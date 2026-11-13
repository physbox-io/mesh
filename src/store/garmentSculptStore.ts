// The tools that work on a garment in the viewport: the sculpting brush, the
// pen that draws curves on it, and the hand that arranges it. Which garment, which tool, and their
// settings. View state, not part of a scene: what they do is saved in the
// draft (`sculpt` dabs, `curves`).

import { create } from 'zustand';
import type { GarmentCurve } from '../types/cloth';

export type GarmentTool = 'sculpt' | 'draw' | 'arrange';

interface GarmentSculptState {
  /** Id of the garment node being worked on, or null when no tool is on. */
  target: string | null;
  tool: GarmentTool;
  /** Brush radius, metres. */
  radius: number;
  /** How far a stroke pushes the cloth out (or draws it in), metres. */
  strength: number;
  /** Draw in rather than push out (Shift flips it while held). */
  pull: boolean;
  /** Each stroke also on the other side. */
  mirror: boolean;
  /** What a drawn curve is. */
  curveKind: GarmentCurve['kind'];
  set: (patch: Partial<Omit<GarmentSculptState, 'set'>>) => void;
}

export const useGarmentSculpt = create<GarmentSculptState>((set) => ({
  target: null,
  tool: 'sculpt',
  radius: 0.08,
  strength: 0.03,
  pull: false,
  mirror: true,
  curveKind: 'seam',
  set: (patch) => set(patch),
}));
