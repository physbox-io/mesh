// Which scene is being opened, for the viewport's "Opening …" pill.
//
// Opening a saved scene can take seconds: the account is asked for it, its
// meshes come down from the blob store, and then the model compiles. Until
// the new scene is drawn nothing on screen said anything was happening.
//
// A store of its own rather than a slice of useStore: it is not part of a
// scene, and editing useStore reloads the app and the scene with it.

import { create } from 'zustand';
import { useStore } from './useStore';

interface SceneLoadState {
  /** The scene being opened, or null. */
  opening: string | null;
  /** Which opening it is, so a second open of the same scene is a new one. */
  id: number;
}

export const useSceneLoad = create<SceneLoadState>(() => ({ opening: null, id: 0 }));

let current = 0;

/** Longest the pill waits for the scene to appear: a load that failed quietly must not leave it up. */
const GIVE_UP_MS = 60_000;

/**
 * Marks `label` as opening while `load` runs and until the scene it swaps in
 * is on screen. `load` returns whether it started a scene swap; false (a fetch
 * that failed, say) takes the pill down at once.
 */
export async function openingScene(label: string, load: () => Promise<boolean> | boolean): Promise<void> {
  const id = ++current;
  useSceneLoad.setState({ opening: label, id });
  // Subscribed before the load, so a swap that finishes quickly is not missed.
  // finishSceneSwap bumps cameraResetToken once the new scene has painted.
  let unsubscribe = () => {};
  const shown = new Promise<void>((resolve) => {
    const start = useStore.getState().cameraResetToken;
    unsubscribe = useStore.subscribe((s) => {
      if (s.cameraResetToken !== start) resolve();
    });
    setTimeout(resolve, GIVE_UP_MS);
  });
  try {
    if (await load()) await shown;
  } finally {
    unsubscribe();
    if (id === current) useSceneLoad.setState({ opening: null });
  }
}
