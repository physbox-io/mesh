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
import type { SceneNode } from '../types/scene';
import type { NoteCard } from './noteCards';

export const USER_PRESETS_KEY = 'physics_user_presets';

/** A saved scene: the graph, plus the annotations shown alongside it. */
/** The fields of a copilot chat message a preset carries; the panel's own type has more. */
export interface SavedCopilotMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

export interface UserPreset {
  nodes?: SceneNode[];
  noteCards?: NoteCard[];
  copilotMessages?: SavedCopilotMessage[];
  [key: string]: unknown;
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

/**
 * Whether a failed write failed because the store is FULL, rather than broken.
 *
 * It matters because the two want opposite advice. A browser with storage
 * switched off cannot be helped by deleting anything; a browser that is simply
 * full can, and the user is owed a list of what is taking the room. The name
 * differs per engine and the legacy numeric codes are still what some of them
 * set, so all four are checked.
 */
export function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; code?: unknown };
  return e.name === 'QuotaExceededError'
    || e.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || e.code === 22
    || e.code === 1014;
}

/** What one preset costs, in bytes of the JSON it is stored as. */
export interface PresetSize { name: string; bytes: number }

/**
 * What each saved preset is costing, largest first.
 *
 * Presets are not all of a size. A scene of primitives is a couple of kilobytes
 * and a scene holding a sculpt, a boolean or a generated mesh is a thousand
 * times that, so "your storage is full" is only useful next to "and this one is
 * 1.1 MB of it". Measured on the serialised form, because that is what is
 * actually stored.
 */
export function presetSizes(): PresetSize[] {
  const presets = readUserPresets();
  return Object.entries(presets)
    .map(([name, data]) => {
      let bytes: number;
      try { bytes = JSON.stringify(data).length; } catch { bytes = 0; }
      return { name, bytes };
    })
    .sort((a, b) => b.bytes - a.bytes);
}

/** Total size of the preset store, in bytes of JSON. */
export function presetStoreBytes(): number {
  try {
    return (localStorage.getItem(USER_PRESETS_KEY) || '').length;
  } catch {
    return 0;
  }
}

function writeAll(presets: Record<string, UserPreset>): boolean {
  try {
    localStorage.setItem(USER_PRESETS_KEY, JSON.stringify(presets));
    return true;
  } catch (err) {
    console.error('[PhysBox] Could not save presets', err);
    lastWriteError = err;
    return false;
  }
}

/**
 * Why the last local write failed, for the layer that has to explain it.
 *
 * writeAll can only answer yes or no, and every caller of it is several frames
 * from the exception. Rather than thread a result type through all of them, the
 * error is parked here and read by presetStorage, which is the only thing that
 * needs to tell a quota from a refusal.
 */
let lastWriteError: unknown = null;
export function takeLastWriteError(): unknown {
  const err = lastWriteError;
  lastWriteError = null;
  return err;
}

/**
 * The local half on its own, without the mirror to the account.
 *
 * presetStorage needs the two steps separated: it has to know whether the
 * account took a preset, which means holding the upload's promise rather than
 * dropping it, and it must not fire a second upload on top of the one below.
 */
export function writeLocalPreset(name: string, preset: UserPreset): boolean {
  const key = name.replace(/^user:/, '');
  const presets = readUserPresets();
  presets[key] = preset;
  return writeAll(presets);
}

/** Saves locally, then mirrors to the account. Returns false if the local write failed. */
export function saveUserPreset(name: string, preset: UserPreset): boolean {
  const key = name.replace(/^user:/, '');
  if (!writeLocalPreset(key, preset)) return false;
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
