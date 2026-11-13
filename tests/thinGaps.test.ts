import { describe, it, expect, beforeAll } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../src/utils/sculptCut';
import { treatThinGaps, thinGapWarning } from '../src/utils/thinGaps';
import { printLimits, DEFAULT_PRINTER } from '../src/utils/printLimits';
import { clampPrinter } from '../src/utils/printerSettings';
import { generateMoldMeshes, DEFAULT_MOLD_OPTIONS } from '../src/utils/moldExporter';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await loadManifold();
}, 60_000);

const FDM = printLimits(DEFAULT_PRINTER); // 0.2 mm skin, 0.4 mm wall
const slab = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) =>
  wasm.Manifold.cube([x1 - x0, y1 - y0, z1 - z0]).translate([x0, y0, z0]);

describe('printLimits', () => {
  it('reads one layer and one nozzle line for FDM, two layers and two pixels for resin', () => {
    expect(printLimits({ process: 'fdm', nozzleMm: 0.4, layerMm: 0.2, xyMm: 0.05 })).toEqual({ minSkinMm: 0.2, minWallMm: 0.4, bridgeMm: 5 });
    expect(printLimits({ process: 'resin', nozzleMm: 0.4, layerMm: 0.05, xyMm: 0.035 })).toEqual({ minSkinMm: 0.1, minWallMm: 0.07, bridgeMm: 0 });
  });

  it('repairs a garbage record', () => {
    expect(clampPrinter({ process: 'laser' as never, nozzleMm: '0.6' as never, layerMm: -1 })).toEqual({ process: 'fdm', nozzleMm: 0.6, layerMm: 0.01, xyMm: 0.05 });
  });
});

describe('thin gaps', () => {
  // Two 10 mm plates, the upper 0.1 mm over the lower, joined by a post: the
  // gear sculpture's stacked gears in small.
  const stacked = () => wasm.Manifold.union([slab(0, 0, 0, 10, 10, 2), slab(0, 0, 2.1, 10, 10, 4), slab(-3, -3, 0, -1, -1, 4), slab(-3, 0, 0, 0, 2, 4)]);

  it('finds stacked faces closer than a layer, and leaves them when asked', () => {
    const part = stacked();
    const { part: out, report } = treatThinGaps(wasm, part, FDM, 'leave');
    expect(out).toBe(part);
    expect(report.skin.areaMm2).toBeCloseTo(100, 0);
    expect(report.skin.thinnestMm).toBeCloseTo(0.1, 3);
    expect(thinGapWarning(report, FDM, 'leave')).toMatch(/100 mm² of stacked faces under 0.2 mm apart, down to 0.10 mm.*Close/);
    part.delete();
  });

  it('closes them with casting', () => {
    const part = stacked();
    const { part: out, report } = treatThinGaps(wasm, part, FDM, 'close');
    expect(report.changedMm3).toBeCloseTo(10, 0);
    expect(out.volume() - part.volume()).toBeCloseTo(10, 0);
    // Nothing thin left.
    expect(treatThinGaps(wasm, out, FDM, 'leave').report.skin.areaMm2).toBe(0);
    for (const m of [part, out]) m.delete();
  });

  it('opens them to a layer', () => {
    const part = stacked();
    const { part: out } = treatThinGaps(wasm, part, FDM, 'fix');
    const again = treatThinGaps(wasm, out, FDM, 'leave').report;
    expect(again.skin.areaMm2).toBe(0);
    // Half the 0.1 mm shortfall off each plate.
    expect(part.volume() - out.volume()).toBeCloseTo(10, 0);
    for (const m of [part, out]) m.delete();
  });

  it('finds side-by-side gaps narrower than a nozzle line, not wider ones', () => {
    const narrow = wasm.Manifold.union([slab(0, 0, 0, 5, 10, 3), slab(5.3, 0, 0, 10, 10, 3)]);
    const wide = wasm.Manifold.union([slab(0, 0, 0, 5, 10, 3), slab(5.5, 0, 0, 10, 10, 3)]);
    const n = treatThinGaps(wasm, narrow, FDM, 'leave').report;
    expect(n.wall.areaMm2).toBeGreaterThan(2.5);
    expect(n.wall.thinnestMm).toBeLessThan(0.4);
    expect(treatThinGaps(wasm, wide, FDM, 'leave').report.wall.areaMm2).toBe(0);
    // A 0.2 mm nozzle makes the 0.3 mm gap.
    expect(treatThinGaps(wasm, narrow, { minSkinMm: 0.1, minWallMm: 0.2, bridgeMm: 5 }, 'leave').report.wall.areaMm2).toBe(0);
    for (const m of [narrow, wide]) m.delete();
  });

  it('is named in the mold, and closed when asked', () => {
    const MM = 0.001;
    const box = (name: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): SceneGeom =>
      ({ name, type: 'box', size: [((x1 - x0) / 2) * MM, ((y1 - y0) / 2) * MM, ((z1 - z0) / 2) * MM], pos: [((x0 + x1) / 2) * MM, ((y0 + y1) / 2) * MM, ((z0 + z1) / 2) * MM] }) as SceneGeom;
    const scene = {
      nodes: [{ id: 'g', name: 'gears', type: 'body', pos: [0, 0, 0], geoms: [box('lower', -10, -10, 0, 10, 10, 3), box('upper', -10, -10, 3.1, 10, 10, 6), box('post', -14, -2, 0, -10, 2, 6)], joints: [], children: [] }],
    } as unknown as SceneGraph;
    const opts = { ...DEFAULT_MOLD_OPTIONS, moldType: 'clamshell' as const, pullDirection: '+z' as const, printLimits: FDM };
    const left = generateMoldMeshes(scene, opts, wasm);
    expect(left.success, left.error).toBe(true);
    expect(left.warnings.join(' ')).toMatch(/The casting has 400 mm² of stacked faces/);
    const closed = generateMoldMeshes(scene, { ...opts, thinGaps: 'close' }, wasm);
    expect(closed.success, closed.error).toBe(true);
    expect(closed.warnings.join(' ')).toMatch(/Closed: filled with casting, 40 mm³ added/);
  }, 120_000);
});
