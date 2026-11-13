// Cutter descriptions, reach limits, and the tooling and feeds a relief carve is given by default.

import { stepdownForEngagement } from './adaptiveClearing';
import { DEFAULT_MATERIAL, recommendSpeeds, type MaterialId, type SpindleRange } from './feedsAndSpeeds';
import { vBitConeHeight, type CutterGeometry, type CutterShape, type CutterTip, type ReliefCarveOptions } from './reliefOptions';

/** Stickout, in tool diameters, past which a bit is too whippy to hold a surface. */
export const MAX_REACH_DIAMETERS = 4;

/** Cutting length, in diameters, past which long-reach bits stop being a stock item. */
export const MAX_AVAILABLE_REACH_DIAMETERS = 8;

/**
 * Shank a bit that size is most likely ground on.
 *
 * Anything under an eighth of an inch is a small cutter on a standard blank —
 * a 1.6 mm bit almost always arrives on a 3.175 mm shank — which is exactly the
 * step that fouls a deep cut. Bigger bits are their own diameter all the way up.
 */
export function autoShankDia(diaMm: number): number {
  return diaMm < 3.175 ? 3.175 : diaMm;
}

/**
 * Cutting length a bit that size is likely to carry. Catalogue bits run about
 * this.
 *
 * A V-bit is not a catalogue guess at all — its cutting length is a fact about
 * the cone. The flank stops widening the instant it reaches the nominal
 * diameter, and everything above that point is shank, so a 6 mm 60 deg bit has
 * 5.2 mm of usable cutter and no more however long the blank is.
 */
export function autoFluteLength(diaMm: number, tip?: CutterTip): number {
  if (tip?.shape === 'v_bit') return vBitConeHeight(diaMm, tip.vBitAngleDeg ?? 60);
  return diaMm * 3;
}

/** How a cutter shape reads in a header comment and in a pause prompt. */
const SHAPE_NAMES: Record<CutterShape, string> = {
  ball_nose: 'ball-nose end mill',
  flat: 'flat end mill',
  v_bit: 'V-bit',
};

/**
 * Names a cutter the way the operator standing at the machine holding a box of
 * bits needs it named.
 *
 * "T2 M6" tells them nothing. "6 mm 60 deg V-bit, 2-flute downcut" is the label
 * on the packet, and it is the difference between fitting the right tool and
 * finding out at the end of the finishing pass that they did not.
 */
export function describeCutter(
  diaMm: number,
  shape: CutterShape,
  flutes: number,
  geometry: CutterGeometry,
  vBitAngleDeg = 60
): string {
  const head =
    shape === 'v_bit'
      ? `${diaMm} mm ${Math.round(vBitAngleDeg)}\u00b0 V-bit`
      : `${diaMm} mm ${SHAPE_NAMES[shape]}`;
  const n = Math.max(1, Math.round(flutes));
  const helix = geometry === 'straight' ? 'straight-flute' : geometry;
  return `${head}, ${n}-flute ${helix}`;
}

/**
 * Chip thickness per cutting edge, mm — the number a feed rate actually means.
 *
 * Feed, spindle speed and flute count are three views of one quantity, and the
 * flute count is the one nothing in this app used to know: at 12,000 RPM a
 * 1500 mm/min feed is 0.06 mm a tooth on a two-flute cutter and 0.03 mm on a
 * four, which is the difference between cutting and rubbing. That is exactly
 * why the number of flutes changes the program.
 */
export function chiploadMm(feedMmMin: number, rpm: number, flutes: number): number {
  const n = Math.max(1, Math.round(flutes));
  return feedMmMin / Math.max(1, rpm) / n;
}

/** Two decimals, so a derived setting lands in the UI as a number and not a float artefact. */
export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Diameters a workshop is likely to actually own, metric and imperial mixed. */
export const STANDARD_BIT_DIAS = [0.8, 1.0, 1.5, 2.0, 3.0, 3.175, 4.0, 6.0, 6.35];

export interface ReliefToolingInput {
  /**
   * The narrowest valley the finishing bit has to get into, in mm, as
   * `measureDetailMm` reads it off the relief. Left out, the bit is sized from
   * the board alone.
   */
  detailMm?: number;
  /** How deep the relief goes, in mm. */
  reliefDepthMm: number;
  /** Plan-view size of the carved area in mm. */
  planWidthMm: number;
  planDepthMm: number;
  /** What is being cut. Decides both the spindle speed and the chip it wants. */
  material?: MaterialId;
  /**
   * What the spindle can actually be set to, from the controller's `$30`/`$31`
   * when there is one. Without it a common hobby range is assumed.
   */
  spindle?: SpindleRange | null;
  /** Fastest the gantry tracks while cutting, mm/min — `$110`/`$111`. */
  maxFeedMmMin?: number;
}

/**
 * Picks tooling that suits a given relief, so a model does not have to carry
 * machining settings around with it.
 *
 * A mesh is a description of an object. How deep it is and how wide it is are
 * properties of that object; which cutter reaches the bottom of it is a property
 * of this exporter and the tools it knows about. Keeping the second out of the
 * first is what lets the same model be carved on stock it was not designed for.
 *
 * The binding constraint is reach, and reach is about the shank rather than the
 * cutter. Bits under 3.175 mm are ground on a 3.175 mm blank, so past the length
 * of their flutes it is the shank in the cut, not the edges — which means a deep
 * relief cannot be finished with a small bit however fine the detail wants to
 * be. The smallest bit that can reach the floor is therefore the best bit, and
 * for anything deeper than a few millimetres that lands on 3.175 mm, the point
 * where shank and cutting diameter meet.
 *
 * Stiffness is deliberately not a constraint here, only a warning elsewhere. A
 * bit held twenty diameters out will chatter, but refusing to emit the job would
 * leave no job at all; slowing the feed and saying so is the honest response.
 */
export function recommendReliefTooling(input: ReliefToolingInput): Partial<ReliefCarveOptions> {
  const depth = Math.max(0.1, input.reliefDepthMm);
  const planMin = Math.max(1, Math.min(input.planWidthMm, input.planDepthMm));
  const material = input.material ?? DEFAULT_MATERIAL;

  // Do not go finer than the part can use. A bit far below this turns a carving
  // into a week of raster lines for detail the wood will not hold anyway.
  const detailFloor = planMin / 40;

  // A straight-shank bit has no step to foul, so geometry alone would let it go
  // arbitrarily deep. Availability does not: long-reach bits run out somewhere
  // around eight diameters of cutting length, and past that the bit is not a
  // stiffness problem, it is a bit that cannot be bought. A stepped bit is
  // limited by its flutes however long the blank behind them is.
  const straightShank = (d: number) => autoShankDia(d) <= d + 1e-6;
  const canReach = (d: number) =>
    depth <= (straightShank(d) ? d * MAX_AVAILABLE_REACH_DIAMETERS : autoFluteLength(d));
  const byBoard =
    STANDARD_BIT_DIAS.find((d) => d >= detailFloor && canReach(d)) ??
    STANDARD_BIT_DIAS.find(canReach) ??
    STANDARD_BIT_DIAS[STANDARD_BIT_DIAS.length - 1];

  // A bit has to get into the valleys it is finishing. Sized from the board
  // alone, a 300 mm giraffe hide got a 6 mm ball for 4 mm seams: it rode the
  // seam tops and never touched a floor. `detailMm` is the widest disc that
  // reaches the valleys at six tenths of the depth; the floor below that is
  // narrower still where the walls slope, hence the margin. Of the bits that
  // fit, take the one the board rule would have picked, or the largest.
  const detailCap = input.detailMm !== undefined && input.detailMm > 0 ? input.detailMm * 0.8 : Infinity;
  const fitting = STANDARD_BIT_DIAS.filter((d) => d <= detailCap && canReach(d));
  const finishDia =
    byBoard <= detailCap ? byBoard : fitting.length > 0 ? fitting[fitting.length - 1] : byBoard;

  // The waste is wide open, so the roughing bit is limited by the part rather
  // than by reach. A fifth of the narrow side keeps it inside the shape.
  const roughCandidates = STANDARD_BIT_DIAS.filter((d) => d <= planMin / 5 && d > finishDia);
  const roughDia = roughCandidates.length > 0 ? roughCandidates[roughCandidates.length - 1] : finishDia;

  // Flutes a bit that size is ground with, and the reason the feed depends on
  // it. Under about 2 mm there is no room in the gullet for a second flute's
  // worth of chip, so small cutters come single-fluted and are fed at half the
  // rate a two-flute one of the same chipload would take.
  const flutesFor = (d: number) => (d < 2 ? 1 : 2);

  /**
   * Speeds for a cutter of a given size, from the material rather than from a
   * fixed RPM handed in.
   *
   * The spindle speed used to be an input to this function — whatever was in
   * the box, usually the untouched 12,000 default — and the feed was derived
   * from it. That is backwards. Surface speed is a property of the material and
   * the cutter, so the RPM is an output, and the feed follows from the RPM that
   * was actually chosen rather than from one nobody picked.
   *
   * The derate is stickout: a bit reaching down four diameters is already
   * bending, and asking it for a full chip on top of that is how it snaps.
   */
  const speedsFor = (d: number) =>
    recommendSpeeds({
      diameterMm: d,
      flutes: flutesFor(d),
      material,
      spindle: input.spindle,
      maxFeedMmMin: input.maxFeedMmMin,
      derate: Math.min(1, Math.max(0.4, (MAX_REACH_DIAMETERS * d) / depth)),
    });

  const roughSpeeds = speedsFor(roughDia);
  const finishSpeeds = speedsFor(finishDia);

  // Both passes run at one spindle speed, because on the machines this app
  // drives the speed is a dial and the job only stops once. The finishing bit
  // is the smaller and more fragile of the two, so it is the one the setting
  // has to suit; the roughing feed is then worked back from that same speed
  // rather than from the one the roughing bit would have preferred.
  const rpm = finishSpeeds.rpm;
  // Scaled up to the finishing bit's speed, a roughing feed can pass what the
  // gantry can track, so it is held to that.
  const maxFeed = input.maxFeedMmMin && input.maxFeedMmMin > 0 ? input.maxFeedMmMin : Infinity;
  const feedAt = (rec: ReturnType<typeof speedsFor>) =>
    Math.min(maxFeed, Math.max(50, Math.round((rec.feedMmMin * (rpm / rec.rpm)) / 10) * 10));

  return {
    material,
    spindleRpm: rpm,

    roughingEnabled: roughDia > finishDia + 1e-6,
    roughingToolDiaMm: roughDia,
    roughingStepdownMm: round2(
      Math.min(depth / 2, Math.max(0.2, roughDia * (material === 'aluminium' ? 0.1 : 0.3)))
    ),
    roughingAllowanceMm: round2(Math.min(0.5, Math.max(0.1, finishDia / 8))),
    roughingFeedrate: feedAt(roughSpeeds),
    roughingPlungeRate: Math.max(30, Math.round(feedAt(roughSpeeds) / 3 / 10) * 10),
    roughingFlutes: flutesFor(roughDia),
    // Upcut for roughing, always: the job of this pass is to get waste out of a
    // pocket, and that is the only geometry that lifts it.
    roughingGeometry: 'upcut',

    finishingToolType: 'ball_nose',
    finishingToolDiaMm: finishDia,
    finishingFlutes: flutesFor(finishDia),
    finishingGeometry: 'upcut',
    // Leave at 0 (auto) so autoShankDia and autoFluteLength track subsequent
    // diameter changes by the operator.
    finishingShankDiaMm: 0,
    finishingFluteLengthMm: 0,
    finishingStepoverPercent: 25,
    finishingFeedrate: finishSpeeds.feedMmMin,
    finishingPlungeRate: finishSpeeds.plungeMmMin,
    // Sweep the long way: fewer, longer passes and fewer lead-ins.
    finishingDirection: input.planWidthMm >= input.planDepthMm ? 'x' : 'y',
  };
}
/**
 * The settings a relief carve can work out for itself, given the bits and the
 * material.
 *
 * Separated from `recommendReliefTooling` because they answer different
 * questions. That one picks the *tools* — which is a decision, made once, that
 * changes what the operator has to go and find in a drawer. These are the
 * consequences of that decision, and they should never have been typed by
 * anybody: spindle speed is surface speed over diameter, feed is chip per tooth
 * times teeth times RPM, and stepdown and stepover are fractions of the cutter.
 * Presenting them as empty boxes with plausible defaults in them is how a
 * beginner ends up running a 1 mm bit at a feed meant for a 6 mm one.
 */
export type DerivedReliefSettings = Pick<
  ReliefCarveOptions,
  | 'spindleRpm'
  | 'finishingFeedrate'
  | 'finishingPlungeRate'
  | 'finishingStepoverPercent'
  | 'finishingStepdownMm'
  | 'roughingFeedrate'
  | 'roughingPlungeRate'
  | 'roughingStepdownMm'
  | 'roughingAllowanceMm'
>;

/** Which of a relief's settings are derived, and therefore overridable. */
export type ReliefOverrides = Partial<DerivedReliefSettings>;

/**
 * Works the feeds and speeds out from the tools and the material that were
 * actually chosen.
 *
 * One spindle speed for the whole job, set by the finishing bit — it is the
 * smaller and more fragile of the two, and on the machines this app drives the
 * speed is a dial that gets turned once. The roughing feed is then worked back
 * from that same speed rather than from the one the roughing bit would have
 * preferred on its own.
 */
export function deriveReliefFeeds(
  opts: Pick<
    ReliefCarveOptions,
    | 'material'
    | 'finishingToolDiaMm'
    | 'finishingFlutes'
    | 'roughingToolDiaMm'
    | 'roughingFlutes'
    | 'carveDepthMm'
  > & Partial<Pick<ReliefCarveOptions, 'finishingToolType'>>,
  spindle?: SpindleRange | null,
  /** Fastest the gantry tracks while cutting, mm/min — `$110`/`$111`. */
  maxFeedMmMin?: number
): DerivedReliefSettings {
  const finishDia = Math.max(0.1, opts.finishingToolDiaMm);
  const roughDia = Math.max(0.1, opts.roughingToolDiaMm);
  const depth = Math.max(0.1, opts.carveDepthMm);

  const finish = recommendSpeeds({
    diameterMm: finishDia,
    flutes: opts.finishingFlutes,
    material: opts.material,
    spindle,
    maxFeedMmMin,
    // Stickout: a bit reaching down four diameters is already bending, and a
    // full chip on top of that is how it snaps.
    derate: Math.min(1, Math.max(0.4, (MAX_REACH_DIAMETERS * finishDia) / depth)),
  });
  const rough = recommendSpeeds({
    diameterMm: roughDia,
    flutes: opts.roughingFlutes,
    material: opts.material,
    spindle,
    maxFeedMmMin,
  });

  const rpm = finish.rpm;
  // The roughing bit at the finishing bit's speed: same chip per tooth, so the
  // feed scales with however far the speed had to move - but never past what
  // the gantry can track.
  const roughFeed = Math.min(
    maxFeedMmMin && maxFeedMmMin > 0 ? maxFeedMmMin : Infinity,
    Math.max(50, Math.round((rough.feedMmMin * (rpm / rough.rpm)) / 10) * 10)
  );
  const soft = opts.material === 'foam' || opts.material === 'softwood';
  const metal = opts.material === 'aluminium';

  return {
    spindleRpm: rpm,
    finishingFeedrate: finish.feedMmMin,
    finishingPlungeRate: finish.plungeMmMin,
    // A ball nose leaves a scallop of about 3% of its radius at this spacing,
    // which sands out; a V-bit's ridge is set by its angle instead. A flat mill
    // leaves none on a flat, so it strides further - as far as the solid
    // dialog has always set, and no further: on the slopes a hybrid still
    // rasters, its steps grow with the stride.
    finishingStepoverPercent: opts.finishingToolType === 'flat' ? 30 : 25,
    // 0 means "one bite as deep as the cutter is wide", which is what a
    // finishing pass over already-roughed stock can take.
    finishingStepdownMm: 0,
    roughingFeedrate: roughFeed,
    roughingPlungeRate: Math.max(30, Math.round(roughFeed / 3 / 10) * 10),
    roughingStepdownMm:
      Math.round(Math.min(depth / 2, Math.max(0.2, roughDia * (metal ? 0.1 : soft ? 0.4 : 0.3))) * 100) / 100,
    roughingAllowanceMm: Math.round(Math.min(0.5, Math.max(0.1, finishDia / 8)) * 100) / 100,
  };
}

/**
 * The radial bite an adaptive clear should take, as a fraction of the cutter.
 *
 * A light bite buys depth: `stepdownForEngagement` lets a 20% bite go about
 * three times deeper than a 45% one. That is only worth having where the depth
 * has layers to give back. On a 6 mm relief a 6.35 mm cutter clears the whole
 * thing in two layers at 30% as surely as at 20%, and the 20% bite then just
 * walks half as much again of path for nothing — a third of the roughing time
 * on a foliage panel, measured. The cost of a bite is the layers it takes
 * divided by the width it takes them at, which is the path length to within a
 * constant, so the bite is the one that minimises that, the wider one on a tie.
 *
 * The layer count is worked out exactly as the roughing pass lays them.
 */
export function adaptiveBiteFraction(toolDiaMm: number, baseStepdownMm: number, roughDepthMm: number): number {
  const depth = Math.max(0, roughDepthMm);
  let best = 0.2;
  let bestCost = Infinity;
  // Nothing wider than 30%: measured on six reliefs with two cutters, 40%
  // was slower than 30% in every case but one, and 30% was never much worse
  // than 20%.
  for (const e of [0.2, 0.25, 0.3]) {
    const stepdown = stepdownForEngagement(toolDiaMm, e, Math.max(0.1, baseStepdownMm));
    const layerStep = Math.min(stepdown, Math.max(0.1, depth / 2));
    let layers = 0;
    for (let z = -layerStep; z > -depth + 1e-6; z -= layerStep) layers++;
    if (depth > 1e-6) layers++;
    const cost = layers / e;
    if (cost <= bestCost) {
      bestCost = cost;
      best = e;
    }
  }
  return best;
}
