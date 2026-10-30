/**
 * Hinges and slides written without an axis.
 *
 * MuJoCo gives such a joint its default axis, the body's own Z, and says
 * nothing. A seesaw meant to swing about Y was built with no axis and never
 * moved: it was hinged about the vertical. The joint is still built that way
 * (it is a valid joint, and Z may be meant); the reply says so.
 */
import type { SceneNode } from '../types/scene';

const hasAxis = (axis: unknown): boolean =>
  Array.isArray(axis) && axis.length >= 3 && axis.slice(0, 3).every((v) => typeof v === 'number' && Number.isFinite(v)) &&
  axis.slice(0, 3).some((v) => v !== 0);

/** A warning for each hinge or slide, at any depth, that has no usable axis. */
export function jointAxisWarnings(nodes: SceneNode[]): string[] {
  const out: string[] = [];
  const walk = (list: SceneNode[] | undefined) => {
    for (const n of list || []) {
      for (const j of n.joints || []) {
        if ((j.type !== 'hinge' && j.type !== 'slide') || hasAxis(j.axis)) continue;
        const what = j.type === 'hinge' ? 'turns about' : 'slides along';
        out.push(
          `Joint '${j.name}' on '${n.name || n.id}' is a ${j.type} with no axis${j.axis !== undefined ? ' it can use' : ''}, so it ${what} ` +
          `the body's own Z (MuJoCo's default). If it should ${j.type === 'hinge' ? 'turn' : 'slide'} another way, give axis: [x, y, z], ` +
          `e.g. [0, 1, 0] for a seesaw across Y.`,
        );
      }
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}
