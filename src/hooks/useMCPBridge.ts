/**
 * MCP bridge for Physics Sim.
 * Uses the Zustand store directly (getState/setState) from outside React.
 */

import { hexToRgb, rgbToHex } from '../utils/hexColor';
import { useEffect } from 'react';
import { getStoredAuthToken } from '../utils/apiClient';
import { tabSession } from '../utils/tabSession';
import { useViewQuality } from '../store/viewQualityStore';
import { renderViewportNow, captureViewportThumb } from '../utils/viewportCapture';
import { savePreset } from '../utils/presetStorage';
import { announcePresetSave } from '../utils/presetNotices';
import { summarizeTrajectory } from '../utils/trajectorySummary';
import { authoredQuat, orientationOf } from '../utils/bodyOrientation';
import { pocketMesh, type PocketSpec } from '../utils/pocketCutter';
import { useStore, getPhysicsWorkerClient } from '../store/useStore';
import { useDentStore } from '../store/dentStore';
import { isDentable, needsConversionForDenting } from '../utils/dentMesh';
import type { DentConfig } from '../utils/breakThresholds';
import { createMeshMachineHandlers, setCurrentScene } from '../utils/machineMcp';
import { compileToMJCF, PRINT_CONTACT_TIME } from '../utils/mjcf';
import { analyzeMesh } from '../utils/meshIntegrity';
import { compileSCAD } from '../utils/openscad';
import { getLiveCameraPose } from '../utils/liveCamera';
import { makePresetNoteCard, updateOrCreateNotecard, type NoteCard } from '../utils/noteCards';
import { generateCurveGeoms, normalizeMeshGeomData, DEFAULT_CURVE_POINTS, DEFAULT_CURVE_WIDTH, DEFAULT_CURVE_THICKNESS, DEFAULT_CURVE_SEGMENTS } from '../utils/geom';
import { compileCsgNodes } from './useCsgCompile';
import { bodyEdges, bodyUp, whyNotRoundable } from '../utils/edgeRoundBase';
import { maxSizeFor, sameEdge, selectEdges, type EdgeCandidate, type EdgeGroup } from '../utils/featureEdges';
import { csgFrameOffset, collisionModeOf } from '../utils/csg';
import { solidMeshGeoms, SOLIDITY_DECOMPOSE_BELOW } from '../utils/convexDecomposition';
import { PRESETS } from '../presets/presetScenes';
import { parseSTL } from '../utils/stlParser';
import {
  applyDab, buildMeshPaintGeometry, buildPaintGeometry, canvasFromLayer, isPaintable,
  layerFromCanvas, paintArgsFromSize, paintMeshResolution, paintResolution, toGeometrySpace,
} from '../utils/vertexPaint';
import { deleteUserPreset, readUserPreset, listUserPresetNames, ensureUserPreset, type SavedCopilotMessage } from '../utils/userPresets';
import { unpackMeshArrays } from '../utils/meshPacking';
import { SCULPT_BASES, buildSculptBase, buildSculptBaseSized, MAX_SCULPT_SIZE, MIN_SCULPT_SIZE, type SculptBaseId } from '../utils/sculptBases';
import { fromSceneGeom, toSceneGeom, splitComponents, type BrushType } from '../utils/sculptMesh';
import { applySculptStroke, probeSurface, sculptSummary, undoSculptStroke, BRUSH_TYPES } from '../utils/sculptCommands';
import { cutSculptOffThread } from '../utils/sculptCutClient';
import type { CarveProfile } from '../utils/sculptCarve';
import { describeReferenceImage, normalizeReferencePicture, readReferencePatch, upsertReferenceImage } from '../utils/referenceImages';
import { sceneContentBounds } from '../utils/frameScene';
import {
  addFacesMm, addRingMm, bevelEdgesMm, bevelFaceMm, bridgeFacesMm, describeLattice,
  dimensionSelectionMm, extrudeMm,
  insetFaceMm, latticeSummary, removeFacesMm, revolveMm, sharpenEdgesMm,
} from '../utils/latticeCommands';
import { measureInScene } from '../utils/measureScene';
import { getNodeWorldPos } from '../utils/sceneTree';
import { generateCastPattern, DEFAULT_CAST_OPTIONS, type CastMethod } from '../utils/castPatternExporter';
import { runCastPrep } from '../utils/castPrepRunner';
import { planPourBox } from '../utils/pourBoxScene';
import { addPourBoxToScene, pourBoxStl } from '../utils/pourBoxActions';
import { SILICONES, type PourBoxOptions, type SiliconeId } from '../utils/siliconeMold';
import { cutAlongPlaneOffThread, selectionSoups, splitOffThread, testAssemblyOffThread } from '../utils/printSplitClient';
import { loadManifold } from '../utils/sculptCut';
import {
  collectIndividualPartSoups,
  decomposeSolidIntoPlanks,
  resolveTimberTargetIds,
  type PlankJointType,
} from '../utils/timberBreakdown';
import { synthesizeTimberJoinery, type TenonCornerFit, type TimberEdgeProfile, type TimberJointMode } from '../utils/timberJoinery';
import { buildTimberCutPlan } from '../utils/timberCutList';
import { filamentSpec } from '../utils/filaments';
import { deriveSolidOptions, measurePart, type SolidMachiningOptions, type SolidMachiningResult } from '../utils/solidMachiningExporter';
import {
  APP_RELIEF_DEFAULTS,
  DEFAULT_RELIEF_OPTIONS,
  deriveReliefFeeds,
  describeCutter,
  type ReliefCarveOptions,
  type ReliefCarveResult,
} from '../utils/reliefCarveExporter';
import { DEFAULT_LASER_OPTIONS, type LaserCutResult } from '../utils/laserCutExporter';
import { DEFAULT_CONTOUR_OPTIONS, collectSceneTriangles, type ContourSliceResult } from '../utils/contourSliceExporter';
import { exportSheetUnfold, type SheetUnfoldOptions } from '../utils/sheetUnfoldExporter';
import {
  PCB_PRESETS,
  buildPcbNode,
  decodePcbHandoff,
  exportPcbFaceplateSvg,
  generatePcbEnclosure,
  type PcbEnclosureFace,
  type PcbEnclosureOptions,
  type PcbMechanicalSpec,
} from '../utils/pcbEnclosureSync';
import {
  buildCamMechanism,
  buildFourBarLinkage,
  buildGt2BeltDrive,
  buildInvoluteGearNode,
  buildLeadscrewDrive,
  buildMeshingGearPair,
  buildRackAndPinionPair,
  type CamSpec,
  type FourBarSpec,
  type Gt2BeltDriveSpec,
  type InvoluteGearSpec,
  type InvoluteRackSpec,
  type LeadscrewSpec,
} from '../utils/mechanismParts';
import {
  PIPE_STANDARDS,
  breakdownPipeFrame,
  buildAllCustomHubNodes,
  buildWireBendingJigNode,
  computeTubeCopeJoint,
  computeWireBendSchedule,
  exportTubeCopeSvg,
  generatePipeStructurePreset,
  type PipeFrameOptions,
  type PipeStandardId,
  type PipeStructurePresetId,
  type TubeCopeSpec,
  type WireBendJigOptions,
} from '../utils/tubeAndWireExporter';
import { reliefSimulationTools } from '../utils/simulatedPart';
import { simulationSetups } from '../utils/solidSetups';
import { BLOCK_FACES, FACE_NAME, type BlockFace } from '../utils/orient';
import { contourSheetParts, laserSheetParts, laserStockTransform } from '../utils/sheetSimulation';
import { addSimulationToScene } from './useAddSimulation';
import { runMcpMoldSimulation } from '../utils/moldWorkerClient';
import { runMcpRepairMesh } from '../utils/meshRepair';
import { lastReliefOptions } from '../utils/lastReliefOptions';
import { ExportWorkerClient } from '../utils/exportWorkerClient';
import { patternPickAt, patternSurfaces } from '../utils/facePatternPick';
import { carryAcrossCut, knifeSoups, seamsAcross } from '../utils/knife';
import { SURFACE_PATTERNS, patternById } from '../utils/surfacePatterns';
import {
  DEFAULT_TEXTURE_BORDER_M,
  DEFAULT_TEXTURE_CELL_M,
  splitSeams,
  type SurfaceTexture,
  type TextureProjection,
} from '../utils/surfaceTexture';
import { geomHalfLen } from '../utils/geomSurface';
import { requestTexturedSurface } from '../utils/textureClient';
import { webSerialManager } from '../utils/webSerialManager';
import type { Object3D } from 'three';
import { Quaternion, Vector3 } from 'three';
import type { SceneGraph, SceneNode, SceneGeom, SceneJoint, HardwareBore, HardwareCutKind, HardwarePartKind, SealType } from '../types/scene';
import type { ModelMirror } from '../types/sceneLayer';
import type { RawGeom, RawJoint, RawNode } from '../utils/sceneNodes';
import { HARDWARE_KINDS, hardwareCutProblem, hardwareSpecOf } from '../utils/hardwareCuts';
import { HARDWARE_PARTS } from '../utils/hardwareParts';
import { sealFindings } from '../utils/hardwareChecks';
import { hardwareList } from '../utils/hardwareList';
import {
  boxLattice, cloneLattice, createLattice, deserializeCage, orientFaces, serializeCage, toSceneGeom as latticeToSceneGeom, DEFAULT_UNIT as LATTICE_UNIT,
  type Axis as LatticeAxis, type Lattice,
} from '../utils/latticeMesh';
import type { SculptMesh, SculptUndoEntry } from '../utils/sculptMesh';
import { CAMERA_VIEWS, type CameraView } from '../utils/cameraViews';
import { getLiveDimensions } from '../utils/liveDimensions';
import type { HeadlessResult, HistoryEntry, HistoryQuery } from '../workers/physicsWorkerProtocol';

interface PhysicsWindow extends Window {
  _physics_setNoteCards?: (cards: NoteCard[]) => void;
  _physics_getNoteCards?: () => NoteCard[];
  _physics_setCopilotMessages?: (msgs: SavedCopilotMessage[]) => void;
  _physics_getCopilotMessages?: () => SavedCopilotMessage[];
  _physics_gl?: { domElement: HTMLCanvasElement; render: (scene: unknown, camera: unknown) => void };
  _physics_scene?: unknown;
  _physics_camera?: unknown;
  _physics_composer?: { render: () => void };
}

/**
 * The last few strokes on each sculpt, so they can be taken back off.
 *
 * Held here rather than in the store because it is the agent's own history:
 * a person's undo stack belongs to the editor and is driven by Ctrl-Z, and
 * mixing the two would let one of them silently swallow the other's work.
 * Capped because each entry can hold a copy of the mesh.
 */
const sculptHistory = new Map<string, SculptUndoEntry[]>();

/*
 * Commands that change a sculpt's clay run one after another, in the order
 * they arrived. Each reads the mesh, works on it (a cut or a carve in a
 * worker, for a while), and writes it back; two at once read the same mesh,
 * and the second to finish found the body changed under it and was refused
 * ("The body changed while it was being cut"), so an agent sending a face's
 * features together lost half of them. One queue for all bodies, not one per
 * body: a body named one way and id'd another would otherwise get two.
 */
const SERIAL_SCULPT_COMMANDS = new Set(['SCULPT', 'SCULPT_CUT', 'SCULPT_CARVE', 'UNDO_SCULPT', 'RESIZE_SCULPT', 'SET_SCULPT_BASE']);
let sculptQueue: Promise<unknown> = Promise.resolve();

/**
 * The last few cages of each lattice body, so an operation can be taken back off.
 *
 * Whole snapshots rather than inverse operations, as everywhere else this mode
 * keeps history: a cage is a few hundred integers, and a snapshot cannot get an
 * inverse subtly wrong. Separate from the editor's own history, so undoing over
 * MCP never swallows a person's work.
 */
const latticeHistory = new Map<string, Lattice[]>();
const LATTICE_HISTORY_DEPTH = 8;
const SCULPT_HISTORY_DEPTH = 8;

const autoCompileScad = async (nodes: SceneNode[]) => {
  const scadNodes: SceneNode[] = [];
  const collect = (nodesList: SceneNode[]) => {
    if (!nodesList) return;
    for (const node of nodesList) {
      if (node.scad) scadNodes.push(node);
      collect(node.children || []);
    }
  };
  collect(nodes);

  // These used to be compiled strictly sequentially: openscad-wasm has shared
  // global state, and running two compiles concurrently was observed to silently
  // return an empty mesh for one of them. That constraint is per-realm, and
  // compileSCAD now dispatches across a pool of workers that each get their own
  // realm - so firing them together is safe, and a scene with several scad nodes
  // compiles in parallel instead of paying the sum of every node's compile time.
  // (Within any one worker compiles are still serialized; excess nodes queue.)
  await Promise.all(scadNodes.map(async (node) => {
    // openscad-wasm has been observed to intermittently fail (throw, or return
    // empty output) on a compile immediately following another one, even when
    // run strictly sequentially with a fresh instance each time - some global
    // state in the library isn't fully torn down between calls. Retry a couple
    // of times before giving up, since a clean retry reliably succeeds.
    let compiled: { vertices: number[]; faces: number[]; renderVertices: number[] } | null = null;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3 && !compiled; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 100));
      try {
        // `collect` only ever pushes a node that has one.
        const result = await compileSCAD(node.scad!);
        // A technically-valid but empty STL (zero triangles) doesn't throw in
        // compileSCAD but is just as much a failed compile - retry it too.
        if (result.faces.length === 0) {
          lastErr = new Error('Compile produced an empty mesh (0 faces)');
          continue;
        }
        compiled = result;
      } catch (err) {
        lastErr = err;
      }
    }
    if (compiled) {
      // skipRecompile: the caller (settleScene) runs a single recompile after
      // every node is done. Without this, each node's own recompile fires an
      // unawaited MJCF/WASM build using whatever the scene looked like at that
      // moment - e.g. compiled while a later node's mesh doesn't exist yet - and
      // these overlapping builds race. Letting one of the stale/erroring ones
      // finish last silently corrupts lastCompileError even when the scene is fine.
      useStore.getState().updateNodeScad(node.id, node.scad!, compiled, true);
    } else {
      console.error(`Failed to auto-compile SCAD for node ${node.id} after 3 attempts:`, lastErr);
    }
  }));
};

// Loads a scene and waits for it to fully settle before responding: SCAD bodies
// compile asynchronously, so a caller that gets an immediate ok:true has no way
// to know whether the scene it just loaded actually built successfully. This
// awaits the whole pipeline (all scad compiles, then a single final recompile)
// and reports the real MJCF compile result instead.
const settleScene = async (
  nodes: SceneNode[],
  { replacesScene = true }: { replacesScene?: boolean } = {},
): Promise<{ ok: boolean; error?: string; nodeCount: number }> => {
  const store = useStore.getState();
  // A freshly built/replaced scene (BUILD_SCENE/UPDATE_SCENE) is never a preset
  // load, so any note card left over from a previously-loaded preset (e.g.
  // "Double Pendulum") is now describing a scene that no longer exists. Clear
  // it here rather than relying on callers to remember to. Not for a caller
  // that only adds a body to the scene (CREATE_LATTICE, IMPORT_STL): that
  // wiped the user's own notes.
  if (replacesScene) (window as unknown as PhysicsWindow)._physics_setNoteCards?.([]);
  // skipRecompile: this initial set uses placeholder (pre-scad) mesh geoms, so
  // an immediate recompile here would be both wasted work and another stale
  // build racing against the final one below.
  // A caller that only adds a body keeps what the scene says about itself:
  // print fidelity, cast prep, reference pictures, its name.
  store.updateScene(replacesScene ? { nodes } : { ...store.sceneGraph, nodes }, true);
  await autoCompileScad(nodes);
  await applyDeclarativePreCsgFeatures(nodes);
  // Boolean bodies compile through the same OpenSCAD pool, and just as
  // asynchronously — a caller that got ok:true before they finished would be
  // told a scene built when its geometry didn't exist yet. skipFinalRecompile:
  // the single build below covers it.
  await compileCsgNodes(true);
  await applyDeclarativePostCsgFeatures(nodes);
  // This is now the ONLY recompile triggered by this load, so there's nothing
  // left to race against. forceReset is false so recompile() preserves qpos/qvel
  // when the edit didn't change the DOF count (e.g. tweaking a color or adding a
  // fixed body) instead of always snapping the sim back to its initial state.
  await useStore.getState().recompile(useStore.getState().sceneGraph, undefined, false, true);
  const error = useStore.getState().lastCompileError;
  return { ok: !error, ...(error ? { error } : {}), nodeCount: nodes.length };
};

/** Every id in a scene tree, at any depth. */
function collectNodeIds(nodes: SceneNode[], into: Set<string> = new Set()): Set<string> {
  for (const node of nodes || []) {
    into.add(node.id);
    collectNodeIds(node.children || [], into);
  }
  return into;
}

/**
 * Wait for a node that was not in `before` to appear anywhere in the scene.
 *
 * The store's add path ends in a debounced recompile rather than a synchronous
 * write, and there is no promise to await, so the arrival has to be observed.
 * Polling rather than subscribing keeps this to a few lines and costs nothing:
 * the wait is milliseconds in practice.
 */
async function waitForNewNode(before: Set<string>, timeoutMs: number): Promise<SceneNode | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const nodes = useStore.getState().sceneGraph.nodes;
    const found = findNewNode(nodes, before);
    if (found) return found;
    if (Date.now() > deadline) return null;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function findNewNode(nodes: SceneNode[], before: Set<string>): SceneNode | null {
  for (const node of nodes || []) {
    if (!before.has(node.id)) return node;
    const child = findNewNode(node.children || [], before);
    if (child) return child;
  }
  return null;
}

/**
 * The sculptable mesh on a node, rebuilt from the geom arrays it is stored as.
 *
 * renderVertices, not vertices: that is the Z-up copy sculptMesh works in, and
 * the one toSceneGeom will write back.
 */
/** The editable cage on a node, or a refusal that says what to do instead. */
function latticeOf(node: SceneNode | null | undefined): Lattice {
  if (!node?.latticeCage) {
    throw new Error(`'${node?.id}' has no lattice cage`);
  }
  return deserializeCage(node.latticeCage);
}

/** Resolves an id to a lattice body and its cage, or explains why it is not one. */
function latticeTarget(store: ReturnType<typeof useStore.getState>, targetId: string): { node: SceneNode; lattice: Lattice } {
  if (!targetId) throw new Error('Missing targetId');
  const node = findNodeInScene(store.sceneGraph.nodes, targetId);
  if (!node) throw new Error(`No object with id '${targetId}'`);
  if (!node.isLattice || !node.latticeCage) {
    throw new Error(`'${targetId}' is not a lattice body — make one with physics_create_lattice. There is no conversion: the cage is the document, and a primitive, an imported mesh or a sculpt does not have one.`);
  }
  return { node, lattice: deserializeCage(node.latticeCage) };
}

function pushLatticeHistory(targetId: string, snapshot: Lattice) {
  const stack = latticeHistory.get(targetId) ?? [];
  stack.push(snapshot);
  while (stack.length > LATTICE_HISTORY_DEPTH) stack.shift();
  latticeHistory.set(targetId, stack);
}

/**
 * Writes a cage back and rebuilds the body from it.
 *
 * The version bump comes first and separately: the editor holds its own live
 * copy of the cage while it is open, and only a change of version tells it to
 * load this one rather than carry on with what it has — the same signal
 * setSculptBase sends when it swaps a mesh out.
 */
function commitLattice(node: SceneNode, lattice: Lattice) {
  const store = useStore.getState();
  store.updateNode(node.id, { latticeVersion: (node.latticeVersion ?? 1) + 1 });
  store.applyLattice(node.id, serializeCage(lattice), node.latticeSubdiv ?? 0);
}

function sculptMeshOf(node: SceneNode | null | undefined, geomIndex = sculptGeomIndex(node)) {
  const geom = node?.geoms?.[geomIndex];
  if (!geom?.renderVertices?.length || !geom?.faces?.length) {
    throw new Error(`'${node?.id}' has no sculptable mesh geom`);
  }
  return fromSceneGeom(geom.renderVertices, geom.faces);
}

/**
 * Which geom the brushes work on: a sculpt body's clay, or on any other body
 * the first mesh it carries that is not the output of a boolean - the rule the
 * inspector's "Sculpt This Mesh" button uses. -1 when there is none.
 */
function sculptGeomIndex(node: SceneNode | null | undefined): number {
  const geoms = node?.geoms ?? [];
  if (node?.isSculpt) return geoms.findIndex((g) => g.type === 'mesh');
  return geoms.findIndex((g) => g.type === 'mesh' && !g.csgDerived && !!g.renderVertices?.length && !!g.faces?.length);
}

/**
 * Resolves an id to a body the sculpt tools can work on, and the geom they
 * work on, or explains why it is not one.
 *
 * Any mesh can be brushed: a sculpt body, an imported STL, a generated scene
 * mesh, a compiled OpenSCAD part. A boolean body cannot - what it draws is
 * rebuilt from its primitives on every compile, so a stroke would last until
 * the next one - and neither can a primitive, which has no mesh to move.
 */
/**
 * Puts a cut made off-thread (scissors or carve) onto the body: refused if
 * the body changed while the worker had it, split into one body per piece if
 * it came apart, and otherwise one entry in the agent's sculpt history.
 */
/** Whether two geoms hold the same mesh: same counts, and the same values at a spread of places. */
function sameMesh(a: SceneGeom | undefined, b: SceneGeom | undefined): boolean {
  if (a === b) return true;
  const av = a?.renderVertices, bv = b?.renderVertices, af = a?.faces, bf = b?.faces;
  if (!av || !bv || !af || !bf) return false;
  if (av === bv && af === bf) return true;
  if (av.length !== bv.length || af.length !== bf.length) return false;
  const step = Math.max(1, Math.floor(av.length / 997));
  for (let i = 0; i < av.length; i += step) if (av[i] !== bv[i]) return false;
  const fstep = Math.max(1, Math.floor(af.length / 997));
  for (let i = 0; i < af.length; i += fstep) if (af[i] !== bf[i]) return false;
  return true;
}

async function applySculptCutResult(
  targetId: string,
  geomIndex: number,
  geomBefore: SceneGeom | undefined,
  mesh: SculptMesh,
  result: Awaited<ReturnType<typeof cutSculptOffThread>>,
) {
  if (!result.ok) return { ok: false, id: targetId, error: result.error };

  // The worker had it for a while; if the body changed meanwhile, the
  // cut is of a shape that no longer exists. The clay is found again by its
  // geom's name and compared by the mesh it holds: the collider pass that
  // follows every edit rewrites the node and, once the clay is concave, adds
  // its convex pieces as geoms, so the old index and the old object both
  // refused the next carve while the clay itself was untouched.
  const live = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId);
  const liveIndex = live?.geoms?.findIndex((g) => g.name === geomBefore?.name) ?? -1;
  if (!live || liveIndex < 0 || !sameMesh(live.geoms[liveIndex], geomBefore)) {
    return { ok: false, id: targetId, error: 'The body changed while it was being cut; nothing was applied.' };
  }
  geomIndex = liveIndex;

  // A cut that splits the clay makes one body per piece, as the
  // Scissors do in the viewport. That is a change to the document, so
  // it is the editor's undo that reverses it, not this history.
  const pieces = splitComponents(result.mesh);
  if (pieces.length > 1) {
    const bodies = useStore.getState().separateSculpt(targetId, pieces, geomBefore?.name);
    sculptHistory.delete(targetId);
    const error = useStore.getState().lastCompileError;
    return {
      ok: !error, ...(error ? { error } : {}), id: targetId,
      facesBefore: result.facesBefore, facesAfter: pieces[0].faceCount,
      pieces: pieces.length, bodies,
      ...sculptSummary(pieces[0]),
      undoDepth: 0,
    };
  }

  const stack = sculptHistory.get(targetId) ?? [];
  stack.push({ indices: null, positions: null, mesh });
  while (stack.length > SCULPT_HISTORY_DEPTH) stack.shift();
  sculptHistory.set(targetId, stack);

  // Metadata first, geometry second — see SCULPT.
  const latest = useStore.getState();
  latest.updateNode(targetId, { sculptEdited: true, sculptVersion: (live.sculptVersion ?? 1) + 1 });
  const { vertices, renderVertices, faces } = toSceneGeom(result.mesh);
  latest.updateNodeGeom(targetId, { vertices, renderVertices, faces }, geomIndex);

  const error = useStore.getState().lastCompileError;
  return {
    ok: !error, ...(error ? { error } : {}), id: targetId,
    facesBefore: result.facesBefore, facesAfter: result.facesAfter, pieces: result.pieces,
    ...sculptSummary(result.mesh),
    undoDepth: stack.length,
  };
}

function sculptTarget(store: ReturnType<typeof useStore.getState>, targetId: string): { node: SceneNode; geomIndex: number } {
  if (!targetId) throw new Error('Missing targetId');
  const node = findNodeInScene(store.sceneGraph.nodes, targetId);
  if (!node) throw new Error(`No object with id '${targetId}'`);
  if (node.csgEnabled && !node.isSculpt) {
    throw new Error(`'${targetId}' is a boolean body: its mesh is rebuilt from its primitives on every change, so a stroke would not last. Brush a sculpt body or a mesh instead.`);
  }
  const geomIndex = sculptGeomIndex(node);
  if (geomIndex < 0) {
    throw new Error(`'${targetId}' has no mesh to sculpt - a primitive (box, sphere, cylinder...) is not one. Start from physics_create_sculpt, or import the shape with physics_import_stl.`);
  }
  return { node, geomIndex };
}

/**
 * A message with the fields one command's schema documents named at their
 * types. Everything else stays `unknown`, which is how it arrives: a message is
 * parsed JSON.
 *
 * This says what a command expects once, at the top of its case, instead of at
 * every use of every field. It asserts rather than checks, deliberately — each
 * handler already validates what it needs, and re-checking here would turn a
 * malformed field into a missing one, which is a different answer from the one
 * a caller gets today.
 */
type Msg<T> = Record<string, unknown> & T;

/**
 * A parameter the dialogs no longer offer, refused rather than ignored, so an
 * agent that still sends it hears what to do instead. `harmless` is the value
 * that asks for nothing: older servers send stockThicknessMm 0 on every call,
 * and 0 always meant "size it to the part".
 */
function refuseRetired(msg: Record<string, unknown>, retired: Record<string, [string, unknown]>): void {
  for (const [key, [instead, harmless]] of Object.entries(retired)) {
    if (msg[key] !== undefined && msg[key] !== harmless) throw new Error(`${key} is no longer taken. ${instead}`);
  }
}

const RESIZE_INSTEAD =
  'Parts are cut at their modelled size, as in the dialog: resize the part in the scene (physics_update_object).';

/**
 * The relief job an MCP command plans: the dialog's last plan if there is one,
 * else the scene's and the bench's, with the command's own overrides on top.
 * Shared by EXPORT_RELIEF and ADD_SIMULATION, so a simulation is of the
 * program the export would hand over.
 */
function reliefOptionsFor(msg: Record<string, unknown>): { options: ReliefCarveOptions; fromDialog: boolean } {
  refuseRetired(msg, { scalePercent: [RESIZE_INSTEAD, 100] });
  const store = useStore.getState();
  const motion = webSerialManager.getState().motion;
  const dialog = lastReliefOptions();
  const base: ReliefCarveOptions = dialog
    ? { ...DEFAULT_RELIEF_OPTIONS, ...dialog }
    : {
        ...DEFAULT_RELIEF_OPTIONS,
        ...APP_RELIEF_DEFAULTS,
        ...store.carveSettings,
        stockWidthMm: store.stock.widthMm,
        stockDepthMm: store.stock.depthMm,
        stockThicknessMm: store.stock.thicknessMm,
        material: store.material,
      };
  const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : undefined);
  const shape = msg.finishingToolType === 'flat' || msg.finishingToolType === 'ball_nose' || msg.finishingToolType === 'v_bit'
    ? msg.finishingToolType
    : undefined;
  const asked: Partial<ReliefCarveOptions> = {
    ...(num(msg.roughingToolDiaMm) ? { roughingToolDiaMm: num(msg.roughingToolDiaMm) } : {}),
    ...(num(msg.finishingToolDiaMm) ? { finishingToolDiaMm: num(msg.finishingToolDiaMm) } : {}),
    ...(shape ? { finishingToolType: shape } : {}),
    ...(num(msg.carveDepthMm) ? { carveDepthMm: num(msg.carveDepthMm) } : {}),
    ...(typeof msg.material === 'string' ? { material: msg.material as ReliefCarveOptions['material'] } : {}),
    ...(msg.roughingStrategy === 'adaptive' || msg.roughingStrategy === 'raster' ? { roughingStrategy: msg.roughingStrategy } : {}),
    ...(typeof msg.roughingEnabled === 'boolean' ? { roughingEnabled: msg.roughingEnabled } : {}),
    ...(num(msg.stockWidthMm) ? { stockWidthMm: num(msg.stockWidthMm) } : {}),
    ...(num(msg.stockDepthMm) ? { stockDepthMm: num(msg.stockDepthMm) } : {}),
    ...(num(msg.stockThicknessMm) ? { stockThicknessMm: num(msg.stockThicknessMm) } : {}),
    ...(['auto', 'model', 'fill', 'proportional'].includes(msg.verticalScaleMode as string)
      ? { verticalScaleMode: msg.verticalScaleMode as ReliefCarveOptions['verticalScaleMode'] }
      : {}),
    ...(num(msg.verticalExaggeration) ? { verticalExaggeration: num(msg.verticalExaggeration) } : {}),
    // 'actual' is the dialog's Actual Size; 'manual' is its old name.
    ...(msg.fitMode === 'fit' ? { fitMode: 'fit' as const } : {}),
    ...(msg.fitMode === 'actual' || msg.fitMode === 'manual' ? { fitMode: 'manual' as const } : {}),
    ...(['auto', 'carve', 'skip'].includes(msg.backgroundMode as string)
      ? { backgroundMode: msg.backgroundMode as ReliefCarveOptions['backgroundMode'] }
      : {}),
  };
  const merged: ReliefCarveOptions = { ...base, ...asked, scalePercent: 100 };
  // The dialog's feeds stand, overrides and all, unless what they were
  // worked out for has been changed here.
  const rederive = !dialog || ['roughingToolDiaMm', 'finishingToolDiaMm', 'carveDepthMm', 'material']
    .some((k) => k in asked);
  const options: ReliefCarveOptions = {
    ...merged,
    ...(rederive
      ? deriveReliefFeeds(merged, motion.spindle, Math.min(motion.maxRate.x, motion.maxRate.y))
      : {}),
    motionProfile: motion,
    // The probed bed belongs to the dialog's session at the machine.
    meshLevelGrid: null,
    applyMeshLeveling: false,
  };
  return { options, fromDialog: !!dialog };
}

/**
 * `setups` as an agent may send it: 'auto', 1 or 2, or the faces to cut from
 * as a list or a comma-separated string ('+z,+x,-x'), named as the block
 * stands for setup 1. Anything else is left out, which keeps `sides`.
 */
function parseSetups(v: unknown): SolidMachiningOptions['setups'] | undefined {
  if (v === 'auto') return 'auto';
  if (v === 1 || v === '1') return 1;
  if (v === 2 || v === '2') return 2;
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
  if (!list) return undefined;
  const faces = list.map((f) => String(f).trim().toLowerCase()).filter((f): f is BlockFace => (BLOCK_FACES as string[]).includes(f));
  return faces.length > 0 ? faces : undefined;
}

/** The solid-machining job an MCP command plans. Shared by EXPORT_MACHINING and ADD_SIMULATION. */
function machiningOptionsFor(msg: Record<string, unknown>, scene: SceneGraph) {
  const dia = typeof msg.toolDiaMm === 'number' && msg.toolDiaMm > 0 ? msg.toolDiaMm : 3;
  // Feeds, speeds and stepdowns worked out for the material and the
  // connected machine, as the dialog does; DEFAULT_SOLID_OPTIONS alone is
  // a wood recipe whatever material is named.
  const motion = webSerialManager.getState().motion;
  const boardInstead =
    'The stock is the bench board, as in the dialog: set it with physics_set_environment.';
  refuseRetired(msg, {
    scalePercent: [RESIZE_INSTEAD, 100],
    stockWidthMm: [boardInstead, 0],
    stockDepthMm: [boardInstead, 0],
    stockThicknessMm: [boardInstead, 0],
  });
  const setups = parseSetups(msg.setups);
  const options = deriveSolidOptions(scene, {
    scalePercent: 100,
    board: useStore.getState().stock,
    stockWidthMm: 0,
    stockDepthMm: 0,
    stockThicknessMm: 0,
    ...(typeof msg.sides === 'number' ? { sides: msg.sides } : {}),
    ...(setups !== undefined ? { setups } : {}),
    ...(typeof msg.clearanceMm === 'number' ? { clearanceMm: msg.clearanceMm } : {}),
    ...(typeof msg.toolStickoutMm === 'number' ? { toolStickoutMm: msg.toolStickoutMm } : {}),
    ...(typeof msg.material === 'string' ? { material: msg.material } : {}),
    ...(msg.finishingToolType === 'flat' || msg.finishingToolType === 'ball_nose' || msg.finishingToolType === 'v_bit'
      ? { finishingToolType: msg.finishingToolType }
      : {}),
    roughingToolDiaMm: dia,
    finishingToolDiaMm: dia,
  } as Parameters<typeof deriveSolidOptions>[1], motion.spindle, Math.min(motion.maxRate.x, motion.maxRate.y));
  return options;
}

/**
 * `at` as the list of points it stands for: one point, or a list of them.
 *
 * Only decides which of those two shapes was sent; whether the points are
 * points at all is the caller's own check, immediately below every use.
 */
const pointList = (v: unknown): number[][] =>
  (Array.isArray(v) && Array.isArray(v[0]) ? v : [v]) as number[][];

/**
 * Where a new body asked to go under `parent` (an id or a name) lands: the
 * parent's real id, and whether it or anything above it has a joint. Throws
 * when there is no such body, rather than quietly adding at the top level.
 */
const resolveParent = (nodes: SceneNode[], parent: unknown): { id: string; moves: boolean } | null => {
  if (parent === undefined || parent === null || parent === '') return null;
  if (typeof parent !== 'string') throw new Error('parent must be the id or name of an existing body');
  const walk = (list: SceneNode[], aboveMoves: boolean): { id: string; moves: boolean } | null => {
    for (const n of list || []) {
      const moves = aboveMoves || (n.joints?.length ?? 0) > 0 || n.isComposite === true;
      if (n.id === parent || n.name === parent) return { id: n.id, moves };
      const found = walk(n.children || [], moves);
      if (found) return found;
    }
    return null;
  };
  const found = walk(nodes, false);
  if (!found) throw new Error(`No body '${parent}' to put the new one under`);
  return found;
};

/** The scene with `child` appended to the children of `parentId`, copied along the path. */
const withChild = (nodes: SceneNode[], parentId: string, child: SceneNode): SceneNode[] =>
  nodes.map((n) => n.id === parentId
    ? { ...n, children: [...(n.children || []), child] }
    : n.children?.length ? { ...n, children: withChild(n.children, parentId, child) } : n);

const findNodeInScene = (nodes: SceneNode[], id: string): SceneNode | null => {
  for (const node of nodes || []) {
    if (node.id === id || node.name === id) return node;
    const child = findNodeInScene(node.children || [], id);
    if (child) return child;
  }
  return null;
};

const bboxOf = (flatVerts: number[] | undefined) => {
  if (!flatVerts || flatVerts.length === 0) return undefined;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < flatVerts.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = flatVerts[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max };
};

/**
 * Whether a mesh geom actually encloses anything.
 *
 * physics_get_lattice and physics_get_sculpt have always reported `watertight`,
 * and a raw mesh geom reported nothing at all — so a mesh assembled by hand out
 * of pieces could be full of open rims and inside-out triangles and every reply
 * would happily describe it by its vertex count and bounding box. That is a
 * scene which renders perfectly and exports as nothing, and it is not the kind
 * of thing anybody spots by looking.
 *
 * The three checks live in utils/meshIntegrity.ts, because the MJCF compiler
 * asks the same questions of the same mesh for a different reason — whether
 * MuJoCo can integrate its true volume for its mass — and the two must not
 * drift apart on what "closed" means.
 */
function meshIntegrity(g: SceneGeom): Record<string, unknown> {
  const faces = g.faces || [];
  const pos = g.renderVertices || g.vertices || [];
  const triangles = faces.length / 3;
  if (!triangles || !pos.length) return {};
  const m = analyzeMesh(pos, faces);
  if (!m) return { watertight: 'not checked — too many triangles' };
  return {
    watertight: m.closed,
    ...(m.boundaryEdges ? { boundaryEdges: m.boundaryEdges } : {}),
    ...(m.nonManifoldEdges ? { nonManifoldEdges: m.nonManifoldEdges } : {}),
    ...(m.degenerateTriangles ? { degenerateTriangles: m.degenerateTriangles } : {}),
    ...(m.closed && m.volume < 0 ? { windingInverted: true } : {}),
    // The case signed volume cannot see: some faces one way, some the other.
    ...(m.closed && !m.consistentlyWound ? { windingMixed: true } : {}),
  };
}

/**
 * The bench stock against the design: the board every carve uses, and how the
 * scene's footprint and height compare with it, in plain numbers. Makers think
 * of their oak as stock, not as part of the design, and "the design is 5 mm
 * wider than your stock" is the sentence that saves the board.
 */
function stockReport(scene: SceneGraph, stock: { widthMm: number; depthMm: number; thicknessMm: number }) {
  const design = scene.nodes?.length ? measurePart(scene, '+z', 100) : null;
  if (!design) return { ...stock };
  const r = (v: number) => Math.round(v * 10) / 10;
  const over: string[] = [];
  if (design.x > stock.widthMm + 0.5) over.push(`${r(design.x - stock.widthMm)} mm wider`);
  if (design.y > stock.depthMm + 0.5) over.push(`${r(design.y - stock.depthMm)} mm deeper`);
  if (design.z > stock.thicknessMm + 0.05) over.push(`${r(design.z - stock.thicknessMm)} mm taller`);
  // A design of several parts is usually cut one part at a time, and the box
  // round the assembly says nothing about whether each fits. The machining
  // export does take the whole scene, so that figure stays; each part's comes
  // beside it, turned 90° on the board if that is what it takes.
  const parts = (scene.nodes?.length ?? 0) > 1
    ? scene.nodes.flatMap((n) => {
        const m = measurePart({ ...scene, nodes: [n] }, '+z', 100);
        if (!m) return [];
        const fitsPlan = (m.x <= stock.widthMm + 0.5 && m.y <= stock.depthMm + 0.5)
          || (m.y <= stock.widthMm + 0.5 && m.x <= stock.depthMm + 0.5);
        const fits = fitsPlan && m.z <= stock.thicknessMm + 0.05;
        return [{ id: n.id, sizeMm: { width: r(m.x), depth: r(m.y), height: r(m.z) }, fits }];
      })
    : [];
  const misfits = parts.filter((p) => !p.fits).map((p) => p.id);
  return {
    ...stock,
    designMm: { width: r(design.x), depth: r(design.y), height: r(design.z) },
    fits: over.length === 0,
    ...(over.length ? { note: `The design is ${over.join(', ')} than your stock.` } : {}),
    ...(parts.length ? {
      parts,
      partsNote: misfits.length
        ? `On its own, ${misfits.join(', ')} ${misfits.length === 1 ? 'does' : 'do'} not fit the stock. designMm is the whole scene, which is what physics_export_machining cuts as one piece.`
        : 'Each part fits the stock on its own. designMm is the whole scene, which is what physics_export_machining cuts as one piece.',
    } : {}),
  };
}

/**
 * How a body actually reaches the contact solver.
 *
 * Worth reporting on every body with a mesh, not just one someone asked about:
 * "collides as its convex hull" is the difference between a cup and a solid
 * billet, and it is not visible in a screenshot or a vertex count. An agent that
 * drops a ball into a container and watches it rest on thin air has no other way
 * to find out why.
 */
function collisionReport(node: SceneNode): Record<string, unknown> {
  const colliders = (node.geoms || []).filter(g => g.csgDerived === 'collider');
  if (colliders.length > 0) {
    return {
      collidesAs: `${colliders.length} convex pieces`,
      ...(node.collisionSolidity !== undefined ? { solidity: node.collisionSolidity } : {}),
      // Slots and recesses a piece fills in, which the piece count hides.
      ...(node.collisionCavities?.length ? { cavitiesFilled: node.collisionCavities } : {}),
      ...(node.collisionWarning ? { collisionWarning: node.collisionWarning } : {}),
    };
  }
  if (solidMeshGeoms(node).length === 0) return {};
  const filled = node.collisionSolidity !== undefined && node.collisionSolidity < SOLIDITY_DECOMPOSE_BELOW;
  return {
    collidesAs: 'convex hull',
    ...(node.collisionSolidity !== undefined ? { solidity: node.collisionSolidity } : {}),
    ...(filled ? { cavityFilled: 'This body is hollow but collides as its convex hull, so its cavity is solid to contact.' } : {}),
    ...(node.collisionWarning ? { collisionWarning: node.collisionWarning } : {}),
    ...(node.collisionError ? { collisionError: node.collisionError } : {}),
  };
}

const summarizeGeom = (g: SceneGeom) => ({
  name: g.name,
  type: g.type,
  ...(g.csg && g.csg !== 'union' ? { csg: g.csg } : {}),
  ...(g.csgDerived ? { generated: g.csgDerived } : {}),
  ...(g.pos ? { pos: g.pos } : {}),
  ...(g.type === 'mesh'
    ? {
        vertCount: (g.renderVertices || g.vertices || []).length / 3,
        faceCount: (g.faces || []).length / 3,
        bbox: bboxOf(g.renderVertices || g.vertices),
        ...meshIntegrity(g),
      }
    : { size: g.size }),
});

/*
 * What the solver uses for a body, read back from the compiled model rather
 * than worked out from the graph: densities, hand-set masses, convex pieces
 * standing in for a concave mesh and dropped source meshes all end up here,
 * and a dynamic test was the only other way to check them. The centre of mass
 * and the principal axes are in the body's own frame.
 */
const inertialOf = (model: ModelMirror | null, node: SceneNode): Record<string, unknown> | null => {
  const bId = model?._idMaps?.body?.[node.id];
  if (bId === undefined || bId < 0 || !model?.body_mass) return null;
  const r = (v: number, d: number) => +v.toPrecision(d);
  const out: Record<string, unknown> = { massKg: r(model.body_mass[bId], 6) };
  if (model.body_ipos) out.comMm = [0, 1, 2].map(i => +(model.body_ipos![bId * 3 + i] * 1000).toFixed(3));
  if (model.body_inertia) out.principalInertiaKgM2 = [0, 1, 2].map(i => r(model.body_inertia![bId * 3 + i], 6));
  if (model.body_iquat) out.principalAxesQuat = [0, 1, 2, 3].map(i => +model.body_iquat![bId * 4 + i].toFixed(6));
  return out;
};

const summarizeNode = (node: SceneNode, model: ModelMirror | null = null): Record<string, unknown> => ({
  id: node.id,
  name: node.name,
  pos: node.pos,
  ...((i) => i ? { inertial: i } : {})(inertialOf(model, node)),
  ...(node.quat ? { quat: node.quat } : {}),
  ...(node.euler ? { euler: node.euler } : {}),
  ...(node.scad ? { hasScad: true } : {}),
  ...(node.csgEnabled ? {
    csg: {
      collision: collisionModeOf(node),
      ...(node.csgVolume !== undefined ? { volumeM3: +node.csgVolume.toFixed(8) } : {}),
      /*
       * How far the drawn solid sits from the frame its shapes were written in.
       *
       * A compiled boolean is re-origined on its own centre of mass in X and Y,
       * so a plate drawn symmetric about x=0 with a hole near one edge DRAWS a
       * few millimetres off centre — 4.5 mm, for a 200 mm plate with a 60 mm
       * bore at x=60. Sizes and the distances between features are unaffected;
       * only the mapping from these coordinates to world space is.
       *
       * It was not reported anywhere, so a caller measuring the drawn part and
       * then cutting at what it measured put the cut in the wrong place. It is
       * reported here for the same reason latticeOrigin is: it is the number you
       * need to convert, and nothing else will tell you it.
       */
      ...(node.csgCentroid ? { originOffsetMm: csgFrameOffset(node).map(v => +(v * 1000).toFixed(3)) } : {}),
      ...(node.csgWarning ? { warning: node.csgWarning } : {}),
      ...(node.csgError ? { error: node.csgError } : {}),
    },
  } : {}),
  ...(node.csgEnabled ? {} : collisionReport(node)),
  ...(node.printPose ? { printPose: { up: node.printPose.up, spinDeg: +(node.printPose.spin * 180 / Math.PI).toFixed(2) } } : {}),
  joints: (node.joints || []).map((j) => ({ name: j.name, type: j.type })),
  // A split section carries dozens of exact pin and socket colliders; listing
  // each one would bury the geoms that matter, so they are counted instead.
  geoms: (node.geoms || []).filter((g) => !g.contactClass).map(summarizeGeom),
  ...((node.geoms || []).some((g) => g.contactClass) ? {
    exactColliders: {
      pins: (node.geoms || []).filter((g) => g.contactClass === 'pin').length,
      sockets: (node.geoms || []).filter((g) => g.contactClass === 'socket').length,
    },
  } : {}),
  children: (node.children || []).map((c) => summarizeNode(c, model)),
});

const stripMeshArrays = (node: SceneNode): SceneNode => {
  const cloned = { ...node };
  if (cloned.geoms) {
    cloned.geoms = cloned.geoms.map((g) => {
      const rest = { ...g };
      delete rest.vertices;
      delete rest.faces;
      delete rest.renderVertices;
      delete rest.colliderVertices;
      delete rest.colliderFaces;
      // A text pattern's saved letter outlines are kilobytes of coordinates.
      if (rest.textures?.some((t) => t.options?.outline)) {
        rest.textures = rest.textures.map((t) => {
          if (!t.options?.outline) return t;
          const { outline: _outline, outlineSig: _sig, imageGrid: _grid, ...options } = t.options;
          return { ...t, options };
        });
      }
      return rest;
    });
  }
  if (cloned.children) {
    cloned.children = cloned.children.map(stripMeshArrays);
  }
  return cloned;
};

// Shared by BUILD_SCENE and UPDATE_SCENE: fills in the fields compileToMJCF's
// buildNode() unconditionally calls .forEach on (joints, geoms, children).
// UPDATE_SCENE used to skip this and pass nodes straight through, so any
// hand-authored node missing one of those fields (e.g. a leaf body with no
// `children` at all) crashed recompile with a bare "Cannot read properties
// of undefined (reading 'forEach')" and no indication of which field or node
// was at fault.
// A mesh geom on a jointed body has to be dynamic:true or it renders from
// vertices baked once into world space and never reads data.xpos/data.xmat
// again — the body simulates and drags correctly, it just looks frozen in
// place on screen. That is exactly the trap californiaRelief.ts and
// megaBustStudio.ts fell into by hand-authoring mesh geoms without it, so an
// agent supplying a mesh geom on a jointed body gets it defaulted here rather
// than needing to know the field exists. renderVertices is auto-derived from
// vertices (Y-up -> MuJoCo Z-up: (x,y,z)->(x,-z,y)) when the caller hasn't
// supplied one, for the same reason: it's a pure function of vertices, not a
// real second thing to author.
const toRenderVertices = (vertices: number[]): number[] => {
  const out = new Array(vertices.length);
  for (let i = 0; i < vertices.length; i += 3) {
    out[i] = vertices[i];
    out[i + 1] = -vertices[i + 2];
    out[i + 2] = vertices[i + 1];
  }
  return out;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface LatticeOpSpec extends Record<string, any> {
  op?: string;
  type?: string;
  kind?: string;
}

export function runLatticeOps(
  lattice: Lattice,
  ops: LatticeOpSpec[],
  initialSubdiv = 0,
  initialThicknessMm = 0,
): { subdiv: number; thicknessMm: number; results: Record<string, unknown>[] } {
  let subdiv = Math.max(0, Math.min(2, Math.round(Number(initialSubdiv) || 0)));
  let thicknessMm = Math.max(0, Number(initialThicknessMm) || 0);
  const results: Record<string, unknown>[] = [];
  for (const item of ops || []) {
    if (!item || typeof item !== 'object') continue;
    const opName = String(item.op ?? item.type ?? item.kind ?? '').toLowerCase();
    switch (opName) {
      case 'extrude': {
        const d = Number(item.distanceMm ?? item.amountMm ?? 10);
        results.push({ op: 'extrude', ...extrudeMm(lattice, item.face, d, item.axis as LatticeAxis | undefined, item.mirror as LatticeAxis | undefined) });
        break;
      }
      case 'inset': {
        const amt = Number(item.amountMm ?? item.distanceMm ?? 5);
        results.push({ op: 'inset', ...insetFaceMm(lattice, item.face, amt, item.mirror as LatticeAxis | undefined) });
        break;
      }
      case 'bevel': {
        const amt = Number(item.amountMm ?? item.distanceMm ?? 5);
        results.push({ op: 'bevel', ...bevelFaceMm(lattice, item.face, amt, item.mirror as LatticeAxis | undefined) });
        break;
      }
      case 'bevel_edges':
      case 'beveledges': {
        const rad = Number(item.radiusMm ?? item.amountMm ?? item.sizeMm ?? 3);
        const mode = item.mode === 'fillet' || item.mode === 'round' ? 'fillet' : 'chamfer';
        results.push({ op: 'bevel_edges', ...bevelEdgesMm(lattice, item.edges, rad, mode, item.mirror as LatticeAxis | undefined, item.loop === true) });
        break;
      }
      case 'faces':
      case 'add_faces':
      case 'addfaces': {
        results.push({ op: 'faces', ...addFacesMm(lattice, item.faces, item.mirror as LatticeAxis | undefined) });
        break;
      }
      case 'delete_faces':
      case 'deletefaces':
      case 'remove_faces': {
        results.push({ op: 'delete_faces', ...removeFacesMm(lattice, item.faces, item.mirror as LatticeAxis | undefined) });
        break;
      }
      case 'sharpen': {
        results.push({ op: 'sharpen', ...sharpenEdgesMm(lattice, item.edges, item.sharp !== false, item.mirror as LatticeAxis | undefined, item.loop === true) });
        break;
      }
      case 'circle':
      case 'ring': {
        results.push({
          op: 'circle',
          ...addRingMm(
            lattice,
            item.centre ?? item.center,
            Number(item.diameterMm ?? 10),
            (item.axis as LatticeAxis) || 'z',
            typeof item.sides === 'number' ? item.sides : 0,
            item.mirror as LatticeAxis | undefined,
          ),
        });
        break;
      }
      case 'revolve': {
        results.push({
          op: 'revolve',
          ...revolveMm(
            lattice,
            item.profile,
            (item.axis as LatticeAxis) || 'z',
            typeof item.degrees === 'number' ? item.degrees : 360,
            {
              throughMm: Array.isArray(item.throughMm) ? item.throughMm : undefined,
              segments: typeof item.segments === 'number' ? item.segments : 0,
              closed: item.closed === true,
            },
          ),
        });
        break;
      }
      case 'bridge': {
        results.push({ op: 'bridge', ...bridgeFacesMm(lattice, item.faceA, item.faceB) });
        break;
      }
      case 'dimension': {
        const which = (item.axis === 'x' || item.axis === 'y' || item.axis === 'z') ? item.axis : 'x';
        const how = item.mode === 'position' ? 'position' : 'size';
        results.push({ op: 'dimension', ...dimensionSelectionMm(lattice, item.corners, which, how, Number(item.valueMm ?? 10)) });
        break;
      }
      case 'orient': {
        results.push({ op: 'orient', flipped: orientFaces(lattice) });
        break;
      }
      case 'smooth': {
        subdiv = Math.max(0, Math.min(2, Math.round(Number(item.level ?? item.subdiv ?? 1))));
        results.push({ op: 'smooth', level: subdiv });
        break;
      }
      case 'wall': {
        thicknessMm = Math.max(0, Number(item.thicknessMm ?? 0));
        results.push({ op: 'wall', thicknessMm });
        break;
      }
      default:
        throw new Error(
          `Unknown lattice op '${opName}'. Valid ops: extrude, inset, bevel, bevel_edges, faces, delete_faces, sharpen, circle, revolve, bridge, dimension, orient, smooth, wall`
        );
    }
  }
  return { subdiv, thicknessMm, results };
}

interface PendingDeclarativeOps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sculptCuts?: Record<string, any>[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cuts?: Record<string, any>[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  roundEdges?: Record<string, any>[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  patterns?: Record<string, any>[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  paint?: Record<string, any>[];
}

const pendingDeclarativeOps = new Map<string, PendingDeclarativeOps>();

const normalizeRgba = (
  rgba: number[] | undefined,
  fallbackAlpha = 1,
): [number, number, number, number] | undefined => {
  if (!Array.isArray(rgba) || rgba.length < 3) return undefined;
  return [
    Number(rgba[0]) || 0,
    Number(rgba[1]) || 0,
    Number(rgba[2]) || 0,
    rgba[3] !== undefined ? Number(rgba[3]) : fallbackAlpha,
  ];
};

export const fillGeomDefaults = (rawG: RawGeom, bodyName: string, idx: number, bodyIsJointed: boolean): SceneGeom => {
  const g: RawGeom = { ...rawG };
  normalizeMeshGeomData(g);
  const isMesh = (g.type ?? 'box') === 'mesh';
  const dynamic = g.dynamic !== undefined ? g.dynamic : (isMesh ? true : (bodyIsJointed ? undefined : undefined));
  const renderVertices = g.renderVertices !== undefined
    ? g.renderVertices
    : (dynamic && Array.isArray(g.vertices) ? toRenderVertices(g.vertices) : undefined);
  return {
    // Everything the caller wrote is kept, and only what needs a default is
    // filled in. This was a whitelist, which fell behind the schema: density,
    // margin, gap, paint, thread and the dent and pierce fields were dropped
    // without a word, so a documented `density: 700` weighed as water.
    ...(g as SceneGeom),
    name:    g.name    ?? `${bodyName}_geom_${idx}`,
    type:    g.type    ?? 'box',
    size:    g.size    ?? [0.25, 0.25, 0.25],
    rgba:    normalizeRgba(g.rgba) ?? [0.6, 0.6, 0.9, 1],
    ...(g.pos         !== undefined ? { pos: g.pos }         : {}),
    ...(g.quat        !== undefined ? { quat: g.quat }       : {}),
    ...(g.euler       !== undefined ? { euler: g.euler }     : {}),
    ...(g.fromto      !== undefined ? { fromto: g.fromto }   : {}),
    ...(g.mass        !== undefined ? { mass: g.mass }       : {}),
    ...(g.friction    !== undefined ? { friction: g.friction }: {}),
    ...(g.contype     !== undefined ? { contype: g.contype } : {}),
    ...(g.conaffinity !== undefined ? { conaffinity: g.conaffinity } : {}),
    ...(g.condim      !== undefined ? { condim: g.condim }   : {}),
    ...(g.solref      !== undefined ? { solref: g.solref }   : {}),
    ...(g.solimp      !== undefined ? { solimp: g.solimp }   : {}),
    ...(g.vertices    !== undefined ? { vertices: g.vertices }: {}),
    ...(g.faces       !== undefined ? { faces: g.faces }     : {}),
    ...(dynamic         !== undefined ? { dynamic } : {}),
    ...(renderVertices  !== undefined ? { renderVertices } : {}),
    ...(g.csg         !== undefined ? { csg: g.csg }           : {}),
    ...(g.role        !== undefined ? { role: g.role }         : {}),
  };
};

const GEOM_SHAPE_KEYS = [
  'type', 'size', 'fromto', 'vertices', 'verticesZUp', 'renderVertices',
  'radius', 'width', 'height', 'depth', 'polygon', 'profile',
  'majorRadius', 'minorRadius', 'tubeRadius', 'innerRadius', 'outerRadius',
] as const;

const GEOM_STRUCTURAL_KEYS = [
  ...GEOM_SHAPE_KEYS, 'faces', 'pos', 'quat', 'euler', 'csg', 'thread',
] as const;

/**
 * Merges `updates.geoms` against `target.geoms` for `physics_update_object`.
 *
 * A partial geom (such as `{ name, rgba }` or `{ rgba }`) merges into the
 * matching existing geom rather than replacing it with a default 0.25 m box;
 * if a partial geom names a geom that does not exist on the body, the call is
 * rejected instead of silently destroying the body's geometry.
 */
export function resolveUpdatedGeoms(
  target: SceneNode,
  rawGeoms: RawGeom[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updates: Record<string, any> = {},
): { ok: true; geoms: SceneGeom[] } | { ok: false; error: string } {
  const existingGeoms = target.geoms ?? [];
  const authoredGeoms = existingGeoms.filter((g) => !g.csgDerived);
  const indexableGeoms = authoredGeoms.length > 0 ? authoredGeoms : existingGeoms;
  const moves = (updates.joints ?? target.joints ?? []).length > 0;
  const bodyName = updates.name ?? target.name ?? target.id;
  const bodyRgba = normalizeRgba(updates.rgba);

  const resolvedList: SceneGeom[] = [];
  const matchedMap = new Map<SceneGeom, SceneGeom>();
  let allPartialPatches = rawGeoms.length > 0;
  let anyStructuralChange = false;

  for (let i = 0; i < rawGeoms.length; i++) {
    const g = rawGeoms[i] ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gAny = g as Record<string, any>;
    const hasOwnShape = GEOM_SHAPE_KEYS.some((k) => gAny[k] !== undefined);
    const hasStructural = GEOM_STRUCTURAL_KEYS.some((k) => gAny[k] !== undefined);
    if (hasStructural) anyStructuralChange = true;

    let existing: SceneGeom | undefined;
    if (typeof g.name === 'string' && g.name.length > 0) {
      existing = existingGeoms.find((eg) => eg.name === g.name);
      if (!existing && !hasOwnShape) {
        const known = indexableGeoms.map((eg) => eg.name).join(', ') || 'none';
        return {
          ok: false,
          error: `Object "${target.id}" has no geom named "${g.name}" (existing geoms: ${known}). Pass an existing geom name to update it, or specify type and size for a new geom.`,
        };
      }
    } else if (!hasOwnShape) {
      existing = indexableGeoms[i];
      if (!existing) {
        return {
          ok: false,
          error: `Partial geom at index ${i} has no type or size, and object "${target.id}" has no existing geom at index ${i} to merge into.`,
        };
      }
    } else if (g.name === undefined && g.type === undefined && indexableGeoms[i]) {
      existing = indexableGeoms[i];
    }

    if (existing) {
      const changesType = g.type !== undefined && g.type !== existing.type;
      const changesVertices =
        gAny.vertices !== undefined ||
        gAny.verticesZUp !== undefined ||
        gAny.renderVertices !== undefined ||
        gAny.polygon !== undefined ||
        gAny.profile !== undefined;
      if (g.type !== undefined) allPartialPatches = false;

      let resolved: SceneGeom;
      if (!changesType && !changesVertices && existing.type === 'mesh') {
        const nextRgba = g.rgba !== undefined
          ? normalizeRgba(g.rgba, existing.rgba?.[3] ?? 1)
          : (bodyRgba ?? existing.rgba);
        resolved = {
          ...existing,
          ...(g as Partial<SceneGeom>),
          ...(nextRgba ? { rgba: nextRgba } : {}),
        };
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const base: RawGeom & Record<string, any> = { ...existing, ...g };
        if (gAny.verticesZUp !== undefined) {
          delete base.vertices;
          delete base.renderVertices;
        } else if (gAny.vertices !== undefined && gAny.renderVertices === undefined) {
          delete base.renderVertices;
        } else if (gAny.renderVertices !== undefined && gAny.vertices === undefined) {
          delete base.vertices;
        }
        if (changesType && g.type !== 'mesh') {
          delete base.vertices;
          delete base.faces;
          delete base.renderVertices;
          delete base.baseVertices;
          delete base.baseRenderVertices;
          delete base.paint;
        }
        if (g.rgba === undefined && bodyRgba !== undefined) base.rgba = bodyRgba;
        resolved = fillGeomDefaults(base, bodyName, i, moves);
      }
      resolvedList.push(resolved);
      matchedMap.set(existing, resolved);
    } else {
      allPartialPatches = false;
      const base: RawGeom = { ...g };
      if (base.rgba === undefined && bodyRgba !== undefined) base.rgba = bodyRgba;
      resolvedList.push(fillGeomDefaults(base, bodyName, i, moves));
    }
  }

  // When every entry was a partial patch onto an existing geom (e.g.
  // `geoms: [{ name: 'pumpkin_sculpt', rgba: [...] }]`), update those geoms in
  // place so sibling geoms and non-stale convex colliders on the body are kept.
  if (allPartialPatches && matchedMap.size === rawGeoms.length) {
    const baseList = anyStructuralChange
      ? existingGeoms.filter((eg) => eg.csgDerived !== 'collider')
      : existingGeoms;
    return {
      ok: true,
      geoms: baseList.map((eg) => matchedMap.get(eg) ?? eg),
    };
  }

  return { ok: true, geoms: resolvedList };
}

const fillJointDefaults = (j: RawJoint, bodyName: string, idx: number): SceneJoint => ({
  // As for geoms: springref and the crumple fields were dropped by a whitelist.
  ...(j as SceneJoint),
  name:    j.name    ?? `${bodyName}_joint_${idx}`,
  type:    j.type    ?? 'free',
  ...(j.axis     !== undefined ? { axis: j.axis }         : {}),
  ...(j.pos      !== undefined ? { pos: j.pos }           : {}),
  ...(j.damping  !== undefined ? { damping: j.damping }   : {}),
  ...(j.stiffness!== undefined ? { stiffness: j.stiffness}: {}),
  ...(j.limited  !== undefined ? { limited: j.limited }   : {}),
  ...(j.range    !== undefined ? { range: j.range }       : {}),
  ...(j.actuator !== undefined ? { actuator: j.actuator } : {}),
});

/**
 * `parentMoves` is null for a top-level body. For a nested one it says whether
 * anything above it has a joint, which decides whether its meshes are drawn
 * from the body's transform.
 */
export const fillBodyDefaults = (b: RawNode, parentMoves: boolean | null = null): SceneNode => {
  const name = b.name ?? b.id ?? `body_${Math.random().toString(36).slice(2, 7)}`;
  const id   = b.id   ?? name;
  const nested = parentMoves !== null;
  // MuJoCo allows a free joint only on a top-level body; written inside another
  // one it fails the whole compile with a message that names neither body.
  if (nested && (b.joints ?? []).some((j: RawJoint) => j.type === 'free')) {
    throw new Error(`Body '${name}' has a free joint but sits inside another body. A free joint is only allowed at the top level: leave joints out to fix it rigidly to its parent, or give it a hinge or slide.`);
  }
  // Curve (rigid curved track): generate convex box segments from the spline
  // params so agents can author curves declaratively without hand-placing geoms.
  const curveGeoms = (b.isCurve === true && b.geoms === undefined)
    ? generateCurveGeoms(
        id,
        b.curvePoints ?? DEFAULT_CURVE_POINTS,
        b.curveWidth ?? DEFAULT_CURVE_WIDTH,
        b.curveThickness ?? DEFAULT_CURVE_THICKNESS,
        b.curveSegments ?? DEFAULT_CURVE_SEGMENTS,
        b.rgba ?? [0.85, 0.45, 0.15, 1],
        b.curveClosed === true,
        b.curveBank ?? 0
      )
    : null;
  // Flags an agent may write on a body to mean "does not move", none of which
  // is a SceneNode field: honoured here so the body gets no free joint.
  const flags = b as RawNode & { dynamic?: boolean; static?: boolean; fixed?: boolean };
  const isFixed = flags.dynamic === false ||
    flags.static === true ||
    flags.fixed === true ||
    (Array.isArray(b.geoms) && b.geoms.length > 0 && b.geoms.every(g => g.dynamic === false));
  // A nested body with no joints given is fixed rigidly to its parent.
  const defaultJoints: RawJoint[] = (b.isCurve === true || isFixed || nested) ? [] : [{ type: 'free' }];
  const resolvedJoints = (b.joints ?? defaultJoints)
    .map((j: RawJoint, i: number) => fillJointDefaults(j, name, i));
  const moves = resolvedJoints.length > 0 || parentMoves === true;

  // Declarative lattice spec on body (`lattice: { sizeMm?, empty?, subdiv?, thicknessMm?, ops?: [...] }`)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const latSpec = (b as any).lattice as {
    sizeMm?: number;
    empty?: boolean;
    subdiv?: number;
    thicknessMm?: number;
    ops?: LatticeOpSpec[];
  } | undefined;
  let latticeFields: Partial<SceneNode> | null = null;
  let latticeGeoms: RawGeom[] | null = null;
  if (latSpec && typeof latSpec === 'object') {
    const firstOp = Array.isArray(latSpec.ops) && latSpec.ops.length > 0
      ? String(latSpec.ops[0]?.op ?? latSpec.ops[0]?.type ?? '').toLowerCase()
      : '';
    const startEmpty = latSpec.empty === true || latSpec.sizeMm === 0 || (latSpec.sizeMm === undefined && firstOp === 'revolve');
    const size = typeof latSpec.sizeMm === 'number' && latSpec.sizeMm > 0 ? latSpec.sizeMm : 40;
    const halfSteps = Math.max(1, Math.round((size / 2) / (LATTICE_UNIT * 1000)));
    const lat = startEmpty ? createLattice(LATTICE_UNIT) : boxLattice(LATTICE_UNIT, halfSteps);
    const { subdiv, thicknessMm } = runLatticeOps(
      lat,
      Array.isArray(latSpec.ops) ? latSpec.ops : [],
      Number(latSpec.subdiv ?? b.latticeSubdiv ?? 0),
      Number(latSpec.thicknessMm ?? (b.latticeThickness ? b.latticeThickness * 1000 : 0)),
    );
    const cage = serializeCage(lat);
    const { vertices, renderVertices, faces, origin } = latticeToSceneGeom(deserializeCage(cage), subdiv, thicknessMm / 1000);
    latticeFields = {
      isLattice: true,
      latticeCage: cage,
      latticeSubdiv: subdiv,
      ...(thicknessMm > 0 ? { latticeThickness: thicknessMm / 1000 } : {}),
      latticeVersion: 1,
      latticeOrigin: origin,
    };
    latticeGeoms = [{
      name: `${id}_mesh`,
      type: 'mesh',
      size: [1],
      rgba: b.rgba ?? [0.55, 0.68, 0.85, 1],
      mass: typeof (b as RawGeom).mass === 'number' ? (b as RawGeom).mass : 1,
      condim: 3,
      dynamic: true,
      latticeGeom: true,
      vertices,
      faces,
      renderVertices,
    }];
  }

  // Declarative sculpt spec on body (`sculpt: { base?: SculptBaseId, strokes?: [...], cuts?: [...] }`)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sculptSpec = (b as any).sculpt as {
    base?: SculptBaseId;
    /**
     * Longest side in mm, applied before the strokes. Omitted, the base stays
     * at BASE_SIZE (240 mm): scenes written before clay had a size place their
     * strokes on that, and would miss on anything smaller.
     */
    sizeMm?: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    strokes?: Record<string, any>[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cuts?: Record<string, any>[];
  } | undefined;
  let sculptFields: Partial<SceneNode> | null = null;
  let sculptGeoms: RawGeom[] | null = null;
  if (sculptSpec && typeof sculptSpec === 'object') {
    const baseId = (sculptSpec.base ?? b.sculptBase ?? 'sphere') as SculptBaseId;
    if (!SCULPT_BASES.some((sb) => sb.id === baseId)) {
      throw new Error(`Unknown sculpt base '${baseId}'. Available: ${SCULPT_BASES.map((sb) => sb.id).join(', ')}`);
    }
    const mesh = typeof sculptSpec.sizeMm === 'number' && sculptSpec.sizeMm > 0
      ? buildSculptBaseSized(baseId, sculptSpec.sizeMm / 1000)
      : buildSculptBase(baseId);
    if (Array.isArray(sculptSpec.strokes)) {
      for (const s of sculptSpec.strokes) {
        if (!s || typeof s !== 'object') continue;
        const pts = pointList(s.at);
        if (!pts.length || pts.some((p: unknown) => !Array.isArray(p) || p.length < 3)) {
          throw new Error("sculpt stroke 'at' must be [x, y, z] or a list of them, in the body's own frame (metres)");
        }
        applySculptStroke(mesh, {
          brush: s.brush,
          at: pts,
          // An unsized base keeps the 40 mm brush it always had, so an old
          // scene's strokes come out as they did; sized clay gets one in
          // proportion (defaultRadiusFor).
          radius: s.radius ?? (sculptSpec.sizeMm ? undefined : 0.04),
          strength: s.strength,
          invert: s.invert,
          symmetryX: s.symmetryX,
          symmetry: s.symmetry,
          detail: s.detail,
          dynamicTopology: s.dynamicTopology,
          delta: s.delta,
          depthMm: s.depthMm,
          hardness: s.hardness,
        });
      }
    }
    const { vertices, renderVertices, faces } = toSceneGeom(mesh);
    sculptFields = {
      isSculpt: true,
      sculptBase: baseId,
      sculptEdited: Boolean(sculptSpec.strokes?.length || sculptSpec.cuts?.length),
      sculptVersion: 1,
    };
    sculptGeoms = [{
      name: `${id}_sculpt`,
      type: 'mesh',
      size: [0.12, 0.12, 0.12],
      rgba: b.rgba ?? [0.82, 0.72, 0.62, 1],
      mass: typeof (b as RawGeom).mass === 'number' ? (b as RawGeom).mass : 1,
      condim: 3,
      dynamic: true,
      vertices,
      faces,
      renderVertices,
    }];
  }

  // Record declarative post-body-creation ops (cuts, roundEdges, patterns, paint, sculpt.cuts)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bAny = b as Record<string, any>;
  const rawCuts = Array.isArray(bAny.cuts) ? bAny.cuts : undefined;
  const rawRoundEdges = bAny.roundEdges !== undefined ? bAny.roundEdges : bAny.roundings;
  const normRoundEdges = Array.isArray(rawRoundEdges)
    ? rawRoundEdges
    : rawRoundEdges && typeof rawRoundEdges === 'object'
      ? [rawRoundEdges]
      : undefined;
  const rawPatterns = Array.isArray(bAny.patterns)
    ? bAny.patterns
    : bAny.pattern && typeof bAny.pattern === 'object'
      ? [bAny.pattern]
      : undefined;
  const rawPaint = Array.isArray(bAny.paint)
    ? bAny.paint
    : bAny.paint && typeof bAny.paint === 'object'
      ? [bAny.paint]
      : undefined;
  const rawSculptCuts = Array.isArray(sculptSpec?.cuts) && sculptSpec!.cuts.length > 0
    ? sculptSpec!.cuts
    : undefined;

  if (rawCuts || normRoundEdges || rawPatterns || rawPaint || rawSculptCuts) {
    pendingDeclarativeOps.set(id, {
      ...(rawSculptCuts ? { sculptCuts: rawSculptCuts } : {}),
      ...(rawCuts ? { cuts: rawCuts } : {}),
      ...(normRoundEdges ? { roundEdges: normRoundEdges } : {}),
      ...(rawPatterns ? { patterns: rawPatterns } : {}),
      ...(rawPaint ? { paint: rawPaint } : {}),
    });
  }

  const bodyRgba = normalizeRgba(b.rgba);

  // Synthesize single geom when body-level geom properties are supplied without `geoms`
  const synthesizedSingleGeom: RawGeom[] = b.scad !== undefined
    ? [{
        type: 'mesh',
        size: [1],
        dynamic: true,
        ...(bodyRgba !== undefined ? { rgba: bodyRgba } : {}),
        ...(bAny.mass !== undefined ? { mass: bAny.mass } : {}),
        ...(bAny.density !== undefined ? { density: bAny.density } : {}),
        ...(bAny.friction !== undefined ? { friction: bAny.friction } : {}),
        ...(bAny.contype !== undefined ? { contype: bAny.contype } : {}),
        ...(bAny.conaffinity !== undefined ? { conaffinity: bAny.conaffinity } : {}),
        ...(bAny.condim !== undefined ? { condim: bAny.condim } : {}),
        ...(bAny.solref !== undefined ? { solref: bAny.solref } : {}),
        ...(bAny.solimp !== undefined ? { solimp: bAny.solimp } : {}),
      }]
    : [{
        type: (bAny.type && bAny.type !== 'body') ? bAny.type : 'box',
        ...(bAny.size !== undefined ? { size: bAny.size } : {}),
        ...(bodyRgba !== undefined ? { rgba: bodyRgba } : {}),
        ...(bAny.fromto !== undefined ? { fromto: bAny.fromto } : {}),
        ...(bAny.mass !== undefined ? { mass: bAny.mass } : {}),
        ...(bAny.density !== undefined ? { density: bAny.density } : {}),
        ...(bAny.friction !== undefined ? { friction: bAny.friction } : {}),
        ...(bAny.contype !== undefined ? { contype: bAny.contype } : {}),
        ...(bAny.conaffinity !== undefined ? { conaffinity: bAny.conaffinity } : {}),
        ...(bAny.condim !== undefined ? { condim: bAny.condim } : {}),
        ...(bAny.solref !== undefined ? { solref: bAny.solref } : {}),
        ...(bAny.solimp !== undefined ? { solimp: bAny.solimp } : {}),
        ...(bAny.radius !== undefined ? { radius: bAny.radius } : {}),
        ...(bAny.height !== undefined ? { height: bAny.height } : {}),
        ...(bAny.width !== undefined ? { width: bAny.width } : {}),
        ...(bAny.depth !== undefined ? { depth: bAny.depth } : {}),
        ...(bAny.majorRadius !== undefined ? { majorRadius: bAny.majorRadius } : {}),
        ...(bAny.minorRadius !== undefined ? { minorRadius: bAny.minorRadius } : {}),
        ...(bAny.tubeRadius !== undefined ? { tubeRadius: bAny.tubeRadius } : {}),
        ...(bAny.innerRadius !== undefined ? { innerRadius: bAny.innerRadius } : {}),
        ...(bAny.outerRadius !== undefined ? { outerRadius: bAny.outerRadius } : {}),
        ...(bAny.wallThickness !== undefined ? { wallThickness: bAny.wallThickness } : {}),
        ...(bAny.segments !== undefined ? { segments: bAny.segments } : {}),
        ...(bAny.radialSegments !== undefined ? { radialSegments: bAny.radialSegments } : {}),
        ...(bAny.tubularSegments !== undefined ? { tubularSegments: bAny.tubularSegments } : {}),
        ...(bAny.polygon !== undefined ? { polygon: bAny.polygon } : {}),
        ...(bAny.holes !== undefined ? { holes: bAny.holes } : {}),
        ...(bAny.centered !== undefined ? { centered: bAny.centered } : {}),
        ...(bAny.profile !== undefined ? { profile: bAny.profile } : {}),
        ...(bAny.vertices !== undefined ? { vertices: bAny.vertices } : {}),
        ...(bAny.verticesZUp !== undefined ? { verticesZUp: bAny.verticesZUp } : {}),
        ...(bAny.renderVertices !== undefined ? { renderVertices: bAny.renderVertices } : {}),
        ...(bAny.faces !== undefined ? { faces: bAny.faces } : {}),
        ...(bAny.thread !== undefined ? { thread: bAny.thread } : {}),
      }];

  // As for geoms, the caller's fields are kept (shatter settings, sculpt
  // flags...) - all but the transient declarative/shorthand fields above.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rest = { ...b } as Record<string, any>;
  if (bodyRgba) rest.rgba = bodyRgba;
  delete rest.dynamic;
  delete rest.static;
  delete rest.fixed;
  delete rest.lattice;
  delete rest.sculpt;
  delete rest.cuts;
  delete rest.roundEdges;
  delete rest.roundings;
  delete rest.patterns;
  delete rest.pattern;
  delete rest.paint;
  delete rest.polygon;
  delete rest.holes;
  delete rest.centered;
  delete rest.profile;
  delete rest.vertices;
  delete rest.verticesZUp;
  delete rest.renderVertices;
  delete rest.faces;
  delete rest.majorRadius;
  delete rest.minorRadius;
  delete rest.tubeRadius;
  delete rest.innerRadius;
  delete rest.outerRadius;
  delete rest.wallThickness;
  delete rest.radialSegments;
  delete rest.tubularSegments;

  const chosenGeoms = curveGeoms ?? latticeGeoms ?? sculptGeoms ?? b.geoms ?? synthesizedSingleGeom;
  const resolvedGeoms = chosenGeoms.map((g: RawGeom, i: number) =>
    fillGeomDefaults(
      g.rgba === undefined && bodyRgba !== undefined && g.csg !== 'difference'
        ? { ...g, rgba: bodyRgba }
        : g,
      name,
      i,
      moves,
    ),
  );

  return {
    ...(rest as SceneNode),
    ...(latticeFields ?? {}),
    ...(sculptFields ?? {}),
    id,
    name,
    type:     'body',
    // A nested body's pos is relative to its parent, so the top-level
    // default (a metre up, to drop onto the floor) would float it off the part.
    pos:      b.pos     ?? (nested ? [0, 0, 0] : [0, 0, 1]),
    ...(b.quat  !== undefined ? { quat: b.quat }   : {}),
    ...(b.euler !== undefined ? { euler: b.euler } : {}),
    geoms:    resolvedGeoms,
    joints:   resolvedJoints,
    children: (b.children ?? []).map((c) => fillBodyDefaults(c, moves)),
    ...(b.coupleTargetId  !== undefined ? { coupleTargetId: b.coupleTargetId }   : {}),
    ...(b.coupleRatio     !== undefined ? { coupleRatio: b.coupleRatio }         : {}),
    ...(b.weldTargetId    !== undefined ? { weldTargetId: b.weldTargetId }       : {}),
    ...(b.connectTargetId !== undefined ? { connectTargetId: b.connectTargetId } : {}),
    ...(b.connectAnchor   !== undefined ? { connectAnchor: b.connectAnchor }     : {}),
    ...(b.weldBreakForceN    !== undefined ? { weldBreakForceN: b.weldBreakForceN }       : {}),
    ...(b.weldBreakTorqueNm  !== undefined ? { weldBreakTorqueNm: b.weldBreakTorqueNm }   : {}),
    ...(b.weldBreakHoldSteps !== undefined ? { weldBreakHoldSteps: b.weldBreakHoldSteps } : {}),
    ...(b.script          !== undefined ? { script: b.script }                   : {}),
    ...(b.scad            !== undefined ? { scad: b.scad }                       : {}),
    ...(b.isComposite     !== undefined ? { isComposite: b.isComposite }         : {}),
    ...(b.compositeType   !== undefined ? { compositeType: b.compositeType }     : {}),
    ...(b.compositeCount  !== undefined ? { compositeCount: b.compositeCount }   : {}),
    ...(b.compositeSize   !== undefined ? { compositeSize: b.compositeSize }     : {}),
    ...(b.compositePrefix !== undefined ? { compositePrefix: b.compositePrefix } : {}),
    ...(b.compositeCurve  !== undefined ? { compositeCurve: b.compositeCurve }   : {}),
    ...(b.weldLastToId    !== undefined ? { weldLastToId: b.weldLastToId }       : {}),
    // Boolean modifiers: a body whose geoms carry csg:'difference' is compiled
    // into a single mesh (see utils/csg.ts). csgEnabled is inferred when the
    // caller marked a negative but forgot the flag, since a negative geom is
    // meaningless without it and silently rendering it as a solid is worse.
    // Rounded and bevelled edges are a boolean too (utils/edgeRound.ts), and
    // so is a threaded rod, which MuJoCo can only draw as a plain cylinder.
    ...((b.csgEnabled === true || resolvedGeoms.some((g: SceneGeom) => g.csg === 'difference' || g.csg === 'intersection' ||
      (g.type === 'cylinder' && (g.thread?.pitch ?? 0) > 0)) ||
      (Array.isArray(b.edgeRounds) && b.edgeRounds.length > 0))
      ? { csgEnabled: true } : {}),
    ...(Array.isArray(b.edgeRounds) ? { edgeRounds: b.edgeRounds } : {}),
    ...(b.csgCollision !== undefined ? { csgCollision: b.csgCollision } : {}),
    // How ANY mesh body collides — see utils/convexDecomposition.ts. Supersedes
    // csgCollision, which is still accepted above so older callers keep working.
    ...(b.collision      !== undefined ? { collision: b.collision }           : {}),
    ...(b.collisionHulls !== undefined ? { collisionHulls: b.collisionHulls } : {}),
    ...(b.collisionResolution !== undefined ? { collisionResolution: b.collisionResolution } : {}),
    ...(b.collisionMass  !== undefined ? { collisionMass: b.collisionMass }   : {}),
    ...(b.csgSectors   !== undefined ? { csgSectors: b.csgSectors }     : {}),
    ...(b.csgHoleAxis  !== undefined ? { csgHoleAxis: b.csgHoleAxis }   : {}),
    ...(b.csgMass      !== undefined ? { csgMass: b.csgMass }           : {}),
    ...(b.csgFn        !== undefined ? { csgFn: b.csgFn }               : {}),
    ...(b.isCurve === true ? {
      isCurve: true,
      curvePoints:    b.curvePoints    ?? DEFAULT_CURVE_POINTS.map((p: number[]) => [...p]),
      curveWidth:     b.curveWidth     ?? DEFAULT_CURVE_WIDTH,
      curveThickness: b.curveThickness ?? DEFAULT_CURVE_THICKNESS,
      curveSegments:  b.curveSegments  ?? DEFAULT_CURVE_SEGMENTS,
      curveClosed:    b.curveClosed === true,
      curveBank:      b.curveBank      ?? 0,
    } : {}),
  };
};

/**
 * The piece of a part that a body is fixed to, to move with it: a carriage
 * (rail, rod, runner, spring) first, else whatever else moves — a bearing's
 * inner race, a stepper's shaft.
 */
function movingPieceOf(part: SceneNode): SceneNode | null {
  const pieces: SceneNode[] = [];
  const walk = (n: SceneNode) => { for (const c of n.children || []) if (c.hardwarePart?.piece) { pieces.push(c); walk(c); } };
  walk(part);
  return pieces.find((p) => p.hardwarePart!.piece === 'carriage') ?? pieces[0] ?? null;
}

/** Whether one O-ring groove seals against what is placed round it, as the DFM check says. */
function sealCheckFor(scene: SceneGraph, nodeId: string, group: string) {
  const f = sealFindings(scene, 'print').find((x) => x.id === `seal_${nodeId}_${group}`);
  return f ? { seals: !!f.passed, title: f.title, detail: f.detail, fix: f.fix } : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applySingleCutToBody(targetId: string, spec: Record<string, any>): Record<string, any> {
  const store = useStore.getState();
  const { shape, at, normal, diameterMm, widthMm, lengthMm, depthMm, threadPitchMm, threadLeft, threadFitMm, size, bore, fitMm, seal, turned } = spec;
  const node = findNodeInScene(store.sceneGraph.nodes, targetId);
  if (!node) return { ok: false, error: `No object with id '${targetId}'` };
  const spotIn = Array.isArray(at) && at.length >= 3
    ? {
      at: [at[0] / 1000, at[1] / 1000, at[2] / 1000],
      normal: Array.isArray(normal) && normal.length >= 3 ? [...normal] : [0, 0, 1],
    }
    : undefined;

  if (typeof shape === 'string' && shape in HARDWARE_KINDS) {
    const hwKind = shape as HardwareCutKind;
    const group = store.addHardwareCut(targetId, hwKind, spotIn);
    if (!group) return { ok: false, error: store.hardwareCutProblemAt(targetId, hwKind, spotIn) ?? 'That body has no solid shape to cut into' };
    const railSeat = hwKind === 'rail_seat' && (typeof lengthMm === 'number' || typeof turned === 'boolean');
    if (size !== undefined || bore !== undefined || fitMm !== undefined || seal !== undefined || railSeat) {
      const current = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId);
      const before = current && hardwareSpecOf(current.geoms ?? [], group);
      const changes = {
        ...(size !== undefined ? { size: String(size) } : {}),
        ...(bore !== undefined ? { bore: bore as HardwareBore } : {}),
        ...(typeof fitMm === 'number' ? { fitMm } : {}),
        ...(seal === 'face' || seal === 'bore' || seal === 'piston' ? { seal: seal as SealType } : {}),
        // A rail seat's own length and direction.
        ...(hwKind === 'rail_seat' && typeof lengthMm === 'number' ? { lengthMm } : {}),
        ...(hwKind === 'rail_seat' && typeof turned === 'boolean' ? { turned } : {}),
      };
      // A groove a size cannot fit is not changed: say why rather than hand back the wrong one.
      const why = current && before && hardwareCutProblem({ ...before, ...changes }, current);
      if (why) {
        // Nothing half-made is left behind: the groove added at its own size goes too.
        const index = (current.geoms ?? []).findIndex((g) => g.hardware?.group === group && !g.csgDerived);
        if (index >= 0) useStore.getState().deleteNodeGeom(targetId, index);
        return { ok: false, error: why };
      }
      useStore.getState().setHardwareCut(targetId, group, changes);
    }
    const after = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId);
    const hwSpec = hardwareSpecOf(after?.geoms ?? [], group);
    const info = HARDWARE_KINDS[hwKind];
    if (size !== undefined && hwSpec && hwSpec.size !== String(size)) {
      return { ok: false, error: `${info.label} comes in ${info.sizes.join(', ')}; got '${size}'` };
    }
    return {
      ok: true, id: targetId, group, shape: hwKind, size: hwSpec?.size,
      ...(hwSpec?.bore ? { bore: hwSpec.bore } : {}),
      fitMm: hwSpec?.fitMm ?? 0,
      atMm: (hwSpec?.at ?? []).map((v: number) => Math.round(v * 1000 * 1000) / 1000),
      normal: hwSpec?.normal,
      pieces: (after?.geoms ?? []).filter((g) => g.hardware?.group === group).map((g) => g.hardware!.part),
      ...(hwSpec?.seal ? { seal: hwSpec.seal } : {}),
      ...(hwKind === 'oring' || hwKind === 'seal_cord' ? { sealCheck: sealCheckFor(useStore.getState().sceneGraph, targetId, group) } : {}),
    };
  }

  if (shape === 'pocket') return applyPocketCut(targetId, spec, spotIn);

  const kind = shape === 'slot' || shape === 'box' ? 'box'
    : shape === 'dish' || shape === 'sphere' ? 'sphere' : 'cylinder';
  const index = store.addBodyCut(targetId, kind, spotIn);
  if (index < 0) return { ok: false, error: 'That body has no solid shape to cut into' };

  if (kind === 'box') {
    const wide = typeof widthMm === 'number' ? widthMm / 2000 : undefined;
    const long = typeof lengthMm === 'number' ? lengthMm / 2000 : undefined;
    if (wide !== undefined || long !== undefined) {
      const now = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId)?.geoms?.[index];
      useStore.getState().setCutSection(targetId, index, [
        wide ?? now?.size?.[0] ?? 0.005,
        long ?? now?.size?.[1] ?? 0.005,
      ]);
    }
  } else if (typeof diameterMm === 'number') {
    useStore.getState().setCutSection(targetId, index, [diameterMm / 2000]);
  }
  if (typeof depthMm === 'number') useStore.getState().setCutDepth(targetId, index, depthMm);
  if (typeof threadPitchMm === 'number' && kind === 'cylinder') {
    useStore.getState().setGeomThread(targetId, index, {
      pitchMm: threadPitchMm,
      left: threadLeft === true,
      fitMm: typeof threadFitMm === 'number' ? threadFitMm : 0,
    });
  }

  const cut = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId)?.geoms?.[index];
  return {
    ok: true,
    id: targetId,
    geomIndex: index,
    name: cut?.name,
    shape: kind,
    atMm: (cut?.cutAt ?? []).map((v: number) => Math.round(v * 1000 * 1000) / 1000),
    normal: cut?.cutNormal,
    ...(cut?.thread?.pitch ? {
      threadPitchMm: Math.round(cut.thread.pitch * 1000 * 1000) / 1000,
      ...(cut.thread.left ? { threadLeft: true } : {}),
      ...(cut.thread.fit ? { threadFitMm: Math.round(cut.thread.fit * 1000 * 1000) / 1000 } : {}),
    } : {}),
    depthMm: cut?.cutDepth ? Math.round(cut.cutDepth * 1000 * 1000) / 1000 : 0,
    through: !(cut?.cutDepth && cut.cutDepth > 0),
  };
}

/**
 * A smooth pocket: placed the way any cut is (a line cast along `normal`
 * through `at` finds the surface), then swapped for a dense closed mesh of the
 * outline, depth and floor asked for, baked into the body's frame. It keeps no
 * cutAt, so nothing re-derives it as a primitive; what it was made from stays
 * on it as `pocket`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyPocketCut(targetId: string, spec: Record<string, any>, spotIn?: { at: number[]; normal: number[] }): Record<string, any> {
  const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : undefined);
  const outline = spec.outline === 'ellipse' || spec.outline === 'circle' ? 'ellipse' : 'rect';
  const widthMm = num(spec.widthMm) ?? num(spec.diameterMm);
  const lengthMm = num(spec.lengthMm) ?? (outline === 'ellipse' ? widthMm : undefined);
  const depthMm = num(spec.depthMm);
  if (!widthMm || !lengthMm || !depthMm) {
    return { ok: false, error: 'A pocket needs widthMm and lengthMm (or diameterMm for a round one) and depthMm' };
  }
  const pocket: PocketSpec = {
    outline,
    widthMm,
    lengthMm,
    depthMm,
    ...(num(spec.cornerRadiusMm) ? { cornerRadiusMm: num(spec.cornerRadiusMm) } : {}),
    floor: spec.floor === 'bowl' ? 'bowl' : 'flat',
    ...(typeof spec.floorRadiusMm === 'number' ? { floorRadiusMm: spec.floorRadiusMm } : {}),
  };
  const store = useStore.getState();
  const index = store.addBodyCut(targetId, 'cylinder', spotIn);
  if (index < 0) return { ok: false, error: 'That body has no solid shape to cut into' };
  const node = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId);
  const placed = node?.geoms?.[index];
  if (!node || !placed?.cutAt || !placed.cutNormal) return { ok: false, error: 'The pocket could not be placed' };

  const { verts, faces } = pocketMesh(pocket);
  const n = new Vector3(...(placed.cutNormal as [number, number, number])).normalize();
  const turn = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), n);
  const origin = new Vector3(...(placed.cutAt as [number, number, number]));
  const zup: number[] = [];
  const v = new Vector3();
  for (let i = 0; i < verts.length; i += 3) {
    v.set(verts[i] / 1000, verts[i + 1] / 1000, verts[i + 2] / 1000).applyQuaternion(turn).add(origin);
    zup.push(v.x, v.y, v.z);
  }
  const yup = zup.flatMap((_, i, a) => (i % 3 === 0 ? [a[i], a[i + 2], -a[i + 1]] : []));
  const mesh: SceneGeom = {
    name: placed.name,
    type: 'mesh',
    // A mesh geom's size is unused, as for every other mesh geom.
    size: [1],
    csg: 'difference',
    rgba: placed.rgba,
    renderVertices: zup,
    vertices: yup,
    faces,
    pocket: { ...pocket, at: [...placed.cutAt], normal: [...placed.cutNormal] },
  };
  store.updateNode(targetId, { geoms: node.geoms.map((g, i) => (i === index ? mesh : g)) });
  return {
    ok: true,
    id: targetId,
    geomIndex: index,
    name: placed.name,
    shape: 'pocket',
    atMm: placed.cutAt.map((c: number) => Math.round(c * 1e6) / 1000),
    normal: placed.cutNormal,
    pocket,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function applyRoundEdgesToBody(targetId: string, specs: Record<string, any>[], compileNow = true): Promise<Record<string, any>> {
  const store = useStore.getState();
  const node = findNodeInScene(store.sceneGraph.nodes, targetId);
  const why = whyNotRoundable(node);
  if (why) return { ok: false, error: node ? why : `No object with id '${targetId}'` };
  const found = await bodyEdges(node!, bodyUp(store.sceneGraph.nodes, targetId));
  let totalChanged = 0;

  for (const spec of specs) {
    const { edges, sizeMm, mode, remove } = spec;
    const which = Array.isArray(edges) ? edges.map(Number)
      : edges === undefined ? 'all'
      : ['all', 'top', 'bottom', 'vertical', 'inside'].includes(String(edges)) ? String(edges) as EdgeGroup : null;
    if (which === null) return { ok: false, error: "edges must be 'all', 'top', 'bottom', 'vertical', 'inside' or a list of ids from physics_get_edges" };
    const { picked, unknown } = selectEdges(found.edges, which);
    if (unknown.length) return { ok: false, error: `No edge with id ${unknown.join(', ')} — physics_get_edges lists them` };
    if (picked.length === 0) return { ok: false, error: `This part has no ${Array.isArray(which) ? '' : which + ' '}edges that can be rounded` };

    if (remove === true) {
      useStore.getState().unroundEdges(targetId, picked.map((e) => e.edge));
    } else {
      const kind: 'fillet' | 'chamfer' = mode === 'bevel' || mode === 'chamfer' ? 'chamfer' : 'fillet';
      if (typeof sizeMm !== 'number' || !(sizeMm > 0)) return { ok: false, error: 'sizeMm must be a positive number of millimetres' };
      const most = maxSizeFor(picked, kind);
      if (sizeMm / 1000 > most + 1e-9) {
        return { ok: false, error: `${sizeMm} mm is too big for ${picked.length === 1 ? 'this edge' : 'these edges'} — ${Math.floor(most * 1e5) / 100} mm is the most that fits` };
      }
      useStore.getState().roundEdges(targetId, { mode: kind, size: sizeMm / 1000, edges: picked.map((e) => e.edge) });
    }
    totalChanged += picked.length;
  }

  if (compileNow) {
    await compileCsgNodes(true);
    await useStore.getState().recompile(useStore.getState().sceneGraph, undefined, false, true);
  }
  const after = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId);
  if (after?.csgError) return { ok: false, error: `Rounding failed: ${after.csgError}` };
  return {
    ok: true,
    id: targetId,
    edgesChanged: totalChanged,
    roundings: (after?.edgeRounds ?? []).map((f, i) => ({
      index: i, mode: f.mode === 'fillet' ? 'round' : 'bevel', sizeMm: Math.round(f.size * 1e5) / 100, edges: f.edges.length,
    })),
    ...(after?.csgVolume !== undefined ? { volumeMm3: Math.round(after.csgVolume * 1e9 * 10) / 10 } : {}),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function applySinglePatternToBody(targetId: string, m: Record<string, any>): Promise<Record<string, any>> {
  const store = useStore.getState();
  const node = findNodeInScene(store.sceneGraph.nodes, targetId);
  if (!node) throw new Error(`No object with id '${targetId}'`);
  const at = pointList(m.at)[0];
  if (!at) throw new Error("Missing at: a point [x, y, z] on the face, in the body's own frame in millimetres.");
  const pick = patternPickAt(node, at.map((v) => v / 1000), Array.isArray(m.normal) ? m.normal : undefined);
  if (!pick) {
    throw new Error(`No surface of '${targetId}' within 10 mm of [${at.join(', ')}] mm. Points are in the body's own frame in millimetres; physics_get_object gives the shapes, and normal says which way the face looks.`);
  }
  const geom = (node.geoms || []).find((g) => g.name === pick.geomName);
  if (!geom) throw new Error(`The face picked belongs to '${pick.geomName}', which is not on the body.`);
  const existing = geom.textures ?? [];
  const describe = (t: SurfaceTexture) =>
    `${patternById(t.pattern)?.label ?? t.pattern}, ${t.depthM > 0 ? 'embossed' : 'engraved'} ${(Math.abs(t.depthM) * 1000).toFixed(1)} mm`;

  if (m.remove) {
    if (pick.index === undefined) return { ok: false, error: 'There is no pattern on the face at that point.' };
    const list = existing.filter((_, i) => i !== pick.index);
    if (!m.preview) useStore.getState().setGeomTextures(node.id, geom.name, list.length ? list : undefined);
    return { ok: true, removed: describe(existing[pick.index]), geomName: geom.name, remaining: list.length };
  }

  const prev = pick.index !== undefined ? existing[pick.index] : undefined;
  const faceable = SURFACE_PATTERNS.filter((p) => !p.throughCut);
  const known = () =>
    faceable.map((p) => `${p.id} (${p.fields.map((f) => f.key).join(', ')})`).join('; ');
  const patternId = m.pattern ?? prev?.pattern;
  if (!patternId) throw new Error(`Missing pattern. One of, with its options: ${known()}.`);
  const spec = patternById(patternId);
  if (!spec || spec.throughCut) {
    throw new Error(`'${patternId}' is not a pattern that goes on a face. One of, with its options: ${known()}.`);
  }
  const projections: TextureProjection[] = ['auto', 'planar', 'cylindrical', 'revolved', 'unwrap'];
  if (m.projection !== undefined && !projections.includes(m.projection as TextureProjection)) {
    throw new Error(`projection is one of ${projections.join(', ')}.`);
  }
  const optionKeys = new Set(spec.fields.map((f) => f.key));
  const unknown = Object.keys(m.options ?? {}).filter((k) => !optionKeys.has(k));
  const depthMm = m.depthMm ?? (prev ? Math.abs(prev.depthM) * 1000 : 1.5);
  if (!(depthMm > 0)) throw new Error('depthMm must be more than 0.');
  const emboss = m.emboss ?? (prev ? prev.depthM > 0 : false);
  const projection = (m.projection ?? prev?.projection) as TextureProjection | undefined;
  // [r, g, b] 0..1 or '#rrggbb' for the part the pattern moves; null or 'none' clears it.
  let color: number[] | undefined = prev?.color;
  if (m.color === null || m.color === 'none') color = undefined;
  else if (typeof m.color === 'string' && /^#[0-9a-f]{6}$/i.test(m.color)) color = hexToRgb(m.color);
  else if (Array.isArray(m.color) && m.color.length >= 3 && m.color.slice(0, 3).every((v: unknown) => typeof v === 'number')) {
    color = m.color.slice(0, 3).map((v: number) => Math.min(1, Math.max(0, v)));
  } else if (m.color !== undefined) throw new Error("color is [r, g, b] each 0..1, or '#rrggbb', or 'none'.");
  const texture: SurfaceTexture = {
    pattern: spec.id,
    options: { ...spec.defaults, ...(prev?.pattern === spec.id ? prev.options : {}), ...(m.options ?? {}) },
    depthM: ((emboss ? 1 : -1) * depthMm) / 1000,
    borderM: m.borderMm !== undefined ? Math.max(0, m.borderMm) / 1000 : prev?.borderM ?? DEFAULT_TEXTURE_BORDER_M,
    // Lettering's strokes want finer triangles than a texture does.
    cellM: m.cellMm !== undefined ? Math.max(0.05, m.cellMm) / 1000 : prev?.cellM ?? (spec.figure || spec.wraps ? 0.00025 : DEFAULT_TEXTURE_CELL_M),
    seedAt: prev?.seedAt ?? pick.seedAt,
    seedNormal: prev?.seedNormal ?? pick.seedNormal,
    maxTiltDeg: m.stopAtDeg ?? prev?.maxTiltDeg,
    projection: projection === 'auto' ? undefined : projection,
    twistDeg: m.twistDeg ?? prev?.twistDeg,
    scale: m.scale ?? prev?.scale,
    ...(color ? { color } : {}),
  };
  // Text fetches its font and is laid out here; the build only fills the outline.
  if (spec.prepare) {
    try {
      texture.options = await spec.prepare(texture.options ?? {});
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  const index = pick.index ?? existing.length;
  const list = [...existing];
  list[index] = texture;
  const surface = await requestTexturedSurface({ ...geom, textures: list }, geomHalfLen(geom));
  const region = surface?.regions.find((r) => r.index === index);
  const warnings = [
    ...(surface?.warnings ?? [])
      .filter((w) => w.startsWith(`Pattern ${index + 1}:`) || !w.startsWith('Pattern '))
      .map((w) => w.replace(/^Pattern \d+: /, '')),
    ...(unknown.length ? [`${spec.label} has no option ${unknown.join(', ')}; it takes ${[...optionKeys].join(', ')}.`] : []),
  ];
  if (!region?.applied) {
    return { ok: false, error: region?.reason ?? 'The pattern could not be laid on that face.', warnings };
  }
  if (!m.preview) useStore.getState().setGeomTextures(node.id, geom.name, list);
  const mm = (v: number) => Math.round(v * 10000) / 10;
  return {
    ok: true,
    preview: !!m.preview,
    edited: pick.index !== undefined,
    index,
    geomName: geom.name,
    pattern: describe({ ...texture, depthM: region.depthM }),
    options: Object.fromEntries(Object.entries(texture.options ?? {}).filter(([k]) => k !== 'outline' && k !== 'outlineSig' && k !== 'imageGrid')),
    faceMm: [mm(region.extentM[0]), mm(region.extentM[1])],
    areaMm2: Math.round(region.areaM2 * 1e6),
    projection: region.projection,
    stretchPercent: region.stretch !== undefined && Number.isFinite(region.stretch) ? Math.round(region.stretch * 100) : null,
    ...(region.wrap ? { wrap: region.wrap } : {}),
    ...(region.seam ? { seam: true } : {}),
    ...(region.capped ? { capped: true } : {}),
    depthMm: mm(Math.abs(region.depthM)),
    ...(texture.color ? { color: rgbToHex(texture.color) } : {}),
    triangles: region.triangles,
    warnings,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyPaintStrokeToBody(targetId: string, m: Record<string, any>): Record<string, any> {
  const store = useStore.getState();
  const { geomName, at, radius, rgba, flow, erase } = m;
  const node = findNodeInScene(store.sceneGraph.nodes, targetId);
  if (!node) throw new Error(`No object with id '${targetId}'`);

  const geom = geomName
    ? (node.geoms || []).find((g: SceneGeom) => g.name === geomName)
    : (node.csgEnabled
        ? (node.geoms || []).find((g: SceneGeom) => g.csgDerived === 'visual' && isPaintable(g.type, !!node.isWedge)) ??
          (node.geoms || []).find((g: SceneGeom) => isPaintable(g.type, !!node.isWedge))
        : (node.geoms || []).find((g: SceneGeom) => isPaintable(g.type, !!node.isWedge)));
  if (!geom) throw new Error(geomName ? `No geom named '${geomName}' on '${targetId}'` : `Nothing paintable on '${targetId}'`);
  if (!isPaintable(geom.type, !!node.isWedge)) {
    throw new Error(`A '${geom.type}' geom cannot hold paint — paintable types are box, sphere, ellipsoid, cylinder, capsule and mesh`);
  }
  if (!Array.isArray(rgba) || rgba.length < 3) throw new Error('rgba must be [r, g, b], each 0..1');

  const points: number[][] = pointList(at);
  if (!points.length || points.some((p: unknown) => !Array.isArray(p) || p.length < 3)) {
    throw new Error("at must be [x, y, z] or a list of them, in the geom's own frame (metres)");
  }
  const brush = typeof radius === 'number' ? radius : 0.008;

  const isDynamicMesh = geom.type === 'mesh' && (geom.dynamic !== false || !geom.vertices?.length);
  const rawMeshPositions = geom.type === 'mesh'
    ? (isDynamicMesh ? (geom.renderVertices ?? geom.vertices) : geom.vertices)
    : undefined;
  const args = paintArgsFromSize(geom.type, geom.size || []);
  const res = geom.paint
    ? geom.paint.res
    : geom.type === 'mesh'
      ? (rawMeshPositions?.length ? paintMeshResolution(rawMeshPositions) : [])
      : paintResolution(geom.type, args);
  const built = geom.type === 'mesh'
    ? (rawMeshPositions?.length && geom.faces?.length && res.length
        ? buildMeshPaintGeometry(rawMeshPositions, geom.faces, res)
        : null)
    : buildPaintGeometry(geom.type, args, res);
  const positions: ArrayLike<number> | undefined = built
    ? (built.getAttribute('position')?.array as Float32Array | undefined)
    : rawMeshPositions;
  const faces: ArrayLike<number> | undefined = built
    ? (built.getIndex()?.array as Uint32Array | undefined)
    : geom.faces;
  if (!positions?.length) throw new Error('That geom has no surface to paint');

  const canvas = canvasFromLayer(geom.paint, positions.length / 3, res);
  let landed = 0;
  for (const point of points) {
    const [x, y, z] = toGeometrySpace(geom.type, point, isDynamicMesh);
    if (applyDab(canvas, positions, {
      x, y, z,
      radius: brush,
      color: rgba,
      flow: typeof flow === 'number' ? flow : 1,
      erase: !!erase,
    }, faces)) landed++;
  }
  built?.dispose();

  if (!landed) {
    throw new Error(`No vertices within ${brush} m of any of those points — the point has to be on the surface, in the geom's own frame`);
  }
  useStore.getState().setGeomPaint(targetId, geom.name, layerFromCanvas(canvas));
  return { ok: true, geomName: geom.name, dabsLanded: landed, dabsRequested: points.length };
}

async function applyDeclarativePreCsgFeatures(nodes: SceneNode[]): Promise<void> {
  const walk = async (list: SceneNode[]) => {
    for (const n of list || []) {
      const pending = pendingDeclarativeOps.get(n.id);
      if (pending) {
        if (pending.sculptCuts && pending.sculptCuts.length > 0) {
          for (const cutSpec of pending.sculptCuts) {
            const live = findNodeInScene(useStore.getState().sceneGraph.nodes, n.id);
            if (!live || !live.isSculpt) break;
            const geomIndex = Math.max(0, (live.geoms ?? []).findIndex((g: SceneGeom) => g.type === 'mesh'));
            const mesh = sculptMeshOf(live);
            const res = await cutSculptOffThread(
              mesh,
              { kind: 'polygon', polygon: cutSpec.polygon, direction: cutSpec.direction },
              { mode: cutSpec.mode, cap: cutSpec.cap },
            );
            if (!res.ok) throw new Error(`Sculpt cut on '${n.name}' failed: ${res.error}`);
            const latest = useStore.getState();
            latest.updateNode(n.id, { sculptEdited: true, sculptVersion: (live.sculptVersion ?? 1) + 1 });
            const { vertices, renderVertices, faces } = toSceneGeom(res.mesh);
            latest.updateNodeGeom(n.id, { vertices, renderVertices, faces }, geomIndex);
          }
        }
        if (pending.cuts && pending.cuts.length > 0) {
          for (const cutSpec of pending.cuts) {
            const res = applySingleCutToBody(n.id, cutSpec);
            if (!res.ok) throw new Error(`Cut on '${n.name}' failed: ${res.error}`);
          }
        }
        if (pending.roundEdges && pending.roundEdges.length > 0) {
          const res = await applyRoundEdgesToBody(n.id, pending.roundEdges, false);
          if (!res.ok) throw new Error(`Edge rounding on '${n.name}' failed: ${res.error}`);
        }
        if (pending.patterns && pending.patterns.length > 0) {
          for (const patSpec of pending.patterns) {
            const res = await applySinglePatternToBody(n.id, patSpec);
            if (!res.ok) throw new Error(`Pattern on '${n.name}' failed: ${res.error}`);
          }
        }
      }
      if (n.children && n.children.length > 0) {
        await walk(n.children);
      }
    }
  };
  await walk(nodes);
}

async function applyDeclarativePostCsgFeatures(nodes: SceneNode[]): Promise<void> {
  const walk = async (list: SceneNode[]) => {
    for (const n of list || []) {
      const pending = pendingDeclarativeOps.get(n.id);
      if (pending) {
        pendingDeclarativeOps.delete(n.id);
        if (pending.paint && pending.paint.length > 0) {
          for (const paintSpec of pending.paint) {
            applyPaintStrokeToBody(n.id, paintSpec);
          }
        }
      }
      if (n.children && n.children.length > 0) {
        await walk(n.children);
      }
    }
  };
  await walk(nodes);
}

// Bounding-box diagonal above this (in MuJoCo meters) on a freshly-compiled
// SCAD mesh almost always means the source forgot the required
// scale([0.001,0.001,0.001]) wrapper and compiled at millimeter scale by
// mistake (a 183x132x11mm part is ~0.2m across; the same part un-scaled
// is ~183m across) rather than an intentionally huge object.
const SUSPICIOUSLY_LARGE_DIAGONAL_M = 20;

/**
 * This tab's name, for the hub's session list.
 *
 * sessionStorage, not localStorage: it is per-tab and dies with the tab, which
 * is exactly the lifetime wanted. It also survives a reload, so reloading the
 * page a person had selected does not silently hand the agent a different tab.
 *
 * The label is what a person reads in `list_sessions` when they have three of
 * these open and have to say which one to drive, so it carries the port and a
 * short id rather than just a uuid.
 */
/**
 * Bytes as base64, for handing a produced file back over the bridge.
 *
 * Chunked because String.fromCharCode is applied to the array and a megabyte of
 * arguments overflows the call stack. The MCP server writes these to disk and
 * never returns them to the agent, so size here costs transfer, not context.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * The produced files, with or without the bytes.
 *
 * An agent asking what a part weighs and how long it takes to cut does not want
 * a megabyte of G-code, and when the MCP server has nowhere to put a file it
 * does not want it either. So the caller says whether it is going to keep them,
 * and when it is not the bytes are never encoded, never sent, and never sit in
 * a socket buffer — only the name and the size it would have been.
 */
function describeFiles(files: { name: string; bytes: Uint8Array }[], include: boolean) {
  return files.map(f => include
    ? { name: f.name, bytes: f.bytes.byteLength, base64: bytesToBase64(f.bytes) }
    : { name: f.name, bytes: f.bytes.byteLength });
}

function tabIdentity(): { sessionId: string; label: string; href: string; startedAt: number } {
  const { id, startedAt } = tabSession();
  const href = typeof location !== 'undefined' ? location.href : '';
  const port = typeof location !== 'undefined' ? location.port : '';
  return { sessionId: id, label: `Mesh :${port} ${id.slice(4)}`, href, startedAt };
}

export function useMCPBridge() {
  useEffect(() => {
    let ws: WebSocket | null = null;
    let dead = false;
    let retryTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      if (dead) return;
      const params = new URLSearchParams(location.search);
      const wsPort = params.get('mcpPort') || '3142';
      ws = new WebSocket(`ws://localhost:${wsPort}`);

      ws.onopen = () =>
        /*
         * The handshake also offers this tab's session, as a fallback
         * credential for the MCP server's cloud tools — the ones that read the
         * run archive over HTTPS rather than driving this tab. It means an
         * agent can answer a question about last month's job with no setup at
         * all, as long as the app is open.
         *
         * The server treats it as a last resort behind PHYSBOX_API_TOKEN and its
         * config file, because this socket has no origin check. It is localhost
         * only, and the server binds loopback.
         */
        ws!.send(JSON.stringify({
          event: 'HELLO',
          app: 'physics',
          port: location.port,
          token: getStoredAuthToken() ?? undefined,
          // Which TAB this is. Several tabs of the same app all connect to the
          // one hub, and without a name for each the hub could only shout: every
          // command went to all of them and whichever answered first won. That
          // is not a race you can win by retrying — a body created in one tab is
          // invisible to the next command if a different tab answers it, and a
          // preset saved by a stale tab overwrites a good one, because
          // localStorage is shared across tabs of an origin and the last write
          // stands. With an id per tab the hub can address exactly one.
          ...tabIdentity(),
        }));

      ws.onmessage = (evt) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(evt.data); } catch { return; }
        if (!msg || typeof msg !== 'object') return;
        const cmd = typeof msg.cmd === 'string' ? msg.cmd : undefined;
        const id = msg.id;
        if (!cmd) return;

        useStore.getState().incrementMcpActive();
        // The counter drives the "MCP Active" badge, so this command's
        // increment has to be paid back exactly once no matter which way the
        // handler ends — including the synchronous-throw path below, which
        // would otherwise double-decrement and hide a genuinely running
        // command's badge.
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          useStore.getState().decrementMcpActive();
        };

        let result: unknown;
        try {
          result = guardedHandle(cmd, msg);
        } catch (e) {
          ws?.send(JSON.stringify({ event: 'ERROR', cmd, id, error: String(e) }));
          done();
          return;
        }
        Promise.resolve(result)
          .then(data => ws?.send(JSON.stringify({ event: 'RESULT', cmd, id, data })))
          .catch(e  => ws?.send(JSON.stringify({ event: 'ERROR', cmd, id, error: String(e) })))
          .finally(done);
      };

      ws.onclose = () => { if (!dead) retryTimer = setTimeout(connect, 2000); };
      ws.onerror = () => ws?.close();
    };

    /*
     * The machine commands, shared with Volt and Etch.
     *
     * Everything that can move an axis goes through the arming gate: a person
     * clicks "Allow Claude to move this machine" in the app, once, and the
     * agent works inside that window. Reading state, trimming a running cut,
     * pausing, cancelling and e-stopping are all ungated — refusing a stop
     * would be worse than having no gate at all.
     */
    const machineHandlers = createMeshMachineHandlers();

    /*
     * With draft baked in by Prepare for Casting, the store turns body edits
     * away (see the guard in useStore). A handler that went on to report
     * success would be telling the agent something that did not happen, so a
     * command during which an edit was refused fails instead, and says how to
     * get past it. The guard's modal is for a person; an agent has its answer,
     * so the modal is closed again.
     */
    const guardedHandle = async (cmd: string, msg: Record<string, unknown>): Promise<unknown> => {
      if (SERIAL_SCULPT_COMMANDS.has(cmd)) {
        const run = sculptQueue.then(() => guardedNow(cmd, msg));
        sculptQueue = run.catch(() => undefined);
        return run;
      }
      return guardedNow(cmd, msg);
    };

    const guardedNow = async (cmd: string, msg: Record<string, unknown>): Promise<unknown> => {
      const blockedBefore = useStore.getState().castPrepBlocked;
      const data = await handle(cmd, msg);
      if (useStore.getState().castPrepBlocked === blockedBefore) return data;
      useStore.getState().closeCastPrepGuard();
      return {
        ok: false,
        error: 'The scene is prepared for casting with draft baked in, so that edit was not made. '
          + 'Call physics_set_cast_prep with off=true to restore the original shapes, or bake=true to keep the drafted ones, then retry.',
      };
    };

    const handle = async (cmd: string, msg: Record<string, unknown>): Promise<unknown> => {
      // Access Zustand store directly — works outside React render
      const store = useStore.getState();

      // The machine handlers outlive any one render, so they are pointed at the
      // scene this call is answering about rather than closing over a stale one.
      setCurrentScene(store.sceneGraph, store.stock);

      const machineHandler = machineHandlers[cmd];
      if (machineHandler) {
        try {
          return await machineHandler((msg ?? {}) as Record<string, unknown>);
        } catch (e) {
          // Returned rather than thrown: a refusal is an answer the agent has to
          // read and act on — arm the machine, use a smaller tool, re-zero — and
          // an exception here would surface as a bridge fault instead.
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }

      /*
       * A body given by name becomes its id, once, here.
       *
       * Every handler finds bodies by id or name (findNodeInScene), but the store
       * edits, deletes and keys history by id alone. So sculpt, combine, delete
       * and the lattice undo stack given a name found the body, reported ok, and
       * changed nothing - or pushed history under a key undo never read. An
       * exact id wins over a name, so a body named like another's id is safe.
       */
      const toId = (v: unknown): unknown => {
        if (typeof v !== 'string') return v;
        const byId = (nodes: SceneNode[] = []): boolean =>
          nodes.some((n) => n.id === v || byId(n.children));
        if (byId(store.sceneGraph.nodes)) return v;
        return findNodeInScene(store.sceneGraph.nodes, v)?.id ?? v;
      };
      if (msg && typeof msg.targetId === 'string') msg = { ...msg, targetId: toId(msg.targetId) };
      if (msg && Array.isArray(msg.withIds)) msg = { ...msg, withIds: msg.withIds.map(toId) };

      switch (cmd) {
        case 'GET_STATE':
          return {
            // Mesh arrays stripped as physics_get_objects strips them: one
            // carved tray made this reply 2.8 MB. include_meshes asks for them.
            sceneGraph: msg.includeMeshes === true
              ? store.sceneGraph
              : { ...store.sceneGraph, nodes: (store.sceneGraph.nodes || []).map(stripMeshArrays) },
            isPlaying:    store.isPlaying,
            isLoaded:     store.isLoaded,
            gravityZ:     store.gravityZ,
            windX:        store.windX,
            windY:        store.windY,
            density:      store.density,
            floorFriction: store.floorFriction,
            floorBounce:   store.floorBounce,
            lastCompileError: store.lastCompileError,
          };

        case 'GET_CAMERA': {
          // Prefer the live pose (reflects manual orbiting/panning done in the
          // browser since the last SET_CAMERA/preset change); fall back to the
          // last-known override/preset if the viewport hasn't mounted yet.
          const live = getLiveCameraPose();
          return {
            ...(live ?? {}),
            preset: store.cameraOverride ? null : store.cameraView,
            isOverride: store.cameraOverride !== null,
            dims: store.dimsEnabled,
            // What the Dims overlay is drawing right now, in mm; empty when it
            // is off, in Perspective, or orbited off the view's axis.
            dimensions: getLiveDimensions(),
          };
        }

        case 'SET_CAMERA': {
          // Two mutually exclusive forms: { preset } to reset to a built-in
          // view, or { position:[x,y,z], target?:[x,y,z] } for an explicit
          // (perspective) pose. Both position and target are in MuJoCo world
          // space, same convention as every other pos field in this API.
          // `dims` switches the Dims overlay with either form, or alone.
          if (msg.dims !== undefined) {
            if (typeof msg.dims !== 'boolean') return { ok: false, error: 'dims must be true or false' };
            store.setDimsEnabled(msg.dims);
          }
          if (msg.preset !== undefined) {
            if (!CAMERA_VIEWS.includes(msg.preset as CameraView)) {
              return { ok: false, error: `preset must be one of ${CAMERA_VIEWS.map((v) => `'${v}'`).join(', ')}` };
            }
            store.setCameraView(msg.preset as CameraView);
            return { ok: true };
          }
          if (msg.dims !== undefined && msg.position === undefined) return { ok: true };
          if (!Array.isArray(msg.position) || msg.position.length !== 3) {
            return { ok: false, error: 'position must be a [x,y,z] array in MuJoCo world space (or pass preset instead)' };
          }
          if (msg.target !== undefined && (!Array.isArray(msg.target) || msg.target.length !== 3)) {
            return { ok: false, error: 'target must be a [x,y,z] array in MuJoCo world space' };
          }
          store.setCameraOverride({
            position: msg.position as [number, number, number],
            target: (msg.target ?? [0, 0, 0]) as [number, number, number],
          });
          return { ok: true };
        }

        case 'GET_SCENE':
          return store.sceneGraph;

        case 'GET_SCENE_SUMMARY':
          return {
            nodes: (store.sceneGraph.nodes || []).map((n) => summarizeNode(n, store.model)),
            // What to buy: every bought part counted, bar stock packed.
            ...(() => {
              const list = hardwareList(store.sceneGraph);
              return list.rows.length ? { hardwareList: list } : {};
            })(),
            ...(store.model?.body_mass ? {
              // Body 0 is the world.
              totalMassKg: +Array.from(store.model.body_mass).slice(1).reduce((a, b) => a + b, 0).toPrecision(6),
            } : {}),
            stock: stockReport(store.sceneGraph, store.stock),
            ...(store.sceneGraph.simFidelity === 'print' ? {
              simFidelity: {
                mode: 'print',
                // g * t^2 at the stiffest contact the timestep allows.
                restingPenetrationMm: +(9.81 * PRINT_CONTACT_TIME * PRINT_CONTACT_TIME * 1000).toFixed(3),
                note: 'Pins and sockets collide exactly; everything else collides as its hull or convex pieces. A clearance under about 0.1 mm is below what the contact can resolve.',
              },
            } : {}),
            ...(store.sceneGraph.referenceImages?.length
              ? { referenceImages: store.sceneGraph.referenceImages.map(describeReferenceImage) }
              : {}),
          };

        /*
          A picture pinned in the viewport to model from. Without `imageId` it
          adds one (`image` required: a data URL or bare base64, which the
          server reads off disk for `path`); with `imageId` it changes that one.
          `remove` takes one off, `clear` takes them all. One undo step either
          way. Not `id`: that is the request's own id on the wire.
        */
        case 'SET_REFERENCE_IMAGE': {
          const { imageId: id, image, remove, clear } = msg as Msg<{ imageId?: string; image?: string; remove?: boolean; clear?: boolean }>;
          const current = store.sceneGraph.referenceImages ?? [];
          const listed = (list: typeof current) => list.map(describeReferenceImage);
          if (clear) {
            store.setReferenceImages([]);
            return { ok: true, removed: current.length, referenceImages: [] };
          }
          if (remove) {
            if (!id) throw new Error('remove needs the imageId of the picture to take off');
            if (!current.some((r) => r.id === id)) throw new Error(`No reference image with id '${id}'`);
            const rest = current.filter((r) => r.id !== id);
            store.setReferenceImages(rest);
            return { ok: true, removed: id, referenceImages: listed(rest) };
          }
          const patch: Parameters<typeof upsertReferenceImage>[2] = readReferencePatch(msg);
          if (msg.height !== undefined && msg.width === undefined) {
            const h = Number(msg.height);
            if (!Number.isFinite(h) || h <= 0 || h > 20) throw new Error('height must be more than 0 and at most 20 m');
            patch.height = h;
          }
          if (typeof image === 'string' && image) {
            Object.assign(patch, await normalizeReferencePicture(image.startsWith('data:') ? image : `data:image/png;base64,${image}`));
          } else if (!id) {
            throw new Error('Give path (or image) to add a reference image, or imageId to change one');
          }
          const { images, image: placed } = upsertReferenceImage(
            useStore.getState().sceneGraph.referenceImages, id, patch, sceneContentBounds(store.sceneGraph.nodes),
          );
          store.setReferenceImages(images);
          return { ok: true, ...describeReferenceImage(placed), referenceImages: listed(images) };
        }

        case 'GET_TELEMETRY':
          return getPhysicsWorkerClient().getTelemetry().then(t => t || { error: 'No simulation telemetry available' });

        case 'GET_HISTORY': {
          // The worker holds up to 5000 frames, ~14 MB of JSON when full. No
          // agent can read that, so unless maxFrames is given (0 = no cap) the
          // stride is raised to fit 200 frames across whatever window was asked for.
          const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
          const { frames, total, stride } = await getPhysicsWorkerClient().getHistory({
            sinceTime: num(msg.sinceTime),
            last: num(msg.last),
            stride: num(msg.stride),
            maxFrames: num(msg.maxFrames) ?? 200,
            bodies: Array.isArray(msg.bodies) ? (msg.bodies as string[]) : undefined,
            include: Array.isArray(msg.include) ? (msg.include as HistoryQuery['include']) : undefined,
          });
          return { total, returned: frames.length, stride, frames };
        }

        case 'RUN_HEADLESS': {
          const ticks = Number(msg.ticks) || 300;
          const { sceneGraph, gravityZ, floorFriction, windX, windY, density, floorBounce } = store;
          // Runs inside the same physics worker that owns the live simulation
          // (see src/workers/physicsWorker.ts's runHeadless) — its own isolated
          // model/data built from the one already-loaded mujoco module, so a
          // headless "what-if" run can never diverge from what's actually
          // rendered live, and never costs a second loaded WASM module.
          const client = getPhysicsWorkerClient();
          const xml = compileToMJCF(sceneGraph, gravityZ, floorFriction, windX, windY, density, floorBounce, {
            meshFiles: client.meshFiles,
          });
          // Decimated in the worker, not here: a full per-tick, per-body
          // trajectory is ~500KB per 900 ticks, and striding only after the run
          // left the worker's 20,000-frame cap in force, so a long run stopped
          // early and told the caller to raise the stride it had already raised.
          const stride = Math.max(1, Math.floor(Number(msg.stride) || 1));
          const result: HeadlessResult = await client.runHeadless(xml, sceneGraph, ticks, stride);
          const bodyFilter = Array.isArray(msg.bodies) && msg.bodies.length > 0 ? new Set(msg.bodies as string[]) : null;
          if (result.ok && result.trajectory && bodyFilter) {
            result.trajectory = result.trajectory.map((fr: HistoryEntry) => ({
              ...fr,
              bodies: Object.fromEntries(Object.entries(fr.bodies || {}).filter(([k]) => bodyFilter.has(k))),
            }));
          }
          // How it ended, so the trajectory need not be read to find out.
          if (result.ok && result.trajectory) {
            return { ...result, final: summarizeTrajectory(result.trajectory) };
          }
          return result;
        }

        case 'GET_OBJECTS':
          return (store.sceneGraph.nodes || []).map(stripMeshArrays);

        case 'GET_OBJECT': {
          const targetId = typeof msg.targetId === 'string' ? msg.targetId : '';
          if (!targetId) throw new Error('Missing object id');
          const findNode = (nodesList: SceneNode[] | undefined): SceneNode | null => {
            if (!nodesList) return null;
            for (const node of nodesList) {
              if (node.id === targetId) return node;
              const child = findNode(node.children);
              if (child) return child;
            }
            return null;
          };
          const found = findNode(store.sceneGraph.nodes);
          if (!found) throw new Error(`Object not found: ${targetId}`);
          // The docs promise every mesh geom its size and integrity checks, as
          // physics_get_scene_summary gives them; this used to strip the arrays
          // and return nothing in their place.
          const withMeshChecks = (n: SceneNode): SceneNode => ({
            ...n,
            ...(n.geoms ? {
              geoms: n.geoms.map((g) => (g.type === 'mesh'
                ? { ...g, vertCount: (g.renderVertices || g.vertices || []).length / 3, faceCount: (g.faces || []).length / 3, bbox: bboxOf(g.renderVertices || g.vertices), ...meshIntegrity(g) }
                : g)),
            } : {}),
            ...(n.children ? { children: n.children.map(withMeshChecks) } : {}),
          });
          // Every O-ring groove on it, checked against what is round it now.
          const grooves = [...new Set((found.geoms || []).filter((g) => g.hardware?.part === 'groove').map((g) => g.hardware!.group))];
          const sealChecks = grooves.map((group) => ({ group, ...sealCheckFor(store.sceneGraph, found.id, group) }));
          return { ...stripMeshArrays(withMeshChecks(found)), ...(sealChecks.length ? { sealChecks } : {}) };
        }

        case 'UPDATE_OBJECT': {
          const requestedId = typeof msg.targetId === 'string' ? msg.targetId : '';
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rawUpdates = msg.updates as Partial<SceneNode> & Record<string, any>;
          if (!requestedId) throw new Error('Missing object id');
          if (!rawUpdates) throw new Error('Missing updates payload');
          // The store edits by id alone and ignores one it doesn't know, which
          // this handler then reported as ok:true.
          const target = findNodeInScene(store.sceneGraph.nodes, requestedId);
          if (!target) return { ok: false, error: `No object with id "${requestedId}"` };
          const targetId = target.id;

          // Extract declarative feature arrays if passed in updates
          const updates = { ...rawUpdates };
          const rawCuts = Array.isArray(updates.cuts) ? updates.cuts : undefined;
          const rawRoundEdges = updates.roundEdges !== undefined ? updates.roundEdges : updates.roundings;
          const normRoundEdges = Array.isArray(rawRoundEdges)
            ? rawRoundEdges
            : rawRoundEdges && typeof rawRoundEdges === 'object'
              ? [rawRoundEdges]
              : undefined;
          const rawPatterns = Array.isArray(updates.patterns)
            ? updates.patterns
            : updates.pattern && typeof updates.pattern === 'object'
              ? [updates.pattern]
              : undefined;
          const rawPaint = Array.isArray(updates.paint)
            ? updates.paint
            : updates.paint && typeof updates.paint === 'object'
              ? [updates.paint]
              : undefined;
          delete updates.cuts;
          delete updates.roundEdges;
          delete updates.roundings;
          delete updates.patterns;
          delete updates.pattern;
          delete updates.paint;

          if (updates.rgba !== undefined) {
            const norm = normalizeRgba(updates.rgba);
            if (!norm) return { ok: false, error: 'rgba must be [r, g, b] or [r, g, b, a], each 0..1' };
            updates.rgba = norm;
          }

          if (Array.isArray(updates.geoms)) {
            const geomResult = resolveUpdatedGeoms(target, updates.geoms, updates);
            if (!geomResult.ok) return { ok: false, error: geomResult.error };
            updates.geoms = geomResult.geoms;
            if (updates.geoms.some((g: SceneGeom) => g.csg === 'difference' || g.csg === 'intersection' || (g.type === 'cylinder' && (g.thread?.pitch ?? 0) > 0))) {
              updates.csgEnabled = true;
            }
          }

          if (rawCuts || normRoundEdges || rawPatterns || rawPaint) {
            pendingDeclarativeOps.set(targetId, {
              ...(rawCuts ? { cuts: rawCuts } : {}),
              ...(normRoundEdges ? { roundEdges: normRoundEdges } : {}),
              ...(rawPatterns ? { patterns: rawPatterns } : {}),
              ...(rawPaint ? { paint: rawPaint } : {}),
            });
          }

          // null or "" detaches the source: the body keeps the mesh it last
          // compiled to (or whatever geoms came with this call) as a plain
          // mesh. Compiling it would fail, and used to, leaving deleting and
          // re-adding the body as the only way out.
          if (updates.scad === null || updates.scad === '') updates.scad = undefined;

          if (updates.scad !== undefined) {
            let compiled: Awaited<ReturnType<typeof compileSCAD>> | null = null;
            let lastErr: unknown = null;
            for (let attempt = 0; attempt < 3 && !compiled; attempt++) {
              if (attempt > 0) await new Promise(r => setTimeout(r, 100));
              try {
                const result = await compileSCAD(updates.scad);
                if (result.faces.length === 0) {
                  lastErr = new Error('Compile produced an empty mesh (0 faces)');
                  continue;
                }
                compiled = result;
              } catch (err) {
                lastErr = err;
              }
            }
            if (!compiled) {
              pendingDeclarativeOps.delete(targetId);
              throw new Error(`Failed to compile SCAD: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
            }
            // Every other field in the same call goes in first: a SCAD body
            // sent with a new geoms array, a position or a name used to have
            // all of them dropped while the reply still said ok. The compiled
            // mesh then lands in the first mesh geom of whatever geoms the
            // body now has; a geoms array with no mesh in it gets one in front,
            // rather than having its first primitive overwritten.
            const { scad, ...rest } = updates;
            if (Array.isArray(rest.geoms) && !rest.geoms.some((g: SceneGeom) => g.type === 'mesh')) {
              const name = rest.name ?? target.name;
              const moves = (rest.joints ?? target.joints ?? []).length > 0;
              const meshRgba = updates.rgba ?? target.geoms?.find((g: SceneGeom) => g.type === 'mesh')?.rgba;
              rest.geoms = [{ ...fillGeomDefaults({ type: 'mesh', ...(meshRgba ? { rgba: meshRgba } : {}) }, name, 0, moves), name: `${name}_mesh` }, ...rest.geoms];
            }
            if (Object.keys(rest).length > 0) store.updateNode(targetId, rest);
            store.updateNodeScad(targetId, scad, compiled, false);
            await applyDeclarativePreCsgFeatures([target]);
            if (findNodeInScene(useStore.getState().sceneGraph.nodes, targetId)?.csgEnabled) {
              await compileCsgNodes(true);
            }
            await applyDeclarativePostCsgFeatures([target]);
            await useStore.getState().recompile(useStore.getState().sceneGraph, undefined, false, true);
          } else {
            if (Object.keys(updates).length > 0) {
              store.updateNode(targetId, updates);
            }
            await applyDeclarativePreCsgFeatures([target]);
            // An update that touches a boolean body (its geoms, its collision
            // mode, a csg marker) invalidates the generated mesh. The editor's
            // debounced auto-compiler would get to it eventually, but an MCP
            // caller is told ok:true synchronously — so do it here and await it.
            const compiled = await compileCsgNodes(true);
            await applyDeclarativePostCsgFeatures([target]);
            await useStore.getState().recompile(useStore.getState().sceneGraph, undefined, false, true);
            if (compiled > 0) {
              const node = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId);
              if (node?.csgError) return { ok: false, error: `Boolean failed: ${node.csgError}` };
            }
          }
          updateOrCreateNotecard({
            mode: 'mcp',
            nodes: useStore.getState().sceneGraph.nodes
          });
          const error = useStore.getState().lastCompileError;
          // Says what was taken, so a caller can see its whole update landed.
          return { ok: !error, applied: Object.keys(rawUpdates), ...(error ? { error } : {}) };
        }

        case 'SET_COLOR': {
          // The base colour of a body — what "make the imported bracket blue"
          // means. Paint (below) sits on top of this and is not disturbed by it.
          const { targetId, geomName, rgba } = msg as Msg<{ targetId: string; geomName?: string; rgba: number[] }>;
          if (!targetId) throw new Error('Missing targetId');
          if (!Array.isArray(rgba) || rgba.length < 3) throw new Error('rgba must be [r, g, b] or [r, g, b, a], each 0..1');
          const node = findNodeInScene(store.sceneGraph.nodes, targetId);
          if (!node) throw new Error(`No object with id '${targetId}'`);
          if (geomName && !(node.geoms || []).some((g: SceneGeom) => g.name === geomName)) {
            throw new Error(`Object '${targetId}' has no geom named '${geomName}'`);
          }
          store.setGeomColor(targetId, geomName, rgba);
          return { ok: true, geomsColored: geomName ? 1 : (node.geoms || []).length };
        }

        case 'PAINT': {
          // Brushed colour, laid down the way a human stroke is: dabs of
          // coverage at points on the surface, building up where they overlap.
          //
          // `at` is one point or a list of them, in the geom's own frame — so
          // the five pips of a die face are one call rather than five.
          // Also accepts `strokes: [{ geomName?, at, radius?, rgba, flow?, erase? }, ...]`
          // to apply multiple colours/brushes in one round-trip.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { targetId, strokes } = msg as Msg<{ targetId: string; strokes?: Record<string, any>[] }>;
          if (!targetId) throw new Error('Missing targetId');
          if (Array.isArray(strokes) && strokes.length > 0) {
            const results = [];
            let totalLanded = 0;
            let totalRequested = 0;
            for (const s of strokes) {
              const res = applyPaintStrokeToBody(targetId, s);
              results.push(res);
              totalLanded += Number(res.dabsLanded || 0);
              totalRequested += Number(res.dabsRequested || 0);
            }
            return { ok: true, id: targetId, strokesApplied: results.length, dabsLanded: totalLanded, dabsRequested: totalRequested, results };
          }
          return applyPaintStrokeToBody(targetId, msg);
        }

        /*
          Sculpting, driven by coordinates.

          Everything about the sculpt tools assumed a cursor: pick a brush, drag
          on the surface, and the viewport's raycast supplies the position and
          normal. None of that is available to a caller with no screen, so the
          whole subsystem — nine bases, six brushes, symmetry, dynamic topology —
          was unreachable over MCP. `at` is in the body's own frame in metres,
          the same convention PAINT uses, and utils/sculptCommands.ts snaps each
          point to the surface and reads the normal there.
        */
        case 'CREATE_SCULPT': {
          const { name, base, pos, sizeMm } = msg as Msg<{ name?: string; base?: SculptBaseId; sizeMm?: number }>;
          if (sizeMm !== undefined && !(typeof sizeMm === 'number' && sizeMm > 0)) throw new Error('sizeMm must be a positive number of millimetres');
          const parent = resolveParent(store.sceneGraph.nodes, msg.parent);
          const position = Array.isArray(pos) && pos.length === 3 ? pos : [0, 0, 0.3];
          if (base !== undefined && !SCULPT_BASES.some(b => b.id === base)) {
            throw new Error(`Unknown base '${base}'. Available: ${SCULPT_BASES.map(b => b.id).join(', ')}`);
          }
          /*
            addComponent picks its own id and finishes with a DEBOUNCED, async
            recompile, so the store still holds the old scene when it returns —
            reading the node list straight afterwards gives you the scene as it
            was.

            Taking "the last node" was that bug: it returned whatever the scene
            already ended with, and the rename below then renamed the user's
            existing body. So: remember every id, ask for the
            component, and wait for the one that appears.
          */
          const before = collectNodeIds(store.sceneGraph.nodes);
          // Under the `parent` asked for, or at the top level - never under
          // whatever happens to be selected. addComponent takes a world
          // position, and `pos` here is relative to the parent, as everywhere
          // else in the scene graph.
          const parentWorld = parent ? getNodeWorldPos(store.sceneGraph.nodes, parent.id) ?? [0, 0, 0] : [0, 0, 0];
          store.addComponent('sculpt', position.map((v: number, i: number) => v + parentWorld[i]), parent?.id ?? null);

          const created = await waitForNewNode(before, 10000);
          if (!created) throw new Error('The sculpt body was not created (timed out waiting for the scene to settle)');

          // Nested, it is fixed rigidly to its parent, like any body added
          // under one over MCP; the editor's own adds give a child a hinge.
          if (parent) store.updateNodeJointsList(created.id, []);
          if (base && base !== created.sculptBase) store.setSculptBase(created.id, base);
          if (sizeMm !== undefined) useStore.getState().resizeSculpt(created.id, sizeMm / 1000);
          if (typeof name === 'string' && name.trim()) store.renameNode(created.id, name.trim());

          const after = findNodeInScene(useStore.getState().sceneGraph.nodes, created.id);
          return {
            ok: true,
            id: created.id,
            name: after?.name,
            ...(parent ? { parent: parent.id } : {}),
            base: after?.sculptBase,
            ...sculptSummary(sculptMeshOf(after)),
          };
        }

        case 'SET_SCULPT_BASE': {
          const { targetId, base } = msg as Msg<{ targetId: string; base: SculptBaseId }>;
          if (!targetId) throw new Error('Missing targetId');
          if (!SCULPT_BASES.some(b => b.id === base)) {
            throw new Error(`Unknown base '${base}'. Available: ${SCULPT_BASES.map(b => b.id).join(', ')}`);
          }
          const node = findNodeInScene(store.sceneGraph.nodes, targetId);
          if (!node) throw new Error(`No object with id '${targetId}'`);
          if (!node.isSculpt) throw new Error(`'${targetId}' is not a sculpt body`);

          // Wholesale replacement: whatever was sculpted is discarded.
          store.setSculptBase(targetId, base);
          const after = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId);
          return { ok: true, id: targetId, base, ...sculptSummary(sculptMeshOf(after)) };
        }

        case 'RESIZE_SCULPT': {
          const { targetId, sizeMm } = msg as Msg<{ targetId: string; sizeMm: number | (number | null)[] }>;
          if (!targetId) throw new Error('Missing targetId');
          const node = findNodeInScene(store.sceneGraph.nodes, targetId);
          if (!node) throw new Error(`No object with id '${targetId}'`);
          if (!node.isSculpt) throw new Error(`'${targetId}' is not a sculpt body`);
          const limits = [MIN_SCULPT_SIZE * 1000, MAX_SCULPT_SIZE * 1000];
          const valid = (v: unknown) => typeof v === 'number' && v >= limits[0] && v <= limits[1];
          // A number is the longest side; [width, depth, height] sizes each
          // axis, a null keeping that one as it is.
          if (Array.isArray(sizeMm)) {
            if (sizeMm.length !== 3 || sizeMm.some((v) => v !== null && !valid(v))) {
              throw new Error(`sizeMm as a list is [width, depth, height] in mm, each ${limits[0]} to ${limits[1]} or null`);
            }
            store.resizeSculpt(targetId, sizeMm.map((v) => (v === null ? null : v / 1000)));
          } else {
            if (!valid(sizeMm)) throw new Error(`sizeMm must be between ${limits[0]} and ${limits[1]}, or [width, depth, height]`);
            store.resizeSculpt(targetId, sizeMm / 1000);
          }
          // Delta undo entries hold positions at the old scale; replaying one
          // would drag those vertices back to it.
          sculptHistory.delete(targetId);
          const after = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId);
          return { ok: true, id: targetId, ...sculptSummary(sculptMeshOf(after)), undoDepth: 0 };
        }

        case 'SCULPT': {
          // Every option below is handed straight to applySculptStroke, which
          // supplies its own default for each one it does not get.
          // Also accepts `strokes: [...]` to run a whole batch of brushes/strokes
          // in a single mesh update & recompile.
          const { targetId, brush, at, radius, strength, invert, symmetryX, symmetry, detail, dynamicTopology, delta, depthMm, hardness, strokes } =
            msg as Msg<{
              targetId: string; brush?: BrushType; radius?: number; strength?: number;
              depthMm?: number; hardness?: number;
              invert?: boolean; symmetryX?: boolean; symmetry?: 'x' | 'y' | 'z';
              detail?: number; dynamicTopology?: boolean; delta?: number[];
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              strokes?: Record<string, any>[];
            }>;
          const { node, geomIndex } = sculptTarget(store, targetId);

          const strokeList = Array.isArray(strokes) && strokes.length > 0
            ? strokes
            : [{ brush, at, radius, strength, invert, symmetryX, symmetry, detail, dynamicTopology, delta, depthMm, hardness }];

          const mesh = sculptMeshOf(node, geomIndex);
          let lastResult: ReturnType<typeof applySculptStroke> | null = null;
          let totalVerticesChanged = 0;

          for (const s of strokeList) {
            if (s.brush !== undefined && !BRUSH_TYPES.includes(s.brush)) {
              throw new Error(`Unknown brush '${s.brush}'. Available: ${BRUSH_TYPES.join(', ')}`);
            }
            const points: number[][] = pointList(s.at);
            if (!points.length || points.some((p: unknown) => !Array.isArray(p) || p.length < 3)) {
              throw new Error("at must be [x, y, z] or a list of them, in the body's own frame (metres)");
            }
            const sink: { undo?: SculptUndoEntry | null } = {};
            lastResult = applySculptStroke(mesh, {
              brush: s.brush,
              at: points,
              radius: s.radius,
              strength: s.strength,
              invert: s.invert,
              symmetryX: s.symmetryX,
              symmetry: s.symmetry,
              detail: s.detail,
              dynamicTopology: s.dynamicTopology,
              delta: s.delta,
              depthMm: s.depthMm,
              hardness: s.hardness,
            }, sink);
            totalVerticesChanged += lastResult.moved ?? 0;

            if (sink.undo) {
              const stack = sculptHistory.get(targetId) ?? [];
              stack.push(sink.undo);
              while (stack.length > SCULPT_HISTORY_DEPTH) stack.shift();
              sculptHistory.set(targetId, stack);
            }
          }

          /*
            Metadata first, geometry second, and no recompile of our own.
            updateNodeGeom treats a change of vertices as structural, so it
            rebuilds immediately and without the debounce; asking for another
            one here only queued a second build of the same state.
          */
          store.updateNode(targetId, {
            sculptEdited: true,
            sculptVersion: (node.sculptVersion ?? 1) + 1,
          });
          const { vertices, renderVertices, faces } = toSceneGeom(mesh);
          store.updateNodeGeom(targetId, { vertices, renderVertices, faces }, geomIndex);

          const error = useStore.getState().lastCompileError;
          return {
            ok: !error, ...(error ? { error } : {}), id: targetId,
            ...(lastResult ?? {}),
            ...(strokeList.length > 1 ? { strokesApplied: strokeList.length, verticesChanged: totalVerticesChanged } : {}),
            undoDepth: (sculptHistory.get(targetId) ?? []).length,
          };
        }

        case 'UNDO_SCULPT': {
          const { targetId } = msg as Msg<{ targetId: string }>;
          const { node, geomIndex } = sculptTarget(store, targetId);

          const stack = sculptHistory.get(targetId) ?? [];
          const entry = stack.pop();
          if (!entry) return { ok: false, error: 'No sculpt stroke of mine left to undo on this body', undoDepth: 0 };
          sculptHistory.set(targetId, stack);

          const mesh = sculptMeshOf(node, geomIndex);
          undoSculptStroke(mesh, entry);
          store.updateNode(targetId, { sculptVersion: (node.sculptVersion ?? 1) + 1 });
          const { vertices, renderVertices, faces } = toSceneGeom(mesh);
          store.updateNodeGeom(targetId, { vertices, renderVertices, faces }, geomIndex);

          return { ok: true, id: targetId, undoDepth: stack.length, ...sculptSummary(mesh) };
        }

        /*
          The scissors, without a screen: a polygon in the body's own frame,
          swept through the whole body along `direction` (default: the
          polygon's own normal) and taken out — or, with mode 'keep', kept and
          everything else taken out. `cap: false` leaves the cut open.

          Runs in the scissors' worker, so a cut of a dense sculpt does not
          stall the page, and is one entry in the same history UNDO_SCULPT
          pops.
        */
        case 'SCULPT_CUT': {
          const { targetId, polygon, direction, mode, cap } = msg as Msg<{
            targetId: string; polygon: number[][]; direction?: number[]; mode?: 'remove' | 'keep'; cap?: boolean;
          }>;
          const { node, geomIndex } = sculptTarget(store, targetId);
          if (!Array.isArray(polygon) || polygon.length < 3 || polygon.some((p: unknown) => !Array.isArray(p) || p.length < 3)) {
            throw new Error("polygon must be three or more [x, y, z] points, in the body's own frame (metres)");
          }
          if (direction !== undefined && (!Array.isArray(direction) || direction.length < 3)) {
            throw new Error('direction must be [x, y, z]');
          }
          if (mode !== undefined && mode !== 'remove' && mode !== 'keep') {
            throw new Error("mode must be 'remove' (take the prism out) or 'keep' (keep only the prism)");
          }

          const geomBefore = node.geoms?.[geomIndex];
          const mesh = sculptMeshOf(node, geomIndex);
          const result = await cutSculptOffThread(mesh, { kind: 'polygon', polygon, direction }, { mode, cap });
          return applySculptCutResult(targetId, geomIndex, geomBefore, mesh, result);
        }

        case 'SCULPT_CARVE': {
          const { targetId, path, widthMm, depthMm, profile = 'round', symmetry, fill, taper, angleDeg, mode = 'cut' } = msg as Msg<{
            targetId: string; path: number[][]; widthMm: number; depthMm?: number;
            profile?: CarveProfile; symmetry?: 'x' | 'y' | 'z'; fill?: boolean;
            taper?: number; angleDeg?: number; mode?: 'cut' | 'add';
          }>;
          const { node, geomIndex } = sculptTarget(store, targetId);
          const points = pointList(path);
          if (!points.length || points.some((p: unknown) => !Array.isArray(p) || p.length < 3)) {
            throw new Error("path must be [x, y, z] or a list of them, in the body's own frame (metres)");
          }
          if (mode !== 'cut' && mode !== 'add') throw new Error("mode must be 'cut' or 'add'");
          const add = mode === 'add';
          if (!(widthMm > 0) || (!add && !((depthMm ?? 0) > 0))) throw new Error('widthMm and depthMm must be positive millimetres');
          if (!['round', 'v', 'flat'].includes(profile)) throw new Error("profile must be 'round', 'v' or 'flat'");
          if (symmetry !== undefined && !['x', 'y', 'z'].includes(symmetry)) throw new Error("symmetry must be 'x', 'y' or 'z'");
          if (taper !== undefined && !(taper >= 0 && taper <= 0.5)) throw new Error('taper is the share of the length at each end, 0 to 0.5');

          // Snapped, filled and cut in the worker, which already holds the
          // mesh: done here, the closest-point searches on 80 k vertices held
          // the page long enough for the browser to call it crashed.
          const geomBefore = node.geoms?.[geomIndex];
          const mesh = sculptMeshOf(node, geomIndex);
          const result = await cutSculptOffThread(mesh, {
            kind: 'carvePath', path: points, width: widthMm / 1000, depth: (depthMm ?? 0) / 1000, profile,
            ...(symmetry ? { mirror: symmetry } : {}),
            fill: fill === true && !add,
            ...(taper ? { taper } : {}),
            ...(angleDeg ? { tilt: (angleDeg * Math.PI) / 180 } : {}),
            add,
          }, { mode: add ? 'add' : 'remove', cap: true });
          return applySculptCutResult(targetId, geomIndex, geomBefore, mesh, result);
        }

        /*
          Lattice modelling, driven by coordinates.

          The one thing in this app that is EASIER to drive without a screen than
          with one: the whole state is integers on a grid, so "the corner at
          20, -10, 0" is exactly a corner, is the same corner on the next call,
          and comes back out of physics_get_lattice in the form it went in.
          Callers speak millimetres in the body's own frame; see
          utils/latticeCommands.ts.
        */
        case 'CREATE_LATTICE': {
          const { name, pos, sizeMm, edit, empty, ops, subdiv: initSubdiv, thicknessMm: initThickness } = msg;
          const parent = resolveParent(useStore.getState().sceneGraph.nodes, msg.parent);
          const position: [number, number, number] = Array.isArray(pos) && pos.length === 3 ? [pos[0], pos[1], pos[2]] : [0, 0, 0.2];
          const firstOp = Array.isArray(ops) && ops.length > 0
            ? String(ops[0]?.op ?? ops[0]?.type ?? '').toLowerCase()
            : '';
          const startEmpty = empty === true || sizeMm === 0 || (sizeMm === undefined && firstOp === 'revolve');
          const size = typeof sizeMm === 'number' && sizeMm > 0 ? sizeMm : 40;
          const halfSteps = Math.max(1, Math.round((size / 2) / (LATTICE_UNIT * 1000)));

          const id = `lattice_${Math.random().toString(36).substring(2, 10)}`;
          const lat = startEmpty ? createLattice(LATTICE_UNIT) : boxLattice(LATTICE_UNIT, halfSteps);
          const { subdiv, thicknessMm } = runLatticeOps(
            lat,
            Array.isArray(ops) ? ops : [],
            typeof initSubdiv === 'number' ? initSubdiv : 0,
            typeof initThickness === 'number' ? initThickness : 0,
          );
          const cage = serializeCage(lat);
          const { vertices, renderVertices, faces, origin } = latticeToSceneGeom(deserializeCage(cage), subdiv, thicknessMm / 1000);

          const newNode: SceneNode = {
            id,
            name: (typeof name === 'string' && name.trim()) ? name.trim() : 'Lattice',
            type: 'body',
            pos: position,
            // Nested, it is fixed rigidly to its parent: a free joint is only
            // allowed at the top level.
            joints: parent ? [] : [{ name: `${id}_free`, type: 'free' }],
            geoms: [{
              name: `${id}_mesh`,
              type: 'mesh',
              size: [1],
              rgba: [0.55, 0.68, 0.85, 1],
              mass: 1,
              condim: 3,
              dynamic: true,
              latticeGeom: true,
              vertices,
              faces,
              renderVertices,
            }],
            children: [],
            isLattice: true,
            latticeCage: cage,
            latticeSubdiv: subdiv,
            ...(thicknessMm > 0 ? { latticeThickness: thicknessMm / 1000 } : {}),
            latticeVersion: 1,
            latticeOrigin: origin,
          };

          const currentNodes = useStore.getState().sceneGraph.nodes || [];
          const updatedNodes = parent ? withChild(currentNodes, parent.id, newNode) : [...currentNodes, newNode];
          const settleRes = await settleScene(updatedNodes, { replacesScene: false });
          if (!settleRes.ok) {
            throw new Error(`The lattice body failed to compile: ${settleRes.error}`);
          }

          // Opening the tools is opt-in: it takes over the viewport and pauses
          // the simulation, which is rude to do to somebody mid-task, but it is
          // exactly what is wanted when a person is about to carry on by hand.
          if (edit) useStore.getState().setLatticeNodeId(id);

          return {
            ok: true, id, name: newNode.name,
            ...(parent ? { parent: parent.id } : {}),
            ...(Array.isArray(ops) && ops.length > 0 ? { opsApplied: ops.length } : {}),
            ...latticeSummary(deserializeCage(cage)),
          };
        }

        case 'LATTICE_FACES': {
          const { targetId, faces, mirror } = msg as Msg<{ targetId: string }>;
          const { node, lattice } = latticeTarget(store, targetId);
          const before = cloneLattice(lattice);
          const result = addFacesMm(lattice, faces, mirror as LatticeAxis | undefined);
          if (result.added === 0) {
            return { ok: false, id: targetId, error: 'No face was added', ...result, ...latticeSummary(lattice) };
          }
          pushLatticeHistory(targetId, before);
          commitLattice(node, lattice);
          return { ok: true, id: targetId, ...result, ...latticeSummary(lattice), undoDepth: (latticeHistory.get(targetId) ?? []).length };
        }

        case 'LATTICE_EXTRUDE': {
          const { targetId, face, distanceMm, axis, mirror } = msg as Msg<{ targetId: string }>;
          const { node, lattice } = latticeTarget(store, targetId);
          if (typeof distanceMm !== 'number' || !Number.isFinite(distanceMm)) {
            throw new Error('distanceMm must be a number of millimetres to push the face out by');
          }
          const before = cloneLattice(lattice);
          const result = extrudeMm(lattice, face, distanceMm, axis as LatticeAxis | undefined, mirror as LatticeAxis | undefined);
          pushLatticeHistory(targetId, before);
          commitLattice(node, lattice);
          return { ok: true, id: targetId, ...result, ...latticeSummary(lattice), undoDepth: (latticeHistory.get(targetId) ?? []).length };
        }

        case 'LATTICE_DELETE_FACES': {
          const { targetId, faces, mirror } = msg as Msg<{ targetId: string }>;
          const { node, lattice } = latticeTarget(store, targetId);
          const before = cloneLattice(lattice);
          const result = removeFacesMm(lattice, faces, mirror as LatticeAxis | undefined);
          if (result.removed === 0) {
            return { ok: false, id: targetId, error: 'No face was removed', ...result, ...latticeSummary(lattice) };
          }
          pushLatticeHistory(targetId, before);
          commitLattice(node, lattice);
          return { ok: true, id: targetId, ...result, ...latticeSummary(lattice), undoDepth: (latticeHistory.get(targetId) ?? []).length };
        }

        case 'LATTICE_SHARPEN': {
          const { targetId, edges, sharp, mirror, loop } = msg as Msg<{ targetId: string }>;
          const { node, lattice } = latticeTarget(store, targetId);
          const before = cloneLattice(lattice);
          const result = sharpenEdgesMm(lattice, edges, sharp !== false, mirror as LatticeAxis | undefined, loop === true);
          if (result.changed === 0) {
            return { ok: false, id: targetId, error: 'No edge changed', ...result, ...latticeSummary(lattice) };
          }
          pushLatticeHistory(targetId, before);
          commitLattice(node, lattice);
          return { ok: true, id: targetId, ...result, ...latticeSummary(lattice), undoDepth: (latticeHistory.get(targetId) ?? []).length };
        }

        case 'LATTICE_SMOOTH': {
          const { targetId, level } = msg as Msg<{ targetId: string }>;
          const { node } = latticeTarget(store, targetId);
          const wanted = Math.max(0, Math.min(2, Math.round(Number(level) || 0)));
          useStore.getState().setLatticeSubdiv(node.id, wanted);
          const after = findNodeInScene(useStore.getState().sceneGraph.nodes, node.id);
          const mesh = after?.geoms?.find((g: SceneGeom) => g.type === 'mesh');
          return {
            ok: true, id: node.id, level: wanted,
            ...latticeSummary(latticeOf(after)),
            // The cage is unchanged; what smoothing changes is the mesh built
            // from it, which is what everything downstream actually sees.
            meshTriangles: mesh?.faces ? mesh.faces.length / 3 : 0,
          };
        }

        case 'LATTICE_INSET': {
          const { targetId, face, amountMm, mirror } = msg as Msg<{ targetId: string; amountMm: number }>;
          const { node, lattice } = latticeTarget(store, targetId);
          const before = cloneLattice(lattice);
          const result = insetFaceMm(lattice, face, amountMm, mirror as LatticeAxis | undefined);
          pushLatticeHistory(targetId, before);
          commitLattice(node, lattice);
          return { ok: true, id: targetId, ...result, ...latticeSummary(lattice), undoDepth: (latticeHistory.get(targetId) ?? []).length };
        }

        case 'LATTICE_BEVEL': {
          const { targetId, face, amountMm, mirror } = msg as Msg<{ targetId: string; amountMm: number }>;
          const { node, lattice } = latticeTarget(store, targetId);
          const before = cloneLattice(lattice);
          const result = bevelFaceMm(lattice, face, amountMm, mirror as LatticeAxis | undefined);
          pushLatticeHistory(targetId, before);
          commitLattice(node, lattice);
          return { ok: true, id: targetId, ...result, ...latticeSummary(lattice), undoDepth: (latticeHistory.get(targetId) ?? []).length };
        }

        case 'LATTICE_BEVEL_EDGES': {
          const { targetId, edges, radiusMm, mode, mirror, loop } = msg as Msg<{ targetId: string; radiusMm: number }>;
          const { node, lattice } = latticeTarget(store, targetId);
          const before = cloneLattice(lattice);
          const result = bevelEdgesMm(
            lattice, edges, radiusMm,
            mode === 'fillet' ? 'fillet' : 'chamfer',
            mirror as LatticeAxis | undefined,
            loop === true,
          );
          pushLatticeHistory(targetId, before);
          commitLattice(node, lattice);
          return { ok: true, id: targetId, ...result, ...latticeSummary(lattice), undoDepth: (latticeHistory.get(targetId) ?? []).length };
        }

        case 'LATTICE_CIRCLE': {
          const { targetId, centre, diameterMm, axis, sides, mirror } = msg as Msg<{ targetId: string; diameterMm: number }>;
          const { node, lattice } = latticeTarget(store, targetId);
          const before = cloneLattice(lattice);
          const result = addRingMm(
            lattice, centre, diameterMm,
            (axis as LatticeAxis) || 'z',
            typeof sides === 'number' ? sides : 0,
            mirror as LatticeAxis | undefined,
          );
          pushLatticeHistory(targetId, before);
          commitLattice(node, lattice);
          return { ok: true, id: targetId, ...result, ...latticeSummary(lattice), undoDepth: (latticeHistory.get(targetId) ?? []).length };
        }

        case 'LATTICE_REVOLVE': {
          const { targetId, profile, axis, degrees, throughMm, segments, closed } = msg as Msg<{ targetId: string }>;
          const { node, lattice } = latticeTarget(store, targetId);
          const before = cloneLattice(lattice);
          const result = revolveMm(
            lattice, profile, (axis as LatticeAxis) || 'z',
            typeof degrees === 'number' ? degrees : 360,
            {
              throughMm: Array.isArray(throughMm) ? throughMm : undefined,
              segments: typeof segments === 'number' ? segments : 0,
              closed: closed === true,
            },
          );
          pushLatticeHistory(targetId, before);
          commitLattice(node, lattice);
          return { ok: true, id: targetId, ...result, ...latticeSummary(lattice), undoDepth: (latticeHistory.get(targetId) ?? []).length };
        }

        case 'MEASURE': {
          const { from, to, corner, snap, withinMm } = msg;
          // Which way a body points, rather than a distance: `body` with an
          // optional local `axis`. Read from the simulation's latest frame when
          // it has one, else from the body as authored.
          if (typeof msg.body === 'string') {
            const wanted = msg.body;
            const byName = (list: SceneNode[]): SceneNode | null => {
              for (const n of list) {
                if (n.name === wanted) return n;
                const hit = byName(n.children || []);
                if (hit) return hit;
              }
              return null;
            };
            const node = findNodeInScene(store.sceneGraph.nodes, wanted) ?? byName(store.sceneGraph.nodes);
            if (!node) return { ok: false, error: `No body with id or name "${wanted}"` };
            const axis = msg.axis === 'x' || msg.axis === 'y' ? msg.axis : 'z';
            const { frames } = await getPhysicsWorkerClient().getHistory({ last: 1, bodies: [node.id], maxFrames: 1 });
            const live = frames[frames.length - 1]?.bodies?.[node.id]?.quat;
            const quat = live ?? authoredQuat(node);
            return {
              ok: true,
              body: node.id,
              axis,
              source: live ? 'simulation' : 'authored',
              ...(live ? { atTime: frames[frames.length - 1].time } : {}),
              quat,
              ...orientationOf(quat, axis),
            };
          }
          const point = (value: unknown, name: string): [number, number, number] => {
            if (!Array.isArray(value) || value.length < 3 || !value.every((v) => typeof v === 'number' && Number.isFinite(v))) {
              throw new Error(`${name} must be a point [x, y, z] in metres, in the world frame`);
            }
            return [value[0], value[1], value[2]];
          };
          // The DRAWN scene, not the document: that is where the transforms
          // have been applied, where a boolean has been evaluated, and where a
          // lattice cage has already become the mesh anybody would measure.
          const root = (window as unknown as { _physics_scene?: Object3D })._physics_scene ?? null;
          return {
            ok: true,
            ...measureInScene(root, point(from, 'from'), point(to, 'to'), {
              corner: corner === undefined ? undefined : point(corner, 'corner'),
              snap: snap !== false,
              withinMm: typeof withinMm === 'number' ? withinMm : 3,
            }),
            snapped: snap !== false && root !== null,
          };
        }

        case 'LATTICE_BRIDGE': {
          const { targetId, faceA, faceB } = msg as Msg<{ targetId: string }>;
          const { node, lattice } = latticeTarget(store, targetId);
          const before = cloneLattice(lattice);
          const result = bridgeFacesMm(lattice, faceA, faceB);
          pushLatticeHistory(targetId, before);
          commitLattice(node, lattice);
          return { ok: true, id: targetId, ...result, ...latticeSummary(lattice), undoDepth: (latticeHistory.get(targetId) ?? []).length };
        }

        case 'LATTICE_DIMENSION': {
          const { targetId, corners, axis, mode, valueMm } = msg as Msg<{ targetId: string }>;
          const { node, lattice } = latticeTarget(store, targetId);
          const which = (axis === 'x' || axis === 'y' || axis === 'z') ? axis : null;
          if (!which) return { ok: false, error: "axis must be 'x', 'y' or 'z'" };
          const how = mode === 'position' ? 'position' : 'size';
          if (typeof valueMm !== 'number' || !Number.isFinite(valueMm)) {
            return { ok: false, error: 'valueMm must be a number, in millimetres' };
          }
          const before = cloneLattice(lattice);
          const result = dimensionSelectionMm(lattice, corners, which, how, valueMm);
          if (!result.changed) {
            // Not an error. Asking for the size something already is, or for a
            // size on an axis it is flat along, is a no-op and saying so is
            // more use than a failure the caller has to interpret.
            return { ok: true, id: targetId, ...result, ...latticeSummary(lattice) };
          }
          pushLatticeHistory(targetId, before);
          commitLattice(node, lattice);
          return {
            ok: true, id: targetId, ...result, ...latticeSummary(lattice),
            undoDepth: (latticeHistory.get(targetId) ?? []).length,
          };
        }

        /*
         * Rounded and bevelled edges. GET_EDGES lists what can be rounded, with
         * ids; ROUND_EDGES rounds some of them — by id, or by a group a person
         * would name (all, top, bottom, vertical). The edges are found on the
         * body as modelled, before any rounding, so ids stay put while its
         * roundings change. See utils/edgeRound.ts.
         */
        case 'GET_EDGES': {
          const { targetId } = msg as Msg<{ targetId: string }>;
          const node = findNodeInScene(store.sceneGraph.nodes, targetId);
          const why = whyNotRoundable(node);
          if (why) return { ok: false, error: node ? why : `No object with id '${targetId}'` };
          const found = await bodyEdges(node!, bodyUp(store.sceneGraph.nodes, targetId));
          const mm = (p: number[]) => p.map((v) => Math.round(v * 1e6) / 1e3);
          const roundedBy = (e: EdgeCandidate) => (node!.edgeRounds ?? []).findIndex((f) => f.edges.some((x) => sameEdge(x, e.edge)));
          return {
            ok: true,
            id: targetId,
            edges: found.edges.map((e) => ({
              id: e.id,
              kind: e.edge.kind,
              ...(e.edge.kind === 'line'
                ? { fromMm: mm(e.edge.a), toMm: mm(e.edge.b) }
                : { centreMm: mm(e.edge.centre), diameterMm: Math.round(e.edge.radius * 2e6) / 1e3, axis: e.edge.axis.map((v) => Math.round(v * 1000) / 1000) }),
              convex: e.edge.convex,
              angleDeg: Math.round(e.angleDeg * 10) / 10,
              groups: e.edge.convex ? (['top', 'bottom', 'vertical'] as const).filter((g) => e[g]) : ['inside'],
              maxRoundMm: Math.round(maxSizeFor([e], 'fillet') * 1e5) / 100,
              maxBevelMm: Math.round(maxSizeFor([e], 'chamfer') * 1e5) / 100,
              ...(roundedBy(e) >= 0 ? { roundedBy: roundedBy(e) } : {}),
            })),
            // Edges that were found but are neither straight nor a full circle.
            unroundable: found.other.length,
            roundings: (node!.edgeRounds ?? []).map((f, i) => ({
              index: i, mode: f.mode === 'fillet' ? 'round' : 'bevel', sizeMm: Math.round(f.size * 1e5) / 100, edges: f.edges.length,
            })),
          };
        }

        case 'ROUND_EDGES': {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { targetId, roundings } = msg as Msg<{ targetId: string; roundings?: Record<string, any>[] }>;
          const specs = Array.isArray(roundings) && roundings.length > 0 ? roundings : [msg];
          return await applyRoundEdgesToBody(targetId, specs, true);
        }

        case 'BODY_CUT': {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { targetId, cuts } = msg as Msg<{ targetId: string; cuts?: Record<string, any>[] }>;
          const node = findNodeInScene(store.sceneGraph.nodes, targetId);
          if (!node) return { ok: false, error: `No object with id '${targetId}'` };
          const specs = Array.isArray(cuts) && cuts.length > 0 ? cuts : [msg];
          const results = [];
          for (const spec of specs) {
            const res = applySingleCutToBody(targetId, spec);
            if (!res.ok) return res;
            results.push(res);
          }
          await compileCsgNodes(true);
          await useStore.getState().recompile(useStore.getState().sceneGraph, undefined, false, true);
          const after = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId);
          if (after?.csgError) return { ok: false, error: `Cut boolean failed: ${after.csgError}` };
          if (results.length === 1) return results[0];
          return { ok: true, id: targetId, cutsApplied: results.length, cuts: results };
        }

        case 'ADD_HARDWARE': {
          const { kind, size, lengthMm, washer, into, group, at, fixTo, id: existing, between } = msg as Msg<{
            kind: string; size?: string | number; lengthMm?: number; washer?: boolean; into?: string; group?: string; at?: number[];
            fixTo?: string; id?: string; between?: string[];
          }>;
          // A part already in the scene: only fix a body to its moving piece.
          if (existing) {
            const part = findNodeInScene(store.sceneGraph.nodes, existing);
            const piece = part && (part.hardwarePart?.piece ? part : movingPieceOf(part));
            if (!piece) return { ok: false, error: `'${existing}' has no moving piece to fix a body to` };
            if (!fixTo) return { ok: false, error: 'Give fixTo: the body to weld to its moving piece' };
            const why = store.fixToPiece(piece.id, fixTo);
            return why ? { ok: false, error: why } : { ok: true, id: existing, pieceId: piece.id, fixed: fixTo };
          }
          if (typeof kind !== 'string' || !(kind in HARDWARE_PARTS)) {
            return { ok: false, error: `kind must be one of ${Object.keys(HARDWARE_PARTS).join(', ')}` };
          }
          const partKind = kind as HardwarePartKind;
          const info = HARDWARE_PARTS[partKind];
          if (size !== undefined && !info.sizes.includes(String(size))) {
            return { ok: false, error: `${info.label} comes in ${info.sizes.join(', ')}; got '${size}'` };
          }
          if (into && !findNodeInScene(store.sceneGraph.nodes, into)) return { ok: false, error: `No object with id '${into}'` };
          let id: string | null;
          const housing = into && group ? findNodeInScene(store.sceneGraph.nodes, into)?.geoms?.find((g) => g.hardware?.group === group)?.hardware?.kind === 'lm_housing' : false;
          if (housing) {
            // A housing takes no part of its own: it rides the rod on its line.
            const why = store.rideOnRod(into!, group!);
            if (why) return { ok: false, error: why };
            const host = findNodeInScene(useStore.getState().sceneGraph.nodes, into!);
            return { ok: true, id: into, ridesOn: host?.weldTargetId };
          }
          if (partKind === 'drawer_runner' && into && !group) {
            const fitted = store.addDrawerRunners(into);
            if (typeof fitted === 'string') return { ok: false, error: fitted };
            await useStore.getState().recompile(useStore.getState().sceneGraph, undefined, false, true);
            const after = useStore.getState().sceneGraph.nodes;
            return {
              ok: true, ids: fitted,
              runners: fitted.map((rid) => {
                const r = findNodeInScene(after, rid);
                return { id: rid, name: r?.name, posMm: r?.pos.map((v) => Math.round(v * 1e6) / 1000), weldedTo: r?.weldTargetId };
              }),
            };
          }
          // Extrusion: a joining piece goes where two profiles meet, a carriage onto its V-slot.
          const joinKind = kind === 'corner_bracket' || kind === 'joint_plate' || kind === 'end_tap' ? kind : null;
          if (joinKind) {
            if (!Array.isArray(between) || between.length !== 2) return { ok: false, error: `A ${info.label.toLowerCase()} joins two profiles: give their ids as between: [a, b]` };
            const joined = store.joinProfiles(between[0], between[1], joinKind, size !== undefined ? String(size) : undefined);
            if ('problem' in joined) return { ok: false, error: joined.problem };
            id = joined.id;
          } else if (kind === 'vslot_carriage') {
            if (!into) return { ok: false, error: 'A V-slot carriage runs on a profile: give its id as into' };
            const placed = store.addCarriage(into);
            if ('problem' in placed) return { ok: false, error: placed.problem };
            id = placed.id;
          } else if (into && group) {
            id = store.seatHardwarePart(into, group, partKind);
            if (!id) return { ok: false, error: `'${into}' has no hardware cut '${group}' that takes a ${info.label.toLowerCase()}` };
          } else {
            const pos = Array.isArray(at) && at.length >= 3 ? at.map((v) => v / 1000) : [0, 0, 0.03];
            id = store.addHardwarePart(partKind, pos, into ?? null);
          }
          if (!id) return { ok: false, error: 'The part could not be added' };
          if (fixTo) {
            const added = findNodeInScene(useStore.getState().sceneGraph.nodes, id);
            const piece = added && movingPieceOf(added);
            const why = piece ? useStore.getState().fixToPiece(piece.id, fixTo) : `A ${info.label.toLowerCase()} has no moving piece to fix a body to`;
            if (why) return { ok: false, error: why, id };
          }
          if (!joinKind && kind !== 'vslot_carriage' && (size !== undefined || lengthMm !== undefined || washer !== undefined)) {
            useStore.getState().setHardwarePart(id, {
              ...(size !== undefined ? { size: String(size) } : {}),
              ...(typeof lengthMm === 'number' ? { lengthMm } : {}),
              ...(typeof washer === 'boolean' ? { washer } : {}),
            });
          }
          await compileCsgNodes(true);
          await useStore.getState().recompile(useStore.getState().sceneGraph, undefined, false, true);
          const part = findNodeInScene(useStore.getState().sceneGraph.nodes, id);
          const spec = part?.hardwarePart;
          if (!part || !spec) return { ok: false, error: 'The part could not be added' };
          return {
            ok: true, id, name: part.name, kind: spec.kind, size: spec.size,
            ...(spec.lengthMm !== undefined ? { lengthMm: spec.lengthMm } : {}),
            ...(spec.washer ? { washer: true } : {}),
            ...(spec.seat ? { seatedIn: spec.seat === 'bore' ? 'bearing bore' : spec.seat } : {}),
            ...(spec.fastens ? { fastens: spec.fastens } : {}),
            ...(part.weldTargetId ? { weldedTo: part.weldTargetId } : {}),
            ...(part.children.some((c) => c.hardwarePart?.piece === 'inner')
              ? { innerRaceId: part.children.find((c) => c.hardwarePart?.piece === 'inner')!.id } : {}),
            posMm: part.pos.map((v) => Math.round(v * 1e6) / 1000),
            ...(spec.kind === 'oring' && into && spec.seat ? { sealCheck: sealCheckFor(useStore.getState().sceneGraph, into, spec.seat) } : {}),
          };
        }

        case 'COMBINE_BODIES': {
          const { targetId, withIds, op } = msg as Msg<{ targetId: string }>;
          const sources = Array.isArray(withIds) ? withIds.filter((v: unknown): v is string => typeof v === 'string') : [];
          if (sources.length === 0) return { ok: false, error: 'Give the ids of the bodies to merge in, as withIds' };
          const target = findNodeInScene(store.sceneGraph.nodes, targetId);
          if (!target) return { ok: false, error: `No object with id '${targetId}'` };
          const missing = sources.filter((id: string) => !findNodeInScene(store.sceneGraph.nodes, id));
          if (missing.length > 0) return { ok: false, error: `No object with id '${missing.join("', '")}'` };
          const how = op === 'difference' || op === 'subtract' ? 'difference'
            : op === 'intersection' || op === 'intersect' ? 'intersection' : 'union';

          const before = (target.geoms || []).length;
          store.combineBodies(targetId, sources, how);
          await compileCsgNodes(true);
          await useStore.getState().recompile(useStore.getState().sceneGraph, undefined, false, true);
          const after = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId);
          if (after?.csgError) return { ok: false, error: `Combine boolean failed: ${after.csgError}` };
          return {
            ok: true,
            id: targetId,
            op: how,
            merged: sources,
            shapesAdded: (after?.geoms || []).filter((g: SceneGeom) => !g.csgDerived).length - before,
            geoms: (after?.geoms || []).filter((g: SceneGeom) => !g.csgDerived).map((g: SceneGeom) => g.name),
          };
        }

        case 'LATTICE_ORIENT': {
          const { targetId } = msg as Msg<{ targetId: string }>;
          const { node, lattice } = latticeTarget(store, targetId);
          const before = cloneLattice(lattice);
          const flipped = orientFaces(lattice);
          if (flipped === 0) {
            return { ok: true, id: targetId, flipped: 0, ...latticeSummary(lattice) };
          }
          pushLatticeHistory(targetId, before);
          commitLattice(node, lattice);
          return { ok: true, id: targetId, flipped, ...latticeSummary(lattice), undoDepth: (latticeHistory.get(targetId) ?? []).length };
        }

        case 'LATTICE_WALL': {
          const { targetId, thicknessMm } = msg as Msg<{ targetId: string }>;
          const { node } = latticeTarget(store, targetId);
          const mm = Math.max(0, Number(thicknessMm) || 0);
          useStore.getState().setLatticeThickness(node.id, mm);
          const after = findNodeInScene(useStore.getState().sceneGraph.nodes, node.id);
          const mesh = after?.geoms?.find((g: SceneGeom) => g.type === 'mesh');
          return {
            ok: true, id: node.id, thicknessMm: mm,
            ...latticeSummary(latticeOf(after)),
            // The CAGE stays open — the wall is built when the mesh is, so the
            // watertight figure above is about the surface being edited and
            // this is about the thing that gets exported.
            meshTriangles: mesh?.faces ? mesh.faces.length / 3 : 0,
          };
        }

        case 'UNDO_LATTICE': {
          const { targetId } = msg as Msg<{ targetId: string }>;
          const { node } = latticeTarget(store, targetId);
          const stack = latticeHistory.get(node.id) ?? [];
          const snapshot = stack.pop();
          if (!snapshot) return { ok: false, error: 'No lattice operation of mine left to undo on this body', undoDepth: 0 };
          latticeHistory.set(node.id, stack);
          commitLattice(node, snapshot);
          return { ok: true, id: node.id, undoDepth: stack.length, ...latticeSummary(snapshot) };
        }

        case 'GET_LATTICE': {
          const { targetId } = msg as Msg<{ targetId: string }>;
          const { lattice } = latticeTarget(store, targetId);
          return { ok: true, id: targetId, ...describeLattice(lattice) };
        }

        case 'PROBE_SCULPT': {
          const { targetId, at } = msg as Msg<{ targetId: string }>;
          const { node, geomIndex } = sculptTarget(store, targetId);
          const points: number[][] = pointList(at);
          if (!points.length || points.some((p: unknown) => !Array.isArray(p) || p.length < 3)) {
            throw new Error("at must be [x, y, z] or a list of them, in the body's own frame (metres)");
          }
          return { ok: true, id: targetId, points: probeSurface(sculptMeshOf(node, geomIndex), points) };
        }

        /*
         * Weld one body to another, and say what it takes to shear the weld off.
         *
         * Both halves were reachable only from here before the Constraints panel
         * existed, and the thresholds are new. Nothing set here reaches the
         * emitted MJCF: a weld's limit is checked every step against the force
         * MuJoCo reports for holding it, so it costs nothing until it trips.
         */
        case 'SET_CONSTRAINT': {
          const { targetId, weldTo, connectTo, breakForceN, breakTorqueNm, breakHoldSteps } =
            msg as Msg<{
              targetId: string; weldTo?: string | null; connectTo?: string | null;
              breakForceN?: number | null; breakTorqueNm?: number | null; breakHoldSteps?: number | null;
            }>;
          if (!targetId) throw new Error('Missing targetId');
          const node = findNodeInScene(store.sceneGraph.nodes, targetId);
          if (!node) throw new Error(`No object with id '${targetId}'`);

          const updates: Partial<SceneNode> = {};
          for (const [field, value] of [
            ['weldTargetId', weldTo], ['connectTargetId', connectTo],
          ] as const) {
            if (value === undefined) continue;
            if (value === null || value === '') { updates[field] = undefined; continue; }
            const target = findNodeInScene(store.sceneGraph.nodes, value);
            if (!target) throw new Error(`No object with id '${value}' to attach to`);
            if (target.id === node.id) return { ok: false, error: 'A body cannot be attached to itself' };
            updates[field] = target.id;
          }
          // null clears a threshold; undefined leaves it alone. Without the
          // distinction there is no way to make a weld unbreakable again.
          if (breakForceN !== undefined) updates.weldBreakForceN = breakForceN ?? undefined;
          if (breakTorqueNm !== undefined) updates.weldBreakTorqueNm = breakTorqueNm ?? undefined;
          if (breakHoldSteps !== undefined) updates.weldBreakHoldSteps = breakHoldSteps ?? undefined;

          store.updateNode(node.id, updates);
          const after = findNodeInScene(useStore.getState().sceneGraph.nodes, node.id);
          return {
            ok: true, id: node.id, name: node.name,
            weldTargetId: after?.weldTargetId ?? null,
            connectTargetId: after?.connectTargetId ?? null,
            weldBreakForceN: after?.weldBreakForceN ?? null,
            weldBreakTorqueNm: after?.weldBreakTorqueNm ?? null,
            weldBreakHoldSteps: after?.weldBreakHoldSteps ?? null,
          };
        }

        /*
         * What has come apart in this run, and putting it back.
         *
         * Breakage is transient — the scene graph still says everything is
         * welded on — so this is the only way to see it from outside.
         */
        /*
         * A crumple zone: a joint that is rigid until it is overloaded, and
         * then folds and stays folded.
         *
         * Set on a JOINT rather than on a body, because that is what folds. The
         * lock holding it still is an ordinary weld equality the MJCF builder
         * emits, so nothing new reaches the solver.
         */
        case 'SET_CRUMPLE': {
          const { targetId, jointName, crumpleTorqueNm, crumpleRangeDeg, crumpleDampingAfter } =
            msg as Msg<{
              targetId: string; jointName?: string;
              crumpleTorqueNm?: number | null;
              crumpleRangeDeg?: [number, number];
              crumpleDampingAfter?: number;
            }>;
          if (!targetId) throw new Error('Missing targetId');
          const node = findNodeInScene(store.sceneGraph.nodes, targetId);
          if (!node) throw new Error(`No object with id '${targetId}'`);

          const joints = node.joints || [];
          const joint = jointName
            ? joints.find((j) => j.name === jointName)
            : joints.find((j) => j.type === 'hinge' || j.type === 'slide');
          if (!joint) {
            return { ok: false, error: jointName
              ? `'${targetId}' has no joint named '${jointName}'`
              : `'${targetId}' has no hinge or slider to crumple — a free or ball joint has no single axis to fold about` };
          }

          const updates: Partial<typeof joint> = {};
          if (crumpleTorqueNm !== undefined) updates.crumpleTorqueNm = crumpleTorqueNm ?? undefined;
          if (crumpleRangeDeg !== undefined) updates.crumpleRangeDeg = crumpleRangeDeg;
          if (crumpleDampingAfter !== undefined) updates.crumpleDampingAfter = crumpleDampingAfter;
          store.updateNodeJoint(node.id, updates, joints.indexOf(joint));

          const after = findNodeInScene(useStore.getState().sceneGraph.nodes, node.id)
            ?.joints?.find((j) => j.name === joint.name);
          return {
            ok: true, id: node.id, joint: joint.name,
            crumpleTorqueNm: after?.crumpleTorqueNm ?? null,
            crumpleRangeDeg: after?.crumpleRangeDeg ?? null,
            crumpleDampingAfter: after?.crumpleDampingAfter ?? null,
          };
        }

        case 'GET_BREAKS': {
          const state = useStore.getState();
          const dents = useDentStore.getState().dents;
          return {
            ok: true,
            // Weld keys look like 'weld:<nodeId>-><targetId>'; a crumple zone
            // that has given looks like 'crumple:<jointName>'.
            broken: state.brokenConstraints,
            last: state.lastBreak ?? null,
            shattered: Object.entries(state.shatteredBodies).map(([id, shards]) => ({ id, pieces: shards.length })),
            lastShatter: state.lastShatter ?? null,
            dented: Object.entries(dents).map(([key, d]) => ({
              key, dents: d.count, deepestMm: +(d.deepest * 1000).toFixed(2),
            })),
          };
        }

        /*
         * Brittleness and dentability, the two impact thresholds.
         *
         * Both are measured in newton-seconds — momentum — rather than force,
         * because contact force in a hard solver is a spike whose height
         * depends on the timestep. Neither reaches the emitted MJCF: they are
         * compared every step against what MuJoCo already reports.
         */
        case 'SET_IMPACT': {
          const { targetId, shatterImpulseNs, shatterPieces, shatterSeed, shatterPattern, shatterSpread, shatterDepth,
                  dentYieldNs, dentDepthPerNs, dentRadius, dentMaxDepth, pierceImpulseNs, deformCollision, geomName } =
            msg as Msg<{
              targetId: string;
              shatterImpulseNs?: number | null; shatterPieces?: number; shatterSeed?: number;
              shatterPattern?: 'uniform' | 'radial'; shatterSpread?: number; shatterDepth?: number;
              dentYieldNs?: number | null; dentDepthPerNs?: number; dentRadius?: number; dentMaxDepth?: number;
              pierceImpulseNs?: number | null; deformCollision?: boolean;
              geomName?: string;
            }>;
          if (!targetId) throw new Error('Missing targetId');
          const node = findNodeInScene(store.sceneGraph.nodes, targetId);
          if (!node) throw new Error(`No object with id '${targetId}'`);

          const nodeUpdates: Partial<SceneNode> = {};
          if (shatterImpulseNs !== undefined) nodeUpdates.shatterImpulseNs = shatterImpulseNs ?? undefined;
          if (shatterPieces !== undefined) nodeUpdates.shatterPieces = shatterPieces;
          if (shatterSeed !== undefined) nodeUpdates.shatterSeed = shatterSeed;
          if (shatterPattern !== undefined) nodeUpdates.shatterPattern = shatterPattern;
          if (shatterSpread !== undefined) nodeUpdates.shatterSpread = shatterSpread;
          if (shatterDepth !== undefined) nodeUpdates.shatterDepth = shatterDepth;
          if (Object.keys(nodeUpdates).length > 0) store.updateNode(node.id, nodeUpdates);

          const wantsDent = dentYieldNs !== undefined || dentDepthPerNs !== undefined
            || dentRadius !== undefined || dentMaxDepth !== undefined || pierceImpulseNs !== undefined
            || deformCollision !== undefined;
          let dentedGeom: string | null = null;
          let convertedToMesh = false;
          if (wantsDent) {
            /*
             * A primitive is converted rather than refused.
             *
             * A dent moves vertices and a primitive has none — a box is six
             * numbers the solver evaluates, not eight corners — so making one
             * dentable means rebuilding it as the mesh it already looked like.
             * `makeDentable` does that, and is the same path the inspector's
             * checkbox takes.
             */
            const geoms = node.geoms || [];
            const idx = geomName
              ? geoms.findIndex((g) => g.name === geomName)
              : geoms.findIndex((g) => isDentable(g) || needsConversionForDenting(g));
            if (idx < 0) {
              return { ok: false, error: geomName
                ? `'${targetId}' has no geom named '${geomName}'`
                : `'${targetId}' has no surface that can be dented` };
            }
            const cfg: DentConfig = {};
            if (dentYieldNs !== undefined) cfg.dentYieldNs = dentYieldNs ?? undefined;
            if (dentDepthPerNs !== undefined) cfg.dentDepthPerNs = dentDepthPerNs;
            if (dentRadius !== undefined) cfg.dentRadius = dentRadius;
            if (dentMaxDepth !== undefined) cfg.dentMaxDepth = dentMaxDepth;
            if (pierceImpulseNs !== undefined) cfg.pierceImpulseNs = pierceImpulseNs ?? undefined;
            if (deformCollision !== undefined) cfg.deformCollision = deformCollision || undefined;
            const converted = needsConversionForDenting(geoms[idx]);
            if (!store.makeDentable(node.id, idx, cfg)) {
              return { ok: false, error: `'${geoms[idx].name}' is a ${geoms[idx].type}, which has no surface a dent can be made in` };
            }
            dentedGeom = geoms[idx].name;
            if (converted) convertedToMesh = true;
          }

          const after = findNodeInScene(useStore.getState().sceneGraph.nodes, node.id);
          return {
            ok: true, id: node.id, name: node.name,
            shatterImpulseNs: after?.shatterImpulseNs ?? null,
            shatterPieces: after?.shatterPieces ?? null,
            dentGeom: dentedGeom,
            // Worth saying: the body's geom type changed under the caller.
            convertedToMesh,
            dentYieldNs: dentedGeom
              ? (after?.geoms || []).find((g) => g.name === dentedGeom)?.dentYieldNs ?? null
              : null,
          };
        }

        case 'RESTORE_BREAK': {
          const { key } = msg as Msg<{ key?: string }>;
          const state = useStore.getState();
          if (!key) {
            // No key means "put everything back", which is what Reset does.
            state.resetSimulation();
            return { ok: true, restored: 'all' };
          }
          if (!state.brokenConstraints.includes(key)) {
            return { ok: false, error: `'${key}' is not broken` };
          }
          state.restoreConstraint(key);
          return { ok: true, restored: key };
        }

        case 'DELETE_OBJECT': {
          const { targetId } = msg as Msg<{ targetId: string }>;
          if (!targetId) throw new Error('Missing targetId');
          const node = findNodeInScene(store.sceneGraph.nodes, targetId);
          if (!node) throw new Error(`No object with id '${targetId}'`);
          const name = node.name;
          const childCount = (node.children ?? []).length;

          store.deleteNode(targetId);
          sculptHistory.delete(targetId);

          const gone = !findNodeInScene(useStore.getState().sceneGraph.nodes, targetId);
          if (!gone) return { ok: false, error: `'${targetId}' could not be deleted` };
          return { ok: true, deleted: targetId, name, childrenRemoved: childCount };
        }

        /*
         * Add ONE body, leaving everything already in the scene alone.
         *
         * Until this existed the only ways to get a body in were the three that
         * make their own (create_lattice, create_sculpt, import_stl) or
         * build_scene/update_scene, which replace the whole graph. So adding a
         * ball to a scene you had just built meant reading the entire scene back
         * — every vertex of every mesh — and posting all of it again, which on
         * anything with a sculpt or a boolean in it is megabytes each way and
         * loses whatever another client changed in between.
         */
        case 'ADD_OBJECT': {
          const raw = msg.body as RawNode | undefined;
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new Error('Missing body: pass one body descriptor, the same shape as an element of physics_build_scene\'s bodies array');
          }
          const parent = resolveParent(store.sceneGraph.nodes, msg.parent);
          const node = fillBodyDefaults(raw, parent ? parent.moves : null);
          // A clashing id would make every later call ambiguous about which body
          // it meant, so it is corrected here rather than refused: the reply says
          // what the body ended up called.
          const taken = collectNodeIds(store.sceneGraph.nodes);
          if (taken.has(node.id)) {
            const oldId = node.id;
            let n = 2;
            while (taken.has(`${node.id}_${n}`)) n++;
            node.id = `${node.id}_${n}`;
            if (!raw.name) node.name = node.id;
            const pending = pendingDeclarativeOps.get(oldId);
            if (pending) {
              pendingDeclarativeOps.delete(oldId);
              pendingDeclarativeOps.set(node.id, pending);
            }
          }
          const nodes = parent
            ? withChild(store.sceneGraph.nodes, parent.id, node)
            : [...store.sceneGraph.nodes, node];
          store.updateScene({ ...store.sceneGraph, nodes }, true);
          await autoCompileScad([node]);
          await applyDeclarativePreCsgFeatures([node]);
          await compileCsgNodes(true);
          await applyDeclarativePostCsgFeatures([node]);
          await useStore.getState().recompile(useStore.getState().sceneGraph, node.id, false, true);
          const addError = useStore.getState().lastCompileError;
          const landed = findNodeInScene(useStore.getState().sceneGraph.nodes, node.id);
          if (landed?.csgError) {
            return { ok: false, error: `Boolean failed: ${landed.csgError}`, id: node.id };
          }
          return {
            ok: !addError && !!landed,
            ...(addError ? { error: addError } : {}),
            id: node.id,
            name: landed?.name ?? node.name,
            ...(parent ? { parent: parent.id } : {}),
            nodeCount: useStore.getState().sceneGraph.nodes.length,
          };
        }

        /*
         * A printed pour box for a silicone mold of the given bodies (default:
         * the selection, else every body): base with a groove, sleeve, and an
         * optional wick pin. Reports the fill line and the silicone; apply adds
         * the pieces to the scene; files come back as for EXPORT_CAST.
         */
        case 'MAKE_POUR_BOX': {
          const raw = typeof msg.bodyId === 'string' ? msg.bodyId.split(',').map((x) => x.trim()).filter(Boolean) : [];
          const given = raw.length ? raw : store.selectedNodeId ? [store.selectedNodeId, ...store.extraSelectedIds.filter((id) => id !== store.selectedNodeId)] : [];
          const missing = given.filter((id) => !findNodeInScene(store.sceneGraph.nodes, id));
          if (missing.length) return { ok: false, error: `No body called ${missing.join(', ')}.` };
          const ids = given.length
            ? given.map((id) => findNodeInScene(store.sceneGraph.nodes, id)!.id)
            : store.sceneGraph.nodes.filter((n) => !n.simulation).map((n) => n.id);
          if (!ids.length) return { ok: false, error: 'The scene is empty: add the master first.' };
          const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
          const options: Partial<PourBoxOptions> = {};
          for (const key of ['coverMm', 'wallMm', 'clearanceMm', 'baseMm', 'grooveMm', 'freeboardMm', 'pinDiaMm'] as const) {
            const v = num(msg[key]);
            if (v !== undefined) options[key] = v;
          }
          if (msg.shape === 'fit' || msg.shape === 'round' || msg.shape === 'box') options.shape = msg.shape;
          if (typeof msg.pin === 'boolean') options.pin = msg.pin;
          if (typeof msg.silicone === 'string') {
            if (!(msg.silicone in SILICONES)) return { ok: false, error: `silicone is one of ${Object.keys(SILICONES).join(', ')}.` };
            options.silicone = msg.silicone as SiliconeId;
          }
          let box;
          try {
            box = await planPourBox(store.sceneGraph, ids, options);
          } catch (e) {
            return { ok: false, error: (e as Error).message };
          }
          const added = msg.apply === true ? await addPourBoxToScene(ids, options, box) : null;
          const { warnings, ...summary } = box.report;
          return {
            ok: true,
            summary: {
              ...summary,
              master: ids,
              ...(box.pin ? { pinDiaMm: box.pin.diaMm } : {}),
              ...(added ? { added: { baseId: added.baseId, sleeveId: added.sleeveId, ...(added.pinId ? { pinId: added.pinId } : {}) } } : {}),
            },
            warnings,
            files: describeFiles(
              [
                { name: 'pour-base.stl', bytes: pourBoxStl(box.base, 'base') },
                { name: 'pour-sleeve.stl', bytes: pourBoxStl(box.sleeve, 'sleeve') },
              ],
              msg.includeFiles !== false
            ),
          };
        }

        /*
         * The two export paths, reachable at last.
         *
         * Everything the app can make — a casting pattern, a CNC program, a
         * mold, a laser layout — lived behind a modal and a mouse, so an agent
         * could model a part and then had no way to find out whether it could be
         * made. These two are the ones asked for.
         *
         * Files come back base64-encoded and the MCP server writes them out; it
         * never hands the bytes to the agent, which is the whole reason they are
         * separated from the summary.
         */
        case 'EXPORT_CAST': {
          const scene = store.sceneGraph;
          if (!scene.nodes?.length) return { ok: false, error: 'The scene is empty — there is nothing to cast.' };
          const options = {
            ...DEFAULT_CAST_OPTIONS,
            // `metal` is what the MCP tool calls it; `metalId` is what the
            // exporter's own options call it. Both are accepted so neither side
            // has to know the other's spelling.
            ...(typeof msg.metal === 'string' ? { metalId: msg.metal } : {}),
            ...(typeof msg.metalId === 'string' ? { metalId: msg.metalId } : {}),
            ...(msg.partingFromBaseMm === 'auto' || typeof msg.partingFromBaseMm === 'number'
              ? { partingFromBaseMm: msg.partingFromBaseMm as number | 'auto' } : {}),
            ...(msg.method === 'sand' || msg.method === 'lost-pla' ? { method: msg.method as CastMethod } : {}),
            ...(typeof msg.addGating === 'boolean' ? { addGating: msg.addGating } : {}),
            ...(typeof msg.sprueDiaMm === 'number' ? { sprueDiaMm: msg.sprueDiaMm } : {}),
            ...(typeof msg.riserDiaMm === 'number' ? { riserDiaMm: msg.riserDiaMm } : {}),
            ...(typeof msg.addRiser === 'boolean' ? { addRiser: msg.addRiser } : {}),
          };
          const result = generateCastPattern(scene, options);
          if (!result.success) return { ok: false, error: result.error || 'The cast pattern could not be generated.', warnings: result.warnings ?? [] };
          return {
            ok: true,
            summary: result.summary,
            warnings: result.warnings ?? [],
            files: describeFiles(
              [{ name: result.summary.method === 'lost-pla' ? 'burnout-pattern.stl' : 'cast-pattern.stl', bytes: result.patternStl }],
              msg.includeFiles !== false
            ),
          };
        }

        /*
         * Split for Print, as the dialog does it: cut a body into sections
         * that fit the bed, with joinery on the cut faces. Reports the
         * sections; `testAssembly` puts them back together in MuJoCo first,
         * and `apply` replaces the body with them. See utils/printSplit.ts.
         */
        case 'SPLIT_FOR_PRINT': {
          const bodyId = typeof msg.bodyId === 'string' ? msg.bodyId : store.selectedNodeId;
          const node = bodyId ? findNodeInScene(store.sceneGraph.nodes, bodyId) : null;
          if (!node) return { ok: false, error: bodyId ? `No body called ${bodyId}.` : 'Give bodyId, or select a body first.' };
          // More bodies to split as one part with it, in its frame.
          const others = (Array.isArray(msg.withIds) ? msg.withIds : []).filter((v): v is string => typeof v === 'string');
          const missing = others.filter((id) => !findNodeInScene(store.sceneGraph.nodes, id));
          if (missing.length) return { ok: false, error: `No body called ${missing.join(', ')}.` };
          const { soups, absorbed } = selectionSoups(store.sceneGraph, [node.id, ...others.map((id) => findNodeInScene(store.sceneGraph.nodes, id)!.id)]);
          if (!soups.length) return { ok: false, error: `${node.name} has no solid geometry to split.` };
          const bedArr = Array.isArray(msg.bedMm) ? (msg.bedMm as number[]) : null;
          const bed = bedArr && bedArr.length === 3 && bedArr.every((v) => typeof v === 'number' && v > 0)
            ? { widthMm: bedArr[0], depthMm: bedArr[1], heightMm: bedArr[2] }
            : store.printBed;
          const kind = msg.joinery === 'none' || msg.joinery === 'peg' || msg.joinery === 'dowel' ? msg.joinery : 'dowel';
          const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
          const joinery = Object.fromEntries(Object.entries({
            kind,
            diameterMm: num(msg.diameterMm),
            lengthMm: num(msg.lengthMm),
            clearanceMm: num(msg.clearanceMm),
            minWallMm: num(msg.minWallMm),
          }).filter(([, v]) => v !== undefined));
          const { result, checks } = await splitOffThread(soups, {
            bed,
            marginMm: num(msg.marginMm) ?? 5,
            overhangDeg: filamentSpec(store.filament).maxOverhangDeg,
            joinery,
          });
          if (!result.ok) return { ok: false, error: result.error };

          let assembly: Record<string, unknown> | undefined;
          if (msg.testAssembly === true && result.cuts.length) {
            try {
              const { results } = await testAssemblyOffThread(result);
              assembly = {
                ok: results.every((r) => r.ok),
                stages: results.map((r) => ({
                  label: r.label, kind: r.kind, ok: r.ok, seated: r.seated,
                  gapMm: +r.gapMm.toFixed(3), lateralMm: +r.lateralMm.toFixed(3), angleDeg: +r.angleDeg.toFixed(3),
                  playMm: r.playMm === null ? 'unbounded' : +r.playMm.toFixed(3),
                  twistDeg: r.twistDeg === null ? 'unbounded' : +r.twistDeg.toFixed(3),
                  rotates: r.rotates, diverged: r.diverged, notes: r.notes,
                })),
              };
            } catch (err) {
              assembly = { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
          }

          const ids = msg.apply === true ? store.splitBodyForPrint(node.id, result.sections, absorbed) : null;
          const round = (v: number, d = 1) => +v.toFixed(d);
          return {
            ok: true,
            applied: !!ids,
            ...(absorbed.length ? { includedBodies: absorbed.length } : {}),
            bedMm: [bed.widthMm, bed.depthMm, bed.heightMm],
            sections: result.sections.map((sec, i) => ({
              index: i,
              ...(ids ? { id: ids[i] } : {}),
              fits: sec.fits,
              printedSizeMm: sec.sizeMm.map((v) => round(v)),
              supportMm2: round(sec.supportMm2),
              up: sec.up.map((v) => round(v, 4)),
              spinDeg: round(sec.spin * 180 / Math.PI, 2),
              volumeMm3: round(sec.volumeMm3),
              holes: sec.features.filter((f) => f.kind === 'bore').length,
              pegs: sec.features.filter((f) => f.kind === 'peg').length,
            })),
            cuts: result.cuts.map((c) => ({ normal: c.normal.map((v) => round(v, 4)), offsetMm: round(c.offset * 1000, 2) })),
            joints: result.joints.map((j) => ({
              between: [j.neg, j.pos], areaMm2: round(j.areaMm2), pins: j.pins.length,
              ...(j.pegSide ? { pegsOn: j.pegSide === 'neg' ? j.neg : j.pos } : {}),
            })),
            checks,
            ...(assembly ? { assembly } : {}),
            warnings: result.warnings,
          };
        }

        /*
         * Timber & Joinery Breakdown (`physics_timber_breakdown` / `BREAKDOWN_JOINERY`):
         * Decompose either:
         *   (a) Large architectural/enclosure/cabinet solids into machinable timber
         *       planks with interlocking rabbet, miter, finger, or butt joints,
         *       alignment dowels, hollow interior option, and lay-flat sheet packing; OR
         *   (b) Framed furniture (table, chair, flower stand) into mortise-and-tenon
         *       legs & rails, stopped edge roundovers, 1D stock bars, and CNC windows.
         */
        case 'TIMBER_BREAKDOWN':
        case 'PHYSICS_TIMBER_BREAKDOWN':
        case 'BREAKDOWN_JOINERY': {
          const explicitBodyId =
            typeof msg.bodyId === 'string'
              ? msg.bodyId
              : typeof msg.body_id === 'string'
                ? msg.body_id
                : null;
          const rawWithIds = Array.isArray(msg.withIds)
            ? msg.withIds
            : Array.isArray(msg.with_ids)
              ? msg.with_ids
              : [];
          const others = rawWithIds.filter((v): v is string => typeof v === 'string');
          const targetIds = explicitBodyId
            ? [explicitBodyId, ...others]
            : resolveTimberTargetIds(store.sceneGraph.nodes, store.selectedNodeId, others);
          if (!targetIds.length) return { ok: false, error: 'Give bodyId, or add a body to the scene first.' };
          const primary = findNodeInScene(store.sceneGraph.nodes, targetIds[0]);
          if (!primary) return { ok: false, error: `No body called ${targetIds[0]}.` };

          const { items, absorbed } = collectIndividualPartSoups(store.sceneGraph, targetIds);
          if (!items.length) return { ok: false, error: `${primary.name} has no solid geometry to break down.` };

          const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
          const placement: 'replace' | 'beside' = msg.placement === 'beside' ? 'beside' : 'replace';

          const rawJointType = msg.jointType ?? msg.joint_type;
          const hasPlankSpecificArg =
            msg.mode === 'planks' ||
            rawJointType === 'rabbet' ||
            rawJointType === 'miter' ||
            rawJointType === 'finger' ||
            rawJointType === 'butt' ||
            rawJointType === 'glue' ||
            msg.boardThicknessMm !== undefined ||
            msg.board_thickness_mm !== undefined ||
            msg.wallThicknessMm !== undefined ||
            msg.wall_thickness_mm !== undefined ||
            msg.hollowInterior !== undefined ||
            msg.hollow_interior !== undefined ||
            msg.fingerWidthMm !== undefined ||
            msg.finger_width_mm !== undefined ||
            msg.dowelDiaMm !== undefined ||
            msg.dowel_dia_mm !== undefined ||
            msg.maxBoardLengthMm !== undefined ||
            msg.max_board_length_mm !== undefined;

          const wasm = await loadManifold();
          const soups = items.map((it) => it.soup);

          if (hasPlankSpecificArg && msg.mode !== 'frame') {
            const jointType: PlankJointType =
              rawJointType === 'miter' || rawJointType === 'finger' || rawJointType === 'butt' || rawJointType === 'glue'
                ? rawJointType
                : 'rabbet';
            const plankRes = decomposeSolidIntoPlanks(wasm, soups, {
              boardThicknessMm: num(msg.boardThicknessMm ?? msg.board_thickness_mm),
              wallThicknessMm: num(msg.wallThicknessMm ?? msg.wall_thickness_mm),
              maxBoardWidthMm: num(msg.maxBoardWidthMm ?? msg.max_board_width_mm),
              maxBoardLengthMm: num(msg.maxBoardLengthMm ?? msg.max_board_length_mm),
              jointType,
              fingerWidthMm: num(msg.fingerWidthMm ?? msg.finger_width_mm),
              dowelDiaMm: num(msg.dowelDiaMm ?? msg.dowel_dia_mm),
              dowelLengthMm: num(msg.dowelLengthMm ?? msg.dowel_length_mm),
              clearanceMm: num(msg.clearanceMm ?? msg.clearance_mm),
              hollowInterior:
                typeof msg.hollowInterior === 'boolean'
                  ? msg.hollowInterior
                  : typeof msg.hollow_interior === 'boolean'
                    ? msg.hollow_interior
                    : undefined,
            });
            if (!plankRes.ok) return plankRes;

            const names = plankRes.planks.map((p) => p.id);
            const ids =
              msg.apply === true
                ? store.splitBodyForPrint(primary.id, plankRes.sections, absorbed, {
                    plain: false,
                    names,
                    centerOrigin: true,
                    placement,
                  })
                : null;

            return {
              ok: true,
              mode: 'planks',
              applied: !!ids,
              placement: ids ? placement : undefined,
              options: plankRes.options,
              totalVolumeMm3: plankRes.totalVolumeMm3,
              originalVolumeMm3: plankRes.originalVolumeMm3,
              hollowedVolumeMm3: plankRes.hollowedVolumeMm3,
              layFlatSheetMm: plankRes.layFlatSheetMm,
              planks: plankRes.planks.map((p, idx) => ({
                index: idx,
                id: p.id,
                ...(ids ? { sceneNodeId: ids[idx] } : {}),
                name: p.name,
                wallFace: p.wallFace,
                dimensionsMm: p.dimensionsMm,
                grainAxis: p.grainAxis,
                volumeMm3: p.volumeMm3,
                explodedOffsetMm: p.explodedOffsetMm,
                layFlatOffsetMm: p.layFlatOffsetMm,
                layFlatSizeMm: p.layFlatSizeMm,
                dowelCount: p.dowelHoles.length,
                jointSummary: p.jointSummary,
                joints: p.joints,
              })),
              bomMarkdown: plankRes.bomMarkdown,
              warnings: plankRes.warnings,
            };
          }

          const jointMode: TimberJointMode =
            msg.jointMode === 'dowel' || msg.jointMode === 'dado' || msg.jointMode === 'butt'
              ? msg.jointMode
              : msg.jointMode === 'glue'
                ? 'butt'
                : 'mortise_tenon';
          const tenonCornerFit: TenonCornerFit =
            msg.tenonCornerFit === 'round_tenon' || msg.tenonCornerFit === 'chisel_square' ? msg.tenonCornerFit : 'dogbone';
          const edgeProfile: TimberEdgeProfile =
            msg.edgeProfile === 'chamfer' || msg.edgeProfile === 'square' ? msg.edgeProfile : 'roundover';

          const outcome = synthesizeTimberJoinery(
            wasm,
            soups,
            {
              jointMode,
              tenonCornerFit,
              edgeProfile,
              cutterDiaMm: num(msg.cutterDiaMm),
              shoulderMm: num(msg.shoulderMm),
              tenonLengthMm: num(msg.tenonLengthMm),
              clearanceMm: num(msg.clearanceMm),
              edgeRadiusMm: num(msg.edgeRadiusMm),
              stopMarginMm: num(msg.stopMarginMm),
              maxBoardWidthMm: num(msg.maxBoardWidthMm),
              tabletopClips: typeof msg.tabletopClips === 'boolean' ? msg.tabletopClips : undefined,
              tenonCutMethod: msg.tenonCutMethod === 'cnc' ? 'cnc' : 'bandsaw',
            },
          );
          if (!outcome.ok) return outcome;

          // If auto-mode was called on a single unframed solid block (1 part, 0 joints)
          // and msg.mode !== 'frame', fall back to hollow-shell / plank breakdown!
          if (msg.mode !== 'frame' && outcome.parts.length <= 1 && outcome.joints.length === 0 && msg.jointMode === undefined) {
            const plankRes = decomposeSolidIntoPlanks(wasm, soups, {
              maxBoardWidthMm: num(msg.maxBoardWidthMm ?? msg.max_board_width_mm),
              clearanceMm: num(msg.clearanceMm ?? msg.clearance_mm),
            });
            if (plankRes.ok && plankRes.planks.length > 1) {
              const names = plankRes.planks.map((p) => p.id);
              const ids =
                msg.apply === true
                  ? store.splitBodyForPrint(primary.id, plankRes.sections, absorbed, {
                      plain: false,
                      names,
                      centerOrigin: true,
                      placement,
                    })
                  : null;
              return {
                ok: true,
                mode: 'planks',
                applied: !!ids,
                placement: ids ? placement : undefined,
                options: plankRes.options,
                totalVolumeMm3: plankRes.totalVolumeMm3,
                originalVolumeMm3: plankRes.originalVolumeMm3,
                hollowedVolumeMm3: plankRes.hollowedVolumeMm3,
                layFlatSheetMm: plankRes.layFlatSheetMm,
                planks: plankRes.planks.map((p, idx) => ({
                  index: idx,
                  id: p.id,
                  ...(ids ? { sceneNodeId: ids[idx] } : {}),
                  name: p.name,
                  wallFace: p.wallFace,
                  dimensionsMm: p.dimensionsMm,
                  grainAxis: p.grainAxis,
                  volumeMm3: p.volumeMm3,
                  explodedOffsetMm: p.explodedOffsetMm,
                  layFlatOffsetMm: p.layFlatOffsetMm,
                  layFlatSizeMm: p.layFlatSizeMm,
                  dowelCount: p.dowelHoles.length,
                  jointSummary: p.jointSummary,
                  joints: p.joints,
                })),
                bomMarkdown: plankRes.bomMarkdown,
                warnings: plankRes.warnings,
              };
            }
          }

          const bedArr = Array.isArray(msg.cncBedMm) ? (msg.cncBedMm as number[]) : null;
          const cncBedMm: [number, number, number] =
            bedArr && bedArr.length === 3 && bedArr.every((v) => typeof v === 'number' && v > 0)
              ? [bedArr[0], bedArr[1], bedArr[2]]
              : [store.cncBed.widthMm, store.cncBed.depthMm, store.cncBed.heightMm];

          const cutPlan = buildTimberCutPlan(outcome, {
            cncBedMm,
            defaultStockLengthMm: num(msg.stockLengthMm) ?? 1800,
          });

          const names = outcome.parts.map((p) => p.member.id);
          const ids =
            msg.apply === true
              ? store.splitBodyForPrint(primary.id, outcome.sections, absorbed, {
                  plain: false,
                  names,
                  centerOrigin: true,
                  placement,
                })
              : null;

          return {
            ok: true,
            mode: 'frame',
            applied: !!ids,
            placement: ids ? placement : undefined,
            parts: outcome.parts.map((p, idx) => ({
              index: idx,
              id: p.member.id,
              ...(ids ? { sceneNodeId: ids[idx] } : {}),
              title: p.member.title,
              role: p.member.role,
              mirrorOf: p.member.mirrorOf,
              finishedDimsMm: [p.totalFinishedLengthMm, p.crossSectionMm[0], p.crossSectionMm[1]],
              shoulderToShoulderMm: p.shoulderToShoulderMm,
              face1: p.member.face1.label,
              face2: p.member.face2.label,
              mortiseCount: p.mortises.length,
              tenonCount: p.tenons.length,
              zClipSlotCount: p.zClipSlots.length,
              stoppedEdgeZones: p.stoppedEdgeZones,
            })),
            joints: outcome.joints.map((j) => ({
              id: j.id,
              kind: j.kind,
              between: [j.memberAId, j.memberBId],
              miteredCornerTenon: j.tenon?.miteredTip ?? false,
              notes: j.notes,
            })),
            stockBars: cutPlan.stockBars,
            hardwareBom: cutPlan.hardwareBom,
            cncSetups: cutPlan.allCncSetups.map((s) => ({
              id: s.id,
              partId: s.partId,
              faceUpLabel: s.faceUpLabel,
              fenceFaceLabel: s.fenceFaceLabel,
              indexOffsetFromTopMm: s.indexOffsetFromTopMm,
              overhangMm: s.overhangMm,
              estimatedMinutes: s.estimatedMinutes,
              operationsSummary: s.operationsSummary,
              gcode: s.gcode,
            })),
            buildGuideMarkdown: cutPlan.buildGuideMarkdown,
            warnings: outcome.warnings,
          };
        }

        case 'EXPORT_SHEET_UNFOLD':
        case 'PHYSICS_EXPORT_SHEET_UNFOLD': {
          const targetIds = Array.isArray(msg.targetIds)
            ? msg.targetIds.filter((x): x is string => typeof x === 'string')
            : typeof msg.targetId === 'string'
              ? [msg.targetId]
              : undefined;
          const res = exportSheetUnfold(
            store.sceneGraph,
            msg as Partial<SheetUnfoldOptions>,
            targetIds,
          );
          return {
            ok: true,
            mode: res.options.mode,
            totalFaces: res.totalFaces,
            foldCount: res.foldCount,
            seamCount: res.seamCount,
            glueTabCount: res.glueTabCount,
            stitchHoleCount: res.stitchHoleCount,
            sheetCount: res.sheets.length,
            islands: res.islands.map((isl) => ({
              id: isl.id,
              nodeId: isl.nodeId,
              nodeName: isl.nodeName,
              faceCount: isl.faceCount,
              boundsMm: isl.boundsMm,
            })),
            svg: res.svg,
            etchUrl: res.etchUrl,
            warnings: res.warnings,
          };
        }

        case 'SYNC_PCB_ENCLOSURE':
        case 'PHYSICS_SYNC_PCB_ENCLOSURE': {
          const presetKey = typeof msg.preset === 'string' ? msg.preset : undefined;
          let spec: PcbMechanicalSpec | null;
          if (presetKey && presetKey in PCB_PRESETS) {
            spec = PCB_PRESETS[presetKey];
          } else if (typeof msg.handoff === 'string') {
            spec = decodePcbHandoff(msg.handoff);
          } else if (msg.spec && typeof msg.spec === 'object') {
            spec = msg.spec as PcbMechanicalSpec;
          } else {
            spec = PCB_PRESETS.arduino_uno;
          }
          if (!spec) return { ok: false, error: 'Invalid PCB specification or handoff payload.' };

          const face: PcbEnclosureFace =
            msg.face === 'front' || msg.face === 'back' || msg.face === 'left' || msg.face === 'right'
              ? msg.face
              : 'top';
          const faceplate = exportPcbFaceplateSvg(spec, face);

          if (msg.pcbOnly === true) {
            const pcbNode = buildPcbNode(spec);
            const nextNodes = [...store.sceneGraph.nodes.filter((n) => n.id !== pcbNode.id), pcbNode];
            await settleScene(nextNodes);
            return {
              ok: true,
              pcbId: pcbNode.id,
              faceplateSvg: faceplate.svg,
              etchUrl: faceplate.etchUrl,
            };
          }

          const enc = generatePcbEnclosure(spec, msg as Partial<PcbEnclosureOptions>);
          const addedIds = new Set([enc.baseNode.id, enc.pcbNode.id, ...(enc.lidNode ? [enc.lidNode.id] : [])]);
          const nextNodes = [
            ...store.sceneGraph.nodes.filter((n) => !addedIds.has(n.id)),
            enc.baseNode,
            enc.pcbNode,
            ...(enc.lidNode ? [enc.lidNode] : []),
          ];
          await settleScene(nextNodes);
          return {
            ok: true,
            baseId: enc.baseNode.id,
            lidId: enc.lidNode?.id,
            pcbId: enc.pcbNode.id,
            cutouts: enc.cutouts,
            clearanceReport: enc.clearanceReport,
            faceplateSvg: faceplate.svg,
            etchUrl: faceplate.etchUrl,
          };
        }

        case 'BUILD_MECHANISM':
        case 'PHYSICS_BUILD_MECHANISM': {
          const family = typeof msg.family === 'string' ? msg.family : 'gear_pair';
          let createdNodes: SceneNode[];
          let metrics: Record<string, unknown> = {};
          if (family === 'gear') {
            const node = buildInvoluteGearNode(msg as unknown as InvoluteGearSpec);
            createdNodes = [node];
          } else if (family === 'gear_pair') {
            const driverSpec: InvoluteGearSpec = (msg.driver as InvoluteGearSpec) ?? {
              moduleMm: typeof msg.moduleMm === 'number' ? msg.moduleMm : 1.5,
              teeth: typeof msg.driverTeeth === 'number' ? msg.driverTeeth : 16,
            };
            const drivenSpec: InvoluteGearSpec = (msg.driven as InvoluteGearSpec) ?? {
              moduleMm: driverSpec.moduleMm,
              teeth: typeof msg.drivenTeeth === 'number' ? msg.drivenTeeth : 32,
            };
            const pair = buildMeshingGearPair(driverSpec, drivenSpec);
            createdNodes = [pair.driverNode, pair.drivenNode];
            metrics = { centerDistanceMm: pair.centerDistanceMm, ratio: pair.ratio, contactRatio: pair.contactRatio };
          } else if (family === 'rack_pinion') {
            const pinionSpec: InvoluteGearSpec = (msg.pinion as InvoluteGearSpec) ?? {
              moduleMm: typeof msg.moduleMm === 'number' ? msg.moduleMm : 1.5,
              teeth: typeof msg.pinionTeeth === 'number' ? msg.pinionTeeth : 16,
            };
            const rackSpec: InvoluteRackSpec = (msg.rack as InvoluteRackSpec) ?? {
              moduleMm: pinionSpec.moduleMm,
              teeth: typeof msg.rackTeeth === 'number' ? msg.rackTeeth : 20,
            };
            const rp = buildRackAndPinionPair(pinionSpec, rackSpec);
            createdNodes = [rp.pinionNode, rp.rackNode];
            metrics = { coupleRatio: rp.coupleRatio, pitchLineOffsetMm: rp.pitchLineOffsetMm };
          } else if (family === 'gt2_belt') {
            const belt = buildGt2BeltDrive((msg as unknown as Gt2BeltDriveSpec) ?? { driverTeeth: 20, drivenTeeth: 40, centerDistanceMm: 80 });
            createdNodes = [belt.driverNode, belt.drivenNode, belt.beltNode];
            metrics = { beltLengthMm: belt.beltLengthMm, beltTeeth: belt.beltTeeth, coupleRatio: belt.coupleRatio };
          } else if (family === 'leadscrew') {
            const ls = buildLeadscrewDrive((msg as unknown as LeadscrewSpec) ?? { lengthMm: 200, leadMm: 8 });
            createdNodes = [ls.screwNode];
            metrics = { coupleRatio: ls.coupleRatio, travelMm: ls.travelMm };
          } else if (family === 'cam_follower') {
            const cam = buildCamMechanism((msg as unknown as CamSpec) ?? { profile: 'eccentric', baseRadiusMm: 20, liftMm: 8 });
            createdNodes = [cam.camNode, cam.followerNode];
            metrics = { maxRadiusMm: cam.maxRadiusMm, minRadiusMm: cam.minRadiusMm, coupleRatio: cam.coupleRatio };
          } else if (family === 'four_bar') {
            const fb = buildFourBarLinkage((msg as unknown as FourBarSpec) ?? { groundMm: 100, crankMm: 40, couplerMm: 90, rockerMm: 80 });
            createdNodes = fb.nodes;
            metrics = { ...fb.metrics };
          } else {
            return { ok: false, error: `Unknown mechanism family '${family}'.` };
          }
          const createdIds = new Set(createdNodes.map((n) => n.id));
          const nextNodes = [...store.sceneGraph.nodes.filter((n) => !createdIds.has(n.id)), ...createdNodes];
          await settleScene(nextNodes);
          return {
            ok: true,
            family,
            addedIds: createdNodes.map((n) => n.id),
            metrics,
          };
        }

        case 'BREAKDOWN_PIPE_FRAME':
        case 'PHYSICS_BREAKDOWN_PIPE_FRAME': {
          if (typeof msg.preset === 'string') {
            const presetNodes = generatePipeStructurePreset(msg.preset as PipeStructurePresetId, {
              pipeStandardId: (typeof msg.pipeStandardId === 'string' && msg.pipeStandardId in PIPE_STANDARDS
                ? msg.pipeStandardId
                : 'pvc_sch40_3_4') as PipeStandardId,
              widthMm: typeof msg.widthMm === 'number' ? msg.widthMm : undefined,
              depthMm: typeof msg.depthMm === 'number' ? msg.depthMm : undefined,
              heightMm: typeof msg.heightMm === 'number' ? msg.heightMm : undefined,
              roofPitchDeg: typeof msg.roofPitchDeg === 'number' ? msg.roofPitchDeg : undefined,
            });
            await settleScene(presetNodes);
          }
          const bd = breakdownPipeFrame(useStore.getState().sceneGraph, msg as Partial<PipeFrameOptions>);
          let addedHubIds: string[] = [];
          if (msg.addPrintableHubs === true) {
            const hubNodes = buildAllCustomHubNodes(bd);
            addedHubIds = hubNodes.map((h) => h.id);
            const hubIdSet = new Set(addedHubIds);
            const nextNodes = [...useStore.getState().sceneGraph.nodes.filter((n) => !hubIdSet.has(n.id)), ...hubNodes];
            await settleScene(nextNodes);
          }
          return {
            ok: true,
            pipeSpec: bd.pipeSpec,
            strutCount: bd.struts.length,
            hubCount: bd.hubs.length,
            sticksRequired: bd.sticksRequired,
            totalPipeLengthMm: bd.totalPipeLengthMm,
            shoppingList: bd.shoppingList,
            sticks: bd.sticks,
            addedHubIds,
            warnings: bd.warnings,
          };
        }

        case 'EXPORT_TUBE_COPE': {
          const cope = computeTubeCopeJoint(msg as unknown as TubeCopeSpec);
          const svgRes = exportTubeCopeSvg([msg as unknown as TubeCopeSpec]);
          return {
            ok: true,
            circumferenceMm: cope.circumferenceMm,
            peakToValleyOuterMm: cope.peakToValleyOuterMm,
            peakToValleyInnerMm: cope.peakToValleyInnerMm,
            peakToValleyCutMm: cope.peakToValleyCutMm,
            svg: svgRes.svg,
            warnings: cope.warnings,
          };
        }

        case 'COMPUTE_WIRE_BEND': {
          const pts = Array.isArray(msg.pointsMm) ? (msg.pointsMm as [number, number, number][]) : [[0, 0, 0], [60, 0, 0], [60, 50, 0], [120, 50, 0]];
          if (msg.addJig === true) {
            const { jigNode, schedule, isPlanar } = buildWireBendingJigNode(pts, msg as Partial<WireBendJigOptions>);
            const nextNodes = [...store.sceneGraph.nodes.filter((n) => n.id !== jigNode.id), jigNode];
            await settleScene(nextNodes);
            return { ok: true, jigId: jigNode.id, isPlanar, schedule };
          }
          const schedule = computeWireBendSchedule(pts, msg as Partial<WireBendJigOptions>);
          return { ok: true, schedule };
        }

        /*
         * Prepare for Casting, as the Cast dialog's switch does it: edge
         * breaks on every part, and for sand, draft baked in. See
         * utils/castPrep.ts.
         */
        case 'SET_CAST_PREP': {
          if (msg.off === true) {
            if (!store.sceneGraph.castPrep) return { ok: true, on: false, note: 'Prep was not on.' };
            const { restored, kept } = store.clearCastPrep();
            await useStore.getState().recompile(useStore.getState().sceneGraph, undefined, false, true);
            return { ok: true, on: false, restored: restored.length, keptAsTheyAre: kept.map((k) => k.name) };
          }
          if (msg.bake === true) {
            if (!store.sceneGraph.castPrep) return { ok: false, error: 'Prep is not on, so there is nothing to bake in.' };
            store.bakeCastPrep();
            return { ok: true, on: false, baked: true };
          }
          const method = msg.method === 'lost-pla' ? 'lost-pla' : 'sand';
          const report = await runCastPrep({
            method,
            draftDeg: typeof msg.draftDeg === 'number' ? msg.draftDeg : 2,
            draftMode: msg.draftMode === 'remove' ? 'remove' : 'add',
            edges: msg.edges !== false,
            edgeSizeMm: typeof msg.edgeSizeMm === 'number' && msg.edgeSizeMm > 0 ? msg.edgeSizeMm : 'auto',
            partingFromBaseMm: typeof msg.partingFromBaseMm === 'number' ? msg.partingFromBaseMm : 'auto',
          });
          return report.ok ? { ...report, on: true } : report;
        }

        /*
         * A relief carve, planned the way the Relief Carve dialog last planned
         * it - the same stock, fit, cutters and any feed typed over - so an
         * agent looking into a carve is looking at the job that went to the
         * machine. Anything asked for here is laid on top; asking for a cutter,
         * a material or a depth works the feeds out again for it. With the
         * dialog not opened this session, it starts from the scene's own carve
         * settings and the bench's stock and material, as the dialog would.
         */
        case 'EXPORT_RELIEF': {
          const scene = store.sceneGraph;
          if (!scene.nodes?.length) return { ok: false, error: 'The scene is empty — there is nothing to carve.' };
          const { options, fromDialog } = reliefOptionsFor(msg);
          const client = new ExportWorkerClient();
          let result: ReliefCarveResult;
          try {
            result = await client.run('relief', scene, options);
          } finally {
            client.dispose();
          }
          if (!result.success) return { ok: false, error: result.error || 'The relief carve could not be planned.', warnings: result.warnings ?? [] };
          const lines = result.gcode.split('\n');
          const toolChangeAt = lines.findIndex((l) => /^T\d+\s*M0?6\b/.test(l));
          return {
            ok: true,
            optionsFrom: fromDialog ? 'the Relief Carve dialog' : 'the scene and bench defaults (the dialog has not planned a carve this session)',
            summary: {
              stockMm: { width: options.stockWidthMm, depth: options.stockDepthMm, thickness: options.stockThicknessMm },
              material: options.material,
              heightMode: result.heightMode,
              scalePercent: Math.round(result.scaleFactor * 1000) / 10,
              carveDepthMm: result.heightMode === 'model' ? null : options.carveDepthMm,
              reliefDepthMm: result.reliefDepthMm,
              undercut: result.undercut
                ? {
                    areaMm2: Math.round(result.undercut.areaMm2),
                    volumeMm3: Math.round(result.undercut.volumeMm3),
                    maxMm: Math.round(result.undercut.maxMm * 10) / 10,
                    boundsMm: result.undercut.bounds,
                  }
                : null,
              roughing: options.roughingEnabled
                ? {
                    tool: describeCutter(options.roughingToolDiaMm, 'flat', options.roughingFlutes, options.roughingGeometry),
                    strategy: options.roughingStrategy,
                    layers: result.roughingPassCount,
                    bitePercent: result.roughingBitePercent,
                    estimatedSeconds: result.roughingTimeSeconds,
                  }
                : null,
              finishing: options.finishingEnabled
                ? {
                    tool: describeCutter(options.finishingToolDiaMm, options.finishingToolType, options.finishingFlutes, options.finishingGeometry, options.finishingVBitAngleDeg),
                    strategy: options.finishingStrategy,
                    passes: result.finishingRasterLines,
                  }
                : null,
              spindleRpm: options.spindleRpm,
              estimatedTimeSeconds: result.estimatedTimeSeconds,
              totalCutDistanceMm: result.totalCutDistanceMm,
              lines: lines.length,
              // 1-based, as an editor or a sender's line counter shows it.
              toolChangeLine: result.toolChange && toolChangeAt >= 0 ? toolChangeAt + 1 : null,
            },
            warnings: result.warnings ?? [],
            files: describeFiles(
              [{ name: 'relief-carve.nc', bytes: new TextEncoder().encode(result.gcode) }],
              msg.includeFiles !== false,
            ),
          };
        }

        case 'EXPORT_MACHINING': {
          const scene = store.sceneGraph;
          if (!scene.nodes?.length) return { ok: false, error: 'The scene is empty — there is nothing to machine.' };
          const options = machiningOptionsFor(msg, scene);
          // On a worker, as the dialog plans it: on the page, a big part froze
          // the tab for the half minute its plan takes.
          const client = new ExportWorkerClient();
          let result: SolidMachiningResult;
          try { result = await client.run('solid', scene, options); } finally { client.dispose(); }
          if (!result.success) return { ok: false, error: result.error || 'The machining program could not be generated.', warnings: result.warnings ?? [] };
          const encoder = new TextEncoder();
          return {
            ok: true,
            summary: {
              stock: result.stock,
              ...(result.boardPrep ? { boardPrep: result.boardPrep } : {}),
              partSizeMm: result.partSizeMm,
              partVolumeMm3: result.partVolumeMm3,
              unreachablePercent: result.unreachablePercent,
              tabsPlaced: result.tabsPlaced,
              estimatedTimeSeconds: result.estimatedTimeSeconds,
              totalCutDistanceMm: result.totalCutDistanceMm,
              sides: result.sides.map(s => ({ side: s.side, depthMm: s.depthMm })),
              // Planned setups (setups: 'auto' or a list of faces), in the order they run.
              ...(result.plan ? {
                plan: result.plan.text,
                upChosen: result.upChosen,
                remaining: result.plan.remaining,
                redesignHint: result.plan.redesignHint ?? null,
                dropped: result.plan.dropped,
                setups: (result.setups ?? []).map((st) => ({
                  index: st.index,
                  face: st.upFace,
                  faceUp: FACE_NAME[st.upFace],
                  standingHeightMm: +st.standingHeightMm.toFixed(1),
                  depthMm: +st.depthMm.toFixed(2),
                  lengthOverDia: +st.lengthOverDia.toFixed(1),
                  estimatedTimeSeconds: Math.round(st.estimatedTimeSeconds),
                  clearedMm3: Math.round(st.clearedMm3),
                  skinMm: +st.allowanceMm.toFixed(2),
                  locate: st.locate,
                  datum: st.datum?.description ?? null,
                  instructions: st.instructions,
                })),
              } : {}),
            },
            warnings: result.warnings ?? [],
            files: describeFiles(
              result.plan && result.setups
                ? result.setups.map(st => ({ name: `machining-setup-${st.index}-${st.upFace.replace('+', 'p').replace('-', 'm')}.nc`, bytes: encoder.encode(st.gcode ?? '') }))
                : result.sides.map(s => ({ name: `machining-side-${s.side}.nc`, bytes: encoder.encode(s.gcode ?? '') })),
              msg.includeFiles !== false,
            ),
          };
        }

        case 'ADD_SIMULATION': {
          // The part a program leaves, added to the scene: the same plan the
          // matching export would hand over, cut back out of its stock.
          const scene = store.sceneGraph;
          const placement = msg.placement === 'overlay' ? 'overlay' : 'beside';
          const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : undefined);

          if (msg.kind === 'mold' || msg.kind === 'mold_cast' || msg.kind === 'cast') {
            return runMcpMoldSimulation({
              msg,
              scene,
              placement,
              toId: (s) => toId(s) as string,
              findNodeInScene,
              describeFiles,
            });
          }

          if (!scene.nodes?.some((n) => !n.simulation)) {
            return { ok: false, error: 'The scene has nothing to cut but earlier simulations.' };
          }

          const runJob = async <T,>(go: (client: ExportWorkerClient) => Promise<T>) => {
            const client = new ExportWorkerClient();
            try { return await go(client); } finally { client.dispose(); }
          };

          if (msg.kind === 'relief') {
            const { options, fromDialog } = reliefOptionsFor(msg);
            const result: ReliefCarveResult = await runJob((c) => c.run('relief', scene, options));
            if (!result.success || !result.stockTransform) {
              return { ok: false, error: result.error || 'The relief carve could not be planned.', warnings: result.warnings ?? [] };
            }
            const added = await addSimulationToScene({
              job: {
                gcode: result.gcode,
                widthMm: options.stockWidthMm,
                depthMm: options.stockDepthMm,
                thicknessMm: options.stockThicknessMm,
                ...reliefSimulationTools(options),
              },
              transform: result.stockTransform,
              kind: 'relief',
              label: 'Relief carve',
              placement,
            });
            const m = added.milled!;
            return {
              ok: true, id: added.id, name: added.name, kind: 'relief', placement,
              optionsFrom: fromDialog ? 'the Relief Carve dialog' : 'the scene and bench defaults',
              volumeMm3: Math.round(m.volumeMm3),
              stockVolumeMm3: Math.round(m.stockVolumeMm3),
              removedMm3: Math.round(m.stockVolumeMm3 - m.volumeMm3),
              rapidMovesThatCut: m.rapidCuts,
              deepestRapidCutMm: +m.deepestRapidMm.toFixed(3),
              cellMm: +m.cellMm.toFixed(3),
              meshToleranceMm: +m.toleranceMm.toFixed(3),
              warnings: result.warnings ?? [],
            };
          }

          if (msg.kind === 'machining') {
            const options = machiningOptionsFor(msg, scene);
            // On the worker: a big part's plan takes half a minute, and on the
            // page it froze the tab for all of it.
            const result: SolidMachiningResult = await runJob((c) => c.run('solid', scene, options));
            if (!result.success || !result.stockTransform) {
              return { ok: false, error: result.error || 'The machining program could not be generated.', warnings: result.warnings ?? [] };
            }
            const added = await addSimulationToScene({
              job: {
                gcode: result.sides[0].gcode,
                gcodeB: result.sides[1]?.gcode,
                setups: simulationSetups(result),
                widthMm: result.stock.widthMm,
                depthMm: result.stock.depthMm,
                thicknessMm: result.stock.thicknessMm,
                ...reliefSimulationTools(options),
                measureRect: result.partBounds,
                measureMask: result.footprint,
              },
              transform: result.stockTransform,
              kind: 'machining',
              label: 'Solid part',
              placement,
              modelVolumeMm3: result.partVolumeMm3,
            });
            const m = added.milled!;
            const part = m.measuredVolumeMm3 ?? 0;
            return {
              ok: true, id: added.id, name: added.name, kind: 'machining', placement,
              sides: result.sides.length,
              setups: result.setups?.map((st) => st.upFace) ?? null,
              volumeMm3: Math.round(m.volumeMm3),
              // Inside the part's own outline, so the frame, the tabs and the
              // stock round a part that is not a rectangle are all left out.
              partVolumeMm3: Math.round(part),
              modelVolumeMm3: Math.round(result.partVolumeMm3),
              partVsModel: result.partVolumeMm3 > 0 ? +(part / result.partVolumeMm3).toFixed(4) : null,
              rapidMovesThatCut: m.rapidCuts,
              deepestRapidCutMm: +m.deepestRapidMm.toFixed(3),
              cellMm: +m.cellMm.toFixed(3),
              meshToleranceMm: +m.toleranceMm.toFixed(3),
              warnings: result.warnings ?? [],
            };
          }

          if (msg.kind === 'laser' || msg.kind === 'contour') {
            const router = msg.machine === 'router';
            const routerRadiusMm = router ? (num(msg.bitDiaMm) ?? 3.175) / 2 : 0;
            // A contour layer is one sheet of the bench's stock, as in its dialog.
            const thicknessMm = num(msg.materialThicknessMm)
              ?? (msg.kind === 'contour' ? useStore.getState().stock.thicknessMm : 3);
            if (msg.kind === 'laser') {
              const result: LaserCutResult = await runJob((c) =>
                c.run('laser', scene, { ...DEFAULT_LASER_OPTIONS, materialThickness: thicknessMm / 1000 }));
              if (!result.success || !result.panels?.length) {
                return { ok: false, error: result.error || 'The panels could not be laid out.', warnings: result.warnings ?? [] };
              }
              const added = await addSimulationToScene({
                sheets: { parts: laserSheetParts(result.panels, result.sheets), routerRadiusMm },
                transform: laserStockTransform(result.panels, result.scaleFactor ?? 1),
                kind: 'laser',
                label: router ? 'Router cut' : 'Laser cut',
                placement,
                details: [`${result.panels.length} panels in ${thicknessMm} mm stock`],
              });
              return {
                ok: true, id: added.id, name: added.name, kind: 'laser', placement,
                panels: result.panels.length,
                volumeMm3: Math.round(added.volumeMm3),
                warnings: result.warnings ?? [],
              };
            }
            const result: ContourSliceResult = await runJob((c) =>
              c.run('contour', scene, { ...DEFAULT_CONTOUR_OPTIONS, materialThickness: thicknessMm / 1000 }));
            if (!result.success || !result.layers?.length || !result.stockTransform) {
              return { ok: false, error: result.error || 'The model could not be sliced.', warnings: result.warnings ?? [] };
            }
            const added = await addSimulationToScene({
              sheets: { parts: contourSheetParts(result.layers, thicknessMm), routerRadiusMm },
              transform: result.stockTransform,
              kind: 'contour',
              label: 'Contour stack',
              placement,
              details: [`${result.layers.length} layers of ${thicknessMm} mm stock`],
            });
            // The model, stretched the way the stack is.
            const tris = collectSceneTriangles(scene).tris;
            let six = 0;
            for (let t = 0; t + 8 < tris.length; t += 9) {
              six += tris[t] * (tris[t + 4] * tris[t + 8] - tris[t + 5] * tris[t + 7])
                - tris[t + 1] * (tris[t + 3] * tris[t + 8] - tris[t + 5] * tris[t + 6])
                + tris[t + 2] * (tris[t + 3] * tris[t + 7] - tris[t + 4] * tris[t + 6]);
            }
            const [sx, sy, sz] = result.stockTransform.scale;
            const model = (six / 6) * 1e9 * sx * sy * sz;
            return {
              ok: true, id: added.id, name: added.name, kind: 'contour', placement,
              layers: result.layers.length,
              volumeMm3: Math.round(added.volumeMm3),
              modelVolumeMm3: Math.round(model),
              stackVsModel: model > 0 ? +(added.volumeMm3 / model).toFixed(4) : null,
              warnings: result.warnings ?? [],
            };
          }

          return { ok: false, error: "kind must be 'relief', 'machining', 'laser', 'contour', 'mold' or 'mold_cast'." };
        }

        case 'REPAIR_MESH':
          return runMcpRepairMesh({
            msg,
            toId: (s) => toId(s) as string,
            nodes: store.sceneGraph.nodes,
            findNodeInScene,
            updateNode: (nodeId, patch) => useStore.getState().updateNode(nodeId, patch),
            compileCsgNodes,
          });

        case 'GET_SCULPT': {
          const { targetId } = msg as Msg<{ targetId: string }>;
          const { node, geomIndex } = sculptTarget(store, targetId);
          return {
            ok: true,
            id: targetId,
            name: node.name,
            ...(node.isSculpt ? { base: node.sculptBase } : { geom: node.geoms[geomIndex].name }),
            edited: !!node.sculptEdited,
            ...sculptSummary(sculptMeshOf(node, geomIndex)),
          };
        }

        case 'APPLY_PATTERN': {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { targetId, patterns } = msg as Msg<{ targetId: string; patterns?: Record<string, any>[] }>;
          if (!targetId) throw new Error('Missing targetId');
          if (Array.isArray(patterns) && patterns.length > 0) {
            const results = [];
            for (const p of patterns) {
              const res = await applySinglePatternToBody(targetId, p);
              if (!res.ok) return res;
              results.push(res);
            }
            return { ok: true, id: targetId, patternsApplied: results.length, patterns: results };
          }
          return await applySinglePatternToBody(targetId, msg);
        }

        case 'KNIFE': {
          const m = msg as Msg<{ targetId: string; at?: number[]; normal?: number[]; cut?: boolean; remove?: boolean }>;
          if (!m.targetId) throw new Error('Missing targetId');
          const node = findNodeInScene(store.sceneGraph.nodes, m.targetId);
          if (!node) throw new Error(`No object with id '${m.targetId}'`);
          const atMm = pointList(m.at)[0];
          if (!atMm) throw new Error('Missing at: a point [x, y, z] the plane passes through, in the body\'s own frame in millimetres.');
          const at = new Vector3(...atMm.map((v) => v / 1000));

          if (m.remove) {
            // The seam passing nearest the point, within 5 mm.
            let best: { geomName: string; index: number; d: number } | null = null;
            const a = new Vector3(), b = new Vector3(), q = new Vector3();
            for (const { geom, base, toBody } of patternSurfaces(node)) {
              splitSeams(base.positions, base.faces, geom.faceSplits ?? []).forEach((seg, index) => {
                for (let i = 0; i + 5 < seg.length; i += 6) {
                  a.set(seg[i], seg[i + 1], seg[i + 2]).applyMatrix4(toBody);
                  b.set(seg[i + 3], seg[i + 4], seg[i + 5]).applyMatrix4(toBody);
                  const ab = b.clone().sub(a);
                  const t = Math.max(0, Math.min(1, at.clone().sub(a).dot(ab) / Math.max(1e-18, ab.lengthSq())));
                  const d = q.copy(a).addScaledVector(ab, t).distanceTo(at);
                  if (!best || d < best.d) best = { geomName: geom.name, index, d };
                }
              });
            }
            const found = best as { geomName: string; index: number; d: number } | null;
            if (!found || found.d > 0.005) return { ok: false, error: `No seam on '${m.targetId}' passes within 5 mm of [${atMm.join(', ')}] mm.` };
            const geom = node.geoms!.find((g) => g.name === found.geomName)!;
            const left = (geom.faceSplits ?? []).filter((_, i) => i !== found.index);
            store.setGeomFaceSplits(node.id, geom.name, left.length ? left : undefined);
            return { ok: true, removed: true, geomName: geom.name, remaining: left.length };
          }

          if (!Array.isArray(m.normal) || m.normal.length !== 3 || !m.normal.every(Number.isFinite)) {
            throw new Error('Missing normal: the direction [x, y, z] square to the plane, in the body\'s own frame.');
          }
          const normal = new Vector3(...m.normal);
          if (normal.lengthSq() < 1e-18) throw new Error('normal must not be [0, 0, 0].');
          normal.normalize();

          if (m.cut) {
            const { soups, absorbed } = knifeSoups(node);
            const result = await cutAlongPlaneOffThread(soups, at.toArray(), normal.toArray());
            if (!result.ok) return { ok: false, error: result.error };
            const carry = carryAcrossCut(node, result.sections, at.toArray(), normal.toArray());
            const ids = useStore.getState().splitBodyForPrint(node.id, result.sections, absorbed, { plain: true, carry });
            return {
              ok: true,
              cut: true,
              pieces: ids.map((id, k) => ({
                id,
                volumeMm3: Math.round(result.sections[k].volumeMm3),
                patterns: carry[k].textures?.length ?? 0,
                seams: carry[k].faceSplits?.length ?? 0,
              })),
            };
          }

          const seams = seamsAcross(node, at, normal);
          if (!seams.length) {
            return { ok: false, error: 'The plane does not divide any face of the part: it misses it, or runs along an edge.' };
          }
          for (const { geomName, split } of seams) {
            const geom = node.geoms?.find((g) => g.name === geomName);
            if (geom) store.setGeomFaceSplits(node.id, geomName, [...(geom.faceSplits ?? []), split]);
          }
          return { ok: true, seams: seams.map(({ geomName, split }) => ({ geomName, facesDivided: split.seeds.length })) };
        }

        case 'CLEAR_PAINT': {
          const { targetId, geomName } = msg as Msg<{ targetId: string; geomName?: string }>;
          if (!targetId) {
            store.clearAllPaint();
            return { ok: true, scope: 'scene' };
          }
          const node = findNodeInScene(store.sceneGraph.nodes, targetId);
          if (!node) throw new Error(`No object with id '${targetId}'`);
          for (const geom of node.geoms || []) {
            if (geomName && geom.name !== geomName) continue;
            if (geom.paint) store.setGeomPaint(targetId, geom.name, undefined);
          }
          return { ok: true, scope: geomName || targetId };
        }

        case 'TOGGLE_PLAY':
          store.togglePlay();
          // `store` is the snapshot from before the toggle.
          return { ok: true, isPlaying: useStore.getState().isPlaying };

        case 'PLAY':
          if (!store.isPlaying) store.togglePlay();
          return { ok: true };

        case 'STOP':
          if (store.isPlaying) store.togglePlay();
          return { ok: true };

        case 'RESET':
          store.resetSimulation();
          getPhysicsWorkerClient().clearHistory();
          return { ok: true };

        case 'LOAD_PRESET': {
          const name = msg.preset as Parameters<typeof store.loadPreset>[0];
          if (!name) return { ok: false, error: 'Missing preset name' };
          // loadPreset ignores a name it doesn't know, and this handler used to
          // report ok and then clear the note cards and chat anyway.
          const known = name.startsWith('user:')
            ? listUserPresetNames().includes(name.slice('user:'.length))
            : Object.hasOwn(PRESETS, name);
          if (!known) return { ok: false, error: `No preset named "${name}". Call physics_list_presets for the valid names.` };
          // Listed from the account by name: its data is fetched on first open.
          if (name.startsWith('user:') && !(await ensureUserPreset(name))) {
            return { ok: false, error: `Preset "${name}" is in the account but could not be fetched from it. Try again.` };
          }
          store.loadPreset(name);
          getPhysicsWorkerClient().clearHistory();
          // The preset's boolean bodies build asynchronously, and this used to
          // answer before they had: a contour slice sent straight after
          // loading the casting flask cut solid blocks, its holes not yet made.
          await compileCsgNodes();
          // Mirror App.tsx's loadPresetWithCard/loadUserPresetWithCard: replace
          // whatever note card is showing with this preset's own card (or clear
          // it) instead of leaving a stale card from whatever was loaded before -
          // this path (MCP LOAD_PRESET) used to skip that entirely, since it
          // calls store.loadPreset directly rather than through those UI wrappers.
          const setter = (window as unknown as PhysicsWindow)._physics_setNoteCards;
          if (setter) {
            if (name.startsWith('user:')) {
              const saved = readUserPreset(name);
              setter(saved && Array.isArray(saved.noteCards) ? saved.noteCards : []);
            } else {
              const presetCard = makePresetNoteCard(name);
              setter(presetCard ? [presetCard] : []);
            }
          }
          const msgSetter = (window as unknown as PhysicsWindow)._physics_setCopilotMessages;
          if (msgSetter) {
            if (name.startsWith('user:')) {
              const saved = readUserPreset(name);
              msgSetter(saved && Array.isArray(saved.copilotMessages) ? saved.copilotMessages : []);
            } else {
              msgSetter([]);
            }
          }
          updateOrCreateNotecard({
            mode: 'mcp',
            nodes: useStore.getState().sceneGraph.nodes
          });
          return { ok: true, preset: name };
        }

        case 'SAVE_PRESET': {
          const name = String(msg.preset || msg.name || '').trim();
          if (!name) return { ok: false, error: 'Missing preset name' };
          const userPresetKey = name.replace(/^user:/, '');
          // Through savePreset, the path the Save button takes, so an agent's
          // save lands where a person's would: in this browser and the account,
          // or the account alone when the browser cannot hold it. This used to
          // write localStorage only, and a big scene failed signed in or not.
          // The graph is SPREAD, not nested under a `sceneGraph` key. A user
          // preset is read back as `{ nodes, noteCards, ... }` — that is the
          // shape App.tsx's own save writes and the shape loadPreset looks for.
          // Nesting it put the nodes one level down, where loadPreset's
          // `Array.isArray(saved.nodes)` guard found nothing and returned
          // quietly: every preset saved over MCP reported ok and then loaded as
          // an empty scene.
          // Pictured like a save by hand, so it sits in the scene browser the
          // same way; savePreset dates it.
          const thumbnail = captureViewportThumb();
          const preset = {
            ...store.sceneGraph,
            noteCards: (window as unknown as PhysicsWindow)._physics_getNoteCards?.() || [],
            copilotMessages: (window as unknown as PhysicsWindow)._physics_getCopilotMessages?.() || [],
            ...(thumbnail ? { thumbnail } : {}),
          };
          const result = await savePreset(userPresetKey, preset);
          // The same notice a person's save raises, so the user sees it happen.
          announcePresetSave(userPresetKey, preset, result);
          if (!result.ok) return { ok: false, error: result.message, bytes: result.bytes };
          // Waited for here, unlike the toast: the agent's answer should say
          // whether the account has it, not that it might.
          const inAccount = result.savedTo === 'cloud' || (result.cloudPending ? await result.cloudPending : false);
          return {
            ok: true,
            preset: `user:${userPresetKey}`,
            savedTo: result.savedTo === 'cloud' ? 'account' : inAccount ? 'browser and account' : 'browser',
            ...(result.signedIn && !inAccount ? { warning: 'Saved in this browser only: the account did not take it.' } : {}),
            message: result.message,
          };
        }

        case 'DELETE_PRESET': {
          const name = String(msg.preset || msg.name || '').trim();
          if (!name) return { ok: false, error: 'Missing preset name' };
          const userPresetKey = name.replace(/^user:/, '');
          if (!deleteUserPreset(userPresetKey)) {
            return { ok: false, error: 'Could not write the preset list to local storage' };
          }
          return { ok: true, preset: name };
        }

        case 'CHECK_COLLISIONS': {
          const nodes = store.sceneGraph.nodes || [];
          const bodyBounds: Array<{ id: string; name: string; min: number[]; max: number[] }> = [];

          const computeBounds = (nodeList: SceneNode[], parentPos: number[] = [0, 0, 0]) => {
            for (const node of nodeList) {
              const nodePos = [
                (node.pos?.[0] || 0) + parentPos[0],
                (node.pos?.[1] || 0) + parentPos[1],
                (node.pos?.[2] || 0) + parentPos[2],
              ];
              const min = [nodePos[0] - 0.1, nodePos[1] - 0.1, nodePos[2] - 0.1];
              const max = [nodePos[0] + 0.1, nodePos[1] + 0.1, nodePos[2] + 0.1];

              (node.geoms || []).forEach((g: SceneGeom) => {
                const s = g.size || [0.1, 0.1, 0.1];
                const halfX = s[0] || 0.1;
                const halfY = s[1] || halfX;
                const halfZ = s[2] || halfX;
                min[0] = Math.min(min[0], nodePos[0] - halfX);
                min[1] = Math.min(min[1], nodePos[1] - halfY);
                min[2] = Math.min(min[2], nodePos[2] - halfZ);
                max[0] = Math.max(max[0], nodePos[0] + halfX);
                max[1] = Math.max(max[1], nodePos[1] + halfY);
                max[2] = Math.max(max[2], nodePos[2] + halfZ);
              });

              bodyBounds.push({ id: node.id || node.name, name: node.name || node.id, min, max });
              if (node.children) computeBounds(node.children, nodePos);
            }
          };

          computeBounds(nodes);

          const overlappingPairs: Array<{ bodyA: string; bodyB: string }> = [];
          for (let i = 0; i < bodyBounds.length; i++) {
            for (let j = i + 1; j < bodyBounds.length; j++) {
              const a = bodyBounds[i];
              const b = bodyBounds[j];
              const overlap = (
                a.min[0] <= b.max[0] && a.max[0] >= b.min[0] &&
                a.min[1] <= b.max[1] && a.max[1] >= b.min[1] &&
                a.min[2] <= b.max[2] && a.max[2] >= b.min[2]
              );
              if (overlap) {
                overlappingPairs.push({ bodyA: a.name, bodyB: b.name });
              }
            }
          }

          // A body whose cavity is filled in is the other reason a scene does
          // not behave: nothing overlaps, and the ball still will not go in.
          // This is the command someone runs when that happens, so say it here
          // rather than make them go looking in the scene summary.
          const filledCavities: Array<{ body: string; solidity: number }> = [];
          const collectFilled = (ns: SceneNode[]) => {
            for (const n of ns || []) {
              const hasColliders = (n.geoms || []).some((g: SceneGeom) => g.csgDerived === 'collider');
              if (!hasColliders && n.collisionSolidity !== undefined && n.collisionSolidity < SOLIDITY_DECOMPOSE_BELOW) {
                filledCavities.push({ body: n.name || n.id, solidity: n.collisionSolidity });
              }
              collectFilled(n.children || []);
            }
          };
          collectFilled(nodes);

          return {
            ok: true,
            hasInterpenetrations: overlappingPairs.length > 0,
            bodyCount: bodyBounds.length,
            overlappingPairs,
            ...(filledCavities.length ? {
              filledCavities,
              note: 'These bodies are hollow but collide as their convex hull, so their cavities are solid to contact — anything dropped in rests on the rim. Set collision:\'decompose\' on them, or simplify the mesh if it was declined for being too dense.',
            } : {}),
          };
        }

        case 'IMPORT_STL': {
          const { stlData, name, importMode, pos, scale, dynamic } =
            msg as Msg<{ stlData?: string; name?: string; importMode?: string; scale?: number | [number, number, number]; dynamic?: boolean }>;
          if (!stlData) return { ok: false, error: 'Missing stlData (Base64 string or ASCII text)' };

          let data: ArrayBuffer | string;
          try {
            if (typeof stlData === 'string' && stlData.startsWith('data:')) {
              // Not split(',', 1): its limit keeps only the first piece, so the
              // payload was never found and every data URL failed to decode.
              const b64 = stlData.slice(stlData.indexOf(',') + 1);
              const binary = atob(b64);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
              data = bytes.buffer;
            } else if (typeof stlData === 'string' && !stlData.includes('solid')) {
              try {
                const binary = atob(stlData.trim());
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                data = bytes.buffer;
              } catch {
                data = stlData;
              }
            } else {
              data = stlData;
            }
          } catch (e) {
            return { ok: false, error: `Failed to decode STL payload: ${String(e)}` };
          }

          const baseName = name || 'imported_stl';
          const parsed = parseSTL(data, { name: baseName, scale });

          // The nodes below are written without geom or joint names, as this
          // import always has — MuJoCo names them itself. Said out loud rather
          // than filled in: naming them would change what lands in the scene.
          const mode = importMode || 'scad_parametric';
          const nodePos = Array.isArray(pos) && pos.length === 3 ? pos : [0, 0, 1];
          const id = `stl_${Math.random().toString(36).slice(2, 7)}`;
          let newNode: SceneNode;

          if (mode === 'scad_parametric') {
            newNode = {
              id,
              name: baseName,
              pos: nodePos,
              scad: parsed.scadParametric,
              geoms: [{ type: 'mesh', size: [1], dynamic: dynamic !== false } as SceneGeom],
              joints: [{ type: 'free' } as SceneJoint],
              children: [],
            };
          } else if (mode === 'scad_raw') {
            newNode = {
              id,
              name: baseName,
              pos: nodePos,
              scad: parsed.scadRaw,
              geoms: [{ type: 'mesh', size: [1], dynamic: dynamic !== false } as SceneGeom],
              joints: [{ type: 'free' } as SceneJoint],
              children: [],
            };
          } else if (mode === 'mesh') {
            newNode = {
              id,
              name: baseName,
              pos: nodePos,
              geoms: [{
                type: 'mesh',
                vertices: parsed.vertices,
                faces: parsed.faces,
                renderVertices: parsed.renderVertices,
                dynamic: dynamic !== false,
              } as SceneGeom],
              joints: [{ type: 'free' } as SceneJoint],
              children: [],
            };
          } else {
            newNode = {
              id,
              name: baseName,
              pos: nodePos,
              geoms: [{
                type: parsed.primitiveGeom.type,
                size: parsed.primitiveGeom.size,
                rgba: [0.3, 0.7, 0.9, 1],
              } as SceneGeom],
              joints: [{ type: 'free' } as SceneJoint],
              children: [],
            };
          }

          const currentNodes = store.sceneGraph.nodes || [];
          const updatedNodes = [...currentNodes, newNode];
          const res = await settleScene(updatedNodes, { replacesScene: false });

          return {
            ok: res.ok,
            nodeId: id,
            name: baseName,
            vertCount: parsed.vertices.length / 3,
            faceCount: parsed.faces.length / 3,
            subComponentCount: parsed.subComponents.length,
            inferredSpacing: parsed.inferredSpacing,
            boundingBox: parsed.boundingBox,
            scadCode: newNode.scad,
          };
        }

        case 'LIST_PRESETS': {
          const userKeys = listUserPresetNames().map(k => `user:${k}`);
          return [...Object.keys(PRESETS), ...userKeys];
        }

        case 'SCREENSHOT': {
          const win = window as unknown as PhysicsWindow;
          const gl = win._physics_gl;
          if (!gl || !gl.domElement) return { ok: false, error: 'Renderer not ready yet' };

          /*
           * Draw a frame before reading one.
           *
           * This used to rely on r3f redrawing every animation frame and on
           * preserveDrawingBuffer keeping the last one about. That holds while
           * something is moving; it does not when the viewport goes idle — a
           * paused simulation, a backgrounded tab — and then toDataURL returns
           * whatever was last painted, which can be minutes old and framed by a
           * camera that has since moved. The caller cannot tell: they get a
           * perfectly good PNG of a scene that is not there any more. That is
           * worse than an error, and it is exactly what happened while building
           * a model through this bridge — five camera moves, five identical
           * frames of empty floor, with the model sitting in the scene the whole
           * time.
           */
          // The collider overlay, for this frame only: switched, given two
          // frames to mount and track its bodies, and put back afterwards.
          const viewQuality = useViewQuality.getState();
          const restoreColliders = viewQuality.showColliders;
          if (typeof msg.showColliders === 'boolean' && msg.showColliders !== restoreColliders) {
            viewQuality.setShowColliders(msg.showColliders);
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          }

          // Through the composer when there is one; see renderViewportNow.
          renderViewportNow();

          const dataUrl = gl.domElement.toDataURL('image/png');
          if (useViewQuality.getState().showColliders !== restoreColliders) {
            useViewQuality.getState().setShowColliders(restoreColliders);
          }
          return {
            ok: true,
            dataUrl,
            width: gl.domElement.width,
            height: gl.domElement.height,
            // Says whether the frame was drawn to order or is whatever the
            // canvas happened to be holding.
            rendered: Boolean(win._physics_scene && win._physics_camera),
          };
        }

        case 'GET_NOTE_CARDS': {
          const getter = (window as unknown as PhysicsWindow)._physics_getNoteCards;
          return { ok: true, noteCards: getter ? getter() : [] };
        }

        case 'SET_NOTE_CARDS': {
          const setter = (window as unknown as PhysicsWindow)._physics_setNoteCards;
          if (!setter) return { ok: false, error: 'Note card state not available' };
          if (!Array.isArray(msg.noteCards)) return { ok: false, error: 'noteCards must be an array' };
          setter(msg.noteCards);
          return { ok: true };
        }

        case 'VALIDATE_SCAD': {
          const scadCode = msg.scad as string | undefined;
          if (scadCode === undefined) {
            return { ok: false, error: 'Missing scad parameter' };
          }
          try {
            const result = await compileSCAD(scadCode);
            if (!result || result.faces.length === 0) {
              return { ok: false, error: 'Compilation produced an empty mesh (0 faces)' };
            }
            const bbox = bboxOf(result.renderVertices || result.vertices);
            const sizeM = bbox ? [0, 1, 2].map(a => bbox.max[a] - bbox.min[a]) : undefined;
            const diagonalM = sizeM ? Math.hypot(...sizeM) : undefined;
            const warning = diagonalM !== undefined && diagonalM > SUSPICIOUSLY_LARGE_DIAGONAL_M
              ? `Compiled mesh bounding box is ${sizeM!.map(v => v.toFixed(2)).join(' x ')} meters (diagonal ${diagonalM.toFixed(1)}m) — did you forget to wrap your design in scale([0.001,0.001,0.001])? MuJoCo units are meters, so millimeter-scale OpenSCAD designs compile 1000x too large without it.`
              : undefined;
            return {
              ok: true,
              vertCount: (result.renderVertices || result.vertices || []).length / 3,
              faceCount: (result.faces || []).length / 3,
              boundingBoxM: bbox,
              ...(warning ? { warning } : {}),
            };
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        }

        case 'LOAD_SCENE_FILE': {
          // An Export JSON file, read off disk by the MCP server so that a scene
          // of many megabytes never passes through a tool call. Loaded the way
          // App.tsx's Import JSON loads one: the whole graph as written (name,
          // castPrep and simFidelity included, no default-filling - the file came
          // out of this app), its note cards and chat, the sim stopped, and no
          // preset claiming the scene, so Save cannot overwrite one with it.
          const scene = unpackMeshArrays(msg.scene) as (SceneGraph & { noteCards?: unknown; copilotMessages?: unknown }) | undefined;
          if (!scene || !Array.isArray(scene.nodes)) {
            return { ok: false, error: 'The file is not a Mesh scene: it has no "nodes" array.' };
          }
          const { noteCards, copilotMessages, ...graph } = scene;
          if (store.isPlaying) store.togglePlay();
          store.setSculptNodeId(null);
          store.setLatticeNodeId(null);
          store.setActivePreset(undefined);
          store.updateScene(graph, true);
          // Awaited, unlike Import JSON's: the reply has to say whether it built.
          await useStore.getState().recompile(useStore.getState().sceneGraph);
          getPhysicsWorkerClient().clearHistory();
          const win = window as unknown as PhysicsWindow;
          win._physics_setNoteCards?.(Array.isArray(noteCards) ? noteCards as NoteCard[] : []);
          win._physics_setCopilotMessages?.(Array.isArray(copilotMessages) ? copilotMessages as SavedCopilotMessage[] : []);
          const error = useStore.getState().lastCompileError;
          return {
            ok: !error,
            ...(error ? { error } : {}),
            nodeCount: graph.nodes.length,
            noteCardCount: Array.isArray(noteCards) ? noteCards.length : 0,
          };
        }

        case 'UPDATE_SCENE': {
          if (!msg.sceneGraph) return { ok: false, error: 'Missing sceneGraph' };
          // The MCP tool schema passes sceneGraph as a bare array of nodes (matching
          // BUILD_SCENE's convention); also accept the internal { nodes: [...] } shape.
          const rawScene = msg.sceneGraph as RawNode[] | { nodes?: RawNode[] };
          const rawNodes = Array.isArray(rawScene) ? rawScene : rawScene.nodes;
          if (!Array.isArray(rawNodes)) {
            return { ok: false, error: 'sceneGraph must be an array of nodes, or an object of the form { nodes: SceneNode[] }' };
          }
          // Run through the same default-filling as BUILD_SCENE so a node missing
          // joints/geoms/children (very easy to hand-author without, e.g. by
          // editing the output of GET_SCENE_SUMMARY, which strips these arrays)
          // doesn't crash compileToMJCF's unconditional .forEach on those fields.
          const nodes = rawNodes.map((b) => fillBodyDefaults(b));
          const result = await settleScene(nodes);
          updateOrCreateNotecard({
            mode: 'mcp',
            nodes: useStore.getState().sceneGraph.nodes
          });
          return result;
        }

        case 'SET_ENVIRONMENT': {
          const { gravityZ, windX, windY, density, floorFriction, floorBounce, fidelity, stockWidthMm, stockDepthMm, stockThicknessMm } =
            msg as Msg<{ gravityZ?: number; windX?: number; windY?: number; density?: number; floorFriction?: number; floorBounce?: number; fidelity?: string; stockWidthMm?: number; stockDepthMm?: number; stockThicknessMm?: number }>;
          // The board on the bench: what every carve, export and fit check uses.
          const stockPatch = {
            ...(typeof stockWidthMm === 'number' && stockWidthMm > 0 ? { widthMm: stockWidthMm } : {}),
            ...(typeof stockDepthMm === 'number' && stockDepthMm > 0 ? { depthMm: stockDepthMm } : {}),
            ...(typeof stockThicknessMm === 'number' && stockThicknessMm > 0 ? { thicknessMm: stockThicknessMm } : {}),
          };
          if (Object.keys(stockPatch).length > 0) store.setStock(stockPatch);
          if (fidelity !== undefined) {
            if (fidelity !== 'standard' && fidelity !== 'print') return { ok: false, error: `fidelity must be 'standard' or 'print', not '${fidelity}'.` };
            store.setSimFidelity(fidelity);
          }
          const env: Record<string, number> = {};
          if (gravityZ !== undefined) env.gravityZ = gravityZ;
          if (windX !== undefined) env.windX = windX;
          if (windY !== undefined) env.windY = windY;
          if (density !== undefined) env.density = density;
          if (floorFriction !== undefined) env.floorFriction = floorFriction;
          if (floorBounce !== undefined) env.floorBounce = floorBounce;
          store.setEnvironment(env);
          return {
            ok: true,
            ...(Object.keys(stockPatch).length > 0
              ? { stock: stockReport(useStore.getState().sceneGraph, useStore.getState().stock) }
              : {}),
          };
        }

        case 'GET_SCHEMA':
          return {
            choosingTheRightTool: {
              ruleOfThumb: 'Build detailed scenes in ONE call to physics_build_scene (or add parts with physics_add_object) using declarative body features instead of making 20 sequential tool calls or hand-writing raw triangle arrays.',
              mechanicalPartsWithHolesThreadsRounding: 'Use primitive geoms + declarative `cuts: [...]`, `roundEdges: [...]`, `patterns: [...]`, and `paint: [...]` directly on the body descriptor in physics_build_scene / physics_add_object / physics_update_object, OR boolean geoms (`csg: "difference" | "intersection"`).',
              extruded2DProfilesWithHoles: 'Use `type: "extrude"` (or `"prism"`) with `polygon: [[x,y], ...]` (metres), optional `holes: [[[x,y], ...]]`, and `height` (metres) on a geom or body.',
              turnedOrAxisymmetricParts: 'Use `type: "lathe"` (or `"revolve"`) with `profile: [[r,z], ...]` (metres) on a geom or body, OR a declarative lattice `{ lattice: { empty: true, subdiv: 1, ops: [{ op: "revolve", profile: [[xMm,0,zMm], ...] }] } }`.',
              conesWedgesToriTubes: 'Use parametric geom types directly: `cone` (`size: [r, hh]`), `pyramid` (`size: [hx, hy, hh]`), `wedge` (`size: [hx, hy, hz]`), `torus` (`size: [R, r]`), `tube` / `pipe` (`size: [outerR, innerR, hh]`).',
              subdivisionAndGridPolyhedra: 'Use declarative `lattice: { sizeMm: 40, subdiv: 1, thicknessMm: 0, ops: [{ op: "extrude" | "inset" | "bevel" | "bevel_edges" | "circle" | "revolve" | "bridge" | "faces" | "delete_faces" | "sharpen" | "dimension" | "orient" | "smooth" | "wall", ... }] }` on the body, or pass `ops: [...]` to `physics_create_lattice`.',
              organicClayShapes: 'Use declarative `sculpt: { base: "sphere" | "Bust" | ..., strokes: [...], cuts: [...] }` on the body, or pass batch `strokes: [...]` to `physics_sculpt`.',
              curvedTracksAndRamps: 'Set `isCurve: true` and `curvePoints: [[x,y,z], ...]` (Z-up metres) on the body.',
              ropesCablesChains: 'Set `isComposite: true`, `compositeType: "cable"`, `compositeCount`, `compositeSize` on the body.',
              customPolyhedra: 'If you must supply raw triangles (`type: "mesh"`), pass `verticesZUp: [x0,y0,z0, ...]` in standard MuJoCo Z-up metres (auto-converted to Y-up `vertices` and `renderVertices`, with inside-out closed meshes auto-flipped). Avoid hand-typing hundreds of coordinates when `extrude`, `lathe`, `lattice`, or `scad` can express the shape in 5 lines.',
            },
            geomTypes: ['box', 'sphere', 'capsule', 'cylinder', 'ellipsoid', 'plane', 'cone', 'pyramid', 'wedge', 'torus', 'tube', 'extrude', 'lathe', 'mesh'],
            geomSizes: {
              box:       'half-extents [hx, hy, hz]',
              sphere:    'radius [r]',
              capsule:   'radius and half-height [r, hh] — cylinder between the two end-caps. ALWAYS give both elements (or use fromto): a 1-element [r] does not error, it silently falls back to hh=r and collapses the geom into a tiny stub pill at pos.',
              cylinder:  'radius and half-height [r, hh]',
              ellipsoid: 'semi-axes [rx, ry, rz]',
              plane:     'ignored by MuJoCo (infinite plane) — set to [0, 0, 1] or any non-zero',
              cone:      '[radius, halfHeight] (or `radius` and `height` fields in metres) — auto-generates a closed outward-wound cone mesh',
              pyramid:   '[hx, hy, halfHeight] (or `width`, `depth`, `height` in metres) — 4-sided pyramid mesh',
              wedge:     '[hx, hy, hz] (or `width`, `depth`, `height` in metres) — right-triangular prism / ramp mesh',
              torus:     '[majorRadius, tubeRadius] (or `majorRadius`, `tubeRadius` in metres) — watertight torus ring in XY plane around Z axis',
              tube:      '[outerRadius, innerRadius, halfHeight] (or `outerRadius`, `innerRadius`, `height` in metres; alias `pipe` / `hollow_cylinder`) — hollow cylinder / pipe mesh',
              extrude:   '2D polygon prism (alias `prism`): provide `polygon: [[x,y], ...]` in metres, optional `holes: [[[x,y], ...]]`, and `height` in metres (or `size: [halfHeight]`). Centered on Z by default (`centered: false` spans z=0..height).',
              lathe:     'revolved 2D profile around Z axis (alias `revolve`): provide `profile: [[r,z], ...]` in metres and optional `segments` (default 24).',
              mesh:      'arbitrary triangle mesh via `verticesZUp` (preferred, Z-up metres) or `vertices` (Three.js Y-up metres) + `faces`. Defaults to `dynamic: true` so body `pos`/`euler`/`quat` and geom `pos`/`euler`/`quat` always position the mesh in Z-up space.',
            },
            jointTypes: ['hinge', 'slide', 'ball', 'free'],
            geomFields: {
              name:        'string — unique identifier',
              type:        'GeomType (see geomTypes — includes parametric mesh shorthands cone, pyramid, wedge, torus, tube, extrude, lathe)',
              size:        'number[] — interpretation depends on type (see geomSizes)',
              rgba:        'number[4] — [r, g, b, a] each 0-1, default white opaque',
              pos:         'number[3] — local offset from body origin in Z-up metres, NOT world-space (works on all geoms including dynamic meshes)',
              quat:        'number[4] — [w, x, y, z] rotation quaternion',
              euler:       'number[3] — [roll, pitch, yaw] in degrees, alternative to quat',
              fromto:      'number[6] — [x1,y1,z1, x2,y2,z2] for capsule/cylinder endpoints (overrides size/pos/quat)',
              mass:        'number — if set, overrides density-based mass for this geom',
              friction:    'number[3] — [slide, spin, roll]. slide: tangential friction (0=icy, 1=normal, 2=rubbery). spin: torsional (typical 0.005). roll: rolling resistance (typical 0.0001).',
              contype:     'number — bitmask for collision group membership',
              conaffinity: 'number — bitmask for which groups this geom collides with',
              condim:      'number — contact dimensionality (1, 3, 4, or 6)',
              solref:      'number[2] — [timeconst_s, dampingRatio]. timeconst_s: contact spring time constant in seconds (min 0.005s = 5x timestep, 0.04 is a safe default). dampingRatio: 1.0=no bounce (critically damped), 0.0=max bounce, ~0.2=lively. Contact blends both geoms by averaging — floor has dampingRatio=0.0 so it does not kill ball bounce.',
              solimp:      'number[5] — [d0, d1, width, midpoint, power]. d0/d1: min/max impedance (0.99/0.9999 for hard contact). Typical bouncy: [0.99, 0.9999, 0.0001, 0.5, 2].',
              verticesZUp: 'number[] — PREFERRED for custom meshes: flat [x0,y0,z0, x1,y1,z1, ...] in standard MuJoCo Z-up metres. Automatically populates Three.js Y-up `vertices` and `renderVertices`, and auto-flips closed meshes if wound inside-out.',
              vertices:    'number[] — flat array of vertex positions for mesh type: [x0,y0,z0, x1,y1,z1, ...] in Three.js Y-up space (optional if `verticesZUp` or `renderVertices` is provided)',
              faces:       'number[] — flat array of triangle indices for mesh type: [i0,j0,k0, i1,j1,k1, ...]. Closed meshes with uniformly inverted winding are automatically flipped outward.',
              polygon:     'number[][] — for `type: "extrude"`: 2D `[x, y]` vertices in metres',
              holes:       'number[][][] — for `type: "extrude"`: optional array of 2D `[x, y]` hole loops in metres',
              profile:     'number[][] — for `type: "lathe"`: 2D `[r, z]` profile points in metres revolved around Z',
              dynamic:     'boolean — defaults to `true` for all mesh geoms so body `pos`/`euler` work in Z-up space',
              csg:         `'union'|'difference'|'intersection' — boolean modifier (default 'union'). A geom marked 'difference' is CUT OUT of the union of the body's other geoms instead of being added to it: one ellipsoid plus a slimmer ellipsoid marked 'difference' is a ring. The body is compiled to a single mesh; set collision on the body to choose how it collides.`,
              thread:      `{ pitch: number, left?: boolean, fit?: number } — on any cylinder. On one marked 'difference' the hole is tapped; on any other the cylinder becomes a threaded rod (external ISO thread), which makes the body a boolean one. pitch and fit are in METRES (M6 coarse is 0.001). The cylinder's radius is the thread's MAJOR radius, so an M8 rod (radius 0.004, pitch 0.00125) screws into an M8 tapped hole as drawn. For holes, declarative cuts or physics_cut's threadPitchMm is easier.`,
              role:        `'visual'|'collision' — 'visual' draws but never collides (contype/conaffinity forced to 0), 'collision' simulates but is never drawn. Default (omitted) is both.`,
              renderVertices: 'number[] — flat [x0,y0,z0,...] in raw MuJoCo Z-up space. Auto-derived from `verticesZUp` or `vertices` if omitted.',
            },
            nodeFields: {
              id:            'string — unique body identifier (used in coupling/weld/connect refs)',
              name:          'string — display name, also used in MuJoCo XML',
              pos:           'number[3] — position relative to parent (world for root nodes)',
              quat:          'number[4] — body orientation quaternion [w,x,y,z]',
              euler:         'number[3] — body orientation in degrees, alternative to quat',
              static:        'boolean — if true (or `fixed: true` / `dynamic: false`), omits the default free joint so a top-level body is fixed in world space',
              geoms:         'SceneGeom[] — one or more geoms composing the body shape (optional if body-level `type`/`size` shorthand, `lattice`, `sculpt`, `isCurve`, or `scad` is used)',
              cuts:          'DeclarativeCut[] — array of hole/slot/dish/hardware cut specs `{ shape?: "cylinder"|"slot"|"dish"|"counterbore"|"countersink"|"hex_socket"|"nut_trap"|"heat_set_insert"|"bearing_seat"|"o_ring_groove"|"t_slot", at?: [xMm,yMm,zMm], normal?: [nx,ny,nz], diameterMm?, widthMm?, lengthMm?, depthMm?, threadPitchMm?, size?: "M3"|"M4"|..., bore?, fitMm? }` applied automatically when the body is built or updated',
              roundEdges:    'DeclarativeRound[] | DeclarativeRound — `{ edges?: "all"|"top"|"bottom"|"vertical"|"inside"|number[], sizeMm: number, mode?: "round"|"bevel" }` (or array of them; alias `roundings`) applied automatically after cuts',
              patterns:      'DeclarativePattern[] — array of surface textures `{ at: [xMm,yMm,zMm], normal?: [nx,ny,nz], pattern: "knurl"|"hex"|"ribs"|"grid"|"wave"|"dimples"|"voronoi"|"flutes"|"threads"|"text", depthMm?: number, emboss?: boolean, options?: {...} }` applied automatically to the body faces',
              paint:         'DeclarativePaint[] — array of paint strokes `{ at: [x,y,z] | [[x,y,z],...], rgba: [r,g,b,a?], radius?: number, flow?: number, geomName?: string }` (in metres) applied automatically after CSG',
              lattice:       '`{ sizeMm?: number, empty?: boolean, subdiv?: 0|1|2, thicknessMm?: number, ops?: LatticeOp[] }` — builds a lattice body inline in a single pass. Each op in `ops` is `{ op: "extrude"|"inset"|"bevel"|"bevel_edges"|"circle"|"revolve"|"bridge"|"faces"|"delete_faces"|"sharpen"|"dimension"|"orient"|"smooth"|"wall", ... }` in mm.',
              sculpt:        '`{ base?: "sphere"|"cube"|"cylinder"|"torus"|"capsule"|"cone"|"Bust"|"Head"|"Hand", strokes?: SculptStroke[], cuts?: SculptCut[] }` — builds a sculpted clay body inline in a single pass.',
              joints:        'SceneJoint[] — joints attaching this body to its parent',
              children:      'SceneNode[] — child bodies (rigidly offset unless they have joints)',
              coupleTargetId:'string — id of another body; couples their first joints with coupleRatio',
              coupleRatio:   'number — gear ratio for explicit joint coupling (default -1)',
              weldTargetId:  'string — id of body to weld to (closed-loop rigid constraint)',
              weldBreakForceN:    'number — newtons of pull this weld survives before it shears off. Omit and it never breaks. A 1 kg body hanging off a weld pulls about 10 N. Breaking is transient: the scene graph still says the part is welded on, and reset puts it back.',
              weldBreakTorqueNm:  'number — newton-metres of twist this weld survives. Same rules as weldBreakForceN; either limit alone is enough.',
              weldBreakHoldSteps: 'number — consecutive overloaded steps required before it counts (default 3). Guards against the single-step force spike a hard contact produces.',
              connectTargetId:'string — id of body to connect to via a ball-and-socket point constraint',
              connectAnchor: 'number[3] — world-space anchor point for the connect constraint',
              script:        'string — JavaScript control script running at 1000 Hz',
              scad:          'string — raw OpenSCAD code to compile into a dynamic mesh geometry',
              isComposite:   'boolean — emit this body as a MuJoCo <composite> (auto-jointed chain forming a smooth curve) instead of using its own geoms/joints/children directly. See compositeType/compositeCount/compositeSize/compositeCurve. Prefer this over manually chaining capsule fromto segments for rope/cable/mustache/tentacle curves.',
              compositeType: `'cable'|'grid'|'rope'|'cloth' — default 'cable'. 'rope' is remapped to MuJoCo's 'cable' type.`,
              compositeCount:'string (not array) — space-separated segment counts, e.g. "25 1 1". Default "15 1 1".',
              compositeSize: 'string (not number) — total extent before curving, e.g. "1.5". Default "1.5".',
              compositeCurve:'string — MuJoCo composite curve-shape spec, e.g. "s 0 0" for straight. Passed verbatim to MuJoCo, not validated here.',
              compositePrefix:'string — name prefix for auto-generated segment bodies (default `${name}_`). Last segment auto-name is `${compositePrefix}B_last`.',
              weldLastToId:  'string — id of another body to weld the composite\'s LAST segment to (e.g. anchoring a rope/cable end). Only used when isComposite is true.',
              isCurve:       'boolean — RIGID curved track: a Catmull-Rom spline through curvePoints is decomposed into many small convex box geoms, so collision follows the real (even concave) curve — balls roll along it. Omit geoms and joints: geoms are auto-generated and the body defaults to static (welded to world). Contrast with isComposite (a floppy rope/cable).',
              curvePoints:   'number[][] — body-local Z-up control points, e.g. [[-1.6,0,1.4],[-0.55,0,0.45],[0.45,0,0.12],[1.6,0,0.7]]. The spline IS the rolling surface (boxes sit half a thickness below it). Default is a ramp-with-valley demo curve.',
              curveWidth:    'number — track width in meters (default 0.5)',
              curveThickness:'number — slab thickness in meters (default 0.06)',
              curveSegments: 'number — how many box segments approximate the spline (default 28; more = smoother)',
              curveClosed:   'boolean — wrap the spline into a seamless closed loop (oval/circuit tracks). Default false.',
              curveBank:     'number — bank (roll) angle in degrees about the travel direction; positive raises the left-of-travel edge. For a counter-clockwise loop use a NEGATIVE bank to raise the outside edge (see the oval_track preset, which uses -18).',
              csgEnabled:    'boolean — evaluate this body\'s geoms as a boolean program (see the geom `csg` field). Inferred automatically when any geom is marked difference/intersection, so you rarely need to set it. The primitives remain the source of truth; the mesh is regenerated whenever they change.',
              edgeRounds:    'array — rounded (fillet) and bevelled (chamfer) edges, each { mode: "fillet"|"chamfer", size (m), edges }. Use declarative `roundEdges` on the body or `physics_round_edges` rather than authoring raw edge geometry by hand.',
              collision:     `'auto'|'hull'|'decompose'|'primitives' — how THIS BODY collides, mesh or boolean. MuJoCo collides a mesh as its CONVEX HULL, which fills in any cavity, so a cup, bowl, open-top box, funnel or housing would be solid to contact. 'auto' (the default) measures SOLIDITY — true volume over hull volume — and breaks the shape into convex pieces when it is below ~0.92. A box or sphere is 1.0 and keeps its hull, which is exact and cheap; a cup is around 0.3 and gets decomposed, so a ball dropped in lands INSIDE it. 'hull' forces the old filled-in behaviour. 'decompose' forces the split even for a mesh auto declined (under ~24 triangles, or over ~150k). 'primitives' is boolean-only: the authored positives collide and the mesh is visual. Runs in the background and is cached against the mesh, so it costs nothing until the shape changes. NOTE a decomposed hollow body weighs its true volume rather than its hull's — often a third as much; set mass or collisionMass if you wanted the heavier figure.`,
              collisionResolution: `number — V-HACD voxel count for this body's decomposition, 10,000 to 400,000. Default 25,000, with one automatic retry at 100,000 and 32 pieces when the first result fills a cavity in (physics_get_scene_summary reports any left as cavitiesFilled). Raise it for a narrow slot or groove that still comes out solid; it costs decomposition time, not simulation time.`,
              collisionHulls: `number — how many convex pieces to break this body into. Default: 8 to 16, scaled by how concave it is. Contact cost between two decomposed bodies is quadratic in this, and accuracy is flat past about 16, so raise it only for a shape whose cavity is genuinely being missed.`,
              collisionMass: `number (kg) — total mass shared across the convex pieces by volume, as csgMass is for a boolean body.`,
              csgCollision:  `DEPRECATED, use 'collision'. Still read, so older scenes behave as they always did. 'auto'|'decompose'|'primitives'|'hull' — how the boolean result collides.`,
              csgSectors:    'number — sector count for decomposition (default 16). Higher = tighter fit to the hole, more geoms.',
              csgHoleAxis:   `'auto'|'x'|'y'|'z' — axis the hole runs along, for decomposition. 'auto' takes the longest axis of the largest negative geom.`,
              csgMass:       'number — total mass of the boolean solid, split across its colliders by volume. Without this, MuJoCo would derive mass from the hull volume, which for a ring is far more material than there actually is.',
              csgFn:         'number — OpenSCAD $fn (facet count) for the generated primitives (default 32).',
            },
            tips: [
              'ONE-CALL SCENE BUILDING — You can include `cuts`, `roundEdges`, `patterns`, `paint`, `lattice`, and `sculpt` directly on any body inside `physics_build_scene` or `physics_add_object`. Everything compiles in a single pass without needing 20 follow-up tool calls.',
              'BATCH TOOL CALLS — Existing modification tools also accept batch arrays: `physics_cut(targetId, cuts=[...])`, `physics_round_edges(targetId, roundings=[...])`, `physics_sculpt(targetId, strokes=[...])`, `physics_paint(targetId, strokes=[...])`, `physics_apply_pattern(targetId, patterns=[...])`, and `physics_create_lattice(..., ops=[...])`.',
              'PARAMETRIC MESH SHORTHANDS — Use `type: "cone" | "pyramid" | "wedge" | "torus" | "tube" | "extrude" | "lathe"` on any geom or body instead of hand-building raw vertex/face arrays.',
              'Z-UP CUSTOM MESHES — When building custom polyhedra with `type: "mesh"`, supply `verticesZUp: [x0,y0,z0, ...]` in standard MuJoCo Z-up metres. You do NOT need to convert to Three.js Y-up `vertices` or supply `renderVertices`, and closed meshes with negative signed volume are automatically flipped right-side out.',
              'GOTCHA — geom pos is body-local, not world-space: for a body at pos [0,0,0.4] with a box half-extent of 0.4, local z=0 is the box center (world z=0.4) and local z=+0.4 is the top face (world z=0.8). Do not pick pos values as if they were world heights.',
              'PREFER over manual capsule-chain curves: for rope/cable/mustache/tentacle/vine shapes, set isComposite:true + compositeType:\'cable\' + compositeCount/compositeSize/compositeCurve on one body instead of hand-placing many capsule fromto segments.',
              'Compound shapes: add multiple geoms to one body with different pos/quat/euler offsets (works for both primitives and parametric/custom meshes).',
              'Rings/tubes/holes — use `type: "tube"` / `"torus"`, declarative `cuts: [...]`, or boolean modifiers (`csg: "difference"`).',
              'HOLLOW AND CONCAVE SHAPES JUST WORK — do not build proxy walls. `collision: "auto"` (the default) measures solidity and decomposes any concave mesh body into convex pieces automatically so balls land inside cups, bowls, funnels, and housings.',
              'GOTCHA — rgba alpha is NOT rendered as transparency in this app: the renderer\'s material always uses full opacity regardless of the 4th rgba value, so rgba:[r,g,b,0] does NOT make a geom invisible — use `role: "collision"` for invisible colliders or `role: "visual"` for non-colliding visuals.',
              'OpenSCAD shapes: set scad="cube([0.5,0.5,0.5]);" on a body node. If geoms is omitted, it automatically creates a dynamic mesh geom and compiles the SCAD code to vertices/faces.',
              'Bouncy objects: set solref=[0.04, 0.2] and solimp=[0.99, 0.9999, 0.0001, 0.5, 2]. dampingRatio 0.2 = lively bounce. The floor has dampingRatio=0.0 so ball+floor averages to 0.1 (still bouncy).',
            ],
          };

        case 'BUILD_SCENE': {
          // High-level helper: accepts an array of body descriptors and assembles a valid sceneGraph.
          // Each descriptor can have the same fields as SceneNode but `geoms` may be a shorthand array
          // of plain objects — missing fields are filled with safe defaults so agents don't need to
          // supply every field.
          const bodies = msg.bodies as RawNode[];
          if (!Array.isArray(bodies) || bodies.length === 0) {
            return { ok: false, error: 'bodies must be a non-empty array' };
          }

          const nodes = bodies.map((b) => fillBodyDefaults(b));
          const result = await settleScene(nodes);
          updateOrCreateNotecard({
            mode: 'mcp',
            nodes: useStore.getState().sceneGraph.nodes
          });
          return result;
        }

        default:
          return { error: `Unknown command: ${cmd}` };
      }
    };

    connect();
    return () => {
      dead = true;
      clearTimeout(retryTimer);
      ws?.close();
      // Nothing can reply for a command once the bridge is gone, so don't leave
      // its badge behind (a dev-time remount would otherwise strand it).
      useStore.getState().resetMcpActive();
    };
  }, []);
}
