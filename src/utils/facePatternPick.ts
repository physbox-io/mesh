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
import { geomHalfLen, geomLocalSurface, texturedSurfaceKey } from './geomSurface';
import { patternRegionAt, textureIndexAt } from './surfaceTexture';

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
  return castPatternRay(node, origin, direction)?.pick ?? null;
}

/** The face a pattern would go on, to light up: triangles and edge in the body's frame. */
export interface PatternFaceGlow {
  /** Which face this is, to tell a move onto another face from one across the same face. */
  key: string;
  triangles: Float32Array;
  outline: Float32Array;
}

/**
 * The face a ray in the body's frame would put a pattern on — the pattern
 * already there, or the region a new one would cover — or null.
 */
export function patternFaceGlow(node: SceneNode, origin: number[], direction: number[]): PatternFaceGlow | null {
  const hit = castPatternRay(node, origin, direction);
  return hit ? glowOf(hit.geom, hit.pick) : null;
}

/** The face a pick already made covers, as patternFaceGlow; for the face the pattern dialog is open on. */
export function pickedFaceGlow(node: SceneNode, pick: PatternPick): PatternFaceGlow | null {
  const geom = resolveCsgGeoms(node, 'render').find((g) => g.name === pick.geomName);
  return geom ? glowOf(geom, pick) : null;
}

function glowOf(geom: SceneGeom, pick: PatternPick): PatternFaceGlow | null {
  const base = baseSurface(geom);
  if (!base) return null;
  const region = patternRegionAt(base.positions, base.faces, geom.textures ?? [], pick.seedAt, pick.seedNormal);
  if (!region) return null;
  // Back from the geom's frame to the body's, the way castPatternRay came.
  const matrix = geom.type === 'mesh'
    ? new THREE.Matrix4().makeTranslation(geom.pos?.[0] || 0, geom.pos?.[1] || 0, geom.pos?.[2] || 0)
    : getGeomFrame(geom).matrix;
  const v = new THREE.Vector3();
  for (const list of [region.triangles, region.outline]) {
    for (let i = 0; i < list.length; i += 3) {
      v.set(list[i], list[i + 1], list[i + 2]).applyMatrix4(matrix);
      list[i] = v.x; list[i + 1] = v.y; list[i + 2] = v.z;
    }
  }
  // The first triangle of a region is its seed's, so it names the face.
  const t = region.triangles;
  return { key: `${geom.name}|${t.length}|${t[0]},${t[1]},${t[2]}`, ...region };
}

/*
 * A geom's surface in its own frame, kept by its shape: the region search
 * indexes the surface it is handed once per array, and a hover asks on
 * every move.
 */
const bases = new Map<string, { positions: number[]; faces: number[] } | null>();
function baseSurface(geom: SceneGeom) {
  const halfLen = geomHalfLen(geom);
  const key = texturedSurfaceKey(geom, halfLen);
  if (!bases.has(key)) {
    bases.set(key, geomLocalSurface(geom, halfLen));
    while (bases.size > 8) bases.delete(bases.keys().next().value!);
  }
  return bases.get(key)!;
}

/**
 * The face at a point given in the body's frame, for a pick made by
 * coordinates rather than a click (MCP). With `normal` the point is looked at
 * from just outside along it; without, from all six axis directions, keeping
 * the surface that passes nearest the point. Null when no surface is within
 * a centimetre.
 */
export function patternPickAt(node: SceneNode, at: number[], normal?: number[]): PatternPick | null {
  const OUT = 0.005;
  const p = new THREE.Vector3(at[0] ?? 0, at[1] ?? 0, at[2] ?? 0);
  const looks = normal && Math.hypot(normal[0] ?? 0, normal[1] ?? 0, normal[2] ?? 0) > 1e-9
    ? [new THREE.Vector3(normal[0] ?? 0, normal[1] ?? 0, normal[2] ?? 0).normalize()]
    : [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map((d) => new THREE.Vector3(...d));
  let best: { pick: PatternPick; off: number } | null = null;
  for (const n of looks) {
    const origin = p.clone().addScaledVector(n, OUT);
    const hit = castPatternRay(node, origin.toArray(), n.clone().negate().toArray());
    if (!hit) continue;
    const off = Math.abs(hit.t - OUT);
    if (off <= 0.01 && (!best || off < best.off)) best = { pick: hit.pick, off };
  }
  return best?.pick ?? null;
}

function castPatternRay(node: SceneNode, origin: number[], direction: number[]): { pick: PatternPick; t: number; geom: SceneGeom } | null {
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
    const base = baseSurface(best.geom);
    const index = base ? textureIndexAt(base.positions, base.faces, textures, pick.seedAt, pick.seedNormal) : -1;
    if (index >= 0) pick.index = index;
  }
  return { pick, t: best.t, geom: best.geom };
}

/** The face the pattern dialog is open on. `index` is the pattern being edited; absent for a new one. */
export interface FacePatternTarget extends PatternPick {
  nodeId: string;
}

/**
 * The detail of a `physbox:pattern-glow` event: the face to light up, or
 * null to put the light out. The pattern dialog sends it; the scene draws it.
 */
export type FacePatternGlowEvent = FacePatternTarget | null;
