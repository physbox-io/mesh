/**
 * Where a saved preset actually goes, and what to do when it will not fit.
 *
 * Presets have always been kept in localStorage and mirrored to the account as
 * an afterthought. That arrangement is fine right up to the moment the browser
 * says no: localStorage is a handful of megabytes shared with everything else
 * the origin keeps, a single scene carrying a sculpt, a boolean or a generated
 * mesh can be over a megabyte on its own, and the failure arrives as a bare
 * `QuotaExceededError` out of `setItem`.
 *
 * Two things were wrong with how that was handled:
 *
 *   - Nobody was told. App.tsx caught the error and wrote it to the console; the
 *     MCP bridge returned "Could not write the preset to local storage" with no
 *     hint that the store was full rather than broken, and no idea what to do
 *     about it. A save that silently does nothing is the worst kind of bug,
 *     because the work is gone by the time anyone notices.
 *
 *   - The account was never tried. `saveUserPreset` returned false the moment
 *     the local write failed and never reached the cloud mirror, so an account
 *     that could perfectly well have held the preset never saw it. The paid tier
 *     was therefore just as dependent on a full browser as the free one, which
 *     is exactly backwards.
 *
 * So this module owns the policy instead: try local, fall back to the account,
 * and when neither can take it, say so in terms the caller can act on — how much
 * room is in use, which presets are eating it, and the JSON to download so the
 * work survives regardless.
 */

import {
  listUserPresetNames, writeLocalPreset, rememberCloudOnlyPreset,
  isQuotaError, takeLastWriteError, presetSizes, presetStoreBytes,
  type UserPreset, type PresetSize,
} from './userPresets';
import { saveCloudPreset } from './cloudSync';
import { packMeshArrays } from './meshPacking';
import { getStoredAuthToken, isProAccount } from './apiClient';

/** Where a preset ended up. */
export type PresetSavedTo = 'local' | 'cloud' | 'nowhere';

export interface PresetSaveResult {
  ok: boolean;
  savedTo: PresetSavedTo;
  /** True when the local store is full, as opposed to unavailable or broken. */
  quotaExceeded: boolean;
  /** Size of the preset that was being saved, in bytes of JSON. */
  bytes: number;
  /** What the preset store currently holds, in bytes. */
  storeBytes: number;
  /** The biggest saved presets, largest first — what to delete to make room. */
  largest: PresetSize[];
  /** Whether an account is signed in at all, and whether it is a paid one. */
  signedIn: boolean;
  pro: boolean;
  /** A sentence a human can read, and an agent can pass on unchanged. */
  message: string;
  /** What the caller should offer to do about it, in the order worth offering. */
  remedies: PresetRemedy[];
  /**
   * The upload to the account, still in flight.
   *
   * The local write is instant and the upload is a network round trip, so the
   * result cannot wait for it — a save that takes a second to acknowledge feels
   * broken. The caller gets the answer immediately and this to settle with,
   * which is how the toast can say "Saved" now and "and to your account" a
   * moment later without ever claiming something that has not happened yet.
   *
   * Null when signed out, or when the preset went to the account already.
   */
  cloudPending: Promise<boolean> | null;
}

export type PresetRemedy =
  /** Delete saved presets to make room; `names` are the biggest ones. */
  | { kind: 'delete'; names: string[]; freesBytes: number }
  /** Offer the JSON as a file download so the work is not lost. */
  | { kind: 'download' }
  /** Sign in, so the account can hold what the browser cannot. */
  | { kind: 'signIn' }
  /** Upgrade, for cloud storage that does not depend on this browser at all. */
  | { kind: 'upgrade' };

/** Bytes, as something to put in a sentence. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${bytes} bytes`;
}

/**
 * How many of the biggest presets would have to go to free `needed` bytes.
 *
 * Deleting the largest first is the shortest route to room, and it is also the
 * advice that costs the user the fewest presets.
 */
function biggestToFree(needed: number, exclude: string): { names: string[]; freesBytes: number } {
  const names: string[] = [];
  let freed = 0;
  for (const p of presetSizes()) {
    if (p.name === exclude) continue;
    if (freed >= needed) break;
    names.push(p.name);
    freed += p.bytes;
  }
  return { names, freesBytes: freed };
}

/**
 * Saves a preset wherever it can go.
 *
 * Local first, because that is what makes it appear instantly and work offline.
 * If the browser has no room, the account is tried — and for a signed-in user
 * that is usually the end of it: the preset is saved, it is listed, it loads,
 * and the only difference is that it lives in the account rather than the tab.
 */
export async function savePreset(
  name: string,
  given: UserPreset,
  { keepDate = false }: { keepDate?: boolean } = {},
): Promise<PresetSaveResult> {
  const key = name.replace(/^user:/, '');
  // When it was saved, for the scene browser; a rename keeps the date it had.
  // Packed here as well as where it is written, so `bytes` is what is stored.
  const dated: UserPreset = keepDate && typeof given.savedAt === 'number' ? given : { ...given, savedAt: Date.now() };
  const preset = packMeshArrays(dated);
  let bytes: number;
  try { bytes = JSON.stringify(preset).length; } catch { bytes = 0; }

  const signedIn = !!getStoredAuthToken();
  const pro = isProAccount();

  // The local write and the upload are kicked off separately here, rather than
  // through saveUserPreset, so the upload's promise can be handed back instead
  // of dropped — see cloudPending.
  if (writeLocalPreset(key, preset)) {
    return {
      ok: true, savedTo: 'local', quotaExceeded: false, bytes,
      storeBytes: presetStoreBytes(), largest: [], signedIn, pro,
      message: `Saved “${key}”.`,
      remedies: [],
      cloudPending: signedIn ? saveCloudPreset(key, preset) : null,
    };
  }

  const err = takeLastWriteError();
  const quota = isQuotaError(err);

  // The browser could not take it. The account still might.
  if (signedIn) {
    const uploaded = await saveCloudPreset(key, preset);
    if (uploaded) {
      // Listed and loadable from here on, though this browser holds no copy;
      // another machine finds it through the pull on sign-in.
      rememberCloudOnlyPreset(key, preset);
      return {
        ok: true, savedTo: 'cloud', quotaExceeded: quota, bytes,
        storeBytes: presetStoreBytes(), largest: presetSizes().slice(0, 5), signedIn, pro,
        // Where it went is all there is to say: the account is the place for a
        // scene this size, and this browser's storage is nobody's business.
        message: `Saved “${key}” to your account.`,
        remedies: [{ kind: 'delete', ...biggestToFree(bytes, key) }],
        cloudPending: null,
      };
    }
  }

  // Nowhere left to put it. Say what is in the way and what can be done.
  const store = presetStoreBytes();
  const remedies: PresetRemedy[] = [];
  let message: string;
  if (signedIn) {
    // Signed in, the account is where it goes, any account: presets are not a
    // Pro feature. Failing here means the account could not be reached, and
    // how full this browser is has nothing to do with it.
    remedies.push({ kind: 'download' });
    message = `“${key}” could not be saved: your account could not be reached. `
      + `Try again in a moment, or download it as a file so the work is not lost.`;
  } else {
    const freeing = biggestToFree(bytes, key);
    if (quota && freeing.names.length) remedies.push({ kind: 'delete', ...freeing });
    remedies.push({ kind: 'download' }, { kind: 'signIn' });
    message = quota
      ? `“${key}” is ${formatBytes(bytes)} and this browser's preset storage is full `
        + `(${formatBytes(store)} in use across ${listUserPresetNames().length} presets). `
        + `Nothing has been saved. Delete a preset to make room, or download this one as a file. `
        + `Signing in from the account menu keeps presets in your account rather than this browser.`
      : `“${key}” could not be saved: this browser refused to store it. Download it as a file so the work is not lost.`;
  }

  return {
    ok: false, savedTo: 'nowhere', quotaExceeded: quota, bytes,
    storeBytes: store, largest: presetSizes().slice(0, 5), signedIn, pro,
    message, remedies, cloudPending: null,
  };
}

/**
 * The preset as a file, for when there is nowhere to put it.
 *
 * The point of offering this is that it is the one remedy that cannot fail and
 * needs no account: whatever else is wrong, the scene the user just built comes
 * off the machine intact and can be loaded back later.
 */
export function presetToFile(name: string, preset: UserPreset): { filename: string; json: string } {
  const key = name.replace(/^user:/, '');
  return {
    filename: `${key.replace(/[^\w.-]+/g, '_') || 'preset'}.physbox.json`,
    json: JSON.stringify(preset, null, 2),
  };
}

/** What the preset store holds right now, for a settings panel or an agent. */
export function presetStorageReport() {
  const sizes = presetSizes();
  return {
    presets: sizes.length,
    totalBytes: presetStoreBytes(),
    total: formatBytes(presetStoreBytes()),
    largest: sizes.slice(0, 10).map(p => ({ ...p, size: formatBytes(p.bytes) })),
    signedIn: !!getStoredAuthToken(),
    pro: isProAccount(),
  };
}
