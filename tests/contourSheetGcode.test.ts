import { describe, it, expect } from 'vitest';
import { exportContourSliceSvg, DEFAULT_CONTOUR_OPTIONS } from '../src/utils/contourSliceExporter';
import { generateContourSliceGcode, DEFAULT_GCODE_OPTIONS } from '../src/utils/gcodeExporter';
import type { SceneGraph } from '../src/types/scene';

// A 100 mm cube on z = 0, cut from 10 mm stock: ten 100 x 100 mm layers, four
// to a 300 x 250 mm sheet, so three sheets.
const cube: SceneGraph = {
  nodes: [{
    id: 'b1', name: 'part', type: 'body', pos: [0, 0, 0.05], joints: [], children: [],
    geoms: [{ name: 'g1', type: 'box', size: [0.05, 0.05, 0.05] }],
  }],
};
const SHEET_W = 300;
const SHEET_H = 250;

function sliceCube() {
  return exportContourSliceSvg(cube, {
    ...DEFAULT_CONTOUR_OPTIONS,
    materialThickness: 0.01,
    pinHoles: false,
    sheetWidth: SHEET_W / 1000,
    sheetHeight: SHEET_H / 1000,
  });
}

/** Every X/Y the program moves to, in order. */
function moves(gcode: string): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const line of gcode.split('\n')) {
    const x = /X(-?[\d.]+)/.exec(line);
    const y = /Y(-?[\d.]+)/.exec(line);
    if (x && y && /^G[01]\b/.test(line)) out.push({ x: parseFloat(x[1]), y: parseFloat(y[1]) });
  }
  return out;
}

describe('contour stack sheets', () => {
  it('places each layer on its own sheet, in that sheet\'s coordinates', () => {
    const result = sliceCube();
    expect(result.success).toBe(true);
    expect(result.sheetCount).toBe(3);
    for (const layer of result.layers!) {
      expect(layer.sheetIndex).toBeGreaterThanOrEqual(0);
      expect(layer.sheetIndex).toBeLessThan(3);
      expect(layer.placedPos2D!.y + layer.height2D!).toBeLessThanOrEqual(SHEET_H);
    }
    expect(result.layers!.map((l) => l.sheetIndex)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2]);
  });

  it('still draws later sheets below the first in the SVG', () => {
    const result = sliceCube();
    const ys = [...result.svg!.matchAll(/[ML] (-?[\d.]+) (-?[\d.]+)/g)].map((m) => parseFloat(m[2]));
    expect(Math.max(...ys)).toBeGreaterThan(2 * SHEET_H);
    expect(Math.max(...ys)).toBeLessThanOrEqual(3 * SHEET_H);
  });

  for (const machineMode of ['cnc', 'laser'] as const) {
    it(`keeps every ${machineMode} move on the sheet, whichever sheet it is`, () => {
      const result = sliceCube();
      const g = generateContourSliceGcode(result, { ...DEFAULT_GCODE_OPTIONS, machineMode, cutDepthZ: 10 });
      expect(g.success).toBe(true);
      const pts = moves(g.gcode);
      expect(pts.length).toBeGreaterThan(0);
      for (const p of pts) {
        expect(p.y).toBeGreaterThanOrEqual(-5);
        expect(p.y).toBeLessThanOrEqual(SHEET_H);
        expect(p.x).toBeLessThanOrEqual(SHEET_W);
      }
      expect(g.bounds.maxY).toBeLessThanOrEqual(SHEET_H);
    });
  }

  it('pauses for a new sheet between sheets, not between layers on one sheet', () => {
    const result = sliceCube();
    const g = generateContourSliceGcode(result, { ...DEFAULT_GCODE_OPTIONS, machineMode: 'cnc', cutDepthZ: 10 });
    const pauses = g.gcode.split('\n').filter((l) => /^M0\b/.test(l));
    expect(pauses).toHaveLength(2);
    expect(pauses[0]).toContain('Sheet 2 of 3');
    expect(pauses[1]).toContain('Sheet 3 of 3');
    expect(g.operations.filter((o) => o.type === 'pause_sheet').map((o) => o.sheetIndex)).toEqual([1, 2]);
    expect(g.operations.filter((o) => o.type === 'cut').every((o) => o.sheetIndex! <= 2)).toBe(true);
  });
});

describe('contour stack nesting', () => {
  it('starts on the first sheet when a layer is taller than the sheet', () => {
    // 100 mm layers on a 300 x 100 mm sheet: none fits with its margins.
    const result = exportContourSliceSvg(cube, {
      ...DEFAULT_CONTOUR_OPTIONS, materialThickness: 0.01, pinHoles: false,
      sheetWidth: 0.3, sheetHeight: 0.1,
    });
    expect(result.layers![0].sheetIndex).toBe(0);
    expect(result.layers![0].placedPos2D).toEqual({ x: 8, y: 8 });
    // Two a sheet across, and no blank sheet in front of them.
    expect(result.sheetCount).toBe(5);
  });

  it('does not skip a row when a layer is wider than the sheet', () => {
    const result = exportContourSliceSvg(cube, {
      ...DEFAULT_CONTOUR_OPTIONS, materialThickness: 0.01, pinHoles: false,
      sheetWidth: 0.1, sheetHeight: 0.3,
    });
    expect(result.layers![0].placedPos2D).toEqual({ x: 8, y: 8 });
    expect(result.layers![1].placedPos2D!.x).toBe(8);
    expect(result.layers![1].placedPos2D!.y).toBeCloseTo(116, 3);
    expect(result.layers![1].sheetIndex).toBe(0);
  });
});
