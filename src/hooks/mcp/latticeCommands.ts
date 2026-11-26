// ---------------------------------------------------------------------------
// MCP lattice commands: create a cage, edit it, undo, read it back
// ---------------------------------------------------------------------------

import { useStore } from '../../store/useStore';
import { framingPatch } from '../../store/sceneFraming';
import {
  addFacesMm, addRingMm, bevelEdgesMm, bevelFaceMm, bridgeFacesMm, describeLattice,
  dimensionSelectionMm, extrudeMm, insetFaceMm, latticeSummary, removeFacesMm, revolveMm,
  sharpenEdgesMm,
} from '../../utils/latticeCommands';
import type { SceneNode, SceneGeom } from '../../types/scene';
import {
  boxLattice, cloneLattice, createLattice, deserializeCage, faceCount, orientFaces, serializeCage,
  toSceneGeom as latticeToSceneGeom, DEFAULT_UNIT as LATTICE_UNIT,
} from '../../utils/latticeMesh';
import { type Msg, resolveParent, withChild, findNodeInScene } from './bridgeUtils';
import {
  latticeHistory, latticeOf, latticeTarget, pushLatticeHistory, commitLattice, runLatticeOps,
  parseAxis, parseBevelMode, parseSubdiv, parseThicknessMm, parseRingCount,
} from './latticeState';
import { settleScene } from './settleScene';
import { collidersAreStale } from '../../utils/convexDecomposition';
import { cageOriginInBodyMm, latticeBodyPos } from '../../utils/latticeFrame';
import type { McpCommands } from './types';

export const latticeCommands: McpCommands = {
    /*
      Lattice modelling, driven by coordinates.
  
      The one thing in this app that is EASIER to drive without a screen than
      with one: the whole state is integers on a grid, so "the corner at
      20, -10, 0" is exactly a corner, is the same corner on the next call,
      and comes back out of physics_get_lattice in the form it went in.
      Callers speak millimetres in the body's own frame; see
      utils/latticeCommands.ts.
    */
  CREATE_LATTICE: async (msg) => {
    const { name, pos, sizeMm, edit, empty, ops, subdiv: initSubdiv, thicknessMm: initThickness } = msg;
    const parent = resolveParent(useStore.getState().sceneGraph.nodes, msg.parent);
    if (pos !== undefined) {
      if (!Array.isArray(pos) || pos.length !== 3 || pos.some((v: unknown) => typeof v !== 'number' || !Number.isFinite(v))) {
        throw new Error('pos must be [x, y, z] finite numbers in metres');
      }
    }
    if (sizeMm !== undefined && !(typeof sizeMm === 'number' && Number.isFinite(sizeMm) && sizeMm >= 0 && sizeMm <= 200_000)) {
      throw new Error('sizeMm must be a non-negative finite number of millimetres (at most 200000)');
    }
    if (ops !== undefined && !Array.isArray(ops)) {
      throw new Error('ops must be an array of lattice operations');
    }
    const parsedSubdiv = initSubdiv !== undefined ? parseSubdiv(initSubdiv, 'subdiv') : 0;
    const parsedThickness = initThickness !== undefined ? parseThicknessMm(initThickness, 'thicknessMm') : 0;
    const position: [number, number, number] = pos !== undefined ? [pos[0], pos[1], pos[2]] : [0, 0, 0.2];
    const firstItem = Array.isArray(ops) && ops.length > 0 ? ops[0] : null;
    const firstOp = firstItem && typeof firstItem === 'object' && !Array.isArray(firstItem)
      ? String(firstItem.op ?? firstItem.type ?? '').toLowerCase()
      : '';
    const startEmpty = empty === true || sizeMm === 0 || (sizeMm === undefined && firstOp === 'revolve');
    const size = typeof sizeMm === 'number' && Number.isFinite(sizeMm) && sizeMm > 0 ? sizeMm : 40;
    const halfSteps = Math.max(1, Math.round((size / 2) / (LATTICE_UNIT * 1000)));

    const id = `lattice_${Math.random().toString(36).substring(2, 10)}`;
    const lat = startEmpty ? createLattice(LATTICE_UNIT) : boxLattice(LATTICE_UNIT, halfSteps);
    const { subdiv, thicknessMm } = runLatticeOps(
      lat,
      Array.isArray(ops) ? ops : [],
      parsedSubdiv,
      parsedThickness,
    );
    const cage = serializeCage(lat);
    const { vertices, renderVertices, faces, origin } = latticeToSceneGeom(deserializeCage(cage), subdiv, thicknessMm / 1000);

    const newNode: SceneNode = {
      id,
      name: (typeof name === 'string' && name.trim()) ? name.trim() : 'Lattice',
      type: 'body',
      // The caller's `pos` is where the CAGE origin goes, since every
      // coordinate in `ops` and in the later lattice tools is in the cage's
      // frame; the body itself sits on the shape's centre of mass, which the
      // mesh is centred on (utils/latticeFrame.ts).
      pos: latticeBodyPos(position, origin),
      // Nested, it is fixed rigidly to its parent: a free joint is only
      // allowed at the top level.
      joints: parent ? [] : [{ name: `${id}_free`, type: 'free' }],
      geoms: [{
        name: `${id}_mesh`,
        type: 'mesh',
        size: [1],
        rgba: [0.55, 0.68, 0.85, 1],
        // Weighed by its volume (see generatedMeshMass), not a flat kilogram.
        condim: 3,
        dynamic: true,
        latticeGeom: true,
        vertices,
        faces,
        renderVertices,
      }],
      children: [],
      isLattice: true,
      latticeCage: cage,
      latticeSubdiv: subdiv,
      ...(thicknessMm > 0 ? { latticeThickness: thicknessMm / 1000 } : {}),
      latticeVersion: 1,
      latticeOrigin: origin,
    };

    const currentNodes = useStore.getState().sceneGraph.nodes || [];
    const wasEmpty = currentNodes.length === 0;
    const updatedNodes = parent ? withChild(currentNodes, parent.id, newNode) : [...currentNodes, newNode];
    // Not waiting for its convex pieces: those are V-HACD, one job at a time
    // across the whole scene, and a burst of creates queued behind each
    // other's until one timed out with its body already made (a retry then
    // made it twice). The summary reports collisionPending meanwhile, and
    // physics_run_headless waits for them.
    const settleRes = await settleScene(updatedNodes, { replacesScene: false, waitForColliders: false });
    if (!settleRes.ok) {
      throw new Error(`The lattice body failed to compile: ${settleRes.error}`);
    }

    // Auto-frame the camera when the first body is created in an empty scene.
    if (wasEmpty) {
      const patch = framingPatch(useStore.getState().sceneGraph, null);
      if (patch.cameraOverride) useStore.setState(patch);
    }

    // Opening the tools is opt-in: it takes over the viewport and pauses
    // the simulation, which is rude to do to somebody mid-task, but it is
    // exactly what is wanted when a person is about to carry on by hand.
    if (edit) useStore.getState().setLatticeNodeId(id);

    return {
      ok: true, id, name: newNode.name,
      ...(parent ? { parent: parent.id } : {}),
      ...(Array.isArray(ops) && ops.length > 0 ? { opsApplied: ops.length } : {}),
      ...latticeSummary(deserializeCage(cage)),
      // Joint anchors and child bodies are in the body frame, whose origin is
      // the centre of mass: cage point c (mm) is at body-frame c + this.
      cageOriginMm: cageOriginInBodyMm(newNode),
      ...(collidersAreStale(findNodeInScene(useStore.getState().sceneGraph.nodes, id) ?? newNode) ? { collisionPending: true } : {}),
    };
  },
  LATTICE_FACES: async (msg, { store }) => {
    const { targetId, faces, mirror } = msg as Msg<{ targetId: string }>;
    const { node, lattice } = latticeTarget(store, targetId);
    const mir = parseAxis(mirror, 'mirror', false);
    const before = cloneLattice(lattice);
    const result = addFacesMm(lattice, faces, mir);
    if (result.added === 0) {
      return { ok: false, id: targetId, error: 'No face was added', ...result, ...latticeSummary(lattice) };
    }
    pushLatticeHistory(targetId, before);
    commitLattice(node, lattice);
    return { ok: true, id: targetId, ...result, ...latticeSummary(lattice), undoDepth: (latticeHistory.get(targetId) ?? []).length };
  },
  LATTICE_EXTRUDE: async (msg, { store }) => {
    const { targetId, face, distanceMm, axis, mirror } = msg as Msg<{ targetId: string }>;
    const { node, lattice } = latticeTarget(store, targetId);
    if (typeof distanceMm !== 'number' || !Number.isFinite(distanceMm)) {
      throw new Error('distanceMm must be a number of millimetres to push the face out by');
    }
    const ax = parseAxis(axis, 'axis', false);
    const mir = parseAxis(mirror, 'mirror', false);
    const before = cloneLattice(lattice);
    const result = extrudeMm(lattice, face, distanceMm, ax, mir);
    pushLatticeHistory(targetId, before);
    commitLattice(node, lattice);
    return { ok: true, id: targetId, ...result, ...latticeSummary(lattice), undoDepth: (latticeHistory.get(targetId) ?? []).length };
  },
  LATTICE_DELETE_FACES: async (msg, { store }) => {
    const { targetId, faces, mirror } = msg as Msg<{ targetId: string }>;
    const { node, lattice } = latticeTarget(store, targetId);
    const mir = parseAxis(mirror, 'mirror', false);
    const before = cloneLattice(lattice);
    const result = removeFacesMm(lattice, faces, mir);
    if (result.removed === 0) {
      return { ok: false, id: targetId, error: 'No face was removed', ...result, ...latticeSummary(lattice) };
    }
    if (faceCount(lattice) === 0) {
      return {
        ok: false,
        id: targetId,
        error: 'Deleting those faces would leave 0 faces in the lattice cage, which cannot compile. Use physics_delete_object to delete the whole body instead.',
        ...latticeSummary(before),
      };
    }
    pushLatticeHistory(targetId, before);
    commitLattice(node, lattice);
    return { ok: true, id: targetId, ...result, ...latticeSummary(lattice), undoDepth: (latticeHistory.get(targetId) ?? []).length };
  },
  LATTICE_SHARPEN: async (msg, { store }) => {
    const { targetId, edges, sharp, mirror, loop } = msg as Msg<{ targetId: string }>;
    const { node, lattice } = latticeTarget(store, targetId);
    const mir = parseAxis(mirror, 'mirror', false);
    const before = cloneLattice(lattice);
    const result = sharpenEdgesMm(lattice, edges, sharp !== false, mir, loop === true);
    if (result.changed === 0) {
      return { ok: false, id: targetId, error: 'No edge changed', ...result, ...latticeSummary(lattice) };
    }
    pushLatticeHistory(targetId, before);
    commitLattice(node, lattice);
    return { ok: true, id: targetId, ...result, ...latticeSummary(lattice), undoDepth: (latticeHistory.get(targetId) ?? []).length };
  },
  LATTICE_SMOOTH: async (msg, { store }) => {
    const { targetId, level } = msg as Msg<{ targetId: string }>;
    const { node } = latticeTarget(store, targetId);
    const wanted = parseSubdiv(level, 'level');
    useStore.getState().setLatticeSubdiv(node.id, wanted);
    const after = findNodeInScene(useStore.getState().sceneGraph.nodes, node.id);
    const mesh = after?.geoms?.find((g: SceneGeom) => g.latticeGeom)
      ?? after?.geoms?.find((g: SceneGeom) => g.type === 'mesh' && !g.csgDerived);
    return {
      ok: true, id: node.id, level: wanted,
      ...latticeSummary(latticeOf(after)),
      // The cage is unchanged; what smoothing changes is the mesh built
      // from it, which is what everything downstream actually sees.
      meshTriangles: mesh?.faces ? mesh.faces.length / 3 : 0,
    };
  },
  LATTICE_INSET: async (msg, { store }) => {
    const { targetId, face, amountMm, mirror } = msg as Msg<{ targetId: string; amountMm: number }>;
    const { node, lattice } = latticeTarget(store, targetId);
    const mir = parseAxis(mirror, 'mirror', false);
    const before = cloneLattice(lattice);
    const result = insetFaceMm(lattice, face, amountMm, mir);
    pushLatticeHistory(targetId, before);
    commitLattice(node, lattice);
    return { ok: true, id: targetId, ...result, ...latticeSummary(lattice), undoDepth: (latticeHistory.get(targetId) ?? []).length };
  },
  LATTICE_BEVEL: async (msg, { store }) => {
    const { targetId, face, amountMm, mirror } = msg as Msg<{ targetId: string; amountMm: number }>;
    const { node, lattice } = latticeTarget(store, targetId);
    const mir = parseAxis(mirror, 'mirror', false);
    const before = cloneLattice(lattice);
    const result = bevelFaceMm(lattice, face, amountMm, mir);
    pushLatticeHistory(targetId, before);
    commitLattice(node, lattice);
    return { ok: true, id: targetId, ...result, ...latticeSummary(lattice), undoDepth: (latticeHistory.get(targetId) ?? []).length };
  },
  LATTICE_BEVEL_EDGES: async (msg, { store }) => {
    const { targetId, edges, radiusMm, mode, mirror, loop } = msg as Msg<{ targetId: string; radiusMm: number }>;
    const { node, lattice } = latticeTarget(store, targetId);
    const bevelMode = parseBevelMode(mode);
    const mir = parseAxis(mirror, 'mirror', false);
    const before = cloneLattice(lattice);
    const result = bevelEdgesMm(
      lattice, edges, radiusMm,
      bevelMode,
      mir,
      loop === true,
    );
    pushLatticeHistory(targetId, before);
    commitLattice(node, lattice);
    return { ok: true, id: targetId, ...result, ...latticeSummary(lattice), undoDepth: (latticeHistory.get(targetId) ?? []).length };
  },
  LATTICE_CIRCLE: async (msg, { store }) => {
    const { targetId, diameterMm, axis, sides, mirror } = msg as Msg<{ targetId: string; diameterMm: number }>;
    const centre = msg.centre ?? msg.center;
    const { node, lattice } = latticeTarget(store, targetId);
    const ax = parseAxis(axis, 'axis', false) ?? 'z';
    const mir = parseAxis(mirror, 'mirror', false);
    const sideCount = parseRingCount(sides, 'sides');
    const before = cloneLattice(lattice);
    const result = addRingMm(
      lattice, centre, diameterMm,
      ax,
      sideCount,
      mir,
    );
    pushLatticeHistory(targetId, before);
    commitLattice(node, lattice);
    return { ok: true, id: targetId, ...result, ...latticeSummary(lattice), undoDepth: (latticeHistory.get(targetId) ?? []).length };
  },
  LATTICE_REVOLVE: async (msg, { store }) => {
    const { targetId, profile, axis, degrees, throughMm, segments, closed } = msg as Msg<{ targetId: string }>;
    const { node, lattice } = latticeTarget(store, targetId);
    const ax = parseAxis(axis, 'axis', false) ?? 'z';
    if (degrees !== undefined && (typeof degrees !== 'number' || !Number.isFinite(degrees))) {
      throw new Error('degrees must be a finite number between 1 and 360');
    }
    const segs = parseRingCount(segments, 'segments');
    const before = cloneLattice(lattice);
    const result = revolveMm(
      lattice, profile, ax,
      degrees === undefined ? 360 : degrees,
      {
        throughMm: throughMm as number[] | undefined,
        segments: segs,
        closed: closed === true,
      },
    );
    pushLatticeHistory(targetId, before);
    commitLattice(node, lattice);
    return { ok: true, id: targetId, ...result, ...latticeSummary(lattice), undoDepth: (latticeHistory.get(targetId) ?? []).length };
  },
  LATTICE_BRIDGE: async (msg, { store }) => {
    const { targetId, faceA, faceB } = msg as Msg<{ targetId: string }>;
    const { node, lattice } = latticeTarget(store, targetId);
    const before = cloneLattice(lattice);
    const result = bridgeFacesMm(lattice, faceA, faceB);
    pushLatticeHistory(targetId, before);
    commitLattice(node, lattice);
    return { ok: true, id: targetId, ...result, ...latticeSummary(lattice), undoDepth: (latticeHistory.get(targetId) ?? []).length };
  },
  LATTICE_DIMENSION: async (msg, { store }) => {
    const { targetId, corners, axis, mode, valueMm } = msg as Msg<{ targetId: string }>;
    const { node, lattice } = latticeTarget(store, targetId);
    let which;
    try {
      which = parseAxis(axis, 'axis', true)!;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (mode !== undefined && mode !== 'size' && mode !== 'position') {
      return { ok: false, error: "mode must be 'size' or 'position'" };
    }
    const how = mode === 'position' ? 'position' : 'size';
    if (typeof valueMm !== 'number' || !Number.isFinite(valueMm)) {
      return { ok: false, error: 'valueMm must be a number, in millimetres' };
    }
    const before = cloneLattice(lattice);
    const result = dimensionSelectionMm(lattice, corners, which, how, valueMm);
    if (!result.changed) {
      // Not an error. Asking for the size something already is, or for a
      // size on an axis it is flat along, is a no-op and saying so is
      // more use than a failure the caller has to interpret.
      return { ok: true, id: targetId, ...result, ...latticeSummary(lattice) };
    }
    pushLatticeHistory(targetId, before);
    commitLattice(node, lattice);
    return {
      ok: true, id: targetId, ...result, ...latticeSummary(lattice),
      undoDepth: (latticeHistory.get(targetId) ?? []).length,
    };
  },
  LATTICE_ORIENT: async (msg, { store }) => {
    const { targetId } = msg as Msg<{ targetId: string }>;
    const { node, lattice } = latticeTarget(store, targetId);
    const before = cloneLattice(lattice);
    const flipped = orientFaces(lattice);
    if (flipped === 0) {
      return { ok: true, id: targetId, flipped: 0, ...latticeSummary(lattice) };
    }
    pushLatticeHistory(targetId, before);
    commitLattice(node, lattice);
    return { ok: true, id: targetId, flipped, ...latticeSummary(lattice), undoDepth: (latticeHistory.get(targetId) ?? []).length };
  },
  LATTICE_WALL: async (msg, { store }) => {
    const { targetId, thicknessMm } = msg as Msg<{ targetId: string }>;
    const { node } = latticeTarget(store, targetId);
    const mm = parseThicknessMm(thicknessMm, 'thicknessMm');
    useStore.getState().setLatticeThickness(node.id, mm);
    const after = findNodeInScene(useStore.getState().sceneGraph.nodes, node.id);
    const mesh = after?.geoms?.find((g: SceneGeom) => g.latticeGeom)
      ?? after?.geoms?.find((g: SceneGeom) => g.type === 'mesh' && !g.csgDerived);
    return {
      ok: true, id: node.id, thicknessMm: mm,
      ...latticeSummary(latticeOf(after)),
      // The CAGE stays open — the wall is built when the mesh is, so the
      // watertight figure above is about the surface being edited and
      // this is about the thing that gets exported.
      meshTriangles: mesh?.faces ? mesh.faces.length / 3 : 0,
    };
  },
  UNDO_LATTICE: async (msg, { store }) => {
    const { targetId } = msg as Msg<{ targetId: string }>;
    const { node } = latticeTarget(store, targetId);
    const stack = latticeHistory.get(node.id) ?? [];
    const snapshot = stack.pop();
    if (!snapshot) return { ok: false, error: 'No lattice operation of mine left to undo on this body', undoDepth: 0 };
    latticeHistory.set(node.id, stack);
    commitLattice(node, snapshot);
    return { ok: true, id: node.id, undoDepth: stack.length, ...latticeSummary(snapshot) };
  },
  GET_LATTICE: async (msg, { store }) => {
    const { targetId } = msg as Msg<{ targetId: string }>;
    const { node, lattice } = latticeTarget(store, targetId);
    return { ok: true, id: targetId, ...describeLattice(lattice), cageOriginMm: cageOriginInBodyMm(node) };
  },
};
