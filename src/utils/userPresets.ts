/**
 * The one place user presets are read from and written to.
 *
 * They used to be hand-rolled `localStorage.getItem('physics_user_presets')`
 * calls in four separate files — App.tsx, useStore.ts, useMCPBridge.ts — each
 * parsing and re-serialising the same blob. That is why cloud sync was never
 * wired: there was no single seam to hang it on, and hooking three of the four
 * would have meant a preset saved by an agent over MCP never reaching the
 * account while one saved by hand did.
 *
 * Saving and deleting therefore also push to the cloud, fire-and-forget: the
 * local write is what the user is waiting on, and a failed upload must not lose
 * it. `cloudSync` no-ops when signed out.
 */

import { saveCloudPreset, removeCloudPreset } from './cloudSync';

export const USER_PRESETS_KEY = 'physics_user_presets';

/** A saved scene: the graph, plus the annotations shown alongside it. */
export interface UserPreset {
  nodes?: any[];
  noteCards?: any[];
  copilotMessages?: any[];
  [key: string]: any;
}

export function readUserPresets(): Record<string, UserPreset> {
  try {
    const raw = localStorage.getItem(USER_PRESETS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Names without the `user:` prefix, in the order localStorage holds them. */
export function listUserPresetNames(): string[] {
  return Object.keys(readUserPresets());
}

/** Accepts either `name` or `user:name`, since both forms circulate. */
export function readUserPreset(name: string): UserPreset | null {
  const key = name.replace(/^user:/, '');
  const preset = readUserPresets()[key];
  return preset ?? null;
}

function writeAll(presets: Record<string, UserPreset>): boolean {
  try {
    localStorage.setItem(USER_PRESETS_KEY, JSON.stringify(presets));
    return true;
  } catch (err) {
    console.error('[PhysBox] Could not save presets', err);
    return false;
  }
}

/** Saves locally, then mirrors to the account. Returns false if the local write failed. */
export function saveUserPreset(name: string, preset: UserPreset): boolean {
  const key = name.replace(/^user:/, '');
  const presets = readUserPresets();
  presets[key] = preset;
  if (!writeAll(presets)) return false;
  void saveCloudPreset(key, preset);
  return true;
}

export function deleteUserPreset(name: string): boolean {
  const key = name.replace(/^user:/, '');
  const presets = readUserPresets();
  delete presets[key];
  if (!writeAll(presets)) return false;
  void removeCloudPreset(key);
  return true;
}

/**
 * Merges presets pulled from the account into local storage.
 *
 * Additive on purpose — see the note in cloudSync.pullCloudState. Returns how
 * many were new, for the message the account menu shows.
 */
export function mergePulledPresets(pulled: Record<string, UserPreset>): number {
  const presets = readUserPresets();
  let added = 0;
  for (const [name, data] of Object.entries(pulled)) {
    if (name in presets) continue;
    presets[name] = data;
    added += 1;
  }
  if (added > 0) writeAll(presets);
  return added;
}
