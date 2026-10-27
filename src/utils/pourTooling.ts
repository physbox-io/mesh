// What a silicone pour box adds round a master is tooling, not part of it:
// the base, the sleeve, and the pin that leaves a hole through the silicone.
// They are tagged (`pourBox`); a pin from before the tag is known by its id.

import type { SceneNode } from '../types/scene';

export function isPourTooling(node: SceneNode): boolean {
  return Boolean(node.pourBox) || /^(holepin|wickpin)_/.test(node.id);
}

/** The node without any pour box tooling under it. */
export function withoutTooling(node: SceneNode): SceneNode {
  const children = node.children ?? [];
  if (!children.some((c) => isPourTooling(c) || (c.children?.length ?? 0) > 0)) return node;
  return { ...node, children: children.filter((c) => !isPourTooling(c)).map(withoutTooling) };
}
