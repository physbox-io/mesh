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
      sheetWidth: 0.1, sheetHeight: 0.3, kerf: 0,
    });
    expect(result.layers![0].placedPos2D).toEqual({ x: 8, y: 8 });
    expect(result.layers![1].placedPos2D!.x).toBe(8);
    expect(result.layers![1].placedPos2D!.y).toBeCloseTo(116, 3);
    expect(result.layers![1].sheetIndex).toBe(0);
  });
});

describe('contour layer cut order', () => {
  const square = (lo: number, hi: number) => [
    { x: lo, y: lo }, { x: hi, y: lo }, { x: hi, y: hi }, { x: lo, y: hi },
  ];
  const circle = (cx: number, cy: number, r: number) =>
    Array.from({ length: 24 }, (_, i) => ({ x: cx + r * Math.cos((i / 24) * 2 * Math.PI), y: cy + r * Math.sin((i / 24) * 2 * Math.PI) }));
  // A 100 mm square with a 40 mm window and a dowel hole: the outline first in
  // the list, as the slicer hands it over.
  const layer = {
    index: 0, z: 0.005, pieceCount: 1, areaMm2: 8400,
    loops: [square(0, 100), square(30, 70).reverse(), circle(15, 15, 1.5)],
    sheetIndex: 0, placedPos2D: { x: 10, y: 10 }, modelOffset2D: { x: 0, y: 100 }, width2D: 100, height2D: 100,
  };
  const result = { success: true, layers: [layer], sheetCount: 1 };

  /** The program split into loops, each with how far its points reach from the layer's centre. */
  function loops(gcode: string) {
    const out: { reach: number; text: string[] }[] = [];
    for (const line of gcode.split('\n')) {
      if (/^G0 X/.test(line)) out.push({ reach: 0, text: [] });
      const cur = out[out.length - 1];
      if (!cur) continue;
      cur.text.push(line);
      const x = /X(-?[\d.]+)/.exec(line), y = /Y(-?[\d.]+)/.exec(line);
      if (x && y) cur.reach = Math.max(cur.reach, Math.hypot(parseFloat(x[1]) - 60, parseFloat(y[1]) - 60));
    }
    return out.filter((l) => l.text.some((t) => /^G1 X/.test(t)));
  }

  for (const machineMode of ['cnc', 'laser'] as const) {
    it(`cuts the holes before the ${machineMode} outline that frees the layer, and holds only the outline`, () => {
      const g = generateContourSliceGcode(result, {
        ...DEFAULT_GCODE_OPTIONS, machineMode, cutDepthZ: 6, bitDiameterMm: 1,
        attachmentsEnabled: true, attachmentWidthMm: 3, attachmentSpacingMm: 40,
      });
      const cut = loops(g.gcode);
      expect(cut).toHaveLength(3);
      // The outline reaches the corners, ~71 mm out; the window and dowel do not.
      expect(cut[2].reach).toBeGreaterThan(65);
      expect(cut[0].reach).toBeLessThan(65);
      expect(cut[1].reach).toBeLessThan(65);
      const held = (l: { text: string[] }) => l.text.some((t) => /attachment|Z-[\d.]+ F/.test(t) && /^G1 X.*(Z| S0 )/.test(t));
      expect(held(cut[2])).toBe(true);
      expect(held(cut[0])).toBe(false);
      expect(held(cut[1])).toBe(false);
    });
  }
});

describe('contour stack dowels', () => {
  it('keeps the dowel holes the dowel\'s size when the stack is scaled down', () => {
    const result = exportContourSliceSvg(cube, {
      ...DEFAULT_CONTOUR_OPTIONS, materialThickness: 0.01, kerf: 0,
      pinHoles: true, pinCount: 2, pinDiameter: 0.003, scaleFactor: 0.5,
    });
    expect(result.scaleFactor).toBeCloseTo(0.5, 6);
    expect(result.pins).toHaveLength(2);
    for (const pin of result.pins!) expect(pin.radiusMm).toBeCloseTo(1.5, 3);
    const layer = result.layers![0];
    expect(layer.width2D).toBeCloseTo(50, 1);
    const hole = layer.loops[layer.loops.length - 1];
    const xs = hole.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(3, 1);
  });
});

describe('contour stack kerf', () => {
  const span = (loop: { x: number }[]) => Math.max(...loop.map((p) => p.x)) - Math.min(...loop.map((p) => p.x));

  it('offsets every layer by half the kerf, so a lasered layer comes out at its true size', () => {
    const result = exportContourSliceSvg(cube, {
      ...DEFAULT_CONTOUR_OPTIONS, materialThickness: 0.01, kerf: 0.0002,
      pinHoles: true, pinCount: 2, pinDiameter: 0.003,
    });
    const layer = result.layers![0];
    // The outline grows by half the 0.2 mm kerf all round, the dowel holes shrink by it.
    expect(span(layer.loops[0])).toBeCloseTo(100.2, 2);
    expect(layer.width2D).toBeCloseTo(100.2, 2);
    expect(span(layer.loops[1])).toBeCloseTo(2.8, 1);
    expect(span(layer.loops[2])).toBeCloseTo(2.8, 1);
  });

  it('cuts on the line with no kerf, which is what a router is sent', () => {
    const result = exportContourSliceSvg(cube, {
      ...DEFAULT_CONTOUR_OPTIONS, materialThickness: 0.01, kerf: 0,
      pinHoles: true, pinCount: 2, pinDiameter: 0.003,
    });
    const layer = result.layers![0];
    expect(span(layer.loops[0])).toBeCloseTo(100, 2);
    expect(span(layer.loops[1])).toBeCloseTo(3, 1);
  });

  it('retracts to safeZ in faceLayerLines when hopping across an unfaced gap even if hop <= bitDiameterMm', () => {
    const rect = (x0: number, y0: number, x1: number, y1: number) => [
      { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
    ];
    // Two separate islands whose compensated facing rings sit ~4 mm apart (< 6 mm bit diameter)
    // with an unfaced gap between them at x = 23..27.
    const twoIslands = {
      success: true,
      sheetCount: 1,
      layers: [{
        index: 0, z: 0, pieceCount: 2, areaMm2: 800, facedToMm: 7,
        loops: [rect(0, 0, 20, 20), rect(30, 0, 50, 20)],
      }],
    } as unknown as Parameters<typeof generateContourSliceGcode>[0];
    const g = generateContourSliceGcode(twoIslands, {
      ...DEFAULT_GCODE_OPTIONS,
      machineMode: 'cnc',
      cutDepthZ: 10,
      zStepdown: 3,
      bitDiameterMm: 6,
      attachmentsEnabled: false,
    });
    const facePart = g.gcode.slice(g.gcode.indexOf('--- Facing'), g.gcode.indexOf('; Pass 1/'));
    // Must retract to safeZ at least twice per pass (once for each island), never plowing across the gap at cutting Z.
    expect((facePart.match(/^G0 X/gm) || []).length).toBeGreaterThanOrEqual(2);
  });
});
