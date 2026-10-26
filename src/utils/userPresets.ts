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

import { saveCloudPreset, removeCloudPreset, fetchCloudPresetData } from './cloudSync';
import type { SceneNode } from '../types/scene';
import type { NoteCard } from './noteCards';
import { forgetRecent } from './sceneMeta';
import { packMeshArrays, unpackMeshArrays } from './meshPacking';

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
  /** When it was last saved, ms since the epoch. Missing on presets saved before it was kept. */
  savedAt?: number;
  /**
   * A small JPEG of the viewport at the last save, as a data URL, for the
   * scene browser. Kept with the preset so it travels to the account with it,
   * but it is the app's, not the scene's: loading takes it off again, so it is
   * never in the scene graph, a JSON export or a share link.
   */
  thumbnail?: string;
  [key: string]: unknown;
}

/**
 * Presets the account holds that this browser had no room for.
 *
 * Without this, a preset that went to the account because localStorage was full
 * was listed nowhere: the dropdown, the loaders and the MCP bridge all read
 * localStorage, and the pull on another machine copied the account into a
 * localStorage just as full, failing for every preset at once and saying
 * nothing. They are held here for the session instead, and every reader below
 * falls back to them, so a preset is listed and loads wherever it lives.
 *
 * Deliberately not counted by readUserPresets, presetSizes or presetStoreBytes:
 * those answer "what is this browser storing", which is what the quota advice
 * needs.
 *
 * Null is a preset the pull listed by name and nobody has opened yet: its data
 * stays in the account until ensureUserPreset fetches it.
 */
const cloudOnly: Record<string, UserPreset | null> = {};

/** What the account's list says about each preset: its picture and when it was saved. */
const cloudCards: Record<string, { thumbnail: string | null; savedAt: number | null }> = {};

export function rememberCloudPresetCard(name: string, card: { thumbnail?: string | null; updatedAt?: string }): void {
  const at = card.updatedAt ? Date.parse(card.updatedAt) : NaN;
  cloudCards[name.replace(/^user:/, '')] = { thumbnail: card.thumbnail || null, savedAt: Number.isFinite(at) ? at : null };
}

/**
 * A saved scene's picture and date for its card: from this browser's copy, or
 * a copy fetched from the account, or the account's list for one not fetched.
 */
export function presetCard(name: string): { thumbnail: string | null; savedAt: number | null } {
  const key = name.replace(/^user:/, '');
  const held = readCachedPresets()[key] ?? cloudOnly[key];
  const listed = cloudCards[key];
  return {
    thumbnail: typeof held?.thumbnail === 'string' ? held.thumbnail : listed?.thumbnail ?? null,
    savedAt: typeof held?.savedAt === 'number' ? held.savedAt : listed?.savedAt ?? null,
  };
}

/** Fired whenever the set of listed presets changes outside a local save. */
export const USER_PRESETS_CHANGED_EVENT = 'physics:user-presets-changed';

function announceChange(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(USER_PRESETS_CHANGED_EVENT));
}

/** Lists a preset that only the account holds, for the rest of the session. */
export function rememberCloudOnlyPreset(name: string, preset: UserPreset): void {
  cloudOnly[name.replace(/^user:/, '')] = preset;
  announceChange();
}

/**
 * Makes a preset's data readable before it is loaded.
 *
 * Presets this browser holds, or whose data was already fetched, are ready at
 * once. One listed from the account by name only is fetched, and kept here too
 * when there is room, so opening it again does not go back to the network.
 * False when the preset is unknown or the account could not be reached.
 */
export async function ensureUserPreset(name: string): Promise<boolean> {
  const key = name.replace(/^user:/, '');
  if (Object.hasOwn(readCachedPresets(), key)) return true;
  if (!Object.hasOwn(cloudOnly, key)) return false;
  if (cloudOnly[key]) return true;
  const data = await fetchCloudPresetData(key);
  if (!data) return false;
  // Deleted, saved here or fetched by another caller while this was in flight:
  // the newer state stands.
  if (cloudOnly[key] !== null) return Object.hasOwn(cloudOnly, key) || Object.hasOwn(readCachedPresets(), key);
  if (!writeLocalPreset(key, data)) {
    takeLastWriteError();
    cloudOnly[key] = data;
  }
  announceChange();
  return true;
}

/** Presets listed only because the account has them, without the `user:` prefix. */
export function cloudOnlyPresetNames(): string[] {
  const local = readCachedPresets();
  return Object.keys(cloudOnly).filter(name => !Object.hasOwn(local, name));
}

let cachedRaw: string | null = null;
let cachedParsed: Record<string, UserPreset> = {};
let cachedSizes: PresetSize[] | null = null;

function readCachedPresets(): Record<string, UserPreset> {
  try {
    const raw = localStorage.getItem(USER_PRESETS_KEY);
    if (!raw) {
      cachedRaw = null;
      cachedParsed = {};
      cachedSizes = null;
      return cachedParsed;
    }
    if (raw === cachedRaw) {
      return cachedParsed;
    }
    const parsed = JSON.parse(raw);
    cachedRaw = raw;
    cachedParsed = parsed && typeof parsed === 'object' ? parsed : {};
    cachedSizes = null;
    return cachedParsed;
  } catch {
    cachedRaw = null;
    cachedParsed = {};
    cachedSizes = null;
    return cachedParsed;
  }
}

export function readUserPresets(): Record<string, UserPreset> {
  return { ...readCachedPresets() };
}

/** Names without the `user:` prefix: this browser's, then any held only by the account. */
export function listUserPresetNames(): string[] {
  const names = Object.keys(readCachedPresets());
  for (const name of Object.keys(cloudOnly)) if (!names.includes(name)) names.push(name);
  return names;
}

/**
 * Accepts either `name` or `user:name`, since both forms circulate.
 *
 * A copy, never the cached object: the loader mutates what it gets
 * (promoteJointedMeshGeomsDeep) and hands it to the live scene, and the next
 * save of ANY preset writes the cache back out, so an alias would put the edits
 * made on screen into the stored preset without anyone saving it.
 */
export function readUserPreset(name: string): UserPreset | null {
  const key = name.replace(/^user:/, '');
  const preset = readCachedPresets()[key] ?? cloudOnly[key];
  // Stored with its meshes packed (meshPacking.ts); read with them as numbers.
  return preset ? unpackMeshArrays(structuredClone(preset)) : null;
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
  const presets = readCachedPresets();
  if (cachedSizes) {
    return cachedSizes.map(s => ({ ...s }));
  }
  const sizes = Object.entries(presets)
    .map(([name, data]) => {
      let bytes: number;
      try { bytes = JSON.stringify(data).length; } catch { bytes = 0; }
      return { name, bytes };
    })
    .sort((a, b) => b.bytes - a.bytes);
  cachedSizes = sizes;
  return sizes.map(s => ({ ...s }));
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
    const serialized = JSON.stringify(presets);
    localStorage.setItem(USER_PRESETS_KEY, serialized);
    cachedRaw = serialized;
    cachedParsed = { ...presets };
    cachedSizes = null;
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
  presets[key] = packMeshArrays(preset);
  if (!writeAll(presets)) return false;
  // Room was made and it is stored here now; the local copy is what reads find.
  delete cloudOnly[key];
  return true;
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
  const wasCloudOnly = Object.hasOwn(cloudOnly, key);
  delete cloudOnly[key];
  const presets = readUserPresets();
  if (Object.hasOwn(presets, key)) {
    delete presets[key];
    if (!writeAll(presets)) return false;
  }
  void removeCloudPreset(key);
  forgetRecent(`user:${key}`);
  if (wasCloudOnly) announceChange();
  return true;
}

/**
 * Lists the account's presets that this browser does not hold.
 *
 * Additive on purpose — see the note in cloudSync.pullCloudState. Names only:
 * the pull used to bring every preset down whole and copy it in here, which
 * meant downloading the whole account on every page load until the list went
 * over the server's response cap and the pull failed outright. Each one is
 * fetched when it is opened (ensureUserPreset). Returns how many were listed.
 */
export function mergePulledPresets(
  names: string[],
  cards: Record<string, { thumbnail?: string | null; updatedAt?: string }> = {},
): number {
  for (const [name, card] of Object.entries(cards)) rememberCloudPresetCard(name, card);
  const local = readCachedPresets();
  let listed = 0;
  for (const name of names) {
    if (Object.hasOwn(local, name) || Object.hasOwn(cloudOnly, name)) continue;
    cloudOnly[name] = null;
    listed += 1;
  }
  if (listed > 0) announceChange();
  return listed;
}
