// The Draft tab's and MCP's end of addDraftToBodies (castPrep.ts): the part
// tapered to pull straight up as it stands, baked in as one undo step.

import { useStore } from '../store/useStore';
import { cloneSceneGraph } from '../store/sceneClone';
import { addDraftToBodies, type AddDraftResult } from './castPrep';

export const MAX_ADD_DRAFT_DEG = 15;

export function applyAddDraft(ids: string[], deg: number, mode: 'add' | 'remove'): AddDraftResult & { error?: string } {
  const store = useStore.getState();
  const d = Math.max(0, Math.min(MAX_ADD_DRAFT_DEG, deg));
  if (!(d > 0)) return { drafted: [], skipped: [], partingZ: 0, error: 'Draft must be more than 0°.' };
  const scene = cloneSceneGraph(store.sceneGraph);
  const result = addDraftToBodies(scene, ids, d, mode);
  if (!result.drafted.length) {
    return { ...result, error: result.skipped.length ? result.skipped.map((s) => `${s.name}: ${s.reason}`).join(' ') : 'There is no solid part to draft.' };
  }
  // Only the bodies change, so everything else the scene says about itself stays.
  store.updateScene({ ...store.sceneGraph, nodes: scene.nodes });
  return result;
}
