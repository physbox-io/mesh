// ---------------------------------------------------------------------------
// Mold pull direction
// ---------------------------------------------------------------------------
//
// A printed mold pulls off along one axis, and everything the part hides from
// that axis -- the face of a bust standing upright, the underside of a chin --
// is filled in solid. Which axis that is matters far more than any other mold
// setting, so it is not left to how the part happens to sit in the scene: every
// axis is tried and the one that fills in the least of the part wins.
//
// "Fills in" is measured, not guessed. A column through the part casts as one
// solid run from its lowest to its highest surface (and on to the parting plane
// if it does not reach it); the part itself only occupies its spans. The
// difference, summed over the grid, is the volume the mold adds to the casting.
// ---------------------------------------------------------------------------

import { sampleColumns, choosePartingZ, type Grid } from './moldColumns';

export type PullDirection = '+z' | '-z' | '+y' | '-y' | '+x' | '-x';

export interface PullCandidate {
  direction: PullDirection;
  /** Volume the mold fills in that the part does not have, as a share of the part's volume. */
  lostFraction: number;
}

export interface PullChoice {
  direction: PullDirection;
  lostFraction: number;
  /** The part's own orientation, for comparison. */
  asPlacedLostFraction: number;
  candidates: PullCandidate[];
}

/**
 * Turns a point so that `direction` points up (+Z). Every turn is a proper
 * rotation, so triangle winding -- which the column sampler reads to tell
 * entering from leaving -- survives it.
 */
export function rotateForPull(direction: PullDirection, x: number, y: number, z: number): [number, number, number] {
  switch (direction) {
    case '+z': return [x, y, z];
    case '-z': return [x, -y, -z];
    case '+y': return [x, -z, y];
    case '-y': return [x, z, -y];
    case '+x': return [-z, y, x];
    case '-x': return [z, y, -x];
  }
}

/** The inverse of rotateForPull: takes a point in the mold's frame back to the part's. */
export function unrotateFromPull(direction: PullDirection, x: number, y: number, z: number): [number, number, number] {
  switch (direction) {
    case '+z': return [x, y, z];
    case '-z': return [x, -y, -z];
    case '+y': return [x, z, -y];
    case '-y': return [x, -z, y];
    case '+x': return [z, y, -x];
    case '-x': return [-z, y, x];
  }
}

/** Rotates a flat triangle soup (x, y, z, ...) into the frame where `direction` is up. */
export function rotateTrianglesForPull(tris: ArrayLike<number>, direction: PullDirection): Float64Array {
  const out = new Float64Array(tris.length);
  for (let i = 0; i < tris.length; i += 3) {
    const [x, y, z] = rotateForPull(direction, tris[i], tris[i + 1], tris[i + 2]);
    out[i] = x;
    out[i + 1] = y;
    out[i + 2] = z;
  }
  return out;
}

/**
 * How much of the part a mold pulling along +Z fills in, for a part already
 * turned into that frame. `open` molds part at whichever extreme has the bigger
 * footprint, as the exporter does; clamshells part where the exporter would.
 */
export function measurePullLoss(tris: Float64Array, open: boolean, targetCells = 80): number {
  const triCount = Math.floor(tris.length / 9);
  if (triCount === 0) return 0;

  let mnX = Infinity, mxX = -Infinity, mnY = Infinity, mxY = -Infinity, mnZ = Infinity, mxZ = -Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i], y = tris[i + 1], z = tris[i + 2];
    if (x < mnX) mnX = x;
    if (x > mxX) mxX = x;
    if (y < mnY) mnY = y;
    if (y > mxY) mxY = y;
    if (z < mnZ) mnZ = z;
    if (z > mxZ) mxZ = z;
  }
  const cx = (mnX + mxX) / 2, cy = (mnY + mxY) / 2, cz = (mnZ + mxZ) / 2;
  const centred = new Float64Array(tris.length);
  for (let i = 0; i < tris.length; i += 3) {
    centred[i] = tris[i] - cx;
    centred[i + 1] = tris[i + 1] - cy;
    centred[i + 2] = tris[i + 2] - cz;
  }

  const halfW = (mxX - mnX) / 2 || 1;
  const halfD = (mxY - mnY) / 2 || 1;
  const zMax = (mxZ - mnZ) / 2;
  const zMin = -zMax;
  const step = Math.max(halfW, halfD) * 2 / targetCells;
  const cols = Math.max(8, Math.round((2 * halfW) / step) + 1);
  const rows = Math.max(8, Math.round((2 * halfD) / step) + 1);
  const grid: Grid = {
    cols,
    rows,
    stepX: (2 * halfW) / (cols - 1),
    stepY: (2 * halfD) / (rows - 1),
    halfW,
    halfD,
  };
  const field = sampleColumns(centred, triCount, grid, halfW, halfD);

  let partingZ: number;
  if (open) {
    const zEps = Math.max(1e-6, (zMax - zMin) * 1e-4);
    let covBottom = 0;
    let covTop = 0;
    for (let i = 0; i < field.hit.length; i++) {
      if (!field.hit[i]) continue;
      if (field.minZ[i] <= zMin + zEps) covBottom++;
      if (field.maxZ[i] >= zMax - zEps) covTop++;
    }
    partingZ = covTop > covBottom ? zMax : zMin;
  } else {
    partingZ = choosePartingZ(field, zMin, zMax);
  }

  let partLen = 0;
  let castLen = 0;
  for (let i = 0; i < field.hit.length; i++) {
    if (!field.hit[i]) continue;
    const s = field.spans[i];
    for (let k = 0; k + 1 < s.length; k += 2) partLen += s[k + 1] - s[k];
    castLen += Math.max(field.maxZ[i], partingZ) - Math.min(field.minZ[i], partingZ);
  }
  if (!(partLen > 0)) return 0;
  return Math.max(0, castLen - partLen) / partLen;
}

/**
 * Picks the axis to pull the mold along. An open mold has one face to pour
 * through, so both ends of each axis are tried; a clamshell opens both ways at
 * once, so each axis is tried once. The part keeps its own orientation unless
 * another loses clearly less of it -- a fifth less, and half a percent of its
 * volume -- so a part that molds fine as placed is not turned for nothing.
 */
export function choosePullDirection(tris: ArrayLike<number>, open: boolean): PullChoice {
  const directions: PullDirection[] = open ? ['+z', '-z', '+y', '-y', '+x', '-x'] : ['+z', '+y', '+x'];
  const candidates: PullCandidate[] = directions.map((direction) => ({
    direction,
    lostFraction: measurePullLoss(rotateTrianglesForPull(tris, direction), open),
  }));

  // An open mold's own search already picks the better end of Z, so "as
  // placed" is whichever end of Z is better, not +Z alone.
  const asPlaced = candidates
    .filter((c) => c.direction === '+z' || c.direction === '-z')
    .reduce((a, b) => (b.lostFraction < a.lostFraction ? b : a));

  let best = asPlaced;
  for (const c of candidates) {
    if (c.lostFraction < best.lostFraction) best = c;
  }
  const clearlyBetter =
    best.lostFraction < asPlaced.lostFraction * 0.8 && asPlaced.lostFraction - best.lostFraction > 0.005;
  const chosen = clearlyBetter ? best : asPlaced;

  return {
    direction: chosen.direction,
    lostFraction: chosen.lostFraction,
    asPlacedLostFraction: asPlaced.lostFraction,
    candidates,
  };
}
