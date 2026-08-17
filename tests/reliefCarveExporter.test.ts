import { describe, it, expect } from 'vitest';
import {
  generateReliefCarveGcode,
  buildHeightmap,
  dilateForTool,
  sampleHeightmap,
  DEFAULT_RELIEF_OPTIONS,
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
