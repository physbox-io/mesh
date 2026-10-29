/**
 * MCP bridge for Physics Sim.
 * Uses the Zustand store directly (getState/setState) from outside React.
 */

import { useEffect } from 'react';
import { getStoredAuthToken } from '../utils/apiClient';
import { tabSession } from '../utils/tabSession';
import { useViewQuality } from '../store/viewQualityStore';
import { renderViewportNow, captureViewportThumb } from '../utils/viewportCapture';
import { savePreset } from '../utils/presetStorage';
import { announcePresetSave } from '../utils/presetNotices';
import { summarizeTrajectory } from '../utils/trajectorySummary';
import { authoredQuat, orientationOf } from '../utils/bodyOrientation';
import { useStore, getPhysicsWorkerClient } from '../store/useStore';
import { createMeshMachineHandlers, setCurrentScene } from '../utils/machineMcp';
import { compileToMJCF, PRINT_CONTACT_TIME } from '../utils/mjcf';
import { compileSCAD } from '../utils/openscad';
import { getLiveCameraPose } from '../utils/liveCamera';
import { makePresetNoteCard, updateOrCreateNotecard, type NoteCard } from '../utils/noteCards';
import { compileCsgNodes } from './useCsgCompile';
import { bodyEdges, bodyUp, whyNotRoundable } from '../utils/edgeRoundBase';
import { maxSizeFor, sameEdge, type EdgeCandidate } from '../utils/featureEdges';
import { SOLIDITY_DECOMPOSE_BELOW, collidersAreStale } from '../utils/convexDecomposition';
import { PRESETS } from '../presets/presetScenes';
import { parseSTL } from '../utils/stlParser';
import { deleteUserPreset, readUserPreset, listUserPresetNames, ensureUserPreset, type SavedCopilotMessage } from '../utils/userPresets';
import { unpackMeshArrays } from '../utils/meshPacking';
import { describeReferenceImage, normalizeReferencePicture, readReferencePatch, upsertReferenceImage } from '../utils/referenceImages';
import { sceneContentBounds } from '../utils/frameScene';
import { measureInScene } from '../utils/measureScene';
import { cutAlongPlaneOffThread } from '../utils/printSplitClient';
import { runMcpRepairMesh } from '../utils/meshRepair';
import { patternSurfaces } from '../utils/facePatternPick';
import { carryAcrossCut, knifeSoups, seamsAcross } from '../utils/knife';
import { splitSeams } from '../utils/surfaceTexture';
import type { Object3D } from 'three';
import { Vector3 } from 'three';
import type { SceneGraph, SceneNode, SceneGeom, SceneJoint, HardwarePartKind } from '../types/scene';
import type { RawNode } from '../utils/sceneNodes';
import { HARDWARE_PARTS } from '../utils/hardwareParts';
import { hardwareList } from '../utils/hardwareList';
import { CAMERA_VIEWS, type CameraView } from '../utils/cameraViews';
import { getLiveDimensions } from '../utils/liveDimensions';
import { belowFloor, boundsOverlaps, contactOverlaps, DEFAULT_OVERLAP_TOLERANCE } from '../utils/collisionCheck';
import { walkBodiesWorld } from '../utils/bodyWorld';
import { initialContacts } from './initialContacts';
import { bboxOf, geomBboxOf, isFabricationScene, meshIntegrity, staleBodies, stockReport, summarizeNode } from '../utils/sceneSummary';
import { recompilesInFlight } from '../store/simulationActions';
import { framingPatch } from '../store/sceneFraming';
import { modelBuiltFrom } from '../store/modelProvenance';
import { withMotorArmature } from '../utils/motionParts';
import type { HeadlessResult, HistoryEntry, HistoryQuery } from '../workers/physicsWorkerProtocol';
import {
  type PhysicsWindow, workerStatusNow, countBodies, collectNodeIds, type Msg, pointList,
  resolveParent, withChild, findNodeInScene, stripMeshArrays, HEADLESS_WAIT_FOR_COLLIDERS_MS,
  SUSPICIOUSLY_LARGE_DIAGONAL_M,
} from './mcp/bridgeUtils';
import { sculptHistory } from './mcp/sculptState';
import {
  pendingDeclarativeOps, normalizeRgba, fillGeomDefaults, resolveUpdatedGeoms, resolveBreakFields,
  fillBodyDefaults,
} from './mcp/bodyDefaults';
import {
  movingPieceOf, sealCheckFor, applySingleCutToBody, applyRoundEdgesToBody,
  applySinglePatternToBody, applyPaintStrokeToBody, applyDeclarativePreCsgFeatures,
  applyDeclarativePostCsgFeatures,
} from './mcp/bodyFeatures';
import { autoCompileScad, settleScene } from './mcp/settleScene';
import type { McpCommands } from './mcp/types';
import { sculptCommands } from './mcp/sculptCommands';
import { latticeCommands } from './mcp/latticeCommands';
import { breakageCommands } from './mcp/breakageCommands';
import { castCommands } from './mcp/castCommands';
import { partBuildCommands } from './mcp/partBuildCommands';
import { machiningCommands } from './mcp/machiningCommands';

// Moved into ./mcp, and still imported from here.
export { type LatticeOpSpec, runLatticeOps } from './mcp/latticeState';
export { fillGeomDefaults, resolveUpdatedGeoms, fillBodyDefaults } from './mcp/bodyDefaults';
export {
  applySingleCutToBody, applyRoundEdgesToBody, applySinglePatternToBody, applyPaintStrokeToBody,
} from './mcp/bodyFeatures';


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

function tabIdentity(): { sessionId: string; label: string; href: string; startedAt: number } {
  const { id, startedAt } = tabSession();
  const href = typeof location !== 'undefined' ? location.href : '';
  const port = typeof location !== 'undefined' ? location.port : '';
  return { sessionId: id, label: `Mesh :${port} ${id.slice(4)}`, href, startedAt };
}

/** Every command but the machine ones, by name; the modules under ./mcp each add a family. */
const COMMANDS: McpCommands = {
  ...machiningCommands,
  ...partBuildCommands,
  ...castCommands,
  ...breakageCommands,
  ...latticeCommands,
  ...sculptCommands,
};

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

      if (Object.hasOwn(COMMANDS, cmd)) return COMMANDS[cmd](msg, { store, toId });

      switch (cmd) {
        case 'GET_STATE': {
          const worker = workerStatusNow(store);
          return {
            // Mesh arrays stripped as physics_get_objects strips them: one
            // carved tray made this reply 2.8 MB. include_meshes asks for them.
            sceneGraph: msg.includeMeshes === true
              ? store.sceneGraph
              : { ...store.sceneGraph, nodes: (store.sceneGraph.nodes || []).map(stripMeshArrays) },
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
          };
        }

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

        case 'GET_SCENE_SUMMARY': {
          // Bodies the installed model was not built from, as they now stand:
          // their `inertial` is the previous build's.
          const stale = staleBodies(store.sceneGraph, store.model ? modelBuiltFrom().graph : null);
          const compiling = recompilesInFlight > 0;
          return {
            ...(stale.size || compiling ? {
              modelStale: {
                bodies: stale.size,
                compiling,
                note: compiling
                  ? 'A compile is in flight: inertial figures and masses marked stale are from the previous build. Ask again in a moment.'
                  : 'The scene has changed since the model was last compiled (or its compile failed: see physics_get_state.lastCompileError). Inertial figures and masses marked stale are from the previous build.',
              },
            } : {}),
            nodes: (store.sceneGraph.nodes || []).map((n) => summarizeNode(n, { model: store.model, stale })),
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
        }

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
          // A body still being broken into convex pieces collides as its hull
          // until they land, so a run straight after a load could throw a car
          // off a track that is solid across its channel and say nothing. Wait
          // a while for them, then say which bodies ran as hulls.
          const pendingBodies = () => {
            const out: string[] = [];
            const walk = (nodes: SceneNode[] = []) => nodes.forEach(n => { if (collidersAreStale(n)) out.push(n.name); walk(n.children); });
            walk(useStore.getState().sceneGraph.nodes);
            return out;
          };
          for (const until = Date.now() + HEADLESS_WAIT_FOR_COLLIDERS_MS; pendingBodies().length > 0 && Date.now() < until;) {
            await new Promise(r => setTimeout(r, 250));
          }
          const stillPending = pendingBodies();
          const { sceneGraph, gravityZ, floorFriction, windX, windY, density, floorBounce } = useStore.getState();
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
          if (stillPending.length > 0) {
            result.warnings = [
              `Ran before the convex pieces of ${stillPending.join(', ')} were ready, so ${stillPending.length === 1 ? 'it' : 'they'} collided as a convex hull with any hollow filled in. Wait until physics_get_scene_summary no longer reports collisionPending, then run again.`,
              ...(result.warnings ?? []),
            ];
          }
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
                ? { ...g, vertCount: (g.renderVertices || g.vertices || []).length / 3, faceCount: (g.faces || []).length / 3, bbox: geomBboxOf(g), ...meshIntegrity(g) }
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
          if (Array.isArray(updates.joints)) updates.joints = updates.joints.map(withMotorArmature);
          const breakError = resolveBreakFields(updates, target.deformMaterial);
          if (breakError) return { ok: false, error: breakError };
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
          // `partId`, not `id`: `id` is the request's own, so a part named that way
          // was never seen, and every call read the request id as a part's.
          const { kind, size, lengthMm, washer, into, group, at, fixTo, partId: existing, between } = msg as Msg<{
            kind: string; size?: string | number; lengthMm?: number; washer?: boolean; into?: string; group?: string; at?: number[];
            fixTo?: string; partId?: string; between?: string[];
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

          // Counted the same way as after, without the generated geoms a
          // recompile replaces: counting those made a union report -8.
          const before = (target.geoms || []).filter((g: SceneGeom) => !g.csgDerived).length;
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
          const rawFields = { ...raw } as Record<string, unknown>;
          const breakError = resolveBreakFields(rawFields, undefined);
          if (breakError) return { ok: false, error: breakError };
          const node = fillBodyDefaults(rawFields as RawNode, parent ? parent.moves : null);
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
            nodeCount: countBodies(useStore.getState().sceneGraph.nodes),
            topLevelCount: useStore.getState().sceneGraph.nodes.length,
          };
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

        case 'PLAY': {
          if (!store.isPlaying) store.togglePlay();
          // Whether there is anything to play: a scene the worker never built
          // used to play nothing and report ok all the same.
          const { sceneBuilt, compiling, note } = workerStatusNow(useStore.getState(), false);
          return {
            ok: true,
            isPlaying: useStore.getState().isPlaying,
            sceneBuilt,
            ...(sceneBuilt ? {} : { compiling, warning: note }),
          };
        }

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
            bodyCount,
            method: exact ? 'contacts' : 'bounds',
            toleranceMm: tol * 1000,
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
            nodeCount: countBodies(graph.nodes),
            topLevelCount: graph.nodes.length,
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
              collisionResolution: `number — V-HACD voxel count for this body's decomposition, 10,000 to 1,000,000. Default 25,000, with one automatic retry at 100,000 and up to 64 pieces when the first result fills a cavity in; a long thin part (length over wall thickness 80 or more, e.g. a U-channel track) starts at up to 400,000 and 512 pieces instead (physics_get_scene_summary reports any left as cavitiesFilled). Raise it for a narrow slot or groove that still comes out solid; it costs decomposition time, not simulation time.`,
              collisionHulls: `number — how many convex pieces to break each of this body's meshes into, up to 512. Default: 8 to 16, scaled by how concave it is, or more for a long thin part. Contact cost between two decomposed bodies is quadratic in this, and accuracy is flat past about 16, so raise it only for a shape whose cavity is genuinely being missed.`,
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
          const result = await settleScene(nodes, { freshStart: true });
          // A new scene is framed as a loaded preset is: the whole of it, every
          // child and geom at its real pose. The camera used to stay wherever
          // it was, which for a 300 mm ride was a close-up of its base.
          useStore.setState(framingPatch(useStore.getState().sceneGraph, null));
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
