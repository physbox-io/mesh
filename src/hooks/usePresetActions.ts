import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store/useStore';
import { useDialogs } from '../store/dialogStore';
import { PRESETS } from '../presets/presetScenes';
import { makePresetNoteCard, type NoteCard } from '../utils/noteCards';
import type { CopilotMessage } from '../physicsGlobals';
import { readUserPreset, ensureUserPreset, USER_PRESETS_CHANGED_EVENT } from '../utils/userPresets';
import { savePreset } from '../utils/presetStorage';
import { announcePresetSave } from '../utils/presetNotices';
import { cloudAutosave } from '../utils/cloudDocuments';
import { getSyncedSceneGraph } from '../utils/mujocoSync';
import { packMeshArrays } from '../utils/meshPacking';
import type { SceneDocument } from './useSceneDocument';
import { recordRecent } from '../utils/sceneMeta';
import { openingScene } from '../store/sceneLoadStore';
import { captureViewportThumb } from '../utils/viewportCapture';

export type PresetEntry = { name: string; emoji?: string };

/**
 * Loading and saving presets: built-in and user presets in with their note
 * cards and chat, the save dialog (and Ctrl+S for it), and the cloud
 * auto-save that follows every edit.
 */
export function usePresetActions(doc: SceneDocument) {
  const { noteCards, copilotMessages, markClean, replaceDocument } = doc;
  const { mujoco, activePreset, sceneGraph, loadPreset } = useStore(useShallow((s) => ({
    mujoco: s.mujoco, activePreset: s.activePreset,
    sceneGraph: s.sceneGraph, loadPreset: s.loadPreset,
  })));
  const showNotice = useDialogs((s) => s.showNotice);

  const [isSaveModalOpen, setIsSaveModalOpen] = useState(false);
  const [presetNameInput, setPresetNameInput] = useState('');
  // The preset list reads storage during render, so a pull from the account or
  // a save that only the account could take has to ask for a render to show up.
  const [, setPresetListVersion] = useState(0);
  useEffect(() => {
    const bump = () => setPresetListVersion(v => v + 1);
    window.addEventListener(USER_PRESETS_CHANGED_EVENT, bump);
    return () => window.removeEventListener(USER_PRESETS_CHANGED_EVENT, bump);
  }, []);

  // The open scene's name, on the button that opens the scene browser.
  const activePresetLabel = useMemo(() => {
    if (!activePreset) return '✏️ Modified scene';
    if (activePreset.startsWith('user:')) return `💾 ${activePreset.replace('user:', '')}`;
    const preset = PRESETS[activePreset as keyof typeof PRESETS] as PresetEntry | undefined;
    if (!preset) return '✏️ Modified scene';
    return `${preset.emoji ? `${preset.emoji} ` : ''}${preset.name}`;
  }, [activePreset]);

  // Load a preset and replace the note card with the preset's built-in card (if any)
  const loadPresetWithCard = useCallback((name: string) => {
    const preset = PRESETS[name as keyof typeof PRESETS] as PresetEntry | undefined;
    void openingScene(preset?.name ?? name, () => {
      loadPreset(name);
      return true;
    });
    recordRecent(name);
    const builtinKey = name.startsWith('user:') ? null : name;
    const presetCard = builtinKey ? makePresetNoteCard(builtinKey) : null;
    replaceDocument(presetCard ? [presetCard] : [], []);
  }, [loadPreset, replaceDocument]);

  // Also load note cards from user presets (stored alongside the scene)
  const loadUserPresetWithCard = useCallback(async (name: string) => {
    const label = name.replace(/^user:/, '');
    // The pill stays up until the scene is drawn; the notes and chat swap in as the load starts.
    await openingScene(label, async () => {
      // A preset listed from the account has its data fetched on first open.
      if (!(await ensureUserPreset(name))) {
        showNotice('Could not open preset', `"${label}" could not be fetched from your account. Check the connection and try again.`, 'red');
        return false;
      }
      loadPreset(name);
      recordRecent(name.startsWith('user:') ? name : `user:${name}`);
      let notes: NoteCard[] = [];
      let chat: CopilotMessage[] = [];
      try {
        const saved = readUserPreset(name);
        if (saved && Array.isArray(saved.noteCards)) notes = saved.noteCards;
        if (saved && Array.isArray(saved.copilotMessages)) chat = saved.copilotMessages as CopilotMessage[];
      } catch {
        // Unreadable: it loads with no notes or chat, as before.
      }
      replaceDocument(notes, chat);
      return true;
    });
  }, [loadPreset, replaceDocument, showNotice]);

  const saveUserPresetByName = useCallback((name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const { model, data } = useStore.getState();
      const syncedScene = getSyncedSceneGraph(sceneGraph, model, data, mujoco);
      // The picture for the scene browser, of the scene being saved.
      const thumbnail = captureViewportThumb();
      const preset = { ...syncedScene, noteCards, copilotMessages, ...(thumbnail ? { thumbnail } : {}) };
      /*
       * Through savePreset, which says what happened: the browser's storage is
       * a few megabytes and a sculpted scene can be one of them. This used to
       * ignore a failed write and then load the preset "just saved" — which,
       * re-saving under an existing name, put the OLD copy over the work on
       * screen. And a save that worked is not a load either: the scene on
       * screen already is the preset, so it is only named as one, leaving the
       * tools open and the camera where it was.
       */
      void savePreset(trimmed, preset).then((result) => {
        announcePresetSave(trimmed, preset, result);
        if (result.ok) {
          recordRecent(`user:${trimmed}`);
          useStore.getState().setActivePreset(`user:${trimmed}`);
          markClean(noteCards, copilotMessages);
        }
      });
      // A deliberate save is also a named revision of the cloud document, which
      // the pruner never discards — unlike the automatic checkpoints.
      void cloudAutosave.saveExplicit(trimmed, packMeshArrays(preset), `Saved as “${trimmed}”`);
    } catch (e) {
      console.error('Failed to save user preset', e);
      showNotice('Could not save preset', `Could not save "${trimmed}": ${e instanceof Error ? e.message : String(e)}`, 'red');
    }
  }, [sceneGraph, mujoco, noteCards, copilotMessages, markClean, showNotice]);

  /*
   * Cloud auto-save.
   *
   * The scene being worked on has never been persisted anywhere: presets are saved
   * on purpose, and a reload drops back to a blank scene. This offers it to
   * the account after every edit.
   *
   * It has to live in a component rather than in the store or in userPresets.ts,
   * because the serialised form is `getSyncedSceneGraph(...)` — the same function
   * the manual save and the JSON export use, so an auto-saved scene is
   * byte-for-byte what saving by hand would have produced — and the note cards and
   * chat it carries are component state (see useSceneDocument).
   *
   * Depending on `sceneGraph` rather than on simulation state is deliberate: the
   * graph changes when somebody edits the scene, which is what is worth saving.
   * Positions changing sixty times a second while a simulation runs are not edits.
   *
   * `cloudAutosave` does nothing at all unless the account is signed in with Pro,
   * and every local save path is untouched, so nothing here is load-bearing.
   */
  useEffect(() => {
    if (!mujoco) return;
    try {
      const name = activePreset?.startsWith('user:') ? activePreset.slice('user:'.length) : 'Untitled scene';
      // Built only when the save actually serialises it: with auto-save off, or
      // inside the coalescing window, cloning the scene here was wasted work.
      cloudAutosave.schedule(name, () => {
        const { model, data } = useStore.getState();
        return packMeshArrays({
          ...getSyncedSceneGraph(sceneGraph, model, data, mujoco),
          noteCards,
          copilotMessages,
        });
      });
    } catch {
      // A scene that cannot be synced cannot be saved to anything; the local paths
      // have the same problem and there is nothing useful to add here.
    }
  }, [sceneGraph, noteCards, copilotMessages, mujoco, activePreset]);

  const handleSavePresetClick = useCallback(() => {
    const defaultName = activePreset && activePreset.startsWith('user:')
      ? activePreset.replace('user:', '')
      : '';
    setPresetNameInput(defaultName);
    setIsSaveModalOpen(true);
  }, [activePreset]);

  // Ctrl+S opens the save dialog, named for the preset that is open, rather
  // than the browser's "Save page as", which saves the app's HTML and none of
  // the scene. Everywhere, fields included: the browser's dialog is no more
  // use from inside one.
  const savePresetClickRef = useRef(handleSavePresetClick);
  useEffect(() => {
    savePresetClickRef.current = handleSavePresetClick;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 's') return;
      e.preventDefault();
      savePresetClickRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleConfirmSavePreset = useCallback(() => {
    // Enter with no name used to close the dialog as if it had saved; the
    // Save button is already disabled for that.
    if (!presetNameInput.trim()) return;
    saveUserPresetByName(presetNameInput);
    setIsSaveModalOpen(false);
    setPresetNameInput('');
  }, [presetNameInput, saveUserPresetByName]);

  return {
    activePresetLabel,
    loadPresetWithCard, loadUserPresetWithCard, saveUserPresetByName,
    handleSavePresetClick,
    saveModal: {
      isOpen: isSaveModalOpen,
      name: presetNameInput,
      setName: setPresetNameInput,
      close: () => setIsSaveModalOpen(false),
      confirm: handleConfirmSavePreset,
    },
  };
}

export type PresetActions = ReturnType<typeof usePresetActions>;
