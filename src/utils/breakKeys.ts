// The names of break constraints, and the layout of the limits stored with
// them. Split from breakModel.ts so the physics worker can read both without
// importing the compiler side (materials, geometry).

/**
 * What a <numeric> holds, by index. `-1` means "no limit".
 *
 * - KIND: SNAP (a weld that lets go and leaves two free pieces), LOCK (a weld
 *   holding a bend joint still; releasing it leaves the member hinged and
 *   bending against its yield), or JOIN (a blob's weld or pin).
 * - AXIS: the member's direction in body1's frame, for buckling; or, for a
 *   rod in a joint, the way into the rod, so that pulling it out can be told
 *   from pushing it in. Zero when neither applies.
 * - LATERAL: for a rod in a joint, the sideways push it survives. FORCE is
 *   then the pull out along the rod only.
 * - ALSO: 1 when breaking this one must take another with it. Unused by
 *   the compiler today; the worker honours it.
 * - TORQUE is the bending limit the weak way. For a bar, STRONG is the limit
 *   the strong way and WIDE (WX..WZ, body1's frame) the direction its wide
 *   side runs, so a bent weld is judged by which way it is bent; zero for a
 *   rod, which is as strong every way.
 */
export const BREAK_FIELDS = { KIND: 0, FORCE: 1, TORQUE: 2, COMPRESSION: 3, AX: 4, AY: 5, AZ: 6, HOLD: 7, ALSO: 8, LATERAL: 9, WX: 10, WY: 11, WZ: 12, STRONG: 13 } as const;
export const BREAK_KIND = { SNAP: 1, LOCK: 2, JOIN: 3 } as const;

/** Keys, which are also the equality names. Built from ids, so they survive rebuilds. */
export const memberKey = (nodeId: string) => `member:${nodeId}`;
export const joinKey = (blobId: string, partId: string) => `join:${blobId}>${partId}`;
export const pinKey = (blobId: string, partId: string) => `pin:${blobId}>${partId}`;

/** The two ids in a break key: the part that broke and what it was held by. */
export function parseBreakKey(key: string): { kind: 'member' | 'join' | 'pin'; nodeId: string; targetId: string } | null {
  const m = /^(member|join|pin):(.*)$/.exec(key);
  if (!m) return null;
  if (m[1] === 'member') return { kind: 'member', nodeId: m[2], targetId: m[2] };
  const at = m[2].indexOf('>');
  if (at < 0) return null;
  return { kind: m[1] as 'join' | 'pin', nodeId: m[2].slice(at + 1), targetId: m[2].slice(0, at) };
}

