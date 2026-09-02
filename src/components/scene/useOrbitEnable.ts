import { useCallback } from 'react';
import { useThree } from '@react-three/fiber';

/**
 * Switches the orbit controls off and on from inside a pointer handler.
 *
 * Dragging something in the scene already disables the controls through their
 * `enabled` prop, but that only takes effect on the next render — fine for a
 * mouse, whose left button does nothing to the camera in this app, and not
 * fine for a finger, whose single-touch gesture *is* the orbit gesture. Called
 * during the pointerdown itself, this makes the controls see `enabled ===
 * false` when their own listener runs a moment later, so the body drags
 * instead of the camera swinging.
 *
 * Reads through R3F's `get()` rather than holding the controls in a render
 * value, so the instance is always the live one (they register themselves via
 * `makeDefault` after the scene's meshes have already mounted).
 */
export const useOrbitEnable = () => {
  const getThree = useThree((state) => state.get);
  return useCallback((on: boolean) => {
    const controls = getThree().controls as { enabled?: boolean } | null;
    if (controls) controls.enabled = on;
  }, [getThree]);
};

