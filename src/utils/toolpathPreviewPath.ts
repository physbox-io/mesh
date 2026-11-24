import type { ToolpathSegment } from './reliefCarveExporter';
import { clockMoves, type ClockedMove, type TimedMove } from './timeEstimate';
import type { MotionProfile } from './motionProfile';

/**
 * What the viewport needs to know about a job. A relief carve's result and a
 * solid machining side both satisfy it.
 */
export interface ToolpathPreviewResult {
  segments: ToolpathSegment[];
  estimatedTimeSeconds: number;
  /** Roughing share of `estimatedTimeSeconds`, when both passes ran. */
  roughingTimeSeconds?: number;
  /**
   * Z height (nominal stock mm) of the touch-off shelf at the tool change, when
   * non-zero. Post-M6 live `wpos.z` is shifted by `-finishingZOffsetMm`.
   */
  finishingZOffsetMm?: number;
  /** Footprint the job occupies on the stock, in machine mm. */
  carveBounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/** The settings the viewport draws or times the job with. */
export interface ToolpathPreviewOptions {
  stockWidthMm: number;
  stockDepthMm: number;
  stockThicknessMm: number;
  finishingToolDiaMm: number;
  roughingFeedrate: number;
  roughingPlungeRate?: number;
  finishingFeedrate: number;
  finishingPlungeRate: number;
  safeZ: number;
  motionProfile: MotionProfile;
}

/** Rapid traverse the preview animates retracts at, mm/min. */
const RAPID_MM_MIN = 3000;

/** Which pass a preview move belongs to, from the segment it was built from. */
export type ToolpathPass = 'roughing' | 'finishing';

/**
 * A preview move on the job clock, tagged with its pass. The pass is carried,
 * not inferred from the feed: with equal roughing and finishing feeds every
 * move used to colour as roughing, and the plunges into roughing (timed at the
 * finishing plunge rate) as finishing.
 */
export type PreviewMove = ClockedMove & { pass: ToolpathPass };

/**
 * The order the tool visits the preview's points, as one flat list of moves.
 *
 * The decimated segments are already in program order, so walking them and
 * putting a rapid between each pair reproduces the shape of the program: cut
 * the pass, lift, fly to the head of the next one, drop in. Those rapids are a
 * real share of a raster job's clock and a real part of what the animation has
 * to show, because a job whose retracts are invisible looks like it is cutting
 * continuously when in fact it spends a third of its life in the air.
 *
 * This is a preview of the toolpath rather than a second parse of the file: the
 * points are decimated and the lead-in ramps are not in them. The total is
 * therefore rescaled to the exporter's own figure, which *is* taken off the
 * finished program — so the clock at the bottom of the animation and the "Est.
 * Time" above it are the same number, and the playhead's local pace still slows
 * where the machine will slow.
 */
export function buildPreviewPath(
  result: ToolpathPreviewResult,
  options: ToolpathPreviewOptions
): { moves: PreviewMove[]; seconds: number } {
  const raw: Array<TimedMove & { pass: ToolpathPass }> = [];
  let at: { x: number; y: number; z: number } | null = null;

  for (const seg of result.segments) {
    if (seg.points.length === 0) continue;
    const pass: ToolpathPass = seg.type === 'roughing' ? 'roughing' : 'finishing';
    const feed = pass === 'roughing' ? options.roughingFeedrate : options.finishingFeedrate;
    const head = seg.points[0];

    if (at) {
      /*
       * Up, across, down — the retract the exporter writes between passes.
       *
       * At the height the exporter actually chose, not at `safeZ`. It clears
       * only what stands between the two passes now, which on a raster of
       * closely spaced lines is a fraction of the full retract — and an
       * estimate still modelling the old round trip would quote a job hours
       * longer than the one about to run.
       */
      const hop = seg.traverseZ ?? options.safeZ;
      // Never below where the tool already is: the exporter does not descend
      // to traverse, it only lifts if it has to.
      const over = Math.max(hop, at.z);
      const plungeFeed = Math.max(
        1,
        pass === 'roughing'
          ? (options.roughingPlungeRate ?? options.finishingPlungeRate)
          : options.finishingPlungeRate
      );
      if (over > at.z + 1e-6) {
        raw.push({ x1: at.x, y1: at.y, z1: at.z, x2: at.x, y2: at.y, z2: over, feed: RAPID_MM_MIN, rapid: true, pass });
      }
      if (Math.hypot(head.x - at.x, head.y - at.y) > 1e-6) {
        raw.push({ x1: at.x, y1: at.y, z1: over, x2: head.x, y2: head.y, z2: over, feed: RAPID_MM_MIN, rapid: true, pass });
      }
      if (Math.abs(head.z - over) > 1e-6) {
        raw.push({ x1: head.x, y1: head.y, z1: over, x2: head.x, y2: head.y, z2: head.z, feed: plungeFeed, rapid: false, pass });
      }
    }

    for (let i = 0; i + 1 < seg.points.length; i++) {
      const a = seg.points[i];
      const b = seg.points[i + 1];
      raw.push({ x1: a.x, y1: a.y, z1: a.z, x2: b.x, y2: b.y, z2: b.z, feed, rapid: false, pass });
    }
    at = seg.points[seg.points.length - 1];
  }

  // The machine's own dynamics, so the playhead crawls through the dense parts
  // and flies through the open ones in the same places the tool will. The total
  // is rescaled below either way, but the *shape* of the clock is only right if
  // the acceleration and corner tolerance are the ones the controller reported.
  const clocked = clockMoves(raw, { profile: options.motionProfile });
  if (clocked.length === 0) return { moves: clocked, seconds: 0 };

  const previewTotal = clocked[clocked.length - 1].t1;
  const trueTotal = result.estimatedTimeSeconds;
  const trueRough = result.roughingTimeSeconds ?? 0;

  // When both passes are present and the exporter reported the roughing split,
  // rescale roughing and finishing separately so their transition on the preview
  // clock lands at the exact time the real program reaches M6. A single global
  // scale skews the split because roughing and finishing omit different shares
  // of lead-in ramps.
  let splitIdx = -1;
  if (trueRough > 0 && trueTotal > trueRough) {
    let seenRough = false;
    for (let i = 0; i < clocked.length; i++) {
      if (clocked[i].pass === 'roughing') {
        seenRough = true;
      } else if (seenRough) {
        splitIdx = i;
        break;
      }
    }
  }

  if (splitIdx > 0) {
    const previewRough = clocked[splitIdx - 1].t1;
    const previewFin = previewTotal - previewRough;
    const roughScale = previewRough > 1e-6 ? trueRough / previewRough : 1;
    const finScale = previewFin > 1e-6 ? (trueTotal - trueRough) / previewFin : 1;
    for (let i = 0; i < splitIdx; i++) {
      clocked[i].t0 *= roughScale;
      clocked[i].t1 *= roughScale;
    }
    for (let i = splitIdx; i < clocked.length; i++) {
      clocked[i].t0 = trueRough + (clocked[i].t0 - previewRough) * finScale;
      clocked[i].t1 = trueRough + (clocked[i].t1 - previewRough) * finScale;
    }
  } else {
    const scale = previewTotal > 1e-6 && trueTotal > 0 ? trueTotal / previewTotal : 1;
    if (scale !== 1) {
      for (const m of clocked) {
        m.t0 *= scale;
        m.t1 *= scale;
      }
    }
  }
  return { moves: clocked, seconds: clocked[clocked.length - 1].t1 };
}
