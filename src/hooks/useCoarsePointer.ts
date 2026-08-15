import { useEffect, useState } from 'react';

/**
 * True when the primary pointer is a fingertip rather than a cursor.
 *
 * This exists to size hit targets, and nothing else. A mouse can land on a
 * one-pixel control handle and a finger covers about 9 mm of screen — and,
 * unlike a cursor, the finger hides the thing it is aiming at — so draggable
 * handles are drawn larger on a touch device. Everything about the model —
 * coordinates, units, what a gesture means — is identical either way, so this
 * must never be used to make a *behavioural* decision, only a dimensional one.
 *
 * `(pointer: coarse)` describes the primary input, not the screen: a small
 * window on a desktop is still a mouse and keeps the small handles, and a
 * tablet keeps the large ones however wide it is held.
 */
export const useCoarsePointer = (): boolean => {
  const [coarse, setCoarse] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
  );

  useEffect(() => {
    const mq = window.matchMedia('(pointer: coarse)');
    const onChange = () => setCoarse(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return coarse;
};
