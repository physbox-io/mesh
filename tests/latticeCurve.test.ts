import { describe, expect, it } from 'vitest';
import { curveCoords, type LatticeCoord } from '../src/utils/latticeMesh';

const key = (c: LatticeCoord) => c.join(',');

describe('curveCoords', () => {
  it('leaves the start and end out and keeps every corner on the plane', () => {
    const from: LatticeCoord = [0, 0, 5];
    const to: LatticeCoord = [40, 0, 5];
    const chain = curveCoords(from, [0, 30, 5], [40, 30, 5], to, 'z', 1);
    expect(chain.length).toBeGreaterThan(3);
    expect(chain.map(key)).not.toContain(key(from));
    expect(chain.map(key)).not.toContain(key(to));
    for (const c of chain) expect(c[2]).toBe(5);
    // Distinct corners, or the face cannot be built.
    expect(new Set(chain.map(key)).size).toBe(chain.length);
  });

  it('rounds to the grid step asked for', () => {
    const chain = curveCoords([0, 0, 0], [0, 300, 0], [400, 300, 0], [400, 0, 0], 'z', 10);
    for (const c of chain) {
      expect(c[0] % 10).toBe(0);
      expect(c[1] % 10).toBe(0);
    }
  });

  it('reduces a straight curve to nothing between its ends', () => {
    // Control points on the line itself: the curve IS the segment.
    expect(curveCoords([0, 0, 0], [10, 0, 0], [20, 0, 0], [30, 0, 0], 'z', 1)).toEqual([]);
  });

  it('bows towards its handles', () => {
    const chain = curveCoords([0, 0, 0], [0, 20, 0], [40, 20, 0], [40, 0, 0], 'z', 1);
    const peak = Math.max(...chain.map((c) => c[1]));
    // A cubic with both handles at 20 reaches three quarters of the way.
    expect(peak).toBe(15);
  });

  it('never hands back more corners than a cage can be edited with', () => {
    const chain = curveCoords([0, 0, 0], [0, 5000, 0], [8000, 5000, 0], [8000, 0, 0], 'z', 1, 64);
    expect(chain.length).toBeLessThanOrEqual(64);
    expect(chain.length).toBeGreaterThan(10);
  });

  it('flattens a control point that has wandered off the plane', () => {
    const chain = curveCoords([0, 0, 0], [0, 20, 7], [40, 20, -3], [40, 0, 0], 'z', 1);
    for (const c of chain) expect(c[2]).toBe(0);
  });
});
