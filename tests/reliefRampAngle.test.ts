import { describe, it, expect } from 'vitest';
import { generateReliefCarveGcode, DEFAULT_RELIEF_OPTIONS } from '../src/utils/reliefCarveExporter';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

/*
 * A ramp into a run descends no steeper than the lead-in angle.
 *
 * The ramp was fitted into half the run whatever that did to its angle, so on
 * a short run it was a plunge with a sideways lean: 16.5 mm down over 3 mm of
 * travel, about 80 degrees, with the finishing bit and no roughing ahead of
 * it. Where the run is too short for the angle, the ramp now goes back and
 * forth along it.
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

/** Square bosses of several heights, close together. */
const steps = body([
  { type: 'box', size: [0.05, 0.05, 0.002], pos: [0, 0, 0.002] } as never,
  { type: 'box', size: [0.01, 0.01, 0.006], pos: [-0.02, -0.02, 0.006] } as never,
  { type: 'box', size: [0.008, 0.012, 0.004], pos: [0.02, -0.02, 0.004] } as never,
  { type: 'box', size: [0.012, 0.008, 0.008], pos: [-0.02, 0.02, 0.008] } as never,
  { type: 'box', size: [0.01, 0.01, 0.005], pos: [0.02, 0.02, 0.005] } as never,
]);
const dome = body([{ type: 'sphere', size: [0.05] }]);

const options = {
  ...DEFAULT_RELIEF_OPTIONS,
  stockWidthMm: 120,
  stockDepthMm: 120,
  stockThicknessMm: 30,
  fitMode: 'manual' as const,
  scalePercent: 100,
  backgroundMode: 'carve' as const,
  carveDepthMm: 16,
  finishingToolType: 'flat' as const,
  finishingToolDiaMm: 3.175,
};

/** The steepest descending move at a plunge rate that also travels, as a slope. */
function steepestRamp(gcode: string, plungeRates: number[]): { slope: number; line: string } {
  let x = NaN, y = NaN, z = NaN, feed = 0;
  // A ramp starts half a millimetre over the material, at the height the
  // rapid approach stopped at; that half millimetre is air.
  let approached = false;
  let worst = { slope: 0, line: '' };
  for (const raw of gcode.split('\n')) {
    const line = raw.split(';')[0].trim();
    const g = /^G([01])\b/.exec(line);
    if (!g) continue;
    const nx = parseFloat(/X(-?[\d.]+)/.exec(line)?.[1] ?? `${x}`);
    const ny = parseFloat(/Y(-?[\d.]+)/.exec(line)?.[1] ?? `${y}`);
    const nz = parseFloat(/Z(-?[\d.]+)/.exec(line)?.[1] ?? `${z}`);
    const fw = /F([\d.]+)/.exec(line);
    if (fw) feed = parseFloat(fw[1]);
    const run = Math.hypot(nx - x, ny - y);
    // Ramps are fed at the plunge rate; so are the straight drops at the foot
    // of a wall, which do not travel.
    const from = approached ? z - 0.5 : z;
    // (Or the traverse flew at that height, and there was no descent to make.)
    approached = g[1] === '0';
    if (g[1] === '1' && plungeRates.includes(feed) && run > 0.05 && nz < from - 1e-6) {
      const slope = (from - nz) / run;
      if (slope > worst.slope) worst = { slope, line };
    }
    x = nx; y = ny; z = nz;
  }
  return worst;
}

describe('Lead-in ramps', () => {
  const tan = Math.tan((options.leadInAngleDeg * Math.PI) / 180);
  for (const [name, scene] of [['steps', steps], ['dome', dome]] as const) {
    for (const roughingEnabled of [true, false]) {
      it(`never enter steeper than the lead-in angle (${name}, roughing ${roughingEnabled ? 'on' : 'off'})`, () => {
        const res = generateReliefCarveGcode(scene, { ...options, roughingEnabled });
        expect(res.success).toBe(true);
        const worst = steepestRamp(res.gcode, [res.gcode.includes('OP 1') ? options.roughingPlungeRate : -1, options.finishingPlungeRate]);
        // Coordinates are written to a micron, so a short leg's slope reads a
        // little off.
        expect(worst.slope, worst.line).toBeLessThanOrEqual(tan * 1.05 + 1e-3);
      });
    }
  }
});
