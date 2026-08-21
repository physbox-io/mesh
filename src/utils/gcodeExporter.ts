// ---------------------------------------------------------------------------
// G-Code Generator Engine for Laser Cutters & CNC Routers
// ---------------------------------------------------------------------------

import type { LaserPanel, Point2D } from './laserCutExporter';
import type { ContourSliceResult } from './contourSliceExporter';

export interface GcodeExportOptions {
  machineMode: 'laser' | 'cnc';
  /**
   * Controller's maximum S-value, i.e. GRBL's `$30` (default 1000). This is a
   * per-machine setting, not a standard: stock GRBL ships 1000, but plenty of
   * diode-laser boards ship 10000. Sending S1000 to a `$30=10000` machine runs
   * the tube at 10% power, which looks like a weak laser rather than a
   * misconfiguration. Check `$$` on the machine and set this to match.
   */
  laserMaxPower: number;
  /** Laser power for cutting, as an S-value in 0..laserMaxPower. */
  laserPower: number;
  /** Low laser power for guide framing, as an S-value on the $30=1000 scale (default 5 = 0.5%). Rescaled to laserMaxPower on output. */
  laserGuidePower: number;
  /** Number of times the laser retraces each cut path (default 1). */
  laserPasses: number;
  /** Cut feedrate in mm/min (default 1200). */
  cutFeedrate: number;
  /** Travel rapid move feedrate in mm/min (default 3000). */
  travelFeedrate: number;
  /** CNC Z-axis plunge feedrate in mm/min (default 300). */
  plungeFeedrate: number;
  /** CNC Z safe height above bed in mm (default 5.0). */
  safeZ: number;
  /** Total cut depth in mm for CNC (default 3.0). */
  cutDepthZ: number;
  /** Depth per pass for CNC in mm (default 3.0). */
  zStepdown: number;
  /** Spindle speed in RPM for CNC (default 12000). */
  spindleRpm: number;
  /** Insert M0 pause between material sheets. */
  pauseBetweenSheets: boolean;
  /** Insert T<N> M6 pause for tool changes. */
  pauseOnToolChange: boolean;
  /**
   * Leave short stretches of every part outline uncut, so finished parts stay
   * held in the stock instead of dropping out mid-job. Nothing to do with the
   * finger/mortise tabs of the joinery — these are sacrificial and get snapped
   * or pared off after the sheet comes off the machine.
   */
  attachmentsEnabled: boolean;
  /** Length of each attachment measured along the cut path, in mm. */
  attachmentWidthMm: number;
  /** Target distance between attachments along a cut path, in mm. */
  attachmentSpacingMm: number;
  /**
   * CNC only: stock left under the cutter as it rides over an attachment, in mm.
   * A laser has no Z, so its attachments are simply gaps in the cut and this is
   * ignored.
   */
  attachmentHeightMm: number;
}

export const DEFAULT_GCODE_OPTIONS: GcodeExportOptions = {
  machineMode: 'laser',
  // 10000 is both the commoner diode-board $30 and the safer guess: GRBL clamps an
  // S-value above $30 down to $30, so overshooting a $30=1000 machine still cuts at
  // full power, while undershooting a $30=10000 machine quietly runs it at 10%.
  laserMaxPower: 10000,
  laserPower: 10000,
  laserGuidePower: 5,
  laserPasses: 1,
  cutFeedrate: 1200,
  travelFeedrate: 3000,
  plungeFeedrate: 300,
  safeZ: 5.0,
  cutDepthZ: 3.0,
  zStepdown: 3.0,
  spindleRpm: 12000,
  pauseBetweenSheets: true,
  pauseOnToolChange: true,
  attachmentsEnabled: false,
  attachmentWidthMm: 4.0,
  attachmentSpacingMm: 80.0,
  attachmentHeightMm: 0.6,
};

export interface GcodeOperation {
  id: string;
  name: string;
  type: 'framing' | 'cut' | 'engrave' | 'pause_sheet' | 'pause_tool';
  sheetIndex: number;
  toolNumber?: number;
}

export interface GcodeExportResult {
  success: boolean;
  gcode: string;
  totalCutDistanceMm: number;
  estimatedTimeSeconds: number;
  sheetCount: number;
  operations: GcodeOperation[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** How many holding attachments were left across the whole job. */
  attachmentCount: number;
  error?: string;
}

/** Cut S-value, clamped to the controller's $30 ceiling. */
function laserS(options: GcodeExportOptions): number {
  const ceiling = Math.max(1, Math.round(options.laserMaxPower));
  return Math.max(0, Math.min(ceiling, Math.round(options.laserPower)));
}

/** Guide S-value, authored on the $30=1000 scale and rescaled to this machine. */
function laserGuideS(options: GcodeExportOptions): number {
  const ceiling = Math.max(1, Math.round(options.laserMaxPower));
  const scaled = Math.round(options.laserGuidePower * (ceiling / 1000));
  return Math.max(1, Math.min(ceiling, scaled));
}

/** How many times each cut path is traced. Only the laser retraces in XY; CNC steps down in Z instead. */
function laserPassCount(options: GcodeExportOptions): number {
  if (options.machineMode !== 'laser') return 1;
  return Math.max(1, Math.round(options.laserPasses));
}

function polygonPerimeter(pts: Point2D[]): number {
  let len = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    len += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return len;
}

/** Formats a G-code coordinate number to 3 decimal places. */
function f(num: number): string {
  return num.toFixed(3);
}

// ---------------------------------------------------------------------------
// Attachments — the uncut bridges that hold a finished part in the stock
// ---------------------------------------------------------------------------

/**
 * One attachment, as four arc-length marks along its loop.
 *
 * The flat run between `flatStart` and `flatEnd` is the attachment proper. The
 * ramps either side exist because a router cannot climb out of and drop back
 * into its own slot instantly: without them the far edge of every attachment is
 * a full-width plunge into uncut stock. A laser has nothing to lift, so its
 * ramps are zero-length and the two pairs coincide.
 */
interface AttachmentSpan {
  rampInStart: number;
  flatStart: number;
  flatEnd: number;
  rampOutEnd: number;
}

/**
 * Where to leave attachments around a loop of the given perimeter.
 *
 * Count comes from the requested spacing, but is capped so no attachment can
 * take more than half of the run it sits in — that keeps two of them from
 * merging into one long uncut stretch on a small part, and it is also what
 * guarantees no span straddles the loop's start point, so the emitters below
 * never have to deal with wrapping. A loop too short to hold even one gets
 * none, which is how small mortises and slots stay clean.
 */
function planAttachments(perimeterMm: number, options: GcodeExportOptions): AttachmentSpan[] {
  if (!options.attachmentsEnabled) return [];
  const width = Math.max(0.1, options.attachmentWidthMm);
  const ramp = options.machineMode === 'cnc'
    ? Math.max(0, Math.min(width, options.attachmentHeightMm))
    : 0;
  const span = width + 2 * ramp;
  const spacing = Math.max(span, options.attachmentSpacingMm);

  const maxCount = Math.floor(perimeterMm / (2 * span));
  const count = Math.min(maxCount, Math.round(perimeterMm / spacing));
  if (count < 1) return [];

  const spans: AttachmentSpan[] = [];
  for (let k = 0; k < count; k++) {
    const centre = ((k + 0.5) * perimeterMm) / count;
    spans.push({
      rampInStart: centre - span / 2,
      flatStart: centre - width / 2,
      flatEnd: centre + width / 2,
      rampOutEnd: centre + span / 2,
    });
  }
  return spans;
}

/** A loop vertex tagged with how far around the loop it sits. */
interface LoopPoint { x: number; y: number; s: number }

/**
 * The loop closed back onto its first point, with an extra vertex inserted
 * wherever an attachment starts or ends. Splitting the path up front means the
 * emitters only ever switch state at a vertex.
 */
function resampleLoop(loop: Point2D[], spans: AttachmentSpan[]): LoopPoint[] {
  const cuts: number[] = [];
  for (const sp of spans) cuts.push(sp.rampInStart, sp.flatStart, sp.flatEnd, sp.rampOutEnd);
  cuts.sort((a, b) => a - b);

  const out: LoopPoint[] = [{ x: loop[0].x, y: loop[0].y, s: 0 }];
  let s = 0;
  let next = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const end = s + len;
    while (next < cuts.length && cuts[next] < end) {
      const cut = cuts[next++];
      if (cut <= s || len <= 1e-9) continue; // already past it, or a zero-length edge
      const t = (cut - s) / len;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, s: cut });
    }
    s = end;
    out.push({ x: b.x, y: b.y, s });
  }
  return out;
}

/** Whether an arc-length position falls in the uncut middle of an attachment. */
function inFlat(s: number, spans: AttachmentSpan[]): boolean {
  for (const sp of spans) if (s > sp.flatStart - 1e-6 && s < sp.flatEnd + 1e-6) return true;
  return false;
}

/**
 * Cutting depth at a point on the loop: `cutZ` everywhere except over an
 * attachment, where the tool rises to `topZ` and ramps back down.
 */
function attachmentZ(s: number, spans: AttachmentSpan[], cutZ: number, topZ: number): number {
  for (const sp of spans) {
    if (s <= sp.rampInStart || s >= sp.rampOutEnd) continue;
    if (s >= sp.flatStart && s <= sp.flatEnd) return topZ;
    const t = s < sp.flatStart
      ? (s - sp.rampInStart) / Math.max(1e-9, sp.flatStart - sp.rampInStart)
      : (sp.rampOutEnd - s) / Math.max(1e-9, sp.rampOutEnd - sp.flatEnd);
    return cutZ + (topZ - cutZ) * t;
  }
  return cutZ;
}

/**
 * Generates G-code from 2D LaserCut panels.
 * Interior holes/mortises are cut FIRST, outer polygon outlines are cut LAST.
 */
export function generateLaserCutGcode(
  panels: LaserPanel[],
  userOptions?: Partial<GcodeExportOptions>
): GcodeExportResult {
  const options: GcodeExportOptions = { ...DEFAULT_GCODE_OPTIONS, ...userOptions };
  if (!panels || panels.length === 0) {
    return {
      success: false,
      gcode: '',
      totalCutDistanceMm: 0,
      estimatedTimeSeconds: 0,
      sheetCount: 0,
      operations: [],
      bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      attachmentCount: 0,
      error: 'No panels provided for G-code generation.',
    };
  }

  // Group by the sheet the packer nested each panel on. Placements are already
  // in sheet-local coordinates: every sheet is loaded against the same machine
  // zero, so sheet 3 cuts in the same square of bed that sheet 1 did.
  const sheetMap = new Map<number, LaserPanel[]>();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const p of panels) {
    const pos = p.placedPos2D || { x: 0, y: 0 };
    const sheetIdx = p.sheetIndex || 0;
    if (!sheetMap.has(sheetIdx)) sheetMap.set(sheetIdx, []);
    sheetMap.get(sheetIdx)!.push(p);

    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + (p.width2D || 50));
    maxY = Math.max(maxY, pos.y + (p.height2D || 50));
  }

  const sheetIndices = Array.from(sheetMap.keys()).sort((a, b) => a - b);
  const sheetCount = sheetIndices.length;
  const operations: GcodeOperation[] = [];

  let lines: string[] = [];
  lines.push(`; --------------------------------------------------`);
  lines.push(`; PhysBox Generated G-Code (${options.machineMode.toUpperCase()} Mode)`);
  lines.push(`; Date: ${new Date().toISOString()}`);
  lines.push(`; Total Sheets: ${sheetCount}, Total Panels: ${panels.length}`);
  if (options.machineMode === 'laser') {
    lines.push(`; Laser: S${laserS(options)} of $30=${Math.round(options.laserMaxPower)} max, ${laserPassCount(options)} pass(es)`);
  }
  if (options.attachmentsEnabled) {
    lines.push(
      `; Attachments: ${f(options.attachmentWidthMm)}mm every ~${f(options.attachmentSpacingMm)}mm` +
        (options.machineMode === 'cnc' ? `, ${f(options.attachmentHeightMm)}mm of stock left under each` : ` (beam off)`)
    );
  }
  lines.push(`; --------------------------------------------------`);
  lines.push(`G21 ; Units in millimeters`);
  lines.push(`G90 ; Absolute positioning`);
  lines.push(`G17 ; XY Plane selection`);

  if (options.machineMode === 'cnc') {
    lines.push(`G0 Z${f(options.safeZ)} ; Raise spindle to safe height`);
    lines.push(`M3 S${Math.round(options.spindleRpm)} ; Spindle ON`);
    lines.push(`G4 P2 ; Wait 2s for spindle to reach full speed`);
  }

  let totalCutDistanceMm = 0;
  let attachmentCount = 0;

  for (let sIdx = 0; sIdx < sheetIndices.length; sIdx++) {
    const sKey = sheetIndices[sIdx];
    const sheetPanels = sheetMap.get(sKey)!;

    if (sIdx > 0 && options.pauseBetweenSheets) {
      operations.push({
        id: `pause_sheet_${sIdx + 1}`,
        name: `Insert Material Sheet ${sIdx + 1} of ${sheetCount}`,
        type: 'pause_sheet',
        sheetIndex: sIdx,
      });

      lines.push(``);
      lines.push(`; --- PAUSE: MATERIAL SHEET SWAP ---`);
      if (options.machineMode === 'laser') lines.push(`M5 ; Laser OFF`);
      else {
        lines.push(`G0 Z${f(options.safeZ)}`);
        lines.push(`M5 ; Spindle OFF`);
      }
      lines.push(`G0 X0.000 Y0.000 ; Park head at origin`);
      lines.push(`M0 (PAUSE: Insert Material Sheet ${sIdx + 1} of ${sheetCount})`);
      if (options.machineMode === 'cnc') {
        lines.push(`M3 S${Math.round(options.spindleRpm)}`);
        lines.push(`G4 P2`);
      }
    }

    lines.push(``);
    lines.push(`; ==================================================`);
    lines.push(`; SHEET ${sIdx + 1} of ${sheetCount}`);
    lines.push(`; ==================================================`);

    for (const panel of sheetPanels) {
      const pos = panel.placedPos2D || { x: 0, y: 0 };
      lines.push(`; --- Panel: ${panel.name} ---`);

      // 1. Cut inner cutouts/mortises FIRST so material doesn't shift
      for (let cIdx = 0; cIdx < panel.innerCutouts2D.length; cIdx++) {
        const cutout = panel.innerCutouts2D[cIdx];
        if (cutout.length < 3) continue;

        operations.push({
          id: `${panel.id}_cutout_${cIdx}`,
          name: `${panel.name} Cutout #${cIdx + 1}`,
          type: 'cut',
          sheetIndex: sIdx,
        });

        totalCutDistanceMm += polygonPerimeter(cutout);
        lines.push(...generateLoopGcode(cutout, pos, options));
      }

      // 2. Cut outer boundary polygon LAST
      if (panel.outerPolygon2D.length >= 3) {
        operations.push({
          id: `${panel.id}_outer`,
          name: `${panel.name} Outline`,
          type: 'cut',
          sheetIndex: sIdx,
        });

        // Only the outline gets attachments: it is the cut that frees the panel,
        // and a bridge left across a mortise would block the tab meant to enter it.
        const spans = planAttachments(polygonPerimeter(panel.outerPolygon2D), options);
        attachmentCount += spans.length;
        totalCutDistanceMm += polygonPerimeter(panel.outerPolygon2D);
        lines.push(...generateLoopGcode(panel.outerPolygon2D, pos, options, spans));
      }
    }
  }

  // Program End
  lines.push(``);
  lines.push(`; --- PROGRAM END ---`);
  if (options.machineMode === 'laser') {
    lines.push(`M5 ; Laser OFF`);
    lines.push(`G0 X0.000 Y0.000 F${options.travelFeedrate} ; Rapid to origin`);
  } else {
    lines.push(`G0 Z${f(options.safeZ)} ; Retract Z`);
    lines.push(`M5 ; Spindle OFF`);
    lines.push(`G0 X0.000 Y0.000 F${options.travelFeedrate} ; Park X/Y`);
  }
  lines.push(`M30 ; End of program`);

  // Every laser pass retraces the whole path, so the head really does travel that far.
  totalCutDistanceMm *= laserPassCount(options);

  const estCutTimeSec = (totalCutDistanceMm / options.cutFeedrate) * 60;
  const estTravelTimeSec = sheetCount * 5;
  const estimatedTimeSeconds = Math.round(estCutTimeSec + estTravelTimeSec);

  return {
    success: true,
    gcode: lines.join('\n'),
    totalCutDistanceMm: Math.round(totalCutDistanceMm),
    estimatedTimeSeconds,
    sheetCount,
    operations,
    bounds: { minX, minY, maxX, maxY },
    attachmentCount,
  };
}

/**
 * Helper to generate G-code motion lines for a single closed loop.
 *
 * `spans` are the attachments to leave behind, empty for a loop that should be
 * cut clean through. Callers pass them only for loops that free a part — a
 * mortise slug is small enough to be harmless, and a bridge across one would
 * stop its tab entering.
 */
function generateLoopGcode(
  loop: Point2D[],
  offset: Point2D,
  options: GcodeExportOptions,
  spans: AttachmentSpan[] = []
): string[] {
  const lines: string[] = [];
  if (loop.length < 3) return lines;

  const startX = offset.x + loop[0].x;
  const startY = offset.y + loop[0].y;
  const path = resampleLoop(loop, spans);

  if (options.machineMode === 'laser') {
    // Laser Mode: G0 to start, M3 S<power>, G1 around loop (once per pass), M5.
    // The beam stays on between passes — the path is closed, so it ends where the
    // next pass begins and there is nothing to re-pierce.
    //
    // An attachment is just the beam going out for its length. The head keeps
    // moving at the cut feedrate rather than rapiding across, so the gap really
    // is the length asked for and the beam comes back on already up to speed.
    const passes = laserPassCount(options);
    lines.push(`G0 X${f(startX)} Y${f(startY)} F${options.travelFeedrate}`);
    lines.push(`M3 S${laserS(options)}`);
    for (let pass = 1; pass <= passes; pass++) {
      if (passes > 1) lines.push(`; Pass ${pass}/${passes}`);
      let beamOn = true;
      for (let i = 1; i < path.length; i++) {
        const p = path[i];
        // A segment is entirely inside or entirely outside an attachment, so its
        // midpoint decides — the resample already split it at every boundary.
        const gap = spans.length > 0 && inFlat((path[i - 1].s + p.s) / 2, spans);
        if (gap !== !beamOn) {
          lines.push(gap ? `M5 ; attachment` : `M3 S${laserS(options)}`);
          beamOn = !gap;
        }
        lines.push(`G1 X${f(offset.x + p.x)} Y${f(offset.y + p.y)} F${options.cutFeedrate}`);
      }
      if (!beamOn) lines.push(`M3 S${laserS(options)}`);
    }
    lines.push(`M5`);
  } else {
    // CNC Mode: Multi-pass depth slicing
    const totalDepth = Math.abs(options.cutDepthZ);
    const stepdown = Math.max(0.1, Math.abs(options.zStepdown));
    const passes = Math.ceil(totalDepth / stepdown);
    // The attachment's top surface. Clamped below the stock surface so a height
    // set at or above the cut depth cannot turn the whole outline into a no-op.
    const attachTopZ = -Math.max(0.1, totalDepth - Math.max(0, options.attachmentHeightMm));

    lines.push(`G0 X${f(startX)} Y${f(startY)} F${options.travelFeedrate}`);
    lines.push(`G0 Z${f(options.safeZ)}`);

    for (let pass = 1; pass <= passes; pass++) {
      const currentZ = -Math.min(totalDepth, pass * stepdown);
      lines.push(`; Pass ${pass}/${passes} (Z = ${f(currentZ)}mm)`);
      lines.push(`G1 Z${f(currentZ)} F${options.plungeFeedrate}`);

      // Only passes that reach below the attachment tops have to ride over them;
      // shallower ones are still cutting stock the attachment keeps anyway.
      const riding = spans.length > 0 && currentZ < attachTopZ - 1e-6;
      for (let i = 1; i < path.length; i++) {
        const p = path[i];
        const px = f(offset.x + p.x);
        const py = f(offset.y + p.y);
        if (riding) {
          const z = attachmentZ(p.s, spans, currentZ, attachTopZ);
          lines.push(`G1 X${px} Y${py} Z${f(z)} F${options.cutFeedrate}`);
        } else {
          lines.push(`G1 X${px} Y${py} F${options.cutFeedrate}`);
        }
      }
    }
    lines.push(`G0 Z${f(options.safeZ)}`);
  }

  return lines;
}

/** Generates low-power laser framing G-code trace around a bounding box. */
function formatNum(val: number): string { return val.toFixed(3); }

export function generateFramingGcode(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  userOptions?: Partial<GcodeExportOptions>
): string {
  const options: GcodeExportOptions = { ...DEFAULT_GCODE_OPTIONS, ...userOptions };
  const { minX, minY, maxX, maxY } = bounds;

  const lines: string[] = [
    `; --- LASER FRAMING / GUIDE TRACE ---`,
    `G21 ; mm`,
    `G90 ; absolute`,
    `G0 X${formatNum(minX)} Y${formatNum(minY)} F${options.travelFeedrate}`,
  ];

  if (options.machineMode === 'laser') {
    lines.push(`M3 S${laserGuideS(options)} ; Low power guide dot`);
    lines.push(`G1 X${formatNum(maxX)} Y${formatNum(minY)} F3000`);
    lines.push(`G1 X${formatNum(maxX)} Y${formatNum(maxY)} F3000`);
    lines.push(`G1 X${formatNum(minX)} Y${formatNum(maxY)} F3000`);
    lines.push(`G1 X${formatNum(minX)} Y${formatNum(minY)} F3000`);
    lines.push(`M5 ; Laser OFF`);
  } else {
    lines.push(`G0 Z${formatNum(options.safeZ)}`);
    lines.push(`G1 X${formatNum(maxX)} Y${formatNum(minY)} F3000`);
    lines.push(`G1 X${formatNum(maxX)} Y${formatNum(maxY)} F3000`);
    lines.push(`G1 X${formatNum(minX)} Y${formatNum(maxY)} F3000`);
    lines.push(`G1 X${formatNum(minX)} Y${formatNum(minY)} F3000`);
  }

  return lines.join('\n');
}

/** Generates G-code for Contour Slices (stacked relief map layers). */
export function generateContourSliceGcode(
  result: ContourSliceResult,
  userOptions?: Partial<GcodeExportOptions>
): GcodeExportResult {
  const options: GcodeExportOptions = { ...DEFAULT_GCODE_OPTIONS, ...userOptions };
  if (!result || !result.success || !result.layers) {
    return {
      success: false,
      gcode: '',
      totalCutDistanceMm: 0,
      estimatedTimeSeconds: 0,
      sheetCount: 0,
      operations: [],
      bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      attachmentCount: 0,
      error: 'Invalid contour slice result provided.',
    };
  }

  const layers = result.layers;
  const sheetCount = layers.length;
  const operations: GcodeOperation[] = [];

  let lines: string[] = [];
  lines.push(`; --------------------------------------------------`);
  lines.push(`; PhysBox Contour Slice Stack G-Code (${options.machineMode.toUpperCase()})`);
  lines.push(`; Layers: ${sheetCount}`);
  if (options.machineMode === 'laser') {
    lines.push(`; Laser: S${laserS(options)} of $30=${Math.round(options.laserMaxPower)} max, ${laserPassCount(options)} pass(es)`);
  }
  if (options.attachmentsEnabled) {
    lines.push(
      `; Attachments: ${f(options.attachmentWidthMm)}mm every ~${f(options.attachmentSpacingMm)}mm` +
        (options.machineMode === 'cnc' ? `, ${f(options.attachmentHeightMm)}mm of stock left under each` : ` (beam off)`)
    );
  }
  lines.push(`; --------------------------------------------------`);
  lines.push(`G21 ; mm`);
  lines.push(`G90 ; absolute`);
  lines.push(`G17 ; XY plane`);

  if (options.machineMode === 'cnc') {
    lines.push(`G0 Z${f(options.safeZ)}`);
    lines.push(`M3 S${Math.round(options.spindleRpm)}`);
    lines.push(`G4 P2`);
  }

  let totalCutDistanceMm = 0;
  let attachmentCount = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (let lIdx = 0; lIdx < layers.length; lIdx++) {
    const layer = layers[lIdx];
    const loops = layer.loops || [];

    if (lIdx > 0 && options.pauseBetweenSheets) {
      operations.push({
        id: `pause_layer_${lIdx + 1}`,
        name: `Insert Slice Layer ${lIdx + 1} of ${sheetCount}`,
        type: 'pause_sheet',
        sheetIndex: lIdx,
      });

      lines.push(``);
      lines.push(`; --- PAUSE: CONTOUR LAYER SWAP ---`);
      if (options.machineMode === 'laser') lines.push(`M5`);
      else {
        lines.push(`G0 Z${f(options.safeZ)}`);
        lines.push(`M5`);
      }
      lines.push(`G0 X0.000 Y0.000`);
      lines.push(`M0 (PAUSE: Insert Slice Layer ${lIdx + 1} of ${sheetCount})`);
      if (options.machineMode === 'cnc') {
        lines.push(`M3 S${Math.round(options.spindleRpm)}`);
        lines.push(`G4 P2`);
      }
    }

    lines.push(``);
    lines.push(`; ==================================================`);
    lines.push(`; CONTOUR LAYER ${lIdx + 1} of ${sheetCount} (Z = ${f(layer.z * 1000)}mm)`);
    lines.push(`; ==================================================`);

    for (let cIdx = 0; cIdx < loops.length; cIdx++) {
      const contour = loops[cIdx];
      if (contour.length < 3) continue;

      operations.push({
        id: `layer_${lIdx + 1}_contour_${cIdx}`,
        name: `Layer ${lIdx + 1} Contour #${cIdx + 1}`,
        type: 'cut',
        sheetIndex: lIdx,
      });

      for (const pt of contour) {
        minX = Math.min(minX, pt.x);
        minY = Math.min(minY, pt.y);
        maxX = Math.max(maxX, pt.x);
        maxY = Math.max(maxY, pt.y);
      }

      // Every contour gets attachments, holes included: a slice's holes are voids
      // in the model rather than joinery, and their slugs are big enough to be
      // worth holding down.
      const spans = planAttachments(polygonPerimeter(contour), options);
      attachmentCount += spans.length;
      totalCutDistanceMm += polygonPerimeter(contour);
      lines.push(...generateLoopGcode(contour, { x: 0, y: 0 }, options, spans));
    }
  }

  lines.push(``);
  lines.push(`; --- PROGRAM END ---`);
  if (options.machineMode === 'laser') lines.push(`M5`, `G0 X0.000 Y0.000`);
  else lines.push(`G0 Z${f(options.safeZ)}`, `M5`, `G0 X0.000 Y0.000`);
  lines.push(`M30`);

  totalCutDistanceMm *= laserPassCount(options);

  const estCutTimeSec = (totalCutDistanceMm / options.cutFeedrate) * 60;
  const estimatedTimeSeconds = Math.round(estCutTimeSec + sheetCount * 5);

  return {
    success: true,
    gcode: lines.join('\n'),
    totalCutDistanceMm: Math.round(totalCutDistanceMm),
    estimatedTimeSeconds,
    sheetCount,
    operations,
    bounds: { minX: isFinite(minX) ? minX : 0, minY: isFinite(minY) ? minY : 0, maxX: isFinite(maxX) ? maxX : 0, maxY: isFinite(maxY) ? maxY : 0 },
    attachmentCount,
  };
}
