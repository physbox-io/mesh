import { create, type StateCreator } from 'zustand';
import { shareUnchanged } from '../utils/shareUnchanged';
import * as THREE from 'three';
import type { SceneGraph, SceneNode, SceneGeom, SceneJoint, GeomType, ReferenceImage } from '../types/scene';
import { reconcileEdgeRounds } from '../utils/edgeRound';
import { releaseFastenings } from '../utils/hardwareParts';
import { hardwarePartActions, type HardwarePartActions } from './hardwarePartActions';
import { extrusionActions, type ExtrusionActions } from './extrusionActions';
import { clipboardActions, type ClipboardActions } from './clipboardActions';
import { belowOffset, besideOffset, restingPos } from '../utils/spawnPlacement';
import type { DataMirror, ModelMirror } from '../types/sceneLayer';
import { toSceneGeom } from '../utils/sculptMesh';
import { buildSculptBaseSized, DEFAULT_SCULPT_BASE, DEFAULT_SCULPT_SIZE } from '../utils/sculptBases';
import {
  createLattice, deserializeCage, serializeCage, toSceneGeom as latticeToSceneGeom,
  DEFAULT_UNIT as LATTICE_UNIT,
} from '../utils/latticeMesh';
import { CSG_DEFAULT_SECTORS, sourcePositiveBounds, reconcileCuts, hasBooleanOps } from '../utils/csg';
import { insetNegatives } from '../utils/scaleNode';
import type { FacePatternTarget } from '../utils/facePatternPick';
import type { CameraView } from '../utils/cameraViews';
import { generateGearGeoms } from '../presets/presetScenes';
import type { ConstraintBrokenEvent } from '../workers/physicsWorkerProtocol';
import { DEFAULT_JOIN_MATERIAL, joinMaterial } from '../utils/joinMaterials';
import { generatePyramidMeshData, generateConeMeshData, generateTorusMeshData, generateTubeMeshData, generateCurveGeoms, DEFAULT_CURVE_POINTS, DEFAULT_CURVE_WIDTH, DEFAULT_CURVE_THICKNESS, DEFAULT_CURVE_SEGMENTS, getStickyRotation } from '../utils/geom';
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
import { getNodeWorldPos } from '../utils/sceneTree';
import { findNodeById, cloneSceneGraph, findNode, addChildNode } from './sceneClone';
import { bindStore } from './storeRef';

// Moved out of this file into the modules above, and still imported from here.
export { cloneSceneGraph } from './sceneClone';
export { restoreCollisionWhenMadeMovable, scaleMeshGeoms } from './meshGeomTransforms';
export { castPrepArmed } from './editGuard';
export { applyShatterPieces, effectiveSceneGraph, type DeformedGeometry } from './breakage';
export { endVoltLink, getPhysicsWorkerClient, setPhysicsFrameListener } from './physicsEngine';
export type { EdgeRoundSession } from './edgeRoundActions';
export type { UndoRedoState } from './historyActions';
import {
  isAllMeshNode, promoteMeshGeomsToDynamic, restoreCollisionWhenMadeMovable, mapVerts,
  translateMeshGeoms, rotateMeshGeomsAbsolute,
} from './meshGeomTransforms';
import { userEditPending, castPrepBypass, refusedGraphs, keptGraphs, castPrepArmed, bodiesChanged } from './editGuard';
import { type DeformedGeometry, detachReferencesTo } from './breakage';
import { shapeParamActions, type ShapeParamActions } from './shapeParamActions';
import { type PhysicsWindow, MUJOCO_SHIM, getPhysicsWorkerClient } from './physicsEngine';
import { initialPreset, initialScene, initialFraming, snapForGridMm } from './sceneFraming';
import { latticeActions, type LatticeActions } from './latticeActions';
import { dropStaleColliders, rebuildAfterGeomEdit } from './geomEdits';
import { sculptActions, type SculptActions } from './sculptActions';
import { printSplitActions, type PrintSplitActions } from './printSplitActions';
import { edgeRoundActions, type EdgeRoundActions } from './edgeRoundActions';
import { castPrepActions, type CastPrepActions } from './castPrepActions';
import { cutActions, type CutActions } from './cutActions';
import { breakageActions, type BreakageActions } from './breakageActions';
import { paintActions, type PaintActions } from './paintActions';
import { booleanActions, type BooleanActions } from './booleanActions';
import { simulationActions, type SimulationActions } from './simulationActions';
import { historyActions, type HistoryActions } from './historyActions';
import { sceneSwapActions, type SceneSwapActions } from './sceneSwapActions';

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

export interface PhysicsState extends HardwarePartActions, ExtrusionActions, ClipboardActions, ShapeParamActions, LatticeActions, SculptActions, PrintSplitActions, EdgeRoundActions, CastPrepActions, CutActions, BreakageActions, PaintActions, BooleanActions, SimulationActions, HistoryActions, SceneSwapActions {
  
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
  /**
   * Puts a scaled copy of a body's own shape inside it, marked as a hole.
   *
   * The shortest path from a solid to a hollow one. Factors are per-axis, and
   * an axis above 1 is how the copy is made to pass right through — a cylinder
   * with a [0.8, 0.8, 1.05] copy of itself subtracted is a pipe, where the same
   * copy shrunk on all three would be a sealed cavity nobody can see.
   */
  insetNodeGeoms: (nodeId: string, factor: [number, number, number], pocket?: { axis: 0 | 1 | 2; side: 1 | -1 }) => void;
  incrementMcpActive: () => void;
  decrementMcpActive: () => void;
  resetMcpActive: () => void;
  incrementScadCompile: () => void;
  decrementScadCompile: () => void;
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
  ...breakageActions({ set, get }),
  ...paintActions({ set, get }),
  ...booleanActions({ set, get }),
  ...simulationActions({ set, get }),
  ...historyActions({ set, get }),
  ...sceneSwapActions({ set, get }),

  voltLink: null,
  brokenConstraints: [],
  lastBreak: null,
  shatteredBodies: {},
  visibleShatteredBodies: {},
  deformedGeoms: {},
  lastShatter: null,
  isLoaded: false,
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
