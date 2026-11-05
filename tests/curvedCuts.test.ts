// Holes that have to work as holes, whatever makes them and however small
// they are next to the part. Each of these failed on the default pipeline:
//
// * A 20 mm bore in a 60 mm block read as convex (solidity 0.92), so it was
//   solid to contact, and a 3 mm plate's bolt hole with it.
// * Big enough to be decomposed, a 22 mm bore came out 5.9 mm narrower in 68
//   V-HACD pieces, and a peg with 1 mm clearance stopped at the rim. Filleted
//   and elliptical pockets went the same way.
// * A 21.16 mm hex pocket left a micron-thick skin behind one cut, and its
//   whole part fell back to V-HACD.
// * Four nesting bowls came out upside down at the default contact.

import { afterAll, describe, expect, it } from 'vitest';
import { concaveByDepth, decomposeNodeColliders, decompositionVerdict, wallContactTime } from '../src/utils/convexDecomposition';
import { fromManifold } from '../src/utils/chunkedDecomposition';
import { concavityDepth } from '../src/utils/hullDepth';
import { convexHullOf } from '../src/utils/csg';
import { loadManifold } from '../src/utils/sculptCut';
import { compileToMJCF } from '../src/utils/mjcf';
import type { SceneGeom, SceneNode } from '../src/types/scene';
import { boxMesh, sphereMesh, zupToYupFlat, type MeshData } from './helpers/meshes';
import { paraboloidBowl } from './helpers/sweptMeshes';
import { simulate, type Sim } from './helpers/simulate';

const sims: Sim[] = [];
afterAll(() => { for (const s of sims) s.dispose(); });

type Solid = Parameters<typeof fromManifold>[0];
const toMesh = (m: Solid): MeshData => { const r = fromManifold(m); m.delete(); return r; };

const meshNode = (id: string, m: MeshData, extra: Partial<SceneNode> = {}, geom: Partial<SceneGeom> = {}): SceneNode => ({
  id, name: id, type: 'body', pos: [0, 0, 0], joints: [], children: [],
  geoms: [{ name: `${id}_m`, type: 'mesh', size: [1], dynamic: true, renderVertices: m.verts, vertices: zupToYupFlat(m.verts), faces: m.faces, ...geom }],
  ...extra,
});

async function decomposed(node: SceneNode): Promise<SceneNode> {
  const r = (await decomposeNodeColliders(node))!;
  return { ...node, geoms: [...node.geoms!, ...r.geoms], collisionHash: r.hash, collisionDecomposed: true };
}

const hullDepthOf = (m: MeshData) => {
  const pts: number[][] = [];
  for (let i = 0; i < m.verts.length; i += 3) pts.push([m.verts[i], m.verts[i + 1], m.verts[i + 2]]);
  return concavityDepth(m.verts, m.faces, convexHullOf(pts)!);
};

/** Drops `peg` from above a 60 x 60 x 40 mm block; how far its foot stops above the pocket's 5 mm floor, mm. */
async function pegAboveFloor(block: MeshData, peg: MeshData): Promise<number> {
  const b = await decomposed(meshNode('block', block));
  const p = meshNode('peg', peg, { pos: [0, 0, 0.046], joints: [{ name: 'peg_free', type: 'free' }] }, { density: 1200 });
  const sim = await simulate({ nodes: [b, p] } as never);
  sims.push(sim);
  sim.run(2.5);
  return sim.bodyPos('peg')[2] * 1000 - 5;
}

describe('a peg in a pocket of any section', () => {
  it('reaches the floor of a bore too small to move the solidity', async () => {
    const { Manifold: M } = await loadManifold();
    const block = M.cube([60, 60, 40]).translate([-30, -30, 0]).subtract(M.cylinder(40, 10.2, 10.2, 64).translate([5, 0, 5]));
    expect(await pegAboveFloor(toMesh(block), toMesh(M.cylinder(30, 10, 10, 64).translate([5, 0, 0])))).toBeLessThan(0.5);
  }, 60_000);

  it('reaches the floor of a bore, a filleted pocket and an ellipse at 0.5 mm clearance', async () => {
    const W = await loadManifold();
    const { Manifold: M, CrossSection: CS } = W;
    const block = () => M.cube([60, 60, 40]).translate([-30, -30, 0]);
    const square = (s: number, r: number) => new CS([[-s + r, -s + r], [s - r, -s + r], [s - r, s - r], [-s + r, s - r]]).offset(r, 'Round', 2, 64);
    const ellipse = (a: number, b: number) => new CS(Array.from({ length: 64 }, (_, i) => [a * Math.cos((i * Math.PI) / 32), b * Math.sin((i * Math.PI) / 32)] as [number, number]));
    const cases: [Solid, Solid][] = [
      [M.cylinder(40, 10.5, 10.5, 64).translate([5, 0, 5]), M.cylinder(30, 10, 10, 64).translate([5, 0, 0])],
      [square(10.5, 3).extrude(40).translate([0, 0, 5]), square(10, 2.5).extrude(30)],
      [ellipse(14.5, 9.5).extrude(40).translate([0, 0, 5]), ellipse(14, 9).extrude(30)],
    ];
    for (const [pocket, peg] of cases) {
      expect(await pegAboveFloor(toMesh(block().subtract(pocket)), toMesh(peg))).toBeLessThan(0.5);
    }
  }, 120_000);

  it('cuts a bore exactly: under 0.1 mm proud, in a few dozen pieces', async () => {
    const { Manifold: M } = await loadManifold();
    const r = (await decomposeNodeColliders(meshNode('block', toMesh(M.cube([60, 60, 40]).translate([-30, -30, 0]).subtract(M.cylinder(40, 11, 11, 64).translate([5, 0, 5]))))))!;
    expect(r.geoms.length).toBeLessThan(64);
    expect(r.intrusion?.mm ?? 0).toBeLessThanOrEqual(0.1);
  }, 60_000);

  it('survives a corner cut that leaves a skin over a hex pocket', async () => {
    const W = await loadManifold();
    const { Manifold: M, CrossSection: CS } = W;
    const hex = (r: number) => new CS(Array.from({ length: 6 }, (_, i) => [r * Math.cos((i * Math.PI) / 3), r * Math.sin((i * Math.PI) / 3)] as [number, number]));
    // 10.5775: the size that left the skin. 10 + 0.5 x 1.155.
    const block = M.cube([60, 60, 40]).translate([-30, -30, 0]).subtract(hex(10.5775).extrude(40).translate([0, 0, 5]));
    const r = (await decomposeNodeColliders(meshNode('block', toMesh(block))))!;
    expect(r.geoms.length).toBeLessThan(16);
    expect(r.intrusion).toBeUndefined();
  }, 60_000);

  it('goes through a bolt hole in a 3 mm plate', async () => {
    const { Manifold: M } = await loadManifold();
    const plate = M.cube([100, 100, 3]).translate([-50, -50, 0]).subtract(M.cylinder(10, 2.5, 2.5, 32).translate([0, 0, -3]));
    const b = await decomposed(meshNode('plate', toMesh(plate), { pos: [0, 0, 0.02] }));
    const p = meshNode('pin', toMesh(M.cylinder(12, 2, 2, 32)), { pos: [0, 0, 0.03], joints: [{ name: 'pin_free', type: 'free' }] }, { density: 1200 });
    const sim = await simulate({ nodes: [b, p] } as never);
    sims.push(sim);
    sim.run(1);
    // Foot on the world floor, 20 mm under the plate. It used to stand on top.
    expect(sim.bodyPos('pin')[2]).toBeLessThan(0.002);
  }, 60_000);
});

describe('deciding that a part has a hole', () => {
  it('measures a through bore, which no vertex shows, and nothing on a sphere', async () => {
    const { Manifold: M } = await loadManifold();
    const block = toMesh(M.cube([60, 60, 40]).translate([-30, -30, 0]).subtract(M.cylinder(40, 5, 5, 32)));
    expect(hullDepthOf(block)).toBeGreaterThan(0.015);
    expect(hullDepthOf(sphereMesh())).toBeLessThan(1e-6);
    expect(hullDepthOf(boxMesh())).toBeLessThan(1e-6);
  });

  it('goes by depth at 1 mm or a hundredth of the part', () => {
    expect(concaveByDepth(0.0015, 0.1)).toBe(true);
    expect(concaveByDepth(0.0009, 0.05)).toBe(false);
    expect(concaveByDepth(0.002, 0.4)).toBe(false);
  });

  it('takes no hole from overlapping shells, whatever lies inside their hull', () => {
    const node = meshNode('foliage', sphereMesh());
    const v = decompositionVerdict(node, { volume: 1.4, hullVolume: 1, triangles: 500, concavityDepth: 0.5, size: 3 });
    expect(v.strategy).toBe('hull');
    expect(decompositionVerdict(node, { volume: 0.98, hullVolume: 1, triangles: 500, concavityDepth: 0.5, size: 3 }).strategy).toBe('decompose');
  });
});

describe('contact on a thin wall', () => {
  it('stops a landing inside the wall, and leaves a thick part at the default', () => {
    expect(wallContactTime(0.004)).toBe(0.004);
    expect(wallContactTime(0.0005)).toBe(0.002);
    expect(wallContactTime(0.03)).toBeUndefined();
  });

  const bowls = async (geom: Partial<SceneGeom> = {}) => {
    const out: SceneNode[] = [];
    for (const [i, h] of [0.055, 0.045, 0.035, 0.025].entries()) {
      out.push(await decomposed(meshNode(`bowl${i}`, paraboloidBowl(h), { pos: [0, 0, 0.002 + 0.024 * i], joints: [{ name: `bowl${i}_free`, type: 'free' }] }, { density: 1200, ...geom })));
    }
    return out;
  };

  it('stacks nesting bowls in order at the default settings', async () => {
    const nodes = await bowls();
    const sim = await simulate({ nodes } as never);
    sims.push(sim);
    sim.run(2);
    const z = nodes.map(n => sim.bodyPos(n.name)[2]);
    for (let i = 1; i < z.length; i++) expect(z[i]).toBeGreaterThan(z[i - 1] + 0.003);
  }, 180_000);

  it('gives way to a solref asked for, and to print fidelity', async () => {
    const [own] = await bowls({ solref: [0.01, 1] });
    expect(own.geoms!.some(g => g.wallContactTime)).toBe(false);
    const [bowl] = await bowls();
    const contact = (simFidelity?: string) => (compileToMJCF({ nodes: [bowl], simFidelity } as never) as string).match(/<geom[^>]*_csg_col0"[^>]*/)![0];
    // These walls measure 2.7 mm square to the surface.
    expect(contact()).toMatch(/solref="0\.002[0-9]* 1"/);
    expect(contact('print')).not.toContain('solref');
  }, 180_000);
});
