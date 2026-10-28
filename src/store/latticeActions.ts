// ---------------------------------------------------------------------------
// The store's lattice mode: the cage being edited, its tools and drawing
// plane, and turning a cage into a body (applyLattice, separateLattice,
// bakeLattice)
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { SceneNode, SceneGeom, SceneJoint } from '../types/scene';
import {
  deserializeCage, serializeCage, separablePieces, DRAWING_TOOLS, toSceneGeom as latticeToSceneGeom,
  type Axis as LatticeAxis, type LatticeCage, type SnapMultiple, type LatticeTool,
} from '../utils/latticeMesh';
import { reconcileCuts } from '../utils/csg';
import { cloneSceneGraph, findNode } from './sceneClone';
import { getPhysicsWorkerClient } from './physicsEngine';
import { initialFraming, snapForGridMm } from './sceneFraming';
import type { PhysicsState } from './useStore';
import type { SliceDeps } from './sliceDeps';
import { generatedMeshMass } from '../utils/generatedMeshMass';

export interface LatticeActions {
  // The state here is the state of the TOOL, not of the shape: the shape lives
  // on the node as `latticeCage`, because it has to survive being saved and the
  // tool does not. See utils/latticeMesh.ts.
  /** The body being modelled, or null when the lattice tools are closed. */
  latticeNodeId: string | null;
  latticeTool: LatticeTool;
  /**
   * The slice of the grid that clicks land on. Everything about placing a point
   * in three dimensions with a two-dimensional pointer comes down to this: a
   * ray hits infinitely many grid points, and exactly one plane.
   */
  latticePlane: { axis: LatticeAxis; index: number };
  /** How many grid steps a click snaps to. Powers of two only — see SNAP_MULTIPLES. */
  latticeSnap: SnapMultiple;
  /** Mirror every placement across this axis through the body origin. */
  latticeMirror: LatticeAxis | null;
  /**
   * Whether the pointer is being held to the work plane, for whatever reason:
   * Ctrl held, the hold below switched on, or a drawing tool in hand. Set by
   * the viewport, which is the only thing that knows all three.
   */
  latticePlaneLocked: boolean;
  /**
   * The work plane held still without a key held down — the panel's lock
   * button, or Caps Lock, whose light then says whether the plane is held.
   *
   * Separate from `latticePlaneLocked` because that is the EFFECT and this is
   * one of its causes: Ctrl is a moment, this is a decision, and a decision has
   * to survive letting go of the keyboard.
   */
  latticePlaneHold: boolean;
  /**
   * Bumped to ask the viewport to turn every face the right way round.
   *
   * A request rather than a scene-graph edit: the editor holds the live cage
   * while it is open, so a repair written straight to the node would either be
   * overwritten by the next commit or force a remount that throws away the
   * undo history the repair most needs to be part of.
   */
  latticeOrientRequest: number;
  /** What the panel shows: counts and whether the surface has closed. */
  latticeStats: { vertices: number; faces: number; quads: number; tris: number; creases: number; inconsistent: number; watertight: boolean; parts: number } | null;
  /**
   * What is selected in the editor, measured — the numbers the panel puts in
   * boxes you can type into.
   *
   * Published by the viewport rather than derived from the node, because the
   * selection and the live cage both belong to the editor while it is open; the
   * scene graph only hears about whole operations.
   *
   * Extents and positions are in millimetres on the cage's own grid, which is
   * the frame every lattice tool already speaks. An axis whose extent is zero —
   * a face seen edge-on, a loop lying in a plane — has a position and no size,
   * and the panel says so rather than offering a box that cannot do anything.
   */
  latticeSelection: {
    kind: 'face' | 'faces' | 'edge' | 'loop' | 'corner' | 'corners';
    corners: number;
    minMm: number[];
    maxMm: number[];
  } | null;
  /**
   * Asks the viewport to make the selection a given size, or to put it at a
   * given place, on one axis.
   *
   * A request for the same reason orienting is one: the cage the numbers would
   * be written to is the editor's, not the node's. `nonce` is what makes two
   * identical edits in a row two edits — typing 20 twice on a selection that
   * has drifted has to work the second time.
   */
  latticeResizeRequest: { axis: LatticeAxis; mode: 'size' | 'position'; mm: number; nonce: number } | null;
  setLatticeNodeId: (id: string | null) => void;
  setLatticeTool: (tool: LatticeTool) => void;
  setLatticePlane: (plane: { axis: LatticeAxis; index: number }) => void;
  /** Steps the work plane along its own axis. The keyboard's main job here. */
  nudgeLatticePlane: (delta: number) => void;
  setLatticeSnap: (snap: SnapMultiple) => void;
  setLatticeMirror: (axis: LatticeAxis | null) => void;
  setLatticePlaneLocked: (locked: boolean) => void;
  setLatticePlaneHold: (hold: boolean) => void;
  requestLatticeOrient: () => void;
  setLatticeSelection: (selection: PhysicsState['latticeSelection']) => void;
  requestLatticeResize: (axis: LatticeAxis, mode: 'size' | 'position', mm: number) => void;
  /**
   * How much a chamfer or fillet takes off a selected edge, in millimetres.
   *
   * A setting rather than a gesture. Every other size in the lattice tools is
   * dragged out with the pointer, but a fillet radius is almost always a number
   * somebody already has — it is the cutter they own, or the radius the mating
   * part needs — and dragging until the readout says 3.00 is a poor way to ask
   * for 3 mm. It is also the one number that has to survive between operations,
   * because a part wants the same radius on every edge.
   */
  latticeBevelMm: number;
  setLatticeBevelMm: (mm: number) => void;
  /** Asks the viewport to chamfer or round the edges it has selected. */
  latticeBevelRequest: { mode: 'chamfer' | 'fillet'; mm: number; nonce: number } | null;
  requestLatticeBevel: (mode: 'chamfer' | 'fillet', mm: number) => void;
  /**
   * How many corners the shape tool's ring gets. Zero means "as many as it
   * takes to be round", which is what a circle is on a grid — see circleSides.
   */
  latticeShapeSides: number;
  setLatticeShapeSides: (sides: number) => void;
  /** Asks the viewport to sweep the selected profile about one of the axes. */
  latticeRevolveRequest: { axis: LatticeAxis; degrees: number; nonce: number } | null;
  requestLatticeRevolve: (axis: LatticeAxis, degrees: number) => void;
  setLatticeStats: (stats: { vertices: number; faces: number; quads: number; tris: number; creases: number; inconsistent: number; watertight: boolean; parts: number } | null) => void;
  /**
   * Writes a cage to a node and rebuilds its mesh from it, in one go.
   *
   * One action rather than a geom update followed by a node update, because
   * those are two scene-graph writes and therefore two MuJoCo recompiles for
   * what is one edit.
   */
  applyLattice: (nodeId: string, cage: LatticeCage, subdiv?: number, quiet?: boolean) => void;
  /**
   * Breaks a lattice that is several separate pieces into one body per piece,
   * each with its own cage, at the same place in the world. The first piece
   * keeps the body; the rest are new bodies beside it. Nothing moves — this
   * is what makes it possible to move one piece against another afterwards,
   * or hand one to the other with Subtract.
   */
  separateLattice: (nodeId: string) => void;
  /**
   * Applies the cage: the mesh stops being derived and becomes the document.
   *
   * Sculpting is the only thing that asks for this, and it has to ask, because
   * the two tools cannot both own one mesh — see SceneNode.latticeBaked. An
   * ordinary undo step, so the cage comes back with Ctrl+Z.
   */
  bakeLattice: (nodeId: string) => void;
  /** Changes how many smoothing passes a lattice body's mesh is built with. */
  setLatticeSubdiv: (nodeId: string, level: number) => void;
  /** Sets a lattice body's wall thickness in millimetres; 0 leaves it a surface. */
  setLatticeThickness: (nodeId: string, mm: number) => void;
}

export function latticeActions({ set, get }: SliceDeps): LatticeActions {
  return {
    latticeNodeId: null,

    latticeTool: 'place',

    latticePlane: { axis: 'z', index: 0 },

    // The step the grid on screen is drawn at — 10 mm for most parts, with
    // 0.1 mm a held Alt away. This used to be a fixed 1000 (100 mm) under a
    // 10 mm grid, so clicks landed on every tenth line of what was shown.
    latticeSnap: snapForGridMm(initialFraming.gridCellSizeMm),

    latticeMirror: null,

    latticePlaneLocked: false,

    latticePlaneHold: false,

    latticeOrientRequest: 0,

    latticeStats: null,

    latticeSelection: null,

    latticeResizeRequest: null,

    // Opening one modelling mode closes the other: both take over the drawing of
    // the body they are on and both bind the pointer, and two of them at once is
    // two components fighting over one mesh.
    // The worker is paused too, for the same reason as setSculptNodeId.
    setLatticeNodeId: (id) => {
      if (id && typeof Worker !== 'undefined') getPhysicsWorkerClient().setPlaying(false);
      set(id
        ? { latticeNodeId: id, sculptNodeId: null, selectedNodeId: id, isPlaying: false }
        : { latticeNodeId: null, latticeStats: null, latticeSelection: null, latticePlaneHold: false, cutSpot: null });
    },

    // Picking up a drawing tool holds the plane, since a stroke is flat; it is
    // the hold that can be let go of again, not a lock the tool insists on.
    setLatticeTool: (tool) => set(DRAWING_TOOLS.has(tool) ? { latticeTool: tool, latticePlaneHold: true } : { latticeTool: tool }),

    setLatticePlane: (plane) => set({ latticePlane: plane }),

    nudgeLatticePlane: (delta) => set((state) => ({
      latticePlane: { ...state.latticePlane, index: state.latticePlane.index + delta },
    })),

    setLatticeSnap: (snap) => set({ latticeSnap: snap }),

    setLatticeMirror: (axis) => set({ latticeMirror: axis }),

    setLatticePlaneLocked: (lockedNow) => set((state) => (
      state.latticePlaneLocked === lockedNow ? {} : { latticePlaneLocked: lockedNow }
    )),

    setLatticePlaneHold: (hold) => set((state) => (state.latticePlaneHold === hold ? {} : { latticePlaneHold: hold })),

    requestLatticeOrient: () => set((state) => ({ latticeOrientRequest: state.latticeOrientRequest + 1 })),

    setLatticeSelection: (selection) => set({ latticeSelection: selection }),

    requestLatticeResize: (axis, mode, mm) => set((state) => ({
      latticeResizeRequest: { axis, mode, mm, nonce: (state.latticeResizeRequest?.nonce ?? 0) + 1 },
    })),

    latticeBevelMm: 1,

    setLatticeBevelMm: (mm) => set({ latticeBevelMm: Math.max(0, mm) }),

    latticeBevelRequest: null,

    requestLatticeBevel: (mode, mm) => set((state) => ({
      latticeBevelRequest: { mode, mm, nonce: (state.latticeBevelRequest?.nonce ?? 0) + 1 },
    })),

    latticeShapeSides: 0,

    setLatticeShapeSides: (sides) => set({ latticeShapeSides: Math.max(0, Math.floor(sides)) }),

    latticeRevolveRequest: null,

    requestLatticeRevolve: (axis, degrees) => set((state) => ({
      latticeRevolveRequest: { axis, degrees, nonce: (state.latticeRevolveRequest?.nonce ?? 0) + 1 },
    })),

    setLatticeStats: (stats) => set({ latticeStats: stats }),

    applyLattice: (nodeId, cage, subdiv, quiet) => {
      get().recordInteraction('lattice');
      const newScene = cloneSceneGraph(get().sceneGraph);
      const traverse = (nodes: SceneNode[]): boolean => {
        if (!nodes) return false;
        for (const node of nodes) {
          if (node.id === nodeId) {
            const level = subdiv ?? node.latticeSubdiv ?? 0;
            const { vertices, renderVertices, faces, origin } = latticeToSceneGeom(
              deserializeCage(cage), level, node.latticeThickness ?? 0,
            );
            /*
              The cage owns ONE geom, and it says so. A lattice body may now carry
              other shapes — a cut to subtract, and the boolean evaluator's own
              output, which is a mesh too — so "the first mesh geom" long ago
              stopped naming one thing. Older saves have no marker, so the first
              mesh that isn't generated is adopted as the cage's and marked.
            */
            const geom = node.geoms?.find((g: SceneGeom) => g.latticeGeom)
              ?? node.geoms?.find((g: SceneGeom) => g.type === 'mesh' && !g.csgDerived)
              ?? node.geoms?.[0];
            if (geom) Object.assign(geom, { vertices, renderVertices, faces, latticeGeom: true });

            /*
              The mesh comes back centred on its own centre of mass, so the body
              spins about the shape rather than swinging it around a point off to
              one side — see latticeMesh.toSceneGeom. The body then has to move by
              however much the shape moved, or extruding away from the origin
              would drag the whole thing across the scene.

              The offset is in the body's own axes, so it is rotated into world
              space by the body's own orientation before it is added to a world
              position. Only the CHANGE is applied: the offset already baked into
              the mesh is remembered on the node, because every commit recomputes
              it from scratch.
            */
            const previous = node.latticeOrigin ?? [0, 0, 0];
            const local = [
              origin[0] - previous[0],
              origin[1] - previous[1],
              origin[2] - previous[2],
            ];
            const delta = new THREE.Vector3(local[0], local[1], local[2]);
            if (delta.lengthSq() > 0) {
              /*
                Everything else on the body is positioned in the body's frame, and
                the recentring below moves the body out from under it. A cut sits
                where it was put ON THE SHAPE — so the shapes that aren't the cage's
                are walked back by the same amount the cage's vertices just moved,
                or extruding a face on one side of a part would drag the hole on
                the other side along with it.
              */
              for (const other of node.geoms ?? []) {
                if (other === geom || other.csgDerived) continue;
                // A cut is rebuilt from its anchor by reconcileCuts below, which
                // throws its `pos` away — so it is the anchor that has to walk
                // back. Walking only `pos` slid every hole sideways off the spot
                // it was put on, and left a face prism a stray offset that grew
                // with every edit.
                if (other.cutAt && other.cutNormal) {
                  other.cutAt = other.cutAt.map((v, a) => v - local[a]);
                  continue;
                }
                const at = other.pos ?? [0, 0, 0];
                other.pos = [at[0] - local[0], at[1] - local[1], at[2] - local[2]];
              }
              if (node.quat) {
                delta.applyQuaternion(new THREE.Quaternion(node.quat[1], node.quat[2], node.quat[3], node.quat[0]));
              } else if (node.euler) {
                const rad = (d: number) => (d * Math.PI) / 180;
                delta.applyEuler(new THREE.Euler(rad(node.euler[0]), rad(node.euler[1]), rad(node.euler[2]), 'XYZ'));
              }
              node.pos = [
                (node.pos?.[0] ?? 0) + delta.x,
                (node.pos?.[1] ?? 0) + delta.y,
                (node.pos?.[2] ?? 0) + delta.z,
              ];
              // basePos is what the rotation code rewinds to; leaving it behind
              // would teleport the body back to where the shape used to be the
              // next time somebody turned a rotation slider.
              if (node.basePos) node.basePos = [...node.pos];
            }

            /*
              And the cuts follow the shape. The walk-back above keeps a cut where
              it was put ACROSS its face; this puts it back at the right depth
              INTO it, now that the face has moved. Without it, pushing the top of
              a part up leaves a hole sealed inside the material — a void nothing
              in the viewport shows.
            */
            reconcileCuts(node);

            node.latticeOrigin = origin;
            node.latticeCage = cage;
            node.latticeSubdiv = level;
            node.latticeEdited = true;
            return true;
          }
          if (traverse(node.children)) return true;
        }
        return false;
      };
      if (traverse(newScene.nodes)) {
        set({ sceneGraph: newScene });
        // `quiet` for all but the last of a batch: several bodies rebuilt in a
        // row each asking for a compile recycles the worker under the earlier
        // ones, which fail, loudly, for nothing.
        if (!quiet) get().recompile(newScene, undefined, true);
      }
    },

    separateLattice: (nodeId) => {
      const node = findNode(get().sceneGraph.nodes, nodeId);
      if (!node?.isLattice || !node.latticeCage) return;
      const pieces = separablePieces(deserializeCage(node.latticeCage));
      if (pieces.length < 2) return;

      get().prepareForDiscreteChange();
      const newScene = cloneSceneGraph(get().sceneGraph);
      const first = findNode(newScene.nodes, nodeId);
      if (!first) return;
      first.latticeCage = serializeCage(pieces[0]);
      first.latticeVersion = (first.latticeVersion ?? 1) + 1;

      const cageGeom = (first.geoms || []).find((g: SceneGeom) => g.latticeGeom) ?? first.geoms?.[0];
      const ids: string[] = [nodeId];
      // The parent the original hangs from, so the pieces hang there too and
      // the copied pose means the same thing.
      const siblings = (() => {
        const walk = (list: SceneNode[]): SceneNode[] | null => {
          for (const n of list) {
            if (n.id === nodeId) return list;
            const found = walk(n.children || []);
            if (found) return found;
          }
          return null;
        };
        return walk(newScene.nodes) ?? newScene.nodes;
      })();
      pieces.slice(1).forEach((piece) => {
        const id = `lattice_${Math.random().toString(36).substring(2, 10)}`;
        ids.push(id);
        /*
          The same pose and the same cage frame: every piece's coordinates are
          the original cage's, so a copy of the original's origin puts the piece
          exactly where it was drawn, and applyLattice then recentres each body
          on its own piece by the difference — which is how the original works
          after any edit.
        */
        siblings.push({
          id,
          name: id,
          type: 'body',
          pos: [...(first.pos ?? [0, 0, 0])],
          ...(first.quat ? { quat: [...first.quat] } : {}),
          ...(first.euler ? { euler: [...first.euler] } : {}),
          joints: (first.joints || []).map((j: SceneJoint) => ({ ...j, name: `${id}_${String(j.name || 'joint').split('_').pop()}` })),
          isLattice: true,
          latticeCage: serializeCage(piece),
          latticeSubdiv: first.latticeSubdiv ?? 0,
          latticeThickness: first.latticeThickness,
          latticeVersion: 1,
          latticeOrigin: [...(first.latticeOrigin ?? [0, 0, 0])],
          geoms: [{
            name: `${id}_mesh`,
            type: 'mesh',
            size: [1],
            rgba: [...(cageGeom?.rgba ?? [0.55, 0.68, 0.85, 1])],
            // Each piece weighs its own volume unless the original was given a mass.
            ...generatedMeshMass(cageGeom),
            condim: cageGeom?.condim ?? 3,
            dynamic: true,
            vertices: [],
            faces: [],
            renderVertices: [],
            latticeGeom: true,
          }],
          children: [],
        });
      });
      set({ sceneGraph: newScene, extraSelectedIds: [] });
      // Rebuilds each body's mesh from its cage and recentres it; the last one
      // recompiles with all of them in place.
      ids.forEach((id, i) => {
        const n = findNode(get().sceneGraph.nodes, id);
        if (n?.latticeCage) get().applyLattice(id, n.latticeCage, n.latticeSubdiv ?? 0, i < ids.length - 1);
      });
    },

    bakeLattice: (nodeId) => {
      const node = findNode(get().sceneGraph.nodes, nodeId);
      if (!node?.isLattice) return;
      get().prepareForDiscreteChange();
      const newScene = cloneSceneGraph(get().sceneGraph);
      const baked = findNode(newScene.nodes, nodeId);
      if (!baked) return;
      baked.isLattice = false;
      baked.latticeBaked = true;
      // The cage itself is left alone. It costs a few hundred integers, it is
      // the only record of how the shape was built, and undo needs it to be
      // there when it turns `isLattice` back on.
      set({ sceneGraph: newScene });
      if (get().latticeNodeId === nodeId) {
        set({ latticeNodeId: null, latticeStats: null, latticeSelection: null, latticePlaneHold: false, cutSpot: null });
      }
    },

    setLatticeSubdiv: (nodeId, level) => {
      const node = findNode(get().sceneGraph.nodes, nodeId);
      if (!node?.latticeCage) return;
      get().applyLattice(nodeId, node.latticeCage, Math.max(0, Math.min(2, Math.round(level))));
    },

    setLatticeThickness: (nodeId, mm) => {
      const node = findNode(get().sceneGraph.nodes, nodeId);
      if (!node?.latticeCage) return;
      // Written to the node first, because applyLattice reads the thickness off
      // the node when it builds the mesh — the same ordering the version bump
      // needs, and for the same reason.
      get().updateNode(nodeId, { latticeThickness: Math.max(0, mm) / 1000 });
      get().applyLattice(nodeId, node.latticeCage, node.latticeSubdiv ?? 0);
    },
  };
}
