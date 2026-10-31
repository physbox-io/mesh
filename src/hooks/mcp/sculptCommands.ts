// ---------------------------------------------------------------------------
// MCP sculpt commands. The ones that change the clay run one at a time
// (SERIAL_SCULPT_COMMANDS in the bridge).
// ---------------------------------------------------------------------------

import { useStore } from '../../store/useStore';
import { SCULPT_BASES, MAX_SCULPT_SIZE, MIN_SCULPT_SIZE, type SculptBaseId } from '../../utils/sculptBases';
import { toSceneGeom, type BrushType } from '../../utils/sculptMesh';
import {
  applySculptStroke, probeSurface, sculptSummary, undoSculptStroke, BRUSH_TYPES,
} from '../../utils/sculptCommands';
import { cutSculptOffThread } from '../../utils/sculptCutClient';
import type { CarveProfile } from '../../utils/sculptCarve';
import { getNodeWorldPos } from '../../utils/sceneTree';
import { restingPos } from '../../utils/spawnPlacement';
import { viewCentre } from '../../utils/liveCamera';
import type { SculptUndoEntry } from '../../utils/sculptMesh';
import { collectNodeIds, waitForNewNode, type Msg, pointList, resolveParent, findNodeInScene } from './bridgeUtils';
import { sculptHistory, SCULPT_HISTORY_DEPTH, sculptMeshOf, applySculptCutResult, sculptTarget } from './sculptState';
import type { McpCommands } from './types';

export const sculptCommands: McpCommands = {
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
  CREATE_SCULPT: async (msg, { store }) => {
    const { name, base, pos, sizeMm } = msg as Msg<{ name?: string; base?: SculptBaseId; sizeMm?: number }>;
    if (sizeMm !== undefined && !(typeof sizeMm === 'number' && sizeMm > 0)) throw new Error('sizeMm must be a positive number of millimetres');
    const parent = resolveParent(store.sceneGraph.nodes, msg.parent);
    const given = Array.isArray(pos) && pos.length === 3;
    // With no pos, it stands on the floor at the middle of the view, as the
    // palette places one. The old default, 0.3 m up, was above the default
    // view: all a caller saw of the new body was its shadow.
    const position = given ? pos : [0, 0, 0];
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
    store.addComponent('sculpt', position.map((v: number, i: number) => v + parentWorld[i]), parent?.id ?? null, { exact: true });

    const created = await waitForNewNode(before, 10000);
    if (!created) throw new Error('The sculpt body was not created (timed out waiting for the scene to settle)');

    // Nested, it is fixed rigidly to its parent, like any body added
    // under one over MCP; the editor's own adds give a child a hinge.
    if (parent) store.updateNodeJointsList(created.id, []);
    if (base && base !== created.sculptBase) store.setSculptBase(created.id, base);
    if (sizeMm !== undefined) useStore.getState().resizeSculpt(created.id, sizeMm / 1000);
    if (typeof name === 'string' && name.trim()) store.renameNode(created.id, name.trim());
    // Placed once base and size are known, since both change its bounds.
    if (!given && !parent) {
      const nodes = useStore.getState().sceneGraph.nodes;
      const self = findNodeInScene(nodes, created.id);
      if (self) {
        const at = restingPos(self, nodes.filter((n) => n.id !== created.id), viewCentre());
        useStore.getState().updateNodePos(created.id, at as [number, number, number]);
      }
    }

    const after = findNodeInScene(useStore.getState().sceneGraph.nodes, created.id);
    return {
      ok: true,
      id: created.id,
      name: after?.name,
      pos: after?.pos,
      ...(parent ? { parent: parent.id } : {}),
      base: after?.sculptBase,
      ...sculptSummary(sculptMeshOf(after)),
    };
  },
  SET_SCULPT_BASE: async (msg, { store }) => {
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
  },
  RESIZE_SCULPT: async (msg, { store }) => {
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
  },
  SCULPT: async (msg, { store }) => {
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
    const perStroke: { brush?: string; applied: number; missed: number; moved: number; topologyChanged?: boolean }[] = [];

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
      perStroke.push({
        brush: s.brush ?? 'draw',
        applied: Number(lastResult.applied ?? 0),
        missed: Array.isArray(lastResult.missed) ? lastResult.missed.length : 0,
        moved: lastResult.moved ?? 0,
        ...(lastResult.topologyChanged ? { topologyChanged: true } : {}),
      });

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
    // A batch reports each stroke and their totals. It used to spread the
    // LAST stroke's applied/missed/moved over the whole reply beside a
    // total of its own, and the two never agreed.
    const batch = strokeList.length > 1;
    const { applied: _a, missed: _m, moved: _v, maxDisplacement: _d, topologyChanged: _t, ...meshFields } = lastResult ?? ({} as Partial<ReturnType<typeof applySculptStroke>>);
    return {
      ok: !error, ...(error ? { error } : {}), id: targetId,
      ...(batch ? meshFields : lastResult ?? {}),
      ...(batch ? {
        strokesApplied: strokeList.length,
        dabsApplied: perStroke.reduce((n, r) => n + r.applied, 0),
        pointsMissed: perStroke.reduce((n, r) => n + r.missed, 0),
        strokes: perStroke,
      } : {}),
      undoDepth: (sculptHistory.get(targetId) ?? []).length,
    };
  },
  UNDO_SCULPT: async (msg, { store }) => {
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
  },
  /*
    The scissors, without a screen: a polygon in the body's own frame,
    swept through the whole body along `direction` (default: the
    polygon's own normal) and taken out — or, with mode 'keep', kept and
    everything else taken out. `cap: false` leaves the cut open.
  
    Runs in the scissors' worker, so a cut of a dense sculpt does not
    stall the page, and is one entry in the same history UNDO_SCULPT
    pops.
  */
  SCULPT_CUT: async (msg, { store }) => {
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
  },
  SCULPT_CARVE: async (msg, { store }) => {
    const { targetId, path, widthMm, depthMm, profile = 'round', symmetry, fill, taper, angleDeg, mode = 'cut', thicknessMm, flatAxis = 'z' } = msg as Msg<{
      targetId: string; path: number[][]; widthMm: number; depthMm?: number;
      profile?: CarveProfile; symmetry?: 'x' | 'y' | 'z'; fill?: boolean;
      taper?: number; angleDeg?: number; mode?: 'cut' | 'add';
      thicknessMm?: number; flatAxis?: 'x' | 'y' | 'z';
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
    if (thicknessMm !== undefined && (!add || !(thicknessMm > 0 && thicknessMm <= widthMm))) {
      throw new Error("thicknessMm is for mode 'add': the tube's thickness across flatAxis, more than 0 and at most widthMm");
    }
    if (!['x', 'y', 'z'].includes(flatAxis)) throw new Error("flatAxis must be 'x', 'y' or 'z'");

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
      ...(thicknessMm !== undefined && thicknessMm < widthMm
        ? { flatten: { normal: [flatAxis === 'x' ? 1 : 0, flatAxis === 'y' ? 1 : 0, flatAxis === 'z' ? 1 : 0], ratio: thicknessMm / widthMm } }
        : {}),
      add,
    }, { mode: add ? 'add' : 'remove', cap: true });
    return applySculptCutResult(targetId, geomIndex, geomBefore, mesh, result, { add });
  },
  PROBE_SCULPT: async (msg, { store }) => {
    const { targetId, at } = msg as Msg<{ targetId: string }>;
    const { node, geomIndex } = sculptTarget(store, targetId);
    const points: number[][] = pointList(at);
    if (!points.length || points.some((p: unknown) => !Array.isArray(p) || p.length < 3)) {
      throw new Error("at must be [x, y, z] or a list of them, in the body's own frame (metres)");
    }
    return { ok: true, id: targetId, points: probeSurface(sculptMeshOf(node, geomIndex), points) };
  },
  GET_SCULPT: async (msg, { store }) => {
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
  },
};
