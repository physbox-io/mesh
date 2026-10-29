import { describe, it, expect } from 'vitest';
import { generateSolidMachining, deriveSolidOptions } from '../src/utils/solidMachiningExporter';
import { registrationPrelude, runSimulationJob, simulatedBody } from '../src/utils/simulatedPart';
import { nextStep, solidPlanKey, solidStepRequest, stepTitle } from '../src/utils/solidSimulationSteps';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import type { SceneGraph, SceneGeom, SceneNode } from '../src/types/scene';

/*
 * Add Simulation one step at a time: the stock as it goes on (pins bored),
 * then the block after each setup, stood as it stands for that setup.
 */

const CELL = 0.5;

function stepJob(result: ReturnType<typeof generateSolidMachining>, tooling: Parameters<typeof solidStepRequest>[1], k: number) {
  const req = solidStepRequest(result, tooling, k);
  return { req, sim: runSimulationJob({ ...req.job!, cellMm: CELL }) };
}

function extent(node: SceneNode): [number, number, number] {
  const v = node.geoms![0].renderVertices!;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], v[i]);
    hi[i % 3] = Math.max(hi[i % 3], v[i]);
  }
  return [0, 1, 2].map((k) => (hi[k] - lo[k]) * 1000) as [number, number, number];
}

describe('a flipped part on registration pins', () => {
  const ball: SceneGraph = {
    nodes: [{
      id: 'b1', name: 'ball', type: 'body', pos: [0, 0, 0],
      geoms: [{ name: 'g1', type: 'sphere', size: [0.02] } as never],
      joints: [], children: [],
    }],
  };
  const opts = { ...deriveSolidOptions(ball, { sides: 2, material: 'softwood' }), registrationPins: true };
  // As the dialog asks for it; the MCP may ask by `sides` alone, which comes back without setups.
  const result = generateSolidMachining(ball, { ...opts, setups: 2 });
  const bySides = generateSolidMachining(ball, opts);
  const T = result.stock.thicknessMm;

  it('plans two setups with pins', () => {
    expect(result.success, result.error).toBe(true);
    expect(result.setups).toHaveLength(2);
    expect(result.pins.length).toBe(2);
  });

  it('steps a plan asked for by sides alone the same way', () => {
    expect(bySides.setups).toBeUndefined();
    const a = solidStepRequest(result, opts, 2), b = solidStepRequest(bySides, opts, 2);
    expect(b.step).toEqual(a.step);
    expect(b.job!.setups!.map((s) => s.rotation)).toEqual(a.job!.setups!.map((s) => s.rotation));
  });

  it('bores the pins and nothing else at step 0', () => {
    const prelude = registrationPrelude(result.setups![0].gcode);
    expect(prelude).toMatch(/OP 0: registration pins/);
    expect(prelude.trimEnd().split('\n').pop()).toMatch(/^G0 X0 Y0/);
    expect(prelude).not.toMatch(/OP 1/);
    const { sim } = stepJob(result, opts, 0);
    const bores = result.pins.length * Math.PI * (opts.pinDiaMm / 2) ** 2 * T;
    const removed = sim.stockVolumeMm3 - sim.volumeMm3;
    // The drawn mesh is only as close as its merge tolerance, a fraction of a
    // percent of the block; any of the part itself would be tens of percent.
    expect(removed).toBeGreaterThan(bores * 0.95);
    expect(Math.abs(removed - bores)).toBeLessThan(sim.stockVolumeMm3 * 0.003);
    expect(sim.rapidCuts).toBe(0);
  });

  it('takes material off at every step, and ends where the one-shot simulation does', () => {
    const vols = [0, 1, 2].map((k) => stepJob(result, opts, k).sim.volumeMm3);
    expect(vols[1]).toBeLessThan(vols[0]);
    expect(vols[2]).toBeLessThan(vols[1]);
    const whole = runSimulationJob({ ...solidStepRequest(result, opts, 2).job!, stage: undefined, cellMm: CELL });
    expect(vols[2]).toBeCloseTo(whole.volumeMm3, 3);
  });

  it('stands step 2 upside down, as the flipped block sits, wound outward', () => {
    const { req, sim } = stepJob(result, opts, 2);
    const body = simulatedBody(sim, req.transform, {
      id: 's2', name: 'step 2', kind: 'machining', placement: 'beside',
      machineFrame: req.step!.machineFrame, stage: req.step,
    });
    expect(body.simulation).toMatchObject({ stage: 2, stages: 3, planKey: solidPlanKey(result.setups!) });
    const check = analyzeMesh(body.geoms![0].renderVertices!, body.geoms![0].faces!)!;
    expect(check.volume).toBeGreaterThan(0);
    expect(check.consistentlyWound).toBe(true);
    expect(req.step!.machineFrame[8]).toBe(-1);
  });
});

describe('a part turned onto its sides', () => {
  const W = 135, D = 138, H = 19;
  function prism(name: string, profile: [number, number][]): SceneGeom {
    const v: number[] = [];
    for (const x of [0, W]) for (const [y, z] of profile) v.push(x / 1000, y / 1000, z / 1000);
    const n = profile.length;
    const faces: number[] = [];
    for (let i = 1; i < n - 1; i++) faces.push(0, i + 1, i, n, n + i, n + i + 1);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      faces.push(i, j, n + j, i, n + j, n + i);
    }
    return { name, type: 'mesh', size: [1], renderVertices: v, faces } as SceneGeom;
  }
  const run = 12 * Math.tan((15 * Math.PI) / 180);
  const tray: SceneGraph = {
    nodes: [{
      id: 'b1', name: 'tray', type: 'body', pos: [0, 0, 0],
      geoms: [
        prism('base', [[0, 0], [D, 0], [D, 7], [0, 7]]),
        prism('front', [[0, 7], [60, 7], [60 + run, H], [0, H]]),
        prism('back', [[72, 7], [D, 7], [D, H], [72 + run, H]]),
      ],
      joints: [], children: [],
    }],
  };
  const opts = deriveSolidOptions(tray, {
    sides: 1, material: 'softwood', roughingToolDiaMm: 6, finishingToolDiaMm: 6, finishingToolType: 'flat',
    toolStickoutMm: 80, stockWidthMm: 156, stockDepthMm: 160, stockThicknessMm: 30,
  });
  const result = generateSolidMachining(tray, { ...opts, setups: 'auto' });
  const setups = result.setups!;

  it('stands each step as its setup holds the block', () => {
    expect(result.success, result.error).toBe(true);
    expect(setups.some((s) => s.upFace !== '+z' && s.upFace !== '-z')).toBe(true);
    let last = Infinity;
    for (let k = 0; k <= setups.length; k++) {
      const { req, sim } = stepJob(result, opts, k);
      expect(sim.volumeMm3).toBeLessThanOrEqual(last + 1);
      last = sim.volumeMm3;
      const body = simulatedBody(sim, req.transform, {
        id: `s${k}`, name: `step ${k}`, kind: 'machining', placement: 'beside',
        machineFrame: req.step!.machineFrame, stage: req.step,
      });
      const check = analyzeMesh(body.geoms![0].renderVertices!, body.geoms![0].faces!);
      if (check) {
        expect(check.volume, `step ${k}`).toBeGreaterThan(0);
        expect(check.consistentlyWound, `step ${k}`).toBe(true);
      }
      // The block as it stands for the setup: its height is that setup's stock
      // thickness, since no setup cuts right through the block's full height.
      const s = setups[Math.max(0, k - 1)].stock;
      const [, , z] = extent(body);
      expect(z, `step ${k}`).toBeCloseTo(s.thicknessMm, 0);
    }
  }, 120_000);

  it('cuts the datum notch in setup 1, and says so at step 0', () => {
    expect(setups[0].gcode).toMatch(/Datum notch/);
    expect(solidStepRequest(result, opts, 0).details!.join(' ')).toMatch(/datum notch/);
    const notch = 8 ** 3;
    const v0 = stepJob(result, opts, 0).sim;
    expect(v0.stockVolumeMm3 - v0.volumeMm3).toBeLessThan(1);
    // Setup 1 takes at least the notch.
    expect(v0.volumeMm3 - stepJob(result, opts, 1).sim.volumeMm3).toBeGreaterThan(notch);
  }, 60_000);

  it('names the steps and finds the next one from the scene', () => {
    expect(stepTitle(setups, 0)).toBe('Stock');
    expect(stepTitle(setups, 1)).toMatch(/^Setup 1, .+ up$/);
    const key = solidPlanKey(setups);
    const node = (stage: number, planKey = key) =>
      ({ id: `n${stage}`, simulation: { kind: 'machining', stage, planKey } }) as unknown as SceneNode;
    expect(nextStep([], key)).toBe(0);
    expect(nextStep([node(0), node(1)], key)).toBe(2);
    expect(nextStep([node(0), node(3, 'other')], key)).toBe(1);
  });
});
