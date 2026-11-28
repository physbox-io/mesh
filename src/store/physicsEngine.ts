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
import type { ClothStateSnapshot } from '../workers/physicsWorkerProtocol';
import { PhysicsWorkerClient, type BuiltResult, type FrameSnapshot } from './physicsWorkerClient';
import { envelope } from '../utils/coSimLink';
import { applyShatterPieces } from './breakage';
import type { PhysicsState } from './useStore';
import { store } from './storeRef';
import { noteWorkerFrame } from './modelProvenance';
import { useSoundStore } from './soundStore';
import {
  chokeBodyVoice,
  estimateBodyModes,
  getSharedOutputBusForContext,
  inferAcousticMaterial,
  peekSharedAudioContext,
  playAeroSnapPulse,
  playModalImpact,
  resolveTwoBodyImpact,
  silenceAeroVoices,
  silenceBowedVoices,
  silenceFrictionVoices,
  silenceModalVoices,
  silenceWindVoices,
  triggerSympatheticStringPluck,
  updateLiveAeroVoices,
  updateLiveBowedVoices,
  updateLiveFrictionVoices,
  updateLiveWindVoices,
  type BodyModalProfile,
  type ModalVoice,
} from '../utils/modalAudio';
import { solveAeroAcousticVoice, solveClothSnapPulse } from '../utils/aeroAcoustics';
import { solveContactFrictionVoice } from '../utils/contactFrictionAcoustics';
import { resolveExternalTubeResonator } from '../utils/resonatorAcoustics';
import { simulate3DVibroAcousticIR, type VibroAcousticIRResult } from '../utils/solidAcoustics3D';
import {
  resolveBodyWorldPosMuJoCo,
  resolveSpatialAcousticParams,
  type ModelIdMapsLike,
  type SpatialAcousticParams,
} from '../utils/spatialAcoustics';
import {
  evaluateTautString,
  resolveStringBetaFromPoint,
  solveBowedStringVoice,
  type StringPluckImpactContext,
} from '../utils/stringAcoustics';
import {
  applyAudioDampingEvents,
  updateSympatheticBowedVoices,
  updateVoiceSpatialPan,
  updateVoiceTremolo,
} from '../utils/voiceSympathyPool';
import { extractBoreWaveguide } from '../utils/windAcoustics';
import type { SceneGeom, SceneNode } from '../types/scene';

type GlobalWithAuditionHold = typeof globalThis & {
  __physboxAcousticAuditionUntilMs?: number;
};

/**
 * Holds Inspector Blow / Bow preview auditions open for `ms` milliseconds so live
 * `syncLiveWindAudio` / `onBowedStrings` frames do not overwrite or silence them.
 */
export function setAcousticAuditionHold(ms: number): void {
  const dur = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  (globalThis as GlobalWithAuditionHold).__physboxAcousticAuditionUntilMs =
    dur > 0 ? performance.now() + dur : 0;
}

export function isAcousticAuditionActive(): boolean {
  return ((globalThis as GlobalWithAuditionHold).__physboxAcousticAuditionUntilMs ?? 0) > performance.now();
}

function collectWeldedSolids(node: SceneNode, isRoot = true, out: SceneGeom[] = []): SceneGeom[] {
  if (!isRoot && ((node.joints?.length ?? 0) > 0 || node.acousticString || node.simulation)) {
    return out;
  }
  for (const g of node.geoms ?? []) {
    if (!g.csgDerived && g.csg !== 'difference' && g.role !== 'visual' && g.type !== 'plane') {
      out.push(g);
    }
  }
  for (const ch of node.children ?? []) {
    collectWeldedSolids(ch, false, out);
  }
  return out;
}

const findNode = (nodes: SceneNode[], id: string): SceneNode | null => {
  for (const n of nodes || []) {
    if (n.id === id || n.name === id) return n;
    const sub = findNode(n.children || [], id);
    if (sub) return sub;
  }
  return null;
};

const modalCache = new WeakMap<
  SceneNode,
  { geomsRef: SceneNode['geoms']; sculptVer: number | undefined; profile: BodyModalProfile }
>();
const windIrCache = new WeakMap<
  SceneNode,
  { geomsRef: SceneNode['geoms']; deformMat: string | undefined; sculptVer: number | undefined; result: VibroAcousticIRResult | null }
>();

function getCachedWindIr(wn: SceneNode): VibroAcousticIRResult | null {
  const hit = windIrCache.get(wn);
  if (
    hit &&
    hit.geomsRef === wn.geoms &&
    hit.deformMat === wn.deformMaterial &&
    hit.sculptVer === wn.sculptVersion
  ) {
    return hit.result;
  }
  const result = simulate3DVibroAcousticIR(wn, inferAcousticMaterial(wn)) ?? null;
  windIrCache.set(wn, {
    geomsRef: wn.geoms,
    deformMat: wn.deformMaterial,
    sculptVer: wn.sculptVersion,
    result,
  });
  return result;
}

const cachedModesFor = (
  node: SceneNode,
  sceneNodes?: SceneNode[],
  pluckCtx?: StringPluckImpactContext,
): BodyModalProfile => {
  if (node.acousticString) {
    const strEval = evaluateTautString(node, sceneNodes, pluckCtx);
    if (strEval) {
      return { ...strEval.profile, nodeId: node.id };
    }
  }
  if (node.acousticMembrane) {
    return estimateBodyModes(node, true, sceneNodes);
  }
  const hit = modalCache.get(node);
  if (hit && hit.geomsRef === node.geoms && hit.sculptVer === node.sculptVersion) {
    return hit.profile;
  }
  const profile = estimateBodyModes(node, true, sceneNodes);
  modalCache.set(node, { geomsRef: node.geoms, sculptVer: node.sculptVersion, profile });
  return profile;
};
import { garmentSettings } from '../utils/cloth/garments';
import { doneUp } from '../utils/cloth/fastening';

const SYNC_PREWARM_BUDGET_MS = 16;
const DEFERRED_PREWARM_SLICE_MS = 6;
let deferredPrewarmTimer: ReturnType<typeof setTimeout> | null = null;

function cancelDeferredPrewarm(): void {
  if (deferredPrewarmTimer !== null) {
    clearTimeout(deferredPrewarmTimer);
    deferredPrewarmTimer = null;
  }
}

/**
 * Pre-computes and caches 3D Vibro-Acoustic FIRs (`simulate3DVibroAcousticIR`)
 * within a strict 16 ms synchronous frame budget (prioritizing musical instruments
 * first and deferring generic rigid bodies across 6 ms idle slices so Play and
 * mid-play Sound-ON never stall the main thread).
 */
export function prewarmSceneAcousticIRs(nodes: SceneNode[]): void {
  cancelDeferredPrewarm();
  if (!useSoundStore.getState().soundEnabled || !nodes?.length) return;
  let hasDynamicOrInstrument = false;
  const checkActive = (list: SceneNode[]) => {
    for (const n of list) {
      if (
        (n.joints?.length ?? 0) > 0 ||
        n.acousticString ||
        n.acousticMembrane ||
        n.windInstrument ||
        n.resonatorTube ||
        n.nonlinearPlate
      ) {
        hasDynamicOrInstrument = true;
        return;
      }
      if (n.children?.length) checkActive(n.children);
      if (hasDynamicOrInstrument) return;
    }
  };
  checkActive(nodes);
  if (!hasDynamicOrInstrument) return;

  const priorityQueue: (() => void)[] = [];
  const secondaryQueue: (() => void)[] = [];

  const collectTasks = (list: SceneNode[]) => {
    for (const n of list) {
      if (n.acousticString) {
        priorityQueue.push(() => {
          evaluateTautString(n, nodes);
        });
      } else if (n.acousticMembrane) {
        priorityQueue.push(() => {
          cachedModesFor(n, nodes);
        });
      } else if (n.windInstrument) {
        if ((n.windInstrument.breathKPa ?? 0) > 0.01 || n.script) {
          priorityQueue.push(() => {
            getCachedWindIr(n);
          });
        } else {
          secondaryQueue.push(() => {
            getCachedWindIr(n);
          });
        }
      } else if (!isWindSubtreeOrNonColliding(n, nodes)) {
        const hasCollidableSolid = collectWeldedSolids(n).some(
          (g) => !(g.contype === 0 && g.conaffinity === 0),
        );
        if (hasCollidableSolid) {
          const isTunedOrPlate = typeof n.tunedPitchHz === 'number' || !!n.nonlinearPlate || !!n.resonatorTube;
          (isTunedOrPlate ? priorityQueue : secondaryQueue).push(() => {
            cachedModesFor(n, nodes);
          });
        }
      }
      if (n.children?.length) collectTasks(n.children);
    }
  };
  collectTasks(nodes);

  const allTasks = [...priorityQueue, ...secondaryQueue];
  const tStart = performance.now();
  let cursor = 0;
  while (cursor < allTasks.length) {
    allTasks[cursor++]();
    if (cursor < allTasks.length && performance.now() - tStart >= SYNC_PREWARM_BUDGET_MS) {
      break;
    }
  }

  if (cursor < allTasks.length) {
    const drainSlice = () => {
      deferredPrewarmTimer = null;
      if (!useSoundStore.getState().soundEnabled) return;
      const sliceStart = performance.now();
      while (cursor < allTasks.length && performance.now() - sliceStart < DEFERRED_PREWARM_SLICE_MS) {
        allTasks[cursor++]();
      }
      if (cursor < allTasks.length) {
        deferredPrewarmTimer = setTimeout(drainSlice, 16);
      }
    };
    deferredPrewarmTimer = setTimeout(drainSlice, 16);
  }
}

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
  geom_bodyid: built.geom_bodyid,
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
  flexes: built.flexes,
  clothStitches: built.clothStitches,
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
  flexvert_xpos: built.flexvert_xpos,
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
// Latest serialisable ClothSim state snapshot from the worker, carried across
// proactive WASM-heap recycles so cloth does not reset or re-settle mid-play.
export let lastClothState: ClothStateSnapshot | undefined;
export const setLastClothState = (state: ClothStateSnapshot | undefined) => { lastClothState = state; };

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
let lastWindAudioSyncMs = 0;
let lastTremoloSyncMs = 0;
let hadActiveWindVoices = false;
let hadActiveFrictionVoices = false;
let hadActiveBowedSympathy = false;

interface ActiveTremoloBarState {
  nodeId: string;
  profile: BodyModalProfile;
  baseVoices: ModalVoice[];
  expiresAtMs: number;
}
const activeTremoloBars = new Map<string, ActiveTremoloBarState>();

/** Silences all live modal, wind, bowed, aero, and contact-friction voices immediately. */
export function silenceAllLiveAcoustics(): void {
  cancelDeferredPrewarm();
  hadActiveWindVoices = false;
  hadActiveFrictionVoices = false;
  hadActiveBowedSympathy = false;
  activeTremoloBars.clear();
  silenceModalVoices();
  silenceWindVoices();
  silenceBowedVoices();
  silenceAeroVoices();
  silenceFrictionVoices();
}

/**
 * Before a planned recycle: the cloth's state now, from the worker about to
 * go (frames carry one only about once a second). Kept as it was if the
 * worker does not answer.
 */
export const refreshClothStateForRecycle = async () => {
  const c = physicsWorkerClientSingleton;
  if (!c) return;
  const s = await c.getClothState().catch(() => undefined);
  if (s) lastClothState = s;
};

export const recycleWorker = () => {
  silenceAllLiveAcoustics();
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
function resolveNodeSpatial(
  nodeId: string,
  node?: SceneNode | null,
  localPoint?: [number, number, number] | null,
  explicitWorldPos?: [number, number, number] | null,
): SpatialAcousticParams {
  const s = store().getState();
  const camera =
    typeof window !== 'undefined' ? ((window as unknown as PhysicsWindow)._physics_camera ?? null) : null;
  const mjPos =
    explicitWorldPos ??
    resolveBodyWorldPosMuJoCo(
      nodeId,
      s.model as unknown as ModelIdMapsLike | null,
      s.data,
      localPoint ?? null,
      node?.pos ?? null,
    );
  return resolveSpatialAcousticParams(mjPos, camera);
}

function isWindSubtreeOrNonColliding(node: SceneNode, roots: SceneNode[]): boolean {
  if (node.windInstrument) return true;
  const checkWindAncestor = (list: SceneNode[], insideWind: boolean): boolean => {
    for (const n of list) {
      const nextWind = insideWind || !!n.windInstrument;
      if (n.id === node.id) return nextWind;
      if (n.children?.length && checkWindAncestor(n.children, nextWind)) return true;
    }
    return false;
  };
  if (checkWindAncestor(roots, false)) return true;

  // Non-colliding mechanism bodies (e.g. contype=0 music drums, cams) only hit internal joint stops;
  // include jointless welded child bodies (e.g. `cradle_bob_body_*` under `cradle_*` in Newton's Cradle!).
  if (typeof node.tunedPitchHz !== 'number' && !node.acousticString && !node.acousticMembrane) {
    const solids = collectWeldedSolids(node);
    if (solids.length > 0 && solids.every((g) => g.contype === 0 && g.conaffinity === 0)) {
      return true;
    }
  }
  return false;
}

function collectWindNodes(nodes: SceneNode[], out: SceneNode[] = []): SceneNode[] {
  for (const n of nodes) {
    if (n.windInstrument) out.push(n);
    if (n.children?.length) collectWindNodes(n.children, out);
  }
  return out;
}

function syncLiveWindAudio() {
  if (isAcousticAuditionActive()) return;
  if (!useSoundStore.getState().soundEnabled) {
    if (hadActiveWindVoices) {
      hadActiveWindVoices = false;
      silenceWindVoices();
    }
    return;
  }
  const s = store().getState();
  if (!s.isPlaying || !s.model || !s.data) {
    if (hadActiveWindVoices) {
      hadActiveWindVoices = false;
      silenceWindVoices();
    }
    return;
  }

  const now = performance.now();
  if (now - lastWindAudioSyncMs < 12) return;
  lastWindAudioSyncMs = now;

  const windNodes = collectWindNodes(s.sceneGraph.nodes);
  if (windNodes.length === 0) {
    if (hadActiveWindVoices) {
      hadActiveWindVoices = false;
      silenceWindVoices();
    }
    return;
  }

  const jMap = ((s.model._idMaps as IdMaps | undefined)?.joint as Record<string, number> | undefined) ?? {};
  const qpos = s.data.qpos;
  const qvel = s.data.qvel;
  const jposAddr = s.model.jnt_qposadr;
  const jdofAddr = s.model.jnt_dofadr;

  const readJointPos = (name: string): number => {
    const jid = jMap[name];
    if (jid === undefined || !jposAddr) return 0;
    return qpos[jposAddr[jid]] ?? 0;
  };
  const readJointVel = (name: string): number => {
    const jid = jMap[name];
    if (jid === undefined || !jdofAddr) return 0;
    return qvel[jdofAddr[jid]] ?? 0;
  };

  let jointPositions: Record<string, number> | null = null;
  const ensureJointPositions = (): Record<string, number> => {
    if (!jointPositions) {
      jointPositions = {};
      for (const jName of Object.keys(jMap)) {
        jointPositions[jName] = readJointPos(jName);
      }
    }
    return jointPositions;
  };

  const envWindSpeed = Math.hypot(s.windX || 0, s.windY || 0);
  const payloads = [];
  for (const wn of windNodes) {
    const spec = wn.windInstrument!;
    const scriptSt = lastScriptState?.[wn.id] as Record<string, unknown> | undefined;
    // Base breath from spec + ambient wind, overridden smoothly if script sets `api.state.breathKPa` or child bellows
    let breathKPa =
      typeof scriptSt?.breathKPa === 'number' && Number.isFinite(scriptSt.breathKPa)
        ? scriptSt.breathKPa
        : (spec.breathKPa ?? 0) + envWindSpeed * 0.45;
    let embouchureHz =
      typeof scriptSt?.embouchureHz === 'number' && Number.isFinite(scriptSt.embouchureHz)
        ? scriptSt.embouchureHz
        : spec.embouchureHz;
    for (const ch of wn.children ?? []) {
      for (const cj of ch.joints ?? []) {
        if (cj.name.endsWith('_bellows')) {
          const vStroke = readJointVel(cj.name);
          breathKPa = Math.max(0, vStroke * 52);
        } else if (cj.name.endsWith('_embouchure')) {
          const qDial = readJointPos(cj.name);
          embouchureHz = spec.embouchureHz * Math.pow(2, qDial);
        }
      }
    }

    // Skip expensive TMM bore extraction & 3D FDTD IR lookup on idle wind instruments!
    if (!(breathKPa > 0.01)) continue;

    const bore = extractBoreWaveguide(wn, ensureJointPositions());
    const windIr = getCachedWindIr(wn);
    const spatial = resolveNodeSpatial(wn.id, wn);
    payloads.push({
      id: wn.id,
      exciter: spec.exciter,
      breathKPa: Math.max(0, Math.min(8, breathKPa)),
      embouchureHz: Math.max(16, Math.min(2200, embouchureHz)),
      bodyIr: windIr?.ir ?? null,
      bodyIrSig: windIr?.signature ?? '',
      boreShape: bore?.boreShape,
      resonantModesHz: bore?.resonantModesHz,
      modeImpedancePeaks: bore?.modeImpedancePeaks,
      impedanceGrid: bore?.impedanceGrid,
      muteFactor: bore?.muteFactor,
      breachFactor: bore?.breachFactor,
      mouthRadiusM: bore?.mouthRadiusM,
      bellRadiusM: bore?.bellRadiusM,
      cellCount: bore?.cellCount ?? 32,
      exactCells: bore?.exactCells,
      junctionK: bore?.junctionK ?? [],
      bellCutoffHz: bore?.bellCutoffHz ?? 1500,
      shunts: (bore?.toneholes ?? [])
        .filter((th) => th.openAmount > 0.05)
        .map((th) => ({ cell: th.cellIndex, coeff: th.shuntCoeff * th.openAmount })),
      pan: spatial.pan,
      distanceGain: spatial.distanceGain,
    });
  }

  if (payloads.length === 0) {
    if (hadActiveWindVoices) {
      hadActiveWindVoices = false;
      updateLiveWindVoices([]);
    }
    return;
  }

  hadActiveWindVoices = payloads.some((p) => p.breathKPa > 0.05);
  updateLiveWindVoices(payloads);
}

/** Updates rotating vibraphone fan tremolo & spatial stereo pan on actively ringing resonator bars. */
function syncLiveTremoloVoices() {
  if (activeTremoloBars.size === 0 || !useSoundStore.getState().soundEnabled) return;
  const now = performance.now();
  if (now - lastTremoloSyncMs < 24) return;
  lastTremoloSyncMs = now;

  const s = store().getState();
  if (!s.isPlaying || !s.model || !s.data) return;
  const nodes = liveModelGraph(s).graph.nodes;
  const ctx = peekSharedAudioContext();

  for (const [nodeId, entry] of Array.from(activeTremoloBars.entries())) {
    if (now >= entry.expiresAtMs) {
      activeTremoloBars.delete(nodeId);
      continue;
    }
    const barNode = findNode(nodes, nodeId);
    if (!barNode) {
      activeTremoloBars.delete(nodeId);
      continue;
    }
    const res = resolveExternalTubeResonator(barNode, entry.profile, entry.baseVoices, nodes, {
      model: s.model,
      data: s.data,
    });
    if (res) {
      updateVoiceTremolo(ctx, nodeId, {
        rateHz: res.tremolo.tremoloHz,
        depth: res.tremolo.active ? res.tremolo.amDepth : 0,
        formantHz: res.tube.fundamentalHz,
        occlusionGain: res.tremolo.active
          ? res.tremolo.meanOpenFactor
          : res.tremolo.instantaneousOpenFactor,
      });
    }
    const spatial = resolveNodeSpatial(nodeId, barNode);
    updateVoiceSpatialPan(ctx, nodeId, spatial.pan, spatial.distanceGain);
  }
}

let physicsFrameListener: (() => void) | null = null;

export const setPhysicsFrameListener = (listener: (() => void) | null) => {
  physicsFrameListener = listener;
};

export const peekPhysicsWorkerClient = (): PhysicsWorkerClient | null => physicsWorkerClientSingleton;

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
      // Frames carry it only about once a second: keep the last until then.
      if (snap.clothState) lastClothState = snap.clothState;
      noteWorkerFrame(snap.time);
      const data = store().getState().data;
      if (data) {
        data.time = snap.time;
        if (!snap.isShared && snap.qpos && snap.qvel && snap.ctrl && snap.xfrc_applied && snap.qfrc_applied && snap.xpos && snap.xmat && snap.cvel && snap.geom_xpos && snap.geom_xmat) {
          data.qpos.set(snap.qpos); data.qvel.set(snap.qvel); data.ctrl.set(snap.ctrl);
          data.xfrc_applied.set(snap.xfrc_applied); data.qfrc_applied.set(snap.qfrc_applied);
          data.xpos.set(snap.xpos); data.xmat.set(snap.xmat); data.cvel.set(snap.cvel);
          data.geom_xpos.set(snap.geom_xpos); data.geom_xmat.set(snap.geom_xmat);
          if (snap.flexvert_xpos && data.flexvert_xpos?.length === snap.flexvert_xpos.length) data.flexvert_xpos.set(snap.flexvert_xpos);
        }
        data.clothTies = snap.clothTies;
        data.clothZips = snap.clothZips;
      }
      physicsFrameListener?.();
      syncLiveWindAudio();
      syncLiveTremoloVoices();
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
      if (useSoundStore.getState().soundEnabled) {
        const s = store().getState();
        const nodes = liveModelGraph(s).graph.nodes;
        const node = findNode(nodes, event.nodeId);
        if (node) {
          const profile = cachedModesFor(node, nodes);
          const spatial = resolveNodeSpatial(node.id, node);
          const impulseNs = Math.max(0.2, event.forceN * 0.015);
          const twoBody = resolveTwoBodyImpact(profile, node, {
            impulseNs,
            sceneNodes: nodes,
            liveKinematics: { model: s.model, data: s.data },
          });
          playModalImpact(profile, impulseNs, false, {
            ...twoBody,
            nodeId: node.id,
            pan: spatial.pan,
            distanceGain: spatial.distanceGain,
          });
        }
      }
    };
    client.onImpact = (event) => {
      store().getState().handleImpact(event);
    };
    client.onAudioImpacts = (events) => {
      if (!useSoundStore.getState().soundEnabled) return;
      const s = store().getState();
      const nodes = liveModelGraph(s).graph.nodes;
      const pluckedBatchIds = new Set<string>();
      for (const ev of events) {
        if (ev.impulseNs >= 0.0015) pluckedBatchIds.add(ev.nodeId);
      }

      const isDedicatedResonator = (n: SceneNode | null | undefined): boolean =>
        !!n &&
        (typeof n.tunedPitchHz === 'number' ||
          !!n.acousticString ||
          !!n.acousticMembrane ||
          !!n.nonlinearPlate ||
          !!n.resonatorTube);

      for (const ev of events) {
        if (ev.impulseNs < 0.0015) continue;
        const node = findNode(nodes, ev.nodeId);
        if (!node || isWindSubtreeOrNonColliding(node, nodes)) continue;
        const strikerNode =
          ev.otherNodeId && ev.otherNodeId !== 'world' ? findNode(nodes, ev.otherNodeId) : null;
        // Suppress redundant beater/mallet stick self-thuds when striking a dedicated musical resonator
        if (isDedicatedResonator(strikerNode) && !isDedicatedResonator(node)) continue;
        const isPluck = !!node.acousticString;
        const profile = cachedModesFor(
          node,
          nodes,
          isPluck
            ? {
                localPoint: ev.localPoint,
                strikerNode,
                strikerGeomName: ev.otherGeomName,
                impulseNs: ev.impulseNs,
              }
            : undefined,
        );
        const twoBody = resolveTwoBodyImpact(profile, node, {
          impulseNs: ev.impulseNs,
          strikerNode,
          selfGeomName: ev.selfGeomName,
          strikerGeomName: ev.otherGeomName,
          localPoint: ev.localPoint,
          isPluck,
          sceneNodes: nodes,
          liveKinematics: { model: s.model, data: s.data },
        });
        const spatial = resolveNodeSpatial(node.id, node, ev.localPoint);
        playModalImpact(profile, ev.impulseNs, isPluck, {
          ...twoBody,
          nodeId: node.id,
          pan: spatial.pan,
          distanceGain: spatial.distanceGain,
          simTime: s.data?.time,
        });

        // Starter #3: Weinreich bridge-admittance sympathetic string excitation across sibling strings!
        if (isPluck) {
          const ctx = peekSharedAudioContext();
          const bus = getSharedOutputBusForContext(ctx);
          if (ctx && bus) {
            triggerSympatheticStringPluck(ctx, bus, node, nodes, ev.impulseNs, {
              sourcePitchHz: profile.fundamentalHz,
              excludedNodeIds: pluckedBatchIds,
              pan: spatial.pan,
              distanceGain: spatial.distanceGain,
            });
          }
        }

        // Starter #5: Track ringing vibraphone bars over motor-driven tremolo resonator tubes
        if (twoBody.resonator?.tremolo.vaneJointName) {
          activeTremoloBars.set(node.id, {
            nodeId: node.id,
            profile,
            baseVoices: profile.modes,
            expiresAtMs: performance.now() + 3800,
          });
        }
      }
    };
    client.onBowedStrings = (contacts) => {
      if (isAcousticAuditionActive()) return;
      if (!useSoundStore.getState().soundEnabled || !store().getState().isPlaying) {
        silenceBowedVoices();
        return;
      }
      if (contacts.length === 0) {
        updateLiveBowedVoices([]);
        if (hadActiveBowedSympathy) {
          hadActiveBowedSympathy = false;
          const ctx = peekSharedAudioContext();
          const bus = getSharedOutputBusForContext(ctx);
          updateSympatheticBowedVoices(ctx, bus, [], liveModelGraph(store().getState()).graph.nodes);
        }
        return;
      }
      const s = store().getState();
      const nodes = liveModelGraph(s).graph.nodes;
      const bowedPayloads = [];
      const activeBowedForSympathy: {
        node: SceneNode;
        pitchHz: number;
        amplitude: number;
        stringHarmonicWeights?: number[];
      }[] = [];

      for (const ev of contacts) {
        const strNode = findNode(nodes, ev.stringNodeId);
        if (!strNode || !strNode.acousticString) continue;
        const bowNode = findNode(nodes, ev.bowNodeId);
        const bowSpec = bowNode?.acousticBow;
        const bowGeom = bowNode?.geoms?.find((g) => g.name === ev.bowGeomName) ?? bowNode?.geoms?.[0];
        let bowRibbonWidthM = 0.009;
        if (typeof bowSpec?.hairWidthMm === 'number' && Number.isFinite(bowSpec.hairWidthMm) && bowSpec.hairWidthMm > 0) {
          bowRibbonWidthM = Math.max(0.002, Math.min(0.025, bowSpec.hairWidthMm * 1e-3));
        } else if (bowGeom?.type === 'box' && bowGeom.size.length >= 3) {
          const sorted = [...bowGeom.size.slice(0, 3)].sort((a, b) => a - b);
          bowRibbonWidthM = Math.max(0.003, Math.min(0.024, sorted[1] * 2));
        } else if (bowGeom && (bowGeom.type === 'capsule' || bowGeom.type === 'cylinder')) {
          bowRibbonWidthM = Math.max(0.003, Math.min(0.020, (bowGeom.size[0] ?? 0.004) * 2));
        }
        const forceScale =
          typeof bowSpec?.forceScale === 'number' && Number.isFinite(bowSpec.forceScale) && bowSpec.forceScale > 0
            ? Math.max(0.1, Math.min(5.0, bowSpec.forceScale))
            : 1.0;
        const bowBeta = resolveStringBetaFromPoint(
          strNode,
          ev.localPoint,
          ev.stoppedLengthFraction,
          nodes,
        );
        const solved = solveBowedStringVoice({
          node: strNode,
          sceneNodes: nodes,
          bowVelocityMps: ev.bowVelocityMps,
          bowForceN: ev.bowForceN * forceScale,
          bowBeta,
          stoppedLengthFraction: ev.stoppedLengthFraction,
          bowRibbonWidthM,
        });
        const spatial = resolveNodeSpatial(ev.stringNodeId, strNode, ev.localPoint);
        bowedPayloads.push({
          id: ev.stringNodeId,
          active: solved.active,
          pitchHz: solved.pitchHz,
          amplitude: solved.amplitude,
          harmonicWeights: solved.harmonicWeights,
          stringHarmonicWeights: solved.stringHarmonicWeights,
          bodyIr: solved.bodyIr,
          bodyIrSig: solved.bodyIrSig,
          bodyFormantHz: solved.bodyFormantHz,
          bodyFormantGainDb: solved.bodyFormantGainDb,
          bodyFormantQ: solved.bodyFormantQ,
          secondaryFormantHz: solved.secondaryFormantHz,
          woodModeHz: solved.woodModeHz,
          dipoleCancelHz: solved.dipoleCancelHz,
          dipoleCancelDb: solved.dipoleCancelDb,
          bridgeHillHz: solved.bridgeHillHz,
          bridgeHillGainDb: solved.bridgeHillGainDb,
          lowpassHz: solved.lowpassHz,
          rosinNoiseGain: solved.rosinNoiseGain,
          rosinCenterHz: solved.rosinCenterHz,
          pan: spatial.pan,
          distanceGain: spatial.distanceGain,
        });
        if (solved.active) {
          activeBowedForSympathy.push({
            node: strNode,
            pitchHz: solved.pitchHz,
            amplitude: solved.amplitude,
            stringHarmonicWeights: solved.stringHarmonicWeights,
          });
        }
      }
      updateLiveBowedVoices(bowedPayloads);
      if (activeBowedForSympathy.length > 0 || hadActiveBowedSympathy) {
        hadActiveBowedSympathy = activeBowedForSympathy.length > 0;
        const ctx = peekSharedAudioContext();
        const bus = getSharedOutputBusForContext(ctx);
        if (ctx && bus) {
          updateSympatheticBowedVoices(ctx, bus, activeBowedForSympathy, nodes);
        }
      }
    };
    client.onAeroAudio = (voices, snaps) => {
      if (!useSoundStore.getState().soundEnabled || !store().getState().isPlaying) {
        silenceAeroVoices();
        return;
      }
      const s = store().getState();
      const nodes = liveModelGraph(s).graph.nodes;
      const solvedVoices = voices.map((v) => {
        const solved = solveAeroAcousticVoice(v);
        const aeroNode = findNode(nodes, solved.id);
        const spatial = resolveNodeSpatial(solved.id, aeroNode, null, v.worldPos ?? null);
        return {
          ...solved,
          pan: spatial.pan,
          distanceGain: spatial.distanceGain,
        };
      });
      updateLiveAeroVoices(solvedVoices);
      for (const sn of snaps) {
        const snapParams = solveClothSnapPulse(sn);
        const snapNode = findNode(nodes, sn.nodeId);
        const spatial = resolveNodeSpatial(sn.nodeId, snapNode, null, sn.worldPos ?? null);
        playAeroSnapPulse(snapParams, spatial);
      }
    };
    client.onContactFriction = (contacts) => {
      if (!useSoundStore.getState().soundEnabled || !store().getState().isPlaying) {
        if (hadActiveFrictionVoices) {
          hadActiveFrictionVoices = false;
          silenceFrictionVoices();
        }
        return;
      }
      if (contacts.length === 0) {
        if (hadActiveFrictionVoices) {
          hadActiveFrictionVoices = false;
          updateLiveFrictionVoices([]);
        }
        return;
      }
      const s = store().getState();
      const nodes = liveModelGraph(s).graph.nodes;
      const payloads = contacts.map((ev) => {
        const primaryNode = findNode(nodes, ev.nodeId);
        const partnerNode =
          ev.otherNodeId && ev.otherNodeId !== 'world' ? findNode(nodes, ev.otherNodeId) : null;
        const primaryProfile = primaryNode ? cachedModesFor(primaryNode, nodes) : null;
        const partnerProfile = partnerNode ? cachedModesFor(partnerNode, nodes) : null;
        const spatial = resolveNodeSpatial(
          ev.nodeId,
          primaryNode,
          ev.localPoint ?? null,
          ev.contactPointWorld ?? null,
        );
        return solveContactFrictionVoice(ev, {
          primaryProfile,
          primaryNode,
          partnerProfile,
          partnerNode,
          spatial,
        });
      });
      hadActiveFrictionVoices = payloads.some((p) => p.active);
      updateLiveFrictionVoices(payloads);
    };
    client.onAudioDamping = (contacts) => {
      if (!useSoundStore.getState().soundEnabled || contacts.length === 0) return;
      const ctx = peekSharedAudioContext();
      if (!ctx) return;
      const s = store().getState();
      applyAudioDampingEvents(ctx, contacts, liveModelGraph(s).graph.nodes, s.data?.time);
    };
    client.setSound(useSoundStore.getState().soundEnabled);
    // A zip's slider let go in the viewport: the garment's trim done up as far,
    // as the inspector's slider or MCP would set it. Not rebuilt: the cloth
    // is done up so already.
    client.onClothZip = ({ cloth, trim, fastened }) => {
      const st = store().getState();
      let node: SceneNode | undefined;
      const find = (list: SceneNode[]) => { for (const n of list) { if (node) return; if (n.cloth && (n.name || n.id) === cloth) node = n; else find(n.children ?? []); } };
      find(st.sceneGraph.nodes);
      const draft = node?.cloth?.garment;
      if (!node || !draft) return;
      const trims = garmentSettings(draft).trims ?? [];
      if (!trims[trim] || trims[trim].kind !== 'zipper') return;
      const f = Math.round(fastened * 1000) / 1000;
      if (Math.abs(doneUp(trims[trim]) - f) < 1e-3) return;
      const next = trims.map((t, k) => (k === trim ? { ...t, fastened: f >= 1 ? true : f <= 0 ? false : f } : t));
      st.prepareForDiscreteChange();
      st.updateNode(node.id, { cloth: { ...node.cloth!, garment: { ...draft, trims: next } } }, true);
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

let prevSoundEnabled = useSoundStore.getState().soundEnabled;
useSoundStore.subscribe((state) => {
  const wasEnabled = prevSoundEnabled;
  prevSoundEnabled = state.soundEnabled;
  physicsWorkerClientSingleton?.setSound(state.soundEnabled);
  if (!state.soundEnabled) {
    silenceAllLiveAcoustics();
  } else if (!wasEnabled) {
    try {
      const s = store().getState();
      if (s.isPlaying) {
        prewarmSceneAcousticIRs(liveModelGraph(s).graph.nodes);
      }
    } catch {
      // Store not initialized in pure unit-test imports
    }
  }
});

// Silence modal & continuous voices on simulation pause, and physically choke grabbed bodies!
setTimeout(() => {
  try {
    store().subscribe((state, prev) => {
      if (prev.isPlaying && !state.isPlaying) {
        silenceAllLiveAcoustics();
      }
      if (state.draggedNodeId && state.draggedNodeId !== prev.draggedNodeId) {
        chokeBodyVoice(null, state.draggedNodeId, { mode: 'grab' });
      }
    });
  } catch {
    // Store not initialized in pure unit-test imports
  }
}, 0);
