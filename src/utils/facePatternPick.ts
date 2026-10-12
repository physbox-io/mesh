// ---------------------------------------------------------------------------
// Which geom, and where on it, a pick for a surface pattern lands.
//
// A pattern belongs to the surface that is drawn: a boolean body's compiled
// mesh rather than the box it was cut from, an ordinary body's own shapes.
// The pick is made in the body's frame and handed back in the geom's own
// frame, which is the frame utils/surfaceTexture.ts grows the region in (see
// utils/geomSurface.ts).
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { SceneGeom, SceneNode } from '../types/scene';
import { geomRayHits, resolveCsgGeoms } from './csg';
import { getGeomFrame } from './laserCutExporter';
import { geomHalfLen, geomLocalSurface } from './geomSurface';
import { textureIndexAt } from './surfaceTexture';

/** A face picked for a pattern: the geom, and the seed in its own frame. */
export interface PatternPick {
  geomName: string;
  seedAt: number[];
  seedNormal: number[];
  /** The pattern already on the face picked, which the pick opens rather than adding another. */
  index?: number;
}

const PATTERNABLE = new Set(['box', 'sphere', 'ellipsoid', 'cylinder', 'capsule', 'mesh']);

/**
 * The nearest drawn surface a ray in the body's frame meets, or null if it
 * meets none.
 */
export function pickPatternFace(node: SceneNode, origin: number[], direction: number[]): PatternPick | null {
  const o = new THREE.Vector3(origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0);
  const d = new THREE.Vector3(direction[0] ?? 0, direction[1] ?? 0, direction[2] ?? 0);
  if (d.lengthSq() < 1e-18) return null;
  d.normalize();

  let best: { geom: SceneGeom; t: number; normal: number[] } | null = null;
  for (const geom of resolveCsgGeoms(node, 'render')) {
    if (geom.role === 'collision' || !PATTERNABLE.has(geom.type)) continue;
    for (const hit of geomRayHits(geom, o, d)) {
      if (hit.t > 1e-9 && (!best || hit.t < best.t)) best = { geom, t: hit.t, normal: hit.normal };
    }
  }
  if (!best) return null;

  const at = o.clone().addScaledVector(d, best.t);
  const normal = new THREE.Vector3(best.normal[0], best.normal[1], best.normal[2]);
  // Facing the ray, as pickCutSpot does: a backwards triangle would otherwise
  // hand back the inside of the face.
  if (normal.dot(d) > 0) normal.negate();

  // geomRayHits reads a mesh at renderVertices + pos and a primitive in its
  // own frame; the seed goes back the same way.
  if (best.geom.type === 'mesh') {
    const p = best.geom.pos || [0, 0, 0];
    at.sub(new THREE.Vector3(p[0] || 0, p[1] || 0, p[2] || 0));
  } else {
    const inverse = getGeomFrame(best.geom).matrix.clone().invert();
    at.applyMatrix4(inverse);
    normal.transformDirection(inverse);
  }
  const round = (v: THREE.Vector3) => v.toArray().map((x) => +x.toFixed(7));
  const pick: PatternPick = { geomName: best.geom.name, seedAt: round(at), seedNormal: round(normal.normalize()) };
  const textures = best.geom.textures;
  if (textures?.length) {
    const base = geomLocalSurface(best.geom, geomHalfLen(best.geom));
    const index = base ? textureIndexAt(base.positions, base.faces, textures, pick.seedAt, pick.seedNormal) : -1;
    if (index >= 0) pick.index = index;
  }
  return pick;
}

/** The face the pattern dialog is open on. `index` is the pattern being edited; absent for a new one. */
export interface FacePatternTarget extends PatternPick {
  nodeId: string;
}
