/**
 * A cloth's model for a read-back the live model cannot answer (the physics
 * worker has not published it yet: a preset loading, a rebuild, one just
 * added; or what it published is stale). In the app, the modelling pool's
 * (clothModelClient) if it has made it, else null: never modelled on the
 * main thread, where it froze the tab for seconds. Headless (no Worker),
 * modelled here, as the worker would.
 */

import type { SceneNode } from '../../types/scene';
import { clothModel, type ClothModel } from './clothModel';
import { clothInputs } from './clothInputs';
import { cachedClothModel } from './clothModelClient';
import { clothWorldMatrix } from './clothFrame';

export function modelForReadBack(node: SceneNode, scene: SceneNode[]): ClothModel | null {
  const input = clothInputs(scene).find((c) => c.node === node || (c.node.name || c.node.id) === (node.name || node.id));
  const made = input && cachedClothModel(input.exact);
  if (made) return made;
  if (typeof Worker !== 'undefined') return null;
  return clothModel(node, input?.world ?? clothWorldMatrix(scene, node), scene);
}
