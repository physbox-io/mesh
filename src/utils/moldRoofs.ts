// ---------------------------------------------------------------------------
// Roofs over the casting, as a slicer sees a mold half printed face up
// ---------------------------------------------------------------------------
//
// A mold half prints parting face up, so its cavity opens upward and needs no
// support. Mold that hangs over cast space is different. A slicer supports it,
// and support printed in the cavity fills what the casting needed: a real HIPS
// insert came off the printer with its face closed over the casting, apart
// from thin outlines, because "support everywhere" had filled in under it.
//
// This walks the printed body a layer at a time. Each layer is held up by the
// one below grown by a layer height (a 45° overhang), and whatever is not held
// up and lies over cast space is a roof. A roof printed without support has to
// be reached from where its layer is held up, a short way out. Anything further
// out is a roof a slicer will support.
// ---------------------------------------------------------------------------

import type { CrossSection, Manifold } from 'manifold-3d';

/** Layer height the check slices at, mm. */
export const ROOF_LAYER_MM = 0.2;
/**
 * How far an unsupported layer can reach out from held-up material and still
 * print with nothing under it, mm. Kept short: Bambu Studio supported the
 * window pads of a gear insert that were bridges of under 6 mm, and support
 * in the cavity is the failure this guards against.
 */
export const ROOF_REACH_MM = 1;

/** Narrower than this, a roof is a sliver no slicer prints, mm. */
const SLIVER_MM = 0.3;

export interface CavityRoof {
  /** Where the roof's underside is, below the parting face (z = 0 in the half's frame), mm. */
  depthMm: number;
  /** How much of it prints only with support under it, mm². */
  areaMm2: number;
  /** Middle of that region in the half's frame, mm. */
  at: [number, number];
}

/**
 * The roofs over `cast` in `body` that print only with support under them,
 * one per layer they start in, worst first. Both solids are in the half's own
 * frame, parting face at z = 0, and the body prints the way up it lies.
 */
export function unprintableRoofs(
  body: Manifold,
  cast: Manifold,
  layerMm = ROOF_LAYER_MM,
  reachMm = ROOF_REACH_MM,
): CavityRoof[] {
  const box = body.boundingBox();
  const found: CavityRoof[] = [];
  let below: CrossSection | null = null;
  for (let z = box.min[2] + layerMm / 2; z < box.max[2]; z += layerMm) {
    const layer = body.slice(z);
    if (below) {
      const grown = below.offset(layerMm, 'Round');
      const held = layer.intersect(grown);
      const loose = layer.subtract(held);
      if (loose.area() > 1e-3) {
        const castBelow = cast.slice(z - layerMm);
        const roof = loose.intersect(castBelow);
        if (roof.area() > 1e-3) {
          const reach = held.offset(reachMm, 'Round');
          const raw = roof.subtract(reach);
          // Slivers thinner than a nozzle's line print as nothing.
          const thin = raw.offset(-SLIVER_MM / 2, 'Round');
          const bad = thin.offset(SLIVER_MM / 2, 'Round');
          raw.delete();
          thin.delete();
          const a = bad.area();
          if (a > 0.25) {
            const b = bad.bounds();
            found.push({
              depthMm: Math.round(-(z - layerMm / 2) * 100) / 100,
              areaMm2: Math.round(a * 10) / 10,
              at: [Math.round(((b.min[0] + b.max[0]) / 2) * 10) / 10, Math.round(((b.min[1] + b.max[1]) / 2) * 10) / 10],
            });
          }
          bad.delete();
          reach.delete();
        }
        roof.delete();
        castBelow.delete();
      }
      grown.delete();
      held.delete();
      loose.delete();
      below.delete();
    }
    below = layer;
  }
  below?.delete();
  return found.sort((p, q) => q.areaMm2 - p.areaMm2);
}
