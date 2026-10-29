// ---------------------------------------------------------------------------
// MCP lattice commands: create a cage, edit it, undo, read it back
// ---------------------------------------------------------------------------

import { useStore } from '../../store/useStore';
import {
  addFacesMm, addRingMm, bevelEdgesMm, bevelFaceMm, bridgeFacesMm, describeLattice,
  dimensionSelectionMm, extrudeMm, insetFaceMm, latticeSummary, removeFacesMm, revolveMm,
  sharpenEdgesMm,
} from '../../utils/latticeCommands';
import type { SceneNode, SceneGeom } from '../../types/scene';
import {
  boxLattice, cloneLattice, createLattice, deserializeCage, orientFaces, serializeCage,
  toSceneGeom as latticeToSceneGeom, DEFAULT_UNIT as LATTICE_UNIT, type Axis as LatticeAxis,
} from '../../utils/latticeMesh';
import { type Msg, resolveParent, withChild, findNodeInScene } from './bridgeUtils';
import {
  latticeHistory, latticeOf, latticeTarget, pushLatticeHistory, commitLattice, runLatticeOps,
} from './latticeState';
import { settleScene } from './settleScene';
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
    const position: [number, number, number] = Array.isArray(pos) && pos.length === 3 ? [pos[0], pos[1], pos[2]] : [0, 0, 0.2];
    const firstOp = Array.isArray(ops) && ops.length > 0
      ? String(ops[0]?.op ?? ops[0]?.type ?? '').toLowerCase()
      : '';
    const startEmpty = empty === true || sizeMm === 0 || (sizeMm === undefined && firstOp === 'revolve');
    const size = typeof sizeMm === 'number' && sizeMm > 0 ? sizeMm : 40;
    const halfSteps = Math.max(1, Math.round((size / 2) / (LATTICE_UNIT * 1000)));

    const id = `lattice_${Math.random().toString(36).substring(2, 10)}`;
    const lat = startEmpty ? createLattice(LATTICE_UNIT) : boxLattice(LATTICE_UNIT, halfSteps);
    const { subdiv, thicknessMm } = runLatticeOps(
      lat,
      Array.isArray(ops) ? ops : [],
      typeof initSubdiv === 'number' ? initSubdiv : 0,
      typeof initThickness === 'number' ? initThickness : 0,
    );
    const cage = serializeCage(lat);
    const { vertices, renderVertices, faces, origin } = latticeToSceneGeom(deserializeCage(cage), subdiv, thicknessMm / 1000);

    const newNode: SceneNode = {
      id,
      name: (typeof name === 'string' && name.trim()) ? name.trim() : 'Lattice',
      type: 'body',
      pos: position,
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
    const updatedNodes = parent ? withChild(currentNodes, parent.id, newNode) : [...currentNodes, newNode];
    const settleRes = await settleScene(updatedNodes, { replacesScene: false });
    if (!settleRes.ok) {
      throw new Error(`The lattice body failed to compile: ${settleRes.error}`);
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
    };
  },
  LATTICE_FACES: async (msg, { store }) => {
    const { targetId, faces, mirror } = msg as Msg<{ targetId: string }>;
    const { node, lattice } = latticeTarget(store, targetId);
    const before = cloneLattice(lattice);
    const result = addFacesMm(lattice, faces, mirror as LatticeAxis | undefined);
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
    const before = cloneLattice(lattice);
    const result = extrudeMm(lattice, face, distanceMm, axis as LatticeAxis | undefined, mirror as LatticeAxis | undefined);
    pushLatticeHistory(targetId, before);
    commitLattice(node, lattice);
    return { ok: true, id: targetId, ...result, ...latticeSummary(lattice), undoDepth: (latticeHistory.get(targetId) ?? []).length };
  },
  LATTICE_DELETE_FACES: async (msg, { store }) => {
    const { targetId, faces, mirror } = msg as Msg<{ targetId: string }>;
    const { node, lattice } = latticeTarget(store, targetId);
    const before = cloneLattice(lattice);
    const result = removeFacesMm(lattice, faces, mirror as LatticeAxis | undefined);
    if (result.removed === 0) {
      return { ok: false, id: targetId, error: 'No face was removed', ...result, ...latticeSummary(lattice) };
    }
    pushLatticeHistory(targetId, before);
    commitLattice(node, lattice);
    return { ok: true, id: targetId, ...result, ...latticeSummary(lattice), undoDepth: (latticeHistory.get(targetId) ?? []).length };
  },
  LATTICE_SHARPEN: async (msg, { store }) => {
    const { targetId, edges, sharp, mirror, loop } = msg as Msg<{ targetId: string }>;
    const { node, lattice } = latticeTarget(store, targetId);
    const before = cloneLattice(lattice);
    const result = sharpenEdgesMm(lattice, edges, sharp !== false, mirror as LatticeAxis | undefined, loop === true);
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
    const wanted = Math.max(0, Math.min(2, Math.round(Number(level) || 0)));
    useStore.getState().setLatticeSubdiv(node.id, wanted);
    const after = findNodeInScene(useStore.getState().sceneGraph.nodes, node.id);
    const mesh = after?.geoms?.find((g: SceneGeom) => g.type === 'mesh');
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
    const before = cloneLattice(lattice);
    const result = insetFaceMm(lattice, face, amountMm, mirror as LatticeAxis | undefined);
    pushLatticeHistory(targetId, before);
    commitLattice(node, lattice);
    return { ok: true, id: targetId, ...result, ...latticeSummary(lattice), undoDepth: (latticeHistory.get(targetId) ?? []).length };
  },
  LATTICE_BEVEL: async (msg, { store }) => {
    const { targetId, face, amountMm, mirror } = msg as Msg<{ targetId: string; amountMm: number }>;
    const { node, lattice } = latticeTarget(store, targetId);
    const before = cloneLattice(lattice);
    const result = bevelFaceMm(lattice, face, amountMm, mirror as LatticeAxis | undefined);
    pushLatticeHistory(targetId, before);
    commitLattice(node, lattice);
    return { ok: true, id: targetId, ...result, ...latticeSummary(lattice), undoDepth: (latticeHistory.get(targetId) ?? []).length };
  },
  LATTICE_BEVEL_EDGES: async (msg, { store }) => {
    const { targetId, edges, radiusMm, mode, mirror, loop } = msg as Msg<{ targetId: string; radiusMm: number }>;
    const { node, lattice } = latticeTarget(store, targetId);
    const before = cloneLattice(lattice);
    const result = bevelEdgesMm(
      lattice, edges, radiusMm,
      mode === 'fillet' ? 'fillet' : 'chamfer',
      mirror as LatticeAxis | undefined,
      loop === true,
    );
    pushLatticeHistory(targetId, before);
    commitLattice(node, lattice);
    return { ok: true, id: targetId, ...result, ...latticeSummary(lattice), undoDepth: (latticeHistory.get(targetId) ?? []).length };
  },
  LATTICE_CIRCLE: async (msg, { store }) => {
    const { targetId, centre, diameterMm, axis, sides, mirror } = msg as Msg<{ targetId: string; diameterMm: number }>;
    const { node, lattice } = latticeTarget(store, targetId);
    const before = cloneLattice(lattice);
    const result = addRingMm(
      lattice, centre, diameterMm,
      (axis as LatticeAxis) || 'z',
      typeof sides === 'number' ? sides : 0,
      mirror as LatticeAxis | undefined,
    );
    pushLatticeHistory(targetId, before);
    commitLattice(node, lattice);
    return { ok: true, id: targetId, ...result, ...latticeSummary(lattice), undoDepth: (latticeHistory.get(targetId) ?? []).length };
  },
  LATTICE_REVOLVE: async (msg, { store }) => {
    const { targetId, profile, axis, degrees, throughMm, segments, closed } = msg as Msg<{ targetId: string }>;
    const { node, lattice } = latticeTarget(store, targetId);
    const before = cloneLattice(lattice);
    const result = revolveMm(
      lattice, profile, (axis as LatticeAxis) || 'z',
      typeof degrees === 'number' ? degrees : 360,
      {
        throughMm: Array.isArray(throughMm) ? throughMm : undefined,
        segments: typeof segments === 'number' ? segments : 0,
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
    const which = (axis === 'x' || axis === 'y' || axis === 'z') ? axis : null;
    if (!which) return { ok: false, error: "axis must be 'x', 'y' or 'z'" };
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
    const mm = Math.max(0, Number(thicknessMm) || 0);
    useStore.getState().setLatticeThickness(node.id, mm);
    const after = findNodeInScene(useStore.getState().sceneGraph.nodes, node.id);
    const mesh = after?.geoms?.find((g: SceneGeom) => g.type === 'mesh');
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
    const { lattice } = latticeTarget(store, targetId);
    return { ok: true, id: targetId, ...describeLattice(lattice) };
  },
};
