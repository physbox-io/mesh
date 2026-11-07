import { useCallback, useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store/useStore';
import { useDialogs } from '../store/dialogStore';
import type { SceneGraph } from '../types/scene';
import type { NoteCard } from '../utils/noteCards';
import type { CopilotMessage } from '../physicsGlobals';
import { getSyncedSceneGraph } from '../utils/mujocoSync';
import { withEnvironment } from '../store/sceneEnvironment';
import { packMeshArrays, unpackMeshArrays } from '../utils/meshPacking';
import { exportBaseName } from '../utils/exportBaseName';
import { cloudAutosave } from '../utils/cloudDocuments';
import { listUserPresetNames } from '../utils/userPresets';
import type { SceneDocument } from './useSceneDocument';

/** The scene as a JSON file: written by the header's download button, read by its import button or a drop. */
export function useSceneIo(doc: SceneDocument) {
  const { noteCards, copilotMessages, replaceDocument, markUnsaved, hasUnsavedWork } = doc;
  const { model, data, mujoco, activePreset, sceneGraph, togglePlay, updateScene } = useStore(useShallow((s) => ({
    model: s.model, data: s.data, mujoco: s.mujoco, activePreset: s.activePreset, sceneGraph: s.sceneGraph,
    togglePlay: s.togglePlay, updateScene: s.updateScene,
  })));
  const showNotice = useDialogs((s) => s.showNotice);
  const openDialog = useDialogs((s) => s.openDialog);
  const closeDialog = useDialogs((s) => s.closeDialog);

  const exportJson = useCallback(() => {
    try {
      const syncedScene = withEnvironment(getSyncedSceneGraph(sceneGraph, model, data, mujoco), useStore.getState());
      const dataStr = JSON.stringify(packMeshArrays({ ...syncedScene, noteCards, copilotMessages }), null, 2);
      const blob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${exportBaseName(noteCards, activePreset, useStore.getState().sceneGraph.name)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Failed to export JSON', e);
      showNotice('Export failed', 'Failed to export JSON.', 'red');
    }
  }, [sceneGraph, model, data, mujoco, noteCards, copilotMessages, activePreset, showNotice]);

  // Puts a scene on screen, in place of whatever was: from a file, or from the account.
  const showScene = useCallback((parsed: { noteCards?: unknown; copilotMessages?: unknown }) => {
    const s = useStore.getState();
    if (s.isPlaying) togglePlay();
    s.setSculptNodeId(null);
    s.setLatticeNodeId(null);
    s.setActivePreset(undefined);
    // The notes and chat are the document's, not the graph's.
    const { noteCards, copilotMessages, ...graph } = parsed;
    updateScene(graph as SceneGraph);
    const notes = Array.isArray(noteCards) ? noteCards as NoteCard[] : [];
    const chat = Array.isArray(copilotMessages) ? copilotMessages as CopilotMessage[] : [];
    replaceDocument(notes, chat);
  }, [togglePlay, updateScene, replaceDocument]);

  // Unsaved work from the last session comes back as it was left: unsaved, and
  // on the preset it was an edit of, so saving it saves over that preset.
  const unsavedWorkRef = useRef(hasUnsavedWork);
  useEffect(() => {
    unsavedWorkRef.current = hasUnsavedWork;
  });
  useEffect(() => {
    cloudAutosave.connectDocument(() => unsavedWorkRef.current(), (draft, name) => {
      showScene(draft as { noteCards?: unknown; copilotMessages?: unknown });
      if (listUserPresetNames().includes(name)) useStore.getState().setActivePreset(`user:${name}`);
      markUnsaved();
    });
  }, [showScene, markUnsaved]);

  /*
   * Opens a scene file, from the Import button or dropped on the viewport.
   *
   * A drop used to take its own path: a bad file did nothing but log, a good
   * one replaced the scene without asking — a file dragged across the window
   * by accident took the work with it — and neither stopped the simulation or
   * the old chat. And after either, the app still took the imported scene for
   * the preset that had been open, so the Save button overwrote that preset
   * with it. The scene is no preset now until it is saved as one.
   */
  const importSceneJson = useCallback((text: string, fileName: string, dropped: boolean) => {
    let parsed: { nodes?: unknown; noteCards?: unknown; copilotMessages?: unknown } | null;
    try {
      parsed = unpackMeshArrays(JSON.parse(text));
    } catch {
      showNotice('Could not read file', `Could not read ${fileName}: it is not valid JSON.`, 'red');
      return;
    }
    if (!parsed || !Array.isArray(parsed.nodes)) {
      showNotice('Invalid scene file', `${fileName} is not a scene: it has no "nodes" array.`, 'red');
      return;
    }
    const applyImport = () => showScene(parsed);
    if (dropped) {
      openDialog({
        title: `Replace the current scene with ${fileName}?`,
        confirmLabel: 'Replace scene',
        tone: 'amber',
        body: <p>The current scene on screen will be replaced by the imported file.</p>,
        onCancel: closeDialog,
        onConfirm: () => {
          closeDialog();
          applyImport();
        },
      });
      return;
    }
    applyImport();
  }, [showScene, showNotice, openDialog, closeDialog]);

  const importJson = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e: Event) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      void file.text().then((text) => importSceneJson(text, file.name, false));
    };
    input.click();
  }, [importSceneJson]);

  return { exportJson, importSceneJson, importJson };
}
