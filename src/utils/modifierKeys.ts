/**
 * Which modifier keys are down right now, for the whole app.
 *
 * Alt means "don't snap" everywhere: the gizmo's floor and mate snaps, the
 * lattice grid, the 10 mm stops on the sliders. Each of those used to track
 * the key for itself, or read it off pointer events only, and they disagreed —
 * the gizmo's own tracker never heard the keyup that Alt-Tab swallows, so
 * snapping stayed off until the next keypress. One tracker, fed by keys AND
 * pointer events (a pointer event carries the true state even when a key event
 * was missed), and cleared when the window loses focus.
 *
 * A plain module rather than store state: it changes on every Alt press, and
 * the handlers that care read it at the moment of a drag, not through a render.
 * Components that do need to re-render on it use useModifier (hooks/).
 */

export interface ModifierState {
  alt: boolean;
  shift: boolean;
}

let state: ModifierState = { alt: false, shift: false };
const listeners = new Set<() => void>();

export function modifiers(): ModifierState {
  return state;
}

export function subscribeModifiers(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function update(next: ModifierState) {
  if (next.alt === state.alt && next.shift === state.shift) return;
  state = next;
  for (const listener of listeners) listener();
}

interface ModifierEventLike {
  altKey?: boolean;
  shiftKey?: boolean;
  key?: string;
  preventDefault?: () => void;
}

/**
 * Listens on `target` (the window, in the app; a bare EventTarget in tests).
 * Returns the function that stops listening. Installing twice on the same
 * target is harmless — the second call is a no-op until the first is removed.
 */
const installed = new WeakSet<object>();
export function installModifierKeys(target: EventTarget, doc?: { visibilityState?: string } & EventTarget): () => void {
  if (installed.has(target)) return () => {};
  installed.add(target);

  const fromEvent = (event: Event) => {
    const e = event as unknown as ModifierEventLike;
    update({ alt: !!e.altKey, shift: !!e.shiftKey });
  };
  const onKey = (event: Event) => {
    const e = event as unknown as ModifierEventLike;
    // A bare Alt press and release hands focus to the browser's menu bar on
    // Windows, so the next key goes to the menu instead of the app. Nothing in
    // this app wants that, and it would make Alt-to-fine-tune feel broken.
    if (e.key === 'Alt') e.preventDefault?.();
    fromEvent(event);
  };
  const clear = () => update({ alt: false, shift: false });
  const onVisibility = () => {
    if (doc?.visibilityState === 'hidden') clear();
  };

  target.addEventListener('keydown', onKey, true);
  target.addEventListener('keyup', onKey, true);
  target.addEventListener('pointerdown', fromEvent, true);
  target.addEventListener('pointermove', fromEvent, true);
  target.addEventListener('blur', clear);
  doc?.addEventListener('visibilitychange', onVisibility);

  return () => {
    installed.delete(target);
    target.removeEventListener('keydown', onKey, true);
    target.removeEventListener('keyup', onKey, true);
    target.removeEventListener('pointerdown', fromEvent, true);
    target.removeEventListener('pointermove', fromEvent, true);
    target.removeEventListener('blur', clear);
    doc?.removeEventListener('visibilitychange', onVisibility);
    clear();
  };
}

/** Installs on the real window once, the first time anything asks. */
export function ensureModifierKeys(): void {
  if (typeof window === 'undefined') return;
  installModifierKeys(window, document);
}

/**
 * A slider step with Alt held: two decades finer, so a 10 mm slider moves in
 * 0.1 mm. Kept as a function so the one rule lives in one place.
 */
export function fineStep(step: number): number {
  return step / 100;
}
