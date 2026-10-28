/**
 * Where each body of the scene graph sits in the world, as authored.
 *
 * A body's `pos` and `quat`/`euler` are relative to its parent, so a gondola
 * hung off a wheel turned 90° is somewhere quite different from the sum of the
 * positions along its path. Bounds, framing and the collision check all need
 * the real pose; this is the one place it is worked out.
 *
 * MuJoCo world space (Z-up, metres). The euler convention is MuJoCo's default,
 * intrinsic xyz in degrees, as authoredQuat reads it.
 */
import * as THREE from 'three';
import type { SceneNode } from '../types/scene';
import { authoredQuat } from './bodyOrientation';

export interface Box3Like {
  min: number[];
  max: number[];
}

/** A body's own transform in its parent's frame. */
export function bodyLocalMatrix(node: Pick<SceneNode, 'pos' | 'quat' | 'euler'>): THREE.Matrix4 {
  const q = authoredQuat(node);
  const m = new THREE.Matrix4().makeRotationFromQuaternion(
    new THREE.Quaternion(q[1] || 0, q[2] || 0, q[3] || 0, q[0] ?? 1).normalize(),
  );
  const p = node.pos || [0, 0, 0];
  m.setPosition(p[0] || 0, p[1] || 0, p[2] || 0);
  return m;
}

/**
 * Visits every body, depth first, with its world matrix and its parent. The
 * matrix handed to `visit` is fresh for each body and may be kept.
 */
export function walkBodiesWorld(
  nodes: SceneNode[] | undefined,
  visit: (node: SceneNode, world: THREE.Matrix4, parent: SceneNode | null) => void,
  parentWorld: THREE.Matrix4 = new THREE.Matrix4(),
  parent: SceneNode | null = null,
): void {
  for (const node of nodes || []) {
    const world = parentWorld.clone().multiply(bodyLocalMatrix(node));
    visit(node, world, parent);
    walkBodiesWorld(node.children, visit, world, node);
  }
}

/** The axis-aligned box round `box` once it has been moved by `m`. */
export function transformBox(box: Box3Like, m: THREE.Matrix4): Box3Like {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const p = new THREE.Vector3();
  for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) {
    p.set(x, y, z).applyMatrix4(m);
    const c = [p.x, p.y, p.z];
    for (let a = 0; a < 3; a++) {
      if (c[a] < min[a]) min[a] = c[a];
      if (c[a] > max[a]) max[a] = c[a];
    }
  }
  return { min, max };
}
