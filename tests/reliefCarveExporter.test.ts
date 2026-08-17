import { describe, it, expect } from 'vitest';
import {
  generateReliefCarveGcode,
  buildHeightmap,
  dilateForTool,
  sampleHeightmap,
  DEFAULT_RELIEF_OPTIONS,
  recommendReliefTooling,
} from '../src/utils/reliefCarveExporter';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

function bodyWith(geom: Partial<SceneGeom> & { type: SceneGeom['type']; size: number[] }, pos = [0, 0, 0]): SceneGraph {
  return {
    nodes: [{
      id: 'b1',
      name: 'part',
      type: 'body',
      pos,
      geoms: [{ name: 'g1', ...geom } as SceneGeom],
      joints: [],
      children: [],
    }],
  };
}

/** A 100 mm hemisphere-ish dome: a sphere sitting with its centre on z = 0. */
const dome = bodyWith({ type: 'sphere', size: [0.05] }, [0, 0, 0]);
/** A 100 mm cube, base on z = 0. */
const cube = bodyWith({ type: 'box', size: [0.05, 0.05, 0.05] }, [0, 0, 0.05]);

/** Every Z word in a G-code file. */
function zValues(gcode: string): number[] {
  return [...gcode.matchAll(/Z(-?\d+(?:\.\d+)?)/g)].map((m) => parseFloat(m[1]));
}

/** Every cutting (G1) move, as its X/Y/Z words. */
function cutMoves(gcode: string): { x?: number; y?: number; z?: number }[] {
  return gcode
    .split('\n')
    .filter((l) => l.startsWith('G1 '))
    .map((l) => ({
      x: /X(-?[\d.]+)/.exec(l) ? parseFloat(/X(-?[\d.]+)/.exec(l)![1]) : undefined,
      y: /Y(-?[\d.]+)/.exec(l) ? parseFloat(/Y(-?[\d.]+)/.exec(l)![1]) : undefined,
      z: /Z(-?[\d.]+)/.exec(l) ? parseFloat(/Z(-?[\d.]+)/.exec(l)![1]) : undefined,
    }));
}

describe('Relief carve heightmap', () => {
  it('reads the top surface of a triangle, not the bottom', () => {
    // Two stacked horizontal triangles covering the same square.
    const tris = new Float64Array([
      -10, -10, -3, 10, -10, -3, 0, 10, -3,
      -10, -10, -1, 10, -10, -1, 0, 10, -1,
    ]);
    const hm = buildHeightmap(tris, { minX: -10, minY: -10, maxX: 10, maxY: 10 }, 21, 21, -5);
    expect(sampleHeightmap(hm, 0, 0)).toBeCloseTo(-1, 3);
  });

  it('falls back to the floor where nothing is above', () => {
    const tris = new Float64Array([-1, -1, -2, 1, -1, -2, 0, 1, -2]);
    const hm = buildHeightmap(tris, { minX: -10, minY: -10, maxX: 10, maxY: 10 }, 21, 21, -5);
    expect(sampleHeightmap(hm, 9, 9)).toBeCloseTo(-5, 3);
  });

  it('lifts a ball-nose tip clear of a step instead of gouging it', () => {
    // A flat plateau at z = 0 over half the grid, floor at -10 over the other.
    const cols = 41, rows = 3;
    const z = new Float32Array(cols * rows).fill(-10);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) if (c >= 20) z[r * cols + c] = 0;
    }
    const hm = {
      minX: -20, minY: -1, maxX: 20, maxY: 1,
      cols, rows, stepX: 1, stepY: 1, z,
    };

    const raw = sampleHeightmap(hm, -2, 0);
    const ball = sampleHeightmap(dilateForTool(hm, 3, true), -2, 0);
    const flat = sampleHeightmap(dilateForTool(hm, 3, false), -2, 0);

    // 2 mm short of the wall the raw surface is still floor level, which would
    // bury a 3 mm-radius cutter in the plateau.
    expect(raw).toBeCloseTo(-10, 3);
    // The ball rides up the wall: tip = 0 + sqrt(9 - 4) - 3.
    expect(ball).toBeCloseTo(Math.sqrt(5) - 3, 2);
    // A flat mill has to clear the plateau entirely.
    expect(flat).toBeCloseTo(0, 3);
  });
});

describe('Relief carve exporter', () => {
  it('carves into the stock instead of cutting air above it', () => {
    const result = generateReliefCarveGcode(dome, { ...DEFAULT_RELIEF_OPTIONS, carveDepthMm: 8 });

    expect(result.success).toBe(true);
    const zs = zValues(result.gcode);
    // Nothing may be commanded below the relief floor, and the deepest cut has
    // to actually reach it.
    expect(Math.min(...zs)).toBeGreaterThanOrEqual(-8.001);
    expect(Math.min(...zs)).toBeLessThan(-7.5);
    // Gemini's version drove the cutter to the model's own world height, so
    // every cut was tens of mm in the air above the block.
    const cutZs = cutMoves(result.gcode).map((m) => m.z).filter((z): z is number => z !== undefined);
    expect(cutZs.length).toBeGreaterThan(100);
    expect(Math.max(...cutZs)).toBeLessThanOrEqual(0);
  });

  it('scales the model to the stock and centres it', () => {
    const result = generateReliefCarveGcode(cube, {
      ...DEFAULT_RELIEF_OPTIONS,
      stockWidthMm: 200,
      stockDepthMm: 100,
      fitMode: 'fit',
      finishingToolDiaMm: 4,
    });

    expect(result.success).toBe(true);
    // A 100 mm cube in 100 mm of depth, minus the 2 mm tool radius each side.
    expect(result.scaleFactor).toBeCloseTo(0.96, 3);
    // Centred on the stock, but the stock's own origin is its near-left corner,
    // so the model straddles the 50 mm mid-line of a 100 mm depth.
    expect(result.carveBounds.maxY).toBeCloseTo(98, 3);
    expect(result.carveBounds.minY).toBeCloseTo(2, 3);
  });

  it('keeps the whole job in the +X +Y quadrant from the work origin', () => {
    const result = generateReliefCarveGcode(dome, {
      ...DEFAULT_RELIEF_OPTIONS,
      stockWidthMm: 120,
      stockDepthMm: 80,
    });

    expect(result.success).toBe(true);
    expect(result.bounds.minX).toBe(0);
    expect(result.bounds.minY).toBe(0);

    // A job zeroed on the corner of the stock used to run from -W/2, -D/2, i.e.
    // off the block down and to the left of the zero the operator had just set.
    for (const line of result.gcode.split('\n')) {
      const x = line.match(/^G[01] .*?X(-?[\d.]+)/);
      const y = line.match(/^G[01] .*?Y(-?[\d.]+)/);
      if (x) expect(parseFloat(x[1])).toBeGreaterThanOrEqual(0);
      if (y) expect(parseFloat(y[1])).toBeGreaterThanOrEqual(0);
    }
  });

  it('sweeps along the axis it is told to', () => {
    const base = { ...DEFAULT_RELIEF_OPTIONS, stockWidthMm: 60, stockDepthMm: 60 };
    const alongX = generateReliefCarveGcode(dome, { ...base, finishingDirection: 'x' });
    const alongY = generateReliefCarveGcode(dome, { ...base, finishingDirection: 'y' });

    expect(alongX.finishingRasterLines).toBeGreaterThan(10);
    // Gemini's version emitted nothing at all for 'y'.
    expect(alongY.finishingRasterLines).toBeGreaterThan(10);
    expect(alongY.gcode).not.toEqual(alongX.gcode);
  });

  it('roughs only where there is material to take off', () => {
    // Background left alone, so the roughing pass has to stay inside the dome.
    const result = generateReliefCarveGcode(dome, {
      ...DEFAULT_RELIEF_OPTIONS,
      stockWidthMm: 200,
      stockDepthMm: 200,
      fitMode: 'manual',
      scalePercent: 100,
      backgroundMode: 'skip',
      carveDepthMm: 10,
    });

    expect(result.success).toBe(true);
    expect(result.roughingPassCount).toBeGreaterThan(0);

    // The dome is 100 mm across on 200 mm stock. Gemini's version hogged the
    // whole block out to (thickness - 2) mm regardless of the model; roughing
    // must stay inside the dome's own footprint.
    const roughing = result.segments.filter((s) => s.type === 'roughing');
    expect(roughing.length).toBeGreaterThan(0);
    // Measured from the stock's centre, which sits at 100,100 now that the work
    // origin is the block's near-left corner.
    for (const seg of roughing) {
      for (const p of seg.points) {
        expect(Math.hypot(p.x - 100, p.y - 100)).toBeLessThan(
          50 + DEFAULT_RELIEF_OPTIONS.roughingToolDiaMm
        );
      }
    }
  });

  it('stops for a tool change only when the two tools differ', () => {
    const twoTool = generateReliefCarveGcode(dome, DEFAULT_RELIEF_OPTIONS);
    const oneTool = generateReliefCarveGcode(dome, {
      ...DEFAULT_RELIEF_OPTIONS,
      roughingToolDiaMm: DEFAULT_RELIEF_OPTIONS.finishingToolDiaMm,
    });

    expect(twoTool.toolChange).toBe(true);
    expect(twoTool.gcode).toContain('M6');
    expect(oneTool.toolChange).toBe(false);
    expect(oneTool.gcode).not.toContain('M6');
  });

  it('reports a scene it cannot carve rather than emitting an empty job', () => {
    const result = generateReliefCarveGcode({ nodes: [] });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no solid geometry/i);
    expect(result.gcode).toBe('');
  });

  it('warns when the relief is deeper than the stock', () => {
    const result = generateReliefCarveGcode(dome, {
      ...DEFAULT_RELIEF_OPTIONS,
      stockThicknessMm: 12,
      carveDepthMm: 12,
    });
    expect(result.warnings.join(' ')).toMatch(/1 mm/);
  });

  it('warns when the relief is deeper than the finishing bit can reach', () => {
    // The job that broke a real 1.6 mm bit: a 20 mm relief, no roughing, and
    // nothing but a finishing pass to get there.
    const result = generateReliefCarveGcode(dome, {
      ...DEFAULT_RELIEF_OPTIONS,
      stockWidthMm: 50,
      stockDepthMm: 40,
      stockThicknessMm: 40,
      carveDepthMm: 20,
      roughingEnabled: false,
      finishingToolDiaMm: 1.6,
    });

    expect(result.success).toBe(true);
    const warned = result.warnings.join(' ');
    expect(warned).toMatch(/12\.5 diameters of stickout/);
    expect(warned).toMatch(/5\.0 mm or more/);
  });

  it('separates the shank fouling the cut from the bit being whippy', () => {
    const base = {
      ...DEFAULT_RELIEF_OPTIONS,
      stockThicknessMm: 40,
      carveDepthMm: 20,
      finishingToolDiaMm: 1.6,
      toolBodyClearance: false,
    };

    // Stock 1.6 mm bit: 3.175 mm shank, so the shank is in the cut, and nothing
    // is holding the path out of the wall.
    const stock = generateReliefCarveGcode(dome, base).warnings.join(' ');
    expect(stock).toMatch(/shank will be\s+in the cut|shank will be in the cut/);
    expect(stock).toMatch(/diameters of stickout/);

    // A necked long-reach bit — shank no wider than the cutter, 25 mm of it —
    // has no step to foul, so only the stiffness caution is left.
    const necked = generateReliefCarveGcode(dome, {
      ...base,
      finishingShankDiaMm: 1.6,
      finishingFluteLengthMm: 25,
    }).warnings.join(' ');
    expect(necked).not.toMatch(/shank will be/);
    expect(necked).toMatch(/diameters of stickout/);
  });

  it('layers the finishing raster when it has to clear the relief alone', () => {
    const deep = {
      ...DEFAULT_RELIEF_OPTIONS,
      stockThicknessMm: 40,
      carveDepthMm: 20,
      finishingToolDiaMm: 3.175,
    };
    const layered = generateReliefCarveGcode(dome, { ...deep, roughingEnabled: false });
    const roughed = generateReliefCarveGcode(dome, { ...deep, roughingEnabled: true });

    // With roughing off the raster repeats at ~one bit diameter per layer.
    expect(layered.gcode).toMatch(/; layer down to Z/);
    expect(layered.finishingRasterLines).toBeGreaterThan(roughed.finishingRasterLines);
    // Roughing leaves only the allowance, so the finisher stays a single sweep.
    expect(roughed.gcode).not.toMatch(/; layer down to Z/);
  });

  it('still allows a depth-first sweep when it is asked for outright', () => {
    const deep = {
      ...DEFAULT_RELIEF_OPTIONS,
      stockThicknessMm: 40,
      carveDepthMm: 20,
      roughingEnabled: false,
      finishingToolDiaMm: 1.6,
    };
    const single = generateReliefCarveGcode(dome, { ...deep, finishingDepthMode: 'single' as const });
    const auto = generateReliefCarveGcode(dome, { ...deep, finishingDepthMode: 'auto' as const });

    expect(single.gcode).not.toMatch(/; layer down to Z/);
    expect(single.finishingRasterLines).toBeLessThan(auto.finishingRasterLines);
    expect(single.estimatedTimeSeconds).toBeLessThan(auto.estimatedTimeSeconds);
    // Quicker, but it does not get to be quiet about what it is doing.
    expect(single.warnings.join(' ')).toMatch(/first entry/);

    // And 'layered' forces layers even when roughing would have covered it.
    const forced = generateReliefCarveGcode(dome, {
      ...deep,
      roughingEnabled: true,
      finishingDepthMode: 'layered' as const,
      finishingStepdownMm: 3,
    });
    expect(forced.gcode).toMatch(/; layer down to Z/);
  });

  it('never drops more than one finishing stepdown in a single move', () => {
    const result = generateReliefCarveGcode(dome, {
      ...DEFAULT_RELIEF_OPTIONS,
      stockThicknessMm: 40,
      carveDepthMm: 20,
      roughingEnabled: false,
      finishingToolDiaMm: 1.6,
      finishingStepdownMm: 2,
    });

    // Track Z through the whole program and check every downward cutting move.
    // Before layering, the first G1 of the raster dived from the safe height to
    // the floor of the relief — 20 mm straight down on a 1.6 mm bit. The bound
    // is one stepdown plus the 0.5 mm the tool is rapided down to first.
    let z = DEFAULT_RELIEF_OPTIONS.safeZ;
    for (const line of result.gcode.split('\n')) {
      const zw = /Z(-?[\d.]+)/.exec(line);
      if (!zw) continue;
      const next = parseFloat(zw[1]);
      if (line.startsWith('G1 ') && next < z) {
        expect(z - next).toBeLessThanOrEqual(2.5 + 1e-6);
      }
      z = next;
    }
  });

  it('ramps into the cut instead of plunging, unless told not to', () => {
    const opts = {
      ...DEFAULT_RELIEF_OPTIONS,
      stockThicknessMm: 40,
      carveDepthMm: 20,
      roughingEnabled: false,
      finishingToolDiaMm: 1.6,
      finishingStepdownMm: 2,
    };
    const ramped = generateReliefCarveGcode(dome, opts);
    const plunged = generateReliefCarveGcode(dome, { ...opts, leadInAngleDeg: 0 });

    // A ramp is a G1 that moves in X/Y and Z together; a plunge is Z alone.
    // Passes whose head is already all but at depth keep plunging — there is no
    // room to ramp and nothing to gain — so what matters is not that plunges are
    // gone but that no deep one is left.
    const deepestPlunge = (g: string) => {
      let z = DEFAULT_RELIEF_OPTIONS.safeZ;
      let worst = 0;
      for (const line of g.split('\n')) {
        const zw = /Z(-?[\d.]+)/.exec(line);
        if (!zw) continue;
        const next = parseFloat(zw[1]);
        if (/^G1 Z/.test(line) && z - next > worst) worst = z - next;
        z = next;
      }
      return worst;
    };
    expect(deepestPlunge(plunged.gcode)).toBeGreaterThan(2);
    expect(deepestPlunge(ramped.gcode)).toBeLessThan(0.6);

    // Ramping costs travel — it descends along the path and backs up over it.
    expect(ramped.totalCutDistanceMm).toBeGreaterThan(plunged.totalCutDistanceMm);
  });

  it('holds the shank out of a wall the flutes alone would have cleared', () => {
    // A narrow trench: the flutes fit, the shank does not.
    // Towers either side of a 2 mm slot: wider than the 1.6 mm flutes, narrower
    // than the 3.175 mm shank behind them.
    const hm = buildHeightmap(
      new Float64Array([
        -20, -20, 0, -1, -20, 0, -1, 20, 0,
        -20, -20, 0, -1, 20, 0, -20, 20, 0,
        1, -20, 0, 20, -20, 0, 20, 20, 0,
        1, -20, 0, 20, 20, 0, 1, 20, 0,
      ]),
      { minX: -20, minY: -20, maxX: 20, maxY: 20 },
      161, 161, -20
    );

    // Checking the cutting end alone, the slot looks wide open: nothing within
    // 0.8 mm of the centre is above the floor.
    const flutesOnly = sampleHeightmap(dilateForTool(hm, 0.8, false), 0, 0);
    expect(flutesOnly).toBeCloseTo(-20, 1);

    // Add the shank and it is not: the towers are inside its 1.59 mm radius, so
    // the tip is held 4.8 mm below their tops instead of 20 mm below.
    const withShank = sampleHeightmap(
      dilateForTool(hm, 0.8, false, [{ aboveTipMm: 4.8, radiusMm: 3.175 / 2 }]),
      0, 0
    );
    expect(withShank).toBeCloseTo(-4.8, 1);

    // The collet nut sees the towers too, but sits 20 mm up rather than 4.8, so
    // it has slack the shank does not — the strictest section still wins.
    const withHolder = sampleHeightmap(
      dilateForTool(hm, 0.8, false, [
        { aboveTipMm: 4.8, radiusMm: 3.175 / 2 },
        { aboveTipMm: 20, radiusMm: 9.5 },
      ]),
      0, 0
    );
    expect(withHolder).toBeCloseTo(-4.8, 1);

    // Body sections are extra constraints on the same max, so they can only ever
    // hold the tool higher. A path that got deeper by adding one would be a bug.
    const bare = dilateForTool(hm, 0.8, false);
    const guarded = dilateForTool(hm, 0.8, false, [
      { aboveTipMm: 4.8, radiusMm: 3.175 / 2 },
      { aboveTipMm: 20, radiusMm: 9.5 },
    ]);
    let lifted = 0;
    for (let i = 0; i < bare.z.length; i++) {
      expect(guarded.z[i]).toBeGreaterThanOrEqual(bare.z[i] - 1e-4);
      if (guarded.z[i] > bare.z[i] + 0.1) lifted++;
    }
    expect(lifted).toBeGreaterThan(0);
  });

  it('says how much of the relief the tool body puts out of reach', () => {
    const opts = {
      ...DEFAULT_RELIEF_OPTIONS,
      stockWidthMm: 50,
      stockDepthMm: 40,
      stockThicknessMm: 40,
      carveDepthMm: 20,
      roughingEnabled: false,
      finishingToolDiaMm: 1.6,
    };
    const guarded = generateReliefCarveGcode(dome, opts);
    const bare = generateReliefCarveGcode(dome, { ...opts, toolBodyClearance: false });

    expect(guarded.warnings.join(' ')).toMatch(/cannot reach into/);
    expect(bare.warnings.join(' ')).not.toMatch(/cannot reach into/);

    // Both still reach the floor out in the open background — the shank only
    // binds where something tall is standing next to the cut — so the jobs
    // differ without either being uniformly deeper in the G-code.
    expect(guarded.gcode).not.toEqual(bare.gcode);
  });

  it('keeps height on the plan scale when asked to, instead of filling the depth', () => {
    // Same model, same relief depth, two very different stock sizes.
    const base = {
      ...DEFAULT_RELIEF_OPTIONS,
      fitMode: 'fit' as const,
      carveDepthMm: 20,
      stockThicknessMm: 40,
    };
    const big = { ...base, stockWidthMm: 200, stockDepthMm: 200 };
    const small = { ...base, stockWidthMm: 50, stockDepthMm: 40 };

    // Fill mode: the plan shrinks by 4x, the depth does not, so the exaggeration
    // goes up by 4x. This is the trap.
    const fillBig = generateReliefCarveGcode(dome, big);
    const fillSmall = generateReliefCarveGcode(dome, small);
    expect(fillBig.reliefDepthMm).toBeCloseTo(fillSmall.reliefDepthMm, 3);
    expect(fillSmall.verticalExaggeration / fillBig.verticalExaggeration).toBeCloseTo(
      fillBig.scaleFactor / fillSmall.scaleFactor,
      2
    );

    // Proportional mode: the exaggeration is the number asked for on both, and
    // the depth follows the plan instead. The dome is 100 mm tall and fits the
    // big stock at ~2x, so the exaggeration has to be small for neither to run
    // into the 20 mm ceiling and hide the effect.
    const prop = { verticalScaleMode: 'proportional' as const, verticalExaggeration: 0.05 };
    const propBig = generateReliefCarveGcode(dome, { ...big, ...prop });
    const propSmall = generateReliefCarveGcode(dome, { ...small, ...prop });
    expect(propBig.verticalExaggeration).toBeCloseTo(0.05, 3);
    expect(propSmall.verticalExaggeration).toBeCloseTo(0.05, 3);
    expect(propSmall.reliefDepthMm / propBig.reliefDepthMm).toBeCloseTo(
      propSmall.scaleFactor / propBig.scaleFactor,
      2
    );

    // And the exaggeration knob does what it says.
    const doubled = generateReliefCarveGcode(dome, {
      ...small,
      ...prop,
      verticalExaggeration: 0.1,
    });
    expect(doubled.reliefDepthMm).toBeCloseTo(propSmall.reliefDepthMm * 2, 2);
  });

  it('flattens rather than overshooting when proportional height exceeds the depth', () => {
    const result = generateReliefCarveGcode(dome, {
      ...DEFAULT_RELIEF_OPTIONS,
      stockWidthMm: 200,
      stockDepthMm: 200,
      stockThicknessMm: 40,
      carveDepthMm: 5,
      verticalScaleMode: 'proportional',
      verticalExaggeration: 4,
    });

    expect(result.reliefDepthMm).toBeCloseTo(5, 3);
    expect(result.warnings.join(' ')).toMatch(/flattened onto the floor/);
    const zs = [...result.gcode.matchAll(/Z(-?[\d.]+)/g)].map((m) => parseFloat(m[1]));
    expect(Math.min(...zs)).toBeGreaterThanOrEqual(-5 - 1e-6);
  });

  it('recommends a bit that can actually reach the floor of the relief', () => {
    const plan = { planWidthMm: 30, planDepthMm: 35 };

    // Shallow: a small bit's flutes clear the whole depth, so detail wins.
    const shallow = recommendReliefTooling({ ...plan, reliefDepthMm: 2.7 });
    expect(shallow.finishingToolDiaMm).toBeLessThan(3.175);

    // Deep: every bit under 3.175 mm is on a 3.175 mm shank, and past its flutes
    // that shank is in the cut. So the smallest bit that reaches is the one whose
    // shank is its own diameter — however much finer detail would like to be.
    const deep = recommendReliefTooling({ ...plan, reliefDepthMm: 20 });
    expect(deep.finishingToolDiaMm).toBe(3.175);
    expect(deep.finishingShankDiaMm).toBe(3.175);
    // And it has to be a long-reach one, which the recommendation says outright.
    expect(deep.finishingFluteLengthMm).toBeGreaterThanOrEqual(22);

    // Deeper still, and even that will not do.
    const deeper = recommendReliefTooling({ ...plan, reliefDepthMm: 60 });
    expect(deeper.finishingToolDiaMm!).toBeGreaterThan(3.175);
  });

  it('recommends tooling that carves the job without complaint', () => {
    // The end-to-end claim: hand the exporter nothing but the model and the
    // stock, take its own advice, and the only thing left to say about the job
    // is that a 20 mm relief is a lot of stickout.
    const base = {
      ...DEFAULT_RELIEF_OPTIONS,
      stockWidthMm: 50,
      stockDepthMm: 40,
      stockThicknessMm: 40,
      carveDepthMm: 20,
      fitMode: 'fit' as const,
    };
    const first = generateReliefCarveGcode(dome, base);
    expect(first.success).toBe(true);

    const advised = generateReliefCarveGcode(dome, {
      ...base,
      ...recommendReliefTooling({
        reliefDepthMm: first.reliefDepthMm,
        planWidthMm: first.carveBounds.maxX - first.carveBounds.minX,
        planDepthMm: first.carveBounds.maxY - first.carveBounds.minY,
        spindleRpm: base.spindleRpm,
      }),
    });

    expect(advised.success).toBe(true);
    expect(advised.warnings.every((w) => /diameters of stickout/.test(w))).toBe(true);
    // Feeds are derated for how far the bit is hanging out, not left at default.
    expect(advised.finishingRasterLines).toBeGreaterThan(0);
  });

  it('emits a job small enough to stream over serial', () => {
    const result = generateReliefCarveGcode(dome, {
      ...DEFAULT_RELIEF_OPTIONS,
      stockWidthMm: 150,
      stockDepthMm: 150,
    });
    // Unsimplified this raster is ~200k lines, which GRBL cannot be fed fast
    // enough to keep the cut moving.
    expect(result.gcode.split('\n').length).toBeLessThan(60_000);
    expect(result.estimatedTimeSeconds).toBeGreaterThan(60);
  });
});
