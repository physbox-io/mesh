import { describe, it, expect } from 'vitest';
import {
  buildHeightmapMesh,
  imageToHeightmapMesh,
  sampleLuminanceGrid,
  rowsForAspect,
  applySlopeProfile,
  applyMultiLevelSlopeProfile,
  evenThresholds,
  detectLevels,
  bimodality,
  DEFAULT_HEIGHTMAP_OPTIONS,
  type HeightmapOptions,
} from '../src/utils/heightmapMesh';

const opts = (over: Partial<HeightmapOptions> = {}): HeightmapOptions => ({
  ...DEFAULT_HEIGHTMAP_OPTIONS,
  widthM: 0.1,
  maxHeightM: 0.02,
  baseThicknessM: 0.004,
  smoothPasses: 0,
  ...over,
});

/** A ramp from black on the left to white on the right. */
function ramp(cols: number, rows: number): Float32Array {
  const g = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) g[r * cols + c] = c / (cols - 1);
  return g;
}

function maxZ(m: { renderVertices: number[] }): number {
  let z = -Infinity;
  for (let i = 2; i < m.renderVertices.length; i += 3) z = Math.max(z, m.renderVertices[i]);
  return z;
}

describe('buildHeightmapMesh', () => {
  it('is watertight: every edge is shared by exactly two triangles', () => {
    const mesh = buildHeightmapMesh(ramp(9, 7), 9, 7, opts());
    const counts = new Map<string, number>();
    for (let i = 0; i < mesh.faces.length; i += 3) {
      const tri = [mesh.faces[i], mesh.faces[i + 1], mesh.faces[i + 2]];
      for (let k = 0; k < 3; k++) {
        const a = tri[k], b = tri[(k + 1) % 3];
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    expect([...counts.values()].every(n => n === 2)).toBe(true);
  });

  it('encloses a positive volume, so its triangles wind outward', () => {
    const mesh = buildHeightmapMesh(ramp(9, 7), 9, 7, opts());
    const v = mesh.renderVertices;
    let vol = 0;
    for (let i = 0; i < mesh.faces.length; i += 3) {
      const [a, b, c] = [mesh.faces[i] * 3, mesh.faces[i + 1] * 3, mesh.faces[i + 2] * 3];
      vol += (
        v[a] * (v[b + 1] * v[c + 2] - v[c + 1] * v[b + 2]) -
        v[a + 1] * (v[b] * v[c + 2] - v[c] * v[b + 2]) +
        v[a + 2] * (v[b] * v[c + 1] - v[c] * v[b + 1])
      ) / 6;
    }
    expect(vol).toBeGreaterThan(0);
  });

  it('maps white to the top in white-high and to the base in white-low', () => {
    const high = buildHeightmapMesh(ramp(9, 7), 9, 7, opts({ mapping: 'white-high' }));
    const low = buildHeightmapMesh(ramp(9, 7), 9, 7, opts({ mapping: 'white-low' }));
    // Column 8 is white, column 0 black; row 3 is mid-height either way.
    const zAt = (m: typeof high, c: number) => m.renderVertices[(3 * 9 + c) * 3 + 2];
    expect(zAt(high, 8)).toBeCloseTo(0.024, 6);
    expect(zAt(high, 0)).toBeCloseTo(0.004, 6);
    expect(zAt(low, 8)).toBeCloseTo(0.004, 6);
    expect(zAt(low, 0)).toBeCloseTo(0.024, 6);
    expect(maxZ(high)).toBeCloseTo(0.024, 6);
  });

  it('keeps the image aspect ratio and centres the plaque on the origin', () => {
    const mesh = buildHeightmapMesh(ramp(11, 6), 11, 6, opts({ widthM: 0.2 }));
    expect(mesh.sizeM[0]).toBeCloseTo(0.2, 9);
    expect(mesh.sizeM[1]).toBeCloseTo(0.1, 9); // 10 cells wide, 5 tall, square cells
    expect(mesh.boundingBox.center[0]).toBeCloseTo(0, 9);
    expect(mesh.boundingBox.center[1]).toBeCloseTo(0, 9);
    expect(mesh.boundingBox.min[2]).toBeCloseTo(0, 9);
  });

  it('drops sub-floor detail onto the base plane', () => {
    const g = new Float32Array([0, 0.1, 0.9, 1, 0, 0.1, 0.9, 1, 0, 0.1, 0.9, 1]);
    const mesh = buildHeightmapMesh(g, 4, 3, opts({ floor: 0.5 }));
    expect(mesh.heights[0]).toBe(0);
    expect(mesh.heights[1]).toBe(0); // 0.1 is below the floor
    expect(mesh.heights[2]).toBeCloseTo(0.9, 6);
  });

  it('rejects a grid too small to triangulate', () => {
    expect(() => buildHeightmapMesh(new Float32Array(1), 1, 1, opts())).toThrow();
  });
});

describe('sampleLuminanceGrid', () => {
  it('box-averages source blocks and weights by alpha', () => {
    // 2x1 image: opaque white, then fully transparent white.
    const px = new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 0]);
    expect(Array.from(sampleLuminanceGrid(px, 2, 1, 2, 1))).toEqual([1, 0]);
    expect(sampleLuminanceGrid(px, 2, 1, 1, 1)[0]).toBeCloseTo(0.5, 6);
  });
});

describe('imageToHeightmapMesh', () => {
  it('derives its row count from the image aspect', () => {
    const px = new Uint8ClampedArray(40 * 20 * 4).fill(255);
    const mesh = imageToHeightmapMesh(px, 40, 20, opts({ gridCols: 21 }));
    expect(mesh.rows).toBe(rowsForAspect(40, 20, 21));
    expect(mesh.rows).toBe(11);
    expect(mesh.triangleCount).toBe(mesh.faces.length / 3);
  });
});

/** A 21-wide grid split down the middle: black left, white right. */
function halfPlane(cols: number, rows: number): Float32Array {
  const g = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) g[r * cols + c] = c >= cols / 2 ? 1 : 0;
  return g;
}

describe('applySlopeProfile', () => {
  it('ramps linearly across the boundary, centred on the original edge', () => {
    // 20 cells wide, edge between c=9 and c=10; ramp of 4 cells.
    const out = applySlopeProfile(halfPlane(20, 3), 20, 3, 0.5, 4, 'centred');
    const row = (c: number) => out[1 * 20 + c];
    expect(row(9)).toBeCloseTo(0.375, 6);  // half a cell out from the edge
    expect(row(10)).toBeCloseTo(0.625, 6); // mirrored on the high side
    expect(row(8)).toBeCloseTo(0.125, 6);
    expect(row(11)).toBeCloseTo(0.875, 6);
    // Constant slope: equal steps all the way through the ramp.
    expect(row(10) - row(9)).toBeCloseTo(row(11) - row(10), 6);
    expect(row(0)).toBe(0);
    expect(row(19)).toBe(1);
  });

  it('carves the ramp inward, keeping the footprint', () => {
    const out = applySlopeProfile(halfPlane(20, 3), 20, 3, 0.5, 4, 'inward');
    expect(out[20 + 9]).toBe(0);              // background stays flat
    expect(out[20 + 10]).toBeCloseTo(0.125, 6); // first high cell has barely risen
    expect(out[20 + 14]).toBe(1);
  });

  it('spreads the ramp outward, keeping the flat top', () => {
    const out = applySlopeProfile(halfPlane(20, 3), 20, 3, 0.5, 4, 'outward');
    expect(out[20 + 10]).toBe(1);              // shape is full height at its edge
    expect(out[20 + 9]).toBeCloseTo(0.875, 6); // ramp runs into the background
    expect(out[20 + 5]).toBe(0);
  });

  it('slopes radially, so a dot becomes a cone rather than a stepped pyramid', () => {
    const g = new Float32Array(11 * 11);
    g[5 * 11 + 5] = 1;
    const out = applySlopeProfile(g, 11, 11, 0.5, 6, 'centred');
    const at = (dr: number, dc: number) => out[(5 + dr) * 11 + (5 + dc)];
    // Two cells straight out vs. two diagonally: the diagonal is further away,
    // so it must be lower — a per-axis ramp would make them equal.
    expect(at(0, 2)).toBeGreaterThan(at(2, 2));
    expect(at(0, 2)).toBeCloseTo(at(2, 0), 6); // and isotropic across axes
  });

  it('falls back to a hard step at zero slope width and to flat on a single tone', () => {
    const hard = applySlopeProfile(halfPlane(8, 2), 8, 2, 0.5, 0, 'centred');
    expect(Array.from(hard.slice(0, 8))).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    const flat = applySlopeProfile(new Float32Array(8).fill(1), 8, 1, 0.5, 4, 'centred');
    expect(Array.from(flat)).toEqual(new Array(8).fill(1));
  });
});

describe('sloped profile through buildHeightmapMesh', () => {
  it('replaces vertical cliffs with a ramp of the requested run', () => {
    const cliff = buildHeightmapMesh(halfPlane(21, 3), 21, 3, opts({ widthM: 0.02, profile: 'grayscale' }));
    const sloped = buildHeightmapMesh(halfPlane(21, 3), 21, 3, opts({
      widthM: 0.02,          // 20 cells over 20mm => 1mm per cell
      profile: 'sloped',
      slopeWidthM: 0.004,    // 4mm ramp
      slopeStyle: 'centred',
      threshold: 0.5,
    }));
    const zAt = (m: typeof cliff, c: number) => m.renderVertices[(1 * 21 + c) * 3 + 2];
    // Grayscale: neighbouring columns jump the full relief height.
    expect(zAt(cliff, 11) - zAt(cliff, 10)).toBeCloseTo(0.02, 6);
    // Sloped: the same step is spread over the ramp.
    expect(zAt(sloped, 11) - zAt(sloped, 10)).toBeCloseTo(0.02 / 4, 6);
    expect(sloped.heights[1 * 21 + 8]).toBe(0);
    expect(sloped.heights[1 * 21 + 13]).toBe(1);
  });

  it('stays watertight with a slope applied', () => {
    const mesh = buildHeightmapMesh(halfPlane(12, 9), 12, 9, opts({ profile: 'sloped', slopeWidthM: 0.01 }));
    const counts = new Map<string, number>();
    for (let i = 0; i < mesh.faces.length; i += 3) {
      const tri = [mesh.faces[i], mesh.faces[i + 1], mesh.faces[i + 2]];
      for (let k = 0; k < 3; k++) {
        const a = tri[k], b = tri[(k + 1) % 3];
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    expect([...counts.values()].every(n => n === 2)).toBe(true);
  });
});

describe('bimodality', () => {
  it('scores line art high and a gradient low', () => {
    expect(bimodality(halfPlane(20, 20))).toBe(1);
    expect(bimodality(ramp(21, 4))).toBeLessThan(0.5);
  });
});

/** Columns split into `n` equal bands running 0 -> 1. */
function bands(cols: number, rows: number, n: number): Float32Array {
  const g = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const band = Math.min(n - 1, Math.floor((c * n) / cols));
      g[r * cols + c] = band / (n - 1);
    }
  }
  return g;
}

describe('multi-level slope', () => {
  it('leaves the two-level black-and-white result bit-identical', () => {
    const src = halfPlane(20, 5);
    for (const style of ['centred', 'inward', 'outward'] as const) {
      const single = applySlopeProfile(src, 20, 5, 0.5, 4, style);
      const multi = applyMultiLevelSlopeProfile(src, 20, 5, [0.5], 4, style);
      expect(Array.from(multi)).toEqual(Array.from(single));
    }
  });

  it('keeps two-level meshes identical through the builder', () => {
    const src = halfPlane(21, 5);
    const before = buildHeightmapMesh(src, 21, 5, opts({ profile: 'sloped', slopeWidthM: 0.004 }));
    const withLevels = buildHeightmapMesh(src, 21, 5, opts({ profile: 'sloped', slopeWidthM: 0.004, slopeLevels: 2 }));
    expect(Array.from(withLevels.heights)).toEqual(Array.from(before.heights));
    expect(withLevels.renderVertices).toEqual(before.renderVertices);
  });

  it('gives a three-tone image three flat treads with a ramp between each', () => {
    // 15 columns: 5 black, 5 mid-grey, 5 white, over a grid of 1mm cells.
    const mesh = buildHeightmapMesh(bands(15, 3, 3), 15, 3, opts({
      widthM: 0.014, profile: 'sloped', slopeLevels: 3, slopeWidthM: 0.003, smoothPasses: 0,
    }));
    const h = (c: number) => mesh.heights[1 * 15 + c];
    expect(h(1)).toBeCloseTo(0, 6);    // black tread
    expect(h(7)).toBeCloseTo(0.5, 6);  // grey tread, at half height
    expect(h(13)).toBeCloseTo(1, 6);   // white tread
    // Each riser climbs half the relief over the same run, in equal steps.
    expect(h(5) - h(4)).toBeCloseTo(1 / 6, 6);
    expect(h(10) - h(9)).toBeCloseTo(h(5) - h(4), 6);
    // Monotone throughout: no dips between treads.
    for (let c = 1; c < 15; c++) expect(h(c)).toBeGreaterThanOrEqual(h(c - 1) - 1e-9);
  });

  it('stays monotone when ramps overlap', () => {
    // Six levels crammed into 12 columns with a run wider than the treads.
    const mesh = buildHeightmapMesh(bands(12, 3, 6), 12, 3, opts({
      widthM: 0.011, profile: 'sloped', slopeLevels: 6, slopeWidthM: 0.006, smoothPasses: 0,
    }));
    const h = (c: number) => mesh.heights[1 * 12 + c];
    for (let c = 1; c < 12; c++) expect(h(c)).toBeGreaterThanOrEqual(h(c - 1) - 1e-9);
    expect(h(0)).toBeGreaterThanOrEqual(0);
    expect(h(11)).toBeLessThanOrEqual(1);
  });
});

describe('evenThresholds', () => {
  it('cuts midway between evenly spaced levels', () => {
    expect(evenThresholds(2)).toEqual([0.5]);
    expect(evenThresholds(3)).toEqual([0.25, 0.75]);
    expect(evenThresholds(5).length).toBe(4);
  });
});

describe('detectLevels', () => {
  it('counts the flat tones in line art and backs off to 2 on a gradient', () => {
    expect(detectLevels(bands(60, 60, 2))).toBe(2);
    expect(detectLevels(bands(60, 60, 3))).toBe(3);
    expect(detectLevels(bands(60, 60, 4))).toBe(4);
    expect(detectLevels(ramp(64, 64))).toBe(2);
  });
});
