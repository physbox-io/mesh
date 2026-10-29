/**
 * What a headless run does not simulate, named body by body.
 *
 * Welds, members, joint blobs and crumple zones break inside the physics
 * worker's own step, so physics_run_headless breaks them as the live run does.
 * Shattering and denting do not: the worker only REPORTS an impact, and the
 * store on the main thread decides, cuts the shards (in the fracture worker)
 * and rebuilds the model around them while the old one keeps stepping. A
 * headless run steps a model of its own, start to finish, inside one worker
 * call, with nobody to hand an impact to, so a drop that shatters live
 * finished whole headless and get_breaks had nothing to say. Until the cut and
 * the rebuild can run inside the worker, the run says which bodies it is
 * leaving whole and unmarked rather than letting the trajectory stand for
 * what would happen.
 */
import type { SceneNode } from '../types/scene';
import { canDent, canShatter } from './breakThresholds';

export function unsimulatedImpacts(nodes: SceneNode[] | undefined): { shatter: string[]; dent: string[] } {
  const shatter: string[] = [];
  const dent: string[] = [];
  const walk = (list: SceneNode[] | undefined) => {
    for (const node of list ?? []) {
      if (canShatter(node)) shatter.push(node.name || node.id);
      else if ((node.geoms ?? []).some((g) => canDent(g))) dent.push(node.name || node.id);
      walk(node.children);
    }
  };
  walk(nodes);
  return { shatter, dent };
}

/** The warning for a headless reply, or null when nothing in the scene can shatter or dent. */
export function headlessImpactWarning(nodes: SceneNode[] | undefined): string | null {
  const { shatter, dent } = unsimulatedImpacts(nodes);
  const parts: string[] = [];
  if (shatter.length) parts.push(`${shatter.join(', ')} ${shatter.length === 1 ? 'is' : 'are'} set to shatter`);
  if (dent.length) parts.push(`${dent.join(', ')} ${dent.length === 1 ? 'is' : 'are'} set to dent`);
  if (!parts.length) return null;
  return `${parts.join(', and ')}, which a headless run does not simulate: they stay whole and unmarked however hard they are hit, and physics_get_breaks will not list them. Welds, members, blobs and crumple zones do break here. Play the scene live (physics_play, then physics_get_breaks) to see the impacts.`;
}
