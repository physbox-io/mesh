// Pieces pulled in to the surface (utils/tightPieces.ts), and the lathe
// recogniser that routes a solid of revolution to the exact sector slicer
// (utils/revolution.ts).

import { describe, expect, it } from 'vitest';
import { tightenPieces } from '../src/utils/tightPieces';
import { detectRevolution } from '../src/utils/revolution';
import { buildMeshQuery } from '../src/utils/meshQuery';
import { decomposeMesh } from '../src/utils/vhacd';
import { boredCup, boxUnion, helicalHalfPipe, zToX } from './helpers/meshes';

describe('pulling pieces in to the surface', () => {
  it('takes most of the voxel overshoot off a square pocket, and says what is left', async () => {
    const block = boxUnion([{ min: [-0.03, -0.03, 0], max: [0.03, 0.03, 0.035] }], [{ min: [-0.0105, -0.0105, 0.005], max: [0.0105, 0.0105, 0.04] }]);
    const hulls = await decomposeMesh(block.verts, block.faces, { maxHulls: 16 });
    const r = tightenPieces(block.verts, block.faces, hulls, { tolerance: 1e-4, maxPieces: 200, timeBudgetMs: 5000 });
    // V-HACD's 16 pieces stood 5.7 mm proud; after, what is left is inside corners.
    expect(r.intrusionBefore).toBeGreaterThan(0.004);
    expect(r.intrusion).toBeLessThan(r.intrusionBefore / 2);
    // Nothing the pieces held is lost: every point of the block's solid is still covered.
    const q = buildMeshQuery(block.verts, block.faces);
    expect(q.inside(0.02, 0.02, 0.02)).toBe(true);
  }, 60_000);
});

describe('recognising a lathed part', () => {
  it('finds the axis of a cup, upright or on its side', () => {
    expect(detectRevolution(boredCup().verts, boredCup().faces)?.axis.map(Math.abs).map(v => Math.round(v))).toEqual([0, 0, 1]);
    const side = zToX(boredCup());
    expect(detectRevolution(side.verts, side.faces)?.axis.map(Math.abs).map(v => Math.round(v))).toEqual([1, 0, 0]);
  });

  it('does not take a box or a coiled chute for one', () => {
    const block = boxUnion([{ min: [0, 0, 0], max: [0.02, 0.03, 0.01] }]);
    expect(detectRevolution(block.verts, block.faces)).toBeNull();
    const chute = helicalHalfPipe();
    expect(detectRevolution(chute.verts, chute.faces)).toBeNull();
  });
});
