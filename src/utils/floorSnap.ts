// ---------------------------------------------------------------------------
// Settling a body onto the floor
// ---------------------------------------------------------------------------
//
// Dragging the gizmo's Z arrow, the value nearly everyone is after is "resting
// on the ground" — and it is the one value a freehand drag almost never hits.
// You land a millimetre high and the body drops when the sim starts, or a
// millimetre low and it is buried in the floor and jumps out.
//
// So the drag is pulled toward the height where the body's lowest point touches
// z = 0, and only near it: far away nothing happens, and pushing past the band
// lets go cleanly. The pull is a smooth ramp rather than a jump to the value,
// because a handle that teleports under the pointer reads as a bug, and it has
// a deadzone at the middle so the snap actually *lands* instead of asymptoting
// toward the floor forever.
//
// The threshold is chosen in pixels by the caller and converted to metres here,
// so the snap feels the same at any zoom — the same reasoning as MeasureTool's
// `SNAP_PIXELS`. Pure functions, no three.js and no store, so the shape of the
// curve can be tested rather than eyeballed.
//
// `snapEase` is that curve on its own. The floor is only the first thing worth
// snapping to; `mateSnap.ts` pulls a body onto another body's corners, holes
// and faces, and it must feel like the SAME pull rather than a second one with
// its own timing. Sharing the function is what guarantees that — a copy would
// drift the first time either was tuned.

/** How much of the band, at the middle, snaps exactly rather than easing. */
const DEADZONE_FRACTION = 0.35;

/** How hard a snap is pulling, at some distance from the thing it pulls toward. */
export interface Ease {
  /**
   * The fraction of the raw distance that SURVIVES: 0 at the lock, 1 at the
   * band edge. Written this way round — as a fraction of the distance rather
   * than of the band — because that is what guarantees the two properties the
   * curve has to have: it meets the lock at zero and untouched motion at the
   * threshold with no step at either join, and it can only ever pull toward the
   * target, never push past the pointer on the way out.
   */
  factor: number;
  /** 1 at the lock, 0 at the band edge — what a hint's opacity is drawn from. */
  strength: number;
  /** True inside the deadzone, where the snap lands exactly. */
  locked: boolean;
}

/**
 * The pull curve, at a distance `dist` from the thing being snapped to.
 *
 * A `threshold` of zero or less turns the snap off, which is what a caller
 * passes while a modifier is held.
 */
export function snapEase(dist: number, threshold: number): Ease {
  if (!Number.isFinite(dist) || !(threshold > 0)) return { factor: 1, strength: 0, locked: false };
  const away = Math.abs(dist);
  if (away >= threshold) return { factor: 1, strength: 0, locked: false };

  const inner = DEADZONE_FRACTION * threshold;
  if (away <= inner) return { factor: 0, strength: 1, locked: true };

  // `t` runs 0 at the deadzone edge to 1 at the band edge; smoothstep of it is
  // the fraction of the distance left alone.
  const t = (away - inner) / (threshold - inner);
  const eased = t * t * (3 - 2 * t);
  return { factor: eased, strength: 1 - eased, locked: false };
}

export interface FloorSnap {
  /** Where the drag should actually put the body. */
  z: number;
  /** 0 outside the band, 1 locked to the floor — drives the hint's opacity. */
  strength: number;
  /** True while `z` is exactly `groundZ`. */
  locked: boolean;
}

/**
 * Pulls a dragged Z toward the height at which the body sits on the floor.
 *
 * `z` and `groundZ` are in the same units (metres, MuJoCo world). `groundZ` is
 * the value of `z` that puts the body's lowest point at the ground plane, which
 * is not zero for anything whose origin is not its base — a mesh whose position
 * is its centroid, most obviously.
 *
 * A `threshold` of zero or less turns the snap off, which is what the caller
 * passes while a modifier is held.
 */
export function snapToFloor({ z, groundZ, threshold }: {
  z: number;
  groundZ: number;
  threshold: number;
}): FloorSnap {
  if (!Number.isFinite(z) || !Number.isFinite(groundZ) || !(threshold > 0)) {
    return { z, strength: 0, locked: false };
  }

  const d = z - groundZ;
  const ease = snapEase(d, threshold);
  if (ease.locked) return { z: groundZ, strength: 1, locked: true };
  if (ease.strength === 0) return { z, strength: 0, locked: false };
  return {
    z: groundZ + d * ease.factor,
    strength: ease.strength,
    locked: false,
  };
}

/**
 * How many world metres one screen pixel covers at a given distance.
 *
 * Used to state the snap threshold in pixels so it is the same size on screen
 * however far out the camera is. An orthographic camera has no such falloff —
 * pass its own constant instead of calling this.
 */
export function worldPerPixel(fovDegrees: number, distance: number, canvasHeight: number): number {
  if (!(canvasHeight > 0) || !Number.isFinite(distance)) return 0;
  const visibleHeight = 2 * Math.abs(distance) * Math.tan((fovDegrees * Math.PI) / 360);
  return visibleHeight / canvasHeight;
}

/**
 * The snap threshold for a drag, in metres.
 *
 * Clamped at both ends: on a scene a few metres across, fourteen pixels is a
 * sane pull, but zoomed far out it would be a snap zone wider than the part,
 * and pressed right up against a body it would be too small to ever feel.
 */
export const SNAP_PIXELS = 14;
export const MIN_SNAP_M = 0.0002;
export const MAX_SNAP_M = 0.02;

export function snapThreshold(fovDegrees: number, distance: number, canvasHeight: number): number {
  const raw = worldPerPixel(fovDegrees, distance, canvasHeight) * SNAP_PIXELS;
  if (!(raw > 0)) return MIN_SNAP_M;
  return Math.min(MAX_SNAP_M, Math.max(MIN_SNAP_M, raw));
}
