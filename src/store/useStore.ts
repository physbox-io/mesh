import { create, type StateCreator } from 'zustand';
import { shareUnchanged } from '../utils/shareUnchanged';
import type { SceneGraph, SceneNode, ReferenceImage } from '../types/scene';
import { hardwarePartActions, type HardwarePartActions } from './hardwarePartActions';
import { extrusionActions, type ExtrusionActions } from './extrusionActions';
import { clipboardActions, type ClipboardActions } from './clipboardActions';
import type { FacePatternTarget } from '../utils/facePatternPick';
import type { CameraView } from '../utils/cameraViews';
import type { ConstraintBrokenEvent } from '../workers/physicsWorkerProtocol';
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
import { cloneSceneGraph } from './sceneClone';
import { bindStore } from './storeRef';

// Moved out of this file into the modules above, and still imported from here.
export { cloneSceneGraph } from './sceneClone';
export { restoreCollisionWhenMadeMovable, scaleMeshGeoms } from './meshGeomTransforms';
export { castPrepArmed } from './editGuard';
export { applyShatterPieces, effectiveSceneGraph, type DeformedGeometry } from './breakage';
export { endVoltLink, getPhysicsWorkerClient, setPhysicsFrameListener } from './physicsEngine';
export type { EdgeRoundSession } from './edgeRoundActions';
export type { UndoRedoState } from './historyActions';
export type { AddPlacement } from './addComponentActions';
import { userEditPending, castPrepBypass, refusedGraphs, keptGraphs, castPrepArmed, bodiesChanged } from './editGuard';
import type { DeformedGeometry } from './breakage';
import { shapeParamActions, type ShapeParamActions } from './shapeParamActions';
import { getPhysicsWorkerClient } from './physicsEngine';
import { initialPreset, initialScene, initialFraming, snapForGridMm } from './sceneFraming';
import { latticeActions, type LatticeActions } from './latticeActions';
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
import { addComponentActions, type AddComponentActions } from './addComponentActions';
import { geomActions, type GeomActions } from './geomActions';
import { nodeActions, type NodeActions } from './nodeActions';

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


export interface PhysicsState extends HardwarePartActions, ExtrusionActions, ClipboardActions, ShapeParamActions, LatticeActions, SculptActions, PrintSplitActions, EdgeRoundActions, CastPrepActions, CutActions, BreakageActions, PaintActions, BooleanActions, SimulationActions, HistoryActions, SceneSwapActions, AddComponentActions, GeomActions, NodeActions {
  
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
  rotateAroundCOM: boolean;
  setRotateAroundCOM: (val: boolean) => void;

  setDraggedNodeId: (id: string | null) => void;
  setDragTarget: (target: { x: number; y: number; z: number } | null) => void;
  setDragDistance: (distance: number) => void;
  
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
  ...addComponentActions({ set, get }),
  ...geomActions({ set, get }),
  ...nodeActions({ set, get }),

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
