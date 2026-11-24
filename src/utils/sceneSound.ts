import type { SceneNode } from '../types/scene';

/**
 * Whether a scene is built to be heard: any body carrying an instrument
 * spec (string, membrane, bore, plate, resonator, bow) or a tuned pitch.
 *
 * Collisions sound in every scene, so they say nothing; these fields only
 * exist on bodies that were made to play.
 */
export function sceneHasInstruments(nodes: readonly SceneNode[] | null | undefined): boolean {
  if (!nodes) return false;
  for (const n of nodes) {
    if (
      typeof n.tunedPitchHz === 'number' ||
      n.acousticString ||
      n.acousticMembrane ||
      n.windInstrument ||
      n.nonlinearPlate ||
      n.resonatorTube ||
      n.acousticBow
    ) {
      return true;
    }
    if (n.children?.length && sceneHasInstruments(n.children)) return true;
  }
  return false;
}
