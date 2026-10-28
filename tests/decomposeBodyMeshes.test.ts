// A body with more than one mesh, or a mesh posed inside its body, broken into
// convex pieces — the shapes the fairground rides were built from.
//
// Each of these was wrong in the app: a Ferris wheel's second rim got no
// colliders, its rims' pieces lay flat at the hub because the geoms' own
// euler and pos were never applied, a decorative sleeve that collided with
// nothing was decomposed into pieces that collided with everything, and a
// carousel's canopy vanished from the physics, mass and all, because the
// platform it shared a body with had been decomposed.

import { describe, it, expect, afterAll } from 'vitest';
import { bodyFrameMesh, decomposeNodeColliders } from '../src/utils/convexDecomposition';
import { meshVolumeAndCentroid, resolveCsgGeoms } from '../src/utils/csg';
import { boxMesh, cupMesh, torusMesh, zupToYupFlat } from './helpers/meshes';
import { simulate, type Sim } from './helpers/simulate';
import type { SceneGeom, SceneNode } from '../src/types/scene';

const meshGeom = (name: string, m: { verts: number[]; faces: number[] }, extra: Partial<SceneGeom> = {}): SceneGeom => ({
  name, type: 'mesh', size: [1], dynamic: true,
  renderVertices: m.verts, vertices: zupToYupFlat(m.verts), faces: m.faces,
  ...extra,
});

const body = (geoms: SceneGeom[], extra: Partial<SceneNode> = {}): SceneNode => ({
  id: 'b', name: 'b', type: 'body', pos: [0, 0, 0], geoms, joints: [], children: [], ...extra,
});

/** Installs a result the way applyNodeColliders does. */
async function decomposed(node: SceneNode): Promise<SceneNode> {
  const result = (await decomposeNodeColliders(node))!;
  return { ...node, geoms: [...node.geoms!, ...result.geoms], collisionHash: result.hash, collisionDecomposed: result.geoms.length > 0 || undefined, collisionWarning: result.warning };
}

/** The body-frame points a collider occupies: its vertices (Y-up, centred) put back at its pos. */
const colliderPoints = (g: SceneGeom): number[][] => {
  const v = g.vertices!;
  const out: number[][] = [];
  for (let i = 0; i < v.length; i += 3) out.push([v[i] + g.pos![0], -v[i + 2] + g.pos![1], v[i + 1] + g.pos![2]]);
  return out;
};
const extentOf = (geoms: SceneGeom[]) => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const g of geoms) for (const p of colliderPoints(g)) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
  return { lo, hi };
};

// Two upright rims, as the Ferris wheel had them: tori about Z turned 90° about
// X, so they stand in the XZ plane, 60 mm apart along Y.
const rim = torusMesh(0.08, 0.006);
const wheel = () => body([
  meshGeom('rim_front', rim, { pos: [0, -0.03, 0], euler: [90, 0, 0] }),
  meshGeom('rim_back', rim, { pos: [0, 0.03, 0], euler: [90, 0, 0] }),
]);

describe('bodyFrameMesh', () => {
  it('applies the geom’s pos and euler, the way MuJoCo and the viewport place it', () => {
    const { verts } = bodyFrameMesh(meshGeom('r', rim, { pos: [0, -0.03, 0], euler: [90, 0, 0] }));
    let maxAbsY = 0, maxZ = 0;
    for (let i = 0; i < verts.length; i += 3) {
      maxAbsY = Math.max(maxAbsY, Math.abs(verts[i + 1] + 0.03));
      maxZ = Math.max(maxZ, verts[i + 2]);
    }
    // Turned upright: no wider than the tube along Y, a full ring tall in Z.
    expect(maxAbsY).toBeLessThan(0.0061);
    expect(maxZ).toBeCloseTo(0.086, 3);
  });

  it('takes a quat as MuJoCo’s [w, x, y, z], and Y-up vertices when there are no render vertices', () => {
    const half = Math.SQRT1_2;
    const q = bodyFrameMesh(meshGeom('r', rim, { quat: [half, half, 0, 0] })).verts;
    const e = bodyFrameMesh({ ...meshGeom('r', rim, { euler: [90, 0, 0] }), renderVertices: undefined }).verts;
    expect(q.length).toBe(e.length);
    for (let i = 0; i < q.length; i++) expect(q[i]).toBeCloseTo(e[i], 9);
  });
});

describe('decomposing every mesh of a body', () => {
  it('gives both rims of a wheel their own pieces, each where its rim stands', async () => {
    const node = await decomposed(wheel());
    const colliders = node.geoms!.filter(g => g.csgDerived === 'collider');
    const front = colliders.filter(g => g.colliderOf === 'rim_front');
    const back = colliders.filter(g => g.colliderOf === 'rim_back');
    expect(front.length).toBeGreaterThan(1);
    expect(back.length).toBeGreaterThan(1);
    expect(front.length + back.length).toBe(colliders.length);
    // Names run on across both, so none clash.
    expect(new Set(colliders.map(g => g.name)).size).toBe(colliders.length);

    for (const [pieces, y] of [[front, -0.03], [back, 0.03]] as const) {
      const { lo, hi } = extentOf(pieces);
      // Upright and on its own side: the tube's thickness along Y, a ring in X and Z.
      expect(lo[1]).toBeGreaterThan(y - 0.008);
      expect(hi[1]).toBeLessThan(y + 0.008);
      expect(hi[2] - lo[2]).toBeGreaterThan(0.16);
      expect(hi[0] - lo[0]).toBeGreaterThan(0.16);
    }
  }, 60_000);

  it('puts a mesh standing on a pos above the floor, not through it', async () => {
    const cup = cupMesh({ outerR: 0.03, innerR: 0.026, height: 0.17, baseThickness: 0.004, z0: -0.085 });
    const node = await decomposed(body([meshGeom('sleeve', cup, { pos: [0, 0, 0.085] })]));
    const { lo, hi } = extentOf(node.geoms!.filter(g => g.csgDerived === 'collider'));
    expect(lo[2]).toBeGreaterThan(-0.001);
    expect(hi[2]).toBeCloseTo(0.17, 2);
  }, 60_000);

  it('leaves a mesh that collides with nothing out, and still decomposes the rest', async () => {
    const node = await decomposed(body([
      meshGeom('rim_front', rim, { pos: [0, -0.03, 0], euler: [90, 0, 0] }),
      meshGeom('rim_back', rim, { pos: [0, 0.03, 0], euler: [90, 0, 0], contype: 0, conaffinity: 0 }),
    ]));
    const colliders = node.geoms!.filter(g => g.csgDerived === 'collider');
    expect(colliders.length).toBeGreaterThan(1);
    expect(colliders.every(g => g.colliderOf === 'rim_front')).toBe(true);
  }, 60_000);
});

describe('what a decomposed body keeps', () => {
  const physics = (node: SceneNode) => resolveCsgGeoms(node, 'physics');

  it('drops only the meshes its pieces stand in for', async () => {
    const node = await decomposed(body([
      meshGeom('platform', cupMesh({ outerR: 0.1, innerR: 0.09, height: 0.03, baseThickness: 0.01 })),
      // Convex: collides exactly as its own hull, so it is never decomposed.
      meshGeom('canopy', boxMesh([0, 0, 0.2], [0.1, 0.1, 0.01])),
      meshGeom('sleeve', cupMesh(), { contype: 0, conaffinity: 0, mass: 0.3 }),
      { name: 'deck', type: 'cylinder', size: [0.1, 0.005] },
    ]));
    const names = physics(node).map(g => g.name);
    expect(names).not.toContain('platform');
    expect(names).toEqual(expect.arrayContaining(['canopy', 'sleeve', 'deck']));
    expect(physics(node).find(g => g.name === 'sleeve')!.mass).toBe(0.3);
    expect(names.filter(n => n.startsWith('b_csg_col')).length).toBeGreaterThan(1);
  }, 60_000);

  it('still demotes every colliding mesh for colliders made before they named their mesh', () => {
    const node = body([
      meshGeom('a', cupMesh()),
      meshGeom('b2', cupMesh()),
      meshGeom('decor', cupMesh(), { contype: 0, conaffinity: 0 }),
      { name: 'old_csg_col0', type: 'mesh', size: [1], vertices: boxMesh().verts, faces: boxMesh().faces, role: 'collision', csgDerived: 'collider' },
    ]);
    expect(physics(node).map(g => g.name)).toEqual(['decor', 'old_csg_col0']);
  });

  it('keeps a static mesh it stands in for, drawn but massless and out of contact', async () => {
    const node = await decomposed(body([meshGeom('platform', cupMesh(), { dynamic: false })]));
    const kept = physics(node).find(g => g.name === 'platform')!;
    expect(kept.role).toBe('visual');
    expect(kept.mass).toBe(0);
  }, 60_000);

  it('weighs the whole body in the mass warning, not just the mesh that got lighter', async () => {
    const result = (await decomposeNodeColliders(body([
      meshGeom('cup', cupMesh()),
      { name: 'ballast', type: 'box', size: [0.01, 0.01, 0.01], mass: 2 },
    ])))!;
    const m = result.warning!.match(/weighs ([\d.]+) kg rather than the ([\d.]+) kg/)!;
    expect(Number(m[1])).toBeCloseTo(2 + result.mass, 1);
    expect(Number(m[2])).toBeCloseTo(2 + 1000 * result.hullVolume, 1);
  }, 60_000);
});

describe('in MuJoCo', () => {
  let sim: Sim | null = null;
  afterAll(() => sim?.dispose());

  it('the wheel’s pieces sit on its rims, and the body weighs both rims', async () => {
    const node = await decomposed({ ...wheel(), id: 'wheel', name: 'wheel', pos: [0, 0, 0.3] });
    sim = await simulate({ nodes: [node] } as never);
    const { model, data } = sim as unknown as { model: Record<string, ArrayLike<number> & { [k: number]: number }> & { ngeom: number }; data: Record<string, ArrayLike<number>> };
    const ys: number[] = [];
    for (let g = 0; g < model.ngeom; g++) {
      if (model.geom_contype[g] === 0 && model.geom_conaffinity[g] === 0) continue;
      if (model.geom_bodyid[g] === 0) continue;
      ys.push(data.geom_xpos[g * 3 + 1]);
    }
    expect(ys.length).toBe(node.geoms!.filter(g => g.csgDerived === 'collider').length);
    expect(ys.filter(y => Math.abs(y + 0.03) < 0.008).length).toBeGreaterThan(1);
    expect(ys.filter(y => Math.abs(y - 0.03) < 0.008).length).toBeGreaterThan(1);
    const mass = node.geoms!.filter(g => g.csgDerived === 'collider').reduce((m, g) => m + (g.mass ?? 0), 0);
    expect(mass).toBeCloseTo(2 * 1000 * meshVolumeAndCentroid(rim.verts, rim.faces).volume, 6);
  }, 60_000);
});
