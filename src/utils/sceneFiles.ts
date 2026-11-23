/**
 * Renaming and copying saved scenes, for the scene browser.
 *
 * Both are a save under the new name through savePreset — so a full browser
 * falls back to the account exactly as a hand save does — and a rename then
 * deletes the old name only once the new one is safely somewhere. The
 * thumbnail is part of the preset, so it goes along with it.
 */

import { ensureUserPreset, readUserPreset, deleteUserPreset, listUserPresetNames, normalizePresetName } from './userPresets';
import { savePreset, type PresetSaveResult } from './presetStorage';
import { copyName } from './sceneCatalog';
import { renameRecent } from './sceneMeta';

export type SceneFileResult = { ok: true; name: string } | { ok: false; message: string; save?: PresetSaveResult };

async function copyTo(from: string, to: string, keepDate: boolean): Promise<SceneFileResult> {
  if (!(await ensureUserPreset(from))) return { ok: false, message: `“${from}” could not be fetched from your account.` };
  const preset = readUserPreset(from);
  if (!preset) return { ok: false, message: `“${from}” could not be read.` };
  const save = await savePreset(to, preset, { keepDate });
  return save.ok ? { ok: true, name: to } : { ok: false, message: save.message, save };
}

export async function renameScene(from: string, to: string): Promise<SceneFileResult> {
  const source = normalizePresetName(from);
  const name = normalizePresetName(to);
  if (!source || !name) return { ok: false, message: 'A scene needs a name.' };
  if (name === source) return { ok: true, name };
  if (listUserPresetNames().includes(name)) return { ok: false, message: `There is already a scene called “${name}”.` };
  const copied = await copyTo(source, name, true);
  if (!copied.ok) return copied;
  // Moved before the delete, which would otherwise forget it.
  renameRecent(`user:${source}`, `user:${name}`);
  if (!deleteUserPreset(source)) return { ok: false, message: `Saved as “${name}”, but “${source}” could not be removed.` };
  return copied;
}

export async function duplicateScene(from: string): Promise<SceneFileResult> {
  const source = normalizePresetName(from);
  return copyTo(source, copyName(source, listUserPresetNames()), false);
}
