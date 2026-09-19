import { describe, it, expect } from 'vitest';
import { buildPatternPlank, patternById, PANEL_BASE_MM } from '../src/utils/surfacePatterns';
import {
  generateReliefCarveGcode,
  DEFAULT_RELIEF_OPTIONS,
  type ReliefCarveOptions,
} from '../src/utils/reliefCarveExporter';
import type { StockSize } from '../src/utils/stockSettings';
import type { SceneGraph } from '../src/types/scene';

/*
 * The claim this file exists to check.
 *
 * A generated board is not a pattern sitting on top of a plank -- it IS the
 * plank, sized to the stock, with the pattern as its top face. If that holds,
 * the existing relief carve exporter machines it with no special case: Z0 is
 * the top of the stock, the pattern's peaks are that same surface, and the
 * cutter only ever descends into the valleys.
 *
 * If it ever stops holding, the symptom is not an error. It is a job that
 * faces the whole board off before it starts, or one that cuts through it.
 */

const stock: StockSize = { widthMm: 200, depthMm: 120, thicknessMm: 20 };
const DEPTH_MM = 5;

/** Exactly what the generator dialog hands the exporter. */
function carveOptions(over: Partial<ReliefCarveOptions> = {}): ReliefCarveOptions {
  return {
    ...DEFAULT_RELIEF_OPTIONS,
    stockWidthMm: stock.widthMm,
    stockDepthMm: stock.depthMm,
    stockThicknessMm: stock.thicknessMm,
    carveDepthMm: DEPTH_MM + PANEL_BASE_MM,
    fitMode: 'manual',
    scalePercent: 100,
    verticalScaleMode: 'proportional',
    verticalExaggeration: 1,
    backgroundMode: 'skip',
    ...over,
  };
}

function plankScene(id: string): SceneGraph {
  const spec = patternById(id)!;
  const { node } = buildPatternPlank(spec, spec.defaults, stock, DEPTH_MM, 160);
  return { nodes: [node] };
}

describe('a generated board goes straight through the relief exporter', () => {
  it('cuts a wood grain board to exactly the depth that was asked for', () => {
    const result = generateReliefCarveGcode(plankScene('wood_grain'), carveOptions());
    expect(result.success).toBe(true);
    expect(result.gcode.length).toBeGreaterThan(0);
    // 'proportional' at 1x means the relief is the mesh's own height range,
    // which is the pattern depth and nothing else.
    expect(result.reliefDepthMm).toBeCloseTo(DEPTH_MM + PANEL_BASE_MM, 1);
  });

  it('never asks the cutter to go through the back of the board', () => {
    const result = generateReliefCarveGcode(plankScene('masonry'), carveOptions());
    expect(result.success).toBe(true);
    // Every Z in the program is between the safe height and the deepest cut.
    let deepest = 0;
    for (const m of result.gcode.matchAll(/Z(-?\d+(?:\.\d+)?)/g)) {
      deepest = Math.min(deepest, Number(m[1]));
    }
    expect(deepest).toBeLessThan(0);
    expect(deepest).toBeGreaterThanOrEqual(-stock.thicknessMm);
    expect(deepest).toBeGreaterThanOrEqual(-DEPTH_MM - PANEL_BASE_MM - 0.5);
  });

  it('does not warn about the stock or the fit at the settings the dialog ships', () => {
    // Every warning the exporter raises here would be about a mismatch the
    // generator is supposed to have made impossible.
    const result = generateReliefCarveGcode(plankScene('waves'), carveOptions());
    expect(result.success).toBe(true);
    // The exporter reserves half a cutter all round, so a panel that fills the
    // stock edge to edge is reported as overhanging: the outer tool-radius band
    // is left uncut. That is true and worth saying, and it is the price of a
    // pattern that runs to the edge instead of sitting in a bare border.
    const complaints = (result.warnings ?? []).filter((w) => !/overhangs the stock/.test(w));
    expect(complaints).toEqual([]);
  });

  it('leaves the high points of the pattern as untouched stock face', () => {
    // The whole idea: the peaks are Z0, so there is material the cutter never
    // touches. A program whose shallowest cut is well below zero has faced the
    // board off, which means the board was not the size of the stock.
    const result = generateReliefCarveGcode(plankScene('wood_grain'), carveOptions());
    expect(result.success).toBe(true);
    let shallowestCut = -Infinity;
    for (const line of result.gcode.split('\n')) {
      if (!/^G1/.test(line)) continue;
      const m = /Z(-?\d+(?:\.\d+)?)/.exec(line);
      if (m) shallowestCut = Math.max(shallowestCut, Number(m[1]));
    }
    expect(shallowestCut).toBeGreaterThan(-1);
  });

  it('carves every pattern in the menu without failing', () => {
    for (const id of ['wood_grain', 'waves', 'topographic', 'voronoi', 'masonry', 'studs', 'foliage']) {
      const result = generateReliefCarveGcode(plankScene(id), carveOptions());
      expect(result.success, `${id}: ${result.error ?? ''}`).toBe(true);
      expect(result.gcode.length, id).toBeGreaterThan(0);
    }
  });
});
