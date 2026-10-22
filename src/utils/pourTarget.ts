// The selected bodies as one mold to pour into: a mother mold is usually a
// master and a sleeve, two bodies, and the cast fills what they enclose together.

import * as THREE from 'three';
import type { SceneNode } from '../types/scene';
import { getNodeWorldTransform } from './laserCutExporter';

/**
 * One body holding copies of the given bodies placed where they stand in the
 * world, so a nested body keeps its parents' transforms. A body selected along
 * with one of its ancestors comes in once, with the ancestor. Null when none of
 * the ids is in the scene.
 */
export function pourNodeFor(nodes: SceneNode[], ids: string[]): SceneNode | null {
  const wanted = new Set(ids);
  const children: SceneNode[] = [];
  const walk = (list: SceneNode[], parent: THREE.Matrix4 | undefined) => {
    for (const n of list) {
      if (wanted.has(n.id)) {
        const world = getNodeWorldTransform(n, parent);
        const pos = new THREE.Vector3();
        const quat = new THREE.Quaternion();
        world.decompose(pos, quat, new THREE.Vector3());
        // MuJoCo order, w first, which is what getNodeWorldTransform reads back.
        children.push({ ...n, pos: [pos.x, pos.y, pos.z], quat: [quat.w, quat.x, quat.y, quat.z], euler: undefined });
        continue;
      }
      if (n.children?.length) walk(n.children, getNodeWorldTransform(n, parent));
    }
  };
  walk(nodes, undefined);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return {
    id: children.map((c) => c.id).join('+'),
    name: children.map((c) => c.name).join(' + '),
    type: 'body',
    pos: [0, 0, 0],
    joints: [],
    geoms: [],
    children,
  } as SceneNode;
}
