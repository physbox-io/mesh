// ---------------------------------------------------------------------------
// The store's simulation: compiling the scene graph to MJCF and building it
// in the physics worker, playing and resetting, and recovering from a worker
// that died or is about to run out of heap
// ---------------------------------------------------------------------------

import type { ScriptStateMap } from '../utils/scriptState';
import type { SceneGraph } from '../types/scene';
import type { DataMirror, ModelMirror } from '../types/sceneLayer';
import { compileToMJCF } from '../utils/mjcf';
import { PhysicsWorkerClient, type BuiltResult } from './physicsWorkerClient';
import { canShatter } from '../utils/breakThresholds';
import { prewarmFractureWorker } from '../utils/fractureWorkerClient';
import { useDialogs } from './dialogStore';
import { downloadSceneRescue, allowUnload } from '../utils/rescueScene';
import { refusedGraphs, keptGraphs } from './editGuard';
import { modelBuiltFrom, noteModelBuilt } from './modelProvenance';
import { documentCtrlValues } from '../workers/carryState';
import { clearBreakage, anyNode, applyShatterPieces } from './breakage';
import {
  type PhysicsWindow, MUJOCO_SHIM, buildModelMirror, buildDataMirror, RECYCLE_HEAP_BYTES,
  lastHeapBytes, setLastHeapBytes, lastScriptState, onNextPaint, liveModelGraph, recycleWorker,
  getPhysicsWorkerClient, endVoltLink,
} from './physicsEngine';
import type { PhysicsState } from './useStore';
import type { SliceDeps } from './sliceDeps';

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
export let recompilesInFlight = 0;

/** Callers waiting for every recompile in flight to land; see `whenBuildsLand`. */
let idleWaiters: (() => void)[] = [];

/**
 * Resolves once no recompile is in flight.
 *
 * A recompile that a newer one supersedes does not build; the newer one builds
 * the newer scene. Its caller used to get control back at once, and an MCP
 * command that read `lastCompileError` then read whatever the PREVIOUS build
 * had left there — so a scene that was about to build was reported with the
 * last one's error. A superseded call waits here instead, and returns only once
 * the build that covers its request has landed.
 */
const whenBuildsLand = (): Promise<void> => recompilesInFlight === 0
  ? Promise.resolve()
  : new Promise((resolve) => { idleWaiters.push(resolve); });

/** A reset that a superseded recompile was asked for; see recompile. */
let pendingForceReset = false;

let loggedSharedMode = false;

export interface SimulationActions {
  mujoco: typeof MUJOCO_SHIM | null;
  model: ModelMirror | null;
  data: DataMirror | null;
  recompileId: number;
  isPlaying: boolean;
  lastCompileError: string | null;
  // Actions
  togglePlay: () => void;
  resetSimulation: () => void;
  recompile: (overrideScene?: SceneGraph, overrideSelectedId?: string | null, forceReset?: boolean, keepPreset?: boolean, settle?: boolean, immediate?: boolean) => Promise<void>;
  recoverFromFatalWorkerError: (message: string, lastState?: { qpos: number[]; qvel: number[]; time: number; scriptState?: ScriptStateMap }) => Promise<void>;
  recycleWorkerSeamlessly: () => Promise<void>;
}

export function simulationActions({ set, get }: SliceDeps): SimulationActions {
  return {
    mujoco: null,

    model: null,

    data: null,

    recompileId: 0,

    isPlaying: false,

    lastCompileError: null,

    togglePlay: () => set((state) => {
      // Playing hands the clock back from Volt: the two cannot both drive it.
      if (state.voltLink) endVoltLink();
      const isPlaying = !state.isPlaying;
      getPhysicsWorkerClient().setPlaying(isPlaying);
      // Something in this scene can break: have the cutter loaded before it does.
      if (isPlaying && anyNode(state.sceneGraph.nodes, canShatter)) prewarmFractureWorker();
      return { isPlaying };
    }),

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
      const done = () => {
        if (!counted) return;
        counted = false;
        recompilesInFlight = Math.max(0, recompilesInFlight - 1);
        if (recompilesInFlight === 0 && idleWaiters.length) {
          const waiters = idleWaiters;
          idleWaiters = [];
          waiters.forEach((w) => w());
        }
      };
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
        let wake: (() => void) | null = null;
        await new Promise<void>(resolve => {
          wake = resolve;
          win._recompileWake = resolve;
          win._recompileTimeoutId = setTimeout(resolve, settle ? 180 : 50);
        });
        // Only our own handle. A call that was woken by a newer one wakes up
        // after that one has set its handle, and clearing it unconditionally
        // left the newer call with no way to be woken: the next edit cleared
        // its timer, found no handle, and it hung for good - never building,
        // never returning, and never giving back its count, so every scene
        // summary after a burst of edits said a compile was in flight.
        if (win._recompileWake === wake) win._recompileWake = null;
        if (token !== recompileToken) {
          // Handed on rather than dropped: the call that overtook this one builds
          // the newer scene, and it must still start that scene from rest if this
          // one was asked to.
          if (forceReset) pendingForceReset = true;
          done();
          await whenBuildsLand();
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
        // The error clears NOW, not with the rest on the next paint. The await
        // on recompile() resolves before that paint, and every MCP command
        // reads lastCompileError straight after it: deferred, a build that
        // worked was reported with the previous build's error.
        set({ lastCompileError: null });
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
          // The document this model describes: for a build of the runtime
          // overlay (shards, dents), the graph it was laid over.
          noteModelBuilt(isRuntimeBuild ? graphAtBuildStart : sceneGraph);
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
              // The set speeds that ctrl was running under; see applyEditedCtrl.
              docCtrl: documentCtrlValues(modelBuiltFrom().graph?.nodes),
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
                  // The set speeds that ctrl was running under; see applyEditedCtrl.
                  docCtrl: documentCtrlValues(modelBuiltFrom().graph?.nodes),
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
        if (token !== recompileToken) { done(); await whenBuildsLand(); return; }
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
      const docGraph = get().sceneGraph;
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
        noteModelBuilt(docGraph);
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
      const docGraph = get().sceneGraph;
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
        // The set speeds that ctrl was running under; see applyEditedCtrl.
        docCtrl: documentCtrlValues(modelBuiltFrom().graph?.nodes),
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
        noteModelBuilt(docGraph);
        if (get().isPlaying) client.setPlaying(true);
      } catch (e) {
        console.error('Seamless proactive worker recycle failed:', e);
      }
    },
  };
}
