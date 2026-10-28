// ---------------------------------------------------------------------------
// Copying and searching the scene graph
//
// The store clones the graph on every edit and every undo snapshot, so the
// clone shares the big mesh arrays rather than copying them (see cloneGeom).
// ---------------------------------------------------------------------------

import type { SceneGraph, SceneNode, SceneGeom } from '../types/scene';

/**
 * The scratch fields the rotate helpers keep on a geom and a body between
 * absolute rotations: the unrotated vertices, so repeated rotations compound
 * from the same base rather than accumulating drift. Not part of the saved
 * document, but cloneGeom carries them across an edit.
 */
export type WorkingGeom = SceneGeom & { baseVertices?: number[]; baseRenderVertices?: number[] };

export type WorkingNode = SceneNode & { basePos?: number[] };

/**
 * Deep equality for scene-graph data, by reference wherever it can be.
 *
 * The comparison this replaces was `JSON.stringify(a) !== JSON.stringify(b)`,
 * which allocates two copies of every mesh in the scene — megabytes of vertex
 * data — to answer a question that is usually settled by the first `===`:
 * cloneSceneGraph shares those arrays by reference, so an untouched mesh is
 * literally the same array. Only data that genuinely arrived from somewhere
 * else (an MCP payload, a loaded file) is walked element by element.
 */
export const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    if (!sameValue(left[key], right[key])) return false;
  }
  return true;
};

// Structural clone of a scene graph that SHARES the large mesh arrays
// (vertices/faces/renderVertices) by reference instead of copying them.
// Every code path that changes mesh data replaces these arrays wholesale
// (scaleMeshGeoms, update*Params, scad compile) rather than mutating them in
// place, so sharing is safe — and it turns per-edit cloning from O(mesh bytes)
// into O(node count). This matters: the old JSON.parse(JSON.stringify(...))
// ran on every slider tick / handle drag and every undo snapshot, copying
// potentially megabytes of SCAD mesh data each time.
export const SHARED_GEOM_KEYS = new Set([
  'vertices',
  'faces',
  'renderVertices',
  'baseVertices',
  'baseRenderVertices',
  'colliderVertices',
  'colliderFaces',
  'paint',
]);

export const clonePlain = <T>(val: T): T => {
  if (val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) {
    const len = val.length;
    const out = new Array(len);
    for (let i = 0; i < len; i++) {
      const item = val[i];
      out[i] = item !== null && typeof item === 'object' ? clonePlain(item) : item;
    }
    return out as unknown as T;
  }
  const src = val as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key in src) {
    if (Object.prototype.hasOwnProperty.call(src, key)) {
      const v = src[key];
      if (v !== undefined) {
        out[key] = v !== null && typeof v === 'object' ? clonePlain(v) : v;
      }
    }
  }
  return out as T;
};

export const cloneGeom = (g: SceneGeom): SceneGeom => {
  // `paint` joins the mesh arrays in being shared rather than copied, for the
  // same reason: it is thousands of numbers, it is replaced wholesale rather
  // than mutated in place, and this clone runs on every slider tick and every
  // undo snapshot.
  const src = g as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key in src) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
    const v = src[key];
    if (v === undefined) continue;
    if (SHARED_GEOM_KEYS.has(key)) {
      out[key] = v;
    } else {
      out[key] = v !== null && typeof v === 'object' ? clonePlain(v) : v;
    }
  }
  return out as unknown as WorkingGeom;
};

export const cloneNode = (n: SceneNode): SceneNode => {
  const src = n as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key in src) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
    if (key === 'geoms' || key === 'children') continue;
    const v = src[key];
    if (v === undefined) continue;
    out[key] = v !== null && typeof v === 'object' ? clonePlain(v) : v;
  }
  out.geoms = (n.geoms || []).map(cloneGeom);
  out.children = (n.children || []).map(cloneNode);
  return out as unknown as SceneNode;
};

/** Depth-first lookup by node id. */
export const findNodeById = (nodes: SceneNode[], id: string): SceneNode | null => {
  for (const n of nodes || []) {
    if (n.id === id) return n;
    const found = findNodeById(n.children || [], id);
    if (found) return found;
  }
  return null;
};

/**
 * Swap one node out for several, wherever it sits in the tree.
 *
 * The shards go in at the same depth the body was, rather than at the top
 * level, so a vase that was parented to a table stays with the table.
 */
export const replaceNodeWith = (nodes: SceneNode[], id: string, replacements: SceneNode[]): SceneNode[] => {
  const out: SceneNode[] = [];
  for (const n of nodes || []) {
    if (n.id === id) { out.push(...replacements); continue; }
    const children = replaceNodeWith(n.children || [], id, replacements);
    out.push(children === n.children ? n : { ...n, children });
  }
  return out;
};

export const cloneSceneGraph = (sg: SceneGraph): SceneGraph => ({
  ...sg,
  nodes: (sg.nodes || []).map(cloneNode),
});

export const findNode = (nodes: SceneNode[] | undefined, id: string): SceneNode | null => {
  for (const node of nodes || []) {
    if (node.id === id || node.name === id) return node;
    const child = findNode(node.children, id);
    if (child) return child;
  }
  return null;
};

// ---------------------------------------------------------------------------
// Cuts
// ---------------------------------------------------------------------------

export const addChildNode = (nodes: SceneNode[], parentId: string, newNode: SceneNode): boolean => {
  for (const node of nodes) {
    if (node.id === parentId) {
      if (!node.children) node.children = [];
      node.children.push(newNode);
      return true;
    }
    if (node.children && addChildNode(node.children, parentId, newNode)) {
      return true;
    }
  }
  return false;
};
