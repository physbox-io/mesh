// ---------------------------------------------------------------------------
// The store's edits to bodies: name, position and rotation, joints and
// scripts, any other field, moving a body out of its parent, and deleting
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { SceneGraph, SceneNode, SceneJoint } from '../types/scene';
import { releaseFastenings } from '../utils/hardwareParts';
import type { DataMirror, ModelMirror } from '../types/sceneLayer';
import { getStickyRotation } from '../utils/geom';
import { cloneSceneGraph } from './sceneClone';
import {
  isAllMeshNode, promoteMeshGeomsToDynamic, restoreCollisionWhenMadeMovable, mapVerts,
  translateMeshGeoms, rotateMeshGeomsAbsolute,
} from './meshGeomTransforms';
import { detachReferencesTo } from './breakage';
import { MUJOCO_SHIM, getPhysicsWorkerClient } from './physicsEngine';
import type { SliceDeps } from './sliceDeps';
import { takeEnvironment } from './sceneEnvironment';
import { assertGeomSizes } from '../utils/geomSize';

/** A node's own transform, as MJCF would apply it under its parent. */
const localMatrixOf = (node: SceneNode): THREE.Matrix4 => {
  const m = new THREE.Matrix4();
  const q = node.quat
    // MJCF quaternions are [w, x, y, z]; Three wants [x, y, z, w].
    ? new THREE.Quaternion(node.quat[1], node.quat[2], node.quat[3], node.quat[0])
    : new THREE.Quaternion().setFromEuler(new THREE.Euler(
        ((node.euler?.[0] ?? 0) * Math.PI) / 180,
        ((node.euler?.[1] ?? 0) * Math.PI) / 180,
        ((node.euler?.[2] ?? 0) * Math.PI) / 180,
        'XYZ',
      ));
  return m.compose(
    new THREE.Vector3(node.pos?.[0] ?? 0, node.pos?.[1] ?? 0, node.pos?.[2] ?? 0),
    q,
    new THREE.Vector3(1, 1, 1),
  );
};

export interface NodeActions {
  updateScene: (sceneGraph: SceneGraph, skipRecompile?: boolean) => void;
  renameNode: (id: string, newName: string) => void;
  updateNodePos: (id: string, newPos: [number, number, number]) => void;
  updateNodeRotation: (id: string, axis: 0 | 1 | 2, deg: number, rotateAroundCOM?: boolean) => void;
  updateNodeJoint: (id: string, updates: Partial<SceneJoint>, jointIndex?: number) => void;
  updateNodeScript: (id: string, script: string) => void;
  updateNode: (id: string, updates: Partial<SceneNode>) => void;
  /**
   * Lift a body out of its parent and onto the top level, keeping it where
   * it looks like it is. MuJoCo allows a free joint only on a top-level
   * body, so a nested body cannot be made 6-DOF without this first.
   */
  detachToTopLevel: (id: string) => boolean;
  updateNodeJointsList: (id: string, joints: SceneJoint[]) => void;
  deleteNode: (id: string) => void;
  /** Deletes several bodies as one undo step, and clears the selection they made up. */
  deleteNodes: (ids: string[]) => void;
}

export function nodeActions({ set, get }: SliceDeps): NodeActions {
  return {
    updateScene: (loaded, skipRecompile) => {
      get().prepareForDiscreteChange();
      // A file or an agent's get_scene round trip carries its environment;
      // an edit (`{ ...sceneGraph, nodes }`) never does, and leaves it be.
      const { graph: newScene, environment } = takeEnvironment(loaded);
      set(environment ? { sceneGraph: newScene, ...environment } : { sceneGraph: newScene });
      if (!skipRecompile) {
        get().recompile(newScene);
      }
    },

    renameNode: (id, newName) => {
      get().prepareForDiscreteChange();
      const newScene = cloneSceneGraph(get().sceneGraph);
      const traverse = (nodes: SceneNode[]) => {
        if (!nodes) return false;
        for (const node of nodes) {
          if (node.id === id) {
            node.name = newName;
            return true;
          }
          if (traverse(node.children)) return true;
        }
        return false;
      };
      traverse(newScene.nodes);
      set({ sceneGraph: newScene });
      get().recompile(newScene);
    },

    updateNodePos: (id, newPos) => {
      get().recordInteraction('node-pos');
      const newScene = cloneSceneGraph(get().sceneGraph);
      const traverse = (nodes: SceneNode[]) => {
        if (!nodes) return false; for (const node of nodes) {
          if (node.id === id) {
            if (isAllMeshNode(node)) {
              // Mesh vertices are baked in world space — translate them directly
              const [ox, oy, oz] = node.pos as number[];
              const dx = newPos[0] - ox, dy = newPos[1] - oy, dz = newPos[2] - oz;
              translateMeshGeoms(node, dx, dy, dz);
              for (const g of node.geoms) {
                if (g.baseVertices) {
                  g.baseVertices = mapVerts([...g.baseVertices], (x, y, z) => [x + dx, y + dy, z + dz]);
                }
                // Z-up, as the collider it is the unturned copy of.
                if (g.baseColliderVertices && !g.dynamic) {
                  g.baseColliderVertices = mapVerts([...g.baseColliderVertices], (x, y, z) => [x + dx, y - dz, z + dy]);
                }
              }
            }
            node.pos = newPos;
            node.basePos = [...newPos];
            return true;
          }
          if (traverse(node.children)) return true;
        }
        return false;
      };
      traverse(newScene.nodes);
      set({ sceneGraph: newScene });
      get().recompile(newScene, undefined, false);
    },

    updateNodeRotation: (id, axis, deg, rotateAroundCOMOverride) => {
      get().recordInteraction('node-rotation');
      const rotateAroundCOM = rotateAroundCOMOverride ?? get().rotateAroundCOM ?? true;
      const newScene = cloneSceneGraph(get().sceneGraph);
      const traverse = (nodes: SceneNode[]) => {
        if (!nodes) return false;
        for (const node of nodes) {
          if (node.id === id) {
            const currentEuler = node.euler ? [...node.euler] : [0, 0, 0];
            currentEuler[axis] = deg;
            node.euler = currentEuler as [number, number, number];
            delete node.quat;

            const stickyEuler = currentEuler.map(a => getStickyRotation(a)) as [number, number, number];

            if (isAllMeshNode(node)) {
              rotateMeshGeomsAbsolute(node, stickyEuler, rotateAroundCOM);
            } else {
              if (!node.basePos && node.pos) {
                node.basePos = [...node.pos];
              }
              if (!rotateAroundCOM && node.basePos) {
                const radX = (stickyEuler[0] * Math.PI) / 180;
                const radY = (stickyEuler[1] * Math.PI) / 180;
                const radZ = (stickyEuler[2] * Math.PI) / 180;
                const matX = new THREE.Matrix4().makeRotationX(radX);
                const matY = new THREE.Matrix4().makeRotationY(radY);
                const matZ = new THREE.Matrix4().makeRotationZ(radZ);
                const rotMat = new THREE.Matrix4().multiplyMatrices(matZ, new THREE.Matrix4().multiplyMatrices(matY, matX));
                const v = new THREE.Vector3(node.basePos[0], node.basePos[1], node.basePos[2]).applyMatrix4(rotMat);
                node.pos = [v.x, v.y, v.z];
              } else if (rotateAroundCOM && node.basePos) {
                node.pos = [...node.basePos];
              }
            }
            return true;
          }
          if (traverse(node.children)) return true;
        }
        return false;
      };
      if (traverse(newScene.nodes)) {
        set({ sceneGraph: newScene });
        // Settled: a gizmo rotate commits all three axes in a row, and each one
        // would otherwise be a rebuild of its own.
        get().recompile(newScene, undefined, true, undefined, true);
      }
    },

    // `jointIndex` defaults to 0, which is what every caller meant before it
    // existed — the inspector only ever shows one joint. A body with several (a
    // gimbal, say) needs to be able to say which.
    updateNodeJoint: (id, updates, jointIndex = 0) => {
      get().recordInteraction('node-joint');
      const newScene = cloneSceneGraph(get().sceneGraph);
      const traverse = (nodes: SceneNode[]) => {
        if (!nodes) return false; for (const node of nodes) {
          if (node.id === id && node.joints?.length > 0) {
            const target = node.joints[jointIndex] ?? node.joints[0];
            Object.assign(target, updates);
            return true;
          }
          if (traverse(node.children)) return true;
        }
        return false;
      };
      traverse(newScene.nodes);
      set({ sceneGraph: newScene });
      get().recompile();
    },

    updateNodeScript: (id, script) => {
      get().recordInteraction('node-script');
      const newScene = cloneSceneGraph(get().sceneGraph);
      const traverse = (nodes: SceneNode[]) => {
        if (!nodes) return false;
        for (const node of nodes) {
          if (node.id === id) {
            node.script = script;
            return true;
          }
          if (traverse(node.children)) return true;
        }
        return false;
      };
      traverse(newScene.nodes);
      set({ sceneGraph: newScene });
      // Note: Live updates do not force model recompiles to support hot-editing of
      // control gains! The worker keeps its own copy of the scene for script
      // execution, so it needs telling directly rather than via a recompile.
      getPhysicsWorkerClient().updateScript(id, script);
    },

    updateNode: (id, updates) => {
      // A bad geom size is refused, not written for the compiler to guess at.
      if (updates.geoms) assertGeomSizes(updates.geoms, updates.name ?? id);
      get().recordInteraction('node');
      const newScene = cloneSceneGraph(get().sceneGraph);
      const traverse = (nodes: SceneNode[]): boolean => {
        for (const node of nodes) {
          if (node.id === id) {
            const wasJointless = !(node.joints?.length > 0);
            Object.assign(node, updates);
            // Body-level rgba is a shorthand for colouring the body's geoms:
            // SceneNode has no colour of its own in MJCF or the renderer, so
            // storing it on the node alone left SCAD and primitive bodies lilac.
            const rawRgba = (updates as { rgba?: number[] }).rgba;
            if (updates.geoms === undefined && Array.isArray(rawRgba) && rawRgba.length >= 3 && node.geoms?.length) {
              for (const geom of node.geoms) {
                if (geom.csg === 'difference') continue;
                geom.rgba = [rawRgba[0] ?? 0.8, rawRgba[1] ?? 0.8, rawRgba[2] ?? 0.8, rawRgba[3] ?? geom.rgba?.[3] ?? 1];
              }
            }
            // Same trap as updateNodeJointsList: an update that hands this node
            // its first joint (e.g. an MCP physics_update_object call, not just
            // the properties panel) needs its mesh geoms promoted too, or the
            // body simulates and drags correctly while its render stays frozen.
            if (updates.joints !== undefined && node.joints?.length > 0) {
              promoteMeshGeomsToDynamic(node);
              if (wasJointless) restoreCollisionWhenMadeMovable(node);
            }
            return true;
          }
          if (traverse(node.children)) return true;
        }
        return false;
      };
      if (traverse(newScene.nodes)) {
        set({ sceneGraph: newScene });
        // Recompile so aerodynamics flag propagates to physics loop
        get().recompile(newScene, undefined, false);
      }
    },

    /*
     * "free joint can only be used on top level" is MuJoCo refusing the whole
     * model, not a warning — so before this existed, setting a nested body to
     * 6-DOF left the last good model running while the document said something
     * else, and the body simply stopped responding.
     *
     * The body keeps the pose it appears to have. Where the sim is live that is
     * MuJoCo's own xpos/xmat, which is where the user can see it; otherwise the
     * authored chain is composed down from the root, which is where the document
     * says it is. Its own children come with it and need no adjustment, since
     * they are positioned relative to this body either way.
     */
    detachToTopLevel: (id) => {
      const scene = cloneSceneGraph(get().sceneGraph);

      let parent: SceneNode | null = null;
      let node: SceneNode | null = null;
      const find = (nodes: SceneNode[], above: SceneNode | null): boolean => {
        for (const n of nodes) {
          if (n.id === id) { node = n; parent = above; return true; }
          if (find(n.children || [], n)) return true;
        }
        return false;
      };
      find(scene.nodes, null);
      if (!node || !parent) return false;   // missing, or already top level
      const found: SceneNode = node;
      const from: SceneNode = parent;

      // Where it is now, in world terms.
      const world = new THREE.Matrix4();
      const model = get().model as ModelMirror | null;
      const data = get().data as DataMirror | null;
      const bodyId = MUJOCO_SHIM.mj_name2id(model, 'body', id);
      if (model && data && bodyId >= 0) {
        const o = bodyId * 3, m = bodyId * 9;
        // xmat is row-major body-to-world.
        world.set(
          data.xmat[m], data.xmat[m + 1], data.xmat[m + 2], data.xpos[o],
          data.xmat[m + 3], data.xmat[m + 4], data.xmat[m + 5], data.xpos[o + 1],
          data.xmat[m + 6], data.xmat[m + 7], data.xmat[m + 8], data.xpos[o + 2],
          0, 0, 0, 1,
        );
      } else {
        // No live model: compose the authored chain instead.
        const chain: SceneNode[] = [];
        const walk = (nodes: SceneNode[], trail: SceneNode[]): boolean => {
          for (const n of nodes) {
            const next = [...trail, n];
            if (n.id === id) { chain.push(...next); return true; }
            if (walk(n.children || [], next)) return true;
          }
          return false;
        };
        walk(scene.nodes, []);
        for (const link of chain) world.multiply(localMatrixOf(link));
      }

      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      world.decompose(pos, quat, new THREE.Vector3());

      from.children = (from.children || []).filter((c) => c.id !== id);
      found.pos = [pos.x, pos.y, pos.z];
      found.basePos = [pos.x, pos.y, pos.z];
      // mjcf.ts writes no eulerseq, so MuJoCo reads euler as its default
      // intrinsic xyz — Three's 'XYZ'. Degrees, as everything authored here is.
      const e = new THREE.Euler().setFromQuaternion(quat, 'XYZ');
      const deg = (r: number) => (r * 180) / Math.PI;
      found.euler = [deg(e.x), deg(e.y), deg(e.z)];
      delete found.quat;
      scene.nodes = [...scene.nodes, found];

      set({ sceneGraph: scene });
      get().recompile(scene, id, false, true);
      return true;
    },

    updateNodeJointsList: (id, joints) => {
      get().recordInteraction('node-joints-list');
      const newScene = cloneSceneGraph(get().sceneGraph);
      const traverse = (nodes: SceneNode[]): boolean => {
        if (!nodes) return false;
        for (const node of nodes) {
          if (node.id === id) {
            const wasJointless = !(node.joints?.length > 0);
            node.joints = joints;
            if (joints.length > 0) {
              promoteMeshGeomsToDynamic(node);
              if (wasJointless) restoreCollisionWhenMadeMovable(node);
            }
            return true;
          }
          if (traverse(node.children)) return true;
        }
        return false;
      };
      if (traverse(newScene.nodes)) {
        // Into the store now, not when the build lands: the build installs its
        // scene only if nothing has changed meanwhile, so any edit straight
        // after this one (a resize, a rename) dropped the new joints. That is
        // how physics_create_sculpt with a parent kept the hinge addComponent
        // gives a child, after taking it off.
        set({ sceneGraph: newScene });
        get().recompile(newScene, id);
      }
    },

    deleteNode: (id) => get().deleteNodes([id]),

    // Shift-click builds a selection of several bodies, and Delete used to take
    // only the primary one, leaving the rest highlighted and still listed in the
    // Combine card.
    deleteNodes: (ids) => {
      const doomed = new Set(ids);
      if (doomed.size === 0) return;
      get().prepareForDiscreteChange();
      const newScene = cloneSceneGraph(get().sceneGraph);
      // A screw taken out lets go of what it held.
      releaseFastenings(newScene, doomed);
      let removed = false;
      const traverseAndRemove = (nodes: SceneNode[]) => {
        if (!nodes) return;
        for (let i = nodes.length - 1; i >= 0; i--) {
          if (doomed.has(nodes[i].id)) {
            nodes.splice(i, 1);
            removed = true;
          } else {
            traverseAndRemove(nodes[i].children);
          }
        }
      };
      traverseAndRemove(newScene.nodes);
      if (removed) {
        // Nothing may go on naming what is gone — a bracket's weld to a deleted
        // profile, a pen head welded to a deleted rail's carriage — or the
        // whole scene stops compiling.
        const gone: string[] = [];
        const collect = (nodes: SceneNode[]) => {
          for (const n of nodes) { if (doomed.has(n.id)) { const all = (m: SceneNode) => { gone.push(m.id); (m.children || []).forEach(all); }; all(n); } else collect(n.children || []); }
        };
        collect(get().sceneGraph.nodes);
        for (const id of gone) newScene.nodes = detachReferencesTo(newScene.nodes, id);
        set({ sceneGraph: newScene, selectedNodeId: null, extraSelectedIds: [] });
        get().recompile(newScene, null);
      }
    },
  };
}
