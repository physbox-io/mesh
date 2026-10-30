// Body-level mass and density on a concave mesh body that collides as convex
// pieces (a plain cup, no boolean).
//
// Its source mesh is dropped from the model once the pieces stand in for it,
// and each piece carries a mass of its own, so the body's mass or density used
// to change nothing: utils/bodyMass skipped any body with derived colliders.
// The pieces now take it, in proportion to the solid's true volume, and the
// centre of mass stays where the solid's is.

import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.hoisted(() => { (globalThis as { navigator?: unknown }).navigator ??= { hardwareConcurrency: 2 }; });

import load_mujoco from '@mujoco/mujoco';
import { decomposeNodeColliders } from '../src/utils/convexDecomposition';
import { meshVolumeAndCentroid } from '../src/utils/csg';
import { compileToMJCF } from '../src/utils/mjcf';
import { cupMesh, zupToYupFlat } from './helpers/meshes';
import type { SceneNode } from '../src/types/scene';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mj: any;
let cup: SceneNode;
let trueVolume: number;

beforeAll(async () => {
  mj = await load_mujoco();
  const m = cupMesh({ outerR: 0.05, innerR: 0.04, height: 0.08, baseThickness: 0.01 });
  trueVolume = Math.abs(meshVolumeAndCentroid(m.verts, m.faces).volume);
  const base: SceneNode = {
    id: 'cup', name: 'cup', pos: [0, 0, 0.2], children: [],
    joints: [{ name: 'cup_free', type: 'free' }],
    geoms: [{ name: 'cup_mesh', type: 'mesh', size: [1], dynamic: true, renderVertices: m.verts, vertices: zupToYupFlat(m.verts), faces: m.faces }],
  } as SceneNode;
  const result = (await decomposeNodeColliders(base))!;
  expect(result.geoms.length).toBeGreaterThan(1);
  cup = { ...base, geoms: [...base.geoms, ...result.geoms], collisionHash: result.hash, collisionDecomposed: true };
}, 120_000);

const inertial = (node: SceneNode) => {
  const m = mj.MjModel.from_xml_string(compileToMJCF({ nodes: [node] }, -9.81, 1, 0, 0, 0));
  const id = mj.mj_name2id(m, mj.mjtObj.mjOBJ_BODY.value, 'cup');
  const out = { mass: m.body_mass[id] as number, ipos: [0, 1, 2].map((k) => m.body_ipos[id * 3 + k] as number) };
  m.delete();
  return out;
};

describe('a decomposed cup', () => {
  it('weighs its true volume in water with nothing said (unchanged)', () => {
    expect(inertial(cup).mass).toBeCloseTo(trueVolume * 1000, 3);
  });

  it('weighs its body mass (was ignored)', () => {
    expect(inertial({ ...cup, mass: 0.75 }).mass).toBeCloseTo(0.75, 6);
  });

  it('weighs its true volume at the body density (was ignored)', () => {
    expect(inertial({ ...cup, density: 2700 }).mass).toBeCloseTo(trueVolume * 2700, 3);
  });

  it('keeps the centre of mass where the solid has it', () => {
    const plain = inertial(cup).ipos;
    const massed = inertial({ ...cup, mass: 0.75 }).ipos;
    for (let k = 0; k < 3; k++) expect(massed[k]).toBeCloseTo(plain[k], 6);
  });

  it('leaves a stated collisionMass to its own path', () => {
    expect(inertial({ ...cup, mass: 0.75, collisionMass: 0.2 }).mass).not.toBeCloseTo(0.75, 3);
  });
});
