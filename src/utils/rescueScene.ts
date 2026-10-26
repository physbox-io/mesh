import type { SceneGraph } from '../types/scene';
// Type-only: physicsGlobals imports the store, and the store imports this.
import type { PhysicsGlobals } from '../physicsGlobals';
import { packMeshArrays } from './meshPacking';
import { exportBaseName } from './exportBaseName';

/**
 * Downloads the scene as the store holds it, with its note cards and chat, for
 * when the app is going down: a render crash, or a physics engine that has to
 * be reloaded away. Not the simulated pose, which needs MuJoCo — often what
 * broke. Takes the graph rather than reading the store, so the store can call
 * it without importing itself back.
 */
export function downloadSceneRescue(sceneGraph: SceneGraph, activePreset: string | undefined): void {
  const physicsGlobals = window as unknown as PhysicsGlobals;
  const noteCards = physicsGlobals._physics_getNoteCards?.() ?? [];
  const copilotMessages = physicsGlobals._physics_getCopilotMessages?.() ?? [];
  const text = JSON.stringify(packMeshArrays({ ...sceneGraph, noteCards, copilotMessages }), null, 2);
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${exportBaseName(noteCards, activePreset)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

let unloadAllowed = false;

/** A reload the user has already said yes to: the close-tab question is not asked again. */
export function allowUnload(): void {
  unloadAllowed = true;
}

export function unloadIsAllowed(): boolean {
  return unloadAllowed;
}
