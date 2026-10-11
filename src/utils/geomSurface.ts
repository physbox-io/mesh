// ---------------------------------------------------------------------------
// A geom's surface as triangles in its own frame, with its patterns on.
//
// Every exporter reaches a geom's triangles through appendSolidTriangles in
// contourSliceExporter.ts, and that comes here. So a pattern laid on a face
// (utils/surfaceTexture.ts) is machined, sliced, moulded and split for print
// without any of them knowing patterns exist. The physics never comes here:
// mjcf.ts emits the geom as it was authored, so a pattern costs the
// simulation nothing.
//
// "Its own frame" is the one pos/quat/size are given in: a primitive about its
// centre with a cylinder along +Z, a mesh in its renderVertices (Z-up). A
// texture's seed is a point in this frame too.
//
// The textured mesh is derived, and big -- a 100 mm face at 0.4 mm is a
// quarter of a million triangles -- so it is never written into the scene
// graph, where it would ride along in every save, preset and undo step. It is
// cached here instead, keyed by the base surface and the textures, and built
// again from them whenever the cache does not have it.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { SceneGeom } from '../types/scene';
import { getGeomFrame, yupVertsToZup } from './laserCutExporter';
import { applySurfaceTextures, type TexturedSurface } from './surfaceTexture';

/**
 * Appends the geom's own triangles, untextured, placed by `matrix`. Returns
 * false for shapes with no volume, which append nothing useful.
 */
export function appendBaseGeomTriangles(
  geom: SceneGeom,
  halfLen: number | undefined,
  matrix: THREE.Matrix4,
  out: number[]
): boolean {
  const s = geom.size || [];
  const r = s[0] || 0.01;
  let geometry: THREE.BufferGeometry;

  switch (geom.type) {
    case 'box':
      geometry = new THREE.BoxGeometry(2 * (s[0] || 0.01), 2 * (s[1] || 0.01), 2 * (s[2] || 0.01));
      break;
    case 'sphere':
      geometry = new THREE.SphereGeometry(r, 48, 24);
      break;
    case 'ellipsoid':
      geometry = new THREE.SphereGeometry(1, 48, 24).scale(s[0] || 0.01, s[1] || 0.01, s[2] || 0.01);
      break;
    case 'cylinder':
      // three builds these around +Y; the scene's primitives run along local +Z.
      geometry = new THREE.CylinderGeometry(r, r, 2 * (halfLen ?? s[1] ?? r), 48).rotateX(Math.PI / 2);
      break;
    case 'capsule':
      geometry = new THREE.CapsuleGeometry(r, 2 * (halfLen ?? s[1] ?? r), 12, 32).rotateX(Math.PI / 2);
      break;
    case 'mesh': {
      // vertices is the Y-up (three.js) copy; renderVertices shares its space
      // with pos/euler/size, and therefore with `matrix`.
      const verts = geom.renderVertices ?? yupVertsToZup(geom.vertices || []);
      const faces = geom.faces || [];
      if (verts.length === 0 || faces.length === 0) return false;
      return appendIndexed(verts, faces, matrix, out);
    }
    // A plane is the infinite ground, not stock to be cut.
    default:
      return false;
  }

  const nonIndexed = geometry.index ? geometry.toNonIndexed() : geometry;
  nonIndexed.applyMatrix4(matrix);
  const pos = nonIndexed.attributes.position.array;
  for (let i = 0; i < pos.length; i++) out.push(pos[i]);
  return true;
}

function appendIndexed(verts: ArrayLike<number>, faces: ArrayLike<number>, matrix: THREE.Matrix4, out: number[]): boolean {
  const v = new THREE.Vector3();
  for (let i = 0; i + 2 < faces.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const vi = faces[i + k] * 3;
      if (vi + 2 >= verts.length) return false;
      v.set(verts[vi], verts[vi + 1], verts[vi + 2]).applyMatrix4(matrix);
      out.push(v.x, v.y, v.z);
    }
  }
  return true;
}

/**
 * The geom's untextured surface in its own frame, as a triangle soup (every
 * corner its own vertex). Null for a shape with no surface.
 */
export function geomLocalSurface(geom: SceneGeom, halfLen?: number): { positions: number[]; faces: number[] } | null {
  const positions: number[] = [];
  if (!appendBaseGeomTriangles(geom, halfLen, new THREE.Matrix4(), positions) || positions.length < 9) return null;
  return { positions, faces: Array.from({ length: positions.length / 3 }, (_, i) => i) };
}

/** A cylinder or capsule given by `fromto` has its length there, not in `size`. */
export function geomHalfLen(geom: SceneGeom): number | undefined {
  return getGeomFrame(geom).halfLen;
}

// --- the cache ---------------------------------------------------------------

// Mesh arrays are shared by reference between the copies of a geom the store
// makes (see cloneGeom), so an array's identity says "the same mesh" without
// hashing a quarter of a million numbers.
const arrayIds = new WeakMap<object, number>();
let nextArrayId = 1;
const idOf = (a: object | undefined) => {
  if (!a) return 0;
  let id = arrayIds.get(a);
  if (id === undefined) {
    id = nextArrayId++;
    arrayIds.set(a, id);
  }
  return id;
};

/** Entries kept. Each is tens of megabytes at the densest. */
const CACHE_SIZE = 8;
const cache = new Map<string, TexturedSurface>();

/** What the textured surface of this geom depends on, as one string. */
export function texturedSurfaceKey(geom: SceneGeom, halfLen?: number): string {
  const base = geom.type === 'mesh'
    ? `mesh:${idOf(geom.renderVertices ?? geom.vertices)}:${idOf(geom.faces)}`
    : `${geom.type}:${(geom.size || []).join(',')}:${halfLen ?? ''}`;
  return `${base}|${JSON.stringify(geom.textures ?? [])}`;
}

/** The cached textured surface, without building it. */
export function cachedTexturedSurface(geom: SceneGeom, halfLen?: number): TexturedSurface | null {
  if (!geom.textures?.length) return null;
  const key = texturedSurfaceKey(geom, halfLen);
  const hit = cache.get(key);
  if (!hit) return null;
  // Most recently used goes to the back, so the front is what is evicted.
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

export function storeTexturedSurface(key: string, surface: TexturedSurface): void {
  cache.delete(key);
  cache.set(key, surface);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
}

/**
 * The geom's surface with its patterns on, built now if it is not cached.
 * Null when the geom has no patterns, or no surface to put them on.
 */
export function texturedSurfaceOf(geom: SceneGeom, halfLen?: number): TexturedSurface | null {
  if (!geom.textures?.length) return null;
  const hit = cachedTexturedSurface(geom, halfLen);
  if (hit) return hit;
  const base = geomLocalSurface(geom, halfLen);
  if (!base) return null;
  const surface = applySurfaceTextures(base.positions, base.faces, geom.textures);
  storeTexturedSurface(texturedSurfaceKey(geom, halfLen), surface);
  return surface;
}

/**
 * Appends the geom's triangles placed by `matrix`: patterned where it has
 * patterns, as authored where it does not.
 */
export function appendGeomTriangles(
  geom: SceneGeom,
  halfLen: number | undefined,
  matrix: THREE.Matrix4,
  out: number[]
): boolean {
  const textured = texturedSurfaceOf(geom, halfLen);
  if (textured && textured.regions.some((r) => r.applied)) {
    return appendIndexed(textured.vertices, textured.faces, matrix, out);
  }
  return appendBaseGeomTriangles(geom, halfLen, matrix, out);
}
