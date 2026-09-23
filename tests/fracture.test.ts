// Do the shards add back up to the thing that broke?
//
// That is the whole claim this module makes over the convex decomposition the
// app already had: V-HACD's hulls overlap, so shards cut from them weigh more
// than the body did and start out interpenetrating. Voronoi cells of a convex
// hull tile it exactly, and these tests are what holds that to account.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FRACTURE_PIECES, MAX_FRACTURE_PIECES, clampPieces, fractureFidelity,
  fractureMesh, seedPoints, voronoiCells,
} from '../src/utils/fracture';
import { convexHullOf, meshVolumeAndCentroid } from '../src/utils/csg';
import { boxMesh } from './helpers/meshes';

const box = (half = 0.1) => {
  const m = boxMesh([0, 0, 0], [half, half, half]);
  return { verts: m.verts, faces: m.faces };
};

describe('seedPoints', () => {
  it('is deterministic for a seed, and different for a different one', () => {
    const { verts } = box();
    expect(seedPoints(verts, { pieces: 8, seed: 1 })).toEqual(seedPoints(verts, { pieces: 8, seed: 1 }));
    expect(seedPoints(verts, { pieces: 8, seed: 1 })).not.toEqual(seedPoints(verts, { pieces: 8, seed: 2 }));
  });

  it('gives the number of pieces asked for, within the range the model can carry', () => {
    const { verts } = box();
    expect(seedPoints(verts, { pieces: 12, seed: 3 })).toHaveLength(12);
    expect(seedPoints(verts, { pieces: 500, seed: 3 })).toHaveLength(MAX_FRACTURE_PIECES);
    expect(seedPoints(verts, { pieces: 1, seed: 3 })).toHaveLength(2);
  });

  it('stays inside the bounding box it was given', () => {
    const { verts } = box(0.1);
    for (const [x, y, z] of seedPoints(verts, { pieces: 16, seed: 7 })) {
      expect(Math.abs(x)).toBeLessThanOrEqual(0.1 + 1e-9);
      expect(Math.abs(y)).toBeLessThanOrEqual(0.1 + 1e-9);
      expect(Math.abs(z)).toBeLessThanOrEqual(0.1 + 1e-9);
    }
  });

  it('crowds toward an impact point when given one', () => {
    const { verts } = box(0.1);
    const focus: [number, number, number] = [0.1, 0, 0];
    const near = (pts: [number, number, number][]) =>
      pts.reduce((s, p) => s + Math.hypot(p[0] - focus[0], p[1] - focus[1], p[2] - focus[2]), 0) / pts.length;
    const spread = seedPoints(verts, { pieces: 16, seed: 5 });
    const pulled = seedPoints(verts, { pieces: 16, seed: 5, focus, focusStrength: 1 });
    expect(near(pulled)).toBeLessThan(near(spread));
  });
});

describe('clampPieces', () => {
  it('holds the range and survives nonsense', () => {
    expect(clampPieces(8)).toBe(8);
    expect(clampPieces(0)).toBe(2);
    expect(clampPieces(1000)).toBe(MAX_FRACTURE_PIECES);
    expect(clampPieces(NaN)).toBe(DEFAULT_FRACTURE_PIECES);
    expect(clampPieces(7.6)).toBe(8);
  });
});

describe('voronoiCells', () => {
  it('tiles the solid: the shards add up to what broke', () => {
    const { verts, faces } = box(0.1);
    const target = meshVolumeAndCentroid(verts, faces).volume;
    const cells = fractureMesh(verts, faces, { pieces: 12, seed: 4 });

    expect(cells.length).toBeGreaterThan(1);
    const total = cells.reduce((s, c) => s + c.volume, 0);
    // This is the assertion the whole module exists for. V-HACD would overshoot.
    expect(total).toBeCloseTo(target, 6);
    expect(fractureFidelity(cells, verts, faces)).toBeCloseTo(1, 4);
  });

  it('never makes a shard bigger than the body', () => {
    const { verts, faces } = box(0.1);
    const target = meshVolumeAndCentroid(verts, faces).volume;
    for (const c of fractureMesh(verts, faces, { pieces: 10, seed: 11 })) {
      expect(c.volume).toBeGreaterThan(0);
      expect(c.volume).toBeLessThan(target);
    }
  });

  it('keeps every shard inside the original hull', () => {
    const { verts, faces } = box(0.1);
    for (const c of fractureMesh(verts, faces, { pieces: 10, seed: 2 })) {
      for (let i = 0; i < c.verts.length; i += 3) {
        expect(Math.abs(c.verts[i])).toBeLessThanOrEqual(0.1 + 1e-6);
        expect(Math.abs(c.verts[i + 1])).toBeLessThanOrEqual(0.1 + 1e-6);
        expect(Math.abs(c.verts[i + 2])).toBeLessThanOrEqual(0.1 + 1e-6);
      }
    }
  });

  it('gives each shard a usable closed mesh', () => {
    const { verts, faces } = box(0.1);
    for (const c of fractureMesh(verts, faces, { pieces: 8, seed: 9 })) {
      expect(c.faces.length % 3).toBe(0);
      expect(c.faces.length).toBeGreaterThanOrEqual(12);
      // convexHullOf reports positive volume only for outward winding, which is
      // what the renderer needs — a backwards shard reads as half-transparent.
      expect(meshVolumeAndCentroid(c.verts, c.faces).volume).toBeGreaterThan(0);
    }
  });

  it('is reproducible, so a scene breaks the same way twice', () => {
    const { verts, faces } = box(0.1);
    const a = fractureMesh(verts, faces, { pieces: 9, seed: 42 });
    const b = fractureMesh(verts, faces, { pieces: 9, seed: 42 });
    expect(a.map((c) => c.volume)).toEqual(b.map((c) => c.volume));
  });

  it('returns the whole hull when asked for one piece', () => {
    const { verts, faces } = box(0.1);
    const cells = voronoiCells(verts, faces, [[0, 0, 0]]);
    expect(cells).toHaveLength(1);
    expect(cells[0].volume).toBeCloseTo(convexHullOf(
      Array.from({ length: verts.length / 3 }, (_, i) => [verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]] as [number, number, number]),
    )!.volume, 9);
  });

  it('refuses a degenerate body rather than making nonsense', () => {
    expect(voronoiCells([0, 0, 0, 1, 0, 0, 2, 0, 0], [0, 1, 2], [[0, 0, 0], [1, 0, 0]])).toEqual([]);
    expect(voronoiCells([], [], [[0, 0, 0]])).toEqual([]);
  });
});
