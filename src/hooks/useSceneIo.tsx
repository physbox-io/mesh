import { useCallback, useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store/useStore';
import { useDialogs } from '../store/dialogStore';
import type { SceneGraph } from '../types/scene';
import type { NoteCard } from '../utils/noteCards';
import type { CopilotMessage } from '../physicsGlobals';
import { getSyncedSceneGraph } from '../utils/mujocoSync';
import { DEFAULT_ENVIRONMENT, takeEnvironment, withEnvironment } from '../store/sceneEnvironment';
import { withCastPrepBypass } from '../store/editGuard';
import { promoteJointedMeshGeomsDeep } from '../store/meshGeomTransforms';
import { clearBreakage } from '../store/breakage';
import { framingPatch } from '../store/sceneFraming';
import { getPhysicsWorkerClient, onNextPaint, silenceAllLiveAcoustics } from '../store/physicsEngine';
import { applySceneSound } from '../store/sceneSwapActions';
import { packMeshArrays, unpackMeshArrays } from '../utils/meshPacking';
import { exportBaseName } from '../utils/exportBaseName';
import { cloudAutosave } from '../utils/cloudDocuments';
import { listUserPresetNames } from '../utils/userPresets';
import type { SceneDocument } from './useSceneDocument';

let importSwapSeq = 0;

/** Validates that a JSON scene's `nodes` tree contains well-formed SceneNode objects recursively. */
export function validateSceneNodes(nodes: unknown): string | null {
  if (!Array.isArray(nodes)) return 'it has no "nodes" array.';
  const walk = (list: unknown[], path: string): string | null => {
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return `node at ${path}[${i}] is not an object.`;
      }
      const n = item as Record<string, unknown>;
      if (typeof n.id !== 'string' || !n.id.trim()) {
        return `node at ${path}[${i}] is missing a valid "id".`;
      }
      if (!Array.isArray(n.geoms) || n.geoms.some((g) => !g || typeof g !== 'object' || Array.isArray(g))) {
        return `node "${n.id}" has an invalid "geoms" array.`;
      }
      if (!Array.isArray(n.children)) {
        return `node "${n.id}" has an invalid "children" array.`;
      }
      const childErr = walk(n.children, `${path}[${i}].children`);
      if (childErr) return childErr;
    }
    return null;
  };
  return walk(nodes, 'nodes');
}

/**
 * Replaces the live store scene with a loaded JSON file or restored cloud draft,
 * bypassing Cast-Prep edit guards, stripping file-only metadata, promoting jointed
 * meshes, resetting environment/breakage/tools, force-resetting physics, and framing.
 */
export function applyLoadedSceneToStore(parsed: {
  noteCards?: unknown;
  copilotMessages?: unknown;
  thumbnail?: unknown;
  savedAt?: unknown;
  [key: string]: unknown;
}): { notes: NoteCard[]; chat: CopilotMessage[] } {
  const {
    noteCards: rawNotes,
    copilotMessages: rawChat,
    thumbnail: _thumbnail,
    savedAt: _savedAt,
    ...rawGraph
  } = parsed;
  const { graph: cleanGraph, environment } = takeEnvironment(rawGraph as unknown as SceneGraph);
  if (Array.isArray(cleanGraph.nodes)) {
    promoteJointedMeshGeomsDeep(cleanGraph.nodes);
  }
  const nextEnv = environment ?? DEFAULT_ENVIRONMENT;

  withCastPrepBypass(() => {
    const s = useStore.getState();
    const outgoing = s.outgoingSceneGraph ?? s.sceneGraph;
    silenceAllLiveAcoustics();
    if (typeof Worker !== 'undefined') getPhysicsWorkerClient().setPlaying(false);
    clearBreakage((patch) => useStore.setState(patch));
    // Route scene + environment through updateScene(skipRecompile=true) so undo snapshots
    // the outgoing scene/environment and sharingUnchangedNodes middleware normalizes the graph.
    s.updateScene({ ...cleanGraph, environment: nextEnv }, true);
    useStore.setState({
      isPlaying: false,
      activePreset: undefined,
      selectedNodeId: null,
      extraSelectedIds: [],
      hiddenNodeIds: [],
      carveSettings: null,
      cameraOverride: null,
      patternGeneratorId: null,
      facePatternTarget: null,
      latticeNodeId: null,
      latticeStats: null,
      latticeSelection: null,
      cutSpot: null,
      sculptNodeId: null,
      sculptStats: null,
      gestureStatus: null,
      measureMode: null,
      castPrepGuardOpen: false,
      outgoingSceneGraph: outgoing,
    });
    const installed = useStore.getState().sceneGraph;
    applySceneSound(installed);
    const swap = ++importSwapSeq;
    const build = Promise.resolve(useStore.getState().recompile(installed, null, true, true));
    const finish = () => onNextPaint(() => {
      if (swap !== importSwapSeq) return;
      useStore.setState((state) => ({
        outgoingSceneGraph: null,
        cameraResetToken: state.cameraResetToken + 1,
        ...framingPatch(installed, null),
      }));
    });
    void build.then(finish, finish);
  });

  return {
    notes: Array.isArray(rawNotes) ? rawNotes as NoteCard[] : [],
    chat: Array.isArray(rawChat) ? rawChat as CopilotMessage[] : [],
  };
}

/** The scene as a JSON file: written by the header's download button, read by its import button or a drop. */
export function useSceneIo(doc: SceneDocument) {
  const { noteCards, copilotMessages, replaceDocument, markUnsaved, hasUnsavedWork } = doc;
  const { model, data, mujoco, activePreset, sceneGraph } = useStore(useShallow((s) => ({
    model: s.model, data: s.data, mujoco: s.mujoco, activePreset: s.activePreset, sceneGraph: s.sceneGraph,
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
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      console.error('Failed to export JSON', e);
      showNotice('Export failed', 'Failed to export JSON.', 'red');
    }
  }, [sceneGraph, model, data, mujoco, noteCards, copilotMessages, activePreset, showNotice]);

  // Puts a scene on screen, in place of whatever was: from a file, or from the account.
  const showScene = useCallback((parsed: { noteCards?: unknown; copilotMessages?: unknown; [key: string]: unknown }) => {
    const { notes, chat } = applyLoadedSceneToStore(parsed);
    replaceDocument(notes, chat);
  }, [replaceDocument]);

  // Unsaved work from the last session comes back as it was left: unsaved, and
  // on the preset it was an edit of, so saving it saves over that preset.
  const unsavedWorkRef = useRef(hasUnsavedWork);
  useEffect(() => {
    unsavedWorkRef.current = hasUnsavedWork;
  });
  useEffect(() => {
    cloudAutosave.connectDocument(() => unsavedWorkRef.current(), (draft, name) => {
      showScene(draft as { noteCards?: unknown; copilotMessages?: unknown; [key: string]: unknown });
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
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      showNotice('Could not read file', `Could not read ${fileName}: it is not valid JSON.`, 'red');
      return;
    }
    let parsed: { nodes?: unknown; noteCards?: unknown; copilotMessages?: unknown; [key: string]: unknown } | null;
    try {
      parsed = unpackMeshArrays(raw) as { nodes?: unknown; noteCards?: unknown; copilotMessages?: unknown; [key: string]: unknown } | null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'its mesh data is invalid.';
      showNotice('Invalid scene file', `Could not open ${fileName}: ${msg}`, 'red');
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      showNotice('Invalid scene file', `${fileName} is not a scene: expected a JSON object.`, 'red');
      return;
    }
    const nodeError = validateSceneNodes(parsed.nodes);
    if (nodeError) {
      showNotice('Invalid scene file', `${fileName} is not a valid scene: ${nodeError}`, 'red');
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
      void file.text()
        .then((text) => importSceneJson(text, file.name, false))
        .catch((err) => {
          console.error('Failed to read JSON file', err);
          showNotice('Could not read file', `Could not read ${file.name}.`, 'red');
        });
    };
    input.click();
  }, [importSceneJson, showNotice]);

  return { exportJson, importSceneJson, importJson };
}
