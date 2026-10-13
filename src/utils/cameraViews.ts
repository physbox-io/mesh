/**
 * The viewport's camera presets, and the three that are drawing views.
 *
 * Top Down, Front and Side are orthographic: a drawing sheet's projection, in
 * which a part's near and far edges land on the same line, so a dimension
 * drawn on the screen means the same thing at every depth. Perspective is the
 * free view everything else opens in.
 *
 * All directions here are in the document frame (MuJoCo, Z-up, metres). The
 * viewport converts with (x, y, z) → (x, z, −y), as everywhere else.
 *
 *   Front looks along +Y, from the −Y side the default view already sits on.
 *   Side is the right-hand view, from +X, the same side as the default eye.
 *   Top looks down −Z with +Y up the screen, as Top Down always has.
 *
 * No store and no camera object, so the framing can be tested.
 */
import { DEFAULT_VIEW_EXTENT } from './frameScene';

export type CameraView = 'perspective' | 'topDown' | 'front' | 'side';
export type DrawingView = Exclude<CameraView, 'perspective'>;

type Vec3 = [number, number, number];

export interface ViewAxes {
  /** The direction the camera looks. */
  forward: Vec3;
  /** Screen right. */
  right: Vec3;
  /** Screen up. */
  up: Vec3;
}

export const VIEW_AXES: Record<DrawingView, ViewAxes> = {
  topDown: { forward: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0] },
  front: { forward: [0, 1, 0], right: [1, 0, 0], up: [0, 0, 1] },
  side: { forward: [-1, 0, 0], right: [0, 1, 0], up: [0, 0, 1] },
};

/**
 * Within 1° of a drawing view's axis, the camera is still in that view: its
 * button shows as chosen and the Dims draw. Past it, it has been orbited off.
 */
export const SQUARE_TO_VIEW = Math.cos((1 * Math.PI) / 180);

export const CAMERA_VIEWS: readonly CameraView[] = ['perspective', 'topDown', 'front', 'side'];

export function isDrawingView(view: CameraView): view is DrawingView {
  return view !== 'perspective';
}

/**
 * How far behind the target an orthographic camera sits. Distance changes
 * nothing about an orthographic picture; it only has to clear the scene so
 * the near plane never cuts into it.
 */
export const ORTHO_STANDOFF = 2;

/**
 * Air around the content in a drawing view: a little more than the
 * perspective framing's, because the dimension rows are drawn outside the part.
 */
const ORTHO_MARGIN = 1.6;

export interface OrthoFraming {
  /** The point looked at, document frame. */
  target: Vec3;
  /** Metres of world shown top to bottom. */
  height: number;
}

/**
 * Where an orthographic view looks and how much it shows: the content's centre,
 * at the same 160 mm default scale as the perspective view, backing off only for
 * content too big for it — the same rule as framingForBounds.
 */
export function orthoFraming(
  bounds: { min: number[]; max: number[] } | null,
  view: DrawingView,
  aspect = 1,
): OrthoFraming {
  if (!bounds) return { target: [0, 0, 0], height: DEFAULT_VIEW_EXTENT };
  const { right, up } = VIEW_AXES[view];
  const span = (axis: Vec3) =>
    Math.abs(axis[0]) * (bounds.max[0] - bounds.min[0]) +
    Math.abs(axis[1]) * (bounds.max[1] - bounds.min[1]) +
    Math.abs(axis[2]) * (bounds.max[2] - bounds.min[2]);
  const fit = Math.max(span(up), span(right) / Math.max(0.0001, aspect)) * ORTHO_MARGIN;
  return {
    target: [0, 1, 2].map((a) => (bounds.min[a] + bounds.max[a]) / 2) as Vec3,
    height: Math.max(DEFAULT_VIEW_EXTENT, fit),
  };
}
