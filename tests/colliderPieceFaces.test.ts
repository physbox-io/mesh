// A convex piece goes to MuJoCo as points only, and MuJoCo hulls it.
//
// The pieces carry V-HACD's faces, and after a painted cat was decomposed one
// of them (cat_csg_col55) had two faces wound against each other. MuJoCo
// refuses such a mesh for "inconsistent orientation", and refusing one mesh
// refuses the model: nothing edited afterwards reached the viewport.

import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.hoisted(() => { (globalThis as { navigator?: unknown }).navigator ??= { hardwareConcurrency: 2 }; });

import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import type { SceneGeom, SceneNode } from '../src/types/scene';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); });

// A 2 cm cube, Y-up, centred; its outward triangles.
const s = 0.01;
const verts = [-s, -s, -s, s, -s, -s, s, s, -s, -s, s, -s, -s, -s, s, s, -s, s, s, s, s, -s, s, s];
const outward = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7];
// The same cube with one triangle turned over.
const misWound = [...outward];
[misWound[1], misWound[2]] = [misWound[2], misWound[1]];

const body = (piece: Partial<SceneGeom>): SceneNode => ({
  id: 'cat', name: 'cat', pos: [0, 0, 0.2], children: [],
  joints: [{ name: 'cat_free', type: 'free' }],
  geoms: [{
    name: 'cat_csg_col55', type: 'mesh', size: [1], vertices: verts, faces: misWound, mass: 0.1,
    role: 'collision', ...piece,
  } as SceneGeom],
} as SceneNode);

const load = (node: SceneNode) => {
  const m = mj.MjModel.from_xml_string(compileToMJCF({ nodes: [node] }, -9.81, 1, 0, 0, 0));
  const mass = m.body_mass[1] as number;
  m.delete();
  return mass;
};

describe('a convex piece with a face wound wrong', () => {
  it('is what MuJoCo refuses, given as faces with exact inertia (as pieces were)', () => {
    const xml = `<mujoco><asset><mesh name="p" inertia="exact" vertex="${verts.join(' ')}" face="${misWound.join(' ')}"/></asset>
      <worldbody><body><freejoint/><geom type="mesh" mesh="p" mass="0.1"/></body></worldbody></mujoco>`;
    expect(() => mj.MjModel.from_xml_string(xml).delete()).toThrow();
  });

  it('loads as a derived piece, which MuJoCo hulls itself', () => {
    expect(load(body({ csgDerived: 'collider' }))).toBeCloseTo(0.1, 6);
  });
});
