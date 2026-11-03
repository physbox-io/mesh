// The finishing pass of a surface job: the strategy's passes, layered where
// the finishing tool clears on its own, cut nearest first and linked along the
// surface where that is safe.

import { describeFinishingStrategy, finishingPassGroups, waterlineLevel, type FinishingStrategy } from './finishingPaths';
import { sampleHeightmap, type Heightmap } from './reliefHeightmap';
import { DEFAULT_RELIEF_OPTIONS, vBitHalfAngleRad, type ReliefCarveOptions } from './reliefOptions';
import {
  PATH_SIMPLIFY_MM,
  f,
  higherWaterlinesNear,
  simplifyPass,
  squareUpWalls,
  type PathPoint,
} from './reliefPaths';
import { MAX_REACH_DIAMETERS, describeCutter } from './reliefTooling';
import { FLAT_PROFILE, ballProfile, vProfile } from './stockModel';
import type { ToolpathWriter } from './toolpathWriter';

/** The finishing tool's view of the surface, as `machineSurface` prepares it. */
export interface FinishingSurface {
  /** The surface dilated by the finishing cutter. */
  finishMap: Heightmap;
  /** The window the finishing tool's centre may enter. */
  passRect: { minX: number; minY: number; maxX: number; maxY: number };
  /** Where a waterline point can stand at its level (see `machineSurface`). */
  holdOffWall: (p: { x: number; y: number }, level: number) => PathPoint;
  finishRad: number;
  stepover: number;
  floorZ: number;
  depthMm: number;
  res: number;
}

/**
 * Writes the finishing pass onto `w`. `materialLevelAt` is what roughing left
 * standing; a pass is entered from that height rather than the stock's face.
 */
export function finishSurface(
  w: ToolpathWriter,
  opts: ReliefCarveOptions,
  fin: FinishingSurface,
  materialLevelAt: (x: number, y: number) => number,
  warnings: string[]
): { finishingRasterLines: number; error?: undefined } | { error: string } {
  const { finishMap, passRect, holdOffWall, finishRad, stepover, floorZ, depthMm, res } = fin;
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

  // Where each pass point stands and how high, worked out once: it is the
  // same on every layer, and checking a waterline against its walls again
  // per layer nearly doubled the time a layered job took to plan.
  const placed = planGroups.map((group) => group.map((plan) => plan.map((pt) => {
    const level = waterlineLevel(pt);
    return level === undefined
      ? { x: pt.x, y: pt.y, z: sampleHeightmap(finishMap, pt.x, pt.y) }
      : holdOffWall(pt, level);
  })));
  // The level each pass was traced at, where it is a waterline.
  const placedLevels = planGroups.map((group) => group.map((plan) =>
    plan.length > 0 ? waterlineLevel(plan[0]) : undefined));

  for (const limit of finishLimits) {
    if (finishLimits.length > 1) {
      w.gcode.push(`; layer down to Z${f(limit)}`);
    }

    // Whether the cutter is down on the surface at the end of a run, from
    // where the next may be linked to without lifting.
    let down = false;

    for (let g = 0; g < placed.length; g++) {
      const group = placed[g];
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
          if (ok) link = candidate;
        }

        if (link) {
          for (let i = 1; i < link.length; i++) {
            const p = link[i];
            w.cutTo(p.x, p.y, p.z);
            w.gcode.push(`G1 X${f(p.x)} Y${f(p.y)} Z${f(p.z)} F${Math.round(opts.finishingFeedrate)}`);
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
          const entryZ = Math.min(0, materialLevelAt(head.x, head.y), prevLimit);
          pass = w.leadIn(pass, entryZ, opts.finishingPlungeRate, opts.finishingFeedrate);
        }

        // GRBL keeps the last feedrate, so it is only stated when it changes:
        // at the start, and either side of the straight drops `squareUpWalls`
        // puts at the foot of a wall, which go down at the plunge rate. A link
        // stated the feed already.
        let rate = link ? opts.finishingFeedrate : 0;
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

    prevLimit = limit;
  }

  if (finishingRasterLines === 0) {
    return { error: 'The chosen stock and stepover produced no finishing passes.' };
  }
  return { finishingRasterLines };
}

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
