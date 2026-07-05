import { useEffect } from 'react';
import { useStore } from '../store/useStore';

let isInitializing = false;

export const useMuJoCoInit = () => {
  const { mujoco, recompile } = useStore();

  useEffect(() => {
    if (mujoco || isInitializing) return;

    isInitializing = true;

    // Spawns the physics worker (see src/store/physicsWorkerClient.ts) and
    // sends the initial BUILD for whatever scene is currently in the store —
    // the same forced-reset recompile path used by resetSimulation()/preset
    // loading, just run once on first mount.
    recompile(undefined, undefined, true, true).finally(() => {
      isInitializing = false;
    });
  }, []);
};
