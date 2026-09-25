
import { Canvas } from '@react-three/fiber';
import { Grid, Environment } from '@react-three/drei';
import { DEFAULT_EYE } from './utils/frameScene';
import { EffectComposer, N8AO } from '@react-three/postprocessing';
import { SCULPT_BASES, type SculptBaseId } from './utils/sculptBases';
import { downloadMeshGeomStl } from './utils/meshStlExport';
import SculptPanel from './components/SculptPanel';
import LatticePanel from './components/LatticePanel';
import { CutControls } from './components/CutControls';
import ColoringSection from './components/ColoringSection';
import { useMuJoCoInit } from './hooks/useMuJoCo';
import { useMCPBridge } from './hooks/useMCPBridge';
import { useCoarsePointer } from './hooks/useCoarsePointer';
import { useShallow } from 'zustand/react/shallow';
import { useStore, getPhysicsWorkerClient, cloneSceneGraph } from './store/useStore';
import { useDentStore } from './store/dentStore';
import { applyShatterPieces } from './store/useStore';
import type { SceneGraph, SceneNode, SceneGeom, SceneJoint, CsgOp } from './types/scene';
import type { WeakSpot } from './utils/printAnalysis';
import { Play, Square, SlidersHorizontal, Settings, Box, Circle, X, RotateCcw, Trash2, Layers, CircleDot, Zap, Info, Triangle, Disc, Code, Menu, Shapes, Minimize2, Save, Download, Upload, Undo, Redo, FileText, PanelRight, Printer, Scissors, Sparkles, Sun, Moon, Pyramid, Cone, Donut, ChartSpline, Paintbrush, Grid3x3, Image as ImageIcon, Share2, Copy, Check, Link2, Unlink, Hammer } from 'lucide-react';
import { useRef, useMemo, useEffect, useCallback, useState, type ComponentRef } from 'react';
import AICopilotPanel from './components/AICopilotPanel';
import { DocsModal } from './components/docs/DocsModal';
import { DocsInfoButton } from './components/docs/DocsInfoButton';
import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { exportThreeMf, type ThreeMfMesh } from './utils/threeMfExporter';
import { simplifyGeomMesh, toRenderVertices } from './utils/simplifyMesh';
import { sliderSpan, offsetSpan, lengthSpan } from './utils/sliderSpan';
import { loadCompiler, compileSCAD, isCompilerReady, setScadCompileListener } from './utils/openscad';
import { getStickyRotation } from './utils/geom';
import { csgSourceGeoms, csgHashOf, collisionModeOf, CSG_DEFAULT_SECTORS } from './utils/csg';
import { DEFAULT_HOLD_STEPS, isBreakable, weldKey } from './utils/breakThresholds';
import { isDentable, needsConversionForDenting } from './utils/dentMesh';
import { CUSTOM_DENT, CUSTOM_SHATTER, DEFORM_MATERIALS, deformMaterial, dentFields, estimateBodyMass, materialUpdates, shatterFields } from './utils/deformMaterials';
import { collidersAreStale, solidMeshGeoms } from './utils/convexDecomposition';
import { useCsgAutoCompile } from './hooks/useCsgCompile';
import { PRESETS } from './presets/presetScenes';
import { makePresetNoteCard, type NoteCard } from './utils/noteCards';
import { physicsGlobals, type CopilotMessage } from './physicsGlobals';
import { ImportStlModal } from './components/ImportStlModal';
import { ImportImageModal } from './components/ImportImageModal';
import { GeneratePatternModal } from './components/GeneratePatternModal';
import { SURFACE_PATTERNS } from './utils/surfacePatterns';
import { ExportLaserCutModal } from './components/ExportLaserCutModal';
import { ExportContourSliceModal } from './components/ExportContourSliceModal';
import { ExportReliefCarveModal } from './components/ExportReliefCarveModal';
import { ExportMoldModal } from './components/ExportMoldModal';
import { ExportSolidMachiningModal } from './components/ExportSolidMachiningModal';
import { ExportCastModal } from './components/ExportCastModal';
import { PulleyRopeMarkers } from './components/scene/PulleyRopes';
import { SliderValue } from './components/SliderValue';
import { RangeInput } from './components/RangeInput';
import { SettledNumberInput, SettledTextInput } from './components/SettledInputs';
import { ScaleControls } from './components/ScaleCard';
import { ConfirmModal } from './components/ConfirmModal';
import { CompileErrorBanner } from './components/CompileErrorBanner';
import { ObjectGestureController } from './components/scene/ObjectGestures';
import { TransformGizmo } from './components/scene/TransformGizmo';
import { isGizmoBusy } from './components/scene/gizmoBusy';
import { MeasureTool } from './components/scene/MeasureTool';
import { EdgeRoundTool } from './components/scene/EdgeRoundTool';
import { EdgeRoundPanel } from './components/EdgeRoundPanel';
import { EdgesCard } from './components/EdgesCard';
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
import { MIN_MAX_TOKENS, MAX_MAX_TOKENS, readMaxTokens, writeMaxTokens } from './utils/llmSettings';
import { DfmHUD } from './components/DfmHUD';
import { createHeatSetBossNode, createHexNutTrapNode, createBearingPocketNode, createDShaftHubNode, createCounterboreHoleNode } from './utils/hardwareComponents';
import { pushGlobalParameter } from './utils/llmSettings';
import { saveUserPreset, deleteUserPreset, readUserPreset, listUserPresetNames } from './utils/userPresets';
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
import { generateScadForNode, parseScadVariables, replaceVarInCode } from './utils/scadSource';
import { isTopLevel, findNodeById, getNodeWorldPos, patchGeom } from './utils/sceneTree';
import { NoteCardOverlay } from './components/NoteCardOverlay';
import { AxisLegendDrawer } from './components/AxisLegendDrawer';
import { DropHandler } from './components/DropHandler';
import { PhysicsLoop } from './components/scene/PhysicsLoop';
import { RenderOnChange } from './components/scene/RenderOnChange';
import { GridFadeFollowsCamera } from './components/scene/GridFadeFollowsCamera';
import { GRID_NAME } from './components/scene/gridConstants';
import { anthropicUrl, geminiUrl } from './utils/llmEndpoints';

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

  // The reference guide's open state lives in the store: the (i) buttons that
  // deep-link into it are spread through the property cards, which read it
  // themselves rather than being handed an opener apiece.
  const isDocsOpen = useStore((s) => s.isDocsOpen);
  const docsTab = useStore((s) => s.docsTab);
  const openDocs = useStore((s) => s.openDocs);
  const setDocsTab = useStore((s) => s.setDocsTab);
  const closeDocs = useStore((s) => s.closeDocs);
  useEscapeToClose(isDocsOpen, closeDocs);
  const [showAICopilot, setShowAICopilot] = useState(false);
  // Set when Free is picked for a body that hangs under another: MuJoCo only
  // allows a free joint at the top level, so the body has to be detached
  // first and that is not something to do behind someone's back.
  const [detachForFree, setDetachForFree] = useState<{ id: string; joints: SceneJoint[] } | null>(null);
  const [scriptText, setScriptText] = useState('');
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [meshEditorGeom, setMeshEditorGeom] = useState<string | null>(null);
  const [meshEditorText, setMeshEditorText] = useState('');
  const [meshEditorError, setMeshEditorError] = useState<string | null>(null);
  const [meshSimplifierGeom, setMeshSimplifierGeom] = useState<string | null>(null);
  const [simplifyRatio, setSimplifyRatio] = useState(0.5);
  const [meshSimplifierError, setMeshSimplifierError] = useState<string | null>(null);
  const [showApiRef, setShowApiRef] = useState(false);
  const [propertiesWidth, setPropertiesWidth] = useState(380);
  const [isLeftSidebarOpen, setIsLeftSidebarOpen] = useState(false);
  const coarsePointer = useCoarsePointer();
  /**
   * Whether the properties inspector is showing as an overlay drawer.
   *
   * Only consulted below the `lg` breakpoint — at desktop width the inspector
   * is a permanent column and this is ignored, so nothing here can change the
   * desktop layout. It opens only when the toolbar button is pressed: on a
   * phone the drawer covers the model, so selecting a body to *see* it would
   * otherwise immediately hide it behind the panel describing it.
   */
  const [isPropertiesOpen, setIsPropertiesOpen] = useState(false);
  const [isSaveModalOpen, setIsSaveModalOpen] = useState(false);
  const [isImportStlModalOpen, setIsImportStlModalOpen] = useState(false);
  const [isLaserCutModalOpen, setIsLaserCutModalOpen] = useState(false);
  const [isContourSliceModalOpen, setIsContourSliceModalOpen] = useState(false);
  const [isReliefCarveModalOpen, setIsReliefCarveModalOpen] = useState(false);
  const [isMoldModalOpen, setIsMoldModalOpen] = useState(false);
  const [isSolidModalOpen, setIsSolidModalOpen] = useState(false);
  const [isCastModalOpen, setIsCastModalOpen] = useState(false);
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
  const activeGeomIndex = useStore((s) => s.activeGeomIndex);
  const setActiveGeomIndex = useStore((s) => s.setActiveGeomIndex);
  // While anything is in pieces the scene on screen is the document with the
  // broken bodies swapped for their shards. See `shatterPieces` in the store.
  const shatteredBodies = useStore((s) => s.visibleShatteredBodies);
  const lastShatter = useStore((s) => s.lastShatter);
  // Only the selected body's dents: the panel shows no one else's, and a
  // subscription to the whole map re-rendered the app for every dent anywhere
  // in the scene, several a second while things are colliding.
  const selectedNodeIdForDents = useStore((s) => s.selectedNodeId);
  const dents = useDentStore(useShallow((s) => {
    const mine: typeof s.dents = {};
    if (!selectedNodeIdForDents) return mine;
    const prefix = `${selectedNodeIdForDents}/`;
    for (const key in s.dents) if (key.startsWith(prefix)) mine[key] = s.dents[key];
    return mine;
  }));
  const brokenConstraints = useStore((s) => s.brokenConstraints);
  const lastBreak = useStore((s) => s.lastBreak);
  const restoreConstraint = useStore((s) => s.restoreConstraint);
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
  const [scadText, setScadText] = useState('');
  const [scadError, setScadError] = useState<string | null>(null);
  const [isScadCompiling, setIsScadCompiling] = useState(false);
  const [isCompilerLoading, setIsCompilerLoading] = useState(false);
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

  const scadVars = useMemo(() => parseScadVariables(scadText), [scadText]);
  const compileTimeoutRef = useRef<number | null>(null);

  // OpenSCAD Slider Debouncing State
  const [slidingValues, setSlidingValues] = useState<Record<string, number>>({});

  const scadTextRef = useRef(scadText);
  useEffect(() => {
    scadTextRef.current = scadText;
  }, [scadText]);

  const slidingValuesRef = useRef(slidingValues);
  useEffect(() => {
    slidingValuesRef.current = slidingValues;
  }, [slidingValues]);

  const updateCodeTimeoutRef = useRef<number | null>(null);

  const debouncedUpdateCode = useCallback(() => {
    if (updateCodeTimeoutRef.current) {
      window.clearTimeout(updateCodeTimeoutRef.current);
    }
    updateCodeTimeoutRef.current = window.setTimeout(async () => {
      let updated = scadTextRef.current;
      for (const [name, value] of Object.entries(slidingValuesRef.current)) {
        updated = replaceVarInCode(updated, name, value);
      }
      setScadText(updated);

      const selectedNodeId = useStore.getState().selectedNodeId;
      if (!selectedNodeId) return;
      setIsScadCompiling(true);
      setScadError(null);
      try {
        const compiled = await compileSCAD(updated);
        useStore.getState().updateNodeScad(selectedNodeId, updated, compiled);
      } catch (e) {
        console.error('OpenSCAD Auto-Compilation Error:', e);
        setScadError((e as Error).message || 'Auto-compilation failed.');
      } finally {
        setIsScadCompiling(false);
        setSlidingValues({});
      }
    }, 300);
  }, []);

  useEffect(() => {
    return () => {
      /* eslint-disable react-hooks/exhaustive-deps */
      if (compileTimeoutRef.current) {
        window.clearTimeout(compileTimeoutRef.current);
      }
      if (updateCodeTimeoutRef.current) {
        window.clearTimeout(updateCodeTimeoutRef.current);
      }
      /* eslint-enable react-hooks/exhaustive-deps */
    };
  }, []);

  // Expose noteCards and copilotMessages state to MCP bridge and noteCard manager
  useEffect(() => {
    physicsGlobals._physics_getNoteCards = () => noteCards;
    physicsGlobals._physics_setNoteCards = (cards: typeof noteCards) => setNoteCards(cards);
    physicsGlobals._physics_getCopilotMessages = () => copilotMessages;
    physicsGlobals._physics_setCopilotMessages = (msgs: typeof copilotMessages) => setCopilotMessages(msgs);
    physicsGlobals._physics_store = useStore;
  }, [noteCards, copilotMessages]);


  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const handleMouseMove = (moveEvent: MouseEvent) => {
      const newWidth = window.innerWidth - moveEvent.clientX;
      if (newWidth >= 280 && newWidth <= 800) {
        setPropertiesWidth(newWidth);
      }
    };
    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, []);

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
    dfmEnabled, setDfmEnabled,
    wireframe, toggleWireframe, showEdges, toggleShowEdges, paintMode,
    gridCellSizeMm, setGridCellSizeMm,
    sceneGraph, selectedNodeId, setSelectedNodeId,
    updateNodeGeom, updateNodeJoint, updateGearTeeth, addPusherPeg, deletePusherPeg, updatePusherPeg, addComponent, loadPreset, openPatternGenerator, updateScene,
    resetSimulation, updateNodePos,
    updateNodeJointsList, deleteNode, renameNode,
    addHardwareComponentNode, updateNodeRotation, rotateAroundCOM, setRotateAroundCOM,
    updateWedgeParams, updatePyramidParams, updateConeParams, updateTorusParams, updateTubeParams, updateCurveParams, updatePulleyParams, updateRopeParams,
    parentUnderSelected, setParentUnderSelected, updateNodeScript, updateNode,
    deleteNodeGeom, setGeomCsgOp,
    sculptNodeId, setSculptNodeId, setSculptBase,
    latticeNodeId, setLatticeNodeId,
    extraSelectedIds, combineBodies,
    undoStack, redoStack,
    makeDentable,
  } = useStore(useShallow((s) => ({
    model: s.model, data: s.data, mujoco: s.mujoco, recompileId: s.recompileId, activePreset: s.activePreset,
    isPlaying: s.isPlaying, togglePlay: s.togglePlay, isLoaded: s.isLoaded,
    mcpActiveCount: s.mcpActiveCount, scadCompileCount: s.scadCompileCount,
    isSettingsOpen: s.isSettingsOpen, setSettingsOpen: s.setSettingsOpen,
    gravityZ: s.gravityZ, windX: s.windX, windY: s.windY, density: s.density, floorFriction: s.floorFriction, floorBounce: s.floorBounce, setEnvironment: s.setEnvironment,
    cameraView: s.cameraView, setCameraView: s.setCameraView,
    dfmEnabled: s.dfmEnabled, setDfmEnabled: s.setDfmEnabled,
    wireframe: s.wireframe, toggleWireframe: s.toggleWireframe, showEdges: s.showEdges, toggleShowEdges: s.toggleShowEdges, paintMode: s.paintMode,
    gridCellSizeMm: s.gridCellSizeMm, setGridCellSizeMm: s.setGridCellSizeMm,
    sceneGraph: s.sceneGraph, selectedNodeId: s.selectedNodeId, setSelectedNodeId: s.setSelectedNodeId,
    updateNodeGeom: s.updateNodeGeom, updateNodeJoint: s.updateNodeJoint, updateGearTeeth: s.updateGearTeeth, addPusherPeg: s.addPusherPeg, deletePusherPeg: s.deletePusherPeg, updatePusherPeg: s.updatePusherPeg, addComponent: s.addComponent, loadPreset: s.loadPreset, openPatternGenerator: s.openPatternGenerator, updateScene: s.updateScene,
    resetSimulation: s.resetSimulation, updateNodePos: s.updateNodePos,
    updateNodeJointsList: s.updateNodeJointsList, deleteNode: s.deleteNode, renameNode: s.renameNode,
    addHardwareComponentNode: s.addHardwareComponentNode, updateNodeRotation: s.updateNodeRotation, rotateAroundCOM: s.rotateAroundCOM, setRotateAroundCOM: s.setRotateAroundCOM,
    updateWedgeParams: s.updateWedgeParams, updatePyramidParams: s.updatePyramidParams, updateConeParams: s.updateConeParams, updateTorusParams: s.updateTorusParams, updateTubeParams: s.updateTubeParams, updateCurveParams: s.updateCurveParams, updatePulleyParams: s.updatePulleyParams, updateRopeParams: s.updateRopeParams,
    parentUnderSelected: s.parentUnderSelected, setParentUnderSelected: s.setParentUnderSelected, updateNodeScript: s.updateNodeScript, updateNode: s.updateNode,
    deleteNodeGeom: s.deleteNodeGeom, setGeomCsgOp: s.setGeomCsgOp,
    sculptNodeId: s.sculptNodeId, setSculptNodeId: s.setSculptNodeId, setSculptBase: s.setSculptBase,
    latticeNodeId: s.latticeNodeId, setLatticeNodeId: s.setLatticeNodeId,
    extraSelectedIds: s.extraSelectedIds, combineBodies: s.combineBodies,
    undoStack: s.undoStack, redoStack: s.redoStack,
    makeDentable: s.makeDentable,
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
      alert(`Could not save "${trimmed}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [sceneGraph, model, data, mujoco, noteCards, copilotMessages, markClean]);

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
  const openSharedScene = useCallback((shared: SharedScene): boolean => {
    if (
      !window.confirm(
        `Open "${shared.name}"?\n\n` +
          'It is saved under that name and replaces the scene on screen. ' +
          'Save what you have first if you want it back.\n' +
          'Cancel keeps it — the link stays in the address bar, so you can reload to open it later.'
      )
    ) {
      return false;
    }
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
    return true;
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
   * Returns null when the user cancels the size prompt.
   */
  const buildExportGroup = useCallback((): THREE.Group | null => {
    const scene = threeSceneRef.current;
    if (!scene) { alert('Scene not ready'); return null; }

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
      const targetStr = window.prompt("Longest part's longest side (mm):", defaultMm);
      if (targetStr === null) return null;
      const targetMm = parseFloat(targetStr);
      if (isNaN(targetMm) || targetMm <= 0) { alert('Invalid size'); return null; }
      const scale = targetMm / longestPartDim;
      const center = bbox.getCenter(new THREE.Vector3());
      const transform = new THREE.Matrix4()
        .makeRotationX(Math.PI / 2)
        .multiply(new THREE.Matrix4().makeScale(scale, scale, scale))
        .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));
      for (const child of exportGroup.children) {
        (child as THREE.Mesh).geometry.applyMatrix4(transform);
      }
    }

    return exportGroup;
  }, []);

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
      alert('Failed to export JSON');
    }
  }, [sceneGraph, model, data, mujoco, noteCards, copilotMessages, exportBaseName]);

  const downloadBlob = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const exportStl = useCallback(() => {
    const exportGroup = buildExportGroup();
    if (!exportGroup) return;
    // As the 3MF export does: an empty scene otherwise downloads an STL with
    // no triangles in it.
    let hasMesh = false;
    exportGroup.traverse((o) => { if ((o as THREE.Mesh).isMesh) hasMesh = true; });
    if (!hasMesh) { alert('Nothing to export'); return; }

    const exporter = new STLExporter();
    const result = exporter.parse(exportGroup, { binary: true }) as DataView;
    downloadBlob(new Blob([result.buffer as ArrayBuffer], { type: 'application/octet-stream' }), `${exportBaseName()}.stl`);
  }, [buildExportGroup, exportBaseName, downloadBlob]);

  /**
   * The same model, in the format that can carry what it looks like.
   *
   * Both halves of the colour go in — per-corner colour for anything that
   * renders the file, and a filament slot per triangle for a slicer that
   * prints it. See utils/threeMfExporter.
   */
  const export3mf = useCallback(() => {
    const exportGroup = buildExportGroup();
    if (!exportGroup) return;

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

    if (!meshes.length) { alert('Nothing to export'); return; }

    const result = exportThreeMf(meshes);
    downloadBlob(new Blob([result.data.buffer as ArrayBuffer], { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml' }), `${exportBaseName()}.3mf`);

    // Said out loud because it is the one thing about the file a user cannot
    // see by looking at it: how many filaments the paint was reduced to.
    const slots = result.palette.filter(p => p.triangles > 0);
    if (slots.length > 1) {
      console.info(`[Export] 3MF written with ${slots.length} filament slots:`,
        slots.map(p => `${p.extruder}: ${p.hex} (${p.triangles} triangles)`).join(', '));
    }
  }, [buildExportGroup, exportBaseName, downloadBlob]);

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
      alert(`Could not read ${fileName}: it is not valid JSON.`);
      return;
    }
    if (!parsed || !Array.isArray(parsed.nodes)) {
      alert(`${fileName} is not a scene: it has no "nodes" array.`);
      return;
    }
    if (dropped && !confirm(`Replace the current scene with ${fileName}?`)) return;
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
  }, [togglePlay, updateScene, markClean]);

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


  const allPulleyWheels = useMemo(() => {
    const list: SceneNode[] = [];
    const traverse = (nodes: SceneNode[]) => {
      if (!nodes) return;
      for (const n of nodes) {
        if (n.isPulleyWheel) list.push(n);
        traverse(n.children);
      }
    };
    traverse(sceneGraph.nodes);
    return list;
  }, [sceneGraph]);

  const allJointedNodes = useMemo(() => {
    const list: SceneNode[] = [];
    const traverse = (nodes: SceneNode[]) => {
      if (!nodes) return;
      for (const n of nodes) {
        if (n.joints && n.joints.length > 0 && !n.isPulleyWheel) {
          list.push(n);
        }
        traverse(n.children);
      }
    };
    traverse(sceneGraph.nodes);
    return list;
  }, [sceneGraph]);

  /*
   * A click on a gizmo handle is a click on a mesh with no R3F handlers, so R3F
   * reports it as a miss — and clearing the selection here would take the gizmo
   * away underneath the drag that is using it.
   */
  const handlePointerMissed = useCallback(() => {
    if (isGizmoBusy()) return;
    setSelectedNodeId(null);
  }, [setSelectedNodeId]);


  const handleDragStart = (e: React.DragEvent, type: string) => {
    e.dataTransfer.setData('type', type);
  };

  // Find selected node details
  const selectedNode = useMemo<SceneNode | null>(() => {
    if (!selectedNodeId) return null;
    let found: SceneNode | null = null;
    const traverse = (nodes: SceneNode[]) => {
      if (!nodes) return;
      for (const node of nodes) {
        if (node.id === selectedNodeId) found = node;
        traverse(node.children);
      }
    };
    traverse(sceneGraph.nodes);
    return found;
  }, [selectedNodeId, sceneGraph]);

  // Sync selected node's script and scad code into local text state
  useEffect(() => {
    const timer = setTimeout(() => {
      if (selectedNode) {
        setScriptText(selectedNode.script || '');
        setScriptError(null);
        
        let currentScad = selectedNode.scad;
        if (currentScad === undefined && (selectedNode.id.includes('openscad') || selectedNode.id.includes('scad'))) {
          currentScad = generateScadForNode(selectedNode);
          // Persist the generated scad field to the node in store
          useStore.getState().updateNode(selectedNode.id, { scad: currentScad });
        }
        
        setScadText(currentScad || '');
        setScadError(null);
      } else {
        setScriptText('');
        setScriptError(null);
        setScadText('');
        setScadError(null);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [selectedNodeId, selectedNode]);

  const handleSaveScript = useCallback(() => {
    if (!selectedNode) return;
    try {
      if (scriptText.trim() !== '') {
        // Syntax compilation check
        new Function('api', scriptText);
      }
      setScriptError(null);
      updateNodeScript(selectedNode.id, scriptText);
    } catch (e) {
      setScriptError((e as Error).message || 'Compilation Error');
    }
  }, [selectedNode, scriptText, updateNodeScript]);

  const handleCompileScad = useCallback(async () => {
    if (!selectedNode) return;
    setIsScadCompiling(true);
    setScadError(null);
    try {
      const compiled = await compileSCAD(scadText);
      useStore.getState().updateNodeScad(selectedNode.id, scadText, compiled);
    } catch (e) {
      console.error('OpenSCAD Compilation Error:', e);
      setScadError((e as Error).message || 'Compilation failed.');
    } finally {
      setIsScadCompiling(false);
    }
  }, [selectedNode, scadText]);

  const handleSimplifyMesh = useCallback((g: SceneGeom, ownerId: string) => {
    try {
      setMeshSimplifierError(null);
      const { vertices: uniqueVerts, faces, renderVertices: newRenderVerts } = simplifyGeomMesh(g, simplifyRatio);

      const newScene = cloneSceneGraph(useStore.getState().sceneGraph);
      patchGeom(newScene.nodes, ownerId, g.name, {
        vertices: uniqueVerts,
        faces,
        ...(newRenderVerts ? { renderVertices: newRenderVerts } : {}),
      });
      useStore.getState().updateScene(newScene);
      
      setMeshSimplifierGeom(null);
    } catch (err) {
      console.error('Mesh simplification failed:', err);
      setMeshSimplifierError((err as Error).message || 'Mesh simplification failed.');
    }
  }, [simplifyRatio]);

  // Utility to handle moving free bodies
  const handleMove = (axis: 0 | 1 | 2, val: number) => {
    if (!selectedNode) return;
    const cleanVal = isNaN(val) ? 0 : val;

    // Always update the scene-graph initial position (persists on reset/restart)
    const currentPos = [...selectedNode.pos] as [number, number, number];
    currentPos[axis] = cleanVal;
    updateNodePos(selectedNode.id, currentPos);

    // Also directly move the body in the live sim (via the physics worker) so
    // only THIS body moves, regardless of whether playing or paused. This
    // avoids the full forceReset recompile (from updateNodePos alone) which
    // was snapping all other bodies back to their initial positions.
    const freeJoint = selectedNode.joints?.find((j) => j.type === 'free');
    if (freeJoint) {
      getPhysicsWorkerClient().setQpos(freeJoint.name, axis, cleanVal);
    }
  };

  const handleAddComponentClick = (type: 'box' | 'sphere' | 'capsule' | 'cylinder' | 'bob' | 'gear' | 'wedge' | 'pulley_wheel' | 'pulley_rope' | 'mesh' | 'openscad' | 'pyramid' | 'cone' | 'torus' | 'tube' | 'ellipsoid' | 'curve' | 'ring' | 'sculpt') => {
    if (selectedNodeId) {
      const parentNode = findNodeById(sceneGraph.nodes, selectedNodeId);
      if (parentNode) {
        const worldPos = getNodeWorldPos(sceneGraph.nodes, selectedNodeId) || [0, 0, 0];
        const offset = (type === 'capsule' || type === 'bob') ? [0, 0, -0.6] : [0.5, 0, 0];
        addComponent(type, [worldPos[0] + offset[0], worldPos[1] + offset[1], worldPos[2] + offset[2]]);
        setIsLeftSidebarOpen(false);
        return;
      }
    }
    addComponent(type, [0, 0, 0.15]); // Spawn slightly above floor
    setIsLeftSidebarOpen(false);
  };

  /**
   * Adds a ball of clay and opens the sculpt tools on it.
   *
   * Making the object and then having to go and find the tools that act on it is
   * two steps where the intent was one — nobody adds a sculpt in order to look
   * at a sphere. The new node is picked out of the store afterwards because
   * `addComponent` mints the id itself and does not hand it back.
   */
  /**
   * Adds a box on the grid and opens the lattice tools on it.
   *
   * Same reasoning as the sculpt button: nobody adds a lattice body in order to
   * look at a cube, and leaving them to go and find the tools afterwards makes
   * two steps out of one intent.
   */
  const handleAddLatticeClick = () => {
    addComponent('lattice', [0, 0, 0.2]);
    setIsLeftSidebarOpen(false);
    const created = [...useStore.getState().sceneGraph.nodes].reverse().find((n) => n.isLattice);
    if (created) useStore.getState().setLatticeNodeId(created.id);
  };

  const handleAddSculptClick = () => {
    addComponent('sculpt', [0, 0, 0.2]);
    setIsLeftSidebarOpen(false);
    const created = [...useStore.getState().sceneGraph.nodes].reverse().find((n) => n.isSculpt);
    if (created) useStore.getState().setSculptNodeId(created.id);
  };

  /**
   * Switches a sculpt body to a different base.
   *
   * Confirmed only once there is something to lose. Asking before the first
   * stroke would be a dialog in front of the one action every new sculpt starts
   * with — trying the shapes to see which one fits.
   */
  const handleSculptBaseClick = (node: SceneNode, base: SculptBaseId, label: string) => {
    if ((node.sculptBase || 'sphere') === base) return;
    if (node.sculptEdited && !window.confirm(`Start over from the ${label} base? The sculpting on this body will be discarded.`)) return;
    setSculptBase(node.id, base);
  };

  const renderHierarchyNode = useCallback((rootNode: SceneNode, rootDepth: number = 0): React.ReactNode => {
    const render = (node: SceneNode, depth: number): React.ReactNode => {
    const isSelected = selectedNodeId === node.id;
    
    // Choose pretty visual emoji
    let emoji = '📦';
    if (node.id.includes('coin')) emoji = '🪙';
    else if (node.id.includes('gear')) emoji = '⚙️';
    else if (node.id.includes('pole') || node.id.includes('capsule')) emoji = '🥢';
    else if (node.id.includes('bob')) emoji = '🔵';
    else if (node.id.includes('cylinder')) emoji = '🛢️';
    else if (node.id.includes('sphere')) emoji = '🟢';
    else if (node.id.includes('wedge')) emoji = '📐';
    else if (node.id.includes('pyramid')) emoji = '🔺';
    else if (node.id.includes('cone')) emoji = '🍦';
    else if (node.id.includes('torus')) emoji = '🍩';
    else if (node.id.includes('tube')) emoji = '🛢️';
    else if (node.id.includes('ellipsoid')) emoji = '🥚';
    else if (node.id.includes('pulley_wheel')) emoji = '🛞';
    else if (node.isPulleyRope) emoji = '🧵';
    else if (node.isCurve || node.id.includes('curve')) emoji = '🎢';
    else if (node.csgEnabled || node.id.includes('ring')) emoji = '💠';

    return (
      <div key={node.id} className="flex flex-col">
        <div 
          onClick={() => {
            setSelectedNodeId(node.id);
            setActiveGeomIndex(0);
            setIsLeftSidebarOpen(false);
          }} 
          style={{ paddingLeft: `${depth === 0 ? 8 : 4}px` }}
          className={`flex items-center px-2 py-1.5 rounded-md border cursor-pointer transition-colors shadow-sm mb-1 ${
            isSelected && activeGeomIndex === 0 
              ? 'bg-blue-50 border-blue-200 text-blue-600 dark:bg-blue-950/40 dark:border-blue-800 dark:text-blue-400 font-semibold' 
              : isSelected 
                ? 'bg-blue-50/40 border-blue-100/50 text-blue-500 dark:bg-blue-950/20 dark:border-blue-900/50 dark:text-blue-400 font-semibold' 
                : 'bg-white dark:bg-slate-900/90 border-transparent dark:border-slate-800/40 hover:bg-slate-100/70 dark:hover:bg-slate-800/70 text-slate-600 dark:text-slate-300'
          }`}
        >
          <span className="text-xs flex items-center gap-1.5 font-medium truncate">
            <span>{emoji}</span> <span className="truncate">{node.name}</span>
          </span>
        </div>
        
        {/* Render sub-geoms nested under body if there are multiple geoms.
            Curves are one logical shape built from dozens of segment boxes —
            listing each segment would swamp the tree, so skip them. */}
        {node.geoms && node.geoms.length > 1 && !node.isCurve && (
          <div className="pl-3 ml-2.5 border-l border-slate-200 dark:border-slate-800/60 flex flex-col gap-0.5 mb-1">
            {node.geoms.map((g, idx) => {
              const isGeomSelected = isSelected && activeGeomIndex === idx;
              // Generated boolean output is derived data, not something to select
              // and edit — the primitives above it are the real controls.
              if (g.csgDerived) return null;
              let subEmoji = '🔹';
              if (g.type === 'cylinder') subEmoji = '🛢️';
              else if (g.type === 'box') subEmoji = '📦';
              else if (g.type === 'sphere') subEmoji = '🟢';
              else if (g.type === 'ellipsoid') subEmoji = '🥚';
              else if (g.type === 'mesh') {
                if (node.isPyramid) subEmoji = '🔺';
                else if (node.isCone) subEmoji = '🍦';
                else if (node.isTorus) subEmoji = '🍩';
                else if (node.isTube) subEmoji = '🛢️';
                else subEmoji = '📐';
              }
              // A boolean operator matters more than the shape it's applied to.
              if (g.csg === 'difference') subEmoji = '➖';
              else if (g.csg === 'intersection') subEmoji = '∩';

              return (
                <div 
                  key={`${node.id}-geom-${idx}`}
                  onClick={() => {
                    setSelectedNodeId(node.id);
                    setActiveGeomIndex(idx);
                    setIsLeftSidebarOpen(false);
                  }}
                  className={`flex items-center px-2 py-1 rounded-md border cursor-pointer transition-colors shadow-sm text-xs ${
                    isGeomSelected 
                      ? 'bg-indigo-50 border-indigo-200 text-indigo-600 dark:bg-indigo-950/40 dark:border-indigo-800 dark:text-indigo-400 font-semibold' 
                      : 'bg-white/80 dark:bg-slate-900/50 border-transparent dark:border-slate-800/80 hover:bg-slate-50 dark:hover:bg-slate-800/50 text-slate-500 dark:text-slate-400'
                  }`}
                >
                  <span className="flex items-center gap-1.5 text-[11px] font-medium truncate">
                    <span>{subEmoji}</span>
                    <span className={`truncate ${g.csg === 'difference' ? 'line-through decoration-rose-400/70' : ''}`}>{g.name || `Geom ${idx + 1}`}</span>
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {node.children && node.children.length > 0 && (
          <div className="pl-3 ml-2.5 border-l border-slate-200 dark:border-slate-800/60 flex flex-col gap-0.5">
            {node.children.map((child) => render(child, depth + 1))}
          </div>
        )}
      </div>
    );
    };
    return render(rootNode, rootDepth);
  }, [selectedNodeId, setSelectedNodeId, setIsLeftSidebarOpen, activeGeomIndex, setActiveGeomIndex]);

  useMCPBridge();
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
                if (hasUnsavedWork() && !confirm('Replace the current scene? Its unsaved changes, note cards and copilot chat will be lost.')) return;
                if (v.startsWith('user:')) loadUserPresetWithCard(v);
                else loadPresetWithCard(v);
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
                try {
                  keys = listUserPresetNames();
                } catch {
                  return null;
                }
                if (keys.length === 0) return null;
                return (
                  <optgroup label="📁 Saved Presets" className="bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300">
                    {keys.sort().map(k => (
                      <option key={`user:${k}`} value={`user:${k}`}>💾 {k}</option>
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
                    if (window.confirm(`Are you sure you want to delete the preset "${presetName}"?`)) {
                      // The preset goes; the scene on screen stays. Loading the
                      // empty scene here wiped the work, notes and chat as well,
                      // which the question above never mentioned.
                      if (deleteUserPreset(presetName)) {
                        useStore.getState().setActivePreset(undefined);
                      } else {
                        alert(`Could not delete "${presetName}": this browser would not write the preset list.`);
                      }
                    }
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
          <div className="flex items-center max-lg:shrink-0 bg-slate-100 dark:bg-slate-800/80 p-0.5 rounded-lg border border-slate-200/80 dark:border-slate-700/60 shadow-inner">
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
              onClick={() => openDocs(docsTab)}
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

        {/* Mobile Sidebar Backdrop Scrim. Covers the workspace, not the whole
            page: the header above it stays live, so the hamburger that opened
            the drawer is still the thing that closes it. */}
        {isLeftSidebarOpen && (
          <div
            onClick={() => setIsLeftSidebarOpen(false)}
            className="absolute inset-0 bg-slate-900/20 backdrop-blur-xs z-[115] md:hidden"
          />
        )}

        {/* Left Sidebar.
            `absolute inset-y-0` against the workspace, not `fixed inset-y-14`:
            below `lg` the header wraps onto as many rows as its contents need,
            so its height is not knowable here and anything pinned 3.5rem from
            the top of the page tucks under a two-row navbar. */}
        <aside className={`w-64 md:w-56 max-w-[85vw] shrink-0 glass-panel border-r border-slate-200 dark:border-slate-800 flex flex-col p-4 bg-white/90 dark:bg-slate-900/90 overflow-y-auto transition-transform duration-200 ease-in-out absolute md:relative inset-y-0 md:inset-auto left-0 z-20 max-md:z-[120] shadow-xl md:shadow-none ${
          isLeftSidebarOpen ? 'flex translate-x-0' : 'hidden md:flex -translate-x-full md:translate-x-0'
        }`}>
          <div className="flex items-center justify-between mb-2.5">
            <h2 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Hierarchy</h2>
            {/* As an overlay the drawer covers the model, so it carries its own
                way out rather than relying on the hamburger it came from. */}
            <button
              onClick={() => setIsLeftSidebarOpen(false)}
              className="md:hidden p-1 -m-1 rounded text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              title="Close the hierarchy panel"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex flex-col gap-1.5 mb-6">
            <div 
              className={`px-3 py-1.5 rounded-md border cursor-pointer transition-colors shadow-sm flex items-center gap-1.5 ${
                !selectedNodeId 
                  ? 'bg-blue-50 border-blue-200 text-blue-600 dark:bg-blue-950/40 dark:border-blue-800 dark:text-blue-400 font-bold' 
                  : 'bg-white dark:bg-slate-900 border-transparent dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300'
              }`}
              onClick={() => {
                setSelectedNodeId(null);
                setIsLeftSidebarOpen(false);
              }}
            >
              <span>🌍</span> <span className="text-xs font-semibold">Worldbody</span>
            </div>
            <div className="flex flex-col mt-1">
              {sceneGraph.nodes.map(node => renderHierarchyNode(node, 0))}
              {/* A blank scene said nothing at all about where to start. */}
              {sceneGraph.nodes.length === 0 && (
                <p className="px-3 py-2 text-[11px] leading-relaxed text-slate-400 dark:text-slate-500">
                  Nothing here yet. Drag a part in from Components below, pick a preset at the top, or ask the Copilot to build one.
                </p>
              )}
            </div>
          </div>

          <h2 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">Components</h2>

          {/* The palette is drag-and-drop with a mouse, which a finger cannot
              do onto a canvas it cannot see behind the drawer. Tapping already
              adds the part at the origin — it just needed saying. */}
          {coarsePointer && (
            <p className="text-[10px] text-slate-400 dark:text-slate-500 leading-tight mb-1.5">
              Tap a part to drop it into the scene.
            </p>
          )}

          <div className="text-[10px] font-medium text-slate-500 dark:text-slate-400 mb-2.5 bg-slate-50 dark:bg-slate-950/40 px-2 py-1.5 rounded-lg border border-slate-200/50 dark:border-slate-800/50">
            Adding to: <span className="text-blue-600 dark:text-blue-400 font-semibold truncate block">{selectedNode && parentUnderSelected ? selectedNode.name : '🌍 Worldbody'}</span>
          </div>

          {selectedNode && (
            <label className="text-[10px] font-semibold text-slate-600 dark:text-slate-400 flex items-center gap-2 mb-3 bg-slate-50 dark:bg-slate-950/40 border border-slate-200/60 dark:border-slate-800/60 p-2 rounded-lg cursor-pointer select-none hover:bg-slate-100/50 dark:hover:bg-slate-800/50 transition-colors shadow-sm">
              <input 
                type="checkbox" 
                checked={parentUnderSelected} 
                onChange={(e) => setParentUnderSelected(e.target.checked)} 
                className="w-3.5 h-3.5 rounded text-blue-600 border-slate-300 dark:border-slate-700 focus:ring-blue-400 dark:focus:ring-blue-900 accent-blue-500 cursor-pointer"
              />
              <span>Nest under selected</span>
            </label>
          )}

          <div className="grid grid-cols-2 gap-2">
            {/* Cube (Box) */}
            <div 
              draggable 
              onDragStart={(e) => handleDragStart(e, 'box')} 
              onClick={() => handleAddComponentClick('box')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Cube (Box geom)"
            >
              <div className="p-1.5 bg-rose-50 dark:bg-rose-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <Box className="w-4 h-4 text-rose-500 dark:text-rose-400" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Cube</span>
            </div>

            {/* Sphere */}
            <div 
              draggable 
              onDragStart={(e) => handleDragStart(e, 'sphere')} 
              onClick={() => handleAddComponentClick('sphere')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Sphere (Ball geom)"
            >
              <div className="p-1.5 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <Circle className="w-4 h-4 text-emerald-500 dark:text-emerald-400" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Sphere</span>
            </div>

            {/* Cylinder */}
            <div 
              draggable 
              onDragStart={(e) => handleDragStart(e, 'cylinder')} 
              onClick={() => handleAddComponentClick('cylinder')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Cylinder block"
            >
              <div className="p-1.5 bg-amber-50 dark:bg-amber-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <Layers className="w-4 h-4 text-amber-600 dark:text-amber-400" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Cylinder</span>
            </div>

            {/* Pole (Capsule) */}
            <div 
              draggable 
              onDragStart={(e) => handleDragStart(e, 'capsule')} 
              onClick={() => handleAddComponentClick('capsule')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Capsule rod (Pole)"
            >
              <div className="p-1.5 bg-indigo-50 dark:bg-indigo-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <Zap className="w-4 h-4 text-indigo-500 dark:text-indigo-400" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Pole</span>
            </div>

            {/* Gear */}
            <div 
              draggable 
              onDragStart={(e) => handleDragStart(e, 'gear')} 
              onClick={() => handleAddComponentClick('gear')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Gear cog"
            >
              <div className="p-1.5 bg-slate-100 dark:bg-slate-800 rounded-lg mb-1 group-hover:rotate-45 transition-transform duration-300">
                <Settings className="w-4 h-4 text-slate-500 dark:text-slate-400" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Gear</span>
            </div>

            {/* Wedge */}
            <div 
              draggable 
              onDragStart={(e) => handleDragStart(e, 'wedge')} 
              onClick={() => handleAddComponentClick('wedge')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Wedge (Inclined plane)"
            >
              <div className="p-1.5 bg-amber-50 dark:bg-amber-950/20 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <Triangle className="w-4 h-4 text-amber-600 dark:text-amber-500 rotate-90" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Wedge</span>
            </div>

            {/* Pyramid */}
            <div 
              draggable 
              onDragStart={(e) => handleDragStart(e, 'pyramid')} 
              onClick={() => handleAddComponentClick('pyramid')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Pyramid (Convex mesh)"
            >
              <div className="p-1.5 bg-rose-50 dark:bg-rose-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <Pyramid className="w-4 h-4 text-rose-600 dark:text-rose-400" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Pyramid</span>
            </div>

            {/* Cone */}
            <div 
              draggable 
              onDragStart={(e) => handleDragStart(e, 'cone')} 
              onClick={() => handleAddComponentClick('cone')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Cone (Convex mesh)"
            >
              <div className="p-1.5 bg-sky-50 dark:bg-sky-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <Cone className="w-4 h-4 text-sky-600 dark:text-sky-400" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Cone</span>
            </div>

            {/* Torus */}
            <div 
              draggable 
              onDragStart={(e) => handleDragStart(e, 'torus')} 
              onClick={() => handleAddComponentClick('torus')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Torus (Ring mesh)"
            >
              <div className="p-1.5 bg-violet-50 dark:bg-violet-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <Donut className="w-4 h-4 text-violet-600 dark:text-violet-400" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Torus</span>
            </div>

            {/* Tube */}
            <div 
              draggable 
              onDragStart={(e) => handleDragStart(e, 'tube')} 
              onClick={() => handleAddComponentClick('tube')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Tube (Hollow cylinder)"
            >
              <div className="p-1.5 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <CircleDot className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Tube</span>
            </div>

            {/* Ellipsoid */}
            <div 
              draggable 
              onDragStart={(e) => handleDragStart(e, 'ellipsoid')} 
              onClick={() => handleAddComponentClick('ellipsoid')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Ellipsoid primitive"
            >
              <div className="p-1.5 bg-amber-50 dark:bg-amber-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <Circle className="w-4 h-4 text-amber-600 dark:text-amber-400 scale-x-125 scale-y-75" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Ellipsoid</span>
            </div>

            {/* Ring — a boolean body: ellipsoid minus a piercing ellipsoid */}
            <div
              draggable
              onDragStart={(e) => handleDragStart(e, 'ring')}
              onClick={() => handleAddComponentClick('ring')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Ring (an ellipsoid with a second ellipsoid subtracted; a boolean body you can reshape)"
            >
              <div className="p-1.5 bg-rose-50 dark:bg-rose-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <Donut className="w-4 h-4 text-rose-600 dark:text-rose-400" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Ring</span>
            </div>

            {/* Sculpt (free-form clay — the one shape not made from parameters) */}
            <div
              draggable
              onDragStart={(e) => handleDragStart(e, 'sculpt')}
              onClick={() => handleAddSculptClick()}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Sculpt (a ball of clay you push into shape by hand; detail is added as you brush)"
            >
              <div className="p-1.5 bg-sky-50 dark:bg-sky-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <Paintbrush className="w-4 h-4 text-sky-600 dark:text-sky-400" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Sculpt</span>
            </div>

            {/* Lattice (points on a grid, connected — the precise counterpart
                to sculpting's free hand) */}
            <div
              draggable
              onDragStart={(e) => handleDragStart(e, 'lattice')}
              onClick={() => handleAddLatticeClick()}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Lattice (connect points on a 3D grid into faces, with exact dimensions and optional smoothing)"
            >
              <div className="p-1.5 bg-indigo-50 dark:bg-indigo-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <Grid3x3 className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Lattice</span>
            </div>

            {/* Curve (rigid curved track) */}
            <div
              draggable
              onDragStart={(e) => handleDragStart(e, 'curve')}
              onClick={() => handleAddComponentClick('curve')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Curve (rigid spline track that balls roll along)"
            >
              <div className="p-1.5 bg-orange-50 dark:bg-orange-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <ChartSpline className="w-4 h-4 text-orange-600 dark:text-orange-400" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Curve</span>
            </div>

            {/* Pulley Wheel */}
            <div 
              draggable 
              onDragStart={(e) => handleDragStart(e, 'pulley_wheel')} 
              onClick={() => handleAddComponentClick('pulley_wheel')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Pulley Stand system disk"
            >
              <div className="p-1.5 bg-cyan-50 dark:bg-cyan-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <Disc className="w-4 h-4 text-cyan-600 dark:text-cyan-400" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Pulley</span>
            </div>

            {/* Rope */}
            <div 
              draggable 
              onDragStart={(e) => handleDragStart(e, 'pulley_rope')} 
              onClick={() => handleAddComponentClick('pulley_rope')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Coupler Rope"
            >
              <div className="p-1.5 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <CircleDot className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Rope</span>
            </div>
          </div>

          {/* 3D-Printed Mechanical Hardware Primitives */}
          <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800">
            <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <span>🔩 3D Hardware Primitives</span>
            </h3>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => {
                  const node = createHeatSetBossNode('M3');
                  addHardwareComponentNode(node);
                  setIsLeftSidebarOpen(false);
                }}
                className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-emerald-400 dark:hover:border-emerald-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
                title="M3 Heat-Set Insert Boss"
              >
                <div className="p-1.5 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                  <span className="text-xs font-mono text-emerald-600 dark:text-emerald-400 font-bold">M3</span>
                </div>
                <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">M3 Insert Boss</span>
              </button>

              <button
                onClick={() => {
                  const node = createHexNutTrapNode('M3');
                  addHardwareComponentNode(node);
                  setIsLeftSidebarOpen(false);
                }}
                className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
                title="M3 Hex Nut Trap Slot"
              >
                <div className="p-1.5 bg-blue-50 dark:bg-blue-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                  <span className="text-xs font-mono text-blue-600 dark:text-blue-400 font-bold">Nut</span>
                </div>
                <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">M3 Nut Trap</span>
              </button>

              <button
                onClick={() => {
                  const node = createCounterboreHoleNode('M3');
                  addHardwareComponentNode(node);
                  setIsLeftSidebarOpen(false);
                }}
                className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-cyan-400 dark:hover:border-cyan-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
                title="M3 Counterbored Screw Hole (Cap Screw Recess + Shank Clearance)"
              >
                <div className="p-1.5 bg-cyan-50 dark:bg-cyan-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                  <span className="text-xs font-mono text-cyan-600 dark:text-cyan-400 font-bold">M3</span>
                </div>
                <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">M3 Cap Recess</span>
              </button>

              <button
                onClick={() => {
                  const node = createBearingPocketNode('608');
                  addHardwareComponentNode(node);
                  setIsLeftSidebarOpen(false);
                }}
                className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-amber-400 dark:hover:border-amber-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
                title="608 Skate Bearing Pocket"
              >
                <div className="p-1.5 bg-amber-50 dark:bg-amber-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                  <Disc className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                </div>
                <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">608 Bearing</span>
              </button>

              <button
                onClick={() => {
                  const node = createDShaftHubNode(5.0);
                  addHardwareComponentNode(node);
                  setIsLeftSidebarOpen(false);
                }}
                className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-purple-400 dark:hover:border-purple-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
                title="5mm D-Shaft Motor Hub (NEMA17)"
              >
                <div className="p-1.5 bg-purple-50 dark:bg-purple-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                  <span className="text-xs font-mono text-purple-600 dark:text-purple-400 font-bold">D5</span>
                </div>
                <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">D-Shaft Hub</span>
              </button>
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800">
            <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <span>🔧 Others</span>
            </h3>
            <div className="grid grid-cols-2 gap-2">
            {/* Mesh */}
            <div 
              draggable 
              onDragStart={(e) => handleDragStart(e, 'mesh')} 
              onClick={() => handleAddComponentClick('mesh')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Custom static Mesh"
            >
              <div className="p-1.5 bg-violet-50 dark:bg-violet-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <Shapes className="w-4 h-4 text-violet-500 dark:text-violet-400" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Mesh</span>
            </div>

            {/* OpenSCAD */}
            <div 
              draggable 
              onDragStart={(e) => handleDragStart(e, 'openscad')} 
              onClick={() => handleAddComponentClick('openscad')}
              className="p-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 shadow-xs flex flex-col items-center justify-center text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group"
              title="Procedural OpenSCAD shape"
            >
              <div className="p-1.5 bg-blue-50 dark:bg-blue-950/30 rounded-lg mb-1 group-hover:scale-105 transition-transform">
                <Code className="w-4 h-4 text-blue-500 dark:text-blue-400" />
              </div>
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">SCAD</span>
            </div>

            {/* Note Card - spans 2 cols */}
            <div
              onClick={() => {
                const id = `card_${Date.now()}`;
                setNoteCards(prev => [...prev, { id, markdown: '# Note\n\nWrite your notes here.', minimized: false, x: 80, y: 80 }]);
                setEditingCardId(id);
                setIsLeftSidebarOpen(false);
              }}
              className="col-span-2 p-2 border border-dashed border-violet-300 dark:border-violet-800 rounded-lg bg-violet-50/20 dark:bg-violet-950/10 flex items-center justify-center gap-2 cursor-pointer hover:border-violet-400 dark:hover:border-violet-700 hover:bg-violet-50/40 dark:hover:bg-violet-950/30 transition-all group select-none mt-1"
            >
              <FileText className="w-3.5 h-3.5 text-violet-600 dark:text-violet-400 group-hover:scale-105 transition-transform" />
              <span className="text-[10px] font-bold text-slate-700 dark:text-slate-300">Add Note Card</span>
            </div>
          </div>
        </div>

        {/* Colour, which is looks only — see ColoringSection. */}
        <ColoringSection onArmed={() => setIsLeftSidebarOpen(false)} />
      </aside>

        {/* Viewport */}
        <main className="flex-1 relative min-w-0">
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
            <DropHandler addComponent={addComponent} onImportFile={handleDroppedImportFile} onImportImageFile={handleDroppedImageFile} onImportSceneJson={importSceneJson} />
            <color attach="background" args={[darkMode ? '#0b0f19' : '#f8fafc']} />
            {/* background={false}: this only feeds reflections/specular highlights
                on the PBR materials, it never replaces the flat <color> above.
                Kept low so it reads as "materials aren't dead flat any more"
                rather than "everything is suddenly glossy". */}
            <Environment preset="apartment" background={false} environmentIntensity={0.12} />
            <ambientLight intensity={darkMode ? 0.35 : 0.6} />
            {/* Fill light opposite the key light, well below its intensity — just
                enough to lift the shadow side off pure black without flattening
                the modeling the key light + AO are doing. Stacking this with a
                hemisphere light on top of ambient + environment washed everything
                toward white, so this is the only extra light left. */}
            <directionalLight position={[-2, 1.2, -1.5]} intensity={darkMode ? 0.12 : 0.15} />
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
            <directionalLight
              position={[1.5, 3, 1.5]}
              intensity={darkMode ? 1.4 : 1.2}
              castShadow
              shadow-mapSize={[2048, 2048]}
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
              multisampling={0}
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
            </EffectComposer>
          </Canvas>

          {/* Floating Viewport Camera Controls */}
          <div className="absolute bottom-4 right-4 z-10 flex items-center gap-1 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border border-slate-200 dark:border-slate-800 p-1 rounded-lg shadow-sm">
            <button
              onClick={() => setCameraView('perspective')}
              className={`px-2.5 py-1 rounded text-[10px] font-bold tracking-wide transition-all cursor-pointer ${
                cameraView === 'perspective'
                  ? 'bg-blue-500 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              Perspective
            </button>
            <button
              onClick={() => setCameraView('topDown')}
              className={`px-2.5 py-1 rounded text-[10px] font-bold tracking-wide transition-all cursor-pointer ${
                cameraView === 'topDown'
                  ? 'bg-blue-500 text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              Top Down
            </button>
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

        {/* Dimmer behind the inspector drawer. Only exists below `lg`, where
            the inspector is an overlay; tapping the model puts it away. */}
        {isPropertiesOpen && selectedNode && !isPlaying && (
          <div
            className="lg:hidden absolute inset-0 z-[105] bg-slate-950/30"
            onClick={() => setIsPropertiesOpen(false)}
          />
        )}

        {/* Contextual Properties Sidebar. Nothing is editable while the
            simulation runs, so it stays away rather than sliding in whenever a
            body is clicked; the selection survives, and the panel comes back
            with it when the run stops. */}
        {selectedNode && !isPlaying && (
          /*
            Below `lg` there is not room for a permanent 380px column beside a
            3D viewport, so the inspector slides in over it instead.

            Written as `max-lg:` overrides on top of the original classes, so
            that at desktop width this element carries exactly what it always
            did — in particular no stray transform, which would otherwise make
            the aside a containing block and re-anchor the absolutely
            positioned popovers inside it. The drag-to-resize width is an
            inline style, so the mobile width has to out-rank it explicitly.
          */
          <aside
            style={{ width: `${propertiesWidth}px` }}
            className={`shrink-0 glass-panel border-l border-slate-200 dark:border-slate-800 flex flex-col p-4 z-20 bg-white/55 dark:bg-slate-900/55 overflow-y-auto relative max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-[110] max-lg:w-80! max-lg:max-w-[80vw] max-lg:shadow-xl max-lg:bg-white/95 max-lg:dark:bg-slate-900/95 max-lg:transition-transform max-lg:duration-200 ${
              // Below `lg` the drawer waits off the right-hand edge until it is
              // asked for. `pointer-events-none` as well as the translate, so a
              // panel parked off screen cannot swallow taps meant for the model.
              isPropertiesOpen ? 'max-lg:translate-x-0' : 'max-lg:translate-x-full max-lg:pointer-events-none'
            }`}
          >
            {/* Elegant Resize Handle */}
            <div
              onMouseDown={handleMouseDown}
              className="absolute top-0 left-0 bottom-0 w-1.5 cursor-col-resize hover:bg-blue-500/20 active:bg-blue-500/40 transition-colors z-20 group hidden lg:flex items-center justify-center"
              title="Drag to resize panel"
            >
              <div className="w-[2px] h-8 bg-slate-300 dark:bg-slate-700 group-hover:bg-blue-500 group-active:bg-blue-600 rounded transition-colors" />
            </div>

            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-4 flex items-center justify-between">
              <span className="flex items-center gap-2"><SlidersHorizontal className="w-4 h-4" /> Properties</span>
              {/* Closes the drawer and leaves the component selected: the top
                  bar's bin, undo and the keyboard all act on the selection, so
                  putting the panel away must not throw that away too. The
                  desktop column has nowhere to go, so there its X deselects,
                  exactly as it always did. */}
              <button
                onClick={() => setIsPropertiesOpen(false)}
                className="lg:hidden cursor-pointer"
                title="Close Properties"
              >
                <X className="w-4 h-4 text-slate-400 hover:text-slate-600" />
              </button>
              <button onClick={() => setSelectedNodeId(null)} className="hidden lg:block cursor-pointer" title="Deselect"><X className="w-4 h-4 text-slate-400 hover:text-slate-600" /></button>
            </h2>
            
            <div className="flex flex-col gap-4">
                {/* Combining. A boolean is a program over ONE body's shapes, so
                    two bodies dragged in from the sidebar can never cut each
                    other however they overlap — the shapes have to be on one
                    body first. Shift-click a second body and this appears. */}
                {extraSelectedIds.length > 0 && (
                  <div className="p-3 bg-white dark:bg-slate-900 rounded-lg border border-indigo-200 dark:border-indigo-900 shadow-sm flex flex-col gap-2">
                    <h3 className="text-sm font-medium text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                      <Donut className="w-3.5 h-3.5 text-indigo-500" />
                      Combine {extraSelectedIds.length + 1} bodies
                    </h3>
                    <p className="text-[10px] text-slate-400 leading-snug">
                      The other {extraSelectedIds.length === 1 ? 'body is' : 'bodies are'} merged into
                      <strong> {selectedNode.name || selectedNode.id}</strong>, keeping
                      {extraSelectedIds.length === 1 ? ' its' : ' their'} place in the world. One body
                      comes out.
                    </p>
                    {/* Said out loud, because a merged body takes its subtree
                        with it and losing a child body you spent time on is not
                        something to find out afterwards. */}
                    {(() => {
                      const withKids = extraSelectedIds.filter((id) => {
                        const n = findNodeById(sceneGraph.nodes, id);
                        return (n?.children?.length ?? 0) > 0;
                      });
                      if (withKids.length === 0) return null;
                      return (
                        <p className="text-[10px] leading-snug text-amber-600 dark:text-amber-400">
                          <strong>Anything parented to {withKids.length === 1 ? 'it' : 'them'} goes too.</strong>{' '}
                          {withKids.join(', ')} {withKids.length === 1 ? 'has' : 'have'} child bodies, and
                          merging removes the body they hang from. Undo puts it all back.
                        </p>
                      );
                    })()}
                    <div className="flex gap-1">
                      {([
                        ['union', '＋ Add', 'One body made of both shapes.'],
                        ['difference', '－ Subtract', 'The other shapes are cut out of this one.'],
                        ['intersection', '∩ Intersect', 'Only the overlap is kept.'],
                      ] as const).map(([op, label, hint]) => (
                        <button
                          key={op}
                          type="button"
                          onClick={() => combineBodies(selectedNode.id, extraSelectedIds, op)}
                          title={hint}
                          className="flex-1 py-1.5 rounded-md text-[10px] font-semibold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-indigo-100 dark:hover:bg-indigo-950/50 hover:text-indigo-700 dark:hover:text-indigo-300 cursor-pointer transition-colors"
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Lattice: only for bodies that ARE one. Unlike sculpting,
                    this cannot be opened on an arbitrary mesh — the cage is the
                    document and an imported STL does not have one. */}
                {selectedNode.isLattice && (
                  <button
                    type="button"
                    onClick={() => setLatticeNodeId(selectedNode.id)}
                    disabled={latticeNodeId === selectedNode.id}
                    className="flex items-center justify-center gap-2 w-full py-2 rounded-lg text-xs font-bold transition-all bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-200 disabled:text-slate-400 text-white cursor-pointer disabled:cursor-default"
                    title="Open the lattice tools on this cage. Pauses the simulation."
                  >
                    <Grid3x3 className="w-3.5 h-3.5" />
                    {latticeNodeId === selectedNode.id ? 'Modelling…' : 'Edit Lattice'}
                  </button>
                )}

                {/* Why the Edit Lattice button is gone. Without this the body
                    simply stops offering the tools it offered a minute ago. */}
                {selectedNode.latticeBaked && !selectedNode.isLattice && (
                  <p className="text-[10px] leading-snug text-slate-400 px-1">
                    <strong className="text-slate-500">Lattice applied.</strong> The mesh is now edited
                    directly; the cage is kept in the file but does not drive the shape.
                    <span className="whitespace-nowrap"> Ctrl+Z</span> puts it back.
                  </p>
                )}

                {/* Sculpt: offered for any body carrying a mesh, not only for one
                    that started as clay — an imported STL or a boolean result is
                    a perfectly good thing to push around by hand.

                    On a LATTICE body it first applies the cage. The two tools
                    cannot share a mesh: the cage rebuilds it from scratch on
                    every edit, so sculpting under a live cage is work that
                    disappears the next time a face moves — silently, and long
                    after the decision that cost it. Baking says so up front,
                    and it is an ordinary undo step. */}
                {/* Not on a boolean body: what it shows is a mesh rebuilt from
                    its primitives on every change, so a stroke on it could
                    only ever be thrown away by the next compile. */}
                {!selectedNode.csgEnabled && selectedNode.geoms?.some((g) => g.type === 'mesh' && !g.csgDerived && g.renderVertices?.length) && (
                  <button
                    type="button"
                    onClick={() => {
                      if (selectedNode.isLattice) {
                        if (!window.confirm(
                          'Sculpting applies the lattice: this mesh stops being built from its cage, '
                          + 'and the lattice tools close on it for good. The cage stays in the file, '
                          + 'and Ctrl+Z puts it back. Carry on?')) return;
                        useStore.getState().bakeLattice(selectedNode.id);
                      }
                      setSculptNodeId(selectedNode.id);
                    }}
                    disabled={sculptNodeId === selectedNode.id}
                    className="flex items-center justify-center gap-2 w-full py-2 rounded-lg text-xs font-bold transition-all bg-sky-600 hover:bg-sky-500 disabled:bg-slate-200 disabled:text-slate-400 text-white cursor-pointer disabled:cursor-default"
                    title={selectedNode.isLattice
                      ? 'Applies the lattice first: the cage stops driving this mesh, and sculpting takes over. Undoable.'
                      : 'Open the sculpting tools on this mesh. Pauses the simulation.'}
                  >
                    <Paintbrush className="w-3.5 h-3.5" />
                    {sculptNodeId === selectedNode.id
                      ? 'Sculpting…'
                      : selectedNode.isLattice ? 'Apply Lattice & Sculpt' : 'Sculpt This Mesh'}
                  </button>
                )}

                {/* Base shape. Only for bodies that started as clay: replacing
                    the mesh of an imported STL with a humanoid would be a
                    delete wearing a dropdown's clothes. */}
                {selectedNode.isSculpt && (
                  <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
                    <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 flex items-center gap-1.5">
                      <Shapes className="w-3.5 h-3.5 text-sky-500" /> Base Shape
                    </h3>
                    <div className="grid grid-cols-3 gap-1.5">
                      {SCULPT_BASES.map((base) => (
                        <button
                          key={base.id}
                          type="button"
                          onClick={() => handleSculptBaseClick(selectedNode, base.id, base.label)}
                          title={base.description}
                          className={`py-1.5 px-1 rounded-lg border text-[10px] font-semibold transition-all cursor-pointer truncate ${
                            (selectedNode.sculptBase || 'sphere') === base.id
                              ? 'bg-sky-50 border-sky-400 text-sky-700'
                              : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300'
                          }`}
                        >
                          {base.label}
                        </button>
                      ))}
                    </div>
                    <p className="text-[10px] leading-snug text-slate-500">
                      {(SCULPT_BASES.find((b) => b.id === (selectedNode.sculptBase || 'sphere')) ?? SCULPT_BASES[0]).description}
                    </p>
                    {selectedNode.sculptEdited && (
                      <p className="text-[10px] leading-snug text-amber-600">
                        This body has been sculpted. Changing the base starts it over.
                      </p>
                    )}
                  </div>
                )}

                <div className="flex items-center justify-between p-3 bg-slate-50 border border-slate-200/60 rounded-lg">
                  <div>
                    <div className="text-xs font-semibold text-slate-700">Aerodynamics</div>
                    <div className="text-[10px] text-slate-500">Apply lift and drag automatically</div>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input 
                      type="checkbox" 
                      className="sr-only peer"
                      checked={selectedNode.isAerodynamic || false}
                      onChange={(e) => updateNode(selectedNode.id, { isAerodynamic: e.target.checked })}
                    />
                    <div className="w-8 h-4 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-blue-500"></div>
                  </label>
                </div>

                <div className="flex flex-col gap-1.5 p-3 bg-slate-50 border border-slate-200/60 rounded-lg">
                <div className="flex justify-between items-center">
                  <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Component Name</label>
                  <span className="font-mono text-[9px] text-blue-600 font-semibold bg-blue-50 px-1 py-0.5 rounded cursor-pointer select-all border border-blue-100" title="Body API Reference Name. Click to select/copy.">
                    api.getPosition('{selectedNode.name || selectedNode.id}')
                  </span>
                </div>
                <SettledTextInput
                  value={selectedNode.name || ''}
                  onChange={(name) => renameNode(selectedNode.id, name)}
                  className="w-full px-2.5 py-1.5 border border-slate-200 rounded text-sm bg-white font-medium text-slate-800 outline-none focus:border-blue-500 shadow-sm"
                  placeholder="Rename component..."
                />
                <span className="text-[9px] font-mono text-slate-400 mt-0.5">ID: {selectedNode.id}</span>
              </div>

              {/* Position Coordinates (Applicable to all nodes!) */}
              <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-3">
                <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 flex items-center gap-1.5">
                  <span>Position Offset</span>
                  <DocsInfoButton tab="offset" />
                </h3>
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <label className="text-xs text-slate-500 font-medium">X Position</label>
                      <SliderValue
                        value={selectedNode.pos[0]}
                        onChange={(v) => handleMove(0, v)}
                        decimals={3}
                        unit="m"
                        className="text-xs text-slate-500"
                      />
                    </div>
                    <RangeInput 
                      {...offsetSpan(selectedNode.pos[0])}
                      className="w-full accent-blue-500 cursor-pointer" 
                      value={selectedNode.pos[0]} 
                      onChange={(v) => handleMove(0, v)} 
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <label className="text-xs text-slate-500 font-medium">Y Position</label>
                      <SliderValue
                        value={selectedNode.pos[1]}
                        onChange={(v) => handleMove(1, v)}
                        decimals={3}
                        unit="m"
                        className="text-xs text-slate-500"
                      />
                    </div>
                    <RangeInput 
                      {...offsetSpan(selectedNode.pos[1])}
                      className="w-full accent-blue-500 cursor-pointer" 
                      value={selectedNode.pos[1]} 
                      onChange={(v) => handleMove(1, v)} 
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {(() => {
                      // For dynamic mesh bodies, pos[2] = centroid Z, not base Z.
                      // Compute centroid offset from renderVertices so slider 0 = base on ground.
                      const dynMesh = selectedNode.geoms?.find((g) => g.dynamic && g.renderVertices);
                      const centroidZ = dynMesh
                        ? -Math.min(...(dynMesh.renderVertices as number[]).filter((_: number, i: number) => i % 3 === 2))
                        : 0;
                      const displayZ = selectedNode.pos[2] - centroidZ;
                      return (<>
                        <div className="flex items-center justify-between">
                          <label className="text-xs text-slate-500 font-medium flex items-center gap-1">
                            Z Position (Height)
                            {centroidZ > 0 ? <span className="text-slate-300 text-[10px]">(+{centroidZ.toFixed(3)} centroid)</span> : null}
                          </label>
                          <SliderValue
                            value={displayZ}
                            onChange={(v) => handleMove(2, v + centroidZ)}
                            decimals={3}
                            unit="m"
                            className="text-xs text-slate-500"
                          />
                        </div>
                        <RangeInput
                          {...offsetSpan(displayZ)}
                          className="w-full accent-blue-500 cursor-pointer"
                          value={displayZ}
                          onChange={(v) => handleMove(2, v + centroidZ)}
                        />
                      </>);
                    })()}
                  </div>
                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-100">
                    <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Rotation Pivot</span>
                    <label 
                      className="text-xs font-medium text-slate-600 flex items-center gap-1.5 cursor-pointer bg-slate-50 hover:bg-slate-100 px-2 py-0.5 rounded border border-slate-200 transition-colors"
                      title={rotateAroundCOM ? "Rotate component in-place around its Center of Mass" : "Rotate component around World Origin (0,0,0)"}
                    >
                      <input 
                        type="checkbox" 
                        checked={rotateAroundCOM} 
                        onChange={(e) => setRotateAroundCOM(e.target.checked)} 
                        className="w-3.5 h-3.5 rounded text-blue-500 accent-blue-500 cursor-pointer"
                      />
                      Center of Mass
                    </label>
                  </div>
                  <div className="flex flex-col gap-1.5 mt-1 border-t border-slate-100 pt-2">
                    <label className="text-xs text-slate-500 flex items-center justify-between font-medium">X Rotation
                      <SliderValue value={getStickyRotation(selectedNode.euler ? selectedNode.euler[0] : 0)} onChange={(v) => updateNodeRotation(selectedNode.id, 0, v)} decimals={0} unit="°" min={0} max={360} />
                    </label>
                    <RangeInput 
                      min="0" 
                      max="360" 
                      step="1" 
                      className="w-full accent-blue-500 cursor-pointer" 
                      value={selectedNode.euler ? selectedNode.euler[0] : 0} 
                      onChange={(v) => updateNodeRotation(selectedNode.id, 0, v)} 
                    />
                  </div>
                  <div className="flex flex-col gap-1.5 mt-1">
                    <label className="text-xs text-slate-500 flex items-center justify-between font-medium">Y Rotation
                      <SliderValue value={getStickyRotation(selectedNode.euler ? selectedNode.euler[1] : 0)} onChange={(v) => updateNodeRotation(selectedNode.id, 1, v)} decimals={0} unit="°" min={0} max={360} />
                    </label>
                    <RangeInput 
                      min="0" 
                      max="360" 
                      step="1" 
                      className="w-full accent-blue-500 cursor-pointer" 
                      value={selectedNode.euler ? selectedNode.euler[1] : 0} 
                      onChange={(v) => updateNodeRotation(selectedNode.id, 1, v)} 
                    />
                  </div>
                  <div className="flex flex-col gap-1.5 mt-1">
                    <label className="text-xs text-slate-500 flex items-center justify-between font-medium">Z Rotation
                      <SliderValue value={getStickyRotation(selectedNode.euler ? selectedNode.euler[2] : 0)} onChange={(v) => updateNodeRotation(selectedNode.id, 2, v)} decimals={0} unit="°" min={0} max={360} />
                    </label>
                    <RangeInput 
                      min="0" 
                      max="360" 
                      step="1" 
                      className="w-full accent-blue-500 cursor-pointer" 
                      value={selectedNode.euler ? selectedNode.euler[2] : 0} 
                      onChange={(v) => updateNodeRotation(selectedNode.id, 2, v)} 
                    />
                  </div>
                </div>
              </div>

              {/* Resize. Here, after rotation, because it is the third thing
                  you do to a component and the panes below are a long way to
                  go for it. It carries the whole-body Scale multiplier as well:
                  Scale used to be a second card of its own in this slot, the
                  same control over the same state, with no telling the two
                  apart. The active sub-geom is resolved here rather than
                  inherited, since the geom-properties block it used to sit
                  inside now comes further down. */}
              {(() => {
                if (!selectedNode.geoms || selectedNode.geoms.length === 0) return null;
                const activeIndex = (activeGeomIndex >= 0 && activeGeomIndex < selectedNode.geoms.length) ? activeGeomIndex : 0;
                const geom = selectedNode.geoms[activeIndex];
                if (!geom) return null;
                return (
                  <>
                    {!selectedNode.id.includes('gear') && (
                      <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-3">
                        <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 flex items-center gap-1.5">
                          <span className="flex items-center gap-1">📏 Resize Component</span>
                          <DocsInfoButton tab="resize" />
                        </h3>

                        {selectedNode.teeth === undefined && (
                          <div className="flex flex-col gap-2 pb-1 border-b border-slate-100">
                            <label className="text-xs font-medium text-slate-500 flex justify-between">
                              Scale <span>applies to every sub-geom together</span>
                            </label>
                            <ScaleControls nodeId={selectedNode.id} />
                          </div>
                        )}
                        
                        {geom.type === 'sphere' && (
                          <div className="flex flex-col gap-2">
                            <label className="text-xs font-medium text-slate-500 flex justify-between">Radius <SliderValue value={geom.size[0]} onChange={(v) => {
                                const r = v;
                                updateNodeGeom(selectedNode.id, { size: [r] }, activeIndex);
                              }} decimals={2} unit="m" min={0.01} /></label>
                            <RangeInput 
                              {...lengthSpan(geom.size[0])}
                              value={geom.size[0]}
                              onChange={(v) => {
                                const r = v;
                                updateNodeGeom(selectedNode.id, { size: [r] }, activeIndex);
                              }}
                              className="w-full accent-blue-500 cursor-pointer" 
                            />
                          </div>
                        )}

                        {geom.type === 'box' && selectedNode.isWedge && (
                          <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Base Width (X) <SliderValue value={selectedNode.width || 2.0} onChange={(v) => {
                                  const val = v;
                                  updateWedgeParams(selectedNode.id, { width: val });
                                }} decimals={2} unit="m" min={0.01} /></label>
                              <RangeInput 
                                {...lengthSpan(selectedNode.width || 2.0)}
                                value={selectedNode.width || 2.0}
                                onChange={(v) => {
                                  const val = v;
                                  updateWedgeParams(selectedNode.id, { width: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Depth (Y) <SliderValue value={selectedNode.depth || 1.0} onChange={(v) => {
                                  const val = v;
                                  updateWedgeParams(selectedNode.id, { depth: val });
                                }} decimals={2} unit="m" min={0.01} /></label>
                              <RangeInput 
                                {...lengthSpan(selectedNode.depth || 1.0)}
                                value={selectedNode.depth || 1.0}
                                onChange={(v) => {
                                  const val = v;
                                  updateWedgeParams(selectedNode.id, { depth: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Height (Z) <SliderValue value={selectedNode.height || 0.5} onChange={(v) => {
                                  const val = v;
                                  updateWedgeParams(selectedNode.id, { height: val });
                                }} decimals={2} unit="m" min={0.01} /></label>
                              <RangeInput 
                                {...lengthSpan(selectedNode.height || 0.5)}
                                value={selectedNode.height || 0.5}
                                onChange={(v) => {
                                  const val = v;
                                  updateWedgeParams(selectedNode.id, { height: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            <div className="flex flex-col gap-1 border-t border-slate-100 pt-2">
                              <label className="text-xs font-medium text-slate-600 flex justify-between">Wedge Angle <SliderValue value={selectedNode.wedgeAngle !== undefined ? selectedNode.wedgeAngle : 14.036} onChange={(v) => {
                                  const val = v;
                                  updateWedgeParams(selectedNode.id, { wedgeAngle: val });
                                }} decimals={1} unit="°" min={2} max={85} /></label>
                              <RangeInput 
                                min="2" 
                                max="85" 
                                step="1" 
                                value={selectedNode.wedgeAngle !== undefined ? selectedNode.wedgeAngle : 14.036}
                                onChange={(v) => {
                                  const val = v;
                                  updateWedgeParams(selectedNode.id, { wedgeAngle: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                          </div>
                        )}

                        {selectedNode.isPyramid && (
                          <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Base Width (X) <SliderValue value={selectedNode.width || 0.5} onChange={(v) => {
                                  const val = v;
                                  updatePyramidParams(selectedNode.id, { width: val });
                                }} decimals={2} unit="m" min={0.01} /></label>
                              <RangeInput 
                                {...lengthSpan(selectedNode.width || 0.5)}
                                value={selectedNode.width || 0.5}
                                onChange={(v) => {
                                  const val = v;
                                  updatePyramidParams(selectedNode.id, { width: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Base Depth (Y) <SliderValue value={selectedNode.depth || 0.5} onChange={(v) => {
                                  const val = v;
                                  updatePyramidParams(selectedNode.id, { depth: val });
                                }} decimals={2} unit="m" min={0.01} /></label>
                              <RangeInput 
                                {...lengthSpan(selectedNode.depth || 0.5)}
                                value={selectedNode.depth || 0.5}
                                onChange={(v) => {
                                  const val = v;
                                  updatePyramidParams(selectedNode.id, { depth: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Height (Z) <SliderValue value={selectedNode.height || 0.5} onChange={(v) => {
                                  const val = v;
                                  updatePyramidParams(selectedNode.id, { height: val });
                                }} decimals={2} unit="m" min={0.01} /></label>
                              <RangeInput 
                                {...lengthSpan(selectedNode.height || 0.5)}
                                value={selectedNode.height || 0.5}
                                onChange={(v) => {
                                  const val = v;
                                  updatePyramidParams(selectedNode.id, { height: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                          </div>
                        )}

                        {selectedNode.isCone && (
                          <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Radius <SliderValue value={selectedNode.radius || 0.3} onChange={(v) => {
                                  const val = v;
                                  updateConeParams(selectedNode.id, { radius: val });
                                }} decimals={2} unit="m" min={0.01} /></label>
                              <RangeInput 
                                {...lengthSpan(selectedNode.radius || 0.3)}
                                value={selectedNode.radius || 0.3}
                                onChange={(v) => {
                                  const val = v;
                                  updateConeParams(selectedNode.id, { radius: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Height <SliderValue value={selectedNode.height || 0.6} onChange={(v) => {
                                  const val = v;
                                  updateConeParams(selectedNode.id, { height: val });
                                }} decimals={2} unit="m" min={0.01} /></label>
                              <RangeInput 
                                {...lengthSpan(selectedNode.height || 0.6)}
                                value={selectedNode.height || 0.6}
                                onChange={(v) => {
                                  const val = v;
                                  updateConeParams(selectedNode.id, { height: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                          </div>
                        )}

                        {selectedNode.isTorus && (
                          <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Major Radius (Ring) <SliderValue value={selectedNode.majorRadius || 0.4} onChange={(v) => {
                                  const val = v;
                                  updateTorusParams(selectedNode.id, { majorRadius: val });
                                }} decimals={2} unit="m" min={0.01} /></label>
                              <RangeInput 
                                {...lengthSpan(selectedNode.majorRadius || 0.4)}
                                value={selectedNode.majorRadius || 0.4}
                                onChange={(v) => {
                                  const val = v;
                                  updateTorusParams(selectedNode.id, { majorRadius: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Tube Radius <SliderValue value={selectedNode.tubeRadius || 0.1} onChange={(v) => {
                                  const val = v;
                                  updateTorusParams(selectedNode.id, { tubeRadius: val });
                                }} decimals={2} unit="m" min={0.01} /></label>
                              <RangeInput 
                                {...lengthSpan(selectedNode.tubeRadius || 0.1)}
                                value={selectedNode.tubeRadius || 0.1}
                                onChange={(v) => {
                                  const val = v;
                                  updateTorusParams(selectedNode.id, { tubeRadius: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                          </div>
                        )}

                        {selectedNode.isTube && (
                          <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Inner Radius <SliderValue value={selectedNode.innerRadius || 0.2} onChange={(v) => {
                                  const val = v;
                                  updateTubeParams(selectedNode.id, { innerRadius: val });
                                }} decimals={2} unit="m" min={0.01} /></label>
                              <RangeInput 
                                {...lengthSpan(selectedNode.innerRadius || 0.2)}
                                max={selectedNode.outerRadius ? selectedNode.outerRadius - 0.01 : 0.29}
                                value={selectedNode.innerRadius || 0.2} 
                                onChange={(v) => {
                                  const val = v;
                                  updateTubeParams(selectedNode.id, { innerRadius: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Outer Radius <SliderValue value={selectedNode.outerRadius || 0.3} onChange={(v) => {
                                  const val = v;
                                  updateTubeParams(selectedNode.id, { outerRadius: val });
                                }} decimals={2} unit="m" /></label>
                              <RangeInput 
                                {...lengthSpan(selectedNode.outerRadius || 0.3)}
                                min={selectedNode.innerRadius ? selectedNode.innerRadius + 0.01 : 0.21}
                                value={selectedNode.outerRadius || 0.3} 
                                onChange={(v) => {
                                  const val = v;
                                  updateTubeParams(selectedNode.id, { outerRadius: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Height (Z) <SliderValue value={selectedNode.height || 0.5} onChange={(v) => {
                                  const val = v;
                                  updateTubeParams(selectedNode.id, { height: val });
                                }} decimals={2} unit="m" min={0.01} /></label>
                              <RangeInput 
                                {...lengthSpan(selectedNode.height || 0.5)}
                                value={selectedNode.height || 0.5}
                                onChange={(v) => {
                                  const val = v;
                                  updateTubeParams(selectedNode.id, { height: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer"
                              />
                            </div>
                          </div>
                        )}

                        {selectedNode.isCurve && (
                          <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Track Width <SliderValue value={selectedNode.curveWidth || 0.5} onChange={(v) => {
                                  const val = v;
                                  updateCurveParams(selectedNode.id, { width: val });
                                }} decimals={2} unit="m" min={0.01} /></label>
                              <RangeInput
                                {...lengthSpan(selectedNode.curveWidth || 0.5)}
                                value={selectedNode.curveWidth || 0.5}
                                onChange={(v) => {
                                  const val = v;
                                  updateCurveParams(selectedNode.id, { width: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer"
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Thickness <SliderValue value={selectedNode.curveThickness || 0.06} onChange={(v) => {
                                  const val = v;
                                  updateCurveParams(selectedNode.id, { thickness: val });
                                }} decimals={2} unit="m" min={0.01} /></label>
                              <RangeInput
                                {...lengthSpan(selectedNode.curveThickness || 0.06)}
                                value={selectedNode.curveThickness || 0.06}
                                onChange={(v) => {
                                  const val = v;
                                  updateCurveParams(selectedNode.id, { thickness: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer"
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Smoothness <span>{selectedNode.curveSegments || 28} segments</span></label>
                              <RangeInput
                                min="6"
                                max="60"
                                step="1"
                                value={selectedNode.curveSegments || 28}
                                onChange={(v) => {
                                  const val = Math.round(v);
                                  updateCurveParams(selectedNode.id, { segments: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer"
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Bank Angle <SliderValue value={selectedNode.curveBank || 0} onChange={(v) => {
                                  const val = v;
                                  updateCurveParams(selectedNode.id, { bank: val });
                                }} decimals={0} unit="°" min={-45} max={45} /></label>
                              <RangeInput
                                min="-45"
                                max="45"
                                step="1"
                                value={selectedNode.curveBank || 0}
                                onChange={(v) => {
                                  const val = v;
                                  updateCurveParams(selectedNode.id, { bank: val });
                                }}
                                className="w-full accent-blue-500 cursor-pointer"
                              />
                            </div>
                            <label className="flex items-center gap-2 text-xs font-medium text-slate-500 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={selectedNode.curveClosed === true}
                                onChange={(e) => {
                                  updateCurveParams(selectedNode.id, { closed: e.target.checked });
                                }}
                                className="accent-blue-500"
                              />
                              Closed loop (join ends)
                            </label>
                            <div className="flex flex-col gap-1.5">
                              <label className="text-xs font-medium text-slate-500">Control Points (x, y, z). Drag the blue handles in the viewport, or edit here.</label>
                              {(selectedNode.curvePoints || []).map((pt: number[], pi: number) => (
                                <div key={pi} className="flex items-center gap-1">
                                  {[0, 1, 2].map((axis) => (
                                    <input
                                      key={axis}
                                      type="number"
                                      step="0.1"
                                      value={pt[axis]}
                                      onChange={(e) => {
                                        const val = parseFloat(e.target.value);
                                        if (isNaN(val)) return;
                                        const pts = (selectedNode.curvePoints || []).map((p: number[]) => [...p]);
                                        pts[pi][axis] = val;
                                        updateCurveParams(selectedNode.id, { points: pts });
                                      }}
                                      className="w-full min-w-0 px-1.5 py-1 text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300"
                                    />
                                  ))}
                                  <button
                                    onClick={() => {
                                      const pts = (selectedNode.curvePoints || []).map((p: number[]) => [...p]);
                                      if (pts.length <= 2) return; // spline needs at least 2 points
                                      pts.splice(pi, 1);
                                      updateCurveParams(selectedNode.id, { points: pts });
                                    }}
                                    disabled={(selectedNode.curvePoints || []).length <= 2}
                                    className="p-1 text-slate-400 hover:text-red-500 disabled:opacity-30 disabled:hover:text-slate-400"
                                    title="Remove point"
                                  >
                                    <X className="w-3 h-3" />
                                  </button>
                                </div>
                              ))}
                              <button
                                onClick={() => {
                                  const pts = (selectedNode.curvePoints || []).map((p: number[]) => [...p]);
                                  const n = pts.length;
                                  // extend past the last point along the last span direction
                                  const last = pts[n - 1];
                                  const prev = pts[n - 2] || [last[0] - 1, last[1], last[2]];
                                  pts.push([last[0] + (last[0] - prev[0]), last[1] + (last[1] - prev[1]), last[2] + (last[2] - prev[2])]);
                                  updateCurveParams(selectedNode.id, { points: pts });
                                }}
                                className="mt-1 px-2 py-1 text-xs font-medium rounded border border-dashed border-slate-300 dark:border-slate-700 text-slate-500 hover:border-blue-400 hover:text-blue-500 transition-colors"
                              >
                                + Add Point
                              </button>
                            </div>
                          </div>
                        )}

                        {geom.type === 'ellipsoid' && (
                          <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Radius X <SliderValue value={geom.size[0]} onChange={(v) => {
                                  const val = v;
                                  updateNodeGeom(selectedNode.id, { size: [val, geom.size[1], geom.size[2]] }, activeIndex);
                                }} decimals={2} unit="m" min={0.01} /></label>
                              <RangeInput 
                                {...lengthSpan(geom.size[0])}
                                value={geom.size[0]}
                                onChange={(v) => {
                                  const val = v;
                                  updateNodeGeom(selectedNode.id, { size: [val, geom.size[1], geom.size[2]] }, activeIndex);
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Radius Y <SliderValue value={geom.size[1]} onChange={(v) => {
                                  const val = v;
                                  updateNodeGeom(selectedNode.id, { size: [geom.size[0], val, geom.size[2]] }, activeIndex);
                                }} decimals={2} unit="m" min={0.01} /></label>
                              <RangeInput 
                                {...lengthSpan(geom.size[1])}
                                value={geom.size[1]}
                                onChange={(v) => {
                                  const val = v;
                                  updateNodeGeom(selectedNode.id, { size: [geom.size[0], val, geom.size[2]] }, activeIndex);
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Radius Z <SliderValue value={geom.size[2]} onChange={(v) => {
                                  const val = v;
                                  updateNodeGeom(selectedNode.id, { size: [geom.size[0], geom.size[1], val] }, activeIndex);
                                }} decimals={2} unit="m" min={0.01} /></label>
                              <RangeInput 
                                {...lengthSpan(geom.size[2])}
                                value={geom.size[2]}
                                onChange={(v) => {
                                  const val = v;
                                  updateNodeGeom(selectedNode.id, { size: [geom.size[0], geom.size[1], val] }, activeIndex);
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                          </div>
                        )}

                        {geom.type === 'box' && !selectedNode.isWedge && (
                          <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Width (X) <SliderValue value={geom.size[0]} onChange={(v) => {
                                  const val = v;
                                  updateNodeGeom(selectedNode.id, { size: [val, geom.size[1], geom.size[2]] }, activeIndex);
                                }} decimals={2} unit="m" min={0.01} /></label>
                              <RangeInput 
                                {...lengthSpan(geom.size[0])}
                                value={geom.size[0]}
                                onChange={(v) => {
                                  const val = v;
                                  updateNodeGeom(selectedNode.id, { size: [val, geom.size[1], geom.size[2]] }, activeIndex);
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Depth (Y) <SliderValue value={geom.size[1]} onChange={(v) => {
                                  const val = v;
                                  updateNodeGeom(selectedNode.id, { size: [geom.size[0], val, geom.size[2]] }, activeIndex);
                                }} decimals={2} unit="m" min={0.01} /></label>
                              <RangeInput 
                                {...lengthSpan(geom.size[1])}
                                value={geom.size[1]}
                                onChange={(v) => {
                                  const val = v;
                                  updateNodeGeom(selectedNode.id, { size: [geom.size[0], val, geom.size[2]] }, activeIndex);
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Height (Z) <SliderValue value={geom.size[2]} onChange={(v) => {
                                  const val = v;
                                  updateNodeGeom(selectedNode.id, { size: [geom.size[0], geom.size[1], val] }, activeIndex);
                                }} decimals={2} unit="m" min={0.01} /></label>
                              <RangeInput 
                                {...lengthSpan(geom.size[2])}
                                value={geom.size[2]}
                                onChange={(v) => {
                                  const val = v;
                                  updateNodeGeom(selectedNode.id, { size: [geom.size[0], geom.size[1], val] }, activeIndex);
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                          </div>
                        )}

                        {(geom.type === 'capsule' || geom.type === 'cylinder') && !selectedNode.isPulleyWheel && (
                          <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Radius <SliderValue value={geom.size[0]} onChange={(v) => {
                                  const val = v;
                                  updateNodeGeom(selectedNode.id, { 
                                    size: geom.size[1] !== undefined ? [val, geom.size[1]] : [val] 
                                  }, activeIndex);
                                }} decimals={3} unit="m" min={0.01} /></label>
                              <RangeInput 
                                {...lengthSpan(geom.size[0])}
                                value={geom.size[0]}
                                onChange={(v) => {
                                  const val = v;
                                  updateNodeGeom(selectedNode.id, { 
                                    size: geom.size[1] !== undefined ? [val, geom.size[1]] : [val] 
                                  }, activeIndex);
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            {geom.size[1] !== undefined && (
                              <div className="flex flex-col gap-1">
                                <label className="text-xs font-medium text-slate-500 flex justify-between">Length (Half-Height) <SliderValue value={geom.size[1]} onChange={(v) => {
                                    const val = v;
                                    updateNodeGeom(selectedNode.id, { size: [geom.size[0], val] }, activeIndex);
                                  }} decimals={2} unit="m" min={0.01} /></label>
                                <RangeInput 
                                  {...lengthSpan(geom.size[1])}
                                  value={geom.size[1]}
                                  onChange={(v) => {
                                    const val = v;
                                    updateNodeGeom(selectedNode.id, { size: [geom.size[0], val] }, activeIndex);
                                  }}
                                  className="w-full accent-blue-500 cursor-pointer" 
                                />
                              </div>
                            )}
                            {geom.fromto !== undefined && (() => {
                              // Held in a local so the handlers below, which
                              // are functions and so lose the narrowing above,
                              // read the same array.
                              const fromto = geom.fromto;
                              const dirX = fromto[3] - fromto[0];
                              const dirY = fromto[4] - fromto[1];
                              const dirZ = fromto[5] - fromto[2];
                              const currentLength = Math.sqrt(dirX*dirX + dirY*dirY + dirZ*dirZ) || 1.0;
                              
                              return (
                                <div className="flex flex-col gap-1">
                                  <label className="text-xs font-medium text-slate-500 flex justify-between">
                                    Length (Segment) <SliderValue value={currentLength} onChange={(v) => {
                                      const newVal = v;
                                      const scale = newVal / currentLength;
                                      const newFromto = [
                                        fromto[0],
                                        fromto[1],
                                        fromto[2],
                                        fromto[0] + dirX * scale,
                                        fromto[1] + dirY * scale,
                                        fromto[2] + dirZ * scale
                                      ];
                                      updateNodeGeom(selectedNode.id, { fromto: newFromto }, activeIndex);
                                    }} decimals={2} unit="m" min={0.01} />
                                  </label>
                                  <RangeInput 
                                    {...lengthSpan(currentLength)}
                                    value={currentLength} 
                                    onChange={(v) => {
                                      const newVal = v;
                                      const scale = newVal / currentLength;
                                      const newFromto = [
                                        fromto[0],
                                        fromto[1],
                                        fromto[2],
                                        fromto[0] + dirX * scale,
                                        fromto[1] + dirY * scale,
                                        fromto[2] + dirZ * scale
                                      ];
                                      updateNodeGeom(selectedNode.id, { fromto: newFromto }, activeIndex);
                                    }}
                                    className="w-full accent-blue-500 cursor-pointer" 
                                  />
                                </div>
                              );
                            })()}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                );
              })()}

              {/* Joint Type Configuration */}
              <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
                <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
                  <span className="flex items-center gap-1">🔗 Joint Type</span>
                  <DocsInfoButton tab="gravity" />
                </h3>
                <select 
                  value={selectedNode.joints?.length > 0 ? selectedNode.joints[0].type : 'fixed'}
                  onChange={(e) => {
                    const jointType = e.target.value;
                    let newJoints: SceneJoint[] = [];
                    if (jointType !== 'fixed') {
                      const name = `${selectedNode.id}_joint`;
                      if (jointType === 'free') {
                        newJoints = [{ name, type: 'free' }];
                      } else if (jointType === 'hinge') {
                        newJoints = [{ name, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.5 }];
                      } else if (jointType === 'slide') {
                        newJoints = [{ name, type: 'slide', axis: [0, 0, 1], pos: [0, 0, 0], damping: 0.5 }];
                      } else if (jointType === 'ball') {
                        newJoints = [{ name, type: 'ball', pos: [0, 0, 0], damping: 0.5 }];
                      }
                    }
                    // A free joint is only legal on a top-level body. Asked
                    // for on a nested one, MuJoCo refuses the entire model and
                    // the app carries on with the last one that worked, so the
                    // body stops responding with nothing said. Offer the
                    // detach that would make it legal instead.
                    if (jointType === 'free' && !isTopLevel(sceneGraph.nodes, selectedNode.id)) {
                      setDetachForFree({ id: selectedNode.id, joints: newJoints });
                      return;
                    }
                    updateNodeJointsList(selectedNode.id, newJoints);
                  }}
                  className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm bg-white font-medium text-slate-700 outline-none focus:border-blue-500 cursor-pointer"
                >
                  <option value="fixed">Fixed / Welded to Parent</option>
                  <option value="free">Free (6-DOF Movable)</option>
                  <option value="hinge">Hinge (Rotational Joint)</option>
                  <option value="slide">Slider (Prismatic Joint)</option>
                  <option value="ball">Ball Joint (Spherical)</option>
                </select>

                {selectedNode.joints?.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1.5 p-2 bg-slate-50 rounded-lg border border-slate-150">
                    <div className="flex justify-between items-center">
                      <label className="text-[9px] font-semibold text-slate-400 uppercase tracking-wider">Joint Name (for API)</label>
                      <span className="font-mono text-[9px] text-blue-600 font-semibold bg-blue-50 px-1 py-0.5 rounded cursor-pointer select-all border border-blue-100" title="Joint API Reference. Click to select/copy.">
                        api.getJointPosition('{selectedNode.joints[0].name}')
                      </span>
                    </div>
                    <SettledTextInput
                      value={selectedNode.joints[0].name || ''}
                      clean={(raw) => raw.replace(/[^a-zA-Z0-9_]/g, '_')}
                      onChange={(cleanName) => updateNodeJoint(selectedNode.id, { name: cleanName })}
                      className="w-full px-2 py-1 border border-slate-200 rounded text-xs font-mono bg-white text-slate-800 outline-none focus:border-blue-500 shadow-sm"
                      placeholder="e.g. cart_slide"
                    />
                  </div>
                )}
                
                {/* Free Joint Launch Velocity */}
                {selectedNode.joints?.length > 0 && selectedNode.joints[0].type === 'free' && (
                  <div className="flex flex-col gap-2 mt-2 pt-2 border-t border-slate-100">
                    <h3 className="text-xs font-semibold text-slate-600 mb-1 flex items-center gap-1.5">
                      <span>Launch Velocity (m/s)</span>
                      <DocsInfoButton tab="launch" size="w-3 h-3" />
                    </h3>
                    {['X (Forward)', 'Y (Side)', 'Z (Up)'].map((label, i) => (
                      <div key={label} className="flex flex-col gap-1">
                        <label className="text-xs font-medium text-slate-500 flex justify-between">
                          {label} <span>{selectedNode.joints[0].initialVelocity?.[i] || 0}</span>
                        </label>
                        <RangeInput
                          min="-20"
                          max="20"
                          step="0.5"
                          value={selectedNode.joints[0].initialVelocity?.[i] || 0}
                          onChange={(v) => {
                            const vel = [...(selectedNode.joints[0].initialVelocity || [0,0,0,0,0,0])];
                            vel[i] = v;
                            updateNodeJoint(selectedNode.id, { ...selectedNode.joints[0], initialVelocity: vel });
                          }}
                          className="w-full accent-blue-500 cursor-pointer"
                        />
                      </div>
                    ))}

                    <h3 className="text-xs font-semibold text-slate-600 mt-2 mb-1 pt-2 border-t border-slate-100 flex items-center gap-1.5">
                      <span>Launch Spin / Angular Velocity (rad/s)</span>
                      <DocsInfoButton tab="launch" size="w-3 h-3" />
                    </h3>
                    {['X (Roll)', 'Y (Pitch)', 'Z (Yaw)'].map((label, i) => {
                      const idx = i + 3;
                      return (
                        <div key={label} className="flex flex-col gap-1">
                          <label className="text-xs font-medium text-slate-500 flex justify-between">
                            {label} <span>{selectedNode.joints[0].initialVelocity?.[idx] || 0}</span>
                          </label>
                          <RangeInput
                            min="-50"
                            max="50"
                            step="0.5"
                            value={selectedNode.joints[0].initialVelocity?.[idx] || 0}
                            onChange={(v) => {
                              const vel = [...(selectedNode.joints[0].initialVelocity || [0,0,0,0,0,0])];
                              vel[idx] = v;
                              updateNodeJoint(selectedNode.id, { ...selectedNode.joints[0], initialVelocity: vel });
                            }}
                            className="w-full accent-blue-500 cursor-pointer"
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Motor Actuator Option for Hinge/Slide joints */}
              {selectedNode.joints?.length > 0 && (selectedNode.joints[0].type === 'hinge' || selectedNode.joints[0].type === 'slide') && (
                <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
                  <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1">⚡ Joint Actuator / Motor</h3>
                  <label className="text-xs font-semibold text-slate-500 flex items-center gap-2 cursor-pointer py-1">
                    <input 
                      type="checkbox" 
                      checked={!!selectedNode.joints[0].actuator}
                      onChange={(e) => {
                        const enabled = e.target.checked;
                        const updatedJoint = {
                          ...selectedNode.joints[0],
                          actuator: enabled ? { type: 'velocity' as const, kv: 10, ctrlValue: 0 } : undefined
                        };
                        updateNodeJoint(selectedNode.id, updatedJoint);
                      }}
                      className="w-4 h-4 rounded text-blue-500 focus:ring-blue-400 accent-blue-500 cursor-pointer"
                    />
                    Enable Motor Drive
                  </label>

                  {selectedNode.joints[0].actuator && (
                    <div className="flex flex-col gap-2.5 mt-1 pt-2 border-t border-slate-100">
                      <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Actuator Type</label>
                        <select
                          value={selectedNode.joints[0].actuator.type}
                          onChange={(e) => {
                            const type = e.target.value as 'velocity' | 'motor';
                            updateNodeJoint(selectedNode.id, {
                              ...selectedNode.joints[0],
                              actuator: { ...selectedNode.joints[0].actuator, type, kv: type === 'velocity' ? 10 : undefined }
                            });
                          }}
                          className="w-full px-2 py-1.5 border border-slate-200 rounded text-xs bg-white font-medium text-slate-700 outline-none cursor-pointer focus:border-blue-500"
                        >
                          <option value="velocity">Velocity Drive (Target Speed)</option>
                          <option value="motor">Torque Drive (Direct Force)</option>
                        </select>
                      </div>

                      {selectedNode.joints[0].actuator.type === 'velocity' && (
                        <div className="flex flex-col gap-1">
                          <label className="text-xs font-medium text-slate-500 flex justify-between">
                            Velocity Gain (kv) <span>{selectedNode.joints[0].actuator.kv || 10}</span>
                          </label>
                          <RangeInput
                            min="0.5"
                            max="100"
                            step="0.5"
                            value={selectedNode.joints[0].actuator.kv || 10}
                            onChange={(v) => {
                              updateNodeJoint(selectedNode.id, {
                                ...selectedNode.joints[0],
                                actuator: { ...selectedNode.joints[0].actuator!, kv: v }
                              });
                            }}
                            className="w-full accent-blue-500 cursor-pointer"
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}


              {/* Gear Config */}
              {selectedNode.id.includes('gear') && selectedNode.geoms && (() => {
                const pegGeom = selectedNode.geoms.find((g) => g.name.includes('peg'));
                const gearRadius = selectedNode.geoms[0].size[0];
                return (
                  <div className="flex flex-col gap-4">
                    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
                      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1">⚙️ Gear Properties</h3>
                      <label className="text-xs font-medium text-slate-500 flex justify-between">
                        Teeth Count <span>{selectedNode.geoms.length - (pegGeom ? 2 : 1)}</span>
                      </label>
                      <RangeInput 
                        min="4" 
                        max="24" 
                        step="1" 
                        value={selectedNode.geoms.length - (pegGeom ? 2 : 1)} 
                        onChange={(v) => {
                          const teethVal = Math.round(v);
                          updateGearTeeth(selectedNode.id, teethVal);
                        }} 
                        className="w-full accent-blue-500 cursor-pointer" 
                      />
                      <label className="text-xs font-medium text-slate-500 flex justify-between mt-2">
                        Gear Radius <SliderValue value={gearRadius} onChange={(v) => {
                          const r = v;
                          updateNodeGeom(selectedNode.id, { size: [r, selectedNode.geoms[0].size[1]] });
                        }} decimals={2} unit="m" min={0.05} max={5.0} />
                      </label>
                      <RangeInput 
                        min="0.05" 
                        max="5.0" 
                        step="0.01" 
                        value={gearRadius} 
                        onChange={(v) => {
                          const r = v;
                          updateNodeGeom(selectedNode.id, { size: [r, selectedNode.geoms[0].size[1]] });
                        }} 
                        className="w-full accent-blue-500 cursor-pointer" 
                      />
                    </div>

                    {/* generateGearGeoms always places the peg, so `pos` is there. */}
                    {pegGeom && pegGeom.pos ? (
                      <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
                        <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1">📍 Pusher Peg Properties</h3>
                        <label className="text-xs font-medium text-slate-500 flex justify-between">
                          Peg Offset (Radius) <SliderValue value={pegGeom.pos[0]} onChange={(v) => {
                            const offsetVal = v;
                            updatePusherPeg(selectedNode.id, { offset: offsetVal });
                          }} decimals={2} unit="m" min={0.01} max={5.0} />
                        </label>
                        <RangeInput 
                          min="0.01" 
                          max="5.0" 
                          step="0.01" 
                          value={pegGeom.pos[0]} 
                          onChange={(v) => {
                            const offsetVal = v;
                            updatePusherPeg(selectedNode.id, { offset: offsetVal });
                          }} 
                          className="w-full accent-blue-500 cursor-pointer" 
                        />
                        <label className="text-xs font-medium text-slate-500 flex justify-between mt-2">
                          Peg Thickness <SliderValue value={pegGeom.size[0]} onChange={(v) => {
                            const rVal = v;
                            updatePusherPeg(selectedNode.id, { size: [rVal, pegGeom.size[1]] });
                          }} decimals={3} unit="m" min={0.005} max={0.5} />
                        </label>
                        <RangeInput 
                          min="0.005" 
                          max="0.5" 
                          step="0.005" 
                          value={pegGeom.size[0]} 
                          onChange={(v) => {
                            const rVal = v;
                            updatePusherPeg(selectedNode.id, { size: [rVal, pegGeom.size[1]] });
                          }} 
                          className="w-full accent-blue-500 cursor-pointer" 
                        />
                        <label className="text-xs font-medium text-slate-500 flex justify-between mt-2">
                          Peg Length <SliderValue value={pegGeom.size[1]} onChange={(v) => {
                            const hVal = v;
                            updatePusherPeg(selectedNode.id, { size: [pegGeom.size[0], hVal] });
                          }} decimals={2} unit="m" min={0.01} max={1.0} />
                        </label>
                        <RangeInput 
                          min="0.01" 
                          max="1.0" 
                          step="0.01" 
                          value={pegGeom.size[1]} 
                          onChange={(v) => {
                            const hVal = v;
                            updatePusherPeg(selectedNode.id, { size: [pegGeom.size[0], hVal] });
                          }} 
                          className="w-full accent-blue-500 cursor-pointer" 
                        />
                        <button
                          onClick={() => deletePusherPeg(selectedNode.id)}
                          className="mt-2 w-full py-1.5 px-3 bg-red-50 text-red-600 hover:bg-red-100 rounded-md text-xs font-medium transition duration-150 shadow-sm border border-red-100"
                        >
                          🗑️ Remove Pusher Peg
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => addPusherPeg(selectedNode.id)}
                        className="py-2 px-3 bg-blue-50 hover:bg-blue-100 text-blue-600 rounded-lg text-xs font-semibold transition duration-150 border border-blue-100 flex items-center justify-center gap-1.5 shadow-sm"
                      >
                        ➕ Add Pusher Peg
                      </button>
                    )}
                  </div>
                );
              })()}

              {/* Damping, Limits, and Actuator Target Speed properties */}
              {selectedNode.joints?.map((joint, i) => (
                <div key={`joint-${i}`} className="flex flex-col gap-4">
                  {(joint.damping !== undefined || joint.type === 'free') && (
                    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
                      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
                        <span className="flex items-center gap-1">🔗 Joint Damping</span>
                        <DocsInfoButton tab="damping" />
                      </h3>
                      <label className="text-xs font-medium text-slate-500 flex justify-between">Damping <SliderValue value={joint.damping !== undefined ? joint.damping : 0.0} onChange={(v) => updateNodeJoint(selectedNode.id, {damping: v})} decimals={2} min={0} /></label>
                      <RangeInput 
                        min="0" 
                        max={joint.type === 'free' ? "5.0" : "500"} 
                        step={joint.type === 'free' ? "0.01" : "0.1"} 
                        value={joint.damping !== undefined ? joint.damping : 0.0} 
                        onChange={(v) => updateNodeJoint(selectedNode.id, {damping: v})} 
                        className="w-full accent-blue-500 cursor-pointer" 
                      />
                    </div>
                  )}

                  {/* Crumple — a joint that is rigid until it is overloaded,
                      and then folds and stays folded. Held still by an
                      auto-emitted weld; releasing it is the same one-byte write
                      that shears a weld off. See utils/breakThresholds.ts. */}
                  {(joint.type === 'hinge' || joint.type === 'slide') && (() => {
                    const on = joint.crumpleTorqueNm !== undefined;
                    const key = `crumple:${joint.name}`;
                    const given = brokenConstraints.includes(key);
                    const info = given && lastBreak?.key === key ? lastBreak : null;
                    const range = joint.crumpleRangeDeg ?? [-80, 0];
                    return (
                      <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
                        <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
                          <span className="flex items-center gap-1">🪗 Crumple Zone</span>
                          {given
                            ? <span className="text-[10px] font-semibold text-amber-600">folded</span>
                            : <DocsInfoButton tab="breaking" />}
                        </h3>

                        <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={(e) => updateNodeJoint(selectedNode.id, e.target.checked
                              ? { crumpleTorqueNm: 10, crumpleRangeDeg: [-80, 0], crumpleDampingAfter: 5 }
                              : { crumpleTorqueNm: undefined, crumpleRangeDeg: undefined, crumpleDampingAfter: undefined })}
                            className="accent-amber-500 cursor-pointer"
                          />
                          This joint can take a permanent set
                        </label>

                        {on && (
                          <>
                            <div className="flex items-center gap-2">
                              <label className="text-[10px] text-slate-500 w-20 shrink-0">Gives at</label>
                              <SettledNumberInput
                                step="1" min={0}
                                value={joint.crumpleTorqueNm ?? 0}
                                onChange={(v) => updateNodeJoint(selectedNode.id, { crumpleTorqueNm: v })}
                                className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500"
                              />
                              <span className="text-[10px] text-slate-400 w-8 shrink-0">N·m</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <label className="text-[10px] text-slate-500 w-20 shrink-0">Folds to</label>
                              <SettledNumberInput
                                step="5"
                                value={range[0]}
                                onChange={(v) => updateNodeJoint(selectedNode.id, { crumpleRangeDeg: [v, range[1]] })}
                                className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500"
                              />
                              <SettledNumberInput
                                step="5"
                                value={range[1]}
                                onChange={(v) => updateNodeJoint(selectedNode.id, { crumpleRangeDeg: [range[0], v] })}
                                className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500"
                              />
                              <span className="text-[10px] text-slate-400 w-8 shrink-0">deg</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <label className="text-[10px] text-slate-500 w-20 shrink-0">Stiffness after</label>
                              <SettledNumberInput
                                step="1" min={0}
                                value={joint.crumpleDampingAfter ?? 0}
                                onChange={(v) => updateNodeJoint(selectedNode.id, { crumpleDampingAfter: v })}
                                className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500"
                              />
                              <span className="text-[10px] text-slate-400 w-8 shrink-0">N·m·s</span>
                            </div>
                            <p className="text-[10px] text-slate-400 leading-snug">
                              Held rigid until the torque on it passes the limit, then it folds
                              within the range above and <strong className="text-slate-500">stays
                              folded</strong> — a spring comes back, a crumpled bracket does not.
                              Give it enough stiffness after that it settles into its new shape
                              instead of swinging into it. Reset straightens it.
                            </p>
                            {info && (
                              <div className="flex items-center gap-2 text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 leading-snug">
                                <span className="flex-1">
                                  Gave at {info.time.toFixed(2)} s, carrying {info.torqueNm.toFixed(1)} N·m.
                                </span>
                                <button
                                  onClick={() => restoreConstraint(key)}
                                  className="shrink-0 px-1.5 py-0.5 rounded border border-amber-300 hover:bg-amber-100 font-medium"
                                >
                                  Straighten
                                </button>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })()}

                  {(joint.type === 'hinge' || joint.type === 'slide' || joint.type === 'ball') && (
                    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-3">
                      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
                        <span className="flex items-center gap-1">🌸 Joint Springs</span>
                        <DocsInfoButton tab="springs" />
                      </h3>
                      
                      <div className="flex flex-col gap-1">
                        <label className="text-xs font-medium text-slate-500 flex justify-between">
                          Spring Stiffness (K) <SliderValue value={joint.stiffness || 0} onChange={(v) => updateNodeJoint(selectedNode.id, { stiffness: v })} decimals={0} unit="N/m" min={0} max={5000} />
                        </label>
                        <RangeInput 
                          min="0" 
                          max="5000" 
                          step="10" 
                          value={joint.stiffness || 0} 
                          onChange={(v) => updateNodeJoint(selectedNode.id, { stiffness: v })}
                          className="w-full accent-blue-500 cursor-pointer" 
                        />
                      </div>

                      {(joint.stiffness || 0) > 0 && (joint.type === 'hinge' || joint.type === 'slide') && (
                        <div className="flex flex-col gap-1 mt-1 border-t border-slate-50 pt-2">
                          <label className="text-xs font-medium text-slate-500 flex justify-between">
                            Spring Rest Position <span>{(joint.springref || 0).toFixed(joint.type === 'slide' ? 2 : 0)}{joint.type === 'slide' ? ' m' : '°'}</span>
                          </label>
                          <RangeInput 
                            min={joint.type === 'slide' ? -20.0 : -360} 
                            max={joint.type === 'slide' ? 20.0 : 360} 
                            step={joint.type === 'slide' ? 0.05 : 1} 
                            value={joint.springref || 0} 
                            onChange={(v) => {
                              const raw = v;
                              const val = joint.type === 'slide' ? raw : getStickyRotation(raw);
                              updateNodeJoint(selectedNode.id, { springref: val });
                            }}
                            className="w-full accent-blue-500 cursor-pointer" 
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {(joint.type === 'hinge' || joint.type === 'slide') && (
                    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-3">
                      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
                        <span className="flex items-center gap-1">🔒 Joint Limits</span>
                        <DocsInfoButton tab="springs" />
                      </h3>
                      
                      <label className="text-xs font-semibold text-slate-500 flex items-center gap-2 cursor-pointer py-1">
                        <input 
                          type="checkbox" 
                          checked={joint.limited === true || (joint.limited as unknown) === 'true'}
                          onChange={(e) => {
                            const enabled = e.target.checked;
                            const defaultRange = joint.type === 'slide' ? [-1.0, 1.0] : [-90, 90];
                            updateNodeJoint(selectedNode.id, { 
                              limited: enabled,
                              range: enabled ? (joint.range || defaultRange) : undefined
                            });
                          }}
                          className="w-4 h-4 rounded text-blue-500 focus:ring-blue-400 accent-blue-500 cursor-pointer"
                        />
                        Enable Range Limits
                      </label>

                      {/* A scene loaded from JSON can carry the string rather than the
                          boolean, and always could; the cast only says so. */}
                      {(joint.limited === true || (joint.limited as unknown) === 'true') && (() => {
                        const range = joint.range || (joint.type === 'slide' ? [-1.0, 1.0] : [-90, 90]);
                        const isSlide = joint.type === 'slide';
                        const minVal = range[0];
                        const maxVal = range[1];
                        
                        return (
                          <div className="flex flex-col gap-3 mt-1 border-t border-slate-50 pt-2">
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">
                                Minimum Limit <span>{minVal.toFixed(isSlide ? 2 : 0)}{isSlide ? ' m' : '°'}</span>
                              </label>
                              <RangeInput 
                                min={isSlide ? -20.0 : -360}
                                max={isSlide ? 20.0 : 360}
                                step={isSlide ? 0.05 : 1}
                                list={!isSlide ? 'rotation-snaps' : undefined}
                                value={minVal}
                                onChange={(v) => {
                                  const raw = v;
                                  const val = isSlide ? raw : getStickyRotation(raw);
                                  const newMin = Math.min(val, maxVal);
                                  updateNodeJoint(selectedNode.id, { range: [newMin, maxVal] });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>

                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">
                                Maximum Limit <span>{maxVal.toFixed(isSlide ? 2 : 0)}{isSlide ? ' m' : '°'}</span>
                              </label>
                              <RangeInput 
                                min={isSlide ? -20.0 : -360}
                                max={isSlide ? 20.0 : 360}
                                step={isSlide ? 0.05 : 1}
                                list={!isSlide ? 'rotation-snaps' : undefined}
                                value={maxVal}
                                onChange={(v) => {
                                  const raw = v;
                                  const val = isSlide ? raw : getStickyRotation(raw);
                                  const newMax = Math.max(val, minVal);
                                  updateNodeJoint(selectedNode.id, { range: [minVal, newMax] });
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  )}

                  {joint.actuator && (() => {
                    const isTorque = joint.actuator.type === 'motor';
                    
                    return (
                      <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
                        <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1">
                          {isTorque ? '💪 Target Torque/Force' : '⚡ Target Velocity'}
                        </h3>
                        <label className="text-xs font-medium text-slate-500 flex justify-between">
                          {isTorque ? 'Control Force' : 'Control Speed'}
                          <span>{joint.actuator.ctrlValue || 0}</span>
                        </label>
                        <input 
                          type="range" 
                          min={isTorque ? "-1000" : "-100"} 
                          max={isTorque ? "1000" : "100"} 
                          step={isTorque ? "1" : "0.1"} 
                          value={joint.actuator.ctrlValue || 0} 
                          onChange={(e) => {
                            const val = parseFloat(e.target.value);
                            if (isPlaying) {
                              getPhysicsWorkerClient().setCtrl(`${joint.name}_actuator`, val);
                            }
                            updateNodeJoint(selectedNode.id, { actuator: { ...joint.actuator!, ctrlValue: val } });
                          }}
                          className="w-full accent-blue-500 cursor-pointer" 
                        />
                      </div>
                    );
                  })()}
                </div>
              ))}

              {/* Dimensions Resizing and Color Properties */}
              {(() => {
                if (!selectedNode.geoms || selectedNode.geoms.length === 0) return null;
                const activeIndex = (activeGeomIndex >= 0 && activeGeomIndex < selectedNode.geoms.length) ? activeGeomIndex : 0;
                const geom = selectedNode.geoms[activeIndex];
                if (!geom) return null;
                return (
                  <div key="geom-properties" className="flex flex-col gap-4">
                    {/* Sub-Geometry dropdown selector if there are multiple geoms */}
                    {selectedNode.geoms.length > 1 && (
                      <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
                        <label className="text-xs font-semibold text-slate-600">Select Sub-Geometry</label>
                        <select
                          value={activeIndex}
                          onChange={(e) => setActiveGeomIndex(parseInt(e.target.value))}
                          className="w-full px-2.5 py-1.5 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500 cursor-pointer font-medium"
                        >
                          {selectedNode.geoms.map((g, idx) => (
                            // Generated boolean geoms aren't editable — a body with
                            // 16 sector colliders would otherwise bury its two real
                            // shapes at the bottom of this list. Values stay the
                            // real indices so activeGeomIndex still means one thing.
                            g.csgDerived ? null : (
                            <option key={idx} value={idx}>
                              {g.csg === 'difference' ? '\u2796 ' : g.csg === 'intersection' ? '\u2229 ' : ''}{g.name || `Geom ${idx + 1}`} ({g.type})
                            </option>
                            )
                          ))}
                        </select>
                        <div className="text-[10px] text-slate-400 font-semibold px-0.5 flex justify-between uppercase tracking-wider">
                          <span>Type: {geom.type}</span>
                          {geom.name && <span>Name: {geom.name}</span>}
                        </div>
                      </div>
                    )}


                    {/* Position Offset Control for Sub-Geom */}
                    {(() => {
                      const pos = geom.pos || [0, 0, 0];
                      return (
                        // Folded until opened: most bodies never move a sub-geom off its origin.
                        // The class is only the starting state; the header click toggles it (see
                        // the collapse effect), and React leaves it alone while the prop is unchanged.
                        <div className="is-collapsed p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-3">
                          <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 flex items-center gap-1.5">
                            <span className="flex items-center gap-1">📍 Geom Position Offset</span>
                            <DocsInfoButton tab="offset" />
                          </h3>
                          <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">X Offset <SliderValue value={pos[0]} onChange={(v) => {
                                  const val = v;
                                  updateNodeGeom(selectedNode.id, { pos: [val, pos[1], pos[2]] }, activeIndex);
                                }} decimals={3} unit="m" /></label>
                              <RangeInput 
                                {...sliderSpan(pos[0], -1, 1)}
                                value={pos[0]}
                                onChange={(v) => {
                                  const val = v;
                                  updateNodeGeom(selectedNode.id, { pos: [val, pos[1], pos[2]] }, activeIndex);
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Y Offset <SliderValue value={pos[1]} onChange={(v) => {
                                  const val = v;
                                  updateNodeGeom(selectedNode.id, { pos: [pos[0], val, pos[2]] }, activeIndex);
                                }} decimals={3} unit="m" /></label>
                              <RangeInput 
                                {...sliderSpan(pos[1], -1, 1)}
                                value={pos[1]}
                                onChange={(v) => {
                                  const val = v;
                                  updateNodeGeom(selectedNode.id, { pos: [pos[0], val, pos[2]] }, activeIndex);
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">Z Offset <SliderValue value={pos[2]} onChange={(v) => {
                                  const val = v;
                                  updateNodeGeom(selectedNode.id, { pos: [pos[0], pos[1], val] }, activeIndex);
                                }} decimals={3} unit="m" /></label>
                              <RangeInput 
                                {...sliderSpan(pos[2], -1, 1)}
                                value={pos[2]}
                                onChange={(v) => {
                                  const val = v;
                                  updateNodeGeom(selectedNode.id, { pos: [pos[0], pos[1], val] }, activeIndex);
                                }}
                                className="w-full accent-blue-500 cursor-pointer" 
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })()}

                    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
                      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
                        <span>Mass</span>
                        <DocsInfoButton tab="gravity" />
                      </h3>
                      <label className="text-xs font-medium text-slate-500 flex justify-between">Value <SliderValue value={geom.mass ?? 0} onChange={(v) => updateNodeGeom(selectedNode.id, {mass: v}, activeIndex)} decimals={2} unit="kg" min={0} max={50} /></label>
                      <RangeInput min="0" max="50" step="0.01" value={geom.mass ?? 0} onChange={(v) => updateNodeGeom(selectedNode.id, {mass: v}, activeIndex)} className="w-full accent-blue-500 cursor-pointer" />
                      
                      {(() => {
                        let volM3 = 0;
                        const sz = geom.size || [0.1, 0.1, 0.1];
                        // A capsule or cylinder written as a fromto states its
                        // length as two end points and carries no size[1], so
                        // reading the half-length straight out of size gave
                        // undefined -> NaN, and NaN <= 0 is false, so the card
                        // printed "NaN L" rather than declining to answer.
                        const ft = geom.fromto;
                        const halfLen = sz[1] ?? (ft
                          ? Math.hypot(ft[3] - ft[0], ft[4] - ft[1], ft[5] - ft[2]) / 2
                          : undefined);
                        if (geom.type === 'sphere') {
                          volM3 = (4 / 3) * Math.PI * Math.pow(sz[0], 3);
                        } else if (geom.type === 'cylinder') {
                          volM3 = Math.PI * Math.pow(sz[0], 2) * ((halfLen ?? 0) * 2);
                        } else if (geom.type === 'capsule') {
                          volM3 = (4 / 3) * Math.PI * Math.pow(sz[0], 3) + Math.PI * Math.pow(sz[0], 2) * ((halfLen ?? 0) * 2);
                        } else if (geom.type === 'box') {
                          volM3 = 8 * sz[0] * (sz[1] ?? sz[0]) * (sz[2] ?? sz[0]);
                        } else if (geom.type === 'ellipsoid') {
                          volM3 = (4 / 3) * Math.PI * sz[0] * (sz[1] ?? sz[0]) * (sz[2] ?? sz[0]);
                        }
                        if (!(volM3 > 0) || !Number.isFinite(volM3)) return null;
                        const m = geom.mass ?? 0;
                        const objDensity = m / volM3;
                        const gAbs = Math.abs(gravityZ);
                        // Against the ambient medium set in Environment.
                        const buoyancyN = density * volM3 * gAbs;
                        const weightN = m * gAbs;
                        const status = buoyancyN > weightN * 1.02 ? 'floats' : buoyancyN < weightN * 0.98 ? 'sinks' : 'neutral';

                        return (
                          <div className="pt-2 border-t border-slate-100 flex flex-col gap-1 text-[11px] text-slate-600">
                            <div className="flex justify-between items-center font-mono text-[10px]">
                              <span>Volume:</span>
                              <span>{(volM3 * 1000).toFixed(2)} L ({(volM3 * 1e6).toFixed(0)} cm³)</span>
                            </div>
                            <div className="flex justify-between items-center font-mono text-[10px]">
                              <span>Object Density:</span>
                              <span className="font-bold">{objDensity.toFixed(0)} kg/m³</span>
                            </div>
                            {density > 0 && (
                              <>
                                <div className="flex justify-between items-center font-mono text-[10px] text-slate-500">
                                  <span>Buoyancy / Weight @ {density.toFixed(2)} kg/m³:</span>
                                  <span>{buoyancyN.toFixed(2)}N / {weightN.toFixed(2)}N</span>
                                </div>
                                <div className="flex justify-between items-center mt-0.5">
                                  <span className="font-semibold text-slate-500 text-[10px]">Fluid Status:</span>
                                  {status === 'floats' && <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 font-bold text-[10px]">🟢 FLOATS (F_b &gt; W)</span>}
                                  {status === 'sinks' && <span className="px-1.5 py-0.5 rounded bg-rose-100 text-rose-800 font-bold text-[10px]">🔴 SINKS (W &gt; F_b)</span>}
                                  {status === 'neutral' && <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-bold text-[10px]">🟡 NEUTRAL (F_b ≈ W)</span>}
                                </div>
                              </>
                            )}
                          </div>
                        );
                      })()}
                    </div>

                    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
                      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
                        <span className="flex items-center gap-1">💥 Collision Physics</span>
                        <DocsInfoButton tab="collision" />
                      </h3>
                      <label className="text-xs font-semibold text-slate-500 flex items-center gap-2 cursor-pointer py-1">
                        <input 
                          type="checkbox" 
                          checked={geom.contype !== 0 && geom.conaffinity !== 0}
                          onChange={(e) => {
                            const enabled = e.target.checked;
                            updateNodeGeom(selectedNode.id, {
                              contype: enabled ? 1 : 0,
                              conaffinity: enabled ? 1 : 0
                            }, activeIndex);
                          }}
                          className="w-4 h-4 rounded text-blue-500 focus:ring-blue-400 accent-blue-500 cursor-pointer"
                        />
                        Enable Collisions
                      </label>
                    </div>

                    {/* Material Properties Card */}
                    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-3">
                      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
                        <span className="flex items-center gap-1">🧪 Physical Material</span>
                        <DocsInfoButton tab="material" />
                      </h3>

                      {/* Contact spring timeconst — solref[0] */}
                      {(() => {
                        const val = geom.solref ? Math.max(0.001, geom.solref[0]) : 0.02;
                        return (
                          <div className="flex flex-col gap-1.5">
                            <label className="text-xs font-semibold text-slate-500 flex justify-between">
                              Contact Stiffness <span className="text-[10px] font-normal text-slate-400">solref[0]</span>
                              <span className="text-blue-600 font-bold">{val.toFixed(3)}s</span>
                            </label>
                            <RangeInput min="0.001" max="0.1" step="0.001" className="w-full accent-blue-500 cursor-pointer"
                              value={val}
                              onChange={(v) => {
                                const sr = geom.solref ? [...geom.solref] : [0.02, 1.0];
                                sr[0] = v;
                                updateNodeGeom(selectedNode.id, { solref: sr as [number,number] }, activeIndex);
                              }}
                            />
                            <span className="text-[10px] text-slate-400 leading-tight">Time constant of the contact spring. Lower = stiffer contact. Keep ≥ 5× timestep (0.005s) to avoid instability.</span>
                          </div>
                        );
                      })()}

                      {/* Damping ratio — solref[1] */}
                      {(() => {
                        const val = geom.solref ? Math.max(0, Math.min(1, geom.solref[1])) : 1.0;
                        return (
                          <div className="flex flex-col gap-1.5 mt-1 border-t border-slate-100 pt-2">
                            <label className="text-xs font-semibold text-slate-500 flex justify-between">
                              Damping Ratio (Bounciness) <span className="text-[10px] font-normal text-slate-400">solref[1]</span>
                              <span className="text-blue-600 font-bold">{val.toFixed(2)}</span>
                            </label>
                            <RangeInput min="0.0" max="1.0" step="0.01" className="w-full accent-blue-500 cursor-pointer"
                              value={val}
                              onChange={(v) => {
                                const dr = v;
                                const sr = geom.solref ? [...geom.solref] : [0.02, 1.0];
                                sr[1] = dr;
                                updateNodeGeom(selectedNode.id, {
                                  solref: sr as [number,number],
                                  solimp: [0.99, 0.9999, 0.0001, 0.5, 2]
                                }, activeIndex);
                              }}
                            />
                            <span className="text-[10px] text-slate-400 leading-tight">0 = max bounce (underdamped). 1 = no bounce (critically damped). ~0.2 gives lively bouncing.</span>
                          </div>
                        );
                      })()}

                      {/* Contact impedance — solimp[0] */}
                      {(() => {
                        const val = geom.solimp ? geom.solimp[0] : 0.99;
                        return (
                          <div className="flex flex-col gap-1.5 mt-1 border-t border-slate-100 pt-2">
                            <label className="text-xs font-semibold text-slate-500 flex justify-between">
                              Contact Impedance <span className="text-[10px] font-normal text-slate-400">solimp[0]</span>
                              <span className="text-blue-600 font-bold">{val.toFixed(3)}</span>
                            </label>
                            <RangeInput min="0.8" max="0.9999" step="0.001" className="w-full accent-blue-500 cursor-pointer"
                              value={val}
                              onChange={(v) => {
                                const si = geom.solimp ? [...geom.solimp] : [0.99, 0.9999, 0.0001, 0.5, 2];
                                si[0] = v;
                                updateNodeGeom(selectedNode.id, { solimp: si }, activeIndex);
                              }}
                            />
                            <span className="text-[10px] text-slate-400 leading-tight">Controls how much the contact force can deviate from ideal. Higher = harder, less penetration.</span>
                          </div>
                        );
                      })()}

                      {/* Friction Sliders */}
                      {(() => {
                        const fr = geom.friction ?? [0.7, 0.005, 0.0001];
                        return (
                          <div className="flex flex-col gap-2 mt-1 border-t border-slate-100 pt-2">
                            {[
                              { label: 'Sliding Friction', key: 0, min: 0, max: 2, step: 0.01, hint: 'Tangential friction. High = rubbery, low = icy.' },
                              { label: 'Torsional Friction', key: 1, min: 0, max: 0.05, step: 0.001, hint: 'Spin friction around the contact normal.' },
                              { label: 'Rolling Friction', key: 2, min: 0, max: 0.01, step: 0.0001, hint: 'Resistance to rolling. Keeps balls from rolling forever.' },
                            ].map(({ label, key, min, max, step, hint }) => (
                              <div key={key} className="flex flex-col gap-1.5">
                                <label className="text-xs font-semibold text-slate-500 flex justify-between">
                                  {label} <span className="text-[10px] font-normal text-slate-400">friction[{key}]</span>
                                  <span className="text-blue-600 font-bold">{fr[key].toFixed(key === 2 ? 4 : 3)}</span>
                                </label>
                                <RangeInput min={min} max={max} step={step} className="w-full accent-blue-500 cursor-pointer"
                                  value={fr[key]}
                                  onChange={(v) => {
                                    const newFr = [...fr] as [number,number,number];
                                    newFr[key] = v;
                                    updateNodeGeom(selectedNode.id, { friction: newFr }, activeIndex);
                                  }}
                                />
                                <span className="text-[10px] text-slate-400 leading-tight">{hint}</span>
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                    </div>

                    {/* Joint Mechanical Coupling Configuration */}
                    {selectedNode.joints && selectedNode.joints.length > 0 && (
                      <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2.5">
                        <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
                          <span className="flex items-center gap-1">⚙️ Mechanical Coupling</span>
                          <DocsInfoButton tab="coupling" />
                        </h3>

                        <label className="text-xs font-semibold text-slate-500 flex items-center gap-2 cursor-pointer py-1">
                          <input 
                            type="checkbox" 
                            checked={selectedNode.allowCoupling !== false}
                            onChange={(e) => {
                              const enabled = e.target.checked;
                              const newScene = cloneSceneGraph(sceneGraph);
                              const traverse = (nodes: SceneNode[]) => {
                                if (!nodes) return false;
                                for (const node of nodes) {
                                  if (node.id === selectedNode.id) {
                                    node.allowCoupling = enabled;
                                    return true;
                                  }
                                  if (traverse(node.children)) return true;
                                }
                                return false;
                              };
                              traverse(newScene.nodes);
                              updateScene(newScene);
                            }}
                            className="w-4 h-4 rounded text-blue-500 focus:ring-blue-400 accent-blue-500 cursor-pointer"
                          />
                          Enable Coupling
                        </label>

                        {selectedNode.allowCoupling !== false && (() => {
                          // Gather list of other jointed nodes in the scene
                          const list: SceneNode[] = [];
                          const traverse = (items: SceneNode[]) => {
                            for (const item of items) {
                              if (item.id !== selectedNode.id && item.joints && item.joints.length > 0) {
                                list.push(item);
                              }
                              if (item.children) {
                                traverse(item.children);
                              }
                            }
                          };
                          traverse(sceneGraph.nodes);

                          return (
                            <div className="flex flex-col gap-2 mt-1 border-t border-slate-100 pt-2">
                              <div className="flex flex-col gap-1">
                                <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Couple Target Component</span>
                                <select
                                  value={selectedNode.coupleTargetId || ''}
                                  onChange={(e) => {
                                    const val = e.target.value || undefined;
                                    const newScene = cloneSceneGraph(sceneGraph);
                                    const traverse2 = (nodes: SceneNode[]) => {
                                      if (!nodes) return false;
                                      for (const node of nodes) {
                                        if (node.id === selectedNode.id) {
                                          node.coupleTargetId = val;
                                          // Default ratio depending on type if target selected and no custom ratio set
                                          if (val && node.coupleRatio === undefined) {
                                            node.coupleRatio = val.includes('rack') || selectedNode.id.includes('rack') ? 0.2 : -1.0;
                                          }
                                          return true;
                                        }
                                        if (traverse2(node.children)) return true;
                                      }
                                      return false;
                                    };
                                    traverse2(newScene.nodes);
                                    updateScene(newScene);
                                  }}
                                  className="w-full px-2 py-1.5 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500 cursor-pointer"
                                >
                                  <option value="">[Auto Proximity Fallback]</option>
                                  {list.map(node => (
                                    <option key={node.id} value={node.id}>
                                      {node.name || node.id} ({node.joints[0].type})
                                    </option>
                                  ))}
                                </select>
                              </div>

                              {selectedNode.coupleTargetId && (
                                <div className="flex flex-col gap-1">
                                  <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Coupling Ratio</span>
                                  <div className="flex gap-1.5 items-center">
                                    <select
                                      value={
                                        selectedNode.coupleRatio === -1.0 ? 'gear' :
                                        selectedNode.coupleRatio === 0.2 ? 'pinion_rack' :
                                        selectedNode.coupleRatio === 1.0 ? 'direct' :
                                        'custom'
                                      }
                                      onChange={(e) => {
                                        const type = e.target.value;
                                        let ratio = -1.0;
                                        if (type === 'gear') ratio = -1.0;
                                        else if (type === 'pinion_rack') ratio = 0.2;
                                        else if (type === 'direct') ratio = 1.0;
                                        else ratio = selectedNode.coupleRatio !== undefined ? selectedNode.coupleRatio : -1.0;

                                        const newScene = cloneSceneGraph(sceneGraph);
                                        const traverse2 = (nodes: SceneNode[]) => {
                                          if (!nodes) return false;
                                          for (const node of nodes) {
                                            if (node.id === selectedNode.id) {
                                              node.coupleRatio = ratio;
                                              return true;
                                            }
                                            if (traverse2(node.children)) return true;
                                          }
                                          return false;
                                        };
                                        traverse2(newScene.nodes);
                                        updateScene(newScene);
                                      }}
                                      className="px-2 py-1.5 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500 cursor-pointer flex-1"
                                    >
                                      <option value="gear">Gears meshing (-1.0)</option>
                                      <option value="pinion_rack">Rack & Pinion (0.2)</option>
                                      <option value="direct">Direct link (1.0)</option>
                                      <option value="custom">Custom Ratio...</option>
                                    </select>

                                    <SettledNumberInput
                                      step="0.05"
                                      value={selectedNode.coupleRatio !== undefined ? selectedNode.coupleRatio : -1.0}
                                      onChange={(val) => {
                                        const newScene = cloneSceneGraph(sceneGraph);
                                        const traverse2 = (nodes: SceneNode[]) => {
                                          if (!nodes) return false;
                                          for (const node of nodes) {
                                            if (node.id === selectedNode.id) {
                                              node.coupleRatio = val;
                                              return true;
                                            }
                                            if (traverse2(node.children)) return true;
                                          }
                                          return false;
                                        };
                                        traverse2(newScene.nodes);
                                        updateScene(newScene);
                                      }}
                                      className="w-16 px-1.5 py-1.5 border border-slate-200 rounded text-xs text-center font-mono outline-none focus:border-blue-500"
                                      title="Custom gear coupling ratio"
                                    />
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    )}

                    {(() => {
                      const rgba = geom.rgba || [0.5, 0.5, 0.5, 1];
                      const rHex = Math.floor((rgba[0] ?? 0.5) * 255).toString(16).padStart(2, '0');
                      const gHex = Math.floor((rgba[1] ?? 0.5) * 255).toString(16).padStart(2, '0');
                      const bHex = Math.floor((rgba[2] ?? 0.5) * 255).toString(16).padStart(2, '0');
                      return (
                        <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
                          <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1">Appearance</h3>
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-slate-500">Color (RGB)</span>
                            <input type="color" value={`#${rHex}${gHex}${bHex}`} 
                              onChange={(e) => {
                                const hex = e.target.value;
                                const r = parseInt(hex.slice(1,3), 16)/255;
                                const g = parseInt(hex.slice(3,5), 16)/255;
                                const b = parseInt(hex.slice(5,7), 16)/255;
                                // Keep the alpha: picking a colour must not
                                // silently turn a pane of glass back into a wall.
                                updateNodeGeom(selectedNode.id, {rgba: [r, g, b, rgba[3] ?? 1]}, activeIndex);
                              }} 
                              className="w-8 h-8 rounded cursor-pointer border-0 p-0 shadow-sm" 
                            />
                          </div>
                          <label className="text-xs font-medium text-slate-500 flex justify-between mt-1">
                            Opacity <span>{Math.round((rgba[3] ?? 1) * 100)}%</span>
                          </label>
                          <RangeInput min="0" max="1" step="0.01" value={rgba[3] ?? 1}
                            onChange={(v) => updateNodeGeom(
                              selectedNode.id,
                              {rgba: [rgba[0] ?? 0.5, rgba[1] ?? 0.5, rgba[2] ?? 0.5, v]},
                              activeIndex,
                            )}
                            className="w-full accent-blue-500 cursor-pointer"
                          />
                        </div>
                      );
                    })()}
                  </div>
                );
              })()}

              {/* Constraints — welding one body to another, and what it takes to
                  shear it off again. Both the weld itself and the break
                  thresholds were reachable only over MCP before this. */}
              {(() => {
                // A body cannot be welded to itself or to anything hanging off
                // it: MuJoCo's equality would be fighting the body hierarchy
                // that already holds them together.
                const excluded = new Set<string>();
                const markSubtree = (n: SceneNode) => {
                  excluded.add(n.id);
                  (n.children || []).forEach(markSubtree);
                };
                markSubtree(selectedNode);

                const candidates: SceneNode[] = [];
                const collect = (nodes: SceneNode[]) => {
                  for (const n of nodes || []) {
                    if (!excluded.has(n.id)) candidates.push(n);
                    collect(n.children || []);
                  }
                };
                collect(sceneGraph.nodes);
                if (candidates.length === 0) return null;

                const welded = !!selectedNode.weldTargetId;
                const breakable = isBreakable(selectedNode);
                const key = welded ? weldKey(selectedNode.id, selectedNode.weldTargetId!) : '';
                const isBroken = welded && brokenConstraints.includes(key);
                const breakInfo = isBroken && lastBreak?.key === key ? lastBreak : null;
                const targetName = candidates.find((c) => c.id === selectedNode.weldTargetId)?.name;

                return (
                  <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
                    <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
                      <Link2 className="w-3.5 h-3.5 text-indigo-500" /> Constraints
                      {isBroken && <span className="ml-auto text-[10px] font-semibold text-amber-600">broken</span>}
                    </h3>

                    <label className="text-[10px] font-medium text-slate-500">Welded to</label>
                    <select
                      value={selectedNode.weldTargetId || ''}
                      onChange={(e) => updateNode(selectedNode.id, { weldTargetId: e.target.value || undefined })}
                      className="w-full px-2.5 py-1.5 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500 cursor-pointer font-medium"
                      title="Holds this body rigidly to another one, wherever the two happen to be. Use it to fix a handle to a mug or a leg to a table."
                    >
                      <option value="">— not welded —</option>
                      {candidates.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>

                    <label className="text-[10px] font-medium text-slate-500 mt-1">Pinned to (ball joint)</label>
                    <select
                      value={selectedNode.connectTargetId || ''}
                      onChange={(e) => updateNode(selectedNode.id, { connectTargetId: e.target.value || undefined })}
                      className="w-full px-2.5 py-1.5 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500 cursor-pointer font-medium"
                      title="Holds one point of this body to another body, but lets it swivel about that point — a pin rather than a weld."
                    >
                      <option value="">— not pinned —</option>
                      {candidates.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>

                    {welded && (
                      <>
                        <label className="flex items-center gap-2 text-xs text-slate-700 mt-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={breakable}
                            onChange={(e) => updateNode(selectedNode.id, e.target.checked
                              ? { weldBreakForceN: 100, weldBreakHoldSteps: DEFAULT_HOLD_STEPS }
                              : { weldBreakForceN: undefined, weldBreakTorqueNm: undefined, weldBreakHoldSteps: undefined })}
                            className="accent-indigo-500 cursor-pointer"
                          />
                          This weld can shear off
                        </label>

                        {breakable && (
                          <>
                            <div className="flex items-center gap-2">
                              <label className="text-[10px] text-slate-500 w-20 shrink-0">Pull limit</label>
                              <SettledNumberInput
                                step="10"
                                min={0}
                                value={selectedNode.weldBreakForceN ?? 0}
                                onChange={(v) => updateNode(selectedNode.id, { weldBreakForceN: v })}
                                className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500"
                              />
                              <span className="text-[10px] text-slate-400 w-8 shrink-0">N</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <label className="text-[10px] text-slate-500 w-20 shrink-0">Twist limit</label>
                              <SettledNumberInput
                                step="1"
                                min={0}
                                value={selectedNode.weldBreakTorqueNm ?? 0}
                                onChange={(v) => updateNode(selectedNode.id, { weldBreakTorqueNm: v || undefined })}
                                className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500"
                                placeholder="none"
                              />
                              <span className="text-[10px] text-slate-400 w-8 shrink-0">N·m</span>
                            </div>
                            <p className="text-[10px] text-slate-400 leading-snug">
                              A 1 kg body hanging off this weld pulls about 10 N, so a few
                              hundred is a sturdy joint and a few tens is a decorative one.
                              Leave a limit at zero to ignore it. Breaking is part of the
                              run, not an edit — the part is still welded on in the saved
                              scene, and Reset puts it back.
                            </p>
                          </>
                        )}

                        {isBroken && (
                          <div className="flex items-center gap-2 text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 leading-snug">
                            <Unlink className="w-3 h-3 shrink-0" />
                            <span className="flex-1">
                              {breakInfo
                                ? `Sheared off ${targetName ? `from ${targetName} ` : ''}at ${breakInfo.time.toFixed(2)} s, carrying ${breakInfo.forceN.toFixed(0)} N.`
                                : 'This weld has sheared off.'}
                            </span>
                            <button
                              onClick={() => restoreConstraint(key)}
                              className="shrink-0 px-1.5 py-0.5 rounded border border-amber-300 hover:bg-amber-100 font-medium"
                            >
                              Restore
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })()}

              {/* Deformation — what this body does when it is hit hard: break
                  into pieces, take a dent, both or neither. A material fills in
                  numbers that belong together; see utils/deformMaterials.ts.
                  Shattering is per body and denting per geom, so the card
                  works on the one geom a dent would be made in. */}
              {(() => {
                // Offered on primitives too. A dent moves vertices and a
                // fracture cuts them, and a primitive has none, so turning
                // either on converts the shape into the mesh it already looked
                // like — see utils/dentMesh.ts. A plane is the one thing that
                // cannot be converted; it is infinite in the solver.
                const candidates = (selectedNode.geoms || []).filter(
                  (g) => isDentable(g) || needsConversionForDenting(g),
                );
                if (candidates.length === 0) return null;
                const geom = candidates.find((g) => (g.dentYieldNs ?? 0) > 0) ?? candidates[0];
                const gi = (selectedNode.geoms || []).indexOf(geom);
                const willConvert = needsConversionForDenting(geom);
                const nodeId = selectedNode.id;

                const shatterOn = typeof selectedNode.shatterImpulseNs === 'number' && selectedNode.shatterImpulseNs > 0;
                const dentOn = typeof geom.dentYieldNs === 'number' && geom.dentYieldNs > 0;
                const material = deformMaterial(selectedNode.deformMaterial);
                const movable = (selectedNode.joints || []).length > 0;
                const inPieces = !!shatteredBodies[nodeId];
                const info = lastShatter?.nodeId === nodeId ? lastShatter : null;
                const marks = dents[`${nodeId}/${geom.name}`];
                const massKg = estimateBodyMass(selectedNode);

                // Any number changed by hand means the body is no longer the
                // material the dropdown names.
                const markCustom = () => {
                  if (selectedNode.deformMaterial && selectedNode.deformMaterial !== 'custom') {
                    updateNode(nodeId, { deformMaterial: 'custom' });
                  }
                };
                const tuneNode = (u: Partial<SceneNode>) => {
                  updateNode(nodeId, selectedNode.deformMaterial ? { ...u, deformMaterial: 'custom' } : u);
                };
                const tuneGeom = (u: Partial<SceneGeom>) => {
                  updateNodeGeom(nodeId, u, gi);
                  markCustom();
                };

                const setShatter = (on: boolean) => {
                  if (!on) { updateNode(nodeId, { shatterImpulseNs: undefined }); return; }
                  if (willConvert) makeDentable(nodeId, gi, {});
                  updateNode(nodeId, shatterFields(material?.shatter ?? CUSTOM_SHATTER, massKg));
                };
                const setDent = (on: boolean) => {
                  if (on) makeDentable(nodeId, gi, dentFields(material?.dent ?? CUSTOM_DENT));
                  else updateNodeGeom(nodeId, { dentYieldNs: undefined }, gi);
                };
                const pickMaterial = (id: string) => {
                  const m = deformMaterial(id);
                  if (!m) { updateNode(nodeId, { deformMaterial: id === 'custom' ? 'custom' : undefined }); return; }
                  const r = materialUpdates(selectedNode, m, { shatter: shatterOn, dent: dentOn });
                  for (const [i, u] of Object.entries(r.geoms)) updateNodeGeom(nodeId, u, Number(i));
                  if (r.dent) makeDentable(nodeId, gi, dentFields(m.dent!));
                  else {
                    if (dentOn) updateNodeGeom(nodeId, { dentYieldNs: undefined }, gi);
                    if (r.shatter && willConvert) makeDentable(nodeId, gi, {});
                  }
                  updateNode(nodeId, r.node);
                };

                const breakSpeed = shatterOn && massKg > 0 ? selectedNode.shatterImpulseNs! / massKg : null;

                return (
                  <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
                    <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
                      <Hammer className="w-3.5 h-3.5 text-amber-600" /> Deformation
                      {(inPieces || marks) && (
                        <span className="ml-auto text-[10px] font-semibold text-rose-600">
                          {inPieces
                            ? 'in pieces'
                            : marks!.holes ? `${marks!.holes} hole${marks!.holes === 1 ? '' : 's'}` : `${marks!.count} dent${marks!.count === 1 ? '' : 's'}`}
                        </span>
                      )}
                    </h3>

                    <div className="flex items-center gap-2">
                      <label className="text-[10px] text-slate-500 w-20 shrink-0">Material</label>
                      <select
                        value={material?.id ?? 'custom'}
                        onChange={(e) => pickMaterial(e.target.value)}
                        className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500 cursor-pointer"
                        title="Fills in the numbers below, and the density, so the body weighs what it is made of."
                      >
                        <option value="custom">Custom</option>
                        {DEFORM_MATERIALS.map((m) => (
                          <option key={m.id} value={m.id}>{m.label}</option>
                        ))}
                      </select>
                    </div>
                    {material && (
                      <p className="text-[10px] text-slate-400 leading-snug">{material.note}</p>
                    )}

                    {willConvert && !shatterOn && !dentOn && (
                      <p className="text-[10px] text-slate-400 leading-snug">
                        A {geom.type} has no vertices to break or push in. Turning either on
                        below rebuilds it as the mesh it already looks like.
                      </p>
                    )}

                    {/* ---- Shattering ---- */}
                    <label
                      className={`flex items-center gap-2 text-xs cursor-pointer ${material && !material.shatter ? 'text-slate-400' : 'text-slate-700'}`}
                      title={material && !material.shatter ? `${material.label} does not shatter. Choose Custom to make it.` : undefined}
                    >
                      <input
                        type="checkbox"
                        checked={shatterOn}
                        disabled={!!material && !material.shatter}
                        onChange={(e) => setShatter(e.target.checked)}
                        className="accent-rose-500 cursor-pointer disabled:cursor-not-allowed"
                      />
                      <Sparkles className="w-3 h-3 text-rose-500" /> Shatters
                    </label>

                    {shatterOn && !movable && (
                      <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 leading-snug">
                        This body is fixed in place, so nothing can hit it hard enough to
                        matter. Give it a joint under Body &amp; Joints to let it be struck.
                      </p>
                    )}

                    {shatterOn && (
                      <div className="flex flex-col gap-2 pl-5">
                        <div className="flex items-center gap-2">
                          <label className="text-[10px] text-slate-500 w-20 shrink-0">Breaks at</label>
                          <SettledNumberInput
                            step="0.5"
                            min={0}
                            value={selectedNode.shatterImpulseNs ?? 0}
                            onChange={(v) => tuneNode({ shatterImpulseNs: v })}
                            className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500"
                          />
                          <span className="text-[10px] text-slate-400 w-8 shrink-0">N·s</span>
                        </div>
                        {breakSpeed !== null && (
                          <p className="text-[10px] text-slate-400 leading-snug -mt-1">
                            A {(massKg * 1000 < 1000 ? `${Math.round(massKg * 1000)} g` : `${massKg.toFixed(1)} kg`)} body
                            stopped from {breakSpeed.toFixed(1)} m/s — a drop of
                            about {(breakSpeed * breakSpeed / 19.62 * 100).toFixed(0)} cm onto something hard
                            {selectedNode.shatterThicknessRef
                              ? `, where the wall is ${+(selectedNode.shatterThicknessRef * 1000).toFixed(1)} mm. Thinner breaks sooner: half that wall, half the blow.`
                              : '.'}
                          </p>
                        )}
                        <div className="flex items-center gap-2">
                          <label className="text-[10px] text-slate-500 w-20 shrink-0">Rated wall</label>
                          <SettledNumberInput
                            step="1" min={0}
                            value={+((selectedNode.shatterThicknessRef ?? 0) * 1000).toFixed(1)}
                            onChange={(v) => tuneNode({ shatterThicknessRef: v > 0 ? v / 1000 : undefined })}
                            className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500"
                            placeholder="any"
                            title="The wall thickness the number above is for. Hit somewhere thinner and it breaks sooner; thicker, and it takes more (up to three times). Measured where the blow lands. Zero: thickness does not matter."
                          />
                          <span className="text-[10px] text-slate-400 w-8 shrink-0">mm</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <label className="text-[10px] text-slate-500 w-20 shrink-0">Pieces</label>
                          <input
                            type="range" min={2} max={24} step={1}
                            value={selectedNode.shatterPieces ?? 8}
                            onChange={(e) => tuneNode({ shatterPieces: parseInt(e.target.value, 10) })}
                            className="flex-1 accent-rose-500 cursor-pointer"
                          />
                          <span className="text-[10px] text-slate-500 w-8 shrink-0 text-right">{selectedNode.shatterPieces ?? 8}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <label className="text-[10px] text-slate-500 w-20 shrink-0">Pattern</label>
                          <select
                            value={selectedNode.shatterPattern ?? 'radial'}
                            onChange={(e) => tuneNode({ shatterPattern: e.target.value as 'uniform' | 'radial' })}
                            className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500 cursor-pointer"
                            title="Radial crowds the small pieces around the point of impact, which is what really happens and what reads as a blow."
                          >
                            <option value="radial">Around the impact</option>
                            <option value="uniform">Evenly</option>
                          </select>
                        </div>
                        <div className="flex items-center gap-2">
                          <label className="text-[10px] text-slate-500 w-20 shrink-0">Pieces break</label>
                          <select
                            value={selectedNode.shatterDepth ?? 0}
                            onChange={(e) => tuneNode({ shatterDepth: parseInt(e.target.value, 10) || undefined })}
                            className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500 cursor-pointer"
                            title="Whether the pieces can break again when they land. Each generation multiplies the body count and every break rebuilds the model, so a scene set to cascade will hitch its way down."
                          >
                            <option value={0}>Not again</option>
                            <option value={1}>Once more</option>
                            <option value={2}>Twice more</option>
                          </select>
                        </div>
                        <div className="flex items-center gap-2">
                          <label className="text-[10px] text-slate-500 w-20 shrink-0">Scatter</label>
                          <SettledNumberInput
                            step="0.1"
                            min={0}
                            value={selectedNode.shatterSpread ?? 0}
                            onChange={(v) => tuneNode({ shatterSpread: v || undefined })}
                            className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500"
                          />
                          <span className="text-[10px] text-slate-400 w-8 shrink-0">m/s</span>
                        </div>
                        {info && (
                          <div className="flex items-center gap-2 text-[10px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1 leading-snug">
                            <span className="flex-1">
                              Broke into {info.pieces} pieces at {info.time.toFixed(2)} s, taking {info.impulseNs.toFixed(1)} N·s{info.wallM !== undefined ? ` where the wall is ${(info.wallM * 1000).toFixed(1)} mm` : ''}. Reset makes it whole.
                            </span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* ---- Denting ---- */}
                    <label
                      className={`flex items-center gap-2 text-xs cursor-pointer ${material && !material.dent ? 'text-slate-400' : 'text-slate-700'}`}
                      title={material && !material.dent ? `${material.label} does not dent. Choose Custom to make it.` : undefined}
                    >
                      <input
                        type="checkbox"
                        checked={dentOn}
                        disabled={!!material && !material.dent}
                        onChange={(e) => setDent(e.target.checked)}
                        className="accent-amber-500 cursor-pointer disabled:cursor-not-allowed"
                      />
                      <Hammer className="w-3 h-3 text-amber-600" /> Dents
                    </label>

                    {dentOn && (
                      <div className="flex flex-col gap-2 pl-5">
                        <div className="flex items-center gap-2">
                          <label className="text-[10px] text-slate-500 w-20 shrink-0">Yields at</label>
                          <SettledNumberInput
                            step="0.5" min={0}
                            value={geom.dentYieldNs ?? 0}
                            onChange={(v) => tuneGeom({ dentYieldNs: v })}
                            className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500"
                          />
                          <span className="text-[10px] text-slate-400 w-8 shrink-0">N·s</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <label className="text-[10px] text-slate-500 w-20 shrink-0">Deepest</label>
                          <SettledNumberInput
                            step="1" min={0}
                            value={Math.round((geom.dentMaxDepth ?? 0.02) * 1000)}
                            onChange={(v) => tuneGeom({ dentMaxDepth: v / 1000 })}
                            className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500"
                          />
                          <span className="text-[10px] text-slate-400 w-8 shrink-0">mm</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <label className="text-[10px] text-slate-500 w-20 shrink-0">Pierces at</label>
                          <SettledNumberInput
                            step="1" min={0}
                            value={geom.pierceImpulseNs ?? 0}
                            onChange={(v) => tuneGeom({ pierceImpulseNs: v || undefined })}
                            className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500"
                            placeholder="never"
                            title="Above this the surface is holed rather than dented: the material under the striker is gone, not pushed aside. Leave at zero and it can never be pierced."
                          />
                          <span className="text-[10px] text-slate-400 w-8 shrink-0">N·s</span>
                        </div>
                        {(geom.pierceImpulseNs ?? 0) > 0 && (geom.pierceImpulseNs ?? 0) <= (geom.dentYieldNs ?? 0) * 1.5 && (
                          <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 leading-snug">
                            Piercing this close to the yield leaves almost no range in which this
                            behaves like a sheet — nearly everything that marks it will go through.
                          </p>
                        )}
                        <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer mt-1">
                          <input
                            type="checkbox"
                            checked={!!geom.deformCollision}
                            onChange={(e) => updateNodeGeom(nodeId,
                              { deformCollision: e.target.checked || undefined }, gi)}
                            className="accent-amber-500 cursor-pointer"
                          />
                          Damage is real, not just seen
                        </label>
                        {geom.deformCollision ? (
                          <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 leading-snug">
                            Every mark now changes what this body collides as: things fall
                            through the holes, and an edge worn away stops holding what it used
                            to. <strong>It is slow on purpose.</strong> Damage reaches the
                            solver by rebuilding the model, and the surface has to be broken
                            into convex pieces each time — a hull would fill every crater and
                            every hole straight back in. Expect a hitch per blow.
                          </p>
                        ) : (
                          <p className="text-[10px] text-slate-400 leading-snug">
                            <strong className="text-slate-500">Damage is cosmetic.</strong> The
                            surface shows the crater, but contact keeps using the undamaged
                            shape — so something can rest on the hole it just made. Tick the box
                            above to make it real, and read what that costs.
                            {marks && ` Deepest so far ${(marks.deepest * 1000).toFixed(1)} mm`}
                            {marks?.holes ? `, and holed through ${marks.holes} time${marks.holes === 1 ? '' : 's'}` : ''}
                            {marks && '.'}
                          </p>
                        )}
                      </div>
                    )}

                    {(shatterOn || dentOn) && (
                      <p className="text-[10px] text-slate-400 leading-snug">
                        Blows are measured as impulse, not force, so the number means the same
                        thing whatever the solver is doing: a 200 g body arriving at 5 m/s and
                        stopping dead is about 1 N·s.{shatterOn && dentOn && ' A blow hard enough to shatter does not also dent.'}
                      </p>
                    )}
                  </div>
                );
              })()}

              {/* Collision — how any mesh body reaches MuJoCo's contact solver.
                  A boolean body's equivalent lives in Boolean Modifiers below,
                  next to the sector and hole-axis controls it shares. */}
              {(() => {
                if (selectedNode.csgEnabled) return null;
                const meshes = solidMeshGeoms(selectedNode);
                if (meshes.length === 0) return null;

                const mode = collisionModeOf(selectedNode);
                const colliders = (selectedNode.geoms || []).filter((g) => g.csgDerived === 'collider');
                const stale = collidersAreStale(selectedNode);
                const solidity = selectedNode.collisionSolidity ?? null;

                return (
                  <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
                    <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
                      <Donut className="w-3.5 h-3.5 text-rose-500" /> Collision
                      {stale && <span className="ml-auto text-[10px] font-semibold text-amber-600 animate-pulse">working…</span>}
                    </h3>
                    <select
                      value={mode}
                      onChange={(e) => updateNode(selectedNode.id, { collision: e.target.value as SceneNode['collision'] })}
                      className="w-full px-2.5 py-1.5 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500 cursor-pointer font-medium"
                      title="MuJoCo collides a mesh as its convex hull, which fills in any hollow. Auto breaks a hollow shape into convex pieces so it behaves like the shape it looks like."
                    >
                      <option value="auto">Auto</option>
                      <option value="decompose">Convex pieces</option>
                      <option value="hull">Convex hull</option>
                    </select>
                    <p className="text-[10px] text-slate-400 leading-snug">
                      {colliders.length > 0
                        ? `Colliding as ${colliders.length} convex pieces, so anything hollow in this shape is really hollow — a ball dropped into it lands inside.`
                        : 'Colliding as one convex hull, so any hollow in this shape is filled in for contact.'}
                      {solidity !== null && ` Solidity ${(solidity * 100).toFixed(0)}% — how much of its own hull this shape actually fills.`}
                    </p>
                    {selectedNode.collisionWarning && (
                      <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 leading-snug">{selectedNode.collisionWarning}</p>
                    )}
                    {selectedNode.collisionError && (
                      <p className="text-[10px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1 leading-snug">Collision failed: {selectedNode.collisionError}</p>
                    )}
                  </div>
                );
              })()}

              <EdgesCard node={selectedNode} />

              {/* Boolean Modifiers (CSG) — subtract/intersect one primitive with another */}
              {(() => {
                const source = csgSourceGeoms(selectedNode);
                const solids = source.filter((g) => g.type !== 'plane');
                const ops = source.filter((g) => g.csg === 'difference' || g.csg === 'intersection');
                const isCsg = !!selectedNode.csgEnabled && ops.length > 0;
                // Offered on anything with a solid to cut into — OpenSCAD and
                // imported parts included: Cut makes a hole in any of them.
                if (!isCsg && (solids.length === 0 || selectedNode.isCurve || selectedNode.isPulleyRope)) return null;

                const mode = selectedNode.csgCollision ?? 'auto';
                const colliders = (selectedNode.geoms || []).filter((g) => g.csgDerived === 'collider');
                const visual = (selectedNode.geoms || []).find((g) => g.csgDerived === 'visual');
                const stale = isCsg && csgHashOf(selectedNode) !== selectedNode.csgHash;
                const effectiveMode = colliders.length > 0 ? 'decompose' : (visual ? (visual.role === 'visual' ? 'primitives' : 'hull') : null);

                return (
                  <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-3">
                    <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
                      <Donut className="w-3.5 h-3.5 text-rose-500" /> Boolean Modifiers
                      {stale && <span className="ml-auto text-[10px] font-semibold text-amber-600 animate-pulse">recompiling…</span>}
                    </h3>
                    <p className="text-[10px] text-slate-400 -mt-1 leading-snug">
                      <strong>Cut</strong> takes a shape out of this body: click the part where you want it, then pick
                      a shape. Subtracted shapes are drawn as red outlines. The list below is every shape this body is
                      made of; switching one to <strong>subtract</strong> turns it into a hole.
                    </p>

                    {/* Cut. The only way to put a shape ON a body: dragging one
                        in from the sidebar makes a CHILD BODY, whose geoms
                        belong to a different boolean program and are invisible
                        to this one — which is what the line above used to
                        advise, wrongly, for years. */}
                    <div className="flex flex-col gap-1.5 pb-1 border-b border-slate-100">
                      <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                        Cut a shape out of it
                      </label>
                      <CutControls node={selectedNode} compact />
                    </div>

                    {/* Per-geom operator */}
                    <div className="flex flex-col gap-1.5">
                      {source.map((g) => {
                        const idx = (selectedNode.geoms || []).indexOf(g);
                        return (
                          <div key={g.name || idx} className="flex items-center gap-1.5">
                            <span className={`flex-1 text-[10px] font-mono truncate ${g.csg === 'difference' ? 'text-rose-500' : 'text-slate-500'}`} title={g.name}>
                              {g.name || `Geom ${idx + 1}`} <span className="text-slate-300">· {g.type}</span>
                            </span>
                            {/* Mirrors setGeomCsgOp's guard: a body must keep at
                                least one positive shape, or there is nothing to
                                cut into and no geometry left to emit. */}
                            {(() => {
                              const otherPositives = source.filter((o, i) =>
                                i !== source.indexOf(g) && (!o.csg || o.csg === 'union')).length;
                              const canSubtract = otherPositives > 0;
                              return (
                                <select
                                  value={g.csg || 'union'}
                                  onChange={(e) => setGeomCsgOp(selectedNode.id, idx, e.target.value as CsgOp)}
                                  className="px-1.5 py-1 border border-slate-200 rounded text-[10px] bg-white text-slate-700 outline-none focus:border-blue-500 cursor-pointer font-semibold"
                                  title={canSubtract ? undefined : 'This is the body\u2019s only shape, so there is nothing for it to be cut out of. Use Cut above to take a shape out of it.'}
                                >
                                  <option value="union">＋ add</option>
                                  <option value="difference" disabled={!canSubtract}>－ subtract</option>
                                  <option value="intersection" disabled={!canSubtract}>∩ intersect</option>
                                </select>
                              );
                            })()}
                            <button
                              onClick={() => { deleteNodeGeom(selectedNode.id, idx); setActiveGeomIndex(0); }}
                              disabled={solids.length <= 1}
                              className="p-1 rounded border border-slate-200 text-slate-400 hover:text-rose-600 hover:border-rose-200 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
                              title={solids.length <= 1 ? 'A body needs at least one shape' : 'Delete this shape'}
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        );
                      })}
                    </div>

                    {isCsg && (
                      <>
                        <div className="flex flex-col gap-1 pt-1 border-t border-slate-100">
                          <label className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Collision</label>
                          <select
                            value={mode}
                            onChange={(e) => updateNode(selectedNode.id, { csgCollision: e.target.value as SceneNode['csgCollision'] })}
                            className="w-full px-2.5 py-1.5 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500 cursor-pointer font-medium"
                          >
                            <option value="auto">Auto (decompose if there is a hole axis)</option>
                            <option value="decompose">Convex sectors (holes collide)</option>
                            <option value="primitives">Source primitives (holes are solid)</option>
                            <option value="hull">Convex hull (whole shape is solid)</option>
                          </select>
                          {/* MuJoCo hulls every mesh geom, so this trade-off is
                              unavoidable and worth stating outright rather than
                              letting it surprise someone mid-experiment. */}
                          <p className="text-[10px] text-slate-400 leading-snug mt-0.5">
                            {effectiveMode === 'decompose'
                              ? `Colliding as ${colliders.length} convex sectors. The hole is real, and a peg can pass through it. Each sector spans a chord of the inner surface, so it intrudes ~${(100 * (1 - Math.cos(Math.PI / (selectedNode.csgSectors ?? CSG_DEFAULT_SECTORS)))).toFixed(1)}% of the hole radius.`
                              : effectiveMode === 'hull'
                                ? 'One mesh geom that both draws and collides. MuJoCo takes its convex hull, so every hole and dip is filled for contact.'
                                : 'The boolean mesh is visual only; the source primitives collide. Exact convex contact, but holes are solid.'}
                          </p>
                        </div>

                        {(mode === 'auto' || mode === 'decompose') && (
                          <>
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">
                                Sectors <span>{selectedNode.csgSectors ?? CSG_DEFAULT_SECTORS}</span>
                              </label>
                              <RangeInput min="4" max="48" step="1"
                                value={selectedNode.csgSectors ?? CSG_DEFAULT_SECTORS}
                                onChange={(v) => updateNode(selectedNode.id, { csgSectors: Math.round(v) })}
                                className="w-full accent-blue-500 cursor-pointer"
                              />
                            </div>
                            <div className="flex items-center justify-between gap-2">
                              <label className="text-xs font-medium text-slate-500">Hole axis</label>
                              <select
                                value={selectedNode.csgHoleAxis ?? 'auto'}
                                onChange={(e) => updateNode(selectedNode.id, { csgHoleAxis: e.target.value as SceneNode['csgHoleAxis'] })}
                                className="px-2 py-1 border border-slate-200 rounded text-[11px] bg-white text-slate-700 outline-none focus:border-blue-500 cursor-pointer font-medium"
                              >
                                <option value="auto">Auto</option>
                                <option value="x">X</option>
                                <option value="y">Y</option>
                                <option value="z">Z</option>
                              </select>
                            </div>
                          </>
                        )}

                        <div className="flex flex-col gap-1">
                          <label className="text-xs font-medium text-slate-500 flex justify-between">
                            Total mass <SliderValue value={selectedNode.csgMass ?? 1} onChange={(v) => updateNode(selectedNode.id, { csgMass: v })} decimals={3} unit="kg" min={0.01} max={20} />
                          </label>
                          <RangeInput min="0.01" max="20" step="0.01"
                            value={selectedNode.csgMass ?? 1}
                            onChange={(v) => updateNode(selectedNode.id, { csgMass: v })}
                            className="w-full accent-blue-500 cursor-pointer"
                          />
                          {/* MuJoCo would derive mass from the hull's volume, which
                              for a ring is wildly more material than there is. Show
                              both figures so the number above is a choice, not a guess. */}
                          {selectedNode.csgVolume !== undefined && (
                            <p className="text-[10px] text-slate-400 leading-snug">
                              True volume <span className="font-mono text-slate-500">{(selectedNode.csgVolume * 1e6).toFixed(1)} cm³</span>
                              {selectedNode.csgHullVolume ? <> · convex hull <span className="font-mono text-slate-500">{(selectedNode.csgHullVolume * 1e6).toFixed(1)} cm³</span></> : null}
                              {selectedNode.csgVolume > 0 && <> · density <span className="font-mono text-slate-500">{((selectedNode.csgMass ?? 1) / selectedNode.csgVolume).toFixed(0)} kg/m³</span></>}
                            </p>
                          )}
                        </div>

                        {selectedNode.csgWarning && (
                          <div className="text-[10px] text-amber-800 bg-amber-50 border border-amber-200 rounded p-1.5 leading-snug">{selectedNode.csgWarning}</div>
                        )}
                        {selectedNode.csgError && (
                          <div className="text-[10px] text-rose-800 bg-rose-50 border border-rose-200 rounded p-1.5 leading-snug">
                            <strong>Boolean failed:</strong> <span className="font-mono break-all">{selectedNode.csgError}</span>
                          </div>
                        )}

                        {visual && (
                          <div className="text-[10px] text-slate-400 font-mono">
                            {(visual.vertices?.length ?? 0) / 3} verts · {(visual.faces?.length ?? 0) / 3} tris
                            {colliders.length > 0 ? ` · ${colliders.length} colliders` : ''}
                          </div>
                        )}

                        {selectedNode.csgScad && (
                          <details className="text-[10px]">
                            <summary className="cursor-pointer text-slate-500 font-semibold select-none">Generated OpenSCAD</summary>
                            <textarea
                              readOnly
                              value={selectedNode.csgScad}
                              className="w-full h-32 mt-1.5 font-mono text-[10px] leading-relaxed p-2 bg-slate-950 text-emerald-300 rounded border border-slate-700 resize-y"
                              spellCheck={false}
                            />
                          </details>
                        )}
                      </>
                    )}
                  </div>
                );
              })()}

              {/* Mesh Properties — shown when the body or any child has a mesh geom */}
              {(() => {
                const allGeoms: (SceneGeom & { _fromChildId: string | null })[] = [];
                const collectGeoms = (node: SceneNode) => { node.geoms?.forEach((g) => allGeoms.push({...g, _fromChildId: node.id !== selectedNode.id ? node.id : null})); node.children?.forEach(collectGeoms); };
                collectGeoms(selectedNode);
                if (!allGeoms.some((g) => g.type === 'mesh')) return null;
                return (
                <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-3">
                  <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
                    <Shapes className="w-3.5 h-3.5 text-violet-500" /> Body Geoms ({allGeoms.length})
                  </h3>
                  <p className="text-[10px] text-slate-400 -mt-1 leading-snug">
                    Static mesh geoms are <strong>visual only</strong>. Primitive geoms handle physics. Dynamic meshes simulate and collide.
                  </p>
                  {allGeoms.map((g) => (
                    <div key={g.name} className="flex flex-col gap-1.5 p-2 bg-slate-50 rounded border border-slate-100">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
                          {g.name}{g._fromChildId ? <span className="text-violet-400 font-normal"> (child)</span> : null}
                        </span>
                        <span className="text-[10px] text-slate-400">
                          {g.type === 'mesh'
                            ? (g.vertices ? `mesh · ${g.vertices.length / 3} verts · ${g.faces ? g.faces.length / 3 : 0} tris${g.dynamic ? ' · dynamic' : ' · static'}` : 'mesh · no geometry')
                            : `${g.type} · size [${(g.size || []).map((s: number) => s.toFixed(2)).join(', ')}]`}
                        </span>
                      </div>
                      {g.type === 'mesh' && g.vertices && g.vertices.length > 0 && (
                        <div className="flex flex-col gap-1.5">
                          <div className="flex gap-1.5">
                            <button
                              onClick={() => {
                                if (meshEditorGeom === g.name) { setMeshEditorGeom(null); return; }
                                // The mesh arrays, named locally: this button
                                // only exists for a geom that has them (see the
                                // condition above), which a handler cannot see.
                                const verts = g.vertices!;
                                const faces = g.faces!;
                                // Format vertices as one triplet per line, faces as one triangle per line
                                const vLines = [];
                                for (let i = 0; i < verts.length; i += 3)
                                  vLines.push(`${verts[i]} ${verts[i+1]} ${verts[i+2]}`);
                                const fLines = [];
                                for (let i = 0; i < faces.length; i += 3)
                                  fLines.push(`${faces[i]} ${faces[i+1]} ${faces[i+2]}`);
                                setMeshEditorText(`# vertices (x y z, one per line, Three.js Y-up space)\n${vLines.join('\n')}\n\n# faces (i j k triangle indices, one per line)\n${fLines.join('\n')}`);
                                setMeshEditorError(null);
                                setMeshEditorGeom(g.name);
                                setMeshSimplifierGeom(null); // Close simplifier if open
                              }}
                              className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 bg-violet-50 hover:bg-violet-100 border border-violet-200 rounded text-[10px] font-semibold text-violet-700 transition-colors cursor-pointer"
                            >
                              <Code className="w-3 h-3" /> {meshEditorGeom === g.name ? 'Close Editor' : 'Edit Vertices'}
                            </button>
                            <button
                              onClick={() => {
                                if (meshSimplifierGeom === g.name) { setMeshSimplifierGeom(null); return; }
                                setMeshSimplifierGeom(g.name);
                                setMeshSimplifierError(null);
                                setMeshEditorGeom(null); // Close editor if open
                              }}
                              className={`flex items-center justify-center gap-1 px-2.5 py-1.5 border rounded text-[10px] font-semibold transition-colors cursor-pointer ${meshSimplifierGeom === g.name ? 'bg-amber-50 hover:bg-amber-100 border-amber-200 text-amber-700' : 'bg-slate-50 hover:bg-slate-100 border-slate-200 text-slate-600'}`}
                              title="Simplify mesh (reduce vertex/triangle count)"
                            >
                              <Scissors className="w-3 h-3" /> {meshSimplifierGeom === g.name ? 'Close' : 'Simplify'}
                            </button>
                            <button
                              onClick={() => {
                                // As above: this button is only rendered for a
                                // geom that has the mesh arrays.
                                const verts = g.vertices!;
                                const faces = g.faces!;
                                const unique = new Map<string, number>();
                                const newVerts: number[] = [], remap: number[] = [];
                                for (let i = 0; i < verts.length; i += 3) {
                                  const key = `${verts[i].toFixed(4)},${verts[i+1].toFixed(4)},${verts[i+2].toFixed(4)}`;
                                  if (!unique.has(key)) { unique.set(key, newVerts.length/3); newVerts.push(verts[i], verts[i+1], verts[i+2]); }
                                  remap[i/3] = unique.get(key)!;
                                }
                                const filteredFaces: number[] = [];
                                for (let i = 0; i < faces.length; i += 3) {
                                  const a=remap[faces[i]], b=remap[faces[i+1]], c=remap[faces[i+2]];
                                  if (a!==b && b!==c && a!==c) filteredFaces.push(a,b,c);
                                }
                                const newScene = cloneSceneGraph(useStore.getState().sceneGraph);
                                // A dynamic mesh is drawn from renderVertices, so they are
                                // renumbered with the rest or the new faces index old points.
                                patchGeom(newScene.nodes, g._fromChildId ?? selectedNode.id, g.name, {
                                  vertices: newVerts,
                                  faces: filteredFaces,
                                  ...(g.dynamic ? { renderVertices: toRenderVertices(newVerts) } : {}),
                                });
                                useStore.getState().updateScene(newScene);
                              }}
                              className="flex items-center justify-center gap-1 px-2 py-1.5 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded text-[10px] font-semibold text-slate-600 transition-colors cursor-pointer"
                              title="Remove duplicate vertices"
                            >
                              <Minimize2 className="w-3 h-3" />
                            </button>
                            <button
                              onClick={() => downloadMeshGeomStl(g, g.name || selectedNode.name || 'mesh')}
                              className="flex items-center justify-center gap-1 px-2 py-1.5 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded text-[10px] font-semibold text-emerald-700 transition-colors cursor-pointer"
                              title="Download this geom on its own as a binary STL, in millimetres. The toolbar's STL export writes the whole scene."
                            >
                              <Download className="w-3 h-3" /> STL
                            </button>
                          </div>
                          {meshEditorGeom === g.name && (
                            <div className="flex flex-col gap-1.5">
                              <textarea
                                value={meshEditorText}
                                onChange={(e) => setMeshEditorText(e.target.value)}
                                className="w-full h-48 font-mono text-[10px] leading-relaxed p-2 bg-slate-950 text-violet-300 rounded border border-slate-700 focus:outline-none focus:ring-1 focus:ring-violet-500 resize-y"
                                spellCheck={false}
                              />
                              {meshEditorError && (
                                <div className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded p-1.5">{meshEditorError}</div>
                              )}
                              <button
                                onClick={() => {
                                  try {
                                    // Parse using the explicit # vertices / # faces section markers
                                    // Everything before the blank line / # faces comment = vertices
                                    // Everything after = faces
                                    const newVerts: number[] = [], newFaces: number[] = [];
                                    let section: 'vertices' | 'faces' = 'vertices';
                                    for (const raw of meshEditorText.split('\n')) {
                                      const line = raw.trim();
                                      if (!line) continue;
                                      if (line.startsWith('#')) {
                                        if (line.toLowerCase().includes('face')) section = 'faces';
                                        else if (line.toLowerCase().includes('vert')) section = 'vertices';
                                        continue;
                                      }
                                      const nums = line.split(/[\s,]+/).map(Number);
                                      if (nums.length !== 3 || nums.some(isNaN)) throw new Error(`Bad line: "${raw.trim()}": expected exactly 3 numbers`);
                                      if (section === 'vertices') newVerts.push(...nums);
                                      else newFaces.push(...nums);
                                    }
                                    if (newVerts.length < 9) throw new Error('Need at least 3 vertices');
                                    if (newFaces.length < 3) throw new Error('Need at least 1 face');
                                    const nv = newVerts.length / 3;
                                    const badIdx = newFaces.find(i => !Number.isInteger(i) || i < 0 || i >= nv);
                                    if (badIdx !== undefined) throw new Error(`Face index ${badIdx} out of range (0–${nv-1})`);
                                    // If this is a dynamic mesh, recompute renderVertices from the new vertices.
                                    // renderVertices = raw Z-up: Y-up (x,y,z) → Z-up (x,-z,y), no centroid subtraction.
                                    // MuJoCo recenters the mesh internally; xpos tracks the recentered frame.
                                    const newRenderVerts = g.dynamic ? toRenderVertices(newVerts) : undefined;
                                    const newScene = cloneSceneGraph(useStore.getState().sceneGraph);
                                    patchGeom(newScene.nodes, g._fromChildId ?? selectedNode.id, g.name, {
                                      vertices: newVerts,
                                      faces: newFaces,
                                      ...(newRenderVerts ? { renderVertices: newRenderVerts } : {}),
                                    });
                                    useStore.getState().updateScene(newScene);
                                    setMeshEditorError(null);
                                    setMeshEditorGeom(null);
                                  } catch (e) {
                                    setMeshEditorError((e as Error).message);
                                  }
                                }}
                                className="px-3 py-1.5 bg-violet-600 hover:bg-violet-700 text-white rounded text-[10px] font-semibold cursor-pointer transition-colors"
                              >
                                  Apply Mesh
                                </button>
                              </div>
                            )}
                            {meshSimplifierGeom === g.name && (
                              <div className="flex flex-col gap-2 p-2 bg-amber-50/50 rounded border border-amber-100 mt-1">
                                <div className="flex items-center justify-between text-[10px] font-semibold text-slate-700">
                                  <span>Target Quality:</span>
                                  <span className="font-mono text-amber-700 font-bold">{(simplifyRatio * 100).toFixed(0)}% vertices</span>
                                </div>
                                <RangeInput
                                  min="0.05"
                                  max="0.95"
                                  step="0.05"
                                  value={simplifyRatio}
                                  onChange={(v) => setSimplifyRatio(v)}
                                  className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-amber-600 focus:outline-none"
                                />
                                <div className="flex justify-between text-[8px] text-slate-400">
                                  <span>High Simplification (5% kept)</span>
                                  <span>Low Simplification (95% kept)</span>
                                </div>

                                {meshSimplifierError && (
                                  <div className="text-[9px] text-amber-800 bg-amber-100/60 border border-amber-200 rounded p-1.5 font-mono">
                                    {meshSimplifierError}
                                  </div>
                                )}

                                <div className="flex justify-end gap-1.5 mt-1">
                                  <button
                                    onClick={() => setMeshSimplifierGeom(null)}
                                    className="px-2 py-1 bg-white hover:bg-slate-50 border border-slate-200 text-[10px] text-slate-600 font-semibold rounded cursor-pointer transition-colors"
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    onClick={() => handleSimplifyMesh(g, g._fromChildId ?? selectedNode.id)}
                                    className="px-2.5 py-1 bg-amber-600 hover:bg-amber-700 text-white text-[10px] font-semibold rounded cursor-pointer shadow transition-colors flex items-center gap-1"
                                  >
                                    <Sparkles className="w-3 h-3" />
                                    Simplify Mesh
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                  ))}
                </div>
                );
              })()}

              {selectedNode.isPulleyWheel && (
                <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
                  <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1">🛞 Pulley Properties</h3>
                  <label className="text-xs font-medium text-slate-500 flex justify-between">
                    Pulley Radius <SliderValue value={selectedNode.pulleyRadius || 0.4} onChange={(v) => {
                      const radVal = v;
                      updatePulleyParams(selectedNode.id, { pulleyRadius: radVal });
                    }} decimals={2} unit="m" min={0.15} max={1.5} />
                  </label>
                  <RangeInput 
                    min="0.15" 
                    max="1.5" 
                    step="0.01" 
                    value={selectedNode.pulleyRadius || 0.4} 
                    onChange={(v) => {
                      const radVal = v;
                      updatePulleyParams(selectedNode.id, { pulleyRadius: radVal });
                    }} 
                    className="w-full accent-blue-500 cursor-pointer" 
                  />
                </div>
              )}

              {selectedNode.isPulleyRope && (
                <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-3">
                  <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
                    <span>🧵 Rope Properties</span>
                  </h3>

                  <p className="text-[10px] text-slate-400 leading-snug -mt-1">
                    Connect two bodies directly, or optionally route through a Pulley Wheel for an Atwood-style coupling.
                  </p>
                  
                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-semibold text-slate-500 flex justify-between">
                      Body A <span className="font-normal text-rose-400">required</span>
                    </label>
                    <select
                      value={selectedNode.leftTargetId || ''}
                      onChange={(e) => updateRopeParams(selectedNode.id, { leftTargetId: e.target.value })}
                      className="w-full text-xs border border-slate-200 rounded p-1.5 bg-slate-50 font-medium text-slate-700 focus:border-blue-500 outline-none"
                    >
                      <option value="">-- Select Body A --</option>
                      {allJointedNodes.map(n => (
                        <option key={n.id} value={n.id}>{n.id}</option>
                      ))}
                    </select>
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-semibold text-slate-500 flex justify-between">
                      Body B <span className="font-normal text-rose-400">required</span>
                    </label>
                    <select
                      value={selectedNode.rightTargetId || ''}
                      onChange={(e) => updateRopeParams(selectedNode.id, { rightTargetId: e.target.value })}
                      className="w-full text-xs border border-slate-200 rounded p-1.5 bg-slate-50 font-medium text-slate-700 focus:border-blue-500 outline-none"
                    >
                      <option value="">-- Select Body B --</option>
                      {allJointedNodes.map(n => (
                        <option key={n.id} value={n.id}>{n.id}</option>
                      ))}
                    </select>
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-semibold text-slate-500 flex justify-between">
                      Pulley Wheel <span className="font-normal text-slate-400">optional</span>
                    </label>
                    <select
                      value={selectedNode.pulleyWheelId || ''}
                      onChange={(e) => updateRopeParams(selectedNode.id, { pulleyWheelId: e.target.value })}
                      className="w-full text-xs border border-slate-200 rounded p-1.5 bg-slate-50 font-medium text-slate-700 focus:border-blue-500 outline-none"
                    >
                      <option value="">-- None (direct coupling) --</option>
                      {allPulleyWheels.map(wheel => (
                        <option key={wheel.id} value={wheel.id}>
                          {wheel.id} (r={( wheel.pulleyRadius || 0.4).toFixed(2)}m)
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {/* OpenSCAD Editor Card */}
              {selectedNode.scad !== undefined && (
                <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2.5">
                  <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center justify-between">
                    <span className="flex items-center gap-1.5 font-semibold text-slate-800">
                      <Settings className="w-4 h-4 text-violet-500" />
                      OpenSCAD CAD Code
                    </span>
                    <div className="flex items-center gap-1.5">
                      {isScadCompiling ? (
                        <span className="flex items-center gap-1 text-[10px] font-semibold text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-full border border-amber-100 animate-pulse">
                          Compiling...
                        </span>
                      ) : (
                        <span className="text-[10px] font-medium text-slate-400 bg-slate-50 px-1.5 py-0.5 rounded-full border border-slate-100">
                          CAD Shape
                        </span>
                      )}
                    </div>
                  </h3>

                  <p className="text-[10px] text-slate-400 -mt-1 leading-tight">
                    Write constructive solid geometry code to generate custom physics structures.
                  </p>

                  {!isCompilerReady() && (
                    <div className="text-[9px] text-violet-600 font-semibold bg-violet-50 border border-violet-100/60 p-1.5 rounded text-center leading-snug animate-pulse">
                      🌐 Loading CAD engine in background...
                    </div>
                  )}

                  {/* Templates Selector */}
                  <div className="flex items-center justify-between text-xs text-slate-500 gap-1.5 bg-slate-50 p-1.5 rounded-md border border-slate-100">
                    <span className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">Templates:</span>
                    <select
                      onChange={(e) => {
                        const templateVal = e.target.value;
                        if (templateVal === 'hollow_cube') {
                          setScadText(`// Hollow Cube\nsize = 0.6; // [0.2:0.05:1.2]\nhole_d = 0.75; // [0.3:0.05:1.5]\ndifference() {\n  cube([size, size, size], center=true);\n  sphere(d=hole_d, $fn=24);\n}`);
                        } else if (templateVal === 'wheel') {
                          setScadText(`// Wheel with Hole\nheight = 0.15; // [0.05:0.05:0.5]\nouter_r = 0.35; // [0.1:0.05:1.0]\ninner_r = 0.08; // [0.02:0.02:0.5]\ndifference() {\n  cylinder(h=height, r=outer_r, center=true, $fn=30);\n  cylinder(h=height*1.5, r=inner_r, center=true, $fn=16);\n}`);
                        } else if (templateVal === 'wedge') {
                          setScadText(`// Wedge with multiple holes\nwidth = 1.0; // [0.5:0.1:2.0]\nheight = 0.5; // [0.2:0.1:1.5]\nthickness = 0.4; // [0.1:0.1:1.0]\nhole_r = 0.08; // [0.02:0.01:0.2]\ndifference() {\n  // Base wedge block\n  linear_extrude(height=thickness, center=true)\n    polygon([[0,0], [width,0], [0,height]]);\n  \n  // Cylindrical holes\n  translate([width*0.2, height*0.2, 0])\n    cylinder(h=thickness*1.5, r=hole_r, center=true, $fn=16);\n  translate([width*0.5, height*0.3, 0])\n    cylinder(h=thickness*1.5, r=hole_r, center=true, $fn=16);\n}`);
                        } else if (templateVal === 'funnel') {
                          setScadText(`// Funnel / Bowl\nheight = 0.4; // [0.2:0.05:1.0]\nbase_r = 0.15; // [0.05:0.05:0.5]\ntop_r = 0.4; // [0.2:0.05:1.0]\npassage_r = 0.05; // [0.02:0.01:0.2]\ndifference() {\n  cylinder(h=height, r1=base_r, r2=top_r, center=true, $fn=24);\n  translate([0, 0, height*0.125])\n    cylinder(h=height, r1=base_r*0.66, r2=top_r*0.95, center=true, $fn=24);\n  // vertical passage hole\n  cylinder(h=height*1.5, r=passage_r, center=true, $fn=16);\n}`);
                        } else if (templateVal === 'clear') {
                          setScadText('');
                        }
                        e.target.value = ''; // Reset selection
                      }}
                      className="text-xs bg-white border border-slate-200 rounded px-1.5 py-0.5 text-slate-700 outline-none focus:border-blue-500 cursor-pointer"
                    >
                      <option value="">-- Select Template --</option>
                      <option value="hollow_cube">Hollow Cube</option>
                      <option value="wheel">Wheel with Hole</option>
                      <option value="wedge">Wedge with Holes</option>
                      <option value="funnel">Funnel / Bowl</option>
                      <option value="clear">Clear Editor</option>
                    </select>
                  </div>

                  {/* Procedural parameters sliders */}
                  {scadVars.length > 0 && (
                    <div className="flex flex-col gap-2 p-2 bg-slate-50 dark:bg-slate-900/50 rounded-lg border border-slate-100 dark:border-slate-800 mb-1">
                      <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">
                        Procedural Parameters
                      </span>
                      <div className="grid grid-cols-1 gap-2">
                        {scadVars.map((v) => (
                          <div key={v.name} className="flex flex-col gap-1">
                            <div className="flex justify-between items-center text-xs">
                              <span className="font-mono text-slate-700 dark:text-slate-300 font-medium">{v.name}</span>
                              <span className="font-mono text-violet-600 dark:text-violet-400 font-bold bg-violet-50 dark:bg-violet-950/40 px-1.5 py-0.5 rounded border border-violet-100 dark:border-violet-900/50">
                                {Number((slidingValues[v.name] ?? v.value).toPrecision(4))}
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-[9px] text-slate-400 font-mono w-8 text-right">{Number(v.min.toPrecision(3))}</span>
                              <RangeInput
                                min={v.min}
                                max={v.max}
                                step={v.step}
                                value={slidingValues[v.name] ?? v.value}
                                onChange={(next) => {
                                  // Only the float noise off the step comes off: two decimals would turn
                                  // a 5 mm value, written in metres, into 10 mm.
                                  const val = Number(next.toPrecision(10));
                                  setSlidingValues(prev => ({ ...prev, [v.name]: val }));
                                  debouncedUpdateCode();
                                }}
                                className="flex-1 h-1 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-violet-600"
                              />
                              <span className="text-[9px] text-slate-400 font-mono w-8">{Number(v.max.toPrecision(3))}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Text Area Code Editor */}
                  <div className="relative">
                    <textarea
                      value={scadText}
                      onChange={(e) => setScadText(e.target.value)}
                      placeholder="// Write OpenSCAD here... e.g. cube(10);"
                      className="w-full h-44 font-mono text-[11px] leading-relaxed p-2.5 bg-slate-950 text-violet-300 rounded-lg border border-slate-800 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent resize-y shadow-inner"
                      spellCheck={false}
                    />
                    <div className="absolute right-2.5 bottom-2.5 text-[8px] font-mono text-slate-600 bg-slate-900/50 px-1 rounded pointer-events-none select-none border border-slate-800">
                      SCAD
                    </div>
                  </div>

                  {/* Compilation Error Display */}
                  {scadError && (
                    <div className="p-2.5 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg text-[10px] flex gap-1.5 items-start leading-tight">
                      <span className="font-bold shrink-0">⚠️ Error:</span>
                      <span className="font-mono text-slate-700 break-all">{scadError}</span>
                    </div>
                  )}

                  {/* Action Buttons Row */}
                  <div className="flex gap-2 items-center justify-between">
                    <button
                      onClick={async () => {
                        setIsCompilerLoading(true);
                        try {
                          const compiled = await compileSCAD(scadText);
                          if (!compiled.vertices || compiled.vertices.length === 0) {
                            throw new Error('Compilation produced no vertices.');
                          }

                          const geo = new THREE.BufferGeometry();
                          geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(compiled.vertices), 3));
                          geo.setIndex(new THREE.BufferAttribute(new Uint32Array(compiled.faces), 1));
                          geo.computeVertexNormals();

                          const mesh = new THREE.Mesh(geo);
                          const bbox = new THREE.Box3().setFromObject(mesh);
                          const size = bbox.getSize(new THREE.Vector3());
                          const longestSide = Math.max(size.x, size.y, size.z);

                          let defaultPrompt = '150';
                          if (longestSide > 0) {
                            defaultPrompt = Math.round(longestSide * 1000).toString();
                          }

                          const targetStr = window.prompt("Longest part's longest side (mm):", defaultPrompt);
                          if (targetStr === null) return;
                          const targetMm = parseFloat(targetStr);
                          if (isNaN(targetMm) || targetMm <= 0) { alert('Invalid size'); return; }

                          const scale = targetMm / longestSide;
                          const center = bbox.getCenter(new THREE.Vector3());
                          const transform = new THREE.Matrix4()
                            .makeRotationX(Math.PI / 2)
                            .multiply(new THREE.Matrix4().makeScale(scale, scale, scale))
                            .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));
                          
                          geo.applyMatrix4(transform);

                          const exportGroup = new THREE.Group();
                          exportGroup.add(mesh);

                          const exporter = new STLExporter();
                          const result = exporter.parse(exportGroup, { binary: true }) as DataView;
                          const blob = new Blob([result.buffer as ArrayBuffer], { type: 'application/octet-stream' });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = `${selectedNode.name || 'openscad_shape'}.stl`;
                          a.click();
                          URL.revokeObjectURL(url);
                        } catch (e) {
                          alert('Failed to export OpenSCAD STL: ' + (e as Error).message);
                        } finally {
                          setIsCompilerLoading(false);
                        }
                      }}
                      disabled={isCompilerLoading || isScadCompiling}
                      className="text-[10px] font-semibold text-blue-600 hover:text-blue-700 disabled:text-slate-400 transition-colors flex items-center gap-1 cursor-pointer"
                    >
                      <Printer className="w-3.5 h-3.5" />
                      Export STL (3D Print)
                    </button>

                    <button
                      onClick={handleCompileScad}
                      disabled={isScadCompiling || isCompilerLoading}
                      className="px-3 py-1.5 bg-violet-600 hover:bg-violet-700 disabled:bg-slate-400 active:bg-violet-800 text-white rounded-lg text-[11px] font-semibold shadow transition-colors flex items-center gap-1 cursor-pointer"
                    >
                      <Zap className="w-3.5 h-3.5" />
                      {isScadCompiling ? 'Compiling...' : 'Compile & Update'}
                    </button>
                  </div>
                </div>
              )}

              {/* Component Control Script Card */}
              <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2.5">
                <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center justify-between">
                  <span className="flex items-center gap-1.5 font-semibold text-slate-800">
                    <Code className="w-4 h-4 text-blue-500" />
                    Component Script
                    <button
                      type="button"
                      onClick={() => openDocs('tutorial')}
                      className="ml-0.5 flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold text-blue-600 bg-blue-50 border border-blue-200 hover:bg-blue-100 hover:border-blue-300 transition-colors cursor-pointer"
                      title="Open the scripting tutorial"
                    >
                      <Info className="w-3.5 h-3.5" />
                      Tutorial
                    </button>
                  </span>
                  <div className="flex items-center gap-1.5">
                    {selectedNode.script ? (
                      <span className="flex items-center gap-1 text-[10px] font-semibold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded-full border border-emerald-100 animate-pulse">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                        Active
                      </span>
                    ) : (
                      <span className="text-[10px] font-medium text-slate-400 bg-slate-50 px-1.5 py-0.5 rounded-full border border-slate-100">
                        Disabled
                      </span>
                    )}
                  </div>
                </h3>

                <p className="text-[10px] text-slate-400 -mt-1 leading-tight">
                  Write custom real-time JavaScript to control this component at 1000Hz.
                </p>

                {/* Templates Selector */}
                <div className="flex items-center justify-between text-xs text-slate-500 gap-1.5 bg-slate-50 p-1.5 rounded-md border border-slate-100">
                  <span className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">Templates:</span>
                  <select
                    onChange={(e) => {
                      const templateVal = e.target.value;
                      if (templateVal === 'lqr') {
                        setScriptText(`// Cartpole LQR Balancing Controller
const x = api.getJointPosition('cart_slide');
const v = api.getJointVelocity('cart_slide');
const theta = api.getJointPosition('pole_hinge');
const omega = api.getJointVelocity('pole_hinge');

// State-feedback LQR controller gains
const kx = 22.0;      // Cart position gain
const kv = 15.0;      // Cart velocity damping
const kTheta = 80.0;  // Pole angle gain (robust tracking)
const kOmega = 20.0;  // Pole angular velocity damping

// Compute the balancing force
const force = (kx * x) + (kv * v) + (kTheta * theta) + (kOmega * omega);

// Apply force directly to the cart slide joint
api.applyJointForce('cart_slide', force);
`);
                      } else if (templateVal === 'sine') {
                        setScriptText(`// Sinusoidal Driver
const forceX = Math.sin(api.getTime() * 5.0) * 8.0;
api.applyForce([forceX, 0, 0]);
`);
                      } else if (templateVal === 'spring') {
                        setScriptText(`// PD Harmonic Spring / Return-to-Center
const pos = api.getPosition();
const dist = 0.0 - pos[0];
const vel = api.getVelocity()[0];

// PD coefficients
const kp = 25.0; // Spring constant
const kd = 5.0;  // Damping

const force = (kp * dist) - (kd * vel);
api.applyForce([force, 0, 0]);
`);
                      } else if (templateVal === 'clear') {
                        setScriptText('');
                      }
                      e.target.value = ''; // Reset selection
                    }}
                    className="text-xs bg-white border border-slate-200 rounded px-1.5 py-0.5 text-slate-700 outline-none focus:border-blue-500 cursor-pointer"
                  >
                    <option value="">-- Select Template --</option>
                    <option value="lqr">LQR Cartpole Balancer</option>
                    <option value="sine">Sinusoidal Driver</option>
                    <option value="spring">PD Harmonic Spring</option>
                    <option value="clear">Clear Script</option>
                  </select>
                </div>

                {/* Text Area Code Editor */}
                <div className="relative">
                  <textarea
                    value={scriptText}
                    onChange={(e) => setScriptText(e.target.value)}
                    placeholder="// Write control logic here... e.g. api.applyForce([10, 0, 0])"
                    className="w-full h-40 font-mono text-[11px] leading-relaxed p-2.5 bg-slate-950 text-emerald-400 rounded-lg border border-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y shadow-inner"
                    spellCheck={false}
                  />
                  <div className="absolute right-2.5 bottom-2.5 text-[8px] font-mono text-slate-600 bg-slate-900/50 px-1 rounded pointer-events-none select-none border border-slate-800">
                    JS
                  </div>
                </div>

                {/* Compilation Error Display */}
                {scriptError && (
                  <div className="p-2.5 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg text-[10px] flex gap-1.5 items-start leading-tight">
                    <span className="font-bold shrink-0">⚠️ Error:</span>
                    <span className="font-mono text-slate-700 break-all">{scriptError}</span>
                  </div>
                )}

                {/* Control Actions Row */}
                <div className="flex gap-2 items-center justify-between">
                  <button
                    onClick={() => setShowApiRef(!showApiRef)}
                    className="text-[10px] font-semibold text-blue-600 hover:text-blue-700 transition-colors flex items-center gap-1 cursor-pointer"
                  >
                    <Info className="w-3.5 h-3.5" />
                    {showApiRef ? 'Hide API Reference' : 'Show API Reference'}
                  </button>

                  <button
                    onClick={handleSaveScript}
                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white rounded-lg text-[11px] font-semibold shadow transition-colors flex items-center gap-1 cursor-pointer"
                  >
                    <Zap className="w-3.5 h-3.5" />
                    Save & Execute
                  </button>
                </div>

                {/* API Reference Collapsible */}
                {showApiRef && (
                  <div className="text-[10px] bg-slate-50 border border-slate-150 rounded-lg p-2.5 flex flex-col gap-2 font-sans text-slate-600 max-h-64 overflow-y-auto">
                    <div className="flex items-center justify-between border-b border-slate-200 pb-1 mb-1">
                      <span className="font-semibold text-slate-700">Available API Methods</span>
                      <button
                        type="button"
                        onClick={() => openDocs('apiref')}
                        className="text-blue-600 hover:text-blue-700 font-semibold cursor-pointer"
                      >
                        Full reference →
                      </button>
                    </div>
                    <p className="text-slate-400 leading-tight -mt-1">
                      Runs once per physics step. <code className="font-mono">bodyName?</code> defaults to this component.
                    </p>
                    {[
                      { group: 'Read body state', rows: [
                        ['api.getPosition(bodyName?)', 'World position [x, y, z] in metres.'],
                        ['api.getVelocity(bodyName?)', 'Linear velocity [vx, vy, vz] in m/s.'],
                        ['api.getAngularVelocity(bodyName?)', 'Angular velocity [wx, wy, wz] in rad/s.'],
                        ['api.getOrientation(bodyName?)', 'Rotation as a flat 9-element matrix.'],
                        ['api.getMass(bodyName?)', 'Body mass in kg.'],
                      ]},
                      { group: 'Read joint state', rows: [
                        ['api.getJointPosition(jointName)', 'Metres for slide, radians for hinge.'],
                        ['api.getJointVelocity(jointName)', 'm/s for slide, rad/s for hinge.'],
                      ]},
                      { group: 'Apply forces', rows: [
                        ['api.applyForce(forceVec, bodyName?)', 'World-space force [fx, fy, fz] in newtons.'],
                        ['api.applyTorque(torqueVec, bodyName?)', 'World-space torque [tx, ty, tz] in N·m.'],
                        ['api.applyJointForce(jointName, value)', 'Force/torque along the joint axis.'],
                        ['api.setActuatorControl(name, ctrl)', 'Command a motor actuator.'],
                      ]},
                      { group: 'Override state', rows: [
                        ['api.setPosition(pos, bodyName?)', 'Teleport. [x,y,z] for free, number for hinge/slide.'],
                        ['api.setVelocity(vel, bodyName?)', 'Force a linear velocity, bypassing the solver.'],
                        ['api.setAngularVelocity(v, bodyName?)', 'Force an angular velocity.'],
                      ]},
                      { group: 'Environment & utilities', rows: [
                        ['api.getTime()', 'Simulation time in seconds.'],
                        ['api.isKeyPressed(key)', "True while held: 'space', 'w', 'arrowup'…"],
                        ['api.getWind()', 'Current wind as [windX, windY].'],
                        ['api.log(msg)', 'Log to the browser console.'],
                        ['api.id / api.name', "This component's id and display name."],
                      ]},
                    ].map(({ group, rows }) => (
                      <div key={group} className="flex flex-col gap-1.5">
                        <div className="text-[9px] font-bold uppercase tracking-wider text-slate-400 mt-1">{group}</div>
                        {rows.map(([sig, desc]) => (
                          <div key={sig}>
                            <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">{sig}</code>
                            <p className="text-slate-500 mt-0.5">{desc}</p>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Delete Component Button */}
              <button 
                onClick={() => deleteNode(selectedNode.id)}
                className="mt-2 flex items-center justify-center gap-2 w-full py-2 border border-red-200 rounded-lg text-xs font-semibold text-red-600 bg-red-50 hover:bg-red-100 hover:border-red-300 transition-colors shadow-sm cursor-pointer"
              >
                <Trash2 className="w-4 h-4" /> Delete Component
              </button>
            </div>
          </aside>
        )}

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

      {detachForFree && (() => {
        const body = findNodeById(sceneGraph.nodes, detachForFree.id);
        return (
          <ConfirmModal
            title="Detach this body to make it free?"
            confirmLabel="Detach and make free"
            body={
              <>
                <p>
                  <strong>{body?.name || detachForFree.id}</strong> hangs inside another body, and a
                  6-DOF body has to sit at the top of the scene — MuJoCo will not load a model with a
                  free joint anywhere else.
                </p>
                <p>
                  It will be lifted out of its parent and left exactly where it is now, free to fall
                  and be pushed around. Anything hanging under it comes too. Its parent keeps
                  everything else.
                </p>
              </>
            }
            onCancel={() => setDetachForFree(null)}
            onConfirm={() => {
              const { id, joints } = detachForFree;
              setDetachForFree(null);
              if (useStore.getState().detachToTopLevel(id)) updateNodeJointsList(id, joints);
            }}
          />
        );
      })()}

      {isSaveModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-100 shadow-2xl max-w-md w-full p-6 flex flex-col gap-4 animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-blue-100 flex items-center justify-center text-blue-600">
                <Save className="w-5 h-5" />
              </div>
              <div>
                <h2 className="font-bold text-slate-800 text-base">Save Scene Preset</h2>
                <p className="text-xs text-slate-500">Give your scene a name to save it locally</p>
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
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="flex justify-end gap-2 text-xs">
              <button
                onClick={() => setIsSaveModalOpen(false)}
                className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmSavePreset}
                disabled={!presetNameInput.trim()}
                className="px-4 py-2 font-semibold text-white bg-blue-500 hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors"
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
      <PresetSaveNotice />
    </div>
  );
}

export default App;
