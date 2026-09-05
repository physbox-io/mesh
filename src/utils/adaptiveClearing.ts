// ---------------------------------------------------------------------------
// Adaptive clearing — taking the waste out without breaking the cutter
// ---------------------------------------------------------------------------
//
// Roughing a relief means removing everything above the finished surface, one
// horizontal slab at a time, and the question is what path the tool takes
// through each slab.
//
// The obvious answer, and the one this app has always used, is a raster: sweep
// back and forth in parallel lines, stepping over by some fraction of the
// cutter each time. It is simple and it works, but it has a failure mode that
// decides how the whole job has to be set up. The stepover only describes how
// much material the tool takes in the *steady state*, in the middle of a long
// straight line. Every time a line runs into a concave part of the boundary, or
// crosses a channel narrower than the cutter, the tool is suddenly cutting with
// its full width instead of a fraction of it. Engagement goes from 40% to 100%
// in the space of a millimetre, and with it the cutting force and the heat.
//
// A tool cannot be set up for both. So it gets set up for the worst case: a
// shallow stepdown that a full-width bite will survive. That shallow stepdown
// is then paid for over the entire job, most of which never sees a full-width
// bite at all — which is why roughing a deep relief takes as long as it does.
//
// Clearing along contours of the region instead removes the spike. Every ring
// after the first has open air on the outside of it, because the previous ring
// just cut it away, so the engagement really is the stepover — everywhere,
// including in corners, which is exactly where the raster fails. With the worst
// case gone, the axial depth can go up several times over, and a deeper cut at
// a smaller radial engagement removes more material per minute while asking
// less of the tool.
//
// What this does NOT do is loop the tool trochoidally through the first ring of
// each slab, which is unavoidably a slot: nothing has cut the material either
// side of it yet. That one pass is instead fed at a rate scaled for the
// engagement it really has, which keeps the chip load right without the
// complexity of generating the loops. It is the honest 90% of the benefit, and
// the remaining slot is one ring per layer rather than the whole path.

import type { Point2D } from './laserCutExporter';
import { squaredDistanceTransform } from './heightmapMesh';
import { isoContours } from './marchingSquares';
import { orientForClimb } from './polygonOffset';

/** Where the tool's centre is allowed to be, on a grid. */
export interface ClearingRegion {
  /** 1 where the centre may go at this depth. */
  mask: Uint8Array;
  cols: number;
  rows: number;
  /** Size of one grid cell in mm. */
  mmPerCell: number;
  /** Stock coordinates of the (0,0) cell centre, mm. */
  originMm: Point2D;
}

/** One concentric ring of the clearing path. */
export interface ClearingRing {
  /** How far in from the region's boundary this ring runs, mm. */
  insetMm: number;
  /**
   * How much of the cutter's diameter is buried in material along this ring,
   * as a fraction.
   *
   * 1 on the first ring of a slab, which is a slot with uncut material on both
   * sides. `stepover / diameter` on every ring after it, because the ring
   * outside has already opened the way. This is the number the feedrate is
   * scaled by, and it is the whole reason the method is worth the trouble.
   */
  engagement: number;
  /** Closed paths in stock coordinates, mm. */
  loops: Point2D[][];
}

/**
 * Distance from every cell inside the region to the nearest cell outside it, mm.
 *
 * Half a cell is taken off for the same reason it is in the V-carve field: the
 * transform measures centre to centre, so a cell hard against the edge reports
 * a whole cell when the edge is really half of one away.
 */
export function clearanceField(region: ClearingRegion): Float32Array {
  const { mask, cols, rows, mmPerCell } = region;
  const outside = new Uint8Array(cols * rows);
  for (let i = 0; i < outside.length; i++) outside[i] = mask[i] ? 0 : 1;

  const sq = squaredDistanceTransform(outside, cols, rows);
  const out = new Float32Array(cols * rows);
  for (let i = 0; i < out.length; i++) {
    if (!mask[i]) { out[i] = 0; continue; }
    const d = Math.sqrt(sq[i]) - 0.5;
    out[i] = d > 0 ? d * mmPerCell : 0;
  }
  return out;
}

/**
 * The concentric rings that clear a region, outermost first.
 *
 * Outermost first is the order that makes the method work. Each ring is cut
 * with the ring outside it already gone, so the material it meets is only the
 * stepover's worth on its inner side. Reverse the order and every ring is a
 * slot, which is the thing being avoided.
 *
 * `toolDiameterMm` is only used to express the engagement as a fraction; the
 * geometry of the rings depends on the stepover alone, because the region has
 * already been shrunk by the tool's radius by whoever built the mask.
 */
export function clearingRings(
  region: ClearingRegion,
  stepoverMm: number,
  toolDiameterMm: number,
  maxRings = 500
): ClearingRing[] {
  const field = clearanceField(region);
  const step = Math.max(region.mmPerCell, stepoverMm);

  let deepest = 0;
  for (let i = 0; i < field.length; i++) if (field[i] > deepest) deepest = field[i];
  if (deepest <= 0) return [];

  const rings: ClearingRing[] = [];
  const steadyEngagement = Math.max(0.01, Math.min(1, step / Math.max(1e-6, toolDiameterMm)));

  for (let k = 0; k < maxRings; k++) {
    // The first ring hugs the boundary. A quarter of a cell in rather than zero,
    // because a contour taken at exactly zero runs along the flat outside the
    // region where every value is identical, and marching squares has nothing
    // to interpolate between there.
    const inset = k === 0 ? region.mmPerCell * 0.25 : k * step;
    if (inset > deepest) break;

    const loops = isoContours(field, region.cols, region.rows, inset);
    if (loops.length === 0) continue;

    rings.push({
      insetMm: inset,
      engagement: k === 0 ? 1 : steadyEngagement,
      /*
       * Wound so the cutter climb-mills. Rings are cut outermost first, so
       * every one after the first meets stock on its inner side only — the
       * ring outside it has already gone — and material inside the loop means
       * cutting it clockwise. Marching squares has no reason to prefer either
       * winding, so without this the direction is whichever way the contour
       * tracer happened to walk, and half the rings shave while the other half
       * rub. Rubbing is heat in the tool, which on aluminium is what welds
       * swarf to the flutes.
       */
      loops: loops.map((loop) => orientForClimb(
        loop.map((p) => ({
          x: region.originMm.x + p.x * region.mmPerCell,
          y: region.originMm.y + p.y * region.mmPerCell,
        })),
        'inside'
      )),
    });
  }

  return rings;
}

/**
 * Feed to run a ring at, given what it is actually cutting.
 *
 * Chip thickness falls as the tool wraps further round the cut, so the same
 * feedrate at a smaller engagement means thinner chips — which rub and burn
 * rather than cut, and blunt the tool faster than a heavy cut does. Real CAM
 * compensates by feeding *faster* at small engagements; the same arithmetic run
 * the other way is what protects the tool on the slotting first ring.
 *
 * The correction is the ratio of chip thicknesses, which for a radial
 * engagement `a` on a cutter of radius `r` is `sqrt(1 − (1 − a/r)²)`. It is
 * clamped, because the formula runs away at very small engagements and no
 * hobby router wants its roughing feed tripled.
 */
export function feedForEngagement(
  baseFeedMmMin: number,
  engagement: number,
  referenceEngagement = 0.45,
  maxBoost = 1.6
): number {
  const chipFactor = (fraction: number) => {
    const a = Math.max(1e-4, Math.min(1, fraction)) * 2; // fraction of diameter -> of radius
    const inner = Math.max(0, 1 - Math.min(1, a));
    return Math.sqrt(Math.max(1e-6, 1 - inner * inner));
  };

  const ratio = chipFactor(referenceEngagement) / chipFactor(engagement);
  const clamped = Math.max(1 / maxBoost, Math.min(maxBoost, ratio));
  return Math.max(1, Math.round(baseFeedMmMin * clamped));
}

/**
 * The stepdown a slab may be cut at, given how far round the tool is wrapping.
 *
 * This is the payoff, stated as a number rather than a claim, and it has to be
 * a real one: a smaller radial bite means proportionally more path to walk, so
 * if the depth does not go up by *more* than the stepover came down, adaptive
 * clearing is just a slower raster with better manners.
 *
 * What makes it come out ahead is that side load does not fall linearly with
 * engagement — it falls off faster, and below about a quarter of the diameter
 * the thing limiting the cut stops being force at all and becomes how much
 * flute the cutter has. Hence the 1.5 power, and hence the cap: an inch and a
 * half of depth on a 6 mm bit is not a force problem, it is a bit that does not
 * have that much flute, and this knows nothing about how far any particular
 * tool is hanging out of the collet.
 *
 * The result on a deep relief is roughly a third off the roughing time, on top
 * of the reason the method was worth having — that the tool never meets the
 * full-width bite a raster springs on it in every corner.
 */
export function stepdownForEngagement(
  toolDiameterMm: number,
  engagement: number,
  baselineStepdownMm: number,
  referenceEngagement = 0.45
): number {
  const ratio = Math.max(0.02, Math.min(1, engagement));
  const gain = Math.pow(referenceEngagement / ratio, 1.5);
  return Math.min(toolDiameterMm * 1.5, Math.max(baselineStepdownMm, baselineStepdownMm * gain));
}
