// A body's velocity as telemetry and the scripts report it.
//
// MuJoCo's `cvel` is not "the body's velocity". It is a spatial velocity
// [ω; v] in the world frame whose linear part is the velocity of the point
// `subtree_com[body_rootid[b]]`: the centre of mass of the whole tree the body
// hangs from. Read as the body's own, a hinged wheel on a cart reported the
// cart's COM velocity plus nothing (0.539, 0, 0.872 m/s on a cart doing
// 0.436), and even a lone free body reported its COM's velocity, not that of
// the point `pos` gives. The old correction added ω × (xpos − parent xpos),
// which assumed the linear part sat at the parent's origin.
//
// Here the linear part is moved to the point asked for (the body's origin,
// `xpos`, unless said otherwise), as mj_objectVelocity does, with no wasm-heap
// out-buffer to allocate and free. ω is the same at every point: the body's
// angular velocity in the WORLD frame.
//
// Plain functions over typed views, so tests drive them against real MuJoCo.

/** The views a velocity is read from, taken once per frame (each `data.x` read is an embind getter). */
export interface VelocityViews {
  cvel: ArrayLike<number>;
  xpos: ArrayLike<number>;
  subtreeCom: ArrayLike<number>;
  /** model.body_rootid */
  rootId: ArrayLike<number>;
}

/** World-frame linear velocity of `point` (default: body `b`'s origin, xpos), m/s. */
export function bodyPointVelocity(v: VelocityViews, b: number, point?: ArrayLike<number>): [number, number, number] {
  const o = b * 6;
  const wx = v.cvel[o], wy = v.cvel[o + 1], wz = v.cvel[o + 2];
  const r = v.rootId[b] * 3;
  const px = point ? point[0] : v.xpos[b * 3];
  const py = point ? point[1] : v.xpos[b * 3 + 1];
  const pz = point ? point[2] : v.xpos[b * 3 + 2];
  const rx = px - v.subtreeCom[r], ry = py - v.subtreeCom[r + 1], rz = pz - v.subtreeCom[r + 2];
  return [
    v.cvel[o + 3] + (wy * rz - wz * ry),
    v.cvel[o + 4] + (wz * rx - wx * rz),
    v.cvel[o + 5] + (wx * ry - wy * rx),
  ];
}

/** World-frame angular velocity of body `b`, rad/s. */
export function bodyAngularVelocity(v: VelocityViews, b: number): [number, number, number] {
  return [v.cvel[b * 6], v.cvel[b * 6 + 1], v.cvel[b * 6 + 2]];
}

/** World ω into body `b`'s frame (R^T ω, xmat row-major): what a free joint's qvel[3..5] holds. */
export function worldToBodyFrame(xmat: ArrayLike<number>, b: number, w: ArrayLike<number>): [number, number, number] {
  const m = b * 9;
  return [
    xmat[m] * w[0] + xmat[m + 3] * w[1] + xmat[m + 6] * w[2],
    xmat[m + 1] * w[0] + xmat[m + 4] * w[1] + xmat[m + 7] * w[2],
    xmat[m + 2] * w[0] + xmat[m + 5] * w[1] + xmat[m + 8] * w[2],
  ];
}
