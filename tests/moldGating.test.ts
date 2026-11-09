import { describe, it, expect, beforeAll } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { generateMoldMeshes, DEFAULT_MOLD_OPTIONS, type MoldOptions } from '../src/utils/moldExporter';
import { simulateCastFromMoldResult } from '../src/utils/moldCastSimulation';
import { planPeakVents, feedRouteOf, type PourSpans } from '../src/utils/moldGating';
import { loadManifold } from '../src/utils/sculptCut';
import type { Grid } from '../src/utils/moldColumns';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

// A lined gear sculpture's mold was poured from the top, its deep half hanging
// from the lid's layer by posts too narrow for air to get past the resin, and
// vented at two spots. Filled from the bottom, with a vent at every high point,
// the air always goes up ahead of the resin.

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await loadManifold();
});

const grid = (n: number, step: number): Grid => ({ cols: n, rows: n, stepX: step, stepY: step, halfW: ((n - 1) * step) / 2, halfD: ((n - 1) * step) / 2 });

describe('high points', () => {
  it('finds the top of each pocket the rising level would close over', () => {
    // A 20 mm slab 4 mm deep, with two 3 mm-tall towers on its roof: three
    // high points, the two towers and nothing else (the slab's roof is below them).
    const g = grid(21, 1);
    const spans: PourSpans = [];
    for (let r = 0; r < 21; r++) {
      for (let c = 0; c < 21; c++) {
        const x = -10 + c, y = -10 + r;
        const tower = (Math.abs(x + 5) <= 1 && Math.abs(y) <= 1) || (Math.abs(x - 5) <= 1 && Math.abs(y) <= 1);
        spans.push(Float64Array.of(-4, tower ? 3 : 0));
      }
    }
    const peaks = planPeakVents(spans, g);
    expect(peaks).toHaveLength(2);
    // At the middle of each tower's top, not its edge.
    const xs = peaks.map((p) => Math.round(p.x)).sort((a, b) => a - b);
    expect(xs).toEqual([-5, 5]);
    for (const p of peaks) {
      expect(Math.round(p.y)).toBe(0);
      expect(p.z).toBeGreaterThan(2);
    }
  });

  it('leaves a pocket shallower than half a millimetre', () => {
    const g = grid(11, 0.25);
    const spans: PourSpans = [];
    for (let i = 0; i < 121; i++) spans.push(Float64Array.of(-2, i === 60 ? 0.25 : 0));
    // The bump is 0.25 mm: one vent, for the slab's top, none for the bump.
    expect(planPeakVents(spans, g)).toHaveLength(1);
  });

  it('vents a wide shallow pocket, and a flat ceiling once', () => {
    // Two ceilings 0.25 mm proud of the roof between them, 3 x 3 mm: too shallow
    // for the depth test, but several cubic millimetres of air each.
    const g = grid(21, 0.25);
    const spans: PourSpans = [];
    for (let r = 0; r < 21; r++) {
      for (let c = 0; c < 21; c++) {
        const proud = r >= 4 && r <= 16 && (c <= 7 || c >= 13);
        spans.push(Float64Array.of(-2, proud ? 0.25 : 0));
      }
    }
    const xs = planPeakVents(spans, g).map((p) => Math.sign(p.x)).sort();
    expect(xs).toEqual([-1, 1]);
  });
});

/** A thin plate with a post 2.4 mm across hanging from it to a bulb: the gear sculpture's trouble in small. */
const plateAndBulb: SceneGraph = {
  nodes: [{
    id: 'b1', name: 'plate and bulb', type: 'body', pos: [0, 0, 0],
    geoms: [
      { name: 'plate', type: 'box', size: [0.015, 0.015, 0.001], pos: [0, 0, 0.001] } as SceneGeom,
      { name: 'post', type: 'cylinder', size: [0.0012, 0.006], pos: [0.006, 0.006, 0.008] } as SceneGeom,
      { name: 'bulb', type: 'box', size: [0.004, 0.004, 0.003], pos: [0.006, 0.006, 0.017] } as SceneGeom,
    ],
    joints: [], children: [],
  }],
};

const OPTS: MoldOptions = { ...DEFAULT_MOLD_OPTIONS, moldType: 'clamshell', pullDirection: '+z', dissolvableLiner: true, linerPair: 'abs_hips', castMaterial: 'epoxy' };

describe('bottom fill', () => {
  it('fills a bulb hanging from a plate by a narrow post', async () => {
    const r = generateMoldMeshes(plateAndBulb, OPTS, wasm);
    expect(r.success, r.error).toBe(true);
    expect(r.features!.feed).toBe('bottom');
    expect(r.features!.vents.length).toBeGreaterThan(0);
    const cast = await simulateCastFromMoldResult(r, { castMaterial: 'epoxy' });
    expect(cast.success, cast.error).toBe(true);
    expect(cast.fill!.filledShare, JSON.stringify({ fill: cast.fill, vol: cast.castVolumeMm3, comps: cast.cavityComponents, size: cast.sizeMm, warn: cast.warnings })).toBeGreaterThan(0.97);
    // Poured from the top it fills no better.
    const top = await simulateCastFromMoldResult(generateMoldMeshes(plateAndBulb, { ...OPTS, sprueFeed: 'top' }, wasm), { castMaterial: 'epoxy' });
    expect(top.fill!.filledShare).toBeLessThanOrEqual(cast.fill!.filledShare + 1e-3);
  });

  it('keeps the funnel over the down-sprue inside the block', () => {
    const r = generateMoldMeshes(plateAndBulb, OPTS, wasm);
    const s = r.features!.sprue!;
    const half = r.moldWidthMm / 2;
    expect(Math.abs(s.atMm[0]) + s.diaMm / 2).toBeLessThanOrEqual(half - 1.4);
    expect(Math.abs(s.atMm[1]) + s.diaMm / 2).toBeLessThanOrEqual(r.moldDepthMm / 2 - 1.4);
  });

  it('refuses a wall too thin for its down-sprue, in one sentence', () => {
    const r = generateMoldMeshes(plateAndBulb, { ...OPTS, wallMarginMm: 4 }, wasm);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/needs 9.7 mm of wall/);
    expect(r.error).toMatch(/fill from the top/);
  });

  it('refuses to fill from the bottom with no vents', () => {
    const r = generateMoldMeshes(plateAndBulb, { ...OPTS, includeVents: false }, wasm);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/needs its vents/);
  });

  it('places the bottom-fill horizontal runner below the soluble liner skin', () => {
    const skinMm = 2.4;
    // A thicker skin sleeves the down-sprue thicker too, so it wants a wider wall.
    const r = generateMoldMeshes(plateAndBulb, { ...OPTS, dissolvableLiner: true, linerSkinMm: skinMm, wallMarginMm: 12 }, wasm);
    expect(r.success, r.error).toBe(true);
    const route = feedRouteOf(r.features)!;
    // Top of the horizontal runner (`runnerZ + r`) must sit at least 1 mm below the liner floor (`gate[2] - skinMm`).
    expect(route.runnerZ + route.r).toBeLessThanOrEqual(route.gate[2] - skinMm - 1 + 1e-6);
  });

  it('keeps the down-sprue clear of the widened cavity when draft is added to an exact/lined mold', () => {
    const deepBlock: SceneGraph = {
      nodes: [{
        id: 'b1', name: 'deep', type: 'body', pos: [0, 0, 0],
        geoms: [{ name: 'b', type: 'box', size: [0.01, 0.01, 0.01], pos: [0, 0, 0.01] } as SceneGeom],
        joints: [], children: [],
      }],
    };
    const undrafted = generateMoldMeshes(deepBlock, { ...OPTS, draftAngleDeg: 0, wallMarginMm: 15 }, wasm);
    const drafted = generateMoldMeshes(deepBlock, { ...OPTS, draftAngleDeg: 8, draftMode: 'add', wallMarginMm: 15 }, wasm);
    expect(undrafted.success, undrafted.error).toBe(true);
    expect(drafted.success, drafted.error).toBe(true);
    const d0 = Math.hypot(...feedRouteOf(undrafted.features)!.down);
    const d8 = Math.hypot(...feedRouteOf(drafted.features)!.down);
    expect(d8).toBeGreaterThan(d0 + 0.5);
  });
});
