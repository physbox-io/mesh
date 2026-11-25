/**
 * Pure, store-free helpers for mapping live machine state onto 2D SVG cut previews
 * (`ExportLaserCutModal` and `ExportContourSliceModal`).
 *
 * Coordinate convention:
 * - Both `exportLaserCutSvg` and `exportContourSliceSvg` stack sheets vertically
 *   top-to-bottom in SVG (`viewBox="0 0 totalWidth totalHeight"`).
 * - Inside each sheet `s` (starting at `topY`), each placed panel or contour layer
 *   occupies `[pos.x, pos.x + w] × [pos.y, pos.y + h]` in BOTH sheet-local G-code
 *   work coordinates and SVG coordinates — EXCEPT that the part's local Y axis is
 *   inverted inside its own bounding box so plan-view +Y (up) maps to SVG -Y (up):
 *
 *     G-code:  workX = pos.x + localX,               workY = pos.y + localY
 *     SVG:     svgX  = pos.x + localX,               svgY  = topY + pos.y + h - localY
 *
 *   Substituting `localY = workY - pos.y` gives the exact inverse:
 *
 *     svgX = workX
 *     svgY = topY + 2 * pos.y + h - workY
 *
 *   Outside any placed panel/layer (rapids between parts, parked at origin), Y maps
 *   directly to `topY + workY`, which runs continuously in the same sheet direction
 *   as `pos.y`.
 */

import type { ContourSliceResult } from './contourSliceExporter';
import type { LaserCutResult } from './laserCutExporter';
import { prepareJobLines } from './machineJobLines';
import type { MachineState } from './machineTypes';

export interface SvgSheetRect {
  /** 0-based sheet index (matches `panel.sheetIndex` / `layer.sheetIndex`). */
  sheetIndex: number;
  /** Top Y offset in the stacked SVG viewBox, mm. */
  topY: number;
  /** Sheet width in mm. */
  widthMm: number;
  /** Sheet height in mm. */
  heightMm: number;
}

export interface SvgFlipRegion {
  /** 0-based sheet index this panel or contour layer sits on. */
  sheetIndex: number;
  /** Placed origin X on the sheet in mm (`placedPos2D.x`). */
  x: number;
  /** Placed origin Y on the sheet in mm (`placedPos2D.y`). */
  y: number;
  /** Bounding box width in mm (`width2D`). */
  width: number;
  /** Bounding box height in mm (`height2D`). */
  height: number;
}

export interface SvgSheetLayout {
  viewBoxWidth: number;
  viewBoxHeight: number;
  sheets: SvgSheetRect[];
  /** Per-panel / per-layer regions whose local Y is flipped in SVG relative to G-code. */
  regions: SvgFlipRegion[];
  /** Extra reach (mm) outside region bounds when matching cutter-compensated moves. */
  regionMarginMm: number;
}

export interface MappedSvgPoint {
  /** SVG X coordinate in viewBox mm. */
  x: number;
  /** SVG Y coordinate in viewBox mm. */
  y: number;
  /** Clamped SVG X inside `[0, viewBoxWidth]`. */
  clampedX: number;
  /** Clamped SVG Y inside `[0, viewBoxHeight]`. */
  clampedY: number;
  /** True when `(workX, workY)` falls within the active sheet (plus cutter margin). */
  inBounds: boolean;
  /** True when the point matched a placed panel/layer flip region. */
  matchedRegion: boolean;
}

export interface ParsedCutSegment {
  /** 1-based prepared line index in `prepareJobLines(gcode)`. */
  lineIndex: number;
  sheetIndex: number;
  svgX1: number;
  svgY1: number;
  svgX2: number;
  svgY2: number;
}

export interface ParsedSheetGcode {
  /** Prepared line indices where each sheet begins (sorted ascending by `lineIndex`). */
  sheetStarts: Array<{ lineIndex: number; sheetIndex: number }>;
  /** Cut-only 2D segments already projected into SVG viewBox coordinates. */
  cutSegments: ParsedCutSegment[];
  /** Total prepared lines in the program. */
  totalLines: number;
  /** Whether the program is laser G-code (uses M4 / no Z cuts). */
  isLaser: boolean;
}

export type LiveHeadActivity = 'cutting' | 'rapid' | 'paused' | 'idle' | 'alarm';

export interface SvgLiveOverlayState {
  viewBoxWidth: number;
  viewBoxHeight: number;
  machineMode: 'laser' | 'cnc';
  /** True when the running or paused machine job matches this modal's G-code. */
  isLiveJob: boolean;
  activity: LiveHeadActivity;
  activeSheetIndex: number;
  totalSheets: number;
  activeSheetRect: SvgSheetRect;
  headX: number;
  headY: number;
  clampedHeadX: number;
  clampedHeadY: number;
  workX: number;
  workY: number;
  workZ: number;
  inBounds: boolean;
  /** SVG path `d` for completed cutting segments up to `machineState.currentLine`. */
  completedPathD: string;
  progressPercent: number;
  spindleSpeed: number;
  feedRate: number;
  bitDiameterMm?: number;
}

/**
 * Extracts `width` and `height` from an SVG string's `viewBox="0 0 W H"`.
 * Returns `null` if no valid positive viewBox is present.
 */
export function parseSvgViewBox(svg: string | undefined): { width: number; height: number } | null {
  if (!svg) return null;
  const m = /viewBox="[^"]*?\s+([\d.+-]+)\s+([\d.+-]+)"/i.exec(svg);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

/**
 * Builds an `SvgSheetLayout` for `ExportLaserCutModal` matching `exportLaserCutSvg`.
 */
export function buildLaserSvgLayout(
  result: LaserCutResult | null | undefined,
  fallbackSheetWidthMm: number,
  fallbackSheetHeightMm: number,
  machineMode: 'laser' | 'cnc',
  bitDiameterMm = 0,
): SvgSheetLayout | null {
  if (!result?.success) return null;

  const sheets: SvgSheetRect[] = [];
  let stackY = 0;

  if (result.sheets && result.sheets.length > 0) {
    for (let i = 0; i < result.sheets.length; i++) {
      const sh = result.sheets[i];
      const w = Number.isFinite(sh.widthMm) && sh.widthMm > 0 ? sh.widthMm : fallbackSheetWidthMm;
      const h = Number.isFinite(sh.heightMm) && sh.heightMm > 0 ? sh.heightMm : fallbackSheetHeightMm;
      sheets.push({ sheetIndex: i, topY: stackY, widthMm: w, heightMm: h });
      stackY += h;
    }
  } else {
    const count = Math.max(1, result.sheetCount ?? 1);
    const w = Math.max(1, fallbackSheetWidthMm);
    const h = Math.max(1, fallbackSheetHeightMm);
    for (let i = 0; i < count; i++) {
      sheets.push({ sheetIndex: i, topY: stackY, widthMm: w, heightMm: h });
      stackY += h;
    }
  }

  const parsedVb = parseSvgViewBox(result.svg);
  const viewBoxWidth = parsedVb?.width ?? Math.max(...sheets.map((s) => s.widthMm), 1);
  const viewBoxHeight = parsedVb?.height ?? Math.max(stackY, 1);

  const regions: SvgFlipRegion[] = [];
  for (const panel of result.panels ?? []) {
    const pos = panel.placedPos2D;
    const width = panel.width2D ?? 0;
    const height = panel.height2D ?? 0;
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || width <= 0 || height <= 0) {
      continue;
    }
    regions.push({
      sheetIndex: panel.sheetIndex ?? 0,
      x: pos.x,
      y: pos.y,
      width,
      height,
    });
  }

  const regionMarginMm = machineMode === 'cnc' ? Math.max(0.5, bitDiameterMm / 2 + 0.5) : 0.5;
  return { viewBoxWidth, viewBoxHeight, sheets, regions, regionMarginMm };
}

/**
 * Builds an `SvgSheetLayout` for `ExportContourSliceModal` matching `exportContourSliceSvg`.
 */
export function buildContourSvgLayout(
  result: ContourSliceResult | null | undefined,
  sheetWidthMm: number,
  sheetHeightMm: number,
  machineMode: 'laser' | 'cnc',
  bitDiameterMm = 0,
): SvgSheetLayout | null {
  if (!result?.success) return null;

  const count = Math.max(1, result.sheetCount ?? 1);
  const w = Math.max(1, sheetWidthMm);
  const h = Math.max(1, sheetHeightMm);
  const sheets: SvgSheetRect[] = [];
  for (let i = 0; i < count; i++) {
    sheets.push({ sheetIndex: i, topY: i * h, widthMm: w, heightMm: h });
  }

  const parsedVb = parseSvgViewBox(result.svg);
  const viewBoxWidth = parsedVb?.width ?? w;
  const viewBoxHeight = parsedVb?.height ?? h * count;

  const regions: SvgFlipRegion[] = [];
  for (const layer of result.layers ?? []) {
    const pos = layer.placedPos2D;
    const width = layer.width2D ?? 0;
    const height = layer.height2D ?? 0;
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || width <= 0 || height <= 0) {
      continue;
    }
    regions.push({
      sheetIndex: layer.sheetIndex ?? 0,
      x: pos.x,
      y: pos.y,
      width,
      height,
    });
  }

  const regionMarginMm = machineMode === 'cnc' ? Math.max(0.5, bitDiameterMm / 2 + 0.5) : 0.5;
  return { viewBoxWidth, viewBoxHeight, sheets, regions, regionMarginMm };
}

function distSqToRect(px: number, py: number, r: SvgFlipRegion): number {
  const dx = px < r.x ? r.x - px : px > r.x + r.width ? px - (r.x + r.width) : 0;
  const dy = py < r.y ? r.y - py : py > r.y + r.height ? py - (r.y + r.height) : 0;
  return dx * dx + dy * dy;
}

/**
 * Finds the panel/layer flip region on `sheetIndex` that owns `(workX, workY)`.
 *
 * Prefers the smallest-area region strictly containing the point (so a small part
 * nested inside a larger panel's cutout maps to the inner part), and falls back to
 * the closest region within `regionMarginMm` (for CNC cutter-compensated outer cuts).
 */
export function findOwningRegion(
  workX: number,
  workY: number,
  sheetIndex: number,
  layout: SvgSheetLayout,
): SvgFlipRegion | null {
  let bestContaining: SvgFlipRegion | null = null;
  let bestContainingArea = Infinity;
  let bestNear: SvgFlipRegion | null = null;
  let bestNearDistSq = layout.regionMarginMm * layout.regionMarginMm;

  for (const r of layout.regions) {
    if (r.sheetIndex !== sheetIndex) continue;
    if (workX >= r.x && workX <= r.x + r.width && workY >= r.y && workY <= r.y + r.height) {
      const area = r.width * r.height;
      if (area < bestContainingArea) {
        bestContainingArea = area;
        bestContaining = r;
      }
      continue;
    }
    if (!bestContaining) {
      const dSq = distSqToRect(workX, workY, r);
      if (dSq <= bestNearDistSq) {
        bestNearDistSq = dSq;
        bestNear = r;
      }
    }
  }

  return bestContaining ?? bestNear;
}

/**
 * Maps machine work coordinates `(workX, workY)` on `sheetIndex` into stacked SVG
 * viewBox coordinates. Returns `null` for non-finite coordinates or an empty layout.
 */
export function mapWorkToSvg(
  workX: number,
  workY: number,
  sheetIndex: number,
  layout: SvgSheetLayout,
): MappedSvgPoint | null {
  if (!Number.isFinite(workX) || !Number.isFinite(workY)) return null;
  if (layout.sheets.length === 0) return null;

  const sheet =
    layout.sheets.find((s) => s.sheetIndex === sheetIndex) ??
    layout.sheets[Math.min(Math.max(0, sheetIndex), layout.sheets.length - 1)];

  const region = findOwningRegion(workX, workY, sheet.sheetIndex, layout);
  const svgX = workX;
  const svgY = region
    ? sheet.topY + 2 * region.y + region.height - workY
    : sheet.topY + workY;

  const pad = layout.regionMarginMm;
  const inBounds =
    workX >= -pad &&
    workX <= sheet.widthMm + pad &&
    workY >= -pad &&
    workY <= sheet.heightMm + pad;

  const clampedX = Math.min(Math.max(0, svgX), layout.viewBoxWidth);
  const clampedY = Math.min(Math.max(0, svgY), layout.viewBoxHeight);

  return {
    x: svgX,
    y: svgY,
    clampedX,
    clampedY,
    inBounds,
    matchedRegion: region !== null,
  };
}

/**
 * Extracts a 0-based sheet index from an M0 pause note/message such as
 * `"PAUSE: Insert Material Sheet 2 of 3"` or `"PAUSE: Insert Sheet 3 of 4"`.
 */
export function parseSheetIndexFromPause(text: string | undefined): number | null {
  if (!text) return null;
  const m = /Insert\s+(?:Material\s+)?Sheet\s+(\d+)/i.exec(text);
  if (!m) return null;
  const oneBased = parseInt(m[1], 10);
  return Number.isFinite(oneBased) && oneBased >= 1 ? oneBased - 1 : null;
}

/**
 * Parses a sheet-cut G-code program once (per G-code generation) to build:
 * - Sheet-start line boundaries (from `M0` sheet-swap pauses)
 * - Projected 2D SVG cut segments for live completed-path rendering
 *
 * Uses `prepareJobLines(gcode)` so line indices match `machineState.currentLine`.
 */
export function parseSheetGcodeProgram(
  gcode: string | null | undefined,
  layout: SvgSheetLayout | null,
): ParsedSheetGcode | null {
  if (!gcode || !layout || layout.sheets.length === 0) return null;

  const lines = prepareJobLines(gcode);
  const firstSheet = layout.sheets[0].sheetIndex;
  const sheetStarts: Array<{ lineIndex: number; sheetIndex: number }> = [
    { lineIndex: 0, sheetIndex: firstSheet },
  ];
  const cutSegments: ParsedCutSegment[] = [];

  let currentSheet = firstSheet;
  let motion: 0 | 1 = 0;
  let x = 0;
  let y = 0;
  let z = 0;
  let spindleOn = false;
  let spindleS = 0;
  let seenM4 = false;
  let seenNegZ = false;

  const rawMoves: Array<{
    lineIndex: number;
    sheetIndex: number;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    z: number;
    spindleOn: boolean;
    spindleS: number;
  }> = [];

  for (let i = 0; i < lines.length; i++) {
    const { code, note } = lines[i];
    const lineNum = i + 1;
    const upper = code.toUpperCase();

    if (/\bM0*0\b/.test(upper)) {
      const nextSheet = parseSheetIndexFromPause(note);
      if (nextSheet !== null) {
        currentSheet = nextSheet;
        sheetStarts.push({ lineIndex: lineNum, sheetIndex: nextSheet });
      }
      continue;
    }

    if (/\bM0*4\b/.test(upper)) {
      seenM4 = true;
      spindleOn = true;
    } else if (/\bM0*3\b/.test(upper)) {
      spindleOn = true;
    } else if (/\bM0*5\b/.test(upper)) {
      spindleOn = false;
    }

    const sMatch = /\bS(-?\d+(?:\.\d+)?)/.exec(upper);
    if (sMatch) {
      const val = parseFloat(sMatch[1]);
      if (Number.isFinite(val)) spindleS = val;
    }

    if (/\bG0*0\b/.test(upper)) motion = 0;
    else if (/\bG0*1\b/.test(upper)) motion = 1;

    const xMatch = /\bX(-?\d+(?:\.\d+)?)/.exec(upper);
    const yMatch = /\bY(-?\d+(?:\.\d+)?)/.exec(upper);
    const zMatch = /\bZ(-?\d+(?:\.\d+)?)/.exec(upper);

    const nx = xMatch ? parseFloat(xMatch[1]) : x;
    const ny = yMatch ? parseFloat(yMatch[1]) : y;
    const nz = zMatch ? parseFloat(zMatch[1]) : z;

    if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz)) continue;
    if (nz < -1e-4) seenNegZ = true;

    if (motion === 1 && (Math.abs(nx - x) > 1e-4 || Math.abs(ny - y) > 1e-4)) {
      rawMoves.push({
        lineIndex: lineNum,
        sheetIndex: currentSheet,
        x1: x,
        y1: y,
        x2: nx,
        y2: ny,
        z: nz,
        spindleOn,
        spindleS,
      });
    }

    x = nx;
    y = ny;
    z = nz;
  }

  const isLaser = seenM4 || !seenNegZ;

  for (const mv of rawMoves) {
    const isCutting = isLaser ? mv.spindleOn && mv.spindleS > 0 : mv.z < -1e-4;
    if (!isCutting) continue;
    const p1 = mapWorkToSvg(mv.x1, mv.y1, mv.sheetIndex, layout);
    const p2 = mapWorkToSvg(mv.x2, mv.y2, mv.sheetIndex, layout);
    if (!p1 || !p2) continue;
    cutSegments.push({
      lineIndex: mv.lineIndex,
      sheetIndex: mv.sheetIndex,
      svgX1: p1.x,
      svgY1: p1.y,
      svgX2: p2.x,
      svgY2: p2.y,
    });
  }

  return {
    sheetStarts,
    cutSegments,
    totalLines: lines.length,
    isLaser,
  };
}

/**
 * Returns the 0-based active sheet index at `currentLine`.
 */
export function activeSheetIndexAtLine(
  program: ParsedSheetGcode | null,
  currentLine: number,
  pauseMessage?: string,
): number {
  const fromPause = parseSheetIndexFromPause(pauseMessage);
  if (fromPause !== null) return fromPause;
  if (!program || program.sheetStarts.length === 0) return 0;

  let active = program.sheetStarts[0].sheetIndex;
  for (let i = 1; i < program.sheetStarts.length; i++) {
    if (currentLine >= program.sheetStarts[i].lineIndex) {
      active = program.sheetStarts[i].sheetIndex;
    } else {
      break;
    }
  }
  return active;
}

/**
 * Builds a compact SVG `<path d="...">` string for all cut segments completed
 * up to `currentLine`, merging contiguous endpoints into `L` commands.
 */
export function buildCompletedPathD(
  program: ParsedSheetGcode | null,
  currentLine: number,
): string {
  if (!program || currentLine <= 0 || program.cutSegments.length === 0) return '';

  const parts: string[] = [];
  let prevX = NaN;
  let prevY = NaN;

  for (let i = 0; i < program.cutSegments.length; i++) {
    const seg = program.cutSegments[i];
    if (seg.lineIndex > currentLine) break;
    const contiguous =
      Math.abs(seg.svgX1 - prevX) < 0.02 && Math.abs(seg.svgY1 - prevY) < 0.02;
    if (!contiguous) {
      parts.push(`M${seg.svgX1.toFixed(2)} ${seg.svgY1.toFixed(2)}`);
    }
    parts.push(`L${seg.svgX2.toFixed(2)} ${seg.svgY2.toFixed(2)}`);
    prevX = seg.svgX2;
    prevY = seg.svgY2;
  }

  return parts.join(' ');
}

/**
 * Derives the complete 2D SVG live overlay state from `machineState`, layout, and
 * parsed program. Returns `null` when no overlay should be drawn (disconnected,
 * non-finite coordinates, relief-map view, or another unrelated job running).
 */
export function deriveSvgLiveState(params: {
  machineState: MachineState;
  machineMode: 'laser' | 'cnc';
  isLiveJob: boolean;
  layout: SvgSheetLayout | null;
  program: ParsedSheetGcode | null;
  viewMode?: 'sheets' | 'map';
  bitDiameterMm?: number;
}): SvgLiveOverlayState | null {
  const {
    machineState,
    machineMode,
    isLiveJob,
    layout,
    program,
    viewMode = 'sheets',
    bitDiameterMm,
  } = params;

  if (!layout || layout.sheets.length === 0 || viewMode === 'map') return null;
  if (!machineState.connected) return null;

  const status = machineState.status;
  const jobActiveOnMachine = status === 'RUNNING' || status.startsWith('PAUSED');
  // Match 3D ToolpathView: do not draw a misleading live head over this preview
  // when the machine is actively running a different program.
  if (jobActiveOnMachine && !isLiveJob) return null;

  const { x: workX, y: workY, z: rawZ } = machineState.wpos;
  if (!Number.isFinite(workX) || !Number.isFinite(workY)) return null;
  const workZ = Number.isFinite(rawZ) ? rawZ : 0;

  const liveJobRunning = isLiveJob && jobActiveOnMachine;
  const activeSheetIndex = liveJobRunning
    ? activeSheetIndexAtLine(program, machineState.currentLine, machineState.pauseMessage)
    : layout.sheets[0].sheetIndex;

  const activeSheetRect =
    layout.sheets.find((s) => s.sheetIndex === activeSheetIndex) ?? layout.sheets[0];

  const mapped = mapWorkToSvg(workX, workY, activeSheetRect.sheetIndex, layout);
  if (!mapped) return null;

  let activity: LiveHeadActivity;
  if (status === 'ALARM' || status === 'ERROR') {
    activity = 'alarm';
  } else if (status.startsWith('PAUSED')) {
    activity = 'paused';
  } else if (status === 'RUNNING') {
    const cuttingNow =
      machineMode === 'laser'
        ? machineState.spindleSpeed > 0
        : workZ < -0.05;
    activity = cuttingNow ? 'cutting' : 'rapid';
  } else {
    activity = 'idle';
  }

  const completedPathD = liveJobRunning
    ? buildCompletedPathD(program, machineState.currentLine)
    : '';

  return {
    viewBoxWidth: layout.viewBoxWidth,
    viewBoxHeight: layout.viewBoxHeight,
    machineMode,
    isLiveJob: liveJobRunning,
    activity,
    activeSheetIndex: activeSheetRect.sheetIndex,
    totalSheets: layout.sheets.length,
    activeSheetRect,
    headX: mapped.x,
    headY: mapped.y,
    clampedHeadX: mapped.clampedX,
    clampedHeadY: mapped.clampedY,
    workX,
    workY,
    workZ,
    inBounds: mapped.inBounds,
    completedPathD,
    progressPercent: Number.isFinite(machineState.progressPercent)
      ? Math.min(100, Math.max(0, machineState.progressPercent))
      : 0,
    spindleSpeed: Number.isFinite(machineState.spindleSpeed) ? machineState.spindleSpeed : 0,
    feedRate: Number.isFinite(machineState.feedRate) ? machineState.feedRate : 0,
    bitDiameterMm,
  };
}
