/**
 * MCP bridge for Physics Sim.
 * Uses the Zustand store directly (getState/setState) from outside React.
 */

import { useEffect } from 'react';
import { useStore, getPhysicsWorkerClient } from '../store/useStore';
import { compileToMJCF } from '../utils/mjcf';
import { compileSCAD } from '../utils/openscad';
import { getLiveCameraPose } from '../utils/liveCamera';
import { makePresetNoteCard, updateOrCreateNotecard } from '../utils/noteCards';
import { generateCurveGeoms, DEFAULT_CURVE_POINTS, DEFAULT_CURVE_WIDTH, DEFAULT_CURVE_THICKNESS, DEFAULT_CURVE_SEGMENTS } from '../utils/geom';
import { compileCsgNodes } from './useCsgCompile';
import { PRESETS } from '../presets/presetScenes';
import { parseSTL } from '../utils/stlParser';
import { saveUserPreset, deleteUserPreset, readUserPreset, listUserPresetNames } from '../utils/userPresets';

const autoCompileScad = async (nodes: any[]) => {
  const scadNodes: any[] = [];
  const collect = (nodesList: any[]) => {
    if (!nodesList) return;
    for (const node of nodesList) {
      if (node.scad) scadNodes.push(node);
      collect(node.children);
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
        const result = await compileSCAD(node.scad);
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
      useStore.getState().updateNodeScad(node.id, node.scad, compiled, true);
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
const settleScene = async (nodes: any[]): Promise<{ ok: boolean; error?: string; nodeCount: number }> => {
  const store = useStore.getState();
  // A freshly built/replaced scene (BUILD_SCENE/UPDATE_SCENE) is never a preset
  // load, so any note card left over from a previously-loaded preset (e.g.
  // "Double Pendulum") is now describing a scene that no longer exists. Clear
  // it here rather than relying on callers to remember to.
  (window as any)._physics_setNoteCards?.([]);
  // skipRecompile: this initial set uses placeholder (pre-scad) mesh geoms, so
  // an immediate recompile here would be both wasted work and another stale
  // build racing against the final one below.
  store.updateScene({ nodes }, true);
  await autoCompileScad(nodes);
  // Boolean bodies compile through the same OpenSCAD pool, and just as
  // asynchronously — a caller that got ok:true before they finished would be
  // told a scene built when its geometry didn't exist yet. skipFinalRecompile:
  // the single build below covers it.
  await compileCsgNodes(true);
  // This is now the ONLY recompile triggered by this load, so there's nothing
  // left to race against. forceReset is false so recompile() preserves qpos/qvel
  // when the edit didn't change the DOF count (e.g. tweaking a color or adding a
  // fixed body) instead of always snapping the sim back to its initial state.
  await useStore.getState().recompile(useStore.getState().sceneGraph, undefined, false, true);
  const error = useStore.getState().lastCompileError;
  return { ok: !error, ...(error ? { error } : {}), nodeCount: nodes.length };
};

const findNodeInScene = (nodes: any[], id: string): any | null => {
  for (const node of nodes || []) {
    if (node.id === id || node.name === id) return node;
    const child = findNodeInScene(node.children, id);
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

const summarizeGeom = (g: any) => ({
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
      }
    : { size: g.size }),
});

const summarizeNode = (node: any): any => ({
  id: node.id,
  name: node.name,
  pos: node.pos,
  ...(node.quat ? { quat: node.quat } : {}),
  ...(node.euler ? { euler: node.euler } : {}),
  ...(node.scad ? { hasScad: true } : {}),
  ...(node.csgEnabled ? {
    csg: {
      collision: node.csgCollision ?? 'auto',
      ...(node.csgVolume !== undefined ? { volumeM3: +node.csgVolume.toFixed(8) } : {}),
      ...(node.csgWarning ? { warning: node.csgWarning } : {}),
      ...(node.csgError ? { error: node.csgError } : {}),
    },
  } : {}),
  joints: (node.joints || []).map((j: any) => ({ name: j.name, type: j.type })),
  geoms: (node.geoms || []).map(summarizeGeom),
  children: (node.children || []).map(summarizeNode),
});

const stripMeshArrays = (node: any): any => {
  const cloned = { ...node };
  if (cloned.geoms) {
    cloned.geoms = cloned.geoms.map((g: any) => {
      const { vertices, faces, renderVertices, ...rest } = g;
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
const fillGeomDefaults = (g: any, bodyName: string, idx: number) => ({
  name:    g.name    ?? `${bodyName}_geom_${idx}`,
  type:    g.type    ?? 'box',
  size:    g.size    ?? [0.25, 0.25, 0.25],
  rgba:    g.rgba    ?? [0.6, 0.6, 0.9, 1],
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
  ...(g.dynamic     !== undefined ? { dynamic: g.dynamic } : {}),
  ...(g.renderVertices !== undefined ? { renderVertices: g.renderVertices } : {}),
  ...(g.csg         !== undefined ? { csg: g.csg }           : {}),
  ...(g.role        !== undefined ? { role: g.role }         : {}),
});

const fillJointDefaults = (j: any, bodyName: string, idx: number) => ({
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

const fillBodyDefaults = (b: any): any => {
  const name = b.name ?? b.id ?? `body_${Math.random().toString(36).slice(2, 7)}`;
  const id   = b.id   ?? name;
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
  return {
    id,
    name,
    type:     'body',
    pos:      b.pos     ?? [0, 0, 1],
    ...(b.quat  !== undefined ? { quat: b.quat }   : {}),
    ...(b.euler !== undefined ? { euler: b.euler } : {}),
    geoms:    (curveGeoms ?? b.geoms ?? (b.scad !== undefined ? [{ type: 'mesh', size: [1], dynamic: true }] : [{ type: 'box', size: [0.25, 0.25, 0.25] }]))
                .map((g: any, i: number) => fillGeomDefaults(g, name, i)),
    joints:   (b.joints  ?? (b.isCurve === true ? [] : [{ type: 'free' }]))
                .map((j: any, i: number) => fillJointDefaults(j, name, i)),
    children: (b.children ?? []).map(fillBodyDefaults),
    ...(b.coupleTargetId  !== undefined ? { coupleTargetId: b.coupleTargetId }   : {}),
    ...(b.coupleRatio     !== undefined ? { coupleRatio: b.coupleRatio }         : {}),
    ...(b.weldTargetId    !== undefined ? { weldTargetId: b.weldTargetId }       : {}),
    ...(b.connectTargetId !== undefined ? { connectTargetId: b.connectTargetId } : {}),
    ...(b.connectAnchor   !== undefined ? { connectAnchor: b.connectAnchor }     : {}),
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
    ...((b.csgEnabled === true || (b.geoms || []).some((g: any) => g.csg === 'difference' || g.csg === 'intersection'))
      ? { csgEnabled: true } : {}),
    ...(b.csgCollision !== undefined ? { csgCollision: b.csgCollision } : {}),
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

// Bounding-box diagonal above this (in MuJoCo meters) on a freshly-compiled
// SCAD mesh almost always means the source forgot the required
// scale([0.001,0.001,0.001]) wrapper and compiled at millimeter scale by
// mistake (a 183x132x11mm part is ~0.2m across; the same part un-scaled
// is ~183m across) rather than an intentionally huge object.
const SUSPICIOUSLY_LARGE_DIAGONAL_M = 20;

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
        ws!.send(JSON.stringify({ event: 'HELLO', app: 'physics', port: location.port }));

      ws.onmessage = (evt) => {
        let msg: any;
        try { msg = JSON.parse(evt.data); } catch { return; }
        const { cmd, id } = msg;
        if (!cmd) return;

        useStore.getState().incrementMcpActive();

        let result: unknown;
        try {
          result = handle(cmd, msg);
        } catch (e) {
          ws?.send(JSON.stringify({ event: 'ERROR', cmd, id, error: String(e) }));
          useStore.getState().decrementMcpActive();
          return;
        }
        Promise.resolve(result)
          .then(data => ws?.send(JSON.stringify({ event: 'RESULT', cmd, id, data })))
          .catch(e  => ws?.send(JSON.stringify({ event: 'ERROR', cmd, id, error: String(e) })))
          .finally(() => {
            useStore.getState().decrementMcpActive();
          });
      };

      ws.onclose = () => { if (!dead) retryTimer = setTimeout(connect, 2000); };
      ws.onerror = () => ws?.close();
    };

    const handle = async (cmd: string, msg: any): Promise<unknown> => {
      // Access Zustand store directly — works outside React render
      const store = useStore.getState();

      switch (cmd) {
        case 'GET_STATE':
          return {
            sceneGraph:   store.sceneGraph,
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
          };
        }

        case 'SET_CAMERA': {
          // Two mutually exclusive forms: { preset: 'perspective'|'topDown' } to
          // reset to a built-in view, or { position:[x,y,z], target?:[x,y,z] }
          // for an explicit pose. Both position and target are in MuJoCo world
          // space, same convention as every other pos field in this API.
          if (msg.preset !== undefined) {
            if (msg.preset !== 'perspective' && msg.preset !== 'topDown') {
              return { ok: false, error: "preset must be 'perspective' or 'topDown'" };
            }
            store.setCameraView(msg.preset);
            return { ok: true };
          }
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
          return { nodes: (store.sceneGraph.nodes || []).map(summarizeNode) };

        case 'GET_TELEMETRY':
          return getPhysicsWorkerClient().getTelemetry().then(t => t || { error: 'No simulation telemetry available' });

        case 'GET_HISTORY':
          return getPhysicsWorkerClient().getHistory();

        case 'RUN_HEADLESS': {
          const ticks = Number(msg.ticks) || 300;
          const { sceneGraph, gravityZ, floorFriction, windX, windY, density, floorBounce } = store;
          // Runs inside the same physics worker that owns the live simulation
          // (see src/workers/physicsWorker.ts's runHeadless) — its own isolated
          // model/data built from the one already-loaded mujoco module, so a
          // headless "what-if" run can never diverge from what's actually
          // rendered live, and never costs a second loaded WASM module.
          const xml = compileToMJCF(sceneGraph, gravityZ, floorFriction, windX, windY, density, floorBounce);
          const result: any = await getPhysicsWorkerClient().runHeadless(xml, sceneGraph, ticks);
          // Decimate/filter the trajectory before it crosses the websocket: a
          // full per-tick, per-body trajectory is ~500KB per 900 ticks and was
          // the main reason long runs blew the bridge's 30s response window.
          const stride = Math.max(1, Math.floor(Number(msg.stride) || 1));
          const bodyFilter = Array.isArray(msg.bodies) && msg.bodies.length > 0 ? new Set(msg.bodies) : null;
          if (result?.trajectory && (stride > 1 || bodyFilter)) {
            const t = result.trajectory;
            let frames = stride > 1
              ? t.filter((_: any, i: number) => i % stride === 0 || i === t.length - 1)
              : t;
            if (bodyFilter) {
              frames = frames.map((fr: any) => ({
                ...fr,
                bodies: Object.fromEntries(Object.entries(fr.bodies || {}).filter(([k]) => bodyFilter.has(k))),
              }));
            }
            result.trajectory = frames;
          }
          return result;
        }

        case 'GET_OBJECTS':
          return (store.sceneGraph.nodes || []).map(stripMeshArrays);

        case 'GET_OBJECT': {
          const targetId = msg.targetId;
          if (!targetId) throw new Error('Missing object id');
          const findNode = (nodesList: any[]): any => {
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
          return stripMeshArrays(found);
        }

        case 'UPDATE_OBJECT': {
          const targetId = msg.targetId;
          const updates = msg.updates;
          if (!targetId) throw new Error('Missing object id');
          if (!updates) throw new Error('Missing updates payload');

          if (updates.scad !== undefined) {
            let compiled: any = null;
            let lastErr: any = null;
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
              throw new Error(`Failed to compile SCAD: ${lastErr?.message || String(lastErr)}`);
            }
            store.updateNodeScad(targetId, updates.scad, compiled, false);
          } else {
            store.updateNode(targetId, updates);
            // An update that touches a boolean body (its geoms, its collision
            // mode, a csg marker) invalidates the generated mesh. The editor's
            // debounced auto-compiler would get to it eventually, but an MCP
            // caller is told ok:true synchronously — so do it here and await it.
            const compiled = await compileCsgNodes(true);
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
          return { ok: !error, ...(error ? { error } : {}) };
        }

        case 'TOGGLE_PLAY':
          store.togglePlay();
          return { ok: true, isPlaying: store.isPlaying };

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
          store.loadPreset(name);
          getPhysicsWorkerClient().clearHistory();
          // Mirror App.tsx's loadPresetWithCard/loadUserPresetWithCard: replace
          // whatever note card is showing with this preset's own card (or clear
          // it) instead of leaving a stale card from whatever was loaded before -
          // this path (MCP LOAD_PRESET) used to skip that entirely, since it
          // calls store.loadPreset directly rather than through those UI wrappers.
          const setter = (window as any)._physics_setNoteCards;
          if (setter) {
            if (name.startsWith('user:')) {
              const saved = readUserPreset(name);
              setter(saved && Array.isArray(saved.noteCards) ? saved.noteCards : []);
            } else {
              const presetCard = makePresetNoteCard(name);
              setter(presetCard ? [presetCard] : []);
            }
          }
          const msgSetter = (window as any)._physics_setCopilotMessages;
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
          // Through the shared accessor, not localStorage directly: a preset an
          // agent saves has to reach the account like any other, and this path
          // is the one that used to bypass sync.
          const saved = saveUserPreset(userPresetKey, {
            sceneGraph: store.sceneGraph,
            noteCards: (window as any)._physics_getNoteCards?.() || [],
            copilotMessages: (window as any)._physics_getCopilotMessages?.() || [],
          });
          if (!saved) return { ok: false, error: 'Could not write the preset to local storage' };
          return { ok: true, preset: `user:${userPresetKey}` };
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

          const computeBounds = (nodeList: any[], parentPos: number[] = [0, 0, 0]) => {
            for (const node of nodeList) {
              const nodePos = [
                (node.pos?.[0] || 0) + parentPos[0],
                (node.pos?.[1] || 0) + parentPos[1],
                (node.pos?.[2] || 0) + parentPos[2],
              ];
              const min = [nodePos[0] - 0.1, nodePos[1] - 0.1, nodePos[2] - 0.1];
              const max = [nodePos[0] + 0.1, nodePos[1] + 0.1, nodePos[2] + 0.1];

              (node.geoms || []).forEach((g: any) => {
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

          return {
            ok: true,
            hasInterpenetrations: overlappingPairs.length > 0,
            bodyCount: bodyBounds.length,
            overlappingPairs,
          };
        }

        case 'IMPORT_STL': {
          const { stlData, name, importMode, pos, scale, dynamic } = msg;
          if (!stlData) return { ok: false, error: 'Missing stlData (Base64 string or ASCII text)' };

          let data: ArrayBuffer | string;
          try {
            if (typeof stlData === 'string' && stlData.startsWith('data:')) {
              const b64 = stlData.split(',', 1)[1] || stlData;
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

          const mode = importMode || 'scad_parametric';
          const nodePos = Array.isArray(pos) && pos.length === 3 ? pos : [0, 0, 1];
          const id = `stl_${Math.random().toString(36).slice(2, 7)}`;
          let newNode: any = null;

          if (mode === 'scad_parametric') {
            newNode = {
              id,
              name: baseName,
              pos: nodePos,
              scad: parsed.scadParametric,
              geoms: [{ type: 'mesh', size: [1], dynamic: dynamic !== false }],
              joints: [{ type: 'free' }],
              children: [],
            };
          } else if (mode === 'scad_raw') {
            newNode = {
              id,
              name: baseName,
              pos: nodePos,
              scad: parsed.scadRaw,
              geoms: [{ type: 'mesh', size: [1], dynamic: dynamic !== false }],
              joints: [{ type: 'free' }],
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
              }],
              joints: [{ type: 'free' }],
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
              }],
              joints: [{ type: 'free' }],
              children: [],
            };
          }

          const currentNodes = store.sceneGraph.nodes || [];
          const updatedNodes = [...currentNodes, newNode];
          const res = await settleScene(updatedNodes);

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
          const gl = (window as any)._physics_gl;
          if (!gl || !gl.domElement) return { ok: false, error: 'Renderer not ready yet' };
          // r3f's default frameloop ("always") keeps redrawing every animation
          // frame, and preserveDrawingBuffer keeps that last-drawn frame around
          // for toDataURL to read synchronously — no manual render needed here.
          const dataUrl = gl.domElement.toDataURL('image/png');
          return { ok: true, dataUrl, width: gl.domElement.width, height: gl.domElement.height };
        }

        case 'GET_NOTE_CARDS': {
          const getter = (window as any)._physics_getNoteCards;
          return { ok: true, noteCards: getter ? getter() : [] };
        }

        case 'SET_NOTE_CARDS': {
          const setter = (window as any)._physics_setNoteCards;
          if (!setter) return { ok: false, error: 'Note card state not available' };
          if (!Array.isArray(msg.noteCards)) return { ok: false, error: 'noteCards must be an array' };
          setter(msg.noteCards);
          return { ok: true };
        }

        case 'VALIDATE_SCAD': {
          const scadCode = msg.scad;
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

        case 'UPDATE_SCENE': {
          if (!msg.sceneGraph) return { ok: false, error: 'Missing sceneGraph' };
          // The MCP tool schema passes sceneGraph as a bare array of nodes (matching
          // BUILD_SCENE's convention); also accept the internal { nodes: [...] } shape.
          const rawNodes = Array.isArray(msg.sceneGraph) ? msg.sceneGraph : msg.sceneGraph.nodes;
          if (!Array.isArray(rawNodes)) {
            return { ok: false, error: 'sceneGraph must be an array of nodes, or an object of the form { nodes: SceneNode[] }' };
          }
          // Run through the same default-filling as BUILD_SCENE so a node missing
          // joints/geoms/children (very easy to hand-author without, e.g. by
          // editing the output of GET_SCENE_SUMMARY, which strips these arrays)
          // doesn't crash compileToMJCF's unconditional .forEach on those fields.
          const nodes = rawNodes.map(fillBodyDefaults);
          const result = await settleScene(nodes);
          updateOrCreateNotecard({
            mode: 'mcp',
            nodes: useStore.getState().sceneGraph.nodes
          });
          return result;
        }

        case 'SET_ENVIRONMENT': {
          const { gravityZ, windX, windY, density, floorFriction, floorBounce } = msg;
          const env: Record<string, number> = {};
          if (gravityZ !== undefined) env.gravityZ = gravityZ;
          if (windX !== undefined) env.windX = windX;
          if (windY !== undefined) env.windY = windY;
          if (density !== undefined) env.density = density;
          if (floorFriction !== undefined) env.floorFriction = floorFriction;
          if (floorBounce !== undefined) env.floorBounce = floorBounce;
          store.setEnvironment(env);
          return { ok: true };
        }

        case 'GET_SCHEMA':
          return {
            geomTypes: ['box', 'sphere', 'capsule', 'cylinder', 'ellipsoid', 'plane', 'mesh'],
            geomSizes: {
              box:       'half-extents [hx, hy, hz]',
              sphere:    'radius [r]',
              capsule:   'radius and half-height [r, hh] — cylinder between the two end-caps. ALWAYS give both elements (or use fromto): a 1-element [r] does not error, it silently falls back to hh=r and collapses the geom into a tiny stub pill at pos.',
              cylinder:  'radius and half-height [r, hh]',
              ellipsoid: 'semi-axes [rx, ry, rz]',
              plane:     'ignored by MuJoCo (infinite plane) — set to [0, 0, 1] or any non-zero',
              mesh:      'not used — shape defined by vertices+faces. Two modes: STATIC (default, visual only) and DYNAMIC (dynamic:true, full physics+collision). See tips.',
            },
            jointTypes: ['hinge', 'slide', 'ball', 'free'],
            geomFields: {
              name:        'string — unique identifier',
              type:        'GeomType (see geomTypes)',
              size:        'number[] — interpretation depends on type (see geomSizes)',
              rgba:        'number[4] — [r, g, b, a] each 0-1, default white opaque',
              pos:         'number[3] — local offset from body origin, NOT world-space (e.g. a box half-extent 0.4 spans local z -0.4..+0.4 regardless of the body\'s world pos)',
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
              vertices:    'number[] — flat array of vertex positions for mesh type: [x0,y0,z0, x1,y1,z1, ...] in Three.js Y-up space',
              faces:       'number[] — flat array of triangle indices for mesh type: [i0,j0,k0, i1,j1,k1, ...]',
              dynamic:     'boolean — if true, mesh participates in simulation and collision; requires renderVertices',
              csg:         `'union'|'difference'|'intersection' — boolean modifier (default 'union'). A geom marked 'difference' is CUT OUT of the union of the body's other geoms instead of being added to it: one ellipsoid plus a slimmer ellipsoid marked 'difference' is a ring. The body is compiled to a single mesh; set csgCollision on the body to choose how it collides.`,
              role:        `'visual'|'collision' — 'visual' draws but never collides (contype/conaffinity forced to 0), 'collision' simulates but is never drawn. Default (omitted) is both.`,
              renderVertices: 'number[] — dynamic mesh only: flat [x0,y0,z0,...] in raw MuJoCo Z-up space. Convert from Y-up vertices: (x,y,z)→(x,-z,y). Do NOT subtract centroid — MuJoCo recenters internally.',
            },
            nodeFields: {
              id:            'string — unique body identifier (used in coupling/weld/connect refs)',
              name:          'string — display name, also used in MuJoCo XML',
              pos:           'number[3] — position relative to parent (world for root nodes)',
              quat:          'number[4] — body orientation quaternion [w,x,y,z]',
              euler:         'number[3] — body orientation in degrees, alternative to quat',
              geoms:         'SceneGeom[] — one or more geoms composing the body shape',
              joints:        'SceneJoint[] — joints attaching this body to its parent',
              children:      'SceneNode[] — child bodies (rigidly offset unless they have joints)',
              coupleTargetId:'string — id of another body; couples their first joints with coupleRatio',
              coupleRatio:   'number — gear ratio for explicit joint coupling (default -1)',
              weldTargetId:  'string — id of body to weld to (closed-loop rigid constraint)',
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
              csgCollision:  `'auto'|'decompose'|'primitives'|'hull' — how the boolean result collides. MuJoCo takes the CONVEX HULL of any mesh geom, so a subtracted hole does not exist for contact unless it is decomposed. 'decompose' (and 'auto', when the negative shape is elongated enough to define a hole axis) slices the result into convex angular sectors so the hole is real and things can pass through it. 'primitives' makes the mesh visual-only and collides the source primitives (exact, but holes are solid). 'hull' collides the whole shape as one filled hull. Default 'auto'.`,
              csgSectors:    'number — sector count for decomposition (default 16). Higher = tighter fit to the hole, more geoms.',
              csgHoleAxis:   `'auto'|'x'|'y'|'z' — axis the hole runs along, for decomposition. 'auto' takes the longest axis of the largest negative geom.`,
              csgMass:       'number — total mass of the boolean solid, split across its colliders by volume. Without this, MuJoCo would derive mass from the hull volume, which for a ring is far more material than there actually is.',
              csgFn:         'number — OpenSCAD $fn (facet count) for the generated primitives (default 32).',
            },
            tips: [
              'GOTCHA — geom pos is body-local, not world-space: for a body at pos [0,0,0.4] with a box half-extent of 0.4, local z=0 is the box center (world z=0.4) and local z=+0.4 is the top face (world z=0.8). Do not pick pos values as if they were world heights. When placing decoration on a face, set the face-normal coordinate to ~half-extent and keep the other two coordinates well inside ±half-extent.',
              'PREFER over manual capsule-chain curves: for rope/cable/mustache/tentacle/vine shapes, set isComposite:true + compositeType:\'cable\' + compositeCount/compositeSize/compositeCurve on one body instead of hand-placing many capsule fromto segments.',
              'Compound shapes: add multiple geoms to one body with different pos/quat/euler offsets',
              'Asymmetric shapes: combine box + sphere + cylinder geoms on a single body',
              'Rings/tubes/holes — PREFER boolean modifiers over hand-built approximations: put two geoms on one body and mark the inner one csg:\'difference\'. E.g. a washer: {type:\'cylinder\',size:[0.12,0.02]} plus {type:\'cylinder\',size:[0.06,0.1],csg:\'difference\'}. The negative MUST be longer than the solid along the hole axis so it pierces right through — a negative that fits entirely inside makes a hollow shell, not a hole, and cannot be decomposed for collision.',
              'A boolean body collides as convex sectors by default (holes are real). Set csgCollision:\'primitives\' if you only care how it looks, or \'hull\' if you want the hole filled for contact.',
              'Torus-like shapes: ring of capsule geoms arranged with pos+euler offsets',
              'L/T/cross shapes: multiple box geoms with offset positions on one body',
              'fromto on capsule lets you specify start/end points directly in local space',
              'Use rgba to color each geom independently for visual variety',
              'ellipsoid semi-axes let you squash/stretch independently on all 3 axes',
              'Children without joints are rigid offsets — useful for adding detail geometry',
              'Arbitrary mesh: type=mesh with vertices=[x0,y0,z0,...] and faces=[i0,j0,k0,...] (triangles)',
              'CRITICAL — mesh vertex coordinate system: X=right, Y=up (height), Z=toward camera. This is Three.js world space, NOT MuJoCo Z-up. The ground plane is at Y=0.',
              'Mesh vertical post example: vertices centred at (cx, halfHeight, cz) with hy=halfHeight (tall in Y)',
              'Mesh flat plank example: box(cx, 0.3, cz, halfSpan, 0.06, halfWidth) — small hy=thickness, large hx=span',
              'Mesh tetrahedron example: vertices=[0,0,0, 1,0,0, 0.5,1,0, 0.5,0.5,1], faces=[0,1,2, 0,1,3, 1,2,3, 0,2,3]',
              'Static mesh (no dynamic field): visual-only. Vertices in Three.js Y-up world space. Never moves, never collides. Good for scenery and decorative structures.',
              'Dynamic mesh (dynamic:true): full physics+collision. MuJoCo takes convex hull — concave shapes will not collide correctly. Requires renderVertices.',
              'CRITICAL — hollow/concave containers (cups, boxes-with-open-tops, tubes): a single dynamic mesh geom can NEVER act as a real container, no matter how the vertices are shaped. MuJoCo collides dynamic meshes via their convex hull, and the hull of a hollow shape\'s vertices is just the solid outer envelope (it fills in the concave interior) — anything dropped on it lands on what is effectively a solid block. Build the hollow shape as a compound body instead: a floor + walls as separate primitive box/cylinder geoms on the same body (each primitive is individually convex, so together they form a real cavity). If you also want a nicer-looking CSG/OpenSCAD shell, add it as an EXTRA geom on the same body with contype:0 and conaffinity:0 (dynamic:true so it still tracks the body kinematically, but doesn\'t participate in collision) so the primitives handle physics while the mesh handles looks.',
              'GOTCHA — rgba alpha is NOT rendered as transparency in this app: the renderer\'s material always uses full opacity regardless of the 4th rgba value, so rgba:[r,g,b,0] does NOT make a geom invisible — it renders as solid opaque black (r=g=b=0), which commonly causes flickering/z-fighting where it overlaps another geom. To hide a primitive collision proxy, do NOT rely on alpha — either color it to match the geom it\'s layered under (e.g. same rgba as a decorative mesh sitting on top of it) or set contype:0/conaffinity:0 on whichever geom you don\'t want colliding and accept both are visible.',
              'Dynamic mesh renderVertices: just swap Y↔Z on each Y-up vertex: (x,y,z)→(x,-z,y). Do NOT subtract centroid. MuJoCo recenters internally.',
              'Dynamic mesh face winding: use outward-facing CCW winding. Wrong winding causes inside-out contacts and objects sinking through surfaces.',
              'Dynamic mesh body pos: set body_pos=[0,0,0] to place mesh where its Y-up base sits. Adjust body_pos.z to raise/lower.',
              'OpenSCAD shapes: set scad="cube([0.5,0.5,0.5]);" on a body node. If geoms is omitted, it automatically creates a dynamic mesh geom and compiles the SCAD code to vertices/faces.',
              'A scad body\'s mesh IS the whole part — when converting a primitive-built body to SCAD (or rewriting its SCAD), send an explicit geoms array holding ONLY that mesh geom. UPDATE_OBJECT with a scad payload refills the existing mesh geom but does NOT prune sibling primitives: leftovers still render and still collide over the mesh, and since they are usually unpositioned (pos [0,0,0], no fromto) they pile up as stray blobs at the body origin. A dynamic mesh already collides via its convex hull, so only keep a primitive if it is a deliberate proxy — positioned explicitly, with contype:0/conaffinity:0 on whichever geom must not collide.',
              'Working example: mesh_collision preset (pyramid + ramp with full collision).',
              'Bouncy objects: set solref=[0.04, 0.2] and solimp=[0.99, 0.9999, 0.0001, 0.5, 2]. dampingRatio 0.2 = lively bounce. The floor has dampingRatio=0.0 so ball+floor averages to 0.1 (still bouncy).',
              'Contact blending: two geoms in contact average their solref/solimp. Keep this in mind when tuning — a non-bouncy floor (dampingRatio=1.0) will halve any ball\'s effective bounce.',
            ],
          };

        case 'BUILD_SCENE': {
          // High-level helper: accepts an array of body descriptors and assembles a valid sceneGraph.
          // Each descriptor can have the same fields as SceneNode but `geoms` may be a shorthand array
          // of plain objects — missing fields are filled with safe defaults so agents don't need to
          // supply every field.
          const bodies: any[] = msg.bodies;
          if (!Array.isArray(bodies) || bodies.length === 0) {
            return { ok: false, error: 'bodies must be a non-empty array' };
          }

          const nodes = bodies.map(fillBodyDefaults);
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
    };
  }, []);
}
