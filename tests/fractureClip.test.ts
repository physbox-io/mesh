// Shattering a concave body gives pieces of the body, not of its hull.
//
// A lattice chair (seat, four legs, a back) set to shatter into 10 pieces
// broke into shards that tiled its CONVEX HULL: the air between and under the
// legs became solid shards and it settled as a brick.

import { describe, it, expect, beforeAll } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../src/utils/sculptCut';
import { fractureSolid, insideMesh } from '../src/utils/fractureClip';
import { fractureMesh } from '../src/utils/fracture';
import { convexHullOf } from '../src/utils/csg';
import { buildShatterGraph } from '../src/utils/runtimeShatter';
import { boxLattice, createLattice, deserializeCage, serializeCage, toSceneGeom, DEFAULT_UNIT } from '../src/utils/latticeMesh';
import { runLatticeOps } from '../src/hooks/mcp/latticeState';
import type { SceneNode } from '../src/types/scene';

type P = [number, number, number];
function box(min: P, max: P): P[][] {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return [
    [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]],
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
    [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
    [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]],
    [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]],
    [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]],
  ];
}

/** The chair from the report, as one fused cage, in metres (Z-up). */
function chair() {
  const lattice = createLattice(DEFAULT_UNIT);
  runLatticeOps(lattice, [{
    op: 'faces',
    faces: [
      ...box([-180, -180, 410], [180, 180, 440]),
      ...box([-180, -180, 0], [-150, -150, 410]),
      ...box([150, -180, 0], [180, -150, 410]),
      ...box([-180, 150, 0], [-150, 180, 410]),
      ...box([150, 150, 0], [180, 180, 410]),
      ...box([-180, 150, 440], [180, 180, 840]),
    ],
  }]);
  const { renderVertices, faces, origin } = toSceneGeom(deserializeCage(serializeCage(lattice)), 0, 0);
  // Back in the cage's own frame: the mesh comes centred on its centre of mass.
  return { verts: renderVertices.map((v, i) => v + origin[i % 3]), faces };
}

const TRUE_VOLUME = (360 * 360 * 30 + 4 * 30 * 30 * 410 + 360 * 30 * 400) * 1e-9;

let wasm: ManifoldToplevel;
beforeAll(async () => { wasm = await loadManifold(); });

describe('fractureSolid', () => {
  it('cuts a chair into pieces of chair', () => {
    const { verts, faces } = chair();
    const shards = fractureSolid(wasm, verts, faces, { pieces: 10, seed: 3 });
    expect(shards.length).toBeGreaterThanOrEqual(2);
    const total = shards.reduce((s, c) => s + c.volume, 0);
    // The material, all of it, and none of the air.
    expect(total / TRUE_VOLUME).toBeCloseTo(1, 2);
    // Every shard's middle is in the chair, or at least its piece of it is:
    // no shard lies wholly in the space under the seat between the legs.
    for (const shard of shards) {
      const touchesMaterial = Array.from({ length: shard.verts.length / 3 }, (_, i) => [
        shard.verts[i * 3], shard.verts[i * 3 + 1], shard.verts[i * 3 + 2],
      ]).every(([x, y, z]) => !(Math.abs(x) < 0.14 && Math.abs(y) < 0.14 && z > 0.01 && z < 0.4));
      expect(touchesMaterial).toBe(true);
    }
    // What the hull's cells weighed, for comparison: several chairs' worth.
    const hullCells = fractureMesh(verts, faces, { pieces: 10, seed: 3 });
    expect(hullCells.reduce((s, c) => s + c.volume, 0)).toBeGreaterThan(5 * TRUE_VOLUME);
  });

  it('shares out exactly the body mass among them', () => {
    const { verts, faces } = chair();
    const cells = fractureSolid(wasm, verts, faces, { pieces: 10, seed: 3 });
    const node = { id: 'chair', name: 'chair', type: 'body', pos: [0, 0, 1], joints: [{ name: 'chair_free', type: 'free' }], children: [], geoms: [] } as unknown as SceneNode;
    const { shards } = buildShatterGraph(node, verts, faces, cells, {
      pos: [0, 0, 1], xmat: [1, 0, 0, 0, 1, 0, 0, 0, 1], vel: [0, 0, 0], angvel: [0, 0, 0],
    }, { totalMass: 9.684 });
    const mass = shards.reduce((s, n) => s + (n.geoms[0].mass ?? 0), 0);
    expect(mass).toBeCloseTo(9.684, 9);
  });

  it('leaves a convex body to the exact hull cells', () => {
    const { renderVertices, faces } = toSceneGeom(boxLattice(DEFAULT_UNIT, 200), 0, 0);
    const shards = fractureSolid(wasm, renderVertices, faces, { pieces: 6, seed: 1 });
    const exact = fractureMesh(renderVertices, faces, { pieces: 6, seed: 1 });
    expect(shards.length).toBe(exact.length);
    const hull = convexHullOf(Array.from({ length: renderVertices.length / 3 }, (_, i) => renderVertices.slice(i * 3, i * 3 + 3)))!;
    expect(shards.reduce((s, c) => s + c.volume, 0) / hull.volume).toBeCloseTo(1, 6);
  });

  it('tells inside from outside', () => {
    const { verts, faces } = chair();
    expect(insideMesh(verts, faces, [0, 0, 0.425])).toBe(true); // in the seat
    expect(insideMesh(verts, faces, [0, 0, 0.2])).toBe(false); // under it
    expect(insideMesh(verts, faces, [0.165, 0.165, 0.2])).toBe(true); // in a leg
  });
});

describe('the mass a decomposed body breaks with', () => {
  it('counts its mesh once, not again in its convex pieces', async () => {
    const { estimateBodyMass } = await import('../src/utils/deformMaterials');
    const { verts, faces } = chair();
    const node = {
      id: 'chair', name: 'chair', type: 'body', pos: [0, 0, 1], joints: [], children: [],
      geoms: [
        { name: 'chair_mesh', type: 'mesh', size: [1], renderVertices: verts, faces },
        { name: 'chair_piece0', type: 'mesh', size: [1], csgDerived: 'collider', mass: 5, renderVertices: verts, faces },
        { name: 'chair_piece1', type: 'mesh', size: [1], csgDerived: 'collider', mass: 4.684, renderVertices: verts, faces },
      ],
    } as unknown as SceneNode;
    expect(estimateBodyMass(node)).toBeCloseTo(TRUE_VOLUME * 1000, 6);
    expect(estimateBodyMass({ ...node, collisionMass: 3 } as SceneNode)).toBeCloseTo(3, 9);
  });
});
