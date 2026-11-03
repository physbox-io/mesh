// Cuts a surface into the top of a block: the program round the roughing and
// finishing passes, and the numbers about it.

import { materialSpec } from './feedsAndSpeeds';
import { warpGcode } from './meshLeveler';
import { dilateForTool, sampleHeightmap, toolTipHeightAt } from './reliefHeightmap';
import { MAX_PREVIEW_POINTS, f } from './reliefPaths';
import { describeCutter } from './reliefTooling';
import { WALL_SLOPE } from './finishingPaths';
import { estimateGcodeTime } from './timeEstimate';
import { bodyFor, centreWindow, type SurfaceJob, type SurfaceMachiningResult } from './surfaceJob';
import { finishingCutter, warnAboutTooling } from './surfaceToolingWarnings';
import { ToolpathWriter } from './toolpathWriter';
import { roughSurface } from './surfaceRoughing';
import { finishSurface } from './surfaceFinishing';
import type { ReliefCarveOptions } from './reliefOptions';

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
  const surface = job.surface;
  const res = job.resolution;
  const floorZ = -depthMm;

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
  const { finishTip, finishRad, stepover } = finishingCutter(opts);
  const material = materialSpec(opts.material);

  const finishBody = bodyFor(
    opts,
    opts.finishingToolDiaMm,
    opts.finishingShankDiaMm,
    opts.finishingFluteLengthMm,
    finishTip
  );
  const finishMap = dilateForTool(surface, finishRad, finishTip, finishBody);
  // For points between the samples (a waterline's), read under the cutter
  // itself rather than off the dilated grid.
  const finishTipAt = toolTipHeightAt(surface, finishRad, finishTip, finishBody);
  /*
   * Where a waterline point can stand at its level. The line is traced on the
   * dilated grid and the cutter is checked under itself, and the two can put
   * a wall a fraction of a cell apart. Where the check finds the cutter in the
   * wall, the point steps downhill, off the wall, until it is clear: a
   * waterline keeps its height and gives up a little of its line. Climbing the
   * wall instead, at every such point, was 287 m of vertical travel on one
   * side of a 100 mm cylinder. Only a point with no clear spot within a cell
   * is lifted.
   */
  const wallRise = WALL_SLOPE * Math.min(finishMap.stepX || Infinity, finishMap.stepY || Infinity);
  /**
   * Whether the dilated grid has a wall across the cell a point is in: the
   * only cells where the line was placed by the half-way rule rather than by
   * the grid's own reading, so the only ones the cutter has to be checked in.
   */
  const inWallCell = (x: number, y: number) => {
    const fx = (x - finishMap.minX) / (finishMap.stepX || 1), fy = (y - finishMap.minY) / (finishMap.stepY || 1);
    const c = Math.min(finishMap.cols - 2, Math.max(0, Math.floor(fx)));
    const r = Math.min(finishMap.rows - 2, Math.max(0, Math.floor(fy)));
    const k = r * finishMap.cols + c, z = finishMap.z;
    const a = z[k], b = z[k + 1], cc = z[k + finishMap.cols], d = z[k + finishMap.cols + 1];
    return Math.max(a, b, cc, d) - Math.min(a, b, cc, d) > wallRise;
  };
  const passRect = centreWindow(job, finishRad);

  const holdOffWall = (p: { x: number; y: number }, level: number) => {
    if (!inWallCell(p.x, p.y) || finishTipAt(p.x, p.y) <= level + 1e-3) return { x: p.x, y: p.y, z: level };
    const gx = sampleHeightmap(finishMap, p.x + res / 2, p.y) - sampleHeightmap(finishMap, p.x - res / 2, p.y);
    const gy = sampleHeightmap(finishMap, p.x, p.y + res / 2) - sampleHeightmap(finishMap, p.x, p.y - res / 2);
    const g = Math.hypot(gx, gy);
    if (g > 1e-9) {
      for (let k = 1; k <= 8; k++) {
        const d = (res * k) / 8;
        const x = p.x - (gx / g) * d, y = p.y - (gy / g) * d;
        // Never off the edge of the stock the tool centre is kept inside.
        if (x < passRect.minX || x > passRect.maxX || y < passRect.minY || y > passRect.maxY) break;
        if (finishTipAt(x, y) <= level + 1e-3) return { x, y, z: level };
      }
    }
    return { x: p.x, y: p.y, z: Math.max(level, finishTipAt(p.x, p.y)) };
  };

  // How much of the ${noun} the tool's own body puts out of reach. Left silent
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
        `Shank/holder clearance lifted the ${opts.finishingToolDiaMm} mm toolpath over ${((100 * blocked) / carved).toFixed(0)}% of the ${noun} (up to ${worst.toFixed(1)} mm above the surface). Use a longer-reach bit, reduce depth, or disable shank clearance in Advanced.`
      );
    }
  }

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
  if (toolChange) {
    // Out of the cut before the spindle stops, and in the air before it
    // starts again: a spindle stopped in the work drags its bit, and one
    // started at touch-off height spins the new bit up on the stock. Mesh's
    // own streamer retracts on resume, but another sender runs this as written.
    w.gcode.push(`G0 Z${f(Math.max(opts.safeZ, 20))}`);
    w.gcode.push('M5 ; spindle off for the tool change');
    /*
     * Over the work origin for the change, not over the pocket roughing
     * happened to finish in: the corner is where the operator reaches the
     * collet from and touches the new bit off.
     *
     * The path planner is not told. The finishing order still starts from
     * where roughing finished - planned from the corner instead, the dome's
     * finishing lifted 73 times against 56 - and the flight from the corner
     * to its first run is at the change height, over everything.
     */
    w.gcode.push('G0 X0 Y0 ; park over the work origin');
    w.gcode.push(
      `T2 M6 ; fit the ${describeCutter(
        opts.finishingToolDiaMm,
        opts.finishingToolType,
        opts.finishingFlutes,
        opts.finishingGeometry,
        opts.finishingVBitAngleDeg
      )} and re-zero Z`
    );
    // Back up to the travel height, said out loud rather than assumed.
    //
    // Everything after this point traverses at whatever Z it thinks the tool is
    // already at, and emits no Z word when it believes it is high enough. But a
    // tool change ends with the operator having jogged the tip down onto the
    // work to touch off the new bit, so what the file assumes and where the
    // machine is standing are as far apart as they ever get — and the next
    // traverse would be a rapid across the job at the surface of it.
    w.gcode.push(`G0 Z${f(Math.max(opts.safeZ, 20))} ; back to travel height after the change`);
    w.gcode.push(`M3 S${Math.round(opts.spindleRpm)}`);
    w.gcode.push('G4 P2');
    w.atX = 0;
    w.atY = 0;
    w.atZ = Math.max(opts.safeZ, 20);
  }

  // --- Finishing -------------------------------------------------------------
  let finishingRasterLines = 0;
  if (opts.finishingEnabled) {
    const finished = finishSurface(
      w,
      opts,
      { finishMap, passRect, holdOffWall, finishRad, stepover, floorZ, depthMm, res },
      materialLevelAt,
      warnings
    );
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
