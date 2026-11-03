// What `machineSurface` is handed and what it hands back.

import type { Heightmap, ToolBodySection } from './reliefHeightmap';
import type { CutterTip, ReliefCarveOptions, ToolpathSegment } from './reliefOptions';
import { autoFluteLength, autoShankDia } from './reliefTooling';

/**
 * What `machineSurface` needs to know about the job that is not a tooling
 * option: the surface itself, and how to introduce the program.
 */
export interface SurfaceJob {
  /**
   * The surface the finished part presents to the spindle, undilated: the
   * height the material is to be left at under every cell, with the stock's
   * top face at 0 and nothing above it. Every cell finite.
   */
  surface: Heightmap;
  /** The stock block, in work coordinates. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number; minZ: number; maxZ: number };
  /** Deepest the cut goes below the top face, as a positive number of mm. */
  depthMm: number;
  /** Pitch the surface was sampled at, mm. Passes are laid out on it. */
  resolution: number;
  /** Comment lines describing the job, written at the head of the program. */
  header: string[];
  /**
   * Lines run after the spindle is up and before roughing begins. Anything
   * here must leave the tool at safe Z over the work origin, because the path
   * that follows assumes that is where it is.
   */
  prelude?: string[];
  /** What the depth is called in warnings: 'relief' or 'cut'. */
  noun?: string;
  /**
   * Sides of the stock the surface runs off below the top face (`openEdges`),
   * where the tool centre may go past the edge instead of stopping a radius
   * inside it. Absent, every side holds the cutter on the stock as before.
   */
  runOff?: OpenEdges | null;
}

/** Which sides of the stock a surface leaves at, below its top face. */
export interface OpenEdges {
  minX: boolean;
  maxX: boolean;
  minY: boolean;
  maxY: boolean;
}

/** Below the top face by more than this at the stock's edge, a side is open. */
export const OPEN_EDGE_MM = 0.05;
/**
 * How far past an open edge the tool centre goes, mm. A ball or V tip cuts its
 * full depth only under its centre, so stopping a radius inside the edge left
 * a groove that runs off the part closed by a ramp at each end.
 */
export const OVERRUN_PAST_EDGE_MM = 0.5;

/**
 * The sides where the finished surface meets the stock's edge below the top
 * face: a groove or a step that runs off the part. Null when there are none,
 * which is what keeps a closed model's program unchanged.
 *
 * `only` limits it to the sides that may count and the stretch of each edge
 * to look along: a relief's carved background is below the top face at every
 * edge, and is not a feature running off the board.
 */
export function openEdges(
  hm: Heightmap,
  only?: { sides: OpenEdges; span: { minX: number; minY: number; maxX: number; maxY: number } }
): OpenEdges | null {
  const below = (k: number) => hm.z[k] < -OPEN_EDGE_MM;
  const r0 = only ? Math.max(0, Math.ceil((only.span.minY - hm.minY) / (hm.stepY || 1) - 1e-6)) : 0;
  const r1 = only ? Math.min(hm.rows - 1, Math.floor((only.span.maxY - hm.minY) / (hm.stepY || 1) + 1e-6)) : hm.rows - 1;
  const c0 = only ? Math.max(0, Math.ceil((only.span.minX - hm.minX) / (hm.stepX || 1) - 1e-6)) : 0;
  const c1 = only ? Math.min(hm.cols - 1, Math.floor((only.span.maxX - hm.minX) / (hm.stepX || 1) + 1e-6)) : hm.cols - 1;
  const may = only?.sides ?? { minX: true, maxX: true, minY: true, maxY: true };
  const sides: OpenEdges = { minX: false, maxX: false, minY: false, maxY: false };
  for (let r = r0; r <= r1; r++) {
    if (may.minX && below(r * hm.cols)) sides.minX = true;
    if (may.maxX && below(r * hm.cols + hm.cols - 1)) sides.maxX = true;
  }
  for (let c = c0; c <= c1; c++) {
    if (may.minY && below(c)) sides.minY = true;
    if (may.maxY && below((hm.rows - 1) * hm.cols + c)) sides.maxY = true;
  }
  return sides.minX || sides.maxX || sides.minY || sides.maxY ? sides : null;
}

/** What `machineSurface` hands back — the program and the numbers about it. */
export interface SurfaceMachiningResult {
  success: boolean;
  error?: string;
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
  /** Decimated toolpath polylines for the 3D preview. */
  segments: ToolpathSegment[];
}

/*
 * What the rest of the tool needs to clear.
 *
 * Small bits come on a shank fatter than the bit — a 1.6 mm cutter is ground
 * on a 3.175 mm blank — and catalogue cutting lengths sit around three
 * diameters. Those two are properties of the bit and can be guessed. The
 * stickout and the size of the nut are properties of how the user set the job
 * up, so those are only checked when they say.
 */
export const bodyFor = (
  opts: ReliefCarveOptions,
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

/**
 * The rectangle the tool *centre* may enter: the stock, inset by the tool's
 * own radius, except on a side the surface runs off (`job.runOff`), where it
 * goes past the edge so a feature open at the part's edge comes out open.
 * Past the edge the dilated map is read at its border, which only ever
 * holds the cutter higher than it needs to be. On stock narrower than the
 * cutter it collapses to the centre line rather than inverting.
 */
export const centreWindow = (job: SurfaceJob, rad: number) => {
  const bounds = job.bounds;
  const open = job.runOff;
  const midX = (bounds.minX + bounds.maxX) / 2, midY = (bounds.minY + bounds.maxY) / 2;
  return {
    minX: open?.minX ? bounds.minX - OVERRUN_PAST_EDGE_MM : Math.min(bounds.minX + rad, midX),
    maxX: open?.maxX ? bounds.maxX + OVERRUN_PAST_EDGE_MM : Math.max(bounds.maxX - rad, midX),
    minY: open?.minY ? bounds.minY - OVERRUN_PAST_EDGE_MM : Math.min(bounds.minY + rad, midY),
    maxY: open?.maxY ? bounds.maxY + OVERRUN_PAST_EDGE_MM : Math.max(bounds.maxY - rad, midY),
  };
};
