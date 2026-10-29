// ---------------------------------------------------------------------------
// MCP commands for the scene as a whole: play and reset, presets, scene
// files and STL import, the environment, build_scene
// ---------------------------------------------------------------------------

import { captureViewportThumb } from '../../utils/viewportCapture';
import { savePreset } from '../../utils/presetStorage';
import { announcePresetSave } from '../../utils/presetNotices';
import { emptySceneRefusal, reportHeadless } from '../../utils/headlessReport';
import { useStore, getPhysicsWorkerClient } from '../../store/useStore';
import { compileToMJCF } from '../../utils/mjcf';
import { compileSCAD } from '../../utils/openscad';
import { makePresetNoteCard, updateOrCreateNotecard, type NoteCard } from '../../utils/noteCards';
import { collidersBeingDecomposed, compileCsgNodes } from '../useCsgCompile';
import { collidersAreStale } from '../../utils/convexDecomposition';
import { PRESETS } from '../../presets/presetScenes';
import { parseSTL } from '../../utils/stlParser';
import {
  deleteUserPreset, readUserPreset, listUserPresetNames, ensureUserPreset, type SavedCopilotMessage,
} from '../../utils/userPresets';
import { unpackMeshArrays } from '../../utils/meshPacking';
import type { SceneGraph, SceneNode, SceneGeom, SceneJoint } from '../../types/scene';
import type { RawNode } from '../../utils/sceneNodes';
import { bboxOf, stockReport } from '../../utils/sceneSummary';
import { framingPatch } from '../../store/sceneFraming';
import type { HeadlessResult } from '../../workers/physicsWorkerProtocol';
import {
  type PhysicsWindow, workerStatusNow, countBodies, type Msg, HEADLESS_WAIT_FOR_COLLIDERS_MS,
  SUSPICIOUSLY_LARGE_DIAGONAL_M,
} from './bridgeUtils';
import { fillBodyDefaults } from './bodyDefaults';
import { settleScene } from './settleScene';
import { scriptWarnings } from '../../utils/scriptCheck';
import type { McpCommands } from './types';

/** A scene reply, plus a warning for each script that does not compile (applied all the same). */
const withScriptWarnings = <R extends object>(result: R, nodes: SceneNode[]): R & { scriptWarnings?: string[] } => {
  const warnings = scriptWarnings(nodes);
  return warnings.length ? { ...result, scriptWarnings: warnings } : result;
};

export const sceneCommands: McpCommands = {
  RUN_HEADLESS: async (msg) => {
    const ticks = Number(msg.ticks) || 300;
    // A body still being broken into convex pieces collides as its hull
    // until they land, so a run straight after a load could throw a car
    // off a track that is solid across its channel and say nothing. Wait
    // a while for them, then say which bodies ran as hulls.
    const pendingBodies = () => {
      const out: string[] = [];
      // In flight as well as stale: a body whose pieces are being
      // worked out again (a second ask for the same shape joins the first).
      const running = new Set(collidersBeingDecomposed());
      const walk = (nodes: SceneNode[] = []) => nodes.forEach(n => { if (collidersAreStale(n) || running.has(n.id)) out.push(n.name); walk(n.children); });
      walk(useStore.getState().sceneGraph.nodes);
      return out;
    };
    for (const until = Date.now() + HEADLESS_WAIT_FOR_COLLIDERS_MS; pendingBodies().length > 0 && Date.now() < until;) {
      await new Promise(r => setTimeout(r, 250));
    }
    const stillPending = pendingBodies();
    // Nothing to run: an empty scene used to come back ok and settled.
    const empty = emptySceneRefusal(useStore.getState().sceneGraph);
    if (empty) return empty;
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
    // Names or ids; `final` judged on the whole scene before the filter.
    return reportHeadless(result, sceneGraph, msg.bodies);
  },
  TOGGLE_PLAY: async (_msg, { store }) => {
    store.togglePlay();
    // `store` is the snapshot from before the toggle.
    return { ok: true, isPlaying: useStore.getState().isPlaying };
  },
  PLAY: async (_msg, { store }) => {
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
  },
  STOP: async (_msg, { store }) => {
    if (store.isPlaying) store.togglePlay();
    return { ok: true };
  },
  RESET: async (_msg, { store }) => {
    // The worker clears the history itself on a build that starts over from
    // t = 0. Clearing it here too, after the build was posted, wiped the
    // opening frame that build had just recorded.
    store.resetSimulation();
    return { ok: true };
  },
  LOAD_PRESET: async (msg, { store }) => {
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
    // History: cleared by the worker on the fresh build, as for RESET.
    store.loadPreset(name);
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
  },
  SAVE_PRESET: async (msg, { store }) => {
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
  },
  DELETE_PRESET: async (msg) => {
    const name = String(msg.preset || msg.name || '').trim();
    if (!name) return { ok: false, error: 'Missing preset name' };
    const userPresetKey = name.replace(/^user:/, '');
    if (!deleteUserPreset(userPresetKey)) {
      return { ok: false, error: 'Could not write the preset list to local storage' };
    }
    return { ok: true, preset: name };
  },
  LIST_PRESETS: async () => {
    const userKeys = listUserPresetNames().map(k => `user:${k}`);
    return [...Object.keys(PRESETS), ...userKeys];
  },
  IMPORT_STL: async (msg, { store }) => {
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
  },
  VALIDATE_SCAD: async (msg) => {
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
  },
  LOAD_SCENE_FILE: async (msg, { store }) => {
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
    // From rest: a new scene with as many degrees of freedom as the old one
    // used to inherit its poses and clock. That fresh build also clears the
    // history, so the old scene's frames cannot mix with this one's.
    await useStore.getState().recompile(useStore.getState().sceneGraph, null, true, true);
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
  },
  UPDATE_SCENE: async (msg) => {
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
    return withScriptWarnings(result, nodes);
  },
  SET_ENVIRONMENT: async (msg, { store }) => {
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
  },
  BUILD_SCENE: async (msg) => {
    // High-level helper: accepts an array of body descriptors and assembles a valid sceneGraph.
    // Each descriptor can have the same fields as SceneNode but `geoms` may be a shorthand array
    // of plain objects — missing fields are filled with safe defaults so agents don't need to
    // supply every field.
    const bodies = msg.bodies as RawNode[];
    if (!Array.isArray(bodies)) {
      return { ok: false, error: 'bodies must be an array of body descriptors ([] clears the scene)' };
    }

    const nodes = bodies.map((b) => fillBodyDefaults(b));
    const result = withScriptWarnings(await settleScene(nodes, { freshStart: true }), nodes);
    // An empty list clears the scene. It used to be refused, which left
    // physics_update_scene([]) as the only way to start from nothing; there
    // is no scene to frame or describe on a card.
    if (nodes.length === 0) return result;
    // A new scene is framed as a loaded preset is: the whole of it, every
    // child and geom at its real pose. The camera used to stay wherever
    // it was, which for a 300 mm ride was a close-up of its base.
    useStore.setState(framingPatch(useStore.getState().sceneGraph, null));
    updateOrCreateNotecard({
      mode: 'mcp',
      nodes: useStore.getState().sceneGraph.nodes
    });
    return result;
  },
};
