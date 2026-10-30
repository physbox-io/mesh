// ---------------------------------------------------------------------------
// One body's surface, a page at a time
// ---------------------------------------------------------------------------
//
// physics_get_object leaves the mesh arrays out, and physics_get_scene sends
// all of them at once, which on a scanned or sculpted master is more than the
// MCP link carries. This is the way between: one geom's triangles, placed in
// the world, `limit` of them from `offset`, with the offset of the next page.

import * as THREE from 'three';
import type { SceneGeom, SceneNode } from '../types/scene';
import { appendSolidTriangles } from './contourSliceExporter';
import { resolveCsgGeoms } from './csg';
import { getNodeWorldTransform } from './laserCutExporter';

export const MESH_PAGE_DEFAULT = 2000;
export const MESH_PAGE_MAX = 20000;

export interface MeshPage {
  geom: string;
  triangleCount: number;
  offset: number;
  /** One row per triangle: its three corners in world metres, x y z each, wound outward. */
  triangles: number[][];
  /** Where the next page starts; null on the last one. */
  nextOffset: number | null;
}

/** The world matrix of the body `id`, its parents' poses composed; null if it is not in the tree. */
function worldMatrixOf(nodes: SceneNode[], id: string, parent?: THREE.Matrix4): { node: SceneNode; matrix: THREE.Matrix4 } | null {
  for (const node of nodes) {
    const matrix = getNodeWorldTransform(node, parent);
    if (node.id === id) return { node, matrix };
    const hit = worldMatrixOf(node.children || [], id, matrix);
    if (hit) return hit;
  }
  return null;
}

const micron = (v: number) => Math.round(v * 1e6) / 1e6;

export function meshPage(
  nodes: SceneNode[],
  bodyId: string,
  opts: { geom?: string; offset?: number; limit?: number },
): MeshPage | { error: string } {
  const found = worldMatrixOf(nodes, bodyId);
  if (!found) return { error: `Object not found: ${bodyId}` };
  // The geoms as drawn: a body with holes gives its evaluated solid.
  const geoms = resolveCsgGeoms(found.node, 'render').filter((g) => g.role !== 'collision');
  const named = (g: SceneGeom, i: number) => g.name || `${g.type}_${i}`;
  let index = -1;
  if (opts.geom) index = geoms.findIndex((g, i) => named(g, i) === opts.geom);
  else if (geoms.length === 1) index = 0;
  if (index < 0) {
    const names = geoms.map(named).join(', ') || 'none';
    return {
      error: opts.geom
        ? `${found.node.name} has no geom "${opts.geom}"; its geoms are ${names}.`
        : `${found.node.name} has ${geoms.length} geoms; pass geom, one of ${names}.`,
    };
  }

  const flat: number[] = [];
  if (!appendSolidTriangles(geoms[index], found.matrix, flat)) {
    return { error: `${named(geoms[index], index)} has no volume to give triangles for.` };
  }
  const triangleCount = flat.length / 9;
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const limit = Math.min(MESH_PAGE_MAX, Math.max(1, Math.floor(opts.limit ?? MESH_PAGE_DEFAULT)));
  const end = Math.min(triangleCount, offset + limit);
  const triangles: number[][] = [];
  for (let t = offset; t < end; t++) triangles.push(flat.slice(t * 9, t * 9 + 9).map(micron));
  return {
    geom: named(geoms[index], index),
    triangleCount,
    offset,
    triangles,
    nextOffset: end < triangleCount ? end : null,
  };
}
