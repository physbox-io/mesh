/**
 * What each cloth of a scene is modelled from (clothModel): its node, where
 * it stands, and the form it is cut to; and the key a model is cached by.
 * One function for the physics worker (clothWorld) and the main thread's
 * modelling pool (clothModelClient), so the two agree on which model is
 * which. Pure: give it the graph as the worker gets it (withoutMeshData).
 */

import type * as THREE from 'three';
import type { SceneNode } from '../../types/scene';
import { walkBodiesWorld } from '../bodyWorld';
import { clothFrame } from './clothFrame';

export interface ClothInput {
  node: SceneNode;
  world: THREE.Matrix4;
  /** The form it is fitted to, if any. */
  form: SceneNode | undefined;
  /** The measurements a garment is cut to (its form's, or its own once let go of it); null for plain cloth. */
  cut: unknown;
  /** Everything its model depends on, colours and prints included: the model cache's key. */
  exact: string;
}

export function clothInputs(nodes: SceneNode[]): ClothInput[] {
  const cloths: { node: SceneNode; world: THREE.Matrix4 }[] = [];
  walkBodiesWorld(nodes, (n, world) => { if (n.cloth) cloths.push({ node: n, world }); });
  return cloths.map(({ node, world: own }) => {
    const world = clothFrame(nodes, node, own);
    const draft = node.cloth?.garment, fit = draft?.fitTo;
    let form: SceneNode | undefined;
    if (fit) walkBodiesWorld(nodes, (m) => { if ((m.name || m.id) === fit && m.bodyForm) form = m; });
    const cut = draft ? (form?.bodyForm ?? draft.form ?? null) : null;
    return { node, world, form, cut, exact: JSON.stringify([node.name || node.id, node.cloth, Array.from(world.elements), cut]) };
  });
}
