// Flat-walled concavities cut exactly along their inside corners
// (utils/reflexCuts.ts), before V-HACD sees them.
//
// A 60 mm block with a 21 mm square pocket came out of V-HACD and the planar
// cuts in tightPieces.ts as 66 pieces still standing 4.8 mm proud into the
// pocket, and a 20 mm square peg with 0.5 mm clearance stopped 16 mm above
// the floor. Cut along the planes of its reflex edges it is 5 boxes, exactly
// the block, and the peg goes to the floor.

import { afterAll, describe, expect, it } from 'vitest';
import { cutAtReflexEdges, reflexEdges } from '../src/utils/reflexCuts';
import { decomposeSolid } from '../src/utils/solidDecomposition';
import { decomposeNodeColliders } from '../src/utils/convexDecomposition';
import { loadManifold } from '../src/utils/sculptCut';
import { fromManifold } from '../src/utils/chunkedDecomposition';
import type { SceneGeom, SceneNode } from '../src/types/scene';
import { boxMesh, boxUnion, signedVolume, uChannelTrack, zupToYupFlat, type MeshData } from './helpers/meshes';
import { simulate, type Sim } from './helpers/simulate';

/** 60 x 60 x 35 mm, a 21 x 21 mm pocket 30 mm deep: a 5 mm floor. */
const pocketBlock = () => boxUnion([{ min: [-0.03, -0.03, 0], max: [0.03, 0.03, 0.035] }], [{ min: [-0.0105, -0.0105, 0.005], max: [0.0105, 0.0105, 0.04] }]);

const meshNode = (id: string, m: MeshData, extra: Partial<SceneNode> = {}, geom: Partial<SceneGeom> = {}): SceneNode => ({
  id, name: id, type: 'body', pos: [0, 0, 0], joints: [], children: [],
  geoms: [{ name: `${id}_m`, type: 'mesh', size: [1], dynamic: true, renderVertices: m.verts, vertices: zupToYupFlat(m.verts), faces: m.faces, ...geom }],
  ...extra,
});

const volumeOf = (cells: { verts: number[]; faces: number[] }[]) => cells.reduce((v, c) => v + signedVolume(c), 0);

const sims: Sim[] = [];
afterAll(() => { for (const s of sims) s.dispose(); });

describe('cutting along inside corners', () => {
  it('cuts a square pocket into five boxes that are exactly the block', async () => {
    const block = pocketBlock();
    const cut = cutAtReflexEdges(await loadManifold(), block.verts, block.faces, 128)!;
    expect(cut.rest).toEqual([]);
    // The floor, then a plane through two walls' corners at a time.
    expect(cut.convex).toHaveLength(5);
    for (const c of cut.convex) expect(reflexEdges(c)).toEqual([]);
    expect(volumeOf(cut.convex)).toBeCloseTo(signedVolume(block), 12);
  });

  it('opens a sealed hollow rather than filling it', async () => {
    // Decomposed into shells, a closed box's hollow is a shell of its own; left
    // out, the box read as one convex cube.
    const box = boxUnion([{ min: [0, 0, 0], max: [0.06, 0.06, 0.06] }], [{ min: [0.005, 0.005, 0.005], max: [0.055, 0.055, 0.055] }]);
    const cut = cutAtReflexEdges(await loadManifold(), box.verts, box.faces, 128)!;
    expect(cut.convex.length).toBeGreaterThan(5);
    expect(volumeOf(cut.convex)).toBeCloseTo(signedVolume(box), 12);
  });

  it('takes boxes listed together in one mesh as they are', async () => {
    const a = boxMesh([0, 0, 0.005], [0.03, 0.03, 0.005]), b = boxMesh([0.025, 0, 0.03], [0.005, 0.03, 0.02]);
    const both = { verts: [...a.verts, ...b.verts], faces: [...a.faces, ...b.faces.map(i => i + a.verts.length / 3)] };
    const cut = cutAtReflexEdges(await loadManifold(), both.verts, both.faces, 128)!;
    expect(cut.convex).toHaveLength(2);
  });

  it('cuts a part with a pocket and a round bore at its corners, and hands back only the curved cells', async () => {
    const w = await loadManifold();
    const M = w.Manifold;
    const part = M.cube([80, 40, 35]).translate([-40, -20, 0])
      .subtract(M.cube([21, 21, 40]).translate([-27.5, -10.5, 5]))
      .subtract(M.cylinder(40, 10.5, 10.5, 64).translate([17, 0, 5]));
    const m = fromManifold(part);
    part.delete();
    const cut = cutAtReflexEdges(w, m.verts, m.faces, 128)!;
    expect(cut.convex.length).toBeGreaterThan(2);
    expect(cut.rest.length).toBeGreaterThan(0);
    // The bore's facets turn 5.6° each: left for V-HACD. Every rest cell is
    // on the bore's side of the pocket's wall at x = -6.5 mm.
    for (const c of cut.rest) {
      for (let i = 0; i < c.verts.length; i += 3) expect(c.verts[i]).toBeGreaterThan(-0.0065 - 1e-6);
    }
    expect(volumeOf([...cut.convex, ...cut.rest])).toBeCloseTo(signedVolume(m), 12);
  });

  it('gives up on a swept channel cut into more cells than it may make', async () => {
    const track = uChannelTrack();
    // Its walls are flat across the track, so it is three cells; held to two it gives up.
    expect(cutAtReflexEdges(await loadManifold(), track.verts, track.faces, 2)).toBeNull();
  });
});

describe('a square peg in a square pocket', () => {
  it('decomposes the same way every time', async () => {
    const block = pocketBlock();
    const once = await decomposeSolid(block.verts, block.faces, { maxPieces: 512 });
    const again = await decomposeSolid(block.verts, block.faces, { maxPieces: 512 });
    expect(again.hulls.map(h => h.verts)).toEqual(once.hulls.map(h => h.verts));
    expect(once.hulls).toHaveLength(5);
    expect(once.intrusion).toBeLessThan(1e-5);
  });

  it('reaches the floor at 0.5 mm clearance, as a box and as a mesh', async () => {
    const block = meshNode('block', pocketBlock());
    const r = (await decomposeNodeColliders(block))!;
    // Nothing narrowed, so nothing said.
    expect(r.intrusion).toBeUndefined();
    const placed = { ...block, geoms: [...block.geoms!, ...r.geoms], collisionHash: r.hash, collisionDecomposed: true };
    const box: SceneNode = {
      id: 'peg', name: 'peg', type: 'body', pos: [0, 0, 0.045], children: [], joints: [{ name: 'peg_free', type: 'free' }],
      geoms: [{ name: 'peg_g', type: 'box', size: [0.01, 0.01, 0.025], density: 1200 }],
    };
    const mesh = meshNode('peg', boxMesh([0, 0, 0], [0.01, 0.01, 0.025]), {
      pos: [0, 0, 0.045], joints: [{ name: 'peg_free', type: 'free' }],
    }, { density: 1200 });
    for (const peg of [box, mesh]) {
      const sim = await simulate({ nodes: [placed, peg] } as never);
      sims.push(sim);
      sim.run(2);
      // The peg's centre is 25 mm above its foot; the floor is at 5 mm. It stopped 16 mm up.
      expect(Math.abs(sim.bodyPos('peg')[2] - 0.025 - 0.005)).toBeLessThan(0.0005);
    }
  }, 60_000);
});
