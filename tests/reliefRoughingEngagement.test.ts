import { describe, it, expect } from 'vitest';
import { generateReliefCarveGcode, DEFAULT_RELIEF_OPTIONS } from '../src/utils/reliefCarveExporter';
import { StockModel } from '../src/utils/stockModel';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

/*
 * What the adaptive roughing cutter is really buried in, move by move.
 *
 * Adaptive clearing earns its deep stepdown and its boosted feed from one
 * promise: every ring after the first has open air on its outer side, so the
 * cutter only ever takes the stepover. On a flat-bottomed pocket that holds.
 * On a relief it did not. Each ring follows the surface down to the slab's
 * floor, so on a slope the ring inside sits lower than the ring outside it -
 * and the material between the two heights is solid on both sides of the
 * cutter. That is a full-width slot, and it was being cut at the boosted
 * depth in one bite at up to 160% of the roughing feed.
 *
 * This replays the roughing program against a stock model and measures, for
 * every feed move, how deep the material stands on *both* flanks of the
 * cutter: the depth of slot it is cutting. That must never exceed the
 * stepdown set for a full-width cut, and wherever there is any real slot the
 * feed must not be boosted past the roughing feed.
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

/** A 100 mm dome: sloped everywhere. */
const dome = body([{ type: 'sphere', size: [0.05] }]);
/** A 40 mm square boss standing on an 80 mm square shelf. */
const shelf = body([
  { type: 'box', size: [0.04, 0.04, 0.006], pos: [0, 0, 0.006] } as never,
  { type: 'box', size: [0.02, 0.02, 0.008], pos: [0, 0, 0.02] } as never,
]);
/** A square frame round a central boss: a pocket with an island in it. */
const island = body([
  { type: 'box', size: [0.05, 0.006, 0.01], pos: [0, 0.044, 0.01] } as never,
  { type: 'box', size: [0.05, 0.006, 0.01], pos: [0, -0.044, 0.01] } as never,
  { type: 'box', size: [0.006, 0.05, 0.01], pos: [0.044, 0, 0.01] } as never,
  { type: 'box', size: [0.006, 0.05, 0.01], pos: [-0.044, 0, 0.01] } as never,
  { type: 'box', size: [0.012, 0.012, 0.01], pos: [0, 0, 0.01] } as never,
]);

const deep = {
  ...DEFAULT_RELIEF_OPTIONS,
  stockWidthMm: 140,
  stockDepthMm: 140,
  stockThicknessMm: 40,
  fitMode: 'manual' as const,
  scalePercent: 100,
  backgroundMode: 'carve' as const,
  carveDepthMm: 24,
  roughingStrategy: 'adaptive' as const,
  finishingEnabled: false,
};

interface Worst { slot: number; slotAtBoostedFeed: number; line: string }

/** Replays the roughing moves and reports the deepest slot cut. */
function measure(scene: SceneGraph, opts = deep): Worst {
  const res = generateReliefCarveGcode(scene, opts);
  expect(res.success).toBe(true);
  const start = res.gcode.indexOf('OP 1: roughing');
  expect(start).toBeGreaterThan(0);
  const end = res.gcode.indexOf('OP 2');
  const rough = res.gcode.slice(start, end > start ? end : undefined);

  const r = opts.roughingToolDiaMm / 2;
  const stock = new StockModel(
    { minX: 0, minY: 0, maxX: opts.stockWidthMm, maxY: opts.stockDepthMm },
    0.2
  );
  // Where each flank is read: most of the way out to the cutter's rim, so a
  // ring one stepover in has certainly been over it.
  const flank = r * 0.8;
  const worst: Worst = { slot: 0, slotAtBoostedFeed: 0, line: '' };
  let x = 0, y = 0, z = opts.safeZ, feed = 0;

  for (const raw of rough.split('\n')) {
    const line = raw.split(';')[0].trim();
    const g = /^G([01])\b/.exec(line);
    if (!g) continue;
    const nx = parseFloat(/X(-?[\d.]+)/.exec(line)?.[1] ?? `${x}`);
    const ny = parseFloat(/Y(-?[\d.]+)/.exec(line)?.[1] ?? `${y}`);
    const nz = parseFloat(/Z(-?[\d.]+)/.exec(line)?.[1] ?? `${z}`);
    const f = /F([\d.]+)/.exec(line);
    if (f) feed = parseFloat(f[1]);

    const len = Math.hypot(nx - x, ny - y);
    if (g[1] === '1' && len > 1e-6) {
      const ux = (nx - x) / len, uy = (ny - y) / len;
      const steps = Math.max(1, Math.ceil(len / 0.5));
      let slot = 0;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const px = x + (nx - x) * t, py = y + (ny - y) * t, pz = z + (nz - z) * t;
        const left = stock.highestUnder(px - uy * flank, py + ux * flank, 0);
        const right = stock.highestUnder(px + uy * flank, py - ux * flank, 0);
        slot = Math.max(slot, Math.min(left, right) - pz);
      }
      if (slot > worst.slot) { worst.slot = slot; worst.line = line; }
      if (slot > 0.5 && feed > opts.roughingFeedrate + 1) {
        worst.slotAtBoostedFeed = Math.max(worst.slotAtBoostedFeed, slot);
      }
    }
    if (g[1] === '1') {
      // The model lowers each piece of a move only to that piece's higher
      // end, so a steep move is fed to it in short steps of height, or it
      // remembers a staircase of material the cutter really took.
      const pieces = Math.max(1, Math.ceil(Math.abs(nz - z) / 0.05));
      for (let s = 0; s < pieces; s++) {
        const a = s / pieces, b = (s + 1) / pieces;
        stock.cut(
          x + (nx - x) * a, y + (ny - y) * a, z + (nz - z) * a,
          x + (nx - x) * b, y + (ny - y) * b, z + (nz - z) * b, r
        );
      }
    }
    x = nx; y = ny; z = nz;
  }
  return worst;
}

describe('Adaptive roughing engagement', () => {
  // A cell of the stock model either side of the flank sample, and the
  // rounding of the program's coordinates.
  const SLACK = 0.3;

  for (const [name, scene] of [['dome', dome], ['stepped shelf', shelf], ['pocket with an island', island]] as const) {
    it(`never slots deeper than a full-width stepdown on a ${name}`, () => {
      const w = measure(scene);
      expect(w.slot, w.line).toBeLessThanOrEqual(deep.roughingStepdownMm + SLACK);
    });

    it(`never feeds a slot faster than the roughing feed on a ${name}`, () => {
      const w = measure(scene);
      expect(w.slotAtBoostedFeed, w.line).toBe(0);
    });
  }

  it('clears round an island from the island outward', () => {
    // Each ring round the boss needs the ring between it and the boss cut
    // first, or it is a slot. They used to be hung under the pocket's outer
    // rings, which they do not lie inside, so the ring hugging the boss came
    // last, after everything it was meant to open the way for.
    const res = generateReliefCarveGcode(island, deep);
    expect(res.success).toBe(true);
    const c = deep.stockWidthMm / 2;
    let prev: { d: number; z: number } | null = null;
    let seen = 0;
    for (const seg of res.segments.filter((s) => s.type === 'roughing')) {
      const pts = seg.points;
      const cheb = pts.map((p) => Math.max(Math.abs(p.x - c), Math.abs(p.y - c)));
      // Round the 24 mm boss, inside the frame's 76 mm opening.
      if (Math.max(...cheb) > 24) continue;
      if (!(pts.some((p) => p.x < c) && pts.some((p) => p.x > c))) continue;
      const d = cheb.reduce((a, b) => a + b, 0) / cheb.length;
      const z = Math.min(...pts.map((p) => p.z));
      // Only a new, deeper layer starts again from the boss.
      if (prev && d < prev.d - 0.5) expect(z, `ring at ${d.toFixed(2)} after ${prev.d.toFixed(2)}`).toBeLessThan(prev.z - 1e-3);
      prev = { d, z };
      seen++;
    }
    expect(seen).toBeGreaterThan(3);
  });
});
