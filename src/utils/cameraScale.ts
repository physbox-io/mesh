/**
 * How many metres one screen pixel covers, for either kind of camera.
 *
 * Most of the viewport's pixel-sized things (snap bands, lattice dots, measure
 * markers) were worked out from the perspective camera's field of view and the
 * distance to the point. The Top, Front and Side views are orthographic, where
 * there is no field of view and distance changes nothing: the scale is the
 * frustum's height over its zoom. Reading `fov` off an orthographic camera
 * gives undefined, and a NaN band snaps nothing — hence one helper for both.
 */
import * as THREE from 'three';

export function metresPerPixel(camera: THREE.Camera, distance: number, canvasHeight: number): number {
  if (!(canvasHeight > 0)) return 0;
  const ortho = camera as THREE.OrthographicCamera;
  if (ortho.isOrthographicCamera) return (ortho.top - ortho.bottom) / (ortho.zoom * canvasHeight);
  const fov = (camera as THREE.PerspectiveCamera).fov ?? 50;
  if (!Number.isFinite(distance)) return 0;
  return (2 * Math.abs(distance) * Math.tan((fov * Math.PI) / 360)) / canvasHeight;
}
