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

  it('leaves the visual shell out of the model: the renderer draws it, MuJoCo never touches it', () => {
    expect(xml).not.toContain('name="ring1_csg"');
    expect(xml).not.toContain('<mesh name="ring1_csg"');
  });



  it('keeps each collider\'s pos, which MuJoCo needs to place recentred meshes', () => {
    // MuJoCo translates every mesh asset so its centre of mass sits at the asset
    // frame's origin, then places that frame at the geom's pos. Drop the pos and
    // every sector stacks up on the body origin.
    expect(geomTag(xml, 'ring1_csg_col0')).toMatch(/pos="0.09 0 0"/);
    expect(geomTag(xml, 'ring1_csg_col1')).toMatch(/pos="-0.09 0 0"/);
  });

  it('declares a mesh asset for every mesh geom it emits', () => {
    for (const n of ['ring1_csg_col0', 'ring1_csg_col1']) {
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

describe('visual-only geoms weigh nothing', () => {
  // MuJoCo infers a geom's mass from its volume and a default density of 1000
  // unless told otherwise, so a decorative inner shell the size of a jar arrives
  // as a real 27kg bolted to that jar's body. Scenery has to be weightless.
  const jarLike = (): SceneNode => ({
    id: 'jar', name: 'jar', type: 'body', pos: [0, 0, 0], children: [], joints: [],
    geoms: [
      { name: 'wall', type: 'cylinder', size: [0.2, 0.18], mass: 1.5 },
      { name: 'inner_shell', type: 'cylinder', size: [0.183, 0.13], role: 'visual' },
    ] as SceneGeom[],
  });

  it('pins a visual geom to mass 0', () => {
    expect(geomTag(compile([jarLike()]), 'inner_shell')).toContain('mass="0"');
  });

  it('leaves an authored mass alone', () => {
    const node = jarLike();
    node.geoms[1].mass = 0.25;
    expect(geomTag(compile([node]), 'inner_shell')).toContain('mass="0.25"');
  });

  it('will not zero out a body that is nothing but visual geoms', () => {
    // Left massless, a moving body with no mass at all is rejected outright by
    // MuJoCo — better a body that weighs something odd than a scene that fails
    // to compile.
    const node = jarLike();
    node.geoms = [node.geoms[1]];
    expect(geomTag(compile([node]), 'inner_shell')).not.toContain('mass=');
  });
});

// ---------------------------------------------------------------------------
// A body that is not a boolean at all, whose mesh has been decomposed into
// convex pieces. This is the general concave-collision path: an imported STL, a
// sculpt, a lattice part or a relief reaches MuJoCo the same way.
// ---------------------------------------------------------------------------

describe('a decomposed mesh body', () => {
  const decomposedCup = (dynamic: boolean): SceneNode => ({
    id: 'cup', name: 'cup', type: 'body', pos: [0, 0, 0.2], children: [],
    joints: dynamic ? [{ name: 'cup_free', type: 'free' }] : [],
    geoms: [
      { name: 'cup_mesh', type: 'mesh', size: [1], mass: 0.4, rgba: [0.3, 0.6, 0.9, 1], dynamic, ...tet },
      { name: 'cup_csg_col0', type: 'mesh', size: [1], role: 'collision', csgDerived: 'collider', mass: 0.25, pos: [0, 0, 0.01], ...tet },
      { name: 'cup_csg_col1', type: 'mesh', size: [1], role: 'collision', csgDerived: 'collider', mass: 0.15, pos: [0.09, 0, 0.06], ...tet },
    ] as SceneGeom[],
  });

  describe('when its mesh is dynamic', () => {
    const xml = compile([decomposedCup(true)]);

    it('drops the source mesh from the model entirely', () => {
      // A dynamic mesh is drawn from the body transform, so MuJoCo never needs
      // to see it — and parsing plus hulling a mesh nothing collides with is
      // pure cost on every rebuild.
      expect(geomTag(xml, 'cup_mesh')).toBe('');
      expect(xml).not.toContain('<mesh name="cup_mesh"');
    });

    it('emits every collider, each keeping its own pos', () => {
      // MuJoCo recentres a mesh asset on its centre of mass and places that
      // frame at pos. Lose the pos and every piece stacks on the body origin.
      expect(geomTag(xml, 'cup_csg_col0')).toContain('pos="0 0 0.01"');
      expect(geomTag(xml, 'cup_csg_col1')).toContain('pos="0.09 0 0.06"');
    });

    it('gives each collider its own mesh asset', () => {
      expect(xml).toContain('<mesh name="cup_csg_col0"');
      expect(xml).toContain('<mesh name="cup_csg_col1"');
    });

    it('integrates a collider exactly, since a hull is closed by construction', () => {
      expect(xml).toMatch(/<mesh name="cup_csg_col0" inertia="exact"/);
    });

    it('leaves the body weighing what the pieces weigh', () => {
      expect(geomTag(xml, 'cup_csg_col0')).toContain('mass="0.25"');
      expect(geomTag(xml, 'cup_csg_col1')).toContain('mass="0.15"');
    });
  });

  describe('when its mesh is static', () => {
    const xml = compile([decomposedCup(false)]);

    it('keeps the source mesh emitted, or the body would jump to the origin', () => {
      // A static mesh is drawn from data.geom_xpos via its geom id. Drop the
      // geom and that lookup returns -1 and the renderer falls back to identity.
      expect(geomTag(xml, 'cup_mesh')).not.toBe('');
    });

    it('but strips its contact and its mass, so only the pieces collide', () => {
      expect(geomTag(xml, 'cup_mesh')).toContain('contype="0"');
      expect(geomTag(xml, 'cup_mesh')).toContain('conaffinity="0"');
      expect(geomTag(xml, 'cup_mesh')).toContain('mass="0"');
    });

    it('still emits the colliders', () => {
      expect(geomTag(xml, 'cup_csg_col0')).toContain('pos="0 0 0.01"');
    });
  });

  it('changes nothing for a body with no colliders derived', () => {
    // The guarantee that every existing scene is untouched: same node, minus the
    // derived pieces, must emit exactly what it always did.
    const plain = decomposedCup(true);
    plain.geoms = [plain.geoms[0]];
    const xml = compile([plain]);
    expect(geomTag(xml, 'cup_mesh')).toContain('mass="0.4"');
    expect(geomTag(xml, 'cup_mesh')).not.toContain('contype="0"');
    expect(xml).toContain('<mesh name="cup_mesh"');
  });
});

/*
 * Rotating a mesh body, which the app does in two places at once.
 *
 * `updateNodeRotation` bakes the angles into a mesh body's vertices — that is
 * what `baseVertices` is: the unrotated copy the bake is derived from — and it
 * also records them in `node.euler` so the sidebar's sliders have something to
 * read. Emitting that euler as well told MuJoCo to turn the body a second time,
 * on top of vertices already turned, so one rotation came out as two.
 *
 * A mesh body with no `baseVertices` has never been through that path: its
 * vertices are as authored and its euler is the only rotation it has, so it
 * keeps it.
 */
describe('a rotated mesh body', () => {
  const meshNode = (id: string, baked: boolean): SceneNode => ({
    id, name: id, type: 'body', pos: [0, 0, 0.2], children: [],
    euler: [30, 40, 50],
    geoms: [{
      name: `${id}_mesh`, type: 'mesh', size: [1], dynamic: true, ...tet,
      ...(baked ? { baseVertices: [...tet.vertices] } : {}),
    }] as SceneGeom[],
  });

  const bodyTag = (xml: string, name: string) =>
    (xml.match(new RegExp(`<body name="${name}"[^>]*>`)) || [''])[0];

  it('does not turn a baked body a second time', () => {
    expect(bodyTag(compile([meshNode('baked', true)]), 'baked')).not.toContain('euler');
  });

  it('still turns a mesh whose vertices were never baked', () => {
    expect(bodyTag(compile([meshNode('raw', false)]), 'raw')).toContain('euler="30 40 50"');
  });

  it('leaves a primitive body alone — nothing is baked into a box', () => {
    const box: SceneNode = {
      id: 'box', name: 'box', type: 'body', pos: [0, 0, 0.2], children: [],
      euler: [30, 40, 50],
      geoms: [{ name: 'box_g', type: 'box', size: [0.1, 0.1, 0.1] }] as SceneGeom[],
    };
    expect(bodyTag(compile([box]), 'box')).toContain('euler="30 40 50"');
  });

  it('keeps turning a body whose mesh is only part of it', () => {
    const mixed: SceneNode = {
      id: 'mixed', name: 'mixed', type: 'body', pos: [0, 0, 0.2], children: [],
      euler: [30, 40, 50],
      geoms: [
        { name: 'mixed_m', type: 'mesh', size: [1], ...tet, baseVertices: [...tet.vertices] },
        { name: 'mixed_b', type: 'box', size: [0.1, 0.1, 0.1] },
      ] as SceneGeom[],
    };
    expect(bodyTag(compile([mixed]), 'mixed')).toContain('euler="30 40 50"');
  });
});
