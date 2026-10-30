// ---------------------------------------------------------------------------
// MCP commands that edit bodies: add, update, delete, colour and paint,
// constraints, cuts, rounded edges, hardware, patterns, the knife
// ---------------------------------------------------------------------------

import { scriptSyntaxError, scriptWarnings } from '../../utils/scriptCheck';
import { useStore, getPhysicsWorkerClient } from '../../store/useStore';
import { freeJointPose, touchesPose } from '../../utils/livePose';
import { compileSCAD } from '../../utils/openscad';
import { updateOrCreateNotecard } from '../../utils/noteCards';
import { compileCsgNodes } from '../useCsgCompile';
import { cutAlongPlaneOffThread } from '../../utils/printSplitClient';
import { runMcpRepairMesh } from '../../utils/meshRepair';
import { patternSurfaces } from '../../utils/facePatternPick';
import { carryAcrossCut, knifeSoups, seamsAcross } from '../../utils/knife';
import { splitSeams } from '../../utils/surfaceTexture';
import { Vector3 } from 'three';
import { checkIncomingBody } from '../../utils/incomingBodyCheck';
import type { SceneNode, SceneGeom, HardwarePartKind } from '../../types/scene';
import type { RawNode } from '../../utils/sceneNodes';
import { HARDWARE_PARTS } from '../../utils/hardwareParts';
import { withoutNulls } from '../../utils/withoutNulls';
import { jointAxisWarnings } from '../../utils/jointAxisCheck';
import {
  countBodies, collectNodeIds, type Msg, pointList, resolveParent, withChild, findNodeInScene,
} from './bridgeUtils';
import { sculptHistory } from './sculptState';
import {
  pendingDeclarativeOps, normalizeRgba, fillGeomDefaults, resolveUpdatedGeoms, resolveBreakFields,
  fillBodyDefaults,
} from './bodyDefaults';
import {
  movingPieceOf, sealCheckFor, applySingleCutToBody, applyRoundEdgesToBody,
  applySinglePatternToBody, applyPaintStrokeToBody, applyDeclarativePreCsgFeatures,
  applyDeclarativePostCsgFeatures,
} from './bodyFeatures';
import { autoCompileScad } from './settleScene';
import type { McpCommands } from './types';
import { unresolvedReferences, unresolvedReferenceWarnings } from '../../utils/unresolvedReferences';

/**
 * Puts a free body where its document now says, in the running simulation too,
 * as the editor's own position fields and gizmos do (utils/livePose.ts). The
 * rebuild that follows carries qpos across, so without this the body stayed
 * at its old pose until Reset, paused or not.
 */
function syncFreeJointToDocument(id: string) {
  const nodes = useStore.getState().sceneGraph.nodes;
  const node = findNodeInScene(nodes, id);
  const pose = freeJointPose(node, nodes.some((n) => n.id === id));
  if (pose) getPhysicsWorkerClient().setQpos(pose.joint, 0, pose.qpos);
}

export const objectCommands: McpCommands = {
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
  ADD_OBJECT: async (msg, { store }) => {
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
    // Read before the store drops them: a typo in a target id did nothing, ok:true.
    const referenceWarnings = unresolvedReferenceWarnings(unresolvedReferences(nodes, new Set([node.id])));
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
    // Applied either way; a script that does not compile is said so here.
    const added = scriptWarnings(landed ? [landed] : [node]);
    const axes = jointAxisWarnings(landed ? [landed] : [node]);
    return {
      ok: !addError && !!landed,
      ...(addError ? { error: addError } : {}),
      ...(added.length ? { scriptWarnings: added } : {}),
      ...(referenceWarnings.length ? { referenceWarnings } : {}),
      ...(axes.length ? { warnings: axes } : {}),
      id: node.id,
      name: landed?.name ?? node.name,
      ...(parent ? { parent: parent.id } : {}),
      nodeCount: countBodies(useStore.getState().sceneGraph.nodes),
      topLevelCount: useStore.getState().sceneGraph.nodes.length,
    };
  },
  UPDATE_OBJECT: async (msg, { store }) => {
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

    // Extract declarative feature arrays if passed in updates. A null field
    // removes it from the body (and, in a geom or joint, from that).
    const updates = { ...rawUpdates };
    // A body cannot be without an id, a name or a place, so a null there is ignored.
    for (const k of Object.keys(updates)) {
      if (updates[k] !== null) continue;
      if (k === 'id' || k === 'name' || k === 'pos') delete updates[k];
      else updates[k] = undefined;
    }
    if (Array.isArray(updates.joints)) updates.joints = updates.joints.map((j) => withoutNulls(j));
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

    // A geom type, coordinate or size MuJoCo would refuse with an XML line
    // number is refused here, by name, before the body is touched.
    const next = { ...target, ...updates } as SceneNode;
    try {
      checkIncomingBody(next, (next.joints || []).length > 0);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    // Read before the store drops them: a typo in a target id did nothing, ok:true.
    const replaced = (list: SceneNode[]): SceneNode[] =>
      list.map((n) => (n.id === targetId ? next : { ...n, children: replaced(n.children || []) }));
    const referenceWarnings = unresolvedReferenceWarnings(unresolvedReferences(replaced(store.sceneGraph.nodes), new Set([targetId])));

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
      if (touchesPose(rest)) syncFreeJointToDocument(targetId);
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
        if (touchesPose(updates)) syncFreeJointToDocument(targetId);
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
    // A script is applied even when it does not compile; the reply says so.
    const scriptError = typeof rawUpdates.script === 'string' ? scriptSyntaxError(rawUpdates.script) : null;
    // Only when the joints were sent: a body already warned about is not warned again on every edit.
    const updated = Array.isArray(rawUpdates.joints) ? findNodeInScene(useStore.getState().sceneGraph.nodes, targetId) : null;
    const axes = updated ? jointAxisWarnings([{ ...updated, children: [] }]) : [];
    // Says what was taken, so a caller can see its whole update landed.
    return {
      ok: !error, applied: Object.keys(rawUpdates), ...(error ? { error } : {}),
      ...(referenceWarnings.length ? { referenceWarnings } : {}),
      ...(axes.length ? { warnings: axes } : {}),
      ...(scriptError ? { scriptWarnings: [`Script on '${target.name || targetId}' does not compile: ${scriptError}. It was saved as written and will do nothing until fixed.`] } : {}),
    };
  },
  DELETE_OBJECT: async (msg, { store }) => {
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
  },
  SET_COLOR: async (msg, { store }) => {
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
  },
  PAINT: async (msg) => {
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
  },
  CLEAR_PAINT: async (msg, { store }) => {
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
  },
    /*
     * Weld one body to another, and say what it takes to shear the weld off.
     *
     * Both halves were reachable only from here before the Constraints panel
     * existed, and the thresholds are new. Nothing set here reaches the
     * emitted MJCF: a weld's limit is checked every step against the force
     * MuJoCo reports for holding it, so it costs nothing until it trips.
     */
  SET_CONSTRAINT: async (msg, { store }) => {
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
  },
  COMBINE_BODIES: async (msg, { store }) => {
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
  },
  ROUND_EDGES: async (msg) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { targetId, roundings } = msg as Msg<{ targetId: string; roundings?: Record<string, any>[] }>;
    const specs = Array.isArray(roundings) && roundings.length > 0 ? roundings : [msg];
    return await applyRoundEdgesToBody(targetId, specs, true);
  },
  BODY_CUT: async (msg, { store }) => {
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
  },
  ADD_HARDWARE: async (msg, { store }) => {
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
      const placed = Array.isArray(at) && at.length >= 3;
      const pos = placed ? at.map((v) => v / 1000) : [0, 0, 0.03];
      // `at` is where it goes, exactly; `into` a body with no cut for it
      // fixes it there (a stepper bolted to its frame).
      id = store.addHardwarePart(partKind, pos, into ?? null, { exact: placed, mount: !!into });
    }
    if (!id) return { ok: false, error: 'The part could not be added' };
    // Sized before anything is fixed to it: fixed first, a body rode the
    // default size's moving piece where the new size's no longer was.
    if (!joinKind && kind !== 'vslot_carriage' && (size !== undefined || lengthMm !== undefined || washer !== undefined)) {
      useStore.getState().setHardwarePart(id, {
        ...(size !== undefined ? { size: String(size) } : {}),
        ...(typeof lengthMm === 'number' ? { lengthMm } : {}),
        ...(typeof washer === 'boolean' ? { washer } : {}),
      });
    }
    if (fixTo) {
      const added = findNodeInScene(useStore.getState().sceneGraph.nodes, id);
      const piece = added && movingPieceOf(added);
      const why = piece ? useStore.getState().fixToPiece(piece.id, fixTo) : `A ${info.label.toLowerCase()} has no moving piece to fix a body to`;
      if (why) return { ok: false, error: why, id };
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
        ? { [spec.kind === 'stepper' ? 'shaftId' : 'innerRaceId']: part.children.find((c) => c.hardwarePart?.piece === 'inner')!.id } : {}),
      ...(part.children.some((c) => c.hardwarePart?.piece === 'carriage')
        ? { carriageId: part.children.find((c) => c.hardwarePart?.piece === 'carriage')!.id } : {}),
      posMm: part.pos.map((v) => Math.round(v * 1e6) / 1000),
      ...(spec.kind === 'oring' && into && spec.seat ? { sealCheck: sealCheckFor(useStore.getState().sceneGraph, into, spec.seat) } : {}),
    };
  },
  APPLY_PATTERN: async (msg) => {
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
  },
  KNIFE: async (msg, { store }) => {
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
  },
  REPAIR_MESH: async (msg, { store, toId }) => {
    return runMcpRepairMesh({
      msg,
      toId: (s) => toId(s) as string,
      nodes: store.sceneGraph.nodes,
      findNodeInScene,
      updateNode: (nodeId, patch) => useStore.getState().updateNode(nodeId, patch),
      compileCsgNodes,
    });
  },
};
