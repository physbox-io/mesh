import { useEffect, type RefObject } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Provides modal dialog accessibility: saves and restores focus on open/close,
 * moves initial focus inside the dialog if focus is outside, and traps Tab/Shift+Tab.
 */
export function useDialogA11y(ref: RefObject<HTMLElement | null>, isOpen = true): void {
  useEffect(() => {
    if (!isOpen) return;
    const prevFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const container = ref.current;
    if (container && !container.contains(document.activeElement)) {
      const first = container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      if (first) first.focus();
      else {
        if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
        container.focus();
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !ref.current) return;
      const nodes = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (nodes.length === 0) {
        e.preventDefault();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !ref.current.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !ref.current.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (prevFocused && prevFocused.isConnected) prevFocused.focus();
    };
  }, [ref, isOpen]);
}
