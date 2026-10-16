import { describe, it, expect } from 'vitest';
import { generateReliefCarveGcode, DEFAULT_RELIEF_OPTIONS } from '../src/utils/reliefCarveExporter';
import { generateSolidMachining, deriveSolidOptions } from '../src/utils/solidMachiningExporter';
import type { SceneGraph } from '../src/types/scene';
import { cutStockMap } from '../src/utils/cutSimulation';

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

/** How roughing gets into its cuts: lifts out, reversals, and ramping at the plunge rate. */
function entries(gcode: string, plungeRate: number) {
  let x = 0, y = 0, z = 0, feed = 0, ux = 0, uy = 0;
  let lifts = 0, reversals = 0, plungeMm = 0;
  for (const raw of gcode.slice(0, gcode.indexOf('OP 2: finishing')).split('\n')) {
    const line = raw.split(';')[0];
    const mode = /^G([01])\b/.exec(line);
    if (!mode) continue;
    const word = (k: string, d: number) => {
      const m = new RegExp(`${k}(-?[\\d.]+)`).exec(line);
      return m ? parseFloat(m[1]) : d;
    };
    const nx = word('X', x), ny = word('Y', y), nz = word('Z', z);
    feed = word('F', feed);
    if (mode[1] === '0') {
      if (nz > z + 1e-9) lifts++;
      ux = uy = 0;
    } else {
      const len = Math.hypot(nx - x, ny - y);
      if (len > 1e-6) {
        if ((nx - x) * ux + (ny - y) * uy < -0.9 * len) reversals++;
        ux = (nx - x) / len;
        uy = (ny - y) / len;
      }
      if (feed === plungeRate) plungeMm += Math.hypot(nx - x, ny - y, nz - z);
    }
    x = nx; y = ny; z = nz;
  }
  return { lifts, reversals, plungeMm };
}

/*
 * Getting into each ring. Every bite after a ring's first used to lift out of
 * the slot the bite before had just cut - the stock model's rim of uncounted
 * cells read the stock's face there - and ramp back down through it; and every
 * ramp into a ring went out, turned round to the head, and turned round again
 * into the pass. On four stripes that was 47 lifts, 106 dead stops and 1364 mm
 * at the plunge rate; 17, 0 and 290 once later bites ramp on down from where
 * the tool stands and a ramp carries on round the loop. Roughing went from
 * 14.8 to 10.8 minutes.
 */
describe('adaptive roughing entries', () => {
  it('ramps on round each ring, and on down into its next bite', () => {
    const stripes: SceneGraph = {
      nodes: [{
        id: 'b1', name: 'part', type: 'body', pos: [0, 0, 0], joints: [], children: [],
        geoms: [-0.04, -0.015, 0.01, 0.035].map((x, i) => ({
          name: `s${i}`, type: 'box', size: [0.006, 0.05, 0.02], pos: [x, 0, 0],
        })) as never,
      }],
    };
    const res = generateReliefCarveGcode(stripes, {
      ...DEFAULT_RELIEF_OPTIONS, carveDepthMm: 10, stockWidthMm: 120, stockDepthMm: 120,
      roughingStrategy: 'adaptive',
    });
    const e = entries(res.gcode, DEFAULT_RELIEF_OPTIONS.roughingPlungeRate);
    expect(e.lifts).toBeLessThan(25);
    expect(e.reversals).toBeLessThan(10);
    expect(e.plungeMm).toBeLessThan(400);
  });

  // 195 mm at the plunge rate and 116 reversals on the dome; 137 and 36. The
  // reversals left are in the rings themselves, round slivers of the slab.
  it('a dome: shorter ramps, and no turning round in them', () => {
    const res = generateReliefCarveGcode(dome, { ...options, roughingStrategy: 'adaptive' });
    const e = entries(res.gcode, options.roughingPlungeRate);
    expect(e.plungeMm).toBeLessThan(160);
    expect(e.reversals).toBeLessThan(50);
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
    // 0.61 with hybrid the default: its waterline takes the steep flanks
    // roughing left a cell on (see below) down to the surface as well.
    expect(left[Math.floor(left.length * 0.5)]).toBeLessThan(opts.roughingAllowanceMm + 0.25);
    // 0.54 mm at p90 while roughing read a wall as standing on its high
    // sample, which cut past walls sampled across (0.85 mm into a 100 mm
    // cylinder). Held clear of them it is 1.83: up to a cell of the steep
    // flank near the equator left for the ball, 133 minutes against 121.
    // 2.31 once hybrid was the default: the raster had left most of that cell
    // on the flank, and the waterline takes it off.
    expect(left[Math.floor(left.length * 0.9)]).toBeLessThan(opts.roughingAllowanceMm + 2.1);
  });

  it('flies little between cuts', () => {
    const { rapid, cut } = travel(side.slice(0, split));
    expect(rapid / cut).toBeLessThan(0.1);
  });
});

/** Rapids that climb during the finishing pass: one per run the tool lifts out of. */
function finishingLifts(gcode: string): number {
  let z = 0, lifts = 0;
  for (const raw of gcode.slice(gcode.indexOf('OP 2: finishing')).split('\n')) {
    const line = raw.split(';')[0];
    const m = /^G([01])\b.*Z(-?[\d.]+)/.exec(line);
    if (!m) continue;
    const nz = parseFloat(m[2]);
    if (m[1] === '0' && nz > z + 1e-9) lifts++;
    z = nz;
  }
  return lifts;
}

/*
 * The finishing pass had the same fault roughing did. Its runs - raster rows
 * split where they leave the material, waterline levels split where they leave
 * steep ground - were cut in the generator's order, so the tool lifted out of
 * every one and flew across the stock to the next piece of the next row. On a
 * giraffe hide that was 761 runs and more distance in the air than cutting;
 * the run log had the tool at its clearance height in half of all samples.
 *
 * Runs are now cut nearest first, and a run close to the last one is reached
 * by cutting across the surface rather than lifting out. Figures are old/new.
 */
describe('finishing', () => {
  // Was 141 lifts and a 0.097 rapid/cut ratio; 16 and 0.048. 56 once
  // roughing kept clear of the walls it used to cut past: the ring it now
  // leaves round the foot of the dome is more runs, 270 mm more in the air
  // and 21.4 minutes against 21.3.
  it('a dome: lifts out of the cut a handful of times, not once a row', () => {
    const res = generateReliefCarveGcode(dome, options);
    expect(finishingLifts(res.gcode)).toBeLessThan(60);
    const { rapid, cut } = travel(res.gcode.slice(res.gcode.indexOf('OP 2: finishing')));
    expect(rapid / cut).toBeLessThan(0.07);
  });

  // Was 858 lifts, flying 0.47 of what it cut; 377 and 0.030.
  it('stripes: does not fly between the pieces of neighbouring rows', () => {
    const stripes: SceneGraph = {
      nodes: [{
        id: 'b1', name: 'part', type: 'body', pos: [0, 0, 0], joints: [], children: [],
        geoms: [-0.04, -0.015, 0.01, 0.035].map((x, i) => ({
          name: `s${i}`, type: 'box', size: [0.006, 0.05, 0.02], pos: [x, 0, 0],
        })) as never,
      }],
    };
    const res = generateReliefCarveGcode(stripes, {
      ...DEFAULT_RELIEF_OPTIONS, carveDepthMm: 10, stockWidthMm: 120, stockDepthMm: 120,
    });
    expect(finishingLifts(res.gcode)).toBeLessThan(500);
    const { rapid, cut } = travel(res.gcode.slice(res.gcode.indexOf('OP 2: finishing')));
    expect(rapid / cut).toBeLessThan(0.1);
  });

  // Solid machining finishes through the same code. Was 98 lifts a side with
  // its default flat finisher; 5. 23 at most once roughing kept clear of the
  // walls it used to cut past, for the same reason as the dome. 155 with
  // hybrid finishing the default: a waterline's runs end where its level
  // leaves steep ground, and that is 3 m in the air on a 60 mm sphere's side,
  // about a minute and a half of a 49-minute side.
  it('a solid part: the same, on every side', () => {
    const ball: SceneGraph = {
      nodes: [{
        id: 'b1', name: 'part', type: 'body', pos: [0, 0, 0],
        geoms: [{ name: 'g1', type: 'sphere', size: [0.03] } as never],
        joints: [], children: [],
      }],
    };
    const res = generateSolidMachining(ball, deriveSolidOptions(ball, { sides: 2, material: 'softwood' }));
    for (const side of res.sides) expect(finishingLifts(side.gcode ?? '')).toBeLessThan(170);
  });
});
