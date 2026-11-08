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
 * A bottom-fill gate's diameter. No air has to pass it, and it is what snaps
 * when the casting is lifted off the runner under it, so it is narrow: 4 mm,
 * or the thinnest section the material can flow through at all (concrete's
 * aggregate jams anything under 10).
 */
export function gateDiaMm(material: CastMaterialId = 'epoxy'): number {
  return Math.max(4, castMaterial(material).minSectionMm);
}

/** What a printed hole loses to the first perimeter and to ooze, mm. */
const PRINTED_HOLE_LOSS_MM = 0.5;

/**
 * The vent diameter a pour of this material gets: the asked one, or the least
 * that still lets a bubble rise through it once printed. It was 1.5 mm for
 * everything: a gear sculpture's seven vents came off the printer as pinpricks
 * that shut for good the moment liquid wet their mouths, with any air still
 * behind it left in the casting, and nothing could clear them.
 */
export function ventBoreDiaMm(askedMm: number, material: CastMaterialId = 'epoxy'): number {
  return Math.max(askedMm, castMaterial(material).bubbleRiseMm + PRINTED_HOLE_LOSS_MM);
}

/** A vent's taper, wider at the outer face by this radius, mm. */
export const VENT_TAPER_MM = 0.4;

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
 * The way into an open mold: the part's section, in the half's own frame
 * (cavity below z = 0, the part ending on the face), carried up through the
 * face. Taken right at the face, a part that only touches it (a ball, a dome)
 * got a mouth the size of its tangent patch, ⌀4 mm into a ⌀40 mm ball with a
 * roof over the rest. So the section is taken as deep as it needs to be to hold
 * a circle of `mouthR`, or at its widest if it never does. Returned as the part
 * with its mouth added, `part` consumed; as it was if it does not reach the face.
 *
 * Evaluated before the two are deleted: this union, left lazy, lost the mouth
 * altogether, as one once lost a lined lid its sprue.
 */
export function withPourMouth(wasm: ManifoldToplevel, part: Manifold, mouthR: number): Manifold {
  const bottom = part.boundingBox().min[2];
  if (!(bottom < 0)) return part;
  let best: { z: number; area: number } | null = null;
  for (let z = -0.01; z > bottom; z = z > -0.1 ? -0.1 : z - 0.25) {
    const slice = part.slice(z);
    const area = slice.area();
    let fits = false;
    if (area > 0) {
      const inner = slice.offset(-mouthR);
      fits = !inner.isEmpty();
      inner.delete();
    }
    slice.delete();
    if (area > 0 && (!best || area > best.area)) best = { z, area };
    if (fits) {
      best = { z, area };
      break;
    }
  }
  if (!best) return part;
  const slice = part.slice(best.z);
  const stub = wasm.Manifold.extrude(slice, 2 - best.z);
  slice.delete();
  const mouth = stub.translate([0, 0, best.z]);
  stub.delete();
  const out = part.add(mouth);
  out.numTri();
  part.delete();
  mouth.delete();
  return out;
}

/**
 * A channel bored from the outer face of a half `blockHeight` thick (cavity
 * below z = 0, outer face at -blockHeight) as a solid to subtract. A sprue is
 * its funnel and neck; a vent a single taper, wide end out, that stops at
 * `pocketZMm` above the parting face if the pocket it serves ends in this half.
 */
export function channelSolid(
  wasm: ManifoldToplevel,
  ch: { x: number; y: number; outerR: number; innerR: number; funnelDepth?: number; pocketZMm?: number },
  blockHeight: number,
): Manifold {
  const through = blockHeight + 2;
  if (ch.funnelDepth === undefined) {
    const stop = ch.pocketZMm ?? 0;
    const height = stop > 0 ? blockHeight + 1 - stop : through;
    return wasm.Manifold.cylinder(height, ch.outerR, ch.innerR, 24, false).translate([ch.x, ch.y, -blockHeight - 1]);
  }
  // One revolved profile, not a cone added to a cylinder. The union, its two
  // parts deleted before Manifold had evaluated it, left the gear sculpture's
  // lined lid with no sprue at all, and came right whenever anything forced it
  // to evaluate first; a single primitive has nothing to go wrong. The funnel
  // starts a millimetre outside the face, and so a millimetre wider, to keep 45°.
  const z0 = -blockHeight - 1;
  const zFoot = -blockHeight + Math.max(0, ch.funnelDepth);
  const zTop = z0 + through;
  const r0 = ch.funnelDepth > 0 ? ch.outerR + 1 : ch.innerR;
  const r1 = ch.innerR;
  const profile: [number, number][] = [
    [0, z0],
    [r0, z0],
    ...(ch.funnelDepth > 0 ? [[r1, zFoot] as [number, number]] : []),
    [r1, zTop],
    [0, zTop],
  ];
  let body = wasm.Manifold.revolve([profile], 48);
  // Four vertical air-bleed ribs at 45°, 135°, 225°, 315° projecting into the
  // funnel and neck wall: their sharp interior corners break the circular
  // capillary meniscus so air escapes up the corners while liquid pours down.
  const ribDepth = Math.min(0.45, Math.max(0, r1 - 0.8));
  const ribWidth = Math.min(0.6, r1 * 0.3);
  if (ribDepth > 0.1 && ribWidth > 0.1) {
    const ribPoly: [number, number][] = [
      [r0 - ribDepth, z0 - 0.5],
      [r0 + 0.5, z0 - 0.5],
      ...(ch.funnelDepth > 0 ? [[r1 + 0.5, zFoot] as [number, number]] : []),
      [r1 + 0.5, zTop + 0.5],
      [r1 - ribDepth, zTop + 0.5],
      ...(ch.funnelDepth > 0 ? [[r1 - ribDepth, zFoot] as [number, number]] : []),
    ];
    const slab = wasm.Manifold.extrude([ribPoly], ribWidth).translate([0, 0, -ribWidth / 2]).rotate([90, 0, 0]);
    for (const deg of [45, 135, 225, 315]) {
      const rib = slab.rotate([0, 0, deg]);
      const next = body.subtract(rib);
      body.delete();
      rib.delete();
      body = next;
    }
    slab.delete();
    body.numTri();
  }
  const out = body.translate([ch.x, ch.y, 0]);
  body.delete();
  out.numTri();
  return out;
}
