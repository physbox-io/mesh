// ---------------------------------------------------------------------------
// 3D CNC Relief Carving Export Engine
// ---------------------------------------------------------------------------
//
// The laser exporter unwraps flat faces onto sheet stock; the contour exporter
// stacks the model out of horizontal slices. This one carves the model into the
// face of a solid block, the way a relief plaque is carved: the scene is
// sampled from directly above into a heightmap, that heightmap is squashed into
// the depth the user is willing to cut, and a ball-nose, flat or V cutter
// sweeps it in parallel passes.
//
// The pipeline is: tessellate the scene into world triangles, fit them onto the
// stock, drop a ray down through every grid cell to get the surface height,
// dilate that surface by the cutter's own shape so the tool sits ON the surface
// instead of THROUGH it, then emit an optional layered roughing pass followed by
// the finishing raster.
//
// Everything in here is millimetres in machine coordinates, with the top face of
// the stock at Z = 0 and cuts running negative.

import type { SceneGraph } from '../types/scene';
import { collectSceneTriangles } from './contourSliceExporter';
import { warpGcode, type ProbeGrid } from './meshLeveler';
import { estimateGcodeTime } from './timeEstimate';
import { DEFAULT_MOTION_PROFILE, type MotionProfile } from './motionProfile';
import {
  DEFAULT_MATERIAL,
  materialSpec,
  recommendSpeeds,
  type MaterialId,
  type SpindleRange,
} from './feedsAndSpeeds';

/**
 * The shape of a cutter's business end, which is what decides the shape of the
 * surface it can leave behind.
 *
 * A ball nose rides the surface and leaves scallops between passes; a flat mill
 * has to clear the highest point under its whole diameter, so it rounds every
 * convex feature off to its own radius. A V-bit is neither: it is a cone, so it
 * reaches into an internal corner no round cutter can enter and holds detail far
 * finer than its nominal diameter — the reason lettering and fine ornament are
 * cut with one — at the cost of leaving a ridge between passes that grows as the
 * point angle narrows.
 */
export type CutterShape = 'ball_nose' | 'flat' | 'v_bit';

/**
 * Which way a cutter's helix throws the chip, which is not a cosmetic detail:
 * it decides where the waste ends up and therefore how hard the tool may be
 * driven.
 *
 * 'upcut' lifts chips up and out of the cut. It is the one that clears a deep
 * pocket, and the one that lifts thin stock off the bed and frays the top face
 * of the material.
 *
 * 'downcut' presses down. It leaves a clean top edge and holds veneer and thin
 * ply flat, and it packs its own chips into the bottom of the cut — so it wants
 * shallower passes and a much gentler plunge, and it is the wrong tool for a
 * deep relief.
 *
 * 'compression' is upcut for the first few millimetres and downcut above, so
 * both faces of a through-cut come out clean. In a relief the tool never leaves
 * the lower section, so it behaves as an upcut and is simply an expensive one.
 *
 * 'straight' has no helix at all. It neither lifts nor presses, clears poorly,
 * and is mostly what a cheap V-bit or engraver is.
 */
export type CutterGeometry = 'upcut' | 'downcut' | 'compression' | 'straight';

/** How a cutter's tip is shaped, for the dilation that fits it to a surface. */
export interface CutterTip {
  shape: CutterShape;
  /** Included point angle in degrees. Only read when `shape` is 'v_bit'. */
  vBitAngleDeg?: number;
}

/** Half the included angle, in radians, clamped to something a bit can be ground to. */
export function vBitHalfAngleRad(includedDeg: number): number {
  const included = Math.min(170, Math.max(10, includedDeg));
  return ((included / 2) * Math.PI) / 180;
}

/**
 * How far up the cone a V-bit reaches its nominal diameter — its usable
 * cutting depth, past which what is in the cut is the shank.
 */
export function vBitConeHeight(diaMm: number, includedDeg: number): number {
  return diaMm / 2 / Math.tan(vBitHalfAngleRad(includedDeg));
}

export interface ReliefCarveOptions {
  /** Stock width (X extent) in mm. */
  stockWidthMm: number;
  /** Stock depth (Y extent) in mm. */
  stockDepthMm: number;
  /** Stock thickness in mm. Only used to sanity-check the carve depth. */
  stockThicknessMm: number;
  /**
   * How far below the stock's top face the deepest point of the relief goes.
   *
   * In 'fill' mode this is a target the model's height range is stretched onto.
   * In 'proportional' mode it is a limit, and anything past it is flattened.
   */
  carveDepthMm: number;
  /**
   * Whether Z is on the same scale as X and Y.
   *
   * 'fill' stretches the model's height range onto the carve depth whatever the
   * plan scale is. The relief is always exactly as deep as asked for, but Z is
   * decoupled from the plan: fitting a model onto smaller stock shrinks X and Y
   * and leaves Z alone, which quietly multiplies the vertical exaggeration by
   * the same factor the plan shrank by.
   *
   * 'proportional' puts Z on the plan scale, so the model keeps the proportions
   * it was authored with however it is fitted, and `verticalExaggeration` is the
   * only thing that stretches it.
   */
  verticalScaleMode: 'fill' | 'proportional';
  /**
   * Height stretch applied in 'proportional' mode. 1 keeps the model's own
   * proportions; terrain usually wants more, because true-scale terrain over a
   * map-sized plan is a flat board.
   */
  verticalExaggeration: number;
  /** 'fit' scales the model to the stock; 'manual' honours `scalePercent`. */
  fitMode: 'fit' | 'manual';
  /** Plan-view scale when `fitMode` is 'manual', as a percentage of 1 m : 1 mm. */
  scalePercent: number;
  /**
   * What to do with the stock the model does not cover. 'carve' takes the
   * background down to the floor so the model stands proud of it; 'skip' leaves
   * it at full stock height and only cuts where the model actually dips.
   */
  backgroundMode: 'carve' | 'skip';
  /** Clear waste with a flat mill before the finishing raster. */
  roughingEnabled: boolean;
  /** Roughing tool diameter in mm. Always a flat end mill — see `roughingToolDiaMm`. */
  roughingToolDiaMm: number;
  /** Cutting edges on the roughing mill. Feed is chipload x flutes x RPM. */
  roughingFlutes: number;
  /** Which way the roughing mill's helix throws chips. */
  roughingGeometry: CutterGeometry;
  /** Roughing Z stepdown per layer in mm. */
  roughingStepdownMm: number;
  /** Roughing cut feedrate in mm/min. */
  roughingFeedrate: number;
  /** Z plunge rate in mm/min. */
  roughingPlungeRate: number;
  /** Material left on the surface for the finishing pass to take off, in mm. */
  roughingAllowanceMm: number;
  /** Finishing tool shape. A ball nose is what makes a curved surface smooth. */
  finishingToolType: CutterShape;
  /**
   * Included point angle of the finishing V-bit, in degrees — 60 for a 60 deg
   * bit. Ignored unless `finishingToolType` is 'v_bit'.
   */
  finishingVBitAngleDeg: number;
  /** Finishing tool diameter in mm. For a V-bit, the diameter at full depth. */
  finishingToolDiaMm: number;
  /** Cutting edges on the finishing tool. Feed is chipload x flutes x RPM. */
  finishingFlutes: number;
  /** Which way the finishing tool's helix throws chips. */
  finishingGeometry: CutterGeometry;
  /**
   * How the finishing raster gets down to the surface.
   *
   * 'single' is depth-first: every point is taken to its final height the first
   * time the raster crosses it, in one sweep. It is the quicker of the two and
   * the right answer whenever there is little material left to take — after a
   * roughing pass, or in a shallow relief.
   *
   * 'layered' is depth-limited: the raster repeats at successively lower limits,
   * each taking at most a stepdown, so the cutter is never asked to swallow the
   * whole relief at once. Slower, but it is the difference between a job that
   * runs and a snapped bit when the finishing tool is clearing the relief alone.
   *
   * 'auto' picks 'single' when roughing is enabled and 'layered' when it is not.
   */
  finishingDepthMode: 'auto' | 'single' | 'layered';
  /** Most depth one finishing layer may take when layering. 0 uses the tool diameter. */
  finishingStepdownMm: number;
  /** Distance between finishing passes, as a percentage of tool diameter. */
  finishingStepoverPercent: number;
  /** Finishing cut feedrate in mm/min. */
  finishingFeedrate: number;
  /** Finishing Z plunge rate in mm/min. */
  finishingPlungeRate: number;
  /** Which axis the finishing passes sweep along. */
  finishingDirection: 'x' | 'y';
  /**
   * Angle below horizontal at which the cutter descends into the material at
   * the head of a pass. 0 plunges straight down, which is what a cutter is
   * worst at; 10-20 degrees turns the entry into an ordinary cut.
   */
  leadInAngleDeg: number;
  /**
   * Hold the shank and the tool holder clear of the work, not just the flutes.
   *
   * On, the toolpath is lifted wherever a part of the tool that cannot cut would
   * otherwise be driven into the material — so a deep pocket a small bit cannot
   * physically reach comes out with material left in it rather than with the
   * shank ploughing through the wall. Off restores the older behaviour, where
   * only the cutting end is checked and the rest of the tool is assumed away.
   */
  toolBodyClearance: boolean;
  /** Shank diameter of the finishing tool in mm. 0 derives it from the bit. */
  finishingShankDiaMm: number;
  /** Cutting length of the finishing tool in mm. 0 assumes three diameters. */
  finishingFluteLengthMm: number;
  /** Distance from the tip of the tool to the face of the holder in mm. 0 skips the holder. */
  toolStickoutMm: number;
  /** Diameter of the collet nut or holder in mm. 0 skips the holder. */
  holderDiaMm: number;
  /** Retract height above the stock's top face in mm. */
  safeZ: number;
  /** Spindle speed in RPM. */
  spindleRpm: number;
  /**
   * What is clamped on the bed.
   *
   * The only thing in this file that is a property of the workpiece rather than
   * the model, and it has to be here because feeds, speeds and the warnings
   * about them are meaningless without it: 18,000 RPM is right for pine and
   * ruinous for aluminium, and nothing about a mesh can tell you which.
   */
  material: MaterialId;
  /**
   * What the machine can accelerate and traverse at, for the run-time estimate.
   *
   * Read off the controller's own `$$` when one is connected. Left at the
   * assumed hobby-router profile otherwise, which is what the estimate silently
   * used to assume on every machine.
   */
  motionProfile: MotionProfile;
  /**
   * Invert the relief depth: turn positive/raised features (cameo) into
   * sunken cavities (intaglio / mold impression).
   */
  invertRelief?: boolean;
  /** Probed bed mesh, if the bed has been mapped. */
  meshLevelGrid: ProbeGrid | null;
  /** Ride the probed mesh so a warped bed still cuts to a constant depth. */
  applyMeshLeveling: boolean;
};

export const DEFAULT_RELIEF_OPTIONS: ReliefCarveOptions = {
  stockWidthMm: 150,
  stockDepthMm: 150,
  stockThicknessMm: 18,
  carveDepthMm: 10,
  verticalScaleMode: 'fill',
  verticalExaggeration: 1,
  fitMode: 'fit',
  scalePercent: 100,
  backgroundMode: 'carve',
  invertRelief: false,
  roughingEnabled: true,
  roughingToolDiaMm: 6.35,
  roughingFlutes: 2,
  roughingGeometry: 'upcut',
  roughingStepdownMm: 2.0,
  roughingFeedrate: 1200,
  roughingPlungeRate: 300,
  roughingAllowanceMm: 0.5,
  finishingToolType: 'ball_nose',
  finishingVBitAngleDeg: 60,
  finishingToolDiaMm: 3.175,
  finishingFlutes: 2,
  finishingGeometry: 'upcut',
  finishingDepthMode: 'auto',
  finishingStepdownMm: 0,
  finishingStepoverPercent: 15,
  finishingFeedrate: 1500,
  finishingPlungeRate: 300,
  finishingDirection: 'x',
  leadInAngleDeg: 15,
  toolBodyClearance: true,
  finishingShankDiaMm: 0,
  finishingFluteLengthMm: 0,
  toolStickoutMm: 0,
  holderDiaMm: 0,
  safeZ: 5.0,
  spindleRpm: 12000,
  material: DEFAULT_MATERIAL,
  motionProfile: DEFAULT_MOTION_PROFILE,
  meshLevelGrid: null,
  applyMeshLeveling: false,
};

export interface ToolpathSegment {
  type: 'roughing' | 'finishing';
  points: { x: number; y: number; z: number }[];
}

export interface ReliefCarveResult {
  success: boolean;
  gcode: string;
  /** Cutting travel in mm — rapids excluded. */
  totalCutDistanceMm: number;
  /** Cutting time plus rapids and plunges, in seconds. */
  estimatedTimeSeconds: number;
  roughingPassCount: number;
  finishingRasterLines: number;
  /** Whether the job stops for a tool change between the two passes. */
  toolChange: boolean;
  /** Plan-view scale actually applied to the model, 1.0 = 1 m per mm. */
  scaleFactor: number;
  /** How deep the relief actually came out, which in 'proportional' mode is not the carve depth. */
  reliefDepthMm: number;
  /**
   * How much the height is stretched relative to the plan, 1 being the model's
   * own proportions. What 'fill' mode leaves implicit.
   */
  verticalExaggeration: number;
  /** Footprint the model occupies on the stock, in machine mm. */
  carveBounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** The stock block itself. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number; minZ: number; maxZ: number };
  /** Decimated toolpath polylines for the 3D preview. */
  segments: ToolpathSegment[];
  warnings: string[];
  error?: string;
}

/** Beyond this the heightmap costs more than the extra fidelity is worth. */
const MAX_HEIGHTMAP_CELLS = 260_000;
/** Stickout, in tool diameters, past which a bit is too whippy to hold a surface. */
const MAX_REACH_DIAMETERS = 4;

/** Cutting length, in diameters, past which long-reach bits stop being a stock item. */
const MAX_AVAILABLE_REACH_DIAMETERS = 8;

/**
 * Shank a bit that size is most likely ground on.
 *
 * Anything under an eighth of an inch is a small cutter on a standard blank —
 * a 1.6 mm bit almost always arrives on a 3.175 mm shank — which is exactly the
 * step that fouls a deep cut. Bigger bits are their own diameter all the way up.
 */
function autoShankDia(diaMm: number): number {
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
function autoFluteLength(diaMm: number, tip?: CutterTip): number {
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
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Diameters a workshop is likely to actually own, metric and imperial mixed. */
const STANDARD_BIT_DIAS = [0.8, 1.0, 1.5, 2.0, 3.0, 3.175, 4.0, 6.0, 6.35];

export interface ReliefToolingInput {
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
  const finishDia =
    STANDARD_BIT_DIAS.find((d) => d >= detailFloor && canReach(d)) ??
    STANDARD_BIT_DIAS.find(canReach) ??
    STANDARD_BIT_DIAS[STANDARD_BIT_DIAS.length - 1];

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
  const feedAt = (rec: ReturnType<typeof speedsFor>) =>
    Math.max(50, Math.round((rec.feedMmMin * (rpm / rec.rpm)) / 10) * 10);

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
    // What the bit has to be, not what a catalogue default is: no step behind
    // the cutter, and enough flute to see the floor.
    finishingShankDiaMm: finishDia,
    finishingFluteLengthMm: round2(Math.max(autoFluteLength(finishDia), depth + 2)),
    finishingStepoverPercent: 12,
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
  >,
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
  // feed scales with however far the speed had to move.
  const roughFeed = Math.max(50, Math.round((rough.feedMmMin * (rpm / rough.rpm)) / 10) * 10);
  const soft = opts.material === 'foam' || opts.material === 'softwood';
  const metal = opts.material === 'aluminium';

  return {
    spindleRpm: rpm,
    finishingFeedrate: finish.feedMmMin,
    finishingPlungeRate: finish.plungeMmMin,
    // A ball nose leaves a scallop of about 1/8 of its radius at this spacing,
    // which sands out; a V-bit's ridge is set by its angle instead, and a flat
    // mill leaves none at all so it can stride out.
    finishingStepoverPercent: 12,
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

/** A finishing point this close to the straight line through its neighbours is noise (mm). */
const PATH_SIMPLIFY_MM = 0.01;
/** How far the simplifier looks ahead before it commits to a point. */
const SIMPLIFY_LOOKAHEAD = 48;
/** Preview vertex budget — past this the viewport, not the mill, is the bottleneck. */
const MAX_PREVIEW_POINTS = 60_000;

function f(num: number): string {
  return num.toFixed(3);
}

// ---------------------------------------------------------------------------
// Heightmap
// ---------------------------------------------------------------------------

/**
 * A part of the tool above its cutting end, as a cylinder.
 *
 * The shank of a small bit is wider than the bit, and the collet nut is wider
 * again; both have to clear the work even though neither cuts. Modelling them
 * as (how far up, how wide) is enough to catch the two ways that goes wrong —
 * the shank rubbing a wall the flutes cleared, and the nut striking something
 * standing proud a centimetre away.
 */
export interface ToolBodySection {
  /** Height of the bottom of this section above the tip of the tool, in mm. */
  aboveTipMm: number;
  /** Radius of this section in mm. */
  radiusMm: number;
}

export interface Heightmap {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cols: number;
  rows: number;
  stepX: number;
  stepY: number;
  /** Surface Z per cell, row-major with row 0 at minY. Stock top is 0. */
  z: Float32Array;
}

/**
 * Samples a heightmap between its cells. Outside the grid it clamps to the
 * edge, which is what the tool dilation below wants at the stock boundary.
 */
export function sampleHeightmap(hm: Heightmap, x: number, y: number): number {
  const fx = Math.min(hm.cols - 1, Math.max(0, (x - hm.minX) / hm.stepX));
  const fy = Math.min(hm.rows - 1, Math.max(0, (y - hm.minY) / hm.stepY));

  const c0 = Math.min(hm.cols - 1, Math.floor(fx));
  const r0 = Math.min(hm.rows - 1, Math.floor(fy));
  const c1 = Math.min(hm.cols - 1, c0 + 1);
  const r1 = Math.min(hm.rows - 1, r0 + 1);

  const tx = fx - c0;
  const ty = fy - r0;

  const z00 = hm.z[r0 * hm.cols + c0];
  const z10 = hm.z[r0 * hm.cols + c1];
  const z01 = hm.z[r1 * hm.cols + c0];
  const z11 = hm.z[r1 * hm.cols + c1];

  return (z00 * (1 - tx) + z10 * tx) * (1 - ty) + (z01 * (1 - tx) + z11 * tx) * ty;
}

/**
 * Drops a vertical ray through every cell and keeps the highest triangle it
 * hits — the model as seen from the spindle.
 *
 * Testing every triangle against every cell is what makes the naive version of
 * this unusable on a real mesh (a 300 x 300 grid against a 20 k triangle model
 * is 1.8 billion tests), so triangles are bucketed by their plan-view bounding
 * box first and each ray only visits its own bucket.
 */
export function buildHeightmap(
  tris: Float64Array,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  cols: number,
  rows: number,
  floorZ: number
): Heightmap {
  const stepX = cols > 1 ? (bounds.maxX - bounds.minX) / (cols - 1) : 0;
  const stepY = rows > 1 ? (bounds.maxY - bounds.minY) / (rows - 1) : 0;
  const z = new Float32Array(cols * rows).fill(floorZ);

  const triCount = tris.length / 9;
  if (triCount === 0) {
    return { ...bounds, cols, rows, stepX, stepY, z };
  }

  // One bucket per few triangles, capped so the index itself stays small.
  const side = Math.max(1, Math.min(128, Math.round(Math.sqrt(triCount / 2))));
  const bw = (bounds.maxX - bounds.minX) / side || 1;
  const bh = (bounds.maxY - bounds.minY) / side || 1;
  const buckets: number[][] = Array.from({ length: side * side }, () => []);

  const bucketCol = (x: number) => Math.min(side - 1, Math.max(0, Math.floor((x - bounds.minX) / bw)));
  const bucketRow = (y: number) => Math.min(side - 1, Math.max(0, Math.floor((y - bounds.minY) / bh)));

  for (let t = 0; t < triCount; t++) {
    const i = t * 9;
    const ax = tris[i], ay = tris[i + 1];
    const bx = tris[i + 3], by = tris[i + 4];
    const cx = tris[i + 6], cy = tris[i + 7];

    // A triangle entirely off the stock can never be hit by a ray we cast.
    if (Math.max(ax, bx, cx) < bounds.minX || Math.min(ax, bx, cx) > bounds.maxX) continue;
    if (Math.max(ay, by, cy) < bounds.minY || Math.min(ay, by, cy) > bounds.maxY) continue;

    const c0 = bucketCol(Math.min(ax, bx, cx));
    const c1 = bucketCol(Math.max(ax, bx, cx));
    const r0 = bucketRow(Math.min(ay, by, cy));
    const r1 = bucketRow(Math.max(ay, by, cy));

    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) buckets[r * side + c].push(i);
    }
  }

  for (let row = 0; row < rows; row++) {
    const py = bounds.minY + row * stepY;
    const br = bucketRow(py);

    for (let col = 0; col < cols; col++) {
      const px = bounds.minX + col * stepX;
      const bucket = buckets[br * side + bucketCol(px)];
      if (bucket.length === 0) continue;

      let best = floorZ;

      for (const i of bucket) {
        const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
        const bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5];
        const cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];

        // Barycentric coordinates of (px, py) in the triangle's plan view.
        const v0x = cx - ax, v0y = cy - ay;
        const v1x = bx - ax, v1y = by - ay;
        const v2x = px - ax, v2y = py - ay;

        const den = v0x * v1y - v1x * v0y;
        if (den === 0) continue; // Edge-on triangle: it has no plan-view area.

        const u = (v2x * v1y - v1x * v2y) / den;
        const v = (v0x * v2y - v2x * v0y) / den;
        if (u < 0 || v < 0 || u + v > 1) continue;

        const hitZ = az + u * (cz - az) + v * (bz - az);
        if (hitZ > best) best = hitZ;
      }

      if (best > floorZ) z[row * cols + col] = best;
    }
  }

  return { ...bounds, cols, rows, stepX, stepY, z };
}

/**
 * Lifts the surface into the height the tool's *tip* has to sit at to graze it
 * without cutting into it anywhere under the cutter — a Minkowski dilation by
 * the tool's own shape.
 *
 * This is the step that decides whether the carve is a carve. Driving the tip
 * straight along the sampled surface gouges every convex feature by up to the
 * tool radius, because the shank cuts material the tip never touched.
 */
export function dilateForTool(
  hm: Heightmap,
  toolRadiusMm: number,
  /**
   * The cutting end's shape. `true`/`false` is the old ball/flat switch, still
   * accepted so that callers and tests that only ever knew about those two
   * shapes read the same.
   */
  tip: boolean | CutterTip,
  body: ToolBodySection[] = []
): Heightmap {
  const shape: CutterShape =
    typeof tip === 'boolean' ? (tip ? 'ball_nose' : 'flat') : tip.shape;
  // Rise per mm of radius on the cone's flank: the tip has to sit this much
  // lower than a point one millimetre out for the flank to just graze it.
  const coneSlope =
    shape === 'v_bit'
      ? 1 / Math.tan(vBitHalfAngleRad(typeof tip === 'boolean' ? 60 : tip.vBitAngleDeg ?? 60))
      : 0;
  const out = new Float32Array(hm.z);
  if (toolRadiusMm <= 0) return { ...hm, z: out };

  // The kernel has to be wide enough for the widest part of the tool, not just
  // the cutting end — the whole point of the body sections is that they stick
  // out past it.
  const reach = Math.max(toolRadiusMm, ...body.map((s) => s.radiusMm));
  const kx = Math.max(1, Math.round(reach / (hm.stepX || reach)));
  const ky = Math.max(1, Math.round(reach / (hm.stepY || reach)));

  // Lift is how far the tip has to sit above a neighbouring cell for the tool
  // to clear it, precomputed per kernel cell.
  //
  // For the cutting end that is the tool's own shape, worked out per shape
  // below.
  //
  // For a body section — the shank above the flutes, the collet nut above that
  // — the section is a cylinder of radius R sitting H above the tip, so the tip
  // may go H *below* whatever that cylinder has to clear: a lift of -H, out to
  // radius R. Sections are wider and higher than the cutter, so they bind
  // exactly where the cutter alone would have said the path was clear.
  //
  // A cell covered by more than one section takes whichever binds hardest,
  // which is the largest lift, so the pass below can stay a plain max.
  const lift = new Float32Array((2 * ky + 1) * (2 * kx + 1)).fill(-Infinity);
  for (let dy = -ky; dy <= ky; dy++) {
    for (let dx = -kx; dx <= kx; dx++) {
      const ox = dx * hm.stepX;
      const oy = dy * hm.stepY;
      const d2 = ox * ox + oy * oy;

      let best = -Infinity;
      if (d2 <= toolRadiusMm * toolRadiusMm) {
        // A ball of radius r touching a point d away rides with its centre at
        // h + sqrt(r^2 - d^2), so its tip is one radius below that. A cone of
        // half-angle t has its flank d/tan(t) above the point, so the tip goes
        // that far below — which is why a V-bit drops into a groove no ball
        // nose of the same nominal size can enter. A flat mill lifts by
        // nothing: its whole flat bottom has to clear the highest point under
        // it.
        if (shape === 'ball_nose') {
          best = Math.sqrt(toolRadiusMm * toolRadiusMm - d2) - toolRadiusMm;
        } else if (shape === 'v_bit') {
          best = -Math.sqrt(d2) * coneSlope;
        } else {
          best = 0;
        }
      }
      for (const s of body) {
        if (d2 <= s.radiusMm * s.radiusMm && -s.aboveTipMm > best) best = -s.aboveTipMm;
      }
      if (best > -Infinity) lift[(dy + ky) * (2 * kx + 1) + (dx + kx)] = best;
    }
  }

  for (let row = 0; row < hm.rows; row++) {
    for (let col = 0; col < hm.cols; col++) {
      let best = -Infinity;

      for (let dy = -ky; dy <= ky; dy++) {
        const r = Math.min(hm.rows - 1, Math.max(0, row + dy));
        for (let dx = -kx; dx <= kx; dx++) {
          const l = lift[(dy + ky) * (2 * kx + 1) + (dx + kx)];
          if (l === -Infinity) continue;
          const c = Math.min(hm.cols - 1, Math.max(0, col + dx));
          const candidate = hm.z[r * hm.cols + c] + l;
          if (candidate > best) best = candidate;
        }
      }

      out[row * hm.cols + col] = best;
    }
  }

  return { ...hm, z: out };
}

// ---------------------------------------------------------------------------
// Path building
// ---------------------------------------------------------------------------

interface PathPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * Thins a raster pass down to the points that carry its shape.
 *
 * A relief raster samples on a fixed grid, so a flat stretch of background
 * arrives as hundreds of identical moves. GRBL only swallows a few hundred
 * lines a second over serial, and a job that streams slower than it cuts stalls
 * the spindle in the cut — so points that sit on the straight line between the
 * ones either side of them are dropped.
 */
function simplifyPass(points: PathPoint[], tolMm: number): PathPoint[] {
  if (points.length <= 2) return points;

  const kept: PathPoint[] = [points[0]];
  let anchor = 0;

  for (let i = 1; i < points.length; i++) {
    const a = points[anchor];
    const b = points[i];
    const spanX = b.x - a.x;
    const spanY = b.y - a.y;
    const span = Math.hypot(spanX, spanY);

    let fits = i - anchor <= SIMPLIFY_LOOKAHEAD;
    if (fits && span > 1e-9) {
      for (let j = anchor + 1; j < i; j++) {
        const p = points[j];
        const t = (Math.hypot(p.x - a.x, p.y - a.y)) / span;
        if (Math.abs(p.z - (a.z + (b.z - a.z) * t)) > tolMm) {
          fits = false;
          break;
        }
      }
    }

    if (!fits) {
      kept.push(points[i - 1]);
      anchor = i - 1;
    }
  }

  kept.push(points[points.length - 1]);
  return kept;
}

/** Sample positions along one axis, inclusive of both ends. */
function axisSamples(from: number, to: number, step: number): number[] {
  if (to <= from) return [(from + to) / 2];
  const count = Math.max(1, Math.ceil((to - from) / step));
  const out: number[] = [];
  for (let i = 0; i <= count; i++) out.push(from + ((to - from) * i) / count);
  return out;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Turns a scene into a relief carving job for a 3-axis CNC router.
 */
export function generateReliefCarveGcode(
  scene: SceneGraph,
  userOptions?: Partial<ReliefCarveOptions>
): ReliefCarveResult {
  const opts: ReliefCarveOptions = { ...DEFAULT_RELIEF_OPTIONS, ...userOptions };
  const warnings: string[] = [];

  const stockW = Math.max(1, opts.stockWidthMm);
  const stockD = Math.max(1, opts.stockDepthMm);
  // Work origin is the stock's near-left corner, top face — the same corner the
  // machine panel tells you to jog to before zeroing, and the same convention the
  // laser and contour exports already use. A centred origin here meant a job
  // zeroed on the corner ran off the stock down and to the left of zero.
  const bounds = {
    minX: 0,
    minY: 0,
    maxX: stockW,
    maxY: stockD,
    minZ: -opts.stockThicknessMm,
    maxZ: 0,
  };

  const empty = (error: string): ReliefCarveResult => ({
    success: false,
    error,
    gcode: '',
    totalCutDistanceMm: 0,
    estimatedTimeSeconds: 0,
    roughingPassCount: 0,
    finishingRasterLines: 0,
    toolChange: false,
    scaleFactor: 1,
    reliefDepthMm: 0,
    verticalExaggeration: 1,
    carveBounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    bounds,
    segments: [],
    warnings,
  });

  const { tris: sceneTris, skipped, warnings: sceneWarnings } = collectSceneTriangles(scene);
  warnings.push(...sceneWarnings);
  if (skipped.length > 0) {
    warnings.push(`Skipped (no solid volume to carve): ${skipped.join(', ')}.`);
  }
  if (sceneTris.length === 0) {
    return empty('No solid geometry found in the scene to carve.');
  }

  const carveDepth = Math.max(0.1, opts.carveDepthMm);

  // These all turn on how deep the relief actually ends up, which in
  // proportional mode is not the depth that was asked for, so they are defined
  // here and called once `reliefDepth` is known.
  //
  // A cutter has to reach the floor of the relief with its flutes, not its
  // shank, and it goes soft long before it runs out of flute: bending stiffness
  // falls with the cube of stickout and the fourth power of diameter, so a bit
  // held four diameters out of the collet is already a wire. Catalogue flute
  // lengths for straight bits run about three diameters, so four is the point
  // past which no stock bit that size can do the job at all.
  const reachWarn = (
    dia: number,
    shankDia: number,
    fluteLen: number,
    which: string,
    tip?: CutterTip
  ) => {
    // Two different problems, and a bit can have either without the other.
    //
    // The geometric one is a shank fatter than the cutter having to follow it
    // into the cut. A necked or long-reach bit does not have it at all, which is
    // why this asks about the shank rather than about the depth. It is only
    // raised when nothing is going to account for it, because with shank
    // clearance on the path is held out of the wall instead.
    const shank = shankDia > 0 ? shankDia : autoShankDia(dia);
    const flutes = fluteLen > 0 ? fluteLen : autoFluteLength(dia, tip);
    if (!opts.toolBodyClearance && shank > dia + 1e-6 && reliefDepth > flutes) {
      warnings.push(
        `The ${dia} mm ${which} bit has about ${flutes.toFixed(1)} mm of flute on a ` +
          `${shank.toFixed(3)} mm shank, and the relief is ${reliefDepth.toFixed(1)} mm deep, so the shank will be ` +
          `in the cut. Shank clearance is off, so nothing in this path allows for that. A long-reach ` +
          `or necked bit — one whose shank is no wider than its cutting diameter — has no step to foul.`
      );
    }

    // A V-bit is a solid cone rather than a slender cylinder, so the bending
    // rule below does not describe it. What does limit it is where the cone
    // stops: past the point it reaches its nominal diameter there is only
    // shank, so a relief deeper than that is being cut by the shank whatever
    // the catalogue says the bit is for.
    if (tip?.shape === 'v_bit') {
      const cone = vBitConeHeight(dia, tip.vBitAngleDeg ?? 60);
      if (reliefDepth > cone + 1e-6) {
        warnings.push(
          `The ${dia} mm ${tip.vBitAngleDeg ?? 60}\u00b0 V-bit only cuts for the ` +
            `${cone.toFixed(1)} mm it takes the cone to reach full diameter, and the relief is ` +
            `${reliefDepth.toFixed(1)} mm deep. Below that it is the shank in the cut. Use a wider ` +
            `bit, a narrower point angle, or rough the depth out first and leave the V-bit the ` +
            `detail near the surface.`
        );
      }
      return;
    }

    // The stiffness one is unavoidable at any depth: bending goes with the cube
    // of stickout, so a bit hung this far out chatters and wanders whatever its
    // shank looks like.
    const ratio = reliefDepth / Math.max(0.05, dia);
    if (ratio > MAX_REACH_DIAMETERS) {
      warnings.push(
        `A ${reliefDepth.toFixed(1)} mm relief is ${ratio.toFixed(1)} diameters of stickout for the ` +
          `${dia} mm ${which} bit. Stiffness falls with the cube of that, so expect chatter and ` +
          `wander. A bit of ${(reliefDepth / MAX_REACH_DIAMETERS).toFixed(1)} mm or more, or a ` +
          `shallower relief, is what makes it rigid.`
      );
    }
  };

  /** The finishing cutter's end, as the dilation and the warnings both see it. */
  const finishTip: CutterTip = {
    shape: opts.finishingToolType,
    vBitAngleDeg: opts.finishingVBitAngleDeg,
  };

  // The raster is inset by the finishing tool's radius so the cutter stays over
  // the stock, which is also the area a fitted model has to land inside.
  const finishRad = Math.max(0.05, opts.finishingToolDiaMm / 2);
  const stepover = Math.max(
    0.05,
    (opts.finishingToolDiaMm * Math.min(50, Math.max(2, opts.finishingStepoverPercent))) / 100
  );
  const usableW = Math.max(1, stockW - 2 * finishRad);
  const usableD = Math.max(1, stockD - 2 * finishRad);

  // --- Fit the model onto the stock -----------------------------------------
  // Scene units are metres; 1 m maps to 1000 mm before any user scaling.
  let mnX = Infinity, mnY = Infinity, mnZ = Infinity;
  let mxX = -Infinity, mxY = -Infinity, mxZ = -Infinity;
  for (let i = 0; i < sceneTris.length; i += 3) {
    const x = sceneTris[i] * 1000;
    const y = sceneTris[i + 1] * 1000;
    const z = sceneTris[i + 2] * 1000;
    if (x < mnX) mnX = x;
    if (x > mxX) mxX = x;
    if (y < mnY) mnY = y;
    if (y > mxY) mxY = y;
    if (z < mnZ) mnZ = z;
    if (z > mxZ) mxZ = z;
  }

  const modelW = mxX - mnX;
  const modelD = mxY - mnY;
  const modelH = mxZ - mnZ;
  if (modelW <= 1e-6 || modelD <= 1e-6) {
    return empty('The scene has no plan-view area, so there is no surface to carve.');
  }
  if (modelH <= 1e-6) {
    return empty('The scene is flat along Z, so a relief of it would be a flat pocket.');
  }

  const fitScale = Math.min(usableW / modelW, usableD / modelD);
  const scaleFactor = opts.fitMode === 'fit' ? fitScale : Math.max(0.01, opts.scalePercent / 100);

  if (opts.fitMode === 'manual' && scaleFactor > fitScale * 1.0001) {
    warnings.push(
      `At ${opts.scalePercent}% the model is ${(modelW * scaleFactor).toFixed(0)} x ` +
        `${(modelD * scaleFactor).toFixed(0)} mm and overhangs the stock — anything past the edge is ` +
        `cropped. It fits at ${(fitScale * 100).toFixed(0)}%.`
    );
  }

  // --- How deep the model gets carved ---------------------------------------
  // 'fill' stretches the model's whole height range onto the carve depth, so the
  // relief is always exactly as deep as asked for whatever the plan scale does.
  // That is what makes a relief a relief — carved true, terrain is a flat board
  // — but it means Z is not on the same scale as X and Y, and shrinking the plan
  // to fit small stock silently exaggerates the height by the same factor.
  //
  // 'proportional' puts Z on the plan scale, so the model keeps the shape it was
  // authored with however it is fitted, and the exaggeration is a number the
  // user sets rather than one that falls out of the stock size. Carve depth stops
  // being a target and becomes a limit.
  const proportional = opts.verticalScaleMode === 'proportional';
  const exaggeration = Math.max(0.01, opts.verticalExaggeration);
  const zScale = proportional ? scaleFactor * exaggeration : carveDepth / modelH;
  const wantedDepth = modelH * zScale;
  const reliefDepth = Math.min(carveDepth, wantedDepth);

  if (proportional && wantedDepth > carveDepth + 1e-6) {
    warnings.push(
      `At ${(scaleFactor * 100).toFixed(0)}% plan scale and ${exaggeration}x exaggeration the model ` +
        `wants ${wantedDepth.toFixed(1)} mm of depth, more than the ${carveDepth} mm allowed, so ` +
        `everything below that is flattened onto the floor. Raise the relief depth or drop the ` +
        `exaggeration to ${(carveDepth / (modelH * scaleFactor)).toFixed(2)}x.`
    );
  }

  if (reliefDepth > opts.stockThicknessMm - 1) {
    warnings.push(
      `A ${reliefDepth.toFixed(1)} mm relief in ${opts.stockThicknessMm} mm stock leaves under 1 mm ` +
        `underneath. Cut the relief depth, or use thicker stock.`
    );
  }
  reachWarn(
    opts.finishingToolDiaMm,
    opts.finishingShankDiaMm,
    opts.finishingFluteLengthMm,
    'finishing',
    finishTip
  );
  if (opts.roughingEnabled) {
    reachWarn(opts.roughingToolDiaMm, 0, 0, 'roughing');
  }

  // --- What the cutter's own specification implies --------------------------
  //
  // Flute count and helix direction are not labels on a drop-down. They are two
  // of the three numbers that decide whether the feed rate in this file is a
  // cut or a rub, and where the chips end up once it is.

  const material = materialSpec(opts.material);

  /** Feed, RPM and flutes are one quantity seen three ways; check the third. */
  const chiploadWarn = (feed: number, flutes: number, which: string, dia: number) => {
    const chip = chiploadMm(feed, opts.spindleRpm, flutes);
    // The band is the material's own, scaled to the bit. A generic one is worse
    // than useless here: 0.05 mm a tooth is a healthy chip in pine and roughly
    // four times what a cutter should be taking in aluminium.
    const ideal = material.chiploadPerDia * dia;
    const floor = ideal * 0.25;
    const ceiling = ideal * 2;
    if (chip < floor) {
      warnings.push(
        `${feed} mm/min at ${opts.spindleRpm} RPM on ${Math.max(1, Math.round(flutes))} flutes is ` +
          `${chip.toFixed(4)} mm of chip per tooth on the ${which} tool, against the ` +
          `${ideal.toFixed(3)} mm a ${dia} mm cutter wants in ${material.label.toLowerCase()}. ` +
          `Below about ${floor.toFixed(3)} mm the edge rubs instead of cutting, which is what ` +
          `dulls a bit and burns the work. Feed faster, drop the spindle speed, or use a cutter ` +
          `with fewer flutes.`
      );
    } else if (chip > ceiling) {
      warnings.push(
        `${feed} mm/min at ${opts.spindleRpm} RPM on ${Math.max(1, Math.round(flutes))} flutes is ` +
          `${chip.toFixed(3)} mm of chip per tooth on the ${which} tool, past the ` +
          `${ceiling.toFixed(3)} mm a ${dia} mm cutter will take in ${material.label.toLowerCase()}. ` +
          `Expect deflection, a poor finish and a broken bit. Slow the feed or raise the spindle.`
      );
    }
  };

  // The spindle speed itself, which on these machines is a dial nobody is
  // prompted to turn. Checked against surface speed rather than left implicit
  // in the chipload, because "your feed is wrong" and "your dial is wrong" want
  // different actions from the operator.
  {
    const ideal = (material.surfaceSpeedMMin * 1000) / (Math.PI * Math.max(0.1, opts.finishingToolDiaMm));
    const capped = material.maxRpm !== undefined ? Math.min(ideal, material.maxRpm) : ideal;
    if (opts.spindleRpm > capped * 1.6) {
      warnings.push(
        `${opts.spindleRpm.toLocaleString()} RPM is well above the ` +
          `${Math.round(capped / 500) * 500} RPM a ${opts.finishingToolDiaMm} mm cutter wants in ` +
          `${material.label.toLowerCase()}` +
          (material.maxRpm !== undefined
            ? ` — this material melts rather than wears, so the excess goes into the cut as heat.`
            : ` — the edge is travelling faster than it can clear a chip, which burns the work and blunts the bit.`)
      );
    } else if (opts.spindleRpm < capped * 0.45) {
      warnings.push(
        `${opts.spindleRpm.toLocaleString()} RPM is well below the ` +
          `${Math.round(capped / 500) * 500} RPM a ${opts.finishingToolDiaMm} mm cutter wants in ` +
          `${material.label.toLowerCase()}. A cutter turning too slowly takes too big a bite per ` +
          `tooth and deflects, which shows up as chatter marks across the finish.`
      );
    }
  }

  chiploadWarn(opts.finishingFeedrate, opts.finishingFlutes, 'finishing', opts.finishingToolDiaMm);
  if (opts.roughingEnabled) {
    chiploadWarn(opts.roughingFeedrate, opts.roughingFlutes, 'roughing', opts.roughingToolDiaMm);
  }

  /** What the helix direction means for a pocket this deep. */
  const geometryWarn = (geometry: CutterGeometry, dia: number, which: string) => {
    if (geometry === 'downcut' && reliefDepth > dia * 2) {
      warnings.push(
        `A downcut ${which} bit presses its chips into the bottom of the cut, and this relief is ` +
          `${(reliefDepth / dia).toFixed(1)} diameters deep. The chips have nowhere to go, so the ` +
          `cut packs, heats and burns. Downcut is the right choice for a clean top edge on thin ` +
          `stock, not for clearing depth — use an upcut to rough and keep the downcut for the ` +
          `finishing sweep if the top face is what matters.`
      );
    }
    if (geometry === 'compression' && reliefDepth < 6) {
      warnings.push(
        `A compression ${which} bit is upcut for its first few millimetres and downcut above. ` +
          `This relief never leaves that lower section, so it will behave exactly as an upcut — ` +
          `the tool is doing nothing a plain upcut would not, at several times the price.`
      );
    }
    if (geometry === 'straight' && reliefDepth > dia * 3) {
      warnings.push(
        `A straight-flute ${which} bit has no helix to move chips either way, so a cut ` +
          `${(reliefDepth / dia).toFixed(1)} diameters deep relies entirely on dust extraction to ` +
          `clear itself. Take shallower passes, or fit a helical cutter.`
      );
    }
  };

  geometryWarn(opts.finishingGeometry, opts.finishingToolDiaMm, 'finishing');
  if (opts.roughingEnabled) {
    geometryWarn(opts.roughingGeometry, opts.roughingToolDiaMm, 'roughing');
  }

  // A downcut cutter is at its very worst going straight down: the direction it
  // throws waste is the direction it is trying to travel.
  if (opts.finishingGeometry === 'downcut' && opts.leadInAngleDeg <= 0) {
    warnings.push(
      `The finishing bit is a downcut and the lead-in angle is 0, so every pass starts with a ` +
        `vertical plunge. That is the one move a downcut cutter cannot make — it packs its own ` +
        `chips under the tip. Set a lead-in of 10-20 degrees.`
    );
  }

  // What the finishing stepover actually leaves behind between passes. This is
  // the number people mean by "how smooth will it be", and for a V-bit it is
  // not the ball-nose arithmetic the stepover box implies.
  const half = stepover / 2;
  const ridgeMm =
    opts.finishingToolType === 'flat'
      ? 0
      : opts.finishingToolType === 'v_bit'
        ? half / Math.tan(vBitHalfAngleRad(opts.finishingVBitAngleDeg))
        : half >= finishRad
          ? finishRad
          : finishRad - Math.sqrt(finishRad * finishRad - half * half);
  if (ridgeMm > 0.2) {
    warnings.push(
      `A ${stepover.toFixed(2)} mm stepover with this cutter leaves ${ridgeMm.toFixed(2)} mm ridges ` +
        `between passes on a flat area — that is sanding, not a finish. ` +
        (opts.finishingToolType === 'v_bit'
          ? `A V-bit's ridge is set by its point angle: a wider angle, or a smaller stepover, ` +
            `brings it down.`
          : `Drop the stepover, or fit a larger-diameter ball nose.`)
    );
  }

  // Model centre lands on the stock centre; the model's highest point lands on
  // the stock's top face, and its lowest on the floor of the relief.
  const cx = (mnX + mxX) / 2;
  const cy = (mnY + mxY) / 2;
  const floorZ = -reliefDepth;

  // Centre of the stock in work coordinates, which with a corner origin is half
  // the stock rather than zero.
  const stockCx = stockW / 2;
  const stockCy = stockD / 2;

  const tris = new Float64Array(sceneTris.length);
  for (let i = 0; i < sceneTris.length; i += 3) {
    tris[i] = (sceneTris[i] * 1000 - cx) * scaleFactor + stockCx;
    tris[i + 1] = (sceneTris[i + 1] * 1000 - cy) * scaleFactor + stockCy;
    tris[i + 2] = (sceneTris[i + 2] * 1000 - mxZ) * zScale;
  }

  const carveBounds = {
    minX: Math.max(bounds.minX, stockCx - (modelW * scaleFactor) / 2),
    minY: Math.max(bounds.minY, stockCy - (modelD * scaleFactor) / 2),
    maxX: Math.min(bounds.maxX, stockCx + (modelW * scaleFactor) / 2),
    maxY: Math.min(bounds.maxY, stockCy + (modelD * scaleFactor) / 2),
  };

  // --- Sample the surface ----------------------------------------------------
  let res = Math.min(stepover, 0.6);
  let cols = Math.ceil(stockW / res) + 1;
  let rows = Math.ceil(stockD / res) + 1;
  if (cols * rows > MAX_HEIGHTMAP_CELLS) {
    const shrink = Math.sqrt((cols * rows) / MAX_HEIGHTMAP_CELLS);
    res *= shrink;
    cols = Math.ceil(stockW / res) + 1;
    rows = Math.ceil(stockD / res) + 1;
    warnings.push(
      `Surface sampled every ${res.toFixed(2)} mm — the stock is too large to sample at the ` +
        `${stepover.toFixed(2)} mm stepover. Detail finer than that is smoothed out.`
    );
  }

  // Cells the model does not cover are marked, not floored, so that a model
  // whose own lowest face sits exactly on the floor is not mistaken for bare
  // background and left uncut.
  const surface = buildHeightmap(tris, bounds, cols, rows, -Infinity);
  const backgroundZ = opts.backgroundMode === 'skip' ? 0 : floorZ;
  if (opts.invertRelief) {
    for (let i = 0; i < surface.z.length; i++) {
      if (surface.z[i] === -Infinity) {
        surface.z[i] = backgroundZ;
      } else {
        const clampedZ = Math.max(floorZ, Math.min(0, surface.z[i]));
        surface.z[i] = -reliefDepth - clampedZ;
      }
    }
  } else {
    for (let i = 0; i < surface.z.length; i++) {
      if (surface.z[i] === -Infinity) surface.z[i] = backgroundZ;
      else if (surface.z[i] < floorZ) surface.z[i] = floorZ;
    }
  }

  // --- What the rest of the tool needs to clear ------------------------------
  // Small bits come on a shank fatter than the bit — a 1.6 mm cutter is ground
  // on a 3.175 mm blank — and catalogue cutting lengths sit around three
  // diameters. Those two are properties of the bit and can be guessed. The
  // stickout and the size of the nut are properties of how the user set the job
  // up, so those are only checked when they say.
  const bodyFor = (
    dia: number,
    shankDia: number,
    fluteLen: number,
    tip?: CutterTip
  ): ToolBodySection[] => {
    if (!opts.toolBodyClearance) return [];
    const sections: ToolBodySection[] = [];
    const shank = shankDia > 0 ? shankDia : autoShankDia(dia);
    const flutes = fluteLen > 0 ? fluteLen : autoFluteLength(dia, tip);
    if (shank > dia + 1e-6) sections.push({ aboveTipMm: flutes, radiusMm: shank / 2 });
    if (opts.holderDiaMm > 0 && opts.toolStickoutMm > 0) {
      sections.push({ aboveTipMm: opts.toolStickoutMm, radiusMm: opts.holderDiaMm / 2 });
    }
    return sections;
  };

  const finishBody = bodyFor(
    opts.finishingToolDiaMm,
    opts.finishingShankDiaMm,
    opts.finishingFluteLengthMm,
    finishTip
  );
  const finishMap = dilateForTool(surface, finishRad, finishTip, finishBody);

  // How much of the relief the tool's own body puts out of reach. Left silent
  // this reads as a carve that simply came out shallow, so it is measured
  // against the same pass with the body ignored and reported.
  if (finishBody.length > 0) {
    const bare = dilateForTool(surface, finishRad, finishTip);
    let blocked = 0;
    let carved = 0;
    let worst = 0;
    for (let i = 0; i < finishMap.z.length; i++) {
      if (bare.z[i] >= -1e-6) continue;
      carved++;
      const lost = finishMap.z[i] - bare.z[i];
      if (lost > 0.1) blocked++;
      if (lost > worst) worst = lost;
    }
    if (carved > 0 && blocked / carved > 0.02) {
      warnings.push(
        `The ${opts.finishingToolDiaMm} mm bit's shank or holder cannot reach into ` +
          `${((100 * blocked) / carved).toFixed(0)}% of the relief, up to ${worst.toFixed(1)} mm ` +
          `short of the surface, so the path is lifted clear and that material is left standing. ` +
          `A longer-reach bit, a shallower relief, or turning off shank clearance under Advanced ` +
          `are the ways out — the last one will cut it, by dragging the shank through the wall.`
      );
    }
  }

  const segments: ToolpathSegment[] = [];
  const gcode: string[] = [];
  let cutDistance = 0;

  // Where the tool is, so a path can be built relative to it. The clock used to
  // be kept here as well, as distance over feedrate; it is now taken off the
  // finished program by `estimateGcodeTime`, which plans acceleration the way
  // the controller does instead of pretending every move runs at its feed.
  let atX = 0;
  let atY = 0;
  let atZ = opts.safeZ;

  const rapidTo = (x: number, y: number, z: number) => {
    atX = x; atY = y; atZ = z;
  };
  const plungeTo = (z: number) => {
    atZ = z;
  };
  const cutTo = (x: number, y: number, z: number) => {
    cutDistance += Math.hypot(x - atX, y - atY, z - atZ);
    atX = x; atY = y; atZ = z;
  };

  const leadInTan = Math.tan(
    (Math.max(0, Math.min(89, opts.leadInAngleDeg)) * Math.PI) / 180
  );

  /**
   * Puts the cutter at the head of a pass, entering along the path rather than
   * straight down into it.
   *
   * A vertical plunge asks the centre of the tool to do the cutting, and the
   * centre of an end mill is where its edges meet at zero surface speed with
   * nowhere for a chip to go. It is the move that snaps small cutters, and the
   * deeper the layer the harder it pulls. Descending at a shallow angle along
   * the pass makes the entry an ordinary cut instead.
   *
   * The ramp runs forward to the ramp length and then back to the head of the
   * pass at full depth, so the wedge of material it left behind is taken off
   * before the pass proper starts over it. Where the run is too short to ramp
   * into — or the angle is set to zero — it plunges, which is what it had to do
   * anyway.
   *
   * `entryZ` is the height the material stands at when the pass begins: the
   * stock's top face on the first layer, the level the previous layer left on
   * every one after it.
   */
  const leadIn = (path: PathPoint[], entryZ: number, rate: number) => {
    const head = path[0];
    const approachZ = Math.min(opts.safeZ, entryZ + 0.5);
    rapidTo(head.x, head.y, approachZ);
    gcode.push(`G0 X${f(head.x)} Y${f(head.y)}`);
    if (approachZ < opts.safeZ - 1e-6) gcode.push(`G0 Z${f(approachZ)}`);

    const plunge = () => {
      plungeTo(head.z);
      gcode.push(`G1 Z${f(head.z)} F${Math.round(rate)}`);
    };

    const drop = entryZ - head.z;
    if (leadInTan <= 0 || drop <= 1e-6) return plunge();

    // Half the run, so the ramp and its return both fit inside the pass.
    let pathLen = 0;
    for (let i = 1; i < path.length; i++) {
      pathLen += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    }
    const rampLen = Math.min(drop / leadInTan, pathLen / 2);
    if (rampLen < 0.1) return plunge();

    // Walk the pass until the ramp length is used up, splitting the segment it
    // ends inside. Each stop keeps the pass's own Z so the return leg can cut to
    // the real surface rather than to a straight line under it.
    const walk: { x: number; y: number; pz: number; d: number }[] = [];
    let travelled = 0;
    for (let i = 1; i < path.length && travelled < rampLen; i++) {
      const seg = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
      if (seg <= 1e-9) continue;
      if (travelled + seg <= rampLen) {
        walk.push({ x: path[i].x, y: path[i].y, pz: path[i].z, d: travelled + seg });
      } else {
        const t = (rampLen - travelled) / seg;
        walk.push({
          x: path[i - 1].x + (path[i].x - path[i - 1].x) * t,
          y: path[i - 1].y + (path[i].y - path[i - 1].y) * t,
          pz: path[i - 1].z + (path[i].z - path[i - 1].z) * t,
          d: rampLen,
        });
      }
      travelled += seg;
    }
    if (walk.length === 0) return plunge();

    // Down the ramp, never below the surface the pass is tracing.
    for (const w of walk) {
      const z = Math.max(w.pz, entryZ - drop * (w.d / rampLen));
      cutTo(w.x, w.y, z);
      gcode.push(`G1 X${f(w.x)} Y${f(w.y)} Z${f(z)} F${Math.round(rate)}`);
    }
    // Back to the head at full depth, clearing what the ramp rode over.
    for (let i = walk.length - 2; i >= 0; i--) {
      cutTo(walk[i].x, walk[i].y, walk[i].pz);
      gcode.push(`G1 X${f(walk[i].x)} Y${f(walk[i].y)} Z${f(walk[i].pz)}`);
    }
    cutTo(head.x, head.y, head.z);
    gcode.push(`G1 X${f(head.x)} Y${f(head.y)} Z${f(head.z)}`);
  };

  gcode.push('; ---------------------------------------------------------------');
  gcode.push('; 3D CNC Relief Carving');
  gcode.push(`; Stock       : ${stockW} x ${stockD} x ${opts.stockThicknessMm} mm`);
  gcode.push(`; Relief depth: ${reliefDepth.toFixed(2)} mm below the top face`);
  gcode.push(`; Model scale : ${(scaleFactor * 100).toFixed(1)}% (${(modelW * scaleFactor).toFixed(1)} x ${(modelD * scaleFactor).toFixed(1)} mm)`);
  gcode.push(`; Height      : ${(zScale / Math.max(1e-9, scaleFactor)).toFixed(1)}x the plan scale`);
  gcode.push('; Origin      : near-left corner of the stock, top face, Z0');
  if (opts.roughingEnabled) {
    gcode.push(
      `; T1 rough    : ${describeCutter(opts.roughingToolDiaMm, 'flat', opts.roughingFlutes, opts.roughingGeometry)}`
    );
  }
  gcode.push(`; Material    : ${material.label}`);
  gcode.push(
    `; T2 finish   : ${describeCutter(
      opts.finishingToolDiaMm,
      opts.finishingToolType,
      opts.finishingFlutes,
      opts.finishingGeometry,
      opts.finishingVBitAngleDeg
    )}`
  );
  gcode.push(`; Extents     : X0..${f(stockW)}  Y0..${f(stockD)} (all cuts are +X +Y of zero)`);
  gcode.push('; ---------------------------------------------------------------');
  gcode.push('G21 ; millimetres');
  gcode.push('G90 ; absolute positioning');
  gcode.push('G94 ; feed per minute');
  gcode.push(`G0 Z${f(opts.safeZ)}`);
  // Written out as its own line because on a router with a dial rather than a
  // controlled spindle the `S` word below does nothing at all, and this comment
  // is the only place the number appears in a form anybody reads.
  gcode.push(
    `; SET THE SPINDLE TO ${Math.round(opts.spindleRpm).toLocaleString('en-GB')} RPM ` +
      `before starting — the S word is ignored by a hand-dialled router`
  );
  gcode.push(`M3 S${Math.round(opts.spindleRpm)} ; spindle on`);
  gcode.push('G4 P2 ; let the spindle come up to speed');

  // --- Roughing --------------------------------------------------------------
  let roughingPassCount = 0;
  const roughRad = Math.max(0.05, opts.roughingToolDiaMm / 2);
  const allowance = Math.max(0, opts.roughingAllowanceMm);

  if (opts.roughingEnabled) {
    const roughMap = dilateForTool(surface, roughRad, false, bodyFor(opts.roughingToolDiaMm, 0, 0));
    const stepdown = Math.max(0.1, opts.roughingStepdownMm);
    const roughStepover = Math.max(0.2, opts.roughingToolDiaMm * 0.45);

    // Deepest the roughing tool is allowed to go: the allowance above the
    // lowest point it can reach at all.
    let deepest = 0;
    for (let i = 0; i < roughMap.z.length; i++) {
      if (roughMap.z[i] < deepest) deepest = roughMap.z[i];
    }
    const roughFloor = deepest + allowance;

    const layers: number[] = [];
    for (let z = -stepdown; z > roughFloor + 1e-6; z -= stepdown) layers.push(z);
    if (roughFloor < -1e-6) layers.push(roughFloor);
    roughingPassCount = layers.length;

    if (layers.length > 0) {
      gcode.push('; --- OP 1: roughing ---------------------------------------------');
      // Named as a flat end mill because that is what the roughing path is
      // planned as: it is dilated with a flat bottom, so a ball nose fitted
      // here would leave the corners of every layer uncut, and the job would
      // silently be roughing to the wrong depth. The tool number goes in the
      // header rather than out on the wire as a bare `T1`, because a Marlin
      // build reads that as "select extruder 1" and errors on it.
      gcode.push(
        `; T1: ${describeCutter(opts.roughingToolDiaMm, 'flat', opts.roughingFlutes, opts.roughingGeometry)}, ` +
          `${stepdown} mm stepdown, ${allowance} mm left on`
      );
    }

    const xs = axisSamples(bounds.minX + roughRad, bounds.maxX - roughRad, res);
    const ys = axisSamples(bounds.minY + roughRad, bounds.maxY - roughRad, roughStepover);

    for (const layerZ of layers) {
      let forward = true;

      for (const y of ys) {
        const lineXs = forward ? xs : [...xs].reverse();
        forward = !forward;

        // A run is the stretch of this line where there is still material below
        // the layer height and the tool can reach it without gouging.
        let run: PathPoint[] = [];
        const flushRun = () => {
          if (run.length >= 2) {
            const last = run[run.length - 1];
            // The layer above is what the tool is dropping through, so that is
            // where the ramp starts — one stepdown, not the whole depth so far.
            leadIn([run[0], last], Math.min(0, layerZ + stepdown), opts.roughingPlungeRate);

            cutTo(last.x, last.y, layerZ);
            gcode.push(`G1 X${f(last.x)} Y${f(last.y)} F${Math.round(opts.roughingFeedrate)}`);
            gcode.push(`G0 Z${f(opts.safeZ)}`);
            atZ = opts.safeZ;

            // One segment per run: the preview must not draw a line across the
            // gap the tool actually flew over at safe height.
            segments.push({ type: 'roughing', points: [run[0], run[run.length - 1]] });
          }
          run = [];
        };

        for (const x of lineXs) {
          const target = sampleHeightmap(roughMap, x, y) + allowance;
          if (target <= layerZ - 1e-6) run.push({ x, y, z: layerZ });
          else flushRun();
        }
        flushRun();
      }
    }
  }

  // --- Tool change -----------------------------------------------------------
  const toolChange =
    opts.roughingEnabled && Math.abs(opts.roughingToolDiaMm - opts.finishingToolDiaMm) > 0.01;
  if (toolChange) {
    gcode.push('M5 ; spindle off for the tool change');
    gcode.push(`G0 Z${f(Math.max(opts.safeZ, 20))}`);
    gcode.push(
      `T2 M6 ; fit the ${describeCutter(
        opts.finishingToolDiaMm,
        opts.finishingToolType,
        opts.finishingFlutes,
        opts.finishingGeometry,
        opts.finishingVBitAngleDeg
      )} and re-zero Z`
    );
    gcode.push(`M3 S${Math.round(opts.spindleRpm)}`);
    gcode.push('G4 P2');
    atZ = Math.max(opts.safeZ, 20);
  }

  // --- Finishing -------------------------------------------------------------
  // How much depth one sweep of the raster is allowed to take. With roughing on
  // there is only the allowance left to remove, so the whole surface comes off
  // in one sweep. With roughing off the finishing tool is clearing the entire
  // relief, and a raster that dives to the floor of a 20 mm pocket on its first
  // move buries the cutter to the shank. So it layers, the same way roughing
  // does: repeat the raster at successively lower depth limits, each one taking
  // at most a stepdown, and let the sweep that first reaches a given point cut
  // it to its final height.
  const layerFinishing =
    opts.finishingDepthMode === 'layered' ||
    (opts.finishingDepthMode === 'auto' && !opts.roughingEnabled);
  const finishStepdown = !layerFinishing
    ? Infinity
    : opts.finishingStepdownMm > 0
      ? opts.finishingStepdownMm
      : Math.max(0.2, opts.finishingToolDiaMm);

  let finishDeepest = 0;
  for (let i = 0; i < finishMap.z.length; i++) {
    if (finishMap.z[i] < finishDeepest) finishDeepest = finishMap.z[i];
  }
  finishDeepest = Math.max(floorZ, finishDeepest);

  // Descending depth limits; the last one is below every point on the surface,
  // so that sweep traces the real thing everywhere it has not already been cut.
  const finishLimits: number[] = [];
  if (Number.isFinite(finishStepdown)) {
    for (let z = -finishStepdown; z > finishDeepest + 1e-6; z -= finishStepdown) {
      finishLimits.push(z);
    }
  }
  finishLimits.push(finishDeepest);

  if (finishLimits.length > 1) {
    warnings.push(
      `The finishing pass clears the full ${reliefDepth.toFixed(1)} mm on its own, so it runs as ` +
        `${finishLimits.length} layered sweeps of at most ${finishStepdown.toFixed(2)} mm each. ` +
        `A roughing pass with a bigger bit would be much faster.`
    );
  } else if (!opts.roughingEnabled && reliefDepth > MAX_REACH_DIAMETERS * opts.finishingToolDiaMm) {
    // Asked for explicitly, so it is emitted — but a single sweep with nothing
    // ahead of it means the first move into the stock goes to the floor.
    warnings.push(
      `One depth-first sweep with no roughing ahead of it takes the ${opts.finishingToolDiaMm} mm bit ` +
        `to the full ${reliefDepth.toFixed(1)} mm on its first entry. Layer the finishing pass, or rough first, ` +
        `unless you know this cutter can take it.`
    );
  }

  gcode.push('; --- OP 2: finishing raster -------------------------------------');
  gcode.push(
    `; ${describeCutter(
      opts.finishingToolDiaMm,
      opts.finishingToolType,
      opts.finishingFlutes,
      opts.finishingGeometry,
      opts.finishingVBitAngleDeg
    )}, ` +
      `${stepover.toFixed(2)} mm stepover along ${opts.finishingDirection.toUpperCase()}` +
      (finishLimits.length > 1
        ? `, ${finishLimits.length} layers of ${finishStepdown.toFixed(2)} mm`
        : '')
  );

  const alongX = opts.finishingDirection === 'x';
  // The sweep runs the full width of the stock; the passes step across it.
  const sweep = axisSamples(
    (alongX ? bounds.minX : bounds.minY) + finishRad,
    (alongX ? bounds.maxX : bounds.maxY) - finishRad,
    res
  );
  const across = axisSamples(
    (alongX ? bounds.minY : bounds.minX) + finishRad,
    (alongX ? bounds.maxY : bounds.maxX) - finishRad,
    stepover
  );

  let finishingRasterLines = 0;
  let forward = true;
  // The height the material stands at when a layer starts: the stock's top face
  // for the first, whatever the layer before it left for the rest.
  let prevLimit = 0;

  for (const limit of finishLimits) {
    if (finishLimits.length > 1) {
      gcode.push(`; layer down to Z${f(limit)}`);
    }

    for (const a of across) {
      const line = forward ? sweep : [...sweep].reverse();
      forward = !forward;

      // `surface` is where the pass ends up; `z` is as far as this layer is
      // allowed to go towards it. A point the layer above already took to its
      // surface is finished, and is left out of this layer entirely — which is
      // what stops the raster re-tracing the whole background on every layer.
      const raw: PathPoint[] = [];
      for (const s of line) {
        const x = alongX ? s : a;
        const y = alongX ? a : s;
        const surface = Math.min(0, Math.max(floorZ, sampleHeightmap(finishMap, x, y)));
        const done = surface >= prevLimit - 1e-6;
        raw.push({ x, y, z: done ? 0 : Math.max(surface, limit) });
      }

      // Stretches where the tool would only skim the stock's own top face have
      // no material under them. Flying over them instead of tracing them is what
      // keeps a small model on a big board from costing a full-board raster.
      const runs: PathPoint[][] = [];
      let run: PathPoint[] = [];
      for (const p of raw) {
        if (p.z < -1e-6) run.push(p);
        else if (run.length > 0) { runs.push(run); run = []; }
      }
      if (run.length > 0) runs.push(run);

      for (const r of runs) {
        const pass = simplifyPass(r, PATH_SIMPLIFY_MM);
        if (pass.length < 2) continue;
        finishingRasterLines++;

        leadIn(pass, Math.min(0, prevLimit), opts.finishingPlungeRate);

        // GRBL keeps the last feedrate, so it is only stated when it changes.
        let first = true;
        for (let i = 1; i < pass.length; i++) {
          const p = pass[i];
          cutTo(p.x, p.y, p.z);
          gcode.push(
            `G1 X${f(p.x)} Y${f(p.y)} Z${f(p.z)}${first ? ` F${Math.round(opts.finishingFeedrate)}` : ''}`
          );
          first = false;
        }

        gcode.push(`G0 Z${f(opts.safeZ)}`);
        atZ = opts.safeZ;
        segments.push({ type: 'finishing', points: pass });
      }
    }

    prevLimit = limit;
  }

  if (finishingRasterLines === 0) {
    return empty('The chosen stock and stepover produced no finishing passes.');
  }

  gcode.push('; ---------------------------------------------------------------');
  gcode.push('M5 ; spindle off');
  gcode.push(`G0 Z${f(opts.safeZ)}`);
  gcode.push('G0 X0 Y0 ; back to the work origin');
  gcode.push('M30 ; end of program');

  let text = gcode.join('\n');
  if (opts.applyMeshLeveling && opts.meshLevelGrid) {
    text = warpGcode(text, opts.meshLevelGrid);
  }

  // Preview only needs the shape of the path, and a raster has far more points
  // than a viewport can usefully draw.
  const totalPreview = segments.reduce((n, s) => n + s.points.length, 0);
  const stride = Math.max(1, Math.ceil(totalPreview / MAX_PREVIEW_POINTS));
  const previewSegments =
    stride === 1
      ? segments
      : segments.map((s) => {
          const points = s.points.filter((_, i) => i % stride === 0);
          const last = s.points[s.points.length - 1];
          if (points[points.length - 1] !== last) points.push(last);
          return { type: s.type, points };
        });

  return {
    success: true,
    gcode: text,
    totalCutDistanceMm: cutDistance,
    // Timed from the finished program rather than from the path builder's own
    // running totals. Those totals were distance over feedrate, which on a
    // raster of tens of thousands of short reversing moves is out by a factor
    // of several: the machine never gets close to the programmed feed before it
    // has to brake for the end of the scanline. `estimateGcodeTime` runs the
    // controller's own trapezoidal plan over the moves, and counts the lead-in
    // ramps, the retracts and the mesh-levelling subdivision that the running
    // totals never saw at all.
    estimatedTimeSeconds: estimateGcodeTime(text, { profile: opts.motionProfile }).seconds,
    roughingPassCount,
    finishingRasterLines,
    toolChange,
    scaleFactor,
    reliefDepthMm: reliefDepth,
    verticalExaggeration: zScale / Math.max(1e-9, scaleFactor),
    carveBounds,
    bounds,
    segments: previewSegments,
    warnings,
  };
}
