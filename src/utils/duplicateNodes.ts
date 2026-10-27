// ---------------------------------------------------------------------------
// Copies of bodies: Duplicate, Copy and Paste
//
// A copy is the body and everything under it, given fresh ids, and placed
// beside the original rather than on top of it. Two bodies in one place
// collide, and the solver throws them apart the moment the sim runs.
//
// References between bodies inside the copy (a weld from one child to
// another, a coupled gear pair, a pulley's wheels) are pointed at the new
// bodies. References out of it are kept, so a copied bracket bolted to a frame
// is bolted to that same frame. Names are left alone: the store's unique-name
// rule (utils/uniqueNames.ts) renames the copy to `name_2` and so on.
//
// PURE: the caller clones the scene; these edit what they are given.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { SceneGraph, SceneNode } from '../types/scene';
import { nodeWorldMatrix } from './combineBodies';
import { sceneContentBounds } from './frameScene';
import { clearAlongX } from './spawnPlacement';

/** Each field on a node that holds another node's id. */
const REFERENCE_FIELDS = [
  'coupleTargetId', 'weldTargetId', 'connectTargetId',
  'leftTargetId', 'rightTargetId', 'pulleyWheelId', 'weldLastToId',
] as const;

/** Room left between a body and its copy, in metres. */
const GAP = 0.01;

/** What Copy keeps: the bodies as they were, and where each one sat. */
export interface Clipboard {
  nodes: SceneNode[];
  /** Each body's parent when copied, or null at the top level. */
  parents: (string | null)[];
  /** Each body's world transform when copied, for a parent no longer in the scene. */
  world: number[][];
  /** How far along X one copy steps from the last: the group's width and a gap. */
  step: number;
}

const freshId = (old: string) => `${old.replace(/_[a-z0-9]{8}$/, '')}_${Math.random().toString(36).slice(2, 10)}`;

function walk(node: SceneNode, visit: (n: SceneNode) => void) {
  visit(node);
  for (const c of node.children || []) walk(c, visit);
}

function parentOf(nodes: SceneNode[], id: string, parent: SceneNode | null = null): SceneNode | null | undefined {
  for (const n of nodes) {
    if (n.id === id) return parent;
    const found = parentOf(n.children || [], id, n);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The selected bodies that are not inside another selected body, in tree order. */
export function topmostSelected(nodes: SceneNode[], ids: string[]): SceneNode[] {
  const wanted = new Set(ids);
  const out: SceneNode[] = [];
  const visit = (list: SceneNode[]) => {
    for (const n of list) {
      if (wanted.has(n.id)) out.push(n);
      else visit(n.children || []);
    }
  };
  visit(nodes);
  return out;
}

/** Gives every body in `roots` a new id, and points references within them at the new ids. */
export function renumber(roots: SceneNode[]): void {
  const ids = new Map<string, string>();
  for (const root of roots) walk(root, (n) => { ids.set(n.id, freshId(n.id)); });
  for (const root of roots) {
    walk(root, (n) => {
      n.id = ids.get(n.id)!;
      const fields = n as unknown as Record<string, unknown>;
      for (const f of REFERENCE_FIELDS) {
        const to = fields[f];
        if (typeof to === 'string' && ids.has(to)) fields[f] = ids.get(to);
      }
    });
  }
}

/** Takes a snapshot of the bodies with these ids, for Paste or Duplicate. */
export function copyBodies(scene: SceneGraph, ids: string[], clone: (nodes: SceneNode[]) => SceneNode[]): Clipboard | null {
  const picked = topmostSelected(scene.nodes || [], ids);
  if (!picked.length) return null;
  const bounds = sceneContentBounds(picked.map((n) => {
    // Measured where they are in the world, not relative to their parents.
    const m = nodeWorldMatrix(scene.nodes, n.id)!;
    const p = new THREE.Vector3().setFromMatrixPosition(m);
    return { ...n, pos: p.toArray() };
  }));
  const width = bounds ? bounds.max[0] - bounds.min[0] : 0.05;
  return {
    nodes: clone(picked),
    parents: picked.map((n) => parentOf(scene.nodes, n.id)?.id ?? null),
    world: picked.map((n) => nodeWorldMatrix(scene.nodes, n.id)!.toArray()),
    step: width + GAP,
  };
}

/**
 * Puts the clipboard's bodies into `scene`. Each goes back under its parent
 * when the parent is still there, `times` steps along world X from where it was
 * copied: a part of an assembly stays with the assembly. The rest go in at the
 * top level, at the pose they had, and then, when `at` is given (the point the
 * view is centred on), are moved as one group to stand over it, keeping their
 * height, and stepped along X until they are clear of what is already there.
 * Without `at` they step along X like the rest. Returns the new bodies' ids, in
 * the clipboard's order.
 */
export function pasteBodies(
  scene: SceneGraph, board: Clipboard, times: number,
  clone: (nodes: SceneNode[]) => SceneNode[], at?: number[] | null,
): string[] {
  const copies = clone(board.nodes);
  renumber(copies);
  const shift = new THREE.Vector3(board.step * times, 0, 0);
  const find = (list: SceneNode[], id: string): SceneNode | null => {
    for (const n of list) {
      if (n.id === id) return n;
      const f = find(n.children || [], id);
      if (f) return f;
    }
    return null;
  };
  const loose: SceneNode[] = [];
  copies.forEach((copy, i) => {
    const parentId = board.parents[i];
    const parent = parentId ? find(scene.nodes, parentId) : null;
    if (parent) {
      // The step is along world X; in the parent's frame that is its inverse rotation of X.
      const parentWorld = nodeWorldMatrix(scene.nodes, parent.id)!;
      const q = new THREE.Quaternion().setFromRotationMatrix(parentWorld).invert();
      const local = shift.clone().applyQuaternion(q);
      const p = copy.pos || [0, 0, 0];
      copy.pos = [(p[0] || 0) + local.x, (p[1] || 0) + local.y, (p[2] || 0) + local.z];
      parent.children = [...(parent.children || []), copy];
    } else {
      const m = new THREE.Matrix4().fromArray(board.world[i]);
      const p = new THREE.Vector3(), q = new THREE.Quaternion();
      m.decompose(p, q, new THREE.Vector3());
      copy.pos = p.toArray();
      // Only replace the rotation when it came from a parent; otherwise keep the
      // body's own fields (euler as authored) exactly as they were.
      if (parentId) {
        copy.quat = [q.w, q.x, q.y, q.z];
        delete copy.euler;
      }
      loose.push(copy);
    }
  });
  if (loose.length) {
    const group = at ? sceneContentBounds(loose) : null;
    let dx = shift.x, dy = 0;
    if (group && at) {
      dx = at[0] - (group.min[0] + group.max[0]) / 2;
      dy = at[1] - (group.min[1] + group.max[1]) / 2;
      dx += clearAlongX({
        min: [group.min[0] + dx, group.min[1] + dy],
        max: [group.max[0] + dx, group.max[1] + dy],
      }, scene.nodes);
    }
    for (const copy of loose) copy.pos = [copy.pos[0] + dx, copy.pos[1] + dy, copy.pos[2]];
    scene.nodes = [...scene.nodes, ...loose];
  }
  return copies.map((c) => c.id);
}
