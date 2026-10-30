/**
 * What a headless run does not simulate, named body by body.
 *
 * A headless run stops at every blow and asks what it did, as the live run
 * asks the store (hooks/mcp/headlessImpacts.ts), so bodies shatter and
 * surfaces dent there as they do live. One thing is left out: a surface set to
 * `deformCollision` has its damage made real to the solver live, by rebuilding
 * the model around the deformed mesh after every blow. Headless, its dents are
 * recorded and the solver goes on with the undented surface, so the run says
 * so rather than letting the trajectory stand for a part that has been holed.
 */
import type { SceneNode } from '../types/scene';
import { canDent } from './breakThresholds';

/** Bodies with a surface whose damage the live solver feels and a headless run does not. */
export function unsimulatedImpacts(nodes: SceneNode[] | undefined): string[] {
  const out: string[] = [];
  const walk = (list: SceneNode[] | undefined) => {
    for (const node of list ?? []) {
      const real = (node.geoms ?? []).some((g) => g.deformCollision
        && (canDent(g) || (typeof g.pierceImpulseNs === 'number' && g.pierceImpulseNs > 0)));
      if (real) out.push(node.name || node.id);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** The warning for a headless reply, or null when nothing in the scene deforms its collision shape. */
export function headlessImpactWarning(nodes: SceneNode[] | undefined): string | null {
  const bodies = unsimulatedImpacts(nodes);
  if (!bodies.length) return null;
  return `${bodies.join(', ')} ${bodies.length === 1 ? 'has' : 'have'} deformCollision set, which a headless run does not model: its dents and holes are listed in \`dented\`, but the solver goes on colliding with the undamaged surface, so nothing falls through a hole here. Play the scene live (physics_play, then physics_get_breaks) to see the damage felt.`;
}
