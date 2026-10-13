// ---------------------------------------------------------------------------
// The pointer's ray in a body's own frame, and the way back out.
//
// The tools that pick on a part's surface (T's pattern pick, the knife) work
// in the body's frame: Z-up, metres, about the body origin, wherever MuJoCo
// has the body now (bodyPose.ts). A body is drawn in one of two places: in
// the Z-up group with everything else, or — a body that is only static
// meshes — straight in the Y-up scene, and its ray has to be turned into
// Z-up there. Things drawn on the part go back by bodyToParent.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { SceneNode } from '../../types/scene';
import { bodyPoseOf } from './bodyPose';

/** The Z-up body frame into the Y-up scene, for a body drawn straight in the scene: (x, y, z) → (x, z, −y). */
const Z_UP_TO_Y_UP = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);

/** The object a body's groups hang from: the Z-up group, or the scene. */
export function bodyParent(scene: THREE.Object3D, nodeId: string): THREE.Object3D | null {
  const groups: THREE.Object3D[] = [];
  scene.traverse((object) => {
    if (object.name === nodeId && object.type === 'Group') groups.push(object);
  });
  return (groups.find((g) => g.parent && g.parent.type !== 'Scene') ?? groups[0])?.parent ?? null;
}

/** The ray through a screen point, in `parent`'s own frame. */
export function rayInParent(parent: THREE.Object3D, camera: THREE.Camera, canvas: HTMLElement, x: number, y: number): THREE.Ray {
  const rect = canvas.getBoundingClientRect();
  const caster = new THREE.Raycaster();
  caster.setFromCamera(new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -(((y - rect.top) / rect.height) * 2 - 1)), camera);
  const inverse = new THREE.Matrix4().copy(parent.matrixWorld).invert();
  return new THREE.Ray(
    caster.ray.origin.clone().applyMatrix4(inverse),
    caster.ray.direction.clone().transformDirection(inverse).normalize(),
  );
}

/** The ray through a screen point in the body's own frame, as [x, y, z] arrays. */
export function rayInBody(
  node: SceneNode, parent: THREE.Object3D, camera: THREE.Camera, canvas: HTMLElement, x: number, y: number,
): { origin: number[]; direction: number[] } {
  const ray = rayInParent(parent, camera, canvas, x, y);
  if (parent.type === 'Scene') {
    const zUp = (v: THREE.Vector3) => v.set(v.x, -v.z, v.y);
    zUp(ray.origin);
    zUp(ray.direction);
  }
  const pose = bodyPoseOf(node.id, node.pos);
  const toBody = pose.rot.clone().transpose();
  const origin = ray.origin.clone().sub(pose.pos).applyMatrix3(toBody);
  const direction = ray.direction.clone().applyMatrix3(toBody).normalize();
  return { origin: origin.toArray(), direction: direction.toArray() };
}

/** Body frame into `parent`'s frame: where to hang something drawn on the part. */
export function bodyToParent(node: SceneNode, parent: THREE.Object3D): THREE.Matrix4 {
  const pose = bodyPoseOf(node.id, node.pos);
  const matrix = new THREE.Matrix4().setFromMatrix3(pose.rot).setPosition(pose.pos);
  if (parent.type === 'Scene') matrix.premultiply(Z_UP_TO_Y_UP);
  return matrix;
}
