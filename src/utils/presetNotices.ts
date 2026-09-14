/**
 * The channel between "a preset was saved" and whatever is on screen to say so.
 *
 * Saving happens in a callback deep in App.tsx and in the MCP bridge, neither of
 * which should know what a toast looks like, and the thing that draws the toast
 * is mounted somewhere else entirely. A one-line publish/subscribe keeps them
 * apart, the same way cloudAutosave already does for its own badge.
 *
 * Deliberately not React state: an MCP command is not a render, and a save
 * triggered by an agent should raise the same toast a person's click does.
 */

import type { PresetSaveResult } from './presetStorage';
import type { UserPreset } from './userPresets';

export interface PresetNotice {
  /** Rising each time, so a repeat of the same message still re-shows. */
  id: number;
  name: string;
  result: PresetSaveResult;
  /**
   * The preset itself, kept only so the dialog can offer it as a download when
   * there was nowhere to save it. Nothing else reads it.
   */
  preset: UserPreset;
  /** Settles to whether the account took it; null when there is no account. */
  cloudPending: Promise<boolean> | null;
}

type Listener = (notice: PresetNotice) => void;

const listeners = new Set<Listener>();
let nextId = 1;

export function subscribeToPresetNotices(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function announcePresetSave(name: string, preset: UserPreset, result: PresetSaveResult): void {
  const notice: PresetNotice = {
    id: nextId++,
    name: name.replace(/^user:/, ''),
    result,
    preset,
    cloudPending: result.cloudPending,
  };
  for (const fn of [...listeners]) {
    try { fn(notice); } catch { /* a broken listener must not break saving */ }
  }
}
