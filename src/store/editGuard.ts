// ---------------------------------------------------------------------------
// The Cast-prep edit guard's state, read by sharingUnchangedNodes in useStore
// ---------------------------------------------------------------------------

import type { SceneGraph } from '../types/scene';

/*
 * The Cast-prep edit guard. While draft is baked into the scene (see CastPrep),
 * an edit to any body is turned away and the guard modal opened in its place,
 * because the edit would land on the drafted shape and switching prep off
 * would then have nothing to put back.
 *
 * A user edit is a write that follows recordInteraction or
 * prepareForDiscreteChange in the same tick — everything that writes to the
 * scene calls one of them first (see prepareForDiscreteChange). Internal writes,
 * a compile landing, do not, and are let through.
 */
export let userEditPending = false;
let userEditTimer: ReturnType<typeof setTimeout> | null = null;

/** Nonzero while prep itself is writing: switching off, baking in, undo, redo. */
export let castPrepBypass = 0;

/** Graphs the guard refused, so an action's own recompile of one is not built. */
export const refusedGraphs = new WeakSet<SceneGraph>();

/**
 * The graph the store kept for each one it was handed. An action sets a graph
 * and then rebuilds from its own copy of it, which never went through the
 * rules in sharingUnchangedNodes; recompile builds what was kept instead.
 */
export const keptGraphs = new WeakMap<SceneGraph, SceneGraph>();

export function markUserEdit() {
  userEditPending = true;
  if (userEditTimer) clearTimeout(userEditTimer);
  userEditTimer = setTimeout(() => { userEditPending = false; userEditTimer = null; }, 0);
}

export function withCastPrepBypass<T>(fn: () => T): T {
  castPrepBypass++;
  try { return fn(); } finally { castPrepBypass--; }
}

/** Whether the scene has draft baked in, and so is guarded against edits. */
export function castPrepArmed(sg: SceneGraph | null | undefined): boolean {
  return !!sg?.castPrep && sg.castPrep.draftDeg > 0;
}

/** After shareUnchanged: did any body change? Notes and other scene fields do not count. */
export function bodiesChanged(prev: SceneGraph, next: SceneGraph): boolean {
  const a = prev.nodes || [], b = next.nodes || [];
  return a.length !== b.length || b.some((n, i) => n !== a[i]);
}
