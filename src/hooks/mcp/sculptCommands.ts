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
    const minMm = MIN_SCULPT_SIZE * 1000;
    const maxMm = MAX_SCULPT_SIZE * 1000;
    if (sizeMm !== undefined && !(typeof sizeMm === 'number' && Number.isFinite(sizeMm) && sizeMm >= minMm && sizeMm <= maxMm)) {
      throw new Error(`sizeMm must be between ${minMm} and ${maxMm} millimetres`);
    }
    const parent = resolveParent(store.sceneGraph.nodes, msg.parent);
    const given = pos !== undefined;
    if (given) {
      if (!Array.isArray(pos) || pos.length !== 3 || pos.some((v: unknown) => typeof v !== 'number' || !Number.isFinite(v))) {
        throw new Error('pos must be [x, y, z] finite numbers in metres');
      }
    }
    // With no pos, it stands on the floor at the middle of the view, as the
    // palette places one. The old default, 0.3 m up, was above the default
    // view: all a caller saw of the new body was its shadow.
    const position = given ? (pos as number[]) : [0, 0, 0];
    if (base !== undefined && !SCULPT_BASES.some(b => b.id === base)) {
      throw new Error(`Unknown base '${base}'. Available: ${SCULPT_BASES.map(b => b.id).join(', ')}`);
    }
    const before = collectNodeIds(store.sceneGraph.nodes);
    // Under the `parent` asked for, or at the top level - never under
    // whatever happens to be selected. addComponent takes a world
    // position, and `pos` here is relative to the parent, as everywhere
    // else in the scene graph.
    const parentWorld = parent ? getNodeWorldPos(store.sceneGraph.nodes, parent.id) ?? [0, 0, 0] : [0, 0, 0];
    const addedId = store.addComponent('sculpt', position.map((v: number, i: number) => v + parentWorld[i]), parent?.id ?? null, { exact: true });

    const created = (typeof addedId === 'string' ? findNodeInScene(useStore.getState().sceneGraph.nodes, addedId) : null)
      ?? await waitForNewNode(before, 10000);
    if (!created) throw new Error('The sculpt body was not created (timed out waiting for the scene to settle)');

    // Nested, it is fixed rigidly to its parent, like any body added
    // under one over MCP; the editor's own adds give a child a hinge.
    if (parent) useStore.getState().updateNodeJointsList(created.id, []);
    if (base && base !== created.sculptBase) useStore.getState().setSculptBase(created.id, base);
    if (sizeMm !== undefined) useStore.getState().resizeSculpt(created.id, sizeMm / 1000);
    if (typeof name === 'string' && name.trim()) useStore.getState().renameNode(created.id, name.trim());
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

    // Wholesale replacement: whatever was sculpted is discarded, including any
    // delta undo entries keyed to the previous base's vertex indices.
    store.setSculptBase(targetId, base);
    sculptHistory.delete(targetId);
    const after = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId);
    return { ok: true, id: targetId, base, ...sculptSummary(sculptMeshOf(after)), undoDepth: 0 };
  },
  RESIZE_SCULPT: async (msg, { store }) => {
    const { targetId, sizeMm } = msg as Msg<{ targetId: string; sizeMm: number | (number | null)[] }>;
    if (!targetId) throw new Error('Missing targetId');
    const node = findNodeInScene(store.sceneGraph.nodes, targetId);
    if (!node) throw new Error(`No object with id '${targetId}'`);
    if (!node.isSculpt) throw new Error(`'${targetId}' is not a sculpt body`);
    const limits = [MIN_SCULPT_SIZE * 1000, MAX_SCULPT_SIZE * 1000];
    const valid = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= limits[0] && v <= limits[1];
    // A number is the longest side; [width, depth, height] sizes each
    // axis, a null keeping that one as it is.
    if (Array.isArray(sizeMm)) {
      if (sizeMm.length !== 3 || sizeMm.some((v) => v !== null && !valid(v))) {
        throw new Error(`sizeMm as a list is [width, depth, height] in mm, each ${limits[0]} to ${limits[1]} or null`);
      }
      if (sizeMm.every((v) => v === null)) {
        throw new Error('sizeMm must specify at least one axis (cannot be [null, null, null])');
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
    const { targetId, brush, at, atMm, radius, radiusMm, strength, invert, symmetryX, symmetry, detail, dynamicTopology, delta, depthMm, hardness, strokes } =
      msg as Msg<{
        targetId: string; brush?: BrushType; atMm?: unknown; radius?: number; radiusMm?: number; strength?: number;
        depthMm?: number; hardness?: number;
        invert?: boolean; symmetryX?: boolean; symmetry?: 'x' | 'y' | 'z';
        detail?: number; dynamicTopology?: boolean; delta?: number[];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        strokes?: Record<string, any>[];
      }>;
    const { node, geomIndex } = sculptTarget(store, targetId);

    if (strokes !== undefined) {
      if (!Array.isArray(strokes) || strokes.length === 0) {
        throw new Error('strokes must be a non-empty array of stroke objects');
      }
    }
    const strokeList = strokes !== undefined
      ? strokes
      : [{ brush, at, atMm, radius, radiusMm, strength, invert, symmetryX, symmetry, detail, dynamicTopology, delta, depthMm, hardness }];

    const isFiniteVec3 = (p: unknown): p is number[] =>
      Array.isArray(p) && p.length >= 3 &&
      typeof p[0] === 'number' && typeof p[1] === 'number' && typeof p[2] === 'number' &&
      Number.isFinite(p[0] + p[1] + p[2]);

    // Validate ALL strokes upfront before mutating mesh or sculptHistory.
    const validatedStrokes: { spec: Record<string, unknown>; points: number[][]; resolvedRadius?: number }[] = [];
    for (const s of strokeList) {
      if (!s || typeof s !== 'object' || Array.isArray(s)) {
        throw new Error('Each stroke must be an object');
      }
      if (s.brush !== undefined && (typeof s.brush !== 'string' || !BRUSH_TYPES.includes(s.brush as BrushType))) {
        throw new Error(`Unknown brush '${s.brush}'. Available: ${BRUSH_TYPES.join(', ')}`);
      }
      const points: number[][] = s.at !== undefined
        ? pointList(s.at)
        : s.atMm !== undefined
          ? pointList(s.atMm).map((p) => (isFiniteVec3(p) ? [p[0] / 1000, p[1] / 1000, p[2] / 1000] : p))
          : [];
      if (!points.length || points.some((p: unknown) => !isFiniteVec3(p))) {
        throw new Error("at must be [x, y, z] or a list of them, in the body's own frame in metres (or pass atMm in millimetres)");
      }
      if (s.delta !== undefined && !isFiniteVec3(s.delta)) {
        throw new Error('delta must be [dx, dy, dz] finite numbers in metres');
      }
      if (s.radius !== undefined && !(typeof s.radius === 'number' && Number.isFinite(s.radius) && s.radius > 0)) {
        throw new Error('radius must be a positive number in metres');
      }
      if (s.radiusMm !== undefined && !(typeof s.radiusMm === 'number' && Number.isFinite(s.radiusMm) && s.radiusMm > 0)) {
        throw new Error('radiusMm must be a positive number in millimetres');
      }
      const resolvedRadius = typeof s.radius === 'number'
        ? s.radius
        : typeof s.radiusMm === 'number'
          ? s.radiusMm / 1000
          : undefined;
      if (s.strength !== undefined && !(typeof s.strength === 'number' && Number.isFinite(s.strength) && s.strength >= 0 && s.strength <= 1)) {
        throw new Error('strength must be a finite number between 0 and 1');
      }
      if (s.detail !== undefined && !(typeof s.detail === 'number' && Number.isFinite(s.detail) && s.detail > 0)) {
        throw new Error('detail must be a positive number');
      }
      if (s.depthMm !== undefined && !(typeof s.depthMm === 'number' && Number.isFinite(s.depthMm) && s.depthMm >= 0)) {
        throw new Error('depthMm must be a non-negative number of millimetres');
      }
      if (s.hardness !== undefined && !(typeof s.hardness === 'number' && Number.isFinite(s.hardness) && s.hardness >= 0 && s.hardness <= 1)) {
        throw new Error('hardness must be a finite number between 0 and 1');
      }
      if (s.symmetry !== undefined && s.symmetry !== 'x' && s.symmetry !== 'y' && s.symmetry !== 'z') {
        throw new Error("symmetry must be 'x', 'y' or 'z'");
      }
      validatedStrokes.push({ spec: s, points, resolvedRadius });
    }

    const mesh = sculptMeshOf(node, geomIndex);
    let lastResult: ReturnType<typeof applySculptStroke> | null = null;
    const perStroke: { brush?: string; applied: number; missed: number; moved: number; maxDisplacement: number; topologyChanged?: boolean }[] = [];
    const pendingUndos: SculptUndoEntry[] = [];

    for (const { spec: s, points, resolvedRadius } of validatedStrokes) {
      const sink: { undo?: SculptUndoEntry | null } = {};
      lastResult = applySculptStroke(mesh, {
        brush: s.brush as BrushType | undefined,
        at: points,
        radius: resolvedRadius,
        strength: s.strength as number | undefined,
        invert: s.invert as boolean | undefined,
        symmetryX: s.symmetryX as boolean | undefined,
        symmetry: s.symmetry as 'x' | 'y' | 'z' | undefined,
        detail: s.detail as number | undefined,
        dynamicTopology: s.dynamicTopology as boolean | undefined,
        delta: s.delta as number[] | undefined,
        depthMm: s.depthMm as number | undefined,
        hardness: s.hardness as number | undefined,
      }, sink);
      perStroke.push({
        brush: (s.brush as string | undefined) ?? 'draw',
        applied: Number(lastResult.applied ?? 0),
        missed: Array.isArray(lastResult.missed) ? lastResult.missed.length : 0,
        moved: lastResult.moved ?? 0,
        maxDisplacement: lastResult.maxDisplacement,
        ...(lastResult.topologyChanged ? { topologyChanged: true } : {}),
      });

      if (sink.undo) pendingUndos.push(sink.undo);
    }

    /*
      Metadata and geometry coalesced into a single 'node-geom' undo entry
      and a single structural recompile.
    */
    store.recordInteraction('node-geom');
    store.updateNode(targetId, {
      sculptEdited: true,
      sculptVersion: (node.sculptVersion ?? 1) + 1,
    }, true);
    const { vertices, renderVertices, faces } = toSceneGeom(mesh);
    store.updateNodeGeom(targetId, { vertices, renderVertices, faces }, geomIndex);

    if (pendingUndos.length > 0) {
      const stack = sculptHistory.get(targetId) ?? [];
      for (const entry of pendingUndos) {
        stack.push(entry);
        while (stack.length > SCULPT_HISTORY_DEPTH) stack.shift();
      }
      sculptHistory.set(targetId, stack);
    }

    // A batch reports each stroke and their totals. It used to spread the
    // LAST stroke's applied/missed/moved over the whole reply beside a
    // total of its own, and the two never agreed.
    const batch = validatedStrokes.length > 1;
    const { applied: _a, missed: _m, moved: _v, maxDisplacement: _d, topologyChanged: _t, ...meshFields } = lastResult ?? ({} as Partial<ReturnType<typeof applySculptStroke>>);
    return {
      ok: true, id: targetId,
      ...(batch ? meshFields : lastResult ?? {}),
      ...(batch ? {
        strokesApplied: validatedStrokes.length,
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
    store.recordInteraction('node-geom');
    store.updateNode(targetId, { sculptVersion: (node.sculptVersion ?? 1) + 1 }, true);
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
    const {
      targetId, polygon, direction, mode, cap,
      depthMm, wallMm, floorMm, radiusMm, center, segments,
    } = msg as Msg<{
      targetId: string; polygon?: number[][]; direction?: number[]; mode?: 'remove' | 'keep' | 'hollow'; cap?: boolean;
      depthMm?: number; wallMm?: number; floorMm?: number; radiusMm?: number; center?: number[]; segments?: number;
    }>;
    const { node, geomIndex } = sculptTarget(store, targetId);
    const isFiniteVec3 = (p: unknown): p is number[] =>
      Array.isArray(p) && p.length >= 3 &&
      typeof p[0] === 'number' && typeof p[1] === 'number' && typeof p[2] === 'number' &&
      Number.isFinite(p[0] + p[1] + p[2]);
    const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    if (mode !== undefined && mode !== 'remove' && mode !== 'keep' && mode !== 'hollow') {
      throw new Error("mode must be 'remove' (take the prism out), 'keep' (keep only the prism), or 'hollow' (fast vertical flat-bottomed cavity)");
    }
    if (depthMm !== undefined && (!isFiniteNum(depthMm) || depthMm <= 0)) {
      throw new Error('depthMm must be a positive finite number of millimetres');
    }

    const geomBefore = node.geoms?.[geomIndex];
    const mesh = sculptMeshOf(node, geomIndex);

    if (mode === 'hollow') {
      if (wallMm !== undefined && (!isFiniteNum(wallMm) || wallMm <= 0)) {
        throw new Error('wallMm must be a positive finite number of millimetres');
      }
      if (floorMm !== undefined && (!isFiniteNum(floorMm) || floorMm < 0)) {
        throw new Error('floorMm must be a non-negative finite number of millimetres');
      }
      if (radiusMm !== undefined && (!isFiniteNum(radiusMm) || radiusMm <= 0)) {
        throw new Error('radiusMm must be a positive finite number of millimetres');
      }
      if (center !== undefined && (!Array.isArray(center) || center.length < 2 || !isFiniteNum(center[0]) || !isFiniteNum(center[1]))) {
        throw new Error("center must be [x, y] finite numbers in the body's own frame (metres)");
      }
      if (polygon !== undefined && (!Array.isArray(polygon) || polygon.length < 3 || polygon.some((p: unknown) => !Array.isArray(p) || p.length < 2 || !isFiniteNum(p[0]) || !isFiniteNum(p[1])))) {
        throw new Error("polygon must be three or more [x, y] or [x, y, z] points in the body's own frame (metres)");
      }
      const result = await cutSculptOffThread(mesh, {
        kind: 'hollow',
        ...(wallMm !== undefined ? { wall: wallMm / 1000 } : {}),
        ...(floorMm !== undefined ? { floor: floorMm / 1000 } : {}),
        ...(radiusMm !== undefined ? { radius: radiusMm / 1000 } : {}),
        ...(depthMm !== undefined ? { depth: depthMm / 1000 } : {}),
        ...(center !== undefined ? { center: [center[0], center[1]] as [number, number] } : {}),
        ...(segments !== undefined && isFiniteNum(segments) ? { segments } : {}),
        ...(polygon !== undefined ? { polygon } : {}),
      }, { mode: 'remove', cap: true });
      return applySculptCutResult(targetId, geomIndex, geomBefore, mesh, result);
    }

    if (!Array.isArray(polygon) || polygon.length < 3 || polygon.some((p: unknown) => !isFiniteVec3(p))) {
      throw new Error("polygon must be three or more [x, y, z] points, in the body's own frame (metres)");
    }
    if (direction !== undefined && (!isFiniteVec3(direction) || Math.hypot(direction[0], direction[1], direction[2]) <= 1e-12)) {
      throw new Error('direction must be a non-zero [x, y, z] vector');
    }

    const result = await cutSculptOffThread(
      mesh,
      { kind: 'polygon', polygon, direction, ...(depthMm !== undefined ? { depth: depthMm / 1000 } : {}) },
      { mode, cap },
    );
    return applySculptCutResult(targetId, geomIndex, geomBefore, mesh, result);
  },
  SCULPT_CARVE: async (msg, { store }) => {
    const { targetId, path, pathMm, widthMm, depthMm, profile = 'round', symmetry, fill, taper, angleDeg, mode = 'cut', thicknessMm, flatAxis = 'z' } = msg as Msg<{
      targetId: string; path?: number[][]; pathMm?: number[][]; widthMm: number; depthMm?: number;
      profile?: CarveProfile; symmetry?: 'x' | 'y' | 'z'; fill?: boolean;
      taper?: number; angleDeg?: number; mode?: 'cut' | 'add';
      thicknessMm?: number; flatAxis?: 'x' | 'y' | 'z';
    }>;
    const { node, geomIndex } = sculptTarget(store, targetId);
    const isFiniteVec3 = (p: unknown): p is number[] =>
      Array.isArray(p) && p.length >= 3 &&
      typeof p[0] === 'number' && typeof p[1] === 'number' && typeof p[2] === 'number' &&
      Number.isFinite(p[0] + p[1] + p[2]);
    const points = path !== undefined
      ? pointList(path)
      : pathMm !== undefined
        ? pointList(pathMm).map((p) => (isFiniteVec3(p) ? [p[0] / 1000, p[1] / 1000, p[2] / 1000] : p))
        : [];
    if (!points.length || points.some((p: unknown) => !isFiniteVec3(p))) {
      throw new Error("path must be [x, y, z] or a list of them, in the body's own frame in metres (or pass pathMm in millimetres)");
    }
    if (mode !== 'cut' && mode !== 'add') throw new Error("mode must be 'cut' or 'add'");
    const add = mode === 'add';
    if (
      !(typeof widthMm === 'number' && Number.isFinite(widthMm) && widthMm > 0) ||
      (depthMm !== undefined && !(typeof depthMm === 'number' && Number.isFinite(depthMm))) ||
      (!add && !((depthMm ?? 0) > 0))
    ) {
      throw new Error('widthMm and depthMm must be positive millimetres');
    }
    if (!['round', 'v', 'flat'].includes(profile)) throw new Error("profile must be 'round', 'v' or 'flat'");
    if (symmetry !== undefined && !['x', 'y', 'z'].includes(symmetry)) throw new Error("symmetry must be 'x', 'y' or 'z'");
    if (taper !== undefined && !(typeof taper === 'number' && Number.isFinite(taper) && taper >= 0 && taper <= 0.5)) {
      throw new Error('taper is the share of the length at each end, 0 to 0.5');
    }
    if (angleDeg !== undefined && !(typeof angleDeg === 'number' && Number.isFinite(angleDeg))) {
      throw new Error('angleDeg must be a finite number of degrees');
    }
    if (thicknessMm !== undefined && (!add || !(typeof thicknessMm === 'number' && Number.isFinite(thicknessMm) && thicknessMm > 0 && thicknessMm <= widthMm))) {
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
    const { targetId, at, atMm } = msg as Msg<{ targetId: string; atMm?: unknown }>;
    const { node, geomIndex } = sculptTarget(store, targetId);
    const isFiniteVec3 = (p: unknown): p is number[] =>
      Array.isArray(p) && p.length >= 3 &&
      typeof p[0] === 'number' && typeof p[1] === 'number' && typeof p[2] === 'number' &&
      Number.isFinite(p[0] + p[1] + p[2]);
    const points: number[][] = at !== undefined
      ? pointList(at)
      : atMm !== undefined
        ? pointList(atMm).map((p) => (isFiniteVec3(p) ? [p[0] / 1000, p[1] / 1000, p[2] / 1000] : p))
        : [];
    if (!points.length || points.some((p: unknown) => !isFiniteVec3(p))) {
      throw new Error("at must be [x, y, z] or a list of them, in the body's own frame in metres (or pass atMm in millimetres)");
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
