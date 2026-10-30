// Pieces pulled in to the surface (utils/tightPieces.ts), and the lathe
// recogniser that routes a solid of revolution to the exact sector slicer
// (utils/revolution.ts).

import { describe, expect, it } from 'vitest';
import { tightenPieces } from '../src/utils/tightPieces';
import { detectRevolution } from '../src/utils/revolution';
import { buildMeshQuery } from '../src/utils/meshQuery';
import { decomposeMesh } from '../src/utils/vhacd';
import { decomposeNodeColliders } from '../src/utils/convexDecomposition';
import { buildSculptBaseSized } from '../src/utils/sculptBases';
import { applySculptStroke } from '../src/utils/sculptCommands';
import { recomputeNormals, toSceneGeom } from '../src/utils/sculptMesh';
import type { SceneNode } from '../src/types/scene';
import { boredCup, boxMesh, boxUnion, helicalHalfPipe, zToX } from './helpers/meshes';

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

  // A sculpt is stored in single precision: its 50 mm cube's flat bottom sat
  // at z = -25.00000037 mm, while V-HACD's box over the lower half stopped at
  // exactly -25. Every face of that box lay a few tenths of a nanometre
  // outside the mesh's faces and was clipped away, its corners on the sides
  // read as outside, and the box was dropped as holding nothing: the body had
  // no pieces under its lower half and sank 27 mm into the floor.
  const carvedCube = () => {
    const mesh = buildSculptBaseSized('cube', 0.05);
    recomputeNormals(mesh);
    // physics_sculpt's repro: an 18 mm dent pressed into the top.
    applySculptStroke(mesh, {
      brush: 'draw', invert: true, depthMm: 18, radius: 0.014, hardness: 0.8, strength: 1,
      at: [[0, 0, 0.025], [0.005, 0, 0.025], [-0.005, 0, 0.025], [0, 0.005, 0.025], [0, -0.005, 0.025]],
    });
    return toSceneGeom(mesh);
  };

  it('keeps a piece whose faces lie on the mesh\'s own, in single precision', () => {
    const cube = carvedCube();
    // The box V-HACD made over the lower half, to the digit.
    const lower = boxMesh([0, 0, -0.012253], [0.025, 0.025, 0.012747]);
    // And one beside the dent that rebuilds as it should, so a lost piece
    // cannot hide behind tightenPieces handing back its input untouched.
    const corner = boxMesh([0.02, 0.02, 0.01], [0.004, 0.004, 0.01]);
    const r = tightenPieces(cube.renderVertices, cube.faces, [
      { ...lower, volume: 0.05 * 0.05 * 0.025494, centroid: [0, 0, -0.012253] },
      { ...corner, volume: 0.008 * 0.008 * 0.02, centroid: [0.02, 0.02, 0.01] },
    ], { tolerance: 1e-4, maxPieces: 2 });
    expect(r.hulls).toHaveLength(2);
    const zs = r.hulls.flatMap(h => h.verts.filter((_, i) => i % 3 === 2));
    expect(Math.min(...zs)).toBeLessThan(-0.0249);
  });

  it('leaves a carved sculpt cube with pieces under its lower half', async () => {
    const node: SceneNode = {
      id: 'blob', name: 'blob', type: 'body', pos: [0, 0, 0.1], children: [],
      joints: [{ name: 'blob_free', type: 'free' }],
      geoms: [{ name: 'blob_m', type: 'mesh', size: [1], dynamic: true, ...carvedCube() }],
    };
    const r = (await decomposeNodeColliders(node))!;
    expect(r.geoms.length).toBeGreaterThan(1);
    const zs = r.geoms.flatMap(g => {
      const out: number[] = [];
      // Y-up local vertices about pos: Z-up z is y + pos[2].
      for (let i = 1; i < g.vertices!.length; i += 3) out.push(g.vertices![i] + g.pos![2]);
      return out;
    });
    // Down to the cube's floor, not stopping at +1.8 mm as before.
    expect(Math.min(...zs)).toBeLessThan(-0.0245);
  }, 120_000);
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
