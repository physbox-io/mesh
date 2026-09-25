/**
 * The edges a body offers for rounding, found on its UNROUNDED shape.
 *
 * Edges are picked on the solid as modelled — holes cut, booleans done, but no
 * roundings — because that is where the edges a person means actually are: a
 * rounded edge has no edge left to click, and the one next to it is two
 * tangent seams. So the body's program is compiled once more with its
 * roundings left out (csgProgram's `rounds: false`), through the same OpenSCAD
 * pool and cache as everything else, and the edges are found on that.
 *
 * The result is in the body's source frame. Anything drawn over the compiled
 * body has to shift by csgFrameOffset, the same as the cut ghosts do.
 */
import * as THREE from 'three';
import type { SceneNode } from '../types/scene';
import { csgProgram } from './csg';
import { findFeatureEdges, type FeatureEdges } from './featureEdges';
import { nodeWorldMatrix } from './combineBodies';

export interface BodyEdges extends FeatureEdges {
  /** The unrounded solid the edges were found on, source frame, Z-up. */
  positions: number[];
  faces: number[];
  /** The smallest side of its bounding box, metres — what a suggested size is scaled to. */
  smallestDimension: number;
}

const cache = new Map<string, BodyEdges>();
const CACHE_LIMIT = 8;

/** Why a body cannot be rounded, in words for the panel; null when it can. */
export function whyNotRoundable(node: SceneNode | null | undefined): string | null {
  if (!node) return 'Select a part first.';
  if (node.isSculpt) return 'Sculpted clay has no sharp edges to round — smooth it with the brushes instead.';
  const solid = (node.geoms || []).some((g) => !g.csgDerived && g.type !== 'plane' && (!g.csg || g.csg === 'union') && g.role !== 'visual');
  if (!solid) return 'This part has no solid shape to round.';
  return null;
}

/** Which way is up in this body's own frame, so Top and Bottom mean the world's. */
export function bodyUp(nodes: SceneNode[], id: string): [number, number, number] {
  const m = nodeWorldMatrix(nodes, id);
  if (!m) return [0, 0, 1];
  const rotation = new THREE.Matrix4().extractRotation(m).invert();
  const up = new THREE.Vector3(0, 0, 1).applyMatrix4(rotation).normalize();
  return [up.x, up.y, up.z];
}

export async function bodyEdges(node: SceneNode, up: [number, number, number] = [0, 0, 1]): Promise<BodyEdges> {
  const program = csgProgram(node, { rounds: false, always: true });
  if (!program) throw new Error('This part has no solid shape to round.');
  const key = `${up.map((c) => c.toFixed(4)).join(',')}\n${program}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const { compileSCAD } = await import('./openscad');
  const compiled = await compileSCAD(program);
  const positions = compiled.renderVertices;
  const faces = compiled.faces;
  const found = findFeatureEdges(positions, faces, { up });

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[i + k]);
      max[k] = Math.max(max[k], positions[i + k]);
    }
  }
  const smallestDimension = Math.min(max[0] - min[0], max[1] - min[1], max[2] - min[2]);

  const result: BodyEdges = { ...found, positions, faces, smallestDimension };
  cache.set(key, result);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return result;
}
