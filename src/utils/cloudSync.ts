/**
 * The download half of cloud sync.
 *
 * `apiClient` has been able to fetch parameters and presets since it was
 * written, but nothing ever called those functions: settings and presets went
 * up and never came back, so signing in on a second machine restored nothing
 * while the account menu claimed "Cloud Parameter & Preset Auto-Sync Active".
 * This module is the missing side — it pulls the account's state after sign-in
 * and merges it into the same localStorage the app already reads.
 *
 * Ported from `etch/src/utils/cloudSync.ts`, including the two things that
 * module learned the hard way: presets are addressed by the id the SERVER gave
 * them, and a pull never overwrites a local preset of the same name.
 *
 * It deliberately does not import userPresets: that module saves and deletes
 * through here, so a dependency the other way would be a cycle. Pulled presets
 * are handed back to the caller.
 */

import { fetchCloudParameters, fetchCloudPresetList, fetchCloudPreset, syncCloudPreset, deleteCloudPreset } from './apiClient';
import { SYNCED_LLM_PARAMETER_KEYS } from './llmSettings';
import type { UserPreset } from './userPresets';
import { SPINDLE_MAX_OVERRIDE_KEY } from './spindleOverride';
import { CNC_BED_PARAMETER, TOOL_RACK_PARAMETER } from '@physbox-io/machining';
import { settleToolRack } from './toolRack';
import { cncBedStore } from './printBedSettings';

/** UI preferences that follow the account, under this app's own id. */
export const SYNCED_APP_PARAMETER_KEYS: readonly string[] = ['physics_dark_mode', SPINDLE_MAX_OVERRIDE_KEY];

/**
 * Mirrors one app-scoped preference to the account.
 *
 * Fire-and-forget, and a no-op when signed out — the local write has already
 * happened, and a failed upload must never be why a preference does not stick.
 */
export function pushAppParameter(key: string, value: string | number): void {
  void import('./apiClient').then(({ syncCloudParameters }) => {
    void syncCloudParameters('physics', { [key]: value });
  });
}

/**
 * Maps a preset's name to the id the server gave it.
 *
 * Needed because deleting would otherwise have to guess: the app saves a preset
 * under a name, the server generates its own id for it, and deleting by name
 * matches nothing — leaving the preset in the account forever, ready to be
 * pulled straight back down on the next sign-in.
 */
const PRESET_ID_MAP_KEY = 'physics_cloud_preset_ids';

function readPresetIdMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(PRESET_ID_MAP_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writePresetIdMap(map: Record<string, string>): void {
  try {
    localStorage.setItem(PRESET_ID_MAP_KEY, JSON.stringify(map));
  } catch {
    // Non-fatal: deletes fall back to leaving the cloud copy in place.
  }
}

function rememberPresetId(name: string, id: string): void {
  const map = readPresetIdMap();
  if (map[name] === id) return;
  map[name] = id;
  writePresetIdMap(map);
}

/**
 * Uploads a saved preset and records the id the server assigned it.
 *
 * Returns whether the account actually took it. Nearly every caller is
 * fire-and-forget and ignores this, which is right: the local write is what the
 * user is waiting on. The one caller that does care is the path where the LOCAL
 * write failed for want of room, where this is the difference between the work
 * being safe in the account and being gone.
 */
export async function saveCloudPreset(name: string, data: unknown): Promise<boolean> {
  const existingId = readPresetIdMap()[name];
  const id = await syncCloudPreset('physics', name, data, existingId);
  if (id) rememberPresetId(name, id);
  return !!id;
}

/** Deletes the cloud copy of a preset, by its real server id. */
export async function removeCloudPreset(name: string): Promise<void> {
  const map = readPresetIdMap();
  const id = map[name];
  if (!id) return;
  const deleted = await deleteCloudPreset(id);
  if (deleted) {
    delete map[name];
    writePresetIdMap(map);
  }
}

/**
 * Fetches one preset's data from the account, by name.
 *
 * The pull lists presets without their data; this is what opening one of them
 * calls. Null when the account does not have it or cannot be reached.
 */
export async function fetchCloudPresetData(name: string): Promise<UserPreset | null> {
  const id = readPresetIdMap()[name];
  if (!id) return null;
  const preset = await fetchCloudPreset(id);
  const data = preset?.data;
  return data && typeof data === 'object' ? data as UserPreset : null;
}

/**
 * Writes a pulled parameter into localStorage.
 *
 * Values arrive JSON-decoded from the server, but everything reading them
 * expects the string form localStorage holds, so numbers and booleans are
 * stringified back. Nothing is validated here on purpose — each reader clamps
 * or falls back on its own, which is the same treatment a hand-edited
 * localStorage gets.
 */
function applyParameter(key: string, value: unknown): boolean {
  if (value === null || value === undefined) return false;
  try {
    localStorage.setItem(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    return true;
  } catch {
    return false;
  }
}

export interface CloudPullResult {
  /** Number of settings restored from the account. */
  parameters: number;
  /** Names of the presets the account holds; their data is fetched when opened. */
  presets: string[];
}

/**
 * Pulls the signed-in account's settings and the names of its presets.
 *
 * Throws if the preset list cannot be fetched, so the caller can say the
 * account was not reached instead of reporting it up to date.
 *
 * Presets come back for the caller to merge additively: a name already saved in
 * this browser is left alone. Taking the cloud copy instead would be the wrong
 * call for the case that actually happens — edits made while offline are newer
 * than what the account holds, and overwriting them would lose work to restore
 * a stale copy. Ids for the skipped names are still recorded, so deleting them
 * later removes the cloud copy too.
 */
export async function pullCloudState(): Promise<CloudPullResult> {
  const result: CloudPullResult = { parameters: 0, presets: [] };

  const [appParams, globalParams, presets] = await Promise.all([
    fetchCloudParameters('physics'),
    fetchCloudParameters('global'),
    fetchCloudPresetList('physics'),
  ]);

  for (const key of SYNCED_APP_PARAMETER_KEYS) {
    if (key in appParams && applyParameter(key, appParams[key])) result.parameters += 1;
  }
  for (const key of SYNCED_LLM_PARAMETER_KEYS) {
    // The app query can also return `global` rows, so check both responses.
    const value = key in globalParams ? globalParams[key] : appParams[key];
    if (value !== undefined && applyParameter(key, value)) result.parameters += 1;
  }

  // The shared tool rack, newer copy winning either way. A rack edited here
  // while signed out is newer than the account's and goes up; one edited in
  // Etch or Volt since comes down. The `global` row is the one the other apps
  // write, so it is read first.
  if (settleToolRack(globalParams[TOOL_RACK_PARAMETER] ?? appParams[TOOL_RACK_PARAMETER])) result.parameters += 1;
  // The machine's envelope is shared with Etch and Volt, like the rack.
  if (cncBedStore.adoptRemote(globalParams[CNC_BED_PARAMETER] ?? appParams[CNC_BED_PARAMETER])) result.parameters += 1;

  for (const preset of presets) {
    if (!preset?.name || !preset.id) continue;
    rememberPresetId(preset.name, preset.id);
    result.presets.push(preset.name);
  }

  return result;
}
