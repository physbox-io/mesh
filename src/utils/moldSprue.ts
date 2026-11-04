// ---------------------------------------------------------------------------
// The pour sprue: a funnel sunk into the lid's outer face, and a neck from it
// to the cavity
// ---------------------------------------------------------------------------
//
// It was one cone, 8 mm at the outer face to 4 mm at the cavity. An epoxy
// pour into a lined gear sculpture sat in that cone and never went in: below
// about 3.5 mm a bubble in an upright tube of resin cannot rise past the
// liquid, so the air under the epoxy had no way up and the epoxy no way down.
// The vents were open and the cavity was one piece; only the neck was wrong.
//
// So the neck is never narrower than the cast material can pass
// (castMaterials.ts, sprueNeckMm), whatever the options say, and it runs
// straight from the funnel's foot to the cavity. The funnel is a 45° cone,
// which prints on the bed side of the lid without support, as wide as asked
// and as deep as the lid allows: it stops `MIN_FUNNEL_WALL_MM` short of the
// cavity everywhere under it.
// ---------------------------------------------------------------------------

import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import type { Grid } from './moldColumns';
import { castMaterial, type CastMaterialId } from './castMaterials';

/** Mold left between the funnel and the cavity under it, mm. */
export const MIN_FUNNEL_WALL_MM = 1.5;

export interface SprueChannel {
  x: number;
  y: number;
  /** Radius of the funnel's mouth at the lid's outer face. */
  outerR: number;
  /** Radius of the neck, from the funnel's foot to the cavity. */
  innerR: number;
  /** How far the funnel goes into the lid from its outer face, mm (45°: outerR - innerR). */
  funnelDepth: number;
}

/** The neck diameter a pour of this material gets: the asked one, or the material's least. */
export function sprueNeckDiaMm(askedMm: number, material: CastMaterialId = 'epoxy'): number {
  return Math.max(askedMm, castMaterial(material).sprueNeckMm);
}

/**
 * The sprue at (x, y) on the lid's grid. `cavityDepth` is how deep the lid's
 * cavity goes below its parting face per grid column (the deepest of any
 * field that cuts it), and `blockHeight` the lid's thickness to its outer
 * face. The funnel shrinks, keeping its 45°, until it clears the cavity.
 */
export function planSprue(
  x: number,
  y: number,
  opts: { sprueTopDiaMm: number; sprueBottomDiaMm: number; castMaterial?: CastMaterialId },
  grid: Grid,
  cavityDepth: Float64Array,
  blockHeight: number,
  /** The widest the mouth may be where it is, for a block that follows the part's outline. */
  roomR = Infinity,
): SprueChannel {
  const { cols, rows, stepX, stepY, halfW, halfD } = grid;
  const neckR = sprueNeckDiaMm(opts.sprueBottomDiaMm, opts.castMaterial) / 2;
  // At least twice the neck across, so there is a funnel to pour into, and
  // the wall's thickness inside the block's edge: a down-sprue in the wall
  // had its funnel 0.4 mm from breaking out of the side.
  const inside = Math.min(roomR, halfW - Math.abs(x), halfD - Math.abs(y)) - MIN_FUNNEL_WALL_MM;
  const askedMouthR = Math.max(neckR, Math.min(Math.max(opts.sprueTopDiaMm / 2, neckR * 2), inside));
  let depth = askedMouthR - neckR;

  const c0 = Math.max(0, Math.floor((x - askedMouthR + halfW) / stepX));
  const c1 = Math.min(cols - 1, Math.ceil((x + askedMouthR + halfW) / stepX));
  const r0 = Math.max(0, Math.floor((y - askedMouthR + halfD) / stepY));
  const r1 = Math.min(rows - 1, Math.ceil((y + askedMouthR + halfD) / stepY));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const d = Math.hypot(-halfW + c * stepX - x, -halfD + r * stepY - y);
      // The neck goes through anyway; past the mouth nothing is cut.
      if (d <= neckR || d >= askedMouthR) continue;
      // The funnel's wall stands depth - (d - neckR) off the outer face here,
      // and must stop the wall's thickness short of the cavity.
      const floor = blockHeight - cavityDepth[r * cols + c] - MIN_FUNNEL_WALL_MM;
      depth = Math.min(depth, floor + (d - neckR));
    }
  }
  depth = Math.max(0, depth);
  return { x, y, outerR: neckR + depth, innerR: neckR, funnelDepth: depth };
}

/**
 * A channel bored from the outer face of a half `blockHeight` thick (cavity
 * below z = 0, outer face at -blockHeight) as a solid to subtract. A sprue is
 * its funnel and neck; a vent the old single taper, wide end out.
 */
export function channelSolid(
  wasm: ManifoldToplevel,
  ch: { x: number; y: number; outerR: number; innerR: number; funnelDepth?: number },
  blockHeight: number,
): Manifold {
  const through = blockHeight + 2;
  if (ch.funnelDepth === undefined) {
    return wasm.Manifold.cylinder(through, ch.outerR, ch.innerR, 24, false).translate([ch.x, ch.y, -blockHeight - 1]);
  }
  // One revolved profile, not a cone added to a cylinder. The union, its two
  // parts deleted before Manifold had evaluated it, left the gear sculpture's
  // lined lid with no sprue at all, and came right whenever anything forced it
  // to evaluate first; a single primitive has nothing to go wrong. The funnel
  // starts a millimetre outside the face, and so a millimetre wider, to keep 45°.
  const z0 = -blockHeight - 1;
  const zFoot = -blockHeight + Math.max(0, ch.funnelDepth);
  const profile: [number, number][] = [
    [0, z0],
    [ch.funnelDepth > 0 ? ch.outerR + 1 : ch.innerR, z0],
    ...(ch.funnelDepth > 0 ? [[ch.innerR, zFoot] as [number, number]] : []),
    [ch.innerR, z0 + through],
    [0, z0 + through],
  ];
  return wasm.Manifold.revolve([profile], 48).translate([ch.x, ch.y, 0]);
}
