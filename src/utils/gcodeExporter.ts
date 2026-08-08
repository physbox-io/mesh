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
      error: 'No panels provided for G-code generation.',
    };
  }

  // Group panels by sheet index based on placedPos2D
  const sheetMap = new Map<number, LaserPanel[]>();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const p of panels) {
    const pos = p.placedPos2D || { x: 0, y: 0 };
    // Sheet index is determined by pos.y vs sheetHeight or placed sheet
    const sheetIdx = Math.floor(pos.y / 1000); // normalized sheet grouping
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

        totalCutDistanceMm += polygonPerimeter(panel.outerPolygon2D);
        lines.push(...generateLoopGcode(panel.outerPolygon2D, pos, options));
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
  };
}

/** Helper to generate G-code motion lines for a single closed loop. */
function generateLoopGcode(
  loop: Point2D[],
  offset: Point2D,
  options: GcodeExportOptions
): string[] {
  const lines: string[] = [];
  if (loop.length < 3) return lines;

  const startX = offset.x + loop[0].x;
  const startY = offset.y + loop[0].y;

  if (options.machineMode === 'laser') {
    // Laser Mode: G0 to start, M3 S<power>, G1 around loop (once per pass), M5.
    // The beam stays on between passes — the path is closed, so it ends where the
    // next pass begins and there is nothing to re-pierce.
    const passes = laserPassCount(options);
    lines.push(`G0 X${f(startX)} Y${f(startY)} F${options.travelFeedrate}`);
    lines.push(`M3 S${laserS(options)}`);
    for (let pass = 1; pass <= passes; pass++) {
      if (passes > 1) lines.push(`; Pass ${pass}/${passes}`);
      for (let i = 1; i < loop.length; i++) {
        const px = offset.x + loop[i].x;
        const py = offset.y + loop[i].y;
        lines.push(`G1 X${f(px)} Y${f(py)} F${options.cutFeedrate}`);
      }
      lines.push(`G1 X${f(startX)} Y${f(startY)} F${options.cutFeedrate}`);
    }
    lines.push(`M5`);
  } else {
    // CNC Mode: Multi-pass depth slicing
    const totalDepth = Math.abs(options.cutDepthZ);
    const stepdown = Math.max(0.1, Math.abs(options.zStepdown));
    const passes = Math.ceil(totalDepth / stepdown);

    lines.push(`G0 X${f(startX)} Y${f(startY)} F${options.travelFeedrate}`);
    lines.push(`G0 Z${f(options.safeZ)}`);

    for (let pass = 1; pass <= passes; pass++) {
      const currentZ = -Math.min(totalDepth, pass * stepdown);
      lines.push(`; Pass ${pass}/${passes} (Z = ${f(currentZ)}mm)`);
      lines.push(`G1 Z${f(currentZ)} F${options.plungeFeedrate}`);

      for (let i = 1; i < loop.length; i++) {
        const px = offset.x + loop[i].x;
        const py = offset.y + loop[i].y;
        lines.push(`G1 X${f(px)} Y${f(py)} F${options.cutFeedrate}`);
      }
      lines.push(`G1 X${f(startX)} Y${f(startY)} F${options.cutFeedrate}`);
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

      totalCutDistanceMm += polygonPerimeter(contour);
      lines.push(...generateLoopGcode(contour, { x: 0, y: 0 }, options));
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
  };
}
