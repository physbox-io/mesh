// The lathe builder's winding, which nothing exercised until a vase needed it.
//
// A mesh with inward normals does not look broken in this app — it looks
// half-transparent, because mesh geoms are drawn single-sided. So the sign of
// the signed volume is the assertion that matters, and it is worth more than
// any number of assertions about face counts.

import { describe, it, expect } from 'vitest';
import { buildSolidLathe } from '../src/utils/lathe';
import { analyzeMesh } from '../src/utils/meshIntegrity';

describe('buildSolidLathe', () => {
  it('winds its faces outward, so the shell is not drawn inside out', () => {
    const { vertices, faces } = buildSolidLathe(() => 0.05, 0.2, 48, 8, 0.2);
    const { volume } = analyzeMesh(vertices, faces);
    expect(volume).toBeGreaterThan(0);
  });

  it('encloses the volume the profile describes', () => {
    // A straight profile is a tube: pi * (R^2 - r^2) * h, exactly computable.
    const R = 0.05, ratio = 0.2, h = 0.2;
    const { vertices, faces } = buildSolidLathe(() => R, h, 256, 8, ratio);
    const analytic = Math.PI * (R ** 2 - (R * (1 - ratio)) ** 2) * h;
    const { volume } = analyzeMesh(vertices, faces);
    // 256 slices is within a fraction of a percent of the true circle.
    expect(volume).toBeCloseTo(analytic, 6);
  });

  it('closes its seam, so the shell is watertight', () => {
    // A ring that ends in a duplicate of its own first vertex leaves the seam
    // unstitched: the mesh looks right and is full of boundary edges, which is
    // the sort of thing only an exporter or a physics engine complains about.
    const { vertices, faces } = buildSolidLathe(() => 0.05, 0.2, 24, 12, 0.2);
    const report = analyzeMesh(vertices, faces);
    expect(report.boundaryEdges).toBe(0);
    expect(report.closed).toBe(true);
    expect(report.nonManifoldEdges).toBe(0);
  });

  it('stays consistently wound, which is what makes the sign meaningful', () => {
    const { vertices, faces } = buildSolidLathe((z) => 0.04 + 0.02 * Math.sin(z * 10), 0.3, 32, 24, 0.25);
    const report = analyzeMesh(vertices, faces);
    expect(report.consistentlyWound).toBe(true);
    expect(report.volume).toBeGreaterThan(0);
    expect(report.degenerateTriangles).toBe(0);
  });
});
