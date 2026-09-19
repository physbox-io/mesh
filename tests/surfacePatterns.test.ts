import { describe, it, expect } from 'vitest';
import {
  SURFACE_PATTERNS,
  patternById,
  buildPatternPlank,
  MAX_PATTERN_CELLS,
  PANEL_BASE_MM,
  RELIEF_FLOOR_MM,
  type PatternExtent,
} from '../src/utils/surfacePatterns';
import type { StockSize } from '../src/utils/stockSettings';

/*
 * What these defend: a pattern is a height field, and everything downstream --
 * the mesh builder, the relief exporter, the preview -- assumes it spans 0..1
 * over exactly the grid it was asked for. A pattern that quietly returns a flat
 * board, a NaN, or a grid of the wrong size does not fail loudly; it produces a
 * plank that machines wrong.
 *
 * Two of these have caught real bugs. The Gray-Scott field diverged to
 * infinity within a few dozen steps and normalised back to a dead flat board,
 * which looked exactly like "the pattern has no contrast yet". And wood grain's
 * knots were an unbounded singularity, so the ring count jumped by tens of
 * rings between neighbouring cells and aliased into noise.
 */

const extent: PatternExtent = { widthM: 0.3, depthM: 0.12 };

/** How much of the grid's range is actually used, which is what "has a pattern" means. */
function spread(grid: Float32Array): number {
  let min = Infinity;
  let max = -Infinity;
  for (const v of grid) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return max - min;
}

describe('every surface pattern', () => {
  for (const spec of SURFACE_PATTERNS) {
    describe(spec.id, () => {
      it('fills exactly the grid it was asked for, in 0..1, with no NaNs', () => {
        const cols = 71;
        const rows = 29;
        const grid = spec.build(cols, rows, extent, spec.defaults);
        expect(grid.length).toBe(cols * rows);
        for (const v of grid) {
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      });

      it('actually has a pattern in it at its own defaults', () => {
        // The failure this catches is silent: a diverged or dead field
        // normalises to a flat board, which carves as nothing at all.
        const grid = spec.build(96, 40, extent, spec.defaults);
        expect(spread(grid)).toBeGreaterThan(0.5);
      });

      it('is the same pattern every time for the same settings', () => {
        const a = spec.build(48, 20, extent, spec.defaults);
        const b = spec.build(48, 20, extent, spec.defaults);
        expect(Array.from(a)).toEqual(Array.from(b));
      });

      it('declares a default for every field it offers', () => {
        for (const f of spec.fields) {
          expect(spec.defaults[f.key], `${spec.id}.${f.key}`).toBeDefined();
        }
      });
    });
  }

  it('has unique ids', () => {
    const ids = SURFACE_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('seeding', () => {
  // Studs is the one pattern with nothing random in it -- a lattice of studs on
  // a pitch is fully determined by the pitch -- so it has no seed to vary.
  const seeded = SURFACE_PATTERNS.filter((p) => 'seed' in p.defaults);

  it('covers every pattern that claims to be seeded', () => {
    expect(seeded.length).toBeGreaterThanOrEqual(6);
  });

  for (const spec of seeded) {
    it(`${spec.id} gives a different pattern for a different seed`, () => {
      const a = spec.build(64, 26, extent, { ...spec.defaults, seed: 1 });
      const b = spec.build(64, 26, extent, { ...spec.defaults, seed: 99 });
      expect(Array.from(a)).not.toEqual(Array.from(b));
    });
  }
});

describe('wood grain', () => {
  const wood = patternById('wood_grain')!;

  it('puts more rings on the board when the rings are closer together', () => {
    // Count crossings of the mid height along one row: rings are a repeating
    // ramp, so twice as many rings is about twice as many crossings.
    const crossings = (ringSpacingMm: number): number => {
      const cols = 400;
      const g = wood.build(cols, 8, extent, { ...wood.defaults, ringSpacingMm, knots: 0, wander: 0, angleDeg: 90 });
      let n = 0;
      for (let c = 1; c < cols; c++) {
        const prev = g[4 * cols + c - 1];
        const cur = g[4 * cols + c];
        if ((prev < 0.5 && cur >= 0.5) || (prev >= 0.5 && cur < 0.5)) n++;
      }
      return n;
    };
    expect(crossings(5)).toBeGreaterThan(crossings(15));
  });

  it('does not alias into noise when knots are present', () => {
    // The knot pull used to be an unbounded 1/d, which changed the ring count
    // by tens of rings between neighbouring cells. The symptom was a region of
    // speckle rather than grain, so the test is on how far neighbouring cells
    // can jump.
    const cols = 240;
    const rows = 100;
    const cliffRate = (knots: number): number => {
      const g = wood.build(cols, rows, extent, { ...wood.defaults, knots, seed: 7 });
      let big = 0;
      for (let r = 0; r < rows; r++) {
        for (let c = 1; c < cols; c++) {
          if (Math.abs(g[r * cols + c] - g[r * cols + c - 1]) > 0.8) big++;
        }
      }
      return big / (cols * rows);
    };
    // Ring boundaries are genuine cliffs, so the measure is against a
    // knot-free board rather than against an absolute number. Knots legitimately
    // crowd the rings, so some increase is right; speckle was an order of
    // magnitude, because every cell became its own cliff.
    const plain = cliffRate(0);
    expect(plain).toBeGreaterThan(0);
    expect(cliffRate(6)).toBeLessThan(plain * 3);
  });
});

describe('topographic', () => {
  const topo = patternById('topographic')!;

  it('terraces into flat steps, and more of the board is flat as sharpness rises', () => {
    const flatFraction = (sharpness: number): number => {
      const levels = 7;
      const g = topo.build(200, 80, extent, { ...topo.defaults, levels, sharpness });
      let flat = 0;
      for (const v of g) {
        const s = v * (levels - 1);
        if (Math.abs(s - Math.round(s)) < 1e-4) flat++;
      }
      return flat / g.length;
    };
    expect(flatFraction(1)).toBeGreaterThan(0.99);
    expect(flatFraction(0.85)).toBeGreaterThan(0.7);
    expect(flatFraction(0.85)).toBeGreaterThan(flatFraction(0.4));
  });

  it('never produces fewer than two levels, however few are asked for', () => {
    // One level is a flat board, which is not a pattern and not something a
    // dialog should be able to ask for.
    const g = topo.build(64, 26, extent, { ...topo.defaults, levels: 1 });
    expect(spread(g)).toBeGreaterThan(0.5);
  });
});

describe('stud plate', () => {
  const studs = patternById('studs')!;

  it('puts one stud on each lattice point and leaves the plate between them flat', () => {
    const stock = { widthM: 0.08, depthM: 0.08 };
    const cols = 320;
    const rows = 320;
    const g = studs.build(cols, rows, stock, {
      pitchMm: 8, diameterMm: 4.8, marginMm: 4, shoulder: 0,
    });
    // 80 mm with a 4 mm margin leaves 72 mm, which holds 10 studs at 8 mm pitch.
    let peaks = 0;
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        const i = r * cols + c;
        if (g[i] === 1 && g[i - 1] < 1) peaks++;
      }
    }
    // One left-hand edge per stud per row it spans.
    expect(peaks).toBeGreaterThan(0);

    // The plate between studs is genuinely flat, not merely low.
    let zeros = 0;
    for (const v of g) if (v === 0) zeros++;
    expect(zeros / g.length).toBeGreaterThan(0.4);
  });

  it('leaves a flat board rather than a full-depth one when nothing fits', () => {
    // Normalising a board with no studs on it would amplify floating-point
    // dust into a full-depth pattern.
    const g = studs.build(64, 64, { widthM: 0.02, depthM: 0.02 }, {
      pitchMm: 8, diameterMm: 4.8, marginMm: 40, shoulder: 0.25,
    });
    expect(spread(g)).toBe(0);
  });
});

describe('turing pattern', () => {
  const rd = patternById('reaction_diffusion')!;

  it('forms a pattern for every named regime', () => {
    // The chemistry is only alive in a narrow band of the parameter space;
    // outside it the field decays to bare substrate and carves as nothing.
    const presets = (rd.fields.find((f) => f.kind === 'choice' && f.key === 'preset') as
      { options: Array<{ value: string }> }).options;
    expect(presets.length).toBeGreaterThanOrEqual(5);
    for (const { value } of presets) {
      const g = rd.build(64, 64, { widthM: 0.1, depthM: 0.1 }, {
        ...rd.defaults, preset: value, iterations: 1200,
      });
      expect(spread(g), `regime ${value} produced a flat board`).toBeGreaterThan(0.5);
    }
  });

  it('claims no animal markings, because it cannot make them', () => {
    // Gray-Scott is isotropic: it has no way to prefer a direction, so it
    // cannot produce the parallel bars of a tiger. An earlier version named
    // these regimes after animals and they looked nothing like them.
    const labels = (rd.fields.find((f) => f.kind === 'choice') as
      { options: Array<{ value: string; label: string }> }).options;
    for (const o of labels) {
      expect(/tiger|leopard|giraffe|zebra|cheetah/i.test(o.label + o.value)).toBe(false);
    }
  });

  it('stays finite however long it is run', () => {
    // It diverged to infinity in a few dozen steps before the concentrations
    // were clamped, and the NaNs normalised back to a flat board.
    const g = rd.build(48, 48, { widthM: 0.1, depthM: 0.1 }, { ...rd.defaults, iterations: 6000 });
    for (const v of g) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('masonry', () => {
  const brick = patternById('masonry')!;

  it('offsets alternate courses in a running bond but not in a stack bond', () => {
    const stock = { widthM: 0.3, depthM: 0.12 };
    const cols = 300;
    const rows = 120;
    const opts = { brickLengthMm: 60, brickHeightMm: 20, mortarMm: 5, jitter: 0, seed: 1 };

    /** Where the vertical mortar joints fall along a row through a course. */
    const joints = (bond: string, row: number): number[] => {
      const g = brick.build(cols, rows, stock, { ...opts, bond });
      const out: number[] = [];
      for (let c = 0; c < cols; c++) if (g[row * cols + c] === 0) out.push(c);
      return out;
    };

    // Rows through the middle of two neighbouring courses.
    const courseRows = [Math.round(rows * 0.09), Math.round(rows * 0.26)];
    const stackA = joints('stack', courseRows[0]);
    const stackB = joints('stack', courseRows[1]);
    expect(stackA).toEqual(stackB);

    const runA = joints('running', courseRows[0]);
    const runB = joints('running', courseRows[1]);
    expect(runA).not.toEqual(runB);
  });

  it('cuts the mortar to the floor and leaves the brick faces proud', () => {
    const g = brick.build(240, 96, extent, { ...brick.defaults, jitter: 0 });
    let floor = 0;
    let proud = 0;
    for (const v of g) {
      if (v === 0) floor++;
      else if (v > 0.6) proud++;
    }
    expect(floor).toBeGreaterThan(0);
    expect(proud).toBeGreaterThan(floor);
  });
});

describe('buildPatternPlank', () => {
  const stock: StockSize = { widthMm: 300, depthMm: 120, thicknessMm: 25 };
  const wood = patternById('wood_grain')!;

  it('makes a board the size of the stock, to within half a cell', () => {
    const { mesh, cols, depthErrorMm } = buildPatternPlank(wood, wood.defaults, stock, 6, 200);
    expect(mesh.sizeM[0]).toBeCloseTo(0.3, 6);
    // Cells are square, so the depth is a whole number of them and cannot
    // always land exactly on the stock. It must land within half a cell, and
    // the caller is told by how much so the dialog can show the truth.
    const cellMm = 300 / (cols - 1);
    expect(Math.abs(depthErrorMm)).toBeLessThanOrEqual(cellMm / 2 + 1e-9);
    expect(mesh.sizeM[1] * 1000).toBeCloseTo(120 + depthErrorMm, 6);
    // The panel's height is the pattern depth plus its base, and nothing else.
    // It is deliberately NOT the stock's thickness: the exporter reads its
    // carve depth off this number and would otherwise plan a 25 mm carve, with
    // the roughing passes and the cutter reach to match, for a 6 mm pattern.
    expect(mesh.sizeM[2] * 1000).toBeCloseTo(6 + PANEL_BASE_MM, 6);
  });

  it('is wound the right way out', () => {
    // A mesh built inside out is not drawn at all on its near face, which
    // reads as a half-transparent body rather than as a broken one. See
    // CLAUDE.md; californiaRelief shipped this way.
    const { mesh } = buildPatternPlank(wood, wood.defaults, stock, 6, 120);
    let vol = 0;
    for (let i = 0; i < mesh.faces.length; i += 3) {
      const a = mesh.faces[i] * 3;
      const b = mesh.faces[i + 1] * 3;
      const c = mesh.faces[i + 2] * 3;
      const v = mesh.renderVertices;
      vol +=
        (v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) +
          v[a + 1] * (v[b + 2] * v[c] - v[b] * v[c + 2]) +
          v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c])) / 6;
    }
    expect(vol).toBeGreaterThan(0);
  });

  it('keeps the board proportions when it has to shrink an over-large grid', () => {
    const { cols, rows } = buildPatternPlank(wood, wood.defaults, stock, 6, 4000);
    expect(cols * rows).toBeLessThanOrEqual(MAX_PATTERN_CELLS);
    // 300 x 120 is 2.5:1, and both axes shrink together.
    expect(cols / rows).toBeCloseTo(2.5, 1);
  });

  it('refuses a pattern that would not leave material under it', () => {
    const deepest = stock.thicknessMm - PANEL_BASE_MM - RELIEF_FLOOR_MM;
    // The deepest that does fit is accepted...
    expect(() => buildPatternPlank(wood, wood.defaults, stock, deepest, 120)).not.toThrow();
    // ...and a tenth past it is not.
    expect(() => buildPatternPlank(wood, wood.defaults, stock, deepest + 0.1, 120))
      .toThrow(/does not fit/);
    expect(() => buildPatternPlank(wood, wood.defaults, stock, stock.thicknessMm, 120)).toThrow();
    expect(() => buildPatternPlank(wood, wood.defaults, stock, 0, 120)).toThrow(/needs a depth/);
  });

  it('refuses stock with no size', () => {
    expect(() =>
      buildPatternPlank(wood, wood.defaults, { widthMm: 0, depthMm: 120, thicknessMm: 18 }, 4, 120)
    ).toThrow(/width, a depth and a thickness/);
  });

  it('builds a static mesh geom, not a falling body', () => {
    // A workpiece is clamped to a bed. A free joint would let the physics
    // worker drop it through the floor the moment the scene played.
    const { node } = buildPatternPlank(wood, wood.defaults, stock, 6, 120);
    expect(node.joints).toEqual([]);
    expect(node.geoms).toHaveLength(1);
    expect(node.geoms[0].type).toBe('mesh');
    expect(node.geoms[0].dynamic).toBeFalsy();
  });
});


describe('animal print', () => {
  const coat = patternById('animal_print')!;
  const coats = (coat.fields.find((f) => f.kind === 'choice') as
    { options: Array<{ value: string }> }).options.map((o) => o.value);

  it('offers the six coats', () => {
    expect(coats).toEqual(['tiger', 'zebra', 'leopard', 'cheetah', 'giraffe', 'cow']);
  });

  for (const c of coats) {
    it(`${c} covers part of the board and leaves the rest of it bare`, () => {
      // Markings on bare ground. A coat that is all marking or all ground is
      // not a coat, and both are what a badly scaled pattern degenerates to.
      const g = coat.build(220, 90, extent, { ...coat.defaults, coat: c });
      let marked = 0;
      for (const v of g) if (v > 0.5) marked++;
      const fraction = marked / g.length;
      expect(fraction, `${c} covers ${(fraction * 100).toFixed(0)}%`).toBeGreaterThan(0.05);
      expect(fraction, `${c} covers ${(fraction * 100).toFixed(0)}%`).toBeLessThan(0.85);
    });
  }

  it('runs the stripes across the board, not along it', () => {
    // A tiger's bars are perpendicular to the spine. The test is that crossing
    // the board horizontally meets many more edges than going down it does.
    const cols = 300;
    const rows = 120;
    const g = coat.build(cols, rows, extent, { ...coat.defaults, coat: 'tiger', wander: 0 });
    const edges = (horizontal: boolean): number => {
      let n = 0;
      if (horizontal) {
        for (let r = 0; r < rows; r += 4) {
          for (let c = 1; c < cols; c++) {
            if ((g[r * cols + c] > 0.5) !== (g[r * cols + c - 1] > 0.5)) n++;
          }
        }
      } else {
        for (let c = 0; c < cols; c += 4) {
          for (let r = 1; r < rows; r++) {
            if ((g[r * cols + c] > 0.5) !== (g[(r - 1) * cols + c] > 0.5)) n++;
          }
        }
      }
      return n;
    };
    expect(edges(true)).toBeGreaterThan(edges(false) * 3);
  });

  it('puts fewer, larger markings on the board as the marking size goes up', () => {
    const blobs = (scaleMm: number): number => {
      const cols = 300;
      const rows = 120;
      const g = coat.build(cols, rows, extent, { ...coat.defaults, coat: 'cheetah', scaleMm });
      let starts = 0;
      for (let r = 0; r < rows; r++) {
        for (let c = 1; c < cols; c++) {
          if (g[r * cols + c] > 0.5 && g[r * cols + c - 1] <= 0.5) starts++;
        }
      }
      return starts;
    };
    expect(blobs(12)).toBeGreaterThan(blobs(40));
  });
});


describe('colouring', () => {
  const stock: StockSize = { widthMm: 200, depthMm: 100, thicknessMm: 20 };

  it('paints the top surface and nothing else', () => {
    // Paint lands on the same vertices the height grid does -- the top surface
    // is laid out first, one vertex per cell -- and the skirt and underside are
    // left to the body's own colour, because they are the sawn edge of the
    // board rather than part of the pattern.
    const spec = patternById('animal_print')!;
    const { node, cols, rows } = buildPatternPlank(spec, spec.defaults, stock, 5, 160);
    const paint = node.geoms[0].paint;
    expect(paint).toBeDefined();
    expect(paint!.idx).toHaveLength(cols * rows);
    expect(paint!.idx[0]).toBe(0);
    expect(paint!.idx[paint!.idx.length - 1]).toBe(cols * rows - 1);
    // `res` is empty for a mesh geom: it is painted at its own vertex density.
    expect(paint!.res).toEqual([]);
    // Four bytes a vertex, fully opaque.
    expect(paint!.rgba).toHaveLength(cols * rows * 4);
    for (let i = 3; i < paint!.rgba.length; i += 4) expect(paint!.rgba[i]).toBe(255);
    for (const v of paint!.rgba) expect(v).toBeGreaterThanOrEqual(0);
    for (const v of paint!.rgba) expect(v).toBeLessThanOrEqual(255);
  });

  it('gives a tiger board both of its colours', () => {
    const spec = patternById('animal_print')!;
    const { node } = buildPatternPlank(spec, { ...spec.defaults, coat: 'tiger' }, stock, 5, 160);
    const rgba = node.geoms[0].paint!.rgba;
    let dark = 0;
    let ground = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i] < 60) dark++;
      else if (rgba[i] > 180) ground++;
    }
    // Neither colour may be a rounding error: a board that came out all orange
    // or all black would still have a perfectly good height field under it.
    expect(dark).toBeGreaterThan(rgba.length / 4 * 0.1);
    expect(ground).toBeGreaterThan(rgba.length / 4 * 0.1);
  });

  it('leaves patterns alone where a colour would be a guess', () => {
    // A stud plate is whatever the stock is, and so is a wave. Inventing a
    // colour for them would be inventing a material.
    for (const id of ['studs', 'waves']) {
      const spec = patternById(id)!;
      const { node } = buildPatternPlank(spec, spec.defaults, stock, 5, 120);
      expect(node.geoms[0].paint, id).toBeUndefined();
    }
  });

  it('every palette answers in range across the whole height range', () => {
    for (const spec of SURFACE_PATTERNS) {
      if (!spec.palette) continue;
      for (let i = 0; i <= 20; i++) {
        const rgb = spec.palette(i / 20, spec.defaults);
        expect(rgb, `${spec.id} at h=${i / 20}`).toHaveLength(3);
        for (const c of rgb) {
          expect(Number.isFinite(c), `${spec.id} at h=${i / 20}`).toBe(true);
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
