// ---------------------------------------------------------------------------
// Connect anchors that move with their body
//
// A connect's anchor is written in world space (the MCP API and the four-bar
// builder both state it that way), and nothing moved it: duplicate a linkage
// and the copy's pin stayed on the original, 97 mm away; move both connected
// bodies and the solver yanked one back to where the pin used to be.
//
// So the store keeps the point in the body's own frame as well. On every
// scene it is given: an anchor that was just written (new, or different from
// the one this body had) is taken as meant and the local point worked out from
// it; otherwise the local point is the truth and the world anchor is put back
// on the body wherever the body now is. A pasted copy carries its local point
// with it, so its pin lands on the copy.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { SceneGraph, SceneNode } from '../types/scene';
import { nodeWorldMatrix } from './combineBodies';

const round = (v: number) => +v.toFixed(7);
const same = (a: number[] | undefined, b: number[] | undefined) =>
  !!a && !!b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

function anchorsById(nodes: SceneNode[] | undefined, out = new Map<string, number[] | undefined>()) {
  for (const n of nodes || []) {
    if (n.connectAnchor) out.set(n.id, n.connectAnchor);
    anchorsById(n.children, out);
  }
  return out;
}

/** `next` with every connect anchor on its body. The same object when nothing moved. */
export function withConnectAnchorsFollowing(prev: SceneGraph | undefined, next: SceneGraph): SceneGraph {
  const current = anchorsById(next.nodes);
  if (current.size === 0) return next;
  const before = anchorsById(prev?.nodes);

  const patches = new Map<string, Partial<SceneNode>>();
  const visit = (list: SceneNode[]) => {
    for (const n of list) {
      if (n.connectAnchor && n.connectAnchor.length >= 3) {
        const world = nodeWorldMatrix(next.nodes, n.id);
        if (world) {
          const written = before.has(n.id) ? !same(before.get(n.id), n.connectAnchor) : !n.connectAnchorLocal;
          if (written || !n.connectAnchorLocal) {
            const p = new THREE.Vector3(...(n.connectAnchor.slice(0, 3) as [number, number, number]))
              .applyMatrix4(world.clone().invert());
            const local = [round(p.x), round(p.y), round(p.z)];
            if (!same(local, n.connectAnchorLocal)) patches.set(n.id, { connectAnchorLocal: local });
          } else {
            const p = new THREE.Vector3(...(n.connectAnchorLocal.slice(0, 3) as [number, number, number])).applyMatrix4(world);
            const anchor = [round(p.x), round(p.y), round(p.z)];
            if (!same(anchor, n.connectAnchor.slice(0, 3))) patches.set(n.id, { connectAnchor: anchor });
          }
        }
      }
      visit(n.children || []);
    }
  };
  visit(next.nodes);
  if (patches.size === 0) return next;

  const rebuild = (list: SceneNode[]): SceneNode[] => {
    let changed = false;
    const out = list.map((n) => {
      const children = n.children ? rebuild(n.children) : n.children;
      const patch = patches.get(n.id);
      if (!patch && children === n.children) return n;
      changed = true;
      return { ...n, ...patch, ...(n.children ? { children } : {}) };
    });
    return changed ? out : list;
  };
  return { ...next, nodes: rebuild(next.nodes) };
}
