/**
 * What physics_get_object says about one body and the bodies under it.
 *
 * The scene graph as stored is no reply: a body's mesh arrays run to
 * megabytes, and a decomposed body carries every convex piece it collides as
 * as a geom of its own. A four-link arm of hollow brackets came back at about
 * 110 KB, nearly all of it pieces nobody authored and nobody can edit, each
 * with its own vertex count, box and watertight check. The pieces are counted
 * here, as physics_get_scene_summary counts them, and listed only with
 * `full`.
 */
import type { SceneGeom, SceneNode } from '../types/scene';
import type { BodyWorldPos } from './bodyWorld';
import type { PaintLayer } from './vertexPaint';
import { collisionReport, geomBboxOf, meshIntegrity } from './sceneSummary';

/** A paint layer as its colours, each with the vertices it covers, most first. */
function paintSummary(paint: PaintLayer): PaintLayer {
  const counts = new Map<string, number>();
  for (let i = 0; i < paint.idx.length; i++) {
    const [r, g, b] = [0, 1, 2].map((k) => paint.rgba[i * 4 + k]);
    const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  const colors = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([hex, vertices]) => ({ hex, vertices }));
  return { res: paint.res, idx: [], rgba: [], paintedVertices: paint.idx.length, colors } as PaintLayer;
}

export const stripMeshArrays = (node: SceneNode): SceneNode => {
  const cloned = { ...node };
  if (cloned.geoms) {
    cloned.geoms = cloned.geoms.map((g) => {
      const rest = { ...g };
      delete rest.vertices;
      delete rest.faces;
      delete rest.renderVertices;
      delete rest.colliderVertices;
      delete rest.colliderFaces;
      delete rest.baseColliderVertices;
      // The undeformed copy a dented or reshaped mesh keeps: as big as the mesh.
      delete rest.baseVertices;
      delete rest.baseRenderVertices;
      // Brushed colour is an entry per painted vertex: a striped cat's ran to
      // 61 KB and overflowed physics_get_state on its own. Its colours are
      // listed instead; the arrays come with include_meshes / get_scene,
      // beside the vertices they index.
      if (rest.paint) rest.paint = paintSummary(rest.paint);
      // A text pattern's saved letter outlines are kilobytes of coordinates.
      if (rest.textures?.some((t) => t.options?.outline)) {
        rest.textures = rest.textures.map((t) => {
          if (!t.options?.outline) return t;
          const { outline: _outline, outlineSig: _sig, imageGrid: _grid, ...options } = t.options;
          return { ...t, options };
        });
      }
      return rest;
    });
  }
  if (cloned.children) {
    cloned.children = cloned.children.map(stripMeshArrays);
  }
  return cloned;
};

export interface ObjectReplyOptions {
  /** List every convex piece and exact pin or socket collider, and the generated SCAD. */
  full?: boolean;
  /** World positions by body id (bodyWorldPositions). */
  world?: Map<string, BodyWorldPos>;
}

const round = (v: number) => +v.toFixed(6);

/** A mesh geom with its size and integrity checks in place of its arrays. */
const withMeshChecks = (g: SceneGeom): SceneGeom => (g.type === 'mesh'
  ? { ...g, vertCount: (g.renderVertices || g.vertices || []).length / 3, faceCount: (g.faces || []).length / 3, bbox: geomBboxOf(g), ...meshIntegrity(g) } as SceneGeom
  : g);

/** Generated geoms an author never wrote: convex pieces, and a split part's exact pin and socket colliders. */
const generatedCollider = (g: SceneGeom) => g.csgDerived === 'collider' || !!g.contactClass;

/** How it collides, without repeating the raw fields the node already carries. */
function collisionVerdict(node: SceneNode): Record<string, unknown> {
  const { collisionWarning: _w, collisionError: _e, solidity: _s, cavitiesFilled: _c, ...verdict } = collisionReport(node);
  return verdict;
}

function replyNode(node: SceneNode, opts: ObjectReplyOptions): Record<string, unknown> {
  const geoms = node.geoms || [];
  const listed = opts.full ? geoms : geoms.filter((g) => !generatedCollider(g));
  const pieces = geoms.filter((g) => g.csgDerived === 'collider').length;
  const exact = geoms.filter((g) => g.contactClass);
  const { csgScad, ...rest } = node;
  const world = opts.world?.get(node.id);
  return {
    ...stripMeshArrays({ ...rest, geoms: listed.map(withMeshChecks), children: [] } as SceneNode),
    ...(opts.full && csgScad !== undefined ? { csgScad } : {}),
    ...(world ? { worldPos: world.pos.map(round), worldPosSource: world.source } : {}),
    ...(node.csgEnabled ? {} : collisionVerdict(node)),
    ...(!opts.full && pieces ? { colliderGeoms: pieces } : {}),
    ...(!opts.full && exact.length ? {
      exactColliders: {
        pins: exact.filter((g) => g.contactClass === 'pin').length,
        sockets: exact.filter((g) => g.contactClass === 'socket').length,
      },
    } : {}),
    children: (node.children || []).map((c) => replyNode(c, opts)),
  };
}

export function objectReply(node: SceneNode, opts: ObjectReplyOptions = {}): Record<string, unknown> {
  return replyNode(node, opts);
}
