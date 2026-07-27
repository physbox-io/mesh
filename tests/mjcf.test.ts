// How a boolean-modifier body reaches MuJoCo: which geoms are emitted, which are
// silently dropped, and which are stripped of contact.
//
// The invariants here are what make a hole behave like a hole. MuJoCo takes the
// convex hull of any mesh geom, so the visual shell must not collide and the
// sector colliders must land in the right places, or a ring collides as a disc.

import { describe, it, expect } from 'vitest';
import { compileToMJCF } from '../src/utils/mjcf';
import type { SceneGeom, SceneGraph, SceneNode } from '../src/types/scene';

// A tetrahedron — the smallest thing that counts as a solid mesh.
const tet = {
  vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
  faces: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
};

const compile = (nodes: SceneNode[]) =>
  compileToMJCF({ nodes } as SceneGraph, -9.81, 1, 0, 0, 0, 0);

const geomTag = (xml: string, name: string) =>
  (xml.match(new RegExp(`<geom name="${name}"[^>]*>`)) || [''])[0];

const decomposedRing = (): SceneNode => ({
  id: 'ring1', name: 'ring1', type: 'body', pos: [0, 0, 0.3], children: [],
  joints: [{ name: 'ring1_free', type: 'free' }],
  csgEnabled: true, csgCollision: 'auto', csgMass: 2,
  geoms: [
    { name: 'ring1_body', type: 'ellipsoid', size: [0.12, 0.12, 0.04], mass: 1, rgba: [1, 0, 0, 1] },
    { name: 'ring1_hole', type: 'ellipsoid', size: [0.06, 0.06, 0.2], csg: 'difference' },
    { name: 'ring1_csg', type: 'mesh', size: [1], role: 'visual', csgDerived: 'visual', mass: 0, dynamic: true, ...tet },
    { name: 'ring1_csg_col0', type: 'mesh', size: [1], role: 'collision', csgDerived: 'collider', mass: 1, pos: [0.09, 0, 0], ...tet },
    { name: 'ring1_csg_col1', type: 'mesh', size: [1], role: 'collision', csgDerived: 'collider', mass: 1, pos: [-0.09, 0, 0], ...tet },
  ] as SceneGeom[],
});

describe('a decomposed boolean body', () => {
  const xml = compile([decomposedRing()]);

  it('never emits the negative — a hole is not a solid', () => {
    expect(xml).not.toContain('ring1_hole');
    expect(xml).not.toContain('<mesh name="ring1_hole"');
  });

  it('replaces the source primitive with the sector colliders', () => {
    expect(xml).not.toContain('ring1_body');
    expect(xml).toContain('ring1_csg_col0');
    expect(xml).toContain('ring1_csg_col1');
  });

  it('emits the visual shell with contact disabled', () => {
    // Without this the shell's convex hull would collide, filling the hole in.
    expect(geomTag(xml, 'ring1_csg')).toMatch(/contype="0"/);
    expect(geomTag(xml, 'ring1_csg')).toMatch(/conaffinity="0"/);
  });

  it('gives the visual shell no mass, so the colliders alone carry it', () => {
    expect(geomTag(xml, 'ring1_csg')).toMatch(/mass="0"/);
  });

  it('keeps each collider\'s pos, which MuJoCo needs to place recentred meshes', () => {
    // MuJoCo translates every mesh asset so its centre of mass sits at the asset
    // frame's origin, then places that frame at the geom's pos. Drop the pos and
    // every sector stacks up on the body origin.
    expect(geomTag(xml, 'ring1_csg_col0')).toMatch(/pos="0.09 0 0"/);
    expect(geomTag(xml, 'ring1_csg_col1')).toMatch(/pos="-0.09 0 0"/);
  });

  it('declares a mesh asset for every mesh geom it emits', () => {
    for (const n of ['ring1_csg', 'ring1_csg_col0', 'ring1_csg_col1']) {
      expect(xml).toContain(`<mesh name="${n}"`);
    }
  });

  it('produces one well-formed model', () => {
    expect((xml.match(/<mujoco/g) || []).length).toBe(1);
    expect(xml.trim().endsWith('</mujoco>')).toBe(true);
  });
});

describe("a boolean body colliding as its source primitives", () => {
  const node = decomposedRing();
  node.csgCollision = 'primitives';
  node.geoms = node.geoms.filter(g => g.csgDerived !== 'collider');
  const xml = compile([node]);

  it('emits the positive as the collider', () => {
    expect(xml).toContain('name="ring1_body"');
  });

  it('still drops the negative', () => {
    expect(xml).not.toContain('ring1_hole');
  });

  it('takes the body\'s total mass over the geom\'s own', () => {
    // The primitives overlap, so keeping their authored masses would make the
    // body heavier than the solid it represents.
    expect(geomTag(xml, 'ring1_body')).toMatch(/mass="2"/);
  });
});

describe('bodies without booleans are unaffected', () => {
  const plain: SceneNode = {
    id: 'b', name: 'b', type: 'body', pos: [0, 0, 1], children: [],
    joints: [{ name: 'b_free', type: 'free' }],
    geoms: [{ name: 'b_geom', type: 'box', size: [0.1, 0.1, 0.1], contype: 1, conaffinity: 1 }],
  };

  it('keeps the geom and its authored contact masks', () => {
    const xml = compile([plain]);
    expect(geomTag(xml, 'b_geom')).toMatch(/contype="1"/);
    expect(geomTag(xml, 'b_geom')).toMatch(/conaffinity="1"/);
  });

  it('emits a geom marked visual with contact zeroed, CSG or not', () => {
    const visual = { ...plain, geoms: [{ ...plain.geoms[0], role: 'visual' as const }] };
    expect(geomTag(compile([visual]), 'b_geom')).toMatch(/contype="0"/);
  });
});
