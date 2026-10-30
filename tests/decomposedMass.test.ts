// What a decomposed body weighs, and where: the true solid, not its pieces.
//
// The pieces overlap one another and stand proud of the surface or short of
// it, and a body weighed by them put its centre of mass wherever they leaned:
// a symmetric cup's came out 0.9 mm off its axis, a paraboloid bowl's 0.25 mm
// off and 0.4 mm high, with unequal moments about two axes that are the same.
// The mesh the pieces stand in for now stays in the model out of contact,
// integrated exactly by MuJoCo, and carries the mass (csg.ts
// demoteDecomposedGeom).
//
// And a cup widened to r50/46 mm: a ball dropped on the middle of its floor
// stays there.

import { afterAll, describe, expect, it } from 'vitest';
import { decomposeNodeColliders } from '../src/utils/convexDecomposition';
import { meshVolumeAndCentroid } from '../src/utils/csg';
import type { SceneNode } from '../src/types/scene';
import { paraboloidBowl, zupToYupFlat, type MeshData } from './helpers/meshes';
import { simulate, type Sim } from './helpers/simulate';

const sims: Sim[] = [];
afterAll(() => { for (const s of sims) s.dispose(); });

const meshNode = (id: string, m: MeshData, extra: Partial<SceneNode> = {}): SceneNode => ({
  id, name: id, type: 'body', pos: [0, 0, 0], joints: [], children: [],
  geoms: [{ name: `${id}_m`, type: 'mesh', size: [1], dynamic: true, renderVertices: m.verts, vertices: zupToYupFlat(m.verts), faces: m.faces }],
  ...extra,
});

async function decomposed(node: SceneNode): Promise<SceneNode> {
  const r = (await decomposeNodeColliders(node))!;
  expect(r.geoms.length).toBeGreaterThan(1);
  return { ...node, geoms: [...node.geoms!, ...r.geoms], collisionHash: r.hash, collisionDecomposed: true };
}

describe('a decomposed body\'s mass', () => {
  it('sits where the solid\'s does, with the solid\'s inertia', async () => {
    // A free body: 64 V-HACD pieces, which overlap and lean.
    const bowl = paraboloidBowl(0.03);
    const node = await decomposed(meshNode('bowl', bowl, { pos: [0, 0, 0.1], joints: [{ name: 'bowl_free', type: 'free' }] }));
    const sim = await simulate({ nodes: [node] } as never);
    sims.push(sim);
    const b = sim.bodyId('bowl');
    const truth = meshVolumeAndCentroid(bowl.verts, bowl.faces);
    expect(sim.model.body_mass[b]).toBeCloseTo(1000 * truth.volume, 6);
    // On its axis to the micron, not 0.25 mm off it.
    for (let k = 0; k < 3; k++) expect(sim.model.body_ipos[b * 3 + k]).toBeCloseTo(truth.centroid[k], 6);
    // The two moments across the axis are one moment.
    const I = [0, 1, 2].map(k => sim.model.body_inertia[b * 3 + k]).sort((p, q) => p - q);
    expect(Math.abs(I[1] - I[0]) / I[1]).toBeLessThan(1e-6);
  }, 60_000);
});

describe('a ball dropped on the middle of a widened cup\'s floor', () => {
  it('stays in the middle', async () => {
    // r 50/46 mm, 4 mm floor, as Manifold (and so OpenSCAD) makes it: caps
    // fanned from the rim, no vertex on the axis.
    const { loadManifold } = await import('../src/utils/sculptCut');
    const { fromManifold } = await import('../src/utils/chunkedDecomposition');
    const M = (await loadManifold()).Manifold;
    const part = M.cylinder(60, 50, 50, 64).subtract(M.cylinder(60, 46, 46, 64).translate([0, 0, 4]));
    const cup = await decomposed(meshNode('cup', fromManifold(part)));
    part.delete();
    const ball: SceneNode = {
      id: 'ball', name: 'ball', type: 'body', pos: [0, 0, 0.05], children: [],
      joints: [{ name: 'ball_free', type: 'free' }],
      geoms: [{ name: 'ball_g', type: 'sphere', size: [0.008], mass: 0.02 }],
    };
    const sim = await simulate({ nodes: [cup, ball] } as never);
    sims.push(sim);
    let farthest = 0;
    for (let i = 0; i < 40; i++) {
      sim.run(0.1);
      const p = sim.bodyPos('ball');
      farthest = Math.max(farthest, Math.hypot(p[0], p[1]));
    }
    // It rolled 29 mm to the wall on a floor whose pieces stood proud there.
    expect(farthest).toBeLessThan(0.001);
    expect(sim.bodyPos('ball')[2]).toBeCloseTo(0.004 + 0.008, 3);
  }, 60_000);
});
