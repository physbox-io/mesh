// A part's solids as triangle soups, for the tools that work on what will be
// printed or molded: the split, the knife and the silicone pour box. Kept apart
// from printSplitClient, which starts a worker, so a worker can use it.

import * as THREE from 'three';
import type { SceneNode } from '../types/scene';
import { appendSolidTriangles } from './contourSliceExporter';
import { getNodeWorldTransform } from './laserCutExporter';
import { resolveCsgGeoms } from './csg';
import { isBoughtIn } from './boughtIn';
import { isPourTooling } from './pourTooling';

/**
 * A part's solids as the split takes them: one triangle soup per geom, in the
 * selected body's own frame (Z-up metres), booleans already applied.
 *
 * "The part" is the body and every body rigidly attached under it — children
 * with no joints of their own, all the way down. A model built as a parent
 * holding its panels (the birdhouse is a bare root with seven walls under it)
 * is one part to print, and splitting only the root's own geoms would find
 * nothing at all. A child that has a joint moves on its own, so it is a
 * separate part, and it and everything under it are left out.
 *
 * Only collision-only geoms are skipped. A compiled boolean's mesh is marked
 * visual-only for the physics (its primitives collide), but it is exactly the
 * shape to print — the same rule collectSceneTriangles follows.
 */
export function partSoups(node: SceneNode, frame = new THREE.Matrix4()): { soups: Float64Array[]; absorbed: string[] } {
  const soups: Float64Array[] = [];
  const absorbed: string[] = [];
  const add = (n: SceneNode, frame: THREE.Matrix4) => {
    for (const geom of isBoughtIn(n) ? [] : resolveCsgGeoms(n, 'render')) {
      if (geom.role === 'collision') continue;
      const out: number[] = [];
      if (appendSolidTriangles(geom, frame, out) && out.length >= 36) soups.push(Float64Array.from(out));
    }
    for (const child of n.children || []) {
      // A seated screw has no joint either, but it is bought, not printed; a
      // pour box's pin is tooling round the part, not part of it.
      if (child.joints?.length || isBoughtIn(child) || isPourTooling(child)) continue;
      absorbed.push(child.id);
      add(child, getNodeWorldTransform(child, frame));
    }
  };
  add(node, frame);
  return { soups, absorbed };
}
