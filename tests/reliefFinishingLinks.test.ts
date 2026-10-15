import { describe, it, expect } from 'vitest';
import { generateReliefCarveGcode, DEFAULT_RELIEF_OPTIONS } from '../src/utils/reliefCarveExporter';
import { WALL_SLOPE } from '../src/utils/finishingPaths';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

/*
 * The moves that link one finishing run to the next.
 *
 * Instead of lifting between two runs a few millimetres apart, the cutter
 * rides the finished surface across. The runs themselves are squared up at
 * every wall - across at the top, then straight down - because a straight
 * line between a sample on top of a step and one at its foot cuts through
 * the step's edge. The links were not, and a link across a step drove
 * diagonally through it.
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

describe('Finishing links', () => {
  for (const finishingStrategy of ['raster', 'hybrid', 'crosshatch'] as const) {
    for (const roughingEnabled of [true, false]) {
      it(`never cut a wall on the slant (${finishingStrategy}, roughing ${roughingEnabled ? 'on' : 'off'})`, () => {
        const res = generateReliefCarveGcode(steps, { ...options, finishingStrategy, roughingEnabled });
        expect(res.success).toBe(true);
        const fin = res.gcode.slice(res.gcode.indexOf('OP 2: finishing'));
        let x = NaN, y = NaN, z = NaN, feed = 0;
        let worst = 0, at = '';
        for (const raw of fin.split('\n')) {
          const line = raw.split(';')[0].trim();
          const g = /^G([01])\b/.exec(line);
          if (!g) continue;
          const nx = parseFloat(/X(-?[\d.]+)/.exec(line)?.[1] ?? `${x}`);
          const ny = parseFloat(/Y(-?[\d.]+)/.exec(line)?.[1] ?? `${y}`);
          const nz = parseFloat(/Z(-?[\d.]+)/.exec(line)?.[1] ?? `${z}`);
          const fw = /F([\d.]+)/.exec(line);
          if (fw) feed = parseFloat(fw[1]);
          const run = Math.hypot(nx - x, ny - y);
          // Ramps into a run descend on a slant on purpose, at the plunge
          // rate; only moves at the cutting feed are judged.
          if (g[1] === '1' && feed === options.finishingFeedrate && run > 0.05 && Math.abs(nz - z) > run * WALL_SLOPE * 1.05) {
            const steep = Math.abs(nz - z) - run * WALL_SLOPE;
            if (steep > worst) { worst = steep; at = line; }
          }
          x = nx; y = ny; z = nz;
        }
        expect(worst, at).toBeLessThan(0.01);
      });
    }
  }
});
