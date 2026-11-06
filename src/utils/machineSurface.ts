// Cuts a surface into the top of a block: the program round the roughing and
// finishing passes, and the numbers about it.

import { materialSpec } from './feedsAndSpeeds';
import { interpolateGridZ, warpGcode } from './meshLeveler';
import { MAX_PREVIEW_POINTS, f } from './reliefPaths';
import { describeCutter } from './reliefTooling';
import { estimateGcodeTime } from './timeEstimate';
import type { SurfaceJob, SurfaceMachiningResult } from './surfaceJob';
import { warnAboutTooling } from './surfaceToolingWarnings';
import { ToolpathWriter } from './toolpathWriter';
import { roughSurface } from './surfaceRoughing';
import { finishSurface } from './surfaceFinishing';
import { chooseTouchSpot } from './touchSpot';
import type { ReliefCarveOptions } from './reliefOptions';

/** How far short of a depth a program may stop and still be said to reach it, mm. */
const REACH_TOLERANCE_MM = 0.05;

/**
 * Cuts a surface into the top of a block: roughing layers, a tool change, and
 * the finishing passes, as one program.
 *
 * This is the half of a relief carve that has nothing to do with reliefs. It
 * takes a heightmap and the tooling and writes the G-code that machines it,
 * which is the same job whether the heightmap is a squashed landscape or one
 * face of a solid part — so the relief exporter and the solid machining
 * exporter share it rather than each carrying a copy.
 *
 * Every warning it raises goes onto the `warnings` it is handed, after
 * whatever the caller has already put there.
 */
export function machineSurface(
  job: SurfaceJob,
  opts: ReliefCarveOptions,
  warnings: string[]
): SurfaceMachiningResult {
  const noun = job.noun ?? 'relief';
  const depthMm = job.depthMm;
  const bounds = job.bounds;

  const fail = (error: string): SurfaceMachiningResult => ({
    success: false,
    error,
    gcode: '',
    totalCutDistanceMm: 0,
    estimatedTimeSeconds: 0,
    roughingTimeSeconds: 0,
    roughingPassCount: 0,
    finishingRasterLines: 0,
    toolChange: false,
    roughingBitePercent: 0,
    segments: [],
  });

  warnAboutTooling(opts, depthMm, noun, warnings);
  const material = materialSpec(opts.material);

  const w = new ToolpathWriter(opts, bounds);

  w.gcode.push('; ---------------------------------------------------------------');
  for (const line of job.header) w.gcode.push(line);
  if (opts.roughingEnabled) {
    w.gcode.push(
      `; T1 rough    : ${describeCutter(opts.roughingToolDiaMm, 'flat', opts.roughingFlutes, opts.roughingGeometry)}`
    );
  }
  w.gcode.push(`; Material    : ${material.label}`);
  if (opts.finishingEnabled) {
    w.gcode.push(
      `; T2 finish   : ${describeCutter(
        opts.finishingToolDiaMm,
        opts.finishingToolType,
        opts.finishingFlutes,
        opts.finishingGeometry,
        opts.finishingVBitAngleDeg
      )}`
    );
  } else {
    w.gcode.push('; Finishing   : none — roughing goes to the surface in layers, so slopes come out stepped');
  }
  w.gcode.push('; ---------------------------------------------------------------');
  w.gcode.push('G21 ; millimetres');
  w.gcode.push('G90 ; absolute positioning');
  w.gcode.push('G94 ; feed per minute');
  w.gcode.push(`G0 Z${f(opts.safeZ)}`);
  // Written out as its own line because on a router with a dial rather than a
  // controlled spindle the `S` word below does nothing at all, and this comment
  // is the only place the number appears in a form anybody reads.
  w.gcode.push(`; Spindle: ${Math.round(opts.spindleRpm)} RPM`);
  w.gcode.push(`M3 S${Math.round(opts.spindleRpm)} ; spindle on`);
  w.gcode.push('G4 P2 ; let the spindle come up to speed');
  // Whatever the caller wants done first — registration holes, say.
  for (const line of job.prelude ?? []) w.gcode.push(line);

  if (!opts.finishingEnabled && !opts.roughingEnabled) {
    return fail('The finishing pass is off, so roughing has to be on: one of them has to cut.');
  }

  const { roughingPassCount, roughingBitePercent, materialLevelAt } = roughSurface(w, job, opts);

  // --- Tool change -----------------------------------------------------------
  /*
   * Whether the operator has to fit a different bit between the two passes.
   *
   * Diameter alone is not the question, and asking only that is how a job
   * carves its roughing pass with the right cutter and then rasters the
   * finishing pass with it too. Roughing is always a flat end mill, so a
   * ball-nose or a V-bit finisher is a different tool no matter how wide it
   * is — and a 6 mm end mill followed by a 6 mm V-bit is exactly the case that
   * used to slip through, because the two diameters are identical. It is also
   * the case that matters most: a V-bit finisher is chosen for detail the
   * roughing cutter physically cannot reach, so running the raster with the
   * roughing bit still fitted throws away the whole point of the second pass
   * while looking, from the outside, like the job completed.
   *
   * Flute count and helix are here for the same reason. They mean a different
   * cutter in the collet even at the same diameter, and the feeds for the
   * finishing pass were derived for that cutter and not for the one still in
   * the spindle.
   */
  const toolChange =
    opts.finishingEnabled &&
    opts.roughingEnabled &&
    (Math.abs(opts.roughingToolDiaMm - opts.finishingToolDiaMm) > 0.01 ||
      opts.finishingToolType !== 'flat' ||
      Math.round(opts.roughingFlutes) !== Math.round(opts.finishingFlutes) ||
      opts.roughingGeometry !== opts.finishingGeometry);
  // Where the finishing block starts, and what Z0 means from there on.
  let afterChange = -1;
  let touchZ = 0;
  if (toolChange) {
    // Clear of everything standing, the levelling grid's crown included, and
    // no higher: an un-homed machine lifts no further than this at the M6, and
    // this is the height it has been seen to reach.
    const changeZ = Math.max(opts.safeZ, 20) + w.levellingSpanMm;
    const spot = chooseTouchSpot(
      w.stock,
      job.touchOff?.area ?? job.bounds,
      Math.max(0.05, opts.finishingToolDiaMm / 2),
      job.touchOff?.standsAt
    );
    if (!spot) {
      return fail('Roughing leaves nothing flat to zero the finishing bit on: finish with the roughing bit, or raise the allowance.');
    }
    // Out of the cut before the spindle stops, and in the air before it
    // starts again: a spindle stopped in the work drags its bit, and one
    // started at touch-off height spins the new bit up on the stock. Mesh's
    // own streamer retracts on resume, but another sender runs this as written.
    w.gcode.push(`G0 Z${f(changeZ)}`);
    w.gcode.push('M5 ; spindle off for the tool change');
    /*
     * Over ground the new bit can be zeroed on, so the operator need not jog
     * there. The stock's top face where any of it is left; where roughing took
     * all of that, a roughing floor, whose height the rest of the program is
     * rewritten for below, so that Z0 there is right.
     *
     * The levelling grid moves the ground at the spot as well: a touch-off
     * there takes the grid's height with it, which the warp below would then
     * add a second time.
     *
     * The path planner is not told. The finishing order is still planned from
     * the work origin - planned from the spot, a 100 mm dome on a 140 mm board
     * took 5473 s against 5383 - and the flight from the spot to its first run
     * is at the change height, over everything.
     */
    w.gcode.push(`G0 X${f(spot.x)} Y${f(spot.y)}`);
    w.gcode.push(
      `T2 M6 ; fit the ${describeCutter(
        opts.finishingToolDiaMm,
        opts.finishingToolType,
        opts.finishingFlutes,
        opts.finishingGeometry,
        opts.finishingVBitAngleDeg
      )} and re-zero Z`
    );
    afterChange = w.gcode.length;
    touchZ =
      spot.levelMm +
      (opts.applyMeshLeveling && opts.meshLevelGrid ? interpolateGridZ(opts.meshLevelGrid, spot.x, spot.y) : 0);
    // Back up to the travel height, said out loud rather than assumed.
    //
    // Everything after this point traverses at whatever Z it thinks the tool is
    // already at, and emits no Z word when it believes it is high enough. But a
    // tool change ends with the operator having jogged the tip down onto the
    // work to touch off the new bit, so what the file assumes and where the
    // machine is standing are as far apart as they ever get — and the next
    // traverse would be a rapid across the job at the surface of it.
    w.gcode.push(`G0 Z${f(changeZ)} ; back to travel height after the change`);
    w.gcode.push(`M3 S${Math.round(opts.spindleRpm)}`);
    w.gcode.push('G4 P2');
    w.atX = 0;
    w.atY = 0;
    w.atZ = changeZ;
  }

  // --- Finishing -------------------------------------------------------------
  let finishingRasterLines = 0;
  if (opts.finishingEnabled) {
    const finished = finishSurface(w, job, opts, materialLevelAt, warnings);
    if (finished.error !== undefined) return fail(finished.error);
    finishingRasterLines = finished.finishingRasterLines;
  } else if (roughingPassCount === 0) {
    return fail('Nothing cuts: the finishing pass is off and roughing produced no passes.');
  }

  w.gcode.push('; ---------------------------------------------------------------');
  w.gcode.push(`G0 Z${f(opts.safeZ)}`);
  w.gcode.push('M5 ; spindle off, clear of the work');
  w.gcode.push('G0 X0 Y0 ; back to the work origin');
  w.gcode.push('M30 ; end of program');

  if (job.mustReachMm !== undefined && -w.deepestZ < job.mustReachMm - REACH_TOLERANCE_MM) {
    return fail(
      `The bit stops at ${(-w.deepestZ).toFixed(1)} mm of the ${job.mustReachMm.toFixed(1)} mm this cut has to reach: ` +
        'fit a longer bit, or a narrower one where the channel is tight.'
    );
  }

  // Finishing is planned against the stock's top face throughout, as the stock
  // model is: only the words on the wire move to the Z0 the new bit was set to.
  if (afterChange >= 0 && Math.abs(touchZ) >= 5e-4) {
    for (let i = afterChange; i < w.gcode.length; i++) {
      w.gcode[i] = w.gcode[i].replace(/\bZ(-?\d+(?:\.\d+)?)/g, (_, z) => `Z${f(parseFloat(z) - touchZ)}`);
    }
  }

  let text = w.gcode.join('\n');
  if (opts.applyMeshLeveling && opts.meshLevelGrid) {
    text = warpGcode(text, opts.meshLevelGrid);
  }
  // Where the finishing pass starts, after any levelling warp, so the
  // roughing share is timed off the same program the machine will run.
  const finishingStart = text.indexOf('; --- OP 2: finishing');

  // Preview only needs the shape of the path, and a raster has far more points
  // than a viewport can usefully draw.
  const totalPreview = w.segments.reduce((n, s) => n + s.points.length, 0);
  const stride = Math.max(1, Math.ceil(totalPreview / MAX_PREVIEW_POINTS));
  const previewSegments =
    stride === 1
      ? w.segments
      : w.segments.map((s) => {
          const points = s.points.filter((_, i) => i % stride === 0);
          const last = s.points[s.points.length - 1];
          if (points[points.length - 1] !== last) points.push(last);
          return { ...s, points };
        });
  return {
    success: true,
    gcode: text,
    totalCutDistanceMm: w.cutDistance,
    // Timed from the finished program rather than from the path builder's own
    // running totals. Those totals were distance over feedrate, which on a
    // raster of tens of thousands of short reversing moves is out by a factor
    // of several: the machine never gets close to the programmed feed before it
    // has to brake for the end of the scanline. `estimateGcodeTime` runs the
    // controller's own trapezoidal plan over the moves, and counts the lead-in
    // ramps, the retracts and the mesh-levelling subdivision that the running
    // totals never saw at all.
    estimatedTimeSeconds: estimateGcodeTime(text, { profile: opts.motionProfile }).seconds,
    roughingTimeSeconds: roughingPassCount > 0
      ? estimateGcodeTime(text.slice(0, finishingStart >= 0 ? finishingStart : text.length), { profile: opts.motionProfile }).seconds
      : 0,
    roughingPassCount,
    roughingBitePercent,
    finishingRasterLines,
    toolChange,
    segments: previewSegments,
  };
}
