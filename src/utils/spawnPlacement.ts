// ---------------------------------------------------------------------------
// Where a new body goes
//
// A part added from the palette used to appear 150 mm up at the world origin,
// wherever the view was: a 100 mm box hung with its underside 100 mm off the
// floor, half out of a 160 mm view, and fell when the sim ran. Now it stands
// on the floor at the point asked for (the middle of the view, or where it was
// dropped), and steps aside along X until it is clear of the bodies already
// there, so it is neither inside another part nor thrown out of one.
//
// PURE.
// ---------------------------------------------------------------------------

import type { SceneNode } from '../types/scene';
import { sceneContentBounds } from './frameScene';

/** Room left between a new body and its neighbour, in metres. */
const GAP = 0.01;

type Box = { min: number[]; max: number[] };

/** A body's own extent, about its origin. */
export function ownBounds(node: SceneNode): Box | null {
  return sceneContentBounds([{ ...node, pos: [0, 0, 0], children: [] }]);
}

const overlaps = (a: Box, b: Box) =>
  a.min[0] < b.max[0] && a.max[0] > b.min[0] && a.min[1] < b.max[1] && a.max[1] > b.min[1];

/** Footprints of the bodies in `others` that stand above the floor. */
function footprints(others: SceneNode[]): Box[] {
  return others
    .map((n) => sceneContentBounds([n]))
    .filter((b): b is NonNullable<typeof b> => !!b && b.max[2] > 0);
}

/**
 * How far along +X a footprint (x and y extents) has to move to be clear of
 * every body in `others`. Each overlap moves it just past that body, and it
 * only ever moves one way, so this ends in at most one step per body.
 */
export function clearAlongX(box: Box, others: SceneNode[]): number {
  const taken = footprints(others);
  let dx = 0;
  for (let i = 0; i <= taken.length; i++) {
    const here = { min: [box.min[0] + dx, box.min[1]], max: [box.max[0] + dx, box.max[1]] };
    const hit = taken.find((b) => overlaps(here, b));
    if (!hit) break;
    dx = hit.max[0] + GAP - box.min[0];
  }
  return dx;
}

/**
 * The position for `node` that stands it on the floor at `at` (x and y), moved
 * along +X past whichever of `others` it would overlap.
 */
export function restingPos(node: SceneNode, others: SceneNode[], at: number[]): number[] {
  const own = ownBounds(node);
  if (!own) return [at[0], at[1], 0];
  const box = { min: [at[0] + own.min[0], at[1] + own.min[1]], max: [at[0] + own.max[0], at[1] + own.max[1]] };
  return [at[0] + clearAlongX(box, others), at[1], -own.min[2]];
}

/** How far beside `parent` a part added under it goes, along X: past its edge, plus a gap. */
export function besideOffset(parent: SceneNode, node: SceneNode): number {
  const p = ownBounds(parent);
  const own = ownBounds(node);
  return (p ? p.max[0] : 0.05) + GAP - (own ? own.min[0] : -0.05);
}

/** How far below `parent` a part that hangs from it goes, along Z: under its underside, plus a gap. */
export function belowOffset(parent: SceneNode, node: SceneNode): number {
  const p = ownBounds(parent);
  const own = ownBounds(node);
  return (p ? p.min[2] : -0.05) - GAP - (own ? own.max[2] : 0.05);
}
