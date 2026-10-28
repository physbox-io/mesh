// ---------------------------------------------------------------------------
// The scene the app opens on, and how a scene is framed when it arrives
// ---------------------------------------------------------------------------

import type { SceneGraph } from '../types/scene';
import type { SnapMultiple } from '../utils/latticeMesh';
import type { CameraView } from '../utils/cameraViews';
import { pendulumPreset, emptyPreset } from '../presets/presetScenes';
import { framingForBounds, gridCellForBounds, sceneContentBounds } from '../utils/frameScene';
import type { PhysicsState } from './useStore';

/**
 * The pendulum greets a first visit; every load after that opens blank. The
 * cookie is set on the first one, so a refresh never brings the pendulum back.
 */
const SEEN_COOKIE = 'mesh_seen';

const isFirstVisit = (() => {
  if (typeof document === 'undefined') return true; // tests: keep the pendulum they were written against
  try {
    if (document.cookie.split('; ').some((c) => c.startsWith(`${SEEN_COOKIE}=`))) return false;
    document.cookie = `${SEEN_COOKIE}=1; max-age=${60 * 60 * 24 * 365 * 5}; path=/; SameSite=Lax`;
    return true;
  } catch {
    return false;
  }
})();

export const initialPreset = isFirstVisit ? 'pendulum' : 'empty';
export const initialScene: SceneGraph = isFirstVisit ? pendulumPreset : emptyPreset;

/**
 * How a freshly loaded scene is framed, and how big the graph paper under it
 * is drawn.
 *
 * Both are worked out from the scene's own bounds rather than fixed: the
 * viewport's default pose is 0.8 m out over a 100 mm grid, which suits a
 * bench-scale rig and makes anything at the size people actually cut here —
 * tens of millimetres up to about 250 mm — read as a speck on a floor tile.
 * A preset that states its own camera keeps it; the grid still follows the
 * scene. Returns a patch to `set`, so the caller can apply it in one breath
 * with whatever else it is doing.
 *
 * `gridCellSizeMm` is set directly rather than through `setGridCellSizeMm`
 * because that setter also moves the lattice snap, and loading a scene is no
 * reason to change the increment someone is modelling in.
 */
export function framingPatch(
  scene: SceneGraph,
  explicit: { position: [number, number, number]; target: [number, number, number] } | null
): { cameraOverride: PhysicsState['cameraOverride']; gridCellSizeMm: number; cameraView?: CameraView } {
  const bounds = sceneContentBounds(scene.nodes);
  const cameraOverride = explicit ?? (bounds ? framingForBounds(bounds) : null);
  return {
    cameraOverride,
    gridCellSizeMm: gridCellForBounds(bounds),
    // A pose with an eye position is a perspective pose; see setCameraOverride.
    ...(cameraOverride ? { cameraView: 'perspective' as const } : {}),
  };
}

/**
 * The pendulum is what a first visit opens on, and it is 600mm of stand — taller
 * than the 250mm window the default pose shows. Framed here rather than on load,
 * because nothing loads it: it is the store's initial scene.
 */
export const initialFraming = framingPatch(initialScene, null);

/** The lattice snap (in 0.1 mm grid steps) that matches a grid drawn at `mm`. */
export function snapForGridMm(mm: number): SnapMultiple {
  return (Math.round(mm * 10) || 10) as SnapMultiple;
}
