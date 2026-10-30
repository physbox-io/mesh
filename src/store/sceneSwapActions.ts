// ---------------------------------------------------------------------------
// The store's scene loading: a preset, or a scene a generator made
//
// A swap keeps drawing the outgoing scene until the new model is on screen,
// and only then frames the new one (finishSceneSwap).
// ---------------------------------------------------------------------------

import type { SceneEnvironment, SceneGraph } from '../types/scene';
import { PRESETS } from '../presets/presetScenes';
import { readUserPreset } from '../utils/userPresets';
import { saveStock, clampStock, type StockSize } from '../utils/stockSettings';
import type { ReliefCarveOptions } from '../utils/reliefCarveExporter';
import { cloneSceneGraph } from './sceneClone';
import { promoteJointedMeshGeomsDeep } from './meshGeomTransforms';
import { clearBreakage } from './breakage';
import { onNextPaint, getPhysicsWorkerClient } from './physicsEngine';
import { framingPatch } from './sceneFraming';
import { DEFAULT_ENVIRONMENT, environmentOf, takeEnvironment } from './sceneEnvironment';
import type { PhysicsState } from './useStore';
import type { SliceDeps } from './sliceDeps';

/** A preset as listed in PRESETS: a scene, and optionally a camera framing and an environment. */
interface Preset {
  name: string;
  emoji?: string;
  scene?: SceneGraph;
  camera?: { position: [number, number, number]; target: [number, number, number] };
  environment?: Partial<SceneEnvironment>;
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

export interface SceneSwapActions {
  loadPreset: (name: string) => void;
  /**
   * Replace the scene with something a generator built, and hand the exporter
   * the settings it should be cut with.
   */
  loadGeneratedScene: (scene: SceneGraph, carve: Partial<ReliefCarveOptions> | null) => void;
}

export function sceneSwapActions({ set, get }: SliceDeps): SceneSwapActions {
  return {
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
          // So do the notes and the chat, which the document holds, and the
          // environment, which the store's own fields do.
          const {
            thumbnail: _thumbnail, savedAt: _savedAt, noteCards: _notes, copilotMessages: _chat,
            ...savedGraph
          } = saved ?? {};
          const found: SceneGraph | null =
            saved && Array.isArray(saved.nodes) ? (savedGraph as unknown as SceneGraph)
            : nested && Array.isArray(nested.nodes) ? nested
            : null;
          // A preset with no nodes is a corrupt or half-written entry rather than
          // an empty scene; recompiling it would throw inside the MJCF builder.
          if (found) {
            const { graph: savedScene, environment } = takeEnvironment(found);
            promoteJointedMeshGeomsDeep(savedScene.nodes);
            // In the store now, as a built-in preset's is, not when the worker
            // has built it: everything that reads the graph straight after the
            // load (the boolean compile, the MCP reply, the note card) read the
            // scene being left.
            set((state) => ({
              sceneGraph: savedScene,
              outgoingSceneGraph: state.outgoingSceneGraph ?? state.sceneGraph,
              // A preset saved before the environment was saved gets the default
              // world, not whatever the last scene was set to.
              ...(environment ?? DEFAULT_ENVIRONMENT),
            }));
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
      // The preset's world, and the default for anything it does not mention.
      // Gravity, air and floor friction used to carry over from the last scene.
      set(environmentOf(preset.environment));
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
        ...DEFAULT_ENVIRONMENT,
      }));
      // A generated board is sized from the stock it will be cut from, which
      // is usually a good deal smaller than the default view assumes.
      finishSceneSwap(swap, get().recompile(scene, null, true, true), set,
        () => framingPatch(scene, null));
    },
  };
}
