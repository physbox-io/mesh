// The roughing pass of a surface job: layers cleared down to the surface,
// leaving the finishing allowance on it.

import { adaptiveBiteFraction, describeCutter, round2 } from './reliefTooling';
import { stepdownForEngagement, type ClearingRegion } from './adaptiveClearing';
import { dilateForTool, sampleHeightmap } from './reliefHeightmap';
import { axisSamples, f, roughSimplifyMm, simplifyPass, type PathPoint } from './reliefPaths';
import { FLAT_PROFILE } from './stockModel';
import { bodyFor, centreWindow, type SurfaceJob } from './surfaceJob';
import { emitAdaptiveLayer, type RoughingLayout } from './adaptiveRoughingLayer';
import type { ReliefCarveOptions } from './reliefOptions';
import type { ToolpathWriter } from './toolpathWriter';

export interface RoughingResult {
  roughingPassCount: number;
  /** The radial bite roughing actually took, as a percentage of its cutter. */
  roughingBitePercent: number;
  /**
   * The lowest the material can stand at a point once roughing has been over
   * it: the finishing pass's expected entry height.
   */
  materialLevelAt: (x: number, y: number) => number;
}

/** Writes the roughing pass onto `w`, when roughing is on. */
export function roughSurface(w: ToolpathWriter, job: SurfaceJob, opts: ReliefCarveOptions): RoughingResult {
  const surface = job.surface;
  const res = job.resolution;
  let roughingPassCount = 0;
  let roughingBitePercent = 0;
  const roughRad = Math.max(0.05, opts.roughingToolDiaMm / 2);
  // With no finishing pass to take it off, an allowance would be left on the
  // piece for good, so roughing goes to the surface.
  const allowance = opts.finishingEnabled ? Math.max(0, opts.roughingAllowanceMm) : 0;

  /**
   * The lowest the material can stand at a point once roughing has been over
   * it: the finishing pass's expected entry height. What is really standing is
   * the stock model's business (see `leadIn`).
   *
   * Without roughing nothing has been taken off, so the answer is the stock's
   * top face — which is what this is until the roughing block below replaces
   * it. It is declared out here because the finishing pass needs it and the map
   * it reads lives inside `if (opts.roughingEnabled)`.
   */
  let materialLevelAt: (x: number, y: number) => number = () => 0;

  if (!opts.roughingEnabled) return { roughingPassCount, roughingBitePercent, materialLevelAt };

  // Walls held at the near edge of the cell they were sampled across
  // ('clear'): the allowance only lifts the floor, so on a vertical wall
  // roughing cuts to size, and with the wall anywhere in its cell it cut
  // past it. A 100 mm cylinder milled from solid came out 0.85 mm under
  // at its faces, and nothing after roughing can put material back. This
  // leaves up to a cell on a wall for the finisher instead: 206 against 213
  // minutes on that cylinder, 133 against 121 on a 60 mm sphere, whose
  // flanks near the equator are walls at this sampling.
  // With no finishing pass, roughing is the last cut and goes by the
  // samples, as it always had: held a cell clear, a through-cut's 4 mm
  // slots closed up on a 3.175 mm cutter and nothing was cut at all, and
  // 'middle' still held it 0.28 mm short of cutting through.
  const roughWalls = opts.finishingEnabled ? 'clear' : 'samples';
  const roughMap = dilateForTool(surface, roughRad, false, bodyFor(opts, opts.roughingToolDiaMm, 0, 0), roughWalls);
  // Roughing is always a flat end mill.
  w.cutter = { radius: roughRad, profile: FLAT_PROFILE };
  const adaptive = opts.roughingStrategy === 'adaptive';

  // Deepest the roughing tool is allowed to go: the allowance above the
  // lowest point it can reach at all.
  let deepest = 0;
  for (let i = 0; i < roughMap.z.length; i++) {
    if (roughMap.z[i] < deepest) deepest = roughMap.z[i];
  }
  const roughFloor = deepest + allowance;

  const baseStepdown = Math.max(0.1, opts.roughingStepdownMm);
  // A raster's bite is only the stepover on a straight run; an adaptive clear
  // holds it everywhere, corners included. That is what lets the radial bite
  // come down and the depth go up — but only as far as the depth has layers
  // to give back, so the bite is chosen against this job's depth.
  const roughStepover = Math.max(
    0.2,
    opts.roughingStepoverMm > 0
      ? opts.roughingStepoverMm
      : opts.roughingToolDiaMm *
          (adaptive
            ? adaptiveBiteFraction(opts.roughingToolDiaMm, baseStepdown, Math.abs(Math.min(0, roughFloor)))
            : 0.45)
  );
  const engagement = roughStepover / Math.max(1e-6, opts.roughingToolDiaMm);
  roughingBitePercent = Math.round(engagement * 100);
  // The whole point of holding the engagement down is being able to take the
  // depth up; taking the one without the other is strictly slower than the
  // raster it replaced.
  const stepdown = adaptive
    ? stepdownForEngagement(opts.roughingToolDiaMm, engagement, baseStepdown)
    : baseStepdown;

  // What roughing leaves: its own reachable surface plus the allowance,
  // never deeper than the floor it is allowed to reach and never above the
  // stock's top face. Each slab follows the surface down to its floor, so
  // this is what stands once roughing is done, wherever the flat mill fits.
  // Where it does not, `leadIn` raises the finishing entry to whatever the
  // stock model says is really standing.
  materialLevelAt = (x, y) =>
    Math.min(0, Math.max(roughFloor, sampleHeightmap(roughMap, x, y) + allowance));

  // The last layer sits exactly at the floor, where the only material left to
  // take is at the single deepest point of the ${noun} — so it clears next to
  // nothing, and all the real work happens on the layers above it. A stepdown
  // as deep as the ${noun} therefore leaves no useful layer at all: the loop
  // below produces none, and roughing quietly does nothing.
  //
  // Halving is the guard. It matters more now than it did, because an
  // adaptive clear asks for a much deeper stepdown and a shallow relief is
  // exactly where that ambition outruns the material available to cut.
  const roughDepth = Math.abs(Math.min(0, roughFloor));
  const layerStep = Math.min(stepdown, Math.max(0.1, roughDepth / 2));

  const layers: number[] = [];
  for (let z = -layerStep; z > roughFloor + 1e-6; z -= layerStep) layers.push(z);
  if (roughFloor < -1e-6) layers.push(roughFloor);
  /*
   * No separate layer for a flat any more. Layer planes land wherever they
   * land, and a flat face between two of them used to be left up to a whole
   * layer proud, so each flat got a layer of its own. Each slab now follows
   * the surface down to its floor, which puts a flat between two planes at
   * exactly its own height on the slab that passes through it.
   */
  roughingPassCount = layers.length;

  if (layers.length > 0) {
    w.gcode.push('; --- OP 1: roughing ---------------------------------------------');
    // Named as a flat end mill because that is what the roughing path is
    // planned as: it is dilated with a flat bottom, so a ball nose fitted
    // here would leave the corners of every layer uncut, and the job would
    // silently be roughing to the wrong depth. The tool number goes in the
    // header rather than out on the wire as a bare `T1`, because a Marlin
    // build reads that as "select extruder 1" and errors on it.
    w.gcode.push(
      `; T1: ${describeCutter(opts.roughingToolDiaMm, 'flat', opts.roughingFlutes, opts.roughingGeometry)}, ` +
        `${round2(layerStep)} mm stepdown, ${allowance} mm left on`
    );
    w.gcode.push(
      adaptive
        ? `;     adaptive clear, ${round2(roughStepover)} mm radial engagement (${Math.round(engagement * 100)}%)`
        : `;     raster, ${round2(roughStepover)} mm stepover`
    );
  }

  const roughWin = centreWindow(job, roughRad);
  const xs = axisSamples(roughWin.minX, roughWin.maxX, res);
  const ys = axisSamples(roughWin.minY, roughWin.maxY, roughStepover);

  /** The lowest the roughing tool's tip may go at a point: its surface plus the allowance. */
  const roughTargetAt = (x: number, y: number) =>
    Math.max(roughFloor, sampleHeightmap(roughMap, x, y) + allowance);
  /**
   * Where a slab's cut runs at a point: down to the slab's floor, or to the
   * surface where that stands higher. `roughMap` is the flat cutter's own
   * offset surface, so following it cannot gouge. Never above the slab's
   * top: a contour runs a fraction of a cell outside the region it bounds,
   * where the surface can stand higher than the slab, and on the first slab
   * that is above the stock.
   */
  const slabZ = (x: number, y: number, floorZ: number, topZ: number) =>
    Math.min(topZ, Math.max(floorZ, roughTargetAt(x, y)));

  /**
   * Where the tool's centre may sit at a given layer, as a grid.
   *
   * A one-cell border of empty is left all the way round on purpose. The
   * contour of a region that runs right up to the edge of its grid has
   * nowhere to close, so it comes back as an open path and is discarded — and
   * a relief that fills its stock is exactly the case where that would throw
   * the outermost ring of every layer away.
   */
  // Where a finishing pass follows, a sliver of a few hundredths of a
  // millimetre inside the allowance is not worth roughing: it only generates
  // a single-cell outer ring that skims the surface in air.
  const minRoughCut = allowance > 0 ? Math.min(0.05, allowance * 0.25) : 1e-6;

  const layerRegion = (layerTop: number): ClearingRegion => {
    const gxs = axisSamples(roughWin.minX, roughWin.maxX, res);
    const gys = axisSamples(roughWin.minY, roughWin.maxY, res);
    const cols = gxs.length + 2;
    const rows = gys.length + 2;
    const mask = new Uint8Array(cols * rows);

    for (let j = 0; j < gys.length; j++) {
      for (let i = 0; i < gxs.length; i++) {
        const target = roughTargetAt(gxs[i], gys[j]);
        // Anywhere this slab has material to give, not only where the
        // finished surface lies below the slab's floor. That rule left every
        // cell shallower than the first layer untouched - most of a relief -
        // and a whole layer of terrace standing between every two, all of it
        // for the finishing tool. The path follows the surface down to the
        // floor instead (see `slabZ`).
        if (target < layerTop - minRoughCut) mask[(j + 1) * cols + (i + 1)] = 1;
      }
    }

    const cell = gxs.length > 1 ? gxs[1] - gxs[0] : res;
    return {
      mask, cols, rows,
      mmPerCell: cell,
      // The grid was padded by a cell, so its own origin sits a cell before
      // the first sample.
      originMm: { x: gxs[0] - cell, y: gys[0] - cell },
    };
  };

  /*
   * The window the roughing tool's centre may occupy.
   *
   * The clearing grid above is deliberately padded by an empty cell all round
   * so that a region filling the stock still produces a closed contour. That
   * pad lies outside the safe inset, and marching squares interpolates the
   * contour *into* it — so a region running up to the first real sample comes
   * back as a ring up to half a cell further out than the tool is allowed to
   * go. On a 6.35 mm cutter that put the tool's centre 2.41 mm from the edge
   * of the stock and hung three quarters of a millimetre of it off the board,
   * over the clamps and the spoilboard, on every layer of every roughing
   * pass. The finishing raster never had the problem because it is laid out
   * from `axisSamples` directly rather than read back off a contour.
   *
   * Clamping the emitted points is the fix rather than shrinking the grid: it
   * holds whatever the cell size works out to, and it is the tool's actual
   * constraint stated where the toolpath is written.
   */
  const safeX = (x: number) => Math.min(Math.max(x, roughWin.minX), roughWin.maxX);
  const safeY = (y: number) => Math.min(Math.max(y, roughWin.minY), roughWin.maxY);

  const layout: RoughingLayout = {
    opts, res, allowance, roughRad, roughStepover, baseStepdown, minRoughCut, layerRegion, slabZ, safeX, safeY,
  };

  // No faster than the machine tracks, as adaptive holds its feed: asked for
  // more, a raster wrote F3900 for a gantry that does 3000.
  const rasterFeed = Math.min(opts.roughingFeedrate, opts.motionProfile.maxRate.x, opts.motionProfile.maxRate.y);

  // Regular layers, top down, each one a slab from the layer above.
  let layerTop = 0;
  for (const layerZ of layers) {
    const top = layerTop;
    layerTop = layerZ;
    if (adaptive) {
      emitAdaptiveLayer(w, layout, layerZ, top);
      continue;
    }

    let forward = true;
    // Whether the tool is down in this slab at the end of a run, from where
    // the next may be reached across at depth.
    let down = false;

    for (const y of ys) {
      const lineXs = forward ? xs : [...xs].reverse();
      forward = !forward;

      // A run is the stretch of this line where the slab has material to
      // give, cut down to the slab's floor or to the surface, whichever is
      // higher. See `layerRegion`.
      let run: PathPoint[] = [];
      const flushRun = () => {
        if (run.length >= 2) {
          const plan = simplifyPass(run, roughSimplifyMm(allowance, res));
          // The layer above is what the tool is dropping through, so that is
          // where the ramp starts — one layer, not the whole depth so far.
          /*
           * Across to the next row at depth, where it starts a stepover or so
           * from where the last one ended and the move takes no more than the
           * slab - the cut every row makes sideways anyway. It used to lift
           * out and ramp back in at the head of every run: 430 lifts on a
           * dome, and 42% of the roughing path at the plunge rate.
           */
          const head = plan[0];
          const across = Math.hypot(head.x - w.atX, head.y - w.atY);
          const linked =
            down &&
            across <= roughStepover * 1.5 + 1e-6 &&
            Math.abs(head.z - w.atZ) <= 1e-6 &&
            w.stock.deepestCut(w.atX, w.atY, w.atZ, head.x, head.y, head.z, roughRad) <= top - layerZ + 1e-3;
          let pass: PathPoint[];
          let passFeedStated = false;
          if (linked) {
            w.cutTo(head.x, head.y, head.z);
            w.gcode.push(`G1 X${f(head.x)} Y${f(head.y)} F${Math.round(rasterFeed)}`);
            passFeedStated = true;
            pass = plan;
          } else {
            pass = w.leadIn(plan, top, opts.roughingPlungeRate, rasterFeed);
          }
          down = true;

          let lastZ = pass[0].z;
          for (let i = 1; i < pass.length; i++) {
            w.cutTo(pass[i].x, pass[i].y, pass[i].z);
            const z = Math.abs(pass[i].z - lastZ) > 1e-6 ? ` Z${f(pass[i].z)}` : '';
            lastZ = pass[i].z;
            w.gcode.push(`G1 X${f(pass[i].x)} Y${f(pass[i].y)}${z}${passFeedStated ? '' : ` F${Math.round(rasterFeed)}`}`);
            passFeedStated = true;
          }

          // One segment per run: the preview must not draw a line across the
          // gap the tool actually flew over.
          w.segments.push({ type: 'roughing', points: pass, traverseZ: w.lastTraverseZ });
        }
        run = [];
      };

      for (const x of lineXs) {
        if (roughTargetAt(x, y) < top - minRoughCut) run.push({ x, y, z: slabZ(x, y, layerZ, top) });
        else flushRun();
      }
      flushRun();
    }
  }

  return { roughingPassCount, roughingBitePercent, materialLevelAt };
}
