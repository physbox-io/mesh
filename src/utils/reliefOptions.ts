// Options, results and shared types of the relief carve and solid machining exporters.

import type { ProbeGrid } from './meshLeveler';
import type { Undercut } from './reliefHeightmap';
import type { FinishingStrategy } from './finishingPaths';
import { DEFAULT_MOTION_PROFILE, type MotionProfile } from './motionProfile';
import { DEFAULT_MATERIAL, type MaterialId } from './feedsAndSpeeds';


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
   *
   * 'model' cuts the model exactly as it was modelled: 1:1 in X, Y and Z,
   * centred on the stock, as deep as the lowest point a cutter coming straight
   * down can see. `carveDepthMm`, `fitMode`, `scalePercent` and the
   * exaggeration are all ignored, because the model already says every one of
   * them. This is what a part designed to the size of its board wants — a tray,
   * a sign, a plate with a pattern on its face.
   *
   * 'auto' is 'model' when the model fits the stock (footprint, and depth with
   * a millimetre under it) and 'fill' when it does not, saying so.
   */
  verticalScaleMode: 'fill' | 'proportional' | 'model' | 'auto';
  /**
   * Height stretch applied in 'proportional' mode. 1 keeps the model's own
   * proportions; terrain usually wants more, because true-scale terrain over a
   * map-sized plan is a flat board.
   */
  verticalExaggeration: number;
  /** 'fit' scales the model to the stock; 'manual' honours `scalePercent`. */
  fitMode: 'fit' | 'manual';
  /** Plan-view scale when `fitMode` is 'manual', as a percentage of the modelled size (100 = 1:1). */
  scalePercent: number;
  /**
   * What to do with the stock the model does not cover. 'carve' takes the
   * background down to the floor so the model stands proud of it; 'skip' leaves
   * it at full stock height and only cuts where the model actually dips.
   * 'auto' is 'skip' for a model cut at its own size (the stock round it is
   * the stock, not part of the design) and 'carve' otherwise. Cameo only: an
   * intaglio leaves the stock round its impression at full height.
   */
  backgroundMode: 'carve' | 'skip' | 'auto';
  /**
   * Cut right through the stock, this far into the spoilboard, in mm. Zero
   * keeps the usual 1 mm of stock under the deepest cut.
   *
   * With it set, the relief goes the stock's full thickness plus this, and
   * the holes in the model -- the places inside its footprint with no surface
   * at all -- are cut to that floor whatever `backgroundMode` says, since a
   * hole is the point of a through-cut and not background. Cameo only: an
   * intaglio ignores it, with a warning.
   */
  cutThroughMm?: number;
  /**
   * Through-cuts only: leave tabs bridging any piece the cut would set loose,
   * so it is held to the board instead of thrown. On by default.
   */
  holdingTabs?: boolean;
  /** Tab thickness above the bottom of the stock, mm. */
  tabHeightMm?: number;
  /** Tab length along the slot, mm. */
  tabWidthMm?: number;
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
  /**
   * How the roughing tool gets through each slab of waste.
   *
   * 'raster' sweeps back and forth in parallel lines. Simple, and the stepover
   * describes the bite only in the middle of a long straight line: every time a
   * line meets a concave part of the boundary or crosses a narrow channel the
   * tool is suddenly cutting full width. The stepdown then has to be set for
   * that worst case and paid for over the whole job.
   *
   * 'adaptive' walks the region's own contours instead, outermost ring first,
   * so every ring but the first has open air on its outer side and the bite
   * really is the stepover — in corners too. With the spike gone the stepdown
   * goes up several times over, which is where the time is saved.
   */
  roughingStrategy: 'raster' | 'adaptive';
  /**
   * Radial bite for the roughing pass, mm. Zero derives one from the strategy:
   * 45% of the cutter for a raster, and for an adaptive clear whatever bite
   * between 20% and 30% clears the depth in the fewest passes — see
   * `adaptiveBiteFraction`.
   */
  roughingStepoverMm: number;
  /** Roughing cut feedrate in mm/min. */
  roughingFeedrate: number;
  /** Z plunge rate in mm/min. */
  roughingPlungeRate: number;
  /** Material left on the surface for the finishing pass to take off, in mm. */
  roughingAllowanceMm: number;
  /**
   * Run the finishing pass at all.
   *
   * Off, the roughing bit cuts straight to the surface with no allowance and
   * the job ends there: flat tops and floors exactly as the flat mill leaves
   * them, and every sloped wall stepped by the roughing layers. On a pattern
   * that is flat-topped anyway — a giraffe hide, a brick course, a terrace
   * model — that is the finished piece, in a fraction of the time the ball
   * nose would take to smooth walls nobody is looking at. Needs roughing on.
   */
  finishingEnabled: boolean;
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
  /** Which axis the finishing passes sweep along. The base angle for a raster. */
  finishingDirection: 'x' | 'y';
  /**
   * How the finishing passes are laid out in plan: a parallel raster, a
   * crosshatch, rings, a spiral, a waterline, or the hybrid of waterline and
   * raster that picks whichever suits each part of the surface.
   *
   * A raster is the cheapest to cut and the one whose direction you can see in
   * the finished surface. Everything else here trades cutting time for a
   * surface that does not carry a single direction across the whole model. See
   * utils/finishingPaths.ts.
   *
   * Defaults to 'hybrid': a raster terraces every wall that runs along its
   * passes, and a relief has walls running every way.
   */
  finishingStrategy: FinishingStrategy;
  /**
   * Raster angle in degrees from +X, for the strategies that use one. Undefined
   * takes the angle from `finishingDirection`, so 0 for 'x' and 90 for 'y'.
   *
   * An angle is not a cosmetic choice on wood: passes running across the grain
   * tear it, and 45 degrees is the usual compromise when a feature's long axis
   * and the grain do not agree.
   */
  finishingAngleDeg?: number;
  /**
   * Slope, in degrees from horizontal, at which the hybrid strategy hands over
   * from raster to waterline. Ignored by every other strategy.
   */
  finishingSteepAngleDeg: number;
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
  cutThroughMm: 0,
  holdingTabs: true,
  tabHeightMm: 2,
  tabWidthMm: 6,
  invertRelief: false,
  roughingEnabled: true,
  roughingToolDiaMm: 6.35,
  roughingFlutes: 2,
  roughingGeometry: 'upcut',
  roughingStepdownMm: 2.0,
  roughingStrategy: 'adaptive',
  roughingStepoverMm: 0,
  roughingFeedrate: 1200,
  roughingPlungeRate: 300,
  roughingAllowanceMm: 0.5,
  finishingEnabled: true,
  finishingToolType: 'ball_nose',
  finishingVBitAngleDeg: 60,
  finishingToolDiaMm: 3.175,
  finishingFlutes: 2,
  finishingGeometry: 'upcut',
  finishingDepthMode: 'auto',
  finishingStepdownMm: 0,
  // A ball nose at a quarter of its diameter leaves a scallop of 3% of its
  // radius: 0.05 mm on a 3.175 mm ball, which wood does not show and a sanding
  // block takes off. The old 15% left a third of that and took nearly twice as
  // long to do it.
  finishingStepoverPercent: 25,
  finishingFeedrate: 1500,
  finishingPlungeRate: 300,
  finishingDirection: 'x',
  // Hybrid, not raster. A raster only leaves a smooth wall where the passes
  // cross it; a wall running along the passes is built from neighbouring
  // passes at different heights and comes out terraced, by the stepover times
  // the tangent of the slope. A relief has walls facing every way, so half of
  // them terrace. Hybrid hands anything steeper than the cutover to a
  // waterline and costs nothing on flat ground, where it is a plain raster.
  finishingStrategy: 'hybrid',
  finishingSteepAngleDeg: 35,
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

/**
 * What the app starts a relief from: the model cut at its own size when it
 * fits the stock, scaled to fit when it does not.
 *
 * Kept apart from `DEFAULT_RELIEF_OPTIONS`, which stays on 'fill' because a
 * great deal of code and every older test calls the exporter with a model of
 * no particular size and expects it fitted. The dialog and the MCP export lay
 * this over the defaults before the scene's own carve settings.
 */
export const APP_RELIEF_DEFAULTS: Pick<ReliefCarveOptions, 'verticalScaleMode' | 'backgroundMode'> = {
  verticalScaleMode: 'auto',
  backgroundMode: 'auto',
};

export interface ToolpathSegment {
  type: 'roughing' | 'finishing';
  points: { x: number; y: number; z: number }[];
  /**
   * The height the tool flew at to reach this pass.
   *
   * Written by the exporter because the preview cannot work it out: it is not
   * `safeZ` any more but a clearance plane over whatever actually stands
   * between the previous pass and this one, and the preview's run-time estimate
   * is only honest if it models the same hop the machine will make.
   */
  traverseZ?: number;
}

/**
 * Where the model went on the stock:
 *
 *   work = scale * (rotation . (model - modelOrigin)) + workOrigin
 *
 * per axis, the model in the scene's Z-up millimetres and work in the
 * program's. A relief scales X and Y alike and Z by its own factor and turns
 * nothing; a solid part is turned onto its side A.
 */
export interface StockTransform {
  /** Row-major 3x3. Absent is the identity. */
  rotation?: number[];
  modelOriginMm: [number, number, number];
  workOriginMm: [number, number, number];
  scale: [number, number, number];
  /** The model's own extent, before any of the above. */
  modelMinMm: [number, number, number];
  modelMaxMm: [number, number, number];
}

export interface ReliefCarveResult {
  success: boolean;
  gcode: string;
  /** Cutting travel in mm — rapids excluded. */
  totalCutDistanceMm: number;
  /** Cutting time plus rapids and plunges, in seconds. */
  estimatedTimeSeconds: number;
  /**
   * How much of that is the roughing pass. Said separately because the split is
   * the first sign of a roughing pass that is leaving the work to the finisher.
   */
  roughingTimeSeconds: number;
  roughingPassCount: number;
  /** The radial bite roughing actually took, as a percentage of its cutter. */
  roughingBitePercent: number;
  finishingRasterLines: number;
  /** Whether the job stops for a tool change between the two passes. */
  toolChange: boolean;
  /** Plan-view scale actually applied to the model, 1.0 = 1 m per mm. */
  scaleFactor: number;
  /** How deep the relief actually came out, which in 'proportional' mode is not the carve depth. */
  reliefDepthMm: number;
  /** The narrowest valley in the relief, in mm; see `measureDetailMm`. */
  detailMm?: number;
  /**
   * How much the height is stretched relative to the plan, 1 being the model's
   * own proportions. What 'fill' mode leaves implicit.
   */
  verticalExaggeration: number;
  /** The height mode actually used, with 'auto' resolved. */
  heightMode?: 'fill' | 'proportional' | 'model';
  /**
   * Material a cutter coming straight down cannot reach: the space under an
   * overhang, a leaning slot's far wall. It is left solid. Absent when there is
   * none worth mentioning.
   */
  undercut?: Undercut;
  /** Footprint the model occupies on the stock, in machine mm. */
  carveBounds: { minX: number; minY: number; maxX: number; maxY: number };
  /**
   * What Frame Job traces when the cut runs past the board edge (a groove open
   * at the model's edge): the footprint, grown out to the cutter's reach on
   * those sides. Absent when the cut stays on the board.
   */
  frameBounds?: { minX: number; minY: number; maxX: number; maxY: number };
  /** The stock block itself. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number; minZ: number; maxZ: number };
  /** How the model was put on the stock, so a simulated cut can be put back on the model. */
  stockTransform?: StockTransform;
  /** Decimated toolpath polylines for the 3D preview. */
  segments: ToolpathSegment[];
  warnings: string[];
  error?: string;
}
