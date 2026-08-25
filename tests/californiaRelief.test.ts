import { describe, it, expect } from 'vitest';
import {
  generateReliefCarveGcode,
  recommendReliefTooling,
} from '../src/utils/reliefCarveExporter';
import { collectSceneTriangles } from '../src/utils/contourSliceExporter';
import {
  californiaReliefPreset,
  CALIFORNIA_RELIEF_SETTINGS,
  CA_MAP_WIDTH_MM,
  CA_MAP_HEIGHT_MM,
  CA_COLS,
  CA_ROWS,
  CA_CARVE_DEPTH_MM,
  CA_EXAGGERATION,
  CA_PLINTH_FRACTION,
  CA_ELEV_MIN_M,
  CA_ELEV_MAX_M,
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

  it('lands on the stock at exactly its designed north-south size', () => {
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

  it('carves at the designed size with no fit rescaling, and only the warning it earns', () => {
    const result = generateReliefCarveGcode(californiaReliefPreset, CALIFORNIA_RELIEF_SETTINGS);

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.scaleFactor).toBeCloseTo(1, 6);

    // The footprint the exporter reports back is the map's own bounding box, so
    // a regression in the manual-scale path shows up here rather than on wood.
    expect(result.carveBounds.maxY - result.carveBounds.minY).toBeCloseTo(CA_MAP_HEIGHT_MM, 2);
    expect(result.carveBounds.maxX - result.carveBounds.minX).toBeCloseTo(CA_MAP_WIDTH_MM, 2);

    // It has to fit inside the stock with room for the cutter, and the work
    // origin is that stock's near-left corner.
    expect(result.carveBounds.minX).toBeGreaterThan(0);
    expect(result.carveBounds.maxX).toBeLessThan(CALIFORNIA_RELIEF_SETTINGS.stockWidthMm!);

    expect(result.finishingRasterLines).toBeGreaterThan(50);
  });

  it('carries geometry and no tooling, and is carvable once the app supplies some', () => {
    // The preset says how big the object is and how deep it goes. It says
    // nothing about bits, because which cutter reaches the bottom of a 20 mm
    // wall is a fact about a workshop rather than about California.
    const settings = CALIFORNIA_RELIEF_SETTINGS as Record<string, unknown>;
    for (const key of [
      'roughingToolDiaMm', 'finishingToolDiaMm', 'finishingShankDiaMm',
      'finishingFluteLengthMm', 'finishingFeedrate', 'roughingFeedrate',
      'roughingStepdownMm', 'toolStickoutMm', 'holderDiaMm', 'finishingDirection',
    ]) {
      expect(settings[key]).toBeUndefined();
    }

    // And the app's own advice is enough to cut it: geometry in, tooling
    // derived, and the only thing left to say is that 20 mm is a lot of
    // stickout. A shank fouling the wall or material left out of reach would
    // mean the recommendation had not understood the depth.
    const first = generateReliefCarveGcode(californiaReliefPreset, CALIFORNIA_RELIEF_SETTINGS);
    const advised = generateReliefCarveGcode(californiaReliefPreset, {
      ...CALIFORNIA_RELIEF_SETTINGS,
      ...recommendReliefTooling({
        reliefDepthMm: first.reliefDepthMm,
        planWidthMm: first.carveBounds.maxX - first.carveBounds.minX,
        planDepthMm: first.carveBounds.maxY - first.carveBounds.minY,
      }),
    });

    expect(advised.success).toBe(true);
    expect(advised.warnings).toHaveLength(1);
    expect(advised.warnings[0]).toMatch(/diameters of stickout/);
    expect(advised.toolChange).toBe(true);
    // Sweeps the long way: the map is taller than it is wide. 90 degrees from
    // +X is the Y sweep, which is how the header names it now that a raster can
    // run at any angle.
    expect(advised.gcode).toMatch(/raster at 90 degrees/);
  });

  it('cuts the full relief depth and never breaks through the stock', () => {
    const result = generateReliefCarveGcode(californiaReliefPreset, CALIFORNIA_RELIEF_SETTINGS);
    const zs = result.gcode
      .split('\n')
      .map((l) => l.match(/Z(-?\d+\.\d+)/))
      .filter(Boolean)
      .map((m) => parseFloat(m![1]));

    const deepest = Math.min(...zs);
    // The background floor is the deepest the job is allowed to go, and it is
    // reached: a relief that stopped short would not stand proud of anything.
    expect(deepest).toBeGreaterThanOrEqual(-CA_CARVE_DEPTH_MM - 0.001);
    expect(deepest).toBeLessThan(-CA_CARVE_DEPTH_MM + 0.1);
    // And the stock keeps plenty underneath it.
    expect(deepest).toBeGreaterThan(-CALIFORNIA_RELIEF_SETTINGS.stockThicknessMm!);
  });

  it('is carved at the exaggeration the design is pinned to, not one the stock implied', () => {
    const result = generateReliefCarveGcode(californiaReliefPreset, CALIFORNIA_RELIEF_SETTINGS);

    expect(result.reliefDepthMm).toBeCloseTo(CA_CARVE_DEPTH_MM, 3);

    // The mesh is authored at the proportions it is carved at, so filling the
    // depth is very nearly a no-op rather than a stretch. Not exactly one,
    // because vertex heights are the mean of the cells meeting at that corner,
    // which rounds a percent or two off the extremes; filling puts that back.
    // What matters is that it is 1.0-ish and not, say, 5x, which is what a mesh
    // authored at some unrelated height would silently produce.
    expect(result.verticalExaggeration).toBeGreaterThan(0.9);
    expect(result.verticalExaggeration).toBeLessThan(1.15);

    // So asking for the model's own proportions instead gives the same carve to
    // within that same couple of percent.
    const proportional = generateReliefCarveGcode(californiaReliefPreset, {
      ...CALIFORNIA_RELIEF_SETTINGS,
      verticalScaleMode: 'proportional',
      verticalExaggeration: 1,
    });
    expect(proportional.verticalExaggeration).toBeCloseTo(1, 6);
    expect(proportional.reliefDepthMm / result.reliefDepthMm).toBeGreaterThan(0.9);
    expect(proportional.reliefDepthMm / result.reliefDepthMm).toBeLessThan(1.0);
  });

  it('keeps the terrain at the documented exaggeration over true scale', () => {
    // 1054.5 km of California across the map, and this much elevation in it.
    const kmPerMm = 1054.5 / CA_MAP_HEIGHT_MM;
    const trueReliefMm = (CA_ELEV_MAX_M - CA_ELEV_MIN_M) / 1000 / kmPerMm;
    const carvedTerrainMm = CA_CARVE_DEPTH_MM * (1 - CA_PLINTH_FRACTION);
    expect(carvedTerrainMm / trueReliefMm).toBeCloseTo(CA_EXAGGERATION, 0);
  });
});
