// The parts the relief and solid CAM fixes were made on, cut back out of a
// block: a sloped relief, a stepped shelf, a pocket with an island and a
// two-sided solid. Whatever else a change to the roughing, the finishing
// order or the links does, no rapid may take material off on any of them.
import { describe, it, expect } from 'vitest';
import { generateReliefCarveGcode, DEFAULT_RELIEF_OPTIONS } from '../src/utils/reliefCarveExporter';
import { generateSolidMachining } from '../src/utils/solidMachiningExporter';
import { cutStock } from '../src/utils/cutSimulation';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

function body(geoms: (Partial<SceneGeom> & { type: SceneGeom['type']; size: number[] })[]): SceneGraph {
  return {
    nodes: [{
      id: 'b1', name: 'part', type: 'body', pos: [0, 0, 0],
      geoms: geoms.map((g, i) => ({ name: `g${i}`, ...g }) as SceneGeom),
      joints: [], children: [],
    }],
  };
}

const parts: [string, SceneGraph][] = [
  ['sloped dome', body([{ type: 'sphere', size: [0.05] }])],
  ['stepped shelf', body([
    { type: 'box', size: [0.04, 0.04, 0.006], pos: [0, 0, 0.006] } as never,
    { type: 'box', size: [0.02, 0.02, 0.008], pos: [0, 0, 0.02] } as never,
  ])],
  ['pocket with an island', body([
    { type: 'box', size: [0.05, 0.006, 0.01], pos: [0, 0.044, 0.01] } as never,
    { type: 'box', size: [0.05, 0.006, 0.01], pos: [0, -0.044, 0.01] } as never,
    { type: 'box', size: [0.006, 0.05, 0.01], pos: [0.044, 0, 0.01] } as never,
    { type: 'box', size: [0.006, 0.05, 0.01], pos: [-0.044, 0, 0.01] } as never,
    { type: 'box', size: [0.012, 0.012, 0.01], pos: [0, 0, 0.01] } as never,
  ])],
];

// One diameter for both tools: the simulator cuts with one radius, swapping
// only the end's shape at the tool change.
const TOOL = 3.175;
const TOLERANCE_MM = 0.05;

describe('no rapid through the stock on the batch-3 parts', () => {
  for (const [name, scene] of parts) {
    for (const finishingStrategy of ['hybrid', 'contour'] as const) {
      it(`${name}, adaptive roughing, ${finishingStrategy} finish`, () => {
        const res = generateReliefCarveGcode(scene, {
          ...DEFAULT_RELIEF_OPTIONS,
          stockWidthMm: 140, stockDepthMm: 140, stockThicknessMm: 40,
          fitMode: 'manual', scalePercent: 100,
          backgroundMode: 'carve', carveDepthMm: 20,
          roughingStrategy: 'adaptive',
          roughingToolDiaMm: TOOL, finishingToolDiaMm: TOOL, finishingToolType: 'ball',
          finishingStrategy,
        });
        expect(res.success).toBe(true);
        const hits = cutStock(res.gcode, 140, 140, TOOL / 2, 'ball')
          .filter((c) => c.rapid && c.removedMm > TOLERANCE_MM);
        expect(hits.slice(0, 5)).toEqual([]);
      });
    }
  }

  it('a flanged part cut from both sides', () => {
    const res = generateSolidMachining(body([
      { type: 'box', size: [0.03, 0.03, 0.002], pos: [0, 0, 0.002] } as never,
      { type: 'box', size: [0.015, 0.015, 0.02], pos: [0, 0, 0.02] } as never,
    ]), {
      sides: 2, roughingToolDiaMm: 6.35, finishingToolDiaMm: 6.35,
      finishingToolType: 'flat', finishingStepoverPercent: 40, material: 'softwood',
    });
    expect(res.success, res.error).toBe(true);
    for (const side of res.sides) {
      const hits = cutStock(side.gcode, res.stock.widthMm, res.stock.depthMm, 6.35 / 2)
        .filter((c) => c.rapid && c.removedMm > TOLERANCE_MM);
      expect(hits.slice(0, 5), `side ${side.side}`).toEqual([]);
    }
  });
});
