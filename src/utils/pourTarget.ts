// The selected bodies as one mold to pour into: a mother mold is usually a
// master and a sleeve, two bodies, and the cast fills what they enclose together.

import * as THREE from 'three';
import type { SceneNode } from '../types/scene';
import { getNodeWorldTransform } from './laserCutExporter';
import { geomBounds, positiveBounds } from './csg';
import { castMaterial, resolveCastMaterial } from './castMaterials';

/**
 * One body holding copies of the given bodies placed where they stand in the
 * world, so a nested body keeps its parents' transforms. A body selected along
 * with one of its ancestors comes in once, with the ancestor. Null when none of
 * the ids is in the scene.
 */
export function pourNodeFor(nodes: SceneNode[], ids: string[]): SceneNode | null {
  return combined(placedBodies(nodes, ids));
}

/** Copies of the given bodies placed where they stand in the world. */
function placedBodies(nodes: SceneNode[], ids: string[]): SceneNode[] {
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
  return children;
}

function combined(children: SceneNode[]): SceneNode | null {
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

/**
 * The silicone pour box among the bodies poured into, if there is one standing
 * upright: its fill line. Turned over or on its side, it is not poured as it
 * was planned, so it has no fill line to offer.
 */
export function pourBoxIn(node: SceneNode, parent?: THREE.Matrix4): NonNullable<SceneNode['pourBox']> | null {
  const world = getNodeWorldTransform(node, parent);
  if (node.pourBox) {
    const up = new THREE.Vector3(0, 0, 1).transformDirection(world);
    return up.z > 0.999 ? node.pourBox : null;
  }
  for (const c of node.children ?? []) {
    const found = pourBoxIn(c, world);
    if (found) return found;
  }
  return null;
}

/** The mold is, or holds, a cast poured in silicone, which silicone would stick to. */
export function isSiliconeMold(node: SceneNode): boolean {
  const m = resolveCastMaterial(node.simulation?.material);
  if (m && castMaterial(m).silicone) return true;
  return (node.children ?? []).some(isSiliconeMold);
}

/** How far apart two bodies' boxes may be and still count as touching, metres. */
const TOUCH_M = 0.001;

type Box = { min: number[]; max: number[] };

/** A world-placed body's box, its children included: its own bounds' corners carried through its transform. */
function worldBox(node: SceneNode, parent?: THREE.Matrix4): Box | null {
  const m = getNodeWorldTransform(node, parent);
  const out: Box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  let any = false;
  const add = (b: Box) => {
    const p = new THREE.Vector3();
    for (let k = 0; k < 8; k++) {
      p.set(k & 1 ? b.max[0] : b.min[0], k & 2 ? b.max[1] : b.min[1], k & 4 ? b.max[2] : b.min[2]).applyMatrix4(m);
      [p.x, p.y, p.z].forEach((v, a) => {
        out.min[a] = Math.min(out.min[a], v);
        out.max[a] = Math.max(out.max[a], v);
      });
    }
    any = true;
  };
  const own = positiveBounds(node);
  if (own) add(own);
  else for (const g of node.geoms ?? []) { const b = geomBounds(g); if (b && b.min.every(Number.isFinite)) add(b); }
  for (const c of node.children ?? []) {
    const b = worldBox(c, m);
    if (b) { any = true; for (let a = 0; a < 3; a++) { out.min[a] = Math.min(out.min[a], b.min[a]); out.max[a] = Math.max(out.max[a], b.max[a]); } }
  }
  return any ? out : null;
}

const touching = (a: Box, b: Box) => [0, 1, 2].every((k) => a.min[k] <= b.max[k] + TOUCH_M && b.min[k] <= a.max[k] + TOUCH_M);

/**
 * The selection as a mold to pour into, made of the bodies that touch the
 * first id (the body clicked), directly or through one another. Bodies that
 * stand apart from those hold nothing with them, so they are left out and
 * named in `apart`: a sleeve and a silicone mold 12 cm to one side of it were
 * poured into as one, and came out a spiky tube that was neither.
 */
export function pourSelection(nodes: SceneNode[], ids: string[]): { node: SceneNode; apart: SceneNode[] } | null {
  const bodies = placedBodies(nodes, ids);
  if (bodies.length === 0) return null;
  const boxes = bodies.map((b) => worldBox(b));
  const first = Math.max(0, bodies.findIndex((b) => b.id === ids[0]));
  const inGroup = new Set([first]);
  for (let grew = true; grew;) {
    grew = false;
    bodies.forEach((_, i) => {
      if (inGroup.has(i) || !boxes[i]) return;
      if ([...inGroup].some((j) => boxes[j] && touching(boxes[i]!, boxes[j]!))) { inGroup.add(i); grew = true; }
    });
  }
  return {
    node: combined(bodies.filter((_, i) => inGroup.has(i)))!,
    apart: bodies.filter((_, i) => !inGroup.has(i)),
  };
}
