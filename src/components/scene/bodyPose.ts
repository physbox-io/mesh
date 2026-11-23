/**
 * Where a body IS, as opposed to where it was authored.
 *
 * A simulated body is wherever MuJoCo has put it, which after a settle or a
 * run is not the scene graph's `pos`. Anything that turns a pointer into a
 * point on a body — the cut spot, a hole being dragged across a face — has to
 * work in that frame, or the hole lands where the part used to be.
 *
 * Both parts are in MuJoCo world space (Z-up): `pos` the body origin and
 * `rot` the body-to-world rotation. Falls back to the node's own position with
 * no rotation when there is no model to ask, which is what a body has before
 * its first compile.
 */
import * as THREE from 'three';
import { useStore } from '../../store/useStore';
import type { DataMirror, ModelMirror, MujocoShim } from '../../types/sceneLayer';
import type { SceneNode } from '../../types/scene';
import { getNodeWorldTransform } from '../../utils/laserCutExporter';

export interface BodyPose {
  pos: THREE.Vector3;
  rot: THREE.Matrix3;
  /**
   * Whether this came from the running model or is the authored fallback.
   *
   * The fallback's `rot` is the IDENTITY, not the body's real orientation —
   * fine for a body that has never been compiled, and a lie for one that is
   * merely between models. A rebuild replaces `model` and `data`, so for a
   * frame or two every lookup here falls back; anything that follows a body
   * frame by frame has to sit that out rather than believe it, or a rotated
   * body appears to snap upright and back.
   */
  live: boolean;
}

export function bodyPoseOf(nodeId: string, fallbackPos: number[] = [0, 0, 0]): BodyPose {
  const state = useStore.getState();
  const model = state.model as ModelMirror | null;
  const data = state.data as DataMirror | null;
  const mujoco = state.mujoco as MujocoShim | null;
  if (model && data && mujoco) {
    try {
      const bodyId = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, nodeId);
      if (bodyId >= 0) {
        const o = bodyId * 3;
        const m = bodyId * 9;
        // xmat is row-major body-to-world; Matrix3.set takes rows, so no transpose
        // here. publishCutSpot transposes because it wants world-to-body.
        const rot = new THREE.Matrix3().set(
          data.xmat[m], data.xmat[m + 1], data.xmat[m + 2],
          data.xmat[m + 3], data.xmat[m + 4], data.xmat[m + 5],
          data.xmat[m + 6], data.xmat[m + 7], data.xmat[m + 8],
        );
        return { pos: new THREE.Vector3(data.xpos[o], data.xpos[o + 1], data.xpos[o + 2]), rot, live: true };
      }
    } catch {
      // Fall through to authored fallback below.
    }
  }
  return {
    pos: new THREE.Vector3(fallbackPos[0] ?? 0, fallbackPos[1] ?? 0, fallbackPos[2] ?? 0),
    rot: new THREE.Matrix3(),
    live: false,
  };
}

export interface BodyPoseCache {
  model: ModelMirror | null;
  nodeId: string;
  bodyId: number;
}

/**
 * Zero-allocation variant of `bodyPoseOf` for per-frame `useFrame` loops.
 * Writes directly into caller-owned `outPos` and `outRot`, caching `mj_name2id`
 * per `(model, nodeId)` when a cache ref is supplied.
 */
export function readBodyPoseInto(
  nodeId: string,
  fallbackPos: number[],
  outPos: THREE.Vector3,
  outRot: THREE.Matrix3,
  cache?: BodyPoseCache,
): boolean {
  const state = useStore.getState();
  const model = state.model as ModelMirror | null;
  const data = state.data as DataMirror | null;
  const mujoco = state.mujoco as MujocoShim | null;
  if (model && data && mujoco) {
    try {
      let bodyId: number;
      if (cache && cache.model === model && cache.nodeId === nodeId) {
        bodyId = cache.bodyId;
      } else {
        bodyId = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, nodeId);
        if (cache) {
          cache.model = model;
          cache.nodeId = nodeId;
          cache.bodyId = bodyId;
        }
      }
      if (bodyId >= 0) {
        const o = bodyId * 3;
        const m = bodyId * 9;
        outPos.set(data.xpos[o], data.xpos[o + 1], data.xpos[o + 2]);
        outRot.set(
          data.xmat[m], data.xmat[m + 1], data.xmat[m + 2],
          data.xmat[m + 3], data.xmat[m + 4], data.xmat[m + 5],
          data.xmat[m + 6], data.xmat[m + 7], data.xmat[m + 8],
        );
        return true;
      }
    } catch {
      // Fall through to authored fallback below.
    }
  }
  outPos.set(fallbackPos[0] ?? 0, fallbackPos[1] ?? 0, fallbackPos[2] ?? 0);
  outRot.identity();
  return false;
}

/** The body a node hangs from, or null when it sits at the top of the scene. */
function parentBodyOf(nodes: SceneNode[], id: string, parent: SceneNode | null = null): SceneNode | null | undefined {
  for (const node of nodes) {
    if (node.id === id) return parent;
    const found = parentBodyOf(node.children ?? [], id, node);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * A world point, expressed in the frame a body's `pos` is actually written in.
 *
 * MJCF nests bodies, so a child's `pos` is relative to its PARENT body — while
 * everything that drags a body (the gizmo, the keyboard gestures) works in
 * world space, because that is where the pointer is. Writing the one into the
 * other sends a child of a rotated parent off along the parent's axes instead
 * of the ones under the cursor, and drops it somewhere else entirely when the
 * parent is also offset. The pendulum's lower arm is the case that shows it:
 * its parent swings, so the further the arm has travelled the further the drag
 * misses by.
 *
 * A top-level body hangs off worldbody, whose frame is the world's, so it
 * passes straight through. So does anything whose parent has no live pose to
 * ask — there is nothing better to say then, and it is what this did before.
 */
export function toParentFrame(nodeId: string, world: [number, number, number]): [number, number, number] {
  const parent = parentBodyOf(useStore.getState().sceneGraph?.nodes ?? [], nodeId);
  if (!parent) return world;
  const pose = bodyPoseOf(parent.id, parent.pos);
  if (!pose.live) return world;
  // xmat is body-to-world, so its transpose takes the world into the body.
  const local = new THREE.Vector3(world[0], world[1], world[2])
    .sub(pose.pos)
    .applyMatrix3(pose.rot.clone().transpose());
  return [local.x, local.y, local.z];
}

/** Moves smaller than these are contact settling, not someone moving a part. */
const MOVED_M = 0.0002;
const TURNED_RAD = THREE.MathUtils.degToRad(0.5);

/**
 * Every body's live world pose, when the sim has moved any of them from where
 * the scene graph draws it; null when nothing has moved or there is no model.
 */
export function livePoses(nodes: SceneNode[]): Map<string, THREE.Matrix4> | null {
  const poses = new Map<string, THREE.Matrix4>();
  let moved = false;
  const tmpPos = new THREE.Vector3();
  const tmpRot = new THREE.Matrix3();
  const tmpAt = new THREE.Vector3();
  const tmpQ1 = new THREE.Quaternion();
  const tmpQ2 = new THREE.Quaternion();
  // A body the model lacks (a rebuild in flight, or one not simulated) stays
  // where it is drawn, and so does everything on it.
  const walk = (list: SceneNode[], parent?: THREE.Matrix4) => {
    for (const n of list) {
      const drawn = getNodeWorldTransform(n, parent);
      const isLive = readBodyPoseInto(n.id, n.pos, tmpPos, tmpRot);
      if (!isLive) { walk(n.children ?? [], drawn); continue; }
      const live = new THREE.Matrix4().setFromMatrix3(tmpRot).setPosition(tmpPos);
      if (!moved) {
        tmpAt.setFromMatrixPosition(drawn);
        const turn = tmpQ1.setFromRotationMatrix(drawn).angleTo(tmpQ2.setFromRotationMatrix(live));
        if (tmpAt.distanceTo(tmpPos) > MOVED_M || turn > TURNED_RAD) moved = true;
      }
      poses.set(n.id, live);
      walk(n.children ?? [], live);
    }
  };
  walk(nodes);
  if (!moved) return null;
  return poses;
}
