import { describe, it, expect } from 'vitest';
import {
  dilateForTool,
  sampleHeightmap,
  describeCutter,
  chiploadMm,
  vBitConeHeight,
  generateReliefCarveGcode,
  DEFAULT_RELIEF_OPTIONS,
  measureDetailMm,
  recommendReliefTooling,
  type Heightmap,
} from '../src/utils/reliefCarveExporter';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

/**
 * A flat surface at Z=0 with one narrow slot cut down to `depth` at x=0.
 *
 * The slot is the whole point: it is narrower than any of the cutters below, so
 * how far into it each one reaches is a direct statement of the shape of its
 * tip, and nothing else.
 */
function slottedSurface(halfWidthMm: number, depth: number): Heightmap {
  const cols = 201;
  const rows = 3;
  const stepX = 0.1;
  const z = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = -10 + c * stepX;
      z[r * cols + c] = Math.abs(x) <= halfWidthMm ? -depth : 0;
    }
  }
  return { minX: -10, maxX: 10, minY: -1, maxY: 1, cols, rows, stepX, stepY: 1, z };
}

describe('dilating a surface by the cutter that has to follow it', () => {
  const hm = slottedSurface(0.25, 5);

  it('a flat mill cannot enter a slot narrower than itself at all', () => {
    // Its whole flat bottom has to clear the highest point under it, and that
    // is the land either side of the slot.
    expect(sampleHeightmap(dilateForTool(hm, 1.5, { shape: 'flat' }), 0, 0)).toBeCloseTo(0, 3);
  });

  it('a ball nose gets down by its radius at most', () => {
    // The deepest a 3 mm ball can put its tip in a slot it cannot enter is one
    // radius, when the two shoulders touch its equator.
    const z = sampleHeightmap(dilateForTool(hm, 1.5, { shape: 'ball_nose' }), 0, 0);
    expect(z).toBeLessThan(0);
    expect(z).toBeGreaterThanOrEqual(-1.5);
  });

  it('a V-bit reaches deeper into the same slot than a ball of the same diameter', () => {
    const ball = sampleHeightmap(dilateForTool(hm, 1.5, { shape: 'ball_nose' }), 0, 0);
    const vee = sampleHeightmap(
      dilateForTool(hm, 1.5, { shape: 'v_bit', vBitAngleDeg: 60 }),
      0, 0
    );
    // This is the reason lettering is cut with a V-bit: the cone is narrower
    // than the ball everywhere below the shoulder, so it drops further in.
    expect(vee).toBeLessThan(ball);
  });

  it('a narrower V-bit reaches deeper still', () => {
    const wide = sampleHeightmap(dilateForTool(hm, 1.5, { shape: 'v_bit', vBitAngleDeg: 90 }), 0, 0);
    const narrow = sampleHeightmap(dilateForTool(hm, 1.5, { shape: 'v_bit', vBitAngleDeg: 30 }), 0, 0);
    expect(narrow).toBeLessThan(wide);
  });

  it('a V-bit on an open flat surface still sits on the surface', () => {
    const flat: Heightmap = {
      minX: 0, maxX: 10, minY: 0, maxY: 10, cols: 11, rows: 11, stepX: 1, stepY: 1,
      z: new Float32Array(121).fill(-2),
    };
    const out = dilateForTool(flat, 1.5, { shape: 'v_bit', vBitAngleDeg: 60 });
    // Nothing stands proud, so the tip goes exactly to the surface — a dilation
    // that lifted here would leave the whole floor uncut.
    expect(sampleHeightmap(out, 5, 5)).toBeCloseTo(-2, 6);
  });

  it('still takes the old ball/flat boolean', () => {
    expect(sampleHeightmap(dilateForTool(hm, 1.5, true), 0, 0)).toBeCloseTo(
      sampleHeightmap(dilateForTool(hm, 1.5, { shape: 'ball_nose' }), 0, 0),
      6
    );
    expect(sampleHeightmap(dilateForTool(hm, 1.5, false), 0, 0)).toBeCloseTo(
      sampleHeightmap(dilateForTool(hm, 1.5, { shape: 'flat' }), 0, 0),
      6
    );
  });
});

describe('V-bit geometry', () => {
  it('reaches full diameter at the height the cone is tall', () => {
    // A 6 mm 90 deg bit is a right-angle cone: half-angle 45 deg, so it widens
    // one for one and reaches 6 mm across 3 mm up.
    expect(vBitConeHeight(6, 90)).toBeCloseTo(3, 6);
    // 60 deg is steeper, so the same diameter is further up.
    expect(vBitConeHeight(6, 60)).toBeGreaterThan(vBitConeHeight(6, 90));
  });
});

describe('naming a cutter for the person holding the box of bits', () => {
  it('says shape, angle, flutes and helix', () => {
    expect(describeCutter(6, 'v_bit', 2, 'downcut', 60)).toBe('6 mm 60° V-bit, 2-flute downcut');
    expect(describeCutter(3.175, 'ball_nose', 2, 'upcut')).toBe(
      '3.175 mm ball-nose end mill, 2-flute upcut'
    );
    expect(describeCutter(6.35, 'flat', 1, 'straight')).toBe(
      '6.35 mm flat end mill, 1-flute straight-flute'
    );
  });
});

describe('chipload', () => {
  it('halves when the flute count doubles at the same feed', () => {
    expect(chiploadMm(1200, 12000, 2)).toBeCloseTo(0.05, 6);
    expect(chiploadMm(1200, 12000, 4)).toBeCloseTo(0.025, 6);
  });
});

/** A 100 mm dome — a surface with real relief in it, not a flat plate. */
const scene: SceneGraph = {
  nodes: [{
    id: 'b1',
    name: 'part',
    type: 'body',
    pos: [0, 0, 0],
    geoms: [{ name: 'g1', type: 'sphere', size: [0.05] } as SceneGeom],
    joints: [],
    children: [],
  }],
};

describe('what the exported program says about its tooling', () => {
  it('names both tools in the header, and calls the roughing bit a flat end mill', () => {
    const result = generateReliefCarveGcode(scene, {
      ...DEFAULT_RELIEF_OPTIONS,
      roughingEnabled: true,
      roughingToolDiaMm: 6.35,
      roughingFlutes: 2,
      roughingGeometry: 'upcut',
      finishingToolType: 'ball_nose',
      finishingToolDiaMm: 3.175,
      finishingFlutes: 2,
      finishingGeometry: 'upcut',
    });
    expect(result.success).toBe(true);
    expect(result.gcode).toContain('T1 rough    : 6.35 mm flat end mill, 2-flute upcut');
    expect(result.gcode).toContain('T2 finish   : 3.175 mm ball-nose end mill, 2-flute upcut');
    // And the operator's prompt at the change names the bit rather than a number.
    expect(result.gcode).toMatch(/T2 M6 ; fit the 3\.175 mm ball-nose end mill, 2-flute upcut/);
  });

  it('names a V-bit by its angle wherever it is mentioned', () => {
    const result = generateReliefCarveGcode(scene, {
      ...DEFAULT_RELIEF_OPTIONS,
      finishingToolType: 'v_bit',
      finishingVBitAngleDeg: 60,
      finishingToolDiaMm: 6,
    });
    expect(result.success).toBe(true);
    expect(result.gcode).toContain('60° V-bit');
  });

  it('warns when the feed makes no chip for the flutes it was told about', () => {
    const result = generateReliefCarveGcode(scene, {
      ...DEFAULT_RELIEF_OPTIONS,
      roughingEnabled: false,
      // 60 mm/min on four flutes at 12,000 RPM is a thousandth of a millimetre
      // a tooth: the edge rubs and burns rather than cutting.
      finishingFeedrate: 60,
      finishingFlutes: 4,
    });
    expect(result.warnings.join(' ')).toMatch(/chip per tooth/i);
  });

  it('warns that a downcut bit packs its chips into a deep relief', () => {
    const result = generateReliefCarveGcode(scene, {
      ...DEFAULT_RELIEF_OPTIONS,
      carveDepthMm: 15,
      stockThicknessMm: 25,
      finishingToolDiaMm: 3.175,
      finishingGeometry: 'downcut',
    });
    expect(result.warnings.join(' ')).toMatch(/downcut/i);
  });

  it('estimates a job at more than its cut length over its feedrate', () => {
    const result = generateReliefCarveGcode(scene, DEFAULT_RELIEF_OPTIONS);
    expect(result.success).toBe(true);
    const naive = (result.totalCutDistanceMm / DEFAULT_RELIEF_OPTIONS.finishingFeedrate) * 60;
    expect(result.estimatedTimeSeconds).toBeGreaterThan(naive);
  });
});

describe('measuring the narrowest valley the finishing bit has to enter', () => {
  /**
   * A flat board with two straight slots to full depth: a narrow one the full
   * height of the board and a wide one over `wideFraction` of it.
   */
  function twoSlots(narrowMm: number, wideMm: number, depth: number, wideFraction = 1): Heightmap {
    const step = 0.2;
    const cols = 301;
    const rows = 101;
    const z = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * step;
        const inNarrow = Math.abs(x - 15) <= narrowMm / 2;
        const inWide = Math.abs(x - 45) <= wideMm / 2 && r < rows * wideFraction;
        z[r * cols + c] = inNarrow || inWide ? -depth : 0;
      }
    }
    return { minX: 0, maxX: 60, minY: 0, maxY: 20, cols, rows, stepX: step, stepY: step, z };
  }

  it('reads the valley that carries most of the area', () => {
    // A short wide slot beside a long narrow one: the narrow one is the relief.
    const narrow = measureDetailMm(twoSlots(3, 8, 5, 0.2), 5)!;
    expect(narrow).toBeGreaterThan(2.4);
    expect(narrow).toBeLessThan(3.6);
    // The same slots the full height: now the wide one is most of the valley,
    // and the narrow one is a line the bit is not sized to.
    const wide = measureDetailMm(twoSlots(3, 8, 5), 5)!;
    expect(wide).toBeGreaterThan(7);
    expect(wide).toBeLessThan(8.5);
  });

  it('measures against the lowest point, not a nominal depth the relief never reaches', () => {
    // A generated panel says it is 7 mm deep and cuts 5: the slot is still 3 mm wide.
    const detail = measureDetailMm(twoSlots(3, 8, 5, 0.2), 7)!;
    expect(detail).toBeGreaterThan(2.4);
    expect(detail).toBeLessThan(3.6);
  });

  it('has nothing to say about a board with no valleys, or one that is all valley', () => {
    const flat = twoSlots(3, 8, 5);
    flat.z.fill(0);
    expect(measureDetailMm(flat, 5)).toBeUndefined();
    flat.z.fill(-5);
    expect(measureDetailMm(flat, 5)).toBeUndefined();
  });

  it('sizes the finishing bit to fit the valley, where the board alone would not', () => {
    const board = { reliefDepthMm: 4, planWidthMm: 300, planDepthMm: 200 };
    const byBoard = recommendReliefTooling(board).finishingToolDiaMm!;
    expect(byBoard).toBeGreaterThanOrEqual(6);
    const fitted = recommendReliefTooling({ ...board, detailMm: 4 }).finishingToolDiaMm!;
    expect(fitted).toBeLessThanOrEqual(4 * 0.8);
    expect(fitted).toBeGreaterThanOrEqual(3);
    // A wide-open relief is sized by the board as before.
    expect(recommendReliefTooling({ ...board, detailMm: 40 }).finishingToolDiaMm).toBe(byBoard);
  });
});
