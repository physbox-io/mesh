// Kept in a module of its own, importing nothing but types, so that every
// exporter can ask it without pulling in the hardware builders — and without
// the import cycle that would close through utils/laserCutExporter.ts.

import type { SceneNode } from '../types/scene';

/** Bought, not made: drawn and simulated, never exported for making or analysed as made. */
export function isBoughtIn(node: SceneNode): boolean {
  return !!node.hardwarePart;
}
