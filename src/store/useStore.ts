import type { ScriptStateMap } from '../utils/scriptState';
import { create, type StateCreator } from 'zustand';
import { shareUnchanged } from '../utils/shareUnchanged';
import * as THREE from 'three';
import type { SceneGraph, SceneNode, SceneGeom, SceneJoint, GeomType, CsgOp, ReferenceImage } from '../types/scene';
import { hasEdgeRounds, reconcileEdgeRounds } from '../utils/edgeRound';
import { releaseFastenings, reseatHardware } from '../utils/hardwareParts';
import { hardwarePartActions, type HardwarePartActions } from './hardwarePartActions';
import { extrusionActions, type ExtrusionActions } from './extrusionActions';
import { clipboardActions, type ClipboardActions } from './clipboardActions';
import { belowOffset, besideOffset, restingPos } from '../utils/spawnPlacement';
import type { DataMirror, ModelMirror } from '../types/sceneLayer';
import { type CombineOp, cageInFrame, geomsForCombine, nodeWorldMatrix, removeMergedBody } from '../utils/combineBodies';
import { getGeomFrame } from '../utils/laserCutExporter';
import { toSceneGeom } from '../utils/sculptMesh';
import { buildSculptBaseSized, DEFAULT_SCULPT_BASE, DEFAULT_SCULPT_SIZE } from '../utils/sculptBases';
import {
  createLattice, deserializeCage, faceCount, serializeCage, toSceneGeom as latticeToSceneGeom,
  DEFAULT_UNIT as LATTICE_UNIT,
} from '../utils/latticeMesh';
import { latticeBoolean } from '../utils/latticeBoolean';
import {
  type CsgResult, CSG_DEFAULT_SECTORS, scadForDisplay, sourcePositiveBounds, reconcileCuts,
  hasBooleanOps, csgHashOf,
} from '../utils/csg';
import { collisionHashOf, type ColliderResult } from '../utils/convexDecomposition';
import { insetNegatives } from '../utils/scaleNode';
import type { PaintLayer } from '../utils/vertexPaint';
import type { FaceSplit, SurfaceTexture } from '../utils/surfaceTexture';
import type { FacePatternTarget } from '../utils/facePatternPick';
import type { CameraView } from '../utils/cameraViews';
import { compileToMJCF } from '../utils/mjcf';
import { PRESETS, generateGearGeoms } from '../presets/presetScenes';
import { PhysicsWorkerClient, type BuiltResult } from './physicsWorkerClient';
import type { ConstraintBrokenEvent, ImpactEvent } from '../workers/physicsWorkerProtocol';
import { canShatter, shatterVerdict } from '../utils/breakThresholds';
import { DEFAULT_FRACTURE_PIECES } from '../utils/fracture';
import { fractureMeshOffThread, prewarmFractureWorker } from '../utils/fractureWorkerClient';
import { buildShatterGraph, MAX_LIVE_SHARDS } from '../utils/runtimeShatter';
import { fromtoCenter, imprintOf, isDentable, meshForDenting } from '../utils/dentMesh';
import { DEFAULT_JOIN_MATERIAL, joinMaterial } from '../utils/joinMaterials';
import type { DentConfig } from '../utils/breakThresholds';
import { generatePyramidMeshData, generateConeMeshData, generateTorusMeshData, generateTubeMeshData, generateCurveGeoms, DEFAULT_CURVE_POINTS, DEFAULT_CURVE_WIDTH, DEFAULT_CURVE_THICKNESS, DEFAULT_CURVE_SEGMENTS, getStickyRotation } from '../utils/geom';
import { readUserPreset } from '../utils/userPresets';
import { DEFAULT_MATERIAL, type MaterialId } from '../utils/feedsAndSpeeds';
import { DEFAULT_FILAMENT, type FilamentId } from '../utils/filaments';
import { loadStock, saveStock, clampStock, type StockSize } from '../utils/stockSettings';
import {
  loadPrintBed,
  savePrintBed,
  clampPrintBed,
  type PrintBed,
  loadCncBed,
  saveCncBed,
  clampCncBed,
  type CncBed,
} from '../utils/printBedSettings';
import type { ReliefCarveOptions } from '../utils/reliefCarveExporter';
import { withUniqueNames } from '../utils/uniqueNames';
import { withoutDanglingReferences } from '../utils/danglingReferences';
import { withConnectAnchorsFollowing } from '../utils/connectAnchors';
import { useDialogs } from './dialogStore';
import { downloadSceneRescue, allowUnload } from '../utils/rescueScene';
import { getNodeWorldPos } from '../utils/sceneTree';
import { sameValue, findNodeById, cloneSceneGraph, findNode, addChildNode } from './sceneClone';
import { bindStore } from './storeRef';

// Moved out of this file into the modules above, and still imported from here.
export { cloneSceneGraph } from './sceneClone';
export { restoreCollisionWhenMadeMovable, scaleMeshGeoms } from './meshGeomTransforms';
export { castPrepArmed } from './editGuard';
export { applyShatterPieces, effectiveSceneGraph, type DeformedGeometry } from './breakage';
export { endVoltLink, getPhysicsWorkerClient, setPhysicsFrameListener } from './physicsEngine';
export type { EdgeRoundSession } from './edgeRoundActions';
import {
  isAllMeshNode, toRenderVertices, promoteMeshGeomsToDynamic, restoreCollisionWhenMadeMovable,
  promoteJointedMeshGeomsDeep, mapVerts, translateMeshGeoms, rotateMeshGeomsAbsolute,
} from './meshGeomTransforms';
import {
  userEditPending, castPrepBypass, refusedGraphs, keptGraphs, markUserEdit, withCastPrepBypass,
  castPrepArmed, bodiesChanged,
} from './editGuard';
import {
  type DeformedGeometry, clearBreakage, fracturing, breakageEpoch, anyNode, scheduleShatterRebuild,
  applyShatterPieces, effectiveSceneGraph, detachReferencesTo, retargetReferences, wallAtImpact,
  bodyMassOf, dentBody,
} from './breakage';
import { shapeParamActions, type ShapeParamActions } from './shapeParamActions';
import {
  type PhysicsWindow, MUJOCO_SHIM, buildModelMirror, buildDataMirror, RECYCLE_HEAP_BYTES,
  lastHeapBytes, setLastHeapBytes, lastScriptState, onNextPaint, liveModelGraph, recycleWorker,
  getPhysicsWorkerClient, endVoltLink,
} from './physicsEngine';
import { initialPreset, initialScene, framingPatch, initialFraming, snapForGridMm } from './sceneFraming';
import { latticeActions, type LatticeActions } from './latticeActions';
import { dropStaleColliders, rebuildAfterGeomEdit, rebuildBooleansAfterRestore } from './geomEdits';
import { sculptActions, type SculptActions } from './sculptActions';
import { printSplitActions, type PrintSplitActions } from './printSplitActions';
import { edgeRoundActions, type EdgeRoundActions } from './edgeRoundActions';
import { castPrepActions, type CastPrepActions } from './castPrepActions';
import { cutActions, type CutActions } from './cutActions';

/**
 * What is on the bench.
 *
 * `fdm` is the default because it is what most people who open this app own,
 * and saying so is more honest than presenting a router as the assumption. It
 * is not a machine this app drives — see `FdmNotice` — and everything that
 * writes G-code treats it as it treats a router, because the one thing an FDM
 * user does here is export a mesh.
 */
export type MachineTarget = 'fdm' | 'laser' | 'cnc';

/** A preset as listed in PRESETS: a scene, and optionally a camera framing and an environment. */
interface Preset {
  name: string;
  emoji?: string;
  scene?: SceneGraph;
  camera?: { position: [number, number, number]; target: [number, number, number] };
  environment?: Partial<{ gravityZ: number; windX: number; windY: number; density: number; floorFriction: number; floorBounce: number }>;
  /**
   * How this scene is meant to be carved, for the relief export to open with.
   *
   * A model that was designed at a particular size and depth carries those
   * numbers; without this the relief dialog opens on its own 150x150x18
   * defaults and quietly rescales the thing it was handed.
   */
  carve?: Partial<ReliefCarveOptions>;
}


/**
 * The bench stock a scene's carve settings imply, if they name one.
 *
 * Stock is one fact with one home, so a preset or a generator that says it is
 * cut from a 50 x 40 x 40 block sets the bench to that rather than leaving the
 * bar and the export dialog disagreeing about what is clamped down.
 */
function stockFromCarve(
  carve: Partial<ReliefCarveOptions> | null | undefined,
  current: StockSize
): StockSize {
  if (!carve) return current;
  const { stockWidthMm, stockDepthMm, stockThicknessMm } = carve;
  if (stockWidthMm === undefined && stockDepthMm === undefined && stockThicknessMm === undefined) {
    return current;
  }
  return saveStock(clampStock({
    widthMm: stockWidthMm ?? current.widthMm,
    depthMm: stockDepthMm ?? current.depthMm,
    thicknessMm: stockThicknessMm ?? current.thicknessMm,
  }));
}

/** A node's own transform, as MJCF would apply it under its parent. */
const localMatrixOf = (node: SceneNode): THREE.Matrix4 => {
  const m = new THREE.Matrix4();
  const q = node.quat
    // MJCF quaternions are [w, x, y, z]; Three wants [x, y, z, w].
    ? new THREE.Quaternion(node.quat[1], node.quat[2], node.quat[3], node.quat[0])
    : new THREE.Quaternion().setFromEuler(new THREE.Euler(
        ((node.euler?.[0] ?? 0) * Math.PI) / 180,
        ((node.euler?.[1] ?? 0) * Math.PI) / 180,
        ((node.euler?.[2] ?? 0) * Math.PI) / 180,
        'XYZ',
      ));
  return m.compose(
    new THREE.Vector3(node.pos?.[0] ?? 0, node.pos?.[1] ?? 0, node.pos?.[2] ?? 0),
    q,
    new THREE.Vector3(1, 1, 1),
  );
};

/** Orders recompiles so a superseded one can bow out instead of building stale state. */
let recompileToken = 0;
/**
 * How many recompiles have been asked for and not yet landed.
 *
 * The undo history needs this. A snapshot is taken before a change and pushed a
 * tick later, ONLY if the scene actually moved — which is right for the MCP
 * bridge, where most commands change nothing. But `addComponent` and everything
 * like it never write the scene themselves: they hand it to `recompile`, which
 * lands it fifty milliseconds and a build later, long after that tick. The
 * snapshot found the scene unchanged, threw itself away, and adding a body was
 * not undoable at all.
 *
 * So while a recompile is in flight the snapshot is held rather than discarded,
 * and the landing itself pushes it.
 */
let recompilesInFlight = 0;
/** A reset that a superseded recompile was asked for; see recompile. */
let pendingForceReset = false;
/*
 * The history debounce timer. Module state, not store state: nothing renders
 * it, and every write of it to the store notified every subscriber in the app
 * on every tick of every slider drag.
 */
let historyDebounceTimer: ReturnType<typeof setTimeout> | null = null;

let loggedSharedMode = false;

/** How many steps back Ctrl+Z can go. */
const UNDO_LIMIT = 100;

export interface UndoRedoState {
  sceneGraph: SceneGraph;
  gravityZ: number;
  windX: number;
  windY: number;
  density: number;
  floorFriction: number;
  floorBounce: number;
  selectedNodeId: string | null;
  /**
   * Whether the lattice tools were open, and on what.
   *
   * Part of the state an undo restores, because opening them is a thing a
   * person did and undo is how you take a thing you did back. Without it,
   * stepping back past the point where a body was made left the editor open on
   * a body that no longer existed — and the editor holds its own copy of the
   * cage, so it would happily commit the ghost back into the scene.
   */
  latticeNodeId: string | null;
}

/**
 * What the lattice tools should be looking at after stepping to `state`.
 *
 * Clearing the rest of the tools' state alongside it, because they are all
 * about a body that may be gone: stats describing a shape nobody can see, a
 * selection of corners that no longer exist, a cut spot on a missing surface.
 */
function latticeAfterUndo(state: UndoRedoState) {
  const id = state.latticeNodeId;
  const stillThere = id !== null && findNode(state.sceneGraph.nodes, id) !== null;
  if (stillThere) return { latticeNodeId: id };
  return { latticeNodeId: null, latticeStats: null, latticeSelection: null, cutSpot: null };
}

/**
 * How addComponent places a part. By default from its own size: at the top
 * level it stands on the floor at the given x and y, clear of other bodies;
 * under a parent it goes beside it (below it, for the things that hang).
 * `exact` keeps the position as given, for a caller that chose one (MCP).
 */
export interface AddPlacement { exact?: boolean }

/*
 * A curve added from the palette: the shared default track a tenth the size,
 * so it fits the 160 mm view the others do. The DEFAULT_CURVE_* constants stay
 * as they are, because they are also the fallback for curves already saved.
 */
const PALETTE_CURVE_POINTS = DEFAULT_CURVE_POINTS.map((p) => p.map((v) => v * 0.1));
const PALETTE_CURVE_WIDTH = DEFAULT_CURVE_WIDTH * 0.1;
const PALETTE_CURVE_THICKNESS = DEFAULT_CURVE_THICKNESS * 0.1;

export interface PhysicsState extends HardwarePartActions, ExtrusionActions, ClipboardActions, ShapeParamActions, LatticeActions, SculptActions, PrintSplitActions, EdgeRoundActions, CastPrepActions, CutActions {
  mujoco: typeof MUJOCO_SHIM | null;
  model: ModelMirror | null;
  data: DataMirror | null;
  
  // History State
  undoStack: UndoRedoState[];
  redoStack: UndoRedoState[];
  tempUndoState: UndoRedoState | null;
  lastInteractionType: string | null;

  // History Actions
  undo: () => void;
  redo: () => void;
  recordInteraction: (type: string) => void;
  flushPendingUndo: () => void;
  prepareForDiscreteChange: () => void;
  
  isPlaying: boolean;
  /**
   * Welds that have sheared off during this run, by weldKey().
   *
   * Transient by design: a break is a simulation event, not an edit. The scene
   * graph still says the handle is welded on, so this is never serialised into
   * a preset, a share link or the undo stack, and resetSimulation() empties it
   * — which is what puts the object back together.
   */
  brokenConstraints: string[];
  /** The most recent break, for the "broken at 1.34 s, 212 N" readout. */
  lastBreak: ConstraintBrokenEvent | null;
  /**
   * Bodies that are currently in pieces, and the pieces they are in.
   *
   * Deliberately the SUBSTITUTIONS rather than a finished graph. An overlay
   * captured as a whole scene goes stale the moment anything else is edited:
   * the build compiles the snapshot, the document change never reaches it, and
   * dragging a body moves its gizmo while the body itself sits still. Keeping
   * only "this id became these nodes" means the effective scene is derived from
   * whatever the document says right now, so ordinary editing carries on
   * working around the wreckage.
   *
   * The document itself is never touched, so a break stays out of undo, out of
   * exports and out of anything shared.
   */
  shatteredBodies: Record<string, SceneNode[]>;
  /**
   * The substitutions the CURRENT model actually contains.
   *
   * Lags `shatteredBodies` by exactly one build, and that lag is the point. The
   * moment a body is marked broken it is gone from the scene the renderer
   * derives, while the shards that replace it have no bodies in the model yet —
   * so they resolve to body -1 and are not drawn. The vase vanishes, and
   * reappears in pieces a rebuild later. Rendering from what was built instead
   * keeps the whole vase on screen until the instant its pieces can be drawn,
   * and the swap happens in a single frame.
   */
  visibleShatteredBodies: Record<string, SceneNode[]>;
  /**
   * Surfaces whose damage has been made real to the solver, by dent key.
   *
   * Only geoms with `deformCollision` ever appear here. Like the shattered
   * bodies, these are substitutions applied on top of the document rather than
   * edits to it, so a dented plate is still a flat plate in anything you save,
   * export or undo, and Reset restores it.
   */
  deformedGeoms: Record<string, DeformedGeometry>;
  /** The most recent shatter, for the readout. */
  lastShatter: { nodeId: string; name: string; pieces: number; time: number; impulseNs: number; wallM?: number } | null;
  isLoaded: boolean;
  lastCompileError: string | null;
  /**
   * The Volt page driving this scene, while linked: it owns the clock, and
   * the scene steps only when it asks. See hooks/useVoltLink.ts.
   */
  voltLink: { origin: string } | null;
  isSettingsOpen: boolean;
  /**
   * The camera preset. Top Down, Front and Side are orthographic — a drawing
   * sheet's projection, so a part's near and far edges line up and the Dims
   * overlay can sit on them. They can still be orbited out of; see CameraView.
   */
  cameraView: CameraView;
  /**
   * True once the camera has been orbited off the drawing view it was put in.
   * The view's button stops showing as chosen, because it no longer is —
   * and clicking it puts the view back. Kept by CameraController.
   */
  cameraOffAxis: boolean;
  /**
   * Whether the Dims overlay is on. It draws only in an orthographic view and
   * only while the camera is still square to it (DimensionOverlay.tsx).
   */
  dimsEnabled: boolean;
  /**
   * Whether the DFM overlay is on. What it judges against is NOT stored: the
   * lens follows machineTarget and the limits follow material/filament/stock,
   * all of which are already chosen in the bottom bar. Storing the process too
   * would let this control disagree with the one beside it.
   */
  dfmEnabled: boolean;
  /**
   * Whether the DFM panel's casting section is expanded.
   *
   * Casting is not a machine, so it cannot follow machineTarget like the other
   * lenses — but it is a real Mesh workflow, so it sits in the panel one click
   * away, collapsed. It lives in the store rather than in the panel's own state
   * because the heat map has to follow it: reading about undercuts while the
   * viewport is still coloured for overhangs is worse than showing neither.
   */
  dfmCastOpen: boolean;
  /**
   * Where the DFM panel sits and whether it is rolled up, like a note card.
   *
   * In the store rather than the component so it survives the panel being
   * closed and reopened: having to drag it back out of the way every time is
   * how a floating panel becomes a thing people stop opening.
   *
   * x/y are null until it is first dragged, which is what lets the default sit
   * in the BOTTOM left — anchored to the bottom edge, rather than a top offset
   * guessed from a viewport height nothing here knows.
   */
  dfmPanel: { x: number | null; y: number | null; minimized: boolean };

  // --- Viewport display ---------------------------------------------------
  /** Draw every body as the edges of its triangles rather than a shaded solid. */
  wireframe: boolean;
  /** Draw an ink line (black, white in dark mode) along every real corner of every body; on by default — see scene/FeatureEdges. */
  showEdges: boolean;
  toggleShowEdges: () => void;
  toggleWireframe: () => void;
  /** Grid cell size in millimetres. 10mm suits the 250mm of world the viewport
   *  now shows; 100mm was a bench-scale cell and made a small part (a relief
   *  carve, a coin) look tiny against it. Set to fit whatever scene is loaded
   *  (see utils/frameScene) and overridable from the bottom bar.
   *  Purely a display setting: never touches any body's actual dimensions. */
  gridCellSizeMm: number;
  setGridCellSizeMm: (mm: number) => void;

  // --- Coloring -----------------------------------------------------------
  //
  // Brushed onto part of a surface, not applied to a whole body — see
  // utils/vertexPaint. Purely how the scene looks: a geom's colour has never
  // fed the physics or any exporter.
  /** Whether a drag in the viewport paints bodies instead of selecting them. */
  paintMode: boolean;
  /** The colour the brush is holding, as 0..1 rgb to match a geom's rgba. */
  paintColor: [number, number, number];
  /** Brush radius in metres. */
  paintRadius: number;
  /** Coverage one dab lays down at the centre of the brush, 0..1. */
  paintFlow: number;
  togglePaintMode: () => void;
  setPaintColor: (rgb: [number, number, number]) => void;
  setPaintBrush: (patch: { radius?: number; flow?: number }) => void;
  /** Stores a finished stroke. Passing undefined strips a geom back to bare. */
  setGeomPaint: (nodeId: string, geomName: string, layer: PaintLayer | undefined) => void;
  /** Takes the paint off every geom of the scene. */
  clearAllPaint: () => void;
  /** Sets a body's base colour — one geom by name, or all of them. */
  setGeomColor: (nodeId: string, geomName: string | undefined, rgba: number[]) => void;
  // When set, CameraController points the camera at this explicit pose instead
  // of the cameraView preset. Position/target are in MuJoCo world space (same
  // convention as every other pos field in the app) — CameraController converts
  // to Three.js space itself. Set by the MCP SET_CAMERA bridge command so an
  // agent can frame a specific body without guessing preset rotations.
  cameraOverride: { position: [number, number, number]; target: [number, number, number] } | null;
  /**
   * Bumped whenever the camera should go back to the view it starts in.
   *
   * A token rather than a flag or a call: the camera lives inside the canvas
   * and the thing that wants it moved (loading a preset) is nowhere near it, and
   * "put it back where it starts" is not expressible as a state to be in — the
   * view a person has orbited to is also `perspective`, so nothing changes and
   * no effect re-runs. A number that only goes up always re-runs.
   */
  cameraResetToken: number;
  /**
   * The scene the viewport keeps drawing while a newly loaded one is built.
   *
   * Loading writes `sceneGraph` at once, because the CSG compile and the MCP
   * reply read it straight away, but the model to draw it with comes from the
   * worker some time later. Drawn against the old model, every new geom has no
   * id and every old one is unexplained by the new graph, so the implicit-geom
   * pass drew the outgoing scene again (the pendulum, most often) before the
   * new one replaced it. Null except during that wait.
   */
  outgoingSceneGraph: SceneGraph | null;
  mcpActiveCount: number;
  scadCompileCount: number;
  
  // Environment
  gravityZ: number;
  windX: number;
  windY: number;
  density: number;
  floorFriction: number;
  floorBounce: number;
  
  // Scene
  sceneGraph: SceneGraph;
  selectedNodeId: string | null;
  recompileId: number;
  /**
   * Bodies switched off with the hierarchy's eye. View only: they are still in
   * the model, colliding and carrying mass. Kept out of the scene graph, so it
   * is not saved, not undone and not compiled.
   */
  hiddenNodeIds: string[];
  toggleNodeHidden: (id: string) => void;
  activePreset: string;
  /**
   * Names what is open without loading it — after saving the scene as a
   * preset, the scene on screen IS that preset, and reloading it would close
   * the tools, stop the simulation and reframe the camera for nothing.
   */
  setActivePreset: (name: string | undefined) => void;
  
  draggedNodeId: string | null;
  dragTarget: { x: number; y: number; z: number } | null;
  dragDistance: number;
  
  // Actions
  togglePlay: () => void;
  setLoaded: (loaded: boolean) => void;
  setSettingsOpen: (open: boolean) => void;

  /*
   * What is on the bench, and what is on it.
   *
   * These used to be picked separately inside each export modal, so the machine
   * and the material were answered once per operation and could disagree
   * between them — a relief carved for hardwood and a contour slice cut for
   * acrylic, from the same scene, on the same machine, in the same session.
   * They are properties of the workshop rather than of one export, so they live
   * here and every exporter reads them.
   */
  machineTarget: MachineTarget;
  material: MaterialId;
  /**
   * What it would be printed in, kept separate from what it would be cut from.
   *
   * Two lists rather than one widened one: a filament has no surface speed and
   * no chip load, and adding PLA to the table the feeds arithmetic reads from
   * would mean inventing both. Switching the bench between a printer and a
   * router also should not silently reinterpret "PETG" as a milling stock.
   */
  filament: FilamentId;
  /**
   * What is clamped on the bed, in millimetres. Here for the same reason the
   * machine and the material are: it is a fact about the workshop, not about
   * one export, and until it lived here nothing in the app could answer "how
   * big is the material" -- which is the first thing a pattern generator needs.
   *
   * Persisted, because the board on the bench outlives the tab.
   */
  stock: StockSize;
  /**
   * The printer's build volume, in millimetres: what Split for Print cuts a
   * part to fit, and what the print lens checks a part against. Persisted, for
   * the same reason the stock is.
   */
  printBed: PrintBed;
  setPrintBed: (patch: Partial<PrintBed>) => void;
  /**
   * The CNC router's working envelope [widthMm, depthMm, heightMm], persisted so
   * Joinery and Machine Setup know the dimensions of the CNC bed.
   */
  cncBed: CncBed;
  setCncBed: (patch: Partial<CncBed>) => void;
  /**
   * Carve settings a preset or a generator wants the relief export to open
   * with, or null for the exporter's own defaults.
   *
   * Only the job-shaped keys -- stock, depth, scale, background. Tooling stays
   * out: which cutter reaches the bottom of a 20 mm wall is a fact about a
   * workshop, not about the thing being cut, and `recommendReliefTooling`
   * derives it.
   */
  carveSettings: Partial<ReliefCarveOptions> | null;
  /** Which surface pattern generator's dialog is open, if any. */
  patternGeneratorId: string | null;
  /** The face the pattern-on-a-face dialog is open on, if it is. */
  facePatternTarget: FacePatternTarget | null;
  isMachineConfigOpen: boolean;
  setMachineTarget: (target: MachineTarget) => void;
  setMaterial: (material: MaterialId) => void;
  setFilament: (filament: FilamentId) => void;
  setStock: (patch: Partial<StockSize>) => void;
  setCarveSettings: (settings: Partial<ReliefCarveOptions> | null) => void;
  openPatternGenerator: (id: string) => void;
  closePatternGenerator: () => void;
  openFacePattern: (target: FacePatternTarget) => void;
  closeFacePattern: () => void;
  /**
   * Replaces a geom's surface patterns (see utils/surfaceTexture), or clears
   * them with undefined. No recompile: the MJCF never reads them.
   */
  setGeomTextures: (nodeId: string, geomName: string, textures: SurfaceTexture[] | undefined) => void;
  /** Replace a geom's knife seams (SceneGeom.faceSplits). One undo step; no recompile. */
  setGeomFaceSplits: (nodeId: string, geomName: string, splits: FaceSplit[] | undefined) => void;
  /**
   * Replace the scene with something a generator built, and hand the exporter
   * the settings it should be cut with.
   */
  loadGeneratedScene: (scene: SceneGraph, carve: Partial<ReliefCarveOptions> | null) => void;
  setMachineConfigOpen: (open: boolean) => void;
  setCameraView: (view: CameraView) => void;
  setDimsEnabled: (enabled: boolean) => void;
  setCameraOffAxis: (off: boolean) => void;
  setDfmEnabled: (enabled: boolean) => void;
  setDfmCastOpen: (open: boolean) => void;
  setDfmPanel: (patch: Partial<{ x: number | null; y: number | null; minimized: boolean }>) => void;
  /** Adds a body; it is selected once built unless `select` is false. */
  addHardwareComponentNode: (hardwareNode: SceneNode, opts?: { select?: boolean }) => void;
  setCameraOverride: (override: { position: [number, number, number]; target: [number, number, number] } | null) => void;
  setEnvironment: (env: Partial<{gravityZ: number, windX: number, windY: number, density: number, floorFriction: number, floorBounce: number}>) => void;
  
  setSelectedNodeId: (id: string | null) => void;
  /**
   * Bodies selected ALONGSIDE selectedNodeId, for operations that take more
   * than one — combining, so far.
   *
   * Kept beside the single selection rather than replacing it, because
   * everything else in the app asks "which body's properties am I showing" and
   * that has exactly one answer. This is the rest of the set; the panel shows
   * the primary, and an operation acts on primary plus these.
   */
  extraSelectedIds: string[];
  /** Adds a body to the selection, or takes it out again. */
  toggleExtraSelected: (id: string) => void;
  /**
   * While on, a plain click adds a body to the selection or takes it out,
   * the same as Shift-click — for a mouse-only user, or a trackpad, gathering
   * the bodies Split for Print or Combine should take as one. The bottom
   * bar's mode menu turns it on; Esc, or choosing Nothing, turns it off.
   */
  multiSelectMode: boolean;
  setMultiSelectMode: (on: boolean) => void;
  /**
   * Select these bodies at once — what a box dragged across the viewport
   * catches. The first becomes the primary unless the current primary is among
   * them; `add` keeps what was selected already.
   */
  selectMany: (ids: string[], add: boolean) => void;
  /**
   * Merges other bodies into this one and applies a boolean between them.
   *
   * The move the boolean tools were missing. A body's geoms ARE its boolean
   * program, so two separate bodies could never cut each other however they
   * overlapped — the only way to subtract a sphere from a cube was to create
   * the sphere on the cube. This brings the sphere over: its shapes are
   * rewritten into the cube's frame, marked with the operation, and the body
   * they came from is removed.
   *
   * `union` leaves them as ordinary added shapes, which is a compound body and
   * needs no boolean at all. `difference` and `intersection` turn the boolean
   * on, and the result is compiled like any other.
   */
  combineBodies: (targetId: string, sourceIds: string[], op: CombineOp) => void;
  updateScene: (sceneGraph: SceneGraph, skipRecompile?: boolean) => void;
  updateNodePos: (id: string, newPos: [number, number, number]) => void;
  updateNodeGeom: (id: string, updates: Partial<SceneGeom>, geomIndex?: number) => void;
  updateNodeJoint: (id: string, updates: Partial<SceneJoint>, jointIndex?: number) => void;
  rotateAroundCOM: boolean;
  setRotateAroundCOM: (val: boolean) => void;
  updateNodeRotation: (id: string, axis: 0 | 1 | 2, deg: number, rotateAroundCOM?: boolean) => void;
  updateNodeScript: (id: string, script: string) => void;
  updateNode: (id: string, updates: Partial<SceneNode>) => void;

  renameNode: (id: string, newName: string) => void;
  updateNodeJointsList: (id: string, joints: SceneJoint[]) => void;
  /**
   * Lift a body out of its parent and onto the top level, keeping it where
   * it looks like it is. MuJoCo allows a free joint only on a top-level
   * body, so a nested body cannot be made 6-DOF without this first.
   */
  detachToTopLevel: (id: string) => boolean;
  deleteNode: (id: string) => void;
  /** Deletes several bodies as one undo step, and clears the selection they made up. */
  deleteNodes: (ids: string[]) => void;
  
  setDraggedNodeId: (id: string | null) => void;
  setDragTarget: (target: { x: number; y: number; z: number } | null) => void;
  setDragDistance: (distance: number) => void;
  
  /**
   * Adds a part and returns its id. With `parentId` it goes under that body and
   * the parent stays selected, so several adds in a row land side by side
   * rather than each under the last. Without one it goes at the top level and
   * is selected.
   */
  addComponent: (type: 'box' | 'sphere' | 'capsule' | 'cylinder' | 'bob' | 'gear' | 'wedge' | 'pulley_wheel' | 'pulley_rope' | 'mesh' | 'openscad' | 'pyramid' | 'cone' | 'torus' | 'tube' | 'ellipsoid' | 'curve' | 'ring' | 'sculpt' | 'lattice' | 'blob', position: number[], parentId?: string | null, opts?: AddPlacement) => string;

  /** Set how finely contact is resolved (SceneGraph.simFidelity). One undo step. */
  setSimFidelity: (fidelity: 'standard' | 'print') => void;
  /**
   * Replace the reference images (SceneGraph.referenceImages). Drawn only, so no
   * recompile. `recordUndo: false` is for the frames of a drag after its first,
   * so a slider pull is one undo step, not one per pixel.
   */
  setReferenceImages: (images: ReferenceImage[], recordUndo?: boolean) => void;

  // --- Lattice modelling ---------------------------------------------------
  //
  // The state here is the state of the TOOL, not of the shape: the shape lives
  // on the node as `latticeCage`, because it has to survive being saved and the
  // tool does not. See utils/latticeMesh.ts.
  /**
   * What the app is in the middle of, in the words a person would use: "Scale
   * 1.25x", "Inset 3.0 mm", "Extrude". Null when nothing modal is running.
   *
   * A gesture that is sized by the pointer has no dialog and no handle to read
   * a number off — the shape follows the mouse and that is the whole interface.
   * That works right up until you want to know WHICH gesture is running and how
   * far it has gone, which is what the status bar reads from here.
   */
  gestureStatus: string | null;
  setGestureStatus: (status: string | null) => void;

  /**
   * The measure tool: 'distance' wants two points, 'angle' wants three, null
   * is not measuring.
   *
   * A mode rather than a gesture, because a measurement is not an edit. Every
   * other modal thing in the app ends by changing the model or putting it back,
   * so it can be transient; this one ends by having told you a number, and the
   * number has to stay on screen while you go and do something about it. It
   * also outranks selection while it is on — a click is a pick, not a
   * selection — which is why it lives beside the tools rather than inside one.
   */
  measureMode: 'distance' | 'angle' | null;
  setMeasureMode: (mode: 'distance' | 'angle' | null) => void;
  /**
   * Which handles the paused-sim gizmo puts on the selected body.
   *
   * Editor state rather than component state, because what sets it is a click
   * in the viewport and a key, both of which live elsewhere. Selecting a
   * different body always comes back to the arrows: the move is what you want
   * nine times in ten, and a gizmo that remembered a turn from two bodies ago
   * would be a mode with nothing on screen to explain it.
   */
  gizmoMode: 'translate' | 'rotate';
  setGizmoMode: (mode: 'translate' | 'rotate') => void;
  /** Clicking the body that is already selected swaps the handles over. */
  cycleGizmoMode: () => void;

  /**
   * Which of the selected body's geoms the sidebar is showing, and the one a
   * gesture acts on: G with a cut selected here moves the cut rather than the
   * body. Reset to 0 — the body's first shape — whenever the body itself is
   * picked.
   */
  activeGeomIndex: number;
  setActiveGeomIndex: (index: number) => void;
  updateNodeScad: (id: string, scadCode: string, compiledData: { vertices: number[], faces: number[], renderVertices: number[] }, skipRecompile?: boolean) => void;
  // --- CSG (boolean modifiers) ---
  deleteNodeGeom: (nodeId: string, geomIndex: number) => void;
  setGeomCsgOp: (nodeId: string, geomIndex: number, csg: CsgOp) => void;
  /**
   * Puts a scaled copy of a body's own shape inside it, marked as a hole.
   *
   * The shortest path from a solid to a hollow one. Factors are per-axis, and
   * an axis above 1 is how the copy is made to pass right through — a cylinder
   * with a [0.8, 0.8, 1.05] copy of itself subtracted is a pipe, where the same
   * copy shrunk on all three would be a sealed cavity nobody can see.
   */
  insetNodeGeoms: (nodeId: string, factor: [number, number, number], pocket?: { axis: 0 | 1 | 2; side: 1 | -1 }) => void;
  applyNodeCsg: (nodeId: string, result: CsgResult, skipRecompile?: boolean) => void;
  setNodeCsgError: (nodeId: string, error: string | null, hash?: string) => void;
  applyNodeColliders: (nodeId: string, result: ColliderResult, skipRecompile?: boolean) => void;
  setNodeCollisionError: (nodeId: string, error: string | null, hash?: string) => void;
  recompile: (overrideScene?: SceneGraph, overrideSelectedId?: string | null, forceReset?: boolean, keepPreset?: boolean, settle?: boolean, immediate?: boolean) => Promise<void>;
  loadPreset: (name: string) => void;
  resetSimulation: () => void;
  /** Put one broken weld back, without resetting the rest of the scene. */
  restoreConstraint: (key: string) => void;
  /** A body has been hit: break it, dent it, or ignore it. */
  handleImpact: (event: ImpactEvent) => void;
  /**
   * Make a geom dentable, converting a primitive into the mesh it looked like.
   *
   * A dent moves vertices and a primitive has none, so this is what stands
   * between "tick the box" and a surface that can actually take a mark.
   * Returns false when the geom is something no mesh can be made of — a plane.
   */
  makeDentable: (nodeId: string, geomIndex: number, cfg: DentConfig) => boolean;
  /** Replace a body with its pieces, in the runtime overlay only. */
  shatterNode: (node: SceneNode, event: ImpactEvent, wallM?: number | null) => Promise<void>;
  recoverFromFatalWorkerError: (message: string, lastState?: { qpos: number[]; qvel: number[]; time: number; scriptState?: ScriptStateMap }) => Promise<void>;
  recycleWorkerSeamlessly: () => Promise<void>;
  incrementMcpActive: () => void;
  decrementMcpActive: () => void;
  resetMcpActive: () => void;
  incrementScadCompile: () => void;
  decrementScadCompile: () => void;
}

/** Which scene swap (a preset or generated board loading) is the latest. */
let sceneSwapId = 0;

/**
 * Finish a scene swap once its model is on screen: stop drawing the outgoing
 * scene, and only now put the camera back and frame the new one. Reset at the
 * click instead, the camera jumped to the starting view over the OLD scene, and
 * then jumped again when the new one arrived.
 *
 * Registered after the build has queued its own paint, so it lands in the same
 * frame as the model. A swap that a later one overtook does nothing: the later
 * one finishes it. Run whether or not the build succeeded, or a failed one
 * would hold the old scene on screen for good.
 */
function finishSceneSwap(
  id: number,
  build: Promise<void>,
  set: (fn: (state: PhysicsState) => Partial<PhysicsState>) => void,
  framing: () => ReturnType<typeof framingPatch>,
) {
  const finish = () => onNextPaint(() => {
    if (id !== sceneSwapId) return;
    set((state) => ({
      outgoingSceneGraph: null,
      cameraResetToken: state.cameraResetToken + 1,
      ...framing(),
    }));
  });
  void build.then(finish, finish);
}

/**
 * Every write of a new scene graph goes through shareUnchanged, so a node an
 * edit did not touch keeps its object and the viewport can skip it.
 */
const sharingUnchangedNodes = (config: StateCreator<PhysicsState>): StateCreator<PhysicsState> =>
  (rawSet, get, api) => {
    const set = ((partial: Parameters<typeof rawSet>[0], replace?: boolean) => {
      let patch = typeof partial === 'function' ? partial(get()) : partial;
      if (patch && 'sceneGraph' in patch && patch.sceneGraph) {
        // Clashing body and geom names renamed by the compiler's rule, so the
        // graph the viewport draws from names what the model holds; and what
        // was fixed to a body no longer here let go (utils/danglingReferences),
        // and connect pins kept on their bodies (utils/connectAnchors).
        const offered = patch.sceneGraph;
        patch.sceneGraph = withConnectAnchorsFollowing(
          get().sceneGraph,
          withUniqueNames(withoutDanglingReferences(patch.sceneGraph)),
        );
        const prev = get().sceneGraph;
        shareUnchanged(prev, patch.sceneGraph);
        if (userEditPending && castPrepBypass === 0 && castPrepArmed(prev) && bodiesChanged(prev, patch.sceneGraph)) {
          // Turned away: the rest of the patch (selection and the like) still applies.
          refusedGraphs.add(offered);
          refusedGraphs.add(patch.sceneGraph);
          const { sceneGraph: _refused, ...rest } = patch;
          patch = { ...rest, castPrepGuardOpen: true, castPrepBlocked: get().castPrepBlocked + 1 } as typeof patch;
        } else {
          keptGraphs.set(offered, patch.sceneGraph);
        }
      }
      (rawSet as (p: typeof patch, r?: boolean) => void)(patch, replace);
    }) as typeof rawSet;
    return config(set, get, api);
  };

export const useStore = create<PhysicsState>()(sharingUnchangedNodes((set, get) => ({
  ...hardwarePartActions({ set, get, clone: cloneSceneGraph }),
  ...extrusionActions({ set, get, clone: cloneSceneGraph }),
  ...clipboardActions({ set, get, clone: cloneSceneGraph }),
  ...shapeParamActions({ set, get }),
  ...latticeActions({ set, get }),
  ...sculptActions({ set, get }),
  ...printSplitActions({ set, get }),
  ...edgeRoundActions({ set, get }),
  ...castPrepActions({ set, get }),
  ...cutActions({ set, get }),
  mujoco: null,
  model: null,
  data: null,
  recompileId: 0,

  // History State
  undoStack: [],
  redoStack: [],
  tempUndoState: null,
  lastInteractionType: null,

  // History Actions
  recordInteraction: (type: string) => {
    markUserEdit();
    const state = get();
    if (state.lastInteractionType && state.lastInteractionType !== type) {
      state.flushPendingUndo();
    }

    if (!get().tempUndoState) {
      const snapshot: UndoRedoState = {
        sceneGraph: cloneSceneGraph(get().sceneGraph),
        gravityZ: get().gravityZ,
        windX: get().windX,
        windY: get().windY,
        density: get().density,
        floorFriction: get().floorFriction,
        floorBounce: get().floorBounce,
        selectedNodeId: get().selectedNodeId,
        latticeNodeId: get().latticeNodeId,
      };
      set({
        tempUndoState: snapshot,
        lastInteractionType: type
      });
    }

    if (historyDebounceTimer) clearTimeout(historyDebounceTimer);
    historyDebounceTimer = setTimeout(() => {
      get().flushPendingUndo();
    }, 800);
  },

  flushPendingUndo: () => {
    const { tempUndoState, undoStack } = get();
    if (historyDebounceTimer) clearTimeout(historyDebounceTimer);
    historyDebounceTimer = null;

    if (tempUndoState) {
      const current = get();
      const isDifferent =
        tempUndoState.gravityZ !== current.gravityZ ||
        tempUndoState.windX !== current.windX ||
        tempUndoState.windY !== current.windY ||
        tempUndoState.density !== current.density ||
        tempUndoState.floorFriction !== current.floorFriction ||
        tempUndoState.floorBounce !== current.floorBounce ||
        !sameValue(tempUndoState.sceneGraph, current.sceneGraph);

      if (isDifferent) {
        const newUndoStack = [...undoStack, tempUndoState];
        // A snapshot shares the mesh arrays with the scene it was taken from
        // (see cloneGeom), so a step costs the scene's small fields, not its
        // vertices. Twenty was a few minutes of work.
        if (newUndoStack.length > UNDO_LIMIT) {
          newUndoStack.shift();
        }
        set({
          undoStack: newUndoStack,
          redoStack: [],
          tempUndoState: null,
          lastInteractionType: null,
        });
      } else if (recompilesInFlight > 0) {
        // Nothing has moved YET. The change is still on its way through the
        // compiler, and the landing calls back here.
      } else {
        set({
          tempUndoState: null,
          lastInteractionType: null,
        });
      }
    }
  },

  /*
   * Snapshot before a change that happens all at once, rather than over a drag.
   *
   * Held for a tick rather than pushed on the spot, and then pushed only if the
   * scene actually moved. Everything that writes to the scene comes through
   * here — including the MCP bridge, which calls updateScene/updateNode for
   * every command an agent sends, whether or not the command changes anything.
   * Pushing unconditionally filled the undo stack with entries that undo to
   * exactly what is already on screen: twenty presses of Ctrl+Z that appear to
   * do nothing, with the edit you wanted back pushed off the end of the stack.
   *
   * The timer is zero, so the entry lands as soon as the change that follows
   * this call has been made — and any further discrete change flushes it first,
   * so a run of them still gets one entry each rather than being swallowed.
   */
  prepareForDiscreteChange: () => {
    markUserEdit();
    get().flushPendingUndo();
    const { sceneGraph, gravityZ, windX, windY, density, floorFriction, floorBounce, selectedNodeId, latticeNodeId } = get();
    const snapshot: UndoRedoState = {
      sceneGraph: cloneSceneGraph(sceneGraph),
      gravityZ,
      windX,
      windY,
      density,
      floorFriction,
      floorBounce,
      selectedNodeId,
      latticeNodeId,
    };
    set({
      tempUndoState: snapshot,
      lastInteractionType: 'discrete',
    });
    historyDebounceTimer = setTimeout(() => get().flushPendingUndo(), 0);
  },

  undo: () => {
    if (get().castPrepBusy) return;
    withCastPrepBypass(() => {
      get().flushPendingUndo();
      const { undoStack, redoStack, sceneGraph, gravityZ, windX, windY, density, floorFriction, floorBounce, selectedNodeId, latticeNodeId } = get();
      if (undoStack.length === 0) return;

      const previousState = undoStack[undoStack.length - 1];
      const newUndoStack = undoStack.slice(0, -1);

      const currentStateSnapshot: UndoRedoState = {
        sceneGraph: cloneSceneGraph(sceneGraph),
        gravityZ,
        windX,
        windY,
        density,
        floorFriction,
        floorBounce,
        selectedNodeId,
        latticeNodeId,
      };

      set({
        sceneGraph: previousState.sceneGraph,
        gravityZ: previousState.gravityZ,
        windX: previousState.windX,
        windY: previousState.windY,
        density: previousState.density,
        floorFriction: previousState.floorFriction,
        floorBounce: previousState.floorBounce,
        selectedNodeId: previousState.selectedNodeId,
        // The tools follow the document back. A body that has just stopped
        // existing cannot be the one being modelled, and the editor holding its
        // own copy of the cage is exactly how a ghost gets committed back in.
        ...latticeAfterUndo(previousState),
        undoStack: newUndoStack,
        redoStack: [...redoStack, currentStateSnapshot],
        isPlaying: false
    });

    get().recompile(previousState.sceneGraph, previousState.selectedNodeId, true, true);
    rebuildBooleansAfterRestore();
    });
  },

  redo: () => {
    if (get().castPrepBusy) return;
    withCastPrepBypass(() => {
      get().flushPendingUndo();
      const { undoStack, redoStack, sceneGraph, gravityZ, windX, windY, density, floorFriction, floorBounce, selectedNodeId, latticeNodeId } = get();
      if (redoStack.length === 0) return;

      const nextState = redoStack[redoStack.length - 1];
      const newRedoStack = redoStack.slice(0, -1);

      const currentStateSnapshot: UndoRedoState = {
        sceneGraph: cloneSceneGraph(sceneGraph),
        gravityZ,
        windX,
        windY,
        density,
        floorFriction,
        floorBounce,
        selectedNodeId,
        latticeNodeId,
      };

      set({
        sceneGraph: nextState.sceneGraph,
        gravityZ: nextState.gravityZ,
        windX: nextState.windX,
        windY: nextState.windY,
        density: nextState.density,
        floorFriction: nextState.floorFriction,
        floorBounce: nextState.floorBounce,
        selectedNodeId: nextState.selectedNodeId,
        ...latticeAfterUndo(nextState),
        undoStack: [...undoStack, currentStateSnapshot],
        redoStack: newRedoStack,
        isPlaying: false
    });

    get().recompile(nextState.sceneGraph, nextState.selectedNodeId, true, true);
    rebuildBooleansAfterRestore();
    });
  },

  isPlaying: false,
  voltLink: null,
  brokenConstraints: [],
  lastBreak: null,
  shatteredBodies: {},
  visibleShatteredBodies: {},
  deformedGeoms: {},
  lastShatter: null,
  isLoaded: false,
  lastCompileError: null,
  isSettingsOpen: false,
  machineTarget: 'fdm',
  material: DEFAULT_MATERIAL,
  filament: DEFAULT_FILAMENT,
  stock: loadStock(),
  printBed: loadPrintBed(),
  setPrintBed: (patch) => set((state) => ({ printBed: savePrintBed(clampPrintBed({ ...state.printBed, ...patch })) })),
  cncBed: loadCncBed(),
  setCncBed: (patch) => set((state) => ({ cncBed: saveCncBed(clampCncBed({ ...state.cncBed, ...patch })) })),
  carveSettings: null,
  patternGeneratorId: null,
  facePatternTarget: null,
  isMachineConfigOpen: false,
  cameraView: 'perspective',
  dimsEnabled: true, // only drawn in Top/Front/Side; on, so a flat view arrives measured
  cameraOffAxis: false,
  cameraOverride: initialFraming.cameraOverride,
  cameraResetToken: 0,
  outgoingSceneGraph: null,
  mcpActiveCount: 0,
  scadCompileCount: 0,
  
  gravityZ: -9.81,
  windX: 0,
  windY: 0,
  density: 0,
  floorFriction: 1.0,
  floorBounce: 0.0,
  
  rotateAroundCOM: true,
  setRotateAroundCOM: (val) => set({ rotateAroundCOM: val }),
  sceneGraph: initialScene,
  selectedNodeId: null,
  extraSelectedIds: [],
  hiddenNodeIds: [],
  activePreset: initialPreset,
  setActivePreset: (name) => set({ activePreset: name }),
  draggedNodeId: null,
  dragTarget: null,
  dragDistance: 0,

  toggleNodeHidden: (id) => set((state) => ({
    hiddenNodeIds: state.hiddenNodeIds.includes(id)
      ? state.hiddenNodeIds.filter((h) => h !== id)
      : [...state.hiddenNodeIds, id],
  })),
  incrementMcpActive: () => set((state) => ({ mcpActiveCount: state.mcpActiveCount + 1 })),
  decrementMcpActive: () => set((state) => ({ mcpActiveCount: Math.max(0, state.mcpActiveCount - 1) })),
  resetMcpActive: () => set({ mcpActiveCount: 0 }),
  incrementScadCompile: () => set((state) => ({ scadCompileCount: state.scadCompileCount + 1 })),
  decrementScadCompile: () => set((state) => ({ scadCompileCount: Math.max(0, state.scadCompileCount - 1) })),

  togglePlay: () => set((state) => {
    // Playing hands the clock back from Volt: the two cannot both drive it.
    if (state.voltLink) endVoltLink();
    const isPlaying = !state.isPlaying;
    getPhysicsWorkerClient().setPlaying(isPlaying);
    // Something in this scene can break: have the cutter loaded before it does.
    if (isPlaying && anyNode(state.sceneGraph.nodes, canShatter)) prewarmFractureWorker();
    return { isPlaying };
  }),
  setLoaded: (loaded) => set({ isLoaded: loaded }),
  setSettingsOpen: (open) => set({ isSettingsOpen: open }),
  setMachineTarget: (machineTarget) => set({ machineTarget }),
  setFilament: (filament) => set({ filament }),
  setMaterial: (material) => set({ material }),
  setStock: (patch) => set((state) => ({ stock: saveStock(clampStock({ ...state.stock, ...patch })) })),
  setCarveSettings: (carveSettings) => set({ carveSettings }),
  openPatternGenerator: (id) => set({ patternGeneratorId: id }),
  closePatternGenerator: () => set({ patternGeneratorId: null }),
  openFacePattern: (target) => set({ facePatternTarget: target }),
  closeFacePattern: () => set({ facePatternTarget: null }),
  setMachineConfigOpen: (isMachineConfigOpen) => set({ isMachineConfigOpen }),
  // The token too: choosing the view you are already in, after orbiting off
  // it, is asking for its pose back, and the view alone would not change.
  setCameraView: (view) => set((state) => ({ cameraView: view, cameraOverride: null, cameraResetToken: state.cameraResetToken + 1 })),
  setDimsEnabled: (dimsEnabled) => set({ dimsEnabled }),
  setCameraOffAxis: (cameraOffAxis) => set({ cameraOffAxis }),
  dfmEnabled: false,
  setDfmEnabled: (dfmEnabled) => set({ dfmEnabled }),
  dfmCastOpen: false,
  setDfmCastOpen: (dfmCastOpen) => set({ dfmCastOpen }),
  dfmPanel: { x: null, y: null, minimized: false },
  setDfmPanel: (patch) => set((state) => ({ dfmPanel: { ...state.dfmPanel, ...patch } })),

  wireframe: false,
  toggleWireframe: () => set((state) => ({ wireframe: !state.wireframe })),
  showEdges: true,
  toggleShowEdges: () => set((state) => ({ showEdges: !state.showEdges })),
  gridCellSizeMm: initialFraming.gridCellSizeMm,
  // The one grid. The lattice used to have its own step beside this, and two
  // controls that both said "grid" and meant different things was one too
  // many: 1 mm on the floor and 10 mm in the lattice looked like a bug in the
  // lattice. Cells are millimetres; lattice steps are tenths, hence the ten.
  setGridCellSizeMm: (mm) => set({ gridCellSizeMm: mm, latticeSnap: snapForGridMm(mm) }),

  paintMode: false,
  paintColor: [0.91, 0.30, 0.24],
  paintRadius: 0.008,
  paintFlow: 0.35,
  togglePaintMode: () => set((state) => ({ paintMode: !state.paintMode })),
  setPaintColor: (paintColor) => set({ paintColor }),
  setPaintBrush: (patch) => set((state) => ({
    paintRadius: patch.radius ?? state.paintRadius,
    paintFlow: patch.flow ?? state.paintFlow,
  })),

  setGeomPaint: (nodeId, geomName, layer) => {
    const existing = findNode(get().sceneGraph.nodes, nodeId);
    const index = existing?.geoms?.findIndex((geom: SceneGeom) => geom.name === geomName) ?? -1;
    if (index === -1) return;

    get().recordInteraction('paint');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const node = findNode(newScene.nodes, nodeId);
    if (!node?.geoms?.[index]) return;
    if (layer) node.geoms[index].paint = layer;
    else delete node.geoms[index].paint;

    // Deliberately no recompile.
    //
    // Every other geom edit has to rebuild the MJCF and swap the model in the
    // physics worker, because every other geom edit changes something MuJoCo
    // reads. Paint is not one: the emitter names the attributes it writes, no
    // exporter reads vertex colour, and the viewport takes a geom's colour off
    // the scene graph rather than out of the compiled model. Rebuilding here
    // would drop the simulation back to its initial pose once per stroke to
    // change nothing the simulation can see.
    set({ sceneGraph: newScene });
  },

  setGeomTextures: (nodeId, geomName, textures) => {
    const existing = findNode(get().sceneGraph.nodes, nodeId);
    const index = existing?.geoms?.findIndex((geom: SceneGeom) => geom.name === geomName) ?? -1;
    if (index === -1) return;

    get().recordInteraction('pattern');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const node = findNode(newScene.nodes, nodeId);
    if (!node?.geoms?.[index]) return;
    if (textures?.length) node.geoms[index].textures = textures;
    else delete node.geoms[index].textures;
    // No recompile, for the reason setGeomPaint gives: the physics is the
    // shape as authored, and the viewport and the exporters read the
    // patterns off the scene graph (utils/geomSurface).
    set({ sceneGraph: newScene });
  },

  setGeomFaceSplits: (nodeId, geomName, splits) => {
    const existing = findNode(get().sceneGraph.nodes, nodeId);
    if (!existing?.geoms?.some((geom: SceneGeom) => geom.name === geomName)) return;
    get().prepareForDiscreteChange();
    const newScene = cloneSceneGraph(get().sceneGraph);
    const geom = findNode(newScene.nodes, nodeId)?.geoms?.find((g: SceneGeom) => g.name === geomName);
    if (!geom) return;
    if (splits?.length) geom.faceSplits = splits;
    else delete geom.faceSplits;
    // No recompile: a seam changes no shape (see setGeomTextures).
    set({ sceneGraph: newScene });
  },

  setGeomColor: (nodeId, geomName, rgba) => {
    get().recordInteraction('node-geom');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const node = findNode(newScene.nodes, nodeId);
    if (!node?.geoms?.length) return;

    // No name means the whole body, which is what colouring an imported mesh or
    // a boolean body usually means — those arrive as several geoms and leaving
    // some of them the old colour is never what was asked for.
    const targets = geomName ? node.geoms.filter((g: SceneGeom) => g.name === geomName) : node.geoms;
    if (!targets.length) return;
    for (const geom of targets) {
      geom.rgba = [rgba[0] ?? 0.8, rgba[1] ?? 0.8, rgba[2] ?? 0.8, rgba[3] ?? geom.rgba?.[3] ?? 1];
    }

    // Base colour does go into the MJCF, unlike paint, so this one recompiles —
    // once for the whole body rather than once per geom.
    set({ sceneGraph: newScene });
    get().recompile(newScene, undefined, true);
  },

  clearAllPaint: () => {
    get().recordInteraction('paint');
    const newScene = cloneSceneGraph(get().sceneGraph);
    let found = false;
    const walk = (nodes: SceneNode[]) => {
      for (const node of nodes || []) {
        for (const geom of node.geoms || []) {
          if (geom.paint) { delete geom.paint; found = true; }
        }
        walk(node.children);
      }
    };
    walk(newScene.nodes);
    if (found) set({ sceneGraph: newScene });
  },

  addHardwareComponentNode: (hardwareNode, opts) => {
    get().prepareForDiscreteChange();
    const sceneGraph = get().sceneGraph;
    const newNodes = [...sceneGraph.nodes, hardwareNode];
    // In the store now, not when the build lands: a build that finds the scene
    // changed under it keeps the newer scene, so a body that only rode in on the
    // build was lost to any edit made meanwhile — a collider decomposition
    // finishing just after a load took a simulated cast that way.
    const select = opts?.select !== false;
    // Selected, it is the whole selection, not one more body in it.
    set({ sceneGraph: { ...sceneGraph, nodes: newNodes }, ...(select ? { extraSelectedIds: [] } : {}) });
    get().recompile(get().sceneGraph, select ? hardwareNode.id : undefined);
  },
  // An explicit pose is an eye position and a target, which is a perspective
  // pose: the orthographic drawing views are framed by their axis and zoom.
  setCameraOverride: (override) => set(override ? { cameraOverride: override, cameraView: 'perspective' } : { cameraOverride: null }),
  
  resetSimulation: () => {
    getPhysicsWorkerClient().setPlaying(false);
    // Clearing all of this before the rebuild is what puts a broken object back
    // together: the scene graph was never edited, so a build with nothing in
    // the broken set, no runtime overlay and no dents emits exactly the scene
    // that was authored.
    clearBreakage(set);
    set({ isPlaying: false });
    get().recompile(undefined, undefined, true, true);
  },

  /*
   * A body has just been hit hard enough to matter.
   *
   * Shattering wins over denting when both apply: there is no point creasing
   * the surface of something that is about to stop existing. Both are decided
   * from the same measured impulse, which is what makes them read as one
   * material rather than as two unrelated features.
   */
  handleImpact: (event) => {
    const state = get();
    // Look the body up in the graph that is actually running: a shard has no
    // entry in the document, and a body that already broke has none either.
    const live = effectiveSceneGraph(state.sceneGraph, state.shatteredBodies);
    const node = findNodeById(live.nodes, event.nodeId);
    if (!node) return;

    // Already coming apart: the blow has nothing left to do to this body.
    const cutting = fracturing.has(node.id);
    if (!state.shatteredBodies[node.id] && !cutting) {
      const wallM = node.shatterThicknessRef ? wallAtImpact(node, event.localPoint) : null;
      if (shatterVerdict(event.impulseNs, node, wallM)) {
        get().shatterNode(node, event, wallM);
        return;
      }
    }

    // Dent whatever was soft enough, on either end of the collision. The body
    // that reported the blow is usually the striker, so the thing that takes
    // the mark is usually the other one.
    const other = event.otherNodeId ? findNodeById(live.nodes, event.otherNodeId) : null;
    // Each end of the collision is marked by the shape of the other end.
    if (!cutting) dentBody(node, event.localPoint, event.localNormal, event.impulseNs, imprintOf(other?.geoms?.[0]));
    if (other && event.otherLocalPoint && event.otherLocalNormal) {
      dentBody(other, event.otherLocalPoint, event.otherLocalNormal, event.impulseNs, imprintOf(node.geoms?.[0]));
    }
  },

  /*
   * Replace a body with its pieces, in the runtime overlay only.
   *
   * The rebuild is NOT a force reset: the rest of the scene is mid-flight and
   * has to stay there. It changes the number of degrees of freedom, though, so
   * the worker cannot carry the state over by copying arrays — it matches
   * joints by name instead, which is what the by-joint branch of doBuild is for.
   */
  shatterNode: async (node, event, wallM) => {
    const geom = (node.geoms || []).find((g) => (g.renderVertices ?? g.vertices) && g.faces);
    const source = geom && (geom.renderVertices ?? geom.vertices);
    if (!geom || !source || !geom.faces) return;

    // Stay inside the shard budget. Every entry in `shatteredBodies` lists the
    // pieces of one break, and a piece that has broken again is no longer in
    // the world, so the live ones are the pieces with no entry of their own.
    // A shard breaking now gives its own slot back.
    const broken = get().shatteredBodies;
    const live = Object.values(broken).flat().filter((s) => !broken[s.id]);
    let promised = 0;
    for (const n of fracturing.values()) promised += n;
    const room = MAX_LIVE_SHARDS - live.length - promised + (live.some((s) => s.id === node.id) ? 1 : 0);
    const pieces = Math.min(node.shatterPieces ?? DEFAULT_FRACTURE_PIECES, room);
    if (pieces < 2) return;

    // Cut in the worker while the old model keeps stepping. The pieces are
    // posed from the impact, and rebaseShard moves them onto wherever the body
    // has got to by the time the rebuild lands, so the wait costs no accuracy.
    fracturing.set(node.id, pieces);
    const epoch = breakageEpoch;
    let cells: Awaited<ReturnType<typeof fractureMeshOffThread>>;
    try {
      cells = await fractureMeshOffThread(source, geom.faces, {
        pieces,
        seed: node.shatterSeed ?? 1,
        focus: node.shatterPattern === 'uniform'
          ? undefined
          : [event.localPoint[0], event.localPoint[1], event.localPoint[2]],
      });
    } catch (err) {
      console.warn('[shatter]', err);
      cells = [];
    } finally {
      if (epoch === breakageEpoch) fracturing.delete(node.id);
    }
    // Reset, or a new scene, while it was being cut: that break never happened.
    if (epoch !== breakageEpoch) return;
    const nowBroken = get().shatteredBodies;
    if (nowBroken[node.id]) return;
    if (!findNodeById(effectiveSceneGraph(get().sceneGraph, nowBroken).nodes, node.id)) return;
    // Fewer than two pieces is not a shatter, and replacing a body with one
    // shard would be a visible no-op that had thrown its collider away.
    if (cells.length < 2) return;

    const { shards } = buildShatterGraph(node, source, geom.faces, cells, {
      pos: [event.pos[0], event.pos[1], event.pos[2]],
      xmat: event.xmat,
      vel: [event.vel[0], event.vel[1], event.vel[2]],
      angvel: [event.angvel[0], event.angvel[1], event.angvel[2]],
    }, {
      spread: node.shatterSpread,
      totalMass: bodyMassOf(node),
      rgba: geom.rgba,
      friction: geom.friction,
      solref: geom.solref,
      solimp: geom.solimp,
      recursion: (node.shatterDepth ?? 0) > 0 ? {
        generation: (node.shatterGeneration ?? 0) + 1,
        depth: node.shatterDepth!,
        impulseNs: node.shatterImpulseNs!,
        thicknessRef: node.shatterThicknessRef,
        pieces: node.shatterPieces ?? 8,
        pattern: node.shatterPattern,
        spread: node.shatterSpread,
        seed: node.shatterSeed,
      } : undefined,
    });

    set({
      shatteredBodies: { ...nowBroken, [node.id]: shards },
      lastShatter: { nodeId: node.id, name: node.name, pieces: shards.length, time: event.time, impulseNs: event.impulseNs, wallM: wallM ?? undefined },
    });
    scheduleShatterRebuild(() => get().recompile(undefined, undefined, false, true, false, true));
  },

  makeDentable: (nodeId, geomIndex, cfg) => {
    const node = findNodeById(get().sceneGraph.nodes, nodeId);
    const geom = node?.geoms?.[geomIndex];
    if (!node || !geom) return false;

    const updates: Partial<SceneGeom> = { ...cfg };
    if (!isDentable(geom)) {
      const mesh = meshForDenting(geom);
      if (!mesh) return false;
      updates.type = 'mesh';
      updates.vertices = mesh.vertices;
      updates.renderVertices = toRenderVertices(mesh.vertices);
      updates.faces = mesh.faces;
      // A fromto carried the shape's direction AND its offset. meshForDenting
      // has turned the vertices to face the right way; the offset moves to the
      // geom's pos, because these vertices are the collision geometry too and
      // MuJoCo recentres a mesh asset on its centroid. Bake the offset in and
      // the thing collides half its own length away from where it is drawn.
      if (geom.fromto) {
        updates.pos = fromtoCenter(geom.fromto);
        updates.fromto = undefined;
      }
      // A mesh geom on a body that can move has to say so, or it is drawn from
      // vertices baked once into world space and never tracks the body again:
      // it simulates and drags correctly and looks frozen in place.
      if ((node.joints || []).length > 0) updates.dynamic = true;
      // The shape is its own hull, so there is nothing for the decomposer to
      // find and every reason not to spend a rebuild looking.
      if (!node.collision) get().updateNode(node.id, { collision: 'hull' });
    }
    get().updateNodeGeom(node.id, updates, geomIndex);
    return true;
  },

  restoreConstraint: (key) => {
    const prev = get().brokenConstraints;
    if (!prev.includes(key)) return;
    const next = prev.filter((k) => k !== key);
    set({
      brokenConstraints: next,
      lastBreak: get().lastBreak?.key === key ? null : get().lastBreak,
    });
    // Undebounced and state-preserving: the weld comes back where the body is
    // now, not where it was when it broke.
    get().recompile(undefined, undefined, false, true);
  },
  
  loadPreset: (name) => {
    const prev = get().activePreset;
    get().prepareForDiscreteChange();
    getPhysicsWorkerClient().setPlaying(false);
    // Whatever broke in the last scene broke in THAT scene. Carried over, a
    // reloaded vase was already "in pieces" and could never break again, and
    // a weld whose key the new scene happens to share started out sheared.
    clearBreakage(set);
    if (name.startsWith('user:')) {
      set({
        isPlaying: false,
        selectedNodeId: null,
        hiddenNodeIds: [],
        activePreset: name,
        carveSettings: null,
        cameraOverride: null,
        latticeNodeId: null,
        latticeStats: null,
        sculptNodeId: null,
        sculptStats: null,
        gestureStatus: null,
      });
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('physics:preset-loaded', { detail: { name, prev } }));
      }
      try {
        const saved = readUserPreset(name);
        // Two shapes are in circulation. App.tsx spreads the graph, so the nodes
        // sit at the top level; the MCP bridge used to nest it under a
        // `sceneGraph` key, and every preset an agent saved before that was
        // fixed still has them one level down. Read either, so those presets are
        // not stranded.
        const nested = (saved as { sceneGraph?: SceneGraph } | null)?.sceneGraph;
        // The picture and the date belong to the preset, not the scene: left
        // on, they would ride along in the graph into every export, share
        // link and later save.
        const { thumbnail: _thumbnail, savedAt: _savedAt, ...savedGraph } = saved ?? {};
        const savedScene: SceneGraph | null =
          saved && Array.isArray(saved.nodes) ? (savedGraph as unknown as SceneGraph)
          : nested && Array.isArray(nested.nodes) ? nested
          : null;
        // A preset with no nodes is a corrupt or half-written entry rather than
        // an empty scene; recompiling it would throw inside the MJCF builder.
        if (savedScene) {
          promoteJointedMeshGeomsDeep(savedScene.nodes);
          // A saved scene never carries a camera, so it is framed entirely
          // from its own bounds — the same as a preset that does not state
          // one. After the rebuild, for the same reason the presets are.
          finishSceneSwap(++sceneSwapId, get().recompile(savedScene, null, true, true), set,
            () => framingPatch(savedScene, null));
        }
      } catch (e) {
        console.error('Failed to load user preset', e);
      }
      return;
    }
    const preset: Preset | undefined = (PRESETS as Record<string, Preset>)[name];
    if (!preset) return;
    // Clone: PRESETS holds module-level objects, and handing one straight to the
    // store makes every later edit an edit of the preset itself — reloading it
    // would then restore the edited scene rather than the original.
    const scene: SceneGraph = name === 'empty'
      ? { nodes: [] }
      : cloneSceneGraph(preset.scene || get().sceneGraph);
    promoteJointedMeshGeomsDeep(scene.nodes);
    /*
     * Most presets rely on the default bench-scale framing, but a small one
     * (california_relief, lattice_bracket) can specify its own so it does not
     * read as a speck at that distance.
     *
     * It is applied AFTER the rebuild, not with the scene. The scene graph
     * changes here and now; the model the viewport draws is built by the worker
     * and arrives later, so moving the camera in this breath framed the OLD
     * scene from 120 mm away — a dark shape filling the window for a frame or
     * two before the new one appeared. Cleared immediately either way, so a
     * stale override from the previous preset cannot leak into one that did not
     * ask for it.
     */
    const framing = preset.camera ?? null;
    const swap = ++sceneSwapId;
    set((state) => ({
      isPlaying: false,
      selectedNodeId: null,
      hiddenNodeIds: [],
      activePreset: name,
      sceneGraph: scene,
      // A load that overtakes another still shows what was on screen.
      outgoingSceneGraph: state.outgoingSceneGraph ?? state.sceneGraph,
      // A preset that does not say how it is cut gets the exporter's defaults
      // back, rather than inheriting the last one's.
      carveSettings: preset.carve ?? null,
      stock: stockFromCarve(preset.carve, state.stock),
      // Back to the view every scene starts in, once it is on screen (see
      // finishSceneSwap). Whatever the camera was doing belonged to the scene
      // that has just gone: a view orbited round a 40 mm part, or zoomed to six
      // millimetres inside a lattice, frames the next preset as a wall of
      // geometry across the window.
      cameraOverride: null,
      // The modelling tools were open on a body that no longer exists.
      latticeNodeId: null,
      latticeStats: null,
      sculptNodeId: null,
      sculptStats: null,
      gestureStatus: null,
    }));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('physics:preset-loaded', { detail: { name, prev } }));
    }
    if (preset.environment) {
      set({ windX: 0, windY: 0, floorBounce: 0, ...preset.environment });
    } else {
      set({ windX: 0, windY: 0, floorBounce: 0 });
    }
    finishSceneSwap(swap, get().recompile(scene, null, true, true), set,
      () => framingPatch(scene, framing));
  },


  /**
   * Replace the scene with a generated one.
   *
   * The same sequence as loading a preset, and for the same reasons -- the
   * camera has to be reset because the view belonged to a scene that has gone,
   * and the modelling tools have to be closed because they were open on a body
   * that no longer exists. `activePreset` goes to null: a generated board is
   * not a preset, and claiming to be one would make the dropdown offer to
   * "reload" something that cannot be reloaded.
   */
  loadGeneratedScene: (scene, carve) => {
    get().prepareForDiscreteChange();
    getPhysicsWorkerClient().setPlaying(false);
    const swap = ++sceneSwapId;
    set((state) => ({
      isPlaying: false,
      selectedNodeId: null,
      hiddenNodeIds: [],
      // A generated board is not a preset, and saying it is would make the
      // dropdown offer to reload something that cannot be reloaded. `undefined`
      // rather than null, which is what the field is typed as and what
      // `activePresetLabel` already falls through to.
      activePreset: undefined,
      sceneGraph: scene,
      outgoingSceneGraph: state.outgoingSceneGraph ?? state.sceneGraph,
      carveSettings: carve,
      stock: stockFromCarve(carve, state.stock),
      patternGeneratorId: null,
      facePatternTarget: null,
      cameraOverride: null,
      latticeNodeId: null,
      latticeStats: null,
      sculptNodeId: null,
      sculptStats: null,
      gestureStatus: null,
      windX: 0,
      windY: 0,
      floorBounce: 0,
    }));
    // A generated board is sized from the stock it will be cut from, which
    // is usually a good deal smaller than the default view assumes.
    finishSceneSwap(swap, get().recompile(scene, null, true, true), set,
      () => framingPatch(scene, null));
  },

  setEnvironment: (env) => {
    get().recordInteraction('environment');
    set(env);
    get().recompile(get().sceneGraph);
  },
  
  setSelectedNodeId: (id) => set((state) => ({
    selectedNodeId: id,
    extraSelectedIds: [],
    // A different body starts on the move handles again. Re-selecting the same
    // one leaves them alone, so the viewport's click-to-swap is not undone by
    // the selection it travels with.
    gizmoMode: state.selectedNodeId === id ? state.gizmoMode : 'translate',
  })),
  combineBodies: (targetId, sourceIds, op) => {
    const scene = get().sceneGraph;
    const target = findNode(scene.nodes, targetId);
    const sources = sourceIds
      .filter(id => id !== targetId)
      .map(id => findNode(scene.nodes, id))
      .filter((n): n is SceneNode => n !== null);
    if (!target || sources.length === 0) return;

    // Every geom is written relative to the body carrying it, so moving one to
    // another body means composing three transforms: the source body's pose,
    // the geom's own, and the inverse of the destination's. This is the first
    // and last of those; utils/combineBodies does the middle one per geom.
    const targetWorld = nodeWorldMatrix(scene.nodes, targetId);
    if (!targetWorld) return;
    const intoTarget = targetWorld.clone().invert();

    get().prepareForDiscreteChange();
    const newScene = cloneSceneGraph(scene);
    const node = findNode(newScene.nodes, targetId);
    if (!node) return;

    /*
      Two lattice bodies combined become ONE CAGE, not one cage with the other's
      frozen mesh bolted on. The mesh route worked in the sense that the shape
      was there, and failed in the sense that mattered: open the lattice tools
      afterwards and only the first body's corners could be touched, because the
      second was a mesh geom the cage knew nothing about.

      A cage corner lives in its body's frame at `coord * unit - latticeOrigin`
      (the mesh is recentred on its centre of mass; the origin is how far).
      That point goes through the same three transforms as any other geom and
      lands on the target's grid, rounded — so a source turned by something
      other than a right angle comes across as the nearest grid shape, which is
      what the grid means.

      The cages are then put through a real boolean (utils/latticeBoolean),
      which is the difference between a join and a union: concatenating them
      left the surface where the two solids met buried inside the result, along
      with every corner of it. All three operations go this way now — a cage
      cannot carry a 'subtract' marker, but it can be subtracted FROM.
    */
    const merged = node.isLattice && node.latticeCage
      ? deserializeCage(node.latticeCage)
      : null;
    let mergedFaces = 0;
    let mergedResult: ReturnType<typeof deserializeCage> | null = null;

    const taken = new Set<string>((node.geoms || []).map((g: SceneGeom) => g.name).filter(Boolean));
    const brought: SceneGeom[] = [];
    for (const source of sources) {
      const sourceWorld = nodeWorldMatrix(scene.nodes, source.id);
      if (!sourceWorld) continue;
      const relative = intoTarget.clone().multiply(sourceWorld);
      const cage = merged && source.isLattice && source.latticeCage ? deserializeCage(source.latticeCage) : null;
      let combined = false;
      if (cage && merged) {
        // Into a cage of its own rather than straight onto the target's: a
        // boolean compares two solids, and concatenating them first is exactly
        // the join that left a wall buried down the seam.
        const moved = cageInFrame(cage, relative, source.latticeOrigin, node.latticeOrigin, merged.unit);
        const result = latticeBoolean(mergedResult ?? merged, moved, op);
        if (result) {
          mergedResult = result;
          mergedFaces = faceCount(result);
          combined = true;
        }
      }
      // Only the cage went across, so the source's mesh stays behind. If the
      // boolean refused — an open shell, or a difference that removed
      // everything — nothing was combined and the geoms have to come the old
      // way, or the shape would simply vanish.
      brought.push(...geomsForCombine(source, relative, op, taken, combined));
    }
    if (brought.length === 0 && mergedFaces === 0) return;

    node.geoms = [...(node.geoms || []), ...brought];
    if (mergedResult && mergedFaces > 0) {
      node.latticeCage = serializeCage(mergedResult);
      // A new cage is a new document to the editor, which remounts on this.
      node.latticeVersion = (node.latticeVersion ?? 1) + 1;
    }
    // A boolean that happened on the cage has already happened; turning the
    // evaluator on as well would subtract the source a second time.
    if (op !== 'union' && !mergedResult) {
      node.csgEnabled = true;
      if (node.csgCollision === undefined) node.csgCollision = 'auto';
      if (node.csgSectors === undefined) node.csgSectors = CSG_DEFAULT_SECTORS;
    }

    // The bodies that were merged in are gone: their shapes are on the target
    // now, and leaving the originals behind would draw every one of them twice
    // and simulate them as separate objects that happen to overlap.
    // The bodies hung off them are not merged, and move to the target.
    // Welds to a merged body hold the merged part now.
    for (const source of sources) {
      removeMergedBody(newScene.nodes, source.id, targetId);
      newScene.nodes = retargetReferences(newScene.nodes, source.id, targetId);
    }

    set({ sceneGraph: newScene, extraSelectedIds: [], selectedNodeId: targetId });
    if (mergedResult && mergedFaces > 0) {
      // Rebuilds the mesh from the merged cage, recentres the body on it, and
      // recompiles — the same path an edit in the lattice tools takes.
      // Written a few lines above, under this same condition.
      get().applyLattice(targetId, node.latticeCage!, node.latticeSubdiv);
      return;
    }
    get().recompile(newScene, targetId, true);
  },

  multiSelectMode: false,
  setMultiSelectMode: (on) => set((state) => (state.multiSelectMode === on ? {} : { multiSelectMode: on })),
  selectMany: (ids, add) => set((state) => {
    const all = add
      ? [...(state.selectedNodeId ? [state.selectedNodeId] : []), ...state.extraSelectedIds, ...ids]
      : ids;
    const unique = [...new Set(all)];
    if (!unique.length) return add ? {} : { selectedNodeId: null, extraSelectedIds: [] };
    const primary = state.selectedNodeId && unique.includes(state.selectedNodeId) ? state.selectedNodeId : unique[0];
    return { selectedNodeId: primary, extraSelectedIds: unique.filter((id) => id !== primary) };
  }),

  toggleExtraSelected: (id) => set((state) => {
    // The primary is already selected; asking for it again is not a second
    // selection, and letting it into the list would let a body be combined
    // with itself.
    if (!id || id === state.selectedNodeId) return {};
    return state.extraSelectedIds.includes(id)
      ? { extraSelectedIds: state.extraSelectedIds.filter(other => other !== id) }
      : { extraSelectedIds: [...state.extraSelectedIds, id] };
  }),

  setReferenceImages: (images, recordUndo = true) => {
    if (recordUndo) get().prepareForDiscreteChange();
    set({ sceneGraph: { ...get().sceneGraph, referenceImages: images.length ? images : undefined } });
  },

  setSimFidelity: (fidelity) => {
    if ((get().sceneGraph.simFidelity ?? 'standard') === fidelity) return;
    get().prepareForDiscreteChange();
    const newScene: SceneGraph = { ...get().sceneGraph, simFidelity: fidelity === 'standard' ? undefined : fidelity };
    set({ sceneGraph: newScene });
    get().recompile(newScene, undefined, false);
  },

  gestureStatus: null,
  setGestureStatus: (status) => set((state) => (state.gestureStatus === status ? {} : { gestureStatus: status })),

  measureMode: null,

  setMeasureMode: (mode) => set((state) => (state.measureMode === mode ? {} : { measureMode: mode })),
  gizmoMode: 'translate',
  setGizmoMode: (mode) => set((state) => (state.gizmoMode === mode ? {} : { gizmoMode: mode })),
  cycleGizmoMode: () => set((state) => ({ gizmoMode: state.gizmoMode === 'translate' ? 'rotate' : 'translate' })),

  activeGeomIndex: 0,
  setActiveGeomIndex: (index) => set({ activeGeomIndex: index }),

  setDraggedNodeId: (id) => {
    if (id !== null && get().draggedNodeId === null) {
      get().recordInteraction('drag-node');
    }
    set({ draggedNodeId: id });
    getPhysicsWorkerClient().setDrag(id, get().dragTarget);
  },
  setDragTarget: (target) => {
    set({ dragTarget: target });
    getPhysicsWorkerClient().setDrag(get().draggedNodeId, target);
  },
  setDragDistance: (distance) => set({ dragDistance: distance }),

  updateScene: (newScene, skipRecompile) => {
    get().prepareForDiscreteChange();
    set({ sceneGraph: newScene });
    if (!skipRecompile) {
      get().recompile(newScene);
    }
  },
  
  renameNode: (id, newName) => {
    get().prepareForDiscreteChange();
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]) => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id) {
          node.name = newName;
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    set({ sceneGraph: newScene });
    get().recompile(newScene);
  },
  
  updateNodePos: (id, newPos) => {
    get().recordInteraction('node-pos');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]) => {
      if (!nodes) return false; for (const node of nodes) {
        if (node.id === id) {
          if (isAllMeshNode(node)) {
            // Mesh vertices are baked in world space — translate them directly
            const [ox, oy, oz] = node.pos as number[];
            const dx = newPos[0] - ox, dy = newPos[1] - oy, dz = newPos[2] - oz;
            translateMeshGeoms(node, dx, dy, dz);
            for (const g of node.geoms) {
              if (g.baseVertices) {
                g.baseVertices = mapVerts([...g.baseVertices], (x, y, z) => [x + dx, y + dy, z + dz]);
              }
            }
          }
          node.pos = newPos;
          node.basePos = [...newPos];
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    set({ sceneGraph: newScene });
    get().recompile(newScene, undefined, false);
  },

  updateNodeRotation: (id, axis, deg, rotateAroundCOMOverride) => {
    get().recordInteraction('node-rotation');
    const rotateAroundCOM = rotateAroundCOMOverride ?? get().rotateAroundCOM ?? true;
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]) => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id) {
          const currentEuler = node.euler ? [...node.euler] : [0, 0, 0];
          currentEuler[axis] = deg;
          node.euler = currentEuler as [number, number, number];
          delete node.quat;

          const stickyEuler = currentEuler.map(a => getStickyRotation(a)) as [number, number, number];

          if (isAllMeshNode(node)) {
            rotateMeshGeomsAbsolute(node, stickyEuler, rotateAroundCOM);
          } else {
            if (!node.basePos && node.pos) {
              node.basePos = [...node.pos];
            }
            if (!rotateAroundCOM && node.basePos) {
              const radX = (stickyEuler[0] * Math.PI) / 180;
              const radY = (stickyEuler[1] * Math.PI) / 180;
              const radZ = (stickyEuler[2] * Math.PI) / 180;
              const matX = new THREE.Matrix4().makeRotationX(radX);
              const matY = new THREE.Matrix4().makeRotationY(radY);
              const matZ = new THREE.Matrix4().makeRotationZ(radZ);
              const rotMat = new THREE.Matrix4().multiplyMatrices(matZ, new THREE.Matrix4().multiplyMatrices(matY, matX));
              const v = new THREE.Vector3(node.basePos[0], node.basePos[1], node.basePos[2]).applyMatrix4(rotMat);
              node.pos = [v.x, v.y, v.z];
            } else if (rotateAroundCOM && node.basePos) {
              node.pos = [...node.basePos];
            }
          }
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    if (traverse(newScene.nodes)) {
      set({ sceneGraph: newScene });
      // Settled: a gizmo rotate commits all three axes in a row, and each one
      // would otherwise be a rebuild of its own.
      get().recompile(newScene, undefined, true, undefined, true);
    }
  },

  updateNodeGeom: (id, updates, geomIndex) => {
    get().recordInteraction('node-geom');
    /*
     * Whether this edit changes the shape, or only how it behaves on contact.
     *
     * `recompile`'s third argument does two things: it skips the 50ms debounce,
     * and it rebuilds without carrying the simulation state over. Both are right
     * for a change of geometry — the old state may not even be valid against the
     * new model. Both are wrong for a material property: dragging the contact
     * stiffness slider rebuilt MuJoCo on every pixel of travel and threw the
     * world back to its start each time, which is what made those sliders feel
     * like they were fighting the mouse.
     */
    const STRUCTURAL = ['size', 'vertices', 'faces', 'renderVertices', 'type', 'pos', 'euler', 'quat', 'csg'] as const;
    const structural = STRUCTURAL.some(k => (updates as Record<string, unknown>)[k] !== undefined);
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]) => {
      if (!nodes) return false; for (const node of nodes) {
        if (node.id === id && node.geoms?.length > 0) {
          if (id.includes('gear')) {
            const centerGeom = node.geoms[0];
            const currentRadius = centerGeom.size[0];
            const currentTeeth = node.geoms.length - 1;
            const currentColor = centerGeom.rgba || [0.5, 0.5, 0.5, 1];
            const currentContype = centerGeom.contype !== undefined ? centerGeom.contype : 0;
            const currentConaffinity = centerGeom.conaffinity !== undefined ? centerGeom.conaffinity : 0;
            
            let newRadius = currentRadius;
            if (updates.size && Array.isArray(updates.size)) {
              newRadius = updates.size[0];
            }
            
            let newColor = currentColor;
            if (updates.rgba) {
              newColor = updates.rgba;
            }

            let newContype = currentContype;
            if (updates.contype !== undefined) {
              newContype = updates.contype;
            }

            let newConaffinity = currentConaffinity;
            if (updates.conaffinity !== undefined) {
              newConaffinity = updates.conaffinity;
            }
            
            const gearNum = parseInt(id.replace(/\D/g, '')) || 1;
            const isSecondGear = gearNum % 2 === 0;
            
            node.geoms = generateGearGeoms(id, newRadius, currentTeeth, newColor, isSecondGear, newContype, newConaffinity);
          } else {
            let targetGeom = node.geoms[0];
            if (geomIndex !== undefined && geomIndex >= 0 && geomIndex < node.geoms.length) {
              targetGeom = node.geoms[geomIndex];
            } else {
              const mainGeom = node.geoms.find((g: SceneGeom) => g.type === 'sphere' || g.type === 'box' || g.type === 'cylinder');
              if (mainGeom) {
                targetGeom = mainGeom;
              }
            }
            if (updates.fromto && targetGeom.fromto) {
              const oldFromto = targetGeom.fromto;
              const newFromto = updates.fromto;
              const oldLen = Math.sqrt((oldFromto[3]-oldFromto[0])**2 + (oldFromto[4]-oldFromto[1])**2 + (oldFromto[5]-oldFromto[2])**2) || 1.0;
              const newLen = Math.sqrt((newFromto[3]-newFromto[0])**2 + (newFromto[4]-newFromto[1])**2 + (newFromto[5]-newFromto[2])**2) || 1.0;
              const ratio = newLen / oldLen;
              if (node.children) {
                node.children.forEach((child: SceneNode) => {
                  child.pos = [child.pos[0] * ratio, child.pos[1] * ratio, child.pos[2] * ratio];
                });
              }
            }
            const boundsBefore = structural && node.edgeRounds ? sourcePositiveBounds(node) : null;
            Object.assign(targetGeom, updates);
            if (updates.vertices || updates.faces || updates.renderVertices) dropStaleColliders(node);
            // Rounded edges are stored as points, so they move with the shape.
            if (boundsBefore) reconcileEdgeRounds(node, boundsBefore, sourcePositiveBounds(node));
            /*
              A cut is stated as a face and a depth, so resizing or moving the
              shape it cuts into has to move the cut with it — a hole 10 mm into
              the top of a block is still 10 mm into the top when the block gets
              taller. Only geoms carrying that intent are touched; a negative
              placed by hand keeps its own numbers. See reconcileCuts.
            */
            if (structural) reconcileCuts(node);
          }
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    set({ sceneGraph: newScene });
    get().recompile(newScene, undefined, structural, undefined, structural);
  },

  // `jointIndex` defaults to 0, which is what every caller meant before it
  // existed — the inspector only ever shows one joint. A body with several (a
  // gimbal, say) needs to be able to say which.
  updateNodeJoint: (id, updates, jointIndex = 0) => {
    get().recordInteraction('node-joint');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]) => {
      if (!nodes) return false; for (const node of nodes) {
        if (node.id === id && node.joints?.length > 0) {
          const target = node.joints[jointIndex] ?? node.joints[0];
          Object.assign(target, updates);
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    set({ sceneGraph: newScene });
    get().recompile();
  },

  updateNodeScript: (id, script) => {
    get().recordInteraction('node-script');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]) => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id) {
          node.script = script;
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    set({ sceneGraph: newScene });
    // Note: Live updates do not force model recompiles to support hot-editing of
    // control gains! The worker keeps its own copy of the scene for script
    // execution, so it needs telling directly rather than via a recompile.
    getPhysicsWorkerClient().updateScript(id, script);
  },

  updateNodeScad: (id, scad, compiledData, skipRecompile) => {
    get().recordInteraction('node-scad');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]) => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id || node.name === id) {
          node.scad = scad;
          if (!node.geoms) {
            node.geoms = [];
          }
          let meshGeom = node.geoms.find((g: SceneGeom) => g.type === 'mesh');
          if (!meshGeom && node.geoms.length > 0) {
            meshGeom = node.geoms[0];
          }
          const nodeRgba = (node as { rgba?: number[] }).rgba;
          // number[], as SceneGeom.rgba is: a tuple here made the `as SceneGeom`
          // below an assertion between unrelated types (TS2352).
          const fallbackRgba: number[] =
            Array.isArray(nodeRgba) && nodeRgba.length >= 3
              ? [nodeRgba[0], nodeRgba[1], nodeRgba[2], nodeRgba[3] ?? 1]
              : [0.3, 0.6, 0.9, 1];
          if (!meshGeom) {
            // No `size`: a mesh geom's is unused, the vertices are written a
            // few lines below, and putting a number here would put one in the
            // scene that has never been there.
            meshGeom = {
              id: `geom_${Math.random().toString(36).substring(2, 8)}`,
              name: `${node.name || id}_mesh`,
              type: 'mesh',
              dynamic: true,
              rgba: fallbackRgba,
              mass: 1
            } as SceneGeom;
            node.geoms.push(meshGeom);
          } else if (Array.isArray(nodeRgba) && nodeRgba.length >= 3 && !meshGeom.rgba) {
            meshGeom.rgba = fallbackRgba;
          }
          meshGeom.type = 'mesh';
          meshGeom.dynamic = true;
          meshGeom.vertices = compiledData.vertices;
          meshGeom.faces = compiledData.faces;
          meshGeom.renderVertices = compiledData.renderVertices;
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    if (traverse(newScene.nodes)) {
      set({ sceneGraph: newScene });
      // Bulk callers (e.g. compiling several scad bodies in sequence) pass
      // skipRecompile: firing a recompile per node here creates overlapping,
      // unawaited MJCF/WASM builds that race - a stale one (compiled before a
      // later node's mesh existed) can finish last and silently overwrite the
      // correct final state. Bulk callers run a single recompile after all
      // nodes are updated instead.
      if (!skipRecompile) {
        get().recompile(newScene, id, true);
      }
    }
  },

  // --- CSG (boolean modifiers) ---------------------------------------------
  // A negative geom is an ordinary primitive with csg:'difference' — it's the
  // node's csgEnabled flag plus that marker that turn the body into a boolean.
  // Shapes get onto a body the ordinary ways (drag-in, presets, MCP); flipping
  // one to 'difference' is what makes it a hole.
  deleteNodeGeom: (nodeId, geomIndex) => {
    get().prepareForDiscreteChange();
    const newScene = cloneSceneGraph(get().sceneGraph);
    const node = findNode(newScene.nodes, nodeId);
    if (!node || !node.geoms || geomIndex < 0 || geomIndex >= node.geoms.length) return;
    // A piece of a hardware feature goes with the rest of it: half a nut trap
    // is a hole nobody asked for.
    const group = node.geoms[geomIndex].hardware?.group;
    node.geoms = node.geoms.filter((g: SceneGeom, i: number) => i !== geomIndex && !(group && g.hardware?.group === group));
    // Losing the last boolean operator leaves an ordinary compound body; drop
    // the derived mesh with it so the primitives come back into view.
    if (node.csgEnabled && !hasBooleanOps(node)) {
      node.geoms = node.geoms.filter((g: SceneGeom) => !g.csgDerived);
      node.csgEnabled = false;
      delete node.csgHash;
    }
    set({ sceneGraph: newScene });
    rebuildAfterGeomEdit(get, newScene, nodeId);
  },

  insetNodeGeoms: (nodeId, factor, pocket) => {
    const target = findNode(get().sceneGraph.nodes, nodeId);
    if (!target || insetNegatives(target, factor, pocket).length === 0) return;
    get().prepareForDiscreteChange();
    const newScene = cloneSceneGraph(get().sceneGraph);
    const node = findNode(newScene.nodes, nodeId);
    if (!node) return;
    const copies = insetNegatives(node, factor, pocket);
    if (copies.length === 0) return;

    node.geoms = [...node.geoms, ...copies];
    node.csgEnabled = true;
    if (node.csgCollision === undefined) node.csgCollision = 'auto';
    if (node.csgSectors === undefined) node.csgSectors = CSG_DEFAULT_SECTORS;

    set({ sceneGraph: newScene });
    rebuildAfterGeomEdit(get, newScene, nodeId);
  },

  setGeomCsgOp: (nodeId, geomIndex, csg) => {
    get().recordInteraction('geom-csg-op');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const node = findNode(newScene.nodes, nodeId);
    if (!node?.geoms?.[geomIndex]) return;
    // There has to be something left to cut into. Subtracting a body's only
    // shape would leave it with no positive geometry at all: nothing to render,
    // nothing to collide, and a MuJoCo body with no geoms. Refuse instead.
    if (csg !== 'union') {
      const positivesLeft = node.geoms.filter((g: SceneGeom, i: number) =>
        !g.csgDerived && i !== geomIndex && (!g.csg || g.csg === 'union')).length;
      if (positivesLeft === 0) return;
    }
    node.geoms[geomIndex].csg = csg;
    const hasOps = node.geoms.some((g: SceneGeom) => !g.csgDerived && (g.csg === 'difference' || g.csg === 'intersection')) ||
      hasEdgeRounds(node);
    node.csgEnabled = hasOps;
    if (hasOps) {
      if (node.csgCollision === undefined) node.csgCollision = 'auto';
      if (node.csgSectors === undefined) node.csgSectors = CSG_DEFAULT_SECTORS;
    } else {
      // Back to an ordinary compound body — the stale boolean mesh would
      // otherwise keep drawing over the primitives.
      node.geoms = node.geoms.filter((g: SceneGeom) => !g.csgDerived);
      delete node.csgHash;
    }
    set({ sceneGraph: newScene });
    rebuildAfterGeomEdit(get, newScene, nodeId);
  },

  // Installs the output of evaluateNodeCsg: derived geoms replace the previous
  // ones wholesale, source primitives are untouched.
  applyNodeCsg: (nodeId, result, skipRecompile) => {
    // A result is for the shape the body had when its compile STARTED. If the
    // body has changed since — undone, rounded differently, no longer a
    // boolean at all — installing it would put back a shape that is not there
    // (an undone rounding coming straight back). The auto-compiler builds the
    // current one.
    const current = findNode(get().sceneGraph.nodes, nodeId);
    if (!current || !current.csgEnabled || csgHashOf(current) !== result.hash) return;
    const newScene = cloneSceneGraph(get().sceneGraph);
    const node = findNode(newScene.nodes, nodeId);
    if (!node) return;
    const source = (node.geoms || []).filter((g: SceneGeom) => !g.csgDerived);
    // Patterns and seams on the compiled surface are authored on a derived
    // geom, so they are carried over to the one that replaces it -- by name,
    // or from the only visual mesh to the only visual mesh. Their seeds find
    // the face again on the new surface, or say it has gone.
    const oldVisual = (node.geoms || []).filter((g: SceneGeom) => g.csgDerived === 'visual' && (g.textures?.length || g.faceSplits?.length));
    const newVisual = result.geoms.filter((g: SceneGeom) => g.csgDerived === 'visual');
    const oldCentroid = node.csgCentroid ?? [0, 0, 0];
    const newCentroid = result.centroid ?? [0, 0, 0];
    const transformMarks = (
      textures: SceneGeom['textures'],
      faceSplits: SceneGeom['faceSplits'],
      mat: THREE.Matrix4 | null,
      shift: [number, number, number],
    ): { textures?: SceneGeom['textures']; faceSplits?: SceneGeom['faceSplits'] } => {
      const pt = (p: [number, number, number]): [number, number, number] => {
        const v = new THREE.Vector3(p[0], p[1], p[2]);
        if (mat) v.applyMatrix4(mat);
        return [v.x + shift[0], v.y + shift[1], v.z + shift[2]];
      };
      const dir = (n: [number, number, number]): [number, number, number] => {
        if (!mat) return n;
        const v = new THREE.Vector3(n[0], n[1], n[2]).transformDirection(mat);
        return [v.x, v.y, v.z];
      };
      return {
        textures: textures?.map((t) => ({
          ...t,
          seedAt: pt(t.seedAt as [number, number, number]),
          seedNormal: t.seedNormal ? dir(t.seedNormal as [number, number, number]) : t.seedNormal,
        })),
        faceSplits: faceSplits?.map((s) => ({
          ...s,
          at: pt(s.at as [number, number, number]),
          normal: dir(s.normal as [number, number, number]),
          seeds: s.seeds.map((p) => pt(p as [number, number, number])),
        })),
      };
    };
    const geoms = result.geoms.map((g: SceneGeom) => {
      if (g.csgDerived !== 'visual') return g;
      if (oldVisual.length > 0) {
        const from = oldVisual.find((o: SceneGeom) => o.name === g.name)
          ?? (oldVisual.length === 1 && newVisual.length === 1 ? oldVisual[0] : undefined);
        if (!from) return g;
        const shift: [number, number, number] = [oldCentroid[0] - newCentroid[0], oldCentroid[1] - newCentroid[1], 0];
        return { ...g, ...transformMarks(from.textures, from.faceSplits, null, shift) };
      }
      if (newVisual.length !== 1) return g;
      const markedSources = source.filter(
        (s: SceneGeom) => s.csg !== 'difference' && s.role !== 'visual' && (s.textures?.length || s.faceSplits?.length),
      );
      if (markedSources.length === 0) return g;
      const shift: [number, number, number] = [-newCentroid[0], -newCentroid[1], 0];
      const carriedTextures: NonNullable<SceneGeom['textures']> = [];
      const carriedSplits: NonNullable<SceneGeom['faceSplits']> = [];
      for (const s of markedSources) {
        const m = transformMarks(s.textures, s.faceSplits, getGeomFrame(s).matrix, shift);
        if (m.textures?.length) carriedTextures.push(...m.textures);
        if (m.faceSplits?.length) carriedSplits.push(...m.faceSplits);
      }
      return {
        ...g,
        ...(carriedTextures.length ? { textures: carriedTextures } : {}),
        ...(carriedSplits.length ? { faceSplits: carriedSplits } : {}),
      };
    });
    node.geoms = [...source, ...geoms];
    node.csgHash = result.hash;
    // Summarized, not stored whole: a lattice mesh operand is megabytes of
    // polyhedron literal, and this field is shown, undone and saved.
    node.csgScad = scadForDisplay(result.scad);
    node.csgVolume = result.volume;
    node.csgHullVolume = result.hullVolume;
    node.csgCentroid = result.centroid;
    // The frame the parts seated in it are placed in has moved with the centroid.
    if (oldCentroid.some((v, a) => Math.abs(v - (newCentroid[a] ?? 0)) > 1e-9)) reseatHardware(node);
    node.csgCollision = node.csgCollision ?? 'auto';
    if (result.warning) node.csgWarning = result.warning; else delete node.csgWarning;
    delete node.csgError;
    set({ sceneGraph: newScene });
    // Bulk callers recompile once at the end — see the same note on updateNodeScad.
    if (!skipRecompile) get().recompile(newScene, undefined, false);
  },

  applyNodeColliders: (nodeId, result, skipRecompile) => {
    // A decomposition of a mesh that has since changed — two strokes, the
    // first one's result landing after the second — would install pieces of
    // the wrong shape. The auto-compiler has already queued the right one.
    const current = findNode(get().sceneGraph.nodes, nodeId);
    if (!current || collisionHashOf(current) !== result.hash) return;
    // Nor onto a body that has become a boolean while this ran (rounded, or
    // cut): its colliders come from its boolean, and these would sit on top.
    if (current.csgEnabled) return;
    const newScene = cloneSceneGraph(get().sceneGraph);
    const node = findNode(newScene.nodes, nodeId);
    if (!node) return;
    // Filters 'collider', NOT every derived geom: a boolean body's visual mesh
    // is derived too, and destroying it would leave the body invisible.
    const kept = (node.geoms || []).filter((g: SceneGeom) => g.csgDerived !== 'collider');
    node.geoms = [...kept, ...result.geoms];
    node.collisionHash = result.hash;
    if (result.geoms.length > 0) node.collisionDecomposed = true; else delete node.collisionDecomposed;
    node.collisionSolidity = +result.verdict.solidity.toFixed(4);
    if (result.cavities?.length) node.collisionCavities = result.cavities; else delete node.collisionCavities;
    if (result.warning) node.collisionWarning = result.warning; else delete node.collisionWarning;
    delete node.collisionError;
    set({ sceneGraph: newScene });
    if (!skipRecompile) get().recompile(newScene, undefined, false);
  },

  setNodeCollisionError: (nodeId, error, hash) => {
    const newScene = cloneSceneGraph(get().sceneGraph);
    const node = findNode(newScene.nodes, nodeId);
    if (!node) return;
    if (error) node.collisionError = error; else delete node.collisionError;
    // Record the hash that failed, so a mesh that cannot be decomposed is not
    // retried on every store update — only a real edit re-arms it.
    if (error && hash) node.collisionHash = hash;
    // And stop colliding as the shape before the edit that could not be
    // decomposed: stamping the hash alone left those pieces in place for good.
    // The body collides as its hull instead, which at least contains it.
    const hadColliders = error ? dropStaleColliders(node) : false;
    set({ sceneGraph: newScene });
    if (hadColliders) get().recompile(newScene, undefined, false);
  },

  setNodeCsgError: (nodeId, error, hash) => {
    const newScene = cloneSceneGraph(get().sceneGraph);
    const node = findNode(newScene.nodes, nodeId);
    if (!node) return;
    if (error) node.csgError = error; else delete node.csgError;
    // Record the hash that failed so the auto-compiler doesn't retry the same
    // broken shape on every store update — only a real edit re-arms it.
    if (error && hash) node.csgHash = hash;
    set({ sceneGraph: newScene });
  },

  updateNode: (id, updates) => {
    get().recordInteraction('node');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]): boolean => {
      for (const node of nodes) {
        if (node.id === id) {
          const wasJointless = !(node.joints?.length > 0);
          Object.assign(node, updates);
          // Body-level rgba is a shorthand for colouring the body's geoms:
          // SceneNode has no colour of its own in MJCF or the renderer, so
          // storing it on the node alone left SCAD and primitive bodies lilac.
          const rawRgba = (updates as { rgba?: number[] }).rgba;
          if (updates.geoms === undefined && Array.isArray(rawRgba) && rawRgba.length >= 3 && node.geoms?.length) {
            for (const geom of node.geoms) {
              if (geom.csg === 'difference') continue;
              geom.rgba = [rawRgba[0] ?? 0.8, rawRgba[1] ?? 0.8, rawRgba[2] ?? 0.8, rawRgba[3] ?? geom.rgba?.[3] ?? 1];
            }
          }
          // Same trap as updateNodeJointsList: an update that hands this node
          // its first joint (e.g. an MCP physics_update_object call, not just
          // the properties panel) needs its mesh geoms promoted too, or the
          // body simulates and drags correctly while its render stays frozen.
          if (updates.joints !== undefined && node.joints?.length > 0) {
            promoteMeshGeomsToDynamic(node);
            if (wasJointless) restoreCollisionWhenMadeMovable(node);
          }
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    if (traverse(newScene.nodes)) {
      set({ sceneGraph: newScene });
      // Recompile so aerodynamics flag propagates to physics loop
      get().recompile(newScene, undefined, false);
    }
  },

  /*
   * "free joint can only be used on top level" is MuJoCo refusing the whole
   * model, not a warning — so before this existed, setting a nested body to
   * 6-DOF left the last good model running while the document said something
   * else, and the body simply stopped responding.
   *
   * The body keeps the pose it appears to have. Where the sim is live that is
   * MuJoCo's own xpos/xmat, which is where the user can see it; otherwise the
   * authored chain is composed down from the root, which is where the document
   * says it is. Its own children come with it and need no adjustment, since
   * they are positioned relative to this body either way.
   */
  detachToTopLevel: (id) => {
    const scene = cloneSceneGraph(get().sceneGraph);

    let parent: SceneNode | null = null;
    let node: SceneNode | null = null;
    const find = (nodes: SceneNode[], above: SceneNode | null): boolean => {
      for (const n of nodes) {
        if (n.id === id) { node = n; parent = above; return true; }
        if (find(n.children || [], n)) return true;
      }
      return false;
    };
    find(scene.nodes, null);
    if (!node || !parent) return false;   // missing, or already top level
    const found: SceneNode = node;
    const from: SceneNode = parent;

    // Where it is now, in world terms.
    const world = new THREE.Matrix4();
    const model = get().model as ModelMirror | null;
    const data = get().data as DataMirror | null;
    const bodyId = MUJOCO_SHIM.mj_name2id(model, 'body', id);
    if (model && data && bodyId >= 0) {
      const o = bodyId * 3, m = bodyId * 9;
      // xmat is row-major body-to-world.
      world.set(
        data.xmat[m], data.xmat[m + 1], data.xmat[m + 2], data.xpos[o],
        data.xmat[m + 3], data.xmat[m + 4], data.xmat[m + 5], data.xpos[o + 1],
        data.xmat[m + 6], data.xmat[m + 7], data.xmat[m + 8], data.xpos[o + 2],
        0, 0, 0, 1,
      );
    } else {
      // No live model: compose the authored chain instead.
      const chain: SceneNode[] = [];
      const walk = (nodes: SceneNode[], trail: SceneNode[]): boolean => {
        for (const n of nodes) {
          const next = [...trail, n];
          if (n.id === id) { chain.push(...next); return true; }
          if (walk(n.children || [], next)) return true;
        }
        return false;
      };
      walk(scene.nodes, []);
      for (const link of chain) world.multiply(localMatrixOf(link));
    }

    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    world.decompose(pos, quat, new THREE.Vector3());

    from.children = (from.children || []).filter((c) => c.id !== id);
    found.pos = [pos.x, pos.y, pos.z];
    found.basePos = [pos.x, pos.y, pos.z];
    // mjcf.ts writes no eulerseq, so MuJoCo reads euler as its default
    // intrinsic xyz — Three's 'XYZ'. Degrees, as everything authored here is.
    const e = new THREE.Euler().setFromQuaternion(quat, 'XYZ');
    const deg = (r: number) => (r * 180) / Math.PI;
    found.euler = [deg(e.x), deg(e.y), deg(e.z)];
    delete found.quat;
    scene.nodes = [...scene.nodes, found];

    set({ sceneGraph: scene });
    get().recompile(scene, id, false, true);
    return true;
  },

  updateNodeJointsList: (id, joints) => {
    get().recordInteraction('node-joints-list');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: SceneNode[]): boolean => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id) {
          const wasJointless = !(node.joints?.length > 0);
          node.joints = joints;
          if (joints.length > 0) {
            promoteMeshGeomsToDynamic(node);
            if (wasJointless) restoreCollisionWhenMadeMovable(node);
          }
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    if (traverse(newScene.nodes)) {
      get().recompile(newScene, id);
    }
  },

  deleteNode: (id) => get().deleteNodes([id]),

  // Shift-click builds a selection of several bodies, and Delete used to take
  // only the primary one, leaving the rest highlighted and still listed in the
  // Combine card.
  deleteNodes: (ids) => {
    const doomed = new Set(ids);
    if (doomed.size === 0) return;
    get().prepareForDiscreteChange();
    const newScene = cloneSceneGraph(get().sceneGraph);
    // A screw taken out lets go of what it held.
    releaseFastenings(newScene, doomed);
    let removed = false;
    const traverseAndRemove = (nodes: SceneNode[]) => {
      if (!nodes) return;
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (doomed.has(nodes[i].id)) {
          nodes.splice(i, 1);
          removed = true;
        } else {
          traverseAndRemove(nodes[i].children);
        }
      }
    };
    traverseAndRemove(newScene.nodes);
    if (removed) {
      // Nothing may go on naming what is gone — a bracket's weld to a deleted
      // profile, a pen head welded to a deleted rail's carriage — or the
      // whole scene stops compiling.
      const gone: string[] = [];
      const collect = (nodes: SceneNode[]) => {
        for (const n of nodes) { if (doomed.has(n.id)) { const all = (m: SceneNode) => { gone.push(m.id); (m.children || []).forEach(all); }; all(n); } else collect(n.children || []); }
      };
      collect(get().sceneGraph.nodes);
      for (const id of gone) newScene.nodes = detachReferencesTo(newScene.nodes, id);
      set({ sceneGraph: newScene, selectedNodeId: null, extraSelectedIds: [] });
      get().recompile(newScene, null);
    }
  },

  addComponent: (type, position, parentId, opts) => {
    get().prepareForDiscreteChange();
    const { sceneGraph } = get();
    const newScene = cloneSceneGraph(sceneGraph);
    
    // 8-character random unique suffix (no millisecond timestamp)
    const id = `${type}_${Math.random().toString(36).substring(2, 10)}`;
    
    // Determine target local position
    let localPos: [number, number, number] = [position[0], position[1], position[2]];
    
    const isChild = !!parentId && !!findNodeById(newScene.nodes, parentId);
    
    if (isChild && parentId) {
      // Find parent world position to make drop coordinates relative to parent!
      const parentWorldPos = getNodeWorldPos(newScene.nodes, parentId);
      if (parentWorldPos) {
        localPos = [
          position[0] - parentWorldPos[0],
          position[1] - parentWorldPos[1],
          position[2] - parentWorldPos[2]
        ];
      }
    }

    let geomType: GeomType = type as GeomType;
    let size: number[] = [0.2];
    let rgba = [0.5, 0.5, 0.5, 1];
    let mass = 1;
    let joints: SceneJoint[] = [];
    let geoms: SceneGeom[] = [];
    
    const isChildJoint = isChild;
    
    if (type === 'gear') {
      const radius = 0.05;
      const teeth = 12;
      const color = [0.5, 0.5, 0.5, 1];
      geoms = generateGearGeoms(id, radius, teeth, color, false);
      joints = [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 0, 1], damping: 0.5 }];
    } else if (type === 'pulley_wheel') {
      const r = 0.05;
      const thickness = 0.025;
      const spindle_r = r * 0.8;
      const spindle_h = thickness / 2 - 0.005;
      const flange_h = 0.005;
      
      geoms = [
        { name: `${id}_spindle`, type: 'cylinder', size: [spindle_r, spindle_h], pos: [0, 0, 0], euler: [90, 0, 0], rgba: [0.3, 0.4, 0.6, 1], mass: 0.5 },
        { name: `${id}_flange_l`, type: 'cylinder', size: [r, flange_h], pos: [0, -spindle_h - flange_h / 2, 0], euler: [90, 0, 0], rgba: [0.2, 0.3, 0.5, 1], mass: 0.25 },
        { name: `${id}_flange_r`, type: 'cylinder', size: [r, flange_h], pos: [0, spindle_h + flange_h / 2, 0], euler: [90, 0, 0], rgba: [0.2, 0.3, 0.5, 1], mass: 0.25 }
      ];
      joints = [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.2 }];
    } else if (type === 'pulley_rope') {
      geoms = [];
      joints = [];
    } else if (type === 'curve') {
      // Rigid curved track: spline through control points, decomposed into
      // convex box segments so collision follows the real curve.
      geoms = generateCurveGeoms(id, PALETTE_CURVE_POINTS, PALETTE_CURVE_WIDTH, PALETTE_CURVE_THICKNESS, DEFAULT_CURVE_SEGMENTS);
      joints = []; // static — welded to world like the wedge
      localPos = [localPos[0], localPos[1], 0]; // tracks sit on the ground, not in the air
    } else {
      if (type === 'box') {
        geomType = 'box';
        size = [0.05, 0.05, 0.05];
        rgba = [0.8, 0.2, 0.2, 1];
        joints = isChildJoint ? [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.5 }] : [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'sphere') {
        geomType = 'sphere';
        size = [0.05];
        rgba = [0.2, 0.8, 0.2, 1];
        joints = isChildJoint ? [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.5 }] : [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'capsule') {
        geomType = 'capsule';
        size = [0.01, 0.05];
        rgba = [0.6, 0.6, 0.6, 1];
        // Standalone poles are free bodies and fall like any other shape; only
        // when nested under a parent does a hinge (pendulum rod) make sense.
        joints = isChildJoint ? [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.1 }] : [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'cylinder') {
        geomType = 'cylinder';
        size = [0.05, 0.04];
        rgba = [0.9, 0.6, 0.1, 1];
        joints = isChildJoint ? [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.5 }] : [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'bob') {
        geomType = 'sphere';
        size = [0.04];
        rgba = [0.2, 0.6, 1.0, 1];
        mass = 10.0;
        joints = [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.1 }];
      } else if (type === 'wedge') {
        geomType = 'box';
        size = [0.06, 0.03, 0.015];
        rgba = [0.8, 0.5, 0.2, 1];
        // A wedge is a solid object, not a fixture: it falls and can be tipped
        // over like anything else. Set the joint to Fixed to weld it in place.
        joints = isChildJoint ? [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.5 }] : [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'mesh') {
        // Dynamic icosahedron: radius 0.06, centred at body origin.
        // body pos = localPos handles spawn placement.
        // vertices: Y-up centred at (0,0,0) for the Three.js static render path fallback.
        // renderVertices: Z-up centred at (0,0,0) — icosahedron centroid is exactly (0,0,0).
        geoms = [{
          name: `${id}_mesh`,
          type: 'mesh',
          size: [1],
          rgba: [0.5, 0.7, 0.9, 1],
          mass: 1,
          condim: 3,
          dynamic: true,
          vertices: [-0.0315,0.051,0,0.0315,0.051,0,-0.0315,-0.051,0,0.0315,-0.051,0,0,-0.0315,0.051,0,0.0315,0.051,0,-0.0315,-0.051,0,0.0315,-0.051,0.051,0,-0.0315,0.051,0,0.0315,-0.051,0,-0.0315,-0.051,0,0.0315],
          // renderVertices: raw Z-up (Y↔Z swap only: Y-up (x,y,z)→(x,-z,y)), no centroid subtraction
          renderVertices: [-0.0315,0,0.051,0.0315,0,0.051,-0.0315,0,-0.051,0.0315,0,-0.051,0,-0.051,-0.0315,0,-0.051,0.0315,0,0.051,-0.0315,0,0.051,0.0315,0.051,0.0315,0,0.051,-0.0315,0,-0.051,0.0315,0,-0.051,-0.0315,0],
          faces: [0,11,5,0,5,1,0,1,7,0,7,10,0,10,11,1,5,9,5,11,4,11,10,2,10,7,6,7,1,8,3,9,4,3,4,2,3,2,6,3,6,8,3,8,9,4,9,5,2,4,11,6,2,10,8,6,7,9,8,1],
        }];
        joints = [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'openscad') {
        // Default cube shape, will compile into a custom CSG mesh on render/edit
        geoms = [{
          name: `${id}_geom`,
          type: 'mesh',
          size: [1],
          rgba: [0.3, 0.6, 0.9, 1], // beautiful blue
          mass: 1,
          condim: 3,
          dynamic: true,
          vertices: [
            -0.05, -0.05, -0.05,
             0.05, -0.05, -0.05,
             0.05,  0.05, -0.05,
            -0.05,  0.05, -0.05,
            -0.05, -0.05,  0.05,
             0.05, -0.05,  0.05,
             0.05,  0.05,  0.05,
            -0.05,  0.05,  0.05
          ],
          renderVertices: [
            -0.05,  0.05, -0.05,
             0.05,  0.05, -0.05,
             0.05,  0.05,  0.05,
            -0.05,  0.05,  0.05,
            -0.05, -0.05, -0.05,
             0.05, -0.05, -0.05,
             0.05, -0.05,  0.05,
            -0.05, -0.05,  0.05
          ],
          faces: [
            0, 2, 1,  0, 3, 2,
            4, 5, 6,  4, 6, 7,
            0, 1, 5,  0, 5, 4,
            1, 2, 6,  1, 6, 5,
            2, 3, 7,  2, 7, 6,
            3, 0, 4,  3, 4, 7
          ]
        }];
        joints = [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'pyramid') {
        const w = 0.1;
        const d = 0.1;
        const h = 0.1;
        const { vertices, faces, renderVertices } = generatePyramidMeshData(w, d, h);
        geoms = [{
          name: `${id}_mesh`,
          type: 'mesh',
          size: [1],
          rgba: [0.85, 0.35, 0.15, 1], // reddish orange
          mass: 1,
          condim: 3,
          dynamic: true,
          vertices,
          faces,
          renderVertices
        }];
        joints = [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'cone') {
        const r = 0.05;
        const h = 0.1;
        const { vertices, faces, renderVertices } = generateConeMeshData(r, h, 16);
        geoms = [{
          name: `${id}_mesh`,
          type: 'mesh',
          size: [1],
          rgba: [0.15, 0.65, 0.85, 1], // cyan blue
          mass: 1,
          condim: 3,
          dynamic: true,
          vertices,
          faces,
          renderVertices
        }];
        joints = [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'torus') {
        const R = 0.04;
        const r = 0.012;
        const { vertices, faces, renderVertices } = generateTorusMeshData(R, r, 24, 16);
        geoms = [{
          name: `${id}_mesh`,
          type: 'mesh',
          size: [1],
          rgba: [0.55, 0.35, 0.85, 1], // purple
          mass: 1,
          condim: 3,
          dynamic: true,
          vertices,
          faces,
          renderVertices
        }];
        joints = [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'tube') {
        const r1 = 0.03;
        const r2 = 0.05;
        const h = 0.08;
        const { vertices, faces, renderVertices } = generateTubeMeshData(r1, r2, h, 24);
        geoms = [{
          name: `${id}_mesh`,
          type: 'mesh',
          size: [1],
          rgba: [0.35, 0.75, 0.35, 1], // green
          mass: 1,
          condim: 3,
          dynamic: true,
          vertices,
          faces,
          renderVertices
        }];
        joints = [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'ellipsoid') {
        geomType = 'ellipsoid';
        size = [0.06, 0.04, 0.03];
        rgba = [0.85, 0.55, 0.15, 1]; // yellow/orange
        joints = isChildJoint ? [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.5 }] : [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'sculpt') {
        // A ball of clay: a subdivided icosahedron, uniform enough all over
        // that the first stroke lands the same wherever it is put. Detail is
        // added by the brush as it goes (see utils/sculptMesh.ts), so the base
        // is deliberately coarse — starting dense would only make every stroke
        // slower without making any of them finer.
        const { vertices, renderVertices, faces } = toSceneGeom(buildSculptBaseSized(DEFAULT_SCULPT_BASE, DEFAULT_SCULPT_SIZE));
        geoms = [{
          name: `${id}_mesh`,
          type: 'mesh',
          size: [1],
          rgba: [0.82, 0.72, 0.62, 1], // unfired clay
          mass: 1,
          condim: 3,
          dynamic: true,
          vertices,
          faces,
          renderVertices,
        }];
        joints = [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'lattice') {
        // An empty grid: the first thing drawn is the user's own, and the
        // panel's Add cube puts back the box this used to start as. See
        // utils/latticeMesh.ts.
        const cage = serializeCage(createLattice(LATTICE_UNIT));
        const { vertices, renderVertices, faces } = latticeToSceneGeom(deserializeCage(cage), 0);
        // Centred on the origin already, so the offset it starts with is zero —
        // but it is written down rather than assumed, because applyLattice
        // applies the CHANGE in offset and needs somewhere to start from.
        geoms = [{
          name: `${id}_mesh`,
          type: 'mesh',
          size: [1],
          rgba: [0.55, 0.68, 0.85, 1], // drafting blue, to read as constructed
          mass: 1,
          condim: 3,
          dynamic: true,
          vertices,
          faces,
          renderVertices,
          // The cage's own geom, named as such from the start — a body that
          // later carries a cut has more than one mesh on it. See applyLattice.
          latticeGeom: true,
        }];
        joints = [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'ring') {
        // The canonical boolean: a flattened ellipsoid with a slimmer ellipsoid
        // punched through it along Z. The negative is only a little taller than
        // the disc: it has to pierce right through (a flush cut leaves coincident
        // faces), but overshooting by multiples just makes a big outline in the
        // editor for no benefit. Nothing here is special-cased downstream —
        // it's just two ordinary primitives and a csg marker, so every slider in
        // the panel reshapes it and the mesh is regenerated from scratch.
        geoms = [
          { name: `${id}_body`, type: 'ellipsoid', size: [0.06, 0.06, 0.02], mass: 1, rgba: [0.85, 0.65, 0.2, 1], condim: 3 },
          { name: `${id}_hole`, type: 'ellipsoid', size: [0.03, 0.03, 0.035], csg: 'difference', pos: [0, 0, 0], rgba: [0.9, 0.25, 0.35, 1] },
        ];
        joints = [{ name: `${id}_free`, type: 'free' }];
      }
      if (type !== 'mesh' && type !== 'openscad' && type !== 'pyramid' && type !== 'cone' && type !== 'torus' && type !== 'tube' && type !== 'ring' && type !== 'sculpt' && type !== 'lattice') {
        geoms = [{ name: `${id}_geom`, type: geomType, size, mass, rgba }];
      }
      if (type === 'blob') {
        // A joint: a 12 mm ball of putty, weighing what putty weighs. Whatever
        // reaches into it is welded to it. See utils/joinMaterials.ts.
        const putty = joinMaterial(DEFAULT_JOIN_MATERIAL)!;
        geoms = [{ name: `${id}_geom`, type: 'ellipsoid', size: [0.006, 0.006, 0.006], rgba: [...putty.rgba], density: putty.density }];
        joints = [{ name: `${id}_free`, type: 'free' }];
      }
    }

    // MuJoCo allows a free joint only on a top-level body, and most branches
    // above give one unconditionally. Nested, the part gets the same hinge the
    // primitives get as children.
    if (isChild) {
      joints = joints.map((j): SceneJoint => j.type === 'free'
        ? { name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.5 }
        : j);
    }

    const newNode: SceneNode = {
      id, name: id, type: 'body', pos: localPos,
      joints,
      geoms,
      children: [],
      ...(type === 'blob' ? { joinMaterial: DEFAULT_JOIN_MATERIAL } : {}),
      ...(type === 'wedge' ? {
        isWedge: true,
        width: 0.12,
        depth: 0.06,
        height: 0.03,
        wedgeAngle: 14.036
      } : {}),
      ...(type === 'pyramid' ? {
        isPyramid: true,
        // These must match the mesh built above. They are what the properties
        // panel shows and what a slider regenerates from, so a disagreement
        // makes the shape jump the first time one is touched — and a shape that
        // grows while its body stays put ends up inside the floor, which MuJoCo
        // resolves by ejecting it through.
        width: 0.1,
        depth: 0.1,
        height: 0.1
      } : {}),
      ...(type === 'cone' ? {
        isCone: true,
        radius: 0.05,
        height: 0.1
      } : {}),
      ...(type === 'torus' ? {
        isTorus: true,
        majorRadius: 0.04,
        tubeRadius: 0.012
      } : {}),
      ...(type === 'tube' ? {
        isTube: true,
        innerRadius: 0.03,
        outerRadius: 0.05,
        height: 0.08
      } : {}),
      ...(type === 'pulley_wheel' ? {
        isPulleyWheel: true,
        // Must match the flange geoms above (r = 0.05). It was 0.4, so a
        // dragged-in wheel drew its rope on a 0.4m rim around an 0.08m wheel
        // and coupled the rope kinematics to the wrong radius.
        pulleyRadius: 0.05
      } : {}),
      ...(type === 'pulley_rope' ? {
        isPulleyRope: true,
        pulleyWheelId: '',
        leftTargetId: '',
        rightTargetId: ''
      } : {}),
      ...(type === 'openscad' ? {
        scad: `// Example OpenSCAD Code\ndifference() {\n  cube([0.1, 0.1, 0.1], center=true);\n  sphere(d=0.12, $fn=16);\n}`
      } : {}),
      ...(type === 'ring' ? {
        csgEnabled: true,
        csgCollision: 'auto' as const,
        csgSectors: CSG_DEFAULT_SECTORS,
        csgMass: 1,
      } : {}),
      ...(type === 'sculpt' ? {
        isSculpt: true,
        sculptBase: DEFAULT_SCULPT_BASE,
        sculptVersion: 1,
      } : {}),
      ...(type === 'lattice' ? {
        isLattice: true,
        latticeCage: serializeCage(createLattice(LATTICE_UNIT)),
        latticeSubdiv: 0,
        latticeVersion: 1,
        latticeOrigin: [0, 0, 0],
      } : {}),
      ...(type === 'curve' ? {
        isCurve: true,
        curvePoints: PALETTE_CURVE_POINTS.map(p => [...p]),
        curveWidth: PALETTE_CURVE_WIDTH,
        curveThickness: PALETTE_CURVE_THICKNESS,
        curveSegments: DEFAULT_CURVE_SEGMENTS
      } : {}),
    };

    // Placed by its size, now that it has one: see utils/spawnPlacement.ts.
    if (!opts?.exact) {
      const parent = isChild ? findNodeById(newScene.nodes, parentId!) : null;
      if (parent) {
        newNode.pos = type === 'capsule' || type === 'bob'
          ? [0, 0, belowOffset(parent, newNode)]
          : [besideOffset(parent, newNode), 0, 0];
      } else if (!isChild) {
        newNode.pos = restingPos(newNode, newScene.nodes, position);
      }
    }

    if (isChild && parentId) {
      addChildNode(newScene.nodes, parentId, newNode);
    } else {
      newScene.nodes.push(newNode);
    }
    
    // A nested part leaves its parent selected: the next add goes beside it,
    // not under it.
    const selectId = isChild ? parentId! : typeof window !== 'undefined' && (window as PhysicsWindow).NO_SELECT ? null : id;
    /*
     * The body is written to the store HERE, not left for the recompile to land.
     *
     * recompile is debounced and drops out entirely when a later one supersedes
     * it, without ever writing its scene. So a body added while anything else
     * was touching the scene simply never appeared — no error, no node. Over MCP
     * that surfaced as physics_create_sculpt timing out after ten seconds
     * waiting for a node that was never going to arrive, which is how it failed
     * for a whole session once the app got busy.
     *
     * Writing it now also means the id can be used on the very next line, which
     * is what every caller wants and what the add-a-single-body bridge command
     * needs.
     */
    set(selectId === null ? { sceneGraph: newScene } : { sceneGraph: newScene, selectedNodeId: selectId });
    get().recompile(newScene, selectId);
    return id;
  },
  
  recompile: async (overrideScene?: SceneGraph, overrideSelectedId?: string | null, forceReset?: boolean, _keepPreset?: boolean, settle?: boolean, immediate?: boolean) => {
    // An edit the Cast-prep guard turned away never reached the store; its
    // action's own rebuild must not build it either.
    if (overrideScene && refusedGraphs.has(overrideScene)) return;
    if (overrideScene) overrideScene = keptGraphs.get(overrideScene) ?? overrideScene;
    /*
     * We only debounce if it's NOT a force reset (which is used by presets/loaders).
     *
     * Superseding a pending recompile used to clear its timer and nothing else,
     * so the `await` inside it was left holding a promise that could never
     * settle: every caller that awaited a debounced recompile which a later one
     * overtook simply hung, forever. Nothing noticed while the callers were
     * fire-and-forget UI handlers, but an MCP command that awaits its own
     * recompile before replying just stops responding.
     *
     * So the superseded call is woken and returns without building — the newer
     * one is about to build the newer scene, and two builds of the same state is
     * the other thing we do not want.
     */
    const token = ++recompileToken;
    // The scene as it stood when this build was asked for — see
    // graphAtBuildStart below for why it has to be taken here, before the
    // debounce, when the caller hands in the scene to build.
    const graphAtCall = get().sceneGraph;
    // Counted from the CALL, not from the build: the debounce below is fifty
    // milliseconds, and the undo snapshot is offered for flushing on the very
    // next tick. Counting any later and the snapshot is gone before the change
    // it belongs to has even started compiling.
    recompilesInFlight++;
    let counted = true;
    const done = () => { if (counted) { counted = false; recompilesInFlight = Math.max(0, recompilesInFlight - 1); } };
    /*
     * A force reset normally skips the wait, because it is what a preset load,
     * an undo and a reset all use and none of those may lag. But an edit from a
     * control is also a force reset, and those arrive in bursts: a rotate
     * commits three axes in a row, and each one would otherwise rebuild the
     * model and throw the sim state away on its own. `settle` is how an editing
     * caller asks for the wait back without giving the loaders one — see
     * `updateNodePos`, `updateNodeRotation` and `updateNodeGeom`.
     */
    /*
     * `immediate` is the one way to rebuild at once AND keep the simulation
     * state. A forceReset does the first but not the second, and everything
     * else waits out the debounce — right for a slider being dragged, wrong for
     * something that has already happened in the world. A body shatters on a
     * particular step, and fifty milliseconds of the old model still being on
     * screen is fifty milliseconds of a vase that is not there any more.
     */
    if ((!forceReset && !immediate) || settle) {
      const win = (typeof window !== 'undefined' ? window : globalThis) as unknown as PhysicsWindow;
      if (win._recompileTimeoutId) {
        clearTimeout(win._recompileTimeoutId);
        win._recompileWake?.();
      }
      await new Promise<void>(resolve => {
        win._recompileWake = resolve;
        win._recompileTimeoutId = setTimeout(resolve, settle ? 180 : 50);
      });
      win._recompileWake = null;
      if (token !== recompileToken) {
        // Handed on rather than dropped: the call that overtook this one builds
        // the newer scene, and it must still start that scene from rest if this
        // one was asked to.
        if (forceReset) pendingForceReset = true;
        done();
        return;
      }
    }
    // A reset asked for by a call this one superseded. Without it, whether a
    // sculpt stroke reset the simulation came down to timing: the first stroke
    // also marks the body edited, and that state-keeping rebuild overtook the
    // stroke's own reset inside its debounce.
    if (pendingForceReset) forceReset = true;
    pendingForceReset = false;

    if (typeof window !== 'undefined') {
      (window as PhysicsWindow).DISABLE_USEFRAME = false;
    }
    const { gravityZ, windX, windY, density, floorFriction, floorBounce } = get();
    /*
     * The RUNTIME graph wins, when there is one.
     *
     * A shattered body is not an edit: `sceneGraph` still holds the whole vase,
     * which is what gets saved, exported, shared and handed to MCP. What is on
     * screen and in the solver while the pieces are flying is `runtimeGraph`,
     * and every rebuild between the break and the reset has to compile that one
     * — including the ones nobody asked for, like the periodic worker recycle.
     * Miss one and the vase silently reassembles itself mid-air.
     */
    const pieces = get().shatteredBodies;
    const deformed = get().deformedGeoms;
    const isRuntimeBuild = !overrideScene
      && (Object.keys(pieces).length > 0 || Object.keys(deformed).length > 0);
    const sceneGraph = overrideScene ?? (isRuntimeBuild
      ? applyShatterPieces(get().sceneGraph, pieces, deformed)
      : get().sceneGraph);

    /*
     * What the store held when this build started.
     *
     * The scene is written back below on the next animation frame, from the
     * snapshot this build was given — so any edit made while the build was in
     * flight was thrown away when it landed. Renaming a body immediately after
     * adding one did exactly that: the rename applied, the add's build finished
     * a frame later, and the old name came back with no error anywhere.
     *
     * A build is authoritative about the model it produced, not about every
     * other field of a node, so if the scene has moved on underneath us we keep
     * the newer one and install only the compiled model.
     *
     * "Underneath us" counts from the moment the scene being built was chosen.
     * A caller that passes one chose it at the call, before the debounce above;
     * taking the snapshot after the debounce let any edit made in those fifty
     * milliseconds pass for the starting state, and the build then wrote its
     * older scene straight over it. That is how a rounding dropped by the
     * compiler (keepFoundEdges) came back a moment later.
     */
    const graphAtBuildStart = overrideScene ? graphAtCall : get().sceneGraph;
    // Set once the worker is holding the model this build made; released when
    // that model is on screen.
    let heldClient: PhysicsWorkerClient | null = null;

    const applyBuilt = (built: BuiltResult) => {
      // Once, not on every edit's rebuild.
      if (!loggedSharedMode) {
        loggedSharedMode = true;
        console.info(`[PhysicsWorker] Shared memory (COOP/COEP) active: ${!!built.isShared}`);
      }
      if (built.heapBytes) setLastHeapBytes(built.heapBytes);
      const updates: Partial<PhysicsState> = {
        mujoco: MUJOCO_SHIM, model: buildModelMirror(built), data: buildDataMirror(built),
        sceneGraph, recompileId: Date.now(), lastCompileError: null, isLoaded: true,
      };
      // A build of the runtime overlay must never write the overlay back over
      // the document — that is the one thing that would make a break permanent.
      if (isRuntimeBuild) delete updates.sceneGraph;
      // This model contains exactly these pieces, so this is the moment the
      // renderer may start drawing them.
      if (!overrideScene) updates.visibleShatteredBodies = pieces;
      if (overrideSelectedId !== undefined) updates.selectedNodeId = overrideSelectedId;
      onNextPaint(() => {
        if (get().sceneGraph !== graphAtBuildStart && get().sceneGraph !== sceneGraph) {
          delete updates.sceneGraph;
        }
        set(updates);
        heldClient?.resume();
        heldClient = null;
        done();
        // The scene has moved at last; this is the moment the snapshot taken
        // before it is worth keeping.
        get().flushPendingUndo();
      });
    };

    try {
      // Proactively recycle before the ceiling is ever reached, rather than
      // only reacting to a hard failure — see RECYCLE_HEAP_BYTES comment.
      //
      // Decided BEFORE compiling: the XML names mesh files that this client's
      // worker holds (see utils/meshVfs.ts), and a fresh worker holds none.
      let recycled = false;
      if (lastHeapBytes > RECYCLE_HEAP_BYTES) {
        console.warn(`Proactively recycling the physics worker: the WASM heap has reached ${(lastHeapBytes / 1048576).toFixed(0)} MB, past the ${(RECYCLE_HEAP_BYTES / 1048576).toFixed(0)} MB mark, to stay well clear of the ceiling.`);
        recycleWorker();
        recycled = true;
      }
      const client = getPhysicsWorkerClient();

      const xml = compileToMJCF(sceneGraph, gravityZ, floorFriction, windX, windY, density, floorBounce, {
        // A shattered scene is mostly a heap of shards that have stopped
        // moving; asleep, they cost nothing until something disturbs them.
        sleep: Object.keys(pieces).length > 0 && !overrideScene,
        meshFiles: client.meshFiles,
      });
      if (typeof window !== 'undefined') {
        (window as PhysicsWindow).compiledXML = xml;
      }

      /*
       * A recycled worker has no previous model to carry the simulation across,
       * so the rebuild lands on the pose the DOCUMENT describes — and a body
       * that has been tipped by the simulation, or turned by a drag that only
       * wrote qpos, has no record of its orientation there. Every fifth edit
       * therefore stood such a body back up, which read as a body occasionally
       * forgetting its rotation part way through moving or scaling it.
       *
       * So the live mirror is handed over as a seed, exactly as the periodic
       * mid-play recycle already does. Only on a recycle: with the worker still
       * running, its own copy is the fresher of the two — the main thread's
       * mirror lags a frame behind — and preferring the seed would undo a drag
       * that had just written qpos directly. A seed whose length disagrees with
       * the new model is ignored by the worker, which is the honest answer when
       * an edit really has changed the shape of the state.
       *
       * Never on a force reset. The worker prefers a seed to everything else,
       * so seeding a preset load, an undo or a reset — any of which can land on
       * the fifth build like anything else — would restore the very state those
       * callers exist to throw away.
       */
      const live = recycled && !forceReset ? get().data : null;
      const seedState = live?.qpos
        ? {
            qpos: Array.from(live.qpos as Float64Array),
            qvel: Array.from(live.qvel as Float64Array),
            ctrl: Array.from(live.ctrl as Float64Array),
            time: live.time as number,
            scriptState: lastScriptState,
          }
        : undefined;

      client.setEnv(windX, windY, density);
      // Something has just broken mid-flight: have the worker wait for this
      // model to be on screen before stepping it. See `holdUntil` in the worker.
      const hold = !!immediate && isRuntimeBuild && !forceReset;
      const built = await client.build(xml, sceneGraph, !forceReset, seedState, get().brokenConstraints, hold);
      if (hold && built.ok) heldClient = client;
      if (!built.ok) {
        throw new Error(built.error || 'Unknown physics worker build error');
      }
      applyBuilt(built);
      // A fresh worker starts paused. The other two recycles tell it to play;
      // this one didn't, so the simulation froze while the UI still said Play.
      if (recycled && get().isPlaying) client.setPlaying(true);
    } catch (e) {
      console.error("Failed to compile MJCF:", e);
      const msg = String(e instanceof Error ? e.message : e);
      if (/Aborted|enlarge memory|abort|bad_alloc/i.test(msg)) {
        // The WASM module's linear memory only ever grows across a session, and
        // the @mujoco/mujoco build has a hard 2^31-byte ceiling it can never
        // exceed. Reinstantiating a module in the SAME worker/realm isn't
        // guaranteed to actually return that memory to the OS, so recover by
        // terminating the whole worker (a separate JS realm) and spawning a
        // fresh one — a real reclaim — then rebuilding the same scene against
        // it. Only reload the page if that also fails.
        try {
          console.warn('MuJoCo WASM heap exhausted — terminating and respawning the physics worker (keeping scene/camera).');
          const live = !forceReset ? get().data : null;
          const recoverySeedState = live?.qpos
            ? {
                qpos: Array.from(live.qpos as Float64Array),
                qvel: Array.from(live.qvel as Float64Array),
                ctrl: Array.from(live.ctrl as Float64Array),
                time: live.time as number,
                scriptState: lastScriptState,
              }
            : undefined;
          recycleWorker();
          const freshClient = getPhysicsWorkerClient();
          freshClient.setEnv(windX, windY, density);
          const xml = compileToMJCF(sceneGraph, gravityZ, floorFriction, windX, windY, density, floorBounce, {
            // As the ordinary build above decides it.
            sleep: Object.keys(pieces).length > 0 && !overrideScene,
            meshFiles: freshClient.meshFiles,
          });
          const hold = !!immediate && isRuntimeBuild && !forceReset;
          const built = await freshClient.build(xml, sceneGraph, !forceReset, recoverySeedState, get().brokenConstraints, hold);
          if (hold && built.ok) heldClient = freshClient;
          if (!built.ok) throw new Error(built.error || 'Unknown physics worker build error', { cause: e });
          applyBuilt(built);
          if (get().isPlaying) freshClient.setPlaying(true);
          return;
        } catch (recoveryError) {
          console.error('Worker respawn recovery failed, falling back to full page reload:', recoveryError);
          // Asked in the app's own dialog rather than a native alert, and with
          // the way out of losing the scene on it: the reload drops back to a
          // blank scene, so the scene is offered as a file first.
          const reload = () => { allowUnload(); window.location.reload(); };
          useDialogs.getState().openDialog({
            title: 'The physics engine ran out of memory',
            body: 'It could not recover, even after restarting. The page has to reload to free the memory, and the reload starts from a blank scene. Save the scene as a file first; Import opens it again.',
            confirmLabel: 'Save scene and reload',
            cancelLabel: 'Reload without saving',
            tone: 'red',
            onConfirm: () => {
              try { downloadSceneRescue(get().sceneGraph, get().activePreset); } catch (err) { console.error('Could not save the scene', err); }
              // A tick for the download to start before the page goes.
              setTimeout(reload, 500);
            },
            onCancel: reload,
          });
          done();
          return;
        }
      }
      // A build that a newer call has already superseded is not news: that
      // call is building the newer scene, and its outcome is the one to report.
      if (token !== recompileToken) { done(); return; }
      // Still update the sceneGraph so the UI reflects the change even if MuJoCo
      // rejects it — but only if nothing has been written since this build
      // began, the same guard the success path uses. Unguarded, a failed build
      // of stroke N landing after stroke N+1 had been committed put stroke N
      // back into the document, and could leave it there. And never a runtime
      // overlay, which would make a shatter permanent.
      const updates: Partial<PhysicsState> = { lastCompileError: msg };
      const sceneMovedOn = get().sceneGraph !== graphAtBuildStart && get().sceneGraph !== sceneGraph;
      if (!isRuntimeBuild && !sceneMovedOn) updates.sceneGraph = sceneGraph;
      if (overrideSelectedId !== undefined) updates.selectedNodeId = overrideSelectedId;
      set(updates);
      done();
      get().flushPendingUndo();
    }
  },

  recoverFromFatalWorkerError: async (message, lastState) => {
    // Mirrors recompile()'s memory-exhaustion recovery, but triggered from a
    // fatal error reported by the worker mid-simulation (not during a build):
    // terminate the exhausted worker (real memory reclaim) and rebuild the
    // current scene fresh, reseeding the last qpos/qvel/time the worker
    // reported right before it died (best-effort — if that report itself
    // failed to arrive, this falls back to the as-built initial pose).
    console.warn('Fatal physics worker error — terminating and respawning worker:', message);
    const wasPlaying = get().isPlaying;
    recycleWorker();
    set({ isPlaying: false });
    const { gravityZ, windX, windY, density, floorFriction, floorBounce } = get();
    const { graph: sceneGraph, sleep } = liveModelGraph(get());
    try {
      const client = getPhysicsWorkerClient();
      const xml = compileToMJCF(sceneGraph, gravityZ, floorFriction, windX, windY, density, floorBounce, {
        sleep,
        meshFiles: client.meshFiles,
      });
      client.setEnv(windX, windY, density);
      const built = await client.build(xml, sceneGraph, false, lastState, get().brokenConstraints);
      if (!built.ok) throw new Error(built.error || 'Unknown physics worker build error');
      set({ mujoco: MUJOCO_SHIM, model: buildModelMirror(built), data: buildDataMirror(built), recompileId: Date.now(), lastCompileError: null });
      if (wasPlaying) { client.setPlaying(true); set({ isPlaying: true }); }
    } catch (e) {
      console.error('Recovery rebuild after fatal worker error failed:', e);
    }
  },

  recycleWorkerSeamlessly: async () => {
    // Proactive recycle while actively simulating: MuJoCo's own internal
    // contact/constraint memory can grow over the course of a long play
    // session — not just across explicit rebuilds — and, like everything else
    // in a WASM realm, never shrinks back down on its own. Swap in a fresh
    // worker before that becomes a problem, carrying over the exact current
    // qpos/qvel/time (from the live `data` mirror, kept up to date by FRAME
    // messages) so it's invisible rather than a visible reset.
    //
    // Checked against the heap the worker reports with every frame rather than
    // done unconditionally on a timer. A respawn reloads MuJoCo from scratch,
    // and most play sessions never grow the arena enough to need one — a scene
    // whose contacts are not piling up now pays nothing. See the periodic timer
    // below this store definition, which is what calls this.
    // isPlaying is deliberately read later via get(), not destructured here: the
    // await below means the snapshot could be stale by the time it's used.
    const { data, gravityZ, windX, windY, density, floorFriction, floorBounce } = get();
    const { graph: sceneGraph, sleep } = liveModelGraph(get());
    if (!data) return;
    if (lastHeapBytes <= RECYCLE_HEAP_BYTES) return;
    // Never recycle on top of a request the worker hasn't answered yet: killing
    // the worker mid-build fails a rebuild that was about to succeed (and an
    // MCP command driving one would be told its scene didn't build). The
    // recycle is purely housekeeping — 20s later is just as good.
    if (getPhysicsWorkerClient().hasPendingWork()) return;
    console.warn(`Seamlessly recycling the physics worker mid-play: the WASM heap has reached ${(lastHeapBytes / 1048576).toFixed(0)} MB, past the ${(RECYCLE_HEAP_BYTES / 1048576).toFixed(0)} MB mark.`);
    const seedState = {
      qpos: Array.from(data.qpos as Float64Array),
      qvel: Array.from(data.qvel as Float64Array),
      ctrl: Array.from(data.ctrl as Float64Array),
      time: data.time as number,
      // A fresh worker is a fresh realm: without this every script's api.state
      // (and, as ever, its globals) would be wiped mid-play.
      scriptState: lastScriptState,
    };
    recycleWorker();
    try {
      const client = getPhysicsWorkerClient();
      const xml = compileToMJCF(sceneGraph, gravityZ, floorFriction, windX, windY, density, floorBounce, {
        sleep,
        meshFiles: client.meshFiles,
      });
      client.setEnv(windX, windY, density);
      const built = await client.build(xml, sceneGraph, false, seedState, get().brokenConstraints);
      if (!built.ok) throw new Error(built.error || 'Unknown physics worker build error');
      if (built.heapBytes) setLastHeapBytes(built.heapBytes);
      set({ mujoco: MUJOCO_SHIM, model: buildModelMirror(built), data: buildDataMirror(built), recompileId: Date.now(), lastCompileError: null });
      if (get().isPlaying) client.setPlaying(true);
    } catch (e) {
      console.error('Seamless proactive worker recycle failed:', e);
    }
  },
})));
bindStore(useStore);

if (typeof window !== 'undefined') {
  // Every 20s while actively playing, CHECK whether the physics worker needs
  // recycling (see recycleWorkerSeamlessly above, which returns immediately
  // unless the heap says otherwise) — this is what addresses memory growth from
  // long-running simulation, as opposed to the recycle in recompile() which
  // only looks at the heap across rebuilds. The interval is how often the
  // question is asked; it is no longer how often a worker is thrown away.
  setInterval(() => {
    // Linked to Volt the scene steps without playing, and grows the heap the same way.
    if (useStore.getState().isPlaying || useStore.getState().voltLink) {
      useStore.getState().recycleWorkerSeamlessly();
    }
  }, 20000);
}
