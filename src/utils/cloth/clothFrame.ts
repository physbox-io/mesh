import * as THREE from 'three';
import type { SceneNode } from '../../types/scene';
import { walkBodiesWorld } from '../bodyWorld';

/**
 * The frame a cloth node is modelled in: a garment fitted to a form is worn
 * wherever the form stands, whatever its own pos says (a garment left at the
 * origin while its form stood elsewhere hung in the air beside it, and moving
 * a form left its clothes behind); anything else, its own.
 */
export function clothFrame(nodes: SceneNode[] | undefined, node: SceneNode, own: THREE.Matrix4): THREE.Matrix4 {
  const fit = node.cloth?.garment?.fitTo;
  if (!fit) return own;
  let form: THREE.Matrix4 | null = null;
  walkBodiesWorld(nodes, (n, w) => { if (!form && n.bodyForm && (n.name || n.id) === fit) form = w; });
  return form ?? own;
}

/** Where `node` is modelled in the world: its place in the graph (parents, euler or quat), then clothFrame. */
export function clothWorldMatrix(nodes: SceneNode[] | undefined, node: SceneNode): THREE.Matrix4 {
  let own: THREE.Matrix4 | null = null;
  walkBodiesWorld(nodes, (n, w) => { if (!own && n === node) own = w; });
  if (!own) walkBodiesWorld([node], (n, w) => { if (!own && n === node) own = w; });
  return clothFrame(nodes, node, own ?? new THREE.Matrix4());
}
