/**
 * Where the key light's shadow camera looks, and how much of the ground it
 * covers.
 *
 * It was a fixed ±0.8 m box on the origin, with a 1.6 m shadow catcher to
 * match: right for a part on the bench, but a scene laid out wider lost its
 * shadows past it. Three levers a metre apart cast one shadow between them,
 * the one whose plank happened to sit over the origin. The box now follows
 * the scene's bounds, with the ±0.8 m as its least (so bench-scale parts keep
 * their 0.8 mm texels) and a ceiling at which a 2048 px map is still a shadow.
 */
import type { SceneBounds } from './frameScene';

/** The key light's offset from what it looks at, in three's Y-up world. */
export const KEY_LIGHT_OFFSET: [number, number, number] = [1.5, 3, 1.5];
export const MIN_SHADOW_HALF = 0.8;
export const MAX_SHADOW_HALF = 5;

export interface ShadowFrame {
  /** The ground point the light looks at, three's (x, z). */
  center: [number, number];
  /** Half the side of the shadow camera's box and of the catcher, in metres. */
  half: number;
  /** The shadow camera's far plane. */
  far: number;
}

const LIGHT_DISTANCE = Math.hypot(...KEY_LIGHT_OFFSET);
/** How far a shadow reaches sideways per metre of height, for this light. */
const SHADOW_REACH = Math.hypot(KEY_LIGHT_OFFSET[0], KEY_LIGHT_OFFSET[2]) / KEY_LIGHT_OFFSET[1];

const frameOf = (center: [number, number], half: number): ShadowFrame =>
  ({ center, half, far: LIGHT_DISTANCE + 2 * half + 1 });

/** The frame for a scene's bounds (MuJoCo Z-up, as `sceneContentBounds` gives them). */
export function shadowFrame(bounds: SceneBounds | null): ShadowFrame {
  if (!bounds) return frameOf([0, 0], MIN_SHADOW_HALF);
  const { min, max } = bounds;
  if (![...min, ...max].every(Number.isFinite)) return frameOf([0, 0], MIN_SHADOW_HALF);
  // A scene that fits in the bench box stays on it, centred on the origin as before.
  const reach = Math.max(0, max[2]) * SHADOW_REACH;
  const fits = Math.max(Math.abs(min[0]), Math.abs(max[0]), Math.abs(min[1]), Math.abs(max[1])) + reach <= MIN_SHADOW_HALF;
  if (fits) return frameOf([0, 0], MIN_SHADOW_HALF);
  // Z-up (x, y) is three's (x, -z).
  const center: [number, number] = [(min[0] + max[0]) / 2, -(min[1] + max[1]) / 2];
  const span = Math.max(max[0] - min[0], max[1] - min[1]) / 2;
  const half = Math.min(MAX_SHADOW_HALF, Math.max(MIN_SHADOW_HALF, (span + reach) * 1.1));
  // Rounded, so a body nudged a millimetre does not rebuild the shadow camera.
  const q = (v: number) => Math.round(v * 20) / 20;
  return frameOf([q(center[0]), q(center[1])], Math.ceil(half * 10) / 10);
}
