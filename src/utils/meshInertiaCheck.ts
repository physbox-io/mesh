/**
 * Whether MuJoCo can integrate a closed mesh's inertia exactly.
 *
 * `inertia="exact"` (see mjcf.ts) sums signed tetrahedra over the surface. On a
 * mesh that is closed and consistently wound but passes through itself (a
 * sculpt stroke that folded the top of a ball down through its bottom) part of
 * the volume counts negative, and the inertia that comes out need not be
 * positive definite. MuJoCo then refuses the whole scene: "eigenvalue of mesh
 * inertia must be positive". The same integral is done here first, so such a
 * mesh can be weighed by its hull instead and the sculpt reply can say so.
 *
 * Per unit density, about the centre of mass, in the units of the positions.
 */

export interface InertiaCheck {
  volume: number;
  /** Principal moments, ascending. */
  principal: [number, number, number];
  /** Positive volume and a positive-definite inertia, with some margin. */
  ok: boolean;
}

/** Below this share of the largest principal moment, a moment counts as not positive. */
const MIN_MOMENT_RATIO = 1e-6;

export function checkMeshInertia(positions: ArrayLike<number>, faces: ArrayLike<number>, faceCount = Math.floor(faces.length / 3)): InertiaCheck {
  let vol6 = 0;
  let cx = 0, cy = 0, cz = 0;
  // Second moments about the origin: xx, yy, zz, xy, xz, yz (times 120).
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (let f = 0; f < faceCount; f++) {
    const a = faces[f * 3] * 3, b = faces[f * 3 + 1] * 3, c = faces[f * 3 + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const qx = positions[c], qy = positions[c + 1], qz = positions[c + 2];
    const det = ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx);
    vol6 += det;
    const sx = ax + bx + qx, sy = ay + by + qy, sz = az + bz + qz;
    cx += det * sx; cy += det * sy; cz += det * sz;
    // Tetrahedron (0, a, b, c): covariance = det/120 * (sum v v^T + s s^T).
    xx += det * (ax * ax + bx * bx + qx * qx + sx * sx);
    yy += det * (ay * ay + by * by + qy * qy + sy * sy);
    zz += det * (az * az + bz * bz + qz * qz + sz * sz);
    xy += det * (ax * ay + bx * by + qx * qy + sx * sy);
    xz += det * (ax * az + bx * bz + qx * qz + sx * sz);
    yz += det * (ay * az + by * bz + qy * qz + sy * sz);
  }
  const volume = vol6 / 6;
  if (!(volume > 0) || !Number.isFinite(volume)) return { volume, principal: [0, 0, 0], ok: false };

  const mx = cx / (24 * volume), my = cy / (24 * volume), mz = cz / (24 * volume);
  // About the centre of mass.
  const Cxx = xx / 120 - volume * mx * mx;
  const Cyy = yy / 120 - volume * my * my;
  const Czz = zz / 120 - volume * mz * mz;
  const Cxy = xy / 120 - volume * mx * my;
  const Cxz = xz / 120 - volume * mx * mz;
  const Cyz = yz / 120 - volume * my * mz;
  const tr = Cxx + Cyy + Czz;
  // Inertia = trace(C) I - C.
  const principal = symmetricEigenvalues(tr - Cxx, tr - Cyy, tr - Czz, -Cxy, -Cxz, -Cyz);
  const largest = Math.max(Math.abs(principal[2]), 1e-300);
  const ok = principal[0] > largest * MIN_MOMENT_RATIO && Number.isFinite(principal[0]);
  return { volume, principal, ok };
}

/** Eigenvalues of the symmetric matrix [[a, d, e], [d, b, f], [e, f, c]], ascending. */
export function symmetricEigenvalues(a: number, b: number, c: number, d: number, e: number, f: number): [number, number, number] {
  const p1 = d * d + e * e + f * f;
  if (p1 === 0) {
    const s = [a, b, c].sort((x, y) => x - y);
    return [s[0], s[1], s[2]];
  }
  const q = (a + b + c) / 3;
  const p2 = (a - q) ** 2 + (b - q) ** 2 + (c - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  const B = [(a - q) / p, d / p, e / p, d / p, (b - q) / p, f / p, e / p, f / p, (c - q) / p];
  const detB = B[0] * (B[4] * B[8] - B[5] * B[7]) - B[1] * (B[3] * B[8] - B[5] * B[6]) + B[2] * (B[3] * B[7] - B[4] * B[6]);
  const r = Math.max(-1, Math.min(1, detB / 2));
  const phi = Math.acos(r) / 3;
  const e1 = q + 2 * p * Math.cos(phi);
  const e3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  const e2 = 3 * q - e1 - e3;
  return [e3, e2, e1];
}
