import { describe, expect, it } from 'vitest';
import {
  boxLattice, mergeLattice, vertexCount, latticeStats, setCrease, findVertex, isCrease, type LatticeCoord,
} from '../src/utils/latticeMesh';

describe('mergeLattice', () => {
  it('pours one cage into another, sharing the corners that land together', () => {
    const target = boxLattice(0.0001, 200);
    const source = boxLattice(0.0001, 200);
    // Slid along X by its own width: the two boxes share a wall's four corners.
    const added = mergeLattice(target, source, ([i, j, k]) => [i + 400, j, k]);
    expect(added).toBe(6);
    expect(vertexCount(target)).toBe(12);
    expect(latticeStats(target).faces).toBe(12);
  });

  it('carries creases across with their edges', () => {
    const target = boxLattice(0.0001, 200);
    const source = boxLattice(0.0001, 200);
    const a = findVertex(source, -200, -200, -200);
    const b = findVertex(source, 200, -200, -200);
    expect(setCrease(source, a, b, true)).toBe(true);
    mergeLattice(target, source, ([i, j, k]) => [i, j, k + 1000]);
    const ta = findVertex(target, -200, -200, 800);
    const tb = findVertex(target, 200, -200, 800);
    expect(ta).not.toBe(-1);
    expect(isCrease(target, ta, tb)).toBe(true);
  });

  it('drops a face whose corners round together rather than refusing', () => {
    const target = boxLattice(0.0001, 200);
    const source = boxLattice(0.0001, 200);
    // Everything to one point: nothing sensible to add, and no throw.
    const flat = (): LatticeCoord => [5000, 5000, 5000];
    expect(mergeLattice(target, source, flat)).toBe(0);
    expect(latticeStats(target).faces).toBe(6);
  });
});
