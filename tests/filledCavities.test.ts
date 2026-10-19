import { describe, it, expect } from 'vitest';
import { findFilledCavities } from '../src/utils/filledCavities';
import { convexHullOf } from '../src/utils/csg';
import { decomposeMesh } from '../src/utils/vhacd';
import { cupMesh } from './helpers/meshes';

const cup = cupMesh({ outerR: 0.10, innerR: 0.08, height: 0.12, baseThickness: 0.02 });
const points = (v: number[]) => Array.from({ length: v.length / 3 }, (_, i) => [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]]);

describe('finding cavities the colliders filled in', () => {
  it('finds a cup filled solid by one hull, where it is and how big', () => {
    const hull = convexHullOf(points(cup.verts))!;
    const found = findFilledCavities(cup.verts, cup.faces, [hull]);
    expect(found.length).toBe(1);
    const [c] = found;
    // The inside of the cup: 80 mm radius, from the 20 mm base to the 120 mm rim.
    const inner = Math.PI * 80 * 80 * 100;
    expect(c.volumeMm3).toBeGreaterThan(inner * 0.8);
    expect(c.volumeMm3).toBeLessThan(inner * 1.2);
    expect(c.centerMm[0]).toBeCloseTo(0, -1);
    expect(c.centerMm[2]).toBeGreaterThan(50);
    expect(c.centerMm[2]).toBeLessThan(90);
    expect(c.coveredBy).toBe(0);
  });

  it('reports nothing for a decomposition that kept the cavity open', async () => {
    const hulls = await decomposeMesh(cup.verts, cup.faces);
    const found = findFilledCavities(cup.verts, cup.faces, hulls);
    // The hulls bulge into the walls a little everywhere; none of that is a
    // filled cavity, and nothing near the middle of the cup may be.
    const big = found.filter((c) => c.volumeMm3 > 0.05 * Math.PI * 80 * 80 * 100);
    expect(big).toEqual([]);
  }, 60_000);
});
