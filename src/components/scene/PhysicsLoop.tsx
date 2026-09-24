import { useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { getPhysicsWorkerClient } from '../../store/useStore';
import { physicsGlobals } from '../../physicsGlobals';

// Physics Step Hook
//
// Actual physics stepping, script execution (incl. aerodynamics), free-joint
// damping, drag-force application, and history recording now all live in the
// dedicated physics worker (src/workers/physicsWorker.ts) so that on
// unrecoverable WASM memory exhaustion the worker can be terminated and a
// fresh one spawned — a real memory reclaim. This component's only remaining
// job is forwarding keyboard state to the worker, since scripts' `isKeyPressed`
// needs it and the worker has no DOM access of its own.
export const PhysicsLoop = ({ isPlaying }: { model: unknown, data: unknown, mujoco: unknown, isPlaying: boolean }) => {
  useFrame((_state, delta) => {
    if (physicsGlobals.DISABLE_USEFRAME) return;
    if (!isPlaying) return;
    if (typeof SharedArrayBuffer === 'undefined') {
      getPhysicsWorkerClient().tick(delta);
    }
  });

  useEffect(() => {
    const pressedKeys = new Set<string>();
    const sync = () => getPhysicsWorkerClient().setKeys(Array.from(pressedKeys));

    const handleKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (active && (
        active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.getAttribute('contenteditable') === 'true'
      )) {
        return;
      }
      pressedKeys.add(e.key.toLowerCase());
      pressedKeys.add(e.code.toLowerCase());
      sync();
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      pressedKeys.delete(e.key.toLowerCase());
      pressedKeys.delete(e.code.toLowerCase());
      sync();
    };

    const handleBlur = () => {
      pressedKeys.clear();
      sync();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  return null;
};
