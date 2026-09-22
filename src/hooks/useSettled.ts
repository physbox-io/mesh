// ---------------------------------------------------------------------------
// Waiting until the typing stops
// ---------------------------------------------------------------------------
//
// A control that reports every keystroke makes the app do the work for values
// nobody meant. Typing `0.125` into a size box emits `0`, then `0.1`, then
// `0.12` on the way, and a size edit rebuilds the MuJoCo model and throws away
// the sim state — four rebuilds for one number, three of them for a number that
// was never intended. Dragging a slider is the same thing sixty times a second.
//
// Both hooks here answer that, from opposite ends. `useSettled` takes a value
// that is already changing too often and hands back a copy that only moves once
// it stops, for a consumer that is expensive to run. `useCommitted` sits inside
// the control instead: it keeps the fast-moving value local so the caret and the
// slider handle stay live, and lets only the settled one out.
//
// Nothing in here imports the store, three.js or anything else from this app —
// it is meant to move to `@physbox-io/ui` beside `NumberInput` once it has
// proven out, and Etch and Volt have the same problem in their export dialogs.

import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Holds a value still until edits stop.
 *
 * For a consumer that is expensive to run — regenerating a carve means
 * re-sampling the whole surface and dilating it by the cutter, a few hundred
 * milliseconds of solid work, far too much to run between two keystrokes in a
 * stock-size box.
 *
 * Compare `settled !== value` to know an edit is in flight, and say so in the
 * preview rather than leaving it looking stale.
 */
export function useSettled<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return settled;
}

/**
 * A control that stays smooth while its owner only hears the final value.
 *
 * `draft` is what the control renders, and `setDraft` moves it at once, so the
 * handle tracks the pointer and a half-typed number survives. `commit` runs
 * `delayMs` after the last edit, or straight away on `flush()` — wire that to
 * blur, Enter and pointer-up, which are the three moments a value is finished
 * ahead of the timer.
 *
 * While no edit is pending the draft follows `value`, so a change from anywhere
 * else — an undo, a preset load, the gizmo — still shows up in the box. An edit
 * in flight is never overwritten; that is the bug this replaces.
 *
 * `cancel()` throws the pending edit away instead — what Escape means.
 */
export function useCommitted<T>(
  value: T,
  commit: (v: T) => void,
  delayMs: number,
): [draft: T, setDraft: (v: T) => void, flush: () => void, cancel: () => void] {
  const [draft, setDraftState] = useState(value);

  // Refs, not deps: the commit callback is usually a fresh closure every render,
  // and making the timer depend on it would restart the wait on every keystroke
  // of *any* field on the panel.
  const commitRef = useRef(commit);
  // Written in an effect, not during render: the timer that reads it can only
  // fire after the commit has happened anyway.
  useEffect(() => { commitRef.current = commit; }, [commit]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{ v: T } | null>(null);

  /*
   * Follow the value while nothing is pending, so a change from anywhere else —
   * an undo, a preset load, the gizmo — still shows up in the control. In an
   * effect rather than during render because the test is on a ref, and because
   * an edit in flight must never be overwritten: that is the bug this replaces.
   */
  useEffect(() => {
    if (pendingRef.current === null) setDraftState(value);
  }, [value]);

  const send = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    commitRef.current(pending.v);
  }, []);

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    setDraftState(value);
  }, [value]);

  const setDraft = useCallback(
    (v: T) => {
      setDraftState(v);
      pendingRef.current = { v };
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(send, delayMs);
    },
    [delayMs, send],
  );

  // An unmount mid-edit — a panel closing, a selection changing — still means
  // the number was typed. Losing it silently is worse than committing it late.
  useEffect(() => () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending) commitRef.current(pending.v);
  }, []);

  return [draft, setDraft, send, cancel];
}
