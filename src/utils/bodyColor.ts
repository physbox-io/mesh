import * as THREE from 'three';

/**
 * A body's colour as three should draw it.
 *
 * A geom's rgba is a display colour — what a colour picker or a CSS hex gives,
 * and what the 3MF export writes out. `new THREE.Color(r, g, b)` reads its
 * arguments as linear instead, so the renderer's sRGB encode lifted every
 * channel a second time: red [0.9, 0.25, 0.35] came out pink, a 0.8 grey near
 * white, and the whole viewport looked washed out.
 */
export function bodyColor(
  rgb: ArrayLike<number> | undefined,
  fallback: readonly number[] = [0.8, 0.8, 0.8],
  target = new THREE.Color(),
): THREE.Color {
  return target.setRGB(rgb?.[0] ?? fallback[0], rgb?.[1] ?? fallback[1], rgb?.[2] ?? fallback[2], THREE.SRGBColorSpace);
}

/** One sRGB channel, 0..1, to linear — what a colour attribute holds. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}
