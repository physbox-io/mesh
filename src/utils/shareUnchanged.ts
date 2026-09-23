// Hands a new scene graph back the node objects of the old one wherever a node
// came through an edit unchanged.
//
// Every store action clones the whole graph and edits its copy, so after any
// edit every node — and every geom's rgba array — was a new object. Nothing in
// the viewport could then skip a render: SceneLayer passes each DynamicGeom its
// node and colour, and React.memo compares them by reference. This runs where
// the store takes a new graph and swaps each node that compares equal back to
// the object it was, so an edit to one body re-renders that body.
//
// It edits `next` in place rather than returning a copy. The store tells a build
// that the scene moved on by comparing graph objects (see recompile's
// `graphAtBuildStart`), and an action hands the same object to set() and to
// recompile(), so the top-level object has to be the one it was given.

import type { SceneGeom, SceneGraph, SceneNode } from '../types/scene';

/** Replaced wholesale, never edited in place, so compared by reference. See cloneGeom. */
const SHARED_GEOM_ARRAYS = ['vertices', 'faces', 'renderVertices', 'baseVertices', 'baseRenderVertices', 'paint'] as const;

function geomSignature(g: SceneGeom): string {
  const rest: Record<string, unknown> = { ...g };
  for (const k of SHARED_GEOM_ARRAYS) delete rest[k];
  return JSON.stringify(rest);
}

function nodeSignature(n: SceneNode): string {
  const { geoms: _geoms, children: _children, ...rest } = n;
  return JSON.stringify(rest);
}

function geomsEqual(a: SceneGeom[] | undefined, b: SceneGeom[] | undefined): boolean {
  const x = a || [];
  const y = b || [];
  if (x === y) return true;
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    const p = x[i];
    const q = y[i];
    if (p === q) continue;
    for (const k of SHARED_GEOM_ARRAYS) if (p[k] !== q[k]) return false;
    if (geomSignature(p) !== geomSignature(q)) return false;
  }
  return true;
}

function shareList(prev: SceneNode[] | undefined, next: SceneNode[] | undefined): void {
  if (!prev?.length || !next?.length || prev === next) return;
  const byId = new Map<string, SceneNode>();
  for (const p of prev) byId.set(p.id, p);
  for (let i = 0; i < next.length; i++) {
    const n = next[i];
    const p = byId.get(n.id);
    if (!p || p === n) continue;
    shareList(p.children, n.children);
    const pc = p.children || [];
    const nc = n.children || [];
    if (pc.length !== nc.length || nc.some((c, j) => c !== pc[j])) continue;
    if (!geomsEqual(p.geoms, n.geoms)) continue;
    if (nodeSignature(p) !== nodeSignature(n)) continue;
    next[i] = p;
  }
}

export function shareUnchanged(prev: SceneGraph | null | undefined, next: SceneGraph): SceneGraph {
  if (prev && prev !== next) shareList(prev.nodes, next.nodes);
  return next;
}
