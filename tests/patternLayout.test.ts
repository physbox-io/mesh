import { describe, it, expect } from 'vitest';
import { patternById, type PatternOptions } from '../src/utils/surfacePatterns';
import { tartanLevels } from '../src/utils/patternsNatural';

/*
 * The layout every pattern is wrapped in (fit, frame, symmetry, fade,
 * soften), and the generators added with it. A layout fault is never loud:
 * a frame that is not at the board's top just carves a shallow border, and a
 * kaleidoscope that is off by a cell reads as a slightly wonky rosette. So
 * these measure the grid.
 */

const cols = 201;
const rows = 201;
const extent = { widthM: 0.2, depthM: 0.2 };
const at = (g: Float32Array, c: number, r: number) => g[r * cols + c];

function build(id: string, o: PatternOptions = {}): Float32Array {
  const spec = patternById(id)!;
  return spec.build(cols, rows, extent, { ...spec.defaults, ...o });
}

describe('frame', () => {
  it('leaves a plain border at the board top, or sunk to the floor', () => {
    const plain = build('wood_grain', { frameMm: 20 });
    const sunk = build('wood_grain', { frameMm: 20, frameStyle: 'sunk' });
    for (const [c, r] of [[5, 100], [100, 5], [195, 195], [10, 150]]) {
      expect(at(plain, c, r)).toBe(1);
      expect(at(sunk, c, r)).toBe(0);
    }
    // The pattern is still there inside it.
    let lo = 1;
    for (let c = 40; c < 160; c++) lo = Math.min(lo, at(plain, c, 100));
    expect(lo).toBeLessThan(0.3);
  });

  it('cuts a groove round the middle of a grooved frame', () => {
    const g = build('wood_grain', { frameMm: 20, frameStyle: 'groove', frameGrooveMm: 6 });
    // The frame is 20 cells wide; its groove is centred 10 cells in.
    expect(at(g, 10, 100)).toBeLessThan(0.05);
    expect(at(g, 2, 100)).toBe(1);
    expect(at(g, 18, 100)).toBe(1);
  });

  it('sets a raised frame above the whole pattern', () => {
    const g = build('fluted', { frameMm: 20, frameStyle: 'raised' });
    let hi = 0;
    for (let r = 30; r < 170; r++) for (let c = 30; c < 170; c++) hi = Math.max(hi, at(g, c, r));
    expect(hi).toBeLessThanOrEqual(0.7 + 1e-6);
    expect(at(g, 5, 100)).toBe(1);
  });

  it('keeps a through-cut pattern\'s frame solid, whatever style is asked for', () => {
    const g = build('sliced', { frameMm: 20, frameStyle: 'sunk' });
    expect(at(g, 5, 100)).toBe(1);
  });
});

describe('symmetry', () => {
  it('book-matches left to right', () => {
    const g = build('wood_grain', { symmetry: 'mirror_x' });
    for (const r of [10, 77, 150]) {
      for (const c of [0, 13, 60, 99]) expect(at(g, c, r)).toBeCloseTo(at(g, cols - 1 - c, r), 5);
    }
  });

  it('quarters about both axes', () => {
    const g = build('voronoi', { symmetry: 'quarter' });
    expect(at(g, 30, 40)).toBeCloseTo(at(g, cols - 1 - 30, rows - 1 - 40), 5);
    expect(at(g, 30, 40)).toBeCloseTo(at(g, 30, rows - 1 - 40), 5);
  });

  it('a kaleidoscope repeats every turn of 360/n degrees', () => {
    const g = build('voronoi', { symmetry: 'k6' });
    const c0 = (cols - 1) / 2;
    const sample = (rad: number, deg: number) => {
      const a = (deg * Math.PI) / 180;
      return at(g, Math.round(c0 + rad * Math.cos(a)), Math.round(c0 + rad * Math.sin(a)));
    };
    let diff = 0;
    let n = 0;
    for (const rad of [20, 45, 80]) {
      for (const deg of [7, 23, 41]) {
        diff += Math.abs(sample(rad, deg) - sample(rad, deg + 60));
        n++;
      }
    }
    // Rounding to whole cells blurs it a little; a wrong fold is off by far more.
    expect(diff / n).toBeLessThan(0.08);
  });
});

describe('fit', () => {
  it('stretches a lattice so it is the same at both edges', () => {
    // 200 mm at a 30 mm cell is 6.67 cells: fitted it is 7 of 28.6 mm.
    const g = build('faceted', {});
    for (const r of [17, 100, 160]) expect(at(g, 0, r)).toBeCloseTo(at(g, cols - 1, r), 2);
    const free = build('faceted', { layoutAlign: 'free' });
    let mismatch = 0;
    for (let r = 0; r < rows; r += 10) mismatch += Math.abs(at(free, 0, r) - at(free, cols - 1, r));
    expect(mismatch).toBeGreaterThan(0.5);
  });
});

describe('fade and soften', () => {
  it('fades the pattern out to the board top at its edge', () => {
    const g = build('waves', { fadeMm: 40 });
    for (let c = 0; c < cols; c += 20) expect(at(g, c, 0)).toBeCloseTo(1, 5);
  });

  it('softens a two-level pattern into a graded one', () => {
    const sharp = build('masonry', {});
    const soft = build('masonry', { softenMm: 4 });
    const between = (g: Float32Array) => g.filter((v) => v > 0.1 && v < 0.35).length;
    expect(between(soft)).toBeGreaterThan(between(sharp) * 2);
  });
});

describe('lotus mandala', () => {
  it('is n-fold symmetric about the middle and stands proud of a sunk background', () => {
    const g = build('lotus_mandala', { corners: 'plain' });
    // Corners are the sunk background.
    expect(at(g, 0, 0)).toBe(0);
    expect(at(g, cols - 1, rows - 1)).toBe(0);
    // The middle is the seed pod, near the top.
    expect(at(g, 100, 100)).toBeGreaterThan(0.8);
    // Ten petals: a point and the same point a tenth of a turn on match.
    const c0 = 100;
    let diff = 0;
    for (const rad of [30, 55, 75]) {
      for (const deg of [5, 13]) {
        const a = (deg * Math.PI) / 180;
        const b = a + (2 * Math.PI) / 10;
        diff += Math.abs(
          at(g, Math.round(c0 + rad * Math.cos(a)), Math.round(c0 + rad * Math.sin(a))) -
            at(g, Math.round(c0 + rad * Math.cos(b)), Math.round(c0 + rad * Math.sin(b)))
        );
      }
    }
    expect(diff / 6).toBeLessThan(0.1);
  });

  it('fills the corners with quarter rosettes when asked', () => {
    const plain = build('lotus_mandala', { corners: 'plain' });
    const quarter = build('lotus_mandala', { corners: 'quarter' });
    const raised = (g: Float32Array) => {
      let n = 0;
      for (let r = 0; r < 20; r++) for (let c = 0; c < 20; c++) if (at(g, c, r) > 0.2) n++;
      return n;
    };
    expect(raised(plain)).toBe(0);
    expect(raised(quarter)).toBeGreaterThan(40);
  });
});

describe('thai tiles', () => {
  it('fits whole tiles to the board, with the joint at the floor between them', () => {
    // 200 mm at 100 mm: two tiles each way, the joint down the middle.
    const g = build('thai_tiles', { tileMm: 100, gutterMm: 2 });
    expect(at(g, 100, 37)).toBeLessThan(0.2);
    expect(at(g, 37, 100)).toBeLessThan(0.2);
    // Each tile's flower is at its centre, standing high.
    expect(at(g, 50, 50)).toBeGreaterThan(0.8);
    expect(at(g, 150, 150)).toBeGreaterThan(0.8);
  });

  it('alternates motifs like a chequerboard', () => {
    const same = build('thai_tiles', { tileMm: 100 });
    const alt = build('thai_tiles', { tileMm: 100, alternate: 'phikun' });
    // Tile (0,0) is the main motif either way; tile (1,0) changes.
    expect(at(alt, 30, 50)).toBeCloseTo(at(same, 30, 50), 5);
    let d = 0;
    for (let r = 20; r < 80; r += 3) for (let c = 120; c < 180; c += 3) d += Math.abs(at(alt, c, r) - at(same, c, r));
    expect(d).toBeGreaterThan(5);
  });
});

describe('tartan', () => {
  it('cuts each colour to a level the palette reads back as that colour', () => {
    const spec = patternById('tartan')!;
    const opts = { ...spec.defaults };
    const g = build('tartan', {});
    const levels = tartanLevels(opts);
    const seen = new Set<string>();
    for (const v of g) {
      const [r, gg, b] = spec.palette!(v, opts);
      seen.add(`${r},${gg},${b}`);
    }
    // Every colour in the sett shows, and nothing else does.
    expect(seen.size).toBe(levels.length);
  });
});

describe('weave', () => {
  it('cuts the gaps between strands to the floor', () => {
    const g = build('weave', { gapMm: 2, pitchMm: 10 });
    expect(Math.min(...Array.from(g))).toBe(0);
    expect(Math.max(...Array.from(g))).toBeGreaterThan(0.85);
    // Fitted with the edges between strands: the board ends the same way
    // at both sides.
    for (const r of [3, 50, 120]) expect(at(g, 0, r)).toBeCloseTo(at(g, cols - 1, r), 2);
  });
});

describe('water drop', () => {
  it('rings out from the middle, the same in every direction', () => {
    const g = build('water_drop', {});
    for (const rad of [30, 60]) {
      expect(at(g, 100 + rad, 100)).toBeCloseTo(at(g, 100, 100 + rad), 3);
      expect(at(g, 100 - rad, 100)).toBeCloseTo(at(g, 100, 100 - rad), 3);
    }
  });
});
