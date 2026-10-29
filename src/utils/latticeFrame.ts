/**
 * Where a lattice body's cage sits relative to the body.
 *
 * ONE rule, everywhere: a lattice body's frame has its origin at the shape's
 * centre of mass (the mesh is recentred there, see latticeMesh.toSceneGeom,
 * because MuJoCo recentres every mesh asset on its mass and the renderer draws
 * the vertices at the body's transform). The CAGE has its own fixed frame, in
 * which every lattice tool's coordinates are given, and a cage point `c` is at
 * body-frame point `c * unit - latticeOrigin`. So:
 *
 * - the cage frame's origin is at body-frame `-latticeOrigin`, and that is the
 *   point a caller's `pos` names when it creates a lattice body;
 * - an edit that moves the centre of mass moves `pos` by the change, so the
 *   cage stays put in the world (store `applyLattice`);
 * - everything else hung on the body (other geoms, joint anchors, child
 *   bodies) is walked back by the same change, so it stays where it was put on
 *   the shape.
 *
 * Before this, creating a body with `ops` left `pos` on the requested point
 * while the mesh moved to its centre of mass — an arm extruded 140 mm out from
 * a 20 mm cube was drawn and simulated 70 mm inboard of its cage, and a union
 * of such bodies baked the error into the merged cage.
 */
import * as THREE from 'three';
import type { SceneNode } from '../types/scene';
import { authoredQuat } from './bodyOrientation';

type Vec3 = [number, number, number];

/** `v`, in the body's own axes, turned into its parent's. */
export function rotateByBody(node: { quat?: number[]; euler?: number[] }, v: number[]): Vec3 {
  const q = authoredQuat(node);
  const out = new THREE.Vector3(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0)
    .applyQuaternion(new THREE.Quaternion(q[1] || 0, q[2] || 0, q[3] || 0, q[0] ?? 1).normalize());
  return [out.x, out.y, out.z];
}

/**
 * The `pos` that puts a new lattice body's CAGE origin at `cageAt`: the mesh
 * is centred `origin` metres from the cage origin, so the body goes there.
 */
export function latticeBodyPos(
  cageAt: number[],
  origin: number[] | undefined,
  orientation: { quat?: number[]; euler?: number[] } = {},
): Vec3 {
  const o = rotateByBody(orientation, origin ?? [0, 0, 0]);
  return [(cageAt[0] ?? 0) + o[0], (cageAt[1] ?? 0) + o[1], (cageAt[2] ?? 0) + o[2]];
}

/** Where the cage origin is in the body frame: the negated `latticeOrigin`, in mm. */
export function cageOriginInBodyMm(node: Pick<SceneNode, 'latticeOrigin'>): Vec3 {
  const o = node.latticeOrigin ?? [0, 0, 0];
  const mm = (v: number | undefined) => Math.round(-(v ?? 0) * 1e6) / 1e3 + 0;
  return [mm(o[0]), mm(o[1]), mm(o[2])];
}

/**
 * Joint anchors and child bodies walked back by `local` (body frame, metres)
 * when the body's origin has moved by `local` relative to its shape. Geoms are
 * walked by the caller, which knows which of them is the cage's own. Mutates
 * `node`.
 */
export function keepJointsAndChildrenOnShape(node: SceneNode, local: number[]): void {
  const [dx, dy, dz] = [local[0] ?? 0, local[1] ?? 0, local[2] ?? 0];
  if (dx === 0 && dy === 0 && dz === 0) return;
  for (const joint of node.joints ?? []) {
    // A free joint has no anchor; anything else pivots at `pos` (default the
    // body origin, which is exactly the point that just moved).
    if (joint.type === 'free') continue;
    const at = joint.pos ?? [0, 0, 0];
    joint.pos = [(at[0] ?? 0) - dx, (at[1] ?? 0) - dy, (at[2] ?? 0) - dz];
  }
  for (const child of node.children ?? []) {
    const at = child.pos ?? [0, 0, 0];
    child.pos = [(at[0] ?? 0) - dx, (at[1] ?? 0) - dy, (at[2] ?? 0) - dz];
    if (child.basePos) child.basePos = [...child.pos];
  }
}
