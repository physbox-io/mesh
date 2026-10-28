// ---------------------------------------------------------------------------
// The physics worker, as the store sees it
//
// MuJoCo runs in a worker. The store keeps plain-JS mirrors of its model and
// data (MUJOCO_SHIM, buildModelMirror, buildDataMirror), written in place on
// every frame, and decides when the worker is to be thrown away for a fresh
// one before its WASM heap runs out.
// ---------------------------------------------------------------------------

import type { ScriptStateMap } from '../utils/scriptState';
import * as THREE from 'three';
import type { DataMirror, ModelMirror } from '../types/sceneLayer';
import { PhysicsWorkerClient, type BuiltResult, type FrameSnapshot } from './physicsWorkerClient';
import { envelope } from '../utils/coSimLink';
import { applyShatterPieces } from './breakage';
import type { PhysicsState } from './useStore';
import { store } from './storeRef';

/** Name<->id lookup tables the worker builds; `${type}Rev` maps ids back to names. */
export type IdMaps = Record<string, Record<string, number> | Record<number, string> | undefined>;

/** The globals the viewport and the recompile debounce hang off `window`. */
export type PhysicsWindow = Window & {
  _physics_camera?: THREE.Camera;
  _recompileTimeoutId?: ReturnType<typeof setTimeout>;
  _recompileWake?: (() => void) | null;
  DISABLE_USEFRAME?: boolean;
  NO_SELECT?: boolean;
  compiledXML?: string;
};

// The live MuJoCo module/model/data now live inside a dedicated Worker (see
// src/workers/physicsWorker.ts) so that on unrecoverable WASM memory
// exhaustion the worker can be terminated and a fresh one spawned — a real
// memory reclaim, since a Worker is a separate JS realm, unlike reinstantiating
// a WASM module in place on the main thread (which doesn't reliably return
// abandoned linear memory to the OS). `mujoco`/`model`/`data` in the store are
// now plain-JS mirrors kept in sync via postMessage, not live WASM objects —
// this shim preserves the exact field names/shapes the rest of the app
// (DynamicGeom, PulleyRopesRenderer, MouseDragForceRenderer, getSyncedSceneGraph,
// etc.) already reads, so those call sites need no changes.
export const MUJOCO_SHIM = {
  mjtObj: {
    mjOBJ_BODY: { value: 'body' },
    mjOBJ_JOINT: { value: 'joint' },
    mjOBJ_GEOM: { value: 'geom' },
    mjOBJ_ACTUATOR: { value: 'actuator' },
  },
  mj_name2id: (model: ModelMirror | null | undefined, typeVal: string, name: string): number =>
    ((model?._idMaps as IdMaps | undefined)?.[typeVal] as Record<string, number> | undefined)?.[name] ?? -1,
  mj_id2name: (model: ModelMirror | null | undefined, typeVal: string, id: number): string | null =>
    ((model?._idMaps as IdMaps | undefined)?.[`${typeVal}Rev`] as Record<number, string> | undefined)?.[id] ?? null,
  // Nothing on the main thread should call these directly anymore — the worker
  // owns stepping/forward-kinematics. Kept as safe no-ops in case of a stray call.
  mj_step: () => {},
  mj_forward: () => {},
};

// The `!`s are the same assertion buildDataMirror already makes: a mirror is
// only ever built from a BUILT message that reported ok, and every one of these
// fields is present on such a message.
export const buildModelMirror = (built: BuiltResult): ModelMirror => ({
  nq: built.nq!, nv: built.nv!, nu: built.nu!, ngeom: built.ngeom!, nbody: built.nbody!,
  opt: { timestep: built.timestep },
  geom_size: built.geom_size!,
  geom_type: built.geom_type,
  geom_rgba: built.geom_rgba,
  body_mass: built.body_mass,
  body_inertia: built.body_inertia,
  body_ipos: built.body_ipos,
  body_iquat: built.body_iquat,
  body_dofnum: built.body_dofnum,
  body_parentid: built.body_parentid,
  jnt_qposadr: built.jnt_qposadr,
  jnt_dofadr: built.jnt_dofadr,
  _idMaps: built.idMaps,
});

// A stable object whose typed-array contents get mutated in place on every
// FRAME message (see getPhysicsWorkerClient below) rather than replaced —
// existing per-frame readers (DynamicGeom etc.) already fetch `data` via
// `useStore.getState().data` inside useFrame (not a reactive selector), so
// mutating in place keeps the exact same performance characteristics as the
// original live-WASM-view approach: no React re-render on every physics tick.
export const buildDataMirror = (built: BuiltResult | FrameSnapshot): DataMirror => ({
  time: built.time,
  qpos: built.qpos!, qvel: built.qvel!, ctrl: built.ctrl!,
  xfrc_applied: built.xfrc_applied!, qfrc_applied: built.qfrc_applied!,
  xpos: built.xpos!, xmat: built.xmat!, cvel: built.cvel!,
  geom_xpos: built.geom_xpos!, geom_xmat: built.geom_xmat!,
});

/*
 * Proactive recycling: WASM linear memory only ever grows within a worker's
 * lifetime, and the @mujoco/mujoco build has a hard 2^31-byte ceiling. Rather
 * than wait for a hard "enlarge memory" failure, swap in a fresh worker before
 * exhaustion is reached — the same terminate+respawn mechanism as the reactive
 * recovery path, just run preemptively.
 *
 * This used to fire on a build COUNT, every four builds, because doBuild leaked
 * a whole MjModel + MjData on every rebuild (its teardown called free(), which
 * embind does not expose, so it released nothing) and a count was a stand-in
 * for how much that had cost. Measured at ~13 MB a build on a scene of one box.
 *
 * doBuild now actually frees them, which makes the count both wrong and
 * expensive: a respawn reloads MuJoCo from scratch, and it is also what forces
 * the seeding dance below — every fifth edit used to land on a worker with no
 * previous model to carry the pose across. So the decision is made on the heap
 * the worker reports with each build, and a scene that is not growing never
 * pays for a respawn at all.
 *
 * The threshold leaves generous headroom under the 2 GiB ceiling: growth
 * between two builds can be large for a heavy mesh scene, and the reactive
 * bad_alloc/abort recovery below is the last resort rather than the plan.
 */
export const RECYCLE_HEAP_BYTES = 1_200_000_000;

/**
 * WASM linear memory reserved as of the last build the worker reported.
 *
 * The heap only ever grows within a worker's lifetime, so this is the figure the
 * proactive recycle should be deciding on.
 */
export let lastHeapBytes = 0;
export const setLastHeapBytes = (bytes: number) => { lastHeapBytes = bytes; };

// Every scripted body's api.state as of the latest frame; see onFrame and the
// recycles that seed from it (utils/scriptState.ts).
export let lastScriptState: ScriptStateMap | undefined;

/**
 * Run something on the next paint, or straight away if there will not be one.
 *
 * A finished build used to land inside a bare requestAnimationFrame, so the
 * compiled model and the scene it came from were only ever written to the store
 * once the browser painted. A hidden or backgrounded tab does not paint: every
 * major engine throttles rAF to nothing there. The build itself still ran, so
 * nothing looked broken — but `sceneGraph`, `isLoaded` and the model were never
 * committed, so the app sat with isLoaded:false and every MCP command that waits
 * for the scene to settle timed out. That is exactly what a tab driven by an
 * agent does: sit behind another window.
 *
 * rAF is still preferred when the page is visible, because landing a new model
 * mid-frame is what it is for. When the page is hidden it is a timer instead.
 */
export const onNextPaint = (fn: () => void) => {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    setTimeout(fn, 0);
    return;
  }
  if (typeof requestAnimationFrame !== 'function') {
    setTimeout(fn, 0);
    return;
  }
  // A tab can be hidden between the check above and the callback firing, so the
  // frame is also raced against a timer. Whichever arrives first wins; the other
  // is a no-op.
  let settled = false;
  const once = () => { if (!settled) { settled = true; fn(); } };
  requestAnimationFrame(once);
  setTimeout(once, 250);
};

/*
 * The graph a respawned worker must be given mid-play: the runtime one, with
 * shards and dents, when anything has broken - the same choice recompile()
 * makes. Rebuilding the saved graph instead put a shattered vase back together
 * and, since the shards change the state's length, dropped the seed and reset
 * the whole scene.
 */
export const liveModelGraph = (s: Pick<PhysicsState, 'sceneGraph' | 'shatteredBodies' | 'deformedGeoms'>) => {
  const broken = Object.keys(s.shatteredBodies).length > 0 || Object.keys(s.deformedGeoms).length > 0;
  return {
    graph: broken ? applyShatterPieces(s.sceneGraph, s.shatteredBodies, s.deformedGeoms) : s.sceneGraph,
    sleep: Object.keys(s.shatteredBodies).length > 0,
  };
};

let physicsWorkerClientSingleton: PhysicsWorkerClient | null = null;

export const recycleWorker = () => {
  physicsWorkerClientSingleton?.terminate();
  physicsWorkerClientSingleton = null;
  // A fresh worker is a fresh WASM realm, so the heap starts over too.
  lastHeapBytes = 0;
};

/*
 * Told about every physics frame. A frame moves bodies without touching the
 * store (the data mirror is written in place, above), so a viewport that only
 * draws on demand would otherwise miss one that arrives while the simulation
 * is stopped — a joint slider's SET_QPOS, say. See RenderOnChange in App.
 */
let physicsFrameListener: (() => void) | null = null;

export const setPhysicsFrameListener = (listener: (() => void) | null) => {
  physicsFrameListener = listener;
};

export const getPhysicsWorkerClient = (): PhysicsWorkerClient => {
  if (!physicsWorkerClientSingleton) {
    const client = new PhysicsWorkerClient();
    client.onFrame = (snap) => {
      // The heap moves while stepping too, not only across builds — see the
      // periodic recycle at the bottom of this file, which decides on it.
      if (snap.heapBytes) lastHeapBytes = snap.heapBytes;
      // Kept beside the qpos mirror, from the same frame, so a recycle seeds
      // the new worker's scripts from the moment its bodies are seeded from.
      lastScriptState = snap.scriptState;
      const data = store().getState().data;
      if (data) {
        data.time = snap.time;
        if (!snap.isShared && snap.qpos && snap.qvel && snap.ctrl && snap.xfrc_applied && snap.qfrc_applied && snap.xpos && snap.xmat && snap.cvel && snap.geom_xpos && snap.geom_xmat) {
          data.qpos.set(snap.qpos); data.qvel.set(snap.qvel); data.ctrl.set(snap.ctrl);
          data.xfrc_applied.set(snap.xfrc_applied); data.qfrc_applied.set(snap.qfrc_applied);
          data.xpos.set(snap.xpos); data.xmat.set(snap.xmat); data.cvel.set(snap.cvel);
          data.geom_xpos.set(snap.geom_xpos); data.geom_xmat.set(snap.geom_xmat);
        }
      }
      physicsFrameListener?.();
    };
    client.onBreak = (event) => {
      // Append rather than replace: several welds can go in the same step, and
      // a break is remembered here rather than in the worker because the worker
      // is respawned every fourth build and every twenty seconds of play.
      const prev = store().getState().brokenConstraints;
      if (prev.includes(event.key)) return;
      store().setState({
        brokenConstraints: [...prev, event.key],
        lastBreak: event,
      });
    };
    client.onImpact = (event) => {
      store().getState().handleImpact(event);
    };
    client.onError = (message, fatal, lastState) => {
      console.error('[PhysicsWorker]', message);
      if (fatal) {
        store().getState().recoverFromFatalWorkerError(message, lastState);
      } else {
        store().setState({ isPlaying: false, lastCompileError: message });
      }
    };
    physicsWorkerClientSingleton = client;
  }
  return physicsWorkerClientSingleton;
};

/**
 * Ends a link to Volt from this side: tells the Volt page, and stops answering it.
 * Volt's end stops its run when it hears.
 */
export const endVoltLink = () => {
  const link = store().getState().voltLink;
  if (!link) return;
  try {
    window.opener?.postMessage(envelope({ type: 'UNLINK' }), link.origin);
  } catch {
    // The Volt tab is gone; there is no one to tell.
  }
  store().setState({ voltLink: null });
  // Take off what Volt added to the joints; see setJointParams.
  void getPhysicsWorkerClient().stepFor(0, {}, []).catch(() => {});
};
