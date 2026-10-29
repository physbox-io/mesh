/**
 * The live state a pose edit has to be written into as well as the document.
 *
 * A free joint's position and orientation ARE its qpos, and a rebuild carries
 * qpos across (the simulation keeps going where it was), so an edit to a free
 * body's `pos` or `euler` reached the model's qpos0 but not the body: the
 * viewport kept the old pose until Reset. The editor's own position fields and
 * gizmos write the joint as well as the document; MCP edits do the same now.
 */
import type { SceneNode } from '../types/scene';
import { authoredQuat } from './bodyOrientation';

/**
 * The free joint of a top-level body and the qpos its authored pose means,
 * `[x, y, z, qw, qx, qy, qz]` — or null for a body whose pose is not in qpos
 * (no free joint, or nested: MuJoCo only allows a free joint at the top).
 */
export function freeJointPose(node: SceneNode | null | undefined, topLevel: boolean): { joint: string; qpos: number[] } | null {
  if (!node || !topLevel) return null;
  const free = (node.joints ?? []).find((j) => j.type === 'free');
  if (!free?.name) return null;
  const p = node.pos ?? [0, 0, 0];
  const q = authoredQuat(node);
  const n = Math.hypot(q[0] ?? 1, q[1] ?? 0, q[2] ?? 0, q[3] ?? 0) || 1;
  return {
    joint: free.name,
    qpos: [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, (q[0] ?? 1) / n, (q[1] ?? 0) / n, (q[2] ?? 0) / n, (q[3] ?? 0) / n],
  };
}

/** Whether an update touches a body's pose. */
export const touchesPose = (updates: Record<string, unknown>): boolean =>
  updates.pos !== undefined || updates.euler !== undefined || updates.quat !== undefined;
