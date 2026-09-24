import * as THREE from 'three';
import { cloneSceneGraph } from '../store/useStore';
import type { SceneGraph, SceneNode } from '../types/scene';
import type { ModelMirror, MujocoShim } from '../types/sceneLayer';

// The slice of the MuJoCo model/data mirror that scene syncing reads. Only
// these members are touched here, but they are the store's own mirror types so
// the shim can be handed straight over.
export type SyncMujoco = Pick<MujocoShim, 'mj_name2id'> & { mjtObj: Pick<MujocoShim['mjtObj'], 'mjOBJ_BODY'> };
export interface SyncData {
  xpos: ArrayLike<number>;
  xmat: ArrayLike<number>;
}

export const getSyncedSceneGraph = (
  scene: SceneGraph,
  model: ModelMirror | null,
  data: SyncData | null,
  mujoco: SyncMujoco | null
): SceneGraph => {
  if (!model || !data || !mujoco) return scene;

  const sceneCopy = cloneSceneGraph(scene);

  const syncNode = (
    node: SceneNode,
    parentWorldPos: THREE.Vector3,
    parentWorldQuat: THREE.Quaternion
  ) => {
    if (node.isPulleyRope) {
      if (node.children) {
        for (const child of node.children) {
          syncNode(child, parentWorldPos, parentWorldQuat);
        }
      }
      return;
    }

    const bodyId = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, node.name);
    
    const currentWorldPos = parentWorldPos.clone();
    const currentWorldQuat = parentWorldQuat.clone();

    if (bodyId !== -1) {
      const px = data.xpos[bodyId * 3];
      const py = data.xpos[bodyId * 3 + 1];
      const pz = data.xpos[bodyId * 3 + 2];
      currentWorldPos.set(px, py, pz);

      const m = data.xmat;
      const offset = bodyId * 9;
      const rotationMatrix = new THREE.Matrix4().set(
        m[offset],     m[offset + 1], m[offset + 2], 0,
        m[offset + 3], m[offset + 4], m[offset + 5], 0,
        m[offset + 6], m[offset + 7], m[offset + 8], 0,
        0,             0,             0,             1
      );
      currentWorldQuat.setFromRotationMatrix(rotationMatrix);

      const parentQuatInv = parentWorldQuat.clone().invert();
      const localPos = currentWorldPos.clone().sub(parentWorldPos).applyQuaternion(parentQuatInv);
      const localQuat = parentQuatInv.clone().multiply(currentWorldQuat);

      node.pos = [localPos.x, localPos.y, localPos.z];
      node.quat = [localQuat.w, localQuat.x, localQuat.y, localQuat.z];
      
      if (node.euler) {
        delete node.euler;
      }
    }

    if (node.children) {
      for (const child of node.children) {
        syncNode(child, currentWorldPos, currentWorldQuat);
      }
    }
  };

  const identityQuat = new THREE.Quaternion(0, 0, 0, 1);
  const zeroPos = new THREE.Vector3(0, 0, 0);

  for (const node of sceneCopy.nodes) {
    syncNode(node, zeroPos, identityQuat);
  }

  return sceneCopy;
};
