// Neon: how a geom's `glow` becomes light, and what the composer's Bloom picks up.
//
// Bloom halos whatever is brighter than GLOW_THRESHOLD, which is above anything
// the studio lights or the backdrop reach, so only a glowing geom has a halo.
// Luminance is what it reads, and pure blue has a tenth of green's: so the
// intensity is set by the colour's own luminance, or blue would stay dark while
// yellow blazed. Pure and store-free.

import type { SceneNode } from '../types/scene';

export const GLOW_THRESHOLD = 1.05;

/** Above this a colour adds nothing but white core. */
const MOST_INTENSITY = 14;

export function glowIntensity(glow: number, [r, g, b]: number[]): number {
  if (!(glow > 0)) return 0;
  const luminance = Math.max(0.01, 0.2126 * r + 0.7152 * g + 0.0722 * b);
  return Math.min(MOST_INTENSITY, (glow * 2.4) / luminance);
}

export function sceneGlows(nodes: SceneNode[] | undefined): boolean {
  return (nodes ?? []).some(n => n.geoms?.some(g => (g.glow ?? 0) > 0) || sceneGlows(n.children));
}
