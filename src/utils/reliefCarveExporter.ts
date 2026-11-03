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
import { DEFAULT_RELIEF_OPTIONS, type ReliefCarveOptions, type ReliefCarveResult } from './reliefOptions';
import { buildHeightmap, findUndercut, lowestInteriorZ, measureDetailMm, type Heightmap } from './reliefHeightmap';
import { f } from './reliefPaths';
import { OVERRUN_PAST_EDGE_MM, openEdges, type OpenEdges } from './surfaceJob';
import { addHoldingTabs, countLoosePieces } from './holdingTabs';
import { bridgeOuterEdgeBevel, endFaces, extendOpenEdges, fillGrazedEdges } from './reliefEdges';
import { machineSurface } from './machineSurface';

// The carve's pieces live in their own modules; everything that was always
// imported from here still is.
export {
  vBitHalfAngleRad,
  vBitConeHeight,
  DEFAULT_RELIEF_OPTIONS,
  APP_RELIEF_DEFAULTS,
  type CutterShape,
  type CutterGeometry,
  type CutterTip,
  type ReliefCarveOptions,
  type ToolpathSegment,
  type StockTransform,
  type ReliefCarveResult,
} from './reliefOptions';
export {
  MAX_REACH_DIAMETERS,
  MAX_AVAILABLE_REACH_DIAMETERS,
  describeCutter,
  chiploadMm,
  STANDARD_BIT_DIAS,
  recommendReliefTooling,
  deriveReliefFeeds,
  adaptiveBiteFraction,
  type ReliefToolingInput,
  type DerivedReliefSettings,
  type ReliefOverrides,
} from './reliefTooling';
export {
  measureDetailMm,
  sampleHeightmap,
  buildHeightmap,
  findUndercut,
  dilateForTool,
  toolTipHeightAt,
  type Undercut,
  type ToolBodySection,
  type Heightmap,
} from './reliefHeightmap';
export { flatLevels, squareUpWalls, higherWaterlinesNear } from './reliefPaths';
export {
  OVERRUN_PAST_EDGE_MM,
  openEdges,
  type SurfaceJob,
  type OpenEdges,
  type SurfaceMachiningResult,
} from './surfaceJob';
export { machineSurface } from './machineSurface';
export { countLoosePieces, addHoldingTabs, type HoldingTabOptions } from './holdingTabs';

/** Beyond this the heightmap costs more than the extra fidelity is worth. */
const MAX_HEIGHTMAP_CELLS = 260_000;


const reliefPlaceSampleCache = new WeakMap<
  object,
  Map<string, { surface: Heightmap; gap: Float32Array }>
>();

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
    roughingTimeSeconds: 0,
    roughingPassCount: 0,
    roughingBitePercent: 0,
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

  // The raster is inset by the finishing tool's radius so the cutter stays over
  // the stock, which is also the area a fitted model has to land inside. The
  // dilation itself is `machineSurface`'s business; this wrapper only fits the
  // model into the reachable rectangle.
  const finishRad = Math.max(0.05, opts.finishingToolDiaMm / 2);
  const stepover = Math.max(
    0.05,
    (opts.finishingToolDiaMm * Math.min(100, Math.max(2, opts.finishingStepoverPercent))) / 100
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

  // Only a model that runs past the stock itself is cropped. The usable
  // rectangle above is where the cutter's *centre* may go; the surface is
  // still sampled, and cut by the cutter's flank, right out to the stock's
  // edge. Comparing against it made every board the size of its stock -- a
  // generated pattern panel, always -- report itself as overhanging. Half a
  // millimetre of slack absorbs a generated board's sub-cell rounding.
  const OVERHANG_SLACK_MM = 0.5;
  const footprintFits = modelW <= stockW + OVERHANG_SLACK_MM && modelD <= stockD + OVERHANG_SLACK_MM;
  // An intaglio's holes are where the model has nothing, so its cast has
  // nothing there either and the mold stays solid; through-cutting it would
  // only punch the model's peaks out of the back. Cut Through is a cameo's.
  const cutThrough = opts.invertRelief ? 0 : Math.max(0, opts.cutThroughMm ?? 0);
  if (opts.invertRelief && (opts.cutThroughMm ?? 0) > 0) {
    warnings.push('Cut Through applies only to a raised (cameo) relief, so this intaglio keeps 1 mm under its deepest cut.');
  }
  const maxDepthForStock = Math.max(0.1, opts.stockThicknessMm - 1);

  // Model centre lands on the stock centre; the model's highest point lands on
  // the stock's top face. Centre of the stock in work coordinates, which with a
  // corner origin is half the stock rather than zero.
  const cx = (mnX + mxX) / 2;
  const cy = (mnY + mxY) / 2;
  const stockCx = stockW / 2;
  const stockCy = stockD / 2;

  // --- Sampling grid ---------------------------------------------------------
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

  // Puts the model on the stock at a plan scale and a height scale, and
  // samples it from above. Cells the model does not cover are marked, not
  // floored, so that a model whose own lowest face sits exactly on the floor
  // is not mistaken for bare background and left uncut. The hidden gaps are
  // counted down to the stock's underside: below that nothing is cut anyway.
  const placeAndSample = (scale: number, zs: number) => {
    const cacheKey = `${cx},${cy},${mxZ},${stockCx},${stockCy},${bounds.minX},${bounds.minY},${bounds.maxX},${bounds.maxY},${cols},${rows},${opts.stockThicknessMm},${scale},${zs}`;
    let perScene = reliefPlaceSampleCache.get(sceneTris);
    if (perScene) {
      const cached = perScene.get(cacheKey);
      if (cached) {
        return {
          surface: { ...cached.surface, z: new Float32Array(cached.surface.z) },
          gap: new Float32Array(cached.gap),
        };
      }
    } else {
      perScene = new Map();
      reliefPlaceSampleCache.set(sceneTris, perScene);
    }
    const placed = new Float64Array(sceneTris.length);
    for (let i = 0; i < sceneTris.length; i += 3) {
      placed[i] = (sceneTris[i] * 1000 - cx) * scale + stockCx;
      placed[i + 1] = (sceneTris[i + 1] * 1000 - cy) * scale + stockCy;
      placed[i + 2] = (sceneTris[i + 2] * 1000 - mxZ) * zs;
    }
    const gap = new Float32Array(cols * rows);
    const hm = buildHeightmap(placed, bounds, cols, rows, -Infinity, {
      gap,
      floorZ: -opts.stockThicknessMm,
    });
    if (perScene.size >= 8) {
      const oldest = perScene.keys().next().value;
      if (oldest !== undefined) perScene.delete(oldest);
    }
    perScene.set(cacheKey, {
      surface: { ...hm, z: new Float32Array(hm.z) },
      gap: new Float32Array(gap),
    });
    return { surface: hm, gap };
  };

  // --- Which height mode -----------------------------------------------------
  // 'model' needs the sampled surface to know how deep it is, so for 'auto' it
  // is tried first whenever the footprint fits, and given up only if the
  // depth then does not.
  const requested = opts.verticalScaleMode;
  let heightMode: 'fill' | 'proportional' | 'model' = requested === 'auto' ? 'fill' : requested;
  let sampled: ReturnType<typeof placeAndSample> | null = null;
  let modelDepth = 0;
  if (requested === 'model' || (requested === 'auto' && footprintFits)) {
    sampled = placeAndSample(1, 1);
    const lowest = lowestInteriorZ(sampled.surface);
    modelDepth = Number.isFinite(lowest) ? Math.max(0.1, -lowest) : modelH;
    if (requested === 'model' || cutThrough > 0 || modelDepth <= maxDepthForStock + 1e-6) {
      heightMode = 'model';
    } else {
      sampled = null;
      warnings.push(
        `The model needs ${modelDepth.toFixed(1)} mm of depth and the ${opts.stockThicknessMm} mm stock ` +
          `has ${maxDepthForStock.toFixed(1)} mm to give, so its height is scaled to fit. Use thicker ` +
          `stock to cut it at its own size.`
      );
    }
  } else if (requested === 'auto') {
    warnings.push(
      `The model (${modelW.toFixed(0)} x ${modelD.toFixed(0)} mm) is bigger than the ${stockW} x ` +
        `${stockD} mm stock, so it is scaled to fit. Use bigger stock to cut it at its own size.`
    );
  }
  const asModelled = heightMode === 'model';

  const scaleFactor = asModelled
    ? 1
    : opts.fitMode === 'fit'
      ? fitScale
      : Math.max(0.01, opts.scalePercent / 100);

  const overhang = Math.max(modelW * scaleFactor - stockW, modelD * scaleFactor - stockD);
  if (asModelled && overhang > OVERHANG_SLACK_MM) {
    const wider = modelW - stockW;
    const deeper = modelD - stockD;
    warnings.push(
      wider >= deeper
        ? `The model is ${wider.toFixed(1)} mm wider than your stock (${modelW.toFixed(1)} vs ${stockW} mm). ` +
            `Anything past the edge is cropped.`
        : `The model is ${deeper.toFixed(1)} mm deeper than your stock (${modelD.toFixed(1)} vs ${stockD} mm). ` +
            `Anything past the edge is cropped.`
    );
  } else if (!asModelled && opts.fitMode === 'manual' && overhang > OVERHANG_SLACK_MM) {
    const fitsStock = Math.min(stockW / modelW, stockD / modelD);
    warnings.push(
      `At ${opts.scalePercent}% the model is ${(modelW * scaleFactor).toFixed(0)} x ` +
        `${(modelD * scaleFactor).toFixed(0)} mm and overhangs the stock — anything past the edge is ` +
        `cropped. Fit to Stock, or the model resized to ${Math.floor(fitsStock * 100)}%, makes it fit.`
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
  //
  // 'model' is neither: Z is 1:1 and the depth is what the model shows from
  // above, so there is no number to set at all.
  const proportional = heightMode === 'proportional';
  const exaggeration = Math.max(0.01, opts.verticalExaggeration);
  let zScale = asModelled ? 1 : proportional ? scaleFactor * exaggeration : carveDepth / modelH;
  const wantedDepth = asModelled ? modelDepth : modelH * zScale;
  let reliefDepth = asModelled ? modelDepth : Math.min(carveDepth, wantedDepth);

  if (proportional && wantedDepth > carveDepth + 1e-6) {
    warnings.push(
      `At ${(scaleFactor * 100).toFixed(0)}% plan scale and ${exaggeration}x exaggeration the model ` +
        `wants ${wantedDepth.toFixed(1)} mm of depth, more than the ${carveDepth} mm allowed, so ` +
        `everything below that is flattened onto the floor. Raise the relief depth or drop the ` +
        `exaggeration to ${(carveDepth / (modelH * scaleFactor)).toFixed(2)}x.`
    );
  }

  // 'fill' targets carveDepthMm directly, unrelated to the X/Y fit-to-stock scale
  // above, so a depth that no longer fits the stock is auto-reduced the same way
  // the footprint is — the operator set a stock size, not a depth percentage.
  // 'proportional' ties depth to plan scale and exaggeration instead; clamping it
  // here would silently change that ratio, so it stays a warning to fix by hand.
  if (cutThrough > 0) {
    // A through-cut is a depth the operator asked for by name, not one to
    // second-guess: the stock and a skim of spoilboard, and no less.
    reliefDepth = opts.stockThicknessMm + cutThrough;
    warnings.push(
      `Cuts through ${opts.stockThicknessMm} mm stock and ${cutThrough} mm into the spoilboard.`
    );
  } else if (asModelled && reliefDepth > maxDepthForStock) {
    warnings.push(
      `The model needs ${reliefDepth.toFixed(1)} mm of depth; the stock is ${opts.stockThicknessMm} mm ` +
        `and 1 mm is kept under the cut, so everything below ${maxDepthForStock.toFixed(1)} mm is ` +
        `flattened onto the floor.`
    );
    reliefDepth = maxDepthForStock;
  } else if (!proportional && !asModelled && reliefDepth > maxDepthForStock) {
    warnings.push(
      `Relief depth reduced to ${maxDepthForStock.toFixed(1)} mm to leave 1 mm under the ` +
        `${opts.stockThicknessMm} mm stock (requested ${reliefDepth.toFixed(1)} mm).`
    );
    reliefDepth = maxDepthForStock;
  } else if (proportional && reliefDepth > opts.stockThicknessMm - 1) {
    warnings.push(
      `A ${reliefDepth.toFixed(1)} mm relief in ${opts.stockThicknessMm} mm stock leaves under 1 mm ` +
        `underneath. Cut the relief depth, lower the exaggeration, or use thicker stock.`
    );
  }
  if (!proportional && !asModelled) {
    zScale = reliefDepth / modelH;
  }

  const floorZ = -reliefDepth;

  const carveBounds = {
    minX: Math.max(bounds.minX, stockCx - (modelW * scaleFactor) / 2),
    minY: Math.max(bounds.minY, stockCy - (modelD * scaleFactor) / 2),
    maxX: Math.min(bounds.maxX, stockCx + (modelW * scaleFactor) / 2),
    maxY: Math.min(bounds.maxY, stockCy + (modelD * scaleFactor) / 2),
  };

  // --- Sample the surface ----------------------------------------------------
  const { surface, gap } = sampled ?? placeAndSample(scaleFactor, zScale);

  // What a cutter from above cannot reach. Said out loud when the model is
  // being cut as modelled, because then it is the part's real shape being
  // lost (a phone slot that leans, a lip). A scaled relief is a picture of a
  // shape, and its undersides were never going to be cut; the figure is still
  // in the result for anyone who asks.
  const undercut = findUndercut(gap, surface);
  if (undercut && asModelled) {
    const b = undercut.bounds;
    warnings.push(
      `Undercut region (~${Math.round(undercut.areaMm2)} mm², ~${Math.round(undercut.volumeMm3)} mm³, up to ${undercut.maxMm.toFixed(1)} mm deep near X ${b.minX.toFixed(0)}–${b.maxX.toFixed(0)} Y ${b.minY.toFixed(0)}–${b.maxY.toFixed(0)} mm) is occluded from +Z and left solid.`
    );
  }

  const backgroundMode =
    opts.backgroundMode === 'auto' ? (asModelled ? 'skip' : 'carve') : opts.backgroundMode;
  // An intaglio has no background to carve: round the impression is the
  // stock face, the model's lowest level, whatever Background says.
  if (!opts.invertRelief && asModelled && backgroundMode === 'skip' && (modelW < stockW - 1 || modelD < stockD - 1)) {
    warnings.push(
      `The model (${modelW.toFixed(1)} x ${modelD.toFixed(1)} mm) is smaller than the stock, and the board ` +
        `round it is left uncut. Set Background to Carve to cut it down to the floor.`
    );
  }
  const backgroundZ = backgroundMode === 'skip' ? 0 : floorZ;
  // Which sides of the model end in a face; see `endFaces`.
  let edgeFaces: OpenEdges = { minX: false, maxX: false, minY: false, maxY: false };
  if (opts.invertRelief) {
    for (let i = 0; i < surface.z.length; i++) {
      if (surface.z[i] === -Infinity) {
        surface.z[i] = 0;
      } else {
        const clampedZ = Math.max(floorZ, Math.min(0, surface.z[i]));
        surface.z[i] = -reliefDepth - clampedZ;
      }
    }
  } else {
    // In a through-cut, a cell with no surface inside the model's footprint is
    // one of its holes and goes to the floor; outside the footprint it is
    // background like any other.
    const inFootprint = (i: number): boolean => {
      if (cutThrough <= 0) return false;
      const x = surface.minX + (i % surface.cols) * surface.stepX;
      const y = surface.minY + Math.floor(i / surface.cols) * surface.stepY;
      return x >= carveBounds.minX && x <= carveBounds.maxX && y >= carveBounds.minY && y <= carveBounds.maxY;
    };
    const faces = endFaces(surface, carveBounds);
    edgeFaces = faces;
    fillGrazedEdges(surface, carveBounds, faces);
    if (backgroundMode === 'skip' && cutThrough <= 0) {
      bridgeOuterEdgeBevel(surface, carveBounds, reliefDepth);
    }
    for (let i = 0; i < surface.z.length; i++) {
      if (surface.z[i] === -Infinity) surface.z[i] = inFootprint(i) ? floorZ : backgroundZ;
      else if (surface.z[i] < floorZ) surface.z[i] = floorZ;
    }
    // An uncut margin would close every groove that runs off the model, so
    // what leaves the model below the top face carries on to the board's edge.
    if (backgroundMode === 'skip' && cutThrough <= 0 && extendOpenEdges(surface, carveBounds, faces)) {
      warnings.push(
        'Where the model runs off its edge below the top face, the cut is carried on through the ' +
          'uncut board to the stock edge, so an open-ended groove comes out open.'
      );
    }
  }

  // Sides the cut leaves the stock through, where the cutter runs past the
  // edge: where the model itself reaches the edge, or was carried out to it
  // through an uncut margin. A carved background reaching every edge at the
  // floor is not the model running off.
  const reaches = (gap: number) => gap <= res;
  const carried = backgroundMode === 'skip' && cutThrough <= 0;
  const runOff = opts.invertRelief
    ? null
    : openEdges(surface, {
        sides: {
          minX: reaches(carveBounds.minX - bounds.minX) || (carried && edgeFaces.minX),
          maxX: reaches(bounds.maxX - carveBounds.maxX) || (carried && edgeFaces.maxX),
          minY: reaches(carveBounds.minY - bounds.minY) || (carried && edgeFaces.minY),
          maxY: reaches(bounds.maxY - carveBounds.maxY) || (carried && edgeFaces.maxY),
        },
        span: carveBounds,
      });
  const reachRad = Math.max(finishRad, opts.roughingEnabled ? opts.roughingToolDiaMm / 2 : 0);
  const overrunMm = reachRad + OVERRUN_PAST_EDGE_MM;
  if (runOff) {
    const named = [
      runOff.minX ? 'X0' : null,
      runOff.maxX ? `X${f(stockW)}` : null,
      runOff.minY ? 'Y0' : null,
      runOff.maxY ? `Y${f(stockD)}` : null,
    ].filter(Boolean);
    warnings.push(
      `Toolpath extends ${overrunMm.toFixed(1)} mm past stock edge at ${named.join(', ')}; keep clamps clear.`
    );
  }
  const frameBounds = runOff
    ? {
        minX: runOff.minX ? bounds.minX - overrunMm : carveBounds.minX,
        minY: runOff.minY ? bounds.minY - overrunMm : carveBounds.minY,
        maxX: runOff.maxX ? bounds.maxX + overrunMm : carveBounds.maxX,
        maxY: runOff.maxY ? bounds.maxY + overrunMm : carveBounds.maxY,
      }
    : carveBounds;

  if (cutThrough > 0) {
    let loose = countLoosePieces(surface, -opts.stockThicknessMm, res);
    if (loose > 0 && opts.holdingTabs !== false) {
      const freed = loose;
      const height = Math.min(Math.max(0.2, opts.tabHeightMm ?? 2), opts.stockThicknessMm * 0.8);
      const placed = addHoldingTabs(surface, -opts.stockThicknessMm, res, {
        heightMm: height,
        widthMm: Math.max(0.5, opts.tabWidthMm ?? 6),
        spacingMm: 80,
      });
      loose = placed.loose;
      if (placed.tabs > 0) {
        warnings.push(
          `Placed ${placed.tabs} holding tab${placed.tabs === 1 ? '' : 's'} (${height} mm thick) across ${freed} cut-free piece${freed === 1 ? '' : 's'}.`
        );
      }
    }
    if (loose > 0) {
      warnings.push(
        `${loose} cut-free piece${loose === 1 ? ' has' : 's have'} no holding tabs; secure separately before cutting through.`
      );
    }
  }

  const detailMm = measureDetailMm(surface, reliefDepth);

  const header = [
    '; 3D CNC Relief Carving',
    `; Stock       : ${stockW} x ${stockD} x ${opts.stockThicknessMm} mm`,
    `; Relief depth: ${reliefDepth.toFixed(2)} mm below the top face`,
    `; Model scale : ${(scaleFactor * 100).toFixed(1)}% (${(modelW * scaleFactor).toFixed(1)} x ${(modelD * scaleFactor).toFixed(1)} mm)`,
    asModelled
      ? '; Height      : as modelled, 1:1'
      : `; Height      : ${(zScale / Math.max(1e-9, scaleFactor)).toFixed(1)}x the plan scale`,
    '; Origin      : near-left corner of the stock, top face, Z0',
    runOff
      ? `; Extents     : X${f(frameBounds.minX)}..${f(frameBounds.maxX)}  Y${f(frameBounds.minY)}..${f(frameBounds.maxY)} (runs past the board edge where the model does)`
      : `; Extents     : X0..${f(stockW)}  Y0..${f(stockD)} (all cuts are +X +Y of zero)`,
  ];

  const cut = machineSurface(
    { surface, bounds, depthMm: reliefDepth, resolution: res, header, runOff },
    opts,
    warnings
  );
  if (!cut.success) return empty(cut.error ?? 'The carve produced no toolpath.');

  return {
    success: true,
    gcode: cut.gcode,
    totalCutDistanceMm: cut.totalCutDistanceMm,
    estimatedTimeSeconds: cut.estimatedTimeSeconds,
    roughingTimeSeconds: cut.roughingTimeSeconds,
    roughingPassCount: cut.roughingPassCount,
    roughingBitePercent: cut.roughingBitePercent,
    finishingRasterLines: cut.finishingRasterLines,
    toolChange: cut.toolChange,
    scaleFactor,
    reliefDepthMm: reliefDepth,
    detailMm,
    verticalExaggeration: zScale / Math.max(1e-9, scaleFactor),
    heightMode,
    ...(undercut ? { undercut } : {}),
    carveBounds,
    ...(runOff ? { frameBounds } : {}),
    bounds,
    stockTransform: {
      modelOriginMm: [cx, cy, mxZ],
      workOriginMm: [stockCx, stockCy, 0],
      scale: [scaleFactor, scaleFactor, zScale],
      modelMinMm: [mnX, mnY, mnZ],
      modelMaxMm: [mxX, mxY, mxZ],
    },
    segments: cut.segments,
    warnings,
  };
}