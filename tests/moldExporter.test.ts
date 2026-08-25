import { describe, it, expect } from 'vitest';
import {
  generateMoldMeshes,
  exportBinarySTL,
  computeNormal,
  DEFAULT_MOLD_OPTIONS,
  type Triangle3D,
} from '../src/utils/moldExporter';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

function bodyWith(geom: Partial<SceneGeom> & { type: SceneGeom['type']; size: number[] }, pos = [0, 0, 0]): SceneGraph {
  return {
    nodes: [
      {
        id: 'b1',
        name: 'part',
        type: 'body',
        pos,
        geoms: [{ name: 'g1', ...geom } as SceneGeom],
        joints: [],
        children: [],
      },
    ],
  };
}

const dome = bodyWith({ type: 'sphere', size: [0.03] }, [0, 0, 0]); // 60mm diameter sphere
const box = bodyWith({ type: 'box', size: [0.025, 0.02, 0.015] }, [0, 0, 0.015]); // 50x40x30mm box

describe('Binary STL Exporter', () => {
  it('encodes valid Little-Endian Binary STL header, count, and triangles', () => {
    const tris: Triangle3D[] = [
      {
        a: [0, 0, 0],
        b: [10, 0, 0],
        c: [0, 10, 0],
        normal: [0, 0, 1],
      },
      {
        a: [10, 0, 0],
        b: [10, 10, 0],
        c: [0, 10, 0],
        normal: [0, 0, 1],
      },
    ];

    const bytes = exportBinarySTL(tris, 'Test Mold');
    expect(bytes.length).toBe(80 + 4 + 2 * 50); // 184 bytes

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(80, true)).toBe(2);

    // First triangle normal
    expect(view.getFloat32(84, true)).toBeCloseTo(0);
    expect(view.getFloat32(88, true)).toBeCloseTo(0);
    expect(view.getFloat32(92, true)).toBeCloseTo(1);

    // First triangle Vertex B (x=10)
    expect(view.getFloat32(84 + 24, true)).toBeCloseTo(10);
  });

  it('computes correct normal vector', () => {
    const norm = computeNormal([0, 0, 0], [1, 0, 0], [0, 1, 0]);
    expect(norm[0]).toBeCloseTo(0);
    expect(norm[1]).toBeCloseTo(0);
    expect(norm[2]).toBeCloseTo(1);
  });
});

describe('3D Mold Generator', () => {
  it('generates a 2-part clamshell mold with top/bottom halves, pins, sprue, and vents', () => {
    const res = generateMoldMeshes(dome, {
      ...DEFAULT_MOLD_OPTIONS,
      moldType: 'clamshell',
      wallMarginMm: 10,
      baseThicknessMm: 5,
      includeSprue: true,
      includeVents: true,
    });

    expect(res.success).toBe(true);
    expect(res.totalTriangles).toBeGreaterThan(100);
    expect(res.binarySTL.length).toBe(84 + res.totalTriangles * 50);

    expect(res.bottomHalf).toBeDefined();
    expect(res.bottomHalf.triangles.length).toBeGreaterThan(50);

    expect(res.topHalf).toBeDefined();
    expect(res.topHalf!.triangles.length).toBeGreaterThan(50);

    // Both halves come out in the one plate. They used to be serialised again
    // as a pair of separate STLs for a second download button; the slicer that
    // opens the plate lays both out anyway, so the extra copies were work done
    // for nothing on every export.
    expect(res.combinedTriangles.length).toBe(
      res.bottomHalf.triangles.length + res.topHalf!.triangles.length
    );

    // Mold dimensions enclose the 60mm dome + 20mm margin (10mm per side)
    expect(res.moldWidthMm).toBeGreaterThanOrEqual(75);
    expect(res.moldDepthMm).toBeGreaterThanOrEqual(75);
  });

  it('generates a 1-part open pour mold', () => {
    const res = generateMoldMeshes(box, {
      ...DEFAULT_MOLD_OPTIONS,
      moldType: 'open',
      wallMarginMm: 8,
      baseThicknessMm: 4,
    });

    expect(res.success).toBe(true);
    expect(res.bottomHalf).toBeDefined();
    expect(res.topHalf).toBeUndefined();
    expect(res.totalTriangles).toBe(res.bottomHalf.triangleCount);
  });

  it('handles empty scene gracefully', () => {
    const emptyScene: SceneGraph = { nodes: [] };
    const res = generateMoldMeshes(emptyScene);
    expect(res.success).toBe(false);
    expect(res.warnings.length).toBeGreaterThan(0);
  });
});
