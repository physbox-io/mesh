import { Save, Trash2, FolderOpen, ChevronDown } from 'lucide-react';
import { useEffect } from 'react';
import { useStore } from '../../store/useStore';
import { useDialogs } from '../../store/dialogStore';
import { usePanels, type SceneBrowserTab } from '../../store/panelsStore';
import { listRecent } from '../../utils/sceneMeta';
import { deleteUserPreset, listUserPresetNames } from '../../utils/userPresets';
import type { PresetActions } from '../../hooks/usePresetActions';

/** Where the browser opens: what was opened lately, else your own scenes, else the examples. */
function firstTab(): SceneBrowserTab {
  if (listRecent().length > 0) return 'recent';
  try { if (listUserPresetNames().length > 0) return 'mine'; } catch { /* the examples, then */ }
  return 'examples';
}

/**
 * The open scene's name, which opens the scene browser, with Update and
 * Delete beside it while a saved scene of the user's is open.
 */
export function PresetPicker({ presets }: { presets: PresetActions }) {
  const { activePresetLabel, saveUserPresetByName } = presets;
  const activePreset = useStore((s) => s.activePreset);
  const openSceneBrowser = usePanels((s) => s.openSceneBrowser);
  // Ctrl+O opens the browser, rather than the browser's own "Open file",
  // which would load a file as a page and leave the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'o') return;
      e.preventDefault();
      openSceneBrowser(firstTab());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openSceneBrowser]);
  const openDialog = useDialogs((s) => s.openDialog);
  const closeDialog = useDialogs((s) => s.closeDialog);
  const showNotice = useDialogs((s) => s.showNotice);
  return (
    <div className="flex items-center min-w-0 max-lg:flex-1 bg-slate-100 dark:bg-slate-800/80 p-0.5 rounded-lg border border-slate-200/80 dark:border-slate-700/60 shadow-inner">
      {/* The current scene's name, and the way to every other one. A button
          rather than the <select> it replaced: the select had grown to eighty
          entries, generators included, and could not search. */}
      <button
        onClick={() => openSceneBrowser(firstTab())}
        className="flex items-center gap-1.5 min-w-0 lg:w-[19.5rem] max-lg:flex-1 px-2 py-1 rounded-md text-xs font-medium text-slate-700 dark:text-slate-100 hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer"
        title="Open a scene, an example or a pattern board (Ctrl+O)"
        aria-label="Open scene"
      >
        <FolderOpen className="w-3.5 h-3.5 shrink-0 text-slate-500 dark:text-slate-400" />
        <span className="truncate flex-1 text-left">{activePresetLabel}</span>
        <ChevronDown className="w-3 h-3 shrink-0 text-slate-400" />
      </button>

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
