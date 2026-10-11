import { describe, it, expect } from 'vitest';
import { generateReliefCarveGcode, DEFAULT_RELIEF_OPTIONS } from '../src/utils/reliefCarveExporter';
import { generateSolidMachining, deriveSolidOptions } from '../src/utils/solidMachiningExporter';
import type { SceneGraph } from '../src/types/scene';
import { cutStockMap } from './helpers/cutStock';

/*
 * Whether the toolpath is a sensible use of machine time, not only a safe one.
 *
 * Every other test of the carve asks whether a path is correct: no rapid
 * through stock, no gouge, no dive. A path can pass all of them and still be a
 * waste of an afternoon, and twice that is what went to the machine. On a
 * giraffe relief the roughing end mill cut a dozen holes, hopping between them
 * across the stock, and left the 1.5875 mm ball nose to take up to 3.5 mm in
 * a single sweep over most of the part.
 *
 * Roughing then cleared a cell on a layer only where the finished surface lay
 * below that layer, so everything shallower than the first layer - most of a
 * relief - was never roughed, and a layer of terrace stood between every two.
 * Its rings went out ring-major across the whole stock in scan order.
 *
 * Each figure below was measured on the old path and the new one. Loosen a
 * bound only with a measurement that says why.
 */

/** A 100 mm dome: highest at its centre, falling to the carve depth at the rim. */
const dome: SceneGraph = {
  nodes: [{
    id: 'b1', name: 'part', type: 'body', pos: [0, 0, 0],
    geoms: [{ name: 'g1', type: 'sphere', size: [0.05] } as never],
    joints: [], children: [],
  }],
};

const STOCK = 120;
// One diameter for both tools: the simulator cuts with one radius throughout,
// swapping only the end's shape at the finishing pass.
const TOOL = 3.175;

const options = {
  ...DEFAULT_RELIEF_OPTIONS,
  stockWidthMm: STOCK,
  stockDepthMm: STOCK,
  fitMode: 'manual' as const,
  scalePercent: 100,
  backgroundMode: 'skip' as const,
  carveDepthMm: 10,
  roughingToolDiaMm: TOOL,
  finishingToolDiaMm: TOOL,
  finishingToolType: 'ball' as const,
};

/** The material roughing left above the finished surface, sorted ascending. */
function leftOver(strategy: 'adaptive' | 'raster') {
  const res = generateReliefCarveGcode(dome, { ...options, roughingStrategy: strategy });
  expect(res.success).toBe(true);
  const split = res.gcode.indexOf('OP 2: finishing');
  expect(split).toBeGreaterThan(0);
  const rough = cutStockMap(res.gcode.slice(0, split), STOCK, STOCK, TOOL / 2, 'flat');
  const done = cutStockMap(res.gcode, STOCK, STOCK, TOOL / 2, 'ball');

  const left: number[] = [];
  for (let i = 0; i < done.heights.length; i++) {
    // Only where the job cuts something at all.
    if (done.heights[i] > -0.5) continue;
    left.push(Math.max(0, rough.heights[i] - done.heights[i]));
  }
  left.sort((a, b) => a - b);
  return { res, left, at: (q: number) => left[Math.floor(q * (left.length - 1))] };
}

/** XY distance flown at rapid and cut at feed. */
function travel(gcode: string) {
  let x = 0, y = 0, rapid = 0, cut = 0;
  for (const raw of gcode.split('\n')) {
    const line = raw.split(';')[0];
    const mode = /^G([01])\b/.exec(line);
    if (!mode) continue;
    const nx = parseFloat(/X(-?[\d.]+)/.exec(line)?.[1] ?? String(x));
    const ny = parseFloat(/Y(-?[\d.]+)/.exec(line)?.[1] ?? String(y));
    const d = Math.hypot(nx - x, ny - y);
    if (mode[1] === '0') rapid += d; else cut += d;
    x = nx; y = ny;
  }
  return { rapid, cut };
}

/** How much of the material the whole job removes the roughing pass removes. */
function roughingShare(gcode: string) {
  const split = gcode.indexOf('OP 2: finishing');
  const rough = cutStockMap(gcode.slice(0, split), STOCK, STOCK, TOOL / 2, 'flat');
  const done = cutStockMap(gcode, STOCK, STOCK, TOOL / 2, 'ball');
  let byRough = 0, total = 0;
  for (let i = 0; i < done.heights.length; i++) {
    byRough -= rough.heights[i];
    total -= done.heights[i];
  }
  return byRough / total;
}

describe('roughing a relief', () => {
  for (const strategy of ['adaptive', 'raster'] as const) {
    // Was 1.06 mm (adaptive) and 1.10 mm (raster) at the median, on a 0.5 mm
    // allowance; 0.37 and 0.26 once each slab followed the surface.
    it(`${strategy}: leaves little more than the allowance for the finishing tool`, () => {
      const { at } = leftOver(strategy);
      const allowance = DEFAULT_RELIEF_OPTIONS.roughingAllowanceMm;
      // The flat mill cannot follow the dome's curve exactly between its
      // stepovers, and the ball takes off the scallops a flat leaves on a
      // slope, so this is not zero - but it is a fraction of a millimetre, not
      // a roughing layer.
      expect(at(0.5)).toBeLessThan(allowance + 0.2);
      expect(at(0.9)).toBeLessThan(allowance + 0.3);
    });

    // Was 39% (adaptive) and 36% (raster); 76% and 81% after. The rest is
    // mostly the allowance itself, which on a 10 mm dome is a good part of it.
    it(`${strategy}: does most of the material removal, not the finishing tool`, () => {
      const res = generateReliefCarveGcode(dome, { ...options, roughingStrategy: strategy });
      expect(roughingShare(res.gcode)).toBeGreaterThan(0.7);
    });
  }

  // Was 0.29: a rapid across the stock between every ring of every pocket.
  // 0.04 once each pocket was finished before the next, nearest first.
  it('adaptive: flies little between cuts', () => {
    const res = generateReliefCarveGcode(dome, { ...options, roughingStrategy: 'adaptive' });
    const { rapid, cut } = travel(res.gcode.slice(0, res.gcode.indexOf('OP 2: finishing')));
    expect(rapid / cut).toBeLessThan(0.1);
  });

  // Raster still hops over whatever stands in a row's way, once per row, so
  // it flies a lot (0.78); this holds it from getting worse.
  it('raster: does not fly further than it cuts', () => {
    const res = generateReliefCarveGcode(dome, { ...options, roughingStrategy: 'raster' });
    const { rapid, cut } = travel(res.gcode.slice(0, res.gcode.indexOf('OP 2: finishing')));
    expect(rapid / cut).toBeLessThan(1);
  });
});

/*
 * Solid machining roughs through the same `machineSurface()`, and had the same
 * fault: on a 60 mm sphere's first side the finisher was left 1.25 mm at the
 * median and 3.61 mm at p90 (0.4 mm allowance), and roughing flew 0.38 of
 * what it cut. After: 0.28, 0.54 and 0.045.
 */
describe('roughing a solid part', () => {
  const ball: SceneGraph = {
    nodes: [{
      id: 'b1', name: 'part', type: 'body', pos: [0, 0, 0],
      geoms: [{ name: 'g1', type: 'sphere', size: [0.03] } as never],
      joints: [], children: [],
    }],
  };
  const opts = deriveSolidOptions(ball, {
    sides: 2, material: 'softwood',
    roughingToolDiaMm: TOOL, finishingToolDiaMm: TOOL, finishingToolType: 'ball_nose',
  });
  const res = generateSolidMachining(ball, opts);
  const side = res.sides[0].gcode;
  const split = side.indexOf('OP 2: finishing');

  it('leaves the finisher little more than the allowance', () => {
    const W = res.stock.widthMm;
    const D = res.stock.depthMm;
    const rough = cutStockMap(side.slice(0, split), W, D, TOOL / 2, 'flat');
    const done = cutStockMap(side, W, D, TOOL / 2, 'ball');
    const left: number[] = [];
    for (let i = 0; i < done.heights.length; i++) {
      if (done.heights[i] < -0.5) left.push(Math.max(0, rough.heights[i] - done.heights[i]));
    }
    left.sort((a, b) => a - b);
    expect(left[Math.floor(left.length * 0.5)]).toBeLessThan(opts.roughingAllowanceMm + 0.2);
    expect(left[Math.floor(left.length * 0.9)]).toBeLessThan(opts.roughingAllowanceMm + 0.4);
  });

  it('flies little between cuts', () => {
    const { rapid, cut } = travel(side.slice(0, split));
    expect(rapid / cut).toBeLessThan(0.1);
  });
});
