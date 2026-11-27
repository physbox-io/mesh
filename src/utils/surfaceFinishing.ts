// The finishing pass of a surface job: the strategy's passes, layered where
// the finishing tool clears on its own, cut nearest first and linked along the
// surface where that is safe.

import {
  WALL_SLOPE,
  describeFinishingStrategy,
  finishingPassGroups,
  waterlineLevel,
  type FinishingStrategy,
} from './finishingPaths';
import { dilateForTool, sampleHeightmap, toolTipHeightAt } from './reliefHeightmap';
import { DEFAULT_RELIEF_OPTIONS, vBitHalfAngleRad, type ReliefCarveOptions } from './reliefOptions';
import {
  PATH_SIMPLIFY_MM,
  f,
  higherWaterlinesNear,
  simplifyPass,
  squareUpWalls,
  type PathPoint,
} from './reliefPaths';
import { MAX_REACH_DIAMETERS, describeCutter, stepdownFractionFor } from './reliefTooling';
import { bodyHold } from './bodyHold';
import { exactWalls } from './exactWalls';
import { FLAT_PROFILE, ballProfile, vProfile } from './stockModel';
import { bodyFor, centreWindow, type SurfaceJob } from './surfaceJob';
import { finishingCutter } from './surfaceToolingWarnings';
import type { ToolpathWriter } from './toolpathWriter';

/**
 * Writes the finishing pass onto `w`. `materialLevelAt` is what roughing left
 * standing; a pass is entered from that height rather than the stock's face.
 */
export function finishSurface(
  w: ToolpathWriter,
  job: SurfaceJob,
  opts: ReliefCarveOptions,
  materialLevelAt: (x: number, y: number) => number,
  warnings: string[]
): { finishingRasterLines: number; error?: undefined } | { error: string } {
  const { surface, depthMm, resolution: res } = job;
  const floorZ = -depthMm;
  const noun = job.noun ?? 'relief';
  const { finishTip, finishRad, stepover } = finishingCutter(opts);

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

  // Where the job knows the surface exactly, a flat bit's waterlines go on
  // the walls themselves (see `exactWalls`).
  const exact = opts.finishingToolType === 'flat' ? exactWalls(job, finishRad, passRect) : null;

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
      const flutes = opts.finishingFluteLengthMm > 0
        ? opts.finishingFluteLengthMm
        : finishBody[0]?.aboveTipMm ?? 0;
      warnings.push(
        `Shank/holder clearance lifted the ${opts.finishingToolDiaMm} mm toolpath over ${((100 * blocked) / carved).toFixed(0)}% of the ${noun} (up to ${worst.toFixed(1)} mm above the surface; assumed ${flutes.toFixed(1)} mm reach). Set Flute Length in Advanced to your bit's actual cutting length, use a longer-reach bit, or disable shank clearance.`
      );
    }
  }

  let finishingRasterLines = 0;
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
  const autoStepdown =
    opts.finishingStepdownMm > 0
      ? opts.finishingStepdownMm
      : Math.max(0.2, opts.finishingToolDiaMm * stepdownFractionFor(opts.material));
  const finishStepdown = !layerFinishing ? Infinity : autoStepdown;
  // When roughing ran with a larger cutter, inside corners, narrow valleys,
  // and the stock's outer border still stand at full height. In 'auto' mode,
  // step those local unroughed patches down in place before the final sweep.
  const restLayering =
    !layerFinishing &&
    opts.finishingDepthMode === 'auto' &&
    opts.roughingEnabled &&
    opts.finishingToolDiaMm < opts.roughingToolDiaMm - 1e-3;

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
      `The finishing pass clears the full ${depthMm.toFixed(1)} mm on its own, so it runs as ` +
        `${finishLimits.length} layered sweeps of at most ${finishStepdown.toFixed(2)} mm each. ` +
        `A roughing pass with a bigger bit would be much faster.`
    );
  } else if (!opts.roughingEnabled && depthMm > MAX_REACH_DIAMETERS * opts.finishingToolDiaMm) {
    // Asked for explicitly, so it is emitted — but a single sweep with nothing
    // ahead of it means the first move into the stock goes to the floor.
    warnings.push(
      `Single-pass finishing without roughing engages the ${opts.finishingToolDiaMm} mm bit to the full ${depthMm.toFixed(1)} mm depth on entry; enable roughing or layered finishing.`
    );
  }

  const rasterAngle = opts.finishingAngleDeg ?? (opts.finishingDirection === 'y' ? 90 : 0);
  const strategy: FinishingStrategy = opts.finishingStrategy ?? DEFAULT_RELIEF_OPTIONS.finishingStrategy;

  w.cutter = {
    radius: finishRad,
    profile:
      opts.finishingToolType === 'ball_nose'
        ? ballProfile(finishRad)
        : opts.finishingToolType === 'v_bit'
          ? vProfile(Math.tan(vBitHalfAngleRad(opts.finishingVBitAngleDeg)))
          : FLAT_PROFILE,
  };
  w.gcode.push('; --- OP 2: finishing pass ---------------------------------------');
  w.gcode.push(
    `; ${describeCutter(
      opts.finishingToolDiaMm,
      opts.finishingToolType,
      opts.finishingFlutes,
      opts.finishingGeometry,
      opts.finishingVBitAngleDeg
    )}, ` +
      `${stepover.toFixed(2)} mm stepover, ${describeFinishingStrategy(strategy, rasterAngle)}` +
      (finishLimits.length > 1
        ? `, ${finishLimits.length} layers of ${finishStepdown.toFixed(2)} mm`
        : '')
  );


  // Plan-view only. Z stays this function's business: every point that comes
  // back is sampled against the dilated surface, clamped to the layer limit and
  // dropped where there is nothing under it, exactly as the raster always was.
  const planGroups = finishingPassGroups(strategy, {
    bounds: passRect,
    stepover,
    resolution: res,
    angleDeg: rasterAngle,
    surface: finishMap,
    floorZ,
    steepAngleDeg: opts.finishingSteepAngleDeg,
    // A flat bit's side finishes a straight wall in one pass, two diameters at
    // a time and no more than its flutes are long.
    ...(opts.finishingToolType === 'flat'
      ? {
          flatWallMm: Math.min(2 * opts.finishingToolDiaMm, opts.finishingFluteLengthMm > 0 ? opts.finishingFluteLengthMm : Infinity),
          ...(opts.roughingEnabled && job.scrap !== undefined
            ? {
                skipFloorAt: (x: number, y: number) =>
                  materialLevelAt(x, y) <= floorZ + Math.max(0.5, opts.roughingAllowanceMm) + 0.5,
              }
            : {}),
        }
      : {}),
  });

  if (planGroups.every((g) => g.length === 0)) {
    return { error: 'The chosen finishing strategy produced no passes over this stock.' };
  }

  /** The finished surface at a point, as far down as a layer limited to `limit` may take it. */
  const finishZAt = (x: number, y: number, limit: number) =>
    Math.max(limit, Math.min(0, Math.max(floorZ, sampleHeightmap(finishMap, x, y))));

  /*
   * How far the cutter will cut its way across to the next run rather than lift.
   *
   * Every run used to be entered from above: up to the traverse height, across,
   * down, a ramp in and back. Between the pieces of two neighbouring raster rows
   * that is a millimetre of Z each way and a ramp, to move one stepover. Riding
   * the finished surface across instead is a cut like any other on the pass —
   * the surface is the tool-dilated one the passes themselves follow, so the
   * link cannot gouge it — and takes a fraction of the time. Two cutter widths:
   * past that the link is cutting a line of its own across ground the passes
   * were laid out to cover another way.
   */
  const linkMaxMm = Math.max(2 * stepover, 2 * opts.finishingToolDiaMm);
  /*
   * The deepest a link may bite into what is standing.
   *
   * A link has no ramp, so it is only allowed where it takes about the depth
   * the passes themselves take: the roughing allowance and its scallops, or a
   * layer's stepdown when the finishing tool is clearing on its own. Where
   * roughing could not reach, or a wall the link would climb into stands
   * taller, the run is entered from above as before.
   */
  const linkBiteMm = opts.roughingEnabled
    ? opts.roughingAllowanceMm + 0.5
    : Number.isFinite(finishStepdown) ? finishStepdown : finishRad;
  /*
   * How far out from the axis a link is held to that bite as well.
   *
   * Measured near the axis only, a link at the stock's edge with the finishing
   * tool clearing on its own ran past the fin the tool centre can never reach
   * and took ten millimetres of it in one move, so without roughing it is held
   * to the bite out to the rim. After roughing, every pass down a wall takes
   * the allowance sideways over the wall's whole height, and a link may too -
   * but only the allowance: the rim was not checked at all, and wherever the
   * roughing bit could not get in, a narrow valley or an inside corner, a link
   * ploughed the outer half of the cutter through the full height of what it
   * left. So the bite is checked out to the allowance band, and a stock cell
   * further in for the model's own coarseness.
   */
  const linkRimWithin = opts.roughingEnabled
    ? Math.max(finishRad / 2, finishRad - Math.max(0, opts.roughingAllowanceMm) - w.stock.cell)
    : finishRad;

  // The height the material stands at when a layer starts: the stock's top face
  // for the first, whatever the layer before it left for the rest.
  let prevLimit = 0;

  /*
   * A waterline on scrap (`job.scrap`) above the scrap's own floor is
   * finishing a wall nobody keeps - the frame's inner face, at every level of
   * it, seven of them above the part's top on a bracket - and is left out. The
   * floor itself is finished as before: roughing leaves its allowance there,
   * and where the roughing bit does not reach, the finishing pass is what
   * cuts the part free.
   */
  const scrapWall = (pt: { x: number; y: number }, level: number) =>
    job.scrap !== undefined && job.scrap(pt.x, pt.y) &&
    level > Math.min(0, sampleHeightmap(surface, pt.x, pt.y)) + Math.max(0, opts.roughingAllowanceMm) + 0.05;
  // Where each pass point stands and how high, worked out once: it is the
  // same on every layer, and checking a waterline against its walls again
  // per layer nearly doubled the time a layered job took to plan.
  // Whole waterlines, not points: cut into pieces where it crosses onto the
  // part's ground, a waterline needs a ramp into every piece, and a bowl's
  // finishing went from 10 lifts to 181.
  const onScrapWall = (plan: { x: number; y: number }[]) => {
    const level = plan.length > 0 ? waterlineLevel(plan[0]) : undefined;
    if (level === undefined || job.scrap === undefined) return false;
    let n = 0;
    for (const pt of plan) if (scrapWall(pt, level)) n++;
    return n > plan.length / 2;
  };
  /*
   * A pass point's height. Off the samples the dilated grid is a bilinear,
   * and across a wall's cell that runs the cutter half way down the wall: a
   * raster row between two sample rows went 0.27 mm into a 30 mm cylinder
   * and 0.46 mm into the corners of a square. Where the job knows its model
   * (a solid), the cutter in a wall's cell is read on the model itself.
   */
  const passZ = (pt: { x: number; y: number }) => {
    const z = sampleHeightmap(finishMap, pt.x, pt.y);
    // Scrap's walls nobody keeps (see `scrapWall`).
    if (!exact || !inWallCell(pt.x, pt.y) || job.scrap?.(pt.x, pt.y)) return z;
    return Math.max(z, exact.faceTop(pt.x, pt.y, true));
  };

  /** Up the dilated grid's slope at a point, as a unit vector. */
  const uphill = (p: { x: number; y: number }) => {
    const gx = sampleHeightmap(finishMap, p.x + res / 2, p.y) - sampleHeightmap(finishMap, p.x - res / 2, p.y);
    const gy = sampleHeightmap(finishMap, p.x, p.y + res / 2) - sampleHeightmap(finishMap, p.x, p.y - res / 2);
    const g = Math.hypot(gx, gy);
    return g > 1e-9 ? { x: gx / g, y: gy / g } : undefined;
  };
  const mended = (plan: { x: number; y: number }[], points: PathPoint[]) => {
    const level = plan.length > 0 ? waterlineLevel(plan[0]) : undefined;
    return exact && level !== undefined ? exact.mend(points, level) : points;
  };
  const roughWin = centreWindow(job, Math.max(0.05, opts.roughingToolDiaMm / 2));
  const outsideRoughWin = (x: number, y: number) =>
    x < roughWin.minX || x > roughWin.maxX || y < roughWin.minY || y > roughWin.maxY;

  const placed = planGroups.map((group) => group.map((plan) => onScrapWall(plan)
    ? plan.map((pt) => ({ x: pt.x, y: pt.y, z: 0 }))
    : mended(plan, plan.map((pt) => {
      const level = waterlineLevel(pt);
      if (level === undefined) {
        const z = passZ(pt);
        // Scrap floor already cleared by roughing does not need fine raster finishing;
        // the part's own perimeter (within finishRad + res) is not scrap and still cuts free.
        if (
          opts.roughingEnabled &&
          job.scrap?.(pt.x, pt.y) &&
          materialLevelAt(pt.x, pt.y) <= z + Math.max(0.5, opts.roughingAllowanceMm) + 0.5
        ) {
          return { x: pt.x, y: pt.y, z: 0 };
        }
        return { x: pt.x, y: pt.y, z };
      }
      return exact && inWallCell(pt.x, pt.y)
        ? exact.onWall(pt, level, uphill(pt)) ?? exact.settle(holdOffWall(pt, level))
        : holdOffWall(pt, level);
    }))));
  // The level each pass was traced at, where it is a waterline.
  const placedLevels = planGroups.map((group) => group.map((plan) =>
    plan.length > 0 ? waterlineLevel(plan[0]) : undefined));

  /*
   * Each layer, and the same layer again wherever the tool's body was held up
   * over stock standing above the surface (see `bodyHold`), once the sweep
   * has cut what held it: a valley the roughing bit could not enter is taken
   * down a flute length a sweep, as far as the finished walls let the shank
   * go. Where nothing held the body up, a layer is one sweep, as it always was.
   */
  const hold = bodyHold(w.stock, surface, finishBody);

  // Local rest-cleanup stepdown for unroughed corners, narrow valleys and the
  // outer stock border left by a larger roughing cutter. Unroughed runs are
  // grouped into spatial patches (connected within `linkMaxMm`) and each patch
  // is stepped down locally layer-by-layer with surface linking, avoiding both
  // full-depth plunges and layer-by-layer flights across the stock.
  if (restLayering) {
    const restStepdown = autoStepdown;
    // Allow normal roughing allowance + curved-flank scallops (up to 2x stepdown)
    // to finish in the main sweep, while stepping down genuine unroughed corners,
    // valleys, and outer stock borders in `restStepdown` increments.
    const restThreshold = Math.max(opts.roughingAllowanceMm + 0.25, restStepdown * 2);
    // Check near the tool axis (within a stock cell / quarter radius) inside the
    // roughing window so unroughed inside corners and narrow valleys are caught
    // without triggering on the thin straight/convex wall skin left by roughing.
    const restCheckRad = Math.max(0.05, Math.min(w.stock.cell, finishRad * 0.25));

    interface RestPt {
      x: number;
      y: number;
      targetZ: number;
      standingZ: number;
    }
    interface RestRun {
      pts: RestPt[];
      minX: number;
      minY: number;
      maxX: number;
      maxY: number;
    }
    const restRuns: RestRun[] = [];
    for (let g = 0; g < placed.length; g++) {
      for (let k = 0; k < placed[g].length; k++) {
        const plan = placed[g][k];
        let stretch: RestPt[] = [];
        let startIdx = 0;
        const flushStretch = (endIdx: number) => {
          if (stretch.length === 0) return;
          if (stretch.length === 1 && plan.length >= 2) {
            const p = stretch[0];
            const prev = startIdx > 0 ? plan[startIdx - 1] : null;
            const next = endIdx < plan.length ? plan[endIdx] : null;
            const expanded: RestPt[] = [];
            if (prev) {
              const mx = (prev.x + p.x) / 2, my = (prev.y + p.y) / 2;
              expanded.push({ x: mx, y: my, targetZ: Math.max(p.targetZ, finishZAt(mx, my, p.targetZ)), standingZ: p.standingZ });
            }
            expanded.push(p);
            if (next) {
              const mx = (p.x + next.x) / 2, my = (p.y + next.y) / 2;
              expanded.push({ x: mx, y: my, targetZ: Math.max(p.targetZ, finishZAt(mx, my, p.targetZ)), standingZ: p.standingZ });
            }
            stretch = expanded;
          }
          let len = 0;
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (let i = 0; i < stretch.length; i++) {
            const p = stretch[i];
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
            if (i > 0) len += Math.hypot(p.x - stretch[i - 1].x, p.y - stretch[i - 1].y);
          }
          if (len >= res * 0.5 - 1e-6) restRuns.push({ pts: stretch, minX, minY, maxX, maxY });
          stretch = [];
        };
        for (let i = 0; i < plan.length; i++) {
          const pt = plan[i];
          const targetZ = Math.min(0, Math.max(floorZ, pt.z));
          let needsRest = false;
          let standingZ = -Infinity;
          if (targetZ < -1e-6) {
            const outside = outsideRoughWin(pt.x, pt.y);
            const rad = outside ? finishRad : restCheckRad;
            standingZ = Math.min(0, w.stock.highestUnder(pt.x, pt.y, rad, w.cutter.profile));
            needsRest = standingZ - targetZ > restThreshold;
          }
          if (needsRest) {
            if (stretch.length === 0) startIdx = i;
            stretch.push({ x: pt.x, y: pt.y, targetZ, standingZ });
          } else {
            flushStretch(i);
          }
        }
        flushStretch(plan.length);
      }
    }

    if (restRuns.length > 0) {
      w.gcode.push(`; rest-cleanup stepdown (${restStepdown.toFixed(2)} mm) for unroughed corners/border`);
      // Union-Find to group nearby rest runs (with actual points within linkMaxMm)
      // into local patches. Using point distance (after bbox reject) prevents a
      // curved arc's bounding box from merging distant corners into one patch.
      const parent = new Int32Array(restRuns.length);
      for (let i = 0; i < restRuns.length; i++) parent[i] = i;
      const find = (a: number): number => {
        while (parent[a] !== a) {
          parent[a] = parent[parent[a]];
          a = parent[a];
        }
        return a;
      };
      const pad = linkMaxMm;
      const padSq = pad * pad;
      const maxPatchMm = 1.5 * linkMaxMm;
      const pMinX = Float64Array.from(restRuns, (r) => r.minX);
      const pMinY = Float64Array.from(restRuns, (r) => r.minY);
      const pMaxX = Float64Array.from(restRuns, (r) => r.maxX);
      const pMaxY = Float64Array.from(restRuns, (r) => r.maxY);
      const runsClose = (a: RestRun, b: RestRun): boolean => {
        if (a.maxX + pad < b.minX || b.maxX + pad < a.minX || a.maxY + pad < b.minY || b.maxY + pad < a.minY) {
          return false;
        }
        const sa = Math.max(1, Math.floor(a.pts.length / 8));
        const sb = Math.max(1, Math.floor(b.pts.length / 8));
        for (let ia = 0; ia < a.pts.length; ia += sa) {
          const pa = a.pts[ia];
          for (let ib = 0; ib < b.pts.length; ib += sb) {
            const pb = b.pts[ib];
            const dx = pa.x - pb.x, dy = pa.y - pb.y;
            if (dx * dx + dy * dy <= padSq) return true;
          }
        }
        return false;
      };
      for (let i = 0; i < restRuns.length; i++) {
        const a = restRuns[i];
        for (let j = i + 1; j < restRuns.length; j++) {
          const ra = find(i), rb = find(j);
          if (ra === rb || !runsClose(a, restRuns[j])) continue;
          const nMinX = Math.min(pMinX[ra], pMinX[rb]);
          const nMaxX = Math.max(pMaxX[ra], pMaxX[rb]);
          const nMinY = Math.min(pMinY[ra], pMinY[rb]);
          const nMaxY = Math.max(pMaxY[ra], pMaxY[rb]);
          if (nMaxX - nMinX <= maxPatchMm && nMaxY - nMinY <= maxPatchMm) {
            parent[rb] = ra;
            pMinX[ra] = nMinX;
            pMaxX[ra] = nMaxX;
            pMinY[ra] = nMinY;
            pMaxY[ra] = nMaxY;
          }
        }
      }
      const patchMap = new Map<number, RestRun[]>();
      for (let i = 0; i < restRuns.length; i++) {
        const r = find(i);
        let list = patchMap.get(r);
        if (!list) {
          list = [];
          patchMap.set(r, list);
        }
        list.push(restRuns[i]);
      }
      const patches = Array.from(patchMap.values());
      const usedPatch = new Uint8Array(patches.length);

      let down = false;
      for (let pi = 0; pi < patches.length; pi++) {
        let bestP = -1;
        let bestPD = Infinity;
        for (let i = 0; i < patches.length; i++) {
          if (usedPatch[i]) continue;
          const rep = patches[i][0].pts[0];
          const d = Math.hypot(rep.x - w.atX, rep.y - w.atY);
          if (d < bestPD) {
            bestPD = d;
            bestP = i;
          }
        }
        if (bestP < 0) break;
        usedPatch[bestP] = 1;
        const patch = patches[bestP];

        let topZ = -Infinity;
        let botZ = 0;
        for (const run of patch) {
          for (const p of run.pts) {
            if (p.standingZ > topZ) topZ = p.standingZ;
            if (p.targetZ < botZ) botZ = p.targetZ;
          }
        }

        let prevStepZ = topZ;
        for (let limit = topZ - restStepdown; limit > botZ + 1e-6; limit -= restStepdown) {
          const layerSubs: PathPoint[][] = [];
          for (const run of patch) {
            let cur: PathPoint[] = [];
            let curStart = 0;
            const flushSub = (endIdx: number) => {
              if (cur.length === 0) return;
              if (cur.length === 1 && run.pts.length >= 2) {
                const p = cur[0];
                const prev = curStart > 0 ? run.pts[curStart - 1] : null;
                const next = endIdx < run.pts.length ? run.pts[endIdx] : null;
                const exp: PathPoint[] = [];
                if (prev) {
                  const mx = (prev.x + p.x) / 2, my = (prev.y + p.y) / 2;
                  const mz = Math.max(p.z, finishZAt(mx, my, p.z));
                  exp.push({ x: mx, y: my, z: hold ? Math.min(0, Math.max(mz, hold(mx, my, mz))) : mz });
                }
                exp.push(p);
                if (next) {
                  const mx = (p.x + next.x) / 2, my = (p.y + next.y) / 2;
                  const mz = Math.max(p.z, finishZAt(mx, my, p.z));
                  exp.push({ x: mx, y: my, z: hold ? Math.min(0, Math.max(mz, hold(mx, my, mz))) : mz });
                }
                cur = exp;
              }
              let len = 0;
              for (let i = 1; i < cur.length; i++) {
                len += Math.hypot(cur[i].x - cur[i - 1].x, cur[i].y - cur[i - 1].y);
              }
              if (len >= res * 0.5 - 1e-6) layerSubs.push(cur);
              cur = [];
            };
            for (let i = 0; i < run.pts.length; i++) {
              const p = run.pts[i];
              if (p.standingZ > limit + 1e-6 && p.targetZ < limit - 1e-6) {
                if (cur.length === 0) curStart = i;
                const z = hold ? Math.min(0, Math.max(limit, hold(p.x, p.y, limit))) : limit;
                cur.push({ x: p.x, y: p.y, z });
              } else {
                flushSub(i);
              }
            }
            flushSub(run.pts.length);
          }

          const usedSub = new Uint8Array(layerSubs.length);
          for (let n = 0; n < layerSubs.length; n++) {
            let best = -1;
            let bestRev = false;
            let bestD = Infinity;
            for (let i = 0; i < layerSubs.length; i++) {
              if (usedSub[i]) continue;
              const s = layerSubs[i];
              const d0 = Math.hypot(s[0].x - w.atX, s[0].y - w.atY);
              const d1 = Math.hypot(s[s.length - 1].x - w.atX, s[s.length - 1].y - w.atY);
              if (d0 < bestD) {
                bestD = d0;
                best = i;
                bestRev = false;
              }
              if (d1 < bestD) {
                bestD = d1;
                best = i;
                bestRev = true;
              }
            }
            if (best < 0) break;
            usedSub[best] = 1;
            const sub = bestRev ? [...layerSubs[best]].reverse() : layerSubs[best];

            let cuts = false;
            for (let i = 1; i < sub.length && !cuts; i++) {
              const a = sub[i - 1], b = sub[i];
              if (w.stock.deepestCut(a.x, a.y, a.z, b.x, b.y, b.z, w.cutter.radius, w.cutter.profile) > 0.02) {
                cuts = true;
              }
            }
            if (!cuts) continue;

            let pass = simplifyPass(squareUpWalls(sub), PATH_SIMPLIFY_MM);
            finishingRasterLines++;
            const head = pass[0];

            // Link directly across the surface when close and within the rest stepdown.
            let link: PathPoint[] | null = null;
            const gap = Math.hypot(head.x - w.atX, head.y - w.atY);
            if (down && gap <= linkMaxMm) {
              const steps = Math.max(1, Math.ceil(gap / res));
              const pts: PathPoint[] = [];
              const maxLinkZ = Math.max(w.atZ, head.z);
              let crossesWall = false;
              for (let i = 1; i < steps; i++) {
                const x = w.atX + ((head.x - w.atX) * i) / steps;
                const y = w.atY + ((head.y - w.atY) * i) / steps;
                const z0 = finishZAt(x, y, limit);
                if (z0 > maxLinkZ + 1e-6) { crossesWall = true; break; }
                const z = hold ? Math.min(0, Math.max(z0, hold(x, y, z0))) : z0;
                pts.push({ x, y, z });
              }
              if (!crossesWall) {
                pts.push({ x: head.x, y: head.y, z: head.z });
                const candidate = simplifyPass(squareUpWalls([{ x: w.atX, y: w.atY, z: w.atZ }, ...pts]), PATH_SIMPLIFY_MM);
                let ok = true;
                for (let i = 1; i < candidate.length && ok; i++) {
                  const a = candidate[i - 1], b = candidate[i];
                  ok =
                    w.stock.deepestCut(a.x, a.y, a.z, b.x, b.y, b.z, w.cutter.radius, w.cutter.profile, restCheckRad) <= restStepdown * 1.5;
                }
                if (hold) ok = ok && candidate.every((p) => hold(p.x, p.y, p.z) <= p.z + 1e-6);
                if (ok) link = candidate;
              }
            }

            let linkRate = 0;
            if (link) {
              for (let i = 1; i < link.length; i++) {
                const p = link[i], prev = link[i - 1];
                const drop = p.z < prev.z - 1e-6 && Math.hypot(p.x - prev.x, p.y - prev.y) < 1e-6;
                linkRate = drop ? opts.finishingPlungeRate : opts.finishingFeedrate;
                w.cutTo(p.x, p.y, p.z);
                w.gcode.push(`G1 X${f(p.x)} Y${f(p.y)} Z${f(p.z)} F${Math.round(linkRate)}`);
              }
            } else {
              const fromHere =
                down &&
                Math.hypot(head.x - w.atX, head.y - w.atY) < 1e-6 &&
                w.atZ >= head.z - 1e-6;
              pass = w.leadIn(pass, Math.min(0, prevStepZ), opts.finishingPlungeRate, opts.finishingFeedrate, fromHere);
            }

            let rate = link ? linkRate : 0;
            for (let i = 1; i < pass.length; i++) {
              const p = pass[i];
              const prev = pass[i - 1];
              const drop = p.z < prev.z - 1e-6 && Math.hypot(p.x - prev.x, p.y - prev.y) < 1e-6;
              const want = drop ? opts.finishingPlungeRate : opts.finishingFeedrate;
              w.cutTo(p.x, p.y, p.z);
              w.gcode.push(`G1 X${f(p.x)} Y${f(p.y)} Z${f(p.z)}${want !== rate ? ` F${Math.round(want)}` : ''}`);
              rate = want;
            }
            down = true;
            w.segments.push({
              type: 'finishing',
              points: link ? [...link.slice(0, -1), ...pass] : pass,
              traverseZ: link ? link[0].z : w.lastTraverseZ,
            });
          }
          prevStepZ = limit;
        }
      }
    }
  }
  /*
   * Whether the body could meet anything here at all, from what roughing and
   * the layer above left (`materialLevelAt`, the previous limit) rather than
   * from the stock model, which is far dearer to ask: on a 20 mm dome
   * finished in layers, asking it at every point took planning from 21 s to
   * 40. Once anything has been held, the layer above is no longer a bound.
   */
  const bodyReach = Math.max(0, ...finishBody.map((s) => s.radiusMm));
  const bodyAbove = Math.min(Infinity, ...finishBody.map((s) => s.aboveTipMm));
  let everHeld = false;
  const mayHold = (x: number, y: number, z: number, cap: number) => {
    if (!everHeld && cap - bodyAbove <= z) return false;
    let standing = -Infinity;
    for (let k = 0; k <= 8; k++) {
      const a = (Math.PI * k) / 4, d = k === 8 ? 0 : bodyReach;
      standing = Math.max(standing, materialLevelAt(x + d * Math.cos(a), y + d * Math.sin(a)));
    }
    return Math.min(standing, everHeld ? 0 : cap) - bodyAbove > z;
  };
  const sampleOf = (x: number, y: number) =>
    Math.min(finishMap.rows - 1, Math.max(0, Math.round((y - finishMap.minY) / (finishMap.stepY || 1)))) * finishMap.cols +
    Math.min(finishMap.cols - 1, Math.max(0, Math.round((x - finishMap.minX) / (finishMap.stepX || 1))));
  for (let li = 0; li < finishLimits.length; li++) {
    const limit = finishLimits[li];
    // The samples the sweep before was held up over, and by how much in all.
    let heldOver: Uint8Array | null = null;
    let heldBefore = Infinity;
    for (let sweep = 0; ; sweep++) {
      if (sweep === 0 && finishLimits.length > 1) {
        w.gcode.push(`; layer down to Z${f(limit)}`);
      } else if (sweep > 0) {
        w.gcode.push('; again, where the tool body was held clear of the stock');
      }

      // Whether the cutter is down on the surface at the end of a run, from
      // where the next may be linked to without lifting.
      let down = false;

      const only = heldOver;
      const heldNow = hold ? new Uint8Array(finishMap.cols * finishMap.rows) : null;
      let heldBy = 0;
      for (let g = 0; g < placed.length; g++) {
        const group = only
          ? placed[g].map((plan) => plan.map((pt) => only[sampleOf(pt.x, pt.y)] ? pt : { x: pt.x, y: pt.y, z: 0 }))
          : placed[g];
        const { runs, runLevels } = layerRuns(group, placedLevels[g], limit, prevLimit, floorZ, stepover, res);

        /*
         * Nearest run next, from either end, or from anywhere round a loop.
         *
         * The runs come out of the generator in its own order — row after row
         * across the whole stock for a raster, level after level for a waterline
         * — and once they are split where they leave the material, cutting them
         * in that order flies the width of the stock between every two pieces of
         * neighbouring rows. On a giraffe hide that was 761 runs and more
         * distance in the air than cutting. Taken nearest first, the pieces of
         * one patch are finished, row to row, before the tool leaves it — the
         * same order the roughing pockets were given.
         */
        const closed = runs.map((r) =>
          r.length > 3 && Math.hypot(r[0].x - r[r.length - 1].x, r[0].y - r[r.length - 1].y) < 1e-6
        );
        // A loop's candidate starting points, thinned so the search stays cheap
        // on long contours. The chosen loop is then turned to its exact nearest.
        const probes = runs.map((r, i) => {
          if (!closed[i]) return [0, r.length - 1];
          const step = Math.max(1, Math.floor((r.length - 1) / 32));
          const out: number[] = [];
          for (let k = 0; k < r.length - 1; k += step) out.push(k);
          return out;
        });
        const used = new Uint8Array(runs.length);

        /*
         * ...except down a wall, which is cut top first.
         *
         * Nearest in plan alone ignores height, and stepping from one wall to the
         * next it took whichever level of the next happened to be closest - as
         * often as not the deepest - and worked the wall upward from there, the
         * cutter's flank buried in the allowance standing over it the whole way.
         * A waterline waits for every higher one near it (see
         * `higherWaterlinesNear`); everything else is nearest first as before.
         */
        const waterlineReach = Math.max(
          opts.finishingToolDiaMm,
          stepover / Math.tan((Math.max(5, opts.finishingSteepAngleDeg || 35) * Math.PI) / 180) + res * 2
        );
        const waitingFor = higherWaterlinesNear(runs, runLevels, waterlineReach);
        const pending = waitingFor.map((w) => w.length);
        const releases: number[][] = runs.map(() => []);
        waitingFor.forEach((w, i) => { for (const j of w) releases[j].push(i); });

        for (let n = 0; n < runs.length; n++) {
          let best = -1;
          let bestAt = 0;
          let bestD = Infinity;
          for (let i = 0; i < runs.length; i++) {
            if (used[i] || pending[i] > 0) continue;
            for (const k of probes[i]) {
              const d = Math.hypot(runs[i][k].x - w.atX, runs[i][k].y - w.atY);
              if (d < bestD) {
                bestD = d;
                best = i;
                bestAt = k;
              }
            }
          }
          if (best < 0) best = runs.findIndex((_, i) => !used[i]);
          used[best] = 1;
          for (const i of releases[best]) pending[i]--;
          let r = runs[best];
          if (closed[best]) {
            let near = bestAt;
            for (let k = 0; k < r.length - 1; k++) {
              if (Math.hypot(r[k].x - w.atX, r[k].y - w.atY) < Math.hypot(r[near].x - w.atX, r[near].y - w.atY)) near = k;
            }
            r = [...r.slice(near, r.length - 1), ...r.slice(0, near), r[near]];
          } else if (bestAt !== 0) {
            r = [...r].reverse();
          }

          if (hold && heldNow) {
            r = r.map((p) => {
              if (!mayHold(p.x, p.y, p.z, prevLimit)) return p;
              const need = Math.min(0, hold(p.x, p.y, p.z));
              if (need <= p.z + 1e-6) return p;
              everHeld = true;
              // Scrap - the channel and frame away from the part - is left
              // where the body held it: nobody keeps it, and going back for it
              // a flute length at a time cost a solid job a quarter again.
              if (!job.scrap?.(p.x, p.y)) {
                heldNow[sampleOf(p.x, p.y)] = 1;
                heldBy += need - p.z;
              }
              return { x: p.x, y: p.y, z: need };
            });
          }

          let pass = simplifyPass(squareUpWalls(r), PATH_SIMPLIFY_MM);
          finishingRasterLines++;
          const head = pass[0];

          // Across to the head along the surface, where it is close and the
          // material in the way is no more than a pass would take anyway.
          let link: PathPoint[] | null = null;
          const gap = Math.hypot(head.x - w.atX, head.y - w.atY);
          if (down && gap <= linkMaxMm) {
            const steps = Math.max(1, Math.ceil(gap / res));
            const pts: PathPoint[] = [];
            for (let i = 1; i < steps; i++) {
              const x = w.atX + ((head.x - w.atX) * i) / steps;
              const y = w.atY + ((head.y - w.atY) * i) / steps;
              pts.push({ x, y, z: finishZAt(x, y, limit) });
            }
            pts.push({ x: head.x, y: head.y, z: head.z });
            // Squared up at each wall as the runs are, or a link across a step
            // runs straight through its edge; then measured as the cut it would
            // be, against the cutter's profile.
            const candidate = simplifyPass(squareUpWalls([{ x: w.atX, y: w.atY, z: w.atZ }, ...pts]), PATH_SIMPLIFY_MM);
            let ok = true;
            for (let i = 1; i < candidate.length && ok; i++) {
              const a = candidate[i - 1], b = candidate[i];
              ok =
                w.stock.deepestCut(a.x, a.y, a.z, b.x, b.y, b.z, w.cutter.radius, w.cutter.profile, w.cutter.radius / 2) <= linkBiteMm &&
                w.stock.deepestCut(a.x, a.y, a.z, b.x, b.y, b.z, w.cutter.radius, w.cutter.profile, linkRimWithin) <= linkBiteMm;
            }
            // Nor where the tool body would meet the stock on the way.
            if (hold) ok = ok && candidate.every((p) => !mayHold(p.x, p.y, p.z, prevLimit) || hold(p.x, p.y, p.z) <= p.z + 1e-6);
            if (ok) link = candidate;
          }

          /*
           * A link's straight drops - the foot of a wall it squares up at, or the
           * step from one waterline level to the next - go down at the plunge
           * rate, as a pass's own do. They went at the cutting feed: 150 times
           * on one bracket, a 3.8 mm vertical plunge at 2240 mm/min on a monkey,
           * three times the rate the bit is rated to go straight down at.
           */
          let linkRate = 0;
          if (link) {
            for (let i = 1; i < link.length; i++) {
              const p = link[i], prev = link[i - 1];
              const drop = p.z < prev.z - 1e-6 && Math.hypot(p.x - prev.x, p.y - prev.y) < 1e-6;
              linkRate = drop ? opts.finishingPlungeRate : opts.finishingFeedrate;
              w.cutTo(p.x, p.y, p.z);
              w.gcode.push(`G1 X${f(p.x)} Y${f(p.y)} Z${f(p.z)} F${Math.round(linkRate)}`);
            }
          } else {
            /*
             * Where the material actually is at the head of this pass.
             *
             * This used to be told `Z0` — the stock's top face — whatever roughing
             * had already taken off. With a 10 mm ${noun} and roughing on, the real
             * material stands at about `surface + 0.5 mm`, so the ramp was handed a
             * 10 mm drop instead of half a millimetre and spent 37 mm descending
             * through open air at the plunge rate before it touched anything, then
             * retraced the same 37 mm on the way back. About fifteen seconds a run,
             * for roughly one second of cutting, across every raster line in the
             * job — which is most of where "it spent a long time cutting air" came
             * from.
             *
             * The lower of the two is what is standing: whichever of roughing and
             * the finishing layer above cut deepest here is the one that decides
             * the height, and cutting the same place twice does not raise it.
             */
            // On a repeat sweep (`; again`), `w.stock` already holds what the
            // previous sweep left under the head; passing 0 forced `leadIn` to
            // ramp from the untouched stock face through open air every repeat.
            const entryZ = sweep > 0 ? -Infinity : Math.min(0, materialLevelAt(head.x, head.y), prevLimit);
            pass = w.leadIn(pass, entryZ, opts.finishingPlungeRate, opts.finishingFeedrate);
          }

          // GRBL keeps the last feedrate, so it is only stated when it changes:
          // at the start, and either side of the straight drops `squareUpWalls`
          // puts at the foot of a wall, which go down at the plunge rate. A link
          // stated the feed already.
          // A link that ended on a drop left the plunge rate set.
          let rate = link ? linkRate : 0;
          for (let i = 1; i < pass.length; i++) {
            const p = pass[i];
            const prev = pass[i - 1];
            const drop = p.z < prev.z - 1e-6 && Math.hypot(p.x - prev.x, p.y - prev.y) < 1e-6;
            const want = drop ? opts.finishingPlungeRate : opts.finishingFeedrate;
            w.cutTo(p.x, p.y, p.z);
            w.gcode.push(`G1 X${f(p.x)} Y${f(p.y)} Z${f(p.z)}${want !== rate ? ` F${Math.round(want)}` : ''}`);
            rate = want;
          }
          down = true;

          w.segments.push({
            type: 'finishing',
            points: link ? [...link.slice(0, -1), ...pass] : pass,
            // A linked pass never lifted, so it has no traverse of its own: it
            // starts where the tool already was. It used to carry the last
            // `leadIn`'s height, and after a long flight at the safe height the
            // preview drew and timed that whole lift at every link after it.
            traverseZ: link ? link[0].z : w.lastTraverseZ,
          });
        }
      }

      if (!heldNow || heldBy < 1e-6 || sweep >= MAX_BODY_SWEEPS || heldBy >= heldBefore - 1e-3) break;
      heldOver = heldNow;
      heldBefore = heldBy;
    }
    prevLimit = limit;
  }

  if (finishingRasterLines === 0) {
    return { error: 'The chosen stock and stepover produced no finishing passes.' };
  }
  return { finishingRasterLines };
}

/** Most sweeps one layer takes while the tool body is still being held up. */
const MAX_BODY_SWEEPS = 32;

/**
 * One layer's runs in a group of passes, in no particular order yet, and the
 * waterline level each came from.
 */
function layerRuns(
  group: PathPoint[][],
  levels: (number | undefined)[],
  limit: number,
  prevLimit: number,
  floorZ: number,
  stepover: number,
  res: number
): { runs: PathPoint[][]; runLevels: (number | undefined)[] } {
  const runs: PathPoint[][] = [];
  const runLevels: (number | undefined)[] = [];
  for (let k = 0; k < group.length; k++) {
    const plan = group[k];
    // `surface` is where the pass ends up; `z` is as far as this layer is
    // allowed to go towards it. A point the layer above already took to its
    // surface is finished, and is left out of this layer entirely — which is
    // what stops the pass re-tracing the whole background on every layer.
    const raw: PathPoint[] = [];
    /*
     * A waterline holds its own level, so it does not climb each wall
     * it runs along the foot of, unless the cutter really would cut in
     * there (see `holdOffWall`). Its line is traced with each wall half
     * way across its cell, and a surface steeper than a wall's threshold
     * but not vertical, like a sphere near its equator, stands well off
     * that line: held at the level alone, the tool went 1 mm into a
     * 40 mm sphere's flank.
     */
    for (const at of plan) {
      const surface = Math.min(0, Math.max(floorZ, at.z));
      const done = surface >= prevLimit - 1e-6;
      raw.push({ x: at.x, y: at.y, z: done ? 0 : Math.max(surface, limit) });
    }

    // Stretches where the tool would only skim the stock's own top face have
    // no material under them. Flying over them instead of tracing them is what
    // keeps a small model on a big board from costing a full-board raster.
    let run: PathPoint[] = [];
    let runStartIdx = 0;
    const flush = (endIdx: number) => {
      if (run.length === 0) return;
      if (run.length === 1 && raw.length >= 2) {
        const p = run[0];
        const prev = runStartIdx > 0 ? raw[runStartIdx - 1] : p;
        const next = endIdx < raw.length ? raw[endIdx] : p;
        const entry =
          prev !== p
            ? { x: (prev.x + p.x) / 2, y: (prev.y + p.y) / 2, z: p.z }
            : p;
        const exit =
          next !== p
            ? { x: (p.x + next.x) / 2, y: (p.y + next.y) / 2, z: p.z }
            : p;
        run = entry !== p && exit !== p ? [entry, p, exit] : entry !== p ? [entry, p] : [p, exit];
      }
      let runLen = 0;
      for (let i = 1; i < run.length; i++) {
        runLen += Math.hypot(run[i].x - run[i - 1].x, run[i].y - run[i - 1].y);
      }
      const minFlushLen = prevLimit < 0 ? stepover : res * 0.5;
      if (runLen >= minFlushLen - 1e-6) {
        runs.push(run);
        runLevels.push(levels[k]);
      }
      run = [];
    };
    for (let idx = 0; idx < raw.length; idx++) {
      const p = raw[idx];
      if (p.z < -1e-6) {
        if (run.length === 0) runStartIdx = idx;
        run.push(p);
      } else {
        flush(idx);
      }
    }
    flush(raw.length);
  }
  return { runs, runLevels };
}
