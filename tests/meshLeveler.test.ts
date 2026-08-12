import { describe, it, expect } from 'vitest';
import { createEmptyGrid, interpolateGridZ, getGridStats, warpGcode, type ProbeGrid } from '../src/utils/meshLeveler';

describe('meshLeveler', () => {
  it('creates an empty grid with correct bounds and zero Z values', () => {
    const grid = createEmptyGrid({ minX: 0, minY: 0, maxX: 100, maxY: 50 }, 3, 3);
    expect(grid.gridX).toBe(3);
    expect(grid.gridY).toBe(3);
    expect(grid.points[0][0]).toEqual({ x: 0, y: 0, z: 0 });
    expect(grid.points[2][2]).toEqual({ x: 100, y: 50, z: 0 });
  });

  it('correctly performs bilinear heightmap Z-interpolation on a tilted plane', () => {
    const grid: ProbeGrid = {
      minX: 0,
      minY: 0,
      maxX: 100,
      maxY: 100,
      gridX: 2,
      gridY: 2,
      points: [
        [{ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 1.0 }],
        [{ x: 0, y: 100, z: 0 }, { x: 100, y: 100, z: 1.0 }],
      ],
    };

    // Center point at (50, 50) should be Z = 0.5
    expect(interpolateGridZ(grid, 50, 50)).toBeCloseTo(0.5);
    // Point at (25, 50) should be Z = 0.25
    expect(interpolateGridZ(grid, 25, 50)).toBeCloseTo(0.25);
    // Point at (75, 50) should be Z = 0.75
    expect(interpolateGridZ(grid, 75, 50)).toBeCloseTo(0.75);
  });

  it('computes grid stats correctly', () => {
    const grid: ProbeGrid = {
      minX: 0,
      minY: 0,
      maxX: 10,
      maxY: 10,
      gridX: 2,
      gridY: 2,
      points: [
        [{ x: 0, y: 0, z: -0.1 }, { x: 10, y: 0, z: 0.3 }],
        [{ x: 0, y: 10, z: 0.1 }, { x: 10, y: 10, z: 0.5 }],
      ],
    };

    const stats = getGridStats(grid);
    expect(stats.minZ).toBeCloseTo(-0.1);
    expect(stats.maxZ).toBeCloseTo(0.5);
    expect(stats.spanZ).toBeCloseTo(0.6);
    expect(stats.avgZ).toBeCloseTo(0.2);
  });

  it('warps linear G-code cutting paths by interpolating Z offsets', () => {
    const grid: ProbeGrid = {
      minX: 0,
      minY: 0,
      maxX: 100,
      maxY: 100,
      gridX: 2,
      gridY: 2,
      points: [
        [{ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 1.0 }],
        [{ x: 0, y: 100, z: 0 }, { x: 100, y: 100, z: 1.0 }],
      ],
    };

    const inputGcode = [
      'G90 G21',
      'G0 X0 Y0 Z-1.000',
      'G1 X100 Y0 Z-1.000 F1200',
    ].join('\n');

    const warped = warpGcode(inputGcode, grid, 50.0);
    // Target move at (100, 0) has Z offset +1.0, so Z-1.0 + 1.0 = Z 0.000
    expect(warped).toContain('Z0.000');
    // Middle point at X50 should be Z -1.0 + 0.5 = Z -0.500
    expect(warped).toContain('X50.000 Y0.000 Z-0.500');
  });
});
