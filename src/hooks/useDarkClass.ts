import { useSyncExternalStore } from 'react';

/**
 * Whether the page is in dark mode, read from the `dark` class useDarkMode puts
 * on <html> — for components deep in the scene that the darkMode prop does not
 * reach. One observer is shared by every subscriber, so a scene full of bodies
 * does not attach one each.
 */
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!observer) {
    observer = new MutationObserver(() => listeners.forEach((l) => l()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      observer?.disconnect();
      observer = null;
    }
  };
}

const isDark = () => document.documentElement.classList.contains('dark');

export function useDarkClass(): boolean {
  return useSyncExternalStore(subscribe, isDark, () => false);
}
