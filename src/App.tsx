
import { Canvas } from '@react-three/fiber';
import { Grid, Environment, Lightformer } from '@react-three/drei';
import { DEFAULT_EYE } from './utils/frameScene';
import { EffectComposer, N8AO } from '@react-three/postprocessing';
import SculptPanel from './components/SculptPanel';
import LatticePanel from './components/LatticePanel';
import { LeftSidebar } from './components/palette/LeftSidebar';
import { InspectorPanel } from './components/inspector/InspectorPanel';
import { useSelectedNode } from './hooks/useSelectedNode';
import { useMuJoCoInit } from './hooks/useMuJoCo';
import { useMCPBridge } from './hooks/useMCPBridge';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from './store/useStore';
import { applyShatterPieces } from './store/useStore';
import type { SceneGraph, SceneNode } from './types/scene';
import type { WeakSpot } from './utils/printAnalysis';
import { Play, Square, Settings, Box, X, RotateCcw, Trash2, Zap, Info, Code, Menu, Save, Download, Upload, Undo, Redo, PanelRight, Printer, Sparkles, Sun, Moon, Grid3x3, Image as ImageIcon, Share2, Copy, Check, Aperture } from 'lucide-react';
import { useRef, useMemo, useEffect, useLayoutEffect, useCallback, useState, type ComponentRef } from 'react';
import AICopilotPanel from './components/AICopilotPanel';
import { DocsModal } from './components/docs/DocsModal';
import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { exportThreeMf, type ThreeMfMesh } from './utils/threeMfExporter';
import { loadCompiler, setScadCompileListener } from './utils/openscad';
import { useCsgAutoCompile } from './hooks/useCsgCompile';
import { PRESETS } from './presets/presetScenes';
import { makePresetNoteCard, type NoteCard } from './utils/noteCards';
import { physicsGlobals, type CopilotMessage } from './physicsGlobals';
import { ImportStlModal } from './components/ImportStlModal';
import { ImportImageModal } from './components/ImportImageModal';
import { GeneratePatternModal } from './components/GeneratePatternModal';
import { FacePatternModal } from './components/FacePatternModal';
import { SURFACE_PATTERNS } from './utils/surfacePatterns';
import { ExportLaserCutModal } from './components/ExportLaserCutModal';
import { ExportContourSliceModal } from './components/ExportContourSliceModal';
import { ExportReliefCarveModal } from './components/ExportReliefCarveModal';
import { ExportMoldModal } from './components/ExportMoldModal';
import { ExportSolidMachiningModal } from './components/ExportSolidMachiningModal';
import { ExportCastModal } from './components/ExportCastModal';
import { SplitForPrintModal } from './components/SplitForPrintModal';
import { MarqueeSelect } from './components/scene/MarqueeSelect';
import { layoutOnBed, type PosedPart } from './utils/printPlate';
import { PulleyRopeMarkers } from './components/scene/PulleyRopes';
import { SliderValue } from './components/SliderValue';
import { RangeInput } from './components/RangeInput';
import { ExportScaleModal } from './components/ExportScaleModal';
import { downloadBlob } from './utils/downloadBlob';
import { ConfirmModal } from './components/ConfirmModal';
import { CompileErrorBanner } from './components/CompileErrorBanner';
import { VoltLinkBanner } from './components/VoltLinkBanner';
import { useVoltLink } from './hooks/useVoltLink';
import { ObjectGestureController } from './components/scene/ObjectGestures';
import { TransformGizmo } from './components/scene/TransformGizmo';
import { isGizmoBusy } from './components/scene/gizmoBusy';
import { MeasureTool } from './components/scene/MeasureTool';
import { DimensionOverlay } from './components/scene/DimensionOverlay';
import { EdgeRoundTool } from './components/scene/EdgeRoundTool';
import { EdgeRoundPanel } from './components/EdgeRoundPanel';
import {
  PaintStrokeController, CameraController, DragInteractionController,
  SceneCapture, SceneVisuals,
  LatticeEditorLayer,
} from './components/scene/SceneLayer';
import { BottomStatusBar, SHOW_EXPORTS_EVENT } from './components/BottomStatusBar';
import { MachineConfigModal } from './components/MachineConfigModal';
import { UserProfileButton, SIGN_IN_REQUESTED_EVENT, SIGNED_IN_EVENT } from './components/UserProfileButton';
import { AgentMachineBanner } from './components/AgentMachineBanner';
import { JobRestoreModal } from './components/JobRestoreModal';
import { JobSucceededModal } from './components/JobSucceededModal';
import { MIN_MAX_TOKENS, MAX_MAX_TOKENS, readMaxTokens, writeMaxTokens } from './utils/llmSettings';
import { DfmHUD } from './components/DfmHUD';
import { pushGlobalParameter } from './utils/llmSettings';
import { saveUserPreset, deleteUserPreset, readUserPreset, listUserPresetNames, cloudOnlyPresetNames, USER_PRESETS_CHANGED_EVENT } from './utils/userPresets';
import { savePreset } from './utils/presetStorage';
import { announcePresetSave } from './utils/presetNotices';
import { PresetSaveNotice } from './components/PresetSaveNotice';
import { createPortal } from 'react-dom';
import {
  buildShareLink,
  readShareLink,
  clearShareFragment,
  buildAccountShareLink,
  canShareViaAccount,
  shareTokenInUrl,
  readAccountShareLink,
  clearShareToken,
  ShareTooLargeError,
  type ShareLink,
  type SharedScene,
} from './utils/shareLink';
import { revokeShare, isProRequired } from './utils/apiClient';
import { cloudAutosave } from './utils/cloudDocuments';
import { pushAppParameter } from './utils/cloudSync';
import { useEscapeToClose } from './hooks/useEscapeToClose';
import { getSyncedSceneGraph } from './utils/mujocoSync';
import { pressHistoryKey } from './utils/historyKeys';
import { NoteCardOverlay } from './components/NoteCardOverlay';
import { AxisLegendDrawer } from './components/AxisLegendDrawer';
import { DropHandler } from './components/DropHandler';
import { PhysicsLoop } from './components/scene/PhysicsLoop';
import { RenderOnChange } from './components/scene/RenderOnChange';
import { GridFadeFollowsCamera } from './components/scene/GridFadeFollowsCamera';
import { GRID_NAME } from './components/scene/gridConstants';
import { anthropicUrl, geminiUrl } from './utils/llmEndpoints';
import { BodyToneMapping } from './components/scene/BodyToneMapping';
import { StudioBackdrop } from './components/scene/StudioBackdrop';
import { useViewQuality, usePathTraceStatus } from './store/viewQualityStore';
import { usePanels } from './store/panelsStore';
import { SelectionOutline } from './components/scene/SelectionOutline';
import { PathTracedView } from './components/scene/PathTracedView';

type PresetEntry = { name: string; emoji?: string };
type GeminiModelInfo = { name: string; displayName?: string; supportedGenerationMethods?: string[] };

// The status bar's "SCAD Compiling" pill counts compiles in flight. openscad.ts
// reports them through a listener rather than importing the store; see there.
setScadCompileListener((delta) => {
  const s = useStore.getState();
  if (delta > 0) s.incrementScadCompile();
  else s.decrementScadCompile();
});

/** Marks a clean point whose undo step has not landed yet. See markClean. */
const PENDING_CLEAN = Symbol('pending');

/**
 * The pose the app opens in, before any scene has been framed. 45° of vertical
 * FOV at DEFAULT_EYE puts about 250 mm of world across the window — the size of
 * the parts made here — where it used to put 660 mm and draw everything at
 * roughly two fifths the size. See utils/frameScene.
 */
const CAMERA_CONFIG = { position: DEFAULT_EYE, fov: 45, near: 0.01, far: 1000 };

function App() {
  useMuJoCoInit();
  const hiRes = useViewQuality(s => s.hiRes);
  const setHiRes = useViewQuality(s => s.setHiRes);
  const pathTrace = useViewQuality(s => s.pathTrace);
  const setPathTrace = useViewQuality(s => s.setPathTrace);
  const pathTracePhase = usePathTraceStatus(s => s.phase);
  const pathTraceSamples = usePathTraceStatus(s => s.samples);
  const keyLightRef = useRef<THREE.DirectionalLight>(null);
  // three allocates a shadow map once and never resizes it, so a new mapSize
  // only takes once the old map is gone. Layout effect: the frame the switch
  // asked for must find the map already dropped.
  useLayoutEffect(() => {
    const shadow = keyLightRef.current?.shadow;
    if (!shadow?.map) return;
    shadow.map.dispose();
    shadow.map = null;
  }, [hiRes]);
  const [darkMode, setDarkMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('physics_dark_mode') === 'true';
    }
    return false;
  });

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('physics_dark_mode', 'true');
      pushAppParameter('physics_dark_mode', 'true');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('physics_dark_mode', 'false');
      pushAppParameter('physics_dark_mode', 'false');
    }
  }, [darkMode]);

  const toggleDarkMode = () => setDarkMode(prev => !prev);

  const isDocsOpen = usePanels((s) => s.isDocsOpen);
  const docsTab = usePanels((s) => s.docsTab);
  const openDocs = usePanels((s) => s.openDocs);
  const setDocsTab = usePanels((s) => s.setDocsTab);
  const closeDocs = usePanels((s) => s.closeDocs);
  useEscapeToClose(isDocsOpen, closeDocs);
  const [showAICopilot, setShowAICopilot] = useState(false);
  const isLeftSidebarOpen = usePanels((s) => s.isLeftSidebarOpen);
  const setIsLeftSidebarOpen = usePanels((s) => s.setLeftSidebarOpen);
  const isPropertiesOpen = usePanels((s) => s.isPropertiesOpen);
  const setIsPropertiesOpen = usePanels((s) => s.setPropertiesOpen);
  const [isSaveModalOpen, setIsSaveModalOpen] = useState(false);
  // The preset list reads storage during render, so a pull from the account or
  // a save that only the account could take has to ask for a render to show up.
  const [, setPresetListVersion] = useState(0);
  useEffect(() => {
    const bump = () => setPresetListVersion(v => v + 1);
    window.addEventListener(USER_PRESETS_CHANGED_EVENT, bump);
    return () => window.removeEventListener(USER_PRESETS_CHANGED_EVENT, bump);
  }, []);
  const [isImportStlModalOpen, setIsImportStlModalOpen] = useState(false);
  const [isLaserCutModalOpen, setIsLaserCutModalOpen] = useState(false);
  const [isContourSliceModalOpen, setIsContourSliceModalOpen] = useState(false);
  const [isReliefCarveModalOpen, setIsReliefCarveModalOpen] = useState(false);
  const [isMoldModalOpen, setIsMoldModalOpen] = useState(false);
  const [isSolidModalOpen, setIsSolidModalOpen] = useState(false);
  const [isCastModalOpen, setIsCastModalOpen] = useState(false);
  const [isSplitModalOpen, setIsSplitModalOpen] = useState(false);
  const simFidelity = useStore((s) => s.sceneGraph.simFidelity ?? 'standard');
  const setSimFidelity = useStore((s) => s.setSimFidelity);
  // The machine setup lives in the store rather than in local state: the bottom
  // bar opens it, and the export modals link to it when a job needs a machine
  // that is not connected yet.
  const isMachineConfigOpen = useStore((s) => s.isMachineConfigOpen);
  const setMachineConfigOpen = useStore((s) => s.setMachineConfigOpen);
  const machineTarget = useStore((s) => s.machineTarget);
  const [isImportImageModalOpen, setIsImportImageModalOpen] = useState(false);
  const [droppedImportFile, setDroppedImportFile] = useState<File | null>(null);
  const [droppedImageFile, setDroppedImageFile] = useState<File | null>(null);
  const handleDroppedImportFile = useCallback((file: File) => {
    setDroppedImportFile(file);
    setIsImportStlModalOpen(true);
  }, []);
  const handleDroppedImageFile = useCallback((file: File) => {
    setDroppedImageFile(file);
    setIsImportImageModalOpen(true);
  }, []);
  const [presetNameInput, setPresetNameInput] = useState('');
  // While anything is in pieces the scene on screen is the document with the
  // broken bodies swapped for their shards. See `shatterPieces` in the store.
  const shatteredBodies = useStore((s) => s.visibleShatteredBodies);
  const [noteCards, setNoteCards] = useState<NoteCard[]>(() => {
    const initialPreset = useStore.getState().activePreset;
    if (initialPreset && !initialPreset.startsWith('user:')) {
      const card = makePresetNoteCard(initialPreset);
      return card ? [card] : [];
    }
    return [];
  });
  const [copilotMessages, setCopilotMessages] = useState<CopilotMessage[]>([]);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const axisCanvasRef = useRef<HTMLCanvasElement>(null);

  const [settingsGeminiKey, setSettingsGeminiKey] = useState(() => localStorage.getItem('gemini_api_key') || '');
  const [settingsClaudeKey, setSettingsClaudeKey] = useState(() => localStorage.getItem('anthropic_api_key') || '');
  const [settingsSelectedModel, setSettingsSelectedModel] = useState(() => localStorage.getItem('gemini_model') || 'gemini-3.6-flash');
  const [settingsMaxTokens, setSettingsMaxTokens] = useState(() => readMaxTokens());
  const [liveSettingsClaudeModels, setLiveSettingsClaudeModels] = useState<{ id: string; name: string }[]>([]);
  const [liveSettingsGeminiModels, setLiveSettingsGeminiModels] = useState<{ id: string; name: string }[]>([]);

  const fetchSettingsClaudeModels = async (key: string) => {
    if (!key.trim()) return null;
    const headers = {
      'x-api-key': key.trim(),
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    };
    try {
      const res = await fetch(anthropicUrl('/v1/models'), { headers });
      if (res.ok) {
        const data = await res.json();
        const rawModels = data.data || data.models || [];
        if (Array.isArray(rawModels) && rawModels.length > 0) {
          const formatted = rawModels.map((m: { id: string; name?: string; display_name?: string }) => ({
            id: m.id,
            name: m.display_name || m.name || m.id
          }));
          setLiveSettingsClaudeModels(formatted);
          return formatted;
        }
      }
    } catch (e) {
      console.warn("Failed to fetch Claude models in settings", e);
    }
    return null;
  };

  const fetchSettingsGeminiModels = async (key: string) => {
    if (!key.trim()) return null;
    try {
      const res = await fetch(geminiUrl(`/v1beta/models?key=${key.trim()}`));
      const data = await res.json();
      if (data.models && Array.isArray(data.models)) {
        const validModels = data.models
          .filter((m: GeminiModelInfo) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
          .map((m: GeminiModelInfo) => ({
            id: m.name.replace(/^models\//, ''),
            name: m.displayName || m.name.replace(/^models\//, '')
          }));
        if (validModels.length > 0) {
          setLiveSettingsGeminiModels(validModels);
          return validModels;
        }
      }
    } catch (e) {
      console.warn("Failed to fetch Gemini models in settings", e);
    }
    return null;
  };

  useEffect(() => {
    const syncSettingsState = () => {
      const gk = localStorage.getItem('gemini_api_key') || '';
      const ck = localStorage.getItem('anthropic_api_key') || '';
      const m = localStorage.getItem('gemini_model') || 'gemini-3.6-flash';
      setSettingsGeminiKey(gk);
      setSettingsClaudeKey(ck);
      setSettingsSelectedModel(m);
      setSettingsMaxTokens(readMaxTokens());
      if (gk) fetchSettingsGeminiModels(gk);
      if (ck) fetchSettingsClaudeModels(ck);
    };

    syncSettingsState();
    window.addEventListener('storage', syncSettingsState);
    return () => window.removeEventListener('storage', syncSettingsState);
  }, []);

  const handleUpdateClaudeKeyInSettings = async (newKey: string) => {
    setSettingsClaudeKey(newKey);
    localStorage.setItem('anthropic_api_key', newKey);
    pushGlobalParameter('anthropic_api_key', newKey);
    window.dispatchEvent(new Event('storage'));
    if (newKey.trim()) {
      const live = await fetchSettingsClaudeModels(newKey.trim());
      if (live && live.length > 0) {
        const topModel = live[0].id;
        setSettingsSelectedModel(topModel);
        localStorage.setItem('gemini_model', topModel);
        pushGlobalParameter('gemini_model', topModel);
        window.dispatchEvent(new Event('storage'));
      }
    }
  };

  const handleUpdateGeminiKeyInSettings = async (newKey: string) => {
    setSettingsGeminiKey(newKey);
    localStorage.setItem('gemini_api_key', newKey);
    pushGlobalParameter('gemini_api_key', newKey);
    window.dispatchEvent(new Event('storage'));
    if (newKey.trim()) {
      fetchSettingsGeminiModels(newKey.trim());
    }
  };

  // Expose noteCards and copilotMessages state to MCP bridge and noteCard manager
  useEffect(() => {
    physicsGlobals._physics_getNoteCards = () => noteCards;
    physicsGlobals._physics_setNoteCards = (cards: typeof noteCards) => setNoteCards(cards);
    physicsGlobals._physics_getCopilotMessages = () => copilotMessages;
    physicsGlobals._physics_setCopilotMessages = (msgs: typeof copilotMessages) => setCopilotMessages(msgs);
    physicsGlobals._physics_store = useStore;
  }, [noteCards, copilotMessages]);

  // Only these fields, compared shallowly. A bare useStore() here re-rendered
  // the whole app, viewport included, on every write to any field of the
  // store — the drag target on every pointer move during play among them.
  const { 
    model, data, mujoco, recompileId, activePreset,
    isPlaying, togglePlay, isLoaded, 
    mcpActiveCount, scadCompileCount,
    isSettingsOpen, setSettingsOpen, 
    gravityZ, windX, windY, density, floorFriction, floorBounce, setEnvironment,
    cameraView, setCameraView,
    dimsEnabled, setDimsEnabled, cameraOffAxis,
    dfmEnabled, setDfmEnabled,
    wireframe, toggleWireframe, showEdges, toggleShowEdges, paintMode,
    gridCellSizeMm, setGridCellSizeMm,
    sceneGraph, selectedNodeId, setSelectedNodeId,
    addComponent, loadPreset, openPatternGenerator, updateScene,
    resetSimulation,
    sculptNodeId,
    latticeNodeId,
    extraSelectedIds,
    undoStack, redoStack,
  } = useStore(useShallow((s) => ({
    model: s.model, data: s.data, mujoco: s.mujoco, recompileId: s.recompileId, activePreset: s.activePreset,
    isPlaying: s.isPlaying, togglePlay: s.togglePlay, isLoaded: s.isLoaded,
    mcpActiveCount: s.mcpActiveCount, scadCompileCount: s.scadCompileCount,
    isSettingsOpen: s.isSettingsOpen, setSettingsOpen: s.setSettingsOpen,
    gravityZ: s.gravityZ, windX: s.windX, windY: s.windY, density: s.density, floorFriction: s.floorFriction, floorBounce: s.floorBounce, setEnvironment: s.setEnvironment,
    cameraView: s.cameraView, setCameraView: s.setCameraView,
    dimsEnabled: s.dimsEnabled, setDimsEnabled: s.setDimsEnabled, cameraOffAxis: s.cameraOffAxis,
    dfmEnabled: s.dfmEnabled, setDfmEnabled: s.setDfmEnabled,
    wireframe: s.wireframe, toggleWireframe: s.toggleWireframe, showEdges: s.showEdges, toggleShowEdges: s.toggleShowEdges, paintMode: s.paintMode,
    gridCellSizeMm: s.gridCellSizeMm, setGridCellSizeMm: s.setGridCellSizeMm,
    sceneGraph: s.sceneGraph, selectedNodeId: s.selectedNodeId, setSelectedNodeId: s.setSelectedNodeId,
    addComponent: s.addComponent, loadPreset: s.loadPreset, openPatternGenerator: s.openPatternGenerator, updateScene: s.updateScene,
    resetSimulation: s.resetSimulation,
    sculptNodeId: s.sculptNodeId,
    latticeNodeId: s.latticeNodeId,
    extraSelectedIds: s.extraSelectedIds,
    undoStack: s.undoStack, redoStack: s.redoStack,
  })));

  /*
   * Pre-load the OpenSCAD compiler in the background, so the first boolean is
   * quick — but only once physics is up and the page is idle.
   *
   * It is 11 MB of wasm and 8 MB of fonts. On a fixed two-second timer it went
   * out while MuJoCo's own 9 MB could still be downloading on a slow link, and
   * the scene the user came to see waited behind a compiler it may never need.
   * A scene with booleans in it does not wait for this either way: compiling
   * starts the pool itself.
   */
  useEffect(() => {
    if (!mujoco) return;
    const preload = () => {
      loadCompiler().catch(err => console.warn('Failed to pre-load OpenSCAD compiler in background:', err));
    };
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(preload, { timeout: 10000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = setTimeout(preload, 3000);
    return () => clearTimeout(timer);
  }, [mujoco]);

  // Exactly what the solver was handed, so the picture and the physics cannot
  // disagree about which bodies exist.
  const effectiveGraph = useMemo(
    () => applyShatterPieces(sceneGraph, shatteredBodies),
    [sceneGraph, shatteredBodies],
  );

  const [activeWeakSpot, setActiveWeakSpot] = useState<WeakSpot | null>(null);

  // Keyboard Shortcuts Handler (Delete / Backspace key to delete selected body)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) {
        return;
      }
      if ((e.target as HTMLElement)?.isContentEditable) return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        // Not while a tool has hold of the body. Lattice swallows the key
        // itself; sculpting, painting, measuring and a keyboard gesture did
        // not, so a stray Backspace deleted the body being worked on and threw
        // away its stroke history with it.
        const s = useStore.getState();
        if (s.sculptNodeId || s.latticeNodeId || s.paintMode || s.measureMode || s.gestureStatus) return;
        // Nor from inside a dialog: every modal is a full-screen `fixed inset-0`
        // overlay, and Backspace on one of its buttons deleted the selected
        // body hidden behind it.
        if ((e.target as HTMLElement).closest?.('.fixed.inset-0')) return;
        const ids = [...(s.selectedNodeId ? [s.selectedNodeId] : []), ...s.extraSelectedIds];
        if (ids.length > 0) s.deleteNodes(ids);
        return;
      }

      /*
        Undo and redo on the keyboard.

        There has been an undo BUTTON in the toolbar since the beginning and
        never a shortcut for it, which is the one place a person does not look:
        Ctrl-Z is muscle memory, and when it does nothing the conclusion is that
        the app cannot undo rather than that it is on a button.

        Bubble phase on purpose. The lattice and sculpt tools each keep their own
        history and take Ctrl-Z in the CAPTURE phase while they are open, so
        while you are modelling it takes back modelling; they stop the event only
        when they actually had something to undo, so once their history runs out
        it arrives here and steps the document back instead.
      */
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      // Ctrl-Y as well as Ctrl-Shift-Z: the first is what Windows does, the
      // second is what everything else does, and both are cheap to answer.
      const redoing = key === 'y' || (key === 'z' && e.shiftKey);
      if (!redoing && key !== 'z') return;
      e.preventDefault();
      const store = useStore.getState();
      if (redoing) store.redo();
      else store.undo();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  /**
   * Click a card's h3 to fold it away. Both side panels get this: the palette
   * on the left and the properties inspector on the right are each an
   * `aside.glass-panel`, and the CSS in index.css is written against that
   * selector for both.
   *
   * This used to reach for `querySelector`, which returns only the first match
   * in document order — the left sidebar. The inspector's cards were never
   * wired up at all, so none of its thirty headers folded despite being styled
   * for it.
   *
   * Indicators are injected rather than rendered because the cards are plain
   * JSX all through the inspector. A MutationObserver picks up the ones that
   * mount later (a card revealed by a checkbox, a body selected after this
   * effect ran) — a single timeout only ever caught whatever existed 100ms in.
   */
  useEffect(() => {
    const panels = Array.from(document.querySelectorAll('aside.glass-panel'));
    if (panels.length === 0) return;

    const decorate = () => {
      for (const panel of panels) {
        panel.querySelectorAll('div > h3').forEach((h) => {
          if (h.querySelector('.collapse-indicator')) return;
          const indicator = document.createElement('span');
          indicator.className = 'collapse-indicator text-[9px] font-mono text-slate-400 dark:text-slate-500 font-normal normal-case';
          indicator.style.userSelect = 'none';
          // Mirrors the card's current state: a header that mounts inside an
          // already-folded card has to say [+], not [-].
          indicator.textContent = h.parentElement?.classList.contains('is-collapsed') ? ' [+]' : ' [−]';
          // Taken out of the header's flow rather than appended into it. These
          // headers are flex rows, several of them `justify-between` with a
          // docs (i) as the last child, so an extra child stops being a
          // trailing mark and becomes a third column — which shunts the (i)
          // from the right-hand edge into the middle of the header.
          const hHtml = h as HTMLElement;
          indicator.style.position = 'absolute';
          indicator.style.right = '0';
          indicator.style.top = '50%';
          indicator.style.transform = 'translateY(-50%)';
          hHtml.style.position = 'relative';
          hHtml.style.paddingRight = '1.1rem';
          h.appendChild(indicator);
          hHtml.style.cursor = 'pointer';
        });
      }
    };

    // Coalesced to one pass per frame: the inspector rewrites a lot of DOM
    // while a slider is being dragged, and every write lands here.
    let queued = 0;
    const schedule = () => {
      if (queued) return;
      queued = requestAnimationFrame(() => { queued = 0; decorate(); });
    };

    decorate();
    const observer = new MutationObserver(schedule);
    for (const panel of panels) observer.observe(panel, { childList: true, subtree: true });

    const handleHeaderClick = (e: Event) => {
      const target = e.target as HTMLElement;
      const header = target.closest('h3');
      if (!header) return;
      if (target.closest('button') || target.closest('a') || target.closest('input') || target.closest('select')) return;

      const card = header.parentElement;
      if (!card) return;

      card.classList.toggle('is-collapsed');

      const indicator = header.querySelector('.collapse-indicator');
      if (indicator) {
        indicator.textContent = card.classList.contains('is-collapsed') ? ' [+]' : ' [−]';
      }
    };

    for (const panel of panels) panel.addEventListener('click', handleHeaderClick);

    return () => {
      observer.disconnect();
      if (queued) cancelAnimationFrame(queued);
      for (const panel of panels) panel.removeEventListener('click', handleHeaderClick);
    };
  }, [selectedNodeId]);

  // What the (always-unselected) preset dropdown shows when closed.
  const activePresetLabel = useMemo(() => {
    if (!activePreset) return '✏️ Modified scene';
    if (activePreset.startsWith('user:')) return `💾 ${activePreset.replace('user:', '')}`;
    const preset = PRESETS[activePreset as keyof typeof PRESETS] as PresetEntry | undefined;
    if (!preset) return '✏️ Modified scene';
    return `${preset.emoji ? `${preset.emoji} ` : ''}${preset.name}`;
  }, [activePreset]);

  // Load a preset and replace the note card with the preset's built-in card (if any)
  /*
   * What the scene looked like when it was last loaded, saved or imported, so
   * picking another preset can ask before throwing work away. Undo brings the
   * geometry back after a load, but not the note cards or the copilot chat,
   * which live here rather than in the store's history.
   *
   * An edit is read off the undo stack — a new top entry, or one still being
   * gathered — rather than off the scene object, which also changes when a
   * boolean compiles or colliders land without anyone touching anything.
   */
  const cleanRef = useRef<{ top: unknown; notes: unknown; chat: unknown } | null>(null);
  const stopWatchingClean = useRef<(() => void) | null>(null);
  const markClean = useCallback((notes: unknown, chat: unknown) => {
    stopWatchingClean.current?.();
    stopWatchingClean.current = null;
    // A load's own undo step lands a tick or a build later, so the top of the
    // stack is only read once nothing is still being gathered; until then the
    // scene counts as the one just loaded.
    const clean = { top: PENDING_CLEAN as unknown, notes, chat };
    cleanRef.current = clean;
    const settle = (state: { tempUndoState: unknown; undoStack: unknown[] }) => {
      if (state.tempUndoState !== null) return false;
      clean.top = state.undoStack.at(-1) ?? null;
      return true;
    };
    if (settle(useStore.getState())) return;
    const unsubscribe = useStore.subscribe((state) => {
      if (!settle(state)) return;
      unsubscribe();
      stopWatchingClean.current = null;
    });
    stopWatchingClean.current = unsubscribe;
  }, []);
  const hasUnsavedWork = (): boolean => {
    const clean = cleanRef.current;
    const { undoStack: undoNow, tempUndoState } = useStore.getState();
    if (!clean) return undoNow.length > 0 || copilotMessages.length > 0;
    if (noteCards !== clean.notes || copilotMessages !== clean.chat) return true;
    if (clean.top === PENDING_CLEAN) return false;
    return (undoNow.at(-1) ?? null) !== clean.top || tempUndoState !== null;
  };

  const loadPresetWithCard = useCallback((name: string) => {
    loadPreset(name);
    const builtinKey = name.startsWith('user:') ? null : name;
    const presetCard = builtinKey ? makePresetNoteCard(builtinKey) : null;
    const notes = presetCard ? [presetCard] : [];
    const chat: CopilotMessage[] = [];
    setNoteCards(notes);
    setCopilotMessages(chat);
    setEditingCardId(null);
    markClean(notes, chat);
  }, [loadPreset, markClean]);

  // Also load note cards from user presets (stored alongside the scene)
  const loadUserPresetWithCard = useCallback((name: string) => {
    loadPreset(name);
    let notes: NoteCard[] = [];
    let chat: CopilotMessage[] = [];
    try {
      const saved = readUserPreset(name);
      if (saved && Array.isArray(saved.noteCards)) notes = saved.noteCards;
      if (saved && Array.isArray(saved.copilotMessages)) chat = saved.copilotMessages as CopilotMessage[];
    } catch {
      // Unreadable: it loads with no notes or chat, as before.
    }
    setNoteCards(notes);
    setCopilotMessages(chat);
    setEditingCardId(null);
    markClean(notes, chat);
  }, [loadPreset, markClean]);

  const [dialogModal, setDialogModal] = useState<{
    title: string;
    body: React.ReactNode;
    confirmLabel: string;
    cancelLabel?: string;
    hideCancel?: boolean;
    tone?: 'blue' | 'red' | 'amber';
    onConfirm: () => void;
    onCancel?: () => void;
  } | null>(null);

  const [exportScaleModal, setExportScaleModal] = useState<{
    title: string;
    value: string;
    onConfirm: (targetMm: number) => void;
  } | null>(null);

  const showNotice = useCallback((title: string, message: string, tone: 'blue' | 'red' | 'amber' = 'amber') => {
    setDialogModal({
      title,
      body: <p>{message}</p>,
      confirmLabel: 'OK',
      hideCancel: true,
      tone,
      onConfirm: () => setDialogModal(null),
    });
  }, []);

  const saveUserPresetByName = useCallback((name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const syncedScene = getSyncedSceneGraph(sceneGraph, model, data, mujoco);
      const preset = { ...syncedScene, noteCards, copilotMessages };
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
          useStore.getState().setActivePreset(`user:${trimmed}`);
          markClean(noteCards, copilotMessages);
        }
      });
      // A deliberate save is also a named revision of the cloud document, which
      // the pruner never discards — unlike the automatic checkpoints.
      void cloudAutosave.saveExplicit(trimmed, preset, `Saved as “${trimmed}”`);
    } catch (e) {
      console.error('Failed to save user preset', e);
      showNotice('Could not save preset', `Could not save "${trimmed}": ${e instanceof Error ? e.message : String(e)}`, 'red');
    }
  }, [sceneGraph, model, data, mujoco, noteCards, copilotMessages, markClean, showNotice]);

  /*
   * Cloud auto-save.
   *
   * The scene being worked on has never been persisted anywhere: presets are saved
   * on purpose, and a reload drops back to the default pendulum. This offers it to
   * the account after every edit.
   *
   * It has to live here rather than in the store or in userPresets.ts, because the
   * serialised form is `getSyncedSceneGraph(...)` — the same function the manual
   * save and the JSON export use, so an auto-saved scene is byte-for-byte what
   * saving by hand would have produced — and that needs the live MuJoCo handles,
   * which only exist in this component.
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
      cloudAutosave.schedule(name, () => ({
        ...getSyncedSceneGraph(sceneGraph, model, data, mujoco),
        noteCards,
        copilotMessages,
      }));
    } catch {
      // A scene that cannot be synced cannot be saved to anything; the local paths
      // have the same problem and there is nothing useful to add here.
    }
  }, [sceneGraph, noteCards, copilotMessages, model, data, mujoco, activePreset]);

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

  /*
   * Sharing the scene as a link.
   *
   * The only way to give someone a scene was the JSON file, which is a file:
   * it goes in an email, not in a message, and the person on the other end has
   * to save it, find it and import it.
   */
  const [share, setShare] = useState<ShareLink | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const [shareTooBig, setShareTooBig] = useState<ShareTooLargeError | null>(null);
  const [shareBusy, setShareBusy] = useState(false);

  const copyShareLink = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setShareCopied(true);
    } catch {
      // No clipboard on an insecure origin, and none in some embedded views.
      // The link is in a selectable field beside this for exactly that case.
      setShareCopied(false);
    }
  }, []);

  /**
   * Copies a link that opens this scene in someone else's browser.
   *
   * `getSyncedSceneGraph` is the same reader the save and the JSON export use,
   * so a link, a saved preset and a file all carry the same scene — positions
   * included, which is what "synced" means: the graph on its own still holds
   * where every body *started*, not where the simulation has put it.
   *
   * The copilot conversation is deliberately left out. It is the author's
   * working notes rather than part of the scene, it is usually the largest
   * thing in a saved preset, and the person opening the link wants the model,
   * not the argument that produced it. Note cards do travel: they are
   * annotations written on the scene.
   */
  /** The scene as it would be shared, read the same way the save reads it. */
  const sceneToShare = useCallback((): SharedScene => {
    const synced = getSyncedSceneGraph(sceneGraph, model, data, mujoco);
    const name = activePreset?.startsWith('user:')
      ? activePreset.slice('user:'.length)
      : synced.name || 'Shared scene';
    return { name, nodes: synced.nodes, noteCards };
  }, [sceneGraph, model, data, mujoco, noteCards, activePreset]);

  const handleShare = useCallback(async () => {
    setShareError(null);
    setShareTooBig(null);
    setShareCopied(false);
    try {
      const link = await buildShareLink(sceneToShare());
      setShare(link);
      await copyShareLink(link.url);
    } catch (e) {
      setShare(null);
      /*
       * A scene that will not fit in a link is the ordinary case for anything
       * sculpted, not an error to apologise for — so it is kept apart from a
       * real failure. The panel turns it into the offer that actually solves
       * it: leave the scene with an account and send a short link instead.
       */
      if (e instanceof ShareTooLargeError) setShareTooBig(e);
      else setShareError(e instanceof Error ? e.message : 'That scene could not be made into a link.');
    }
  }, [sceneToShare, copyShareLink]);

  /**
   * Leaves the scene with the account and copies the short link for it.
   *
   * Offered only after the link-sized route has failed. It is the heavier
   * option — it needs an account, and it puts a copy of the scene on a server
   * — and offering it first would make an account look required for something
   * that mostly is not.
   */
  const handleAccountShare = useCallback(async () => {
    setShareError(null);
    setShareBusy(true);
    try {
      const link = await buildAccountShareLink(sceneToShare());
      setShareTooBig(null);
      setShare(link);
      await copyShareLink(link.url);
    } catch (e) {
      // A free account is expected to work here; sharing is deliberately not a
      // Pro route. If that ever changes server-side, say so plainly rather than
      // showing a bare 403.
      setShareError(
        isProRequired(e)
          ? 'Sharing from your account needs PhysBox Pro.'
          : e instanceof Error
            ? e.message
            : 'That scene could not be shared from your account.'
      );
    } finally {
      setShareBusy(false);
    }
  }, [sceneToShare, copyShareLink]);

  /*
   * Signing in was the answer to "this scene is too big for a link", so the
   * share is finished off rather than leaving the panel sitting there with the
   * same button on it — the person already said what they wanted.
   */
  useEffect(() => {
    const done = (e: Event) => {
      if ((e as CustomEvent<{ reason?: string }>).detail?.reason !== 'share') return;
      void handleAccountShare();
    };
    window.addEventListener(SIGNED_IN_EVENT, done);
    return () => window.removeEventListener(SIGNED_IN_EVENT, done);
  }, [handleAccountShare]);

  /** Turns off a link that points at the account. A link with the scene inside it cannot be recalled. */
  const handleStopSharing = useCallback(async (token: string) => {
    setShareBusy(true);
    const ok = await revokeShare(token);
    setShareBusy(false);
    if (!ok) {
      setShareError('That link could not be turned off. Try again in a moment.');
      return;
    }
    setShare(null);
    setShareCopied(false);
  }, []);

  /**
   * A scene arriving by link — one this app made, from the share button.
   *
   * It is saved under its name and then loaded, rather than pushed straight
   * into the store. Every other way into a scene goes through the preset
   * loader, which resets the lattice and sculpt sessions, the camera and the
   * physics worker in one known order; a second path into `recompile` would be
   * a second place for that order to drift. It also means a shared scene is
   * *kept* — a Mesh scene is hours of work to rebuild and losing one to a
   * reload would be worse than an unasked-for entry in the preset list.
   *
   * Declinable, and the fragment stays in the URL until it is accepted, so
   * "no" means "not now" rather than "thrown away".
   */
  /**
   * Puts a shared scene into the app, however the link carried it.
   *
   * Saved under its name and then loaded, rather than pushed into the store.
   * Every other way into a scene goes through the preset loader, which resets
   * the lattice and sculpt sessions, the camera and the physics worker in one
   * known order, and a second path into `recompile` would be a second place for
   * that order to drift. It also means a shared scene is *kept*: a Mesh scene
   * is hours of work to rebuild, and losing one to a reload would be worse than
   * an unasked-for entry in the preset list.
   */
  const openSharedScene = useCallback((shared: SharedScene) => {
    setDialogModal({
      title: `Open "${shared.name}"?`,
      confirmLabel: 'Open shared scene',
      cancelLabel: 'Keep current scene',
      body: (
        <>
          <p>
            It is saved under that name and replaces the scene on screen. Save what you have first if
            you want it back.
          </p>
          <p>
            Keeping your current scene leaves the link in the address bar, so you can reload to open
            it later.
          </p>
        </>
      ),
      onCancel: () => setDialogModal(null),
      onConfirm: () => {
        setDialogModal(null);
        // Never over the top of a scene already saved under that name: a link from
        // someone whose "bracket" is not your "bracket" would otherwise overwrite
        // yours on open, with nothing said.
        const taken = new Set(listUserPresetNames());
        let name = shared.name;
        for (let n = 2; taken.has(name); n++) name = `${shared.name} (${n})`;

        clearShareFragment();
        clearShareToken();
        if (!saveUserPreset(name, { nodes: shared.nodes, noteCards: shared.noteCards ?? [] })) {
          setShareError(
            `"${name}" opened but could not be saved — browser storage is full. ` +
              'Export the JSON now if you want to keep it.'
          );
        }
        loadUserPresetWithCard(`user:${name}`);
      },
    });
  }, [loadUserPresetWithCard]);

  /**
   * A scene arriving as a token — the account route, for scenes too big to put
   * in a link.
   *
   * It lands the same way a fragment-shared scene does, through a save and a
   * preset load, so there is one way into a shared scene rather than two.
   * The token is taken out of the address bar only once it is open, so
   * declining leaves the link where it was.
   */
  useEffect(() => {
    const token = shareTokenInUrl();
    if (!token) return;
    readAccountShareLink(token)
      .then((shared) => openSharedScene(shared))
      .catch((err) => {
        clearShareToken();
        setShareError(err?.message || 'That shared link could not be opened.');
      });
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    readShareLink()
      .then((shared) => {
        if (!shared) return;
        openSharedScene(shared);
      })
      .catch((err) => {
        clearShareFragment();
        setShareError(err?.message || 'That link could not be read.');
      });
    // Once, on mount: opening the scene takes the fragment out of the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const threeSceneRef = useRef<THREE.Scene | null>(null);
  // The EffectComposer instance, so a screenshot can render through the same
  // post-processing pipeline the viewport uses (AO included) instead of a raw
  // gl.render() that would silently skip every effect — see SCREENSHOT in
  // useMCPBridge.
  const composerRef = useRef<ComponentRef<typeof EffectComposer> | null>(null);

  /**
   * The scene, as meshes ready to be written to a file.
   *
   * Shared by every mesh export rather than copied per format: they all want
   * the same thing — world-space geometry, scaled to a real size, Z-up — and
   * the only difference between them is what gets written afterwards. Materials
   * come along, because two of the three formats can carry colour and the one
   * that cannot simply ignores them.
   *
   * Prompts with the in-app export size modal when parts have positive size.
   */
  const withExportGroup = useCallback((title: string, onReady: (exportGroup: THREE.Group) => void) => {
    const scene = threeSceneRef.current;
    if (!scene) {
      showNotice('Scene not ready', 'Wait for the 3D scene to finish loading before exporting.');
      return;
    }

    // Find the nearest ancestor tagged with a body's nodeId (set on DynamicGeom's
    // wrapper <group name={nodeId}>), so multi-part scenes (e.g. an enclosure's
    // box + lid sitting side by side) can be scaled by a single part's size
    // rather than the combined footprint of everything visible.
    const findNodeId = (obj: THREE.Object3D): string | null => {
      let cur: THREE.Object3D | null = obj;
      while (cur) {
        if (cur.name) return cur.name;
        cur = cur.parent;
      }
      return null;
    };

    const exportGroup = new THREE.Group();
    const partBboxes = new Map<string, THREE.Box3>();
    let ungroupedIdx = 0;
    scene.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const mesh = obj as THREE.Mesh;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const standard = mats.find(m => (m as THREE.MeshStandardMaterial).isMeshStandardMaterial) as THREE.MeshStandardMaterial | undefined;
      // Only lit surfaces are the model. The brush ring, the CSG ghosts and the
      // shadow catcher are all basic/shadow materials and stay out of the file.
      if (!standard) return;
      mesh.updateWorldMatrix(true, false);
      const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      // The material is cloned so that turning the viewport to wireframe does
      // not export a wireframe — that is a way of looking at the model, not a
      // property of it.
      const material = standard.clone();
      material.wireframe = false;
      const exported = new THREE.Mesh(geo, material);
      exported.name = findNodeId(mesh) ?? mesh.name ?? `part_${ungroupedIdx}`;
      exportGroup.add(exported);

      const partKey = findNodeId(mesh) ?? `__ungrouped_${ungroupedIdx++}`;
      const meshBbox = new THREE.Box3().setFromBufferAttribute(geo.attributes.position as THREE.BufferAttribute);
      const existing = partBboxes.get(partKey);
      if (existing) existing.union(meshBbox);
      else partBboxes.set(partKey, meshBbox);
    });

    if (exportGroup.children.length === 0) {
      showNotice('Nothing to export', 'There are no visible 3D parts in the scene to export.');
      return;
    }

    // Normalize: fit the LONGEST SINGLE PART's longest side to a user-specified
    // target in mm (not the combined bounding box of everything visible), centered
    // at origin. Also convert from Three.js Y-up (the scene's convention) to the
    // Z-up convention STL/slicers expect - otherwise the export comes out on its
    // side even though the on-screen render (Y-up, handled natively by Three.js)
    // looks correct.
    const bbox = new THREE.Box3().setFromObject(exportGroup);
    let longestPartDim = 0;
    for (const partBbox of partBboxes.values()) {
      const partSize = partBbox.getSize(new THREE.Vector3());
      longestPartDim = Math.max(longestPartDim, partSize.x, partSize.y, partSize.z);
    }
    if (longestPartDim > 0) {
      const defaultMm = Math.round(longestPartDim * 1000).toString();
      setExportScaleModal({
        title,
        value: defaultMm,
        onConfirm: (targetMm) => {
          const scale = targetMm / longestPartDim;
          const center = bbox.getCenter(new THREE.Vector3());
          const transform = new THREE.Matrix4()
            .makeRotationX(Math.PI / 2)
            .multiply(new THREE.Matrix4().makeScale(scale, scale, scale))
            .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));
          for (const child of exportGroup.children) {
            (child as THREE.Mesh).geometry.applyMatrix4(transform);
          }
          onReady(exportGroup);
        },
      });
      return;
    }

    onReady(exportGroup);
  }, [showNotice]);

  /** The scene's name, cleaned up into something that can be a filename. */
  const exportBaseName = useCallback(() => {
    let baseName = '';
    if (noteCards && noteCards.length > 0) {
      for (const card of noteCards) {
        if (card.markdown) {
          const match = card.markdown.match(/^\s*#\s+(.+)$/m);
          const heading = match ? match[1].replace(/[*_`]/g, '').trim() : '';
          // Not the new-card placeholder, or every export became note.stl.
          if (heading && heading !== 'Note') {
            baseName = heading;
            break;
          }
        }
      }
    }

    if (!baseName && activePreset) {
      if (activePreset.startsWith('user:')) {
        baseName = activePreset.replace('user:', '').trim();
      } else {
        const presetObj = PRESETS[activePreset as keyof typeof PRESETS] as PresetEntry | undefined;
        baseName = presetObj?.name || activePreset;
      }
    }

    if (!baseName) {
      baseName = 'physics_scene';
    }

    return baseName.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'physics_scene';
  }, [noteCards, activePreset]);

  const exportJson = useCallback(() => {
    try {
      const syncedScene = getSyncedSceneGraph(sceneGraph, model, data, mujoco);
      const dataStr = JSON.stringify({ ...syncedScene, noteCards, copilotMessages }, null, 2);
      const blob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${exportBaseName()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Failed to export JSON', e);
      showNotice('Export failed', 'Failed to export JSON.', 'red');
    }
  }, [sceneGraph, model, data, mujoco, noteCards, copilotMessages, exportBaseName, showNotice]);

  const exportStl = useCallback(() => {
    withExportGroup('Export STL', (exportGroup) => {
      const exporter = new STLExporter();
      const result = exporter.parse(exportGroup, { binary: true }) as DataView;
      downloadBlob(new Blob([result.buffer as ArrayBuffer], { type: 'application/octet-stream' }), `${exportBaseName()}.stl`);
    });
  }, [withExportGroup, exportBaseName]);

  /**
   * The same model, in the format that can carry what it looks like.
   *
   * Both halves of the colour go in — per-corner colour for anything that
   * renders the file, and a filament slot per triangle for a slicer that
   * prints it. See utils/threeMfExporter.
   */
  const exportWholeScene3mf = useCallback(() => {
    withExportGroup('Export 3MF', (exportGroup) => {
      const meshes: ThreeMfMesh[] = [];
      exportGroup.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const material = mesh.material as THREE.MeshStandardMaterial;
        const position = mesh.geometry.getAttribute('position');
        if (!position) return;
        const color = mesh.geometry.getAttribute('color');
        meshes.push({
          name: mesh.name || 'part',
          positions: position.array as Float32Array,
          indices: (mesh.geometry.getIndex()?.array as Uint32Array | undefined) ?? null,
          // Present exactly when the body carries paint: the painted material is
          // white and holds the body's own colour in the attribute instead.
          colors: material.vertexColors && color ? (color.array as Float32Array) : null,
          baseColor: [material.color.r, material.color.g, material.color.b],
        });
      });

      if (!meshes.length) {
        showNotice('Nothing to export', 'There are no visible 3D parts in the scene to export.');
        return;
      }

      const result = exportThreeMf(meshes);
      downloadBlob(new Blob([result.data.buffer as ArrayBuffer], { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml' }), `${exportBaseName()}.3mf`);

      // Said out loud because it is the one thing about the file a user cannot
      // see by looking at it: how many filaments the paint was reduced to.
      const slots = result.palette.filter(p => p.triangles > 0);
      if (slots.length > 1) {
        console.info(`[Export] 3MF written with ${slots.length} filament slots:`,
          slots.map(p => `${p.extruder}: ${p.hex} (${p.triangles} triangles)`).join(', '));
      }
    });
  }, [withExportGroup, exportBaseName, showNotice]);

  const export3mf = useCallback(() => {
    // Sections made by Split for Print know which way up they print. When
    // there are some, offer the print job — each section stood that way and
    // laid out on the bed — rather than the scene as it stands. No size prompt
    // for those: they were cut to fit this bed, and rescaling would undo that.
    const { sceneGraph: graph, printBed } = useStore.getState();
    const posed: PosedPart[] = [];
    const walk = (nodes: SceneNode[]) => {
      for (const n of nodes) {
        const mesh = n.printPose && (n.geoms || []).find((g) => g.type === 'mesh' && g.role !== 'collision' && g.renderVertices?.length && g.faces?.length);
        if (n.printPose && mesh) {
          const c = new THREE.Color().setRGB(mesh.rgba?.[0] ?? 0.8, mesh.rgba?.[1] ?? 0.8, mesh.rgba?.[2] ?? 0.8, THREE.SRGBColorSpace);
          posed.push({ name: n.name || n.id, positions: mesh.renderVertices!, faces: mesh.faces!, pose: n.printPose, colour: [c.r, c.g, c.b] });
        }
        walk(n.children || []);
      }
    };
    walk(graph.nodes);
    if (posed.length) {
      setDialogModal({
        title: `Lay out ${posed.length} split section${posed.length === 1 ? '' : 's'} on the print bed?`,
        confirmLabel: 'Lay out on bed',
        cancelLabel: 'Export scene as-is',
        body: (
          <>
            <p>
              Each split section will be stood the way it prints and arranged across the{' '}
              <strong>{printBed.widthMm} × {printBed.depthMm} mm</strong> bed.
            </p>
            <p>Choose “Export scene as-is” to export the whole scene in its current pose instead.</p>
          </>
        ),
        onConfirm: () => {
          setDialogModal(null);
          const plated = layoutOnBed(posed, printBed);
          const result = exportThreeMf(plated.map((p) => ({
            name: p.name, positions: p.positions, indices: p.indices, colors: null, baseColor: p.colour,
          })));
          downloadBlob(new Blob([result.data.buffer as ArrayBuffer], { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml' }), `${exportBaseName()}_plate.3mf`);
          const plates = Math.max(...plated.map((p) => p.plate)) + 1;
          if (plates > 1) console.info(`[Export] ${plates} plates' worth of sections; the extra plates sit beside the bed.`);
        },
        onCancel: () => {
          setDialogModal(null);
          exportWholeScene3mf();
        },
      });
      return;
    }

    exportWholeScene3mf();
  }, [exportWholeScene3mf, exportBaseName]);

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
      setNoteCards(notes);
      setCopilotMessages(chat);
      setEditingCardId(null);
      markClean(notes, chat);
    };
    if (dropped) {
      setDialogModal({
        title: `Replace the current scene with ${fileName}?`,
        confirmLabel: 'Replace scene',
        tone: 'amber',
        body: <p>The current scene on screen will be replaced by the imported file.</p>,
        onCancel: () => setDialogModal(null),
        onConfirm: () => {
          setDialogModal(null);
          applyImport();
        },
      });
      return;
    }
    applyImport();
  }, [togglePlay, updateScene, markClean, showNotice]);

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

  /*
   * A click on a gizmo handle is a click on a mesh with no R3F handlers, so R3F
   * reports it as a miss — and clearing the selection here would take the gizmo
   * away underneath the drag that is using it.
   */
  const handlePointerMissed = useCallback(() => {
    if (isGizmoBusy()) return;
    setSelectedNodeId(null);
  }, [setSelectedNodeId]);

  const selectedNode = useSelectedNode();

  // A part dropped on the canvas goes under the selected body, like a clicked
  // one. Read at drop time rather than bound to the selection, so the drop
  // listeners are not torn down and re-added on every selection change.
  const addComponentUnderSelection = useCallback(
    (type: Parameters<typeof addComponent>[0], pos: [number, number, number]) => {
      addComponent(type, pos, useStore.getState().selectedNodeId);
    },
    [addComponent],
  );

  useMCPBridge();
  useVoltLink();
  // Regenerates a boolean body's mesh whenever its primitives change.
  useCsgAutoCompile();

  return (
    /*
      `h-dvh`, not `h-screen`: on a phone `100vh` is the viewport with the URL
      bar hidden, so the foot of the app sat underneath the browser chrome and
      could not be reached. On a desktop the two are the same number.
    */
    <div className={`flex flex-col h-dvh w-screen transition-colors duration-200 ${darkMode ? 'dark bg-slate-950 text-slate-100' : 'bg-slate-50 text-slate-900'} font-sans`}>
      {/*
        Below `lg` the bar wraps onto as many rows as it needs rather than
        squeezing. Everything in here is a file operation, an export or a
        simulation control — deciding on the operator's behalf that they will
        not want to export an STL on a phone is how a mobile layout ends up
        being a demo of the app rather than the app.
      */}
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-3 md:px-6 py-2 flex items-center justify-between shadow-xs z-10 transition-colors shrink-0 max-lg:flex-wrap max-lg:justify-start max-lg:gap-y-1.5">
        {/* Left: Logo, Title & Preset Selector */}
        <div className="flex items-center gap-2 md:gap-4 min-w-0 max-lg:w-full">
          {/* Mobile Sidebar Toggle */}
          <button
            onClick={() => setIsLeftSidebarOpen(!isLeftSidebarOpen)}
            className="p-1.5 rounded-md text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-200 transition-colors md:hidden focus:outline-none cursor-pointer flex-shrink-0"
            title="Toggle Sidebar"
          >
            {isLeftSidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>

          {/* Logo & Title */}
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center flex-shrink-0 p-1.5">
              <svg viewBox="0 0 512 512" className="w-full h-full" fill="none" xmlns="http://www.w3.org/2000/svg">
                <defs>
                  <linearGradient id="logo-cyan-blue" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#00f2fe" />
                    <stop offset="100%" stopColor="#3b82f6" />
                  </linearGradient>
                  <linearGradient id="logo-blue-purple" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#3b82f6" />
                    <stop offset="100%" stopColor="#7c3aed" />
                  </linearGradient>
                  <linearGradient id="logo-face-top" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#00f2fe" stopOpacity="0.15" />
                    <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.15" />
                  </linearGradient>
                  <linearGradient id="logo-face-left" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.25" />
                    <stop offset="100%" stopColor="#1d4ed8" stopOpacity="0.25" />
                  </linearGradient>
                  <linearGradient id="logo-face-right" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#7c3aed" stopOpacity="0.20" />
                    <stop offset="100%" stopColor="#4f46e5" stopOpacity="0.20" />
                  </linearGradient>
                </defs>
                <polygon points="256,60 426,158 256,256 86,158" fill="url(#logo-face-top)" />
                <polygon points="86,158 256,256 256,452 86,354" fill="url(#logo-face-left)" />
                <polygon points="256,256 426,158 426,354 256,452" fill="url(#logo-face-right)" />
                
                <g stroke="url(#logo-cyan-blue)" strokeWidth="10" strokeOpacity="0.75" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="256" y1="60" x2="256" y2="256" />
                  <line x1="86" y1="158" x2="426" y2="158" />
                  <line x1="86" y1="158" x2="256" y2="452" />
                  <line x1="256" y1="256" x2="86" y2="354" />
                  <line x1="256" y1="256" x2="426" y2="354" />
                  <line x1="426" y1="158" x2="256" y2="452" />
                </g>
                
                <polygon points="256,60 426,158 426,354 256,452 86,354 86,158" stroke="url(#logo-blue-purple)" strokeWidth="22" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                <line x1="256" y1="256" x2="256" y2="452" stroke="url(#logo-blue-purple)" strokeWidth="22" strokeLinecap="round" strokeLinejoin="round" />
                <line x1="256" y1="256" x2="86" y2="158" stroke="url(#logo-blue-purple)" strokeWidth="22" strokeLinecap="round" strokeLinejoin="round" />
                <line x1="256" y1="256" x2="426" y2="158" stroke="url(#logo-blue-purple)" strokeWidth="22" strokeLinecap="round" strokeLinejoin="round" />
                
                <g fill="#ffffff">
                  <circle cx="256" cy="60" r="18" stroke="#7c3aed" strokeWidth="8" />
                  <circle cx="86" cy="158" r="18" stroke="#3b82f6" strokeWidth="8" />
                  <circle cx="426" cy="158" r="18" stroke="#3b82f6" strokeWidth="8" />
                  <circle cx="256" cy="256" r="20" stroke="#3b82f6" strokeWidth="9" />
                  <circle cx="86" cy="354" r="18" stroke="#3b82f6" strokeWidth="8" />
                  <circle cx="426" cy="354" r="18" stroke="#3b82f6" strokeWidth="8" />
                  <circle cx="256" cy="452" r="18" stroke="#7c3aed" strokeWidth="8" />
                </g>
              </svg>
            </div>
            {/* The mark alone identifies the app on a phone; the wordmark and
                tagline are the first thing to give up the width. */}
            <div className="hidden md:block">
              <div className="flex items-center gap-2">
                <h1 className="text-base font-extrabold tracking-tight text-slate-900 dark:text-white font-sans">
                  Physbox <span className="text-blue-500 dark:text-blue-400 font-normal">Mesh</span>
                </h1>
                <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-950/80 border border-blue-200 dark:border-blue-800/50 text-blue-700 dark:text-blue-300">
                  3D Studio
                </span>
              </div>
              <p className="text-[10px] text-slate-500 dark:text-slate-400">Real World Physics &amp; Design Studio</p>
            </div>
          </div>

          <div className="h-5 w-px bg-slate-200 dark:bg-slate-800 hidden md:block" />

          {/* Preset Select Segmented Group */}
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
                  setDialogModal({
                    title: 'Replace the current scene?',
                    confirmLabel: 'Replace scene',
                    tone: 'amber',
                    body: <p>Its unsaved changes, note cards and copilot chat will be lost.</p>,
                    onCancel: () => setDialogModal(null),
                    onConfirm: () => {
                      setDialogModal(null);
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
                    setDialogModal({
                      title: `Delete preset "${presetName}"?`,
                      confirmLabel: 'Delete preset',
                      tone: 'red',
                      body: (
                        <p>
                          The saved preset will be removed from your preset list. The scene currently on
                          screen will stay open.
                        </p>
                      ),
                      onCancel: () => setDialogModal(null),
                      onConfirm: () => {
                        setDialogModal(null);
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
        </div>

        {/* Center/Right: Simulation Toolbar & Files */}
        <div className="flex items-center gap-2 md:gap-3 min-w-0 max-lg:w-full max-lg:flex-wrap max-lg:justify-between max-lg:gap-y-1.5">
          {/* Simulation Controller Block */}
          <div className={`flex items-center max-lg:shrink-0 p-0.5 rounded-lg border transition-all duration-300 ${
            isPlaying
              ? 'bg-emerald-50/80 dark:bg-emerald-950/35 border-emerald-400/60 dark:border-emerald-500/40 shadow-[0_0_12px_-2px_rgba(16,185,129,0.28)]'
              : 'bg-slate-100 dark:bg-slate-800/80 border-slate-200/80 dark:border-slate-700/60 shadow-inner'
          }`}>
            {/* Simulate / Stop */}
            <button 
              onClick={togglePlay}
              disabled={!isLoaded}
              className={`flex items-center justify-center gap-1.5 px-3 py-1 rounded-md font-semibold text-xs transition-all disabled:opacity-50 flex-shrink-0 cursor-pointer ${
                isPlaying
                  ? 'bg-red-500 hover:bg-red-600 text-white shadow-xs'
                  : 'hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-100'
              }`}
              title={isPlaying ? "Stop Simulation" : "Start Simulation"}
            >
              {isPlaying ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3 text-emerald-500 dark:text-emerald-400" />}
              <span className="hidden md:inline">{isPlaying ? 'Stop' : 'Run'}</span>
            </button>

            {/* Reset */}
            <button 
              onClick={resetSimulation}
              disabled={!isLoaded}
              className="flex items-center justify-center gap-1.5 px-3 py-1 rounded-md font-semibold text-xs hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors disabled:opacity-50 flex-shrink-0 cursor-pointer"
              title="Reset Simulation"
            >
              <RotateCcw className="w-3 h-3" />
              <span className="hidden md:inline">Reset</span>
            </button>
          </div>

          {/* Files Segmented Group */}
          <div className="flex items-center max-lg:shrink-0 bg-slate-100 dark:bg-slate-800/80 p-0.5 rounded-lg border border-slate-200/80 dark:border-slate-700/60 shadow-inner">
            <button 
              onClick={handleSavePresetClick}
              className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors focus:outline-none cursor-pointer"
              title="Save scene preset (Ctrl+S)"
            >
              <Save className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={() => {
                if (selectedNodeId) useStore.getState().deleteNodes([selectedNodeId, ...extraSelectedIds]);
              }}
              disabled={!selectedNodeId}
              className="flex items-center justify-center p-1 rounded-md hover:bg-red-50 dark:hover:bg-red-950/40 text-red-500 disabled:opacity-30 disabled:hover:bg-transparent transition-colors focus:outline-none cursor-pointer"
              title={selectedNodeId ? "Delete selected item (Delete / Backspace)" : "No item selected"}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={exportJson}
              className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors focus:outline-none cursor-pointer"
              title="JSON"
            >
              <Download className="w-3.5 h-3.5" />
            </button>

            {/* Share: a link with the scene inside it. Next to the JSON
                download because it is one — the same scene, addressed to a
                browser instead of a disk. */}
            <button
              onClick={handleShare}
              className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-sky-600 dark:text-sky-400 transition-colors focus:outline-none cursor-pointer"
              title="Copy a share link — the scene travels inside it"
            >
              <Share2 className="w-3.5 h-3.5" />
            </button>

            {/* Exporting is done from the status bar, beside the machine it
                is exported for. This stays because it is where people look
                for it, and it sends them there. */}
            <button
              onClick={() => window.dispatchEvent(new CustomEvent(SHOW_EXPORTS_EVENT))}
              className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors focus:outline-none cursor-pointer"
              title="Export for a printer, laser or router. The buttons are on the bottom bar, beside the machine and material they depend on."
            >
              <Printer className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={() => setIsImportImageModalOpen(true)}
              className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-fuchsia-600 dark:text-fuchsia-400 transition-colors focus:outline-none cursor-pointer"
              title="Import Image as 3D Relief (heightmap)"
            >
              <ImageIcon className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={() => setIsImportStlModalOpen(true)}
              className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors focus:outline-none cursor-pointer"
              title="Import STL (3D file)"
            >
              <Upload className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={importJson}
              className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors focus:outline-none cursor-pointer"
              title="Import JSON"
            >
              <Upload className="w-3.5 h-3.5" />
            </button>

            {/* The buttons press Ctrl+Z rather than calling the store, so they
                do exactly what the keys do: while sculpt or lattice is open
                that is the tool's own last step, falling through to the
                document once the tool's history is spent. Calling undo()
                directly stepped the document back from under the tool and
                threw its history away. */}
            <button
              onClick={() => pressHistoryKey(false)}
              disabled={undoStack.length === 0 && !sculptNodeId && !latticeNodeId}
              className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 disabled:opacity-30 disabled:hover:bg-transparent transition-colors focus:outline-none cursor-pointer"
              title="Undo"
            >
              <Undo className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={() => pressHistoryKey(true)}
              disabled={redoStack.length === 0 && !sculptNodeId && !latticeNodeId}
              className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 disabled:opacity-30 disabled:hover:bg-transparent transition-colors focus:outline-none cursor-pointer"
              title="Redo"
            >
              <Redo className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Right Utilities (Dark Mode, Docs, Settings, Copilot, User Profile, GitHub) */}
          <div className="flex items-center gap-1.5 max-lg:shrink-0">
            {/* Dark Mode Toggle - immediately left of Docs button */}
            <button
              onClick={toggleDarkMode}
              className="flex items-center justify-center w-8 h-8 rounded-full border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors focus:outline-none flex-shrink-0 cursor-pointer shadow-xs"
              title={darkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
            >
              {darkMode ? <Sun className="w-4 h-4 text-amber-500" /> : <Moon className="w-4 h-4 text-indigo-500 dark:text-indigo-400" />}
            </button>

            {/*
              Properties inspector — a permanent column at `lg`, a drawer below
              it, opened from here. The mirror of the hierarchy hamburger on the
              other end of the bar: one button for the palette going in, one for
              the inspector coming out. Disabled rather than hidden with nothing
              selected, so the bar does not reflow as things are picked and
              dropped, and the button says why it is dark.
            */}
            <button
              onClick={() => setIsPropertiesOpen(!isPropertiesOpen)}
              disabled={!selectedNode || isPlaying}
              className={`lg:hidden flex items-center justify-center w-8 h-8 rounded-full border transition-colors focus:outline-none flex-shrink-0 cursor-pointer shadow-xs disabled:opacity-40 disabled:cursor-not-allowed ${
                isPropertiesOpen
                  ? 'bg-blue-100 border-blue-400 text-blue-700 dark:bg-blue-950 dark:border-blue-700 dark:text-blue-400'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-900'
              }`}
              title={isPlaying ? 'Stop the simulation to edit properties' : selectedNode ? 'Properties' : 'Select a component to see its properties'}
            >
              <PanelRight className="w-4 h-4" />
            </button>

            {/* Docs (Info) */}
            <button
              onClick={() => openDocs('quickref')}
              className="flex items-center justify-center w-8 h-8 rounded-full border border-indigo-200 dark:border-indigo-800 text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/30 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 transition-colors focus:outline-none flex-shrink-0 cursor-pointer shadow-xs"
              title="Documentation"
            >
              <Info className="w-4 h-4" />
            </button>

            {/* Settings */}
            <button 
              onClick={() => setSettingsOpen(!isSettingsOpen)}
              className={`flex items-center justify-center w-8 h-8 rounded-full border transition-colors focus:outline-none flex-shrink-0 cursor-pointer shadow-xs ${
                isSettingsOpen 
                  ? 'bg-blue-100 border-blue-400 text-blue-700 dark:bg-blue-950 dark:border-blue-700 dark:text-blue-400' 
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
              title="Global Settings"
            >
              <Settings className="w-4 h-4" />
            </button>

            {/* AI Copilot */}
            <button
              onClick={() => setShowAICopilot(!showAICopilot)}
              className={`flex items-center justify-center w-8 h-8 rounded-full border transition-colors focus:outline-none flex-shrink-0 cursor-pointer shadow-xs ${
                showAICopilot 
                  ? 'bg-blue-100 border-blue-400 text-blue-700 dark:bg-blue-950 dark:border-blue-700 dark:text-blue-400' 
                  : 'border-indigo-200 dark:border-indigo-800 text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/30 hover:bg-indigo-100 dark:hover:bg-indigo-900/40'
              }`}
              title="AI Copilot Expert"
            >
              <Sparkles className="w-4 h-4" />
            </button>

            {/* User Profile & Cloud Sync */}
            {/* Whether Claude may move the machine — see AgentMachineBanner */}
            <AgentMachineBanner />

            <UserProfileButton />

            {/* GitHub */}
            <a
              href="https://github.com/physbox-io/mesh"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center w-8 h-8 rounded-full border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors focus:outline-none flex-shrink-0 cursor-pointer shadow-xs"
              title="View on GitHub"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg>
            </a>
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden relative">
        {/* Global Settings */}
        {isSettingsOpen && (
          /* Anchored to the settings button on a desktop. Below `lg` there is
             nothing reliable to anchor to — the header wraps, so the button
             moves — and a 16rem popover in the corner of a phone is mostly
             off-screen anyway, so it becomes a centred sheet instead. */
          <div className="absolute top-4 right-6 w-64 max-lg:inset-x-2 max-lg:right-auto max-lg:top-1/2 max-lg:-translate-y-1/2 max-lg:w-auto max-lg:max-h-[80dvh] max-lg:overflow-y-auto glass-panel rounded-lg p-4 z-30 max-lg:z-50 shadow-lg border border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-900/90 text-slate-800 dark:text-slate-100">
            <h3 className="font-semibold text-sm mb-4 flex items-center justify-between text-slate-800 dark:text-slate-100">
              <span className="flex items-center gap-2"><Settings className="w-4 h-4 text-slate-500 dark:text-slate-400" /> Environment</span>
              <button aria-label="Close" title="Close" onClick={() => setSettingsOpen(false)}><X className="w-4 h-4 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 cursor-pointer" /></button>
            </h3>
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-2">
                <span id="hiResLabel" className="text-xs font-medium text-slate-500 dark:text-slate-400" title="Antialiasing, tone mapping and smoother curves. Turn off if the viewport is slow.">Hi-Res</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={hiRes}
                  aria-labelledby="hiResLabel"
                  title="Antialiasing, tone mapping and smoother curves. Turn off if the viewport is slow."
                  onClick={() => setHiRes(!hiRes)}
                  className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full transition-colors ${hiRes ? 'bg-blue-500' : 'bg-slate-300 dark:bg-slate-700'}`}
                >
                  <span className={`inline-block h-3 w-3 rounded-full bg-white shadow transition-transform ${hiRes ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-500 dark:text-slate-400 flex justify-between">Gravity Z <SliderValue value={gravityZ} onChange={(v) => setEnvironment({gravityZ: v})} decimals={1} unit="m/s²" min={-20} max={20} /></label>
                <RangeInput min="-20" max="20" step="0.1" value={gravityZ} onChange={(v) => setEnvironment({gravityZ: v})} className="w-full accent-blue-500 cursor-pointer" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-500 dark:text-slate-400 flex justify-between">Wind X <SliderValue value={windX} onChange={(v) => setEnvironment({windX: v})} decimals={1} unit="m/s" min={-10} max={10} /></label>
                <RangeInput min="-10" max="10" step="0.1" value={windX} onChange={(v) => setEnvironment({windX: v})} className="w-full accent-blue-500 cursor-pointer" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-500 dark:text-slate-400 flex justify-between">Wind Y <SliderValue value={windY} onChange={(v) => setEnvironment({windY: v})} decimals={1} unit="m/s" min={-10} max={10} /></label>
                <RangeInput min="-10" max="10" step="0.1" value={windY} onChange={(v) => setEnvironment({windY: v})} className="w-full accent-blue-500 cursor-pointer" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-500 dark:text-slate-400 flex justify-between">Air Density (Drag) <SliderValue value={density} onChange={(v) => setEnvironment({density: v})} decimals={2} unit="kg/m³" min={0} max={5} /></label>
                <RangeInput min="0" max="5" step="0.01" value={density} onChange={(v) => setEnvironment({density: v})} className="w-full accent-blue-500 cursor-pointer" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-500 dark:text-slate-400 flex justify-between">Floor Friction <SliderValue value={floorFriction} onChange={(v) => setEnvironment({floorFriction: v})} decimals={2} min={0} max={2} /></label>
                <RangeInput min="0" max="2" step="0.01" value={floorFriction} onChange={(v) => setEnvironment({floorFriction: v})} className="w-full accent-blue-500 cursor-pointer" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-500 dark:text-slate-400 flex justify-between">Floor Bounciness <SliderValue value={floorBounce ?? 0} onChange={(v) => setEnvironment({floorBounce: v})} decimals={2} min={0} max={1} /></label>
                <RangeInput min="0" max="1" step="0.01" value={floorBounce ?? 0} onChange={(v) => setEnvironment({floorBounce: v})} className="w-full accent-blue-500 cursor-pointer" />
              </div>
              {/* Contact fidelity. Print is for millimetre parts that have to
                  fit: stiffer contact, and pins colliding with their holes
                  exactly. A property of the scene, so it is undone and saved
                  with it. */}
              <div className="flex items-center justify-between gap-2">
                <span id="fidelityLabel" className="text-xs font-medium text-slate-500 dark:text-slate-400" title="Print: contact stiff enough for millimetre clearances, and pegs and dowels that really go into their holes. For split parts and anything else that has to fit together.">Print Fidelity</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={simFidelity === 'print'}
                  aria-labelledby="fidelityLabel"
                  title="Print: contact stiff enough for millimetre clearances, and pegs and dowels that really go into their holes. For split parts and anything else that has to fit together."
                  onClick={() => setSimFidelity(simFidelity === 'print' ? 'standard' : 'print')}
                  className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full transition-colors ${simFidelity === 'print' ? 'bg-blue-500' : 'bg-slate-300 dark:bg-slate-700'}`}
                >
                  <span className={`inline-block h-3 w-3 rounded-full bg-white shadow transition-transform ${simFidelity === 'print' ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                </button>
              </div>
              <div className="pt-2.5 border-t border-slate-200 dark:border-slate-800 flex flex-col gap-2.5">
                <div className="flex flex-col gap-1">
                  <label htmlFor="geminiApiKey" className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider flex items-center gap-1">
                    🔑 Google Gemini API Key
                  </label>
                  <input 
                    type="password" 
                    id="geminiApiKey"
                    value={settingsGeminiKey} 
                    onChange={(e) => handleUpdateGeminiKeyInSettings(e.target.value)} 
                    placeholder="Paste AIzaSy... here" 
                    className="w-full px-2 py-1.5 text-xs border border-slate-200 dark:border-slate-800 rounded bg-white dark:bg-slate-950 text-slate-800 dark:text-slate-200 shadow-inner focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono" 
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="claudeApiKey" className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider flex items-center gap-1">
                    🔑 Anthropic Claude API Key
                  </label>
                  <input 
                    type="password" 
                    id="claudeApiKey"
                    value={settingsClaudeKey} 
                    onChange={(e) => handleUpdateClaudeKeyInSettings(e.target.value)} 
                    placeholder="Paste sk-ant-... here" 
                    className="w-full px-2 py-1.5 text-xs border border-slate-200 dark:border-slate-800 rounded bg-white dark:bg-slate-950 text-slate-800 dark:text-slate-200 shadow-inner focus:outline-none focus:ring-1 focus:ring-amber-500 font-mono" 
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="geminiModel" className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider flex items-center gap-1">
                    🤖 Copilot AI Model
                  </label>
                  <select 
                    id="geminiModel"
                    value={settingsSelectedModel} 
                    onChange={(e) => {
                      const modelId = e.target.value;
                      setSettingsSelectedModel(modelId);
                      localStorage.setItem('gemini_model', modelId);
                      pushGlobalParameter('gemini_model', modelId);
                      window.dispatchEvent(new Event('storage'));
                    }} 
                    className="w-full px-2 py-1.5 text-xs border border-slate-200 dark:border-slate-800 rounded bg-white dark:bg-slate-950 text-slate-800 dark:text-slate-200 shadow-inner focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer" 
                  >
                    <optgroup label="Google Gemini">
                      {liveSettingsGeminiModels.length > 0 ? (
                        liveSettingsGeminiModels.map(m => (
                          <option key={m.id} value={m.id}>{m.name}</option>
                        ))
                      ) : (
                        <>
                          <option value="gemini-3.6-flash">Gemini 3.6 Flash (Recommended)</option>
                          <option value="gemini-3.5-flash">Gemini 3.5 Flash</option>
                          <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                        </>
                      )}
                    </optgroup>
                    <optgroup label="Anthropic Claude">
                      {liveSettingsClaudeModels.length > 0 ? (
                        liveSettingsClaudeModels.map(m => (
                          <option key={m.id} value={m.id}>{m.name}</option>
                        ))
                      ) : (
                        <>
                          <option value="claude-opus-5">Claude Opus 5</option>
                          <option value="claude-sonnet-5">Claude Sonnet 5</option>
                          <option value="claude-fable-5">Claude Fable 5</option>
                          <option value="claude-3-7-sonnet-20250219">Claude 3.7 Sonnet</option>
                          <option value="claude-3-5-sonnet-20241022">Claude 3.5 Sonnet</option>
                        </>
                      )}
                    </optgroup>
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="copilotMaxTokens" className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider flex items-center justify-between gap-1">
                    <span>📏 Copilot Max Response Tokens</span>
                    <span className="font-mono normal-case tracking-normal text-slate-600 dark:text-slate-300">{settingsMaxTokens.toLocaleString()}</span>
                  </label>
                  <RangeInput
                    id="copilotMaxTokens"
                    min={MIN_MAX_TOKENS}
                    max={MAX_MAX_TOKENS}
                    step={1000}
                    value={settingsMaxTokens}
                    onChange={(v) => {
                      const next = writeMaxTokens(Math.round(v));
                      setSettingsMaxTokens(next);
                      window.dispatchEvent(new Event('storage'));
                    }}
                    className="w-full accent-blue-500 cursor-pointer"
                  />
                  <p className="text-[9px] text-slate-400 dark:text-slate-500 leading-snug">
                    Output budget for one copilot reply. Raise this if scene changes come back cut off; lower it to cut cost and latency.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        <LeftSidebar
          onAddNoteCard={() => {
            const id = `card_${Date.now()}`;
            setNoteCards((prev) => [
              ...prev,
              { id, markdown: '# Note\n\nWrite your notes here.', minimized: false, x: 80, y: 80 },
            ]);
            setEditingCardId(id);
          }}
        />

        {/* Viewport */}
        <main className="flex-1 relative min-w-0 overflow-hidden">
          {/* Subtle Studio Cyclorama Edge Vignette */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-[5] bg-[radial-gradient(ellipse_at_50%_46%,transparent_50%,rgba(100,116,139,0.12)_100%)] dark:bg-[radial-gradient(ellipse_at_50%_46%,transparent_44%,rgba(2,6,23,0.48)_100%)] shadow-[inset_0_1px_2px_rgba(15,23,42,0.04)] dark:shadow-[inset_0_1px_4px_rgba(0,0,0,0.45)]"
          />

          {/* Top-Edge Live Simulation Hairline & Soft Glow */}
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute inset-x-0 top-0 z-[6] transition-opacity duration-500 ${
              isPlaying ? 'opacity-100' : 'opacity-0'
            }`}
          >
            <div className="h-[2.5px] w-full bg-gradient-to-r from-transparent via-emerald-400 to-transparent" />
            <div className="h-7 w-full bg-gradient-to-b from-emerald-500/10 via-amber-400/[0.04] to-transparent dark:from-emerald-400/14 dark:via-amber-300/[0.05] dark:to-transparent" />
          </div>

          {!isLoaded && (
            <div className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none bg-slate-50/50 backdrop-blur-sm">
              <div className="text-slate-500 flex flex-col items-center gap-4 font-medium">
                <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                Initializing Mesh...
              </div>
            </div>
          )}

          {/* Floating Status Indicators */}
          <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-20 flex flex-col gap-2 pointer-events-none items-center">
            {/* First in the stack: it explains why everything under it may be
                describing a scene that is not the one being drawn. */}
            <CompileErrorBanner />
            <VoltLinkBanner />
            <EdgeRoundPanel />
            {scadCompileCount > 0 && (
              <div className="bg-white/90 dark:bg-slate-900/90 text-slate-800 dark:text-slate-100 border border-slate-200/80 dark:border-slate-800/80 px-3.5 py-1.5 rounded-full shadow-md flex items-center gap-2.5 text-xs font-semibold backdrop-blur-md transition-all duration-300 pointer-events-auto">
                <div className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                </div>
                <Code className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400" />
                <span className="tracking-wide">SCAD Compiling</span>
              </div>
            )}
            {mcpActiveCount > 0 && (
              <div className="bg-white/90 dark:bg-slate-900/90 text-slate-800 dark:text-slate-100 border border-slate-200/80 dark:border-slate-800/80 px-3.5 py-1.5 rounded-full shadow-md flex items-center gap-2.5 text-xs font-semibold backdrop-blur-md transition-all duration-300 pointer-events-auto">
                <div className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </div>
                <Zap className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
                <span className="tracking-wide">MCP Active</span>
              </div>
            )}
          </div>

          {/* Axis Legend — HTML overlay, drawn to from inside the R3F Canvas via shared ref */}
          <div
            style={{
              position: 'absolute',
              top: '0.75rem',
              right: '0.75rem',
              zIndex: 15,
              pointerEvents: 'none',
              borderRadius: '10px',
              boxShadow: '0 2px 10px rgba(0,0,0,0.10)',
              padding: '3px',
            }}
            className="bg-slate-50/85 dark:bg-slate-900/85 backdrop-blur-md border border-slate-200/70 dark:border-slate-800/70"
          >
            <canvas ref={axisCanvasRef} width={76} height={76} style={{ display: 'block', borderRadius: '7px' }} />
          </div>
          
          <Canvas
            camera={CAMERA_CONFIG}
            // Every frame while the simulation runs, and only when asked while
            // it is stopped — see RenderOnChange.
            frameloop={isPlaying ? 'always' : 'demand'}
            // Plain PCF: 'soft' asks for PCFSoftShadowMap, which three r184 has
            // deprecated and quietly swaps for PCF anyway, with a warning.
            shadows="percentage"
            // Capped at 1.5: on a 2x display every pass below (shadow, scene,
            // ambient occlusion) ran at four times the pixels of a 1x one.
            dpr={[1, 1.5]}
            onPointerMissed={handlePointerMissed}
            style={paintMode ? { cursor: 'crosshair' } : undefined}
            // antialias off: the scene is drawn into the composer's own target,
            // which is not multisampled, so the canvas's MSAA only ever smoothed
            // the one full-screen quad the composer copies out. No
            // preserveDrawingBuffer either: its one reader, the MCP screenshot,
            // draws a frame immediately before reading the canvas.
            gl={{ antialias: false, logarithmicDepthBuffer: true }}
            onCreated={(state) => {
              physicsGlobals._physics_gl = state.gl;
              // The scene and camera as well as the renderer, so a screenshot
              // can draw a frame rather than read whatever the canvas last
              // happened to hold — see SCREENSHOT in useMCPBridge.
              physicsGlobals._physics_scene = state.scene;
              physicsGlobals._physics_camera = state.camera;
              const canvas = state.gl.domElement;
              // Without this, a lost WebGL context (GPU driver hiccup, memory
              // pressure, etc.) leaves the canvas permanently blank with no way
              // to recover in-app — preventDefault() tells the browser to try
              // restoring the context instead of abandoning it.
              canvas.addEventListener('webglcontextlost', (e) => {
                e.preventDefault();
                console.error('[Physics] WebGL context lost — attempting recovery');
              });
              canvas.addEventListener('webglcontextrestored', () => {
                console.warn('[Physics] WebGL context restored — forcing scene recompile to redraw');
                useStore.getState().recompile(useStore.getState().sceneGraph, undefined, false, true);
              });
            }}
          >
            <SceneCapture sceneRef={threeSceneRef} />
            <RenderOnChange />
            <DropHandler addComponent={addComponentUnderSelection} onImportFile={handleDroppedImportFile} onImportImageFile={handleDroppedImageFile} onImportSceneJson={importSceneJson} onUnsupportedDrop={(msg) => showNotice('Unsupported file', msg, 'amber')} />
            <StudioBackdrop darkMode={darkMode} />
            {/* A photo studio, built here rather than loaded: a broad softbox
                overhead, two strip lights either side and a dim grey room. It
                is where the shading comes from now — the diffuse light that
                wraps a body and the highlights that show a curved face is
                curved — so it runs well above the 0.12 the apartment HDR was
                held at. That HDR was also fetched from a CDN on every load.
                The ambient light under it was most of what the scene used to
                be lit by, and ambient lights every face the same, which is why
                a box read as three flat tints. It is kept only as a floor so
                nothing in a crevice goes fully black.
                background={false}: the room lights the bodies but is never
                drawn; the flat <color> above stays the backdrop. frames={1}
                (the default) renders the cube map once, not every frame. */}
            <Environment background={false} resolution={256} environmentIntensity={darkMode ? 0.7 : 0.8}>
              <color attach="background" args={['#3a3d42']} />
              <Lightformer form="rect" intensity={2.5} position={[0, 5, 0]} rotation-x={Math.PI / 2} scale={[8, 8, 1]} />
              <Lightformer form="rect" intensity={1.6} position={[-5, 1.5, 1]} rotation-y={Math.PI / 2} scale={[8, 2.5, 1]} />
              <Lightformer form="rect" intensity={1.0} position={[5, 1, -1]} rotation-y={-Math.PI / 2} scale={[8, 2.5, 1]} />
              <Lightformer form="rect" intensity={0.6} position={[0, 1, -5]} scale={[8, 2, 1]} />
            </Environment>
            <ambientLight intensity={0.08} />
            {/* The shadow camera is an orthographic box, and its default is +/-5m
                with a 512px map. This scene lives at part scale — the camera
                sits about 300mm out and shows 250mm of world — so the default
                spends its whole depth texture on empty space and resolves a
                part's shadow at roughly 20mm per texel, which is mush. Bounded
                to +/-0.8m at 2048px it lands near 0.8mm per texel instead,
                which is what a 250mm part needs to cast a shadow with an edge
                on it rather than a grey cloud.
                normalBias offsets the lookup along the surface normal, which is
                what keeps a body resting flat on the ground from shadow-acneing
                itself into stripes. 0.01 was tuned against that case — coarse,
                low-poly primitives. A lathed mesh with 96-120 radial wedges
                around a ~5cm cap works out to roughly 2-3mm of arc per wedge,
                right at this map's own ~2mm/texel resolution, so the acne
                shows up radiating with the wedges instead of as stripes. 0.03
                clears that without visible peter-panning at bench scale. */}
            {/* Hi-Res doubles the map (about 0.4mm per texel) and widens the
                PCF filter to soften the shadow's edge. Only so far: three r184
                filters with five taps rotated per pixel, so a wider radius goes
                grainy rather than softer. */}
            <directionalLight
              ref={keyLightRef}
              position={[1.5, 3, 1.5]}
              intensity={darkMode ? 1.4 : 1.2}
              castShadow
              shadow-mapSize={hiRes ? [4096, 4096] : [2048, 2048]}
              shadow-radius={hiRes ? 4 : 1}
              shadow-camera-left={-0.8}
              shadow-camera-right={0.8}
              shadow-camera-top={0.8}
              shadow-camera-bottom={-0.8}
              shadow-camera-near={0.1}
              shadow-camera-far={6}
              shadow-normalBias={0.03}
            />
            {/* Double-sided: drei's Grid defaults to BackSide, so the graph
                paper vanished the moment the camera dropped below the floor —
                which it does whenever you orbit under a part to look at its
                underside, and losing the ground is losing the only reference
                for where the part is. */}
            {/* Fades at 1.6 m, which is where the rest of this scene already
                stops: the shadow camera is +/-0.8 m and the shadow catcher is a
                1.6 m plane, so past that there is ground drawn but nothing
                grounded on it. The floor is also the main thing the eye judges
                a part's size against — a horizon six windows away is what made
                a 35 mm part read as a dot on an airfield — so it ends a few
                part-widths out and no further.

                Still `infiniteGrid`: it is the fade that is pulled in, not the
                plane, so there is no visible edge to the world.

                fadeDistance here is only the value the first frame is drawn
                with: GridFadeFollowsCamera takes it over and keeps it at a
                fixed multiple of the orbit distance, so the fade is the same
                at every zoom instead of being absent on a 40mm part and heavy
                on a half-metre one.

                fadeStrength is the shape of that falloff, not its reach: drei
                draws the grid at pow(1 - dist/fadeDistance, fadeStrength). At 1
                the fade starts at the camera and the graph paper is already
                half washed out where the part is standing, which reads as haze
                over the model rather than as ground running out. 0.8 keeps the
                grid mostly solid around the part and spends the rest of the
                fade further out, where it is doing the job of hiding the
                horizon — see GRID_FADE_RATIO for the pair of them. */}
            <Grid
              name={GRID_NAME}
              infiniteGrid
              side={THREE.DoubleSide}
              fadeDistance={1.6}
              fadeStrength={0.8}
              sectionSize={(gridCellSizeMm / 1000) * 5}
              cellSize={gridCellSizeMm / 1000}
              cellColor={darkMode ? '#334155' : '#cbd5e1'}
              sectionColor={darkMode ? '#64748b' : '#94a3b8'}
              position={[0, -0.005, 0]}
            />
            <GridFadeFollowsCamera />

            {/* Every geom already casts and receives, but until now nothing on
                the ground caught any of it: drei's Grid is a custom shader that
                doesn't receive shadows, so bodies only shadowed each other and
                the floor stayed clean. That's the one place the eye reads
                contact and height from, so a part hovering 20mm up looked
                identical to one sitting down.
                ShadowMaterial draws nothing but the shadow itself, so the grid
                still shows through underneath. Sized to match the shadow
                camera's 1.6m footprint exactly — a larger plane would sample
                outside the depth texture and smear its edge texels outward.
                raycast is stubbed off deliberately: a plane across the
                viewport floor would otherwise swallow every background click,
                and onPointerMissed — the only thing that clears the selection —
                would never fire again. */}
            <mesh
              rotation={[-Math.PI / 2, 0, 0]}
              position={[0, 0, 0]}
              receiveShadow
              raycast={() => null}
            >
              <planeGeometry args={[1.6, 1.6]} />
              <shadowMaterial transparent opacity={darkMode ? 0.5 : 0.32} depthWrite={false} />
            </mesh>
            
            {model && data && mujoco && (
              <PhysicsLoop 
                key={`loop-${recompileId}`} 
                model={model} 
                data={data} 
                mujoco={mujoco} 
                isPlaying={isPlaying} 
              />
            )}
            {/* Outside the compile-keyed visuals on purpose: a lattice edit
                recompiles, and the editor must outlive its own commits. */}
            <LatticeEditorLayer model={model} data={data} mujoco={mujoco} />
            {model && data && mujoco && (
              /* Not keyed on recompileId any more. Remounting on every
                 rebuild threw away and rebuilt every geometry in the scene —
                 each mesh's buffers and normals — for a colour change, and
                 tore the sculpt tools down after each of their own strokes.
                 The geoms re-read their ids and poses from the new model. */
              <SceneVisuals 
                model={model} 
                data={data} 
                mujoco={mujoco} 
                sceneGraph={effectiveGraph} 
                selectedNodeId={selectedNodeId}
                setSelectedNodeId={setSelectedNodeId}
                activeWeakSpot={activeWeakSpot}
                setActiveWeakSpot={setActiveWeakSpot}
              />
            )}
            
            {/* Rope markers rendered in raw world space (no coordinate system rotation) */}
            <PulleyRopeMarkers
              sceneGraph={sceneGraph}
              selectedNodeId={selectedNodeId}
              setSelectedNodeId={setSelectedNodeId}
            />
            
            <AxisLegendDrawer externalRef={axisCanvasRef} />
            <CameraController />
            <DragInteractionController />
            <PaintStrokeController />
            <ObjectGestureController />
            <TransformGizmo />
            <MeasureTool />
            <DimensionOverlay />
            <EdgeRoundTool />

            {/* Subtle contact-shadow AO — reads as "more depth", not a style
                change. The composer takes over the render loop from r3f, so a
                screenshot has to render through it too (see composerRef,
                _physics_composer, and SCREENSHOT in useMCPBridge) or it would
                silently capture a frame with no AO applied. */}
            <EffectComposer
              ref={(instance) => {
                composerRef.current = instance;
                physicsGlobals._physics_composer = instance;
              }}
              // MSAA on the composer's own target, which is where the scene is
              // drawn — the canvas's antialias flag only ever smoothed the
              // copy-out quad, so with this at 0 nothing in the viewport was
              // antialiased at all. The main cost of the Hi-Res switch.
              multisampling={hiRes ? 4 : 0}
              // The outline draws its selection mask between the composer's
              // passes and needs the renderer to leave the buffers alone;
              // the render pass still clears its own target.
              autoClear={false}
            >
              {/* No enableNormalPass. It drew the whole scene a second time
                  every frame, and at full resolution N8AO never reads it: the
                  shader samples `sceneNormal` only under HALFRES, and binds it
                  to null otherwise (n8ao/dist/N8AO.js, the sceneNormal uniform),
                  reconstructing normals from depth instead. A translucent halo
                  on a curved body is a mesh drawn inside out, not missing
                  normals — see "face winding" in CLAUDE.md. */}
              <N8AO
                aoRadius={0.35}
                intensity={0.8}
                distanceFalloff={1}
                color="black"
              />
              {/* Tone maps the bodies only, not the backdrop, grid or floor
                  shadow — see BodyToneMapping. Last in the chain so it sees
                  AO's output in linear light. Hi-Res only. */}
              {hiRes && <BodyToneMapping />}
              {/* After the tone mapping, so the outline is the blue asked for. */}
              {hiRes && <SelectionOutline />}
            </EffectComposer>
            {/* Draws over the composer's frame, so it comes after it. */}
            {pathTrace && <PathTracedView background={darkMode ? '#0b0f19' : '#f8fafc'} />}
            <MarqueeSelect />
          </Canvas>

          {pathTrace && (
            <div className="absolute bottom-14 right-4 z-10 px-2 py-0.5 rounded text-[10px] font-medium tabular-nums bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 pointer-events-none">
              {isPlaying ? 'Render paused while playing'
                : pathTracePhase === 'waiting' ? 'Render: waiting for the view to settle'
                : pathTracePhase === 'building' ? 'Render: preparing scene'
                : pathTracePhase === 'rendering' ? `Render: ${pathTraceSamples} samples`
                : `Render: done, ${pathTraceSamples} samples`}
            </div>
          )}

          {/* Floating Viewport Camera Controls */}
          <div className="absolute bottom-4 right-4 z-10 flex items-center gap-1 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border border-slate-200 dark:border-slate-800 p-1 rounded-lg shadow-sm">
            {([
              ['perspective', 'Perspective', 'The free view'],
              ['topDown', 'Top Down', 'Looking straight down, drawn flat (orthographic)'],
              ['front', 'Front', 'Looking at the front, drawn flat (orthographic)'],
              ['side', 'Side', 'Looking at the right-hand side, drawn flat (orthographic)'],
            ] as const).map(([view, label, title]) => (
              <button
                key={view}
                onClick={() => setCameraView(view)}
                title={title}
                className={`px-2.5 py-1 rounded text-[10px] font-bold tracking-wide transition-all cursor-pointer ${
                  // Orbited off a drawing view, its button is no longer lit:
                  // the view on screen is not that one, and a click puts it back.
                  cameraView === view && !(view !== 'perspective' && cameraOffAxis)
                    ? 'bg-blue-500 text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                {label}
              </button>
            ))}
            {/* Only in the flat views: a dimension means something there at
                every depth, and the overlay draws nothing anywhere else. */}
            {cameraView !== 'perspective' && (
              <button
                onClick={() => setDimsEnabled(!dimsEnabled)}
                title="Dimensions in mm for the selected part, or every part when none is selected"
                className={`px-2.5 py-1 rounded text-[10px] font-bold tracking-wide transition-all cursor-pointer ${
                  dimsEnabled
                    ? 'bg-amber-500 text-white shadow-xs'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                Dims
              </button>
            )}
            {/* Checks the selected part against how it will actually be made.
                No process picker: the machine and the material are already
                chosen in the bottom bar, and asking again is how two controls
                end up disagreeing. */}
            <button
              onClick={() => setDfmEnabled(!dfmEnabled)}
              title="Checks the selected part against the machine and material on the bench: what a printer cannot support, what a router cannot reach."
              className={`px-2.5 py-1 rounded text-[10px] font-bold tracking-wide transition-all cursor-pointer flex items-center gap-1 ${
                dfmEnabled
                  ? 'bg-amber-500 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              DFM
            </button>
            <button
              onClick={() => toggleWireframe()}
              title="Draw every body as the edges of its triangles. Shows the tessellation a slicer or CAM job receives, and lets you see through the model."
              className={`px-2.5 py-1 rounded text-[10px] font-bold tracking-wide transition-all cursor-pointer flex items-center gap-1 ${
                wireframe
                  ? 'bg-violet-500 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              <Grid3x3 className="w-3 h-3" />
              Wireframe
            </button>
            <button
              onClick={() => toggleShowEdges()}
              title="Draw a line along every real corner, so two faces lit the same still read as two. Only edges sharper than about 20°."
              className={`px-2.5 py-1 rounded text-[10px] font-bold tracking-wide transition-all cursor-pointer flex items-center gap-1 ${
                showEdges
                  ? 'bg-violet-500 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              <Box className="w-3 h-3" />
              Edges
            </button>
            <button
              onClick={() => setPathTrace(!pathTrace)}
              title="Path trace the view whenever it is still: real soft shadows and reflections. Uses the whole GPU until the image settles, so leave it off while working."
              className={`px-2.5 py-1 rounded text-[10px] font-bold tracking-wide transition-all cursor-pointer flex items-center gap-1 ${
                pathTrace
                  ? 'bg-violet-500 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              <Aperture className="w-3 h-3" />
              Render
            </button>
            <select
              value={gridCellSizeMm}
              onChange={(e) => setGridCellSizeMm(parseFloat(e.target.value))}
              title="Grid cell size (display only; does not change any body's dimensions)"
              className="px-1.5 py-1 rounded text-[10px] font-bold tracking-wide bg-transparent text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer outline-none border-none"
            >
              <option value={1}>1mm grid</option>
              <option value={10}>10mm grid</option>
              <option value={100}>100mm grid</option>
            </select>

          </div>

          {/* Sculpt tool palette — only mounted while a body is open for sculpting */}
          <SculptPanel />
          {/* Lattice tool palette — likewise, only while a cage is open */}
          <LatticePanel onOpenDocs={() => openDocs('lattice')} />

          {/* Floating Mechanical & 3D Print Failure HUD */}
          <DfmHUD />

          {/* Floating Note Card Overlays */}
          {noteCards.map(card => (
            <NoteCardOverlay
              key={card.id}
              card={card}
              isEditing={editingCardId === card.id}
              onToggleEdit={() => setEditingCardId(prev => prev === card.id ? null : card.id)}
              onToggleMinimize={() => setNoteCards(prev => prev.map(c => c.id === card.id ? { ...c, minimized: !c.minimized } : c))}
              onMarkdownChange={(md) => setNoteCards(prev => prev.map(c => c.id === card.id ? { ...c, markdown: md } : c))}
              onClose={() => { setNoteCards(prev => prev.filter(c => c.id !== card.id)); if (editingCardId === card.id) setEditingCardId(null); }}
              onMove={(x, y) => setNoteCards(prev => prev.map(c => c.id === card.id ? { ...c, x, y } : c))}
            />
          ))}
        </main>

        <InspectorPanel />

        {showAICopilot && (
          <AICopilotPanel
            onClose={() => setShowAICopilot(false)}
            messages={copilotMessages}
            setMessages={setCopilotMessages}
          />
        )}
      </div>

      {isDocsOpen && (
        <DocsModal tab={docsTab} onTab={setDocsTab} onClose={closeDocs} />
      )}

      {/* Share link report.

          Portalled to the body: the toolbar it is triggered from sits inside a
          stacking context of its own, so a z-index set in there is only a rank
          among that context's siblings. z-[105] puts it above the note cards
          (zIndex 25) and below the dialogs.

          The link is in a selectable field as well as on the clipboard: a
          clipboard write is refused on an insecure origin, and a share button
          that silently did nothing is indistinguishable from one that
          worked. */}
      {(share || shareError || shareTooBig) &&
        createPortal(
          <div className="fixed top-16 right-4 max-lg:top-1/2 max-lg:right-1/2 max-lg:translate-x-1/2 max-lg:-translate-y-1/2 z-[105] w-[28rem] max-w-[90vw] p-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl text-xs">
            <div className="flex items-start justify-between gap-3">
              <p className="font-bold text-slate-800 dark:text-slate-100">
                {shareTooBig
                  ? 'This scene is too big to put in a link'
                  : shareError
                    ? 'This scene could not be shared as a link'
                    : shareCopied
                      ? 'Link copied'
                      : 'Share link'}
              </p>
              <button
                onClick={() => {
                  setShare(null);
                  setShareError(null);
                  setShareTooBig(null);
                }}
                className="text-slate-400 hover:text-slate-700 dark:hover:text-white font-bold cursor-pointer px-1"
                title="Dismiss"
              >
                ✕
              </button>
            </div>

            {shareError && (
              <p className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-400">{shareError}</p>
            )}

            {/* The offer, not an apology.

                A sculpt or an imported mesh will never fit in a URL — the
                vertices are in the scene — so "too big" is the ordinary outcome
                for half the things worth showing somebody. The one thing that
                fixes it is an account, and this is the moment it is worth
                having one, so it is asked for here rather than left to be
                discovered behind the avatar in the corner. */}
            {shareTooBig && (
              <div className="mt-1.5 space-y-2">
                <p className="text-[11px] text-slate-600 dark:text-slate-300">{shareTooBig.message}</p>
                {canShareViaAccount() ? (
                  <>
                    <p className="text-[11px] text-slate-600 dark:text-slate-300">
                      Your account can hold it instead, and the link becomes a short one.
                    </p>
                    <button
                      onClick={handleAccountShare}
                      disabled={shareBusy}
                      className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white font-semibold cursor-pointer transition-colors"
                    >
                      <Share2 className="w-3 h-3" />
                      {shareBusy ? 'Storing the scene…' : 'Share from your account'}
                    </button>
                  </>
                ) : (
                  <>
                    <p className="text-[11px] text-slate-600 dark:text-slate-300">
                      Sign in and your account can hold the scene instead — the link becomes a short
                      one, anyone can open it without an account, and you can turn it off later.
                      It is free; there is nothing to buy.
                    </p>
                    <button
                      onClick={() =>
                        window.dispatchEvent(
                          new CustomEvent(SIGN_IN_REQUESTED_EVENT, { detail: { reason: 'share' } })
                        )
                      }
                      className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white font-semibold cursor-pointer transition-colors"
                    >
                      Sign in to share this scene
                    </button>
                  </>
                )}
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Or export STL and send the file.
                </p>
              </div>
            )}

            {share && (
              <>
                <div className="mt-2 flex items-center gap-1.5">
                  <input
                    readOnly
                    value={share.url}
                    onFocus={(e) => e.currentTarget.select()}
                    className="flex-1 min-w-0 px-2 py-1 rounded-md bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 font-mono text-[10px] outline-none"
                  />
                  <button
                    onClick={() => copyShareLink(share.url)}
                    className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md bg-sky-600 hover:bg-sky-500 text-white font-semibold cursor-pointer transition-colors"
                    title="Copy link"
                  >
                    {shareCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    {shareCopied ? 'Copied' : 'Copy'}
                  </button>
                  {share.travelsWell && typeof navigator !== 'undefined' && 'share' in navigator && (
                    <button
                      onClick={() => {
                        void navigator.share({ title: 'Mesh scene', url: share.url }).catch(() => {
                          // Cancelled, or refused for a URL this long. The copy is already made.
                        });
                      }}
                      className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 font-semibold cursor-pointer transition-colors"
                      title="Send it to a message, a post or another app"
                    >
                      <Share2 className="w-3 h-3" />
                      Send
                    </button>
                  )}
                </div>
                <ul className="mt-1.5 space-y-1 text-[11px] text-slate-500 dark:text-slate-400 list-disc list-inside">
                  {share.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
                {/* Only for a link that points at the account. A link with the
                    scene inside it is already out there and cannot be recalled;
                    offering to turn one off would be a lie. */}
                {share.token && (
                  <button
                    onClick={() => handleStopSharing(share.token!)}
                    disabled={shareBusy}
                    className="mt-2 text-[11px] text-red-600 dark:text-red-400 hover:underline disabled:opacity-50 cursor-pointer"
                  >
                    {shareBusy ? 'Turning it off…' : 'Stop sharing this link'}
                  </button>
                )}
              </>
            )}
          </div>,
          document.body
        )}

      {dialogModal && (
        <ConfirmModal
          title={dialogModal.title}
          body={dialogModal.body}
          confirmLabel={dialogModal.confirmLabel}
          cancelLabel={dialogModal.cancelLabel}
          hideCancel={dialogModal.hideCancel}
          tone={dialogModal.tone}
          onCancel={dialogModal.onCancel ?? (() => setDialogModal(null))}
          onConfirm={dialogModal.onConfirm}
        />
      )}

      {exportScaleModal && (
        <ExportScaleModal
          title={exportScaleModal.title}
          initialMm={exportScaleModal.value}
          onCancel={() => setExportScaleModal(null)}
          onConfirm={(targetMm) => {
            const cb = exportScaleModal.onConfirm;
            setExportScaleModal(null);
            cb(targetMm);
          }}
        />
      )}

      {isSaveModalOpen && (
        <div
          className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={() => setIsSaveModalOpen(false)}
        >
          <div
            className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-2xl max-w-md w-full p-6 flex flex-col gap-4 animate-in fade-in zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-blue-100 dark:bg-blue-950/60 flex items-center justify-center text-blue-600 dark:text-blue-400">
                <Save className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-bold text-slate-800 dark:text-slate-100 text-base">Save Scene Preset</h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">Give your scene a name to save it locally</p>
              </div>
            </div>
            <input
              autoFocus
              type="text"
              placeholder="e.g. Double Pendulum Wave"
              value={presetNameInput}
              onChange={(e) => setPresetNameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConfirmSavePreset();
                if (e.key === 'Escape') setIsSaveModalOpen(false);
              }}
              className="w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="flex justify-end gap-2 text-xs">
              <button
                onClick={() => setIsSaveModalOpen(false)}
                className="px-4 py-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors font-semibold cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmSavePreset}
                disabled={!presetNameInput.trim()}
                className="px-4 py-2 font-semibold text-white bg-blue-500 hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors cursor-pointer"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import STL Modal — mounted only while open so each import starts clean */}
      {isImportStlModalOpen && (
      <ImportStlModal
        isOpen={isImportStlModalOpen}
        initialFile={droppedImportFile}
        onClose={() => {
          setIsImportStlModalOpen(false);
          setDroppedImportFile(null);
        }}
        onImportNode={(newNode) => {
          const currentNodes = useStore.getState().sceneGraph.nodes || [];
          useStore.getState().updateScene({ nodes: [...currentNodes, newNode] });
        }}
      />
      )}

      {/* Surface pattern generators. Reads its own open/closed state from the
          store, so there is nothing to pass and nothing to keep in step. */}
      <GeneratePatternModal />
      <FacePatternModal />

      {/* Image heightmap importer — mounted only while open, like the STL one */}
      {isImportImageModalOpen && (
      <ImportImageModal
        isOpen={isImportImageModalOpen}
        initialFile={droppedImageFile}
        onClose={() => {
          setIsImportImageModalOpen(false);
          setDroppedImageFile(null);
        }}
        onImportNode={(newNode) => {
          const currentNodes = useStore.getState().sceneGraph.nodes || [];
          useStore.getState().updateScene({ nodes: [...currentNodes, newNode] });
        }}
      />
      )}

      {/* The zeroing walkthrough is deep-linked from the shared Machine Setup
          dialog now, rather than from a copy of the machine panel in each of
          these — see MachineConfigModal below. */}
      <ExportLaserCutModal
        isOpen={isLaserCutModalOpen}
        onClose={() => setIsLaserCutModalOpen(false)}
        scene={sceneGraph}
      />

      <ExportContourSliceModal
        isOpen={isContourSliceModalOpen}
        onClose={() => setIsContourSliceModalOpen(false)}
        scene={sceneGraph}
      />

      <ExportReliefCarveModal
        isOpen={isReliefCarveModalOpen}
        onClose={() => setIsReliefCarveModalOpen(false)}
        scene={sceneGraph}
      />

      <ExportMoldModal
        isOpen={isMoldModalOpen}
        onClose={() => setIsMoldModalOpen(false)}
        scene={sceneGraph}
      />
      <ExportSolidMachiningModal
        isOpen={isSolidModalOpen}
        onClose={() => setIsSolidModalOpen(false)}
        scene={sceneGraph}
      />
      <ExportCastModal
        isOpen={isCastModalOpen}
        onClose={() => setIsCastModalOpen(false)}
        scene={sceneGraph}
      />
      <SplitForPrintModal
        isOpen={isSplitModalOpen}
        onClose={() => setIsSplitModalOpen(false)}
      />

      <BottomStatusBar
        onOpenMachineConfig={() => setMachineConfigOpen(true)}
        exports={{
          stl: exportStl,
          threeMf: export3mf,
          mold: () => setIsMoldModalOpen(true),
          unwrap: () => setIsLaserCutModalOpen(true),
          contourSlices: () => setIsContourSliceModalOpen(true),
          reliefCarve: () => setIsReliefCarveModalOpen(true),
          solid: () => setIsSolidModalOpen(true),
          cast: () => setIsCastModalOpen(true),
          split: () => setIsSplitModalOpen(true),
        }}
      />

      <MachineConfigModal
        isOpen={isMachineConfigOpen}
        onClose={() => setMachineConfigOpen(false)}
        onOpenDocs={() => openDocs('zeroing')}
        machineTarget={machineTarget}
      />

      {/* A job that was still cutting when this browser last closed. Mounted at
          the top level and not inside an export modal, because the session that
          opened that modal is the session that went away. */}
      <JobRestoreModal />
      {/* A job that ran to its last line, wherever it was started from. */}
      <JobSucceededModal />
      <PresetSaveNotice />
    </div>
  );
}

export default App;
