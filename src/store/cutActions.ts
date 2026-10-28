// ---------------------------------------------------------------------------
// The store's cuts: holes, pockets, bosses and hardware features (nut traps,
// bearing seats, threads) put into a body, and moved or resized on it
//
// A cut is a boolean shape anchored to a spot on the body's surface; every
// edit changes the anchor or depth and works the shape out again from there.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { SceneNode, SceneGeom, HardwareCutKind } from '../types/scene';
import type { GeomThreadSpec } from '../utils/metricThreads';
import { hardwareCutGeoms, hardwareCutProblem, hardwareSpecOf, nextHardwareGroup, type HardwareCutSpec } from '../utils/hardwareCuts';
import { reseatHardware } from '../utils/hardwareParts';
import {
  type CutSpot, type FaceRegion, CSG_DEFAULT_SECTORS, insetPolygon, faceUnderFeature, cutGeometry,
  sourcePositiveBounds, pickCutSpot,
} from '../utils/csg';
import { cloneSceneGraph, findNode } from './sceneClone';
import type { PhysicsWindow } from './physicsEngine';
import { rebuildAfterGeomEdit, settleBooleanState } from './geomEdits';
import type { PhysicsState } from './useStore';
import type { SliceDeps } from './sliceDeps';

/**
 * The spot on a body the camera is looking at, or null when there is no
 * viewport to ask or the look misses.
 *
 * A new hole belongs where you are looking. This is the fallback when nothing
 * has been picked: a ray from the eye to the middle of the part, landing on
 * whatever surface it meets first, facing whichever way that surface faces.
 *
 * The camera is read off the window global the viewport publishes, the same one
 * the screenshot bridge uses: this runs in the store, which is outside the
 * canvas and has no other way to reach it. The body's own rotation is undone
 * first, so the ray is cast in the frame the geoms are written in.
 */
function cutSpotFromCamera(node: SceneNode): CutSpot | null {
  const camera = typeof window !== 'undefined' ? (window as PhysicsWindow)._physics_camera : null;
  const bounds = sourcePositiveBounds(node);
  if (!camera?.position || !bounds) return null;
  try {
    // The viewport is Y-up and MuJoCo is Z-up; the geoms this is cast against
    // are in MuJoCo's axes, so the camera is brought over rather than the other
    // way round.
    const eye = new THREE.Vector3(camera.position.x, -camera.position.z, camera.position.y);
    eye.sub(new THREE.Vector3(node.pos?.[0] ?? 0, node.pos?.[1] ?? 0, node.pos?.[2] ?? 0));
    if (node.quat) {
      eye.applyQuaternion(
        new THREE.Quaternion(node.quat[1], node.quat[2], node.quat[3], node.quat[0]).invert(),
      );
    } else if (node.euler) {
      const rad = (d: number) => (d * Math.PI) / 180;
      const euler = new THREE.Euler(rad(node.euler[0]), rad(node.euler[1]), rad(node.euler[2]), 'XYZ');
      eye.applyQuaternion(new THREE.Quaternion().setFromEuler(euler).invert());
    }
    const middle = [0, 1, 2].map(a => (bounds.min[a] + bounds.max[a]) / 2);
    const dir = new THREE.Vector3(middle[0], middle[1], middle[2]).sub(eye);
    if (dir.lengthSq() < 1e-18) return null;
    return pickCutSpot(node, eye.toArray(), dir.normalize().toArray());
  } catch {
    return null;
  }
}

/**
 * Where a new cut goes, in order of how much the app actually knows: the spot
 * handed in; the last surface picked on this body — the face selected in the
 * lattice editor, or wherever an ordinary click landed on it; the spot the
 * camera is looking at; and failing all of that the middle of the top, which
 * is only reached with no viewport at all.
 */
function newCutSpot(
  get: () => PhysicsState,
  target: SceneNode,
  bounds: { min: number[]; max: number[] },
  spot?: CutSpot,
  fromCamera = true,
): CutSpot {
  const picked = get().cutSpot;
  return spot
    ?? (picked?.nodeId === target.id ? { at: picked.at, normal: picked.normal } : null)
    ?? (fromCamera ? cutSpotFromCamera(target) : null)
    ?? {
      at: [0, 1, 2].map(a => +((bounds.min[a] + bounds.max[a]) / 2).toFixed(6)),
      normal: [0, 0, 1],
    };
}

/**
 * Puts a hardware feature's cuts on a node (of a graph the caller cloned), in
 * place of any it had: where the old ones were in the list, or at the end.
 * Placed in order, so a boss is there before the hole bored into it is
 * measured. False when a piece could not be placed.
 */
function writeHardwareGroup(node: SceneNode, spec: HardwareCutSpec): boolean {
  const geoms = node.geoms || [];
  const first = geoms.findIndex((g) => g.hardware?.group === spec.group && !g.csgDerived);
  const kept = geoms.filter((g) => g.hardware?.group !== spec.group);
  const at = first < 0 ? kept.length : geoms.slice(0, first).filter((g) => g.hardware?.group !== spec.group).length;
  const pieces = hardwareCutGeoms(spec, node.id, node);
  // An O-ring groove that does not fit where it was asked for is no groove.
  if (pieces.length === 0) return false;
  node.geoms = kept;
  let insertAt = at;
  for (const piece of pieces) {
    node.geoms.splice(insertAt, 0, piece);
    const derived = cutGeometry(node, piece);
    if (!derived) return false;
    Object.assign(piece, derived);
    insertAt++;
  }
  node.csgEnabled = true;
  if (node.csgCollision === undefined) node.csgCollision = 'auto';
  if (node.csgSectors === undefined) node.csgSectors = CSG_DEFAULT_SECTORS;
  // A bearing in this pocket goes where the pocket went, and is its new size.
  reseatHardware(node);
  return true;
}

/**
 * Edits one cut and re-derives the primitive underneath it.
 *
 * Every cut edit is the same three steps — change the intent, work the geometry
 * out again from the part's own surface, publish — and doing them in one place
 * is what keeps `pos`, `quat` and `size` from ever disagreeing with the spot
 * and depth they are supposed to express.
 */
function reshapeCut(
  get: () => PhysicsState,
  set: (partial: Partial<PhysicsState>) => void,
  nodeId: string,
  geomIndex: number,
  kind: string,
  edit: (geom: SceneGeom) => void,
) {
  // Coalesced by kind rather than snapshotted outright: these fields report
  // every keystroke, and one undo step per digit of "6.35" makes Ctrl+Z useless
  // exactly where a typed number is most likely to be a typo.
  get().recordInteraction(kind);
  const newScene = cloneSceneGraph(get().sceneGraph);
  const node = findNode(newScene.nodes, nodeId);
  const geom = node?.geoms?.[geomIndex];
  // A boss is a cut stood on the face rather than sunk into it: the same
  // anchor, the same edits.
  const isCut = geom?.csg === 'difference' || (geom?.csg === 'union' && !!geom.cutNormal);
  if (!node || !geom || !isCut || geom.csgDerived) return;
  edit(geom);
  const next = cutGeometry(node, geom);
  if (next) Object.assign(geom, next);
  set({ sceneGraph: newScene });
  rebuildAfterGeomEdit(get, newScene, nodeId);
}

export interface CutActions {
  /**
   * Where the next cut on this body should go: a point on its surface and the
   * way the surface faces there, both in the BODY's frame.
   *
   * Published by the viewport, because that is where surfaces are picked. Two
   * things feed it — the face selected in the lattice editor, and an ordinary
   * click on any other body, which already raycasts to select it and now says
   * where it landed. Either way a hole goes exactly where you pointed, square
   * to the surface, and that is the same sentence for a lattice, a mesh, an
   * imported STL and a primitive.
   *
   * Not on the cage's grid, unlike the figures in `latticeSelection`: the two
   * differ by however far a lattice mesh was recentred on its centre of mass.
   */
  cutSpot: { nodeId: string; at: number[]; normal: number[] } | null;
  setCutSpot: (spot: { nodeId: string; at: number[]; normal: number[] } | null) => void;
  /**
   * Cuts a shape out of a body — any body, not only a lattice one.
   *
   * This is the missing half of the boolean tools. A body's geoms are its
   * boolean program, and until now nothing in the app could put a geom ON a
   * body: dragging a shape in while one was selected made a CHILD BODY, whose
   * geoms belong to a different program entirely and are invisible to the
   * parent's. So a hole could be authored in a preset, in OpenSCAD or over MCP,
   * and nowhere else.
   *
   * On a lattice body it is also the one thing a grid cannot do. Every corner
   * of a cage is a triple of integers, so every shape it can describe lands on
   * the grid — and a 6.35 mm bore does not, at any step worth modelling at. The
   * cage stays editable underneath: the boolean is re-evaluated from the mesh
   * the cage produces, so moving a face moves the material around the hole.
   *
   * `spot` says where on the surface it goes and which way that surface faces;
   * without one it uses whatever was last picked on this body, and failing that
   * the spot the camera is looking at. Returns the index of the geom it added,
   * or -1.
   */
  addBodyCut: (nodeId: string, shape: 'cylinder' | 'box' | 'sphere', spot?: CutSpot) => number;
  /**
   * Cuts a hardware feature — a nut trap, a counterbore, an insert hole or
   * boss, a bearing pocket — into a body at a spot on its surface (or where a
   * plain cut would go without one). Returns the feature's group, or null when
   * the body has nothing solid to cut into.
   */
  addHardwareCut: (nodeId: string, kind: HardwareCutKind, spot?: CutSpot) => string | null;
  /** Why addHardwareCut would refuse this — an O-ring groove with no room — in a sentence, or null. */
  hardwareCutProblemAt: (nodeId: string, kind: HardwareCutKind, spot?: CutSpot) => string | null;
  /** Rebuilds a hardware feature with a new size, bore, fit or spot. */
  setHardwareCut: (nodeId: string, group: string, changes: Partial<Omit<HardwareCutSpec, 'group' | 'kind'>>) => void;
  /**
   * An inset face, pushed in or pulled out: a cut the shape of a flat face (see
   * flatFaceAt) — a box, a disk, or a prism of any other outline — sunk into it
   * as a pocket or stood on it as a boss. `border` is how far in from the
   * face's edges, in metres. `depth` is signed metres: negative into the part,
   * positive out of it; `through` sinks it all the way, however thick the part
   * is or becomes. Nothing is sunk into an open surface. With `index`, reshapes
   * that feature instead of adding one. Returns the feature's geom index, or -1.
   */
  setFaceFeature: (
    nodeId: string,
    region: FaceRegion,
    feature: { border: number; depth: number; through?: boolean },
    index?: number,
  ) => number;
  /** Re-insets a face feature to a border in millimetres, against the face it is on. */
  setFaceFeatureBorder: (nodeId: string, geomIndex: number, borderMm: number) => void;
  /** Moves a cut to another spot on the part, square to the surface there. */
  moveCutTo: (nodeId: string, geomIndex: number, spot: CutSpot) => void;
  /** Sets how deep a cut goes, in millimetres in from the surface; 0 goes through. */
  setCutDepth: (nodeId: string, geomIndex: number, mm: number) => void;
  /**
   * Threads a cylinder, or makes it plain again with null. A hole is tapped; any
   * other cylinder becomes a threaded rod, which makes its body a boolean one.
   * `diameterMm`, when given, sets the major diameter in the same step, so
   * picking a bolt size is one undo.
   */
  setGeomThread: (nodeId: string, geomIndex: number, thread: GeomThreadSpec | null, diameterMm?: number) => void;
  /** Resizes a cut's cross-section, in millimetres, and re-derives its length. */
  setCutSection: (nodeId: string, geomIndex: number, section: number[]) => void;
}

export function cutActions({ set, get }: SliceDeps): CutActions {
  return {
    cutSpot: null,

    setCutSpot: (spot) => set({ cutSpot: spot }),

    addBodyCut: (nodeId, shape, spot) => {
      const target = findNode(get().sceneGraph.nodes, nodeId);
      if (!target) return -1;
      const bounds = sourcePositiveBounds(target);
      if (!bounds) return -1;
      const span = [0, 1, 2].map(a => Math.max(1e-4, bounds.max[a] - bounds.min[a]));

      const where = newCutSpot(get, target, bounds, spot);

      // Sized off the part: a hole that arrives at a seventh of the part's width
      // is one typed number from what you wanted, where a fixed 10 mm is off the
      // model entirely on anything small and a speck on anything large.
      const across = Math.min(span[0], span[1], span[2]);

      get().prepareForDiscreteChange();
      const newScene = cloneSceneGraph(get().sceneGraph);
      const node = findNode(newScene.nodes, nodeId);
      if (!node) return -1;

      const used = (node.geoms || []).filter((g: SceneGeom) => g.csg === 'difference' && !g.csgDerived).length;
      const geom: SceneGeom = {
        name: `${node.id}_cut${used + 1}`,
        type: shape,
        size: shape === 'box'
          ? [+(across * 0.15).toFixed(6), +(across * 0.15).toFixed(6), 0]
          : [+(across * 0.15).toFixed(6), 0],
        csg: 'difference' as const,
        cutAt: where.at.map(v => +v.toFixed(6)),
        cutNormal: where.normal,
        // Straight through to begin with. A hole that goes all the way is the
        // common one, and it is the only starting depth that cannot look like it
        // did nothing.
        cutDepth: 0,
        rgba: [0.9, 0.25, 0.35, 1],
      };
      const derived = cutGeometry(node, geom);
      if (!derived) return -1;
      Object.assign(geom, derived);

      node.geoms = [...(node.geoms || []), geom];
      node.csgEnabled = true;
      if (node.csgCollision === undefined) node.csgCollision = 'auto';
      if (node.csgSectors === undefined) node.csgSectors = CSG_DEFAULT_SECTORS;

      set({ sceneGraph: newScene });
      rebuildAfterGeomEdit(get, newScene, nodeId);
      return node.geoms.length - 1;
    },

    addHardwareCut: (nodeId, kind, spot) => {
      const target = findNode(get().sceneGraph.nodes, nodeId);
      if (!target) return null;
      const bounds = sourcePositiveBounds(target);
      if (!bounds) return null;
      // Not aimed down the camera's line when nothing was clicked: a nut trap
      // goes into a face square to it, and the camera is rarely square to one.
      // The top is where the first one usually goes, and Move takes it anywhere.
      const where = newCutSpot(get, target, bounds, spot, false);
      get().prepareForDiscreteChange();
      const newScene = cloneSceneGraph(get().sceneGraph);
      const node = findNode(newScene.nodes, nodeId);
      if (!node) return null;
      const group = nextHardwareGroup(node.geoms || [], kind);
      if (!writeHardwareGroup(node, { group, kind, size: '', at: where.at, normal: where.normal })) return null;
      const last = (node.geoms || []).reduce((acc, g, i) => (g.hardware?.group === group ? i : acc), -1);
      set({ sceneGraph: newScene, activeGeomIndex: last });
      rebuildAfterGeomEdit(get, newScene, nodeId);
      return group;
    },

    hardwareCutProblemAt: (nodeId, kind, spot) => {
      const target = findNode(get().sceneGraph.nodes, nodeId);
      const bounds = target && sourcePositiveBounds(target);
      if (!target || !bounds) return 'That part has nothing solid to cut into.';
      const where = newCutSpot(get, target, bounds, spot, false);
      return hardwareCutProblem({ group: '', kind, size: '', at: where.at, normal: where.normal }, target);
    },

    setHardwareCut: (nodeId, group, changes) => {
      const current = findNode(get().sceneGraph.nodes, nodeId);
      const spec = current && hardwareSpecOf(current.geoms || [], group);
      if (!spec) return;
      // Coalesced like a cut's own edits: a drag across the part reports every
      // frame, and a typed fit every keystroke.
      get().recordInteraction(`hardware-${changes.at ? 'move' : 'edit'}`);
      const newScene = cloneSceneGraph(get().sceneGraph);
      const node = findNode(newScene.nodes, nodeId);
      if (!node || !writeHardwareGroup(node, { ...spec, ...changes, group, kind: spec.kind })) return;
      set({ sceneGraph: newScene });
      rebuildAfterGeomEdit(get, newScene, nodeId);
    },

    setFaceFeature: (nodeId, region, feature, index) => {
      const raise = !feature.through && feature.depth > 0;
      if (!feature.through && Math.abs(feature.depth) < 1e-7) return -1;
      // A sheet has no inside to sink anything into; a boolean against one is
      // not a part with a pocket in it, it is nothing.
      if (!raise && !region.closed) return -1;
      const border = Math.max(0, feature.border);
      const outline = region.shape === 'polygon' ? (region.outline ? insetPolygon(region.outline, border) : null) : undefined;
      if (outline === null) return -1;
      if (region.shape !== 'polygon' && region.half.some((h) => h - border <= 0)) return -1;
      if (!findNode(get().sceneGraph.nodes, nodeId)) return -1;
      get().prepareForDiscreteChange();
      const newScene = cloneSceneGraph(get().sceneGraph);
      const node = findNode(newScene.nodes, nodeId);
      if (!node) return -1;
      const geoms = [...(node.geoms || [])];
      const existing = index !== undefined ? geoms[index] : undefined;
      if (index !== undefined && !existing?.cutFace) return -1;

      const round = (v: number) => +v.toFixed(6);
      const [h0, h1] = [region.half[0] - border, (region.half[1] ?? region.half[0]) - border];
      const sameKind = existing && (existing.csg === 'union') === raise;
      const count = geoms.filter((g) => g.cutFace && !g.csgDerived && (g.csg === 'union') === raise).length;
      const geom: SceneGeom = {
        ...(existing ?? {}),
        name: sameKind ? existing!.name : `${node.id}_${raise ? 'boss' : 'pocket'}${count + 1}`,
        type: region.shape === 'polygon' ? 'mesh' : region.shape,
        size: region.shape === 'box' ? [round(h0), round(h1), 0] : region.shape === 'cylinder' ? [round(h0), 0] : [1],
        csg: raise ? 'union' : 'difference',
        cutAt: region.at.map(round),
        cutNormal: region.normal.map((v) => +v.toFixed(9)),
        cutDepth: feature.through ? 0 : round(Math.abs(feature.depth)),
        cutFace: true,
        cutBorder: round(border),
      };
      if (outline) {
        // A prism is baked into the body frame by cutGeometry: no size, and no
        // pose of its own to be applied on top.
        geom.cutOutline = outline.map(([x, y]) => [+x.toFixed(7), +y.toFixed(7)]);
        delete geom.pos;
        delete geom.quat;
      } else {
        delete geom.cutOutline;
      }
      if (region.twist) geom.cutTwist = +region.twist.toFixed(9);
      else delete geom.cutTwist;
      // A pocket is red like every negative here. A boss is material, and is the
      // part's colour: a body with no hole in it is not compiled at all, so the
      // boss is drawn as a shape of its own and would otherwise be the default.
      const own = geoms.find((g) => !g.csgDerived && !g.cutFace && (!g.csg || g.csg === 'union') && g.role !== 'visual');
      if (!raise) geom.rgba = [0.9, 0.25, 0.35, 1];
      else if (own?.rgba) geom.rgba = [...own.rgba];
      else delete geom.rgba;

      // Into the list BEFORE it is measured: a boss is left out of its own probe
      // by identity, and the old one it replaces must not still be there to be
      // measured from.
      const at = existing ? index! : geoms.length;
      geoms[at] = geom;
      node.geoms = geoms;
      const derived = cutGeometry(node, geom);
      if (!derived) return -1;
      Object.assign(geom, derived);

      node.csgEnabled = true;
      if (node.csgCollision === undefined) node.csgCollision = 'auto';
      if (node.csgSectors === undefined) node.csgSectors = CSG_DEFAULT_SECTORS;
      set({ sceneGraph: newScene, activeGeomIndex: at });
      rebuildAfterGeomEdit(get, newScene, nodeId);
      return at;
    },

    setFaceFeatureBorder: (nodeId, geomIndex, borderMm) => {
      const node = findNode(get().sceneGraph.nodes, nodeId);
      const feature = node?.geoms?.[geomIndex];
      if (!node || !feature?.cutFace) return;
      const region = faceUnderFeature(node, feature);
      if (!region) return;
      const through = feature.csg === 'difference' && !(feature.cutDepth && feature.cutDepth > 0);
      const depth = feature.csg === 'union' ? (feature.cutDepth ?? 0) : -(feature.cutDepth ?? 0);
      // Too wide a border closes the face up, and setFaceFeature refuses it:
      // the feature is left as it was rather than lost.
      get().setFaceFeature(nodeId, region, { border: Math.max(0, borderMm) / 1000, depth, through }, geomIndex);
    },

    moveCutTo: (nodeId, geomIndex, spot) => {
      // A piece of a hardware feature takes the rest of the feature with it.
      const group = findNode(get().sceneGraph.nodes, nodeId)?.geoms?.[geomIndex]?.hardware?.group;
      if (group) {
        get().setHardwareCut(nodeId, group, { at: spot.at.map(v => +v.toFixed(6)), normal: [...spot.normal] });
        return;
      }
      reshapeCut(get, set, nodeId, geomIndex, 'cut-move', (geom) => {
        geom.cutAt = spot.at.map(v => +v.toFixed(6));
        geom.cutNormal = spot.normal;
      });
    },

    setCutDepth: (nodeId, geomIndex, mm) => reshapeCut(get, set, nodeId, geomIndex, 'cut-depth', (geom) => {
      geom.cutDepth = Math.max(0, mm) / 1000;
    }),

    setGeomThread: (nodeId, geomIndex, thread, diameterMm) => {
      const edit = (geom: SceneGeom) => {
        if (geom.type !== 'cylinder') return;
        if (!thread || !(thread.pitchMm > 0)) delete geom.thread;
        else geom.thread = {
          pitch: thread.pitchMm / 1000,
          ...(thread.left ? { left: true } : {}),
          ...(thread.fitMm && thread.fitMm > 0 ? { fit: thread.fitMm / 1000 } : {}),
        };
        if (diameterMm !== undefined && diameterMm > 0) {
          const size = [...(geom.size || [])];
          size[0] = diameterMm / 2000;
          geom.size = size;
        }
      };
      const geom = findNode(get().sceneGraph.nodes, nodeId)?.geoms?.[geomIndex];
      if (!geom || geom.csgDerived || geom.type !== 'cylinder') return;
      // A hole or boss placed on a face is re-derived from its spot, so its
      // depth still reaches the material at the new diameter.
      if (geom.cutNormal) {
        reshapeCut(get, set, nodeId, geomIndex, 'geom-thread', edit);
        return;
      }
      get().recordInteraction('geom-thread');
      const newScene = cloneSceneGraph(get().sceneGraph);
      const node = findNode(newScene.nodes, nodeId);
      const target = node?.geoms?.[geomIndex];
      if (!node || !target) return;
      edit(target);
      settleBooleanState(node);
      set({ sceneGraph: newScene });
      rebuildAfterGeomEdit(get, newScene, nodeId);
    },

    setCutSection: (nodeId, geomIndex, section) => reshapeCut(get, set, nodeId, geomIndex, 'cut-section', (geom) => {
      const size = [...(geom.size || [])];
      if (geom.type === 'box') {
        // The slot's own width and breadth, in its own frame — they turn with it
        // rather than staying world X and Y.
        size[0] = Math.max(1e-6, section[0] ?? size[0] ?? 0.005);
        size[1] = Math.max(1e-6, section[1] ?? size[1] ?? 0.005);
      } else {
        size[0] = Math.max(1e-6, section[0] ?? size[0] ?? 0.005);
      }
      geom.size = size;
    }),
  };
}
