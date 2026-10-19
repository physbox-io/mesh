import { describe, it, expect } from 'vitest';
import { generateReliefCarveGcode, DEFAULT_RELIEF_OPTIONS } from '../src/utils/reliefCarveExporter';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

/** One body made of boxes, each given as min/max corners in millimetres. */
function boxes(...parts: { min: [number, number, number]; max: [number, number, number] }[]): SceneGraph {
  return {
    nodes: [{
      id: 'b1',
      name: 'part',
      type: 'body',
      pos: [0, 0, 0],
      geoms: parts.map((p, i) => ({
        name: `g${i}`,
        type: 'box',
        pos: [0, 1, 2].map((k) => (p.min[k] + p.max[k]) / 2000),
        size: [0, 1, 2].map((k) => (p.max[k] - p.min[k]) / 2000),
      }) as SceneGeom),
      joints: [],
      children: [],
    }],
  };
}

/**
 * A 120 x 100 tray 20 mm tall with a 15 mm pocket: a 5 mm floor and four
 * walls. Its bounding height is 20, the depth a cutter has to reach is 15.
 */
const tray = boxes(
  { min: [-60, -50, 0], max: [60, 50, 5] },
  { min: [-60, -50, 0], max: [-50, 50, 20] },
  { min: [50, -50, 0], max: [60, 50, 20] },
  { min: [-50, -50, 0], max: [50, -40, 20] },
  { min: [-50, 40, 0], max: [50, 50, 20] },
);

const stock = { stockWidthMm: 130, stockDepthMm: 110, stockThicknessMm: 25 };
const quick = {
  roughingEnabled: false,
  finishingToolDiaMm: 3.175,
  finishingStepoverPercent: 60,
};

describe('a relief cut as modelled', () => {
  it('cuts a tray that fits its stock at its own size and depth by default in the app', () => {
    const r = generateReliefCarveGcode(tray, {
      ...stock,
      ...quick,
      verticalScaleMode: 'auto',
      backgroundMode: 'auto',
    });
    expect(r.success).toBe(true);
    expect(r.heightMode).toBe('model');
    expect(r.scaleFactor).toBe(1);
    // The pocket floor, not the bounding height, and not the 10 mm default.
    expect(r.reliefDepthMm).toBeCloseTo(15, 0);
    expect(r.stockTransform?.scale).toEqual([1, 1, 1]);
    // 120 x 100 on the stock, not shrunk by the cutter's diameter.
    expect(r.carveBounds.maxX - r.carveBounds.minX).toBeCloseTo(120, 1);
    expect(r.carveBounds.maxY - r.carveBounds.minY).toBeCloseTo(100, 1);
    expect(r.undercut).toBeUndefined();
  });

  it('ignores the carve depth and plan scale when told to cut as modelled', () => {
    const r = generateReliefCarveGcode(tray, {
      ...stock,
      ...quick,
      verticalScaleMode: 'model',
      carveDepthMm: 3,
      fitMode: 'manual',
      scalePercent: 50,
    });
    expect(r.heightMode).toBe('model');
    expect(r.scaleFactor).toBe(1);
    expect(r.reliefDepthMm).toBeCloseTo(15, 0);
  });

  it('still fits a model by default when called without the app defaults', () => {
    expect(DEFAULT_RELIEF_OPTIONS.verticalScaleMode).toBe('fill');
    const r = generateReliefCarveGcode(tray, { ...stock, ...quick });
    expect(r.heightMode).toBe('fill');
    expect(r.reliefDepthMm).toBeCloseTo(DEFAULT_RELIEF_OPTIONS.carveDepthMm, 3);
  });

  it('falls back to fitting, and says so, when the model is wider than the stock', () => {
    const r = generateReliefCarveGcode(tray, {
      ...quick,
      stockWidthMm: 100,
      stockDepthMm: 100,
      stockThicknessMm: 25,
      verticalScaleMode: 'auto',
    });
    expect(r.success).toBe(true);
    expect(r.heightMode).toBe('fill');
    expect(r.scaleFactor).toBeLessThan(1);
    expect(r.warnings.some((w) => /bigger than the 100 x 100 mm stock/.test(w))).toBe(true);
  });

  it('falls back to fitting when the model is deeper than the stock allows', () => {
    const r = generateReliefCarveGcode(tray, {
      ...quick,
      ...stock,
      stockThicknessMm: 12,
      verticalScaleMode: 'auto',
    });
    expect(r.heightMode).toBe('fill');
    expect(r.reliefDepthMm).toBeLessThanOrEqual(11 + 1e-6);
    expect(r.warnings.some((w) => /needs 15\.0 mm of depth/.test(w))).toBe(true);
  });

  it('says by how much a true-size model overhangs the stock', () => {
    const r = generateReliefCarveGcode(tray, {
      ...quick,
      stockWidthMm: 115,
      stockDepthMm: 110,
      stockThicknessMm: 25,
      verticalScaleMode: 'model',
    });
    expect(r.warnings.some((w) => /5\.0 mm wider than your stock \(120\.0 vs 115 mm\)/.test(w))).toBe(true);
  });

  it('reports what an overhang hides from a cutter coming straight down', () => {
    // A 5 mm plate with a shelf floating 10 mm over half of it: the space
    // under the shelf is part of the model and no 3-axis cut can reach it.
    const shelf = boxes(
      { min: [-50, -40, 0], max: [50, 40, 5] },
      { min: [0, -40, 15], max: [50, 40, 20] },
    );
    const r = generateReliefCarveGcode(shelf, {
      ...quick,
      stockWidthMm: 110,
      stockDepthMm: 90,
      stockThicknessMm: 25,
      verticalScaleMode: 'model',
    });
    expect(r.success).toBe(true);
    expect(r.undercut).toBeDefined();
    // 50 x 80 mm of shelf over a 10 mm gap.
    expect(r.undercut!.areaMm2).toBeGreaterThan(50 * 80 * 0.9);
    expect(r.undercut!.areaMm2).toBeLessThan(50 * 80 * 1.1);
    expect(r.undercut!.maxMm).toBeCloseTo(10, 0);
    expect(r.warnings.some((w) => /undercut/.test(w))).toBe(true);
  });

  it('leaves the board round a smaller true-size model alone, and says so', () => {
    const r = generateReliefCarveGcode(tray, {
      ...quick,
      stockWidthMm: 200,
      stockDepthMm: 200,
      stockThicknessMm: 25,
      verticalScaleMode: 'auto',
      backgroundMode: 'auto',
    });
    expect(r.heightMode).toBe('model');
    expect(r.warnings.some((w) => /smaller than the stock/.test(w))).toBe(true);
    // Nothing is cut outside the tray: every cutting move stays over it, give
    // or take the cutter's radius.
    const xs = [...r.gcode.matchAll(/^G1 .*X(-?[\d.]+)/gm)].map((m) => parseFloat(m[1]));
    expect(Math.min(...xs)).toBeGreaterThan(100 - 60 - 2);
    expect(Math.max(...xs)).toBeLessThan(100 + 60 + 2);
  });
});
