// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  activeSheetIndexAtLine,
  buildCompletedPathD,
  buildContourSvgLayout,
  buildLaserSvgLayout,
  deriveSvgLiveState,
  findOwningRegion,
  mapWorkToSvg,
  parseSheetGcodeProgram,
  parseSheetIndexFromPause,
  parseSvgViewBox,
  type SvgSheetLayout,
} from '../src/utils/svgLiveOverlay';
import { StaticSvgLayer, SvgLiveHud, SvgLiveOverlay } from '../src/components/SvgLiveOverlay';
import { exportLaserCutSvg, DEFAULT_LASER_OPTIONS } from '../src/utils/laserCutExporter';
import { exportContourSliceSvg, DEFAULT_CONTOUR_OPTIONS } from '../src/utils/contourSliceExporter';
import {
  DEFAULT_GCODE_OPTIONS,
  generateContourSliceGcode,
  generateLaserCutGcode,
} from '../src/utils/gcodeExporter';
import { DEFAULT_MOTION_PROFILE } from '../src/utils/motionProfile';
import type { MachineState } from '../src/utils/machineTypes';
import type { SceneGeom, SceneGraph } from '../src/types/scene';

function baseMachineState(overrides: Partial<MachineState> = {}): MachineState {
  return {
    connected: true,
    status: 'IDLE',
    portName: 'USB Machine',
    mpos: { x: 0, y: 0, z: 0 },
    wpos: { x: 0, y: 0, z: 0 },
    currentLine: 0,
    totalLines: 0,
    progressPercent: 0,
    remainingSeconds: null,
    elapsedSeconds: 0,
    estimatedSeconds: null,
    feedRate: 0,
    spindleSpeed: 0,
    needsZZero: false,
    hasHomed: true,
    motion: DEFAULT_MOTION_PROFILE,
    grblSettings: {},
    overrides: { feed: 100, rapid: 100, spindle: 100 },
    resume: null,
    park: null,
    guideSpot: false,
    controllerSilent: false,
    probePinActive: false,
    probeCircuitSeen: false,
    datumEpoch: 0,
    lastCompletedJob: null,
    ...overrides,
  };
}

function boxScene(wM: number, dM: number, hM: number): SceneGraph {
  const geom: SceneGeom = { name: 'g1', type: 'box', size: [wM / 2, dM / 2, hM / 2] };
  return {
    nodes: [
      {
        id: 'b1',
        name: 'box',
        type: 'body',
        pos: [0, 0, hM / 2],
        geoms: [geom],
        joints: [],
        children: [],
      },
    ],
  };
}

/** Extracts all line segments from SVG `<path d="M ... L ... Z">` inside `#cut-paths`. */
function extractCutPathSegments(svg: string): Array<{ x1: number; y1: number; x2: number; y2: number }> {
  const match = /<g id="cut-paths"[^>]*>([\s\S]*?)<\/g>/.exec(svg);
  if (!match) return [];
  const segs: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  const pathRe = /d="([^"]+)"/g;
  let pm: RegExpExecArray | null;
  while ((pm = pathRe.exec(match[1])) !== null) {
    const tokenRe = /([MLZ])\s*(?:(-?[\d.]+)\s+(-?[\d.]+))?/g;
    let startX = 0;
    let startY = 0;
    let curX = 0;
    let curY = 0;
    let tm: RegExpExecArray | null;
    while ((tm = tokenRe.exec(pm[1])) !== null) {
      const cmd = tm[1];
      if (cmd === 'M') {
        startX = curX = parseFloat(tm[2]);
        startY = curY = parseFloat(tm[3]);
      } else if (cmd === 'L') {
        const nx = parseFloat(tm[2]);
        const ny = parseFloat(tm[3]);
        segs.push({ x1: curX, y1: curY, x2: nx, y2: ny });
        curX = nx;
        curY = ny;
      } else if (cmd === 'Z') {
        segs.push({ x1: curX, y1: curY, x2: startX, y2: startY });
        curX = startX;
        curY = startY;
      }
    }
  }
  return segs;
}

function distToSegment(
  px: number,
  py: number,
  s: { x1: number; y1: number; x2: number; y2: number },
): number {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq > 1e-12 ? Math.max(0, Math.min(1, ((px - s.x1) * dx + (py - s.y1) * dy) / lenSq)) : 0;
  return Math.hypot(px - (s.x1 + dx * t), py - (s.y1 + dy * t));
}

describe('2D SVG Live Machine Following (svgLiveOverlay)', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  describe('parseSvgViewBox & parseSheetIndexFromPause', () => {
    it('parses valid viewBox dimensions and rejects malformed strings', () => {
      expect(parseSvgViewBox('<svg width="600mm" height="800mm" viewBox="0 0 600 800">')).toEqual({
        width: 600,
        height: 800,
      });
      expect(parseSvgViewBox('<svg viewBox="0 0 0 400">')).toBeNull();
      expect(parseSvgViewBox('')).toBeNull();
      expect(parseSvgViewBox(undefined)).toBeNull();
    });

    it('extracts 0-based sheet index from both laser and contour M0 pause messages', () => {
      expect(parseSheetIndexFromPause('PAUSE: Insert Material Sheet 2 of 3')).toBe(1);
      expect(parseSheetIndexFromPause('PAUSE: Insert Sheet 4 of 5')).toBe(3);
      expect(parseSheetIndexFromPause('PAUSE: Tool change T2')).toBeNull();
      expect(parseSheetIndexFromPause(undefined)).toBeNull();
    });
  });

  describe('Coordinate mapping: origin, Y-flip, nested panels, CNC margin, multi-sheet', () => {
    const layout: SvgSheetLayout = {
      viewBoxWidth: 600,
      viewBoxHeight: 700, // Sheet 0 (400mm tall) + Sheet 1 (300mm tall)
      sheets: [
        { sheetIndex: 0, topY: 0, widthMm: 600, heightMm: 400 },
        { sheetIndex: 1, topY: 400, widthMm: 500, heightMm: 300 },
      ],
      regions: [
        // Large panel on sheet 0 at (10, 20), 200 × 100
        { sheetIndex: 0, x: 10, y: 20, width: 200, height: 100 },
        // Small nested panel inside the large panel's cutout at (60, 40), 40 × 30
        { sheetIndex: 0, x: 60, y: 40, width: 40, height: 30 },
        // Panel on sheet 1 at (15, 25), 80 × 50
        { sheetIndex: 1, x: 15, y: 25, width: 80, height: 50 },
      ],
      regionMarginMm: 2.1, // e.g., 3.175mm router bit radius + 0.5mm
    };

    it('flips local Y inside a placed panel so G-code bottom edge maps to SVG bottom edge', () => {
      // Panel at (10, 20), height 100:
      // G-code local y=0 -> workY=20 -> SVG y = 0 + 2*20 + 100 - 20 = 120 (bottom of panel)
      const bottom = mapWorkToSvg(15, 20, 0, layout)!;
      expect(bottom.x).toBeCloseTo(15, 6);
      expect(bottom.y).toBeCloseTo(120, 6);
      expect(bottom.matchedRegion).toBe(true);
      expect(bottom.inBounds).toBe(true);

      // G-code local y=100 -> workY=120 -> SVG y = 0 + 2*20 + 100 - 120 = 20 (top of panel)
      const top = mapWorkToSvg(15, 120, 0, layout)!;
      expect(top.y).toBeCloseTo(20, 6);
    });

    it('prefers the smallest containing region for nested panels', () => {
      // Point (70, 42) is inside both large (10..210, 20..120) and nested (60..100, 40..70)
      const owner = findOwningRegion(70, 42, 0, layout);
      expect(owner).toEqual({ sheetIndex: 0, x: 60, y: 40, width: 40, height: 30 });

      const pt = mapWorkToSvg(70, 42, 0, layout)!;
      // SVG y = 0 + 2*40 + 30 - 42 = 68
      expect(pt.y).toBeCloseTo(68, 6);
    });

    it('matches CNC cutter-compensated points just outside a panel within regionMarginMm', () => {
      // 1.5875 mm outside left edge of panel (10, 20, 200, 100)
      const pt = mapWorkToSvg(10 - 1.5875, 25, 0, layout)!;
      expect(pt.matchedRegion).toBe(true);
      // Flipped within panel: 2*20 + 100 - 25 = 115
      expect(pt.y).toBeCloseTo(115, 6);
    });

    it('maps points on Sheet 2 with mixed-height sheetTop offset', () => {
      // Sheet 1 starts at topY = 400; panel at (15, 25), height 50
      // workY = 30 -> svgY = 400 + 2*25 + 50 - 30 = 470
      const pt = mapWorkToSvg(20, 30, 1, layout)!;
      expect(pt.x).toBeCloseTo(20, 6);
      expect(pt.y).toBeCloseTo(470, 6);
      expect(pt.inBounds).toBe(true);
    });

    it('maps origin (0, 0) and inter-panel rapids directly to sheetTop + workY', () => {
      const originS0 = mapWorkToSvg(0, 0, 0, layout)!;
      expect(originS0).toMatchObject({ x: 0, y: 0, matchedRegion: false, inBounds: true });

      const originS1 = mapWorkToSvg(0, 0, 1, layout)!;
      expect(originS1).toMatchObject({ x: 0, y: 400, matchedRegion: false, inBounds: true });
    });

    it('flags out-of-bounds coordinates and clamps clampedX/clampedY to viewBox', () => {
      const oob = mapWorkToSvg(750, -40, 0, layout)!;
      expect(oob.inBounds).toBe(false);
      expect(oob.clampedX).toBe(600);
      expect(oob.clampedY).toBe(0);
    });

    it('rejects NaN and Infinity work coordinates cleanly', () => {
      expect(mapWorkToSvg(NaN, 10, 0, layout)).toBeNull();
      expect(mapWorkToSvg(10, Infinity, 0, layout)).toBeNull();
      expect(mapWorkToSvg(-Infinity, 0, 0, layout)).toBeNull();
    });
  });

  describe('End-to-end alignment with real Laser Cut & Contour Slice exporters', () => {
    it('maps generated laser G-code cut points onto the exact SVG cut paths', () => {
      const scene = boxScene(0.08, 0.05, 0.04);
      const laserRes = exportLaserCutSvg(scene, {
        ...DEFAULT_LASER_OPTIONS,
        materialThickness: 0.003,
        jointMode: 'finger',
        sheetWidth: 0.3,
        sheetHeight: 0.2,
      });
      expect(laserRes.success).toBe(true);

      const gcodeRes = generateLaserCutGcode(laserRes.panels!, {
        ...DEFAULT_GCODE_OPTIONS,
        machineMode: 'laser',
        laserPower: 800,
        laserMaxPower: 1000,
      });
      expect(gcodeRes.success).toBe(true);

      const layout = buildLaserSvgLayout(laserRes, 300, 200, 'laser');
      expect(layout).not.toBeNull();

      const parsed = parseSheetGcodeProgram(gcodeRes.gcode, layout);
      expect(parsed).not.toBeNull();
      expect(parsed!.isLaser).toBe(true);
      expect(parsed!.cutSegments.length).toBeGreaterThan(10);

      const svgSegs = extractCutPathSegments(laserRes.svg!);
      expect(svgSegs.length).toBeGreaterThan(10);

      // Every parsed G-code cut segment endpoint must land within 0.05 mm of an emitted SVG cut edge.
      let maxErr = 0;
      for (const seg of parsed!.cutSegments.slice(0, 60)) {
        let best = Infinity;
        for (const ss of svgSegs) {
          const d = distToSegment(seg.svgX2, seg.svgY2, ss);
          if (d < best) best = d;
        }
        if (best > maxErr) maxErr = best;
      }
      expect(maxErr).toBeLessThan(0.05);
    });

    it('maps generated contour slice G-code cut points onto the exact SVG cut paths (multi-sheet)', () => {
      // 40×40×30mm box sliced at 5mm = 6 layers on small 100×60mm sheets -> multiple sheets
      const scene = boxScene(0.04, 0.04, 0.03);
      const contourRes = exportContourSliceSvg(scene, {
        ...DEFAULT_CONTOUR_OPTIONS,
        materialThickness: 0.005,
        sheetWidth: 0.1,
        sheetHeight: 0.06,
        pinHoles: false,
        kerf: 0,
      });
      expect(contourRes.success).toBe(true);
      expect(contourRes.sheetCount).toBeGreaterThan(1);

      const gcodeRes = generateContourSliceGcode(contourRes, {
        ...DEFAULT_GCODE_OPTIONS,
        machineMode: 'laser',
        laserPower: 800,
        laserMaxPower: 1000,
      });
      expect(gcodeRes.success).toBe(true);

      const layout = buildContourSvgLayout(contourRes, 100, 60, 'laser');
      expect(layout).not.toBeNull();
      expect(layout!.sheets.length).toBe(contourRes.sheetCount);

      const parsed = parseSheetGcodeProgram(gcodeRes.gcode, layout);
      expect(parsed).not.toBeNull();
      expect(parsed!.sheetStarts.length).toBe(contourRes.sheetCount);

      // Verify sheet index transitions across M0 sheet swaps
      const secondSheetStart = parsed!.sheetStarts[1];
      expect(activeSheetIndexAtLine(parsed, secondSheetStart.lineIndex - 1)).toBe(0);
      expect(activeSheetIndexAtLine(parsed, secondSheetStart.lineIndex)).toBe(1);

      // Verify projected cut segments land on the emitted SVG cut edges across all sheets
      const svgSegs = extractCutPathSegments(contourRes.svg!);
      let maxErr = 0;
      for (const seg of parsed!.cutSegments) {
        let best = Infinity;
        for (const ss of svgSegs) {
          const d = distToSegment(seg.svgX2, seg.svgY2, ss);
          if (d < best) best = d;
        }
        if (best > maxErr) maxErr = best;
      }
      expect(maxErr).toBeLessThan(0.05);
    });
  });

  describe('parseSheetGcodeProgram & buildCompletedPathD', () => {
    const simpleLayout: SvgSheetLayout = {
      viewBoxWidth: 200,
      viewBoxHeight: 200,
      sheets: [
        { sheetIndex: 0, topY: 0, widthMm: 200, heightMm: 100 },
        { sheetIndex: 1, topY: 100, widthMm: 200, heightMm: 100 },
      ],
      regions: [],
      regionMarginMm: 0.5,
    };

    it('excludes laser rapids and S0 attachment gaps, and builds monotonic completed path', () => {
      const gcode = [
        'G21',
        'G90',
        'G0 X10 Y10 F3000',
        'M4 S800',
        'G1 X50 Y10 F1200',
        'G1 X60 Y10 F1200 S0 ; attachment',
        'G1 X90 Y10 F1200 S800',
        'M5',
        'G0 X0 Y0',
        'M0 (PAUSE: Insert Material Sheet 2 of 2)',
        'G0 X20 Y20',
        'M4 S800',
        'G1 X40 Y20 F1200',
        'M5',
      ].join('\n');

      const parsed = parseSheetGcodeProgram(gcode, simpleLayout)!;
      expect(parsed.isLaser).toBe(true);
      expect(parsed.sheetStarts).toEqual([
        { lineIndex: 0, sheetIndex: 0 },
        { lineIndex: 10, sheetIndex: 1 },
      ]);
      // Only 3 cutting segments: (10->50), (60->90) on sheet 0, and (20->40) on sheet 1
      expect(parsed.cutSegments).toHaveLength(3);
      expect(parsed.cutSegments[0]).toMatchObject({ sheetIndex: 0, svgX1: 10, svgX2: 50, svgY1: 10 });
      expect(parsed.cutSegments[1]).toMatchObject({ sheetIndex: 0, svgX1: 60, svgX2: 90, svgY1: 10 });
      expect(parsed.cutSegments[2]).toMatchObject({ sheetIndex: 1, svgX1: 20, svgX2: 40, svgY1: 120 });

      const d0 = buildCompletedPathD(parsed, 0);
      const dMid = buildCompletedPathD(parsed, 7);
      const dAll = buildCompletedPathD(parsed, 14);
      expect(d0).toBe('');
      expect(dMid).toContain('M10.00 10.00 L50.00 10.00');
      expect(dMid).toContain('M60.00 10.00 L90.00 10.00');
      expect(dMid).not.toContain('120.00');
      expect(dAll).toContain('M20.00 120.00 L40.00 120.00');
    });

    it('detects CNC cutting moves only below Z0 and ignores safe-Z retracts', () => {
      const gcode = [
        'G21',
        'G90',
        'G0 Z5',
        'M3 S12000',
        'G0 X10 Y10',
        'G1 Z-1.5 F300',
        'G1 X50 Y10 F800',
        'G1 X50 Y40 F800',
        'G0 Z5',
        'G1 X80 Y80 F800', // above stock -> not a cut
      ].join('\n');

      const parsed = parseSheetGcodeProgram(gcode, simpleLayout)!;
      expect(parsed.isLaser).toBe(false);
      expect(parsed.cutSegments).toHaveLength(2);
      // Contiguous segments merge into one M + two L commands
      expect(buildCompletedPathD(parsed, 10)).toBe('M10.00 10.00 L50.00 10.00 L50.00 40.00');
    });
  });

  describe('deriveSvgLiveState guards & machine states', () => {
    const layout: SvgSheetLayout = {
      viewBoxWidth: 300,
      viewBoxHeight: 400,
      sheets: [
        { sheetIndex: 0, topY: 0, widthMm: 300, heightMm: 200 },
        { sheetIndex: 1, topY: 200, widthMm: 300, heightMm: 200 },
      ],
      regions: [{ sheetIndex: 0, x: 10, y: 10, width: 100, height: 80 }],
      regionMarginMm: 1,
    };

    const gcode = [
      'G21',
      'G90',
      'G0 X10 Y10',
      'M4 S800',
      'G1 X60 Y10 F1200',
      'M5',
      'M0 (PAUSE: Insert Material Sheet 2 of 2)',
      'G0 X20 Y20',
      'M4 S800',
      'G1 X80 Y20 F1200',
      'M5',
    ].join('\n');
    const program = parseSheetGcodeProgram(gcode, layout);

    it('returns null when disconnected, on relief map, non-finite wpos, or another job running', () => {
      expect(
        deriveSvgLiveState({
          machineState: baseMachineState({ connected: false }),
          machineMode: 'laser',
          isLiveJob: false,
          layout,
          program,
        }),
      ).toBeNull();

      expect(
        deriveSvgLiveState({
          machineState: baseMachineState({ status: 'RUNNING', wpos: { x: 20, y: 20, z: 0 } }),
          machineMode: 'laser',
          isLiveJob: true,
          layout,
          program,
          viewMode: 'map',
        }),
      ).toBeNull();

      expect(
        deriveSvgLiveState({
          machineState: baseMachineState({ wpos: { x: NaN, y: 10, z: 0 } }),
          machineMode: 'laser',
          isLiveJob: false,
          layout,
          program,
        }),
      ).toBeNull();

      // Another unrelated job is running on the machine -> do not draw misleading overlay
      expect(
        deriveSvgLiveState({
          machineState: baseMachineState({ status: 'RUNNING', wpos: { x: 20, y: 20, z: 0 } }),
          machineMode: 'laser',
          isLiveJob: false,
          layout,
          program,
        }),
      ).toBeNull();
    });

    it('distinguishes cutting, rapid, paused, idle, and alarm states for laser and CNC', () => {
      const laserCut = deriveSvgLiveState({
        machineState: baseMachineState({
          status: 'RUNNING',
          wpos: { x: 30, y: 10, z: 0 },
          spindleSpeed: 800,
          currentLine: 5,
          progressPercent: 45,
        }),
        machineMode: 'laser',
        isLiveJob: true,
        layout,
        program,
      })!;
      expect(laserCut.activity).toBe('cutting');
      expect(laserCut.isLiveJob).toBe(true);
      expect(laserCut.completedPathD).not.toBe('');

      const laserRapid = deriveSvgLiveState({
        machineState: baseMachineState({
          status: 'RUNNING',
          wpos: { x: 30, y: 10, z: 0 },
          spindleSpeed: 0,
          currentLine: 3,
        }),
        machineMode: 'laser',
        isLiveJob: true,
        layout,
        program,
      })!;
      expect(laserRapid.activity).toBe('rapid');

      const cncCut = deriveSvgLiveState({
        machineState: baseMachineState({
          status: 'RUNNING',
          wpos: { x: 30, y: 10, z: -1.5 },
          spindleSpeed: 12000,
          currentLine: 5,
        }),
        machineMode: 'cnc',
        isLiveJob: true,
        layout,
        program,
        bitDiameterMm: 3.175,
      })!;
      expect(cncCut.activity).toBe('cutting');
      expect(cncCut.bitDiameterMm).toBe(3.175);

      const cncRapid = deriveSvgLiveState({
        machineState: baseMachineState({
          status: 'RUNNING',
          wpos: { x: 30, y: 10, z: 5 },
          spindleSpeed: 12000,
          currentLine: 3,
        }),
        machineMode: 'cnc',
        isLiveJob: true,
        layout,
        program,
      })!;
      expect(cncRapid.activity).toBe('rapid');

      const pausedSheet2 = deriveSvgLiveState({
        machineState: baseMachineState({
          status: 'PAUSED_MATERIAL',
          pauseMessage: 'PAUSE: Insert Material Sheet 2 of 2',
          wpos: { x: 0, y: 0, z: 0 },
          currentLine: 7,
        }),
        machineMode: 'laser',
        isLiveJob: true,
        layout,
        program,
      })!;
      expect(pausedSheet2.activity).toBe('paused');
      expect(pausedSheet2.activeSheetIndex).toBe(1);
      expect(pausedSheet2.headY).toBeCloseTo(200, 6);

      const idle = deriveSvgLiveState({
        machineState: baseMachineState({ status: 'IDLE', wpos: { x: 5, y: 5, z: 0 } }),
        machineMode: 'laser',
        isLiveJob: false,
        layout,
        program,
      })!;
      expect(idle.activity).toBe('idle');
      expect(idle.isLiveJob).toBe(false);
      expect(idle.completedPathD).toBe('');

      const alarm = deriveSvgLiveState({
        machineState: baseMachineState({ status: 'ALARM', wpos: { x: 5, y: 5, z: 0 } }),
        machineMode: 'cnc',
        isLiveJob: false,
        layout,
        program,
      })!;
      expect(alarm.activity).toBe('alarm');
    });
  });

  describe('SvgLiveOverlay & StaticSvgLayer React rendering', () => {
    it('renders non-interactive overlay and does not rebuild static SVG DOM on head moves', async () => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);

      const staticHtml =
        '<svg id="static-cut-svg" width="100%" viewBox="0 0 300 400"><path d="M10 10 L50 10" stroke="#FF0000" /></svg>';

      const makeState = (headX: number, headY: number) => ({
        viewBoxWidth: 300,
        viewBoxHeight: 400,
        machineMode: 'cnc' as const,
        isLiveJob: true,
        activity: 'cutting' as const,
        activeSheetIndex: 1,
        totalSheets: 2,
        activeSheetRect: { sheetIndex: 1, topY: 200, widthMm: 300, heightMm: 200 },
        headX,
        headY,
        clampedHeadX: headX,
        clampedHeadY: headY,
        workX: headX,
        workY: headY - 200,
        workZ: -1.5,
        inBounds: true,
        completedPathD: 'M10.00 210.00 L40.00 210.00',
        progressPercent: 60,
        spindleSpeed: 12000,
        feedRate: 800,
        bitDiameterMm: 3.175,
      });

      try {
        await act(async () => {
          root.render(
            React.createElement(
              'div',
              { className: 'relative' },
              React.createElement(StaticSvgLayer, { html: staticHtml, className: 'w-full' }),
              React.createElement(SvgLiveOverlay, { state: makeState(40, 210) }),
              React.createElement(SvgLiveHud, { state: makeState(40, 210) }),
            ),
          );
        });

        const staticSvgBefore = host.querySelector('#static-cut-svg');
        expect(staticSvgBefore).not.toBeNull();

        const overlay = host.querySelector('[data-testid="svg-live-overlay"]')!;
        expect(overlay.getAttribute('viewBox')).toBe('0 0 300 400');
        expect(overlay.getAttribute('class')).toContain('pointer-events-none');
        expect(host.querySelector('[data-testid="live-active-sheet-frame"]')).not.toBeNull();
        expect(host.querySelector('[data-testid="live-completed-path"]')).not.toBeNull();
        expect(host.querySelector('[data-testid="live-head-marker"]')?.getAttribute('transform')).toBe(
          'translate(40.000 210.000)',
        );
        expect(host.querySelector('[data-testid="svg-live-hud"]')?.textContent).toContain('S2/2');

        // Simulate a high-frequency head position update
        await act(async () => {
          root.render(
            React.createElement(
              'div',
              { className: 'relative' },
              React.createElement(StaticSvgLayer, { html: staticHtml, className: 'w-full' }),
              React.createElement(SvgLiveOverlay, { state: makeState(55, 225) }),
              React.createElement(SvgLiveHud, { state: makeState(55, 225) }),
            ),
          );
        });

        // Static SVG DOM element is the EXACT same object reference (never re-parsed!)
        expect(host.querySelector('#static-cut-svg')).toBe(staticSvgBefore);
        expect(host.querySelector('[data-testid="live-head-marker"]')?.getAttribute('transform')).toBe(
          'translate(55.000 225.000)',
        );
      } finally {
        await act(async () => {
          root.unmount();
        });
        host.remove();
      }
    });
  });
});
