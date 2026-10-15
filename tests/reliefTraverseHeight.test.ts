import { describe, it, expect } from 'vitest';
import {
  generateReliefCarveGcode,
  deriveReliefFeeds,
  recommendReliefTooling,
  DEFAULT_RELIEF_OPTIONS,
} from '../src/utils/reliefCarveExporter';
import { gridFromPoints } from '../src/utils/meshLeveler';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

/*
 * How high the cutter flies between cuts, and where it waits for a tool change.
 *
 * A traverse goes a millimetre over the highest material the stock model has
 * along its line: the low hop that keeps a relief from spending its time in
 * the air. The model knows the stock; it does not know the clamps and screws
 * round it. So a short hop stays low, and a long flight across the job goes at
 * the safe height the operator set for exactly that. And when the program is
 * warped to a levelling grid, a rapid is only moved at its end point, so a
 * traverse also has to clear the grid's whole span - which the safe height was
 * clipping away.
 */

function body(geoms: (Partial<SceneGeom> & { type: SceneGeom['type']; size: number[] })[]): SceneGraph {
  return {
    nodes: [{
      id: 'b1', name: 'part', type: 'body', pos: [0, 0, 0],
      geoms: geoms.map((g, i) => ({ name: `g${i}`, ...g }) as SceneGeom),
      joints: [], children: [],
    }],
  };
}

/** Four small domes far apart: pockets to fly between. */
const scattered = body([
  { type: 'sphere', size: [0.012], pos: [-0.035, -0.035, 0] } as never,
  { type: 'sphere', size: [0.012], pos: [0.035, -0.035, 0] } as never,
  { type: 'sphere', size: [0.012], pos: [-0.035, 0.035, 0] } as never,
  { type: 'sphere', size: [0.012], pos: [0.035, 0.035, 0] } as never,
]);

const options = {
  ...DEFAULT_RELIEF_OPTIONS,
  stockWidthMm: 120,
  stockDepthMm: 120,
  stockThicknessMm: 30,
  fitMode: 'manual' as const,
  scalePercent: 100,
  backgroundMode: 'skip' as const,
  carveDepthMm: 8,
  finishingToolType: 'ball' as const,
  finishingToolDiaMm: 3.175,
  safeZ: 15,
};

describe('Traverse height', () => {
  it('flies a long traverse at the safe height', () => {
    const res = generateReliefCarveGcode(scattered, options);
    expect(res.success).toBe(true);
    let long = 0;
    for (let i = 1; i < res.segments.length; i++) {
      const prev = res.segments[i - 1].points;
      const from = prev[prev.length - 1];
      const to = res.segments[i].points[0];
      if (Math.hypot(to.x - from.x, to.y - from.y) <= 40) continue;
      long++;
      expect(res.segments[i].traverseZ).toBeGreaterThanOrEqual(options.safeZ - 1e-6);
    }
    expect(long).toBeGreaterThan(0);
  });

  it('still hops low between neighbouring cuts', () => {
    const res = generateReliefCarveGcode(scattered, options);
    const low = res.segments.filter((s) => s.traverseZ < 2).length;
    expect(low).toBeGreaterThan(res.segments.length / 2);
  });

  it('clears a levelling grid\'s whole span even past the safe height', () => {
    const span = 12;
    const grid = gridFromPoints([
      [{ x: 0, y: 0, z: 0 }, { x: 120, y: 0, z: span }],
      [{ x: 0, y: 120, z: 0 }, { x: 120, y: 120, z: 0 }],
    ]);
    expect(grid).not.toBeNull();
    const res = generateReliefCarveGcode(scattered, {
      ...options, safeZ: 5, applyMeshLeveling: true, meshLevelGrid: grid,
    });
    expect(res.success).toBe(true);
    // Over the stock's top face a traverse has the face, a millimetre and the
    // grid's span to clear.
    expect(Math.max(...res.segments.map((s) => s.traverseZ))).toBeGreaterThanOrEqual(1 + span - 1e-6);
  });
});

describe('Tool change', () => {
  it('parks over the work origin, clear of the work, for the change', () => {
    const res = generateReliefCarveGcode(scattered, { ...options, roughingEnabled: true });
    expect(res.toolChange).toBe(true);
    const lines = res.gcode.split('\n').map((l) => l.split(';')[0].trim()).filter(Boolean);
    const change = lines.findIndex((l) => /^T2\s*M6/.test(l));
    expect(change).toBeGreaterThan(0);
    // Since the last cut: up first, then over to X0 Y0, then the change.
    // (The spindle stops straight after the lift, wherever it is.)
    let lastCut = change;
    while (lastCut > 0 && !lines[lastCut].startsWith('G1')) lastCut--;
    const between = lines.slice(lastCut + 1, change);
    const lift = between.findIndex((l) => /^G0 Z/.test(l));
    const park = between.findIndex((l) => /^G0 X0(\.0+)? Y0(\.0+)?$/.test(l));
    expect(lift).toBeGreaterThanOrEqual(0);
    expect(park).toBeGreaterThan(lift);
  });
});

describe('Roughing feed', () => {
  it('never asks the gantry for more than it can do', () => {
    // The roughing feed is scaled up to the finishing bit's spindle speed,
    // and with a small finisher in aluminium that went past the machine's
    // maximum.
    const derived = deriveReliefFeeds(
      {
        material: 'aluminium',
        finishingToolDiaMm: 1.5,
        finishingFlutes: 1,
        roughingToolDiaMm: 6.35,
        roughingFlutes: 2,
        carveDepthMm: 10,
      },
      null,
      600
    );
    expect(derived.roughingFeedrate).toBeLessThanOrEqual(600);

    const recommended = recommendReliefTooling({
      reliefDepthMm: 10, planWidthMm: 150, planDepthMm: 150, material: 'aluminium', maxFeedMmMin: 600,
    });
    expect(recommended.roughingFeedrate ?? 0).toBeLessThanOrEqual(600);
  });
});
