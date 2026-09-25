import { useEffect, useSyncExternalStore } from 'react';
import { ensureModifierKeys, modifiers, subscribeModifiers } from '../utils/modifierKeys';

/**
 * Re-renders when Alt (or Shift) goes down or up. See utils/modifierKeys for
 * why there is one tracker for the app; handlers that only need the state at
 * the moment of a drag should call modifiers() instead of this.
 */
export function useModifier(key: 'alt' | 'shift'): boolean {
  useEffect(ensureModifierKeys, []);
  return useSyncExternalStore(subscribeModifiers, () => modifiers()[key], () => false);
}
