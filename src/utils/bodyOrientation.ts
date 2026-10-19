import { Euler, Quaternion, Vector3 } from 'three';

/**
 * Which way a body points: one of its own axes, expressed in the world.
 *
 * Asked as "how far is the phone leaning", which used to be worked out by hand
 * from positions. The answer is the angle between the chosen local axis and
 * world up (MuJoCo's +Z), the same angle from the horizontal, and the compass
 * direction its horizontal part points in, measured from +X towards +Y.
 */
export interface Orientation {
  /** The local axis, in world coordinates (MuJoCo Z-up). */
  axisWorld: [number, number, number];
  fromVerticalDeg: number;
  fromHorizontalDeg: number;
  /** Null when the axis is vertical and has no horizontal direction. */
  headingDeg: number | null;
}

const round = (v: number, places = 2) => Math.round(v * 10 ** places) / 10 ** places;

/** `quat` is MuJoCo's [w, x, y, z]. */
export function orientationOf(quat: number[], axis: 'x' | 'y' | 'z' = 'z'): Orientation {
  const q = new Quaternion(quat[1], quat[2], quat[3], quat[0]).normalize();
  const v = new Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0).applyQuaternion(q);
  const fromVertical = (Math.acos(Math.max(-1, Math.min(1, v.z))) * 180) / Math.PI;
  const horizontal = Math.hypot(v.x, v.y);
  return {
    axisWorld: [round(v.x, 4), round(v.y, 4), round(v.z, 4)],
    fromVerticalDeg: round(fromVertical),
    fromHorizontalDeg: round(90 - fromVertical),
    headingDeg: horizontal < 1e-6 ? null : round((Math.atan2(v.y, v.x) * 180) / Math.PI),
  };
}

/**
 * A body's authored orientation as [w, x, y, z]: its `quat` if it has one,
 * else its `euler` in degrees, read as MuJoCo's default intrinsic xyz (the
 * same order three.js calls 'XYZ').
 */
export function authoredQuat(node: { quat?: number[]; euler?: number[] }): number[] {
  if (Array.isArray(node.quat) && node.quat.length === 4) return node.quat;
  if (Array.isArray(node.euler) && node.euler.length === 3) {
    const d = Math.PI / 180;
    const q = new Quaternion().setFromEuler(new Euler(node.euler[0] * d, node.euler[1] * d, node.euler[2] * d, 'XYZ'));
    return [q.w, q.x, q.y, q.z];
  }
  return [1, 0, 0, 0];
}
