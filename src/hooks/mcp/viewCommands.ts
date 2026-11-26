// ---------------------------------------------------------------------------
// MCP commands that look at the scene: its state, summary, objects, edges and
// collisions, telemetry and history, measurements, the camera and a
// screenshot, reference images, note cards, and the schema
// ---------------------------------------------------------------------------

import { useViewQuality } from '../../store/viewQualityStore';
import { useCapture } from '../../store/captureStore';
import { useSoundStore } from '../../store/soundStore';
import { renderViewportNow } from '../../utils/viewportCapture';
import { authoredQuat, orientationOf } from '../../utils/bodyOrientation';
import { useStore, getPhysicsWorkerClient } from '../../store/useStore';
import { PRINT_CONTACT_TIME } from '../../utils/contactClasses';
import { getLiveCameraPose } from '../../utils/liveCamera';
import { bodyEdges, bodyUp, whyNotRoundable } from '../../utils/edgeRoundBase';
import { maxSizeFor, sameEdge, type EdgeCandidate } from '../../utils/featureEdges';
import {
  describeReferenceImage, normalizeReferencePicture, readReferencePatch, upsertReferenceImage,
} from '../../utils/referenceImages';
import { sceneContentBounds } from '../../utils/frameScene';
import { measureInScene } from '../../utils/measureScene';
import type { Object3D } from 'three';
import type { SceneNode } from '../../types/scene';
import { hardwareList } from '../../utils/hardwareList';
import { CAMERA_VIEWS, type CameraView } from '../../utils/cameraViews';
import { getLiveDimensions } from '../../utils/liveDimensions';
import { belowFloor, boundsOverlaps, contactOverlaps, DEFAULT_OVERLAP_TOLERANCE } from '../../utils/collisionCheck';
import { bodyWorldPositions, walkBodiesWorld } from '../../utils/bodyWorld';
import { objectReply } from '../../utils/objectReply';
import { meshPage } from '../../utils/meshPage';
import { initialContacts } from '../initialContacts';
import {
  collectFilledCavities, isFabricationScene, staleBodies, stockReport, summarizeNode,
} from '../../utils/sceneSummary';
import { recompilesInFlight } from '../../store/simulationActions';
import { modelBuiltFrom } from '../../store/modelProvenance';
import { withEnvironment } from '../../store/sceneEnvironment';
import type { HistoryQuery } from '../../workers/physicsWorkerProtocol';
import { type PhysicsWindow, workerStatusNow, type Msg, findNodeInScene } from './bridgeUtils';
import { stateNode } from '../../utils/objectReply';
import { sealCheckFor } from './bodyFeatures';
import { bodyNamer, jointTypes, resolveBodyFilter } from '../../utils/headlessReport';
import { digestTelemetry } from '../../utils/telemetryDigest';
import type { NoteCard } from '../../utils/noteCards';
import type { McpCommands } from './types';

const getPhysicsWindow = (): PhysicsWindow | null =>
  (typeof window !== 'undefined' ? (window as unknown as PhysicsWindow) : null);

const isFiniteVec3 = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

const VALID_HISTORY_INCLUDE = new Set(['bodies', 'joints', 'contacts', 'aero']);

/** Serializes overlapping SCREENSHOT calls so temporary view toggles cannot corrupt each other. */
let screenshotQueue: Promise<unknown> = Promise.resolve();
let screenshotsInFlight = 0;

/** Yields a single macrotask with a fresh deadline so overdue timers (like WORKING heartbeats) run first. */
const yieldMacrotask = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Yields two macrotasks so React commits Zustand view-flag / clean-capture
 * updates and flushes passive effects without waiting on `requestAnimationFrame`.
 * Waiting on rAF lets R3F execute 1–2 extra full WebGL renders (several seconds
 * each under SwiftShader) right before `renderViewportNow()` renders again.
 */
const flushReactCommit = (): Promise<void> =>
  yieldMacrotask().then(() => yieldMacrotask());

/**
 * Temporarily no-ops `composer.render` (or `gl.render` when no composer is
 * active) while SCREENSHOT flushes React commits. Background V-HACD collider
 * updates (`applyNodeColliders`), recompiles, and `clean: true` unmounts all
 * call R3F's `invalidate()`, which can fire a 4–6 s SwiftShader `rAF` render
 * right before `renderViewportNow()` renders again — pushing total blocking
 * time past the 10 s MCP hub timeout. Pausing the renderer during the commit
 * flush lets `useFrame` state updates run while skipping redundant GPU draws.
 */
function pauseRendererDuringFlush(composer: unknown, gl: unknown): () => void {
  const restores: Array<() => void> = [];
  const stub = (target: unknown) => {
    if (!target || typeof target !== 'object') return;
    const obj = target as { render?: unknown };
    if (typeof obj.render !== 'function') return;
    const hasOwn = Object.prototype.hasOwnProperty.call(obj, 'render');
    const orig = obj.render;
    obj.render = () => {};
    restores.push(() => {
      if (hasOwn) obj.render = orig;
      else delete obj.render;
    });
  };
  stub(composer);
  if (!composer) stub(gl);
  return () => {
    for (const restore of restores) restore();
  };
}

interface OutlineLikeEffect {
  selection: Iterable<unknown> & { clear: () => void; set: (values: unknown[]) => void };
  forceUpdate?: boolean;
}

/**
 * Temporarily clears any postprocessing OutlineEffect selection on the composer
 * for a clean screenshot, avoiding unmounting `<SelectionOutline />` from
 * `<EffectComposer>` (which tears down passes and forces two full WebGL shader
 * recompilations that stall headless/SwiftShader past the 10s MCP timeout).
 */
function suppressComposerOutlines(composer: unknown): () => void {
  const passes = (composer as { passes?: Array<{ effects?: unknown[] }> } | null | undefined)?.passes;
  if (!Array.isArray(passes)) return () => {};
  const saved: Array<{ effect: OutlineLikeEffect; items: unknown[] }> = [];
  for (const pass of passes) {
    if (!Array.isArray(pass?.effects)) continue;
    for (const raw of pass.effects) {
      const effect = raw as Partial<OutlineLikeEffect> | null | undefined;
      if (
        effect &&
        typeof effect === 'object' &&
        effect.selection &&
        typeof effect.selection.clear === 'function' &&
        typeof effect.selection.set === 'function' &&
        Symbol.iterator in effect.selection
      ) {
        const items = Array.from(effect.selection);
        if (items.length > 0) {
          effect.selection.clear();
          // Ensure OutlineEffect.update() clears its outline render target on this frame.
          effect.forceUpdate = true;
          saved.push({ effect: effect as OutlineLikeEffect, items });
        }
      }
    }
  }
  return () => {
    for (const { effect, items } of saved) {
      effect.selection.set(items);
      effect.forceUpdate = true;
    }
  };
}

async function takeScreenshot(msg: Record<string, unknown>, waitedInQueue = false) {
  const win = getPhysicsWindow();
  const gl = win?._physics_gl;
  if (!gl || !gl.domElement) return { ok: false, error: 'Renderer not ready yet' };

  const startMs = Date.now();
  // If we waited behind an earlier screenshot, yield a fresh macrotask so any
  // overdue MCP WORKING heartbeat timer runs before we start rendering.
  if (waitedInQueue) await yieldMacrotask();

  const viewQuality = useViewQuality.getState();
  const before = {
    colliders: viewQuality.showColliders,
    edges: useStore.getState().showEdges,
    wireframe: useStore.getState().wireframe,
  };
  const wanted = {
    colliders: typeof msg.showColliders === 'boolean' ? msg.showColliders : before.colliders,
    edges: typeof msg.showEdges === 'boolean' ? msg.showEdges : before.edges,
    wireframe: typeof msg.wireframe === 'boolean' ? msg.wireframe : before.wireframe,
  };
  const apply = (v: typeof before) => {
    if (useViewQuality.getState().showColliders !== v.colliders) useViewQuality.getState().setShowColliders(v.colliders);
    const s = useStore.getState();
    if (s.showEdges !== v.edges) s.toggleShowEdges();
    if (s.wireframe !== v.wireframe) s.toggleWireframe();
  };
  const overridden = wanted.colliders !== before.colliders
    || wanted.edges !== before.edges || wanted.wireframe !== before.wireframe;
  const clean = msg.clean === true;
  if (overridden) apply(wanted);
  if (clean) useCapture.setState({ clean: true });
  let restoreOutlines: (() => void) | null = null;
  let restoreRenderer: (() => void) | null = null;
  let dataUrl: string;
  try {
    if (overridden || clean) {
      restoreRenderer = pauseRendererDuringFlush(win?._physics_composer, gl);
      await flushReactCommit();
    }
    // If anything (e.g. a background V-HACD collider install or recompile)
    // stalled the main thread during the flush, yield one fresh macrotask so
    // useMCPBridge's 2 s WORKING heartbeat can fire before renderViewportNow().
    if (Date.now() - startMs >= 250) await yieldMacrotask();
    restoreRenderer?.();
    restoreRenderer = null;
    if (clean) restoreOutlines = suppressComposerOutlines(win?._physics_composer);
    // Through the composer when there is one; see renderViewportNow.
    renderViewportNow();
    dataUrl = gl.domElement.toDataURL('image/png');
  } finally {
    restoreRenderer?.();
    restoreOutlines?.();
    if (overridden) apply(before);
    if (clean) useCapture.setState({ clean: false });
  }

  const ink = (typeof document !== 'undefined' && document.documentElement?.classList?.contains('dark')) ? 'white' : 'black';
  const notes: string[] = [];
  if (wanted.edges) {
    notes.push(`Edges view is on: the thin ${ink} lines along corners, and ${ink} specks on fine detail (text, patterns, sculpted creases, small holes), are ink lines drawn on edges sharper than 20-30 degrees, not geometry or defects. Pass show_edges: false for a frame without them.`);
  }
  if (wanted.wireframe) {
    notes.push('Wireframe view is on: bodies are drawn as their triangle edges, see-through, not as shaded solids. Pass wireframe: false for a shaded frame.');
  }
  if (wanted.colliders) {
    notes.push('Collider overlay is on: coloured outlines are what the physics collides, drawn over the bodies.');
  }
  return {
    ok: true,
    dataUrl,
    width: gl.domElement.width,
    height: gl.domElement.height,
    // Says whether the frame was drawn to order or is whatever the
    // canvas happened to be holding.
    rendered: Boolean(win?._physics_scene && win?._physics_camera),
    view: { ...wanted, clean },
    ...(notes.length ? { note: notes.join(' ') } : {}),
  };
}

export const viewCommands: McpCommands = {
  GET_STATE: async (msg, { store }) => {
    const worker = workerStatusNow(store);
    return {
      // Mesh arrays stripped as physics_get_objects strips them: one
      // carved tray made this reply 2.8 MB. include_meshes asks for them.
      sceneGraph: msg.includeMeshes === true
        ? store.sceneGraph
        : { ...store.sceneGraph, nodes: (store.sceneGraph.nodes || []).map(stateNode) },
      isPlaying:    store.isPlaying,
      // Loaded means the worker holds a model of THIS scene. The store's
      // flag goes true on the first build and stays true, so on its own
      // it said yes for a scene the worker never built.
      isLoaded:     store.isLoaded && worker.sceneBuilt,
      worker,
      gravityZ:     store.gravityZ,
      windX:        store.windX,
      windY:        store.windY,
      density:      store.density,
      floorFriction: store.floorFriction,
      floorBounce:   store.floorBounce,
      lastCompileError: store.lastCompileError,
      soundEnabled: useSoundStore.getState().soundEnabled,
      reverbEnabled: useSoundStore.getState().reverbEnabled,
    };
  },
  GET_CAMERA: async (_msg, { store }) => {
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
  },
  SET_CAMERA: async (msg, { store }) => {
    // Two mutually exclusive forms: { preset } to reset to a built-in
    // view, or { position:[x,y,z], target?:[x,y,z] } for an explicit
    // (perspective) pose. Both position and target are in MuJoCo world
    // space, same convention as every other pos field in this API.
    // `dims` switches the Dims overlay with either form, or alone.
    // `clearSelection` (or `clear_selection`) clears body selection so
    // `dims: true` dimensions the whole scene instead of only the last-added body.
    // Validate ALL parameters before mutating store state.
    if (msg.dims !== undefined && typeof msg.dims !== 'boolean') {
      return { ok: false, error: 'dims must be true or false' };
    }
    if (msg.clearSelection !== undefined && typeof msg.clearSelection !== 'boolean') {
      return { ok: false, error: 'clearSelection must be true or false' };
    }
    if (msg.clear_selection !== undefined && typeof msg.clear_selection !== 'boolean') {
      return { ok: false, error: 'clear_selection must be true or false' };
    }
    const clearSelectionOpt = msg.clearSelection !== undefined ? msg.clearSelection : msg.clear_selection;
    const applyAux = () => {
      if (msg.dims !== undefined) store.setDimsEnabled(msg.dims as boolean);
      if (clearSelectionOpt === true) store.setSelectedNodeId(null);
    };
    if (msg.preset !== undefined) {
      if (typeof msg.preset !== 'string' || !CAMERA_VIEWS.includes(msg.preset as CameraView)) {
        return { ok: false, error: `preset must be one of ${CAMERA_VIEWS.map((v) => `'${v}'`).join(', ')}` };
      }
      applyAux();
      store.setCameraView(msg.preset as CameraView);
      return { ok: true };
    }
    if ((msg.dims !== undefined || clearSelectionOpt !== undefined) && msg.position === undefined && msg.target === undefined) {
      applyAux();
      return { ok: true };
    }
    if (!isFiniteVec3(msg.position)) {
      return { ok: false, error: 'position must be a [x,y,z] array of finite numbers in MuJoCo world space (or pass preset instead)' };
    }
    if (msg.target !== undefined && !isFiniteVec3(msg.target)) {
      return { ok: false, error: 'target must be a [x,y,z] array of finite numbers in MuJoCo world space' };
    }
    const target: [number, number, number] = msg.target ? [msg.target[0], msg.target[1], msg.target[2]] : [0, 0, 0];
    const position: [number, number, number] = [msg.position[0], msg.position[1], msg.position[2]];
    if (Math.hypot(position[0] - target[0], position[1] - target[1], position[2] - target[2]) < 1e-6) {
      return { ok: false, error: 'position and target must not be coincident' };
    }
    applyAux();
    store.setCameraOverride({ position, target });
    return { ok: true };
  },
  // Everything UPDATE_SCENE needs to put the scene back as it was: the
  // environment and the note cards live outside the graph, so they are added.
  GET_SCENE: async (_msg, { store }) => ({
    ...withEnvironment(store.sceneGraph, store),
    noteCards: getPhysicsWindow()?._physics_getNoteCards?.() ?? [],
  }),
  GET_SCENE_SUMMARY: async (_msg, { store }) => {
    // Bodies the installed model was not built from, as they now stand:
    // their `inertial` is the previous build's.
    const stale = staleBodies(store.sceneGraph, store.model ? modelBuiltFrom().graph : null);
    const compiling = recompilesInFlight > 0;
    return {
      ...(stale.size || compiling ? {
        modelStale: {
          bodies: stale.size,
          compiling,
          // The reason, here: it used to be only in physics_get_state, a
          // reply big enough to overflow before anyone found it.
          ...(!compiling && store.lastCompileError ? { lastCompileError: store.lastCompileError } : {}),
          note: compiling
            ? 'A compile is in flight: inertial figures and masses marked stale are from the previous build. Ask again in a moment.'
            : 'The scene has changed since the model was last compiled (or its compile failed: see lastCompileError). Inertial figures and masses marked stale are from the previous build.',
        },
      } : {}),
      nodes: (() => {
        const world = bodyWorldPositions(store.sceneGraph.nodes, { model: store.model, data: store.data, stale });
        return (store.sceneGraph.nodes || []).map((n) => summarizeNode(n, { model: store.model, stale, world }));
      })(),
      // What to buy: every bought part counted, bar stock packed.
      ...(() => {
        const list = hardwareList(store.sceneGraph);
        return list.rows.length ? { hardwareList: list } : {};
      })(),
      ...(store.model?.body_mass ? (() => {
        const { body_mass: mass, body_dofnum: dofs, body_parentid: parent } = store.model!;
        // What moves: a body with a degree of freedom of its own or under
        // one that has. A fixed body (a wall, a bench) weighs nothing to
        // the simulation, and counting it made the total meaningless.
        const moves = (b: number): boolean => b > 0 && ((dofs?.[b] ?? 1) > 0 || (!!parent && moves(parent[b])));
        let total = 0, fixed = 0;
        for (let b = 1; b < mass!.length; b++) {
          if (moves(b)) total += mass![b]; else fixed += mass![b];
        }
        return {
          totalMassKg: +total.toPrecision(6),
          ...(fixed > 0 ? { fixedMassKg: +fixed.toPrecision(6) } : {}),
          // Summed from the installed model, so it is the previous build's
          // until the recompile lands (see modelStale).
          ...(stale.size || compiling ? { massStale: true } : {}),
        };
      })() : {}),
      // Only for something being made: see isFabricationScene.
      ...(isFabricationScene(store.sceneGraph, store.carveSettings)
        ? { stock: stockReport(store.sceneGraph, store.stock) }
        : {}),
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
  },
    /*
      A picture pinned in the viewport to model from. Without `imageId` it
      adds one (`image` required: a data URL or bare base64, which the
      server reads off disk for `path`); with `imageId` it changes that one.
      `remove` takes one off, `clear` takes them all. One undo step either
      way. Not `id`: that is the request's own id on the wire.
    */
  SET_REFERENCE_IMAGE: async (msg, { store }) => {
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
    if (msg.height !== undefined) {
      if (typeof msg.height !== 'number' || !Number.isFinite(msg.height) || msg.height <= 0 || msg.height > 20) {
        throw new Error('height must be a finite number more than 0 and at most 20 m');
      }
      if (msg.width === undefined) patch.height = msg.height;
    }
    if (typeof image === 'string' && image) {
      Object.assign(patch, await normalizeReferencePicture(image.startsWith('data:') ? image : `data:image/png;base64,${image}`));
    } else if (!id) {
      throw new Error('Give path (or image) to add a reference image, or imageId to change one');
    }
    const latest = useStore.getState();
    const { images, image: placed } = upsertReferenceImage(
      latest.sceneGraph.referenceImages, id, patch, sceneContentBounds(latest.sceneGraph.nodes),
    );
    if (placed.width > 20) {
      throw new Error('Resulting reference image width exceeds maximum of 20 m');
    }
    latest.setReferenceImages(images);
    return { ok: true, ...describeReferenceImage(placed), referenceImages: listed(images) };
  },
  GET_TELEMETRY: async () => {
    return getPhysicsWorkerClient().getTelemetry().then(t => t || { error: 'No simulation telemetry available' });
  },
  GET_HISTORY: async (msg, { store }) => {
    // The worker holds up to 5000 frames, ~14 MB of JSON when full. No
    // agent can read that, so unless maxFrames is given (0 = no cap) the
    // stride is raised to fit 200 frames across whatever window was asked for.
    if (msg.sinceTime !== undefined && !(typeof msg.sinceTime === 'number' && Number.isFinite(msg.sinceTime))) {
      return { ok: false, error: 'sinceTime must be a finite number' };
    }
    if (msg.last !== undefined && !(typeof msg.last === 'number' && Number.isFinite(msg.last) && msg.last >= 0)) {
      return { ok: false, error: 'last must be a non-negative finite number' };
    }
    if (msg.stride !== undefined && !(typeof msg.stride === 'number' && Number.isFinite(msg.stride) && msg.stride >= 1)) {
      return { ok: false, error: 'stride must be a finite number >= 1' };
    }
    if (msg.maxFrames !== undefined && !(typeof msg.maxFrames === 'number' && Number.isFinite(msg.maxFrames) && msg.maxFrames >= 0)) {
      return { ok: false, error: 'maxFrames must be a non-negative finite number' };
    }
    if (msg.bodies !== undefined && (!Array.isArray(msg.bodies) || msg.bodies.some((b) => typeof b !== 'string'))) {
      return { ok: false, error: 'bodies must be an array of body names or ids' };
    }
    if (msg.include !== undefined && (!Array.isArray(msg.include) || msg.include.some((k) => typeof k !== 'string' || !VALID_HISTORY_INCLUDE.has(k)))) {
      return { ok: false, error: "include must be an array containing only 'bodies', 'joints', 'contacts', or 'aero'" };
    }
    // Names or ids, as physics_run_headless takes them; frames are keyed by id.
    const filter = resolveBodyFilter(store.sceneGraph, msg.bodies);
    const summaryOnly = msg.summary === true;
    const { frames, total, stride } = await getPhysicsWorkerClient().getHistory({
      sinceTime: msg.sinceTime as number | undefined,
      last: msg.last as number | undefined,
      stride: msg.stride as number | undefined,
      maxFrames: (msg.maxFrames as number | undefined) ?? (summaryOnly ? 400 : 200),
      // Nothing matched keeps nothing, not everything.
      bodies: filter.ids ? (filter.ids.size ? [...filter.ids] : ['\u0000none']) : undefined,
      include: msg.include as HistoryQuery['include'] | undefined,
    });
    const unknown = filter.unknown.length ? { warning: `bodies: no body has the name or id ${filter.unknown.map((u) => `"${u}"`).join(', ')}.` } : {};
    const latestGraph = useStore.getState().sceneGraph;
    if (summaryOnly) {
      return {
        total, stride,
        digest: digestTelemetry(frames, { jointTypes: jointTypes(latestGraph), nameOf: bodyNamer(latestGraph) }),
        ...unknown,
      };
    }
    return {
      total, returned: frames.length, stride, frames,
      ...(filter.unknown.length ? { warning: `bodies: no body has the name or id ${filter.unknown.map((u) => `"${u}"`).join(', ')}.` } : {}),
    };
  },
  GET_OBJECTS: async (_msg, { store }) => {
    return (store.sceneGraph.nodes || []).map(stateNode);
  },
  GET_OBJECT: async (msg, { store }) => {
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
    // Every mesh geom gets its size and integrity checks, as
    // physics_get_scene_summary gives them; convex pieces are counted, not
    // listed, unless `full` (utils/objectReply.ts).
    const stale = staleBodies(store.sceneGraph, store.model ? modelBuiltFrom().graph : null);
    const world = bodyWorldPositions(store.sceneGraph.nodes, { model: store.model, data: store.data, stale });
    // Every O-ring groove on it, checked against what is round it now.
    const grooves = [...new Set((found.geoms || []).filter((g) => g.hardware?.part === 'groove').map((g) => g.hardware!.group))];
    const sealChecks = grooves.map((group) => ({ group, ...sealCheckFor(store.sceneGraph, found.id, group) }));
    if (msg.offset !== undefined && !(typeof msg.offset === 'number' && Number.isFinite(msg.offset) && msg.offset >= 0)) {
      throw new Error('offset must be a non-negative finite number');
    }
    if (msg.limit !== undefined && !(typeof msg.limit === 'number' && Number.isFinite(msg.limit) && msg.limit >= 1)) {
      throw new Error('limit must be a finite number >= 1');
    }
    // One geom's triangles, a page at a time, when asked for (utils/meshPage.ts).
    const wantsMesh = typeof msg.geom === 'string' || typeof msg.offset === 'number' || typeof msg.limit === 'number';
    const page = wantsMesh
      ? meshPage(store.sceneGraph.nodes, found.id, {
          geom: typeof msg.geom === 'string' ? msg.geom : undefined,
          offset: typeof msg.offset === 'number' ? msg.offset : undefined,
          limit: typeof msg.limit === 'number' ? msg.limit : undefined,
        })
      : null;
    if (page && 'error' in page) throw new Error(page.error);
    return {
      ...objectReply(found, { full: msg.full === true, world, scene: store.sceneGraph.nodes }),
      ...(sealChecks.length ? { sealChecks } : {}),
      ...(page ? { meshPage: page } : {}),
    };
  },
  MEASURE: async (msg, { store, toId }) => {
    const { from, to, corner, snap, withinMm } = msg;
    // Which way a body points, rather than a distance: `body` with an
    // optional local `axis`. Read from the simulation's latest frame when
    // it has one, else from the body as authored.
    if (msg.body !== undefined) {
      if (typeof msg.body !== 'string' || !msg.body) {
        return { ok: false, error: 'body must be a non-empty body id or name' };
      }
      if (msg.axis !== undefined && msg.axis !== 'x' && msg.axis !== 'y' && msg.axis !== 'z') {
        return { ok: false, error: "axis must be 'x', 'y' or 'z'" };
      }
      const resolved = toId ? toId(msg.body) : msg.body;
      const node = typeof resolved === 'string' ? findNodeInScene(store.sceneGraph.nodes, resolved) : null;
      if (!node) return { ok: false, error: `No body with id or name "${msg.body}"` };
      const axis = (msg.axis ?? 'z') as 'x' | 'y' | 'z';
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
    if (withinMm !== undefined && !(typeof withinMm === 'number' && Number.isFinite(withinMm) && withinMm >= 0 && withinMm <= 10000)) {
      return { ok: false, error: 'withinMm must be a finite number between 0 and 10000' };
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
    const root = (getPhysicsWindow()?._physics_scene as Object3D | undefined) ?? null;
    const measured = measureInScene(root, point(from, 'from'), point(to, 'to'), {
      corner: corner === undefined ? undefined : point(corner, 'corner'),
      snap: snap !== false,
      withinMm: typeof withinMm === 'number' ? withinMm : 3,
    });
    return {
      ok: true,
      ...measured,
      // Whether any end really moved onto something, not whether snapping was asked for.
      snapped: [measured.from, measured.to, measured.corner].some((end) => !!end && end.movedByMm > 0),
    };
  },
    /*
     * Rounded and bevelled edges. GET_EDGES lists what can be rounded, with
     * ids; ROUND_EDGES rounds some of them — by id, or by a group a person
     * would name (all, top, bottom, vertical). The edges are found on the
     * body as modelled, before any rounding, so ids stay put while its
     * roundings change. See utils/edgeRound.ts.
     */
  GET_EDGES: async (msg, { store }) => {
    const { targetId } = msg as Msg<{ targetId: string }>;
    if (typeof targetId !== 'string' || !targetId) return { ok: false, error: 'Missing targetId' };
    const node = findNodeInScene(store.sceneGraph.nodes, targetId);
    const why = whyNotRoundable(node);
    if (why) return { ok: false, error: node ? why : `No object with id '${targetId}'` };
    const found = await bodyEdges(node!, bodyUp(store.sceneGraph.nodes, targetId));
    const latestNode = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId) ?? node!;
    const mm = (p: number[]) => p.map((v) => Math.round(v * 1e6) / 1e3);
    const roundedBy = (e: EdgeCandidate) => (latestNode.edgeRounds ?? []).findIndex((f) => f.edges.some((x) => sameEdge(x, e.edge)));
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
      roundings: (latestNode.edgeRounds ?? []).map((f, i) => ({
        index: i, mode: f.mode === 'fillet' ? 'round' : 'bevel', sizeMm: Math.round(f.size * 1e5) / 100, edges: f.edges.length,
      })),
    };
  },
  CHECK_COLLISIONS: async (_msg, { store }) => {
    const nodes = store.sceneGraph.nodes || [];
    const tol = DEFAULT_OVERLAP_TOLERANCE;
    // The contacts MuJoCo itself makes on the first step are the exact
    // answer; the boxes are the fallback when the worker cannot run the
    // scene, and are conservative (a box round a diagonal strut).
    const exact = await initialContacts(store).catch(() => null);
    const overlappingPairs = exact
      ? contactOverlaps(exact, nodes, tol)
      : [
          ...boundsOverlaps(nodes, tol),
          ...belowFloor(nodes, tol).map((f) => ({ bodyA: f.body, bodyB: 'floor', geomA: f.geom, geomB: 'floor', depthMm: f.depthMm })),
        ];
    let bodyCount = 0;
    walkBodiesWorld(nodes, () => { bodyCount++; });

    // A body whose cavity is filled in is the other reason a scene does
    // not behave: nothing overlaps, and the ball still will not go in.
    // This is the command someone runs when that happens, so say it here
    // rather than make them go looking in the scene summary.
    const latestNodes = useStore.getState().sceneGraph.nodes || [];
    const filledCavities = collectFilledCavities(latestNodes);

    return {
      ok: true,
      hasInterpenetrations: overlappingPairs.length > 0,
      bodyCount,
      method: exact ? 'contacts' : 'bounds',
      toleranceMm: tol * 1000,
      overlappingPairs,
      ...(filledCavities.length ? {
        filledCavities,
        note: 'These bodies are hollow but collide as their convex hull, so their cavities are solid to contact — anything dropped in rests on the rim. Set collision:\'decompose\' on them, or simplify the mesh if it was declined for being too dense.',
      } : {}),
    };
  },
  SCREENSHOT: async (msg) => {
    const waited = screenshotsInFlight > 0;
    screenshotsInFlight++;
    const run = screenshotQueue.then(
      () => takeScreenshot(msg, waited),
      () => takeScreenshot(msg, waited),
    );
    screenshotQueue = run.then(
      () => { screenshotsInFlight = Math.max(0, screenshotsInFlight - 1); },
      () => { screenshotsInFlight = Math.max(0, screenshotsInFlight - 1); },
    );
    return run;
  },
  GET_NOTE_CARDS: async () => {
    const getter = getPhysicsWindow()?._physics_getNoteCards;
    return { ok: true, noteCards: getter ? getter() : [] };
  },
  SET_NOTE_CARDS: async (msg) => {
    const setter = getPhysicsWindow()?._physics_setNoteCards;
    if (!setter) return { ok: false, error: 'Note card state not available' };
    if (!Array.isArray(msg.noteCards)) return { ok: false, error: 'noteCards must be an array' };
    for (let i = 0; i < msg.noteCards.length; i++) {
      const card = msg.noteCards[i];
      if (!card || typeof card !== 'object' || Array.isArray(card)) {
        return { ok: false, error: `noteCards[${i}] must be an object` };
      }
      const c = card as Record<string, unknown>;
      if (typeof c.id !== 'string' || c.id.length === 0) {
        return { ok: false, error: `noteCards[${i}].id must be a non-empty string` };
      }
      if (typeof c.markdown !== 'string') {
        return { ok: false, error: `noteCards[${i}].markdown must be a string` };
      }
      if (c.x !== undefined && !(typeof c.x === 'number' && Number.isFinite(c.x))) {
        return { ok: false, error: `noteCards[${i}].x must be a finite number` };
      }
      if (c.y !== undefined && !(typeof c.y === 'number' && Number.isFinite(c.y))) {
        return { ok: false, error: `noteCards[${i}].y must be a finite number` };
      }
      if (c.minimized !== undefined && typeof c.minimized !== 'boolean') {
        return { ok: false, error: `noteCards[${i}].minimized must be a boolean` };
      }
    }
    setter(msg.noteCards as NoteCard[]);
    return { ok: true };
  },
  GET_SCHEMA: async () => {
    return {
      choosingTheRightTool: {
        ruleOfThumb: 'Build detailed scenes in ONE call to physics_build_scene (or add parts with physics_add_object) using declarative body features instead of making 20 sequential tool calls or hand-writing raw triangle arrays.',
        mechanicalPartsWithHolesThreadsRounding: 'Use primitive geoms + declarative `cuts: [...]`, `roundEdges: [...]`, `patterns: [...]`, and `paint: [...]` directly on the body descriptor in physics_build_scene / physics_add_object / physics_update_object, OR boolean geoms (`csg: "difference" | "intersection"`).',
        extruded2DProfilesWithHoles: 'Use `type: "extrude"` (or `"prism"`) with `polygon: [[x,y], ...]` (metres), optional `holes: [[[x,y], ...]]`, and `height` (metres) on a geom or body.',
        turnedOrAxisymmetricParts: 'Use `type: "lathe"` (or `"revolve"`) with `profile: [[r,z], ...]` (metres) on a geom or body, OR a declarative lattice `{ lattice: { empty: true, subdiv: 1, ops: [{ op: "revolve", profile: [[xMm,0,zMm], ...] }] } }`.',
        conesWedgesToriTubes: 'Use parametric geom types directly: `cone` (`size: [r, hh]`), `pyramid` (`size: [hx, hy, hh]`), `wedge` (`size: [hx, hy, hz]`), `torus` (`size: [R, r]`), `tube` / `pipe` (`size: [outerR, innerR, hh]`).',
        subdivisionAndGridPolyhedra: 'Use declarative `lattice: { sizeMm: 40, subdiv: 1, thicknessMm: 0, ops: [{ op: "extrude" | "inset" | "bevel" | "bevel_edges" | "circle" | "revolve" | "bridge" | "faces" | "delete_faces" | "sharpen" | "dimension" | "orient" | "smooth" | "wall", ... }] }` on the body, or pass `ops: [...]` to `physics_create_lattice`.',
        organicClayShapes: 'Use declarative `sculpt: { base: "sphere" | "cube" | "cylinder" | "humanoid" | "quadruped" | "bird" | "fish" | "hand" | "head", strokes: [...], cuts: [...] }` on the body, or pass batch `strokes: [...]` to `physics_sculpt`.',
        curvedTracksAndRamps: 'Set `isCurve: true` and `curvePoints: [[x,y,z], ...]` (Z-up metres) on the body.',
        compliantFlexures: 'Set declarative `flexure: { kind: "blade" | "cross_pivot" | "serpentine" | "bistable", filament?: "pla" | "petg" | "abs" | "asa" | "tpu", thicknessMm?, lengthMm?, widthMm?, folds?, archRiseMm?, jointName?, targetDeflection? }` on a hinged/sliding body, or use `physics_build_mechanism` families `compliant_gripper`, `parallel_flexure`, `cantilever_pawl`.',
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
        extrude:   '2D polygon prism (alias `prism`): provide `polygon: [[x,y], ...]` in metres, optional `holes: [[[x,y], ...]]`, and `height` in metres (or `size: [halfHeight]`; with neither it is 0.1 m tall). Centered on Z by default (`centered: false` spans z=0..height).',
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
        cuts:          'DeclarativeCut[] — array of hole/slot/pocket/hardware cut specs `{ shape?: "cylinder"|"box"|"pocket"|"slot"|"nut_trap"|"nut_slot"|"counterbore"|"countersink"|"insert"|"insert_boss"|"bearing"|"oring"|"seal_cord"|"rail_seat"|"rod_clamp"|"lm_housing"|"snap_hook"|"snap_catch", at?: [xMm,yMm,zMm], normal?: [nx,ny,nz], diameterMm?, widthMm?, lengthMm?, depthMm?, threadPitchMm?, size?: "M3"|"M4"|..., bore?, fitMm?, angleDeg? }` applied automatically when the body is built or updated',
        flexure:       'FlexureDesignInput — declarative monolithic compliant flexure replacing a rigid hinge or slide joint: `{ kind: "blade"|"cross_pivot"|"serpentine"|"bistable", filament?: "pla"|"petg"|"abs"|"asa"|"tpu", thicknessMm?, lengthMm?, widthMm?, folds? (2..8 for serpentine), archRiseMm? (for bistable), jointName?, targetDeflection? (deg for hinge, mm for slide) }`. Computes spring stiffness, travel limits, yield safety factor, and deformable bending leaf geoms automatically.',
        roundEdges:    'DeclarativeRound[] | DeclarativeRound — `{ edges?: "all"|"top"|"bottom"|"vertical"|"inside"|number[], sizeMm: number, mode?: "round"|"bevel" }` (or array of them; alias `roundings`) applied automatically after cuts',
        patterns:      'DeclarativePattern[] — array of surface textures `{ at: [xMm,yMm,zMm], normal?: [nx,ny,nz], pattern: "knurl"|"hex"|"ribs"|"grid"|"wave"|"dimples"|"voronoi"|"flutes"|"threads"|"text", depthMm?: number, emboss?: boolean, options?: {...} }` applied automatically to the body faces',
        paint:         'DeclarativePaint[] — array of paint strokes `{ at: [x,y,z] | [[x,y,z],...], rgba: [r,g,b,a?], radius?: number, flow?: number, geomName?: string }` (in metres) applied automatically after CSG',
        lattice:       '`{ sizeMm?: number, empty?: boolean, subdiv?: 0|1|2, thicknessMm?: number, ops?: LatticeOp[] }` — builds a lattice body inline in a single pass. Each op in `ops` is `{ op: "extrude"|"inset"|"bevel"|"bevel_edges"|"circle"|"revolve"|"bridge"|"faces"|"delete_faces"|"sharpen"|"dimension"|"orient"|"smooth"|"wall", ... }` in mm.',
        sculpt:        '`{ base?: "sphere"|"cube"|"cylinder"|"humanoid"|"quadruped"|"bird"|"fish"|"hand"|"head", strokes?: SculptStroke[], cuts?: SculptCut[] }` — builds a sculpted clay body inline in a single pass.',
        joints:        'SceneJoint[] — joints attaching this body to its parent',
        children:      'SceneNode[] — child bodies (rigidly offset unless they have joints)',
        coupleTargetId:'string — id of another body; couples their first hinge or slide joints with coupleRatio',
        isPulleyRope:  'boolean — a rope (no geoms, no joints) tying leftTargetId and rightTargetId, bodies with a slide along the rope, optionally over pulleyWheelId (a hinged isPulleyWheel body with pulleyRadius); taut and rigid',
        leftStrands:   'number — default 1; strands holding the rope\'s left end (rightStrands for the right): 2 = movable pulley, 4 = four-fall block and tackle',
        isRack:        'boolean — this slide body is a rack: coupled to a hinged wheel that meshes with it (axis square to the slide, face about one wheel radius from the axis)',
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
        compositeType: `'cable'|'rope' — default 'cable'; the two are the same. MuJoCo no longer has grid or cloth composites.`,
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
        collision:     `'auto'|'hull'|'decompose'|'primitives'|'hfield' — how THIS BODY collides, mesh or boolean. MuJoCo collides a mesh as its CONVEX HULL, which fills in any cavity, so a cup, bowl, open-top box, funnel or housing would be solid to contact. 'auto' (the default) measures SOLIDITY — true volume over hull volume — uses a native MuJoCo <hfield> for static 2.5D relief/terrain meshes, and breaks other hollow shapes below ~0.92 into convex pieces. A box or sphere is 1.0 and keeps its hull, which is exact and cheap; a cup is around 0.3 and gets decomposed, so a ball dropped in lands INSIDE it. 'hfield' forces a native MuJoCo heightfield collider on a static mesh body. 'hull' forces the old filled-in behaviour. 'decompose' forces the split even for a mesh auto declined (under ~24 triangles, or over ~150k). 'primitives' is boolean-only: the authored positives collide and the mesh is visual. Runs in the background and is cached against the mesh, so it costs nothing until the shape changes. NOTE a decomposed hollow body weighs its true volume rather than its hull's — often a third as much; set mass or collisionMass if you wanted the heavier figure.`,
        collisionResolution: `number — V-HACD voxel count per chunk of this body's decomposition, 10,000 to 1,000,000. Each mesh is cut into chunks first, while a chunk is long and thin for its wall or its pieces fill a cavity, and every piece is then pulled in to the surface; a lathed part is sliced exactly about its axis instead. Default: enough for a wall two voxels thick, up to 25,000; Detail Fine is 50,000 and Finest 100,000. Raise it for a slot that still comes out solid (cavitiesFilled) or a fit that jams (openingsNarrowedMm in physics_get_scene_summary); it costs decomposition time, not simulation time. A boolean body is decomposed the same way, except one with a hole right through it along an axis, which is sliced into csgSectors around that axis instead.`,
        collisionHulls: `number — the most convex pieces this body's meshes may come out as in all, up to 512 (default 512, or 64 for a body on a free joint). Leave it unset: setting it low caps the chunks and pieces and fills cavities back in.`,
        collisionMass: `number (kg) — the body's total mass, shared by volume across what it collides as: a mesh body's convex pieces, and a boolean body's colliders (or its positive primitives in 'primitives' mode, or its mesh as a hull). On a boolean body a body-level mass does the same; collisionMass wins when both are set.`,
        csgCollision:  `DEPRECATED, use 'collision'. Still read, so older scenes behave as they always did. 'auto'|'decompose'|'primitives'|'hull' — how the boolean result collides.`,
        csgSectors:    'number — sector count for decomposition (default 16). Higher = tighter fit to the hole, more geoms.',
        csgHoleAxis:   `'auto'|'x'|'y'|'z' — axis the hole runs along, for decomposition. 'auto' takes the longest axis of the largest negative geom.`,
        csgMass:       'DEPRECATED alias of collisionMass on a boolean body, still read so older scenes keep their weight. collisionMass, or a body-level mass, wins when set.',
        csgFn:         'number — OpenSCAD $fn (facet count) for the generated primitives (default 32).',
        deformMaterial: '\'steel\' | \'softMetal\' | \'hardwood\' | \'softwood\' | \'plastic\' | \'rubber\' | \'ceramic\' | \'glass\' | \'stone\' | \'pasta\' | \'custom\' — the body\'s Physical Material preset (anything else is refused). Sets modal impact sound synthesis (Young\'s modulus E, density fallback, mechanical Q sustain, and transient brightness — e.g. steel rings high/long, hardwood gives a warm marimba knock, ceramic/glass chime crisply, plastic gives a short muted thud, rubber a dull thump) and provides default strength when `loadStrength: true` is used. \'custom\' keeps your own density and contact numbers. For pitched bodies see nodeFields.acoustics.',
        acousticString: 'object: `{ material?: \'steel\'|\'bronze\'|\'nylon\'|\'gut\' (default \'bronze\'), diameterMm?: number > 0 (default 0.65), tensionN?: number > 0 (default 50), pluckPos?: number (x/L, clamped to 0.03..0.5), resonatorNodeId?: string (soundbox body id for bridge coupling), nonlinearPitchDroop?: boolean | number }` — makes a capsule/cylinder a taut musical string: Mersenne\'s law with Fletcher stiff-string inharmonicity, a breaking-stress check, and bridge coupling into a hollow soundbox it spans. A string needs a transverse slide joint to be pluckable: `tuneTo` (below) adds one. Missing numbers are filled with the defaults; an unknown material or a non-positive number is refused with the valid values. Read the result in physics_get_object `acoustics.string` (fundamentalHz, stressRatio, lengthM, warnings, bridgeCoupling).',
        windInstrument: 'object: `{ exciter: \'reed\'|\'brass_lip\'|\'flute_jet\'|\'flap_valve\' (required), breathKPa?: number >= 0 (default 0 = silent; playing is 1.5..7 kPa), embouchureHz?: number > 0 (reed / lip / flap-valve natural frequency; default 260, 55 for flap_valve), boreLengthM?, mouthRadiusM?, bellRadiusM?, flareExponent?: number > 0 (a coiled or folded horn\'s unwrapped bore, mouthpiece, bell, and flare; read from the 3D geometry when omitted), toneholeJoints?: [{ jointName, axialFraction, diameterMm }], valveJoints?: [{ jointName, semitones, strokeM? }] }` — a hollow body becomes a 1D waveguide wind instrument whose pitch is the bore\'s resonance the exciter locks to. \'flap_valve\' is an autonomous compliant valve (a whoopee cushion, a raspberry): its pitch is embouchureHz itself. A script blows it with `api.state.breathKPa` and `api.state.embouchureHz` (they override the spec\'s while set). A bad exciter is refused with the valid four. Read physics_get_object `acoustics.wind` (boreShape, lengthM, resonantModesHz, muteFactor, breachFactor).',
        acousticMembrane: 'object: `{ material?: \'mylar\'|\'coated_film\'|\'calfskin\'|\'kevlar\' (default \'mylar\'), tensionNPerM?: number > 0 (default 1800), thicknessMm?: number > 0 (default 0.19), shape?: \'circular\'|\'rectangular\' (inferred from the geometry), shellNodeId?: string (the kettle or shell body; found by position when omitted), kettleCoupling?: 0..1, snareBuzz?: 0..1, pitchGlideSemitones?: number, pitchGlideDecayMs?: number > 0, nonlinearGlide?: 0..2 }` — a thin disc or sheet becomes a tensioned drumhead (Bessel modes, air-cavity coupling, a harder hit sounds a little sharp then settles). Read physics_get_object `acoustics.membrane` (fundamentalHz, overtoneRatio, warnings).',
        nonlinearPlate: 'object: `{ enabled?: boolean, crashSensitivity?: number (0 = linear, 1 = physical default, above 1 = a dramatic tam-tam), bloomDelayMs?: number (50..250), pitchGlideCents?: number, shimmerMix?: 0..1, archRatio?: number (dome rise / plate thickness; above 0.3 glides like an opera gong) }` — von Karman geometric nonlinearity for a thin metal plate, cymbal or gong: a hard hit blooms upward in energy. Thin stiff plates are detected without it; the spec tunes or disables it. All numbers must be finite. physics_get_object `acoustics.nonlinearPlate` is true when the body counts as one.',
        resonatorTube: 'object: `{ endCondition?: \'open_closed\' (quarter-wave stopped tube) | \'open_open\' (half-wave pipe) — detected when omitted, coupledBarNodeId?: string (the bar over its mouth), vaneJointName?: string (a motor-driven vibraphone fan hinge), vaneMaxOcclusion?: 0..1 (default 0.88), tuningHz?: number > 0 }` — a hollow tube\'s air column as a resonator under a bar (a marimba or vibraphone). Read physics_get_object `acoustics.resonatorTube` (fundamentalHz, endCondition). An invalid endCondition is refused.',
        acousticBow: 'object: `{ rosinGrip?: 0.2..2 (default 1), rosinFriction?: 0.20..0.65 (default 0.38), hairWidthMm?: 3..18 (default 9), forceScale?: number > 0 (default 1) }` — makes the body a rosined horsehair bow for strings (stick-slip, the Schelleng bow-force wedge). Out-of-range numbers are clamped. Setting it stamps horsehair contact on the body\'s first solid geom, only for the fields that geom lacks: condim 3, friction [rosinFriction, 0.004, 0.0004], solref [0.005, 1.25].',
        tunedPitchHz: 'number — READ-ONLY: the concert pitch (Hz) the body was last tuned to, stamped by `tuneTo` or the app\'s Tune card. Writing it does not tune anything; use `tuneTo`.',
        tuneTo: 'note | number | object — a request, not a field (never stored): tunes the body to a pitch as it is built, and is applied after every default is filled. `\'A4\'`, `\'F#3\'` (concert pitch, A4 = 440) or a number of Hz, or `{ note | hz, drillNodalHole?: boolean }` (a body-level `drillNodalHole` is read too). Accepted on a body in physics_build_scene, physics_add_object and physics_update_object. It picks the tuner for what the body is: acousticString sets tension and gauge for the span it vibrates over (and adds a pluck joint), acousticMembrane the head tension, resonatorTube the tube\'s length, windInstrument the bore\'s length (or a flap valve\'s embouchureHz), any other body (a bar, chime tube, plate, block) its dimensions, with `drillNodalHole` also drilling the nodal suspension hole. The result is in `tunedPitchHz`; physics_get_object `acoustics` says what the body now sounds like. In physics_update_object a partial acoustic spec (`windInstrument: { breathKPa: 4 }`) merges into the body\'s own, and null removes a subfield. A bad pitch or spec is refused with the reason.',
        bodyForm: 'object — a dress form built from its measurements (`figure: \'male\'|\'female\'`, height/chest/waist/hip/..., optional visual `skinTone` 0..1, pose `armAngle`/`elbowBend`/`stance`/`kneeBend` in degrees). Give it `geoms: []`.',
        cloth: 'object — XPBD simulated fabric (`garment` fitted via `fitTo` or `pieces`/`seams`/`ties`). Give it `geoms: []` and no joints; see `physics_get_schema` section `\'cloth\'`.',
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
        'GOTCHA — rgba alpha below 1 draws a geom translucent and 0 draws nothing, but it still collides and has mass: alpha hides nothing from the physics. Use `role: "collision"` for invisible colliders, `role: "visual"` for non-colliding visuals, and delete what should not be there.',
        'OpenSCAD shapes: set scad="cube([0.5,0.5,0.5]);" on a body node. If geoms is omitted, it automatically creates a dynamic mesh geom and compiles the SCAD code to vertices/faces.',
        'SOUND — set `deformMaterial` for how a body rings when hit. Pitched instruments: `acousticString`, `windInstrument`, `acousticMembrane`, `resonatorTube`, `acousticBow` (nodeFields.acoustics), tuned declaratively with `tuneTo: \'A4\'` (or Hz) on the body. Read what a body sounds like in physics_get_object `acoustics`; turn the audio on with physics_set_environment `sound: true`.',
        'Bouncy objects: set solref=[0.04, 0.2] and solimp=[0.99, 0.9999, 0.0001, 0.5, 2]. dampingRatio 0.2 = lively bounce. The floor has dampingRatio=0.0 so ball+floor averages to 0.1 (still bouncy).',
      ],
    };
  },
};
