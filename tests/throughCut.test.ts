import { describe, it, expect } from 'vitest';
import { buildHeightmapMesh, DEFAULT_HEIGHTMAP_OPTIONS } from '../src/utils/heightmapMesh';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import { buildPatternPlank, patternById, THROUGH_CUT_OVERCUT_MM } from '../src/utils/surfacePatterns';
import {
  generateReliefCarveGcode,
  countLoosePieces,
  addHoldingTabs,
  DEFAULT_RELIEF_OPTIONS,
  type Heightmap,
  type ReliefCarveOptions,
} from '../src/utils/reliefCarveExporter';
import type { StockSize } from '../src/utils/stockSettings';

/*
 * Through-cuts: patterns whose low parts are no material at all, carved right
 * through the board. Three things have to agree for one to come out right --
 * the mesh has to be a real solid with real holes in it, the plank has to be
 * the full board, and the exporter has to cut those holes past the bottom of
 * the stock without being told to leave its usual millimetre.
 */

/** A square grid, solid everywhere except a rectangle of cells. */
function gridWithHole(n: number, hole: [number, number, number, number]): Float32Array {
  const g = new Float32Array(n * n).fill(1);
  const [r0, r1, c0, c1] = hole;
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) g[r * n + c] = 0;
  return g;
}

const holed = (g: Float32Array, n: number) =>
  buildHeightmapMesh(g, n, n, {
    ...DEFAULT_HEIGHTMAP_OPTIONS,
    widthM: 0.05,
    maxHeightM: 0.01,
    baseThicknessM: 0,
    smoothPasses: 0,
    holeBelow: 0.5,
  });

describe('a heightmap with holes', () => {
  it('is a closed solid, wound outward, with the hole taken out of its volume', () => {
    const n = 21;
    const solid = holed(new Float32Array(n * n).fill(1), n);
    const pierced = holed(gridWithHole(n, [6, 12, 4, 15]), n);
    for (const mesh of [solid, pierced]) {
      const check = analyzeMesh(mesh.renderVertices, mesh.faces)!;
      expect(check.boundaryEdges).toBe(0);
      expect(check.nonManifoldEdges).toBe(0);
      expect(check.consistentlyWound).toBe(true);
      expect(check.closed).toBe(true);
      expect(check.volume).toBeGreaterThan(0);
    }
    const vs = analyzeMesh(solid.renderVertices, solid.faces)!.volume;
    const vp = analyzeMesh(pierced.renderVertices, pierced.faces)!.volume;
    // 0.05 m board in 20 cells: 2.5 mm cells, 10 mm thick. Samples 6..12 by
    // 4..15 are empty, and a cell is a hole when most of its corners are, so
    // the hole is 6 x 11 cells -- the run between the empty samples.
    const cell = 0.05 / 20;
    expect(vs - vp).toBeCloseTo(6 * 11 * cell * cell * 0.01, 9);
  });

  it('stays a proper solid where two solid cells would touch only at a corner', () => {
    // A diagonal slot puts cells corner to corner along its whole length.
    const n = 24;
    const g = new Float32Array(n * n).fill(1);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (Math.abs(r - c) <= 1) g[r * n + c] = 0;
    const mesh = holed(g, n);
    const check = analyzeMesh(mesh.renderVertices, mesh.faces)!;
    expect(check.consistentlyWound).toBe(true);
    expect(check.closed).toBe(true);
    expect(check.nonManifoldEdges).toBe(0);
    expect(check.boundaryEdges).toBe(0);
  });

  it('keeps a flat top flat right up to the edge of the hole', () => {
    const n = 21;
    const mesh = holed(gridWithHole(n, [6, 12, 4, 15]), n);
    const tops = new Set<number>();
    // The top grid comes first, one vertex per sample.
    for (let i = 0; i < n * n; i++) tops.add(Math.round(mesh.renderVertices[i * 3 + 2] * 1e6));
    // Samples inside the hole that no solid cell uses stay low; every other
    // top vertex is at full height. Nothing in between.
    for (const z of tops) expect([0, 10000]).toContain(z);
  });
});

describe('the sliced pattern', () => {
  const spec = patternById('sliced')!;
  const stock: StockSize = { widthMm: 300, depthMm: 120, thicknessMm: 18 };
  const extent = { widthM: 0.3, depthM: 0.12 };

  it('is a through-cut', () => {
    expect(spec.throughCut).toBe(true);
  });

  it('leaves both ends solid across the whole board, and cuts one slot fewer than strips', () => {
    const cols = 301;
    const rows = 121;
    const g = spec.build(cols, rows, extent, { ...spec.defaults, slices: 6, endMarginMm: 30 });
    // Inside the end margin, less the slot's rounded end.
    for (const c of [0, 20, 280, 300]) {
      for (let r = 0; r < rows; r++) expect(g[r * cols + c]).toBe(1);
    }
    // Across the middle of the board: count the slots.
    let slots = 0;
    for (let r = 1; r < rows; r++) if (g[r * cols + 150] === 0 && g[(r - 1) * cols + 150] === 1) slots++;
    expect(slots).toBe(5);
  });

  it('builds a board the full thickness of the stock, holed through', () => {
    const { mesh } = buildPatternPlank(spec, spec.defaults, stock, 0, 300);
    expect(mesh.sizeM[2] * 1000).toBeCloseTo(18, 6);
    const check = analyzeMesh(mesh.renderVertices, mesh.faces)!;
    expect(check.boundaryEdges).toBe(0);
    expect(check.consistentlyWound).toBe(true);
    expect(check.closed).toBe(true);
    expect(check.volume).toBeGreaterThan(0);
    // Less than the whole board: the slots are really gone.
    expect(check.volume).toBeLessThan(0.3 * mesh.sizeM[1] * 0.018 * 0.95);
  });
});

/** The deepest Z the G-code ever moves to. */
function deepestZ(gcode: string): number {
  let min = Infinity;
  for (const m of gcode.matchAll(/Z(-?\d+(?:\.\d+)?)/g)) min = Math.min(min, Number(m[1]));
  return min;
}

describe('through-cut relief export', () => {
  const spec = patternById('sliced')!;
  const stock: StockSize = { widthMm: 120, depthMm: 60, thicknessMm: 6 };
  const opts = { ...spec.defaults, slices: 3, slotMm: 4, amplitudeMm: 4, wavelengthMm: 80, endMarginMm: 20 };
  const carve = (over: Partial<ReliefCarveOptions>) => {
    const { node } = buildPatternPlank(spec, opts, stock, 0, 240);
    return generateReliefCarveGcode({ nodes: [node] }, {
      ...DEFAULT_RELIEF_OPTIONS,
      stockWidthMm: stock.widthMm,
      stockDepthMm: stock.depthMm,
      stockThicknessMm: stock.thicknessMm,
      fitMode: 'manual',
      scalePercent: 100,
      verticalScaleMode: 'proportional',
      verticalExaggeration: 1,
      backgroundMode: 'skip',
      roughingToolDiaMm: 3.175,
      roughingStepdownMm: 2,
      finishingEnabled: false,
      ...over,
    });
  };

  it('cuts the slots through the stock and into the spoilboard', () => {
    const result = carve({ carveDepthMm: 6 + THROUGH_CUT_OVERCUT_MM, cutThroughMm: THROUGH_CUT_OVERCUT_MM });
    expect(result.success).toBe(true);
    expect(deepestZ(result.gcode)).toBeCloseTo(-6 - THROUGH_CUT_OVERCUT_MM, 2);
    expect(result.warnings.join(' ')).toMatch(/into the spoilboard/);
    // The strips are joined at both ends, so nothing comes loose.
    expect(result.warnings.join(' ')).not.toMatch(/cut free/);
  }, 60_000);

  it('holds a piece that crossing slots cut free with tabs, not a warning', () => {
    // Opposite-phase slots on a big swing cross each other. Crossing once only
    // splits the middle strip, still held at the far end; crossing twice
    // encloses a piece between the crossings -- the case a user found in the app.
    const { node } = buildPatternPlank(spec, { ...opts, amplitudeMm: 15, wavelengthMm: 40, phaseDeg: 180 }, stock, 0, 240);
    const base = {
      ...DEFAULT_RELIEF_OPTIONS,
      stockWidthMm: stock.widthMm,
      stockDepthMm: stock.depthMm,
      stockThicknessMm: stock.thicknessMm,
      fitMode: 'manual' as const,
      scalePercent: 100,
      verticalScaleMode: 'proportional' as const,
      verticalExaggeration: 1,
      backgroundMode: 'skip' as const,
      roughingToolDiaMm: 3.175,
      roughingStepdownMm: 2,
      finishingEnabled: false,
      carveDepthMm: 6.3,
      cutThroughMm: 0.3,
    };
    const tabbed = generateReliefCarveGcode({ nodes: [node] }, base).warnings.join(' ');
    expect(tabbed).toMatch(/holding tab/);
    expect(tabbed).not.toMatch(/no holding tabs/);
    const bare = generateReliefCarveGcode({ nodes: [node] }, { ...base, holdingTabs: false }).warnings.join(' ');
    expect(bare).toMatch(/no holding tabs/);
  }, 60_000);

  it('never goes below the stock without being asked to', () => {
    const result = carve({ carveDepthMm: 6 + THROUGH_CUT_OVERCUT_MM, cutThroughMm: 0 });
    expect(deepestZ(result.gcode)).toBeGreaterThanOrEqual(-6);
  }, 60_000);
});

describe('countLoosePieces', () => {
  const map = (rows: string[]): Heightmap => {
    const cols = rows[0].length;
    const z = new Float32Array(cols * rows.length);
    rows.forEach((row, r) => [...row].forEach((ch, c) => { z[r * cols + c] = ch === '#' ? 0 : -10; }));
    return { minX: 0, minY: 0, maxX: cols - 1, maxY: rows.length - 1, cols, rows: rows.length, stepX: 1, stepY: 1, z };
  };

  it('finds nothing loose in a board whose slots stop short of its edges', () => {
    expect(countLoosePieces(map([
      '##########',
      '##.....###',
      '##########',
      '##.....###',
      '##########',
    ]), -10, 1)).toBe(0);
  });

  it('counts each strip a slot cuts free', () => {
    expect(countLoosePieces(map([
      '##########',
      '..........',
      '##########',
      '..........',
      '##########',
    ]), -10, 1)).toBe(2);
  });
});

describe('addHoldingTabs', () => {
  /** '#' is board, '.' is cut through; 1 mm cells, stock bottom at -10. */
  const map = (rows: string[]): Heightmap => {
    const cols = rows[0].length;
    const z = new Float32Array(cols * rows.length);
    rows.forEach((row, r) => [...row].forEach((ch, c) => { z[r * cols + c] = ch === '#' ? 0 : -10; }));
    return { minX: 0, minY: 0, maxX: cols - 1, maxY: rows.length - 1, cols, rows: rows.length, stepX: 1, stepY: 1, z };
  };
  const tab = { heightMm: 2, widthMm: 4, spacingMm: 30 };

  it('ties a piece cut out of the middle of a board back to it, on at least two tabs', () => {
    const lines = Array.from({ length: 30 }, (_, r) =>
      Array.from({ length: 60 }, (_, c) => {
        const ring = (r === 8 || r === 9 || r === 20 || r === 21) && c >= 10 && c <= 49;
        const side = (c === 10 || c === 11 || c === 48 || c === 49) && r >= 8 && r <= 21;
        return ring || side ? '.' : '#';
      }).join(''));
    const surface = map(lines);
    expect(countLoosePieces(surface, -10, 1)).toBe(1);
    const { tabs, loose } = addHoldingTabs(surface, -10, 1, tab);
    expect(loose).toBe(0);
    expect(tabs).toBeGreaterThanOrEqual(2);
    // A tab is a raised floor, not a filled slot: nothing is put back above
    // the tab's own height.
    for (const v of surface.z) expect(v === 0 || v === -10 || v === -8).toBe(true);
  });

  it('leaves a board with nothing loose alone', () => {
    const surface = map(['##########', '##.....###', '##########']);
    const before = Array.from(surface.z);
    expect(addHoldingTabs(surface, -10, 1, tab)).toEqual({ tabs: 0, loose: 0 });
    expect(Array.from(surface.z)).toEqual(before);
  });
});
