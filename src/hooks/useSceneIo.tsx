import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store/useStore';
import { useDialogs } from '../store/dialogStore';
import type { SceneGraph } from '../types/scene';
import type { NoteCard } from '../utils/noteCards';
import type { CopilotMessage } from '../physicsGlobals';
import { getSyncedSceneGraph } from '../utils/mujocoSync';
import { exportBaseName } from '../utils/exportBaseName';
import type { SceneDocument } from './useSceneDocument';

/** The scene as a JSON file: written by the header's download button, read by its import button or a drop. */
export function useSceneIo(doc: SceneDocument) {
  const { noteCards, copilotMessages, replaceDocument } = doc;
  const { model, data, mujoco, activePreset, sceneGraph, togglePlay, updateScene } = useStore(useShallow((s) => ({
    model: s.model, data: s.data, mujoco: s.mujoco, activePreset: s.activePreset, sceneGraph: s.sceneGraph,
    togglePlay: s.togglePlay, updateScene: s.updateScene,
  })));
  const showNotice = useDialogs((s) => s.showNotice);
  const openDialog = useDialogs((s) => s.openDialog);
  const closeDialog = useDialogs((s) => s.closeDialog);

  const exportJson = useCallback(() => {
    try {
      const syncedScene = getSyncedSceneGraph(sceneGraph, model, data, mujoco);
      const dataStr = JSON.stringify({ ...syncedScene, noteCards, copilotMessages }, null, 2);
      const blob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${exportBaseName(noteCards, activePreset)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Failed to export JSON', e);
      showNotice('Export failed', 'Failed to export JSON.', 'red');
    }
  }, [sceneGraph, model, data, mujoco, noteCards, copilotMessages, activePreset, showNotice]);

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
      parsed = JSON.parse(text);
    } catch {
      showNotice('Could not read file', `Could not read ${fileName}: it is not valid JSON.`, 'red');
      return;
    }
    if (!parsed || !Array.isArray(parsed.nodes)) {
      showNotice('Invalid scene file', `${fileName} is not a scene: it has no "nodes" array.`, 'red');
      return;
    }
    const applyImport = () => {
      const s = useStore.getState();
      if (s.isPlaying) togglePlay();
      s.setSculptNodeId(null);
      s.setLatticeNodeId(null);
      s.setActivePreset(undefined);
      updateScene(parsed as SceneGraph);
      const notes = Array.isArray(parsed.noteCards) ? parsed.noteCards as NoteCard[] : [];
      const chat = Array.isArray(parsed.copilotMessages) ? parsed.copilotMessages as CopilotMessage[] : [];
      replaceDocument(notes, chat);
    };
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
  }, [togglePlay, updateScene, replaceDocument, showNotice, openDialog, closeDialog]);

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
