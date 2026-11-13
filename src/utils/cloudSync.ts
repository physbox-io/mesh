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
 * Presets are kept level by `presetSync`, which is why this does not import
 * userPresets: that module saves and deletes through here, and connects itself.
 */

import { fetchCloudParameters } from './apiClient';
import { SYNCED_LLM_PARAMETER_KEYS } from './llmSettings';
import type { UserPreset } from './userPresets';
import { packMeshArrays } from './meshPacking';
import { externalizeMeshes, forgetUploadedBlobs, hasBlobRefs, resolveMeshBlobs } from './meshBlobs';
import { SPINDLE_MAX_OVERRIDE_KEY } from './spindleOverride';
import { PRINTER_STORAGE_KEY } from './printerSettings';
import { CNC_BED_PARAMETER, TOOL_RACK_PARAMETER } from '@physbox-io/machining';
import { adoptSuiteParameters } from '@physbox-io/ui/suite';
import { settleToolRack } from './toolRack';
import { cncBedStore } from './printBedSettings';
import { PresetSync, type PresetSyncResult } from './presetSync';

export const presetSync = new PresetSync('physics', 'physics_cloud_preset_ids');

/** UI preferences that follow the account, under this app's own id. */
export const SYNCED_APP_PARAMETER_KEYS: readonly string[] = [SPINDLE_MAX_OVERRIDE_KEY, PRINTER_STORAGE_KEY];

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

/** A preset in the form the account keeps it: big meshes in the blob store, or inline if that is out of reach. */
export async function presetForAccount(data: unknown): Promise<unknown> {
  const packed = packMeshArrays(data);
  return externalizeMeshes(packed).catch(() => packed);
}

/**
 * Records a save as owed to the account and uploads it.
 *
 * Returns whether the account took it. Nearly every caller is fire-and-forget
 * and ignores this, which is right: the local write is what the user is waiting
 * on, and a failed upload goes again at the next pull. The one caller that does
 * care is the path where the LOCAL write failed for want of room, where this is
 * the difference between the work being safe in the account and being gone.
 */
export async function saveCloudPreset(name: string, data: unknown): Promise<boolean> {
  presetSync.noteSaved(name);
  if (await presetSync.upload(name, await presetForAccount(data))) return true;
  // Refused, perhaps for a blob this session thought it had uploaded: once more, asking afresh.
  forgetUploadedBlobs();
  return presetSync.upload(name, await presetForAccount(data));
}

/** Deletes the cloud copy of a preset, now if the account can be reached and at the next pull if not. */
export function removeCloudPreset(name: string): Promise<void> {
  return presetSync.remove(name);
}

/**
 * Fetches one preset's data from the account, by name.
 *
 * Null when the account does not have it or cannot be reached, which includes
 * any of its meshes: a part-fetched preset must not be kept, least of all over
 * a whole one.
 */
export async function fetchCloudPresetData(name: string): Promise<UserPreset | null> {
  return (await presetSync.fetchLatest(name)) as UserPreset | null;
}

/** A preset as it came from the account, with its meshes in. Null when any would not come. */
export async function presetFromAccount(data: unknown, blobUrls?: Record<string, string>): Promise<unknown> {
  const resolved = await resolveMeshBlobs(data, blobUrls);
  return hasBlobRefs(resolved) ? null : resolved;
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
  /** What moved between this browser's presets and the account's. */
  presets: PresetSyncResult;
}

/**
 * Pulls the signed-in account's settings and brings its presets level.
 *
 * Throws if the preset list cannot be fetched, so the caller can say the
 * account was not reached instead of reporting it up to date.
 */
export async function pullCloudState(): Promise<CloudPullResult> {
  const [appParams, globalParams] = await Promise.all([
    fetchCloudParameters('physics'),
    fetchCloudParameters('global'),
  ]);
  let parameters = 0;

  for (const key of SYNCED_APP_PARAMETER_KEYS) {
    if (key in appParams && applyParameter(key, appParams[key])) parameters += 1;
  }
  for (const key of SYNCED_LLM_PARAMETER_KEYS) {
    // The app query can also return `global` rows, so check both responses.
    const value = key in globalParams ? globalParams[key] : appParams[key];
    if (value !== undefined && applyParameter(key, value)) parameters += 1;
  }

  // The shared tool rack, newer copy winning either way. A rack edited here
  // while signed out is newer than the account's and goes up; one edited in
  // Etch or Volt since comes down. The `global` row is the one the other apps
  // write, so it is read first.
  if (settleToolRack(globalParams[TOOL_RACK_PARAMETER] ?? appParams[TOOL_RACK_PARAMETER])) parameters += 1;
  // The machine's envelope is shared with Etch and Volt, like the rack.
  if (cncBedStore.adoptRemote(globalParams[CNC_BED_PARAMETER] ?? appParams[CNC_BED_PARAMETER])) parameters += 1;
  // Dark mode, touch plate and shim, shared by every PhysBox app.
  parameters += adoptSuiteParameters(globalParams);

  return { parameters, presets: await presetSync.pull() };
}
