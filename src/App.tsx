
import { Canvas, useThree } from '@react-three/fiber';
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
import { useStore, getPhysicsWorkerClient, setPhysicsFrameListener, cloneSceneGraph } from './store/useStore';
import { useDentStore } from './store/dentStore';
import { applyShatterPieces } from './store/useStore';
import type { SceneGraph, SceneNode, SceneGeom, SceneJoint, CsgOp } from './types/scene';
import type { ModelMirror, MujocoShim } from './types/sceneLayer';
import type { WeakSpot } from './utils/printAnalysis';
import { Play, Square, SlidersHorizontal, Settings, Box, Circle, X, RotateCcw, Trash2, Layers, CircleDot, Zap, Info, Triangle, Disc, Code, Menu, Shapes, Minimize2, Save, Download, Upload, Undo, Redo, FileText, ChevronDown, ChevronUp, PanelRight, Edit3, Printer, Scissors, Sparkles, Sun, Moon, Pyramid, Cone, Donut, ChartSpline, Paintbrush, Grid3x3, Image as ImageIcon, Share2, Copy, Check, Link2, Unlink, Hammer } from 'lucide-react';
import { useRef, useMemo, useEffect, useCallback, useState, type RefObject, type ComponentProps, type ComponentRef } from 'react';
import AICopilotPanel from './components/AICopilotPanel';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { exportThreeMf, type ThreeMfMesh } from './utils/threeMfExporter';
import { SimplifyModifier } from 'three/examples/jsm/modifiers/SimplifyModifier.js';
import { loadCompiler, compileSCAD, isCompilerReady, setScadCompileListener } from './utils/openscad';
import { getStickyRotation } from './utils/geom';
import { csgSourceGeoms, csgHashOf, collisionModeOf, CSG_DEFAULT_SECTORS } from './utils/csg';
import { DEFAULT_HOLD_STEPS, isBreakable, weldKey } from './utils/breakThresholds';
import { isDentable, needsConversionForDenting } from './utils/dentMesh';
import { CUSTOM_DENT, CUSTOM_SHATTER, DEFORM_MATERIALS, deformMaterial, dentFields, estimateBodyMass, materialUpdates, shatterFields } from './utils/deformMaterials';
import { collidersAreStale, solidMeshGeoms } from './utils/convexDecomposition';
import { useCsgAutoCompile } from './hooks/useCsgCompile';
import { PRESETS } from './presets/presetScenes';
import { makePresetNoteCard } from './utils/noteCards';
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
import { ScaleCard, ScaleControls } from './components/ScaleCard';
import { ObjectGestureController } from './components/scene/ObjectGestures';
import { TransformGizmo } from './components/scene/TransformGizmo';
import { isGizmoBusy } from './components/scene/gizmoBusy';
import { MeasureTool } from './components/scene/MeasureTool';
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
import { sanitizeNoteUrl } from '@physbox-io/ui';

type NoteCard = { id: string; markdown: string; minimized: boolean; x: number; y: number };
// AICopilotPanel keeps its ChatMessage type to itself; this is the same type,
// read back off its props so the two cannot drift.
type CopilotMessage = NonNullable<ComponentProps<typeof AICopilotPanel>['messages']>[number];
type StoreState = ReturnType<typeof useStore.getState>;
type AddComponentType = Parameters<StoreState['addComponent']>[0];
type PresetEntry = { name: string; emoji?: string };
type GeminiModelInfo = { name: string; displayName?: string; supportedGenerationMethods?: string[] };

// The slice of the MuJoCo model/data mirror that scene syncing reads. Only
// these members are touched here, but they are the store's own mirror types so
// the shim can be handed straight over.
type SyncMujoco = Pick<MujocoShim, 'mj_name2id'> & { mjtObj: Pick<MujocoShim['mjtObj'], 'mjOBJ_BODY'> };
interface SyncData {
  xpos: ArrayLike<number>;
  xmat: ArrayLike<number>;
}

// Globals other modules (the MCP bridge, the note-card manager, tests) reach
// through `window`. Typed here rather than declared globally so a differently
// typed declaration elsewhere cannot conflict with this one.
interface PhysicsGlobals {
  DISABLE_USEFRAME?: boolean;
  _physics_getNoteCards?: () => NoteCard[];
  _physics_setNoteCards?: (cards: NoteCard[]) => void;
  _physics_getCopilotMessages?: () => CopilotMessage[];
  _physics_setCopilotMessages?: (msgs: CopilotMessage[]) => void;
  _physics_store?: typeof useStore;
  _physics_gl?: THREE.WebGLRenderer;
  _physics_scene?: THREE.Scene;
  _physics_camera?: THREE.Camera;
  _physics_composer?: ComponentRef<typeof EffectComposer> | null;
}
const physicsGlobals = (typeof window !== 'undefined' ? window : {}) as unknown as PhysicsGlobals;

declare global {
  interface Window { useStore?: typeof useStore }
}
// Debug hook: the store is reachable from the browser console.
if (typeof window !== 'undefined') {
  window.useStore = useStore;
}

// Markdown for a note card. Headings, emphasis, code, links and bullets;
// nothing else, because a note card is a label rather than a document.
function parseNoteMarkdown(md: string): string {
  if (!md) return '';
  let html = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  html = html.replace(/^### (.*$)/gim, '<h3 class="text-xs font-bold text-slate-800 dark:text-slate-200 mt-2 mb-1 uppercase tracking-wide">$1</h3>');
  html = html.replace(/^## (.*$)/gim, '<h2 class="text-sm font-bold text-slate-800 dark:text-slate-200 mt-3 mb-1 border-b border-slate-100 dark:border-slate-800 pb-0.5">$1</h2>');
  html = html.replace(/^# (.*$)/gim, '<h1 class="text-base font-extrabold text-slate-900 dark:text-slate-100 mt-3 mb-2 border-b border-slate-200 dark:border-slate-800 pb-1">$1</h1>');
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong class="font-bold text-slate-900 dark:text-slate-100">$1</strong>');
  html = html.replace(/\*(.*?)\*/g, '<em class="italic text-slate-700 dark:text-slate-300">$1</em>');
  html = html.replace(/`(.*?)`/g, '<code class="px-1 py-0.5 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-[10px] font-mono text-pink-600 dark:text-pink-400">$1</code>');
  // A link is the one place a note card's text reaches an HTML attribute, so
  // what may become an href is decided in @physbox-io/ui and shared with the
  // other apps. Anything else is left on the page as the text it was written
  // as, rather than becoming an anchor nobody can see the target of.
  html = html.replace(/\[(.*?)\]\((.*?)\)/g, (whole, label: string, url: string) => {
    const href = sanitizeNoteUrl(url);
    return href
      ? `<a href="${href}" target="_blank" rel="noopener noreferrer" class="text-blue-600 dark:text-blue-400 hover:underline">${label}</a>`
      : whole;
  });
  html = html.replace(/^\s*-\s+(.*$)/gim, '<li class="ml-4 list-disc text-slate-600 dark:text-slate-300 text-xs mb-0.5">$1</li>');
  html = html.split('\n').map(line => {
    const t = line.trim();
    if (t.startsWith('<h') || t.startsWith('<li') || t === '') return line;
    return `<p class="text-xs text-slate-600 dark:text-slate-300 mb-1.5 leading-relaxed">${line}</p>`;
  }).join('\n');
  return html;
}

// The status bar's "SCAD Compiling" pill counts compiles in flight. openscad.ts
// reports them through a listener rather than importing the store; see there.
setScadCompileListener((delta) => {
  const s = useStore.getState();
  if (delta > 0) s.incrementScadCompile();
  else s.decrementScadCompile();
});

// Floating note card overlay component
function NoteCardOverlay({ card, isEditing, onToggleEdit, onToggleMinimize, onMarkdownChange, onClose, onMove }: {
  card: { id: string; markdown: string; minimized: boolean; x: number; y: number };
  isEditing: boolean;
  onToggleEdit: () => void;
  onToggleMinimize: () => void;
  onMarkdownChange: (md: string) => void;
  onClose: () => void;
  onMove: (x: number, y: number) => void;
}) {
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  /*
   * A drag and a draft are held here and handed up when they settle.
   *
   * The cards live in App's state, so reporting every pointer move or keystroke
   * re-rendered the whole app and re-offered the scene to auto-save each time.
   * The card follows the pointer from its own state and reports where it was
   * dropped; the text is reported once typing pauses, and on blur.
   */
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitDraft = (md: string | null) => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = null;
    if (md !== null) onMarkdownChange(md);
    setDraft(null);
  };
  const onMarkdownChangeRef = useRef(onMarkdownChange);
  onMarkdownChangeRef.current = onMarkdownChange;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Leaving edit mode or closing the card must not drop what was typed last.
  useEffect(() => () => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    if (draftRef.current !== null) onMarkdownChangeRef.current(draftRef.current);
  }, []);
  const x = dragPos?.x ?? card.x;
  const y = dragPos?.y ?? card.y;

  // Pointer events, not mouse events: a finger and a stylus move the card
  // through exactly the same code path as a mouse, which listening for
  // mousedown alone left with no way to move a card at all.
  const handleTitleMouseDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: card.x, origY: card.y };
    let last: { x: number; y: number } | null = null;
    const handleMouseMove = (me: PointerEvent) => {
      if (!dragRef.current) return;
      last = { x: dragRef.current.origX + me.clientX - dragRef.current.startX, y: dragRef.current.origY + me.clientY - dragRef.current.startY };
      setDragPos(last);
    };
    const handleMouseUp = () => {
      dragRef.current = null;
      if (last) onMove(last.x, last.y);
      setDragPos(null);
      window.removeEventListener('pointermove', handleMouseMove);
      window.removeEventListener('pointerup', handleMouseUp);
      window.removeEventListener('pointercancel', handleMouseUp);
    };
    window.addEventListener('pointermove', handleMouseMove);
    window.addEventListener('pointerup', handleMouseUp);
    window.addEventListener('pointercancel', handleMouseUp);
  };

  return (
    <div
      // `min(300px, ...)` so a card dropped near the right edge of a phone is
      // still readable rather than a 300px card hanging half off the screen.
      style={{ position: 'absolute', left: x, top: y, zIndex: 25, width: 'min(300px, calc(100vw - 2rem))', touchAction: 'none' }}
      className="bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border border-slate-200 dark:border-slate-800 shadow-2xl rounded-2xl overflow-hidden"
    >
      {/* Title bar */}
      <div
        className="flex items-center justify-between px-3 py-2 bg-slate-50/80 dark:bg-slate-950/40 border-b border-slate-100 dark:border-slate-800 cursor-move select-none"
        onPointerDown={handleTitleMouseDown}
      >
        <div className="flex items-center gap-1.5">
          <FileText className="w-3.5 h-3.5 text-violet-600 dark:text-violet-400" />
          <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">Note Card</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onToggleEdit} className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors" title={isEditing ? 'Preview' : 'Edit'}>
            <Edit3 className="w-3 h-3 text-slate-500 dark:text-slate-400" />
          </button>
          <button onClick={onToggleMinimize} className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors" title={card.minimized ? 'Expand' : 'Minimize'}>
            {card.minimized ? <ChevronDown className="w-3 h-3 text-slate-500 dark:text-slate-400" /> : <ChevronUp className="w-3 h-3 text-slate-500 dark:text-slate-400" />}
          </button>
          <button onClick={onClose} className="p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-950/40 transition-colors" title="Close">
            <X className="w-3 h-3 text-slate-500 dark:text-slate-400 hover:text-red-500" />
          </button>
        </div>
      </div>

      {/* Body */}
      {!card.minimized && (
        <div className="p-3">
          {isEditing ? (
            <textarea
              autoFocus
              rows={8}
              value={draft ?? card.markdown}
              onChange={(e) => {
                const md = e.target.value;
                setDraft(md);
                if (draftTimer.current) clearTimeout(draftTimer.current);
                draftTimer.current = setTimeout(() => commitDraft(md), 400);
              }}
              onBlur={() => commitDraft(draft)}
              className="w-full px-2 py-1.5 border border-slate-200 dark:border-slate-800 rounded text-xs bg-white dark:bg-slate-950 text-slate-700 dark:text-slate-200 outline-none focus:border-violet-400 font-mono resize-y shadow-sm"
              placeholder="Write markdown here..."
            />
          ) : (
            <div
              className="prose-sm dark:prose-invert max-h-64 overflow-y-auto text-slate-700 dark:text-slate-300"
              dangerouslySetInnerHTML={{ __html: parseNoteMarkdown(card.markdown) }}
            />
          )}
        </div>
      )}
    </div>
  );
}

// Physics Step Hook
//
// Actual physics stepping, script execution (incl. aerodynamics), free-joint
// damping, drag-force application, and history recording now all live in the
// dedicated physics worker (src/workers/physicsWorker.ts) so that on
// unrecoverable WASM memory exhaustion the worker can be terminated and a
// fresh one spawned — a real memory reclaim. This component's only remaining
// job is forwarding keyboard state to the worker, since scripts' `isKeyPressed`
// needs it and the worker has no DOM access of its own.
const PhysicsLoop = ({ isPlaying }: { model: unknown, data: unknown, mujoco: unknown, isPlaying: boolean }) => {
  useFrame((_state, delta) => {
    if (physicsGlobals.DISABLE_USEFRAME) return;
    if (!isPlaying) return;
    if (typeof SharedArrayBuffer === 'undefined') {
      getPhysicsWorkerClient().tick(delta);
    }
  });

  useEffect(() => {
    const pressedKeys = new Set<string>();
    const sync = () => getPhysicsWorkerClient().setKeys(Array.from(pressedKeys));

    const handleKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (active && (
        active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.getAttribute('contenteditable') === 'true'
      )) {
        return;
      }
      pressedKeys.add(e.key.toLowerCase());
      pressedKeys.add(e.code.toLowerCase());
      sync();
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      pressedKeys.delete(e.key.toLowerCase());
      pressedKeys.delete(e.code.toLowerCase());
      sync();
    };

    const handleBlur = () => {
      pressedKeys.clear();
      sync();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  return null;
};

/**
 * Keeps the grid's fade a fixed share of the view, however far out the camera
 * is.
 *
 * drei's `fadeDistance` is a distance in metres, and the camera's is not: a
 * fixed value means the fade is whatever the zoom happens to make of it. On a
 * 40 mm part, viewed from 120 mm, a four-metre fade is thirty windows away and
 * the graph paper is flat and hard-edged to the horizon; on a half-metre
 * pendulum viewed from 800 mm the same number is five windows and the ground
 * washes out right behind the model. Same setting, opposite complaints.
 *
 * So the fade follows the orbit distance instead — always GRID_FADE_RATIO
 * viewing distances out — and the grid reads the same at every zoom. Written
 * straight into the shader uniform in useFrame rather than through the prop,
 * because the prop is React state and this changes on every frame of a drag.
 */
/*
 * 4 viewing distances out, with fadeStrength 0.8 on the Grid below. Between the
 * two numbers: the ground is at about 79% alpha where the part is standing,
 * half gone a bit over two windows out and finished at four. 8 and 0.5 left it
 * at 94% at the part and running to the horizon, which read as no fog at all.
 */
const GRID_FADE_RATIO = 4;

/**
 * Asks for a frame whenever the picture may have changed, so a paused scene
 * can stop drawing.
 *
 * The Canvas renders on demand while the simulation is stopped (see
 * `frameloop` below). Before that it drew every frame forever: shadow map,
 * scene, ambient occlusion and the axis legend, sixty-plus times a second over
 * a scene where nothing was moving. On demand, something has to say when a
 * frame is needed, and nearly everything that changes the picture passes
 * through one of four places: the scene store, the dent store, a physics
 * frame, or a pointer or key event on the page. The tools that write straight
 * into three objects mid-drag (sculpt, gizmo, measure) are all driven by
 * pointer events, so listening for those covers them without each one having
 * to remember.
 * OrbitControls asks for its own frames, damping included.
 *
 * Not every pointer or key event on the page, though: moving the mouse over
 * the sidebar or typing in a panel field drew full frames of a scene nothing
 * had touched. A pointer event counts when it is over the viewport, when a
 * button is held (a drag that has wandered off it), or while a keyboard
 * gesture or the measure tool is following the mouse; a key counts unless it
 * was typed into a field.
 */
const RenderOnChange = () => {
  const invalidate = useThree((state) => state.invalidate);
  const viewport = useThree((state) => state.gl.domElement.parentElement);
  useEffect(() => {
    const ask = () => invalidate();
    const onPointer = (e: PointerEvent | WheelEvent) => {
      if (e.buttons !== 0) return invalidate();
      const target = e.target as Node | null;
      if (viewport && target && viewport.contains(target)) return invalidate();
      const s = useStore.getState();
      if (s.gestureStatus || s.measureMode) invalidate();
    };
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return;
      invalidate();
    };
    const unsubscribe = useStore.subscribe(ask);
    const unsubscribeDents = useDentStore.subscribe(ask);
    setPhysicsFrameListener(ask);
    const pointerEvents = ['pointermove', 'pointerdown', 'pointerup', 'wheel'] as const;
    const keyEvents = ['keydown', 'keyup'] as const;
    for (const e of pointerEvents) window.addEventListener(e, onPointer, { passive: true });
    for (const e of keyEvents) window.addEventListener(e, onKey, { passive: true });
    return () => {
      unsubscribe();
      unsubscribeDents();
      setPhysicsFrameListener(null);
      for (const e of pointerEvents) window.removeEventListener(e, onPointer);
      for (const e of keyEvents) window.removeEventListener(e, onKey);
    };
  }, [invalidate, viewport]);
  return null;
};

/** What the grid mesh is called in the scene, so this can find it again. */
const GRID_NAME = 'ground-grid';

const GridFadeFollowsCamera = () => {
  const found = useRef<THREE.Mesh | undefined>(undefined);
  useFrame((state) => {
    // Looked up from the live scene rather than held from render, the same way
    // the near-plane effect in SceneLayer reads the camera through R3F's
    // get(): this writes into an object R3F owns, and a value captured during
    // render is not ours to modify. The lookup walks the whole scene, so what
    // it finds is kept until it leaves the scene rather than searched for
    // again every frame.
    if (!found.current?.parent) found.current = state.scene.getObjectByName(GRID_NAME) as THREE.Mesh | undefined;
    const grid = found.current;
    const material = grid?.material as THREE.ShaderMaterial | undefined;
    const uniform = material?.uniforms?.fadeDistance;
    if (!uniform) return;
    // OrbitControls is `makeDefault`, so R3F holds it and its target is what
    // the camera is actually circling — the distance to it is the scale of
    // what is on screen. Falling back to the origin covers the frame or two
    // before the controls mount.
    const target = (state.controls as { target?: THREE.Vector3 } | null)?.target;
    const distance = target ? state.camera.position.distanceTo(target) : state.camera.position.length();
    uniform.value = Math.max(0.05, distance * GRID_FADE_RATIO);
  });
  return null;
};

// AxisLegendDrawer — lives inside the R3F Canvas, reads camera every frame and draws
// MuJoCo XYZ axes onto an external HTML canvas element passed via ref.
// MuJoCo coord system: X=right (red), Y=into screen (green), Z=up (blue)
// Three.js Y-up mapping: mujoco(x,y,z) → three(x, z, -y)
const AxisLegendDrawer = ({ externalRef }: { externalRef: RefObject<HTMLCanvasElement | null> }) => {
  const { camera } = useThree();
  // The legend depends on nothing but the camera's orientation, so a frame
  // where that has not turned (every frame of a simulation watched from a
  // still camera) leaves the drawing as it is.
  const drawn = useRef<{ el: HTMLCanvasElement; quaternion: THREE.Quaternion; width: number; height: number } | null>(null);

  useFrame(() => {
    const el = externalRef.current;
    if (!el) return;
    const last = drawn.current;
    if (last && last.el === el && last.width === el.width && last.height === el.height && last.quaternion.equals(camera.quaternion)) return;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    drawn.current = { el, quaternion: camera.quaternion.clone(), width: el.width, height: el.height };

    const W = el.width;
    const H = el.height;
    const cx = W / 2;
    const cy = H / 2 + 6; // shift down to give Z arrow more headroom at top
    const len = W * 0.36;

    ctx.clearRect(0, 0, W, H);

    // Project a MuJoCo direction vector through the live camera view matrix
    const projectAxis = (dx: number, dy: number, dz: number): [number, number] => {
      // MuJoCo(x,y,z) → Three.js world direction: three(x, z, -y)
      const worldDir = new THREE.Vector3(dx, dz, -dy);
      worldDir.normalize();
      const viewDir = worldDir.clone().transformDirection(camera.matrixWorldInverse);
      // view space: x=right, y=up → screen: x=right, y=down
      return [viewDir.x * len, -viewDir.y * len];
    };

    const axes = [
      { dir: [1, 0, 0] as const, color: '#ef4444', label: 'X', shadow: '#7f1d1d' },
      { dir: [0, 1, 0] as const, color: '#22c55e', label: 'Y', shadow: '#14532d' },
      { dir: [0, 0, 1] as const, color: '#3b82f6', label: 'Z', shadow: '#1e3a8a' },
    ];

    // Compute projections and sort back-to-front
    const projected = axes.map(a => {
      const [px, py] = projectAxis(a.dir[0], a.dir[1], a.dir[2]);
      const worldDir = new THREE.Vector3(a.dir[0], a.dir[2], -a.dir[1]);
      const viewDir = worldDir.clone().transformDirection(camera.matrixWorldInverse);
      return { ...a, px, py, depth: viewDir.z };
    });
    projected.sort((a, b) => a.depth - b.depth);

    const arrowHead = (x: number, y: number, ax: number, ay: number, size: number) => {
      const angle = Math.atan2(ay, ax);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - size * Math.cos(angle - 0.4), y - size * Math.sin(angle - 0.4));
      ctx.lineTo(x - size * Math.cos(angle + 0.4), y - size * Math.sin(angle + 0.4));
      ctx.closePath();
      ctx.fill();
    };

    for (const { px, py, color, label, shadow } of projected) {
      const ex = cx + px;
      const ey = cy + py;

      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.22)';
      ctx.shadowBlur = 2;
      ctx.shadowOffsetX = 1;
      ctx.shadowOffsetY = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.fillStyle = color;
      arrowHead(ex, ey, px, py, 8);
      ctx.restore();

      // Label: fixed 13px past the arrowhead tip, along the arrow direction.
      // Normalizing prevents the label from jumping when the axis is nearly
      // perpendicular to the screen (small projected length).
      const mag = Math.sqrt(px * px + py * py);
      if (mag > 2) {
        const nx = px / mag;
        const ny = py / mag;
        const lx = ex + nx * 13;
        const ly = ey + ny * 13;
        ctx.save();
        ctx.font = 'bold 11px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = shadow;
        ctx.fillText(label, lx + 0.5, ly + 0.5);
        ctx.fillStyle = color;
        ctx.fillText(label, lx, ly);
        ctx.restore();
      }
    }

    // Origin dot
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#64748b';
    ctx.fill();
  });

  return null;
};


// Drop Handler for precise spawning & external file imports (.scad, .stl, .json)
const DropHandler = ({ addComponent, onImportFile, onImportImageFile, onImportSceneJson }: {
  addComponent: (type: AddComponentType, pos: [number, number, number]) => void;
  onImportFile: (file: File) => void;
  onImportImageFile: (file: File) => void;
  onImportSceneJson: (text: string, fileName: string, dropped: boolean) => void;
}) => {
  const { camera, gl } = useThree();
  
  useEffect(() => {
    const handler = async (e: DragEvent) => {
      e.preventDefault();
      
      // 1. External files dropped (e.g. from desktop or file explorer)
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const fileName = file.name;
          const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();

          if (ext === '.json') {
            // The same path as the Import button, so a dropped scene is checked,
            // reported and set up the same way rather than swapped in silently.
            onImportSceneJson(await file.text(), fileName, true);
            break;
          } else if (file.type.startsWith('image/') || /\.(png|jpe?g|webp|bmp|gif|avif)$/.test(ext)) {
            // An image can only mean the heightmap importer — it is the one
            // path that turns 2D pixels into a body.
            onImportImageFile(file);
            break;
          } else if (ext === '.scad' || ext === '.stl') {
            // Hand the file to the import dialog rather than guessing: how an
            // STL should come in (CSG primitives, polyhedron, raw mesh) is the
            // whole point of that dialog, and a silent default import was
            // indistinguishable from the drop having done nothing.
            onImportFile(file);
            break;
          }
        }
        return;
      }

      // 2. Sidebar component drag
      const type = e.dataTransfer?.getData('type') as AddComponentType | undefined;
      if (!type) return;
      
      const rect = gl.domElement.getBoundingClientRect();
      const xLocal = e.clientX - rect.left;
      const yLocal = e.clientY - rect.top;

      const vec = new THREE.Vector3(
        (xLocal / rect.width) * 2 - 1,
        -(yLocal / rect.height) * 2 + 1,
        0.5
      );
      vec.unproject(camera);
      const dir = vec.sub(camera.position).normalize();
      
      // Intersect with Canvas Y=0 plane (which maps to MuJoCo Z=0)
      if (Math.abs(dir.y) < 0.001) return;
      const distance = -camera.position.y / dir.y; 
      if (distance < 0) return;
      
      const pos = camera.position.clone().add(dir.multiplyScalar(distance));
      
      let x = pos.x;
      let z = -pos.z;
      
      if (isNaN(x) || isNaN(z)) return;
      
      x = Math.max(-0.45, Math.min(0.45, x));
      z = Math.max(-0.45, Math.min(0.45, z));
      
      addComponent(type, [x, z, 0.2]);
    };
    
    const dragOverHandler = (e: DragEvent) => e.preventDefault();
    
    window.addEventListener('drop', handler);
    window.addEventListener('dragover', dragOverHandler);
    return () => {
      window.removeEventListener('drop', handler);
      window.removeEventListener('dragover', dragOverHandler);
    };
  }, [camera, gl, addComponent, onImportFile, onImportImageFile]);
  
  return null;
};



/**
 * The pose the app opens in, before any scene has been framed. 45° of vertical
 * FOV at DEFAULT_EYE puts about 250 mm of world across the window — the size of
 * the parts made here — where it used to put 660 mm and draw everything at
 * roughly two fifths the size. See utils/frameScene.
 */
const CAMERA_CONFIG = { position: DEFAULT_EYE, fov: 45, near: 0.01, far: 1000 };

const getSyncedSceneGraph = (
  scene: SceneGraph,
  model: ModelMirror | null,
  data: SyncData | null,
  mujoco: SyncMujoco | null
): SceneGraph => {
  if (!model || !data || !mujoco) return scene;

  const sceneCopy = cloneSceneGraph(scene);

  const syncNode = (
    node: SceneNode,
    parentWorldPos: THREE.Vector3,
    parentWorldQuat: THREE.Quaternion
  ) => {
    if (node.isPulleyRope) {
      if (node.children) {
        for (const child of node.children) {
          syncNode(child, parentWorldPos, parentWorldQuat);
        }
      }
      return;
    }

    const bodyId = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, node.name);
    
    const currentWorldPos = parentWorldPos.clone();
    const currentWorldQuat = parentWorldQuat.clone();

    if (bodyId !== -1) {
      const px = data.xpos[bodyId * 3];
      const py = data.xpos[bodyId * 3 + 1];
      const pz = data.xpos[bodyId * 3 + 2];
      currentWorldPos.set(px, py, pz);

      const m = data.xmat;
      const offset = bodyId * 9;
      const rotationMatrix = new THREE.Matrix4().set(
        m[offset],     m[offset + 1], m[offset + 2], 0,
        m[offset + 3], m[offset + 4], m[offset + 5], 0,
        m[offset + 6], m[offset + 7], m[offset + 8], 0,
        0,             0,             0,             1
      );
      currentWorldQuat.setFromRotationMatrix(rotationMatrix);

      const parentQuatInv = parentWorldQuat.clone().invert();
      const localPos = currentWorldPos.clone().sub(parentWorldPos).applyQuaternion(parentQuatInv);
      const localQuat = parentQuatInv.clone().multiply(currentWorldQuat);

      node.pos = [localPos.x, localPos.y, localPos.z];
      node.quat = [localQuat.w, localQuat.x, localQuat.y, localQuat.z];
      
      if (node.euler) {
        delete node.euler;
      }
    }

    if (node.children) {
      for (const child of node.children) {
        syncNode(child, currentWorldPos, currentWorldQuat);
      }
    }
  };

  const identityQuat = new THREE.Quaternion(0, 0, 0, 1);
  const zeroPos = new THREE.Vector3(0, 0, 0);

  for (const node of sceneCopy.nodes) {
    syncNode(node, zeroPos, identityQuat);
  }

  return sceneCopy;
};

// Every panel in the properties sidebar should be able to point at an
// explainer. Tabs are grouped so the nav stays readable as the list grows.
const DOCS_TABS = [
  { group: 'Simulation', items: [
    { id: 'gravity', label: '🪐 Gravity & Inertia' },
    { id: 'collision', label: '💥 Collision Physics' },
    { id: 'material', label: '🧪 Physical Material' },
    { id: 'friction', label: '🛷 Friction Controls' },
    { id: 'breaking', label: '💔 Breaking & Denting' },
  ]},
  { group: 'Bodies & Joints', items: [
    { id: 'launch', label: '🚀 Launch Velocity' },
    { id: 'damping', label: '🔗 Joint Damping' },
    { id: 'springs', label: '🌸 Springs & Limits' },
    { id: 'coupling', label: '⚙️ Joint Coupling' },
  ]},
  { group: 'Geometry', items: [
    { id: 'resize', label: '📏 Resize Component' },
    { id: 'offset', label: '📍 Position Offset' },
  ]},
  { group: 'Modelling', items: [
    { id: 'lattice', label: '🔲 Lattice Modelling' },
    { id: 'gestures', label: '⌨️ Scale, Inset & Modal Keys' },
  ]},
  { group: 'Fabrication', items: [
    { id: 'zeroing', label: '🎯 Machine Setup & Zeroing' },
    { id: 'resuming', label: '↩️ Stopping & Resuming' },
  ]},
  { group: 'Scripting', items: [
    { id: 'scripting', label: '💻 Names & Basics' },
    { id: 'tutorial', label: '🎓 Scripting Tutorial' },
    { id: 'apiref', label: '📚 Full API Reference' },
  ]},
  { group: 'Legal & Terms', items: [
    { id: 'license', label: '⚖️ License & Disclaimers' },
  ]},
] as const;

type DocsTabId = typeof DOCS_TABS[number]['items'][number]['id'];

// Small reusable (i) affordance that deep-links a sidebar panel to its docs tab.
const DocsInfoButton = ({ tab, onOpen, className = '', size = 'w-3.5 h-3.5' }: {
  tab: DocsTabId;
  onOpen: (tab: DocsTabId) => void;
  className?: string;
  size?: string;
}) => (
  <button
    type="button"
    onClick={(e) => { e.stopPropagation(); onOpen(tab); }}
    className={`text-slate-400 hover:text-blue-600 transition-colors cursor-pointer shrink-0 ${className}`}
    title="Click for documentation"
  >
    <Info className={size} />
  </button>
);



function generateScadForNode(node: SceneNode): string {
  const geom = node.geoms?.[0];
  if (!geom) return '// No geometry found';
  
  if (node.isWedge) {
    const w = node.width || 2.0;
    const h = node.height || 0.5;
    const d = node.depth || 1.0;
    return `// Wedge shape\nwidth = ${w.toFixed(3)}; // [0.1:0.05:3.0]\nheight = ${h.toFixed(3)}; // [0.1:0.05:2.0]\ndepth = ${d.toFixed(3)}; // [0.1:0.05:2.0]\nlinear_extrude(height=depth, center=true)\n  polygon([[0,0], [width,0], [0,height]]);`;
  }
  
  if (node.isPyramid) {
    const w = node.width || 0.5;
    const d = node.depth || 0.5;
    const h = node.height || 0.5;
    return `// Pyramid shape\nwidth = ${w.toFixed(3)}; // [0.1:0.05:2.0]\ndepth = ${d.toFixed(3)}; // [0.1:0.05:2.0]\nheight = ${h.toFixed(3)}; // [0.1:0.05:2.0]\nlinear_extrude(height=height, scale=0)\n  square([width, depth], center=true);`;
  }
  
  if (node.isCone) {
    const r = node.radius || 0.3;
    const h = node.height || 0.6;
    return `// Cone shape\nradius = ${r.toFixed(3)}; // [0.1:0.05:2.0]\nheight = ${h.toFixed(3)}; // [0.1:0.05:2.0]\ncylinder(h=height, r1=radius, r2=0, center=false, $fn=24);`;
  }

  if (node.isTorus) {
    const R = node.majorRadius || 0.4;
    const r = node.tubeRadius || 0.1;
    return `// Torus shape\nmajor_r = ${R.toFixed(3)}; // [0.1:0.05:2.0]\ntube_r = ${r.toFixed(3)}; // [0.02:0.01:1.0]\nrotate_extrude($fn=24) translate([major_r, 0, 0]) circle(r=tube_r, $fn=16);`;
  }

  if (node.isTube) {
    const r1 = node.innerRadius || 0.2;
    const r2 = node.outerRadius || 0.3;
    const h = node.height || 0.5;
    return `// Tube shape\ninner_r = ${r1.toFixed(3)}; // [0.05:0.05:2.0]\nouter_r = ${r2.toFixed(3)}; // [0.1:0.05:2.5]\nheight = ${h.toFixed(3)}; // [0.1:0.05:2.0]\ndifference() {\n  cylinder(h=height, r=outer_r, center=true, $fn=24);\n  cylinder(h=height + 0.02, r=inner_r, center=true, $fn=24);\n}`;
  }
  
  if (node.id.includes('gear')) {
    const r = geom.size?.[0] || 0.5;
    return `// Gear shape\nradius = ${r}; // [0.1:0.05:2.0]\ndifference() {\n  cylinder(h=0.08, r=radius, center=true, $fn=30);\n  cylinder(h=0.12, r=0.08, center=true, $fn=16);\n}`;
  }

  switch (geom.type) {
    case 'ellipsoid': {
      const rx = geom.size?.[0] || 0.3;
      const ry = geom.size?.[1] || 0.2;
      const rz = geom.size?.[2] || 0.15;
      return `// Ellipsoid shape\nrx = ${rx.toFixed(3)}; // [0.05:0.05:2.0]\nry = ${ry.toFixed(3)}; // [0.05:0.05:2.0]\nrz = ${rz.toFixed(3)}; // [0.05:0.05:2.0]\nscale([rx, ry, rz]) sphere(r=1, $fn=24);`;
    }
    case 'box': {
      const sx = (geom.size?.[0] || 0.2) * 2;
      const sy = (geom.size?.[1] || 0.2) * 2;
      const sz = (geom.size?.[2] || 0.2) * 2;
      return `// Box shape\nsx = ${sx.toFixed(3)}; // [0.1:0.05:3.0]\nsy = ${sy.toFixed(3)}; // [0.1:0.05:3.0]\nsz = ${sz.toFixed(3)}; // [0.1:0.05:3.0]\ncube([sx, sy, sz], center=true);`;
    }
    case 'sphere': {
      const r = geom.size?.[0] || 0.2;
      return `// Sphere shape\nradius = ${r.toFixed(3)}; // [0.1:0.05:2.0]\nsphere(r=radius, $fn=24);`;
    }
    case 'cylinder': {
      const r = geom.size?.[0] || 0.2;
      const h = (geom.size?.[1] || 0.1) * 2;
      return `// Cylinder shape\nradius = ${r.toFixed(3)}; // [0.1:0.05:2.0]\nheight = ${h.toFixed(3)}; // [0.1:0.05:3.0]\ncylinder(h=height, r=radius, center=true, $fn=24);`;
    }
    case 'capsule': {
      const r = geom.size?.[0] || 0.04;
      const h = geom.size?.[1] || 0.2;
      return `// Capsule shape\nradius = ${r.toFixed(3)}; // [0.01:0.01:1.0]\nheight = ${h.toFixed(3)}; // [0.05:0.05:2.0]\nhull() {\n  translate([0, 0, -height]) sphere(r=radius, $fn=16);\n  translate([0, 0, height]) sphere(r=radius, $fn=16);\n}`;
    }
    case 'mesh': {
      return `// Mesh geometry representation\n// Note: editing this will overwrite the manual vertices\ncube([0.5, 0.5, 0.5], center=true);`;
    }
    default:
      return `// Primitive shape (${geom.type})\ncube([0.4, 0.4, 0.4], center=true);`;
  }
}

interface ScadVariable {
  name: string;
  value: number;
  min: number;
  max: number;
  step: number;
  lineIndex: number;
}

function parseScadVariables(code: string): ScadVariable[] {
  const variables: ScadVariable[] = [];
  if (!code) return variables;
  const lines = code.split('\n');
  let braceDepth = 0;

  const varRegex = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(-?\d+(?:\.\d+)?)\s*;\s*(?:\/\/\s*\[\s*(-?\d+(?:\.\d+)?)(?::(-?\d+(?:\.\d+)?))?:\s*(-?\d+(?:\.\d+)?)\s*\])?/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const openBraces = (line.match(/{/g) || []).length;
    const closeBraces = (line.match(/}/g) || []).length;

    if (braceDepth === 0) {
      const match = line.match(varRegex);
      if (match) {
        const name = match[1];
        const value = parseFloat(match[2]);
        const parsedStep = match[4] ? parseFloat(match[4]) : undefined;

        const min = value === 0 ? -0.2 : value - Math.abs(value) * 0.2;
        const max = value === 0 ? 0.2 : value + Math.abs(value) * 0.2;
        let step = parsedStep;
        if (step === undefined) {
          const range = max - min;
          step = parseFloat((range / 100).toPrecision(2));
        }

        variables.push({
          name,
          value,
          min,
          max,
          step: step || 0.01,
          lineIndex: i
        });
      }
    }

    braceDepth += openBraces - closeBraces;
  }

  return variables;
}

function replaceVarInCode(code: string, varName: string, newValue: number): string {
  const lines = code.split('\n');
  let braceDepth = 0;
  const varRegex = new RegExp(`^(\\s*${varName}\\s*=\\s*)-?\\d+(?:\\.\\d+)?`);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const openBraces = (line.match(/{/g) || []).length;
    const closeBraces = (line.match(/}/g) || []).length;
    if (braceDepth === 0) {
      const match = line.match(varRegex);
      if (match) {
        lines[i] = line.replace(varRegex, `$1${newValue}`);
        break;
      }
    }
    braceDepth += openBraces - closeBraces;
  }
  return lines.join('\n');
}

// Helper to find a node by ID in hierarchy
function findNodeById(nodes: SceneNode[], targetId: string): SceneNode | null {
  for (const node of nodes) {
    if (node.id === targetId) return node;
    if (node.children) {
      const res = findNodeById(node.children, targetId);
      if (res) return res;
    }
  }
  return null;
}

// Helper to get recursive world position of a node
function getNodeWorldPos(nodes: SceneNode[], targetId: string, currentOffset: [number, number, number] = [0, 0, 0]): [number, number, number] | null {
  for (const node of nodes) {
    const nodeWorld: [number, number, number] = [
      currentOffset[0] + node.pos[0],
      currentOffset[1] + node.pos[1],
      currentOffset[2] + node.pos[2]
    ];
    if (node.id === targetId) return nodeWorld;
    if (node.children) {
      const childResult = getNodeWorldPos(node.children, targetId, nodeWorld);
      if (childResult) return childResult;
    }
  }
  return null;
}

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

  const [isDocsOpen, setIsDocsOpen] = useState(false);
  const [showAICopilot, setShowAICopilot] = useState(false);
  const [docsTab, setDocsTab] = useState<DocsTabId>('gravity');
  const openDocs = useCallback((tab: DocsTabId) => { setDocsTab(tab); setIsDocsOpen(true); }, []);
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
      let res = await fetch('/api/anthropic/v1/models', { headers });
      if (!res.ok) {
        res = await fetch('https://api.anthropic.com/v1/models', { headers });
      }
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
      let res = await fetch(`/api/gemini/v1beta/models?key=${key.trim()}`);
      if (!res.ok) {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key.trim()}`);
      }
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
    undo, redo, undoStack, redoStack,
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
    undo: s.undo, redo: s.redo, undoStack: s.undoStack, redoStack: s.redoStack,
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

  // Collapsible properties cards drawer listener
  useEffect(() => {
    let active = true;
    
    const setupCollapse = () => {
      const aside = document.querySelector('aside.glass-panel');
      if (!aside || !active) return;

      // Inject indicator spans
      const headers = aside.querySelectorAll('div > h3');
      headers.forEach(h => {
        if (!h.querySelector('.collapse-indicator') && !h.closest('aside.glass-panel > h2')) {
          const indicator = document.createElement('span');
          indicator.className = 'collapse-indicator text-[9px] font-mono text-slate-400 dark:text-slate-500 ml-1.5 float-right font-normal normal-case';
          indicator.style.userSelect = 'none';
          indicator.textContent = ' [−]';
          h.appendChild(indicator);
          const hHtml = h as HTMLElement;
          hHtml.style.cursor = 'pointer';
        }
      });
    };

    const timer = setTimeout(setupCollapse, 100);

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

    const asideContainer = document.querySelector('aside.glass-panel');
    if (asideContainer) {
      asideContainer.addEventListener('click', handleHeaderClick);
    }

    return () => {
      active = false;
      clearTimeout(timer);
      if (asideContainer) {
        asideContainer.removeEventListener('click', handleHeaderClick);
      }
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
  const loadPresetWithCard = useCallback((name: string) => {
    loadPreset(name);
    const builtinKey = name.startsWith('user:') ? null : name;
    const presetCard = builtinKey ? makePresetNoteCard(builtinKey) : null;
    setNoteCards(presetCard ? [presetCard] : []);
    setCopilotMessages([]);
    setEditingCardId(null);
  }, [loadPreset]);

  // Also load note cards from user presets (stored alongside the scene)
  const loadUserPresetWithCard = useCallback((name: string) => {
    loadPreset(name);
    try {
      const saved = readUserPreset(name);
      if (saved && Array.isArray(saved.noteCards)) {
        setNoteCards(saved.noteCards);
      } else {
        setNoteCards([]);
      }
      if (saved && Array.isArray(saved.copilotMessages)) {
        setCopilotMessages(saved.copilotMessages);
      } else {
        setCopilotMessages([]);
      }
    } catch {
      setNoteCards([]);
      setCopilotMessages([]);
    }
    setEditingCardId(null);
  }, [loadPreset]);

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
        if (result.ok) useStore.getState().setActivePreset(`user:${trimmed}`);
      });
      // A deliberate save is also a named revision of the cloud document, which
      // the pruner never discards — unlike the automatic checkpoints.
      void cloudAutosave.saveExplicit(trimmed, preset, `Saved as “${trimmed}”`);
    } catch (e) {
      console.error('Failed to save user preset', e);
    }
  }, [sceneGraph, model, data, mujoco, noteCards, copilotMessages]);

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

  const handleConfirmSavePreset = useCallback(() => {
    saveUserPresetByName(presetNameInput);
    setIsSaveModalOpen(false);
    setPresetNameInput('');
  }, [presetNameInput, saveUserPresetByName]);

  const exportJson = useCallback(() => {
    try {
      const syncedScene = getSyncedSceneGraph(sceneGraph, model, data, mujoco);
      const dataStr = JSON.stringify({ ...syncedScene, noteCards, copilotMessages }, null, 2);
      const blob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'physics_physbox_scene.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Failed to export JSON', e);
      alert('Failed to export JSON');
    }
  }, [sceneGraph, model, data, mujoco, noteCards, copilotMessages]);

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
          if (match && match[1].trim()) {
            baseName = match[1].trim().replace(/[*_`]/g, '').trim();
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
    setNoteCards(Array.isArray(parsed.noteCards) ? parsed.noteCards as NoteCard[] : []);
    setCopilotMessages(Array.isArray(parsed.copilotMessages) ? parsed.copilotMessages as CopilotMessage[] : []);
    setEditingCardId(null);
  }, [togglePlay, updateScene]);

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

  const handleSimplifyMesh = useCallback((g: SceneGeom) => {
    try {
      setMeshSimplifierError(null);
      if (!g.vertices || g.vertices.length < 9) {
        throw new Error('Not enough vertices to simplify (need at least 3 triangles / 9 coordinates).');
      }

      // 1. Weld/deduplicate vertices first so that the edge collapse algorithm works properly on a connected mesh
      const uniqueInputVerts: number[] = [];
      const inputFaces: number[] = [];
      const inputVertMap = new Map<string, number>();

      for (let i = 0; i < g.vertices.length; i += 3) {
        const x = g.vertices[i];
        const y = g.vertices[i + 1];
        const z = g.vertices[i + 2];
        const key = `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
        let idx = inputVertMap.get(key);
        if (idx === undefined) {
          idx = uniqueInputVerts.length / 3;
          uniqueInputVerts.push(x, y, z);
          inputVertMap.set(key, idx);
        }
      }

      if (g.faces && g.faces.length > 0) {
        for (let i = 0; i < g.faces.length; i++) {
          const oldIdx = g.faces[i];
          const vx = g.vertices[oldIdx * 3];
          const vy = g.vertices[oldIdx * 3 + 1];
          const vz = g.vertices[oldIdx * 3 + 2];
          const key = `${vx.toFixed(5)},${vy.toFixed(5)},${vz.toFixed(5)}`;
          inputFaces.push(inputVertMap.get(key)!);
        }
      } else {
        // If not indexed, build faces sequentially
        for (let i = 0; i < g.vertices.length; i += 3) {
          const x = g.vertices[i];
          const y = g.vertices[i + 1];
          const z = g.vertices[i + 2];
          const key = `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
          inputFaces.push(inputVertMap.get(key)!);
        }
      }

      // 2. Create a THREE.BufferGeometry from the welded geometry
      const geometry = new THREE.BufferGeometry();
      const positionArray = new Float32Array(uniqueInputVerts);
      geometry.setAttribute('position', new THREE.BufferAttribute(positionArray, 3));
      geometry.setIndex(inputFaces);

      // 3. Compute the number of vertices to remove
      const originalVertexCount = uniqueInputVerts.length / 3;
      const targetCount = Math.max(4, Math.floor(originalVertexCount * simplifyRatio));
      const countToRemove = originalVertexCount - targetCount;

      if (countToRemove <= 0) {
        throw new Error('Already at or below target vertex count. Try a lower quality/ratio.');
      }

      // 4. Apply the SimplifyModifier
      const modifier = new SimplifyModifier();
      const simplifiedGeometry = modifier.modify(geometry, countToRemove);
      
      const simplifiedPositions = simplifiedGeometry.attributes.position.array;
      const simplifiedIndex = simplifiedGeometry.index ? simplifiedGeometry.index.array : null;
      if (!simplifiedPositions || simplifiedPositions.length === 0) {
        throw new Error('Simplification produced an empty geometry.');
      }

      // 5. Extract the resulting vertices and faces using the index array from SimplifyModifier
      const uniqueVerts: number[] = [];
      const faces: number[] = [];
      const vertMap = new Map<number, number>();

      if (simplifiedIndex) {
        for (let i = 0; i < simplifiedIndex.length; i++) {
          const oldIdx = simplifiedIndex[i];
          let newIdx = vertMap.get(oldIdx);
          if (newIdx === undefined) {
            newIdx = uniqueVerts.length / 3;
            const vx = simplifiedPositions[oldIdx * 3];
            const vy = simplifiedPositions[oldIdx * 3 + 1];
            const vz = simplifiedPositions[oldIdx * 3 + 2];
            uniqueVerts.push(
              Number(vx.toFixed(5)),
              Number(vy.toFixed(5)),
              Number(vz.toFixed(5))
            );
            vertMap.set(oldIdx, newIdx);
          }
          faces.push(newIdx);
        }
      } else {
        // Fallback for non-indexed output
        const vertMapStr = new Map<string, number>();
        for (let i = 0; i < simplifiedPositions.length; i += 3) {
          const x = simplifiedPositions[i];
          const y = simplifiedPositions[i + 1];
          const z = simplifiedPositions[i + 2];
          const key = `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
          let idx = vertMapStr.get(key);
          if (idx === undefined) {
            idx = uniqueVerts.length / 3;
            uniqueVerts.push(
              Number(x.toFixed(5)),
              Number(y.toFixed(5)),
              Number(z.toFixed(5))
            );
            vertMapStr.set(key, idx);
          }
          faces.push(idx);
        }
      }

      if (uniqueVerts.length < 9) {
        throw new Error('Simplification reduced geometry below minimum visible threshold.');
      }

      // 6. Swap Y/Z coordinates for renderVertices if this is a dynamic mesh (MuJoCo space swap)
      let newRenderVerts: number[] | undefined;
      if (g.dynamic) {
        newRenderVerts = [];
        for (let i = 0; i < uniqueVerts.length; i += 3) {
          const x = uniqueVerts[i], y = uniqueVerts[i+1], z = uniqueVerts[i+2];
          newRenderVerts.push(+x.toFixed(5), +(-z).toFixed(5), +y.toFixed(5));
        }
      }

      // 7. Update the sceneGraph with the new simplified vertices/faces
      const newScene = cloneSceneGraph(useStore.getState().sceneGraph);
      const traverse = (nodes: SceneNode[]): boolean => {
        for (const node of nodes) {
          const idx = node.geoms?.findIndex((ng) => ng.name === g.name);
          if (idx >= 0) {
            node.geoms[idx] = {
              ...node.geoms[idx],
              vertices: uniqueVerts,
              faces,
              ...(newRenderVerts ? { renderVertices: newRenderVerts } : {})
            };
            return true;
          }
          if (traverse(node.children)) return true;
        }
        return false;
      };
      traverse(newScene.nodes);
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
                      ? 'bg-indigo-50 border-indigo-200 text-indigo-650 dark:bg-indigo-950/40 dark:border-indigo-800 dark:text-indigo-400 font-semibold' 
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
              value=""
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return;
                // A generator is not a preset: it opens a dialog and builds a
                // board from the stock already on the bench. It lives in this
                // list because this is where someone looks for "start me off
                // with something", which is what it is.
                if (v.startsWith('generator:')) openPatternGenerator(v.slice('generator:'.length));
                else if (v.startsWith('user:')) loadUserPresetWithCard(v);
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
              title="Save scene preset"
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

            <button
              onClick={undo}
              disabled={undoStack.length === 0}
              className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 disabled:opacity-30 disabled:hover:bg-transparent transition-colors focus:outline-none cursor-pointer"
              title="Undo"
            >
              <Undo className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={redo}
              disabled={redoStack.length === 0}
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
              onClick={() => setIsDocsOpen(true)}
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
              <button onClick={() => setSettingsOpen(false)}><X className="w-4 h-4 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 cursor-pointer" /></button>
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
                          <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
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
              className="col-span-2 p-2 border border-dashed border-violet-305 dark:border-violet-850 rounded-lg bg-violet-50/20 dark:bg-violet-955/10 flex items-center justify-center gap-2 cursor-pointer hover:border-violet-400 dark:hover:border-violet-700 hover:bg-violet-50/40 dark:hover:bg-violet-950/30 transition-all group select-none mt-1"
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
            {scadCompileCount > 0 && (
              <div className="bg-white/90 dark:bg-slate-900/90 text-slate-800 dark:text-slate-100 border border-slate-200/80 dark:border-slate-800/80 px-3.5 py-1.5 rounded-full shadow-md flex items-center gap-2.5 text-xs font-semibold backdrop-blur-md transition-all duration-300 pointer-events-auto">
                <div className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-405 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                </div>
                <Code className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400" />
                <span className="tracking-wide">SCAD Compiling</span>
              </div>
            )}
            {mcpActiveCount > 0 && (
              <div className="bg-white/90 dark:bg-slate-900/90 text-slate-800 dark:text-slate-100 border border-slate-200/80 dark:border-slate-800/80 px-3.5 py-1.5 rounded-full shadow-md flex items-center gap-2.5 text-xs font-semibold backdrop-blur-md transition-all duration-300 pointer-events-auto">
                <div className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-405 opacity-75"></span>
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
                  : 'text-slate-655 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
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
                  : 'text-slate-655 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
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
                  : 'text-slate-655 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
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
                  : 'text-slate-655 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
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
                <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 flex items-center justify-between">
                  <span>Position Offset</span>
                  <DocsInfoButton tab="offset" onOpen={openDocs} />
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
                      min="-10" 
                      max="10" 
                      step="0.001" 
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
                      min="-10" 
                      max="10" 
                      step="0.001" 
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
                          min="0"
                          max="10"
                          step="0.001"
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

              {/* Scale. Beside position and rotation because it is the third
                  thing you do to a component and the fourth pane down is a long
                  way to go for it — the Resize Component card further down keeps
                  the same control alongside the per-primitive dimensions.
                  Every kind of body, in the same place and with the same
                  control — a primitive is asked in its own terms (a cylinder's
                  radius is X and Y, its length is Z) and a generated shape has
                  the numbers it was generated FROM scaled too, so nothing
                  springs back the next time a parameter is touched. A gear is
                  the exception: it is defined by its tooth count and has to
                  stay in step with whatever it runs against. */}
              {selectedNode.teeth === undefined && <ScaleCard nodeId={selectedNode.id} />}

              {/* Joint Type Configuration */}
              <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
                <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center justify-between">
                  <span className="flex items-center gap-1">🔗 Joint Type</span>
                  <DocsInfoButton tab="gravity" onOpen={openDocs} />
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
                    <h3 className="text-xs font-semibold text-slate-600 mb-1 flex items-center justify-between">
                      <span>Launch Velocity (m/s)</span>
                      <DocsInfoButton tab="launch" onOpen={openDocs} size="w-3 h-3" />
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

                    <h3 className="text-xs font-semibold text-slate-600 mt-2 mb-1 pt-2 border-t border-slate-100 flex items-center justify-between">
                      <span>Launch Spin / Angular Velocity (rad/s)</span>
                      <DocsInfoButton tab="launch" onOpen={openDocs} size="w-3 h-3" />
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
                      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center justify-between">
                        <span className="flex items-center gap-1">🔗 Joint Damping</span>
                        <DocsInfoButton tab="damping" onOpen={openDocs} />
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
                        <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center justify-between">
                          <span className="flex items-center gap-1">🪗 Crumple Zone</span>
                          {given
                            ? <span className="text-[10px] font-semibold text-amber-600">folded</span>
                            : <DocsInfoButton tab="breaking" onOpen={openDocs} />}
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
                      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center justify-between">
                        <span className="flex items-center gap-1">🌸 Joint Springs</span>
                        <DocsInfoButton tab="springs" onOpen={openDocs} />
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
                      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center justify-between">
                        <span className="flex items-center gap-1">🔒 Joint Limits</span>
                        <DocsInfoButton tab="springs" onOpen={openDocs} />
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

                    {!selectedNode.id.includes('gear') && (
                      <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-3">
                        <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 flex items-center justify-between">
                          <span className="flex items-center gap-1">📏 Resize Component</span>
                          <DocsInfoButton tab="resize" onOpen={openDocs} />
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
                              }} decimals={2} unit="m" min={0.05} max={2.0} /></label>
                            <RangeInput 
                              min="0.05" 
                              max="2.0" 
                              step="0.01" 
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
                                }} decimals={2} unit="m" min={0.5} max={5.0} /></label>
                              <RangeInput 
                                min="0.5" 
                                max="5.0" 
                                step="0.05" 
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
                                }} decimals={2} unit="m" min={0.2} max={4.0} /></label>
                              <RangeInput 
                                min="0.2" 
                                max="4.0" 
                                step="0.05" 
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
                                }} decimals={2} unit="m" min={0.1} max={3.0} /></label>
                              <RangeInput 
                                min="0.1" 
                                max="3.0" 
                                step="0.05" 
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
                                }} decimals={2} unit="m" min={0.1} max={3.0} /></label>
                              <RangeInput 
                                min="0.1" 
                                max="3.0" 
                                step="0.01" 
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
                                }} decimals={2} unit="m" min={0.1} max={3.0} /></label>
                              <RangeInput 
                                min="0.1" 
                                max="3.0" 
                                step="0.01" 
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
                                }} decimals={2} unit="m" min={0.1} max={3.0} /></label>
                              <RangeInput 
                                min="0.1" 
                                max="3.0" 
                                step="0.01" 
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
                                }} decimals={2} unit="m" min={0.05} max={2.0} /></label>
                              <RangeInput 
                                min="0.05" 
                                max="2.0" 
                                step="0.01" 
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
                                }} decimals={2} unit="m" min={0.1} max={3.0} /></label>
                              <RangeInput 
                                min="0.1" 
                                max="3.0" 
                                step="0.01" 
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
                                }} decimals={2} unit="m" min={0.1} max={3.0} /></label>
                              <RangeInput 
                                min="0.1" 
                                max="3.0" 
                                step="0.01" 
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
                                }} decimals={2} unit="m" min={0.02} max={1.0} /></label>
                              <RangeInput 
                                min="0.02" 
                                max="1.0" 
                                step="0.01" 
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
                                }} decimals={2} unit="m" min={0.02} /></label>
                              <RangeInput 
                                min="0.02" 
                                max={selectedNode.outerRadius ? selectedNode.outerRadius - 0.01 : 0.29} 
                                step="0.01" 
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
                                }} decimals={2} unit="m" max={2.0} /></label>
                              <RangeInput 
                                min={selectedNode.innerRadius ? selectedNode.innerRadius + 0.01 : 0.21} 
                                max="2.0" 
                                step="0.01" 
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
                                }} decimals={2} unit="m" min={0.1} max={3.0} /></label>
                              <RangeInput 
                                min="0.1" 
                                max="3.0" 
                                step="0.01" 
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
                                }} decimals={2} unit="m" min={0.1} max={2.0} /></label>
                              <RangeInput
                                min="0.1"
                                max="2.0"
                                step="0.01"
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
                                }} decimals={2} unit="m" min={0.02} max={0.4} /></label>
                              <RangeInput
                                min="0.02"
                                max="0.4"
                                step="0.01"
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
                                }} decimals={2} unit="m" min={0.05} max={2.0} /></label>
                              <RangeInput 
                                min="0.05" 
                                max="2.0" 
                                step="0.01" 
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
                                }} decimals={2} unit="m" min={0.05} max={2.0} /></label>
                              <RangeInput 
                                min="0.05" 
                                max="2.0" 
                                step="0.01" 
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
                                }} decimals={2} unit="m" min={0.05} max={2.0} /></label>
                              <RangeInput 
                                min="0.05" 
                                max="2.0" 
                                step="0.01" 
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
                                }} decimals={2} unit="m" min={0.05} max={2.0} /></label>
                              <RangeInput 
                                min="0.05" 
                                max="2.0" 
                                step="0.01" 
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
                                }} decimals={2} unit="m" min={0.05} max={2.0} /></label>
                              <RangeInput 
                                min="0.05" 
                                max="2.0" 
                                step="0.01" 
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
                                }} decimals={2} unit="m" min={0.05} max={2.0} /></label>
                              <RangeInput 
                                min="0.05" 
                                max="2.0" 
                                step="0.01" 
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
                                }} decimals={3} unit="m" min={0.01} max={0.8} /></label>
                              <RangeInput 
                                min="0.01" 
                                max="0.8" 
                                step="0.005" 
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
                                  }} decimals={2} unit="m" min={0.05} max={3.0} /></label>
                                <RangeInput 
                                  min="0.05" 
                                  max="3.0" 
                                  step="0.01" 
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
                                    }} decimals={2} unit="m" min={0.1} max={5.0} />
                                  </label>
                                  <RangeInput 
                                    min="0.1" 
                                    max="5.0" 
                                    step="0.05" 
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

                    {/* Position Offset Control for Sub-Geom */}
                    {(() => {
                      const pos = geom.pos || [0, 0, 0];
                      return (
                        <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-3">
                          <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 flex items-center justify-between">
                            <span className="flex items-center gap-1">📍 Geom Position Offset</span>
                            <DocsInfoButton tab="offset" onOpen={openDocs} />
                          </h3>
                          <div className="flex flex-col gap-3">
                            <div className="flex flex-col gap-1">
                              <label className="text-xs font-medium text-slate-500 flex justify-between">X Offset <SliderValue value={pos[0]} onChange={(v) => {
                                  const val = v;
                                  updateNodeGeom(selectedNode.id, { pos: [val, pos[1], pos[2]] }, activeIndex);
                                }} decimals={3} unit="m" min={-1.0} max={1.0} /></label>
                              <RangeInput 
                                min="-1.0" 
                                max="1.0" 
                                step="0.005" 
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
                                }} decimals={3} unit="m" min={-1.0} max={1.0} /></label>
                              <RangeInput 
                                min="-1.0" 
                                max="1.0" 
                                step="0.005" 
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
                                }} decimals={3} unit="m" min={-1.0} max={1.0} /></label>
                              <RangeInput 
                                min="-1.0" 
                                max="1.0" 
                                step="0.005" 
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
                      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center justify-between">
                        <span>Mass</span>
                        <DocsInfoButton tab="gravity" onOpen={openDocs} />
                      </h3>
                      <label className="text-xs font-medium text-slate-500 flex justify-between">Value <SliderValue value={geom.mass ?? 0} onChange={(v) => updateNodeGeom(selectedNode.id, {mass: v}, activeIndex)} decimals={2} unit="kg" min={0} max={50} /></label>
                      <RangeInput min="0" max="50" step="0.01" value={geom.mass ?? 0} onChange={(v) => updateNodeGeom(selectedNode.id, {mass: v}, activeIndex)} className="w-full accent-blue-500 cursor-pointer" />
                      
                      {(() => {
                        let volM3 = 0;
                        const sz = geom.size || [0.1, 0.1, 0.1];
                        if (geom.type === 'sphere') {
                          volM3 = (4 / 3) * Math.PI * Math.pow(sz[0], 3);
                        } else if (geom.type === 'cylinder') {
                          volM3 = Math.PI * Math.pow(sz[0], 2) * (sz[1] * 2);
                        } else if (geom.type === 'capsule') {
                          volM3 = (4 / 3) * Math.PI * Math.pow(sz[0], 3) + Math.PI * Math.pow(sz[0], 2) * (sz[1] * 2);
                        } else if (geom.type === 'box') {
                          volM3 = 8 * sz[0] * (sz[1] ?? sz[0]) * (sz[2] ?? sz[0]);
                        } else if (geom.type === 'ellipsoid') {
                          volM3 = (4 / 3) * Math.PI * sz[0] * (sz[1] ?? sz[0]) * (sz[2] ?? sz[0]);
                        }
                        if (volM3 <= 0) return null;
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
                      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center justify-between">
                        <span className="flex items-center gap-1">💥 Collision Physics</span>
                        <DocsInfoButton tab="collision" onOpen={openDocs} />
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
                      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center justify-between">
                        <span className="flex items-center gap-1">🧪 Physical Material</span>
                        <DocsInfoButton tab="material" onOpen={openDocs} />
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
                        <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center justify-between">
                          <span className="flex items-center gap-1">⚙️ Mechanical Coupling</span>
                          <DocsInfoButton tab="coupling" onOpen={openDocs} />
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

              {/* Boolean Modifiers (CSG) — subtract/intersect one primitive with another */}
              {(() => {
                const source = csgSourceGeoms(selectedNode);
                const solids = source.filter((g) => g.type !== 'plane');
                const ops = source.filter((g) => g.csg === 'difference' || g.csg === 'intersection');
                const isCsg = !!selectedNode.csgEnabled && ops.length > 0;
                // Offer the section on anything made of primitives; a body that's
                // already a single hand-authored mesh has nothing to boolean with.
                if (!isCsg && (solids.length === 0 || selectedNode.scad !== undefined || selectedNode.isCurve || selectedNode.isPulleyRope)) return null;

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
                                const traverse = (nodes: SceneNode[]): boolean => { for (const node of nodes) { const idx = node.geoms?.findIndex((ng) => ng.name === g.name); if (idx >= 0) { node.geoms[idx] = {...node.geoms[idx], vertices: newVerts, faces: filteredFaces}; return true; } if (traverse(node.children)) return true; } return false; };
                                traverse(newScene.nodes);
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
                                    let newRenderVerts: number[] | undefined;
                                    if (g.dynamic) {
                                      newRenderVerts = [];
                                      for (let i = 0; i < newVerts.length; i += 3) {
                                        const x = newVerts[i], y = newVerts[i+1], z = newVerts[i+2];
                                        newRenderVerts.push(+x.toFixed(5), +(-z).toFixed(5), +y.toFixed(5));
                                      }
                                    }
                                    const newScene = cloneSceneGraph(useStore.getState().sceneGraph);
                                    const traverse = (nodes: SceneNode[]): boolean => {
                                      for (const node of nodes) {
                                        const idx = node.geoms?.findIndex((ng) => ng.name === g.name);
                                        if (idx >= 0) {
                                          node.geoms[idx] = {...node.geoms[idx], vertices: newVerts, faces: newFaces, ...(newRenderVerts ? {renderVertices: newRenderVerts} : {})};
                                          return true;
                                        }
                                        if (traverse(node.children)) return true;
                                      }
                                      return false;
                                    };
                                    traverse(newScene.nodes);
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
                                    onClick={() => handleSimplifyMesh(g)}
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
                                {Number((slidingValues[v.name] ?? v.value).toFixed(2))}
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-[9px] text-slate-400 font-mono w-8 text-right">{Number(v.min.toFixed(2))}</span>
                              <RangeInput
                                min={v.min}
                                max={v.max}
                                step={v.step}
                                value={slidingValues[v.name] ?? v.value}
                                onChange={(next) => {
                                  const val = Number(next.toFixed(2));
                                  setSlidingValues(prev => ({ ...prev, [v.name]: val }));
                                  debouncedUpdateCode();
                                }}
                                className="flex-1 h-1 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-violet-600"
                              />
                              <span className="text-[9px] text-slate-400 font-mono w-8">{Number(v.max.toFixed(2))}</span>
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
        // Above the export modals (z-50), which render later in the DOM and
        // would otherwise paint over the docs they just opened.
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-100 shadow-2xl max-w-2xl w-full max-h-[85dvh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-slate-150 flex items-center justify-between bg-slate-50">
              <div className="flex items-center gap-2">
                <Info className="w-5 h-5 text-blue-500" />
                <h2 className="font-bold text-slate-800 text-base">PhysBox Reference Guide</h2>
              </div>
              <button 
                onClick={() => setIsDocsOpen(false)}
                className="p-1 rounded-lg hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Content Split */}
            <div className="flex flex-1 overflow-hidden min-h-0">
              {/* Tab Navigation */}
              {/* The tab rail keeps every section reachable on a phone rather
                  than collapsing into a picker, but at a width that leaves the
                  prose it navigates worth reading. */}
              <div className="w-48 max-sm:w-28 bg-slate-50 border-r border-slate-150 p-3 max-sm:p-2 flex flex-col gap-1 shrink-0 overflow-y-auto">
                {DOCS_TABS.map(({ group, items }) => (
                  <div key={group} className="flex flex-col gap-1 mb-1.5">
                    <span className="px-1 pt-1.5 text-[9px] font-bold uppercase tracking-wider text-slate-400">{group}</span>
                    {items.map(({ id, label }) => (
                      <button
                        key={id}
                        onClick={() => setDocsTab(id)}
                        className={`px-3 py-1.5 text-left rounded-lg text-xs font-semibold transition-all ${docsTab === id ? 'bg-blue-500 text-white shadow' : 'text-slate-600 hover:bg-slate-100'}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                ))}
              </div>

              {/* Tab Panel */}
              <div className="flex-1 p-6 max-sm:p-4 overflow-y-auto min-w-0">
                {docsTab === 'gravity' && (
                  <div className="flex flex-col gap-4">
                    <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">🪐 Gravity, Active Joints & Inertia</h3>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Gravity pulls downward along the Z axis. How a component reacts depends on its <strong>joints</strong> and <strong>inertia</strong>:
                    </p>
                    <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                      <div className="text-xs">
                        <strong className="text-slate-700">🌍 Static Elements (No Joints)</strong>
                        <p className="text-slate-500 mt-1">Shelves, pegs, and support structures have no joints. The solver treats them as having infinite mass welded directly to the world body, so gravity never moves them.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">⚙️ Hinge Gears (Rotational Hinge Joints)</strong>
                        <p className="text-slate-500 mt-1">A gear turns about a single pivot. Gravity acts through the pivot of a symmetrical gear, so it produces no torque about the axis and the gear does not turn on its own.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">📦 Unconstrained Bodies (Free Joints)</strong>
                        <p className="text-slate-500 mt-1">A body with a free joint moves in all six degrees of freedom and falls under gravity.</p>
                      </div>
                    </div>
                  </div>
                )}

                {docsTab === 'coupling' && (
                  <div className="flex flex-col gap-4">
                    <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">⚙️ Mechanical Joint Coupling</h3>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Gears and pinion-racks are driven by a joint constraint rather than by tooth-on-tooth contact.
                    </p>
                    <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                      <div className="text-xs">
                        <strong className="text-slate-700">⚡ Tooth contact</strong>
                        <p className="text-slate-500 mt-1">Rigid teeth overlap slightly between time steps. Resolving those penetrations produces large impulses that make gears lock up, vibrate, or fly apart.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">🔗 Joint coupling</strong>
                        <p className="text-slate-500 mt-1">A bilateral joint constraint ties the two joint rates together by the gear ratio, giving smooth and stable transmission at any speed.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">🎯 Proximity</strong>
                        <p className="text-slate-500 mt-1">Gears and pinion-racks only couple when they are close enough to mesh. Untick <strong>Allow Mechanical Coupling</strong> in the sidebar to turn the constraint off for a body.</p>
                      </div>
                    </div>
                  </div>
                )}

                {docsTab === 'collision' && (
                  <div className="flex flex-col gap-4">
                    <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">💥 Solid and Ephemeral Bodies</h3>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      A component can be a solid obstacle or a visual-only guide:
                    </p>
                    <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                      <div className="text-xs">
                        <strong className="text-slate-700">🛑 Solid Mode (Collision Enabled)</strong>
                        <p className="text-slate-500 mt-1">The body takes part in contact. It blocks and pushes other objects.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">👻 Ephemeral Mode (Collision Disabled)</strong>
                        <p className="text-slate-500 mt-1">Sets <code>contype="0"</code> and <code>conaffinity="0"</code>. Other bodies pass straight through it. Use it for decorative supports or visual guides.</p>
                      </div>
                    </div>
                  </div>
                )}

                {docsTab === 'breaking' && (
                  <div className="flex flex-col gap-4">
                    <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">💔 Breaking</h3>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      A weld can be given a limit, past which it shears off and the part
                      falls away carrying the momentum it already had.
                    </p>
                    <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                      <div className="text-xs">
                        <strong className="text-slate-700">⚖️ What the numbers mean</strong>
                        <p className="text-slate-500 mt-1">
                          MuJoCo reports the force it is spending to hold every weld, so the
                          limits are real newtons rather than a made-up scale. A 1 kg body
                          hanging off a weld pulls about 10 N. A few hundred newtons is a
                          sturdy joint; a few tens is decorative.
                        </p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">↩️ Breaking is not an edit</strong>
                        <p className="text-slate-500 mt-1">
                          The saved scene still says the part is welded on, so nothing you
                          export or share is changed by a break, and it never enters the undo
                          history. <strong>Reset</strong> puts the object back together;
                          pausing does not, because a break you cannot stop and look at is no
                          use. <strong>Restore</strong> on a broken weld puts back that one
                          joint, where the body is now.
                        </p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">🧱 Materials</strong>
                        <p className="text-slate-500 mt-1">
                          The <strong>Deformation</strong> card sets shattering and denting
                          together. Pick a material and it fills in numbers that belong
                          together, plus the density, so the body weighs what it is made of.
                          Glass shatters and never dents; steel dents and never shatters;
                          plastic and wood can do both. A material's breaking point is a
                          speed, so a glass marble and a glass tabletop both break from the
                          same drop. Glass, ceramic and stone also care how thick they are
                          where they are hit, so a wine glass breaks on its thin bowl from a
                          knock its foot would shrug off. Change any number and the material
                          becomes Custom.
                        </p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">💥 Shattering</strong>
                        <p className="text-slate-500 mt-1">
                          A brittle body breaks up when it takes a hard enough blow, measured
                          as <em>impulse</em> — momentum — rather than force, so the number
                          means the same thing whatever the solver is doing. A 200 g body
                          arriving at 5 m/s and stopping dead is about 1 N·s. The pieces are
                          cut from the body's own outline and add up to exactly what broke,
                          each carrying the velocity of the part of the body it used to be.
                        </p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">🔨 Denting</strong>
                        <p className="text-slate-500 mt-1">
                          A surface with a yield takes a permanent crater from anything that
                          crosses it, and nothing at all from anything that does not — which
                          is the half worth watching for. Two identical weights dropped from
                          the same height onto the same plate, one hard and one soft, land
                          the same momentum over very different lengths of time, and only one
                          of them leaves a mark. The crater takes its width and its shape from
                          whatever made it — a flat-ended slug leaves a flat-bottomed pit its
                          own width — and spreads wider as well as deeper the harder the blow.
                          <strong> Dents are cosmetic:</strong> contact
                          keeps using the undented shape, because feeding a deformed mesh back
                          to the solver means rebuilding the model.
                        </p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">🕳️ Piercing</strong>
                        <p className="text-slate-500 mt-1">
                          Past a second, higher limit a surface is not creased but holed: the
                          material under the striker is gone rather than pushed aside. Keep it
                          well above the yield, or there is no range left in which the thing
                          behaves like a sheet. Cosmetic in the same way a dent is — contact
                          keeps using the whole surface, so something can rest on the hole it
                          just made.
                        </p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">⚙️ Real damage, if you want it</strong>
                        <p className="text-slate-500 mt-1">
                          By default a dent or a hole is seen and not felt — contact goes on
                          using the undamaged shape. <strong>Damage is real, not just
                          seen</strong> changes that: things fall through the holes, and an
                          edge worn away stops holding what it used to. It is slow on purpose.
                          Damage reaches the solver by rebuilding the model, and the surface
                          then has to be broken into convex pieces as well, because MuJoCo
                          collides a mesh as its convex hull — and a hull fills every crater
                          and every hole straight back in, which would give you a body that
                          looks worn and collides like new.
                        </p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">🪗 Crumple zones</strong>
                        <p className="text-slate-500 mt-1">
                          A hinge that is rigid until the torque on it passes a limit, and
                          then folds and <em>stays</em> folded — a car's crumple zone rather
                          than a spring. It costs almost nothing because it is not a new
                          mechanism: the joint is held still by a weld, and giving way is the
                          same release that shears a handle off. Note that a joint only folds
                          if something is still loading it afterwards; a post standing
                          straight up gives gravity no lever, so once its base yields it just
                          goes on standing there.
                        </p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">⏱️ Why there is a hold</strong>
                        <p className="text-slate-500 mt-1">
                          A hard contact makes the solver spike for a single step while it
                          resolves the overlap. A limit read one step at a time would snap
                          welds that were never really loaded, so the overload has to last a
                          few steps — about 3 ms — before it counts.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                 {docsTab === 'friction' && (
                  <div className="flex flex-col gap-4">
                    <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">🛷 Friction</h3>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Friction coefficients set how easily objects slide against each other:
                    </p>
                    <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                      <div className="text-xs">
                        <strong className="text-slate-700">🌍 Floor Friction</strong>
                        <p className="text-slate-500 mt-1">The grip of the ground plane. 0.0 is frictionless; higher values give more traction.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">📦 Component Friction</strong>
                        <p className="text-slate-500 mt-1">The sliding friction coefficient of the selected body. Lower values slip more easily; higher values grip.</p>
                      </div>
                    </div>
                  </div>
                )}

                {docsTab === 'scripting' && (
                  <div className="flex flex-col gap-4">
                    <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">💻 Control Scripting & Joint Names</h3>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Custom JavaScript control scripts run inside the physics solver loop on every physics time-step. To query state or apply forces, you pass string-based <strong>body names</strong> or <strong>joint names</strong> to the API.
                    </p>
                    
                    <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-4">
                      <div className="text-xs">
                        <strong className="text-slate-800 font-semibold flex items-center gap-1">🏷️ Where do joint & body names come from?</strong>
                        <p className="text-slate-500 mt-1 leading-relaxed">
                          All names map directly to the values you configure in the <strong>Properties Panel</strong> when a component is selected:
                        </p>
                        <ul className="list-disc pl-4 mt-1.5 text-slate-500 flex flex-col gap-1">
                          <li><strong>Body Names:</strong> Equal to the <strong>Component Name</strong> at the top of the properties panel (e.g. <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">"cart"</code> or <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">"pole"</code>).</li>
                          <li><strong>Joint Names:</strong> Configured in the <strong>Joint Name (for API)</strong> text input under the <strong>🔗 Joint Type</strong> card (e.g. <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">"cart_slide"</code> or <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">"pole_hinge"</code>).</li>
                          <li><strong>Actuator/Motor Names:</strong> If you select "Enable Motor Drive", the actuator is automatically named by appending <code className="font-mono">_actuator</code> to the joint name (e.g. <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">"cart_slide_actuator"</code>).</li>
                        </ul>
                      </div>

                       <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-800 font-semibold">🔄 Retrieving Sensor Data & Key Inputs</strong>
                        <p className="text-slate-500 mt-1 leading-relaxed">
                          Use the following API methods in your script:
                        </p>
                        <pre className="mt-2 bg-slate-950 text-emerald-400 p-2.5 rounded-lg font-mono text-[10px] leading-relaxed shadow-inner overflow-x-auto">
{`// 1. Get positions & velocities of components in world space
const [x, y, z] = api.getPosition('cart');
const [vx, vy, vz] = api.getVelocity('cart');

// 2. Get joint-aligned values (highly recommended for controls)
const position = api.getJointPosition('cart_slide'); // Slider: meters, Hinge: radians
const velocity = api.getJointVelocity('cart_slide'); // Slider: m/s, Hinge: rad/s

// 3. Check if keyboard key is active (excluding editor inputs)
const isSpacePressed = api.isKeyPressed('space'); // Supports: 'space', 'w', 'arrowup', etc.`}
                        </pre>
                      </div>
 
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-800 font-semibold">⚡ Applying Forces & Modifying State</strong>
                        <p className="text-slate-500 mt-1 leading-relaxed">
                          Apply forces directly, command motors, or override position/velocity state:
                        </p>
                        <pre className="mt-2 bg-slate-950 text-emerald-400 p-2.5 rounded-lg font-mono text-[10px] leading-relaxed shadow-inner overflow-x-auto">
{`// Apply torque or force aligned to the joint
api.applyJointForce('cart_slide', 15.5); // Applies linear force

// Command actuator motor velocity target
api.setActuatorControl('cart_slide_actuator', 1.0); // Drive cart at 1.0 m/s

// Directly set physical state (useful for resets or active launches)
api.setPosition([0, 0, 0.5], 'cart'); // Sets joint positions
api.setVelocity([0, 0, 5.0], 'cart'); // Sets linear velocities
api.setAngularVelocity([0, 15.0, 0], 'cart'); // Sets angular velocities`}
                        </pre>
                      </div>
                    </div>
                  </div>
                )}

                {docsTab === 'launch' && (
                  <div className="flex flex-col gap-4">
                    <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">🚀 Launch Velocity & Launch Spin</h3>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      These sliders set the <strong>initial conditions</strong> of a free body: the velocity it has at
                      the instant the simulation starts. They are not a continuous force: gravity, drag and contacts take over
                      immediately after t = 0. Press <strong>Reset</strong> to re-apply them.
                    </p>
                    <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                      <div className="text-xs">
                        <strong className="text-slate-700">➡️ Launch Velocity (m/s)</strong>
                        <p className="text-slate-500 mt-1">Linear velocity along each world axis. <strong>X</strong> is forward, <strong>Y</strong> is sideways, <strong>Z</strong> is up. Setting Z positive throws the body upward; it decelerates at <em>g</em> = 9.81 m/s² and peaks after <em>v/g</em> seconds.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">🌀 Launch Spin (rad/s)</strong>
                        <p className="text-slate-500 mt-1">Angular velocity about each axis: <strong>Roll</strong> (X), <strong>Pitch</strong> (Y), <strong>Yaw</strong> (Z). One full turn per second is 2π ≈ 6.28 rad/s. Spin is conserved in free flight, so a tumbling body keeps tumbling until something touches it.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">🎓 Why only free joints?</strong>
                        <p className="text-slate-500 mt-1">A free joint carries all 6 degrees of freedom, so all six numbers are meaningful. Hinge and slide joints have a single DOF, and their starting motion is set by the joint's own controls instead.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">🧪 Try it</strong>
                        <p className="text-slate-500 mt-1">Give a ball X = 6 m/s and Z = 6 m/s for a classic 45° projectile arc. Add Pitch spin and increase <em>rolling friction</em> in Physical Material to see the spin bite when it lands.</p>
                      </div>
                    </div>
                  </div>
                )}

                {docsTab === 'damping' && (
                  <div className="flex flex-col gap-4">
                    <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">🔗 Joint Damping</h3>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Damping is a resistive force proportional to <strong>velocity</strong>, like friction in
                      a hinge or air resistance on a pendulum. It always opposes motion, so it removes energy from the system and
                      never adds any.
                    </p>
                    <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                      <div className="text-xs">
                        <strong className="text-slate-700">📐 The maths</strong>
                        <p className="text-slate-500 mt-1">The joint feels a force <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">F = −c·v</code>, where <em>c</em> is this slider. Doubling the value roughly halves the time an oscillation takes to die away.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">🎚️ Choosing a value</strong>
                        <p className="text-slate-500 mt-1"><strong>0</strong> is a frictionless ideal joint that swings forever. Small values (0.1–1) give a realistic slowly-decaying pendulum. Large values (50+) make the joint feel like it is moving through treacle.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">📦 Free joints are different</strong>
                        <p className="text-slate-500 mt-1">On a free (6-DOF) body the slider tops out at 5.0 and acts as a general <strong>drag</strong> on both linear and angular motion, scaled by the body's own mass and inertia. It is a quick stand-in for air resistance.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">⚠️ Stability</strong>
                        <p className="text-slate-500 mt-1">Very large damping combined with a large timestep can overshoot and oscillate. If a joint starts buzzing, reduce damping before reaching for other fixes.</p>
                      </div>
                    </div>
                  </div>
                )}

                {docsTab === 'springs' && (
                  <div className="flex flex-col gap-4">
                    <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">🌸 Joint Springs & Limits</h3>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Springs pull a joint back toward a rest pose; limits stop it leaving a range entirely.
                    </p>
                    <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                      <div className="text-xs">
                        <strong className="text-slate-700">🌸 Spring Stiffness (K)</strong>
                        <p className="text-slate-500 mt-1">Restoring force per unit of displacement, <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">F = −K·(q − q₀)</code>. Higher K means a faster, tighter oscillation. With mass <em>m</em>, the natural frequency is <em>√(K/m)</em> rad/s.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">🎯 Spring Rest Position (q₀)</strong>
                        <p className="text-slate-500 mt-1">The pose the spring pulls toward, in degrees for a hinge or metres for a slider. With K = 0 this has no effect at all.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">🤝 Pair it with damping</strong>
                        <p className="text-slate-500 mt-1">A spring on its own oscillates forever. Add <strong>Joint Damping</strong> to get a realistic suspension: too little and it bounces, too much and it never returns. Critical damping is around <em>c = 2√(K·m)</em>.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">🔒 Joint Limits</strong>
                        <p className="text-slate-500 mt-1">A hard range the joint cannot travel beyond, like a knee that will not bend backwards or a drawer that stops when closed. Limits are enforced by the constraint solver, so they hold firmly without needing a huge spring.</p>
                      </div>
                    </div>
                  </div>
                )}

                {docsTab === 'material' && (
                  <div className="flex flex-col gap-4">
                    <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">🧪 Physical Material</h3>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Every contact is modelled as a stiff <strong>spring-damper</strong>.
                      These six numbers shape that contact, and together they decide whether a body feels like steel, rubber or ice.
                    </p>
                    <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                      <div className="text-xs">
                        <strong className="text-slate-700">⏱️ Contact Stiffness (<code className="font-mono">solref[0]</code>)</strong>
                        <p className="text-slate-500 mt-1">The contact spring's <em>time constant</em> in seconds: how long it takes to correct a penetration. <strong>Lower is stiffer.</strong> Keep it at or above 5× the timestep (≈ 0.005 s); going lower makes contacts explosive and jittery.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">🏀 Damping Ratio, Bounciness (<code className="font-mono">solref[1]</code>)</strong>
                        <p className="text-slate-500 mt-1"><strong>1.0</strong> is critically damped: the body lands dead with no bounce. Values below 1 are underdamped and bounce, and <strong>0</strong> bounces the most. Around <strong>0.2</strong> gives a lively rubber ball.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">🧱 Contact Impedance (<code className="font-mono">solimp[0]</code>)</strong>
                        <p className="text-slate-500 mt-1">How strictly the solver enforces non-penetration, from 0 (soft and squishy) to 1 (rigid). Higher values mean less visible sinking under heavy loads, at the cost of a harder problem to solve. 0.99 is a good default.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">🛷 Sliding Friction (<code className="font-mono">friction[0]</code>)</strong>
                        <p className="text-slate-500 mt-1">The classic Coulomb coefficient μ resisting tangential sliding. Ice is about 0.05, wood on wood about 0.4, rubber on tarmac over 1.0. A block only slides down a ramp once <em>tan θ &gt; μ</em>.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">🔄 Torsional Friction (<code className="font-mono">friction[1]</code>)</strong>
                        <p className="text-slate-500 mt-1">Resists spinning about the contact normal, like a coin pirouetting on its face. Values are small. Raise it to stop tops spinning forever.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">⚽ Rolling Friction (<code className="font-mono">friction[2]</code>)</strong>
                        <p className="text-slate-500 mt-1">Resists rolling. Without it a perfect sphere on a flat plane rolls forever. Values are tiny; 0.0001 is usually enough to bring a ball to rest.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">🤝 Contacts combine two bodies</strong>
                        <p className="text-slate-500 mt-1">Both surfaces contribute. A ball will not slide on a sticky floor no matter how slippery you make the ball, so check <strong>Floor Friction</strong> in the environment settings too.</p>
                      </div>
                    </div>
                  </div>
                )}

                {docsTab === 'resize' && (
                  <div className="flex flex-col gap-4">
                    <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">📏 Resize Component</h3>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Resizing changes the geometry the solver collides against, so it has real physical consequences beyond looks.
                    </p>
                    <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                      <div className="text-xs">
                        <strong className="text-slate-700">📐 Half-sizes, not full sizes</strong>
                        <p className="text-slate-500 mt-1">Following MuJoCo's convention, box dimensions are <strong>half-extents</strong>: a size of 0.2 makes a box 0.4 m wide. Sphere size is a radius; a capsule takes a radius and a half-length.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">⚖️ Mass does not follow size</strong>
                        <p className="text-slate-500 mt-1">Mass is set independently, so scaling a body up leaves it just as heavy unless you change it. Real objects scale as the <strong>cube</strong> of length (double the size, eight times the mass), so adjust Mass to match.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">🌀 Inertia is recomputed</strong>
                        <p className="text-slate-500 mt-1">The inertia tensor is derived from the geometry and mass, so a resized body genuinely becomes harder or easier to spin. A long thin rod resists rotation about its centre far more than a compact one.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">🔗 Scale on compound bodies</strong>
                        <p className="text-slate-500 mt-1">The <strong>Scale</strong> card scales every sub-geom <em>and</em> their position offsets and child bodies together, so an assembly keeps its shape. The factor is a multiplier on the current size, and returns to 1× after each Apply. Turn two of the X/Y/Z buttons off to stretch one axis alone; a sphere or a cylinder, having no per-axis radius, takes the average.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">⌨️ Or press S in the viewport</strong>
                        <p className="text-slate-500 mt-1">With a body selected, <kbd className="font-mono">S</kbd> scales it by pointer, <kbd className="font-mono">X</kbd>/<kbd className="font-mono">Y</kbd>/<kbd className="font-mono">Z</kbd> confines it to one axis, and <kbd className="font-mono">I</kbd> hollows it out. Use the card when you want to type an exact figure. See <strong>Scale, Inset &amp; Modal Keys</strong>.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">⚠️ Very small geoms</strong>
                        <p className="text-slate-500 mt-1">Anything below roughly 0.01 m can slip through other objects between timesteps (tunnelling). Prefer scaling the whole scene up over making one part tiny.</p>
                      </div>
                    </div>
                  </div>
                )}

                {docsTab === 'offset' && (
                  <div className="flex flex-col gap-4">
                    <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">📍 Geom Position Offset</h3>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      This moves a single <strong>geom</strong> within its body, rather than moving the body itself. It is the tool for
                      building compound shapes out of primitives.
                    </p>
                    <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                      <div className="text-xs">
                        <strong className="text-slate-700">🧩 Body frame vs world frame</strong>
                        <p className="text-slate-500 mt-1">The offset is measured in the body's own rotating frame. If the body tips over, the offset tips with it. <strong>Position Offset</strong> at the top of the panel moves the whole body in the world instead.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">⚖️ It shifts the centre of mass</strong>
                        <p className="text-slate-500 mt-1">A body's centre of mass is the mass-weighted average of its geoms. Pushing one heavy geom off to one side makes the body <strong>lopsided</strong>, so it will topple or swing rather than balance. This is how to build a weeble or a loaded die.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">🔗 Joints stay put</strong>
                        <p className="text-slate-500 mt-1">Offsetting a geom does not move the body's joint anchor. Sliding mass away from a hinge increases the gravitational torque about it, which is how you tune a pendulum's period without touching the joint.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">🧪 Try it</strong>
                        <p className="text-slate-500 mt-1">Add a second geom to a body, offset it upward, and give it a large mass. The body becomes top-heavy and will refuse to stand up.</p>
                      </div>
                    </div>
                  </div>
                )}

                {docsTab === 'lattice' && (
                  <div className="flex flex-col gap-4">
                    <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">🔲 Lattice Modelling</h3>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Lattice modelling is for crisp, dimensioned, hard-surface parts: a bracket, a housing, a mount,
                      anything that has to be exactly 40&nbsp;mm across and meet another part squarely. You place
                      points on a grid and build the shape by connecting them.
                    </p>

                    <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                      <div className="text-xs">
                        <strong className="text-slate-700">🧮 A vertex is three integers</strong>
                        <p className="text-slate-500 mt-1">Every corner sits on integer grid coordinates. Two corners with the same numbers are the same corner, so faces built at different times meet exactly, and mirroring is <code className="font-mono bg-slate-100 px-1 rounded">i → −i</code>.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">📏 The grid is decades: 0.1 / 1 / 10 / 100 mm</strong>
                        <p className="text-slate-500 mt-1">A corner placed on the 10&nbsp;mm grid is also on the 0.1&nbsp;mm grid. Lay a part out coarse, then switch to a finer grid for the details. Nothing already drawn moves.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">📄 The cage is the document</strong>
                        <p className="text-slate-500 mt-1">What you edit is the cage. The mesh on screen is derived from it: smoothed, walled, and recentred on its own centre of mass. A saved lattice body reopens with its cage intact. The smoothed mesh itself cannot be edited directly.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">✋ Nothing closes on its own</strong>
                        <p className="text-slate-500 mt-1">To finish a face, click back on the corner you started from (the cursor turns green), or press <kbd className="font-mono">Enter</kbd>. A face can have any number of corners.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">🔴 Red means you are seeing the back of a face</strong>
                        <p className="text-slate-500 mt-1">The editor draws front faces only. A face drawn from the wrong side shows red and will be a hole in anything you export. Press <kbd className="font-mono">N</kbd> to turn every face the right way out, or <kbd className="font-mono">F</kbd> to flip the selected one.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">📐 Select something and type its size</strong>
                        <p className="text-slate-500 mt-1">Select a face, an edge, a loop or a few corners and the panel's <strong>Dimensions</strong> box shows its size and position in millimetres, per axis. Type a <em>size</em> to scale the selection about its own middle, so both ends move and the rest of the part stays put. Type an <em>at</em> value to move the whole selection there. Both snap to the grid.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">🕳 Cut: holes at any diameter</strong>
                        <p className="text-slate-500 mt-1">Holes drawn on the grid have grid-sized diameters. For a bore at an exact size, such as 6.35&nbsp;mm for a bearing, use <strong>Cut</strong>. It subtracts a cylinder, box or sphere at a diameter you type. Select a face and the cut lands in the middle of it, square to the face at whatever angle it lies. Depth is measured into the material under the hole. Cut is available once the surface is closed or walled. The cage stays editable underneath, and a cut follows its face when you move it.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">⭕ Circles</strong>
                        <p className="text-slate-500 mt-1">The <strong>Circle</strong> tool (<kbd className="font-mono">4</kbd>) draws a polygon rounded to the grid; at 0.1&nbsp;mm it is within 0.05&nbsp;mm of a true arc. Click the centre, move out to size it, and click again. The <strong>Corners</strong> box sets how many sides: leave it on <em>auto</em> for a circle, or set 6 for a hex boss and 4 for a square post. The result is an ordinary face. Extrude it for a cylinder, bridge two of them for a taper, or type its diameter into <strong>Dimensions</strong>.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">🔄 Revolve</strong>
                        <p className="text-slate-500 mt-1"><strong>Revolve</strong> sweeps a profile round an axis for turned features: a boss, a spigot, a knob, the bell of a funnel. Select a run of edges for a shell or one face for a solid, pick the axis, and press <em>Turn</em>. The distance from the profile to the axis is the radius, so move the profile to change it. A profile point on the axis becomes the pole, which gives a cone. Less than 360° leaves an arc, capped at both ends.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">🪚 Chamfer and fillet, on an edge of the solid</strong>
                        <p className="text-slate-500 mt-1">Select an edge (<kbd className="font-mono">L</kbd> selects its whole loop), put a radius in the panel's <strong>Edge radius</strong> box, and press <kbd className="font-mono">B</kbd> to chamfer it or <kbd className="font-mono">R</kbd> to round it. A chamfer keeps its flat under smoothing. A fillet is left soft, so a pass of smoothing rounds it to about the radius you asked for.</p>
                      </div>
                    </div>

                    <h4 className="font-bold text-slate-700 text-sm mt-1">A worked example: the shelf bracket</h4>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Load the <strong>Wall Bracket (Lattice)</strong> preset to see the finished part, or build one:
                    </p>
                    <ol className="text-xs text-slate-600 leading-relaxed list-decimal ml-4 flex flex-col gap-1.5">
                      <li>Drop in a <strong>Lattice</strong> body. It starts as a 40&nbsp;mm box of six quads.</li>
                      <li>Press <kbd className="font-mono">2</kbd> for <em>Select</em>, click the front face, then drag it with the <em>Extrude</em> tool (<kbd className="font-mono">3</kbd>). It moves in whole grid steps; the status bar counts the millimetres.</li>
                      <li>Set the grid to <strong>1&nbsp;mm</strong> for the details. The coarse corners stay exactly where they are.</li>
                      <li>Select the end face and press <kbd className="font-mono">I</kbd>, then move the pointer to size the inset and click. Extrude the inner face inward for a recess, or straight through for a slot.</li>
                      <li>Select an edge, press <kbd className="font-mono">L</kbd> to grow it to its whole loop, then <kbd className="font-mono">H</kbd> to hold it sharp. Turn <strong>Smoothing</strong> to 1×: the corners round and the marked edges stay crisp.</li>
                      <li>Check the panel's <strong>Surface is closed</strong> line. Exports and Cut need a closed surface; give it a <strong>Wall</strong> or cap it by hand.</li>
                    </ol>

                    <div className="bg-amber-50 border border-amber-200/70 rounded-xl p-4 flex flex-col gap-3">
                      <div className="text-xs">
                        <strong className="text-amber-800">🖌️ Lattice and sculpting on the same body</strong>
                        <p className="text-amber-900/70 mt-1">
                          The cage rebuilds the mesh on every edit, so sculpting on a live cage would be lost the next
                          time a face moved. Pressing <strong>Sculpt</strong> on a lattice body therefore
                          <strong> applies the lattice</strong> first: the mesh becomes its own document, the lattice tools
                          close for that body, and the cage stays in the file without driving anything.
                          <strong> Ctrl+Z puts it all back.</strong> A sculpted mesh cannot be turned back into a cage.
                        </p>
                      </div>
                    </div>

                    <h4 className="font-bold text-slate-700 text-sm mt-1">Every key</h4>
                    <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
                      {[
                        ['1 2 3', 'Place, Select, Extrude'],
                        ['X Y Z', 'Turn the work plane; it lands on whatever the pointer is on'],
                        ['[ ]', 'Move the plane a step along its axis (Shift for five)'],
                        ['Ctrl (hold)', 'Stay on the plane you are pointing at'],
                        ['Click / Enter', 'Close the polygon being drawn'],
                        ['Shift / Ctrl+click', 'Add a corner, face or edge to the selection'],
                        ['Drag', 'Box-select corners; Shift adds to what is selected'],
                        ['L', 'Grow a selected edge to its whole loop'],
                        ['S', 'Scale the selection (then X/Y/Z to hold one axis)'],
                        ['I', 'Inset a face, sized by the pointer'],
                        ['B', 'Bevel: cut the corners off a face'],
                        ['J', 'Join two selected faces, or bore a tunnel between them'],
                        ['H', 'Hold an edge sharp under smoothing'],
                        ['F / N', 'Flip one face / turn every face the right way out'],
                        ['Del', 'Remove the corner under the pointer, or the selection'],
                        ['Ctrl+Z', 'Undo (Shift to redo)'],
                      ].map(([combo, what]) => (
                        <div key={combo} className="contents">
                          <kbd className="font-mono font-semibold text-slate-700 whitespace-nowrap">{combo}</kbd>
                          <span className="text-slate-500">{what}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {docsTab === 'gestures' && (
                  <div className="flex flex-col gap-4">
                    <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">⌨️ Scale, Inset &amp; Modal Keys</h3>
                    <div className="bg-amber-50 border border-amber-200/70 rounded-xl p-4 text-xs">
                      <strong className="text-slate-700">📐 Measuring: <kbd className="font-mono">D</kbd> for a distance, <kbd className="font-mono">A</kbd> for an angle</strong>
                      <p className="text-slate-500 mt-1">
                        Two clicks give a distance and its per-axis parts; three give the angle at the middle one.
                        Each click snaps to the nearest feature: a corner, the midpoint of an edge, the axis of a
                        cylinder, or the centre of a circle the neighbouring vertices lie on. Hole centres snap
                        this way on boolean results too.
                        Click away from the model or press <kbd className="font-mono">Esc</kbd> to clear the reading;
                        <kbd className="font-mono"> Esc</kbd> again puts the tape away. The viewport still orbits on
                        the right mouse button throughout.
                      </p>
                    </div>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Scale and inset need a <strong>size</strong>. The key starts the operation and the pointer sizes
                      it live. Nothing is held down while you move.
                    </p>

                    <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                      <div className="text-xs">
                        <strong className="text-slate-700">1. Press the key</strong>
                        <p className="text-slate-500 mt-1"><kbd className="font-mono">S</kbd> to scale, <kbd className="font-mono">I</kbd> to inset. The gesture starts at 1× wherever the pointer is.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">2. Move the pointer</strong>
                        <p className="text-slate-500 mt-1">Move away from the middle to grow (a wider inset, a bigger body) and back towards it to shrink. The <strong>status bar</strong> along the bottom shows which gesture is running and how far it has gone, for example <em>Scale 1.25× · Z</em>.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">3. Confine it, if you want</strong>
                        <p className="text-slate-500 mt-1">Press <kbd className="font-mono">X</kbd>, <kbd className="font-mono">Y</kbd> or <kbd className="font-mono">Z</kbd> to scale along that world axis alone. Press the same key again to free the other two.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">4. Keep it or put it back</strong>
                        <p className="text-slate-500 mt-1"><strong>Click</strong> or <kbd className="font-mono">Enter</kbd> keeps it; <strong>right-click</strong> or <kbd className="font-mono">Esc</kbd> puts everything back as it was. A cancelled gesture adds no undo step.</p>
                      </div>
                    </div>

                    <h4 className="font-bold text-slate-700 text-sm mt-1">What they do where</h4>
                    <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                      <div className="text-xs">
                        <strong className="text-slate-700">S on an ordinary body</strong>
                        <p className="text-slate-500 mt-1">Scales the selected body and everything parented under it (mesh vertices, primitive sizes, geom offsets and child positions), so an assembly keeps its shape. To type an exact figure instead, use the <strong>Scale</strong> card in the sidebar.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">I on an ordinary body: boring a hole</strong>
                        <p className="text-slate-500 mt-1">Puts a scaled copy of the body's own shape inside it, marked as a boolean <strong>hole</strong>, running right through: a cylinder becomes a pipe, a box becomes a square tube. The red ghost is the hole. Move the pointer out to widen it, and press <kbd className="font-mono">X</kbd>, <kbd className="font-mono">Y</kbd> or <kbd className="font-mono">Z</kbd> to change which way it runs (Z by default).</p>
                        <p className="text-slate-500 mt-1">For a tray or a cup, bore it and then shorten the negative in the sidebar. It is an ordinary geom afterwards, with its own size, position and operator. Deleting it gives the solid back.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">S and I inside the lattice tools</strong>
                        <p className="text-slate-500 mt-1">They act on the selected faces or corners rather than on the whole body. Scale moves corners in whole grid steps about the middle of the selection; inset makes a smaller face inside a selected one, ringed by quads. See the <strong>Lattice Modelling</strong> page.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">📍 Which mode has the keyboard</strong>
                        <p className="text-slate-500 mt-1">The chip at the far left of the status bar always says: <em>Select</em>, <em>Grab</em>, <em>Lattice · Extrude</em>, <em>Sculpt · Smooth</em>, or the gesture in progress. Check it when you are unsure which mode has the keyboard.</p>
                      </div>
                    </div>

                    <h4 className="font-bold text-slate-700 text-sm mt-1">Try it: a pipe in four seconds</h4>
                    <ol className="text-xs text-slate-600 leading-relaxed list-decimal ml-4 flex flex-col gap-1.5">
                      <li>Drop a <strong>cylinder</strong> into the scene and leave it selected.</li>
                      <li>Press <kbd className="font-mono">S</kbd>, pull the pointer out to make it taller and wider, click to keep it.</li>
                      <li>Press <kbd className="font-mono">I</kbd> and move the pointer <em>out</em> until the red ghost is the bore you want. Click.</li>
                      <li>The body is now a boolean: solid minus a copy of itself that runs right through it. Give it a moment to build, then look at the <strong>Boolean</strong> card in the sidebar to choose how it should collide.</li>
                    </ol>
                  </div>
                )}


                {docsTab === 'tutorial' && (
                  <div className="flex flex-col gap-4">
                    <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">🎓 Scripting Tutorial</h3>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      A component script is a snippet of JavaScript that runs <strong>once per physics step</strong> (about 1000×
                      per second) for the body it is attached to.
                    </p>

                    <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-4">
                      <div className="text-xs">
                        <strong className="text-slate-800 font-semibold">1️⃣ Your first script</strong>
                        <p className="text-slate-500 mt-1 leading-relaxed">
                          Select a body, paste this, and press <strong>Save &amp; Execute</strong>. There is no <code className="font-mono">function</code> wrapper
                          and no <code className="font-mono">return</code>; the script body is the loop.
                        </p>
                        <pre className="mt-2 bg-slate-950 text-emerald-400 p-2.5 rounded-lg font-mono text-[10px] leading-relaxed shadow-inner overflow-x-auto">
{`// Push this body steadily along +X, forever.
api.applyForce([5, 0, 0]);`}
                        </pre>
                        <p className="text-slate-500 mt-1.5 leading-relaxed">
                          The body accelerates rather than moving at constant speed, since a constant force gives constant
                          acceleration (<em>F = ma</em>).
                        </p>
                      </div>

                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-800 font-semibold">2️⃣ Read state, then react</strong>
                        <p className="text-slate-500 mt-1 leading-relaxed">
                          Every call without a body name refers to the body the script is attached to.
                        </p>
                        <pre className="mt-2 bg-slate-950 text-emerald-400 p-2.5 rounded-lg font-mono text-[10px] leading-relaxed shadow-inner overflow-x-auto">
{`// A hovering thruster: hold this body at z = 3 m.
const [x, y, z] = api.getPosition();
const [vx, vy, vz] = api.getVelocity();

const kp = 40.0;   // how hard to correct height error
const kd = 10.0;   // how hard to resist vertical speed
const mass = api.getMass();

// Cancel gravity, then add the correction on top.
const hold = mass * 9.81;
const correct = kp * (3.0 - z) - kd * vz;

api.applyForce([0, 0, hold + correct]);`}
                        </pre>
                      </div>

                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-800 font-semibold">3️⃣ Understanding PD control</strong>
                        <p className="text-slate-500 mt-1 leading-relaxed">
                          The pattern <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">kp × (target − actual) − kd × velocity</code> is a
                          <strong> PD controller</strong>. It covers most control tasks.
                        </p>
                        <ul className="list-disc pl-4 mt-1.5 text-slate-500 flex flex-col gap-1">
                          <li><strong>kp</strong> (proportional) pulls toward the target. Too high and it overshoots and oscillates.</li>
                          <li><strong>kd</strong> (derivative) opposes motion and damps that oscillation. Too high and it becomes sluggish.</li>
                          <li>Tune <strong>kp first</strong> until it reaches the target briskly, then raise kd until the wobble stops.</li>
                        </ul>
                      </div>

                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-800 font-semibold">4️⃣ Driving joints and motors</strong>
                        <p className="text-slate-500 mt-1 leading-relaxed">
                          For jointed mechanisms, work in joint space: one number instead of three vectors. Joint names come
                          from the <strong>Joint Name (for API)</strong> field; actuators append <code className="font-mono">_actuator</code>.
                        </p>
                        <pre className="mt-2 bg-slate-950 text-emerald-400 p-2.5 rounded-lg font-mono text-[10px] leading-relaxed shadow-inner overflow-x-auto">
{`// Hold a hinge at 45 degrees using a PD law.
const target = 45 * Math.PI / 180;   // API angles are RADIANS
const q  = api.getJointPosition('arm_hinge');
const qd = api.getJointVelocity('arm_hinge');

api.applyJointForce('arm_hinge', 60 * (target - q) - 8 * qd);

// Or, if the joint has "Enable Motor Drive" ticked:
api.setActuatorControl('arm_hinge_actuator', target);`}
                        </pre>
                      </div>

                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-800 font-semibold">5️⃣ Keyboard input &amp; time</strong>
                        <pre className="mt-2 bg-slate-950 text-emerald-400 p-2.5 rounded-lg font-mono text-[10px] leading-relaxed shadow-inner overflow-x-auto">
{`// Drive with the arrow keys; jump on space.
let fx = 0;
if (api.isKeyPressed('arrowleft'))  fx -= 20;
if (api.isKeyPressed('arrowright')) fx += 20;
api.applyForce([fx, 0, 0]);

if (api.isKeyPressed('space') && api.getPosition()[2] < 0.3) {
  api.setVelocity([0, 0, 4.0]);
}

// getTime() is SIMULATION time, so it is unaffected by frame rate.
const wobble = Math.sin(api.getTime() * 4) * 3;`}
                        </pre>
                      </div>

                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-800 font-semibold">⚠️ Pitfalls worth knowing</strong>
                        <ul className="list-disc pl-4 mt-1.5 text-slate-500 flex flex-col gap-1">
                          <li><strong>Forces vs state.</strong> <code className="font-mono">applyForce</code> asks the solver politely; <code className="font-mono">setVelocity</code> overrides physics outright. Prefer forces unless you are teleporting or resetting.</li>
                          <li><strong>Angles are radians.</strong> Multiply degrees by <code className="font-mono">Math.PI / 180</code>.</li>
                          <li><strong>Forces do not accumulate across steps.</strong> Applied force is cleared each step, so a force you want held must be re-applied every step. Your script already runs every step, so this happens naturally.</li>
                          <li><strong>Keep it cheap.</strong> This runs ~1000×/second. Avoid allocating large arrays or doing heavy work per step.</li>
                          <li><strong>Errors are silent-ish.</strong> A throwing script is caught and logged to the browser console rather than halting the sim. Use <code className="font-mono">api.log()</code> and open DevTools if nothing seems to happen.</li>
                          <li><strong>Gravity is still on.</strong> To hover you must actively cancel weight (<em>m·g</em>), as in the example above.</li>
                        </ul>
                      </div>
                    </div>
                  </div>
                )}

                {docsTab === 'apiref' && (
                  <div className="flex flex-col gap-4">
                    <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">📚 Full Script API Reference</h3>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Every method available on <code className="font-mono text-blue-600 bg-blue-50 px-1 rounded">api</code> inside a component script.
                      Arguments marked <code className="font-mono">?</code> are optional; where a <code className="font-mono">bodyName</code> is
                      omitted it defaults to the body the script is attached to.
                    </p>

                    {[
                      {
                        title: '📖 Reading body state',
                        rows: [
                          ['api.getPosition(bodyName?)', 'World position as [x, y, z], in metres.'],
                          ['api.getVelocity(bodyName?)', 'Linear velocity as [vx, vy, vz], in m/s.'],
                          ['api.getAngularVelocity(bodyName?)', 'Angular velocity as [wx, wy, wz], in rad/s.'],
                          ['api.getOrientation(bodyName?)', 'Orientation as a flat 9-element row-major rotation matrix.'],
                          ['api.getMass(bodyName?)', 'Body mass in kg, as computed from its geoms.'],
                        ],
                      },
                      {
                        title: '📖 Reading joint state',
                        rows: [
                          ['api.getJointPosition(jointName)', 'Joint coordinate: metres for a slide, radians for a hinge.'],
                          ['api.getJointVelocity(jointName)', 'Joint rate: m/s for a slide, rad/s for a hinge.'],
                        ],
                      },
                      {
                        title: '⚡ Applying forces',
                        rows: [
                          ['api.applyForce(forceVec, bodyName?)', 'Adds a world-space force [fx, fy, fz] in newtons for this step.'],
                          ['api.applyTorque(torqueVec, bodyName?)', 'Adds a world-space torque [tx, ty, tz] in N·m for this step.'],
                          ['api.applyJointForce(jointName, value)', 'Adds force/torque along a joint axis. The usual choice for control.'],
                          ['api.setActuatorControl(actuatorName, ctrl)', 'Sets the control input of a motor actuator (jointName + "_actuator").'],
                        ],
                      },
                      {
                        title: '🎯 Overriding state directly',
                        rows: [
                          ['api.setPosition(pos, bodyName?)', 'Teleports the body. Free joints take [x, y, z]; hinge/slide take a single number.'],
                          ['api.setVelocity(vel, bodyName?)', 'Overrides linear velocity, bypassing the solver.'],
                          ['api.setAngularVelocity(angvel, bodyName?)', 'Overrides angular velocity. Free/ball take a vector, hinge takes a number.'],
                        ],
                      },
                      {
                        title: '🌍 Environment & utilities',
                        rows: [
                          ['api.getTime()', 'Elapsed simulation time in seconds (not wall-clock time).'],
                          ['api.isKeyPressed(key)', "True while a key is held: 'space', 'w', 'arrowup', … Ignores typing in editors."],
                          ['api.getWind()', 'Current wind as [windX, windY].'],
                          ['api.log(msg)', 'Logs to the browser console, prefixed with the component name.'],
                          ['api.id / api.name', "This component's id and display name, as strings."],
                        ],
                      },
                    ].map(({ title, rows }) => (
                      <div key={title} className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-2.5">
                        <strong className="text-slate-800 font-semibold text-xs">{title}</strong>
                        {rows.map(([sig, desc]) => (
                          <div key={sig} className="text-xs border-t border-slate-150 pt-2 first:border-t-0 first:pt-0">
                            <code className="font-mono text-[10px] text-blue-600 bg-blue-50 px-1 py-0.5 rounded border border-blue-100">{sig}</code>
                            <p className="text-slate-500 mt-1 leading-relaxed">{desc}</p>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}

                {docsTab === 'zeroing' && (
                  <div className="flex flex-col gap-4">
                    <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">🎯 Machine Setup &amp; Zeroing</h3>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      Before any laser or CNC job you have to tell the machine where the work actually is. The
                      export modals do this under <strong>Set Work Origin</strong>, which appears once a machine
                      is connected over USB. The origin is the near-left corner of your stock that the G-code
                      treats as X0 Y0 Z0. Get it wrong and the job cuts in the wrong place, or into the bed.
                    </p>
                    <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                      <div className="text-xs">
                        <strong className="text-slate-700">1️⃣ Home first ($H)</strong>
                        <p className="text-slate-500 mt-1">Homing establishes machine coordinates against the limit switches. Everything below sets a <em>work</em> offset (G54) on top of that, so homing after zeroing keeps the origin. A soft reset does too.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">2️⃣ Jog X/Y to the origin</strong>
                        <p className="text-slate-500 mt-1">Use the arrow pad to drive the tool over the point on your stock that should be X0 Y0. Steps are 0.1 / 1 / 10 mm. Take the last approach at 0.1 mm and sight down the tool. The red ⏹ button cancels a jog in flight. Then press <strong>Set XY Zero Here</strong>, and <strong>Go To Zero</strong> to confirm it landed where you meant.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">3️⃣ Zero Z, by hand or on a plate</strong>
                        <p className="text-slate-500 mt-1"><strong>By hand</strong> works on any machine and any material, and needs nothing but the bit: jog Z down at 0.1 mm until the tip just marks the surface, or just nips a slip of paper, and press <strong>Set Z Zero Here</strong>. If something is under the tip, enter its thickness in the <em>gauge</em> box (paper is about 0.1 mm, a 1‑2‑3 block is 25.4) and zero lands on the material rather than on the gauge. Nothing moves: the machine is only being told where it already is.</p>
                        <p className="text-slate-500 mt-1"><strong>On a plate</strong> is more repeatable but needs a touch plate, a clip and stock the circuit can see. Clip the lead to the tool, sit the plate on the stock's top face, and touch the tool to the plate by hand until the probe light under the buttons turns green: that proves the circuit, and the probe is refused until it has been seen to close on this connection. Then park the tool a few mm above the plate, enter your plate's real thickness, and press <strong>Probe Z Zero</strong>. <strong>Remove the plate before cutting.</strong></p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">4️⃣ Set the spindle speed by hand</strong>
                        <p className="text-slate-500 mt-1">On a trim router or a VFD-and-a-dial spindle the <code>S</code> word in the G-code does nothing. The speed is a knob, and it stays wherever the last job left it. Each export modal states the number under <strong>Before You Start</strong> once a machine is connected, and writes it into the file as a comment. It is worked out from the material you picked and the cutter's diameter (surface speed ÷ diameter), so change the material and the number moves.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">5️⃣ Frame, then cut</strong>
                        <p className="text-slate-500 mt-1">Frame Job traces the outline at low power so you can check the job fits the stock. For routing, Probe Bed measures a grid across the job so cut depth follows a bed that is not flat.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">6️⃣ Pausing, and re-zeroing after a tool change</strong>
                        <p className="text-slate-500 mt-1"><strong>Pause</strong> is a feed hold: the machine decelerates along the path and keeps its position, so <strong>Resume</strong> picks the cut up exactly where it stopped. <strong>E‑Stop</strong> is a soft reset: it drops the position, and a part that has been cut into cannot be re-registered.</p>
                        <p className="text-slate-500 mt-1"><strong>Live Trim</strong> appears while the job runs. It nudges the feed and the spindle on the motion already in the buffer, so a cut that is chattering or burning can be backed off without stopping. Burn marks mean the feed and the speed are mismatched; trim until it sounds right, then set those numbers for next time.</p>
                        <p className="text-slate-500 mt-1">A job that changes tools stops on its own and says which bit to fit. The new bit is a different length, so the Z datum from the old one is wrong. Resume stays disabled until you have zeroed Z again, by either route, from the pause banner.</p>
                      </div>
                    </div>
                    <div className="bg-amber-50 border border-amber-200/60 rounded-xl p-4 flex flex-col gap-2.5">
                      <strong className="text-amber-800 font-semibold text-xs">⚠️ If the probe misses</strong>
                      <p className="text-amber-700/80 text-xs leading-relaxed">
                        A probe that runs its full travel without touching (clip off, lead broken, plate not
                        under the tool) <strong>does not set Z zero</strong>, and says so in red. Zeroing on a
                        missed probe would put the stock surface wherever the tool ran to, and the next cut would
                        plunge that far past it. Fix the probe and run it again before starting the job.
                        The search is 10 mm, so a probe that does not stop drives at most that far; and it is
                        not started at all until the circuit has been seen to close, or while the input already
                        reads closed with the tool in the air (a shorted lead, or $6 set the wrong way).
                      </p>
                    </div>
                    <p className="text-xs text-slate-500 leading-relaxed">
                      Requires a Chromium browser (WebSerial) and GRBL-compatible firmware: GRBL 1.1, FluidNC,
                      or grblHAL. The plate thickness field defaults to 12 mm; set it to your own plate's
                      measured thickness before the first cut. If you have no probe wired up, use the
                      manual route above; nothing else in the app needs one.
                      Connecting a machine also reads its <code>$$</code> settings, so the job-time
                      estimates switch from an assumed acceleration to your own <code>$120</code>-
                      <code>$122</code> and rapid rates, and the spindle recommendation is bounded by
                      your <code>$30</code>/<code>$31</code>.
                    </p>
                  </div>
                )}

                {docsTab === 'resuming' && (
                  <div className="flex flex-col gap-4">
                    <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">↩️ Stopping &amp; Resuming a Job</h3>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      A relief carve or a deep pocket can run for most of a day. This is what happens
                      when one of those does not get to the end — because the cutter broke, because
                      the USB lead was nudged, or because the laptop went to sleep at hour six.
                    </p>

                    <div className="bg-slate-50 border border-slate-200/60 rounded-xl p-4 flex flex-col gap-3">
                      <div className="text-xs">
                        <strong className="text-slate-700">Pause vs. Park vs. E‑Stop</strong>
                        <p className="text-slate-500 mt-1"><strong>Pause</strong> is a feed hold: the machine decelerates along its path and keeps its position, so Resume carries on exactly where it stopped. <strong>Park</strong> goes further — it stops, notes the line it had actually finished, retracts, and lets go, so you can jog the machine anywhere, change a bit or brush the work out, then put it back. <strong>E‑Stop</strong> is a soft reset: it drops the position, and a part that has been cut into cannot be re-registered from it.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">Resuming from a line</strong>
                        <p className="text-slate-500 mt-1">Line eleven thousand of a G‑code file means nothing on its own: the units, the coordinate system, the feed, the spindle speed and the depth the tool should be at were all set thousands of lines earlier. So the program is replayed without being sent, and a short preamble puts the machine back into that state — retract, spindle up to speed, move over the point it stopped at, then descend into the cut at a feedrate rather than a rapid. The banner names the depth it will descend to. Check that against the piece in front of you.</p>
                        <p className="text-slate-500 mt-1">The line is an editable field, not a fait accompli. Winding it back a little recuts a short stretch of finished surface, which is almost always safer than trying to land exactly on the break.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">Closing the laptop, and power cuts</strong>
                        <p className="text-slate-500 mt-1">When the browser streams the job over USB, the tab is doing the work: it sends a line at a time and waits for the controller to acknowledge it. A laptop that sleeps stops sending, the USB device re-enumerates when it wakes, and the cut ends wherever the controller’s buffer ran out. <strong>So you cannot sleep the machine and expect the cut to continue.</strong></p>
                        <p className="text-slate-500 mt-1">What you can do is pick it up afterwards. The program and the line it reached are written to this browser’s storage as it runs, so after a crash, a closed tab or a power cut you are offered the job again — on load, and whenever you come back to the tab. The offer is only good while <strong>the work is still clamped where it was</strong>. Home the machine, confirm the work origin, and zero Z for whatever bit is actually in the spindle before you take it.</p>
                        <p className="text-slate-500 mt-1">Very large programs — a fine‑stepover relief is hundreds of thousands of lines — do not fit in a browser’s storage. The pause banner says so while the job runs. <strong>PhysBox Pro</strong> keeps the program in your account instead, where size is not the limit, which also means you can pick the job up from a different computer. The line is recorded to the account once a minute rather than every two seconds, so a cloud recovery may be slightly behind the cut — wind it back, not forward.</p>
                      </div>
                      <div className="text-xs border-t border-slate-150 pt-3">
                        <strong className="text-slate-700">The way that really does survive a closed lid</strong>
                        <p className="text-slate-500 mt-1">A job sent to a <strong>Tekno Box</strong> is handed over whole: the device streams it to the controller itself, and the browser is only watching. Close the laptop, shut it down, drive home — the cut carries on. That is the right answer for anything that runs for hours. The machine itself still has to stay powered.</p>
                      </div>
                    </div>

                    <div className="bg-amber-50 border border-amber-200/60 rounded-xl p-4 flex flex-col gap-2.5">
                      <strong className="text-amber-800 font-semibold text-xs">⚠️ What a resume cannot know</strong>
                      <p className="text-amber-700/80 text-xs leading-relaxed">
                        It replays the program, not the workshop. It does not know that the stock was
                        unbolted and put back, that a different bit went in, or that the piece moved when
                        the cutter snapped. If any of those happened, the preamble will drive the tool to
                        a depth that was correct for a piece that no longer exists. A program that used
                        <code>G92</code>, <code>G28</code> or <code>G30</code> is flagged as uncertain for
                        the same reason, rather than being resumed into a fiction.
                      </p>
                    </div>
                  </div>
                )}

                {docsTab === 'license' && (
                  <div className="flex flex-col gap-4">
                    <h3 className="font-bold text-slate-800 text-lg flex items-center gap-1.5">⚖️ License &amp; Terms</h3>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      PhysBox Mesh is distributed under the <strong>PhysBox Permissive Public License (PPPL-1.0)</strong>.
                      Commercial use of generated 3D meshes, STL models, contour slices, relief carving toolpaths, and fabricated goods is fully permitted with attribution.
                    </p>
                    <div className="bg-slate-100 p-3.5 rounded-xl border border-slate-200 text-[11px] font-mono text-slate-700 whitespace-pre-wrap leading-relaxed max-h-[50vh] overflow-y-auto">
{`PhysBox Permissive Public License (PPPL-1.0)
Copyright (c) 2026 PhysBox Contributors and Authors. All Rights Reserved.

1. PERMISSION AND SCOPE
Permission is granted to access, execute, and use the Software for personal, educational, research, and commercial purposes, including the generation, export, and commercial utilization of output artifacts (such as 3D meshes, CAD models, STL files, SVG paths, toolpaths, CNC G-code, and laser/router instructions).

2. PERMITTED COMMERCIAL USE OF OUTPUTS
You are fully permitted to design, prototype, simulate, 3D print, CNC machine, sell, and monetize any physical workpieces or digital models produced using the Software.

3. ATTRIBUTION & RESTRICTIONS ON SOFTWARE FORKING
(a) Attribution: The copyright notice and license must be retained in all copies or substantial portions of the Software.
(b) No Standalone Forking or Hosted Service Redistribution: You may NOT redistribute, sublicense, re-brand, or host the Software source as a competing standalone service or software fork without explicit prior written authorization.
(c) Brand Protection: The names "PhysBox", "Etch", "Volt", "Mesh", "Flux", or the names of their contributors may not be used to endorse or promote third-party products without specific prior written permission.

4. STRICT DISCLAIMER OF LIABILITY & PHYSICAL MACHINERY WARNING
THE SOFTWARE, PHYSICS SOLVERS, CSG COMPILERS, TOOLPATH CALCULATORS, AND MACHINE CONTROLLERS ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND. IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CNC/LASER DAMAGE, SPINDLE CRASHES, 3D PRINTER HEAD CRASHES, FIRE, MATERIAL LOSS, BUSINESS INTERRUPTION, OR BODILY INJURY RESULTING FROM OPERATION OF MACHINERY. OPERATORS ASSUME SOLE RESPONSIBILITY FOR VERIFYING G-CODE, CLAMPING, TRAVEL LIMITS, EYE PROTECTION, AND PHYSICAL SAFETY.`}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
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
