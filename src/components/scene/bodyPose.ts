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
  const fallback: BodyPose = {
    pos: new THREE.Vector3(fallbackPos[0] ?? 0, fallbackPos[1] ?? 0, fallbackPos[2] ?? 0),
    rot: new THREE.Matrix3(),
    live: false,
  };
  const state = useStore.getState();
  const model = state.model as ModelMirror | null;
  const data = state.data as DataMirror | null;
  const mujoco = state.mujoco as MujocoShim | null;
  if (!model || !data || !mujoco) return fallback;
  try {
    const bodyId = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, nodeId);
    if (bodyId < 0) return fallback;
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
  } catch {
    return fallback;
  }
}
