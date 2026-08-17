import { describe, it, expect } from 'vitest';
import { generateReliefCarveGcode } from '../src/utils/reliefCarveExporter';
import { collectSceneTriangles } from '../src/utils/contourSliceExporter';
import {
  californiaReliefPreset,
  CALIFORNIA_RELIEF_SETTINGS,
  CA_MAP_WIDTH_MM,
  CA_MAP_HEIGHT_MM,
  CA_COLS,
  CA_ROWS,
  buildCaliforniaMesh,
} from '../src/presets/californiaRelief';

/**
 * The California preset exists to be carved at a specific physical size, which
 * is a claim about the geometry and not about the exporter. These check that
 * the claim survives the trip through the exporter's own fitting.
 */
describe('California relief preset', () => {
  const mesh = buildCaliforniaMesh();

  it('decodes a land mask covering roughly two fifths of its bounding box', () => {
    // California is a diagonal state: its bounding box is mostly Pacific and
    // Nevada. A mask that came out near 100% would mean the point-in-polygon
    // test had failed open and the carve would be a rectangular slab.
    const fraction = mesh.landCells / (CA_COLS * CA_ROWS);
    expect(fraction).toBeGreaterThan(0.35);
    expect(fraction).toBeLessThan(0.5);
  });

  it('builds a closed solid, not a bare surface', () => {
    // Every edge of the mesh should be shared by exactly two triangles. An open
    // sheet leaves a boundary of once-used edges, and the exporter's winding fix
    // keys off signed volume, which an open sheet does not have.
    const edges = new Map<string, number>();
    for (let i = 0; i < mesh.faces.length; i += 3) {
      const [a, b, c] = [mesh.faces[i], mesh.faces[i + 1], mesh.faces[i + 2]];
      for (const [p, q] of [[a, b], [b, c], [c, a]]) {
        const key = p < q ? `${p}_${q}` : `${q}_${p}`;
        edges.set(key, (edges.get(key) || 0) + 1);
      }
    }
    const unpaired = [...edges.values()].filter((n) => n !== 2).length;
    expect(unpaired).toBe(0);
  });

  it('lands on the stock at exactly 120 mm north-south', () => {
    const { tris } = collectSceneTriangles(californiaReliefPreset);
    expect(tris.length).toBeGreaterThan(0);

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < tris.length; i += 3) {
      minX = Math.min(minX, tris[i] * 1000);
      maxX = Math.max(maxX, tris[i] * 1000);
      minY = Math.min(minY, tris[i + 1] * 1000);
      maxY = Math.max(maxY, tris[i + 1] * 1000);
    }
    // Authored in metres so that manual 100% scale is the stated millimetres.
    expect(maxY - minY).toBeCloseTo(CA_MAP_HEIGHT_MM, 3);
    expect(maxX - minX).toBeCloseTo(CA_MAP_WIDTH_MM, 3);
  });

  it('carves at the designed size with no fit rescaling and no warnings', () => {
    const result = generateReliefCarveGcode(californiaReliefPreset, CALIFORNIA_RELIEF_SETTINGS);

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.scaleFactor).toBeCloseTo(1, 6);

    // The footprint the exporter reports back is the map's own bounding box, so
    // a regression in the manual-scale path shows up here rather than on wood.
    expect(result.carveBounds.maxY - result.carveBounds.minY).toBeCloseTo(120, 2);
    expect(result.carveBounds.maxX - result.carveBounds.minX).toBeCloseTo(CA_MAP_WIDTH_MM, 2);

    // It has to fit inside 150 mm square stock with room for the cutter, and the
    // work origin is that stock's near-left corner.
    expect(result.carveBounds.minX).toBeGreaterThan(0);
    expect(result.carveBounds.maxX).toBeLessThan(150);

    expect(result.warnings).toEqual([]);
    expect(result.finishingRasterLines).toBeGreaterThan(100);
    expect(result.toolChange).toBe(true);
  });

  it('cuts the full relief depth and never breaks through the stock', () => {
    const result = generateReliefCarveGcode(californiaReliefPreset, CALIFORNIA_RELIEF_SETTINGS);
    const zs = result.gcode
      .split('\n')
      .map((l) => l.match(/Z(-?\d+\.\d+)/))
      .filter(Boolean)
      .map((m) => parseFloat(m![1]));

    const deepest = Math.min(...zs);
    // The background floor is the deepest the job is allowed to go.
    expect(deepest).toBeGreaterThanOrEqual(-10.001);
    expect(deepest).toBeLessThan(-9.9);
    // And 18 mm stock keeps 8 mm underneath it.
    expect(deepest).toBeGreaterThan(-18);
  });
});
