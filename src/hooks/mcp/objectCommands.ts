// ---------------------------------------------------------------------------
// MCP commands that edit bodies: add, update, delete, colour and paint,
// constraints, cuts, rounded edges, hardware, patterns, the knife
// ---------------------------------------------------------------------------

import { clothNamesIn, clothWarningsFor } from '../../store/clothStatus';
import { scriptSyntaxError, scriptWarnings } from '../../utils/scriptCheck';
import { useStore, getPhysicsWorkerClient } from '../../store/useStore';
import { framingPatch } from '../../store/sceneFraming';
import { freeJointPose, touchesPose } from '../../utils/livePose';
import { compileSCAD } from '../../utils/openscad';
import { updateOrCreateNotecard } from '../../utils/noteCards';
import { compileCsgNodes } from '../useCsgCompile';
import { cutAlongPlaneOffThread } from '../../utils/printSplitClient';
import { runMcpRepairMesh } from '../../utils/meshRepair';
import { patternSurfaces } from '../../utils/facePatternPick';
import { carryAcrossCut, knifeSoups, seamsAcross } from '../../utils/knife';
import { splitSeams } from '../../utils/surfaceTexture';
import { Quaternion, Vector3 } from 'three';
import { checkIncomingBody, normalizeAcousticFields } from '../../utils/incomingBodyCheck';
import type { SceneNode, SceneGeom, SceneJoint, HardwarePartKind } from '../../types/scene';
import type { RawNode } from '../../utils/sceneNodes';
import { HARDWARE_PARTS, documentWorldMatrix, quietHardwarePart, seatFor, sharedSeamPoint } from '../../utils/hardwareParts';
import { withoutNulls } from '../../utils/withoutNulls';
import { jointAxisWarnings } from '../../utils/jointAxisCheck';
import {
  generateCurveGeoms, DEFAULT_CURVE_POINTS, DEFAULT_CURVE_WIDTH,
  DEFAULT_CURVE_THICKNESS, DEFAULT_CURVE_SEGMENTS,
} from '../../utils/geom';
import {
  countBodies, collectNodeIds, type Msg, pointList, resolveParent, withChild, findNodeInScene,
  isPlainObject, isFiniteNumber, isFiniteVec3,
} from './bridgeUtils';
import { sculptHistory } from './sculptState';
import {
  normalizeRgba, fillGeomDefaults, fillJointDefaults, resolveUpdatedGeoms, resolveBreakFields,
  fillBodyDefaults, parseTuneTo, applyTuneTo, applyPendingTuneTo, type PendingDeclarativeOps,
} from './bodyDefaults';
import {
  movingPieceOf, sealCheckFor, applySingleCutToBody, applyRoundEdgesToBody,
  applySinglePatternToBody, applyPaintStrokeToBody, applyDeclarativePreCsgFeatures,
  applyDeclarativePostCsgFeatures,
} from './bodyFeatures';
import { autoCompileScad, scadFailureError } from './settleScene';
import type { McpCommands } from './types';
import { unresolvedReferences, unresolvedReferenceWarnings } from '../../utils/unresolvedReferences';
import { applyFlexureToNode, revertFlexure, validateFlexureInput, type FlexureDesignInput } from '../../utils/flexure';

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

/** Acoustic fields a body update is checked for (utils/incomingBodyCheck.ts normalizeAcousticFields). */
const SPEC_FIELDS = ['acousticString', 'windInstrument', 'acousticMembrane', 'nonlinearPlate', 'resonatorTube', 'acousticBow'] as const;
const ACOUSTIC_FIELDS = ['deformMaterial', ...SPEC_FIELDS];
const CURVE_FIELDS = ['isCurve', 'curvePoints', 'curveWidth', 'curveThickness', 'curveSegments', 'curveClosed', 'curveBank'] as const;

/** Deduplicates ids across an incoming raw body subtree against `taken` BEFORE fillBodyDefaults runs. */
function dedupeRawSubtree(raw: RawNode, taken: Set<string>): RawNode {
  if (!isPlainObject(raw)) return raw;
  const baseId = typeof raw.id === 'string' && raw.id ? raw.id : (typeof raw.name === 'string' && raw.name ? raw.name : undefined);
  let nextId = baseId;
  let renamed = false;
  if (baseId) {
    if (taken.has(baseId)) {
      let n = 2;
      while (taken.has(`${baseId}_${n}`)) n++;
      nextId = `${baseId}_${n}`;
      renamed = true;
    }
    taken.add(nextId!);
  }
  const children = Array.isArray(raw.children)
    ? raw.children.map((c) => dedupeRawSubtree(c as RawNode, taken))
    : raw.children;
  return {
    ...raw,
    ...(renamed ? { id: nextId, ...(!raw.name ? { name: nextId } : {}) } : {}),
    ...(children !== undefined ? { children } : {}),
  };
}

function isDescendantOf(ancestor: SceneNode, targetId: string): boolean {
  for (const child of ancestor.children || []) {
    if (child.id === targetId || isDescendantOf(child, targetId)) return true;
  }
  return false;
}

const COMBINE_OPS = new Set(['union', 'difference', 'subtract', 'intersection', 'intersect']);

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
    if (!isPlainObject(raw)) {
      return { ok: false, error: 'Missing body: pass one body descriptor, the same shape as an element of physics_build_scene\'s bodies array' };
    }
    const wasEmpty = (store.sceneGraph.nodes?.length ?? 0) === 0;
    let parent: { id: string; moves: boolean } | null;
    try {
      parent = resolveParent(store.sceneGraph.nodes, msg.parent);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    // Deduplicate the entire incoming subtree against existing scene IDs BEFORE
    // fillBodyDefaults runs so pending declarative ops and autoCompileScad keys
    // match the actual stored IDs (root AND children).
    const taken = collectNodeIds(store.sceneGraph.nodes);
    const dedupedRaw = dedupeRawSubtree(raw, taken);
    const opsMap = new Map<string, PendingDeclarativeOps>();
    let node: SceneNode;
    try {
      node = fillBodyDefaults(dedupedRaw, parent ? parent.moves : null, opsMap);
    } catch (err) {
      opsMap.clear();
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    // A string or head given a `tuneTo` is retuned now the scene is around it.
    let nodes: SceneNode[];
    try {
      nodes = applyPendingTuneTo(parent
        ? withChild(store.sceneGraph.nodes, parent.id, node)
        : [...store.sceneGraph.nodes, node]);
    } catch (err) {
      opsMap.clear();
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    // Read before the store drops them: a typo in a target id did nothing, ok:true.
    const referenceWarnings = unresolvedReferenceWarnings(unresolvedReferences(nodes, new Set([node.id])));
    store.updateScene({ ...store.sceneGraph, nodes }, true);
    let scadErrors: Awaited<ReturnType<typeof autoCompileScad>>;
    try {
      scadErrors = await autoCompileScad([node]);
      await applyDeclarativePreCsgFeatures([node], opsMap);
      await compileCsgNodes(true);
      await applyDeclarativePostCsgFeatures([node], opsMap);
    } finally {
      opsMap.clear();
    }
    await useStore.getState().recompile(useStore.getState().sceneGraph, node.id, false, true);
    const compileError = useStore.getState().lastCompileError;
    const addError = [compileError, scadErrors.length ? scadFailureError(scadErrors) : null].filter(Boolean).join(' ') || null;
    const landed = findNodeInScene(useStore.getState().sceneGraph.nodes, node.id);
    if (landed?.csgError) {
      return { ok: false, error: `Boolean failed: ${landed.csgError}`, id: node.id };
    }
    // When adding the first body to an empty scene, frame the camera cleanly
    // around it (matching physics_build_scene) instead of leaving the viewport
    // wherever a previous scene left it.
    if (wasEmpty && landed) {
      const patch = framingPatch(useStore.getState().sceneGraph, null);
      if (patch.cameraOverride) useStore.setState(patch);
    }
    // Applied either way; a script that does not compile is said so here.
    const added = scriptWarnings(landed ? [landed] : [node]);
    const axes = jointAxisWarnings(landed ? [landed] : [node]);
    const cloth = clothWarningsFor(clothNamesIn([landed ?? node]));
    return {
      ok: !addError && !!landed,
      ...(addError ? { error: addError } : {}),
      ...(scadErrors.length ? { scadErrors } : {}),
      ...(added.length ? { scriptWarnings: added } : {}),
      ...(referenceWarnings.length ? { referenceWarnings } : {}),
      ...(axes.length ? { warnings: axes } : {}),
      ...(cloth.length ? { clothWarnings: cloth } : {}),
      id: node.id,
      name: landed?.name ?? node.name,
      ...(parent ? { parent: parent.id } : {}),
      nodeCount: countBodies(useStore.getState().sceneGraph.nodes),
      topLevelCount: useStore.getState().sceneGraph.nodes.length,
    };
  },
  UPDATE_OBJECT: async (msg, { store }) => {
    const requestedId = typeof msg.targetId === 'string' ? msg.targetId : '';
    if (!requestedId) return { ok: false, error: 'Missing object id' };
    if (!isPlainObject(msg.updates)) {
      return { ok: false, error: 'Missing or invalid updates payload (must be a plain object)' };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawUpdates = msg.updates as Partial<SceneNode> & Record<string, any>;
    // The store edits by id alone and ignores one it doesn't know, which
    // this handler then reported as ok:true.
    const target = findNodeInScene(store.sceneGraph.nodes, requestedId);
    if (!target) return { ok: false, error: `No object with id "${requestedId}"` };
    const targetId = target.id;

    if (rawUpdates.id !== undefined && rawUpdates.id !== null && rawUpdates.id !== targetId) {
      return { ok: false, error: 'Body id cannot be changed via update_object' };
    }

    // Extract declarative feature arrays if passed in updates. A null field
    // removes it from the body (and, in a geom or joint, from that).
    const updates = { ...rawUpdates };
    delete updates.id;
    // A body cannot be without an id, a name or a place, so a null there is ignored.
    for (const k of Object.keys(updates)) {
      if (updates[k] !== null) continue;
      if (k === 'id' || k === 'name' || k === 'pos') delete updates[k];
      else updates[k] = undefined;
    }
    if (updates.joints !== undefined) {
      if (!Array.isArray(updates.joints) || !updates.joints.every(isPlainObject)) {
        return { ok: false, error: 'joints must be an array of joint objects' };
      }
      const isTopLevel = store.sceneGraph.nodes.some((n) => n.id === targetId);
      const bodyName = typeof updates.name === 'string' ? updates.name : (target.name ?? targetId);
      const filledJoints: SceneJoint[] = updates.joints.map((j, i) => fillJointDefaults(j, bodyName, i));
      if (!isTopLevel && filledJoints.some((j) => j.type === 'free')) {
        return {
          ok: false,
          error: `Body '${bodyName}' sits inside another body and cannot have a free joint. Leave joints empty to fix it rigidly to its parent, or use a hinge or slide.`,
        };
      }
      updates.joints = filledJoints;
    }
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
    // Transient: a request to tune, not a field of the body.
    const tuneRaw = updates.tuneTo;
    const drillRaw = updates.drillNodalHole;
    const flexureTouched = 'flexure' in rawUpdates;
    const rawFlexure = rawUpdates.flexure;
    delete updates.flexure;
    delete updates.tuneTo;
    delete updates.drillNodalHole;
    delete updates.cuts;
    delete updates.roundEdges;
    delete updates.roundings;
    delete updates.patterns;
    delete updates.pattern;
    delete updates.paint;

    if (updates.rgba !== undefined) {
      const norm = normalizeRgba(updates.rgba);
      if (!norm) return { ok: false, error: 'rgba must be [r, g, b] or [r, g, b, a], each a finite number in 0..1' };
      updates.rgba = norm;
    }

    if (updates.geoms !== undefined) {
      if (!Array.isArray(updates.geoms)) {
        return { ok: false, error: 'geoms must be an array of geom descriptors' };
      }
      let geomResult: ReturnType<typeof resolveUpdatedGeoms>;
      try {
        geomResult = resolveUpdatedGeoms(target, updates.geoms, updates);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      if (!geomResult.ok) return { ok: false, error: geomResult.error };
      updates.geoms = geomResult.geoms;
      if (updates.geoms.some((g: SceneGeom) => g.csg === 'difference' || g.csg === 'intersection' || (g.type === 'cylinder' && (g.thread?.pitch ?? 0) > 0))) {
        updates.csgEnabled = true;
      }
    }

    // Regenerate curve segment boxes whenever any curve* field changes on an
    // isCurve body (or isCurve becomes true, or geoms: [] / rgba is updated).
    const willBeCurve = (updates.isCurve !== undefined ? updates.isCurve : target.isCurve) === true;
    const curveFieldTouched = CURVE_FIELDS.some((k) => k in rawUpdates);
    const explicitEmptyGeoms = Array.isArray(rawUpdates.geoms) && rawUpdates.geoms.length === 0;
    const explicitNonEmptyGeoms = Array.isArray(rawUpdates.geoms) && rawUpdates.geoms.length > 0;
    const rgbaTouched = 'rgba' in rawUpdates && updates.rgba !== undefined;
    if (willBeCurve) {
      const bodyLabel = typeof updates.name === 'string' ? updates.name : (target.name ?? targetId);
      if (updates.curveSegments !== undefined && (!isFiniteNumber(updates.curveSegments) || !Number.isInteger(updates.curveSegments) || updates.curveSegments < 1 || updates.curveSegments > 500)) {
        return { ok: false, error: `Body '${bodyLabel}': curveSegments must be an integer between 1 and 500.` };
      }
      if (updates.curveWidth !== undefined && (!isFiniteNumber(updates.curveWidth) || updates.curveWidth <= 0)) {
        return { ok: false, error: `Body '${bodyLabel}': curveWidth must be a positive finite number.` };
      }
      if (updates.curveThickness !== undefined && (!isFiniteNumber(updates.curveThickness) || updates.curveThickness <= 0)) {
        return { ok: false, error: `Body '${bodyLabel}': curveThickness must be a positive finite number.` };
      }
      if (updates.curveBank !== undefined && !isFiniteNumber(updates.curveBank)) {
        return { ok: false, error: `Body '${bodyLabel}': curveBank must be a finite number.` };
      }
      if (updates.curvePoints !== undefined) {
        if (!Array.isArray(updates.curvePoints) || updates.curvePoints.length < 2 || !updates.curvePoints.every(isFiniteVec3)) {
          return { ok: false, error: `Body '${bodyLabel}': curvePoints must be an array of at least 2 finite [x, y, z] points.` };
        }
      }
      if (!explicitNonEmptyGeoms && (curveFieldTouched || explicitEmptyGeoms || rgbaTouched)) {
        const curvePoints = (updates.curvePoints ?? target.curvePoints ?? DEFAULT_CURVE_POINTS).map((p: number[]) => [...p]);
        const curveWidth = updates.curveWidth ?? target.curveWidth ?? DEFAULT_CURVE_WIDTH;
        const curveThickness = updates.curveThickness ?? target.curveThickness ?? DEFAULT_CURVE_THICKNESS;
        const curveSegments = updates.curveSegments ?? target.curveSegments ?? DEFAULT_CURVE_SEGMENTS;
        const curveClosed = (updates.curveClosed !== undefined ? updates.curveClosed : target.curveClosed) === true;
        const curveBank = updates.curveBank ?? target.curveBank ?? 0;
        const curveRgba =
          updates.rgba
          ?? normalizeRgba((target as unknown as Record<string, unknown>).rgba)
          ?? target.geoms?.[0]?.rgba
          ?? [0.85, 0.45, 0.15, 1];
        if (!target.isCurve) {
          updates.curvePoints = curvePoints;
          updates.curveWidth = curveWidth;
          updates.curveThickness = curveThickness;
          updates.curveSegments = curveSegments;
          updates.curveClosed = curveClosed;
          updates.curveBank = curveBank;
        }
        updates.geoms = generateCurveGeoms(
          targetId,
          curvePoints,
          curveWidth,
          curveThickness,
          curveSegments,
          curveRgba,
          curveClosed,
          curveBank,
        );
      }
    }

    // Clear a stale "Set a mass if you wanted the heavier figure" warning once mass is explicitly set.
    if (updates.mass != null && target.collisionWarning?.includes('Set a mass if you wanted the heavier figure')) {
      updates.collisionWarning = undefined;
    }

    // null or "" detaches the source: the body keeps the mesh it last
    // compiled to (or whatever geoms came with this call) as a plain
    // mesh. Compiling it would fail, and used to, leaving deleting and
    // re-adding the body as the only way out.
    if (updates.scad === null || updates.scad === '') updates.scad = undefined;
    if (updates.scad !== undefined && typeof updates.scad !== 'string') {
      return { ok: false, error: 'scad must be a string (or null/"" to detach)' };
    }

    // Acoustic specs: a partial one merges into the body's own (null drops a
    // subfield), is filled and checked, and `tuneTo` is applied last. What
    // that changed (specs, a tuned string's joint and geoms, tunedPitchHz) goes
    // into `updates`, so the store sees it.
    let next = { ...target, ...updates } as SceneNode;
    const replaced = (list: SceneNode[]): SceneNode[] =>
      list.map((n) => (n.id === targetId ? next : { ...n, children: replaced(n.children || []) }));
    try {
      const touched = ACOUSTIC_FIELDS.filter((k) => k in rawUpdates);
      if (touched.length > 0 || tuneRaw !== undefined) {
        const sentFields = updates as Record<string, unknown>;
        for (const k of SPEC_FIELDS) {
          const had = (target as unknown as Record<string, unknown>)[k];
          const sent = sentFields[k];
          if (sent && typeof sent === 'object' && !Array.isArray(sent) && had && typeof had === 'object') {
            sentFields[k] = withoutNulls({ ...(had as object), ...(sent as object) });
          }
        }
        const before = { ...target, ...updates } as Record<string, unknown>;
        next = { ...before } as unknown as SceneNode;
        normalizeAcousticFields(next, touched);
        if (tuneRaw !== undefined) {
          const flat = replaced(store.sceneGraph.nodes);
          next = applyTuneTo(next, parseTuneTo(tuneRaw, drillRaw), flat);
        }
        for (const [k, v] of Object.entries(next)) if (v !== before[k]) sentFields[k] = v;
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (flexureTouched) {
      if (rawFlexure === null) {
        next = revertFlexure(next);
        updates.geoms = next.geoms;
        updates.joints = next.joints;
        updates.flexure = undefined;
      } else if (rawFlexure !== undefined) {
        if (!isPlainObject(rawFlexure)) {
          return { ok: false, error: 'flexure must be a plain object (or null to remove)' };
        }
        const flexureErr = validateFlexureInput(next, rawFlexure);
        if (flexureErr) return { ok: false, error: flexureErr };
        const applied = applyFlexureToNode(next, rawFlexure as FlexureDesignInput);
        if (!applied) {
          return { ok: false, error: `Body '${next.name || targetId}': flexure requires a 'hinge' or 'slide' joint on the body.` };
        }
        next = applied.node;
        updates.geoms = next.geoms;
        updates.joints = next.joints;
        updates.flexure = next.flexure;
      }
    }
    // A geom type, coordinate or size MuJoCo would refuse with an XML line
    // number is refused here, by name, before the body is touched.
    try {
      checkIncomingBody(next, (next.joints || []).length > 0);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    // Read before the store drops them: a typo in a target id did nothing, ok:true.
    const referenceWarnings = unresolvedReferenceWarnings(unresolvedReferences(replaced(store.sceneGraph.nodes), new Set([targetId])));

    const opsMap = new Map<string, PendingDeclarativeOps>();
    if (rawCuts || normRoundEdges || rawPatterns || rawPaint) {
      opsMap.set(targetId, {
        ...(rawCuts ? { cuts: rawCuts } : {}),
        ...(normRoundEdges ? { roundEdges: normRoundEdges } : {}),
        ...(rawPatterns ? { patterns: rawPatterns } : {}),
        ...(rawPaint ? { paint: rawPaint } : {}),
      });
    }

    try {
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
          return { ok: false, error: `Failed to compile SCAD: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}` };
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
        // skipRecompile = true: UPDATE_OBJECT runs its own awaited recompile below.
        if (Object.keys(rest).length > 0) store.updateNode(targetId, rest, true);
        if (touchesPose(rest)) syncFreeJointToDocument(targetId);
        store.updateNodeScad(targetId, scad, compiled, true);
        const freshPre = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId) ?? target;
        await applyDeclarativePreCsgFeatures([freshPre], opsMap);
        if (findNodeInScene(useStore.getState().sceneGraph.nodes, targetId)?.csgEnabled) {
          await compileCsgNodes(true);
        }
        const freshPost = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId) ?? freshPre;
        await applyDeclarativePostCsgFeatures([freshPost], opsMap);
        await useStore.getState().recompile(useStore.getState().sceneGraph, undefined, false, true);
      } else {
        if (Object.keys(updates).length > 0) {
          store.updateNode(targetId, updates, true);
          if (touchesPose(updates)) syncFreeJointToDocument(targetId);
        }
        const freshPre = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId) ?? target;
        await applyDeclarativePreCsgFeatures([freshPre], opsMap);
        // An update that touches a boolean body (its geoms, its collision
        // mode, a csg marker) invalidates the generated mesh. The editor's
        // debounced auto-compiler would get to it eventually, but an MCP
        // caller is told ok:true synchronously — so do it here and await it.
        // For pure pose/metadata updates (e.g. moving mold pieces with `pos`
        // or `quat`), don't block waiting on unrelated V-HACD convex
        // decomposition of other bodies in the scene.
        const touchesGeometryOrCollision =
          opsMap.size > 0
          || updates.geoms !== undefined
          || updates.collision !== undefined
          || updates.collisionResolution !== undefined
          || updates.csgEnabled !== undefined
          || updates.csgSectors !== undefined
          || updates.brickwork !== undefined
          || updates.bodyForm !== undefined
          || flexureTouched
          || curveFieldTouched;
        const compiled = await compileCsgNodes(true, { colliders: touchesGeometryOrCollision });
        const freshPost = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId) ?? freshPre;
        await applyDeclarativePostCsgFeatures([freshPost], opsMap);
        await useStore.getState().recompile(useStore.getState().sceneGraph, undefined, false, true);
        if (compiled > 0) {
          const node = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId);
          if (node?.csgError) return { ok: false, error: `Boolean failed: ${node.csgError}` };
        }
      }
    } finally {
      opsMap.clear();
    }
    if (typeof window !== 'undefined') {
      updateOrCreateNotecard({
        mode: 'mcp',
        nodes: useStore.getState().sceneGraph.nodes
      });
    }
    const error = useStore.getState().lastCompileError;
    // A script is applied even when it does not compile; the reply says so.
    const scriptError = typeof rawUpdates.script === 'string' ? scriptSyntaxError(rawUpdates.script) : null;
    // Only when the joints were sent: a body already warned about is not warned again on every edit.
    const updated = Array.isArray(rawUpdates.joints) ? findNodeInScene(useStore.getState().sceneGraph.nodes, targetId) : null;
    const axes = updated ? jointAxisWarnings([{ ...updated, children: [] }]) : [];
    // What the cloth now names that it does not have, said to the command that wrote it.
    const landedNode = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId);
    const cloth = landedNode?.cloth ? clothWarningsFor([landedNode.name || landedNode.id]) : [];
    // Says what was taken, so a caller can see its whole update landed.
    return {
      ok: !error, applied: Object.keys(rawUpdates), ...(error ? { error } : {}),
      ...(referenceWarnings.length ? { referenceWarnings } : {}),
      ...(axes.length ? { warnings: axes } : {}),
      ...(cloth.length ? { clothWarnings: cloth } : {}),
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
  SET_COLOR: async (msg, { store, toId }) => {
    // The base colour of a body (or batch of bodies) — what "make the imported
    // bracket blue" means. Paint (below) sits on top of this and is not disturbed by it.
    const parseColorInput = (raw: unknown): { rgba: [number, number, number, number]; hasAlpha: boolean } | undefined => {
      if (typeof raw === 'string') {
        const s = raw.trim();
        const m6 = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(s);
        if (m6) {
          const rgb = m6[1];
          const aHex = m6[2];
          const r = parseInt(rgb.slice(0, 2), 16) / 255;
          const g = parseInt(rgb.slice(2, 4), 16) / 255;
          const b = parseInt(rgb.slice(4, 6), 16) / 255;
          const hasAlpha = aHex !== undefined;
          const a = hasAlpha ? parseInt(aHex, 16) / 255 : 1;
          return { rgba: [r, g, b, a], hasAlpha };
        }
        const m3 = /^#([0-9a-fA-F]{3})([0-9a-fA-F])?$/.exec(s);
        if (m3) {
          const rgb = m3[1];
          const aHex = m3[2];
          const r = parseInt(rgb[0] + rgb[0], 16) / 255;
          const g = parseInt(rgb[1] + rgb[1], 16) / 255;
          const b = parseInt(rgb[2] + rgb[2], 16) / 255;
          const hasAlpha = aHex !== undefined;
          const a = hasAlpha ? parseInt(aHex + aHex, 16) / 255 : 1;
          return { rgba: [r, g, b, a], hasAlpha };
        }
        return undefined;
      }
      const norm = normalizeRgba(raw);
      if (!norm) return undefined;
      return { rgba: norm, hasAlpha: Array.isArray(raw) && raw.length === 4 };
    };

    const resolveId = (v: unknown) => (toId ? toId(v) : v);
    const rawBatch = (msg as Record<string, unknown>).colors ?? (msg as Record<string, unknown>).items;
    if (rawBatch !== undefined) {
      if (!Array.isArray(rawBatch) || rawBatch.length === 0) {
        throw new Error('colors must be a non-empty array of { id, rgba, geomName? } objects');
      }
      const entries: Array<{ nodeId: string; geomName?: string; rgba: number[] }> = [];
      const seenBodies = new Set<string>();
      for (let i = 0; i < rawBatch.length; i++) {
        const item = rawBatch[i];
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw new Error(`colors[${i}] must be an object with id and rgba`);
        }
        const rec = item as Record<string, unknown>;
        const rawId = rec.id ?? rec.targetId;
        if (typeof rawId !== 'string' || !rawId) {
          throw new Error(`colors[${i}] is missing id`);
        }
        const resolvedId = String(resolveId(rawId));
        const node = findNodeInScene(store.sceneGraph.nodes, resolvedId);
        if (!node) throw new Error(`colors[${i}]: No object with id '${rawId}'`);
        const rawRgbaInput = rec.rgba ?? rec.color;
        const parsed = parseColorInput(rawRgbaInput);
        if (!parsed) {
          throw new Error(`colors[${i}]: rgba must be [r, g, b] or [r, g, b, a] (each in 0..1) or a CSS hex string ("#rrggbb" / "#rrggbbaa")`);
        }
        const geomName = typeof rec.geomName === 'string' && rec.geomName ? rec.geomName : undefined;
        if (geomName) {
          if (node.cloth) {
            if (node.cloth.garment) {
              const attached = node.cloth.garment.attached ?? [];
              if (!attached.some((a) => a.name === geomName)) {
                throw new Error(`colors[${i}]: Garment '${rawId}' has no attached piece named '${geomName}'`);
              }
            } else {
              const pieces = node.cloth.pieces ?? [];
              if (!pieces.some((p) => p.name === geomName)) {
                throw new Error(`colors[${i}]: Cloth '${rawId}' has no piece named '${geomName}'`);
              }
            }
          } else if (!(node.geoms || []).some((g: SceneGeom) => g.name === geomName)) {
            throw new Error(`colors[${i}]: Object '${rawId}' has no geom named '${geomName}'`);
          }
        }
        entries.push({
          nodeId: node.id,
          ...(geomName ? { geomName } : {}),
          rgba: parsed.hasAlpha ? parsed.rgba : parsed.rgba.slice(0, 3),
        });
        seenBodies.add(node.id);
      }
      const geomsColored = store.setGeomColorsBatch(entries);
      return { ok: true, bodiesColored: seenBodies.size, geomsColored };
    }
    const { targetId, geomName, rgba, color } = msg as Msg<{ targetId: string; geomName?: string; rgba?: unknown; color?: unknown }>;
    if (!targetId) throw new Error('Missing targetId');
    const rawColorInput = rgba !== undefined ? rgba : color;
    const parsedColor = parseColorInput(rawColorInput);
    if (!parsedColor) {
      throw new Error('rgba must be [r, g, b] or [r, g, b, a] (each in 0..1) or a CSS hex string ("#rrggbb" / "#rrggbbaa")');
    }
    const validatedRgba = parsedColor.rgba;
    const rawRgba = parsedColor.rgba;
    const explicitAlpha = parsedColor.hasAlpha ? parsedColor.rgba[3] : undefined;
    const node = findNodeInScene(store.sceneGraph.nodes, targetId);
    if (!node) throw new Error(`No object with id '${targetId}'`);
    if (node.cloth) {
      if (node.cloth.garment) {
        if (geomName) {
          const attached = node.cloth.garment.attached ?? [];
          if (!attached.some((a) => a.name === geomName)) {
            throw new Error(`Garment '${targetId}' has no attached piece named '${geomName}'`);
          }
          store.updateNode(targetId, {
            cloth: {
              ...node.cloth,
              garment: {
                ...node.cloth.garment,
                attached: attached.map((a) => (a.name === geomName ? { ...a, rgba: [rawRgba[0], rawRgba[1], rawRgba[2], explicitAlpha ?? a.rgba?.[3] ?? 1] } : a)),
              },
            },
          });
          return { ok: true, geomsColored: 1 };
        }
        const c = [rawRgba[0], rawRgba[1], rawRgba[2], explicitAlpha ?? node.cloth.garment.rgba?.[3] ?? 1];
        store.updateNode(targetId, {
          cloth: { ...node.cloth, garment: { ...node.cloth.garment, rgba: c } },
        });
        return { ok: true, geomsColored: 1 };
      }
      const pieces = node.cloth.pieces ?? [];
      if (geomName && !pieces.some((p) => p.name === geomName)) {
        throw new Error(`Cloth '${targetId}' has no piece named '${geomName}'`);
      }
      store.updateNode(targetId, {
        cloth: {
          ...node.cloth,
          pieces: pieces.map((p) =>
            !geomName || p.name === geomName
              ? { ...p, rgba: [rawRgba[0], rawRgba[1], rawRgba[2], explicitAlpha ?? p.rgba?.[3] ?? 1] }
              : p,
          ),
        },
      });
      return { ok: true, geomsColored: geomName ? 1 : pieces.length };
    }
    if (geomName && !(node.geoms || []).some((g: SceneGeom) => g.name === geomName)) {
      throw new Error(`Object '${targetId}' has no geom named '${geomName}'`);
    }
    store.setGeomColor(targetId, geomName, explicitAlpha !== undefined ? validatedRgba : rawRgba.slice(0, 3));
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
    if (!targetId) return { ok: false, error: 'Missing targetId' };
    if (strokes !== undefined) {
      if (!Array.isArray(strokes) || strokes.length === 0) {
        return { ok: false, error: 'strokes must be a non-empty array of paint stroke objects' };
      }
      // A stroke that misses is reported in its place in `results` and the
      // rest still land: one miss used to fail the call after the strokes
      // before it had been applied.
      // Inherit top-level brush defaults (e.g. rgba, radius, flow, hardness,
      // geomName, erase) into each stroke unless overridden per stroke.
      // When a stroke sets radiusMm (or atMm), drop any inherited radius (or at)
      // so the stroke's millimetre unit isn't shadowed by a top-level default.
      const { targetId: _tid, strokes: _strokes, ...topDefaults } = msg as Record<string, unknown>;
      void _tid; void _strokes;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const results: Record<string, any>[] = strokes.map((s) => {
        try {
          if (!isPlainObject(s)) {
            return { ok: false, error: 'Each paint stroke must be a plain object' };
          }
          const merged: Record<string, unknown> = { ...topDefaults, ...s };
          if (s.radiusMm !== undefined && s.radius === undefined) delete merged.radius;
          if (s.radius !== undefined && s.radiusMm === undefined) delete merged.radiusMm;
          if (s.atMm !== undefined && s.at === undefined) delete merged.at;
          if (s.at !== undefined && s.atMm === undefined) delete merged.atMm;
          return applyPaintStrokeToBody(targetId, merged);
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      });
      const landed = results.filter((r) => r.ok);
      return {
        ok: landed.length > 0, id: targetId,
        strokesRequested: strokes.length, strokesApplied: landed.length,
        dabsLanded: results.reduce((n, r) => n + Number(r.dabsLanded || 0), 0),
        dabsRequested: results.reduce((n, r) => n + Number(r.dabsRequested || 0), 0),
        verticesPainted: results.reduce((n, r) => n + Number(r.verticesPainted || 0), 0),
        results,
      };
    }
    try {
      return applyPaintStrokeToBody(targetId, msg);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  CLEAR_PAINT: async (msg, { store }) => {
    const { targetId, geomName } = msg as Msg<{ targetId?: string; geomName?: string }>;
    if (!targetId) {
      if (geomName) {
        return { ok: false, error: 'geomName requires id: specify the body id when clearing paint on one geom.' };
      }
      store.clearAllPaint();
      return { ok: true, scope: 'scene' };
    }
    const node = findNodeInScene(store.sceneGraph.nodes, targetId);
    if (!node) return { ok: false, error: `No object with id '${targetId}'` };
    if (geomName && !(node.geoms || []).some((g) => g.name === geomName)) {
      return { ok: false, error: `Object '${targetId}' has no geom named '${geomName}'` };
    }
    for (const geom of node.geoms || []) {
      if (geomName && geom.name !== geomName) continue;
      if (geom.paint) store.setGeomPaint(node.id, geom.name, undefined);
    }
    return { ok: true, scope: geomName || node.id };
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
        targetId: string; weldTo?: unknown; connectTo?: unknown;
        breakForceN?: unknown; breakTorqueNm?: unknown; breakHoldSteps?: unknown;
      }>;
    if (!targetId) return { ok: false, error: 'Missing targetId' };
    const node = findNodeInScene(store.sceneGraph.nodes, targetId);
    if (!node) return { ok: false, error: `No object with id '${targetId}'` };

    const updates: Partial<SceneNode> = {};
    for (const [field, value] of [
      ['weldTargetId', weldTo], ['connectTargetId', connectTo],
    ] as const) {
      if (value === undefined) continue;
      if (value === null || value === '') { updates[field] = undefined; continue; }
      if (typeof value !== 'string') return { ok: false, error: `${field === 'weldTargetId' ? 'weldTo' : 'connectTo'} must be a body id or name (string), or null to clear` };
      const target = findNodeInScene(store.sceneGraph.nodes, value);
      if (!target) return { ok: false, error: `No object with id '${value}' to attach to` };
      if (target.id === node.id) return { ok: false, error: 'A body cannot be attached to itself' };
      updates[field] = target.id;
    }
    // null clears a threshold; undefined leaves it alone. Without the
    // distinction there is no way to make a weld unbreakable again.
    if (breakForceN !== undefined) {
      if (breakForceN !== null && (!isFiniteNumber(breakForceN) || breakForceN <= 0)) {
        return { ok: false, error: 'breakForceN must be a positive finite number, or null to clear' };
      }
      updates.weldBreakForceN = breakForceN ?? undefined;
    }
    if (breakTorqueNm !== undefined) {
      if (breakTorqueNm !== null && (!isFiniteNumber(breakTorqueNm) || breakTorqueNm <= 0)) {
        return { ok: false, error: 'breakTorqueNm must be a positive finite number, or null to clear' };
      }
      updates.weldBreakTorqueNm = breakTorqueNm ?? undefined;
    }
    if (breakHoldSteps !== undefined) {
      if (breakHoldSteps !== null && (!isFiniteNumber(breakHoldSteps) || !Number.isInteger(breakHoldSteps) || breakHoldSteps < 1)) {
        return { ok: false, error: 'breakHoldSteps must be a positive integer, or null to clear' };
      }
      updates.weldBreakHoldSteps = breakHoldSteps ?? undefined;
    }

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
    const { targetId, withIds, op } = msg as Msg<{ targetId: string; withIds?: unknown; op?: unknown }>;
    const rawSources = Array.isArray(withIds) ? withIds.filter((v: unknown): v is string => typeof v === 'string') : [];
    const sources = [...new Set(rawSources)];
    if (sources.length === 0) return { ok: false, error: 'Give the ids of the bodies to merge in, as withIds' };
    if (op !== undefined && (typeof op !== 'string' || !COMBINE_OPS.has(op))) {
      return { ok: false, error: `op must be 'union', 'difference' ('subtract'), or 'intersection' ('intersect'), not '${String(op)}'` };
    }
    const target = findNodeInScene(store.sceneGraph.nodes, targetId);
    if (!target) return { ok: false, error: `No object with id '${targetId}'` };
    const resolvedSources: SceneNode[] = [];
    const missing: string[] = [];
    for (const id of sources) {
      const found = findNodeInScene(store.sceneGraph.nodes, id);
      if (!found) missing.push(id);
      else resolvedSources.push(found);
    }
    if (missing.length > 0) return { ok: false, error: `No object with id '${missing.join("', '")}'` };
    const sourceIds = [...new Set(resolvedSources.map((n) => n.id))];
    if (sourceIds.includes(target.id)) {
      return { ok: false, error: `Cannot combine body '${target.id}' with itself` };
    }
    for (const src of resolvedSources) {
      if (isDescendantOf(src, target.id)) {
        return { ok: false, error: `Cannot combine ancestor body '${src.id}' into its descendant '${target.id}'` };
      }
    }
    const how = op === 'difference' || op === 'subtract' ? 'difference'
      : op === 'intersection' || op === 'intersect' ? 'intersection' : 'union';

    // Counted the same way as after, without the generated geoms a
    // recompile replaces: counting those made a union report -8.
    const before = (target.geoms || []).filter((g: SceneGeom) => !g.csgDerived).length;
    store.combineBodies(target.id, sourceIds, how);
    await compileCsgNodes(true);
    await useStore.getState().recompile(useStore.getState().sceneGraph, undefined, false, true);
    const after = findNodeInScene(useStore.getState().sceneGraph.nodes, target.id);
    if (after?.csgError) return { ok: false, error: `Combine boolean failed: ${after.csgError}` };
    const compileError = useStore.getState().lastCompileError;
    if (compileError) return { ok: false, error: compileError };
    return {
      ok: true,
      id: target.id,
      op: how,
      merged: sourceIds,
      shapesAdded: (after?.geoms || []).filter((g: SceneGeom) => !g.csgDerived).length - before,
      geoms: (after?.geoms || []).filter((g: SceneGeom) => !g.csgDerived).map((g: SceneGeom) => g.name),
    };
  },
  ROUND_EDGES: async (msg) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { targetId, roundings } = msg as Msg<{ targetId: string; roundings?: Record<string, any>[] }>;
    if (roundings !== undefined && (!Array.isArray(roundings) || roundings.length === 0)) {
      return { ok: false, error: 'roundings must be a non-empty array of rounding specifications' };
    }
    const specs = Array.isArray(roundings) && roundings.length > 0 ? roundings : [msg];
    return await applyRoundEdgesToBody(targetId, specs, true);
  },
  BODY_CUT: async (msg, { store }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { targetId, cuts, frame } = msg as Msg<{ targetId: string; cuts?: Record<string, any>[]; frame?: unknown }>;
    const node = findNodeInScene(store.sceneGraph.nodes, targetId);
    if (!node) return { ok: false, error: `No object with id '${targetId}'` };
    if (cuts !== undefined && (!Array.isArray(cuts) || cuts.length === 0)) {
      return { ok: false, error: 'cuts must be a non-empty array of cut specifications' };
    }
    const specs = Array.isArray(cuts) && cuts.length > 0
      ? cuts.map((spec) => (frame !== undefined && spec && typeof spec === 'object' && !Array.isArray(spec) && spec.frame === undefined
        ? { ...spec, frame }
        : spec))
      : [msg];
    const beforeScene = useStore.getState().sceneGraph;
    const results = [];
    for (const spec of specs) {
      const res = applySingleCutToBody(node.id, spec);
      if (!res.ok) {
        if (results.length > 0) useStore.getState().updateScene(beforeScene, true);
        return res;
      }
      results.push(res);
    }
    await compileCsgNodes(true);
    await useStore.getState().recompile(useStore.getState().sceneGraph, undefined, false, true);
    const after = findNodeInScene(useStore.getState().sceneGraph.nodes, node.id);
    if (after?.csgError) return { ok: false, error: `Cut boolean failed: ${after.csgError}` };
    const compileError = useStore.getState().lastCompileError;
    if (compileError) return { ok: false, error: compileError };
    if (results.length === 1) return results[0];
    return { ok: true, id: node.id, cutsApplied: results.length, cuts: results };
  },
  ADD_HARDWARE: async (msg, { store, toId }) => {
    const wasEmpty = (store.sceneGraph.nodes?.length ?? 0) === 0;
    // `partId`, not `id`: `id` is the request's own, so a part named that way
    // was never seen, and every call read the request id as a part's.
    const { kind, size, lengthMm, washer, into: rawInto, group, at, fixTo: rawFixTo, partId: rawExisting, between: rawBetween } = msg as Msg<{
      kind: unknown; size?: string | number; lengthMm?: unknown; washer?: unknown; into?: unknown; group?: string; at?: unknown;
      fixTo?: unknown; partId?: unknown; between?: unknown;
    }>;
    const resolveId = (v: unknown) => (toId ? toId(v) : v);
    const requestedId = typeof rawExisting === 'string' && rawExisting.trim() ? rawExisting.trim() : undefined;
    const existing = requestedId ? String(resolveId(requestedId)) : undefined;
    const into = typeof rawInto === 'string' && rawInto ? String(resolveId(rawInto)) : undefined;
    const fixTo = typeof rawFixTo === 'string' && rawFixTo ? String(resolveId(rawFixTo)) : undefined;
    const between = Array.isArray(rawBetween)
      ? rawBetween.map((v) => (typeof v === 'string' ? String(resolveId(v)) : v))
      : undefined;

    const existingNode = existing ? findNodeInScene(store.sceneGraph.nodes, existing) : null;
    // A part already in the scene: only fix a body to its moving piece.
    if (existing && (!kind || (fixTo && existingNode))) {
      const part = existingNode;
      const piece = part && movingPieceOf(part);
      if (!piece) return { ok: false, error: `'${existing}' has no moving piece to fix a body to` };
      if (!fixTo) return { ok: false, error: 'Give fixTo: the body to weld to its moving piece' };
      const why = store.fixToPiece(piece.id, fixTo);
      return why ? { ok: false, error: why } : { ok: true, id: existing, pieceId: piece.id, fixed: fixTo };
    }
    if (typeof kind !== 'string' || !Object.hasOwn(HARDWARE_PARTS, kind)) {
      return { ok: false, error: `kind must be one of ${Object.keys(HARDWARE_PARTS).join(', ')}` };
    }
    const partKind = kind as HardwarePartKind;
    const info = HARDWARE_PARTS[partKind];
    // Accept ASCII equivalents like '10x30' for Unicode sizes like 'Ø10×30', and unitless numbers like '75' for '75mm'.
    const normalizeSize = (raw: string) => raw.trim().replace(/^[Øø]/u, '').replace(/[xX×]/gu, '×').toLowerCase();
    const stripMm = (raw: string) => normalizeSize(raw).replace(/mm$/u, '');
    const resolvedSize = size !== undefined
      ? (info.sizes.includes(String(size))
        ? String(size)
        : info.sizes.find((s) => normalizeSize(s) === normalizeSize(String(size)))
          ?? info.sizes.find((s) => stripMm(s) === stripMm(String(size))))
      : undefined;
    if (size !== undefined && !resolvedSize) {
      return { ok: false, error: `${info.label} comes in ${info.sizes.join(', ')}; got '${size}'` };
    }
    if (lengthMm !== undefined && (!isFiniteNumber(lengthMm) || lengthMm <= 0)) {
      return { ok: false, error: 'lengthMm must be a positive finite number' };
    }
    if (at !== undefined && !isFiniteVec3(at)) {
      return { ok: false, error: 'at must be [x, y, z] of finite numbers in millimetres' };
    }
    if (rawInto !== undefined && rawInto !== null && typeof rawInto !== 'string') {
      return { ok: false, error: 'into must be a body id or name (string)' };
    }
    if (into && !findNodeInScene(store.sceneGraph.nodes, into)) return { ok: false, error: `No object with id '${rawInto}'` };
    // Snapshot scene before inserting hardware so validation failures (e.g. invalid fixTo)
    // can roll back cleanly without leaving an orphan body in the scene graph.
    const beforeScene = structuredClone(useStore.getState().sceneGraph);
    const beforeSelectedId = useStore.getState().selectedNodeId;
    let id: string | null;
    let usedJoinProfiles = false;
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
      const afterScene = useStore.getState().sceneGraph;
      const after = afterScene.nodes;
      const drawerNode = findNodeInScene(after, into);
      const findParentId = (nodes: SceneNode[], targetId: string): string | undefined => {
        for (const n of nodes) {
          if (n.children?.some((c) => c.id === targetId)) return n.id;
          const p = findParentId(n.children || [], targetId);
          if (p) return p;
        }
        return undefined;
      };
      return {
        ok: true, ids: fitted,
        runners: fitted.map((rid) => {
          const r = findNodeInScene(after, rid);
          const worldMat = r ? documentWorldMatrix(afterScene, r.id) : null;
          const worldPos = worldMat ? new Vector3().setFromMatrixPosition(worldMat).toArray() : (r?.pos ?? [0, 0, 0]);
          const carriage = r ? movingPieceOf(r) : null;
          const mountedTo = r ? findParentId(after, r.id) : undefined;
          const weldedTo = carriage && drawerNode?.weldTargetId === carriage.id ? drawerNode.id : r?.weldTargetId;
          return {
            id: rid,
            name: r?.name,
            posMm: worldPos.map((v) => Math.round(v * 1e6) / 1000),
            ...(mountedTo ? { mountedTo } : {}),
            ...(carriage ? { carriageId: carriage.id } : {}),
            ...(weldedTo ? { weldedTo } : {}),
            ...(carriage?.coupleTargetId ? { coupledTo: carriage.coupleTargetId } : {}),
          };
        }),
      };
    }
    // Extrusion: a joining piece goes where two profiles meet, a carriage onto its V-slot.
    // A corner_bracket can also be placed standalone at `at` or mounted onto timber/non-extrusion panels.
    const strictJoinKind = kind === 'joint_plate' || kind === 'end_tap' ? kind : null;
    const betweenPair = Array.isArray(between) && between.length === 2 && typeof between[0] === 'string' && typeof between[1] === 'string'
      ? [between[0], between[1]] as [string, string]
      : null;
    const betweenNodes = betweenPair
      ? [findNodeInScene(store.sceneGraph.nodes, betweenPair[0]), findNodeInScene(store.sceneGraph.nodes, betweenPair[1])] as const
      : null;
    const bothExtrusions = !!(betweenNodes?.[0]?.hardwarePart?.kind === 'extrusion' && betweenNodes?.[1]?.hardwarePart?.kind === 'extrusion');
    let betweenMountedTo: string | null = null;
    let betweenOtherId: string | null = null;
    let betweenMovingId: string | null = null;

    /** Reparent a freshly added top-level hardware node as a rigid child of `hostId` at `worldPos`. */
    const attachHardwareRigidlyTo = (partId: string, hostId: string, worldPos: number[], weldOtherId?: string) => {
      const currentScene = useStore.getState().sceneGraph;
      const cloned = structuredClone(currentScene);
      const topIdx = cloned.nodes.findIndex((n) => n.id === partId);
      const hostNode = findNodeInScene(cloned.nodes, hostId);
      if (topIdx < 0 || !hostNode) return;
      const [partNode] = cloned.nodes.splice(topIdx, 1);
      const mHost = documentWorldMatrix(currentScene, hostId);
      if (mHost) {
        const invHost = mHost.clone().invert();
        const localPos = new Vector3(worldPos[0], worldPos[1], worldPos[2]).applyMatrix4(invHost);
        const hostQuat = new Quaternion().setFromRotationMatrix(mHost).invert();
        partNode.pos = [localPos.x, localPos.y, localPos.z].map((v) => +v.toFixed(7));
        partNode.quat = [hostQuat.w, hostQuat.x, hostQuat.y, hostQuat.z].map((v) => +v.toFixed(9));
      } else {
        partNode.pos = [...worldPos];
      }
      partNode.joints = [];
      quietHardwarePart(partNode);
      if (weldOtherId) {
        partNode.weldTargetId = weldOtherId;
        partNode.weldRigid = true;
        if (partNode.hardwarePart) partNode.hardwarePart.fastens = weldOtherId;
      }
      hostNode.children = [...(hostNode.children || []), partNode];
      useStore.setState({ sceneGraph: cloned, selectedNodeId: partId });
    };

    if (strictJoinKind || (kind === 'corner_bracket' && bothExtrusions)) {
      if (!betweenPair) {
        return { ok: false, error: `A ${info.label.toLowerCase()} joins two profiles: give their ids as between: [a, b]` };
      }
      const joined = store.joinProfiles(betweenPair[0], betweenPair[1], (strictJoinKind ?? 'corner_bracket'), resolvedSize);
      if ('problem' in joined) return { ok: false, error: joined.problem };
      id = joined.id;
      usedJoinProfiles = true;
    } else if (kind === 'corner_bracket' && betweenPair) {
      if (!betweenNodes?.[0]) return { ok: false, error: `No object with id '${betweenPair[0]}'` };
      if (!betweenNodes?.[1]) return { ok: false, error: `No object with id '${betweenPair[1]}'` };
      const placed = isFiniteVec3(at);
      const pos = placed
        ? at.map((v) => v / 1000)
        : sharedSeamPoint(store.sceneGraph, betweenNodes[0], betweenNodes[1]);
      const mountTarget = into ?? betweenNodes[0].id;
      const otherTarget = mountTarget === betweenNodes[1].id ? betweenNodes[0].id : betweenNodes[1].id;
      id = store.addHardwarePart(partKind, pos, null, { exact: true, mount: false });
      if (id) {
        attachHardwareRigidlyTo(id, mountTarget, pos, otherTarget);
        betweenMountedTo = mountTarget;
        betweenOtherId = otherTarget;
      }
    } else if ((kind === 'butt_hinge' || kind === 'hasp_latch') && betweenPair) {
      if (!betweenNodes?.[0]) return { ok: false, error: `No object with id '${betweenPair[0]}'` };
      if (!betweenNodes?.[1]) return { ok: false, error: `No object with id '${betweenPair[1]}'` };
      const placed = isFiniteVec3(at);
      const pos = placed
        ? at.map((v) => v / 1000)
        : sharedSeamPoint(store.sceneGraph, betweenNodes[0], betweenNodes[1]);
      const fixedTarget = into ?? betweenNodes[0].id;
      const movingTarget = betweenNodes[1].id;
      id = store.addHardwarePart(partKind, pos, null, { exact: true, mount: false });
      if (id) {
        attachHardwareRigidlyTo(id, fixedTarget, pos);
        betweenMountedTo = fixedTarget;
        betweenMovingId = movingTarget;
      }
    } else if (kind === 'vslot_carriage') {
      if (!into) return { ok: false, error: 'A V-slot carriage runs on a profile: give its id as into' };
      const placed = store.addCarriage(into);
      if ('problem' in placed) return { ok: false, error: placed.problem };
      id = placed.id;
    } else if (into && group) {
      id = store.seatHardwarePart(into, group, partKind);
      if (!id) return { ok: false, error: `'${into}' has no hardware cut '${group}' that takes a ${info.label.toLowerCase()}` };
    } else {
      const placed = isFiniteVec3(at);
      const pos = placed ? at.map((v) => v / 1000) : [0, 0, 0.03];
      // `at` is where it goes, exactly; `into` a body with no cut for it
      // fixes it there (a stepper bolted to its frame).
      id = store.addHardwarePart(partKind, pos, into ?? null, { exact: placed, mount: !!into });
    }
    if (!id) return { ok: false, error: 'The part could not be added' };
    // Honor user-supplied `id` (`partId` on the wire) when creating new hardware.
    if (requestedId && id !== requestedId) {
      const currentScene = useStore.getState().sceneGraph;
      const taken = collectNodeIds(currentScene.nodes);
      // Exclude the freshly generated node (and its piece children) from collision checks.
      const oldId = id;
      for (const tid of [...taken]) {
        if (tid === oldId || tid.startsWith(`${oldId}_`)) taken.delete(tid);
      }
      let finalId = requestedId;
      if (taken.has(finalId)) {
        let n = 2;
        while (taken.has(`${requestedId}_${n}`)) n++;
        finalId = `${requestedId}_${n}`;
      }
      const cloned = structuredClone(currentScene);
      const target = findNodeInScene(cloned.nodes, oldId);
      if (target) {
        const renameStr = (s: string) => (s === oldId ? finalId : s.startsWith(`${oldId}_`) ? `${finalId}${s.slice(oldId.length)}` : s);
        const renameSubtree = (n: SceneNode) => {
          n.id = renameStr(n.id);
          if (n.coupleTargetId) n.coupleTargetId = renameStr(n.coupleTargetId);
          if (n.weldTargetId) n.weldTargetId = renameStr(n.weldTargetId);
          for (const g of n.geoms || []) {
            if (g.name) g.name = renameStr(g.name);
          }
          for (const j of n.joints || []) {
            if (j.name) j.name = renameStr(j.name);
          }
          for (const c of n.children || []) {
            if (c.hardwarePart?.piece) renameSubtree(c);
          }
        };
        renameSubtree(target);
        useStore.setState({ sceneGraph: cloned, selectedNodeId: finalId });
        id = finalId;
      }
    }
    // Sized before anything is fixed to it: fixed first, a body rode the
    // default size's moving piece where the new size's no longer was.
    if (!usedJoinProfiles && kind !== 'vslot_carriage' && (resolvedSize !== undefined || lengthMm !== undefined || washer !== undefined)) {
      useStore.getState().setHardwarePart(id, {
        ...(resolvedSize !== undefined ? { size: resolvedSize } : {}),
        ...(typeof lengthMm === 'number' ? { lengthMm } : {}),
        ...(typeof washer === 'boolean' ? { washer } : {}),
      });
      // Re-seat a linear_rod after changing its lengthMm so its bottom end stays
      // flush on the rod_clamp floor instead of extending past it.
      if (partKind === 'linear_rod' && typeof lengthMm === 'number' && into) {
        const currentScene = useStore.getState().sceneGraph;
        const cloned = structuredClone(currentScene);
        const hostNode = findNodeInScene(cloned.nodes, into);
        const rodNode = findNodeInScene(cloned.nodes, id);
        const seatGroup = rodNode?.hardwarePart?.seat;
        if (hostNode && rodNode && seatGroup) {
          const seat = seatFor(hostNode, seatGroup, 'linear_rod', rodNode.hardwarePart?.lengthMm);
          if (seat) {
            rodNode.pos = seat.pos;
            rodNode.quat = seat.quat;
            useStore.setState({ sceneGraph: cloned });
          }
        }
      }
    }
    if (betweenMovingId) {
      const currentScene = useStore.getState().sceneGraph;
      const cloned = structuredClone(currentScene);
      const added = findNodeInScene(cloned.nodes, id);
      const piece = added && movingPieceOf(added);
      if (piece) {
        piece.weldTargetId = betweenMovingId;
        piece.weldRigid = true;
        useStore.setState({ sceneGraph: cloned });
      }
    }
    if (fixTo && fixTo !== betweenMovingId) {
      const added = findNodeInScene(useStore.getState().sceneGraph.nodes, id);
      const piece = added && movingPieceOf(added);
      const why = piece ? useStore.getState().fixToPiece(piece.id, fixTo) : `A ${info.label.toLowerCase()} has no moving piece to fix a body to`;
      if (why) {
        useStore.setState({ sceneGraph: beforeScene, selectedNodeId: beforeSelectedId });
        return { ok: false, error: why };
      }
    }
    await compileCsgNodes(true);
    await useStore.getState().recompile(useStore.getState().sceneGraph, undefined, false, true);
    const finalScene = useStore.getState().sceneGraph;
    const part = findNodeInScene(finalScene.nodes, id);
    const spec = part?.hardwarePart;
    if (!part || !spec) return { ok: false, error: 'The part could not be added' };
    if (wasEmpty) {
      const patch = framingPatch(finalScene, null);
      if (patch.cameraOverride) useStore.setState(patch);
    }
    const worldMat = documentWorldMatrix(finalScene, part.id);
    const worldPos = worldMat ? new Vector3().setFromMatrixPosition(worldMat).toArray() : part.pos;
    const innerPiece = part.children.find((c) => c.hardwarePart?.piece === 'inner');
    const innerKey = spec.kind === 'stepper'
      ? 'shaftId'
      : (spec.kind as string) === 'butt_hinge'
        ? 'leafId'
        : (spec.kind as string) === 'hasp_latch'
          ? 'strapId'
          : 'innerRaceId';
    return {
      ok: true, id, name: part.name, kind: spec.kind, size: spec.size,
      ...(spec.lengthMm !== undefined ? { lengthMm: spec.lengthMm } : {}),
      ...(spec.washer ? { washer: true } : {}),
      ...(spec.seat ? { seatedIn: spec.seat === 'bore' ? 'bearing bore' : spec.seat } : {}),
      ...(spec.fastens ? { fastens: spec.fastens } : {}),
      ...(betweenMountedTo ? { mountedTo: betweenMountedTo } : {}),
      ...(betweenMovingId ? { fixedTo: betweenMovingId } : {}),
      ...(betweenMountedTo && (betweenMovingId || betweenOtherId)
        ? { between: [betweenMountedTo, betweenMovingId ?? betweenOtherId] }
        : {}),
      ...(part.weldTargetId ? { weldedTo: part.weldTargetId } : {}),
      ...(innerPiece ? { [innerKey]: innerPiece.id } : {}),
      ...(part.children.some((c) => c.hardwarePart?.piece === 'carriage')
        ? { carriageId: part.children.find((c) => c.hardwarePart?.piece === 'carriage')!.id }
        : spec.kind === 'vslot_carriage'
          ? { carriageId: part.id }
          : {}),
      posMm: worldPos.map((v) => Math.round(v * 1e6) / 1000),
      ...(spec.kind === 'oring' && into && spec.seat ? { sealCheck: sealCheckFor(useStore.getState().sceneGraph, into, spec.seat) } : {}),
    };
  },
  APPLY_PATTERN: async (msg) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { targetId, patterns } = msg as Msg<{ targetId: string; patterns?: Record<string, any>[] }>;
    if (!targetId) return { ok: false, error: 'Missing targetId' };
    if (patterns !== undefined) {
      if (!Array.isArray(patterns) || patterns.length === 0) {
        return { ok: false, error: 'patterns must be a non-empty array of pattern objects' };
      }
      const beforeScene = useStore.getState().sceneGraph;
      const results = [];
      for (const p of patterns) {
        const res = await applySinglePatternToBody(targetId, p);
        if (!res.ok) {
          if (results.length > 0) useStore.getState().updateScene(beforeScene, true);
          return res;
        }
        results.push(res);
      }
      return { ok: true, id: targetId, patternsApplied: results.length, patterns: results };
    }
    return await applySinglePatternToBody(targetId, msg);
  },
  KNIFE: async (msg, { store }) => {
    const m = msg as Msg<{ targetId: string; at?: unknown; normal?: unknown; cut?: boolean; remove?: boolean }>;
    if (!m.targetId) return { ok: false, error: 'Missing targetId' };
    const node = findNodeInScene(store.sceneGraph.nodes, m.targetId);
    if (!node) return { ok: false, error: `No object with id '${m.targetId}'` };
    const atMm = pointList(m.at)[0];
    if (!isFiniteVec3(atMm)) {
      return { ok: false, error: "Missing or invalid at: expected [x, y, z] of finite numbers in the body's own frame in millimetres." };
    }
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

    if (!isFiniteVec3(m.normal)) {
      return { ok: false, error: "Missing or invalid normal: expected [x, y, z] of finite numbers in the body's own frame." };
    }
    const normal = new Vector3(...m.normal);
    if (normal.lengthSq() < 1e-18) return { ok: false, error: 'normal must not be [0, 0, 0].' };
    normal.normalize();

    if (m.cut) {
      const { soups, absorbed } = knifeSoups(node);
      const result = await cutAlongPlaneOffThread(soups, at.toArray(), normal.toArray());
      if (!result.ok) return { ok: false, error: result.error };
      // Verify the target node still exists after awaiting the worker cut.
      const freshNode = findNodeInScene(useStore.getState().sceneGraph.nodes, node.id);
      if (!freshNode) return { ok: false, error: `Body '${node.id}' was deleted while cutting.` };
      const carry = carryAcrossCut(freshNode, result.sections, at.toArray(), normal.toArray());
      const ids = useStore.getState().splitBodyForPrint(freshNode.id, result.sections, absorbed, { plain: true, carry });
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
      toId: (s) => (toId ? toId(s) : s) as string,
      nodes: store.sceneGraph.nodes,
      findNodeInScene,
      updateNode: (nodeId, patch) => useStore.getState().updateNode(nodeId, patch),
      compileCsgNodes,
    });
  },
};
