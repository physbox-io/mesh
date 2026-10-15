import { Save, Trash2 } from 'lucide-react';
import { useStore } from '../../store/useStore';
import { useDialogs } from '../../store/dialogStore';
import { PRESETS } from '../../presets/presetScenes';
import { SURFACE_PATTERNS } from '../../utils/surfacePatterns';
import { deleteUserPreset, listUserPresetNames, cloudOnlyPresetNames } from '../../utils/userPresets';
import type { PresetActions, PresetEntry } from '../../hooks/usePresetActions';

/**
 * The scene preset dropdown, with Update and Delete beside it while a saved
 * preset of the user's is open.
 */
export function PresetPicker({ presets, hasUnsavedWork }: { presets: PresetActions; hasUnsavedWork: () => boolean }) {
  const { activePresetLabel, loadPresetWithCard, loadUserPresetWithCard, saveUserPresetByName } = presets;
  const activePreset = useStore((s) => s.activePreset);
  const openPatternGenerator = useStore((s) => s.openPatternGenerator);
  const openDialog = useDialogs((s) => s.openDialog);
  const closeDialog = useDialogs((s) => s.closeDialog);
  const showNotice = useDialogs((s) => s.showNotice);
  return (
    <div className="flex items-center min-w-0 max-lg:flex-1 bg-slate-100 dark:bg-slate-800/80 p-0.5 rounded-lg border border-slate-200/80 dark:border-slate-700/60 shadow-inner">
      {/* The select never *holds* the active preset: its value is always
          the placeholder below, so picking any entry — including the one
          already loaded — is a real change event and reloads the scene.
          Bound to activePreset instead, re-picking Blank after adding a
          body fires nothing at all and the scene is never cleared. */}
      <select
        aria-label="Scene preset"
        value=""
        onChange={(e) => {
          const v = e.target.value;
          if (!v) return;
          // A generator is not a preset: it opens a dialog and builds a
          // board from the stock already on the bench. It lives in this
          // list because this is where someone looks for "start me off
          // with something", which is what it is.
          if (v.startsWith('generator:')) { openPatternGenerator(v.slice('generator:'.length)); return; }
          const applyPresetLoad = () => {
            if (v.startsWith('user:')) loadUserPresetWithCard(v);
            else loadPresetWithCard(v);
          };
          if (hasUnsavedWork()) {
            openDialog({
              title: 'Replace the current scene?',
              confirmLabel: 'Replace scene',
              tone: 'amber',
              body: <p>Its unsaved changes, note cards and copilot chat will be lost.</p>,
              onCancel: () => closeDialog(),
              onConfirm: () => {
                closeDialog();
                applyPresetLoad();
              },
            });
            return;
          }
          applyPresetLoad();
        }}
        className="bg-transparent text-slate-700 dark:text-slate-100 text-xs rounded-md block px-2 py-1 outline-none font-medium cursor-pointer border-none max-lg:flex-1 max-lg:min-w-0"
      >
        <option value="" disabled hidden>{activePresetLabel}</option>
        <optgroup label="⬜ Built-in Presets" className="bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300">
          {Object.entries(PRESETS as Record<string, PresetEntry>).map(([id, p]) => (
            <option key={id} value={id}>{p.emoji ? `${p.emoji} ` : ''}{p.name}</option>
          ))}
        </optgroup>

        {/* Generators: patterns built to the size of the stock, not saved scenes. */}
        <optgroup label="🔧 Generators" className="bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300">
          {SURFACE_PATTERNS.map((p) => (
            <option key={p.id} value={`generator:${p.id}`}>{p.label}…</option>
          ))}
        </optgroup>

        {/* User Presets */}
        {(() => {
          let keys: string[];
          let inAccountOnly: Set<string>;
          try {
            keys = listUserPresetNames();
            inAccountOnly = new Set(cloudOnlyPresetNames());
          } catch {
            return null;
          }
          if (keys.length === 0) return null;
          return (
            <optgroup label="📁 Saved Presets" className="bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300">
              {keys.sort().map(k => (
                <option key={`user:${k}`} value={`user:${k}`}>{inAccountOnly.has(k) ? '☁️' : '💾'} {k}</option>
              ))}
            </optgroup>
          );
        })()}
      </select>

      {activePreset && activePreset.startsWith('user:') && (
        <>
          <button
            onClick={() => {
              const presetName = activePreset.replace('user:', '');
              saveUserPresetByName(presetName);
            }}
            className="flex items-center justify-center p-1 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors focus:outline-none cursor-pointer"
            title={`Update preset "${activePreset.replace('user:', '')}"`}
          >
            <Save className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => {
              const presetName = activePreset.replace('user:', '');
              openDialog({
                title: `Delete preset "${presetName}"?`,
                confirmLabel: 'Delete preset',
                tone: 'red',
                body: (
                  <p>
                    The saved preset will be removed from your preset list. The scene currently on
                    screen will stay open.
                  </p>
                ),
                onCancel: () => closeDialog(),
                onConfirm: () => {
                  closeDialog();
                  // The preset goes; the scene on screen stays. Loading the
                  // empty scene here wiped the work, notes and chat as well,
                  // which the question above never mentioned.
                  if (deleteUserPreset(presetName)) {
                    useStore.getState().setActivePreset(undefined);
                  } else {
                    showNotice(
                      'Could not delete preset',
                      `Could not delete "${presetName}": this browser would not write the preset list.`,
                      'red',
                    );
                  }
                },
              });
            }}
            className="flex items-center justify-center p-1 rounded-md text-red-500 hover:bg-red-50 dark:hover:bg-red-950/50 transition-colors focus:outline-none cursor-pointer"
            title={`Delete preset "${activePreset.replace('user:', '')}"`}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </>
      )}
    </div>
  );
}
