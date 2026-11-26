// ---------------------------------------------------------------------------
// The store's undo history
//
// An edit snapshots the scene before it changes it (recordInteraction for a
// drag or a slider, coalesced; prepareForDiscreteChange for a click), and the
// snapshot is pushed once the scene has actually moved.
// ---------------------------------------------------------------------------

import type { BackgroundId, SceneGraph } from '../types/scene';
import { sameValue, cloneSceneGraph, findNode } from './sceneClone';
import { markUserEdit, withCastPrepBypass } from './editGuard';
import { clearBreakage } from './breakage';
import { rebuildBooleansAfterRestore } from './geomEdits';
import { peekPhysicsWorkerClient, silenceAllLiveAcoustics } from './physicsEngine';
import { recompilesInFlight } from './simulationActions';
import type { SliceDeps } from './sliceDeps';

/*
 * The history debounce timer. Module state, not store state: nothing renders
 * it, and every write of it to the store notified every subscriber in the app
 * on every tick of every slider drag.
 */
let historyDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/** How many steps back Ctrl+Z can go. */
const UNDO_LIMIT = 100;

export interface UndoRedoState {
  sceneGraph: SceneGraph;
  gravityZ: number;
  windX: number;
  windY: number;
  windGusting: boolean;
  density: number;
  floorFriction: number;
  floorBounce: number;
  background: BackgroundId;
  waterLevel: number | null;
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

export interface HistoryActions {
  // History State
  undoStack: UndoRedoState[];
  redoStack: UndoRedoState[];
  tempUndoState: UndoRedoState | null;
  lastInteractionType: string | null;
  recordInteraction: (type: string) => void;
  flushPendingUndo: () => void;
  prepareForDiscreteChange: () => void;
  // History Actions
  undo: () => void;
  redo: () => void;
}

export function historyActions({ set, get }: SliceDeps): HistoryActions {
  return {
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
        const s = get();
        const snapshot: UndoRedoState = {
          sceneGraph: cloneSceneGraph(s.sceneGraph),
          gravityZ: s.gravityZ,
          windX: s.windX,
          windY: s.windY,
          windGusting: s.windGusting,
          density: s.density,
          floorFriction: s.floorFriction,
          floorBounce: s.floorBounce,
          background: s.background,
          waterLevel: s.waterLevel,
          selectedNodeId: s.selectedNodeId,
          latticeNodeId: s.latticeNodeId,
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
          tempUndoState.windGusting !== current.windGusting ||
          tempUndoState.density !== current.density ||
          tempUndoState.floorFriction !== current.floorFriction ||
          tempUndoState.floorBounce !== current.floorBounce ||
          tempUndoState.background !== current.background ||
          tempUndoState.waterLevel !== current.waterLevel ||
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
      const { sceneGraph, gravityZ, windX, windY, windGusting, density, floorFriction, floorBounce, background, waterLevel, selectedNodeId, latticeNodeId } = get();
      const snapshot: UndoRedoState = {
        sceneGraph: cloneSceneGraph(sceneGraph),
        gravityZ,
        windX,
        windY,
        windGusting,
        density,
        floorFriction,
        floorBounce,
        background,
        waterLevel,
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
        const { undoStack, redoStack, sceneGraph, gravityZ, windX, windY, windGusting, density, floorFriction, floorBounce, background, waterLevel, selectedNodeId, latticeNodeId } = get();
        if (undoStack.length === 0) return;

        const previousState = undoStack[undoStack.length - 1];
        const newUndoStack = undoStack.slice(0, -1);

        const currentStateSnapshot: UndoRedoState = {
          sceneGraph: cloneSceneGraph(sceneGraph),
          gravityZ,
          windX,
          windY,
          windGusting,
          density,
          floorFriction,
          floorBounce,
          background,
          waterLevel,
          selectedNodeId,
          latticeNodeId,
        };

        silenceAllLiveAcoustics();
        peekPhysicsWorkerClient()?.setPlaying?.(false);
        peekPhysicsWorkerClient()?.setDrag?.(null, null);
        clearBreakage(set);

        set({
          sceneGraph: previousState.sceneGraph,
          gravityZ: previousState.gravityZ,
          windX: previousState.windX,
          windY: previousState.windY,
          windGusting: previousState.windGusting,
          density: previousState.density,
          floorFriction: previousState.floorFriction,
          floorBounce: previousState.floorBounce,
          background: previousState.background,
          waterLevel: previousState.waterLevel,
          selectedNodeId: previousState.selectedNodeId,
          extraSelectedIds: [],
          activeGeomIndex: 0,
          geomFocused: false,
          draggedNodeId: null,
          dragTarget: null,
          edgeRoundSession: null,
          gestureStatus: null,
          // The tools follow the document back. A body that has just stopped
          // existing cannot be the one being modelled, and the editor holding its
          // own copy of the cage is exactly how a ghost gets committed back in.
          ...latticeAfterUndo(previousState),
          undoStack: newUndoStack,
          redoStack: [...redoStack, currentStateSnapshot],
          isPlaying: false,
        });

        get().recompile(previousState.sceneGraph, previousState.selectedNodeId, true, true);
        rebuildBooleansAfterRestore();
      });
    },

    redo: () => {
      if (get().castPrepBusy) return;
      withCastPrepBypass(() => {
        get().flushPendingUndo();
        const { undoStack, redoStack, sceneGraph, gravityZ, windX, windY, windGusting, density, floorFriction, floorBounce, background, waterLevel, selectedNodeId, latticeNodeId } = get();
        if (redoStack.length === 0) return;

        const nextState = redoStack[redoStack.length - 1];
        const newRedoStack = redoStack.slice(0, -1);

        const currentStateSnapshot: UndoRedoState = {
          sceneGraph: cloneSceneGraph(sceneGraph),
          gravityZ,
          windX,
          windY,
          windGusting,
          density,
          floorFriction,
          floorBounce,
          background,
          waterLevel,
          selectedNodeId,
          latticeNodeId,
        };

        silenceAllLiveAcoustics();
        peekPhysicsWorkerClient()?.setPlaying?.(false);
        peekPhysicsWorkerClient()?.setDrag?.(null, null);
        clearBreakage(set);

        set({
          sceneGraph: nextState.sceneGraph,
          gravityZ: nextState.gravityZ,
          windX: nextState.windX,
          windY: nextState.windY,
          windGusting: nextState.windGusting,
          density: nextState.density,
          floorFriction: nextState.floorFriction,
          floorBounce: nextState.floorBounce,
          background: nextState.background,
          waterLevel: nextState.waterLevel,
          selectedNodeId: nextState.selectedNodeId,
          extraSelectedIds: [],
          activeGeomIndex: 0,
          geomFocused: false,
          draggedNodeId: null,
          dragTarget: null,
          edgeRoundSession: null,
          gestureStatus: null,
          ...latticeAfterUndo(nextState),
          undoStack: [...undoStack, currentStateSnapshot],
          redoStack: newRedoStack,
          isPlaying: false,
        });

        get().recompile(nextState.sceneGraph, nextState.selectedNodeId, true, true);
        rebuildBooleansAfterRestore();
      });
    },
  };
}
