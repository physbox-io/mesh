import { describe, it, expect } from 'vitest';
import { generateReliefCarveGcode, DEFAULT_RELIEF_OPTIONS } from '../src/utils/reliefCarveExporter';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

/*
 * Waterline finishing has to work down a wall, never up it.
 *
 * Roughing leaves its allowance standing on every wall from top to bottom. A
 * waterline cut at the foot of a wall before the levels above it buries the
 * finishing cutter's flank in that allowance over the wall's whole height -
 * a full-length side cut with a small ball nose, which is what deflects and
 * snaps it. Top down, each level takes only its own step of it.
 *
 * The levels were handed to the exporter as one set, which it reordered
 * nearest-first in plan alone, so stepping from one wall to the next it
 * picked whichever level happened to be closest - often the deepest.
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

/** A 40 mm square boss standing on an 80 mm square shelf. */
const shelf = body([
  { type: 'box', size: [0.04, 0.04, 0.006], pos: [0, 0, 0.006] } as never,
  { type: 'box', size: [0.02, 0.02, 0.008], pos: [0, 0, 0.02] } as never,
]);
/** A square frame round a central boss. */
const island = body([
  { type: 'box', size: [0.05, 0.006, 0.01], pos: [0, 0.044, 0.01] } as never,
  { type: 'box', size: [0.05, 0.006, 0.01], pos: [0, -0.044, 0.01] } as never,
  { type: 'box', size: [0.006, 0.05, 0.01], pos: [0.044, 0, 0.01] } as never,
  { type: 'box', size: [0.006, 0.05, 0.01], pos: [-0.044, 0, 0.01] } as never,
  { type: 'box', size: [0.012, 0.012, 0.01], pos: [0, 0, 0.01] } as never,
]);
/** A 100 mm dome. */
const dome = body([{ type: 'sphere', size: [0.05] }]);

const RASTER_DEG = 30;

const options = {
  ...DEFAULT_RELIEF_OPTIONS,
  stockWidthMm: 140,
  stockDepthMm: 140,
  stockThicknessMm: 40,
  fitMode: 'manual' as const,
  scalePercent: 100,
  backgroundMode: 'carve' as const,
  carveDepthMm: 20,
  finishingToolType: 'ball' as const,
};

/** Waterline runs cut below a higher, nearby waterline that was still to come. */
function upwardSteps(scene: SceneGraph, strategy: 'contour' | 'hybrid') {
  const res = generateReliefCarveGcode(scene, { ...options, finishingStrategy: strategy, finishingAngleDeg: RASTER_DEG });
  expect(res.success).toBe(true);
  const reach = options.finishingToolDiaMm;

  // A waterline holds one height all the way round; the link into it and the
  // odd point lifted off a wall do not.
  const runs = res.segments
    .filter((s) => s.type === 'finishing')
    .map((s) => {
      const zs = s.points.map((p) => p.z).sort((a, b) => a - b);
      const level = zs[Math.floor(zs.length / 2)];
      const flat = s.points.filter((p) => Math.abs(p.z - level) < 1e-3);
      // Hybrid cuts its raster first by design. The raster runs at 30
      // degrees, which no wall of these parts does, so a run whose longest
      // move is at 30 degrees is raster (the link into it is short).
      let longest = 0, angle = 0;
      for (let k = 1; k < flat.length; k++) {
        const dx = flat[k].x - flat[k - 1].x, dy = flat[k].y - flat[k - 1].y;
        if (Math.hypot(dx, dy) > longest) { longest = Math.hypot(dx, dy); angle = Math.atan2(dy, dx) * 180 / Math.PI; }
      }
      const off = ((angle - RASTER_DEG) % 180 + 180) % 180;
      const straight = longest > 1 && Math.min(off, 180 - off) < 1;
      return { level, pts: flat, waterline: !straight && flat.length >= 0.8 * s.points.length };
    })
    .filter((r) => r.waterline && r.level < -0.05);

  const near = (a: { x: number; y: number }[], b: { x: number; y: number }[]) => {
    const step = Math.max(1, Math.floor(a.length / 200));
    const stepB = Math.max(1, Math.floor(b.length / 200));
    for (let i = 0; i < a.length; i += step) {
      for (let j = 0; j < b.length; j += stepB) {
        if (Math.hypot(a[i].x - b[j].x, a[i].y - b[j].y) < reach) return true;
      }
    }
    return false;
  };

  let bad = 0;
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      if (runs[j].level > runs[i].level + 1e-3 && near(runs[i].pts, runs[j].pts)) { bad++; break; }
    }
  }
  return { bad, runs: runs.length };
}

describe('Waterline finishing order', () => {
  for (const [name, scene] of [['stepped shelf', shelf], ['pocket with an island', island], ['dome', dome]] as const) {
    for (const strategy of ['contour', 'hybrid'] as const) {
      it(`cuts each ${strategy} wall top down on a ${name}`, () => {
        const { bad, runs } = upwardSteps(scene, strategy);
        expect(runs).toBeGreaterThan(5);
        expect(bad).toBe(0);
      });
    }
  }
});
